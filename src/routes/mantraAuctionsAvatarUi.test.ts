import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
});

// @ts-expect-error Public browser module intentionally has no TypeScript declarations.
const view = await import("../../public-tm/auctions-view.js");

test("auction player initials are Unicode-aware and deterministic", () => {
  assert.equal(view.auctionPlayerInitials("Jesus Imaz"), "JI");
  assert.equal(view.auctionPlayerInitials("Pelé"), "P");
  assert.equal(view.auctionPlayerInitials("  Élodie   Jean-Luc  "), "ÉJ");
  assert.equal(view.auctionPlayerInitials(""), "?");
});

test("auction avatar markup keeps initials until a safe image loads", () => {
  const missing = view.auctionPlayerAvatarMarkup({ avatarUrl: null }, "Jesus Imaz");
  assert.match(missing, /role="img"/);
  assert.match(missing, /aria-label="Фото игрока: Jesus Imaz"/);
  assert.match(missing, />JI</);
  assert.doesNotMatch(missing, /<img/);

  const escaped = view.auctionPlayerAvatarMarkup(
    { avatarUrl: 'https://example.test/" onerror="alert(1)' },
    '"><script>alert(1)</script>',
  );
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /loading="lazy"/);
  assert.match(escaped, /decoding="async"/);

  const { document } = parseHTML(`<body>${escaped}</body>`);
  const image = document.querySelector("[data-auction-avatar]")!;
  assert.equal(image.getAttribute("onerror"), null);
  view.handleAuctionAvatarEvent({ type: "load", target: image });
  assert.equal(image.classList.contains("is-loaded"), true);
});

test("failed auction images are removed without removing initials", () => {
  const markup = view.auctionPlayerAvatarMarkup(
    {
      avatarUrl:
        "https://mantrafootball.s3.eu-west-1.amazonaws.com/player_avatars/missing.png",
    },
    "Karol Czubak",
  );
  const { document } = parseHTML(`<body>${markup}</body>`);
  const image = document.querySelector("[data-auction-avatar]")!;
  view.handleAuctionAvatarEvent({ type: "error", target: image });
  assert.equal(document.querySelector("[data-auction-avatar]"), null);
  assert.equal(document.querySelector(".auction-player-initials")?.textContent, "KC");
});

test("auction selection hides only API-marked rows and resets hidden selection", () => {
  const rows = [
    { mantraLeagueId: 1, auctionId: 10, browsable: false },
    { mantraLeagueId: 1, auctionId: 11, browsable: true },
    { mantraLeagueId: 1, auctionId: 12, browsable: true },
  ];
  assert.deepEqual(view.auctionSelection(rows, "1:10"), {
    auctions: rows.slice(1),
    selected: "all",
  });
  assert.equal(view.auctionSelection(rows, "1:12").selected, "1:12");
  assert.equal(view.auctionSelection(rows, "all").selected, "all");
  rows[0].browsable = true;
  assert.equal(view.auctionSelection(rows, "1:10").selected, "1:10");
});

test("all-auctions card labels fantasy-team identity and escapes provenance", () => {
  const markup = view.auctionPlayerCardMarkup(
    {
      firstName: "Test",
      name: "Player",
      mantraPlayerId: 123,
      profileUrl: null,
      avatarUrl: null,
      clubName: "Club",
      positions: ["CM"],
      stages: [],
      bidRecordCount: 2,
      stageCount: 2,
      bidAmountSum: 101,
      maxBidAmount: 100,
      sourceUrl: "https://mantrafootball.org/api/player_bids/1",
      fetchedAt: "2026-08-11T12:00:00.000Z",
      maxBid: {
        amount: 100,
        fantasyTeamId: 7,
        fantasyTeamName: 'Natashaspor <script>alert("x")</script>',
        fantasyTeamLogoUrl: null,
        fantasyLeagueId: 658,
        fantasyLeagueName: "A1 | Istanbul",
        auctionId: 2741,
        stage: 2,
        sourceUrl: "https://mantrafootball.org/leagues/658/auctions/2741?round=2",
        winner: false,
      },
      historyScope: "super-lig",
      historyVersion: "v1",
    },
    false,
    "all",
  );
  assert.match(markup, /data-auction-mode="all"/);
  assert.match(markup, /Менеджер \/ fantasy-команда/);
  assert.match(markup, /Fantasy-лига/);
  assert.match(markup, /Аукцион 2741 · Этап 2/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /История по fantasy-лигам/);
  assert.match(markup, /aria-expanded="false"/);
});

