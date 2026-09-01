import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpected11App,
  parseExpected11RunRequest,
  publishExpected11Output,
} from "../expected11-server.js";
import { memorySavedTourUrlsStore } from "../domain/expected11SavedUrls.js";
import type {
  Expected11RunOptions,
  Expected11RunResult,
} from "../sync/runExpected11.js";

const matchUrl =
  "https://expected11.com/match/19729166/wolverhampton-wanderers-vs-blackburn-rovers";

const stubTours = [
  {
    round: 2,
    startAt: "2026-08-22T11:30:00.000Z",
    endAt: "2026-08-23T11:00:00.000Z",
    current: false,
  },
  {
    round: 3,
    startAt: "2026-08-28T19:00:00.000Z",
    endAt: "2026-08-29T14:00:00.000Z",
    current: true,
  },
];

function successfulResult(): Expected11RunResult {
  return {
    outputPath: "/tmp/expected11-result.json",
    output: {
      schemaVersion: 2,
      extractedAt: "2026-08-10T20:00:00.000Z",
      matches: [
        {
          sourceUrl: matchUrl,
          extractedAt: "2026-08-10T20:00:00.000Z",
          status: "ok",
          match: {
            id: "19729166",
            title: "Wolverhampton Wanderers vs Blackburn Rovers",
            homeTeam: "Wolverhampton Wanderers",
            awayTeam: "Blackburn Rovers",
            formations: ["4-3-3", "4-2-3-1"],
          },
          teams: [
            {
              side: "home",
              name: "Wolverhampton Wanderers",
              logoUrl: "https://cdn.example.com/wolves.png",
              lineup: {
                starting: [
                  {
                    name: "Toti",
                    displayedPercentage: 80,
                    displayedLabel: "80%",
                    raw: {
                      text: "Toti\n80%",
                      ariaLabel: "80% chance of starting",
                      playerPath: "/player/1/toti",
                    },
                  },
                ],
                bench: [],
                out: [],
              },
              notes: {
                teamAnalysis: { label: "Analysis", text: "Expected to start." },
                injuriesAndRecovery: null,
                suspensionsAndIneligibilities: null,
                additionalNotes: null,
              },
              author: "Expected11 editor",
            },
          ],
          players: [
            {
              team: "Wolverhampton Wanderers",
              name: "Toti",
              lineupGroup: "starting",
              probabilities: { starter: 0.8, substitute: null, notPlaying: null },
              predictionLabel: "Toti\n80%",
              raw: {
                text: "Toti\n80%",
                ariaLabel: "80% chance of starting",
                starterText: "80% chance of starting",
                statusText: null,
                playerPath: "/player/1/toti",
              },
            },
          ],
          diagnostics: {
            accessMessage: null,
            signInVisible: false,
            pageLoading: false,
            headings: ["Starting"],
            visibleLineupCount: 1,
            restrictedPositionCount: 0,
            rawPlayerCandidateCount: 1,
            warnings: [],
          },
        },
      ],
    },
    hasFailures: false,
  };
}

function testApp(
  runner: (options: Expected11RunOptions) => Promise<Expected11RunResult> = async () =>
    successfulResult(),
  options: Parameters<typeof buildExpected11App>[1] = {},
) {
  return buildExpected11App(runner, {
    loadLatestSnapshot: async () => null,
    importToken: "test-token",
    savedUrls: memorySavedTourUrlsStore(),
    publishRequest: (async () => {
      throw new Error("publishRequest not stubbed");
    }) as typeof fetch,
    ...options,
  });
}

async function waitForState(
  app: ReturnType<typeof buildExpected11App>,
  state: string,
) {
  for (let i = 0; i < 50; i++) {
    const status = await app.inject({ method: "GET", url: "/api/status" });
    if (status.json().state === state) return status.json();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for state ${state}`);
}

function partialFailureResult(): Expected11RunResult {
  const result = successfulResult();
  return {
    ...result,
    hasFailures: true,
    output: {
      ...result.output,
      matches: [
        ...result.output.matches,
        {
          ...result.output.matches[0],
          sourceUrl: "https://expected11.com/match/1/no-predictions",
          status: "no-predictions",
          teams: [],
          players: [],
        },
      ],
    },
  };
}

test("validates and normalizes only Expected11 match URLs", () => {
  assert.deepEqual(
    parseExpected11RunRequest({
      urls: [`${matchUrl}#lineup`],
      diagnostic: true,
    }),
    {
      urls: [matchUrl],
      diagnostic: true,
      screenshot: false,
    },
  );

  assert.throws(
    () => parseExpected11RunRequest({ urls: ["https://example.com/match/1"] }),
    /Not an expected11\.com match URL/,
  );
  assert.throws(
    () =>
      parseExpected11RunRequest({
        urls: ["https://user:password@expected11.com/match/1"],
      }),
    /Not an expected11\.com match URL/,
  );
});

