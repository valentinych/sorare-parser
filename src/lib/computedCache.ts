import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";

/** Premium Expected11 × odds join. Bust on parse/mapping; do not touch premium:squads. */
export const PREMIUM_ODDS_JOIN_CACHE_KEY = "premium:odds-join";

export type ComputedCacheStatus = "hit" | "miss" | "stale";

export type ComputedCacheResult<T> = {
  value: T;
  status: ComputedCacheStatus;
  building: boolean;
  version: string;
  builtAt: string;
};

type MemoryEntry = {
  version: string;
  value: unknown;
  builtAt: string;
};

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS computed_cache (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  built_at TEXT NOT NULL
)`;

const memory = new Map<string, MemoryEntry>();
const inflight = new Set<string>();

/** When false (web process), miss/stale never schedules rebuilds — compute worker owns writes. */
let enqueueEnabled = process.env.COMPUTE_ENQUEUE !== "0";

let scheduleRebuild: (work: () => void | Promise<void>) => void = (work) => {
  setImmediate(() => {
    void Promise.resolve(work());
  });
};

export function setComputedCacheScheduler(fn: (work: () => void | Promise<void>) => void): void {
  scheduleRebuild = fn;
}

export function setComputedCacheEnqueueEnabled(enabled: boolean): void {
  enqueueEnabled = enabled;
}

export function isComputedCacheEnqueueEnabled(): boolean {
  return enqueueEnabled;
}

export function resetComputedCacheForTests(): void {
  memory.clear();
  inflight.clear();
  enqueueEnabled = process.env.COMPUTE_ENQUEUE !== "0";
  scheduleRebuild = (work) => {
    setImmediate(() => {
      void Promise.resolve(work());
    });
  };
}

function databaseFor(database?: Database.Database): Database.Database {
  const instance = database ?? getDb();
  instance.exec(CREATE_SQL);
  return instance;
}

function readRow(
  database: Database.Database,
  key: string,
): { version: string; bodyJson: string; builtAt: string } | undefined {
  return database
    .prepare(
      `SELECT version, body_json AS bodyJson, built_at AS builtAt
       FROM computed_cache WHERE key = ?`,
    )
    .get(key) as { version: string; bodyJson: string; builtAt: string } | undefined;
}

function writeRow(
  database: Database.Database,
  key: string,
  version: string,
  value: unknown,
  builtAt: string,
): void {
  database
    .prepare(
      `INSERT INTO computed_cache (key, version, body_json, built_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         version = excluded.version,
         body_json = excluded.body_json,
         built_at = excluded.built_at`,
    )
    .run(key, version, JSON.stringify(value), builtAt);
}

function store(
  database: Database.Database,
  key: string,
  version: string,
  value: unknown,
): MemoryEntry {
  const builtAt = new Date().toISOString();
  const frozen = JSON.parse(JSON.stringify(value)) as unknown;
  const entry = { version, value: frozen, builtAt };
  memory.set(key, entry);
  writeRow(database, key, version, frozen, builtAt);
  return entry;
}

function loadL2(database: Database.Database, key: string): MemoryEntry | undefined {
  const row = readRow(database, key);
  if (!row) return undefined;
  try {
    const entry = {
      version: row.version,
      value: JSON.parse(row.bodyJson) as unknown,
      builtAt: row.builtAt,
    };
    memory.set(key, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Resolve cache entry for a requested version.
 * On L1 miss/mismatch, always re-read SQLite — the compute worker may have
 * written a newer row while this process (web, COMPUTE_ENQUEUE=0) still holds
 * forever-stale memory from the first GET /live.
 */
function entryForVersion(
  database: Database.Database,
  key: string,
  version: string,
): MemoryEntry | undefined {
  const mem = memory.get(key);
  if (mem?.version === version) return mem;
  const fromDb = loadL2(database, key);
  if (fromDb) return fromDb;
  return mem;
}

function enqueueRebuild(
  database: Database.Database,
  key: string,
  version: string,
  compute: () => unknown | Promise<unknown>,
): void {
  if (inflight.has(key)) return;
  inflight.add(key);
  scheduleRebuild(async () => {
    try {
      const latest = memory.get(key);
      if (latest?.version === version) return;
      const value = await Promise.resolve(compute());
      // Already written by a concurrent same-version rebuild.
      const after = memory.get(key);
      if (after?.version === version) return;
      store(database, key, version, value);
    } finally {
      inflight.delete(key);
    }
  });
}

export function peekComputed<T>(key: string, version?: string): T | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (version != null && entry.version !== version) return undefined;
  return entry.value as T;
}

export function peekComputedPersisted<T>(
  key: string,
  options?: { database?: Database.Database },
): T | undefined {
  // Always refresh from SQLite so web sees compute-worker writes.
  const entry = loadL2(databaseFor(options?.database), key);
  return entry?.value as T | undefined;
}

export function writeComputed<T>(
  key: string,
  version: string,
  value: T,
  options?: { database?: Database.Database },
): void {
  store(databaseFor(options?.database), key, version, value);
}

export function getComputed<T>(
  key: string,
  version: string,
  compute: () => T | Promise<T>,
  options: { database?: Database.Database; serveStale?: boolean; blockOnMiss?: boolean } = {},
): ComputedCacheResult<T> {
  const database = databaseFor(options.database);
  const serveStale = options.serveStale !== false;
  const blockOnMiss = options.blockOnMiss !== false;
  const current = entryForVersion(database, key, version);
  if (current?.version === version) {
    return {
      value: current.value as T,
      status: "hit",
      building: false,
      version,
      builtAt: current.builtAt,
    };
  }

  if (!current && !blockOnMiss) {
    if (enqueueEnabled) enqueueRebuild(database, key, version, compute);
    return {
      value: undefined as T,
      status: "miss",
      building: enqueueEnabled,
      version,
      builtAt: "",
    };
  }

  if (current && serveStale) {
    if (enqueueEnabled) enqueueRebuild(database, key, version, compute);
    return {
      value: current.value as T,
      status: "stale",
      building: enqueueEnabled,
      version: current.version,
      builtAt: current.builtAt,
    };
  }

  // Blocking miss must stay sync for callers that need a value immediately.
  const computed = compute();
  if (computed != null && typeof (computed as Promise<T>).then === "function") {
    throw new Error(`getComputed(${key}): async compute requires blockOnMiss: false`);
  }
  const stored = store(database, key, version, computed as T);
  return {
    value: stored.value as T,
    status: "miss",
    building: false,
    version,
    builtAt: stored.builtAt,
  };
}

export function invalidateComputed(
  keyPrefix?: string,
  options?: { database?: Database.Database; persist?: boolean },
): void {
  if (!keyPrefix) {
    memory.clear();
    if (options?.persist) {
      databaseFor(options.database).prepare(`DELETE FROM computed_cache`).run();
    }
    return;
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(keyPrefix)) memory.delete(key);
  }
  if (options?.persist) {
    databaseFor(options.database)
      .prepare(`DELETE FROM computed_cache WHERE key LIKE ?`)
      .run(`${keyPrefix}%`);
  }
}
