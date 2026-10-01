/**
 * MantraFootball scoring rules (Poland / FotMob source).
 * Ported from data-learning/mantra + official rules.
 */

export const MANTRA_SCORING = {
  goal: { ST: 2.0, FW: 2.0, AM: 2.5, W: 2.5, default: 3.0 } as Record<string, number>,
  assist: 1.0,
  /**
   * Not a stacked bonus. A scored penalty is already a goal (ST/FW +2).
   * `penaltiesScored` only switches the icon to ⚽🅿️.
   */
  penaltyScored: 0,
  penaltyEarned: 1.0,
  penaltySaved: 3.0,
  saves6plus: 1.0,
  saves3to5: 0.5,
  cleansheet: { GK: 1.5, CB: 1.0, RB: 1.0, LB: 1.0, WB: 0.5, DM: 0.5 } as Record<
    string,
    number
  >,
  yellowCard: -0.5,
  redCard: -2.0,
  redCardGk: -3.0,
  ownGoal: -2.0,
  goalConcededGk: -1.0,
  penaltyConceded: -1.0,
  penaltyMissed: -2.0,
  defaultBaseFotmob: 6.0,
} as const;

/** Bump when scorePlayer rules change so persisted live scores cannot serve old totals. */
export const MANTRA_SCORE_RULES_VERSION = "gk-pen-save-v2";

export const DEFENCE_BONUS_THRESHOLDS: Array<[number, number]> = [
  [8.0, 5],
  [7.75, 4],
  [7.5, 3],
  [7.25, 2],
  [7.0, 1],
];

export const GOALS_THRESHOLDS = { base: 72, step: 7 } as const;

/** Native position → slot position → malus (0 / -1.5 / -3). */
export const POSITION_MALUS: Record<string, Record<string, number>> = {
  GK: { GK: 0 },
  CB: { CB: 0, DM: -1.5, LB: -1.5, RB: -1.5, CM: -3 },
  LB: { LB: 0, CB: -1.5, WB: -1.5, RB: -1.5 },
  RB: { RB: 0, CB: -1.5, WB: -1.5, LB: -1.5 },
  WB: { WB: 0, LB: -1.5, RB: -1.5, W: -1.5, DM: -3, CM: -3 },
  DM: { DM: 0, CM: -1.5, CB: -1.5, WB: -3 },
  CM: { CM: 0, DM: -1.5, AM: -1.5, W: -3, WB: -3 },
  W: { W: 0, AM: -1.5, WB: -1.5, FW: -1.5, CM: -3 },
  AM: { AM: 0, W: -1.5, CM: -1.5, FW: -1.5 },
  FW: { FW: 0, ST: -1.5, W: -1.5, AM: -1.5 },
  ST: { ST: 0, FW: -1.5 },
};

export function goalBonusForNative(native: string[]): number {
  const set = new Set(native.map((p) => p.toUpperCase()));
  if (set.has("ST") || set.has("FW")) return MANTRA_SCORING.goal.ST;
  if (set.has("AM") || set.has("W")) return MANTRA_SCORING.goal.AM;
  return MANTRA_SCORING.goal.default;
}

/** Best (least negative) malus for native positions vs slot accepted positions. null = illegal. */
export function positionMalus(native: string[], slotAccepted: string[]): number | null {
  let best: number | null = null;
  for (const n of native) {
    const row = POSITION_MALUS[n.toUpperCase()];
    if (!row) continue;
    for (const s of slotAccepted) {
      const m = row[s.toUpperCase()];
      if (m == null) continue;
      if (best == null || m > best) best = m;
    }
  }
  return best;
}

export function defenceBonusFromBaseScores(baseScores: number[]): {
  avg: number;
  bonus: number;
} {
  if (!baseScores.length) return { avg: 0, bonus: 0 };
  const avg = baseScores.reduce((a, b) => a + b, 0) / baseScores.length;
  for (const [threshold, bonus] of DEFENCE_BONUS_THRESHOLDS) {
    if (avg >= threshold) return { avg, bonus };
  }
  return { avg, bonus: 0 };
}

export function fantasyGoalsFromTeamScore(total: number): number {
  if (total < GOALS_THRESHOLDS.base) return 0;
  return 1 + Math.floor((total - GOALS_THRESHOLDS.base) / GOALS_THRESHOLDS.step);
}

export type PlayerMatchStats = {
  rating: number | null;
  minutes: number | null;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  saves: number;
  goalsConceded: number;
  /** Scored penalties (subset of goals). Icon ⚽🅿️ — not extra points. */
  penaltiesScored: number;
  penaltiesMissed: number;
  penaltiesSaved: number;
  penaltiesWon: number;
  penaltiesConceded: number;
  appeared: boolean;
};

export type ScoreEvent = {
  key:
    | "goal"
    | "assist"
    | "pen"
    | "penWon"
    | "penSave"
    | "saves"
    | "cs"
    | "yc"
    | "rc"
    | "og"
    | "gc"
    | "penConc"
    | "penMiss"
    | "oop";
  count?: number;
  delta: number;
};

export type ScoreBreakdown = {
  base: number;
  bonuses: number;
  maluses: number;
  positionMalus: number;
  total: number;
  parts: string[];
  events: ScoreEvent[];
};

