/**
 * Admin Premium button: refresh one Mantra league after calculated auction rounds.
 * Squads (players_json) always; auctions (prices/stages) best-effort if HTML is empty/404.
 */
import type Database from "better-sqlite3";
import {
  collectMantraAuction,
  parseLeagueAuctionIds,
  parseLeagueAuctionNavigationPaths,
  type NormalizedPlayerBid,
} from "../clients/mantraAuction.js";
import { mantraAuthedGet } from "../clients/mantraAuth.js";
import { getDb } from "../db/index.js";
import {
  importMantraAuction,
  MANTRA_AUCTION_SCOPE_KEYS,
  normalizeMantraImageUrl,
  type MantraAuctionScopeKey,
  type NormalizedAuctionPlayer,
} from "../domain/mantraAuctions.js";
import { PREMIUM_SQUAD_REPORT_CACHE_PREFIX } from "../domain/premiumSquadReport.js";
import { PREMIUM_UNPICKED_TOPS_CACHE_PREFIX } from "../domain/premiumUnpickedTops.js";
import { invalidateComputed } from "../lib/computedCache.js";
import { allBuilderLeagues } from "../lib/liveLeagues.js";
import { configuredMantraAuctionIds } from "./runMantraAuctions.js";
import { syncMantraFantasyTeams } from "./syncMantra.js";

const ORIGIN = "https://mantrafootball.org";
const BATCH_PLAYERS = 50;

export type RefreshPremiumLeagueInput = {
  leagueId: number;
  tournamentId?: number | null;
  teamId?: number | null;
};

export type RefreshPremiumLeagueResult = {
  ok: true;
  league: number;
  tournamentId: number | null;
  teamId: number | null;
  auctions: {
    discovered: number;
    imported: number;
    players: number;
    warning: string | null;
  };
  teams: number;
};

export type RefreshPremiumLeagueDeps = {
  database?: Database.Database;
  syncFantasyTeams?: (
    tournamentId: number,
    opts?: { leagueIds?: number[] },
  ) => Promise<number>;
  getHtml?: (path: string) => Promise<string>;
  collectAuction?: typeof collectMantraAuction;
  now?: () => Date;
};

export function auctionScopeForLeague(leagueId: number): {
  key: MantraAuctionScopeKey;
  name: string;
  tournamentId: number;
  leagueIds: number[];
} | null {
  for (const league of allBuilderLeagues()) {
    if (!league.mantraDivisions.some((row) => row.leagueId === leagueId)) continue;
    if (league.mantraTournamentId == null) return null;
    if (
      !MANTRA_AUCTION_SCOPE_KEYS.includes(league.slug as MantraAuctionScopeKey)
    ) {
      return null;
    }
    return {
      key: league.slug as MantraAuctionScopeKey,
      name: league.name,
      tournamentId: league.mantraTournamentId,
      leagueIds: league.mantraDivisions.map((row) => row.leagueId),
    };
  }
  return null;
}

export function tournamentIdForLeague(
  leagueId: number,
  database: Database.Database,
): number | null {
  try {
    const fromLeague = database
      .prepare(`SELECT tournament_id AS tournamentId FROM mantra_leagues WHERE id = ?`)
      .get(leagueId) as { tournamentId: number | null } | undefined;
    if (fromLeague?.tournamentId != null) return fromLeague.tournamentId;
  } catch {
    /* optional table in tests */
  }
  try {
    const fromTeam = database
      .prepare(
        `SELECT tournament_id AS tournamentId FROM mantra_fantasy_teams
         WHERE league_id = ? AND tournament_id IS NOT NULL LIMIT 1`,
      )
      .get(leagueId) as { tournamentId: number | null } | undefined;
    if (fromTeam?.tournamentId != null) return fromTeam.tournamentId;
  } catch {
    /* optional table in tests */
  }
  return (
    allBuilderLeagues().find((league) =>
      league.mantraDivisions.some((row) => row.leagueId === leagueId),
    )?.mantraTournamentId ?? null
  );
}

