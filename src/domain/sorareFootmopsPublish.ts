import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AF_LEAGUES, leagueBySlug } from "../lib/afLeagues.js";
import {
  FOOTMOPS_SOURCE,
  type FootmopsLineupGroup,
  type FootmopsPlayer,
  type FootmopsSnapshot,
} from "./footmops.js";

export const FOOTMOPS_PRODUCTION_IMPORT_URL =
  "https://mantra.panenka.games/api/footmops/import";

export const MAX_FOOTMOPS_IMPORT_BYTES = 512 * 1024;

type SorareCaptureFile = {
  capturedAt?: string;
  teamName?: string;
  clubSlug?: string;
  round?: number;
  leagueLabel?: string;
  probabilities?: Array<{
    name?: string;
    percentage?: number | null;
    group?: string;
  }>;
};

export type SorareFootmopsPublishScope = {
  league: string;
  tour: number;
};

function foldLeagueLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Map SorareInside labels like "England - Championship" → mantra slug. */
export function mapSorareLeagueLabelToSlug(label: string): string | null {
  const raw = label.trim();
  if (!raw) return null;
  const asSlug = raw.toLowerCase();
  if (leagueBySlug(asSlug)?.mantraTournamentId) return asSlug;
  const folded = foldLeagueLabel(raw);
  if (/\bsuper lig\b/.test(folded)) return "super-lig";
  const leagues = Object.values(AF_LEAGUES)
    .filter((league) => league.mantraTournamentId != null)
    .sort((a, b) => b.name.length - a.name.length);
  for (const league of leagues) {
    const name = league.name.toLowerCase();
    if (asSlug.includes(name) || folded.includes(foldLeagueLabel(league.name))) {
      return league.slug;
    }
  }
  return null;
}

function isLineupGroup(value: string): value is FootmopsLineupGroup {
  return value === "starting" || value === "bench" || value === "out";
}

function isCaptureChrome(name: string): boolean {
  const trimmed = name.trim();
  if (/sorareinside\.com/i.test(trimmed)) return true;
  if (/^(first published|updated|copy lineup url)\b/i.test(trimmed)) return true;
  return false;
}

function isUsablePlayerName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  if (/^%/.test(trimmed)) return false;
  if (/^\d+%?$/.test(trimmed)) return false;
  if (/^(score|aa|da|app|sorareinside\.com|copy lineup url)$/i.test(trimmed)) {
    return false;
  }
  if (/^(first published|updated)\b/i.test(trimmed)) return false;
  return true;
}

function finitePercentage(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function playersFromCapture(raw: SorareCaptureFile): FootmopsPlayer[] {
  const out: FootmopsPlayer[] = [];
  let stopOut = false;
  for (const row of raw.probabilities ?? []) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const group = typeof row.group === "string" ? row.group : "";
    if (isCaptureChrome(name)) {
      if (group === "out") stopOut = true;
      continue;
    }
    if (!isUsablePlayerName(name) || !isLineupGroup(group)) continue;
    if (group === "out" && stopOut) continue;
    const percentage = finitePercentage(row.percentage);
    if (group !== "out" && percentage == null) continue;
    out.push({ name, percentage, group });
  }
  return out;
}

export function buildFootmopsSnapshotFromSorareCaptures(
  outputRootAbs: string,
  scope: SorareFootmopsPublishScope,
): FootmopsSnapshot {
  const league = leagueBySlug(scope.league);
  if (!league?.mantraTournamentId) {
    throw new Error(`Unknown mantra league slug: ${scope.league}`);
  }
  if (!Number.isInteger(scope.tour) || scope.tour < 1 || scope.tour > 99) {
    throw new Error("tour must be an integer 1–99.");
  }
  const dir = path.join(outputRootAbs, String(scope.tour));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => /\.json$/i.test(name));
  } catch {
    throw new Error(
      `No captures under data/sorare/output/${scope.tour}/ for ${scope.league}.`,
    );
  }
  const teams: Array<{ name: string; players: FootmopsPlayer[] }> = [];
  let extractedAt = "";
  for (const name of names.sort()) {
    let raw: SorareCaptureFile;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as SorareCaptureFile;
    } catch {
      continue;
    }
    const labelSlug = mapSorareLeagueLabelToSlug(raw.leagueLabel ?? "");
    if (labelSlug && labelSlug !== scope.league) continue;
    // If sidecar has no leagueLabel, include it (folder+explicit scope).
    if (!labelSlug && raw.leagueLabel) continue;
    const teamName =
      (typeof raw.teamName === "string" && raw.teamName.trim()) ||
      name.replace(/\.json$/i, "");
    const players = playersFromCapture(raw);
    if (!players.length) continue;
    teams.push({ name: teamName, players });
    if (
      typeof raw.capturedAt === "string" &&
      (!extractedAt || raw.capturedAt > extractedAt)
    ) {
      extractedAt = raw.capturedAt;
    }
  }
  if (!teams.length) {
    throw new Error(
      `No ${scope.league} club JSON with probabilities in data/sorare/output/${scope.tour}/.`,
    );
  }
  return {
    source: FOOTMOPS_SOURCE,
    sourceUrl: "https://sorareinside.com",
    league: scope.league,
    tour: scope.tour,
    extractedAt: extractedAt || new Date().toISOString(),
    title: `${league.name} tour ${scope.tour} SorareInside lineups`,
    matches: teams.map((team) => ({
      home: team.name,
      away: "",
      teams: [team],
    })),
  };
}

