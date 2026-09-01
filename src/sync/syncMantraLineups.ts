/**
 * Sync Mantra fantasy match lineups for the current tour.
 * Live poller calls this after the first FotMob kickoff (≤4 req/s via mantraRequest).
 * Output: data/mantra-lineups[-{slug}].json
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  fetchMantraMatch,
  type MantraMatch,
  type MantraMatchSlot,
  type MantraMatchSquadPlayer,
  type MantraTourMatch,
  mantraCredentialsConfigured,
} from "../clients/mantraAuth.js";
import { fotmobRoundHasKickedOff, getMantraToursCached, syncMantraTours } from "./syncMantraTours.js";
import { getDb } from "../db/index.js";
import {
  allLiveLeagues,
  mantraFileSuffix,
  resolveLiveLeague,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";

export type MantraLineupsFile = {
  syncedAt: string;
  round: number | null;
  slug?: string;
  matches: Record<string, MantraMatch>;
};

function dataDir(): string {
  const dbPath = process.env.DB_PATH ?? "data/app.db";
  return path.dirname(path.resolve(dbPath));
}

function resolveSlug(league?: string | LiveLeagueDef | null): string {
  if (league && typeof league === "object") return league.slug;
  return resolveLiveLeague(league).slug;
}

function lineupsPath(slug: string): string {
  return path.join(dataDir(), `mantra-lineups${mantraFileSuffix(slug)}.json`);
}

function lineupsArchivePath(slug: string, round: string | number): string {
  return path.join(dataDir(), `mantra-lineups${mantraFileSuffix(slug)}-r${round}.json`);
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function hasBothXi(m: MantraMatch | undefined): boolean {
  return Boolean(m?.home?.lineup?.length && m?.away?.lineup?.length);
}

function sideXiSignature(side: MantraMatch["home"] | undefined): string {
  return (side?.lineup ?? [])
    .map((slot) => `${slot.playerId ?? ""}:${slot.playerName}`)
    .join(",");
}

/** Stable XI identity — full replace only when this changes (lock / swap). */
export function lineupXiSignature(match: MantraMatch | undefined): string {
  if (!match) return "";
  return `${sideXiSignature(match.home)}||${sideXiSignature(match.away)}`;
}

function patchSquadScores(
  prev: MantraMatchSquadPlayer[],
  next: MantraMatchSquadPlayer[],
): MantraMatchSquadPlayer[] {
  if (!prev.length) return next;
  const byKey = new Map(
    next.map((p) => [`${p.playerId ?? ""}:${p.name}`, p] as const),
  );
  return prev.map((p) => {
    const n = byKey.get(`${p.playerId ?? ""}:${p.name}`);
    return n ? { ...p, scoreLabel: n.scoreLabel } : p;
  });
}

function patchSideLiveStats(
  prev: MantraMatch["home"],
  next: MantraMatch["home"],
): MantraMatch["home"] {
  return {
    ...prev,
    module: next.module ?? prev.module,
    defenseBonus: next.defenseBonus ?? prev.defenseBonus,
    fantasyScore: next.fantasyScore,
    goals: next.goals,
    scoredCount: next.scoredCount,
    squad: patchSquadScores(prev.squad, next.squad),
    substitutes: patchSquadScores(prev.substitutes, next.substitutes),
    notInSquad: next.notInSquad.length ? next.notInSquad : prev.notInSquad,
  };
}

/**
 * Keep locked XI; only patch live scores/ratings when the XI set is unchanged.
 * Full replace when the lineup actually changed (managers just locked / swapped).
 */
export function mergeMantraMatchCache(
  prev: MantraMatch | undefined,
  next: MantraMatch,
): MantraMatch {
  if (!prev) return next;
  if (lineupXiSignature(prev) !== lineupXiSignature(next)) return next;
  return {
    ...prev,
    home: patchSideLiveStats(prev.home, next.home),
    away: patchSideLiveStats(prev.away, next.away),
  };
}

function scoresEqual(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  return (a ?? null) === (b ?? null);
}

