/**
 * Thin client for Transfermarkt private API (pet use).
 * Responses are cached in SQLite (`api_cache`) unless forceRefresh=true.
 * Network calls go through tmEnqueue (≤4/s, ≤100/min, jittered).
 */

import { getCachedJson, setCachedJson } from "../lib/apiCache.js";
import { tmEnqueue } from "../lib/tmQueue.js";

const BASE = "https://tmapi-alpha.transfermarkt.technology";

export type TmFetchOpts = {
  /** Bypass DB cache and overwrite with a fresh API response. */
  forceRefresh?: boolean;
};

function cacheKey(path: string): string {
  return `tm:${path}`;
}

function playerCacheKey(id: string): string {
  return `tm:/player/${id}`;
}

async function fetchNetworkJson(path: string): Promise<unknown | null> {
  return tmEnqueue(async () => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9,pl;q=0.8",
          Referer: "https://www.transfermarkt.com/",
        },
      });
      if (!res.ok) return null;
      const raw = await res.text();
      const clean = [...raw]
        .map((ch) => ((ch.codePointAt(0) ?? 0) >= 32 || "\n\r\t".includes(ch) ? ch : " "))
        .join("");
      return JSON.parse(clean);
    } catch {
      return null;
    }
  });
}

async function getJson<T>(path: string, opts: TmFetchOpts = {}): Promise<T | null> {
  const key = cacheKey(path);
  if (!opts.forceRefresh) {
    const cached = getCachedJson<T>(key);
    if (cached != null) return cached;
  }

  const parsed = (await fetchNetworkJson(path)) as T | null;
  if (parsed != null) setCachedJson(key, parsed);
  return parsed;
}

export type TmClub = {
  success: boolean;
  data?: TmClubData;
};

export type TmClubData = {
  id: string;
  name: string;
  relativeUrl?: string;
  crestUrl?: string;
  baseDetails?: {
    shortName?: string;
    abbreviation?: string;
    countryId?: number;
    primaryCompetitionId?: string;
    superiorClub?: {
      location?: {
        city?: string;
        street?: string;
        postcode?: string;
        latitude?: number;
        longitude?: number;
      };
      colors?: {
        firstColor?: string;
        secondColor?: string;
        thirdColor?: string;
      };
    };
  };
  squadDetails?: {
    squadSize?: number;
    averageAge?: number;
    averageMarketValue?: { value?: number; currency?: string };
    acquisitionValue?: { value?: number; currency?: string };
    top18PlayersMarketValue?: { value?: number; currency?: string };
    currentMarketValue?: { value?: number; currency?: string };
  };
};

export type TmCompetitionData = {
  id: string;
  name: string;
  shortName?: string;
  currentSeasonId?: number;
  totalMarketValue?: { value?: number; currency?: string };
  relativeUrl?: string;
  logoUrl?: string;
  baseDetails?: {
    shortName?: string;
    standardGameDurationMinutes?: number;
    gameDayCount?: number;
    closestGameDay?: number;
    isOngoing?: boolean;
  };
  originDetails?: { countryId?: number; confederationId?: number };
};

export type TmTableClub = {
  clubId: string;
  game?: {
    points?: number;
    winCount?: number;
    lossCount?: number;
    drawCount?: number;
    totalCount?: number;
  };
  goal?: {
    totalCount?: number;
    concededCount?: number;
    differenceCount?: number;
  };
  ranking?: {
    current?: number;
    previous?: number;
    shift?: string;
  };
};

export type TmSquad = {
  success: boolean;
  data?: {
    clubId: string;
    playerIds: string[];
    squad?: Array<{
      playerId: string;
      clubId: string;
      shirtNumber: number | null;
      isCaptain: boolean;
      type: string;
    }>;
    localCount?: number;
    foreignCount?: number;
    nationalCount?: number;
  };
};

export type TmPlayer = {
  id: string;
  name: string;
  shortName?: string;
  attributes?: {
    positionGroupName?: string;
    position?: { name?: string; shortName?: string; category?: string };
    firstSidePosition?: { name?: string; shortName?: string; category?: string };
    secondSidePosition?: { name?: string; shortName?: string; category?: string };
    height?: number;
    preferredFoot?: { name?: string };
    contractUntil?: string;
    consultantAgency?: { id?: number; name?: string };
  };
  marketValueDetails?: {
    current?: { value?: number; currency?: string; determined?: string };
    previous?: { value?: number; currency?: string; determined?: string };
    highest?: { value?: number; currency?: string; determined?: string };
    delta?: { value?: string; percentage?: string; type?: string };
  };
  lifeDates?: { age?: number; dateOfBirth?: string };
  birthPlaceDetails?: {
    placeOfBirth?: string;
    countryOfBirthId?: number;
    gender?: string;
  };
  nationalityDetails?: {
    nationalities?: { nationalityId?: number; secondNationalityId?: number };
  };
  clubAssignments?: Array<{
    clubId?: string;
    shirtNumber?: number | null;
    isCaptain?: boolean;
    type?: string;
    debut?: string;
    start?: string;
  }>;
  relativeUrl?: string;
  portraitUrl?: string;
  portraitUrlSource?: string;
};

