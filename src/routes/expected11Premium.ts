import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasExpected11PremiumAccess, isLiveDraftAdmin } from "../config.js";
import { getDb } from "../db/index.js";
import {
  getAuctionRefreshCooldown,
  markAuctionRefreshDone,
  type AuctionRefreshCooldownState,
} from "../domain/auctionRefreshCooldown.js";
import {
  Expected11MappingError,
  getExpected11MappingView,
  getExpected11PremiumView,
  relinkPremiumSquadMappings,
  removeExpected11ManualMapping,
  saveExpected11ManualMapping,
} from "../domain/expected11Premium.js";
import { getPremiumSquadReport } from "../domain/premiumSquadReport.js";
import { getPremiumUnpickedTops } from "../domain/premiumUnpickedTops.js";
import { withTimeout } from "../lib/withTimeout.js";
import {
  refreshPremiumLeagueAfterAuction,
  type RefreshPremiumLeagueInput,
  type RefreshPremiumLeagueResult,
} from "../sync/refreshPremiumLeagueAfterAuction.js";
import { ensureManagerPremiumSquads } from "../sync/syncManagerPremiumSquads.js";
import {
  requireSameOrigin,
  requireUser,
} from "./account.js";

export const PREMIUM_AUCTION_REFRESH_TIMEOUT_MS = 240_000;

const auctionRefreshLock = { running: false };

export function resetPremiumAuctionRefreshLockForTests(): void {
  auctionRefreshLock.running = false;
}

export type Expected11PremiumActor = {
  id: number;
  email: string;
  mantraManagerId: number | null;
};

type Expected11PremiumRouteOptions = {
  authorize?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Expected11PremiumActor | null;
  authorizeMapping?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Expected11PremiumActor | null;
  mappingView?: () => ReturnType<typeof getExpected11MappingView>;
  premiumView?: (
    options: { tournamentId?: number; ownedOnly?: boolean },
    actor: Expected11PremiumActor,
  ) => ReturnType<typeof getExpected11PremiumView> | Promise<ReturnType<typeof getExpected11PremiumView>>;
  ensureSquads?: (
    actor: Expected11PremiumActor,
    force: boolean,
  ) => void | Promise<void>;
  saveMapping?: (
    input: {
      sourceName: string;
      mantraClubId: number;
      mantraPlayerId: number;
    },
    actor: Expected11PremiumActor,
  ) => ReturnType<typeof saveExpected11ManualMapping>;
  removeMapping?: (input: {
    sourceName: string;
    mantraClubId: number;
  }) => ReturnType<typeof removeExpected11ManualMapping>;
  squadReport?: (
    options: { teamId: number; fresh?: boolean; injuries?: boolean },
    actor: Expected11PremiumActor,
  ) => ReturnType<typeof getPremiumSquadReport>;
  unpickedTops?: (
    options: { teamId: number; fresh?: boolean },
    actor: Expected11PremiumActor,
  ) => ReturnType<typeof getPremiumUnpickedTops>;
  authorizeAdmin?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Expected11PremiumActor | null;
  lookupTeamLeague?: (
    teamId: number,
  ) => { leagueId: number; tournamentId: number | null } | null;
  refreshAuctionStatus?: (
    input: RefreshPremiumLeagueInput,
    actor: Expected11PremiumActor,
  ) => RefreshPremiumLeagueResult | Promise<RefreshPremiumLeagueResult>;
  auctionRefreshCooldown?: (leagueId: number) => AuctionRefreshCooldownState;
  markAuctionRefresh?: (leagueId: number) => AuctionRefreshCooldownState;
};

function sessionActor(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const user = requireUser(request, reply);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    mantraManagerId: user.mantra_manager_id,
  };
}

function defaultAuthorize(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const actor = sessionActor(request, reply);
  if (!actor) return null;
  if (!hasExpected11PremiumAccess(actor.email)) {
    reply.code(403).send({ error: "expected11_premium_forbidden" });
    return null;
  }
  return actor;
}

