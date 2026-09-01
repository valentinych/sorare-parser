import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  getMantraAuctionCoverage,
  getMantraAuctionFantasyTeamReport,
  getMantraAuctionFantasyTeams,
  getMantraAuctionIdealPickDetail,
  getMantraAuctionIdealPickSummaries,
  getMantraAuctionPlayerHistory,
  getMantraAuctionPlayers,
  getMantraAuctionPlayersAcrossScope,
  getMantraAuctionScopes,
  getMantraAuctions,
  importMantraAuction,
  MANTRA_AUCTION_SCHEMA,
  normalizeMantraImageUrl,
  normalizeMantraAuctionImport,
  simulateMantraAuctionIdealPicks,
} from "./mantraAuctions.js";

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      tm_url TEXT,
      avatar_path TEXT
    );
    ${MANTRA_AUCTION_SCHEMA}
  `);
  return db;
}

const runId = "auctions-test-run-001";
const now = "2026-08-11T12:00:00.000Z";

function seed(db: Database.Database) {
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "seed",
      runId,
      startedAt: now,
      scopes: [
        { key: "super-lig", name: "Süper Lig", mantraLeagueIds: [658] },
        { key: "championship", name: "Championship", mantraLeagueIds: [651, 652] },
        { key: "ekstraklasa", name: "Ekstraklasa", mantraLeagueIds: [583, 584] },
      ],
    }),
    db,
  );
}

function catalog(db: Database.Database) {
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "catalog",
      runId,
      scopeKey: "super-lig",
      auctions: [
        {
          mantraLeagueId: 658,
          auctionId: 2739,
          status: "FINISHED",
          label: "Auction #1",
          leagueLabel: "A1 | Istanbul",
          sourceUrl: "https://mantrafootball.org/leagues/658/auctions/2739",
          fetchedAt: now,
          stages: [
            {
              stage: 1,
              sourceUrl:
                "https://mantrafootball.org/leagues/658/auctions/2739?round=1",
              playerBidIds: [20],
            },
            {
              stage: 2,
              sourceUrl:
                "https://mantrafootball.org/leagues/658/auctions/2739?round=2",
              playerBidIds: [20],
            },
          ],
        },
      ],
    }),
    db,
  );
}

function batch() {
  return normalizeMantraAuctionImport({
    schemaVersion: 1,
    operation: "batch",
    runId,
    scopeKey: "super-lig",
    players: [
      {
        mantraLeagueId: 658,
        auctionId: 2739,
        playerBidId: 20,
        status: "success",
        price: 19,
        sourceUrl: "https://mantrafootball.org/api/player_bids/20",
        fetchedAt: now,
        player: {
          id: 8718,
          firstName: "Melih",
          name: "Ibrahimoglu",
          avatarUrl:
            "https://mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/melih.png",
          positions: ["CM"],
          positionsItalian: ["C"],
          club: {
            id: 382,
            name: "Konyaspor",
            logoUrl:
              "https://mantrafootball.s3.eu-west-1.amazonaws.com/club_logo/konyaspor.png",
          },
        },
        stages: [
          {
            stage: 1,
            bids: [
              {
                id: 200,
                order: 1,
                status: "failed",
                price: 18,
                team: {
                  id: 1,
                  name: "First",
                  logoUrl:
                    "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/first.png",
                },
              },
              {
                id: 201,
                order: 2,
                status: "success",
                price: 19,
                team: {
                  id: 2,
                  name: "Winner",
                  logoUrl:
                    "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/winner.png",
                },
              },
            ],
          },
          {
            stage: 2,
            bids: [
              {
                id: 202,
                order: 1,
                status: "failed",
                price: 5,
                team: {
                  id: 3,
                  name: "Later bidder",
                  logoUrl: null,
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

test("batch upserts are transactional and idempotent", () => {
  const db = database();
  seed(db);
  catalog(db);
  const payload = batch();
  importMantraAuction(payload, db);
  importMantraAuction(payload, db);

  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM mantra_auction_players`).get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM mantra_auction_bids`).get() as { n: number }).n,
    3,
  );
  const scopes = getMantraAuctionScopes(db);
  assert.equal(scopes.scopes[0]?.players, 1);
  assert.equal(scopes.scopes[0]?.winners, 1);
  assert.equal(scopes.scopes[0]?.bidAmountSum, 42);
});

test("Mantra image URLs allow only canonical image paths and safe relatives", () => {
  assert.equal(
    normalizeMantraImageUrl("/player_avatars/jesus_imaz.png"),
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/jesus_imaz.png",
  );
  assert.equal(
    normalizeMantraImageUrl(
      "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/default.png",
    ),
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/default.png",
  );
  assert.equal(
    normalizeMantraImageUrl(
      "https://mantrafootball.s3.eu-west-1.amazonaws.com/user_logos/991/1ef41146cdb6d9bb413fcee8.png",
    ),
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/user_logos/991/1ef41146cdb6d9bb413fcee8.png",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://127.0.0.1/player_avatars/x.png",
    "https://localhost/player_avatars/x.png",
    "https://user:pass@mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/x.png",
    "http://mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/x.png",
    "https://example.com/player_avatars/x.png",
    "//169.254.169.254/latest/meta-data",
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/private/x.png",
  ]) {
    assert.equal(normalizeMantraImageUrl(value), null, value);
  }
});

test("auction imports reject non-allowlisted image URLs", () => {
  const payload = JSON.parse(JSON.stringify(batch()));
  payload.players[0].player.avatarUrl = "https://127.0.0.1/player.png";
  assert.throws(
    () => normalizeMantraAuctionImport(payload),
    /invalid_mantra_auction_avatar_url/,
  );
});

test("auction imports drop default Mantra app logos instead of rejecting the batch", () => {
  const payload = JSON.parse(JSON.stringify(batch()));
  const defaultLogo =
    "https://mantrafootball.org/assets/default_logo-36d0fff29c873e0788d4ab989d54c91d40bcf58ebf0150fb18526d61a2729787.png";
  payload.players[0].player.club.logoUrl = defaultLogo;
  payload.players[0].stages[0].bids[0].team.logoUrl = defaultLogo;
  const imported = normalizeMantraAuctionImport(payload);
  assert.equal(imported.players[0]?.player.club?.logoUrl, null);
  assert.equal(imported.players[0]?.stages[0]?.bids[0]?.team?.logoUrl, null);
});

test("Premier League and Serie A can be seeded without resetting existing scopes", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "championship",
      status: "complete",
      phase: "complete",
      completed: 2,
      total: 2,
      error: null,
      requestStats: { requestStarts: 4, retries: 0, responses429: 0 },
      updatedAt: now,
    }),
    db,
  );

  const extraRunId = "auctions-pl-sa-test-001";
  const premierIds = Array.from({ length: 48 }, (_, index) => 684 + index);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "seed",
      runId: extraRunId,
      startedAt: now,
      scopes: [
        {
          key: "premier-league",
          name: "Premier League",
          mantraLeagueIds: premierIds,
        },
        { key: "serie-a", name: "Serie A", mantraLeagueIds: [742, 765] },
      ],
    }),
    db,
  );

  const scopes = getMantraAuctionScopes(db).scopes;
  assert.deepEqual(
    scopes.map((scope) => scope.scopeKey),
    ["super-lig", "championship", "ekstraklasa", "premier-league", "serie-a"],
  );
  const championship = scopes.find((scope) => scope.scopeKey === "championship")!;
  assert.notEqual(championship.status, "pending");
  assert.deepEqual(championship.mantraLeagueIds, [651, 652]);
  const premier = scopes.find((scope) => scope.scopeKey === "premier-league")!;
  assert.equal(premier.status, "pending");
  assert.equal(premier.name, "Premier League");
  assert.equal(premier.mantraLeagueIds.length, 48);
  const serieA = scopes.find((scope) => scope.scopeKey === "serie-a")!;
  assert.equal(serieA.status, "pending");
  assert.deepEqual(serieA.mantraLeagueIds, [742, 765]);

  assert.throws(
    () =>
      normalizeMantraAuctionImport({
        schemaVersion: 1,
        operation: "seed",
        runId: extraRunId,
        startedAt: now,
        scopes: [{ key: "la-liga", name: "La Liga", mantraLeagueIds: [1] }],
      }),
    /invalid_mantra_auction_scope/,
  );
});

test("Bundesliga can be seeded without resetting existing scopes", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "championship",
      status: "complete",
      phase: "complete",
      completed: 2,
      total: 2,
      error: null,
      requestStats: { requestStarts: 4, retries: 0, responses429: 0 },
      updatedAt: now,
    }),
    db,
  );

  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "seed",
      runId: "auctions-bundesliga-test-001",
      startedAt: now,
      scopes: [
        {
          key: "bundesliga",
          name: "Bundesliga",
          mantraLeagueIds: Array.from({ length: 15 }, (_, index) => 770 + index),
        },
      ],
    }),
    db,
  );

  const scopes = getMantraAuctionScopes(db).scopes;
  assert.deepEqual(
    scopes.map((scope) => scope.scopeKey),
    ["super-lig", "championship", "ekstraklasa", "bundesliga"],
  );
  const championship = scopes.find((scope) => scope.scopeKey === "championship")!;
  assert.notEqual(championship.status, "pending");
  const bundesliga = scopes.find((scope) => scope.scopeKey === "bundesliga")!;
  assert.equal(bundesliga.status, "pending");
  assert.equal(bundesliga.name, "Bundesliga");
  assert.equal(bundesliga.mantraLeagueIds.length, 15);
  assert.equal(bundesliga.mantraLeagueIds[0], 770);
  assert.equal(bundesliga.mantraLeagueIds.at(-1), 784);
});

test("coverage records no-auction and restricted leagues explicitly", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "coverage",
      runId,
      scopeKey: "championship",
      leagues: [
        {
          mantraLeagueId: 651,
          name: "Cardiff",
          division: "A1",
          seasonId: 8,
          tournamentId: 11,
          registryStatus: "active",
          accessState: "accessible",
          auctionState: "no-auction",
          auctionIds: [],
          sourceUrl: "https://mantrafootball.org/leagues/651",
          evidence: "official registry and authenticated league page",
          discoveredAt: now,
        },
        {
          mantraLeagueId: 652,
          name: "Swansea",
          division: "A2",
          seasonId: 8,
          tournamentId: 11,
          registryStatus: "active",
          accessState: "restricted",
          auctionState: "restricted",
          auctionIds: [],
          sourceUrl: "https://mantrafootball.org/leagues/652",
          evidence: "official registry; HTTP 403",
          discoveredAt: now,
        },
      ],
    }),
    db,
  );

  const coverage = getMantraAuctionCoverage(db, "championship");
  assert.deepEqual(
    coverage.leagues.map((league) => ({
      id: league.mantraLeagueId,
      access: league.accessState,
      auction: league.auctionState,
      auctions: league.auctions.length,
    })),
    [
      { id: 651, access: "accessible", auction: "no-auction", auctions: 0 },
      { id: 652, access: "restricted", auction: "restricted", auctions: 0 },
    ],
  );
  const scope = getMantraAuctionScopes(db).scopes.find(
    (item) => item.scopeKey === "championship",
  )!;
  assert.equal(scope.discoveredLeagues, 2);
  assert.equal(scope.availableLeagues, 1);
  assert.equal(scope.leaguesWithAuctions, 0);
});

test("coverage math requires every exposed auction and detail", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "coverage",
      runId,
      scopeKey: "super-lig",
      leagues: [
        {
          mantraLeagueId: 658,
          name: "Istanbul",
          division: "A1",
          seasonId: 8,
          tournamentId: 21,
          registryStatus: "active",
          accessState: "accessible",
          auctionState: "available",
          auctionIds: [2739, 2740],
          sourceUrl: "https://mantrafootball.org/leagues/658",
          evidence: "two explicit auction links",
          discoveredAt: now,
        },
      ],
    }),
    db,
  );
  catalog(db);
  importMantraAuction(batch(), db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "complete",
      runId,
      scopeKey: "super-lig",
      completedAt: now,
      auctions: [{ mantraLeagueId: 658, auctionId: 2739 }],
    }),
    db,
  );

  const scope = getMantraAuctionScopes(db).scopes[0]!;
  assert.equal(scope.availableAuctions, 2);
  assert.equal(scope.collectedAuctions, 1);
  assert.equal(scope.missingAuctionCount, 1);
  assert.equal(scope.detailsProcessed, 1);
  assert.equal(scope.detailsTotal, 1);
  assert.equal(scope.coverageComplete, false);
  const auctions = getMantraAuctionCoverage(db, "super-lig").leagues[0]!.auctions;
  assert.deepEqual(
    auctions.map((auction) => auction.collectionStatus),
    ["complete", "missing"],
  );
});

test("empty pending auctions are non-browsable without changing coverage", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "coverage",
      runId,
      scopeKey: "super-lig",
      leagues: [
        {
          mantraLeagueId: 658,
          name: "Istanbul",
          division: "A1",
          seasonId: 8,
          tournamentId: 21,
          registryStatus: "active",
          accessState: "accessible",
          auctionState: "available",
          auctionIds: [2739, 2740, 2741, 2742, 2743, 2744, 2745],
          sourceUrl: "https://mantrafootball.org/leagues/658",
          evidence: "seven explicit auction links",
          discoveredAt: now,
        },
      ],
    }),
    db,
  );
  const insert = db.prepare(
    `INSERT INTO mantra_auctions
       (mantra_league_id, auction_id, scope_key, sync_run_id, status, label,
        league_label, source_url, fetched_at, completed_at)
     VALUES (658, ?, 'super-lig', ?, ?, NULL, 'A1 | Istanbul', ?, ?, NULL)`,
  );
  for (const [auctionId, status] of [
    [2739, "pending"],
    [2740, "running"],
    [2741, "error"],
    [2742, "partial"],
    [2743, "discovering"],
    [2744, "pending"],
    [2745, "🏁 FINISHED"],
  ] as Array<[number, string]>) {
    insert.run(
      auctionId,
      runId,
      status,
      `https://mantrafootball.org/leagues/658/auctions/${auctionId}`,
      now,
    );
  }
  db.prepare(
    `INSERT INTO mantra_auction_stages
       (mantra_league_id, auction_id, stage, source_url, player_bid_ids_json,
        sync_run_id, fetched_at)
     VALUES (658, 2744, 1,
       'https://mantrafootball.org/leagues/658/auctions/2744', '[20]', ?, ?)`,
  ).run(runId, now);

  let auctions = getMantraAuctions(db, { mantraLeagueId: 658 }).auctions;
  assert.equal(auctions.find((row) => row.auctionId === 2739)?.browsable, false);
  assert.equal(auctions.find((row) => row.auctionId === 2745)?.browsable, false);
  for (const auctionId of [2740, 2741, 2742, 2743, 2744]) {
    assert.equal(auctions.find((row) => row.auctionId === auctionId)?.browsable, true);
  }
  assert.equal(auctions.find((row) => row.auctionId === 2744)?.detailsTotal, 1);
  assert.equal(
    getMantraAuctionCoverage(db, "super-lig").leagues[0]?.auctionIds.length,
    7,
  );
  assert.equal(
    getMantraAuctionFantasyTeams(db, {
      scopeKey: "super-lig",
      mantraLeagueId: 658,
      auctionId: 2739,
    }),
    null,
  );

  db.prepare(
    `INSERT INTO mantra_auction_stages
       (mantra_league_id, auction_id, stage, source_url, player_bid_ids_json,
        sync_run_id, fetched_at)
     VALUES (658, 2739, 1,
       'https://mantrafootball.org/leagues/658/auctions/2739', '[]', ?, ?)`,
  ).run(runId, now);
  auctions = getMantraAuctions(db, { mantraLeagueId: 658 }).auctions;
  assert.equal(auctions.find((row) => row.auctionId === 2739)?.browsable, true);
});

