import { config } from "../config.js";
import { getDb } from "../db/index.js";

const ENDPOINT = "https://api.sorare.com/graphql";
let nextRequestAt = 0;
let requestQueue = Promise.resolve();
let authSession: { token: string; expiresAt: number } | null = null;
let authStatus: SorareAuthenticationStatus["status"] = "disabled";
let authPromise: Promise<{ token: string; expiresAt: number } | null> | null = null;

export type SorareAuthenticationStatus = {
  source: "sorare_jwt";
  configured: boolean;
  authenticated: boolean;
  status:
    | "disabled"
    | "not_checked"
    | "ready"
    | "two_factor_required"
    | "terms_required"
    | "error";
  expiresAt: string | null;
};

type SignInPayload = {
  signIn: {
    currentUser: { slug: string } | null;
    jwtToken: { token: string; expiredAt: string } | null;
    otpSessionChallenge: string | null;
    tcuToken: string | null;
    errors: Array<{ message?: string }>;
  };
};

const SIGN_IN_QUERY = `
  mutation SignInMutation($input: signInInput!) {
    signIn(input: $input) {
      currentUser { slug }
      jwtToken(aud: __JWT_AUD__) { token expiredAt }
      otpSessionChallenge
      tcuToken
      errors { message }
    }
  }
`;

export type SorareTeamRef = {
  name: string;
  slug: string;
  pictureUrl?: string | null;
};

export type SorareGameRef = {
  id: string;
  date: string;
  statusTyped: string;
  competition: { name: string; slug: string };
  homeTeam: SorareTeamRef | null;
  awayTeam: SorareTeamRef | null;
};

export type SorarePlayingStatusOdds = {
  starterOddsBasisPoints: number;
  substituteOddsBasisPoints: number;
  nonPlayingOddsBasisPoints: number;
  reliability: string;
  providerIconUrl?: string | null;
  providerRedirectUrl?: string | null;
};

export type SorarePlayer = {
  slug: string;
  displayName: string;
  position: string;
  pictureUrl?: string | null;
  squaredPictureUrl?: string | null;
  shirtNumber?: number | null;
  activeClub?: SorareTeamRef | null;
  nextClassicFixturePlayingStatusOdds?: SorarePlayingStatusOdds | null;
};

export type SorareLeaguePayload = {
  football: {
    competition: {
      slug: string;
      name: string;
      displayName: string;
      pictureUrl?: string | null;
      clubs: { nodes: SorareTeamRef[] };
      futureGames: { nodes: SorareGameRef[] };
    };
  };
};

