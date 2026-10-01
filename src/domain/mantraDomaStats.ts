/**
 * League One FotMob season stats for Mantra Дома list mode.
 * Sqlite only — no Mantra HTTP, no FotMob live fetch.
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { getComputed } from "../lib/computedCache.js";
import { tourHasFirstKickoff } from "../lib/liveLeagues.js";
import { seasonStartIso } from "./expected11Premium.js";
import { LEAGUE_ONE_FOTMOB_ID } from "./leagueOne.js";
import {
  loadFotmobSeasonBundle,
  mean,
  parseFotmobTour,
  tableExists,
  type FotmobSeasonBundle,
} from "./premiumSeasonStats.js";

export const MANTRA_DOMA_STATS_CACHE_KEY = "mantra-doma:stats";
export const MANTRA_DOMA_STATS_TTL_MS = 60 * 60 * 1000;

export type MantraDomaRoundCell = {
  round: number;
  minutes: number | null;
  rating: number | null;
  pos: string | null;
  g: number;
  a: number;
  y: number;
  red: number;
};

export type MantraDomaPlayerStats = {
  min: number;
  bars: number[];
  rnd: Array<number | null>;
  rounds: MantraDomaRoundCell[];
  pos: string | null;
  rating: number | null;
  last5: number | null;
  g: number;
  a: number;
  y: number;
  red: number;
  og: number;
  sv: number;
  gc: number;
  apps: number;
  st: number;
  psc: number;
  pmi: number;
  psv: number;
};

export type MantraDomaStatsView = {
  ok: boolean;
  source: "fotmob";
  leagueId: number;
  seasonStart: string;
  tours: number[];
  players: Record<string, MantraDomaPlayerStats>;
  cachedAt: string | null;
};

/** FotMob lineup `position_id` is a pitch-grid slot (not a role string). */
const FOTMOB_POS_ID: Record<number, string> = {
  11: "GK",
  32: "RB",
  33: "CB",
  34: "CB",
  35: "CB",
  36: "CB",
  37: "CB",
  38: "LB",
  51: "WB",
  59: "WB",
  62: "CM",
  63: "CM",
  64: "CM",
  65: "DM",
  66: "CM",
  67: "CM",
  68: "CM",
  71: "W",
  72: "W",
  73: "W",
  74: "AM",
  75: "AM",
  76: "AM",
  77: "AM",
  78: "W",
  79: "W",
  82: "W",
  83: "W",
  84: "AM",
  85: "AM",
  86: "AM",
  87: "W",
  88: "W",
  103: "ST",
  104: "ST",
  105: "ST",
  106: "ST",
  107: "ST",
  115: "ST",
};

export function fotmobPositionShort(positionId: number | null | undefined): string | null {
  if (positionId == null || !Number.isFinite(positionId)) return null;
  const id = Number(positionId);
  if (FOTMOB_POS_ID[id]) return FOTMOB_POS_ID[id];
  if (id < 1 || id > 120) return null;
  if (id <= 15) return "GK";
  if (id <= 45) return "CB";
  if (id <= 70) return "CM";
  if (id <= 95) return "AM";
  return "ST";
}

function mostFrequentPos(
  played: Array<{ pos: string | null; round: number | null }>,
): string | null {
  const counts = new Map<string, { n: number; lastRound: number }>();
  for (const item of played) {
    if (!item.pos) continue;
    const prev = counts.get(item.pos) ?? { n: 0, lastRound: -1 };
    prev.n += 1;
    prev.lastRound = Math.max(prev.lastRound, item.round ?? -1);
    counts.set(item.pos, prev);
  }
  let best: string | null = null;
  let bestN = 0;
  let bestRound = -1;
  for (const [pos, { n, lastRound }] of counts) {
    if (n > bestN || (n === bestN && lastRound > bestRound)) {
      best = pos;
      bestN = n;
      bestRound = lastRound;
    }
  }
  return best;
}

function clubPlayedMatch(
  match: { home_id: number | null; away_id: number | null },
  teamId: number,
): boolean {
  return match.home_id === teamId || match.away_id === teamId;
}

