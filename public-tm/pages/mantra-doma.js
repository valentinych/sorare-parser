import {
  accountState,
  apiJson,
  esc,
  formatUiDateTime,
  tr,
} from "../core.js?v=11";
import { nextToggleSort } from "../premium-sort.js?v=5";

/** MantraFootball position colours (same as Live / Squad Builder). */
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
let playersData = null;
/** @type {Record<string, any>} */
let statsById = {};
/** @type {number[]} */
let statsTours = [];
/** @type {any} */
let applicationsData = null;
/** @type {HTMLElement | null} */
let photoTrigger = null;
/** @type {"players" | "applicants"} */
let activeTab = "players";
/** @type {string} */
let clubFilter = "";
/** @type {string} */
let posFilter = "";
/** @type {string} */
let searchQuery = "";
let filtersBound = false;
let applyBound = false;
let viewBound = false;
/** @type {{ key: string, dir: "asc" | "desc" } | null} */
let listSort = null;

const VIEW_KEY = "mantraDomaView";
const VIEW_VALUES = ["tiles", "list"];

function readStoredView() {
  return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tiles";
}

function currentView() {
  const selected = document.querySelector("#mantra-doma-view [aria-checked='true']");
  const fromDom = selected?.getAttribute("data-mantra-doma-view");
  if (fromDom === "list" || fromDom === "tiles") return fromDom;
  return readStoredView();
}

function applyView(view, { persist = true } = {}) {
  const mode = view === "list" ? "list" : "tiles";
  if (persist) localStorage.setItem(VIEW_KEY, mode);
  document.getElementById("mantra-doma-grid")?.classList.toggle("is-list", mode === "list");
  for (const btn of document.querySelectorAll("#mantra-doma-view [data-mantra-doma-view]")) {
    const selected = btn.getAttribute("data-mantra-doma-view") === mode;
    btn.setAttribute("aria-checked", selected ? "true" : "false");
    btn.setAttribute("aria-pressed", selected ? "true" : "false");
    btn.tabIndex = selected ? 0 : -1;
  }
  if (playersData) renderPlayers();
}

function posPill(pos) {
  const token = String(pos || "").trim().toUpperCase();
  if (!token) return "";
  const bg = MANTRA_POS_COLOR[token] || "#737373";
  return `<span class="mantra-pos-pill" style="background:${bg}">${esc(token)}</span>`;
}

function dash(value) {
  return value == null || value === "" ? "—" : String(value);
}

function ratingBand(rating) {
  if (rating == null || !Number.isFinite(rating)) return "";
  if (rating < 6.5) return "low";
  if (rating >= 7.2) return "high";
  return "mid";
}

function statsFor(row) {
  const id = row?.fotmobPlayerId;
  if (id == null) return null;
  return statsById[String(id)] || null;
}

function sparkline(stats) {
  if (!stats?.bars?.length) {
    return `<span class="mantra-doma-spark is-empty" title="${esc(tr("Нет минут"))}">—</span>`;
  }
  const bars = stats.bars
    .map((minutes, index) => {
      const value = Number(minutes) || 0;
      const pct = Math.max(value > 0 ? 8 : 2, Math.min(100, Math.round((value / 90) * 100)));
      const tour = stats.rnd?.[index];
      const label = tour != null ? `T${tour}: ${value}′` : `${value}′`;
      return `<span class="mantra-doma-spark-bar" style="height:${pct}%" title="${esc(label)}"></span>`;
    })
    .join("");
  return `<div class="mantra-doma-spark" role="img" aria-label="${esc(tr("Минуты по матчам"))}">${bars}</div>`;
}

