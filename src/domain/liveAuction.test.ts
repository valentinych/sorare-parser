import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { config } from "../config.js";
import {
  LiveAuctionError,
  bidLiveAuction,
  correctLiveAuctionAward,
  foldLiveAuction,
  getLiveAuctionRoom,
  nominateLiveAuctionPlayer,
  parseTeamName,
  releaseLiveAuctionPlayer,
  resetLiveAuction,
  searchLiveAuctionPlayers,
  setLiveAuctionTeamName,
  shuffleInPlace,
  startLiveAuction,
  stopLiveAuction,
  autopickLiveAuction,
} from "./liveAuction.js";
import {
  LIVE_DRAFT_ONLINE_MS,
  recordLiveDraftHeartbeat,
  resetLiveDraftPresence,
} from "./liveDraftPresence.js";

const admin = "aharodnik@gmail.com";
const other = "owner@example.com";

function memoryDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE live_draft (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      configured INTEGER NOT NULL DEFAULT 0,
      league TEXT NOT NULL DEFAULT 'premier-league',
      status TEXT NOT NULL DEFAULT 'unconfigured',
      participants_json TEXT NOT NULL DEFAULT '[]',
      rules_json TEXT,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO live_draft (id) VALUES (1);
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY,
      email TEXT,
      name TEXT,
      mantra_manager_id INTEGER
    );
    INSERT INTO app_users (id, email, name, mantra_manager_id) VALUES
      (1, '${admin}', 'Ruslan', 205),
      (2, '${other}', 'Owner', NULL);
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT,
      first_name TEXT,
      positions_json TEXT,
      club_name TEXT,
      club_logo TEXT,
      avatar_path TEXT,
      tournament_id INTEGER
    );
    INSERT INTO mantra_players
      (id, name, full_name, positions_json, club_name, tournament_id)
    VALUES
      (10, 'Salah', 'Mohamed Salah', '["W","FW"]', 'Liverpool', 2),
      (11, 'Haaland', 'Erling Haaland', '["ST"]', 'Manchester City', 2),
      (12, 'Alisson', 'Alisson', '["GK"]', 'Liverpool', 2),
      (13, 'Raya', 'David Raya', '["GK"]', 'Arsenal', 2),
      (14, 'Pope', 'Nick Pope', '["GK"]', 'Newcastle', 2),
      (99, 'Lewandowski', 'Robert Lewandowski', '["ST"]', 'Barcelona', 12);
  `);
  return database;
}

function withAllowlist(fn: () => void) {
  const original = new Set(config.liveDraftEmails);
  config.liveDraftEmails.clear();
  config.liveDraftEmails.add(admin);
  config.liveDraftEmails.add(other);
  try {
    fn();
  } finally {
    config.liveDraftEmails.clear();
    for (const email of original) config.liveDraftEmails.add(email);
  }
}

test("live auction start, bid step, hammer award, and budget/squad rules", () => {
  withAllowlist(() => {
    const db = memoryDb();
    const clock = { now: () => 1_000 };
    assert.throws(
      () => startLiveAuction(other, db),
      (error: unknown) => error instanceof LiveAuctionError && error.code === "not_admin",
    );
    const started = startLiveAuction(admin, db, [admin, other]);
    assert.equal(started.status, "running");
    assert.equal(started.yourTurn, true);
    assert.equal(started.managers.length, 2);
    assert.equal(started.managers[0]?.budgetLeft, 260);

    const again = startLiveAuction(admin, db, [admin, other]);
    assert.equal(again.status, "running");

    const nominated = nominateLiveAuctionPlayer(admin, 10, 5, db, clock);
    assert.equal(nominated.lot?.highBid, 5);
    assert.equal(nominated.lot?.minNextBid, 6);

    assert.throws(
      () => bidLiveAuction(other, 5, db, clock),
      (error: unknown) => error instanceof LiveAuctionError && error.code === "bid_too_low",
    );
    const raised = bidLiveAuction(other, 6, db, clock);
    assert.equal(raised.lot?.highBidder, other);
    assert.equal(raised.lot?.highBid, 6);
    const same = bidLiveAuction(other, 6, db, clock);
    assert.equal(same.lot?.highBid, 6);

    clock.now = () => 1_000 + 14_999;
    assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.highBid, 6);
    clock.now = () => 1_000 + 15_000;
    const sold = getLiveAuctionRoom(admin, db, clock);
    assert.equal(sold.lot, null);
    assert.equal(sold.managers.find((manager) => manager.email === other)?.spent, 6);
    assert.equal(sold.managers.find((manager) => manager.email === other)?.budgetLeft, 254);
    const buyerSquad = sold.managers.find((manager) => manager.email === other)?.squad;
    assert.equal(buyerSquad?.length, 1);
    assert.equal(buyerSquad?.[0]?.name, "Mohamed Salah");
    assert.equal(buyerSquad?.[0]?.clubName, "Liverpool");
    assert.deepEqual(buyerSquad?.[0]?.positions, ["W", "FW"]);
    assert.equal(buyerSquad?.[0]?.amount, 6);
    assert.deepEqual(sold.managers.find((manager) => manager.email === admin)?.squad, []);
    assert.equal(sold.yourTurn, false);
    assert.equal(sold.nominator, other);

    assert.equal(searchLiveAuctionPlayers("salah", db).length, 0);
    assert.equal(searchLiveAuctionPlayers("haal", db)[0]?.id, 11);
    assert.equal(searchLiveAuctionPlayers("lewa", db).length, 0);

    const listed = searchLiveAuctionPlayers("", db, () => 0);
    const listedIds = listed.map((player) => player.id);
    assert.equal(listedIds.includes(10), false);
    assert.equal(listedIds.includes(99), false);
    assert.deepEqual([...listedIds].sort((left, right) => left - right), [11, 12, 13, 14]);
    assert.notDeepEqual(listedIds, [11, 12, 13, 14]);
    assert.equal(
      searchLiveAuctionPlayers("alis", db).some((player) => player.id === 10),
      false,
    );

    assert.throws(
      () => nominateLiveAuctionPlayer(other, 11, 231, db, clock),
      (error: unknown) => error instanceof LiveAuctionError && error.code === "bid_over_max",
    );
    nominateLiveAuctionPlayer(other, 11, 230, db, clock);
    clock.now = () => 1_000 + 30_000;
    const expensive = getLiveAuctionRoom(other, db, clock);
    assert.equal(expensive.managers.find((manager) => manager.email === other)?.budgetLeft, 24);

    const reset = resetLiveAuction(admin, db);
    assert.equal(reset.status, "lobby");
    assert.equal(reset.managers.every((manager) => manager.spent === 0), true);
  });
});

test("live auction blocks an outfield pickup that cannot still reach 3 GKs", () => {
  withAllowlist(() => {
    const db = memoryDb();
    for (let id = 100; id < 123; id++) {
      db.prepare(
        `INSERT INTO mantra_players (id, name, positions_json, tournament_id)
         VALUES (?, ?, '["CM"]', 2)`,
      ).run(id, `Mid ${id}`);
    }
    startLiveAuction(admin, db, [admin, other]);
    const clock = { now: () => 0 };
    const insert = db.prepare(
      `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
       VALUES (?, ?, 1, 0, '2026-08-18T00:00:00.000Z')`,
    );
    for (let id = 100; id < 123; id++) insert.run(id, admin);
    const stats = getLiveAuctionRoom(admin, db).managers.find(
      (manager) => manager.email === admin,
    );
    assert.equal(stats?.squadSize, 23);
    assert.equal(stats?.goalkeepers, 0);
    assert.throws(
      () => nominateLiveAuctionPlayer(admin, 11, 1, db, clock),
      (error: unknown) => error instanceof LiveAuctionError && error.code === "need_goalkeepers",
    );
    const gk = nominateLiveAuctionPlayer(admin, 12, 1, db, clock);
    assert.equal(gk.lot?.player.goalkeeper, true);
  });
});

test("live auction picker shuffle is not sorted by id", () => {
  const ids = [10, 11, 12, 13, 14];
  assert.notDeepEqual(shuffleInPlace([...ids], () => 0), ids);
  assert.deepEqual(
    [...shuffleInPlace([...ids], () => 0)].sort((left, right) => left - right),
    ids,
  );
});

test("live auction team name persists, validates, and is owner-only", () => {
  withAllowlist(() => {
    const db = memoryDb();
    startLiveAuction(admin, db, [admin, other]);
    assert.equal(parseTeamName("<b>Tigers</b>"), "Tigers");
    assert.throws(
      () => parseTeamName("x".repeat(41)),
      (error: unknown) =>
        error instanceof LiveAuctionError && error.code === "invalid_team_name",
    );
    const saved = setLiveAuctionTeamName(admin, "<b>Tigers FC</b>", db);
    assert.equal(
      saved.managers.find((manager) => manager.email === admin)?.name,
      "Tigers FC",
    );
    assert.equal(
      saved.managers.find((manager) => manager.email === admin)?.teamName,
      "Tigers FC",
    );
    assert.deepEqual(saved.namedTeams, [
      { email: admin, teamName: "Tigers FC", squadId: null },
    ]);
    assert.equal(saved.yourTeamName, "Tigers FC");
    assert.equal(
      saved.managers.find((manager) => manager.email === other)?.name,
      "Owner",
    );
    assert.throws(
      () => setLiveAuctionTeamName(other, "Hacked", db, admin),
      (error: unknown) =>
        error instanceof LiveAuctionError &&
        error.code === "not_owner" &&
        error.status === 403,
    );
    assert.equal(getLiveAuctionRoom(admin, db).yourTeamName, "Tigers FC");
    const cleared = setLiveAuctionTeamName(admin, "  ", db);
    assert.equal(cleared.yourTeamName, "");
    assert.equal(
      cleared.managers.find((manager) => manager.email === admin)?.name,
      "Ruslan",
    );
  });
});

test("lobby room lists allowlisted managers and named teams", () => {
  withAllowlist(() => {
    resetLiveDraftPresence();
    const db = memoryDb();
    const lobby = getLiveAuctionRoom(admin, db);
    assert.equal(lobby.status, "lobby");
    assert.equal(lobby.managers.length, 2);
    assert.equal(lobby.managers.every((manager) => manager.online === false), true);
    assert.equal(lobby.managers.every((manager) => manager.pingMs === null), true);
    recordLiveDraftHeartbeat(admin, 55);
    const online = getLiveAuctionRoom(other, db);
    assert.equal(online.managers.find((manager) => manager.email === admin)?.online, true);
    assert.equal(online.managers.find((manager) => manager.email === admin)?.pingMs, 55);
    assert.equal(online.managers.find((manager) => manager.email === other)?.online, false);
    assert.deepEqual(lobby.namedTeams, []);
    assert.equal(
      lobby.managers.find((manager) => manager.email === other)?.teamName,
      "",
    );
    setLiveAuctionTeamName(admin, "Tigers FC", db);
    const named = getLiveAuctionRoom(other, db);
    assert.equal(
      named.managers.find((manager) => manager.email === admin)?.teamName,
      "Tigers FC",
    );
    assert.deepEqual(named.namedTeams, [
      { email: admin, teamName: "Tigers FC", squadId: null },
    ]);
    assert.equal(
      named.managers.find((manager) => manager.email === other)?.teamName,
      "",
    );
  });
});

test("room managers expose persisted Mantra squad IDs", () => {
  withAllowlist(() => {
    const db = memoryDb();
    startLiveAuction(admin, db, [admin, other]);
    setLiveAuctionTeamName(admin, "Loch Ness FC", db);
    db.prepare(
      `UPDATE live_auction_team_names SET squad_id = 5009 WHERE lower(email) = ?`,
    ).run(admin);
    const room = getLiveAuctionRoom(admin, db);
    assert.equal(
      room.managers.find((manager) => manager.email === admin)?.squadId,
      5009,
    );
    assert.equal(
      room.managers.find((manager) => manager.email === other)?.squadId,
      null,
    );
    assert.deepEqual(room.namedTeams, [
      { email: admin, teamName: "Loch Ness FC", squadId: 5009 },
    ]);
    const cleared = setLiveAuctionTeamName(admin, "  ", db);
    assert.equal(cleared.yourTeamName, "");
    assert.equal(
      cleared.managers.find((manager) => manager.email === admin)?.squadId,
      5009,
    );
    assert.equal(
      (
        db
          .prepare(`SELECT squad_id FROM live_auction_team_names WHERE lower(email) = ?`)
          .get(admin) as { squad_id: number }
      ).squad_id,
      5009,
    );
  });
});

test("room managers expose Mantra manager IDs from app_users", () => {
  withAllowlist(() => {
    const db = memoryDb();
    const lobby = getLiveAuctionRoom(admin, db);
    assert.equal(
      lobby.managers.find((manager) => manager.email === admin)?.mantraManagerId,
      205,
    );
    assert.equal(
      lobby.managers.find((manager) => manager.email === other)?.mantraManagerId,
      null,
    );
    db.prepare(
      `UPDATE app_users SET mantra_manager_id = 67 WHERE email = ?`,
    ).run(other);
    const filled = getLiveAuctionRoom(admin, db);
    assert.equal(
      filled.managers.find((manager) => manager.email === other)?.mantraManagerId,
      67,
    );
  });
});

const third = "third@example.com";
const eight = [
  admin,
  other,
  "m2@example.com",
  "m3@example.com",
  "m4@example.com",
  "m5@example.com",
  "m6@example.com",
  "m7@example.com",
];

test("outbid resets the 15s hammer and nomination rotates after the lot", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other]);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  clock.now = () => 5_000;
  const raised = bidLiveAuction(other, 2, db, clock);
  assert.equal(raised.lot?.highBidder, other);
  clock.now = () => 15_000;
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.highBid, 2);
  clock.now = () => 20_000;
  const sold = getLiveAuctionRoom(admin, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.nominator, other);
  assert.equal(sold.yourTurn, false);
  const next = getLiveAuctionRoom(other, db, clock);
  assert.equal(next.yourTurn, true);
});

test("fold leaves a manager out of the lot and rejects their bids", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other, third]);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  const folded = foldLiveAuction(other, db, clock);
  assert.equal(folded.lot?.youFolded, true);
  assert.equal(folded.lot?.foldCount, 1);
  assert.equal(folded.managers.find((manager) => manager.email === other)?.folded, true);
  assert.equal(folded.lot?.highBidder, admin);
  assert.throws(
    () => bidLiveAuction(other, 2, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "folded",
  );
  const again = foldLiveAuction(other, db, clock);
  assert.equal(again.lot?.foldCount, 1);
  assert.equal(getLiveAuctionRoom(third, db, clock).lot?.youFolded, false);
  const raised = bidLiveAuction(third, 2, db, clock);
  assert.equal(raised.lot?.highBidder, third);
  assert.equal(raised.lot?.foldCount, 1);
});

test("seven folds hammer immediately to the high bidder and rotate nominator", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, eight);
  nominateLiveAuctionPlayer(admin, 10, 5, db, clock);
  for (const email of eight.slice(1, 7)) {
    foldLiveAuction(email, db, clock);
  }
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.foldCount, 6);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.highBidder, admin);
  const sold = foldLiveAuction(eight[7]!, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.managers.find((manager) => manager.email === admin)?.spent, 5);
  assert.equal(sold.nominator, other);
  const next = getLiveAuctionRoom(other, db, clock);
  assert.equal(next.yourTurn, true);
});

test("max bid reserves 1 credit per remaining slot after this win", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other], clock);
  assert.throws(
    () => nominateLiveAuctionPlayer(admin, 10, 236, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "bid_over_max",
  );
  const first = nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  assert.equal(first.yourMaxBid, 235);
  assert.equal(first.lot?.youMaxBid, 235);
  assert.throws(
    () => bidLiveAuction(other, 236, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "bid_over_max",
  );
  const raised = bidLiveAuction(other, 235, db, clock);
  assert.equal(raised.lot?.highBid, 235);
  clock.now = () => 15_000;
  assert.equal(getLiveAuctionRoom(other, db, clock).lot, null);

  const midDb = memoryDb();
  const midClock = { now: () => 0 };
  startLiveAuction(admin, midDb, [admin, other], midClock);
  for (let id = 200; id < 210; id++) {
    midDb
      .prepare(
        `INSERT INTO mantra_players (id, name, positions_json, tournament_id)
         VALUES (?, ?, '["CM"]', 2)`,
      )
      .run(id, `Mid ${id}`);
    midDb
      .prepare(
        `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
         VALUES (?, ?, 18, 0, '2026-08-18T00:00:00.000Z')`,
      )
      .run(id, other);
  }
  nominateLiveAuctionPlayer(admin, 10, 1, midDb, midClock);
  const midRoom = getLiveAuctionRoom(other, midDb, midClock);
  assert.equal(midRoom.yourMaxBid, 65);
  assert.throws(
    () => bidLiveAuction(other, 66, midDb, midClock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "bid_over_max",
  );
  assert.equal(bidLiveAuction(other, 65, midDb, midClock).lot?.highBid, 65);

  const lastDb = memoryDb();
  const lastClock = { now: () => 0 };
  startLiveAuction(admin, lastDb, [admin, other], lastClock);
  for (let id = 200; id < 225; id++) {
    lastDb
      .prepare(
        `INSERT INTO mantra_players (id, name, positions_json, tournament_id)
         VALUES (?, ?, ?, 2)`,
      )
      .run(id, `Slot ${id}`, id < 203 ? '["GK"]' : '["CM"]');
    lastDb
      .prepare(
        `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
         VALUES (?, ?, 1, 0, '2026-08-18T00:00:00.000Z')`,
      )
      .run(id, other);
  }
  nominateLiveAuctionPlayer(admin, 10, 1, lastDb, lastClock);
  const lastRoom = getLiveAuctionRoom(other, lastDb, lastClock);
  assert.equal(lastRoom.managers.find((manager) => manager.email === other)?.squadSize, 25);
  assert.equal(lastRoom.yourMaxBid, 235);
  assert.equal(bidLiveAuction(other, 235, lastDb, lastClock).lot?.highBid, 235);
});

test("high bidder cannot fold; new nomination clears previous folds", () => {
  const db = memoryDb();
  const clock = { now: () => 1_000 };
  startLiveAuction(admin, db, eight);
  nominateLiveAuctionPlayer(admin, 10, 8, db, clock);
  assert.throws(
    () => foldLiveAuction(admin, db, clock),
    (error: unknown) =>
      error instanceof LiveAuctionError &&
      error.code === "leader_cannot_fold" &&
      error.status === 403,
  );
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.youFolded, false);
  foldLiveAuction(other, db, clock);
  assert.equal(getLiveAuctionRoom(other, db, clock).lot?.youFolded, true);
  clock.now = () => 16_000;
  const sold = getLiveAuctionRoom(other, db, clock);
  assert.equal(sold.lot, null);
  const next = nominateLiveAuctionPlayer(other, 11, 1, db, clock);
  assert.equal(next.lot?.foldCount, 0);
  assert.equal(next.lot?.youFolded, false);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.youFolded, false);
  assert.equal(getLiveAuctionRoom(other, db, clock).lot?.youAreLeader, true);
});

test("reset clears folds and the nomination turn", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, eight);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  foldLiveAuction(other, db, clock);
  const reset = resetLiveAuction(admin, db);
  assert.equal(reset.status, "lobby");
  assert.equal(reset.lot, null);
  startLiveAuction(admin, db, eight);
  const nominated = nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  assert.equal(nominated.lot?.foldCount, 0);
  assert.equal(nominated.lot?.youFolded, false);
  assert.equal(nominated.nominator, admin);
  assert.equal(nominated.yourTurn, false);
});

test("STOP freezes remaining hammer time and rejects bids until admin resumes", () => {
  resetLiveDraftPresence();
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  clock.now = () => 5_000;
  const stopped = stopLiveAuction(other, db, clock);
  assert.equal(stopped.paused, true);
  assert.equal(stopped.pauseReason, "stop");
  assert.equal(stopped.lot?.hammerRemainingMs, 10_000);
  clock.now = () => 20_000;
  const frozen = getLiveAuctionRoom(admin, db, clock);
  assert.equal(frozen.paused, true);
  assert.equal(frozen.lot?.highBid, 1);
  assert.equal(frozen.lot?.hammerRemainingMs, 10_000);
  const again = stopLiveAuction(admin, db, clock);
  assert.equal(again.lot?.hammerRemainingMs, 10_000);
  assert.throws(
    () => bidLiveAuction(other, 2, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "auction_paused",
  );
  assert.throws(
    () => foldLiveAuction(other, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "auction_paused",
  );
  assert.throws(
    () => startLiveAuction(other, db, [admin, other], clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "not_admin",
  );
  const resumed = startLiveAuction(admin, db, [admin, other], clock);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.pauseReason, null);
  assert.equal(resumed.lot?.hammerRemainingMs, 10_000);
  clock.now = () => 29_999;
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.highBid, 1);
  clock.now = () => 30_000;
  const sold = getLiveAuctionRoom(admin, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.nominator, other);
});

test("offline manager pauses the lot and admin force-start keeps remaining seconds", () => {
  resetLiveDraftPresence();
  const db = memoryDb();
  let now = 0;
  const clock = { now: () => now };
  recordLiveDraftHeartbeat(admin, 1, 0);
  recordLiveDraftHeartbeat(other, 1, 0);
  startLiveAuction(admin, db, [admin, other], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  now = 4_000;
  bidLiveAuction(other, 2, db, clock);
  recordLiveDraftHeartbeat(admin, 1, 4_000);
  now = LIVE_DRAFT_ONLINE_MS + 1;
  const paused = getLiveAuctionRoom(admin, db, clock);
  assert.equal(paused.paused, true);
  assert.equal(paused.pauseReason, "offline");
  assert.equal(paused.lot?.highBid, 2);
  assert.equal(paused.lot?.hammerRemainingMs, 3_999);
  recordLiveDraftHeartbeat(other, 1, now);
  now = 16_000;
  const still = getLiveAuctionRoom(admin, db, clock);
  assert.equal(still.paused, true);
  assert.equal(still.lot?.hammerRemainingMs, 3_999);
  const resumed = startLiveAuction(admin, db, [admin, other], clock);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.lot?.hammerRemainingMs, 3_999);
});

test("seven folds and outbid still work after admin resume", () => {
  resetLiveDraftPresence();
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, eight, clock);
  nominateLiveAuctionPlayer(admin, 10, 5, db, clock);
  stopLiveAuction(other, db, clock);
  startLiveAuction(admin, db, eight, clock);
  for (const email of eight.slice(1, 7)) {
    foldLiveAuction(email, db, clock);
  }
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.foldCount, 6);
  const sold = foldLiveAuction(eight[7]!, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.managers.find((manager) => manager.email === admin)?.spent, 5);
  assert.equal(sold.nominator, other);
  nominateLiveAuctionPlayer(other, 11, 1, db, clock);
  stopLiveAuction(admin, db, clock);
  clock.now = () => 8_000;
  startLiveAuction(admin, db, eight, clock);
  const raised = bidLiveAuction(admin, 2, db, clock);
  assert.equal(raised.lot?.highBidder, admin);
  clock.now = () => 8_000 + 14_999;
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.highBid, 2);
  clock.now = () => 8_000 + 15_000;
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot, null);
});

test("reset clears pause as part of clearing the board", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other], clock);
  stopLiveAuction(other, db, clock);
  const reset = resetLiveAuction(admin, db);
  assert.equal(reset.status, "lobby");
  assert.equal(reset.paused, false);
  assert.equal(reset.pauseReason, null);
  assert.equal(reset.lot, null);
});

test("admin can nominate and bid as another manager; non-admin cannot", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other, third], clock);
  assert.throws(
    () => nominateLiveAuctionPlayer(other, 10, 1, db, clock, admin),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "not_admin" && error.status === 403,
  );
  const nominated = nominateLiveAuctionPlayer(admin, 10, 1, db, clock, other);
  assert.equal(nominated.admin, true);
  assert.equal(nominated.you, admin);
  assert.equal(nominated.lot?.nominator, other);
  assert.equal(nominated.lot?.highBidder, other);
  assert.equal(nominated.lot?.highBid, 1);
  assert.throws(
    () => bidLiveAuction(other, 2, db, clock, admin),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "not_admin" && error.status === 403,
  );
  const raised = bidLiveAuction(admin, 2, db, clock);
  assert.equal(raised.lot?.highBidder, admin);
  assert.equal(raised.lot?.highBid, 2);
  const proxyBid = bidLiveAuction(admin, 3, db, clock, other);
  assert.equal(proxyBid.lot?.highBidder, other);
  assert.equal(proxyBid.lot?.highBid, 3);
  bidLiveAuction(admin, 4, db, clock);
  foldLiveAuction(other, db, clock);
  assert.throws(
    () => bidLiveAuction(admin, 5, db, clock, other),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "folded",
  );
});

test("admin can correct sold player price and owner; unique player stays unique", () => {
  const db = memoryDb();
  const clock = { now: () => 0 };
  startLiveAuction(admin, db, [admin, other], clock);
  nominateLiveAuctionPlayer(admin, 10, 5, db, clock);
  bidLiveAuction(other, 6, db, clock);
  clock.now = () => 15_000;
  const sold = getLiveAuctionRoom(admin, db, clock);
  assert.equal(sold.managers.find((manager) => manager.email === other)?.spent, 6);
  assert.throws(
    () => correctLiveAuctionAward(other, 10, { amount: 8 }, db),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "not_admin" && error.status === 403,
  );
  const repriced = correctLiveAuctionAward(admin, 10, { amount: 20 }, db);
  assert.equal(repriced.managers.find((manager) => manager.email === other)?.spent, 20);
  assert.equal(repriced.managers.find((manager) => manager.email === other)?.budgetLeft, 240);
  assert.equal(
    repriced.managers.find((manager) => manager.email === other)?.squad?.[0]?.amount,
    20,
  );
  db.prepare(
    `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
     VALUES (11, ?, 250, 0, '2026-08-18T00:00:00.000Z')`,
  ).run(other);
  assert.throws(
    () => correctLiveAuctionAward(admin, 10, { amount: 11 }, db),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "budget_exceeded",
  );
  db.prepare(`DELETE FROM live_auction_awards WHERE player_id = 11`).run();
  const moved = correctLiveAuctionAward(admin, 10, { email: admin, amount: 9 }, db);
  const adminSquad = moved.managers.find((manager) => manager.email === admin)?.squad ?? [];
  const otherSquad = moved.managers.find((manager) => manager.email === other)?.squad ?? [];
  assert.equal(adminSquad.length, 1);
  assert.equal(adminSquad[0]?.id, 10);
  assert.equal(adminSquad[0]?.amount, 9);
  assert.deepEqual(otherSquad, []);
  assert.equal(moved.managers.find((manager) => manager.email === admin)?.spent, 9);
  assert.equal(moved.managers.find((manager) => manager.email === other)?.spent, 0);
  assert.equal(searchLiveAuctionPlayers("salah", db).length, 0);
  assert.equal(
    moved.managers.flatMap((manager) => manager.squad || []).filter((player) => player.id === 10)
      .length,
    1,
  );
  assert.throws(
    () => nominateLiveAuctionPlayer(admin, 10, 1, db, clock),
    (error: unknown) => error instanceof LiveAuctionError && error.code === "player_sold",
  );
});

test("admin can release one sold player without wiping bids or other awards", () => {
  withAllowlist(() => {
    const db = memoryDb();
    const clock = { now: () => 0 };
    startLiveAuction(admin, db, [admin, other], clock);
    nominateLiveAuctionPlayer(admin, 10, 5, db, clock);
    bidLiveAuction(other, 6, db, clock);
    clock.now = () => 15_000;
    getLiveAuctionRoom(admin, db, clock);
    nominateLiveAuctionPlayer(admin, 12, 2, db, clock);
    bidLiveAuction(other, 3, db, clock);
    const before = getLiveAuctionRoom(admin, db, clock);
    assert.equal(before.lot?.highBid, 3);
    assert.equal(before.lot?.id, 2);
    const bidCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM live_auction_bids`).get() as { n: number }
    ).n;
    const awardCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM live_auction_awards`).get() as { n: number }
    ).n;
    const lotCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM live_auction_lots`).get() as { n: number }
    ).n;
    assert.equal(awardCountBefore, 1);
    assert.throws(
      () => releaseLiveAuctionPlayer(other, 10, other, db, clock),
      (error: unknown) =>
        error instanceof LiveAuctionError && error.code === "not_admin" && error.status === 403,
    );
    assert.throws(
      () => releaseLiveAuctionPlayer(admin, 10, admin, db, clock),
      (error: unknown) =>
        error instanceof LiveAuctionError && error.code === "player_not_on_roster",
    );
    const released = releaseLiveAuctionPlayer(admin, 10, other, db, clock);
    assert.deepEqual(
      released.managers.find((manager) => manager.email === other)?.squad,
      [],
    );
    assert.equal(released.managers.find((manager) => manager.email === other)?.spent, 0);
    assert.equal(released.lot?.id, 2);
    assert.equal(released.lot?.highBid, 3);
    assert.equal(released.lot?.highBidder, other);
    assert.equal(released.status, "running");
    assert.equal(released.nominator, before.nominator);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM live_auction_bids`).get() as { n: number }).n,
      bidCountBefore,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM live_auction_lots`).get() as { n: number }).n,
      lotCountBefore,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM live_auction_awards`).get() as { n: number }).n,
      0,
    );
    assert.equal(
      (
        db
          .prepare(`SELECT high_bid, status FROM live_auction_lots WHERE id = 2`)
          .get() as { high_bid: number; status: string }
      ).high_bid,
      3,
    );
    assert.ok(searchLiveAuctionPlayers("salah", db).some((player) => player.id === 10));
    assert.throws(
      () => nominateLiveAuctionPlayer(admin, 10, 1, db, clock),
      (error: unknown) =>
        error instanceof LiveAuctionError && error.code === "lot_already_open",
    );
    db.prepare(
      `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
       VALUES (11, ?, 4, 1, '2026-08-20T00:00:00.000Z')`,
    ).run(other);
    db.prepare(`UPDATE live_draft SET status = 'complete'`).run();
    const reopened = releaseLiveAuctionPlayer(admin, 11, other, db, clock);
    assert.equal(reopened.status, "running");
    assert.equal(reopened.lot?.highBid, 3);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM live_auction_awards`).get() as { n: number }).n,
      0,
    );
  });
});

