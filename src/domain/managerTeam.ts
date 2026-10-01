/**
 * Fantasy-manager view: owned Mantra roster + ideal Mantra XI.
 * Score ≈ board/FotMob + bookmaker P(win)/CS/goal-action + R-1 appearance + XI probability.
 * Slot fill: native Mantra positions only (no OoP) so roles stay clear.
 */
import { getDb } from "../db/index.js";
import {
  ALL_FORMATIONS,
  FORMATION_SLOTS,
  layoutFormation,
  playerFitsSlot,
  type FormationSlot,
} from "../lib/mantraFormations.js";
import { config } from "../config.js";
import { buildPlayerBoard } from "./playerBoard.js";
import { loadScoutMd1 } from "./scoutIdealXi.js";
import {
  defaultPredictRound,
  listPredictRounds,
  matchOddsForClubName,
  type PredictRoundInfo,
  type TeamMatchOdds,
} from "./matchWinProb.js";
import { namesMatch, normName } from "../lib/names.js";
import {
  scorePlayer,
  type PlayerMatchStats,
} from "../lib/mantraScoring.js";

export type ManagerRosterPlayer = {
  mantraId: number;
  name: string;
  fullName: string;
  clubName: string;
  positions: string[];
  positionsItal: string[];
  avatarPath: string | null;
  clubLogo: string | null;
  averagePrice: number | null;
  baseScore: number;
  totalScore: number;
  boardRating: number | null;
  afPlayerId: number | null;
  afTeamName: string | null;
  marketValueEur: number | null;
  inClubIdealXi: boolean;
  idealSlot: string | null;
  /** Bookmaker de-vigged P(club wins in selected round). */
  winProb: number | null;
  drawProb: number | null;
  winOdd: number | null;
  /** Bookmaker P(club clean sheet) for selected round. */
  cleanSheetProb: number | null;
  cleanSheetOdd: number | null;
  /**
   * Attacking proxy: P(club scores ≥1) from bookmaker, or player anytime scorer
   * when AF exposes it (not available for Ekstraklasa).
   */
  goalActionProb: number | null;
  goalActionOdd: number | null;
  matchLabel: string | null;
  bookmaker: string | null;
  kickoff: string | null;
  fixtureId: number | null;
  afRound: string | null;
  /** FotMob rating for the selected round (if played). */
  fotmobRating: number | null;
  /** Minutes in selected round (if played). */
  roundMinutes: number | null;
  /** Mantra fantasy points for selected round (native role approx). */
  roundMantraPts: number | null;
  /** Minutes in previous finished round (R-1) — used for upcoming XI form. */
  prevRoundMinutes: number | null;
  /** True if club had a finished FotMob match in R-1 (for DNP detection). */
  prevRoundClubPlayed: boolean;
  /** Effective selection score used for XI pick. */
  selectionScore: number;
};

export type ManagerIdealSlot = {
  label: string;
  x: number;
  y: number;
  native: boolean;
  malus: number;
  player: ManagerRosterPlayer;
  effectiveScore: number;
};

export type ManagerIdealXi = {
  formation: string;
  formationLabel: string;
  filled: number;
  totalSlots: number;
  avgScore: number | null;
  totalScore: number;
  avgWinProb: number | null;
  slots: ManagerIdealSlot[];
  bench: ManagerRosterPlayer[];
  reason: string;
};

export type ManagerTeamView = {
  team: {
    id: number;
    name: string;
    code: string | null;
    logoPath: string | null;
    leagueId: number;
    leagueName: string | null;
    tournamentId: number | null;
    budget: number | null;
    syncedAt: string | null;
  };
  /** Selected Mantra/AF round number. */
  round: number | null;
  afRound: string | null;
  roundPlayed: boolean;
  rounds: PredictRoundInfo[];
  roster: ManagerRosterPlayer[];
  squadFormations: Array<{
    formation: string;
    slots: Array<{
      label: string;
      accepted: readonly string[];
      x: number;
      y: number;
      index: number;
    }>;
  }>;
  /** Best Mantra formation by score. */
  idealXi: ManagerIdealXi;
  /** All fully-fieldable Mantra formations (for scheme picker). */
  formations: ManagerIdealXi[];
};

