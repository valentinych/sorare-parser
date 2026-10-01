import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { spaPageRoutes } from "./spaPages.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public-tm");

test("GET /tables serves the standings SPA view", async (t) => {
  const app = Fastify();
  await app.register(spaPageRoutes, { publicDir });
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/tables" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /data-page="tables"/);
  assert.match(res.body, /id="tables-progress"/);
  assert.match(res.body, /id="tables-progress-pct"/);
  assert.match(res.body, /boot\.js\?v=77/);
  assert.match(res.body, /styles\.css\?v=163/);
  assert.doesNotMatch(res.body, /id="view-live"/);
  assert.doesNotMatch(res.body, /id="league"/);
  assert.doesNotMatch(res.body, /<th>NEXT<\/th>/);
  assert.doesNotMatch(res.body, /standings-move/);
  assert.match(res.body, /data-tables-sort="points"/);
  assert.match(res.body, /data-tables-sort="ts"/);
  assert.match(res.body, /data-tables-sort="idealTs"/);
  assert.match(res.body, /data-tables-sort="idealPct"/);
  assert.match(res.body, /data-tables-sort="iGf"/);
  assert.match(res.body, /data-tables-sort="gfDiff"/);
  assert.match(res.body, /data-tables-sort="iGa"/);
  assert.match(res.body, /data-tables-sort="iGd"/);
  assert.match(res.body, /data-tables-sort="iPts"/);
  assert.match(res.body, /data-tables-sort="ptsDiff"/);
  assert.match(res.body, />iGF</);
  assert.match(res.body, />DIFF</);
  assert.match(res.body, />iPTS</);
  assert.match(res.body, />DP</);
  assert.match(res.body, /iGF[\s\S]*?DIFF[\s\S]*?iGA/);
  assert.match(res.body, /iPTS[\s\S]*?DP[\s\S]*?TS/);
  assert.match(res.body, /title="Games">G</);
  assert.match(res.body, /title="Wins">W</);
  assert.match(res.body, /title="Draws">D</);
  assert.match(res.body, /title="Loses">L</);
  assert.doesNotMatch(res.body, />GAMES</);
  assert.doesNotMatch(res.body, />WINS</);
  assert.doesNotMatch(res.body, />DRAWS</);
  assert.doesNotMatch(res.body, />LOSES</);
  assert.match(res.body, /IDEAL TS/);
  assert.match(res.body, /% к идеалу/);
  assert.match(res.body, /TS \/ Ideal TS/);
  assert.match(res.body, /Идеальные Таблицы/);
  assert.match(res.body, /id="ideal-division-select"/);
  assert.match(res.body, /id="ideal-tour-results"/);
  assert.match(res.body, /Результаты туров/);
  assert.match(res.body, /data-ideal-sort="gf"/);
  assert.match(res.body, /data-ideal-sort="ga"/);
  assert.match(res.body, /data-ideal-sort="gd"/);
  assert.match(res.body, /id="ideal-vs-real-dialog"/);
  assert.match(res.body, /id="real-tables"/);
  assert.match(res.body, /Реальная таблица/);
  assert.match(res.body, /id="managers-table"/);
  assert.match(res.body, /id="managers-select"/);
  assert.match(res.body, /id="managers-scale-note"/);
  assert.match(res.body, /Средние за матч показаны на 100 матчей/);
  assert.match(res.body, /data-managers-sort="rank"/);
  assert.match(res.body, /data-managers-sort="managerName"/);
  assert.match(res.body, /data-managers-sort="games"/);
  assert.match(res.body, /data-managers-sort="clubs"[^>]*title="Сколько команд менеджера играют в чемпионатах">К</);
  assert.match(res.body, /title="Games">G<\/th>\s*<th class="sortable" data-managers-sort="clubs"/);
  assert.match(res.body, /data-managers-sort="wins"[^>]*>W\*/);
  assert.match(res.body, /data-managers-sort="points"[^>]*>POINTS\*/);
  assert.match(res.body, /data-managers-sort="ptsDiff"[^>]*>DP\*/);
  assert.match(res.body, /data-managers-sort="ts"[^>]*>TS</);
  assert.match(res.body, /data-managers-sort="idealTs"[^>]*>IDEAL TS</);
  assert.match(res.body, /data-managers-sort="idealPct"[^>]*>% к идеалу</);
  assert.match(res.body, /Выберите менеджера/);
  assert.doesNotMatch(res.body, /id="dream-team-dialog"/);
});

