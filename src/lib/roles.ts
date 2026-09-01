/** Detailed pitch roles from Transfermarkt shortNames / labels. */

export type Role =
  | "GK"
  | "LB"
  | "CB"
  | "RB"
  | "LWB"
  | "RWB"
  | "DM"
  | "CM"
  | "AM"
  | "LM"
  | "RM"
  | "LW"
  | "RW"
  | "SS"
  | "ST";

export type PitchSlot = {
  id: string;
  role: Role;
  label: string;
  x: number;
  y: number;
};

export type FormationPlan = {
  code: string;
  slots: PitchSlot[];
};

const ROLE_ALIASES: Record<string, Role> = {
  gk: "GK",
  goalkeeper: "GK",
  g: "GK",
  // API-Football coarse positions (without TM detail_role everything became CM)
  def: "CB",
  defender: "CB",
  mid: "CM",
  midfielder: "CM",
  att: "ST",
  attacker: "ST",
  attack: "ST",
  cb: "CB",
  "centre-back": "CB",
  "center-back": "CB",
  sweeper: "CB",
  lb: "LB",
  "left-back": "LB",
  rb: "RB",
  "right-back": "RB",
  lwb: "LWB",
  "left wing-back": "LWB",
  "left-wing-back": "LWB",
  rwb: "RWB",
  "right wing-back": "RWB",
  "right-wing-back": "RWB",
  dm: "DM",
  "defensive midfield": "DM",
  "defensive midfielder": "DM",
  cm: "CM",
  "central midfield": "CM",
  "central midfielder": "CM",
  am: "AM",
  "attacking midfield": "AM",
  "attacking midfielder": "AM",
  lm: "LM",
  "left midfield": "LM",
  "left midfielder": "LM",
  rm: "RM",
  "right midfield": "RM",
  "right midfielder": "RM",
  lw: "LW",
  "left winger": "LW",
  rw: "RW",
  "right winger": "RW",
  ss: "SS",
  "second striker": "SS",
  cf: "ST",
  st: "ST",
  "centre-forward": "ST",
  "center-forward": "ST",
  striker: "ST",
  forward: "ST",
};

/** Adjacent / fallback roles when filling a slot. */
export const ROLE_AFFINITY: Record<Role, Role[]> = {
  GK: ["GK"],
  LB: ["LB", "LWB", "LM"],
  RB: ["RB", "RWB", "RM"],
  CB: ["CB"],
  LWB: ["LWB", "LB", "LM", "LW"],
  RWB: ["RWB", "RB", "RM", "RW"],
  DM: ["DM", "CM"],
  CM: ["CM", "DM", "AM"],
  AM: ["AM", "CM", "SS"],
  LM: ["LM", "LW", "LWB", "LB", "CM"],
  RM: ["RM", "RW", "RWB", "RB", "CM"],
  LW: ["LW", "LM", "AM", "LWB"],
  RW: ["RW", "RM", "AM", "RWB"],
  SS: ["SS", "AM", "ST"],
  /** Strict: do not park AMs at ST just because they score well. */
  ST: ["ST", "SS"],
};

export function parseDetailRole(
  shortName?: string | null,
  fullName?: string | null,
  category?: string | null,
): Role | null {
  for (const raw of [shortName, fullName]) {
    if (!raw) continue;
    const key = raw.trim().toLowerCase();
    if (ROLE_ALIASES[key]) return ROLE_ALIASES[key];
  }
  if (!category) return null;
  const c = category.toLowerCase().trim();
  if (c === "g" || c === "gk" || c.includes("goal")) return "GK";
  if (c === "d" || c === "def" || c.includes("defend")) return "CB";
  if (c === "m" || c === "mid" || c.includes("mid")) return "CM";
  if (c === "a" || c === "f" || c === "att" || c.includes("attack") || c.includes("forward")) return "ST";
  return null;
}

export function roleGroup(role: Role): "GK" | "DEF" | "MID" | "ATT" {
  if (role === "GK") return "GK";
  if (["LB", "CB", "RB", "LWB", "RWB"].includes(role)) return "DEF";
  if (["DM", "CM", "AM", "LM", "RM"].includes(role)) return "MID";
  return "ATT";
}

