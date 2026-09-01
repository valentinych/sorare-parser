import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { nameMatchScore } from "../lib/names.js";
import {
  bestRoleFit,
  FORMATIONS,
  inferFormation,
  parseDetailRole,
  ROLE_AFFINITY,
  roleGroup,
  type FormationPlan,
  type Role,
} from "../lib/roles.js";
import { getManagerFormation } from "../sync/syncManagerFormations.js";
import { loadAfNewTransferMap } from "./newTransfers.js";
import { leaguePlayerRatings } from "./playerRating.js";
import { idealXiFromScout } from "./scoutIdealXi.js";
import { getComputed, peekComputed } from "../lib/computedCache.js";
import { sorarePredictionForAfPlayer, sorarePredictionsForAfPlayers } from "./sorare.js";
import {
  expected11XiPredictionsForAfPlayers,
  type Expected11XiPrediction,
} from "./expected11Xi.js";
import {
  SERIE_A_XI_LEAGUE_ID,
  serieALineupForAfPlayers,
  serieALineupScoreBonus,
  type SerieALineupPrediction,
} from "./serieALineup.js";
import { xiCacheVersion, xiPredictionsCacheKey } from "./xiCache.js";

export type RankedPlayer = {
  playerId: number;
  name: string;
  role: Role;
  roleLabel: string;
  sideRole: Role | null;
  /** All active TM roles (main + each side token). */
  activeRoles: Role[];
  group: "GK" | "DEF" | "MID" | "ATT";
  score: number;
  strength: number;
  valueScore: number;
  marketValueEur: number | null;
  minutes: number;
  rating: number | null;
  goals: number;
  assists: number;
  matchedValue: boolean;
  /** Summer arrival (TM clubAssignments.start + debut filter). */
  isNew: boolean;
  joinedAt: string | null;
  starterProbability?: number | null;
  starterReliability?: string | null;
  starterProbabilitySource?: "expected11" | "official_sorare" | null;
  officialStarterProbability?: number | null;
  expected11?: Expected11XiPrediction | null;
  serieALineup?: SerieALineupPrediction | null;
};

export type XiSlotWithBackup = {
  slot: string;
  role: Role;
  label: string;
  x: number;
  y: number;
  position: "GK" | "DEF" | "MID" | "ATT";
  starter: RankedPlayer;
  backup: RankedPlayer | null;
};

export type SeasonPrediction = {
  season: number;
  basedOnSeason: number;
  teamId: number;
  teamName: string;
  formation: string;
  formationReason: string;
  preseason: {
    played: number;
    wins: number;
    draws: number;
    losses: number;
    gf: number;
    ga: number;
    formScore: number;
  };
  confidence: number;
  method: string;
  /** Mean starter board rating (league-normalized, same as «Все игроки»). */
  avgRating: number;
  xi: XiSlotWithBackup[];
};

type SquadRow = {
  playerId: number;
  name: string;
  afPosition: string | null;
  tmName: string | null;
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  minutes: number;
  playoffMinutes: number;
  age: number | null;
  rating: number | null;
  goals: number;
  assists: number;
  lineups: number;
  marketValueEur: number | null;
  matchedValue: number;
};

type UnmatchedTm = {
  name: string;
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  marketValueEur: number | null;
};

const ROLE_FILL_PRIORITY: Record<Role, number> = {
  GK: 0,
  LB: 1,
  RB: 1,
  LWB: 2,
  RWB: 2,
  ST: 3,
  LW: 4,
  RW: 4,
  DM: 5,
  AM: 6,
  LM: 7,
  RM: 7,
  SS: 8,
  CM: 9,
  CB: 10,
};

function ageQuality(age: number | null): number {
  if (age == null) return 0;
  // Soft peak-age boost — not a hard filter.
  if (age >= 24 && age <= 29) return 28;
  if (age >= 21 && age <= 32) return 16;
  if (age >= 18 && age <= 35) return 6;
  return 0;
}

