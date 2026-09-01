import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db/index.js";
import {
  addLeagueOneMantraPositions,
  attachManualMappings,
  clearAllLeagueOneMantraPositions,
  fineTmPositions,
  getLeagueOneView,
  LeagueOneMappingError,
  matchLeagueOnePlayers,
  removeLeagueOneMantraPosition,
  removeLeagueOnePlayerMapping,
  saveLeagueOnePlayerMapping,
} from "./leagueOne.js";

test("fineTmPositions drops MID DEF ATT buckets", () => {
  assert.deepEqual(fineTmPositions(["CM", "MID", "DEF", "CB", "ATT", "ST"]), [
    "CM",
    "CB",
    "ST",
  ]);
  assert.deepEqual(fineTmPositions(["mid", "GK"]), ["GK"]);
});

test("links unique same-club name matches and leaves orphans", () => {
  const { players, fotmobOrphans } = matchLeagueOnePlayers(
    [
      {
        player_id: "1",
        name: "Bailey Peacock-Farrell",
        club_id: "10",
        club_name: "Blackpool FC",
        position: "MID",
        detail_role: "GK",
        detail_label: "GK",
        side_role: null,
      },
      {
        player_id: "2",
        name: "Unknown Prospect",
        club_id: "10",
        club_name: "Blackpool FC",
        position: "ATT",
        detail_role: "ST",
        detail_label: "CF",
        side_role: "LW",
      },
    ],
    [
      {
        id: 100,
        name: "Bailey Peacock-Farrell",
        teamId: 8483,
        teamName: "Blackpool",
        positionIdsDesc: "GK",
      },
      {
        id: 200,
        name: "Only On Fotmob",
        teamId: 8483,
        teamName: "Blackpool",
        positionIdsDesc: "CM",
      },
    ],
  );

  const linked = players.find((p) => p.tmPlayerId === "1");
  const unmatched = players.find((p) => p.tmPlayerId === "2");
  assert.equal(linked?.matchStatus, "linked");
  assert.equal(linked?.fotmobPlayerId, 100);
  assert.deepEqual(linked?.positions, ["GK"]);
  assert.equal(unmatched?.matchStatus, "unmatched");
  assert.deepEqual(unmatched?.positions, ["ST", "CF", "LW"]);
  assert.equal(fotmobOrphans.length, 1);
  assert.equal(fotmobOrphans[0]?.id, 200);
});

test("marks ambiguous when two FotMob names score at the same club", () => {
  const { players } = matchLeagueOnePlayers(
    [
      {
        player_id: "1",
        name: "John Smith",
        club_id: "10",
        club_name: "Barnsley",
        position: null,
        detail_role: "CM",
        detail_label: "CM",
        side_role: null,
      },
    ],
    [
      {
        id: 1,
        name: "John Smith",
        teamId: 1,
        teamName: "Barnsley",
        positionIdsDesc: "CM",
      },
      {
        id: 2,
        name: "John Smith",
        teamId: 1,
        teamName: "Barnsley",
        positionIdsDesc: "ST",
      },
    ],
  );
  assert.equal(players[0]?.matchStatus, "ambiguous");
  assert.equal(players[0]?.fotmobPlayerId, null);
  assert.ok((players[0]?.candidates.length ?? 0) >= 2);
});

test("marks ambiguous when two TM players claim the same FotMob id", () => {
  const { players } = matchLeagueOnePlayers(
    [
      {
        player_id: "1",
        name: "Alex Jones",
        club_id: "10",
        club_name: "Wigan",
        position: null,
        detail_role: "ST",
        detail_label: "CF",
        side_role: null,
      },
      {
        player_id: "2",
        name: "Alex Jones",
        club_id: "10",
        club_name: "Wigan Athletic",
        position: null,
        detail_role: "ST",
        detail_label: "CF",
        side_role: null,
      },
    ],
    [
      {
        id: 99,
        name: "Alex Jones",
        teamId: 1,
        teamName: "Wigan",
        positionIdsDesc: "ST",
      },
    ],
  );
  assert.equal(players.every((p) => p.matchStatus === "ambiguous"), true);
  assert.equal(players.every((p) => p.fotmobPlayerId == null), true);
});

