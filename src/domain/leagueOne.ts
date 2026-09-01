/**
 * League One (AF 41 / TM GB3 / FotMob 108): sync TM + FotMob squads,
 * fuzzy-match players, persist snapshot JSON for the admin tab.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as fotmob from "../clients/fotmob.js";
import { getDb } from "../db/index.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import { ALL_POSITIONS, type MantraPosition } from "../lib/mantraFormations.js";
import { nameMatchScore } from "../lib/names.js";
import { syncTmLeague } from "../sync/syncTmLeague.js";

export const LEAGUE_ONE_TM = "GB3";
export const LEAGUE_ONE_FOTMOB_ID = fotmob.FOTMOB_LEAGUE_ONE_ID;
export const LEAGUE_ONE_DATA_PATH = path.join(
  process.cwd(),
  "data",
  "league-one.json",
);

const NAME_THRESHOLD = 80;

export type LeagueOneMatchStatus = "linked" | "unmatched" | "ambiguous";

export type LeagueOnePlayerRow = {
  tmPlayerId: string;
  tmName: string;
  tmClubId: string;
  tmClubName: string;
  positions: string[];
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  fotmobPlayerId: number | null;
  fotmobName: string | null;
  fotmobClubName: string | null;
  fotmobPositions: string | null;
  matchStatus: LeagueOneMatchStatus;
  matchScore: number | null;
  candidates: Array<{ id: number; name: string; score: number }>;
  /** MantraFootball-style positions (1–3), persisted in DB. */
  mantraPositions?: string[];
  /** True when FotMob link comes from league_one_player_mappings. */
  manualMapping?: boolean;
};

export type LeagueOneFotmobOrphan = {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
  positions: string | null;
};

export type LeagueOneSnapshot = {
  syncedAt: string;
  tmCompetition: string;
  fotmobLeagueId: number;
  counts: {
    tmPlayers: number;
    fotmobPlayers: number;
    linked: number;
    unmatched: number;
    ambiguous: number;
    fotmobOrphans: number;
  };
  players: LeagueOnePlayerRow[];
  fotmobOrphans: LeagueOneFotmobOrphan[];
};

type TmRow = {
  player_id: string;
  name: string;
  club_id: string;
  club_name: string;
  position: string | null;
  detail_role: string | null;
  detail_label: string | null;
  side_role: string | null;
};

type FotmobRow = {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
  positionIdsDesc: string | null;
};

const COARSE_TM_POSITIONS = new Set(["MID", "DEF", "ATT"]);

/** Drop Transfermarkt bucket labels; keep fine roles (CM, CB, ST, …). */
export function fineTmPositions(positions: string[]): string[] {
  const out: string[] = [];
  for (const raw of positions) {
    const token = String(raw || "").trim();
    if (!token) continue;
    if (COARSE_TM_POSITIONS.has(token.toUpperCase())) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

function positionsFromTm(row: TmRow): string[] {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const part of String(raw).split(/[,/|]/)) {
      const token = part.trim();
      if (token && !out.includes(token)) out.push(token);
    }
  };
  push(row.detail_role);
  push(row.detail_label);
  push(row.side_role);
  // Coarse AF/TM buckets (MID/DEF/ATT) come from `position` — skip them.
  if (row.position && !COARSE_TM_POSITIONS.has(row.position.toUpperCase())) {
    push(row.position);
  }
  return fineTmPositions(out);
}

