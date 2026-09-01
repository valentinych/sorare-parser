/**
 * Ideal MD1 XI from Fantastyczny Skaut predicted lineups + our ratings.
 * Confirmed scout starters preferred; doubtful slots may be swapped to safer squad alternatives.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";
import { namesMatch, normName } from "../lib/names.js";
import { FORMATIONS, roleGroup, type FormationPlan, type Role } from "../lib/roles.js";
import { leaguePlayerRatings } from "./playerRating.js";
import { loadAfNewTransferMap } from "./newTransfers.js";
import type { RankedPlayer, SeasonPrediction, XiSlotWithBackup } from "./predictSeasonXi.js";

export type ScoutSlot = {
  slot: string;
  role: Role;
  name: string;
  price: number;
  doubt: boolean;
};

export type ScoutTeam = {
  teamKey: string;
  name: string;
  afHints: string[];
  opponent: string;
  kickoff: string;
  home: boolean;
  formation: string;
  excluded: string[];
  xi: ScoutSlot[];
};

type ScoutFile = {
  source: string;
  round: number;
  teams: ScoutTeam[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOUT_PATH = path.join(__dirname, "..", "..", "data", "scout-md1-ek.json");

let cached: ScoutFile | null = null;

export function loadScoutMd1(): ScoutFile {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(SCOUT_PATH, "utf8")) as ScoutFile;
  return cached;
}

export function findScoutTeam(afTeamName: string): ScoutTeam | null {
  const n = normName(afTeamName);
  const tokens = new Set(n.split(" ").filter((t) => t.length > 1));
  let best: { t: ScoutTeam; score: number } | null = null;
  for (const t of loadScoutMd1().teams) {
    let score = 0;
    const tn = normName(t.name);
    if (tn === n) score = 100;
    for (const h of t.afHints) {
      const nh = normName(h);
      if (!nh) continue;
      if (n === nh || tn === nh) score = Math.max(score, 95);
      // Whole-token only — never substring ("krakow" must not hit "rakow").
      if (tokens.has(nh)) score = Math.max(score, 40 + Math.min(nh.length, 20));
      if (nh.includes(" ") && (n.includes(nh) || tn.includes(nh))) score = Math.max(score, 85);
    }
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

type SquadCand = {
  playerId: number;
  name: string;
  marketValueEur: number | null;
  minutes: number;
  rating: number | null;
};

function loadSquad(teamId: number, season: number, historySeason: number): SquadCand[] {
  return getDb()
    .prepare(
      `SELECT
         sp.player_id AS playerId,
         sp.name,
         pv.market_value_eur AS marketValueEur,
         COALESCE(ps.minutes, 0) AS minutes,
         ps.rating AS rating
       FROM squad_players sp
       LEFT JOIN player_stats ps
         ON ps.player_id = sp.player_id AND ps.season = ? AND ps.team_id = sp.team_id
       LEFT JOIN player_values pv
         ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
       WHERE sp.season = ? AND sp.team_id = ?`,
    )
    .all(historySeason, season, teamId) as SquadCand[];
}

function matchScoutName(scoutName: string, squad: SquadCand[]): SquadCand | null {
  const sn = normName(scoutName);
  const hits = squad.filter((p) => {
    const pn = normName(p.name);
    if (namesMatch(p.name, scoutName)) return true;
    if (pn.includes(sn) || sn.includes(pn.split(" ").pop() ?? "")) return true;
    // Transliteration soft: last token prefix (Biczachczjan ↔ Bichakhchyan)
    const pl = pn.split(" ").pop() ?? "";
    const sl = sn.split(" ").pop() ?? "";
    if (pl.length >= 5 && sl.length >= 5 && (pl.startsWith(sl.slice(0, 4)) || sl.startsWith(pl.slice(0, 4)))) {
      return true;
    }
    return false;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => b.minutes - a.minutes || (b.marketValueEur ?? 0) - (a.marketValueEur ?? 0));
  return hits[0] ?? null;
}

function isExcluded(name: string, excluded: string[]): boolean {
  return excluded.some((e) => namesMatch(name, e) || normName(name).includes(normName(e)));
}

function toRanked(
  p: SquadCand,
  role: Role,
  score: number,
  board: Map<number, number>,
  transfers: Map<number, { isNew: boolean; joinedAt: string | null }>,
): RankedPlayer {
  const transfer = transfers.get(p.playerId);
  return {
    playerId: p.playerId,
    name: p.name,
    role,
    roleLabel: role,
    sideRole: null,
    activeRoles: [role],
    group: roleGroup(role),
    score: board.get(p.playerId) ?? score,
    strength: Number(Math.min(p.minutes / 18, 100).toFixed(2)),
    valueScore: Number((Math.log10((p.marketValueEur || 1) + 1) * 10).toFixed(2)),
    marketValueEur: p.marketValueEur,
    minutes: p.minutes,
    rating: p.rating,
    goals: 0,
    assists: 0,
    matchedValue: (p.marketValueEur ?? 0) > 0,
    isNew: transfer?.isNew ?? false,
    joinedAt: transfer?.joinedAt ?? null,
  };
}

function formationPlan(code: string): FormationPlan {
  if (FORMATIONS[code]) return FORMATIONS[code]!;
  // 3-4-2-1 / 4-4-1-1 / 5-4-1 not in FORMATIONS — synthesize from nearest
  if (code === "3-4-2-1") {
    return {
      code,
      slots: [
        { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
        { id: "LAM", role: "AM", label: "LAM", x: 32, y: 28 },
        { id: "RAM", role: "AM", label: "RAM", x: 68, y: 28 },
        { id: "LM", role: "LWB", label: "LWB", x: 12, y: 46 },
        { id: "LCM", role: "CM", label: "CM", x: 36, y: 50 },
        { id: "RCM", role: "CM", label: "CM", x: 64, y: 50 },
        { id: "RM", role: "RWB", label: "RWB", x: 88, y: 46 },
        { id: "LCB", role: "CB", label: "LCB", x: 28, y: 74 },
        { id: "CB", role: "CB", label: "CB", x: 50, y: 76 },
        { id: "RCB", role: "CB", label: "RCB", x: 72, y: 74 },
        { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
      ],
    };
  }
  if (code === "4-4-1-1") {
    return {
      code,
      slots: [
        { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
        { id: "AM", role: "AM", label: "AM", x: 50, y: 28 },
        { id: "LM", role: "LW", label: "LW", x: 14, y: 40 },
        { id: "LCM", role: "CM", label: "CM", x: 36, y: 48 },
        { id: "RCM", role: "CM", label: "CM", x: 64, y: 48 },
        { id: "RM", role: "RW", label: "RW", x: 86, y: 40 },
        { id: "LB", role: "LB", label: "LB", x: 14, y: 72 },
        { id: "LCB", role: "CB", label: "LCB", x: 36, y: 74 },
        { id: "RCB", role: "CB", label: "RCB", x: 64, y: 74 },
        { id: "RB", role: "RB", label: "RB", x: 86, y: 72 },
        { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
      ],
    };
  }
  if (code === "5-4-1") {
    return {
      code,
      slots: [
        { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
        { id: "LM", role: "LM", label: "LM", x: 14, y: 36 },
        { id: "LCM", role: "CM", label: "CM", x: 36, y: 42 },
        { id: "RCM", role: "CM", label: "CM", x: 64, y: 42 },
        { id: "RM", role: "RM", label: "RM", x: 86, y: 36 },
        { id: "LWB", role: "LWB", label: "LWB", x: 10, y: 58 },
        { id: "LCB", role: "CB", label: "LCB", x: 28, y: 74 },
        { id: "CB", role: "CB", label: "CB", x: 50, y: 76 },
        { id: "RCB", role: "CB", label: "RCB", x: 72, y: 74 },
        { id: "RWB", role: "RWB", label: "RWB", x: 90, y: 58 },
        { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
      ],
    };
  }
  if (code === "3-4-3") {
    return FORMATIONS["3-4-3"]!;
  }
  if (code === "4-4-2") {
    return FORMATIONS["4-4-2"]!;
  }
  return FORMATIONS["4-2-3-1"]!;
}

/**
 * Build ideal XI for a club from scout MD1 prediction.
 * Returns null if no scout row for this AF team name.
 */
