import { accountState, apiJson, esc } from "../core.js?v=11";

let leagueOneData = null;
/** @type {any} */
let reportsData = null;
/** @type {Set<string>} */
let selectedIds = new Set();
/** @type {Set<string>} */
let tmPosFilter = new Set();
/** @type {Set<string>} */
let fotmobPosFilter = new Set();
/** @type {Set<string>} */
let reportsPosFilter = new Set();
/** @type {Set<string>} */
let reportsClubFilter = new Set();
let multiFiltersBound = false;
let reportsFiltersBound = false;
let activeTab = "players";
let reportsLoaded = false;

function isLeagueOneAdmin() {
  return Boolean(accountState.authenticated && accountState.entitlements?.expected11Admin);
}

function syncAdminChrome() {
  const admin = isLeagueOneAdmin();
  const refresh = document.getElementById("league-one-refresh");
  if (refresh) refresh.hidden = !admin;
  const bar = document.querySelector(".league-one-assign-bar");
  if (bar) {
    bar.hidden = !admin;
    bar.style.display = admin ? "" : "none";
  }
  const reportsSync = document.getElementById("league-one-reports-sync");
  if (reportsSync) reportsSync.hidden = !admin;
}

function dash(value) {
  return value == null || value === "" ? "—" : value;
}

function statusLabel(status) {
  if (status === "linked") return "linked";
  if (status === "ambiguous") return "ambiguous";
  return "unmatched";
}

function parseFotmobPos(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,/|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function multiFilterLabel(selected) {
  if (!selected?.size) return "Все";
  if (selected.size === 1) return [...selected][0];
  return `${selected.size} выбр.`;
}

function visiblePlayers() {
  const status = document.getElementById("league-one-status")?.value || "";
  const club = document.getElementById("league-one-club")?.value || "";
  const tmAnd = document.getElementById("league-one-tm-pos-and")?.value || "";
  const fotmobAnd = document.getElementById("league-one-fotmob-pos-and")?.value || "";
  return (leagueOneData?.snapshot?.players || []).filter((row) => {
    if (status && row.matchStatus !== status) return false;
    if (club && row.tmClubId !== club) return false;
    const tmPositions = row.positions || [];
    if (tmPosFilter.size) {
      if (![...tmPosFilter].some((pos) => tmPositions.includes(pos))) return false;
    }
    if (tmAnd && !tmPositions.includes(tmAnd)) return false;
    const fotmobPositions = parseFotmobPos(row.fotmobPositions);
    if (fotmobPosFilter.size) {
      if (![...fotmobPosFilter].some((pos) => fotmobPositions.includes(pos))) return false;
    }
    if (fotmobAnd && !fotmobPositions.includes(fotmobAnd)) return false;
    return true;
  });
}

function fillClubFilter(snapshot) {
  const select = document.getElementById("league-one-club");
  if (!select) return;
  const selected = select.value;
  const clubs = new Map();
  for (const row of snapshot?.players || []) {
    if (!clubs.has(row.tmClubId)) clubs.set(row.tmClubId, row.tmClubName);
  }
  const sorted = [...clubs.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML =
    `<option value="">Все клубы</option>` +
    sorted
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
      .join("");
  if ([...clubs.keys()].includes(selected)) select.value = selected;
}

function syncMultiFilterButton(btnId, selected) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.textContent = multiFilterLabel(selected);
  btn.classList.toggle("is-active", selected.size > 0);
}

function fillMultiPosMenu(menuId, btnId, values, selected) {
  const menu = document.getElementById(menuId);
  if (!menu) return;
  for (const value of [...selected]) {
    if (!values.includes(value)) selected.delete(value);
  }
  menu.innerHTML = values.length
    ? values
        .map(
          (value) =>
            `<label class="col-filter-multi-item"><input type="checkbox" value="${esc(value)}" ${
              selected.has(value) ? "checked" : ""
            }/> ${esc(value)}</label>`,
        )
        .join("")
    : `<p class="col-filter-multi-empty">Нет значений</p>`;
  syncMultiFilterButton(btnId, selected);
}

function fillAndPosSelect(selectId, values) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const selected = select.value;
  select.innerHTML =
    `<option value="">—</option>` +
    values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  if (values.includes(selected)) select.value = selected;
}

