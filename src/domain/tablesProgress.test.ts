import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  getTablesLeagueProgress,
  percentFromCounts,
  tablesProgressPayload,
  writeTablesJobProgress,
} from "./tablesProgress.js";

test("percentFromCounts weights results, players, FotMob sheets, and tours", () => {
  assert.equal(
    percentFromCounts({
      divisionsDone: 0,
      divisionsTotal: 4,
      resultsDone: 0,
      resultsTotal: 4,
      playersListed: 0,
      fotmobMatches: 0,
      fotmobFinished: 0,
      fotmobSheets: 0,
      toursDivisions: 0,
    }),
    0,
  );
  assert.equal(
    percentFromCounts({
      divisionsDone: 4,
      divisionsTotal: 4,
      resultsDone: 4,
      resultsTotal: 4,
      playersListed: 10,
      fotmobMatches: 80,
      fotmobFinished: 40,
      fotmobSheets: 40,
      toursDivisions: 4,
    }),
    100,
  );
  const halfResults = percentFromCounts({
    divisionsDone: 2,
    divisionsTotal: 4,
    resultsDone: 2,
    resultsTotal: 4,
    playersListed: 0,
    fotmobMatches: 0,
    fotmobFinished: 0,
    fotmobSheets: 0,
    toursDivisions: 0,
  });
  assert.equal(halfResults, 23);
});

test("GET payload rejects unknown slugs via live lookup, not empty objects", () => {
  const missing = tablesProgressPayload("not-a-league");
  assert.equal(missing.progress, null);
  assert.equal(missing.extra, false);
  const extra = tablesProgressPayload("jupiler-pro-league");
  assert.equal(extra.extra, true);
  assert.equal(extra.progress?.slug, "jupiler-pro-league");
  assert.equal(extra.progress?.complete, false);
  assert.ok((extra.progress?.percent ?? 0) < 100);
});

test("job checkpoint is merged and reread from sqlite", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  writeTablesJobProgress(
    "ligue-1",
    { status: "running", phase: "results", lastDivisionId: 732 },
    db,
  );
  const again = writeTablesJobProgress("ligue-1", { lastFotmobMatchId: 99, phase: "fotmob" }, db);
  assert.equal(again.status, "running");
  assert.equal(again.phase, "fotmob");
  assert.equal(again.lastDivisionId, 732);
  assert.equal(again.lastFotmobMatchId, 99);
  const view = getTablesLeagueProgress("ligue-1", db);
  assert.equal(view?.status, "running");
  assert.equal(view?.phase, "fotmob");
  assert.match(view?.label ?? "", /дивизионы/);
});
