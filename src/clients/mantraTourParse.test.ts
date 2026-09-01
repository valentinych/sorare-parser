import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMantraDeadlineLabel,
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
