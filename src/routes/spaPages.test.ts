import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { composeSpaPage, spaPageRoutes } from "./spaPages.js";
import { wantsHtmlPage } from "../lib/wantsHtmlPage.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public-tm");

test("wantsHtmlPage is true only for document navigations", () => {
  assert.equal(wantsHtmlPage({ headers: { "sec-fetch-dest": "document" } } as never), true);
  assert.equal(wantsHtmlPage({ headers: { "sec-fetch-dest": "empty" } } as never), false);
  assert.equal(wantsHtmlPage({ headers: { accept: "*/*" } } as never), false);
  assert.equal(wantsHtmlPage({ headers: { accept: "text/html" } } as never), true);
  assert.equal(wantsHtmlPage({ headers: {} } as never), false);
  assert.equal(wantsHtmlPage({ headers: { accept: "application/json" } } as never), false);
  assert.equal(
    wantsHtmlPage({
      headers: { accept: "application/json", "sec-fetch-dest": "document" },
    } as never),
    false,
  );
});

test("composed menu pages keep one view and boot.js, not the monolith", async () => {
  const html = await readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8");
  const live = composeSpaPage(html, "live");
  assert.match(live, /data-page="live"/);
  assert.match(live, /id="view-live"/);
  assert.doesNotMatch(live, /id="view-auctions"/);
  assert.doesNotMatch(live, /id="view-sorare"/);
  assert.doesNotMatch(live, /id="view-xi"/);
  assert.match(live, /boot\.js\?v=27/);
  assert.doesNotMatch(live, /app\.js\?v=/);
  assert.match(live, /href="\/live"/);
  assert.match(live, /data-view="live"[^>]*aria-selected="true"/);

  const auctions = composeSpaPage(html, "auctions");
  assert.match(auctions, /id="view-auctions"/);
  assert.doesNotMatch(auctions, /id="view-live"/);
  assert.doesNotMatch(auctions, /id="league"/);
  assert.match(auctions, /id="status" hidden/);
  assert.doesNotMatch(auctions, /id="status">Загрузка/);

  const clubs = composeSpaPage(html, "clubs");
  assert.match(clubs, /id="view-clubs"/);
  assert.match(clubs, /id="league"/);
  assert.match(clubs, /id="status">Загрузка/);
  assert.doesNotMatch(html, /data-view="clubs"/);
  assert.doesNotMatch(html, /data-view="players"/);
  assert.doesNotMatch(html, /data-view="matches"/);
  assert.doesNotMatch(html, /data-view="ref"/);
  assert.match(html, /data-view="live"/);
  assert.match(html, /data-view="xi"/);
});

test("feature page modules do not pull unrelated bundles", async () => {
  const [boot, live, expected11, auctions] = await Promise.all([
    readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/live.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/auctions.js", import.meta.url), "utf8"),
  ]);
  assert.match(boot, /pages\/live\.js/);
  assert.match(boot, /await import\(spec\)/);
  assert.doesNotMatch(boot, /import\("\.\/pages\//);
  const appJs = await readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8");
  assert.match(appJs, /xi-season"\)\?\.addEventListener/);
  assert.match(appJs, /builder-my-teams[\s\S]{0,80}if \(myTeams\)/);
  assert.match(appJs, /const MANTRA_POS_COLOR = \{/);
  assert.match(boot, /builder: "\.\/app\.js\?v=145"/);
  assert.doesNotMatch(live, /auctions-view/);
  assert.doesNotMatch(live, /app\.js/);
  assert.doesNotMatch(live, /expected11-view/);
  assert.doesNotMatch(expected11, /auctions-view/);
  assert.doesNotMatch(expected11, /pages\/live/);
  assert.match(auctions, /auctions-view\.js/);
  assert.doesNotMatch(auctions, /pages\/live/);
});

test("GET /auctions and GET / serve HTML without app.js", async (t) => {
  const app = Fastify();
  await app.register(spaPageRoutes, { publicDir });
  t.after(() => app.close());
  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /boot\.js\?v=27/);
  assert.doesNotMatch(home.body, /app\.js\?v=/);
  assert.match(home.body, /id="view-clubs"/);
  const auctions = await app.inject({ method: "GET", url: "/auctions" });
  assert.equal(auctions.statusCode, 200);
  assert.match(auctions.body, /id="view-auctions"/);
  assert.doesNotMatch(auctions.body, /id="view-live"/);
  const builder = await app.inject({ method: "GET", url: "/builder" });
  assert.equal(builder.statusCode, 200);
  assert.match(builder.body, /data-page="builder"/);
  assert.match(builder.body, /id="view-builder"/);
  assert.match(builder.body, /boot\.js\?v=27/);
  assert.doesNotMatch(builder.body, /app\.js\?v=/);
});
