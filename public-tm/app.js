import {
  formatUiDateTime,
  getUiLocale,
  getUiTimeZone,
  initI18n,
  setUiPreferences,
  tr,
} from "./i18n.js?v=24";
import { googleSignInEnabled } from "./live-draft-access.js?v=1";
import { esc as escCore, pageHooks } from "./core.js?v=1";

initI18n();
function esc(s) {
  return escCore(s);
}

const statusEl = document.getElementById("status");
const clubGrid = document.getElementById("club-grid");
const playersBody = document.getElementById("players-body");
const matchesBody = document.getElementById("matches-body");
const refBody = document.getElementById("ref-body");
const dialog = document.getElementById("club-dialog");
const gameDialog = document.getElementById("game-dialog");

/** Nested main-content fetch counter — hide only when all settle. */
let contentLoadingDepth = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let contentLoadingHideTimer = null;

function showContentLoading() {
  contentLoadingDepth += 1;
  if (contentLoadingHideTimer) {
    clearTimeout(contentLoadingHideTimer);
    contentLoadingHideTimer = null;
  }
  const el = document.getElementById("content-loading");
  if (!el) return;
  el.hidden = false;
  el.setAttribute("aria-hidden", "false");
  el.setAttribute("aria-busy", "true");
  document.body.setAttribute("aria-busy", "true");
}

function hideContentLoading() {
  contentLoadingDepth = Math.max(0, contentLoadingDepth - 1);
  if (contentLoadingDepth > 0) return;
  // Short debounce avoids flicker when one reload hands off to the next.
  if (contentLoadingHideTimer) clearTimeout(contentLoadingHideTimer);
  contentLoadingHideTimer = setTimeout(() => {
    contentLoadingHideTimer = null;
    if (contentLoadingDepth > 0) return;
    const el = document.getElementById("content-loading");
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("aria-busy", "false");
    document.body.removeAttribute("aria-busy");
  }, 80);
}

/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
async function withContentLoading(fn) {
  showContentLoading();
  try {
    return await fn();
  } finally {
    hideContentLoading();
  }
}

/** @type {any} */
let competition = null;
/** @type {any[]} */
let competitions = [];
/** @type {{ id: string, slug?: string, name?: string }[]} */
let competitionResolve = [];
/** @type {string} */
let activeCompetitionId = localStorage.getItem("tmCompetition") || "PL1";
/** @type {any[]} */
let clubs = [];
/** @type {any[]} */
let players = [];
/** @type {any[]} */
let games = [];
/** @type {{ category: string, count: number }[]} */
let refCategories = [];
/** @type {any[]} */
let refItems = [];

/** AF league catalogs for predicted XI — filled from /af/leagues on boot. */
/** @type {any[]} */
let XI_LEAGUES = [
  {
    id: "ekstraklasa",
    name: "Ekstraklasa",
    source: "af",
    path: "ekstraklasa",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "PL1",
    afLeagueId: 106,
    mantraTournamentId: 18,
  },
  {
    id: "serie-a",
    name: "Serie A",
    source: "af",
    path: "serie-a",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "IT1",
    afLeagueId: 135,
    mantraTournamentId: 1,
  },
  {
    id: "bundesliga",
    name: "Bundesliga",
    source: "af",
    path: "bundesliga",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "L1",
    afLeagueId: 78,
    mantraTournamentId: 3,
  },
  {
    id: "premier-league",
    name: "Premier League",
    source: "af",
    path: "premier-league",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "GB1",
    afLeagueId: 39,
    mantraTournamentId: 2,
  },
  {
    id: "championship",
    name: "Championship",
    source: "af",
    path: "championship",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "GB2",
    afLeagueId: 40,
    mantraTournamentId: 11,
  },
  {
    id: "super-lig",
    name: "Süper Lig",
    source: "af",
    path: "super-lig",
    seasons: [2026],
    defaultSeason: 2026,
    tmCompetition: "TR1",
    afLeagueId: 203,
    mantraTournamentId: 21,
  },
];

/** Same Latin names as `/tables`, plus League One. */
const BUILDER_SELECT_LABELS = {
  ekstraklasa: "Ekstraklasa",
  "serie-a": "Serie A",
  bundesliga: "Bundesliga",
  "premier-league": "Premier League",
  championship: "Championship",
  "league-one": "League One",
  "super-lig": "Süper Lig",
  "ligue-1": "Ligue 1",
  "la-liga": "La Liga",
  eredivisie: "Eredivisie",
  "jupiler-pro-league": "Pro League",
  "primeira-liga": "Primeira Liga",
  upl: "UPL",
  mls: "MLS",
  brasileirao: "Brasileirão",
};
const BUILDER_SELECT_FALLBACK = [
  { slug: "ekstraklasa", name: "Ekstraklasa", tmCompetition: "PL1", mantraTournamentId: 18, afLeagueId: 106 },
  { slug: "serie-a", name: "Serie A", tmCompetition: "IT1", mantraTournamentId: 1, afLeagueId: 135 },
  { slug: "bundesliga", name: "Bundesliga", tmCompetition: "L1", mantraTournamentId: 3, afLeagueId: 78 },
  { slug: "premier-league", name: "Premier League", tmCompetition: "GB1", mantraTournamentId: 2, afLeagueId: 39 },
  { slug: "championship", name: "Championship", tmCompetition: "GB2", mantraTournamentId: 11, afLeagueId: 40 },
  { slug: "super-lig", name: "Süper Lig", tmCompetition: "TR1", mantraTournamentId: 21, afLeagueId: 203 },
  { slug: "ligue-1", name: "Ligue 1", tmCompetition: "FR1", mantraTournamentId: 4, afLeagueId: 61 },
  { slug: "la-liga", name: "La Liga", tmCompetition: "ES1", mantraTournamentId: 5, afLeagueId: 140 },
  { slug: "eredivisie", name: "Eredivisie", tmCompetition: "NL1", mantraTournamentId: 12, afLeagueId: 88 },
  { slug: "jupiler-pro-league", name: "Pro League", tmCompetition: "BE1", mantraTournamentId: 13, afLeagueId: 144 },
  { slug: "primeira-liga", name: "Primeira Liga", tmCompetition: "PO1", mantraTournamentId: 14, afLeagueId: 94 },
  { slug: "upl", name: "UPL", tmCompetition: "UKR1", mantraTournamentId: 15, afLeagueId: 333 },
  { slug: "mls", name: "MLS", tmCompetition: "MLS1", mantraTournamentId: 16, afLeagueId: 253 },
  { slug: "brasileirao", name: "Brasileirão", tmCompetition: "BRA1", mantraTournamentId: 19, afLeagueId: 71 },
  { slug: "league-one", name: "League One", tmCompetition: "GB3", mantraTournamentId: 26, afLeagueId: 41 },
];
/** @type {{ slug: string, name: string, tmCompetition: string, mantraTournamentId: number, afLeagueId: number }[]} */
let builderLeaguesCatalog = BUILDER_SELECT_FALLBACK.slice();

async function loadXiLeaguesFromApi() {
  try {
    const res = await fetch("/af/leagues");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.leagues || [];
    if (!list.length) return;
    XI_LEAGUES = list.map((l) => ({
      id: l.id || l.slug,
      name: l.name,
      source: l.source || "af",
      path: l.path || l.slug,
      seasons: l.seasons || [data.predictSeason || 2026],
      defaultSeason: l.defaultSeason || data.predictSeason || 2026,
      afLeagueId: l.afLeagueId || l.id,
      tmCompetition: l.tmCompetition,
      mantraTournamentId: l.mantraTournamentId ?? null,
    }));
  } catch {
    /* keep fallback */
  }
}

async function loadBuilderLeaguesFromApi() {
  try {
    const res = await fetch("/builder/leagues");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.leagues || [];
    if (!list.length) return;
    builderLeaguesCatalog = list.map((l) => ({
      slug: l.slug,
      name: BUILDER_SELECT_LABELS[l.slug] || l.name,
      tmCompetition: l.tmCompetition,
      mantraTournamentId: l.mantraTournamentId,
      afLeagueId: l.afId,
    }));
  } catch {
    /* keep fallback */
  }
}

/** @type {Map<number|string, any>} */
const xiTeamById = new Map();
/** @type {any[]} */
let xiTeams = [];
let xiLoadedKey = "";
let xiSelectedTeamId = null;
/** Team slug/id from `#xi?team=` — applied once teams load. */
let xiPendingTeamParam = null;

/** @type {any[]} */
let boardPlayers = [];
/** @type {{ id: number, label: string }[]} */
let mantraLeagues = [];
let boardMinRating = 40;
let mantraAvailable = false;
let rosterFiltersBound = false;
/** @type {"clubs"|"manager"} */
let xiMode = "clubs";
/** @type {any[]} */
let fantasyTeamsAll = [];
/** @type {any|null} */
let managerView = null;
let managerSelectedTeamId = null;
/** Remember scheme pick across team reloads. */
let managerFormationId = null;
/** Selected Mantra/AF round for manager predictions. */
let managerRoundNum = null;

/** Squad Builder state. */
let builderCatalogKey = "";
/** @type {any[]} */
let builderTeams = [];
/** @type {any|null} */
let builderTeamView = null;
let builderTeamId = null;
let builderFormationId = null;
let builderSelectedSlot = null;
let builderEditingAlternative = false;
/** @type {Map<number, number>} formation slot index → Mantra player id */
const builderAssignments = new Map();
/** @type {Map<number, number>} formation slot index → alternative Mantra player id */
const builderAlternatives = new Map();
/** @type {{ authenticated: boolean, googleConfigured: boolean, user: any|null }} */
let accountState = {
  authenticated: false,
  googleConfigured: false,
  user: null,
  entitlements: { expected11Premium: false, expected11Admin: false, liveDraft: false },
  sorare: { source: "sorare_jwt", configured: false, authenticated: false, status: "disabled" },
  sorareInside: { enabled: true, connected: false, status: "empty", count: 0 },
};
/** @type {any[]} */
let builderMyTeams = [];
let builderMyTeamsKey = "";
/** @type {any[]} */
let builderSavedSquads = [];

function formatPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

function ratingBadgeColor(rating, xiMin) {
  const lo = Math.min(xiMin, 40);
  const hi = 100;
  const t = Math.max(0, Math.min(1, (rating - lo) / Math.max(hi - lo, 1)));
  const stops = [
    { t: 0, r: 220, g: 38, b: 38 },
    { t: 0.45, r: 234, g: 179, b: 8 },
    { t: 1, r: 20, g: 83, b: 45 },
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const u = (t - a.t) / Math.max(b.t - a.t, 1e-6);
  const r = Math.round(a.r + (b.r - a.r) * u);
  const g = Math.round(a.g + (b.g - a.g) * u);
  const bl = Math.round(a.b + (b.b - a.b) * u);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
  return {
    bg: `rgb(${r}, ${g}, ${bl})`,
    fg: luminance > 0.55 ? "#14201a" : "#f3f6f1",
  };
}

function currentXiLeague() {
  const tmId = activeCompetitionId;
  const fromAf = XI_LEAGUES.find((l) => l.tmCompetition === tmId);
  if (fromAf) return fromAf;
  const fromBuilder =
    builderLeaguesCatalog.find((l) => l.tmCompetition === tmId) ||
    BUILDER_SELECT_FALLBACK.find((l) => l.tmCompetition === tmId);
  if (fromBuilder) {
    return {
      id: fromBuilder.slug,
      name: fromBuilder.name,
      source: "af",
      path: fromBuilder.slug,
      seasons: [2026],
      defaultSeason: 2026,
      tmCompetition: fromBuilder.tmCompetition,
      afLeagueId: fromBuilder.afLeagueId,
      mantraTournamentId: fromBuilder.mantraTournamentId,
    };
  }
  // Fallback: TM-only competition not in AF registry
  const comp = competitions.find((c) => c.id === tmId);
  return {
    id: tmId,
    name: comp?.name || tmId,
    source: "tm",
    path: tmId,
    seasons: [comp?.seasonId || 2026].filter(Boolean),
    defaultSeason: comp?.seasonId || 2026,
    tmCompetition: tmId,
    afLeagueId: 106,
  };
}

function currentXiSeason() {
  const sel = document.getElementById("xi-season");
  const n = Number(sel?.value);
  if (Number.isFinite(n) && n > 0) return n;
  return currentXiLeague().defaultSeason;
}

function fillXiSeasonSelect() {
  const league = currentXiLeague();
  const seasonSel = document.getElementById("xi-season");
  if (!seasonSel) return;
  const prev = seasonSel.value;
  const seasons = league.seasons?.length ? league.seasons : [league.defaultSeason];
  seasonSel.innerHTML = seasons
    .map((s) => `<option value="${s}">${s}/${String(s + 1).slice(2)}</option>`)
    .join("");
  if (prev && seasons.map(Number).includes(Number(prev))) seasonSel.value = prev;
  else seasonSel.value = String(league.defaultSeason);
}

/** @deprecated kept as alias for boot() */
function fillXiLeagueSelects() {
  fillXiSeasonSelect();
}

async function ensureXiLoaded() {
  applyXiModeUi();
  if (xiMode === "manager") {
    await ensureManagerLoaded();
    return;
  }
  const lineups = document.getElementById("manager-lineups");
  if (lineups) lineups.hidden = true;
  document.getElementById("xi-mantra-formation-wrap").hidden = true;
  const roundWrap = document.getElementById("xi-mantra-round-wrap");
  if (roundWrap) roundWrap.hidden = true;
  const league = currentXiLeague();
  const season = currentXiSeason();
  const key = `clubs:${league.id}:${season}`;
  if (
    key === xiLoadedKey &&
    xiTeams.length &&
    Number(league.afLeagueId) !== 40
  ) {
    return;
  }

  return withContentLoading(async () => {
    document.getElementById("xi-meta").textContent = "Загрузка клубов…";
    document.getElementById("xi-board").hidden = true;
    hideExpertXi();
    document.getElementById("roster-title").textContent = "Все игроки";
    document.getElementById("roster-meta").textContent = "Загрузка игроков…";
    document.getElementById("xi-bench-title").textContent = "Backups";
    document.getElementById("roster-filters").hidden = false;

    // /board is heavy (often 20–40s). Prefill «Свободен в» from the light
    // fantasy-teams payload so Mantra leagues appear immediately.
    const tournamentId =
      league.mantraTournamentId != null && Number.isFinite(Number(league.mantraTournamentId))
        ? Number(league.mantraTournamentId)
        : null;
    if (tournamentId == null) {
      mantraLeagues = [];
      mantraAvailable = false;
      updateMantraFilterVisibility();
      fillRosterMantraFilters();
    } else {
      mantraAvailable = true;
      // Drop previous competition's leagues so we don't flash Cardiff on EK, etc.
      mantraLeagues = [];
      updateMantraFilterVisibility();
      fillRosterMantraFilters();
      void fetch(`/mantra/fantasy-teams?tournamentId=${tournamentId}`)
        .then(async (r) => {
          if (!r.ok) return;
          const data = await r.json();
          if (currentXiLeague().mantraTournamentId !== tournamentId || xiMode !== "clubs") return;
          mantraLeagues = data.leagues || [];
          updateMantraFilterVisibility();
          fillRosterMantraFilters();
        })
        .catch(() => {});
    }

    const url =
      league.source === "tm"
        ? `/api/xi/${encodeURIComponent(league.path)}/teams`
        : `/${league.path}/${season}/teams`;
    const boardUrl =
      league.source === "af" ? `/${league.path}/${season}/board` : null;
    const allXiUrl =
      league.source === "af" ? `/${league.path}/${season}/predicted-xi` : null;

    const [teamsRes, boardRes, allXiRes] = await Promise.all([
      fetch(url),
      boardUrl ? fetch(boardUrl) : Promise.resolve(null),
      allXiUrl ? fetch(allXiUrl) : Promise.resolve(null),
      loadExpertXiCatalog(),
    ]);
    if (!teamsRes.ok) {
      xiTeams = [];
      xiLoadedKey = "";
      boardPlayers = [];
      document.getElementById("xi-teams").innerHTML = "";
      document.getElementById("roster-body").innerHTML = "";
      document.getElementById("xi-meta").textContent =
        `Нет данных для ${league.name} ${season}. Сначала npm run sync:tm / sync:pl`;
      document.getElementById("roster-meta").textContent = "Нет данных";
      return;
    }
    const payload = await teamsRes.json();
    xiTeams = Array.isArray(payload) ? payload : payload.teams || [];

    // Attach avg XI rating and sort strongest → weakest
    const ratingByTeam = new Map();
    if (allXiRes && allXiRes.ok) {
      const preds = await allXiRes.json();
      for (const p of Array.isArray(preds) ? preds : []) {
        const avg =
          p.avgRating != null
            ? Number(p.avgRating)
            : p.xi?.length
              ? p.xi.reduce((s, slot) => s + Number(slot.starter?.score || slot.startShare * 100 || 0), 0) /
                p.xi.length
              : null;
        if (avg != null && Number.isFinite(avg)) ratingByTeam.set(p.teamId, Number(avg.toFixed(1)));
      }
    }
    for (const t of xiTeams) {
      t.avgRating = ratingByTeam.has(t.id) ? ratingByTeam.get(t.id) : null;
    }
    xiTeams.sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || a.name.localeCompare(b.name));

    xiLoadedKey = key;
    xiTeamById.clear();
    renderXiTeams();
    setupRosterClubFilter(xiTeams);
    const top = xiTeams[0];
    document.getElementById("xi-meta").textContent =
      `${league.name} · ${season}/${String(season + 1).slice(2)} · ${xiTeams.length} клубов` +
      (top?.avgRating != null ? ` · лидер ${top.name} (${top.avgRating})` : "") +
      (league.source === "tm" ? " · TM roles + MV" : " · API Football + TM");

    if (boardRes && boardRes.ok) {
      const boardData = await boardRes.json();
      boardPlayers = boardData.players || [];
      mantraLeagues = boardData.mantraLeagues || [];
      mantraAvailable = Boolean(boardData.mantraAvailable);
      boardMinRating = boardPlayers.length
        ? Math.min(...boardPlayers.map((p) => p.rating))
        : 40;
      updateMantraFilterVisibility();
      fillRosterMantraFilters();
      const c = boardData.counts || {};
      document.getElementById("roster-meta").textContent = mantraAvailable
        ? `${c.players ?? boardPlayers.length} игроков · Mantra ${c.mantraMatched ?? 0}/${c.mantra ?? 0}`
        : `${c.players ?? boardPlayers.length} игроков · Mantra: нет лиг для этой страны`;
      renderRosterTable();
    } else if (league.source === "tm") {
      boardPlayers = [];
      mantraAvailable = false;
      updateMantraFilterVisibility();
      document.getElementById("roster-meta").textContent =
        "Таблица «Все игроки» доступна для лиг API Football (Ekstraklasa / Premier League)";
      document.getElementById("roster-body").innerHTML =
        `<tr><td colspan="9">Нет AF board для TM-only режима</td></tr>`;
    } else {
      boardPlayers = [];
      document.getElementById("roster-meta").textContent = "Не удалось загрузить board";
      document.getElementById("roster-body").innerHTML = "";
    }

    const fromHash = resolveXiTeamIdFromParam(xiPendingTeamParam);
    xiPendingTeamParam = null;
    const pick =
      fromHash ??
      (xiSelectedTeamId != null && xiTeamById.has(xiSelectedTeamId)
        ? xiSelectedTeamId
        : xiTeams[0]?.id);
    if (pick != null) await selectXiTeam(pick);
  });
}

function applyXiModeUi() {
  const manager = xiMode === "manager";
  document.getElementById("xi-season-wrap").hidden = manager;
  document.getElementById("xi-mantra-league-wrap").hidden = !manager;
  document.getElementById("xi-mantra-formation-wrap").hidden = !manager;
  const roundWrap = document.getElementById("xi-mantra-round-wrap");
  if (roundWrap) roundWrap.hidden = !manager;
  document.getElementById("roster-filters").hidden = manager;
  const lineups = document.getElementById("manager-lineups");
  if (lineups) lineups.hidden = !manager;
}

function currentMantraTournamentId() {
  const tid = currentXiLeague().mantraTournamentId;
  return tid != null && Number.isFinite(Number(tid)) ? Number(tid) : 18;
}

async function ensureManagerLoaded() {
  applyXiModeUi();
  document.getElementById("xi-meta").textContent = "Загрузка Mantra-команд…";
  // Do not hide xi-board here — prevents flicker / "disappearing" XI when switching league.
  document.getElementById("roster-title").textContent = "Мой состав";
  document.getElementById("xi-bench-title").textContent = "Запас";
  document.getElementById("roster-filters").hidden = true;

  const league = currentXiLeague();
  const tournamentId = currentMantraTournamentId();
  const leagueSel = document.getElementById("xi-mantra-league");
  if (leagueSel.dataset.tournamentId !== String(tournamentId)) {
    leagueSel.innerHTML = `<option value="">Все лиги</option>`;
    leagueSel.value = "";
    delete leagueSel.dataset.filled;
    leagueSel.dataset.tournamentId = String(tournamentId);
  }
  const leagueFilter = leagueSel.value ? Number(leagueSel.value) : undefined;
  const key = `manager:${tournamentId}:${leagueFilter || "all"}`;
  if (key === xiLoadedKey && fantasyTeamsAll.length) {
    renderFantasyTeamChips();
    const pick =
      managerSelectedTeamId != null && xiTeamById.has(managerSelectedTeamId)
        ? managerSelectedTeamId
        : xiTeams[0]?.id;
    if (pick != null) await selectManagerTeam(pick);
    return;
  }

  return withContentLoading(async () => {
    const qs = new URLSearchParams({ tournamentId: String(tournamentId) });
    if (leagueFilter) qs.set("leagueId", String(leagueFilter));
    const res = await fetch(`/mantra/fantasy-teams?${qs}`);
    if (!res.ok) {
      xiTeams = [];
      fantasyTeamsAll = [];
      xiLoadedKey = "";
      document.getElementById("xi-teams").innerHTML = "";
      document.getElementById("xi-meta").textContent =
        `Нет fantasy-команд. Запусти: npm run sync:mantra -- --teams-only --tournament=${tournamentId}`;
      document.getElementById("roster-meta").textContent = "Нет данных";
      document.getElementById("roster-body").innerHTML = "";
      return;
    }
    const data = await res.json();
    fantasyTeamsAll = data.teams || [];
    const leagues = data.leagues || [];
    if (!leagueSel.dataset.filled) {
      leagueSel.innerHTML =
        `<option value="">Все лиги</option>` +
        leagues.map((l) => `<option value="${l.id}">${l.label || l.name}</option>`).join("");
      leagueSel.dataset.filled = "1";
    }

    xiTeams = fantasyTeamsAll.map((t) => ({
      id: t.id,
      name: t.name,
      logo: t.logoPath,
      leagueName: t.leagueName,
      playerCount: t.playerCount,
      avgRating: null,
    }));
    xiLoadedKey = key;
    xiTeamById.clear();
    renderFantasyTeamChips();
    document.getElementById("xi-meta").textContent =
      `Mantra ${league.name || "fantasy"} · ${xiTeams.length} команд` +
      (leagueFilter ? ` · лига ${leagueSel.selectedOptions[0]?.textContent || ""}` : "");

    const pick =
      managerSelectedTeamId != null && xiTeamById.has(managerSelectedTeamId)
        ? managerSelectedTeamId
        : xiTeams[0]?.id;
    if (pick != null) await selectManagerTeam(pick);
    else {
      document.getElementById("roster-meta").textContent = "Выбери команду";
      document.getElementById("roster-body").innerHTML = "";
    }
  });
}

function renderFantasyTeamChips() {
  const el = document.getElementById("xi-teams");
  el.innerHTML = "";
  for (const team of xiTeams) {
    xiTeamById.set(team.id, team);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-chip";
    btn.dataset.teamId = String(team.id);
    const sub = team.leagueName
      ? `<span class="team-chip-rating">${team.playerCount ?? "?"} игроков</span>`
      : "";
    btn.innerHTML = `<img src="${team.logo || ""}" alt="" loading="lazy" /><span class="team-chip-name">${team.name}</span>${sub}`;
    btn.title = `${team.name}${team.leagueName ? ` · ${team.leagueName}` : ""}`;
    btn.addEventListener("click", () => selectManagerTeam(team.id));
    el.appendChild(btn);
  }
}

function fillManagerRoundSelect(view) {
  const sel = document.getElementById("xi-mantra-round");
  if (!sel) return;
  const rounds = view.rounds || [];
  const pick =
    (managerRoundNum != null && rounds.some((r) => r.round === managerRoundNum) && managerRoundNum) ||
    view.round ||
    rounds.find((r) => !r.played)?.round ||
    rounds[0]?.round ||
    "";
  sel.innerHTML = rounds
    .map((r) => {
      const odds = r.oddsCount > 0 ? " · odds" : "";
      const state = r.played ? " · сыгран" : r.upcoming ? "" : "";
      return `<option value="${r.round}">${r.label || `Тур ${r.round}`}${state}${odds}</option>`;
    })
    .join("");
  if (pick !== "" && [...sel.options].some((o) => o.value === String(pick))) {
    sel.value = String(pick);
  }
  managerRoundNum = sel.value ? Number(sel.value) : null;
}