test("progress is evidence-based and monotonic within a run", () => {
  const db = database();
  seed(db);
  const progress = (completed: number, total: number | null, status = "running") =>
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "super-lig",
      status,
      phase: "collecting",
      completed,
      total,
      error: null,
      requestStats: { requestStarts: 10, retries: 0, responses429: 0 },
      updatedAt: now,
    });

  importMantraAuction(progress(1, 2), db);
  assert.throws(
    () => importMantraAuction(progress(0, 2), db),
    /non_monotonic_mantra_auction_progress/,
  );
  importMantraAuction(progress(1, 3), db);
  assert.throws(
    () => importMantraAuction(progress(1, 2), db),
    /changed_mantra_auction_total/,
  );
  assert.throws(
    () => normalizeMantraAuctionImport({
      ...(progress(1, 3) as object),
      status: "complete",
    }),
    /invalid_mantra_auction_completion/,
  );
  importMantraAuction(progress(3, 3, "complete"), db);
  assert.equal(getMantraAuctionScopes(db).scopes[0]?.percent, 100);
});

test("localized upstream failures transition error to partial and then complete", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "coverage",
      runId,
      scopeKey: "championship",
      leagues: [651, 652].map((mantraLeagueId) => ({
        mantraLeagueId,
        name: mantraLeagueId === 651 ? "Cardiff" : "Swansea",
        division: mantraLeagueId === 651 ? "A1" : "A2",
        seasonId: 8,
        tournamentId: 11,
        registryStatus: "active",
        accessState: "accessible",
        auctionState: "no-auction",
        auctionIds: [],
        sourceUrl: `https://mantrafootball.org/leagues/${mantraLeagueId}`,
        evidence: "official registry and authenticated league page",
        discoveredAt: now,
      })),
    }),
    db,
  );
  const progress = (
    status: "error" | "partial" | "complete",
    completed: number,
    failedCount: number,
  ) =>
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "championship",
      status,
      phase: status,
      completed,
      total: 2,
      error:
        status === "partial"
          ? `${failedCount} записей временно недоступны в API Mantra; доступные данные сохранены.`
          : status === "error"
            ? "raw upstream stack and URL"
            : null,
      requestStats: { requestStarts: 14, retries: 3, responses429: 1 },
      failedCount,
      lastRetryAt: status === "error" ? null : "2026-08-11T18:00:00.000Z",
      updatedAt: "2026-08-11T18:00:00.000Z",
    });

  importMantraAuction(progress("error", 1, 1), db);
  importMantraAuction(progress("partial", 1, 1), db);
  let scope = getMantraAuctionScopes(db).scopes.find(
    (item) => item.scopeKey === "championship",
  )!;
  assert.equal(scope.status, "partial");
  assert.equal(scope.failedCount, 1);
  assert.equal(scope.lastRetryAt, "2026-08-11T18:00:00.000Z");
  assert.equal("lastError" in scope, false);

  importMantraAuction(progress("complete", 2, 0), db);
  scope = getMantraAuctionScopes(db).scopes.find(
    (item) => item.scopeKey === "championship",
  )!;
  assert.equal(scope.status, "complete");
  assert.equal(scope.failedCount, 0);
  assert.equal(scope.percent, 100);
});

