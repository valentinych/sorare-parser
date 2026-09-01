import "dotenv/config";
import { open, readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import {
  normalizePlayerBid,
  parseAuctionPage,
  parseLeagueAuctionIds,
  parseLeagueAuctionNavigationPaths,
  type NormalizedPlayerBid,
} from "../clients/mantraAuction.js";
import { mantraAuthedGet, mantraAuthedJson } from "../clients/mantraAuth.js";
import { getMantraRequestStats } from "../clients/mantraRequest.js";
import { fetchMantraLeagues, type MantraLeague } from "../clients/mantra.js";
import {
  MAX_MANTRA_AUCTION_IMPORT_BYTES,
  type MantraAuctionImportPayload,
  type MantraAuctionLeagueCoverage,
  type MantraAuctionScopeKey,
  type NormalizedAuctionPlayer,
} from "../domain/mantraAuctions.js";
import { LIVE_LEAGUES } from "../lib/liveLeagues.js";

const ORIGIN = "https://mantrafootball.org";
const IMPORT_URL = "https://mantra.panenka.games/api/auctions/import";
const DATA_DIR = resolve("data/mantra/auctions");
const CHECKPOINT_PATH = resolve(DATA_DIR, "collection-progress.json");
const DISCOVERY_MANIFEST_PATH = resolve(DATA_DIR, "discovery-manifest.json");
const LOCK_PATH = resolve(DATA_DIR, "collection.lock");
const MAX_BATCH_PLAYERS = 50;
const TARGET_BATCH_BYTES = 220 * 1024;
export const VERIFIED_MANTRA_AUCTION_IDS: Readonly<Record<number, readonly number[]>> = {
  583: [2364],
};

type Scope = {
  key: MantraAuctionScopeKey;
  name: string;
  tournamentId: number;
  leagueIds: number[];
};

const SCOPES: Scope[] = [
  {
    key: "super-lig",
    name: "Süper Lig",
    tournamentId: LIVE_LEAGUES["super-lig"]!.mantraTournamentId!,
    leagueIds: LIVE_LEAGUES["super-lig"]!.mantraDivisions.map((item) => item.leagueId),
  },
  {
    key: "championship",
    name: "Championship",
    tournamentId: LIVE_LEAGUES.championship!.mantraTournamentId!,
    leagueIds: LIVE_LEAGUES.championship!.mantraDivisions.map((item) => item.leagueId),
  },
  {
    key: "ekstraklasa",
    name: "Ekstraklasa",
    tournamentId: LIVE_LEAGUES.ekstraklasa!.mantraTournamentId!,
    leagueIds: LIVE_LEAGUES.ekstraklasa!.mantraDivisions.map((item) => item.leagueId),
  },
  {
    key: "bundesliga",
    name: "Bundesliga",
    tournamentId: LIVE_LEAGUES.bundesliga!.mantraTournamentId!,
    leagueIds: LIVE_LEAGUES.bundesliga!.mantraDivisions.map((item) => item.leagueId),
  },
];

type CatalogAuction = {
  scopeKey: MantraAuctionScopeKey;
  mantraLeagueId: number;
  auctionId: number;
  status: string | null;
  label: string | null;
  leagueLabel: string | null;
  sourceUrl: string;
  fetchedAt: string;
  stages: Array<{ stage: number; sourceUrl: string; playerBidIds: number[] }>;
};

type Checkpoint = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  updatedAt: string;
  discoveredLeagueIds: number[];
  leagueCoverage: MantraAuctionLeagueCoverage[];
  catalog: CatalogAuction[];
  importedPlayerKeys: string[];
  failedPlayerDetails: Array<{
    key: string;
    error: string;
    attempts: number;
    status?: number | "network";
    lastAttemptAt?: string;
  }>;
  lastRetryAtByScope?: Partial<Record<MantraAuctionScopeKey, string>>;
  previousRequestStats: {
    requestStarts: number;
    retries: number;
    responses429: number;
  };
  batchUploads: number;
  importedPlayers: number;
};

