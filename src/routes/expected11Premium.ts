import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasExpected11PremiumAccess, isLiveDraftAdmin } from "../config.js";
import {
  Expected11MappingError,
  getExpected11MappingView,
  getExpected11PremiumView,
  removeExpected11ManualMapping,
  saveExpected11ManualMapping,
} from "../domain/expected11Premium.js";
import { ensureManagerPremiumSquads } from "../sync/syncManagerPremiumSquads.js";
import {
  requireSameOrigin,
  requireUser,
} from "./account.js";

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
        });
  const saveMapping = options.saveMapping ?? saveExpected11ManualMapping;
  const removeMapping =
    options.removeMapping ?? removeExpected11ManualMapping;

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
    await ensureSquads(actor, forceSquads);
    return premiumView(
      {
        tournamentId,
        ownedOnly: query.owned === "1" || query.owned === "true",
      },
      actor,
    );
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
}
