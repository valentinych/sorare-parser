import { getDb } from "../db/index.js";
import {
  liveRoundMetaKey,
  liveSyncedMetaKey,
  mantraToursAreLocked,
  mantraToursHaveActiveDeadline,
  preferMantraMatchRound,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";
import { getMantraToursCached, getMantraToursForRound } from "../sync/syncMantraTours.js";
import { loadMantraLineups } from "../sync/syncMantraLineups.js";
import { MANTRA_SCORE_RULES_VERSION } from "../lib/mantraScoring.js";

export type LiveGoalEvent = {
  time: number | null;
  overloadTime: number | null;
  minuteLabel: string;
  scorer: string;
  assist: string | null;
  isHome: boolean;
  ownGoal: boolean;
};

export type LiveCardEvent = {
  time: number | null;
  overloadTime: number | null;
  minuteLabel: string;
  playerName: string;
  card: string | null;
  isHome: boolean;
};

export type LiveTopPlayer = {
  name: string;
  rating: number;
  teamName: string;
  isHome: boolean;
};

export type LiveMatchSummary = {
  id: number;
  round: string | null;
  kickoff: string | null;
  home: { id: number; name: string };
  away: { id: number; name: string };
  scoreHome: number | null;
  scoreAway: number | null;
  statusShort: string | null;
  phase: "live" | "finished" | "upcoming" | "cancelled" | string;
  pageUrl: string | null;
  fotmobUrl: string;
  potm: { playerId: number; name: string; rating: number | null } | null;
  detailsSyncedAt: string | null;
  /** Best player per side (home / away), for card stars. */
  topBySide: { home: LiveTopPlayer | null; away: LiveTopPlayer | null };
  /** @deprecated kept for compatibility — flat top list */
  topRatings: LiveTopPlayer[];
  goals: LiveGoalEvent[];
  cards: LiveCardEvent[];
};

export type LiveMatchEvent = {
  time: number | null;
  overloadTime: number | null;
  type: string;
  isHome: boolean | null;
  playerName: string | null;
  playerId: number | null;
  card: string | null;
  homeScore: number | null;
  awayScore: number | null;
  assistName: string | null;
  /** Player leaving the pitch (FotMob swap[1]). */
  playerOut: string | null;
  /** Player coming on (FotMob swap[0]). */
  playerIn: string | null;
  playerOutId: number | null;
  playerInId: number | null;
  ownGoal: boolean;
};

export type LiveMatchDetail = LiveMatchSummary & {
  events: LiveMatchEvent[];
  players: Array<{
    playerId: number;
    name: string;
    teamId: number | null;
    teamName: string | null;
    isHome: boolean;
    shirtNumber: string | null;
    rating: number | null;
    /** Display rating: real or 6.0 default when appeared without rating. */
    displayRating: number;
    ratingDefaulted: boolean;
    starter: boolean;
    appeared: boolean;
  }>;
};

const DEFAULT_LOW_MINUTES_RATING = 6.0;

/** Stale NS rows after kickoff still count as in-play (poller one cycle behind). */
export function effectiveLivePhase(
  phase: string,
  kickoff: string | null,
  statusShort: string | null,
): string {
  if (phase === "cancelled" || phase === "finished" || phase === "live") return phase;
  const short = String(statusShort ?? "").toUpperCase();
  if (short === "PP" || short === "CANC" || short === "PST") return phase;
  const kick = kickoff ? Date.parse(kickoff) : NaN;
  if (Number.isFinite(kick) && Date.now() >= kick) return "live";
  return phase;
}

function fotmobMatchUrl(id: number, pageUrl: string | null): string {
  if (pageUrl?.startsWith("/")) return `https://www.fotmob.com${pageUrl}`;
  return `https://www.fotmob.com/matches?id=${id}`;
}

function minuteLabel(time: number | null, overload: number | null): string {
  if (time == null) return "—";
  if (overload != null && overload > 0) return `${time}+${overload}'`;
  return `${time}'`;
}

function fotmobCurrentRoundFromDb(slug: string, fotmobId: number): string | null {
  const db = getDb();
  const meta = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveRoundMetaKey(slug)) as { value: string } | undefined;
  if (meta?.value) return meta.value;

  const live = db
    .prepare(
      `SELECT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'live' AND round IS NOT NULL
       ORDER BY kickoff DESC LIMIT 1`,
    )
    .get(fotmobId) as { round: string } | undefined;
  if (live?.round) return live.round;

  const finished = db
    .prepare(
      `SELECT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'finished' AND round IS NOT NULL
       ORDER BY kickoff DESC LIMIT 1`,
    )
    .get(fotmobId) as { round: string } | undefined;
  const next = db
    .prepare(
      `SELECT round, kickoff FROM fotmob_matches
       WHERE league_id = ? AND phase = 'upcoming' AND round IS NOT NULL
       ORDER BY kickoff ASC LIMIT 1`,
    )
    .get(fotmobId) as { round: string; kickoff: string | null } | undefined;

  if (finished?.round) {
    if (!next?.round || next.round === finished.round) return finished.round;
    const kick = next.kickoff ? Date.parse(next.kickoff) : NaN;
    if (!Number.isFinite(kick) || kick > Date.now()) return finished.round;
    return next.round;
  }
  return next?.round ?? null;
}

