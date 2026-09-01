import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { parseDetailRole, roleGroup, type Role } from "../lib/roles.js";

export type PerfSeasonAgg = {
  season: number;
  minutes: number;
  goals: number;
  assists: number;
  yellow: number;
  red: number;
  conceded: number;
  cleanSheets: number;
  lineups: number;
  afRating: number | null;
};

export type RatingInput = {
  playerId: number;
  marketValueEur: number | null;
  detailRole: string | null;
  detailLabel: string | null;
  afPosition: string | null;
  /** Multi-season AF (+ optional TM gap) performance. */
  seasons: PerfSeasonAgg[];
};

/** Season blend weights for historySeason, -1, -2. */
export const PERF_SEASON_WEIGHTS = [
  { offset: 0, weight: 0.5 },
  { offset: 1, weight: 0.3 },
  { offset: 2, weight: 0.2 },
] as const;

/** Fantasy-style raw points for a single season sample. */
export function fantasySeasonPoints(
  group: "GK" | "DEF" | "MID" | "ATT",
  s: PerfSeasonAgg,
): number {
  const g = s.goals;
  const a = s.assists;
  const y = s.yellow;
  const r = s.red;
  const cs = s.cleanSheets;
  const conceded = s.conceded;
  if (group === "ATT") return g * 4 + a * 3 - y * 1 - r * 3;
  if (group === "MID") return g * 3 + a * 3 + cs * 1 - y * 1 - r * 3;
  if (group === "DEF") return g * 6 + a * 3 + cs * 4 - conceded * 0.25 - y * 1 - r * 3;
  // GK
  return a * 2 + cs * 4 - conceded * 0.5 - y * 1 - r * 3;
}

/**
 * Honest blended raw score before role-percentile.
 * No club form. No inflated MV for zero-minute players.
 */
export function fantasyRawScore(
  group: "GK" | "DEF" | "MID" | "ATT",
  seasons: PerfSeasonAgg[],
  historySeason = config.season,
): { raw: number; minutes: number; hasPerf: boolean } {
  let weighted = 0;
  let wSum = 0;
  let minutes = 0;
  for (const { offset, weight } of PERF_SEASON_WEIGHTS) {
    const season = historySeason - offset;
    const rows = seasons.filter((s) => s.season === season);
    if (!rows.length) continue;
    const agg = mergeSeasonRows(rows);
    minutes += agg.minutes * weight;
    if (agg.minutes <= 0 && agg.goals + agg.assists + agg.lineups <= 0) continue;
    const pts = fantasySeasonPoints(group, agg);
    const nineties = Math.max(agg.minutes / 90, 0.5);
    const pts90 = pts / nineties;
    const timeFactor = Math.min(agg.minutes / 1800, 1);
    weighted += pts90 * timeFactor * weight;
    wSum += weight;
  }
  if (wSum <= 0) return { raw: 0, minutes: 0, hasPerf: false };
  return { raw: weighted / wSum, minutes, hasPerf: true };
}

function mergeSeasonRows(rows: PerfSeasonAgg[]): PerfSeasonAgg {
  const out: PerfSeasonAgg = {
    season: rows[0]!.season,
    minutes: 0,
    goals: 0,
    assists: 0,
    yellow: 0,
    red: 0,
    conceded: 0,
    cleanSheets: 0,
    lineups: 0,
    afRating: null,
  };
  let ratingSum = 0;
  let ratingN = 0;
  for (const r of rows) {
    out.minutes += r.minutes;
    out.goals += r.goals;
    out.assists += r.assists;
    out.yellow += r.yellow;
    out.red += r.red;
    out.conceded += r.conceded;
    out.cleanSheets += r.cleanSheets;
    out.lineups += r.lineups;
    if (r.afRating != null) {
      ratingSum += r.afRating;
      ratingN++;
    }
  }
  out.afRating = ratingN ? ratingSum / ratingN : null;
  return out;
}

/** Rank → 0..100 percentile within peer group (average rank for ties). */
export function percentileScores(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [50];
  const order = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v);
  const out = new Array<number>(n).fill(50);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1]!.v === order[i]!.v) j++;
    const avgRank = (i + j) / 2;
    const pct = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[order[k]!.i] = Number(pct.toFixed(2));
    i = j + 1;
  }
  return out;
}

function resolveGroup(r: RatingInput): "GK" | "DEF" | "MID" | "ATT" {
  const role =
    parseDetailRole(r.detailRole, r.detailLabel, null) ??
    parseDetailRole(r.afPosition, r.afPosition, r.afPosition) ??
    "CM";
  return roleGroup(role);
}

/**
 * Board / AVG XI rating: fantasy perf → percentile within role group in the league.
 * Players with no minutes: soft MV prior capped (~35), never tops the board.
 */
export function scorePlayersBoardStyle(rows: RatingInput[]): Map<number, number> {
  const groups = rows.map(resolveGroup);
  const raws = rows.map((r, i) => fantasyRawScore(groups[i]!, r.seasons));
  const byGroup: Record<string, number[]> = { GK: [], DEF: [], MID: [], ATT: [] };
  const idxInGroup: number[] = new Array(rows.length).fill(-1);

  for (let i = 0; i < rows.length; i++) {
    if (!raws[i]!.hasPerf) continue;
    const g = groups[i]!;
    idxInGroup[i] = byGroup[g]!.length;
    byGroup[g]!.push(raws[i]!.raw);
  }

  const pctByGroup: Record<string, number[]> = {
    GK: percentileScores(byGroup.GK!),
    DEF: percentileScores(byGroup.DEF!),
    MID: percentileScores(byGroup.MID!),
    ATT: percentileScores(byGroup.ATT!),
  };

  // MV soft prior among no-perf players only
  const noPerfIdx = rows.map((r, i) => (!raws[i]!.hasPerf ? i : -1)).filter((i) => i >= 0);
  const mvVals = noPerfIdx.map((i) => Math.log10((rows[i]!.marketValueEur || 1) + 1));
  const mvPct = percentileScores(mvVals);

  const out = new Map<number, number>();
  let mvCursor = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i]!.playerId;
    if (raws[i]!.hasPerf) {
      const g = groups[i]!;
      const gi = idxInGroup[i]!;
      out.set(id, pctByGroup[g]![gi] ?? 50);
    } else {
      const prior = mvPct[mvCursor++] ?? 50;
      // Cap so zero-minute MV never looks like a star
      out.set(id, Number((prior * 0.35).toFixed(2)));
    }
  }
  return out;
}

