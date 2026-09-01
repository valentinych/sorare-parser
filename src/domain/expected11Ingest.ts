import type Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import {
  AF_LEAGUES,
  leagueBySlug,
  leagueByTmCompetition,
  uiLeagues,
  type AfLeagueDef,
} from "../lib/afLeagues.js";
import { LIVE_LEAGUES } from "../lib/liveLeagues.js";
import {
  collectExpected11Snapshot,
  normalizeExpected11Snapshot,
  type Expected11Match,
} from "./expected11.js";
import {
  Expected11ImportError,
  importExpected11,
  MAX_EXPECTED11_IMPORT_BYTES,
  MAX_EXPECTED11_MATCHES,
  normalizeExpected11Import,
  type Expected11ImportPayload,
  type Expected11ImportResult,
} from "./expected11Import.js";
import {
  isExpected11BrowserUnavailable,
  runExpected11,
} from "../sync/runExpected11.js";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class Expected11IngestError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

export type Expected11SkippedUrl = {
  url: string;
  error: string;
};

export type Expected11TourOption = {
  round: number;
  startAt: string | null;
  endAt: string | null;
  current: boolean;
};

export type Expected11TourIngest = {
  league: string;
  tour: number;
  urls?: string[];
  extractedAt: string | null;
  importedAt: string | null;
  matchCount: number;
  lastError: string | null;
  skipped?: Expected11SkippedUrl[];
};

export type Expected11IngestView = {
  league: string | null;
  tour: number | null;
  urls?: string[];
  extractedAt: string | null;
  importedAt: string | null;
  matchCount: number;
  lastError: string | null;
  skipped?: Expected11SkippedUrl[];
  tours: Expected11TourIngest[];
};

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type TourRow = {
  league: string;
  tour: number;
  urls_json: string;
  extracted_at: string | null;
  imported_at: string | null;
  match_ids_json: string;
  skipped_json: string;
  last_error: string | null;
};

function isExpected11Host(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    ["expected11.com", "www.expected11.com"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
  );
}

export function parseExpected11SourceUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Expected11IngestError("invalid_expected11_url");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Expected11IngestError("invalid_expected11_url");
  }
  if (
    !isExpected11Host(url) ||
    url.pathname === "/" ||
    url.pathname.length > 500 ||
    value.trim().length > 500
  ) {
    throw new Expected11IngestError("invalid_expected11_url");
  }
  url.hash = "";
  return url.toString();
}

export function parseExpected11MatchUrl(value: string): string {
  const url = new URL(parseExpected11SourceUrl(value));
  if (!/^\/match\/\d+(?:\/|$)/.test(url.pathname)) {
    throw new Expected11IngestError("invalid_expected11_url");
  }
  return url.toString();
}

function isMatchUrl(value: string): boolean {
  try {
    parseExpected11MatchUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function parseExpected11UrlList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : "")).join("\n")
    : typeof value === "string"
      ? value
      : "";
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Expected11IngestError("invalid_expected11_url");
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const url = parseExpected11SourceUrl(part);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length > MAX_EXPECTED11_MATCHES) {
      throw new Expected11IngestError("invalid_expected11_url");
    }
  }
  return urls;
}

export function resolveExpected11League(value: unknown): AfLeagueDef {
  if (typeof value !== "string" || !value.trim()) {
    throw new Expected11IngestError("invalid_expected11_league");
  }
  const key = value.trim();
  return (
    leagueBySlug(key) ??
    leagueByTmCompetition(key) ??
    (() => {
      throw new Expected11IngestError("invalid_expected11_league");
    })()
  );
}

export function parseExpected11Tour(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Expected11IngestError("invalid_expected11_tour");
  }
  return n;
}

