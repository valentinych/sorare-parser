import {
  accountState,
  apiJson,
  esc,
  formatUiDateTime,
  pageHooks,
  tr,
  withContentLoading,
} from "../core.js?v=11";
import { nextToggleSort } from "../premium-sort.js?v=5";

const LEAGUE_SLUGS = [
  "ekstraklasa",
  "serie-a",
  "bundesliga",
  "premier-league",
  "championship",
  "super-lig",
  "ligue-1",
  "la-liga",
  "eredivisie",
  "jupiler-pro-league",
  "primeira-liga",
  "upl",
  "mls",
  "brasileirao",
  "managers",
];
const LEAGUE_LABELS = {
  ekstraklasa: "Ekstraklasa",
  "serie-a": "Serie A",
  bundesliga: "Bundesliga",
  "premier-league": "Premier League",
  championship: "Championship",
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
const SORT_KEYS = new Set([
  "rank",
  "managerName",
  "games",
  "clubs",
  "wins",
  "draws",
  "loses",
  "gf",
  "ga",
  "gd",
  "points",
  "iGf",
  "gfDiff",
  "iGa",
  "iGd",
  "iPts",
  "ptsDiff",
  "ts",
  "idealTs",
  "idealPct",
]);

const SORT_IDEAL_KEYS = new Set(["wins", "draws", "loses", "gf", "ga", "gd", "points", "ts", "avgTs"]);
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

/** @type {any} */
let payload = null;
/** @type {any} */
let idealPayload = null;
let selectedLeague = "championship";
let selectedDivision = "";
let selectedManager = "";
let fillingSelect = false;
let fillingDivision = false;
let fillingManager = false;
let bound = false;
let fetchGen = 0;
let idealFetchGen = 0;
let progressGen = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let progressTimer = null;
/** @type {{ key: string, dir: "asc" | "desc" }} */
let sort = { key: "points", dir: "desc" };
/** @type {{ key: string, dir: "asc" | "desc" }} */
let idealSort = { key: "points", dir: "desc" };
/** @type {Set<number>} */
let myTeamIds = new Set();
let myTeamsGen = 0;

function isManagersMode() {
  return selectedLeague === "managers";
}

function leagueFromSearch(search = location.search) {
  const raw = new URLSearchParams(search).get("league");
  if (!raw) return "";
  const slug = String(raw).trim().toLowerCase();
  return LEAGUE_SLUGS.includes(slug) ? slug : "";
}

function managerFromSearch(search = location.search) {
  return String(new URLSearchParams(search).get("manager") || "").trim();
}

function divisionFromSearch(search = location.search) {
  return String(new URLSearchParams(search).get("division") || "").trim();
}

function divisionOptions() {
  return payload?.divisionOptions?.length
    ? payload.divisionOptions
    : idealPayload?.divisions || [];
}

function syncLeagueUrl() {
  const qs = new URLSearchParams();
  if (selectedLeague) qs.set("league", selectedLeague);
  if (isManagersMode()) {
    if (selectedManager) qs.set("manager", selectedManager);
  } else if (selectedDivision) {
    qs.set("division", selectedDivision);
  }
  const next = qs.toString() ? `/tables?${qs}` : "/tables";
  const cur = `${location.pathname}${location.search}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}

function dropStaleDivision() {
  if (!selectedDivision) return false;
  const options = divisionOptions();
  if (!options.length) return false;
  if (options.some((item) => item.code === selectedDivision)) return false;
  selectedDivision = "";
  return true;
}

function fillCompetitionSelect() {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  const leagues = payload?.leagues?.length
    ? payload.leagues.slice()
    : LEAGUE_SLUGS.map((slug) => ({ slug, name: LEAGUE_LABELS[slug] }));
  if (!leagues.some((item) => item.slug === "managers")) {
    leagues.push({ slug: "managers", name: "Менеджеры" });
  }
  const nextHtml = leagues
    .map((item) => {
      const slug = item.slug;
      const label =
        slug === "managers" ? tr("Менеджеры") : LEAGUE_LABELS[slug] || item.name || slug;
      return `<option value="${esc(slug)}">${esc(label)}</option>`;
    })
    .join("");
  fillingSelect = true;
  sel.innerHTML = nextHtml;
  sel.value = selectedLeague;
  setTimeout(() => {
    fillingSelect = false;
  }, 0);
}

function fillDivisionSelect() {
  const sel = document.getElementById("ideal-division-select");
  if (!sel) return;
  const options = divisionOptions();
  const nextHtml = [
    `<option value="">${esc(tr("Выберите дивизион"))}</option>`,
    ...options.map((item) => {
      const label = item.label || (item.code && item.name ? `${item.code} | ${item.name}` : item.code);
      return `<option value="${esc(item.code)}">${esc(label)}</option>`;
    }),
  ].join("");
  fillingDivision = true;
  sel.innerHTML = nextHtml;
  sel.value = selectedDivision;
  setTimeout(() => {
    fillingDivision = false;
  }, 0);
}

function dropStaleManager() {
  if (!selectedManager) return false;
  const rows = payload?.rows || [];
  if (!rows.length) return false;
  if (rows.some((row) => row.managerId === selectedManager)) return false;
  selectedManager = "";
  return true;
}

function managerSelectLabel(row) {
  const name = String(row?.managerName || "").trim();
  const teamName = String(row?.teams?.[0]?.teamName || "").trim();
  if (!teamName) return name;
  if (!name) return teamName;
  return `${name} (${teamName})`;
}

function fillManagerSelect() {
  const sel = document.getElementById("managers-select");
  if (!sel) return;
  const rows = (payload?.rows || []).slice().sort((a, b) => {
    const aMine = (a.teamIds || []).some((id) => myTeamIds.has(Number(id)));
    const bMine = (b.teamIds || []).some((id) => myTeamIds.has(Number(id)));
    if (aMine !== bMine) return aMine ? -1 : 1;
    return String(a.managerName || "").localeCompare(String(b.managerName || ""), "en");
  });
  const nextHtml = [
    `<option value="">${esc(tr("Выберите менеджера"))}</option>`,
    ...rows.map((row) => {
      return `<option value="${esc(row.managerId)}">${esc(managerSelectLabel(row))}</option>`;
    }),
  ].join("");
  fillingManager = true;
  sel.innerHTML = nextHtml;
  sel.value = selectedManager;
  setTimeout(() => {
    fillingManager = false;
  }, 0);
}

function paintProgress(progress) {
  const box = document.getElementById("tables-progress");
  if (!box) return;
  if (!progress || progress.complete) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset.status = progress.status === "error" ? "error" : "running";
  const pct = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
  const fill = document.getElementById("tables-progress-fill");
  const pctEl = document.getElementById("tables-progress-pct");
  const label = document.getElementById("tables-progress-label");
  const detail = document.getElementById("tables-progress-detail");
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (label) label.textContent = tr("Загрузка данных лиги");
  if (detail) detail.textContent = progress.label || "";
}

function stopProgressPoll() {
  if (!progressTimer) return;
  clearInterval(progressTimer);
  progressTimer = null;
}

async function loadProgress() {
  if (isManagersMode()) {
    paintProgress(null);
    stopProgressPoll();
    return;
  }
  const generation = ++progressGen;
  const league = selectedLeague;
  try {
    const data = await apiJson(`/api/tables/progress?league=${encodeURIComponent(league)}`);
    if (generation !== progressGen || league !== selectedLeague) return;
    const progress = data.progress;
    paintProgress(progress);
    if (progress && !progress.complete) {
      if (!progressTimer) {
        const extra = Boolean(data.extra);
        progressTimer = setInterval(() => {
          loadProgress();
          if (extra) loadStandings({ silent: true });
        }, 4000);
      }
    } else {
      stopProgressPoll();
    }
  } catch {
    if (generation !== progressGen || league !== selectedLeague) return;
    paintProgress(null);
    stopProgressPoll();
  }
}

function medal(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return "";
}

function formCell(form) {
  return `<span class="standings-form">${(form || [])
    .map((token) => {
      const letter = String(token || "").toUpperCase();
      const cls =
        letter === "W"
          ? "standings-form-w"
          : letter === "L"
            ? "standings-form-l"
            : "standings-form-d";
      return `<span class="${cls}">${esc(letter)}</span>`;
    })
    .join("")}</span>`;
}

function crest(src, name) {
  if (!src) {
    return `<span class="standings-crest-fallback" aria-hidden="true">${esc(
      String(name || "?").slice(0, 1).toUpperCase(),
    )}</span>`;
  }
  return `<img class="standings-crest" src="${esc(src)}" alt="" width="22" height="22" loading="lazy" />`;
}

function managerCell(row) {
  const name = String(row.managerName || "");
  const id = String(row.managerId || "");
  const match = /^u:(\d+)$/.exec(id);
  const label = match
    ? `<a href="https://mantrafootball.org/managers/${match[1]}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
    : `<span>${esc(name)}</span>`;
  return `<span class="standings-team">${crest(row.teamLogo, name)}${label}</span>`;
}

function teamCell(name, logo) {
  return `<span class="standings-team">${crest(logo, name)}<span>${esc(name)}</span></span>`;
}

function tsText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function idealTsText(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(2);
}

function idealPctText(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function avgText(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

/** Per-match average shown ×100 with hundredths. 1.5 → 150.00 */
function avg100Text(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return (Math.round(n * 10000) / 100).toFixed(2);
}

function sortAttr(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (Number.isFinite(n)) return ` data-sort="${n}"`;
  return ` data-sort="${esc(String(value))}"`;
}

function leagueCell(row) {
  const flag = String(row?.flag || "").trim();
  const code = String(row?.division || "").trim();
  const label = [flag, code].filter(Boolean).join("\u00a0");
  return `<td class="managers-only"><span class="standings-league">${esc(label || "—")}</span></td>`;
}

function selectedManagerRow() {
  if (!selectedManager) return null;
  return (payload?.rows || []).find((row) => row.managerId === selectedManager) || null;
}

function idealPctClass(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return "";
  if (pct >= 90) return "ideal-pct-good";
  if (pct >= 75) return "ideal-pct-mid";
  return "ideal-pct-low";
}

function idealRoundsLabel(rounds) {
  const list = (rounds || []).map(String).filter(Boolean);
  if (!list.length) return "";
  const nums = list.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length >= 2) {
    return `${tr("Ideal TS")} · ${tr("завершённые туры")} ${Math.min(...nums)}–${Math.max(...nums)}`;
  }
  return `${tr("Ideal TS")} · ${tr("завершённый тур")} ${list[0]}`;
}

function numVal(row, key) {
  const n = Number(row?.[key]);
  return Number.isFinite(n) ? n : 0;
}

/** Fantasy clubs in cached championship rows. Headcount, not ×100. */
function clubCount(row) {
  const n = Number(row?.clubs);
  if (Number.isFinite(n) && n >= 0) return n;
  if (Array.isArray(row?.teams)) return row.teams.length;
  if (Array.isArray(row?.teamIds)) return row.teamIds.length;
  return 0;
}

function ruCountWord(n, one, few, many) {
  const m100 = Math.abs(Number(n) || 0) % 100;
  const m10 = m100 % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

function teamsCountLabel(n) {
  return tr(`${n} ${ruCountWord(n, "команда", "команды", "команд")}`);
}

function idealStatText(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return String(n);
}

/** GF − iGF. Null when iGF is missing (dash, not 0). */
function gfDiffVal(row) {
  const iGf = sortNum(row, "iGf");
  if (iGf == null) return null;
  const gf = sortNum(row, "gf");
  if (gf == null) return null;
  return gf - iGf;
}

function gfDiffText(row) {
  const n = gfDiffVal(row);
  if (n == null) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function gfDiffClass(row) {
  const n = gfDiffVal(row);
  if (n == null) return "";
  if (n > 0) return "standings-gf-diff is-pos";
  if (n < 0) return "standings-gf-diff is-neg";
  return "standings-gf-diff is-zero";
}

/** POINTS − iPTS. Null when iPTS is missing (dash, not 0). */
function ptsDiffVal(row) {
  const iPts = sortNum(row, "iPts");
  if (iPts == null) return null;
  const points = sortNum(row, "points");
  if (points == null) return null;
  return points - iPts;
}

function ptsDiffText(row) {
  const n = ptsDiffVal(row);
  if (n == null) return "—";
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return n > 0 ? `+${text}` : text;
}

function ptsDiff100Text(row) {
  const n = ptsDiffVal(row);
  if (n == null) return "—";
  const scaled = Math.round(n * 10000) / 100;
  const text = scaled.toFixed(2);
  return scaled > 0 ? `+${text}` : text;
}

function ptsDiffClass(row) {
  const n = ptsDiffVal(row);
  if (n == null) return "";
  if (n > 0) return "standings-gf-diff is-pos";
  if (n < 0) return "standings-gf-diff is-neg";
  return "standings-gf-diff is-zero";
}

function sortNum(row, key) {
  if (key === "gfDiff") return gfDiffVal(row);
  if (key === "ptsDiff") return ptsDiffVal(row);
  if (key === "clubs") return clubCount(row);
  const raw = row?.[key];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function nextManagersSort(current, key) {
  if (current?.key === key) return nextToggleSort(current, key);
  return { key, dir: key === "managerName" ? "asc" : "desc" };
}

function sortRows(rows) {
  const key = SORT_KEYS.has(sort.key) ? sort.key : "points";
  const dir = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === "managerName") {
      const names =
        dir *
        String(a.managerName || "").localeCompare(String(b.managerName || ""), "en");
      if (names) return names;
    } else if (key !== "points") {
      const av = sortNum(a, key);
      const bv = sortNum(b, key);
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      if (av != null && bv != null) {
        const primary = dir * (av - bv);
        if (primary) return primary;
      }
    }
    if (key === "iPts") {
      const gd = dir * (numVal(a, "iGd") - numVal(b, "iGd"));
      if (gd) return gd;
      const gf = dir * (numVal(a, "iGf") - numVal(b, "iGf"));
      if (gf) return gf;
    }
    const pointsDir = key === "points" ? dir : -1;
    const points = pointsDir * (numVal(a, "points") - numVal(b, "points"));
    if (points) return points;
    const tsDir = key === "points" || key === "ts" ? dir : -1;
    const ts = tsDir * (numVal(a, "ts") - numVal(b, "ts"));
    if (ts) return ts;
    return String(a.managerName || a.teamName || "").localeCompare(
      String(b.managerName || b.teamName || ""),
      "en",
    );
  });
}

function syncSortHeaders() {
  for (const th of document.querySelectorAll("#view-tables th.sortable")) {
    const key = th.getAttribute("data-tables-sort") || th.getAttribute("data-managers-sort");
    const active = Boolean(key) && sort.key === key;
    th.classList.toggle("is-sorted", active);
    if (active) {
      th.dataset.dir = sort.dir;
      th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
    } else {
      delete th.dataset.dir;
      th.setAttribute("aria-sort", "none");
    }
  }
}

function setTablesMode() {
  const view = document.getElementById("view-tables");
  if (view) view.dataset.tablesMode = isManagersMode() ? "managers" : "league";
  const combined = document.getElementById("tables-combined-wrap");
  const managersWrap = document.getElementById("managers-wrap");
  const managersPick = document.getElementById("managers-pick");
  const scaleNote = document.getElementById("managers-scale-note");
  if (combined) combined.hidden = isManagersMode();
  if (managersWrap) managersWrap.hidden = !isManagersMode();
  if (managersPick) managersPick.hidden = !isManagersMode();
  if (scaleNote) scaleNote.hidden = !isManagersMode();
}

function managerMine(row) {
  return (row?.teamIds || []).some((id) => myTeamIds.has(Number(id)));
}

function paintManagersTable() {
  const meta = document.getElementById("tables-meta");
  const body = document.getElementById("managers-body");
  const empty = document.getElementById("tables-empty");
  const leagueBody = document.getElementById("tables-body");
  if (leagueBody) leagueBody.innerHTML = "";
  fillManagerSelect();
  if (!body || !meta) return;
  if (!payload) {
    meta.textContent = tr("Загрузка таблицы…");
    body.innerHTML = "";
    if (empty) empty.hidden = true;
    paintIdeal();
    return;
  }
  if (payload.error) {
    meta.textContent = `${tr("Ошибка")}: ${payload.error}`;
    body.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Не удалось загрузить таблицу.");
    }
    paintIdeal();
    return;
  }
  const rows = sortRows(payload.rows || []);
  const cacheLabel =
    payload.cache === "hit"
      ? tr("кэш")
      : payload.cache === "stale"
        ? tr("обновляется")
        : payload.cache
          ? tr("свежие")
          : "";
  meta.textContent = [
    tr("Менеджеры"),
    `${rows.length} ${tr("менеджеров")}`,
    tr("Средние за матч по всем чемпионатам."),
    payload.fetchedAt ? `${tr("снимок")} ${formatUiDateTime(payload.fetchedAt)}` : "",
    cacheLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!rows.length) {
    body.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Нет строк таблицы для менеджеров.");
    }
    paintIdeal();
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = rows
    .map((row, index) => {
      const rank = index + 1;
      const medalMark = medal(rank);
      const mine = managerMine(row);
      return `<tr${
        mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
      }>
        <td class="standings-rank"${sortAttr(row.rank)}>${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rank)}</td>
        <td${sortAttr(row.managerName)}>${managerCell(row)}${
          mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
        }</td>
        <td${sortAttr(row.games)}>${esc(row.games)}</td>
        <td${sortAttr(clubCount(row))}>${esc(clubCount(row))}</td>
        <td${sortAttr(row.wins)}>${esc(avg100Text(row.wins))}</td>
        <td${sortAttr(row.draws)}>${esc(avg100Text(row.draws))}</td>
        <td${sortAttr(row.loses)}>${esc(avg100Text(row.loses))}</td>
        <td${sortAttr(row.gf)}>${esc(avg100Text(row.gf))}</td>
        <td${sortAttr(row.ga)}>${esc(avg100Text(row.ga))}</td>
        <td${sortAttr(row.gd)}>${esc(avg100Text(row.gd))}</td>
        <td class="standings-points"${sortAttr(row.points)}>${esc(avg100Text(row.points))}</td>
        <td${sortAttr(row.iGf)}>${esc(avg100Text(row.iGf))}</td>
        <td${sortAttr(row.iGa)}>${esc(avg100Text(row.iGa))}</td>
        <td${sortAttr(row.iGd)}>${esc(avg100Text(row.iGd))}</td>
        <td class="standings-ipts"${sortAttr(row.iPts)}>${esc(avg100Text(row.iPts))}</td>
        <td class="${ptsDiffClass(row)}"${sortAttr(ptsDiffVal(row))}>${esc(ptsDiff100Text(row))}</td>
        <td${sortAttr(row.ts)}>${esc(avgText(row.ts))}</td>
        <td${sortAttr(row.idealTs)}>${esc(avgText(row.idealTs))}</td>
        <td class="ideal-td-pct ${idealPctClass(row.idealPct)}"${sortAttr(row.idealPct)}>${esc(idealPctText(row.idealPct))}</td>
      </tr>`;
    })
    .join("");
  paintIdeal();
}

function paint() {
  const meta = document.getElementById("tables-meta");
  const body = document.getElementById("tables-body");
  const empty = document.getElementById("tables-empty");
  if (!body || !meta) return;
  setTablesMode();
  fillCompetitionSelect();
  fillDivisionSelect();
  syncSortHeaders();
  if (isManagersMode()) {
    paintManagersTable();
    return;
  }
  const managersBody = document.getElementById("managers-body");
  if (managersBody) managersBody.innerHTML = "";
  if (!payload) {
    meta.textContent = tr("Загрузка таблицы…");
    body.innerHTML = "";
    if (empty) empty.hidden = true;
    paintRealTable();
    return;
  }
  if (payload.error) {
    meta.textContent = `${tr("Ошибка")}: ${payload.error}`;
    body.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Не удалось загрузить таблицу.");
    }
    paintRealTable();
    return;
  }
  const rows = sortRows(payload.rows || []);
  const failed = payload.failedDivisions?.length || 0;
  const cacheLabel =
    payload.cache === "hit"
      ? tr("кэш")
      : payload.cache === "stale"
        ? tr("обновляется")
        : tr("свежие");
  meta.textContent = [
    payload.name || selectedLeague,
    `${rows.length} ${tr("команд")}`,
    `${payload.divisions || 0} ${tr("дивизионов")}`,
    payload.fetchedAt ? `${tr("снимок")} ${formatUiDateTime(payload.fetchedAt)}` : "",
    cacheLabel,
    idealRoundsLabel(payload.idealRounds),
    failed ? `${tr("ошибок")}: ${failed}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (!rows.length) {
    body.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Нет строк таблицы для этого чемпионата.");
    }
    paintRealTable();
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = rows
    .map((row, index) => {
      const rank = index + 1;
      const medalMark = medal(rank);
      const mine = myTeamIds.has(Number(row.teamId));
      return `<tr${
        mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
      }>
        <td class="standings-rank">${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rank)}</td>
        <td>${esc(row.division)}</td>
        <td>${teamCell(row.teamName, row.teamLogo)}${
          mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
        }</td>
        <td>${esc(row.games)}</td>
        <td>${esc(row.wins)}</td>
        <td>${esc(row.draws)}</td>
        <td>${esc(row.loses)}</td>
        <td>${esc(row.gf)}</td>
        <td>${esc(row.ga)}</td>
        <td>${esc(row.gd)}</td>
        <td class="standings-points">${esc(row.points)}</td>
        <td>${esc(idealStatText(row.iGf))}</td>
        <td class="${gfDiffClass(row)}">${esc(gfDiffText(row))}</td>
        <td>${esc(idealStatText(row.iGa))}</td>
        <td>${esc(idealStatText(row.iGd))}</td>
        <td class="standings-ipts">${esc(idealStatText(row.iPts))}</td>
        <td class="${ptsDiffClass(row)}">${esc(ptsDiffText(row))}</td>
        <td>${esc(tsText(row.ts))}</td>
        <td>${esc(idealTsText(row.idealTs))}</td>
        <td class="ideal-td-pct ${idealPctClass(row.idealPct)}">${esc(idealPctText(row.idealPct))}</td>
        <td>${formCell(row.form)}</td>
      </tr>`;
    })
    .join("");
  paintRealTable();
}

async function loadStandings(opts = {}) {
  const generation = ++fetchGen;
  const league = selectedLeague;
  const silent = Boolean(opts.silent);
  paint();
  try {
    const data = silent
      ? await apiJson(`/api/tables?league=${encodeURIComponent(league)}`)
      : await withContentLoading(() =>
          apiJson(`/api/tables?league=${encodeURIComponent(league)}`),
        );
    if (generation !== fetchGen || league !== selectedLeague) return;
    payload = data;
    if (isManagersMode()) {
      if (dropStaleManager()) syncLeagueUrl();
    } else if (dropStaleDivision()) {
      syncLeagueUrl();
    }
    paint();
    if (!silent) {
      if (isManagersMode()) {
        stopProgressPoll();
        paintProgress(null);
      } else {
        loadProgress();
        await loadIdealTable();
      }
    }
  } catch (error) {
    if (generation !== fetchGen || league !== selectedLeague) return;
    payload = { error: error.message, rows: [], leagues: payload?.leagues };
    paint();
  }
}

function bind() {
  if (bound) return;
  bound = true;
  document.getElementById("competition-select")?.addEventListener("change", (event) => {
    if (fillingSelect) return;
    const next = String(event.target.value || "").trim();
    if (!next || next === selectedLeague) return;
    selectedLeague = next;
    sort = { key: "points", dir: "desc" };
    idealSort = { key: "points", dir: "desc" };
    if (isManagersMode()) selectedDivision = "";
    selectedManager = "";
    payload = null;
    idealPayload = null;
    stopProgressPoll();
    paintProgress(null);
    syncLeagueUrl();
    loadStandings();
    loadProgress();
  });
  document.getElementById("tables-refresh")?.addEventListener("click", () => {
    loadStandings();
  });
  document.querySelector("#view-tables > .standings-wrap .standings-table")?.addEventListener("click", (event) => {
    const th = event.target.closest("th.sortable");
    if (!th) return;
    const key = th.getAttribute("data-tables-sort");
    if (!key || !SORT_KEYS.has(key)) return;
    sort =
      sort.key === key
        ? { key, dir: sort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" };
    paint();
  });
  document.getElementById("managers-table")?.addEventListener("click", (event) => {
    const th = event.target.closest("th.sortable");
    if (!th) return;
    const key = th.getAttribute("data-managers-sort");
    if (!key || !SORT_KEYS.has(key)) return;
    sort = nextManagersSort(sort, key);
    paint();
  });
  document.getElementById("managers-select")?.addEventListener("change", (event) => {
    if (fillingManager) return;
    const next = String(event.target.value || "").trim();
    if (next === selectedManager) return;
    selectedManager = next;
    syncLeagueUrl();
    paintIdeal();
  });
  document.getElementById("ideal-division-select")?.addEventListener("change", (event) => {
    if (fillingDivision) return;
    const next = String(event.target.value || "").trim();
    if (next === selectedDivision) return;
    selectedDivision = next;
    idealSort = { key: "points", dir: "desc" };
    syncLeagueUrl();
    loadIdealTable();
  });
  document.getElementById("ideal-tables-table")?.addEventListener("click", (event) => {
    const th = event.target.closest("th.sortable");
    if (!th) return;
    const key = th.getAttribute("data-ideal-sort");
    if (!key || !SORT_IDEAL_KEYS.has(key)) return;
    idealSort =
      idealSort.key === key
        ? { key, dir: idealSort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" };
    paintIdeal();
  });
  document.getElementById("ideal-tour-results-body")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-ideal-match]");
    if (!btn) return;
    const key = btn.getAttribute("data-ideal-match");
    const match = findIdealMatch(key);
    if (match) openIdealMatchDialog(match.row, match.round, match.label);
  });
  document.getElementById("ideal-tour-results-body")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const btn = event.target.closest("[data-ideal-match]");
    if (!btn) return;
    event.preventDefault();
    const key = btn.getAttribute("data-ideal-match");
    const match = findIdealMatch(key);
    if (match) openIdealMatchDialog(match.row, match.round, match.label);
  });
  pageHooks.onAccountChanged = () => {
    loadMyTeams();
  };
  pageHooks.onLoggedOut = () => {
    myTeamsGen += 1;
    myTeamIds = new Set();
    paint();
    paintIdeal();
  };
}

async function loadMyTeams() {
  const generation = ++myTeamsGen;
  if (!accountState.authenticated || !accountState.user?.mantraManagerId) {
    myTeamIds = new Set();
    paint();
    paintIdeal();
    return;
  }
  try {
    const data = await apiJson("/api/me/mantra-teams");
    if (generation !== myTeamsGen) return;
    myTeamIds = new Set(
      (data.teams || [])
        .map((team) => Number(team.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    );
  } catch {
    if (generation !== myTeamsGen) return;
    myTeamIds = new Set();
  }
  paint();
  paintIdeal();
}

export async function start() {
  bind();
  const fromUrl = leagueFromSearch();
  if (fromUrl) selectedLeague = fromUrl;
  selectedDivision = isManagersMode() ? "" : divisionFromSearch();
  selectedManager = isManagersMode() ? managerFromSearch() : "";
  sort = { key: "points", dir: "desc" };
  idealSort = { key: "points", dir: "desc" };
  syncLeagueUrl();
  fillCompetitionSelect();
  fillDivisionSelect();
  loadProgress();
  await Promise.all([loadStandings(), loadMyTeams()]);
}

function formatMantraPts(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}

function sortIdealRows(rows) {
  const key = SORT_IDEAL_KEYS.has(idealSort.key) ? idealSort.key : "points";
  const dir = idealSort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key !== "points") {
      const av = sortNum(a, key);
      const bv = sortNum(b, key);
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      if (av != null && bv != null) {
        const primary = dir * (av - bv);
        if (primary) return primary;
      }
    }
    const pointsDir = key === "points" ? dir : -1;
    const points = pointsDir * (numVal(a, "points") - numVal(b, "points"));
    if (points) return points;
    const tsDir = key === "points" || key === "ts" ? dir : -1;
    const ts = tsDir * (numVal(a, "ts") - numVal(b, "ts"));
    if (ts) return ts;
    return String(a.teamName || "").localeCompare(String(b.teamName || ""), "en");
  });
}

function syncIdealSortHeaders() {
  for (const th of document.querySelectorAll("#ideal-tables-table th.sortable")) {
    const key = th.getAttribute("data-ideal-sort");
    const active = idealSort.key === key;
    th.classList.toggle("is-sorted", active);
    if (active) {
      th.dataset.dir = idealSort.dir;
      th.setAttribute("aria-sort", idealSort.dir === "asc" ? "ascending" : "descending");
    } else {
      delete th.dataset.dir;
      th.setAttribute("aria-sort", "none");
    }
  }
}

function paintIdeal() {
  const meta = document.getElementById("ideal-tables-meta");
  const body = document.getElementById("ideal-tables-body");
  const empty = document.getElementById("ideal-tables-empty");
  const wrap = document.getElementById("ideal-tables-wrap");
  const spoiler = document.getElementById("ideal-tour-results");
  const toursBody = document.getElementById("ideal-tour-results-body");
  fillDivisionSelect();
  syncIdealSortHeaders();
  if (!meta || !body) return;
  if (isManagersMode()) {
    if (spoiler) spoiler.hidden = true;
    if (toursBody) toursBody.innerHTML = "";
    paintManagerTeamTables();
    return;
  }
  if (!selectedDivision) {
    meta.textContent = "";
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (spoiler) spoiler.hidden = true;
    if (toursBody) toursBody.innerHTML = "";
    hideRealTable();
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Выберите дивизион");
    }
    return;
  }
  if (!idealPayload) {
    meta.textContent = tr("Загрузка таблицы…");
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (spoiler) spoiler.hidden = true;
    if (empty) empty.hidden = true;
    paintRealTable();
    return;
  }
  if (idealPayload.error) {
    meta.textContent = `${tr("Ошибка")}: ${idealPayload.error}`;
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (spoiler) spoiler.hidden = true;
    paintRealTable();
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Не удалось загрузить таблицу.");
    }
    return;
  }
  const rows = sortIdealRows(idealPayload.rows || []);
  const cacheLabel =
    idealPayload.cache === "hit"
      ? tr("кэш")
      : idealPayload.cache === "stale"
        ? tr("обновляется")
        : tr("свежие");
  meta.textContent = [
    idealPayload.divisionLabel || selectedDivision,
    `${rows.length} ${tr("команд")}`,
    idealPayload.fetchedAt ? `${tr("снимок")} ${formatUiDateTime(idealPayload.fetchedAt)}` : "",
    cacheLabel,
    (idealPayload.rounds || []).length
      ? `${tr("туры")} ${(idealPayload.rounds || []).join(", ")}`
      : "",
    (idealPayload.missingTours || []).length
      ? `${tr("нет архива туров")}: ${idealPayload.missingTours.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (!rows.length) {
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (spoiler) spoiler.hidden = true;
    if (toursBody) toursBody.innerHTML = "";
    paintRealTable();
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Нет строк таблицы для этого дивизиона.");
    }
    return;
  }
  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = rows
    .map((row, index) => {
      const rank = index + 1;
      const medalMark = medal(rank);
      const mine = myTeamIds.has(Number(row.teamId));
      return `<tr${
        mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
      }>
        <td class="standings-rank">${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rank)}</td>
        ${leagueCell(row)}
        <td>${teamCell(row.teamName, row.teamLogo)}${
          mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
        }</td>
        <td>${esc(row.games)}</td>
        <td>${esc(row.wins)}</td>
        <td>${esc(row.draws)}</td>
        <td>${esc(row.loses)}</td>
        <td>${esc(row.gf)}</td>
        <td>${esc(row.ga)}</td>
        <td>${esc(row.gd)}</td>
        <td class="standings-points">${esc(row.points)}</td>
        <td>${esc(idealTsText(row.ts))}</td>
        <td>${esc(idealTsText(row.avgTs))}</td>
        <td>${formCell(row.form)}</td>
      </tr>`;
    })
    .join("");

  const tours = idealPayload.tours || [];
  if (spoiler) spoiler.hidden = !tours.length;
  if (toursBody) toursBody.innerHTML = tours.map(renderIdealTour).join("");
  paintRealTable();
}

