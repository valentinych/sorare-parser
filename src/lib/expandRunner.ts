import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSyncProgress } from "./syncProgress.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = "/tmp/sync-expand.log";
const DEFAULT_ARGS = ["--skip-mantra-profiles", "--sample=60"];

let child: ChildProcess | null = null;

function isChildAlive(): boolean {
  return Boolean(child?.pid && child.exitCode == null && !child.killed);
}

export function expandRunnerStatus(): {
  running: boolean;
  pid: number | null;
  log: string;
  progress: ReturnType<typeof readSyncProgress>;
} {
  const progress = readSyncProgress();
  return {
    running: isChildAlive() || (progress.status === "running" && progress.pid != null),
    pid: child?.pid ?? progress.pid,
    log: LOG,
    progress,
  };
}

/** Start expand as a child of the TM server (survives agent shell cleanup). */
export function startExpandSync(extraArgs: string[] = []): {
  ok: boolean;
  pid?: number;
  error?: string;
  alreadyRunning?: boolean;
} {
  if (isChildAlive()) {
    return { ok: false, alreadyRunning: true, pid: child!.pid ?? undefined, error: "already running" };
  }

  // Drop stale handle
  child = null;

  const out = fs.openSync(LOG, "a");
  const args = ["tsx", "src/sync/runExpandLeagues.ts", ...DEFAULT_ARGS, ...extraArgs];
  const proc = spawn("npx", args, {
    cwd: ROOT,
    env: process.env,
    detached: false,
    stdio: ["ignore", out, out],
  });

  child = proc;
  proc.on("exit", (code, signal) => {
    fs.writeSync(
      out,
      `\n[expandRunner] exited code=${code} signal=${signal} at ${new Date().toISOString()}\n`,
    );
    if (child === proc) child = null;
  });

  return { ok: true, pid: proc.pid ?? undefined };
}

export function stopExpandSync(): { ok: boolean; error?: string } {
  if (!child?.pid) return { ok: false, error: "not running" };
  try {
    child.kill("SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