async function selectManagerTeam(teamId) {
  managerSelectedTeamId = teamId;
  setXiSelectedChip(teamId);
  statusEl.textContent = "Загрузка состава…";
  return withContentLoading(async () => {
    // Keep previous pitch visible until new data arrives (avoid "disappearing XI").
    const afLeagueId = currentXiLeague().afLeagueId || 106;
    const qs = new URLSearchParams({ afLeagueId: String(afLeagueId) });
    if (managerRoundNum != null && Number.isFinite(managerRoundNum)) {
      qs.set("round", String(managerRoundNum));
    }
    const res = await fetch(`/mantra/fantasy-teams/${teamId}?${qs}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = err.error || `Ошибка ${res.status}`;
      return;
    }
    if (managerSelectedTeamId !== teamId) return; // stale
    managerView = await res.json();
    if (managerView.round != null) managerRoundNum = managerView.round;
    fillManagerRoundSelect(managerView);
    const preferred =
      (managerFormationId &&
        (managerView.formations || []).some((f) => f.formation === managerFormationId) &&
        managerFormationId) ||
      managerView.idealXi?.formation ||
      null;
    managerFormationId = preferred;
    fillManagerFormationSelect(managerView, preferred);
    renderManagerView(managerView, preferred);
    const roundLabel =
      managerView.round != null
        ? ` · тур ${managerView.round}${managerView.roundPlayed ? " (сыгран)" : ""}`
        : "";
    statusEl.textContent = `${managerView.team.name} · идеальный XI${roundLabel}`;
  });
}

function fillManagerFormationSelect(view, selectedId) {
  const sel = document.getElementById("xi-mantra-formation");
  if (!sel) return;
  const forms = view.formations?.length ? view.formations : view.idealXi ? [view.idealXi] : [];
  const pick =
    selectedId ||
    managerFormationId ||
    view.idealXi?.formation ||
    forms[0]?.formation ||
    "";
  sel.innerHTML = forms
    .map((f) => {
      const win =
        f.avgWinProb != null ? ` · P(win) ${(f.avgWinProb * 100).toFixed(0)}%` : "";
      const label = `${f.formation} · Σ ${Number(f.totalScore).toFixed(1)}${win}`;
      return `<option value="${f.formation}">${label}</option>`;
    })
    .join("");
  if (pick && [...sel.options].some((o) => o.value === pick)) sel.value = pick;
  else if (forms[0]) sel.value = forms[0].formation;
  managerFormationId = sel.value || null;
}

function formatWinProb(p) {
  if (p == null || !Number.isFinite(Number(p))) return "—";
  return `${(Number(p) * 100).toFixed(0)}%`;
}

/** Pitch/bench subline: P(win) plus role-relevant P(CS) or P(gol) when present. */
function formatPropHints(p) {
  const bits = [`P(win) ${formatWinProb(p.winProb)}`];
  const pos = p.positions || [];
  const def = pos.some((x) => ["GK", "CB", "RB", "LB", "WB", "DM"].includes(x));
  const atk = pos.some((x) => ["AM", "W", "FW", "ST"].includes(x));
  if (def && p.cleanSheetProb != null) bits.push(`P(CS) ${formatWinProb(p.cleanSheetProb)}`);
  else if ((atk || !def) && p.goalActionProb != null) bits.push(`P(gol) ${formatWinProb(p.goalActionProb)}`);
  return bits.join(" · ");
}

function pickManagerFormation(view, formationId) {
  const forms = view.formations || [];
  return forms.find((f) => f.formation === formationId) || view.idealXi;
}

function renderManagerView(view, formationId) {
  const team = view.team;
  const want = formationId || managerFormationId || view.idealXi?.formation;
  const ideal = pickManagerFormation(view, want) || view.idealXi;
  managerFormationId = ideal?.formation || want || null;
  const sel = document.getElementById("xi-mantra-formation");
  if (sel && managerFormationId && sel.value !== managerFormationId) {
    if ([...sel.options].some((o) => o.value === managerFormationId)) {
      sel.value = managerFormationId;
    }
  }
  const board = document.getElementById("xi-board");
  board.hidden = false;
  hideExpertXi();
  document.getElementById("manager-lineups").hidden = false;
  document.getElementById("roster-filters").hidden = true;
  document.getElementById("xi-team-logo").src = team.logoPath || "";
  document.getElementById("xi-team-logo").alt = team.name;
  document.getElementById("xi-team-name").textContent = team.name;
  document.getElementById("xi-team-meta").textContent = [
    team.leagueName,
    view.round != null ? `Тур ${view.round}${view.roundPlayed ? " · сыгран" : ""}` : null,
    ideal.formation,
    "только родные Mantra-позиции",
  ]
    .filter(Boolean)
    .join(" · ");

  const stats = [
    ideal.avgScore != null ? ["score", String(ideal.avgScore)] : null,
    ideal.avgWinProb != null ? ["P(win)", formatWinProb(ideal.avgWinProb)] : null,
    view.round != null ? ["тур", String(view.round)] : null,
    ["slots", `${ideal.filled}/${ideal.totalSlots}`],
    ["roster", String(view.roster.length)],
  ].filter(Boolean);
  document.getElementById("xi-stats").innerHTML = stats
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join("");

  const pitch = document.getElementById("xi-pitch");
  pitch.innerHTML = `<div class="formation-label">${ideal.formation || "XI"}</div>`;
  const ratings = ideal.slots.map((s) => Number(s.effectiveScore) || 0);
  const xiMin = ratings.length ? Math.min(...ratings) : 40;
  for (const slot of ideal.slots) {
    const el = document.createElement("div");
    el.className = "player";
    el.style.left = `${slot.x}%`;
    el.style.top = `${slot.y}%`;
    const rating = Math.round(Number(slot.effectiveScore) || 0);
    const { bg, fg } = ratingBadgeColor(rating, xiMin);
    const props = formatPropHints(slot.player);
    const pts =
      slot.player.roundMantraPts != null
        ? ` · ${Number(slot.player.roundMantraPts).toFixed(1)} pts`
        : slot.player.fotmobRating != null
          ? ` · FM ${Number(slot.player.fotmobRating).toFixed(1)}`
          : "";
    el.innerHTML = `
      <span class="kit" style="background:${bg};color:${fg}">${slot.label}</span>
      <span class="name">${slot.player.fullName || slot.player.name}</span>
      <span class="sub">${(slot.player.positions || []).join("/") || "—"} · ${props}${pts}</span>
    `;
    el.title = [
      slot.player.clubName,
      slot.player.matchLabel,
      slot.player.bookmaker ? `odds: ${slot.player.bookmaker}` : null,
      slot.player.kickoff ? `kickoff: ${slot.player.kickoff}` : null,
      slot.player.cleanSheetProb != null
        ? `P(CS): ${formatWinProb(slot.player.cleanSheetProb)}`
        : null,
      slot.player.goalActionProb != null
        ? `P(gol/team score): ${formatWinProb(slot.player.goalActionProb)}`
        : null,
      slot.player.prevRoundMinutes != null
        ? `R-1 мин: ${slot.player.prevRoundMinutes}`
        : null,
      slot.player.roundMantraPts != null
        ? `Mantra pts: ${slot.player.roundMantraPts}`
        : null,
      slot.player.fotmobRating != null ? `FotMob: ${slot.player.fotmobRating}` : null,
      slot.player.roundMinutes != null ? `мин: ${slot.player.roundMinutes}` : null,
      slot.player.inClubIdealXi ? "В идеальном XI клуба" : null,
    ]
      .filter(Boolean)
      .join("\n");
    pitch.appendChild(el);
  }

  const backupsEl = document.getElementById("xi-backups");
  backupsEl.innerHTML = "";
  const bench = ideal.bench || [];
  if (!bench.length) {
    backupsEl.innerHTML = `<li><span class="who">Весь состав в XI</span></li>`;
  } else {
    for (const p of bench.slice(0, 12)) {
      const li = document.createElement("li");
      const r = p.boardRating != null ? Math.round(p.boardRating) : "—";
      li.innerHTML = `
        <span class="slot">${(p.positions || []).slice(0, 2).join("/") || "—"}</span>
        <span class="who">${p.fullName || p.name}</span>
        <span class="for">${formatPropHints(p)} · ${r}</span>
      `;
      backupsEl.appendChild(li);
    }
  }

  document.getElementById("manager-lineup-meta").innerHTML = [
    view.round != null
      ? `<span class="form-chip">Тур ${view.round}${view.roundPlayed ? " · сыгран" : ""}</span>`
      : "",
    `<span class="form-chip">${ideal.formation}</span>`,
    ideal.avgWinProb != null
      ? `<span class="lineup-xpts">ср. P(win) <strong>${formatWinProb(ideal.avgWinProb)}</strong></span>`
      : "",
    `<span class="muted">XI ${ideal.filled} · запас ${bench.length}</span>`,
    ideal.reason ? `<span class="muted">${ideal.reason}</span>` : "",
  ].join(" ");

  document.getElementById("manager-xi-body").innerHTML = (ideal.slots || [])
    .map((s) => {
      const p = s.player;
      const rating =
        p.roundMantraPts != null
          ? Number(p.roundMantraPts).toFixed(1)
          : p.fotmobRating != null
            ? `FM ${Number(p.fotmobRating).toFixed(1)}`
            : p.boardRating != null
              ? Math.round(p.boardRating)
              : "—";
      return `<tr>
        <td><span class="tag tag-starter">${s.label}</span></td>
        <td>${p.fullName || p.name}</td>
        <td>${(p.positions || []).join("/") || "—"}</td>
        <td>${p.clubName || "—"}</td>
        <td>${p.matchLabel || "—"}${p.bookmaker ? ` <span class="muted">(${p.bookmaker})</span>` : ""}</td>
        <td class="mono">${formatPropHints(p)}${p.winOdd != null ? ` <span class="muted">(${Number(p.winOdd).toFixed(2)})</span>` : ""}</td>
        <td>${rating}</td>
      </tr>`;
    })
    .join("");

  document.getElementById("manager-bench-body").innerHTML = bench
    .map((p) => {
      const rating = p.boardRating != null ? Math.round(p.boardRating) : "—";
      const status = p.inClubIdealXi
        ? `<span class="tag tag-backup">Club XI</span>`
        : `<span class="tag tag-squad">Запас</span>`;
      return `<tr>
        <td>${p.fullName || p.name}</td>
        <td>${(p.positions || []).join("/") || "—"}</td>
        <td>${p.clubName || "—"}</td>
        <td>${p.matchLabel || "—"}</td>
        <td class="mono">${formatPropHints(p)}</td>
        <td>${rating}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("") || `<tr><td colspan="7">Пусто</td></tr>`;

  document.getElementById("roster-title").textContent = "Весь состав";
  document.getElementById("roster-meta").textContent =
    `${view.roster.length} игроков · ${ideal.formation} (${ideal.filled}/11)` +
    (team.syncedAt ? ` · sync ${team.syncedAt.slice(0, 10)}` : "");
  const head = document.querySelector("#roster-head tr") || document.querySelector(".roster-table thead tr");
  if (head) {
    head.innerHTML = `<th>Игрок</th><th>Клуб</th><th>Odds</th><th>Матч</th><th>Mantra</th><th>Статус</th><th>Рейтинг</th><th>€</th>`;
  }
  renderManagerRosterTable(view, ideal);
}

function renderManagerRosterTable(view, ideal) {
  const body = document.getElementById("roster-body");
  const starterIds = new Set((ideal?.slots || []).map((s) => s.player.mantraId));
  const ratings = view.roster.map((p) => p.boardRating).filter((r) => r != null);
  const minR = ratings.length ? Math.min(...ratings) : 40;
  body.innerHTML = view.roster
    .map((p) => {
      const rating = p.boardRating != null ? Math.round(p.boardRating) : null;
      const badge =
        rating != null
          ? (() => {
              const { bg, fg } = ratingBadgeColor(rating, minR);
              return `<span class="rating-pill" style="background:${bg};color:${fg}">${rating}</span>`;
            })()
          : "—";
      const mantraPos = (p.positions || [])
        .map((x) => `<span class="tag tag-pos">${x}</span>`)
        .join("");
      const status = starterIds.has(p.mantraId)
        ? `<span class="tag tag-starter">Основа</span>`
        : p.inClubIdealXi
          ? `<span class="tag tag-backup">Club XI</span>`
          : `<span class="tag tag-squad">Запас</span>`;
      return `<tr>
        <td>${p.fullName || p.name}</td>
        <td>${p.clubName || "—"}</td>
        <td>${formatPropHints(p)}</td>
        <td>${p.matchLabel || "—"}</td>
        <td>${mantraPos || "—"}</td>
        <td>${status}</td>
        <td>${badge}</td>
        <td>${formatMoney(p.marketValueEur)}</td>
      </tr>`;
    })
    .join("");
}

/** MantraFootball position colours (panenka.games / constants.py). */
const MANTRA_POS_COLOR = {
  GK: "#F5A623",
  RB: "#4CAF50",
  CB: "#4CAF50",
  LB: "#4CAF50",
  WB: "#2196F3",
  DM: "#2196F3",
  CM: "#2196F3",
  W: "#9C27B0",
  AM: "#9C27B0",
  FW: "#D0021B",
  ST: "#D0021B",
};

function builderPositionClass(positions) {
  const pos = Array.isArray(positions) ? positions : [];
  const first = pos[0] || "";
  if (first === "GK") return "pos-gk";
  if (["CB", "RB", "LB"].includes(first)) return "pos-def";
  if (["WB", "DM", "CM"].includes(first)) return "pos-mid";
  if (["W", "AM"].includes(first)) return "pos-am";
  if (["FW", "ST"].includes(first)) return "pos-att";
  return "pos-mid";
}

function builderPositionBackground(positions) {
  const tokens = [...new Set((positions || []).map((position) => String(position).toUpperCase()))];
  if (!tokens.length) return "#737373";
  if (tokens.length === 1) return MANTRA_POS_COLOR[tokens[0]] || "#737373";
  const step = 100 / tokens.length;
  const stops = tokens
    .map((token, index) => {
      const color = MANTRA_POS_COLOR[token] || "#737373";
      return `${color} ${index * step}%, ${color} ${(index + 1) * step}%`;
    })
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

function builderInitials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function builderSurname(player) {
  const fullName = String(player?.fullName || "").trim();
  if (fullName) return fullName.split(/\s+/).at(-1);
  return String(player?.name || "?");
}

const MANTRA_IMAGE_ORIGIN = "https://mantrafootball.s3.eu-west-1.amazonaws.com";
const MANTRA_IMAGE_PATHS = [
  "/player_avatars/",
  "/club_logo/",
  "/teams/",
  "/user_logos/",
];

function builderPublicImage(src) {
  if (!src || typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/mantra/image")) return trimmed;
  try {
    const url = new URL(trimmed, `${MANTRA_IMAGE_ORIGIN}/`);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mantrafootball.s3.eu-west-1.amazonaws.com" ||
      url.port ||
      url.username ||
      url.password ||
      !MANTRA_IMAGE_PATHS.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      return null;
    }
    return `/mantra/image?url=${encodeURIComponent(url.href)}`;
  } catch {
    return null;
  }
}

function builderAvatarMarkup(player, imageClass) {
  const name = player.fullName || player.name || "?";
  const fallback = `<span class="builder-slot-initials">${esc(builderInitials(name))}</span>`;
  const photoSrc = builderPublicImage(player.avatarPath);
  const portrait = photoSrc
    ? `${fallback}<img class="${imageClass}" src="${esc(photoSrc)}" alt="" loading="lazy" onerror="this.hidden=true" />`
    : fallback;
  const clubSrc = builderPublicImage(player.clubLogo) || player.clubLogo;
  const club = clubSrc
    ? `<img class="builder-slot-club" src="${esc(clubSrc)}" alt="" loading="lazy" onerror="this.hidden=true" />`
    : "";
  return `${portrait}${club}`;
}

async function apiJson(url, options, timeoutMs = 0) {
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.code = data.code || data.error;
      error.remainingMs = data.remainingMs;
      error.lastRefreshedAt = data.lastRefreshedAt;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(timeoutMs ? `нет ответа за ${Math.round(timeoutMs / 1000)}с` : "отменено");
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fillAccountTimeZones(selectedTimeZone) {
  const select = document.getElementById("account-time-zone");
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [browserTimeZone, "UTC"];
  const selected = selectedTimeZone || getUiTimeZone() || browserTimeZone;
  if (!timeZones.includes(selected)) timeZones.push(selected);
  select.innerHTML = [...new Set(timeZones)]
    .sort((a, b) => a.localeCompare(b))
    .map((timeZone) => `<option value="${esc(timeZone)}">${esc(timeZone)}</option>`)
    .join("");
  select.value = selected;
}

function renderSorareInsideConnection() {
  const connection = accountState.sorareInside || {
    enabled: true,
    connected: false,
    status: "empty",
    count: 0,
    importedAt: null,
    expiresAt: null,
  };
  const connected = accountState.authenticated && connection.connected;
  const accountStatus = document.getElementById("account-si-status");
  const accountConnect = document.getElementById("account-si-connect");
  const accountDisconnect = document.getElementById("account-si-disconnect");
  const privateStatus = document.getElementById("sorare-private-status");
  const privateOpen = document.getElementById("sorare-private-open");

  let status = "Импортов пока нет";
  if (!accountState.authenticated) status = "Сначала войди через Google";
  else if (connected) {
    status = `Импортировано: ${connection.count || 0} · ${formatUiDateTime(
      new Date(connection.importedAt).toISOString(),
    )}`;
  }

  if (accountStatus) accountStatus.textContent = status;
  if (accountConnect) accountConnect.hidden = !accountState.authenticated;
  if (accountDisconnect) accountDisconnect.hidden = !connected;
  if (privateStatus) privateStatus.textContent = status;
  if (privateOpen) {
    privateOpen.textContent = "Browser import";
    privateOpen.disabled = !accountState.authenticated && !accountState.googleConfigured;
  }
}

function renderSorareAuthentication() {
  const authentication = accountState.sorare || {
    configured: false,
    authenticated: false,
    status: "disabled",
    expiresAt: null,
  };
  const element = document.getElementById("account-sorare-status");
  if (!element) return;
  let status = "Sorare JWT не настроен на сервере";
  if (authentication.status === "not_checked") {
    status = "Sorare JWT настроен · вход при первом запросе";
  } else if (authentication.status === "ready" && authentication.expiresAt) {
    status = `Sorare JWT подключён до ${formatUiDateTime(authentication.expiresAt)}`;
  } else if (authentication.status === "two_factor_required") {
    status = "Sorare требует 2FA · автоматический вход остановлен";
  } else if (authentication.status === "terms_required") {
    status = "Sorare требует принять обновлённые условия";
  } else if (authentication.status === "error") {
    status = "Ошибка входа Sorare";
  }
  element.textContent = status;
}

function renderAccount() {
  const login = document.getElementById("account-login");
  const button = document.getElementById("account-button");
  const user = accountState.user;
  login.hidden = accountState.authenticated;
  button.hidden = !accountState.authenticated;
  const googleOk = googleSignInEnabled(accountState);
  login.textContent = googleOk ? "Войти через Google" : "Google-вход не настроен";
  login.setAttribute("aria-disabled", googleOk ? "false" : "true");
  const expected11Premium = Boolean(
    accountState.authenticated && accountState.entitlements?.expected11Premium,
  );
  const expected11Admin = Boolean(
    accountState.authenticated && accountState.entitlements?.expected11Admin,
  );
  const mappingTab = document.querySelector(`.tab[data-view="mapping"]`);
  if (mappingTab) mappingTab.hidden = !expected11Admin;
  const premiumTab = document.querySelector(`.tab[data-view="premium"]`);
  if (premiumTab) premiumTab.hidden = !expected11Premium;
  const liveDraft = Boolean(
    accountState.authenticated && accountState.entitlements?.liveDraft,
  );
  const liveDraftTab = document.querySelector(`.tab[data-view="live-draft"]`);
  if (liveDraftTab) liveDraftTab.hidden = !liveDraft;

  if (user) {
    setUiPreferences({
      locale: user.locale || getUiLocale(),
      timeZone: user.timeZone || getUiTimeZone(),
    });
    document.getElementById("account-name").textContent = user.name || user.email;
    const avatar = document.getElementById("account-avatar");
    avatar.hidden = !user.pictureUrl;
    avatar.src = user.pictureUrl || "";
    document.getElementById("account-dialog-name").textContent = user.name || "Аккаунт";
    document.getElementById("account-dialog-email").textContent = user.email;
    const dialogAvatar = document.getElementById("account-dialog-avatar");
    dialogAvatar.hidden = !user.pictureUrl;
    dialogAvatar.src = user.pictureUrl || "";
    document.getElementById("account-manager-id").value = user.mantraManagerId || "";
    document.getElementById("account-locale").value = user.locale || getUiLocale();
    fillAccountTimeZones(user.timeZone || getUiTimeZone());
  } else {
    document.getElementById("account-locale").value = getUiLocale();
    fillAccountTimeZones(getUiTimeZone());
  }

  const myTeams = document.getElementById("builder-my-teams");
  if (myTeams) {
    myTeams.disabled = !accountState.authenticated || !user?.mantraManagerId;
    if (myTeams.disabled) myTeams.checked = false;
  }
  renderBuilderSaveControls();
  renderSorareAuthentication();
  renderSorareInsideConnection();
  syncBuilderAuctionRefreshButton();
  if (currentPageName() === "builder") loadBuilderAuctionCooldown();
}

async function loadAccount() {
  try {
    accountState = await apiJson("/api/me");
  } catch {
    accountState = {
      authenticated: false,
      googleConfigured: false,
      user: null,
      entitlements: { expected11Premium: false, expected11Admin: false, liveDraft: false },
      sorare: {
        source: "sorare_jwt",
        configured: false,
        authenticated: false,
        status: "disabled",
      },
      sorareInside: { enabled: true, connected: false, status: "empty", count: 0 },
    };
  }
  renderAccount();
}

function renderBuilderSaveControls() {
  const save = document.getElementById("builder-save");
  const name = document.getElementById("builder-save-name");
  const saved = document.getElementById("builder-saved");
  const load = document.getElementById("builder-load-save");
  const remove = document.getElementById("builder-delete-save");
  const download = document.getElementById("builder-download");
  if (!save || !name || !saved || !load || !remove) return;

  const canSave =
    accountState.authenticated && builderTeamId != null && builderFormationId != null;
  save.disabled = !canSave;
  name.disabled = !accountState.authenticated;
  saved.disabled = !accountState.authenticated || !builderSavedSquads.length;
  load.disabled = !saved.value;
  remove.disabled = !saved.value;
  if (download) {
    download.disabled =
      !builderTeamView || !builderFormationId || builderAssignments.size === 0;
  }
}

function fillBuilderSavedSelect(selectedId = null) {
  const saved = document.getElementById("builder-saved");
  if (!saved) return;
  saved.innerHTML = builderSavedSquads.length
    ? `<option value="">Выбери сохранение…</option>` +
      builderSavedSquads
        .map(
          (squad) =>
            `<option value="${squad.id}">${esc(squad.name)} · ${esc(squad.formation)}</option>`,
        )
        .join("")
    : `<option value="">Нет сохранений</option>`;
  if (
    selectedId != null &&
    builderSavedSquads.some((squad) => Number(squad.id) === Number(selectedId))
  ) {
    saved.value = String(selectedId);
  }
  renderBuilderSaveControls();
}

async function loadBuilderSavedSquads(selectedId = null) {
  if (!accountState.authenticated || builderTeamId == null) {
    builderSavedSquads = [];
    fillBuilderSavedSelect();
    document.getElementById("builder-save-meta").textContent = accountState.authenticated
      ? "Выбери команду, чтобы увидеть сохранения"
      : "Войди через Google, чтобы сохранять составы";
    return;
  }
  try {
    const data = await apiJson(
      `/api/squad-builder/saves?teamId=${encodeURIComponent(builderTeamId)}`,
    );
    builderSavedSquads = data.squads || [];
    fillBuilderSavedSelect(selectedId);
    document.getElementById("builder-save-meta").textContent = builderSavedSquads.length
      ? `Сохранено составов: ${builderSavedSquads.length}`
      : "Для этой команды пока нет сохранённых составов";
  } catch (error) {
    builderSavedSquads = [];
    fillBuilderSavedSelect();
    document.getElementById("builder-save-meta").textContent = `Ошибка: ${error.message}`;
  }
}

async function loadBuilderMyTeams() {
  const tournamentId = currentMantraTournamentId();
  const managerId = accountState.user?.mantraManagerId;
  if (!accountState.authenticated || !managerId) {
    builderMyTeams = [];
    builderMyTeamsKey = "";
    return;
  }
  const key = `${tournamentId}:${managerId || ""}`;
  if (builderMyTeamsKey === key) return;
  const data = await apiJson(
    `/api/me/mantra-teams?tournamentId=${encodeURIComponent(tournamentId)}`,
  );
  builderMyTeams = data.teams || [];
  builderMyTeamsKey = key;
}

function builderSelectCompetitions() {
  const catalog = builderLeaguesCatalog.length ? builderLeaguesCatalog : BUILDER_SELECT_FALLBACK;
  const byId = new Map((competitions || []).map((c) => [c.id, c]));
  return catalog.map((l) => {
    const c = byId.get(l.tmCompetition);
    return {
      ...(c || { id: l.tmCompetition, name: l.name }),
      id: l.tmCompetition,
      name: BUILDER_SELECT_LABELS[l.slug] || l.name,
      builderSlug: l.slug,
    };
  });
}

function fillBuilderCompetitionSelect() {
  const sel = document.getElementById("builder-competition");
  if (!sel) return;
  const options = builderSelectCompetitions();
  sel.innerHTML = options
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  if ([...sel.options].some((o) => o.value === activeCompetitionId)) {
    sel.value = activeCompetitionId;
  }
}

function resetBuilderState({ catalog = false } = {}) {
  if (catalog) {
    builderCatalogKey = "";
    builderTeams = [];
    builderMyTeamsKey = "";
    builderMyTeams = [];
  }
  builderTeamView = null;
  builderTeamId = null;
  builderFormationId = null;
  builderSelectedSlot = null;
  builderEditingAlternative = false;
  builderAssignments.clear();
  builderAlternatives.clear();
  const alternativesToggle = document.getElementById("builder-show-alternatives");
  if (alternativesToggle) alternativesToggle.checked = false;
  builderSavedSquads = [];
  fillBuilderSavedSelect();
}

function syncBuilderHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  const next = qs.toString() ? `/builder?${qs}` : "/builder";
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}

function fillBuilderTeamSelect() {
  const leagueId = Number(document.getElementById("builder-league").value);
  const onlyMine = document.getElementById("builder-my-teams").checked;
  const source = onlyMine ? builderMyTeams : builderTeams;
  const teams = Number.isFinite(leagueId)
    ? source.filter((team) => Number(team.leagueId) === leagueId)
    : [];
  const sel = document.getElementById("builder-team");
  const previous = builderTeamId != null ? String(builderTeamId) : "";
  sel.innerHTML =
    `<option value="">Выбери…</option>` +
    teams
      .map(
        (team) =>
          `<option value="${team.id}">${esc(team.name)} · ${team.playerCount ?? "?"} игроков</option>`,
      )
      .join("");
  if (previous && teams.some((team) => String(team.id) === previous)) {
    sel.value = previous;
  } else if (teams[0]) {
    sel.value = String(teams[0].id);
  }
  return sel.value ? Number(sel.value) : null;
}

const BUILDER_REFRESH_AUCTIONS_LABEL = "Обновить после раундов аукциона";
let builderAuctionCooldown = {
  leagueId: null,
  lastRefreshedAt: null,
  remainingMs: 0,
  fetchedAt: 0,
};
let builderAuctionCooldownTimer = null;

function isBuilderAdmin() {
  return Boolean(accountState.authenticated && accountState.entitlements?.expected11Admin);
}

function selectedBuilderLeagueId() {
  const n = Number(document.getElementById("builder-league")?.value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function builderCooldownRemainingMs() {
  if (!builderAuctionCooldown.remainingMs) return 0;
  return Math.max(0, builderAuctionCooldown.remainingMs - (Date.now() - builderAuctionCooldown.fetchedAt));
}

function builderCooldownLabel(remainingMs) {
  return `Доступно через ${Math.max(1, Math.ceil(remainingMs / 60000))} мин`;
}

function applyBuilderAuctionCooldown(leagueId, remainingMs, lastRefreshedAt) {
  builderAuctionCooldown = {
    leagueId,
    lastRefreshedAt: lastRefreshedAt || null,
    remainingMs: Number(remainingMs) || 0,
    fetchedAt: Date.now(),
  };
  if (builderAuctionCooldownTimer) {
    clearInterval(builderAuctionCooldownTimer);
    builderAuctionCooldownTimer = null;
  }
  if (builderAuctionCooldown.remainingMs > 0) {
    builderAuctionCooldownTimer = setInterval(() => {
      if (builderCooldownRemainingMs() <= 0) {
        clearInterval(builderAuctionCooldownTimer);
        builderAuctionCooldownTimer = null;
      }
      syncBuilderAuctionRefreshButton();
    }, 15000);
  }
  syncBuilderAuctionRefreshButton();
}

function syncBuilderAuctionRefreshButton() {
  const button = document.getElementById("builder-refresh-auctions");
  if (!button) return;
  const admin = isBuilderAdmin();
  button.hidden = !admin;
  if (!admin) return;
  if (button.getAttribute("aria-busy") === "true") return;
  const leagueId = selectedBuilderLeagueId();
  const remaining =
    leagueId != null && builderAuctionCooldown.leagueId === leagueId
      ? builderCooldownRemainingMs()
      : 0;
  button.disabled = leagueId == null || remaining > 0;
  button.textContent = remaining > 0 ? builderCooldownLabel(remaining) : BUILDER_REFRESH_AUCTIONS_LABEL;
}

async function loadBuilderAuctionCooldown() {
  const leagueId = selectedBuilderLeagueId();
  if (!isBuilderAdmin() || leagueId == null) {
    applyBuilderAuctionCooldown(leagueId, 0, null);
    return;
  }
  try {
    const data = await apiJson(
      `/api/expected11/premium/refresh-auctions?leagueId=${encodeURIComponent(leagueId)}`,
    );
    applyBuilderAuctionCooldown(leagueId, data.remainingMs, data.lastRefreshedAt);
  } catch {
    if (builderAuctionCooldown.leagueId !== leagueId) applyBuilderAuctionCooldown(leagueId, 0, null);
    else syncBuilderAuctionRefreshButton();
  }
}

async function refreshBuilderAuctions() {
  const button = document.getElementById("builder-refresh-auctions");
  const meta = document.getElementById("builder-meta");
  const leagueId = selectedBuilderLeagueId();
  if (!isBuilderAdmin() || leagueId == null) return;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = BUILDER_REFRESH_AUCTIONS_LABEL;
  }
  if (meta) meta.textContent = "Обновляю аукцион выбранной лиги…";
  try {
    const data = await apiJson(
      "/api/expected11/premium/refresh-auctions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leagueId }),
      },
      300000,
    );
    applyBuilderAuctionCooldown(
      leagueId,
      data.remainingMs || 30 * 60 * 1000,
      data.lastRefreshedAt,
    );
    const warning = data.auctions?.warning ? ` · ${data.auctions.warning}` : "";
    if (meta) {
      meta.textContent = `Лига ${data.league}: составы ${data.teams}, аукционы ${data.auctions?.imported ?? 0}/${data.auctions?.discovered ?? 0}${warning}`;
    }
  } catch (error) {
    if (error.status === 429 || error.code === "auction_refresh_cooldown") {
      applyBuilderAuctionCooldown(leagueId, error.remainingMs, error.lastRefreshedAt);
      if (meta) meta.textContent = builderCooldownLabel(builderCooldownRemainingMs() || error.remainingMs || 1);
      return;
    }
    if (meta) meta.textContent = `Ошибка: ${error.message}`;
  } finally {
    if (button) button.removeAttribute("aria-busy");
    syncBuilderAuctionRefreshButton();
  }
}

async function ensureBuilderLoaded() {
  fillBuilderCompetitionSelect();
  syncBuilderHash();
  const tournamentId = currentMantraTournamentId();
  const key = String(tournamentId);
  const leagueSel = document.getElementById("builder-league");
  document.getElementById("builder-meta").textContent = "Загрузка Mantra-лиг…";

  if (builderCatalogKey !== key) {
    await withContentLoading(async () => {
      const res = await fetch(`/mantra/fantasy-teams?tournamentId=${tournamentId}`);
      if (!res.ok) throw new Error(`Mantra teams HTTP ${res.status}`);
      const data = await res.json();
      builderTeams = data.teams || [];
      builderCatalogKey = key;
      const leagues = data.leagues || [];
      leagueSel.innerHTML =
        `<option value="">Выбери…</option>` +
        leagues
          .map((league) => `<option value="${league.id}">${esc(league.label || league.name)}</option>`)
          .join("");
      if (leagues[0]) leagueSel.value = String(leagues[0].id);
    });
  }

  if (document.getElementById("builder-my-teams").checked) {
    await loadBuilderMyTeams();
  }
  const teamId = fillBuilderTeamSelect();
  if (teamId != null) {
    await loadBuilderTeam(teamId);
  } else {
    resetBuilderState();
    document.getElementById("builder-formation").innerHTML =
      `<option value="">Выбери…</option>`;
    renderBuilder();
    document.getElementById("builder-meta").textContent =
      document.getElementById("builder-my-teams").checked
        ? "Для выбранной лиги не найдены твои команды"
        : builderTeams.length
          ? "Выбери лигу Mantra"
          : "Для турнира нет Mantra-команд";
  }
  loadBuilderAuctionCooldown();
}

async function loadBuilderTeam(teamId) {
  builderTeamId = Number(teamId);
  builderTeamView = null;
  builderFormationId = null;
  builderSelectedSlot = null;
  builderEditingAlternative = false;
  builderAssignments.clear();
  builderAlternatives.clear();
  document.getElementById("builder-show-alternatives").checked = false;
  document.getElementById("builder-meta").textContent = "Загрузка состава…";
  const requestedId = builderTeamId;

  return withContentLoading(async () => {
    const res = await fetch(`/mantra/squad-builder/${requestedId}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Squad Builder HTTP ${res.status}`);
    }
    if (builderTeamId !== requestedId) return;
    builderTeamView = await res.json();
    const forms = builderTeamView.squadFormations || [];
    const formationSel = document.getElementById("builder-formation");
    formationSel.innerHTML = forms
      .map((form) => `<option value="${esc(form.formation)}">${esc(form.formation)}</option>`)
      .join("");
    const preferred = builderTeamView.idealXi?.formation;
    builderFormationId =
      (preferred && forms.some((form) => form.formation === preferred) && preferred) ||
      forms[0]?.formation ||
      null;
    if (builderFormationId) formationSel.value = builderFormationId;
    const firstSlot = forms.find((form) => form.formation === builderFormationId)?.slots?.[0];
    builderSelectedSlot = firstSlot?.index ?? null;
    document.getElementById("builder-save-name").value =
      builderTeamView.team?.name || "";
    renderBuilder();
    await loadBuilderSavedSquads();
  });
}

function currentBuilderFormation() {
  return (builderTeamView?.squadFormations || []).find(
    (form) => form.formation === builderFormationId,
  );
}

function builderPlayerById(playerId) {
  return builderTeamView?.roster?.find((player) => Number(player.mantraId) === Number(playerId));
}

function playerFitsBuilderSlot(player, slot) {
  return (slot?.accepted || []).some((position) => (player.positions || []).includes(position));
}

function selectNextEmptyBuilderSlot(slots, afterIndex, assignments = builderAssignments) {
  const start = Math.max(
    0,
    slots.findIndex((slot) => Number(slot.index) === Number(afterIndex)),
  );
  for (let step = 1; step <= slots.length; step++) {
    const slot = slots[(start + step) % slots.length];
    if (slot && !assignments.has(slot.index)) return slot.index;
  }
  return afterIndex;
}

function renderBuilderPlayerList(formation) {
  const list = document.getElementById("builder-player-list");
  const hint = document.getElementById("builder-slot-hint");
  const clear = document.getElementById("builder-slot-clear");
  if (!builderTeamView || !formation) {
    list.innerHTML = `<p class="builder-player-empty">Сначала выбери команду и схему</p>`;
    hint.textContent = "Выбери позицию на поле";
    clear.hidden = true;
    return;
  }

  const slot = formation.slots.find(
    (item) => Number(item.index) === Number(builderSelectedSlot),
  );
  const editingAlternative =
    document.getElementById("builder-show-alternatives").checked &&
    builderEditingAlternative;
  const targetAssignments = editingAlternative
    ? builderAlternatives
    : builderAssignments;
  const selectedPlayerId = slot ? targetAssignments.get(slot.index) : null;
  hint.textContent = slot
    ? `${editingAlternative ? "Вторая опция" : "Основной игрок"} · слот ${slot.label} · подходят: ${(slot.accepted || []).join("/")}`
    : "Выбери позицию на поле";
  clear.textContent = editingAlternative ? "Убрать вторую опцию" : "Освободить слот";
  clear.hidden = selectedPlayerId == null;

  const usedByPlayer = new Map();
  for (const [slotIndex, playerId] of builderAssignments) {
    usedByPlayer.set(playerId, { slotIndex, alternative: false });
  }
  for (const [slotIndex, playerId] of builderAlternatives) {
    usedByPlayer.set(playerId, { slotIndex, alternative: true });
  }
  const roster = (builderTeamView.roster || []).filter(
    (player) => !slot || playerFitsBuilderSlot(player, slot),
  );
  list.innerHTML = "";
  if (!roster.length) {
    list.innerHTML = `<p class="builder-player-empty">Нет игроков с подходящей позицией</p>`;
    return;
  }

  for (const player of roster) {
    const used = usedByPlayer.get(player.mantraId);
    const isCurrent =
      slot &&
      used?.slotIndex === slot.index &&
      used?.alternative === editingAlternative;
    const disabled = !slot || (used != null && !isCurrent);
    const positionClass = builderPositionClass(player.positions);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `builder-player-card ${positionClass}`;
    button.style.setProperty(
      "--builder-pos",
      MANTRA_POS_COLOR[player.positions?.[0]] || "#737373",
    );
    button.style.setProperty("--builder-pos-bg", builderPositionBackground(player.positions));
    button.disabled = disabled;
    button.title = disabled && used != null ? "Игрок уже выбран в составе" : "";
    const name = player.fullName || player.name;
    button.innerHTML = `
      <span class="builder-player-avatar">${builderAvatarMarkup(player, "builder-player-photo")}</span>
      <span class="builder-player-copy">
        <span class="builder-player-name">${esc(name)}</span>
        <span class="builder-player-club">${esc(player.clubName || "Без клуба")}</span>
      </span>
      <span class="builder-player-positions">${(player.positions || [])
        .map(
          (position) =>
            `<span class="builder-position-pill ${builderPositionClass([position])}">${esc(position)}</span>`,
        )
        .join("")}</span>
    `;
    button.addEventListener("click", () => {
      if (!slot) return;
      if (isCurrent) {
        targetAssignments.delete(slot.index);
      } else {
        targetAssignments.set(slot.index, player.mantraId);
        if (!editingAlternative) {
          builderSelectedSlot = selectNextEmptyBuilderSlot(
            formation.slots,
            slot.index,
            targetAssignments,
          );
          builderEditingAlternative = false;
        }
      }
      renderBuilder();
    });
    list.appendChild(button);
  }
}

function renderBuilder() {
  const pitch = document.getElementById("builder-pitch");
  const head = document.getElementById("builder-team-head");
  const formation = currentBuilderFormation();
  if (!builderTeamView || !formation) {
    head.hidden = true;
    pitch.innerHTML = `<div class="builder-empty">Выбери лигу Mantra, команду и схему</div>`;
    renderBuilderPlayerList(null);
    renderBuilderSaveControls();
    return;
  }

  const team = builderTeamView.team;
  head.hidden = false;
  document.getElementById("builder-team-logo").src = team.logoPath || "";
  document.getElementById("builder-team-logo").alt = team.name;
  document.getElementById("builder-team-name").textContent = team.name;
  document.getElementById("builder-team-meta").textContent =
    `${team.leagueName || "Mantra"} · ${builderTeamView.roster.length} игроков`;
  const showAlternatives = document.getElementById("builder-show-alternatives").checked;
  document.getElementById("builder-meta").textContent =
    `${formation.formation} · выбрано ${builderAssignments.size}/11` +
    (showAlternatives ? ` · вторых опций ${builderAlternatives.size}/11` : "");

  pitch.innerHTML = `<div class="formation-label">${esc(formation.formation)}</div>`;
  for (const slot of formation.slots) {
    const playerId = builderAssignments.get(slot.index);
    const player = playerId != null ? builderPlayerById(playerId) : null;
    const alternativeId = builderAlternatives.get(slot.index);
    const alternative =
      alternativeId != null ? builderPlayerById(alternativeId) : null;
    const alternativeMarkup = showAlternatives
      ? `<span class="builder-slot-alternative ${alternative ? "" : "is-empty"}">
          ${
            alternative?.clubLogo
              ? `<img src="${esc(alternative.clubLogo)}" alt="" loading="lazy" onerror="this.hidden=true" />`
              : ""
          }
          <span>${alternative ? esc(builderSurname(alternative)) : "+ вторая опция"}</span>
        </span>`
      : "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "builder-slot",
      builderPositionClass(slot.accepted),
      player ? "" : "is-empty",
      showAlternatives ? "shows-alternative" : "",
      Number(builderSelectedSlot) === Number(slot.index) ? "is-selected" : "",
      Number(builderSelectedSlot) === Number(slot.index) &&
      builderEditingAlternative
        ? "is-alternative-selected"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.style.left = `${slot.x}%`;
    button.style.top = `${slot.y}%`;
    button.style.setProperty(
      "--builder-pos",
      MANTRA_POS_COLOR[slot.accepted?.[0]] || "#737373",
    );
    button.style.setProperty("--builder-pos-bg", builderPositionBackground(slot.accepted));
    button.setAttribute("aria-pressed", Number(builderSelectedSlot) === Number(slot.index) ? "true" : "false");
    button.title = `${slot.label}: ${(slot.accepted || []).join("/")}`;
    button.innerHTML = player
      ? `<span class="builder-slot-card">
          <span class="builder-slot-pos">${esc(slot.label)}</span>
          <span class="builder-slot-photo-wrap">${builderAvatarMarkup(player, "builder-slot-photo")}</span>
          <span class="builder-slot-name">${esc(player.fullName || player.name)}</span>
          <span class="builder-slot-native">${esc((player.positions || []).join("/"))}</span>
          ${alternativeMarkup}
        </span>`
      : `<span class="builder-slot-card">
          <span class="builder-slot-pos">${esc(slot.label)}</span>
          <span class="builder-slot-name">+ игрок</span>
          ${alternativeMarkup}
        </span>`;
    button.addEventListener("click", () => {
      const repeatedClick =
        Number(builderSelectedSlot) === Number(slot.index);
      if (
        repeatedClick &&
        showAlternatives &&
        builderAssignments.has(slot.index)
      ) {
        builderEditingAlternative = !builderEditingAlternative;
      } else {
        builderSelectedSlot = slot.index;
        builderEditingAlternative = false;
      }
      renderBuilder();
    });
    pitch.appendChild(button);
  }
  renderBuilderPlayerList(formation);
  renderBuilderSaveControls();
}

function loadBuilderExportImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    image.crossOrigin = "anonymous";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = src;
    setTimeout(() => finish(null), 4000);
  });
}

