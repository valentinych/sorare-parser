import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { expected11TokenMatches } from "../domain/expected11Import.js";
import { importFootmopsSnapshot } from "../domain/footmops.js";
import {
  MAX_FOOTMOPS_IMPORT_BYTES,
  normalizeFootmopsImportPayload,
} from "../domain/sorareFootmopsPublish.js";
import { leagueBySlug } from "../lib/afLeagues.js";

type FootmopsRouteOptions = {
  token?: () => string;
  database?: () => ReturnType<typeof getDb>;
};

function bearer(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

export async function footmopsRoutes(
  app: FastifyInstance,
  options: FootmopsRouteOptions = {},
) {
  const token = options.token ?? (() => config.expected11ImportToken);
  const database = options.database ?? getDb;

  app.post(
    "/api/footmops/import",
    { bodyLimit: MAX_FOOTMOPS_IMPORT_BYTES },
    async (request: FastifyRequest, reply) => {
      reply.header("Cache-Control", "no-store");
      const expectedToken = token();
      if (!expectedToken) {
        return reply.code(503).send({ error: "footmops_import_not_configured" });
      }
      if (!expected11TokenMatches(bearer(request.headers.authorization), expectedToken)) {
        return reply.code(401).send({ error: "invalid_footmops_import_token" });
      }
      try {
        const snapshot = normalizeFootmopsImportPayload(request.body);
        const tournamentId = leagueBySlug(snapshot.league)?.mantraTournamentId;
        if (!tournamentId) {
          return reply.code(400).send({ error: "invalid_footmops_league" });
        }
        const result = importFootmopsSnapshot(snapshot, database(), {
          tournamentId,
        });
        return {
          ok: true,
          ...result,
        };
      } catch (error) {
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof (error as { status: unknown }).status === "number"
            ? (error as { status: number }).status
            : 400;
        const message =
          error instanceof Error ? error.message : "footmops_import_failed";
        return reply.code(status).send({ error: message });
      }
    },
  );
}