export function idealXiFromScout(
  teamId: number,
  teamName: string,
  opts: { season: number; historySeason: number; leagueId: number },
): SeasonPrediction | null {
  const scout = findScoutTeam(teamName);
  if (!scout) return null;

  const squad = loadSquad(teamId, opts.season, opts.historySeason);
  const board = leaguePlayerRatings(opts.season, opts.leagueId);
  const transfers = loadAfNewTransferMap();
  const plan = formationPlan(scout.formation);
  const usedPlayers = new Set<number>();
  const usedPlanSlots = new Set<string>();
  const xi: XiSlotWithBackup[] = [];

  for (const scoutSlot of scout.xi) {
    // Bind scout row → nearest unused formation slot (by id, then role).
    let planSlot =
      plan.slots.find((s) => !usedPlanSlots.has(s.id) && s.id === scoutSlot.slot) ??
      plan.slots.find((s) => !usedPlanSlots.has(s.id) && s.role === scoutSlot.role) ??
      plan.slots.find((s) => !usedPlanSlots.has(s.id));
    if (!planSlot) continue;
    usedPlanSlots.add(planSlot.id);

    const role = scoutSlot.role || planSlot.role;
    let matched = matchScoutName(scoutSlot.name, squad);
    if (matched && isExcluded(matched.name, scout.excluded)) matched = null;

    let starter: RankedPlayer | null = null;
    if (matched && !usedPlayers.has(matched.playerId)) {
      const priceScore = scoutSlot.price * 25 * (scoutSlot.doubt ? 0.85 : 1);
      starter = toRanked(matched, role, priceScore, board, transfers);
    } else {
      // Replacement for missing/excluded scout name: same AF position group if possible.
      const wantPos =
        role === "GK" ? "GK" : roleGroup(role) === "DEF" ? "DEF" : roleGroup(role) === "ATT" ? "ATT" : "MID";
      const withPos = getDb()
        .prepare(
          `SELECT sp.player_id AS playerId, sp.name, sp.position,
                  pv.market_value_eur AS marketValueEur,
                  COALESCE(ps.minutes, 0) AS minutes, ps.rating AS rating
           FROM squad_players sp
           LEFT JOIN player_stats ps
             ON ps.player_id = sp.player_id AND ps.season = ? AND ps.team_id = sp.team_id
           LEFT JOIN player_values pv
             ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
           WHERE sp.season = ? AND sp.team_id = ?`,
        )
        .all(opts.historySeason, opts.season, teamId) as Array<SquadCand & { position: string | null }>;
      const pool = withPos.filter(
        (p) =>
          !usedPlayers.has(p.playerId) &&
          !isExcluded(p.name, scout.excluded) &&
          (p.position === wantPos || (wantPos !== "GK" && p.position !== "GK")),
      );
      const prefer = pool.filter((p) => p.position === wantPos);
      const pick = (prefer.length ? prefer : pool).sort(
        (a, b) => b.minutes - a.minutes || (b.marketValueEur ?? 0) - (a.marketValueEur ?? 0),
      )[0];
      if (pick) starter = toRanked(pick, role, board.get(pick.playerId) ?? 40, board, transfers);
    }
    if (!starter) continue;

    usedPlayers.add(starter.playerId);
    xi.push({
      slot: planSlot.id,
      role,
      label: planSlot.label,
      x: planSlot.x,
      y: planSlot.y,
      position: roleGroup(role),
      starter,
      backup: null,
    });
  }

  // backups
  for (const row of xi) {
    const backup = squad
      .filter((p) => !usedPlayers.has(p.playerId) && !isExcluded(p.name, scout.excluded))
      .map((p) => ({ p, score: board.get(p.playerId) ?? 0 }))
      .sort((a, b) => b.score - a.score)[0];
    if (backup) {
      usedPlayers.add(backup.p.playerId);
      row.backup = toRanked(backup.p, row.role, backup.score, board, transfers);
    }
  }

  const avgRating =
    xi.length === 0 ? 0 : Number((xi.reduce((a, s) => a + s.starter.score, 0) / xi.length).toFixed(1));
  const confirmed = scout.xi.filter((s) => !s.doubt).length;
  const confidence = Number(
    Math.max(0.35, Math.min(0.95, 0.45 + 0.04 * confirmed + 0.02 * (xi.length === 11 ? 5 : 0))).toFixed(
      3,
    ),
  );

  const meta = loadScoutMd1();
  return {
    season: opts.season,
    basedOnSeason: opts.historySeason,
    teamId,
    teamName,
    formation: scout.formation,
    formationReason: `MD${meta.round} Fantastyczny Skaut vs ${scout.opponent}${scout.home ? " (H)" : " (A)"} · ${scout.kickoff.slice(0, 16)}`,
    preseason: { played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, formScore: 0.5 },
    confidence,
    method:
      "Ideal XI: Fantastyczny Skaut predicted lineup + fantasy prices; excluded/doubt noted; board ratings overlaid",
    avgRating,
    xi,
  };
}