function paintManagerTeamTables() {
  const manager = selectedManagerRow();
  const idealMeta = document.getElementById("ideal-tables-meta");
  const idealBody = document.getElementById("ideal-tables-body");
  const idealEmpty = document.getElementById("ideal-tables-empty");
  const idealWrap = document.getElementById("ideal-tables-wrap");
  const realBlock = document.getElementById("real-tables");
  const realWrap = document.getElementById("real-tables-wrap");
  const realEmpty = document.getElementById("real-tables-empty");
  const realBody = document.getElementById("real-tables-body");
  const realMeta = document.getElementById("real-tables-meta");
  fillManagerSelect();
  if (!manager) {
    if (idealMeta) idealMeta.textContent = "";
    if (idealBody) idealBody.innerHTML = "";
    if (idealWrap) idealWrap.hidden = true;
    hideRealTable();
    if (idealEmpty) {
      idealEmpty.hidden = false;
      idealEmpty.textContent = tr("Выберите менеджера");
    }
    return;
  }
  const teams = manager.teams || [];
  const label = manager.managerName;
  const clubsMeta = teamsCountLabel(clubCount(manager) || teams.length);
  if (idealMeta) {
    idealMeta.textContent = [label, clubsMeta].join(" · ");
  }
  if (realMeta) {
    realMeta.textContent = [label, clubsMeta].join(" · ");
  }
  if (!teams.length) {
    if (idealBody) idealBody.innerHTML = "";
    if (idealWrap) idealWrap.hidden = true;
    if (realBody) realBody.innerHTML = "";
    if (realWrap) realWrap.hidden = true;
    if (realBlock) realBlock.hidden = true;
    if (idealEmpty) {
      idealEmpty.hidden = false;
      idealEmpty.textContent = tr("Нет команд у этого менеджера.");
    }
    if (realEmpty) realEmpty.hidden = true;
    return;
  }
  if (idealEmpty) idealEmpty.hidden = true;
  if (realEmpty) realEmpty.hidden = true;
  if (idealWrap) idealWrap.hidden = false;
  if (realBlock) realBlock.hidden = false;
  if (realWrap) realWrap.hidden = false;
  const idealRows = teams.slice().sort((a, b) => {
    const ar = Number(a.idealRank);
    const br = Number(b.idealRank);
    const aOk = Number.isFinite(ar);
    const bOk = Number.isFinite(br);
    if (aOk && bOk && ar !== br) return ar - br;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return String(a.teamName || "").localeCompare(String(b.teamName || ""), "en");
  });
  const realRows = teams.slice().sort((a, b) => {
    const ar = Number(a.divisionRank);
    const br = Number(b.divisionRank);
    if (Number.isFinite(ar) && Number.isFinite(br) && ar !== br) return ar - br;
    return String(a.teamName || "").localeCompare(String(b.teamName || ""), "en");
  });
  if (idealBody) {
    idealBody.innerHTML = idealRows
      .map((row) => {
        const rank = Number(row.idealRank);
        const hasRank = Number.isFinite(rank) && rank > 0;
        const rankText = hasRank ? String(rank) : "—";
        const medalMark = hasRank ? medal(rank) : "";
        const mine = myTeamIds.has(Number(row.teamId));
        return `<tr${
          mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
        }>
          <td class="standings-rank">${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rankText)}</td>
          ${leagueCell(row)}
          <td>${teamCell(row.teamName, row.teamLogo)}${
            mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
          }</td>
          <td>${esc(idealStatText(row.idealGames))}</td>
          <td>${esc(idealStatText(row.idealWins))}</td>
          <td>${esc(idealStatText(row.idealDraws))}</td>
          <td>${esc(idealStatText(row.idealLoses))}</td>
          <td>${esc(idealStatText(row.iGf))}</td>
          <td>${esc(idealStatText(row.iGa))}</td>
          <td>${esc(idealStatText(row.iGd))}</td>
          <td class="standings-points">${esc(idealStatText(row.iPts))}</td>
          <td>${esc(idealTsText(row.idealTs))}</td>
          <td>${esc(idealTsText(row.idealAvgTs))}</td>
          <td>${formCell(row.idealForm)}</td>
        </tr>`;
      })
      .join("");
  }
  if (realBody) {
    realBody.innerHTML = realRows
      .map((row, index) => {
        const rank = Number(row.divisionRank) || index + 1;
        const medalMark = medal(rank);
        const mine = myTeamIds.has(Number(row.teamId));
        return `<tr${
          mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
        }>
          <td class="standings-rank">${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rank)}</td>
          ${leagueCell(row)}
          <td>${teamCell(row.teamName, row.teamLogo)}${
            mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
          }</td>
          <td>${esc(row.games)}</td>
          <td>${esc(row.wins)}</td>
          <td>${esc(row.draws)}</td>
          <td>${esc(row.loses)}</td>
          <td>${esc(row.gf)}</td>
          <td>${esc(row.ga)}</td>
          <td>${esc(row.gd)}</td>
          <td class="standings-points">${esc(row.points)}</td>
          <td>${esc(tsText(row.ts))}</td>
          <td>${formCell(row.form)}</td>
        </tr>`;
      })
      .join("");
  }
}