export function currentRoundFromDb(league?: string | null): string | null {
  const def = resolveLiveLeague(league);
  const fotmobRound = fotmobCurrentRoundFromDb(def.slug, def.fotmobLeagueId);
  const tours = getMantraToursCached(def.slug).tours;
  return preferMantraMatchRound(
    fotmobRound,
    tours.find((t) => t.round != null)?.round ?? null,
    mantraToursAreLocked(tours),
    mantraToursHaveActiveDeadline(tours),
  );
}

export type LiveRoundTab = {
  round: string;
  label: string;
  current: boolean;
  /** Has at least one live/finished match with player stats or FT. */
  playable: boolean;
};

/** Rounds that started (live/finished) plus the soft-sticky current round. */
export function listAvailableRounds(league?: string | null): LiveRoundTab[] {
  const def = resolveLiveLeague(league);
  const fotmobId = def.fotmobLeagueId;
  const db = getDb();
  const current = currentRoundFromDb(def.slug);
  const rows = db
    .prepare(
      `SELECT round,
              SUM(CASE WHEN phase IN ('live', 'finished') THEN 1 ELSE 0 END) AS played
       FROM fotmob_matches
       WHERE league_id = ? AND round IS NOT NULL AND round != ''
       GROUP BY round
       ORDER BY CAST(round AS INTEGER) ASC`,
    )
    .all(fotmobId) as Array<{ round: string; played: number }>;

  const out: LiveRoundTab[] = [];
  for (const r of rows) {
    if (r.played === 0 && r.round !== current) continue;
    out.push({
      round: r.round,
      label: `Round ${r.round}`,
      current: r.round === current,
      playable: r.played > 0 || r.round === current,
    });
  }
  if (current && !out.some((t) => t.round === current)) {
    out.push({
      round: current,
      label: `Round ${current}`,
      current: true,
      playable: true,
    });
    out.sort((a, b) => Number(a.round) - Number(b.round));
  }
  return out;
}

/** Resolve requested round; fall back to current if missing/unknown. */
export function resolveLiveRound(
  requested?: string | null,
  league?: string | null,
): string | null {
  const def = resolveLiveLeague(league);
  const current = currentRoundFromDb(def.slug);
  if (requested == null || requested === "") return current;
  const want = String(requested);
  const tabs = listAvailableRounds(def.slug);
  if (tabs.some((t) => t.round === want)) return want;
  // Allow any round that exists in fotmob_matches (archived finished tours).
  const exists = getDb()
    .prepare(`SELECT 1 AS ok FROM fotmob_matches WHERE league_id = ? AND round = ? LIMIT 1`)
    .get(def.fotmobLeagueId, want) as { ok: number } | undefined;
  return exists ? want : current;
}

