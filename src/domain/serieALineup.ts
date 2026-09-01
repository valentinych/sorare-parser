import type Database from "better-sqlite3";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { nameMatchScore, normName } from "../lib/names.js";
import { invalidateComputed } from "../lib/computedCache.js";

export const SERIE_A_XI_LEAGUE_ID = 135;
export const SERIE_A_XI_TOURNAMENT_ID = 1;
export const SERIE_A_LINEUP_SCORE_WEIGHT = 400;

export const LINEUP_SOURCES = ["fantacalcio", "sorareinside"] as const;
export type LineupSource = (typeof LINEUP_SOURCES)[number];
export type LineupGroup = "starting" | "bench" | "unknown";

export type SerieALineupPlayer = {
  name: string;
  displayedPercentage: number | null;
  lineupGroup: LineupGroup;
  slot: string | null;
  rawLabel: string | null;
};

export type SerieALineupClub = {
  name: string;
  formation: string | null;
  coach: string | null;
  players: SerieALineupPlayer[];
};

export type SerieALineupSnapshot = {
  source: LineupSource;
  sourceUrl: string;
  title: string;
  extractedAt: string;
  clubs: SerieALineupClub[];
};

export type SerieASourcePrediction = {
  displayedPercentage: number | null;
  lineupGroup: LineupGroup;
  sourceName: string;
  rawLabel: string | null;
  sourceUrl: string;
  extractedAt: string;
  importedAt: string;
};

export type SerieALineupPrediction = {
  fantacalcio: SerieASourcePrediction | null;
  sorareInside: SerieASourcePrediction | null;
};

export type SerieALineupImportResult = {
  source: LineupSource;
  clubs: number;
  players: number;
  linked: number;
  unmatched: number;
  ambiguous: number;
  clubLinked: number;
  clubUnmatched: number;
  unmatchedPlayers: Array<{ club: string; name: string }>;
};

const TEAM_ALIASES: Record<string, string> = {
  atalanta: "atalanta",
  "atalanta bergamasca calcio": "atalanta",
  bologna: "bologna",
  "bologna 1909": "bologna",
  "bologna fc 1909": "bologna",
  cagliari: "cagliari",
  "cagliari calcio": "cagliari",
  como: "como",
  "calcio como": "como",
  "como 1907": "como",
  fiorentina: "fiorentina",
  "acf fiorentina": "fiorentina",
  frosinone: "frosinone",
  genoa: "genoa",
  "genoa cfc": "genoa",
  inter: "inter",
  internazionale: "inter",
  "internazionale milano": "inter",
  "fc internazionale milano": "inter",
  "inter milan": "inter",
  juventus: "juventus",
  "juventus fc": "juventus",
  lazio: "lazio",
  "ss lazio": "lazio",
  lecce: "lecce",
  "us lecce": "lecce",
  milan: "milan",
  "ac milan": "milan",
  monza: "monza",
  napoli: "napoli",
  "ssc napoli": "napoli",
  parma: "parma",
  "parma calcio 1913": "parma",
  roma: "roma",
  "as roma": "roma",
  sassuolo: "sassuolo",
  "us sassuolo calcio": "sassuolo",
  torino: "torino",
  "torino fc": "torino",
  udinese: "udinese",
  "udinese calcio": "udinese",
  venezia: "venezia",
  cremonese: "cremonese",
  "us cremonese": "cremonese",
  pisa: "pisa",
  "pisa 1909": "pisa",
  "ac pisa 1909": "pisa",
  verona: "verona",
  "hellas verona": "verona",
  "hellas verona fc": "verona",
};

