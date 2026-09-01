import { parseHTML } from "linkedom";
import { getMantraRequestStats, resetMantraRequestStats } from "./mantraRequest.js";
import { mantraAuthedGet, mantraAuthedJson } from "./mantraAuth.js";
import { REQUEST_START_GAP_MS } from "../lib/rateLimit.js";

const ORIGIN = "https://mantrafootball.org";
type Json = Record<string, unknown>;

export type AuctionPage = {
  status: string | null;
  label: string | null;
  leagueLabel: string | null;
  currentStage: number | null;
  roundNumbers: number[];
  playerBids: Array<{
    playerBidId: number;
    displayedName: string | null;
    positions: string[];
    displayedPrice: string | null;
  }>;
};

export type NormalizedPlayerBid = {
  playerBidId: number;
  status: string | null;
  price: number | null;
  sourceUrl: string;
  player: {
    id: number;
    name: string;
    firstName: string | null;
    profileUrl: string;
    avatarUrl: string | null;
    positions: string[];
    positionsItalian: string[];
    club: Json | null;
  };
  stages: Array<{
    stage: number;
    bids: Array<{
      id: number;
      status: string | null;
      price: number | null;
      order: number;
      team: Json | null;
    }>;
  }>;
  apiData: Json;
};

type CollectorDeps = {
  getHtml?: (path: string) => Promise<string>;
  getJson?: (path: string) => Promise<unknown>;
  now?: () => Date;
};

