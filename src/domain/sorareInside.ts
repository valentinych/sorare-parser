import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

export const IMPORT_CODE_TTL_MS = 10 * 60_000;
export const PROJECTION_TTL_MS = 24 * 60 * 60_000;
export const MAX_IMPORT_PROJECTIONS = 200;

const PROJECTION_KEYS = new Set([
  "clientCardId",
  "playerId",
  "playerSlug",
  "gameId",
  "teamSlug",
  "projectedScore",
  "startingPercentage",
  "reliability",
  "teamWinOdds",
  "playerExpectedGoals",
  "teamCleanSheetOdds",
  "cardPosition",
]);
const SAFE_ID = /^[A-Za-z0-9:_.,|/-]+$/;
const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;
const POSITIONS = new Set(["GK", "DEF", "MID", "FWD"]);

export class SorareImportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

export type ImportedProjection = {
  clientCardId: string | null;
  playerId: string | null;
  playerSlug: string | null;
  gameId: string;
  teamSlug: string | null;
  projectedScore: number | null;
  startingPercentage: number | null;
  reliability: string | null;
  teamWinOdds: number | null;
  playerExpectedGoals: number | null;
  teamCleanSheetOdds: number | null;
  cardPosition: "GK" | "DEF" | "MID" | "FWD";
};

type ProjectionRow = {
  clientCardId: string | null;
  playerId: string | null;
  playerSlug: string | null;
  gameId: string;
  teamSlug: string | null;
  projectedScore: number | null;
  startingPercentage: number | null;
  reliability: string | null;
  teamWinOdds: number | null;
  playerExpectedGoals: number | null;
  teamCleanSheetOdds: number | null;
  cardPosition: "GK" | "DEF" | "MID" | "FWD";
  importedAt: number;
  expiresAt: number;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SorareImportError("invalid_import_payload");
  }
  return value as Record<string, unknown>;
}

function optionalText(
  value: unknown,
  maxLength: number,
  pattern: RegExp,
): string | null {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new SorareImportError("invalid_import_projection");
  }
  return value;
}

function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new SorareImportError("invalid_import_projection");
  }
  return value;
}

export function normalizeImportedProjection(value: unknown): ImportedProjection {
  const row = object(value);
  if (Object.keys(row).some((key) => !PROJECTION_KEYS.has(key))) {
    throw new SorareImportError("invalid_import_projection");
  }

  const playerId = optionalText(row.playerId, 160, SAFE_ID);
  const playerSlug = optionalText(row.playerSlug, 160, SAFE_SLUG);
  const gameId = optionalText(row.gameId, 160, SAFE_ID);
  const rawPosition =
    typeof row.cardPosition === "string" ? row.cardPosition.trim().toUpperCase() : "";
  const position = rawPosition === "FW" ? "FWD" : rawPosition;
  if (!gameId || (!playerId && !playerSlug) || !POSITIONS.has(position)) {
    throw new SorareImportError("invalid_import_projection");
  }

  const projectedScore = optionalNumber(row.projectedScore, 0, 200);
  const startingPercentage = optionalNumber(row.startingPercentage, 0, 100);
  const teamWinOdds = optionalNumber(row.teamWinOdds, 0, 100);
  const playerExpectedGoals = optionalNumber(row.playerExpectedGoals, 0, 10);
  const teamCleanSheetOdds = optionalNumber(row.teamCleanSheetOdds, 0, 100);
  if (
    projectedScore == null &&
    startingPercentage == null &&
    teamWinOdds == null &&
    playerExpectedGoals == null &&
    teamCleanSheetOdds == null
  ) {
    throw new SorareImportError("empty_import_projection");
  }

  return {
    clientCardId: optionalText(row.clientCardId, 300, SAFE_ID),
    playerId,
    playerSlug,
    gameId,
    teamSlug: optionalText(row.teamSlug, 160, SAFE_SLUG),
    projectedScore,
    startingPercentage,
    reliability: optionalText(row.reliability, 30, /^[A-Za-z0-9 _-]+$/),
    teamWinOdds,
    playerExpectedGoals,
    teamCleanSheetOdds,
    cardPosition: position as ImportedProjection["cardPosition"],
  };
}

