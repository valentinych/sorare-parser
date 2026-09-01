import { getDb } from "../db/index.js";

export type XiSlot = {
  slot: string;
  position: "GK" | "DEF" | "MID" | "ATT";
  playerId: number;
  playerName: string;
  starts: number;
  startShare: number;
};

export type PredictedXi = {
  teamId: number;
  teamName: string;
  formation: string;
  formationShare: number;
  matchesSampled: number;
  confidence: number;
  xi: XiSlot[];
};

const FORMATION_NEEDS: Record<string, { GK: number; DEF: number; MID: number; ATT: number }> = {
  "4-3-3": { GK: 1, DEF: 4, MID: 3, ATT: 3 },
  "4-2-3-1": { GK: 1, DEF: 4, MID: 5, ATT: 1 },
  "4-4-2": { GK: 1, DEF: 4, MID: 4, ATT: 2 },
  "3-5-2": { GK: 1, DEF: 3, MID: 5, ATT: 2 },
  "3-4-3": { GK: 1, DEF: 3, MID: 4, ATT: 3 },
  "5-3-2": { GK: 1, DEF: 5, MID: 3, ATT: 2 },
  "4-1-4-1": { GK: 1, DEF: 4, MID: 5, ATT: 1 },
  "4-5-1": { GK: 1, DEF: 4, MID: 5, ATT: 1 },
};

function parseFormationNeeds(formation: string) {
  if (FORMATION_NEEDS[formation]) return FORMATION_NEEDS[formation];
  const parts = formation.split("-").map(Number);
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
    return { GK: 1, DEF: 4, MID: 3, ATT: 3 };
  }
  // last group = attackers, first groups = defenders then midfielders
  const DEF = parts[0] ?? 4;
  const ATT = parts[parts.length - 1] ?? 3;
  const MID = parts.slice(1, -1).reduce((a, b) => a + b, 0) || 3;
  return { GK: 1, DEF, MID, ATT };
}

export function predictedXi(teamId: number): PredictedXi | null {
  const db = getDb();
  const team = db.prepare(`SELECT id, name FROM teams WHERE id = ?`).get(teamId) as
    | { id: number; name: string }
    | undefined;
  if (!team) return null;

  const matchCountRow = db
    .prepare(
      `SELECT COUNT(DISTINCT fixture_id) AS n
       FROM lineup_appearances
       WHERE team_id = ? AND is_starter = 1`,
    )
    .get(teamId) as { n: number };
  const matchesSampled = matchCountRow.n;
  if (matchesSampled === 0) {
    return {
      teamId: team.id,
      teamName: team.name,
      formation: "unknown",
      formationShare: 0,
      matchesSampled: 0,
      confidence: 0,
      xi: [],
    };
  }

  const formations = db
    .prepare(
      `SELECT formation, COUNT(DISTINCT fixture_id) AS n
       FROM lineup_appearances
       WHERE team_id = ? AND is_starter = 1 AND formation IS NOT NULL AND formation != ''
       GROUP BY formation
       ORDER BY n DESC`,
    )
    .all(teamId) as Array<{ formation: string; n: number }>;

  const topFormation = formations[0]?.formation ?? "4-3-3";
  const formationShare = (formations[0]?.n ?? 0) / matchesSampled;
  const needs = parseFormationNeeds(topFormation);

  const starters = db
    .prepare(
      `SELECT player_id AS playerId, player_name AS playerName, position,
              COUNT(*) AS starts
       FROM lineup_appearances
       WHERE team_id = ? AND is_starter = 1
       GROUP BY player_id, player_name, position
       ORDER BY starts DESC`,
    )
    .all(teamId) as Array<{
    playerId: number;
    playerName: string;
    position: string | null;
    starts: number;
  }>;

  const byPos: Record<"GK" | "DEF" | "MID" | "ATT", typeof starters> = {
    GK: [],
    DEF: [],
    MID: [],
    ATT: [],
  };

  for (const s of starters) {
    const pos = (s.position as "GK" | "DEF" | "MID" | "ATT") || "MID";
    if (byPos[pos]) byPos[pos].push(s);
  }

  const used = new Set<number>();
  const xi: XiSlot[] = [];

  const pick = (position: "GK" | "DEF" | "MID" | "ATT", count: number, slotPrefix: string) => {
    let taken = 0;
    for (const s of byPos[position]) {
      if (used.has(s.playerId)) continue;
      used.add(s.playerId);
      taken++;
      xi.push({
        slot: `${slotPrefix}${taken}`,
        position,
        playerId: s.playerId,
        playerName: s.playerName,
        starts: s.starts,
        startShare: Number((s.starts / matchesSampled).toFixed(3)),
      });
      if (taken >= count) break;
    }
  };

  pick("GK", needs.GK, "GK");
  pick("DEF", needs.DEF, "DEF");
  pick("MID", needs.MID, "MID");
  pick("ATT", needs.ATT, "ATT");

  // fill remaining XI slots from any leftover starters if formation buckets were short
  const needTotal = needs.GK + needs.DEF + needs.MID + needs.ATT;
  if (xi.length < needTotal) {
    for (const s of starters) {
      if (used.has(s.playerId)) continue;
      used.add(s.playerId);
      const position = (s.position as XiSlot["position"]) || "MID";
      xi.push({
        slot: `FLEX${xi.length + 1}`,
        position,
        playerId: s.playerId,
        playerName: s.playerName,
        starts: s.starts,
        startShare: Number((s.starts / matchesSampled).toFixed(3)),
      });
      if (xi.length >= needTotal) break;
    }
  }

  const avgShare =
    xi.length === 0 ? 0 : xi.reduce((a, s) => a + s.startShare, 0) / xi.length;
  const confidence = Number((0.5 * formationShare + 0.5 * avgShare).toFixed(3));

  return {
    teamId: team.id,
    teamName: team.name,
    formation: topFormation,
    formationShare: Number(formationShare.toFixed(3)),
    matchesSampled,
    confidence,
    xi,
  };
}

export function allPredictedXi(): PredictedXi[] {
  const teams = getDb().prepare(`SELECT id FROM teams ORDER BY name`).all() as Array<{ id: number }>;
  return teams.map((t) => predictedXi(t.id)).filter((x): x is PredictedXi => x !== null);
}