function text(element: { textContent?: string | null } | null): string | null {
  const value = element?.textContent?.replace(/\s+/g, " ").trim();
  return value || null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Json | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function validateNumericId(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive numeric ID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

export function parseLeagueAuctionIds(html: string, leagueId: number): number[] {
  if (html.includes('id="new_user"') && html.includes("user[password]")) {
    throw new Error("Mantra league page requires login");
  }
  const { document } = parseHTML(html);
  const ids = new Set<number>();
  const expected = new RegExp(`/leagues/${leagueId}/auctions/(\\d+)`);
  for (const link of document.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    const match = new URL(href, ORIGIN).pathname.match(expected);
    if (match) ids.add(Number(match[1]));
  }
  for (const match of html.matchAll(new RegExp(`/leagues/${leagueId}/auctions/(\\d+)`, "g"))) {
    ids.add(Number(match[1]));
  }
  return [...ids].filter(Number.isSafeInteger).sort((a, b) => a - b);
}

export function parseLeagueAuctionNavigationPaths(
  html: string,
  leagueId: number,
): string[] {
  if (html.includes('id="new_user"') && html.includes("user[password]")) {
    throw new Error("Mantra league page requires login");
  }
  const { document } = parseHTML(html);
  const expectedPath = `/leagues/${leagueId}/auctions`;
  const paths = new Set<string>();
  for (const link of document.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const url = new URL(href, ORIGIN);
    if (url.origin === ORIGIN && url.pathname === expectedPath) {
      paths.add(`${url.pathname}${url.search}`);
    }
  }
  return [...paths].sort();
}

export function parseAuctionPage(
  html: string,
  leagueId: number,
  auctionId: number,
): AuctionPage {
  if (html.includes('id="new_user"') && html.includes("user[password]")) {
    throw new Error("Mantra auction page requires login");
  }
  const { document } = parseHTML(html);
  const expectedPath = `/leagues/${leagueId}/auctions/${auctionId}`;
  const rounds = new Set<number>();
  for (const link of document.querySelectorAll(`a[href^="${expectedPath}?"]`)) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const round = numberOrNull(new URL(href, ORIGIN).searchParams.get("round"));
    if (round != null && Number.isInteger(round) && round > 0) rounds.add(round);
  }

  const playerBids = [...document.querySelectorAll(".player-bid-row")].flatMap((row) => {
    const match = row.id.match(/^player-bid-(\d+)$/);
    if (!match) return [];
    return [
      {
        playerBidId: Number(match[1]),
        displayedName: text(row.querySelector(".player-bid-name")),
        positions: [...row.querySelectorAll(".player-position")]
          .map((position) => text(position))
          .filter((position): position is string => position != null),
        displayedPrice: text(row.querySelector(".player-bid-price")),
      },
    ];
  });

  const stageText = text(document.querySelector(".player-stage-number"));
  return {
    status: text(document.querySelector(".auction-badge")),
    label: text(document.querySelector(".auction-text")),
    leagueLabel: text(document.querySelector(".league-name-text")),
    currentStage: numberOrNull(stageText?.match(/#(\d+)/)?.[1]),
    roundNumbers: [...rounds].sort((a, b) => a - b),
    playerBids,
  };
}

export function normalizePlayerBid(payload: unknown, sourceUrl: string): NormalizedPlayerBid {
  const root = recordOrNull(payload);
  const data = recordOrNull(root?.data);
  const player = recordOrNull(data?.player);
  const playerId = numberOrNull(player?.id);
  const playerBidId = numberOrNull(data?.id);
  if (playerId == null || playerBidId == null) {
    throw new Error(`Invalid player-bids response from ${sourceUrl}`);
  }

  const groups = recordOrNull(data?.auction_bids) ?? {};
  const stages = Object.entries(groups)
    .map(([stage, value]) => ({
      stage: Number(stage),
      bids: (Array.isArray(value) ? value : []).map((item, index) => {
        const bid = recordOrNull(item) ?? {};
        const id = numberOrNull(bid.id);
        if (id == null) throw new Error(`Bid without an ID in ${sourceUrl}`);
        return {
          id,
          status: bid.status != null ? String(bid.status) : null,
          price: numberOrNull(bid.price),
          order: index + 1,
          team: recordOrNull(bid.team),
        };
      }),
    }))
    .filter((stage) => Number.isInteger(stage.stage) && stage.stage > 0)
    .sort((a, b) => a.stage - b.stage);

  return {
    playerBidId,
    status: data?.status != null ? String(data.status) : null,
    price: numberOrNull(data?.price),
    sourceUrl,
    player: {
      id: playerId,
      name: String(player?.name ?? ""),
      firstName: player?.first_name != null ? String(player.first_name) : null,
      profileUrl: `${ORIGIN}/players/${playerId}`,
      avatarUrl: player?.avatar_path != null ? String(player.avatar_path) : null,
      positions: Array.isArray(player?.position_classic_arr)
        ? (player.position_classic_arr as unknown[]).map(String)
        : [],
      positionsItalian: Array.isArray(player?.position_ital_arr)
        ? (player.position_ital_arr as unknown[]).map(String)
        : [],
      club: recordOrNull(player?.club),
    },
    stages,
    apiData: data ?? {},
  };
}

export async function collectMantraAuction(
  leagueId: number,
  auctionId: number,
  deps: CollectorDeps = {},
) {
  const getHtml = deps.getHtml ?? mantraAuthedGet;
  const getJson = deps.getJson ?? mantraAuthedJson;
  const now = deps.now ?? (() => new Date());
  resetMantraRequestStats();

  const pagePath = `/leagues/${leagueId}/auctions/${auctionId}`;
  const sourcePage = `${ORIGIN}${pagePath}`;
  const initial = parseAuctionPage(await getHtml(pagePath), leagueId, auctionId);
  const roundNumbers =
    initial.roundNumbers.length > 0
      ? initial.roundNumbers
      : initial.currentStage != null
        ? [initial.currentStage]
        : [];
  if (roundNumbers.length === 0) throw new Error("Auction page exposed no stages");

  const rounds: Array<{
    stage: number;
    sourceUrl: string;
    playerBidIds: number[];
  }> = [];
  const byId = new Map<number, number>();
  const duplicatePlayerBidIds: number[] = [];
  const missingStages: number[] = [];

  for (const stage of roundNumbers) {
    const path = `${pagePath}?round=${stage}`;
    const page = parseAuctionPage(await getHtml(path), leagueId, auctionId);
    if (page.currentStage !== stage || page.playerBids.length === 0) missingStages.push(stage);
    const ids = page.playerBids.map((bid) => bid.playerBidId);
    rounds.push({ stage, sourceUrl: `${ORIGIN}${path}`, playerBidIds: ids });
    for (const id of ids) {
      if (byId.has(id)) duplicatePlayerBidIds.push(id);
      else byId.set(id, stage);
    }
  }

  const playerBids: NormalizedPlayerBid[] = [];
  for (const id of byId.keys()) {
    const path = `/api/player_bids/${id}`;
    const normalized = normalizePlayerBid(await getJson(path), `${ORIGIN}${path}`);
    if (normalized.playerBidId !== id) {
      throw new Error(`Player-bid ID mismatch: requested ${id}, received ${normalized.playerBidId}`);
    }
    playerBids.push(normalized);
  }

  const bids = playerBids.flatMap((playerBid) =>
    playerBid.stages.flatMap((stage) => stage.bids),
  );
  const requestStats = getMantraRequestStats();
  return {
    schemaVersion: 1,
    provenance: {
      fetchedAt: now().toISOString(),
      sourcePage,
      auth: "authenticated repository session",
      endpointFamilies: [
        `${ORIGIN}/leagues/:leagueId/auctions/:auctionId?round=:stage`,
        `${ORIGIN}/api/player_bids/:playerBidId`,
      ],
      rateLimit: {
        maximumRequestStartsPerRollingSecond: 4,
        minimumStartGapMs: REQUEST_START_GAP_MS,
        retries: "Retry-After when supplied; exponential backoff for 429/5xx/network errors",
      },
      requestStats,
    },
    auction: {
      leagueId,
      auctionId,
      sourceUrl: sourcePage,
      status: initial.status,
      label: initial.label,
      leagueLabel: initial.leagueLabel,
      availableStages: roundNumbers,
    },
    rounds,
    playerBids,
    validation: {
      duplicatePlayerBidIds: [...new Set(duplicatePlayerBidIds)].sort((a, b) => a - b),
      missingStages,
    },
    totals: {
      players: new Set(playerBids.map((item) => item.player.id)).size,
      playerBidRecords: playerBids.length,
      stages: playerBids.reduce((sum, item) => sum + item.stages.length, 0),
      bids: bids.length,
      winners: bids.filter((bid) => bid.status === "success").length,
    },
  };
}
