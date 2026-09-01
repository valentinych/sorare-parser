import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  collectExpected11Snapshot,
  normalizeExpected11Snapshot,
  STARTING_XI_FALLBACK_PERCENTAGE,
  withStartingXiFallbackPercentage,
} from "./expected11.js";

test("normalizes both teams' visible squad, notes, and authors", () => {
  const fixture = readFileSync(
    new URL("./fixtures/expected11-lineup.html", import.meta.url),
    "utf8",
  );
  const { document } = parseHTML(fixture);
  const sourceUrl =
    "https://expected11.com/match/19729166/wolverhampton-wanderers-vs-blackburn-rovers";
  const snapshot = collectExpected11Snapshot(document.body, {
    sourceUrl,
    extractedAt: "2026-08-10T20:00:00.000Z",
    assumeVisible: true,
  });
  const result = normalizeExpected11Snapshot(snapshot);

  assert.equal(result.status, "ok");
  assert.equal(result.match.id, "19729166");
  assert.equal(result.match.homeTeam, "Wolverhampton Wanderers");
  assert.equal(result.match.awayTeam, "Blackburn Rovers");
  assert.deepEqual(result.match.formations, ["4-2-3-1", "4-3-3"]);
  assert.deepEqual(
    result.teams.map((team) => ({
      side: team.side,
      name: team.name,
      logoUrl: team.logoUrl,
      starting: team.lineup.starting.map((player) => [
        player.name,
        player.displayedPercentage,
        player.displayedLabel,
      ]),
      bench: team.lineup.bench.map((player) => [
        player.name,
        player.displayedPercentage,
        player.displayedLabel,
      ]),
      out: team.lineup.out.map((player) => [
        player.name,
        player.displayedPercentage,
        player.displayedLabel,
      ]),
      author: team.author,
    })),
    [
      {
        side: "home",
        name: "Wolverhampton Wanderers",
        logoUrl: "https://cdn.example.com/teams/wolves.png",
        starting: [
          ["Daniel Bentley", 60, "60%"],
          ["Fer López", 90, "90%"],
        ],
        bench: [["José Sá", 40, "40%"]],
        out: [["Hee-chan Hwang", null, null]],
        author: "Bickley123",
      },
      {
        side: "away",
        name: "Blackburn Rovers",
        logoUrl: "https://cdn.example.com/teams/blackburn.png",
        starting: [
          ["Balázs Tóth", 80, "80%"],
          ["Sean McLoughlin", 90, "90%"],
        ],
        bench: [["Aynsley Pears", 20, "20%"]],
        out: [["Mathias Jørgensen", null, null]],
        author: "SorareCanary",
      },
    ],
  );

  const [wolves, blackburn] = result.teams;
  assert.match(
    wolves?.notes.teamAnalysis?.text ?? "",
    /Daniel Bentley is expected to start in goal\.\n+Fer López/,
  );
  assert.equal(
    wolves?.notes.injuriesAndRecovery?.text,
    "Hwang and Jiménez are returning late.",
  );
  assert.equal(wolves?.notes.suspensionsAndIneligibilities?.text, ".");
  assert.equal(wolves?.notes.additionalNotes?.text, "Late fitness test expected.");
  assert.match(
    blackburn?.notes.teamAnalysis?.text ?? "",
    /Tóth should begin the season as number one\.\n+Ohashi/,
  );
  assert.equal(
    blackburn?.notes.injuriesAndRecovery?.text,
    "Scott Wharton has no return date.",
  );
  assert.equal(
    blackburn?.notes.suspensionsAndIneligibilities?.text,
    "None.",
  );

  const benchPlayer = result.players.find(
    (player) => player.name === "José Sá",
  );
  assert.deepEqual(benchPlayer?.probabilities, {
    starter: 0.4,
    substitute: null,
    notPlaying: null,
  });
  const outPlayer = result.players.find(
    (player) => player.name === "Hee-chan Hwang",
  );
  assert.deepEqual(outPlayer?.probabilities, {
    starter: null,
    substitute: null,
    notPlaying: null,
  });
  assert.equal(
    result.players[0]?.raw.starterText,
    "60% chance of starting the game",
  );
});

