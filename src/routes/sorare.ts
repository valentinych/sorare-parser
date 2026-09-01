import type { FastifyInstance } from "fastify";
import {
  getSorareGameView,
  getSorareLeagueView,
  getSorareTeamView,
  getSorareTeamViewByAf,
  listSorareLeagues,
} from "../domain/sorare.js";
import { getPrivateSorareInsideProjections } from "../domain/sorareInside.js";
import { requireUser } from "./account.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sorareRoutes(app: FastifyInstance) {
  app.get("/api/sorare/leagues", async () => ({
    leagues: listSorareLeagues(),
  }));

  app.get("/api/sorare/leagues/:league", async (req, reply) => {
    try {
      const view = await getSorareLeagueView((req.params as { league: string }).league);
      if (!view) return reply.code(404).send({ error: "sorare_league_not_found" });
      return view;
    } catch (error) {
      return reply.code(502).send({ error: "sorare_unavailable", message: message(error) });
    }
  });

  app.get("/api/sorare/leagues/:league/teams/:team", async (req, reply) => {
    try {
      const params = req.params as { league: string; team: string };
      const view = await getSorareTeamView(params.league, params.team);
      if (!view) return reply.code(404).send({ error: "sorare_team_not_found" });
      return view;
    } catch (error) {
      return reply.code(502).send({ error: "sorare_unavailable", message: message(error) });
    }
  });

  app.get("/api/sorare/leagues/:league/games/:gameId", async (req, reply) => {
    try {
      const params = req.params as { league: string; gameId: string };
      if (!params.gameId.startsWith("Game:")) {
        return reply.code(400).send({ error: "invalid_sorare_game_id" });
      }
      const view = await getSorareGameView(params.league, params.gameId);
      if (!view) return reply.code(404).send({ error: "sorare_game_not_found" });
      return view;
    } catch (error) {
      return reply.code(502).send({ error: "sorare_unavailable", message: message(error) });
    }
  });

  app.get(
    "/api/sorare/leagues/:league/games/:gameId/private-projections",
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const user = requireUser(req, reply);
      if (!user) return;
      const params = req.params as { league: string; gameId: string };
      if (!params.gameId.startsWith("Game:")) {
        return reply.code(400).send({ error: "invalid_sorare_game_id" });
      }
      return getPrivateSorareInsideProjections(user.id, params.gameId);
    },
  );

  app.get("/api/sorare/by-af/:leagueId/:teamId", async (req, reply) => {
    try {
      const params = req.params as { leagueId: string; teamId: string };
      const leagueId = Number(params.leagueId);
      const teamId = Number(params.teamId);
      if (!Number.isFinite(leagueId) || !Number.isFinite(teamId)) {
        return reply.code(400).send({ error: "invalid_af_team" });
      }
      const view = await getSorareTeamViewByAf(leagueId, teamId);
      if (!view) return reply.code(404).send({ error: "sorare_team_not_linked" });
      return view;
    } catch (error) {
      return reply.code(502).send({ error: "sorare_unavailable", message: message(error) });
    }
  });
}
