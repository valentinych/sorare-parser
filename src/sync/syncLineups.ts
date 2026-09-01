import * as af from "../clients/apiFootball.js";
import { getDb, setMeta } from "../db/index.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function syncLineups(
  opts: { limit?: number; onlyMissing?: boolean; leagueId?: number } = {},
): Promise<number> {
  const db = getDb();
  const onlyMissing = opts.onlyMissing ?? true;
  const leagueClause = opts.leagueId != null ? "AND f.league_id = ?" : "";
  const leagueParams = opts.leagueId != null ? [opts.leagueId] : [];

  let fixtures: Array<{ id: number }> = onlyMissing
    ? (db
        .prepare(
          `SELECT f.id FROM fixtures f
           WHERE f.status IN ('FT', 'AET', 'PEN')
             ${leagueClause}
             AND NOT EXISTS (
               SELECT 1 FROM lineup_appearances la WHERE la.fixture_id = f.id
             )
           ORDER BY f.date`,
        )
        .all(...leagueParams) as Array<{ id: number }>)
    : (db
        .prepare(
          `SELECT f.id FROM fixtures f
           WHERE f.status IN ('FT', 'AET', 'PEN')
             ${leagueClause}
           ORDER BY f.date`,
        )
        .all(...leagueParams) as Array<{ id: number }>);

  if (opts.limit) fixtures = fixtures.slice(0, opts.limit);

  const upsertPlayer = db.prepare(
    `INSERT INTO players (id, name, position, team_id)
     VALUES (@id, @name, @position, @team_id)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       position = COALESCE(excluded.position, players.position),
       team_id = COALESCE(excluded.team_id, players.team_id)`,
  );

  const upsertAppearance = db.prepare(
    `INSERT INTO lineup_appearances
       (fixture_id, team_id, player_id, player_name, position, grid, formation, is_starter)
     VALUES (@fixture_id, @team_id, @player_id, @player_name, @position, @grid, @formation, @is_starter)
     ON CONFLICT(fixture_id, team_id, player_id) DO UPDATE SET
       position = excluded.position,
       grid = excluded.grid,
       formation = excluded.formation,
       is_starter = excluded.is_starter`,
  );

  let synced = 0;
  for (const { id } of fixtures) {
    const { response } = await af.lineups(id);
    const tx = db.transaction((lineups: af.AfLineup[]) => {
      for (const lu of lineups) {
        for (const slot of lu.startXI) {
          const p = slot.player;
          if (!p.id) continue;
          upsertPlayer.run({
            id: p.id,
            name: p.name,
            position: normalizePos(p.pos),
            team_id: lu.team.id,
          });
          upsertAppearance.run({
            fixture_id: id,
            team_id: lu.team.id,
            player_id: p.id,
            player_name: p.name,
            position: normalizePos(p.pos),
            grid: p.grid,
            formation: lu.formation,
            is_starter: 1,
          });
        }
        for (const slot of lu.substitutes) {
          const p = slot.player;
          if (!p.id) continue;
          upsertPlayer.run({
            id: p.id,
            name: p.name,
            position: normalizePos(p.pos),
            team_id: lu.team.id,
          });
          upsertAppearance.run({
            fixture_id: id,
            team_id: lu.team.id,
            player_id: p.id,
            player_name: p.name,
            position: normalizePos(p.pos),
            grid: p.grid,
            formation: lu.formation,
            is_starter: 0,
          });
        }
      }
    });
    tx(response);
    synced++;
    if (synced % 10 === 0) console.log(`  lineups: ${synced}/${fixtures.length}`);
    await sleep(200);
  }

  setMeta("lineups_synced", String(synced));
  return synced;
}

function normalizePos(pos: string | null): string | null {
  if (!pos) return null;
  const p = pos.toUpperCase();
  if (p === "G" || p.startsWith("GK") || p === "GOALKEEPER") return "GK";
  if (p === "D" || p.startsWith("DEF") || p === "DEFENDER") return "DEF";
  if (p === "M" || p.startsWith("MID") || p === "MIDFIELDER") return "MID";
  if (p === "F" || p === "A" || p.startsWith("ATT") || p === "ATTACKER" || p === "FORWARD") return "ATT";
  return p;
}