type RawEventRow = {
  time: number | null;
  overloadTime: number | null;
  type: string;
  isHome: number | null;
  playerName: string | null;
  playerId: number | null;
  card: string | null;
  homeScore: number | null;
  awayScore: number | null;
  raw_json: string | null;
};

function enrichEvent(row: RawEventRow): LiveMatchEvent {
  let assistName: string | null = null;
  let playerOut: string | null = null;
  let playerIn: string | null = null;
  let playerOutId: number | null = null;
  let playerInId: number | null = null;
  let ownGoal = false;
  let playerName = row.playerName;
  let playerId = row.playerId;

  if (row.raw_json) {
    try {
      const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
      if (typeof raw.assistInput === "string" && raw.assistInput.trim()) {
        assistName = raw.assistInput.trim();
      } else if (typeof raw.assistStr === "string") {
        const m = raw.assistStr.match(/assist by\s+(.+)/i);
        if (m) assistName = m[1].trim();
      }
      ownGoal = Boolean(raw.ownGoal);
      const swap = Array.isArray(raw.swap) ? (raw.swap as Array<Record<string, unknown>>) : [];
      // FotMob: swap[0] = player coming on, swap[1] = player going off
      if (swap[0]) {
        playerIn = swap[0].name != null ? String(swap[0].name) : null;
        playerInId = swap[0].id != null ? Number(swap[0].id) : null;
      }
      if (swap[1]) {
        playerOut = swap[1].name != null ? String(swap[1].name) : null;
        playerOutId = swap[1].id != null ? Number(swap[1].id) : null;
      }
      if (!playerName) {
        playerName =
          (raw.nameStr as string) ||
          (raw.fullName as string) ||
          ((raw.player as Record<string, unknown> | undefined)?.name as string) ||
          null;
      }
      if (playerId == null && raw.playerId != null) playerId = Number(raw.playerId);
    } catch {
      /* ignore bad json */
    }
  }

  return {
    time: row.time,
    overloadTime: row.overloadTime,
    type: row.type,
    isHome: row.isHome == null ? null : Boolean(row.isHome),
    playerName,
    playerId,
    card: row.card,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    assistName,
    playerOut,
    playerIn,
    playerOutId,
    playerInId,
    ownGoal,
  };
}

