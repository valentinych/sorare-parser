#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public-tm/app.js");
let src = readFileSync(appPath, "utf8");

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cutOnce(text, startNeedle, endNeedle, insert = "") {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle, start + 1);
  must(start >= 0, `start not found: ${startNeedle.slice(0, 60)}`);
  must(end >= 0, `end not found: ${endNeedle.slice(0, 60)}`);
  return text.slice(0, start) + insert + text.slice(end);
}

src = src.replace(
  `import {
  formatUiDateTime,
  getUiLocale,
  getUiTimeZone,
  initI18n,
  setUiPreferences,
  tr,
} from "./i18n.js?v=24";
import {
  expected11AggregateText,
  expected11NarrativeBlocks,
  expected11PlayerProfileUrl,
  expected11PositionsText,
  expected11ScopeText,
  expected11VisibleMatches,
} from "./expected11-view.js?v=2";
import {
  nextPremiumSort,
  sortPremiumRows,
} from "./premium-sort.js?v=1";
import {
  closestPremiumFormation,
  compatiblePremiumFormations,
  premiumSelectionCounts,
} from "./premium-formations.js?v=1";
import { googleSignInEnabled } from "./live-draft-access.js?v=1";
import {
  startAuctionsView,
  stopAuctionsView,
} from "./auctions-view.js?v=16";
`,
  `import {
  formatUiDateTime,
  getUiLocale,
  getUiTimeZone,
  initI18n,
  setUiPreferences,
  tr,
} from "./i18n.js?v=24";
import { googleSignInEnabled } from "./live-draft-access.js?v=1";
import { esc as escCore } from "./core.js?v=1";
`,
);
must(!src.includes("auctions-view.js"), "auctions import still present");

const slugStart = src.indexOf("function slugifyLeagueName(name) {");
const parseStart = src.indexOf("function parseHash() {");
must(slugStart > 0 && parseStart > slugStart, "slug helpers");
const slugKeep = src.slice(slugStart, parseStart);

const syncXiStart = src.indexOf("/** Keep `#xi?league=");
const livePhase = src.indexOf("const LIVE_PHASE_LABEL = {");
must(syncXiStart > 0 && livePhase > syncXiStart, "syncXi");
let syncXiKeep = src.slice(syncXiStart, livePhase);
syncXiKeep = syncXiKeep
  .replace('`#xi?${qs}` : "#xi"', '`/xi?${qs}` : "/xi"')
  .replace(
    "if (location.hash === next) return;",
    "if (`${location.pathname}${location.search}` === next) return;",
  );

src = src.replace(
  `function playerHref(id) {
  return \`/player.html?id=\${encodeURIComponent(id)}\`;
}
`,
  `function playerHref(id) {
  return \`/player.html?id=\${encodeURIComponent(id)}\`;
}

function currentPageName() {
  return document.body?.dataset?.page || "clubs";
}

${slugKeep}${syncXiKeep}`,
);

src = cutOnce(
  src,
  "/** @type {any | null} */\nlet livePayload = null;",
  "function mainRole(p) {",
);
must(!src.includes("let livePayload"), "livePayload remains");
must(src.includes("function mainRole"), "mainRole missing");
must(src.includes("function competitionLeagueSlug"), "competitionLeagueSlug missing after live cut");

src = cutOnce(
  src,
  "let expected11Loaded = false;",
  "function setView(name) {",
);
must(!src.includes("async function loadExpected11"), "loadExpected11 remains");
must(src.includes("function setView"), "setView missing");
must(src.includes("async function loadCompetitionData"), "loadCompetitionData missing");

src = src.replaceAll("currentHashView()", "currentPageName()");

src = src.replace(
  `function syncBuilderHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  const next = qs.toString() ? \`#builder?\${qs}\` : "#builder";
  if (location.hash !== next) history.replaceState(null, "", next);
}`,
  `function syncBuilderHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  const next = qs.toString() ? \`/builder?\${qs}\` : "/builder";
  if (\`\${location.pathname}\${location.search}\` !== next) history.replaceState(null, "", next);
}`,
);

