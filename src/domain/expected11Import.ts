import { timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import {
  invalidateComputed,
  PREMIUM_ODDS_JOIN_CACHE_KEY,
} from "../lib/computedCache.js";
import { leagueBySlug } from "../lib/afLeagues.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import { nameMatchScore, nameMatchVariants, normName } from "../lib/names.js";
import {
  STARTING_XI_FALLBACK_PERCENTAGE,
  withStartingXiFallbackPercentage,
  type Expected11LineupGroup,
} from "./expected11.js";
import { scheduleChampionshipXiRebuild } from "./xiWarmup.js";

export const MAX_EXPECTED11_IMPORT_BYTES = 512 * 1024;
export const MAX_EXPECTED11_MATCHES = 24;
const MAX_PLAYERS_PER_TEAM = 80;
const GROUPS: Expected11LineupGroup[] = ["starting", "bench", "out"];
const FORBIDDEN_KEYS = new Set([
  "cookie",
  "cookies",
  "html",
  "password",
  "profile",
  "storageState",
  "token",
]);

const TEAM_ALIASES: Record<string, string> = {
  "ac milan": "milan",
  "fc internazionale": "inter",
  "fc internazionale milano": "inter",
  internazionale: "inter",
  "internazionale milano": "inter",
  "inter milan": "inter",
  "afc bournemouth": "bournemouth",
  "bolton wanderers": "bolton",
  "brighton hove albion": "brighton",
  "charlton athletic": "charlton",
  "derby county": "derby",
  "ipswich town": "ipswich",
  "leeds united": "leeds",
  "lincoln city": "lincoln",
  "newcastle united": "newcastle",
  "norwich city": "norwich",
  "preston north end": "preston",
  "queens park rangers": "qpr",
  "sheffield united": "sheffield united",
  "sheffield utd": "sheffield united",
  "tottenham hotspur": "tottenham",
  "west brom": "west bromwich",
  "west bromwich albion": "west bromwich",
  "west ham united": "west ham",
  wolves: "wolverhampton",
  "wolverhampton wanderers": "wolverhampton",
  "amed sk": "amed",
  "besiktas jk": "besiktas",
  "besiktas jimnastik kulubu": "besiktas",
  "buyuksehir belediye erzurum spor kulubu": "erzurumspor",
  "caykur rize": "rizespor",
  "caykur rize spor kulubu": "rizespor",
  "caykur rizespor": "rizespor",
  "corum fk": "corum",
  "erzurumspor fk": "erzurumspor",
  "eyup spor": "eyupspor",
  "eyup spor kulubu": "eyupspor",
  "fenerbahce sk": "fenerbahce",
  "fenerbahce spor kulubu": "fenerbahce",
  "galatasaray sk": "galatasaray",
  "galatasaray spor kulubu": "galatasaray",
  "gaziantep f k": "gaziantep",
  "gaziantep fk": "gaziantep",
  "goztepe spor kulubu": "goztepe",
  "istanbul basaksehir": "basaksehir",
  "kasimpasa sk": "kasimpasa",
  "yeni corumspor": "corum",
  "yeni corumspor spor kulubu": "corum",
  "vfb stuttgart": "stuttgart",
  "hamburger sv": "hamburger",
  "borussia monchengladbach": "borussia mbach",
  "fsv mainz 05": "mainz 05",
  "eintracht frankfurt": "eintracht",
  "tsg hoffenheim": "hoffenheim",
  "bayer 04 leverkusen": "bayer leverkusen",
};

const PLAYER_ALIASES: Record<string, Record<string, string>> = {
  "bristol city": {
    "jed fernley wallace": "jed wallace",
  },
  burnley: {
    "benjamin amos": "ben amos",
    hannibal: "hannibal mejbri",
    "max wei": "max weiss",
  },
  charlton: {
    "i fullah": "ibrahim fullah",
    "karlan ahearne grant": "karlan grant",
    "karlan laughton ahearne grant": "karlan grant",
    "matty godden": "matt godden",
  },
  lincoln: {
    "d elerewe": "deji elerewe",
    "josh honohan": "joshua honohan",
  },
  middlesbrough: {
    neto: "neto borges",
    "william lankshear": "will lankshear",
  },
  norwich: {
    "a cmac": "ante crnac",
  },
  portsmouth: {
    "rocco shein": "rocco robert shein",
    "zachary swanson": "zak swanson",
  },
  preston: {
    "alistair mccann": "ali mccann",
  },
  millwall: {
    "benicio baker": "benicio baker boaitey",
  },
  "queens park rangers": {
    "amadou mbengue": "amadou salif mbengue",
    esquerdinha: "joao esquerdinha",
    "r burrell": "rumarn burrell",
  },
  qpr: {
    "amadou mbengue": "amadou salif mbengue",
    esquerdinha: "joao esquerdinha",
    "james dunne": "jimmy dunne",
    "r burrell": "rumarn burrell",
  },
  "sheffield united": {
    "f seriki": "femi seriki",
    "tom cannon": "thomas cannon",
  },
  southampton: {
    "b brereton": "ben brereton diaz",
    "n wood gor": "nathan wood",
    welington: "damascena welington",
  },
  "swansea city": {
    "moussa yeo": "moussa kounfolo yeo",
    ronald: "ronald pereira",
  },
  watford: {
    "j grieves": "jack grieves",
  },
  "west bromwich": {
    "alex james mowatt": "alex mowatt",
    "aune selland heggebo": "aune heggebo",
    "callum john styles": "callum styles",
    "christopher james mepham": "chris mepham",
    "isaac jude price": "isaac price",
    "jayson patrick molumby": "jayson molumby",
    "max edward oleary": "max oleary",
    "michael andrew johnston": "michael johnston",
    "nathaniel harry phillips": "nathaniel phillips",
    "oliver david bostock": "oliver bostock",
  },
  "west ham": {
    "maximilian kilman": "max kilman",
    pablo: "felipe pablo",
    "taty castellanos": "valentin castellanos",
  },
  wolverhampton: {
    andre: "trindade andre",
    santiago: "santiago bueno",
    toti: "toti gomes",
    wolfe: "david moller wolfe",
  },
  "stoke city": {
    "maksym talovierov": "maksym taloverov",
  },
  chelsea: {
    // Mantra shirt "Pedro Junqueira"; Expected11 / Sorare "João Pedro"
    "joao pedro": "joao pedro junqueira",
  },
  wrexham: {
    "daniel edward peter imray": "danny imray",
    "matthew james": "matty james",
  },
  alanyaspor: {
    maestro: "antonio maestro",
    ruan: "ruan duarte",
  },
  besiktas: {
    "amir murillo": "michael murillo",
  },
  fenerbahce: {
    talisca: "anderson talisca",
  },
  genclerbirligi: {
    thalisson: "kelven thalisson",
  },
  goztepe: {
    juan: "santos juan",
    "malcom bokele": "malcom bokele mputu",
  },
  kocaelispor: {
    show: "manuel show",
  },
  samsunspor: {
    "haluk mustafa tan": "mustafa tan",
  },
  trabzonspor: {
    "noah jose saviolo": "noah saviolo",
    "sidny lopes cabral": "sidny cabral",
  },
};

type SanitizedPlayer = {
  name: string;
  displayedPercentage: number | null;
  playerPath: string | null;
};

type SanitizedTeam = {
  side: "home" | "away";
  name: string;
  logoUrl: string | null;
  lineup: Record<Expected11LineupGroup, SanitizedPlayer[]>;
  notes: Record<string, { label: string; text: string } | null>;
  author: string | null;
};

type SanitizedMatch = {
  sourceUrl: string;
  extractedAt: string;
  id: string;
  title: string;
  homeTeam: string | null;
  awayTeam: string | null;
  formations: string[];
  teams: SanitizedTeam[];
};

export type Expected11SkippedMatch = {
  url: string;
  error: string;
};

export type Expected11ImportPayload = {
  schemaVersion: 2;
  extractedAt: string;
  matches: SanitizedMatch[];
  skipped?: Expected11SkippedMatch[];
};

export class Expected11ImportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Expected11ImportError(code);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  code: string,
  maxLength: number,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Expected11ImportError(code);
  }
  return value.trim();
}