function loadEnrichedEvents(matchId: number): LiveMatchEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT time, overload_time AS overloadTime, type, is_home AS isHome,
              player_name AS playerName, player_id AS playerId, card,
              home_score AS homeScore, away_score AS awayScore, raw_json
       FROM fotmob_match_events WHERE match_id = ?
       ORDER BY event_idx ASC`,
    )
    .all(matchId) as RawEventRow[];
  return rows.map(enrichEvent);
}

function goalsFromEvents(events: LiveMatchEvent[]): LiveGoalEvent[] {
  return events
    .filter((e) => e.type === "Goal" && e.playerName)
    .map((e) => ({
      time: e.time,
      overloadTime: e.overloadTime,
      minuteLabel: minuteLabel(e.time, e.overloadTime),
      scorer: e.playerName!,
      assist: e.assistName,
      isHome: Boolean(e.isHome),
      ownGoal: e.ownGoal,
    }));
}

function cardsFromEvents(events: LiveMatchEvent[]): LiveCardEvent[] {
  return events
    .filter((e) => e.type === "Card" && e.playerName)
    .map((e) => ({
      time: e.time,
      overloadTime: e.overloadTime,
      minuteLabel: minuteLabel(e.time, e.overloadTime),
      playerName: e.playerName!,
      card: e.card,
      isHome: Boolean(e.isHome),
    }));
}

function subInIds(events: LiveMatchEvent[]): Set<number> {
  const ids = new Set<number>();
  for (const e of events) {
    if (e.type !== "Substitution") continue;
    if (e.playerInId != null && Number.isFinite(e.playerInId)) ids.add(e.playerInId);
  }
  return ids;
}

function topBySideForMatch(
  matchId: number,
  events: LiveMatchEvent[],
): { home: LiveTopPlayer | null; away: LiveTopPlayer | null; topRatings: LiveTopPlayer[] } {
  const cameOn = subInIds(events);
  const rows = getDb()
    .prepare(
      `SELECT name, rating, team_name AS teamName, is_home AS isHome, starter, player_id AS playerId
       FROM fotmob_match_players WHERE match_id = ?`,
    )
    .all(matchId) as Array<{
    name: string;
    rating: number | null;
    teamName: string;
    isHome: number;
    starter: number;
    playerId: number;
  }>;

  const scored: LiveTopPlayer[] = [];
  for (const p of rows) {
    const appeared = Boolean(p.starter) || cameOn.has(p.playerId);
    if (!appeared && p.rating == null) continue;
    const rating = p.rating != null ? Number(p.rating) : DEFAULT_LOW_MINUTES_RATING;
    scored.push({
      name: p.name,
      rating,
      teamName: p.teamName,
      isHome: Boolean(p.isHome),
    });
  }
  scored.sort((a, b) => b.rating - a.rating);
  const home = scored.find((p) => p.isHome) ?? null;
  const away = scored.find((p) => !p.isHome) ?? null;
  return { home, away, topRatings: scored.slice(0, 5) };
}

function matchSummaryFromRow(
  r: {
    id: number;
    round: string | null;
    kickoff: string | null;
    home_id: number;
    home_name: string;
    away_id: number;
    away_name: string;
    score_home: number | null;
    score_away: number | null;
    status_short: string | null;
    phase: string;
    page_url: string | null;
    potm_player_id: number | null;
    potm_name: string | null;
    potm_rating: number | null;
    details_synced_at: string | null;
  },
): LiveMatchSummary {
  const events = loadEnrichedEvents(r.id);
  const tops = topBySideForMatch(r.id, events);
  return {
    id: r.id,
    round: r.round,
    kickoff: r.kickoff,
    home: { id: r.home_id, name: r.home_name },
    away: { id: r.away_id, name: r.away_name },
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    statusShort: r.status_short,
    phase: effectiveLivePhase(r.phase, r.kickoff, r.status_short),
    pageUrl: r.page_url,
    fotmobUrl: fotmobMatchUrl(r.id, r.page_url),
    potm:
      r.potm_player_id != null
        ? { playerId: r.potm_player_id, name: r.potm_name || "", rating: r.potm_rating }
        : null,
    detailsSyncedAt: r.details_synced_at,
    topBySide: { home: tops.home, away: tops.away },
    topRatings: tops.topRatings,
    goals: goalsFromEvents(events),
    cards: cardsFromEvents(events),
  };
}

export function listLiveRound(
  requestedRound?: string | null,
  league?: string | null,
): {
  round: string | null;
  currentRound: string | null;
  rounds: LiveRoundTab[];
  syncedAt: string | null;
  matches: LiveMatchSummary[];
  league: string;
  leagueName: string;
  fotmobLeagueId: number;
} {
  const def = resolveLiveLeague(league);
  const fotmobId = def.fotmobLeagueId;
  const db = getDb();
  const currentRound = currentRoundFromDb(def.slug);
  const round = resolveLiveRound(requestedRound, def.slug);
  const rounds = listAvailableRounds(def.slug);
  const synced = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveSyncedMetaKey(def.slug)) as { value: string } | undefined;

  const rows = (
    round
      ? db
          .prepare(
            `SELECT * FROM fotmob_matches
             WHERE league_id = ? AND round = ?
             ORDER BY kickoff ASC, id ASC`,
          )
          .all(fotmobId, round)
      : db
          .prepare(
            `SELECT * FROM fotmob_matches
             WHERE league_id = ?
             ORDER BY kickoff DESC LIMIT 9`,
          )
          .all(fotmobId)
  ) as Array<{
    id: number;
    round: string | null;
    kickoff: string | null;
    home_id: number;
    home_name: string;
    away_id: number;
    away_name: string;
    score_home: number | null;
    score_away: number | null;
    status_short: string | null;
    phase: string;
    page_url: string | null;
    potm_player_id: number | null;
    potm_name: string | null;
    potm_rating: number | null;
    details_synced_at: string | null;
  }>;

  const matches = rows.map(matchSummaryFromRow);

  const order = { live: 0, upcoming: 1, finished: 2, cancelled: 3 } as Record<string, number>;
  matches.sort(
    (a, b) =>
      (order[a.phase] ?? 9) - (order[b.phase] ?? 9) ||
      String(a.kickoff).localeCompare(String(b.kickoff)),
  );

  return {
    round,
    currentRound,
    rounds,
    syncedAt: synced?.value ?? null,
    matches,
    league: def.slug,
    leagueName: def.name,
    fotmobLeagueId: fotmobId,
  };
}

/** Version key for Dream Team / Mantra scores / Ideal vs Real caches. */
export function liveRoundDataVersion(slug: string, round: string): string {
  const def = resolveLiveLeague(slug);
  const tours = getMantraToursForRound(round, slug);
  const lineups = loadMantraLineups(round, slug);
  const fotmob = getDb()
    .prepare(
      `SELECT COALESCE(MAX(details_synced_at), '') AS detailsAt,
              GROUP_CONCAT(
                id || ':' || phase || ':' || COALESCE(score_home, '') || ':' || COALESCE(score_away, ''),
                ','
              ) AS scores
       FROM fotmob_matches
       WHERE league_id = ? AND round = ?`,
    )
    .get(def.fotmobLeagueId, round) as { detailsAt: string; scores: string | null };
  const links = def.mantraTournamentId
    ? (getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM mantra_players
           WHERE tournament_id = ? AND fotmob_player_id IS NOT NULL`,
        )
        .get(def.mantraTournamentId) as { n: number })
    : { n: 0 };
  return [
    slug,
    round,
    MANTRA_SCORE_RULES_VERSION,
    tours.syncedAt ?? "",
    lineups?.syncedAt ?? "",
    fotmob.detailsAt,
    fotmob.scores ?? "",
    `links:${links.n}`,
  ].join("|");
}

