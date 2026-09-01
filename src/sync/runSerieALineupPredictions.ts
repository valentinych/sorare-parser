import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSerieALineupSnapshot,
  parseFantacalcioArticle,
  type SerieALineupImportResult,
} from "../domain/serieALineup.js";
import { sorareInsideSnapshot } from "../domain/serieASorareInside.js";
import { allSeasonPredictions } from "../domain/predictSeasonXi.js";
import { buildPlayerBoard } from "../domain/playerBoard.js";
import { config } from "../config.js";
import { SERIE_A_XI_LEAGUE_ID } from "../domain/serieALineup.js";

const FANTACALCIO_URL =
  "https://www.fantacalcio.it/news/calcio-italia/06_08_2026/asta-fantacalcio-le-probabili-formazioni-della-serie-a-enilive-2026-27-495558";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "data", "serie-a-xi");

async function fetchFantacalcioHtml(): Promise<string> {
  const response = await fetch(FANTACALCIO_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new Error(`fantacalcio_fetch_failed:${response.status}`);
  }
  return response.text();
}

function logResult(label: string, result: SerieALineupImportResult): void {
  console.log(
    `${label}: clubs=${result.clubs} players=${result.players} linked=${result.linked} unmatched=${result.unmatched} ambiguous=${result.ambiguous} clubLinked=${result.clubLinked} clubUnmatched=${result.clubUnmatched}`,
  );
  const sample = result.unmatchedPlayers.slice(0, 12);
  if (sample.length) {
    console.log(
      `  unmatched sample: ${sample.map((row) => `${row.club}: ${row.name}`).join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const html = await fetchFantacalcioHtml();
  const extractedAt = "2026-08-06T00:00:00.000Z";
  const fantacalcio = parseFantacalcioArticle(html, extractedAt);
  const asides = [...html.matchAll(/<aside class="text-type-aside">[\s\S]*?<\/aside>/gi)]
    .map((match) => match[0]!)
    .join("\n");
  await writeFile(path.join(outDir, "fantacalcio-asides.html"), asides);
  await writeFile(
    path.join(outDir, "fantacalcio-2026-08-06.json"),
    JSON.stringify(fantacalcio, null, 2),
  );
  const sorareinside = sorareInsideSnapshot();
  await writeFile(
    path.join(outDir, "sorareinside-screenshots.json"),
    JSON.stringify(sorareinside, null, 2),
  );

  const fc = importSerieALineupSnapshot(fantacalcio);
  logResult("fantacalcio", fc);
  const si = importSerieALineupSnapshot(sorareinside);
  logResult("sorareinside", si);

  allSeasonPredictions(config.predictSeason, SERIE_A_XI_LEAGUE_ID, { serveStale: false });
  buildPlayerBoard(config.predictSeason, SERIE_A_XI_LEAGUE_ID, { serveStale: false });
  console.log("serie-a XI cache rebuilt");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
