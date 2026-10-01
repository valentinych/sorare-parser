import { classifyPenaltyEvent } from "../clients/fotmob.js";
import { getDb } from "../db/index.js";

export type PenaltyRow = {
  match_id: number;
  player_id: number;
  penalties_scored: number | null;
  penalties_missed: number | null;
  penalties_saved?: number | null;
  is_home?: number | boolean | null;
  saves?: number | null;
};

type StoredPenaltyEvent = {
  match_id: number;
  player_id: number;
  type: string;
  is_home: number | null;
  raw_json: string | null;
};

function parseRaw(rawJson: string | null): unknown {
  if (!rawJson) return {};
  try {
    return JSON.parse(rawJson);
  } catch {
    return {};
  }
}

function sideHome(value: number | boolean | null | undefined): boolean | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  return Number(value) !== 0;
}

function eventKickerHome(e: StoredPenaltyEvent): boolean | null {
  const fromCol = sideHome(e.is_home);
  if (fromCol != null) return fromCol;
  const raw = parseRaw(e.raw_json) as { isHome?: unknown };
  if (raw && typeof raw === "object" && raw.isHome != null) {
    return sideHome(raw.isHome as number | boolean);
  }
  return null;
}

function loadGkFotmobIds(): Set<number> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT fotmob_player_id AS id FROM mantra_players
         WHERE fotmob_player_id IS NOT NULL
           AND positions_json LIKE '%GK%'`,
      )
      .all() as Array<{ id: number }>;
    return new Set(rows.map((row) => row.id));
  } catch {
    return new Set();
  }
}

/**
 * MissedPenalty is the kicker's miss/save. Mantra +3 goes to the opposing GK
 * (saves≥1, or a linked Mantra GK). A wide miss with no identifiable GK is skipped.
 */
export function applyMissedPenaltySavesToRows(
  events: StoredPenaltyEvent[],
  rows: PenaltyRow[],
  gkFotmobIds: Set<number> = new Set(),
): void {
  const savesByMatchSide = new Map<string, PenaltyRow[]>();
  for (const row of rows) {
    const home = sideHome(row.is_home);
    if (home == null) continue;
    const key = `${row.match_id}:${home ? 1 : 0}`;
    const list = savesByMatchSide.get(key) ?? [];
    list.push(row);
    savesByMatchSide.set(key, list);
  }

  const extra = new Map<string, number>();
  for (const e of events) {
    const raw = parseRaw(e.raw_json);
    const kind = classifyPenaltyEvent({
      type: e.type,
      playerId: e.player_id,
      ownGoal: Boolean((raw as { ownGoal?: unknown }).ownGoal),
      raw,
    });
    if (kind !== "missed") continue;
    const kickerHome =
      eventKickerHome(e) ??
      sideHome(
        rows.find((row) => row.match_id === e.match_id && row.player_id === e.player_id)
          ?.is_home,
      );
    if (kickerHome == null) continue;
    const gkHome = kickerHome ? 0 : 1;
    const side = savesByMatchSide.get(`${e.match_id}:${gkHome}`) ?? [];
    const gks = side
      .filter((row) => (row.saves ?? 0) > 0 || gkFotmobIds.has(row.player_id))
      .sort(
        (a, b) => (b.saves ?? 0) - (a.saves ?? 0) || a.player_id - b.player_id,
      );
    const gk = gks[0];
    if (!gk) continue;
    const k = `${gk.match_id}:${gk.player_id}`;
    extra.set(k, (extra.get(k) ?? 0) + 1);
  }
  for (const row of rows) {
    const n = extra.get(`${row.match_id}:${row.player_id}`);
    if (!n) continue;
    row.penalties_saved = Math.max(row.penalties_saved ?? 0, n);
  }
}

/** Apply stored FotMob events onto player pen columns (same idea as YC/RC overlay). */
export function overlayPenaltiesFromStoredEvents(
  rows: PenaltyRow[],
  fotmobLeagueId: number,
): void {
  if (!rows.length) return;
  const events = getDb()
    .prepare(
      `SELECT e.match_id, e.player_id, e.type, e.is_home, e.raw_json
       FROM fotmob_match_events e
       JOIN fotmob_matches m ON m.id = e.match_id
       WHERE m.league_id = ?
         AND e.player_id IS NOT NULL
         AND e.type IN ('MissedPenalty', 'Goal')`,
    )
    .all(fotmobLeagueId) as StoredPenaltyEvent[];
  const counts = new Map<string, { scored: number; missed: number }>();
  for (const e of events) {
    const raw = parseRaw(e.raw_json);
    const kind = classifyPenaltyEvent({
      type: e.type,
      playerId: e.player_id,
      ownGoal: Boolean((raw as { ownGoal?: unknown }).ownGoal),
      raw,
    });
    if (!kind) continue;
    const k = `${e.match_id}:${e.player_id}`;
    const cur = counts.get(k) ?? { scored: 0, missed: 0 };
    cur[kind] += 1;
    counts.set(k, cur);
  }
  for (const row of rows) {
    const adj = counts.get(`${row.match_id}:${row.player_id}`);
    if (!adj) continue;
    row.penalties_missed = Math.max(row.penalties_missed ?? 0, adj.missed);
    row.penalties_scored = Math.max(row.penalties_scored ?? 0, adj.scored);
  }
  applyMissedPenaltySavesToRows(events, rows, loadGkFotmobIds());
}
