/**
 * Premium form score 0.00–10.00 (hundredths).
 *
 * Combines season minutes, recent XI regularity, FotMob avg, Mantra TS.
 * SofaScore is not used. Missing ratings/TS score 0, not a fake 10.
 * OUT / 0-min / long DNP streak is scaled down by availability.
 */

export const FORM_SCORE_VERSION = "v1";

export const FORM_SCORE_WEIGHTS = {
  minutes: 0.25,
  starts: 0.3,
  fotmob: 0.25,
  ts: 0.2,
} as const;

export const FORM_SCORE_WINDOW = 6;
export const FORM_SCORE_RECENCY_DECAY = 0.85;

/** FotMob 5.5 → 0, 8.5 → 1 (typical season avgs sit ~6.5–7.3). */
export const FOTMOB_SCORE_FLOOR = 5.5;
export const FOTMOB_SCORE_SPAN = 3;

/** Mantra TS 5.0 → 0, 9.0 → 1 (base ~6, bonuses push 7–9). */
export const TS_SCORE_FLOOR = 5;
export const TS_SCORE_SPAN = 4;

export type FormScoreMinutesCell = {
  minutes: number | null;
  starter: boolean | null;
};

export type FormScoreInput = {
  totalMinutes: number;
  clubTours: number;
  minutesByTour: FormScoreMinutesCell[];
  ratingAvg: number | null;
  mantraTsAvg: number | null;
  lastStreakZero?: number;
  unavailable?: boolean;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function roundFormScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(10, Math.round(value * 100) / 100);
}

export function lastZeroStreak(cells: FormScoreMinutesCell[]): number {
  let streak = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const minutes = cells[i]?.minutes;
    if (minutes == null) continue;
    if (minutes === 0) streak += 1;
    else break;
  }
  return streak;
}

function recentKnown(
  cells: FormScoreMinutesCell[],
): Array<{ minutes: number; starter: boolean }> {
  const known: Array<{ minutes: number; starter: boolean }> = [];
  for (let i = cells.length - 1; i >= 0 && known.length < FORM_SCORE_WINDOW; i--) {
    const cell = cells[i];
    if (cell == null || cell.minutes == null) continue;
    known.push({ minutes: cell.minutes, starter: Boolean(cell.starter) });
  }
  return known;
}

/** Volume: share of 90' × club tours with a match sheet. */
export function minutesComponent(totalMinutes: number, clubTours: number): number {
  if (!(clubTours > 0) || !(totalMinutes > 0)) return 0;
  return clamp01(totalMinutes / (90 * clubTours));
}

/**
 * Recent XI regularity: last ≤6 sheet tours, most recent first.
 * Starter = full recency weight; sub appearance = 0.35; DNP = 0.
 * Decay 0.85^i so a current run of starts beats an old pile of XI minutes.
 */
export function startRegularityComponent(cells: FormScoreMinutesCell[]): number {
  const recent = recentKnown(cells);
  if (!recent.length) return 0;
  let contrib = 0;
  let max = 0;
  for (let i = 0; i < recent.length; i++) {
    const weight = FORM_SCORE_RECENCY_DECAY ** i;
    max += weight;
    const row = recent[i]!;
    if (row.starter && row.minutes > 0) contrib += weight;
    else if (row.minutes > 0) contrib += weight * 0.35;
  }
  return max > 0 ? clamp01(contrib / max) : 0;
}

export function ratingComponent(avg: number | null | undefined): number {
  if (avg == null || !Number.isFinite(avg)) return 0;
  return clamp01((avg - FOTMOB_SCORE_FLOOR) / FOTMOB_SCORE_SPAN);
}

export function tsComponent(avg: number | null | undefined): number {
  if (avg == null || !Number.isFinite(avg)) return 0;
  return clamp01((avg - TS_SCORE_FLOOR) / TS_SCORE_SPAN);
}

export function availabilityFactor(input: {
  totalMinutes: number;
  lastStreakZero: number;
  unavailable?: boolean;
}): number {
  if (!(input.totalMinutes > 0)) return 0;
  let factor = 1;
  if (input.lastStreakZero >= 3) factor = 0.12;
  else if (input.lastStreakZero === 2) factor = 0.3;
  else if (input.lastStreakZero === 1) factor = 0.65;
  if (input.unavailable) factor = Math.min(factor, 0.2);
  return factor;
}

export function premiumFormScore(input: FormScoreInput): number {
  const clubTours = Math.max(0, Math.floor(input.clubTours) || 0);
  const totalMinutes = Number.isFinite(input.totalMinutes) ? Math.max(0, input.totalMinutes) : 0;
  const streak =
    input.lastStreakZero != null
      ? input.lastStreakZero
      : lastZeroStreak(input.minutesByTour || []);
  const availability = availabilityFactor({
    totalMinutes,
    lastStreakZero: streak,
    unavailable: input.unavailable,
  });
  if (availability <= 0) return 0;

  const raw =
    FORM_SCORE_WEIGHTS.minutes * minutesComponent(totalMinutes, clubTours) +
    FORM_SCORE_WEIGHTS.starts * startRegularityComponent(input.minutesByTour || []) +
    FORM_SCORE_WEIGHTS.fotmob * ratingComponent(input.ratingAvg) +
    FORM_SCORE_WEIGHTS.ts * tsComponent(input.mantraTsAvg);

  return roundFormScore(10 * raw * availability);
}
