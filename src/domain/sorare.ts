import {
  sorareGame,
  sorareLeague,
  sorareTeam,
  sorareTeamProfile,
  peekSorareCache,
  type SorareFormation,
  type SorareGamePayload,
  type SorareGameRef,
  type SorarePlayer,
  type SorarePlayingStatusOdds,
} from "../clients/sorare.js";
import { getDb } from "../db/index.js";
import { leagueById, leagueBySlug } from "../lib/afLeagues.js";
import { SORARE_LEAGUE_IDS } from "../sync/syncSorare.js";

type TeamLink = {
  sorareSlug: string;
  sorareName: string;
  afTeamId: number | null;
  afTeamName: string | null;
};

type LocalOddsRow = {
  fixtureId: number;
  kickoff: string | null;
  homeOdd: number;
  drawOdd: number;
  awayOdd: number;
  bookmaker: string | null;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  homeCsProb: number | null;
  awayCsProb: number | null;
  homeScoreProb: number | null;
  awayScoreProb: number | null;
};

function teamLink(leagueId: number, sorareSlug: string | null | undefined): TeamLink | null {
  if (!sorareSlug) return null;
  return (
    (getDb()
      .prepare(
        `SELECT sorare_slug AS sorareSlug, sorare_name AS sorareName,
                af_team_id AS afTeamId, af_team_name AS afTeamName
         FROM sorare_team_links
         WHERE league_id = ? AND sorare_slug = ?`,
      )
      .get(leagueId, sorareSlug) as TeamLink | undefined) ?? null
  );
}

function bookmakerOdds(leagueId: number, game: SorareGameRef): LocalOddsRow | null {
  const home = teamLink(leagueId, game.homeTeam?.slug);
  const away = teamLink(leagueId, game.awayTeam?.slug);
  if (home?.afTeamId == null || away?.afTeamId == null) return null;
  return (
    (getDb()
      .prepare(
        `SELECT o.fixture_id AS fixtureId, o.kickoff,
                o.home_odd AS homeOdd, o.draw_odd AS drawOdd, o.away_odd AS awayOdd,
                o.bookmaker,
                o.home_win_prob AS homeWinProb, o.draw_prob AS drawProb,
                o.away_win_prob AS awayWinProb,
                o.home_cs_prob AS homeCsProb, o.away_cs_prob AS awayCsProb,
                o.home_score_prob AS homeScoreProb, o.away_score_prob AS awayScoreProb
         FROM fixture_odds o
         JOIN fixtures f ON f.id = o.fixture_id
         WHERE o.league_id = ?
           AND f.home_team_id = ? AND f.away_team_id = ?
         ORDER BY ABS(julianday(COALESCE(o.kickoff, f.date)) - julianday(?))
         LIMIT 1`,
      )
      .get(leagueId, home.afTeamId, away.afTeamId, game.date) as LocalOddsRow | undefined) ?? null
  );
}

export function basisPointsToProbability(value: number | null | undefined): number | null {
  return value == null ? null : value / 10_000;
}

export function sorarePlayingProbability(odds: SorarePlayingStatusOdds | null | undefined) {
  if (!odds) return null;
  return {
    starter: basisPointsToProbability(odds.starterOddsBasisPoints)!,
    substitute: basisPointsToProbability(odds.substituteOddsBasisPoints)!,
    nonPlaying: basisPointsToProbability(odds.nonPlayingOddsBasisPoints)!,
    reliability: odds.reliability,
    providerUrl: odds.providerRedirectUrl ?? null,
  };
}

export function buildSorareExpectedXi(players: SorarePlayer[]) {
  const withOdds = players
    .map((player) => ({ player, prediction: sorarePlayingProbability(player.nextClassicFixturePlayingStatusOdds) }))
    .filter((item): item is { player: SorarePlayer; prediction: NonNullable<ReturnType<typeof sorarePlayingProbability>> } =>
      Boolean(item.prediction),
    );
  const quotas: Record<string, number> = {
    Goalkeeper: 1,
    Defender: 4,
    Midfielder: 3,
    Forward: 3,
  };
  const selected: typeof withOdds = [];
  for (const [position, count] of Object.entries(quotas)) {
    selected.push(
      ...withOdds
        .filter((item) => item.player.position === position)
        .sort((a, b) => b.prediction.starter - a.prediction.starter)
        .slice(0, count),
    );
  }
  if (selected.length < 11) {
    const selectedSlugs = new Set(selected.map((item) => item.player.slug));
    selected.push(
      ...withOdds
        .filter((item) => !selectedSlugs.has(item.player.slug))
        .sort((a, b) => b.prediction.starter - a.prediction.starter)
        .slice(0, 11 - selected.length),
    );
  }
  return selected.map(({ player, prediction }) => ({
    slug: player.slug,
    name: player.displayName,
    position: player.position,
    pictureUrl: player.pictureUrl || player.squaredPictureUrl || null,
    ...prediction,
  }));
}

