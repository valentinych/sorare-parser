/**
 * Authenticated MantraFootball session (Devise form login).
 * Uses shared rateLimit4perSec (≤4 req/s). Credentials from env — never log them.
 */
import { mantraFetchWithRetry } from "./mantraRequest.js";

const ORIGIN = "https://mantrafootball.org";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type CookieMap = Map<string, string>;

let cookies: CookieMap = new Map();
let loggedIn = false;
let loginChain: Promise<void> | null = null;

function cookieHeader(): string {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeSetCookie(res: Response): void {
  // Node fetch: getSetCookie() when available
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : (() => {
          const single = res.headers.get("set-cookie");
          return single ? [single] : [];
        })();
  for (const raw of rawList) {
    const part = raw.split(";")[0] ?? "";
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    if (/^(Max-Age|Expires|Path|Domain|Secure|HttpOnly|SameSite)$/i.test(name)) continue;
    cookies.set(name, value);
  }
}

async function mantraFetch(
  pathOrUrl: string,
  init: RequestInit = {},
  redirectDepth = 0,
): Promise<Response> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : ORIGIN + pathOrUrl;
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", UA);
  const jar = cookieHeader();
  if (jar) headers.set("Cookie", jar);
  const res = await mantraFetchWithRetry(url, {
    ...init,
    headers,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  storeSetCookie(res);
  return finishMantraRedirect(res, init, headers, redirectDepth);
}

const MAX_MANTRA_REDIRECTS = 8;

async function finishMantraRedirect(
  res: Response,
  init: RequestInit,
  headers: Headers,
  depth: number,
): Promise<Response> {
  // Follow redirects manually to keep cookies
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (depth >= MAX_MANTRA_REDIRECTS) {
      throw new Error(`Mantra redirect limit (${MAX_MANTRA_REDIRECTS}) exceeded`);
    }
    const loc = res.headers.get("location");
    if (loc) {
      const next = loc.startsWith("http") ? loc : ORIGIN + loc;
      // POST → GET on 302/303
      const method =
        res.status === 303 || (res.status === 302 && (init.method ?? "GET").toUpperCase() === "POST")
          ? "GET"
          : (init.method ?? "GET");
      return mantraFetch(
        next,
        { method, headers: { Accept: headers.get("Accept") ?? "*/*" } },
        depth + 1,
      );
    }
  }
  return res;
}

function extractAuthenticityToken(html: string): string {
  const m =
    html.match(/name="authenticity_token"\s+value="([^"]+)"/) ||
    html.match(/name="csrf-token"\s+content="([^"]+)"/);
  if (!m) throw new Error("Mantra login: CSRF token not found");
  return m[1]!;
}

export function mantraCredentialsConfigured(): boolean {
  return Boolean(process.env.MANTRA_EMAIL?.trim() && process.env.MANTRA_PASSWORD?.trim());
}

export async function mantraLogin(force = false): Promise<void> {
  if (loggedIn && !force) return;
  if (loginChain) return loginChain;
  loginChain = (async () => {
    const email = process.env.MANTRA_EMAIL?.trim();
    const password = process.env.MANTRA_PASSWORD?.trim();
    if (!email || !password) {
      throw new Error("Set MANTRA_EMAIL and MANTRA_PASSWORD in .env");
    }
    cookies = new Map();
    loggedIn = false;

    const signInPage = await mantraFetch("/users/sign_in", {
      method: "GET",
      headers: { Accept: "text/html" },
    });
    if (!signInPage.ok) throw new Error(`Mantra sign_in page → ${signInPage.status}`);
    const html = await signInPage.text();
    const token = extractAuthenticityToken(html);

    const body = new URLSearchParams({
      authenticity_token: token,
      "user[email]": email,
      "user[password]": password,
      "user[remember_me]": "1",
      commit: "Login",
    });

    const res = await mantraFetch("/users/sign_in", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        Referer: `${ORIGIN}/users/sign_in`,
        Origin: ORIGIN,
      },
      body,
    });

    const hasSession =
      cookies.has("remember_user_token") || cookies.has("_fanta_session");
    const landedOk = res.ok || res.url?.includes("/leagues") || res.status === 200;
    // After redirects, final page should not be sign_in
    const finalHtml = await res.text();
    if (finalHtml.includes('id="new_user"') && finalHtml.includes("user[password]")) {
      throw new Error("Mantra login failed — check MANTRA_EMAIL / MANTRA_PASSWORD");
    }
    if (!hasSession && !landedOk) {
      throw new Error(`Mantra login failed → HTTP ${res.status}`);
    }
    loggedIn = true;
    console.log("Mantra: signed in");
  })().finally(() => {
    loginChain = null;
  });
  return loginChain;
}

