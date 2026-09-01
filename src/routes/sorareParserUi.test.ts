import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Sorare parser UI keeps Matches stable after capture and exposes a folder picker", async () => {
  const html = await readFile(
    new URL("../../public-expected11/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="sorare-output-dir"/);
  assert.match(html, /id="sorare-pick-folder"/);
  assert.match(html, /Choose folder/);
  assert.match(html, /function markSorareSideCaptured/);
  assert.match(html, /localStorage\.setItem\(SORARE_OUTPUT_DIR_KEY/);
  assert.match(html, /\/api\/sorare\/pick-folder/);
  assert.match(html, /\/api\/sorare\/output-dir/);
  const captureStart = html.indexOf("async function captureSorareSide");
  const captureEnd = html.indexOf("async function refreshSorareStatus");
  assert.ok(captureStart > 0 && captureEnd > captureStart);
  const captureFn = html.slice(captureStart, captureEnd);
  assert.match(captureFn, /markSorareSideCaptured\(btn/);
  assert.doesNotMatch(captureFn, /renderSorareMatches/);
  assert.doesNotMatch(captureFn, /\/api\/sorare\/matches/);
});

test("SorareInside session scrolls the lineups page before capture", async () => {
  const src = await readFile(
    new URL("../sync/sorareInsideLineups.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /scrollLineupsPageToLoadAll/);
  assert.match(src, /Scrolling lineups to the bottom to load all matches/);
  assert.match(src, /scrollToLoadLazyContent/);
  assert.match(src, /Scrolling to load \$\{teamName\} before capture/);
  assert.match(src, /Scrolling lineup popup to the bottom to load all content/);
  assert.match(src, /Scroll did not settle after \$\{maxPasses\} passes/);
  const captureStart = src.indexOf("async capture(body: unknown)");
  const captureEnd = src.indexOf("function escapeRegExp");
  assert.ok(captureStart > 0 && captureEnd > captureStart);
  const captureFn = src.slice(captureStart, captureEnd);
  assert.match(captureFn, /expandLeagueAccordion/);
  assert.match(captureFn, /scrollToLoadLazyContent/);
  assert.match(captureFn, /untilText: teamName/);
});
