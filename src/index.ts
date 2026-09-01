import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { ekstraklasaRoutes } from "./routes/ekstraklasa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

async function main() {
  getDb();
  const app = Fastify({ logger: true });

  await app.register(ekstraklasaRoutes);
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