export function parseFotmobPositions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(/[,/|]/)) {
    const token = part.trim();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

export function loadTmLeagueOnePlayers(competitionId = LEAGUE_ONE_TM): TmRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT sp.player_id, sp.name, sp.club_id, c.name AS club_name,
              sp.position, sp.detail_role, sp.detail_label, sp.side_role
       FROM tm_squad_players sp
       JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id
       JOIN tm_clubs c ON c.id = sp.club_id
       WHERE cc.competition_id = ?
       ORDER BY c.name COLLATE NOCASE, sp.name COLLATE NOCASE`,
    )
    .all(competitionId) as TmRow[];
}

export async function fetchFotmobLeagueOneSquads(
  leagueId = LEAGUE_ONE_FOTMOB_ID,
  signal?: AbortSignal,
): Promise<FotmobRow[]> {
  const teams = await fotmob.fetchLeagueTableTeams(leagueId, signal);
  const out: FotmobRow[] = [];
  const seen = new Set<number>();
  for (const team of teams) {
    const squad = await fotmob.fetchTeamSquad(team.id, signal);
    const teamName = squad.teamName || team.name;
    for (const player of squad.players) {
      if (seen.has(player.id)) continue;
      seen.add(player.id);
      out.push({
        id: player.id,
        name: player.name,
        teamId: team.id,
        teamName,
        positionIdsDesc: player.positionIdsDesc,
      });
    }
  }
  return out;
}

function candidatesForTm(
  tm: TmRow,
  fotmob: FotmobRow[],
): Array<{ player: FotmobRow; score: number }> {
  const atClub = fotmob.filter((p) => clubsMatch(tm.club_name, p.teamName));
  const scored: Array<{ player: FotmobRow; score: number }> = [];
  for (const player of atClub) {
    const score = nameMatchScore(tm.name, player.name);
    if (score >= NAME_THRESHOLD) scored.push({ player, score });
  }
  scored.sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));
  return scored;
}

function baseRow(tm: TmRow): LeagueOnePlayerRow {
  return {
    tmPlayerId: tm.player_id,
    tmName: tm.name,
    tmClubId: tm.club_id,
    tmClubName: tm.club_name,
    positions: positionsFromTm(tm),
    detailRole: tm.detail_role,
    detailLabel: tm.detail_label,
    sideRole: tm.side_role,
    fotmobPlayerId: null,
    fotmobName: null,
    fotmobClubName: null,
    fotmobPositions: null,
    matchStatus: "unmatched",
    matchScore: null,
    candidates: [],
  };
}

/** Match TM League One squad ↔ FotMob squads (unique 1:1 only → linked). */
export function matchLeagueOnePlayers(
  tmPlayers: TmRow[],
  fotmobPlayers: FotmobRow[],
): { players: LeagueOnePlayerRow[]; fotmobOrphans: LeagueOneFotmobOrphan[] } {
  type Proposal = {
    fotmob: FotmobRow;
    score: number;
    all: Array<{ id: number; name: string; score: number }>;
    ambiguous: boolean;
  };

  const proposals = new Map<string, Proposal>();
  for (const tm of tmPlayers) {
    const scored = candidatesForTm(tm, fotmobPlayers);
    if (!scored.length) continue;
    const all = scored.map((s) => ({
      id: s.player.id,
      name: s.player.name,
      score: s.score,
    }));
    proposals.set(tm.player_id, {
      fotmob: scored[0]!.player,
      score: scored[0]!.score,
      all,
      ambiguous: scored.length > 1,
    });
  }

  const owners = new Map<number, string[]>();
  for (const [tmId, proposal] of proposals) {
    if (proposal.ambiguous) continue;
    const list = owners.get(proposal.fotmob.id) ?? [];
    list.push(tmId);
    owners.set(proposal.fotmob.id, list);
  }

  const linkedFotmob = new Set<number>();
  const players: LeagueOnePlayerRow[] = tmPlayers.map((tm) => {
    const row = baseRow(tm);
    const proposal = proposals.get(tm.player_id);
    if (!proposal) return row;

    const contested = (owners.get(proposal.fotmob.id) ?? []).length !== 1;
    if (proposal.ambiguous || contested) {
      return {
        ...row,
        matchStatus: "ambiguous",
        matchScore: proposal.score,
        candidates: proposal.all.length
          ? proposal.all
          : [{ id: proposal.fotmob.id, name: proposal.fotmob.name, score: proposal.score }],
      };
    }

    linkedFotmob.add(proposal.fotmob.id);
    return {
      ...row,
      fotmobPlayerId: proposal.fotmob.id,
      fotmobName: proposal.fotmob.name,
      fotmobClubName: proposal.fotmob.teamName,
      fotmobPositions: proposal.fotmob.positionIdsDesc,
      matchStatus: "linked",
      matchScore: proposal.score,
      candidates: [],
    };
  });

  const fotmobOrphans: LeagueOneFotmobOrphan[] = fotmobPlayers
    .filter((p) => !linkedFotmob.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      teamId: p.teamId,
      teamName: p.teamName,
      positions: p.positionIdsDesc,
    }))
    .sort(
      (a, b) =>
        a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name),
    );

  return { players, fotmobOrphans };
}

function buildSnapshot(
  tmPlayers: TmRow[],
  fotmobPlayers: FotmobRow[],
  syncedAt = new Date().toISOString(),
): LeagueOneSnapshot {
  const { players, fotmobOrphans } = matchLeagueOnePlayers(tmPlayers, fotmobPlayers);
  return {
    syncedAt,
    tmCompetition: LEAGUE_ONE_TM,
    fotmobLeagueId: LEAGUE_ONE_FOTMOB_ID,
    counts: {
      tmPlayers: tmPlayers.length,
      fotmobPlayers: fotmobPlayers.length,
      linked: players.filter((p) => p.matchStatus === "linked").length,
      unmatched: players.filter((p) => p.matchStatus === "unmatched").length,
      ambiguous: players.filter((p) => p.matchStatus === "ambiguous").length,
      fotmobOrphans: fotmobOrphans.length,
    },
    players,
    fotmobOrphans,
  };
}

export async function readLeagueOneSnapshot(): Promise<LeagueOneSnapshot | null> {
  try {
    const raw = await readFile(LEAGUE_ONE_DATA_PATH, "utf8");
    return JSON.parse(raw) as LeagueOneSnapshot;
  } catch {
    return null;
  }
}

export async function writeLeagueOneSnapshot(snapshot: LeagueOneSnapshot): Promise<void> {
  await mkdir(path.dirname(LEAGUE_ONE_DATA_PATH), { recursive: true });
  await writeFile(LEAGUE_ONE_DATA_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function syncLeagueOne(opts: {
  forceRefresh?: boolean;
  skipTm?: boolean;
  signal?: AbortSignal;
} = {}): Promise<LeagueOneSnapshot> {
  if (!opts.skipTm) {
    await syncTmLeague(LEAGUE_ONE_TM, { forceRefresh: opts.forceRefresh });
  }
  const tmPlayers = loadTmLeagueOnePlayers();
  const fotmobPlayers = await fetchFotmobLeagueOneSquads(
    LEAGUE_ONE_FOTMOB_ID,
    opts.signal,
  );
  const snapshot = buildSnapshot(tmPlayers, fotmobPlayers);
  await writeLeagueOneSnapshot(snapshot);
  return snapshot;
}

export const LEAGUE_ONE_MANTRA_MAX = 3;

export function isLeagueOneMantraPosition(value: string): value is MantraPosition {
  return (ALL_POSITIONS as readonly string[]).includes(value);
}

/**
 * Mantra positions in assignment order (created_at ASC).
 * First entry is the primary position used for reports BS/TS slot scoring.
 */
export function loadLeagueOneMantraPositions(): Map<string, string[]> {
  const db = getDb();
  ensureLeagueOneMantraTable(db);
  const rows = db
    .prepare(
      `SELECT tm_player_id AS tmPlayerId, position
       FROM league_one_mantra_positions
       ORDER BY tm_player_id, created_at ASC, rowid ASC`,
    )
    .all() as Array<{ tmPlayerId: string; position: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!isLeagueOneMantraPosition(row.position)) continue;
    const list = map.get(row.tmPlayerId) ?? [];
    if (!list.includes(row.position)) list.push(row.position);
    map.set(row.tmPlayerId, list);
  }
  return map;
}

function ensureLeagueOneMantraTable(db = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS league_one_mantra_positions (
      tm_player_id TEXT NOT NULL,
      position TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tm_player_id, position)
    );
  `);
}

