/** Canonical Mantra formations (classic positions) — mirrors panenka.games. */

export const ALL_POSITIONS = [
  "GK",
  "CB",
  "RB",
  "LB",
  "WB",
  "DM",
  "CM",
  "AM",
  "W",
  "FW",
  "ST",
] as const;
export type MantraPosition = (typeof ALL_POSITIONS)[number];

export type FormationSlot = {
  readonly label: string;
  readonly accepted: readonly MantraPosition[];
};

/** Formation slot layouts — lineup list order from MantraFootball match HTML
 *  (same order as the squad XI list). Pitch LTR order may differ; for scoring
 *  and roster tables we follow this index. */
export const FORMATION_SLOTS: Record<string, readonly FormationSlot[]> = {
  "3-4-3": [
    { label: "GK", accepted: ["GK"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "W/FW", accepted: ["W", "FW"] },
    { label: "W/FW", accepted: ["W", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "3-4-1-2": [
    { label: "GK", accepted: ["GK"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "AM", accepted: ["AM"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "3-4-2-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "AM", accepted: ["AM"] },
    { label: "AM/FW", accepted: ["AM", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "3-5-2": [
    { label: "GK", accepted: ["GK"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "3-5-1-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM", accepted: ["DM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "AM/FW", accepted: ["AM", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-3-3": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "W/FW", accepted: ["W", "FW"] },
    { label: "W/FW", accepted: ["W", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-3-1-2": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "AM", accepted: ["AM"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-4-2": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "WB", accepted: ["WB"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-1-4-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "CM/AM", accepted: ["CM", "AM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "AM", accepted: ["AM"] },
    { label: "W", accepted: ["W"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-4-1-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "WB/W", accepted: ["WB", "W"] },
    { label: "AM/FW", accepted: ["AM", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-2-3-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "AM", accepted: ["AM"] },
    { label: "W/AM", accepted: ["W", "AM"] },
    { label: "W/FW", accepted: ["W", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
  "4-3-2-1": [
    { label: "GK", accepted: ["GK"] },
    { label: "RB", accepted: ["RB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "CB", accepted: ["CB"] },
    { label: "LB", accepted: ["LB"] },
    { label: "DM", accepted: ["DM"] },
    { label: "DM/CM", accepted: ["DM", "CM"] },
    { label: "CM", accepted: ["CM"] },
    { label: "AM/FW", accepted: ["AM", "FW"] },
    { label: "AM/FW", accepted: ["AM", "FW"] },
    { label: "FW/ST", accepted: ["FW", "ST"] },
  ],
};

export const ALL_FORMATIONS: readonly string[] = Object.keys(FORMATION_SLOTS);

/** OoP coverage with fixed malus (Mantra-style soft fits). */
export const POSITION_COMPAT: Record<MantraPosition, readonly MantraPosition[]> = {
  GK: [],
  RB: ["WB", "CB"],
  CB: ["RB", "LB", "DM"],
  LB: ["WB", "CB"],
  WB: ["RB", "LB", "W", "DM"],
  DM: ["CM", "CB"],
  CM: ["DM", "AM"],
  W: ["WB", "AM", "FW"],
  AM: ["CM", "W", "FW"],
  FW: ["W", "AM", "ST"],
  ST: ["FW"],
};

const OOP_MALUS = 12;

export type SlotFit = { fits: boolean; native: boolean; malus: number };

export function playerFitsSlot(positions: string[], slot: FormationSlot): SlotFit {
  if (slot.accepted.some((p) => positions.includes(p))) {
    return { fits: true, native: true, malus: 0 };
  }
  for (const pos of positions) {
    const compat = POSITION_COMPAT[pos as MantraPosition];
    if (!compat) continue;
    if (slot.accepted.some((acc) => compat.includes(acc))) {
      return { fits: true, native: false, malus: OOP_MALUS };
    }
  }
  return { fits: false, native: false, malus: 0 };
}

/** Pitch layout (percent coords, GK at bottom). */
export function layoutFormation(formationId: string): Array<{
  x: number;
  y: number;
  slot: FormationSlot;
  index: number;
}> {
  const slots = FORMATION_SLOTS[formationId];
  if (!slots?.length) return [];
  const lineCounts = formationId.split("-").map((n) => Number(n));
  if (lineCounts.some((n) => !Number.isFinite(n) || n <= 0)) {
    return slots.map((slot, index) => ({
      x: 50,
      y: 10 + (index / (slots.length - 1 || 1)) * 85,
      slot,
      index,
    }));
  }
  const fieldLines = lineCounts.length;
  const yGK = 90;
  const yDef = 72;
  const yAtt = 14;
  const yForFieldLine = (i: number) => {
    if (fieldLines === 1) return (yDef + yAtt) / 2;
    return yDef - (i / (fieldLines - 1)) * (yDef - yAtt);
  };

  const out: Array<{ x: number; y: number; slot: FormationSlot; index: number }> = [];
  out.push({ x: 50, y: yGK, slot: slots[0]!, index: 0 });

  let cursor = 1;
  lineCounts.forEach((count, lineI) => {
    const y = yForFieldLine(lineI);
    const lineSlots: { slot: FormationSlot; index: number; side: number }[] = [];
    let wingCounter = 0;
    for (let i = 0; i < count; i++) {
      const slot = slots[cursor + i]!;
      const acc = slot.accepted;
      let side = 0;
      if (acc.includes("RB")) side = 1;
      else if (acc.includes("LB")) side = -1;
      else if (acc.includes("WB") || acc.includes("W")) {
        wingCounter++;
        side = wingCounter === 1 ? 0.85 : -0.85;
      }
      lineSlots.push({ slot, index: cursor + i, side });
    }
    cursor += count;
    lineSlots.sort((a, b) => a.side - b.side || a.index - b.index);
    lineSlots.forEach((s, i) => {
      const x = count === 1 ? 50 : 15 + (70 / (count - 1)) * i;
      out.push({ x, y, slot: s.slot, index: s.index });
    });
  });
  return out;
}