function defaultAuthorizeMapping(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const actor = sessionActor(request, reply);
  if (!actor) return null;
  if (!isLiveDraftAdmin(actor.email)) {
    reply.code(403).send({ error: "expected11_admin_forbidden" });
    return null;
  }
  return actor;
}

function positiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function resolveRequestedLeague(
  request: FastifyRequest,
  reply: FastifyReply,
  lookupTeamLeague: (
    teamId: number,
  ) => { leagueId: number; tournamentId: number | null } | null,
): { leagueId: number; tournamentId: number | null; teamId: number | null } | null {
  const body = (request.body ?? {}) as {
    teamId?: unknown;
    leagueId?: unknown;
  };
  const query = request.query as { teamId?: string; leagueId?: string };
  const teamId = positiveId(body.teamId ?? query.teamId);
  const requestedLeagueId = positiveId(body.leagueId ?? query.leagueId);
  let leagueId = requestedLeagueId;
  let tournamentId: number | null = null;
  if (teamId != null) {
    const team = lookupTeamLeague(teamId);
    if (!team) {
      reply.code(400).send({ error: "invalid_team_id" });
      return null;
    }
    leagueId = team.leagueId;
    tournamentId = team.tournamentId;
  }
  if (leagueId == null) {
    reply.code(400).send({ error: "invalid_league_id" });
    return null;
  }
  return { leagueId, tournamentId, teamId: teamId ?? null };
}

function defaultLookupTeamLeague(
  teamId: number,
): { leagueId: number; tournamentId: number | null } | null {
  const row = getDb()
    .prepare(
      `SELECT league_id AS leagueId, tournament_id AS tournamentId
       FROM mantra_fantasy_teams WHERE id = ?`,
    )
    .get(teamId) as
    | { leagueId: number | null; tournamentId: number | null }
    | undefined;
  if (row?.leagueId == null || !Number.isSafeInteger(row.leagueId) || row.leagueId <= 0) {
    return null;
  }
  return { leagueId: row.leagueId, tournamentId: row.tournamentId ?? null };
}

function mappingError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof Expected11MappingError) {
    return reply.code(error.status).send({ error: error.code });
  }
  request.log.error(error, "Expected11 manual mapping failed");
  return reply.code(500).send({ error: "expected11_mapping_failed" });
}