function hideRealTable() {
  const block = document.getElementById("real-tables");
  const wrap = document.getElementById("real-tables-wrap");
  const empty = document.getElementById("real-tables-empty");
  const body = document.getElementById("real-tables-body");
  const meta = document.getElementById("real-tables-meta");
  if (block) block.hidden = true;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;
  if (body) body.innerHTML = "";
  if (meta) meta.textContent = "";
}

function selectedDivisionMeta() {
  return (divisionOptions() || []).find((item) => item.code === selectedDivision) || null;
}

function rowInSelectedDivision(row) {
  const meta = selectedDivisionMeta();
  if (meta?.leagueId != null && row?.leagueId != null) {
    return Number(row.leagueId) === Number(meta.leagueId);
  }
  const code = String(row?.division || "");
  if (code === selectedDivision) return true;
  if (meta?.label && code === meta.label) return true;
  return false;
}

function paintRealTable() {
  const block = document.getElementById("real-tables");
  const wrap = document.getElementById("real-tables-wrap");
  const empty = document.getElementById("real-tables-empty");
  const body = document.getElementById("real-tables-body");
  const meta = document.getElementById("real-tables-meta");
  if (!block || !body) return;
  if (isManagersMode()) return;
  if (!selectedDivision) {
    hideRealTable();
    return;
  }
  block.hidden = false;
  const label = selectedDivisionMeta()?.label || selectedDivision;
  if (!payload) {
    if (meta) meta.textContent = tr("Загрузка таблицы…");
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = true;
    return;
  }
  if (payload.error) {
    if (meta) meta.textContent = `${tr("Ошибка")}: ${payload.error}`;
    body.innerHTML = "";
    if (wrap) wrap.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Не удалось загрузить таблицу.");
    }
    return;
  }
  const rows = (payload.rows || [])
    .filter(rowInSelectedDivision)
    .slice()
    .sort((a, b) => {
      const ar = Number(a.divisionRank);
      const br = Number(b.divisionRank);
      if (Number.isFinite(ar) && Number.isFinite(br) && ar !== br) return ar - br;
      return (
        numVal(b, "points") - numVal(a, "points") ||
        numVal(b, "ts") - numVal(a, "ts") ||
        String(a.teamName || "").localeCompare(String(b.teamName || ""), "en")
      );
    });
  const cacheLabel =
    payload.cache === "hit"
      ? tr("кэш")
      : payload.cache === "stale"
        ? tr("обновляется")
        : payload.cache
          ? tr("свежие")
          : "";
  if (meta) {
    meta.textContent = [
      label,
      `${rows.length} ${tr("команд")}`,
      payload.fetchedAt ? `${tr("снимок")} ${formatUiDateTime(payload.fetchedAt)}` : "",
      cacheLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (!rows.length) {
    if (wrap) wrap.hidden = true;
    body.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = tr("Нет строк таблицы для этого дивизиона.");
    }
    return;
  }
  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = rows
    .map((row, index) => {
      const rank = Number(row.divisionRank) || index + 1;
      const medalMark = medal(rank);
      const mine = myTeamIds.has(Number(row.teamId));
      return `<tr${
        mine ? ` class="standings-row-mine" title="${esc(tr("Моя команда"))}"` : ""
      }>
        <td class="standings-rank">${medalMark ? `<span class="standings-medal">${medalMark}</span>` : ""}${esc(rank)}</td>
        ${leagueCell(row)}
        <td>${teamCell(row.teamName, row.teamLogo)}${
          mine ? `<span class="sr-only">${esc(tr("Моя команда"))}</span>` : ""
        }</td>
        <td>${esc(row.games)}</td>
        <td>${esc(row.wins)}</td>
        <td>${esc(row.draws)}</td>
        <td>${esc(row.loses)}</td>
        <td>${esc(row.gf)}</td>
        <td>${esc(row.ga)}</td>
        <td>${esc(row.gd)}</td>
        <td class="standings-points">${esc(row.points)}</td>
        <td>${esc(tsText(row.ts))}</td>
        <td>${formCell(row.form)}</td>
      </tr>`;
    })
    .join("");
}

