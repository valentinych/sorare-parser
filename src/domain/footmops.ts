import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { leagueBySlug } from "../lib/afLeagues.js";
import {
  invalidateComputed,
  PREMIUM_ODDS_JOIN_CACHE_KEY,
} from "../lib/computedCache.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import { nameMatchScore, normName } from "../lib/names.js";
import {
  expected11AliasedPlayerName,
  expected11TeamKey,
  resolveExpected11Player,
} from "./expected11Import.js";

export const FOOTMOPS_SOURCE = "sorareinside";
export const CHAMPIONSHIP_TOUR = 2;

const CHAMPIONSHIP_TOURNAMENT_ID =
  leagueBySlug("championship")?.mantraTournamentId ?? 11;

const SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/footmops/championship-tour-2.json",
);

export const FOOTMOPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS footmops_snapshots (
  league TEXT NOT NULL,
  tour INTEGER NOT NULL,
  source TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league, tour)
);

CREATE TABLE IF NOT EXISTS footmops_predictions (
  league TEXT NOT NULL,
  tour INTEGER NOT NULL,
  club_key TEXT NOT NULL,
  source_club TEXT NOT NULL,
  source_player TEXT NOT NULL,
  lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench')),
  displayed_percentage REAL NOT NULL,
  mantra_player_id INTEGER,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (league, tour, club_key, source_player)
);

CREATE INDEX IF NOT EXISTS idx_footmops_predictions_player
  ON footmops_predictions(mantra_player_id);