function newCheckpoint(): Checkpoint {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: `auctions-${startedAt.replace(/[^0-9]/g, "")}-${process.pid}`,
    startedAt,
    updatedAt: startedAt,
    discoveredLeagueIds: [],
    leagueCoverage: [],
    catalog: [],
    importedPlayerKeys: [],
    failedPlayerDetails: [],
    previousRequestStats: { requestStarts: 0, retries: 0, responses429: 0 },
    batchUploads: 0,
    importedPlayers: 0,
  };
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const parsed = JSON.parse(await readFile(CHECKPOINT_PATH, "utf8")) as Checkpoint;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.runId === "string" &&
      Array.isArray(parsed.catalog) &&
      Array.isArray(parsed.discoveredLeagueIds) &&
      Array.isArray(parsed.importedPlayerKeys)
    ) {
      parsed.previousRequestStats ??= {
        requestStarts: 0,
        retries: 0,
        responses429: 0,
      };
      parsed.batchUploads ??= 0;
      parsed.importedPlayers ??= parsed.importedPlayerKeys.length;
      parsed.failedPlayerDetails ??= [];
      parsed.leagueCoverage ??= [];
      parsed.lastRetryAtByScope ??= {};
      return parsed;
    }
  } catch {
    // A missing checkpoint starts a new run.
  }
  return newCheckpoint();
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString();
  await writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function saveDiscoveryManifest(checkpoint: Checkpoint): Promise<void> {
  await writeFile(
    DISCOVERY_MANIFEST_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        method:
          "Official /api/leagues tournament registry plus authenticated links and page payloads; verified direct fallbacks only.",
        requestStats: requestStats(checkpoint),
        scopes: SCOPES.map((scope) => ({
          key: scope.key,
          tournamentId: scope.tournamentId,
          leagues: checkpoint.leagueCoverage
            .filter((league) => scope.leagueIds.includes(league.mantraLeagueId))
            .sort((a, b) => a.mantraLeagueId - b.mantraLeagueId),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const handle = await open(LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raw = await readFile(LOCK_PATH, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new Error(`Auction collector is already running (PID ${pid})`);
    await unlink(LOCK_PATH).catch(() => undefined);
    return acquireLock();
  }
  return async () => {
    await unlink(LOCK_PATH).catch(() => undefined);
  };
}

function requestStats(checkpoint: Checkpoint) {
  const current = getMantraRequestStats();
  return {
    requestStarts:
      checkpoint.previousRequestStats.requestStarts + current.requestStarts,
    retries: checkpoint.previousRequestStats.retries + current.retries,
    responses429:
      checkpoint.previousRequestStats.responses429 + current.responses429,
  };
}

async function upload(payload: MantraAuctionImportPayload): Promise<Record<string, unknown>> {
  if (!config.mantraAuctionImportToken) {
    throw new Error("Set MANTRA_AUCTION_IMPORT_TOKEN before collecting auctions");
  }
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_MANTRA_AUCTION_IMPORT_BYTES) {
    throw new Error(`Auction import batch is too large (${bytes} bytes)`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(IMPORT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.mantraAuctionImportToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return result;
      lastError = new Error(
        `Production auction import failed (${response.status}): ${String(result.error ?? "unknown")}`,
      );
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function publishProgress(
  checkpoint: Checkpoint,
  scope: Scope,
  status: "pending" | "discovering" | "running" | "partial" | "complete" | "error",
  phase: string,
  completed: number,
  total: number | null,
  error: string | null = null,
): Promise<void> {
  const failedCount = checkpoint.failedPlayerDetails.filter((failure) =>
    scope.leagueIds.includes(Number(failure.key.split(":")[0])),
  ).length;
  await upload({
    schemaVersion: 1,
    operation: "progress",
    runId: checkpoint.runId,
    scopeKey: scope.key,
    status,
    phase,
    completed,
    total,
    error: error ? error.replace(/\s+/g, " ").slice(0, 300) : null,
    requestStats: requestStats(checkpoint),
    failedCount,
    lastRetryAt: checkpoint.lastRetryAtByScope?.[scope.key] ?? null,
    updatedAt: new Date().toISOString(),
  });
}

async function discoverLeague(
  scope: Scope,
  league: MantraLeague,
): Promise<{
  coverage: MantraAuctionLeagueCoverage;
  auctions: CatalogAuction[];
}> {
  const leagueId = league.id;
  const leaguePath = `/leagues/${leagueId}`;
  const leagueHtml = await mantraAuthedGet(leaguePath);
  const evidence = [
    `official tournament registry ${scope.tournamentId}`,
    `authenticated ${leaguePath}`,
  ];
  const auctionIds = new Set(
    configuredMantraAuctionIds(
      leagueId,
      parseLeagueAuctionIds(leagueHtml, leagueId),
    ),
  );
  if ((VERIFIED_MANTRA_AUCTION_IDS[leagueId] ?? []).length > 0) {
    evidence.push("verified direct auction URL fallback");
  }
  for (const navigationPath of parseLeagueAuctionNavigationPaths(
    leagueHtml,
    leagueId,
  )) {
    try {
      const navigationHtml = await mantraAuthedGet(navigationPath);
      for (const auctionId of parseLeagueAuctionIds(navigationHtml, leagueId)) {
        auctionIds.add(auctionId);
      }
      evidence.push(`linked navigation ${navigationPath}`);
    } catch (error) {
      evidence.push(
        `linked navigation unavailable: ${String(
          error instanceof Error ? error.message : error,
        )
          .replace(/\s+/g, " ")
          .slice(0, 80)}`,
      );
    }
  }

  const auctions: CatalogAuction[] = [];
  const queue = [...auctionIds].sort((a, b) => a - b);
  const attempted = new Set<number>();
  while (queue.length > 0) {
    const auctionId = queue.shift()!;
    if (attempted.has(auctionId)) continue;
    attempted.add(auctionId);
    const auctionPath = `/leagues/${leagueId}/auctions/${auctionId}`;
    let initialHtml: string;
    try {
      initialHtml = await mantraAuthedGet(auctionPath);
    } catch (error) {
      evidence.push(
        `auction ${auctionId} unavailable: ${String(
          error instanceof Error ? error.message : error,
        )
          .replace(/\s+/g, " ")
          .slice(0, 80)}`,
      );
      continue;
    }
    for (const linkedAuctionId of parseLeagueAuctionIds(initialHtml, leagueId)) {
      if (!auctionIds.has(linkedAuctionId)) {
        auctionIds.add(linkedAuctionId);
        queue.push(linkedAuctionId);
        queue.sort((a, b) => a - b);
      }
    }
    const initial = parseAuctionPage(
      initialHtml,
      leagueId,
      auctionId,
    );
    const stageNumbers =
      initial.roundNumbers.length > 0
        ? initial.roundNumbers
        : initial.currentStage != null
          ? [initial.currentStage]
          : [];
    const stages: CatalogAuction["stages"] = [];
    if (stageNumbers.length === 0) {
      evidence.push(`auction ${auctionId} exposed with no stages yet`);
    }
    for (const stage of stageNumbers) {
      const stagePath = `${auctionPath}?round=${stage}`;
      const page = parseAuctionPage(
        await mantraAuthedGet(stagePath),
        leagueId,
        auctionId,
      );
      stages.push({
        stage,
        sourceUrl: `${ORIGIN}${stagePath}`,
        playerBidIds: [...new Set(page.playerBids.map((item) => item.playerBidId))],
      });
    }
    auctions.push({
      scopeKey: scope.key,
      mantraLeagueId: leagueId,
      auctionId,
      status: initial.status,
      label: initial.label,
      leagueLabel: initial.leagueLabel,
      sourceUrl: `${ORIGIN}${auctionPath}`,
      fetchedAt: new Date().toISOString(),
      stages,
    });
  }
  const discoveredAt = new Date().toISOString();
  const exposedAuctionIds = [...auctionIds].sort((a, b) => a - b);
  return {
    coverage: {
      mantraLeagueId: leagueId,
      name: league.name,
      division: league.division || null,
      seasonId: league.seasonId,
      tournamentId: league.tournamentId,
      registryStatus: league.status,
      accessState: "accessible",
      auctionState: exposedAuctionIds.length > 0 ? "available" : "no-auction",
      auctionIds: exposedAuctionIds,
      sourceUrl: `${ORIGIN}${leaguePath}`,
      evidence: evidence.join("; ").slice(0, 300),
      discoveredAt,
    },
    auctions,
  };
}

export function configuredMantraAuctionIds(
  leagueId: number,
  discoveredIds: number[],
): number[] {
  return [
    ...new Set([
      ...discoveredIds,
      ...(VERIFIED_MANTRA_AUCTION_IDS[leagueId] ?? []),
    ]),
  ].sort((a, b) => a - b);
}

function catalogPayload(
  checkpoint: Checkpoint,
  scope: Scope,
): MantraAuctionImportPayload {
  return {
    schemaVersion: 1,
    operation: "catalog",
    runId: checkpoint.runId,
    scopeKey: scope.key,
    auctions: checkpoint.catalog
      .filter((auction) => auction.scopeKey === scope.key)
      .map(({ scopeKey: _scopeKey, ...auction }) => auction),
  };
}

function coveragePayload(
  checkpoint: Checkpoint,
  scope: Scope,
): MantraAuctionImportPayload {
  return {
    schemaVersion: 1,
    operation: "coverage",
    runId: checkpoint.runId,
    scopeKey: scope.key,
    leagues: checkpoint.leagueCoverage.filter((league) =>
      scope.leagueIds.includes(league.mantraLeagueId),
    ),
  };
}

function unavailableLeagueCoverage(
  scope: Scope,
  league: MantraLeague,
  error: unknown,
): MantraAuctionLeagueCoverage {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const restricted = /\b(401|403)\b/.test(message);
  return {
    mantraLeagueId: league.id,
    name: league.name,
    division: league.division || null,
    seasonId: league.seasonId,
    tournamentId: scope.tournamentId,
    registryStatus: league.status,
    accessState: restricted ? "restricted" : "unavailable",
    auctionState: restricted ? "restricted" : "unavailable",
    auctionIds: [],
    sourceUrl: `${ORIGIN}/leagues/${league.id}`,
    evidence: `official tournament registry ${scope.tournamentId}; ${message}`.slice(
      0,
      300,
    ),
    discoveredAt: new Date().toISOString(),
  };
}

export function mantraAuctionDetailKey(
  leagueId: number,
  auctionId: number,
  playerBidId: number,
): string {
  return `${leagueId}:${auctionId}:${playerBidId}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableId(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nullableText(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function normalizedImportPlayer(
  auction: CatalogAuction,
  detail: NormalizedPlayerBid,
  fetchedAt: string,
): NormalizedAuctionPlayer {
  const club = object(detail.player.club);
  return {
    mantraLeagueId: auction.mantraLeagueId,
    auctionId: auction.auctionId,
    playerBidId: detail.playerBidId,
    status: detail.status,
    price: detail.price,
    sourceUrl: detail.sourceUrl,
    fetchedAt,
    player: {
      id: detail.player.id,
      firstName: detail.player.firstName,
      name: detail.player.name,
      avatarUrl: detail.player.avatarUrl,
      positions: detail.player.positions,
      positionsItalian: detail.player.positionsItalian,
      club: club
        ? {
            id: nullableId(club.id),
            name: nullableText(club.name),
            logoUrl: nullableText(club.logo_path),
          }
        : null,
    },
    stages: detail.stages.map((stage) => ({
      stage: stage.stage,
      bids: stage.bids.map((bid) => {
        const team = object(bid.team);
        return {
          id: bid.id,
          order: bid.order,
          status: bid.status,
          price: bid.price,
          team: team
            ? {
                id: nullableId(team.id),
                name: nullableText(team.human_name ?? team.name),
                logoUrl: nullableText(team.logo_path),
              }
            : null,
        };
      }),
    })),
  };
}

function scopeWork(checkpoint: Checkpoint, scope: Scope) {
  const items = checkpoint.catalog
    .filter((auction) => auction.scopeKey === scope.key)
    .flatMap((auction) =>
      [...new Set(auction.stages.flatMap((stage) => stage.playerBidIds))].map(
        (playerBidId) => ({ auction, playerBidId }),
      ),
    );
  return items;
}

function recordPlayerFailure(
  checkpoint: Checkpoint,
  key: string,
  error: unknown,
  attemptedAt: string,
): void {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  const statusMatch = message.match(/(?:→|HTTP)\s*(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : "network";
  const previous = checkpoint.failedPlayerDetails.find((failure) => failure.key === key);
  if (previous) {
    previous.error = message;
    previous.attempts += 1;
    previous.status = status;
    previous.lastAttemptAt = attemptedAt;
  } else {
    checkpoint.failedPlayerDetails.push({
      key,
      error: message,
      attempts: 1,
      status,
      lastAttemptAt: attemptedAt,
    });
  }
}

export function makeMantraAuctionBatches(
  checkpoint: Checkpoint,
  scope: Scope,
  players: NormalizedAuctionPlayer[],
): NormalizedAuctionPlayer[][] {
  const batches: NormalizedAuctionPlayer[][] = [];
  let current: NormalizedAuctionPlayer[] = [];
  for (const player of players) {
    const candidate = [...current, player];
    const payload: MantraAuctionImportPayload = {
      schemaVersion: 1,
      operation: "batch",
      runId: checkpoint.runId,
      scopeKey: scope.key,
      players: candidate,
    };
    if (
      current.length > 0 &&
      (candidate.length > MAX_BATCH_PLAYERS ||
        Buffer.byteLength(JSON.stringify(payload)) > TARGET_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [player];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

type RetryFailedDeps = {
  getJson?: (path: string) => Promise<unknown>;
  uploadPlayers?: (players: NormalizedAuctionPlayer[]) => Promise<void>;
  save?: (checkpoint: Checkpoint) => Promise<void>;
  now?: () => Date;
};

export async function retryCheckpointFailures(
  checkpoint: Checkpoint,
  scope: Scope,
  deps: RetryFailedDeps = {},
): Promise<{ requested: number; recovered: number; remaining: number }> {
  const getJson = deps.getJson ?? mantraAuthedJson;
  const uploadPlayers =
    deps.uploadPlayers ??
    (async (players) => {
      await upload({
        schemaVersion: 1,
        operation: "batch",
        runId: checkpoint.runId,
        scopeKey: scope.key,
        players,
      });
    });
  const save = deps.save ?? saveCheckpoint;
  const now = deps.now ?? (() => new Date());
  const imported = new Set(checkpoint.importedPlayerKeys);
  const workByKey = new Map(
    scopeWork(checkpoint, scope).map((item) => [
      mantraAuctionDetailKey(
        item.auction.mantraLeagueId,
        item.auction.auctionId,
        item.playerBidId,
      ),
      item,
    ]),
  );

  const beforeCleanup = checkpoint.failedPlayerDetails.length;
  checkpoint.failedPlayerDetails = checkpoint.failedPlayerDetails.filter(
    (failure) => !workByKey.has(failure.key) || !imported.has(failure.key),
  );
  if (checkpoint.failedPlayerDetails.length !== beforeCleanup) await save(checkpoint);

  const targets = checkpoint.failedPlayerDetails
    .filter((failure) => workByKey.has(failure.key))
    .map((failure) => ({ failure, work: workByKey.get(failure.key)! }));
  const recovered: Array<{ key: string; player: NormalizedAuctionPlayer }> = [];

  for (const { failure, work } of targets) {
    const attemptedAt = now().toISOString();
    const path = `/api/player_bids/${work.playerBidId}`;
    let payload: unknown;
    try {
      payload = await getJson(path);
    } catch (error) {
      recordPlayerFailure(checkpoint, failure.key, error, attemptedAt);
      await save(checkpoint);
      continue;
    }
    const detail = normalizePlayerBid(payload, `${ORIGIN}${path}`);
    if (detail.playerBidId !== work.playerBidId) {
      throw new Error(
        `Player-bid mismatch: requested ${work.playerBidId}, received ${detail.playerBidId}`,
      );
    }
    recovered.push({
      key: failure.key,
      player: normalizedImportPlayer(work.auction, detail, attemptedAt),
    });
  }

  for (const batch of makeMantraAuctionBatches(
    checkpoint,
    scope,
    recovered.map((item) => item.player),
  )) {
    await uploadPlayers(batch);
    const batchKeys = new Set(
      batch.map((player) =>
        mantraAuctionDetailKey(player.mantraLeagueId, player.auctionId, player.playerBidId),
      ),
    );
    for (const key of batchKeys) {
      if (!imported.has(key)) {
        imported.add(key);
        checkpoint.importedPlayerKeys.push(key);
        checkpoint.importedPlayers++;
      }
    }
    checkpoint.failedPlayerDetails = checkpoint.failedPlayerDetails.filter(
      (failure) => !batchKeys.has(failure.key),
    );
    checkpoint.batchUploads++;
    await save(checkpoint);
  }

  const remaining = checkpoint.failedPlayerDetails.filter((failure) =>
    workByKey.has(failure.key),
  ).length;
  return { requested: targets.length, recovered: recovered.length, remaining };
}

function auctionArtifact(
  checkpoint: Checkpoint,
  auction: CatalogAuction,
  players: NormalizedAuctionPlayer[],
) {
  const bids = players.flatMap((player) => player.stages.flatMap((stage) => stage.bids));
  return {
    schemaVersion: 2,
    provenance: {
      fetchedAt: new Date().toISOString(),
      sourcePage: auction.sourceUrl,
      requestStats: requestStats(checkpoint),
      rateLimit: {
        maximumRequestStartsPerRollingSecond: 4,
        minimumStartGapMs: 260,
      },
    },
    auction: {
      leagueId: auction.mantraLeagueId,
      auctionId: auction.auctionId,
      status: auction.status,
      label: auction.label,
      leagueLabel: auction.leagueLabel,
      sourceUrl: auction.sourceUrl,
      availableStages: auction.stages.map((stage) => stage.stage),
    },
    rounds: auction.stages,
    playerBids: players,
    totals: {
      players: new Set(players.map((player) => player.player.id)).size,
      playerBidRecords: players.length,
      playerStages: players.reduce((sum, player) => sum + player.stages.length, 0),
      bids: bids.length,
      winners: bids.filter((bid) => bid.status === "success").length,
    },
  };
}

async function collectScope(checkpoint: Checkpoint, scope: Scope): Promise<void> {
  const work = scopeWork(checkpoint, scope);
  const imported = new Set(checkpoint.importedPlayerKeys);
  const completedWork = work.filter(({ auction, playerBidId }) =>
    imported.has(
      mantraAuctionDetailKey(
        auction.mantraLeagueId,
        auction.auctionId,
        playerBidId,
      ),
    ),
  ).length;
  const checkpointCompleted = checkpoint.importedPlayerKeys.filter((key) =>
    scope.leagueIds.includes(Number(key.split(":")[0])),
  ).length;
  const checkpointFailures = checkpoint.failedPlayerDetails.filter((failure) =>
    scope.leagueIds.includes(Number(failure.key.split(":")[0])),
  ).length;
  let completed = Math.max(completedWork, checkpointCompleted);
  const progressTotal = Math.max(
    work.length,
    checkpointCompleted + checkpointFailures,
  );
  await publishProgress(
    checkpoint,
    scope,
    "running",
    "collecting player histories",
    completed,
    progressTotal,
  );

  for (const auction of checkpoint.catalog.filter(
    (item) => item.scopeKey === scope.key,
  )) {
    const auctionIds = [
      ...new Set(auction.stages.flatMap((stage) => stage.playerBidIds)),
    ];
    const collected: NormalizedAuctionPlayer[] = [];
    let pending: Array<{ key: string; player: NormalizedAuctionPlayer }> = [];

    const flush = async () => {
      if (!pending.length) return;
      const batches = makeMantraAuctionBatches(
        checkpoint,
        scope,
        pending.map((item) => item.player),
      );
      let offset = 0;
      for (const batch of batches) {
        await upload({
          schemaVersion: 1,
          operation: "batch",
          runId: checkpoint.runId,
          scopeKey: scope.key,
          players: batch,
        });
        const keys = pending.slice(offset, offset + batch.length).map((item) => item.key);
        offset += batch.length;
        for (const key of keys) {
          if (!imported.has(key)) {
            imported.add(key);
            checkpoint.importedPlayerKeys.push(key);
            checkpoint.importedPlayers++;
            completed++;
          }
        }
        checkpoint.batchUploads++;
        await saveCheckpoint(checkpoint);
        await publishProgress(
          checkpoint,
          scope,
          "running",
          "importing normalized batches",
          completed,
          progressTotal,
        );
        console.log(
          `[${scope.key}] ${completed}/${progressTotal} · batch=${batch.length} · ` +
            `requests=${requestStats(checkpoint).requestStarts}`,
        );
      }
      pending = [];
    };

    for (const playerBidId of auctionIds) {
      const key = mantraAuctionDetailKey(
        auction.mantraLeagueId,
        auction.auctionId,
        playerBidId,
      );
      if (imported.has(key)) continue;
      const path = `/api/player_bids/${playerBidId}`;
      const fetchedAt = new Date().toISOString();
      let payload: unknown;
      try {
        payload = await mantraAuthedJson(path);
      } catch (error) {
        recordPlayerFailure(checkpoint, key, error, fetchedAt);
        await saveCheckpoint(checkpoint);
        const failure = checkpoint.failedPlayerDetails.find((item) => item.key === key);
        console.error(`[${scope.key}] ${key} · status=${failure?.status ?? "network"}`);
        continue;
      }
      const detail: NormalizedPlayerBid = normalizePlayerBid(payload, `${ORIGIN}${path}`);
      if (detail.playerBidId !== playerBidId) {
        throw new Error(
          `Player-bid mismatch: requested ${playerBidId}, received ${detail.playerBidId}`,
        );
      }
      checkpoint.failedPlayerDetails = checkpoint.failedPlayerDetails.filter(
        (failure) => failure.key !== key,
      );
      const player = normalizedImportPlayer(auction, detail, fetchedAt);
      collected.push(player);
      pending.push({ key, player });
      const preview = makeMantraAuctionBatches(
        checkpoint,
        scope,
        pending.map((item) => item.player),
      );
      if (preview.length > 1 || pending.length >= MAX_BATCH_PLAYERS) {
        const last = pending.pop()!;
        await flush();
        pending.push(last);
      }
    }
    await flush();

    const auctionComplete =
      auction.stages.length > 0 &&
      auctionIds.every((playerBidId) =>
        imported.has(
          mantraAuctionDetailKey(
            auction.mantraLeagueId,
            auction.auctionId,
            playerBidId,
          ),
        ),
      );
    if (auctionComplete) {
      await upload({
        schemaVersion: 1,
        operation: "complete",
        runId: checkpoint.runId,
        scopeKey: scope.key,
        completedAt: new Date().toISOString(),
        auctions: [
          {
            mantraLeagueId: auction.mantraLeagueId,
            auctionId: auction.auctionId,
          },
        ],
      });
    }

    if (collected.length === auctionIds.length) {
      await writeFile(
        resolve(
          DATA_DIR,
          `league-${auction.mantraLeagueId}-auction-${auction.auctionId}.json`,
        ),
        `${JSON.stringify(auctionArtifact(checkpoint, auction, collected), null, 2)}\n`,
        "utf8",
      );
    }
  }

  const unresolved = checkpoint.failedPlayerDetails.filter((failure) =>
    work.some(
      ({ auction, playerBidId }) =>
        mantraAuctionDetailKey(
          auction.mantraLeagueId,
          auction.auctionId,
          playerBidId,
        ) === failure.key,
    ),
  );
  const coverage = checkpoint.leagueCoverage.filter((league) =>
    scope.leagueIds.includes(league.mantraLeagueId),
  );
  const expectedAuctions = new Set(
    coverage.flatMap((league) =>
      league.auctionIds.map((auctionId) => `${league.mantraLeagueId}:${auctionId}`),
    ),
  );
  const catalogAuctions = new Set(
    checkpoint.catalog
      .filter((auction) => auction.scopeKey === scope.key)
      .map((auction) => `${auction.mantraLeagueId}:${auction.auctionId}`),
  );
  const missingAuctions = [...expectedAuctions].filter(
    (key) => !catalogAuctions.has(key),
  );
  const unreadyAuctions = checkpoint.catalog.filter(
    (auction) => auction.scopeKey === scope.key && auction.stages.length === 0,
  );
  const missingLeagues = Math.max(0, scope.leagueIds.length - coverage.length);
  if (
    unresolved.length > 0 ||
    missingAuctions.length > 0 ||
    unreadyAuctions.length > 0 ||
    missingLeagues > 0
  ) {
    const problems = [
      missingLeagues > 0 ? `${missingLeagues} league records missing` : "",
      missingAuctions.length > 0
        ? `${missingAuctions.length} exposed auctions unavailable`
        : "",
      unreadyAuctions.length > 0
        ? `${unreadyAuctions.length} exposed auctions have no stages yet`
        : "",
      unresolved.length > 0
        ? `${unresolved.length} player details unavailable`
        : "",
    ].filter(Boolean);
    await publishProgress(
      checkpoint,
      scope,
      "partial",
      "partial",
      completed,
      progressTotal,
      problems.join("; "),
    );
    return;
  }

  await upload({
    schemaVersion: 1,
    operation: "complete",
    runId: checkpoint.runId,
    scopeKey: scope.key,
    completedAt: new Date().toISOString(),
    auctions: checkpoint.catalog
      .filter((auction) => auction.scopeKey === scope.key)
      .map((auction) => ({
        mantraLeagueId: auction.mantraLeagueId,
        auctionId: auction.auctionId,
      })),
  });
  await publishProgress(
    checkpoint,
    scope,
    "complete",
    "complete",
    progressTotal,
    progressTotal,
  );
}

async function retryFailedScopes(checkpoint: Checkpoint): Promise<void> {
  for (const scope of SCOPES) {
    const work = scopeWork(checkpoint, scope);
    const workKeys = new Set(
      work.map(({ auction, playerBidId }) =>
        mantraAuctionDetailKey(auction.mantraLeagueId, auction.auctionId, playerBidId),
      ),
    );
    if (!checkpoint.failedPlayerDetails.some((failure) => workKeys.has(failure.key))) {
      continue;
    }

    checkpoint.lastRetryAtByScope ??= {};
    checkpoint.lastRetryAtByScope[scope.key] = new Date().toISOString();
    await saveCheckpoint(checkpoint);
    const completedBefore = work.filter(({ auction, playerBidId }) =>
      checkpoint.importedPlayerKeys.includes(
        mantraAuctionDetailKey(auction.mantraLeagueId, auction.auctionId, playerBidId),
      ),
    ).length;
    await publishProgress(
      checkpoint,
      scope,
      "running",
      "retrying unavailable records",
      completedBefore,
      work.length,
    );

    const result = await retryCheckpointFailures(checkpoint, scope);
    const completed = work.filter(({ auction, playerBidId }) =>
      checkpoint.importedPlayerKeys.includes(
        mantraAuctionDetailKey(auction.mantraLeagueId, auction.auctionId, playerBidId),
      ),
    ).length;
    if (result.remaining > 0) {
      await publishProgress(
        checkpoint,
        scope,
        "partial",
        "partial",
        completed,
        work.length,
        `${result.remaining} записей временно недоступны в API Mantra; доступные данные сохранены.`,
      );
    } else {
      await upload({
        schemaVersion: 1,
        operation: "complete",
        runId: checkpoint.runId,
        scopeKey: scope.key,
        completedAt: new Date().toISOString(),
        auctions: checkpoint.catalog
          .filter((auction) => auction.scopeKey === scope.key)
          .map((auction) => ({
            mantraLeagueId: auction.mantraLeagueId,
            auctionId: auction.auctionId,
          })),
      });
      await publishProgress(
        checkpoint,
        scope,
        "complete",
        "complete",
        work.length,
        work.length,
      );
    }
    console.log(
      `[${scope.key}] targeted=${result.requested} recovered=${result.recovered} ` +
        `remaining=${result.remaining}`,
    );
  }
}

function unsownScopes(checkpoint: Checkpoint, scopes: Scope[]): Scope[] {
  return scopes.filter((scope) => {
    const discovered = scope.leagueIds.some((leagueId) =>
      checkpoint.discoveredLeagueIds.includes(leagueId),
    );
    const cataloged = checkpoint.catalog.some(
      (auction) => auction.scopeKey === scope.key,
    );
    return !discovered && !cataloged;
  });
}

async function completeScopeAuctions(
  checkpoint: Checkpoint,
  scope: Scope,
): Promise<void> {
  const auctions = checkpoint.catalog
    .filter((auction) => auction.scopeKey === scope.key)
    .map((auction) => ({
      mantraLeagueId: auction.mantraLeagueId,
      auctionId: auction.auctionId,
    }));
  if (auctions.length === 0) return;
  await upload({
    schemaVersion: 1,
    operation: "complete",
    runId: checkpoint.runId,
    scopeKey: scope.key,
    completedAt: new Date().toISOString(),
    auctions,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const retryFailed = args.length === 1 && args[0] === "--retry-failed";
  const reconcile = args.length === 1 && args[0] === "--reconcile";
  if (args.length > 0 && !retryFailed && !reconcile) {
    throw new Error(
      "Usage: npm run collect:mantra-auctions [-- --retry-failed|--reconcile]",
    );
  }
  const requestedScopes = reconcile
    ? SCOPES.filter(
        (scope) =>
          scope.key === "championship" || scope.key === "ekstraklasa",
      )
    : SCOPES;
  const release = await acquireLock();
  let checkpoint = await loadCheckpoint();
  try {
    if (retryFailed) {
      const before = getMantraRequestStats();
      await retryFailedScopes(checkpoint);
      const after = getMantraRequestStats();
      checkpoint.previousRequestStats = requestStats(checkpoint);
      await saveCheckpoint(checkpoint);
      console.log(
        `Targeted retry finished · requests=${after.requestStarts - before.requestStarts} ` +
          `retries=${after.retries - before.retries} ` +
          `429=${after.responses429 - before.responses429}`,
      );
      return;
    }
    const toSeed = unsownScopes(checkpoint, requestedScopes);
    if (toSeed.length > 0) {
      await upload({
        schemaVersion: 1,
        operation: "seed",
        runId: checkpoint.runId,
        startedAt: checkpoint.startedAt,
        scopes: toSeed.map((scope) => ({
          key: scope.key,
          name: scope.name,
          mantraLeagueIds: scope.leagueIds,
        })),
      });
    }
    const discovered = new Set(checkpoint.discoveredLeagueIds);
    const alreadyComplete = new Set<MantraAuctionScopeKey>();
    for (const scope of requestedScopes) {
      const existingWork = scopeWork(checkpoint, scope);
      const imported = new Set(checkpoint.importedPlayerKeys);
      const unresolved = new Set(
        checkpoint.failedPlayerDetails.map((failure) => failure.key),
      );
      if (
        !reconcile &&
        existingWork.length > 0 &&
        existingWork.every(({ auction, playerBidId }) => {
          const key = mantraAuctionDetailKey(
            auction.mantraLeagueId,
            auction.auctionId,
            playerBidId,
          );
          return imported.has(key) && !unresolved.has(key);
        })
      ) {
        alreadyComplete.add(scope.key);
        try {
          await completeScopeAuctions(checkpoint, scope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[${scope.key}] could not mark complete: ${message}`);
        }
        continue;
      }
      const needsDiscovery = reconcile || scope.leagueIds.some((leagueId) => {
        const missingVerifiedAuction = (
          VERIFIED_MANTRA_AUCTION_IDS[leagueId] ?? []
        ).some(
          (auctionId) =>
            !checkpoint.catalog.some(
              (auction) =>
                auction.mantraLeagueId === leagueId &&
                auction.auctionId === auctionId,
            ),
        );
        return !discovered.has(leagueId) || missingVerifiedAuction;
      });
      if (!needsDiscovery) continue;
      const discoveryCompleted = Math.max(
        existingWork.filter(({ auction, playerBidId }) =>
          imported.has(
            mantraAuctionDetailKey(
              auction.mantraLeagueId,
              auction.auctionId,
              playerBidId,
            ),
          ),
        ).length,
        checkpoint.importedPlayerKeys.filter((key) =>
          scope.leagueIds.includes(Number(key.split(":")[0])),
        ).length,
      );
      const discoveryTotal = Math.max(
        existingWork.length,
        discoveryCompleted +
          checkpoint.failedPlayerDetails.filter((failure) =>
            scope.leagueIds.includes(Number(failure.key.split(":")[0])),
          ).length,
      );
      await publishProgress(
        checkpoint,
        scope,
        "discovering",
        "discovering league auctions",
        discoveryCompleted,
        discoveryTotal || null,
      );
      const officialLeagues = await fetchMantraLeagues(scope.tournamentId);
      const officialIds = officialLeagues.map((league) => league.id).sort((a, b) => a - b);
      const configuredIds = [...scope.leagueIds].sort((a, b) => a - b);
      if (
        officialIds.length === 0 ||
        officialIds.some((id, index) => id !== configuredIds[index]) ||
        officialIds.length !== configuredIds.length
      ) {
        const message =
          `${scope.name} official registry differs from configured scope: ` +
          `official=${officialIds.join(",")} configured=${configuredIds.join(",")}`;
        await publishProgress(
          checkpoint,
          scope,
          "error",
          "paused",
          discoveryCompleted,
          discoveryTotal || null,
          message,
        );
        console.error(`[${scope.key}] ${message}`);
        continue;
      }
      for (const leagueId of scope.leagueIds) {
        const missingVerifiedAuction = (
          VERIFIED_MANTRA_AUCTION_IDS[leagueId] ?? []
        ).some(
          (auctionId) =>
            !checkpoint.catalog.some(
              (auction) =>
                auction.mantraLeagueId === leagueId &&
                auction.auctionId === auctionId,
            ),
        );
        if (!reconcile && discovered.has(leagueId) && !missingVerifiedAuction) continue;
        console.log(`[${scope.key}] discovering Mantra league ${leagueId}`);
        const league = officialLeagues.find((item) => item.id === leagueId)!;
        let discovery: Awaited<ReturnType<typeof discoverLeague>>;
        try {
          discovery = await discoverLeague(scope, league);
        } catch (error) {
          discovery = {
            coverage: unavailableLeagueCoverage(scope, league, error),
            auctions: [],
          };
        }
        checkpoint.leagueCoverage = checkpoint.leagueCoverage.filter(
          (item) => item.mantraLeagueId !== leagueId,
        );
        checkpoint.leagueCoverage.push(discovery.coverage);
        const exposed = new Set(discovery.coverage.auctionIds);
        checkpoint.catalog = checkpoint.catalog.filter(
          (item) =>
            item.mantraLeagueId !== leagueId || exposed.has(item.auctionId),
        );
        const auctions = discovery.auctions;
        const refreshed = new Set(auctions.map((auction) => auction.auctionId));
        checkpoint.catalog = checkpoint.catalog.filter(
          (item) =>
            item.mantraLeagueId !== leagueId || !refreshed.has(item.auctionId),
        );
        checkpoint.catalog.push(
          ...auctions.filter(
            (auction) =>
              !checkpoint.catalog.some(
                (existing) =>
                  existing.mantraLeagueId === auction.mantraLeagueId &&
                  existing.auctionId === auction.auctionId,
              ),
          ),
        );
        if (!discovered.has(leagueId)) {
          checkpoint.discoveredLeagueIds.push(leagueId);
        }
        discovered.add(leagueId);
        await saveCheckpoint(checkpoint);
        await publishProgress(
          checkpoint,
          scope,
          "discovering",
          `discovered ${checkpoint.discoveredLeagueIds.filter((id) => scope.leagueIds.includes(id)).length}/${scope.leagueIds.length} divisions`,
          discoveryCompleted,
          discoveryTotal || null,
        );
      }
      const scopeAuctions = checkpoint.catalog.filter(
        (auction) => auction.scopeKey === scope.key,
      );
      await upload(coveragePayload(checkpoint, scope));
      await upload(catalogPayload(checkpoint, scope));
      await saveDiscoveryManifest(checkpoint);
      console.log(
        `[${scope.key}] official leagues=${officialLeagues.length} ` +
          `leaguesWithAuctions=${checkpoint.leagueCoverage.filter(
            (league) =>
              scope.leagueIds.includes(league.mantraLeagueId) &&
              league.auctionState === "available",
          ).length} auctions=${scopeAuctions.length}`,
      );
    }

    for (const scope of requestedScopes) {
      if (alreadyComplete.has(scope.key)) continue;
      try {
        await collectScope(checkpoint, scope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const work = scopeWork(checkpoint, scope);
        const completed = work.filter(({ auction, playerBidId }) =>
          checkpoint.importedPlayerKeys.includes(
            mantraAuctionDetailKey(
              auction.mantraLeagueId,
              auction.auctionId,
              playerBidId,
            ),
          ),
        ).length;
        await publishProgress(
          checkpoint,
          scope,
          "error",
          "paused",
          completed,
          work.length || null,
          message,
        ).catch(() => undefined);
        console.error(`[${scope.key}] ${message}`);
      }
    }

    checkpoint.previousRequestStats = requestStats(checkpoint);
    await saveCheckpoint(checkpoint);
    console.log(
      `Finished · requests=${checkpoint.previousRequestStats.requestStarts} ` +
        `retries=${checkpoint.previousRequestStats.retries} ` +
        `429=${checkpoint.previousRequestStats.responses429} ` +
        `batches=${checkpoint.batchUploads}`,
    );
  } catch (error) {
    checkpoint.previousRequestStats = requestStats(checkpoint);
    await saveCheckpoint(checkpoint).catch(() => undefined);
    throw error;
  } finally {
    await release();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
