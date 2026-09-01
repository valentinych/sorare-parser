import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { POSITION_MALUS } from "../lib/mantraScoring.js";
import { LIVE_AUCTION_RULES, isGoalkeeper } from "./liveAuctionRules.js";

type PlayerRow = {
  id: number;
  name: string;
  full_name: string | null;
  first_name: string | null;
  positions_json: string | null;
  club_name: string | null;
  club_logo: string | null;
  avatar_path: string | null;
  average_price: number | null;
};

export type LiveDraftWishlistFilterPlayer = {
  id: number;
  name: string;
  clubName: string | null;
  positions: string[];
  goalkeeper: boolean;
  photoUrl: string | null;
  clubLogoUrl: string | null;
  averagePrice: number | null;
};

export type LiveDraftWishlistFilterView = {
  clubs: string[];
  positions: string[];
  players: LiveDraftWishlistFilterPlayer[];
  sort: "average_price";
};

export const LIVE_DRAFT_WISHLIST_FILTER_LIMIT = 5;
export const LIVE_DRAFT_WISHLIST_FILTER_SORT = "average_price" as const;

/** Mantra club_name strings for the 20 EPL 2026/27 clubs (tournament_id=2). */
export const LIVE_DRAFT_EPL_CLUBS = [
  "Arsenal",
  "Aston Villa",
  "Bournemouth",
  "Brentford",
  "Brighton",
  "Chelsea",
  "Coventry City",
  "Crystal Palace",
  "Everton",
  "Fulham",
  "Hull City",
  "Ipswich",
  "Leeds",
  "Liverpool",
  "Manchester City",
  "Manchester United",
  "Newcastle",
  "Nottingham Forest",
  "Sunderland",
  "Tottenham",
] as const;

const EPL_CLUB_ALIASES: Record<string, (typeof LIVE_DRAFT_EPL_CLUBS)[number]> = {
  "afc bournemouth": "Bournemouth",
  "arsenal fc": "Arsenal",
  "brentford fc": "Brentford",
  "brighton & hove albion": "Brighton",
  "brighton and hove albion": "Brighton",
  "chelsea fc": "Chelsea",
  coventry: "Coventry City",
  "everton fc": "Everton",
  "fulham fc": "Fulham",
  hull: "Hull City",
  "ipswich town": "Ipswich",
  "leeds united": "Leeds",
  "liverpool fc": "Liverpool",
  "man city": "Manchester City",
  "man. city": "Manchester City",
  "man united": "Manchester United",
  "man utd": "Manchester United",
  "man. united": "Manchester United",
  "newcastle united": "Newcastle",
  "sunderland afc": "Sunderland",
  "tottenham hotspur": "Tottenham",
  spurs: "Tottenham",
};

for (const name of LIVE_DRAFT_EPL_CLUBS) {
  EPL_CLUB_ALIASES[name.toLowerCase()] = name;
}

const POSITION_ORDER = Object.keys(POSITION_MALUS);

function parseFilter(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 80);
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

function publicPlayer(row: PlayerRow): LiveDraftWishlistFilterPlayer {
  const positions = parsePositions(row.positions_json);
  return {
    id: row.id,
    name: row.full_name || row.name,
    clubName: row.club_name,
    positions,
    goalkeeper: isGoalkeeper(positions),
    photoUrl: publicImage(row.avatar_path),
    clubLogoUrl: publicImage(row.club_logo),
    averagePrice: row.average_price == null ? null : Number(row.average_price),
  };
}

function playerName(row: PlayerRow): string {
  return row.full_name || row.name;
}

function compareSuggestions(a: PlayerRow, b: PlayerRow): number {
  const aPrice = a.average_price;
  const bPrice = b.average_price;
  if (aPrice == null && bPrice != null) return 1;
  if (bPrice == null && aPrice != null) return -1;
  if (aPrice != null && bPrice != null && aPrice !== bPrice) return bPrice - aPrice;
  const byName = playerName(a).localeCompare(playerName(b), undefined, {
    sensitivity: "base",
  });
  if (byName) return byName;
  return a.id - b.id;
}

function uniqueSorted(values: string[], order?: string[]): string[] {
  const unique = [...new Set(values.filter(Boolean))];
  unique.sort((a, b) => {
    if (order?.length) {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai >= 0 || bi >= 0) {
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        if (ai !== bi) return ai - bi;
      }
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return unique;
}

function normalizeClubKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalEplClub(
  name: string,
): (typeof LIVE_DRAFT_EPL_CLUBS)[number] | null {
  return EPL_CLUB_ALIASES[normalizeClubKey(name)] ?? null;
}

export function wishlistClubMatches(rowClub: string, filterClub: string): boolean {
  const row = (rowClub || "").trim();
  const filter = (filterClub || "").trim();
  if (!filter) return true;
  const canonicalRow = canonicalEplClub(row);
  const canonicalFilter = canonicalEplClub(filter);
  if (canonicalRow && canonicalFilter) return canonicalRow === canonicalFilter;
  return row === filter;
}

function eplWishlistClubs(rows: PlayerRow[]): string[] {
  const spellings = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = (row.club_name || "").trim();
    const canonical = canonicalEplClub(name);
    if (!canonical) continue;
    const names = spellings.get(canonical) ?? new Set<string>();
    names.add(name);
    spellings.set(canonical, names);
  }
  return uniqueSorted(
    LIVE_DRAFT_EPL_CLUBS.map((canonical) => {
      const names = spellings.get(canonical);
      if (!names?.size || names.has(canonical)) return canonical;
      return [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      )[0]!;
    }),
  );
}

function ensureAwardsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function listLiveDraftWishlistFilters(
  query: { club?: unknown; position?: unknown } = {},
  database: Database.Database = getDb(),
): LiveDraftWishlistFilterView {
  ensureAwardsTable(database);
  const club = parseFilter(query.club);
  const position = parseFilter(query.position).toUpperCase();
  const rows = database
    .prepare(
      `SELECT id, name, full_name, first_name, positions_json, club_name, club_logo,
              avatar_path, average_price
       FROM mantra_players
       WHERE tournament_id = ?
         AND id NOT IN (SELECT player_id FROM live_auction_awards)`,
    )
    .all(LIVE_AUCTION_RULES.tournamentId) as PlayerRow[];

  const clubs = eplWishlistClubs(rows);
  const positions = uniqueSorted(
    rows.flatMap((row) => parsePositions(row.positions_json)),
    POSITION_ORDER,
  );

  if (!club && !position) {
    return {
      clubs,
      positions,
      players: [],
      sort: LIVE_DRAFT_WISHLIST_FILTER_SORT,
    };
  }

  const matched = rows
    .filter((row) => {
      if (club && !wishlistClubMatches(row.club_name || "", club)) return false;
      if (position && !parsePositions(row.positions_json).includes(position)) {
        return false;
      }
      return true;
    })
    .sort(compareSuggestions)
    .slice(0, LIVE_DRAFT_WISHLIST_FILTER_LIMIT)
    .map(publicPlayer);

  return {
    clubs,
    positions,
    players: matched,
    sort: LIVE_DRAFT_WISHLIST_FILTER_SORT,
  };
}