function isoDate(value: unknown, code: string): string {
  const result = text(value, code, 40);
  if (!result || !Number.isFinite(Date.parse(result))) {
    throw new Expected11ImportError(code);
  }
  return result;
}

function expected11Url(value: unknown): { url: string; id: string } {
  const raw = text(value, "invalid_expected11_url", 500);
  try {
    const url = new URL(raw!);
    const id = url.pathname.match(/^\/match\/(\d+)(?:\/|$)/)?.[1];
    if (
      url.protocol !== "https:" ||
      !["expected11.com", "www.expected11.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      !id
    ) {
      throw new Error();
    }
    url.hash = "";
    return { url: url.toString(), id };
  } catch {
    throw new Expected11ImportError("invalid_expected11_url");
  }
}

function assertNoForbiddenFields(value: unknown, depth = 0): void {
  if (depth > 12) throw new Expected11ImportError("invalid_expected11_payload");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Expected11ImportError("forbidden_expected11_field");
    }
    assertNoForbiddenFields(child, depth + 1);
  }
}

function normalizePlayer(value: unknown): SanitizedPlayer {
  const input = record(value, "invalid_expected11_player");
  const percentage = input.displayedPercentage;
  if (
    percentage !== null &&
    (typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100)
  ) {
    throw new Expected11ImportError("invalid_expected11_percentage");
  }
  const raw = input.raw == null ? null : record(input.raw, "invalid_expected11_player");
  const playerPath =
    raw?.playerPath == null
      ? null
      : text(raw.playerPath, "invalid_expected11_player_path", 250);
  if (playerPath && !/^\/player\/\d+(?:\/|$)/.test(playerPath)) {
    throw new Expected11ImportError("invalid_expected11_player_path");
  }
  return {
    name: text(input.name, "invalid_expected11_player", 160)!,
    displayedPercentage: percentage as number | null,
    playerPath,
  };
}

