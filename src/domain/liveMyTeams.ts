/**
 * Live «Мои команды»: current-round fixtures of the logged-in manager's clubs,
 * plus the squad players who are in those published lineups.
 */
import type Database from "better-sqlite3";
import { expected11ProfilePlayerId } from "./expected11Import.js";
import { effectiveLivePhase } from "./liveMatches.js";
import { computeMantraMatch, computeMantraMatchMap, slimMantraMatchMapForCards } from "./mantraLiveScore.js";
import { getMantraToursCached } from "../sync/syncMantraTours.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import { namesMatch } from "../lib/names.js";
import { loadMantraLineups } from "../sync/syncMantraLineups.js";
import {
  allLiveLeagues,
  leagueFlagEmoji,
  liveRoundMetaKey,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";

export const LIVE_MY_TEAMS_SLUG = "my-teams";

export const LIVE_MY_TEAMS_SIGN_IN =
  "Войдите и укажите Mantra Manager ID, чтобы увидеть матчи своих команд.";
export const LIVE_MY_TEAMS_NEED_ID =
  "Укажите Mantra Manager ID в профиле, чтобы увидеть матчи своих команд.";
export const LIVE_MY_TEAMS_NO_MATCHES = "Матчей ваших клубов в текущем туре нет.";

export type LiveMyTeamGroup = "live" | "xi" | "bench";

/** Score chip: not started, unused after FT, in-play, or finished with an appearance. */
export type LiveMyTeamChip = "pending" | "unused" | "live" | "played";

export type LiveMyTeamColumns = Record<LiveMyTeamGroup, LiveMyTeamPlayer[]>;

export type LiveMyTeamStatus = "signed_out" | "no_manager" | "ok";

const COLUMN_ORDER: LiveMyTeamGroup[] = ["live", "xi", "bench"];

const LIVE_STATUS_SHORT = new Set(["LIVE", "1H", "HT", "2H", "ET", "P", "BT", "INT"]);
const FINISHED_STATUS_SHORT = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

type SquadPlayer = {
  id: number;
  surname: string;
  clubName: string;
  fotmobPlayerId: number | null;
  tmUrl: string | null;
  slugs: Set<string>;
};

type FotmobSidePlayer = {
  playerId: number;
  name: string;
  teamName: string | null;
  isHome: boolean;
  starter: boolean;
};

export type LiveMyTeamMatch = {
  id: number;
  round: string | null;
  kickoff: string | null;
  home: { id: number; name: string };
  away: { id: number; name: string };
  scoreHome: number | null;
  scoreAway: number | null;
  statusShort: string | null;
  phase: string;
  leagueSlug: string;
  leagueName: string;
  leagueFlag: string;
  goals: [];
  cards: [];
  topBySide: { home: null; away: null };
  potm: null;
};

export type LiveMyTeamPlayer = {
  mantraPlayerId: number;
  surname: string;
  clubName: string;
  leagueSlug: string;
  leagueName: string;
  leagueFlag: string;
  profileUrl: string | null;
  matchId: number;
  group: LiveMyTeamGroup;
  chip: LiveMyTeamChip;
  score: number | null;
  scoreText: string;
  scoreTitle: string;
};

export type LiveMyTeamPairSide = {
  teamId: number | null;
  teamName: string;
  score: number | null;
  goals: number | null;
  scoredCount: number | null;
};

/** One current-round Mantra pair that includes the manager's fantasy team. */
export type LiveMyTeamPair = {
  leagueSlug: string;
  leagueName: string;
  leagueFlag: string;
  matchId: number | null;
  home: LiveMyTeamPairSide;
  away: LiveMyTeamPairSide;
};

export type LiveMyTeamComputed = ReturnType<typeof slimMantraMatchMapForCards>;

export type LiveMyTeamsView = {
  status: LiveMyTeamStatus;
  message: string | null;
  matches: LiveMyTeamMatch[];
  columns: LiveMyTeamColumns;
  pairs: LiveMyTeamPair[];
  computed: LiveMyTeamComputed;
};

function emptyColumns(): LiveMyTeamColumns {
  return { live: [], xi: [], bench: [] };
}

/**
 * Σ column on the mantra match roster (`breakdown.total`), not BASE (`breakdown.base`).
 * Null when the detail table would show «—» (NS / not scored yet).
 */
export function mantraRosterSigma(
  player: { breakdown?: { total?: number | null } | null } | null | undefined,
): number | null {
  const total = player?.breakdown?.total;
  if (total == null || !Number.isFinite(Number(total))) return null;
  return Number(total);
}

export function formatLiveMyTeamScore(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "—";
  return Number(score).toFixed(2);
}

function statusShortOf(statusShort: string | null | undefined): string {
  return String(statusShort ?? "")
    .trim()
    .toUpperCase();
}

/**
 * LIVE: starters and subs who have come on while the match is in progress.
 * XI: starters whose match is not live (not started, or already finished).
 * Запас: bench who are not in LIVE. A sub on in a live match stays in LIVE.
 * No published lineup row → omit.
 * NS/TBD bench stays on the bench even if a stray sub event exists.
 */
export function classifyLiveMyTeamPlayer(input: {
  inLineup: boolean;
  starter: boolean;
  matchLive: boolean;
  cameOn: boolean;
}): LiveMyTeamGroup | null {
  if (!input.inLineup) return null;
  if (input.matchLive && (input.starter || input.cameOn)) return "live";
  if (input.starter) return "xi";
  return "bench";
}

export function liveMyTeamMatchStarted(
  phase: string,
  statusShort: string | null | undefined,
): boolean {
  const short = statusShortOf(statusShort);
  if (short === "NS" || short === "TBD") return false;
  if (FINISHED_STATUS_SHORT.has(short)) return true;
  return phase === "live" || phase === "finished";
}

/** In progress: phase live, or 1H / HT / 2H / ET / P. Finished shorts never count. */
export function liveMyTeamMatchLive(
  phase: string,
  statusShort: string | null | undefined,
): boolean {
  const short = statusShortOf(statusShort);
  if (short === "NS" || short === "TBD") return false;
  if (FINISHED_STATUS_SHORT.has(short) || phase === "finished" || phase === "cancelled") return false;
  if (phase === "live") return true;
  return LIVE_STATUS_SHORT.has(short);
}

export function liveMyTeamMatchFinished(
  phase: string,
  statusShort: string | null | undefined,
): boolean {
  const short = statusShortOf(statusShort);
  if (FINISHED_STATUS_SHORT.has(short)) return true;
  return phase === "finished";
}

/**
 * pending — not started: black dash, white chip.
 * unused — finished and did not appear: white dash, red chip.
 * live — in the LIVE column: red text, white chip (dash if Σ is missing).
 * played — finished and appeared: white text, black chip (dash if Σ is missing).
 * Bench still on the pitch of a live match stays pending: they can still come on.
 */
export function liveMyTeamChip(input: {
  group: LiveMyTeamGroup;
  matchStarted: boolean;
  matchFinished: boolean;
  appeared: boolean;
}): LiveMyTeamChip {
  if (input.group === "live") return "live";
  if (!input.matchStarted || !input.matchFinished) return "pending";
  if (!input.appeared) return "unused";
  return "played";
}

function parseIdArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  } catch {
    return [];
  }
}

