import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  jsonSavedTourUrlsStore,
  memorySavedTourUrlsStore,
} from "./expected11SavedUrls.js";

test("memory store keeps championship tours separate", async () => {
  const store = memorySavedTourUrlsStore();
  await store.set("championship", 3, [
    "https://expected11.com/match/1/a",
    "https://expected11.com/match/2/b",
  ]);
  await store.set("championship", 2, ["https://expected11.com/match/9/c"]);

  assert.deepEqual(await store.get("championship", 3), [
    "https://expected11.com/match/1/a",
    "https://expected11.com/match/2/b",
  ]);
  assert.deepEqual(await store.get("championship", 2), [
    "https://expected11.com/match/9/c",
  ]);
  assert.deepEqual(await store.get("premier-league", 3), []);
});

test("JSON store survives a new store instance on the same file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "expected11-urls-"));
  const filePath = path.join(dir, "saved-tour-urls.json");
  const first = jsonSavedTourUrlsStore(filePath);
  await first.set("championship", 3, ["https://expected11.com/match/1/a"]);

  const second = jsonSavedTourUrlsStore(filePath);
  assert.deepEqual(await second.get("championship", 3), [
    "https://expected11.com/match/1/a",
  ]);
  const saved = JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    string[]
  >;
  assert.deepEqual(saved["championship:3"], ["https://expected11.com/match/1/a"]);
});
