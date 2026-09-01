import { timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const MAX_MANTRA_AUCTION_IMPORT_BYTES = 256 * 1024;
export const MAX_MANTRA_AUCTION_BATCH_PLAYERS = 75;
export const MAX_MANTRA_AUCTION_HISTORY_ROWS = 200;
export const MANTRA_AUCTION_SCOPE_KEYS = [
  "super-lig",
  "championship",
  "ekstraklasa",
  "bundesliga",
  "premier-league",
  "serie-a",
] as const;
export const MAX_MANTRA_AUCTION_SCOPE_LEAGUES = 48;

export type MantraAuctionScopeKey = (typeof MANTRA_AUCTION_SCOPE_KEYS)[number];
type JobStatus = "pending" | "discovering" | "running" | "partial" | "complete" | "error";
type JsonRecord = Record<string, unknown>;
const MANTRA_IMAGE_ORIGIN = "https://mantrafootball.s3.eu-west-1.amazonaws.com";
const MANTRA_IMAGE_PATHS = ["/player_avatars/", "/club_logo/", "/teams/", "/user_logos/"];

export const MANTRA_AUCTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mantra_auction_jobs (
  scope_key TEXT PRIMARY KEY,
  scope_name TEXT NOT NULL,
  mantra_league_ids_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','discovering','running','partial','complete','error')),
  phase TEXT NOT NULL,
  completed_units INTEGER NOT NULL DEFAULT 0,
  total_units INTEGER,
  percent REAL,
  last_error TEXT,
  request_starts INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  responses_429 INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS mantra_auction_leagues (
  mantra_league_id INTEGER PRIMARY KEY,
  scope_key TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  division TEXT,
  season_id INTEGER,
  tournament_id INTEGER NOT NULL,
  registry_status TEXT,
  access_state TEXT NOT NULL CHECK (
    access_state IN ('accessible','restricted','unavailable','archived')
  ),
  auction_state TEXT NOT NULL CHECK (
    auction_state IN ('available','no-auction','restricted','unavailable','archived')
  ),
  auction_ids_json TEXT NOT NULL,
  source_url TEXT NOT NULL,
  evidence TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  FOREIGN KEY (scope_key) REFERENCES mantra_auction_jobs(scope_key)
);

CREATE INDEX IF NOT EXISTS idx_mantra_auction_leagues_scope
  ON mantra_auction_leagues(scope_key, mantra_league_id);

CREATE TABLE IF NOT EXISTS mantra_auctions (
  mantra_league_id INTEGER NOT NULL,
  auction_id INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  status TEXT,
  label TEXT,
  league_label TEXT,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (mantra_league_id, auction_id),
  FOREIGN KEY (scope_key) REFERENCES mantra_auction_jobs(scope_key)
);

CREATE INDEX IF NOT EXISTS idx_mantra_auctions_scope
  ON mantra_auctions(scope_key, auction_id);

CREATE TABLE IF NOT EXISTS mantra_auction_stages (
  mantra_league_id INTEGER NOT NULL,
  auction_id INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  player_bid_ids_json TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (mantra_league_id, auction_id, stage),
  FOREIGN KEY (mantra_league_id, auction_id)
    REFERENCES mantra_auctions(mantra_league_id, auction_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mantra_auction_players (
  mantra_league_id INTEGER NOT NULL,
  auction_id INTEGER NOT NULL,
  player_bid_id INTEGER NOT NULL,
  mantra_player_id INTEGER NOT NULL,
  first_name TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  positions_json TEXT NOT NULL,
  positions_italian_json TEXT NOT NULL,
  club_id INTEGER,
  club_name TEXT,
  club_logo_url TEXT,
  status TEXT,
  final_price REAL,
  source_url TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (mantra_league_id, auction_id, player_bid_id),
  FOREIGN KEY (mantra_league_id, auction_id)
    REFERENCES mantra_auctions(mantra_league_id, auction_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mantra_auction_players_search
  ON mantra_auction_players(mantra_league_id, auction_id, name, first_name);

CREATE TABLE IF NOT EXISTS mantra_auction_player_stages (
  mantra_league_id INTEGER NOT NULL,
  auction_id INTEGER NOT NULL,
  player_bid_id INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  outcome TEXT,
  winning_price REAL,
  winning_team_id INTEGER,
  winning_team_name TEXT,
  winning_team_logo_url TEXT,
  sync_run_id TEXT NOT NULL,
  PRIMARY KEY (mantra_league_id, auction_id, player_bid_id, stage),
  FOREIGN KEY (mantra_league_id, auction_id, player_bid_id)
    REFERENCES mantra_auction_players(mantra_league_id, auction_id, player_bid_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mantra_auction_bids (
  mantra_league_id INTEGER NOT NULL,
  auction_id INTEGER NOT NULL,
  player_bid_id INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  bid_id INTEGER NOT NULL,
  bid_order INTEGER NOT NULL,
  status TEXT,
  price REAL,
  fantasy_team_id INTEGER,
  fantasy_team_name TEXT,
  fantasy_team_logo_url TEXT,
  sync_run_id TEXT NOT NULL,
  PRIMARY KEY (mantra_league_id, auction_id, bid_id),
  FOREIGN KEY (mantra_league_id, auction_id, player_bid_id, stage)
    REFERENCES mantra_auction_player_stages(
      mantra_league_id, auction_id, player_bid_id, stage
    ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mantra_auction_bids_player
  ON mantra_auction_bids(mantra_league_id, auction_id, player_bid_id, stage, bid_order);
`;

export class MantraAuctionImportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

function record(value: unknown, code = "invalid_mantra_auction_payload"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MantraAuctionImportError(code);
  }
  return value as JsonRecord;
}

function array(value: unknown, code: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new MantraAuctionImportError(code);
  }
  return value;
}

function stringValue(
  value: unknown,
  code: string,
  max: number,
  nullable = false,
): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new MantraAuctionImportError(code);
  }
  return value.trim();
}

function integer(value: unknown, code: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new MantraAuctionImportError(code);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MantraAuctionImportError(code);
  }
  return value as number;
}

function numberValue(value: unknown, code: string, nullable = false): number | null {
  if (nullable && value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) {
    throw new MantraAuctionImportError(code);
  }
  return value;
}

function isoDate(value: unknown, code: string): string {
  const result = stringValue(value, code, 40);
  if (!result || !Number.isFinite(Date.parse(result))) {
    throw new MantraAuctionImportError(code);
  }
  return result;
}

function sourceUrl(value: unknown, expectedPath: RegExp): string {
  const raw = stringValue(value, "invalid_mantra_auction_source_url", 500)!;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mantrafootball.org" ||
      url.username ||
      url.password ||
      url.port ||
      !expectedPath.test(url.pathname)
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new MantraAuctionImportError("invalid_mantra_auction_source_url");
  }
}

export function normalizeMantraImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return null;
  try {
    const url = new URL(value.trim(), `${MANTRA_IMAGE_ORIGIN}/`);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mantrafootball.s3.eu-west-1.amazonaws.com" ||
      url.port ||
      url.username ||
      url.password ||
      !MANTRA_IMAGE_PATHS.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function mantraImageUrl(value: unknown, code: string): string | null {
  if (value == null) return null;
  const normalized = normalizeMantraImageUrl(value);
  if (!normalized) throw new MantraAuctionImportError(code);
  return normalized;
}

function scopeKey(value: unknown): MantraAuctionScopeKey {
  if (!MANTRA_AUCTION_SCOPE_KEYS.includes(value as MantraAuctionScopeKey)) {
    throw new MantraAuctionImportError("invalid_mantra_auction_scope");
  }
  return value as MantraAuctionScopeKey;
}

function runId(value: unknown): string {
  const id = stringValue(value, "invalid_mantra_auction_run_id", 80)!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,79}$/.test(id)) {
    throw new MantraAuctionImportError("invalid_mantra_auction_run_id");
  }
  return id;
}

function stringArray(value: unknown, code: string, max: number): string[] {
  return array(value, code, max).map((item) => stringValue(item, code, 30)!);
}

function numericIds(value: unknown, code: string, max: number): number[] {
  const ids = array(value, code, max).map((item) => integer(item, code));
  if (new Set(ids).size !== ids.length) throw new MantraAuctionImportError(code);
  return ids;
}

export type NormalizedAuctionPlayer = {
  mantraLeagueId: number;
  auctionId: number;
  playerBidId: number;
  status: string | null;
  price: number | null;
  sourceUrl: string;
  fetchedAt: string;
  player: {
    id: number;
    firstName: string | null;
    name: string;
    avatarUrl: string | null;
    positions: string[];
    positionsItalian: string[];
    club: {
      id: number | null;
      name: string | null;
      logoUrl: string | null;
    } | null;
  };
  stages: Array<{
    stage: number;
    bids: Array<{
      id: number;
      order: number;
      status: string | null;
      price: number | null;
      team: {
        id: number | null;
        name: string | null;
        logoUrl: string | null;
      } | null;
    }>;
  }>;
};

export type MantraAuctionLeagueCoverage = {
  mantraLeagueId: number;
  name: string;
  division: string | null;
  seasonId: number | null;
  tournamentId: number;
  registryStatus: string | null;
  accessState: "accessible" | "restricted" | "unavailable" | "archived";
  auctionState: "available" | "no-auction" | "restricted" | "unavailable" | "archived";
  auctionIds: number[];
  sourceUrl: string;
  evidence: string;
  discoveredAt: string;
};

export type MantraAuctionImportPayload =
  | {
      schemaVersion: 1;
      operation: "seed";
      runId: string;
      startedAt: string;
      scopes: Array<{
        key: MantraAuctionScopeKey;
        name: string;
        mantraLeagueIds: number[];
      }>;
    }
  | {
      schemaVersion: 1;
      operation: "progress";
      runId: string;
      scopeKey: MantraAuctionScopeKey;
      status: JobStatus;
      phase: string;
      completed: number;
      total: number | null;
      error: string | null;
      requestStats: { requestStarts: number; retries: number; responses429: number };
      failedCount: number;
      lastRetryAt: string | null;
      updatedAt: string;
    }
  | {
      schemaVersion: 1;
      operation: "catalog";
      runId: string;
      scopeKey: MantraAuctionScopeKey;
      auctions: Array<{
        mantraLeagueId: number;
        auctionId: number;
        status: string | null;
        label: string | null;
        leagueLabel: string | null;
        sourceUrl: string;
        fetchedAt: string;
        stages: Array<{
          stage: number;
          sourceUrl: string;
          playerBidIds: number[];
        }>;
      }>;
    }
  | {
      schemaVersion: 1;
      operation: "coverage";
      runId: string;
      scopeKey: MantraAuctionScopeKey;
      leagues: MantraAuctionLeagueCoverage[];
    }
  | {
      schemaVersion: 1;
      operation: "batch";
      runId: string;
      scopeKey: MantraAuctionScopeKey;
      players: NormalizedAuctionPlayer[];
    }
  | {
      schemaVersion: 1;
      operation: "complete";
      runId: string;
      scopeKey: MantraAuctionScopeKey;
      completedAt: string;
      auctions: Array<{ mantraLeagueId: number; auctionId: number }>;
    };

function normalizePlayer(value: unknown): NormalizedAuctionPlayer {
  const input = record(value, "invalid_mantra_auction_player");
  const mantraLeagueId = integer(input.mantraLeagueId, "invalid_mantra_auction_league");
  const auctionId = integer(input.auctionId, "invalid_mantra_auction_id");
  const playerBidId = integer(input.playerBidId, "invalid_mantra_auction_player_bid");
  const playerInput = record(input.player, "invalid_mantra_auction_player");
  const clubInput = input.player && playerInput.club != null
    ? record(playerInput.club, "invalid_mantra_auction_club")
    : null;
  const stages = array(input.stages, "invalid_mantra_auction_stages", 30).map((value) => {
    const stageInput = record(value, "invalid_mantra_auction_stage");
    const stage = integer(stageInput.stage, "invalid_mantra_auction_stage", 100);
    const bids = array(stageInput.bids, "invalid_mantra_auction_bids", 100).map((value, index) => {
      const bid = record(value, "invalid_mantra_auction_bid");
      const order = integer(bid.order, "invalid_mantra_auction_bid_order", 100);
      if (order !== index + 1) throw new MantraAuctionImportError("invalid_mantra_auction_bid_order");
      const team = bid.team == null ? null : record(bid.team, "invalid_mantra_auction_team");
      return {
        id: integer(bid.id, "invalid_mantra_auction_bid"),
        order,
        status: stringValue(bid.status, "invalid_mantra_auction_bid_status", 40, true),
        price: numberValue(bid.price, "invalid_mantra_auction_price", true),
        team: team
          ? {
              id: team.id == null ? null : integer(team.id, "invalid_mantra_auction_team"),
              name: stringValue(team.name, "invalid_mantra_auction_team", 160, true),
              logoUrl: normalizeMantraImageUrl(team.logoUrl),
            }
          : null,
      };
    });
    return { stage, bids };
  });
  if (new Set(stages.map((stage) => stage.stage)).size !== stages.length) {
    throw new MantraAuctionImportError("invalid_mantra_auction_stages");
  }
  return {
    mantraLeagueId,
    auctionId,
    playerBidId,
    status: stringValue(input.status, "invalid_mantra_auction_status", 40, true),
    price: numberValue(input.price, "invalid_mantra_auction_price", true),
    sourceUrl: sourceUrl(input.sourceUrl, new RegExp(`^/api/player_bids/${playerBidId}$`)),
    fetchedAt: isoDate(input.fetchedAt, "invalid_mantra_auction_fetched_at"),
    player: {
      id: integer(playerInput.id, "invalid_mantra_auction_player"),
      firstName: stringValue(playerInput.firstName, "invalid_mantra_auction_player_name", 100, true),
      name: stringValue(playerInput.name, "invalid_mantra_auction_player_name", 120)!,
      avatarUrl: mantraImageUrl(playerInput.avatarUrl, "invalid_mantra_auction_avatar_url"),
      positions: stringArray(playerInput.positions, "invalid_mantra_auction_positions", 12),
      positionsItalian: stringArray(
        playerInput.positionsItalian,
        "invalid_mantra_auction_positions",
        12,
      ),
      club: clubInput
        ? {
            id:
              clubInput.id == null
                ? null
                : integer(clubInput.id, "invalid_mantra_auction_club"),
            name: stringValue(
              clubInput.name,
              "invalid_mantra_auction_club",
              160,
              true,
            ),
            logoUrl: normalizeMantraImageUrl(clubInput.logoUrl),
          }
        : null,
    },
    stages,
  };
}

export function normalizeMantraAuctionImport(value: unknown): MantraAuctionImportPayload {
  const serialized = JSON.stringify(value);
  if (serialized && Buffer.byteLength(serialized) > MAX_MANTRA_AUCTION_IMPORT_BYTES) {
    throw new MantraAuctionImportError("mantra_auction_payload_too_large", 413);
  }
  const input = record(value);
  if (input.schemaVersion !== 1) {
    throw new MantraAuctionImportError("unsupported_mantra_auction_schema");
  }
  const operation = input.operation;
  const normalizedRunId = runId(input.runId);
  if (operation === "seed") {
    const scopes = array(
      input.scopes,
      "invalid_mantra_auction_scopes",
      MANTRA_AUCTION_SCOPE_KEYS.length,
    ).map((value) => {
      const scope = record(value, "invalid_mantra_auction_scope");
      return {
        key: scopeKey(scope.key),
        name: stringValue(scope.name, "invalid_mantra_auction_scope", 80)!,
        mantraLeagueIds: numericIds(
          scope.mantraLeagueIds,
          "invalid_mantra_auction_leagues",
          MAX_MANTRA_AUCTION_SCOPE_LEAGUES,
        ),
      };
    });
    if (
      scopes.length < 1 ||
      new Set(scopes.map((scope) => scope.key)).size !== scopes.length ||
      new Set(scopes.flatMap((scope) => scope.mantraLeagueIds)).size !==
        scopes.flatMap((scope) => scope.mantraLeagueIds).length
    ) {
      throw new MantraAuctionImportError("invalid_mantra_auction_scopes");
    }
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      startedAt: isoDate(input.startedAt, "invalid_mantra_auction_started_at"),
      scopes,
    };
  }
  const normalizedScopeKey = scopeKey(input.scopeKey);
  if (operation === "progress") {
    if (
      !["pending", "discovering", "running", "partial", "complete", "error"].includes(
        String(input.status),
      )
    ) {
      throw new MantraAuctionImportError("invalid_mantra_auction_status");
    }
    const completed = nonNegativeInteger(input.completed, "invalid_mantra_auction_progress");
    const total =
      input.total == null
        ? null
        : nonNegativeInteger(input.total, "invalid_mantra_auction_progress");
    if (total != null && completed > total) {
      throw new MantraAuctionImportError("invalid_mantra_auction_progress");
    }
    if (input.status === "complete" && (total == null || completed !== total)) {
      throw new MantraAuctionImportError("invalid_mantra_auction_completion");
    }
    const stats = record(input.requestStats, "invalid_mantra_auction_request_stats");
    const failedCount =
      input.failedCount == null
        ? 0
        : nonNegativeInteger(input.failedCount, "invalid_mantra_auction_failure_count");
    if (
      (input.status === "partial" &&
        (total == null ||
          completed + failedCount > total ||
          (completed < total && completed + failedCount !== total))) ||
      (input.status === "complete" && failedCount !== 0)
    ) {
      throw new MantraAuctionImportError("invalid_mantra_auction_failure_count");
    }
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      scopeKey: normalizedScopeKey,
      status: input.status as JobStatus,
      phase: stringValue(input.phase, "invalid_mantra_auction_phase", 80)!,
      completed,
      total,
      error: stringValue(input.error, "invalid_mantra_auction_error", 300, true),
      requestStats: {
        requestStarts: nonNegativeInteger(stats.requestStarts, "invalid_mantra_auction_request_stats"),
        retries: nonNegativeInteger(stats.retries, "invalid_mantra_auction_request_stats"),
        responses429: nonNegativeInteger(stats.responses429, "invalid_mantra_auction_request_stats"),
      },
      failedCount,
      lastRetryAt:
        input.lastRetryAt == null
          ? null
          : isoDate(input.lastRetryAt, "invalid_mantra_auction_last_retry_at"),
      updatedAt: isoDate(input.updatedAt, "invalid_mantra_auction_updated_at"),
    };
  }
  if (operation === "coverage") {
    const leagues = array(
      input.leagues,
      "invalid_mantra_auction_coverage",
      MAX_MANTRA_AUCTION_SCOPE_LEAGUES,
    ).map(
      (value) => {
        const league = record(value, "invalid_mantra_auction_coverage");
        const accessState = stringValue(
          league.accessState,
          "invalid_mantra_auction_access_state",
          20,
        )!;
        const auctionState = stringValue(
          league.auctionState,
          "invalid_mantra_auction_state",
          20,
        )!;
        if (
          !["accessible", "restricted", "unavailable", "archived"].includes(
            accessState,
          ) ||
          ![
            "available",
            "no-auction",
            "restricted",
            "unavailable",
            "archived",
          ].includes(auctionState)
        ) {
          throw new MantraAuctionImportError("invalid_mantra_auction_coverage");
        }
        return {
          mantraLeagueId: integer(
            league.mantraLeagueId,
            "invalid_mantra_auction_league",
          ),
          name: stringValue(league.name, "invalid_mantra_auction_league", 120)!,
          division: stringValue(
            league.division,
            "invalid_mantra_auction_division",
            40,
            true,
          ),
          seasonId:
            league.seasonId == null
              ? null
              : integer(league.seasonId, "invalid_mantra_auction_season"),
          tournamentId: integer(
            league.tournamentId,
            "invalid_mantra_auction_tournament",
          ),
          registryStatus: stringValue(
            league.registryStatus,
            "invalid_mantra_auction_status",
            40,
            true,
          ),
          accessState: accessState as MantraAuctionLeagueCoverage["accessState"],
          auctionState: auctionState as MantraAuctionLeagueCoverage["auctionState"],
          auctionIds: numericIds(
            league.auctionIds,
            "invalid_mantra_auction_catalog",
            30,
          ),
          sourceUrl: sourceUrl(
            league.sourceUrl,
            new RegExp(`^/leagues/${integer(
              league.mantraLeagueId,
              "invalid_mantra_auction_league",
            )}$`),
          ),
          evidence: stringValue(
            league.evidence,
            "invalid_mantra_auction_evidence",
            300,
          )!,
          discoveredAt: isoDate(
            league.discoveredAt,
            "invalid_mantra_auction_discovered_at",
          ),
        };
      },
    );
    if (
      new Set(leagues.map((league) => league.mantraLeagueId)).size !==
      leagues.length
    ) {
      throw new MantraAuctionImportError("invalid_mantra_auction_coverage");
    }
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      scopeKey: normalizedScopeKey,
      leagues,
    };
  }
  if (operation === "catalog") {
    const auctions = array(input.auctions, "invalid_mantra_auction_catalog", 100).map((value) => {
      const auction = record(value, "invalid_mantra_auction_catalog");
      const mantraLeagueId = integer(auction.mantraLeagueId, "invalid_mantra_auction_league");
      const auctionId = integer(auction.auctionId, "invalid_mantra_auction_id");
      const stages = array(auction.stages, "invalid_mantra_auction_stages", 30).map((value) => {
        const stage = record(value, "invalid_mantra_auction_stage");
        const stageNumber = integer(stage.stage, "invalid_mantra_auction_stage", 100);
        return {
          stage: stageNumber,
          sourceUrl: sourceUrl(
            stage.sourceUrl,
            new RegExp(`^/leagues/${mantraLeagueId}/auctions/${auctionId}$`),
          ),
          playerBidIds: numericIds(
            stage.playerBidIds,
            "invalid_mantra_auction_player_bids",
            500,
          ),
        };
      });
      if (new Set(stages.map((stage) => stage.stage)).size !== stages.length) {
        throw new MantraAuctionImportError("invalid_mantra_auction_stages");
      }
      return {
        mantraLeagueId,
        auctionId,
        status: stringValue(auction.status, "invalid_mantra_auction_status", 80, true),
        label: stringValue(auction.label, "invalid_mantra_auction_label", 120, true),
        leagueLabel: stringValue(
          auction.leagueLabel,
          "invalid_mantra_auction_league_label",
          120,
          true,
        ),
        sourceUrl: sourceUrl(
          auction.sourceUrl,
          new RegExp(`^/leagues/${mantraLeagueId}/auctions/${auctionId}$`),
        ),
        fetchedAt: isoDate(auction.fetchedAt, "invalid_mantra_auction_fetched_at"),
        stages,
      };
    });
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      scopeKey: normalizedScopeKey,
      auctions,
    };
  }
  if (operation === "batch") {
    const players = array(
      input.players,
      "invalid_mantra_auction_batch",
      MAX_MANTRA_AUCTION_BATCH_PLAYERS,
    ).map(normalizePlayer);
    if (players.length === 0) throw new MantraAuctionImportError("invalid_mantra_auction_batch");
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      scopeKey: normalizedScopeKey,
      players,
    };
  }
  if (operation === "complete") {
    const auctions = array(input.auctions, "invalid_mantra_auction_catalog", 100).map((value) => {
      const auction = record(value, "invalid_mantra_auction_catalog");
      return {
        mantraLeagueId: integer(auction.mantraLeagueId, "invalid_mantra_auction_league"),
        auctionId: integer(auction.auctionId, "invalid_mantra_auction_id"),
      };
    });
    return {
      schemaVersion: 1,
      operation,
      runId: normalizedRunId,
      scopeKey: normalizedScopeKey,
      completedAt: isoDate(input.completedAt, "invalid_mantra_auction_completed_at"),
      auctions,
    };
  }
  throw new MantraAuctionImportError("invalid_mantra_auction_operation");
}

export function mantraAuctionTokenMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function jobForRun(
  database: Database.Database,
  key: MantraAuctionScopeKey,
  id: string,
): { leagueIds: number[]; completed: number; total: number | null } {
  const row = database
    .prepare(
      `SELECT mantra_league_ids_json AS leagueIdsJson,
              completed_units AS completed, total_units AS total, run_id AS runId
       FROM mantra_auction_jobs WHERE scope_key = ?`,
    )
    .get(key) as
    | { leagueIdsJson: string; completed: number; total: number | null; runId: string }
    | undefined;
  if (!row) throw new MantraAuctionImportError("mantra_auction_scope_not_seeded", 409);
  if (row.runId !== id) throw new MantraAuctionImportError("stale_mantra_auction_run", 409);
  return { leagueIds: JSON.parse(row.leagueIdsJson), completed: row.completed, total: row.total };
}

function assertScopeLeague(leagueIds: number[], leagueId: number): void {
  if (!leagueIds.includes(leagueId)) {
    throw new MantraAuctionImportError("cross_scope_mantra_auction_data", 409);
  }
}

export function importMantraAuction(
  payload: MantraAuctionImportPayload,
  database: Database.Database,
) {
  if (payload.operation === "seed") {
    const upsert = database.prepare(
      `INSERT INTO mantra_auction_jobs
         (scope_key, scope_name, mantra_league_ids_json, run_id, status, phase,
          completed_units, total_units, percent, last_error, request_starts,
          retries, responses_429, failed_count, last_retry_at, started_at,
          updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'pending', 'queued', 0, NULL, NULL, NULL, 0, 0, 0,
               0, NULL, ?, ?, NULL)
       ON CONFLICT(scope_key) DO UPDATE SET
         scope_name = excluded.scope_name,
         mantra_league_ids_json = excluded.mantra_league_ids_json,
         run_id = excluded.run_id,
         status = 'pending', phase = 'queued', completed_units = 0,
         total_units = NULL, percent = NULL, last_error = NULL,
         request_starts = 0, retries = 0, responses_429 = 0,
         failed_count = 0, last_retry_at = NULL,
         started_at = excluded.started_at, updated_at = excluded.updated_at,
         completed_at = NULL`,
    );
    database.transaction(() => {
      for (const scope of payload.scopes) {
        upsert.run(
          scope.key,
          scope.name,
          JSON.stringify(scope.mantraLeagueIds),
          payload.runId,
          payload.startedAt,
          payload.startedAt,
        );
      }
    })();
    return { operation: payload.operation, importedScopes: payload.scopes.length };
  }

  const job = jobForRun(database, payload.scopeKey, payload.runId);
  if (payload.operation === "progress") {
    if (payload.completed < job.completed) {
      throw new MantraAuctionImportError("non_monotonic_mantra_auction_progress", 409);
    }
    if (job.total != null && payload.total != null && payload.total < job.total) {
      throw new MantraAuctionImportError("changed_mantra_auction_total", 409);
    }
    const percent =
      payload.total == null || payload.total === 0
        ? null
        : Math.min(100, (payload.completed / payload.total) * 100);
    database
      .prepare(
        `UPDATE mantra_auction_jobs SET
           status = ?, phase = ?, completed_units = ?, total_units = ?,
           percent = ?, last_error = ?, request_starts = ?, retries = ?,
           responses_429 = ?, failed_count = ?, last_retry_at = ?, updated_at = ?,
           completed_at = CASE WHEN ? = 'complete' THEN ? ELSE NULL END
         WHERE scope_key = ? AND run_id = ?`,
      )
      .run(
        payload.status,
        payload.phase,
        payload.completed,
        payload.total,
        percent,
        payload.error,
        payload.requestStats.requestStarts,
        payload.requestStats.retries,
        payload.requestStats.responses429,
        payload.failedCount,
        payload.lastRetryAt,
        payload.updatedAt,
        payload.status,
        payload.updatedAt,
        payload.scopeKey,
        payload.runId,
      );
    return { operation: payload.operation, percent };
  }

  if (payload.operation === "coverage") {
    const upsert = database.prepare(
      `INSERT INTO mantra_auction_leagues
         (mantra_league_id, scope_key, sync_run_id, name, division, season_id,
          tournament_id, registry_status, access_state, auction_state,
          auction_ids_json, source_url, evidence, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mantra_league_id) DO UPDATE SET
         scope_key = excluded.scope_key, sync_run_id = excluded.sync_run_id,
         name = excluded.name, division = excluded.division,
         season_id = excluded.season_id, tournament_id = excluded.tournament_id,
         registry_status = excluded.registry_status,
         access_state = excluded.access_state,
         auction_state = excluded.auction_state,
         auction_ids_json = excluded.auction_ids_json,
         source_url = excluded.source_url, evidence = excluded.evidence,
         discovered_at = excluded.discovered_at`,
    );
    database.transaction(() => {
      for (const league of payload.leagues) {
        assertScopeLeague(job.leagueIds, league.mantraLeagueId);
        upsert.run(
          league.mantraLeagueId,
          payload.scopeKey,
          payload.runId,
          league.name,
          league.division,
          league.seasonId,
          league.tournamentId,
          league.registryStatus,
          league.accessState,
          league.auctionState,
          JSON.stringify(league.auctionIds),
          league.sourceUrl,
          league.evidence,
          league.discoveredAt,
        );
      }
      database
        .prepare(
          `DELETE FROM mantra_auction_leagues
           WHERE scope_key = ? AND sync_run_id != ?`,
        )
        .run(payload.scopeKey, payload.runId);
    })();
    return { operation: payload.operation, importedLeagues: payload.leagues.length };
  }

  if (payload.operation === "catalog") {
    const auctionUpsert = database.prepare(
      `INSERT INTO mantra_auctions
         (mantra_league_id, auction_id, scope_key, sync_run_id, status, label,
          league_label, source_url, fetched_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(mantra_league_id, auction_id) DO UPDATE SET
         scope_key = excluded.scope_key, sync_run_id = excluded.sync_run_id,
         status = excluded.status, label = excluded.label,
         league_label = excluded.league_label, source_url = excluded.source_url,
         fetched_at = excluded.fetched_at, completed_at = NULL`,
    );
    const stageUpsert = database.prepare(
      `INSERT INTO mantra_auction_stages
         (mantra_league_id, auction_id, stage, source_url, player_bid_ids_json,
          sync_run_id, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mantra_league_id, auction_id, stage) DO UPDATE SET
         source_url = excluded.source_url,
         player_bid_ids_json = excluded.player_bid_ids_json,
         sync_run_id = excluded.sync_run_id, fetched_at = excluded.fetched_at`,
    );
    database.transaction(() => {
      for (const auction of payload.auctions) {
        assertScopeLeague(job.leagueIds, auction.mantraLeagueId);
        auctionUpsert.run(
          auction.mantraLeagueId,
          auction.auctionId,
          payload.scopeKey,
          payload.runId,
          auction.status,
          auction.label,
          auction.leagueLabel,
          auction.sourceUrl,
          auction.fetchedAt,
        );
        for (const stage of auction.stages) {
          stageUpsert.run(
            auction.mantraLeagueId,
            auction.auctionId,
            stage.stage,
            stage.sourceUrl,
            JSON.stringify(stage.playerBidIds),
            payload.runId,
            auction.fetchedAt,
          );
        }
      }
    })();
    return {
      operation: payload.operation,
      importedAuctions: payload.auctions.length,
      importedStages: payload.auctions.reduce((sum, auction) => sum + auction.stages.length, 0),
    };
  }

  if (payload.operation === "batch") {
    const auctionExists = database.prepare(
      `SELECT 1 FROM mantra_auctions
       WHERE mantra_league_id = ? AND auction_id = ? AND scope_key = ?`,
    );
    const playerUpsert = database.prepare(
      `INSERT INTO mantra_auction_players
         (mantra_league_id, auction_id, player_bid_id, mantra_player_id,
          first_name, name, avatar_url, positions_json, positions_italian_json,
          club_id, club_name, club_logo_url, status, final_price, source_url,
          sync_run_id, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mantra_league_id, auction_id, player_bid_id) DO UPDATE SET
         mantra_player_id = excluded.mantra_player_id,
         first_name = excluded.first_name, name = excluded.name,
         avatar_url = excluded.avatar_url, positions_json = excluded.positions_json,
         positions_italian_json = excluded.positions_italian_json,
         club_id = excluded.club_id, club_name = excluded.club_name,
         club_logo_url = excluded.club_logo_url, status = excluded.status,
         final_price = excluded.final_price, source_url = excluded.source_url,
         sync_run_id = excluded.sync_run_id, fetched_at = excluded.fetched_at`,
    );
    const stageUpsert = database.prepare(
      `INSERT INTO mantra_auction_player_stages
         (mantra_league_id, auction_id, player_bid_id, stage, outcome,
          winning_price, winning_team_id, winning_team_name,
          winning_team_logo_url, sync_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mantra_league_id, auction_id, player_bid_id, stage) DO UPDATE SET
         outcome = excluded.outcome, winning_price = excluded.winning_price,
         winning_team_id = excluded.winning_team_id,
         winning_team_name = excluded.winning_team_name,
         winning_team_logo_url = excluded.winning_team_logo_url,
         sync_run_id = excluded.sync_run_id`,
    );
    const bidUpsert = database.prepare(
      `INSERT INTO mantra_auction_bids
         (mantra_league_id, auction_id, player_bid_id, stage, bid_id,
          bid_order, status, price, fantasy_team_id, fantasy_team_name,
          fantasy_team_logo_url, sync_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mantra_league_id, auction_id, bid_id) DO UPDATE SET
         player_bid_id = excluded.player_bid_id, stage = excluded.stage,
         bid_order = excluded.bid_order, status = excluded.status,
         price = excluded.price, fantasy_team_id = excluded.fantasy_team_id,
         fantasy_team_name = excluded.fantasy_team_name,
         fantasy_team_logo_url = excluded.fantasy_team_logo_url,
         sync_run_id = excluded.sync_run_id`,
    );
    let importedStages = 0;
    let importedBids = 0;
    database.transaction(() => {
      for (const player of payload.players) {
        assertScopeLeague(job.leagueIds, player.mantraLeagueId);
        if (
          !auctionExists.get(
            player.mantraLeagueId,
            player.auctionId,
            payload.scopeKey,
          )
        ) {
          throw new MantraAuctionImportError("unknown_mantra_auction", 409);
        }
        playerUpsert.run(
          player.mantraLeagueId,
          player.auctionId,
          player.playerBidId,
          player.player.id,
          player.player.firstName,
          player.player.name,
          player.player.avatarUrl,
          JSON.stringify(player.player.positions),
          JSON.stringify(player.player.positionsItalian),
          player.player.club?.id ?? null,
          player.player.club?.name ?? null,
          player.player.club?.logoUrl ?? null,
          player.status,
          player.price,
          player.sourceUrl,
          payload.runId,
          player.fetchedAt,
        );
        for (const stage of player.stages) {
          const winner = stage.bids.find((bid) => bid.status === "success") ?? null;
          stageUpsert.run(
            player.mantraLeagueId,
            player.auctionId,
            player.playerBidId,
            stage.stage,
            winner ? "success" : stage.bids.length ? "failed" : null,
            winner?.price ?? null,
            winner?.team?.id ?? null,
            winner?.team?.name ?? null,
            winner?.team?.logoUrl ?? null,
            payload.runId,
          );
          importedStages++;
          for (const bid of stage.bids) {
            bidUpsert.run(
              player.mantraLeagueId,
              player.auctionId,
              player.playerBidId,
              stage.stage,
              bid.id,
              bid.order,
              bid.status,
              bid.price,
              bid.team?.id ?? null,
              bid.team?.name ?? null,
              bid.team?.logoUrl ?? null,
              payload.runId,
            );
            importedBids++;
          }
        }
      }
    })();
    return {
      operation: payload.operation,
      importedPlayers: payload.players.length,
      importedStages,
      importedBids,
    };
  }

  database.transaction(() => {
    for (const auction of payload.auctions) {
      assertScopeLeague(job.leagueIds, auction.mantraLeagueId);
      const args = [auction.mantraLeagueId, auction.auctionId, payload.runId];
      database
        .prepare(
          `DELETE FROM mantra_auction_bids
           WHERE mantra_league_id = ? AND auction_id = ? AND sync_run_id != ?`,
        )
        .run(...args);
      database
        .prepare(
          `DELETE FROM mantra_auction_player_stages
           WHERE mantra_league_id = ? AND auction_id = ? AND sync_run_id != ?`,
        )
        .run(...args);
      database
        .prepare(
          `DELETE FROM mantra_auction_players
           WHERE mantra_league_id = ? AND auction_id = ? AND sync_run_id != ?`,
        )
        .run(...args);
      database
        .prepare(
          `DELETE FROM mantra_auction_stages
           WHERE mantra_league_id = ? AND auction_id = ? AND sync_run_id != ?`,
        )
        .run(...args);
      database
        .prepare(
          `UPDATE mantra_auctions SET completed_at = ?
           WHERE mantra_league_id = ? AND auction_id = ? AND sync_run_id = ?`,
        )
        .run(payload.completedAt, auction.mantraLeagueId, auction.auctionId, payload.runId);
    }
  })();
  return { operation: payload.operation, completedAuctions: payload.auctions.length };
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function getMantraAuctionCoverage(
  database: Database.Database,
  scope?: MantraAuctionScopeKey,
) {
  type LeagueRow = {
    mantraLeagueId: number;
    scopeKey: MantraAuctionScopeKey;
    name: string;
    division: string | null;
    seasonId: number | null;
    tournamentId: number;
    registryStatus: string | null;
    accessState: MantraAuctionLeagueCoverage["accessState"];
    auctionState: MantraAuctionLeagueCoverage["auctionState"];
    auctionIdsJson: string;
    sourceUrl: string;
    evidence: string;
    discoveredAt: string;
  };
  type AuctionRow = {
    mantraLeagueId: number;
    auctionId: number;
    status: string | null;
    label: string | null;
    sourceUrl: string;
    fetchedAt: string;
    completedAt: string | null;
    stages: number;
    detailsProcessed: number;
    detailsTotal: number;
    bids: number;
    winners: number;
    bidAmountSum: number;
  };
  const where = scope ? "WHERE l.scope_key = ?" : "";
  const leagueRows = database
    .prepare(
      `SELECT l.mantra_league_id AS mantraLeagueId, l.scope_key AS scopeKey,
              l.name, l.division, l.season_id AS seasonId,
              l.tournament_id AS tournamentId,
              l.registry_status AS registryStatus,
              l.access_state AS accessState, l.auction_state AS auctionState,
              l.auction_ids_json AS auctionIdsJson, l.source_url AS sourceUrl,
              l.evidence, l.discovered_at AS discoveredAt
       FROM mantra_auction_leagues l
       ${where}
       ORDER BY l.scope_key, l.division, l.mantra_league_id`,
    )
    .all(...(scope ? [scope] : [])) as LeagueRow[];
  const auctionQuery = database.prepare(
    `SELECT a.mantra_league_id AS mantraLeagueId, a.auction_id AS auctionId,
            a.status, a.label, a.source_url AS sourceUrl,
            a.fetched_at AS fetchedAt, a.completed_at AS completedAt,
            (SELECT COUNT(*) FROM mantra_auction_stages s
             WHERE s.mantra_league_id = a.mantra_league_id
               AND s.auction_id = a.auction_id) AS stages,
            (SELECT COUNT(*) FROM mantra_auction_players p
             WHERE p.mantra_league_id = a.mantra_league_id
               AND p.auction_id = a.auction_id) AS detailsProcessed,
            (SELECT COUNT(DISTINCT CAST(je.value AS INTEGER))
             FROM mantra_auction_stages s, json_each(s.player_bid_ids_json) je
             WHERE s.mantra_league_id = a.mantra_league_id
               AND s.auction_id = a.auction_id) AS detailsTotal,
            (SELECT COUNT(*) FROM mantra_auction_bids b
             WHERE b.mantra_league_id = a.mantra_league_id
               AND b.auction_id = a.auction_id) AS bids,
            (SELECT COUNT(*) FROM mantra_auction_bids b
             WHERE b.mantra_league_id = a.mantra_league_id
               AND b.auction_id = a.auction_id AND b.status = 'success') AS winners,
            (SELECT COALESCE(SUM(b.price), 0) FROM mantra_auction_bids b
             WHERE b.mantra_league_id = a.mantra_league_id
               AND b.auction_id = a.auction_id) AS bidAmountSum
     FROM mantra_auctions a
     WHERE a.mantra_league_id = ?
     ORDER BY a.auction_id`,
  );
  return {
    leagues: leagueRows.map(({ auctionIdsJson, ...league }) => {
      const auctionIds = jsonArray(auctionIdsJson)
        .map(Number)
        .filter(Number.isSafeInteger);
      const byId = new Map(
        (auctionQuery.all(league.mantraLeagueId) as AuctionRow[]).map((auction) => [
          auction.auctionId,
          auction,
        ]),
      );
      return {
        ...league,
        auctionIds,
        auctions: auctionIds.map((auctionId) => {
          const auction = byId.get(auctionId);
          if (!auction) {
            return {
              auctionId,
              status: "missing",
              label: null,
              sourceUrl: `https://mantrafootball.org/leagues/${league.mantraLeagueId}/auctions/${auctionId}`,
              fetchedAt: null,
              completedAt: null,
              stages: 0,
              detailsProcessed: 0,
              detailsTotal: null,
              bids: 0,
              winners: 0,
              bidAmountSum: 0,
              collectionStatus: "missing",
            };
          }
          const complete =
            auction.completedAt != null &&
            auction.detailsProcessed === auction.detailsTotal;
          return {
            ...auction,
            collectionStatus: complete
              ? "complete"
              : auction.detailsProcessed > 0
                ? "partial"
                : "pending",
          };
        }),
      };
    }),
  };
}

export function getMantraAuctionScopes(database: Database.Database) {
  type ScopeRow = {
    scopeKey: string;
    name: string;
    mantraLeagueIdsJson: string;
    status: JobStatus;
    phase: string;
    completed: number;
    total: number | null;
    percent: number | null;
    lastError: string | null;
    requestStarts: number;
    retries: number;
    responses429: number;
    failedCount: number;
    lastRetryAt: string | null;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
    auctions: number;
    players: number;
    playerStages: number;
    bids: number;
    winners: number;
    bidAmountSum: number;
  };
  const rows = database
    .prepare(
      `SELECT j.scope_key AS scopeKey, j.scope_name AS name,
              j.mantra_league_ids_json AS mantraLeagueIdsJson,
              j.status, j.phase, j.completed_units AS completed,
              j.total_units AS total, j.percent, j.last_error AS lastError,
              j.request_starts AS requestStarts, j.retries,
              j.responses_429 AS responses429, j.failed_count AS failedCount,
              j.last_retry_at AS lastRetryAt, j.started_at AS startedAt,
              j.updated_at AS updatedAt, j.completed_at AS completedAt,
              COUNT(DISTINCT a.mantra_league_id || ':' || a.auction_id) AS auctions,
              COUNT(DISTINCT p.mantra_league_id || ':' || p.auction_id || ':' || p.player_bid_id) AS players,
              COUNT(DISTINCT ps.mantra_league_id || ':' || ps.auction_id || ':' ||
                    ps.player_bid_id || ':' || ps.stage) AS playerStages,
              COUNT(DISTINCT b.mantra_league_id || ':' || b.auction_id || ':' || b.bid_id) AS bids,
              COUNT(DISTINCT CASE WHEN b.status = 'success'
                THEN b.mantra_league_id || ':' || b.auction_id || ':' || b.bid_id END) AS winners,
              COALESCE(SUM(b.price), 0) AS bidAmountSum
       FROM mantra_auction_jobs j
       LEFT JOIN mantra_auctions a ON a.scope_key = j.scope_key
       LEFT JOIN mantra_auction_players p
         ON p.mantra_league_id = a.mantra_league_id AND p.auction_id = a.auction_id
       LEFT JOIN mantra_auction_player_stages ps
         ON ps.mantra_league_id = p.mantra_league_id
        AND ps.auction_id = p.auction_id AND ps.player_bid_id = p.player_bid_id
       LEFT JOIN mantra_auction_bids b
         ON b.mantra_league_id = ps.mantra_league_id
        AND b.auction_id = ps.auction_id
        AND b.player_bid_id = ps.player_bid_id AND b.stage = ps.stage
       GROUP BY j.scope_key
       ORDER BY CASE j.scope_key
         WHEN 'super-lig' THEN 1 WHEN 'championship' THEN 2
         WHEN 'ekstraklasa' THEN 3 WHEN 'bundesliga' THEN 4
         WHEN 'premier-league' THEN 5 WHEN 'serie-a' THEN 6 ELSE 7 END`,
    )
    .all() as ScopeRow[];
  const coverage = getMantraAuctionCoverage(database).leagues;
  return {
    scopes: rows.map(({ mantraLeagueIdsJson, lastError: _lastError, ...row }) => {
      const mantraLeagueIds = JSON.parse(mantraLeagueIdsJson) as number[];
      const leagues = coverage.filter((league) => league.scopeKey === row.scopeKey);
      if (
        row.scopeKey === "super-lig" &&
        leagues.length === 0 &&
        row.status === "complete"
      ) {
        return {
          ...row,
          mantraLeagueIds,
          discoveredLeagues: mantraLeagueIds.length,
          availableLeagues: mantraLeagueIds.length,
          leaguesWithAuctions: row.auctions,
          collectedAuctions: row.auctions,
          availableAuctions: row.auctions,
          detailsProcessed: row.players,
          detailsTotal: row.total ?? row.players,
          missingLeagueCount: 0,
          missingAuctionCount: 0,
          missingDetailCount: 0,
          coverageComplete: true,
        };
      }
      const availableLeagues = leagues.filter(
        (league) => league.accessState === "accessible",
      ).length;
      const leaguesWithAuctions = leagues.filter(
        (league) => league.auctionState === "available",
      ).length;
      const auctions = leagues.flatMap((league) => league.auctions);
      const availableAuctions = leagues.reduce(
        (sum, league) => sum + league.auctionIds.length,
        0,
      );
      const collectedAuctions = auctions.filter(
        (auction) => auction.collectionStatus === "complete",
      ).length;
      const detailsProcessed = auctions.reduce(
        (sum, auction) => sum + auction.detailsProcessed,
        0,
      );
      const detailsTotal = auctions.reduce(
        (sum, auction) =>
          sum + (typeof auction.detailsTotal === "number" ? auction.detailsTotal : 0),
        0,
      );
      const missingLeagueCount = Math.max(0, mantraLeagueIds.length - leagues.length);
      const missingAuctionCount = Math.max(
        0,
        availableAuctions - collectedAuctions,
      );
      const missingDetailCount = Math.max(0, detailsTotal - detailsProcessed);
      const coverageComplete =
        leagues.length === mantraLeagueIds.length &&
        missingAuctionCount === 0 &&
        missingDetailCount === 0;
      return {
        ...row,
        status:
          row.status === "complete" && !coverageComplete ? "partial" : row.status,
        mantraLeagueIds,
        discoveredLeagues: leagues.length,
        availableLeagues,
        leaguesWithAuctions,
        collectedAuctions,
        availableAuctions,
        detailsProcessed,
        detailsTotal,
        missingLeagueCount,
        missingAuctionCount,
        missingDetailCount,
        coverageComplete,
      };
    }),
  };
}

export function getMantraAuctions(
  database: Database.Database,
  options: { scopeKey?: MantraAuctionScopeKey; mantraLeagueId?: number } = {},
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.scopeKey) {
    where.push("a.scope_key = ?");
    params.push(options.scopeKey);
  }
  if (options.mantraLeagueId) {
    where.push("a.mantra_league_id = ?");
    params.push(options.mantraLeagueId);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const auctions = database
    .prepare(
      `SELECT a.mantra_league_id AS mantraLeagueId, a.auction_id AS auctionId,
              a.scope_key AS scopeKey, a.status, a.label,
              a.league_label AS leagueLabel, a.source_url AS sourceUrl,
              a.fetched_at AS fetchedAt, a.completed_at AS completedAt,
              COUNT(DISTINCT s.stage) AS stages,
              COUNT(DISTINCT p.player_bid_id) AS players,
              COUNT(DISTINCT CAST(je.value AS INTEGER)) AS detailsTotal
       FROM mantra_auctions a
       LEFT JOIN mantra_auction_stages s
         ON s.mantra_league_id = a.mantra_league_id AND s.auction_id = a.auction_id
       LEFT JOIN json_each(s.player_bid_ids_json) je
       LEFT JOIN mantra_auction_players p
         ON p.mantra_league_id = a.mantra_league_id AND p.auction_id = a.auction_id
       ${sqlWhere}
       GROUP BY a.mantra_league_id, a.auction_id
       ORDER BY a.scope_key, a.mantra_league_id, a.auction_id DESC
       LIMIT 100`,
    )
    .all(...params) as Array<Record<string, unknown> & {
      auctionId: number;
      status: string | null;
      completedAt: string | null;
      stages: number;
      players: number;
      detailsTotal: number;
    }>;
  return {
    auctions: auctions.map((auction) => {
      const status = auction.status?.toLowerCase() ?? "";
      const actionableStatus = ["discovering", "running", "partial", "error"].includes(
        status,
      );
      const emptyPending =
        !auction.completedAt &&
        !actionableStatus &&
        auction.stages === 0 &&
        auction.players === 0 &&
        auction.detailsTotal === 0;
      return { ...auction, browsable: !emptyPending };
    }),
  };
}

const MAX_AUCTION_REPORT_PICKS = 500;

function validAuctionReportAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value < Number.MAX_SAFE_INTEGER
  );
}