function fillPositionFilters(snapshot) {
  const tm = new Set();
  const fot = new Set();
  for (const row of snapshot?.players || []) {
    for (const pos of row.positions || []) tm.add(pos);
    for (const pos of parseFotmobPos(row.fotmobPositions)) fot.add(pos);
  }
  const tmValues = [...tm].sort();
  const fotValues = [...fot].sort();
  fillMultiPosMenu(
    "league-one-tm-pos-menu",
    "league-one-tm-pos-btn",
    tmValues,
    tmPosFilter,
  );
  fillMultiPosMenu(
    "league-one-fotmob-pos-menu",
    "league-one-fotmob-pos-btn",
    fotValues,
    fotmobPosFilter,
  );
  fillAndPosSelect("league-one-tm-pos-and", tmValues);
  fillAndPosSelect("league-one-fotmob-pos-and", fotValues);
}

function closeAllPosMenus() {
  for (const id of [
    "league-one-tm-pos-menu",
    "league-one-fotmob-pos-menu",
    "league-one-reports-pos-menu",
    "league-one-reports-club-menu",
  ]) {
    const menu = document.getElementById(id);
    if (menu) menu.hidden = true;
  }
  for (const id of [
    "league-one-tm-pos-btn",
    "league-one-fotmob-pos-btn",
    "league-one-reports-pos-btn",
    "league-one-reports-club-btn",
  ]) {
    document.getElementById(id)?.setAttribute("aria-expanded", "false");
  }
}