function builderExportImageSrc(src) {
  return builderPublicImage(src) || src;
}

function drawBuilderExportCover(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  );
}

function drawBuilderExportPitch(ctx, pitch) {
  const gradient = ctx.createLinearGradient(0, pitch.y, 0, pitch.y + pitch.height);
  gradient.addColorStop(0, "#166534");
  gradient.addColorStop(1, "#0f5132");
  ctx.fillStyle = gradient;
  ctx.fillRect(pitch.x, pitch.y, pitch.width, pitch.height);

  ctx.fillStyle = "rgba(255,255,255,0.035)";
  const stripeHeight = pitch.height / 10;
  for (let index = 0; index < 10; index += 2) {
    ctx.fillRect(pitch.x, pitch.y + index * stripeHeight, pitch.width, stripeHeight);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 4;
  ctx.strokeRect(pitch.x + 22, pitch.y + 22, pitch.width - 44, pitch.height - 44);
  ctx.beginPath();
  ctx.moveTo(pitch.x + 22, pitch.y + pitch.height / 2);
  ctx.lineTo(pitch.x + pitch.width - 22, pitch.y + pitch.height / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(pitch.x + pitch.width / 2, pitch.y + pitch.height / 2, 110, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(pitch.x + pitch.width / 2, pitch.y + pitch.height / 2, 7, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fill();

  const boxWidth = pitch.width * 0.5;
  const boxHeight = 180;
  ctx.strokeRect(
    pitch.x + (pitch.width - boxWidth) / 2,
    pitch.y + 22,
    boxWidth,
    boxHeight,
  );
  ctx.strokeRect(
    pitch.x + (pitch.width - boxWidth) / 2,
    pitch.y + pitch.height - boxHeight - 22,
    boxWidth,
    boxHeight,
  );
}

function drawBuilderExportAlternative(ctx, alternative, images, x, y, cardWidth) {
  const stripY = y + 136;
  ctx.fillStyle = alternative ? "#eef2f6" : "#f8fafc";
  ctx.beginPath();
  ctx.roundRect(x + 8, stripY, cardWidth - 16, 26, 8);
  ctx.fill();

  const club = alternative ? images.get(alternative.clubLogo) : null;
  if (club) ctx.drawImage(club, x + 14, stripY + 3, 20, 20);
  ctx.fillStyle = alternative ? "#334155" : "#94a3b8";
  ctx.font = "800 14px Manrope, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(
    alternative ? builderSurname(alternative) : "+ вторая опция",
    x + (club ? 40 : 15),
    stripY + 18,
    cardWidth - (club ? 50 : 25),
  );
  ctx.textAlign = "center";
}

function drawBuilderExportSlot(
  ctx,
  slot,
  player,
  alternative,
  showAlternative,
  images,
  pitch,
) {
  const cardWidth = 184;
  const cardHeight = showAlternative ? 170 : 142;
  const centerX = pitch.x + (Number(slot.x) / 100) * pitch.width;
  const centerY = pitch.y + (Number(slot.y) / 100) * pitch.height;
  const x = Math.max(
    pitch.x + 8,
    Math.min(centerX - cardWidth / 2, pitch.x + pitch.width - cardWidth - 8),
  );
  const y = Math.max(
    pitch.y + 8,
    Math.min(centerY - cardHeight / 2, pitch.y + pitch.height - cardHeight - 8),
  );
  const positionColor = MANTRA_POS_COLOR[slot.accepted?.[0]] || "#737373";

  ctx.save();
  ctx.fillStyle = player ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0.16)";
  ctx.strokeStyle = positionColor;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(x, y, cardWidth, cardHeight, 18);
  ctx.fill();
  if (!player) ctx.setLineDash([10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = positionColor;
  ctx.beginPath();
  ctx.roundRect(x + 10, y + 9, 54, 27, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "800 17px Manrope, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(slot.label, x + 37, y + 28, 48);

  if (!player) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "800 20px Manrope, sans-serif";
    ctx.fillText("+ игрок", x + cardWidth / 2, y + 87);
    if (showAlternative) {
      drawBuilderExportAlternative(ctx, alternative, images, x, y, cardWidth);
    }
    ctx.restore();
    return;
  }

  const avatar = images.get(player.avatarPath);
  const avatarX = x + cardWidth / 2 - 34;
  const avatarY = y + 10;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + cardWidth / 2, y + 48, 34, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    drawBuilderExportCover(ctx, avatar, avatarX, avatarY, 68, 68);
  } else {
    ctx.fillStyle = "#dce3e8";
    ctx.fillRect(avatarX, avatarY, 68, 68);
    ctx.fillStyle = "#334155";
    ctx.font = "900 23px Manrope, sans-serif";
    ctx.fillText(
      builderInitials(player.fullName || player.name),
      x + cardWidth / 2,
      y + 56,
    );
  }
  ctx.restore();

  const club = images.get(player.clubLogo);
  if (club) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x + cardWidth - 30, y + 32, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(club, x + cardWidth - 45, y + 17, 30, 30);
  }

  const name = player.fullName || player.name;
  ctx.fillStyle = "#111827";
  ctx.font = "900 19px Manrope, sans-serif";
  ctx.fillText(name, x + cardWidth / 2, y + 103, cardWidth - 18);
  ctx.fillStyle = "#64748b";
  ctx.font = "700 14px Manrope, sans-serif";
  ctx.fillText(
    (player.positions || []).join("/"),
    x + cardWidth / 2,
    y + 126,
    cardWidth - 18,
  );
  if (showAlternative) {
    drawBuilderExportAlternative(ctx, alternative, images, x, y, cardWidth);
  }
  ctx.restore();
}

async function downloadBuilderPng() {
  const formation = currentBuilderFormation();
  if (!builderTeamView || !formation || !builderAssignments.size) return;
  const button = document.getElementById("builder-download");
  const meta = document.getElementById("builder-meta");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "Подготовка…";
  meta.textContent = "Готовим изображение состава…";

  try {
    const team = builderTeamView.team;
    const players = formation.slots
      .map((slot) => builderPlayerById(builderAssignments.get(slot.index)))
      .filter(Boolean);
    const showAlternatives = document.getElementById("builder-show-alternatives").checked;
    const alternatives = showAlternatives
      ? formation.slots
          .map((slot) => builderPlayerById(builderAlternatives.get(slot.index)))
          .filter(Boolean)
      : [];
    const urls = [
      "/mantrafootball-logo.svg",
      team.logoPath,
      ...players.flatMap((player) => [player.avatarPath, player.clubLogo]),
      ...alternatives.map((player) => player.clubLogo),
    ].filter(Boolean);
    const uniqueUrls = [...new Set(urls)];
    const loaded = await Promise.all(
      uniqueUrls.map(async (url) => [
        url,
        await loadBuilderExportImage(builderExportImageSrc(url)),
      ]),
    );
    const images = new Map(loaded);

    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1500;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f1f4f7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.font = "900 48px Manrope, sans-serif";
    ctx.fillText(team.name, 60, 76, 860);
    ctx.fillStyle = "#64748b";
    ctx.font = "700 24px Manrope, sans-serif";
    ctx.fillText(
      `${team.leagueName || "Mantra"} · ${formation.formation}`,
      60,
      116,
      860,
    );
    const teamLogo = images.get(team.logoPath);
    if (teamLogo) ctx.drawImage(teamLogo, 1030, 34, 100, 100);

    const pitch = { x: 55, y: 160, width: 1090, height: 1280 };
    drawBuilderExportPitch(ctx, pitch);
    for (const slot of formation.slots) {
      const playerId = builderAssignments.get(slot.index);
      const alternativeId = builderAlternatives.get(slot.index);
      drawBuilderExportSlot(
        ctx,
        slot,
        playerId != null ? builderPlayerById(playerId) : null,
        alternativeId != null ? builderPlayerById(alternativeId) : null,
        showAlternatives,
        images,
        pitch,
      );
    }

    const mantraLogo = images.get("/mantrafootball-logo.svg");
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.roundRect(72, 1360, 300, 60, 12);
    ctx.fill();
    if (mantraLogo) ctx.drawImage(mantraLogo, 84, 1368, 48, 43);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.font = "900 23px Manrope, sans-serif";
    ctx.fillText("MANTRAFOOTBALL", 145, 1398);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Не удалось создать PNG");
    const fileName = `${team.name}-${formation.formation}`
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName || "mantra-squad"}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    meta.textContent = `${formation.formation} · выбрано ${builderAssignments.size}/11 · PNG скачан`;
  } catch (error) {
    meta.textContent = `Ошибка экспорта: ${error.message}`;
  } finally {
    button.textContent = oldText;
    renderBuilderSaveControls();
  }
}

function renderXiTeams() {
  const el = document.getElementById("xi-teams");
  el.innerHTML = "";
  const ratings = xiTeams.map((t) => t.avgRating).filter((r) => r != null && Number.isFinite(r));
  const xiMin = ratings.length ? Math.min(...ratings) : 40;
  for (const team of xiTeams) {
    xiTeamById.set(team.id, team);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-chip";
    btn.dataset.teamId = String(team.id);
    const rating = team.avgRating;
    let badge = "";
    if (rating != null && Number.isFinite(rating)) {
      const { bg, fg } = ratingBadgeColor(Math.round(rating), xiMin);
      badge = `<span class="team-chip-rating" style="background:${bg};color:${fg}">${Number(rating).toFixed(1)}</span>`;
    }
    btn.innerHTML = `<img src="${team.logo || ""}" alt="" loading="lazy" /><span class="team-chip-name">${team.name}</span>${badge}`;
    btn.title =
      rating != null ? `${team.name} · ср. рейтинг XI ${Number(rating).toFixed(1)}` : team.name;
    btn.addEventListener("click", () => selectXiTeam(team.id));
    el.appendChild(btn);
  }
}

function xiTag(status, slot) {
  if (status === "starter") return `<span class="tag tag-starter">XI ${slot || ""}</span>`;
  if (status === "backup") return `<span class="tag tag-backup">Backup ${slot || ""}</span>`;
  return `<span class="tag tag-squad">Состав</span>`;
}

function newBadge(p) {
  if (!p?.isNew) return "";
  const title = p.joinedAt ? `Новый трансфер · ${p.joinedAt}` : "Новый трансфер";
  return `<span class="tag tag-new" title="${title}">new</span>`;
}

function takenBadge(owner) {
  if (!owner) return "";
  return `<span class="tag tag-taken" title="${esc(`Куплен: ${owner}`)}">${esc(owner)}</span>`;
}

function liveDraftOwnerForName(playerName, teamId) {
  if (!playerName || !boardPlayers?.length) return null;
  const tid = teamId != null && teamId !== "" ? String(teamId) : "";
  const club = tid
    ? boardPlayers.filter((p) => String(p.teamId) === tid)
    : boardPlayers;
  const names = club.map((p) => p.name).filter(Boolean);
  const opts = names.length ? { clubNames: names } : undefined;
  for (const p of club) {
    if (!p.mantra?.ownedBy) continue;
    if (namesMatchUi(p.name, playerName, opts)) return p.mantra.ownedBy;
  }
  return null;
}

function updateMantraFilterVisibility() {
  // Show wraps whenever this AF league has a Mantra tournament — options may
  // still be loading from the light fantasy-teams prefetch.
  const show = mantraAvailable;
  document.getElementById("roster-mantra-wrap").hidden = !show;
  document.getElementById("roster-free-wrap").hidden = !show;
  const note = document.getElementById("roster-mantra-note");
  if (!mantraAvailable) {
    note.hidden = false;
    note.textContent =
      "Mantra-лиги для этой страны ещё не подключены (лимит mantrafootball: ≤4 req/s). Фильтры Mantra скрыты.";
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

function fillRosterMantraFilters() {
  const mantraSel = document.getElementById("roster-mantra");
  const freeSel = document.getElementById("roster-free");
  const posSet = new Set();
  for (const p of boardPlayers) {
    for (const pos of p.mantra?.positions || []) if (pos) posSet.add(pos);
  }
  const positions = [...posSet].sort((a, b) => a.localeCompare(b));
  mantraSel.innerHTML =
    `<option value="">Все</option>` + positions.map((pos) => `<option value="${pos}">${pos}</option>`).join("");
  freeSel.innerHTML =
    `<option value="">Все</option>` +
    mantraLeagues.map((l) => `<option value="${l.id}">${l.label}</option>`).join("");
}

function setupRosterClubFilter(teams) {
  const club = document.getElementById("roster-club");
  const prev = club.value;
  club.innerHTML =
    `<option value="">Все</option>` +
    teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  if (prev && [...club.options].some((o) => o.value === prev)) club.value = prev;
  if (!rosterFiltersBound) {
    rosterFiltersBound = true;
    for (const id of [
      "roster-club",
      "roster-pos",
      "roster-mantra",
      "roster-free",
      "roster-xi",
      "roster-sort",
      "roster-q",
    ]) {
      document.getElementById(id).addEventListener("input", renderRosterTable);
      document.getElementById(id).addEventListener("change", renderRosterTable);
    }
    const expert50 = document.getElementById("roster-expert-50");
    if (expert50) {
      expert50.addEventListener("click", () => {
        const on = expert50.getAttribute("aria-pressed") !== "true";
        expert50.setAttribute("aria-pressed", on ? "true" : "false");
        renderRosterTable();
      });
    }
  }
}

function championshipExpected11Enabled() {
  return Number(currentXiLeague()?.afLeagueId) === 40;
}

function serieALineupEnabled() {
  return Number(currentXiLeague()?.afLeagueId) === 135;
}

function formatSerieASourcePct(prediction) {
  if (!prediction) return "—";
  if (prediction.displayedPercentage != null) {
    return `${Number(prediction.displayedPercentage)}%`;
  }
  if (prediction.lineupGroup === "starting") return tr("XI");
  if (prediction.lineupGroup === "bench") return tr("alt");
  return "—";
}

function serieASourceTitle(label, prediction) {
  if (!prediction) {
    return `${label}: ${tr("данных нет — отсутствие данных нейтрально")}`;
  }
  const pct =
    prediction.displayedPercentage != null
      ? `${Number(prediction.displayedPercentage)}%`
      : tr("без %");
  return [label, prediction.sourceName, prediction.lineupGroup, pct, prediction.rawLabel]
    .filter(Boolean)
    .join(" · ");
}

function serieALineupSignal(player) {
  const prediction = player?.serieALineup;
  if (!prediction) return null;
  return `FC ${formatSerieASourcePct(prediction.fantacalcio)} · SI ${formatSerieASourcePct(prediction.sorareInside)}`;
}

function currentExpected11(player) {
  const prediction = player?.expected11;
  return prediction && prediction.freshness !== "stale" ? prediction : null;
}

function expected11PercentageText(prediction) {
  if (prediction?.displayedPercentage == null) return "—";
  return `${Number(prediction.displayedPercentage)}%`;
}

function expected11StatusText(prediction) {
  if (!prediction) return "—";
  const status = String(prediction.lineupGroup || "").toUpperCase() || "—";
  if (prediction.freshness === "stale") return `${status} · ${tr("устарело")}`;
  if (status === "OUT") return "OUT · —";
  return `${status} · ${expected11PercentageText(prediction)}`;
}

function expected11Title(prediction) {
  if (!prediction) {
    return tr("Expected11: данных нет — отсутствие данных нейтрально");
  }
  const time =
    prediction.freshness === "stale"
      ? tr("устарело — не влияет на выбор XI")
      : prediction.kickoffKnown
        ? formatDate(prediction.kickoff)
        : tr("время неизвестно");
  const influence =
    prediction.outFallback
      ? tr("OUT использован только для заполнения валидной схемы")
      : prediction.influenceReason === "out_exclusion"
        ? tr("OUT исключён из выбора, пока схема заполняется без игрока")
        : prediction.influenceReason === "starter_probability"
          ? tr("вероятность использована вместо официального Sorare-сигнала")
          : tr("не влияет на выбор XI");
  return [
    `Expected11: ${expected11StatusText(prediction)}`,
    [prediction.sourceClub, prediction.opponent ? `vs ${prediction.opponent}` : null]
      .filter(Boolean)
      .join(" "),
    time,
    prediction.updatedAt ? `${tr("Обновлено")}: ${formatDate(prediction.updatedAt)}` : null,
    influence,
  ]
    .filter(Boolean)
    .join("\n");
}

function expected11RosterCell(player) {
  const prediction = player.expected11;
  if (!prediction) {
    return `<span class="expected11-status expected11-missing" title="${esc(expected11Title(null))}">—</span>`;
  }
  const current = currentExpected11(player);
  const statusClass =
    prediction.freshness === "stale"
      ? "expected11-stale"
      : prediction.lineupGroup === "out"
        ? "expected11-out"
        : "";
  const source = prediction.sourceMatchUrl
    ? `<a class="expected11-source-link" href="${esc(prediction.sourceMatchUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Источник Expected11: ${esc(prediction.sourceMatchTitle)}">↗</a>`
    : "";
  const status = prediction.expected11PlayerUrl
    ? `<a class="expected11-status" href="${esc(prediction.expected11PlayerUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Профиль Expected11: ${esc(expected11StatusText(prediction))}">${esc(expected11StatusText(prediction))}</a>`
    : `<span class="expected11-status">${esc(expected11StatusText(prediction))}</span>`;
  return `<span class="expected11-xi-cell ${statusClass}" title="${esc(expected11Title(prediction))}">
    ${status}
    <span class="expected11-source-detail">${esc(prediction.opponent || prediction.sourceMatchTitle || "")}</span>
    ${source}
    ${current?.outFallback ? `<span class="tag tag-backup">fallback</span>` : ""}
  </span>`;
}

function filteredBoard() {
  const club = document.getElementById("roster-club").value;
  const pos = document.getElementById("roster-pos").value;
  const mantraPos = document.getElementById("roster-mantra").value;
  const freeLeague = document.getElementById("roster-free").value;
  const xi = document.getElementById("roster-xi").value;
  const sort = document.getElementById("roster-sort").value;
  const q = document.getElementById("roster-q").value.trim().toLowerCase();
  const expert50 = isExpert50FilterOn();

  let rows = boardPlayers.slice();
  if (club) rows = rows.filter((p) => String(p.teamId) === club);
  if (xi) rows = rows.filter((p) => p.xiStatus === xi);
  if (pos) {
    rows = rows.filter((p) => {
      if (["GK", "DEF", "MID", "ATT"].includes(pos)) return p.group === pos;
      return p.role === pos;
    });
  }
  if (mantraPos) {
    rows = rows.filter((p) => (p.mantra?.positions || []).includes(mantraPos));
  }
  if (freeLeague) {
    const leagueId = Number(freeLeague);
    rows = rows.filter((p) => {
      if (!p.mantra) return false;
      return !(p.mantra.takenLeagueIds || []).includes(leagueId);
    });
  }
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
  if (expert50) {
    rows = rows.filter((p) => {
      const pct = expertPctForBoardPlayer(p);
      return pct != null && pct >= 50;
    });
  }

  rows.sort((a, b) => {
    if (sort === "expected11-desc") {
      const av = currentExpected11(a);
      const bv = currentExpected11(b);
      const aValue =
        av?.displayedPercentage != null
          ? Number(av.displayedPercentage)
          : av?.lineupGroup === "out"
            ? -1
            : null;
      const bValue =
        bv?.displayedPercentage != null
          ? Number(bv.displayedPercentage)
          : bv?.lineupGroup === "out"
            ? -1
            : null;
      if (aValue == null && bValue != null) return 1;
      if (aValue != null && bValue == null) return -1;
      if (aValue != null && bValue != null && bValue !== aValue) return bValue - aValue;
      return b.rating - a.rating || a.playerId - b.playerId;
    }
    if (sort === "rating-asc") return a.rating - b.rating;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "value-desc") return (b.marketValueEur || 0) - (a.marketValueEur || 0);
    return b.rating - a.rating;
  });
  return rows;
}

function renderRosterTable() {
  const body = document.getElementById("roster-body");
  const head =
    document.querySelector("#roster-head tr") ||
    document.querySelector(".roster-table thead tr");
  const cols = expertColumnFlags();
  const showExpected11 = championshipExpected11Enabled();
  const showSerieALineup = serieALineupEnabled();
  const sortSelect = document.getElementById("roster-sort");
  const expectedSort = sortSelect?.querySelector('option[value="expected11-desc"]');
  if (showExpected11 && !expectedSort) {
    sortSelect?.insertAdjacentHTML(
      "beforeend",
      `<option value="expected11-desc">Expected11 ↓</option>`,
    );
  } else if (!showExpected11 && expectedSort) {
    if (sortSelect.value === "expected11-desc") sortSelect.value = "rating-desc";
    expectedSort.remove();
  }
  const expertHeads = [
    cols.sorare
      ? `<th title="Вероятность основы · SorareInside">Sorare</th>`
      : "",
    cols.athletic
      ? `<th title="The Athletic · в основе">Athletic</th>`
      : "",
    cols.ffs
      ? `<th title="Fantasy Football Scout · в основе">FFS</th>`
      : "",
  ].join("");
  const legacyPct =
    !cols.sorare && !cols.athletic && !cols.ffs
      ? `<th title="Вероятность основы по мнению экспертов">Эксп.%</th>`
      : "";
  if (head) {
    head.innerHTML = `<th>Игрок</th><th>Клуб</th><th>Основная роль</th><th>Доп. роли</th><th>Mantra</th><th>Состав</th>${showExpected11 ? `<th title="Expected11: вероятность старта; отсутствие данных нейтрально; OUT исключается, если валидная схема заполняется без игрока">Expected11</th>` : ""}${showSerieALineup ? `<th class="lineup-pct" title="${esc(tr("Fantacalcio: вероятность старта по вероятной основе; нет числа — XI/alt; отсутствие данных нейтрально"))}">${esc(tr("Fantacalcio %"))}</th><th class="lineup-pct" title="${esc(tr("SorareInside: вероятность старта по профилю клуба; отсутствие данных нейтрально"))}">${esc(tr("SorareInside %"))}</th>` : ""}${expertHeads}${legacyPct}<th>Рейтинг</th><th>€</th>`;
  }
  const colCount =
    8 +
    (showExpected11 ? 1 : 0) +
    (showSerieALineup ? 2 : 0) +
    (cols.sorare ? 1 : 0) +
    (cols.athletic ? 1 : 0) +
    (cols.ffs ? 1 : 0) +
    (legacyPct ? 1 : 0);
  if (!boardPlayers.length) {
    body.innerHTML = `<tr><td colspan="${colCount}">Нет игроков</td></tr>`;
    return;
  }
  const rows = filteredBoard();
  if (!rows.length) {
    const msg = isExpert50FilterOn()
      ? "Нет игроков с экспертной вероятностью ≥ 50%"
      : "Нет игроков";
    body.innerHTML = `<tr><td colspan="${colCount}">${msg}</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((p) => {
      const rating = Math.round(p.rating);
      const { bg, fg } = ratingBadgeColor(rating, boardMinRating);
      const mantraPos = (p.mantra?.positions || [])
        .map((x) => `<span class="tag tag-pos">${x}</span>`)
        .join("");
      const mainRole = p.roleLabel || p.role || "—";
      const extraRoles = p.sideRole
        ? String(p.sideRole)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((x) => `<span class="tag tag-pos">${x}</span>`)
            .join("")
        : "—";
      const expertCells = [];
      if (cols.sorare) {
        expertCells.push(
          `<td class="mono">${formatExpertPct(expertPctForBoardPlayer(p))}</td>`,
        );
      }
      if (cols.athletic) {
        const yn = expertYnForBoardPlayer(p, "athletic");
        expertCells.push(
          `<td class="mono expert-yn">${yn == null ? "—" : formatExpertYn(yn)}</td>`,
        );
      }
      if (cols.ffs) {
        const yn = expertYnForBoardPlayer(p, "ffs");
        expertCells.push(
          `<td class="mono expert-yn">${yn == null ? "—" : formatExpertYn(yn)}</td>`,
        );
      }
      if (legacyPct) {
        expertCells.push(
          `<td class="mono">${formatExpertPct(expertPctForBoardPlayer(p))}</td>`,
        );
      }
      return `<tr>
        <td>${p.name}${newBadge(p)}${takenBadge(p.mantra?.ownedBy)}</td>
        <td>${p.teamName}</td>
        <td>${mainRole}</td>
        <td>${extraRoles}</td>
        <td>${mantraPos || (mantraAvailable ? "—" : "n/a")}</td>
        <td>${xiTag(p.xiStatus, p.xiSlot)}</td>
        ${showExpected11 ? `<td class="expected11-roster">${expected11RosterCell(p)}</td>` : ""}
        ${showSerieALineup ? `<td class="mono lineup-pct" title="${esc(serieASourceTitle(tr("Fantacalcio %"), p.serieALineup?.fantacalcio))}">${esc(formatSerieASourcePct(p.serieALineup?.fantacalcio))}</td><td class="mono lineup-pct" title="${esc(serieASourceTitle(tr("SorareInside %"), p.serieALineup?.sorareInside))}">${esc(formatSerieASourcePct(p.serieALineup?.sorareInside))}</td>` : ""}
        ${expertCells.join("")}
        <td><span class="rating-pill" style="background:${bg};color:${fg}">${rating}</span></td>
        <td>${formatMoney(p.marketValueEur)}</td>
      </tr>`;
    })
    .join("");
}

function setXiSelectedChip(teamId) {
  for (const btn of document.querySelectorAll("#xi-teams .team-chip")) {
    btn.setAttribute("aria-selected", btn.dataset.teamId === String(teamId) ? "true" : "false");
  }
}

function slotsAvgRating(pred) {
  const slots = normalizeXiSlots(pred);
  if (!slots.length) return null;
  const sum = slots.reduce((a, s) => a + (Number(s.starter?.score) || 0), 0);
  return Number((sum / slots.length).toFixed(1));
}

/** Pitch coords keyed by slot label — mirrors src/lib/roles.ts FORMATIONS. */
const FORMATION_COORDS = {
  "4-2-3-1": {
    ST: { x: 50, y: 12 },
    LW: { x: 18, y: 30 },
    LAM: { x: 18, y: 30 },
    AM: { x: 50, y: 28 },
    CAM: { x: 50, y: 28 },
    RW: { x: 82, y: 30 },
    RAM: { x: 82, y: 30 },
    LDM: { x: 34, y: 52 },
    RDM: { x: 66, y: 52 },
    LCM: { x: 34, y: 52 },
    RCM: { x: 66, y: 52 },
    CDM: { x: 50, y: 52 },
    DM: { x: 50, y: 52 },
    LB: { x: 14, y: 72 },
    LCB: { x: 36, y: 74 },
    RCB: { x: 64, y: 74 },
    RB: { x: 86, y: 72 },
    GK: { x: 50, y: 90 },
  },
  "4-3-3": {
    ST: { x: 50, y: 12 },
    LW: { x: 18, y: 22 },
    RW: { x: 82, y: 22 },
    LCM: { x: 28, y: 46 },
    CM: { x: 50, y: 50 },
    RCM: { x: 72, y: 46 },
    LB: { x: 14, y: 72 },
    LCB: { x: 36, y: 74 },
    RCB: { x: 64, y: 74 },
    RB: { x: 86, y: 72 },
    GK: { x: 50, y: 90 },
  },
  "4-4-2": {
    LST: { x: 38, y: 14 },
    RST: { x: 62, y: 14 },
    ST: { x: 50, y: 14 },
    LM: { x: 14, y: 40 },
    LCM: { x: 36, y: 44 },
    RCM: { x: 64, y: 44 },
    RM: { x: 86, y: 40 },
    LB: { x: 14, y: 72 },
    LCB: { x: 36, y: 74 },
    RCB: { x: 64, y: 74 },
    RB: { x: 86, y: 72 },
    GK: { x: 50, y: 90 },
  },
  "4-2-2-2": {
    LST: { x: 38, y: 12 },
    RST: { x: 62, y: 12 },
    LAM: { x: 28, y: 32 },
    RAM: { x: 72, y: 32 },
    LDM: { x: 34, y: 52 },
    RDM: { x: 66, y: 52 },
    LB: { x: 14, y: 72 },
    LCB: { x: 36, y: 74 },
    RCB: { x: 64, y: 74 },
    RB: { x: 86, y: 72 },
    GK: { x: 50, y: 90 },
  },
  "3-5-2": {
    LST: { x: 38, y: 14 },
    RST: { x: 62, y: 14 },
    LWB: { x: 12, y: 42 },
    LCM: { x: 32, y: 46 },
    CM: { x: 50, y: 50 },
    DM: { x: 50, y: 50 },
    RCM: { x: 68, y: 46 },
    RWB: { x: 88, y: 42 },
    LCB: { x: 28, y: 74 },
    CB: { x: 50, y: 76 },
    RCB: { x: 72, y: 74 },
    GK: { x: 50, y: 90 },
  },
  "3-4-1-2": {
    LST: { x: 38, y: 12 },
    RST: { x: 62, y: 12 },
    AM: { x: 50, y: 28 },
    CAM: { x: 50, y: 28 },
    LWB: { x: 14, y: 46 },
    LM: { x: 14, y: 46 },
    LCM: { x: 38, y: 50 },
    RCM: { x: 62, y: 50 },
    RWB: { x: 86, y: 46 },
    RM: { x: 86, y: 46 },
    LCB: { x: 28, y: 74 },
    CB: { x: 50, y: 76 },
    RCB: { x: 72, y: 74 },
    GK: { x: 50, y: 90 },
  },
  "3-4-3": {
    LW: { x: 18, y: 16 },
    ST: { x: 50, y: 12 },
    RW: { x: 82, y: 16 },
    LM: { x: 16, y: 44 },
    LCM: { x: 38, y: 48 },
    CM: { x: 38, y: 48 },
    RCM: { x: 62, y: 48 },
    RM: { x: 84, y: 44 },
    LCB: { x: 28, y: 74 },
    CB: { x: 50, y: 76 },
    RCB: { x: 72, y: 74 },
    GK: { x: 50, y: 90 },
  },
  "3-4-2-1": {
    ST: { x: 50, y: 12 },
    LAM: { x: 32, y: 28 },
    RAM: { x: 68, y: 28 },
    AM: { x: 50, y: 28 },
    LWB: { x: 14, y: 46 },
    LM: { x: 14, y: 46 },
    LCM: { x: 38, y: 50 },
    RCM: { x: 62, y: 50 },
    RWB: { x: 86, y: 46 },
    RM: { x: 86, y: 46 },
    LCB: { x: 28, y: 74 },
    CB: { x: 50, y: 76 },
    RCB: { x: 72, y: 74 },
    GK: { x: 50, y: 90 },
  },
  "4-3-1-2": {
    LST: { x: 38, y: 12 },
    RST: { x: 62, y: 12 },
    CAM: { x: 50, y: 28 },
    AM: { x: 50, y: 28 },
    LCM: { x: 28, y: 50 },
    CM: { x: 50, y: 52 },
    RCM: { x: 72, y: 50 },
    LB: { x: 14, y: 72 },
    LCB: { x: 36, y: 74 },
    RCB: { x: 64, y: 74 },
    RB: { x: 86, y: 72 },
    GK: { x: 50, y: 90 },
  },
};

/** @type {any|null} */
let expertXiCatalog = null;
/** @type {Promise<any>|null} */
let expertXiLoad = null;

async function loadExpertXiCatalog() {
  if (expertXiCatalog) return expertXiCatalog;
  if (!expertXiLoad) {
    expertXiLoad = fetch("/expert-xi.json?v=94")
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .catch(() => ({ teams: [] }))
      .then((data) => {
        expertXiCatalog = data;
        return data;
      });
  }
  return expertXiLoad;
}

async function mergeDynamicSorareExpert(catalog, leagueId, teamId, teamName) {
  if (![39, 40, 203].includes(Number(leagueId)) || !Number.isFinite(Number(teamId))) {
    return catalog;
  }
  try {
    const res = await fetch(`/api/sorare/by-af/${leagueId}/${teamId}`);
    if (!res.ok) return catalog;
    const view = await res.json();
    if (!Array.isArray(view.expectedXi) || !view.expectedXi.length) return catalog;
    const slotQueues = {
      Goalkeeper: ["GK"],
      Defender: ["LB", "LCB", "RCB", "RB"],
      Midfielder: ["LCM", "CM", "RCM"],
      Forward: ["LW", "ST", "RW"],
    };
    const xi = view.expectedXi.map((player, index) => ({
      slot: slotQueues[player.position]?.shift() || `P${index + 1}`,
      name: player.name,
      pct: Math.round(Number(player.starter || 0) * 100),
    }));
    let team = findExpertTeam(catalog, { id: teamId, name: teamName });
    if (!team) {
      team = { afTeamId: Number(teamId), name: teamName, hints: [teamName], experts: [] };
      catalog.teams = [...(catalog.teams || []), team];
    }
    const experts = expertSources(team).filter((expert) => expert.id !== "sorare");
    team.experts = [
      {
        id: "sorare",
        label: "SorareInside",
        kind: "pct",
        formation: "4-3-3",
        xi,
      },
      ...experts,
    ];
    return catalog;
  } catch {
    return catalog;
  }
}

/** Normalize team entry: prefer experts[]; legacy xi+sourceLabel → one expert. */
function expertSources(team) {
  if (!team) return [];
  if (Array.isArray(team.experts) && team.experts.length) return team.experts;
  if (team.xi?.length) {
    const label = team.sourceLabel || "Эксперты";
    const id = /athletic/i.test(label)
      ? "athletic"
      : /sorare/i.test(label)
        ? "sorare"
        : /scout|ffs/i.test(label)
          ? "ffs"
          : "expert";
    const kind = id === "sorare" || /sorare/i.test(label) ? "pct" : "yn";
    return [{ id, label, kind, formation: team.formation, xi: team.xi }];
  }
  return [];
}

function expertById(team, id) {
  return expertSources(team).find((e) => e.id === id) || null;
}

/** True if player is listed as a starter (not alt) in this expert XI. */
function expertListsStarter(expert, playerName, clubNames) {
  if (!playerName || !expert?.xi?.length) return false;
  const opts = clubNames?.length ? { clubNames } : undefined;
  for (const slot of expert.xi) {
    if (expertNameCandidates(slot).some((c) => namesMatchUi(c, playerName, opts))) return true;
  }
  return false;
}

/**
 * Consensus vs available experts for a club.
 * red (full): unanimous among present experts when n ≥ 2
 * orange (majority): agree ≥ 2 but not unanimous (e.g. 2/3)
 * weak / legacy is-overlap: single-expert match (Champ/SL Sorare)
 */
function consensusLevel(agree, nExperts) {
  if (nExperts <= 0 || agree <= 0) return null;
  if (nExperts === 1) return "single";
  if (agree === nExperts) return "full";
  if (agree >= 2) return "majority";
  return "weak";
}

function consensusClassName(level) {
  if (level === "full") return "is-overlap-full";
  if (level === "majority") return "is-overlap-majority";
  if (level === "weak") return "is-overlap-weak";
  if (level === "single") return "is-overlap";
  return "";
}

function clearOverlapClasses(el) {
  el.classList.remove(
    "is-overlap",
    "is-overlap-full",
    "is-overlap-majority",
    "is-overlap-weak",
  );
}

/** Which expert column kinds exist for current roster scope (club filter or all). */
function expertColumnFlags() {
  const flags = { sorare: false, athletic: false, ffs: false };
  if (!expertXiCatalog) return flags;
  const club = document.getElementById("roster-club")?.value || "";
  const teamIds = new Set();
  for (const p of boardPlayers) {
    if (club && String(p.teamId) !== club) continue;
    teamIds.add(Number(p.teamId));
  }
  for (const id of teamIds) {
    const team = findExpertTeam(expertXiCatalog, { id });
    for (const e of expertSources(team)) {
      if (e.id === "sorare" || e.kind === "pct") flags.sorare = true;
      if (e.id === "athletic") flags.athletic = true;
      if (e.id === "ffs") flags.ffs = true;
    }
  }
  return flags;
}

function formatExpertYn(inXi) {
  return inXi ? "✓" : "—";
}

/** Collect name candidates for an expert alt (string or {name, aliases}). */
function expertAltNameCandidates(alt) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (alt == null) return out;
  if (typeof alt === "string") {
    add(alt);
    return out;
  }
  add(alt.name);
  for (const a of alt.aliases || []) add(a);
  return out;
}

/**
 * Expert start % from one expert source (pct kind / legacy xi).
 * Starter `pct` or alt `altPct` / nested alt.pct; max if several slots.
 * @returns {number|null}
 */
function resolveExpertPctFromXi(playerName, xi, clubNames) {
  if (!playerName || !xi?.length) return null;
  const opts = clubNames?.length ? { clubNames } : undefined;
  let max = null;
  for (const slot of xi) {
    if (slot.pct != null && expertNameCandidates(slot).some((c) => namesMatchUi(c, playerName, opts))) {
      const n = Number(slot.pct);
      if (Number.isFinite(n)) max = max == null ? n : Math.max(max, n);
    }
    const altPct =
      slot.altPct != null
        ? Number(slot.altPct)
        : typeof slot.alt === "object" && slot.alt?.pct != null
          ? Number(slot.alt.pct)
          : null;
    if (altPct != null && Number.isFinite(altPct)) {
      const alts = expertAltNameCandidates(slot.alt);
      if (alts.some((c) => namesMatchUi(c, playerName, opts))) {
        max = max == null ? altPct : Math.max(max, altPct);
      }
    }
  }
  return max;
}

/**
 * Sorare-style % (or max across pct experts). YN-only clubs: 100 if in any yn XI.
 * Used by Эксп.% / 50%+ when a pct column isn't shown separately.
 */
function resolveExpertPct(playerName, expertTeam, clubNames) {
  const sources = expertSources(expertTeam);
  if (!playerName || !sources.length) return null;
  let max = null;
  const pctSources = sources.filter((e) => e.kind === "pct" || e.id === "sorare");
  const pool = pctSources.length ? pctSources : sources;
  for (const ex of pool) {
    const n = resolveExpertPctFromXi(playerName, ex.xi, clubNames);
    if (n != null) max = max == null ? n : Math.max(max, n);
  }
  return max;
}

function boardClubNames(teamId) {
  const id = Number(teamId);
  if (!Number.isFinite(id) || !boardPlayers?.length) return [];
  return boardPlayers.filter((p) => Number(p.teamId) === id).map((p) => p.name).filter(Boolean);
}

function expertPctForBoardPlayer(p) {
  if (!expertXiCatalog || !p) return null;
  const team = findExpertTeam(expertXiCatalog, { id: p.teamId, name: p.teamName });
  const clubNames = boardClubNames(p.teamId);
  const sorare = expertById(team, "sorare");
  if (sorare) return resolveExpertPctFromXi(p.name, sorare.xi, clubNames);
  return resolveExpertPct(p.name, team, clubNames);
}

function expertYnForBoardPlayer(p, expertId) {
  if (!expertXiCatalog || !p) return null;
  const team = findExpertTeam(expertXiCatalog, { id: p.teamId, name: p.teamName });
  const ex = expertById(team, expertId);
  if (!ex) return null;
  return expertListsStarter(ex, p.name, boardClubNames(p.teamId));
}

function formatExpertPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${Math.round(pct)}%`;
}

function isExpert50FilterOn() {
  const btn = document.getElementById("roster-expert-50");
  return btn?.getAttribute("aria-pressed") === "true";
}

const NAME_PARTICLES_UI = new Set([
  "de", "da", "do", "dos", "das", "van", "von", "der", "den", "la", "le", "el", "di", "del", "della", "af", "av",
]);
const DIMINUTIVE_OF_UI = (() => {
  const groups = [
    ["tom", "thomas", "tommy"],
    ["will", "william", "bill", "billy", "liam"],
    ["alex", "alexander", "alexandre", "alejandro"],
    ["seb", "sebastian", "sebastien"],
    ["ollie", "oliver"],
    ["nick", "nicholas", "nicolas", "nico"],
    ["mike", "michael", "mick", "mickey"],
    ["chris", "christopher"],
    ["dan", "daniel", "danny"],
    ["dave", "david", "dai"],
    ["jim", "james", "jamie", "jimmy"],
    ["joe", "joseph", "joey"],
    ["john", "johnny", "jon"],
    ["rob", "robert", "bob", "bobby", "robbie"],
    ["steve", "stephen", "steven"],
    ["matt", "matthew", "matty"],
    ["ben", "benjamin", "benny"],
    ["sam", "samuel", "sammy"],
    ["tony", "anthony"],
    ["andy", "andrew"],
    ["josh", "joshua"],
    ["max", "maxim", "maximilian"],
  ];
  const map = new Map();
  for (const g of groups) {
    const set = new Set(g);
    for (const n of g) map.set(n, set);
  }
  return map;
})();

function normNameUi(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .replace(/đ/gi, "d")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/&apos;/g, "")
    .replace(/&#0*39;/g, "")
    .replace(/(\w)['\u2019\u2018](\w)/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function givenTokenCompatibleUi(a, b) {
  if (a === b) return true;
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return true;
  const g = DIMINUTIVE_OF_UI.get(a);
  return !!(g && g.has(b));
}

function givenNamesCompatibleUi(a, b) {
  if (!a.length || !b.length) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length === longer.length) {
    return shorter.every((t, i) => givenTokenCompatibleUi(t, longer[i]));
  }
  if (shorter.every((t) => t.length === 1) && shorter.length <= longer.length) {
    return shorter.every((t, i) => longer[i].startsWith(t));
  }
  if (shorter.length === 1) return givenTokenCompatibleUi(shorter[0], longer[0]);
  return shorter.every((t, i) => givenTokenCompatibleUi(t, longer[i]));
}

function significantTokensUi(name) {
  return normNameUi(name)
    .split(" ")
    .filter((t) => t && !NAME_PARTICLES_UI.has(t));
}

/** Ordered whole-token subsequence (not raw substring — avoids Son⊂Johnson). */
function tokensContainUi(hay, needle) {
  if (!needle.length) return false;
  let i = 0;
  for (const t of hay) {
    if (t === needle[i]) {
      i++;
      if (i === needle.length) return true;
    }
  }
  return false;
}

/** True when ≤1 club player has `token` as last significant token. */
function surnameUniqueAsLastUi(token, clubNames) {
  if (!clubNames?.length) return true;
  const hits = new Set();
  for (const n of clubNames) {
    const sig = significantTokensUi(n);
    if ((sig[sig.length - 1] || null) === token) hits.add(normNameUi(n));
  }
  return hits.size <= 1;
}

/** True when ≤1 club player contains `token` as a significant token. */
function tokenUniqueInClubUi(token, clubNames) {
  if (!clubNames?.length) return true;
  const hits = new Set();
  for (const n of clubNames) {
    if (significantTokensUi(n).includes(token)) hits.add(normNameUi(n));
  }
  return hits.size <= 1;
}

/**
 * Expert/UI name match — surname-first within a club.
 * "Havertz" ↔ "Kai Havertz"; "Raya" ↔ "David Raya Martin"; "Gabriel" ↔ "Gabriel Magalhães".
 * Optional `opts.clubNames` (our XI / board roster) disambiguates shared surnames.
 */
function namesMatchUi(a, b, opts) {
  const na = normNameUi(a);
  const nb = normNameUi(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  const sigA = ta.filter((t) => !NAME_PARTICLES_UI.has(t));
  const sigB = tb.filter((t) => !NAME_PARTICLES_UI.has(t));
  const clubNames = opts?.clubNames;

  // Multi-token containment: "david raya" ⊂ "david raya martin"
  if (sigA.length >= 2 && tokensContainUi(sigB, sigA)) return true;
  if (sigB.length >= 2 && tokensContainUi(sigA, sigB)) return true;

  const lastA = sigA[sigA.length - 1] || ta[ta.length - 1];
  const lastB = sigB[sigB.length - 1] || tb[tb.length - 1];

  // Same last significant token ("Havertz" ↔ "Kai Havertz")
  if (lastA && lastB && lastA === lastB && lastA.length >= 4) {
    const givenA = sigA.slice(0, -1);
    const givenB = sigB.slice(0, -1);
    if (!givenA.length || !givenB.length) {
      return surnameUniqueAsLastUi(lastA, clubNames);
    }
    return givenNamesCompatibleUi(givenA, givenB);
  }

  // Single token vs fuller name: must appear in the other, and be unique in club.
  // Covers "Raya" ↔ "David Raya Martin" and "Gabriel" ↔ "Gabriel Magalhães".
  const softSingle = (single, other) => {
    if (single.length !== 1 || single[0].length < 4) return false;
    const tok = single[0];
    if (!other.includes(tok)) return false;
    if (other[other.length - 1] === tok) return surnameUniqueAsLastUi(tok, clubNames);
    return tokenUniqueInClubUi(tok, clubNames);
  };
  if (softSingle(sigA, sigB) || softSingle(sigB, sigA)) return true;

  return false;
}

function expertNameCandidates(slot) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(slot?.name);
  for (const a of slot?.aliases || []) add(a);
  return out;
}

function findExpertTeam(catalog, team) {
  if (!catalog?.teams?.length || !team) return null;
  const id = Number(team.id ?? team.teamId);
  if (Number.isFinite(id)) {
    const byAf = catalog.teams.find((t) => Number(t.afTeamId) === id);
    if (byAf) return byAf;
    const byTm = catalog.teams.find((t) => Number(t.tmClubId) === id);
    if (byTm) return byTm;
  }
  const name = team.name || "";
  return (
    catalog.teams.find(
      (t) =>
        namesMatchUi(t.name, name) ||
        (t.hints || []).some((h) => namesMatchUi(h, name) || normNameUi(name).includes(normNameUi(h))),
    ) || null
  );
}

/** Club roster names for surname uniqueness (our predicted XI only — not expert aliases). */
function clubNamesForExpertMatch(ourSlots, _expertTeam) {
  const out = [];
  for (const s of ourSlots || []) {
    const n = s?.starter?.name;
    if (n) out.push(n);
  }
  return out;
}

function overlapNameSet(ourSlots, expertXi, clubNames) {
  const matched = new Set();
  const opts = clubNames?.length ? { clubNames } : undefined;
  for (const slot of expertXi || []) {
    const cands = expertNameCandidates(slot);
    for (const ours of ourSlots) {
      const ourName = ours?.starter?.name;
      if (!ourName) continue;
      if (cands.some((c) => namesMatchUi(c, ourName, opts))) {
        matched.add(ourName);
        for (const c of cands) matched.add(c);
      }
    }
  }
  return matched;
}

function isNameInOverlap(name, overlap, clubNames) {
  if (!name || !overlap?.size) return false;
  if (overlap.has(name)) return true;
  const opts = clubNames?.length ? { clubNames } : undefined;
  for (const m of overlap) {
    if (namesMatchUi(name, m, opts)) return true;
  }
  return false;
}

function hideExpertXi() {
  const wrap = document.getElementById("xi-expert");
  if (wrap) wrap.hidden = true;
  const pitches = document.getElementById("xi-expert-pitches");
  if (pitches) pitches.innerHTML = "";
  const pitch = document.getElementById("xi-expert-pitch");
  if (pitch) pitch.innerHTML = "";
}

function renderOneExpertPitch(container, expert, ourSlots, clubNames) {
  const overlap = overlapNameSet(ourSlots, expert.xi, clubNames);
  const coords = FORMATION_COORDS[expert.formation] || FORMATION_COORDS["4-2-3-1"];
  const block = document.createElement("div");
  block.className = "xi-expert-block";
  const head = document.createElement("div");
  head.className = "xi-expert-block-head";
  let overlapCount = 0;
  const seenOurs = new Set();
  for (const s of ourSlots) {
    const n = s?.starter?.name;
    if (n && isNameInOverlap(n, overlap, clubNames) && !seenOurs.has(normNameUi(n))) {
      seenOurs.add(normNameUi(n));
      overlapCount++;
    }
  }
  head.innerHTML = `
    <h4 class="xi-expert-block-title">${esc(expert.label || expert.id || "Эксперт")}</h4>
    <p class="meta">${[expert.formation || null, `${overlapCount}/11 с нашим XI`].filter(Boolean).join(" · ")}</p>
  `;
  const pitch = document.createElement("div");
  pitch.className = "pitch pitch-expert";
  pitch.setAttribute("aria-label", `${expert.label || "Expert"} formation`);
  pitch.innerHTML = `<div class="formation-label">${expert.formation || "XI"}</div>`;
  const usedXy = new Set();
  (expert.xi || []).forEach((slot, i) => {
    const label = slot.slot || slot.label || "—";
    let xy = coords[label];
    if (!xy) {
      xy = { x: 12 + (i % 5) * 19, y: 18 + Math.floor(i / 5) * 22 };
    }
    const key = `${xy.x},${xy.y}`;
    if (usedXy.has(key)) {
      xy = { x: xy.x + 4, y: xy.y + 3 };
    }
    usedXy.add(`${xy.x},${xy.y}`);

    const matched = isNameInOverlap(slot.name, overlap, clubNames);
    const owner = liveDraftOwnerForName(slot.name, xiSelectedTeamId);
    const el = document.createElement("div");
    el.className = matched ? "player is-overlap" : "player";
    if (owner) el.classList.add("is-taken");
    el.style.left = `${xy.x}%`;
    el.style.top = `${xy.y}%`;
    const showPct = expert.kind === "pct" || expert.id === "sorare";
    const pct =
      showPct && slot.pct != null
        ? `<span class="pct">${Math.round(slot.pct)}%</span>`
        : "";
    const altName =
      typeof slot.alt === "object" ? slot.alt?.name : slot.alt;
    const alt =
      altName != null
        ? `<span class="alt">${esc(altName)}${
            slot.altPct != null ? ` ${Math.round(slot.altPct)}%` : ""
          }</span>`
        : "";
    el.innerHTML = `
      <span class="kit">${esc(label)}</span>
      <span class="name">${esc(slot.name)}${takenBadge(owner)}</span>
      ${pct}
      ${alt}
    `;
    el.title = [
      `Слот: ${label}`,
      showPct && slot.pct != null ? `Старт: ${slot.pct}%` : null,
      altName ? `Alt: ${altName}${slot.altPct != null ? ` ${slot.altPct}%` : ""}` : null,
      owner ? `Куплен: ${owner}` : null,
      matched ? "Совпадает с нашим XI" : null,
    ]
      .filter(Boolean)
      .join("\n");
    pitch.appendChild(el);
  });
  block.appendChild(head);
  block.appendChild(pitch);
  container.appendChild(block);
  return overlapCount;
}

function renderExpertXiPitch(expertTeam, ourSlots) {
  const wrap = document.getElementById("xi-expert");
  const titleEl = document.getElementById("xi-expert-title");
  const metaEl = document.getElementById("xi-expert-meta");
  let pitchesHost = document.getElementById("xi-expert-pitches");
  if (!wrap) return 0;

  const sources = expertSources(expertTeam).filter((e) => e?.xi?.length);
  if (!sources.length) {
    hideExpertXi();
    return 0;
  }

  if (!pitchesHost) {
    // Migrate old single-pitch markup if present
    const oldPitch = document.getElementById("xi-expert-pitch");
    pitchesHost = document.createElement("div");
    pitchesHost.id = "xi-expert-pitches";
    pitchesHost.className = "xi-expert-pitches";
    if (oldPitch) oldPitch.replaceWith(pitchesHost);
    else wrap.appendChild(pitchesHost);
  }

  pitchesHost.innerHTML = "";
  const labels = sources.map((e) => e.label || e.id).join(" · ");
  if (titleEl) titleEl.textContent = `Эксперты · ${labels}`;

  const clubNames = clubNamesForExpertMatch(ourSlots, expertTeam);
  let totalOverlapHint = 0;
  for (const ex of sources) {
    totalOverlapHint = Math.max(totalOverlapHint, renderOneExpertPitch(pitchesHost, ex, ourSlots, clubNames));
  }

  // Summary: how many of our XI have full / majority consensus
  let full = 0;
  let majority = 0;
  const seen = new Set();
  for (const s of ourSlots) {
    const n = s?.starter?.name;
    if (!n || seen.has(normNameUi(n))) continue;
    seen.add(normNameUi(n));
    let agree = 0;
    for (const ex of sources) {
      if (expertListsStarter(ex, n, clubNames)) agree++;
    }
    const level = consensusLevel(agree, sources.length);
    if (level === "full") full++;
    else if (level === "majority") majority++;
  }
  if (metaEl) {
    const bits = [
      sources.length > 1 ? `${sources.length} источника` : null,
      full ? `${full} единогласно` : null,
      majority ? `${majority} большинство` : null,
    ].filter(Boolean);
    metaEl.textContent = bits.join(" · ") || `${totalOverlapHint}/11 пересечений`;
  }

  wrap.hidden = false;
  return full + majority;
}

/** Apply consensus highlight classes on our predicted XI pitch. */
function applyOurXiConsensus(pitch, slots, expertTeam) {
  const sources = expertSources(expertTeam).filter((e) => e?.xi?.length);
  const clubNames = clubNamesForExpertMatch(slots, expertTeam);
  for (const el of pitch.querySelectorAll(".player")) {
    clearOverlapClasses(el);
    const name = el.dataset.name;
    if (!name || !sources.length) continue;
    let agree = 0;
    for (const ex of sources) {
      if (expertListsStarter(ex, name, clubNames)) agree++;
    }
    const level = consensusLevel(agree, sources.length);
    const cls = consensusClassName(level);
    if (cls) {
      el.classList.add(cls);
      const tip =
        sources.length <= 1
          ? "Совпадает с экспертом"
          : `Эксперты: ${agree}/${sources.length}`;
      el.title = [el.title, tip].filter(Boolean).join("\n");
    }
  }
}

function normalizeXiSlots(pred) {
  // predictSeasonXi: starter/backup + x/y; historical predictedXi: flat slots
  if (!pred?.xi?.length) return [];
  if (pred.xi[0].starter) return pred.xi;
  const n = pred.xi.length;
  return pred.xi.map((s, i) => ({
    label: s.slot || s.position,
    role: s.position,
    x: 12 + (i % 5) * 19,
    y: 18 + Math.floor(i / 5) * 22,
    starter: {
      name: s.playerName,
      score: Math.round((s.startShare || 0) * 100),
      marketValueEur: null,
      role: s.position,
      roleLabel: s.position,
    },
    backup: null,
  }));
}

function renderXiPrediction(team, pred) {
  const board = document.getElementById("xi-board");
  board.hidden = false;
  document.getElementById("xi-team-logo").src = team.logo || "";
  document.getElementById("xi-team-logo").alt = team.name;
  document.getElementById("xi-team-name").textContent = pred.teamName || team.name;
  document.getElementById("xi-team-meta").textContent = [
    pred.formation || "—",
    pred.formationReason || null,
    pred.method || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const pre = pred.preseason;
  const avg =
    pred.avgRating != null
      ? Number(pred.avgRating)
      : slotsAvgRating(pred);
  const stats = [
    avg != null ? ["avg XI", Number(avg).toFixed(1)] : null,
    ["confidence", formatPct(pred.confidence)],
    pre ? ["friendlies", String(pre.played ?? "—")] : null,
    pre ? ["W-D-L", `${pre.wins ?? 0}-${pre.draws ?? 0}-${pre.losses ?? 0}`] : null,
    pre ? ["goals", `${pre.gf ?? 0}:${pre.ga ?? 0}`] : null,
    pred.matchesSampled != null ? ["matches", String(pred.matchesSampled)] : null,
  ].filter(Boolean);
  document.getElementById("xi-stats").innerHTML = stats
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join("");

  const slots = normalizeXiSlots(pred);
  const pitch = document.getElementById("xi-pitch");
  pitch.innerHTML = `<div class="formation-label">${pred.formation || "XI"}</div>`;
  const ratings = slots.map((s) => Number(s.starter?.score) || 0);
  const xiMin = ratings.length ? Math.min(...ratings) : 40;

  slots.forEach((slot) => {
    const el = document.createElement("div");
    el.className = "player";
    el.dataset.name = slot.starter.name || "";
    el.style.left = `${slot.x}%`;
    el.style.top = `${slot.y}%`;
    const mv = formatMoney(slot.starter.marketValueEur);
    const slotLabel = slot.label || slot.role || "—";
    const rating = Math.round(Number(slot.starter.score) || 0);
    const expected11 = slot.starter.expected11;
    const officialSorarePct =
      slot.starter.officialStarterProbability != null
        ? Math.round(Number(slot.starter.officialStarterProbability) * 100)
        : null;
    const serieASignal = serieALineupEnabled() ? serieALineupSignal(slot.starter) : null;
    const lineupSignal =
      expected11
        ? `Expected11 ${expected11StatusText(expected11)}${expected11.outFallback ? " fallback" : ""}`
        : slot.starter.starterProbabilitySource === "official_sorare" &&
            officialSorarePct != null
          ? `Sorare ${officialSorarePct}%`
          : serieASignal;
    const { bg, fg } = ratingBadgeColor(rating, xiMin);
    const owner = liveDraftOwnerForName(slot.starter.name, pred.teamId ?? team?.id);
    if (owner) el.classList.add("is-taken");
    el.innerHTML = `
      <span class="kit" style="background:${bg};color:${fg}">${slotLabel}</span>
      <span class="name">${slot.starter.name}${newBadge(slot.starter)}${takenBadge(owner)}</span>
      <span class="sub">${mv} · рейтинг ${rating}${lineupSignal ? ` · ${esc(lineupSignal)}` : ""}</span>
    `;
    el.title = [
      `Слот: ${slotLabel}`,
      `Роль: ${slot.starter.roleLabel || slot.starter.role || "—"}`,
      slot.starter.isNew
        ? `Новый трансфер${slot.starter.joinedAt ? ` · ${slot.starter.joinedAt}` : ""}`
        : null,
      owner ? `Куплен: ${owner}` : null,
      slot.backup ? `Backup: ${slot.backup.name}` : null,
      expected11 ? expected11Title(expected11) : null,
      serieASignal,
      !expected11 && officialSorarePct != null
        ? `Официальный Sorare: ${officialSorarePct}%`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    pitch.appendChild(el);
  });

  // Expert XI overlay (async catalog; highlight both pitches once loaded)
  void loadExpertXiCatalog().then(async (catalog) => {
    const league = currentXiLeague();
    await mergeDynamicSorareExpert(
      catalog,
      league?.afLeagueId,
      Number(pred.teamId ?? team.id),
      pred.teamName || team.name,
    );
    // Skip if user switched team while fetch was in flight
    if (xiSelectedTeamId != null && String(xiSelectedTeamId) !== String(pred.teamId ?? team.id)) {
      return;
    }
    const expertTeam = findExpertTeam(catalog, {
      id: pred.teamId ?? team.id,
      name: pred.teamName || team.name,
    });
    applyOurXiConsensus(pitch, slots, expertTeam);
    renderExpertXiPitch(expertTeam, slots);
  });

  const backupsEl = document.getElementById("xi-backups");
  backupsEl.innerHTML = "";
  const withBackup = slots.filter((s) => s.backup);
  if (withBackup.length === 0) {
    backupsEl.innerHTML = `<li><span class="who">Нет backup по ролям</span></li>`;
    return;
  }
  for (const s of withBackup) {
    const li = document.createElement("li");
    const expected11 = s.backup.expected11;
    const serieASignal = serieALineupEnabled() ? serieALineupSignal(s.backup) : null;
    li.innerHTML = `
      <span class="slot">${s.label}</span>
      <span class="who">${s.backup.name}${newBadge(s.backup)}</span>
      <span class="for">${s.backup.roleLabel || s.backup.role || ""} → ${s.starter.name} · ${formatMoney(s.backup.marketValueEur)}${expected11 ? ` · Expected11 ${esc(expected11StatusText(expected11))}` : ""}${serieASignal ? ` · ${esc(serieASignal)}` : ""}</span>
    `;
    if (expected11) li.title = expected11Title(expected11);
    backupsEl.appendChild(li);
  }
}

async function selectXiTeam(teamId) {
  xiSelectedTeamId = teamId;
  setXiSelectedChip(teamId);
  if (currentPageName() === "xi") syncXiHash();
  const league = currentXiLeague();
  const season = currentXiSeason();
  statusEl.textContent = "Загрузка предикта…";
  return withContentLoading(async () => {
    const url =
      league.source === "tm"
        ? `/api/xi/${encodeURIComponent(league.path)}/teams/${encodeURIComponent(teamId)}/predicted-xi`
        : `/${league.path}/${season}/teams/${teamId}/predicted-xi`;
    const res = await fetch(url);
    if (!res.ok) {
      statusEl.textContent = `Не удалось загрузить XI для клуба ${teamId}`;
      return;
    }
    const pred = await res.json();
    const team = xiTeamById.get(teamId);
    renderXiPrediction(team, pred);
    statusEl.textContent = pred.method || `${league.name} · предикт XI`;
  });
}

function formatMoney(value) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

function formatHeight(h) {
  if (h == null) return "—";
  return `${Number(h).toFixed(2)} m`;
}

function formatDate(iso) {
  return formatUiDateTime(iso);
}

function playerHref(id) {
  return `/player.html?id=${encodeURIComponent(id)}`;
}

function currentPageName() {
  return document.body?.dataset?.page || "clubs";
}

function slugifyLeagueName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function competitionLeagueSlug(compId = activeCompetitionId) {
  const xi = XI_LEAGUES.find((l) => l.tmCompetition === compId);
  if (xi?.path) return String(xi.path);
  if (xi?.id) return String(xi.id);
  const builder =
    builderLeaguesCatalog.find((l) => l.tmCompetition === compId) ||
    BUILDER_SELECT_FALLBACK.find((l) => l.tmCompetition === compId);
  if (builder?.slug) return builder.slug;
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
  const compact = slug.replace(/-/g, "");
  const catalog = [...competitions, ...competitionResolve, ...XI_LEAGUES, ...builderLeaguesCatalog];
  const byId = catalog.find((c) => {
    const id = String(c.id || "");
    const path = String(c.path || c.slug || "");
    const tm = String(c.tmCompetition || "");
    return (
      id === raw ||
      id.toLowerCase() === rawLower ||
      path === raw ||
      path === slug ||
      path.replace(/-/g, "") === compact ||
      tm === raw ||
      tm.toLowerCase() === rawLower ||
      slugifyLeagueName(c.name).replace(/-/g, "") === compact
    );
  });
  if (byId?.tmCompetition) return byId.tmCompetition;
  if (byId?.id && /^[A-Za-z]{1,3}\d+$/.test(String(byId.id))) return byId.id;
  const byName = catalog.find((c) => slugifyLeagueName(c.name) === slug);
  if (byName?.tmCompetition) return byName.tmCompetition;
  if (byName?.id) return byName.id;
  const xi = XI_LEAGUES.find(
    (l) =>
      String(l.id) === raw ||
      String(l.path) === raw ||
      slugifyLeagueName(l.name) === slug ||
      String(l.id).toLowerCase() === rawLower,
  );
  if (xi?.tmCompetition) return xi.tmCompetition;
  return null;
}

function resolveXiTeamIdFromParam(param) {
  if (param == null || param === "") return null;
  const raw = String(param).trim();
  if (!raw) return null;
  const slug = slugifyLeagueName(raw);
  const byId = xiTeams.find((t) => String(t.id) === raw);
  if (byId) return byId.id;
  const bySlug = xiTeams.find((t) => slugifyLeagueName(t.name) === slug);
  return bySlug?.id ?? null;
}

/** Keep `#xi?league=…&team=…` in sync (replaceState — no history spam). */
function syncXiHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  if (xiSelectedTeamId != null) {
    const team = xiTeamById.get(xiSelectedTeamId);
    const teamSlug = team?.name ? slugifyLeagueName(team.name) : String(xiSelectedTeamId);
    if (teamSlug) qs.set("team", teamSlug);
  }
  const next = qs.toString() ? `/xi?${qs}` : "/xi";
  if (`${location.pathname}${location.search}` === next) return;
  history.replaceState(null, "", next);
}


function mainRole(p) {
  return p.detailLabel || p.detailRole || p.position || "—";
}

function extraRoles(p) {
  if (p.sideRole) return p.sideRole;
  if (p.sideRole2) return p.sideRole2;
  return "—";
}

function setView(name) {
  if (name === "live-draft") {
    location.replace("/live-draft");
    return;
  }
  if (name === "mapping" && !accountState.entitlements?.expected11Admin) {
    name = "clubs";
  }
  if (name === "premium" && !accountState.entitlements?.expected11Premium) {
    name = "clubs";
  }
  for (const btn of document.querySelectorAll(".tab")) {
    btn.setAttribute("aria-selected", btn.dataset.view === name ? "true" : "false");
  }
  for (const id of ["clubs", "players", "matches", "xi", "builder", "ref"]) {
    const el = document.getElementById(`view-${id}`);
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
      if (meta) meta.textContent = `Ошибка: ${err.message}`;
    });
  }
}

function sortedClubs() {
  const sort = document.getElementById("club-sort").value;
  const rows = clubs.slice();
  rows.sort((a, b) => {
    if (sort === "value-asc") return (a.marketValue || 0) - (b.marketValue || 0);
    if (sort === "age-asc") return (a.averageAge || 99) - (b.averageAge || 99);
    if (sort === "squad-desc") return (b.squadSize || 0) - (a.squadSize || 0);
    if (sort === "name") return a.name.localeCompare(b.name);
    return (b.marketValue || 0) - (a.marketValue || 0);
  });
  return rows;
}

function renderLeague() {
  const logo = document.getElementById("league-logo");
  if (!logo || !competition) return;
  logo.src = competition.logoUrl || "";
  document.getElementById("league-name").textContent = competition.name;
  document.getElementById("league-meta").textContent =
    `${competition.shortName || competition.id || "—"} · сезон ${competition.seasonId ?? "—"}` +
    (competition.pending
      ? " · ещё не в TM (ждём sync:expand)"
      : competition.syncedAt
        ? ` · sync ${competition.syncedAt.slice(0, 10)}`
        : "");

  const stats = [
    ["Стоимость", formatMoney(competition.totalMarketValue)],
    ["Клубы", String(competition.clubCount)],
    ["Игроки", String(competition.playerCount)],
    ["Матчи", String(games.length)],
    ["Туры", String(competition.gameDayCount ?? "—")],
  ];
  document.getElementById("league-stats").innerHTML = stats
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

/** @type {ReturnType<typeof setInterval> | null} */
let syncProgressTimer = null;

function phaseLabel(phase) {
  const map = { af: "API Football", tm: "Transfermarkt", mantra: "Mantra", managers: "Managers" };
  return map[phase] || phase || "—";
}

function renderSyncProgress(payload) {
  const box = document.getElementById("sync-progress");
  if (!box) return;
  const progress = payload?.progress;
  if (!progress || progress.status === "idle") {
    box.hidden = true;
    return;
  }

  const ageMs = progress.finishedAt ? Date.now() - Date.parse(progress.finishedAt) : 0;
  if (progress.status === "done" && ageMs > 15 * 60_000) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  box.dataset.status = progress.status;
  const local = payload.forThisLeague;
  const pct = Math.round(progress.percent || 0);
  document.getElementById("sync-progress-fill").style.width = `${pct}%`;
  document.getElementById("sync-progress-pct").textContent = `${pct}%`;

  let head = "Очередь sync";
  if (progress.status === "running") {
    head = local?.activeHere
      ? `Синхронизация этой лиги · ${phaseLabel(progress.phase)}`
      : local?.position
        ? `В очереди · позиция ${local.position} из ${local.remaining}`
        : `Очередь sync · ${phaseLabel(progress.phase)}`;
  } else if (progress.status === "done") {
    head = "Sync завершён";
  } else if (progress.status === "error") {
    head = "Sync прерван";
  }
  document.getElementById("sync-progress-label").textContent = head;

  const parts = [];
  if (progress.label) parts.push(progress.label);
  if (local?.items?.length && progress.status === "running") {
    const pending = local.items.filter((i) => i.status === "pending").map((i) => i.kind);
    if (pending.length) parts.push(`дальше: ${pending.join(" → ")}`);
  }
  if (progress.status === "running" && progress.queue?.length) {
    const done = progress.queue.filter((q) => q.status === "done" || q.status === "skipped").length;
    parts.push(`очередь ${done}/${progress.queue.length}`);
  }
  if (progress.error) parts.push(progress.error);
  document.getElementById("sync-progress-detail").textContent = parts.filter(Boolean).join(" · ");

  const restartBtn = document.getElementById("sync-restart");
  if (restartBtn) {
    const showRestart = progress.status === "error" || progress.status === "idle";
    restartBtn.hidden = !showRestart;
  }
}

async function restartExpandSync() {
  const btn = document.getElementById("sync-restart");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Запуск…";
  }
  try {
    const res = await fetch("/api/sync/expand/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      statusEl.textContent = `Sync: ${data.error || `HTTP ${res.status}`}`;
    } else {
      statusEl.textContent = `Sync:expand запущен (pid ${data.pid})`;
    }
  } catch (err) {
    statusEl.textContent = `Sync start failed: ${err.message}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Перезапустить sync:expand";
    }
    await refreshSyncProgress();
  }
}

async function refreshSyncProgress() {
  try {
    const res = await fetch(
      `/api/sync/progress?competition=${encodeURIComponent(activeCompetitionId)}`,
    );
    if (!res.ok) return;
    const data = await res.json();
    renderSyncProgress(data);
    const running = data?.progress?.status === "running";
    if (running && !syncProgressTimer) {
      syncProgressTimer = setInterval(refreshSyncProgress, 2500);
    } else if (!running && syncProgressTimer) {
      clearInterval(syncProgressTimer);
      syncProgressTimer = null;
    }
  } catch {
    /* ignore transient poll errors */
  }
}

function renderClubs() {
  if (!clubGrid) return;
  const rows = sortedClubs();
  const meta = document.getElementById("clubs-meta");
  if (meta) meta.textContent = `${rows.length} клубов`;
  clubGrid.innerHTML = "";
  rows.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "club-card";
    btn.style.animationDelay = `${Math.min(i, 12) * 0.03}s`;
    btn.innerHTML = `
      <img src="${c.crestUrl || ""}" alt="" loading="lazy" />
      <div>
        <h3>${c.name}</h3>
        <p class="city">${c.city || "—"}</p>
        <div class="club-metrics">
          <span class="chip">${formatMoney(c.marketValue)}</span>
          <span class="chip">возраст ${c.averageAge?.toFixed?.(1) ?? "—"}</span>
          <span class="chip">состав ${c.squadSize ?? "—"}</span>
        </div>
      </div>`;
    btn.addEventListener("click", () => openClub(c.id));
    clubGrid.appendChild(btn);
  });
}

const PLAYERS_COLS_KEY = "tmPlayersCols:v1";
const PLAYERS_SORT_KEY = "tmPlayersSort:v1";

/** Column catalog for #players — toggle + sort. */
const PLAYERS_COL_DEFS = [
  { id: "photo", label: "", group: "profile", defaultOn: true, sortable: false },
  { id: "name", label: "Игрок", group: "profile", defaultOn: true, sortable: true, type: "text" },
  { id: "club", label: "Клуб", group: "profile", defaultOn: true, sortable: true, type: "text" },
  { id: "clubsPlayed", label: "Клубы (сезон)", group: "stats", defaultOn: false, sortable: true, type: "text" },
  { id: "domesticLeague", label: "Дом. лига", group: "stats", defaultOn: true, sortable: true, type: "text" },
  { id: "role", label: "Основная роль", group: "profile", defaultOn: true, sortable: true, type: "text" },
  { id: "sideRoles", label: "Доп. роли", group: "profile", defaultOn: false, sortable: false },
  { id: "mantraPositions", label: "Mantra Positions", group: "profile", defaultOn: true, sortable: true, type: "text" },
  { id: "apps", label: "Игры", group: "stats", defaultOn: true, sortable: true, type: "num" },
  { id: "goals", label: "Голы", group: "stats", defaultOn: true, sortable: true, type: "num" },
  { id: "assists", label: "Пасы", group: "stats", defaultOn: true, sortable: true, type: "num" },
  { id: "minutes", label: "Минуты", group: "stats", defaultOn: true, sortable: true, type: "num" },
  { id: "xg", label: "xG", group: "stats", defaultOn: false, sortable: true, type: "num" },
  { id: "xa", label: "xA", group: "stats", defaultOn: false, sortable: true, type: "num" },
  { id: "rating", label: "Оц.", group: "stats", defaultOn: true, sortable: true, type: "num" },
  { id: "shots", label: "Удары", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "shotsOn", label: "В створ", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "keyPasses", label: "Кл. пасы", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "passes", label: "Пасы ∑", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "passAcc", label: "Точн. %", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "tackles", label: "Отборы", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "dribbles", label: "Дриблинг", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "yc", label: "ЖК", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "rc", label: "КК", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "cs", label: "Сухие", group: "advanced", defaultOn: false, sortable: true, type: "num" },
  { id: "nationality", label: "Нация", group: "profile", defaultOn: false, sortable: true, type: "text" },
  { id: "birth", label: "Город", group: "profile", defaultOn: false, sortable: true, type: "text" },
  { id: "age", label: "Возраст", group: "profile", defaultOn: false, sortable: true, type: "num" },
  { id: "height", label: "Рост", group: "profile", defaultOn: false, sortable: true, type: "num" },
  { id: "foot", label: "Нога", group: "profile", defaultOn: false, sortable: true, type: "text" },
  { id: "contract", label: "Контракт", group: "profile", defaultOn: false, sortable: true, type: "text" },
  { id: "value", label: "Цена", group: "profile", defaultOn: true, sortable: true, type: "num" },
  { id: "peak", label: "Пик", group: "profile", defaultOn: false, sortable: true, type: "num" },
  { id: "agency", label: "Агентство", group: "profile", defaultOn: false, sortable: true, type: "text" },
];

const EUROPE_LEAGUE_IDS = new Set([2, 3, 848]);

let playersColVisible = loadPlayersColVisible();
let playersSort = loadPlayersSort();
let playersExpanded = new Set();
let playersColsUiBound = false;
/** Column-driven filters — reset when visible columns change. Not persisted. */
let playersColFilters = {};
let playersColFiltersUiBound = false;
/** Signature of last built filter UI (visible filterable col ids). */
let playersColFiltersBuiltFor = "";

/** Skip: photo, name (search), club (toolbar club filter). */
const PLAYERS_COL_FILTER_SKIP = new Set(["photo", "name", "club"]);
/** Discrete multi-value fields — match if any selected value intersects player's set. */
const PLAYERS_COL_FILTER_MULTI = new Set(["mantraPositions", "clubsPlayed"]);

function playersColFilterKind(col) {
  if (!col || PLAYERS_COL_FILTER_SKIP.has(col.id)) return null;
  if (col.type === "num") return "num";
  if (col.type === "text" || col.id === "sideRoles") {
    return PLAYERS_COL_FILTER_MULTI.has(col.id) ? "multi" : "discrete";
  }
  return null;
}

function filterableVisiblePlayerCols() {
  return visiblePlayerCols().filter((c) => playersColFilterKind(c));
}

function resetPlayersColFilters() {
  playersColFilters = {};
}

function playersColFiltersSignature() {
  const comp = document.getElementById("player-comp-filter")?.value || "all";
  // Include players.length so options rebuild after data load (first paint may be empty).
  return `${comp}|${players.length}|${filterableVisiblePlayerCols()
    .map((c) => c.id)
    .join(",")}`;
}

/** Numeric value for range filter (null = missing → fails when a bound is set). */
function playerFilterNum(p, key) {
  const view = playerStatView(p);
  const t = view.totals;
  switch (key) {
    case "apps":
      return t?.appearances ?? null;
    case "goals":
      return t?.goals ?? null;
    case "assists":
      return t?.assists ?? null;
    case "minutes":
      return t?.minutes ?? null;
    case "xg":
      return t?.xg ?? null;
    case "xa":
      return t?.xa ?? null;
    case "rating":
      return t?.rating ?? null;
    case "shots":
      return t?.shotsTotal ?? null;
    case "shotsOn":
      return t?.shotsOn ?? null;
    case "keyPasses":
      return t?.keyPasses ?? null;
    case "passes":
      return t?.passesTotal ?? null;
    case "passAcc":
      return t?.passAccuracy ?? null;
    case "tackles":
      return t?.tacklesTotal ?? null;
    case "dribbles":
      return t?.dribblesSuccess ?? null;
    case "yc":
      return t?.yellowCards ?? null;
    case "rc":
      return t?.redCards ?? null;
    case "cs":
      return t?.cleanSheets ?? null;
    case "age":
      return p.age ?? null;
    case "height":
      return p.height ?? null;
    case "value":
      return p.marketValueEur ?? null;
    case "peak":
      return p.marketValueHighest ?? null;
    default:
      return null;
  }
}

/** Distinct values for a discrete/multi column (from full loaded dataset). */
function playerDiscreteValues(p, colId) {
  const view = playerStatView(p);
  switch (colId) {
    case "clubsPlayed":
      return (view.clubsPlayed || []).filter(Boolean);
    case "domesticLeague":
      return view.domesticLeague && view.domesticLeague !== "—" ? [view.domesticLeague] : [];
    case "role": {
      const r = mainRole(p);
      return r && r !== "—" ? [r] : [];
    }
    case "sideRoles": {
      const s = extraRoles(p);
      return s && s !== "—" ? [s] : [];
    }
    case "mantraPositions":
      return (p.mantraPositions || []).filter(Boolean);
    case "nationality":
      return p.nationality ? [p.nationality] : [];
    case "birth":
      return p.placeOfBirth ? [p.placeOfBirth] : [];
    case "foot":
      return p.preferredFoot ? [p.preferredFoot] : [];
    case "contract":
      return p.contractUntil ? [p.contractUntil] : [];
    case "agency":
      return p.agencyName ? [p.agencyName] : [];
    default:
      return [];
  }
}

function discreteOptionsForCol(colId) {
  const set = new Set();
  for (const p of players) {
    for (const v of playerDiscreteValues(p, colId)) set.add(v);
  }
  return [...set].sort((a, b) => String(a).localeCompare(String(b), "ru"));
}

function parseFilterBound(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function matchesPlayersColFilters(p) {
  for (const col of filterableVisiblePlayerCols()) {
    const state = playersColFilters[col.id];
    if (!state) continue;
    const kind = playersColFilterKind(col);
    if (kind === "num") {
      const min = parseFilterBound(state.min);
      const max = parseFilterBound(state.max);
      if (min == null && max == null) continue;
      const v = playerFilterNum(p, col.id);
      if (v == null) return false;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
    } else if (kind === "discrete" || kind === "multi") {
      const selected = state.values;
      if (!selected?.size) continue;
      const vals = playerDiscreteValues(p, col.id);
      if (!vals.some((v) => selected.has(v))) return false;
    }
  }
  return true;
}

function colFilterActiveCount() {
  let n = 0;
  for (const col of filterableVisiblePlayerCols()) {
    const state = playersColFilters[col.id];
    if (!state) continue;
    const kind = playersColFilterKind(col);
    if (kind === "num") {
      if (parseFilterBound(state.min) != null || parseFilterBound(state.max) != null) n += 1;
    } else if (state.values?.size) n += 1;
  }
  return n;
}

function multiFilterButtonLabel(col, selected) {
  if (!selected?.size) return "Все";
  if (selected.size === 1) return [...selected][0];
  return `${selected.size} выбр.`;
}

function renderPlayersColFilters({ force = false } = {}) {
  const panel = document.getElementById("player-col-filters-panel");
  const body = document.getElementById("player-col-filters");
  if (!panel || !body) return;

  const cols = filterableVisiblePlayerCols();
  const sig = playersColFiltersSignature();
  if (!cols.length) {
    panel.hidden = true;
    body.innerHTML = "";
    playersColFiltersBuiltFor = "";
    return;
  }
  panel.hidden = false;

  if (!force && sig === playersColFiltersBuiltFor) {
    // Keep open dropdowns; only refresh active labels on buttons
    for (const col of cols) {
      const kind = playersColFilterKind(col);
      if (kind !== "discrete" && kind !== "multi") continue;
      const btn = body.querySelector(`[data-col-filter-btn="${col.id}"]`);
      if (!btn) continue;
      const selected = playersColFilters[col.id]?.values;
      btn.textContent = multiFilterButtonLabel(col, selected);
      btn.classList.toggle("is-active", Boolean(selected?.size));
    }
    const summary = panel.querySelector(".col-filters-summary");
    if (summary) {
      const active = colFilterActiveCount();
      summary.textContent = active ? `Фильтры колонок (${active})` : "Фильтры колонок";
    }
    return;
  }

  playersColFiltersBuiltFor = sig;
  // Drop state for columns that are no longer visible/filterable
  for (const key of Object.keys(playersColFilters)) {
    if (!cols.some((c) => c.id === key)) delete playersColFilters[key];
  }

  body.innerHTML = cols
    .map((col) => {
      const kind = playersColFilterKind(col);
      if (kind === "num") {
        const st = playersColFilters[col.id] || { min: "", max: "" };
        return `<div class="col-filter" data-col-filter="${col.id}" data-kind="num">
          <span class="col-filter-label">${esc(col.label)}</span>
          <div class="col-filter-range">
            <input type="number" inputmode="decimal" data-bound="min" placeholder="от" value="${esc(String(st.min ?? ""))}" />
            <span>–</span>
            <input type="number" inputmode="decimal" data-bound="max" placeholder="до" value="${esc(String(st.max ?? ""))}" />
          </div>
        </div>`;
      }
      const selected = playersColFilters[col.id]?.values;
      const opts = discreteOptionsForCol(col.id);
      // Drop selected values that disappeared from options
      if (selected?.size) {
        for (const v of [...selected]) {
          if (!opts.includes(v)) selected.delete(v);
        }
        if (!selected.size) delete playersColFilters[col.id];
      }
      const sel = playersColFilters[col.id]?.values;
      const menu =
        opts.length === 0
          ? `<p class="col-filter-multi-empty">Нет значений</p>`
          : opts
              .map(
                (v) =>
                  `<label class="col-filter-multi-item"><input type="checkbox" value="${esc(v)}" ${
                    sel?.has(v) ? "checked" : ""
                  }/> ${esc(v)}</label>`,
              )
              .join("");
      return `<div class="col-filter" data-col-filter="${col.id}" data-kind="${kind}">
        <span class="col-filter-label">${esc(col.label)}</span>
        <div class="col-filter-multi">
          <button type="button" class="col-filter-multi-btn${sel?.size ? " is-active" : ""}" data-col-filter-btn="${col.id}" aria-expanded="false">${esc(
            multiFilterButtonLabel(col, sel),
          )}</button>
          <div class="col-filter-multi-menu" data-col-filter-menu="${col.id}" hidden>${menu}</div>
        </div>
      </div>`;
    })
    .join("");

  const summary = panel.querySelector(".col-filters-summary");
  if (summary) {
    const active = colFilterActiveCount();
    summary.textContent = active ? `Фильтры колонок (${active})` : "Фильтры колонок";
  }
  ensurePlayersColFiltersUi();
}

function ensurePlayersColFiltersUi() {
  if (playersColFiltersUiBound) return;
  playersColFiltersUiBound = true;
  const body = document.getElementById("player-col-filters");
  if (!body) return;

  body.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-bound]");
    if (!input) return;
    const wrap = input.closest("[data-col-filter]");
    if (!wrap) return;
    const colId = wrap.getAttribute("data-col-filter");
    const bound = input.getAttribute("data-bound");
    if (!playersColFilters[colId]) playersColFilters[colId] = { min: "", max: "" };
    playersColFilters[colId][bound] = input.value;
    renderPlayers();
  });

  body.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const wrap = cb.closest("[data-col-filter]");
    const menu = cb.closest("[data-col-filter-menu]");
    if (!wrap || !menu) return;
    const colId = wrap.getAttribute("data-col-filter");
    const selected = new Set();
    for (const el of menu.querySelectorAll('input[type="checkbox"]:checked')) {
      selected.add(el.value);
    }
    if (selected.size) playersColFilters[colId] = { values: selected };
    else delete playersColFilters[colId];
    const btn = wrap.querySelector(`[data-col-filter-btn="${colId}"]`);
    if (btn) {
      const col = PLAYERS_COL_DEFS.find((c) => c.id === colId);
      btn.textContent = multiFilterButtonLabel(col, selected);
      btn.classList.toggle("is-active", selected.size > 0);
    }
    const panel = document.getElementById("player-col-filters-panel");
    const summary = panel?.querySelector(".col-filters-summary");
    if (summary) {
      const active = colFilterActiveCount();
      summary.textContent = active ? `Фильтры колонок (${active})` : "Фильтры колонок";
    }
    renderPlayers();
  });

  body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-col-filter-btn]");
    if (!btn) return;
    e.stopPropagation();
    const colId = btn.getAttribute("data-col-filter-btn");
    const menu = body.querySelector(`[data-col-filter-menu="${colId}"]`);
    if (!menu) return;
    const open = menu.hidden;
    for (const m of body.querySelectorAll("[data-col-filter-menu]")) {
      m.hidden = true;
      m.closest(".col-filter")
        ?.querySelector("[data-col-filter-btn]")
        ?.setAttribute("aria-expanded", "false");
    }
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#player-col-filters")) return;
    for (const m of body.querySelectorAll("[data-col-filter-menu]")) {
      m.hidden = true;
      m.closest(".col-filter")
        ?.querySelector("[data-col-filter-btn]")
        ?.setAttribute("aria-expanded", "false");
    }
  });
}

function loadPlayersColVisible() {
  const defaults = Object.fromEntries(PLAYERS_COL_DEFS.map((c) => [c.id, c.defaultOn]));
  try {
    const raw = localStorage.getItem(PLAYERS_COLS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function savePlayersColVisible() {
  localStorage.setItem(PLAYERS_COLS_KEY, JSON.stringify(playersColVisible));
}

function loadPlayersSort() {
  try {
    const raw = localStorage.getItem(PLAYERS_SORT_KEY);
    if (!raw) return { key: "value", dir: "desc" };
    const parsed = JSON.parse(raw);
    if (parsed?.key) return { key: parsed.key, dir: parsed.dir === "asc" ? "asc" : "desc" };
  } catch {
    /* ignore */
  }
  return { key: "value", dir: "desc" };
}

function savePlayersSort() {
  localStorage.setItem(PLAYERS_SORT_KEY, JSON.stringify(playersSort));
}

function visiblePlayerCols() {
  return PLAYERS_COL_DEFS.filter((c) => playersColVisible[c.id]);
}

function dashNum(v) {
  if (v == null || v === "") return "—";
  return v;
}

function playerStatView(p) {
  const filter = document.getElementById("player-comp-filter")?.value || "all";
  const comps = p.competitions || [];
  if (filter === "domestic") {
    const rows = comps.filter((c) => c.isDomestic);
    return aggregateCompRows(rows, p.domesticLeague);
  }
  if (filter === "europe") {
    const rows = comps.filter((c) => EUROPE_LEAGUE_IDS.has(c.leagueId));
    return aggregateCompRows(rows, "Еврокубки");
  }
  return {
    totals: p.seasonTotals || null,
    clubsPlayed: p.clubsPlayed || [],
    domesticLeague: p.domesticLeague || "—",
  };
}

function aggregateCompRows(rows, domesticLeague) {
  if (!rows.length) {
    return { totals: null, clubsPlayed: [], domesticLeague: domesticLeague || "—" };
  }
  const totals = {
    appearances: 0,
    lineups: 0,
    minutes: 0,
    goals: 0,
    assists: 0,
    rating: null,
    yellowCards: 0,
    redCards: 0,
    goalsConceded: 0,
    cleanSheets: 0,
    shotsTotal: null,
    shotsOn: null,
    passesTotal: null,
    keyPasses: null,
    passAccuracy: null,
    tacklesTotal: null,
    blocks: null,
    interceptions: null,
    dribblesAttempts: null,
    dribblesSuccess: null,
    foulsDrawn: null,
    foulsCommitted: null,
    penScored: null,
    penMissed: null,
    saves: null,
    xg: null,
    xa: null,
  };
  let ratingSum = 0;
  let ratingW = 0;
  let passSum = 0;
  let passW = 0;
  const addN = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  for (const r of rows) {
    totals.appearances += r.appearances || 0;
    totals.lineups += r.lineups || 0;
    totals.minutes += r.minutes || 0;
    totals.goals += r.goals || 0;
    totals.assists += r.assists || 0;
    totals.yellowCards += r.yellowCards || 0;
    totals.redCards += r.redCards || 0;
    totals.goalsConceded += r.goalsConceded || 0;
    totals.cleanSheets += r.cleanSheets || 0;
    totals.shotsTotal = addN(totals.shotsTotal, r.shotsTotal);
    totals.shotsOn = addN(totals.shotsOn, r.shotsOn);
    totals.passesTotal = addN(totals.passesTotal, r.passesTotal);
    totals.keyPasses = addN(totals.keyPasses, r.keyPasses);
    totals.tacklesTotal = addN(totals.tacklesTotal, r.tacklesTotal);
    totals.blocks = addN(totals.blocks, r.blocks);
    totals.interceptions = addN(totals.interceptions, r.interceptions);
    totals.dribblesAttempts = addN(totals.dribblesAttempts, r.dribblesAttempts);
    totals.dribblesSuccess = addN(totals.dribblesSuccess, r.dribblesSuccess);
    totals.foulsDrawn = addN(totals.foulsDrawn, r.foulsDrawn);
    totals.foulsCommitted = addN(totals.foulsCommitted, r.foulsCommitted);
    totals.penScored = addN(totals.penScored, r.penScored);
    totals.penMissed = addN(totals.penMissed, r.penMissed);
    totals.saves = addN(totals.saves, r.saves);
    if (r.rating != null) {
      const w = r.minutes > 0 ? r.minutes : 1;
      ratingSum += r.rating * w;
      ratingW += w;
    }
    if (r.passAccuracy != null) {
      const w = r.passesTotal > 0 ? r.passesTotal : 1;
      passSum += r.passAccuracy * w;
      passW += w;
    }
  }
  totals.rating = ratingW ? Number((ratingSum / ratingW).toFixed(2)) : null;
  totals.passAccuracy = passW ? Math.round(passSum / passW) : null;
  return {
    totals,
    clubsPlayed: [...new Set(rows.map((r) => r.teamName).filter(Boolean))].sort(),
    domesticLeague: domesticLeague || "—",
  };
}

function playerSortValue(p, key) {
  const view = playerStatView(p);
  const t = view.totals;
  switch (key) {
    case "name":
      return p.name || "";
    case "club":
      return p.clubName || "";
    case "clubsPlayed":
      return (view.clubsPlayed || []).join(", ");
    case "domesticLeague":
      return view.domesticLeague || "";
    case "role":
      return mainRole(p) || "";
    case "mantraPositions":
      return (p.mantraPositions || []).join("/") || "";
    case "apps":
      return t?.appearances ?? -1;
    case "goals":
      return t?.goals ?? -1;
    case "assists":
      return t?.assists ?? -1;
    case "minutes":
      return t?.minutes ?? -1;
    case "xg":
    case "xa":
      return -1;
    case "rating":
      return t?.rating ?? -1;
    case "shots":
      return t?.shotsTotal ?? -1;
    case "shotsOn":
      return t?.shotsOn ?? -1;
    case "keyPasses":
      return t?.keyPasses ?? -1;
    case "passes":
      return t?.passesTotal ?? -1;
    case "passAcc":
      return t?.passAccuracy ?? -1;
    case "tackles":
      return t?.tacklesTotal ?? -1;
    case "dribbles":
      return t?.dribblesSuccess ?? -1;
    case "yc":
      return t?.yellowCards ?? -1;
    case "rc":
      return t?.redCards ?? -1;
    case "cs":
      return t?.cleanSheets ?? -1;
    case "nationality":
      return p.nationality || "";
    case "birth":
      return p.placeOfBirth || "";
    case "age":
      return p.age ?? 999;
    case "height":
      return p.height ?? -1;
    case "foot":
      return p.preferredFoot || "";
    case "contract":
      return p.contractUntil || "";
    case "value":
      return p.marketValueEur ?? -1;
    case "peak":
      return p.marketValueHighest ?? -1;
    case "agency":
      return p.agencyName || "";
    default:
      return 0;
  }
}

function filteredPlayers() {
  const club = document.getElementById("player-club").value;
  const pos = document.getElementById("player-pos").value;
  const q = document.getElementById("player-q").value.trim().toLowerCase();
  let rows = players.slice();
  if (club) rows = rows.filter((p) => p.clubId === club);
  if (pos) rows = rows.filter((p) => p.position === pos);
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
  rows = rows.filter((p) => matchesPlayersColFilters(p));

  const { key, dir } = playersSort;
  const mul = dir === "asc" ? 1 : -1;
  const def = PLAYERS_COL_DEFS.find((c) => c.id === key);
  rows.sort((a, b) => {
    const va = playerSortValue(a, key);
    const vb = playerSortValue(b, key);
    if (typeof va === "string" || typeof vb === "string") {
      return mul * String(va).localeCompare(String(vb), "ru");
    }
    if (va !== vb) return mul * (va - vb);
    return a.name.localeCompare(b.name, "ru");
  });
  // silence unused
  void def;
  return rows;
}

function formatPlayerCell(colId, p, view) {
  const t = view.totals;
  switch (colId) {
    case "photo":
      return p.portraitUrl
        ? `<img class="thumb" src="${p.portraitUrl}" alt="" loading="lazy" />`
        : "";
    case "name": {
      const comps = p.competitions || [];
      const expand =
        comps.length > 1
          ? `<button type="button" class="comp-expand" data-expand="${p.playerId}" aria-expanded="${
              playersExpanded.has(p.playerId) ? "true" : "false"
            }" title="Турниры">${playersExpanded.has(p.playerId) ? "▾" : "▸"}</button>`
          : "";
      return `<div class="player-cell">${expand}<a href="${playerHref(p.playerId)}">${esc(p.name)}</a>${
        p.isCaptain ? `<span class="cap" title="Капитан">C</span>` : ""
      }</div>`;
    }
    case "club":
      return esc(p.clubName);
    case "clubsPlayed":
      return esc((view.clubsPlayed || []).join(", ") || "—");
    case "domesticLeague":
      return esc(view.domesticLeague || "—");
    case "role":
      return esc(mainRole(p));
    case "sideRoles":
      return esc(extraRoles(p));
    case "mantraPositions": {
      const pos = p.mantraPositions;
      if (!pos?.length) return "—";
      return mantraPosPill(pos.join("/"));
    }
    case "apps":
      return dashNum(t?.appearances);
    case "goals":
      return dashNum(t?.goals);
    case "assists":
      return dashNum(t?.assists);
    case "minutes":
      return dashNum(t?.minutes);
    case "xg":
    case "xa":
      return "—";
    case "rating":
      return t?.rating != null ? t.rating.toFixed(2) : "—";
    case "shots":
      return dashNum(t?.shotsTotal);
    case "shotsOn":
      return dashNum(t?.shotsOn);
    case "keyPasses":
      return dashNum(t?.keyPasses);
    case "passes":
      return dashNum(t?.passesTotal);
    case "passAcc":
      return t?.passAccuracy != null ? `${t.passAccuracy}%` : "—";
    case "tackles":
      return dashNum(t?.tacklesTotal);
    case "dribbles":
      return t?.dribblesSuccess != null || t?.dribblesAttempts != null
        ? `${dashNum(t?.dribblesSuccess)}/${dashNum(t?.dribblesAttempts)}`
        : "—";
    case "yc":
      return dashNum(t?.yellowCards);
    case "rc":
      return dashNum(t?.redCards);
    case "cs":
      return dashNum(t?.cleanSheets);
    case "nationality":
      return esc(p.nationality || "—");
    case "birth":
      return esc(p.placeOfBirth || "—");
    case "age":
      return dashNum(p.age);
    case "height":
      return formatHeight(p.height);
    case "foot":
      return esc(p.preferredFoot || "—");
    case "contract":
      return esc(p.contractUntil || "—");
    case "value":
      return formatMoney(p.marketValueEur);
    case "peak":
      return formatMoney(p.marketValueHighest);
    case "agency":
      return esc(p.agencyName || "—");
    default:
      return "—";
  }
}

function renderPlayersHead() {
  const head = document.getElementById("players-head");
  if (!head) return;
  const cols = visiblePlayerCols();
  head.innerHTML = cols
    .map((c) => {
      if (!c.sortable) return `<th>${esc(c.label)}</th>`;
      const sorted = playersSort.key === c.id;
      const dir = sorted ? playersSort.dir : "desc";
      return `<th class="sortable${sorted ? " is-sorted" : ""}" data-dir="${dir}" data-players-sort="${c.id}">${esc(
        c.label,
      )}</th>`;
    })
    .join("");
}

function renderPlayersColPicker() {
  const menu = document.getElementById("player-cols-menu");
  if (!menu) return;
  const groups = [
    ["profile", "Профиль"],
    ["stats", "Сезон 2025/26"],
    ["advanced", "Расширенная"],
  ];
  menu.innerHTML = groups
    .map(([gid, title]) => {
      const items = PLAYERS_COL_DEFS.filter((c) => c.group === gid && c.id !== "photo");
      return `<div class="col-picker-group"><p class="col-picker-title">${title}</p>${items
        .map(
          (c) => `<label class="col-picker-item"><input type="checkbox" data-col="${c.id}" ${
            playersColVisible[c.id] ? "checked" : ""
          }/> ${esc(c.label)}</label>`,
        )
        .join("")}</div>`;
    })
    .join("");
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Plain-text cell for CSV — all PLAYERS_COL_DEFS, independent of visibility toggles. */
function csvPlayerValue(colId, p, view) {
  const t = view.totals;
  switch (colId) {
    case "photo":
      return p.portraitUrl || "";
    case "name":
      return p.name || "";
    case "club":
      return p.clubName || "";
    case "clubsPlayed":
      return (view.clubsPlayed || []).join(", ");
    case "domesticLeague":
      return view.domesticLeague || "";
    case "role":
      return mainRole(p) || "";
    case "sideRoles":
      return extraRoles(p) || "";
    case "mantraPositions":
      return (p.mantraPositions || []).join("/");
    case "apps":
      return t?.appearances ?? "";
    case "goals":
      return t?.goals ?? "";
    case "assists":
      return t?.assists ?? "";
    case "minutes":
      return t?.minutes ?? "";
    case "xg":
      return t?.xg ?? "";
    case "xa":
      return t?.xa ?? "";
    case "rating":
      return t?.rating ?? "";
    case "shots":
      return t?.shotsTotal ?? "";
    case "shotsOn":
      return t?.shotsOn ?? "";
    case "keyPasses":
      return t?.keyPasses ?? "";
    case "passes":
      return t?.passesTotal ?? "";
    case "passAcc":
      return t?.passAccuracy ?? "";
    case "tackles":
      return t?.tacklesTotal ?? "";
    case "dribbles":
      return t?.dribblesSuccess != null || t?.dribblesAttempts != null
        ? `${t?.dribblesSuccess ?? ""}/${t?.dribblesAttempts ?? ""}`
        : "";
    case "yc":
      return t?.yellowCards ?? "";
    case "rc":
      return t?.redCards ?? "";
    case "cs":
      return t?.cleanSheets ?? "";
    case "nationality":
      return p.nationality || "";
    case "birth":
      return p.placeOfBirth || "";
    case "age":
      return p.age ?? "";
    case "height":
      return p.height ?? "";
    case "foot":
      return p.preferredFoot || "";
    case "contract":
      return p.contractUntil || "";
    case "value":
      return p.marketValueEur ?? "";
    case "peak":
      return p.marketValueHighest ?? "";
    case "agency":
      return p.agencyName || "";
    default:
      return "";
  }
}

function playersCsvFilename() {
  const season = players[0]?.season ?? 2025;
  const y = season;
  const y2 = String(season + 1).slice(-2);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `players-${y}-${y2}-${stamp}.csv`;
}

function flashPlayersMeta(msg) {
  const meta = document.getElementById("players-meta");
  if (!meta) return;
  const prev = meta.textContent;
  meta.textContent = msg;
  setTimeout(() => {
    if (meta.textContent === msg) {
      // restore via re-render if still on players; else leave
      if (!document.getElementById("view-players")?.hidden) renderPlayers();
      else meta.textContent = prev;
    }
  }, 2200);
}

function exportPlayersCsv() {
  if (!players.length) {
    flashPlayersMeta("Экспорт: данные ещё загружаются или пусты");
    return;
  }
  const rows = filteredPlayers();
  if (!rows.length) {
    flashPlayersMeta("Экспорт: нет игроков по текущим фильтрам");
    return;
  }
  const cols = PLAYERS_COL_DEFS;
  const header = cols.map((c) => csvEscape(c.id === "photo" ? "photo" : c.label || c.id));
  const lines = [header.join(",")];
  for (const p of rows) {
    const view = playerStatView(p);
    lines.push(cols.map((c) => csvEscape(csvPlayerValue(c.id, p, view))).join(","));
  }
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = playersCsvFilename();
  a.click();
  URL.revokeObjectURL(url);
  flashPlayersMeta(`Экспорт: ${rows.length} игроков · все колонки`);
}

function ensurePlayersColsUi() {
  if (playersColsUiBound) return;
  playersColsUiBound = true;
  const btn = document.getElementById("player-cols-btn");
  const menu = document.getElementById("player-cols-menu");
  const picker = document.getElementById("player-col-picker");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderPlayersColPicker();
  });
  menu?.addEventListener("change", (e) => {
    const input = e.target.closest("input[data-col]");
    if (!input) return;
    playersColVisible[input.dataset.col] = input.checked;
    // Keep at least name visible
    if (!playersColVisible.name) {
      playersColVisible.name = true;
      input.checked = input.dataset.col === "name" ? true : input.checked;
    }
    savePlayersColVisible();
    resetPlayersColFilters();
    playersColFiltersBuiltFor = "";
    renderPlayersColFilters({ force: true });
    renderPlayers();
  });
  document.getElementById("players-export-csv")?.addEventListener("click", () => {
    exportPlayersCsv();
  });
  document.addEventListener("click", (e) => {
    if (!picker || picker.contains(e.target)) return;
    if (menu) menu.hidden = true;
    btn?.setAttribute("aria-expanded", "false");
  });
  document.getElementById("players-table")?.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-players-sort]");
    if (th) {
      const key = th.getAttribute("data-players-sort");
      if (!key) return;
      if (playersSort.key === key) {
        playersSort.dir = playersSort.dir === "asc" ? "desc" : "asc";
      } else {
        playersSort = { key, dir: key === "name" || key === "club" ? "asc" : "desc" };
      }
      savePlayersSort();
      renderPlayers();
      return;
    }
    const expand = e.target.closest("[data-expand]");
    if (expand) {
      e.preventDefault();
      e.stopPropagation();
      const id = expand.getAttribute("data-expand");
      if (playersExpanded.has(id)) playersExpanded.delete(id);
      else playersExpanded.add(id);
      renderPlayers();
    }
  });
}