function normalizeNotes(value: unknown): SanitizedTeam["notes"] {
  const input = record(value ?? {}, "invalid_expected11_notes");
  const result: SanitizedTeam["notes"] = {};
  for (const key of [
    "teamAnalysis",
    "injuriesAndRecovery",
    "suspensionsAndIneligibilities",
    "additionalNotes",
  ]) {
    if (input[key] == null) {
      result[key] = null;
      continue;
    }
    const note = record(input[key], "invalid_expected11_notes");
    result[key] = {
      label: text(note.label, "invalid_expected11_notes", 120)!,
      text: text(note.text, "invalid_expected11_notes", 20_000, true) ?? "",
    };
  }
  return result;
}

function normalizeTeam(value: unknown): SanitizedTeam {
  const input = record(value, "invalid_expected11_team");
  if (input.side !== "home" && input.side !== "away") {
    throw new Expected11ImportError("invalid_expected11_team_side");
  }
  const lineupInput = record(input.lineup, "invalid_expected11_lineup");
  const lineup = { starting: [], bench: [], out: [] } as Record<
    Expected11LineupGroup,
    SanitizedPlayer[]
  >;
  for (const group of GROUPS) {
    const players = lineupInput[group];
    if (!Array.isArray(players) || players.length > MAX_PLAYERS_PER_TEAM) {
      throw new Expected11ImportError("invalid_expected11_lineup");
    }
    lineup[group] = players.map((player) => {
      const normalized = normalizePlayer(player);
      return {
        ...normalized,
        displayedPercentage: withStartingXiFallbackPercentage(
          group,
          normalized.displayedPercentage,
        ),
      };
    });
  }
  let logoUrl: string | null = null;
  if (input.logoUrl != null) {
    const candidate = text(input.logoUrl, "invalid_expected11_logo_url", 500);
    try {
      const parsed = new URL(candidate!);
      if (parsed.protocol !== "https:") throw new Error();
      logoUrl = parsed.toString();
    } catch {
      throw new Expected11ImportError("invalid_expected11_logo_url");
    }
  }
  return {
    side: input.side,
    name: text(input.name, "invalid_expected11_team", 160)!,
    logoUrl,
    lineup,
    notes: normalizeNotes(input.notes),
    author: text(input.author, "invalid_expected11_author", 160, true),
  };
}

export function normalizeExpected11Import(value: unknown): Expected11ImportPayload {
  const serialized = JSON.stringify(value);
  if (
    serialized &&
    Buffer.byteLength(serialized) > MAX_EXPECTED11_IMPORT_BYTES
  ) {
    throw new Expected11ImportError("expected11_payload_too_large", 413);
  }
  assertNoForbiddenFields(value);
  const input = record(value, "invalid_expected11_payload");
  if (input.schemaVersion !== 2) {
    throw new Expected11ImportError("unsupported_expected11_schema");
  }
  if (
    !Array.isArray(input.matches) ||
    input.matches.length === 0 ||
    input.matches.length > MAX_EXPECTED11_MATCHES
  ) {
    throw new Expected11ImportError("invalid_expected11_matches");
  }
  const skipped: Expected11SkippedMatch[] = [];
  const matches: SanitizedMatch[] = [];
  for (const value of input.matches) {
    const matchInput = record(value, "invalid_expected11_match");
    const source = expected11Url(matchInput.sourceUrl);
    if (matchInput.status !== "ok") {
      skipped.push({
        url: source.url,
        error:
          matchInput.status === "login-required"
            ? "expected11_login_required"
            : "expected11_match_has_no_predictions",
      });
      continue;
    }
    const details = record(matchInput.match, "invalid_expected11_match");
    if (details.id !== source.id) {
      throw new Expected11ImportError("expected11_match_id_mismatch");
    }
    if (!Array.isArray(details.formations) || details.formations.length > 2) {
      throw new Expected11ImportError("invalid_expected11_formations");
    }
    const teams = Array.isArray(matchInput.teams)
      ? matchInput.teams.map(normalizeTeam)
      : [];
    if (
      teams.length === 0 ||
      teams.length > 2 ||
      new Set(teams.map((team) => team.side)).size !== teams.length
    ) {
      throw new Expected11ImportError("invalid_expected11_teams");
    }
    matches.push({
      sourceUrl: source.url,
      extractedAt: isoDate(matchInput.extractedAt, "invalid_expected11_extracted_at"),
      id: source.id,
      title: text(details.title, "invalid_expected11_match", 250)!,
      homeTeam: text(details.homeTeam, "invalid_expected11_match", 160, true),
      awayTeam: text(details.awayTeam, "invalid_expected11_match", 160, true),
      formations: details.formations.map(
        (formation) => text(formation, "invalid_expected11_formations", 30)!,
      ),
      teams,
    });
  }
  if (matches.length === 0) {
    throw new Expected11ImportError("expected11_no_predicted_matches");
  }
  return {
    schemaVersion: 2,
    extractedAt: isoDate(input.extractedAt, "invalid_expected11_extracted_at"),
    matches,
    skipped,
  };
}

