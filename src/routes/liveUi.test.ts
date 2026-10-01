import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Live dropdown is driven by /live/leagues and the six slugs", async () => {
  const [app, html, i18n, core] = await Promise.all([
    readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/core.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="competition-select"/);
  assert.match(app, /fetch\("\/live\/leagues"\)/);
  assert.match(app, /function liveSelectCompetitions/);
  assert.match(app, /\/live\?/);
  assert.match(app, /"premier-league"/);
  assert.match(app, /"championship"/);
  assert.match(app, /"super-lig"/);
  assert.match(app, /"ekstraklasa"/);
  assert.match(app, /"serie-a"/);
  assert.match(app, /"bundesliga"/);
  assert.match(app, /tmCompetition: "GB1"/);
  assert.match(app, /tmCompetition: "GB2"/);
  assert.match(app, /tmCompetition: "TR1"/);
  assert.match(app, /tmCompetition: "PL1"/);
  assert.match(app, /tmCompetition: "IT1"/);
  assert.match(app, /tmCompetition: "L1"/);
  assert.match(i18n, /Премьер-лига/);
  assert.match(i18n, /Чемпионшип/);
  assert.match(i18n, /Суперлига/);
  assert.match(i18n, /Экстракласса/);
  assert.match(i18n, /Серия А/);
  assert.match(i18n, /Бундеслига/);
  assert.match(core, /championship: "Чемпионшип"/);
  assert.match(core, /"serie-a": "Серия А"/);
  assert.match(core, /bundesliga: "Бундеслига"/);
  assert.match(app, /liveClientTimer = setInterval/);
  assert.match(app, /5 \* 60 \* 1000/);
});

test("Live league dropdown uses header Latin names and slug option values", async () => {
  const app = await readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8");
  const boot = await readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8");
  assert.match(app, /"Premier League"/);
  assert.match(app, /"Championship"/);
  assert.match(app, /"Süper Lig"/);
  assert.match(app, /"Ekstraklasa"/);
  assert.match(app, /"Serie A"/);
  assert.match(app, /"Bundesliga"/);
  assert.doesNotMatch(app, /Премьер-лига/);
  assert.doesNotMatch(app, /Чемпионшип/);
  assert.doesNotMatch(app, /leagueUiLabel/);
  const fill = app.slice(
    app.indexOf("function fillLiveCompetitionSelect"),
    app.indexOf("function bindLivePage"),
  );
  assert.match(fill, /option value="\$\{esc\(slug\)\}"/);
  const bind = app.slice(app.indexOf("function bindLivePage"), app.indexOf("export async function start"));
  assert.match(bind, /fetchLiveRound\(\{ silent: false \}\)/);
  assert.match(bind, /resolveCompetitionIdFromLeagueParam/);
  assert.match(boot, /pages\/live\.js\?v=14/);
});

test("Live heading and round tabs use human names, not slugs or English Round N", async () => {
  const app = await readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8");
  assert.match(app, /function paintLiveLeagueChrome/);
  assert.match(app, /getElementById\("league-name"\)/);
  assert.match(app, /function liveRoundLabel/);
  assert.match(app, /tr\("Тур"\)/);
  assert.doesNotMatch(app, /FotMob · \$\{livePayload\?\.leagueName/);
  assert.doesNotMatch(app, /r\.label \|\| `Round \$\{r\.round\}`/);
});

test("Live first paint uses GET /live and does not POST /live/refresh", async () => {
  const app = await readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8");
  const fetchLive = app.slice(
    app.indexOf("async function fetchLiveRound"),
    app.indexOf("function ensureLiveLoaded"),
  );
  assert.match(fetchLive, /fetch\(`\/live\$\{q\}`/);
  assert.match(fetchLive, /Accept: "application\/json"/);
  assert.match(fetchLive, /cache: "no-store"/);
  assert.match(fetchLive, /"format", "json"/);
  assert.match(fetchLive, /LIVE_FETCH_RETRIES/);
  assert.match(fetchLive, /liveFetchRetryable\(res\.status\)/);
  assert.match(app, /status === 502 \|\| status === 503 \|\| status === 504/);
  assert.doesNotMatch(fetchLive, /\/live\/refresh/);
  assert.doesNotMatch(fetchLive, /method: forceRefresh \? "POST"/);
  assert.match(fetchLive, /renderLiveList\(\)/);
  assert.match(fetchLive, /void fetchIdealStandings/);
  assert.match(fetchLive, /refreshOpenMantraDialogFromLive/);
  assert.match(fetchLive, /void loadLiveDetail/);
  assert.match(app, /fetch\(`\/live\/ideal-standings\$\{q\}`\)/);
  assert.match(app, /fetchLiveRound\(\{ silent: true \}\)/);
  assert.doesNotMatch(app, /loadCompetitionData/);
});

test("Live event log never labels MissedPenalty as a goal; miss and scored-pen glyphs differ", async () => {
  const app = await readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8");
  const fmt = app.slice(
    app.indexOf("function formatLiveEventText"),
    app.indexOf("function renderSideIncidents"),
  );
  assert.match(fmt, /e\.type === "MissedPenalty"/);
  assert.match(fmt, /Незабитый пенальти/);
  const missReturn = fmt.slice(fmt.indexOf("MissedPenalty"), fmt.indexOf("e.type === \"Goal\""));
  assert.doesNotMatch(missReturn, /Гол/);
  const icons = app.slice(
    app.indexOf("function formatMantraScoreIcons"),
    app.indexOf("function mantraPhasePill"),
  );
  assert.match(icons, /case "pen":\s*return `[^`]*⚽🅿️/);
  assert.match(icons, /case "penMiss":\s*return `[^`]*🅿️✕/);
});

test("Live pins user Mantra leagues in the selected championship and auto-follows current tour", async () => {
  const [app, html, i18n] = await Promise.all([
    readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="live-pin-leagues"/);
  assert.match(html, /Показывай мои лиги вверху/);
  assert.match(i18n, /Показывай мои лиги вверху/);
  assert.match(app, /function pinMyItemsFirst/);
  assert.match(app, /function orderedMantraTours/);
  assert.match(app, /livePinnedRound/);
  assert.match(app, /t\.deadline/);
  assert.match(app, /дедлайн/);
  assert.match(app, /livePinnedRound && liveSelectedRound/);
  assert.match(app, /PATCH[\s\S]*pinMyLeagues/);
  const fetchLive = app.slice(
    app.indexOf("async function fetchLiveRound"),
    app.indexOf("function ensureLiveLoaded"),
  );
  assert.match(fetchLive, /if \(!livePinnedRound\)/);
  assert.match(fetchLive, /livePayload\?\.currentRound/);
});

test("Mantra match dialog paints cached Real XI and does not wipe to pending", async () => {
  const app = await readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8");
  assert.match(app, /function computedMatchFromLive/);
  assert.match(app, /function matchStubFromComputed/);
  assert.match(app, /function paintMantraMatchDialog/);
  assert.match(app, /keepRosterIfPending/);
  assert.match(app, /mantraDialogHasRoster/);
  const open = app.slice(
    app.indexOf("async function openMantraMatchDialog"),
    app.indexOf("/** @type {any | null} */"),
  );
  assert.match(open, /computedMatchFromLive\(matchId\)/);
  assert.match(open, /keepRosterIfPending/);
  assert.doesNotMatch(
    open.slice(0, open.indexOf("await fetch")),
    /mantra-dialog-body"\)\.innerHTML = ""/,
  );
});