function renderPlayers() {
  if (!playersBody) return;
  ensurePlayersColsUi();
  renderPlayersColFilters();
  renderPlayersHead();
  const cols = visiblePlayerCols();
  const rows = filteredPlayers();
  const seasonLabel = players[0]?.season != null ? `${players[0].season}/${String(players[0].season + 1).slice(2)}` : "2025/26";
  const withStats = rows.filter((p) => p.seasonTotals).length;
  document.getElementById("players-meta").textContent =
    `${rows.length} игроков · сезон ${seasonLabel} · статистика ${withStats}/${rows.length}`;
  playersBody.innerHTML = "";
  for (const p of rows) {
    const view = playerStatView(p);
    const tr = document.createElement("tr");
    tr.className = "click-row";
    tr.innerHTML = cols.map((c) => `<td>${formatPlayerCell(c.id, p, view)}</td>`).join("");
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a,button,[data-expand]")) return;
      location.href = playerHref(p.playerId);
    });
    playersBody.appendChild(tr);

    if (playersExpanded.has(p.playerId) && (p.competitions || []).length) {
      for (const line of p.competitions) {
        const sub = document.createElement("tr");
        sub.className = "comp-subrow";
        const lineView = {
          totals: line,
          clubsPlayed: [line.teamName],
          domesticLeague: line.leagueName,
        };
        sub.innerHTML = cols
          .map((c) => {
            if (c.id === "photo") return `<td></td>`;
            if (c.id === "name")
              return `<td class="comp-sub-name"><span class="muted">${esc(line.leagueName)}</span></td>`;
            if (c.id === "club" || c.id === "clubsPlayed")
              return `<td>${esc(line.teamName)}</td>`;
            if (c.id === "domesticLeague") return `<td>${esc(line.leagueCode)}</td>`;
            if (c.id === "role" || c.id === "sideRoles") return `<td></td>`;
            if (["nationality", "birth", "age", "height", "foot", "contract", "value", "peak", "agency"].includes(c.id))
              return `<td></td>`;
            return `<td>${formatPlayerCell(c.id, p, lineView)}</td>`;
          })
          .join("");
        playersBody.appendChild(sub);
      }
    }
  }
}