export function extractExpected11MatchUrls(html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:https:\/\/(?:www\.)?expected11\.com)?\/match\/(\d+)(?:\/[^\s"'<>]*)?/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[0]!.startsWith("http")
      ? match[0]!
      : `https://expected11.com${match[0]!}`;
    let canonical: string;
    try {
      canonical = parseExpected11MatchUrl(href);
    } catch {
      continue;
    }
    const id = new URL(canonical).pathname.match(/^\/match\/(\d+)/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    found.push(canonical);
    if (found.length >= MAX_EXPECTED11_MATCHES) break;
  }
  return found;
}

export function parseExpected11Html(
  html: string,
  sourceUrl: string,
  extractedAt: string,
): Expected11Match {
  const { document } = parseHTML(html);
  const root = document.body ?? document;
  return normalizeExpected11Snapshot(
    collectExpected11Snapshot(root, {
      sourceUrl,
      extractedAt,
      assumeVisible: true,
    }),
  );
}

async function fetchExpected11Html(
  url: string,
  request: FetchLike,
): Promise<string> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await request(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Expected11IngestError("expected11_fetch_failed", 502);
  }
  if (!response.ok) {
    throw new Expected11IngestError("expected11_fetch_failed", 502);
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url || url);
  } catch {
    throw new Expected11IngestError("expected11_fetch_failed", 502);
  }
  if (!isExpected11Host(finalUrl)) {
    throw new Expected11IngestError("expected11_fetch_failed", 502);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_EXPECTED11_IMPORT_BYTES) {
    throw new Expected11IngestError("expected11_payload_too_large", 413);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_EXPECTED11_IMPORT_BYTES) {
    throw new Expected11IngestError("expected11_payload_too_large", 413);
  }
  return buffer.toString("utf8");
}