function goalsBadge(homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) return "";
  const home = Number(homeGoals);
  const away = Number(awayGoals);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return "";
  return `<span class="ideal-tour-goals" title="${esc(tr("голы Ideal XI"))}">${esc(home)}–${esc(away)}</span>`;
}

function realGoalsBadge(homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) {
    return `<span class="ideal-tour-real-score is-unknown" title="${esc(tr("счёт Mantra неизвестен"))}">—</span>`;
  }
  const home = Number(homeGoals);
  const away = Number(awayGoals);
  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return `<span class="ideal-tour-real-score is-unknown" title="${esc(tr("счёт Mantra неизвестен"))}">—</span>`;
  }
  return `<span class="ideal-tour-real-score" title="${esc(tr("реальный счёт Mantra"))}">${esc(home)}–${esc(away)}</span>`;
}

function realMatchLine(match) {
  const tsUnknown = match.home.realTs == null && match.away.realTs == null;
  const goalsUnknown = match.home.realGoals == null || match.away.realGoals == null;
  const tsHtml = tsUnknown
    ? "—"
    : `${esc(formatMantraPts(match.home.realTs))} <span aria-hidden="true">—</span> ${esc(formatMantraPts(match.away.realTs))}`;
  return `<span class="ideal-tour-real">
    <span class="ideal-tour-real-ts" title="${esc(tr("реальный TS"))}">${tsHtml}</span>
    ${tsUnknown && goalsUnknown ? "" : realGoalsBadge(match.home.realGoals, match.away.realGoals)}
  </span>`;
}