function qualitySoft(row: { marketValueEur: number | null; age: number | null }): number {
  const mv = Math.log10((row.marketValueEur ?? 0) + 1) * 12;
  return mv + ageQuality(row.age);
}

function selectionScore(
  row: {
    minutes: number;
    playoffMinutes: number;
    lineups: number;
    marketValueEur: number | null;
    age: number | null;
  },
  isNew = false,
): number {
  // XI fill must NOT use fantasy rating — minutes/lineups first, soft MV+age, playoff boost.
  const playoff = row.playoffMinutes > 0 ? row.playoffMinutes * 1.35 : 0;
  const mv = row.marketValueEur ?? 0;
  const mvOnly = Math.log10(mv + 1) * 40 + ageQuality(row.age);
  if (row.minutes > 0 || playoff > 0) {
    const base = row.minutes + playoff + row.lineups * 8 + qualitySoft(row);
    // Starter-caliber arrivals with almost no club minutes yet (summer or mid-season).
    // Don't let a low-minute deputy (€200k GK with 700') beat Uğurcan Çakır / Trossard.
    if (mv >= 8_000_000 && row.minutes < 200) {
      return Math.max(base, mvOnly + 600);
    }
    if (isNew && mv >= 8_000_000 && row.minutes < 900) {
      return Math.max(base, mvOnly + 600);
    }
    return base;
  }
  // Zero club minutes: €8M+ still compete with low-minute deputies.
  if (mv >= 8_000_000) return mvOnly + 600;
  return mvOnly;
}

/** Drop bad TM links (e.g. K. Moore → Alex Moore) and rematch unmatched TM on the same club. */
function trustTmFields(row: SquadRow, unmatched: UnmatchedTm[]): SquadRow {
  const pool: UnmatchedTm[] = [...unmatched];
  if (row.tmName) {
    pool.push({
      name: row.tmName,
      detailRole: row.detailRole,
      detailLabel: row.detailLabel,
      sideRole: row.sideRole,
      marketValueEur: row.marketValueEur,
    });
  }

  const hits = pool
    .map((t) => ({
      t,
      score: nameMatchScore(row.name, t.name) + Math.log10((t.marketValueEur ?? 0) + 1) * 3,
    }))
    .filter((h) => h.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || (b.t.marketValueEur ?? 0) - (a.t.marketValueEur ?? 0),
    );

  const best = hits[0]?.t;
  if (!best) {
    return {
      ...row,
      tmName: null,
      detailRole: null,
      detailLabel: null,
      sideRole: null,
      marketValueEur: null,
      matchedValue: 0,
    };
  }

  const umIdx = unmatched.findIndex((t) => t.name === best.name && t.detailRole === best.detailRole);
  if (umIdx >= 0) unmatched.splice(umIdx, 1);

  return {
    ...row,
    tmName: best.name,
    detailRole: best.detailRole,
    detailLabel: best.detailLabel,
    sideRole: best.sideRole,
    marketValueEur: best.marketValueEur,
    matchedValue: 1,
  };
}