test("fatal errors remain distinct when no safe progress is available", () => {
  const db = database();
  seed(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "ekstraklasa",
      status: "error",
      phase: "validation failed",
      completed: 0,
      total: null,
      error: "internal validation details",
      requestStats: { requestStarts: 0, retries: 0, responses429: 0 },
      failedCount: 0,
      lastRetryAt: null,
      updatedAt: now,
    }),
    db,
  );
  const scope = getMantraAuctionScopes(db).scopes.find(
    (item) => item.scopeKey === "ekstraklasa",
  )!;
  assert.equal(scope.status, "error");
  assert.equal(scope.failedCount, 0);
  assert.equal("lastError" in scope, false);
});

test("a new seeded run retries Poland from error through real discovery phases", () => {
  const db = database();
  seed(db);
  const progress = (status: string, phase: string) =>
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "ekstraklasa",
      status,
      phase,
      completed: 0,
      total: null,
      error: status === "error" ? "sanitized discovery error" : null,
      requestStats: { requestStarts: 1, retries: 0, responses429: 0 },
      updatedAt: now,
    });
  importMantraAuction(progress("error", "discovery complete"), db);
  assert.equal(
    getMantraAuctionScopes(db).scopes.find((scope) => scope.scopeKey === "ekstraklasa")
      ?.status,
    "error",
  );
  importMantraAuction(progress("discovering", "verified fallback"), db);
  importMantraAuction(progress("running", "collecting"), db);
  assert.equal(
    getMantraAuctionScopes(db).scopes.find((scope) => scope.scopeKey === "ekstraklasa")
      ?.status,
    "running",
  );
});

