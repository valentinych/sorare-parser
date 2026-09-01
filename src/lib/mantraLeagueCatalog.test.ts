import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDESLIGA_MANTRA_LEAGUES,
  catalogMantraLeagues,
} from "./mantraLeagueCatalog.js";

test("Bundesliga Mantra catalog is season 26-27 city leagues 770–784", () => {
  assert.equal(BUNDESLIGA_MANTRA_LEAGUES.length, 15);
  assert.deepEqual(
    BUNDESLIGA_MANTRA_LEAGUES.map((league) => league.id),
    [770, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784],
  );
  assert.equal(BUNDESLIGA_MANTRA_LEAGUES[0]?.name, "Berlin");
  assert.equal(BUNDESLIGA_MANTRA_LEAGUES.at(-1)?.name, "Duisburg");
  assert.deepEqual(catalogMantraLeagues(3), BUNDESLIGA_MANTRA_LEAGUES);
  assert.deepEqual(catalogMantraLeagues(2), []);
  assert.deepEqual(catalogMantraLeagues(11), []);
  assert.deepEqual(catalogMantraLeagues(18), []);
  assert.deepEqual(catalogMantraLeagues(21), []);
  assert.deepEqual(catalogMantraLeagues(1), []);
});