/** Additive assign; each player keeps existing positions, capped at 3. */
export function addLeagueOneMantraPositions(
  tmPlayerIds: string[],
  positions: string[],
): { added: number; skipped: number; byPlayer: Record<string, string[]> } {
  const db = getDb();
  ensureLeagueOneMantraTable(db);
  const cleanPositions = [
    ...new Set(
      positions
        .map((p) => String(p || "").trim().toUpperCase())
        .filter(isLeagueOneMantraPosition),
    ),
  ];
  const ids = [...new Set(tmPlayerIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!cleanPositions.length || !ids.length) {
    return { added: 0, skipped: 0, byPlayer: Object.fromEntries(loadLeagueOneMantraPositions()) };
  }

  const current = loadLeagueOneMantraPositions();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO league_one_mantra_positions (tm_player_id, position, created_at)
     VALUES (?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const existing = [...(current.get(id) ?? [])];
      for (const pos of cleanPositions) {
        if (existing.includes(pos)) {
          skipped += 1;
          continue;
        }
        if (existing.length >= LEAGUE_ONE_MANTRA_MAX) {
          skipped += 1;
          continue;
        }
        const result = insert.run(id, pos, now);
        if (result.changes > 0) {
          existing.push(pos);
          added += 1;
        } else {
          skipped += 1;
        }
      }
      current.set(id, existing);
    }
  });
  tx();

  const byPlayer: Record<string, string[]> = {};
  for (const id of ids) byPlayer[id] = current.get(id) ?? [];
  return { added, skipped, byPlayer };
}