test("read API data is paginated, filtered, and uses Transfermarkt profile IDs", () => {
  const db = database();
  seed(db);
  catalog(db);
  importMantraAuction(batch(), db);
  db.prepare(`INSERT INTO mantra_players (id, tm_url, avatar_path) VALUES (?, ?, ?)`).run(
    8718,
    "https://www.transfermarkt.com/melih-ibrahimoglu/profil/spieler/340574",
    "/player_avatars/canonical-melih.png",
  );

  const result = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
    page: 1,
    limit: 10,
    query: "melih",
    stage: 1,
    outcome: "success",
  });
  assert.equal(result.total, 1);
  assert.equal(result.players[0]?.profilePlayerId, "340574");
  assert.equal(result.players[0]?.profileUrl, "/player.html?id=340574");
  assert.equal(
    result.players[0]?.avatarUrl,
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/canonical-melih.png",
  );
  assert.equal(result.players[0]?.bidRecordCount, 3);
  assert.equal(result.players[0]?.stageCount, 2);
  assert.equal(result.players[0]?.bidAmountSum, 42);
  assert.deepEqual(result.players[0]?.maxBid, {
    amount: 19,
    fantasyTeamId: 2,
    fantasyTeamName: "Winner",
    fantasyTeamLogoUrl:
      "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/winner.png",
    fantasyLeagueId: 658,
    fantasyLeagueName: "A1 | Istanbul",
    auctionId: 2739,
    stage: 1,
    bidId: 201,
    sourceUrl: "https://mantrafootball.org/leagues/658/auctions/2739?round=1",
    winner: true,
  });
  assert.equal(result.preliminary, true);
  assert.equal(
    result.players[0]?.stages.flatMap((stage) => stage.bids)
      .filter((bid) => bid.status === "success").length,
    1,
  );

  const none = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
    query: "not present",
  });
  assert.equal(none.total, 0);
});

test("fantasy-team report uses successful stages, stable IDs, and honest minimums", () => {
  const db = database();
  seed(db);
  catalog(db);
  importMantraAuction(batch(), db);
  const player = (
    playerBidId: number,
    mantraPlayerId: number,
    bids: Array<{
      id: number;
      order: number;
      status: string;
      price: number;
      team: { id: number; name: string; logoUrl: null };
    }>,
  ) => ({
    mantraLeagueId: 658,
    auctionId: 2739,
    playerBidId,
    status: "success",
    price: bids.find((bid) => bid.status === "success")?.price ?? null,
    sourceUrl: `https://mantrafootball.org/api/player_bids/${playerBidId}`,
    fetchedAt: now,
    player: {
      id: mantraPlayerId,
      firstName: "Report",
      name: `Player ${playerBidId}`,
      avatarUrl: null,
      positions: ["CM"],
      positionsItalian: ["C"],
      club: null,
    },
    stages: [{ stage: 1, bids }],
  });
  const reportBatch = normalizeMantraAuctionImport({
    schemaVersion: 1,
    operation: "batch",
    runId,
    scopeKey: "super-lig",
    players: [
      player(21, 9001, [
        {
          id: 210,
          order: 1,
          status: "success",
          price: 10,
          team: { id: 2, name: "Winner", logoUrl: null },
        },
      ]),
      player(22, 9002, [
        {
          id: 220,
          order: 1,
          status: "failed",
          price: 99,
          team: { id: 2, name: "Winner", logoUrl: null },
        },
        {
          id: 221,
          order: 2,
          status: "failed",
          price: 10,
          team: { id: 3, name: "Other", logoUrl: null },
        },
        {
          id: 222,
          order: 3,
          status: "success",
          price: 10,
          team: { id: 2, name: "Winner", logoUrl: null },
        },
      ]),
      player(23, 9003, [
        {
          id: 230,
          order: 1,
          status: "success",
          price: 7,
          team: { id: 2, name: "Winner", logoUrl: null },
        },
      ]),
      player(24, 9004, [
        {
          id: 240,
          order: 1,
          status: "success",
          price: 4,
          team: { id: 4, name: "Winner", logoUrl: null },
        },
      ]),
    ],
  });
  importMantraAuction(reportBatch, db);
  importMantraAuction(reportBatch, db);
  db.prepare(
    `UPDATE mantra_auction_stages
     SET player_bid_ids_json = '[20,21,22,23,24]'
     WHERE mantra_league_id = 658 AND auction_id = 2739 AND stage = 1`,
  ).run();
  db.prepare(
    `DELETE FROM mantra_auction_bids
     WHERE mantra_league_id = 658 AND auction_id = 2739 AND bid_id = 230`,
  ).run();
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "complete",
      runId,
      scopeKey: "super-lig",
      completedAt: now,
      auctions: [{ mantraLeagueId: 658, auctionId: 2739 }],
    }),
    db,
  );

  const teams = getMantraAuctionFantasyTeams(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
  })!;
  assert.deepEqual(
    teams.teams.map((team) => [team.fantasyTeamId, team.name, team.wonPickCount]),
    [
      [2, "Winner", 4],
      [4, "Winner", 1],
    ],
  );
  assert.equal(teams.collectionComplete, true);
  assert.equal(teams.isPartial, true);
  const winnerSummary = teams.teams.find((team) => team.fantasyTeamId === 2)!;
  assert.deepEqual(
    {
      actual: winnerSummary.actual,
      actualKnown: winnerSummary.actualKnown,
      minimum: winnerSummary.minimum,
      minimumKnown: winnerSummary.minimumKnown,
      difference: winnerSummary.difference,
      differenceKnown: winnerSummary.differenceKnown,
      partial: winnerSummary.isPartial,
      minimumUnknownCount: winnerSummary.completeness.minimumUnknownCount,
    },
    {
      actual: null,
      actualKnown: 46,
      minimum: null,
      minimumKnown: 31,
      difference: null,
      differenceKnown: 8,
      partial: true,
      minimumUnknownCount: 1,
    },
  );
  const sameNameSummary = teams.teams.find((team) => team.fantasyTeamId === 4)!;
  assert.deepEqual(
    [
      sameNameSummary.actual,
      sameNameSummary.minimum,
      sameNameSummary.difference,
      sameNameSummary.isPartial,
    ],
    [4, 1, 3, false],
  );

  const first = getMantraAuctionFantasyTeamReport(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
    fantasyTeamId: 2,
    page: 1,
    limit: 2,
  })!;
  assert.equal(first.total, 4);
  assert.equal(first.picks.length, 2);
  assert.equal(first.pages, 2);
  const byPlayer = getMantraAuctionFantasyTeamReport(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
    fantasyTeamId: 2,
    limit: 50,
  })!;
  const pick20 = byPlayer.picks.find((pick) => pick.playerBidId === 20)!;
  const noCompetitor = byPlayer.picks.find((pick) => pick.playerBidId === 21)!;
  const tie = byPlayer.picks.find((pick) => pick.playerBidId === 22)!;
  const missingWinner = byPlayer.picks.find((pick) => pick.playerBidId === 23)!;
  assert.deepEqual(
    [pick20.actual, pick20.runnerUp?.fantasyTeamId, pick20.theoreticalMinimum],
    [19, 1, 19],
  );
  assert.deepEqual(
    [noCompetitor.actual, noCompetitor.runnerUp, noCompetitor.theoreticalMinimum],
    [10, null, 1],
  );
  assert.deepEqual(
    [tie.actual, tie.runnerUp?.amount, tie.theoreticalMinimum, tie.difference],
    [10, 10, 11, -1],
  );
  assert.deepEqual(
    [
      missingWinner.actual,
      missingWinner.actualProvenance,
      missingWinner.theoreticalMinimum,
      missingWinner.incompleteReason,
    ],
    [7, "stage_outcome", null, "winning_bid_record_missing"],
  );
  assert.deepEqual(byPlayer.totals, {
    actual: null,
    actualKnown: 46,
    theoreticalMinimum: null,
    theoreticalMinimumKnown: 31,
    difference: null,
    differenceKnown: 8,
  });
  assert.deepEqual(
    [
      winnerSummary.actualKnown,
      winnerSummary.minimumKnown,
      winnerSummary.differenceKnown,
    ],
    [
      byPlayer.totals.actualKnown,
      byPlayer.totals.theoreticalMinimumKnown,
      byPlayer.totals.differenceKnown,
    ],
  );
  assert.equal(byPlayer.partial, true);
  assert.equal(byPlayer.completeness.minimumUnknownCount, 1);
  assert.equal(
    getMantraAuctionFantasyTeamReport(db, {
      scopeKey: "championship",
      mantraLeagueId: 658,
      auctionId: 2739,
      fantasyTeamId: 2,
    }),
    null,
  );
  assert.equal(
    getMantraAuctionFantasyTeamReport(db, {
      scopeKey: "super-lig",
      mantraLeagueId: 658,
      auctionId: 2739,
      fantasyTeamId: 999,
    }),
    undefined,
  );

  db.prepare(
    `UPDATE mantra_auctions SET completed_at = NULL
     WHERE mantra_league_id = 658 AND auction_id = 2739`,
  ).run();
  const incompleteAuction = getMantraAuctionFantasyTeamReport(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
    fantasyTeamId: 4,
  })!;
  assert.equal(incompleteAuction.collectionComplete, false);
  assert.equal(incompleteAuction.partial, true);
  assert.equal(incompleteAuction.totals.actual, null);
  assert.equal(incompleteAuction.totals.actualKnown, 4);
  assert.equal(incompleteAuction.totals.theoreticalMinimum, null);
  assert.equal(incompleteAuction.totals.theoreticalMinimumKnown, 1);
});