export type SquadBuilderTeamView = {
  team: ManagerTeamView["team"];
  roster: Array<
    Pick<
      ManagerRosterPlayer,
      | "mantraId"
      | "name"
      | "fullName"
      | "clubName"
      | "positions"
      | "positionsItal"
      | "avatarPath"
      | "clubLogo"
    >
  >;
  squadFormations: ManagerTeamView["squadFormations"];
};

type FantasyTeamRow = {
  id: number;
  league_id: number;
  tournament_id: number | null;
  name: string;
  code: string | null;
  logo_path: string | null;
  budget: number | null;
  players_json: string;
  synced_at: string | null;
  league_name: string | null;
};

type FotmobRoundRow = {
  player_id: number;
  name: string;
  team_name: string;
  is_home: number;
  rating: number | null;
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  own_goals: number | null;
  saves: number | null;
  goals_conceded: number | null;
  penalties_won: number | null;
  penalties_conceded: number | null;
  penalties_scored: number | null;
  penalties_missed: number | null;
  penalties_saved: number | null;
  phase: string;
  score_home: number | null;
  score_away: number | null;
};

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[]).map((x) => String(x)).filter(Boolean);
  } catch {
    return [];
  }
}

function parseIdArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function squadFormationDefinitions(): ManagerTeamView["squadFormations"] {
  return ALL_FORMATIONS.map((formation) => ({
    formation,
    slots: layoutFormation(formation).map((slot) => ({
      label: slot.slot.label,
      accepted: slot.slot.accepted,
      x: slot.x,
      y: slot.y,
      index: slot.index,
    })),
  }));
}

function scoutIdealNames(): Set<string> {
  const set = new Set<string>();
  for (const t of loadScoutMd1().teams) {
    for (const s of t.xi) set.add(normName(s.name));
  }
  return set;
}

function playerInScoutIdeal(name: string, scoutNames: Set<string>): boolean {
  const n = normName(name);
  if (scoutNames.has(n)) return true;
  for (const sn of scoutNames) {
    if (namesMatch(n, sn)) return true;
  }
  return false;
}

function clubsRoughMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb || namesMatch(a, b)) return true;
  if (na.includes(nb) || nb.includes(na)) {
    // Avoid Kraków⊂Raków / Wisła↔Wieczysta style false positives on short tokens.
    const short = na.length < nb.length ? na : nb;
    if (short.length >= 5) return true;
  }
  return false;
}

function loadFotmobRoundPool(roundNum: number, opts?: { allRows?: boolean }): FotmobRoundRow[] {
  const allRows = opts?.allRows === true;
  return getDb()
    .prepare(
      `SELECT p.player_id, p.name, p.team_name, p.is_home,
              p.rating, p.minutes, p.goals, p.assists, p.yellow_cards, p.red_cards,
              p.own_goals, p.saves, p.goals_conceded,
              p.penalties_won, p.penalties_conceded, p.penalties_scored,
              p.penalties_missed, p.penalties_saved,
              m.phase, m.score_home, m.score_away
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.round = ?
         AND (
           ? = 1
           OR (p.minutes IS NOT NULL AND p.minutes > 0)
           OR p.rating IS NOT NULL
           OR COALESCE(p.goals, 0) > 0
         )`,
    )
    .all(String(roundNum), allRows ? 1 : 0) as FotmobRoundRow[];
}

