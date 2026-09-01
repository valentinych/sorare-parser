import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import {
  getMantraAuctionFantasyTeamReport,
  getMantraAuctionFantasyTeams,
  getMantraAuctionIdealPickDetail,
  getMantraAuctionIdealPickSummaries,
  getMantraAuctionPlayers,
  getMantraAuctionPlayerHistory,
  getMantraAuctionPlayersAcrossScope,
  getMantraAuctionCoverage,
  getMantraAuctions,
  getMantraAuctionScopes,
  importMantraAuction,
  MANTRA_AUCTION_SCOPE_KEYS,
  MantraAuctionImportError,
  mantraAuctionTokenMatches,
  MAX_MANTRA_AUCTION_HISTORY_ROWS,
  MAX_MANTRA_AUCTION_IMPORT_BYTES,
  normalizeMantraAuctionImport,
  type MantraAuctionScopeKey,
} from "../domain/mantraAuctions.js";

type Options = {
  database?: () => Database.Database;
  token?: () => string;
};

function bearer(value: string | undefined): string | undefined {
  return value?.match(/^Bearer ([^\s]+)$/)?.[1];
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result <= 1_000_000 ? result : null;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) {
    return null;
  }
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= 1e9 ? result : null;
}

function validScope(value: unknown): MantraAuctionScopeKey | undefined {
  return MANTRA_AUCTION_SCOPE_KEYS.includes(value as MantraAuctionScopeKey)
    ? (value as MantraAuctionScopeKey)
    : undefined;
}