export type SorareTeamPayload = {
  football: {
    club: SorareTeamRef & {
      officialName: string;
      shortName: string;
      founded?: string | null;
      domesticLeagueRanking?: number | null;
      country: { name: string; code: string };
      activePlayers: {
        nodes: SorarePlayer[];
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
      upcomingGames: SorareGameRef[];
      latestGames: { nodes: SorareGameRef[] };
    };
  };
};

export type SorareFormation = {
  startingLineupAvailable: boolean;
  startingLineup: SorarePlayer[][];
  bench: SorarePlayer[];
};

export type SorareGamePlayerScore = {
  footballPlayer: SorarePlayer;
  footballPlayerGameStats: {
    formationPlace?: number | null;
    onGameSheet: boolean;
    gameStarted?: number | null;
    footballPlayingStatusOdds?: SorarePlayingStatusOdds | null;
  };
};

export type SorareTeamGameStats = {
  winOddsBasisPoints?: number | null;
  drawOddsBasisPoints?: number | null;
  loseOddsBasisPoints?: number | null;
  cleanSheetOdds?: number | null;
  threeGoalsOdds?: number | null;
};

export type SorareGamePayload = {
  anyGame: SorareGameRef & {
    homeFormation: SorareFormation;
    awayFormation: SorareFormation;
    homeStats?: SorareTeamGameStats | null;
    awayStats?: SorareTeamGameStats | null;
    playerGameScores: SorareGamePlayerScore[];
  };
};

type CacheRow = {
  body_json: string;
  fetched_at: string;
  expires_at: string;
};

export type CachedSorare<T> = {
  data: T;
  fetchedAt: string;
  stale: boolean;
};

const LEAGUE_QUERY = `
  query SorareLeague($slug: String!) {
    football {
      competition(slug: $slug) {
        slug
        name
        displayName
        pictureUrl
        clubs(first: 40) {
          nodes { name slug pictureUrl }
        }
        futureGames(first: 20) {
          nodes {
            id date statusTyped
            competition { name slug }
            homeTeam { name slug pictureUrl }
            awayTeam { name slug pictureUrl }
          }
        }
      }
    }
  }
`;

const TEAM_QUERY = `
  query SorareTeam($slug: String!) {
    football {
      club(slug: $slug) {
        name slug officialName shortName founded pictureUrl
        domesticLeagueRanking
        country { name code }
        activePlayers(first: 15) {
          nodes {
            slug displayName position pictureUrl squaredPictureUrl shirtNumber
            activeClub { name slug pictureUrl }
            nextClassicFixturePlayingStatusOdds {
              starterOddsBasisPoints substituteOddsBasisPoints nonPlayingOddsBasisPoints
              reliability providerIconUrl providerRedirectUrl
            }
          }
          pageInfo { hasNextPage endCursor }
        }
        upcomingGames(first: 5) {
          id date statusTyped competition { name slug }
          homeTeam { name slug pictureUrl }
          awayTeam { name slug pictureUrl }
        }
        latestGames(first: 3) {
          nodes {
            id date statusTyped competition { name slug }
            homeTeam { name slug pictureUrl }
            awayTeam { name slug pictureUrl }
          }
        }
      }
    }
  }
`;

const TEAM_PROFILE_QUERY = `
  query SorareTeamProfile($slug: String!) {
    football {
      club(slug: $slug) {
        name slug officialName shortName founded pictureUrl
        domesticLeagueRanking
        country { name code }
        upcomingGames(first: 5) {
          id date statusTyped competition { name slug }
          homeTeam { name slug pictureUrl }
          awayTeam { name slug pictureUrl }
        }
        latestGames(first: 3) {
          nodes {
            id date statusTyped competition { name slug }
            homeTeam { name slug pictureUrl }
            awayTeam { name slug pictureUrl }
          }
        }
      }
    }
  }
`;

const TEAM_PLAYERS_QUERY = `
  query SorareTeamPlayers($slug: String!, $after: String) {
    football {
      club(slug: $slug) {
        activePlayers(first: 15, after: $after) {
          nodes {
            slug displayName position pictureUrl squaredPictureUrl shirtNumber
            activeClub { name slug pictureUrl }
            nextClassicFixturePlayingStatusOdds {
              starterOddsBasisPoints substituteOddsBasisPoints nonPlayingOddsBasisPoints
              reliability providerIconUrl providerRedirectUrl
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const GAME_QUERY = `
  query SorareGame($id: ID!) {
    anyGame(id: $id) {
      ... on Game {
        id date statusTyped competition { name slug }
        homeTeam { name slug pictureUrl }
        awayTeam { name slug pictureUrl }
        homeFormation {
          startingLineupAvailable
          startingLineup { slug displayName position pictureUrl squaredPictureUrl }
          bench { slug displayName position pictureUrl squaredPictureUrl }
        }
        awayFormation {
          startingLineupAvailable
          startingLineup { slug displayName position pictureUrl squaredPictureUrl }
          bench { slug displayName position pictureUrl squaredPictureUrl }
        }
        homeStats {
          ... on FootballTeamGameStats {
            winOddsBasisPoints drawOddsBasisPoints loseOddsBasisPoints
            cleanSheetOdds threeGoalsOdds
          }
        }
        awayStats {
          ... on FootballTeamGameStats {
            winOddsBasisPoints drawOddsBasisPoints loseOddsBasisPoints
            cleanSheetOdds threeGoalsOdds
          }
        }
        playerGameScores {
          ... on PlayerGameScore {
            footballPlayer {
              slug displayName position pictureUrl squaredPictureUrl shirtNumber
              activeClub { name slug pictureUrl }
            }
            footballPlayerGameStats {
              formationPlace onGameSheet gameStarted
              footballPlayingStatusOdds {
                starterOddsBasisPoints substituteOddsBasisPoints nonPlayingOddsBasisPoints
                reliability providerIconUrl providerRedirectUrl
              }
            }
          }
        }
      }
    }
  }
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authEnvPresent(): boolean {
  return Boolean(
    config.sorareEmail.trim() &&
      config.sorarePasswordHash.trim() &&
      config.sorareJwtAud.trim(),
  );
}

function passwordHashValid(): boolean {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(
    config.sorarePasswordHash.trim(),
  );
}

export function sorareAuthenticationStatus(): SorareAuthenticationStatus {
  if (!authEnvPresent()) {
    return {
      source: "sorare_jwt",
      configured: false,
      authenticated: false,
      status: "disabled",
      expiresAt: null,
    };
  }
  if (!passwordHashValid()) {
    return {
      source: "sorare_jwt",
      configured: true,
      authenticated: false,
      status: "error",
      expiresAt: null,
    };
  }
  if (authSession && authSession.expiresAt > Date.now()) {
    return {
      source: "sorare_jwt",
      configured: true,
      authenticated: true,
      status: "ready",
      expiresAt: new Date(authSession.expiresAt).toISOString(),
    };
  }
  return {
    source: "sorare_jwt",
    configured: true,
    authenticated: false,
    status: authStatus === "disabled" ? "not_checked" : authStatus,
    expiresAt: null,
  };
}

export function resetSorareClientForTests(): void {
  nextRequestAt = 0;
  requestQueue = Promise.resolve();
  authSession = null;
  authPromise = null;
  authStatus = authEnvPresent()
    ? passwordHashValid()
      ? "not_checked"
      : "error"
    : "disabled";
}

async function throttle(authenticated: boolean): Promise<void> {
  const interval = config.sorareApiKey ? 110 : authenticated ? 1_050 : 3_100;
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait > 0) await sleep(wait);
  nextRequestAt = Date.now() + interval;
}

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(fn);
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function signInSorare(): Promise<{ token: string; expiresAt: number } | null> {
  if (!authEnvPresent()) {
    authStatus = "disabled";
    authSession = null;
    return null;
  }
  if (!passwordHashValid()) {
    authStatus = "error";
    authSession = null;
    throw new Error("SORARE_PASSWORD_HASH must be a bcrypt hash");
  }
  if (authSession && authSession.expiresAt > Date.now() + 60_000) return authSession;
  if (authPromise) return authPromise;

  authPromise = (async () => {
    authSession = null;
    authStatus = "not_checked";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.sorareApiKey) headers.APIKEY = config.sorareApiKey;
      const query = SIGN_IN_QUERY.replace(
        "__JWT_AUD__",
        JSON.stringify(config.sorareJwtAud.trim()),
      );
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationName: "SignInMutation",
          query,
          variables: {
            input: {
              email: config.sorareEmail.trim(),
              password: config.sorarePasswordHash.trim(),
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        authStatus = "error";
        throw new Error(`Sorare authentication failed with ${response.status}`);
      }
      const body = (await response.json()) as {
        data?: SignInPayload;
        errors?: Array<{ message?: string }>;
      };
      const result = body.data?.signIn;
      if (body.errors?.length || !result) {
        authStatus = "error";
        throw new Error("Sorare authentication failed");
      }
      if (result.otpSessionChallenge || (!result.currentUser && !result.errors.length)) {
        authStatus = "two_factor_required";
        throw new Error("Sorare authentication requires 2FA");
      }
      if (result.tcuToken) {
        authStatus = "terms_required";
        throw new Error("Sorare terms acceptance is required");
      }
      if (result.errors.length || !result.currentUser || !result.jwtToken?.token) {
        authStatus = "error";
        throw new Error("Sorare authentication failed");
      }
      const expiresAt = Date.parse(result.jwtToken.expiredAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        authStatus = "error";
        throw new Error("Sorare returned an invalid JWT expiry");
      }
      authSession = { token: result.jwtToken.token, expiresAt };
      authStatus = "ready";
      return authSession;
    } finally {
      clearTimeout(timeout);
      authPromise = null;
    }
  })();
  return authPromise;
}