/** Clubs that have a finished (or any) FotMob match in this round. */
function fotmobClubsPlayed(roundNum: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT home_name AS name FROM fotmob_matches WHERE round = ? AND phase = 'finished'
       UNION
       SELECT DISTINCT away_name AS name FROM fotmob_matches WHERE round = ? AND phase = 'finished'`,
    )
    .all(String(roundNum), String(roundNum)) as Array<{ name: string | null }>;
  return new Set(rows.map((r) => r.name).filter(Boolean) as string[]);
}

function clubInSet(clubName: string, clubs: Set<string>): boolean {
  if (!clubName || !clubs.size) return false;
  for (const c of clubs) {
    if (clubsRoughMatch(clubName, c)) return true;
  }
  return false;
}

function toStats(row: FotmobRoundRow): PlayerMatchStats {
  return {
    rating: row.rating,
    minutes: row.minutes,
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    yellowCards: row.yellow_cards ?? 0,
    redCards: row.red_cards ?? 0,
    ownGoals: row.own_goals ?? 0,
    saves: row.saves ?? 0,
    goalsConceded: row.goals_conceded ?? 0,
    penaltiesScored: row.penalties_scored ?? 0,
    penaltiesMissed: row.penalties_missed ?? 0,
    penaltiesSaved: row.penalties_saved ?? 0,
    penaltiesWon: row.penalties_won ?? 0,
    penaltiesConceded: row.penalties_conceded ?? 0,
    appeared: true,
  };
}

function roundMantraPts(
  positions: string[],
  row: FotmobRoundRow,
): number | null {
  if (!positions.length) return null;
  const cs =
    row.phase !== "upcoming" &&
    (row.is_home ? row.score_away : row.score_home) === 0;
  const bd = scorePlayer({
    native: positions,
    slotAccepted: positions,
    stats: toStats(row),
    teamCleanSheet: Boolean(cs && (row.minutes ?? 0) >= 60),
  });
  return bd ? Number(bd.total.toFixed(2)) : null;
}

function attachOdds(
  clubName: string,
  afLeagueId: number,
  roundNum: number | null,
): Partial<ManagerRosterPlayer> {
  const odds: TeamMatchOdds | null = matchOddsForClubName(
    clubName,
    afLeagueId,
    config.predictSeason,
    roundNum,
  );
  if (!odds) {
    return {
      winProb: null,
      drawProb: null,
      winOdd: null,
      cleanSheetProb: null,
      cleanSheetOdd: null,
      goalActionProb: null,
      goalActionOdd: null,
      matchLabel: null,
      bookmaker: null,
      kickoff: null,
      fixtureId: null,
      afRound: null,
    };
  }
  const ha = odds.isHome ? "H" : "A";
  return {
    winProb: odds.winProb,
    drawProb: odds.drawProb,
    winOdd: odds.winOdd,
    cleanSheetProb: odds.cleanSheetProb,
    cleanSheetOdd: odds.cleanSheetOdd,
    goalActionProb: odds.teamScoreProb,
    goalActionOdd: odds.teamScoreOdd,
    matchLabel: `${ha} vs ${odds.opponentName}`,
    bookmaker: odds.bookmaker,
    kickoff: odds.kickoff,
    fixtureId: odds.fixtureId,
    afRound: odds.round,
  };
}

type BuildOpts = {
  leagueId: number;
  roundNum: number | null;
  roundPlayed: boolean;
};

function emptyPlayer(id: number): ManagerRosterPlayer {
  return {
    mantraId: id,
    name: `#${id}`,
    fullName: `#${id}`,
    clubName: "",
    positions: [],
    positionsItal: [],
    avatarPath: null,
    clubLogo: null,
    averagePrice: null,
    baseScore: 0,
    totalScore: 0,
    boardRating: null,
    afPlayerId: null,
    afTeamName: null,
    marketValueEur: null,
    inClubIdealXi: false,
    idealSlot: null,
    winProb: null,
    drawProb: null,
    winOdd: null,
    cleanSheetProb: null,
    cleanSheetOdd: null,
    goalActionProb: null,
    goalActionOdd: null,
    matchLabel: null,
    bookmaker: null,
    kickoff: null,
    fixtureId: null,
    afRound: null,
    fotmobRating: null,
    roundMinutes: null,
    roundMantraPts: null,
    prevRoundMinutes: null,
    prevRoundClubPlayed: false,
    selectionScore: 20,
  };
}

