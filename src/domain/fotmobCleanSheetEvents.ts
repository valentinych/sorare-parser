import { getDb } from "../db/index.js";
import {
  parseCleanSheetEvent,
  type CleanSheetEvent,
} from "../lib/playerCleanSheet.js";

/** Goal + substitution events for on-pitch clean sheets, keyed by FotMob match id. */
export function loadCleanSheetEventsByMatch(matchIds: number[]): Map<number, CleanSheetEvent[]> {
  const out = new Map<number, CleanSheetEvent[]>();
  const uniq = [...new Set(matchIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (!uniq.length) return out;

  const placeholders = uniq.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT match_id, event_idx, type, time, overload_time, is_home, raw_json
       FROM fotmob_match_events
       WHERE match_id IN (${placeholders})
         AND type IN ('Goal', 'Substitution')
       ORDER BY match_id, event_idx`,
    )
    .all(...uniq) as Array<{
    match_id: number;
    event_idx: number;
    type: string;
    time: number | null;
    overload_time: number | null;
    is_home: number | null;
    raw_json: string | null;
  }>;

  for (const row of rows) {
    const ev = parseCleanSheetEvent(row, row.event_idx);
    const list = out.get(row.match_id);
    if (list) list.push(ev);
    else out.set(row.match_id, [ev]);
  }
  return out;
}
