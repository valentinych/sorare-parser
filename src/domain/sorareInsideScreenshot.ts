/** Helpers for the local SorareInside lineups tab (Expected11 UI on :3002). */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { clubFileSlug, parseScreenshotTour } from "./expected11Screenshot.js";

export { clubFileSlug, parseScreenshotTour };

/**
 * Injected into the Playwright page (tsx `.toString()` adds `__name`, which
 * does not exist in the browser). Keep this as plain JS.
 */
export const LINEUP_TEAM_LABELS_MATCH_SOURCE = `(displayed, wanted) => {
  const fold = (value) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .toLowerCase()
      .replace(/\\s+/g, " ")
      .trim();
  const stripFc = (value) =>
    fold(value).replace(/\\s+(fc|afc|cf|sc)\\.?$/i, "").trim();
  const slug = (value) =>
    stripFc(value)
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
  const DROP = {
    north: 1, end: 1, town: 1, athletic: 1, hotspur: 1, albion: 1,
    rovers: 1, wanderers: 1, county: 1, argyle: 1, forest: 1, wednesday: 1,
  };
  const slugsEqual = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (!longer.startsWith(shorter + "-")) return false;
    const rest = longer.slice(shorter.length + 1).split("-");
    return rest.length > 0 && rest.every((t) => DROP[t]);
  };
  const shown = String(displayed || "").trim();
  if (!shown || shown.length > 500) return false;
  const want = String(wanted || "").trim();
  if (!want) return false;
  const collapsed = fold(shown);
  const wantFold = fold(want);
  const wantNoFc = stripFc(want);
  if (!wantNoFc) return false;
  if (collapsed.includes(wantFold) || collapsed.includes(wantNoFc)) return true;
  const wantWords = wantNoFc.split(" ");
  if (wantWords.length >= 2) {
    const two = wantWords.slice(0, 2).join(" ");
    if (two.length >= 8 && collapsed.includes(two)) return true;
  }
  const shownNoFc = stripFc(collapsed);
  if (
    shownNoFc.length >= 8 &&
    shownNoFc.split(" ").length >= 2 &&
    wantNoFc.startsWith(shownNoFc)
  ) {
    return true;
  }
  const sides = collapsed.split(/\\s+vs\\.?\\s+/i);
  for (const side of sides) {
    const chunk = side
      .replace(/updated\\s+\\d+\\s+[a-z]+\\s+ago/g, " ")
      .replace(/\\b(mon|tue|wed|thu|fri|sat|sun)\\b[^]{0,40}/g, " ")
      .trim();
    if (chunk && slugsEqual(slug(chunk), slug(want))) return true;
    if (chunk && fold(chunk).includes(wantNoFc)) return true;
    if (
      chunk &&
      stripFc(chunk).length >= 8 &&
      stripFc(chunk).split(" ").length >= 2 &&
      wantNoFc.startsWith(stripFc(chunk))
    ) {
      return true;
    }
  }
  const firstLine = shown.split("\\n")[0].trim();
  const wantSlug = slug(want);
  if (slugsEqual(slug(firstLine), wantSlug) || slugsEqual(slug(collapsed), wantSlug)) {
    return true;
  }
  if (/(?:\\u2026|\\.\\.\\.)$/.test(firstLine)) {
    const prefix = slug(firstLine.replace(/(?:\\u2026|\\.\\.\\.)$/, "").trim());
    if (prefix.length >= 6 && wantSlug.startsWith(prefix)) return true;
  }
  return false;
}`;

const lineupTeamLabelsMatchFn = new Function(
  `return ${LINEUP_TEAM_LABELS_MATCH_SOURCE};`,
)() as (displayed: string, wanted: string) => boolean;

/** True when a lineups-list label is the same club as `wanted`. */
export function lineupTeamLabelsMatch(displayed: string, wanted: string): boolean {
  return lineupTeamLabelsMatchFn(displayed, wanted);
}

/**
 * Find the visible club name on a Championship vs-row.
 * Live DOM (2026-09-01): `a.mantine-Anchor-root > p` with "Birmingham City FC".
 * Hidden ` [data-combobox-option]` copies must be skipped — they sort first.
 * Injected as plain JS (no tsx `__name`).
 */
