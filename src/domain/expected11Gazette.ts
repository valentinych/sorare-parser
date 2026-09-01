import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GAZETTES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "expected11",
  "gazettes",
);

export function defaultExpected11GazettesDir(): string {
  return DEFAULT_GAZETTES_DIR;
}

export function expected11GazetteFileName(leagueSlug: string, tour: number): string {
  return `${leagueSlug}-${tour}.pdf`;
}

function isPdfMagic(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(5);
    if (readSync(fd, buf, 0, 5, 0) < 5) return false;
    return buf.toString("latin1") === "%PDF-";
  } finally {
    closeSync(fd);
  }
}

export function expected11GazetteFile(
  leagueSlug: string,
  tour: number,
  dir = DEFAULT_GAZETTES_DIR,
): string | null {
  if (!/^[a-z0-9-]+$/.test(leagueSlug) || !Number.isInteger(tour) || tour < 1 || tour > 99) {
    return null;
  }
  const resolvedDir = path.resolve(dir);
  const file = path.resolve(resolvedDir, expected11GazetteFileName(leagueSlug, tour));
  if (path.dirname(file) !== resolvedDir) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size < 5 || !isPdfMagic(file)) return null;
    return file;
  } catch {
    return null;
  }
}

export function expected11GazetteView(
  leagueSlug: string,
  tour: number | null,
  dir = DEFAULT_GAZETTES_DIR,
): { url: string } | null {
  if (tour == null) return null;
  const file = expected11GazetteFile(leagueSlug, tour, dir);
  if (!file) return null;
  const v = Math.trunc(statSync(file).mtimeMs);
  return {
    url: `/api/expected11/gazette/${encodeURIComponent(leagueSlug)}/${tour}?v=${v}`,
  };
}