function ensureMultiFiltersUi() {
  if (multiFiltersBound) return;
  multiFiltersBound = true;
  const root = document.getElementById("view-league-one");
  if (!root) return;

  root.addEventListener("click", (event) => {
    const btn = event.target.closest(".col-filter-multi-btn");
    if (!btn || !root.contains(btn)) return;
    event.stopPropagation();
    const wrap = btn.closest(".col-filter-multi");
    const menu = wrap?.querySelector(".col-filter-multi-menu");
    if (!menu) return;
    const open = menu.hidden;
    closeAllPosMenus();
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  root.addEventListener("change", (event) => {
    const input = event.target.closest(
      "#league-one-tm-pos-menu input[type='checkbox'], #league-one-fotmob-pos-menu input[type='checkbox']",
    );
    if (!input) return;
    const menu = input.closest(".col-filter-multi-menu");
    if (!menu) return;
    const selected = menu.id === "league-one-tm-pos-menu" ? tmPosFilter : fotmobPosFilter;
    const btnId =
      menu.id === "league-one-tm-pos-menu"
        ? "league-one-tm-pos-btn"
        : "league-one-fotmob-pos-btn";
    selected.clear();
    for (const el of menu.querySelectorAll('input[type="checkbox"]:checked')) {
      selected.add(el.value);
    }
    syncMultiFilterButton(btnId, selected);
    renderLeagueOne();
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("#view-league-one .col-filter-multi")) return;
    closeAllPosMenus();
  });
}

function setLeagueOneTab(tab) {
  activeTab = tab === "reports" ? "reports" : "players";
  for (const btn of document.querySelectorAll("#league-one-subtabs [data-league-one-tab]")) {
    const selected = btn.getAttribute("data-league-one-tab") === activeTab;
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  }
  const players = document.getElementById("league-one-panel-players");
  const reports = document.getElementById("league-one-panel-reports");
  if (players) players.hidden = activeTab !== "players";
  if (reports) reports.hidden = activeTab !== "reports";
  if (activeTab === "reports" && !reportsLoaded) {
    loadReports(false).catch(() => {});
  } else if (activeTab === "reports") {
    renderReports();
  }
}

function formatPts(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function visibleReportPlayers() {
  return (reportsData?.players || []).filter((row) => {
    if (reportsPosFilter.size) {
      const positions = row.mantraPositions || [];
      if (![...reportsPosFilter].some((pos) => positions.includes(pos))) return false;
    }
    if (reportsClubFilter.size && !reportsClubFilter.has(row.clubId)) return false;
    return true;
  });
}

function fillReportsFilters(data) {
  const positions = new Set();
  const clubs = new Map();
  for (const row of data?.players || []) {
    for (const pos of row.mantraPositions || []) positions.add(pos);
    if (row.clubId) clubs.set(row.clubId, row.clubName);
  }
  fillMultiPosMenu(
    "league-one-reports-pos-menu",
    "league-one-reports-pos-btn",
    [...positions].sort(),
    reportsPosFilter,
  );
  const clubEntries = [...clubs.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const menu = document.getElementById("league-one-reports-club-menu");
  if (menu) {
    for (const id of [...reportsClubFilter]) {
      if (!clubs.has(id)) reportsClubFilter.delete(id);
    }
    menu.innerHTML = clubEntries.length
      ? clubEntries
          .map(
            ([id, name]) =>
              `<label class="col-filter-multi-item"><input type="checkbox" value="${esc(id)}" ${
                reportsClubFilter.has(id) ? "checked" : ""
              }/> ${esc(name)}</label>`,
          )
          .join("")
      : `<p class="col-filter-multi-empty">Нет клубов</p>`;
    syncMultiFilterButton("league-one-reports-club-btn", reportsClubFilter);
  }
}

function ensureReportsFiltersUi() {
  if (reportsFiltersBound) return;
  reportsFiltersBound = true;
  const root = document.getElementById("view-league-one");
  if (!root) return;
  root.addEventListener("change", (event) => {
    const input = event.target.closest(
      "#league-one-reports-pos-menu input[type='checkbox'], #league-one-reports-club-menu input[type='checkbox']",
    );
    if (!input) return;
    const menu = input.closest(".col-filter-multi-menu");
    if (!menu) return;
    const selected =
      menu.id === "league-one-reports-pos-menu" ? reportsPosFilter : reportsClubFilter;
    const btnId =
      menu.id === "league-one-reports-pos-menu"
        ? "league-one-reports-pos-btn"
        : "league-one-reports-club-btn";
    selected.clear();
    for (const el of menu.querySelectorAll('input[type="checkbox"]:checked')) {
      selected.add(el.value);
    }
    syncMultiFilterButton(btnId, selected);
    renderReports();
  });
}

function renderReports() {
  const head = document.getElementById("league-one-reports-head");
  const body = document.getElementById("league-one-reports-body");
  const meta = document.getElementById("league-one-reports-meta");
  if (!head || !body || !meta) return;
  if (!reportsData) {
    head.innerHTML = "";
    body.innerHTML = `<tr><td class="live-empty">Нет данных</td></tr>`;
    meta.textContent = "Отчёты ещё не загружены";
    return;
  }
  const rounds = reportsData.rounds || [];
  meta.textContent =
    `${reportsData.syncedAt || "—"} · матчей FT ${reportsData.matchesFinished ?? 0}` +
    ` · со статами ${reportsData.matchesWithStats ?? 0}` +
    ` · игроков с Mantra ${reportsData.playersWithPositions ?? 0}` +
    ` · туров ${rounds.length}`;
  fillReportsFilters(reportsData);
  ensureReportsFiltersUi();

  const rows = visibleReportPlayers();
  const roundHeads = rounds
    .map((round) => {
      const played = rows.filter((row) => row.byRound?.[round]).length;
      return `<th class="league-one-round-col" colspan="2">Тур ${esc(round)} <span class="league-one-round-count">(${played})</span></th>`;
    })
    .join("");
  const roundSub = rounds
    .map(() => `<th class="num">BS</th><th class="num">TS</th>`)
    .join("");
  head.innerHTML = `<tr>
      <th>Клуб</th>
      <th>Игрок</th>
      <th>Mantra</th>
      <th>Осн.</th>
      ${roundHeads}
    </tr>
    <tr class="league-one-reports-subhead">
      <th></th><th></th><th></th><th></th>
      ${roundSub}
    </tr>`;

  body.innerHTML = rows.length
    ? rows
        .map((row) => {
          const cells = rounds
            .map((round) => {
              const score = row.byRound?.[round];
              if (!score) {
                return `<td class="num muted">—</td><td class="num muted">—</td>`;
              }
              return `<td class="num">${esc(formatPts(score.bs))}</td><td class="num league-one-ts">${esc(
                formatPts(score.ts),
              )}</td>`;
            })
            .join("");
          return `<tr>
            <td>${esc(row.clubName)}</td>
            <td>${esc(row.name)}</td>
            <td>${esc((row.mantraPositions || []).join(" / ") || "—")}</td>
            <td>${esc(row.primaryPosition || "—")}</td>
            ${cells}
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="${4 + rounds.length * 2}" class="live-empty">Нет игроков по фильтру (нужны Mantra-позиции + связь FotMob)</td></tr>`;
}

async function loadReports(sync) {
  const meta = document.getElementById("league-one-reports-meta");
  const status = document.getElementById("league-one-reports-status");
  const button = document.getElementById("league-one-reports-sync");
  if (meta) {
    meta.textContent = sync
      ? "Синхронизация матчей FotMob…"
      : "Загрузка отчётов…";
  }
  if (status) status.textContent = "";
  if (button) button.disabled = true;
  try {
    const data = sync
      ? await apiJson("/api/league-one/reports/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      : await apiJson("/api/league-one/reports");
    reportsData = data;
    reportsLoaded = true;
    renderReports();
    if (status && sync) {
      const s = data.sync;
      status.textContent = s
        ? `Синхронизация: обновлено ${s.refreshed ?? 0}, осталось без статов ${s.pendingDetails ?? 0}`
        : "Синхронизация завершена";
    }
  } catch (error) {
    if (meta) meta.textContent = `Ошибка: ${error.message}`;
    if (status) status.textContent = `Ошибка: ${error.message}`;
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function fillAssignSelect() {
  const select = document.getElementById("league-one-assign-pos");
  if (!select) return;
  const selected = select.value;
  const positions = leagueOneData?.mantraPositions || [
    "GK",
    "CB",
    "RB",
    "LB",
    "WB",
    "DM",
    "CM",
    "AM",
    "W",
    "FW",
    "ST",
  ];
  select.innerHTML = positions
    .map((pos) => `<option value="${esc(pos)}">${esc(pos)}</option>`)
    .join("");
  if (positions.includes(selected)) select.value = selected;
}

function updateSelectionCount() {
  const el = document.getElementById("league-one-selection-count");
  if (!el) return;
  const n = selectedIds.size;
  el.textContent = n ? `Выбрано: ${n}` : "Никто не выбран";
  const all = document.getElementById("league-one-select-all");
  if (all) {
    const visible = visiblePlayers();
    all.checked =
      visible.length > 0 && visible.every((row) => selectedIds.has(row.tmPlayerId));
    all.indeterminate =
      !all.checked && visible.some((row) => selectedIds.has(row.tmPlayerId));
  }
}

function renderOrphans(snapshot) {
  const wrap = document.getElementById("league-one-orphans-wrap");
  const box = document.getElementById("league-one-orphans");
  if (!wrap || !box) return;
  if (!isLeagueOneAdmin()) {
    wrap.hidden = true;
    box.innerHTML = "";
    return;
  }
  const orphans = snapshot?.fotmobOrphans || [];
  wrap.hidden = orphans.length === 0;
  if (!orphans.length) {
    box.innerHTML = "";
    return;
  }
  const tmCandidates = (snapshot?.players || [])
    .filter((row) => !row.fotmobPlayerId)
    .slice()
    .sort(
      (a, b) =>
        a.tmClubName.localeCompare(b.tmClubName) ||
        a.tmName.localeCompare(b.tmName),
    );
  const optionsFor = (orphan) => {
    const clubKey = String(orphan.teamName || "")
      .toLowerCase()
      .replace(/\b(fc|afc|athletic)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const sameClub = [];
    const other = [];
    for (const tm of tmCandidates) {
      const tmKey = String(tm.tmClubName || "")
        .toLowerCase()
        .replace(/\b(fc|afc|athletic)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const label = `${tm.tmName} · ${tm.tmClubName}`;
      const option = `<option value="${esc(tm.tmPlayerId)}">${esc(label)}</option>`;
      if (clubKey && tmKey && (tmKey.includes(clubKey) || clubKey.includes(tmKey))) {
        sameClub.push(option);
      } else {
        other.push(option);
      }
    }
    const groups = [];
    if (sameClub.length) {
      groups.push(
        `<optgroup label="Тот же клуб">${sameClub.join("")}</optgroup>`,
      );
    }
    if (other.length) {
      groups.push(`<optgroup label="Другие">${other.join("")}</optgroup>`);
    }
    return (
      `<option value="">— выбрать TM —</option>` +
      (groups.join("") || `<option value="" disabled>Нет unmatched TM</option>`)
    );
  };
  box.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Клуб</th><th>Игрок</th><th>Позиции</th><th>FotMob id</th><th>Связать с TM</th></tr></thead>
    <tbody>
      ${orphans
        .map(
          (row) => `<tr>
            <td>${esc(row.teamName)}</td>
            <td>${esc(row.name)}</td>
            <td>${esc(dash(row.positions))}</td>
            <td>${esc(row.id)}</td>
            <td class="league-one-map-cell">
              <select class="league-one-map-tm" data-fotmob-id="${esc(row.id)}">
                ${optionsFor(row)}
              </select>
              <button type="button" class="col-picker-btn league-one-map-save"
                data-fotmob-id="${esc(row.id)}">Связать</button>
            </td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function mantraChips(row) {
  const positions = row.mantraPositions || [];
  if (!positions.length) return `<span class="league-one-mantra-empty">—</span>`;
  const admin = isLeagueOneAdmin();
  return positions
    .map(
      (pos) => `<span class="league-one-mantra-chip">
        ${esc(pos)}${
          admin
            ? `
        <button type="button" class="league-one-mantra-remove"
          data-tm-id="${esc(row.tmPlayerId)}" data-pos="${esc(pos)}"
          aria-label="Удалить ${esc(pos)}">×</button>`
            : ""
        }
      </span>`,
    )
    .join("");
}

function renderLeagueOne() {
  const body = document.getElementById("league-one-body");
  const meta = document.getElementById("league-one-meta");
  if (!body || !meta) return;
  const snapshot = leagueOneData?.snapshot;
  if (!snapshot) {
    body.innerHTML = `<tr><td colspan="9" class="live-empty">Нет снимка. Нажми «Обновить снимок».</td></tr>`;
    meta.textContent = "Снимок ещё не собран";
    renderOrphans(null);
    updateSelectionCount();
    return;
  }
  const counts = snapshot.counts || {};
  meta.textContent = `${snapshot.syncedAt || "—"} · TM ${counts.tmPlayers ?? 0} · FotMob ${
    counts.fotmobPlayers ?? 0
  } · linked ${counts.linked ?? 0} · unmatched ${counts.unmatched ?? 0} · ambiguous ${
    counts.ambiguous ?? 0
  } · orphans ${counts.fotmobOrphans ?? 0}`;
  const rows = visiblePlayers();
  const liveIds = new Set(rows.map((row) => row.tmPlayerId));
  selectedIds = new Set([...selectedIds].filter((id) => liveIds.has(id) ||
    (leagueOneData?.snapshot?.players || []).some((p) => p.tmPlayerId === id)));
  body.innerHTML = rows.length
    ? rows
        .map((row) => {
          const admin = isLeagueOneAdmin();
          const fotmob = row.fotmobName
            ? `${esc(row.fotmobName)}${
                row.manualMapping && admin
                  ? ` <button type="button" class="col-picker-btn league-one-unmap" data-tm-id="${esc(
                      row.tmPlayerId,
                    )}">Отвязать</button>`
                  : ""
              }`
            : row.candidates?.length
              ? row.candidates
                  .map((c) => `${esc(c.name)} (${esc(c.score)})`)
                  .join("<br>")
              : "—";
          const checked = selectedIds.has(row.tmPlayerId) ? " checked" : "";
          const status = row.manualMapping
            ? "linked (manual)"
            : statusLabel(row.matchStatus);
          return `<tr>
            <td class="league-one-check-col">
              ${
                admin
                  ? `<input type="checkbox" class="league-one-player-select"
                data-tm-id="${esc(row.tmPlayerId)}"${checked} />`
                  : ""
              }
            </td>
            <td>${esc(row.tmClubName)}</td>
            <td>${esc(row.tmName)}</td>
            <td>${esc((row.positions || []).join(" / ") || "—")}</td>
            <td>${fotmob}</td>
            <td>${esc(dash(row.fotmobPositions))}</td>
            <td class="league-one-mantra-cell">${mantraChips(row)}</td>
            <td>${esc(status)}</td>
            <td>${esc(row.matchScore ?? "—")}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="live-empty">Нет игроков по фильтру</td></tr>`;
  renderOrphans(snapshot);
  updateSelectionCount();
}

function applyLoadedData(data) {
  leagueOneData = data;
  const liveIds = new Set(
    (data.snapshot?.players || []).map((row) => row.tmPlayerId),
  );
  selectedIds = new Set([...selectedIds].filter((id) => liveIds.has(id)));
  fillClubFilter(data.snapshot);
  fillPositionFilters(data.snapshot);
  fillAssignSelect();
  ensureMultiFiltersUi();
  renderLeagueOne();
}

async function loadLeagueOne(sync) {
  const refresh = document.getElementById("league-one-refresh");
  const status = document.getElementById("league-one-status-msg");
  if (refresh) refresh.disabled = true;
  document.getElementById("league-one-meta").textContent = sync
    ? "Синхронизация TM + FotMob…"
    : "Загрузка…";
  if (status) status.textContent = "";
  try {
    const data = sync
      ? await apiJson("/api/league-one/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      : await apiJson("/api/league-one");
    applyLoadedData(data);
    if (status && sync) {
      status.textContent = `Снимок обновлён · linked ${data.snapshot?.counts?.linked ?? 0}`;
    }
  } catch (error) {
    document.getElementById("league-one-meta").textContent = `Ошибка: ${error.message}`;
    if (status) status.textContent = `Ошибка: ${error.message}`;
    throw error;
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

async function assignSelected() {
  const status = document.getElementById("league-one-status-msg");
  const position = document.getElementById("league-one-assign-pos")?.value;
  const tmPlayerIds = [...selectedIds];
  if (!position || !tmPlayerIds.length) {
    if (status) status.textContent = "Выбери игроков и Mantra-позицию";
    return;
  }
  const button = document.getElementById("league-one-assign");
  if (button) button.disabled = true;
  try {
    const data = await apiJson("/api/league-one/mantra-positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tmPlayerIds, position }),
    });
    applyLoadedData(data);
    if (status) {
      status.textContent = `Добавлено ${data.added ?? 0}, пропущено ${data.skipped ?? 0} (макс. 3 позиции)`;
    }
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  } finally {
    if (button) button.disabled = false;
  }
}

async function removeMantraPosition(tmPlayerId, position) {
  const status = document.getElementById("league-one-status-msg");
  try {
    const data = await apiJson("/api/league-one/mantra-positions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tmPlayerId, position }),
    });
    applyLoadedData(data);
    if (status) status.textContent = `Удалено ${position}`;
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  }
}

async function clearAllMantraPositions() {
  const status = document.getElementById("league-one-status-msg");
  const ok = window.confirm(
    "Очистить Mantra-позиции у всех игроков League One? Это нельзя отменить.",
  );
  if (!ok) return;
  const button = document.getElementById("league-one-clear-mantra");
  if (button) button.disabled = true;
  try {
    const data = await apiJson("/api/league-one/mantra-positions/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    applyLoadedData(data);
    if (status) status.textContent = `Очищено назначений: ${data.cleared ?? 0}`;
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveManualMapping(fotmobPlayerId, tmPlayerId) {
  const status = document.getElementById("league-one-status-msg");
  if (!fotmobPlayerId || !tmPlayerId) {
    if (status) status.textContent = "Выбери TM-игрока для связи";
    return;
  }
  try {
    const data = await apiJson("/api/league-one/mapping", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tmPlayerId,
        fotmobPlayerId: Number(fotmobPlayerId),
      }),
    });
    applyLoadedData(data);
    if (status) {
      status.textContent = `Связано · orphans ${data.snapshot?.counts?.fotmobOrphans ?? 0}`;
    }
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  }
}

async function removeManualMapping(tmPlayerId) {
  const status = document.getElementById("league-one-status-msg");
  try {
    const data = await apiJson("/api/league-one/mapping", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tmPlayerId }),
    });
    applyLoadedData(data);
    if (status) status.textContent = "Ручная связь удалена";
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  }
}

for (const id of [
  "league-one-status",
  "league-one-club",
  "league-one-tm-pos-and",
  "league-one-fotmob-pos-and",
]) {
  document.getElementById(id)?.addEventListener("change", () => {
    renderLeagueOne();
  });
}

document.getElementById("league-one-refresh")?.addEventListener("click", () => {
  loadLeagueOne(true).catch(() => {});
});

document.getElementById("league-one-assign")?.addEventListener("click", () => {
  assignSelected().catch(() => {});
});

document.getElementById("league-one-clear-mantra")?.addEventListener("click", () => {
  clearAllMantraPositions().catch(() => {});
});

document.getElementById("league-one-select-all")?.addEventListener("change", (event) => {
  const checked = Boolean(event.target.checked);
  for (const row of visiblePlayers()) {
    if (checked) selectedIds.add(row.tmPlayerId);
    else selectedIds.delete(row.tmPlayerId);
  }
  renderLeagueOne();
});

document.getElementById("view-league-one")?.addEventListener("change", (event) => {
  const input = event.target.closest("input.league-one-player-select");
  if (!input) return;
  const id = input.dataset.tmId;
  if (!id) return;
  if (input.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  updateSelectionCount();
});

document.getElementById("view-league-one")?.addEventListener("click", (event) => {
  const unmap = event.target.closest("button.league-one-unmap");
  if (unmap) {
    const tmPlayerId = unmap.dataset.tmId;
    if (tmPlayerId) removeManualMapping(tmPlayerId).catch(() => {});
    return;
  }
  const mapSave = event.target.closest("button.league-one-map-save");
  if (mapSave) {
    const fotmobPlayerId = mapSave.dataset.fotmobId;
    const select = document.querySelector(
      `select.league-one-map-tm[data-fotmob-id="${fotmobPlayerId}"]`,
    );
    const tmPlayerId = select?.value || "";
    saveManualMapping(fotmobPlayerId, tmPlayerId).catch(() => {});
    return;
  }
  const button = event.target.closest("button.league-one-mantra-remove");
  if (!button) return;
  const tmPlayerId = button.dataset.tmId;
  const position = button.dataset.pos;
  if (!tmPlayerId || !position) return;
  removeMantraPosition(tmPlayerId, position).catch(() => {});
});

document.getElementById("league-one-subtabs")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-league-one-tab]");
  if (!btn) return;
  setLeagueOneTab(btn.getAttribute("data-league-one-tab"));
});

document.getElementById("league-one-reports-sync")?.addEventListener("click", () => {
  loadReports(true).catch(() => {});
});

export async function start(page) {
  if (page !== "league-one") return;
  syncAdminChrome();
  ensureMultiFiltersUi();
  setLeagueOneTab("players");
  await loadLeagueOne(false);
}