function filteredGames() {
  const club = document.getElementById("match-club").value;
  const comp = document.getElementById("match-comp").value;
  const status = document.getElementById("match-status").value;
  let rows = games.slice();
  if (club) rows = rows.filter((g) => g.homeClubId === club || g.awayClubId === club);
  if (comp) rows = rows.filter((g) => g.competitionId === comp);
  if (status === "finished") rows = rows.filter((g) => g.isFinished || g.homeScore != null);
  if (status === "upcoming") rows = rows.filter((g) => !g.isFinished && g.homeScore == null);
  return rows;
}

function competitionCell(g) {
  const name = g.competitionName || g.competitionId || "—";
  const code = g.competitionId;
  if (code && name !== code) return `${name} <span class="muted">(${code})</span>`;
  return name;
}

function renderMatches() {
  if (!matchesBody) return;
  const rows = filteredGames();
  document.getElementById("matches-meta").textContent = `${rows.length} матчей`;
  matchesBody.innerHTML = "";
  for (const g of rows) {
    const tr = document.createElement("tr");
    tr.className = "click-row";
    const score =
      g.homeScore != null && g.awayScore != null ? `${g.homeScore} : ${g.awayScore}` : "—";
    const tactics = [g.homeTactic, g.awayTactic].filter(Boolean).join(" / ") || "—";
    tr.innerHTML = `
      <td>${formatDate(g.dateUtc)}</td>
      <td>${g.gameDay ?? (g.source === "af" ? "PS" : "—")}</td>
      <td>${competitionCell(g)}</td>
      <td>${g.homeClubName || g.homeClubId || "—"}</td>
      <td><strong>${score}</strong></td>
      <td>${g.awayClubName || g.awayClubId || "—"}</td>
      <td>${tactics}</td>`;
    tr.addEventListener("click", () => openGame(g.id));
    matchesBody.appendChild(tr);
  }
}