export async function mantraAuctionRoutes(
  app: FastifyInstance,
  options: Options = {},
) {
  const database = options.database ?? getDb;
  const token = options.token ?? (() => config.mantraAuctionImportToken);

  app.get("/api/auctions/scopes", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3");
    return getMantraAuctionScopes(database());
  });

  app.get("/api/auctions", async (request, reply) => {
    const query = request.query as { scope?: string; leagueId?: string };
    const scope = query.scope == null ? undefined : validScope(query.scope);
    if (query.scope != null && !scope) {
      return reply.code(400).send({ error: "invalid_mantra_auction_scope" });
    }
    const mantraLeagueId =
      query.leagueId == null ? undefined : positiveInteger(query.leagueId);
    if (query.leagueId != null && !mantraLeagueId) {
      return reply.code(400).send({ error: "invalid_mantra_auction_league" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return getMantraAuctions(database(), {
      scopeKey: scope,
      mantraLeagueId: mantraLeagueId ?? undefined,
    });
  });

  app.get("/api/auctions/coverage", async (request, reply) => {
    const query = request.query as { scope?: string };
    const scope = query.scope == null ? undefined : validScope(query.scope);
    if (query.scope != null && !scope) {
      return reply.code(400).send({ error: "invalid_mantra_auction_scope" });
    }
    reply.header("Cache-Control", "public, max-age=3");
    return getMantraAuctionCoverage(database(), scope);
  });

  app.get("/api/auctions/all/players", async (request, reply) => {
    const query = request.query as {
      scope?: string;
      page?: string;
      limit?: string;
      q?: string;
      stage?: string;
      outcome?: string;
      bidRecordsMin?: string;
      bidRecordsMax?: string;
      stagesMin?: string;
      stagesMax?: string;
      bidAmountMin?: string;
      bidAmountMax?: string;
      sort?: string;
      direction?: string;
    };
    const scope = validScope(query.scope);
    const page = query.page == null ? 1 : positiveInteger(query.page);
    const limit = query.limit == null ? 30 : positiveInteger(query.limit);
    const stage = query.stage == null ? undefined : positiveInteger(query.stage);
    const bidRecordsMin =
      query.bidRecordsMin == null ? undefined : nonNegativeInteger(query.bidRecordsMin);
    const bidRecordsMax =
      query.bidRecordsMax == null ? undefined : nonNegativeInteger(query.bidRecordsMax);
    const stagesMin =
      query.stagesMin == null ? undefined : nonNegativeInteger(query.stagesMin);
    const stagesMax =
      query.stagesMax == null ? undefined : nonNegativeInteger(query.stagesMax);
    const bidAmountMin =
      query.bidAmountMin == null ? undefined : nonNegativeNumber(query.bidAmountMin);
    const bidAmountMax =
      query.bidAmountMax == null ? undefined : nonNegativeNumber(query.bidAmountMax);
    const sort = query.sort ?? "maxBid";
    const direction = query.direction ?? "desc";
    if (
      !scope ||
      !page ||
      !limit ||
      limit > 100 ||
      (query.stage != null && !stage) ||
      (query.outcome != null && !["success", "failed"].includes(query.outcome)) ||
      (query.q != null && query.q.length > 100) ||
      (query.bidRecordsMin != null && bidRecordsMin == null) ||
      (query.bidRecordsMax != null && bidRecordsMax == null) ||
      (query.stagesMin != null && stagesMin == null) ||
      (query.stagesMax != null && stagesMax == null) ||
      (query.bidAmountMin != null && bidAmountMin == null) ||
      (query.bidAmountMax != null && bidAmountMax == null) ||
      (bidRecordsMin != null && bidRecordsMax != null && bidRecordsMin > bidRecordsMax) ||
      (stagesMin != null && stagesMax != null && stagesMin > stagesMax) ||
      (bidAmountMin != null && bidAmountMax != null && bidAmountMin > bidAmountMax) ||
      !["bidRecords", "stages", "bidAmount", "maxBid", "name"].includes(sort) ||
      !["asc", "desc"].includes(direction)
    ) {
      return reply.code(400).send({ error: "invalid_mantra_auction_filter" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return getMantraAuctionPlayersAcrossScope(database(), {
      scopeKey: scope,
      page,
      limit,
      query: query.q?.trim() || undefined,
      stage: stage ?? undefined,
      outcome: query.outcome as "success" | "failed" | undefined,
      bidRecordsMin: bidRecordsMin ?? undefined,
      bidRecordsMax: bidRecordsMax ?? undefined,
      stagesMin: stagesMin ?? undefined,
      stagesMax: stagesMax ?? undefined,
      bidAmountMin: bidAmountMin ?? undefined,
      bidAmountMax: bidAmountMax ?? undefined,
      sort: sort as "bidRecords" | "stages" | "bidAmount" | "maxBid" | "name",
      direction: direction as "asc" | "desc",
    });
  });

  app.get("/api/auctions/all/players/:playerId/history", async (request, reply) => {
    const params = request.params as { playerId: string };
    const query = request.query as {
      scope?: string;
      offset?: string;
      limit?: string;
    };
    const playerId = positiveInteger(params.playerId);
    const scope = validScope(query.scope);
    const offset = query.offset == null ? 0 : nonNegativeInteger(query.offset);
    const limit = query.limit == null ? 100 : positiveInteger(query.limit);
    if (
      !playerId ||
      !scope ||
      offset == null ||
      !limit ||
      limit > MAX_MANTRA_AUCTION_HISTORY_ROWS
    ) {
      return reply.code(400).send({ error: "invalid_mantra_auction_history" });
    }
    const history = getMantraAuctionPlayerHistory(database(), {
      scopeKey: scope,
      mantraPlayerId: playerId,
      offset,
      limit,
    });
    if (!history) {
      return reply.code(404).send({ error: "mantra_auction_player_not_found" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return history;
  });

  app.get("/api/auctions/:leagueId/:auctionId/teams", async (request, reply) => {
    const params = request.params as { leagueId: string; auctionId: string };
    const query = request.query as { scope?: string };
    const leagueId = positiveInteger(params.leagueId);
    const auctionId = positiveInteger(params.auctionId);
    const scope = validScope(query.scope);
    if (!leagueId || !auctionId || !scope) {
      return reply.code(400).send({ error: "invalid_mantra_auction_team_scope" });
    }
    const result = getMantraAuctionFantasyTeams(database(), {
      scopeKey: scope,
      mantraLeagueId: leagueId,
      auctionId,
    });
    if (!result) {
      return reply.code(404).send({ error: "mantra_auction_not_found" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return result;
  });

  app.get(
    "/api/auctions/:leagueId/:auctionId/teams/:teamId/report",
    async (request, reply) => {
      const params = request.params as {
        leagueId: string;
        auctionId: string;
        teamId: string;
      };
      const query = request.query as {
        scope?: string;
        page?: string;
        limit?: string;
      };
      const leagueId = positiveInteger(params.leagueId);
      const auctionId = positiveInteger(params.auctionId);
      const teamId = positiveInteger(params.teamId);
      const scope = validScope(query.scope);
      const page = query.page == null ? 1 : positiveInteger(query.page);
      const limit = query.limit == null ? 25 : positiveInteger(query.limit);
      if (
        !leagueId ||
        !auctionId ||
        !teamId ||
        !scope ||
        !page ||
        !limit ||
        limit > 50
      ) {
        return reply.code(400).send({ error: "invalid_mantra_auction_team_report" });
      }
      const result = getMantraAuctionFantasyTeamReport(database(), {
        scopeKey: scope,
        mantraLeagueId: leagueId,
        auctionId,
        fantasyTeamId: teamId,
        page,
        limit,
      });
      if (!result) {
        return reply.code(404).send({ error: "mantra_auction_team_not_found" });
      }
      reply.header("Cache-Control", "public, max-age=10");
      return result;
    },
  );

  app.get("/api/auctions/:leagueId/:auctionId/ideal-picks", async (request, reply) => {
    const params = request.params as { leagueId: string; auctionId: string };
    const query = request.query as { scope?: string };
    const leagueId = positiveInteger(params.leagueId);
    const auctionId = positiveInteger(params.auctionId);
    const scope = validScope(query.scope);
    if (!leagueId || !auctionId || !scope) {
      return reply.code(400).send({ error: "invalid_mantra_auction_ideal_pick_scope" });
    }
    const result = getMantraAuctionIdealPickSummaries(database(), {
      scopeKey: scope,
      mantraLeagueId: leagueId,
      auctionId,
    });
    if (!result) {
      return reply.code(404).send({ error: "mantra_auction_not_found" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return result;
  });

  app.get(
    "/api/auctions/:leagueId/:auctionId/ideal-picks/:teamId",
    async (request, reply) => {
      const params = request.params as {
        leagueId: string;
        auctionId: string;
        teamId: string;
      };
      const query = request.query as { scope?: string };
      const leagueId = positiveInteger(params.leagueId);
      const auctionId = positiveInteger(params.auctionId);
      const teamId = positiveInteger(params.teamId);
      const scope = validScope(query.scope);
      if (!leagueId || !auctionId || !teamId || !scope) {
        return reply.code(400).send({ error: "invalid_mantra_auction_ideal_pick" });
      }
      const result = getMantraAuctionIdealPickDetail(database(), {
        scopeKey: scope,
        mantraLeagueId: leagueId,
        auctionId,
        fantasyTeamId: teamId,
      });
      if (!result) {
        return reply.code(404).send({ error: "mantra_auction_ideal_pick_not_found" });
      }
      reply.header("Cache-Control", "public, max-age=10");
      return result;
    },
  );

  app.get("/api/auctions/:leagueId/:auctionId/players", async (request, reply) => {
    const params = request.params as { leagueId: string; auctionId: string };
    const leagueId = positiveInteger(params.leagueId);
    const auctionId = positiveInteger(params.auctionId);
    if (!leagueId || !auctionId) {
      return reply.code(400).send({ error: "invalid_mantra_auction_id" });
    }
    const query = request.query as {
      page?: string;
      limit?: string;
      q?: string;
      stage?: string;
      outcome?: string;
      bidRecordsMin?: string;
      bidRecordsMax?: string;
      stagesMin?: string;
      stagesMax?: string;
      bidAmountMin?: string;
      bidAmountMax?: string;
      sort?: string;
      direction?: string;
    };
    const page = query.page == null ? 1 : positiveInteger(query.page);
    const limit = query.limit == null ? 30 : positiveInteger(query.limit);
    const stage = query.stage == null ? undefined : positiveInteger(query.stage);
    const bidRecordsMin =
      query.bidRecordsMin == null ? undefined : nonNegativeInteger(query.bidRecordsMin);
    const bidRecordsMax =
      query.bidRecordsMax == null ? undefined : nonNegativeInteger(query.bidRecordsMax);
    const stagesMin =
      query.stagesMin == null ? undefined : nonNegativeInteger(query.stagesMin);
    const stagesMax =
      query.stagesMax == null ? undefined : nonNegativeInteger(query.stagesMax);
    const bidAmountMin =
      query.bidAmountMin == null ? undefined : nonNegativeNumber(query.bidAmountMin);
    const bidAmountMax =
      query.bidAmountMax == null ? undefined : nonNegativeNumber(query.bidAmountMax);
    const sort = query.sort ?? "finalPrice";
    const direction = query.direction ?? "desc";
    if (
      !page ||
      !limit ||
      limit > 100 ||
      (query.stage != null && !stage) ||
      (query.outcome != null && !["success", "failed"].includes(query.outcome)) ||
      (query.q != null && query.q.length > 100) ||
      (query.bidRecordsMin != null && bidRecordsMin == null) ||
      (query.bidRecordsMax != null && bidRecordsMax == null) ||
      (query.stagesMin != null && stagesMin == null) ||
      (query.stagesMax != null && stagesMax == null) ||
      (query.bidAmountMin != null && bidAmountMin == null) ||
      (query.bidAmountMax != null && bidAmountMax == null) ||
      (bidRecordsMin != null && bidRecordsMax != null && bidRecordsMin > bidRecordsMax) ||
      (stagesMin != null && stagesMax != null && stagesMin > stagesMax) ||
      (bidAmountMin != null && bidAmountMax != null && bidAmountMin > bidAmountMax) ||
      !["bidRecords", "stages", "bidAmount", "maxBid", "finalPrice", "name"].includes(sort) ||
      !["asc", "desc"].includes(direction)
    ) {
      return reply.code(400).send({ error: "invalid_mantra_auction_filter" });
    }
    reply.header("Cache-Control", "public, max-age=10");
    return getMantraAuctionPlayers(database(), {
      mantraLeagueId: leagueId,
      auctionId,
      page,
      limit,
      query: query.q?.trim() || undefined,
      stage: stage ?? undefined,
      outcome: query.outcome as "success" | "failed" | undefined,
      bidRecordsMin: bidRecordsMin ?? undefined,
      bidRecordsMax: bidRecordsMax ?? undefined,
      stagesMin: stagesMin ?? undefined,
      stagesMax: stagesMax ?? undefined,
      bidAmountMin: bidAmountMin ?? undefined,
      bidAmountMax: bidAmountMax ?? undefined,
      sort: sort as
        | "bidRecords"
        | "stages"
        | "bidAmount"
        | "maxBid"
        | "finalPrice"
        | "name",
      direction: direction as "asc" | "desc",
    });
  });

  app.post(
    "/api/auctions/import",
    { bodyLimit: MAX_MANTRA_AUCTION_IMPORT_BYTES },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const expected = token();
      if (!expected) {
        return reply.code(503).send({ error: "mantra_auction_import_not_configured" });
      }
      const authorization = request.headers.authorization;
      const supplied = bearer(authorization);
      if (!supplied) {
        return reply
          .header("WWW-Authenticate", "Bearer")
          .code(401)
          .send({ error: "missing_mantra_auction_import_token" });
      }
      if (!mantraAuctionTokenMatches(supplied, expected)) {
        return reply.code(403).send({ error: "invalid_mantra_auction_import_token" });
      }
      try {
        const payload = normalizeMantraAuctionImport(request.body);
        return importMantraAuction(payload, database());
      } catch (error) {
        if (error instanceof MantraAuctionImportError) {
          return reply.code(error.status).send({ error: error.code });
        }
        request.log.error(error, "Mantra auction import failed");
        return reply.code(500).send({ error: "mantra_auction_import_failed" });
      }
    },
  );
}
