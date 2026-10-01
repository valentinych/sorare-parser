/**
 * Extra-league Ideal: when FotMob stores lineups without ratings (Enetpulse),
 * persist official Mantra player GW totals by mantra player id, archive the
 * locked XI+bench, and copy totals onto FotMob rows that still have no rating.
 * Never overwrites a native FotMob rating. Extra-league tournament IDs only.
 */
import { fetchMantraMatch, type MantraMatch, type MantraMatchSquadPlayer } from "../clients/mantraAuth.js";
import { getDb } from "../db/index.js";
import {
  isNativeFotmobRating,
  upsertMantraGwPlayerScores,
  type MantraGwPlayerScore,
} from "../domain/mantraGwScores.js";
import { listScoredFotmobRounds } from "../domain/mantraIdealVsReal.js";
import { liveLeagueBySlug, isTablesExtraSlug } from "../lib/liveLeagues.js";
import {
  enrichFromDb,
  loadMantraLineups,
  writeMantraLineupsRoundArchive,
} from "./syncMantraLineups.js";
import { getMantraToursForRound } from "./syncMantraTours.js";

export function mantraScoreFromLabel(label: string | null | undefined): number | null {
  if (label == null) return null;
  const n = Number(String(label).replace(",", ".").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export function fotmobIdsFromMantraScores(
  players: Array<{ playerId?: number | null; scoreLabel?: string | null }>,
  mantraToFotmob: Map<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const player of players) {
    const mantraId = Number(player.playerId);
    const score = mantraScoreFromLabel(player.scoreLabel);
    if (!Number.isSafeInteger(mantraId) || mantraId <= 0 || score == null) continue;
    const fotmobId = mantraToFotmob.get(mantraId);
    if (fotmobId == null || fotmobId <= 0) continue;
    const prev = out.get(fotmobId);
    if (prev == null || score > prev) out.set(fotmobId, score);
  }
  return out;
}

export function mantraGwScoresFromPlayers(
  players: Array<{
    playerId?: number | null;
    scoreLabel?: string | null;
    baseLabel?: string | null;
  }>,
): MantraGwPlayerScore[] {
  const byId = new Map<number, MantraGwPlayerScore>();
  for (const player of players) {
    const playerId = Number(player.playerId);
    const total = mantraScoreFromLabel(player.scoreLabel);
    if (!Number.isSafeInteger(playerId) || playerId <= 0 || total == null) continue;
    const base = mantraScoreFromLabel(player.baseLabel);
    const prev = byId.get(playerId);
    if (!prev || total > prev.total) {
      byId.set(playerId, { playerId, total, base });
    }
  }
  return [...byId.values()];
}

function matchSquadPlayers(match: MantraMatch): MantraMatchSquadPlayer[] {
  return [
    ...(match.home.squad || []),
    ...(match.home.substitutes || []),
    ...(match.away.squad || []),
    ...(match.away.substitutes || []),
  ];
}

function matchHasPostedScores(match: MantraMatch | undefined): boolean {
  if (!match) return false;
  return matchSquadPlayers(match).some((p) => mantraScoreFromLabel(p.scoreLabel) != null);
}

function loadMantraToFotmob(tournamentId: number): Map<number, number> {
  const rows = getDb()
    .prepare(
      `SELECT id, fotmob_player_id AS fotmobId FROM mantra_players
       WHERE tournament_id = ? AND fotmob_player_id IS NOT NULL`,
    )
    .all(tournamentId) as Array<{ id: number; fotmobId: number }>;
  return new Map(rows.map((row) => [row.id, row.fotmobId]));
}

function finishedRoundMatchIds(slug: string, round: number): number[] {
  const ids = new Set<number>();
  for (const tour of getMantraToursForRound(round, slug).tours) {
    for (const match of tour.matches || []) {
      const id = Number(match.matchId);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids];
}

function finishedFotmobRounds(fotmobLeagueId: number): number[] {
  return listScoredFotmobRounds(fotmobLeagueId)
    .filter((item) => item.fullyFinished)
    .map((item) => Number(item.round))
    .filter((n) => Number.isFinite(n) && n >= 1);
}

/** Skip FotMob overlay when the league already has real match ratings (not Mantra copies). */
export function leagueHasNativeFotmobRatings(fotmobLeagueId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT p.rating, p.minutes FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ? AND m.phase = 'finished'
         AND p.rating IS NOT NULL AND p.rating > 0
         AND p.minutes IS NOT NULL AND p.minutes > 0
       LIMIT 1`,
    )
    .get(fotmobLeagueId) as { rating: number; minutes: number } | undefined;
  return isNativeFotmobRating(row?.rating, row?.minutes);
}

function applyRatingsToRound(
  fotmobLeagueId: number,
  round: number,
  ratings: Map<number, number>,
): number {
  if (!ratings.size) return 0;
  const upd = getDb().prepare(
    `UPDATE fotmob_match_players
     SET rating = ?
     WHERE player_id = ?
       AND rating IS NULL
       AND match_id IN (
         SELECT id FROM fotmob_matches
         WHERE league_id = ? AND round = ? AND phase IN ('live', 'finished')
       )`,
  );
  let n = 0;
  const tx = getDb().transaction(() => {
    for (const [fotmobId, score] of ratings) {
      n += upd.run(score, fotmobId, fotmobLeagueId, String(round)).changes;
    }
  });
  tx();
  if (n > 0) {
    getDb()
      .prepare(
        `UPDATE fotmob_matches SET details_synced_at = ?
         WHERE league_id = ? AND round = ? AND phase IN ('live', 'finished')`,
      )
      .run(new Date().toISOString(), fotmobLeagueId, String(round));
  }
  return n;
}

function persistRoundScores(
  slug: string,
  round: number,
  matches: Record<string, MantraMatch>,
  mantraToFotmob: Map<number, number>,
  overlayFotmob: boolean,
): { stored: number; rated: number } {
  const players: MantraMatchSquadPlayer[] = [];
  for (const match of Object.values(matches)) players.push(...matchSquadPlayers(match));
  const stored = upsertMantraGwPlayerScores(slug, round, mantraGwScoresFromPlayers(players));
  let rated = 0;
  if (overlayFotmob) {
    rated = applyRatingsToRound(
      liveLeagueBySlug(slug)!.fotmobLeagueId,
      round,
      fotmobIdsFromMantraScores(players, mantraToFotmob),
    );
  }
  return { stored, rated };
}

export async function backfillMantraGwRatings(
  slug: string,
  opts: { fetchMatch?: typeof fetchMantraMatch } = {},
): Promise<{ slug: string; matches: number; rated: number; stored: number; skipped: boolean }> {
  const empty = { slug, matches: 0, rated: 0, stored: 0, skipped: true };
  if (!isTablesExtraSlug(slug)) return empty;
  const league = liveLeagueBySlug(slug);
  if (!league?.mantraTournamentId) return empty;

  const fetchMatch = opts.fetchMatch ?? fetchMantraMatch;
  const mantraToFotmob = loadMantraToFotmob(league.mantraTournamentId);
  const overlayFotmob = !leagueHasNativeFotmobRatings(league.fotmobLeagueId);
  if (!overlayFotmob) {
    console.log(`  gw-ratings [${slug}]: FotMob native ratings present — skip overlay`);
  }
  const rounds = finishedFotmobRounds(league.fotmobLeagueId);
  let matches = 0;
  let rated = 0;
  let stored = 0;
  for (const round of rounds) {
    const ids = finishedRoundMatchIds(slug, round);
    const archived = loadMantraLineups(round, slug);
    const roundMatches: Record<string, MantraMatch> = {};
    const missing: number[] = [];
    for (const matchId of ids) {
      const cached = archived?.matches?.[String(matchId)];
      if (cached && matchHasPostedScores(cached)) {
        roundMatches[String(matchId)] = cached;
      } else {
        missing.push(matchId);
      }
    }
    for (const matchId of missing) {
      try {
        const raw = await fetchMatch(matchId);
        const enriched = enrichFromDb(raw, league.mantraTournamentId);
        roundMatches[String(matchId)] = enriched;
        matches += 1;
        if (matches % 25 === 0) {
          console.log(`  gw-ratings [${slug}] r${round} fetched=${matches}`);
        }
      } catch (error) {
        console.warn(
          `  gw-ratings ${slug} match ${matchId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (Object.keys(roundMatches).length) {
      writeMantraLineupsRoundArchive(slug, round, roundMatches);
      const result = persistRoundScores(slug, round, roundMatches, mantraToFotmob, overlayFotmob);
      stored += result.stored;
      rated += result.rated;
    }
    console.log(
      `  gw-ratings [${slug}] round ${round}: matches=${ids.length} fetched=${missing.length} stored=${stored} rows=${rated}`,
    );
  }
  return { slug, matches, rated, stored, skipped: false };
}