export function scorePlayer(opts: {
  native: string[];
  slotAccepted: string[];
  stats: PlayerMatchStats | null;
  /** Club conceded no goals while this player was on the pitch (not FT score). */
  teamCleanSheet: boolean;
}): ScoreBreakdown | null {
  const { native, slotAccepted, stats, teamCleanSheet } = opts;
  if (!stats?.appeared) return null;

  const oop = positionMalus(native, slotAccepted);
  if (oop == null) return null; // illegal slot — shouldn't happen for locked lineups

  const parts: string[] = [];
  const events: ScoreEvent[] = [];
  const base =
    stats.rating != null && Number.isFinite(stats.rating)
      ? Number(stats.rating)
      : MANTRA_SCORING.defaultBaseFotmob;
  parts.push(`base ${base.toFixed(2)}`);

  let bonuses = 0;
  let maluses = 0;
  const isGk = native.some((p) => p.toUpperCase() === "GK");

  const gb = goalBonusForNative(native);
  const penGoals = Math.min(stats.goals, stats.penaltiesScored);
  const openPlayGoals = Math.max(0, stats.goals - penGoals);
  if (stats.goals > 0) {
    const g = stats.goals * gb;
    bonuses += g;
    parts.push(`goal×${stats.goals} +${g}`);
  }
  if (openPlayGoals > 0) {
    events.push({ key: "goal", count: openPlayGoals, delta: openPlayGoals * gb });
  }
  if (penGoals > 0) {
    // Same incident as a goal — icon only, no extra penaltyScored points.
    events.push({ key: "pen", count: penGoals, delta: penGoals * gb });
  }
  if (stats.assists > 0) {
    const a = stats.assists * MANTRA_SCORING.assist;
    bonuses += a;
    parts.push(`ast×${stats.assists} +${a}`);
    events.push({ key: "assist", count: stats.assists, delta: a });
  }
  if (stats.penaltiesWon > 0) {
    const p = stats.penaltiesWon * MANTRA_SCORING.penaltyEarned;
    bonuses += p;
    parts.push(`penWon +${p}`);
    events.push({ key: "penWon", count: stats.penaltiesWon, delta: p });
  }
  if (isGk && stats.penaltiesSaved > 0) {
    const p = stats.penaltiesSaved * MANTRA_SCORING.penaltySaved;
    bonuses += p;
    parts.push(`penSave +${p}`);
    events.push({ key: "penSave", count: stats.penaltiesSaved, delta: p });
  }
  if (isGk && stats.saves >= 6) {
    bonuses += MANTRA_SCORING.saves6plus;
    parts.push(`saves6 +1`);
    events.push({ key: "saves", count: stats.saves, delta: MANTRA_SCORING.saves6plus });
  } else if (isGk && stats.saves >= 3) {
    bonuses += MANTRA_SCORING.saves3to5;
    parts.push(`saves3-5 +0.5`);
    events.push({ key: "saves", count: stats.saves, delta: MANTRA_SCORING.saves3to5 });
  }

  // Clean sheet: native ∩ module eligible, ≥60' (Mantra: at least 60), on-pitch CS
  const mins = stats.minutes ?? 0;
  if (teamCleanSheet && mins >= 60) {
    const nativeSet = new Set(native.map((p) => p.toUpperCase()));
    const slotSet = new Set(slotAccepted.map((p) => p.toUpperCase()));
    const csPositions = Object.keys(MANTRA_SCORING.cleansheet);
    const nativeCs = csPositions
      .filter((p) => nativeSet.has(p))
      .map((p) => MANTRA_SCORING.cleansheet[p]!);
    const slotCs = csPositions
      .filter((p) => slotSet.has(p))
      .map((p) => MANTRA_SCORING.cleansheet[p]!);
    if (nativeCs.length && slotCs.length) {
      const csBonus = Math.min(Math.max(...nativeCs), Math.max(...slotCs));
      bonuses += csBonus;
      parts.push(`CS +${csBonus}`);
      events.push({ key: "cs", delta: csBonus });
    }
  }

  if (stats.yellowCards > 0) {
    const y = stats.yellowCards * MANTRA_SCORING.yellowCard;
    maluses += y;
    parts.push(`YC ${y}`);
    events.push({ key: "yc", count: stats.yellowCards, delta: y });
  }
  if (stats.redCards > 0) {
    const r = stats.redCards * (isGk ? MANTRA_SCORING.redCardGk : MANTRA_SCORING.redCard);
    maluses += r;
    parts.push(`RC ${r}`);
    events.push({ key: "rc", count: stats.redCards, delta: r });
  }
  if (stats.ownGoals > 0) {
    const og = stats.ownGoals * MANTRA_SCORING.ownGoal;
    maluses += og;
    parts.push(`OG ${og}`);
    events.push({ key: "og", count: stats.ownGoals, delta: og });
  }
  if (isGk && stats.goalsConceded > 0) {
    const gc = stats.goalsConceded * MANTRA_SCORING.goalConcededGk;
    maluses += gc;
    parts.push(`GC ${gc}`);
    events.push({ key: "gc", count: stats.goalsConceded, delta: gc });
  }
  if (stats.penaltiesConceded > 0) {
    const p = stats.penaltiesConceded * MANTRA_SCORING.penaltyConceded;
    maluses += p;
    parts.push(`penConc ${p}`);
    events.push({ key: "penConc", count: stats.penaltiesConceded, delta: p });
  }
  if (stats.penaltiesMissed > 0) {
    const p = stats.penaltiesMissed * MANTRA_SCORING.penaltyMissed;
    maluses += p;
    parts.push(`penMiss ${p}`);
    events.push({ key: "penMiss", count: stats.penaltiesMissed, delta: p });
  }

  if (oop < 0) {
    maluses += oop;
    parts.push(`OoP ${oop}`);
    events.push({ key: "oop", delta: oop });
  }

  const total = base + bonuses + maluses;
  return {
    base,
    bonuses,
    maluses,
    positionMalus: oop,
    total,
    parts,
    events,
  };
}