function buildRoster(playerIds: number[], opts: BuildOpts): ManagerRosterPlayer[] {
  if (!playerIds.length) return [];
  const db = getDb();
  const placeholders = playerIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, fotmob_player_id, name, first_name, full_name, positions_json, positions_ital_json,
              club_name, club_logo, avatar_path, average_price, base_score, total_score
       FROM mantra_players
       WHERE id IN (${placeholders})`,
    )
    .all(...playerIds) as Array<{
    id: number;
    fotmob_player_id: number | null;
    name: string;
    first_name: string | null;
    full_name: string | null;
    positions_json: string | null;
    positions_ital_json: string | null;
    club_name: string | null;
    club_logo: string | null;
    avatar_path: string | null;
    average_price: number | null;
    base_score: number | null;
    total_score: number | null;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const board = buildPlayerBoard(config.predictSeason, opts.leagueId);
  const boardByMantra = new Map<number, (typeof board)[number]>();
  for (const p of board) {
    if (p.mantra?.id != null) boardByMantra.set(p.mantra.id, p);
  }
  const scoutNames = scoutIdealNames();
  const clubIdealSlots = new Map<number, string>();
  for (const p of board) {
    if (p.xiStatus === "starter" && p.mantra?.id != null) {
      clubIdealSlots.set(p.mantra.id, p.xiSlot ?? p.role ?? "XI");
    }
  }

  const fotmobPool =
    opts.roundNum != null ? loadFotmobRoundPool(opts.roundNum) : [];
  const fotmobById = new Map(fotmobPool.map((player) => [player.player_id, player]));
  const prevRoundNum =
    !opts.roundPlayed && opts.roundNum != null && opts.roundNum > 1
      ? opts.roundNum - 1
      : null;
  const prevPool =
    prevRoundNum != null ? loadFotmobRoundPool(prevRoundNum, { allRows: true }) : [];
  const prevById = new Map(prevPool.map((player) => [player.player_id, player]));
  const prevClubsPlayed =
    prevRoundNum != null ? fotmobClubsPlayed(prevRoundNum) : new Set<string>();

  const oddsCache = new Map<string, Partial<ManagerRosterPlayer>>();
  const out: ManagerRosterPlayer[] = [];
  for (const id of playerIds) {
    const r = byId.get(id);
    if (!r) {
      out.push(emptyPlayer(id));
      continue;
    }
    const bp = boardByMantra.get(id);
    const name = r.full_name || [r.first_name, r.name].filter(Boolean).join(" ") || r.name;
    const clubName = r.club_name ?? bp?.teamName ?? "";
    const positions = parseJsonArray(r.positions_json);
    const inClubIdealXi =
      clubIdealSlots.has(id) ||
      playerInScoutIdeal(name, scoutNames) ||
      playerInScoutIdeal(r.name, scoutNames);
    let odds = oddsCache.get(clubName);
    if (!odds) {
      odds = attachOdds(clubName, opts.leagueId, opts.roundNum);
      oddsCache.set(clubName, odds);
    }

    const fm =
      r.fotmob_player_id != null
        ? fotmobById.get(r.fotmob_player_id) ?? null
        : null;
    const fotmobRating = fm?.rating ?? null;
    const roundMinutes = fm?.minutes ?? null;
    const mantraPts = fm ? roundMantraPts(positions, fm) : null;

    const prevFm =
      r.fotmob_player_id != null
        ? prevById.get(r.fotmob_player_id) ?? null
        : null;
    const prevRoundClubPlayed = clubInSet(clubName, prevClubsPlayed);
    let prevRoundMinutes: number | null = null;
    if (prevFm) {
      prevRoundMinutes = prevFm.minutes ?? 0;
    } else if (prevRoundClubPlayed) {
      prevRoundMinutes = 0;
    }

    const player: ManagerRosterPlayer = {
      mantraId: id,
      name: r.name,
      fullName: name,
      clubName,
      positions,
      positionsItal: parseJsonArray(r.positions_ital_json),
      avatarPath: r.avatar_path,
      clubLogo: r.club_logo,
      averagePrice: r.average_price,
      baseScore: Number(r.base_score) || 0,
      totalScore: Number(r.total_score) || 0,
      boardRating: bp?.rating ?? null,
      afPlayerId: bp?.playerId ?? null,
      afTeamName: bp?.teamName ?? null,
      marketValueEur: bp?.marketValueEur ?? null,
      inClubIdealXi,
      idealSlot: clubIdealSlots.get(id) ?? null,
      winProb: odds.winProb ?? null,
      drawProb: odds.drawProb ?? null,
      winOdd: odds.winOdd ?? null,
      cleanSheetProb: odds.cleanSheetProb ?? null,
      cleanSheetOdd: odds.cleanSheetOdd ?? null,
      goalActionProb: odds.goalActionProb ?? null,
      goalActionOdd: odds.goalActionOdd ?? null,
      matchLabel: odds.matchLabel ?? null,
      bookmaker: odds.bookmaker ?? null,
      kickoff: odds.kickoff ?? null,
      fixtureId: odds.fixtureId ?? null,
      afRound: odds.afRound ?? null,
      fotmobRating,
      roundMinutes,
      roundMantraPts: mantraPts,
      prevRoundMinutes,
      prevRoundClubPlayed,
      selectionScore: 0,
    };
    player.selectionScore = playerScore(player, opts.roundPlayed);
    out.push(player);
  }
  return out;
}

const CS_POSITIONS = new Set(["GK", "CB", "RB", "LB", "WB", "DM"]);
const GOAL_POSITIONS = new Set(["AM", "W", "FW", "ST"]);

/**
 * Selection score for round R:
 * - base: board rating → else Mantra season score → else price → else 20
 * - if round played: lock base to Mantra pts×10 or FotMob rating×8
 * - + winProb×25 (bookmaker P(win) for club fixture in R)
 * - + XI probability: scout/club ideal (+8), or minutes when played
 * - upcoming: appearanceBoost from R-1 minutes (starter +10 / cameo +2 / DNP −15)
 * - + propBoost: CS prob×18 for defence, team-score/goal-action×14 for attack
 */
function playerScore(p: ManagerRosterPlayer, roundPlayed: boolean): number {
  let base = 20;
  if (p.boardRating != null && p.boardRating > 0) base = p.boardRating;
  else if (p.totalScore > 0) base = p.totalScore * 10;
  else if (p.averagePrice != null && p.averagePrice > 0) base = Math.min(55, p.averagePrice / 2);

  if (roundPlayed) {
    if (p.roundMantraPts != null) base = p.roundMantraPts * 10;
    else if (p.fotmobRating != null && p.fotmobRating > 0) base = p.fotmobRating * 8;
    else if (p.roundMinutes === 0 || (p.roundMinutes == null && p.fotmobRating == null)) {
      // No appearance — heavily discount vs board quality alone
      base = Math.min(base, 25);
    }
  }

  const win = p.winProb != null ? p.winProb : 0.33;
  const winBoost = win * 25;

  let xiBoost = p.inClubIdealXi ? 8 : 0;
  if (roundPlayed && p.roundMinutes != null) {
    if (p.roundMinutes >= 60) xiBoost = Math.max(xiBoost, 8);
    else if (p.roundMinutes > 0) xiBoost = Math.max(xiBoost, 3);
    else xiBoost = 0;
  }

  let appearanceBoost = 0;
  if (!roundPlayed && p.prevRoundClubPlayed) {
    const mins = p.prevRoundMinutes;
    if (mins != null && mins >= 60) appearanceBoost = 10;
    else if (mins != null && mins > 0) appearanceBoost = 2;
    else {
      // Did not start / no minutes in R-1 — strong penalty unless ideal XI softens it
      appearanceBoost = p.inClubIdealXi ? -8 : -15;
    }
  }

  let propBoost = 0;
  const hasCs = p.positions.some((pos) => CS_POSITIONS.has(pos));
  const hasGoal = p.positions.some((pos) => GOAL_POSITIONS.has(pos));
  if (hasCs && p.cleanSheetProb != null) propBoost += p.cleanSheetProb * 18;
  if (hasGoal && p.goalActionProb != null) propBoost += p.goalActionProb * 14;
  if (!hasCs && !hasGoal && p.goalActionProb != null) {
    // CM and other midfield — mild team-score signal
    propBoost += p.goalActionProb * 8;
  }

  return Number((base + winBoost + xiBoost + appearanceBoost + propBoost).toFixed(1));
}

type Tentative = {
  formation: string;
  slots: Array<{
    slot: FormationSlot;
    x: number;
    y: number;
    player: ManagerRosterPlayer;
    native: boolean;
    malus: number;
    effectiveScore: number;
  }>;
  totalScore: number;
  filled: number;
};

/** Native Mantra fit only — no OoP, so slot labels stay meaningful. */
function fillFormation(formation: string, roster: ManagerRosterPlayer[]): Tentative | null {
  const slots = FORMATION_SLOTS[formation];
  if (!slots?.length) return null;
  const layout = layoutFormation(formation);
  const used = new Set<number>();
  const filled: Tentative["slots"] = [];
  let total = 0;

  // Fill rarest slots first (Din8sty / xPts style).
  const order = slots
    .map((slot, i) => {
      const n = roster.filter((p) => playerFitsSlot(p.positions, slot).native).length;
      return { i, n };
    })
    .sort((a, b) => a.n - b.n || a.i - b.i);

  const byIndex = new Map<number, Tentative["slots"][number]>();

  for (const { i } of order) {
    const slot = slots[i]!;
    const lay = layout[i] ?? { x: 50, y: 50, slot, index: i };
    let best: {
      player: ManagerRosterPlayer;
      effective: number;
    } | null = null;

    for (const p of roster) {
      if (used.has(p.mantraId)) continue;
      const fit = playerFitsSlot(p.positions, slot);
      if (!fit.native) continue;
      const effective = p.selectionScore;
      if (!best || effective > best.effective) best = { player: p, effective };
    }
    if (!best) continue;
    used.add(best.player.mantraId);
    total += best.effective;
    byIndex.set(i, {
      slot,
      x: lay.x,
      y: lay.y,
      player: best.player,
      native: true,
      malus: 0,
      effectiveScore: best.effective,
    });
  }

  for (let i = 0; i < slots.length; i++) {
    const row = byIndex.get(i);
    if (row) filled.push(row);
  }

  return {
    formation,
    slots: filled,
    totalScore: total,
    filled: filled.length,
  };
}

function toIdealXi(cand: Tentative, roster: ManagerRosterPlayer[], reason: string): ManagerIdealXi {
  const starterIds = new Set(cand.slots.map((s) => s.player.mantraId));
  const bench = roster
    .filter((p) => !starterIds.has(p.mantraId))
    .sort(
      (a, b) =>
        b.selectionScore - a.selectionScore ||
        (b.winProb ?? -1) - (a.winProb ?? -1) ||
        (b.boardRating ?? -1) - (a.boardRating ?? -1),
    );
  const avg =
    cand.filled > 0 ? Number((cand.totalScore / cand.filled).toFixed(1)) : null;
  const winVals = cand.slots
    .map((s) => s.player.winProb)
    .filter((x): x is number => x != null);
  const avgWin =
    winVals.length > 0
      ? Number((winVals.reduce((a, b) => a + b, 0) / winVals.length).toFixed(3))
      : null;
  return {
    formation: cand.formation,
    formationLabel: cand.formation,
    filled: cand.filled,
    totalSlots: 11,
    avgScore: avg,
    totalScore: Number(cand.totalScore.toFixed(1)),
    avgWinProb: avgWin,
    slots: cand.slots.map((s) => ({
      label: s.slot.label,
      x: s.x,
      y: s.y,
      native: s.native,
      malus: s.malus,
      player: s.player,
      effectiveScore: Number(s.effectiveScore.toFixed(1)),
    })),
    bench,
    reason,
  };
}

function emptyIdeal(roster: ManagerRosterPlayer[]): ManagerIdealXi {
  return {
    formation: "—",
    formationLabel: "—",
    filled: 0,
    totalSlots: 11,
    avgScore: null,
    totalScore: 0,
    avgWinProb: null,
    slots: [],
    bench: roster.slice(),
    reason: "Недостаточно игроков с родными Mantra-позициями под схему",
  };
}

function pickIdealFormations(
  roster: ManagerRosterPlayer[],
  roundPlayed: boolean,
): {
  best: ManagerIdealXi;
  all: ManagerIdealXi[];
} {
  const reason = roundPlayed
    ? "Тур сыгран · Mantra/FotMob очки + P(win) букмекеров · родные позиции"
    : "Прогноз тура · рейтинг + P(win) букмекеров · шанс в XI клуба";
  const all: ManagerIdealXi[] = [];
  for (const f of ALL_FORMATIONS) {
    const cand = fillFormation(f, roster);
    if (!cand || cand.filled < 11) continue;
    all.push(toIdealXi(cand, roster, reason));
  }
  all.sort((a, b) => b.totalScore - a.totalScore || (b.avgWinProb ?? 0) - (a.avgWinProb ?? 0));

  if (!all.length) {
    let bestPartial: Tentative | null = null;
    for (const f of ALL_FORMATIONS) {
      const cand = fillFormation(f, roster);
      if (!cand) continue;
      if (
        !bestPartial ||
        cand.filled > bestPartial.filled ||
        (cand.filled === bestPartial.filled && cand.totalScore > bestPartial.totalScore)
      ) {
        bestPartial = cand;
      }
    }
    if (!bestPartial) {
      const empty = emptyIdeal(roster);
      return { best: empty, all: [] };
    }
    const partial = toIdealXi(
      bestPartial,
      roster,
      `Заполнено ${bestPartial.filled}/11 родными позициями`,
    );
    return { best: partial, all: [partial] };
  }

  return { best: all[0]!, all };
}

export function listFantasyTeams(opts: {
  tournamentId?: number;
  leagueId?: number;
  managerId?: number;
}): Array<{
  id: number;
  name: string;
  code: string | null;
  logoPath: string | null;
  leagueId: number;
  leagueName: string | null;
  playerCount: number;
}> {
  const db = getDb();
  const clauses: string[] = [];
  const params: number[] = [];
  if (opts.leagueId != null) {
    clauses.push("t.league_id = ?");
    params.push(opts.leagueId);
  }
  if (opts.tournamentId != null) {
    clauses.push("(t.tournament_id = ? OR (t.tournament_id IS NULL AND ? = 18))");
    params.push(opts.tournamentId, opts.tournamentId);
  }
  if (opts.managerId != null) {
    clauses.push("t.user_id = ?");
    params.push(opts.managerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.code, t.logo_path, t.league_id, t.players_json, l.name AS league_name
       FROM mantra_fantasy_teams t
       LEFT JOIN mantra_leagues l ON l.id = t.league_id
       ${where}
       ORDER BY l.division, l.name, t.name`,
    )
    .all(...params) as Array<{
    id: number;
    name: string;
    code: string | null;
    logo_path: string | null;
    league_id: number;
    players_json: string;
    league_name: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    logoPath: r.logo_path,
    leagueId: r.league_id,
    leagueName: r.league_name,
    playerCount: parseIdArray(r.players_json).length,
  }));
}

