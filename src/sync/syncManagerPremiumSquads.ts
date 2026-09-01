import type Database from "better-sqlite3";
import * as mantra from "../clients/mantra.js";
import { getDb } from "../db/index.js";
import { uiLeagues } from "../lib/afLeagues.js";
import {
  peekComputedPersisted,
  writeComputed,
} from "../lib/computedCache.js";
import { catalogMantraLeagues } from "../lib/mantraLeagueCatalog.js";
import { allLiveLeagues } from "../lib/liveLeagues.js";

export type PremiumSquadsClient = {
  fetchLeagueTeams: typeof mantra.fetchLeagueTeams;
  fetchFantasyTeam: typeof mantra.fetchFantasyTeam;
  fetchMantraLeague?: typeof mantra.fetchMantraLeague;
};

export type ManagerSquadsMarker = {
  teamIds: number[];
  syncedAt: string;
};

const inflight = new Map<number, Promise<{ fetched: boolean; teams: number }>>();

export function premiumSquadsCacheKey(managerId: number): string {
  return `premium:squads:${managerId}`;
}

export function resetManagerPremiumSquadsForTests(): void {
  inflight.clear();
}

function defaultClient(): PremiumSquadsClient {
  return {
    fetchLeagueTeams: mantra.fetchLeagueTeams,
    fetchFantasyTeam: mantra.fetchFantasyTeam,
    fetchMantraLeague: mantra.fetchMantraLeague,
  };
}

function uiTournamentIds(): number[] {
  return [
    ...new Set(
      uiLeagues()
        .map((league) => league.mantraTournamentId)
        .filter((id): id is number => id != null),
    ),
  ];
}

function discoveryLeagues(
  database: Database.Database,
): Array<{ id: number; tournamentId: number | null; name: string; division: string }> {
  const map = new Map<
    number,
    { id: number; tournamentId: number | null; name: string; division: string }
  >();
  const put = (row: {
    id: number;
    tournamentId?: number | null;
    name?: string | null;
    division?: string | null;
  }) => {
    if (!Number.isSafeInteger(row.id) || row.id <= 0) return;
    const current = map.get(row.id);
    if (!current) {
      map.set(row.id, {
        id: row.id,
        tournamentId: row.tournamentId ?? null,
        name: String(row.name || ""),
        division: String(row.division || ""),
      });
      return;
    }
    if (current.tournamentId == null && row.tournamentId != null) {
      current.tournamentId = row.tournamentId;
    }
    if (!current.name && row.name) current.name = row.name;
    if (!current.division && row.division) current.division = row.division;
  };

  const tournaments = uiTournamentIds();
  if (tournaments.length) {
    const rows = database
      .prepare(
        `SELECT id, tournament_id AS tournamentId, name, division
         FROM mantra_leagues
         WHERE tournament_id IN (${tournaments.map(() => "?").join(",")})`,
      )
      .all(...tournaments) as Array<{
      id: number;
      tournamentId: number | null;
      name: string;
      division: string | null;
    }>;
    for (const row of rows) put(row);
  }

  for (const league of allLiveLeagues()) {
    for (const division of league.mantraDivisions) {
      put({
        id: division.leagueId,
        tournamentId: league.mantraTournamentId,
        name: division.name,
        division: division.division,
      });
    }
  }
  for (const tournamentId of tournaments) {
    for (const league of catalogMantraLeagues(tournamentId)) {
      put({
        id: league.id,
        tournamentId,
        name: league.name,
        division: league.division,
      });
    }
  }
  return [...map.values()];
}

function managerTeamRows(database: Database.Database, managerId: number) {
  return database
    .prepare(
      `SELECT id, league_id AS leagueId, tournament_id AS tournamentId
       FROM mantra_fantasy_teams
       WHERE user_id = ?
       ORDER BY id`,
    )
    .all(managerId) as Array<{
    id: number;
    leagueId: number;
    tournamentId: number | null;
  }>;
}

function squadsAlreadyCached(
  managerId: number,
  database: Database.Database,
): boolean {
  if (peekComputedPersisted(premiumSquadsCacheKey(managerId), { database })) {
    return true;
  }
  return managerTeamRows(database, managerId).length > 0;
}

function markSquadsSynced(
  managerId: number,
  teamIds: number[],
  database: Database.Database,
): void {
  writeComputed(
    premiumSquadsCacheKey(managerId),
    "1",
    {
      teamIds,
      syncedAt: new Date().toISOString(),
    } satisfies ManagerSquadsMarker,
    { database },
  );
}

function upsertLeague(
  database: Database.Database,
  league: {
    id: number;
    name: string;
    division: string;
    tournamentId: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO mantra_leagues (id, name, division, tournament_id, synced_at)
       VALUES (@id, @name, @division, @tournamentId, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
         division = CASE
           WHEN excluded.division != '' THEN excluded.division ELSE division
         END,
         tournament_id = COALESCE(excluded.tournament_id, tournament_id),
         synced_at = excluded.synced_at`,
    )
    .run({
      id: league.id,
      name: league.name || `Лига #${league.id}`,
      division: league.division,
      tournamentId: league.tournamentId,
    });
}

