import { sorareGame, sorareLeague, type SorareGameRef, type SorarePlayer } from "../clients/sorare.js";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { AF_LEAGUES, leagueById } from "../lib/afLeagues.js";
import { normName } from "../lib/names.js";

const SUPPORTED_LEAGUE_IDS = [39, 40, 203] as const;

const TEAM_ALIASES: Record<number, Record<string, string>> = {
  39: {
    "brighton-hove-albion-brighton-east-sussex": "Brighton",
    "coventry-city-coventry": "Coventry",
    "ipswich-town-ipswich-suffolk": "Ipswich",
    "leeds-united-leeds-west-yorkshire": "Leeds",
    "newcastle-united-newcastle-upon-tyne": "Newcastle",
    "tottenham-hotspur-london": "Tottenham",
  },
  40: {
    "birmingham-city-birmingham": "Birmingham",
    "blackburn-rovers-blackburn-lancashire": "Blackburn",
    "bolton-wanderers-bolton": "Bolton",
    "cardiff-city-cardiff": "Cardiff",
    "charlton-athletic-london-greater-london": "Charlton",
    "derby-county-derby": "Derby",
    "lincoln-city-lincoln-lincolnshire": "Lincoln",
    "norwich-city-norwich-norfolk": "Norwich",
    "preston-north-end-preston": "Preston",
    "queens-park-rangers-london": "QPR",
    "sheffield-united-sheffield": "Sheffield Utd",
    "swansea-city-swansea": "Swansea",
    "west-bromwich-albion-west-bromwich": "West Brom",
    "west-ham-united-london": "West Ham",
    "wolverhampton-wanderers-wolverhampton": "Wolves",
  },
  203: {
    "alanyaspor-alanya": "Alanyaspor",
    "amed-diyarbakir": "Amed",
    "besiktas-istanbul": "Beşiktaş",
    "bb-erzurumspor-erzurum": "Erzurumspor FK",
    "eyupspor-istanbul": "Eyüpspor",
    "gazisehir-gaziantep-gaziantep": "Gaziantep FK",
    "genclerbirligi-ankara": "Gençlerbirliği S.K.",
    "kocaelispor-izmet": "Kocaelispor",
    "samsunspor-samsun": "Samsunspor",
    "trabzonspor-trabzon": "Trabzonspor",
    "konyaspor-konya": "Konyaspor",
    "yeni-corumspor-corum": "Çorum FK",
    "rizespor-rize": "Rizespor",
    "istanbul-basaksehir-istanbul": "Başakşehir",
  },
};

type LocalTeam = { id: number; name: string };
type LocalPlayer = { id: number; name: string };

export type SorareSyncResult = {
  leagueId: number;
  league: string;
  teams: number;
  linkedTeams: number;
  games: number;
  predictions: number;
  linkedPlayers: number;
  fetchedAt: string;
};