function extraTitle(stats) {
  if (!stats) return "";
  const bits = [];
  if (stats.last5 != null) bits.push(`${tr("Последние 5")}: ${stats.last5}`);
  if (stats.apps) bits.push(`${tr("Игры")}: ${stats.apps}${stats.st ? ` (${tr("старт")} ${stats.st})` : ""}`);
  if (stats.og) bits.push(`${tr("Автоголы")}: ${stats.og}`);
  if (stats.sv) bits.push(`${tr("Сейвы")}: ${stats.sv}`);
  if (stats.gc) bits.push(`${tr("Пропущено")}: ${stats.gc}`);
  if (stats.psc) bits.push(`${tr("Пенальти")}: ${stats.psc}`);
  if (stats.pmi) bits.push(`${tr("Незабитые пенальти")}: ${stats.pmi}`);
  if (stats.psv) bits.push(`${tr("Отбитые пенальти")}: ${stats.psv}`);
  return bits.join(" · ");
}

function statline(row) {
  const stats = statsFor(row);
  const extra = extraTitle(stats);
  const rating = stats?.rating;
  const ga = stats ? `${stats.g}+${stats.a}` : "—";
  const cards = stats ? `${stats.y}/${stats.red}` : "—";
  return `<div class="mantra-doma-statline"${extra ? ` title="${esc(extra)}"` : ""}>
    ${sparkline(stats)}
    <span class="mantra-doma-num" title="${esc(tr("Минуты"))}">${stats ? stats.min : "—"}</span>
    <span class="mantra-doma-rating${rating != null ? ` is-${ratingBand(rating)}` : ""}" title="${esc(
      stats?.last5 != null ? `${tr("Сезон")} ${dash(rating)} · ${tr("посл. 5")} ${stats.last5}` : tr("Оценка FotMob"),
    )}">${rating != null ? rating.toFixed(1) : "—"}</span>
    <span class="mantra-doma-num" title="${esc(tr("Голы + передачи"))}">${ga}</span>
    <span class="mantra-doma-num" title="${esc(tr("Жёлтые / красные"))}">${cards}</span>
  </div>`;
}

function tourBadges(cell) {
  const bits = [];
  const add = (count, cls, icon, title) => {
    if (!count) return;
    const n = count > 1 ? `<sup>${count}</sup>` : "";
    bits.push(
      `<span class="mantra-ico${cls}" title="${esc(title)}">${icon}${n}</span>`,
    );
  };
  add(cell.g, "", "⚽", tr("Гол"));
  add(cell.a, " mantra-ico-a", "A", tr("пас"));
  add(cell.y, "", "🟨", tr("Жёлтая"));
  add(cell.red, "", "🟥", tr("Красная"));
  return bits.length ? `<span class="mantra-icos">${bits.join("")}</span>` : "";
}

function tourPiece(cell, row) {
  if (cell.minutes == null) {
    return `<div class="mantra-doma-tour is-dnp">—</div>`;
  }
  const rating = cell.rating;
  const pos = cell.pos || (row.mantraPositions || [])[0] || "";
  return `<div class="mantra-doma-tour">
    <span class="mantra-doma-tour-top">
      <span class="mantra-doma-rating${rating != null ? ` is-${ratingBand(rating)}` : ""}">${
        rating != null ? Number(rating).toFixed(1) : "—"
      }</span>
      ${pos ? `<span class="mantra-doma-tour-pos">${esc(pos)}</span>` : ""}
      ${tourBadges(cell)}
    </span>
    <span class="mantra-doma-tour-min">${cell.minutes}′</span>
  </div>`;
}

function tourCellHtml(row, tour) {
  const stats = statsFor(row);
  const cells = (stats?.rounds || []).filter((cell) => cell.round === tour);
  if (!cells.length) return `<td class="mantra-doma-td-tour">—</td>`;
  return `<td class="mantra-doma-td-tour">${cells.map((cell) => tourPiece(cell, row)).join("")}</td>`;
}