test("GET /api/tables/progress is public and scoped by league slug", async (t) => {
  const app = Fastify();
  const { mantraStandingsRoutes } = await import("./mantraStandings.js");
  await app.register(mantraStandingsRoutes);
  t.after(() => app.close());
  const bad = await app.inject({ method: "GET", url: "/api/tables/progress?league=not-a-league" });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({
    method: "GET",
    url: "/api/tables/progress?league=ligue-1",
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  const body = ok.json();
  assert.equal(body.league, "ligue-1");
  assert.equal(body.extra, true);
  assert.equal(body.progress.slug, "ligue-1");
  assert.equal(typeof body.progress.percent, "number");
  const core = await app.inject({
    method: "GET",
    url: "/api/tables/progress?league=championship",
  });
  assert.equal(core.statusCode, 200);
  assert.equal(core.json().extra, false);
});

test("GET /api/tables merges Ideal TS from mantra-ideal-table for extra leagues", async () => {
  const src = await readFile(new URL("./mantraStandings.ts", import.meta.url), "utf8");
  assert.match(src, /peekIdealTableOverlay/);
  assert.match(src, /mergeIdealTsSources/);
  assert.match(src, /loadSeasonIdealTotals/);
});

test("GET /api/tables accepts extra Mantra championship slugs", async (t) => {
  const { setStandingsScheduler, resetMantraStandingsCacheForTests } = await import(
    "../domain/mantraStandings.js"
  );
  setStandingsScheduler(() => {});
  const app = Fastify();
  const { mantraStandingsRoutes } = await import("./mantraStandings.js");
  await app.register(mantraStandingsRoutes);
  t.after(() => {
    resetMantraStandingsCacheForTests();
    return app.close();
  });
  const res = await app.inject({ method: "GET", url: "/api/tables?league=ligue-1" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.notEqual(body.error, "invalid_standings_league");
  assert.equal(body.league, "ligue-1");
  assert.ok(body.leagues.some((row) => row.slug === "upl"));
  assert.ok(body.leagues.some((row) => row.slug === "brasileirao"));
});

test("GET /api/tables accepts managers slug without waiting on Mantra", async (t) => {
  const src = await readFile(new URL("./mantraStandings.ts", import.meta.url), "utf8");
  assert.match(src, /isManagersSlug\(requested\)/);
  assert.match(src, /getManagersStandings/);
  assert.doesNotMatch(src, /mantraAuth|fetchMantraManagerHtml|syncManagerNicknames/);
  const app = Fastify();
  const { mantraStandingsRoutes } = await import("./mantraStandings.js");
  await app.register(mantraStandingsRoutes);
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/tables?league=managers" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.notEqual(body.error, "invalid_standings_league");
  assert.equal(body.league, "managers");
  assert.ok(Array.isArray(body.rows));
  assert.ok(body.leagues.some((row) => row.slug === "managers"));
  const progress = await app.inject({
    method: "GET",
    url: "/api/tables/progress?league=managers",
  });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().progress.complete, true);
});

test("GET /api/tables rejects unknown championship slugs", async (t) => {
  const app = Fastify();
  const { mantraStandingsRoutes } = await import("./mantraStandings.js");
  await app.register(mantraStandingsRoutes);
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/tables?league=not-a-league" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_standings_league");
});

test("tables page fetches /api/tables with league query", async () => {
  const src = await readFile(new URL("../../public-tm/pages/tables.js", import.meta.url), "utf8");
  assert.match(src, /\/api\/tables\/progress\?league=/);
  assert.match(src, /"ligue-1"/);
  assert.match(src, /"brasileirao"/);
  assert.match(src, /"managers"/);
  assert.match(src, /isManagersMode/);
  assert.match(src, /getElementById\("managers-select"\)/);
  assert.match(src, /function managerSelectLabel/);
  assert.match(src, /teams\?\.\[0\]\?\.teamName/);
  assert.match(src, /\$\{name\} \(\$\{teamName\}\)/);
  assert.match(src, /esc\(managerSelectLabel\(row\)\)/);
  assert.match(src, /"clubs"/);
  assert.match(src, /function clubCount/);
  assert.match(src, /function teamsCountLabel/);
  assert.doesNotMatch(src, /avg100Text\(row\.clubs\)/);
  assert.match(src, /avg100Text/);
  assert.match(src, /nextManagersSort/);
  assert.match(src, /data-sort=/);
  assert.match(src, /premium-sort\.js\?v=5/);
  assert.match(src, /key === "managerName" \? "asc"/);
  assert.match(src, /avgText/);
  assert.match(src, /leagueCell/);
  assert.match(src, /paintManagersTable/);
  assert.match(src, /managerCell/);
  assert.match(src, /mantrafootball.org\/managers\//);
  assert.match(src, /paintManagerTeamTables/);
  assert.match(src, /function paintProgress/);
  assert.match(src, /getElementById\("tables-progress"\)/);
  assert.match(src, /\/api\/tables\?league=/);
  assert.match(src, /Дивизион|row\.division/);
  assert.doesNotMatch(src, /movementCell|nextTeamName|standings-move/);
  assert.match(src, /data-tables-sort/);
  assert.match(src, /key === "points" \|\| key === "ts"/);
  assert.match(src, /"idealTs"/);
  assert.match(src, /"idealPct"/);
  assert.match(src, /toFixed\(2\)/);
  assert.match(src, /av == null && bv != null/);
  assert.match(src, /\/api\/me\/mantra-teams/);
  assert.match(src, /standings-row-mine/);
  assert.match(src, /\/api\/tables\/ideal\?league=/);
  assert.match(src, /division=\$\{encodeURIComponent\(division\)\}/);
  assert.match(src, /if \(!division\)/);
  assert.match(src, /getElementById\("ideal-tour-results"\)/);
  assert.match(src, /data-ideal-match/);
  assert.match(src, /openIdealMatchDialog/);
  assert.match(src, /завершённые туры/);
  assert.match(src, /ideal-tour-goals/);
  assert.match(src, /"gf"/);
  assert.match(src, /function paintRealTable/);
  assert.match(src, /function realMatchLine/);
  assert.match(src, /ideal-tour-real-score is-unknown/);
  assert.match(src, /match\.home\.realTs/);
  assert.match(src, /match\.home\.realGoals/);
  assert.match(src, /row\.leagueId/);
  assert.match(src, /"iGf"/);
  assert.match(src, /"gfDiff"/);
  assert.match(src, /"iPts"/);
  assert.match(src, /"ptsDiff"/);
  assert.match(src, /row\.iGf/);
  assert.match(src, /function gfDiffVal/);
  assert.match(src, /gfDiffText\(row\)/);
  assert.match(src, /function ptsDiffVal/);
  assert.match(src, /ptsDiffText\(row\)/);
  assert.match(src, /standings-gf-diff is-pos/);
  assert.match(src, /is-outcome-flip/);
  assert.match(src, /is-outcome-draw-swing/);
  assert.match(src, /function matchOutcomeClass/);
  assert.doesNotMatch(src, /function playerCell/);
  assert.match(src, /function rowInSelectedDivision/);
});

test("ideal tour cards are a 2-column grid from 1100px with yellow/red outcome washes", async () => {
  const css = await readFile(new URL("../../public-tm/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(min-width: 1100px\) \{[\s\S]*?\.ideal-tour-matches \{[\s\S]*?grid-template-columns: 1fr 1fr;/);
  assert.match(css, /\.ideal-tour-match\.is-outcome-draw-swing/);
  assert.match(css, /\.ideal-tour-match\.is-outcome-flip/);
  assert.match(css, /\.standings-gf-diff\.is-pos/);
  assert.match(css, /\.standings-gf-diff\.is-neg/);
  assert.match(css, /\.standings-gf-diff\.is-zero/);
  assert.match(css, /\[data-tables-mode="managers"\] \.league-only/);
  assert.match(css, /\.managers-pick/);
  assert.match(css, /#managers-scale-note/);
});

test("GET /api/tables/ideal skips compute without a division and rejects unknown ones", async (t) => {
  const app = Fastify();
  const { mantraStandingsRoutes } = await import("./mantraStandings.js");
  await app.register(mantraStandingsRoutes);
  t.after(() => app.close());
  const empty = await app.inject({ method: "GET", url: "/api/tables/ideal?league=super-lig" });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().reason, "select_division");
  assert.equal(empty.json().rows.length, 0);
  assert.ok(empty.json().divisions.some((item) => item.code === "A1"));
  const bad = await app.inject({
    method: "GET",
    url: "/api/tables/ideal?league=super-lig&division=ZZ",
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_standings_division");
});
