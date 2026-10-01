/**
 * Cross-league /tables view: one row per Mantra manager.
 * Averages are sum(stat) / sum(played matches) across that manager's clubs
 * (weighting by games). Missing Ideal is omitted, never treated as 0.
 */
import type Database from "better-sqlite3";
import { peekIdealTableOverlay, type IdealTableTeamStats } from "./mantraIdealTables.js";
import { loadSeasonIdealTotals } from "./mantraIdealVsReal.js";
import {
  mergeIdealTsSources,
  peekChampionshipStandings,
  realOverIdealPct,
  standingsLeagues,
  withIdealTableStats,
  withIdealTs,
  type StandingsRow,
  type StandingsView,
} from "./mantraStandings.js";
import { allTablesLeagues, leagueFlagEmoji } from "../lib/liveLeagues.js";

export const MANAGERS_SLUG = "managers";

export function isManagersSlug(slug: string | null | undefined): boolean {
  return String(slug || "").trim().toLowerCase() === MANAGERS_SLUG;
}

export type ManagerTeamRow = {
  managerId: string;
  teamId: number;
  teamName: string;
  teamLogo: string | null;
  leagueSlug: string;
  leagueName: string;
  flag: string;
  division: string;
  divisionRank: number;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  idealTs: number | null;
  idealPct: number | null;
  iGf: number | null;
  iGa: number | null;
  iGd: number | null;
  iPts: number | null;
  form: StandingsRow["form"];
  idealRank: number | null;
  idealGames: number | null;
  idealWins: number | null;
  idealDraws: number | null;
  idealLoses: number | null;
  idealAvgTs: number | null;
  idealForm: StandingsRow["form"];
};

export type ManagerStandingsRow = {
  rank: number;
  managerId: string;
  managerName: string;
  teamLogo: string | null;
  teamIds: number[];
  teams: ManagerTeamRow[];
  /** Fantasy clubs in cached championship tables. Headcount, not ×100. */
  clubs: number;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  idealTs: number | null;
  idealPct: number | null;
  iGf: number | null;
  iGa: number | null;
  iGd: number | null;
  iPts: number | null;
  ptsDiff: number | null;
};

export type ManagersStandingsView = {
  ok: boolean;
  empty: boolean;
  league: typeof MANAGERS_SLUG;
  name: string;
  cache: "hit" | "miss" | "stale";
  fetchedAt: string;
  divisions: number;
  teams: number;
  failedDivisions: StandingsView["failedDivisions"];
  rows: ManagerStandingsRow[];
  idealRounds: string[];
  leagues: StandingsView["leagues"];
  divisionOptions: [];
};

export type ManagerOwners = Map<number, number>;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Per-match average (full precision). Null when there are no matches. */
export function perMatchAvg(sum: number, games: number): number | null {
  if (!Number.isFinite(sum) || !Number.isFinite(games) || games <= 0) return null;
  return sum / games;
}

/** Display scale for per-match W/D/L/GF/GA/GD/PTS/i-star/DP. Not for G, clubs/К, TS, Ideal TS, or %. */
export const MANAGERS_PER100_KEYS = [
  "wins",
  "draws",
  "loses",
  "gf",
  "ga",
  "gd",
  "points",
  "iGf",
  "iGa",
  "iGd",
  "iPts",
  "ptsDiff",
] as const;

export type ManagersPer100Key = (typeof MANAGERS_PER100_KEYS)[number];

/** Per-match average ×100, hundredths. 1.5 wins/game → 150. */
export function perMatchTimes100(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return round2(Number(value) * 100);
}

export function managerKey(userId: number | null | undefined, teamId: number): string {
  if (userId != null && Number.isSafeInteger(userId) && userId > 0) return `u:${userId}`;
  return `t:${teamId}`;
}