function resolveRole(row: SquadRow): { role: Role; label: string; side: Role | null; active: Role[] } {
  const fromDetail = parseDetailRole(row.detailRole, row.detailLabel, null);
  const fromAf = parseDetailRole(row.afPosition, row.afPosition, row.afPosition);
  const role = fromDetail ?? fromAf ?? "CM";
  const sideTokens = String(row.sideRole || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sides = sideTokens
    .map((t) => parseDetailRole(t, t, null))
    .filter((r): r is Role => r != null)
    // Keep sides near the main role (blocks ST + bogus CM from a bad TM link).
    .filter((r) => {
      if (roleGroup(r) === roleGroup(role)) return true;
      const nearMain = ROLE_AFFINITY[role] ?? [];
      const nearSide = ROLE_AFFINITY[r] ?? [];
      return nearMain.includes(r) || nearSide.includes(role);
    });
  const side = sides[0] ?? null;
  const active = [...new Set<Role>([role, ...sides])];
  const label = row.detailLabel ?? row.detailRole ?? role;
  return { role, label, side, active };
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
  return `inferred ${plan.code} from squad roles (${bits.join(", ")})`;
}

function pickFormation(
  ranked: RankedPlayer[],
  teamId: number,
  forced?: string,
): { plan: FormationPlan; reason: string } {
  const roles = ranked.map((p) => p.role);
  const inferred = inferFormation(roles);

  if (forced && FORMATIONS[forced]) {
    return { plan: FORMATIONS[forced], reason: `forced ${forced}` };
  }

  // Preferred: current manager's formation from AF career sample (recency-weighted).
  // Threshold 3: ignore one-off / tiny samples before trusting over squad infer.
  const mgr = getManagerFormation(teamId);
  if (mgr && FORMATIONS[mgr.preferredFormation] && mgr.sampleSize >= 3) {
    return {
      plan: FORMATIONS[mgr.preferredFormation]!,
      reason: `manager ${mgr.coachName}: ${mgr.preferredFormation} in ${mgr.preferredCount}/${mgr.sampleSize} recent games (recency-weighted AF)`,
    };
  }

  const hist = getDb()
    .prepare(
      `SELECT formation, COUNT(DISTINCT fixture_id) AS n
       FROM lineup_appearances
       WHERE team_id = ? AND is_starter = 1 AND formation IS NOT NULL AND formation != ''
       GROUP BY formation
       ORDER BY n DESC
       LIMIT 1`,
    )
    .get(teamId) as { formation: string; n: number } | undefined;

  if (hist?.formation && hist.n >= 8 && FORMATIONS[hist.formation]) {
    return {
      plan: FORMATIONS[hist.formation],
      reason: `from ${hist.n} historical lineups (${hist.formation})`,
    };
  }

  return { plan: inferred, reason: formationReason(inferred, roles) };
}

function isCurrentExpected11Out(player: RankedPlayer): boolean {
  return (
    player.expected11?.freshness !== "stale" &&
    player.expected11?.lineupGroup === "out"
  );
}

export function effectiveStarterEvidence(
  official: { starterProbability: number; reliability: string | null } | null,
  expected11: Expected11XiPrediction | null,
): {
  probability: number | null;
  reliability: string | null;
  source: "expected11" | "official_sorare" | null;
} {
  if (expected11?.starterProbability != null) {
    return {
      probability: expected11.starterProbability,
      reliability: "expected11",
      source: "expected11",
    };
  }
  if (official) {
    return {
      probability: official.starterProbability,
      reliability: official.reliability,
      source: "official_sorare",
    };
  }
  return { probability: null, reliability: null, source: null };
}

function selectFormationStarters(
  ranked: RankedPlayer[],
  chosen: FormationPlan,
): XiSlotWithBackup[] {
  const used = new Set<number>();
  const xi: XiSlotWithBackup[] = [];
  const orderedSlots = [...chosen.slots].sort(
    (a, b) => (ROLE_FILL_PRIORITY[a.role] ?? 50) - (ROLE_FILL_PRIORITY[b.role] ?? 50),
  );

  for (const slot of orderedSlots) {
    const slotGroup = roleGroup(slot.role);
    const scored = ranked
      .filter((p) => !used.has(p.playerId))
      .map((p) => {
        const mainFit = bestRoleFit([p.role], slot.role);
        const anyFit = bestRoleFit(p.activeRoles, slot.role);
        const fit = mainFit >= 0.99 ? 1 : anyFit * (mainFit >= 0.35 ? 1 : 0.75);
        return { p, fit, mainFit, fitScore: p.score * (0.35 + 0.65 * fit) };
      })
      .filter((candidate) => candidate.fit >= 0.35)
      .sort((a, b) => {
        const defensive = slotGroup === "DEF" || slotGroup === "GK";
        if (defensive) {
          const ae = a.mainFit >= 0.99 ? 1 : 0;
          const be = b.mainFit >= 0.99 ? 1 : 0;
          if (be !== ae) return be - ae;
        } else {
          const ae = a.fit >= 0.99 ? 1 : 0;
          const be = b.fit >= 0.99 ? 1 : 0;
          if (be !== ae) return be - ae;
          const am = a.mainFit >= 0.99 ? 1 : 0;
          const bm = b.mainFit >= 0.99 ? 1 : 0;
          if (bm !== am && Math.abs(a.p.score - b.p.score) < 200) return bm - am;
        }

        const aStarterCaliber =
          (a.p.marketValueEur ?? 0) >= 8_000_000 && a.p.minutes < 200;
        const bStarterCaliber =
          (b.p.marketValueEur ?? 0) >= 8_000_000 && b.p.minutes < 200;
        if (!aStarterCaliber && !bStarterCaliber) {
          const am = a.p.minutes >= 450 ? 1 : 0;
          const bm = b.p.minutes >= 450 ? 1 : 0;
          if (bm !== am && Math.abs(a.p.score - b.p.score) < 100) return bm - am;
        }

        return (
          b.fitScore - a.fitScore ||
          b.p.score - a.p.score ||
          (b.p.marketValueEur ?? 0) - (a.p.marketValueEur ?? 0) ||
          a.p.playerId - b.p.playerId
        );
      });

    const starterEntry =
      scored[0] ??
      ranked
        .filter((p) => !used.has(p.playerId) && p.group === slotGroup)
        .map((p) => ({ p, fitScore: p.score * 0.3 }))
        .sort(
          (a, b) =>
            b.fitScore - a.fitScore ||
            b.p.score - a.p.score ||
            a.p.playerId - b.p.playerId,
        )[0];
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
      chosen.slots.findIndex((slot) => slot.id === a.slot) -
      chosen.slots.findIndex((slot) => slot.id === b.slot),
  );
  return xi;
}

export function selectXiWithExpected11Availability(
  ranked: RankedPlayer[],
  chosen: FormationPlan,
): XiSlotWithBackup[] {
  const availableRanked = ranked.filter((player) => !isCurrentExpected11Out(player));
  let xi = selectFormationStarters(availableRanked, chosen);
  if (xi.length < chosen.slots.length) {
    xi = selectFormationStarters(ranked, chosen);
    for (const slot of xi) {
      if (isCurrentExpected11Out(slot.starter) && slot.starter.expected11) {
        slot.starter.expected11 = {
          ...slot.starter.expected11,
          outFallback: true,
        };
      }
    }
  }
  return xi;
}

type PredictSeasonXiOpts = {
  season?: number;
  historySeason?: number;
  formation?: string;
  leagueId?: number;
  /** Precomputed league board ratings (avoids N× league scans). */
  boardRatings?: Map<number, number>;
  /** Precomputed strict Expected11 links (avoids N× snapshot scans). */
  expected11Predictions?: Map<number, Expected11XiPrediction>;
  /** Precomputed Sorare starter odds (avoids N× prediction lookups). */
  sorarePredictions?: Map<
    number,
    NonNullable<ReturnType<typeof sorarePredictionForAfPlayer>>
  >;
  /** Precomputed Serie A Fantacalcio/SorareInside % (missing = neutral). */
  serieALineupPredictions?: Map<number, SerieALineupPrediction>;
  now?: Date;
};

export function predictSeasonXi(
  teamId: number,
  opts?: PredictSeasonXiOpts,
): SeasonPrediction | null {
  if (
    opts?.formation == null &&
    opts?.now == null &&
    opts?.expected11Predictions == null &&
    opts?.boardRatings == null &&
    opts?.sorarePredictions == null &&
    opts?.serieALineupPredictions == null
  ) {
    const season = opts?.season ?? config.predictSeason;
    const leagueId = opts?.leagueId;
    if (leagueId != null) {
      const version = xiCacheVersion(season, leagueId);
      const cached = peekComputed<SeasonPrediction[]>(
        xiPredictionsCacheKey(season, leagueId),
        version,
      );
      if (cached) return cached.find((row) => row.teamId === teamId) ?? null;
    }
  }
  return buildSeasonPrediction(teamId, opts);
}

function buildSeasonPrediction(
  teamId: number,
  opts?: PredictSeasonXiOpts,
): SeasonPrediction | null {
  const season = opts?.season ?? config.predictSeason;
  const historySeason = opts?.historySeason ?? config.season;
  const db = getDb();

  const team = opts?.leagueId
    ? (db
        .prepare(
          `SELECT team_id AS id, name, league_id AS leagueId FROM season_teams
           WHERE season = ? AND team_id = ? AND (league_id = ? OR league_id IS NULL)`,
        )
        .get(season, teamId, opts.leagueId) as
        | { id: number; name: string; leagueId: number | null }
        | undefined)
    : (db
        .prepare(
          `SELECT team_id AS id, name, league_id AS leagueId FROM season_teams
           WHERE season = ? AND team_id = ?`,
        )
        .get(season, teamId) as { id: number; name: string; leagueId: number | null } | undefined);
  if (!team) return null;

  // MD1 Ekstraklasa: prefer Fantastyczny Skaut predicted XI when available.
  const leagueId = opts?.leagueId ?? team.leagueId ?? null;
  if (leagueId === 106) {
    const scout = idealXiFromScout(teamId, team.name, {
      season,
      historySeason,
      leagueId: 106,
    });
    if (scout && scout.xi.length >= 10) return scout;
  }

  const form = (db
    .prepare(
      `SELECT played, wins, draws, losses, gf, ga, form_score AS formScore
       FROM preseason_team_form WHERE season = ? AND team_id = ?`,
    )
    .get(season, teamId) as
    | {
        played: number;
        wins: number;
        draws: number;
        losses: number;
        gf: number;
        ga: number;
        formScore: number;
      }
    | undefined) ?? {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    gf: 0,
    ga: 0,
    formScore: 0.5,
  };

  const unmatchedTm = db
    .prepare(
      `SELECT name, detail_role AS detailRole, detail_label AS detailLabel,
              side_role AS sideRole, market_value_eur AS marketValueEur
       FROM player_values
       WHERE team_id = ? AND af_player_id IS NULL`,
    )
    .all(teamId) as UnmatchedTm[];

  const rows = (
    db
      .prepare(
        `SELECT
           sp.player_id AS playerId,
           sp.name,
           sp.position AS afPosition,
           pv.name AS tmName,
           pv.detail_role AS detailRole,
           pv.detail_label AS detailLabel,
           pv.side_role AS sideRole,
           COALESCE(ps.minutes, 0) AS minutes,
           COALESCE((
             SELECT SUM(CASE WHEN la.is_starter = 1 THEN 90 ELSE 30 END)
             FROM lineup_appearances la
             JOIN fixtures f ON f.id = la.fixture_id
             WHERE la.player_id = sp.player_id AND la.team_id = sp.team_id
               AND f.league_id = ?
               AND (
                 lower(f.round) IN ('semi-finals', 'final')
                 OR lower(f.round) LIKE '%play-off%'
                 OR lower(f.round) LIKE '%playoff%'
                 OR lower(f.round) LIKE '%promotion%'
               )
           ), 0) AS playoffMinutes,
           p.age AS age,
           ps.rating AS rating,
           COALESCE(ps.goals, 0) AS goals,
           COALESCE(ps.assists, 0) AS assists,
           COALESCE(ps.lineups, 0) AS lineups,
           pv.market_value_eur AS marketValueEur,
           CASE WHEN pv.af_player_id IS NOT NULL THEN 1 ELSE 0 END AS matchedValue
         FROM squad_players sp
         LEFT JOIN players p ON p.id = sp.player_id
         LEFT JOIN player_stats ps
           ON ps.player_id = sp.player_id AND ps.season = ? AND ps.team_id = sp.team_id
         LEFT JOIN player_values pv
           ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
         WHERE sp.season = ? AND sp.team_id = ?`,
      )
      .all(leagueId ?? team.leagueId ?? 0, historySeason, season, teamId) as SquadRow[]
  ).map((r) => trustTmFields(r, unmatchedTm));

  const newTransfers = loadAfNewTransferMap();
  const expected11Predictions =
    opts?.expected11Predictions ??
    (leagueId == null
      ? new Map<number, Expected11XiPrediction>()
      : expected11XiPredictionsForAfPlayers(
          leagueId,
          rows.map((row) => row.playerId),
          { now: opts?.now },
        ));
  const serieALineupPredictions =
    opts?.serieALineupPredictions ??
    (leagueId == null
      ? new Map<number, SerieALineupPrediction>()
      : serieALineupForAfPlayers(leagueId, rows.map((row) => row.playerId)));
  const ranked: RankedPlayer[] = rows.map((r) => {
    const { role, label, side, active } = resolveRole(r);
    const transfer = newTransfers.get(r.playerId);
    const isNew = transfer?.isNew ?? false;
    const sorare =
      opts?.sorarePredictions?.get(r.playerId) ??
      (leagueId != null ? sorarePredictionForAfPlayer(leagueId, r.playerId) : null);
    const expected11 = expected11Predictions.get(r.playerId) ?? null;
    const serieALineup = serieALineupPredictions.get(r.playerId) ?? null;
    const starterEvidence = effectiveStarterEvidence(sorare, expected11);
    const effectiveStarterProbability = starterEvidence.probability;
    const starterSignal =
      effectiveStarterProbability == null
        ? 0
        : (effectiveStarterProbability - 0.5) * 1_800;
    const score =
      selectionScore(r, isNew) + starterSignal + serieALineupScoreBonus(serieALineup);
    return {
      playerId: r.playerId,
      // Prefer TM name when matched (AF squads may use the second Spanish surname).
      name: r.tmName ?? r.name,
      role,
      roleLabel: label,
      sideRole: side,
      activeRoles: active,
      group: roleGroup(role),
      score: Number(score.toFixed(2)),
      strength: Number(Math.min(r.minutes / 18, 100).toFixed(2)),
      valueScore: Number((Math.log10((r.marketValueEur || 1) + 1) * 10).toFixed(2)),
      marketValueEur: r.marketValueEur,
      minutes: r.minutes,
      rating: r.rating,
      goals: r.goals,
      assists: r.assists,
      matchedValue: r.matchedValue === 1,
      isNew,
      joinedAt: transfer?.joinedAt ?? null,
      starterProbability: effectiveStarterProbability,
      starterReliability: starterEvidence.reliability,
      starterProbabilitySource: starterEvidence.source,
      officialStarterProbability: sorare?.starterProbability ?? null,
      expected11,
      serieALineup,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  const { plan: chosen, reason } = pickFormation(ranked, teamId, opts?.formation);

  const availableRanked = ranked.filter((player) => !isCurrentExpected11Out(player));
  const xi = selectXiWithExpected11Availability(ranked, chosen);
  const used = new Set(xi.map((slot) => slot.starter.playerId));

  // Pass 2: backups from remaining players with role fit
  const usedBackup = new Set<number>();
  for (const row of xi) {
    const backupEntry = availableRanked
      .filter((p) => !used.has(p.playerId) && !usedBackup.has(p.playerId))
      .map((p) => {
        const fit = bestRoleFit(p.activeRoles, row.role);
        return { p, fit, fitScore: p.score * (0.4 + 0.6 * fit) };
      })
      .filter((c) => c.fit >= 0.35)
      .sort(
        (a, b) =>
          b.fitScore - a.fitScore ||
          b.p.score - a.p.score ||
          a.p.playerId - b.p.playerId,
      )[0];

    if (backupEntry) {
      usedBackup.add(backupEntry.p.playerId);
      row.backup = backupEntry.p;
    }
  }

  // Selection uses minutes×roleFit; display/avg use honest fantasy role-percentile ratings.
  const lid = opts?.leagueId ?? team.leagueId ?? 106;
  const boardRatings = opts?.boardRatings ?? leaguePlayerRatings(season, lid);
  for (const row of xi) {
    const sr = boardRatings.get(row.starter.playerId);
    if (sr != null) row.starter.score = sr;
    if (row.backup) {
      const br = boardRatings.get(row.backup.playerId);
      if (br != null) row.backup.score = br;
    }
  }

  const avgStarterScore =
    xi.length === 0 ? 0 : xi.reduce((a, s) => a + s.starter.score, 0) / xi.length;
  const avgRating = Number(avgStarterScore.toFixed(1));
  const coverage =
    rows.length === 0
      ? 0
      : rows.filter((r) => r.minutes > 0 || (r.marketValueEur ?? 0) > 0).length / rows.length;
  const detailed =
    ranked.length === 0 ? 0 : ranked.filter((p) => p.matchedValue && p.role).length / ranked.length;
  const confidence = Number(
    Math.max(
      0,
      Math.min(1, 0.35 * form.formScore + 0.3 * (avgStarterScore / 100) + 0.2 * coverage + 0.15 * detailed),
    ).toFixed(3),
  );

  return {
    season,
    basedOnSeason: historySeason,
    teamId: team.id,
    teamName: team.name,
    formation: chosen.code,
    formationReason: reason,
    preseason: form,
    confidence,
    method:
      leagueId === 40
        ? "XI: manager formation + TM roles + minutes/playoffs + MV/age + current Expected11 starter probability (official Sorare fallback; OUT excluded unless formation fallback); rating = fantasy perf percentile by role"
        : leagueId === SERIE_A_XI_LEAGUE_ID
          ? "XI: manager formation + TM roles + minutes/playoffs + MV/age + Serie A Fantacalcio/SorareInside % (missing = neutral, numeric % only); rating = fantasy perf percentile by role"
          : "XI: manager formation + TM roles + minutes/playoffs + MV/age + fresh official Sorare starter probability; rating = fantasy perf percentile by role",
    avgRating,
    xi,
  };
}

function computeAllSeasonPredictions(
  season: number,
  leagueId?: number,
): SeasonPrediction[] {
  const teams = leagueId
    ? (getDb()
        .prepare(
          `SELECT team_id AS id FROM season_teams
           WHERE season = ? AND (league_id = ? OR league_id IS NULL)
           ORDER BY name`,
        )
        .all(season, leagueId) as Array<{ id: number }>)
    : (getDb()
        .prepare(`SELECT team_id AS id FROM season_teams WHERE season = ? ORDER BY name`)
        .all(season) as Array<{ id: number }>);
  const boardRatings = leagueId != null ? leaguePlayerRatings(season, leagueId) : undefined;
  const playerIds =
    leagueId == null
      ? []
      : getDb()
          .prepare(
            `SELECT sp.player_id AS playerId
             FROM squad_players sp
             JOIN season_teams st
               ON st.season = sp.season AND st.team_id = sp.team_id
             WHERE sp.season = ?
               AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))`,
          )
          .all(season, leagueId, leagueId)
          .map((row) => (row as { playerId: number }).playerId);
  const expected11Predictions =
    leagueId == null
      ? undefined
      : expected11XiPredictionsForAfPlayers(leagueId, playerIds);
  const sorarePredictions =
    leagueId == null ? undefined : sorarePredictionsForAfPlayers(leagueId, playerIds);
  const serieALineupPredictions =
    leagueId == null ? undefined : serieALineupForAfPlayers(leagueId, playerIds);
  return teams
    .map((t) =>
      buildSeasonPrediction(t.id, {
        season,
        leagueId,
        boardRatings,
        expected11Predictions,
        sorarePredictions,
        serieALineupPredictions,
      }),
    )
    .filter((x): x is SeasonPrediction => x !== null);
}

export function allSeasonPredictions(
  season = config.predictSeason,
  leagueId?: number,
  options?: { serveStale?: boolean },
): SeasonPrediction[] {
  if (leagueId == null) return computeAllSeasonPredictions(season);
  return getComputed(
    xiPredictionsCacheKey(season, leagueId),
    xiCacheVersion(season, leagueId),
    () => computeAllSeasonPredictions(season, leagueId),
    { serveStale: options?.serveStale },
  ).value;
}