export const LINEUP_CLUB_FIND_SOURCE = `(want, mode, requireVisible) => {
  const match = ${LINEUP_TEAM_LABELS_MATCH_SOURCE};
  const skipSel =
    "[data-combobox-option], [data-combobox-dropdown], [data-combobox-target], [role='combobox'], .mantine-Select-option, .mantine-Select-dropdown, .mantine-Combobox-option, .mantine-Combobox-dropdown";
  const textOf = (el) =>
    String((el.innerText != null ? el.innerText : el.textContent) || "")
      .replace(/\\s+/g, " ")
      .trim();
  const isVisible = (el) => {
    if (!requireVisible) return true;
    if (typeof el.getBoundingClientRect !== "function") return true;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const clubNodes = document.querySelectorAll(
    "a.mantine-Anchor-root, p.mantine-Text-root",
  );
  let best = null;
  for (const el of clubNodes) {
    if (!el || el.closest(skipSel)) continue;
    const t = textOf(el);
    if (!t || t.length > 80) continue;
    if (!match(t, want)) continue;
    if (!isVisible(el)) continue;
    best = (el.closest && el.closest("a.mantine-Anchor-root")) || el;
    break;
  }
  if (!best) {
    for (const el of document.querySelectorAll("div[class*='_game_']")) {
      if (!el || el.closest(skipSel)) continue;
      const t = textOf(el);
      if (!t || t.length > 400 || !match(t, want)) continue;
      if (!isVisible(el)) continue;
      let club = null;
      for (const n of el.querySelectorAll("a.mantine-Anchor-root, p.mantine-Text-root")) {
        if (n.closest(skipSel)) continue;
        if (match(textOf(n), want)) {
          club = n.closest("a.mantine-Anchor-root") || n;
          break;
        }
      }
      best = club || el;
      break;
    }
  }
  if (!best) return { ok: false, text: null, tag: null, cls: null };
  if (mode === "click") {
    if (best.scrollIntoView) best.scrollIntoView({ block: "center", inline: "nearest" });
    if (typeof best.click === "function") best.click();
  }
  return {
    ok: true,
    text: textOf(best).slice(0, 80),
    tag: best.tagName || null,
    cls: String(best.className || "").slice(0, 120),
  };
}`;

type LineupClubFindResult = {
  ok: boolean;
  text: string | null;
  tag: string | null;
  cls: string | null;
};

/** Run the live-page club finder against saved lineups HTML (no browser). */
export function findLineupClubAnchorInHtml(
  html: string,
  teamName: string,
): LineupClubFindResult {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const find = new Function(
    "document",
    `return ${LINEUP_CLUB_FIND_SOURCE};`,
  )(document) as (
    want: string,
    mode: "find" | "click",
    requireVisible: boolean,
  ) => LineupClubFindResult;
  return find(teamName, "find", false);
}

export const SORARE_INSIDE_ORIGIN = "https://sorareinside.com";
export const SORARE_INSIDE_API_ORIGIN = "https://platform-api.sorareinside.com";

/** Screenshots live under `data/sorare/output/{tour}/{club}.png` by default. */
export const SORARE_OUTPUT_RELATIVE_ROOT = "data/sorare/output";
export const SORARE_OUTPUT_DIR_CONFIG_RELATIVE = "data/sorare/output-dir.json";

/** Absolute folder path; relative values resolve against `projectRoot`. */
export function parseSorareOutputDir(value: unknown, projectRoot: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("outputDir must be a non-empty folder path.");
  }
  const trimmed = value.trim();
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(projectRoot, trimmed);
}

/** Prefer a project-relative path in the UI when the folder is inside the repo. */
export function displaySorareOutputDir(
  outputDirAbs: string,
  projectRoot: string,
): string {
  const rel = path.relative(projectRoot, outputDirAbs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return outputDirAbs;
}

export function loadSorareOutputDirConfig(projectRoot: string): string | null {
  const file = path.join(projectRoot, SORARE_OUTPUT_DIR_CONFIG_RELATIVE);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { outputDir?: unknown };
    if (raw.outputDir == null) return null;
    return parseSorareOutputDir(raw.outputDir, projectRoot);
  } catch {
    return null;
  }
}