function formationJson(formation: SorareFormation) {
  return {
    available: formation.startingLineupAvailable,
    rows: formation.startingLineup.map((row) =>
      row.map((player) => ({
        slug: player.slug,
        name: player.displayName,
        position: player.position,
        pictureUrl: player.pictureUrl || player.squaredPictureUrl || null,
      })),
    ),
    bench: formation.bench.map((player) => ({
      slug: player.slug,
      name: player.displayName,
      position: player.position,
      pictureUrl: player.pictureUrl || player.squaredPictureUrl || null,
    })),
  };
}

export function listSorareLeagues() {
  return SORARE_LEAGUE_IDS.map((leagueId) => {
    const league = leagueById(leagueId)!;
    const counts = getDb()
      .prepare(
        `SELECT COUNT(*) AS teams,
                SUM(CASE WHEN af_team_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
         FROM sorare_team_links WHERE league_id = ?`,
      )
      .get(leagueId) as { teams: number; linked: number | null };
    return {
      id: league.slug,
      name: league.name,
      afLeagueId: league.id,
      sorareCompetitionSlug: league.sorareCompetitionSlug,
      teams: counts.teams,
      linkedTeams: counts.linked ?? 0,
    };
  });
}

export async function getSorareLeagueView(leagueSlug: string) {
  const league = leagueBySlug(leagueSlug);
  if (!league || !SORARE_LEAGUE_IDS.includes(league.id as (typeof SORARE_LEAGUE_IDS)[number])) return null;
  const response = await sorareLeague(league.sorareCompetitionSlug!);
  const competition = response.data.football.competition;
  return {
    league: {
      id: league.slug,
      name: league.name,
      afLeagueId: league.id,
      sorareCompetitionSlug: competition.slug,
      displayName: competition.displayName,
      pictureUrl: competition.pictureUrl ?? null,
    },
    teams: competition.clubs.nodes.map((team) => ({
      ...team,
      link: teamLink(league.id, team.slug),
    })),
    games: competition.futureGames.nodes.map((game) => ({
      ...game,
      homeLink: teamLink(league.id, game.homeTeam?.slug),
      awayLink: teamLink(league.id, game.awayTeam?.slug),
      bookmakerOdds: bookmakerOdds(league.id, game),
    })),
    fetchedAt: response.fetchedAt,
    stale: response.stale,
  };
}

export async function getSorareTeamView(leagueSlug: string, teamSlug: string) {
  const league = leagueBySlug(leagueSlug);
  if (!league || !SORARE_LEAGUE_IDS.includes(league.id as (typeof SORARE_LEAGUE_IDS)[number])) return null;
  const leagueResponse = await sorareLeague(league.sorareCompetitionSlug!);
  const fixture = leagueResponse.data.football.competition.futureGames.nodes.find(
    (game) => game.homeTeam?.slug === teamSlug || game.awayTeam?.slug === teamSlug,
  );
  const gameSnapshot = fixture
    ? peekSorareCache<SorareGamePayload>(`game:${fixture.id}`)
    : null;
  const response = gameSnapshot
    ? await sorareTeamProfile(teamSlug)
    : await sorareTeam(teamSlug);
  const team = response.data.football.club;
  if (gameSnapshot) {
    team.activePlayers.nodes = gameSnapshot.data.anyGame.playerGameScores
      .filter((row) => row.footballPlayer.activeClub?.slug === teamSlug)
      .map((row) => ({
        ...row.footballPlayer,
        nextClassicFixturePlayingStatusOdds:
          row.footballPlayerGameStats.footballPlayingStatusOdds ?? null,
      }));
  }
  return {
    league: { id: league.slug, name: league.name, afLeagueId: league.id },
    team: {
      name: team.name,
      slug: team.slug,
      officialName: team.officialName,
      shortName: team.shortName,
      founded: team.founded ?? null,
      ranking: team.domesticLeagueRanking ?? null,
      country: team.country,
      pictureUrl: team.pictureUrl ?? null,
      link: teamLink(league.id, team.slug),
    },
    players: team.activePlayers.nodes
      .map((player) => ({
        slug: player.slug,
        name: player.displayName,
        position: player.position,
        shirtNumber: player.shirtNumber ?? null,
        pictureUrl: player.pictureUrl || player.squaredPictureUrl || null,
        prediction: sorarePlayingProbability(player.nextClassicFixturePlayingStatusOdds),
      }))
      .sort(
        (a, b) =>
          (b.prediction?.starter ?? -1) - (a.prediction?.starter ?? -1) ||
          a.name.localeCompare(b.name),
      ),
    expectedXi: buildSorareExpectedXi(team.activePlayers.nodes),
    upcomingGames: team.upcomingGames.map((game) => ({
      ...game,
      bookmakerOdds: bookmakerOdds(league.id, game),
    })),
    latestGames: team.latestGames.nodes,
    fetchedAt: response.fetchedAt,
    stale: response.stale,
  };
}

