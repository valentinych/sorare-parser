/**
 * Bookmaker win probability per club for upcoming / current / selected round fixtures.
 */
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { namesMatch, normName } from "../lib/names.js";

export type TeamMatchOdds = {
  fixtureId: number;
  kickoff: string | null;
  isHome: boolean;
  opponentName: string;
  opponentId: number;
  winProb: number;
  drawProb: number;
  loseProb: number;
  winOdd: number;
  drawOdd: number;
  loseOdd: number;
  /** Bookmaker P(team keeps a clean sheet). */
  cleanSheetProb: number | null;
  cleanSheetOdd: number | null;
  /** Bookmaker P(team scores ≥1) — proxy for attacking upside when player props missing. */
  teamScoreProb: number | null;
  teamScoreOdd: number | null;
  bookmaker: string | null;
  round: string | null;
  /** Parsed Mantra/AF round number from "Regular Season - N". */
  roundNum: number | null;
  status: string | null;
};

export type PredictRoundInfo = {
  round: number;
  afRound: string;
  label: string;
  fixtureCount: number;
  oddsCount: number;
  /** True if any fixture is finished (FT/AET/PEN) or FotMob round is finished. */
  played: boolean;
  /** True if any fixture still NS/TBD/1H/HT/2H/LIVE. */
  upcoming: boolean;
  kickoffMin: string | null;
  kickoffMax: string | null;
};

type OddsJoinRow = {
  fixture_id: number;
  kickoff: string | null;
  home_odd: number;
  draw_odd: number;
  away_odd: number;
  bookmaker: string | null;
  home_win_prob: number;
  draw_prob: number;
  away_win_prob: number;
  home_cs_odd: number | null;
  away_cs_odd: number | null;
  home_cs_prob: number | null;
  away_cs_prob: number | null;
  home_score_odd: number | null;
  away_score_odd: number | null;
  home_score_prob: number | null;
  away_score_prob: number | null;
  home_team_id: number;
  away_team_id: number;
  round: string | null;
  status: string | null;
  home_name: string | null;
  away_name: string | null;
};

const FINISHED = new Set(["FT", "AET", "PEN", "CANC", "PST", "ABD"]);

/** Parse "Regular Season - 12" / "12" → 12. */
export function parseAfRoundNum(round: string | null | undefined): number | null {
  if (round == null || round === "") return null;
  const m = String(round).match(/(\d+)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function afRoundLabel(roundNum: number): string {
  return `Regular Season - ${roundNum}`;
}

function rowToOdds(r: OddsJoinRow, isHome: boolean): TeamMatchOdds {
  return {
    fixtureId: r.fixture_id,
    kickoff: r.kickoff,
    isHome,
    opponentName: isHome
      ? r.away_name || `#${r.away_team_id}`
      : r.home_name || `#${r.home_team_id}`,
    opponentId: isHome ? r.away_team_id : r.home_team_id,
    winProb: isHome ? r.home_win_prob : r.away_win_prob,
    drawProb: r.draw_prob,
    loseProb: isHome ? r.away_win_prob : r.home_win_prob,
    winOdd: isHome ? r.home_odd : r.away_odd,
    drawOdd: r.draw_odd,
    loseOdd: isHome ? r.away_odd : r.home_odd,
    cleanSheetProb: isHome ? r.home_cs_prob : r.away_cs_prob,
    cleanSheetOdd: isHome ? r.home_cs_odd : r.away_cs_odd,
    teamScoreProb: isHome ? r.home_score_prob : r.away_score_prob,
    teamScoreOdd: isHome ? r.home_score_odd : r.away_score_odd,
    bookmaker: r.bookmaker,
    round: r.round,
    roundNum: parseAfRoundNum(r.round),
    status: r.status,
  };
}

/**
 * Win probs keyed by AF team id.
 * - No round: first unfinished fixture per team (legacy default).
 * - With round: that AF round's fixture (includes finished — odds stay for history).
 */
export function teamWinProbsById(
  leagueId = config.leagueId,
  season = config.predictSeason,
  roundNum?: number | null,
): Map<number, TeamMatchOdds> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.fixture_id, o.kickoff, o.home_odd, o.draw_odd, o.away_odd, o.bookmaker,
              o.home_win_prob, o.draw_prob, o.away_win_prob,
              o.home_cs_odd, o.away_cs_odd, o.home_cs_prob, o.away_cs_prob,
              o.home_score_odd, o.away_score_odd, o.home_score_prob, o.away_score_prob,
              f.home_team_id, f.away_team_id, f.round, f.status,
              th.name AS home_name, ta.name AS away_name
       FROM fixture_odds o
       JOIN fixtures f ON f.id = o.fixture_id
       LEFT JOIN season_teams th
         ON th.team_id = f.home_team_id AND th.season = o.season
            AND (th.league_id = o.league_id OR th.league_id IS NULL)
       LEFT JOIN season_teams ta
         ON ta.team_id = f.away_team_id AND ta.season = o.season
            AND (ta.league_id = o.league_id OR ta.league_id IS NULL)
       WHERE o.league_id = ? AND o.season = ?
       ORDER BY o.kickoff ASC`,
    )
    .all(leagueId, season) as OddsJoinRow[];

  const want =
    roundNum != null && Number.isFinite(roundNum) ? Number(roundNum) : null;
  const byTeam = new Map<number, TeamMatchOdds>();

  for (const r of rows) {
    const rn = parseAfRoundNum(r.round);
    if (want != null) {
      if (rn !== want) continue;
    } else {
      const status = (r.status || "").toUpperCase();
      if (FINISHED.has(status)) continue;
    }

    const home = rowToOdds(r, true);
    const away = rowToOdds(r, false);
    if (!byTeam.has(r.home_team_id)) byTeam.set(r.home_team_id, home);
    if (!byTeam.has(r.away_team_id)) byTeam.set(r.away_team_id, away);
  }
  return byTeam;
}

export function matchOddsForClubName(
  clubName: string,
  leagueId = config.leagueId,
  season = config.predictSeason,
  roundNum?: number | null,
): TeamMatchOdds | null {
  if (!clubName) return null;
  const byId = teamWinProbsById(leagueId, season, roundNum);
  const db = getDb();
  const teams = db
    .prepare(
      `SELECT team_id AS id, name FROM season_teams
       WHERE season = ? AND (league_id = ? OR (league_id IS NULL AND ? = 106))`,
    )
    .all(season, leagueId, leagueId) as Array<{ id: number; name: string }>;

  const n = normName(clubName);
  let best: { id: number; score: number } | null = null;
  for (const t of teams) {
    const tn = normName(t.name);
    let score = 0;
    if (tn === n) score = 100;
    else if (namesMatch(clubName, t.name)) score = 80;
    else if (n.includes(tn) || tn.includes(n)) score = 50;
    if (score > 0 && (!best || score > best.score)) best = { id: t.id, score };
  }
  if (!best) return null;
  return byId.get(best.id) ?? null;
}

/** Default predict round: next unfinished AF round, else live FotMob round. */
export function defaultPredictRound(
  leagueId = config.leagueId,
  season = config.predictSeason,
): number | null {
  const db = getDb();
  const next = db
    .prepare(
      `SELECT round FROM fixtures
       WHERE league_id = ? AND season = ?
         AND status NOT IN ('FT','AET','PEN','CANC','PST','ABD')
         AND round LIKE 'Regular Season - %'
       ORDER BY date ASC
       LIMIT 1`,
    )
    .get(leagueId, season) as { round: string | null } | undefined;
  const nextN = parseAfRoundNum(next?.round ?? null);
  if (nextN != null) return nextN;

  const live = db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'live_round'`)
    .get() as { value: string } | undefined;
  return parseAfRoundNum(live?.value);
}