test("single-auction cards render the same maximum-bid provenance structure", () => {
  const markup = view.auctionPlayerCardMarkup(
    {
      playerBidId: 1,
      firstName: "Jesus",
      name: "Imaz",
      profileUrl: null,
      avatarUrl: null,
      clubName: "Jagiellonia",
      positions: ["AM"],
      stages: [],
      bidRecordCount: 1,
      stageCount: 1,
      bidAmountSum: 75,
      maxBidAmount: 75,
      finalPrice: 75,
      sourceUrl: "https://mantrafootball.org/api/player_bids/1",
      fetchedAt: "2026-08-11T12:00:00.000Z",
      maxBid: {
        amount: 75,
        fantasyTeamId: 7,
        fantasyTeamName: "Pse Latarnia",
        fantasyTeamLogoUrl: null,
        fantasyLeagueId: 583,
        fantasyLeagueName: "Warsaw",
        auctionId: 2364,
        stage: 1,
        sourceUrl: "https://mantrafootball.org/leagues/583/auctions/2364?round=1",
        winner: true,
      },
    },
    false,
    "single",
  );
  assert.match(markup, /Менеджер \/ fantasy-команда/);
  assert.match(markup, /Pse Latarnia/);
  assert.match(markup, /Fantasy-лига/);
  assert.match(markup, /Аукцион 2364 · Этап 1/);
  assert.match(markup, /Источник помечает ставку выигрышной/);
});

test("grouped history uses compact adjacent bid markup", () => {
  const markup = view.auctionHistoryMarkup({
    mantraPlayerId: 123,
    partial: false,
    truncated: false,
    counts: { fantasyLeagues: 1, auctions: 1, stages: 1, bids: 1 },
    leagues: [{
      fantasyLeagueId: 583,
      fantasyLeagueName: "Warsaw",
      sourceUrl: "https://mantrafootball.org/leagues/583",
      auctions: [{
        auctionId: 2364,
        label: "Auction 1",
        status: "FINISHED",
        collectionStatus: "complete",
        sourceUrl: "https://mantrafootball.org/leagues/583/auctions/2364",
        stages: [{
          stage: 1,
          outcome: "success",
          bids: [{
            id: 1,
            status: "success",
            winner: true,
            price: 75,
            teamName: "Pse Latarnia",
            teamLogoUrl: null,
          }],
        }],
      }],
    }],
  });
  assert.match(markup, /auction-history-league/);
  assert.match(markup, /auction-history-auction/);
  assert.match(markup, /auction-bid-team[^>]*>Pse Latarnia<\/span>\s*<span[^>]*>·<\/span>\s*<strong[^>]*>75M/);
  assert.match(markup, /is-winner/);
});

test("team-report selection stays scoped and resets incompatible auctions", () => {
  const rows = [
    {
      mantraLeagueId: 583,
      auctionId: 2364,
      players: 10,
      detailsTotal: 10,
      browsable: true,
    },
    {
      mantraLeagueId: 583,
      auctionId: 2365,
      players: 5,
      detailsTotal: 5,
      browsable: true,
    },
    {
      mantraLeagueId: 584,
      auctionId: 2369,
      players: 8,
      detailsTotal: 10,
      browsable: true,
    },
    {
      mantraLeagueId: 584,
      auctionId: 2370,
      players: 0,
      detailsTotal: 0,
      browsable: false,
    },
  ];
  const all = view.auctionTeamReportSelection(rows, "all", "583", "583:2365");
  assert.deepEqual(all.leagueIds, ["583", "584"]);
  assert.equal(all.leagueId, "583");
  assert.equal(all.auctionKey, "583:2365");
  assert.equal(all.fixed, false);
  const changedLeague = view.auctionTeamReportSelection(
    rows,
    "all",
    "584",
    "583:2365",
  );
  assert.equal(changedLeague.auctionKey, "584:2369");
  const fixed = view.auctionTeamReportSelection(rows, "583:2364", "584", "584:2369");
  assert.deepEqual(fixed.auctions, [rows[0]]);
  assert.equal(fixed.auctionKey, "583:2364");
  assert.equal(fixed.fixed, true);
});