const MANTRA_IMAGE_ORIGIN = "https://mantrafootball.s3.eu-west-1.amazonaws.com";
const MANTRA_IMAGE_PATHS = [
  "/player_avatars/",
  "/club_logo/",
  "/teams/",
  "/user_logos/",
];

/** Same-origin proxy URL for mantrafootball S3 photos; null if the path is missing or not Mantra. */
export function squadBuilderImageUrl(path: string | null | undefined): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  if (trimmed.startsWith("/mantra/image")) return trimmed;
  try {
    const url = new URL(trimmed, `${MANTRA_IMAGE_ORIGIN}/`);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mantrafootball.s3.eu-west-1.amazonaws.com" ||
      url.port ||
      url.username ||
      url.password ||
      !MANTRA_IMAGE_PATHS.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      return null;
    }
    return `/mantra/image?url=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}

export function getSquadBuilderTeamView(
  fantasyTeamId: number,
): SquadBuilderTeamView | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*, l.name AS league_name
       FROM mantra_fantasy_teams t
       LEFT JOIN mantra_leagues l ON l.id = t.league_id
       WHERE t.id = ?`,
    )
    .get(fantasyTeamId) as FantasyTeamRow | undefined;
  if (!row) return null;

  const playerIds = parseIdArray(row.players_json);
  const players = playerIds.length
    ? (db
        .prepare(
          `SELECT id, name, first_name, full_name, positions_json, positions_ital_json,
                  club_name, club_logo, avatar_path
           FROM mantra_players
           WHERE id IN (${playerIds.map(() => "?").join(",")})`,
        )
        .all(...playerIds) as Array<{
        id: number;
        name: string;
        first_name: string | null;
        full_name: string | null;
        positions_json: string | null;
        positions_ital_json: string | null;
        club_name: string | null;
        club_logo: string | null;
        avatar_path: string | null;
      }>)
    : [];
  const byId = new Map(players.map((player) => [player.id, player]));

  return {
    team: {
      id: row.id,
      name: row.name,
      code: row.code,
      logoPath: row.logo_path,
      leagueId: row.league_id,
      leagueName: row.league_name,
      tournamentId: row.tournament_id,
      budget: row.budget,
      syncedAt: row.synced_at,
    },
    roster: playerIds.flatMap((id) => {
      const player = byId.get(id);
      if (!player) return [];
      return [
        {
          mantraId: player.id,
          name: player.name,
          fullName:
            player.full_name ||
            [player.first_name, player.name].filter(Boolean).join(" ") ||
            player.name,
          clubName: player.club_name || "",
          positions: parseJsonArray(player.positions_json),
          positionsItal: parseJsonArray(player.positions_ital_json),
          avatarPath: squadBuilderImageUrl(player.avatar_path),
          clubLogo: squadBuilderImageUrl(player.club_logo) ?? player.club_logo,
        },
      ];
    }),
    squadFormations: squadFormationDefinitions(),
  };
}

