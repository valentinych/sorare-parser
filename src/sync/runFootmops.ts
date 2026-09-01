import {
  ensureFootmopsImported,
  importFootmopsSnapshot,
  readChampionshipTour2Snapshot,
  type FootmopsImportResult,
} from "../domain/footmops.js";

function logResult(result: FootmopsImportResult): void {
  console.log(
    `footmops ${result.league} t${result.tour}: clubs=${result.clubs} players=${result.players} linked=${result.linked} unmatched=${result.unmatched} ambiguous=${result.ambiguous}`,
  );
  const sample = result.unmatchedPlayers.slice(0, 20);
  if (sample.length) {
    console.log(
      `  unmatched sample: ${sample
        .map((row) => `${row.club}: ${row.name} ${row.percentage}%`)
        .join("; ")}`,
    );
  }
}

function main(): void {
  const snapshot = readChampionshipTour2Snapshot();
  const result = importFootmopsSnapshot(snapshot);
  logResult(result);
  const skipped = ensureFootmopsImported();
  if (skipped) logResult(skipped);
}

main();