function fillClubSelects() {
  const opts = clubs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join("");
  for (const id of ["player-club", "match-club"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    const prev = select.value;
    select.innerHTML = `<option value="">Все</option>${opts}`;
    if (prev) select.value = prev;
  }
}

function fillMatchCompFilter() {
  const select = document.getElementById("match-comp");
  if (!select) return;
  const prev = select.value;
  const byCode = new Map();
  for (const g of games) {
    if (!g.competitionId) continue;
    if (!byCode.has(g.competitionId)) {
      byCode.set(g.competitionId, g.competitionName || g.competitionId);
    }
  }
  const comps = [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  select.innerHTML =
    `<option value="">Все</option>` +
    comps
      .map(([code, name]) => {
        const label = name && name !== code ? `${name} (${code})` : code;
        return `<option value="${code}">${label}</option>`;
      })
      .join("");
  if (prev) select.value = prev;
}

/** @type {string | null} */
let refLoadedCategory = null;

async function renderRef() {
  const category = document.getElementById("ref-category").value;
  const q = document.getElementById("ref-q").value.trim().toLowerCase();
  const help = document.getElementById("ref-help");
  if (!category) {
    refBody.innerHTML = "";
    if (help) help.textContent = "";
    refLoadedCategory = null;
    return;
  }

  const paintRows = () => {
    let rows = refItems;
    if (q) rows = rows.filter((r) => `${r.id} ${r.name || ""}`.toLowerCase().includes(q));
    document.getElementById("ref-meta").textContent = `${rows.length} / ${refItems.length}`;
    refBody.innerHTML = rows
      .slice(0, 500)
      .map((r) => `<tr><td>${r.id}</td><td>${r.name || "—"}</td></tr>`)
      .join("");
  };

  // Filter-only path: no fetch / no overlay.
  if (category === refLoadedCategory) {
    paintRows();
    return;
  }

  return withContentLoading(async () => {
    const res = await fetch(`/api/ref/${encodeURIComponent(category)}`);
    const data = await res.json();
    refItems = data.items || [];
    refLoadedCategory = category;
    const meta = data.meta;
    if (help) {
      help.innerHTML = meta
        ? `<strong>${meta.title}</strong> — ${meta.purpose}${
            meta.usedInPlayerCard ? " · используется в карточке игрока" : " · в карточке игрока напрямую не показывается"
          }`
        : "";
    }
    paintRows();
  });
}

function fillRefCategories() {
  const select = document.getElementById("ref-category");
  select.innerHTML = refCategories
    .map((c) => {
      const title = c.meta?.title || c.category;
      return `<option value="${c.category}">${title} (${c.count})</option>`;
    })
    .join("");
}

async function openClub(clubId) {
  const res = await fetch(
    `/api/clubs/${clubId}?competition=${encodeURIComponent(activeCompetitionId)}`,
  );
  if (!res.ok) {
    statusEl.textContent = `Club ${clubId} failed`;
    return;
  }
  const data = await res.json();
  const c = data.club;
  document.getElementById("dialog-crest").src = c.crestUrl || "";
  document.getElementById("dialog-name").textContent = c.name;
  document.getElementById("dialog-meta").textContent = `${c.city || "—"} · состав ${c.squadSize ?? data.squad.length}`;

  const stats = [
    ["Стоимость", formatMoney(c.marketValue)],
    ["Средняя", formatMoney(c.averageMarketValue)],
    ["Top-18", formatMoney(c.top18MarketValue)],
    ["Закупки", formatMoney(c.acquisitionValue)],
    ["Возраст", c.averageAge?.toFixed?.(1) ?? "—"],
  ];
  document.getElementById("dialog-stats").innerHTML = stats
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");

  const body = document.getElementById("dialog-squad");
  body.innerHTML = "";
  for (const p of data.squad) {
    const tr = document.createElement("tr");
    tr.className = "click-row";
    tr.innerHTML = `
      <td>${p.shirtNumber ?? "—"}</td>
      <td>${p.portraitUrl ? `<img class="thumb" src="${p.portraitUrl}" alt="" loading="lazy" />` : ""}</td>
      <td><a href="${playerHref(p.playerId)}">${p.name}</a>${p.isCaptain ? ' <span class="cap">C</span>' : ""}</td>
      <td>${mainRole(p)}</td>
      <td>${extraRoles(p)}</td>
      <td>${p.age ?? "—"}</td>
      <td>${formatMoney(p.marketValueEur)}</td>
      <td>${p.contractUntil || "—"}</td>`;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      location.href = playerHref(p.playerId);
    });
    body.appendChild(tr);
  }
  dialog.showModal();
}