test("zero-stage players expose zero aggregates and completion removes preliminary marker", () => {
  const db = database();
  seed(db);
  catalog(db);
  const empty = batch() as Extract<ReturnType<typeof batch>, { operation: "batch" }>;
  empty.players[0]!.stages = [];
  importMantraAuction(empty, db);
  let result = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
  });
  assert.deepEqual(
    {
      bids: result.players[0]?.bidRecordCount,
      stages: result.players[0]?.stageCount,
      sum: result.players[0]?.bidAmountSum,
      preliminary: result.preliminary,
    },
    { bids: 0, stages: 0, sum: 0, preliminary: true },
  );

  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "complete",
      runId,
      scopeKey: "super-lig",
      completedAt: now,
      auctions: [{ mantraLeagueId: 658, auctionId: 2739 }],
    }),
    db,
  );
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "progress",
      runId,
      scopeKey: "super-lig",
      status: "complete",
      phase: "complete",
      completed: 1,
      total: 1,
      error: null,
      requestStats: { requestStarts: 1, retries: 0, responses429: 0 },
      updatedAt: now,
    }),
    db,
  );
  result = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
  });
  assert.equal(result.preliminary, false);
});

test("aggregate ranges and numeric sorts compose with existing player filters", () => {
  const db = database();
  seed(db);
  catalog(db);
  importMantraAuction(batch(), db);
  const second = JSON.parse(JSON.stringify(batch())) as Extract<
    ReturnType<typeof batch>,
    { operation: "batch" }
  >;
  const player = second.players[0]!;
  player.playerBidId = 21;
  player.sourceUrl = "https://mantrafootball.org/api/player_bids/21";
  player.player.id = 9000;
  player.player.firstName = "Lower";
  player.player.name = "Aggregate";
  for (const stage of player.stages) {
    for (const bid of stage.bids) {
      bid.id += 100;
      bid.price = bid.order;
    }
  }
  importMantraAuction(second, db);

  const sorted = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
    sort: "bidAmount",
    direction: "desc",
  });
  assert.deepEqual(
    sorted.players.map((row) => row.playerBidId),
    [20, 21],
  );
  const maxSorted = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
    sort: "maxBid",
    direction: "desc",
  });
  assert.deepEqual(
    maxSorted.players.map((row) => row.playerBidId),
    [20, 21],
  );
  const filtered = getMantraAuctionPlayers(db, {
    mantraLeagueId: 658,
    auctionId: 2739,
    query: "melih",
    stage: 1,
    outcome: "success",
    bidRecordsMin: 3,
    bidRecordsMax: 3,
    stagesMin: 2,
    stagesMax: 2,
    bidAmountMin: 40,
    bidAmountMax: 50,
    sort: "bidRecords",
    direction: "asc",
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.players[0]?.playerBidId, 20);
});

