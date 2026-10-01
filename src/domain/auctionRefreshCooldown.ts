import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";

export const AUCTION_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
export const AUCTION_REFRESH_COOLDOWN_KEY_PREFIX = "auction_refresh_league:";

export type AuctionRefreshCooldownState = {
  lastRefreshedAt: string | null;
  remainingMs: number;
  availableAt: string | null;
};

export function auctionRefreshCooldownKey(leagueId: number): string {
  return `${AUCTION_REFRESH_COOLDOWN_KEY_PREFIX}${leagueId}`;
}

function stateFromLast(
  lastRefreshedAt: string | null,
  now: Date,
): AuctionRefreshCooldownState {
  if (!lastRefreshedAt) {
    return { lastRefreshedAt: null, remainingMs: 0, availableAt: null };
  }
  const lastMs = Date.parse(lastRefreshedAt);
  if (!Number.isFinite(lastMs)) {
    return { lastRefreshedAt: null, remainingMs: 0, availableAt: null };
  }
  const remainingMs = Math.max(0, lastMs + AUCTION_REFRESH_COOLDOWN_MS - now.getTime());
  return {
    lastRefreshedAt: new Date(lastMs).toISOString(),
    remainingMs,
    availableAt:
      remainingMs > 0 ? new Date(lastMs + AUCTION_REFRESH_COOLDOWN_MS).toISOString() : null,
  };
}

function readLastRefreshedAt(
  leagueId: number,
  database: Database.Database,
): string | null {
  try {
    const row = database
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(auctionRefreshCooldownKey(leagueId)) as { value: string } | undefined;
    const value = row?.value?.trim();
    if (!value) return null;
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function getAuctionRefreshCooldown(
  leagueId: number,
  opts: { database?: Database.Database; now?: () => Date } = {},
): AuctionRefreshCooldownState {
  const now = opts.now?.() ?? new Date();
  return stateFromLast(readLastRefreshedAt(leagueId, opts.database ?? getDb()), now);
}

export function markAuctionRefreshDone(
  leagueId: number,
  opts: { database?: Database.Database; now?: () => Date } = {},
): AuctionRefreshCooldownState {
  const now = opts.now?.() ?? new Date();
  const lastRefreshedAt = now.toISOString();
  try {
    (opts.database ?? getDb())
      .prepare(
        `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(auctionRefreshCooldownKey(leagueId), lastRefreshedAt);
  } catch {
    /* tests without sync_meta still return the in-memory cooldown for this call */
  }
  return stateFromLast(lastRefreshedAt, now);
}
