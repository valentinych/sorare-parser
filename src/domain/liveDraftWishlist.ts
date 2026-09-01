import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { LiveAuctionError } from "./liveAuction.js";
import { LIVE_AUCTION_RULES, isGoalkeeper, parseBidAmount } from "./liveAuctionRules.js";

type PlayerRow = {
  id: number;
  name: string;
  full_name: string | null;
  first_name: string | null;
  positions_json: string | null;
  club_name: string | null;
  club_logo: string | null;
  avatar_path: string | null;
};

type WishlistRow = {
  player_id: number;
  target_bid: number;
};

export type LiveDraftWishlistPlayer = {
  id: number;
  name: string;
  clubName: string | null;
  positions: string[];
  goalkeeper: boolean;
  photoUrl: string | null;
  clubLogoUrl: string | null;
};

export type LiveDraftWishlistItem = {
  playerId: number;
  targetBid: number;
  player: LiveDraftWishlistPlayer;
};

export type LiveDraftWishlistView = {
  items: LiveDraftWishlistItem[];
};

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

function parsePositions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item).toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function publicImage(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/mantra/image")) return path;
  const href = path.startsWith("http")
    ? path
    : `https://mantrafootball.s3.eu-west-1.amazonaws.com${
        path.startsWith("/") ? path : `/${path}`
      }`;
  try {
    const url = new URL(href);
    if (url.hostname !== "mantrafootball.s3.eu-west-1.amazonaws.com") return null;
  } catch {
    return null;
  }
  return `/mantra/image?url=${encodeURIComponent(href)}`;
}

function publicPlayer(row: PlayerRow): LiveDraftWishlistPlayer {
  const positions = parsePositions(row.positions_json);
  return {
    id: row.id,
    name: row.full_name || row.name,
    clubName: row.club_name,
    positions,
    goalkeeper: isGoalkeeper(positions),
    photoUrl: publicImage(row.avatar_path),
    clubLogoUrl: publicImage(row.club_logo),
  };
}

export function parseWishlistPlayerId(value: unknown): number | null {
  const playerId = typeof value === "string" && value.trim() ? Number(value.trim()) : Number(value);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return null;
  return playerId;
}

export function ensureLiveDraftWishlistTable(
  database: Database.Database = getDb(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_auction_wishlists (
      email TEXT NOT NULL,
      player_id INTEGER NOT NULL,
      target_bid INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (email, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_live_auction_wishlists_email
      ON live_auction_wishlists(email);
  `);
}

function loadPlayer(
  database: Database.Database,
  playerId: number,
): PlayerRow | undefined {
  return database
    .prepare(
      `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
       FROM mantra_players WHERE id = ? AND tournament_id = ?`,
    )
    .get(playerId, LIVE_AUCTION_RULES.tournamentId) as PlayerRow | undefined;
}

function fallbackPlayer(playerId: number): LiveDraftWishlistPlayer {
  return {
    id: playerId,
    name: `#${playerId}`,
    clubName: null,
    positions: [],
    goalkeeper: false,
    photoUrl: null,
    clubLogoUrl: null,
  };
}

function dropSoldWishlistRows(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `DELETE FROM live_auction_wishlists
       WHERE player_id IN (SELECT player_id FROM live_auction_awards)`,
    )
    .run();
}

export function listLiveDraftWishlist(
  actorEmail: string,
  database: Database.Database = getDb(),
): LiveDraftWishlistView {
  const you = normalizeEmail(actorEmail);
  ensureLiveDraftWishlistTable(database);
  dropSoldWishlistRows(database);
  const rows = database
    .prepare(
      `SELECT player_id, target_bid FROM live_auction_wishlists
       WHERE email = ? ORDER BY created_at ASC, player_id ASC`,
    )
    .all(you) as WishlistRow[];
  const items = rows.map((row) => {
    const player = loadPlayer(database, row.player_id);
    return {
      playerId: row.player_id,
      targetBid: row.target_bid,
      player: player ? publicPlayer(player) : fallbackPlayer(row.player_id),
    };
  });
  return { items };
}

export function upsertLiveDraftWishlist(
  actorEmail: string,
  playerId: unknown,
  targetBid: unknown,
  database: Database.Database = getDb(),
): LiveDraftWishlistView {
  const you = normalizeEmail(actorEmail);
  const id = parseWishlistPlayerId(playerId);
  if (id == null) throw new LiveAuctionError("invalid_player", 400);
  const bid = parseBidAmount(targetBid);
  if (bid == null) throw new LiveAuctionError("invalid_amount", 400);
  ensureLiveDraftWishlistTable(database);
  const player = loadPlayer(database, id);
  if (!player) throw new LiveAuctionError("player_not_found", 404);
  database
    .prepare(
      `INSERT INTO live_auction_wishlists (email, player_id, target_bid, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(email, player_id) DO UPDATE SET
         target_bid = excluded.target_bid,
         updated_at = excluded.updated_at`,
    )
    .run(you, id, bid);
  return listLiveDraftWishlist(you, database);
}

export function removeLiveDraftWishlist(
  actorEmail: string,
  playerId: unknown,
  database: Database.Database = getDb(),
): LiveDraftWishlistView {
  const you = normalizeEmail(actorEmail);
  const id = parseWishlistPlayerId(playerId);
  if (id == null) throw new LiveAuctionError("invalid_player", 400);
  ensureLiveDraftWishlistTable(database);
  database
    .prepare(`DELETE FROM live_auction_wishlists WHERE email = ? AND player_id = ?`)
    .run(you, id);
  return listLiveDraftWishlist(you, database);
}
