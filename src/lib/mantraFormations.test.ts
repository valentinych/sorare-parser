import assert from "node:assert/strict";
import { test } from "node:test";
import { FORMATION_SLOTS } from "./mantraFormations.js";

/** Slot labels in Mantra match HTML / squad XI order (not pitch LTR). */
const MANTRA_HTML_SLOT_ORDER: Record<string, readonly string[]> = {
  "3-5-2": ["GK", "CB", "CB", "CB", "WB", "DM", "DM/CM", "CM", "WB/W", "FW/ST", "FW/ST"],
  "4-3-3": ["GK", "RB", "CB", "CB", "LB", "DM", "DM/CM", "CM", "W/FW", "W/FW", "FW/ST"],
  "4-3-1-2": ["GK", "RB", "CB", "CB", "LB", "DM", "DM/CM", "CM", "AM", "FW/ST", "FW/ST"],
  "4-3-2-1": ["GK", "RB", "CB", "CB", "LB", "DM", "DM/CM", "CM", "AM/FW", "AM/FW", "FW/ST"],
};

test("FORMATION_SLOTS matches Mantra HTML XI order for wing/DM dual slots", () => {
  for (const [module, expected] of Object.entries(MANTRA_HTML_SLOT_ORDER)) {
    const labels = FORMATION_SLOTS[module]?.map((s) => s.label) ?? [];
    assert.deepEqual(labels, [...expected], module);
  }
});

test("3-5-2 does not swap WB and WB/W (false HTML≠index at #4/#8)", () => {
  const labels = FORMATION_SLOTS["3-5-2"]!.map((s) => s.label);
  assert.equal(labels[4], "WB");
  assert.equal(labels[8], "WB/W");
});