function upsertTeam(
  database: Database.Database,
  team: mantra.MantraFantasyTeam,
  tournamentId: number | null,
): void {
  database
    .prepare(
      `INSERT INTO mantra_fantasy_teams (
         id, league_id, tournament_id, name, code, logo_path, user_id, budget, players_json, synced_at
       ) VALUES (
         @id, @leagueId, @tournamentId, @name, @code, @logoPath, @userId, @budget, @playersJson, @syncedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         league_id = excluded.league_id,
         tournament_id = COALESCE(excluded.tournament_id, tournament_id),
         name = excluded.name,
         code = excluded.code,
         logo_path = excluded.logo_path,
         user_id = excluded.user_id,
         budget = excluded.budget,
         players_json = excluded.players_json,
         synced_at = excluded.synced_at`,
    )
    .run({
      id: team.id,
      leagueId: team.leagueId,
      tournamentId,
      name: team.name || `Команда #${team.id}`,
      code: team.code,
      logoPath: team.logoPath,
      userId: team.userId,
      budget: team.budget,
      playersJson: JSON.stringify(team.playerIds),
      syncedAt: new Date().toISOString(),
    });
}

function localTeamUser(
  database: Database.Database,
  teamId: number,
): { userId: number | null; tournamentId: number | null } | undefined {
  return database
    .prepare(
      `SELECT user_id AS userId, tournament_id AS tournamentId
       FROM mantra_fantasy_teams WHERE id = ?`,
    )
    .get(teamId) as
    | { userId: number | null; tournamentId: number | null }
    | undefined;
}

function leagueTeamCount(database: Database.Database, leagueId: number): number {
  return (
    database
      .prepare(`SELECT COUNT(*) AS n FROM mantra_fantasy_teams WHERE league_id = ?`)
      .get(leagueId) as { n: number }
  ).n;
}

async function pullManagerSquads(
  managerId: number,
  options: {
    discoverUnknown: boolean;
    database: Database.Database;
    client: PremiumSquadsClient;
  },
): Promise<number> {
  const { database, client } = options;
  const leagues = discoveryLeagues(database);
  const leagueById = new Map(leagues.map((league) => [league.id, league]));

  const refreshIds = new Set(managerTeamRows(database, managerId).map((row) => row.id));
  for (const id of refreshIds) {
    const team = await client.fetchFantasyTeam(id);
    const known = leagueById.get(team.leagueId);
    const local = localTeamUser(database, id);
    if (known) upsertLeague(database, known);
    upsertTeam(
      database,
      team,
      known?.tournamentId ?? local?.tournamentId ?? null,
    );
  }

  for (const league of leagues) {
    const summaries = await client.fetchLeagueTeams(league.id);
    let found = false;
    const unknown: typeof summaries = [];
    for (const summary of summaries) {
      const local = localTeamUser(database, summary.id);
      if (local?.userId === managerId) {
        found = true;
        continue;
      }
      if (local) continue;
      unknown.push(summary);
    }
    if (found || !options.discoverUnknown) continue;
    if (unknown.length === 0) continue;
    if (leagueTeamCount(database, league.id) > 0) continue;

    if (client.fetchMantraLeague && !league.name) {
      const remote = await client.fetchMantraLeague(league.id);
      if (remote) {
        league.name = remote.name;
        league.division = remote.division;
        if (remote.tournamentId) league.tournamentId = remote.tournamentId;
      }
    }
    if (league.name) upsertLeague(database, league);

    for (const summary of unknown) {
      const team = await client.fetchFantasyTeam(summary.id);
      upsertTeam(database, team, league.tournamentId);
      if (team.userId === managerId) break;
    }
  }

  return managerTeamRows(database, managerId).length;
}

export async function ensureManagerPremiumSquads(
  managerId: number | null | undefined,
  options: {
    force?: boolean;
    database?: Database.Database;
    client?: PremiumSquadsClient;
  } = {},
): Promise<{ fetched: boolean; teams: number }> {
  if (managerId == null || !Number.isSafeInteger(managerId) || managerId <= 0) {
    return { fetched: false, teams: 0 };
  }
  const pending = inflight.get(managerId);
  if (pending) return pending;

  const work = (async () => {
    const database = options.database ?? getDb();
    const client = options.client ?? defaultClient();
    const force = options.force === true;
    if (!force && squadsAlreadyCached(managerId, database)) {
      return { fetched: false, teams: managerTeamRows(database, managerId).length };
    }
    const teams = await pullManagerSquads(managerId, {
      discoverUnknown: force || managerTeamRows(database, managerId).length === 0,
      database,
      client,
    });
    markSquadsSynced(
      managerId,
      managerTeamRows(database, managerId).map((row) => row.id),
      database,
    );
    return { fetched: true, teams };
  })();

  inflight.set(managerId, work);
  try {
    return await work;
  } finally {
    inflight.delete(managerId);
  }
}
