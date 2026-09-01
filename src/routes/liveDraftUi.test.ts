import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  liveDraftErrorText,
  liveDraftMaxBid,
  managerHeading,
  managerMantraId,
  managerPresence,
  managerSquadId,
  namedTeamsFromRoom,
  renderAllManagerSquads,
  renderSquadPositionTally,
  squadPlayerLine,
  squadPositionCounts,
} from "../../public-tm/live-draft-view.js";
import { liveDraftPageRoutes } from "./liveDraftPage.js";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public-tm",
);

test("live draft tab stays hidden and links to the standalone page", async () => {
  const [html, app, i18n, access] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/live-draft-access.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-view="live-draft"[^>]*hidden/);
  assert.match(html, /href="\/live-draft"/);
  assert.match(html, /"live-draft": "\/live-draft"/);
  assert.match(html, /location\.replace\(path \+ qs\)/);
  assert.doesNotMatch(html, /id="view-live-draft"/);
  assert.doesNotMatch(html, /snake.?draft/i);
  assert.match(app, /accountState\.entitlements\?\.liveDraft/);
  assert.match(app, /googleSignInEnabled\(accountState\)/);
  assert.match(app, /name === "live-draft"/);
  assert.match(app, /location\.replace\("\/live-draft"\)/);
  assert.doesNotMatch(app, /\/api\/live-draft\/room/);
  assert.doesNotMatch(app, /loadLiveDraftPlayers/);
  assert.doesNotMatch(app, /setView\("clubs"\);\s*return;/);
  assert.match(access, /authenticated \|\| account\.googleConfigured/);
  assert.match(i18n, /"PL Live Auction"/);
  assert.match(i18n, /"No access"/);
  assert.match(i18n, /"Team name"/);
  assert.match(i18n, /"Team name…"/);
  assert.match(i18n, /"no name yet"/);
  assert.match(i18n, /"online"/);
  assert.match(i18n, /"offline"/);
  assert.match(i18n, /"ms"/);
  assert.match(i18n, /"Don't bid"/);
  assert.match(i18n, /"Return to auction"/);
  assert.match(i18n, /"As manager"/);
  assert.match(i18n, /"Wishlist"/);
  assert.match(i18n, /"Top 5 by Mantra average price"/);
  assert.match(i18n, /"Paused: STOP"/);
  assert.match(i18n, /"Paused: a manager is offline"/);
  assert.match(i18n, /"Auction is paused"/);
  assert.match(i18n, /"You already folded"/);
  assert.match(i18n, /"Bid is too low"/);
  assert.match(i18n, /"It is not your turn"/);
  assert.match(i18n, /"The leader cannot fold"/);
  assert.match(i18n, /"Autopick"/);
  assert.match(i18n, /"Close the lot now\? The player goes to the current leader\."/);
});