test("API rejects invalid input without starting the parser", async (t) => {
  let starts = 0;
  const app = testApp(async () => {
    starts += 1;
    return successfulResult();
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: ["file:///tmp/page.html"] },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Not an expected11\.com match URL/);
  assert.equal(starts, 0);
});

test("API reports busy while a run owns the browser profile", async (t) => {
  let finishRun: (() => void) | undefined;
  let receivedOptions: Expected11RunOptions | undefined;
  const gate = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const app = testApp(async (options) => {
    receivedOptions = options;
    await gate;
    return successfulResult();
  });
  t.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl], diagnostic: true },
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl] },
  });

  assert.equal(first.statusCode, 202);
  assert.equal(first.json().currentUrl, null);
  assert.match(first.json().message, /sign-in/i);
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /already active/);
  assert.deepEqual(receivedOptions?.urls, [matchUrl]);
  assert.equal(receivedOptions?.diagnostic, true);

  finishRun?.();
});

test("continue unblocks login wait without exposing match URLs first", async (t) => {
  let finishRun: (() => void) | undefined;
  const app = testApp(async (options) => {
    options.onProgress?.({
      phase: "waiting-login",
      completed: 0,
      total: 1,
      currentUrl: "https://expected11.com/sign-in",
      message: "Waiting for Expected11 email/password login in Chrome",
    });
    await options.waitForManualLogin?.("https://expected11.com/sign-in");
    options.onProgress?.({
      phase: "opening",
      completed: 0,
      total: 1,
      currentUrl: matchUrl,
      message: "Opening match 1 of 1",
    });
    await new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    return successfulResult();
  });
  t.after(() => app.close());

  const started = await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl] },
  });
  assert.equal(started.statusCode, 202);
  assert.notEqual(started.json().currentUrl, matchUrl);

  const waiting = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(waiting.json().state, "waiting-login");
  assert.equal(waiting.json().currentUrl, "https://expected11.com/sign-in");

  const continued = await app.inject({ method: "POST", url: "/api/continue" });
  assert.equal(continued.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const running = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(running.json().state, "running");
  assert.equal(running.json().currentUrl, matchUrl);

  finishRun?.();
});

test("publisher uses only the fixed production endpoint and bearer token", async () => {
  let requestUrl = "";
  let authorization = "";
  let publishedBody = "";
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    authorization = String((init?.headers as Record<string, string>)?.Authorization);
    publishedBody = String(init?.body);
    return new Response(JSON.stringify({ importedMatches: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await publishExpected11Output(
    successfulResult().output,
    "test-secret",
    { league: "championship", tour: 2 },
    request,
  );

  assert.equal(
    requestUrl,
    "https://mantra.panenka.games/api/expected11/import",
  );
  assert.equal(authorization, "Bearer test-secret");
  assert.equal(result?.importedMatches, 1);

  const published = JSON.parse(publishedBody);
  assert.equal(published.league, "championship");
  assert.equal(published.tour, 2);
  assert.equal(published.matches[0].players, undefined);
  assert.equal(published.matches[0].diagnostics, undefined);
  assert.equal(published.matches[0].teams[0].lineup.starting[0].displayedLabel, undefined);
  assert.deepEqual(published.matches[0].teams[0].lineup.starting[0].raw, {
    playerPath: "/player/1/toti",
  });
  assert.equal(
    published.matches[0].teams[0].notes.teamAnalysis.text,
    "Expected to start.",
  );
  assert.equal(published.matches[0].teams[0].author, "Expected11 editor");
});

test("local UI catalog lists championships and schedule tours", async (t) => {
  const app = testApp(async () => successfulResult(), {
    toursForLeague: async (league) => {
      assert.equal(league, "championship");
      return stubTours;
    },
  });
  t.after(() => app.close());

  const leagues = await app.inject({ method: "GET", url: "/api/leagues" });
  assert.equal(leagues.statusCode, 200);
  assert.equal(leagues.json().defaultLeague, "championship");
  assert.ok(
    leagues.json().leagues.some(
      (league: { slug: string }) => league.slug === "premier-league",
    ),
  );
  assert.ok(
    leagues.json().leagues.some((league: { slug: string }) => league.slug === "serie-a"),
  );
  assert.ok(
    leagues.json().leagues.some((league: { slug: string }) => league.slug === "bundesliga"),
  );
  assert.equal(
    leagues.json().leagues.some((league: { slug: string }) => league.slug === "la-liga"),
    false,
  );
  assert.equal(
    leagues.json().leagues.some((league: { slug: string }) => league.slug === "ligue-1"),
    false,
  );

  const tours = await app.inject({
    method: "GET",
    url: "/api/tours?league=championship",
  });
  assert.equal(tours.statusCode, 200);
  assert.equal(tours.json().league, "championship");
  assert.equal(tours.json().tours[1].round, 3);
  assert.equal(tours.json().tours[1].current, true);
});

test("publish rejects a completed result without championship and tour", async (t) => {
  const app = testApp();
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl] },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const missing = await app.inject({ method: "POST", url: "/api/publish" });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "invalid_expected11_league");
});