const SUM_COLS = [
  { key: "min", label: "Мин", title: "Минуты за сезон" },
  { key: "g", label: "Г", title: "Голы" },
  { key: "a", label: "П", title: "Пасы (ассисты)" },
  { key: "pos", label: "Поз", title: "Самая частая позиция на поле" },
  { key: "rating", label: "FM", title: "Средняя оценка FotMob за сезон", digits: 1 },
  { key: "last5", label: "5", title: "Средняя оценка FotMob за последние 5 матчей", digits: 1 },
  { key: "apps", label: "И", title: "Игры (выходы на поле)" },
  { key: "st", label: "Ст", title: "Старты в основе" },
  { key: "y", label: "Ж", title: "Жёлтые карточки" },
  { key: "red", label: "К", title: "Красные карточки" },
  { key: "og", label: "АГ", title: "Автоголы" },
  { key: "sv", label: "Св", title: "Сейвы" },
  { key: "gc", label: "Пр", title: "Пропущенные голы" },
  { key: "psc", label: "Пен", title: "Забитые пенальти" },
  { key: "pmi", label: "Нп", title: "Незабитые пенальти" },
  { key: "psv", label: "Оп", title: "Отбитые пенальти" },
];

function sumTd(stats, col, first) {
  const cls = `mantra-doma-td-sum${first ? " is-sum-start" : ""}`;
  if (!stats) return `<td class="${cls}">—</td>`;
  if (col.key === "pos") {
    return `<td class="${cls}">${stats.pos ? posPill(stats.pos) : "—"}</td>`;
  }
  const value = stats[col.key];
  if (value == null) return `<td class="${cls}">—</td>`;
  const text = col.digits != null ? Number(value).toFixed(col.digits) : String(value);
  return `<td class="${cls}">${esc(text)}</td>`;
}