async function requestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.sorareApiKey) headers.APIKEY = config.sorareApiKey;
  const session = await signInSorare();
  if (session) {
    headers.Authorization = `Bearer ${session.token}`;
    headers["JWT-AUD"] = config.sorareJwtAud.trim();
  }
  return headers;
}

export async function sorareGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return enqueue(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const headers = await requestHeaders();
        await throttle(Boolean(headers.Authorization));
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        if (
          (response.status === 401 || response.status === 403) &&
          headers.Authorization &&
          attempt === 0
        ) {
          authSession = null;
          authStatus = "not_checked";
          continue;
        }
        if (response.status === 429 && attempt === 0) {
          const retryAfter = Math.max(1, Number(response.headers.get("retry-after") ?? 5));
          await sleep(retryAfter * 1_000);
          continue;
        }
        if (!response.ok) throw new Error(`Sorare HTTP ${response.status}`);
        const body = (await response.json()) as {
          data?: T;
          errors?: Array<{ message?: string }>;
        };
        if (body.errors?.length || !body.data) {
          throw new Error(body.errors?.map((error) => error.message).filter(Boolean).join("; ") || "Sorare returned no data");
        }
        return body.data;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Sorare rate limit exceeded");
  });
}

function cacheRow<T>(key: string): CachedSorare<T> | null {
  const row = getDb()
    .prepare(`SELECT body_json, fetched_at, expires_at FROM sorare_cache WHERE key = ?`)
    .get(key) as CacheRow | undefined;
  if (!row) return null;
  try {
    return {
      data: JSON.parse(row.body_json) as T,
      fetchedAt: row.fetched_at,
      stale: Date.parse(row.expires_at) <= Date.now(),
    };
  } catch {
    return null;
  }
}

