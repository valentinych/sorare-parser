import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasLiveDraftAccess } from "../config.js";
import { getDb } from "../db/index.js";
import {
  LiveAuctionError,
  autopickLiveAuction,
  bidLiveAuction,
  correctLiveAuctionAward,
  foldLiveAuction,
  getLiveAuctionRoom,
  nominateLiveAuctionPlayer,
  releaseLiveAuctionPlayer,
  resetLiveAuction,
  searchLiveAuctionPlayers,
  setLiveAuctionTeamName,
  startLiveAuction,
  stopLiveAuction,
} from "../domain/liveAuction.js";
import { getLiveDraftStatus } from "../domain/liveDraft.js";
import { recordLiveDraftHeartbeat } from "../domain/liveDraftPresence.js";
import {
  listLiveDraftWishlist,
  parseWishlistPlayerId,
  removeLiveDraftWishlist,
  upsertLiveDraftWishlist,
} from "../domain/liveDraftWishlist.js";
import { listLiveDraftWishlistFilters } from "../domain/liveDraftWishlistFilters.js";
import { currentUser, isGoogleConfigured, requireSameOrigin } from "./account.js";

export type LiveDraftActor = {
  id: number;
  email: string;
};

type LiveDraftRouteOptions = {
  authorize?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => LiveDraftActor | null;
  statusView?: (entitled: boolean) => ReturnType<typeof getLiveDraftStatus>;
  wishlist?: {
    list: typeof listLiveDraftWishlist;
    upsert: typeof upsertLiveDraftWishlist;
    remove: typeof removeLiveDraftWishlist;
  };
  wishlistFilters?: {
    list: typeof listLiveDraftWishlistFilters;
  };
};

function defaultAuthorize(
  request: FastifyRequest,
  reply: FastifyReply,
): LiveDraftActor | null {
  const user = currentUser(request);
  if (!user) {
    reply.code(401).send({
      error: "authentication_required",
      googleConfigured: isGoogleConfigured(),
    });
    return null;
  }
  if (!hasLiveDraftAccess(user.email)) {
    reply.code(403).send({ error: "live_draft_forbidden" });
    return null;
  }
  return { id: user.id, email: user.email };
}

function sendAuctionError(reply: FastifyReply, error: unknown) {
  if (error instanceof LiveAuctionError) {
    return reply.code(error.status).send({ error: error.code });
  }
  throw error;
}

export async function liveDraftRoutes(
  app: FastifyInstance,
  options: LiveDraftRouteOptions = {},
) {
  const authorize = options.authorize ?? defaultAuthorize;
  const statusView = options.statusView ?? getLiveDraftStatus;
  const wishlist = options.wishlist ?? {
    list: listLiveDraftWishlist,
    upsert: upsertLiveDraftWishlist,
    remove: removeLiveDraftWishlist,
  };
  const wishlistFilters = options.wishlistFilters ?? {
    list: listLiveDraftWishlistFilters,
  };

  app.get("/api/live-draft/status", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    return statusView(true);
  });

  app.get("/api/live-draft/room", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    return getLiveAuctionRoom(actor.email);
  });

  app.get("/api/live-draft/players", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = String((request.query as { q?: string }).q ?? "");
    return { players: searchLiveAuctionPlayers(query) };
  });

  app.post("/api/live-draft/heartbeat", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as { pingMs?: unknown };
    const presence = recordLiveDraftHeartbeat(actor.email, body.pingMs);
    return { ok: true, pingMs: presence.pingMs };
  });

  app.post("/api/live-draft/team-name", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as { teamName?: unknown; email?: unknown };
    const forEmail =
      body.email == null || body.email === "" ? actor.email : String(body.email);
    if (
      forEmail.trim().toLocaleLowerCase() !== actor.email.trim().toLocaleLowerCase()
    ) {
      return reply.code(403).send({ error: "not_owner" });
    }
    try {
      return setLiveAuctionTeamName(actor.email, body.teamName);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/start", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    try {
      return startLiveAuction(actor.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/stop", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    try {
      return stopLiveAuction(actor.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/reset", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    try {
      return resetLiveAuction(actor.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/nominate", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as {
      playerId?: unknown;
      amount?: unknown;
      asEmail?: unknown;
    };
    const playerId = Number(body.playerId);
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      return reply.code(400).send({ error: "invalid_player" });
    }
    try {
      return nominateLiveAuctionPlayer(
        actor.email,
        playerId,
        body.amount,
        getDb(),
        { now: () => Date.now() },
        body.asEmail,
      );
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/bid", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as { amount?: unknown; asEmail?: unknown };
    try {
      return bidLiveAuction(
        actor.email,
        body.amount,
        getDb(),
        { now: () => Date.now() },
        body.asEmail,
      );
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/correct", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as {
      playerId?: unknown;
      amount?: unknown;
      email?: unknown;
    };
    const playerId = Number(body.playerId);
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      return reply.code(400).send({ error: "invalid_player" });
    }
    try {
      return correctLiveAuctionAward(actor.email, playerId, {
        amount: body.amount,
        email: body.email,
      });
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/release", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as {
      playerId?: unknown;
      email?: unknown;
    };
    const playerId = Number(body.playerId);
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      return reply.code(400).send({ error: "invalid_player" });
    }
    try {
      return releaseLiveAuctionPlayer(actor.email, playerId, body.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/fold", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    try {
      return foldLiveAuction(actor.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.post("/api/live-draft/autopick", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    try {
      return autopickLiveAuction(actor.email);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.get("/api/live-draft/wishlist", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    return wishlist.list(actor.email);
  });

  app.get("/api/live-draft/wishlist-filters", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = request.query as { club?: unknown; position?: unknown };
    return wishlistFilters.list({ club: query.club, position: query.position });
  });

  app.post("/api/live-draft/wishlist", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const body = (request.body ?? {}) as {
      playerId?: unknown;
      targetBid?: unknown;
      amount?: unknown;
    };
    const playerId = parseWishlistPlayerId(body.playerId);
    if (playerId == null) {
      return reply.code(400).send({ error: "invalid_player" });
    }
    try {
      return wishlist.upsert(actor.email, playerId, body.targetBid ?? body.amount);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });

  app.delete("/api/live-draft/wishlist", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    const actor = authorize(request, reply);
    if (!actor) return;
    const query = request.query as { playerId?: unknown };
    const body = (request.body ?? {}) as { playerId?: unknown };
    const playerId = parseWishlistPlayerId(query.playerId ?? body.playerId);
    if (playerId == null) {
      return reply.code(400).send({ error: "invalid_player" });
    }
    try {
      return wishlist.remove(actor.email, playerId);
    } catch (error) {
      return sendAuctionError(reply, error);
    }
  });
}
