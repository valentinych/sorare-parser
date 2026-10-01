import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_LEAGUES,
  PREMIUM_EXTRA_LEAGUES,
  allLiveLeagues,
  allBuilderLeagues,
  allPremiumLeagues,
  allTablesLeagues,
  catalogDivisionsForTournament,
  isTablesExtraSlug,
  leagueFlagEmoji,
  liveLeagueByFotmobId,
  liveLeagueBySlug,
  mantraToursAreLocked,
  mantraToursHaveActiveDeadline,
  preferMantraMatchRound,
  resolveLiveLeague,
  shouldAutoOpenNextTour,
  tourHasActiveDeadline,
  tourHasFirstKickoff,
} from "./liveLeagues.js";

test("LIVE_LEAGUES includes the six UI championships", () => {
  const slugs = allLiveLeagues().map((l) => l.slug);
  assert.deepEqual(slugs, [
    "ekstraklasa",
    "serie-a",
    "bundesliga",
    "premier-league",
    "championship",
    "super-lig",
  ]);
  assert.equal(LIVE_LEAGUES.ekstraklasa?.mantraTournamentId, 18);
  assert.equal(LIVE_LEAGUES.ekstraklasa?.fotmobLeagueId, 196);
  assert.deepEqual(
    LIVE_LEAGUES.ekstraklasa?.mantraDivisions.map((d) => d.division),
    ["A1", "B1", "B2", "C1"],
  );
  assert.equal(LIVE_LEAGUES.ekstraklasa?.mantraDivisions[0]?.leagueId, 583);
  assert.equal(LIVE_LEAGUES["serie-a"]?.mantraTournamentId, 1);
  assert.equal(LIVE_LEAGUES["serie-a"]?.fotmobLeagueId, 55);
  assert.equal(LIVE_LEAGUES.bundesliga?.mantraTournamentId, 3);
  assert.equal(LIVE_LEAGUES.bundesliga?.fotmobLeagueId, 54);
  assert.equal(LIVE_LEAGUES["premier-league"]?.mantraTournamentId, 2);
  assert.equal(LIVE_LEAGUES["premier-league"]?.fotmobLeagueId, 47);
  assert.equal(LIVE_LEAGUES.championship?.mantraTournamentId, 11);
  assert.equal(LIVE_LEAGUES["super-lig"]?.mantraTournamentId, 21);
});

test("tables extra leagues are wired for /tables but stay off Live poller", () => {
  assert.deepEqual(allLiveLeagues().map((l) => l.slug), [
    "ekstraklasa",
    "serie-a",
    "bundesliga",
    "premier-league",
    "championship",
    "super-lig",
  ]);
  const extra = allTablesLeagues().map((l) => l.slug);
  assert.deepEqual(extra.slice(6), [
    "ligue-1",
    "la-liga",
    "eredivisie",
    "jupiler-pro-league",
    "primeira-liga",
    "upl",
    "mls",
    "brasileirao",
  ]);
  assert.equal(LIVE_LEAGUES["ligue-1"], undefined);
  assert.equal(liveLeagueBySlug("ligue-1")?.mantraTournamentId, 4);
  assert.equal(liveLeagueBySlug("ligue-1")?.fotmobLeagueId, 53);
  assert.equal(liveLeagueBySlug("FR1")?.slug, "ligue-1");
  assert.equal(liveLeagueBySlug("la-liga")?.mantraTournamentId, 5);
  assert.equal(liveLeagueBySlug("la-liga")?.fotmobLeagueId, 87);
  assert.equal(liveLeagueBySlug("eredivisie")?.fotmobLeagueId, 57);
  assert.equal(liveLeagueBySlug("jupiler-pro-league")?.fotmobLeagueId, 40);
  assert.equal(liveLeagueBySlug("primeira-liga")?.fotmobLeagueId, 61);
  assert.equal(liveLeagueBySlug("upl")?.mantraTournamentId, 15);
  assert.equal(liveLeagueBySlug("upl")?.fotmobLeagueId, 441);
  assert.equal(liveLeagueBySlug("mls")?.mantraTournamentId, 16);
  assert.equal(liveLeagueBySlug("mls")?.fotmobLeagueId, 130);
  assert.equal(liveLeagueBySlug("brasileirao")?.mantraTournamentId, 19);
  assert.equal(liveLeagueBySlug("brasileirao")?.fotmobLeagueId, 268);
  assert.equal(leagueFlagEmoji("ligue-1"), "🇫🇷");
  assert.equal(leagueFlagEmoji("championship"), "🏴󠁧󠁢󠁥󠁮󠁧󠁿");
  assert.equal(liveLeagueBySlug("ligue-1")?.mantraDivisions[0]?.leagueId, 732);
  assert.equal(liveLeagueBySlug("la-liga")?.mantraDivisions[0]?.leagueId, 664);
  assert.equal(liveLeagueBySlug("upl")?.mantraDivisions.length, 52);
  assert.equal(isTablesExtraSlug("ligue-1"), true);
  assert.equal(isTablesExtraSlug("championship"), false);
  assert.equal(isTablesExtraSlug("league-one"), false);
});