function leagueByTournament(tournamentId: number | null): LiveLeagueDef | null {
  if (tournamentId == null) return null;
  return allLiveLeagues().find((league) => league.mantraTournamentId === tournamentId) ?? null;
}

function currentRound(db: Database.Database, league: LiveLeagueDef): string | null {
  const meta = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveRoundMetaKey(league.slug)) as { value: string } | undefined;
  const stored = meta?.value?.trim();
  if (stored) return stored;

  const live = db
    .prepare(
      `SELECT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'live' AND round IS NOT NULL AND round != ''
       ORDER BY kickoff DESC LIMIT 1`,
    )
    .get(league.fotmobLeagueId) as { round: string } | undefined;
  if (live?.round) return live.round;

  const finished = db
    .prepare(
      `SELECT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'finished' AND round IS NOT NULL AND round != ''
       ORDER BY kickoff DESC LIMIT 1`,
    )
    .get(league.fotmobLeagueId) as { round: string } | undefined;
  const next = db
    .prepare(
      `SELECT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'upcoming' AND round IS NOT NULL AND round != ''
       ORDER BY kickoff ASC LIMIT 1`,
    )
    .get(league.fotmobLeagueId) as { round: string } | undefined;
  return finished?.round ?? next?.round ?? null;
}

function cameOnFromEvents(
  rows: Array<{ raw_json: string | null; player_name: string | null }>,
): { ids: Set<number>; names: string[] } {
  const ids = new Set<number>();
  const names: string[] = [];
  for (const row of rows) {
    if (!row.raw_json) continue;
    try {
      const raw = JSON.parse(row.raw_json) as { swap?: Array<{ id?: unknown; name?: unknown }> };
      const incoming = Array.isArray(raw.swap) ? raw.swap[0] : null;
      const id = incoming?.id != null ? Number(incoming.id) : NaN;
      if (Number.isFinite(id) && id > 0) ids.add(id);
      if (incoming?.name != null && String(incoming.name).trim()) names.push(String(incoming.name));
    } catch {
      /* missing sub payload — that player stays unused */
    }
  }
  return { ids, names };
}

