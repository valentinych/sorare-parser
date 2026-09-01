import { mantraFetchWithRetry } from "./mantraRequest.js";

const BASE = "https://mantrafootball.org/api";

/** @deprecated use tournament id from AfLeagueDef.mantraTournamentId */
export const POLAND_TOURNAMENT_ID = 18;

export type MantraListPlayer = {
  id: number;
  name: string;
  firstName: string | null;
  positions: string[];
  positionsItal: string[];
  clubId: number | null;
  clubName: string;
  clubCode: string | null;
  clubLogo: string | null;
  clubTmUrl: string | null;
  avatarPath: string | null;
  baseScore: number;
  totalScore: number;
  appearances: number;
  averagePrice: number | null;
  /** Fantasy leagues where this player is already owned (ids). */
  leagues: number[];
  teamsCount: number;
};

export type MantraLeague = {
  id: number;
  name: string;
  division: string;
  divisionId: number | null;
  seasonId: number | null;
  status: string | null;
  tournamentId: number;
};

export type MantraProfile = MantraListPlayer & {
  tmUrl: string | null;
  tmPrice: number | null;
  birthDate: string | null;
  age: number | null;
  height: number | null;
  nationality: string | null;
  number: number | null;
};

export type MantraFantasyTeamSummary = {
  id: number;
  name: string;
  logoPath: string | null;
};

export type MantraFantasyTeam = MantraFantasyTeamSummary & {
  code: string | null;
  leagueId: number;
  userId: number | null;
  budget: number | null;
  playerIds: number[];
};

type Json = Record<string, unknown>;

