import { bootCore, currentPage } from "./core.js?v=7";

const PAGE_MODULES = {
  clubs: "./app.js?v=145",
  players: "./app.js?v=145",
  matches: "./app.js?v=145",
  ref: "./app.js?v=145",
  xi: "./app.js?v=145",
  builder: "./app.js?v=145",
  live: "./pages/live.js?v=12",
  auctions: "./pages/auctions.js?v=3",
  sorare: "./pages/expected11.js?v=12",
  mapping: "./pages/expected11.js?v=12",
  premium: "./pages/premium.js?v=8",
  "league-one": "./pages/league-one.js?v=10",
};

const CORE_PAGES = new Set(["live", "auctions", "sorare", "mapping", "premium", "league-one"]);

const page = currentPage();
if (CORE_PAGES.has(page)) await bootCore();
const spec = PAGE_MODULES[page];
if (!spec) throw new Error(`Unknown page: ${page}`);
const mod = await import(spec);
if (typeof mod.start === "function") await mod.start(page);