function playerCameOn(
  player: FotmobSidePlayer,
  cameOn: { ids: Set<number>; names: string[] },
): boolean {
  if (cameOn.ids.has(player.playerId)) return true;
  return cameOn.names.some((name) => namesMatch(name, player.name));
}

function findLineupRow(
  squad: SquadPlayer,
  rows: FotmobSidePlayer[],
): FotmobSidePlayer | null {
  if (squad.fotmobPlayerId != null) {
    const byId = rows.find((row) => row.playerId === squad.fotmobPlayerId);
    if (byId) return byId;
  }
  const named = rows.filter(
    (row) => namesMatch(squad.surname, row.name) || namesMatch(row.name, squad.surname),
  );
  return named.length === 1 ? named[0]! : null;
}

function sideRows(
  rows: FotmobSidePlayer[],
  clubName: string,
  homeName: string,
  awayName: string,
): FotmobSidePlayer[] {
  const home = clubsMatch(clubName, homeName);
  const away = clubsMatch(clubName, awayName);
  return rows.filter((row) => {
    if (row.teamName && clubsMatch(clubName, row.teamName)) return true;
    if (home && row.isHome) return true;
    if (away && !row.isHome) return true;
    return false;
  });
}

function loadSquad(db: Database.Database, managerId: number): {
  players: SquadPlayer[];
  teamIdsBySlug: Map<string, number[]>;
} {
  const teams = db
    .prepare(
      `SELECT id, tournament_id AS tournamentId, players_json AS playersJson
       FROM mantra_fantasy_teams
       WHERE user_id = ?`,
    )
    .all(managerId) as Array<{ id: number; tournamentId: number | null; playersJson: string }>;

  const slugsByPlayer = new Map<number, Set<string>>();
  const teamIdsBySlug = new Map<string, number[]>();
  for (const team of teams) {
    const league = leagueByTournament(team.tournamentId);
    if (!league || team.tournamentId == null) continue;
    const teamIds = teamIdsBySlug.get(league.slug) ?? [];
    teamIds.push(team.id);
    teamIdsBySlug.set(league.slug, teamIds);
    for (const id of parseIdArray(team.playersJson)) {
      const slugs = slugsByPlayer.get(id) ?? new Set<string>();
      slugs.add(league.slug);
      slugsByPlayer.set(id, slugs);
    }
  }
  const ids = [...slugsByPlayer.keys()];
  if (!ids.length) return { players: [], teamIdsBySlug };

  const rows = db
    .prepare(
      `SELECT id, name, club_name AS clubName, fotmob_player_id AS fotmobPlayerId, tm_url AS tmUrl
       FROM mantra_players
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{
    id: number;
    name: string;
    clubName: string | null;
    fotmobPlayerId: number | null;
    tmUrl: string | null;
  }>;

  const players: SquadPlayer[] = [];
  for (const row of rows) {
    const clubName = row.clubName?.trim() || "";
    if (!clubName) continue;
    players.push({
      id: row.id,
      surname: row.name,
      clubName,
      fotmobPlayerId: row.fotmobPlayerId,
      tmUrl: row.tmUrl,
      slugs: slugsByPlayer.get(row.id) ?? new Set(),
    });
  }
  return { players, teamIdsBySlug };
}

type TsOverride = {
  mantraPlayerId: number;
  total?: number | null;
  breakdown?: { total?: number | null; base?: number | null } | null;
};

function sigmaFromOverride(row: TsOverride): number | null {
  if (row.breakdown !== undefined) return mantraRosterSigma(row);
  if (row.total == null || !Number.isFinite(Number(row.total))) return null;
  return Number(row.total);
}

type SigmaIndex = {
  byId: Map<number, number | null>;
  unnamed: Array<{ name: string; clubName: string | null; total: number | null }>;
};

function emptySigma(): SigmaIndex {
  return { byId: new Map(), unnamed: [] };
}

function rememberSigma(
  index: SigmaIndex,
  player: {
    playerId?: number | null;
    name?: string | null;
    clubName?: string | null;
    breakdown?: { total?: number | null } | null;
  },
): void {
  const total = mantraRosterSigma(player);
  if (player.playerId != null && !index.byId.has(player.playerId)) {
    index.byId.set(player.playerId, total);
    return;
  }
  if (player.playerId != null) return;
  const name = player.name?.trim();
  if (!name) return;
  index.unnamed.push({ name, clubName: player.clubName ?? null, total });
}

function pairSide(side: {
  teamId: number | null;
  teamName: string;
  score: number | null;
  goals: number | null;
  scoredCount: number | null;
}): LiveMyTeamPairSide {
  return {
    teamId: side.teamId,
    teamName: side.teamName,
    score: side.score,
    goals: side.goals,
    scoredCount: side.scoredCount,
  };
}

/** Current Mantra tour pairs for the manager's fantasy teams, same cards as the division grid. */
function loadManagerPairs(teamIdsBySlug: Map<string, number[]>): {
  pairs: LiveMyTeamPair[];
  computed: LiveMyTeamComputed;
} {
  const pairs: LiveMyTeamPair[] = [];
  const full: Parameters<typeof slimMantraMatchMapForCards>[0] = {};
  for (const [slug, teamIds] of teamIdsBySlug) {
    const league = allLiveLeagues().find((item) => item.slug === slug);
    if (!league || !teamIds.length) continue;
    let tours;
    try {
      tours = getMantraToursCached(slug).tours;
    } catch (err) {
      console.warn(
        "Live my-teams pairs skipped:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const round = tours.find((tour) => tour.round != null)?.round ?? null;
    const roundKey = round != null ? String(round) : null;
    const want = new Set(teamIds);
    const cached = roundKey
      ? computeMantraMatchMap(roundKey, slug, { blockOnMiss: false })
      : {};
    const seen = new Set<string>();
    for (const tour of tours) {
      for (const match of tour.matches) {
        const home = match.home.teamId != null && want.has(match.home.teamId);
        const away = match.away.teamId != null && want.has(match.away.teamId);
        if (!home && !away) continue;
        const key =
          match.matchId != null
            ? `m:${match.matchId}`
            : `t:${match.home.teamId ?? "?"}-${match.away.teamId ?? "?"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          leagueSlug: slug,
          leagueName: league.name,
          leagueFlag: leagueFlagEmoji(slug),
          matchId: match.matchId,
          home: pairSide(match.home),
          away: pairSide(match.away),
        });
        if (match.matchId == null) continue;
        const id = String(match.matchId);
        const computed = cached[id] ?? computeMantraMatch(match.matchId, roundKey, slug);
        if (computed) full[id] = computed;
      }
    }
  }
  pairs.sort(
    (a, b) =>
      a.leagueName.localeCompare(b.leagueName) ||
      a.home.teamName.localeCompare(b.home.teamName) ||
      (a.matchId ?? 0) - (b.matchId ?? 0),
  );
  return { pairs, computed: slimMantraMatchMapForCards(full) };
}

