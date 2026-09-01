import { config } from "../config.js";
import { AF_LEAGUES } from "../lib/afLeagues.js";
import { EXPECTED11_XI_LEAGUE_ID } from "./expected11Xi.js";
import { SERIE_A_XI_LEAGUE_ID } from "./serieALineup.js";
import { allSeasonPredictions } from "./predictSeasonXi.js";
import { buildPlayerBoard } from "./playerBoard.js";

const WARMUP_ORDER = [40, 39, 106, 203, 135];

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function scheduleChampionshipXiRebuild(): void {
  setImmediate(() => {
    try {
      const season = config.predictSeason;
      allSeasonPredictions(season, EXPECTED11_XI_LEAGUE_ID, { serveStale: false });
      buildPlayerBoard(season, EXPECTED11_XI_LEAGUE_ID, { serveStale: false });
    } catch (error) {
      console.warn("Championship XI cache rebuild failed", error);
    }
  });
}

export function scheduleSerieAXiRebuild(): void {
  setImmediate(() => {
    try {
      const season = config.predictSeason;
      allSeasonPredictions(season, SERIE_A_XI_LEAGUE_ID, { serveStale: false });
      buildPlayerBoard(season, SERIE_A_XI_LEAGUE_ID, { serveStale: false });
    } catch (error) {
      console.warn("Serie A XI cache rebuild failed", error);
    }
  });
}

export async function warmupXiCaches(): Promise<void> {
  const season = config.predictSeason;
  for (const leagueId of WARMUP_ORDER) {
    const slug =
      Object.values(AF_LEAGUES).find((league) => league.id === leagueId)?.slug ??
      String(leagueId);
    await yieldEventLoop();
    try {
      allSeasonPredictions(season, leagueId);
      await yieldEventLoop();
      buildPlayerBoard(season, leagueId);
      console.log(`xi cache ready: ${slug}`);
    } catch (error) {
      console.warn(`xi cache warmup failed: ${slug}`, error);
    }
  }
}