export function normalizeImportRequest(value: unknown): {
  code: string;
  projections: ImportedProjection[];
} {
  const body = object(value);
  if (
    Object.keys(body).some((key) => key !== "code" && key !== "projections") ||
    typeof body.code !== "string" ||
    !/^mi_[A-Za-z0-9_-]{32}$/.test(body.code) ||
    !Array.isArray(body.projections) ||
    body.projections.length < 1 ||
    body.projections.length > MAX_IMPORT_PROJECTIONS
  ) {
    throw new SorareImportError("invalid_import_payload");
  }

  const unique = new Map<string, ImportedProjection>();
  for (const value of body.projections) {
    const projection = normalizeImportedProjection(value);
    const playerKey = projection.playerSlug
      ? `slug:${projection.playerSlug}`
      : `id:${projection.playerId}`;
    unique.set(`${projection.gameId}:${playerKey}`, projection);
  }
  return { code: body.code, projections: [...unique.values()] };
}

export function createSorareImportCode(
  userId: number,
  now = Date.now(),
): { code: string; expiresAt: number } {
  const code = `mi_${randomBytes(24).toString("base64url")}`;
  const expiresAt = now + IMPORT_CODE_TTL_MS;
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM sorare_import_codes WHERE expires_at <= ?`).run(now);
    db.prepare(
      `DELETE FROM sorare_import_codes
       WHERE user_id = ? AND consumed_at IS NULL`,
    ).run(userId);
    db.prepare(
      `INSERT INTO sorare_import_codes
         (code_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(hash(code), userId, now, expiresAt);
  })();
  return { code, expiresAt };
}