export function expected11TokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

type MantraClub = { id: number; name: string };
type MantraPlayer = {
  id: number;
  name: string;
  firstName: string | null;
  fullName: string | null;
};

export function expected11TeamKey(name: string): string {
  const normalized = normName(name);
  return TEAM_ALIASES[normalized] ?? normalized;
}

export function expected11AliasedPlayerName(clubName: string, sourceName: string): string {
  const clubKey = expected11TeamKey(clubName);
  return PLAYER_ALIASES[clubKey]?.[normName(sourceName)] ?? sourceName;
}

function teamAliasKey(name: string): string {
  return expected11TeamKey(name);
}

function resolveClub(database: Database.Database, sourceName: string) {
  const targetKey = teamAliasKey(sourceName);
  const rows = database
    .prepare(
      `SELECT DISTINCT club_id AS id, club_name AS name
       FROM mantra_players
       WHERE club_id IS NOT NULL AND club_name IS NOT NULL`,
    )
    .all() as MantraClub[];
  const matches = rows.filter((club) => teamAliasKey(club.name) === targetKey);
  return matches.length === 1
    ? { status: "linked" as const, club: matches[0]! }
    : {
        status: matches.length > 1 ? ("ambiguous" as const) : ("unmatched" as const),
        club: null,
      };
}

export function resolveExpected11Player(
  database: Database.Database,
  club: MantraClub,
  sourceName: string,
) {
  const clubKey = normName(club.name);
  const sourceKey = normName(sourceName);
  const manual = database
    .prepare(
      `SELECT mp.id, mp.name, mp.first_name AS firstName, mp.full_name AS fullName
       FROM expected11_manual_mappings mm
       JOIN mantra_players mp ON mp.id = mm.mantra_player_id
       WHERE mm.source_name_normalized = ? AND mm.mantra_club_id = ?
         AND mp.club_id = ?`,
    )
    .get(sourceKey, club.id, club.id) as MantraPlayer | undefined;
  if (manual) return { status: "linked" as const, player: manual };
  const targetKey = PLAYER_ALIASES[clubKey]?.[sourceKey] ?? sourceKey;
  const rows = database
    .prepare(
      `SELECT id, name, first_name AS firstName, full_name AS fullName
       FROM mantra_players WHERE club_id = ?`,
    )
    .all(club.id) as MantraPlayer[];
  const matches = rows.filter((player) => {
    const variants = [
      player.fullName,
      player.firstName && player.name ? `${player.firstName} ${player.name}` : null,
      player.firstName && player.name ? `${player.name} ${player.firstName}` : null,
    ].filter((candidate): candidate is string => Boolean(candidate));
    return variants.some((candidate) => normName(candidate) === targetKey);
  });
  return matches.length === 1
    ? { status: "linked" as const, player: matches[0]! }
    : {
        status: matches.length > 1 ? ("ambiguous" as const) : ("unmatched" as const),
        player: null,
      };
}

