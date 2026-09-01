import { getDb } from "../db/index.js";
import {
  bestRoleFit,
  FORMATIONS,
  inferFormation,
  parseDetailRole,
  roleGroup,
  type FormationPlan,
  type Role,
} from "../lib/roles.js";
import { isNewTransfer } from "./newTransfers.js";
import type { RankedPlayer, SeasonPrediction, XiSlotWithBackup } from "./predictSeasonXi.js";

const ROLE_FILL_PRIORITY: Record<Role, number> = {
  GK: 0,
  LB: 1,
  RB: 2,
  CB: 3,
  LWB: 4,
  RWB: 5,
  DM: 10,
  CM: 11,
  AM: 12,
  LM: 13,
  RM: 14,
  LW: 20,
  RW: 21,
  SS: 22,
  ST: 23,
};

type TmSquadRow = {
  playerId: string;
  name: string;
  position: string | null;
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  marketValueEur: number | null;
  isCaptain: number;
};

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((v) => ((v - min) / (max - min)) * 100);
}

function parseSideRole(raw: string | null): Role | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  return parseDetailRole(first, first, null);
}

function resolveRole(row: TmSquadRow): { role: Role; label: string; side: Role | null } {
  const fromDetail = parseDetailRole(row.detailRole, row.detailLabel, null);
  const fromPos = parseDetailRole(row.position, row.position, row.position);
  const role = fromDetail ?? fromPos ?? "CM";
  const side = parseSideRole(row.sideRole);
  const label = row.detailLabel ?? row.detailRole ?? role;
  return { role, label, side };
}