export async function mantraAuthedGet(path: string): Promise<string> {
  const res = await mantraAuthedGetResponse(path, "text/html,application/xhtml+xml");
  return res.text();
}

/** Signed-in HTML of `/managers/{id}` — same page as mantrafootball.org/managers/205. */
export async function fetchMantraManagerHtml(userId: number): Promise<string> {
  return mantraAuthedGet(`/managers/${userId}`);
}

async function mantraAuthedGetResponse(path: string, accept: string): Promise<Response> {
  await mantraLogin();
  const res = await mantraFetch(path, {
    method: "GET",
    headers: { Accept: accept },
  });
  if (res.status === 401 || res.url?.includes("/users/sign_in")) {
    loggedIn = false;
    await mantraLogin(true);
    const retry = await mantraFetch(path, {
      method: "GET",
      headers: { Accept: accept },
    });
    if (!retry.ok) throw new Error(`Mantra ${path} → ${retry.status}`);
    return retry;
  }
  if (!res.ok) throw new Error(`Mantra ${path} → ${res.status}`);
  return res;
}

export async function mantraAuthedJson<T>(path: string): Promise<T> {
  const res = await mantraAuthedGetResponse(path, "application/json");
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`Mantra ${path} did not return JSON`);
  }
  return (await res.json()) as T;
}

export type MantraMatchSlot = {
  slot: string | null;
  positions: string[];
  playerName: string;
  /** Filled when enriching from mantra_players / squad. */
  playerId?: number | null;
  nativePositions?: string[];
  clubName?: string | null;
};

export type MantraMatchSquadPlayer = {
  playerId: number | null;
  name: string;
  positions: string[];
  /** Posted GW total (base + bonuses). Preferred over `baseLabel`. */
  scoreLabel: string | null;
  /** Mantra `team-player-score` (rating before bonuses). Used for DP. */
  baseLabel?: string | null;
  nativePositions?: string[];
  clubName?: string | null;
};

export type MantraMatchSide = {
  teamId: number | null;
  teamName: string;
  module: string | null;
  defenseBonus: number | null;
  fantasyScore: number | null;
  goals: number | null;
  scoredCount: number | null;
  lineup: MantraMatchSlot[];
  /** Starting XI from the squad list (same 11 as lineup). */
  squad: MantraMatchSquadPlayer[];
  substitutes: MantraMatchSquadPlayer[];
  notInSquad: MantraMatchSquadPlayer[];
};

export type MantraMatch = {
  id: number;
  url: string;
  home: MantraMatchSide;
  away: MantraMatchSide;
};

function sectionBetween(html: string, startMarker: string, endMarkers: string[]): string {
  const start = html.indexOf(startMarker);
  if (start < 0) return "";
  let end = html.length;
  for (const m of endMarkers) {
    const i = html.indexOf(m, start + startMarker.length);
    if (i >= 0 && i < end) end = i;
  }
  return html.slice(start, end);
}