function playerHead(row) {
  const crest = row.clubLogoUrl
    ? `<img class="mantra-doma-crest" src="${esc(row.clubLogoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : "";
  return `<div class="mantra-doma-player-cell">
    ${photoBlock(row)}
    <div class="mantra-doma-body">
      <span class="mantra-doma-name">${esc(row.name)}</span>
      <div class="mantra-doma-club">${crest}<span>${esc(row.clubName)}</span></div>
    </div>
  </div>`;
}

function sortableTh(label, key, title, extraClass = "") {
  const active = listSort?.key === key;
  const aria = active ? (listSort.dir === "asc" ? "ascending" : "descending") : "none";
  const sorted = active ? " is-sorted" : "";
  const dirAttr = active ? ` data-dir="${esc(listSort.dir)}"` : "";
  const cls = `${extraClass} sortable${sorted}`.trim();
  return `<th class="${cls}" data-doma-sort="${esc(key)}" title="${esc(title)}" aria-sort="${aria}"${dirAttr}>${label}</th>`;
}

function tourSortValue(stats, tour) {
  const cells = (stats?.rounds || []).filter((cell) => cell.round === tour);
  let best = null;
  for (const cell of cells) {
    if (cell.rating != null && Number.isFinite(Number(cell.rating))) {
      const rating = Number(cell.rating);
      best = best == null ? rating : Math.max(best, rating);
    }
  }
  if (best != null) return best;
  const minutes = cells.map((cell) => cell.minutes).filter((value) => value != null);
  return minutes.length ? Math.max(...minutes) : null;
}

function numericSortValue(row, key) {
  const stats = statsFor(row);
  if (key.startsWith("t:")) {
    return tourSortValue(stats, Number(key.slice(2)));
  }
  if (key === "pos") {
    const pos = stats?.pos || (row.mantraPositions || [])[0] || "";
    return pos || null;
  }
  if (!stats) return null;
  const value = stats[key];
  if (value == null || value === "") return null;
  if (typeof value === "string") return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareNullLast(aValue, bValue, direction, a, b) {
  if (aValue == null || bValue == null) {
    if (aValue == null && bValue == null) {
      return String(a.name || "").localeCompare(String(b.name || ""), "ru");
    }
    return aValue == null ? 1 : -1;
  }
  if (typeof aValue === "string" || typeof bValue === "string") {
    return (
      direction * String(aValue).localeCompare(String(bValue), "ru") ||
      String(a.name || "").localeCompare(String(b.name || ""), "ru")
    );
  }
  return direction * (aValue - bValue) || String(a.name || "").localeCompare(String(b.name || ""), "ru");
}

function sortVisibleRows(rows) {
  if (!listSort?.key) return rows.slice();
  const direction = listSort.dir === "asc" ? 1 : -1;
  const key = listSort.key;
  return rows.slice().sort((a, b) => {
    if (key === "name") {
      return (
        direction * String(a.name || "").localeCompare(String(b.name || ""), "ru") ||
        String(a.clubName || "").localeCompare(String(b.clubName || ""), "ru")
      );
    }
    if (key === "mantraPos") {
      const aPos = (a.mantraPositions || [])[0] || "";
      const bPos = (b.mantraPositions || [])[0] || "";
      return compareNullLast(aPos || null, bPos || null, direction, a, b);
    }
    return compareNullLast(numericSortValue(a, key), numericSortValue(b, key), direction, a, b);
  });
}

function renderPlayersTable(rows) {
  const tours = statsTours;
  const tourHeads = tours
    .map((tour) =>
      sortableTh(
        `T${tour}`,
        `t:${tour}`,
        `${tr("Тур")} ${tour}: ${tr("оценка FotMob, позиция, минуты")}`,
        "mantra-doma-th-tour",
      ),
    )
    .join("");
  const sumHeads = SUM_COLS.map((col, index) =>
    sortableTh(
      esc(tr(col.label)),
      col.key,
      tr(col.title),
      `mantra-doma-th-sum${index === 0 ? " is-sum-start" : ""}`,
    ),
  ).join("");
  const body = sortVisibleRows(rows)
    .map((row) => {
      const stats = statsFor(row);
      const pills = (row.mantraPositions || []).map(posPill).join("") || "—";
      const tourTds = tours.map((tour) => tourCellHtml(row, tour)).join("");
      const sumTds = SUM_COLS.map((col, index) => sumTd(stats, col, index === 0)).join("");
      return `<tr>
        <th scope="row" class="mantra-doma-td-player">${playerHead(row)}</th>
        <td class="mantra-doma-td-pos">${pills}</td>
        ${tourTds}
        ${sumTds}
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap mantra-doma-table-wrap">
    <table class="data-table compact-table mantra-doma-table">
      <thead>
        <tr>
          ${sortableTh(esc(tr("Игрок")), "name", tr("Игрок и клуб"), "mantra-doma-th-player")}
          ${sortableTh(esc(tr("Поз")), "mantraPos", tr("Позиции Mantra"), "mantra-doma-th-pos")}
          ${tourHeads}
          ${sumHeads}
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function photoBlock(row) {
  const fallback = `<span class="mantra-doma-photo-fallback" aria-hidden="true">${esc(initials(row.name))}</span>`;
  if (!row.photoUrl) return `<div class="mantra-doma-photo-wrap">${fallback}</div>`;
  const label = `${tr("Открыть фото")}: ${row.name}`;
  return `<div class="mantra-doma-photo-wrap">
    <button type="button" class="mantra-doma-photo-btn" data-photo-src="${esc(row.photoUrl)}" data-photo-alt="${esc(row.name)}" aria-haspopup="dialog" aria-label="${esc(label)}">
      <img class="mantra-doma-photo" src="${esc(row.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
    </button>
  </div>`;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function visiblePlayers() {
  const q = searchQuery.trim().toLowerCase();
  return (playersData?.players || []).filter((row) => {
    if (clubFilter && row.clubId !== clubFilter) return false;
    if (posFilter && !(row.mantraPositions || []).includes(posFilter)) return false;
    if (!q) return true;
    return `${row.name} ${row.clubName}`.toLowerCase().includes(q);
  });
}

function fillFilters() {
  const clubSelect = document.getElementById("mantra-doma-club");
  if (clubSelect) {
    const selected = clubSelect.value;
    clubSelect.innerHTML =
      `<option value="">${esc(tr("Все клубы"))}</option>` +
      (playersData?.clubs || [])
        .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
        .join("");
    clubSelect.value = selected;
  }

  const posSelect = document.getElementById("mantra-doma-pos");
  if (posSelect) {
    const selected = posSelect.value;
    const positions = [
      ...new Set((playersData?.players || []).flatMap((p) => p.mantraPositions || [])),
    ].sort();
    posSelect.innerHTML =
      `<option value="">${esc(tr("Все позиции"))}</option>` +
      positions.map((pos) => `<option value="${esc(pos)}">${esc(pos)}</option>`).join("");
    posSelect.value = selected;
  }
}

function preferenceLabels(row) {
  const labels = [];
  if (row.wantRegularAuction) labels.push(tr("Обычный аукцион"));
  if (row.wantLiveAuction) labels.push(tr("Живой аукцион"));
  return labels.join(" · ") || "—";
}

function setTab(tab) {
  activeTab = tab === "applicants" ? "applicants" : "players";
  const playersPanel = document.getElementById("mantra-doma-panel-players");
  const applicantsPanel = document.getElementById("mantra-doma-panel-applicants");
  if (playersPanel) playersPanel.hidden = activeTab !== "players";
  if (applicantsPanel) applicantsPanel.hidden = activeTab !== "applicants";
  for (const btn of document.querySelectorAll("#mantra-doma-subtabs [data-mantra-doma-tab]")) {
    const selected = btn.getAttribute("data-mantra-doma-tab") === activeTab;
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  }
}

function renderPlayers() {
  const grid = document.getElementById("mantra-doma-grid");
  const meta = document.getElementById("mantra-doma-meta");
  if (!grid || !meta) return;

  const rows = visiblePlayers();
  const tourMeta = statsTours.length ? ` · ${tr("туров")} ${statsTours.length}` : "";
  meta.textContent = playersData?.empty
    ? tr("Нет игроков с назначенными Mantra-позициями.")
    : `${tr("Показано")} ${rows.length} ${tr("из")} ${playersData?.count ?? 0}` +
      tourMeta +
      (playersData?.syncedAt
        ? ` · ${tr("снимок")} ${formatUiDateTime(playersData.syncedAt)}`
        : "");

  if (!rows.length) {
    grid.innerHTML = `<p class="mantra-doma-empty">${esc(tr("Ничего не найдено"))}</p>`;
    return;
  }

  if (currentView() === "list") {
    grid.innerHTML = renderPlayersTable(rows);
    return;
  }

  grid.innerHTML = rows
    .map((row) => {
      const pills = (row.mantraPositions || []).map(posPill).join("");
      const crest = row.clubLogoUrl
        ? `<img class="mantra-doma-crest" src="${esc(row.clubLogoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : "";
      return `<article class="mantra-doma-card">
        ${photoBlock(row)}
        <div class="mantra-doma-body">
          <h3 class="mantra-doma-name">${esc(row.name)}</h3>
          <div class="mantra-doma-positions">${pills || "—"}</div>
          <div class="mantra-doma-club">${crest}<span>${esc(row.clubName)}</span></div>
        </div>
        ${statline(row)}
      </article>`;
    })
    .join("");
}

function renderApplicants() {
  const list = document.getElementById("mantra-doma-applicants");
  const meta = document.getElementById("mantra-doma-applicants-meta");
  if (!list || !meta) return;

  const rows = applicationsData?.applications || [];
  meta.textContent = `${tr("Заявившихся")}: ${rows.length}`;

  if (!rows.length) {
    list.innerHTML = `<p class="mantra-doma-empty">${esc(tr("Пока никто не заявился"))}</p>`;
    return;
  }

  list.innerHTML = `<div class="table-wrap"><table class="data-table compact-table">
    <thead>
      <tr>
        <th>${esc(tr("Команда"))}</th>
        <th>${esc(tr("Аукционы"))}</th>
        <th>${esc(tr("Игрок"))}</th>
        <th>${esc(tr("Когда"))}</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map((row) => {
          const name = row.userName || "—";
          const avatar = row.userPictureUrl
            ? `<img class="mantra-doma-applicant-avatar" src="${esc(row.userPictureUrl)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer" />`
            : `<span class="mantra-doma-applicant-avatar-fallback" aria-hidden="true">${esc(initials(name))}</span>`;
          const mine = row.isMine
            ? ` <span class="mantra-doma-mine">${esc(tr("вы"))}</span>`
            : "";
          return `<tr>
            <td>${esc(row.teamName)}${mine}</td>
            <td>${esc(preferenceLabels(row))}</td>
            <td><div class="mantra-doma-applicant-user">${avatar}<strong>${esc(name)}</strong></div></td>
            <td>${esc(formatUiDateTime(row.updatedAt || row.createdAt))}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table></div>`;
}

function updateApplyButton() {
  const btn = document.getElementById("mantra-doma-apply");
  if (!btn) return;
  btn.textContent = applicationsData?.mine ? tr("Обновить заявку") : tr("Заявиться");
}

function fillApplyForm() {
  const mine = applicationsData?.mine;
  const team = document.getElementById("mantra-doma-team-name");
  const regular = document.getElementById("mantra-doma-want-regular");
  const live = document.getElementById("mantra-doma-want-live");
  if (team) team.value = mine?.teamName || "";
  if (regular) regular.checked = Boolean(mine?.wantRegularAuction);
  if (live) live.checked = Boolean(mine?.wantLiveAuction);
}

async function loadPlayers() {
  const meta = document.getElementById("mantra-doma-meta");
  if (meta) meta.textContent = tr("Загрузка…");
  try {
    playersData = await apiJson("/api/mantra-doma");
    fillFilters();
    renderPlayers();
  } catch (error) {
    if (meta) meta.textContent = `${tr("Ошибка")}: ${error.message}`;
    const grid = document.getElementById("mantra-doma-grid");
    if (grid) grid.innerHTML = "";
  }
}

async function loadStats() {
  try {
    const data = await apiJson("/api/mantra-doma/stats");
    statsById = data?.players && typeof data.players === "object" ? data.players : {};
    statsTours = Array.isArray(data?.tours) ? data.tours.filter((n) => Number.isFinite(n)) : [];
    if (playersData) renderPlayers();
  } catch {
    statsById = {};
    statsTours = [];
  }
}

function openPhoto(src, alt, trigger) {
  const dialog = document.getElementById("mantra-doma-photo-dialog");
  const img = document.getElementById("mantra-doma-photo-full");
  if (!dialog || !img || !src) return;
  photoTrigger = trigger || null;
  img.src = src;
  img.alt = alt || "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}


async function loadApplications() {
  const meta = document.getElementById("mantra-doma-applicants-meta");
  if (meta) meta.textContent = tr("Загрузка…");
  try {
    applicationsData = await apiJson("/api/mantra-doma/applications");
    updateApplyButton();
    fillApplyForm();
    renderApplicants();
  } catch (error) {
    if (meta) meta.textContent = `${tr("Ошибка")}: ${error.message}`;
    const list = document.getElementById("mantra-doma-applicants");
    if (list) list.innerHTML = "";
  }
}

function openApplyDialog() {
  if (!accountState.authenticated) {
    sessionStorage.setItem("postAuthPath", "/mantra-doma");
    location.href = "/auth/google";
    return;
  }
  fillApplyForm();
  const status = document.getElementById("mantra-doma-apply-status");
  if (status) status.textContent = "";
  document.getElementById("mantra-doma-apply-dialog")?.showModal();
}

async function submitApplication(event) {
  event.preventDefault();
  const status = document.getElementById("mantra-doma-apply-status");
  const teamName = document.getElementById("mantra-doma-team-name")?.value.trim() || "";
  const wantRegularAuction = Boolean(
    document.getElementById("mantra-doma-want-regular")?.checked,
  );
  const wantLiveAuction = Boolean(document.getElementById("mantra-doma-want-live")?.checked);
  if (!teamName) {
    if (status) status.textContent = tr("Укажите название команды");
    return;
  }
  if (!wantRegularAuction && !wantLiveAuction) {
    if (status) status.textContent = tr("Выберите хотя бы один тип аукциона");
    return;
  }
  if (status) status.textContent = tr("Сохранение…");
  try {
    const result = await apiJson("/api/mantra-doma/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamName, wantRegularAuction, wantLiveAuction }),
    });
    const others = (applicationsData?.applications || []).filter(
      (row) => row.userId !== result.application.userId,
    );
    applicationsData = {
      ok: true,
      applications: [result.application, ...others],
      mine: result.application,
    };
    updateApplyButton();
    renderApplicants();
    if (status) status.textContent = tr("Заявка сохранена");
    setTimeout(() => {
      document.getElementById("mantra-doma-apply-dialog")?.close();
      setTab("applicants");
    }, 350);
  } catch (error) {
    const code = error.message || "";
    const friendly =
      code === "auction_preference_required"
        ? tr("Выберите хотя бы один тип аукциона")
        : code === "team_name_required"
          ? tr("Укажите название команды")
          : `${tr("Ошибка")}: ${code}`;
    if (status) status.textContent = friendly;
  }
}

function bindViewToggle() {
  if (viewBound) return;
  viewBound = true;
  const group = document.getElementById("mantra-doma-view");
  if (!group) return;
  group.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-mantra-doma-view]");
    if (!btn) return;
    applyView(btn.getAttribute("data-mantra-doma-view"));
  });
  group.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const values = VIEW_VALUES;
    const idx = Math.max(0, values.indexOf(currentView()));
    let next = idx;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = values.length - 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (idx + values.length - 1) % values.length;
    } else {
      next = (idx + 1) % values.length;
    }
    applyView(values[next]);
    document.querySelector(`#mantra-doma-view [data-mantra-doma-view="${values[next]}"]`)?.focus();
  });
}

