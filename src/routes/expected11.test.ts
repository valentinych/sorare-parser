import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {
  MAX_EXPECTED11_IMPORT_BYTES,
  type Expected11ImportPayload,
  type Expected11ViewOptions,
} from "../domain/expected11Import.js";
import { expected11Routes } from "./expected11.js";
import type { FastifyReply, FastifyRequest } from "fastify";

const emptyIngest = {
  league: "championship",
  tour: 3,
  extractedAt: null,
  importedAt: null,
  matchCount: 0,
  lastError: null,
  tours: [],
};

const stubTours = [
  {
    round: 3,
    startAt: "2026-08-22T14:00:00.000Z",
    endAt: "2026-08-23T16:00:00.000Z",
    current: true,
  },
];

function authorizeAdmin(request: FastifyRequest, reply: FastifyReply) {
  const role = request.headers["x-test-role"];
  if (!role) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (role !== "admin") {
    reply.code(403).send({ error: "expected11_admin_forbidden" });
    return null;
  }
  return { email: "aharodnik@gmail.com" };
}

function payload() {
  return {
    schemaVersion: 2,
    extractedAt: "2026-08-10T21:37:30.701Z",
    league: "championship",
    tour: 3,
    matches: [
      {
        sourceUrl: "https://expected11.com/match/19729166/home-vs-away",
        extractedAt: "2026-08-10T21:37:30.701Z",
        status: "ok",
        match: {
          id: "19729166",
          title: "Home vs Away",
          homeTeam: "Home",
          awayTeam: "Away",
          formations: [],
        },
        teams: [
          {
            side: "home",
            name: "Home",
            logoUrl: null,
            lineup: {
              starting: [
                {
                  name: "Toti",
                  displayedPercentage: 80,
                  raw: { playerPath: "/player/1/toti" },
                },
              ],
              bench: [],
              out: [],
            },
            notes: {},
            author: null,
          },
        ],
      },
    ],
  };
}

function realisticPayload() {
  const base = payload();
  const matches = Array.from({ length: 11 }, (_, matchIndex) => {
    const id = String(19729166 + matchIndex);
    const team = (side: "home" | "away", name: string) => ({
      side,
      name,
      logoUrl: null,
      lineup: {
        starting: Array.from({ length: 25 }, (_, playerIndex) => ({
          name: `${name} Player ${playerIndex + 1}`,
          displayedPercentage: 50 + (playerIndex % 5) * 10,
          raw: { playerPath: `/player/${matchIndex * 100 + playerIndex + 1}/player` },
        })),
        bench: [],
        out: [],
      },
      notes: {
        teamAnalysis: {
          label: "Team analysis",
          text: "x".repeat(4_000),
        },
      },
      author: "Expected11 editor",
    });
    return {
      ...base.matches[0]!,
      sourceUrl: `https://expected11.com/match/${id}/home-vs-away`,
      match: { ...base.matches[0]!.match, id },
      teams: [team("home", "Home"), team("away", "Away")],
    };
  });
  return { ...base, matches };
}

test("Expected11 view requests narratives only for a selected match", async (t) => {
  let narrativeMatchId: string | undefined;
  const app = Fastify();
  await app.register(expected11Routes, {
    ingestView: () => emptyIngest,
    toursForLeague: () => stubTours,
    matchIdsForTour: () => [],
    view: (options?: Expected11ViewOptions) => {
      narrativeMatchId = options?.narrativeMatchId;
      return { aggregate: {}, matches: [] } as never;
    },
  });
  t.after(() => app.close());

  await app.inject({ method: "GET", url: "/api/expected11" });
  assert.equal(narrativeMatchId, undefined);

  await app.inject({
    method: "GET",
    url: "/api/expected11?matchId=19729166",
  });
  assert.equal(narrativeMatchId, "19729166");

  await app.inject({ method: "GET", url: "/api/expected11?matchId=not-an-id" });
  assert.equal(narrativeMatchId, undefined);
});