async function mantraGet(path: string, params?: Record<string, string | number>): Promise<Json> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.append(k, String(v));
    }
  }
  const res = await mantraFetchWithRetry(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "transfermarkt-xi-pet/0.1",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Mantra ${path} → ${res.status}`);
  return (await res.json()) as Json;
}

function parseListPlayer(raw: Json): MantraListPlayer {
  const club = (raw.club as Json | null) ?? null;
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    firstName: raw.first_name != null ? String(raw.first_name) : null,
    positions: Array.isArray(raw.position_classic_arr) ? (raw.position_classic_arr as string[]) : [],
    positionsItal: Array.isArray(raw.position_ital_arr) ? (raw.position_ital_arr as string[]) : [],
    clubId: club?.id != null ? Number(club.id) : null,
    clubName: club?.name ? String(club.name) : "",
    clubCode: club?.code != null ? String(club.code) : null,
    clubLogo: club?.logo_path != null ? String(club.logo_path) : null,
    clubTmUrl: club?.tm_url != null ? String(club.tm_url) : null,
    avatarPath: raw.avatar_path != null ? String(raw.avatar_path) : null,
    baseScore: Number(raw.average_base_score ?? 0) || 0,
    totalScore: Number(raw.average_total_score ?? 0) || 0,
    appearances: Number(raw.appearances ?? 0) || 0,
    averagePrice: raw.average_price != null ? Number(raw.average_price) : null,
    leagues: Array.isArray(raw.leagues)
      ? (raw.leagues as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n))
      : [],
    teamsCount: Number(raw.teams_count ?? 0) || 0,
  };
}

export async function fetchMantraLeagues(tournamentId: number): Promise<MantraLeague[]> {
  const data = await mantraGet("/leagues", {
    "filter[tournament_id]": tournamentId,
    "page[size]": 50,
    "page[number]": 1,
  });
  const list = Array.isArray(data.data) ? (data.data as Json[]) : [];
  return list
    .map((raw) => ({
      id: Number(raw.id),
      name: String(raw.name ?? ""),
      division: String(raw.division ?? ""),
      divisionId: raw.division_id != null ? Number(raw.division_id) : null,
      seasonId: raw.season_id != null ? Number(raw.season_id) : null,
      status: raw.status != null ? String(raw.status) : null,
      tournamentId,
    }))
    .filter((l) => l.status === "active");
}

export async function fetchMantraPlayersPage(
  tournamentId: number,
  pageNumber: number,
  pageSize = 50,
) {
  const data = await mantraGet("/players", {
    "filter[tournament_id][]": tournamentId,
    "page[size]": pageSize,
    "page[number]": pageNumber,
    "order[field]": "name",
    "order[direction]": "asc",
  });
  const list = Array.isArray(data.data) ? (data.data as Json[]) : [];
  const meta = (data.meta ?? {}) as Json;
  const page = (meta.page ?? {}) as Json;
  return {
    players: list.map(parseListPlayer),
    total: Number(meta.size ?? 0),
    totalPages: Number(page.total_pages ?? 1),
    currentPage: Number(page.current_page ?? pageNumber),
  };
}

export async function fetchAllMantraPlayers(tournamentId: number): Promise<MantraListPlayer[]> {
  const first = await fetchMantraPlayersPage(tournamentId, 1);
  const out = [...first.players];
  for (let p = 2; p <= first.totalPages; p++) {
    const next = await fetchMantraPlayersPage(tournamentId, p);
    out.push(...next.players);
    console.log(
      `  mantra t${tournamentId} list page ${p}/${first.totalPages} (+${next.players.length})`,
    );
  }
  return out;
}

export async function fetchMantraProfile(playerId: number): Promise<MantraProfile> {
  const data = await mantraGet(`/players/${playerId}`);
  const raw = (data.data ?? data) as Json;
  const base = parseListPlayer(raw);
  return {
    ...base,
    tmUrl: raw.tm_url != null ? String(raw.tm_url) : null,
    tmPrice: raw.tm_price != null ? Number(raw.tm_price) : null,
    birthDate: raw.birth_date != null ? String(raw.birth_date) : null,
    age: raw.age != null ? Number(raw.age) : null,
    height: raw.height != null ? Number(raw.height) : null,
    nationality: raw.nationality != null ? String(raw.nationality) : null,
    number: raw.number != null ? Number(raw.number) : null,
  };
}

export async function fetchLeagueTeams(leagueId: number): Promise<MantraFantasyTeamSummary[]> {
  const data = await mantraGet(`/leagues/${leagueId}/teams`);
  const list = Array.isArray(data.data) ? (data.data as Json[]) : [];
  return list
    .map((raw) => ({
      id: Number(raw.id),
      name: String(raw.human_name ?? raw.name ?? "").trim(),
      logoPath: raw.logo_path != null ? String(raw.logo_path) : null,
    }))
    .filter((t) => Number.isFinite(t.id) && t.name);
}

export async function fetchMantraLeague(leagueId: number): Promise<MantraLeague | null> {
  const data = await mantraGet(`/leagues/${leagueId}`);
  const raw = (data.data ?? data) as Json;
  const id = Number(raw.id ?? leagueId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(raw.name ?? ""),
    division: raw.division != null ? String(raw.division) : "",
    divisionId: raw.division_id != null ? Number(raw.division_id) : null,
    seasonId: raw.season_id != null ? Number(raw.season_id) : null,
    status: raw.status != null ? String(raw.status) : null,
    tournamentId: raw.tournament_id != null ? Number(raw.tournament_id) : 0,
  };
}

export async function fetchFantasyTeam(teamId: number): Promise<MantraFantasyTeam> {
  const data = await mantraGet(`/teams/${teamId}`);
  const raw = (data.data ?? data) as Json;
  const playersRaw = Array.isArray(raw.players) ? (raw.players as unknown[]) : [];
  return {
    id: Number(raw.id),
    name: String(raw.human_name ?? raw.name ?? "").trim(),
    logoPath: raw.logo_path != null ? String(raw.logo_path) : null,
    code: raw.code != null ? String(raw.code) : null,
    leagueId: Number(raw.league_id),
    userId: raw.user_id != null ? Number(raw.user_id) : null,
    budget: raw.budget != null ? Number(raw.budget) : null,
    playerIds: playersRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n)),
  };
}

/** @deprecated */
export async function fetchPolandLeagues(): Promise<MantraLeague[]> {
  return fetchMantraLeagues(POLAND_TOURNAMENT_ID);
}

/** @deprecated */
export async function fetchAllPolandPlayers(): Promise<MantraListPlayer[]> {
  return fetchAllMantraPlayers(POLAND_TOURNAMENT_ID);
}