type AuctionReportPickRow = {
  playerBidId: number;
  mantraPlayerId: number;
  firstName: string | null;
  name: string;
  avatarUrl: string | null;
  canonicalAvatarUrl: string | null;
  tmUrl: string | null;
  stage: number;
  winningPrice: number | null;
  fantasyTeamId: number;
  fantasyTeamName: string | null;
  fantasyTeamLogoUrl: string | null;
};

type AuctionReportBidRow = {
  playerBidId: number;
  stage: number;
  bidId: number;
  bidOrder: number;
  status: string | null;
  price: number | null;
  fantasyTeamId: number | null;
  fantasyTeamName: string | null;
  fantasyTeamLogoUrl: string | null;
};

function calculateAuctionReportPick(
  row: Pick<AuctionReportPickRow, "winningPrice">,
  bids: AuctionReportBidRow[],
  fantasyTeamId: number,
) {
  const winnerBid = bids
    .filter(
      (bid) => bid.status === "success" && bid.fantasyTeamId === fantasyTeamId,
    )
    .sort((left, right) => left.bidOrder - right.bidOrder || left.bidId - right.bidId)[0];
  const actualFromBid = validAuctionReportAmount(winnerBid?.price)
    ? winnerBid.price
    : null;
  const actualFromStage = validAuctionReportAmount(row.winningPrice)
    ? row.winningPrice
    : null;
  const actual = actualFromBid ?? actualFromStage;
  const malformedCompetingBid = bids.some(
    (bid) =>
      bid.fantasyTeamId == null ||
      (bid.fantasyTeamId !== fantasyTeamId && !validAuctionReportAmount(bid.price)),
  );
  const competitors = bids
    .filter(
      (bid) =>
        bid.fantasyTeamId != null &&
        bid.fantasyTeamId !== fantasyTeamId &&
        validAuctionReportAmount(bid.price),
    )
    .sort(
      (left, right) =>
        Number(right.price) - Number(left.price) ||
        left.bidId - right.bidId ||
        Number(left.fantasyTeamId) - Number(right.fantasyTeamId),
    );
  const runnerUp = competitors[0] ?? null;
  const minimumKnown =
    winnerBid != null &&
    actualFromBid != null &&
    !malformedCompetingBid &&
    (runnerUp == null || Number(runnerUp.price) < Number.MAX_SAFE_INTEGER);
  const theoreticalMinimum = minimumKnown
    ? runnerUp == null
      ? 1
      : Number(runnerUp.price) + 1
    : null;
  return {
    winnerBid,
    actual,
    actualProvenance: actualFromBid != null
      ? "winning_bid_record"
      : actualFromStage != null
        ? "stage_outcome"
        : "unknown",
    runnerUp,
    theoreticalMinimum,
    minimumRule: theoreticalMinimum == null
      ? "unknown"
      : runnerUp
        ? "highest_competing_final_bid_plus_1m"
        : "verified_1m_floor",
    difference:
      actual != null && theoreticalMinimum != null
        ? actual - theoreticalMinimum
        : null,
    complete: actual != null && theoreticalMinimum != null,
    incompleteReason:
      winnerBid == null
        ? "winning_bid_record_missing"
        : actualFromBid == null
          ? "winning_bid_amount_invalid"
          : malformedCompetingBid
            ? "competing_bid_detail_invalid"
            : null,
  };
}