test("Expected11 import requires the configured bearer token", async (t) => {
  let imports = 0;
  let importedScope: { league: string; tour: number } | undefined;
  const app = Fastify();
  await app.register(expected11Routes, {
    token: () => "test-secret",
    importPayload: (_payload, scope) => {
      imports += 1;
      importedScope = scope;
      return {
        scope: "snapshot",
        league: scope.league,
        tour: scope.tour,
        importedMatches: 1,
        importedTeams: 1,
        importedPlayers: 1,
        linked: 0,
        unmatched: 0,
        ambiguous: 0,
        teamLinked: 0,
        teamUnmatched: 1,
        teamAmbiguous: 0,
      };
    },
  });
  t.after(() => app.close());

  for (const authorization of [undefined, "Bearer wrong-secret"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/expected11/import",
      headers: authorization ? { authorization } : {},
      payload: payload(),
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(imports, 0);

  const response = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: payload(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().importedMatches, 1);
  assert.equal(response.json().importedPlayers, 1);
  assert.equal(response.json().league, "championship");
  assert.equal(response.json().tour, 3);
  assert.equal(imports, 1);
  assert.deepEqual(importedScope, { league: "championship", tour: 3 });
});

test("Expected11 import keeps predicted matches and reports stubs", async (t) => {
  let imported: Expected11ImportPayload | undefined;
  const app = Fastify();
  await app.register(expected11Routes, {
    token: () => "test-secret",
    importPayload: (normalized) => {
      imported = normalized;
      return {
        scope: "snapshot",
        importedMatches: normalized.matches.length,
        importedTeams: 1,
        importedPlayers: 1,
        linked: 0,
        unmatched: 1,
        ambiguous: 0,
        teamLinked: 0,
        teamUnmatched: 1,
        teamAmbiguous: 0,
        skipped: normalized.skipped,
      };
    },
  });
  t.after(() => app.close());

  const mixed = payload();
  mixed.matches.push({
    sourceUrl: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
    extractedAt: mixed.extractedAt,
    status: "no-predictions",
    match: {
      id: "19746637",
      title: "Erzurumspor FK vs Galatasaray",
      homeTeam: "Erzurumspor FK",
      awayTeam: "Galatasaray",
      formations: [],
    },
    teams: [],
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: mixed,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().importedMatches, 1);
  assert.equal(imported?.matches.length, 1);
  assert.equal(imported?.matches[0]?.id, "19729166");
  assert.deepEqual(imported?.skipped, [
    {
      url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
      error: "expected11_match_has_no_predictions",
    },
  ]);

  const stubsOnly = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: {
      schemaVersion: 2,
      extractedAt: mixed.extractedAt,
      league: "championship",
      tour: 3,
      matches: [mixed.matches[1]],
    },
  });
  assert.equal(stubsOnly.statusCode, 400);
  assert.equal(stubsOnly.json().error, "expected11_no_predicted_matches");
});

test("Expected11 import accepts a realistic multi-match payload", async (t) => {
  const app = Fastify();
  let importedPlayers = 0;
  await app.register(expected11Routes, {
    token: () => "test-secret",
    importPayload: (normalized: Expected11ImportPayload) => {
      importedPlayers = normalized.matches.reduce(
        (total, match) =>
          total +
          match.teams.reduce(
            (teamTotal, team) =>
              teamTotal +
              Object.values(team.lineup).reduce(
                (groupTotal, players) => groupTotal + players.length,
                0,
              ),
            0,
          ),
        0,
      );
      return {
        scope: "snapshot",
        importedMatches: normalized.matches.length,
        importedTeams: normalized.matches.length * 2,
        importedPlayers,
        linked: 0,
        unmatched: importedPlayers,
        ambiguous: 0,
        teamLinked: 0,
        teamUnmatched: normalized.matches.length * 2,
        teamAmbiguous: 0,
      };
    },
  });
  t.after(() => app.close());

  const realistic = realisticPayload();
  const bytes = Buffer.byteLength(JSON.stringify(realistic));
  assert.ok(bytes > 128 * 1024);
  assert.ok(bytes < MAX_EXPECTED11_IMPORT_BYTES);

  const response = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: realistic,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().importedMatches, 11);
  assert.equal(response.json().importedPlayers, 550);
});