test("starting XI without a percentage gets 66% and real percents stay", () => {
  assert.equal(withStartingXiFallbackPercentage("starting", null), 66);
  assert.equal(withStartingXiFallbackPercentage("starting", 0), 66);
  assert.equal(withStartingXiFallbackPercentage("starting", 82), 82);
  assert.equal(withStartingXiFallbackPercentage("bench", null), null);
  assert.equal(withStartingXiFallbackPercentage("bench", 0), 0);
  assert.equal(withStartingXiFallbackPercentage("out", null), null);

  const { document } = parseHTML(`
    <html>
      <head><title>Lincoln City vs Portsmouth | Expected 11</title></head>
      <body>
        <a class="match-view__team-label--home">Lincoln City</a>
        <a class="match-view__team-label--away">Portsmouth</a>
        <article>
          <h3>Lincoln City</h3>
          <section>
            <h4>Starting</h4>
            <ol>
              <li><a href="/player/1/george-wickens">George Wickens</a></li>
              <li><a href="/player/2/tendayi-darikwa">Tendayi Darikwa</a><span>82%</span></li>
            </ol>
          </section>
          <section>
            <h4>Bench</h4>
            <ol><li><a href="/player/3/jose-sa">José Sá</a></li></ol>
          </section>
          <section>
            <h4>Out</h4>
            <ol><li><a href="/player/4/hee-chan-hwang">Hee-chan Hwang</a></li></ol>
          </section>
        </article>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/19729151/lincoln-city-vs-portsmouth",
      extractedAt: "2026-08-21T12:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.deepEqual(
    result.teams[0]?.lineup.starting.map((player) => [
      player.name,
      player.displayedPercentage,
      player.displayedLabel,
    ]),
    [
      ["George Wickens", STARTING_XI_FALLBACK_PERCENTAGE, "66%"],
      ["Tendayi Darikwa", 82, "82%"],
    ],
  );
  assert.equal(result.teams[0]?.lineup.bench[0]?.name, "José Sá");
  assert.equal(result.teams[0]?.lineup.bench[0]?.displayedPercentage, null);
  assert.equal(result.teams[0]?.lineup.bench[0]?.displayedLabel, null);
  assert.equal(result.teams[0]?.lineup.out[0]?.displayedPercentage, null);
  assert.equal(
    result.players.find((player) => player.name === "George Wickens")?.probabilities
      .starter,
    0.66,
  );
  assert.equal(
    result.players.find((player) => player.name === "Tendayi Darikwa")?.probabilities
      .starter,
    0.82,
  );
});

test("reports restricted markup without inventing player names", () => {
  const { document } = parseHTML(`
    <html>
      <body>
        <div class="lineup lineup--home" aria-label="Home FC starting lineup">
          <article class="lineup-position lineup-position--restricted"
            aria-label="Restricted lineup position, Confidence 70 percent">
            <span class="starting-odds-badge">70%</span>
          </article>
        </div>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/123/home-vs-away",
      extractedAt: "2026-08-10T20:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.equal(result.status, "login-required");
  assert.deepEqual(result.players, []);
  assert.equal(result.diagnostics.restrictedPositionCount, 1);
  assert.match(result.diagnostics.warnings.join(" "), /access-restricted/);
});

test("keeps expected teams whose visible lineup groups are empty", () => {
  const { document } = parseHTML(`
    <html>
      <head><title>Home FC vs Away FC | Expected 11</title></head>
      <body>
        <a class="match-view__team-label--home">Home FC</a>
        <a class="match-view__team-label--away">Away FC</a>
        <article>
          <h3>Home FC</h3>
          <section><h4>Starting</h4><ol></ol></section>
          <section><h4>Bench</h4><ol></ol></section>
          <section><h4>Out</h4><ol></ol></section>
        </article>
        <article>
          <h3>Away FC</h3>
          <section>
            <h4>Starting</h4>
            <ol><li><a href="/player/1/away-player">Away Player</a><span>70%</span></li></ol>
          </section>
          <section><h4>Bench</h4><ol></ol></section>
          <section><h4>Out</h4><ol></ol></section>
        </article>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/123/home-vs-away",
      extractedAt: "2026-08-10T20:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.deepEqual(
    result.teams.map((team) => ({
      side: team.side,
      name: team.name,
      players:
        team.lineup.starting.length + team.lineup.bench.length + team.lineup.out.length,
    })),
    [
      { side: "home", name: "Home FC", players: 0 },
      { side: "away", name: "Away FC", players: 1 },
    ],
  );
  assert.match(result.diagnostics.warnings.join(" "), /Home FC/);
});

test("cleans and flags visible placeholder player rows", () => {
  const { document } = parseHTML(`
    <html>
      <body>
        <a class="match-view__team-label--home">Home FC</a>
        <article>
          <h3>Home FC</h3>
          <section>
            <h4>Bench</h4>
            <ol><li>BE
Benjamin Amos ?
10%</li></ol>
          </section>
        </article>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/123/home-vs-away",
      extractedAt: "2026-08-10T20:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.equal(result.teams[0]?.lineup.bench[0]?.name, "Benjamin Amos");
  assert.match(result.diagnostics.warnings.join(" "), /placeholder markup/);
});

test("treats signed-out loading markup as login-required, not empty predictions", () => {
  const { document } = parseHTML(`
    <html>
      <body>
        <div class="layout-auth-controls__signed-out">
          <a href="/sign-in">Sign in</a>
        </div>
        <div class="match-view match-view--loading">
          <a class="match-view__team-label match-view__team-label--home">
            <span class="match-view__skeleton"></span>
          </a>
          <section class="match-view__panel" aria-label="Loading squads">
            <article class="match-view__squad-team" aria-label="Loading home team squad">
              <h3></h3>
              <section>
                <h4>Starting</h4>
                <ol>
                  <li aria-hidden="true"><span class="match-view__skeleton"></span></li>
                </ol>
              </section>
            </article>
          </section>
        </div>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/19729150/millwall-vs-norwich-city",
      extractedAt: "2026-08-19T16:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.equal(result.status, "login-required");
  assert.equal(result.diagnostics.signInVisible, true);
  assert.equal(result.diagnostics.pageLoading, true);
  assert.equal(result.players.length, 0);
  assert.equal(result.teams.length, 0);
});

test("keeps a match stub when teams are visible but XI percentages are not yet", () => {
  const { document } = parseHTML(`
    <html>
      <head><title>Millwall vs Norwich City | Expected 11</title></head>
      <body>
        <a class="match-view__team-label--home">Millwall</a>
        <a class="match-view__team-label--away">Norwich City</a>
        <article class="match-view__squad-team match-view__squad-team--home">
          <h3>Millwall</h3>
          <section><h4>Starting</h4><ol></ol></section>
          <section><h4>Bench</h4><ol></ol></section>
          <section><h4>Out</h4><ol></ol></section>
        </article>
        <article class="match-view__squad-team match-view__squad-team--away">
          <h3>Norwich City</h3>
          <section><h4>Starting</h4><ol></ol></section>
          <section><h4>Bench</h4><ol></ol></section>
          <section><h4>Out</h4><ol></ol></section>
        </article>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl: "https://expected11.com/match/19729150/millwall-vs-norwich-city",
      extractedAt: "2026-08-19T16:00:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.teams.map((team) => ({
      side: team.side,
      name: team.name,
      players:
        team.lineup.starting.length + team.lineup.bench.length + team.lineup.out.length,
    })),
    [
      { side: "home", name: "Millwall", players: 0 },
      { side: "away", name: "Norwich City", players: 0 },
    ],
  );
});