export const FORMATIONS: Record<string, FormationPlan> = {
  "4-3-3": {
    code: "4-3-3",
    slots: [
      { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
      { id: "LW", role: "LW", label: "LW", x: 18, y: 22 },
      { id: "RW", role: "RW", label: "RW", x: 82, y: 22 },
      { id: "LCM", role: "CM", label: "LCM", x: 28, y: 46 },
      { id: "CM", role: "CM", label: "CM", x: 50, y: 50 },
      { id: "RCM", role: "CM", label: "RCM", x: 72, y: 46 },
      { id: "LB", role: "LB", label: "LB", x: 14, y: 72 },
      { id: "LCB", role: "CB", label: "LCB", x: 36, y: 74 },
      { id: "RCB", role: "CB", label: "RCB", x: 64, y: 74 },
      { id: "RB", role: "RB", label: "RB", x: 86, y: 72 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
  "4-2-3-1": {
    code: "4-2-3-1",
    slots: [
      { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
      { id: "LAM", role: "LW", label: "LW", x: 18, y: 30 },
      { id: "AM", role: "AM", label: "AM", x: 50, y: 28 },
      { id: "RAM", role: "RW", label: "RW", x: 82, y: 30 },
      { id: "LDM", role: "DM", label: "LDM", x: 34, y: 52 },
      { id: "RDM", role: "DM", label: "RDM", x: 66, y: 52 },
      { id: "LB", role: "LB", label: "LB", x: 14, y: 72 },
      { id: "LCB", role: "CB", label: "LCB", x: 36, y: 74 },
      { id: "RCB", role: "CB", label: "RCB", x: 64, y: 74 },
      { id: "RB", role: "RB", label: "RB", x: 86, y: 72 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
  "4-4-2": {
    code: "4-4-2",
    slots: [
      { id: "LST", role: "ST", label: "ST", x: 38, y: 14 },
      { id: "RST", role: "ST", label: "ST", x: 62, y: 14 },
      { id: "LM", role: "LM", label: "LM", x: 14, y: 40 },
      { id: "LCM", role: "CM", label: "LCM", x: 36, y: 44 },
      { id: "RCM", role: "CM", label: "RCM", x: 64, y: 44 },
      { id: "RM", role: "RM", label: "RM", x: 86, y: 40 },
      { id: "LB", role: "LB", label: "LB", x: 14, y: 72 },
      { id: "LCB", role: "CB", label: "LCB", x: 36, y: 74 },
      { id: "RCB", role: "CB", label: "RCB", x: 64, y: 74 },
      { id: "RB", role: "RB", label: "RB", x: 86, y: 72 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
  "3-5-2": {
    code: "3-5-2",
    slots: [
      { id: "LST", role: "ST", label: "ST", x: 38, y: 14 },
      { id: "RST", role: "ST", label: "ST", x: 62, y: 14 },
      { id: "LWB", role: "LWB", label: "LWB", x: 12, y: 42 },
      { id: "LCM", role: "CM", label: "CM", x: 32, y: 46 },
      { id: "CM", role: "DM", label: "DM", x: 50, y: 50 },
      { id: "RCM", role: "CM", label: "CM", x: 68, y: 46 },
      { id: "RWB", role: "RWB", label: "RWB", x: 88, y: 42 },
      { id: "LCB", role: "CB", label: "LCB", x: 28, y: 74 },
      { id: "CB", role: "CB", label: "CB", x: 50, y: 76 },
      { id: "RCB", role: "CB", label: "RCB", x: 72, y: 74 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
  "3-4-3": {
    code: "3-4-3",
    slots: [
      { id: "LW", role: "LW", label: "LW", x: 18, y: 16 },
      { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
      { id: "RW", role: "RW", label: "RW", x: 82, y: 16 },
      { id: "LM", role: "LM", label: "LM", x: 16, y: 44 },
      { id: "LCM", role: "CM", label: "CM", x: 38, y: 48 },
      { id: "RCM", role: "CM", label: "CM", x: 62, y: 48 },
      { id: "RM", role: "RM", label: "RM", x: 84, y: 44 },
      { id: "LCB", role: "CB", label: "LCB", x: 28, y: 74 },
      { id: "CB", role: "CB", label: "CB", x: 50, y: 76 },
      { id: "RCB", role: "CB", label: "RCB", x: 72, y: 74 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
  "4-1-4-1": {
    code: "4-1-4-1",
    slots: [
      { id: "ST", role: "ST", label: "ST", x: 50, y: 12 },
      { id: "LM", role: "LM", label: "LM", x: 14, y: 34 },
      { id: "LCM", role: "CM", label: "CM", x: 36, y: 38 },
      { id: "RCM", role: "CM", label: "CM", x: 64, y: 38 },
      { id: "RM", role: "RM", label: "RM", x: 86, y: 34 },
      { id: "DM", role: "DM", label: "DM", x: 50, y: 56 },
      { id: "LB", role: "LB", label: "LB", x: 14, y: 72 },
      { id: "LCB", role: "CB", label: "LCB", x: 36, y: 74 },
      { id: "RCB", role: "CB", label: "RCB", x: 64, y: 74 },
      { id: "RB", role: "RB", label: "RB", x: 86, y: 72 },
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
    ],
  },
};

export function countRoles(roles: Role[]): Record<Role, number> {
  const counts = Object.fromEntries(
    (Object.keys(ROLE_AFFINITY) as Role[]).map((r) => [r, 0]),
  ) as Record<Role, number>;
  for (const r of roles) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

/** Pick formation from squad role depth (not a flat 4-3-3 default). */
export function inferFormation(roles: Role[]): FormationPlan {
  const c = countRoles(roles);
  const fullbacks = c.LB + c.RB;
  const wingbacks = c.LWB + c.RWB;
  const wideMids = c.LM + c.RM;
  const wideAttack = c.LW + c.RW;
  const flankDef = fullbacks + wingbacks + Math.min(wideMids, 2);
  const score: Array<{ code: string; pts: number }> = [
    {
      code: "3-5-2",
      pts:
        (c.CB >= 3 ? 3 : 0) +
        (wingbacks >= 2 ? 4 : flankDef >= 2 && fullbacks === 0 ? 2 : 0) +
        (c.ST + c.SS >= 2 ? 3 : 0) +
        (c.DM + c.CM >= 3 ? 2 : 0) -
        (fullbacks >= 2 ? 3 : 0),
    },
    {
      code: "3-4-3",
      pts:
        (c.CB >= 3 ? 2 : 0) +
        (wideAttack >= 2 ? 4 : 0) +
        (c.ST >= 1 ? 2 : 0) +
        (wideMids + wingbacks >= 2 ? 2 : 0) -
        (fullbacks >= 2 ? 2 : 0),
    },
    {
      code: "4-2-3-1",
      pts:
        (c.DM >= 2 ? 3 : c.DM >= 1 ? 1 : 0) +
        (c.AM >= 1 ? 2 : 0) +
        (c.ST + c.SS <= 1 ? 2 : 0) +
        (wideAttack >= 2 ? 1 : 0) +
        (flankDef >= 2 ? 2 : 0) -
        (c.ST + c.SS >= 2 ? 2 : 0),
    },
    {
      code: "4-1-4-1",
      pts:
        (c.DM === 1 ? 3 : 0) +
        (wideMids + wideAttack >= 2 ? 3 : 0) +
        (c.CM >= 2 ? 2 : 0) +
        (c.ST === 1 ? 2 : 0) +
        (flankDef >= 2 ? 2 : 0),
    },
    {
      code: "4-4-2",
      pts:
        (c.ST + c.SS >= 2 ? 5 : 0) +
        (wideMids + wideAttack >= 2 ? 3 : 0) +
        (flankDef >= 2 ? 3 : 0) +
        (c.CM >= 2 ? 2 : 0) -
        (c.AM >= 3 && c.ST + c.SS < 2 ? 2 : 0),
    },
    {
      code: "4-3-3",
      pts:
        (wideAttack >= 2 ? 5 : wideAttack === 1 ? 2 : 0) +
        (c.ST >= 1 ? 2 : 0) +
        (c.CM + c.DM >= 3 ? 3 : 0) +
        (flankDef >= 2 ? 3 : 0) +
        (c.AM <= 1 ? 2 : 0) -
        (c.DM >= 2 && c.AM >= 2 ? 1 : 0),
    },
  ];

  score.sort((a, b) => b.pts - a.pts);
  const best = score[0]?.code ?? "4-3-3";
  return FORMATIONS[best] ?? FORMATIONS["4-3-3"];
}

export function affinityScore(playerRole: Role, slotRole: Role): number {
  if (playerRole === slotRole) return 1;
  const list = ROLE_AFFINITY[slotRole] ?? [];
  const idx = list.indexOf(playerRole);
  if (idx === -1) {
    // same broad group weak fit — but never for GK↔outfield or ST↔pure mid unless listed
    if (slotRole === "GK" || playerRole === "GK") return 0;
    if (roleGroup(playerRole) === roleGroup(slotRole)) return 0.2;
    return 0;
  }
  return Math.max(0.35, 1 - idx * 0.2);
}

/** Best fit of a player's active TM roles (main + sides) to a pitch slot. */
export function bestRoleFit(playerRoles: Role[], slotRole: Role): number {
  if (!playerRoles.length) return 0;
  return Math.max(...playerRoles.map((r) => affinityScore(r, slotRole)));
}