function bindFilters() {
  if (filtersBound) return;
  filtersBound = true;
  document.getElementById("mantra-doma-club")?.addEventListener("change", (event) => {
    clubFilter = event.target.value || "";
    renderPlayers();
  });
  document.getElementById("mantra-doma-pos")?.addEventListener("change", (event) => {
    posFilter = event.target.value || "";
    renderPlayers();
  });
  document.getElementById("mantra-doma-search")?.addEventListener("input", (event) => {
    searchQuery = event.target.value || "";
    renderPlayers();
  });
  document.getElementById("mantra-doma-refresh")?.addEventListener("click", () => {
    Promise.all([loadPlayers(), loadApplications(), loadStats()]).catch(() => {});
  });
  document.getElementById("mantra-doma-subtabs")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-mantra-doma-tab]");
    if (!btn) return;
    setTab(btn.getAttribute("data-mantra-doma-tab") || "players");
  });
}

function bindApply() {
  if (applyBound) return;
  applyBound = true;
  document.getElementById("mantra-doma-apply")?.addEventListener("click", openApplyDialog);
  document.getElementById("mantra-doma-apply-form")?.addEventListener("submit", (event) => {
    submitApplication(event).catch(() => {});
  });
}

let photoBound = false;

function bindPhoto() {
  if (photoBound) return;
  photoBound = true;
  document.getElementById("mantra-doma-grid")?.addEventListener("click", (event) => {
    const th = event.target.closest("th[data-doma-sort]");
    if (th) {
      listSort = nextToggleSort(listSort, th.getAttribute("data-doma-sort"));
      renderPlayers();
      return;
    }
    const btn = event.target.closest(".mantra-doma-photo-btn");
    if (!btn) return;
    openPhoto(btn.getAttribute("data-photo-src"), btn.getAttribute("data-photo-alt"), btn);
  });
  const dialog = document.getElementById("mantra-doma-photo-dialog");
  if (!dialog) return;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    const img = document.getElementById("mantra-doma-photo-full");
    if (img) {
      img.removeAttribute("src");
      img.alt = "";
    }
    photoTrigger?.focus?.();
    photoTrigger = null;
  });
}

export async function start(page) {
  if (page !== "mantra-doma") return;
  bindFilters();
  bindApply();
  bindViewToggle();
  bindPhoto();
  applyView(readStoredView(), { persist: false });
  setTab("players");
  const playersP = loadPlayers();
  const statsP = loadStats();
  const appsP = loadApplications();
  await playersP;
  await Promise.all([statsP, appsP]);
}
