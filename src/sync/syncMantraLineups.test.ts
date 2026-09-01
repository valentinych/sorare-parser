import assert from "node:assert/strict";
import test from "node:test";
import type { MantraMatch, MantraTourMatch } from "../clients/mantraAuth.js";
import {
  lineupXiSignature,
  mergeMantraMatchCache,
  patchMatchScoresFromTour,
  pitchNameMatchKey,
  takeSquadPlayerForSlot,
} from "./syncMantraLineups.js";

function side(
  names: string[],
  extras?: { fantasyScore?: number | null; goals?: number | null; scoreLabel?: string | null },
): MantraMatch["home"] {
  return {
    teamId: 1,
    teamName: "T",
    module: "3-4-3",
    defenseBonus: 0,
    fantasyScore: extras?.fantasyScore ?? 0,
    goals: extras?.goals ?? 0,
    scoredCount: names.length,
    lineup: names.map((playerName) => ({
      slot: null,
      positions: ["FW"],
      playerName,
      playerId: null,
    })),
    squad: names.map((name) => ({
      playerId: null,
      name,
      positions: ["FW"],
      scoreLabel: extras?.scoreLabel ?? null,
    })),
    substitutes: [],
    notInSquad: [],
  };
}

function match(home: string[], away: string[], extras?: Parameters<typeof side>[1]): MantraMatch {
  return {
    id: 1,
    url: "https://mantrafootball.org/matches/1",
    home: side(home, extras),
    away: side(away, extras),
  };
}

test("merge keeps locked XI and patches only live scores when the set is unchanged", () => {
  const prev = match(["A", "B"], ["C"], { fantasyScore: 10, goals: 1, scoreLabel: "6.0" });
  const next = match(["A", "B"], ["C"], { fantasyScore: 14, goals: 2, scoreLabel: "6.5" });
  const merged = mergeMantraMatchCache(prev, next);
  assert.equal(lineupXiSignature(merged), lineupXiSignature(prev));
  assert.equal(merged.home.fantasyScore, 14);
  assert.equal(merged.home.goals, 2);
  assert.equal(merged.home.squad[0]?.scoreLabel, "6.5");
  assert.equal(merged.home.lineup[0]?.playerName, "A");
});

test("merge fully replaces when the XI set changes", () => {
  const prev = match(["A", "B"], ["C"]);
  const next = match(["A", "D"], ["C"], { fantasyScore: 9 });
  const merged = mergeMantraMatchCache(prev, next);
  assert.equal(lineupXiSignature(merged), lineupXiSignature(next));
  assert.deepEqual(
    merged.home.lineup.map((s) => s.playerName),
    ["A", "D"],
  );
});

test("pitchNameMatchKey strips Mantra pitch ellipsis", () => {
  assert.equal(pitchNameMatchKey("Pedro Junqu..."), "pedro junqu");
  assert.equal(pitchNameMatchKey("Pedro Junqu…"), "pedro junqu");
  assert.equal(pitchNameMatchKey("Ouattara"), "ouattara");
});

test("truncated pitch name Pedro Junqu... resolves squad Pedro Junqueira Joao", () => {
  const slot = {
    slot: "slot-d5",
    positions: ["FW", "ST"],
    playerName: "Pedro Junqu...",
    playerId: null,
  };
  const squad = [
    {
      playerId: 4213,
      name: "Ouattara",
      positions: ["W", "FW"],
      scoreLabel: "Brentford",
    },
    {
      playerId: 967,
      name: "Pedro Junqueira Joao",
      positions: ["FW", "ST"],
      scoreLabel: "Chelsea",
    },
  ];
  const hit = takeSquadPlayerForSlot(slot, squad, new Set());
  assert.equal(hit?.playerId, 967);
  assert.equal(hit?.name, "Pedro Junqueira Joao");
});

test("tour card scores patch cached match without touching XI", () => {
  const cached = match(["A"], ["B"], { fantasyScore: 8, goals: 0 });
  const tour: MantraTourMatch = {
    matchId: 1,
    url: cached.url,
    locked: true,
    home: {
      teamId: 1,
      teamName: "T",
      logoUrl: null,
      score: 12,
      scoredCount: 4,
      goals: 2,
    },
    away: {
      teamId: 2,
      teamName: "U",
      logoUrl: null,
      score: 7,
      scoredCount: 2,
      goals: 1,
    },
  };
  const patched = patchMatchScoresFromTour(cached, tour);
  assert.notEqual(patched, cached);
  assert.equal(patched.home.fantasyScore, 12);
  assert.equal(patched.away.goals, 1);
  assert.equal(lineupXiSignature(patched), lineupXiSignature(cached));
  assert.equal(patchMatchScoresFromTour(patched, tour), patched);
});
