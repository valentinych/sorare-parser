import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMantraDeadlineLabel,
  parseMantraMatchHtml,
  parseMantraTourHtml,
} from "./mantraAuth.js";

test("parseMantraDeadlineLabel treats wall time as Europe/Rome", () => {
  const now = new Date("2026-08-26T10:00:00Z");
  assert.equal(parseMantraDeadlineLabel("Fri, Aug 28 at 19:15", now), "2026-08-28T17:15:00.000Z");
  assert.equal(parseMantraDeadlineLabel("nope", now), null);
});

test("parseMantraTourHtml reads unlocked pairs and lineup deadline", () => {
  const html = `
    <div class="league-name-text">A1 | Rome</div>
    <div class="round-title-number">2</div>
    <div class="round-deadline">
      <div class="round-deadline-text">☠️ Deadline:</div>
      <div class="round-deadline-value">Fri, Aug 28 at 19:15</div>
    </div>
    <div class="round-match-item round-match-unlocked">
      <div class="round-match-team round-match-host">
        <a href="/teams/107"><div class="results-team-name">Batyari</div></a>
      </div>
      <div class="round-match-vs round-match-vs-set_lineup">
        <a href="/matches/93888">vs</a>
      </div>
      <div class="round-match-team round-match-guest">
        <a href="/teams/2009"><div class="results-team-name">GianlucaDuaLipa</div></a>
      </div>
    </div>
  `;
  const tour = parseMantraTourHtml(23292, html, { leagueId: 742, division: "A1", name: "Rome" });
  assert.equal(tour.round, 2);
  assert.equal(tour.matches.length, 1);
  assert.equal(tour.matches[0]?.locked, false);
  assert.equal(tour.matches[0]?.matchId, 93888);
  assert.equal(tour.deadlineLabel, "Fri, Aug 28 at 19:15");
  assert.equal(
    tour.deadline,
    parseMantraDeadlineLabel("Fri, Aug 28 at 19:15"),
  );
});

test("parseMantraTourHtml reads official TS and football score from a locked pair", () => {
  const html = `
    <div class="league-name-text">A1 | Rome</div>
    <div class="round-title-number">6</div>
    <div class="round-match-item round-match-locked">
      <div class="round-match-team round-match-host">
        <a href="/teams/107"><div class="results-team-name">Batyari</div></a>
      </div>
      <div class="round-match-host-score">
        <div class="round-match-total-score">73.8</div>
        <div class="round-match-scores-count">11</div>
      </div>
      <div class="round-match-result">
        <div class="round-match-host-goals">2</div>
        <a href="/matches/93888">2:1</a>
        <div class="round-match-guest-goals">1</div>
      </div>
      <div class="round-match-guest-score">
        <div class="round-match-total-score">71.2</div>
        <div class="round-match-scores-count">11</div>
      </div>
      <div class="round-match-team round-match-guest">
        <a href="/teams/2009"><div class="results-team-name">GianlucaDuaLipa</div></a>
      </div>
    </div>
  `;
  const tour = parseMantraTourHtml(23292, html, { leagueId: 742, division: "A1", name: "Rome" });
  assert.equal(tour.matches.length, 1);
  assert.equal(tour.matches[0]?.locked, true);
  assert.equal(tour.matches[0]?.home.score, 73.8);
  assert.equal(tour.matches[0]?.away.score, 71.2);
  assert.equal(tour.matches[0]?.home.goals, 2);
  assert.equal(tour.matches[0]?.away.goals, 1);
});

test("parseMantraMatchHtml uses GW total, not the club chip in score-unspecified", () => {
  const player = `
    <div class="match-player-item">
      <a href="/players/8145"><div class="team-player-name">
        Gorokh Valentyn
        <div class="team-player-score-unspecified inline-block">Veres</div>
      </div></a>
      <div class="team-player-scores">
        <div class="team-player-score">9.8</div>
        <div class="team-player-total-score">12.3</div>
      </div>
    </div>
    <div class="match-player-item">
      <a href="/players/1"><div class="team-player-name">Bench
        <div class="team-player-score-unspecified inline-block">Kolos</div>
      </div></a>
      <div class="team-player-score-not-played"></div>
    </div>`;
  const html = `
    <div class="match-host"><a href="/teams/1"><div class="match-team-name">Home</div></a></div>
    <div class="match-result">
      <div class="round-match-score">80.7</div>
      <div class="round-match-score">84.6</div>
    </div>
    <div class="match-guest"><a href="/teams/2"><div class="match-team-name">Away</div></a></div>
    <div class="match-team-squad"><div class="match-main-squad">${player}</div></div>
    <div class="match-team-squad"><div class="match-main-squad">${player}</div></div>
  `;
  const match = parseMantraMatchHtml(72197, html);
  assert.equal(match.home.squad[0]?.playerId, 8145);
  assert.equal(match.home.squad[0]?.scoreLabel, "12.3");
  assert.equal(match.home.squad[0]?.baseLabel, "9.8");
  assert.equal(match.home.squad[1]?.scoreLabel, null);
});
