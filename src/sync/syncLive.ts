/**
 * Sync current Live round from FotMob + refresh details for live/recent matches.
 */
import * as fotmob from "../clients/fotmob.js";
import { getDb, setMeta } from "../db/index.js";
import {
  DEFAULT_LIVE_SLUG,
  liveOngoingMetaKey,
  liveRoundMetaKey,
  liveSyncedMetaKey,
  mantraToursAreLocked,
  mantraToursHaveActiveDeadline,
  preferMantraMatchRound,
  resolveLiveLeague,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";
import { getMantraToursCached } from "./syncMantraTours.js";
import { withTimeout } from "../lib/withTimeout.js";

/** Cap details pulls so one league cannot occupy the FotMob lock for the full 5m interval. */
export const MAX_LIVE_DETAILS_REFRESH = 12;
export const LEAGUE_SYNC_TIMEOUT_MS = 60_000;

export type LiveSyncResult = {
  slug: string;
  fotmobLeagueId: number;
  round: string | null;
  listed: number;
  refreshed: number;
  live: number;
  finished: number;
  upcoming: number;
  syncedAt: string;
};

function ensureTables(): void {
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

/** Pick displayed tour: stay on last finished round until the next round starts. */
export function pickCurrentRound(matches: fotmob.FotmobFixtureMatch[]): string | null {
  const live = matches.find((m) => fotmob.matchPhase(m) === "live");
  if (live?.round != null) return String(live.round);

  const now = Date.now();
  const finished = matches
    .filter((m) => fotmob.matchPhase(m) === "finished" && m.status.utcTime)
    .sort((a, b) => String(b.status.utcTime).localeCompare(String(a.status.utcTime)));
  const lastFinishedRound = finished[0]?.round != null ? String(finished[0].round) : null;

  const upcoming = matches
    .filter((m) => fotmob.matchPhase(m) === "upcoming" && m.status.utcTime)
    .sort((a, b) => String(a.status.utcTime).localeCompare(String(b.status.utcTime)));
  const nextUpcoming = upcoming[0] ?? null;
  const nextRound = nextUpcoming?.round != null ? String(nextUpcoming.round) : null;
  const nextKick = nextUpcoming?.status.utcTime
    ? Date.parse(String(nextUpcoming.status.utcTime))
    : NaN;

  // Hold the completed tour (Dream Team + results) until the next tour kicks off.
  if (lastFinishedRound) {
    if (!nextRound || nextRound === lastFinishedRound) return lastFinishedRound;
    if (!Number.isFinite(nextKick) || nextKick > now) return lastFinishedRound;
    return nextRound;
  }

  if (nextRound) return nextRound;
  return matches[0]?.round != null ? String(matches[0].round) : null;
}

export function upsertMatchList(
  matches: fotmob.FotmobFixtureMatch[],
  fotmobLeagueId: number,
  now: string,
): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO fotmob_matches (
       id, league_id, round, round_name, kickoff, home_id, home_name, away_id, away_name,
       score_home, score_away, status_short, phase, page_url, list_synced_at
     ) VALUES (
       @id, @league_id, @round, @round_name, @kickoff, @home_id, @home_name, @away_id, @away_name,
       @score_home, @score_away, @status_short, @phase, @page_url, @list_synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       league_id = excluded.league_id,
       round = excluded.round,
       round_name = excluded.round_name,
       kickoff = excluded.kickoff,
       home_id = excluded.home_id,
       home_name = excluded.home_name,
       away_id = excluded.away_id,
       away_name = excluded.away_name,
       score_home = COALESCE(excluded.score_home, fotmob_matches.score_home),
       score_away = COALESCE(excluded.score_away, fotmob_matches.score_away),
       status_short = excluded.status_short,
       phase = excluded.phase,
       page_url = excluded.page_url,
       list_synced_at = excluded.list_synced_at`,
  );
  const tx = db.transaction((rows: fotmob.FotmobFixtureMatch[]) => {
    for (const m of rows) {
      const phase = fotmob.matchPhase(m);
      upsert.run({
        id: m.id,
        league_id: fotmobLeagueId,
        round: m.round != null ? String(m.round) : null,
        round_name: m.roundName,
        kickoff: m.status.utcTime ?? null,
        home_id: m.home.id,
        home_name: m.home.name,
        away_id: m.away.id,
        away_name: m.away.name,
        score_home: m.home.score,
        score_away: m.away.score,
        status_short:
          m.status.reason?.short ?? m.status.liveTime?.short ?? (phase === "upcoming" ? "NS" : null),
        phase,
        page_url: m.pageUrl,
        list_synced_at: now,
      });
    }
  });
  tx(matches);
}

export function storeMatchDetails(d: fotmob.FotmobMatchDetails, now: string): void {
  const db = getDb();
  const phase = fotmob.matchPhase(d);
  db.prepare(
    `UPDATE fotmob_matches SET
       kickoff = COALESCE(@kickoff, kickoff),
       home_id = @home_id,
       home_name = @home_name,
       away_id = @away_id,
       away_name = @away_name,
       score_home = @score_home,
       score_away = @score_away,
       status_short = @status_short,
       phase = @phase,
       potm_player_id = @potm_player_id,
       potm_name = @potm_name,
       potm_rating = @potm_rating,
       details_synced_at = @details_synced_at
     WHERE id = @id`,
  ).run({
    id: d.matchId,
    kickoff: d.kickoff,
    home_id: d.home.id,
    home_name: d.home.name,
    away_id: d.away.id,
    away_name: d.away.name,
    score_home: d.scoreHome,
    score_away: d.scoreAway,
    status_short: d.statusShort,
    phase,
    potm_player_id: d.potm?.playerId ?? null,
    potm_name: d.potm?.name ?? null,
    potm_rating: d.potm?.rating ?? null,
    details_synced_at: now,
  });

  db.prepare(`DELETE FROM fotmob_match_players WHERE match_id = ?`).run(d.matchId);
  db.prepare(`DELETE FROM fotmob_match_events WHERE match_id = ?`).run(d.matchId);

  const insP = db.prepare(
    `INSERT INTO fotmob_match_players (
       match_id, player_id, name, team_id, team_name, is_home, shirt_number, position_id, rating, starter,
       minutes, goals, assists, yellow_cards, red_cards, own_goals, saves, goals_conceded,
       penalties_won, penalties_conceded, penalties_scored, penalties_missed, penalties_saved
     ) VALUES (
       @match_id, @player_id, @name, @team_id, @team_name, @is_home, @shirt_number, @position_id, @rating, @starter,
       @minutes, @goals, @assists, @yellow_cards, @red_cards, @own_goals, @saves, @goals_conceded,
       @penalties_won, @penalties_conceded, @penalties_scored, @penalties_missed, @penalties_saved
     )`,
  );
  const insE = db.prepare(
    `INSERT INTO fotmob_match_events (
       match_id, event_idx, time, overload_time, type, is_home, player_id, player_name, card,
       home_score, away_score, raw_json
     ) VALUES (
       @match_id, @event_idx, @time, @overload_time, @type, @is_home, @player_id, @player_name, @card,
       @home_score, @away_score, @raw_json
     )`,
  );

  const tx = db.transaction(() => {
    const seen = new Set<number>();
    for (const p of d.players) {
      if (!p.playerId || seen.has(p.playerId)) continue;
      seen.add(p.playerId);
      insP.run({
        match_id: d.matchId,
        player_id: p.playerId,
        name: p.name,
        team_id: p.teamId,
        team_name: p.teamName,
        is_home: p.isHome ? 1 : 0,
        shirt_number: p.shirtNumber,
        position_id: p.positionId,
        rating: p.rating,
        starter: p.starter ? 1 : 0,
        minutes: p.minutes,
        goals: p.goals,
        assists: p.assists,
        yellow_cards: p.yellowCards,
        red_cards: p.redCards,
        own_goals: p.ownGoals,
        saves: p.saves,
        goals_conceded: p.goalsConceded,
        penalties_won: p.penaltiesWon,
        penalties_conceded: p.penaltiesConceded,
        penalties_scored: p.penaltiesScored,
        penalties_missed: p.penaltiesMissed,
        penalties_saved: p.penaltiesSaved,
      });
    }
    d.events.forEach((e, idx) => {
      insE.run({
        match_id: d.matchId,
        event_idx: idx,
        time: e.time,
        overload_time: e.overloadTime,
        type: e.type,
        is_home: e.isHome == null ? null : e.isHome ? 1 : 0,
        player_id: e.playerId,
        player_name: e.playerName,
        card: e.card,
        home_score: e.homeScore,
        away_score: e.awayScore,
        raw_json: JSON.stringify(e.raw),
      });
    });
  });
  tx();
}

/** Which matches need a details refresh this cycle. */
export function selectMatchesToRefresh(
  roundMatches: fotmob.FotmobFixtureMatch[],
): fotmob.FotmobFixtureMatch[] {
  const now = Date.now();
  const tourOpen = roundMatches.some((m) => {
    const p = fotmob.matchPhase(m);
    return p === "live" || p === "upcoming";
  });
  const out: fotmob.FotmobFixtureMatch[] = [];
  for (const m of roundMatches) {
    const phase = fotmob.matchPhase(m);
    if (phase === "live") {
      out.push(m);
      continue;
    }
    if (phase === "finished") {
      const db = getDb();
      const row = db
        .prepare(`SELECT details_synced_at, potm_rating FROM fotmob_matches WHERE id = ?`)
        .get(m.id) as { details_synced_at: string | null; potm_rating: number | null } | undefined;
      const kick = m.status.utcTime ? Date.parse(m.status.utcTime) : NaN;
      const recent = Number.isFinite(kick) && now - kick < 6 * 3600_000;
      if (!row?.details_synced_at) {
        out.push(m);
        continue;
      }
      // Unfinished tour: re-pull FT matches hourly — FotMob often revises ratings post-match.
      const syncedAt = Date.parse(row.details_synced_at);
      const hourStale = Number.isFinite(syncedAt) && now - syncedAt >= 60 * 60_000;
      if (tourOpen && hourStale) {
        out.push(m);
        continue;
      }
      if (recent && row.potm_rating == null) {
        out.push(m);
        continue;
      }
      // Re-fetch if we lack detailed player stats (minutes) needed for Mantra scoring.
      const hasMins = db
        .prepare(
          `SELECT 1 AS ok FROM fotmob_match_players WHERE match_id = ? AND minutes IS NOT NULL LIMIT 1`,
        )
        .get(m.id) as { ok: number } | undefined;
      if (!hasMins) out.push(m);
      continue;
    }
    // upcoming: pull details in the last 90 minutes so we catch published XIs
    if (phase === "upcoming") {
      const kick = m.status.utcTime ? Date.parse(m.status.utcTime) : NaN;
      if (!Number.isFinite(kick)) continue;
      const msLeft = kick - now;
      if (msLeft > 0 && msLeft <= 90 * 60_000) out.push(m);
    }
  }
  return out.slice(0, MAX_LIVE_DETAILS_REFRESH);
}

export async function syncLiveRound(
  league: string | LiveLeagueDef | null = DEFAULT_LIVE_SLUG,
  signal?: AbortSignal,
): Promise<LiveSyncResult> {
  ensureTables();
  const def = resolveLiveLeague(typeof league === "object" && league ? league.slug : league);
  const fotmobLeagueId = def.fotmobLeagueId;
  const slug = def.slug;
  const now = new Date().toISOString();
  console.log(`Live sync [${slug}] fetching fixtures…`);
  const { matches, hasOngoingMatch } = await fotmob.fetchLeagueFixtures(fotmobLeagueId, signal);
  upsertMatchList(matches, fotmobLeagueId, now);

  const fotmobRound = pickCurrentRound(matches);
  const mantra = getMantraToursCached(slug);
  const mantraRound = mantra.tours.find((t) => t.round != null)?.round ?? null;
  const round = preferMantraMatchRound(
    fotmobRound,
    mantraRound,
    mantraToursAreLocked(mantra.tours),
    mantraToursHaveActiveDeadline(mantra.tours),
  );
  const roundMatches = round
    ? matches.filter((m) => String(m.round) === round)
    : matches.slice(0, 9);

  const liveNow = matches.filter((m) => fotmob.matchPhase(m) === "live");
  const extraLive = liveNow.filter((m) => !roundMatches.some((r) => r.id === m.id));
  const toRefresh = selectMatchesToRefresh([...roundMatches, ...extraLive]);
  // Persist list sync before details so a hung matchDetails cannot freeze syncedAt.
  setMeta(liveRoundMetaKey(slug), round ?? "");
  setMeta(liveSyncedMetaKey(slug), now);
  setMeta(liveOngoingMetaKey(slug), hasOngoingMatch ? "1" : "0");
  console.log(
    `Live sync [${slug}] round=${round} listed=${roundMatches.length} refreshing=${toRefresh.length}`,
  );
  let refreshed = 0;
  for (const m of toRefresh) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      console.log(`  fotmob match ${m.id} details…`);
      const details = await fotmob.fetchMatchDetails(m.id, signal);
      // Keep list round if details omit it
      if (!details.round && m.round != null) details.round = String(m.round);
      storeMatchDetails(details, now);
      refreshed++;
    } catch (err) {
      console.warn(
        `  fotmob match ${m.id} details failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const phases = roundMatches.map((m) => fotmob.matchPhase(m));
  const result: LiveSyncResult = {
    slug,
    fotmobLeagueId,
    round,
    listed: roundMatches.length,
    refreshed,
    live: phases.filter((p) => p === "live").length,
    finished: phases.filter((p) => p === "finished").length,
    upcoming: phases.filter((p) => p === "upcoming").length,
    syncedAt: now,
  };
  console.log(
    `Live sync [${slug}] round=${round} listed=${result.listed} refreshed=${refreshed} live=${result.live}`,
  );
  return result;
}

export async function syncAllLiveRounds(): Promise<LiveSyncResult[]> {
  const { allLiveLeagues } = await import("../lib/liveLeagues.js");
  const out: LiveSyncResult[] = [];
  for (const league of allLiveLeagues()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ac = new AbortController();
    try {
      out.push(
        await withTimeout(
          syncLiveRound(league.slug, ac.signal),
          LEAGUE_SYNC_TIMEOUT_MS,
          `Live sync [${league.slug}] timed out`,
        ),
      );
    } catch (err) {
      console.warn(
        `Live sync [${league.slug}] failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      ac.abort();
    }
  }
  return out;
}
