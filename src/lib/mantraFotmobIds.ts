import { getDb } from "../db/index.js";
import { allLiveLeagues } from "./liveLeagues.js";
import { nameMatchScore, normName } from "./names.js";

type MantraPlayer = {
  id: number;
  name: string;
  first_name: string | null;
  full_name: string | null;
  club_name: string | null;
  fotmob_player_id: number | null;
};

type FotmobPlayerRow = {
  player_id: number;
  name: string;
  team_name: string;
};

type FotmobPlayer = {
  id: number;
  names: Set<string>;
  clubs: Set<string>;
};

/** Map FotMob / Mantra club strings onto a shared key after normName. */
export const FOTMOB_CLUB_ALIASES: Record<string, string> = {
  "ac milan": "milan",
  "istanbul basaksehir": "basaksehir",
  "istanbul basaksehir fk": "basaksehir",
  "buyuksehir belediye": "basaksehir",
  "caykur rizespor": "rizespor",
  "gaziantep fk": "gaziantep",
  "gaziantep": "gaziantep",
  "fatih karagumruk": "karagumruk",
  "fatih karagumruk sk": "karagumruk",
  "galatasaray sk": "galatasaray",
  "fenerbahce sk": "fenerbahce",
  "besiktas jk": "besiktas",
  "kasimpasa sk": "kasimpasa",
  "trabzonspor as": "trabzonspor",
};

/**
 * Club-scoped Mantra shirt/full names → FotMob display name for scoring.
 * Used when Mantra surname-shirt form does not share tokens with FotMob.
 */
export const FOTMOB_PLAYER_ALIASES: Record<string, Record<string, string>> = {
  chelsea: {
    "pedro junqueira": "joao pedro",
    "joao pedro junqueira": "joao pedro",
  },
};

const CLUB_NOISE = new Set([
  "fc",
  "cf",
  "ks",
  "rks",
  "mks",
  "gks",
  "lks",
  "fk",
  "sk",
  "jk",
  "as",
]);

export function canonicalClubName(name: string): string {
  const normalized = normName(name);
  return FOTMOB_CLUB_ALIASES[normalized] ?? normalized;
}

function clubTokens(name: string): string[] {
  return canonicalClubName(name)
    .split(" ")
    .filter((token) => token.length > 1 && !CLUB_NOISE.has(token));
}

/** Strict club match: alias/exact, then every token of the shorter name. */
export function clubsMatch(a: string, b: string): boolean {
  const xName = canonicalClubName(a);
  const yName = canonicalClubName(b);
  if (!xName || !yName) return false;
  if (xName === yName) return true;
  const x = clubTokens(xName);
  const y = clubTokens(yName);
  if (!x.length || !y.length) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.every((token) => longer.includes(token));
}

function mantraNames(player: MantraPlayer): string[] {
  const names = [
    player.full_name,
    player.first_name ? `${player.first_name} ${player.name}` : player.name,
  ];
  const out = [
    ...new Set(
      names.map((name) => name?.trim()).filter((name): name is string => Boolean(name)),
    ),
  ];
  const clubKey = player.club_name ? canonicalClubName(player.club_name) : "";
  const aliases = clubKey ? FOTMOB_PLAYER_ALIASES[clubKey] : undefined;
  if (!aliases) return out;
  // Look up by shirt name too (even when first/full name already listed).
  for (const name of [...out, player.name]) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const alias = aliases[normName(trimmed)];
    if (alias) out.push(alias);
  }
  return [...new Set(out)];
}

function nameScore(mantra: MantraPlayer, fotmob: FotmobPlayer): number {
  let best = 0;
  for (const left of mantraNames(mantra)) {
    for (const right of fotmob.names) {
      best = Math.max(best, nameMatchScore(left, right));
    }
  }
  return best;
}

export type UnmatchedFotmobReason =
  | "missing-club"
  | "no-club-match"
  | "name-below-threshold"
  | "ambiguous"
  | "fotmob-id-taken"
  | "fotmob-id-contested";

export type UnmatchedFotmobPlayer = {
  id: number;
  name: string;
  club: string | null;
  reason: UnmatchedFotmobReason;
  detail?: string;
};

function loadMantraPlayers(tournamentId: number): MantraPlayer[] {
  return getDb()
    .prepare(
      `SELECT id, name, first_name, full_name, club_name, fotmob_player_id
       FROM mantra_players
       WHERE tournament_id = ? OR (? = 18 AND tournament_id IS NULL)`,
    )
    .all(tournamentId, tournamentId) as MantraPlayer[];
}

function loadFotmobPlayers(fotmobLeagueId: number): Map<number, FotmobPlayer> {
  const db = getDb();
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fotmob_match_players'`,
    )
    .get() as { ok: number } | undefined;
  if (!exists) return new Map();
  const rows = db
    .prepare(
      `SELECT DISTINCT p.player_id, p.name, p.team_name
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ?`,
    )
    .all(fotmobLeagueId) as FotmobPlayerRow[];
  const fotmobById = new Map<number, FotmobPlayer>();
  for (const row of rows) {
    let player = fotmobById.get(row.player_id);
    if (!player) {
      player = { id: row.player_id, names: new Set(), clubs: new Set() };
      fotmobById.set(row.player_id, player);
    }
    if (row.name) player.names.add(row.name);
    if (row.team_name) player.clubs.add(row.team_name);
  }
  return fotmobById;
}

