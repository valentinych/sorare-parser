import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Fastify from "fastify";
import { ekstraklasaRoutes } from "./ekstraklasa.js";
import { spaPageRoutes } from "./spaPages.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public-tm");

const BUILDER_SLUGS = [
  "ekstraklasa",
  "serie-a",
  "bundesliga",
  "premier-league",
  "championship",
  "super-lig",
  "ligue-1",
  "la-liga",
  "eredivisie",
  "jupiler-pro-league",
  "primeira-liga",
  "upl",
  "mls",
  "brasileirao",
  "league-one",
];

test("GET /builder/leagues lists Live, tables, and League One slugs", async (t) => {
  const app = Fastify();
  await app.register(ekstraklasaRoutes);
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/builder/leagues" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.leagues.map((row: { slug: string }) => row.slug),
    BUILDER_SLUGS,
  );
  const ligue1 = body.leagues.find((row: { slug: string }) => row.slug === "ligue-1");
  assert.equal(ligue1?.tmCompetition, "FR1");
  assert.equal(ligue1?.mantraTournamentId, 4);
  const leagueOne = body.leagues.find((row: { slug: string }) => row.slug === "league-one");
  assert.equal(leagueOne?.tmCompetition, "GB3");
  assert.equal(leagueOne?.mantraTournamentId, 26);
  assert.equal(leagueOne?.fotmobLeagueId, 108);
  const championship = body.leagues.find((row: { slug: string }) => row.slug === "championship");
  assert.equal(championship?.mantraTournamentId, 11);
});

test("GET /builder accepts remaining championship slugs without 404", async (t) => {
  const app = Fastify();
  await app.register(spaPageRoutes, { publicDir });
  t.after(() => app.close());
  for (const slug of ["championship", "ligue-1", "league-one", "la-liga", "upl"]) {
    const res = await app.inject({ method: "GET", url: `/builder?league=${slug}` });
    assert.equal(res.statusCode, 200, slug);
    assert.match(res.body, /data-page="builder"/);
    assert.match(res.body, /id="view-builder"/);
    assert.match(res.body, /id="competition-select"/);
    assert.match(res.body, /id="builder-refresh-auctions"/);
    assert.match(res.body, /id="builder-refresh-auctions"[\s\S]*?\bhidden\b/);
    assert.match(res.body, /Обновить после раундов аукциона/);
    assert.doesNotMatch(res.body, /app\.js\?v=/);
  }
});

test("Builder picker uses /builder/leagues and skips TM crawl on load", async () => {
  const appJs = await readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8");
  const boot = await readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8");
  assert.match(appJs, /fetch\("\/builder\/leagues"\)/);
  assert.match(appJs, /function builderSelectCompetitions/);
  assert.match(appJs, /function loadBuilderLeaguesFromApi/);
  assert.match(appJs, /slug: "ligue-1"/);
  assert.match(appJs, /slug: "league-one"/);
  assert.match(appJs, /tmCompetition: "FR1"/);
  assert.match(appJs, /tmCompetition: "GB3"/);
  assert.match(appJs, /mantraTournamentId: 26/);
  assert.match(appJs, /"jupiler-pro-league": "Pro League"/);
  assert.match(appJs, /"league-one": "League One"/);
  assert.match(appJs, /page === "builder" \? loadBuilderLeaguesFromApi/);
  assert.match(appJs, /else if \(page === "builder"\) \{/);
  assert.match(appJs, /currentPageName\(\) === "builder"/);
  assert.match(appJs, /resetBuilderState\(\{ catalog: true \}\)/);
  assert.match(appJs, /syncBuilderHash\(\)/);
  assert.match(appJs, /function builderPublicImage/);
  assert.match(appJs, /builderPublicImage\(player\.avatarPath\)/);
  assert.match(boot, /builder: "\.\/app\.js\?v=148"/);
  assert.match(appJs, /id="builder-refresh-auctions"|builder-refresh-auctions/);
  assert.match(appJs, /\/api\/expected11\/premium\/refresh-auctions/);
  assert.match(appJs, /accountState\.entitlements\?\.expected11Admin/);
  assert.match(appJs, /function isBuilderAdmin/);
  assert.match(appJs, /Доступно через/);
});

test("GET /mantra/fantasy-teams accepts extra tournament ids", async (t) => {
  const app = Fastify();
  await app.register(ekstraklasaRoutes);
  t.after(() => app.close());
  for (const tournamentId of [11, 4, 26]) {
    const res = await app.inject({
      method: "GET",
      url: `/mantra/fantasy-teams?tournamentId=${tournamentId}`,
    });
    assert.equal(res.statusCode, 200, String(tournamentId));
    const body = res.json();
    assert.equal(body.tournamentId, tournamentId);
    assert.ok(Array.isArray(body.leagues));
    assert.ok(Array.isArray(body.teams));
  }
});