/** One-shot re-link for unmatched clubs/players. Mapping clicks stay scoped. */
export function relinkUnmatchedExpected11Teams(
  database: Database.Database = getDb(),
) {
  const teams = database
    .prepare(
      `SELECT match_id AS matchId, side, source_name AS sourceName
       FROM expected11_teams
       WHERE link_status <> 'linked'`,
    )
    .all() as Array<{
    matchId: string;
    side: "home" | "away";
    sourceName: string;
  }>;
  const unmatchedPlayers = database
    .prepare(
      `SELECT p.match_id AS matchId, p.team_side AS side,
              p.lineup_group AS lineupGroup, p.sort_order AS sortOrder,
              p.source_name AS sourceName,
              t.mantra_club_id AS clubId, t.mantra_club_name AS clubName
       FROM expected11_predictions p
       JOIN expected11_teams t
         ON t.match_id = p.match_id AND t.side = p.team_side
       WHERE p.link_status <> 'linked'
         AND t.link_status = 'linked' AND t.mantra_club_id IS NOT NULL`,
    )
    .all() as Array<{
    matchId: string;
    side: "home" | "away";
    lineupGroup: Expected11LineupGroup;
    sortOrder: number;
    sourceName: string;
    clubId: number;
    clubName: string;
  }>;
  if (teams.length === 0 && unmatchedPlayers.length === 0) {
    return { teamsLinked: 0, playersLinked: 0 };
  }

  const updateTeam = database.prepare(
    `UPDATE expected11_teams
     SET mantra_club_id = ?, mantra_club_name = ?, link_status = ?
     WHERE match_id = ? AND side = ?`,
  );
  const listPlayers = database.prepare(
    `SELECT lineup_group AS lineupGroup, sort_order AS sortOrder,
            source_name AS sourceName
     FROM expected11_predictions
     WHERE match_id = ? AND team_side = ?`,
  );
  const updatePlayer = database.prepare(
    `UPDATE expected11_predictions
     SET mantra_player_id = ?, link_status = ?
     WHERE match_id = ? AND team_side = ? AND lineup_group = ? AND sort_order = ?`,
  );

  let teamsLinked = 0;
  let playersLinked = 0;
  database.transaction(() => {
    const relinkedFromTeams = new Set<string>();
    for (const team of teams) {
      const linkedClub = resolveClub(database, team.sourceName);
      updateTeam.run(
        linkedClub.club?.id ?? null,
        linkedClub.club?.name ?? null,
        linkedClub.status,
        team.matchId,
        team.side,
      );
      if (linkedClub.status !== "linked" || !linkedClub.club) continue;
      teamsLinked += 1;
      const rows = listPlayers.all(team.matchId, team.side) as Array<{
        lineupGroup: Expected11LineupGroup;
        sortOrder: number;
        sourceName: string;
      }>;
      for (const row of rows) {
        const linkedPlayer = resolveExpected11Player(
          database,
          linkedClub.club,
          row.sourceName,
        );
        updatePlayer.run(
          linkedPlayer.player?.id ?? null,
          linkedPlayer.status,
          team.matchId,
          team.side,
          row.lineupGroup,
          row.sortOrder,
        );
        relinkedFromTeams.add(
          `${team.matchId}:${team.side}:${row.lineupGroup}:${row.sortOrder}`,
        );
        if (linkedPlayer.status === "linked") playersLinked += 1;
      }
    }
    for (const row of unmatchedPlayers) {
      const key = `${row.matchId}:${row.side}:${row.lineupGroup}:${row.sortOrder}`;
      if (relinkedFromTeams.has(key)) continue;
      const linkedPlayer = resolveExpected11Player(
        database,
        { id: row.clubId, name: row.clubName },
        row.sourceName,
      );
      updatePlayer.run(
        linkedPlayer.player?.id ?? null,
        linkedPlayer.status,
        row.matchId,
        row.side,
        row.lineupGroup,
        row.sortOrder,
      );
      if (linkedPlayer.status === "linked") playersLinked += 1;
    }
  })();
  return { teamsLinked, playersLinked };
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name),
  );
}

function mantraNameVariants(player: MantraPlayer): string[] {
  return nameMatchVariants({
    shirtName: player.name,
    firstName: player.firstName,
    surname: player.name,
    fullName: player.fullName,
  });
}

function tmUrlFromSquad(relativeUrl: string | null, playerId: string): string {
  if (relativeUrl?.startsWith("/")) {
    return `https://www.transfermarkt.com${relativeUrl}`;
  }
  return `https://www.transfermarkt.com/spieler/profil/spieler/${playerId}`;
}