function alreadyLinkedIds(): Set<number> {
  return new Set(
    (
      getDb()
        .prepare(
          `SELECT fotmob_player_id
           FROM mantra_players
           WHERE fotmob_player_id IS NOT NULL`,
        )
        .all() as Array<{ fotmob_player_id: number }>
    ).map((row) => row.fotmob_player_id),
  );
}

function clubCandidates(player: MantraPlayer, fotmobById: Map<number, FotmobPlayer>): FotmobPlayer[] {
  if (!player.club_name) return [];
  return [...fotmobById.values()].filter((candidate) =>
    [...candidate.clubs].some((club) => clubsMatch(player.club_name!, club)),
  );
}

/**
 * Persist only unambiguous Mantra ↔ FotMob player links.
 * Runtime scoring must use these IDs and never fuzzy-match names.
 */
export function syncMantraFotmobIds(
  tournamentId: number,
  fotmobLeagueId: number,
): { linked: number; total: number } {
  const db = getDb();
  const mantra = loadMantraPlayers(tournamentId);
  const fotmobById = loadFotmobPlayers(fotmobLeagueId);
  const alreadyLinked = alreadyLinkedIds();
  const proposals = new Map<number, number>();
  for (const player of mantra) {
    if (player.fotmob_player_id != null || !player.club_name) continue;
    const candidates = clubCandidates(player, fotmobById).filter(
      (candidate) => !alreadyLinked.has(candidate.id) && nameScore(player, candidate) >= 80,
    );
    if (candidates.length === 1) proposals.set(player.id, candidates[0]!.id);
  }

  const owners = new Map<number, number[]>();
  for (const [mantraId, fotmobId] of proposals) {
    const list = owners.get(fotmobId) ?? [];
    list.push(mantraId);
    owners.set(fotmobId, list);
  }

  const update = db.prepare(
    `UPDATE mantra_players
     SET fotmob_player_id = ?
     WHERE id = ? AND fotmob_player_id IS NULL`,
  );
  let linked = 0;
  const tx = db.transaction(() => {
    for (const [mantraId, fotmobId] of proposals) {
      if (owners.get(fotmobId)?.length !== 1) continue;
      linked += update.run(fotmobId, mantraId).changes;
    }
  });
  tx();

  return {
    linked,
    total: mantra.filter((player) => player.fotmob_player_id != null).length + linked,
  };
}

export function unmatchedMantraFotmob(
  tournamentId: number,
  fotmobLeagueId: number,
): UnmatchedFotmobPlayer[] {
  const mantra = loadMantraPlayers(tournamentId);
  const fotmobById = loadFotmobPlayers(fotmobLeagueId);
  const alreadyLinked = alreadyLinkedIds();
  const proposals = new Map<number, { fotmobId: number; name: string }>();
  const out: UnmatchedFotmobPlayer[] = [];

  for (const player of mantra) {
    if (player.fotmob_player_id != null) continue;
    const label = player.full_name || player.name;
    if (!player.club_name) {
      out.push({ id: player.id, name: label, club: null, reason: "missing-club" });
      continue;
    }
    const atClub = clubCandidates(player, fotmobById);
    if (!atClub.length) {
      out.push({
        id: player.id,
        name: label,
        club: player.club_name,
        reason: "no-club-match",
      });
      continue;
    }
    const named = atClub.filter((candidate) => nameScore(player, candidate) >= 80);
    if (!named.length) {
      out.push({
        id: player.id,
        name: label,
        club: player.club_name,
        reason: "name-below-threshold",
        detail: atClub
          .map((c) => `${[...c.names][0]}:${nameScore(player, c)}`)
          .slice(0, 3)
          .join(","),
      });
      continue;
    }
    const free = named.filter((candidate) => !alreadyLinked.has(candidate.id));
    if (!free.length) {
      out.push({
        id: player.id,
        name: label,
        club: player.club_name,
        reason: "fotmob-id-taken",
      });
      continue;
    }
    if (free.length !== 1) {
      out.push({
        id: player.id,
        name: label,
        club: player.club_name,
        reason: "ambiguous",
        detail: free.map((c) => [...c.names][0]).join("|"),
      });
      continue;
    }
    proposals.set(player.id, { fotmobId: free[0]!.id, name: label });
  }

  const owners = new Map<number, number[]>();
  for (const [mantraId, { fotmobId }] of proposals) {
    const list = owners.get(fotmobId) ?? [];
    list.push(mantraId);
    owners.set(fotmobId, list);
  }
  for (const [mantraId, { fotmobId, name }] of proposals) {
    if (owners.get(fotmobId)?.length === 1) continue;
    const player = mantra.find((p) => p.id === mantraId);
    out.push({
      id: mantraId,
      name,
      club: player?.club_name ?? null,
      reason: "fotmob-id-contested",
    });
  }
  return out;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** DB-only. Call from Mantra/boot background, never from GET /live. */
export async function syncAllLiveMantraFotmobIds(): Promise<
  Array<{
    slug: string;
    linked: number;
    total: number;
  }>
> {
  const out: Array<{ slug: string; linked: number; total: number }> = [];
  for (const league of allLiveLeagues()) {
    await yieldEventLoop();
    const result = syncMantraFotmobIds(league.mantraTournamentId!, league.fotmobLeagueId);
    // Skip unmatchedMantraFotmob here — a second O(n×m) pass stalls the event
    // loop long enough for Caddy to 502 GET /live after deploy/boot.
    console.log(`Mantra↔FotMob IDs [${league.slug}]: +${result.linked} total=${result.total}`);
    out.push({ slug: league.slug, ...result });
  }
  return out;
}