test("uses the visible percentage badge when a stale aria-label still says 80%", () => {
  const { document } = parseHTML(`
    <html>
      <head><title>Preston North End vs Wolverhampton Wanderers | Expected 11</title></head>
      <body>
        <a class="match-view__team-label--home">Preston North End</a>
        <a class="match-view__team-label--away">Wolverhampton Wanderers</a>
        <article class="match-view__squad-team match-view__squad-team--away">
          <h3>Wolverhampton Wanderers</h3>
          <section>
            <h4>Bench</h4>
            <ol>
              <li>
                <span aria-label="80% chance of starting the game">
                  <a href="/player/80902/ladislav-krejci">Ladislav Krejci</a>
                  <span>40%</span>
                </span>
              </li>
            </ol>
          </section>
        </article>
      </body>
    </html>
  `);
  const result = normalizeExpected11Snapshot(
    collectExpected11Snapshot(document.body, {
      sourceUrl:
        "https://expected11.com/match/19729149/preston-north-end-vs-wolverhampton-wanderers",
      extractedAt: "2026-08-21T13:20:00.000Z",
      assumeVisible: true,
    }),
  );

  assert.equal(result.teams[0]?.lineup.bench[0]?.name, "Ladislav Krejci");
  assert.equal(result.teams[0]?.lineup.bench[0]?.displayedPercentage, 40);
});
