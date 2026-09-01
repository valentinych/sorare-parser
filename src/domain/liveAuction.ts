import type Database from "better-sqlite3";
import { config, isLiveDraftAdmin } from "../config.js";
import { getDb } from "../db/index.js";
import { ensureLiveDraftRow } from "./liveDraft.js";
import { liveDraftPresence } from "./liveDraftPresence.js";
import {
  LIVE_AUCTION_RULES,
  canAddPlayer,
  canAfford,
  isGoalkeeper,
  lotShouldHammer,
  managerCanEnterNextBid,
  maxLegalBid,
  minNextBid,
  parseBidAmount,
} from "./liveAuctionRules.js";

export class LiveAuctionError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

type RoomStatus = "lobby" | "running" | "complete";
type PauseReason = "stop" | "offline";

type RoomState = {
  nominationIndex: number;
  currentLotId: number | null;
  version: number;
  paused: boolean;
  pauseReason: PauseReason | null;
  pausedRemainingMs: number | null;
  ignoreOfflineEmails: string[];
};

type AwardRow = {
  player_id: number;
  email: string;
  amount: number;
  lot_id: number;
};

type LotRow = {
  id: number;
  player_id: number;
  nominator_email: string;
  high_bid: number;
  high_bidder_email: string;
  status: "open" | "sold";
  last_bid_at: string;
};

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

type UserRow = {
  email: string;
  name: string | null;
  mantra_manager_id?: number | null;
};

export type LiveAuctionClock = { now: () => number };

export const LIVE_AUCTION_TEAM_NAME_MAX = 40;
export const LIVE_AUCTION_PLAYER_LIST_LIMIT = 80;

const defaultClock: LiveAuctionClock = { now: () => Date.now() };

export function shuffleInPlace<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const current = items[i]!;
    items[i] = items[j]!;
    items[j] = current;
  }
  return items;
}

export function parseTeamName(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new LiveAuctionError("invalid_team_name", 400);
  }
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length > LIVE_AUCTION_TEAM_NAME_MAX) {
    throw new LiveAuctionError("invalid_team_name", 400);
  }
  return stripped;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
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

function parseEmails(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim().toLocaleLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parsePauseReason(value: unknown): PauseReason | null {
  return value === "stop" || value === "offline" ? value : null;
}

function parseIgnoreEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toLocaleLowerCase())
    .filter(Boolean);
}

function parseRemainingMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const remaining = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(remaining)) return null;
  return Math.max(0, Math.round(remaining));
}

function emptyRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    nominationIndex: 0,
    currentLotId: null,
    version: 0,
    paused: false,
    pauseReason: null,
    pausedRemainingMs: null,
    ignoreOfflineEmails: [],
    ...overrides,
  };
}

