import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import {
  defaultExpected11League,
  Expected11IngestError,
  listExpected11Leagues,
  listExpected11Tours,
  parseExpected11ImportScope,
  resolveExpected11League,
  type Expected11TourOption,
} from "./domain/expected11Ingest.js";
import {
  jsonSavedTourUrlsStore,
  type SavedTourUrlsStore,
} from "./domain/expected11SavedUrls.js";
import {
  listSorareCapturedClubs,
  parseSorareInsideCaptureRequest,
  parseSorareInsideDiscoverRequest,
  parseSorareInsideExpandRequest,
  parseSorareOutputDir,
} from "./domain/sorareInsideScreenshot.js";
import {
  buildFootmopsSnapshotFromSorareCaptures,
  parseSorareFootmopsPublishRequest,
  publishFootmopsSnapshot,
} from "./domain/sorareFootmopsPublish.js";
import { parseScreenshotTour } from "./domain/expected11Screenshot.js";
import { getSorareInsideSession } from "./sync/sorareInsideLineups.js";
import {
  parseExpected11MatchUrl,
  runExpected11,
  type Expected11Output,
  type Expected11RunOptions,
  type Expected11RunResult,
} from "./sync/runExpected11.js";

const host = "127.0.0.1";
const port = 3002;
const publicDir = fileURLToPath(new URL("../public-expected11", import.meta.url));
const defaultOutputDir = fileURLToPath(
  new URL("../data/expected11/output", import.meta.url),
);
const defaultSavedUrlsPath = fileURLToPath(
  new URL("../data/expected11/saved-tour-urls.json", import.meta.url),
);
const productionImportUrl =
  "https://mantra.panenka.games/api/expected11/import";
const execFileAsync = promisify(execFile);
const expected11ProjectRoot = fileURLToPath(new URL("..", import.meta.url));

type Expected11Runner = (
  options: Expected11RunOptions,
) => Promise<Expected11RunResult>;

type PublishScope = { league: string; tour: number };

type RunRequest = {
  urls: string[];
  diagnostic: boolean;
  screenshot: boolean;
  /** Selected tour — green screenshots saved as `{tour}/{club}.png`. */
  tour?: number;
  publishAfter?: PublishScope;
};

type RunStatus = {
  state: "idle" | "running" | "waiting-login" | "publishing" | "completed" | "failed";
  message: string;
  completed: number;
  total: number;
  currentUrl: string | null;
  diagnostic: boolean;
  downloadReady: boolean;
  publishReady: boolean;
  failedMatchCount: number;
  outputPath: string | null;
};

export type Expected11SnapshotFile = {
  output: Expected11Output;
  outputPath: string;
};

export function expected11FailedMatchCount(output: Expected11Output): number {
  return output.matches.filter((match) => match.status !== "ok").length;
}

export function expected11SnapshotPublishable(output: Expected11Output): boolean {
  return output.matches.some((match) => match.status === "ok");
}

export async function loadLatestExpected11Snapshot(
  dir = defaultOutputDir,
): Promise<Expected11SnapshotFile | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const latest = names
    .filter((name) => name.startsWith("expected11-") && name.endsWith(".json"))
    .sort()
    .at(-1);
  if (!latest) return null;
  const outputPath = path.join(dir, latest);
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as Expected11Output;
    if (!parsed || !Array.isArray(parsed.matches)) return null;
    return { output: parsed, outputPath };
  } catch {
    return null;
  }
}

export function parseExpected11MatchUrlList(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : null;
  if (!raw) {
    throw new Error("Provide Expected11 match URLs as an array or newline-separated text.");
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("Every URL must be a string.");
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    const url = parseExpected11MatchUrl(trimmed);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (!options.allowEmpty && urls.length === 0) {
    throw new Error("Provide at least one Expected11 match URL.");
  }
  return urls;
}

export function parseExpected11RunRequest(body: unknown): RunRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must contain a urls array.");
  }
  const candidate = body as {
    urls?: unknown;
    diagnostic?: unknown;
    screenshot?: unknown;
    tour?: unknown;
  };
  if (
    candidate.diagnostic !== undefined &&
    typeof candidate.diagnostic !== "boolean"
  ) {
    throw new Error("diagnostic must be a boolean.");
  }
  if (
    candidate.screenshot !== undefined &&
    typeof candidate.screenshot !== "boolean"
  ) {
    throw new Error("screenshot must be a boolean.");
  }

  let tour: number | undefined;
  if (candidate.tour !== undefined && candidate.tour !== null && candidate.tour !== "") {
    const n = typeof candidate.tour === "number" ? candidate.tour : Number(candidate.tour);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      throw new Error("tour must be an integer from 1 to 99.");
    }
    tour = n;
  }

  return {
    urls: parseExpected11MatchUrlList(candidate.urls),
    diagnostic: candidate.diagnostic ?? false,
    screenshot: candidate.screenshot ?? false,
    ...(tour != null ? { tour } : {}),
  };
}