function aggregateAuctionReportPicks(
  picks: Array<{
    actual: number | null;
    theoreticalMinimum: number | null;
    difference: number | null;
  }>,
  collectionComplete: boolean,
  truncated = false,
) {
  const actualKnown = picks.reduce((sum, pick) => sum + (pick.actual ?? 0), 0);
  const minimumKnown = picks.reduce(
    (sum, pick) => sum + (pick.theoreticalMinimum ?? 0),
    0,
  );
  const differenceKnown = picks.reduce(
    (sum, pick) => sum + (pick.difference ?? 0),
    0,
  );
  const actualUnknownCount = picks.filter((pick) => pick.actual == null).length;
  const minimumUnknownCount = picks.filter(
    (pick) => pick.theoreticalMinimum == null,
  ).length;
  const differenceUnknownCount = picks.filter((pick) => pick.difference == null).length;
  const exact =
    collectionComplete &&
    actualUnknownCount === 0 &&
    minimumUnknownCount === 0 &&
    !truncated;
  return {
    exact,
    partial: !exact,
    completeness: {
      knownPicks: picks.length,
      actualKnownCount: picks.length - actualUnknownCount,
      actualUnknownCount,
      minimumKnownCount: picks.length - minimumUnknownCount,
      minimumUnknownCount,
      differenceKnownCount: picks.length - differenceUnknownCount,
      differenceUnknownCount,
    },
    totals: {
      actual: exact ? actualKnown : null,
      actualKnown,
      theoreticalMinimum: exact ? minimumKnown : null,
      theoreticalMinimumKnown: minimumKnown,
      difference: exact ? differenceKnown : null,
      differenceKnown,
    },
  };
}

