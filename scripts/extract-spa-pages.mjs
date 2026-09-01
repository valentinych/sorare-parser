#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "public-tm/app.js");
const app = readFileSync(appPath, "utf8");
const lines = app.split("\n");

function slice(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

const liveHeader = `import {
  accountState,
  activeCompetitionId,
  competitions,
  esc,
  formatDate,
  formatUiDateTime,
  getUiTimeZone,
  hideContentLoading,
  loadAccount,
  loadCompetitionsList,
  pageHooks,
  setActiveCompetitionId,
  showContentLoading,
  slugifyLeagueName,
  tr,
} from "../core.js?v=1";

`;

const liveState = slice(3257, 3266);
const liveSelect = slice(3341, 3383);
const liveBody = slice(3413, 4670);

const liveFooter = `

function competitionLeagueSlug(compId = activeCompetitionId) {
  const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
  const cur = liveList.find((c) => c.id === compId);
  if (cur?.liveSlug) return cur.liveSlug;
  const fb = LIVE_SELECT_FALLBACK.find((l) => l.tmCompetition === compId);
  if (fb) return fb.slug;
  const c = competitions.find((x) => x.id === compId);
  if (c?.name) {
    const s = slugifyLeagueName(c.name);
    if (s) return s;
  }
  return slugifyLeagueName(compId) || String(compId || "").toLowerCase();
}

function resolveCompetitionIdFromLeagueParam(param) {
  if (param == null || param === "") return null;
  const raw = String(param).trim();
  if (!raw) return null;
  const rawLower = raw.toLowerCase();
  const slug = slugifyLeagueName(raw);
  const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
  const byLive = liveList.find(
    (c) => c.liveSlug === raw || c.liveSlug === slug || c.id === raw || c.id.toLowerCase() === rawLower,
  );
  if (byLive) return byLive.id;
  const byId = competitions.find((c) => c.id === raw || c.id.toLowerCase() === rawLower);
  if (byId) return byId.id;
  const fb = LIVE_SELECT_FALLBACK.find((l) => l.slug === raw || l.slug === slug);
  if (fb) return fb.tmCompetition;
  const byName = competitions.find((c) => slugifyLeagueName(c.name) === slug);
  return byName?.id ?? null;
}

function fillLiveCompetitionSelect() {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
  const options = liveList.length ? liveList : competitions;
  if (!options.length) {
    sel.innerHTML = \`<option value="\${activeCompetitionId}">\${activeCompetitionId}</option>\`;
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId)) {
    setActiveCompetitionId(options[0].id);
  }
  sel.innerHTML = options
    .map((c) => {
      const label = LIVE_SELECT_LABEL[c.liveSlug] || c.liveName || c.name;
      return \`<option value="\${c.id}">\${tr(label)}</option>\`;
    })
    .join("");
  sel.value = activeCompetitionId;
  const titleName =
    LIVE_SELECT_LABEL[options.find((c) => c.id === activeCompetitionId)?.liveSlug] ||
    competitions.find((c) => c.id === activeCompetitionId)?.name;
  document.title = \`Live · \${tr(titleName || activeCompetitionId)} · Mantra Helper\`;
}

function bindLivePage() {
  document.getElementById("competition-select")?.addEventListener("change", (e) => {
    setActiveCompetitionId(e.target.value);
    liveSelectedRound = null;
    liveSelectedId = null;
    livePayload = null;
    syncLiveHash();
    void fetchLiveRound({ silent: true });
  });
  document.getElementById("live-ratings-table")?.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.getAttribute("data-live-sort");
    if (!key || !liveDetailPlayers) return;
    if (liveRatingSort.key === key) {
      liveRatingSort.dir = liveRatingSort.dir === "asc" ? "desc" : "asc";
    } else {
      liveRatingSort = { key, dir: key === "rating" ? "desc" : "asc" };
    }
    renderLiveRatingsTable();
  });
  pageHooks.onAccountChanged = () => {
    if (livePayload) {
      renderLiveRoundTabs();
      renderLiveList();
      if (liveSelectedId != null) loadLiveDetail(liveSelectedId);
    }
  };
}

export async function start() {
  showContentLoading();
  try {
    bindLivePage();
    await Promise.all([loadLiveLeaguesFromApi(), loadAccount(), loadCompetitionsList()]);
    const qs = new URLSearchParams(location.search);
    const fromParam = resolveCompetitionIdFromLeagueParam(qs.get("league"));
    if (fromParam) setActiveCompetitionId(fromParam);
    const round = qs.get("round");
    if (round != null && round !== "") liveSelectedRound = round;
    fillLiveCompetitionSelect();
    syncLiveHash();
    await fetchLiveRound({ silent: true });
  } catch (err) {
    const meta = document.getElementById("live-meta");
    if (meta) meta.textContent = \`Ошибка: \${err.message}\`;
  } finally {
    hideContentLoading();
  }
}
`;

let liveSrc = liveHeader + liveState + "\n" + liveSelect + "\n" + liveBody + liveFooter;
liveSrc = liveSrc.replaceAll("currentHashView() === \"live\"", "true");
liveSrc = liveSrc.replace(
  `function syncLiveHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  if (liveSelectedRound != null && liveSelectedRound !== "") {
    qs.set("round", String(liveSelectedRound));
  }
  const next = qs.toString() ? \`#live?\${qs}\` : "#live";
  if (location.hash === next) return;
  history.replaceState(null, "", next);
}`,
  `function syncLiveHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  if (liveSelectedRound != null && liveSelectedRound !== "") {
    qs.set("round", String(liveSelectedRound));
  }
  const next = qs.toString() ? \`/live?\${qs}\` : "/live";
  const cur = \`\${location.pathname}\${location.search}\`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}`,
);

writeFileSync(path.join(root, "public-tm/pages/live.js"), liveSrc);

const e11Header = `import {
  accountState,
  apiJson,
  builderInitials,
  esc,
  formatUiDateTime,
  tr,
} from "../core.js?v=1";
import {
  expected11AggregateText,
  expected11NarrativeBlocks,
  expected11PlayerProfileUrl,
  expected11PositionsText,
  expected11ScopeText,
  expected11VisibleMatches,
} from "../expected11-view.js?v=2";
import {
  nextPremiumSort,
  sortPremiumRows,
} from "../premium-sort.js?v=1";
import {
  closestPremiumFormation,
  compatiblePremiumFormations,
  premiumSelectionCounts,
} from "../premium-formations.js?v=1";

`;

const e11Body = slice(4682, 5470);
const e11Listeners = slice(7505, 7649);

const e11Footer = `

export async function start(page) {
  if (
    (page === "mapping" || page === "premium") &&
    !accountState.entitlements?.expected11Premium
  ) {
    location.replace("/clubs");
    return;
  }
  try {
    if (page === "mapping") await loadMapping();
    else if (page === "premium") await loadPremium();
    else await loadExpected11();
  } catch (err) {
    const id =
      page === "mapping" ? "mapping-meta" : page === "premium" ? "premium-meta" : "expected11-meta";
    const el = document.getElementById(id);
    if (el) el.textContent = \`Ошибка: \${err.message}\`;
  }
}
`;

writeFileSync(
  path.join(root, "public-tm/pages/expected11.js"),
  e11Header + e11Body + "\n\n" + e11Listeners + e11Footer,
);

console.log("wrote live.js and expected11.js");