export function sorareTeamKey(name: string): string {
  return normName(name)
    .replace(/\b(afc|fk|sk|football club|futbol kulubu|spor kulubu)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function strictUniqueExact<T>(
  values: T[],
  target: string,
  key: (value: T) => string,
): T | null {
  const hits = values.filter((value) => key(value) === target);
  return hits.length === 1 ? hits[0]! : null;
}

function localTeams(leagueId: number): LocalTeam[] {
  return getDb()
    .prepare(
      `SELECT team_id AS id, name
       FROM season_teams
       WHERE season = ? AND league_id = ?
       ORDER BY name`,
    )
    .all(config.predictSeason, leagueId) as LocalTeam[];
}

function saveTeamLink(
  leagueId: number,
  remote: { slug: string; name: string },
  local: LocalTeam | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO sorare_team_links
         (league_id, sorare_slug, sorare_name, af_team_id, af_team_name, mapped_at)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
       ON CONFLICT(league_id, sorare_slug) DO UPDATE SET
         sorare_name = excluded.sorare_name,
         af_team_id = excluded.af_team_id,
         af_team_name = excluded.af_team_name,
         mapped_at = excluded.mapped_at`,
    )
    .run(leagueId, remote.slug, remote.name, local?.id ?? null, local?.name ?? null, local?.id ?? null);
}

function linkedTeamId(leagueId: number, sorareSlug: string | null | undefined): number | null {
  if (!sorareSlug) return null;
  const row = getDb()
    .prepare(
      `SELECT af_team_id AS id FROM sorare_team_links
       WHERE league_id = ? AND sorare_slug = ?`,
    )
    .get(leagueId, sorareSlug) as { id: number | null } | undefined;
  return row?.id ?? null;
}

function localPlayers(teamId: number): LocalPlayer[] {
  return getDb()
    .prepare(
      `SELECT player_id AS id, name
       FROM squad_players
       WHERE season = ? AND team_id = ?`,
    )
    .all(config.predictSeason, teamId) as LocalPlayer[];
}

function savePlayerLink(
  leagueId: number,
  player: SorarePlayer,
  teamSlug: string,
  afTeamId: number | null,
): number | null {
  const local =
    afTeamId == null
      ? null
      : strictUniqueExact(localPlayers(afTeamId), normName(player.displayName), (item) => normName(item.name));
  getDb()
    .prepare(
      `INSERT INTO sorare_player_links
         (league_id, sorare_slug, sorare_name, sorare_team_slug,
          af_player_id, af_team_id, mapped_at)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
       ON CONFLICT(league_id, sorare_slug) DO UPDATE SET
         sorare_name = excluded.sorare_name,
         sorare_team_slug = excluded.sorare_team_slug,
         af_player_id = excluded.af_player_id,
         af_team_id = excluded.af_team_id,
         mapped_at = excluded.mapped_at`,
    )
    .run(
      leagueId,
      player.slug,
      player.displayName,
      teamSlug,
      local?.id ?? null,
      afTeamId,
      local?.id ?? null,
    );
  return local?.id ?? null;
}

function savePrediction(
  leagueId: number,
  game: SorareGameRef,
  player: SorarePlayer,
  afPlayerId: number | null,
  afTeamId: number | null,
  odds: NonNullable<
    Awaited<ReturnType<typeof sorareGame>>["data"]["anyGame"]["playerGameScores"][number]["footballPlayerGameStats"]["footballPlayingStatusOdds"]
  >,
  fetchedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO sorare_player_predictions
         (sorare_game_id, league_id, kickoff, sorare_player_slug,
          af_player_id, af_team_id, starter_prob, substitute_prob,
          non_playing_prob, reliability, provider_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sorare_game_id, sorare_player_slug) DO UPDATE SET
         af_player_id = excluded.af_player_id,
         af_team_id = excluded.af_team_id,
         starter_prob = excluded.starter_prob,
         substitute_prob = excluded.substitute_prob,
         non_playing_prob = excluded.non_playing_prob,
         reliability = excluded.reliability,
         provider_url = excluded.provider_url,
         fetched_at = excluded.fetched_at`,
    )
    .run(
      game.id,
      leagueId,
      game.date,
      player.slug,
      afPlayerId,
      afTeamId,
      odds.starterOddsBasisPoints / 10_000,
      odds.substituteOddsBasisPoints / 10_000,
      odds.nonPlayingOddsBasisPoints / 10_000,
      odds.reliability,
      odds.providerRedirectUrl ?? null,
      fetchedAt,
    );
}

export async function syncSorareLeague(leagueId: number): Promise<SorareSyncResult> {
  const league = leagueById(leagueId);
  if (!league?.sorareCompetitionSlug) throw new Error(`Sorare is not configured for league ${leagueId}`);
  const local = localTeams(leagueId);
  const response = await sorareLeague(league.sorareCompetitionSlug, true);
  const competition = response.data.football.competition;

  let linkedTeams = 0;
  for (const team of competition.clubs.nodes) {
    const alias = TEAM_ALIASES[leagueId]?.[team.slug];
    const match = strictUniqueExact(
      local,
      sorareTeamKey(alias ?? team.name),
      (item) => sorareTeamKey(item.name),
    );
    if (match) linkedTeams++;
    saveTeamLink(leagueId, team, match);
  }

  let predictions = 0;
  const linkedPlayerIds = new Set<number>();
  const games = competition.futureGames.nodes.filter(
    (game) => Date.parse(game.date) <= Date.now() + 14 * 24 * 60 * 60_000,
  ).slice(0, 10);
  for (const game of games) {
    const detail = await sorareGame(game.id, true);
    for (const row of detail.data.anyGame.playerGameScores) {
      const player = row.footballPlayer;
      const teamSlug = player.activeClub?.slug ?? "";
      const afTeamId = linkedTeamId(leagueId, teamSlug);
      const afPlayerId = savePlayerLink(leagueId, player, teamSlug, afTeamId);
      if (afPlayerId != null) linkedPlayerIds.add(afPlayerId);
      const odds = row.footballPlayerGameStats.footballPlayingStatusOdds;
      if (!odds) continue;
      savePrediction(leagueId, game, player, afPlayerId, afTeamId, odds, detail.fetchedAt);
      predictions++;
    }
  }

  getDb()
    .prepare(
      `DELETE FROM sorare_player_predictions
       WHERE league_id = ? AND datetime(kickoff) < datetime('now', '-1 day')`,
    )
    .run(leagueId);

  return {
    leagueId,
    league: league.name,
    teams: competition.clubs.nodes.length,
    linkedTeams,
    games: games.length,
    predictions,
    linkedPlayers: linkedPlayerIds.size,
    fetchedAt: new Date().toISOString(),
  };
}

export async function syncSorareAll(): Promise<SorareSyncResult[]> {
  const results: SorareSyncResult[] = [];
  for (const leagueId of SUPPORTED_LEAGUE_IDS) {
    results.push(await syncSorareLeague(leagueId));
  }
  return results;
}

let poller: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const result = await syncSorareAll();
    console.log("Sorare sync", JSON.stringify(result));
  } catch (error) {
    console.error("Sorare sync failed", error);
  } finally {
    polling = false;
  }
}

export function startSorarePoller(): void {
  if (poller) return;
  setTimeout(() => void poll(), 5_000);
  poller = setInterval(() => void poll(), config.sorarePollIntervalMs);
  poller.unref?.();
}

export const SORARE_LEAGUE_IDS = SUPPORTED_LEAGUE_IDS;

export function sorareConfiguredLeagues() {
  return SUPPORTED_LEAGUE_IDS.map((id) => AF_LEAGUES[id]);
}