function getAuctionReportScope(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
  },
) {
  return database
    .prepare(
      `SELECT a.scope_key AS scopeKey,
              COALESCE(l.name, a.league_label) AS fantasyLeagueName,
              a.label AS auctionLabel, a.status AS auctionStatus,
              a.source_url AS auctionSourceUrl, a.fetched_at AS fetchedAt,
              a.completed_at AS completedAt,
              (SELECT COUNT(*) FROM mantra_auction_stages s
               WHERE s.mantra_league_id = a.mantra_league_id
                 AND s.auction_id = a.auction_id) AS stages,
              (SELECT COUNT(*) FROM mantra_auction_players p
               WHERE p.mantra_league_id = a.mantra_league_id
                 AND p.auction_id = a.auction_id) AS detailsProcessed,
              (SELECT COUNT(DISTINCT CAST(je.value AS INTEGER))
               FROM mantra_auction_stages s, json_each(s.player_bid_ids_json) je
               WHERE s.mantra_league_id = a.mantra_league_id
                 AND s.auction_id = a.auction_id) AS detailsTotal
       FROM mantra_auctions a
       LEFT JOIN mantra_auction_leagues l
         ON l.mantra_league_id = a.mantra_league_id
       WHERE a.scope_key = ? AND a.mantra_league_id = ? AND a.auction_id = ?`,
    )
    .get(options.scopeKey, options.mantraLeagueId, options.auctionId) as
    | {
        scopeKey: MantraAuctionScopeKey;
        fantasyLeagueName: string | null;
        auctionLabel: string | null;
        auctionStatus: string | null;
        auctionSourceUrl: string;
        fetchedAt: string;
        completedAt: string | null;
        stages: number;
        detailsProcessed: number;
        detailsTotal: number;
      }
    | undefined;
}

function auctionReportScopeBrowsable(
  scope: NonNullable<ReturnType<typeof getAuctionReportScope>>,
) {
  const status = scope.auctionStatus?.toLowerCase() ?? "";
  const actionableStatus = ["discovering", "running", "partial", "error"].includes(
    status,
  );
  return !(
    scope.completedAt == null &&
    !actionableStatus &&
    scope.stages === 0 &&
    scope.detailsProcessed === 0 &&
    scope.detailsTotal === 0
  );
}

export function getMantraAuctionFantasyTeams(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
  },
) {
  const scope = getAuctionReportScope(database, options);
  if (!scope || !auctionReportScopeBrowsable(scope)) return null;
  const pickRows = database
    .prepare(
      `SELECT ps.player_bid_id AS playerBidId, p.mantra_player_id AS mantraPlayerId,
              p.first_name AS firstName, p.name, p.avatar_url AS avatarUrl,
              NULL AS canonicalAvatarUrl, NULL AS tmUrl, ps.stage,
              ps.winning_price AS winningPrice,
              ps.winning_team_id AS fantasyTeamId,
              ps.winning_team_name AS fantasyTeamName,
              ps.winning_team_logo_url AS fantasyTeamLogoUrl
       FROM mantra_auction_player_stages ps
       JOIN mantra_auction_players p
         ON p.mantra_league_id = ps.mantra_league_id
        AND p.auction_id = ps.auction_id
        AND p.player_bid_id = ps.player_bid_id
       WHERE ps.mantra_league_id = ? AND ps.auction_id = ?
         AND ps.outcome = 'success' AND ps.winning_team_id IS NOT NULL
       ORDER BY ps.player_bid_id ASC, ps.stage ASC`,
    )
    .all(options.mantraLeagueId, options.auctionId) as AuctionReportPickRow[];
  const bidRows = database
    .prepare(
      `SELECT b.player_bid_id AS playerBidId, b.stage, b.bid_id AS bidId,
              b.bid_order AS bidOrder, b.status, b.price,
              b.fantasy_team_id AS fantasyTeamId,
              b.fantasy_team_name AS fantasyTeamName,
              b.fantasy_team_logo_url AS fantasyTeamLogoUrl
       FROM mantra_auction_bids b
       JOIN mantra_auction_player_stages ps
         ON ps.mantra_league_id = b.mantra_league_id
        AND ps.auction_id = b.auction_id
        AND ps.player_bid_id = b.player_bid_id AND ps.stage = b.stage
       WHERE b.mantra_league_id = ? AND b.auction_id = ?
         AND ps.outcome = 'success' AND ps.winning_team_id IS NOT NULL
       ORDER BY b.player_bid_id ASC, b.stage ASC, b.bid_order ASC, b.bid_id ASC`,
    )
    .all(options.mantraLeagueId, options.auctionId) as AuctionReportBidRow[];
  const bidsByPick = new Map<string, AuctionReportBidRow[]>();
  for (const bid of bidRows) {
    const key = `${bid.playerBidId}:${bid.stage}`;
    const bids = bidsByPick.get(key) ?? [];
    bids.push(bid);
    bidsByPick.set(key, bids);
  }
  const collectionComplete =
    scope.completedAt != null && scope.detailsProcessed === scope.detailsTotal;
  const teamsById = new Map<
    number,
    {
      fantasyTeamId: number;
      name: string | null;
      logoUrl: string | null;
      picks: ReturnType<typeof calculateAuctionReportPick>[];
    }
  >();
  for (const row of pickRows) {
    const team = teamsById.get(row.fantasyTeamId) ?? {
      fantasyTeamId: row.fantasyTeamId,
      name: row.fantasyTeamName,
      logoUrl: row.fantasyTeamLogoUrl,
      picks: [],
    };
    if (
      row.fantasyTeamName != null &&
      (team.name == null || row.fantasyTeamName.localeCompare(team.name) > 0)
    ) {
      team.name = row.fantasyTeamName;
    }
    if (row.fantasyTeamLogoUrl != null) team.logoUrl = row.fantasyTeamLogoUrl;
    team.picks.push(
      calculateAuctionReportPick(
        row,
        bidsByPick.get(`${row.playerBidId}:${row.stage}`) ?? [],
        row.fantasyTeamId,
      ),
    );
    teamsById.set(row.fantasyTeamId, team);
  }
  const teams = [...teamsById.values()]
    .map((team) => {
      const summary = aggregateAuctionReportPicks(team.picks, collectionComplete);
      return {
        fantasyTeamId: team.fantasyTeamId,
        name: team.name,
        logoUrl: team.logoUrl,
        wonPickCount: team.picks.length,
        isPartial: summary.partial,
        partial: summary.partial,
        minimum: summary.totals.theoreticalMinimum,
        minimumKnown: summary.totals.theoreticalMinimumKnown,
        actual: summary.totals.actual,
        actualKnown: summary.totals.actualKnown,
        difference: summary.totals.difference,
        differenceKnown: summary.totals.differenceKnown,
        completeness: summary.completeness,
      };
    })
    .sort(
      (left, right) =>
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.fantasyTeamId - right.fantasyTeamId,
    );
  const missingDetailCount = Math.max(0, scope.detailsTotal - scope.detailsProcessed);
  const partial = !collectionComplete || teams.some((team) => team.isPartial);
  return {
    scopeKey: options.scopeKey,
    mantraLeagueId: options.mantraLeagueId,
    auctionId: options.auctionId,
    fantasyLeagueName: scope.fantasyLeagueName,
    auctionLabel: scope.auctionLabel,
    collectionComplete,
    partial,
    isPartial: partial,
    detailsProcessed: scope.detailsProcessed,
    detailsTotal: scope.detailsTotal,
    completeness: {
      detailsProcessed: scope.detailsProcessed,
      detailsTotal: scope.detailsTotal,
      missingDetailCount,
      knownParticipantCount: teams.length,
    },
    semantics: {
      bidData: "final_bid_records_returned_by_mantra_api",
      minimum: "guaranteed_by_outright_beat",
      incrementM: 1,
      noCompetitorFloorM: 1,
    },
    teams,
  };
}

