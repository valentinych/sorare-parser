/**
 * Sync League One (FotMob 108) fixtures + finished-match details into fotmob_* tables
 * for Mantra BS/TS reports.
 */
import * as fotmob from "../clients/fotmob.js";
import { getDb, setMeta } from "../db/index.js";
import { LEAGUE_ONE_FOTMOB_ID } from "../domain/leagueOne.js";
import { storeMatchDetails, upsertMatchList } from "./syncLive.js";

export const LEAGUE_ONE_MATCHES_SYNCED_META = "league_one_matches_synced_at";
/** Cap details pulls per sync so admin "Обновить" stays responsive. */
export const MAX_LEAGUE_ONE_DETAILS_PER_SYNC = 40;

export type LeagueOneMatchesSyncResult = {
  fotmobLeagueId: number;
  listed: number;
  finished: number;
  refreshed: number;
  pendingDetails: number;
  syncedAt: string;
};

function ensureTables(): void {
  // Same schema as Live — create if a fresh DB never ran syncLive.
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      round_name TEXT,
      kickoff TEXT,
      home_id INTEGER,
      home_name TEXT,
      away_id INTEGER,
      away_name TEXT,
      score_home INTEGER,
      score_away INTEGER,
      status_short TEXT,
      phase TEXT,
      page_url TEXT,
      potm_player_id INTEGER,
      potm_name TEXT,
      potm_rating REAL,
      details_synced_at TEXT,
      list_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fotmob_match_players (
      match_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      name TEXT,
      team_id INTEGER,
      team_name TEXT,
      is_home INTEGER,
      shirt_number TEXT,
      position_id INTEGER,
      rating REAL,
      starter INTEGER,
      minutes INTEGER,
      goals INTEGER,
      assists INTEGER,
      yellow_cards INTEGER,
      red_cards INTEGER,
      own_goals INTEGER,
      saves INTEGER,
      goals_conceded INTEGER,
      penalties_won INTEGER,
      penalties_conceded INTEGER,
      penalties_scored INTEGER,
      penalties_missed INTEGER,
      penalties_saved INTEGER,
      PRIMARY KEY (match_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS fotmob_match_events (
      match_id INTEGER NOT NULL,
      event_idx INTEGER NOT NULL,
      time INTEGER,
      overload_time INTEGER,
      type TEXT,
      is_home INTEGER,
      player_id INTEGER,
      player_name TEXT,
      card TEXT,
      home_score INTEGER,
      away_score INTEGER,
      raw_json TEXT,
      PRIMARY KEY (match_id, event_idx)
    );
  `);
}

/** Finished League One matches that still need player minutes for scoring. */
export function selectLeagueOneMatchesNeedingDetails(
  matches: fotmob.FotmobFixtureMatch[],
  limit = MAX_LEAGUE_ONE_DETAILS_PER_SYNC,
): fotmob.FotmobFixtureMatch[] {
  const db = getDb();
  const finished = matches
    .filter((m) => fotmob.matchPhase(m) === "finished")
    .sort((a, b) => String(a.status.utcTime ?? "").localeCompare(String(b.status.utcTime ?? "")));
  const out: fotmob.FotmobFixtureMatch[] = [];
  for (const m of finished) {
    if (out.length >= limit) break;
    const row = db
      .prepare(`SELECT details_synced_at FROM fotmob_matches WHERE id = ?`)
      .get(m.id) as { details_synced_at: string | null } | undefined;
    if (!row?.details_synced_at) {
      out.push(m);
      continue;
    }
    const hasMins = db
      .prepare(
        `SELECT 1 AS ok FROM fotmob_match_players WHERE match_id = ? AND minutes IS NOT NULL LIMIT 1`,
      )
      .get(m.id) as { ok: number } | undefined;
    if (!hasMins) out.push(m);
  }
  return out;
}

export async function syncLeagueOneMatches(
  opts: { signal?: AbortSignal; maxDetails?: number } = {},
): Promise<LeagueOneMatchesSyncResult> {
  ensureTables();
  const now = new Date().toISOString();
  const maxDetails = opts.maxDetails ?? MAX_LEAGUE_ONE_DETAILS_PER_SYNC;
  console.log(`League One matches sync (FotMob ${LEAGUE_ONE_FOTMOB_ID})…`);
  const { matches } = await fotmob.fetchLeagueFixtures(LEAGUE_ONE_FOTMOB_ID, opts.signal);
  upsertMatchList(matches, LEAGUE_ONE_FOTMOB_ID, now);

  const finished = matches.filter((m) => fotmob.matchPhase(m) === "finished");
  const needing = selectLeagueOneMatchesNeedingDetails(matches, maxDetails);
  const pendingDetails = finished.filter((m) => {
    const row = getDb()
      .prepare(`SELECT details_synced_at FROM fotmob_matches WHERE id = ?`)
      .get(m.id) as { details_synced_at: string | null } | undefined;
    if (!row?.details_synced_at) return true;
    const hasMins = getDb()
      .prepare(
        `SELECT 1 AS ok FROM fotmob_match_players WHERE match_id = ? AND minutes IS NOT NULL LIMIT 1`,
      )
      .get(m.id) as { ok: number } | undefined;
    return !hasMins;
  }).length;

  let refreshed = 0;
  for (const m of needing) {
    if (opts.signal?.aborted) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      console.log(`  League One match ${m.id} details…`);
      const details = await fotmob.fetchMatchDetails(m.id, opts.signal);
      if (!details.round && m.round != null) details.round = String(m.round);
      storeMatchDetails(details, now);
      refreshed += 1;
    } catch (err) {
      console.warn(
        `  League One match ${m.id} details failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  setMeta(LEAGUE_ONE_MATCHES_SYNCED_META, now);
  const result: LeagueOneMatchesSyncResult = {
    fotmobLeagueId: LEAGUE_ONE_FOTMOB_ID,
    listed: matches.length,
    finished: finished.length,
    refreshed,
    pendingDetails: Math.max(0, pendingDetails - refreshed),
    syncedAt: now,
  };
  console.log(
    `League One matches sync listed=${result.listed} finished=${result.finished} refreshed=${result.refreshed} pending=${result.pendingDetails}`,
  );
  return result;
}
