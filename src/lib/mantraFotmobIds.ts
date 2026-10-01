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
  "buyuksehir belediye erzurum spor kulubu": "erzurumspor",
  "caykur rize": "rizespor",
  "caykur rize spor kulubu": "rizespor",
  "caykur rizespor": "rizespor",
  "eyup spor": "eyupspor",
  "eyup spor kulubu": "eyupspor",
  "gaziantep fk": "gaziantep",
  "gaziantep": "gaziantep",
  "fatih karagumruk": "karagumruk",
  "fatih karagumruk sk": "karagumruk",
  "galatasaray sk": "galatasaray",
  "fenerbahce sk": "fenerbahce",
  "besiktas jk": "besiktas",
  "besiktas jimnastik kulubu": "besiktas",
  "goztepe spor kulubu": "goztepe",
  "kasimpasa sk": "kasimpasa",
  "trabzonspor as": "trabzonspor",
  "yeni corumspor": "corum",
  "yeni corumspor spor kulubu": "corum",
  "borussia monchengladbach": "borussia mbach",
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
  arsenal: {
    magalhaes: "gabriel",
    "gabriel magalhaes": "gabriel",
  },
  "bayer leverkusen": {
    "ezequiel fernandez": "equi fernandez",
  },
  stuttgart: {
    "julian chabot": "jeff chabot",
    chabot: "jeff chabot",
  },
  "union berlin": {
    "wooyeong jeong": "woo yeong jeong",
    jeong: "woo yeong jeong",
  },
  "schalke 04": {
    "soufiane el faouzi": "soufian el faouzi",
    "el faouzi": "soufian el faouzi",
  },
  brentford: {
    "yegor yarmolyuk": "yehor yarmoliuk",
    yarmolyuk: "yehor yarmoliuk",
  },
  "stoke city": {
    "maksym taloverov": "maksym talovierov",
    taloverov: "maksym talovierov",
  },
  brighton: {
    "matt oriley": "matthew oriley",
    oriley: "matthew oriley",
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

const NAME_LINK_MIN = 80;

/** Unique top score ≥80. Ties (two Gabriels at 87) stay unmatched. */
function uniqueBestCandidate(
  player: MantraPlayer,
  candidates: FotmobPlayer[],
): { candidate: FotmobPlayer; score: number } | null {
  const scored = candidates
    .map((candidate) => ({ candidate, score: nameScore(player, candidate) }))
    .filter((row) => row.score >= NAME_LINK_MIN)
    .sort((a, b) => b.score - a.score || a.candidate.id - b.candidate.id);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!;
}

type FotmobProposal = { mantraId: number; fotmobId: number; score: number };

function proposeFotmobLinks(
  mantra: MantraPlayer[],
  fotmobById: Map<number, FotmobPlayer>,
  alreadyLinked: Set<number>,
): FotmobProposal[] {
  const proposals: FotmobProposal[] = [];
  for (const player of mantra) {
    if (player.fotmob_player_id != null || !player.club_name) continue;
    const candidates = clubCandidates(player, fotmobById).filter(
      (candidate) => !alreadyLinked.has(candidate.id),
    );
    const best = uniqueBestCandidate(player, candidates);
    if (!best) continue;
    proposals.push({ mantraId: player.id, fotmobId: best.candidate.id, score: best.score });
  }
  return proposals;
}

/** One FotMob id, one Mantra player: unique highest nameScore wins a contest. */
function winningProposals(proposals: FotmobProposal[]): FotmobProposal[] {
  const owners = new Map<number, FotmobProposal[]>();
  for (const proposal of proposals) {
    const list = owners.get(proposal.fotmobId) ?? [];
    list.push(proposal);
    owners.set(proposal.fotmobId, list);
  }
  const won: FotmobProposal[] = [];
  for (const list of owners.values()) {
    list.sort((a, b) => b.score - a.score || a.mantraId - b.mantraId);
    if (list.length > 1 && list[0]!.score === list[1]!.score) continue;
    won.push(list[0]!);
  }
  return won;
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
  const won = winningProposals(proposeFotmobLinks(mantra, fotmobById, alreadyLinked));

  const update = db.prepare(
    `UPDATE mantra_players
     SET fotmob_player_id = ?
     WHERE id = ? AND fotmob_player_id IS NULL`,
  );
  let linked = 0;
  const tx = db.transaction(() => {
    for (const { mantraId, fotmobId } of won) {
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
  const proposals = new Map<number, { fotmobId: number; name: string; score: number }>();
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
    const named = atClub.filter((candidate) => nameScore(player, candidate) >= NAME_LINK_MIN);
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
    const best = uniqueBestCandidate(player, free);
    if (!best) {
      out.push({
        id: player.id,
        name: label,
        club: player.club_name,
        reason: "ambiguous",
        detail: free.map((c) => [...c.names][0]).join("|"),
      });
      continue;
    }
    proposals.set(player.id, { fotmobId: best.candidate.id, name: label, score: best.score });
  }

  const wonIds = new Set(
    winningProposals(
      [...proposals.entries()].map(([mantraId, rec]) => ({
        mantraId,
        fotmobId: rec.fotmobId,
        score: rec.score,
      })),
    ).map((row) => row.mantraId),
  );
  for (const [mantraId, { name }] of proposals) {
    if (wonIds.has(mantraId)) continue;
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
