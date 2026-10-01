import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  getComputed,
  invalidateComputed,
  listComputedKeys,
  peekComputed,
  peekComputedPersisted,
  resetComputedCacheForTests,
  writeComputed,
  setComputedCacheScheduler,
  setComputedCacheEnqueueEnabled,
} from "./computedCache.js";

function database() {
  const db = new Database(":memory:");
  return db;
}

test.afterEach(() => {
  resetComputedCacheForTests();
});

test("cache hit returns the same payload as the miss without recomputing", () => {
  const db = database();
  let computes = 0;
  const compute = () => {
    computes += 1;
    return { teams: [{ id: 1, total: 26 }], flag: true };
  };

  const miss = getComputed("xi:test", "v1", compute, { database: db });
  const hit = getComputed("xi:test", "v1", compute, { database: db });

  assert.equal(miss.status, "miss");
  assert.equal(hit.status, "hit");
  assert.equal(computes, 1);
  assert.deepEqual(hit.value, miss.value);
  assert.deepEqual(hit.value, { teams: [{ id: 1, total: 26 }], flag: true });
});

test("version bump rebuilds and does not keep forever-stale data", () => {
  const db = database();
  let payload = { total: 10 };
  const first = getComputed("xi:test", "v1", () => payload, { database: db });
  payload = { total: 11 };
  const rebuilt = getComputed("xi:test", "v2", () => payload, {
    database: db,
    serveStale: false,
  });

  assert.equal(first.value.total, 10);
  assert.equal(rebuilt.status, "miss");
  assert.equal(rebuilt.value.total, 11);
  assert.deepEqual(peekComputed("xi:test", "v2"), { total: 11 });
});

test("stale-while-revalidate is single-flight and later reads the rebuild", async () => {
  const db = database();
  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });

  let computes = 0;
  getComputed("xi:test", "v1", () => ({ n: 1 }), { database: db });
  const staleA = getComputed("xi:test", "v2", () => {
    computes += 1;
    return { n: 2 };
  }, { database: db });
  const staleB = getComputed("xi:test", "v2", () => {
    computes += 1;
    return { n: 2 };
  }, { database: db });

  assert.equal(staleA.status, "stale");
  assert.equal(staleB.status, "stale");
  assert.equal(staleA.building, true);
  assert.equal(staleA.value.n, 1);
  assert.equal(queued.length, 1);
  assert.equal(computes, 0);

  await queued[0]!();
  const hit = getComputed("xi:test", "v2", () => {
    computes += 1;
    return { n: 9 };
  }, { database: db });
  assert.equal(computes, 1);
  assert.equal(hit.status, "hit");
  assert.equal(hit.value.n, 2);
});

test("persisted peek and write survive memory invalidation", () => {
  const db = database();
  writeComputed("premium:squads:205", "1", { teamIds: [396, 5009] }, { database: db });
  invalidateComputed("premium:squads:");
  assert.equal(peekComputed("premium:squads:205"), undefined);
  assert.deepEqual(peekComputedPersisted("premium:squads:205", { database: db }), {
    teamIds: [396, 5009],
  });
});

test("L2 sqlite survives memory invalidation", () => {
  const db = database();
  getComputed("board:test", "v1", () => ({ players: [1, 2, 3] }), { database: db });
  invalidateComputed("board:");
  assert.equal(peekComputed("board:test"), undefined);

  const hit = getComputed("board:test", "v1", () => ({ players: [9] }), { database: db });
  assert.equal(hit.status, "hit");
  assert.deepEqual(hit.value, { players: [1, 2, 3] });
});

test("blockOnMiss false returns immediately without computing and rebuilds later", async () => {
  const db = database();
  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });
  let computes = 0;
  const miss = getComputed(
    "ideal-vs-real:ekstraklasa:4",
    "phase:live|3-0",
    () => {
      computes += 1;
      return { live: 1 };
    },
    { database: db, blockOnMiss: false },
  );
  assert.equal(miss.status, "miss");
  assert.equal(miss.building, true);
  assert.equal(miss.value, undefined);
  assert.equal(computes, 0);
  assert.equal(queued.length, 1);
  await queued[0]!();
  assert.equal(computes, 1);
  const hit = getComputed(
    "ideal-vs-real:ekstraklasa:4",
    "phase:live|3-0",
    () => {
      computes += 1;
      return { live: 9 };
    },
    { database: db, blockOnMiss: false },
  );
  assert.equal(hit.status, "hit");
  assert.deepEqual(hit.value, { live: 1 });
});

