import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { getIdealDivisionTable, peekIdealTableOverlay, resolveIdealDivision, warmIdealTables } from "../domain/mantraIdealTables.js";
import { getManagersStandings, isManagersSlug } from "../domain/mantraManagers.js";
import { loadSeasonIdealTotals } from "../domain/mantraIdealVsReal.js";
import {
  DEFAULT_STANDINGS_SLUG,
  getChampionshipStandings,
  mergeIdealTsSources,
  resolveStandingsLeague,
  standingsLeagues,
  withIdealTableStats,
  withIdealTs,
} from "../domain/mantraStandings.js";
import { tablesProgressPayload } from "../domain/tablesProgress.js";

export async function mantraStandingsRoutes(app: FastifyInstance) {
  app.get("/api/tables/leagues", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    return { leagues: standingsLeagues(), defaultLeague: DEFAULT_STANDINGS_SLUG };
  });

  app.get("/api/tables/progress", async (request, reply) => {
    const query = request.query as { league?: string };
    const requested = query.league == null ? "" : String(query.league);
    if (isManagersSlug(requested)) {
      reply.header("Cache-Control", "no-store");
      return { league: "managers", extra: false, progress: { complete: true } };
    }
    const league = requested.trim() ? resolveStandingsLeague(requested) : null;
    if (requested.trim() && !league) {
      return reply.code(400).send({ error: "invalid_standings_league" });
    }
    reply.header("Cache-Control", "no-store");
    return tablesProgressPayload(league?.slug ?? requested);
  });

  app.get("/api/tables", async (request, reply) => {
    const query = request.query as { league?: string };
    const requested = query.league == null ? DEFAULT_STANDINGS_SLUG : String(query.league);
    if (isManagersSlug(requested)) {
      reply.header("Cache-Control", "public, max-age=30");
      return getManagersStandings({ database: getDb() });
    }
    const league = resolveStandingsLeague(requested);
    if (query.league != null && query.league !== "" && !league) {
      return reply.code(400).send({ error: "invalid_standings_league" });
    }
    reply.header("Cache-Control", "public, max-age=30");
    const database = getDb();
    const view = await getChampionshipStandings(league?.slug ?? DEFAULT_STANDINGS_SLUG, {
      database,
    });
    const playedGames = view.rows.reduce((max, row) => Math.max(max, row.games || 0), 0);
    warmIdealTables(view.league, { database });
    const table = peekIdealTableOverlay(view.league, database);
    return withIdealTableStats(
      withIdealTs(
        view,
        mergeIdealTsSources(
          loadSeasonIdealTotals(view.league, {
            database,
            maxRounds: playedGames > 0 ? playedGames : undefined,
          }),
          table,
        ),
      ),
      table.stats,
    );
  });

  app.get("/api/tables/ideal", async (request, reply) => {
    const query = request.query as { league?: string; division?: string };
    const requested = query.league == null ? DEFAULT_STANDINGS_SLUG : String(query.league);
    const league = resolveStandingsLeague(requested);
    if (query.league != null && query.league !== "" && !league) {
      return reply.code(400).send({ error: "invalid_standings_league" });
    }
    const slug = league?.slug ?? DEFAULT_STANDINGS_SLUG;
    const division = query.division == null ? "" : String(query.division);
    reply.header("Cache-Control", "public, max-age=30");
    if (!division.trim()) {
      return getIdealDivisionTable(slug, "");
    }
    if (!resolveIdealDivision(slug, division)) {
      return reply.code(400).send({
        error: "invalid_standings_division",
        ...(await getIdealDivisionTable(slug, division)),
      });
    }
    const database = getDb();
    // Warm standings cache (same 1h snapshot as /api/tables) so GW history
    // overlays official Mantra TS/GF without extra tour fetches.
    await getChampionshipStandings(slug, { database });
    return getIdealDivisionTable(slug, division, { database });
  });
}