src = src.replace(
  `  for (const id of [
    "clubs",
    "players",
    "matches",
    "live",
    "auctions",
    "xi",
    "sorare",
    "mapping",
    "premium",
    "builder",
    "ref",
  ]) {
    document.getElementById(\`view-\${id}\`).hidden = id !== name;
  }
  if (name !== "auctions") stopAuctionsView();
  fillCompetitionSelect(name);
  if (name === "live") {
    fillCompetitionSelect();
    const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
    if (liveList.length && !liveList.some((c) => c.id === activeCompetitionId)) {
      liveSelectedRound = null;
      liveSelectedId = null;
      livePayload = null;
      void loadCompetitionData(liveList[0].id, { silent: true });
      syncLiveHash();
      void fetchLiveRound({ silent: true });
      return;
    }
    syncLiveHash();
    ensureLiveLoaded();
  } else if (name === "xi") {
    syncXiHash();
    applyXiModeUi();
    fillXiSeasonSelect();
    xiLoadedKey = "";
    ensureXiLoaded();
  } else if (name === "auctions") {
    history.replaceState(null, "", "#auctions");
    startAuctionsView().catch((err) => {
      document.getElementById("auctions-meta").textContent = \`Ошибка: \${err.message}\`;
    });
  } else if (name === "builder") {
    ensureBuilderLoaded().catch((err) => {
      document.getElementById("builder-meta").textContent = \`Ошибка: \${err.message}\`;
    });
  } else if (name === "sorare") {
    history.replaceState(null, "", "#sorare");
    loadExpected11().catch((err) => {
      document.getElementById("expected11-meta").textContent = \`Ошибка: \${err.message}\`;
    });
  } else if (name === "mapping") {
    history.replaceState(null, "", "#mapping");
    loadMapping().catch((err) => {
      document.getElementById("mapping-meta").textContent = \`Ошибка: \${err.message}\`;
    });
  } else if (name === "premium") {
    history.replaceState(null, "", "#premium");
    loadPremium().catch((err) => {
      document.getElementById("premium-meta").textContent = \`Ошибка: \${err.message}\`;
    });
  } else {
    history.replaceState(null, "", \`#\${name}\`);
  }
}`,
  `  for (const id of ["clubs", "players", "matches", "xi", "builder", "ref"]) {
    const el = document.getElementById(\`view-\${id}\`);
    if (el) el.hidden = id !== name;
  }
  fillCompetitionSelect(name);
  if (name === "xi") {
    syncXiHash();
    applyXiModeUi();
    fillXiSeasonSelect();
    xiLoadedKey = "";
    ensureXiLoaded();
  } else if (name === "builder") {
    ensureBuilderLoaded().catch((err) => {
      const meta = document.getElementById("builder-meta");
      if (meta) meta.textContent = \`Ошибка: \${err.message}\`;
    });
  }
}`,
);
must(!src.includes("startAuctionsView"), "startAuctionsView remains");
must(!src.includes("stopAuctionsView"), "stopAuctionsView remains");
must(src.includes("async function loadCompetitionData"), "loadCompetitionData lost in setView replace");

src = src.replace(
  `function fillCompetitionSelect(viewName = currentPageName()) {
  const sel = document.getElementById("competition-select");
  const liveView = viewName === "live";
  const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
  const options = liveView && liveList.length ? liveList : competitions;
  if (!options.length) {
    sel.innerHTML = \`<option value="\${activeCompetitionId}">\${activeCompetitionId}</option>\`;
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId)) {
    activeCompetitionId = options[0].id;
  }
  sel.innerHTML = options
    .map((c) => {
      const pending = c.pending ? " · sync…" : "";
      const season = liveView ? "" : c.seasonId ? \` · \${c.seasonId}\` : "";
      const label = liveView
        ? tr(LIVE_SELECT_LABEL[c.liveSlug] || c.liveName || c.name)
        : c.name;
      return \`<option value="\${c.id}">\${label}\${season}\${pending}</option>\`;
    })
    .join("");
  sel.value = activeCompetitionId;
  const titleName = liveView
    ? LIVE_SELECT_LABEL[options.find((c) => c.id === activeCompetitionId)?.liveSlug] ||
      competitions.find((c) => c.id === activeCompetitionId)?.name
    : competitions.find((c) => c.id === activeCompetitionId)?.name;
  document.title = \`TM Desk · \${tr(titleName || activeCompetitionId)}\`;
}`,
  `function fillCompetitionSelect(viewName = currentPageName()) {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  const options = competitions;
  if (!options.length) {
    sel.innerHTML = \`<option value="\${activeCompetitionId}">\${activeCompetitionId}</option>\`;
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId)) {
    activeCompetitionId = options[0].id;
  }
  sel.innerHTML = options
    .map((c) => {
      const pending = c.pending ? " · sync…" : "";
      const season = c.seasonId ? \` · \${c.seasonId}\` : "";
      return \`<option value="\${c.id}">\${c.name}\${season}\${pending}</option>\`;
    })
    .join("");
  sel.value = activeCompetitionId;
  const titleName = competitions.find((c) => c.id === activeCompetitionId)?.name;
  document.title = \`\${viewName} · \${tr(titleName || activeCompetitionId)} · Mantra Helper\`;
}`,
);

