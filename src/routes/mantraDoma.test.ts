import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { mantraDomaRoutes } from "./mantraDoma.js";

test("GET /api/mantra-doma/stats is public and has no session gate", async (t) => {
  const src = await readFile(new URL("./mantraDoma.ts", import.meta.url), "utf8");
  const statsBlock =
    src.match(/app\.get\("\/api\/mantra-doma\/stats"[\s\S]*?\n  \}\);/)?.[0] ?? "";
  assert.match(src, /app\.get\("\/api\/mantra-doma\/stats"/);
  assert.doesNotMatch(statsBlock, /requireUser|currentUser|authorize/);

  const app = Fastify();
  await app.register(mantraDomaRoutes, {
    getStats: () => ({
      ok: true,
      source: "fotmob",
      leagueId: 108,
      seasonStart: "2026-07-01",
      tours: [],
      players: {},
      cachedAt: null,
    }),
  });
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/api/mantra-doma/stats" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().source, "fotmob");
});