/** Fill missing Super Lig tm_url from TR1 squads so Expected11 names can link. */
export function backfillMantraTmUrlsFromSquad(
  database: Database.Database = getDb(),
  tournamentId = leagueBySlug("super-lig")?.mantraTournamentId ?? 21,
) {
  if (
    !tableExists(database, "tm_squad_players") ||
    !tableExists(database, "tm_clubs") ||
    !tableExists(database, "tm_competition_clubs")
  ) {
    return { filled: 0 };
  }
  const mantraCols = new Set(
    (
      database.prepare(`PRAGMA table_info(mantra_players)`).all() as Array<{
        name: string;
      }>
    ).map((col) => col.name),
  );
  if (!mantraCols.has("tournament_id") || !mantraCols.has("tm_url")) {
    return { filled: 0 };
  }
  const pending = database
    .prepare(
      `SELECT id, name, first_name AS firstName, full_name AS fullName, club_name AS clubName
       FROM mantra_players
       WHERE tournament_id = ?
         AND (tm_url IS NULL OR tm_url = '')
         AND club_name IS NOT NULL`,
    )
    .all(tournamentId) as Array<MantraPlayer & { clubName: string }>;
  if (pending.length === 0) return { filled: 0 };

  const tmClubs = database
    .prepare(
      `SELECT c.id, c.name
       FROM tm_clubs c
       JOIN tm_competition_clubs cc ON cc.club_id = c.id
       WHERE cc.competition_id = ?`,
    )
    .all("TR1") as Array<{ id: string; name: string }>;
  if (tmClubs.length === 0) return { filled: 0 };

  const squadByClub = new Map<
    string,
    Array<{ playerId: string; name: string; relativeUrl: string | null }>
  >();
  const squadQuery = database.prepare(
    `SELECT player_id AS playerId, name, relative_url AS relativeUrl
     FROM tm_squad_players WHERE club_id = ?`,
  );
  for (const club of tmClubs) {
    squadByClub.set(
      club.id,
      squadQuery.all(club.id) as Array<{
        playerId: string;
        name: string;
        relativeUrl: string | null;
      }>,
    );
  }

  const proposals = new Map<number, { playerId: string; url: string }>();
  for (const player of pending) {
    const clubHits = tmClubs.filter((club) =>
      clubsMatch(player.clubName, club.name),
    );
    if (clubHits.length !== 1) continue;
    const squad = squadByClub.get(clubHits[0]!.id) ?? [];
    const variants = mantraNameVariants(player);
    const scored = squad
      .map((row) => ({
        row,
        score: Math.max(
          0,
          ...variants.map((name) => nameMatchScore(name, row.name)),
        ),
      }))
      .filter((row) => row.score >= 80)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score;
    const unique = scored.filter((row) => row.score === best);
    if (unique.length !== 1) continue;
    const hit = unique[0]!.row;
    proposals.set(player.id, {
      playerId: hit.playerId,
      url: tmUrlFromSquad(hit.relativeUrl, hit.playerId),
    });
  }

  const owners = new Map<string, number[]>();
  for (const [mantraId, proposal] of proposals) {
    const list = owners.get(proposal.playerId) ?? [];
    list.push(mantraId);
    owners.set(proposal.playerId, list);
  }
  const update = database.prepare(
    `UPDATE mantra_players SET tm_url = ? WHERE id = ? AND (tm_url IS NULL OR tm_url = '')`,
  );
  let filled = 0;
  database.transaction(() => {
    for (const [mantraId, proposal] of proposals) {
      if ((owners.get(proposal.playerId) ?? []).length !== 1) continue;
      const result = update.run(proposal.url, mantraId);
      if (result.changes > 0) filled += 1;
    }
  })();
  return { filled };
}

export type Expected11ImportResult = {
  scope: "snapshot";
  league?: string;
  tour?: number;
  importedMatches: number;
  importedTeams: number;
  importedPlayers: number;
  linked: number;
  unmatched: number;
  ambiguous: number;
  teamLinked: number;
  teamUnmatched: number;
  teamAmbiguous: number;
  skipped?: Expected11SkippedMatch[];
};

function bustPremiumOddsJoinCache(database: Database.Database): void {
  invalidateComputed(PREMIUM_ODDS_JOIN_CACHE_KEY, { database, persist: true });
}

export function backfillStartingXiFallbackPercentages(
  database: Database.Database = getDb(),
): number {
  const result = database
    .prepare(
      `UPDATE expected11_predictions
       SET displayed_percentage = ?
       WHERE lineup_group = 'starting'
         AND (displayed_percentage IS NULL OR displayed_percentage = 0)`,
    )
    .run(STARTING_XI_FALLBACK_PERCENTAGE);
  if (result.changes > 0) bustPremiumOddsJoinCache(database);
  return result.changes;
}