export function getMantraAuctionFantasyTeamReport(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
    fantasyTeamId: number;
    page?: number;
    limit?: number;
  },
) {
  const scope = getAuctionReportScope(database, options);
  if (!scope || !auctionReportScopeBrowsable(scope)) return null;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 25)));
  const allPickRows = database
    .prepare(
      `SELECT p.player_bid_id AS playerBidId,
              p.mantra_player_id AS mantraPlayerId, p.first_name AS firstName,
              p.name, p.avatar_url AS avatarUrl,
              mp.avatar_path AS canonicalAvatarUrl, mp.tm_url AS tmUrl,
              ps.stage, ps.winning_price AS winningPrice,
              ps.winning_team_id AS fantasyTeamId,
              ps.winning_team_name AS fantasyTeamName,
              ps.winning_team_logo_url AS fantasyTeamLogoUrl
       FROM mantra_auction_player_stages ps
       JOIN mantra_auction_players p
         ON p.mantra_league_id = ps.mantra_league_id
        AND p.auction_id = ps.auction_id
        AND p.player_bid_id = ps.player_bid_id
       LEFT JOIN mantra_players mp ON mp.id = p.mantra_player_id
       WHERE ps.mantra_league_id = ? AND ps.auction_id = ?
         AND ps.outcome = 'success' AND ps.winning_team_id = ?
       ORDER BY ps.player_bid_id ASC, ps.stage ASC
       LIMIT ?`,
    )
    .all(
      options.mantraLeagueId,
      options.auctionId,
      options.fantasyTeamId,
      MAX_AUCTION_REPORT_PICKS + 1,
    ) as AuctionReportPickRow[];
  const picksTruncated = allPickRows.length > MAX_AUCTION_REPORT_PICKS;
  const pickRows = allPickRows.slice(0, MAX_AUCTION_REPORT_PICKS);
  if (!pickRows.length) return undefined;

  const bidRows = database
    .prepare(
      `SELECT b.player_bid_id AS playerBidId, b.stage, b.bid_id AS bidId,
              b.bid_order AS bidOrder, b.status, b.price,
              b.fantasy_team_id AS fantasyTeamId,
              b.fantasy_team_name AS fantasyTeamName,
              b.fantasy_team_logo_url AS fantasyTeamLogoUrl
       FROM mantra_auction_bids b
       JOIN mantra_auction_player_stages ps
         ON ps.mantra_league_id = b.mantra_league_id
        AND ps.auction_id = b.auction_id
        AND ps.player_bid_id = b.player_bid_id AND ps.stage = b.stage
       WHERE b.mantra_league_id = ? AND b.auction_id = ?
         AND ps.outcome = 'success' AND ps.winning_team_id = ?
       ORDER BY b.player_bid_id ASC, b.stage ASC, b.bid_order ASC, b.bid_id ASC`,
    )
    .all(
      options.mantraLeagueId,
      options.auctionId,
      options.fantasyTeamId,
    ) as AuctionReportBidRow[];
  const bidsByPick = new Map<string, AuctionReportBidRow[]>();
  for (const bid of bidRows) {
    const key = `${bid.playerBidId}:${bid.stage}`;
    const bids = bidsByPick.get(key) ?? [];
    bids.push(bid);
    bidsByPick.set(key, bids);
  }

  const picks = pickRows.map((row) => {
    const bids = bidsByPick.get(`${row.playerBidId}:${row.stage}`) ?? [];
    const financial = calculateAuctionReportPick(row, bids, options.fantasyTeamId);
    const profilePlayerId =
      row.tmUrl?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
    return {
      pickId: `${options.mantraLeagueId}:${options.auctionId}:${row.playerBidId}:${row.stage}`,
      playerBidId: row.playerBidId,
      mantraPlayerId: row.mantraPlayerId,
      player: {
        firstName: row.firstName,
        name: row.name,
        avatarUrl:
          normalizeMantraImageUrl(row.canonicalAvatarUrl) ??
          normalizeMantraImageUrl(row.avatarUrl),
        profilePlayerId,
        profileUrl: profilePlayerId ? `/player.html?id=${profilePlayerId}` : null,
      },
      stage: row.stage,
      winnerBidId: financial.winnerBid?.bidId ?? null,
      actual: financial.actual,
      actualProvenance: financial.actualProvenance,
      runnerUp: financial.runnerUp
        ? {
            bidId: financial.runnerUp.bidId,
            fantasyTeamId: financial.runnerUp.fantasyTeamId,
            fantasyTeamName: financial.runnerUp.fantasyTeamName,
            fantasyTeamLogoUrl: financial.runnerUp.fantasyTeamLogoUrl,
            amount: financial.runnerUp.price,
          }
        : null,
      theoreticalMinimum: financial.theoreticalMinimum,
      minimumRule: financial.minimumRule,
      difference: financial.difference,
      complete: financial.complete,
      incompleteReason: financial.incompleteReason,
    };
  });
  picks.sort(
    (left, right) =>
      Number(right.actual ?? -1) - Number(left.actual ?? -1) ||
      `${left.player.firstName ?? ""} ${left.player.name}`.localeCompare(
        `${right.player.firstName ?? ""} ${right.player.name}`,
      ) ||
      left.playerBidId - right.playerBidId ||
      left.stage - right.stage,
  );

  const collectionComplete =
    scope.completedAt != null && scope.detailsProcessed === scope.detailsTotal;
  const summary = aggregateAuctionReportPicks(
    picks,
    collectionComplete,
    picksTruncated,
  );
  const offset = (page - 1) * limit;
  return {
    scopeKey: options.scopeKey,
    mantraLeagueId: options.mantraLeagueId,
    auctionId: options.auctionId,
    fantasyLeagueName: scope.fantasyLeagueName,
    auctionLabel: scope.auctionLabel,
    team: {
      fantasyTeamId: options.fantasyTeamId,
      name: pickRows[0]?.fantasyTeamName ?? null,
      logoUrl: pickRows[0]?.fantasyTeamLogoUrl ?? null,
    },
    semantics: {
      bidData: "final_bid_records_returned_by_mantra_api",
      minimum: "guaranteed_by_outright_beat",
      incrementM: 1,
      noCompetitorFloorM: 1,
    },
    partial: summary.partial,
    isPartial: summary.partial,
    truncated: picksTruncated,
    collectionComplete,
    detailsProcessed: scope.detailsProcessed,
    detailsTotal: scope.detailsTotal,
    page,
    limit,
    total: picks.length,
    pages: Math.ceil(picks.length / limit),
    completeness: {
      ...summary.completeness,
      missingDetailCount: Math.max(0, scope.detailsTotal - scope.detailsProcessed),
    },
    totals: summary.totals,
    picks: picks.slice(offset, offset + limit),
  };
}

const IDEAL_PICK_TARGET_COUNT = 26;

export type MantraIdealPickCandidate = {
  playerBidId: number;
  mantraPlayerId: number;
  firstName: string | null;
  name: string;
  avatarUrl: string | null;
  canonicalAvatarUrl: string | null;
  tmUrl: string | null;
  positions: string[];
  stage: number;
  stageSourceUrl: string;
  playerSourceUrl: string;
  outcome: string | null;
  winningPrice: number | null;
  winningTeamId: number | null;
  winningTeamName: string | null;
  winningTeamLogoUrl: string | null;
};

export type MantraIdealPickBid = {
  playerBidId: number;
  stage: number;
  bidId: number;
  status: string | null;
  price: number | null;
  fantasyTeamId: number | null;
  fantasyTeamName: string | null;
  fantasyTeamLogoUrl: string | null;
};

export type MantraIdealPickParticipant = {
  fantasyTeamId: number;
  name: string | null;
  logoUrl: string | null;
};

type IdealPickSource = {
  candidates: MantraIdealPickCandidate[];
  bids: MantraIdealPickBid[];
  participants: MantraIdealPickParticipant[];
  auctionSourceUrl: string;
  collectionComplete: boolean;
  missingDetailCount: number;
  targetCount?: number;
};

function validIdealAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
}

function validIdealTeamId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function idealAverageFormatted(numerator: number, count: number): string {
  if (count === 0) return "0M";
  const rounded = Math.round((numerator / count + Number.EPSILON) * 100) / 100;
  return `${rounded}M`;
}

function compareIdealAverage(
  left: { stageAverageBidNumerator: number; stageAverageBidCount: number },
  right: { stageAverageBidNumerator: number; stageAverageBidCount: number },
) {
  const leftCount = left.stageAverageBidCount || 1;
  const rightCount = right.stageAverageBidCount || 1;
  return (
    right.stageAverageBidNumerator * leftCount -
    left.stageAverageBidNumerator * rightCount
  );
}

export function simulateMantraAuctionIdealPicks(source: IdealPickSource) {
  const targetCount = Math.min(
    IDEAL_PICK_TARGET_COUNT,
    Math.max(1, Math.floor(source.targetCount ?? IDEAL_PICK_TARGET_COUNT)),
  );
  const uniqueBids = [...source.bids]
    .sort(
      (left, right) =>
        left.bidId - right.bidId ||
        Number(left.fantasyTeamId ?? Number.MAX_SAFE_INTEGER) -
          Number(right.fantasyTeamId ?? Number.MAX_SAFE_INTEGER) ||
        Number(left.price ?? Number.MAX_SAFE_INTEGER) -
          Number(right.price ?? Number.MAX_SAFE_INTEGER),
    )
    .filter((bid, index, rows) => index === 0 || rows[index - 1]!.bidId !== bid.bidId);
  const bidsByCandidate = new Map<string, MantraIdealPickBid[]>();
  let malformedBidCount = 0;
  for (const bid of uniqueBids) {
    if (!validIdealAmount(bid.price) || !validIdealTeamId(bid.fantasyTeamId)) {
      malformedBidCount += 1;
    }
    const key = `${bid.playerBidId}:${bid.stage}`;
    const rows = bidsByCandidate.get(key) ?? [];
    rows.push(bid);
    bidsByCandidate.set(key, rows);
  }

  const candidates = [...source.candidates]
    .sort(
      (left, right) =>
        left.stage - right.stage ||
        left.mantraPlayerId - right.mantraPlayerId ||
        left.playerBidId - right.playerBidId,
    )
    .filter(
      (candidate, index, rows) =>
        index === 0 ||
        `${rows[index - 1]!.playerBidId}:${rows[index - 1]!.stage}` !==
          `${candidate.playerBidId}:${candidate.stage}`,
    );
  const candidateIds = new Set(
    candidates.map((candidate) => `${candidate.playerBidId}:${candidate.stage}`),
  );
  malformedBidCount += uniqueBids.filter(
    (bid) => !candidateIds.has(`${bid.playerBidId}:${bid.stage}`),
  ).length;
  const dataPartial =
    !source.collectionComplete || source.missingDetailCount > 0 || malformedBidCount > 0;

  const participants = new Map<number, MantraIdealPickParticipant>();
  const rememberTeam = (
    fantasyTeamId: number | null,
    name: string | null,
    logoUrl: string | null,
  ) => {
    if (!validIdealTeamId(fantasyTeamId)) return;
    const current = participants.get(fantasyTeamId);
    participants.set(fantasyTeamId, {
      fantasyTeamId,
      name: current?.name ?? name,
      logoUrl: current?.logoUrl ?? logoUrl,
    });
  };
  for (const participant of [...source.participants].sort(
    (left, right) => left.fantasyTeamId - right.fantasyTeamId,
  )) {
    rememberTeam(participant.fantasyTeamId, participant.name, participant.logoUrl);
  }
  for (const bid of uniqueBids) {
    rememberTeam(bid.fantasyTeamId, bid.fantasyTeamName, bid.fantasyTeamLogoUrl);
  }
  for (const candidate of candidates) {
    rememberTeam(
      candidate.winningTeamId,
      candidate.winningTeamName,
      candidate.winningTeamLogoUrl,
    );
  }

  const outcomesByPlayer = new Map<
    number,
    Array<{
      playerBidId: number;
      stage: number;
      fantasyTeamId: number;
      fantasyTeamName: string | null;
      fantasyTeamLogoUrl: string | null;
      winningBid: number | null;
      sourceUrl: string;
      status: string;
    }>
  >();
  for (const candidate of candidates) {
    if (
      candidate.outcome !== "success" ||
      !validIdealTeamId(candidate.winningTeamId)
    ) {
      continue;
    }
    const successfulBid = (bidsByCandidate.get(
      `${candidate.playerBidId}:${candidate.stage}`,
    ) ?? [])
      .filter(
        (bid) =>
          bid.status === "success" &&
          bid.fantasyTeamId === candidate.winningTeamId &&
          validIdealAmount(bid.price),
      )
      .sort(
        (left, right) =>
          Number(right.price) - Number(left.price) || left.bidId - right.bidId,
      )[0];
    const rows = outcomesByPlayer.get(candidate.mantraPlayerId) ?? [];
    rows.push({
      playerBidId: candidate.playerBidId,
      stage: candidate.stage,
      fantasyTeamId: candidate.winningTeamId,
      fantasyTeamName: candidate.winningTeamName,
      fantasyTeamLogoUrl: candidate.winningTeamLogoUrl,
      winningBid: successfulBid?.price ??
        (validIdealAmount(candidate.winningPrice) ? candidate.winningPrice : null),
      sourceUrl: candidate.stageSourceUrl,
      status: candidate.outcome,
    });
    outcomesByPlayer.set(candidate.mantraPlayerId, rows);
  }
  for (const rows of outcomesByPlayer.values()) {
    rows.sort(
      (left, right) =>
        right.stage - left.stage ||
        right.playerBidId - left.playerBidId ||
        left.fantasyTeamId - right.fantasyTeamId,
    );
  }

  const simulations = [...participants.values()]
    .sort(
      (left, right) =>
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.fantasyTeamId - right.fantasyTeamId,
    )
    .map((manager) => {
      const rankedByStage = new Map<number, Array<MantraIdealPickCandidate & {
        managerOriginalBid: number;
        stageMaxBid: number;
        stageAverageBid: number;
        stageAverageBidNumerator: number;
        stageAverageBidCount: number;
        nearestOtherTeam: {
          bidId: number;
          fantasyTeamId: number;
          name: string | null;
          logoUrl: string | null;
          amount: number;
        } | null;
        requiredIdealBid: number;
        candidateComplete: boolean;
      }>>();
      for (const candidate of candidates) {
        const candidateBids = bidsByCandidate.get(
          `${candidate.playerBidId}:${candidate.stage}`,
        ) ?? [];
        const validBids = candidateBids.filter(
          (bid): bid is MantraIdealPickBid & { price: number; fantasyTeamId: number } =>
            validIdealAmount(bid.price) && validIdealTeamId(bid.fantasyTeamId),
        );
        const managerBids = validBids
          .filter((bid) => bid.fantasyTeamId === manager.fantasyTeamId)
          .sort(
            (left, right) => right.price - left.price || left.bidId - right.bidId,
          );
        const competitors = validBids
          .filter((bid) => bid.fantasyTeamId !== manager.fantasyTeamId)
          .sort(
            (left, right) =>
              right.price - left.price ||
              left.bidId - right.bidId ||
              left.fantasyTeamId - right.fantasyTeamId,
          );
        const nearest = competitors[0] ?? null;
        const numerator = validBids.reduce((sum, bid) => sum + bid.price, 0);
        const malformed = candidateBids.some(
          (bid) => !validIdealAmount(bid.price) || !validIdealTeamId(bid.fantasyTeamId),
        );
        const ranked = rankedByStage.get(candidate.stage) ?? [];
        ranked.push({
          ...candidate,
          managerOriginalBid: managerBids[0]?.price ?? 0,
          stageMaxBid: validBids.reduce((max, bid) => Math.max(max, bid.price), 0),
          stageAverageBid: validBids.length ? numerator / validBids.length : 0,
          stageAverageBidNumerator: numerator,
          stageAverageBidCount: validBids.length,
          nearestOtherTeam: nearest
            ? {
                bidId: nearest.bidId,
                fantasyTeamId: nearest.fantasyTeamId,
                name: nearest.fantasyTeamName,
                logoUrl: nearest.fantasyTeamLogoUrl,
                amount: nearest.price,
              }
            : null,
          requiredIdealBid: nearest ? nearest.price + 1 : 1,
          candidateComplete: source.collectionComplete && !malformed,
        });
        rankedByStage.set(candidate.stage, ranked);
      }

      const selected = new Set<number>();
      const picks: Array<ReturnType<typeof idealPickOutput>> = [];
      for (const stage of [...rankedByStage.keys()].sort((left, right) => left - right)) {
        const ranked = rankedByStage.get(stage)!;
        ranked.sort(
          (left, right) =>
            right.managerOriginalBid - left.managerOriginalBid ||
            right.stageMaxBid - left.stageMaxBid ||
            compareIdealAverage(left, right) ||
            left.mantraPlayerId - right.mantraPlayerId ||
            left.playerBidId - right.playerBidId,
        );
        for (const candidate of ranked) {
          if (selected.has(candidate.mantraPlayerId)) continue;
          selected.add(candidate.mantraPlayerId);
          const outcomes = outcomesByPlayer.get(candidate.mantraPlayerId) ?? [];
          const actual = outcomes[0] ?? null;
          const outcomeAmbiguous = outcomes.length > 1;
          const actuallyAcquiredByManager = actual
            ? actual.fantasyTeamId === manager.fantasyTeamId
            : dataPartial
              ? null
              : false;
          const relationship = actual == null
            ? dataPartial
              ? "unknown"
              : "no_winner"
            : actual.fantasyTeamId === manager.fantasyTeamId
              ? "manager_won"
              : actual.playerBidId === candidate.playerBidId &&
                  actual.stage === candidate.stage
                ? "same_stage_outbid"
                : actual.stage > candidate.stage
                  ? "won_later"
                  : "unknown";
          const actualWinner = actual
            ? {
                fantasyTeamId: actual.fantasyTeamId,
                name:
                  participants.get(actual.fantasyTeamId)?.name ??
                  actual.fantasyTeamName,
                logoUrl:
                  participants.get(actual.fantasyTeamId)?.logoUrl ??
                  actual.fantasyTeamLogoUrl,
                winningBid: actual.winningBid,
                winningStage: actual.stage,
                sourceUrl: actual.sourceUrl,
                status: actual.status,
              }
            : null;
          picks.push(
            idealPickOutput(
              candidate,
              picks.length + 1,
              source.auctionSourceUrl,
              actuallyAcquiredByManager,
              relationship,
              actualWinner,
              outcomeAmbiguous,
            ),
          );
          if (picks.length === targetCount) break;
        }
        if (picks.length === targetCount) break;
      }
      const deficit = Math.max(0, targetCount - picks.length);
      const provisionalIdealTotal = picks.reduce(
        (sum, pick) => sum + pick.requiredIdealBid,
        0,
      );
      const complete = !dataPartial && deficit === 0;
      const acquiredKnown = picks.filter(
        (pick) => pick.actuallyAcquiredByManager === true,
      ).length;
      const missedKnown = picks.filter(
        (pick) => pick.actuallyAcquiredByManager === false,
      ).length;
      const unknownOutcomeCount = picks.filter(
        (pick) => pick.actualWinner == null,
      ).length;
      const competitorGroups = new Map<
        number,
        {
          fantasyTeamId: number;
          name: string | null;
          logoUrl: string | null;
          players: Array<{ mantraPlayerId: number; name: string; relationship: string }>;
          actualWinningBidKnownTotal: number;
          unknownWinningBidCount: number;
        }
      >();
      for (const pick of picks) {
        if (
          pick.actuallyAcquiredByManager !== false ||
          !pick.actualWinner ||
          pick.actualWinner.fantasyTeamId === manager.fantasyTeamId
        ) {
          continue;
        }
        const current = competitorGroups.get(pick.actualWinner.fantasyTeamId) ?? {
          fantasyTeamId: pick.actualWinner.fantasyTeamId,
          name: pick.actualWinner.name,
          logoUrl: pick.actualWinner.logoUrl,
          players: [],
          actualWinningBidKnownTotal: 0,
          unknownWinningBidCount: 0,
        };
        current.players.push({
          mantraPlayerId: pick.mantraPlayerId,
          name: `${pick.player.firstName ?? ""} ${pick.player.name}`.trim(),
          relationship: pick.actualRelationship,
        });
        if (pick.actualWinner.winningBid == null) current.unknownWinningBidCount += 1;
        else current.actualWinningBidKnownTotal += pick.actualWinner.winningBid;
        competitorGroups.set(current.fantasyTeamId, current);
      }
      const whoOutbid = [...competitorGroups.values()]
        .map((group) => ({
          ...group,
          count: group.players.length,
          exactCount: complete ? group.players.length : null,
          actualWinningBidTotal:
            complete && group.unknownWinningBidCount === 0
              ? group.actualWinningBidKnownTotal
              : null,
          provisional: !complete,
        }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            right.actualWinningBidKnownTotal - left.actualWinningBidKnownTotal ||
            left.fantasyTeamId - right.fantasyTeamId ||
            (left.name ?? "").localeCompare(right.name ?? ""),
        );
      const missedWithKnownCompetitor = whoOutbid.reduce(
        (sum, group) => sum + group.count,
        0,
      );
      return {
        fantasyTeamId: manager.fantasyTeamId,
        name: manager.name,
        logoUrl: manager.logoUrl,
        selectedCount: picks.length,
        idealTargetCount: picks.length,
        targetCount,
        deficit,
        incomplete: !complete,
        partial: dataPartial,
        idealTotal: complete ? provisionalIdealTotal : null,
        provisionalIdealTotal,
        actuallyAcquiredCount: complete ? acquiredKnown : null,
        actuallyAcquiredKnownCount: acquiredKnown,
        missedTargetCount: complete ? missedKnown : null,
        missedTargetKnownCount: missedKnown,
        missedWithKnownCompetitorCount: complete
          ? missedWithKnownCompetitor
          : null,
        missedWithKnownCompetitorKnownCount: missedWithKnownCompetitor,
        missedUnknownOutcomeCount: complete ? unknownOutcomeCount : null,
        missedUnknownOutcomeKnownCount: unknownOutcomeCount,
        topCompetitor: whoOutbid[0]
          ? {
              fantasyTeamId: whoOutbid[0].fantasyTeamId,
              name: whoOutbid[0].name,
              logoUrl: whoOutbid[0].logoUrl,
              count: whoOutbid[0].count,
              exactCount: whoOutbid[0].exactCount,
            }
          : null,
        whoOutbid,
        picks,
      };
    });
  return {
    targetCount,
    collectionComplete: source.collectionComplete,
    partial: dataPartial,
    missingDetailCount: source.missingDetailCount,
    malformedBidCount,
    simulations,
  };
}

function idealPickOutput(
  candidate: MantraIdealPickCandidate & {
    managerOriginalBid: number;
    stageMaxBid: number;
    stageAverageBid: number;
    stageAverageBidNumerator: number;
    stageAverageBidCount: number;
    nearestOtherTeam: {
      bidId: number;
      fantasyTeamId: number;
      name: string | null;
      logoUrl: string | null;
      amount: number;
    } | null;
    requiredIdealBid: number;
    candidateComplete: boolean;
  },
  pickOrder: number,
  auctionSourceUrl: string,
  actuallyAcquiredByManager: boolean | null,
  actualRelationship: string,
  actualWinner: {
    fantasyTeamId: number;
    name: string | null;
    logoUrl: string | null;
    winningBid: number | null;
    winningStage: number;
    sourceUrl: string;
    status: string;
  } | null,
  outcomeAmbiguous: boolean,
) {
  const profilePlayerId =
    candidate.tmUrl?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
  return {
    pickOrder,
    stage: candidate.stage,
    playerBidId: candidate.playerBidId,
    mantraPlayerId: candidate.mantraPlayerId,
    canonicalPlayerId: candidate.mantraPlayerId,
    player: {
      firstName: candidate.firstName,
      name: candidate.name,
      avatarUrl:
        normalizeMantraImageUrl(candidate.canonicalAvatarUrl) ??
        normalizeMantraImageUrl(candidate.avatarUrl),
      positions: candidate.positions,
      profilePlayerId,
      profileUrl: profilePlayerId ? `/player.html?id=${profilePlayerId}` : null,
    },
    managerOriginalBid: candidate.managerOriginalBid,
    stageMaxBid: candidate.stageMaxBid,
    stageAverageBid: candidate.stageAverageBid,
    stageAverageBidNumerator: candidate.stageAverageBidNumerator,
    stageAverageBidCount: candidate.stageAverageBidCount,
    stageAverageBidFormatted: idealAverageFormatted(
      candidate.stageAverageBidNumerator,
      candidate.stageAverageBidCount,
    ),
    nearestOtherTeam: candidate.nearestOtherTeam,
    requiredIdealBid: candidate.requiredIdealBid,
    source: {
      auctionUrl: auctionSourceUrl,
      stageUrl: candidate.stageSourceUrl,
      playerDetailUrl: candidate.playerSourceUrl,
    },
    complete: candidate.candidateComplete,
    actuallyAcquiredByManager,
    actualRelationship,
    actualWinner,
    actualOutcomeAmbiguous: outcomeAmbiguous,
    actualWinningBidGap:
      actualRelationship === "same_stage_outbid" &&
      candidate.managerOriginalBid > 0 &&
      actualWinner?.winningBid != null
        ? actualWinner.winningBid - candidate.managerOriginalBid
        : null,
  };
}

function getMantraAuctionIdealPickData(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
  },
) {
  const scope = getAuctionReportScope(database, options);
  if (
    !scope ||
    !auctionReportScopeBrowsable(scope) ||
    (scope.detailsTotal === 0 && scope.detailsProcessed === 0)
  ) {
    return null;
  }
  const rows = database
    .prepare(
      `SELECT p.player_bid_id AS playerBidId,
              p.mantra_player_id AS mantraPlayerId, p.first_name AS firstName,
              p.name, p.avatar_url AS avatarUrl,
              mp.avatar_path AS canonicalAvatarUrl, mp.tm_url AS tmUrl,
              p.positions_json AS positionsJson, ps.stage,
              s.source_url AS stageSourceUrl, p.source_url AS playerSourceUrl,
              ps.outcome, ps.winning_price AS winningPrice,
              ps.winning_team_id AS winningTeamId,
              ps.winning_team_name AS winningTeamName,
              ps.winning_team_logo_url AS winningTeamLogoUrl
       FROM mantra_auction_player_stages ps
       JOIN mantra_auction_players p
         ON p.mantra_league_id = ps.mantra_league_id
        AND p.auction_id = ps.auction_id
        AND p.player_bid_id = ps.player_bid_id
       JOIN mantra_auction_stages s
         ON s.mantra_league_id = ps.mantra_league_id
        AND s.auction_id = ps.auction_id AND s.stage = ps.stage
       LEFT JOIN mantra_players mp ON mp.id = p.mantra_player_id
       WHERE ps.mantra_league_id = ? AND ps.auction_id = ?
       ORDER BY ps.stage ASC, p.mantra_player_id ASC, p.player_bid_id ASC`,
    )
    .all(options.mantraLeagueId, options.auctionId) as Array<
      Omit<MantraIdealPickCandidate, "positions"> & { positionsJson: string }
    >;
  const candidates = rows.map(({ positionsJson, ...row }) => ({
    ...row,
    positions: jsonArray(positionsJson),
  }));
  const bids = database
    .prepare(
      `SELECT b.player_bid_id AS playerBidId, b.stage, b.bid_id AS bidId,
              b.status, b.price, b.fantasy_team_id AS fantasyTeamId,
              b.fantasy_team_name AS fantasyTeamName,
              b.fantasy_team_logo_url AS fantasyTeamLogoUrl
       FROM mantra_auction_bids b
       WHERE b.mantra_league_id = ? AND b.auction_id = ?
       ORDER BY b.bid_id ASC`,
    )
    .all(options.mantraLeagueId, options.auctionId) as MantraIdealPickBid[];
  const participantRows = database
    .prepare(
      `SELECT fantasyTeamId, MAX(name) AS name, MAX(logoUrl) AS logoUrl
       FROM (
         SELECT b.fantasy_team_id AS fantasyTeamId,
                b.fantasy_team_name AS name,
                b.fantasy_team_logo_url AS logoUrl
         FROM mantra_auction_bids b
         WHERE b.mantra_league_id = ? AND b.auction_id = ?
           AND b.fantasy_team_id IS NOT NULL
         UNION ALL
         SELECT ps.winning_team_id, ps.winning_team_name,
                ps.winning_team_logo_url
         FROM mantra_auction_player_stages ps
         WHERE ps.mantra_league_id = ? AND ps.auction_id = ?
           AND ps.winning_team_id IS NOT NULL
       )
       GROUP BY fantasyTeamId
       ORDER BY fantasyTeamId ASC`,
    )
    .all(
      options.mantraLeagueId,
      options.auctionId,
      options.mantraLeagueId,
      options.auctionId,
    ) as MantraIdealPickParticipant[];
  const collectionComplete =
    scope.completedAt != null && scope.detailsProcessed === scope.detailsTotal;
  const missingDetailCount = Math.max(0, scope.detailsTotal - scope.detailsProcessed);
  return {
    scope,
    result: simulateMantraAuctionIdealPicks({
      candidates,
      bids,
      participants: participantRows,
      auctionSourceUrl: scope.auctionSourceUrl,
      collectionComplete,
      missingDetailCount,
    }),
  };
}