function loadSeasonPlayerIds(
  database: Database.Database,
  leagueId: number,
  seasonStart: string,
): number[] {
  if (!tableExists(database, "fotmob_matches") || !tableExists(database, "fotmob_match_players")) {
    return [];
  }
  const rows = database
    .prepare(
      `SELECT DISTINCT p.player_id AS id
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ? AND m.phase = 'finished'
         AND (m.kickoff IS NULL OR m.kickoff >= ?)`,
    )
    .all(leagueId, seasonStart) as Array<{ id: number }>;
  return rows
    .map((row) => row.id)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * League One columns: every round that has kicked off this season, not only
 * `phase='finished'`. Prod often leaves later fixtures as stale `upcoming`
 * (no details, no player sheets) after the kickoff has already passed.
 */
export function listPlayedFotmobTours(
  database: Database.Database,
  leagueId: number,
  seasonStart: string,
  now: Date,
): number[] {
  if (!tableExists(database, "fotmob_matches")) return [];
  const rows = database
    .prepare(
      `SELECT round, phase, kickoff FROM fotmob_matches
       WHERE league_id = ? AND round IS NOT NULL AND round != ''
         AND (kickoff IS NULL OR kickoff >= ?)`,
    )
    .all(leagueId, seasonStart) as Array<{
    round: string;
    phase: string | null;
    kickoff: string | null;
  }>;
  const byTour = new Map<number, typeof rows>();
  for (const row of rows) {
    const tour = parseFotmobTour(row.round);
    if (tour == null) continue;
    const list = byTour.get(tour) ?? [];
    list.push(row);
    byTour.set(tour, list);
  }
  const nowMs = now.getTime();
  return [...byTour.entries()]
    .filter(([, matches]) => tourHasFirstKickoff(matches, nowMs))
    .map(([tour]) => tour)
    .sort((a, b) => a - b);
}

export function mantraDomaStatsFingerprint(
  database: Database.Database,
  leagueId = LEAGUE_ONE_FOTMOB_ID,
  seasonStart?: string,
  now?: Date,
): string {
  if (!tableExists(database, "fotmob_matches")) return "empty";
  const start = seasonStart ?? seasonStartIso(now ?? new Date());
  const matches = database
    .prepare(
      `SELECT COUNT(*) AS n FROM fotmob_matches
       WHERE league_id = ? AND phase = 'finished'
         AND (kickoff IS NULL OR kickoff >= ?)`,
    )
    .get(leagueId, start) as { n: number };
  const tours = listPlayedFotmobTours(database, leagueId, start, now ?? new Date());
  if (!tableExists(database, "fotmob_match_players")) {
    return `${matches.n}:0:${tours.join(",")}`;
  }
  const rows = database
    .prepare(
      `SELECT COUNT(*) AS n
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ? AND m.phase = 'finished'
         AND (m.kickoff IS NULL OR m.kickoff >= ?)`,
    )
    .get(leagueId, start) as { n: number };
  return `${matches.n}:${rows.n}:${tours.join(",")}`;
}

function emptyRound(round: number): MantraDomaRoundCell {
  return {
    round,
    minutes: null,
    rating: null,
    pos: null,
    g: 0,
    a: 0,
    y: 0,
    red: 0,
  };
}

function statsForPlayer(
  fotmobId: number,
  bundle: FotmobSeasonBundle,
): MantraDomaPlayerStats | null {
  const teamId = bundle.teamIdByPlayer.get(fotmobId);
  if (teamId == null) return null;

  const clubMatches = bundle.matches
    .filter((match) => clubPlayedMatch(match, teamId))
    .sort((a, b) => {
      const ta = parseFotmobTour(a.round) ?? 0;
      const tb = parseFotmobTour(b.round) ?? 0;
      return ta - tb || (a.kickoff || "").localeCompare(b.kickoff || "") || a.id - b.id;
    });

  const bars: number[] = [];
  const rnd: Array<number | null> = [];
  const rounds: MantraDomaRoundCell[] = [];
  const ratings: number[] = [];
  const playedPos: Array<{ pos: string | null; round: number | null }> = [];
  let min = 0;
  let g = 0;
  let a = 0;
  let y = 0;
  let red = 0;
  let og = 0;
  let sv = 0;
  let gc = 0;
  let apps = 0;
  let st = 0;
  let psc = 0;
  let pmi = 0;
  let psv = 0;

  for (const match of clubMatches) {
    const row = bundle.statsByPlayerMatch.get(`${fotmobId}:${match.id}`);
    const hasSheet = bundle.matchesWithStats.has(match.id);
    const tour = parseFotmobTour(match.round);
    if (!row) {
      if (tour != null) rounds.push(emptyRound(tour));
      if (hasSheet) {
        bars.push(0);
        rnd.push(tour);
      }
      continue;
    }
    const playedMinutes = row.minutes ?? 0;
    const played = playedMinutes > 0;
    bars.push(playedMinutes);
    rnd.push(tour);
    const pos = played ? fotmobPositionShort(row.position_id) : null;
    if (tour != null) {
      rounds.push({
        round: tour,
        minutes: played ? playedMinutes : null,
        rating: played && row.rating != null && Number.isFinite(row.rating) ? Number(row.rating) : null,
        pos,
        g: row.goals ?? 0,
        a: row.assists ?? 0,
        y: row.yellow_cards ?? 0,
        red: row.red_cards ?? 0,
      });
    }
    if (played) {
      min += playedMinutes;
      apps += 1;
      if (row.starter) st += 1;
      playedPos.push({ pos, round: tour });
    }
    g += row.goals ?? 0;
    a += row.assists ?? 0;
    y += row.yellow_cards ?? 0;
    red += row.red_cards ?? 0;
    og += row.own_goals ?? 0;
    sv += row.saves ?? 0;
    gc += row.goals_conceded ?? 0;
    psc += row.penalties_scored ?? 0;
    pmi += row.penalties_missed ?? 0;
    psv += row.penalties_saved ?? 0;
    if (played && row.rating != null && Number.isFinite(row.rating)) {
      ratings.push(Number(row.rating));
    }
  }

  if (!bars.length && !rounds.length) return null;

  return {
    min,
    bars,
    rnd,
    rounds,
    pos: mostFrequentPos(playedPos),
    rating: mean(ratings),
    last5: mean(ratings.slice(-5)),
    g,
    a,
    y,
    red,
    og,
    sv,
    gc,
    apps,
    st,
    psc,
    pmi,
    psv,
  };
}

function buildMantraDomaFotmobStats(
  database: Database.Database,
  now: Date,
  fotmobIds?: number[],
): { players: Record<string, MantraDomaPlayerStats>; tours: number[] } {
  const leagueId = LEAGUE_ONE_FOTMOB_ID;
  const ids = fotmobIds?.length
    ? [...new Set(fotmobIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
    : loadSeasonPlayerIds(database, leagueId, seasonStartIso(now));
  const bundle = loadFotmobSeasonBundle(database, leagueId, ids, now);
  const out: Record<string, MantraDomaPlayerStats> = {};
  for (const id of ids) {
    const stats = statsForPlayer(id, bundle);
    if (stats) out[String(id)] = stats;
  }
  return {
    players: out,
    tours: listPlayedFotmobTours(database, leagueId, seasonStartIso(now), now),
  };
}

export function aggregateMantraDomaFotmobStats(
  database: Database.Database,
  now: Date,
  fotmobIds?: number[],
): Record<string, MantraDomaPlayerStats> {
  return buildMantraDomaFotmobStats(database, now, fotmobIds).players;
}

export function getMantraDomaStats(options?: {
  database?: Database.Database;
  now?: Date;
}): MantraDomaStatsView {
  const database = options?.database ?? getDb();
  const now = options?.now ?? new Date();
  const seasonStart = seasonStartIso(now);
  const leagueId = LEAGUE_ONE_FOTMOB_ID;
  const fp = mantraDomaStatsFingerprint(database, leagueId, seasonStart, now);
  const bucket = Math.floor(now.getTime() / MANTRA_DOMA_STATS_TTL_MS);
  const version = `ttl:${bucket}|league:${leagueId}|season:${seasonStart}|fp:${fp}|v:3`;
  const cached = getComputed(
    MANTRA_DOMA_STATS_CACHE_KEY,
    version,
    () => buildMantraDomaFotmobStats(database, now),
    { database, serveStale: false },
  );
  return {
    ok: true,
    source: "fotmob",
    leagueId,
    seasonStart,
    tours: cached.value?.tours ?? [],
    players: cached.value?.players ?? {},
    cachedAt: cached.builtAt || null,
  };
}