function outcomeFromGoals(home, away) {
  if (home == null || away == null || home === "" || away === "") return null;
  const h = Number(home);
  const a = Number(away);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (h > a) return "H";
  if (a > h) return "A";
  return "D";
}

function matchOutcomeClass(match) {
  const ideal = outcomeFromGoals(match?.home?.goals, match?.away?.goals);
  const real = outcomeFromGoals(match?.home?.realGoals, match?.away?.realGoals);
  if (!ideal || !real) return "";
  if (ideal === real) return "";
  if ((ideal === "H" && real === "A") || (ideal === "A" && real === "H")) return " is-outcome-flip";
  if (ideal === "D" || real === "D") return " is-outcome-draw-swing";
  return "";
}

function renderIdealTour(tour) {
  const matches = (tour.matches || [])
    .map((match, index) => {
      const key = `${tour.round}:${index}`;
      const homeWin = match.outcome === "H";
      const awayWin = match.outcome === "A";
      return `<button type="button" class="ideal-tour-match${matchOutcomeClass(match)}" data-ideal-match="${esc(key)}" tabindex="0">
        <span class="ideal-tour-side${homeWin ? " is-win" : ""}">${esc(match.home.teamName)}</span>
        <span class="ideal-tour-score" title="${esc(tr("Ideal XI"))}">
          ${esc(formatMantraPts(match.home.ts))}
          <span aria-hidden="true">—</span>
          ${esc(formatMantraPts(match.away.ts))}
          ${goalsBadge(match.home.goals, match.away.goals)}
        </span>
        <span class="ideal-tour-side is-away${awayWin ? " is-win" : ""}">${esc(match.away.teamName)}</span>
        ${realMatchLine(match)}
      </button>`;
    })
    .join("");
  return `<article class="ideal-tour-round">
    <h3>${esc(tr("Тур"))} ${esc(tour.round)}${tour.label ? ` · ${esc(tour.label)}` : ""}</h3>
    <div class="ideal-tour-matches">${matches}</div>
  </article>`;
}