export async function expected11PremiumRoutes(
  app: FastifyInstance,
  options: Expected11PremiumRouteOptions = {},
) {
  const authorize = options.authorize ?? defaultAuthorize;
  const authorizeMapping =
    options.authorizeMapping ?? options.authorize ?? defaultAuthorizeMapping;
  const mappingView = options.mappingView ?? getExpected11MappingView;
  const premiumView = options.premiumView ?? getExpected11PremiumView;
  const ensureSquads =
    options.ensureSquads ??
    (options.premiumView
      ? async () => undefined
      : async (actor: Expected11PremiumActor, force: boolean) => {
          await ensureManagerPremiumSquads(actor.mantraManagerId, { force });
          if (force) relinkPremiumSquadMappings();
        });
  const saveMapping = options.saveMapping ?? saveExpected11ManualMapping;
  const removeMapping =
    options.removeMapping ?? removeExpected11ManualMapping;
  const squadReport = options.squadReport ?? getPremiumSquadReport;
  const unpickedTops = options.unpickedTops ?? getPremiumUnpickedTops;
  const authorizeAdmin = options.authorizeAdmin ?? defaultAuthorizeMapping;
  const lookupTeamLeague = options.lookupTeamLeague ?? defaultLookupTeamLeague;
  const refreshAuctionStatus =
    options.refreshAuctionStatus ??
    ((input: RefreshPremiumLeagueInput) => refreshPremiumLeagueAfterAuction(input));
  const auctionRefreshCooldown =
    options.auctionRefreshCooldown ?? ((leagueId: number) => getAuctionRefreshCooldown(leagueId));
  const markAuctionRefresh =
    options.markAuctionRefresh ?? ((leagueId: number) => markAuctionRefreshDone(leagueId));

  async function premiumPayload(
    request: FastifyRequest,
    reply: FastifyReply,
    forceSquads: boolean,
  ) {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = request.query as {
      tournamentId?: string;
      owned?: string;
    };
    const tournamentId =
      query.tournamentId != null ? Number(query.tournamentId) : undefined;
    if (
      tournamentId != null &&
      (!Number.isSafeInteger(tournamentId) || tournamentId <= 0)
    ) {
      return reply.code(400).send({ error: "invalid_tournament_id" });
    }
    const wall = Date.now();
    if (forceSquads) {
      await ensureSquads(actor, true);
    } else {
      // First paint: return sqlite view immediately. Mantra sync in background.
      void Promise.resolve(ensureSquads(actor, false)).catch((error) => {
        console.log(`premium ensureSquads background failed: ${error?.message || error}`);
      });
    }
    const afterEnsure = Date.now();
    const payload = await premiumView(
      {
        tournamentId,
        ownedOnly: query.owned === "1" || query.owned === "true",
      },
      actor,
    );
    console.log(
      `premium json ${Date.now() - afterEnsure}ms wall=${Date.now() - wall}ms force=${forceSquads}`,
    );
    return payload;
  }

  app.get("/api/expected11/mapping", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!authorizeMapping(request, reply)) return;
    return mappingView();
  });

  app.put("/api/expected11/mapping", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorizeMapping(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as {
      sourceName?: string;
      mantraClubId?: number;
      mantraPlayerId?: number;
    };
    try {
      return saveMapping(
        {
          sourceName: String(body.sourceName ?? ""),
          mantraClubId: Number(body.mantraClubId),
          mantraPlayerId: Number(body.mantraPlayerId),
        },
        actor,
      );
    } catch (error) {
      return mappingError(error, request, reply);
    }
  });

  app.delete("/api/expected11/mapping", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeMapping(request, reply)) return;
    const body = (request.body ?? {}) as {
      sourceName?: string;
      mantraClubId?: number;
    };
    try {
      return removeMapping({
        sourceName: String(body.sourceName ?? ""),
        mantraClubId: Number(body.mantraClubId),
      });
    } catch (error) {
      return mappingError(error, request, reply);
    }
  });

  app.get("/api/expected11/premium", async (request, reply) => {
    return premiumPayload(request, reply, false);
  });

  app.post("/api/expected11/premium/refresh", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    return premiumPayload(request, reply, true);
  });

  app.get("/api/expected11/premium/refresh-auctions", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorizeAdmin(request, reply);
    if (!actor) return;
    const resolved = resolveRequestedLeague(request, reply, lookupTeamLeague);
    if (!resolved) return;
    const cooldown = auctionRefreshCooldown(resolved.leagueId);
    return {
      ok: true,
      league: resolved.leagueId,
      lastRefreshedAt: cooldown.lastRefreshedAt,
      remainingMs: cooldown.remainingMs,
      availableAt: cooldown.availableAt,
    };
  });

  app.post("/api/expected11/premium/refresh-auctions", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorizeAdmin(request, reply);
    if (!actor) return;
    const resolved = resolveRequestedLeague(request, reply, lookupTeamLeague);
    if (!resolved) return;
    const { leagueId, tournamentId, teamId } = resolved;
    const cooldown = auctionRefreshCooldown(leagueId);
    if (cooldown.remainingMs > 0) {
      return reply.code(429).send({
        error: "auction_refresh_cooldown",
        league: leagueId,
        lastRefreshedAt: cooldown.lastRefreshedAt,
        remainingMs: cooldown.remainingMs,
        availableAt: cooldown.availableAt,
      });
    }
    if (auctionRefreshLock.running) {
      return reply.code(409).send({ error: "premium_auction_refresh_busy" });
    }
    auctionRefreshLock.running = true;
    const started = Date.now();
    try {
      const result = await withTimeout(
        Promise.resolve(
          refreshAuctionStatus(
            { leagueId, tournamentId, teamId },
            actor,
          ),
        ),
        PREMIUM_AUCTION_REFRESH_TIMEOUT_MS,
        "premium auction refresh timeout",
      );
      const next = markAuctionRefresh(leagueId);
      console.log(
        `premium refresh-auctions ${Date.now() - started}ms league=${leagueId} teams=${result.teams}`,
      );
      return {
        ...result,
        lastRefreshedAt: next.lastRefreshedAt,
        remainingMs: next.remainingMs,
        availableAt: next.availableAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timeout")) {
        request.log.warn(error, "premium auction refresh timed out");
        return reply.code(504).send({
          error: "premium_auction_refresh_timeout",
          league: leagueId,
        });
      }
      request.log.error(error, "premium auction refresh failed");
      return reply.code(500).send({ error: "premium_auction_refresh_failed" });
    } finally {
      auctionRefreshLock.running = false;
    }
  });

  app.get("/api/expected11/premium/squad-report", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = request.query as { teamId?: string; fresh?: string };
    const teamId = query.teamId != null ? Number(query.teamId) : NaN;
    if (!Number.isSafeInteger(teamId) || teamId <= 0) {
      return reply.code(400).send({ error: "invalid_team_id" });
    }
    const started = Date.now();
    try {
      const view = await withTimeout(
        Promise.resolve(
          squadReport(
            {
              teamId,
              fresh: query.fresh === "1" || query.fresh === "true",
              injuries: true,
            },
            actor,
          ),
        ),
        10_000,
        "squad-report timeout",
      );
      console.log(
        `squad-report ${Date.now() - started}ms team=${teamId} players=${
          (view as { players?: unknown[] }).players?.length ?? 0
        } injuries=${
          (view as { injuryMeta?: { fotmob?: string; apiFootball?: string } }).injuryMeta
            ?.fotmob || "n/a"
        }/${
          (view as { injuryMeta?: { fotmob?: string; apiFootball?: string } }).injuryMeta
            ?.apiFootball || "n/a"
        }`,
      );
      return view;
    } catch (error) {
      console.log(`squad-report timeout ${Date.now() - started}ms team=${teamId}`);
      request.log.warn(error, "premium squad-report timed out");
      return {
        ok: false,
        teamId,
        teamName: null,
        tours: [],
        players: [],
        ratingSource: "fotmob",
        sofaScore: false,
        cachedAt: null,
        message: "Отчёт не успел за 10с — таблица Premium уже доступна, травмы подтянутся из кэша.",
        gaps: { sofaScore: true, fotmobInjuryReturn: true, injuriesTimedOut: true },
      };
    }
  });

  app.get("/api/expected11/premium/unpicked-tops", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = request.query as { teamId?: string; fresh?: string };
    const teamId = query.teamId != null ? Number(query.teamId) : NaN;
    if (!Number.isSafeInteger(teamId) || teamId <= 0) {
      return reply.code(400).send({ error: "invalid_team_id" });
    }
    const started = Date.now();
    try {
      const view = await withTimeout(
        Promise.resolve(
          unpickedTops(
            {
              teamId,
              fresh: query.fresh === "1" || query.fresh === "true",
            },
            actor,
          ),
        ),
        10_000,
        "unpicked-tops timeout",
      );
      console.log(
        `unpicked-tops ${Date.now() - started}ms team=${teamId} groups=${
          (view as { groups?: unknown[] }).groups?.length ?? 0
        }`,
      );
      return view;
    } catch (error) {
      console.log(`unpicked-tops timeout ${Date.now() - started}ms team=${teamId}`);
      request.log.warn(error, "premium unpicked-tops timed out");
      return {
        ok: false,
        teamId,
        teamName: null,
        leagueId: null,
        tours: [],
        groups: [],
        ratingSource: "fotmob",
        sofaScore: false,
        cachedAt: null,
        message: "Свободные не успели за 10с — таблица Premium уже доступна.",
      };
    }
  });
}