async function openGame(gameId) {
  const res = await fetch(`/api/games/${gameId}`);
  if (!res.ok) return;
  const data = await res.json();
  const g = data.game;
  const score =
    g.homeScore != null && g.awayScore != null ? `${g.homeScore} : ${g.awayScore}` : "vs";
  document.getElementById("game-title").textContent =
    `${g.homeClubName || g.homeClubId} ${score} ${g.awayClubName || g.awayClubId}`;
  document.getElementById("game-meta").textContent =
    `${g.competitionName || g.competitionId || "—"}` +
    (g.competitionId && g.competitionName && g.competitionName !== g.competitionId
      ? ` (${g.competitionId})`
      : "") +
    ` · тур ${g.gameDay ?? (g.source === "af" ? "предсезон" : "—")} · ${formatDate(g.dateUtc)}` +
    (g.status ? ` · ${g.status}` : "") +
    (g.homeTactic || g.awayTactic ? ` · ${g.homeTactic || "?"} / ${g.awayTactic || "?"}` : "") +
    (g.source === "af" ? " · API Football" : "");

  const byClub = new Map();
  for (const row of data.lineup || []) {
    if (!byClub.has(row.clubId)) byClub.set(row.clubId, { starters: [], bench: [] });
    (row.isStarter ? byClub.get(row.clubId).starters : byClub.get(row.clubId).bench).push(row);
  }

  const events = (data.events || [])
    .map((e) => {
      const link = (id, name) =>
        id ? `<a href="${playerHref(id)}">${name || id}</a>` : name || "—";
      let body = "";
      if (e.eventType === "substitutes") {
        body = `${link(e.passivePlayerId, e.passivePlayerName)} ↑ · ${link(e.activePlayerId, e.activePlayerName)} ↓`;
      } else if (e.eventType === "goals") {
        body =
          link(e.activePlayerId, e.activePlayerName) +
          (e.passivePlayerId || e.passivePlayerName
            ? ` <span class="muted">(п.а. ${link(e.passivePlayerId, e.passivePlayerName)})</span>`
            : "") +
          (e.reasonLabel ? ` <span class="muted">· ${e.reasonLabel}</span>` : "");
      } else if (e.eventType === "cards") {
        body =
          link(e.activePlayerId, e.activePlayerName) +
          (e.reasonLabel ? ` <span class="muted">· ${e.reasonLabel}</span>` : "");
      } else {
        body = e.summary || e.eventLabel || e.eventType;
      }
      return `<li class="event-row">
        <span class="event-min">${e.minuteLabel ?? e.minute ?? "?"}′</span>
        <span class="event-ico" aria-hidden="true">${e.icon || "•"}</span>
        <span class="event-body">
          <strong>${e.eventLabel || e.eventType}</strong> — ${body}
          ${e.clubName ? ` <span class="muted">· ${e.clubName}</span>` : ""}
        </span>
      </li>`;
    })
    .join("");

  const clubsHtml = [...byClub.entries()]
    .map(([clubId, pack]) => {
      const name =
        clubId === g.homeClubId ? g.homeClubName || clubId : g.awayClubName || clubId;
      const starters = pack.starters
        .map(
          (p) =>
            `<li><a href="${playerHref(p.playerId)}">${p.shirtNumber ?? ""} ${p.playerName}</a> <em>${p.positionLabel || ""}</em></li>`,
        )
        .join("");
      const bench = pack.bench
        .map(
          (p) =>
            `<li><a href="${playerHref(p.playerId)}">${p.shirtNumber ?? ""} ${p.playerName}</a></li>`,
        )
        .join("");
      return `<div class="game-side"><h3>${name}</h3><h4>Старт</h4><ul>${starters || "<li>—</li>"}</ul><h4>Запас</h4><ul>${bench || "<li>—</li>"}</ul></div>`;
    })
    .join("");

  const emptyLineupNote = !clubsHtml && g.lineupNote ? `<p class="meta">${g.lineupNote}</p>` : "";
  const eventsBlock =
    events ||
    `<li>${g.isFinished ? "Событий в API Football нет" : "Нет данных (матч ещё не сыгран)"}</li>`;

  document.getElementById("game-body").innerHTML =
    `${clubsHtml || emptyLineupNote}<div class="game-side events-side"><h3>События</h3><ul class="event-list">${eventsBlock}</ul></div>`;
  gameDialog.showModal();
}