`;

export type FootmopsLineupGroup = "starting" | "bench";

export type FootmopsPlayer = {
  name: string;
  percentage: number;
  group: FootmopsLineupGroup;
};

export type FootmopsSnapshot = {
  source: string;
  sourceUrl: string;
  league: string;
  tour: number;
  extractedAt: string;
  title: string;
  matches: Array<{
    home: string;
    away: string;
    teams: Array<{ name: string; players: FootmopsPlayer[] }>;
  }>;
};

export type FootmopsHint = {
  displayedPercentage: number;
  lineupGroup: FootmopsLineupGroup;
  sourceName: string;
};

export type FootmopsImportResult = {
  league: string;
  tour: number;
  clubs: number;
  players: number;
  linked: number;
  unmatched: number;
  ambiguous: number;
  unmatchedPlayers: Array<{ club: string; name: string; percentage: number }>;
};

type MantraClub = { id: number; name: string };

function isGroup(value: string): value is FootmopsLineupGroup {
  return value === "starting" || value === "bench";
}

function mergePlayers(players: FootmopsPlayer[]): FootmopsPlayer[] {
  const byKey = new Map<string, FootmopsPlayer>();
  for (const player of players) {
    const name = player.name.trim();
    const percentage = Number(player.percentage);
    if (!name || !Number.isFinite(percentage)) continue;
    const group = isGroup(player.group) ? player.group : "bench";
    const key = normName(name);
    const current = byKey.get(key);
    if (
      !current ||
      percentage > current.percentage ||
      (percentage === current.percentage &&
        group === "starting" &&
        current.group !== "starting")
    ) {
      byKey.set(key, { name, percentage, group });
    }
  }
  return [...byKey.values()];
}

export function readChampionshipTour2Snapshot(
  filePath: string = SNAPSHOT_PATH,
): FootmopsSnapshot {
  return JSON.parse(readFileSync(filePath, "utf8")) as FootmopsSnapshot;
}

function playerNameVariants(row: {
  name: string;
  firstName: string | null;
  fullName: string | null;
}): string[] {
  return [
    row.fullName,
    row.firstName && row.name ? `${row.firstName} ${row.name}` : null,
    row.firstName && row.name ? `${row.name} ${row.firstName}` : null,
    row.name,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function truncatedScore(source: string, candidate: string): number {
  const raw = source.replace(/[.…]+$/g, "").trim();
  const sourceKey = normName(raw);
  const candidateKey = normName(candidate);
  if (!sourceKey || sourceKey.length < 4 || !candidateKey) return 0;
  if (candidateKey === sourceKey) return 100;
  if (candidateKey.startsWith(sourceKey) || candidateKey.includes(sourceKey)) {
    return 70 + Math.min(sourceKey.length, 15);
  }
  const sourceTokens = sourceKey.split(" ").filter(Boolean);
  const candidateTokens = candidateKey.split(" ").filter(Boolean);
  const lastSource = sourceTokens[sourceTokens.length - 1] ?? "";
  const lastCandidate = candidateTokens[candidateTokens.length - 1] ?? "";
  if (lastSource.length < 3 || !lastCandidate.startsWith(lastSource)) return 0;
  const givenSource = sourceTokens.slice(0, -1);
  const givenCandidate = candidateTokens.slice(0, -1);
  if (givenSource.length === 0) return 45;
  const givenOk = givenSource.every((token, index) => {
    const other = givenCandidate[index];
    if (!other) return false;
    return other === token || (token.length === 1 && other.startsWith(token));
  });
  return givenOk ? 65 : 0;
}

function resolveClub(
  database: Database.Database,
  sourceName: string,
  tournamentId: number,
): { status: "linked" | "unmatched" | "ambiguous"; club: MantraClub | null } {
  const target = expected11TeamKey(sourceName);
  const rows = database
    .prepare(
      `SELECT DISTINCT club_id AS id, club_name AS name
       FROM mantra_players
       WHERE tournament_id = ? AND club_id IS NOT NULL AND club_name IS NOT NULL`,
    )
    .all(tournamentId) as MantraClub[];
  const matches = rows.filter(
    (club) =>
      expected11TeamKey(club.name) === target || clubsMatch(sourceName, club.name),
  );
  const unique = new Map(matches.map((club) => [club.id, club]));
  if (unique.size === 1) return { status: "linked", club: [...unique.values()][0]! };
  return {
    status: unique.size > 1 ? "ambiguous" : "unmatched",
    club: null,
  };
}

function resolveFootmopsPlayer(
  database: Database.Database,
  club: MantraClub,
  sourceName: string,
) {
  const aliased = expected11AliasedPlayerName(club.name, sourceName);
  const exact = resolveExpected11Player(database, club, aliased);
  if (exact.status === "linked") return exact;
  if (normName(aliased) !== normName(sourceName)) {
    const original = resolveExpected11Player(database, club, sourceName);
    if (original.status === "linked") return original;
  }
  const rows = database
    .prepare(
      `SELECT id, name, first_name AS firstName, full_name AS fullName
       FROM mantra_players WHERE club_id = ?`,
    )
    .all(club.id) as Array<{
    id: number;
    name: string;
    firstName: string | null;
    fullName: string | null;
  }>;
  const scored = rows
    .map((row) => {
      const variants = playerNameVariants(row);
      const score = Math.max(
        0,
        ...variants.flatMap((name) => [
          nameMatchScore(aliased, name),
          nameMatchScore(sourceName, name),
          truncatedScore(sourceName, name),
        ]),
      );
      return { id: row.id, score };
    })
    .filter((row) => row.score >= 40)
    .sort((a, b) => b.score - a.score || a.id - b.id);
  if (scored.length === 0) return { status: "unmatched" as const, player: null };
  const best = scored[0]!.score;
  const winners = scored.filter((row) => row.score === best);
  if (winners.length !== 1) return { status: "ambiguous" as const, player: null };
  const winner = rows.find((row) => row.id === winners[0]!.id);
  return winner
    ? { status: "linked" as const, player: winner }
    : { status: "unmatched" as const, player: null };
}

export function footmopsSnapshotVersion(
  database: Database.Database = getDb(),
): string {
  database.exec(FOOTMOPS_SCHEMA);
  const row = database
    .prepare(`SELECT MAX(extracted_at) AS extractedAt FROM footmops_snapshots`)
    .get() as { extractedAt: string | null };
  return row.extractedAt ?? "";
}

export function footmopsByPlayer(
  database: Database.Database = getDb(),
): Map<number, FootmopsHint> {
  database.exec(FOOTMOPS_SCHEMA);
  const rows = database
    .prepare(
      `SELECT mantra_player_id AS mantraPlayerId, source_player AS sourceName,
              lineup_group AS lineupGroup, displayed_percentage AS displayedPercentage
       FROM footmops_predictions
       WHERE link_status = 'linked' AND mantra_player_id IS NOT NULL`,
    )
    .all() as Array<{
    mantraPlayerId: number;
    sourceName: string;
    lineupGroup: FootmopsLineupGroup;
    displayedPercentage: number;
  }>;
  const rank = { starting: 0, bench: 1 };
  const map = new Map<number, FootmopsHint>();
  for (const row of rows) {
    const current = map.get(row.mantraPlayerId);
    if (
      current &&
      (rank[current.lineupGroup] < rank[row.lineupGroup] ||
        (current.lineupGroup === row.lineupGroup &&
          current.displayedPercentage >= row.displayedPercentage))
    ) {
      continue;
    }
    map.set(row.mantraPlayerId, {
      displayedPercentage: row.displayedPercentage,
      lineupGroup: row.lineupGroup,
      sourceName: row.sourceName,
    });
  }
  return map;
}

export function importFootmopsSnapshot(
  snapshot: FootmopsSnapshot,
  database: Database.Database = getDb(),
  options: { tournamentId?: number; bustCache?: boolean } = {},
): FootmopsImportResult {
  database.exec(FOOTMOPS_SCHEMA);
  const tournamentId =
    options.tournamentId ??
    leagueBySlug(snapshot.league)?.mantraTournamentId ??
    CHAMPIONSHIP_TOURNAMENT_ID;
  const clubs = snapshot.matches.flatMap((match) =>
    match.teams.map((team) => ({
      name: team.name,
      players: mergePlayers(team.players),
    })),
  );
  const result: FootmopsImportResult = {
    league: snapshot.league,
    tour: snapshot.tour,
    clubs: clubs.length,
    players: 0,
    linked: 0,
    unmatched: 0,
    ambiguous: 0,
    unmatchedPlayers: [],
  };
  const upsertSnap = database.prepare(
    `INSERT INTO footmops_snapshots (league, tour, source, extracted_at, imported_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(league, tour) DO UPDATE SET
       source = excluded.source,
       extracted_at = excluded.extracted_at,
       imported_at = excluded.imported_at`,
  );
  const deletePlayers = database.prepare(
    `DELETE FROM footmops_predictions WHERE league = ? AND tour = ?`,
  );
  const insertPlayer = database.prepare(
    `INSERT INTO footmops_predictions
       (league, tour, club_key, source_club, source_player, lineup_group,
        displayed_percentage, mantra_player_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.transaction(() => {
    upsertSnap.run(
      snapshot.league,
      snapshot.tour,
      snapshot.source,
      snapshot.extractedAt,
    );
    deletePlayers.run(snapshot.league, snapshot.tour);
    for (const club of clubs) {
      const linkedClub = resolveClub(database, club.name, tournamentId);
      const clubKey = expected11TeamKey(linkedClub.club?.name ?? club.name);
      for (const player of club.players) {
        result.players += 1;
        const linkedPlayer =
          linkedClub.status === "linked" && linkedClub.club
            ? resolveFootmopsPlayer(database, linkedClub.club, player.name)
            : { status: "unmatched" as const, player: null };
        if (linkedPlayer.status === "linked") result.linked += 1;
        else if (linkedPlayer.status === "ambiguous") result.ambiguous += 1;
        else {
          result.unmatched += 1;
          result.unmatchedPlayers.push({
            club: club.name,
            name: player.name,
            percentage: player.percentage,
          });
        }
        insertPlayer.run(
          snapshot.league,
          snapshot.tour,
          clubKey,
          club.name,
          player.name,
          player.group,
          player.percentage,
          linkedPlayer.player?.id ?? null,
          linkedPlayer.status,
        );
      }
    }
  })();
  if (options.bustCache !== false) {
    invalidateComputed(PREMIUM_ODDS_JOIN_CACHE_KEY, { database, persist: true });
  }
  return result;
}

export function ensureFootmopsImported(
  database: Database.Database = getDb(),
): FootmopsImportResult | null {
  database.exec(FOOTMOPS_SCHEMA);
  const snapshot = readChampionshipTour2Snapshot();
  const existing = database
    .prepare(
      `SELECT extracted_at AS extractedAt FROM footmops_snapshots
       WHERE league = ? AND tour = ?`,
    )
    .get(snapshot.league, snapshot.tour) as { extractedAt: string } | undefined;
  if (existing?.extractedAt === snapshot.extractedAt) return null;
  return importFootmopsSnapshot(snapshot, database);
}

/**
 * Apply expected11_manual_mappings to footmops rows (SorareInside %).
 * Call after a Mapping-page save/delete so the футмопс column updates immediately.
 */
export function relinkFootmopsFromManualMappings(
  database: Database.Database = getDb(),
  scope?: { mantraClubId: number; sourceKey: string },
): { updated: number } {
  database.exec(FOOTMOPS_SCHEMA);
  const rows = database
    .prepare(
      `SELECT league, tour, club_key AS clubKey, source_club AS sourceClub,
              source_player AS sourcePlayer, mantra_player_id AS mantraPlayerId,
              link_status AS linkStatus
       FROM footmops_predictions`,
    )
    .all() as Array<{
    league: string;
    tour: number;
    clubKey: string;
    sourceClub: string;
    sourcePlayer: string;
    mantraPlayerId: number | null;
    linkStatus: "linked" | "unmatched" | "ambiguous";
  }>;
  if (rows.length === 0) return { updated: 0 };

  const update = database.prepare(
    `UPDATE footmops_predictions
     SET mantra_player_id = ?, link_status = ?
     WHERE league = ? AND tour = ? AND club_key = ? AND source_player = ?`,
  );
  let updated = 0;
  for (const row of rows) {
    if (scope && normName(row.sourcePlayer) !== scope.sourceKey) continue;
    const club = resolveClub(database, row.sourceClub, CHAMPIONSHIP_TOURNAMENT_ID);
    if (club.status !== "linked" || !club.club) continue;
    if (scope && club.club.id !== scope.mantraClubId) continue;
    const linked = resolveExpected11Player(database, club.club, row.sourcePlayer);
    const nextId = linked.player?.id ?? null;
    const nextStatus =
      linked.status === "linked"
        ? ("linked" as const)
        : linked.status === "ambiguous"
          ? ("ambiguous" as const)
          : ("unmatched" as const);
    if (nextId === row.mantraPlayerId && nextStatus === row.linkStatus) continue;
    update.run(nextId, nextStatus, row.league, row.tour, row.clubKey, row.sourcePlayer);
    updated += 1;
  }
  if (updated > 0) {
    invalidateComputed(PREMIUM_ODDS_JOIN_CACHE_KEY, { database, persist: true });
  }
  return { updated };
}

/** Unmatched SorareInside/footmops players for the Mapping UI. */
export function listUnmatchedFootmopsPlayers(
  database: Database.Database = getDb(),
): Array<{
  league: string;
  tour: number;
  sourceClub: string;
  sourcePlayer: string;
  displayedPercentage: number;
  lineupGroup: FootmopsLineupGroup;
  mantraClubId: number;
  mantraClubName: string;
  linkStatus: "unmatched" | "ambiguous";
}> {
  database.exec(FOOTMOPS_SCHEMA);
  const rows = database
    .prepare(
      `SELECT league, tour, source_club AS sourceClub, source_player AS sourcePlayer,
              displayed_percentage AS displayedPercentage,
              lineup_group AS lineupGroup, link_status AS linkStatus
       FROM footmops_predictions
       WHERE link_status IN ('unmatched', 'ambiguous')
       ORDER BY source_club, source_player`,
    )
    .all() as Array<{
    league: string;
    tour: number;
    sourceClub: string;
    sourcePlayer: string;
    displayedPercentage: number;
    lineupGroup: FootmopsLineupGroup;
    linkStatus: "unmatched" | "ambiguous";
  }>;
  const out: Array<{
    league: string;
    tour: number;
    sourceClub: string;
    sourcePlayer: string;
    displayedPercentage: number;
    lineupGroup: FootmopsLineupGroup;
    mantraClubId: number;
    mantraClubName: string;
    linkStatus: "unmatched" | "ambiguous";
  }> = [];
  for (const row of rows) {
    const club = resolveClub(database, row.sourceClub, CHAMPIONSHIP_TOURNAMENT_ID);
    if (club.status !== "linked" || !club.club) continue;
    out.push({
      ...row,
      mantraClubId: club.club.id,
      mantraClubName: club.club.name,
    });
  }
  return out;
}

export function footmopsHasSourcePlayer(
  database: Database.Database,
  mantraClubId: number,
  sourceKey: string,
): boolean {
  database.exec(FOOTMOPS_SCHEMA);
  const rows = database
    .prepare(
      `SELECT source_club AS sourceClub, source_player AS sourcePlayer
       FROM footmops_predictions`,
    )
    .all() as Array<{ sourceClub: string; sourcePlayer: string }>;
  for (const row of rows) {
    if (normName(row.sourcePlayer) !== sourceKey) continue;
    const club = resolveClub(database, row.sourceClub, CHAMPIONSHIP_TOURNAMENT_ID);
    if (club.status === "linked" && club.club?.id === mantraClubId) return true;
  }
  return false;
}
