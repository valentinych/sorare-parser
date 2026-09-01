import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import {
  createSorareImportCode,
  getPrivateSorareInsideProjections,
  importSorareProjections,
  IMPORT_CODE_TTL_MS,
  normalizeImportRequest,
  PROJECTION_TTL_MS,
  SorareImportError,
  sorareInsideConnectionStatus,
} from "./sorareInside.js";

config.dbPath = `/tmp/mantra-sorare-browser-import-${process.pid}.db`;
const db = getDb();

function user(id: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO app_users (id, google_sub, email) VALUES (?, ?, ?)`,
  ).run(id, `google-${id}`, `user-${id}@example.test`);
}

function projection(playerSlug = "fixture-player") {
  return {
    clientCardId: `card|Game:fixture||FWD`,
    playerId: "Player:fixture",
    playerSlug,
    gameId: "Game:fixture",
    teamSlug: null,
    projectedScore: 61,
    startingPercentage: 82.5,
    reliability: "high",
    teamWinOdds: 57,
    playerExpectedGoals: 0.31,
    teamCleanSheetOdds: null,
    cardPosition: "FW",
  };
}

test("strictly accepts only sanitized projection fields", () => {
  const normalized = normalizeImportRequest({
    code: `mi_${"a".repeat(32)}`,
    projections: [projection()],
  });
  assert.equal(normalized.projections[0]?.cardPosition, "FWD");
  assert.equal(normalized.projections[0]?.startingPercentage, 82.5);
  assert.equal(JSON.stringify(normalized).includes("token"), false);

  assert.throws(
    () =>
      normalizeImportRequest({
        code: `mi_${"a".repeat(32)}`,
        projections: [{ ...projection(), token: "must-not-pass" }],
      }),
    (error: unknown) =>
      error instanceof SorareImportError &&
      error.code === "invalid_import_projection",
  );
  assert.throws(
    () =>
      normalizeImportRequest({
        code: `mi_${"a".repeat(32)}`,
        projections: [{ ...projection(), projectedScore: 999 }],
      }),
    SorareImportError,
  );
});

test("isolates imported projections by owner and applies TTL", () => {
  user(101);
  user(102);
  const now = 1_800_000_000_000;
  const { code } = createSorareImportCode(101, now);
  const request = normalizeImportRequest({ code, projections: [projection()] });
  const result = importSorareProjections(request, now + 1_000);

  assert.equal(result.imported, 1);
  assert.equal(sorareInsideConnectionStatus(101, now + 1_001).count, 1);
  assert.equal(sorareInsideConnectionStatus(102, now + 1_001).count, 0);
  assert.equal(
    getPrivateSorareInsideProjections(101, "Game:fixture", now + 1_001)
      .projections.length,
    1,
  );
  assert.equal(
    getPrivateSorareInsideProjections(102, "Game:fixture", now + 1_001)
      .projections.length,
    0,
  );
  assert.equal(
    getPrivateSorareInsideProjections(
      101,
      "Game:fixture",
      now + 1_000 + PROJECTION_TTL_MS,
    ).projections.length,
    0,
  );
});

test("one-time import codes expire and cannot be replayed", () => {
  user(103);
  const now = 1_900_000_000_000;
  const first = createSorareImportCode(103, now);
  const request = normalizeImportRequest({
    code: first.code,
    projections: [projection("replay-player")],
  });
  importSorareProjections(request, now + 1);
  assert.throws(
    () => importSorareProjections(request, now + 2),
    (error: unknown) =>
      error instanceof SorareImportError && error.code === "import_code_used",
  );

  const expired = createSorareImportCode(103, now + 10_000);
  const expiredRequest = normalizeImportRequest({
    code: expired.code,
    projections: [projection("expired-player")],
  });
  assert.throws(
    () =>
      importSorareProjections(
        expiredRequest,
        now + 10_000 + IMPORT_CODE_TTL_MS,
      ),
    (error: unknown) =>
      error instanceof SorareImportError &&
      error.code === "import_code_expired",
  );
});