test("England 3 is Premium-only, not Live or /tables", () => {
  assert.equal(LIVE_LEAGUES["league-one"], undefined);
  assert.equal(allLiveLeagues().some((l) => l.slug === "league-one"), false);
  assert.equal(allTablesLeagues().some((l) => l.slug === "league-one"), false);
  assert.equal(PREMIUM_EXTRA_LEAGUES["league-one"]?.mantraTournamentId, 26);
  assert.equal(liveLeagueBySlug("league-one")?.fotmobLeagueId, 108);
  assert.equal(liveLeagueBySlug("GB3")?.slug, "league-one");
  assert.equal(liveLeagueByFotmobId(108)?.slug, "league-one");
  assert.deepEqual(
    liveLeagueBySlug("league-one")?.mantraDivisions.map((d) => d.leagueId),
    [795, 796, 797, 798, 799],
  );
  assert.deepEqual(allPremiumLeagues().map((l) => l.slug), [
    "ekstraklasa",
    "serie-a",
    "bundesliga",
    "premier-league",
    "championship",
    "super-lig",
    "league-one",
  ]);
  assert.equal(leagueFlagEmoji("league-one"), "🏴󠁧󠁢󠁥󠁮󠁧󠁿");
});

test("Builder catalog is Live 6 + /tables extras + League One", () => {
  assert.deepEqual(allBuilderLeagues().map((l) => l.slug), [
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
  ]);
  assert.equal(allBuilderLeagues().find((l) => l.slug === "ligue-1")?.mantraTournamentId, 4);
  assert.equal(allBuilderLeagues().find((l) => l.slug === "league-one")?.mantraTournamentId, 26);
  assert.equal(allBuilderLeagues().find((l) => l.slug === "championship")?.mantraTournamentId, 11);
  assert.deepEqual(
    catalogDivisionsForTournament(4).map((d) => d.id),
    [732, 733, 734, 735, 736, 737, 738, 739, 740],
  );
  assert.deepEqual(
    catalogDivisionsForTournament(26).map((d) => d.id),
    [795, 796, 797, 798, 799],
  );
  assert.equal(catalogDivisionsForTournament(26)[0]?.name, "Winchester");
  assert.equal(catalogDivisionsForTournament(99).length, 0);
});

test("liveLeagueBySlug accepts AF slugs and TM codes", () => {
  assert.equal(liveLeagueBySlug("premier-league")?.slug, "premier-league");
  assert.equal(liveLeagueBySlug("GB1")?.slug, "premier-league");
  assert.equal(liveLeagueBySlug("super-lig")?.slug, "super-lig");
  assert.equal(liveLeagueBySlug("TR1")?.slug, "super-lig");
  assert.equal(liveLeagueBySlug("serie-a")?.slug, "serie-a");
  assert.equal(liveLeagueBySlug("IT1")?.slug, "serie-a");
  assert.equal(liveLeagueBySlug("bundesliga")?.slug, "bundesliga");
  assert.equal(liveLeagueBySlug("L1")?.slug, "bundesliga");
  assert.equal(liveLeagueBySlug("championship")?.slug, "championship");
  assert.equal(liveLeagueBySlug("ekstraklasa")?.slug, "ekstraklasa");
  assert.equal(liveLeagueBySlug("ES1")?.slug, "la-liga");
  assert.equal(liveLeagueBySlug("UKR1")?.slug, "upl");
});

test("resolveLiveLeague no longer maps Premier League onto Ekstraklasa", () => {
  assert.equal(resolveLiveLeague("premier-league").slug, "premier-league");
  assert.equal(resolveLiveLeague("unknown-league").slug, "ekstraklasa");
});

test("Serie A live catalog is tournament 1 leagues 742–765", () => {
  const ids = LIVE_LEAGUES["serie-a"]!.mantraDivisions.map((d) => d.leagueId);
  assert.equal(ids[0], 742);
  assert.equal(ids.at(-1), 765);
  assert.equal(ids.length, 24);
  assert.equal(LIVE_LEAGUES["serie-a"]!.mantraDivisions[0]?.name, "Rome");
  assert.equal(LIVE_LEAGUES["serie-a"]!.mantraDivisions.at(-1)?.name, "Venice");
});

test("Bundesliga live catalog is tournament 3 leagues 770–784", () => {
  const ids = LIVE_LEAGUES.bundesliga!.mantraDivisions.map((d) => d.leagueId);
  assert.deepEqual(ids, [
    770, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784,
  ]);
  assert.equal(LIVE_LEAGUES.bundesliga!.mantraDivisions[0]?.name, "Berlin");
});