test("Expected11 import validates URL and rejects oversized payloads", async (t) => {
  const app = Fastify();
  await app.register(expected11Routes, {
    token: () => "test-secret",
    importPayload: () => {
      throw new Error("must not import invalid payload");
    },
  });
  t.after(() => app.close());

  const malformed = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error, "invalid_expected11_payload");

  const restricted = payload();
  restricted.matches[0]!.sourceUrl = "https://example.com/match/19729166/home-vs-away";
  const invalid = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: restricted,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_expected11_url");

  const oversized = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      value: "x".repeat(MAX_EXPECTED11_IMPORT_BYTES + 1),
    }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error, "Payload Too Large");
});

test("Expected11 import requires championship and tour", async (t) => {
  const app = Fastify();
  await app.register(expected11Routes, {
    token: () => "test-secret",
    importPayload: () => {
      throw new Error("must not import without a tour");
    },
  });
  t.after(() => app.close());

  const { league: _league, tour: _tour, ...unscoped } = payload();
  const response = await app.inject({
    method: "POST",
    url: "/api/expected11/import",
    headers: { authorization: "Bearer test-secret" },
    payload: unscoped,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid_expected11_league");
});

const matchUrl = "https://expected11.com/match/1/tour";
const otherMatchUrl = "https://expected11.com/match/2/championship";

function savedIngest(includeUrls = false) {
  const base = {
    league: "championship",
    tour: 3,
    extractedAt: "2026-08-19T12:00:00.000Z",
    importedAt: "2026-08-19T12:00:01.000Z",
    matchCount: 2,
    lastError: null,
    tours: [
      {
        league: "championship",
        tour: 3,
        extractedAt: "2026-08-19T12:00:00.000Z",
        importedAt: "2026-08-19T12:00:01.000Z",
        matchCount: 2,
        lastError: null,
      },
    ],
  };
  return {
    ...base,
    ...(includeUrls
      ? { urls: [matchUrl, otherMatchUrl], skipped: [] }
      : {}),
  };
}

test("Expected11 URL ingest rejects non-admins and empty or invalid URLs", async (t) => {
  const app = Fastify();
  let saved = 0;
  await app.register(expected11Routes, {
    ingestView: (options) => savedIngest(options?.includeUrls),
    toursForLeague: () => stubTours,
    matchIdsForTour: () => ["1", "2"],
    authorizeAdmin,
    view: () =>
      ({
        aggregate: { matches: 3 },
        matches: [{ id: "1" }, { id: "2" }],
      }) as never,
    saveUrls: () => {
      saved += 1;
      throw new Error("must not save invalid urls");
    },
  });
  t.after(() => app.close());

  const payload = {
    league: "championship",
    tour: 3,
    urls: `${matchUrl}\n${otherMatchUrl}`,
  };
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/expected11/urls",
    payload,
  });
  assert.equal(unauthenticated.statusCode, 401);

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/expected11/urls",
    headers: { "x-test-role": "other" },
    payload,
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "expected11_admin_forbidden");

  const rebuildForbidden = await app.inject({
    method: "POST",
    url: "/api/expected11/rebuild",
    headers: { "x-test-role": "other" },
    payload: { league: "championship", tour: 3 },
  });
  assert.equal(rebuildForbidden.statusCode, 403);
  assert.equal(rebuildForbidden.json().error, "expected11_admin_forbidden");
  assert.equal(saved, 0);

  const emptyApp = Fastify();
  await emptyApp.register(expected11Routes, {
    ingestView: () => emptyIngest,
    toursForLeague: () => stubTours,
    matchIdsForTour: () => [],
    authorizeAdmin,
    view: () => ({ aggregate: {}, matches: [] }) as never,
  });
  t.after(() => emptyApp.close());

  const empty = await emptyApp.inject({
    method: "POST",
    url: "/api/expected11/urls",
    headers: { "x-test-role": "admin" },
    payload: { league: "championship", tour: 3, urls: "  " },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, "invalid_expected11_url");

  const invalid = await emptyApp.inject({
    method: "POST",
    url: "/api/expected11/urls",
    headers: { "x-test-role": "admin" },
    payload: {
      league: "championship",
      tour: 3,
      urls: "https://example.com/match/1",
    },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_expected11_url");
});

test("admin can save URLs per league and tour; rebuild uses stored URLs", async (t) => {
  const app = Fastify();
  let saved:
    | { league: unknown; tour: unknown; urls: unknown }
    | undefined;
  let rebuilt:
    | { league: unknown; tour: unknown; urls?: unknown }
    | undefined;
  await app.register(expected11Routes, {
    authorizeAdmin,
    actorEmail: (request) =>
      request.headers["x-test-role"] === "admin"
        ? "aharodnik@gmail.com"
        : request.headers["x-test-role"]
          ? "viewer@example.com"
          : null,
    ingestView: (options) => savedIngest(options?.includeUrls),
    toursForLeague: () => stubTours,
    matchIdsForTour: () => ["1", "2"],
    view: () =>
      ({
        aggregate: { matches: 2, linked: 10 },
        matches: [{ id: "1", title: "Tour match" }, { id: "2", title: "Other match" }],
      }) as never,
    saveUrls: (input) => {
      saved = input;
      return { import: null, ingest: savedIngest(true) };
    },
    rebuildTour: async (input) => {
      rebuilt = input;
      return {
        import: {
          scope: "snapshot",
          importedMatches: 2,
          importedTeams: 4,
          importedPlayers: 20,
          linked: 10,
          unmatched: 10,
          ambiguous: 0,
          teamLinked: 4,
          teamUnmatched: 0,
          teamAmbiguous: 0,
        },
        ingest: savedIngest(true),
      };
    },
  });
  t.after(() => app.close());

  const viewer = await app.inject({
    method: "GET",
    url: "/api/expected11?league=championship&tour=3",
    headers: { "x-test-role": "viewer" },
  });
  assert.equal(viewer.statusCode, 200);
  assert.equal(viewer.json().canEditUrls, false);
  assert.equal(viewer.json().tour, 3);
  assert.equal(viewer.json().matches.length, 2);
  assert.equal(viewer.json().ingest.matchCount, 2);
  assert.equal(viewer.json().ingest.urls, undefined);
  assert.equal(viewer.json().gazette, null);

  const adminGet = await app.inject({
    method: "GET",
    url: "/api/expected11?league=championship&tour=3",
    headers: { "x-test-role": "admin" },
  });
  assert.equal(adminGet.json().canEditUrls, true);
  assert.deepEqual(adminGet.json().ingest.urls, [matchUrl, otherMatchUrl]);

  const save = await app.inject({
    method: "POST",
    url: "/api/expected11/urls",
    headers: { "x-test-role": "admin" },
    payload: {
      league: "championship",
      tour: 3,
      urls: `${matchUrl}\n${otherMatchUrl}`,
    },
  });
  assert.equal(save.statusCode, 200);
  assert.deepEqual(saved, {
    league: "championship",
    tour: 3,
    urls: `${matchUrl}\n${otherMatchUrl}`,
  });
  assert.equal(save.json().import, null);
  assert.deepEqual(save.json().ingest.urls, [matchUrl, otherMatchUrl]);

  const rebuild = await app.inject({
    method: "POST",
    url: "/api/expected11/rebuild",
    headers: { "x-test-role": "admin" },
    payload: { league: "championship", tour: 3 },
  });
  assert.equal(rebuild.statusCode, 200);
  assert.equal(rebuilt?.league, "championship");
  assert.equal(rebuilt?.tour, 3);
  assert.equal(rebuild.json().import.importedMatches, 2);
  assert.equal(rebuild.json().matches.length, 2);
});

test("mapping payload includes Expected11 ingest results without source URLs", async (t) => {
  const { expected11PremiumRoutes } = await import("./expected11Premium.js");
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize: (request, reply) => {
      if (!request.headers["x-test-role"]) {
        reply.code(401).send({ error: "authentication_required" });
        return null;
      }
      return { id: 1, email: "viewer@example.com", mantraManagerId: null };
    },
    mappingView: () =>
      ({
        counts: { linked: 4, unmatched: 2, ambiguous: 0 },
        groups: [{ mantraClubName: "Home", players: [{ sourceName: "Mystery" }] }],
        mappings: [],
        ingest: savedIngest(false),
      }) as never,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/expected11/mapping",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().groups[0].players[0].sourceName, "Mystery");
  assert.equal(response.json().ingest.matchCount, 2);
  assert.equal(response.json().ingest.urls, undefined);
  assert.equal(response.json().ingest.tours[0].matchCount, 2);
});

test("Expected11 gazette PDF is served for a keyed league/tour and hidden otherwise", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "expected11-gazette-route-"));
  const pdf = Buffer.from("%PDF-1.7\ntrailer<<>>\n%%EOF\n", "latin1");
  writeFileSync(path.join(dir, "ekstraklasa-5.pdf"), pdf);
  const ekstraklasaTours = [
    { round: 4, startAt: null, endAt: null, current: false },
    { round: 5, startAt: null, endAt: null, current: true },
  ];
  const app = Fastify();
  await app.register(expected11Routes, {
    gazetteDir: dir,
    ingestView: () => emptyIngest,
    toursForLeague: (slug) => (slug === "ekstraklasa" ? ekstraklasaTours : stubTours),
    matchIdsForTour: () => [],
    view: () =>
      ({
        aggregate: { matches: 1, linked: 0 },
        matches: [{ id: "1", title: "Should stay hidden behind gazette" }],
      }) as never,
  });
  t.after(() => app.close());

  const championship = await app.inject({
    method: "GET",
    url: "/api/expected11?league=championship&tour=3",
  });
  assert.equal(championship.statusCode, 200);
  assert.equal(championship.json().gazette, null);

  const missingTour = await app.inject({
    method: "GET",
    url: "/api/expected11?league=ekstraklasa&tour=4",
  });
  assert.equal(missingTour.json().gazette, null);

  const gazetted = await app.inject({
    method: "GET",
    url: "/api/expected11?league=PL1&tour=5",
  });
  assert.equal(gazetted.statusCode, 200);
  assert.equal(gazetted.json().league.slug, "ekstraklasa");
  assert.equal(gazetted.json().tour, 5);
  assert.match(gazetted.json().gazette.url, /^\/api\/expected11\/gazette\/ekstraklasa\/5\?v=\d+$/);

  const file = await app.inject({
    method: "GET",
    url: gazetted.json().gazette.url,
  });
  assert.equal(file.statusCode, 200);
  assert.match(file.headers["content-type"], /application\/pdf/);
  assert.equal(file.headers["content-disposition"], 'inline; filename="ekstraklasa-5.pdf"');
  assert.equal(file.rawPayload.equals(pdf), true);

  const missingFile = await app.inject({
    method: "GET",
    url: "/api/expected11/gazette/championship/3",
  });
  assert.equal(missingFile.statusCode, 404);
  assert.equal(missingFile.json().error, "gazette_not_found");
});