/** Tour cards already carry totals — patch cached match without refetching /matches/:id. */
export function patchMatchScoresFromTour(
  cached: MantraMatch,
  tour: MantraTourMatch,
): MantraMatch {
  if (
    scoresEqual(cached.home.fantasyScore, tour.home.score) &&
    scoresEqual(cached.away.fantasyScore, tour.away.score) &&
    scoresEqual(cached.home.goals, tour.home.goals) &&
    scoresEqual(cached.away.goals, tour.away.goals) &&
    scoresEqual(cached.home.scoredCount, tour.home.scoredCount) &&
    scoresEqual(cached.away.scoredCount, tour.away.scoredCount)
  ) {
    return cached;
  }
  return {
    ...cached,
    home: {
      ...cached.home,
      fantasyScore: tour.home.score ?? cached.home.fantasyScore,
      goals: tour.home.goals ?? cached.home.goals,
      scoredCount: tour.home.scoredCount ?? cached.home.scoredCount,
    },
    away: {
      ...cached.away,
      fantasyScore: tour.away.score ?? cached.away.fantasyScore,
      goals: tour.away.goals ?? cached.away.goals,
      scoredCount: tour.away.scoredCount ?? cached.away.scoredCount,
    },
  };
}

function readLineupsFile(file: string): MantraLineupsFile | null {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as MantraLineupsFile;
    if (!parsed?.matches) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a per-round copy so Ideal/Real + scores stay viewable after the next tour. */
export function archiveMantraLineups(slug: string, file: MantraLineupsFile): void {
  if (file.round == null) return;
  const dest = lineupsArchivePath(slug, file.round);
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify({ ...file, slug }, null, 2));
  } catch (err) {
    console.warn(
      "Could not archive Mantra lineups:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function loadMantraLineups(
  round?: string | number | null,
  league?: string | null,
): MantraLineupsFile | null {
  const slug = resolveSlug(league);
  const current = readLineupsFile(lineupsPath(slug));
  if (round == null || round === "") return current;
  const want = String(round);
  if (current && current.round != null && String(current.round) === want) return current;
  return readLineupsFile(lineupsArchivePath(slug, want)) ?? current;
}

function matchFromFile(
  file: MantraLineupsFile | null,
  matchId: string,
  slug: string,
): { match: MantraMatch; file: MantraLineupsFile; slug: string } | null {
  if (!file) return null;
  const match = file.matches[matchId];
  if (!match) return null;
  return { match, file, slug };
}

/**
 * Score click must hit cached Real XI even if league/round query is wrong
 * (defaults to Ekstraklasa). Search preferred file, then every Live league.
 */
export function findMantraMatchInLineups(
  matchId: number,
  opts?: { round?: string | number | null; league?: string | null },
): { match: MantraMatch; file: MantraLineupsFile; slug: string } | null {
  const id = String(matchId);
  const preferred = opts?.league ? resolveLiveLeague(opts.league).slug : null;
  const slugs = [
    ...(preferred ? [preferred] : []),
    ...allLiveLeagues()
      .map((l) => l.slug)
      .filter((s) => s !== preferred),
  ];
  for (const slug of slugs) {
    const hit =
      matchFromFile(loadMantraLineups(opts?.round, slug), id, slug) ??
      (opts?.round != null && opts.round !== ""
        ? matchFromFile(loadMantraLineups(null, slug), id, slug)
        : null);
    if (hit) return hit;
  }
  return null;
}

/**
 * Mantra pitch HTML truncates long shirt names ("Pedro Junqu...").
 * Strip trailing ellipsis so we can match squad / DB ("Pedro Junqueira Joao").
 */
export function pitchNameMatchKey(playerName: string): string {
  return playerName
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\.\.\.|…)$/u, "")
    .trim();
}