test("standalone live-draft page does not boot the main SPA", async () => {
  const [page, script, css] = await Promise.all([
    readFile(new URL("../../public-tm/live-draft.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/live-draft.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/live-draft.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /app\.js/);
  assert.doesNotMatch(page, /auctions-view\.js/);
  assert.match(page, /live-draft\.js\?v=17/);
  assert.match(page, /live-draft\.css\?v=14/);
  assert.match(page, /id="live-draft-stop"/);
  assert.match(page, /id="live-draft-board"/);
  assert.match(page, /id="live-draft-team-name"/);
  assert.match(page, /id="live-draft-managers"/);
  assert.match(page, /id="live-draft-nominate-as"/);
  assert.match(page, /id="live-draft-bid-as"/);
  assert.match(page, /id="live-draft-all-squads"/);
  assert.match(page, /id="live-draft-fold"/);
  assert.match(page, /id="live-draft-bid-up"/);
  assert.match(page, /id="live-draft-bid-down"/);
  assert.match(page, /id="live-draft-bid-cap"/);
  assert.match(page, /live-draft-bid-submit/);
  assert.match(page, /id="live-draft-wishlist"/);
  assert.match(page, /id="live-draft-wishlist-add"/);
  assert.match(page, /id="live-draft-wishlist-club"/);
  assert.match(page, /id="live-draft-wishlist-position"/);
  assert.match(page, /id="live-draft-wishlist-suggestions"/);
  assert.match(page, /Молоток — 15 секунд/);
  assert.doesNotMatch(page, /id="live-draft-named-teams"/);
  assert.doesNotMatch(page, /Команды с названиями/);
  assert.doesNotMatch(script, /app\.js/);
  assert.doesNotMatch(script, /\/api\/players\?/);
  assert.doesNotMatch(script, /\/api\/competitions/);
  assert.match(script, /\/api\/live-draft\/room/);
  assert.match(script, /\/api\/live-draft\/team-name/);
  assert.match(script, /\/api\/live-draft\/heartbeat/);
  assert.match(script, /\/api\/live-draft\/players/);
  assert.match(script, /\/api\/live-draft\/stop/);
  assert.match(script, /\/api\/live-draft\/correct/);
  assert.match(script, /\/api\/live-draft\/release/);
  assert.match(script, /\/api\/live-draft\/fold/);
  assert.match(script, /\/api\/live-draft\/autopick/);
  assert.match(script, /\/api\/live-draft\/wishlist/);
  assert.match(script, /\/api\/live-draft\/wishlist-filters/);
  assert.match(script, /wishlistClubAndPositionSelected/);
  assert.match(script, /liveDraftPauseCopy/);
  assert.match(script, /liveDraftErrorText/);
  assert.match(script, /liveDraftMaxBid/);
  assert.match(script, /liveDraftLotOpen/);
  assert.match(script, /nudgeBid/);
  assert.match(script, /leader_cannot_fold|youAreLeader/);
  assert.match(script, /i18n\.js\?v=33/);
  assert.match(script, /live-draft-view\.js\?v=12/);
  assert.match(script, /managerSquadId/);
  assert.match(script, /managerPresence/);
  assert.match(script, /renderAllManagerSquads/);
  assert.match(script, /renderSquadPositionTally/);
  assert.match(script, /LIVE_DRAFT_HEARTBEAT_MS = 5000/);
  assert.match(script, /Promise\.allSettled/);
  assert.match(css, /\.live-draft-toolbar-actions/);
  assert.match(css, /\.live-draft-ping-dot/);
  assert.match(css, /\.live-draft-ping\.is-online/);
  assert.match(css, /\.live-draft-wishlist-row/);
  assert.match(css, /\.live-draft-wishlist-filters/);
  assert.match(css, /\.live-draft-fold/);
  assert.match(css, /\.live-draft-fold\.is-pressed/);
  assert.match(css, /\.live-draft-autopick/);
  assert.match(css, /\.live-draft-bid-submit/);
  assert.match(css, /\.live-draft-lot\.is-open/);
  assert.match(css, /\.live-draft-manager\.is-folded/);
  assert.match(css, /\.live-draft-correct/);
  assert.match(css, /\.live-draft-release/);
  assert.match(css, /\.live-draft-all-squads-grid/);
  assert.match(css, /\.live-draft-manager-squad/);
  assert.match(css, /\.live-draft-squad-tally/);
});

test("live draft assets are cache-busted", async () => {
  const [html, app, page] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/live-draft.html", import.meta.url), "utf8"),
  ]);
  assert.match(html, /boot\.js\?v=19/);
  assert.match(html, /styles\.css\?v=129/);
  assert.match(app, /i18n\.js\?v=24/);
  assert.match(app, /live-draft-access\.js\?v=1/);
  assert.match(page, /live-draft\.js\?v=17/);
  assert.match(page, /live-draft\.css\?v=14/);
});

test("live draft error codes and max bid formula are humanized for the bid UI", () => {
  assert.equal(liveDraftMaxBid(260, 0), 235);
  assert.equal(liveDraftMaxBid(80, 10), 65);
  assert.equal(liveDraftMaxBid(12, 25), 12);
  assert.equal(liveDraftErrorText({ code: "auction_paused" }), "Аукцион на паузе");
  assert.equal(liveDraftErrorText({ code: "folded" }), "Ты уже пас");
  assert.equal(liveDraftErrorText({ code: "bid_too_low" }), "Ставка слишком низкая");
  assert.equal(liveDraftErrorText({ code: "not_your_turn" }), "Сейчас не твой ход");
  assert.equal(liveDraftErrorText({ code: "leader_cannot_fold" }), "Лидер не может пасовать");
  assert.equal(liveDraftErrorText({ code: "bid_over_max" }), "Ставка выше максимума — нужен резерв на свободные слоты");
  assert.equal(liveDraftErrorText({ code: "cannot_autopick" }), "Автопик недоступен — кто-то ещё может перебить");
});

test("named teams helper prefers persisted teamName over fallback", () => {
  assert.deepEqual(
    namedTeamsFromRoom({
      namedTeams: [
        { email: "a@example.com", teamName: "Tigers FC" },
        { email: "b@example.com", teamName: "  " },
      ],
      managers: [{ email: "b@example.com", teamName: "Ignored" }],
    }),
    [{ email: "a@example.com", teamName: "Tigers FC" }],
  );
  assert.deepEqual(managerHeading({ teamName: "Tigers FC", name: "Ruslan" }), {
    label: "Tigers FC",
    named: true,
  });
  assert.deepEqual(
    managerHeading({ teamName: "", name: "", email: "owner@example.com" }),
    { label: "owner", named: false },
  );
  assert.deepEqual(managerPresence({ online: true, pingMs: 81.4 }), {
    online: true,
    pingMs: 81,
  });
  assert.deepEqual(managerPresence({ online: false, pingMs: 12 }), {
    online: false,
    pingMs: null,
  });
  assert.equal(managerMantraId({ mantraManagerId: 67 }), 67);
  assert.equal(managerMantraId({ mantraManagerId: "205" }), 205);
  assert.equal(managerMantraId({ mantraManagerId: null }), null);
  assert.equal(managerMantraId({}), null);
  assert.equal(managerSquadId({ squadId: 5009 }), 5009);
  assert.equal(managerSquadId({ squadId: "1925" }), 1925);
  assert.equal(managerSquadId({ squadId: null }), null);
  assert.equal(managerSquadId({ mantraManagerId: 67 }), null);
});

test("all-manager squads renderer lists a column per manager", () => {
  assert.equal(
    squadPlayerLine({
      name: "Salah",
      positions: ["W", "FW"],
      clubName: "Liverpool",
      amount: 6,
    }),
    "Salah · W/FW · Liverpool · 6",
  );
  assert.equal(squadPlayerLine({ name: "Raya", positions: ["GK"], amount: 1 }), "Raya · GK · 1");
  const html = renderAllManagerSquads(
    [
      {
        teamName: "Tigers FC",
        squad: [
          {
            name: "Salah",
            positions: ["W", "FW"],
            clubName: "Liverpool",
            amount: 6,
          },
        ],
      },
      { email: "owner@example.com", squad: [] },
      { teamName: "<b>Hack</b>", squad: [{ name: "<img>" }] },
    ],
    { emptyLabel: "Пока пусто" },
  );
  assert.match(html, /<h4>Tigers FC<\/h4>/);
  assert.match(
    renderAllManagerSquads([
      { email: "a@example.com", teamName: "Tigers FC", squadId: 5009, squad: [] },
    ]),
    /<h4>Tigers FC · ID 5009<\/h4>/,
  );
  assert.match(html, /Salah · W\/FW · Liverpool · 6/);
  assert.match(html, /<h4>owner<\/h4>/);
  assert.match(html, /Пока пусто/);
  assert.match(html, /&lt;b&gt;Hack&lt;\/b&gt;/);
  assert.match(html, /&lt;img&gt;/);
  assert.equal((html.match(/live-draft-manager-squad/g) || []).length, 3);
  assert.doesNotMatch(html, /data-correct-player/);
  const adminHtml = renderAllManagerSquads(
    [
      {
        email: "a@example.com",
        teamName: "Tigers FC",
        squad: [{ id: 10, name: "Salah", amount: 6 }],
      },
      { email: "owner@example.com", teamName: "Owner", squad: [] },
    ],
    { admin: true },
  );
  assert.match(adminHtml, /data-correct-player="10"/);
  assert.match(adminHtml, /data-release-player="10"/);
  assert.match(adminHtml, /data-release-email="a@example.com"/);
  assert.match(adminHtml, /Удалить в аукцион/);
  assert.match(adminHtml, /value="a@example.com" selected/);
  assert.match(adminHtml, /value="owner@example.com"/);
});

test("my-squad tally counts a player toward every Mantra position they cover", () => {
  assert.deepEqual(
    squadPositionCounts([
      { positions: ["W", "FW"] },
      { positions: ["gk", "GK"] },
      { positions: ["ST"] },
    ]),
    {
      GK: 1,
      CB: 0,
      RB: 0,
      LB: 0,
      WB: 0,
      DM: 0,
      CM: 0,
      AM: 0,
      W: 1,
      FW: 1,
      ST: 1,
    },
  );
  const html = renderSquadPositionTally([]);
  assert.match(html, /live-draft-squad-tally/);
  assert.match(html, /GK 0/);
  assert.match(html, /CB 0/);
  assert.match(html, /ST 0/);
  const filled = renderSquadPositionTally([{ positions: ["W", "FW"] }]);
  assert.match(filled, />W 1</);
  assert.match(filled, />FW 1</);
  assert.match(filled, />CB 0</);
});

test("GET /live-draft serves the standalone HTML without app.js", async (t) => {
  const app = Fastify();
  await app.register(liveDraftPageRoutes, { publicDir });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/live-draft" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] || "", /text\/html/);
  assert.doesNotMatch(response.body, /app\.js/);
  assert.match(response.body, /live-draft\.js\?v=17/);
  assert.match(response.body, /id="live-draft-stop"/);
  assert.match(response.body, /id="live-draft-managers"/);
  assert.match(response.body, /id="live-draft-all-squads"/);
  assert.match(response.body, /id="live-draft-wishlist"/);
  assert.match(response.body, /id="live-draft-wishlist-club"/);
  assert.match(response.body, /id="live-draft-fold"/);
});