test("publish stays available when some matches lack predictions", async (t) => {
  let published = "";
  const app = testApp(async () => partialFailureResult(), {
    publishRequest: stubPublish((body) => {
      published = body;
    }),
  });
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl] },
  });
  const status = await waitForState(app, "completed");
  assert.equal(status.downloadReady, true);
  assert.equal(status.publishReady, true);
  assert.equal(status.failedMatchCount, 1);
  assert.equal(status.publishConfigured, true);
  assert.match(status.message, /no visible predictions/i);

  const response = await app.inject({
    method: "POST",
    url: "/api/publish",
    payload: { league: "championship", tour: 2 },
  });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(published) as { matches: { status: string }[] };
  assert.equal(payload.matches.length, 2);
  assert.equal(payload.matches.filter((match) => match.status !== "ok").length, 1);
});

test("idle UI reloads the latest snapshot from disk", async (t) => {
  const snapshot = successfulResult();
  const app = testApp(
    async () => {
      throw new Error("parser should not start");
    },
    {
      loadLatestSnapshot: async () => ({
        output: snapshot.output,
        outputPath: snapshot.outputPath,
      }),
    },
  );
  t.after(() => app.close());

  const status = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().downloadReady, true);
  assert.equal(status.json().publishReady, true);
  assert.equal(status.json().outputPath, snapshot.outputPath);
  assert.match(status.json().message, /disk/i);

  const result = await app.inject({ method: "GET", url: "/api/result" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().matches[0].match.id, "19729166");
});