function formationReason(plan: FormationPlan, roles: Role[]): string {
  const c = roles.reduce(
    (acc, r) => {
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const bits = [
    `CB×${c.CB ?? 0}`,
    `FB×${(c.LB ?? 0) + (c.RB ?? 0)}`,
    `DM×${c.DM ?? 0}`,
    `AM×${c.AM ?? 0}`,
    `W×${(c.LW ?? 0) + (c.RW ?? 0)}`,
    `ST×${(c.ST ?? 0) + (c.SS ?? 0)}`,
  ];
  return `inferred ${plan.code} from TM squad roles (${bits.join(", ")})`;
}

export function listTmXiTeams(competitionId: string) {
  return getDb()
    .prepare(
      `SELECT cl.id, cl.name, cl.crest_url AS logo
       FROM tm_competition_clubs cc
       JOIN tm_clubs cl ON cl.id = cc.club_id
       WHERE cc.competition_id = ?
       ORDER BY COALESCE(cl.market_value, 0) DESC, cl.name`,
    )
    .all(competitionId) as Array<{ id: string; name: string; logo: string | null }>;
}

export function predictTmClubXi(
  competitionId: string,
  clubId: string,
  opts?: { formation?: string },
): SeasonPrediction | null {
  const db = getDb();
  const team = db
    .prepare(
      `SELECT cl.id, cl.name
       FROM tm_clubs cl
       JOIN tm_competition_clubs cc ON cc.club_id = cl.id AND cc.competition_id = ?
       WHERE cl.id = ?`,
    )
    .get(competitionId, clubId) as { id: string; name: string } | undefined;
  if (!team) return null;

  const rows = db
    .prepare(
      `SELECT
         player_id AS playerId,
         name,
         position,
         detail_role AS detailRole,
         detail_label AS detailLabel,
         side_role AS sideRole,
         market_value_eur AS marketValueEur,
         COALESCE(is_captain, 0) AS isCaptain,
         json_extract(raw_json, '$.clubAssignments[0].start') AS joinedAt,
         json_extract(raw_json, '$.clubAssignments[0].debut') AS debut
       FROM tm_squad_players
       WHERE club_id = ?`,
    )
    .all(clubId) as Array<TmSquadRow & { joinedAt: string | null; debut: string | null }>;

  if (rows.length === 0) return null;

  const values = rows.map((r) => r.marketValueEur ?? 0);
  const valueN = normalize(values.map((v) => Math.log10((v || 1) + 1)));

  const ranked: RankedPlayer[] = rows.map((r, i) => {
    const { role, label, side } = resolveRole(r);
    const captainBoost = r.isCaptain ? 3 : 0;
    const score = valueN[i]! + captainBoost;
    const sideTokens = String(r.sideRole || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => parseDetailRole(t, t, null))
      .filter((x): x is Role => x != null);
    const activeRoles = [...new Set<Role>([role, ...sideTokens])];
    const joinedAt = r.joinedAt || null;
    return {
      playerId: Number(r.playerId) || 0,
      name: r.name,
      role,
      roleLabel: label,
      sideRole: side,
      activeRoles,
      group: roleGroup(role),
      score: Number(score.toFixed(2)),
      strength: Number(valueN[i]!.toFixed(2)),
      valueScore: Number(valueN[i]!.toFixed(2)),
      marketValueEur: r.marketValueEur,
      minutes: 0,
      rating: null,
      goals: 0,
      assists: 0,
      matchedValue: (r.marketValueEur ?? 0) > 0,
      isNew: isNewTransfer(joinedAt, r.debut),
      joinedAt,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  const roles = ranked.map((p) => p.role);
  let plan: FormationPlan;
  let reason: string;
  if (opts?.formation && FORMATIONS[opts.formation]) {
    plan = FORMATIONS[opts.formation]!;
    reason = `forced ${opts.formation}`;
  } else {
    plan = inferFormation(roles);
    reason = formationReason(plan, roles);
  }

  const used = new Set<number>();
  const xi: XiSlotWithBackup[] = [];
  const orderedSlots = [...plan.slots].sort(
    (a, b) => (ROLE_FILL_PRIORITY[a.role] ?? 50) - (ROLE_FILL_PRIORITY[b.role] ?? 50),
  );

  for (const slot of orderedSlots) {
    const candidates = ranked
      .filter((p) => !used.has(p.playerId))
      .map((p) => {
        const fit = bestRoleFit(p.activeRoles, slot.role);
        return { p, fit, fitScore: p.score * (0.4 + 0.6 * fit) };
      })
      .filter((c) => c.fit >= 0.35)
      .sort((a, b) => b.fitScore - a.fitScore || b.p.score - a.p.score);

    const starterEntry =
      candidates[0] ??
      ranked
        .filter((p) => !used.has(p.playerId))
        .map((p) => ({
          p,
          fit: bestRoleFit(p.activeRoles, slot.role),
          fitScore: p.score * 0.35,
        }))
        .filter((c) => c.fit > 0)
        .sort((a, b) => b.fitScore - a.fitScore)[0];

    if (!starterEntry) continue;
    used.add(starterEntry.p.playerId);
    xi.push({
      slot: slot.id,
      role: slot.role,
      label: slot.label,
      x: slot.x,
      y: slot.y,
      position: roleGroup(slot.role),
      starter: starterEntry.p,
      backup: null,
    });
  }

  xi.sort(
    (a, b) =>
      plan.slots.findIndex((s) => s.id === a.slot) - plan.slots.findIndex((s) => s.id === b.slot),
  );

  const usedBackup = new Set<number>();
  for (const row of xi) {
    const backupEntry = ranked
      .filter((p) => !used.has(p.playerId) && !usedBackup.has(p.playerId))
      .map((p) => {
        const fit = bestRoleFit(p.activeRoles, row.role);
        return { p, fit, fitScore: p.score * (0.4 + 0.6 * fit) };
      })
      .filter((c) => c.fit >= 0.35)
      .sort((a, b) => b.fitScore - a.fitScore)[0];

    if (backupEntry) {
      usedBackup.add(backupEntry.p.playerId);
      row.backup = backupEntry.p;
    }
  }

  const avgStarterScore =
    xi.length === 0 ? 0 : xi.reduce((a, s) => a + s.starter.score, 0) / xi.length;
  const avgRating = Number(avgStarterScore.toFixed(1));
  const coverage =
    rows.length === 0 ? 0 : rows.filter((r) => (r.marketValueEur ?? 0) > 0).length / rows.length;
  const confidence = Number(
    Math.max(0, Math.min(1, 0.45 * (avgStarterScore / 100) + 0.55 * coverage)).toFixed(3),
  );

  const seasonRow = db
    .prepare(`SELECT season_id FROM tm_competitions WHERE id = ?`)
    .get(competitionId) as { season_id: number | null } | undefined;

  return {
    season: seasonRow?.season_id ?? 2026,
    basedOnSeason: seasonRow?.season_id ?? 2026,
    teamId: Number(team.id) || 0,
    teamName: team.name,
    formation: plan.code,
    formationReason: reason,
    preseason: {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gf: 0,
      ga: 0,
      formScore: 0.5,
    },
    confidence,
    method:
      "TM Desk: formation from squad role depth; score = market value (+ captain); backup = next best role fit",
    avgRating,
    xi,
  };
}

export function allTmPredictions(competitionId: string): SeasonPrediction[] {
  return listTmXiTeams(competitionId)
    .map((t) => predictTmClubXi(competitionId, t.id))
    .filter((x): x is SeasonPrediction => x !== null);
}
