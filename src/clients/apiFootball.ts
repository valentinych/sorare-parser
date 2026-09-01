import { requireApiKey } from "../config.js";
import { rateLimit4perSec } from "../lib/rateLimit.js";

const BASE = "https://v3.football.api-sports.io";

export type AfTeam = {
  team: { id: number; name: string; code: string | null; logo: string };
};

export type AfFixture = {
  fixture: { id: number; date: string; status: { short: string } };
  league: { id: number; name: string; round: string; season?: number };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
};

export type AfLineup = {
  team: { id: number; name: string };
  formation: string | null;
  startXI: Array<{ player: { id: number; name: string; pos: string | null; grid: string | null } }>;
  substitutes: Array<{ player: { id: number; name: string; pos: string | null; grid: string | null } }>;
};

export type AfPlayerStatBlock = {
  team: { id: number; name: string };
  league?: { id: number; name: string; country?: string | null; type?: string | null };
  games: {
    appearences: number | null;
    lineups: number | null;
    minutes: number | null;
    position: string | null;
    rating: string | null;
  };
  goals: {
    total: number | null;
    assists: number | null;
    conceded?: number | null;
    saves?: number | null;
  };
  shots?: { total?: number | null; on?: number | null };
  passes?: { total?: number | null; key?: number | null; accuracy?: number | null };
  tackles?: { total?: number | null; blocks?: number | null; interceptions?: number | null };
  dribbles?: { attempts?: number | null; success?: number | null; past?: number | null };
  fouls?: { drawn?: number | null; committed?: number | null };
  cards?: {
    yellow?: number | null;
    yellowred?: number | null;
    red?: number | null;
  };
  penalty?: {
    scored?: number | null;
    missed?: number | null;
    saved?: number | null;
  };
  /** Present on some AF payloads; otherwise null. */
  clean_sheets?: number | null;
};

export type AfPlayerRow = {
  player: {
    id: number;
    name: string;
    age: number | null;
    nationality: string | null;
    photo: string | null;
  };
  statistics: AfPlayerStatBlock[];
};

export type AfSquadPlayer = {
  id: number;
  name: string;
  age: number | null;
  number: number | null;
  position: string | null;
  photo: string | null;
};

type AfResponse<T> = {
  response: T;
  results: number;
  paging?: { current: number; total: number };
  errors?: unknown;
};

async function get<T>(path: string, params: Record<string, string | number>): Promise<AfResponse<T>> {
  await rateLimit4perSec();

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: {
      "x-apisports-key": requireApiKey(),
    },
  });

  if (!res.ok) {
    throw new Error(`API-Football ${path} failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as AfResponse<T>;
  if (data.errors && Object.keys(data.errors as object).length > 0) {
    throw new Error(`API-Football error on ${path}: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

export function teams(league: number, season: number) {
  return get<AfTeam[]>("/teams", { league, season });
}

export function fixtures(league: number, season: number) {
  return get<AfFixture[]>("/fixtures", { league, season });
}

export type AfOddsBookmaker = {
  id: number;
  name: string;
  bets: Array<{
    id: number;
    name: string;
    values: Array<{ value: string; odd: string }>;
  }>;
};

export type AfOddsRow = {
  fixture: { id: number; date: string; timestamp?: number };
  league: { id: number; season: number; round?: string };
  bookmakers: AfOddsBookmaker[];
  update?: string;
};

/** Pre-match odds for a league season (all markets). Paginated; client rate-limits. */
export async function oddsForLeague(
  league: number,
  season: number,
  bet?: number,
): Promise<AfOddsRow[]> {
  const out: AfOddsRow[] = [];
  let page = 1;
  let total = 1;
  while (page <= total) {
    const params: Record<string, string | number> = { league, season, page };
    if (bet != null) params.bet = bet;
    const data = await get<AfOddsRow[]>("/odds", params);
    out.push(...(data.response ?? []));
    total = data.paging?.total ?? 1;
    page += 1;
  }
  return out;
}

/** @deprecated Prefer oddsForLeague — kept for callers that only need 1x2. */
export async function oddsMatchWinner(league: number, season: number): Promise<AfOddsRow[]> {
  return oddsForLeague(league, season, 1);
}

export function teamFixtures(params: {
  team: number;
  season: number;
  from?: string;
  to?: string;
}) {
  const q: Record<string, string | number> = { team: params.team, season: params.season };
  if (params.from) q.from = params.from;
  if (params.to) q.to = params.to;
  return get<AfFixture[]>("/fixtures", q);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type AfCoachCareer = {
  team: { id: number | null; name: string; logo?: string | null };
  start: string | null;
  end: string | null;
};

export type AfCoach = {
  id: number;
  name: string;
  photo?: string | null;
  career?: AfCoachCareer[];
};

export function coaches(params: { team?: number; id?: number; search?: string }) {
  const q: Record<string, string | number> = {};
  if (params.team != null) q.team = params.team;
  if (params.id != null) q.id = params.id;
  if (params.search) q.search = params.search;
  return get<AfCoach[]>("/coachs", q);
}

export type AfLineupWithCoach = AfLineup & {
  coach?: { id: number; name: string; photo?: string | null };
};

export function lineups(fixtureId: number, teamId?: number) {
  const q: Record<string, string | number> = { fixture: fixtureId };
  if (teamId != null) q.team = teamId;
  return get<AfLineupWithCoach[]>("/fixtures/lineups", q);
}

export type AfFixtureEvent = {
  time: { elapsed: number | null; extra: number | null };
  team: { id: number; name: string };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string;
  comments: string | null;
};

export function fixtureEvents(fixtureId: number) {
  return get<AfFixtureEvent[]>("/fixtures/events", { fixture: fixtureId });
}

export async function playersPage(league: number, season: number, page: number) {
  return get<AfPlayerRow[]>("/players", { league, season, page });
}

export async function allPlayers(league: number, season: number): Promise<AfPlayerRow[]> {
  const first = await playersPage(league, season, 1);
  const total = first.paging?.total ?? 1;
  const rows = [...first.response];
  for (let page = 2; page <= total; page++) {
    const next = await playersPage(league, season, page);
    rows.push(...next.response);
    await sleep(250);
  }
  return rows;
}

/** Full season stats across all competitions for one player. */
export async function playerById(playerId: number, season: number): Promise<AfPlayerRow | null> {
  const data = await get<AfPlayerRow[]>("/players", { id: playerId, season });
  return data.response?.[0] ?? null;
}

export async function squad(teamId: number): Promise<AfSquadPlayer[]> {
  const data = await get<Array<{ team: { id: number }; players: AfSquadPlayer[] }>>("/players/squads", {
    team: teamId,
  });
  return data.response[0]?.players ?? [];
}