function ingestReplyError(error: unknown): { status: number; error: string } {
  if (error instanceof Expected11IngestError) {
    return { status: error.status, error: error.code };
  }
  return {
    status: 400,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function expected11PublishStatusMessage(
  imported: Record<string, unknown> | null,
  scope: PublishScope,
): string {
  const skipped = Array.isArray(imported?.skipped) ? imported.skipped.length : 0;
  return (
    `Published ${scope.league} tour ${scope.tour}: snapshot input: ` +
    `${imported?.importedMatches ?? 0} matches, ` +
    `${imported?.importedTeams ?? 0} team rows, ${imported?.importedPlayers ?? 0} player rows · ` +
    `persisted: linked ${imported?.linked ?? 0}, unmatched ${imported?.unmatched ?? 0}, ` +
    `ambiguous ${imported?.ambiguous ?? 0}` +
    (skipped ? ` · skipped stubs ${skipped}` : "")
  );
}

class Expected11RunManager {
  private busy = false;
  private continueLogin: (() => void) | null = null;
  private output: Expected11Output | null = null;
  private hydrating: Promise<void> | null = null;
  private status: RunStatus = {
    state: "idle",
    message: "Ready",
    completed: 0,
    total: 0,
    currentUrl: null,
    diagnostic: false,
    downloadReady: false,
    publishReady: false,
    failedMatchCount: 0,
    outputPath: null,
  };

  constructor(
    private readonly runner: Expected11Runner,
    private readonly loadLatestSnapshot: () => Promise<Expected11SnapshotFile | null>,
    private readonly publishOutput?: (
      output: Expected11Output,
      scope: PublishScope,
    ) => Promise<Record<string, unknown> | null>,
  ) {}

  getStatus(): RunStatus {
    return { ...this.status };
  }

  getOutput(): Expected11Output | null {
    return this.output;
  }

  async ensureSnapshot(): Promise<void> {
    if (this.output || this.busy) return;
    if (this.hydrating) {
      await this.hydrating;
      return;
    }
    this.hydrating = this.hydrateFromDisk().finally(() => {
      this.hydrating = null;
    });
    await this.hydrating;
  }

  private applyOutput(
    output: Expected11Output,
    outputPath: string,
    message: string,
    state: RunStatus["state"] = "completed",
  ) {
    const failedMatchCount = expected11FailedMatchCount(output);
    this.output = output;
    this.status = {
      ...this.status,
      state,
      message,
      completed: output.matches.length,
      total: Math.max(this.status.total, output.matches.length),
      currentUrl: null,
      downloadReady: true,
      publishReady: expected11SnapshotPublishable(output),
      failedMatchCount,
      outputPath,
    };
  }

  private async hydrateFromDisk(): Promise<void> {
    const latest = await this.loadLatestSnapshot();
    if (!latest || this.busy || this.output) return;
    const failedMatchCount = expected11FailedMatchCount(latest.output);
    this.applyOutput(
      latest.output,
      latest.outputPath,
      failedMatchCount
        ? `Last snapshot loaded from disk (${failedMatchCount} match(es) without predictions).`
        : "Last snapshot loaded from disk.",
    );
  }

  start(request: RunRequest): boolean {
    if (this.busy) return false;

    const publishAfter = request.publishAfter;
    this.busy = true;
    this.output = null;
    this.status = {
      state: "running",
      message: "Opening Expected11 sign-in",
      completed: 0,
      total: request.urls.length,
      currentUrl: null,
      diagnostic: request.diagnostic,
      downloadReady: false,
      publishReady: false,
      failedMatchCount: 0,
      outputPath: null,
    };

    void this.runner({
      urls: request.urls,
      diagnostic: request.diagnostic,
      screenshot: request.screenshot,
      tour: request.tour ?? request.publishAfter?.tour,
      onProgress: (progress) => {
        if (progress.phase !== "waiting-login") {
          this.continueLogin = null;
        }
        this.status = {
          ...this.status,
          state: progress.phase === "waiting-login" ? "waiting-login" : "running",
          message: progress.message,
          completed: progress.completed,
          total: progress.total,
          currentUrl: progress.currentUrl,
        };
      },
      waitForManualLogin: (url) =>
        new Promise<void>((resolve) => {
          this.status = {
            ...this.status,
            state: "waiting-login",
            message:
              "Sign in with email and password in Chrome (not Google), then click Login complete — continue.",
            currentUrl: url,
          };
          this.continueLogin = () => {
            this.continueLogin = null;
            this.status = {
              ...this.status,
              state: "running",
              message: "Login confirmed; opening matches one at a time",
            };
            resolve();
          };
        }),
    })
      .then(async (result) => {
        if (publishAfter) {
          this.applyOutput(
            result.output,
            result.outputPath,
            `Publishing ${publishAfter.league} tour ${publishAfter.tour} to mantra.panenka.games…`,
            "publishing",
          );
          await this.publishParsedOutput(result.output, publishAfter);
          return;
        }
        this.applyOutput(
          result.output,
          result.outputPath,
          result.hasFailures
            ? "Finished, but one or more matches had no visible predictions."
            : "Finished successfully.",
        );
      })
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
          currentUrl: null,
          downloadReady: false,
          publishReady: false,
          failedMatchCount: 0,
          outputPath: null,
        };
      })
      .finally(() => {
        this.busy = false;
        this.continueLogin = null;
      });

    return true;
  }

  private async publishParsedOutput(
    output: Expected11Output,
    scope: PublishScope,
  ): Promise<void> {
    if (!expected11SnapshotPublishable(output)) {
      this.status = {
        ...this.status,
        state: "completed",
        message:
          "Finished, but nothing was published: no matches with predictions.",
      };
      return;
    }
    if (!this.publishOutput) {
      this.status = {
        ...this.status,
        state: "completed",
        message:
          "Parsed OK, but publish is disabled: set EXPECTED11_IMPORT_TOKEN, then restart this UI.",
      };
      return;
    }
    this.status = {
      ...this.status,
      state: "publishing",
      message: `Publishing ${scope.league} tour ${scope.tour} to mantra.panenka.games…`,
      currentUrl: null,
    };
    try {
      const imported = await this.publishOutput(output, scope);
      this.status = {
        ...this.status,
        state: "completed",
        message: expected11PublishStatusMessage(imported, scope),
      };
    } catch (error: unknown) {
      this.status = {
        ...this.status,
        state: "completed",
        message: `Parsed OK, but production import failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  continueAfterLogin(): boolean {
    if (!this.continueLogin) return false;
    this.continueLogin();
    return true;
  }
}

export function buildExpected11PublishPayload(
  output: Expected11Output,
  scope: { league: string; tour: number },
) {
  return {
    schemaVersion: output.schemaVersion,
    extractedAt: output.extractedAt,
    league: scope.league,
    tour: scope.tour,
    matches: output.matches.map((match) => ({
      sourceUrl: match.sourceUrl,
      extractedAt: match.extractedAt,
      status: match.status,
      match: match.match,
      teams: match.teams.map((team) => ({
        side: team.side,
        name: team.name,
        logoUrl: team.logoUrl,
        lineup: Object.fromEntries(
          Object.entries(team.lineup).map(([group, players]) => [
            group,
            players.map((player) => ({
              name: player.name,
              displayedPercentage: player.displayedPercentage,
              raw: { playerPath: player.raw.playerPath },
            })),
          ]),
        ),
        notes: team.notes,
        author: team.author,
      })),
    })),
  };
}

export async function publishExpected11Output(
  output: Expected11Output,
  token: string,
  scope: { league: string; tour: number },
  request: typeof fetch = fetch,
) {
  if (!token) throw new Error("Set EXPECTED11_IMPORT_TOKEN before publishing.");
  const response = await request(productionImportUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildExpected11PublishPayload(output, scope)),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? `Production import failed: ${body.error}`
        : `Production import failed (${response.status}).`,
    );
  }
  return body;
}

type Expected11AppOptions = {
  toursForLeague?: (
    league: string,
  ) => Expected11TourOption[] | Promise<Expected11TourOption[]>;
  importToken?: string;
  loadLatestSnapshot?: () => Promise<Expected11SnapshotFile | null>;
  publishRequest?: typeof fetch;
  savedUrls?: SavedTourUrlsStore;
};

async function loadPublishTours(leagueSlug: string): Promise<Expected11TourOption[]> {
  try {
    const response = await fetch(
      `https://mantra.panenka.games/api/expected11?league=${encodeURIComponent(leagueSlug)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (response.ok) {
      const body = (await response.json()) as { tours?: Expected11TourOption[] };
      if (Array.isArray(body.tours) && body.tours.length > 0) return body.tours;
    }
  } catch {
    /* local schedule is the same source /sorare uses */
  }
  return listExpected11Tours(resolveExpected11League(leagueSlug));
}