function findIdealMatch(key) {
  const [round, indexRaw] = String(key || "").split(":");
  const index = Number(indexRaw);
  const tour = (idealPayload?.tours || []).find((item) => String(item.round) === String(round));
  const row = tour?.matches?.[index];
  if (!row) return null;
  return { row, round: tour.round, label: tour.label };
}

async function loadIdealTable() {
  if (isManagersMode()) {
    paintIdeal();
    return;
  }
  const generation = ++idealFetchGen;
  const league = selectedLeague;
  const division = selectedDivision;
  if (!division) {
    idealPayload = null;
    paintIdeal();
    return;
  }
  paintIdeal();
  try {
    const data = await withContentLoading(() =>
      apiJson(
        `/api/tables/ideal?league=${encodeURIComponent(league)}&division=${encodeURIComponent(division)}`,
      ),
    );
    if (generation !== idealFetchGen || league !== selectedLeague || division !== selectedDivision) {
      return;
    }
    idealPayload = data;
    paintIdeal();
  } catch (error) {
    if (generation !== idealFetchGen || league !== selectedLeague || division !== selectedDivision) {
      return;
    }
    idealPayload = { error: error.message, rows: [], tours: [], divisions: idealPayload?.divisions };
    paintIdeal();
  }
}

function mantraPosPill(label) {
  const text = String(label || "").trim();
  if (!text) return "—";
  const tokens = text.split("/").map((t) => t.trim().toUpperCase()).filter(Boolean);
  let bg = "#737373";
  if (tokens.length === 1) {
    bg = MANTRA_POS_COLOR[tokens[0]] || bg;
  } else if (tokens.length > 1) {
    const step = 100 / tokens.length;
    const stops = tokens
      .map((t, i) => {
        const c = MANTRA_POS_COLOR[t] || "#737373";
        return `${c} ${(i * step).toFixed(2)}%, ${c} ${((i + 1) * step).toFixed(2)}%`;
      })
      .join(", ");
    bg = `linear-gradient(to right, ${stops})`;
  }
  return `<span class="mantra-pos-pill" style="background:${bg}">${esc(text)}</span>`;
}

