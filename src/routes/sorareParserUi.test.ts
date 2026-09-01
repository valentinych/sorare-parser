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
  assert.match(captureFn, /Expanding league to click \$\{team\.teamName\}/);
  assert.match(captureFn, /\/api\/sorare\/status/);
  assert.doesNotMatch(captureFn, /Capturing \$\{team\.teamName\} →/);
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
  assert.match(src, /Scrolling expanded \$\{league.competitionName\} for \$\{teamName\}/);
  assert.match(src, /Expanding \$\{league.competitionName\}/);
  assert.doesNotMatch(src, /Scrolling to load \$\{teamName\} before capture/);
  assert.match(src, /Scrolling lineup popup to the bottom to load all content/);
  assert.match(src, /Scroll did not settle after \$\{maxPasses\} passes/);
  assert.match(src, /SI_SPINNER_SELECTOR/);
  assert.match(src, /Timed out after 25s waiting for lineup content/);
  assert.doesNotMatch(src, /\[role='progressbar'\]/);
  assert.doesNotMatch(src, /Timed out after 90s/);
  const captureStart = src.indexOf("async capture(body: unknown)");
  const captureEnd = src.indexOf("let sharedSession");
  assert.ok(captureStart > 0 && captureEnd > captureStart);
  const captureFn = src.slice(captureStart, captureEnd);
  assert.match(captureFn, /expandLeagueAccordion/);
  assert.match(captureFn, /scrollToLoadLazyContent/);
  assert.match(captureFn, /untilText: teamName/);
  assert.doesNotMatch(captureFn, /scrollLineupsPageToLoadAll/);
  assert.doesNotMatch(captureFn, /getByPlaceholder/);
});

test("SorareInside capture clicks the lineups match after expanding the league", async () => {
  const src = await readFile(
    new URL("../sync/sorareInsideLineups.ts", import.meta.url),
    "utf8",
  );
  const clickStart = src.indexOf("private async clickMatchOnLineupsList");
  const clickEnd = src.indexOf("private leagueAccordionNeedles");
  assert.ok(clickStart > 0 && clickEnd > clickStart);
  const clickFn = src.slice(clickStart, clickEnd);
  assert.match(src, /LINEUP_TEAM_LABELS_MATCH_SOURCE/);
  assert.match(clickFn, /lineupsTeamCardPresent/);
  assert.match(clickFn, /Clicking \$\{teamName\} on the lineups list/);
  assert.match(clickFn, /No clickable "\$\{teamName\}" match on the lineups list/);
  assert.match(clickFn, /clickVisibleMatchRow/);
  assert.match(clickFn, /getByText/);
  assert.doesNotMatch(clickFn, /getByPlaceholder/);
  assert.doesNotMatch(clickFn, /data-combobox-option/);
  assert.doesNotMatch(clickFn, /Select from/);
  assert.doesNotMatch(clickFn, /select\.fill/);
  assert.doesNotMatch(clickFn, /team select has no matching option/);
  assert.doesNotMatch(clickFn, /\.click\(\{ timeout: 8_000 \}\)/);
  assert.doesNotMatch(src, /private async clickTeamToOpenPopup/);
});