test("Premier League live catalog is tournament 2 leagues 684–786", () => {
  const ids = LIVE_LEAGUES["premier-league"]!.mantraDivisions.map((d) => d.leagueId);
  const bournemouth = LIVE_LEAGUES["premier-league"]!.mantraDivisions.find(
    (d) => d.name === "Bournemouth",
  );
  assert.equal(ids[0], 684);
  assert.equal(ids.at(-1), 786);
  assert.ok(ids.includes(701));
  assert.ok(ids.includes(703));
  assert.ok(!ids.includes(702));
  assert.equal(ids.length, 49);
  assert.equal(bournemouth?.leagueId, 786);
  assert.equal(bournemouth?.tourId, 24903);
});

test("preferMantraMatchRound follows a locked Mantra tour ahead of FotMob hold", () => {
  assert.equal(preferMantraMatchRound("3", 4, true), "4");
  assert.equal(preferMantraMatchRound("3", 4, false), "3");
  assert.equal(preferMantraMatchRound("4", 4, true), "4");
  assert.equal(preferMantraMatchRound("4", 3, true), "4");
  assert.equal(preferMantraMatchRound(null, 1, true), "1");
  assert.equal(preferMantraMatchRound("1", null, true), "1");
  assert.equal(preferMantraMatchRound("1", 2, false, true), "2");
  assert.equal(preferMantraMatchRound("1", 2, false, false), "1");
});

test("tourHasActiveDeadline is a future ISO or an unlocked labelled window", () => {
  const now = Date.parse("2026-08-26T10:00:00Z");
  assert.equal(
    tourHasActiveDeadline({ deadline: "2026-08-28T17:15:00.000Z", matches: [{ locked: false }] }, now),
    true,
  );
  assert.equal(
    tourHasActiveDeadline({ deadline: "2026-08-22T17:15:00.000Z", matches: [{ locked: false }] }, now),
    false,
  );
  assert.equal(
    tourHasActiveDeadline({ deadlineLabel: "Fri, Aug 28 at 19:15", matches: [{ locked: false }] }, now),
    true,
  );
  assert.equal(
    tourHasActiveDeadline({ deadlineLabel: "Fri, Aug 28 at 19:15", matches: [{ locked: true }] }, now),
    false,
  );
  assert.equal(
    mantraToursHaveActiveDeadline(
      [{ deadline: "2026-08-28T17:15:00.000Z", matches: [{ locked: false }] }],
      now,
    ),
    true,
  );
});

test("mantraToursAreLocked requires a locked match, not just published pairs", () => {
  assert.equal(
    mantraToursAreLocked([{ matches: [{ locked: false }, { locked: false }] }]),
    false,
  );
  assert.equal(
    mantraToursAreLocked([{ matches: [{ locked: false }, { locked: true }] }]),
    true,
  );
});

test("shouldAutoOpenNextTour when locked or FotMob first kickoff, and ahead", () => {
  assert.equal(shouldAutoOpenNextTour(2, { round: 3, locked: true }), true);
  assert.equal(shouldAutoOpenNextTour(2, { round: 3, locked: false }), false);
  assert.equal(shouldAutoOpenNextTour(2, { round: 3, locked: false, kickedOff: true }), true);
  assert.equal(shouldAutoOpenNextTour(2, { round: 3, locked: false, hasDeadline: true }), true);
  assert.equal(shouldAutoOpenNextTour(3, { round: 3, locked: true }), false);
  assert.equal(shouldAutoOpenNextTour(3, { round: 3, locked: false, kickedOff: true }), false);
  assert.equal(shouldAutoOpenNextTour(null, { round: 1, locked: true }), true);
  assert.equal(shouldAutoOpenNextTour(null, { round: 1, locked: false, kickedOff: true }), true);
  assert.equal(shouldAutoOpenNextTour(2, null), false);
});

test("tourHasFirstKickoff is live, finished, or kickoff already passed", () => {
  const now = Date.parse("2026-08-21T18:05:00Z");
  assert.equal(tourHasFirstKickoff([{ phase: "live", kickoff: "2026-08-21T18:00:00Z" }], now), true);
  assert.equal(
    tourHasFirstKickoff([{ phase: "finished", kickoff: "2026-08-21T16:00:00Z" }], now),
    true,
  );
  assert.equal(
    tourHasFirstKickoff(
      [{ phase: "upcoming", kickoff: "2026-08-21T18:00:00Z", status_short: "NS" }],
      now,
    ),
    true,
  );
  assert.equal(
    tourHasFirstKickoff(
      [{ phase: "upcoming", kickoff: "2026-08-21T19:00:00Z", status_short: "NS" }],
      now,
    ),
    false,
  );
  assert.equal(
    tourHasFirstKickoff(
      [{ phase: "upcoming", kickoff: "2026-08-21T18:00:00Z", status_short: "PP" }],
      now,
    ),
    false,
  );
  assert.equal(tourHasFirstKickoff([], now), false);
});