export function buildExpected11App(
  runner: Expected11Runner = runExpected11,
  options: Expected11AppOptions = {},
): FastifyInstance {
  const app = Fastify();
  const importToken = options.importToken ?? config.expected11ImportToken;
  const toursForLeague = options.toursForLeague ?? loadPublishTours;
  const publishRequest = options.publishRequest ?? fetch;
  const savedUrls =
    options.savedUrls ?? jsonSavedTourUrlsStore(defaultSavedUrlsPath);
  const manager = new Expected11RunManager(
    runner,
    options.loadLatestSnapshot ?? loadLatestExpected11Snapshot,
    (output, scope) =>
      publishExpected11Output(output, importToken, scope, publishRequest),
  );

  const publicStatus = () => ({
    ...manager.getStatus(),
    publishConfigured: Boolean(importToken),
  });

  app.get("/api/leagues", async () => {
    const defaultLeague = defaultExpected11League();
    return {
      defaultLeague: defaultLeague.slug,
      leagues: listExpected11Leagues(),
    };
  });

  app.get("/api/tours", async (request, reply) => {
    const query = request.query as { league?: string };
    try {
      const league = resolveExpected11League(
        query.league || defaultExpected11League().slug,
      );
      return { league: league.slug, tours: await toursForLeague(league.slug) };
    } catch (error) {
      const code =
        error instanceof Expected11IngestError
          ? error.code
          : "invalid_expected11_league";
      return reply.code(400).send({ error: code });
    }
  });

  app.get("/api/status", async () => {
    await manager.ensureSnapshot();
    return publicStatus();
  });

  app.get("/api/saved-urls", async (request, reply) => {
    try {
      const scope = parseExpected11ImportScope(request.query);
      return {
        ...scope,
        urls: await savedUrls.get(scope.league, scope.tour),
      };
    } catch (error) {
      const { status, error: message } = ingestReplyError(error);
      return reply.code(status).send({ error: message });
    }
  });

  app.post("/api/saved-urls", async (request, reply) => {
    try {
      const scope = parseExpected11ImportScope(request.body);
      const body = (request.body ?? {}) as { urls?: unknown };
      const urls = parseExpected11MatchUrlList(body.urls, { allowEmpty: true });
      await savedUrls.set(scope.league, scope.tour, urls);
      return { ...scope, urls };
    } catch (error) {
      const { status, error: message } = ingestReplyError(error);
      return reply.code(status).send({ error: message });
    }
  });

  app.post("/api/rebuild-and-publish", async (request, reply) => {
    if (!importToken) {
      return reply.code(409).send({
        error: "Set EXPECTED11_IMPORT_TOKEN before publishing.",
      });
    }
    let scope: PublishScope;
    let diagnostic = false;
    let screenshot = false;
    let urls: string[];
    try {
      scope = parseExpected11ImportScope(request.body);
      const body = (request.body ?? {}) as {
        urls?: unknown;
        diagnostic?: unknown;
        screenshot?: unknown;
      };
      if (body.diagnostic !== undefined && typeof body.diagnostic !== "boolean") {
        throw new Error("diagnostic must be a boolean.");
      }
      if (body.screenshot !== undefined && typeof body.screenshot !== "boolean") {
        throw new Error("screenshot must be a boolean.");
      }
      diagnostic = body.diagnostic ?? false;
      screenshot = body.screenshot ?? false;
      if (body.urls !== undefined) {
        urls = parseExpected11MatchUrlList(body.urls);
        await savedUrls.set(scope.league, scope.tour, urls);
      } else {
        urls = await savedUrls.get(scope.league, scope.tour);
      }
    } catch (error) {
      const { status, error: message } = ingestReplyError(error);
      return reply.code(status).send({ error: message });
    }
    if (urls.length === 0) {
      return reply.code(400).send({
        error:
          "No saved match URLs for this championship and tour. Paste URLs and click Сохранить ссылки.",
      });
    }
    if (
      !manager.start({
        urls,
        diagnostic,
        screenshot,
        tour: scope.tour,
        publishAfter: scope,
      })
    ) {
      return reply.code(409).send({
        error: "An Expected11 run is already active.",
      });
    }
    return reply.code(202).send(publicStatus());
  });

  app.post("/api/run", async (request, reply) => {
    let runRequest: RunRequest;
    try {
      runRequest = parseExpected11RunRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!manager.start(runRequest)) {
      return reply.code(409).send({
        error: "An Expected11 run is already active.",
      });
    }
    return reply.code(202).send(publicStatus());
  });

  app.post("/api/continue", async (_request, reply) => {
    if (!manager.continueAfterLogin()) {
      return reply.code(409).send({
        error: "The parser is not waiting for manual login.",
      });
    }
    return reply.send(publicStatus());
  });

  app.post("/api/screenshot", async (request, reply) => {
    try {
      const { parseScreenshotRequest } = await import(
        "./domain/expected11Screenshot.js"
      );
      const { captureExpected11Screenshot } = await import(
        "./sync/captureExpected11Screenshot.js"
      );
      const body = (request.body ?? {}) as Record<string, unknown>;
      const shotRequest = parseScreenshotRequest(body);
      if (!shotRequest.url && typeof body.urls === "string") {
        const first = parseExpected11MatchUrlList(body.urls, { allowEmpty: true })[0];
        if (first) shotRequest.url = first;
      }
      if (!shotRequest.url) {
        return reply.code(400).send({
          error:
            'Provide "url" (Expected11 match URL). For coords also pass clip:{x,y,width,height}.',
        });
      }
      const result = await captureExpected11Screenshot(shotRequest);
      return {
        ok: true,
        mode: shotRequest.mode,
        tour: shotRequest.tour ?? null,
        outputDir: result.outputDir,
        files: result.files.map((file) => ({
          path: file.path,
          relativePath: file.relativePath,
          side: file.side ?? null,
          teamName: file.teamName ?? null,
          clubSlug: file.clubSlug ?? null,
          clip: file.clip,
        })),
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/result", async (_request, reply) => {
    await manager.ensureSnapshot();
    const output = manager.getOutput();
    if (!output) {
      return reply.code(404).send({ error: "No completed result is available." });
    }
    return reply.send(output);
  });

  app.get("/api/result/download", async (_request, reply) => {
    await manager.ensureSnapshot();
    const output = manager.getOutput();
    if (!output) {
      return reply.code(404).send({ error: "No completed result is available." });
    }
    const filename = `expected11-${output.extractedAt.replace(/[:.]/g, "-")}.json`;
    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type("application/json")
      .send(`${JSON.stringify(output, null, 2)}\n`);
  });

  app.post("/api/publish", async (request, reply) => {
    await manager.ensureSnapshot();
    const status = manager.getStatus();
    const output = manager.getOutput();
    if (!output || !status.publishReady) {
      return reply.code(409).send({
        error: "Only a parser snapshot with at least one predicted match can be published.",
      });
    }
    let scope: { league: string; tour: number };
    try {
      scope = parseExpected11ImportScope(request.body);
    } catch (error) {
      const code =
        error instanceof Expected11IngestError
          ? error.code
          : "invalid_expected11_league";
      return reply.code(400).send({ error: code });
    }
    try {
      return await publishExpected11Output(
        output,
        importToken,
        scope,
        publishRequest,
      );
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const sorare = getSorareInsideSession();

  const sorarePublic = () => ({
    ...sorare.getStatus(),
    outputRoot: sorare.getOutputRootDisplay(),
    outputRootAbs: sorare.getOutputRootAbs(),
    publishConfigured: Boolean(importToken),
  });

  async function pickFolderNative(): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error(
        "Native folder picker works on macOS. Paste a folder path instead.",
      );
    }
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Save Sorare screenshots to:")',
      ]);
      const chosen = stdout.trim();
      if (!chosen) throw new Error("No folder selected.");
      return chosen;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/User canceled|user cancelled|-128/i.test(message)) {
        throw new Error("Folder picker cancelled.");
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  app.get("/api/sorare/status", async () => sorarePublic());

  app.get("/api/sorare/output-dir", async () => sorarePublic());

  app.post("/api/sorare/output-dir", async (request, reply) => {
    const body = (request.body ?? {}) as { outputDir?: unknown };
    try {
      parseSorareOutputDir(body.outputDir, expected11ProjectRoot);
      const outputRootAbs = sorare.setOutputRoot(String(body.outputDir));
      return {
        ...sorarePublic(),
        outputRootAbs,
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/sorare/pick-folder", async (_request, reply) => {
    try {
      const chosen = await pickFolderNative();
      sorare.setOutputRoot(chosen);
      return sorarePublic();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /cancelled/i.test(message);
      return reply.code(cancelled ? 400 : 500).send({ error: message });
    }
  });

  app.get("/api/sorare/leagues", async () => ({
    ...sorarePublic(),
    leagues: sorare.getLeagues(),
  }));

  app.get("/api/sorare/matches", async (request) => {
    const query = request.query as { leagueId?: string | string[] };
    const raw = query.leagueId;
    const leagueIds = Array.isArray(raw)
      ? raw
      : typeof raw === "string" && raw
        ? raw.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined;
    return {
      ...sorarePublic(),
      matches: sorare.getMatches(leagueIds),
    };
  });

  app.get("/api/sorare/captured", async (request, reply) => {
    const query = request.query as { round?: string };
    const round = parseScreenshotTour(query.round);
    if (round == null) {
      return reply.code(400).send({
        error: "round is required (integer 1–99).",
      });
    }
    const outputRootAbs = sorare.getOutputRootAbs();
    const clubs = listSorareCapturedClubs(outputRootAbs, round);
    return {
      round,
      outputRoot: sorare.getOutputRootDisplay(),
      outputRootAbs,
      clubs,
      bySlug: Object.fromEntries(clubs.map((c) => [c.clubSlug, c])),
    };
  });

  app.post("/api/sorare/discover", async (request, reply) => {
    try {
      parseSorareInsideDiscoverRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!sorare.startDiscover(request.body)) {
      return reply.code(409).send({
        error: "A SorareInside operation is already running.",
      });
    }
    return reply.code(202).send(sorarePublic());
  });

  app.post("/api/sorare/continue", async (_request, reply) => {
    if (!sorare.continueAfterLogin()) {
      return reply.code(409).send({
        error: "SorareInside is not waiting for manual login.",
      });
    }
    return sorarePublic();
  });

  app.post("/api/sorare/expand", async (request, reply) => {
    try {
      parseSorareInsideExpandRequest(request.body);
      return sorare.expand(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/sorare/capture", async (request, reply) => {
    try {
      parseSorareInsideCaptureRequest(request.body);
      const result = await sorare.capture(request.body);
      return {
        ok: true,
        ...sorarePublic(),
        ...result,
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/sorare/publish", async (request, reply) => {
    if (!importToken) {
      return reply.code(503).send({
        error: "Set EXPECTED11_IMPORT_TOKEN before publishing.",
      });
    }
    let scopes;
    try {
      scopes = parseSorareFootmopsPublishRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const outputRootAbs = sorare.getOutputRootAbs();
    const results: Array<Record<string, unknown>> = [];
    try {
      for (const scope of scopes) {
        const snapshot = buildFootmopsSnapshotFromSorareCaptures(
          outputRootAbs,
          scope,
        );
        const imported = await publishFootmopsSnapshot(
          snapshot,
          importToken,
          publishRequest,
        );
        results.push({
          league: scope.league,
          tour: scope.tour,
          clubsLocal: snapshot.matches.reduce(
            (n, match) => n + match.teams.length,
            0,
          ),
          ...imported,
        });
      }
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
        results,
      });
    }
    const totals = results.reduce(
      (acc, row) => ({
        clubs: acc.clubs + Number(row.clubs ?? row.clubsLocal ?? 0),
        players: acc.players + Number(row.players ?? 0),
        linked: acc.linked + Number(row.linked ?? 0),
        unmatched: acc.unmatched + Number(row.unmatched ?? 0),
        ambiguous: acc.ambiguous + Number(row.ambiguous ?? 0),
      }),
      { clubs: 0, players: 0, linked: 0, unmatched: 0, ambiguous: 0 },
    );
    return {
      ok: true,
      message:
        `Published footmops to production: clubs=${totals.clubs} players=${totals.players}` +
        ` linked=${totals.linked} unmatched=${totals.unmatched}` +
        (totals.ambiguous ? ` ambiguous=${totals.ambiguous}` : ""),
      totals,
      results,
    };
  });

  void app.register(fastifyStatic, {
    root: path.resolve(publicDir),
    prefix: "/",
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildExpected11App();
  await app.listen({ host, port });
  console.log(`Expected11 local UI → http://${host}:${port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