function parseState(raw: string): RoomState {
  try {
    const parsed = JSON.parse(raw) as Partial<RoomState>;
    return emptyRoomState({
      nominationIndex: Number(parsed.nominationIndex) || 0,
      currentLotId:
        parsed.currentLotId == null ? null : Number(parsed.currentLotId) || null,
      version: Number(parsed.version) || 0,
      paused: Boolean(parsed.paused),
      pauseReason: parsePauseReason(parsed.pauseReason),
      pausedRemainingMs: parseRemainingMs(parsed.pausedRemainingMs),
      ignoreOfflineEmails: parseIgnoreEmails(parsed.ignoreOfflineEmails),
    });
  } catch {
    return emptyRoomState();
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

function publicPlayer(row: PlayerRow) {
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

function spentByEmail(awards: AwardRow[]): Map<string, number> {
  const spent = new Map<string, number>();
  for (const award of awards) {
    spent.set(award.email, (spent.get(award.email) ?? 0) + award.amount);
  }
  return spent;
}

function squadOf(awards: AwardRow[], email: string, players: Map<number, PlayerRow>) {
  return awards
    .filter((award) => award.email === email)
    .map((award) => {
      const player = players.get(award.player_id);
      return {
        ...publicPlayer(
          player ?? {
            id: award.player_id,
            name: `#${award.player_id}`,
            full_name: null,
            first_name: null,
            positions_json: null,
            club_name: null,
            club_logo: null,
            avatar_path: null,
          },
        ),
        amount: award.amount,
      };
    });
}

export function ensureLiveAuctionTables(
  database: Database.Database = getDb(),
): void {
  ensureLiveDraftRow(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_auction_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      nominator_email TEXT NOT NULL,
      high_bid INTEGER NOT NULL,
      high_bidder_email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','sold')),
      last_bid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_auction_bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_auction_bids_lot ON live_auction_bids(lot_id);
    CREATE TABLE IF NOT EXISTS live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_auction_team_names (
      email TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      squad_id INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_auction_folds (
      lot_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (lot_id, email)
    );
  `);
  const teamCols = database
    .prepare(`PRAGMA table_info(live_auction_team_names)`)
    .all() as Array<{ name: string }>;
  if (!teamCols.some((col) => col.name === "squad_id")) {
    database.exec(`ALTER TABLE live_auction_team_names ADD COLUMN squad_id INTEGER`);
  }
}

function loadRoom(database: Database.Database) {
  ensureLiveAuctionTables(database);
  const row = database
    .prepare(
      `SELECT status, configured, participants_json, state_json
       FROM live_draft WHERE id = 1`,
    )
    .get() as {
    status: string;
    configured: number;
    participants_json: string;
    state_json: string;
  };
  const status = (
    row.status === "running" || row.status === "complete" || row.status === "lobby"
      ? row.status
      : "lobby"
  ) as RoomStatus;
  return {
    status: row.configured ? status : ("lobby" as RoomStatus),
    emails: parseEmails(row.participants_json),
    state: parseState(row.state_json),
  };
}

function saveRoom(
  database: Database.Database,
  status: RoomStatus,
  emails: string[],
  state: RoomState,
): void {
  database
    .prepare(
      `UPDATE live_draft
       SET configured = 1, status = ?, participants_json = ?, state_json = ?,
           rules_json = ?, updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run(
      status,
      JSON.stringify(emails),
      JSON.stringify(state),
      JSON.stringify(LIVE_AUCTION_RULES),
    );
}

function loadAwards(database: Database.Database): AwardRow[] {
  return database
    .prepare(`SELECT player_id, email, amount, lot_id FROM live_auction_awards`)
    .all() as AwardRow[];
}

function loadPlayers(database: Database.Database, ids: number[]): Map<number, PlayerRow> {
  const map = new Map<number, PlayerRow>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
       FROM mantra_players WHERE id IN (${placeholders})`,
    )
    .all(...ids) as PlayerRow[];
  for (const row of rows) map.set(row.id, row);
  return map;
}

function loadLot(database: Database.Database, id: number | null): LotRow | null {
  if (id == null) return null;
  return (
    (database
      .prepare(
        `SELECT id, player_id, nominator_email, high_bid, high_bidder_email, status, last_bid_at
         FROM live_auction_lots WHERE id = ?`,
      )
      .get(id) as LotRow | undefined) ?? null
  );
}

function loadFoldEmails(database: Database.Database, lotId: number | null): string[] {
  if (lotId == null) return [];
  return (
    database
      .prepare(`SELECT email FROM live_auction_folds WHERE lot_id = ?`)
      .all(lotId) as Array<{ email: string }>
  ).map((row) => row.email);
}

function namesByEmail(database: Database.Database, emails: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!emails.length) return map;
  const placeholders = emails.map(() => "?").join(",");
  const rows = database
    .prepare(`SELECT email, name FROM app_users WHERE lower(email) IN (${placeholders})`)
    .all(...emails) as UserRow[];
  for (const row of rows) {
    map.set(row.email.toLocaleLowerCase(), row.name || row.email.split("@")[0] || row.email);
  }
  return map;
}

function mantraIdsByEmail(
  database: Database.Database,
  emails: string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (!emails.length) return map;
  const placeholders = emails.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT email, mantra_manager_id FROM app_users
       WHERE lower(email) IN (${placeholders})`,
    )
    .all(...emails) as UserRow[];
  for (const row of rows) {
    const id = row.mantra_manager_id;
    if (id != null && Number.isSafeInteger(id) && id > 0) {
      map.set(row.email.toLocaleLowerCase(), id);
    }
  }
  return map;
}

function teamNamesByEmail(
  database: Database.Database,
  emails: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (!emails.length) return map;
  const placeholders = emails.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT email, team_name FROM live_auction_team_names
       WHERE lower(email) IN (${placeholders})`,
    )
    .all(...emails) as Array<{ email: string; team_name: string }>;
  for (const row of rows) {
    const name = row.team_name.trim();
    if (name) map.set(row.email.toLocaleLowerCase(), name);
  }
  return map;
}

function squadIdsByEmail(
  database: Database.Database,
  emails: string[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (!emails.length) return map;
  const placeholders = emails.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT email, squad_id FROM live_auction_team_names
       WHERE lower(email) IN (${placeholders})`,
    )
    .all(...emails) as Array<{ email: string; squad_id: number | null }>;
  for (const row of rows) {
    const id = row.squad_id;
    if (id != null && Number.isSafeInteger(id) && id > 0) {
      map.set(row.email.toLocaleLowerCase(), id);
    }
  }
  return map;
}

function displayName(
  email: string,
  teamNames: Map<string, string>,
  names: Map<string, string>,
): string {
  return teamNames.get(email) || names.get(email) || email.split("@")[0] || email;
}

function managerStats(awards: AwardRow[], players: Map<number, PlayerRow>, email: string) {
  const squad = awards.filter((award) => award.email === email);
  const spent = squad.reduce((sum, award) => sum + award.amount, 0);
  const goalkeepers = squad.filter((award) => {
    const player = players.get(award.player_id);
    return player ? isGoalkeeper(parsePositions(player.positions_json)) : false;
  }).length;
  return {
    spent,
    budgetLeft: LIVE_AUCTION_RULES.startingBudget - spent,
    squadSize: squad.length,
    goalkeepers,
  };
}

function eligibleToNominate(
  emails: string[],
  awards: AwardRow[],
  players: Map<number, PlayerRow>,
): string[] {
  return emails.filter((email) => {
    const stats = managerStats(awards, players, email);
    return (
      stats.squadSize < LIVE_AUCTION_RULES.squadSize &&
      stats.budgetLeft >= LIVE_AUCTION_RULES.minBid
    );
  });
}

function nextNominator(
  emails: string[],
  awards: AwardRow[],
  players: Map<number, PlayerRow>,
  fromIndex: number,
): { email: string; index: number } | null {
  if (!emails.length) return null;
  for (let offset = 0; offset < emails.length; offset++) {
    const index = (fromIndex + offset) % emails.length;
    const email = emails[index]!;
    const stats = managerStats(awards, players, email);
    if (
      stats.squadSize < LIVE_AUCTION_RULES.squadSize &&
      stats.budgetLeft >= LIVE_AUCTION_RULES.minBid
    ) {
      return { email, index };
    }
  }
  return null;
}

function lotRemainingMs(lot: LotRow, now: number): number {
  const lastBidMs = Date.parse(lot.last_bid_at);
  if (!Number.isFinite(lastBidMs)) return LIVE_AUCTION_RULES.hammerMs;
  return Math.max(
    0,
    Math.min(LIVE_AUCTION_RULES.hammerMs, lastBidMs + LIVE_AUCTION_RULES.hammerMs - now),
  );
}

function offlineEmails(emails: string[], now: number): string[] {
  return emails.filter((email) => !liveDraftPresence(email, now).online);
}

function restorePausedLot(
  database: Database.Database,
  state: RoomState,
  clock: LiveAuctionClock,
): void {
  if (!state.paused || state.currentLotId == null || state.pausedRemainingMs == null) {
    return;
  }
  const lot = loadLot(database, state.currentLotId);
  if (!lot || lot.status !== "open") return;
  const remaining = Math.max(
    0,
    Math.min(LIVE_AUCTION_RULES.hammerMs, state.pausedRemainingMs),
  );
  const lastBidAt = clock.now() - (LIVE_AUCTION_RULES.hammerMs - remaining);
  database
    .prepare(`UPDATE live_auction_lots SET last_bid_at = ? WHERE id = ?`)
    .run(iso(lastBidAt), lot.id);
}

function pauseRoom(
  database: Database.Database,
  room: { status: RoomStatus; emails: string[]; state: RoomState },
  reason: PauseReason,
  clock: LiveAuctionClock,
  ignoreOfflineEmails = room.state.ignoreOfflineEmails,
): { status: RoomStatus; emails: string[]; state: RoomState } {
  const lot = loadLot(database, room.state.currentLotId);
  const remaining =
    lot && lot.status === "open" ? lotRemainingMs(lot, clock.now()) : null;
  const state = emptyRoomState({
    ...room.state,
    paused: true,
    pauseReason: reason,
    pausedRemainingMs: remaining,
    ignoreOfflineEmails,
    version: room.state.version + 1,
  });
  saveRoom(database, room.status, room.emails, state);
  return { ...room, state };
}

function applyPresencePause(
  database: Database.Database,
  room: { status: RoomStatus; emails: string[]; state: RoomState },
  clock: LiveAuctionClock,
): { status: RoomStatus; emails: string[]; state: RoomState } {
  if (room.status !== "running") return room;
  const now = clock.now();
  const ignore = new Set(room.state.ignoreOfflineEmails);
  let ignoreChanged = false;
  for (const email of [...ignore]) {
    if (liveDraftPresence(email, now).online) {
      ignore.delete(email);
      ignoreChanged = true;
    }
  }
  const nextIgnore = [...ignore];
  if (!room.state.paused) {
    const offender = room.emails.find(
      (email) => !ignore.has(email) && !liveDraftPresence(email, now).online,
    );
    if (offender) {
      return pauseRoom(database, room, "offline", clock, nextIgnore);
    }
  }
  if (!ignoreChanged) return room;
  const state = { ...room.state, ignoreOfflineEmails: nextIgnore };
  saveRoom(database, room.status, room.emails, state);
  return { ...room, state };
}

function requireActiveAuction(
  database: Database.Database,
  room: { status: RoomStatus; emails: string[]; state: RoomState },
  clock: LiveAuctionClock,
): { status: RoomStatus; emails: string[]; state: RoomState } {
  if (room.status !== "running") throw new LiveAuctionError("auction_not_running", 409);
  const next = applyPresencePause(database, room, clock);
  if (next.state.paused) throw new LiveAuctionError("auction_paused", 409);
  return next;
}

function awardOpenLot(
  database: Database.Database,
  emails: string[],
  state: RoomState,
  clock: LiveAuctionClock,
): RoomState {
  const lot = loadLot(database, state.currentLotId);
  if (!lot || lot.status !== "open") return state;
  const now = iso(clock.now());
  database
    .prepare(`UPDATE live_auction_lots SET status = 'sold' WHERE id = ?`)
    .run(lot.id);
  database
    .prepare(
      `INSERT OR IGNORE INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(lot.player_id, lot.high_bidder_email, lot.high_bid, lot.id, now);
  const awards = loadAwards(database);
  const players = loadPlayers(
    database,
    awards.map((award) => award.player_id),
  );
  const nominatorIndex = emails.indexOf(lot.nominator_email);
  const next = nextNominator(
    emails,
    awards,
    players,
    (nominatorIndex >= 0 ? nominatorIndex : state.nominationIndex) + 1,
  );
  return {
    ...state,
    nominationIndex: next?.index ?? state.nominationIndex,
    currentLotId: null,
    version: state.version + 1,
  };
}

function settleOpenLot(
  database: Database.Database,
  emails: string[],
  state: RoomState,
  clock: LiveAuctionClock,
): RoomState {
  if (state.paused) return state;
  const lot = loadLot(database, state.currentLotId);
  if (!lot || lot.status !== "open") return state;
  const folds = loadFoldEmails(database, lot.id);
  const rivals = emails.filter((email) => email !== lot.high_bidder_email);
  if (
    !lotShouldHammer({
      now: clock.now(),
      lastBidAtMs: Date.parse(lot.last_bid_at),
      foldCount: folds.length,
      rivalCount: rivals.length,
      foldedRivalCount: rivals.filter((email) => folds.includes(email)).length,
    })
  ) {
    return state;
  }
  return awardOpenLot(database, emails, state, clock);
}

function lotCanAutopick(input: {
  emails: string[];
  awards: AwardRow[];
  players: Map<number, PlayerRow>;
  lot: LotRow;
  folds: string[];
  player: PlayerRow | null;
  paused: boolean;
  pauseReason: PauseReason | null;
}): boolean {
  if (input.lot.status !== "open") return false;
  if (input.paused && input.pauseReason === "stop") return false;
  const nextBid = minNextBid(input.lot.high_bid);
  const playerIsGk = input.player
    ? isGoalkeeper(parsePositions(input.player.positions_json))
    : false;
  for (const email of input.emails) {
    if (email === input.lot.high_bidder_email) continue;
    if (input.folds.includes(email)) continue;
    const stats = managerStats(input.awards, input.players, email);
    if (
      managerCanEnterNextBid({
        budgetLeft: stats.budgetLeft,
        squadSize: stats.squadSize,
        goalkeepers: stats.goalkeepers,
        playerIsGk,
        nextBid,
      })
    ) {
      return false;
    }
  }
  return true;
}

function assertCanBuy(
  awards: AwardRow[],
  players: Map<number, PlayerRow>,
  email: string,
  player: PlayerRow,
  amount: number,
): void {
  const stats = managerStats(awards, players, email);
  if (!canAfford(stats.budgetLeft, amount)) {
    throw new LiveAuctionError("budget_exceeded", 400);
  }
  if (amount > maxLegalBid(stats.budgetLeft, stats.squadSize)) {
    throw new LiveAuctionError("bid_over_max", 400);
  }
  if (
    !canAddPlayer(
      stats.squadSize,
      stats.goalkeepers,
      isGoalkeeper(parsePositions(player.positions_json)),
    )
  ) {
    throw new LiveAuctionError(
      stats.squadSize >= LIVE_AUCTION_RULES.squadSize
        ? "squad_full"
        : "need_goalkeepers",
      400,
    );
  }
}

function resolveActingManager(actorEmail: string, asEmail: unknown): string {
  const actor = actorEmail.trim().toLocaleLowerCase();
  if (asEmail == null || asEmail === "") return actor;
  if (typeof asEmail !== "string") throw new LiveAuctionError("unknown_manager", 400);
  const target = asEmail.trim().toLocaleLowerCase();
  if (!target || target === actor) return actor;
  if (!isLiveDraftAdmin(actor)) throw new LiveAuctionError("not_admin", 403);
  return target;
}

function requireParticipant(emails: string[], email: string): void {
  if (!emails.includes(email)) throw new LiveAuctionError("unknown_manager", 400);
}

export function getLiveAuctionRoom(
  actorEmail: string,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
) {
  return database.transaction(() => {
    let room = loadRoom(database);
    if (room.status === "running") {
      room = applyPresencePause(database, room, clock);
      if (!room.state.paused) {
        const nextState = settleOpenLot(database, room.emails, room.state, clock);
        if (nextState !== room.state) {
          const awards = loadAwards(database);
          const players = loadPlayers(
            database,
            awards.map((award) => award.player_id),
          );
          const remaining = eligibleToNominate(room.emails, awards, players);
          const status: RoomStatus = remaining.length ? "running" : "complete";
          saveRoom(database, status, room.emails, nextState);
          room = { status, emails: room.emails, state: nextState };
        }
      }
    }
    const awards = loadAwards(database);
    const playerIds = [
      ...awards.map((award) => award.player_id),
      room.state.currentLotId
        ? (loadLot(database, room.state.currentLotId)?.player_id ?? 0)
        : 0,
    ].filter(Boolean);
    const players = loadPlayers(database, playerIds);
    const you = actorEmail.trim().toLocaleLowerCase();
    const managerEmails = room.emails.length
      ? room.emails
      : [...config.liveDraftEmails];
    const nameEmails = [...new Set([...managerEmails, you])];
    const names = namesByEmail(database, nameEmails);
    const mantraIds = mantraIdsByEmail(database, nameEmails);
    const teamNames = teamNamesByEmail(database, nameEmails);
    const squadIds = squadIdsByEmail(database, nameEmails);
    const lot = loadLot(database, room.state.currentLotId);
    const lotPlayer = lot ? players.get(lot.player_id) : null;
    const folds = loadFoldEmails(database, lot?.id ?? null);
    const bids = lot
      ? (database
          .prepare(
            `SELECT email, amount, created_at FROM live_auction_bids
             WHERE lot_id = ? ORDER BY id ASC`,
          )
          .all(lot.id) as Array<{ email: string; amount: number; created_at: string }>)
      : [];
    const nominator = room.emails[room.state.nominationIndex] ?? room.emails[0] ?? null;
    const now = clock.now();
    const lotOpen = Boolean(lot && lot.status === "open");
    const hammerRemainingMs = lotOpen && lot
      ? room.state.paused
        ? (room.state.pausedRemainingMs ?? 0)
        : lotRemainingMs(lot, now)
      : null;
    const lastBidMs = lot ? Date.parse(lot.last_bid_at) : NaN;
    const hammerEndsAt =
      lotOpen && lot
        ? room.state.paused
          ? now + (hammerRemainingMs ?? 0)
          : Number.isFinite(lastBidMs)
            ? lastBidMs + LIVE_AUCTION_RULES.hammerMs
            : null
        : null;
    const youStats = managerStats(awards, players, you);
    const yourMaxBid = maxLegalBid(youStats.budgetLeft, youStats.squadSize);
    return {
      entitled: true,
      admin: isLiveDraftAdmin(you),
      you,
      status: room.status,
      paused: room.state.paused,
      pauseReason: room.state.pauseReason,
      rules: LIVE_AUCTION_RULES,
      version: room.state.version,
      nominator,
      nominatorName: nominator ? displayName(nominator, teamNames, names) : null,
      yourTurn:
        room.status === "running" && !room.state.paused && !lot && nominator === you,
      yourMaxBid,
      lot: lotOpen && lot
        ? {
            id: lot.id,
            player: lotPlayer ? publicPlayer(lotPlayer) : { id: lot.player_id },
            nominator: lot.nominator_email,
            nominatorName: displayName(lot.nominator_email, teamNames, names),
            highBid: lot.high_bid,
            highBidder: lot.high_bidder_email,
            highBidderName: displayName(lot.high_bidder_email, teamNames, names),
            minNextBid: minNextBid(lot.high_bid),
            youMaxBid: yourMaxBid,
            youAreLeader: lot.high_bidder_email === you,
            canAutopick: lotCanAutopick({
              emails: room.emails,
              awards,
              players,
              lot,
              folds,
              player: lotPlayer ?? null,
              paused: room.state.paused,
              pauseReason: room.state.pauseReason,
            }),
            hammerEndsAt,
            hammerRemainingMs,
            foldCount: folds.length,
            youFolded: folds.includes(you),
            folds: folds.map((email) => ({
              email,
              name: displayName(email, teamNames, names),
            })),
            bids: bids.map((bid) => ({
              email: bid.email,
              name: displayName(bid.email, teamNames, names),
              amount: bid.amount,
              at: bid.created_at,
            })),
          }
        : null,
      managers: managerEmails.map((email, index) => {
        const stats = managerStats(awards, players, email);
        const presence = liveDraftPresence(email, now);
        return {
          email,
          name: displayName(email, teamNames, names),
          teamName: teamNames.get(email) || "",
          squadId: squadIds.get(email) ?? null,
          mantraManagerId: mantraIds.get(email) ?? null,
          turn: index === room.state.nominationIndex,
          folded: lotOpen && folds.includes(email),
          online: presence.online,
          pingMs: presence.pingMs,
          ...stats,
          squad: squadOf(awards, email, players),
        };
      }),
      namedTeams: managerEmails.flatMap((email) => {
        const teamName = teamNames.get(email) || "";
        return teamName
          ? [{ email, teamName, squadId: squadIds.get(email) ?? null }]
          : [];
      }),
      yourTeamName: teamNames.get(you) || "",
      squad: squadOf(awards, you, players),
    };
  })();
}

export function startLiveAuction(
  actorEmail: string,
  database: Database.Database = getDb(),
  emails = [...config.liveDraftEmails],
  clock: LiveAuctionClock = defaultClock,
): ReturnType<typeof getLiveAuctionRoom> {
  if (!isLiveDraftAdmin(actorEmail)) throw new LiveAuctionError("not_admin", 403);
  const participants = emails.map((email) => email.trim().toLocaleLowerCase()).filter(Boolean);
  if (participants.length < 2) throw new LiveAuctionError("need_participants", 400);
  database.transaction(() => {
    const room = loadRoom(database);
    if (room.status === "complete") throw new LiveAuctionError("reset_required", 409);
    const ignore = offlineEmails(participants, clock.now());
    if (room.status === "running") {
      if (!room.state.paused) return;
      restorePausedLot(database, room.state, clock);
      saveRoom(
        database,
        "running",
        room.emails.length ? room.emails : participants,
        emptyRoomState({
          ...room.state,
          paused: false,
          pauseReason: null,
          pausedRemainingMs: null,
          ignoreOfflineEmails: ignore,
          version: room.state.version + 1,
        }),
      );
      return;
    }
    saveRoom(
      database,
      "running",
      participants,
      emptyRoomState({
        nominationIndex: 0,
        currentLotId: null,
        version: room.state.version + 1,
        ignoreOfflineEmails: ignore,
      }),
    );
  })();
  return getLiveAuctionRoom(actorEmail, database, clock);
}

export function stopLiveAuction(
  actorEmail: string,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
): ReturnType<typeof getLiveAuctionRoom> {
  const you = actorEmail.trim().toLocaleLowerCase();
  database.transaction(() => {
    const room = loadRoom(database);
    if (room.status !== "running") throw new LiveAuctionError("auction_not_running", 409);
    if (room.state.paused) return;
    pauseRoom(database, room, "stop", clock);
  })();
  return getLiveAuctionRoom(you, database, clock);
}

export function resetLiveAuction(
  actorEmail: string,
  database: Database.Database = getDb(),
): ReturnType<typeof getLiveAuctionRoom> {
  if (!isLiveDraftAdmin(actorEmail)) throw new LiveAuctionError("not_admin", 403);
  database.transaction(() => {
    ensureLiveAuctionTables(database);
    const version = loadRoom(database).state.version + 1;
    database.exec(`DELETE FROM live_auction_folds`);
    database.exec(`DELETE FROM live_auction_bids`);
    database.exec(`DELETE FROM live_auction_lots`);
    database.exec(`DELETE FROM live_auction_awards`);
    saveRoom(
      database,
      "lobby",
      [...config.liveDraftEmails],
      emptyRoomState({ version }),
    );
  })();
  return getLiveAuctionRoom(actorEmail, database);
}

export function searchLiveAuctionPlayers(
  query: string,
  database: Database.Database = getDb(),
  random: () => number = Math.random,
) {
  ensureLiveAuctionTables(database);
  const needle = query.trim().replace(/%/g, "").slice(0, 80);
  const params: Array<string | number> = [LIVE_AUCTION_RULES.tournamentId];
  let sql = `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
       FROM mantra_players
       WHERE tournament_id = ?
         AND id NOT IN (SELECT player_id FROM live_auction_awards)`;
  if (needle.length >= 2) {
    sql += ` AND (name LIKE ? COLLATE NOCASE OR IFNULL(full_name, '') LIKE ? COLLATE NOCASE)`;
    const like = `%${needle}%`;
    params.push(like, like);
  }
  sql += ` ORDER BY id`;
  const rows = database.prepare(sql).all(...params) as PlayerRow[];
  return shuffleInPlace(rows, random)
    .slice(0, LIVE_AUCTION_PLAYER_LIST_LIMIT)
    .map(publicPlayer);
}

export function setLiveAuctionTeamName(
  actorEmail: string,
  teamName: unknown,
  database: Database.Database = getDb(),
  forEmail = actorEmail,
): ReturnType<typeof getLiveAuctionRoom> {
  const you = actorEmail.trim().toLocaleLowerCase();
  const target = forEmail.trim().toLocaleLowerCase();
  if (!you || target !== you) {
    throw new LiveAuctionError("not_owner", 403);
  }
  const name = parseTeamName(teamName);
  database.transaction(() => {
    ensureLiveAuctionTables(database);
    if (!name) {
      database
        .prepare(
          `UPDATE live_auction_team_names
           SET team_name = '', updated_at = datetime('now')
           WHERE lower(email) = ?`,
        )
        .run(you);
      return;
    }
    database
      .prepare(
        `INSERT INTO live_auction_team_names (email, team_name, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(email) DO UPDATE SET team_name = excluded.team_name,
           updated_at = excluded.updated_at`,
      )
      .run(you, name);
  })();
  return getLiveAuctionRoom(you, database);
}

export function nominateLiveAuctionPlayer(
  actorEmail: string,
  playerId: number,
  amount: unknown,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
  asEmail?: unknown,
): ReturnType<typeof getLiveAuctionRoom> {
  const bid = parseBidAmount(amount);
  if (bid == null) throw new LiveAuctionError("invalid_amount", 400);
  const actor = actorEmail.trim().toLocaleLowerCase();
  const as = resolveActingManager(actor, asEmail);
  const db = database ?? getDb();
  const nowClock = clock ?? defaultClock;
  db.transaction(() => {
    let room = loadRoom(db);
    room = requireActiveAuction(db, room, nowClock);
    room = {
      ...room,
      state: settleOpenLot(db, room.emails, room.state, nowClock),
    };
    if (room.state.currentLotId) throw new LiveAuctionError("lot_already_open", 409);
    requireParticipant(room.emails, as);
    const nominator = nextNominator(
      room.emails,
      loadAwards(db),
      loadPlayers(
        db,
        loadAwards(db).map((award) => award.player_id),
      ),
      room.state.nominationIndex,
    );
    if (!nominator) {
      saveRoom(db, "complete", room.emails, { ...room.state, currentLotId: null });
      throw new LiveAuctionError("auction_complete", 409);
    }
    if (nominator.email !== as && !isLiveDraftAdmin(actor)) {
      throw new LiveAuctionError("not_your_turn", 403);
    }
    const awarded = db
      .prepare(`SELECT 1 FROM live_auction_awards WHERE player_id = ?`)
      .get(playerId);
    if (awarded) throw new LiveAuctionError("player_sold", 409);
    const player = db
      .prepare(
        `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
         FROM mantra_players WHERE id = ? AND tournament_id = ?`,
      )
      .get(playerId, LIVE_AUCTION_RULES.tournamentId) as PlayerRow | undefined;
    if (!player) throw new LiveAuctionError("player_not_found", 404);
    const awards = loadAwards(db);
    const players = loadPlayers(db, [
      ...awards.map((award) => award.player_id),
      player.id,
    ]);
    players.set(player.id, player);
    assertCanBuy(awards, players, as, player, bid);
    const now = iso(nowClock.now());
    const result = db
      .prepare(
        `INSERT INTO live_auction_lots
           (player_id, nominator_email, high_bid, high_bidder_email, status, last_bid_at, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(player.id, as, bid, as, now, now);
    const lotId = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO live_auction_bids (lot_id, email, amount, created_at) VALUES (?, ?, ?, ?)`,
    ).run(lotId, as, bid, now);
    saveRoom(db, "running", room.emails, {
      ...room.state,
      nominationIndex: nominator.index,
      currentLotId: lotId,
      version: room.state.version + 1,
    });
  })();
  return getLiveAuctionRoom(actor, db, nowClock);
}

export function bidLiveAuction(
  actorEmail: string,
  amount: unknown,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
  asEmail?: unknown,
): ReturnType<typeof getLiveAuctionRoom> {
  const bid = parseBidAmount(amount);
  if (bid == null) throw new LiveAuctionError("invalid_amount", 400);
  const actor = actorEmail.trim().toLocaleLowerCase();
  const as = resolveActingManager(actor, asEmail);
  const db = database ?? getDb();
  const nowClock = clock ?? defaultClock;
  db.transaction(() => {
    let room = loadRoom(db);
    room = requireActiveAuction(db, room, nowClock);
    room = {
      ...room,
      state: settleOpenLot(db, room.emails, room.state, nowClock),
    };
    requireParticipant(room.emails, as);
    const lot = loadLot(db, room.state.currentLotId);
    if (!lot || lot.status !== "open") throw new LiveAuctionError("no_open_lot", 409);
    if (loadFoldEmails(db, lot.id).includes(as)) {
      throw new LiveAuctionError("folded", 400);
    }
    if (lot.high_bidder_email === as && lot.high_bid === bid) return;
    if (lot.high_bidder_email === as) throw new LiveAuctionError("already_high_bid", 400);
    if (bid < minNextBid(lot.high_bid)) throw new LiveAuctionError("bid_too_low", 400);
    const player = db
      .prepare(
        `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
         FROM mantra_players WHERE id = ?`,
      )
      .get(lot.player_id) as PlayerRow | undefined;
    if (!player) throw new LiveAuctionError("player_not_found", 404);
    const awards = loadAwards(db);
    const players = loadPlayers(db, [
      ...awards.map((award) => award.player_id),
      player.id,
    ]);
    players.set(player.id, player);
    assertCanBuy(awards, players, as, player, bid);
    const now = iso(nowClock.now());
    db.prepare(
      `INSERT INTO live_auction_bids (lot_id, email, amount, created_at) VALUES (?, ?, ?, ?)`,
    ).run(lot.id, as, bid, now);
    db.prepare(
      `UPDATE live_auction_lots SET high_bid = ?, high_bidder_email = ?, last_bid_at = ? WHERE id = ?`,
    ).run(bid, as, now, lot.id);
    saveRoom(db, "running", room.emails, {
      ...room.state,
      currentLotId: lot.id,
      version: room.state.version + 1,
    });
  })();
  return getLiveAuctionRoom(actor, db, nowClock);
}

export function correctLiveAuctionAward(
  actorEmail: string,
  playerId: number,
  patch: { amount?: unknown; email?: unknown } = {},
  database: Database.Database = getDb(),
): ReturnType<typeof getLiveAuctionRoom> {
  if (!isLiveDraftAdmin(actorEmail)) throw new LiveAuctionError("not_admin", 403);
  const actor = actorEmail.trim().toLocaleLowerCase();
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    throw new LiveAuctionError("invalid_player", 400);
  }
  database.transaction(() => {
    const room = loadRoom(database);
    const award = (
      database
        .prepare(
          `SELECT player_id, email, amount, lot_id FROM live_auction_awards WHERE player_id = ?`,
        )
        .get(playerId) as AwardRow | undefined
    );
    if (!award) throw new LiveAuctionError("player_not_sold", 404);
    const participants = room.emails.length ? room.emails : [...config.liveDraftEmails];
    let nextEmail = award.email;
    if (patch.email != null && patch.email !== "") {
      if (typeof patch.email !== "string") {
        throw new LiveAuctionError("unknown_manager", 400);
      }
      nextEmail = patch.email.trim().toLocaleLowerCase();
    }
    requireParticipant(participants, nextEmail);
    let nextAmount = award.amount;
    if (patch.amount != null && patch.amount !== "") {
      const parsed = parseBidAmount(patch.amount);
      if (parsed == null) throw new LiveAuctionError("invalid_amount", 400);
      nextAmount = parsed;
    }
    if (nextEmail === award.email && nextAmount === award.amount) return;
    const player = database
      .prepare(
        `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
         FROM mantra_players WHERE id = ? AND tournament_id = ?`,
      )
      .get(playerId, LIVE_AUCTION_RULES.tournamentId) as PlayerRow | undefined;
    if (!player) throw new LiveAuctionError("player_not_found", 404);
    const awards = loadAwards(database).filter((row) => row.player_id !== playerId);
    const players = loadPlayers(database, [
      ...awards.map((row) => row.player_id),
      player.id,
    ]);
    players.set(player.id, player);
    assertCanBuy(awards, players, nextEmail, player, nextAmount);
    database
      .prepare(`UPDATE live_auction_awards SET email = ?, amount = ? WHERE player_id = ?`)
      .run(nextEmail, nextAmount, playerId);
    if (award.lot_id) {
      database
        .prepare(
          `UPDATE live_auction_lots SET high_bid = ?, high_bidder_email = ? WHERE id = ?`,
        )
        .run(nextAmount, nextEmail, award.lot_id);
    }
    saveRoom(database, room.status, room.emails.length ? room.emails : participants, {
      ...room.state,
      version: room.state.version + 1,
    });
  })();
  return getLiveAuctionRoom(actor, database);
}

/** Drop one sold player back into the unsold pool. Does not wipe bids or other awards. */
export function releaseLiveAuctionPlayer(
  actorEmail: string,
  playerId: number,
  fromEmail: unknown = null,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
): ReturnType<typeof getLiveAuctionRoom> {
  if (!isLiveDraftAdmin(actorEmail)) throw new LiveAuctionError("not_admin", 403);
  const actor = actorEmail.trim().toLocaleLowerCase();
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    throw new LiveAuctionError("invalid_player", 400);
  }
  database.transaction(() => {
    ensureLiveAuctionTables(database);
    const room = loadRoom(database);
    const award = (
      database
        .prepare(
          `SELECT player_id, email, amount, lot_id FROM live_auction_awards WHERE player_id = ?`,
        )
        .get(playerId) as AwardRow | undefined
    );
    if (!award) return;
    if (fromEmail != null && fromEmail !== "") {
      if (typeof fromEmail !== "string") {
        throw new LiveAuctionError("unknown_manager", 400);
      }
      const owner = fromEmail.trim().toLocaleLowerCase();
      if (award.email !== owner) {
        throw new LiveAuctionError("player_not_on_roster", 409);
      }
    }
    database
      .prepare(`DELETE FROM live_auction_awards WHERE player_id = ?`)
      .run(playerId);
    const awards = loadAwards(database);
    const players = loadPlayers(
      database,
      awards.map((row) => row.player_id),
    );
    const emails = room.emails.length ? room.emails : [...config.liveDraftEmails];
    const remaining = eligibleToNominate(emails, awards, players);
    const status: RoomStatus =
      room.status === "complete" && remaining.length ? "running" : room.status;
    saveRoom(database, status, emails, {
      ...room.state,
      version: room.state.version + 1,
    });
  })();
  return getLiveAuctionRoom(actor, database, clock);
}

export function foldLiveAuction(
  actorEmail: string,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
): ReturnType<typeof getLiveAuctionRoom> {
  const you = actorEmail.trim().toLocaleLowerCase();
  database.transaction(() => {
    let room = loadRoom(database);
    room = requireActiveAuction(database, room, clock);
    room = {
      ...room,
      state: settleOpenLot(database, room.emails, room.state, clock),
    };
    const lot = loadLot(database, room.state.currentLotId);
    if (!lot || lot.status !== "open") throw new LiveAuctionError("no_open_lot", 409);
    if (lot.high_bidder_email === you) {
      throw new LiveAuctionError("leader_cannot_fold", 403);
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO live_auction_folds (lot_id, email, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(lot.id, you, iso(clock.now()));
    const settled = settleOpenLot(database, room.emails, room.state, clock);
    const nextState =
      settled === room.state
        ? { ...room.state, version: room.state.version + 1 }
        : settled;
    let status: RoomStatus = "running";
    if (settled !== room.state) {
      const awards = loadAwards(database);
      const players = loadPlayers(
        database,
        awards.map((award) => award.player_id),
      );
      status = eligibleToNominate(room.emails, awards, players).length
        ? "running"
        : "complete";
    }
    saveRoom(database, status, room.emails, nextState);
  })();
  return getLiveAuctionRoom(you, database, clock);
}

export function autopickLiveAuction(
  actorEmail: string,
  database: Database.Database = getDb(),
  clock: LiveAuctionClock = defaultClock,
): ReturnType<typeof getLiveAuctionRoom> {
  if (!isLiveDraftAdmin(actorEmail)) throw new LiveAuctionError("not_admin", 403);
  const you = actorEmail.trim().toLocaleLowerCase();
  database.transaction(() => {
    let room = loadRoom(database);
    if (room.status !== "running") throw new LiveAuctionError("auction_not_running", 409);
    room = applyPresencePause(database, room, clock);
    if (room.state.paused && room.state.pauseReason === "stop") {
      throw new LiveAuctionError("auction_paused", 409);
    }
    const lot = loadLot(database, room.state.currentLotId);
    if (!lot || lot.status !== "open") throw new LiveAuctionError("no_open_lot", 409);
    const folds = loadFoldEmails(database, lot.id);
    const awards = loadAwards(database);
    const player = (
      (database
        .prepare(
          `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo, avatar_path
           FROM mantra_players WHERE id = ?`,
        )
        .get(lot.player_id) as PlayerRow | undefined) ?? null
    );
    const players = loadPlayers(database, [
      ...awards.map((award) => award.player_id),
      lot.player_id,
    ]);
    if (player) players.set(player.id, player);
    if (
      !lotCanAutopick({
        emails: room.emails,
        awards,
        players,
        lot,
        folds,
        player,
        paused: room.state.paused,
        pauseReason: room.state.pauseReason,
      })
    ) {
      throw new LiveAuctionError("cannot_autopick", 409);
    }
    const nextState = awardOpenLot(database, room.emails, room.state, clock);
    const nextAwards = loadAwards(database);
    const nextPlayers = loadPlayers(
      database,
      nextAwards.map((award) => award.player_id),
    );
    const status: RoomStatus = eligibleToNominate(
      room.emails,
      nextAwards,
      nextPlayers,
    ).length
      ? "running"
      : "complete";
    saveRoom(database, status, room.emails, nextState);
  })();
  return getLiveAuctionRoom(you, database, clock);
}
