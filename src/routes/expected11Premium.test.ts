import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  expected11PremiumRoutes,
  type Expected11PremiumActor,
} from "./expected11Premium.js";

function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const role = request.headers["x-test-role"];
  if (!role) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (role !== "entitled") {
    reply.code(403).send({ error: "expected11_premium_forbidden" });
    return null;
  }
  return {
    id: 1,
    email: "owner@example.com",
    mantraManagerId: 99,
  };
}

test("Mapping and Premium APIs enforce 401, 403, and authorized access", async (t) => {
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize,
    mappingView: () => ({ counts: { linked: 1 }, groups: [], mappings: [] }) as never,
    premiumView: () => ({ rows: [{ mantraPlayerId: 1 }] }) as never,
  });
  t.after(() => app.close());

  for (const url of ["/api/expected11/mapping", "/api/expected11/premium"]) {
    const unauthenticated = await app.inject({ method: "GET", url });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error, "authentication_required");

    const forbidden = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-role": "other" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error, "expected11_premium_forbidden");

    const authorized = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-role": "entitled" },
    });
    assert.equal(authorized.statusCode, 200);
  }
});

test("authorized Mapping mutations pass session actor and payload", async (t) => {
  const app = Fastify();
  let saved:
    | {
        sourceName: string;
        mantraClubId: number;
        mantraPlayerId: number;
        actor: Expected11PremiumActor;
      }
    | undefined;
  let removed: { sourceName: string; mantraClubId: number } | undefined;
  await app.register(expected11PremiumRoutes, {
    authorize,
    saveMapping: (
      input: {
        sourceName: string;
        mantraClubId: number;
        mantraPlayerId: number;
      },
      actor: Expected11PremiumActor,
    ) => {
      saved = { ...input, actor };
      return { ok: true } as never;
    },
    removeMapping: (input: { sourceName: string; mantraClubId: number }) => {
      removed = input;
      return { ok: true } as never;
    },
  });
  t.after(() => app.close());

  const save = await app.inject({
    method: "PUT",
    url: "/api/expected11/mapping",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {
      sourceName: "Player",
      mantraClubId: 10,
      mantraPlayerId: 20,
    },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(saved?.sourceName, "Player");
  assert.equal(saved?.actor.email, "owner@example.com");

  const remove = await app.inject({
    method: "DELETE",
    url: "/api/expected11/mapping",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { sourceName: "Player", mantraClubId: 10 },
  });
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(removed, { sourceName: "Player", mantraClubId: 10 });
});

test("Premium refresh is same-origin POST and forces a squad pull", async (t) => {
  const app = Fastify();
  const pulls: Array<{ id: number; force: boolean }> = [];
  await app.register(expected11PremiumRoutes, {
    authorize,
    premiumView: () => ({ rows: [{ mantraPlayerId: 7 }] }) as never,
    ensureSquads: (actor, force) => {
      pulls.push({ id: actor.mantraManagerId ?? 0, force });
    },
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const crossOrigin = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
    headers: {
      "x-test-role": "entitled",
      origin: "https://evil.example",
      host: "localhost:3000",
    },
  });
  assert.equal(crossOrigin.statusCode, 403);

  const first = await app.inject({
    method: "GET",
    url: "/api/expected11/premium",
    headers: { "x-test-role": "entitled" },
  });
  const refresh = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().rows[0]?.mantraPlayerId, 7);
  assert.deepEqual(pulls, [
    { id: 99, force: false },
    { id: 99, force: true },
  ]);
});
