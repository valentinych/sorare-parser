/**
 * Mantra clean sheet: no goals conceded while the player was on the pitch.
 * Official rules: at least 60' (enforced in scorePlayer) + on-pitch CS.
 * Sending-off: outfield needs a full-time team CS; GK red card never gets CS.
 */

export type CleanSheetEvent = {
  idx: number;
  type: string;
  time: number | null;
  overloadTime: number | null;
  isHome: boolean | null;
  ownGoal: boolean;
  playerInId: number | null;
  playerOutId: number | null;
};

export type CleanSheetPlayer = {
  phase: string;
  isHome: boolean;
  playerId: number;
  starter: boolean;
  minutes: number | null;
  redCards: number;
  isGk: boolean;
  /** Goals the club conceded at FT (or current live score). */
  concededFt: number | null;
  events: CleanSheetEvent[];
};

function asId(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** FotMob swap[0] = on, swap[1] = off. */
export function parseCleanSheetEvent(
  row: {
    event_idx?: number;
    type: string;
    time: number | null;
    overload_time?: number | null;
    overloadTime?: number | null;
    is_home?: number | null;
    isHome?: boolean | number | null;
    raw_json: string | null;
  },
  idx: number,
): CleanSheetEvent {
  let ownGoal = false;
  let playerInId: number | null = null;
  let playerOutId: number | null = null;
  if (row.raw_json) {
    try {
      const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
      ownGoal = Boolean(raw.ownGoal);
      const swap = Array.isArray(raw.swap) ? (raw.swap as Array<Record<string, unknown>>) : [];
      playerInId = asId(swap[0]?.id);
      playerOutId = asId(swap[1]?.id);
    } catch {
      /* ignore bad json */
    }
  }
  const isHomeRaw = row.isHome ?? row.is_home;
  return {
    idx: row.event_idx ?? idx,
    type: row.type,
    time: row.time,
    overloadTime: row.overloadTime ?? row.overload_time ?? null,
    isHome: isHomeRaw == null ? null : Boolean(isHomeRaw),
    ownGoal,
    playerInId,
    playerOutId,
  };
}

function clock(time: number | null, overload: number | null): number {
  if (time == null || !Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return time * 100 + (overload != null && Number.isFinite(overload) ? overload : 0);
}

/** FotMob `isHome` is the beneficiary (who the goal is awarded to), including OGs. */
export function goalConcededBySide(e: CleanSheetEvent, isHome: boolean): boolean {
  if (e.type !== "Goal") return false;
  return e.isHome === !isHome;
}

function onOffBySubs(
  playerId: number,
  starter: boolean,
  events: CleanSheetEvent[],
): { onIdx: number; offIdx: number } | null {
  let onIdx: number | null = starter ? -1 : null;
  let offIdx = Number.POSITIVE_INFINITY;
  for (const e of events) {
    if (e.type !== "Substitution") continue;
    if (e.playerInId === playerId) onIdx = e.idx;
    if (e.playerOutId === playerId) offIdx = e.idx;
  }
  if (onIdx == null && offIdx !== Number.POSITIVE_INFINITY) onIdx = -1;
  if (onIdx == null) return null;
  return { onIdx, offIdx };
}

function concededBetweenIdx(
  events: CleanSheetEvent[],
  isHome: boolean,
  onIdx: number,
  offIdx: number,
): boolean {
  for (const e of events) {
    if (!goalConcededBySide(e, isHome)) continue;
    if (e.idx > onIdx && e.idx < offIdx) return true;
  }
  return false;
}

function concededInClockWindow(
  events: CleanSheetEvent[],
  isHome: boolean,
  on: number,
  off: number,
): boolean {
  for (const e of events) {
    if (!goalConcededBySide(e, isHome)) continue;
    const c = clock(e.time, e.overloadTime);
    if (c > on && c <= off) return true;
  }
  return false;
}

/**
 * True if the club conceded no goals while this player was on the pitch.
 * Does not check minutes — scorePlayer still requires ≥60.
 */
export function onPitchCleanSheet(p: CleanSheetPlayer): boolean {
  if (p.phase === "upcoming") return false;
  if (p.isGk && p.redCards > 0) return false;
  const ft = p.concededFt;
  if (p.redCards > 0) return ft === 0;

  if (!p.events.length) return ft === 0;

  const window = onOffBySubs(p.playerId, p.starter, p.events);
  if (window) {
    const { onIdx, offIdx } = window;
    if (offIdx === Number.POSITIVE_INFINITY && p.starter && p.minutes != null && p.minutes < 90) {
      return !concededInClockWindow(p.events, p.isHome, 0, p.minutes * 100);
    }
    return !concededBetweenIdx(p.events, p.isHome, onIdx, offIdx);
  }

  const mins = p.minutes ?? 0;
  if (p.starter || mins >= 90) {
    const off = mins > 0 && mins < 90 ? mins * 100 : Number.POSITIVE_INFINITY;
    return !concededInClockWindow(p.events, p.isHome, 0, off);
  }
  if (mins > 0) {
    const on = Math.max(0, (90 - mins) * 100);
    return !concededInClockWindow(p.events, p.isHome, on, Number.POSITIVE_INFINITY);
  }
  return ft === 0;
}