export function removeLeagueOneMantraPosition(
  tmPlayerId: string,
  position: string,
): { removed: boolean; positions: string[] } {
  const db = getDb();
  ensureLeagueOneMantraTable(db);
  const id = String(tmPlayerId || "").trim();
  const pos = String(position || "").trim().toUpperCase();
  if (!id || !isLeagueOneMantraPosition(pos)) {
    return { removed: false, positions: loadLeagueOneMantraPositions().get(id) ?? [] };
  }
  const result = db
    .prepare(
      `DELETE FROM league_one_mantra_positions WHERE tm_player_id = ? AND position = ?`,
    )
    .run(id, pos);
  return {
    removed: result.changes > 0,
    positions: loadLeagueOneMantraPositions().get(id) ?? [],
  };
}

/** Wipe all Mantra-like position assignments for League One. */
export function clearAllLeagueOneMantraPositions(): { cleared: number } {
  const db = getDb();
  ensureLeagueOneMantraTable(db);
  const result = db.prepare(`DELETE FROM league_one_mantra_positions`).run();
  return { cleared: Number(result.changes) || 0 };
}

function attachMantraPositions(snapshot: LeagueOneSnapshot): LeagueOneSnapshot {
  const assigned = loadLeagueOneMantraPositions();
  return {
    ...snapshot,
    players: snapshot.players.map((player) => ({
      ...player,
      positions: fineTmPositions(player.positions || []),
      mantraPositions: assigned.get(player.tmPlayerId) ?? [],
    })),
  };
}

export type LeagueOnePlayerMapping = {
  tmPlayerId: string;
  fotmobPlayerId: number;
};

function ensureLeagueOneMappingsTable(db = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS league_one_player_mappings (
      tm_player_id TEXT PRIMARY KEY,
      fotmob_player_id INTEGER NOT NULL UNIQUE,
      mapped_by_user_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function loadLeagueOnePlayerMappings(): LeagueOnePlayerMapping[] {
  const db = getDb();
  ensureLeagueOneMappingsTable(db);
  return db
    .prepare(
      `SELECT tm_player_id AS tmPlayerId, fotmob_player_id AS fotmobPlayerId
       FROM league_one_player_mappings
       ORDER BY tm_player_id`,
    )
    .all() as LeagueOnePlayerMapping[];
}

/** Overlay DB manual links on an auto-match snapshot (survives sync). */
export function attachManualMappings(snapshot: LeagueOneSnapshot): LeagueOneSnapshot {
  const mappings = loadLeagueOnePlayerMappings();
  if (!mappings.length) {
    return {
      ...snapshot,
      players: snapshot.players.map((player) => ({
        ...player,
        manualMapping: false,
      })),
    };
  }

  const players = snapshot.players.map((player) => ({
    ...player,
    manualMapping: false,
  }));
  const byTm = new Map(players.map((player) => [player.tmPlayerId, player]));
  const orphanById = new Map(
    snapshot.fotmobOrphans.map((orphan) => [orphan.id, { ...orphan }]),
  );

  for (const mapping of mappings) {
    const player = byTm.get(mapping.tmPlayerId);
    if (!player) continue;
    const orphan = orphanById.get(mapping.fotmobPlayerId);
    if (!orphan) {
      // Already auto-linked to the same FotMob id — just mark as manual.
      if (player.fotmobPlayerId === mapping.fotmobPlayerId) {
        player.manualMapping = true;
      }
      continue;
    }
    // Only map onto TM rows that are not already linked to a different FotMob.
    if (player.fotmobPlayerId != null && player.fotmobPlayerId !== mapping.fotmobPlayerId) {
      continue;
    }
    player.fotmobPlayerId = orphan.id;
    player.fotmobName = orphan.name;
    player.fotmobClubName = orphan.teamName;
    player.fotmobPositions = orphan.positions;
    player.matchStatus = "linked";
    player.matchScore = null;
    player.candidates = [];
    player.manualMapping = true;
    orphanById.delete(orphan.id);
  }

  const fotmobOrphans = [...orphanById.values()].sort(
    (a, b) =>
      a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name),
  );

  return {
    ...snapshot,
    players,
    fotmobOrphans,
    counts: {
      ...snapshot.counts,
      linked: players.filter((p) => p.matchStatus === "linked").length,
      unmatched: players.filter((p) => p.matchStatus === "unmatched").length,
      ambiguous: players.filter((p) => p.matchStatus === "ambiguous").length,
      fotmobOrphans: fotmobOrphans.length,
    },
  };
}

export class LeagueOneMappingError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "LeagueOneMappingError";
    this.statusCode = statusCode;
  }
}