test("all-auctions mode merges only stable player IDs and keeps deterministic max provenance", () => {
  const db = database();
  seed(db);
  catalog(db);
  importMantraAuction(batch(), db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "catalog",
      runId,
      scopeKey: "super-lig",
      auctions: [2740, 2741].map((auctionId) => ({
        mantraLeagueId: 658,
        auctionId,
        status: "FINISHED",
        label: `Auction ${auctionId}`,
        leagueLabel: "A1 | Istanbul",
        sourceUrl: `https://mantrafootball.org/leagues/658/auctions/${auctionId}`,
        fetchedAt: now,
        stages: [1, 2].map((stage) => ({
          stage,
          sourceUrl:
            `https://mantrafootball.org/leagues/658/auctions/${auctionId}?round=${stage}`,
          playerBidIds: auctionId === 2741 ? [40, 41, 42] : [30],
        })),
      })),
    }),
    db,
  );
  const basePlayer = {
    status: "failed",
    price: null,
    fetchedAt: now,
    player: {
      id: 8718,
      firstName: "Melih",
      name: "Ibrahimoglu",
      avatarUrl: null,
      positions: ["CM"],
      positionsItalian: ["C"],
      club: null,
    },
  };
  const crossAuctionBatch = normalizeMantraAuctionImport({
    schemaVersion: 1,
    operation: "batch",
    runId,
    scopeKey: "super-lig",
    players: [
      {
        ...basePlayer,
        mantraLeagueId: 658,
        auctionId: 2740,
        playerBidId: 30,
        sourceUrl: "https://mantrafootball.org/api/player_bids/30",
        stages: [{
          stage: 1,
          bids: [{
            id: 300,
            order: 1,
            status: "failed",
            price: 100,
            team: { id: 30, name: "Older tie", logoUrl: null },
          }],
        }],
      },
      {
        ...basePlayer,
        mantraLeagueId: 658,
        auctionId: 2741,
        playerBidId: 40,
        sourceUrl: "https://mantrafootball.org/api/player_bids/40",
        stages: [
          {
            stage: 1,
            bids: [{
              id: 400,
              order: 1,
              status: "failed",
              price: 100,
              team: { id: 40, name: "Earlier stage", logoUrl: null },
            }],
          },
          {
            stage: 2,
            bids: [{
              id: 401,
              order: 1,
              status: "failed",
              price: 100,
              team: { id: 41, name: "Earlier bid", logoUrl: null },
            }],
          },
        ],
      },
      {
        ...basePlayer,
        mantraLeagueId: 658,
        auctionId: 2741,
        playerBidId: 42,
        sourceUrl: "https://mantrafootball.org/api/player_bids/42",
        stages: [{
          stage: 2,
          bids: [{
            id: 403,
            order: 1,
            status: "success",
            price: 100,
            team: {
              id: 43,
              name: "Newest stable bid",
              logoUrl:
                "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/newest.png",
            },
          }],
        }],
      },
      {
        ...basePlayer,
        mantraLeagueId: 658,
        auctionId: 2741,
        playerBidId: 41,
        sourceUrl: "https://mantrafootball.org/api/player_bids/41",
        player: { ...basePlayer.player, id: 9000 },
        stages: [{
          stage: 2,
          bids: [{
            id: 402,
            order: 1,
            status: "failed",
            price: 90,
            team: { id: 42, name: "Same name, other ID", logoUrl: null },
          }],
        }],
      },
    ],
  });
  importMantraAuction(crossAuctionBatch, db);
  importMantraAuction(crossAuctionBatch, db);

  const result = getMantraAuctionPlayersAcrossScope(db, {
    scopeKey: "super-lig",
    sort: "maxBid",
    direction: "desc",
  });
  assert.equal(result.mode, "all");
  assert.equal(result.contentAuctionCount, 3);
  assert.equal(result.total, 2);
  const merged = result.players.find((player) => player.mantraPlayerId === 8718)!;
  const sameNameOtherId = result.players.find((player) => player.mantraPlayerId === 9000)!;
  assert.deepEqual(
    {
      bidRecords: merged.bidRecordCount,
      stages: merged.stageCount,
      auctions: merged.auctionCount,
      total: merged.totalBidAmount,
      max: merged.maxBidAmount,
    },
    { bidRecords: 7, stages: 5, auctions: 3, total: 442, max: 100 },
  );
  assert.equal(sameNameOtherId.bidRecordCount, 1);
  assert.equal(sameNameOtherId.totalBidAmount, 90);
  assert.deepEqual(merged.maxBid, {
    amount: 100,
    fantasyTeamId: 43,
    fantasyTeamName: "Newest stable bid",
    fantasyTeamLogoUrl:
      "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/newest.png",
    fantasyLeagueId: 658,
    fantasyLeagueName: "A1 | Istanbul",
    auctionId: 2741,
    stage: 2,
    bidId: 403,
    sourceUrl: "https://mantrafootball.org/leagues/658/auctions/2741?round=2",
    winner: true,
  });

  const filtered = getMantraAuctionPlayersAcrossScope(db, {
    scopeKey: "super-lig",
    query: "melih",
    stage: 1,
    outcome: "success",
    bidRecordsMin: 7,
    bidRecordsMax: 7,
    stagesMin: 5,
    stagesMax: 5,
    bidAmountMin: 442,
    bidAmountMax: 442,
    sort: "bidAmount",
    direction: "desc",
    page: 1,
    limit: 1,
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.pages, 1);
  assert.equal(filtered.players[0]?.mantraPlayerId, 8718);
});