export function importSorareProjections(
  request: { code: string; projections: ImportedProjection[] },
  now = Date.now(),
): { imported: number; status: SorareInsideConnectionStatus } {
  const db = getDb();
  const result = db.transaction(() => {
    const codeHash = hash(request.code);
    const code = db
      .prepare(
        `SELECT user_id AS userId, expires_at AS expiresAt, consumed_at AS consumedAt
         FROM sorare_import_codes WHERE code_hash = ?`,
      )
      .get(codeHash) as
      | { userId: number; expiresAt: number; consumedAt: number | null }
      | undefined;
    if (!code) throw new SorareImportError("invalid_import_code", 401);
    if (code.consumedAt != null) throw new SorareImportError("import_code_used", 409);
    if (code.expiresAt <= now) throw new SorareImportError("import_code_expired", 410);

    const consumed = db.prepare(
      `UPDATE sorare_import_codes SET consumed_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    ).run(now, codeHash, now);
    if (consumed.changes !== 1) throw new SorareImportError("import_code_used", 409);

    db.prepare(`DELETE FROM user_sorare_projections WHERE expires_at <= ?`).run(now);
    const expiresAt = now + PROJECTION_TTL_MS;
    const upsert = db.prepare(
      `INSERT INTO user_sorare_projections
         (user_id, game_id, player_key, client_card_id, player_id, player_slug,
          team_slug, projected_score, starting_percentage, reliability,
          team_win_odds, player_expected_goals, team_clean_sheet_odds,
          card_position, imported_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game_id, player_key) DO UPDATE SET
         client_card_id = excluded.client_card_id,
         player_id = excluded.player_id,
         player_slug = excluded.player_slug,
         team_slug = excluded.team_slug,
         projected_score = excluded.projected_score,
         starting_percentage = excluded.starting_percentage,
         reliability = excluded.reliability,
         team_win_odds = excluded.team_win_odds,
         player_expected_goals = excluded.player_expected_goals,
         team_clean_sheet_odds = excluded.team_clean_sheet_odds,
         card_position = excluded.card_position,
         imported_at = excluded.imported_at,
         expires_at = excluded.expires_at`,
    );
    for (const projection of request.projections) {
      const playerKey = projection.playerSlug
        ? `slug:${projection.playerSlug}`
        : `id:${projection.playerId}`;
      upsert.run(
        code.userId,
        projection.gameId,
        playerKey,
        projection.clientCardId,
        projection.playerId,
        projection.playerSlug,
        projection.teamSlug,
        projection.projectedScore,
        projection.startingPercentage,
        projection.reliability,
        projection.teamWinOdds,
        projection.playerExpectedGoals,
        projection.teamCleanSheetOdds,
        projection.cardPosition,
        now,
        expiresAt,
      );
    }
    return { userId: code.userId };
  })();

  return {
    imported: request.projections.length,
    status: sorareInsideConnectionStatus(result.userId, now),
  };
}

export type SorareInsideConnectionStatus = {
  source: "browser_import";
  configured: true;
  enabled: true;
  connected: boolean;
  status: "imported" | "empty";
  importedAt: number | null;
  expiresAt: number | null;
  count: number;
};

export function sorareInsideConnectionStatus(
  userId: number | null,
  now = Date.now(),
): SorareInsideConnectionStatus {
  if (userId == null) {
    return {
      source: "browser_import",
      configured: true,
      enabled: true,
      connected: false,
      status: "empty",
      importedAt: null,
      expiresAt: null,
      count: 0,
    };
  }
  const db = getDb();
  db.prepare(`DELETE FROM user_sorare_projections WHERE expires_at <= ?`).run(now);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(imported_at) AS importedAt,
              MAX(expires_at) AS expiresAt
       FROM user_sorare_projections
       WHERE user_id = ? AND expires_at > ?`,
    )
    .get(userId, now) as {
    count: number;
    importedAt: number | null;
    expiresAt: number | null;
  };
  return {
    source: "browser_import",
    configured: true,
    enabled: true,
    connected: row.count > 0,
    status: row.count > 0 ? "imported" : "empty",
    importedAt: row.importedAt,
    expiresAt: row.expiresAt,
    count: row.count,
  };
}

export function disconnectSorareInside(userId: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM sorare_import_codes WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM user_sorare_projections WHERE user_id = ?`).run(userId);
  })();
}

export function getPrivateSorareInsideProjections(
  userId: number,
  gameId: string,
  now = Date.now(),
): {
  projections: Array<ImportedProjection & {
    source: "companion_dom";
    playerName: string;
    importedAt: number;
  }>;
  fetchedAt: number;
  expiresAt: number;
  cached: false;
} {
  const db = getDb();
  db.prepare(`DELETE FROM user_sorare_projections WHERE expires_at <= ?`).run(now);
  const rows = db
    .prepare(
      `SELECT client_card_id AS clientCardId, player_id AS playerId,
              player_slug AS playerSlug, game_id AS gameId, team_slug AS teamSlug,
              projected_score AS projectedScore,
              starting_percentage AS startingPercentage, reliability,
              team_win_odds AS teamWinOdds,
              player_expected_goals AS playerExpectedGoals,
              team_clean_sheet_odds AS teamCleanSheetOdds,
              card_position AS cardPosition, imported_at AS importedAt,
              expires_at AS expiresAt
       FROM user_sorare_projections
       WHERE user_id = ? AND game_id = ? AND expires_at > ?
       ORDER BY player_slug, player_id`,
    )
    .all(userId, gameId, now) as ProjectionRow[];
  return {
    projections: rows.map((row) => ({
      ...row,
      source: "companion_dom",
      playerName: row.playerSlug ?? row.playerId ?? "",
    })),
    fetchedAt: rows.reduce((latest, row) => Math.max(latest, row.importedAt), 0),
    expiresAt: rows.reduce((latest, row) => Math.max(latest, row.expiresAt), 0),
    cached: false,
  };
}