function tableExists(database: Database.Database, name: string): boolean {
  const row = database
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

const MANAGER_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS mantra_managers (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS mantra_table_rows (
  league_slug TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  manager_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  team_logo TEXT,
  league_name TEXT NOT NULL,
  flag TEXT,
  division TEXT NOT NULL,
  division_rank INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins REAL NOT NULL DEFAULT 0,
  draws REAL NOT NULL DEFAULT 0,
  loses REAL NOT NULL DEFAULT 0,
  gf REAL NOT NULL DEFAULT 0,
  ga REAL NOT NULL DEFAULT 0,
  gd REAL NOT NULL DEFAULT 0,
  points REAL NOT NULL DEFAULT 0,
  ts REAL NOT NULL DEFAULT 0,
  ideal_ts REAL,
  ideal_pct REAL,
  i_gf REAL,
  i_ga REAL,
  i_gd REAL,
  i_pts REAL,
  form_json TEXT,
  ideal_rank INTEGER,
  ideal_games INTEGER,
  ideal_wins INTEGER,
  ideal_draws INTEGER,
  ideal_loses INTEGER,
  ideal_avg_ts REAL,
  ideal_form_json TEXT,
  fetched_at TEXT,
  PRIMARY KEY (league_slug, team_id)
);
CREATE INDEX IF NOT EXISTS idx_mantra_table_rows_manager
  ON mantra_table_rows(manager_id);
`;

export function ensureManagerTables(database: Database.Database): void {
  database.exec(MANAGER_TABLES_SQL);
}

function decodeBasicHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Nickname from signed-in `/managers/{id}` HTML (`<div class="manager-name">`). */
export function parseManagerNicknameHtml(html: string): string | null {
  const raw = String(html || "");
  if (raw.includes('id="new_user"') && raw.includes("user[password]")) return null;
  const match = raw.match(/<div class="manager-name">\s*([^<]+?)\s*<\/div>/i);
  const name = decodeBasicHtml((match?.[1] ?? "").trim());
  return name || null;
}

/** Played matches: W+D+L when present, else GAMES. */
export function playedMatches(row: {
  wins?: number | null;
  draws?: number | null;
  loses?: number | null;
  games?: number | null;
}): number {
  const wins = Number(row.wins) || 0;
  const draws = Number(row.draws) || 0;
  const loses = Number(row.loses) || 0;
  const wdl = wins + draws + loses;
  if (wdl > 0) return wdl;
  const games = Number(row.games) || 0;
  return games > 0 ? games : 0;
}

export function loadManagerNicknames(database?: Database.Database): Map<number, string> {
  const out = new Map<number, string>();
  if (!database || !tableExists(database, "mantra_managers")) return out;
  const rows = database
    .prepare(`SELECT id, nickname FROM mantra_managers WHERE nickname != ''`)
    .all() as Array<{ id: number; nickname: string }>;
  for (const row of rows) {
    const id = Number(row.id);
    const nickname = String(row.nickname || "").trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !nickname) continue;
    out.set(id, nickname);
  }
  return out;
}

export function upsertManagerNickname(
  database: Database.Database,
  id: number,
  nickname: string,
): void {
  const name = String(nickname || "").trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !name) return;
  ensureManagerTables(database);
  database
    .prepare(
      `INSERT INTO mantra_managers (id, nickname, synced_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nickname = excluded.nickname,
         synced_at = excluded.synced_at`,
    )
    .run(id, name, new Date().toISOString());
}

export function listManagerIdsMissingNicknames(database: Database.Database): number[] {
  if (!tableExists(database, "mantra_fantasy_teams")) return [];
  ensureManagerTables(database);
  const rows = database
    .prepare(
      `SELECT DISTINCT t.user_id AS id
       FROM mantra_fantasy_teams t
       LEFT JOIN mantra_managers m ON m.id = t.user_id
       WHERE t.user_id IS NOT NULL
         AND (m.nickname IS NULL OR m.nickname = '')
       ORDER BY t.user_id`,
    )
    .all() as Array<{ id: number }>;
  return rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

export async function syncManagerNicknames(options: {
  database: Database.Database;
  fetchNickname: (id: number) => Promise<string | null>;
  limit?: number;
  force?: boolean;
  ids?: number[];
}): Promise<number> {
  const { database, fetchNickname } = options;
  ensureManagerTables(database);
  if (!tableExists(database, "mantra_fantasy_teams")) return 0;
  const requested = (options.ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0);
  const ids = requested.length
    ? requested
    : options.force
    ? (
        database
          .prepare(
            `SELECT DISTINCT user_id AS id FROM mantra_fantasy_teams
             WHERE user_id IS NOT NULL ORDER BY user_id`,
          )
          .all() as Array<{ id: number }>
      )
        .map((row) => Number(row.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    : listManagerIdsMissingNicknames(database);
  const slice = options.limit != null ? ids.slice(0, options.limit) : ids;
  let n = 0;
  for (const id of slice) {
    try {
      const nickname = await fetchNickname(id);
      if (!nickname) continue;
      upsertManagerNickname(database, id, nickname);
      n += 1;
    } catch (err) {
      console.warn(
        `  mantra manager ${id} nickname failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return n;
}

/** teamId → Mantra user_id. Missing table or user_id → omit (singleton team key). */
export function loadTeamManagerIds(database?: Database.Database): ManagerOwners {
  const out: ManagerOwners = new Map();
  if (!database || !tableExists(database, "mantra_fantasy_teams")) return out;
  const rows = database
    .prepare(
      `SELECT id AS teamId, user_id AS userId
       FROM mantra_fantasy_teams
       WHERE user_id IS NOT NULL`,
    )
    .all() as Array<{ teamId: number; userId: number | null }>;
  for (const row of rows) {
    const teamId = Number(row.teamId);
    const userId = Number(row.userId);
    if (!Number.isSafeInteger(teamId) || teamId <= 0) continue;
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    out.set(teamId, userId);
  }
  return out;
}

function pickManagerName(teams: ManagerTeamRow[]): string {
  const byName = new Map<string, { games: number; count: number }>();
  for (const team of teams) {
    const name = String(team.teamName || "").trim();
    if (!name) continue;
    const prev = byName.get(name);
    if (prev) {
      prev.games += team.games;
      prev.count += 1;
    } else {
      byName.set(name, { games: team.games, count: 1 });
    }
  }
  const names = [...byName.entries()].sort((a, b) => {
    return (
      b[1].count - a[1].count ||
      b[1].games - a[1].games ||
      a[0].localeCompare(b[0], "en")
    );
  });
  return names[0]?.[0] || teams[0]?.teamName || "—";
}

function sumKey(teams: ManagerTeamRow[], key: keyof ManagerTeamRow): number {
  let n = 0;
  for (const team of teams) {
    const value = Number(team[key]);
    if (Number.isFinite(value)) n += value;
  }
  return n;
}

export function hasIdealTs(team: {
  idealTs?: number | null;
}): boolean {
  return team.idealTs != null && Number.isFinite(team.idealTs) && team.idealTs > 0;
}

/**
 * Match count the stored Ideal TS total covers.
 * Table-sourced totals match avgTs × idealGames; season-ideal is aligned to GAMES.
 */
export function idealWindowGames(team: {
  games: number;
  idealGames?: number | null;
  idealTs?: number | null;
  idealAvgTs?: number | null;
}): number {
  if (!hasIdealTs(team)) return 0;
  const games = Number(team.games) || 0;
  const ig = Number(team.idealGames);
  const avg = Number(team.idealAvgTs);
  const total = Number(team.idealTs);
  if (ig > 0 && Number.isFinite(avg) && avg > 0 && Number.isFinite(total)) {
    const asTable = Math.abs(total - avg * ig);
    const asSeason = Math.abs(total - avg * games);
    if (asTable < asSeason - 0.51) return ig;
  }
  return games > 0 ? games : 0;
}

/** Real TS on the same GWs as Ideal. Scales down when Ideal covers fewer matches. */
export function tsOnIdealWindow(team: ManagerTeamRow): number | null {
  if (!hasIdealTs(team)) return null;
  const window = idealWindowGames(team);
  if (window <= 0 || team.games <= 0) return null;
  if (window >= team.games) return team.ts;
  return team.ts * (window / team.games);
}

/**
 * Incomplete Ideal (partial tours, 0-TS games counted) makes Mantra TS > Ideal
 * on the same window. max(picked, Real XI) should not lose by 10–200%.
 */
export function hasReliableIdeal(team: ManagerTeamRow): boolean {
  if (!hasIdealTs(team)) return false;
  const real = tsOnIdealWindow(team);
  const ideal = Number(team.idealTs);
  if (real == null || !Number.isFinite(ideal) || ideal <= 0) return false;
  return real <= ideal + 0.05;
}

function idealAvg(
  teams: ManagerTeamRow[],
  key: "iGf" | "iGa" | "iGd" | "iPts",
): number | null {
  let sum = 0;
  let games = 0;
  for (const team of teams) {
    if (!hasReliableIdeal(team)) continue;
    const value = team[key];
    if (value == null || !Number.isFinite(value)) continue;
    const g = idealWindowGames(team);
    if (g <= 0) continue;
    sum += value;
    games += g;
  }
  return perMatchAvg(sum, games);
}

/**
 * Sum stats, then divide by total played matches (same as weighting each
 * club's per-match average by its games). Ideal columns use only clubs
 * that have Ideal; missing Ideal is — not 0.
 */
function managerDisplayName(
  managerId: string,
  teams: ManagerTeamRow[],
  nicknames?: Map<number, string>,
): string {
  const match = /^u:(\d+)$/.exec(managerId);
  if (match && nicknames) {
    const nickname = nicknames.get(Number(match[1]));
    if (nickname) return nickname;
  }
  return pickManagerName(teams);
}

export function aggregateManagerRow(
  teams: ManagerTeamRow[],
  nicknames?: Map<number, string>,
): Omit<ManagerStandingsRow, "rank"> | null {
  if (!teams.length) return null;
  const games = sumKey(teams, "games");
  const wins = perMatchAvg(sumKey(teams, "wins"), games);
  const draws = perMatchAvg(sumKey(teams, "draws"), games);
  const loses = perMatchAvg(sumKey(teams, "loses"), games);
  const gf = perMatchAvg(sumKey(teams, "gf"), games);
  const ga = perMatchAvg(sumKey(teams, "ga"), games);
  const gd = perMatchAvg(sumKey(teams, "gd"), games);
  const points = perMatchAvg(sumKey(teams, "points"), games);
  const ts = perMatchAvg(sumKey(teams, "ts"), games);
  const iGf = idealAvg(teams, "iGf");
  const iGa = idealAvg(teams, "iGa");
  const iGd = idealAvg(teams, "iGd");
  const iPts = idealAvg(teams, "iPts");
  const paired = teams.filter(hasReliableIdeal);
  let idealTsSum = 0;
  let idealTsGames = 0;
  let tsWithIdeal = 0;
  for (const team of paired) {
    const window = idealWindowGames(team);
    const real = tsOnIdealWindow(team);
    if (window <= 0 || real == null) continue;
    idealTsSum += team.idealTs ?? 0;
    idealTsGames += window;
    tsWithIdeal += real;
  }
  const idealTs = perMatchAvg(idealTsSum, idealTsGames);
  const sortedTeams = teams.slice().sort((a, b) => {
    return (
      a.leagueName.localeCompare(b.leagueName, "en") ||
      a.division.localeCompare(b.division, "en") ||
      a.teamName.localeCompare(b.teamName, "en")
    );
  });
  return {
    managerId: teams[0]!.managerId,
    managerName: managerDisplayName(teams[0]!.managerId, teams, nicknames),
    teamLogo: teams.find((team) => team.teamLogo)?.teamLogo ?? teams[0]!.teamLogo,
    teamIds: teams.map((team) => team.teamId),
    teams: sortedTeams,
    clubs: teams.length,
    games,
    wins: wins ?? 0,
    draws: draws ?? 0,
    loses: loses ?? 0,
    gf: gf ?? 0,
    ga: ga ?? 0,
    gd: gd ?? 0,
    points: points ?? 0,
    ts: ts != null ? round2(ts) : 0,
    idealTs: idealTs != null ? round2(idealTs) : null,
    idealPct: realOverIdealPct(tsWithIdeal, idealTsSum),
    iGf,
    iGa,
    iGd,
    iPts,
    ptsDiff: points != null && iPts != null ? points - iPts : null,
  };
}

export function groupTeamsByManager(
  teams: ManagerTeamRow[],
  nicknames?: Map<number, string>,
): ManagerStandingsRow[] {
  const groups = new Map<string, ManagerTeamRow[]>();
  for (const team of teams) {
    const list = groups.get(team.managerId);
    if (list) list.push(team);
    else groups.set(team.managerId, [team]);
  }
  const rows = [...groups.values()]
    .map((group) => aggregateManagerRow(group, nicknames))
    .filter((row): row is Omit<ManagerStandingsRow, "rank"> => row != null)
    .sort((a, b) => {
      return (
        b.points - a.points ||
        b.ts - a.ts ||
        a.managerName.localeCompare(b.managerName, "en")
      );
    });
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function tagTeam(
  row: StandingsRow,
  leagueSlug: string,
  leagueName: string,
  owners: ManagerOwners,
  ideal?: IdealTableTeamStats,
): ManagerTeamRow {
  const userId = owners.get(row.teamId) ?? null;
  const hasIdeal = hasIdealTs(row);
  return {
    managerId: managerKey(userId, row.teamId),
    teamId: row.teamId,
    teamName: row.teamName,
    teamLogo: row.teamLogo,
    leagueSlug,
    leagueName,
    flag: leagueFlagEmoji(leagueSlug),
    division: row.division,
    divisionRank: row.divisionRank,
    games: playedMatches(row),
    wins: row.wins,
    draws: row.draws,
    loses: row.loses,
    gf: row.gf,
    ga: row.ga,
    gd: row.gd,
    points: row.points,
    ts: row.ts,
    idealTs: hasIdeal ? row.idealTs : null,
    idealPct: hasIdeal ? row.idealPct : null,
    iGf: hasIdeal ? row.iGf : null,
    iGa: hasIdeal ? row.iGa : null,
    iGd: hasIdeal ? row.iGd : null,
    iPts: hasIdeal ? row.iPts : null,
    form: row.form,
    idealRank: ideal?.rank ?? null,
    idealGames: ideal?.games ?? null,
    idealWins: ideal?.wins ?? null,
    idealDraws: ideal?.draws ?? null,
    idealLoses: ideal?.loses ?? null,
    idealAvgTs: ideal?.avgTs ?? null,
    idealForm: ideal?.form ?? [],
  };
}

function overlayStandings(view: StandingsView, database?: Database.Database): StandingsView {
  const playedGames = view.rows.reduce((max, row) => Math.max(max, row.games || 0), 0);
  const table = peekIdealTableOverlay(view.league, database);
  return withIdealTableStats(
    withIdealTs(
      view,
      mergeIdealTsSources(
        loadSeasonIdealTotals(view.league, {
          database,
          maxRounds: playedGames > 0 ? playedGames : undefined,
        }),
        table,
      ),
    ),
    table.stats,
  );
}

function parseFormJson(raw: string | null | undefined): StandingsRow["form"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StandingsRow["form"][number] => item === "W" || item === "D" || item === "L");
  } catch {
    return [];
  }
}

function persistLeagueTableRows(
  database: Database.Database,
  slug: string,
  fetchedAt: string,
  teams: ManagerTeamRow[],
): void {
  ensureManagerTables(database);
  const del = database.prepare(`DELETE FROM mantra_table_rows WHERE league_slug = ?`);
  const ins = database.prepare(
    `INSERT INTO mantra_table_rows (
       league_slug, team_id, manager_id, team_name, team_logo, league_name, flag,
       division, division_rank, games, wins, draws, loses, gf, ga, gd, points, ts,
       ideal_ts, ideal_pct, i_gf, i_ga, i_gd, i_pts, form_json, ideal_rank, ideal_games,
       ideal_wins, ideal_draws, ideal_loses, ideal_avg_ts, ideal_form_json, fetched_at
     ) VALUES (
       @league_slug, @team_id, @manager_id, @team_name, @team_logo, @league_name, @flag,
       @division, @division_rank, @games, @wins, @draws, @loses, @gf, @ga, @gd, @points, @ts,
       @ideal_ts, @ideal_pct, @i_gf, @i_ga, @i_gd, @i_pts, @form_json, @ideal_rank, @ideal_games,
       @ideal_wins, @ideal_draws, @ideal_loses, @ideal_avg_ts, @ideal_form_json, @fetched_at
     )`,
  );
  const tx = database.transaction(() => {
    del.run(slug);
    for (const team of teams) {
      ins.run({
        league_slug: slug,
        team_id: team.teamId,
        manager_id: team.managerId,
        team_name: team.teamName,
        team_logo: team.teamLogo,
        league_name: team.leagueName,
        flag: team.flag,
        division: team.division,
        division_rank: team.divisionRank,
        games: team.games,
        wins: team.wins,
        draws: team.draws,
        loses: team.loses,
        gf: team.gf,
        ga: team.ga,
        gd: team.gd,
        points: team.points,
        ts: team.ts,
        ideal_ts: team.idealTs,
        ideal_pct: team.idealPct,
        i_gf: team.iGf,
        i_ga: team.iGa,
        i_gd: team.iGd,
        i_pts: team.iPts,
        form_json: JSON.stringify(team.form ?? []),
        ideal_rank: team.idealRank,
        ideal_games: team.idealGames,
        ideal_wins: team.idealWins,
        ideal_draws: team.idealDraws,
        ideal_loses: team.idealLoses,
        ideal_avg_ts: team.idealAvgTs,
        ideal_form_json: JSON.stringify(team.idealForm ?? []),
        fetched_at: fetchedAt,
      });
    }
  });
  tx();
}

type FlattenedTeamRow = {
  league_slug: string;
  team_id: number;
  manager_id: string;
  team_name: string;
  team_logo: string | null;
  league_name: string;
  flag: string | null;
  division: string;
  division_rank: number;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  ideal_ts: number | null;
  ideal_pct: number | null;
  i_gf: number | null;
  i_ga: number | null;
  i_gd: number | null;
  i_pts: number | null;
  form_json: string | null;
  ideal_rank: number | null;
  ideal_games: number | null;
  ideal_wins: number | null;
  ideal_draws: number | null;
  ideal_loses: number | null;
  ideal_avg_ts: number | null;
  ideal_form_json: string | null;
};

function teamFromPersisted(row: FlattenedTeamRow): ManagerTeamRow {
  return {
    managerId: String(row.manager_id),
    teamId: Number(row.team_id),
    teamName: String(row.team_name || ""),
    teamLogo: row.team_logo,
    leagueSlug: String(row.league_slug),
    leagueName: String(row.league_name || ""),
    flag: String(row.flag || ""),
    division: String(row.division || ""),
    divisionRank: Number(row.division_rank) || 0,
    games: Number(row.games) || 0,
    wins: Number(row.wins) || 0,
    draws: Number(row.draws) || 0,
    loses: Number(row.loses) || 0,
    gf: Number(row.gf) || 0,
    ga: Number(row.ga) || 0,
    gd: Number(row.gd) || 0,
    points: Number(row.points) || 0,
    ts: Number(row.ts) || 0,
    idealTs: row.ideal_ts,
    idealPct: row.ideal_pct,
    iGf: row.i_gf,
    iGa: row.i_ga,
    iGd: row.i_gd,
    iPts: row.i_pts,
    form: parseFormJson(row.form_json),
    idealRank: row.ideal_rank,
    idealGames: row.ideal_games,
    idealWins: row.ideal_wins,
    idealDraws: row.ideal_draws,
    idealLoses: row.ideal_loses,
    idealAvgTs: row.ideal_avg_ts,
    idealForm: parseFormJson(row.ideal_form_json),
  };
}

function loadPersistedTeams(database: Database.Database): ManagerTeamRow[] {
  if (!tableExists(database, "mantra_table_rows")) return [];
  const slugs = allTablesLeagues().map((league) => league.slug);
  if (!slugs.length) return [];
  const placeholders = slugs.map(() => "?").join(",");
  const rows = database
    .prepare(`SELECT * FROM mantra_table_rows WHERE league_slug IN (${placeholders})`)
    .all(...slugs) as FlattenedTeamRow[];
  return rows.map(teamFromPersisted);
}

function emptyManagersView(cache: ManagersStandingsView["cache"]): ManagersStandingsView {
  return {
    ok: true,
    empty: true,
    league: MANAGERS_SLUG,
    name: "Менеджеры",
    cache,
    fetchedAt: "",
    divisions: 0,
    teams: 0,
    failedDivisions: [],
    rows: [],
    idealRounds: [],
    leagues: standingsLeagues(),
    divisionOptions: [],
  };
}

/** Cached combined tables only. Never waits on Mantra. */
export function getManagersStandings(options?: {
  database?: Database.Database;
  owners?: ManagerOwners;
}): ManagersStandingsView {
  const database = options?.database;
  const owners = options?.owners ?? loadTeamManagerIds(database);
  const nicknames = loadManagerNicknames(database);
  if (database) ensureManagerTables(database);
  let teams: ManagerTeamRow[] = [];
  const failedDivisions: StandingsView["failedDivisions"] = [];
  const idealRounds = new Set<string>();
  let fetchedAt = "";
  let cache: ManagersStandingsView["cache"] = "miss";
  let anyHit = false;
  let anyStale = false;

  for (const league of allTablesLeagues()) {
    const peeked = peekChampionshipStandings(league.slug, database);
    if (!peeked) continue;
    if (peeked.cache === "hit") anyHit = true;
    else if (peeked.cache === "stale") anyStale = true;
    if (peeked.fetchedAt && peeked.fetchedAt > fetchedAt) fetchedAt = peeked.fetchedAt;
    const view = overlayStandings(peeked, database);
    const table = peekIdealTableOverlay(league.slug, database);
    for (const round of view.idealRounds || []) {
      if (round) idealRounds.add(String(round));
    }
    for (const row of view.failedDivisions || []) failedDivisions.push(row);
    const tagged = (view.rows || []).map((row) =>
      tagTeam(row, league.slug, league.name, owners, table.stats.get(row.teamId)),
    );
    if (database) persistLeagueTableRows(database, league.slug, peeked.fetchedAt, tagged);
    if (!database) teams.push(...tagged);
  }

  if (database) teams = loadPersistedTeams(database);

  if (!teams.length) return emptyManagersView(cache);
  if (anyStale) cache = "stale";
  else if (anyHit) cache = "hit";

  const rows = groupTeamsByManager(teams, nicknames);
  return {
    ok: true,
    empty: rows.length === 0,
    league: MANAGERS_SLUG,
    name: "Менеджеры",
    cache,
    fetchedAt,
    divisions: 0,
    teams: rows.length,
    failedDivisions,
    rows,
    idealRounds: [...idealRounds].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
    leagues: standingsLeagues(),
    divisionOptions: [],
  };
}