function formatMantraScoreIcons(events) {
  if (!events?.length) return "";
  const icon = (ev) => {
    const n = ev.count > 1 ? `<sup>${ev.count}</sup>` : "";
    const sign = ev.delta > 0 ? `+${ev.delta}` : String(ev.delta);
    const title = `${ev.key} ${sign}`;
    switch (ev.key) {
      case "goal":
        return `<span class="mantra-ico" title="${esc(title)}">⚽${n}</span>`;
      case "assist":
        return `<span class="mantra-ico mantra-ico-a" title="${esc(title)}">A${n}</span>`;
      case "cs":
        return `<span class="mantra-ico" title="${esc(title)}">🔒</span>`;
      case "yc":
        return `<span class="mantra-ico" title="${esc(title)}">🟨${n}</span>`;
      case "rc":
        return `<span class="mantra-ico" title="${esc(title)}">🟥${n}</span>`;
      case "og":
        return `<span class="mantra-ico" title="${esc(title)}">⚽↩${n}</span>`;
      case "gc":
        return `<span class="mantra-ico" title="${esc(title)}">🥅${n}</span>`;
      case "saves":
        return `<span class="mantra-ico" title="${esc(title)}">🧤${n}</span>`;
      case "pen":
        return `<span class="mantra-ico" title="${esc(title)}">⚽🅿️${n}</span>`;
      case "penSave":
        return `<span class="mantra-ico" title="${esc(title)}">🧤🅿️${n}</span>`;
      case "penWon":
        return `<span class="mantra-ico" title="${esc(title)}">🅿️↑${n}</span>`;
      case "penConc":
        return `<span class="mantra-ico" title="${esc(title)}">🅿️↓${n}</span>`;
      case "penMiss":
        return `<span class="mantra-ico" title="${esc(title)}">🅿️✕${n}</span>`;
      case "oop":
        return `<span class="mantra-ico mantra-ico-oop" title="${esc(title)}">OoP</span>`;
      default:
        return "";
    }
  };
  return `<span class="mantra-icos">${events.map(icon).join("")}</span>`;
}

