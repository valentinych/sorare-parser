/**
 * Sync league fixtures + bookmaker odds from API-Football.
 * Markets: Match Winner (1x2), Clean Sheet H/A, Team Score a Goal H/A,
 * Exact Score (most likely score = shortest odds).
 * Player anytime scorer (bet 92) is not offered for Ekstraklasa — see parse notes.
 * Uses shared rateLimit4perSec (≤4 req/s).
 */
import * as af from "../clients/apiFootball.js";
import { config } from "../config.js";
import { getDb, setMeta } from "../db/index.js";
import {
  invalidateComputed,
  PREMIUM_ODDS_JOIN_CACHE_KEY,
} from "../lib/computedCache.js";

const PREFERRED_BOOKMAKER_IDS = [8, 7, 16, 1]; // Bet365, William Hill, Unibet, 10Bet

export type ParsedOdds = {
  home: number;
  draw: number;
  away: number;
  bookmaker: string;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  homeCsOdd: number | null;
  awayCsOdd: number | null;
  homeCsProb: number | null;
  awayCsProb: number | null;
  homeScoreOdd: number | null;
  awayScoreOdd: number | null;
  homeScoreProb: number | null;
  awayScoreProb: number | null;
  /** Most likely Exact Score, e.g. "2:0". */
  popularScore: string | null;
};

/** Implied probs from decimal odds, de-vigged to sum=1. */
export function implied1x2(home: number, draw: number, away: number): {
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
} {
  const ih = 1 / home;
  const id = 1 / draw;
  const ia = 1 / away;
  const sum = ih + id + ia;
  return {
    homeWinProb: Number((ih / sum).toFixed(4)),
    drawProb: Number((id / sum).toFixed(4)),
    awayWinProb: Number((ia / sum).toFixed(4)),
  };
}

/** Yes/No market → de-vigged P(Yes). */
export function impliedYesNo(yesOdd: number, noOdd: number): number | null {
  if (![yesOdd, noOdd].every((n) => Number.isFinite(n) && n > 1)) return null;
  const iy = 1 / yesOdd;
  const ino = 1 / noOdd;
  return Number((iy / (iy + ino)).toFixed(4));
}

function pickBookmaker(bookmakers: af.AfOddsBookmaker[]): af.AfOddsBookmaker | null {
  if (!bookmakers.length) return null;
  for (const id of PREFERRED_BOOKMAKER_IDS) {
    const hit = bookmakers.find((b) => b.id === id);
    if (hit?.bets.some((bet) => bet.id === 1 || bet.name === "Match Winner")) return hit;
  }
  const with1x2 = bookmakers.find((b) =>
    b.bets.some((bet) => bet.id === 1 || bet.name === "Match Winner"),
  );
  return with1x2 ?? bookmakers[0]!;
}

function betByIdOrName(
  bm: af.AfOddsBookmaker,
  id: number,
  name: string,
): af.AfOddsBookmaker["bets"][number] | undefined {
  return bm.bets.find((b) => b.id === id || b.name === name);
}

function yesNoFromBet(
  bet: af.AfOddsBookmaker["bets"][number] | undefined,
): { odd: number; prob: number } | null {
  if (!bet) return null;
  const yes = Number(bet.values.find((v) => String(v.value).toLowerCase() === "yes")?.odd);
  const no = Number(bet.values.find((v) => String(v.value).toLowerCase() === "no")?.odd);
  const prob = impliedYesNo(yes, no);
  if (prob == null || !Number.isFinite(yes)) return null;
  return { odd: yes, prob };
}

