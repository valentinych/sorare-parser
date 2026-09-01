import assert from "node:assert/strict";
import test from "node:test";
import {
  collectMantraAuction,
  normalizePlayerBid,
  parseAuctionPage,
  parseLeagueAuctionIds,
  parseLeagueAuctionNavigationPaths,
  validateNumericId,
} from "./mantraAuction.js";

function page(round: number | null, ids: number[]): string {
  const links = [1, 2]
    .map((stage) => `<a href="/leagues/658/auctions/2739?round=${stage}">#${stage}</a>`)
    .join("");
  const rows = ids
    .map(
      (id) => `<div id="player-bid-${id}" class="player-bid-row">
        <div class="player-bid-name">Player ${id}</div>
        <div class="player-position">CM</div>
        <div class="player-bid-price">${id}M</div>
      </div>`,
    )
    .join("");
  return `<html><body>
    <div class="league-name-text">A1 | Istanbul</div>
    <div class="auction-badge">FINISHED</div>
    <div class="auction-text">Auction #1</div>
    ${links}
    ${round == null ? "" : `<div class="player-stage-number">Stage #${round}</div>`}
    ${rows}
  </body></html>`;
}

function payload(id: number, playerId = id) {
  return {
    data: {
      id,
      status: "success",
      price: id,
      player: {
        id: playerId,
        first_name: "Test",
        name: `Player ${playerId}`,
        position_classic_arr: ["CM"],
        position_ital_arr: ["C"],
        club: { id: 9, name: "Club" },
      },
      auction_bids: {
        "1": [
          {
            id: id * 10,
            status: "success",
            price: id,
            team: { id: 7, human_name: "Team" },
          },
        ],
      },
    },
  };
}

test("validates numeric league and auction IDs", () => {
  assert.equal(validateNumericId("658", "league ID"), 658);
  for (const value of ["", "0", "-1", "1.5", "https://example.com"]) {
    assert.throws(() => validateNumericId(value, "league ID"), /positive numeric ID/);
  }
});

test("parses stage links and player-bid summaries", () => {
  const parsed = parseAuctionPage(page(2, [20, 21]), 658, 2739);
  assert.equal(parsed.status, "FINISHED");
  assert.equal(parsed.currentStage, 2);
  assert.deepEqual(parsed.roundNumbers, [1, 2]);
  assert.deepEqual(
    parsed.playerBids.map((bid) => bid.playerBidId),
    [20, 21],
  );
});

test("discovers only auction links belonging to the requested league", () => {
  const html = `<a href="/leagues/658/auctions/2739">Current</a>
    <a href="https://mantrafootball.org/leagues/658/auctions/2740?round=1">Next</a>
    <a href="/leagues/659/auctions/9999">Other league</a>
    <a href="/leagues/658/auctions/2739">Duplicate</a>
    <script>window.payload = {"auction_url":"/leagues/658/auctions/2741"}</script>`;
  assert.deepEqual(parseLeagueAuctionIds(html, 658), [2739, 2740, 2741]);
});

test("discovers linked auction index navigation without guessing routes", () => {
  const html = `<a href="/leagues/658/auctions">Auction history</a>
    <a href="/leagues/658/auctions?season=8">Season auctions</a>
    <a href="/leagues/659/auctions">Other league</a>`;
  assert.deepEqual(parseLeagueAuctionNavigationPaths(html, 658), [
    "/leagues/658/auctions",
    "/leagues/658/auctions?season=8",
  ]);
});

test("normalizes API stage ordering without dropping raw data", () => {
  const normalized = normalizePlayerBid(payload(20), "https://mantrafootball.org/api/player_bids/20");
  assert.equal(normalized.player.id, 20);
  assert.equal(normalized.stages[0]?.bids[0]?.order, 1);
  assert.equal(normalized.apiData.id, 20);
});

test("exhausts discovered stages and reports duplicate or missing pages", async () => {
  const htmlCalls: string[] = [];
  const artifact = await collectMantraAuction(658, 2739, {
    getHtml: async (path) => {
      htmlCalls.push(path);
      if (!path.includes("?")) return page(null, []);
      if (path.endsWith("round=1")) return page(1, [20]);
      return page(1, [20]);
    },
    getJson: async () => payload(20),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });

  assert.deepEqual(htmlCalls, [
    "/leagues/658/auctions/2739",
    "/leagues/658/auctions/2739?round=1",
    "/leagues/658/auctions/2739?round=2",
  ]);
  assert.deepEqual(artifact.validation.duplicatePlayerBidIds, [20]);
  assert.deepEqual(artifact.validation.missingStages, [2]);
  assert.equal(artifact.totals.players, 1);
  assert.equal(artifact.totals.bids, 1);
  assert.equal(artifact.totals.winners, 1);
});