function spendAlmostAll(
  db: Database.Database,
  email: string,
  playerId: number,
  amount = 259,
) {
  db.prepare(
    `INSERT INTO mantra_players (id, name, positions_json, tournament_id)
     VALUES (?, ?, '["CM"]', 2)`,
  ).run(playerId, `Spent ${playerId}`);
  db.prepare(
    `INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
     VALUES (?, ?, ?, 0, '2026-08-20T00:00:00.000Z')`,
  ).run(playerId, email, amount);
}

test("autopick appears only when remaining rivals cannot overbid, then hammers like the 15s timer", () => {
  resetLiveDraftPresence();
  const db = memoryDb();
  const clock = { now: () => 1_000 };
  startLiveAuction(admin, db, [admin, other, third], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.canAutopick, false);
  spendAlmostAll(db, other, 500);
  spendAlmostAll(db, third, 501);
  const ready = getLiveAuctionRoom(admin, db, clock);
  assert.equal(ready.lot?.canAutopick, true);
  assert.equal(ready.lot?.highBidder, admin);
  assert.equal(ready.lot?.highBid, 1);
  assert.throws(
    () => autopickLiveAuction(other, db, clock),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "not_admin" && error.status === 403,
  );
  const sold = autopickLiveAuction(admin, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.managers.find((manager) => manager.email === admin)?.spent, 1);
  assert.equal(sold.nominator, other);
  assert.equal(
    (db.prepare(`SELECT status FROM live_auction_lots WHERE id = 1`).get() as { status: string })
      .status,
    "sold",
  );
});

