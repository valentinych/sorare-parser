import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { allPredictedXi, predictedXi } from "../domain/predictedXi.js";
import { allSeasonPredictions, predictSeasonXi } from "../domain/predictSeasonXi.js";
import {
  EXPECTED11_XI_LEAGUE_ID,
  expected11SnapshotVersion,
} from "../domain/expected11Xi.js";
import { buildPlayerBoard, listMantraLeagues } from "../domain/playerBoard.js";
import { listLiveDraftSquads } from "../domain/liveDraftOwnership.js";
import {
  getManagerTeamView,
  getSquadBuilderTeamView,
  listFantasyTeams,
} from "../domain/managerTeam.js";
import { topBoard, topByPosition, type PositionGroup } from "../domain/topByPosition.js";
import { AF_LEAGUES, leagueById, uiLeagues } from "../lib/afLeagues.js";
import { allBuilderLeagues } from "../lib/liveLeagues.js";

const POSITIONS = new Set(["GK", "DEF", "MID", "ATT"]);

function teamsForSeason(season: number, leagueId: number) {
  return getDb()
    .prepare(
      `SELECT team_id AS id, name, code, logo FROM season_teams
       WHERE season = ? AND (league_id = ? OR (league_id IS NULL AND ? = 106))
       ORDER BY name`,
    )
    .all(season, leagueId, leagueId);
}

export async function ekstraklasaRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    leagueId: config.leagueId,
    season: config.season,
    predictSeason: config.predictSeason,
    leagues: Object.values(AF_LEAGUES),
  }));

  app.get("/af/leagues", async () => ({
    leagues: uiLeagues().map((l) => ({
      ...l,
      seasons: [config.predictSeason],
      defaultSeason: config.predictSeason,
      source: "af" as const,
      path: l.slug,
      id: l.slug,
      afLeagueId: l.id,
    })),
    predictSeason: config.predictSeason,
    historySeason: config.season,
  }));

  app.get("/builder/leagues", async () => ({
    leagues: allBuilderLeagues().map((l) => ({
      slug: l.slug,
      name: l.name,
      afId: l.id,
      tmCompetition: l.tmCompetition,
      fotmobLeagueId: l.fotmobLeagueId,
      mantraTournamentId: l.mantraTournamentId,
      divisions: l.mantraDivisions.length,
    })),
  }));

  app.get("/mantra/fantasy-teams", async (req) => {
    const q = req.query as { tournamentId?: string; leagueId?: string };
    const tournamentId = q.tournamentId != null ? Number(q.tournamentId) : 18;
    const leagueId = q.leagueId != null ? Number(q.leagueId) : undefined;
    const teams = listFantasyTeams({
      tournamentId: Number.isFinite(tournamentId) ? tournamentId : 18,
      leagueId: leagueId != null && Number.isFinite(leagueId) ? leagueId : undefined,
    });
    const leagues = [
      ...(tournamentId === 2 ? listLiveDraftSquads() : []),
      ...listMantraLeagues(Number.isFinite(tournamentId) ? tournamentId : 18),
    ];
    return { tournamentId, leagues, teams };
  });

  app.get("/mantra/fantasy-teams/:teamId", async (req, reply) => {
    const teamId = Number((req.params as { teamId: string }).teamId);
    const q = req.query as { afLeagueId?: string; round?: string };
    if (!Number.isFinite(teamId)) return reply.code(400).send({ error: "bad teamId" });
    const afLeagueId =
      q.afLeagueId != null && Number.isFinite(Number(q.afLeagueId))
        ? Number(q.afLeagueId)
        : 106;
    const round =
      q.round != null && q.round !== "" && Number.isFinite(Number(q.round))
        ? Number(q.round)
        : null;
    const view = getManagerTeamView(teamId, afLeagueId, round);
    if (!view) return reply.code(404).send({ error: "Fantasy team not found — run npm run sync:mantra -- --teams-only" });
    return view;
  });

  app.get("/mantra/squad-builder/:teamId", async (req, reply) => {
    const teamId = Number((req.params as { teamId: string }).teamId);
    if (!Number.isFinite(teamId)) return reply.code(400).send({ error: "bad teamId" });
    const view = getSquadBuilderTeamView(teamId);
    if (!view) return reply.code(404).send({ error: "Fantasy team not found" });
    return view;
  });

  app.get("/mantra/image", async (req, reply) => {
    const rawUrl = (req.query as { url?: string }).url;
    if (!rawUrl) return reply.code(400).send({ error: "missing image url" });
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reply.code(400).send({ error: "bad image url" });
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mantrafootball.s3.eu-west-1.amazonaws.com" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return reply.code(400).send({ error: "image host not allowed" });
    }
    const image = await fetch(url);
    const contentType = image.headers.get("content-type") ?? "";
    const contentLength = Number(image.headers.get("content-length") ?? 0);
    if (
      !image.ok ||
      !contentType.startsWith("image/") ||
      (contentLength > 0 && contentLength > 5_000_000)
    ) {
      return reply.code(502).send({ error: "image unavailable" });
    }
    const body = Buffer.from(await image.arrayBuffer());
    if (body.length > 5_000_000) {
      return reply.code(502).send({ error: "image too large" });
    }
    return reply
      .header("Cache-Control", "public, max-age=86400")
      .type(contentType)
      .send(body);
  });

  // Generic AF league routes: /premier-league/2026/... and /ekstraklasa/2026/...
  for (const league of Object.values(AF_LEAGUES)) {
    registerLeagueRoutes(app, league.slug, league.id);
  }
}