/** Match a pitch slot to an unused squad row (exported for tests). */
export function takeSquadPlayerForSlot(
  slot: MantraMatchSlot,
  squad: MantraMatchSquadPlayer[],
  usedIds: Set<number>,
): MantraMatchSquadPlayer | null {
  const key = pitchNameMatchKey(slot.playerName);
  if (!key) return null;
  const unused = squad.filter(
    (p: MantraMatchSquadPlayer) => p.playerId == null || !usedIds.has(p.playerId),
  );

  // 1) Exact full-name match among unused
  let cands = unused.filter(
    (p) => p.name.toLowerCase().replace(/\s+/g, " ").trim() === key,
  );
  // 2) Surname / contains / truncated-prefix match
  if (!cands.length) {
    cands = unused.filter((p) => {
      const n = p.name.toLowerCase().replace(/\s+/g, " ").trim();
      const parts = n.split(/\s+/);
      return (
        parts[parts.length - 1] === key ||
        n.includes(key) ||
        n.startsWith(key)
      );
    });
  }
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0]!;

  // 3) Disambiguate same surname by slot / native position overlap
  const slotPos = new Set(slot.positions.map((p) => p.toUpperCase()));
  const scored = cands.map((p) => {
    const pos = (p.positions ?? []).map((x) => x.toUpperCase());
    const overlap = pos.filter((x) => slotPos.has(x)).length;
    return { p, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored[0]!.p;
}

function enrichFromDb(match: MantraMatch, tournamentId: number): MantraMatch {
  const db = getDb();
  const lookup = db.prepare(
    `SELECT id, positions_json, club_name FROM mantra_players WHERE id = ?`,
  );
  const byName = db.prepare(
    `SELECT id, positions_json, club_name, name FROM mantra_players
     WHERE tournament_id = ? AND lower(name) LIKE ? LIMIT 8`,
  );

  const enrichSide = (side: MantraMatch["home"]) => {
    const usedIds = new Set<number>();

    const lineup = side.lineup.map((slot) => {
      const sp = takeSquadPlayerForSlot(slot, side.squad, usedIds);
      let playerId = sp?.playerId ?? null;
      let native = sp?.positions?.length ? sp.positions : slot.positions;
      let clubName: string | null = null;

      if (playerId != null) {
        usedIds.add(playerId);
        const row = lookup.get(playerId) as
          | { id: number; positions_json: string | null; club_name: string | null }
          | undefined;
        if (row) {
          clubName = row.club_name;
          if (row.positions_json) {
            try {
              const pos = JSON.parse(row.positions_json) as string[];
              if (pos.length) native = pos;
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        const key = pitchNameMatchKey(slot.playerName);
        const rows = byName.all(tournamentId, `%${key}%`) as Array<{
          id: number;
          positions_json: string | null;
          club_name: string | null;
          name: string;
        }>;
        const free = rows.filter((r) => !usedIds.has(r.id));
        const slotPos = new Set(slot.positions.map((p) => p.toUpperCase()));
        const ranked = free
          .map((r) => {
            let pos: string[] = [];
            try {
              pos = r.positions_json ? (JSON.parse(r.positions_json) as string[]) : [];
            } catch {
              /* ignore */
            }
            const overlap = pos.filter((x) => slotPos.has(x.toUpperCase())).length;
            return { r, overlap };
          })
          .sort((a, b) => b.overlap - a.overlap);
        const hit =
          ranked[0]?.r ||
          free.find((r) => r.name.toLowerCase().endsWith(key)) ||
          free[0];
        if (hit) {
          playerId = hit.id;
          usedIds.add(hit.id);
          clubName = hit.club_name;
          if (hit.positions_json) {
            try {
              native = JSON.parse(hit.positions_json) as string[];
            } catch {
              /* ignore */
            }
          }
        }
      }

      return {
        ...slot,
        playerId,
        nativePositions: native,
        clubName,
      };
    });

    const substitutes = side.substitutes.map((p) => {
      let native = p.positions;
      let clubName: string | null = null;
      if (p.playerId != null) {
        const row = lookup.get(p.playerId) as
          | { positions_json: string | null; club_name: string | null }
          | undefined;
        if (row?.positions_json) {
          try {
            native = JSON.parse(row.positions_json) as string[];
          } catch {
            /* ignore */
          }
        }
        clubName = row?.club_name ?? null;
      }
      return { ...p, nativePositions: native, clubName };
    });

    return { ...side, lineup, substitutes };
  };

  return {
    ...match,
    home: enrichSide(match.home),
    away: enrichSide(match.away),
  };
}

/** Re-apply DB enrichment to an already-synced lineups file (no Mantra fetch). */
export function reenrichMantraLineupsFile(league?: string | null): MantraLineupsFile | null {
  const def = resolveLiveLeague(league);
  const file = loadMantraLineups(null, def.slug);
  if (!file) return null;
  const tournamentId = def.mantraTournamentId!;
  const matches: Record<string, MantraMatch> = {};
  for (const [id, match] of Object.entries(file.matches)) {
    matches[id] = enrichFromDb(match, tournamentId);
  }
  const out: MantraLineupsFile = {
    ...file,
    matches,
    // Bump so liveRoundDataVersion invalidates mantra-scores / Ideal caches.
    syncedAt: new Date().toISOString(),
    slug: def.slug,
  };
  mkdirSync(path.dirname(lineupsPath(def.slug)), { recursive: true });
  writeFileSync(lineupsPath(def.slug), JSON.stringify(out, null, 2));
  return out;
}

export async function syncMantraLineups(opts?: {
  force?: boolean;
  league?: string | null;
  /** Poller: skip Mantra match fetches until FotMob first kickoff of this tour. */
  requireKickoff?: boolean;
}): Promise<{ ok: boolean; matches: number; path: string; slug: string; error?: string }> {
  const def = resolveLiveLeague(opts?.league);
  const slug = def.slug;
  const tournamentId = def.mantraTournamentId!;
  const filePath = lineupsPath(slug);

  if (!mantraCredentialsConfigured()) {
    return { ok: false, matches: 0, path: filePath, slug, error: "no credentials" };
  }

  // Ensure tours list is fresh for match ids
  let tours = getMantraToursCached(slug).tours;
  if (!tours.length) {
    await syncMantraTours(slug);
    tours = getMantraToursCached(slug).tours;
  }

  const round = tours.find((t) => t.round != null)?.round ?? null;
  if (opts?.requireKickoff && !fotmobRoundHasKickedOff(slug, round)) {
    console.log(
      `Mantra lineups [${slug}] skip: first FotMob match of round ${round ?? "?"} has not kicked off`,
    );
    return { ok: true, matches: 0, path: filePath, slug };
  }

  const prev = readLineupsFile(filePath);
  const roundChanged =
    prev != null &&
    prev.round != null &&
    round != null &&
    String(prev.round) !== String(round);

  if (roundChanged && prev) {
    archiveMantraLineups(slug, prev);
    console.log(
      `Archived Mantra lineups [${slug}] round ${prev.round} before syncing round ${round}`,
    );
  }

  const existing = opts?.force || roundChanged ? null : prev;
  const matchIds = [
    ...new Set(
      tours
        .flatMap((t) => t.matches.map((m) => m.matchId))
        .filter((id): id is number => id != null && Number.isFinite(id)),
    ),
  ];

  const matches: Record<string, MantraMatch> = { ...(existing?.matches ?? {}) };
  let fetched = 0;
  for (const id of matchIds) {
    await yieldEventLoop();
    // Locked XI stays on disk; empty/never-fetched must be pulled after kickoff.
    if (!opts?.force && hasBothXi(matches[String(id)])) continue;
    try {
      const raw = await fetchMantraMatch(id);
      const enriched = enrichFromDb(raw, tournamentId);
      matches[String(id)] = mergeMantraMatchCache(matches[String(id)], enriched);
      fetched++;
      console.log(`  [${slug}] lineup ${id}: ${raw.home.teamName} vs ${raw.away.teamName}`);
    } catch (err) {
      console.warn(
        `  [${slug}] lineup ${id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  let patched = 0;
  for (const t of tours) {
    for (const tourMatch of t.matches) {
      if (tourMatch.matchId == null) continue;
      const key = String(tourMatch.matchId);
      const cached = matches[key];
      if (!cached) continue;
      const next = patchMatchScoresFromTour(cached, tourMatch);
      if (next !== cached) {
        matches[key] = next;
        patched++;
      }
    }
  }

  if (fetched === 0 && patched === 0 && existing && !roundChanged) {
    console.log(
      `Mantra lineups [${slug}]: ${Object.keys(matches).length} matches cached (no XI/score change)`,
    );
    return {
      ok: true,
      matches: Object.keys(matches).length,
      path: filePath,
      slug,
    };
  }

  const payload: MantraLineupsFile = {
    syncedAt: new Date().toISOString(),
    round,
    slug,
    matches,
  };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  archiveMantraLineups(slug, payload);
  console.log(
    `Mantra lineups [${slug}]: ${Object.keys(payload.matches).length} matches (${fetched} fetched, ${patched} score-patched) → ${filePath}`,
  );
  return {
    ok: true,
    matches: Object.keys(payload.matches).length,
    path: filePath,
    slug,
  };
}

export async function syncAllMantraLineups(opts?: {
  force?: boolean;
}): Promise<Array<{ ok: boolean; matches: number; path: string; slug: string; error?: string }>> {
  const { allLiveLeagues } = await import("../lib/liveLeagues.js");
  const out = [];
  for (const league of allLiveLeagues()) {
    out.push(await syncMantraLineups({ ...opts, league: league.slug }));
  }
  return out;
}