function toImportMatch(match: Expected11Match) {
  return {
    sourceUrl: match.sourceUrl,
    extractedAt: match.extractedAt,
    status: match.status,
    match: match.match,
    teams: match.teams
      .map((team) => {
        if (team.side === "home" || team.side === "away") return team;
        if (
          match.match.homeTeam &&
          team.name.toLocaleLowerCase() === match.match.homeTeam.toLocaleLowerCase()
        ) {
          return { ...team, side: "home" as const };
        }
        if (
          match.match.awayTeam &&
          team.name.toLocaleLowerCase() === match.match.awayTeam.toLocaleLowerCase()
        ) {
          return { ...team, side: "away" as const };
        }
        return team;
      })
      .filter((team) => team.side === "home" || team.side === "away")
      .map((team) => ({
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
  };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMatchIds(value: string): string[] {
  return parseJsonArray(value).filter((id): id is string => typeof id === "string");
}

function parseUrlList(value: string): string[] {
  return parseJsonArray(value).filter((url): url is string => typeof url === "string");
}

function parseSkipped(value: string): Expected11SkippedUrl[] {
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { url?: unknown; error?: unknown };
    return typeof row.url === "string" && typeof row.error === "string"
      ? [{ url: row.url, error: row.error }]
      : [];
  });
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function mergeSkipped(
  previous: Expected11SkippedUrl[],
  next: Expected11SkippedUrl[],
  importedUrls: Set<string>,
): Expected11SkippedUrl[] {
  const byUrl = new Map<string, Expected11SkippedUrl>();
  for (const row of previous) {
    if (!importedUrls.has(row.url)) byUrl.set(row.url, row);
  }
  for (const row of next) {
    if (!importedUrls.has(row.url)) byUrl.set(row.url, row);
  }
  return [...byUrl.values()];
}

function toTourIngest(
  row: TourRow,
  options: { includeUrls?: boolean },
): Expected11TourIngest {
  return {
    league: row.league,
    tour: row.tour,
    ...(options.includeUrls ? { urls: parseUrlList(row.urls_json) } : {}),
    extractedAt: row.extracted_at,
    importedAt: row.imported_at,
    matchCount: parseMatchIds(row.match_ids_json).length,
    lastError: row.last_error,
    ...(options.includeUrls ? { skipped: parseSkipped(row.skipped_json) } : {}),
  };
}

function emptyIngest(
  league: string | null,
  tour: number | null,
): Omit<Expected11IngestView, "tours"> {
  return {
    league,
    tour,
    extractedAt: null,
    importedAt: null,
    matchCount: 0,
    lastError: null,
  };
}

function loadTourRow(
  database: Database.Database,
  league: string,
  tour: number,
): TourRow | undefined {
  return database
    .prepare(
      `SELECT league, tour, urls_json, extracted_at, imported_at, match_ids_json,
              skipped_json, last_error
       FROM expected11_ingest_tours
       WHERE league = ? AND tour = ?`,
    )
    .get(league, tour) as TourRow | undefined;
}

function loadAllTourRows(database: Database.Database): TourRow[] {
  return database
    .prepare(
      `SELECT league, tour, urls_json, extracted_at, imported_at, match_ids_json,
              skipped_json, last_error
       FROM expected11_ingest_tours
       ORDER BY league, tour`,
    )
    .all() as TourRow[];
}

export function getExpected11TourMatchIds(
  league: string,
  tour: number,
  database: Database.Database = getDb(),
): string[] {
  const row = loadTourRow(database, league, tour);
  return row ? parseMatchIds(row.match_ids_json) : [];
}

export function getExpected11IngestView(
  options: {
    includeUrls?: boolean;
    league?: string | null;
    tour?: number | null;
  } = {},
  database: Database.Database = getDb(),
): Omit<Expected11IngestView, never> {
  const tours = loadAllTourRows(database).map((row) =>
    toTourIngest(row, options),
  );
  const selected =
    options.league && options.tour != null
      ? tours.find(
          (row) => row.league === options.league && row.tour === options.tour,
        ) ?? {
          league: options.league,
          tour: options.tour,
          ...(options.includeUrls ? { urls: [], skipped: [] } : {}),
          extractedAt: null,
          importedAt: null,
          matchCount: 0,
          lastError: null,
        }
      : null;
  return {
    ...emptyIngest(options.league ?? null, options.tour ?? null),
    ...(selected
      ? {
          league: selected.league,
          tour: selected.tour,
          extractedAt: selected.extractedAt,
          importedAt: selected.importedAt,
          matchCount: selected.matchCount,
          lastError: selected.lastError,
          ...(options.includeUrls
            ? { urls: selected.urls ?? [], skipped: selected.skipped ?? [] }
            : {}),
        }
      : {}),
    tours,
  };
}

function upsertTourRow(
  database: Database.Database,
  input: {
    league: string;
    tour: number;
    urls: string[];
    extractedAt?: string | null;
    matchIds?: string[];
    skipped?: Expected11SkippedUrl[];
    lastError?: string | null;
    imported?: boolean;
  },
): void {
  const previous = loadTourRow(database, input.league, input.tour);
  database
    .prepare(
      `INSERT INTO expected11_ingest_tours
         (league, tour, urls_json, extracted_at, imported_at, match_ids_json,
          skipped_json, last_error)
       VALUES (?, ?, ?, ?, ${input.imported ? "datetime('now')" : "NULL"}, ?, ?, ?)
       ON CONFLICT(league, tour) DO UPDATE SET
         urls_json = excluded.urls_json,
         extracted_at = COALESCE(excluded.extracted_at, expected11_ingest_tours.extracted_at),
         imported_at = CASE
           WHEN excluded.imported_at IS NOT NULL THEN excluded.imported_at
           ELSE expected11_ingest_tours.imported_at
         END,
         match_ids_json = CASE
           WHEN excluded.match_ids_json = '[]' AND excluded.imported_at IS NULL
           THEN expected11_ingest_tours.match_ids_json
           ELSE excluded.match_ids_json
         END,
         skipped_json = excluded.skipped_json,
         last_error = excluded.last_error`,
    )
    .run(
      input.league,
      input.tour,
      JSON.stringify(input.urls),
      input.extractedAt ?? previous?.extracted_at ?? null,
      JSON.stringify(input.matchIds ?? parseMatchIds(previous?.match_ids_json ?? "[]")),
      JSON.stringify(input.skipped ?? []),
      input.lastError ?? null,
    );
}

function matchIdFromUrl(url: string): string | undefined {
  return new URL(url).pathname.match(/^\/match\/(\d+)/)?.[1];
}

function existingMatchIdForUrl(
  database: Database.Database,
  url: string,
): string | undefined {
  const id = matchIdFromUrl(url);
  if (id) {
    const row = database
      .prepare(`SELECT id FROM expected11_matches WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (row) return row.id;
  }
  const byUrl = database
    .prepare(`SELECT id FROM expected11_matches WHERE source_url = ?`)
    .get(url) as { id: string } | undefined;
  return byUrl?.id;
}

export type Expected11MatchParser = (
  urls: string[],
  options: { extractedAt: string },
) => Promise<Expected11Match[]>;

async function parseMatchesWithBrowser(
  urls: string[],
  options: { extractedAt: string },
): Promise<Expected11Match[]> {
  try {
    const result = await runExpected11({
      urls,
      extractedAt: options.extractedAt,
      promptForLogin: false,
    });
    return result.output.matches;
  } catch (error) {
    if (error instanceof Expected11IngestError) throw error;
    if (isExpected11BrowserUnavailable(error)) {
      throw new Expected11IngestError("expected11_browser_unavailable", 503);
    }
    throw new Expected11IngestError("expected11_fetch_failed", 502);
  }
}

function ingestSkipCode(match: Expected11Match): string | null {
  if (match.status === "ok") return null;
  if (match.status === "login-required") return "expected11_login_required";
  return "expected11_match_has_no_predictions";
}

function isPaywalledStub(match: Expected11Match): boolean {
  return (
    match.players.length === 0 &&
    Boolean(
      match.diagnostics.accessMessage ||
        match.diagnostics.signInVisible ||
        match.diagnostics.restrictedPositionCount > 0,
    )
  );
}

export type Expected11IngestResult = {
  ingest: Expected11IngestView;
  import: Expected11ImportResult | null;
};

export function saveExpected11TourUrls(
  input: { league: unknown; tour: unknown; urls: unknown },
  database: Database.Database = getDb(),
): Expected11IngestResult {
  const league = resolveExpected11League(input.league);
  const tour = parseExpected11Tour(input.tour);
  const urls = parseExpected11UrlList(input.urls);
  upsertTourRow(database, {
    league: league.slug,
    tour,
    urls,
    skipped: [],
    lastError: null,
  });
  return {
    import: null,
    ingest: getExpected11IngestView(
      { includeUrls: true, league: league.slug, tour },
      database,
    ),
  };
}

export async function rebuildExpected11Tour(
  input: { league: unknown; tour: unknown; urls?: unknown },
  options: {
    database?: Database.Database;
    fetch?: FetchLike;
    parseMatches?: Expected11MatchParser;
    now?: Date;
  } = {},
): Promise<Expected11IngestResult> {
  const league = resolveExpected11League(input.league);
  const tour = parseExpected11Tour(input.tour);
  const database = options.database ?? getDb();
  const request = options.fetch ?? fetch;
  const parseMatches = options.parseMatches ?? parseMatchesWithBrowser;
  const extractedAt = (options.now ?? new Date()).toISOString();
  const urls =
    input.urls != null &&
    !(typeof input.urls === "string" && !input.urls.trim()) &&
    !(Array.isArray(input.urls) && input.urls.length === 0)
      ? parseExpected11UrlList(input.urls)
      : parseUrlList(loadTourRow(database, league.slug, tour)?.urls_json ?? "[]");
  if (urls.length === 0) {
    throw new Expected11IngestError("invalid_expected11_url");
  }

  const htmlByUrl = new Map<string, string>();
  const skipped: Expected11SkippedUrl[] = [];
  const matchUrls: string[] = [];
  const seenQueued = new Set<string>();

  async function htmlFor(url: string): Promise<string> {
    const cached = htmlByUrl.get(url);
    if (cached != null) return cached;
    const html = await fetchExpected11Html(url, request);
    htmlByUrl.set(url, html);
    return html;
  }

  function queueMatch(url: string): void {
    const id = matchIdFromUrl(url);
    if (id && seenQueued.has(id)) return;
    if (id) seenQueued.add(id);
    if (matchUrls.length >= MAX_EXPECTED11_MATCHES) return;
    matchUrls.push(url);
  }

  for (const sourceUrl of urls) {
    try {
      if (isMatchUrl(sourceUrl)) {
        queueMatch(sourceUrl);
        continue;
      }
      const html = await htmlFor(sourceUrl);
      const matches = extractExpected11MatchUrls(html);
      if (matches.length === 0) {
        skipped.push({ url: sourceUrl, error: "expected11_no_matches" });
        continue;
      }
      for (const matchUrl of matches) queueMatch(matchUrl);
    } catch (error) {
      const code =
        error instanceof Expected11IngestError
          ? error.code
          : "expected11_fetch_failed";
      skipped.push({ url: sourceUrl, error: code });
    }
  }

  const okMatches: Expected11Match[] = [];
  const keptIds: string[] = [];

  function keepExisting(url: string): void {
    const existing = existingMatchIdForUrl(database, url);
    if (existing) keptIds.push(existing);
  }

  if (matchUrls.length > 0) {
    try {
      const parsed = await parseMatches(matchUrls, { extractedAt });
      const byUrl = new Map(parsed.map((match) => [match.sourceUrl, match]));
      for (const url of matchUrls) {
        const match = byUrl.get(url);
        if (!match) {
          skipped.push({ url, error: "expected11_match_has_no_predictions" });
          keepExisting(url);
          continue;
        }
        const skip = ingestSkipCode(match);
        if (skip) {
          skipped.push({ url, error: skip });
          keepExisting(url);
          continue;
        }
        okMatches.push(match);
      }
    } catch (error) {
      const code =
        error instanceof Expected11IngestError
          ? error.code
          : "expected11_fetch_failed";
      for (const url of matchUrls) {
        skipped.push({ url, error: code });
        keepExisting(url);
      }
    }
  }

  let imported: Expected11ImportResult | null = null;
  if (okMatches.length > 0) {
    let payload;
    try {
      payload = normalizeExpected11Import({
        schemaVersion: 2,
        extractedAt,
        matches: okMatches.map(toImportMatch),
      });
    } catch (error) {
      if (error instanceof Expected11ImportError) {
        throw new Expected11IngestError(error.code, error.status);
      }
      throw error;
    }
    imported = importExpected11(payload, database, { replaceAll: false });
  }

  const matchIds = [
    ...new Set([
      ...okMatches.map((match) => match.match.id).filter(Boolean),
      ...keptIds,
    ]),
  ];
  upsertTourRow(database, {
    league: league.slug,
    tour,
    urls,
    extractedAt,
    matchIds,
    skipped,
    lastError:
      okMatches.length === 0 && skipped.length > 0
        ? skipped[0]!.error
        : okMatches.some(isPaywalledStub)
          ? "expected11_login_required"
          : null,
    imported: true,
  });
  return {
    import: imported,
    ingest: getExpected11IngestView(
      { includeUrls: true, league: league.slug, tour },
      database,
    ),
  };
}

function parseRoundNum(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const match = String(value).match(/(\d+)\s*$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function listExpected11Tours(
  league: AfLeagueDef,
  database: Database.Database = getDb(),
  season = config.predictSeason,
): Expected11TourOption[] {
  const byRound = new Map<number, { startAt: string | null; endAt: string | null }>();
  const add = (round: number, startAt: string | null, endAt: string | null) => {
    const prev = byRound.get(round);
    if (!prev) {
      byRound.set(round, { startAt, endAt });
      return;
    }
    byRound.set(round, {
      startAt:
        startAt && (!prev.startAt || startAt < prev.startAt) ? startAt : prev.startAt,
      endAt: endAt && (!prev.endAt || endAt > prev.endAt) ? endAt : prev.endAt,
    });
  };

  const fixtures = database
    .prepare(
      `SELECT round, MIN(date) AS start_at, MAX(date) AS end_at
       FROM fixtures
       WHERE league_id = ? AND season = ? AND round IS NOT NULL AND round != ''
       GROUP BY round`,
    )
    .all(league.id, season) as Array<{
    round: string;
    start_at: string | null;
    end_at: string | null;
  }>;
  for (const row of fixtures) {
    const n = parseRoundNum(row.round);
    if (n != null) add(n, row.start_at, row.end_at);
  }

  const fotmobId = LIVE_LEAGUES[league.slug]?.fotmobLeagueId;
  if (fotmobId != null) {
    const fotmob = database
      .prepare(
        `SELECT round, MIN(kickoff) AS start_at, MAX(kickoff) AS end_at
         FROM fotmob_matches
         WHERE league_id = ? AND round IS NOT NULL AND round != ''
         GROUP BY round`,
      )
      .all(fotmobId) as Array<{
      round: string;
      start_at: string | null;
      end_at: string | null;
    }>;
    for (const row of fotmob) {
      const n = parseRoundNum(row.round);
      if (n != null) add(n, row.start_at, row.end_at);
    }
  }

  for (const row of loadAllTourRows(database)) {
    if (row.league === league.slug) add(row.tour, null, null);
  }

  const nextUnfinished = database
    .prepare(
      `SELECT round FROM fixtures
       WHERE league_id = ? AND season = ?
         AND status NOT IN ('FT','AET','PEN','CANC','PST','ABD')
         AND round LIKE 'Regular Season - %'
       ORDER BY date ASC
       LIMIT 1`,
    )
    .get(league.id, season) as { round: string | null } | undefined;
  let current = parseRoundNum(nextUnfinished?.round ?? null);
  if (current == null && fotmobId != null) {
    const liveRound = database
      .prepare(
        `SELECT round, kickoff FROM fotmob_matches
         WHERE league_id = ? AND phase = 'upcoming' AND round IS NOT NULL
         ORDER BY kickoff ASC LIMIT 1`,
      )
      .get(fotmobId) as { round: string } | undefined;
    current = parseRoundNum(liveRound?.round ?? null);
  }
  if (current == null && byRound.size > 0) {
    current = Math.max(...byRound.keys());
  }

  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, dates]) => ({
      round,
      startAt: dates.startAt,
      endAt: dates.endAt,
      current: round === current,
    }));
}

export function resolveExpected11Tour(
  requested: unknown,
  tours: Expected11TourOption[],
): number | null {
  if (requested != null && String(requested).trim() !== "") {
    try {
      return parseExpected11Tour(requested);
    } catch {
      /* fall through to schedule default */
    }
  }
  return tours.find((tour) => tour.current)?.round ?? tours[0]?.round ?? null;
}

export function defaultExpected11League(): AfLeagueDef {
  return AF_LEAGUES[40] ?? Object.values(AF_LEAGUES)[0]!;
}

export function listExpected11Leagues(): Array<{
  slug: string;
  name: string;
  tmCompetition: string;
}> {
  return uiLeagues().map((league) => ({
    slug: league.slug,
    name: league.name,
    tmCompetition: league.tmCompetition,
  }));
}

export function parseExpected11ImportScope(value: unknown): {
  league: string;
  tour: number;
} {
  if (!value || typeof value !== "object") {
    throw new Expected11IngestError("invalid_expected11_league");
  }
  const input = value as { league?: unknown; championship?: unknown; tour?: unknown };
  const league = resolveExpected11League(input.league ?? input.championship);
  return { league: league.slug, tour: parseExpected11Tour(input.tour) };
}

export function importExpected11ForTour(
  payload: Expected11ImportPayload,
  leagueValue: unknown,
  tourValue: unknown,
  database: Database.Database = getDb(),
): Expected11ImportResult {
  const league = resolveExpected11League(leagueValue);
  const tour = parseExpected11Tour(tourValue);
  const imported = importExpected11(payload, database, { replaceAll: false });
  const skipped = payload.skipped ?? [];
  const previous = loadTourRow(database, league.slug, tour);
  const importedUrls = new Set(payload.matches.map((match) => match.sourceUrl));
  upsertTourRow(database, {
    league: league.slug,
    tour,
    urls: uniqueStrings([
      ...parseUrlList(previous?.urls_json ?? "[]"),
      ...payload.matches.map((match) => match.sourceUrl),
      ...skipped.map((row) => row.url),
    ]),
    extractedAt: payload.extractedAt,
    matchIds: uniqueStrings([
      ...parseMatchIds(previous?.match_ids_json ?? "[]"),
      ...payload.matches.map((match) => match.id),
    ]),
    skipped: mergeSkipped(
      parseSkipped(previous?.skipped_json ?? "[]"),
      skipped,
      importedUrls,
    ),
    lastError: null,
    imported: true,
  });
  return {
    ...imported,
    league: league.slug,
    tour,
    skipped,
  };
}