src = src.replace(
  `async function boot() {
  if (currentPageName() === "live-draft") {
    location.replace("/live-draft");
    return;
  }
  showContentLoading();
  try {
    await Promise.all([loadXiLeaguesFromApi(), loadLiveLeaguesFromApi(), loadAccount()]);
    const [compsRes, refRes] = await Promise.all([
      fetch("/api/competitions"),
      fetch("/api/ref"),
    ]);
    const compsData = compsRes.ok ? await compsRes.json() : { competitions: [] };
    const refData = await refRes.json();
    competitions = compsData.competitions || [];
    refCategories = refData.categories || [];
    fillRefCategories();
    fillXiLeagueSelects();

    const { view, qs } = parseHash();
    if (view === "live" || view === "xi" || view === "builder") {
      const fromHash = resolveCompetitionIdFromLeagueParam(qs.get("league"));
      if (fromHash) activeCompetitionId = fromHash;
    }
    if (view === "live") {
      const round = qs.get("round");
      if (round != null && round !== "") liveSelectedRound = round;
    }
    if (view === "xi") {
      xiPendingTeamParam = qs.get("team");
    }

    fillCompetitionSelect();
    if (view === "live") {
      const liveFetch = fetchLiveRound({ silent: true });
      void loadCompetitionData(activeCompetitionId, { silent: true });
      void renderRef();
      setView("live");
      await liveFetch;
    } else {
      await loadCompetitionData(activeCompetitionId);
      await renderRef();
      if (
        [
          "players",
          "matches",
          "auctions",
          "xi",
          "sorare",
          "mapping",
          "premium",
          "builder",
          "ref",
        ].includes(view)
      ) {
        setView(view);
      }
    }
  } catch (err) {
    statusEl.textContent = \`Ошибка: \${err.message}. Сначала npm run sync:tm / sync:expand\`;
  } finally {
    hideContentLoading();
  }
}`,
  `export async function start(page = currentPageName()) {
  showContentLoading();
  try {
    await Promise.all([loadXiLeaguesFromApi(), loadAccount()]);
    const [compsRes, refRes] = await Promise.all([
      fetch("/api/competitions"),
      page === "ref" ? fetch("/api/ref") : Promise.resolve({ ok: false, json: async () => ({ categories: [] }) }),
    ]);
    const compsData = compsRes.ok ? await compsRes.json() : { competitions: [] };
    const refData = refRes.ok ? await refRes.json() : { categories: [] };
    competitions = compsData.competitions || [];
    refCategories = refData.categories || [];
    if (page === "ref") fillRefCategories();
    fillXiLeagueSelects();

    const qs = new URLSearchParams(location.search);
    if (page === "xi" || page === "builder") {
      const fromParam = resolveCompetitionIdFromLeagueParam(qs.get("league"));
      if (fromParam) activeCompetitionId = fromParam;
    }
    if (page === "xi") xiPendingTeamParam = qs.get("team");

    fillCompetitionSelect(page);
    if (page === "ref") {
      await renderRef();
    } else {
      await loadCompetitionData(activeCompetitionId);
      if (page === "xi" || page === "builder" || page === "players" || page === "matches") {
        setView(page);
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = \`Ошибка: \${err.message}. Сначала npm run sync:tm / sync:expand\`;
  } finally {
    hideContentLoading();
  }
}`,
);
must(src.includes("export async function start"), "start() missing");
must(!src.includes("loadLiveLeaguesFromApi"), "loadLiveLeaguesFromApi remains");

src = src.replace(
  `for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", (event) => {
    if (btn.dataset.view === "live-draft") return;
    event.preventDefault();
    setView(btn.dataset.view);
  });
}
window.addEventListener("hashchange", () => {
  const view = currentPageName();
  if (view === "live-draft") {
    location.replace("/live-draft");
    return;
  }
  if (document.querySelector(\`.tab[data-view="\${view}"]\`)) setView(view);
});
`,
  "",
);

src = src.replace(
  `  if (currentPageName() === "live") {
    liveSelectedRound = null;
    liveSelectedId = null;
    livePayload = null;
    syncLiveHash();
    void fetchLiveRound({ silent: true });
    void loadCompetitionData(nextId, { silent: true });
    return;
  }
  loadCompetitionData(nextId)`,
  `  loadCompetitionData(nextId)`,
);

src = cutOnce(
  src,
  `document.getElementById("sorare-league")?.addEventListener("change", async (event) => {`,
  "let lastBrowserImportRefreshAt = 0;",
);

src = src.replace(
  /let lastBrowserImportRefreshAt = 0;[\s\S]*$/,
  `document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !accountState.authenticated) return;
  await loadAccount();
});
`,
);

must(!src.includes("\nboot();\n") && !src.endsWith("boot();\n"), "boot() still called");
must(src.includes("function renderClubs"), "renderClubs missing");
must(src.includes("function renderLeague"), "renderLeague missing");
must(src.includes("async function openClub"), "openClub missing");
must(!src.includes("function esc("), "local esc remains — live cut incomplete?");

src = src.replace(
  "initI18n();\n\nconst statusEl",
  `initI18n();
function esc(s) {
  return escCore(s);
}

const statusEl`,
);

must(src.includes("championshipExpected11Enabled"), "xi expected11 helpers missing");
must(src.includes("googleSignInEnabled(accountState)"), "account google check missing");

writeFileSync(appPath, src);
console.log("ok", src.split("\n").length, "lines", src.length, "bytes");