test("canonical player history groups, orders, deduplicates, and bounds cross-league rows", () => {
  const db = database();
  seed(db);
  db.prepare(
    `UPDATE mantra_auction_jobs
     SET mantra_league_ids_json = '[658,659]'
     WHERE scope_key = 'super-lig'`,
  ).run();
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "coverage",
      runId,
      scopeKey: "super-lig",
      leagues: [
        {
          mantraLeagueId: 658,
          name: "Alpha League",
          division: "A1",
          seasonId: 8,
          tournamentId: 21,
          registryStatus: "active",
          accessState: "accessible",
          auctionState: "available",
          auctionIds: [2739],
          sourceUrl: "https://mantrafootball.org/leagues/658",
          evidence: "test fixture",
          discoveredAt: now,
        },
        {
          mantraLeagueId: 659,
          name: "Beta League",
          division: "A2",
          seasonId: 8,
          tournamentId: 21,
          registryStatus: "active",
          accessState: "accessible",
          auctionState: "available",
          auctionIds: [2800],
          sourceUrl: "https://mantrafootball.org/leagues/659",
          evidence: "test fixture",
          discoveredAt: now,
        },
      ],
    }),
    db,
  );
  catalog(db);
  importMantraAuction(
    normalizeMantraAuctionImport({
      schemaVersion: 1,
      operation: "catalog",
      runId,
      scopeKey: "super-lig",
      auctions: [{
        mantraLeagueId: 659,
        auctionId: 2800,
        status: "RUNNING",
        label: "Auction #2",
        leagueLabel: "A2 | Beta",
        sourceUrl: "https://mantrafootball.org/leagues/659/auctions/2800",
        fetchedAt: now,
        stages: [{
          stage: 1,
          sourceUrl: "https://mantrafootball.org/leagues/659/auctions/2800?round=1",
          playerBidIds: [30, 31],
        }],
      }],
    }),
    db,
  );
  importMantraAuction(batch(), db);
  const betaBatch = normalizeMantraAuctionImport({
    schemaVersion: 1,
    operation: "batch",
    runId,
    scopeKey: "super-lig",
    players: [
      {
        mantraLeagueId: 659,
        auctionId: 2800,
        playerBidId: 30,
        status: "success",
        price: 30,
        sourceUrl: "https://mantrafootball.org/api/player_bids/30",
        fetchedAt: now,
        player: {
          id: 8718,
          firstName: "Melih",
          name: "Ibrahimoglu",
          avatarUrl: null,
          positions: ["CM"],
          positionsItalian: ["C"],
          club: null,
        },
        stages: [{
          stage: 1,
          bids: [
            {
              id: 300,
              order: 1,
              status: "failed",
              price: 30,
              team: { id: 30, name: "Thirty", logoUrl: null },
            },
            {
              id: 301,
              order: 2,
              status: "success",
              price: 30,
              team: { id: 31, name: "Winner", logoUrl: null },
            },
          ],
        }],
      },
      {
        mantraLeagueId: 659,
        auctionId: 2800,
        playerBidId: 31,
        status: "failed",
        price: null,
        sourceUrl: "https://mantrafootball.org/api/player_bids/31",
        fetchedAt: now,
        player: {
          id: 9000,
          firstName: "Melih",
          name: "Ibrahimoglu",
          avatarUrl: null,
          positions: ["CM"],
          positionsItalian: ["C"],
          club: null,
        },
        stages: [{
          stage: 1,
          bids: [{
            id: 302,
            order: 1,
            status: "failed",
            price: 99,
            team: { id: 32, name: "Other player", logoUrl: null },
          }],
        }],
      },
    ],
  });
  importMantraAuction(betaBatch, db);
  importMantraAuction(betaBatch, db);

  const first = getMantraAuctionPlayerHistory(db, {
    scopeKey: "super-lig",
    mantraPlayerId: 8718,
    limit: 2,
  })!;
  assert.deepEqual(first.counts, {
    fantasyLeagues: 2,
    auctions: 2,
    stages: 3,
    bids: 5,
  });
  assert.equal(first.partial, true);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.leagues[0]?.fantasyLeagueName, "Alpha League");
  assert.deepEqual(
    first.leagues[0]?.auctions[0]?.stages[0]?.bids.map((bid) => bid.id),
    [201, 200],
  );

  const last = getMantraAuctionPlayerHistory(db, {
    scopeKey: "super-lig",
    mantraPlayerId: 8718,
    offset: first.nextOffset!,
    limit: 20,
  })!;
  assert.equal(last.truncated, false);
  assert.equal(last.leagues.at(-1)?.fantasyLeagueName, "Beta League");
  assert.deepEqual(
    last.leagues.at(-1)?.auctions[0]?.stages[0]?.bids.map((bid) => bid.id),
    [301, 300],
  );

  const sameName = getMantraAuctionPlayerHistory(db, {
    scopeKey: "super-lig",
    mantraPlayerId: 9000,
  })!;
  assert.equal(sameName.counts.bids, 1);
  assert.equal(sameName.leagues[0]?.auctions[0]?.stages[0]?.bids[0]?.id, 302);
  assert.equal(
    getMantraAuctionPlayerHistory(db, {
      scopeKey: "championship",
      mantraPlayerId: 8718,
    }),
    null,
  );
});

test("rejects oversized, malformed, and cross-scope imports without mutation", () => {
  const db = database();
  seed(db);
  catalog(db);
  const wrong = batch() as Extract<ReturnType<typeof batch>, { operation: "batch" }>;
  wrong.players[0]!.mantraLeagueId = 651;
  assert.throws(
    () => importMantraAuction(wrong, db),
    /cross_scope_mantra_auction_data/,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM mantra_auction_players`).get() as { n: number }).n,
    0,
  );
  assert.throws(
    () =>
      normalizeMantraAuctionImport({
        schemaVersion: 1,
        operation: "batch",
        runId,
        scopeKey: "super-lig",
        players: [],
        padding: "x".repeat(300 * 1024),
      }),
    /mantra_auction_payload_too_large/,
  );
});

test("ideal picks use exact ranking, independent managers, prices, and actual owners", () => {
  const candidate = (
    playerBidId: number,
    mantraPlayerId: number,
    stage: number,
    outcome: string | null = null,
    winningTeamId: number | null = null,
    winningPrice: number | null = null,
  ) => ({
    playerBidId,
    mantraPlayerId,
    firstName: "Ideal",
    name: `Player ${mantraPlayerId}`,
    avatarUrl: null,
    canonicalAvatarUrl: null,
    tmUrl: null,
    positions: ["CM"],
    stage,
    stageSourceUrl: `https://mantrafootball.org/auction?round=${stage}`,
    playerSourceUrl: `https://mantrafootball.org/api/player_bids/${playerBidId}`,
    outcome,
    winningPrice,
    winningTeamId,
    winningTeamName: winningTeamId == null ? null : winningTeamId === 1 ? "Manager" : "Same",
    winningTeamLogoUrl: null,
  });
  const bid = (
    bidId: number,
    playerBidId: number,
    stage: number,
    fantasyTeamId: number,
    price: number,
    status = "failed",
  ) => ({
    bidId,
    playerBidId,
    stage,
    fantasyTeamId,
    fantasyTeamName: fantasyTeamId === 1 ? "Manager" : "Same",
    fantasyTeamLogoUrl: null,
    price,
    status,
  });
  const bids = [
    bid(1, 101, 1, 1, 30),
    bid(2, 101, 1, 2, 31, "success"),
    bid(3, 105, 1, 1, 25, "success"),
    bid(4, 103, 1, 2, 20, "success"),
    bid(5, 102, 1, 2, 20),
    bid(6, 102, 1, 3, 10),
    bid(7, 104, 1, 2, 19),
    bid(8, 202, 2, 3, 15, "success"),
    bid(8, 202, 2, 3, 15, "success"),
  ];
  const result = simulateMantraAuctionIdealPicks({
    targetCount: 5,
    auctionSourceUrl: "https://mantrafootball.org/auction",
    collectionComplete: true,
    missingDetailCount: 0,
    participants: [
      { fantasyTeamId: 1, name: "Manager", logoUrl: null },
      { fantasyTeamId: 2, name: "Same", logoUrl: null },
      { fantasyTeamId: 3, name: "Same", logoUrl: null },
    ],
    candidates: [
      candidate(101, 1001, 1, "success", 2, 31),
      candidate(105, 1005, 1, "success", 1, 25),
      candidate(103, 1003, 1, "success", 2, 20),
      candidate(102, 1002, 1, "failed"),
      candidate(104, 1004, 1),
      candidate(201, 1001, 2),
      candidate(202, 1002, 2, "success", 3, 15),
    ],
    bids,
  });
  const manager = result.simulations.find((team) => team.fantasyTeamId === 1)!;
  assert.deepEqual(
    manager.picks.map((pick) => pick.mantraPlayerId),
    [1001, 1005, 1003, 1002, 1004],
  );
  assert.equal(manager.picks[0]?.managerOriginalBid, 30);
  assert.equal(manager.picks[2]?.managerOriginalBid, 0);
  assert.deepEqual(
    [
      manager.picks[3]?.stageMaxBid,
      manager.picks[3]?.stageAverageBidNumerator,
      manager.picks[3]?.stageAverageBidCount,
      manager.picks[3]?.stageAverageBid,
    ],
    [20, 30, 2, 15],
  );
  assert.deepEqual(
    [
      manager.picks[0]?.requiredIdealBid,
      manager.picks[4]?.requiredIdealBid,
      manager.provisionalIdealTotal,
      manager.idealTotal,
    ],
    [32, 20, 95, 95],
  );
  assert.deepEqual(
    manager.picks.map((pick) => pick.actualRelationship),
    ["same_stage_outbid", "manager_won", "same_stage_outbid", "won_later", "no_winner"],
  );
  assert.equal(manager.picks[0]?.actualWinningBidGap, 1);
  assert.equal(manager.picks[2]?.actualWinningBidGap, null);
  assert.deepEqual(
    [manager.actuallyAcquiredCount, manager.missedTargetCount, manager.missedUnknownOutcomeCount],
    [1, 4, 1],
  );
  assert.deepEqual(
    manager.whoOutbid.map((group) => [group.fantasyTeamId, group.count]),
    [
      [2, 2],
      [3, 1],
    ],
  );
  assert.equal(
    manager.whoOutbid.reduce((sum, group) => sum + group.count, 0),
    manager.missedWithKnownCompetitorCount,
  );
  assert.equal(manager.whoOutbid.some((group) => group.fantasyTeamId === 1), false);
  const other = result.simulations.find((team) => team.fantasyTeamId === 2)!;
  assert.notDeepEqual(
    other.picks.map((pick) => pick.requiredIdealBid),
    manager.picks.map((pick) => pick.requiredIdealBid),
  );
  assert.equal(new Set(manager.picks.map((pick) => pick.mantraPlayerId)).size, 5);
});