export function importExpected11(
  payload: Expected11ImportPayload,
  database: Database.Database = getDb(),
  options: { replaceAll?: boolean } = {},
): Expected11ImportResult {
  const result: Expected11ImportResult = {
    scope: "snapshot",
    importedMatches: payload.matches.length,
    importedTeams: 0,
    importedPlayers: 0,
    linked: 0,
    unmatched: 0,
    ambiguous: 0,
    teamLinked: 0,
    teamUnmatched: 0,
    teamAmbiguous: 0,
    skipped: payload.skipped ?? [],
  };
  const upsertMatch = database.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       source_url = excluded.source_url,
       title = excluded.title,
       home_team = excluded.home_team,
       away_team = excluded.away_team,
       formations_json = excluded.formations_json,
       extracted_at = excluded.extracted_at,
       imported_at = excluded.imported_at`,
  );
  const insertTeam = database.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, logo_url, notes_json, author,
        mantra_club_id, mantra_club_name, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPlayer = database.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, player_path, mantra_player_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const transaction = database.transaction(() => {
    if (options.replaceAll !== false) {
      database.prepare(`DELETE FROM expected11_matches`).run();
    }
    for (const match of payload.matches) {
      upsertMatch.run(
        match.id,
        match.sourceUrl,
        match.title,
        match.homeTeam,
        match.awayTeam,
        JSON.stringify(match.formations),
        match.extractedAt,
      );
      database.prepare(`DELETE FROM expected11_teams WHERE match_id = ?`).run(match.id);
      for (const team of match.teams) {
        const linkedClub = resolveClub(database, team.name);
        result.importedTeams += 1;
        result[
          linkedClub.status === "linked"
            ? "teamLinked"
            : linkedClub.status === "ambiguous"
              ? "teamAmbiguous"
              : "teamUnmatched"
        ] += 1;
        insertTeam.run(
          match.id,
          team.side,
          team.name,
          team.logoUrl,
          JSON.stringify(team.notes),
          team.author,
          linkedClub.club?.id ?? null,
          linkedClub.club?.name ?? null,
          linkedClub.status,
        );
        for (const group of GROUPS) {
          for (const [index, player] of team.lineup[group].entries()) {
            const linkedPlayer = linkedClub.club
              ? resolveExpected11Player(database, linkedClub.club, player.name)
              : { status: linkedClub.status, player: null };
            result.importedPlayers += 1;
            result[
              linkedPlayer.status === "linked"
                ? "linked"
                : linkedPlayer.status === "ambiguous"
                  ? "ambiguous"
                  : "unmatched"
            ] += 1;
            insertPlayer.run(
              match.id,
              team.side,
              group,
              index,
              player.name,
              player.displayedPercentage,
              player.playerPath,
              linkedPlayer.player?.id ?? null,
              linkedPlayer.status,
            );
          }
        }
      }
    }
    backfillStartingXiFallbackPercentages(database);
  });
  transaction();
  bustPremiumOddsJoinCache(database);
  if (database === getDb()) scheduleChampionshipXiRebuild();
  return result;
}

function parsePositions(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((position): position is string => typeof position === "string")
      : [];
  } catch {
    return [];
  }
}

export function expected11ProfilePlayerId(tmUrl: string | null): string | null {
  return tmUrl?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
}

function parseNotes(value: string): SanitizedTeam["notes"] {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result: SanitizedTeam["notes"] = {};
    for (const key of [
      "teamAnalysis",
      "injuriesAndRecovery",
      "suspensionsAndIneligibilities",
      "additionalNotes",
    ]) {
      const note = parsed[key];
      result[key] =
        note &&
        typeof note === "object" &&
        typeof (note as { label?: unknown }).label === "string" &&
        typeof (note as { text?: unknown }).text === "string"
          ? {
              label: (note as { label: string }).label,
              text: (note as { text: string }).text,
            }
          : null;
    }
    return result;
  } catch {
    return {};
  }
}

export type Expected11ViewOptions = {
  narrativeMatchId?: string;
  matchIds?: string[];
};

export function getExpected11View(
  database: Database.Database = getDb(),
  options: Expected11ViewOptions = {},
) {
  relinkUnmatchedExpected11Teams(database);
  backfillMantraTmUrlsFromSquad(database);
  const matchIds = options.matchIds;
  const matches = (
    matchIds
      ? matchIds.length === 0
        ? []
        : database
            .prepare(
              `SELECT id, source_url AS sourceUrl, title, home_team AS homeTeam,
                      away_team AS awayTeam, formations_json AS formationsJson,
                      extracted_at AS extractedAt, imported_at AS importedAt
               FROM expected11_matches
               WHERE id IN (${matchIds.map(() => "?").join(",")})
               ORDER BY datetime(extracted_at) DESC, datetime(imported_at) DESC,
                        CAST(id AS INTEGER) DESC`,
            )
            .all(...matchIds)
      : database
          .prepare(
            `SELECT id, source_url AS sourceUrl, title, home_team AS homeTeam,
                    away_team AS awayTeam, formations_json AS formationsJson,
                    extracted_at AS extractedAt, imported_at AS importedAt
             FROM expected11_matches
             ORDER BY datetime(extracted_at) DESC, datetime(imported_at) DESC,
                      CAST(id AS INTEGER) DESC`,
          )
          .all()
  ) as Array<{
    id: string;
    sourceUrl: string;
    title: string;
    homeTeam: string | null;
    awayTeam: string | null;
    formationsJson: string;
    extractedAt: string;
    importedAt: string;
  }>;
  const emptyCounts = () => ({ linked: 0, unmatched: 0, ambiguous: 0 });
  if (matches.length === 0) {
    return {
      aggregate: { matches: 0, teams: 0, clubs: 0, ...emptyCounts() },
      matches: [],
    };
  }

  const teamQuery = database
    .prepare(
      `SELECT side, source_name AS sourceName, logo_url AS logoUrl,
              notes_json AS notesJson, author, mantra_club_id AS mantraClubId,
              mantra_club_name AS mantraClubName, link_status AS linkStatus
       FROM expected11_teams WHERE match_id = ?
       ORDER BY CASE side WHEN 'home' THEN 0 ELSE 1 END`,
    );
  type TeamRow = {
    side: "home" | "away";
    sourceName: string;
    logoUrl: string | null;
    notesJson: string;
    author: string | null;
    mantraClubId: number | null;
    mantraClubName: string | null;
    linkStatus: "linked" | "unmatched" | "ambiguous";
  };
  const playerQuery = database.prepare(
    `SELECT p.lineup_group AS lineupGroup, p.sort_order AS sortOrder,
            p.source_name AS sourceName,
            p.displayed_percentage AS displayedPercentage,
            p.link_status AS linkStatus, p.mantra_player_id AS mantraPlayerId,
            mp.name AS surname, mp.full_name AS fullName,
            mp.positions_json AS positionsJson, mp.tm_url AS tmUrl
     FROM expected11_predictions p
     LEFT JOIN mantra_players mp ON mp.id = p.mantra_player_id
     WHERE p.match_id = ? AND p.team_side = ?
     ORDER BY CASE p.lineup_group
       WHEN 'starting' THEN 0 WHEN 'bench' THEN 1 ELSE 2 END, p.sort_order`,
  );
  const aggregateCounts = emptyCounts();
  const clubKeys = new Set<string>();
  let teamCount = 0;
  const matchViews = matches.map((match) => {
    const counts = emptyCounts();
    const teams = teamQuery.all(match.id) as TeamRow[];
    teamCount += teams.length;
    const teamViews = teams.map((team) => {
      clubKeys.add(
        team.mantraClubId == null
          ? `source:${normName(team.sourceName)}`
          : `mantra:${team.mantraClubId}`,
      );
      const players = (
        playerQuery.all(match.id, team.side) as Array<{
          lineupGroup: Expected11LineupGroup;
          sortOrder: number;
          sourceName: string;
          displayedPercentage: number | null;
          linkStatus: "linked" | "unmatched" | "ambiguous";
          mantraPlayerId: number | null;
          surname: string | null;
          fullName: string | null;
          positionsJson: string | null;
          tmUrl: string | null;
        }>
      ).map((player) => {
        counts[player.linkStatus] += 1;
        aggregateCounts[player.linkStatus] += 1;
        const linked =
          player.linkStatus === "linked" && player.mantraPlayerId != null;
        const positions = linked ? parsePositions(player.positionsJson) : [];
        const playerId = linked ? expected11ProfilePlayerId(player.tmUrl) : null;
        return {
          lineupGroup: player.lineupGroup,
          sourceName: player.sourceName,
          displayedPercentage: withStartingXiFallbackPercentage(
            player.lineupGroup,
            player.displayedPercentage,
          ),
          linkStatus: player.linkStatus,
          mantraPlayerId: player.mantraPlayerId,
          surname: player.surname,
          fullName: player.fullName,
          position: positions[0] ?? null,
          positions,
          profilePlayerId: playerId,
          profileUrl: playerId ? `/player.html?id=${playerId}` : null,
        };
      });
      const { notesJson, ...teamView } = team;
      return {
        ...teamView,
        ...(options.narrativeMatchId === match.id
          ? { notes: parseNotes(notesJson) }
          : {}),
        players,
      };
    });
    return {
      id: match.id,
      sourceUrl: match.sourceUrl,
      title: match.title,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      formations: JSON.parse(match.formationsJson) as string[],
      extractedAt: match.extractedAt,
      importedAt: match.importedAt,
      teams: teamViews,
      counts,
    };
  });
  return {
    aggregate: {
      matches: matchViews.length,
      teams: teamCount,
      clubs: clubKeys.size,
      ...aggregateCounts,
    },
    matches: matchViews,
  };
}