function idealPickSemantics() {
  return {
    bidData: "unique_final_bid_records_returned_by_mantra_api",
    stageOrder: "canonical_numeric_ascending",
    ranking: [
      "manager_original_bid_desc",
      "stage_max_bid_desc",
      "stage_average_unique_bid_desc",
      "canonical_player_id_then_history_id_asc",
    ],
    requiredBid: "maximum_other_team_bid_plus_1m_or_1m_floor",
    independentManagers: true,
    average: {
      raw: "numerator_and_count",
      display: "nearest_0.01m",
    },
    whoOutbid:
      "historical_actual_owner_of_ideal_target_under_original_bids_not_counterfactual_outbid",
    participantLimitation:
      "only_fantasy_team_ids_present_in_auction_bid_or_winner_data_are_discoverable",
  };
}

export function getMantraAuctionIdealPickSummaries(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
  },
) {
  const data = getMantraAuctionIdealPickData(database, options);
  if (!data) return null;
  const { scope, result } = data;
  return {
    scopeKey: options.scopeKey,
    mantraLeagueId: options.mantraLeagueId,
    auctionId: options.auctionId,
    fantasyLeagueName: scope.fantasyLeagueName,
    auctionLabel: scope.auctionLabel,
    dataVersion: `${scope.completedAt ?? scope.fetchedAt}:${scope.detailsProcessed}:${scope.detailsTotal}`,
    targetCount: result.targetCount,
    collectionComplete: result.collectionComplete,
    partial: result.partial,
    completeness: {
      detailsProcessed: scope.detailsProcessed,
      detailsTotal: scope.detailsTotal,
      missingDetailCount: result.missingDetailCount,
      malformedBidCount: result.malformedBidCount,
      knownParticipantCount: result.simulations.length,
    },
    semantics: idealPickSemantics(),
    teams: result.simulations.map(({ picks: _picks, whoOutbid: _whoOutbid, ...team }) => team),
  };
}

export function getMantraAuctionIdealPickDetail(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraLeagueId: number;
    auctionId: number;
    fantasyTeamId: number;
  },
) {
  const data = getMantraAuctionIdealPickData(database, options);
  if (!data) return null;
  const simulation = data.result.simulations.find(
    (team) => team.fantasyTeamId === options.fantasyTeamId,
  );
  if (!simulation) return undefined;
  const { scope, result } = data;
  return {
    scopeKey: options.scopeKey,
    mantraLeagueId: options.mantraLeagueId,
    auctionId: options.auctionId,
    fantasyLeagueName: scope.fantasyLeagueName,
    auctionLabel: scope.auctionLabel,
    dataVersion: `${scope.completedAt ?? scope.fetchedAt}:${scope.detailsProcessed}:${scope.detailsTotal}`,
    collectionComplete: result.collectionComplete,
    partial: simulation.partial,
    incomplete: simulation.incomplete,
    completeness: {
      detailsProcessed: scope.detailsProcessed,
      detailsTotal: scope.detailsTotal,
      missingDetailCount: result.missingDetailCount,
      malformedBidCount: result.malformedBidCount,
    },
    semantics: idealPickSemantics(),
    team: {
      fantasyTeamId: simulation.fantasyTeamId,
      name: simulation.name,
      logoUrl: simulation.logoUrl,
    },
    summary: {
      selectedCount: simulation.selectedCount,
      idealTargetCount: simulation.idealTargetCount,
      targetCount: simulation.targetCount,
      deficit: simulation.deficit,
      idealTotal: simulation.idealTotal,
      provisionalIdealTotal: simulation.provisionalIdealTotal,
      actuallyAcquiredCount: simulation.actuallyAcquiredCount,
      actuallyAcquiredKnownCount: simulation.actuallyAcquiredKnownCount,
      missedTargetCount: simulation.missedTargetCount,
      missedTargetKnownCount: simulation.missedTargetKnownCount,
      missedWithKnownCompetitorCount: simulation.missedWithKnownCompetitorCount,
      missedWithKnownCompetitorKnownCount:
        simulation.missedWithKnownCompetitorKnownCount,
      missedUnknownOutcomeCount: simulation.missedUnknownOutcomeCount,
      missedUnknownOutcomeKnownCount: simulation.missedUnknownOutcomeKnownCount,
      topCompetitor: simulation.topCompetitor,
    },
    whoOutbid: simulation.whoOutbid,
    picks: simulation.picks,
  };
}

