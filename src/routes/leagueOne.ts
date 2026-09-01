import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isLiveDraftAdmin } from "../config.js";
import {
  addLeagueOneMantraPositions,
  clearAllLeagueOneMantraPositions,
  getLeagueOneView,
  LeagueOneMappingError,
  readLeagueOneSnapshot,
  removeLeagueOneMantraPosition,
  removeLeagueOnePlayerMapping,
  saveLeagueOnePlayerMapping,
  syncLeagueOne,
} from "../domain/leagueOne.js";
import { getLeagueOneReports } from "../domain/leagueOneReports.js";
import { syncLeagueOneMatches } from "../sync/syncLeagueOneMatches.js";
import { requireSameOrigin, requireUser } from "./account.js";

function authorizeAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): { email: string; id: number } | null {
  const user = requireUser(request, reply);
  if (!user) return null;
  if (!isLiveDraftAdmin(user.email)) {
    reply.code(403).send({ error: "league_one_admin_forbidden" });
    return null;
  }
  return { email: user.email, id: user.id };
}

export async function leagueOneRoutes(app: FastifyInstance) {
  app.get("/api/league-one", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return;
    const snapshot = await readLeagueOneSnapshot();
    return getLeagueOneView(snapshot);
  });

  app.post("/api/league-one/sync", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = (request.body ?? {}) as { skipTm?: boolean; refresh?: boolean };
    try {
      const snapshot = await syncLeagueOne({
        skipTm: Boolean(body.skipTm),
        forceRefresh: Boolean(body.refresh),
      });
      return getLeagueOneView(snapshot);
    } catch (err) {
      request.log.error(err);
      reply.code(500).send({
        error: "league_one_sync_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/league-one/mantra-positions", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = (request.body ?? {}) as {
      tmPlayerIds?: unknown;
      positions?: unknown;
      position?: unknown;
    };
    const tmPlayerIds = Array.isArray(body.tmPlayerIds)
      ? body.tmPlayerIds.map((id) => String(id))
      : [];
    const positions = Array.isArray(body.positions)
      ? body.positions.map((p) => String(p))
      : body.position != null
        ? [String(body.position)]
        : [];
    if (!tmPlayerIds.length || !positions.length) {
      reply.code(400).send({ error: "league_one_mantra_positions_required" });
      return;
    }
    const result = addLeagueOneMantraPositions(tmPlayerIds, positions);
    const snapshot = await readLeagueOneSnapshot();
    return { ...getLeagueOneView(snapshot), ...result };
  });

  app.delete("/api/league-one/mantra-positions", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = (request.body ?? {}) as {
      tmPlayerId?: unknown;
      position?: unknown;
    };
    const tmPlayerId = body.tmPlayerId != null ? String(body.tmPlayerId) : "";
    const position = body.position != null ? String(body.position) : "";
    if (!tmPlayerId || !position) {
      reply.code(400).send({ error: "league_one_mantra_position_required" });
      return;
    }
    const result = removeLeagueOneMantraPosition(tmPlayerId, position);
    const snapshot = await readLeagueOneSnapshot();
    return { ...getLeagueOneView(snapshot), ...result };
  });

  app.post("/api/league-one/mantra-positions/clear", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const result = clearAllLeagueOneMantraPositions();
    const snapshot = await readLeagueOneSnapshot();
    return { ...getLeagueOneView(snapshot), ...result };
  });

  app.put("/api/league-one/mapping", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    const admin = authorizeAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as {
      tmPlayerId?: unknown;
      fotmobPlayerId?: unknown;
    };
    const tmPlayerId = body.tmPlayerId != null ? String(body.tmPlayerId) : "";
    const fotmobPlayerId =
      body.fotmobPlayerId != null ? Number(body.fotmobPlayerId) : NaN;
    try {
      const snapshot = await readLeagueOneSnapshot();
      const result = saveLeagueOnePlayerMapping(
        { tmPlayerId, fotmobPlayerId },
        admin.id,
        snapshot,
      );
      return { ...getLeagueOneView(snapshot), ...result };
    } catch (err) {
      if (err instanceof LeagueOneMappingError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/api/league-one/mapping", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = (request.body ?? {}) as { tmPlayerId?: unknown };
    const tmPlayerId = body.tmPlayerId != null ? String(body.tmPlayerId) : "";
    try {
      const result = removeLeagueOnePlayerMapping(tmPlayerId);
      if (!result.removed) {
        reply.code(404).send({ error: "league_one_mapping_not_found" });
        return;
      }
      const snapshot = await readLeagueOneSnapshot();
      return { ...getLeagueOneView(snapshot), ...result };
    } catch (err) {
      if (err instanceof LeagueOneMappingError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/api/league-one/reports", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return;
    return getLeagueOneReports();
  });

  app.post("/api/league-one/reports/sync", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    try {
      const sync = await syncLeagueOneMatches();
      const reports = await getLeagueOneReports();
      return { ...reports, sync };
    } catch (err) {
      request.log.error(err);
      reply.code(500).send({
        error: "league_one_reports_sync_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