/** AF regular-season rounds with odds / played flags for the Round selector. */
export function listPredictRounds(
  leagueId = config.leagueId,
  season = config.predictSeason,
): PredictRoundInfo[] {
  const db = getDb();
  const fx = db
    .prepare(
      `SELECT f.round,
              COUNT(*) AS fixture_count,
              SUM(CASE WHEN o.fixture_id IS NOT NULL THEN 1 ELSE 0 END) AS odds_count,
              SUM(CASE WHEN UPPER(COALESCE(f.status,'')) IN ('FT','AET','PEN') THEN 1 ELSE 0 END) AS finished_n,
              SUM(CASE WHEN UPPER(COALESCE(f.status,'')) IN ('NS','TBD','1H','HT','2H','LIVE','ET','P','BT')
                       OR f.status IS NULL THEN 1 ELSE 0 END) AS open_n,
              MIN(COALESCE(o.kickoff, f.date)) AS kickoff_min,
              MAX(COALESCE(o.kickoff, f.date)) AS kickoff_max
       FROM fixtures f
       LEFT JOIN fixture_odds o ON o.fixture_id = f.id
       WHERE f.league_id = ? AND f.season = ?
         AND f.round LIKE 'Regular Season - %'
       GROUP BY f.round`,
    )
    .all(leagueId, season) as Array<{
    round: string;
    fixture_count: number;
    odds_count: number;
    finished_n: number;
    open_n: number;
    kickoff_min: string | null;
    kickoff_max: string | null;
  }>;

  const fotmobFinished = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT round FROM fotmob_matches
           WHERE phase = 'finished' AND round GLOB '[0-9]*'`,
        )
        .all() as Array<{ round: string }>
    ).map((r) => Number(r.round)),
  );

  const out: PredictRoundInfo[] = [];
  for (const r of fx) {
    const n = parseAfRoundNum(r.round);
    if (n == null) continue;
    const played = r.finished_n > 0 || fotmobFinished.has(n);
    out.push({
      round: n,
      afRound: r.round,
      label: `Тур ${n}`,
      fixtureCount: r.fixture_count,
      oddsCount: r.odds_count,
      played,
      upcoming: r.open_n > 0 && !played,
      kickoffMin: r.kickoff_min,
      kickoffMax: r.kickoff_max,
    });
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}