export function getMantraAuctionPlayers(
  database: Database.Database,
  options: {
    mantraLeagueId: number;
    auctionId: number;
    page?: number;
    limit?: number;
    query?: string;
    stage?: number;
    outcome?: "success" | "failed";
    bidRecordsMin?: number;
    bidRecordsMax?: number;
    stagesMin?: number;
    stagesMax?: number;
    bidAmountMin?: number;
    bidAmountMax?: number;
    sort?: "bidRecords" | "stages" | "bidAmount" | "maxBid" | "finalPrice" | "name";
    direction?: "asc" | "desc";
  },
) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)));
  const where = ["p.mantra_league_id = ?", "p.auction_id = ?"];
  const params: unknown[] = [options.mantraLeagueId, options.auctionId];
  if (options.query) {
    where.push(`LOWER(COALESCE(p.first_name, '') || ' ' || p.name) LIKE ? ESCAPE '\\'`);
    params.push(
      `%${options.query.toLowerCase().replace(/[\\%_]/g, (value) => `\\${value}`)}%`,
    );
  }
  if (options.stage) {
    where.push(
      `EXISTS (SELECT 1 FROM mantra_auction_player_stages sf
       WHERE sf.mantra_league_id = p.mantra_league_id
         AND sf.auction_id = p.auction_id AND sf.player_bid_id = p.player_bid_id
         AND sf.stage = ?)`,
    );
    params.push(options.stage);
  }
  if (options.outcome) {
    where.push(
      `EXISTS (SELECT 1 FROM mantra_auction_player_stages so
       WHERE so.mantra_league_id = p.mantra_league_id
         AND so.auction_id = p.auction_id AND so.player_bid_id = p.player_bid_id
         AND so.outcome = ?)`,
    );
    params.push(options.outcome);
  }
  for (const [value, expression, operator] of [
    [options.bidRecordsMin, "COALESCE(ba.bidRecordCount, 0)", ">="],
    [options.bidRecordsMax, "COALESCE(ba.bidRecordCount, 0)", "<="],
    [options.stagesMin, "COALESCE(sa.stageCount, 0)", ">="],
    [options.stagesMax, "COALESCE(sa.stageCount, 0)", "<="],
    [options.bidAmountMin, "COALESCE(ba.bidAmountSum, 0)", ">="],
    [options.bidAmountMax, "COALESCE(ba.bidAmountSum, 0)", "<="],
  ] as Array<[number | undefined, string, string]>) {
    if (value != null) {
      where.push(`${expression} ${operator} ?`);
      params.push(value);
    }
  }
  const aggregateJoin = `
    LEFT JOIN (
      SELECT mantra_league_id, auction_id, player_bid_id,
             COUNT(*) AS bidRecordCount, COALESCE(SUM(price), 0) AS bidAmountSum,
             MAX(price) AS maxBidAmount
      FROM (
        SELECT mantra_league_id, auction_id, player_bid_id, bid_id, MAX(price) AS price
        FROM mantra_auction_bids
        GROUP BY mantra_league_id, auction_id, player_bid_id, bid_id
      ) unique_bids
      GROUP BY mantra_league_id, auction_id, player_bid_id
    ) ba
      ON ba.mantra_league_id = p.mantra_league_id
     AND ba.auction_id = p.auction_id
     AND ba.player_bid_id = p.player_bid_id
    LEFT JOIN (
      SELECT mantra_league_id, auction_id, player_bid_id,
             COUNT(DISTINCT stage) AS stageCount
      FROM mantra_auction_player_stages
      GROUP BY mantra_league_id, auction_id, player_bid_id
    ) sa
      ON sa.mantra_league_id = p.mantra_league_id
     AND sa.auction_id = p.auction_id
     AND sa.player_bid_id = p.player_bid_id`;
  const whereSql = where.join(" AND ");
  const total = (
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mantra_auction_players p
         ${aggregateJoin}
         WHERE ${whereSql}`,
      )
      .get(...params) as { count: number }
  ).count;
  const direction = options.direction === "asc" ? "ASC" : "DESC";
  const sortExpression = {
    bidRecords: "COALESCE(ba.bidRecordCount, 0)",
    stages: "COALESCE(sa.stageCount, 0)",
    bidAmount: "COALESCE(ba.bidAmountSum, 0)",
    maxBid: "ba.maxBidAmount",
    finalPrice: "COALESCE(p.final_price, -1)",
    name: "LOWER(COALESCE(p.first_name, '') || ' ' || p.name)",
  }[options.sort ?? "finalPrice"];
  const orderDirection = options.sort === "name" ? "ASC" : direction;
  const nullsLast = options.sort === "maxBid" ? `${sortExpression} IS NULL ASC,` : "";
  const rows = database
    .prepare(
      `SELECT p.player_bid_id AS playerBidId, p.mantra_player_id AS mantraPlayerId,
              p.first_name AS firstName, p.name,
              p.avatar_url AS auctionAvatarUrl,
              p.positions_json AS positionsJson,
              p.positions_italian_json AS positionsItalianJson,
              p.club_id AS clubId, p.club_name AS clubName,
              p.club_logo_url AS clubLogoUrl, p.status, p.final_price AS finalPrice,
              p.source_url AS sourceUrl, p.fetched_at AS fetchedAt,
              mp.tm_url AS tmUrl, mp.avatar_path AS canonicalAvatarUrl,
              COALESCE(ba.bidRecordCount, 0) AS bidRecordCount,
              COALESCE(sa.stageCount, 0) AS stageCount,
              COALESCE(ba.bidAmountSum, 0) AS bidAmountSum,
              ba.maxBidAmount AS maxBidAmount
       FROM mantra_auction_players p
       LEFT JOIN mantra_players mp ON mp.id = p.mantra_player_id
       ${aggregateJoin}
       WHERE ${whereSql}
       ORDER BY ${nullsLast} ${sortExpression} ${orderDirection},
                LOWER(COALESCE(p.first_name, '') || ' ' || p.name) ASC,
                p.player_bid_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, (page - 1) * limit) as Array<
    Record<string, unknown> & {
      playerBidId: number;
      positionsJson: string;
      positionsItalianJson: string;
      tmUrl: string | null;
      canonicalAvatarUrl: string | null;
      auctionAvatarUrl: string | null;
      bidRecordCount: number;
      stageCount: number;
      bidAmountSum: number;
      maxBidAmount: number | null;
    }
  >;
  const stageQuery = database.prepare(
    `SELECT ps.stage, ps.outcome, ps.winning_price AS winningPrice,
            winning_team_id AS winningTeamId,
            winning_team_name AS winningTeamName,
            winning_team_logo_url AS winningTeamLogoUrl,
            s.source_url AS sourceUrl
     FROM mantra_auction_player_stages ps
     LEFT JOIN mantra_auction_stages s
       ON s.mantra_league_id = ps.mantra_league_id
      AND s.auction_id = ps.auction_id AND s.stage = ps.stage
     WHERE ps.mantra_league_id = ? AND ps.auction_id = ? AND ps.player_bid_id = ?
     ORDER BY ps.stage DESC`,
  );
  const bidQuery = database.prepare(
    `SELECT bid_id AS id, bid_order AS "order", status, price,
            fantasy_team_id AS teamId, fantasy_team_name AS teamName,
            fantasy_team_logo_url AS teamLogoUrl
     FROM mantra_auction_bids
     WHERE mantra_league_id = ? AND auction_id = ?
       AND player_bid_id = ? AND stage = ?
     ORDER BY bid_order`,
  );
  const sync = database
    .prepare(
      `SELECT a.completed_at AS auctionCompletedAt, j.status AS scopeStatus,
              a.scope_key AS scopeKey, a.source_url AS auctionSourceUrl,
              COALESCE(l.name, a.league_label) AS fantasyLeagueName
       FROM mantra_auctions a
       JOIN mantra_auction_jobs j ON j.scope_key = a.scope_key
       LEFT JOIN mantra_auction_leagues l
         ON l.mantra_league_id = a.mantra_league_id
       WHERE a.mantra_league_id = ? AND a.auction_id = ?`,
    )
    .get(options.mantraLeagueId, options.auctionId) as
    | {
        auctionCompletedAt: string | null;
        scopeStatus: JobStatus;
        scopeKey: MantraAuctionScopeKey;
        auctionSourceUrl: string;
        fantasyLeagueName: string | null;
      }
    | undefined;
  const players = rows.map(({
    positionsJson,
    positionsItalianJson,
    tmUrl,
    canonicalAvatarUrl,
    auctionAvatarUrl,
    ...row
  }) => {
    const stages = (
      stageQuery.all(options.mantraLeagueId, options.auctionId, row.playerBidId) as Array<
        Record<string, unknown> & { stage: number; sourceUrl: string | null }
      >
    ).map((stage) => ({
      ...stage,
      bids: bidQuery.all(
        options.mantraLeagueId,
        options.auctionId,
        row.playerBidId,
        stage.stage,
      ) as Array<{
        id: number;
        order: number;
        status: string | null;
        price: number | null;
        teamId: number | null;
        teamName: string | null;
        teamLogoUrl: string | null;
      }>,
    }));
    const profilePlayerId =
      tmUrl?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
    const maxBidCandidate = stages
      .flatMap((stage) =>
        stage.bids.map((bid) => ({ ...bid, stage: stage.stage, sourceUrl: stage.sourceUrl })),
      )
      .filter((bid) => bid.price != null)
      .sort(
        (left, right) =>
          Number(right.price) - Number(left.price) ||
          right.stage - left.stage ||
          right.id - left.id,
      )[0];
    const maxBid = maxBidCandidate
      ? {
          amount: maxBidCandidate.price,
          fantasyTeamId: maxBidCandidate.teamId,
          fantasyTeamName: maxBidCandidate.teamName,
          fantasyTeamLogoUrl: maxBidCandidate.teamLogoUrl,
          fantasyLeagueId: options.mantraLeagueId,
          fantasyLeagueName: sync?.fantasyLeagueName ?? null,
          auctionId: options.auctionId,
          stage: maxBidCandidate.stage,
          bidId: maxBidCandidate.id,
          sourceUrl: maxBidCandidate.sourceUrl ?? sync?.auctionSourceUrl ?? row.sourceUrl,
          winner: maxBidCandidate.status === "success",
        }
      : null;
    return {
      ...row,
      totalBidAmount: row.bidAmountSum,
      avatarUrl:
        normalizeMantraImageUrl(canonicalAvatarUrl) ??
        normalizeMantraImageUrl(auctionAvatarUrl),
      positions: jsonArray(positionsJson),
      positionsItalian: jsonArray(positionsItalianJson),
      profilePlayerId,
      profileUrl: profilePlayerId ? `/player.html?id=${profilePlayerId}` : null,
      maxBid,
      stages,
    };
  });
  return {
    mode: "single" as const,
    scopeKey: sync?.scopeKey ?? null,
    mantraLeagueId: options.mantraLeagueId,
    auctionId: options.auctionId,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    preliminary:
      !sync?.auctionCompletedAt || sync.scopeStatus !== "complete",
    players,
  };
}

export function getMantraAuctionPlayersAcrossScope(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    page?: number;
    limit?: number;
    query?: string;
    stage?: number;
    outcome?: "success" | "failed";
    bidRecordsMin?: number;
    bidRecordsMax?: number;
    stagesMin?: number;
    stagesMax?: number;
    bidAmountMin?: number;
    bidAmountMax?: number;
    sort?: "bidRecords" | "stages" | "bidAmount" | "maxBid" | "name";
    direction?: "asc" | "desc";
  },
) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)));
  const commonSql = `
    WITH scoped_player_rows AS (
      SELECT p.*,
             ROW_NUMBER() OVER (
               PARTITION BY p.mantra_player_id
               ORDER BY p.auction_id DESC, p.player_bid_id DESC, p.mantra_league_id DESC
             ) AS representativeRank
      FROM mantra_auction_players p
      JOIN mantra_auctions a
        ON a.mantra_league_id = p.mantra_league_id AND a.auction_id = p.auction_id
      WHERE a.scope_key = ?
    ),
    players AS (
      SELECT * FROM scoped_player_rows WHERE representativeRank = 1
    ),
    unique_bids AS (
      SELECT spr.mantra_player_id AS mantraPlayerId,
             b.mantra_league_id AS mantraLeagueId, b.auction_id AS auctionId,
             b.bid_id AS bidId, MAX(b.price) AS price
      FROM scoped_player_rows spr
      JOIN mantra_auction_bids b
        ON b.mantra_league_id = spr.mantra_league_id
       AND b.auction_id = spr.auction_id
       AND b.player_bid_id = spr.player_bid_id
      GROUP BY spr.mantra_player_id, b.mantra_league_id, b.auction_id, b.bid_id
    ),
    bid_aggregates AS (
      SELECT mantraPlayerId, COUNT(*) AS bidRecordCount,
             COALESCE(SUM(price), 0) AS totalBidAmount, MAX(price) AS maxBidAmount
      FROM unique_bids
      GROUP BY mantraPlayerId
    ),
    stage_rows AS (
      SELECT spr.mantra_player_id AS mantraPlayerId,
             ps.auction_id AS auctionId, ps.stage, ps.outcome
      FROM scoped_player_rows spr
      JOIN mantra_auction_player_stages ps
        ON ps.mantra_league_id = spr.mantra_league_id
       AND ps.auction_id = spr.auction_id
       AND ps.player_bid_id = spr.player_bid_id
      GROUP BY spr.mantra_player_id, ps.auction_id, ps.stage, ps.outcome
    ),
    stage_aggregates AS (
      SELECT mantraPlayerId, COUNT(DISTINCT auctionId || ':' || stage) AS stageCount
      FROM stage_rows
      GROUP BY mantraPlayerId
    ),
    auction_aggregates AS (
      SELECT mantra_player_id AS mantraPlayerId,
             COUNT(DISTINCT mantra_league_id || ':' || auction_id) AS auctionCount
      FROM scoped_player_rows
      GROUP BY mantra_player_id
    ),
    ranked_max_bids AS (
      SELECT spr.mantra_player_id AS mantraPlayerId, b.price AS maxBidAmount,
             b.fantasy_team_id AS maxBidFantasyTeamId,
             b.fantasy_team_name AS maxBidFantasyTeamName,
             b.fantasy_team_logo_url AS maxBidFantasyTeamLogoUrl,
             b.mantra_league_id AS maxBidFantasyLeagueId,
             COALESCE(l.name, a.league_label) AS maxBidFantasyLeagueName,
             b.auction_id AS maxBidAuctionId, b.stage AS maxBidStage,
             b.bid_id AS maxBidId, b.status AS maxBidStatus,
             COALESCE(s.source_url, a.source_url) AS maxBidSourceUrl,
             ROW_NUMBER() OVER (
               PARTITION BY spr.mantra_player_id
               ORDER BY b.price DESC, b.auction_id DESC, b.stage DESC,
                        b.mantra_league_id DESC, b.bid_id DESC
             ) AS maxBidRank
      FROM scoped_player_rows spr
      JOIN mantra_auction_bids b
        ON b.mantra_league_id = spr.mantra_league_id
       AND b.auction_id = spr.auction_id
       AND b.player_bid_id = spr.player_bid_id
      JOIN mantra_auctions a
        ON a.mantra_league_id = b.mantra_league_id AND a.auction_id = b.auction_id
      LEFT JOIN mantra_auction_leagues l
        ON l.mantra_league_id = b.mantra_league_id
      LEFT JOIN mantra_auction_stages s
        ON s.mantra_league_id = b.mantra_league_id
       AND s.auction_id = b.auction_id AND s.stage = b.stage
      WHERE b.price IS NOT NULL
    ),
    max_bids AS (
      SELECT * FROM ranked_max_bids WHERE maxBidRank = 1
    )`;
  const where: string[] = [];
  const filterParams: unknown[] = [];
  if (options.query) {
    where.push(
      `EXISTS (
        SELECT 1 FROM scoped_player_rows search_row
        WHERE search_row.mantra_player_id = p.mantra_player_id
          AND LOWER(COALESCE(search_row.first_name, '') || ' ' || search_row.name)
              LIKE ? ESCAPE '\\'
      )`,
    );
    filterParams.push(
      `%${options.query.toLowerCase().replace(/[\\%_]/g, (value) => `\\${value}`)}%`,
    );
  }
  if (options.stage) {
    where.push(
      `EXISTS (
        SELECT 1 FROM stage_rows sf
        WHERE sf.mantraPlayerId = p.mantra_player_id AND sf.stage = ?
      )`,
    );
    filterParams.push(options.stage);
  }
  if (options.outcome) {
    where.push(
      `EXISTS (
        SELECT 1 FROM stage_rows so
        WHERE so.mantraPlayerId = p.mantra_player_id AND so.outcome = ?
      )`,
    );
    filterParams.push(options.outcome);
  }
  for (const [value, expression, operator] of [
    [options.bidRecordsMin, "COALESCE(ba.bidRecordCount, 0)", ">="],
    [options.bidRecordsMax, "COALESCE(ba.bidRecordCount, 0)", "<="],
    [options.stagesMin, "COALESCE(sa.stageCount, 0)", ">="],
    [options.stagesMax, "COALESCE(sa.stageCount, 0)", "<="],
    [options.bidAmountMin, "COALESCE(ba.totalBidAmount, 0)", ">="],
    [options.bidAmountMax, "COALESCE(ba.totalBidAmount, 0)", "<="],
  ] as Array<[number | undefined, string, string]>) {
    if (value != null) {
      where.push(`${expression} ${operator} ?`);
      filterParams.push(value);
    }
  }
  const joins = `
    LEFT JOIN bid_aggregates ba ON ba.mantraPlayerId = p.mantra_player_id
    LEFT JOIN stage_aggregates sa ON sa.mantraPlayerId = p.mantra_player_id
    LEFT JOIN auction_aggregates aa ON aa.mantraPlayerId = p.mantra_player_id
    LEFT JOIN max_bids mb ON mb.mantraPlayerId = p.mantra_player_id`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const params = [options.scopeKey, ...filterParams];
  const total = (
    database
      .prepare(`${commonSql} SELECT COUNT(*) AS count FROM players p ${joins} ${whereSql}`)
      .get(...params) as { count: number }
  ).count;
  const direction = options.direction === "asc" ? "ASC" : "DESC";
  const sortExpression = {
    bidRecords: "COALESCE(ba.bidRecordCount, 0)",
    stages: "COALESCE(sa.stageCount, 0)",
    bidAmount: "COALESCE(ba.totalBidAmount, 0)",
    maxBid: "mb.maxBidAmount",
    name: "LOWER(COALESCE(p.first_name, '') || ' ' || p.name)",
  }[options.sort ?? "maxBid"];
  const orderDirection = options.sort === "name" ? "ASC" : direction;
  const nullsLast = options.sort === "maxBid" || options.sort == null
    ? `${sortExpression} IS NULL ASC,`
    : "";
  const rows = database
    .prepare(
      `${commonSql}
       SELECT p.player_bid_id AS playerBidId, p.mantra_player_id AS mantraPlayerId,
              p.first_name AS firstName, p.name, p.avatar_url AS auctionAvatarUrl,
              p.positions_json AS positionsJson,
              p.positions_italian_json AS positionsItalianJson,
              p.club_id AS clubId, p.club_name AS clubName,
              p.club_logo_url AS clubLogoUrl, p.source_url AS sourceUrl,
              p.fetched_at AS fetchedAt, mp.tm_url AS tmUrl,
              mp.avatar_path AS canonicalAvatarUrl,
              COALESCE(ba.bidRecordCount, 0) AS bidRecordCount,
              COALESCE(sa.stageCount, 0) AS stageCount,
              COALESCE(aa.auctionCount, 0) AS auctionCount,
              COALESCE(ba.totalBidAmount, 0) AS totalBidAmount,
              mb.maxBidAmount, mb.maxBidFantasyTeamId,
              mb.maxBidFantasyTeamName, mb.maxBidFantasyTeamLogoUrl,
              mb.maxBidFantasyLeagueId, mb.maxBidFantasyLeagueName,
              mb.maxBidAuctionId, mb.maxBidStage, mb.maxBidId,
              mb.maxBidStatus, mb.maxBidSourceUrl
       FROM players p
       LEFT JOIN mantra_players mp ON mp.id = p.mantra_player_id
       ${joins}
       ${whereSql}
       ORDER BY ${nullsLast} ${sortExpression} ${orderDirection},
                LOWER(COALESCE(mb.maxBidFantasyTeamName, '')) ASC,
                LOWER(COALESCE(p.first_name, '') || ' ' || p.name) ASC,
                p.mantra_player_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, (page - 1) * limit) as Array<Record<string, unknown> & {
      mantraPlayerId: number;
      bidRecordCount: number;
      stageCount: number;
      auctionCount: number;
      positionsJson: string;
      positionsItalianJson: string;
      tmUrl: string | null;
      canonicalAvatarUrl: string | null;
      auctionAvatarUrl: string | null;
      totalBidAmount: number;
      maxBidAmount: number | null;
      maxBidFantasyTeamId: number | null;
      maxBidFantasyTeamName: string | null;
      maxBidFantasyTeamLogoUrl: string | null;
      maxBidFantasyLeagueId: number | null;
      maxBidFantasyLeagueName: string | null;
      maxBidAuctionId: number | null;
      maxBidStage: number | null;
      maxBidId: number | null;
      maxBidStatus: string | null;
      maxBidSourceUrl: string | null;
    }>;
  const scope = database
    .prepare(
      `SELECT scope_name AS name, status, updated_at AS dataVersion
       FROM mantra_auction_jobs WHERE scope_key = ?`,
    )
    .get(options.scopeKey) as
    | { name: string; status: JobStatus; dataVersion: string }
    | undefined;
  const contentAuctionCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mantra_auctions a
         WHERE a.scope_key = ?
           AND EXISTS (
             SELECT 1 FROM mantra_auction_players p
             WHERE p.mantra_league_id = a.mantra_league_id
               AND p.auction_id = a.auction_id
           )`,
      )
      .get(options.scopeKey) as { count: number }
  ).count;
  return {
    mode: "all" as const,
    scopeKey: options.scopeKey,
    scopeName: scope?.name ?? options.scopeKey,
    dataVersion: scope?.dataVersion ?? null,
    contentAuctionCount,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    preliminary: scope?.status !== "complete",
    players: rows.map(({
      positionsJson,
      positionsItalianJson,
      tmUrl,
      canonicalAvatarUrl,
      auctionAvatarUrl,
      maxBidFantasyTeamId,
      maxBidFantasyTeamName,
      maxBidFantasyTeamLogoUrl,
      maxBidFantasyLeagueId,
      maxBidFantasyLeagueName,
      maxBidAuctionId,
      maxBidStage,
      maxBidId,
      maxBidStatus,
      maxBidSourceUrl,
      ...row
    }) => {
      const profilePlayerId =
        tmUrl?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
      return {
        ...row,
        bidAmountSum: row.totalBidAmount,
        avatarUrl:
          normalizeMantraImageUrl(canonicalAvatarUrl) ??
          normalizeMantraImageUrl(auctionAvatarUrl),
        positions: jsonArray(positionsJson),
        positionsItalian: jsonArray(positionsItalianJson),
        profilePlayerId,
        profileUrl: profilePlayerId ? `/player.html?id=${profilePlayerId}` : null,
        maxBid: row.maxBidAmount == null
          ? null
          : {
              amount: row.maxBidAmount,
              fantasyTeamId: maxBidFantasyTeamId,
              fantasyTeamName: maxBidFantasyTeamName,
              fantasyTeamLogoUrl: maxBidFantasyTeamLogoUrl,
              fantasyLeagueId: maxBidFantasyLeagueId,
              fantasyLeagueName: maxBidFantasyLeagueName,
              auctionId: maxBidAuctionId,
              stage: maxBidStage,
              bidId: maxBidId,
              sourceUrl: maxBidSourceUrl,
              winner: maxBidStatus === "success",
            },
        stages: [],
      };
    }),
  };
}