function parseLineupBlock(block: string): MantraMatchSlot[] {
  // Only top-level pitch slots: "match-module-item slot-XX" (not -pos / -player wrappers).
  const items = [
    ...block.matchAll(
      /<div class="match-module-item (slot-[a-z0-9]+)">([\s\S]*?)(?=<div class="match-module-item slot-|$)/gi,
    ),
  ];
  const out: MantraMatchSlot[] = [];
  for (const m of items) {
    const slot = m[1] ?? null;
    const body = m[2] ?? "";
    const positions = [...body.matchAll(/class="player-position[^"]*">\s*([^<]+)/g)]
      .map((x) => x[1]!.trim())
      .filter(Boolean);
    const nameM = body.match(/match-module-item-player">\s*([^<]+)/);
    const playerName = nameM?.[1]?.trim() ?? "";
    if (!playerName) continue;
    out.push({ slot, positions, playerName });
  }
  return out;
}

function parseSquadBlock(block: string): MantraMatchSquadPlayer[] {
  const items = [...block.matchAll(/<div class="match-player-item">([\s\S]*?)(?=<div class="match-player-item">|$)/g)];
  const out: MantraMatchSquadPlayer[] = [];
  for (const m of items) {
    const body = m[1] ?? "";
    const idM = body.match(/href="\/players\/(\d+)"/);
    const nameM = body.match(/team-player-name">\s*([^<]+)/);
    const name = nameM?.[1]?.trim() ?? "";
    if (!name) continue;
    const positions = [...body.matchAll(/class="player-position[^"]*">\s*([^<]+)/g)]
      .map((x) => x[1]!.trim())
      .filter(Boolean);
    // Prefer total (base + bonuses). `team-player-score*` also matches the
    // club-name chip `team-player-score-unspecified` ("Veres") — skip that.
    const totalM = body.match(/class="team-player-total-score">\s*([^<]+)/);
    const baseM = body.match(/class="team-player-score">\s*([^<]+)/);
    const totalLabel = (totalM?.[1] ?? "").trim() || null;
    const baseLabel = (baseM?.[1] ?? "").trim() || null;
    const scoreLabel = totalLabel ?? baseLabel;
    out.push({
      playerId: idM ? Number(idM[1]) : null,
      name,
      positions,
      scoreLabel,
      baseLabel,
    });
  }
  return out;
}

function parseSideMeta(
  html: string,
  side: "host" | "guest",
): Pick<
  MantraMatchSide,
  "teamId" | "teamName" | "fantasyScore" | "goals" | "scoredCount"
> {
  // Host block then guest block around match-result
  const hostBlock = sectionBetween(html, 'class="match-host"', ['class="match-result"', 'class="match-guest"']);
  const guestBlock = sectionBetween(html, 'class="match-guest"', ['class="match-actions"', 'class="match-lineups"', 'class="match-squads"']);
  const block = side === "host" ? hostBlock : guestBlock;
  const teamM = block.match(/href="\/teams\/(\d+)"[\s\S]*?match-team-name">\s*([^<]+)/);
  const result = sectionBetween(html, 'class="match-result"', ['class="match-guest"', 'class="match-actions"']);
  let fantasyScore: number | null = null;
  let goals: number | null = null;
  let scoredCount: number | null = null;
  if (side === "host") {
    const scores = [...result.matchAll(/round-match-score">\s*([\d.]+)/g)].map((x) => Number(x[1]));
    fantasyScore = scores[0] ?? null;
    const g = result.match(/round-match-host-goals">\s*(\d+)/);
    goals = g ? Number(g[1]) : null;
    const c = result.match(/round-match-scores-host-count[\s\S]*?round-match-scores-count">\s*(\d+)/);
    scoredCount = c ? Number(c[1]) : null;
  } else {
    const scores = [...result.matchAll(/round-match-score">\s*([\d.]+)/g)].map((x) => Number(x[1]));
    fantasyScore = scores[1] ?? null;
    const g = result.match(/round-match-guest-goals">\s*(\d+)/);
    goals = g ? Number(g[1]) : null;
    const c = result.match(/round-match-scores-guest-count[\s\S]*?round-match-scores-count">\s*(\d+)/);
    scoredCount = c ? Number(c[1]) : null;
  }
  return {
    teamId: teamM ? Number(teamM[1]) : null,
    teamName: teamM?.[2]?.trim() ?? (side === "host" ? "Home" : "Away"),
    fantasyScore,
    goals,
    scoredCount,
  };
}

function parseTeamSquadSection(block: string): {
  module: string | null;
  defenseBonus: number | null;
  squad: MantraMatchSquadPlayer[];
  substitutes: MantraMatchSquadPlayer[];
  notInSquad: MantraMatchSquadPlayer[];
} {
  const moduleM = block.match(/♟️ Module:[\s\S]*?match-team-data-value">\s*([^<]+)/);
  const defM = block.match(/Defense Bonus:[\s\S]*?match-team-data-value">\s*([^<]+)/);

  const main = sectionBetween(block, 'class="match-main-squad"', [
    'class="match-reserve"',
    'class="match-team-squad"',
  ]);
  const reserveBlocks = [...block.matchAll(/<div class="match-reserve">([\s\S]*?)(?=<div class="match-reserve">|$)/g)];
  let substitutes: MantraMatchSquadPlayer[] = [];
  let notInSquad: MantraMatchSquadPlayer[] = [];
  for (const rb of reserveBlocks) {
    const body = rb[1] ?? "";
    const title = body.match(/match-reserve-title">\s*([^<]+)/)?.[1]?.trim() ?? "";
    const players = parseSquadBlock(body);
    if (/not in squad/i.test(title)) notInSquad = players;
    else if (/substitut/i.test(title)) substitutes = players;
  }

  return {
    module: moduleM?.[1]?.trim() ?? null,
    defenseBonus: defM && Number.isFinite(Number(defM[1])) ? Number(defM[1]) : null,
    squad: parseSquadBlock(main || block),
    substitutes,
    notInSquad,
  };
}

export function parseMantraMatchHtml(matchId: number, html: string): MantraMatch {
  if (html.includes('id="new_user"') && html.includes("user[password]")) {
    throw new Error("Mantra match page requires login");
  }
  const homeMeta = parseSideMeta(html, "host");
  const awayMeta = parseSideMeta(html, "guest");

  const homeLineupHtml = sectionBetween(
    html,
    'match-module-lineup match-module-home"',
    [
      'match-module-lineup match-module-away"',
      'class="match-team-squad"',
      'class="match-team-name"',
    ],
  );
  const awayLineupHtml = sectionBetween(
    html,
    'match-module-lineup match-module-away"',
    ['class="match-team-squad"', 'class="match-team-name"'],
  );

  const squadParts = html.split(/<div class="match-team-squad">/).slice(1);
  const homeSquad = parseTeamSquadSection(squadParts[0] ?? "");
  const awaySquad = parseTeamSquadSection(squadParts[1] ?? "");

  return {
    id: matchId,
    url: `${ORIGIN}/matches/${matchId}`,
    home: {
      ...homeMeta,
      module: homeSquad.module,
      defenseBonus: homeSquad.defenseBonus,
      lineup: parseLineupBlock(homeLineupHtml),
      squad: homeSquad.squad,
      substitutes: homeSquad.substitutes,
      notInSquad: homeSquad.notInSquad,
    },
    away: {
      ...awayMeta,
      module: awaySquad.module,
      defenseBonus: awaySquad.defenseBonus,
      lineup: parseLineupBlock(awayLineupHtml),
      squad: awaySquad.squad,
      substitutes: awaySquad.substitutes,
      notInSquad: awaySquad.notInSquad,
    },
  };
}

export async function fetchMantraMatch(matchId: number): Promise<MantraMatch> {
  const html = await mantraAuthedGet(`/matches/${matchId}`);
  return parseMantraMatchHtml(matchId, html);
}

/** Match ids linked from a league tour page (e.g. /tours/17746). */
export async function fetchTourMatchIds(tourId: number): Promise<number[]> {
  const html = await mantraAuthedGet(`/tours/${tourId}`);
  const ids = [...html.matchAll(/href="\/matches\/(\d+)"/g)].map((m) => Number(m[1]));
  return [...new Set(ids.filter((n) => Number.isFinite(n)))];
}

import type { MantraDivisionDef } from "../lib/liveLeagues.js";
import {
  LIVE_LEAGUES,
  shouldAutoOpenNextTour,
  tourHasActiveDeadline,
} from "../lib/liveLeagues.js";

/** @deprecated use LIVE_LEAGUES.ekstraklasa.mantraDivisions */
export const POLAND_MANTRA_TOURS = LIVE_LEAGUES.ekstraklasa!.mantraDivisions.map((d) => ({
  tourId: d.tourId ?? 0,
  leagueId: d.leagueId,
  division: d.division,
  name: d.name,
}));

/** Resolve the live tour page id from a league page (Round nav link). */
export async function resolveLeagueTourId(
  leagueId: number,
  fallbackTourId?: number,
): Promise<number> {
  const html = await mantraAuthedGet(`/leagues/${leagueId}`);
  const fromRoundNav =
    numOrNull(
      html.match(
        /<a href="\/tours\/(\d+)"><div class="league-link[^"]*">[\s\S]{0,400}?Round<\/div>/i,
      )?.[1],
    ) ??
    numOrNull(
      html.match(/<div class="league-links">[\s\S]*?<a href="\/tours\/(\d+)">/i)?.[1],
    );
  if (fromRoundNav != null) return fromRoundNav;
  if (fallbackTourId != null) return fallbackTourId;
  throw new Error(`Could not resolve Mantra tour id for league ${leagueId}`);
}

export type MantraTourMatchSide = {
  teamId: number | null;
  teamName: string;
  logoUrl: string | null;
  /** Fantasy points (realtime). */
  score: number | null;
  /** Players with a score so far. */
  scoredCount: number | null;
  goals: number | null;
};

export type MantraTourMatch = {
  /** Null when Mantra published the pair but has not created /matches/:id yet. */
  matchId: number | null;
  url: string | null;
  locked: boolean;
  home: MantraTourMatchSide;
  away: MantraTourMatchSide;
};

export type MantraTourRound = {
  tourId: number;
  leagueId: number | null;
  division: string | null;
  name: string | null;
  label: string;
  round: number | null;
  live: boolean;
  url: string;
  matches: MantraTourMatch[];
  /** Lineup lock instant (ISO), when Mantra printed a deadline. */
  deadline: string | null;
  /** Raw Mantra deadline label, e.g. "Fri, Aug 28 at 19:15". */
  deadlineLabel: string | null;
  syncedAt: string;
};

function numOrNull(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** Wall time in Europe/Rome → ISO. Mantra prints "Fri, Aug 28 at 19:15". */
export function parseMantraDeadlineLabel(
  raw: string,
  now = new Date(),
): string | null {
  const m = raw.match(
    /\b([A-Za-z]{3}),\s+([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\b/,
  );
  if (!m) return null;
  const month = MONTH_INDEX[m[2]!];
  if (!month) return null;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  if (![day, hour, min].every((n) => Number.isFinite(n))) return null;
  const year = now.getUTCFullYear();
  const iso = isoFromEuropeRome(year, month, day, hour, min);
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isFinite(t) && t < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
    const next = isoFromEuropeRome(year + 1, month, day, hour, min);
    if (next) return next;
  }
  return iso;
}

function isoFromEuropeRome(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
): string | null {
  const utcAsWall = Date.UTC(year, month - 1, day, hour, min);
  if (!Number.isFinite(utcAsWall)) return null;
  const shown = new Date(utcAsWall).toLocaleString("sv-SE", { timeZone: "Europe/Rome" });
  const shownUtc = Date.parse(shown.replace(" ", "T") + "Z");
  if (!Number.isFinite(shownUtc)) return null;
  return new Date(utcAsWall - (shownUtc - utcAsWall)).toISOString();
}

function parseTourDeadline(html: string): { iso: string | null; label: string | null } {
  const label =
    html.match(/round-deadline-value">\s*([^<]+)/)?.[1]?.trim() ||
    html.match(/Deadline:\s*<\/div>\s*<div[^>]*>\s*([^<]+)/i)?.[1]?.trim() ||
    null;
  if (!label) return { iso: null, label: null };
  return { iso: parseMantraDeadlineLabel(label), label };
}

function parseTourSide(
  block: string,
  which: "host" | "guest",
): MantraTourMatchSide {
  const teamRe =
    which === "host"
      ? /round-match-host[\s\S]*?href="\/teams\/(\d+)"([\s\S]*?)(?=round-match-score|round-match-result|$)/
      : /round-match-guest[\s\S]*?href="\/teams\/(\d+)"([\s\S]*?)(?=$)/;
  const teamM = block.match(teamRe);
  const teamId = teamM ? Number(teamM[1]) : null;
  const teamChunk = teamM?.[2] ?? "";
  const teamName =
    teamChunk.match(/results-team-name">\s*([^<]+)/)?.[1]?.trim() ??
    (which === "host" ? "Home" : "Away");
  const logoUrl = teamChunk.match(/<img src="([^"]+)"/)?.[1] ?? null;

  const scoreRe =
    which === "host"
      ? /round-match-host-score">([\s\S]*?)(?=<div class="round-match-result"|$)/
      : /round-match-guest-score">([\s\S]*?)(?=<div class="round-match-team round-match-guest"|$)/;
  const scoreChunk = block.match(scoreRe)?.[1] ?? "";
  const score = numOrNull(scoreChunk.match(/round-match-total-score">\s*([^<]*)/)?.[1]);
  const scoredCount = numOrNull(scoreChunk.match(/round-match-scores-count">\s*([^<]*)/)?.[1]);
  const goals = numOrNull(
    block.match(
      which === "host"
        ? /round-match-host-goals">\s*([^<]*)/
        : /round-match-guest-goals">\s*([^<]*)/,
    )?.[1],
  );

  return { teamId, teamName, logoUrl, score, scoredCount, goals };
}

export function parseMantraTourHtml(
  tourId: number,
  html: string,
  meta?: { leagueId?: number; division?: string; name?: string },
): MantraTourRound {
  if (html.includes('id="new_user"') && html.includes("user[password]")) {
    throw new Error("Mantra tour page requires login");
  }
  const label =
    html.match(/league-name-text">\s*([^<]+)/)?.[1]?.trim() ||
    (meta?.division && meta?.name ? `${meta.division} | ${meta.name}` : `Tour ${tourId}`);
  const round =
    numOrNull(html.match(/round-title-number">\s*([^<]+)/)?.[1]) ??
    numOrNull(html.match(/ROUND #(\d+)/)?.[1]);
  const live = /live-badge|live-text">\s*LIVE/i.test(html);

  const items = [
    ...html.matchAll(
      /<div class="round-match-item(?![^"]*mob-)([^"]*)">([\s\S]*?)(?=<div class="round-match-item|<div class="match-lineups"|<script|$)/g,
    ),
  ];
  const matches: MantraTourMatch[] = [];
  const seen = new Set<string>();
  for (const m of items) {
    const cls = m[1] ?? "";
    if (cls.includes("mob-")) continue;
    const body = m[2] ?? "";
    const home = parseTourSide(body, "host");
    const away = parseTourSide(body, "guest");
    // Pairs are published before /matches/:id exists — keep them with null matchId.
    const matchId = numOrNull(body.match(/href="\/matches\/(\d+)"/)?.[1]);
    if (home.teamId == null && away.teamId == null && matchId == null) continue;
    const key =
      matchId != null
        ? `m:${matchId}`
        : `t:${home.teamId ?? "?"}-${away.teamId ?? "?"}-${home.teamName}-${away.teamName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      matchId,
      url: matchId != null ? `${ORIGIN}/matches/${matchId}` : null,
      // class is often "round-match-unlocked" — don't treat that as locked.
      locked: /\blocked\b/.test(cls) && !/\bunlocked\b/.test(cls),
      home,
      away,
    });
  }

  const leagueIdFromLink = numOrNull(html.match(/href="\/leagues\/(\d+)\/results"/)?.[1]);
  const deadline = parseTourDeadline(html);

  return {
    tourId,
    leagueId: meta?.leagueId ?? leagueIdFromLink,
    division: meta?.division ?? label.split("|")[0]?.trim() ?? null,
    name: meta?.name ?? label.split("|")[1]?.trim() ?? null,
    label,
    round,
    live,
    url: `${ORIGIN}/tours/${tourId}`,
    matches,
    deadline: deadline.iso,
    deadlineLabel: deadline.label,
    syncedAt: new Date().toISOString(),
  };
}

export async function fetchMantraTour(
  tourId: number,
  meta?: { leagueId?: number; division?: string; name?: string },
): Promise<MantraTourRound> {
  const html = await mantraAuthedGet(`/tours/${tourId}`);
  return parseMantraTourHtml(tourId, html, meta);
}

async function fetchDivisionTour(
  division: MantraDivisionDef,
  tourId: number,
): Promise<MantraTourRound> {
  return fetchMantraTour(tourId, {
    leagueId: division.leagueId,
    division: division.division,
    name: division.name,
  });
}

/**
 * If Round nav still points at the finished tour, probe tourId+1 (one extra
 * request). Auto-open when the next tour is locked, has a lineup deadline,
 * OR FotMob's first match of that round has already kicked off — do not wait
 * for a global "open tour".
 */
async function maybeAutoOpenLockedNextTour(
  current: MantraTourRound[],
  divisions: MantraDivisionDef[],
  kickedOffRound?: (round: number) => boolean,
): Promise<MantraTourRound[]> {
  if (!current.length || current.length !== divisions.length) return current;
  const probeFrom = current[0]!;
  const probeDivision = divisions[0]!;
  const nextId = probeFrom.tourId + 1;
  let probe: MantraTourRound;
  try {
    probe = await fetchDivisionTour(probeDivision, nextId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/→ 404\b/.test(msg)) {
      console.warn(`Mantra next-tour probe ${nextId} failed:`, msg);
    }
    return current;
  }
  const currentRound = current.find((t) => t.round != null)?.round ?? null;
  const locked = probe.matches.some((m) => m.locked);
  const kickedOff =
    probe.round != null && kickedOffRound ? kickedOffRound(probe.round) : false;
  const hasDeadline = tourHasActiveDeadline(probe);
  if (
    !shouldAutoOpenNextTour(currentRound, {
      round: probe.round,
      locked,
      kickedOff,
      hasDeadline,
    })
  ) {
    return current;
  }
  console.log(
    `Mantra ${probe.division || probeDivision.division}: tour ${nextId} round ${probe.round} ${
      locked ? "locked" : hasDeadline ? "deadline" : "kicked off"
    } — auto-open`,
  );
  const nextTours: MantraTourRound[] = [probe];
  for (let i = 1; i < current.length; i++) {
    const division = divisions[i]!;
    const cur = current[i]!;
    try {
      const next = await fetchDivisionTour(division, cur.tourId + 1);
      if (next.round !== probe.round) {
        console.warn(
          `Mantra ${division.division} next tour round ${next.round} != ${probe.round}; skip auto-open`,
        );
        return current;
      }
      nextTours.push(next);
    } catch (err) {
      console.warn(
        `Mantra ${division.division} next tour ${cur.tourId + 1} not ready:`,
        err instanceof Error ? err.message : err,
      );
      return current;
    }
  }
  return nextTours;
}

/** Fetch current tour pages for a set of Mantra fantasy divisions. */
export async function fetchMantraToursForDivisions(
  divisions: MantraDivisionDef[],
  opts?: { kickedOffRound?: (round: number) => boolean },
): Promise<MantraTourRound[]> {
  const out: MantraTourRound[] = [];
  for (const t of divisions) {
    const tourId = await resolveLeagueTourId(t.leagueId, t.tourId);
    if (t.tourId != null && tourId !== t.tourId) {
      console.log(
        `Mantra ${t.division}: resolved tour ${tourId} (fallback was ${t.tourId})`,
      );
    }
    out.push(await fetchDivisionTour(t, tourId));
  }
  return maybeAutoOpenLockedNextTour(out, divisions, opts?.kickedOffRound);
}

/** @deprecated use fetchMantraToursForDivisions(LIVE_LEAGUES.ekstraklasa.mantraDivisions) */
export async function fetchPolandMantraTours(): Promise<MantraTourRound[]> {
  return fetchMantraToursForDivisions(LIVE_LEAGUES.ekstraklasa!.mantraDivisions);
}