test("ideal picks mark latest successful outcome ambiguity, deficits, and partial totals", () => {
  const base = {
    firstName: null,
    name: "Repeated",
    avatarUrl: null,
    canonicalAvatarUrl: null,
    tmUrl: null,
    positions: [] as string[],
    playerSourceUrl: "https://mantrafootball.org/api/player_bids/1",
    winningTeamName: "Competitor",
    winningTeamLogoUrl: null,
  };
  const result = simulateMantraAuctionIdealPicks({
    targetCount: 2,
    auctionSourceUrl: "https://mantrafootball.org/auction",
    collectionComplete: false,
    missingDetailCount: 1,
    participants: [
      { fantasyTeamId: 1, name: "Manager", logoUrl: null },
      { fantasyTeamId: 2, name: "Competitor", logoUrl: null },
      { fantasyTeamId: 3, name: "Competitor", logoUrl: null },
    ],
    candidates: [
      {
        ...base,
        playerBidId: 1,
        mantraPlayerId: 10,
        stage: 1,
        stageSourceUrl: "https://mantrafootball.org/auction?round=1",
        outcome: "success",
        winningPrice: 5,
        winningTeamId: 2,
      },
      {
        ...base,
        playerBidId: 2,
        mantraPlayerId: 10,
        stage: 2,
        stageSourceUrl: "https://mantrafootball.org/auction?round=2",
        outcome: "success",
        winningPrice: 7,
        winningTeamId: 3,
      },
    ],
    bids: [],
  });
  const manager = result.simulations.find((team) => team.fantasyTeamId === 1)!;
  assert.equal(manager.selectedCount, 1);
  assert.equal(manager.deficit, 1);
  assert.equal(manager.idealTotal, null);
  assert.equal(manager.provisionalIdealTotal, 1);
  assert.equal(manager.actuallyAcquiredCount, null);
  assert.equal(manager.missedTargetCount, null);
  assert.equal(manager.picks[0]?.actualRelationship, "won_later");
  assert.equal(manager.picks[0]?.actualWinner?.fantasyTeamId, 3);
  assert.equal(manager.picks[0]?.actualOutcomeAmbiguous, true);
  assert.equal(manager.whoOutbid[0]?.exactCount, null);
});

test("ideal picks traverse stages chronologically and stop at 26 distinct players", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    playerBidId: index + 1,
    mantraPlayerId: index + 1,
    firstName: null,
    name: `P${index + 1}`,
    avatarUrl: null,
    canonicalAvatarUrl: null,
    tmUrl: null,
    positions: [],
    stage: index < 20 ? 1 : 2,
    stageSourceUrl: `https://mantrafootball.org/auction?round=${index < 20 ? 1 : 2}`,
    playerSourceUrl: `https://mantrafootball.org/api/player_bids/${index + 1}`,
    outcome: null,
    winningPrice: null,
    winningTeamId: null,
    winningTeamName: null,
    winningTeamLogoUrl: null,
  }));
  const result = simulateMantraAuctionIdealPicks({
    auctionSourceUrl: "https://mantrafootball.org/auction",
    collectionComplete: true,
    missingDetailCount: 0,
    participants: [{ fantasyTeamId: 1, name: "Manager", logoUrl: null }],
    candidates,
    bids: [],
  });
  const manager = result.simulations[0]!;
  assert.equal(manager.selectedCount, 26);
  assert.equal(manager.deficit, 0);
  assert.deepEqual(manager.picks.slice(0, 20).map((pick) => pick.stage), Array(20).fill(1));
  assert.deepEqual(manager.picks.slice(20).map((pick) => pick.stage), Array(6).fill(2));
});

test("ideal-pick DB summary and detail share scoped simulation results", () => {
  const db = database();
  seed(db);
  catalog(db);
  importMantraAuction(batch(), db);
  const summaries = getMantraAuctionIdealPickSummaries(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
  })!;
  const team = summaries.teams.find((item) => item.fantasyTeamId === 2)!;
  const detail = getMantraAuctionIdealPickDetail(db, {
    scopeKey: "super-lig",
    mantraLeagueId: 658,
    auctionId: 2739,
    fantasyTeamId: 2,
  })!;
  assert.equal(team.selectedCount, detail.summary.selectedCount);
  assert.equal(team.provisionalIdealTotal, detail.summary.provisionalIdealTotal);
  assert.equal(detail.picks.length, team.selectedCount);
  assert.equal(
    getMantraAuctionIdealPickSummaries(db, {
      scopeKey: "championship",
      mantraLeagueId: 658,
      auctionId: 2739,
    }),
    null,
  );
});
