import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  configuredMantraAuctionIds,
  makeMantraAuctionBatches,
  mantraAuctionDetailKey,
  parseMantraAuctionCollectorArgs,
  retryCheckpointFailures,
  VERIFIED_MANTRA_AUCTION_IDS,
} from "./runMantraAuctions.js";

function player(id: number, name = `Player ${id}`) {
  return {
    mantraLeagueId: 658,
    auctionId: 2739,
    playerBidId: id,
    status: "success",
    price: 1,
    sourceUrl: `https://mantrafootball.org/api/player_bids/${id}`,
    fetchedAt: "2026-08-11T12:00:00.000Z",
    player: {
      id,
      firstName: "Test",
      name,
      avatarUrl: null,
      positions: ["CM"],
      positionsItalian: ["C"],
      club: null,
    },
    stages: [],
  };
}

const checkpoint = {
  runId: "auctions-batch-test-001",
};
const scope = { key: "super-lig" };

test("orchestrator batches by count and serialized byte budget", () => {
  const byCount = makeMantraAuctionBatches(
    checkpoint as never,
    scope as never,
    Array.from({ length: 101 }, (_, index) => player(index + 1)),
  );
  assert.deepEqual(byCount.map((batch) => batch.length), [50, 50, 1]);

  const byBytes = makeMantraAuctionBatches(
    checkpoint as never,
    scope as never,
    [player(1, "x".repeat(120_000)), player(2, "y".repeat(120_000))],
  );
  assert.deepEqual(byBytes.map((batch) => batch.length), [1, 1]);
});

test("checkpoint detail keys are stable and scope-specific", () => {
  assert.equal(mantraAuctionDetailKey(658, 2739, 297630), "658:2739:297630");
  assert.notEqual(
    mantraAuctionDetailKey(658, 2739, 297630),
    mantraAuctionDetailKey(659, 2739, 297630),
  );
});

test("verified Poland auction fallback is merged without scanning or duplicates", () => {
  assert.deepEqual(VERIFIED_MANTRA_AUCTION_IDS[583], [2364]);
  assert.deepEqual(configuredMantraAuctionIds(583, []), [2364]);
  assert.deepEqual(configuredMantraAuctionIds(583, [2364, 2400]), [2364, 2400]);
  assert.deepEqual(configuredMantraAuctionIds(584, []), []);
});

test("targeted retries request checkpoint failures once and become idempotent", async () => {
  const checkpoint = {
    runId: "auctions-retry-test-001",
    catalog: [
      {
        scopeKey: "championship",
        mantraLeagueId: 653,
        auctionId: 2714,
        status: "FINISHED",
        label: "Auction #1",
        leagueLabel: "B1 | Newport",
        sourceUrl: "https://mantrafootball.org/leagues/653/auctions/2714",
        fetchedAt: "2026-08-11T12:00:00.000Z",
        stages: [
          {
            stage: 5,
            sourceUrl:
              "https://mantrafootball.org/leagues/653/auctions/2714?round=5",
            playerBidIds: [233515],
          },
        ],
      },
    ],
    importedPlayerKeys: [],
    importedPlayers: 0,
    failedPlayerDetails: [
      {
        key: "653:2714:233515",
        error: "Mantra /api/player_bids/233515 → 500",
        attempts: 2,
      },
    ],
    batchUploads: 0,
  };
  const scope = {
    key: "championship",
    name: "Championship",
    leagueIds: [653],
  };
  let requests = 0;
  let uploads = 0;
  const deps = {
    getJson: async () => {
      requests++;
      return {
        data: {
          id: 233515,
          status: "success",
          price: 10,
          player: {
            id: 42,
            name: "Recovered",
            first_name: "Test",
            position_classic_arr: ["CM"],
            position_ital_arr: ["C"],
            club: null,
          },
          auction_bids: {},
        },
      };
    },
    uploadPlayers: async () => {
      uploads++;
    },
    save: async () => undefined,
    now: () => new Date("2026-08-11T18:00:00.000Z"),
  };

  assert.deepEqual(
    await retryCheckpointFailures(checkpoint as never, scope as never, deps),
    { requested: 1, recovered: 1, remaining: 0 },
  );
  assert.deepEqual(
    await retryCheckpointFailures(checkpoint as never, scope as never, deps),
    { requested: 0, recovered: 0, remaining: 0 },
  );
  assert.equal(requests, 1);
  assert.equal(uploads, 1);
  assert.deepEqual(checkpoint.importedPlayerKeys, ["653:2714:233515"]);
  assert.deepEqual(checkpoint.failedPlayerDetails, []);
});

test("collector --scope=ekstraklasa rediscovers Poland only", () => {
  const parsed = parseMantraAuctionCollectorArgs(["--scope=ekstraklasa"]);
  assert.equal(parsed.retryFailed, false);
  assert.equal(parsed.forceDiscover, true);
  assert.deepEqual(
    parsed.requestedScopes.map((scope) => scope.key),
    ["ekstraklasa"],
  );
  const reconcile = parseMantraAuctionCollectorArgs(["--reconcile"]);
  assert.deepEqual(
    reconcile.requestedScopes.map((scope) => scope.key),
    ["championship", "ekstraklasa"],
  );
  assert.throws(
    () => parseMantraAuctionCollectorArgs(["--scope=serie-a"]),
    /Unknown auction scope/,
  );
});

test("collector treats Bundesliga as a first-class auction scope", async () => {
  const source = await readFile(new URL("./runMantraAuctions.ts", import.meta.url), "utf8");
  assert.match(source, /key: "bundesliga"/);
  assert.match(source, /LIVE_LEAGUES\.bundesliga/);
  assert.match(source, /unsownScopes\(/);
});