test("persist invalidation drops L2 so in-play version is not served forever", () => {
  const db = database();
  getComputed("ideal-vs-real:ekstraklasa:4", "phase:upcoming|0-0", () => ({ live: 0 }), {
    database: db,
  });
  invalidateComputed("ideal-vs-real:", { database: db, persist: true });
  assert.equal(peekComputed("ideal-vs-real:ekstraklasa:4"), undefined);

  let computes = 0;
  const miss = getComputed(
    "ideal-vs-real:ekstraklasa:4",
    "phase:live|3-0",
    () => {
      computes += 1;
      return { live: 1, score: "3-0" };
    },
    { database: db, serveStale: false },
  );
  assert.equal(miss.status, "miss");
  assert.equal(computes, 1);
  assert.deepEqual(miss.value, { live: 1, score: "3-0" });
});

test("FotMob score change in the version key rebuilds instead of serving 0-0 forever", () => {
  const db = database();
  getComputed(
    "ideal-vs-real:championship:1",
    "championship|1||2026-08-16T14:28:00Z|5836764:upcoming:0:0",
    () => ({ score: "0-0" }),
    { database: db },
  );
  const rebuilt = getComputed(
    "ideal-vs-real:championship:1",
    "championship|1||2026-08-16T15:35:00Z|5836764:live:1:0",
    () => ({ score: "1-0" }),
    { database: db, serveStale: false },
  );
  assert.equal(rebuilt.status, "miss");
  assert.deepEqual(rebuilt.value, { score: "1-0" });
});

test("enqueue disabled (web) returns miss without scheduling rebuild", () => {
  const db = database();
  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });
  setComputedCacheEnqueueEnabled(false);
  let computes = 0;
  const miss = getComputed(
    "mantra-scores:premier-league:4",
    "v1",
    () => {
      computes += 1;
      return { "1": { total: 9 } };
    },
    { database: db, blockOnMiss: false },
  );
  assert.equal(miss.status, "miss");
  assert.equal(miss.building, false);
  assert.equal(computes, 0);
  assert.equal(queued.length, 0);
});

test("enqueue disabled does not schedule stale Ideal rebuilds (web peeks only)", () => {
  const db = database();
  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });
  getComputed("ideal-vs-real:serie-a:2", "v1", () => ({ n: 1 }), { database: db });
  setComputedCacheEnqueueEnabled(false);
  let computes = 0;
  const stale = getComputed(
    "ideal-vs-real:serie-a:2",
    "v2",
    () => {
      computes += 1;
      return { n: 2 };
    },
    { database: db, blockOnMiss: false },
  );
  assert.equal(stale.status, "stale");
  assert.equal(stale.building, false);
  assert.equal(stale.value.n, 1);
  assert.equal(computes, 0);
  assert.equal(queued.length, 0);
});

test("enqueue disabled reloads SQLite when compute worker writes a newer version", () => {
  const db = database();
  getComputed("mantra-scores:premier-league:2", "v1", () => ({ total: 10 }), {
    database: db,
  });
  setComputedCacheEnqueueEnabled(false);
  // Worker writes L2 only (other process) — leave web L1 on v1.
  db.prepare(
    `UPDATE computed_cache SET version = ?, body_json = ?, built_at = ? WHERE key = ?`,
  ).run(
    "v2",
    JSON.stringify({ total: 42 }),
    new Date().toISOString(),
    "mantra-scores:premier-league:2",
  );

  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });
  let computes = 0;
  const hit = getComputed(
    "mantra-scores:premier-league:2",
    "v2",
    () => {
      computes += 1;
      return { total: 99 };
    },
    { database: db, blockOnMiss: false },
  );
  assert.equal(hit.status, "hit");
  assert.equal(hit.value.total, 42);
  assert.equal(computes, 0);
  assert.equal(queued.length, 0);
});

test("enqueue disabled still allows blocking compute worker writes", () => {
  const db = database();
  const queued: Array<() => void | Promise<void>> = [];
  setComputedCacheScheduler((work) => {
    queued.push(work);
  });
  setComputedCacheEnqueueEnabled(false);
  let computes = 0;
  const miss = getComputed(
    "dream-team:ekstraklasa:4",
    "v1",
    () => {
      computes += 1;
      return { xi: [1] };
    },
    { database: db, blockOnMiss: true },
  );
  assert.equal(miss.status, "miss");
  assert.equal(computes, 1);
  assert.equal(queued.length, 0);
  assert.deepEqual(peekComputed("dream-team:ekstraklasa:4"), { xi: [1] });
});

test("listComputedKeys returns memory and sqlite keys for a prefix", () => {
  const db = database();
  writeComputed("mantra-ideal-table:v3:serie-a:B3", "v1", { n: 1 }, { database: db });
  writeComputed("mantra-ideal-table:v4-pen:serie-a:C4", "v1", { n: 2 }, { database: db });
  writeComputed("mantra-standings:v3:serie-a", "v1", { n: 3 }, { database: db });
  const keys = listComputedKeys("mantra-ideal-table:", { database: db }).sort();
  assert.deepEqual(keys, [
    "mantra-ideal-table:v3:serie-a:B3",
    "mantra-ideal-table:v4-pen:serie-a:C4",
  ]);
});
