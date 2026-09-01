import { getDb, setMeta } from "../db/index.js";
import { AF_LEAGUES, leagueById } from "./afLeagues.js";

const META_KEY = "expand_sync_progress";

export type SyncQueueItem = {
  kind: "af" | "tm" | "mantra" | "managers";
  key: string;
  name: string;
  status: "pending" | "active" | "done" | "skipped" | "error";
  step?: string | null;
};

export type SyncProgress = {
  status: "idle" | "running" | "done" | "error";
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  /** PID of the expand process — used to detect silent death. */
  pid: number | null;
  phase: "af" | "tm" | "mantra" | "managers" | "done" | "idle";
  label: string;
  percent: number;
  leagueIds: number[];
  tmCompetitions: string[];
  mantraTournaments: number[];
  current: SyncQueueItem | null;
  queue: SyncQueueItem[];
  error: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyProgress(): SyncProgress {
  return {
    status: "idle",
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null,
    pid: null,
    phase: "idle",
    label: "Нет активного sync",
    percent: 0,
    leagueIds: [],
    tmCompetitions: [],
    mantraTournaments: [],
    current: null,
    queue: [],
    error: null,
  };
}

export function getMeta(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function readSyncProgress(): SyncProgress {
  const raw = getMeta(META_KEY);
  if (!raw) return emptyProgress();
  let p: SyncProgress;
  try {
    p = { ...emptyProgress(), ...(JSON.parse(raw) as SyncProgress) };
  } catch {
    return emptyProgress();
  }
  return reconcileStale(p);
}

/** If expand process died, surface it instead of frozen "running · 0%". */
function processAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reconcileStale(p: SyncProgress): SyncProgress {
  if (p.status !== "running") return p;
  const alive = processAlive(p.pid);
  const ageMs = p.updatedAt ? Date.now() - Date.parse(p.updatedAt) : Infinity;
  // Dead PID → immediate; otherwise allow long AF steps up to 15 min without heartbeat.
  if (alive && Number.isFinite(ageMs) && ageMs < 15 * 60_000) return p;
  if (!alive && Number.isFinite(ageMs) && ageMs < 20_000) return p; // brief race at start
  if (alive) return p;

  p.status = "error";
  p.phase = "done";
  p.error =
    p.error ||
    (p.pid ? `Sync процесс pid=${p.pid} не найден` : "Sync прерван (нет обновлений >15 мин)");
  p.label = "Sync прерван — перезапустите npm run sync:expand";
  p.current = null;
  p.pid = null;
  setMeta(META_KEY, JSON.stringify(p));
  return p;
}

function stepFraction(step?: string | null): number {
  if (!step) return 0.15;
  const m = step.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b > 0) return Math.min(0.95, a / b);
  }
  return 0.35;
}

function write(p: SyncProgress): SyncProgress {
  p.updatedAt = nowIso();
  const done = p.queue.filter((q) => q.status === "done" || q.status === "skipped").length;
  const active = p.queue.find((q) => q.status === "active");
  const activeFrac = active ? stepFraction(active.step) : 0;
  const total = Math.max(p.queue.length, 1);
  p.percent =
    p.status === "done" ? 100 : Math.min(99, Math.round(((done + activeFrac) / total) * 100));
  p.current = active ?? null;
  setMeta(META_KEY, JSON.stringify(p));
  return p;
}

export function beginExpandSync(opts: {
  leagueIds: number[];
  tmCompetitions: string[];
  mantraTournaments: number[];
  skipAf?: boolean;
  skipTm?: boolean;
  skipMantra?: boolean;
  skipManagers?: boolean;
}): SyncProgress {
  const queue: SyncQueueItem[] = [];
  if (!opts.skipAf) {
    for (const id of opts.leagueIds) {
      const def = leagueById(id);
      queue.push({
        kind: "af",
        key: `af:${id}`,
        name: def?.name ?? `AF ${id}`,
        status: "pending",
      });
    }
  }
  if (!opts.skipTm) {
    for (const code of opts.tmCompetitions) {
      queue.push({ kind: "tm", key: `tm:${code}`, name: `TM ${code}`, status: "pending" });
    }
  }
  if (!opts.skipMantra) {
    for (const tid of opts.mantraTournaments) {
      queue.push({
        kind: "mantra",
        key: `mantra:${tid}`,
        name: `Mantra #${tid}`,
        status: "pending",
      });
    }
  }
  if (!opts.skipManagers) {
    for (const id of opts.leagueIds) {
      const def = leagueById(id);
      queue.push({
        kind: "managers",
        key: `managers:${id}`,
        name: `Managers · ${def?.name ?? id}`,
        status: "pending",
      });
    }
  }

  return write({
    ...emptyProgress(),
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    pid: process.pid,
    phase: queue[0]?.kind ?? "done",
    label: queue[0] ? `Старт: ${queue[0].name}` : "Пустая очередь",
    leagueIds: opts.leagueIds,
    tmCompetitions: opts.tmCompetitions,
    mantraTournaments: opts.mantraTournaments,
    queue,
    error: null,
  });
}