type StatsRow = {
  playerId: number;
  season: number;
  minutes: number;
  goals: number;
  assists: number;
  yellow: number;
  red: number;
  conceded: number;
  cleanSheets: number;
  lineups: number;
  afRating: number | null;
};

function loadPerfForPlayers(
  playerIds: number[],
  historySeason = config.season,
): Map<number, PerfSeasonAgg[]> {
  const map = new Map<number, PerfSeasonAgg[]>();
  if (!playerIds.length) return map;
  const seasons = PERF_SEASON_WEIGHTS.map((w) => historySeason - w.offset);
  const placeholders = playerIds.map(() => "?").join(",");
  const seasonPlaceholders = seasons.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT player_id AS playerId, season,
              COALESCE(minutes, 0) AS minutes,
              COALESCE(goals, 0) AS goals,
              COALESCE(assists, 0) AS assists,
              COALESCE(yellow_cards, 0) AS yellow,
              COALESCE(red_cards, 0) AS red,
              COALESCE(goals_conceded, 0) AS conceded,
              COALESCE(clean_sheets, 0) AS cleanSheets,
              COALESCE(lineups, 0) AS lineups,
              rating AS afRating
       FROM player_stats
       WHERE player_id IN (${placeholders})
         AND season IN (${seasonPlaceholders})`,
    )
    .all(...playerIds, ...seasons) as StatsRow[];

  // Optional TM gap-fill: add goals/cards/apps when AF season empty
  const tmRows = getDb()
    .prepare(
      `SELECT af_player_id AS playerId, season,
              COALESCE(appearances, 0) AS lineups,
              COALESCE(goals, 0) AS goals,
              COALESCE(assists, 0) AS assists,
              COALESCE(yellow_cards, 0) AS yellow,
              COALESCE(red_cards, 0) AS red,
              COALESCE(clean_sheets, 0) AS cleanSheets
       FROM player_tm_perf
       WHERE af_player_id IN (${placeholders})
         AND season IN (${seasonPlaceholders})`,
    )
    .all(...playerIds, ...seasons) as Array<{
    playerId: number;
    season: number;
    lineups: number;
    goals: number;
    assists: number;
    yellow: number;
    red: number;
    cleanSheets: number;
  }>;

  for (const r of rows) {
    const list = map.get(r.playerId) ?? [];
    list.push({
      season: r.season,
      minutes: r.minutes,
      goals: r.goals,
      assists: r.assists,
      yellow: r.yellow,
      red: r.red,
      conceded: r.conceded,
      cleanSheets: r.cleanSheets,
      lineups: r.lineups,
      afRating: r.afRating,
    });
    map.set(r.playerId, list);
  }

  for (const t of tmRows) {
    if (t.playerId == null) continue;
    const list = map.get(t.playerId) ?? [];
    const existing = list.find((s) => s.season === t.season);
    if (existing && existing.minutes > 0) continue; // AF wins when present
    if (existing) {
      existing.goals = Math.max(existing.goals, t.goals);
      existing.assists = Math.max(existing.assists, t.assists);
      existing.yellow = Math.max(existing.yellow, t.yellow);
      existing.red = Math.max(existing.red, t.red);
      existing.cleanSheets = Math.max(existing.cleanSheets, t.cleanSheets);
      existing.lineups = Math.max(existing.lineups, t.lineups);
    } else {
      list.push({
        season: t.season,
        minutes: 0,
        goals: t.goals,
        assists: t.assists,
        yellow: t.yellow,
        red: t.red,
        conceded: 0,
        cleanSheets: t.cleanSheets,
        lineups: t.lineups,
        afRating: null,
      });
      map.set(t.playerId, list);
    }
  }

  return map;
}

/** League-scoped ratings for current predict squad. */
export function leaguePlayerRatings(
  season = config.predictSeason,
  leagueId = 106,
): Map<number, number> {
  const historySeason = config.season;
  const squad = getDb()
    .prepare(
      `SELECT
         sp.player_id AS playerId,
         sp.position AS afPosition,
         pv.detail_role AS detailRole,
         pv.detail_label AS detailLabel,
         pv.market_value_eur AS marketValueEur
       FROM squad_players sp
       JOIN season_teams st ON st.season = sp.season AND st.team_id = sp.team_id
       LEFT JOIN player_values pv ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
       WHERE sp.season = ?
         AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))`,
    )
    .all(season, leagueId, leagueId) as Array<{
    playerId: number;
    afPosition: string | null;
    detailRole: string | null;
    detailLabel: string | null;
    marketValueEur: number | null;
  }>;

  const perf = loadPerfForPlayers(
    squad.map((s) => s.playerId),
    historySeason,
  );
  const inputs: RatingInput[] = squad.map((s) => ({
    playerId: s.playerId,
    marketValueEur: s.marketValueEur,
    detailRole: s.detailRole,
    detailLabel: s.detailLabel,
    afPosition: s.afPosition,
    seasons: perf.get(s.playerId) ?? [],
  }));
  return scorePlayersBoardStyle(inputs);
}