function normalizeExactScore(value: string): string | null {
  const match = value.trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Shortest-odds Exact Score outcome, skipping "any other score" buckets. */
export function popularScoreFromBet(
  bet: af.AfOddsBookmaker["bets"][number] | undefined,
): string | null {
  if (!bet) return null;
  let best: { score: string; odd: number } | null = null;
  for (const row of bet.values) {
    const score = normalizeExactScore(String(row.value ?? ""));
    const odd = Number(row.odd);
    if (!score || !Number.isFinite(odd) || odd <= 1) continue;
    if (!best || odd < best.odd) best = { score, odd };
  }
  return best?.score ?? null;
}

/**
 * Parse 1x2 + team CS + team-to-score from one bookmaker payload.
 * Gap: Anytime Goal Scorer (bet 92) is not present for Ekstraklasa fixtures;
 * attackers use Home/Away Team Score a Goal (43/44) as P(team scores).
 */
export function parseFixtureOdds(bookmakers: af.AfOddsBookmaker[]): ParsedOdds | null {
  const bm = pickBookmaker(bookmakers);
  if (!bm) return null;
  const mw = betByIdOrName(bm, 1, "Match Winner");
  if (!mw) return null;
  const home = Number(mw.values.find((v) => v.value === "Home")?.odd);
  const draw = Number(mw.values.find((v) => v.value === "Draw")?.odd);
  const away = Number(mw.values.find((v) => v.value === "Away")?.odd);
  if (![home, draw, away].every((n) => Number.isFinite(n) && n > 1)) return null;
  const probs = implied1x2(home, draw, away);

  // Prefer CS/score from same bookmaker; fall back across bookmakers.
  const findYesNo = (id: number, name: string) => {
    const local = yesNoFromBet(betByIdOrName(bm, id, name));
    if (local) return local;
    for (const idPref of PREFERRED_BOOKMAKER_IDS) {
      const other = bookmakers.find((b) => b.id === idPref);
      if (!other || other.id === bm.id) continue;
      const hit = yesNoFromBet(betByIdOrName(other, id, name));
      if (hit) return hit;
    }
    for (const other of bookmakers) {
      if (other.id === bm.id) continue;
      const hit = yesNoFromBet(betByIdOrName(other, id, name));
      if (hit) return hit;
    }
    return null;
  };

  const homeCs = findYesNo(27, "Clean Sheet - Home");
  const awayCs = findYesNo(28, "Clean Sheet - Away");
  const homeScore = findYesNo(43, "Home Team Score a Goal");
  const awayScore = findYesNo(44, "Away Team Score a Goal");

  const findPopularScore = () => {
    const local = popularScoreFromBet(betByIdOrName(bm, 10, "Exact Score"));
    if (local) return local;
    for (const idPref of PREFERRED_BOOKMAKER_IDS) {
      const other = bookmakers.find((b) => b.id === idPref);
      if (!other || other.id === bm.id) continue;
      const hit = popularScoreFromBet(betByIdOrName(other, 10, "Exact Score"));
      if (hit) return hit;
    }
    for (const other of bookmakers) {
      if (other.id === bm.id) continue;
      const hit = popularScoreFromBet(betByIdOrName(other, 10, "Exact Score"));
      if (hit) return hit;
    }
    return null;
  };

  return {
    home,
    draw,
    away,
    bookmaker: bm.name,
    ...probs,
    homeCsOdd: homeCs?.odd ?? null,
    awayCsOdd: awayCs?.odd ?? null,
    homeCsProb: homeCs?.prob ?? null,
    awayCsProb: awayCs?.prob ?? null,
    homeScoreOdd: homeScore?.odd ?? null,
    awayScoreOdd: awayScore?.odd ?? null,
    homeScoreProb: homeScore?.prob ?? null,
    awayScoreProb: awayScore?.prob ?? null,
    popularScore: findPopularScore(),
  };
}

/** @deprecated alias for tests / older imports */
export function parse1x2(bookmakers: af.AfOddsBookmaker[]): ParsedOdds | null {
  return parseFixtureOdds(bookmakers);
}

export async function syncLeagueFixturesAndOdds(
  leagueId = config.leagueId,
  season = config.predictSeason,
): Promise<{
  fixtures: number;
  odds: number;
  withCs: number;
  withScore: number;
  withPopularScore: number;
}> {
  const db = getDb();
  const now = new Date().toISOString();

  console.log(`AF fixtures league=${leagueId} season=${season}…`);
  const fxRes = await af.fixtures(leagueId, season);
  const upsertFx = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season, is_preseason, home_goals, away_goals)
     VALUES
       (@id, @date, @round, @home_team_id, @away_team_id, @status, @league_id, @season, 0, @home_goals, @away_goals)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       round = excluded.round,
       home_team_id = excluded.home_team_id,
       away_team_id = excluded.away_team_id,
       status = excluded.status,
       league_id = excluded.league_id,
       season = excluded.season,
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals`,
  );
  const fxTx = db.transaction((rows: af.AfFixture[]) => {
    for (const r of rows) {
      upsertFx.run({
        id: r.fixture.id,
        date: r.fixture.date,
        round: r.league.round ?? null,
        home_team_id: r.teams.home.id,
        away_team_id: r.teams.away.id,
        status: r.fixture.status.short,
        league_id: leagueId,
        season,
        home_goals: r.goals.home,
        away_goals: r.goals.away,
      });
    }
  });
  fxTx(fxRes.response ?? []);
  console.log(`  fixtures: ${fxRes.response?.length ?? 0}`);

  console.log(`AF odds (1x2+CS+team score+exact) league=${leagueId} season=${season}…`);
  const oddsRows = await af.oddsForLeague(leagueId, season);
  const upsertOdds = db.prepare(
    `INSERT INTO fixture_odds (
       fixture_id, league_id, season, kickoff,
       home_odd, draw_odd, away_odd, bookmaker,
       home_win_prob, draw_prob, away_win_prob,
       home_cs_odd, away_cs_odd, home_cs_prob, away_cs_prob,
       home_score_odd, away_score_odd, home_score_prob, away_score_prob,
       popular_score, synced_at
     ) VALUES (
       @fixture_id, @league_id, @season, @kickoff,
       @home_odd, @draw_odd, @away_odd, @bookmaker,
       @home_win_prob, @draw_prob, @away_win_prob,
       @home_cs_odd, @away_cs_odd, @home_cs_prob, @away_cs_prob,
       @home_score_odd, @away_score_odd, @home_score_prob, @away_score_prob,
       @popular_score, @synced_at
     )
     ON CONFLICT(fixture_id) DO UPDATE SET
       league_id = excluded.league_id,
       season = excluded.season,
       kickoff = excluded.kickoff,
       home_odd = excluded.home_odd,
       draw_odd = excluded.draw_odd,
       away_odd = excluded.away_odd,
       bookmaker = excluded.bookmaker,
       home_win_prob = excluded.home_win_prob,
       draw_prob = excluded.draw_prob,
       away_win_prob = excluded.away_win_prob,
       home_cs_odd = excluded.home_cs_odd,
       away_cs_odd = excluded.away_cs_odd,
       home_cs_prob = excluded.home_cs_prob,
       away_cs_prob = excluded.away_cs_prob,
       home_score_odd = excluded.home_score_odd,
       away_score_odd = excluded.away_score_odd,
       home_score_prob = excluded.home_score_prob,
       away_score_prob = excluded.away_score_prob,
       popular_score = excluded.popular_score,
       synced_at = excluded.synced_at`,
  );

  let oddsN = 0;
  let withCs = 0;
  let withScore = 0;
  let withPopularScore = 0;
  const oddsTx = db.transaction((rows: af.AfOddsRow[]) => {
    for (const r of rows) {
      const parsed = parseFixtureOdds(r.bookmakers ?? []);
      if (!parsed) continue;
      upsertOdds.run({
        fixture_id: r.fixture.id,
        league_id: leagueId,
        season,
        kickoff: r.fixture.date,
        home_odd: parsed.home,
        draw_odd: parsed.draw,
        away_odd: parsed.away,
        bookmaker: parsed.bookmaker,
        home_win_prob: parsed.homeWinProb,
        draw_prob: parsed.drawProb,
        away_win_prob: parsed.awayWinProb,
        home_cs_odd: parsed.homeCsOdd,
        away_cs_odd: parsed.awayCsOdd,
        home_cs_prob: parsed.homeCsProb,
        away_cs_prob: parsed.awayCsProb,
        home_score_odd: parsed.homeScoreOdd,
        away_score_odd: parsed.awayScoreOdd,
        home_score_prob: parsed.homeScoreProb,
        away_score_prob: parsed.awayScoreProb,
        popular_score: parsed.popularScore,
        synced_at: now,
      });
      oddsN++;
      if (parsed.homeCsProb != null || parsed.awayCsProb != null) withCs++;
      if (parsed.homeScoreProb != null || parsed.awayScoreProb != null) withScore++;
      if (parsed.popularScore) withPopularScore++;
    }
  });
  oddsTx(oddsRows);
  console.log(
    `  odds: ${oddsN}/${oddsRows.length} (CS ${withCs}, team-score ${withScore}, exact ${withPopularScore})`,
  );

  setMeta(`fixtures_${leagueId}_${season}`, String(fxRes.response?.length ?? 0));
  setMeta(`odds_${leagueId}_${season}`, String(oddsN));
  invalidateComputed(PREMIUM_ODDS_JOIN_CACHE_KEY, { database: db, persist: true });
  return {
    fixtures: fxRes.response?.length ?? 0,
    odds: oddsN,
    withCs,
    withScore,
    withPopularScore,
  };
}