test("team report renders partial totals, compact competitors, and negative differences", () => {
  const summary = view.auctionTeamReportSummaryMarkup({
    partial: true,
    collectionComplete: false,
    total: 2,
    completeness: { minimumKnownCount: 1 },
    totals: {
      actual: null,
      actualKnown: 20,
      theoreticalMinimum: null,
      theoreticalMinimumKnown: 11,
      difference: null,
      differenceKnown: -1,
    },
  });
  assert.match(summary, /Предварительный отчёт/);
  assert.match(summary, />≥20M\*</);
  assert.match(summary, />-1M\*</);

  const pick = view.auctionTeamReportPickMarkup({
    complete: true,
    stage: 2,
    actual: 10,
    actualProvenance: "winning_bid_record",
    theoreticalMinimum: 11,
    difference: -1,
    player: {
      firstName: "Safe",
      name: "<script>Player</script>",
      avatarUrl: null,
      profileUrl: "/player.html?id=123",
    },
    runnerUp: {
      fantasyTeamId: 9,
      fantasyTeamName: "Nearest",
      fantasyTeamLogoUrl: null,
      amount: 10,
    },
  });
  assert.doesNotMatch(pick, /<script>/);
  assert.match(pick, /Nearest · <strong>10M/);
  assert.match(pick, /data-label="Минимум \+1M"/);
  assert.match(pick, />-1M</);
});

test("team spending table sorts numerically, keeps stable ties, and marks partials", () => {
  const team = (
    fantasyTeamId: number,
    name: string,
    minimum: number | null,
    actual: number | null,
    difference: number | null,
  ) => ({
    fantasyTeamId,
    name,
    logoUrl: null,
    wonPickCount: 2,
    minimum,
    minimumKnown: minimum,
    actual,
    actualKnown: actual,
    difference,
    differenceKnown: difference,
    isPartial: false,
    completeness: {
      minimumKnownCount: minimum == null ? 0 : 2,
      actualKnownCount: actual == null ? 0 : 2,
      differenceKnownCount: difference == null ? 0 : 2,
    },
  });
  const rows = [
    team(2, "Same", 5, 10, 5),
    team(1, "Same", 5, 10, 5),
    team(3, "Large", 12, 20, 8),
    team(4, "Negative", 11, 10, -1),
    team(5, "Unknown", null, null, null),
  ];
  assert.deepEqual(
    view.sortAuctionTeamSummaries(rows, "actual", "desc").map(
      (row: { fantasyTeamId: number }) => row.fantasyTeamId,
    ),
    [3, 4, 1, 2, 5],
  );
  assert.deepEqual(
    view.sortAuctionTeamSummaries(rows, "minimum", "asc").map(
      (row: { fantasyTeamId: number }) => row.fantasyTeamId,
    ),
    [1, 2, 4, 3, 5],
  );
  assert.deepEqual(
    view.sortAuctionTeamSummaries(rows, "difference", "asc").map(
      (row: { fantasyTeamId: number }) => row.fantasyTeamId,
    ),
    [4, 1, 2, 3, 5],
  );
  assert.deepEqual(view.nextAuctionTeamSummarySort("actual", "desc", "actual"), {
    key: "actual",
    order: "asc",
  });
  assert.deepEqual(view.nextAuctionTeamSummarySort("minimum", "asc", "difference"), {
    key: "difference",
    order: "desc",
  });

  const partial = team(7, "Partial", null, null, null);
  partial.minimumKnown = 258;
  partial.actualKnown = 260;
  partial.differenceKnown = 2;
  partial.isPartial = true;
  partial.completeness = {
    minimumKnownCount: 1,
    actualKnownCount: 1,
    differenceKnownCount: 1,
  };
  const markup = view.auctionTeamSpendingMarkup(
    {
      partial: true,
      collectionComplete: false,
      detailsProcessed: 9,
      detailsTotal: 10,
      teams: [partial],
    },
    "7",
  );
  assert.match(markup, /<table class="auction-team-summary-table">/);
  assert.match(markup, /aria-sort="descending"/);
  assert.match(markup, /data-team-summary-sort="actual"/);
  assert.match(markup, />≥258M\*</);
  assert.match(markup, />2M\*</);
  assert.match(markup, /aria-current="true"/);
  assert.match(markup, /data-team-summary-team="7"/);
});

test("lazy history caches success, shares requests, retries errors, and invalidates versions", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    view.clearAuctionHistoryCache();
  });
  view.clearAuctionHistoryCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "temporary" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        mode: "all-history",
        scopeKey: "super-lig",
        mantraPlayerId: 8718,
        dataVersion: calls >= 3 ? "v2" : "v1",
        partial: false,
        truncated: false,
        offset: 0,
        limit: 100,
        nextOffset: null,
        returnedRows: 1,
        totalRows: 1,
        counts: { fantasyLeagues: 0, auctions: 0, stages: 0, bids: 0 },
        leagues: [],
      }),
    };
  }) as unknown as typeof fetch;

  await assert.rejects(
    view.loadAuctionPlayerHistory("super-lig", 8718, "v1"),
    /temporary/,
  );
  const [retry, shared] = await Promise.all([
    view.loadAuctionPlayerHistory("super-lig", 8718, "v1"),
    view.loadAuctionPlayerHistory("super-lig", 8718, "v1"),
  ]);
  assert.equal(retry, shared);
  assert.equal(calls, 2);
  await view.loadAuctionPlayerHistory("super-lig", 8718, "v1");
  assert.equal(calls, 2);

  await view.loadAuctionPlayerHistory("super-lig", 8718, "v2");
  assert.equal(calls, 3);
  view.clearAuctionHistoryCache();
  await view.loadAuctionPlayerHistory("super-lig", 8718, "v2");
  assert.equal(calls, 4);
});

