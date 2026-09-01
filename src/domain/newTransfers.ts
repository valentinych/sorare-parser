import { config } from "../config.js";
import { getDb } from "../db/index.js";

export type NewTransferInfo = {
  isNew: boolean;
  joinedAt: string | null;
};

/**
 * TM clubAssignments.start is contract start (includes renewals).
 * Treat as new arrival when start is in the summer window and debut is
 * missing, also in-window, or within ~90d of start (loan→permanent).
 */
export function isNewTransfer(
  joinedAt: string | null | undefined,
  debut: string | null | undefined,
  windowStart = config.preseasonFrom,
): boolean {
  if (!joinedAt || joinedAt < windowStart) return false;
  if (!debut) return true;
  if (debut >= windowStart) return true;
  const startMs = Date.parse(joinedAt);
  const debutMs = Date.parse(debut);
  if (!Number.isFinite(startMs) || !Number.isFinite(debutMs)) return true;
  return (startMs - debutMs) / 86_400_000 <= 90;
}

/** AF player_id → new-transfer flag from TM clubAssignments at mapped club. */
export function loadAfNewTransferMap(
  windowStart = config.preseasonFrom,
): Map<number, NewTransferInfo> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pv.af_player_id AS afPlayerId,
              json_extract(sp.raw_json, '$.clubAssignments[0].start') AS joinedAt,
              json_extract(sp.raw_json, '$.clubAssignments[0].debut') AS debut
       FROM player_values pv
       JOIN tm_club_map m ON m.af_team_id = pv.team_id
       JOIN tm_squad_players sp
         ON sp.player_id = pv.tm_player_id AND sp.club_id = m.tm_club_id
       WHERE pv.af_player_id IS NOT NULL
         AND json_extract(sp.raw_json, '$.clubAssignments[0].start') IS NOT NULL`,
    )
    .all() as Array<{
    afPlayerId: number;
    joinedAt: string | null;
    debut: string | null;
  }>;

  const map = new Map<number, NewTransferInfo>();
  for (const r of rows) {
    const joinedAt = r.joinedAt || null;
    const isNew = isNewTransfer(joinedAt, r.debut, windowStart);
    const prev = map.get(r.afPlayerId);
    if (!prev || (isNew && !prev.isNew)) {
      map.set(r.afPlayerId, { isNew, joinedAt });
    }
  }
  return map;
}