export function getMantraAuctionPlayerHistory(
  database: Database.Database,
  options: {
    scopeKey: MantraAuctionScopeKey;
    mantraPlayerId: number;
    offset?: number;
    limit?: number;
  },
) {
  type HistoryRow = {
    fantasyLeagueId: number;
    fantasyLeagueName: string | null;
    fantasyLeagueSourceUrl: string | null;
    auctionId: number;
    auctionLabel: string | null;
    auctionStatus: string | null;
    auctionSourceUrl: string;
    auctionFetchedAt: string;
    auctionCompletedAt: string | null;
    detailsProcessed: number;
    detailsTotal: number;
    stage: number | null;
    outcome: string | null;
    stageSourceUrl: string | null;
    bidId: number | null;
    bidOrder: number | null;
    bidStatus: string | null;
    price: number | null;
    fantasyTeamId: number | null;
    fantasyTeamName: string | null;
    fantasyTeamLogoUrl: string | null;
  };
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(
    MAX_MANTRA_AUCTION_HISTORY_ROWS,
    Math.max(1, Math.floor(options.limit ?? 100)),
  );
  const scope = database
    .prepare(
      `SELECT j.updated_at AS dataVersion,
              EXISTS (
                SELECT 1
                FROM mantra_auction_players p
                JOIN mantra_auctions a
                  ON a.mantra_league_id = p.mantra_league_id
                 AND a.auction_id = p.auction_id
                WHERE a.scope_key = j.scope_key AND p.mantra_player_id = ?
              ) AS playerExists
       FROM mantra_auction_jobs j
       WHERE j.scope_key = ?`,
    )
    .get(options.mantraPlayerId, options.scopeKey) as
    | { dataVersion: string; playerExists: number }
    | undefined;
  if (!scope?.playerExists) return null;

  const rows = database
    .prepare(
      `WITH player_rows AS (
         SELECT p.*
         FROM mantra_auction_players p
         JOIN mantra_auctions a
           ON a.mantra_league_id = p.mantra_league_id
          AND a.auction_id = p.auction_id
         WHERE a.scope_key = ? AND p.mantra_player_id = ?
       ),
       player_auctions AS (
         SELECT DISTINCT mantra_league_id, auction_id FROM player_rows
       ),
       auction_meta AS (
         SELECT a.mantra_league_id, a.auction_id, a.label, a.status,
                a.source_url, a.fetched_at, a.completed_at,
                (SELECT COUNT(*) FROM mantra_auction_players ap
                 WHERE ap.mantra_league_id = a.mantra_league_id
                   AND ap.auction_id = a.auction_id) AS detailsProcessed,
                (SELECT COUNT(DISTINCT CAST(je.value AS INTEGER))
                 FROM mantra_auction_stages ast, json_each(ast.player_bid_ids_json) je
                 WHERE ast.mantra_league_id = a.mantra_league_id
                   AND ast.auction_id = a.auction_id) AS detailsTotal
         FROM mantra_auctions a
         JOIN player_auctions pa
           ON pa.mantra_league_id = a.mantra_league_id
          AND pa.auction_id = a.auction_id
       )
       SELECT p.mantra_league_id AS fantasyLeagueId,
              COALESCE(l.name, a.league_label) AS fantasyLeagueName,
              l.source_url AS fantasyLeagueSourceUrl,
              p.auction_id AS auctionId, am.label AS auctionLabel,
              am.status AS auctionStatus, am.source_url AS auctionSourceUrl,
              am.fetched_at AS auctionFetchedAt,
              am.completed_at AS auctionCompletedAt,
              am.detailsProcessed, am.detailsTotal,
              ps.stage, ps.outcome, s.source_url AS stageSourceUrl,
              b.bid_id AS bidId, b.bid_order AS bidOrder,
              b.status AS bidStatus, b.price,
              b.fantasy_team_id AS fantasyTeamId,
              b.fantasy_team_name AS fantasyTeamName,
              b.fantasy_team_logo_url AS fantasyTeamLogoUrl
       FROM player_rows p
       JOIN auction_meta am
         ON am.mantra_league_id = p.mantra_league_id
        AND am.auction_id = p.auction_id
       JOIN mantra_auctions a
         ON a.mantra_league_id = p.mantra_league_id
        AND a.auction_id = p.auction_id
       LEFT JOIN mantra_auction_leagues l
         ON l.mantra_league_id = p.mantra_league_id
       LEFT JOIN mantra_auction_player_stages ps
         ON ps.mantra_league_id = p.mantra_league_id
        AND ps.auction_id = p.auction_id
        AND ps.player_bid_id = p.player_bid_id
       LEFT JOIN mantra_auction_stages s
         ON s.mantra_league_id = ps.mantra_league_id
        AND s.auction_id = ps.auction_id AND s.stage = ps.stage
       LEFT JOIN mantra_auction_bids b
         ON b.mantra_league_id = ps.mantra_league_id
        AND b.auction_id = ps.auction_id
        AND b.player_bid_id = ps.player_bid_id AND b.stage = ps.stage
       ORDER BY LOWER(COALESCE(l.name, a.league_label, '')) ASC,
                p.mantra_league_id ASC, p.auction_id DESC, ps.stage ASC,
                b.price IS NULL ASC, b.price DESC, b.bid_id DESC`,
    )
    .all(options.scopeKey, options.mantraPlayerId) as HistoryRow[];

  const fantasyLeagueKeys = new Set<string>();
  const auctionKeys = new Set<string>();
  const stageKeys = new Set<string>();
  const bidKeys = new Set<string>();
  const stageBidCounts = new Map<string, number>();
  const uniqueRows: HistoryRow[] = [];
  const historyRowKeys = new Set<string>();
  let partial = false;
  for (const row of rows) {
    const leagueKey = String(row.fantasyLeagueId);
    const auctionKey = `${leagueKey}:${row.auctionId}`;
    fantasyLeagueKeys.add(leagueKey);
    auctionKeys.add(auctionKey);
    const auctionComplete =
      row.auctionCompletedAt != null && row.detailsProcessed === row.detailsTotal;
    if (!auctionComplete) partial = true;
    const stageKey =
      row.stage == null ? null : `${auctionKey}:${row.stage}`;
    if (stageKey) stageKeys.add(stageKey);
    const bidKey =
      row.bidId == null ? null : `${auctionKey}:${row.bidId}`;
    if (bidKey && !bidKeys.has(bidKey)) {
      bidKeys.add(bidKey);
      if (stageKey) {
        stageBidCounts.set(stageKey, (stageBidCounts.get(stageKey) ?? 0) + 1);
      }
    }
    const historyRowKey = bidKey ?? stageKey ?? auctionKey;
    if (!historyRowKeys.has(historyRowKey)) {
      historyRowKeys.add(historyRowKey);
      uniqueRows.push(row);
    }
  }

  type StageGroup = {
    stage: number;
    outcome: string | null;
    sourceUrl: string | null;
    bidCount: number;
    bids: Array<{
      id: number;
      order: number | null;
      status: string | null;
      price: number | null;
      teamId: number | null;
      teamName: string | null;
      teamLogoUrl: string | null;
      winner: boolean;
    }>;
  };
  type AuctionGroup = {
    auctionId: number;
    label: string | null;
    status: string | null;
    collectionStatus: "complete" | "partial" | "pending";
    sourceUrl: string;
    fetchedAt: string;
    completedAt: string | null;
    stages: StageGroup[];
    stageMap: Map<number, StageGroup>;
  };
  type LeagueGroup = {
    fantasyLeagueId: number;
    fantasyLeagueName: string | null;
    sourceUrl: string | null;
    auctions: AuctionGroup[];
    auctionMap: Map<number, AuctionGroup>;
  };
  const leagueMap = new Map<number, LeagueGroup>();
  const pageRows = uniqueRows.slice(offset, offset + limit);
  for (const row of pageRows) {
    let league = leagueMap.get(row.fantasyLeagueId);
    if (!league) {
      league = {
        fantasyLeagueId: row.fantasyLeagueId,
        fantasyLeagueName: row.fantasyLeagueName,
        sourceUrl: row.fantasyLeagueSourceUrl,
        auctions: [],
        auctionMap: new Map(),
      };
      leagueMap.set(row.fantasyLeagueId, league);
    }
    let auction = league.auctionMap.get(row.auctionId);
    if (!auction) {
      const complete =
        row.auctionCompletedAt != null && row.detailsProcessed === row.detailsTotal;
      auction = {
        auctionId: row.auctionId,
        label: row.auctionLabel,
        status: row.auctionStatus,
        collectionStatus: complete
          ? "complete"
          : row.detailsProcessed > 0
            ? "partial"
            : "pending",
        sourceUrl: row.auctionSourceUrl,
        fetchedAt: row.auctionFetchedAt,
        completedAt: row.auctionCompletedAt,
        stages: [],
        stageMap: new Map(),
      };
      league.auctionMap.set(row.auctionId, auction);
      league.auctions.push(auction);
    }
    if (row.stage == null) continue;
    let stage = auction.stageMap.get(row.stage);
    if (!stage) {
      stage = {
        stage: row.stage,
        outcome: row.outcome,
        sourceUrl: row.stageSourceUrl,
        bidCount:
          stageBidCounts.get(
            `${row.fantasyLeagueId}:${row.auctionId}:${row.stage}`,
          ) ?? 0,
        bids: [],
      };
      auction.stageMap.set(row.stage, stage);
      auction.stages.push(stage);
    }
    if (row.bidId != null) {
      stage.bids.push({
        id: row.bidId,
        order: row.bidOrder,
        status: row.bidStatus,
        price: row.price,
        teamId: row.fantasyTeamId,
        teamName: row.fantasyTeamName,
        teamLogoUrl: row.fantasyTeamLogoUrl,
        winner: row.bidStatus === "success",
      });
    }
  }

  const leagues = [...leagueMap.values()].map(({ auctionMap: _auctionMap, ...league }) => ({
    ...league,
    auctions: league.auctions.map(({ stageMap: _stageMap, ...auction }) => auction),
  }));
  const nextOffset =
    offset + pageRows.length < uniqueRows.length ? offset + pageRows.length : null;
  return {
    mode: "all-history" as const,
    scopeKey: options.scopeKey,
    mantraPlayerId: options.mantraPlayerId,
    dataVersion: scope.dataVersion,
    partial,
    truncated: nextOffset != null,
    offset,
    limit,
    nextOffset,
    returnedRows: pageRows.length,
    totalRows: uniqueRows.length,
    counts: {
      fantasyLeagues: fantasyLeagueKeys.size,
      auctions: auctionKeys.size,
      stages: stageKeys.size,
      bids: bidKeys.size,
    },
    leagues,
  };
}