function safeImage(value: unknown): string | null {
  if (value == null || value === "") return null;
  return normalizeMantraImageUrl(String(value));
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableId(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nullableText(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function importPlayer(
  leagueId: number,
  auctionId: number,
  detail: NormalizedPlayerBid,
  fetchedAt: string,
): NormalizedAuctionPlayer {
  const club = object(detail.player.club);
  return {
    mantraLeagueId: leagueId,
    auctionId,
    playerBidId: detail.playerBidId,
    status: detail.status,
    price: detail.price,
    sourceUrl: detail.sourceUrl,
    fetchedAt,
    player: {
      id: detail.player.id,
      firstName: detail.player.firstName,
      name: detail.player.name,
      avatarUrl: safeImage(detail.player.avatarUrl),
      positions: detail.player.positions,
      positionsItalian: detail.player.positionsItalian,
      club: club
        ? {
            id: nullableId(club.id),
            name: nullableText(club.name),
            logoUrl: safeImage(club.logo_path ?? club.logoUrl),
          }
        : null,
    },
    stages: detail.stages.map((stage) => ({
      stage: stage.stage,
      bids: stage.bids.map((bid) => {
        const team = object(bid.team);
        return {
          id: bid.id,
          order: bid.order,
          status: bid.status,
          price: bid.price,
          team: team
            ? {
                id: nullableId(team.id),
                name: nullableText(team.human_name ?? team.name),
                logoUrl: safeImage(team.logo_path ?? team.logoUrl),
              }
            : null,
        };
      }),
    })),
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function ensureAuctionJob(
  database: Database.Database,
  scope: {
    key: MantraAuctionScopeKey;
    name: string;
    leagueIds: number[];
  },
  leagueId: number,
  now: Date,
): string | null {
  let row: { runId: string; leagueIdsJson: string } | undefined;
  try {
    row = database
      .prepare(
        `SELECT run_id AS runId, mantra_league_ids_json AS leagueIdsJson
         FROM mantra_auction_jobs WHERE scope_key = ?`,
      )
      .get(scope.key) as { runId: string; leagueIdsJson: string } | undefined;
  } catch {
    return null;
  }
  if (row) {
    let ids: number[] = [];
    try {
      ids = JSON.parse(row.leagueIdsJson) as number[];
    } catch {
      return null;
    }
    return ids.includes(leagueId) ? row.runId : null;
  }
  const runId = `refresh-${scope.key}-${now.getTime()}`;
  importMantraAuction(
    {
      schemaVersion: 1,
      operation: "seed",
      runId,
      startedAt: now.toISOString(),
      scopes: [
        {
          key: scope.key,
          name: scope.name,
          mantraLeagueIds: scope.leagueIds,
        },
      ],
    },
    database,
  );
  return runId;
}

async function discoverAuctionIds(
  leagueId: number,
  getHtml: (path: string) => Promise<string>,
): Promise<{ ids: number[]; warning: string | null }> {
  const leaguePath = `/leagues/${leagueId}`;
  let leagueHtml: string;
  try {
    leagueHtml = await getHtml(leaguePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ids: configuredMantraAuctionIds(leagueId, []),
      warning: `league html unavailable: ${message.replace(/\s+/g, " ").slice(0, 120)}`,
    };
  }
  if (!String(leagueHtml || "").trim()) {
    return {
      ids: configuredMantraAuctionIds(leagueId, []),
      warning: "league html empty",
    };
  }
  const ids = new Set(
    configuredMantraAuctionIds(leagueId, parseLeagueAuctionIds(leagueHtml, leagueId)),
  );
  for (const navigationPath of parseLeagueAuctionNavigationPaths(leagueHtml, leagueId)) {
    try {
      const navigationHtml = await getHtml(navigationPath);
      for (const auctionId of parseLeagueAuctionIds(navigationHtml, leagueId)) {
        ids.add(auctionId);
      }
    } catch {
      /* finished auction nav may 404 */
    }
  }
  return { ids: [...ids].sort((a, b) => a - b), warning: null };
}

export async function refreshLeagueAuctions(
  leagueId: number,
  deps: RefreshPremiumLeagueDeps = {},
): Promise<{
  discovered: number;
  imported: number;
  players: number;
  warning: string | null;
}> {
  const database = deps.database ?? getDb();
  const getHtml = deps.getHtml ?? mantraAuthedGet;
  const collectAuction = deps.collectAuction ?? collectMantraAuction;
  const now = deps.now ?? (() => new Date());
  const scope = auctionScopeForLeague(leagueId);
  if (!scope) {
    return {
      discovered: 0,
      imported: 0,
      players: 0,
      warning: "no_auction_scope",
    };
  }
  const runId = ensureAuctionJob(database, scope, leagueId, now());
  if (!runId) {
    return {
      discovered: 0,
      imported: 0,
      players: 0,
      warning: "auction_job_unavailable",
    };
  }

  const discovered = await discoverAuctionIds(leagueId, getHtml);
  const warnings: string[] = [];
  if (discovered.warning) warnings.push(discovered.warning);
  if (discovered.ids.length === 0) {
    return {
      discovered: 0,
      imported: 0,
      players: 0,
      warning: warnings[0] ?? "no_auctions",
    };
  }

  let imported = 0;
  let players = 0;
  for (const auctionId of discovered.ids) {
    let artifact: Awaited<ReturnType<typeof collectMantraAuction>>;
    try {
      artifact = await collectAuction(leagueId, auctionId, { getHtml });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `auction ${auctionId}: ${message.replace(/\s+/g, " ").slice(0, 80)}`,
      );
      continue;
    }
    const fetchedAt = artifact.provenance.fetchedAt;
    const catalogPlayers = artifact.playerBids.map((detail) =>
      importPlayer(leagueId, auctionId, detail, fetchedAt),
    );
    try {
      importMantraAuction(
        {
          schemaVersion: 1,
          operation: "catalog",
          runId,
          scopeKey: scope.key,
          auctions: [
            {
              mantraLeagueId: leagueId,
              auctionId,
              status: artifact.auction.status,
              label: artifact.auction.label,
              leagueLabel: artifact.auction.leagueLabel,
              sourceUrl: artifact.auction.sourceUrl,
              fetchedAt,
              stages: artifact.rounds.map((round) => ({
                stage: round.stage,
                sourceUrl: round.sourceUrl,
                playerBidIds: round.playerBidIds,
              })),
            },
          ],
        },
        database,
      );
      for (const batch of chunks(catalogPlayers, BATCH_PLAYERS)) {
        importMantraAuction(
          {
            schemaVersion: 1,
            operation: "batch",
            runId,
            scopeKey: scope.key,
            players: batch,
          },
          database,
        );
        players += batch.length;
      }
      imported += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `import ${auctionId}: ${message.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }

  return {
    discovered: discovered.ids.length,
    imported,
    players,
    warning: warnings.length ? warnings.join("; ").slice(0, 300) : null,
  };
}

function invalidateLeaguePremiumCaches(
  database: Database.Database,
  leagueId: number,
): void {
  invalidateComputed(`${PREMIUM_UNPICKED_TOPS_CACHE_PREFIX}${leagueId}`, {
    database,
    persist: true,
  });
  let teamIds: Array<{ id: number }> = [];
  try {
    teamIds = database
      .prepare(`SELECT id FROM mantra_fantasy_teams WHERE league_id = ?`)
      .all(leagueId) as Array<{ id: number }>;
  } catch {
    teamIds = [];
  }
  for (const row of teamIds) {
    invalidateComputed(`${PREMIUM_SQUAD_REPORT_CACHE_PREFIX}${row.id}`, {
      database,
      persist: true,
    });
  }
}

export async function refreshPremiumLeagueAfterAuction(
  input: RefreshPremiumLeagueInput,
  deps: RefreshPremiumLeagueDeps = {},
): Promise<RefreshPremiumLeagueResult> {
  const leagueId = input.leagueId;
  const database = deps.database ?? getDb();
  const tournamentId =
    input.tournamentId ?? tournamentIdForLeague(leagueId, database);
  const syncFantasyTeams = deps.syncFantasyTeams ?? syncMantraFantasyTeams;

  let teams = 0;
  if (tournamentId != null) {
    teams = await syncFantasyTeams(tournamentId, { leagueIds: [leagueId] });
  }

  let auctions: RefreshPremiumLeagueResult["auctions"] = {
    discovered: 0,
    imported: 0,
    players: 0,
    warning: tournamentId == null ? "missing_tournament" : null,
  };
  try {
    auctions = await refreshLeagueAuctions(leagueId, deps);
    if (tournamentId == null && !auctions.warning) {
      auctions = { ...auctions, warning: "missing_tournament" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auctions = {
      discovered: 0,
      imported: 0,
      players: 0,
      warning: `auctions failed: ${message.replace(/\s+/g, " ").slice(0, 160)}`,
    };
  }

  invalidateLeaguePremiumCaches(database, leagueId);

  return {
    ok: true,
    league: leagueId,
    tournamentId: tournamentId ?? null,
    teamId: input.teamId ?? null,
    auctions,
    teams,
  };
}
