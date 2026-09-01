import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SavedTourUrlsStore = {
  get(league: string, tour: number): Promise<string[]>;
  set(league: string, tour: number, urls: string[]): Promise<void>;
};

function tourKey(league: string, tour: number): string {
  return `${league}:${tour}`;
}

function asUrlMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, urls] of Object.entries(value)) {
    if (!Array.isArray(urls)) continue;
    result[key] = urls.filter((url): url is string => typeof url === "string");
  }
  return result;
}

export function memorySavedTourUrlsStore(
  initial: Record<string, string[]> = {},
): SavedTourUrlsStore {
  const data = new Map(Object.entries(initial).map(([key, urls]) => [key, [...urls]]));
  return {
    async get(league, tour) {
      return [...(data.get(tourKey(league, tour)) ?? [])];
    },
    async set(league, tour, urls) {
      const key = tourKey(league, tour);
      if (urls.length === 0) data.delete(key);
      else data.set(key, [...urls]);
    },
  };
}

export function jsonSavedTourUrlsStore(filePath: string): SavedTourUrlsStore {
  async function readAll(): Promise<Record<string, string[]>> {
    try {
      return asUrlMap(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async function writeAll(data: Record<string, string[]>): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpPath, filePath);
  }

  return {
    async get(league, tour) {
      const all = await readAll();
      return all[tourKey(league, tour)] ?? [];
    },
    async set(league, tour, urls) {
      const all = await readAll();
      const key = tourKey(league, tour);
      if (urls.length === 0) delete all[key];
      else all[key] = [...urls];
      await writeAll(all);
    },
  };
}