export function saveLeagueOnePlayerMapping(
  input: { tmPlayerId: string; fotmobPlayerId: number },
  actorUserId: number | null | undefined,
  snapshot: LeagueOneSnapshot | null,
): { mapping: LeagueOnePlayerMapping } {
  const tmPlayerId = String(input.tmPlayerId || "").trim();
  const fotmobPlayerId = Number(input.fotmobPlayerId);
  if (!tmPlayerId || !Number.isSafeInteger(fotmobPlayerId) || fotmobPlayerId <= 0) {
    throw new LeagueOneMappingError("league_one_mapping_invalid");
  }
  if (!snapshot) throw new LeagueOneMappingError("league_one_snapshot_missing", 404);

  const tm = snapshot.players.find((p) => p.tmPlayerId === tmPlayerId);
  if (!tm) throw new LeagueOneMappingError("league_one_tm_player_not_found", 404);

  const existing = loadLeagueOnePlayerMappings();
  const existingForTm = existing.find((m) => m.tmPlayerId === tmPlayerId);
  const existingForFotmob = existing.find((m) => m.fotmobPlayerId === fotmobPlayerId);

  // TM must be unmatched/ambiguous, or this row's existing manual map (overwrite).
  const tmAutoLinked =
    tm.fotmobPlayerId != null && !existingForTm;
  if (tmAutoLinked) {
    throw new LeagueOneMappingError("league_one_tm_already_linked");
  }
  if (tm.fotmobPlayerId == null && tm.matchStatus === "linked") {
    throw new LeagueOneMappingError("league_one_tm_already_linked");
  }

  if (existingForFotmob && existingForFotmob.tmPlayerId !== tmPlayerId) {
    throw new LeagueOneMappingError("league_one_fotmob_already_mapped");
  }

  const orphan = snapshot.fotmobOrphans.find((o) => o.id === fotmobPlayerId);
  const remappingOwn =
    existingForTm?.fotmobPlayerId === fotmobPlayerId ||
    existingForFotmob?.tmPlayerId === tmPlayerId;
  if (!orphan && !remappingOwn) {
    const taken = snapshot.players.some(
      (p) => p.fotmobPlayerId === fotmobPlayerId && p.tmPlayerId !== tmPlayerId,
    );
    if (taken) throw new LeagueOneMappingError("league_one_fotmob_already_linked");
    throw new LeagueOneMappingError("league_one_fotmob_not_orphan", 404);
  }

  const db = getDb();
  ensureLeagueOneMappingsTable(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO league_one_player_mappings
       (tm_player_id, fotmob_player_id, mapped_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tm_player_id) DO UPDATE SET
       fotmob_player_id = excluded.fotmob_player_id,
       mapped_by_user_id = excluded.mapped_by_user_id,
       updated_at = excluded.updated_at`,
  ).run(tmPlayerId, fotmobPlayerId, actorUserId ?? null, now, now);

  return { mapping: { tmPlayerId, fotmobPlayerId } };
}

export function removeLeagueOnePlayerMapping(tmPlayerId: string): {
  removed: boolean;
} {
  const id = String(tmPlayerId || "").trim();
  if (!id) throw new LeagueOneMappingError("league_one_mapping_invalid");
  const db = getDb();
  ensureLeagueOneMappingsTable(db);
  const result = db
    .prepare(`DELETE FROM league_one_player_mappings WHERE tm_player_id = ?`)
    .run(id);
  return { removed: result.changes > 0 };
}

export function getLeagueOneView(snapshot: LeagueOneSnapshot | null): {
  ok: boolean;
  empty: boolean;
  mantraPositions: readonly MantraPosition[];
  snapshot: LeagueOneSnapshot | null;
} {
  if (!snapshot) {
    return { ok: true, empty: true, mantraPositions: ALL_POSITIONS, snapshot: null };
  }
  return {
    ok: true,
    empty: false,
    mantraPositions: ALL_POSITIONS,
    snapshot: attachMantraPositions(attachManualMappings(snapshot)),
  };
}