test("autopick stays hidden if a not-yet-bidding or outbid rival can still raise", () => {
  const db = memoryDb();
  const clock = { now: () => 1_000 };
  startLiveAuction(admin, db, [admin, other, third], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  spendAlmostAll(db, third, 500);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.canAutopick, false);
  bidLiveAuction(other, 2, db, clock);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.canAutopick, false);
  assert.throws(
    () => autopickLiveAuction(admin, db, clock),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "cannot_autopick",
  );
});

test("folded rivals do not block autopick; STOP does", () => {
  const db = memoryDb();
  const clock = { now: () => 1_000 };
  startLiveAuction(admin, db, [admin, other, third], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, db, clock);
  spendAlmostAll(db, third, 500);
  foldLiveAuction(other, db, clock);
  assert.equal(getLiveAuctionRoom(admin, db, clock).lot?.canAutopick, true);
  const sold = autopickLiveAuction(admin, db, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.managers.find((manager) => manager.email === admin)?.spent, 1);

  const stopped = memoryDb();
  startLiveAuction(admin, stopped, [admin, other], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, stopped, clock);
  spendAlmostAll(stopped, other, 500);
  assert.equal(getLiveAuctionRoom(admin, stopped, clock).lot?.canAutopick, true);
  stopLiveAuction(admin, stopped, clock);
  assert.equal(getLiveAuctionRoom(admin, stopped, clock).lot?.canAutopick, false);
  assert.throws(
    () => autopickLiveAuction(admin, stopped, clock),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "auction_paused",
  );
});