function idealPlayerSurname(p) {
  const mantraName = String(p?.name || "").trim();
  if (mantraName) return mantraName;
  const display = String(p?.displayName || "").trim();
  if (!display) return "—";
  const parts = display.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || display;
}

function idealXiTableRows(players) {
  return (players || [])
    .map((p) => {
      const native = (p.positions || []).join("/") || "—";
      const icons = formatMantraScoreIcons(p.events);
      const label = idealPlayerSurname(p);
      return `<tr>
        <td class="dream-td-native">${mantraPosPill(native)}</td>
        <td class="dream-td-player">
          <div class="dream-team-name">${esc(label)}</div>
          <div class="muted dream-team-club">${esc(p.clubName || "—")}</div>
        </td>
        <td class="dream-td-slot">${mantraPosPill(p.slotLabel)}</td>
        <td class="num dream-td-bs"><span class="dream-mobile-lab">BS</span>${esc(formatMantraPts(p.baseScore))}</td>
        <td class="num dream-team-ts dream-td-ts"><span class="dream-mobile-lab">TS</span>${esc(formatMantraPts(p.totalScore))}</td>
        <td class="dream-team-icos dream-td-icos">${icons}</td>
      </tr>`;
    })
    .join("");
}

function openIdealMatchDialog(match, round, label) {
  const dialog = document.getElementById("ideal-vs-real-dialog");
  if (!dialog || !match) return;
  document.getElementById("ideal-vs-real-title").textContent =
    `${match.home.teamName} — ${match.away.teamName}`;
  document.getElementById("ideal-vs-real-meta").textContent = [
    label,
    round ? `${tr("Тур")} ${round}` : null,
    tr("клик по строке — сравнение XI"),
  ]
    .filter(Boolean)
    .join(" · ");

  const homeDb = match.home.defenceBonus > 0 ? ` +${match.home.defenceBonus}` : "";
  const awayDb = match.away.defenceBonus > 0 ? ` +${match.away.defenceBonus}` : "";
  document.getElementById("ideal-vs-real-sum").innerHTML = `
    <span>${esc(match.home.teamName)} <strong>${esc(formatMantraPts(match.home.ts))}</strong>${esc(
      homeDb ? ` (${formatMantraPts(match.home.playersTotal)}${homeDb})` : "",
    )}</span>
    <span>${esc(match.away.teamName)} <strong>${esc(formatMantraPts(match.away.ts))}</strong>${esc(
      awayDb ? ` (${formatMantraPts(match.away.playersTotal)}${awayDb})` : "",
    )}</span>
  `;

  const col = (title, meta, players) => `
    <section class="ideal-vs-real-col">
      <h3>${esc(title)}</h3>
      <p class="meta">${esc(meta)}</p>
      <div class="table-wrap dream-team-table-wrap">
        <table class="data-table compact-table dream-team-table">
          <thead>
            <tr>
              <th class="dream-th-native">Pos</th>
              <th>Игрок</th>
              <th class="dream-th-slot">Слот</th>
              <th class="dream-th-bs">BS</th>
              <th class="dream-th-ts">TS</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${idealXiTableRows(players) || `<tr><td colspan="6" class="muted">${esc(tr("Нет данных"))}</td></tr>`}</tbody>
        </table>
      </div>
    </section>`;

  document.getElementById("ideal-vs-real-body").innerHTML =
    col(
      `${match.home.teamName} · Ideal XI`,
      `${match.home.formation || "—"} · ${formatMantraPts(match.home.ts)} ts`,
      match.home.idealXi,
    ) +
    col(
      `${match.away.teamName} · Ideal XI`,
      `${match.away.formation || "—"} · ${formatMantraPts(match.away.ts)} ts`,
      match.away.idealXi,
    );

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