export function getManagerTeamView(
  fantasyTeamId: number,
  afLeagueId = 106,
  round?: number | null,
): ManagerTeamView | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*, l.name AS league_name
       FROM mantra_fantasy_teams t
       LEFT JOIN mantra_leagues l ON l.id = t.league_id
       WHERE t.id = ?`,
    )
    .get(fantasyTeamId) as FantasyTeamRow | undefined;
  if (!row) return null;

  const rounds = listPredictRounds(afLeagueId, config.predictSeason);
  const roundNum =
    round != null && Number.isFinite(round)
      ? Number(round)
      : defaultPredictRound(afLeagueId, config.predictSeason);
  const roundMeta = roundNum != null ? rounds.find((r) => r.round === roundNum) : undefined;
  const roundPlayed = Boolean(roundMeta?.played);

  const playerIds = parseIdArray(row.players_json);
  const roster = buildRoster(playerIds, {
    leagueId: afLeagueId,
    roundNum,
    roundPlayed,
  });
  roster.sort(
    (a, b) =>
      b.selectionScore - a.selectionScore ||
      (b.winProb ?? -1) - (a.winProb ?? -1) ||
      (b.boardRating ?? -1) - (a.boardRating ?? -1) ||
      a.name.localeCompare(b.name),
  );
  const { best, all } = pickIdealFormations(roster, roundPlayed);

  return {
    team: {
      id: row.id,
      name: row.name,
      code: row.code,
      logoPath: row.logo_path,
      leagueId: row.league_id,
      leagueName: row.league_name,
      tournamentId: row.tournament_id,
      budget: row.budget,
      syncedAt: row.synced_at,
    },
    round: roundNum,
    afRound: roundMeta?.afRound ?? (roundNum != null ? `Regular Season - ${roundNum}` : null),
    roundPlayed,
    rounds,
    roster,
    squadFormations: squadFormationDefinitions(),
    idealXi: best,
    formations: all,
  };
}