test("offline rival with budget hides autopick; broke offline rival does not", () => {
  resetLiveDraftPresence();
  const richDb = memoryDb();
  let now = 0;
  const clock = { now: () => now };
  recordLiveDraftHeartbeat(admin, 1, 0);
  recordLiveDraftHeartbeat(other, 1, 0);
  recordLiveDraftHeartbeat(third, 1, 0);
  startLiveAuction(admin, richDb, [admin, other, third], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, richDb, clock);
  spendAlmostAll(richDb, third, 500);
  recordLiveDraftHeartbeat(admin, 1, 0);
  recordLiveDraftHeartbeat(third, 1, 0);
  now = LIVE_DRAFT_ONLINE_MS + 1;
  const pausedRich = getLiveAuctionRoom(admin, richDb, clock);
  assert.equal(pausedRich.paused, true);
  assert.equal(pausedRich.pauseReason, "offline");
  assert.equal(pausedRich.lot?.canAutopick, false);
  assert.throws(
    () => autopickLiveAuction(admin, richDb, clock),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "cannot_autopick",
  );

  resetLiveDraftPresence();
  const brokeDb = memoryDb();
  now = 0;
  recordLiveDraftHeartbeat(admin, 1, 0);
  recordLiveDraftHeartbeat(other, 1, 0);
  recordLiveDraftHeartbeat(third, 1, 0);
  startLiveAuction(admin, brokeDb, [admin, other, third], clock);
  nominateLiveAuctionPlayer(admin, 10, 1, brokeDb, clock);
  spendAlmostAll(brokeDb, other, 500);
  spendAlmostAll(brokeDb, third, 501);
  recordLiveDraftHeartbeat(admin, 1, 0);
  now = LIVE_DRAFT_ONLINE_MS + 1;
  const pausedBroke = getLiveAuctionRoom(admin, brokeDb, clock);
  assert.equal(pausedBroke.paused, true);
  assert.equal(pausedBroke.pauseReason, "offline");
  assert.equal(pausedBroke.lot?.canAutopick, true);
  const sold = autopickLiveAuction(admin, brokeDb, clock);
  assert.equal(sold.lot, null);
  assert.equal(sold.managers.find((manager) => manager.email === admin)?.spent, 1);
});