export function saveSorareOutputDirConfig(
  projectRoot: string,
  outputDirAbs: string,
): void {
  const file = path.join(projectRoot, SORARE_OUTPUT_DIR_CONFIG_RELATIVE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ outputDir: outputDirAbs }, null, 2)}\n`,
  );
}

export type SorareInsideLeague = {
  id: string;
  /** e.g. "Argentina - Liga Professional Argentina" */
  label: string;
  regionCode: string;
  regionName: string;
  competitionName: string;
  pictureUrl: string | null;
  gameCount: number;
  lineupCount: number;
};

export type SorareInsideMatchSide = {
  teamName: string;
  teamSlug: string | null;
  lineupId: string | null;
  pictureUrl: string | null;
};

export type SorareInsideMatch = {
  gameId: string;
  leagueId: string;
  leagueLabel: string;
  date: string | null;
  home: SorareInsideMatchSide;
  away: SorareInsideMatchSide;
};

export type SorareInsideDiscoverRequest = {
  url: string;
  gwSlug: string;
};

export type SorareInsideExpandRequest = {
  leagues: Array<{ id: string; round: number }>;
};

export type SorareInsideCaptureRequest = {
  gameId: string;
  /** Which side's popup to open and save as `{tour}/{club}.png`. */
  side: "home" | "away";
  round: number;
  /** Optional override; defaults from discovered match. */
  teamName?: string;
  lineupId?: string;
};

export type SorareInsidePlayerGroup = "starting" | "bench" | "out";

export type SorareInsidePlayerProbability = {
  name: string;
  percentage: number | null;
  rawLabel: string | null;
  /** starting = pitch %, bench = default 10% when unlabeled, out = DNP */
  group?: SorareInsidePlayerGroup;
};

export function parseSorareInsideGwSlug(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("gwSlug must be a non-empty string.");
  }
  const slug = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) {
    throw new Error(`Invalid SorareInside gwSlug: ${slug}`);
  }
  return slug;
}

/**
 * Accepts a full lineups URL or a bare gwSlug.
 * Examples:
 * - https://sorareinside.com/lineups?gwSlug=football-28-aug-1-sep-2026
 * - football-28-aug-1-sep-2026
 */
export function parseSorareInsideLineupsUrl(value: unknown): SorareInsideDiscoverRequest {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Provide a SorareInside lineups URL or gwSlug.");
  }
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) {
    const gwSlug = parseSorareInsideGwSlug(raw);
    return {
      url: `${SORARE_INSIDE_ORIGIN}/lineups?gwSlug=${encodeURIComponent(gwSlug)}`,
      gwSlug,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid SorareInside URL.");
  }
  if (!/(^|\.)sorareinside\.com$/i.test(parsed.hostname)) {
    throw new Error("URL must be on sorareinside.com.");
  }
  const gwSlug = parseSorareInsideGwSlug(
    parsed.searchParams.get("gwSlug") || parsed.searchParams.get("gw"),
  );
  parsed.pathname = "/lineups";
  parsed.search = `?gwSlug=${encodeURIComponent(gwSlug)}`;
  parsed.hash = "";
  return { url: parsed.toString(), gwSlug };
}

export function parseSorareInsideDiscoverRequest(body: unknown): SorareInsideDiscoverRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }
  const raw = body as Record<string, unknown>;
  if (raw.url !== undefined) {
    return parseSorareInsideLineupsUrl(raw.url);
  }
  if (raw.gwSlug !== undefined) {
    return parseSorareInsideLineupsUrl(raw.gwSlug);
  }
  throw new Error('Provide "url" (lineups URL) or "gwSlug".');
}

export function parseSorareInsideExpandRequest(body: unknown): SorareInsideExpandRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.leagues) || raw.leagues.length === 0) {
    throw new Error("leagues must be a non-empty array of { id, round }.");
  }
  const leagues: SorareInsideExpandRequest["leagues"] = [];
  const seen = new Set<string>();
  for (const item of raw.leagues) {
    if (!item || typeof item !== "object") {
      throw new Error("Each league entry must be an object with id and round.");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim()) {
      throw new Error("Each league.id must be a non-empty string.");
    }
    const id = row.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const round = parseScreenshotTour(row.round);
    if (round == null) {
      throw new Error(`league ${id}: round is required (integer 1–99).`);
    }
    leagues.push({ id, round });
  }
  if (!leagues.length) {
    throw new Error("Provide at least one league with id and round.");
  }
  return { leagues };
}

export function parseSorareInsideCaptureRequest(body: unknown): SorareInsideCaptureRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.gameId !== "string" || !raw.gameId.trim()) {
    throw new Error("gameId must be a non-empty string.");
  }
  if (raw.side !== "home" && raw.side !== "away") {
    throw new Error('side must be "home" or "away".');
  }
  const round = parseScreenshotTour(raw.round);
  if (round == null) {
    throw new Error("round is required (integer 1–99).");
  }
  let teamName: string | undefined;
  if (raw.teamName !== undefined) {
    if (typeof raw.teamName !== "string" || !raw.teamName.trim()) {
      throw new Error("teamName must be a non-empty string when provided.");
    }
    teamName = raw.teamName.trim();
  }
  let lineupId: string | undefined;
  if (raw.lineupId !== undefined) {
    if (typeof raw.lineupId !== "string" || !raw.lineupId.trim()) {
      throw new Error("lineupId must be a non-empty string when provided.");
    }
    lineupId = raw.lineupId.trim();
  }
  return {
    gameId: raw.gameId.trim(),
    side: raw.side,
    round,
    teamName,
    lineupId,
  };
}

export function leagueLabel(regionName: string, competitionName: string): string {
  const region = regionName.trim();
  const competition = competitionName.trim();
  if (!region) return competition;
  if (!competition) return region;
  if (competition.toLowerCase().startsWith(region.toLowerCase())) return competition;
  return `${region} - ${competition}`;
}

/** Relative path under `data/sorare/output`, e.g. `3/millwall.png`. */
export function sorareTourClubScreenshotPath(tour: number, teamName: string): string {
  return `${tour}/${clubFileSlug(teamName)}.png`;
}

/** Green pitch only, e.g. `3/millwall-green.png`. */
export function sorareTourClubGreenScreenshotPath(
  tour: number,
  teamName: string,
): string {
  return `${tour}/${clubFileSlug(teamName)}-green.png`;
}

export type SorareCapturedClub = {
  clubSlug: string;
  png: boolean;
  green: boolean;
  json: boolean;
  /** Player rows in sidecar JSON, if present. */
  probabilities: number | null;
  capturedAt: string | null;
};

/** Scan `data/sorare/output/{round}/` for already-captured clubs. */
export function listSorareCapturedClubs(
  outputRootAbs: string,
  round: number,
): SorareCapturedClub[] {
  const dir = path.join(outputRootAbs, String(round));
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const bySlug = new Map<string, SorareCapturedClub>();
  const ensure = (slug: string) => {
    let row = bySlug.get(slug);
    if (!row) {
      row = {
        clubSlug: slug,
        png: false,
        green: false,
        json: false,
        probabilities: null,
        capturedAt: null,
      };
      bySlug.set(slug, row);
    }
    return row;
  };
  for (const name of names) {
    const green = name.match(/^(.+)-green\.png$/i);
    if (green) {
      ensure(green[1]!).green = true;
      continue;
    }
    const png = name.match(/^(.+)\.png$/i);
    if (png) {
      ensure(png[1]!).png = true;
      continue;
    }
    const json = name.match(/^(.+)\.json$/i);
    if (!json) continue;
    const row = ensure(json[1]!);
    row.json = true;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
        capturedAt?: string;
        probabilities?: unknown[];
      };
      row.capturedAt =
        typeof raw.capturedAt === "string" ? raw.capturedAt : null;
      row.probabilities = Array.isArray(raw.probabilities)
        ? raw.probabilities.length
        : null;
    } catch {
      /* ignore corrupt sidecar */
    }
  }
  return [...bySlug.values()].sort((a, b) =>
    a.clubSlug.localeCompare(b.clubSlug),
  );
}

export type RemainingSorareCaptureSide = {
  gameId: string;
  side: "home" | "away";
  teamName: string;
  lineupId: string;
  round: number;
};

/** png or json in the tour folder counts as collected (green-only does not). */
export function isSorareSideCapturedOnDisk(info: {
  json?: boolean;
  png?: boolean;
} | undefined): boolean {
  return Boolean(info?.json || info?.png);
}

/**
 * Home/Away sides that still need a capture. Skips missing lineups and clubs
 * that already have `{round}/{club}.png` or `.json`.
 */
export function remainingSorareCaptureSides(
  matches: SorareInsideMatch[],
  roundByLeagueId: ReadonlyMap<string, number>,
  capturedByRound: ReadonlyMap<
    number,
    Readonly<Record<string, { json?: boolean; png?: boolean }>>
  >,
): RemainingSorareCaptureSide[] {
  const remaining: RemainingSorareCaptureSide[] = [];
  for (const match of matches) {
    const round = roundByLeagueId.get(match.leagueId);
    if (!Number.isInteger(round) || (round as number) < 1) continue;
    const bySlug = capturedByRound.get(round as number) || {};
    for (const side of ["home", "away"] as const) {
      const team = match[side];
      if (!team.lineupId) continue;
      if (isSorareSideCapturedOnDisk(bySlug[clubFileSlug(team.teamName)])) {
        continue;
      }
      remaining.push({
        gameId: match.gameId,
        side,
        teamName: team.teamName,
        lineupId: team.lineupId,
        round: round as number,
      });
    }
  }
  return remaining;
}

export function isSorareInsideGamesApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)platform-api\.sorareinside\.com$/i.test(parsed.hostname) &&
      parsed.pathname.replace(/\/$/, "") === "/games"
    );
  } catch {
    return false;
  }
}

type RawTeam = {
  id?: string;
  name?: string;
  slug?: string;
  pictureUrl?: string | null;
  picture_url?: string | null;
};

type RawLineup = {
  id?: string | null;
};

type RawGame = {
  id?: string;
  date?: string | null;
  homeTeam?: RawTeam | null;
  awayTeam?: RawTeam | null;
  homeTeamLineup?: RawLineup | null;
  awayTeamLineup?: RawLineup | null;
};

type RawCompetition = {
  id?: string;
  name?: string;
  pictureUrl?: string | null;
  games?: RawGame[] | null;
};

type RawRegion = {
  regionCode?: string;
  regionName?: string;
  competitions?: RawCompetition[] | null;
};

function sideFrom(
  team: RawTeam | null | undefined,
  lineup: RawLineup | null | undefined,
): SorareInsideMatchSide {
  return {
    teamName: String(team?.name || "").trim() || "TBD",
    teamSlug: team?.slug ? String(team.slug) : null,
    lineupId: lineup?.id ? String(lineup.id) : null,
    pictureUrl: (team?.pictureUrl ?? team?.picture_url ?? null) as string | null,
  };
}

/** Normalize `/games` JSON (region → competition → games) into UI-friendly lists. */
export function parseSorareInsideGamesPayload(payload: unknown): {
  leagues: SorareInsideLeague[];
  matches: SorareInsideMatch[];
} {
  const root = payload as { data?: unknown } | unknown;
  const regions = Array.isArray(root)
    ? root
    : Array.isArray((root as { data?: unknown })?.data)
      ? ((root as { data: unknown[] }).data as unknown[])
      : [];

  const leagues: SorareInsideLeague[] = [];
  const matches: SorareInsideMatch[] = [];

  for (const regionRaw of regions) {
    if (!regionRaw || typeof regionRaw !== "object") continue;
    const region = regionRaw as RawRegion;
    const regionCode = String(region.regionCode || "").trim() || "unknown";
    const regionName = String(region.regionName || "").trim() || regionCode;
    const competitions = Array.isArray(region.competitions) ? region.competitions : [];
    for (const competition of competitions) {
      if (!competition || typeof competition !== "object") continue;
      const competitionId = String(competition.id || "").trim();
      const competitionName = String(competition.name || "").trim();
      if (!competitionId || !competitionName) continue;
      const games = Array.isArray(competition.games) ? competition.games : [];
      let lineupCount = 0;
      const label = leagueLabel(regionName, competitionName);
      for (const game of games) {
        if (!game || typeof game !== "object" || !game.id) continue;
        const home = sideFrom(game.homeTeam, game.homeTeamLineup);
        const away = sideFrom(game.awayTeam, game.awayTeamLineup);
        if (home.lineupId) lineupCount += 1;
        if (away.lineupId) lineupCount += 1;
        matches.push({
          gameId: String(game.id),
          leagueId: competitionId,
          leagueLabel: label,
          date: game.date ? String(game.date) : null,
          home,
          away,
        });
      }
      leagues.push({
        id: competitionId,
        label,
        regionCode,
        regionName,
        competitionName,
        pictureUrl: competition.pictureUrl ?? null,
        gameCount: games.length,
        lineupCount,
      });
    }
  }

  leagues.sort((a, b) => a.label.localeCompare(b.label));
  return { leagues, matches };
}

const SECTION_HEADER_RE =
  /^(starting(?:\s*xi)?|bench(?:\s*players)?|dnp(?:\s*players)?|out|reliability|high|medium|low|key|comments|updates|conversation|team analysis|injuries|potential factors|starting\s*%\s*key)\b/i;

function looksLikePlayerName(name: string): boolean {
  const t = name.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (SECTION_HEADER_RE.test(t)) return false;
  if (/^\d{1,3}\s*%$/.test(t)) return false;
  if (/^https?:/i.test(t)) return false;
  // Prefer names with a letter (allow accents).
  return /[A-Za-zÀ-ÿ]/.test(t);
}

/** Best-effort parse of visible player % labels inside a lineup modal. */
export function parseProbabilitiesFromModalText(text: string): SorareInsidePlayerProbability[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: SorareInsidePlayerProbability[] = [];
  const seen = new Set<string>();
  const push = (
    name: string,
    percentage: number,
    rawLabel: string,
    group: SorareInsidePlayerGroup = "starting",
  ) => {
    if (!name || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return;
    if (!looksLikePlayerName(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, percentage, rawLabel, group });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sameLine = line.match(
      /^(.{2,60}?)\s+(\d{1,3})\s*%(?:\s*(?:chance of starting|start(?:ing)?)?)?$/i,
    );
    if (sameLine) {
      push(sameLine[1].trim(), Number(sameLine[2]), line);
      continue;
    }
    // SorareInside often renders name and "75%" on adjacent lines.
    const pctOnly = line.match(/^(\d{1,3})\s*%$/);
    if (pctOnly && i > 0) {
      const prev = lines[i - 1]!;
      if (looksLikePlayerName(prev) && !/\d\s*%/.test(prev)) {
        push(prev, Number(pctOnly[1]), `${prev} ${line}`);
      }
    }
  }
  return out;
}

/**
 * Parse Bench / DNP list blocks.
 * - Bench without an explicit % → 10%
 * - DNP → out (percentage null, rawLabel "out")
 */
export function parseBenchAndDnpPlayerLists(text: string): SorareInsidePlayerProbability[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  type Mode = "none" | "bench" | "dnp";
  let mode: Mode = "none";
  const out: SorareInsidePlayerProbability[] = [];
  const seen = new Set<string>();

  const push = (row: SorareInsidePlayerProbability) => {
    const key = row.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^bench\s*players?$/i.test(line) || /^bench$/i.test(line)) {
      mode = "bench";
      continue;
    }
    if (/^dnp\s*players?$/i.test(line) || /^dnp$/i.test(line)) {
      mode = "dnp";
      continue;
    }
    if (
      /^(comments|updates|conversation|starting\s*%\s*key|team analysis|injuries)/i.test(
        line,
      )
    ) {
      mode = "none";
      continue;
    }
    if (mode === "none" || !looksLikePlayerName(line)) continue;

    const sameLine = line.match(/^(.{2,60}?)\s+(\d{1,3})\s*%$/);
    if (sameLine && mode === "bench") {
      push({
        name: sameLine[1].trim(),
        percentage: Number(sameLine[2]),
        rawLabel: line,
        group: "bench",
      });
      continue;
    }
    const pctOnly = lines[i + 1]?.match(/^(\d{1,3})\s*%$/);
    if (mode === "bench" && pctOnly) {
      push({
        name: line,
        percentage: Number(pctOnly[1]),
        rawLabel: `${line} ${pctOnly[0]}`,
        group: "bench",
      });
      i += 1;
      continue;
    }
    if (mode === "bench") {
      push({
        name: line,
        percentage: 10,
        rawLabel: "10%",
        group: "bench",
      });
      continue;
    }
    if (mode === "dnp") {
      push({
        name: line,
        percentage: null,
        rawLabel: "out",
        group: "out",
      });
    }
  }
  return out;
}

/** Merge pitch % with bench (10%) and DNP (out); pitch names win. */
export function mergeSorareInsideProbabilities(
  starting: SorareInsidePlayerProbability[],
  benchAndDnp: SorareInsidePlayerProbability[],
): SorareInsidePlayerProbability[] {
  const seen = new Set(
    starting.map((p) => p.name.toLowerCase()).filter(Boolean),
  );
  const out: SorareInsidePlayerProbability[] = starting.map((p) => ({
    ...p,
    group: p.group ?? "starting",
  }));
  for (const row of benchAndDnp) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
