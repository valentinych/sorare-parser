import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { managerIdentityStale, syncManagerFormationsForTeam } from "./syncManagerFormations.js";

/**
 * Sync manager formation preferences (TM identity + AF career formations).
 *
 * Examples:
 *   npm run sync:manager -- --team=40
 *   npm run sync:manager -- --league=106,39 --sample=100
 *   npm run sync:manager -- --league=39 --force
 */
async function main() {
  getDb();
  const args = process.argv.slice(2);
  const teamArg = args.find((a) => a.startsWith("--team="));
  const leagueArg = args.find((a) => a.startsWith("--league="));
  const sampleArg = args.find((a) => a.startsWith("--sample="));
  const seasonArg = args.find((a) => a.startsWith("--season="));
  const force = args.includes("--force");
  const sampleSize = sampleArg ? Number(sampleArg.slice("--sample=".length)) : 100;
  const season = seasonArg ? Number(seasonArg.slice("--season=".length)) : config.predictSeason;

  let teamIds: number[] = [];

  if (teamArg) {
    const id = Number(teamArg.slice("--team=".length));
    if (!Number.isFinite(id)) throw new Error("Invalid --team=");
    teamIds = [id];
  } else if (leagueArg) {
    const leagueIds = leagueArg
      .slice("--league=".length)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (!leagueIds.length) throw new Error("Invalid --league=");
    const placeholders = leagueIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT team_id AS id, name, league_id AS leagueId FROM season_teams
         WHERE season = ? AND league_id IN (${placeholders})
         ORDER BY league_id, name`,
      )
      .all(season, ...leagueIds) as Array<{ id: number; name: string; leagueId: number }>;
    teamIds = rows.map((r) => r.id);
    console.log(
      `Batch manager formations season=${season} leagues=${leagueIds.join(",")} teams=${teamIds.length} sample=${sampleSize}${force ? " force" : ""}`,
    );
    for (const r of rows) console.log(`  · ${r.name} (${r.id}) league=${r.leagueId}`);
  } else {
    teamIds = [40];
    console.log(`Default team=40 (Liverpool). Pass --league=106,39 for batch.`);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < teamIds.length; i++) {
    const teamId = teamIds[i]!;
    const name =
      (
        getDb()
          .prepare(`SELECT name FROM season_teams WHERE season = ? AND team_id = ?`)
          .get(season, teamId) as { name?: string } | undefined
      )?.name ?? String(teamId);

    if (!force) {
      const existing = getDb()
        .prepare(
          `SELECT preferred_formation, sample_size, coach_name, source FROM manager_formation_summary WHERE team_id = ?`,
        )
        .get(teamId) as
        | {
            preferred_formation: string;
            sample_size: number;
            coach_name: string | null;
            source: string | null;
          }
        | undefined;
      if (existing) {
        const stale = await managerIdentityStale(teamId);
        if (!stale && existing.sample_size >= 3) {
          console.log(
            `\n[${i + 1}/${teamIds.length}] skip ${name} (${teamId}) — ${existing.coach_name} ${existing.preferred_formation} n=${existing.sample_size}`,
          );
          skipped++;
          continue;
        }
        if (stale) {
          console.log(
            `\n[${i + 1}/${teamIds.length}] refresh ${name} (${teamId}) — TM manager changed (was ${existing.coach_name})`,
          );
        }
      }
    }

    console.log(`\n[${i + 1}/${teamIds.length}] ${name} (${teamId})…`);
    try {
      const summary = await syncManagerFormationsForTeam(teamId, {
        sampleSize,
        predictSeason: season,
      });
      if (summary) {
        ok++;
        console.log(
          `  → ${summary.preferredFormation} ${summary.preferredCount}/${summary.sampleSize} (${summary.coachName})`,
        );
      } else {
        failed++;
        console.warn(`  → no summary`);
      }
    } catch (err) {
      failed++;
      console.error(`  → error:`, err);
    }
  }

  console.log(`\ndone ok=${ok} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