export function getLiveMatch(matchId: number): LiveMatchDetail | null {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM fotmob_matches WHERE id = ?`).get(matchId) as
    | {
        id: number;
        round: string | null;
        kickoff: string | null;
        home_id: number;
        home_name: string;
        away_id: number;
        away_name: string;
        score_home: number | null;
        score_away: number | null;
        status_short: string | null;
        phase: string;
        page_url: string | null;
        potm_player_id: number | null;
        potm_name: string | null;
        potm_rating: number | null;
        details_synced_at: string | null;
      }
    | undefined;
  if (!r) return null;

  const summary = matchSummaryFromRow(r);
  const events = loadEnrichedEvents(matchId);
  const cameOn = subInIds(events);

  const players = db
    .prepare(
      `SELECT player_id AS playerId, name, team_id AS teamId, team_name AS teamName,
              is_home AS isHome, shirt_number AS shirtNumber, rating, starter
       FROM fotmob_match_players WHERE match_id = ?`,
    )
    .all(matchId) as Array<{
    playerId: number;
    name: string;
    teamId: number | null;
    teamName: string | null;
    isHome: number;
    shirtNumber: string | null;
    rating: number | null;
    starter: number;
  }>;

  const enrichedPlayers = players
    .map((p) => {
      const starter = Boolean(p.starter);
      const appeared = starter || cameOn.has(p.playerId) || p.rating != null;
      const ratingDefaulted = appeared && p.rating == null;
      const displayRating =
        p.rating != null ? Number(p.rating) : ratingDefaulted ? DEFAULT_LOW_MINUTES_RATING : 0;
      return {
        playerId: p.playerId,
        name: p.name,
        teamId: p.teamId,
        teamName: p.teamName,
        isHome: Boolean(p.isHome),
        shirtNumber: p.shirtNumber,
        rating: p.rating,
        displayRating,
        ratingDefaulted,
        starter,
        appeared,
      };
    })
    .filter((p) => p.appeared)
    .sort((a, b) => b.displayRating - a.displayRating || a.name.localeCompare(b.name));

  return {
    ...summary,
    events,
    players: enrichedPlayers,
  };
}
