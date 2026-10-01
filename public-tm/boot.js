import { bootCore, currentPage } from "./core.js?v=11";

const PAGE_MODULES = {
  clubs: "./app.js?v=148",
  players: "./app.js?v=148",
  matches: "./app.js?v=148",
  ref: "./app.js?v=148",
  xi: "./app.js?v=148",
  builder: "./app.js?v=148",
  live: "./pages/live.js?v=14",
  auctions: "./pages/auctions.js?v=3",
  tables: "./pages/tables.js?v=25",
  sorare: "./pages/expected11.js?v=14",
  mapping: "./pages/expected11.js?v=14",
  premium: "./pages/premium.js?v=25",
  "league-one": "./pages/league-one.js?v=14",
  "mantra-doma": "./pages/mantra-doma.js?v=9",
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