function lookupSigma(index: SigmaIndex, squad: SquadPlayer): number | null {
  if (index.byId.has(squad.id)) return index.byId.get(squad.id) ?? null;
  const named = index.unnamed.filter(
    (player) =>
      namesMatch(squad.surname, player.name) &&
      (!player.clubName || clubsMatch(squad.clubName, player.clubName)),
  );
  return named.length === 1 ? named[0]!.total : null;
}

/** Σ from the manager's current mantra match — the same `breakdown.total` the roster prints. */
function loadManagerSigma(
  db: Database.Database,
  teamIdsBySlug: Map<string, number[]>,
): SigmaIndex {
  const index = emptySigma();
  for (const [slug, teamIds] of teamIdsBySlug) {
    const league = allLiveLeagues().find((item) => item.slug === slug);
    if (!league || !teamIds.length) continue;
    const round = currentRound(db, league);
    if (!round) continue;
    try {
      const file = loadMantraLineups(round, slug);
      if (!file?.matches) continue;
      const want = new Set(teamIds);
      const cached = computeMantraMatchMap(round, slug, { blockOnMiss: false });
      for (const match of Object.values(file.matches)) {
        const home = match.home?.teamId != null && want.has(match.home.teamId);
        const away = match.away?.teamId != null && want.has(match.away.teamId);
        if (!home && !away) continue;
        const computed = cached[String(match.id)] ?? computeMantraMatch(match.id, round, slug);
        if (!computed) continue;
        const sides = [home ? computed.home : null, away ? computed.away : null];
        for (const side of sides) {
          if (!side) continue;
          for (const player of [...side.players, ...side.bench]) rememberSigma(index, player);
        }
      }
    } catch (err) {
      console.warn(
        "Live my-teams TS skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return index;
}

function sigmaIndexFromOverride(rows: TsOverride[]): SigmaIndex {
  const index = emptySigma();
  for (const row of rows) {
    const id = Number(row.mantraPlayerId);
    if (!Number.isSafeInteger(id) || id <= 0 || index.byId.has(id)) continue;
    index.byId.set(id, sigmaFromOverride(row));
  }
  return index;
}

export function buildLiveMyTeams(
  db: Database.Database,
  opts: {
    signedIn: boolean;
    managerId: number | null;
    scoreRows?: TsOverride[];
    pairs?: LiveMyTeamPair[];
    computed?: LiveMyTeamComputed;
  },
): LiveMyTeamsView {
  const blank = (status: LiveMyTeamStatus, message: string): LiveMyTeamsView => ({
    status,
    message,
    matches: [],
    columns: emptyColumns(),
    pairs: [],
    computed: {},
  });
  if (!opts.signedIn) return blank("signed_out", LIVE_MY_TEAMS_SIGN_IN);
  if (opts.managerId == null) return blank("no_manager", LIVE_MY_TEAMS_NEED_ID);

  const { players, teamIdsBySlug } = loadSquad(db, opts.managerId);
  const clubsBySlug = new Map<string, SquadPlayer[]>();
  for (const player of players) {
    for (const slug of player.slugs) {
      const list = clubsBySlug.get(slug) ?? [];
      list.push(player);
      clubsBySlug.set(slug, list);
    }
  }

  const matches: LiveMyTeamMatch[] = [];
  const columns = emptyColumns();
  const seenPlayers = new Set<string>();
  const sigma = opts.scoreRows
    ? sigmaIndexFromOverride(opts.scoreRows)
    : loadManagerSigma(db, teamIdsBySlug);
  const loadedPairs =
    opts.scoreRows || opts.pairs
      ? { pairs: opts.pairs ?? [], computed: opts.computed ?? {} }
      : loadManagerPairs(teamIdsBySlug);

  for (const league of allLiveLeagues()) {
    const squad = clubsBySlug.get(league.slug);
    if (!squad?.length) continue;
    const round = currentRound(db, league);
    if (!round) continue;
    const fixtureRows = db
      .prepare(
        `SELECT id, round, kickoff, home_id AS homeId, home_name AS homeName,
                away_id AS awayId, away_name AS awayName,
                score_home AS scoreHome, score_away AS scoreAway,
                status_short AS statusShort, phase
         FROM fotmob_matches
         WHERE league_id = ? AND round = ?
         ORDER BY kickoff ASC, id ASC`,
      )
      .all(league.fotmobLeagueId, round) as Array<{
      id: number;
      round: string | null;
      kickoff: string | null;
      homeId: number;
      homeName: string;
      awayId: number;
      awayName: string;
      scoreHome: number | null;
      scoreAway: number | null;
      statusShort: string | null;
      phase: string;
    }>;

    const clubMatchesFixture = fixtureRows.filter((fixture) =>
      squad.some(
        (player) =>
          clubsMatch(player.clubName, fixture.homeName) ||
          clubsMatch(player.clubName, fixture.awayName),
      ),
    );
    if (!clubMatchesFixture.length) continue;

    const ids = clubMatchesFixture.map((fixture) => fixture.id);
    const lineupRows = db
      .prepare(
        `SELECT match_id AS matchId, player_id AS playerId, name, team_name AS teamName,
                is_home AS isHome, starter
         FROM fotmob_match_players
         WHERE match_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{
      matchId: number;
      playerId: number;
      name: string | null;
      teamName: string | null;
      isHome: number;
      starter: number;
    }>;
    const eventRows = db
      .prepare(
        `SELECT match_id AS matchId, raw_json, player_name
         FROM fotmob_match_events
         WHERE type = 'Substitution' AND match_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{
      matchId: number;
      raw_json: string | null;
      player_name: string | null;
    }>;

    const lineupByMatch = new Map<number, FotmobSidePlayer[]>();
    for (const row of lineupRows) {
      const list = lineupByMatch.get(row.matchId) ?? [];
      list.push({
        playerId: row.playerId,
        name: row.name || "",
        teamName: row.teamName,
        isHome: Boolean(row.isHome),
        starter: Boolean(row.starter),
      });
      lineupByMatch.set(row.matchId, list);
    }
    const eventsByMatch = new Map<number, Array<{ raw_json: string | null; player_name: string | null }>>();
    for (const row of eventRows) {
      const list = eventsByMatch.get(row.matchId) ?? [];
      list.push(row);
      eventsByMatch.set(row.matchId, list);
    }

    for (const fixture of clubMatchesFixture) {
      const phase = effectiveLivePhase(fixture.phase, fixture.kickoff, fixture.statusShort);
      matches.push({
        id: fixture.id,
        round: fixture.round,
        kickoff: fixture.kickoff,
        home: { id: fixture.homeId, name: fixture.homeName },
        away: { id: fixture.awayId, name: fixture.awayName },
        scoreHome: fixture.scoreHome,
        scoreAway: fixture.scoreAway,
        statusShort: fixture.statusShort,
        phase,
        leagueSlug: league.slug,
        leagueName: league.name,
        leagueFlag: leagueFlagEmoji(league.slug),
        goals: [],
        cards: [],
        topBySide: { home: null, away: null },
        potm: null,
      });

      const published = lineupByMatch.get(fixture.id) ?? [];
      if (!published.length) continue;
      const cameOn = cameOnFromEvents(eventsByMatch.get(fixture.id) ?? []);
      const started = liveMyTeamMatchStarted(phase, fixture.statusShort);
      const matchLive = liveMyTeamMatchLive(phase, fixture.statusShort);
      const matchFinished = liveMyTeamMatchFinished(phase, fixture.statusShort);
      for (const squadPlayer of squad) {
        const involved =
          clubsMatch(squadPlayer.clubName, fixture.homeName) ||
          clubsMatch(squadPlayer.clubName, fixture.awayName);
        if (!involved) continue;
        const key = `${squadPlayer.id}:${fixture.id}`;
        if (seenPlayers.has(key)) continue;
        const row = findLineupRow(
          squadPlayer,
          sideRows(published, squadPlayer.clubName, fixture.homeName, fixture.awayName),
        );
        const starter = Boolean(row?.starter);
        const entered = row != null && playerCameOn(row, cameOn);
        const group = classifyLiveMyTeamPlayer({
          inLineup: row != null,
          starter,
          matchLive,
          cameOn: entered,
        });
        if (!group || !row) continue;
        seenPlayers.add(key);
        const appeared = started && (starter || entered);
        const chip = liveMyTeamChip({ group, matchStarted: started, matchFinished, appeared });
        const showScore = chip === "live" || chip === "played";
        const profileId = expected11ProfilePlayerId(squadPlayer.tmUrl);
        const sigmaTotal = lookupSigma(sigma, squadPlayer);
        columns[group].push({
          mantraPlayerId: squadPlayer.id,
          surname: squadPlayer.surname,
          clubName: squadPlayer.clubName,
          leagueSlug: league.slug,
          leagueName: league.name,
          leagueFlag: leagueFlagEmoji(league.slug),
          profileUrl: profileId ? `/player.html?id=${profileId}` : null,
          matchId: fixture.id,
          group,
          chip,
          score: showScore ? sigmaTotal : null,
          scoreText: showScore ? formatLiveMyTeamScore(sigmaTotal) : "—",
          scoreTitle: showScore && sigmaTotal != null ? "Σ" : "",
        });
      }
    }
  }

  const phaseOrder: Record<string, number> = { live: 0, upcoming: 1, finished: 2, cancelled: 3 };
  matches.sort(
    (a, b) =>
      (phaseOrder[a.phase] ?? 9) - (phaseOrder[b.phase] ?? 9) ||
      String(a.kickoff).localeCompare(String(b.kickoff)) ||
      a.id - b.id,
  );
  for (const key of COLUMN_ORDER) {
    columns[key].sort(
      (a, b) =>
        a.leagueName.localeCompare(b.leagueName) ||
        a.surname.localeCompare(b.surname) ||
        a.mantraPlayerId - b.mantraPlayerId,
    );
  }

  return {
    status: "ok",
    message: matches.length ? null : LIVE_MY_TEAMS_NO_MATCHES,
    matches,
    columns,
    pairs: loadedPairs.pairs,
    computed: loadedPairs.computed,
  };
}