const PLAYER_ALIASES: Record<string, Record<string, string>> = {
  sassuolo: {
    "f missoni": "filippo missori",
    missoni: "filippo missori",
    "s turati": "stefano turati",
    "k bowie": "kian bowie",
  },
  como: {
    "i braupt": "ignace van der brempt",
    braupt: "ignace van der brempt",
    rodriguez: "jesus rodriguez",
    "j addai": "jayden addai",
    "n kuhn": "nicolas kuhn",
  },
  juventus: {
    "j david": "jonathan david",
    "p kalulu": "pierre kalulu",
    "g vicario": "guglielmo vicario",
    "l kelly": "lloyd kelly",
    "e zhegrova": "edon zhegrova",
    yildiz: "kenan yildiz",
  },
  parma: {
    "hans nicolussi": "hans nicolussi caviglia",
    "o sorensen": "oliver sorensen",
    "s britschgi": "simon britschgi",
    "e corvi": "enrico corvi",
  },
  udinese: {
    "j piotro": "jakub piotrowski",
    "v bayo": "vakoun bayo",
    "i gueye": "idryssa gueye",
  },
  inter: {
    "h mkhita": "henrikh mkhitaryan",
    "f acerbi": "francesco acerbi",
  },
  roma: {
    svilar: "mile svilar",
    wesley: "wesley franca",
    "d ghilardi": "daniele ghilardi",
    "n el aynaoui": "neil el aynaoui",
    "d rensch": "devyne rensch",
    "s castro": "santiago castro",
  },
  milan: {
    saelemakers: "alexis saelemaekers",
    "p terracciano": "pietro terracciano",
    "f tomori": "fikayo tomori",
    "y fofana": "youssouf fofana",
    "l modric": "luka modric",
    "c nkunku": "christopher nkunku",
    "s chukwueze": "samuel chukwueze",
  },
  atalanta: {
    "m sportiello": "marco sportiello",
    "h ahanor": "honest ahanor",
    "s kolasinac": "sead kolasinac",
    "r bellanova": "raoul bellanova",
    "l samardzic": "lazar samardzic",
    "n krstovic": "nikola krstovic",
  },
  bologna: {
    "r alhassane": "rahim alhassane",
    "n casale": "nicolo casale",
    "m vitik": "martin vitik",
    "n zortea": "nadir zortea",
    "t pobega": "tommaso pobega",
    "m amondarain": "martin amondarain",
    "o el azzouzi": "oussama el azzouzi",
    "n cambiaghi": "nicolo cambiaghi",
    "r piccoli": "roberto piccoli",
    "j rowe": "jonathan rowe",
    "l ferguson": "lewis ferguson",
  },
};

export function clubKey(name: string): string {
  const normalized = normName(name);
  return TEAM_ALIASES[normalized] ?? normalized;
}

export function mergePlayersByHighestPct(
  players: SerieALineupPlayer[],
): SerieALineupPlayer[] {
  const byKey = new Map<string, SerieALineupPlayer>();
  const order: string[] = [];
  for (const player of players) {
    const key = normName(player.name);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...player });
      order.push(key);
      continue;
    }
    const labels = [current.rawLabel, player.rawLabel].filter(Boolean);
    current.rawLabel = labels.length ? labels.join(" | ") : current.rawLabel;
    const currentPct = current.displayedPercentage;
    const nextPct = player.displayedPercentage;
    if (nextPct != null && (currentPct == null || nextPct > currentPct)) {
      current.displayedPercentage = nextPct;
      current.lineupGroup = player.lineupGroup;
      current.slot = player.slot ?? current.slot;
    } else if (currentPct == null && nextPct == null) {
      if (player.lineupGroup === "starting") current.lineupGroup = "starting";
    }
  }
  return order.map((key) => byKey.get(key)!);
}

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error("invalid_extracted_at");
  }
  return value;
}

function parsePlayerNames(line: string): string[] {
  return line
    .replace(/\([^)]*\)/g, " ")
    .replace(/\.$/, "")
    .split(/[;,]/)
    .map((part) => part.replace(/\.$/, "").trim())
    .filter((part) => part.length >= 2);
}