test("publish can send the on-disk snapshot for a selected tour", async (t) => {
  const snapshot = successfulResult();
  let publishedTour = 0;
  const app = testApp(
    async () => {
      throw new Error("parser should not start");
    },
    {
      loadLatestSnapshot: async () => ({
        output: snapshot.output,
        outputPath: snapshot.outputPath,
      }),
      publishRequest: (async (_url: string | URL | Request, init?: RequestInit) => {
        publishedTour = JSON.parse(String(init?.body)).tour;
        return new Response(
          JSON.stringify({
            importedMatches: 1,
            importedTeams: 1,
            importedPlayers: 1,
            linked: 1,
            unmatched: 0,
            ambiguous: 0,
            league: "championship",
            tour: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    },
  );
  t.after(() => app.close());

  const published = await app.inject({
    method: "POST",
    url: "/api/publish",
    payload: { league: "championship", tour: 2 },
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().importedMatches, 1);
  assert.equal(publishedTour, 2);
});

test("status explains when the import token is missing without exposing it", async (t) => {
  const app = testApp(async () => successfulResult(), { importToken: "" });
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: "/api/run",
    payload: { urls: [matchUrl] },
  });
  const status = await waitForState(app, "completed");
  assert.equal(status.publishConfigured, false);
  assert.equal(status.publishReady, true);
  assert.equal("importToken" in status, false);
  assert.doesNotMatch(JSON.stringify(status), /test-token|Bearer /i);

  const published = await app.inject({
    method: "POST",
    url: "/api/publish",
    payload: { league: "championship", tour: 2 },
  });
  assert.equal(published.statusCode, 502);
  assert.match(published.json().error, /EXPECTED11_IMPORT_TOKEN/);
});

test("local UI keeps Publish to production visible next to Download JSON", async (t) => {
  const app = testApp();
  t.after(() => app.close());

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Download JSON/);
  assert.match(page.body, /Publish to production/);
  assert.doesNotMatch(page.body, /id="publish"[^>]*\bhidden\b/);
  assert.match(page.body, /EXPECTED11_IMPORT_TOKEN/);
  assert.match(page.body, /Сохранить ссылки/);
  assert.match(page.body, /Пересобрать и обновить прод/);
  assert.match(page.body, /saved-tour-urls\.json/);
  assert.match(page.body, /id="rebuild-publish"/);
  assert.doesNotMatch(page.body, /publishButton\.hidden/);
  assert.doesNotMatch(page.body, /they will still be included/);
  assert.match(
    page.body,
    /production will skip those stubs and merge the rest/,
  );
});

function stubPublish(onPublish?: (body: string) => void) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onPublish?.(String(init?.body));
    return new Response(
      JSON.stringify({
        importedMatches: 1,
        importedTeams: 1,
        importedPlayers: 1,
        linked: 1,
        unmatched: 0,
        ambiguous: 0,
        league: "championship",
        tour: 3,
        skipped: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

test("saves match URLs per championship and tour without starting the parser", async (t) => {
  let starts = 0;
  const store = memorySavedTourUrlsStore();
  const app = testApp(
    async () => {
      starts += 1;
      return successfulResult();
    },
    { savedUrls: store },
  );
  t.after(() => app.close());

  const saved = await app.inject({
    method: "POST",
    url: "/api/saved-urls",
    payload: {
      league: "championship",
      tour: 3,
      urls: [`${matchUrl}#lineup`, "https://expected11.com/match/2/other"],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().urls, [
    matchUrl,
    "https://expected11.com/match/2/other",
  ]);
  assert.equal(starts, 0);

  const loaded = await app.inject({
    method: "GET",
    url: "/api/saved-urls?league=championship&tour=3",
  });
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loaded.json(), {
    league: "championship",
    tour: 3,
    urls: [matchUrl, "https://expected11.com/match/2/other"],
  });

  const otherTour = await app.inject({
    method: "GET",
    url: "/api/saved-urls?league=championship&tour=2",
  });
  assert.deepEqual(otherTour.json().urls, []);
});

test("rebuild-and-publish parses saved URLs then merges into production", async (t) => {
  let receivedUrls: string[] | undefined;
  let publishedBody = "";
  const store = memorySavedTourUrlsStore({
    "championship:3": [matchUrl],
  });
  const app = testApp(
    async (options) => {
      receivedUrls = options.urls;
      await options.waitForManualLogin?.("https://expected11.com/sign-in");
      return successfulResult();
    },
    {
      savedUrls: store,
      publishRequest: stubPublish((body) => {
        publishedBody = body;
      }),
    },
  );
  t.after(() => app.close());

  const started = await app.inject({
    method: "POST",
    url: "/api/rebuild-and-publish",
    payload: { league: "championship", tour: 3 },
  });
  assert.equal(started.statusCode, 202);
  assert.notEqual(started.json().currentUrl, matchUrl);

  const waiting = await waitForState(app, "waiting-login");
  assert.equal(waiting.currentUrl, "https://expected11.com/sign-in");

  const continued = await app.inject({ method: "POST", url: "/api/continue" });
  assert.equal(continued.statusCode, 200);

  const completed = await waitForState(app, "completed");
  assert.deepEqual(receivedUrls, [matchUrl]);
  assert.match(completed.message, /Published championship tour 3/);
  assert.match(completed.message, /linked 1/);
  const published = JSON.parse(publishedBody);
  assert.equal(published.league, "championship");
  assert.equal(published.tour, 3);
  assert.equal(published.matches[0].match.id, "19729166");
});

test("rebuild-and-publish stores textarea URLs then uses them", async (t) => {
  let receivedUrls: string[] | undefined;
  const store = memorySavedTourUrlsStore();
  const app = testApp(
    async (options) => {
      receivedUrls = options.urls;
      return successfulResult();
    },
    {
      savedUrls: store,
      publishRequest: stubPublish(),
    },
  );
  t.after(() => app.close());

  const started = await app.inject({
    method: "POST",
    url: "/api/rebuild-and-publish",
    payload: { league: "championship", tour: 3, urls: [matchUrl] },
  });
  assert.equal(started.statusCode, 202);
  await waitForState(app, "completed");
  assert.deepEqual(receivedUrls, [matchUrl]);
  assert.deepEqual(await store.get("championship", 3), [matchUrl]);
});

test("rebuild-and-publish rejects a tour with no saved URLs", async (t) => {
  const app = testApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/rebuild-and-publish",
    payload: { league: "championship", tour: 3 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /No saved match URLs/);
});

test("rebuild-and-publish does not start when the import token is missing", async (t) => {
  let starts = 0;
  const app = testApp(
    async () => {
      starts += 1;
      return successfulResult();
    },
    {
      importToken: "",
      savedUrls: memorySavedTourUrlsStore({ "championship:3": [matchUrl] }),
    },
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/rebuild-and-publish",
    payload: { league: "championship", tour: 3 },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /EXPECTED11_IMPORT_TOKEN/);
  assert.equal(starts, 0);
  assert.doesNotMatch(JSON.stringify(response.json()), /test-token|Bearer /i);
});