test("Ideal Pick summary sorts totals and exposes accessible selectable rows", () => {
  const data = {
    partial: false,
    teams: [
      {
        fantasyTeamId: 2,
        name: "B",
        logoUrl: null,
        selectedCount: 26,
        targetCount: 26,
        deficit: 0,
        partial: false,
        idealTotal: 20,
        provisionalIdealTotal: 20,
        actuallyAcquiredCount: 4,
        actuallyAcquiredKnownCount: 4,
        missedTargetCount: 22,
        missedTargetKnownCount: 22,
        topCompetitor: null,
      },
      {
        fantasyTeamId: 1,
        name: "A",
        logoUrl: null,
        selectedCount: 25,
        targetCount: 26,
        deficit: 1,
        partial: false,
        idealTotal: null,
        provisionalIdealTotal: 10,
        actuallyAcquiredCount: null,
        actuallyAcquiredKnownCount: 3,
        missedTargetCount: null,
        missedTargetKnownCount: 20,
        topCompetitor: { fantasyTeamId: 3, name: "C", logoUrl: null, count: 2, exactCount: null },
      },
    ],
  };
  assert.deepEqual(
    view.sortIdealPickSummaries(data.teams, "desc").map((team: { fantasyTeamId: number }) => team.fantasyTeamId),
    [2, 1],
  );
  const markup = view.idealPickSummaryMarkup(data, "1", "asc");
  assert.match(markup, /data-ideal-team="1"/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /aria-current="true"/);
  assert.match(markup, /10M\*/);
});

test("Who outbid distinguishes same-stage and later actual acquisitions", () => {
  const basePick = {
    complete: true,
    player: { firstName: "Test", name: "Player", avatarUrl: null, profileUrl: null },
    pickOrder: 1,
    stage: 1,
    managerOriginalBid: 4,
    stageMaxBid: 5,
    stageAverageBid: 4.5,
    stageAverageBidNumerator: 9,
    stageAverageBidCount: 2,
    nearestOtherTeam: { fantasyTeamId: 2, name: "Other", logoUrl: null, amount: 5 },
    requiredIdealBid: 6,
    source: { stageUrl: "https://mantrafootball.org/auction?round=1" },
    actualWinner: {
      fantasyTeamId: 2,
      name: "Other",
      logoUrl: null,
      winningBid: 5,
      winningStage: 1,
    },
    actualWinningBidGap: 1,
    actualOutcomeAmbiguous: false,
  };
  const same = view.idealPickDetailMarkup({
    summary: {
      selectedCount: 1,
      targetCount: 26,
      provisionalIdealTotal: 6,
      actuallyAcquiredKnownCount: 0,
      missedTargetKnownCount: 1,
    },
    picks: [{ ...basePick, actualRelationship: "same_stage_outbid" }],
  });
  assert.match(same, /Перебил на этапе/);
  assert.doesNotMatch(same, /Забрал позже/);
  const later = view.idealPickDetailMarkup({
    summary: {
      selectedCount: 1,
      targetCount: 26,
      provisionalIdealTotal: 6,
      actuallyAcquiredKnownCount: 0,
      missedTargetKnownCount: 1,
    },
    picks: [
      {
        ...basePick,
        actualRelationship: "won_later",
        actualWinningBidGap: null,
        actualWinner: { ...basePick.actualWinner, winningStage: 2 },
      },
    ],
  });
  assert.match(later, /Забрал позже/);
  assert.doesNotMatch(later, /Перебил на этапе/);
});

test("Who outbid groups are expandable, stable-ID based, and bounded", () => {
  const markup = view.idealWhoOutbidMarkup({
    whoOutbid: [
      {
        fantasyTeamId: 7,
        name: "Same",
        logoUrl: null,
        count: 2,
        exactCount: 2,
        actualWinningBidKnownTotal: 12,
        actualWinningBidTotal: 12,
        players: [
          { name: "One", relationship: "same_stage_outbid" },
          { name: "Two", relationship: "won_later" },
        ],
      },
    ],
  });
  assert.match(markup, /<details>/);
  assert.match(markup, /Кто перебил/);
  assert.match(markup, /Перебил на этапе/);
  assert.match(markup, /Забрал позже/);
});
