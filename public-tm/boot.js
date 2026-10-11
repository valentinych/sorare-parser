import { bootCore, currentPage } from "./core.js?v=14";

const PAGE_MODULES = {
  clubs: "./app.js?v=151",
  players: "./app.js?v=151",
  matches: "./app.js?v=151",
  ref: "./app.js?v=151",
  xi: "./app.js?v=151",
  builder: "./app.js?v=151",
  live: "./pages/live.js?v=21",
  auctions: "./pages/auctions.js?v=6",
  tables: "./pages/tables.js?v=28",
  sorare: "./pages/expected11.js?v=17",
  mapping: "./pages/expected11.js?v=17",
  premium: "./pages/premium.js?v=29",
  "league-one": "./pages/league-one.js?v=17",
  "mantra-doma": "./pages/mantra-doma.js?v=12",
};

const CORE_PAGES = new Set(["live", "auctions", "tables", "sorare", "mapping", "premium", "league-one", "mantra-doma"]);

const page = currentPage();
if (CORE_PAGES.has(page)) await bootCore();
const spec = PAGE_MODULES[page];
if (!spec) throw new Error(`Unknown page: ${page}`);
try {
  const mod = await import(spec);
  if (typeof mod.start === "function") await mod.start(page);
} catch (error) {
  const el =
    document.getElementById("premium-meta") ||
    document.getElementById("status") ||
    document.getElementById("app");
  if (el) el.textContent = `Ошибка: ${error?.message || error}`;
  throw error;
}
