import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export async function liveDraftPageRoutes(
  app: FastifyInstance,
  options: { publicDir: string },
) {
  const file = path.join(options.publicDir, "live-draft.html");

  async function send(_request: FastifyRequest, reply: FastifyReply) {
    const html = await readFile(file, "utf8");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  }

  app.get("/live-draft", send);
}