test("additive mantra positions cap at three and support removal", () => {
  const db = getDb();
  db.exec(`DELETE FROM league_one_mantra_positions WHERE tm_player_id LIKE 'test-lo-%'`);
  const ids = ["test-lo-1", "test-lo-2"];
  let result = addLeagueOneMantraPositions(ids, ["CM", "AM"]);
  assert.equal(result.added, 4);
  assert.deepEqual(result.byPlayer["test-lo-1"], ["CM", "AM"]);
  result = addLeagueOneMantraPositions(["test-lo-1"], ["W", "ST", "FW"]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.byPlayer["test-lo-1"], ["CM", "AM", "W"]);
  const removed = removeLeagueOneMantraPosition("test-lo-1", "CM");
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.positions, ["AM", "W"]);
  const cleared = clearAllLeagueOneMantraPositions();
  assert.ok(cleared.cleared >= 3);
  assert.equal(clearAllLeagueOneMantraPositions().cleared, 0);
  db.exec(`DELETE FROM league_one_mantra_positions WHERE tm_player_id LIKE 'test-lo-%'`);
});

test("manual mapping links Mathew Stevens orphan to Matty Stevens TM", () => {
  const db = getDb();
  db.exec(`DELETE FROM league_one_player_mappings WHERE tm_player_id LIKE 'test-map-%'`);

  const { players, fotmobOrphans } = matchLeagueOnePlayers(
    [
      {
        player_id: "test-map-matty",
        name: "Matty Stevens",
        club_id: "3884",
        club_name: "AFC Wimbledon",
        position: "ATT",
        detail_role: "ST",
        detail_label: "CF",
        side_role: null,
      },
    ],
    [
      {
        id: 579057,
        name: "Mathew Stevens",
        teamId: 158319,
        teamName: "AFC Wimbledon",
        positionIdsDesc: "ST",
      },
    ],
  );
  assert.equal(players[0]?.matchStatus, "unmatched");
  assert.equal(fotmobOrphans.length, 1);

  const snapshot = {
    syncedAt: "2026-01-01T00:00:00.000Z",
    tmCompetition: "GB3",
    fotmobLeagueId: 108,
    counts: {
      tmPlayers: 1,
      fotmobPlayers: 1,
      linked: 0,
      unmatched: 1,
      ambiguous: 0,
      fotmobOrphans: 1,
    },
    players,
    fotmobOrphans,
  };

  saveLeagueOnePlayerMapping(
    { tmPlayerId: "test-map-matty", fotmobPlayerId: 579057 },
    1,
    snapshot,
  );
  const view = getLeagueOneView(snapshot);
  const linked = view.snapshot?.players[0];
  assert.equal(linked?.matchStatus, "linked");
  assert.equal(linked?.fotmobPlayerId, 579057);
  assert.equal(linked?.fotmobName, "Mathew Stevens");
  assert.equal(linked?.manualMapping, true);
  assert.equal(view.snapshot?.fotmobOrphans.length, 0);
  assert.equal(view.snapshot?.counts.linked, 1);
  assert.equal(view.snapshot?.counts.unmatched, 0);
  assert.equal(view.snapshot?.counts.fotmobOrphans, 0);

  const removed = removeLeagueOnePlayerMapping("test-map-matty");
  assert.equal(removed.removed, true);
  const after = attachManualMappings(snapshot);
  assert.equal(after.players[0]?.matchStatus, "unmatched");
  assert.equal(after.fotmobOrphans.length, 1);

  assert.throws(
    () =>
      saveLeagueOnePlayerMapping(
        { tmPlayerId: "missing", fotmobPlayerId: 579057 },
        1,
        snapshot,
      ),
    (err: unknown) =>
      err instanceof LeagueOneMappingError &&
      err.message === "league_one_tm_player_not_found",
  );

  db.exec(`DELETE FROM league_one_player_mappings WHERE tm_player_id LIKE 'test-map-%'`);
});