export function parseFantacalcioArticle(
  html: string,
  extractedAt = new Date().toISOString(),
): SerieALineupSnapshot {
  const asides = [...html.matchAll(/<aside class="text-type-aside">([\s\S]*?)<\/aside>/gi)].map(
    (match) => match[1]!,
  );
  if (asides.length === 0) throw new Error("fantacalcio_asides_missing");
  const clubs: SerieALineupClub[] = [];
  for (const aside of asides) {
    const text = aside
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/h2>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&rsquo;/g, "’")
      .replace(/&ograve;/g, "ò")
      .replace(/&eacute;/g, "é")
      .replace(/&egrave;/g, "è")
      .replace(/&agrave;/g, "à")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .trim();
    const name = text.match(/^([A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’ -]+)/)?.[1]?.trim();
    if (!name) continue;
    const formation = text.match(/Modulo:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
    const coach = text.match(/Allenatore:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
    const xiLine = text.match(/Probabile formazione[^:]*:\s*([^\n]+)/i)?.[1] ?? "";
    const ballotLine = text.match(/Ballottaggi:\s*([^\n]+)/i)?.[1] ?? "";
    const starters = parsePlayerNames(xiLine);
    const challengers = parsePlayerNames(ballotLine)
      .flatMap((pair) => pair.split("/").map((name) => name.trim()))
      .filter(Boolean);
    const starterSet = new Set(starters.map((player) => normName(player)));
    const players: SerieALineupPlayer[] = starters.map((player, index) => ({
      name: player,
      displayedPercentage: null,
      lineupGroup: "starting",
      slot: String(index),
      rawLabel: `XI: ${player}`,
    }));
    for (const player of challengers) {
      if (starterSet.has(normName(player))) continue;
      players.push({
        name: player,
        displayedPercentage: null,
        lineupGroup: "bench",
        slot: null,
        rawLabel: `ballottaggio: ${player}`,
      });
    }
    clubs.push({
      name,
      formation,
      coach,
      players: mergePlayersByHighestPct(players),
    });
  }
  if (clubs.length === 0) throw new Error("fantacalcio_clubs_missing");
  return {
    source: "fantacalcio",
    sourceUrl:
      "https://www.fantacalcio.it/news/calcio-italia/06_08_2026/asta-fantacalcio-le-probabili-formazioni-della-serie-a-enilive-2026-27-495558",
    title: "Asta Fantacalcio, le probabili formazioni della Serie A Enilive 2026/27",
    extractedAt: isoDate(extractedAt),
    clubs,
  };
}

export function normalizeSerieALineupSnapshot(snapshot: SerieALineupSnapshot): SerieALineupSnapshot {
  if (!LINEUP_SOURCES.includes(snapshot.source)) {
    throw new Error("invalid_lineup_source");
  }
  return {
    ...snapshot,
    extractedAt: isoDate(snapshot.extractedAt),
    clubs: snapshot.clubs.map((club) => ({
      ...club,
      players: mergePlayersByHighestPct(
        club.players.filter((player) => {
          const named = player.name.trim() && !/^unknown$/i.test(player.name.trim());
          return named;
        }),
      ),
    })),
  };
}

type ClubRow = {
  key: string;
  afTeamId: number | null;
  afTeamName: string | null;
  mantraClubId: number | null;
  mantraClubName: string | null;
};

type PlayerCandidate = {
  id: number;
  names: string[];
};

function canonicalClub(name: string): string {
  return clubKey(name);
}

function aliasPlayerName(club: string, name: string): string {
  const aliases = PLAYER_ALIASES[canonicalClub(club)];
  return aliases?.[normName(name)] ?? name;
}

function uniqueNameMatch(
  sourceName: string,
  candidates: PlayerCandidate[],
): { status: "linked" | "unmatched" | "ambiguous"; id: number | null } {
  const scored = candidates
    .map((candidate) => ({
      id: candidate.id,
      score: Math.max(0, ...candidate.names.map((name) => nameMatchScore(sourceName, name))),
    }))
    .filter((row) => row.score >= 40)
    .sort((a, b) => b.score - a.score || a.id - b.id);
  if (scored.length === 0) return { status: "unmatched", id: null };
  const best = scored[0]!.score;
  const winners = scored.filter((row) => row.score === best);
  if (winners.length !== 1) return { status: "ambiguous", id: null };
  return { status: "linked", id: winners[0]!.id };
}

function loadClubIndex(
  database: Database.Database,
  season = config.predictSeason,
): { clubs: Map<string, ClubRow>; afPlayers: Map<string, PlayerCandidate[]>; mantraPlayers: Map<string, PlayerCandidate[]> } {
  const clubs = new Map<string, ClubRow>();
  const afRows = database
    .prepare(
      `SELECT team_id AS id, name FROM season_teams
       WHERE season = ? AND league_id = ?`,
    )
    .all(season, SERIE_A_XI_LEAGUE_ID) as Array<{ id: number; name: string }>;
  for (const row of afRows) {
    const key = canonicalClub(row.name);
    const current = clubs.get(key) ?? {
      key,
      afTeamId: null,
      afTeamName: null,
      mantraClubId: null,
      mantraClubName: null,
    };
    current.afTeamId = row.id;
    current.afTeamName = row.name;
    clubs.set(key, current);
  }
  const mantraRows = database
    .prepare(
      `SELECT DISTINCT club_id AS id, club_name AS name
       FROM mantra_players
       WHERE tournament_id = ? AND club_id IS NOT NULL AND club_name IS NOT NULL`,
    )
    .all(SERIE_A_XI_TOURNAMENT_ID) as Array<{ id: number; name: string }>;
  for (const row of mantraRows) {
    const key = canonicalClub(row.name);
    const current = clubs.get(key) ?? {
      key,
      afTeamId: null,
      afTeamName: null,
      mantraClubId: null,
      mantraClubName: null,
    };
    current.mantraClubId = row.id;
    current.mantraClubName = row.name;
    clubs.set(key, current);
  }

  const afPlayers = new Map<string, PlayerCandidate[]>();
  const squadRows = database
    .prepare(
      `SELECT sp.player_id AS id, sp.name, st.name AS teamName
       FROM squad_players sp
       JOIN season_teams st ON st.season = sp.season AND st.team_id = sp.team_id
       WHERE sp.season = ? AND st.league_id = ?`,
    )
    .all(season, SERIE_A_XI_LEAGUE_ID) as Array<{ id: number; name: string; teamName: string }>;
  for (const row of squadRows) {
    const key = canonicalClub(row.teamName);
    const list = afPlayers.get(key) ?? [];
    list.push({ id: row.id, names: [row.name] });
    afPlayers.set(key, list);
  }

  const mantraPlayers = new Map<string, PlayerCandidate[]>();
  const playerRows = database
    .prepare(
      `SELECT id, name, first_name AS firstName, full_name AS fullName, club_name AS clubName
       FROM mantra_players
       WHERE tournament_id = ? AND club_id IS NOT NULL AND club_name IS NOT NULL`,
    )
    .all(SERIE_A_XI_TOURNAMENT_ID) as Array<{
    id: number;
    name: string;
    firstName: string | null;
    fullName: string | null;
    clubName: string;
  }>;
  for (const row of playerRows) {
    const key = canonicalClub(row.clubName);
    const list = mantraPlayers.get(key) ?? [];
    const names = [row.fullName, row.name];
    if (row.firstName && row.name) {
      names.push(`${row.firstName} ${row.name}`, `${row.name} ${row.firstName}`);
    }
    list.push({ id: row.id, names: names.filter((value): value is string => Boolean(value)) });
    mantraPlayers.set(key, list);
  }
  return { clubs, afPlayers, mantraPlayers };
}

export const SERIE_A_LINEUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS serie_a_lineup_snapshots (
  source TEXT PRIMARY KEY CHECK (source IN ('fantacalcio', 'sorareinside')),
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS serie_a_lineup_predictions (
  source TEXT NOT NULL CHECK (source IN ('fantacalcio', 'sorareinside')),
  club_key TEXT NOT NULL,
  source_club TEXT NOT NULL,
  source_player TEXT NOT NULL,
  lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench', 'unknown')),
  sort_order INTEGER NOT NULL,
  displayed_percentage REAL,
  raw_label TEXT,
  slot TEXT,
  af_player_id INTEGER,
  af_team_id INTEGER,
  mantra_player_id INTEGER,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (source, club_key, source_player),
  FOREIGN KEY (source) REFERENCES serie_a_lineup_snapshots(source) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_serie_a_lineup_af_player
  ON serie_a_lineup_predictions(af_player_id);
`;

export function serieALineupSnapshotVersion(
  database: Database.Database = getDb(),
): string | null {
  database.exec(SERIE_A_LINEUP_SCHEMA);
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM serie_a_lineup_snapshots) AS n,
         (SELECT MAX(imported_at) FROM serie_a_lineup_snapshots) AS importedAt,
         (SELECT MAX(extracted_at) FROM serie_a_lineup_snapshots) AS extractedAt`,
    )
    .get() as { n: number; importedAt: string | null; extractedAt: string | null };
  if (!row.n) return null;
  return [row.n, row.importedAt, row.extractedAt].filter(Boolean).join("|");
}

export function importSerieALineupSnapshot(
  snapshot: SerieALineupSnapshot,
  database: Database.Database = getDb(),
  options: { season?: number; rebuildCache?: boolean } = {},
): SerieALineupImportResult {
  const normalized = normalizeSerieALineupSnapshot(snapshot);
  database.exec(SERIE_A_LINEUP_SCHEMA);
  const index = loadClubIndex(database, options.season ?? config.predictSeason);
  const result: SerieALineupImportResult = {
    source: normalized.source,
    clubs: normalized.clubs.length,
    players: 0,
    linked: 0,
    unmatched: 0,
    ambiguous: 0,
    clubLinked: 0,
    clubUnmatched: 0,
    unmatchedPlayers: [],
  };
  const upsertSnap = database.prepare(
    `INSERT INTO serie_a_lineup_snapshots
       (source, source_url, title, extracted_at, imported_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source) DO UPDATE SET
       source_url = excluded.source_url,
       title = excluded.title,
       extracted_at = excluded.extracted_at,
       imported_at = excluded.imported_at`,
  );
  const insertPlayer = database.prepare(
    `INSERT INTO serie_a_lineup_predictions
       (source, club_key, source_club, source_player, lineup_group, sort_order,
        displayed_percentage, raw_label, slot, af_player_id, af_team_id,
        mantra_player_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const transaction = database.transaction(() => {
    upsertSnap.run(
      normalized.source,
      normalized.sourceUrl,
      normalized.title,
      normalized.extractedAt,
    );
    database
      .prepare(`DELETE FROM serie_a_lineup_predictions WHERE source = ?`)
      .run(normalized.source);
    for (const club of normalized.clubs) {
      const key = canonicalClub(club.name);
      const linkedClub = index.clubs.get(key);
      if (linkedClub?.afTeamId != null || linkedClub?.mantraClubId != null) {
        result.clubLinked += 1;
      } else {
        result.clubUnmatched += 1;
      }
      for (const [sortOrder, player] of club.players.entries()) {
        const sourceName = aliasPlayerName(club.name, player.name);
        const afMatch = linkedClub
          ? uniqueNameMatch(sourceName, index.afPlayers.get(key) ?? [])
          : { status: "unmatched" as const, id: null };
        const mantraMatch = linkedClub
          ? uniqueNameMatch(sourceName, index.mantraPlayers.get(key) ?? [])
          : { status: "unmatched" as const, id: null };
        const status =
          afMatch.status === "linked" || mantraMatch.status === "linked"
            ? "linked"
            : afMatch.status === "ambiguous" || mantraMatch.status === "ambiguous"
              ? "ambiguous"
              : "unmatched";
        result.players += 1;
        result[status] += 1;
        if (status !== "linked") {
          result.unmatchedPlayers.push({ club: club.name, name: player.name });
        }
        insertPlayer.run(
          normalized.source,
          key,
          club.name,
          player.name,
          player.lineupGroup,
          sortOrder,
          player.displayedPercentage,
          player.rawLabel,
          player.slot,
          afMatch.id,
          linkedClub?.afTeamId ?? null,
          mantraMatch.id,
          status,
        );
      }
    }
  });
  transaction();
  if (options.rebuildCache !== false && database === getDb()) {
    invalidateComputed("xi:", { persist: true });
    invalidateComputed("board:", { persist: true });
  }
  return result;
}

export function serieALineupForAfPlayers(
  leagueId: number,
  afPlayerIds: number[],
  database: Database.Database = getDb(),
): Map<number, SerieALineupPrediction> {
  if (leagueId !== SERIE_A_XI_LEAGUE_ID) return new Map();
  database.exec(SERIE_A_LINEUP_SCHEMA);
  const uniqueIds = [...new Set(afPlayerIds.filter(Number.isSafeInteger))];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT p.source, p.source_player AS sourceName, p.lineup_group AS lineupGroup,
              p.displayed_percentage AS displayedPercentage, p.raw_label AS rawLabel,
              p.af_player_id AS afPlayerId, s.source_url AS sourceUrl,
              s.extracted_at AS extractedAt, s.imported_at AS importedAt
       FROM serie_a_lineup_predictions p
       JOIN serie_a_lineup_snapshots s ON s.source = p.source
       WHERE p.link_status = 'linked' AND p.af_player_id IN (${placeholders})`,
    )
    .all(...uniqueIds) as Array<{
    source: LineupSource;
    sourceName: string;
    lineupGroup: LineupGroup;
    displayedPercentage: number | null;
    rawLabel: string | null;
    afPlayerId: number;
    sourceUrl: string;
    extractedAt: string;
    importedAt: string;
  }>;
  const result = new Map<number, SerieALineupPrediction>();
  for (const row of rows) {
    const current = result.get(row.afPlayerId) ?? { fantacalcio: null, sorareInside: null };
    const payload: SerieASourcePrediction = {
      displayedPercentage: row.displayedPercentage,
      lineupGroup: row.lineupGroup,
      sourceName: row.sourceName,
      rawLabel: row.rawLabel,
      sourceUrl: row.sourceUrl,
      extractedAt: row.extractedAt,
      importedAt: row.importedAt,
    };
    if (row.source === "fantacalcio") current.fantacalcio = payload;
    else current.sorareInside = payload;
    result.set(row.afPlayerId, current);
  }
  return result;
}

export function serieALineupScoreBonus(prediction: SerieALineupPrediction | null): number {
  if (!prediction) return 0;
  const values = [
    prediction.fantacalcio?.displayedPercentage,
    prediction.sorareInside?.displayedPercentage,
  ].filter((value): value is number => value != null);
  if (values.length === 0) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length / 100;
  return (avg - 0.5) * SERIE_A_LINEUP_SCORE_WEIGHT;
}