export async function getSorareTeamViewByAf(leagueId: number, afTeamId: number) {
  const league = leagueById(leagueId);
  if (!league) return null;
  const link = getDb()
    .prepare(
      `SELECT sorare_slug AS slug FROM sorare_team_links
       WHERE league_id = ? AND af_team_id = ?`,
    )
    .get(leagueId, afTeamId) as { slug: string } | undefined;
  if (!link) return null;
  return getSorareTeamView(league.slug, link.slug);
}

export async function getSorareGameView(leagueSlug: string, gameId: string) {
  const league = leagueBySlug(leagueSlug);
  if (!league || !SORARE_LEAGUE_IDS.includes(league.id as (typeof SORARE_LEAGUE_IDS)[number])) return null;
  const response = await sorareGame(gameId);
  const game = response.data.anyGame;
  const players = game.playerGameScores.map((row) => {
    const player = row.footballPlayer;
    return {
      slug: player.slug,
      name: player.displayName,
      position: player.position,
      pictureUrl: player.pictureUrl || player.squaredPictureUrl || null,
      team: player.activeClub ?? null,
      prediction: sorarePlayingProbability(row.footballPlayerGameStats.footballPlayingStatusOdds),
    };
  });
  const sorareOdds = {
    home: game.homeStats?.winOddsBasisPoints != null ? game.homeStats.winOddsBasisPoints / 10_000 : null,
    draw: game.homeStats?.drawOddsBasisPoints != null ? game.homeStats.drawOddsBasisPoints / 10_000 : null,
    away: game.homeStats?.loseOddsBasisPoints != null ? game.homeStats.loseOddsBasisPoints / 10_000 : null,
  };
  return {
    game: {
      id: game.id,
      date: game.date,
      status: game.statusTyped,
      competition: game.competition,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
    },
    players,
    homeFormation: formationJson(game.homeFormation),
    awayFormation: formationJson(game.awayFormation),
    bookmakerOdds: bookmakerOdds(league.id, game),
    sorareOdds,
    fetchedAt: response.fetchedAt,
    stale: response.stale,
  };
}

export type SorareAfPrediction = {
  starterProbability: number;
  substituteProbability: number;
  reliability: string | null;
  kickoff: string;
};

export function sorarePredictionsForAfPlayers(
  leagueId: number,
  afPlayerIds: number[],
): Map<number, SorareAfPrediction> {
  const unique = [...new Set(afPlayerIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT af_player_id AS afPlayerId,
              starter_prob AS starterProbability,
              substitute_prob AS substituteProbability,
              reliability, kickoff
       FROM sorare_player_predictions
       WHERE league_id = ? AND af_player_id IN (${placeholders})
         AND datetime(kickoff) >= datetime('now', '-2 hours')
         AND datetime(fetched_at) >= datetime('now', '-12 hours')
       ORDER BY datetime(kickoff)`,
    )
    .all(leagueId, ...unique) as Array<SorareAfPrediction & { afPlayerId: number }>;
  const map = new Map<number, SorareAfPrediction>();
  for (const row of rows) {
    if (map.has(row.afPlayerId)) continue;
    map.set(row.afPlayerId, {
      starterProbability: row.starterProbability,
      substituteProbability: row.substituteProbability,
      reliability: row.reliability,
      kickoff: row.kickoff,
    });
  }
  return map;
}

export function sorarePredictionForAfPlayer(
  leagueId: number,
  afPlayerId: number,
): SorareAfPrediction | null {
  return sorarePredictionsForAfPlayers(leagueId, [afPlayerId]).get(afPlayerId) ?? null;
}
