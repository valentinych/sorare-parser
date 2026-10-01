import type { FastifyInstance } from "fastify";
import {
  getMantraDomaView,
  listMantraDomaApplications,
  MantraDomaApplicationError,
  upsertMantraDomaApplication,
} from "../domain/mantraDoma.js";
import { getMantraDomaStats } from "../domain/mantraDomaStats.js";
import { currentUser, requireSameOrigin, requireUser } from "./account.js";

export type MantraDomaRouteDeps = {
  getView?: typeof getMantraDomaView;
  getStats?: typeof getMantraDomaStats;
};

export async function mantraDomaRoutes(
  app: FastifyInstance,
  opts: MantraDomaRouteDeps = {},
) {
  const readView = opts.getView ?? getMantraDomaView;
  const readStats = opts.getStats ?? getMantraDomaStats;

  app.get("/api/mantra-doma", async () => {
    return readView();
  });

  app.get("/api/mantra-doma/stats", async () => {
    return readStats();
  });

  app.get("/api/mantra-doma/applications", async (request) => {
    const user = currentUser(request);
    return listMantraDomaApplications(user?.id ?? null);
  });

  app.post("/api/mantra-doma/applications", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    const user = requireUser(request, reply);
    if (!user) return;
    const body = (request.body ?? {}) as {
      teamName?: unknown;
      wantRegularAuction?: unknown;
      wantLiveAuction?: unknown;
    };
    try {
      return upsertMantraDomaApplication(user.id, body);
    } catch (error) {
      if (error instanceof MantraDomaApplicationError) {
        reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
