import type { FastifyInstance, FastifyReply } from "fastify";
import {
  importSorareProjections,
  normalizeImportRequest,
  SorareImportError,
} from "../domain/sorareInside.js";

const EXTENSION_ORIGIN = "chrome-extension://daolkoaipaheaaolpgnccddnipadlbnc";
const WINDOW_MS = 60_000;
const MAX_UPLOAD_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function cors(reply: FastifyReply): void {
  reply.header("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
  reply.header("Access-Control-Allow-Headers", "content-type");
  reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  reply.header("Vary", "Origin");
  reply.header("Cache-Control", "private, no-store");
}

function rateLimited(key: string, now = Date.now()): boolean {
  const recent = (attempts.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > 2_000) {
    for (const [candidate, times] of attempts) {
      if (!times.some((time) => now - time < WINDOW_MS)) attempts.delete(candidate);
    }
  }
  return recent.length > MAX_UPLOAD_ATTEMPTS;
}

export async function sorareImportRoutes(app: FastifyInstance) {
  app.options("/api/sorareinside/browser-import", async (_req, reply) => {
    cors(reply);
    return reply.code(204).send();
  });

  app.post(
    "/api/sorareinside/browser-import",
    { bodyLimit: 64 * 1024 },
    async (req, reply) => {
      cors(reply);
      const origin = req.headers.origin;
      if (origin && origin !== EXTENSION_ORIGIN) {
        return reply.code(403).send({ error: "invalid_origin" });
      }
      if (rateLimited(req.ip)) {
        reply.header("Retry-After", "60");
        return reply.code(429).send({ error: "rate_limit_exceeded" });
      }
      try {
        const request = normalizeImportRequest(req.body);
        return importSorareProjections(request);
      } catch (error) {
        if (error instanceof SorareImportError) {
          return reply.code(error.status).send({ error: error.code });
        }
        req.log.error(error, "Sorare browser import failed");
        return reply.code(500).send({ error: "browser_import_failed" });
      }
    },
  );
}