export type TmPlayersResponse = {
  success: boolean;
  data?: TmPlayer[];
};

function cachePlayers(players: TmPlayer[]): void {
  for (const p of players) {
    if (p?.id) setCachedJson(playerCacheKey(String(p.id)), p);
  }
}

export async function competition(code: string, opts: TmFetchOpts = {}) {
  return getJson<{ success: boolean; data?: TmCompetitionData }>(`/competition/${code}`, opts);
}

export async function competitionTable(code: string, opts: TmFetchOpts = {}) {
  return getJson<{
    success: boolean;
    data?: { tables: Array<{ clubs: TmTableClub[] }>; competitionId?: string };
  }>(`/competition/${code}/table`, opts);
}

export async function clubInfo(clubId: string | number, opts: TmFetchOpts = {}) {
  return getJson<TmClub>(`/club/${clubId}`, opts);
}

export async function clubSquad(clubId: string | number, opts: TmFetchOpts = {}) {
  return getJson<TmSquad>(`/club/${clubId}/squad`, opts);
}

export async function playerById(id: string | number, opts: TmFetchOpts = {}): Promise<TmPlayer | null> {
  const sid = String(id);
  if (!opts.forceRefresh) {
    const cached = getCachedJson<TmPlayer>(playerCacheKey(sid));
    if (cached) return cached;
  }
  const res = await getJson<{ success: boolean; data?: TmPlayer }>(`/player/${sid}`, opts);
  const player = res?.data ?? null;
  if (player) setCachedJson(playerCacheKey(sid), player);
  return player;
}

/** Fetch players by ids; uses per-player cache, only requests missing ones unless forceRefresh. */
export async function playersByIds(ids: string[], opts: TmFetchOpts = {}): Promise<TmPlayer[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids.map(String))];
  const out: TmPlayer[] = [];
  const missing: string[] = [];

  for (const id of unique) {
    if (!opts.forceRefresh) {
      const cached = getCachedJson<TmPlayer>(playerCacheKey(id));
      if (cached) {
        out.push(cached);
        continue;
      }
    }
    missing.push(id);
  }

  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const qs = chunk.map((id) => `ids[]=${id}`).join("&");
    const res = await getJson<TmPlayersResponse>(`/players?${qs}`, { forceRefresh: true });
    if (res?.data) {
      cachePlayers(res.data);
      out.push(...res.data);
    }
  }

  const byId = new Map(out.map((p) => [String(p.id), p]));
  return unique.map((id) => byId.get(id)).filter((p): p is TmPlayer => Boolean(p));
}

export async function attributes(opts: TmFetchOpts = {}) {
  return getJson<{ success: boolean; data?: Record<string, unknown> }>("/attributes", opts);
}

export async function clubFixtures(clubId: string | number, opts: TmFetchOpts = {}) {
  return getJson<{
    success: boolean;
    data?: {
      competitions: Array<{
        competitionId: string;
        games: Array<Record<string, unknown>>;
      }>;
      gameIds: string[];
      competitionIds: string[];
      clubIds: string[];
    };
  }>(`/club/${clubId}/fixtures`, opts);
}

export async function gameById(gameId: string | number, opts: TmFetchOpts = {}) {
  return getJson<{ success: boolean; data?: Record<string, unknown> }>(`/game/${gameId}`, opts);
}

export async function gamesByIds(ids: string[], opts: TmFetchOpts = {}): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids.map(String))];
  const out: Record<string, unknown>[] = [];
  const missing: string[] = [];

  for (const id of unique) {
    const key = cacheKey(`/game/${id}`);
    if (!opts.forceRefresh) {
      const cached = getCachedJson<{ success: boolean; data?: Record<string, unknown> }>(key);
      if (cached?.data) {
        out.push(cached.data);
        continue;
      }
    }
    missing.push(id);
  }

  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const qs = chunk.map((id) => `ids[]=${id}`).join("&");
    const res = await getJson<{ success: boolean; data?: Record<string, unknown>[] }>(
      `/games?${qs}`,
      { forceRefresh: true },
    );
    const list = res?.data ?? [];
    for (const g of list) {
      if (g?.id) setCachedJson(cacheKey(`/game/${g.id}`), { success: true, data: g });
      out.push(g);
    }
  }

  const byId = new Map(out.map((g) => [String(g.id), g]));
  return unique.map((id) => byId.get(id)).filter((g): g is Record<string, unknown> => Boolean(g));
}