export function parseSorareFootmopsPublishRequest(body: unknown): SorareFootmopsPublishScope[] {
  if (!body || typeof body !== "object") {
    throw new Error("JSON body required: { league, tour } or { scopes: [...] }.");
  }
  const record = body as Record<string, unknown>;
  const scopesRaw = record.scopes;
  if (Array.isArray(scopesRaw)) {
    if (!scopesRaw.length) throw new Error("scopes must not be empty.");
    return scopesRaw.map((entry, index) => parseOneScope(entry, `scopes[${index}]`));
  }
  return [parseOneScope(body, "body")];
}

function parseOneScope(value: unknown, label: string): SorareFootmopsPublishScope {
  if (!value || typeof value !== "object") {
    throw new Error(`${label}: expected { league, tour }.`);
  }
  const row = value as Record<string, unknown>;
  let league =
    typeof row.league === "string" ? row.league.trim().toLowerCase() : "";
  if (!league && typeof row.leagueLabel === "string") {
    league = mapSorareLeagueLabelToSlug(row.leagueLabel) ?? "";
  }
  if (!league || !leagueBySlug(league)?.mantraTournamentId) {
    throw new Error(
      `${label}: league must be a known mantra slug (e.g. championship, premier-league).`,
    );
  }
  const tour = Number(row.tour ?? row.round);
  if (!Number.isInteger(tour) || tour < 1 || tour > 99) {
    throw new Error(`${label}: tour/round must be an integer 1–99.`);
  }
  return { league, tour };
}

export function normalizeFootmopsImportPayload(body: unknown): FootmopsSnapshot {
  if (!body || typeof body !== "object") {
    throw Object.assign(new Error("invalid_footmops_payload"), { status: 400 });
  }
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > MAX_FOOTMOPS_IMPORT_BYTES) {
    throw Object.assign(new Error("footmops_payload_too_large"), { status: 413 });
  }
  const input = body as Record<string, unknown>;
  const league =
    typeof input.league === "string" ? input.league.trim().toLowerCase() : "";
  if (!leagueBySlug(league)?.mantraTournamentId) {
    throw Object.assign(new Error("invalid_footmops_league"), { status: 400 });
  }
  const tour = Number(input.tour);
  if (!Number.isInteger(tour) || tour < 1 || tour > 99) {
    throw Object.assign(new Error("invalid_footmops_tour"), { status: 400 });
  }
  if (!Array.isArray(input.matches) || input.matches.length === 0) {
    throw Object.assign(new Error("invalid_footmops_matches"), { status: 400 });
  }
  const extractedAt =
    typeof input.extractedAt === "string" && input.extractedAt
      ? input.extractedAt
      : new Date().toISOString();
  const source =
    typeof input.source === "string" && input.source.trim()
      ? input.source.trim()
      : FOOTMOPS_SOURCE;
  const sourceUrl =
    typeof input.sourceUrl === "string" && input.sourceUrl.trim()
      ? input.sourceUrl.trim()
      : "https://sorareinside.com";
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : `${league} tour ${tour}`;

  const matches: FootmopsSnapshot["matches"] = [];
  for (const match of input.matches) {
    if (!match || typeof match !== "object") continue;
    const m = match as Record<string, unknown>;
    const home = typeof m.home === "string" ? m.home : "";
    const away = typeof m.away === "string" ? m.away : "";
    const teamsRaw = Array.isArray(m.teams) ? m.teams : [];
    const teams: Array<{ name: string; players: FootmopsPlayer[] }> = [];
    for (const team of teamsRaw) {
      if (!team || typeof team !== "object") continue;
      const t = team as Record<string, unknown>;
      const name = typeof t.name === "string" ? t.name.trim() : "";
      if (!name) continue;
      const players: FootmopsPlayer[] = [];
      for (const player of Array.isArray(t.players) ? t.players : []) {
        if (!player || typeof player !== "object") continue;
        const p = player as Record<string, unknown>;
        const pname = typeof p.name === "string" ? p.name.trim() : "";
        const group = typeof p.group === "string" ? p.group : "";
        if (!isUsablePlayerName(pname) || !isLineupGroup(group)) continue;
        const percentage = finitePercentage(p.percentage);
        if (group !== "out" && percentage == null) continue;
        players.push({ name: pname, percentage, group });
      }
      if (players.length) teams.push({ name, players });
    }
    if (teams.length) matches.push({ home, away, teams });
  }
  if (!matches.length) {
    throw Object.assign(new Error("invalid_footmops_matches"), { status: 400 });
  }
  return {
    source,
    sourceUrl,
    league,
    tour,
    extractedAt,
    title,
    matches,
  };
}

export async function publishFootmopsSnapshot(
  snapshot: FootmopsSnapshot,
  token: string,
  request: typeof fetch = fetch,
  importUrl: string = FOOTMOPS_PRODUCTION_IMPORT_URL,
) {
  if (!token) throw new Error("Set EXPECTED11_IMPORT_TOKEN before publishing.");
  const response = await request(importUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? `Production footmops import failed: ${body.error}`
        : `Production footmops import failed (${response.status}).`,
    );
  }
  return body;
}