export function activateQueueItem(key: string, step?: string): SyncProgress {
  const p = readSyncProgress();
  for (const item of p.queue) {
    if (item.status === "active") item.status = "done";
  }
  const hit = p.queue.find((q) => q.key === key);
  if (hit) {
    hit.status = "active";
    hit.step = step ?? null;
    p.phase = hit.kind;
    p.label = step ? `${hit.name}: ${step}` : hit.name;
  }
  p.status = "running";
  return write(p);
}

export function updateQueueStep(key: string, step: string): SyncProgress {
  const p = readSyncProgress();
  const hit = p.queue.find((q) => q.key === key);
  if (hit) {
    hit.step = step;
    if (hit.status === "active") p.label = `${hit.name}: ${step}`;
  }
  return write(p);
}

export function completeQueueItem(
  key: string,
  status: "done" | "skipped" | "error" = "done",
): SyncProgress {
  const p = readSyncProgress();
  const hit = p.queue.find((q) => q.key === key);
  if (hit) {
    hit.status = status;
    hit.step = null;
  }
  const next = p.queue.find((q) => q.status === "pending");
  p.phase = next?.kind ?? "done";
  p.label = next ? `Далее: ${next.name}` : "Завершение…";
  return write(p);
}

export function finishExpandSync(error?: string): SyncProgress {
  const p = readSyncProgress();
  for (const item of p.queue) {
    if (item.status === "pending" || item.status === "active") {
      item.status = error ? "error" : "done";
    }
  }
  p.status = error ? "error" : "done";
  p.phase = "done";
  p.finishedAt = nowIso();
  p.error = error ?? null;
  p.label = error ? `Ошибка: ${error}` : "Sync завершён";
  p.percent = error ? p.percent : 100;
  p.current = null;
  return write(p);
}

function leagueIdForTm(competitionId: string): number | undefined {
  return Object.values(AF_LEAGUES).find((l) => l.tmCompetition === competitionId)?.id;
}

/** Progress slice relevant to a TM competition page (e.g. GB2). */
export function progressForCompetition(competitionId: string): {
  progress: SyncProgress;
  forThisLeague: {
    inQueue: boolean;
    items: SyncQueueItem[];
    position: number | null;
    remaining: number;
    activeHere: boolean;
  };
} {
  const progress = readSyncProgress();
  const leagueId = leagueIdForTm(competitionId);
  const def = leagueId != null ? leagueById(leagueId) : undefined;

  const items = progress.queue.filter((q) => {
    if (q.kind === "tm") return q.key === `tm:${competitionId}`;
    if (leagueId == null) return false;
    if (q.kind === "af") return q.key === `af:${leagueId}`;
    if (q.kind === "managers") return q.key === `managers:${leagueId}`;
    if (q.kind === "mantra") {
      return def?.mantraTournamentId != null && q.key === `mantra:${def.mantraTournamentId}`;
    }
    return false;
  });

  const pendingOrActive = progress.queue.filter(
    (q) => q.status === "pending" || q.status === "active",
  );
  const firstMine = items.find((q) => q.status === "pending" || q.status === "active");
  const position = firstMine
    ? pendingOrActive.findIndex((q) => q.key === firstMine.key) + 1
    : null;

  return {
    progress,
    forThisLeague: {
      inQueue: items.length > 0,
      items,
      position: position && position > 0 ? position : null,
      remaining: pendingOrActive.length,
      activeHere: items.some((q) => q.status === "active"),
    },
  };
}
