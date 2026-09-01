import type { FastifyInstance } from "fastify";
import {
  getClub,
  getCompetition,
  getGameDetail,
  getPlayerDetail,
  listAllPlayers,
  listClubSquad,
  listCompetitionClubs,
  listCompetitions,
  listGames,
  listRef,
  listRefCategories,
  REF_CATEGORY_META,
} from "../domain/tmStats.js";
import { leagueResolveCatalog } from "../lib/afLeagues.js";
import { listTmXiTeams, predictTmClubXi } from "../domain/predictTmXi.js";
import { progressForCompetition, readSyncProgress } from "../lib/syncProgress.js";
import { expandRunnerStatus, startExpandSync, stopExpandSync } from "../lib/expandRunner.js";
import { tmQueueStats } from "../lib/tmQueue.js";
import { sorareAuthenticationStatus } from "../clients/sorare.js";

export async function tmStatsRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => ({
    ok: true,
    service: "tm-stats",
    sorare: sorareAuthenticationStatus(),
  }));

  app.get("/api/sync/progress", async (req) => {
    const q = req.query as { competition?: string };
    if (q.competition) {
      return { ...progressForCompetition(q.competition), runner: expandRunnerStatus() };
    }
    return {
      progress: readSyncProgress(),
      tmQueue: tmQueueStats(),
      runner: expandRunnerStatus(),
    };
  });

  app.post("/api/sync/expand/start", async (req) => {
    const body = (req.body as { args?: string[] } | null) ?? {};
    const result = startExpandSync(body.args ?? []);
    return result;
  });

  app.post("/api/sync/expand/stop", async () => stopExpandSync());

  app.get("/api/competitions", async () => ({
    competitions: listCompetitions(),
    resolve: leagueResolveCatalog(),
  }));

  app.get("/api/xi/:competitionId/teams", async (req, reply) => {
    const competitionId = (req.params as { competitionId: string }).competitionId;
    const competition = getCompetition(competitionId);
    if (!competition) {
      return reply.code(404).send({ error: `Competition ${competitionId} not found` });
    }
    return {
      competitionId,
      teams: listTmXiTeams(competitionId).map((t) => ({
        id: t.id,
        name: t.name,
        logo: t.logo,
      })),
    };
  });

  app.get("/api/xi/:competitionId/teams/:clubId/predicted-xi", async (req, reply) => {
    const { competitionId, clubId } = req.params as { competitionId: string; clubId: string };
    const xi = predictTmClubXi(competitionId, clubId);
    if (!xi) return reply.code(404).send({ error: "Club not found or empty squad" });
    return xi;
  });

  app.get("/api/competition/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const competition = getCompetition(id);
    if (!competition) return reply.code(404).send({ error: `Competition ${id} not found. Run npm run sync:tm` });
    return { competition, clubs: listCompetitionClubs(id) };
  });

  app.get("/api/clubs/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { competition?: string };
    const club = getClub(id, q.competition || undefined);
    if (!club) return reply.code(404).send({ error: `Club ${id} not found` });
    return { club, squad: listClubSquad(id) };
  });

  app.get("/api/players", async (req) => {
    const q = req.query as { competition?: string };
    const competitionId = q.competition || "PL1";
    const players = listAllPlayers(competitionId);
    return {
      competitionId,
      /** AF season starting year (2025 = 2025/26). */
      season: players[0]?.season ?? undefined,
      players,
    };
  });

  app.get("/api/players/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const player = getPlayerDetail(id);
    if (!player) return reply.code(404).send({ error: `Player ${id} not found` });
    return player;
  });

  app.get("/api/games", async (req) => {
    const q = req.query as { competition?: string; club?: string };
    return {
      competitionId: q.competition || "PL1",
      games: listGames({ competitionId: q.competition || "PL1", clubId: q.club || undefined }),
    };
  });

  app.get("/api/games/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = await getGameDetail(id);
    if (!detail) return reply.code(404).send({ error: `Game ${id} not found` });
    return detail;
  });

  app.get("/api/ref", async () => ({
    categories: listRefCategories().map((c) => ({
      ...c,
      meta: REF_CATEGORY_META[c.category] ?? null,
    })),
  }));

  app.get("/api/ref/:category", async (req) => {
    const category = (req.params as { category: string }).category;
    return {
      category,
      meta: REF_CATEGORY_META[category] ?? null,
      items: listRef(category),
    };
  });
}