function fillCompetitionSelect(viewName = currentPageName()) {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  const builderMode = viewName === "builder";
  let options = builderMode ? builderSelectCompetitions() : competitions.slice();
  if (!options.length) {
    sel.innerHTML = `<option value="${activeCompetitionId}">${activeCompetitionId}</option>`;
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId)) {
    const fromParam = new URLSearchParams(location.search).get("league");
    const extra =
      competitionResolve.find((c) => c.id === activeCompetitionId) ||
      XI_LEAGUES.find((l) => l.tmCompetition === activeCompetitionId) ||
      builderLeaguesCatalog.find((l) => l.tmCompetition === activeCompetitionId);
    if ((fromParam || builderMode) && extra) {
      options = options.concat([
        {
          id: extra.tmCompetition || extra.id,
          name: extra.name || extra.slug || activeCompetitionId,
          seasonId: extra.defaultSeason,
        },
      ]);
    } else {
      activeCompetitionId = options[0].id;
    }
  }
  sel.innerHTML = options
    .map((c) => {
      const pending = !builderMode && c.pending ? " · sync…" : "";
      const season = !builderMode && c.seasonId ? ` · ${c.seasonId}` : "";
      return `<option value="${c.id}">${c.name}${season}${pending}</option>`;
    })
    .join("");
  sel.value = activeCompetitionId;
  const titleName =
    options.find((c) => c.id === activeCompetitionId)?.name ||
    competitions.find((c) => c.id === activeCompetitionId)?.name;
  document.title = `${viewName} · ${tr(titleName || activeCompetitionId)} · Mantra Helper`;
}

async function loadCompetitionData(competitionId, { silent = false } = {}) {
  activeCompetitionId = competitionId;
  localStorage.setItem("tmCompetition", competitionId);
  statusEl.textContent = `Загрузка ${competitionId}…`;

  const work = async () => {
    const [compRes, playersRes, gamesRes] = await Promise.all([
      fetch(`/api/competition/${encodeURIComponent(competitionId)}`),
      fetch(`/api/players?competition=${encodeURIComponent(competitionId)}`),
      fetch(`/api/games?competition=${encodeURIComponent(competitionId)}`),
    ]);
    if (!compRes.ok) throw new Error(`competition HTTP ${compRes.status}`);

    const compData = await compRes.json();
    const playersData = await playersRes.json();
    const gamesData = await gamesRes.json();

    competition = compData.competition;
    clubs = compData.clubs || [];
    players = playersData.players || [];
    games = gamesData.games || [];

    fillClubSelects();
    fillMatchCompFilter();
    fillCompetitionSelect();
    renderLeague();
    renderClubs();
    renderPlayers();
    renderMatches();
    refreshSyncProgress();

    statusEl.textContent = `${competitionId} · ${clubs.length} клубов · ${players.length} игроков · ${games.length} матчей · ${refCategories.length} справочников`;
  };
  if (silent) return work();
  return withContentLoading(work);
}

export async function start(page = currentPageName()) {
  showContentLoading();
  try {
    pageHooks.onAccountChanged = () => {
      const myTeams = document.getElementById("builder-my-teams");
      if (myTeams) {
        myTeams.disabled = !accountState.authenticated || !accountState.user?.mantraManagerId;
        if (myTeams.disabled) myTeams.checked = false;
      }
      renderBuilderSaveControls();
    };
    pageHooks.onAccountChanged();
    await Promise.all([
      loadXiLeaguesFromApi(),
      page === "builder" ? loadBuilderLeaguesFromApi() : Promise.resolve(),
      loadAccount(),
    ]);
    const [compsRes, refRes] = await Promise.all([
      fetch("/api/competitions"),
      page === "ref" ? fetch("/api/ref") : Promise.resolve({ ok: false, json: async () => ({ categories: [] }) }),
    ]);
    const compsData = compsRes.ok ? await compsRes.json() : { competitions: [] };
    const refData = refRes.ok ? await refRes.json() : { categories: [] };
    competitions = compsData.competitions || [];
    competitionResolve = compsData.resolve || [];
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
    } else if (page === "builder") {
      if (statusEl) {
        statusEl.hidden = true;
        statusEl.textContent = "";
      }
      setView("builder");
    } else {
      await loadCompetitionData(activeCompetitionId);
      if (page === "xi" || page === "players" || page === "matches") {
        setView(page);
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Ошибка: ${err.message}. Сначала npm run sync:tm / sync:expand`;
  } finally {
    hideContentLoading();
  }
}

document.getElementById("club-sort")?.addEventListener("change", renderClubs);
for (const id of ["player-club", "player-pos", "player-q", "player-comp-filter"]) {
  document.getElementById(id)?.addEventListener("input", renderPlayers);
  document.getElementById(id)?.addEventListener("change", renderPlayers);
}
for (const id of ["match-club", "match-comp", "match-status"]) {
  document.getElementById(id)?.addEventListener("change", renderMatches);
}
document.getElementById("ref-category")?.addEventListener("change", renderRef);
document.getElementById("ref-q")?.addEventListener("input", renderRef);
document.getElementById("competition-select")?.addEventListener("change", (e) => {
  const nextId = e.target.value;
  if (currentPageName() === "builder") {
    activeCompetitionId = nextId;
    localStorage.setItem("tmCompetition", nextId);
    fillBuilderCompetitionSelect();
    resetBuilderState({ catalog: true });
    syncBuilderHash();
    ensureBuilderLoaded().catch((err) => {
      const meta = document.getElementById("builder-meta");
      if (meta) meta.textContent = `Ошибка: ${err.message}`;
    });
    return;
  }
  loadCompetitionData(nextId)
    .then(() => {
      fillXiSeasonSelect();
      if (currentPageName() === "xi") {
        xiSelectedTeamId = null;
        xiPendingTeamParam = null;
        managerSelectedTeamId = null;
        fantasyTeamsAll = [];
        xiLoadedKey = "";
        syncXiHash();
        return ensureXiLoaded();
      }
    })
    .catch((err) => {
      statusEl.textContent = `Ошибка: ${err.message}`;
    });
});
document.getElementById("sync-restart")?.addEventListener("click", () => {
  restartExpandSync();
});
document.getElementById("xi-season")?.addEventListener("change", () => {
  xiLoadedKey = "";
  ensureXiLoaded();
});
document.getElementById("xi-mode")?.addEventListener("change", (e) => {
  xiMode = e.target.value === "manager" ? "manager" : "clubs";
  applyXiModeUi();
  xiLoadedKey = "";
  ensureXiLoaded();
});
document.getElementById("xi-mantra-league")?.addEventListener("change", () => {
  xiLoadedKey = "";
  ensureXiLoaded();
});
document.getElementById("xi-mantra-formation")?.addEventListener("change", (e) => {
  if (!managerView) return;
  managerFormationId = e.target.value || null;
  renderManagerView(managerView, managerFormationId);
});
document.getElementById("xi-mantra-round")?.addEventListener("change", (e) => {
  const n = Number(e.target.value);
  managerRoundNum = Number.isFinite(n) ? n : null;
  if (managerSelectedTeamId != null) selectManagerTeam(managerSelectedTeamId);
});
document.getElementById("account-login")?.addEventListener("click", (e) => {
  if (googleSignInEnabled(accountState)) return;
  e.preventDefault();
  alert(tr("Google-вход ещё не настроен на сервере."));
});
document.getElementById("account-button")?.addEventListener("click", async () => {
  document.getElementById("account-message").textContent = "";
  await loadAccount();
  document.getElementById("account-dialog").showModal();
});
document.getElementById("sorare-private-open")?.addEventListener("click", () => {
  if (!accountState.authenticated) {
    if (accountState.googleConfigured) {
      location.href = "/auth/google";
    } else {
      alert(tr("Google-вход ещё не настроен на сервере."));
    }
    return;
  }
  document.getElementById("account-message").textContent = "";
  document.getElementById("account-si-connect").hidden = false;
  document.getElementById("account-dialog").showModal();
});
document.getElementById("account-si-generate")?.addEventListener("click", async () => {
  const message = document.getElementById("account-message");
  const codeWrap = document.getElementById("account-si-code-wrap");
  const codeElement = document.getElementById("account-si-code");
  const expiry = document.getElementById("account-si-code-expiry");
  message.textContent = "Создание кода…";
  try {
    const data = await apiJson("/api/me/sorareinside/import-code", {
      method: "POST",
    });
    codeElement.textContent = data.code;
    expiry.textContent = `Код действует до ${formatUiDateTime(
      new Date(data.expiresAt).toISOString(),
    )} и только для одной загрузки.`;
    codeWrap.hidden = false;
    message.textContent = "Код готов — вставь его в панель Mantra import на sorare.com";
  } catch (error) {
    message.textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("account-si-disconnect")?.addEventListener("click", async () => {
  const message = document.getElementById("account-message");
  message.textContent = "Очистка импорта…";
  try {
    const data = await apiJson("/api/me/sorareinside", { method: "DELETE" });
    accountState.sorareInside = data.connection;
    renderAccount();
    message.textContent = "Импортированные прогнозы удалены";
  } catch (error) {
    message.textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("account-save")?.addEventListener("click", async () => {
  const message = document.getElementById("account-message");
  const input = document.getElementById("account-manager-id");
  const locale = document.getElementById("account-locale").value;
  const timeZone = document.getElementById("account-time-zone").value;
  message.textContent = "Сохранение…";
  try {
    const data = await apiJson("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mantraManagerId: input.value.trim() || null,
        locale,
        timeZone,
      }),
    });
    accountState.user = data.user;
    setUiPreferences({ locale: data.user.locale, timeZone: data.user.timeZone });
    builderMyTeamsKey = "";
    builderMyTeams = [];
    renderAccount();
    message.textContent = tr("Настройки сохранены");
  } catch (error) {
    message.textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("account-logout")?.addEventListener("click", async () => {
  try {
    await apiJson("/api/logout", { method: "POST" });
    accountState = {
      authenticated: false,
      googleConfigured: accountState.googleConfigured,
      user: null,
      sorare: accountState.sorare,
      sorareInside: {
        enabled: true,
        connected: false,
        status: "empty",
        count: 0,
      },
    };
    builderMyTeamsKey = "";
    builderMyTeams = [];
    builderSavedSquads = [];
    document.getElementById("account-dialog").close();
    renderAccount();
    fillBuilderSavedSelect();
    if (currentPageName() === "builder") {
      fillBuilderTeamSelect();
      renderBuilder();
    }
  } catch (error) {
    document.getElementById("account-message").textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("builder-competition")?.addEventListener("change", (e) => {
  const main = document.getElementById("competition-select");
  main.value = e.target.value;
  main.dispatchEvent(new Event("change"));
});
document.getElementById("builder-my-teams")?.addEventListener("change", async (e) => {
  if (e.target.checked && !accountState.user?.mantraManagerId) {
    e.target.checked = false;
    if (accountState.authenticated) {
      document.getElementById("account-message").textContent =
        "Сначала укажи Mantra Manager ID";
      document.getElementById("account-dialog").showModal();
    }
    return;
  }
  resetBuilderState();
  try {
    if (e.target.checked) await loadBuilderMyTeams();
    const teamId = fillBuilderTeamSelect();
    if (teamId != null) {
      await loadBuilderTeam(teamId);
    } else {
      renderBuilder();
      document.getElementById("builder-meta").textContent = e.target.checked
        ? "В этой лиге не найдены твои команды"
        : "В этой лиге нет команд";
    }
  } catch (error) {
    e.target.checked = false;
    fillBuilderTeamSelect();
    document.getElementById("builder-meta").textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("builder-refresh-auctions")?.addEventListener("click", () => {
  refreshBuilderAuctions().catch((error) => {
    const meta = document.getElementById("builder-meta");
    if (meta) meta.textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("builder-league")?.addEventListener("change", () => {
  resetBuilderState();
  loadBuilderAuctionCooldown();
  const teamId = fillBuilderTeamSelect();
  if (teamId != null) {
    loadBuilderTeam(teamId).catch((err) => {
      document.getElementById("builder-meta").textContent = `Ошибка: ${err.message}`;
    });
  } else {
    renderBuilder();
    document.getElementById("builder-meta").textContent = "В этой лиге нет команд";
  }
});
document.getElementById("builder-team")?.addEventListener("change", (e) => {
  if (!e.target.value) return;
  const teamId = Number(e.target.value);
  if (!Number.isFinite(teamId)) return;
  loadBuilderTeam(teamId).catch((err) => {
    document.getElementById("builder-meta").textContent = `Ошибка: ${err.message}`;
  });
});
document.getElementById("builder-formation")?.addEventListener("change", (e) => {
  builderFormationId = e.target.value || null;
  builderAssignments.clear();
  builderAlternatives.clear();
  builderEditingAlternative = false;
  const firstSlot = currentBuilderFormation()?.slots?.[0];
  builderSelectedSlot = firstSlot?.index ?? null;
  renderBuilder();
});
document.getElementById("builder-clear")?.addEventListener("click", () => {
  builderAssignments.clear();
  builderAlternatives.clear();
  builderEditingAlternative = false;
  const firstSlot = currentBuilderFormation()?.slots?.[0];
  builderSelectedSlot = firstSlot?.index ?? null;
  renderBuilder();
});
document.getElementById("builder-download")?.addEventListener("click", () => {
  downloadBuilderPng();
});
document.getElementById("builder-show-alternatives")?.addEventListener("change", () => {
  builderSelectedSlot = null;
  builderEditingAlternative = false;
  renderBuilder();
});
document.getElementById("builder-slot-clear")?.addEventListener("click", () => {
  if (builderSelectedSlot == null) return;
  const targetAssignments =
    document.getElementById("builder-show-alternatives").checked &&
    builderEditingAlternative
      ? builderAlternatives
      : builderAssignments;
  targetAssignments.delete(builderSelectedSlot);
  renderBuilder();
});
document.getElementById("builder-save")?.addEventListener("click", async () => {
  if (!accountState.authenticated || builderTeamId == null || !builderFormationId) return;
  const name = document.getElementById("builder-save-name").value.trim();
  const meta = document.getElementById("builder-save-meta");
  if (!name) {
    meta.textContent = "Укажи название состава";
    return;
  }
  meta.textContent = "Сохранение…";
  try {
    const data = await apiJson("/api/squad-builder/saves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fantasyTeamId: builderTeamId,
        name,
        formation: builderFormationId,
        assignments: Object.fromEntries(builderAssignments),
        alternatives: Object.fromEntries(builderAlternatives),
      }),
    });
    await loadBuilderSavedSquads(data.squad?.id);
    meta.textContent = `Сохранено: ${name}`;
  } catch (error) {
    meta.textContent = `Ошибка: ${error.message}`;
  }
});
document.getElementById("builder-saved")?.addEventListener("change", () => {
  renderBuilderSaveControls();
});
document.getElementById("builder-load-save")?.addEventListener("click", () => {
  const id = Number(document.getElementById("builder-saved").value);
  const saved = builderSavedSquads.find((squad) => Number(squad.id) === id);
  if (!saved || !builderTeamView) return;
  const formation = (builderTeamView.squadFormations || []).find(
    (item) => item.formation === saved.formation,
  );
  if (!formation) {
    document.getElementById("builder-save-meta").textContent =
      "Сохранённая схема больше недоступна";
    return;
  }
  builderFormationId = saved.formation;
  document.getElementById("builder-formation").value = saved.formation;
  builderAssignments.clear();
  builderAlternatives.clear();
  for (const [slotIndex, playerId] of Object.entries(saved.assignments || {})) {
    builderAssignments.set(Number(slotIndex), Number(playerId));
  }
  for (const [slotIndex, playerId] of Object.entries(saved.alternatives || {})) {
    builderAlternatives.set(Number(slotIndex), Number(playerId));
  }
  document.getElementById("builder-show-alternatives").checked =
    builderAlternatives.size > 0;
  builderEditingAlternative = false;
  builderSelectedSlot =
    formation.slots.find((slot) => !builderAssignments.has(slot.index))?.index ??
    formation.slots[0]?.index ??
    null;
  document.getElementById("builder-save-name").value = saved.name;
  document.getElementById("builder-save-meta").textContent = `Загружено: ${saved.name}`;
  renderBuilder();
});
document.getElementById("builder-delete-save")?.addEventListener("click", async () => {
  const id = Number(document.getElementById("builder-saved").value);
  const saved = builderSavedSquads.find((squad) => Number(squad.id) === id);
  if (!saved || !confirm(`${tr("Удалить состав")} «${saved.name}»?`)) return;
  const meta = document.getElementById("builder-save-meta");
  try {
    await apiJson(`/api/squad-builder/saves/${id}`, { method: "DELETE" });
    await loadBuilderSavedSquads();
    meta.textContent = `Удалено: ${saved.name}`;
  } catch (error) {
    meta.textContent = `Ошибка: ${error.message}`;
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !accountState.authenticated) return;
  await loadAccount();
});