export function peekSorareCache<T>(key: string): CachedSorare<T> | null {
  return cacheRow<T>(key);
}

function writeCache<T>(key: string, data: T, ttlMs: number): CachedSorare<T> {
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sorare_cache (key, body_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         body_json = excluded.body_json,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    )
    .run(key, JSON.stringify(data), fetchedAt, expiresAt);
  return { data, fetchedAt, stale: false };
}

async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  force = false,
): Promise<CachedSorare<T>> {
  const previous = cacheRow<T>(key);
  if (!force && previous && !previous.stale) return previous;
  try {
    return writeCache(key, await loader(), ttlMs);
  } catch (error) {
    if (previous) return { ...previous, stale: true };
    throw error;
  }
}

export function sorareLeague(
  competitionSlug: string,
  force = false,
): Promise<CachedSorare<SorareLeaguePayload>> {
  return cached(
    `league:${competitionSlug}`,
    30 * 60_000,
    () => sorareGraphql<SorareLeaguePayload>(LEAGUE_QUERY, { slug: competitionSlug }),
    force,
  );
}

export function sorareTeam(
  teamSlug: string,
  force = false,
): Promise<CachedSorare<SorareTeamPayload>> {
  return cached(
    `team:${teamSlug}`,
    6 * 60 * 60_000,
    async () => {
      const data = await sorareGraphql<SorareTeamPayload>(TEAM_QUERY, { slug: teamSlug });
      let pageInfo = data.football.club.activePlayers.pageInfo;
      while (pageInfo?.hasNextPage && pageInfo.endCursor) {
        const page = await sorareGraphql<SorareTeamPayload>(TEAM_PLAYERS_QUERY, {
          slug: teamSlug,
          after: pageInfo.endCursor,
        });
        data.football.club.activePlayers.nodes.push(
          ...page.football.club.activePlayers.nodes,
        );
        pageInfo = page.football.club.activePlayers.pageInfo;
      }
      return data;
    },
    force,
  );
}

export function sorareTeamProfile(
  teamSlug: string,
  force = false,
): Promise<CachedSorare<SorareTeamPayload>> {
  return cached(
    `team-profile:${teamSlug}`,
    24 * 60 * 60_000,
    async () => {
      const data = await sorareGraphql<SorareTeamPayload>(TEAM_PROFILE_QUERY, {
        slug: teamSlug,
      });
      data.football.club.activePlayers = { nodes: [] };
      return data;
    },
    force,
  );
}

export function sorareGame(
  gameId: string,
  force = false,
): Promise<CachedSorare<SorareGamePayload>> {
  return cached(
    `game:${gameId}`,
    30 * 60_000,
    () => sorareGraphql<SorareGamePayload>(GAME_QUERY, { id: gameId }),
    force,
  );
}