function registerLeagueRoutes(app: FastifyInstance, slug: string, leagueId: number) {
  app.get(`/${slug}/:season/meta`, async (req) => {
    const season = Number((req.params as { season: string }).season);
    const db = getDb();
    const seasonTeams = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM season_teams
           WHERE season = ? AND (league_id = ? OR (league_id IS NULL AND ? = 106))`,
        )
        .get(season, leagueId, leagueId) as { n: number }
    ).n;
    const squads = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM squad_players sp
           JOIN season_teams st ON st.season = sp.season AND st.team_id = sp.team_id
           WHERE sp.season = ? AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))`,
        )
        .get(season, leagueId, leagueId) as { n: number }
    ).n;
    const stats = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM player_stats ps
           WHERE ps.season = ? AND ps.team_id IN (
             SELECT team_id FROM season_teams
             WHERE season = ? AND (league_id = ? OR (league_id IS NULL AND ? = 106))
           )`,
        )
        .get(config.season, season, leagueId, leagueId) as { n: number }
    ).n;
    const values = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM player_values
           WHERE team_id IN (
             SELECT team_id FROM season_teams
             WHERE season = ? AND (league_id = ? OR (league_id IS NULL AND ? = 106))
           )`,
        )
        .get(season, leagueId, leagueId) as { n: number }
    ).n;
    return {
      season,
      leagueId,
      slug,
      counts: { seasonTeams, squads, stats, values },
    };
  });

  app.get(`/${slug}/:season/teams`, async (req, reply) => {
    const season = Number((req.params as { season: string }).season);
    const rows = teamsForSeason(season, leagueId);
    if (rows.length === 0 && season === config.season && leagueId === 106) {
      return getDb().prepare(`SELECT id, name, code, logo FROM teams ORDER BY name`).all();
    }
    if (rows.length === 0) {
      return reply.code(404).send({
        error: `No teams for ${slug} season ${season}. Run: npm run sync -- --predict-only --league=${leagueId}`,
      });
    }
    return rows;
  });

  app.get(`/${slug}/:season/teams/:teamId/predicted-xi`, async (req, reply) => {
    const { season, teamId } = req.params as { season: string; teamId: string };
    const s = Number(season);
    const id = Number(teamId);

    if (s === config.predictSeason) {
      reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
      const xi = predictSeasonXi(id, { season: s, leagueId });
      if (!xi) return reply.code(404).send({ error: "Team not found for predict season" });
      return xi;
    }

    if (leagueId !== 106) {
      return reply.code(404).send({ error: "Historical lineup XI only for Ekstraklasa" });
    }
    const xi = predictedXi(id);
    if (!xi) return reply.code(404).send({ error: "Team not found" });
    return xi;
  });

  app.get(`/${slug}/:season/predicted-xi`, async (req, reply) => {
    const s = Number((req.params as { season: string }).season);
    if (s === config.predictSeason) {
      reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
      return allSeasonPredictions(s, leagueId);
    }
    if (s === config.season && leagueId === 106) return allPredictedXi();
    return reply.code(404).send({ error: `Unsupported season ${s}` });
  });

  app.get(`/${slug}/:season/board`, async (req, reply) => {
    const season = Number((req.params as { season: string }).season);
    if (season !== config.predictSeason && season !== config.season) {
      return reply.code(404).send({ error: `Unsupported season ${season}` });
    }
    const target = season === config.predictSeason ? season : config.predictSeason;
    const players = buildPlayerBoard(target, leagueId);
    reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    const mantraTournamentId = leagueById(leagueId)?.mantraTournamentId ?? null;
    const mantraAvailable = mantraTournamentId != null;
    const mantraCount = mantraAvailable
      ? (
          getDb()
            .prepare(
              `SELECT COUNT(*) AS n FROM mantra_players
               WHERE tournament_id = ? OR (tournament_id IS NULL AND ? = 18)`,
            )
            .get(mantraTournamentId, mantraTournamentId) as { n: number }
        ).n
      : 0;
    const mantraProfiles = mantraAvailable
      ? (
          getDb()
            .prepare(
              `SELECT COUNT(*) AS n FROM mantra_players
               WHERE (tournament_id = ? OR (tournament_id IS NULL AND ? = 18))
                 AND profile_synced_at IS NOT NULL`,
            )
            .get(mantraTournamentId, mantraTournamentId) as { n: number }
        ).n
      : 0;
    return {
      season: target,
      leagueId,
      slug,
      mantraAvailable,
      counts: {
        players: players.length,
        starters: players.filter((p) => p.xiStatus === "starter").length,
        backups: players.filter((p) => p.xiStatus === "backup").length,
        mantra: mantraCount,
        mantraProfiles,
        mantraMatched: players.filter((p) => p.mantra).length,
      },
      mantraLeagues: [
        ...(leagueId === 39 ? listLiveDraftSquads() : []),
        ...(mantraAvailable ? listMantraLeagues(mantraTournamentId) : []),
      ],
      expected11SnapshotVersion:
        leagueId === EXPECTED11_XI_LEAGUE_ID
          ? expected11SnapshotVersion()
          : null,
      players,
    };
  });

  if (slug === "ekstraklasa") {
    app.get(`/${slug}/:season/top/:position`, async (req, reply) => {
      const { season, position } = req.params as { season: string; position: string };
      const query = req.query as { teamId?: string; limit?: string };
      const pos = position.toUpperCase();
      if (!POSITIONS.has(pos)) {
        return reply.code(400).send({ error: "position must be GK|DEF|MID|ATT" });
      }
      if (Number(season) !== config.season) {
        return reply
          .code(400)
          .send({ error: `top endpoints use historical stats season ${config.season}` });
      }
      return topByPosition({
        position: pos as PositionGroup,
        teamId: query.teamId ? Number(query.teamId) : undefined,
        limit: query.limit ? Number(query.limit) : 10,
      });
    });

    app.get(`/${slug}/:season/top`, async (req, reply) => {
      const season = Number((req.params as { season: string }).season);
      const query = req.query as { limit?: string };
      if (season !== config.season) {
        return reply
          .code(400)
          .send({ error: `top endpoints use historical stats season ${config.season}` });
      }
      return topBoard(query.limit ? Number(query.limit) : 5);
    });
  }
}
