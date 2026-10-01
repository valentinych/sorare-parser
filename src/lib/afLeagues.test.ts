import assert from "node:assert/strict";
import test from "node:test";
import {
  UI_LEAGUE_SLUGS,
  isPremiumLeagueSlug,
  isUiLeagueSlug,
  isUiTmCompetition,
  leagueBySlug,
  leagueResolveCatalog,
  premiumLeagues,
  premiumMantraTournaments,
  uiLeagues,
} from "./afLeagues.js";

const HIDDEN = [
  "la-liga",
  "ligue-1",
  "eredivisie",
  "primeira-liga",
  "jupiler-pro-league",
  "league-one",
  "upl",
  "mls",
  "brasileirao",
];

test("UI championships are the six kept leagues; hidden ones stay in AF_LEAGUES", () => {
  assert.deepEqual([...UI_LEAGUE_SLUGS], [
    "ekstraklasa",
    "serie-a",
    "bundesliga",
    "premier-league",
    "championship",
    "super-lig",
  ]);
  assert.deepEqual(
    uiLeagues().map((league) => league.slug),
    [...UI_LEAGUE_SLUGS],
  );
  for (const slug of HIDDEN) {
    assert.equal(isUiLeagueSlug(slug), false);
    assert.ok(leagueBySlug(slug), slug);
  }
  assert.equal(isUiTmCompetition("ES1"), false);
  assert.equal(isUiTmCompetition("IT1"), true);
  assert.ok(leagueResolveCatalog().some((row) => row.slug === "la-liga"));
  assert.ok(leagueResolveCatalog().some((row) => row.id === "ES1"));
  assert.equal(leagueBySlug("league-one")?.tmCompetition, "GB3");
  assert.equal(leagueBySlug("league-one")?.id, 41);
  assert.equal(leagueBySlug("upl")?.mantraTournamentId, 15);
  assert.equal(leagueBySlug("mls")?.mantraTournamentId, 16);
  assert.equal(leagueBySlug("brasileirao")?.mantraTournamentId, 19);
  assert.equal(leagueBySlug("ligue-1")?.mantraTournamentId, 4);
  assert.equal(leagueBySlug("la-liga")?.mantraTournamentId, 5);
  assert.equal(leagueBySlug("league-one")?.mantraTournamentId, 26);
  assert.equal(isPremiumLeagueSlug("league-one"), true);
  assert.equal(isPremiumLeagueSlug("la-liga"), false);
  assert.deepEqual(
    premiumLeagues().map((league) => league.slug),
    [...UI_LEAGUE_SLUGS, "league-one"],
  );
  assert.ok(premiumMantraTournaments().includes(26));
  assert.ok(!premiumMantraTournaments().includes(4));
});
