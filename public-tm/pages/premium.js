import {
  accountState,
  esc,
  formatPct,
  formatUiDateTime,
} from "../core.js?v=11";
import {
  nextPremiumSort,
  nextToggleSort,
  sortNumericRows,
  sortPremiumRows,
} from "../premium-sort.js?v=5";
import {
  pickBestPremiumXi,
  premiumPlayerScore,
  premiumSelectionCounts,
} from "../premium-formations.js?v=4";

let premiumData = null;
let premiumSort = null;
let selectedIds = new Set();
let benchIds = new Set();
let premiumTeamChosen = false;
let squadReportData = null;
let squadSort = null;
let unpickedTopsData = null;
const unpickedSortByPos = new Map();

const SQUAD_SORT_KEYS = new Set([
  "auctionPrice",
  "ratingAvg",
  "mantraTsAvg",
  "formScore",
]);

/** Pastel endpoints for Форма 0→red, 5→yellow, 10→green; mixed in oklab. */
const FORM_HEAT_RED = "#f0b6b0";
const FORM_HEAT_YELLOW = "#efe08a";
const FORM_HEAT_GREEN = "#b7dfc4";

function dash(value) {
  return value == null || value === "" ? "—" : value;
}

function formatXiScore(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(1);
}

function formatFormScore(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}

function mixOklab(from, to, t) {
  const u = Math.max(0, Math.min(1, t));
  return `color-mix(in oklab, ${from} ${((1 - u) * 100).toFixed(1)}%, ${to} ${(u * 100).toFixed(1)}%)`;
}

/** Форма 10 = green, 0 = red, yellow mid. Missing → empty (no fake 0). */
function formScoreHeat(value) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const t = Math.max(0, Math.min(1, n / 10));
  return t <= 0.5
    ? mixOklab(FORM_HEAT_RED, FORM_HEAT_YELLOW, t / 0.5)
    : mixOklab(FORM_HEAT_YELLOW, FORM_HEAT_GREEN, (t - 0.5) / 0.5);
}

function formScoreCell(row) {
  const text = formatFormScore(row.formScore);
  const heat = formScoreHeat(row.formScore);
  if (!heat) {
    return `<td class="premium-squad-num" title="Форма 0.00–10.00">${text}</td>`;
  }
  return `<td class="premium-squad-num" title="Форма 0.00–10.00"><span class="premium-form-heat" style="--form-heat:${heat}">${text}</span></td>`;
}

function sortableTh(label, key, sort, attr, extraClass = "") {
  const active = sort?.key === key;
  const aria = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const sorted = active ? " is-sorted" : "";
  const dirAttr = active ? ` data-dir="${esc(sort.dir)}"` : "";
  const cls = `${extraClass} sortable${sorted}`.trim();
  return `<th class="${cls}" ${attr}="${esc(key)}" aria-sort="${aria}"${dirAttr}>${label}</th>`;
}

function syncSortableHeaders(root, sort, attr) {
  if (!root) return;
  for (const th of root.querySelectorAll(`th[${attr}]`)) {
    const key = th.getAttribute(attr);
    const active = Boolean(sort && sort.key === key);
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

function formatAuctionPrice(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function decoratePremiumScores(rows) {
  for (const row of rows || []) {
    const scored = premiumPlayerScore(row);
    row.xiScore = scored.total;
    row.xiScoreTitle = scored.title;
  }
}

function selectedTeamSquad() {
  const teamSelect = document.getElementById("premium-team");
  const selectedTeam = teamSelect?.value || "";
  if (!selectedTeam) return [];
  return (premiumData?.rows || []).filter(
    (row) => String(row.managerTeamId) === selectedTeam,
  );
}

function formatXiPct(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  return `${Number(n)}%`;
}

function formatFootmopsPct(row) {
  if (row?.footmopsGroup === "out") return "OUT";
  return formatXiPct(row?.footmopsPercentage);
}

function formatProb(value) {
  return value == null || value === "" ? "—" : esc(formatPct(value));
}

function mantraPositionsText(row) {
  const positions = Array.isArray(row.positions)
    ? row.positions.map((position) => String(position || "").trim()).filter(Boolean)
    : [];
  if (positions.length) return positions.join("/");
  return row.position || "—";
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

function mantraPosPill(label) {
  const text = String(label || "").trim();
  if (!text || text === "—") return "—";
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

function playerCell(row) {
  const name = row.mantraProfileUrl
    ? `<a href="${esc(row.mantraProfileUrl)}">${esc(row.displayName)}</a>`
    : esc(row.displayName || "—");
  const team = [row.managerTeamName, row.managerLeagueName || row.leagueName]
    .filter(Boolean)
    .join(" · ");
  return `${name}<small>${esc(team || "—")}</small>`;
}

function expected11Cell(row) {
  const label = String(row.lineupGroup || "").toUpperCase() || "E11";
  const href = row.expected11PlayerUrl || row.expected11MatchUrl;
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
    : "—";
}

function renderSelectionCount(visibleRows) {
  const countEl = document.getElementById("premium-selection-count");
  if (!countEl) return;
  const counts = premiumSelectionCounts(selectedIds, visibleRows);
  countEl.textContent = counts.total
    ? `Выбрано: ${counts.total}${
        counts.visible !== counts.total ? ` · видно ${counts.visible}` : ""
      }`
    : "Никто не выбран";
}

function renderLineupItems(items) {
  return `<ul class="premium-formation-xi">
    ${(items || [])
      .map(
        (item) => `<li>
          <strong>${esc(item.slot?.label || "—")}</strong>
          <span>${esc(item.player?.displayName || "—")}</span>
          <small>${esc(
            [
              item.slotScore != null ? formatXiScore(item.slotScore) : null,
              item.player?.clubName,
              mantraPositionsText(item.player || {}),
            ]
              .filter((part) => part && part !== "—")
              .join(" · ") || "—",
          )}</small>
        </li>`,
      )
      .join("")}
  </ul>`;
}

function renderFormationResult(result, open) {
  const extras = (result.extras || [])
    .map((player) => player.displayName || player.surname || `#${player.mantraPlayerId}`)
    .filter(Boolean);
  const bench = result.bench || [];
  const total =
    result.totalScore != null ? ` · оценка ${formatXiScore(result.totalScore)}` : "";
  return `<details class="premium-formation"${open ? " open" : ""}>
    <summary>${esc(result.formation)}${esc(total)}</summary>
    ${renderLineupItems(result.assignments)}
    <p class="premium-formation-bench-title">Скамейка</p>
    ${
      bench.length
        ? renderLineupItems(bench)
        : `<p class="premium-formation-bench">—</p>`
    }
    ${
      extras.length
        ? `<p class="premium-formation-bench">Вне заявки: ${esc(extras.join(", "))}</p>`
        : ""
    }
  </details>`;
}

function renderPickedXi(picked) {
  const messageEl = document.getElementById("premium-selection-message");
  const listEl = document.getElementById("premium-formations");
  if (!messageEl || !listEl) return;
  if (!picked || picked.error) {
    messageEl.textContent = picked?.error || "Выбери команду — XI собирается по одному составу.";
    listEl.innerHTML = "";
    return;
  }
  const best = picked.best;
  messageEl.textContent = `Лучший XI: ${best.formation} · оценка ${formatXiScore(best.totalScore)}.`;
  listEl.innerHTML = renderFormationResult(best, true);
}

function minutesGrid(cells) {
  return `<div class="premium-squad-grid">${(cells || [])
    .map((cell) => {
      const value = cell.minutes == null ? "—" : String(cell.minutes);
      const title = `T${cell.tour}: ${cell.minutes == null ? "нет данных" : `${cell.minutes}'`}`;
      const zero = cell.minutes === 0 ? " is-zero" : "";
      return `<span class="${zero}" title="${esc(title)}">${esc(value)}</span>`;
    })
    .join("")}</div>`;
}

function statusBadge(row) {
  const kind = row?.status;
  if (!kind || kind === "—") return "—";
  const title = [
    row?.injury?.detail || row?.reason,
    row?.injury?.expectedReturn ? `возврат ${row.injury.expectedReturn}` : "",
  ]
    .filter((part) => part && part !== "—")
    .join(" · ");
  let mod = "premium-squad-badge";
  if (kind === "OUT" || kind === "травма") mod += " premium-squad-badge-inj";
  else if (kind === "дисквал" || kind === "дискв.") mod += " premium-squad-badge-ban";
  else if (kind === "сомнителен") mod += " premium-squad-badge-doubt";
  return `<span class="${mod}" title="${esc(title || kind)}">${esc(kind)}</span>`;
}

function squadPlayerCell(row) {
  const name = esc(row.surname || row.displayName || "—");
  const club = row.clubCode
    ? ` <abbr class="premium-squad-club" title="${esc(row.clubName || row.clubCode)}">${esc(row.clubCode)}</abbr>`
    : "";
  return `<span class="premium-squad-name" title="${esc(row.displayName || "")}">${name}</span>${club}`;
}

function subsCell(notes) {
  if (!notes?.length) return "—";
  return notes
    .map(
      (note) =>
        `<span class="premium-squad-sub" title="${esc(note.title || note.label)}">${esc(note.label)}</span>`,
    )
    .join(" ");
}

function showSquadReport() {
  const section = document.getElementById("premium-squad-report");
  if (section) section.hidden = false;
}

function showUnpickedTops() {
  const section = document.getElementById("premium-unpicked-tops");
  if (section) section.hidden = false;
}

function squadRowCells(row, extras) {
  return `<tr>
            <td class="premium-squad-player">${squadPlayerCell(row)}</td>
            <td class="premium-squad-pos">${mantraPosPill(mantraPositionsText(row))}</td>
            ${extras}
          </tr>`;
}

function renderSquadReport(data) {
  squadReportData = data;
  showSquadReport();
  const meta = document.getElementById("premium-squad-report-meta");
  const body = document.getElementById("premium-squad-report-body");
  if (!meta || !body) return;
  if (data?.players?.length) {
    const tours = (data.tours || []).join(", ");
    meta.textContent = `${data.players.length} игроков · туры ${tours || "—"} · оценка ${
      data.ratingSource === "fotmob" ? "FotMob" : data.ratingSource || "FotMob"
    }`;
    body.innerHTML = sortNumericRows(data.players, squadSort)
      .map((row) => {
        const out = row.status === "OUT" || row.status === "травма" || row.status === "дисквал";
        return squadRowCells(
          row,
          `<td class="premium-squad-num" title="Кредиты на аукционе этой лиги">${formatAuctionPrice(row.auctionPrice)}</td>
            <td class="premium-squad-mins">${minutesGrid(row.minutesByTour)}</td>
            <td title="FotMob">${formatXiScore(row.ratingAvg)}</td>
            <td title="Mantra TS с бонусами">${formatXiScore(row.mantraTsAvg)}</td>
            ${formScoreCell(row)}
            <td class="${out ? "premium-squad-status-out" : ""}">${statusBadge(row)}</td>
            <td class="premium-squad-subs">${subsCell(row.subNotes)}</td>`,
        );
      })
      .join("");
    syncSortableHeaders(
      document.getElementById("premium-squad-report"),
      squadSort,
      "data-squad-sort",
    );
    return;
  }
  meta.textContent =
    data?.message || "Выбери команду — минуты, оценка и статус по сезону.";
  body.innerHTML = `<tr><td colspan="9" class="live-empty">${esc(
    data?.message || "Выбери команду",
  )}</td></tr>`;
  syncSortableHeaders(
    document.getElementById("premium-squad-report"),
    squadSort,
    "data-squad-sort",
  );
}

function unpickedTable(group) {
  const pos = group.position || "—";
  const sort = unpickedSortByPos.get(pos) || null;
  const players = sortNumericRows(group.players || [], sort);
  const rows = players.length
    ? players
        .map(
          (row) =>
            squadRowCells(
              row,
              `<td class="premium-squad-mins">${minutesGrid(row.minutesByTour)}</td>
            <td title="FotMob">${formatXiScore(row.ratingAvg)}</td>
            <td title="Mantra TS с бонусами">${formatXiScore(row.mantraTsAvg)}</td>
            ${formScoreCell(row)}`,
            ),
        )
        .join("")
    : `<tr><td colspan="6" class="live-empty">Нет свободных на этой позиции.</td></tr>`;
  return `<section class="premium-unpicked-pos" data-unpicked-pos="${esc(pos)}">
    <h3>${mantraPosPill(pos)}</h3>
    <div class="table-wrap premium-squad-report-wrap">
      <table class="data-table compact-table premium-squad-report-table">
        <thead>
          <tr>
            <th class="premium-squad-player">Игрок</th>
            <th class="premium-squad-pos">Поз</th>
            <th>Мин</th>
            ${sortableTh("FM", "ratingAvg", sort, "data-unpicked-sort")}
            ${sortableTh("TS", "mantraTsAvg", sort, "data-unpicked-sort")}
            ${sortableTh("Форма", "formScore", sort, "data-unpicked-sort", "premium-squad-num")}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderUnpickedTops(data) {
  unpickedTopsData = data;
  showUnpickedTops();
  const meta = document.getElementById("premium-unpicked-tops-meta");
  const body = document.getElementById("premium-unpicked-tops-body");
  if (!meta || !body) return;
  const groups = (data?.groups || []).filter((group) => group?.position);
  if (groups.length) {
    const count = groups.reduce((sum, group) => sum + (group.players || []).length, 0);
    meta.textContent = `${count} свободных · туры ${(data.tours || []).join(", ") || "—"}`;
    body.innerHTML = groups.map((group) => unpickedTable(group)).join("");
    return;
  }
  meta.textContent =
    data?.message || "Выбери команду — лучшие невзятые по позициям.";
  body.innerHTML = `<p class="live-empty">${esc(data?.message || "Выбери команду")}</p>`;
}

function reportLoadError(error) {
  renderSquadReport({
    ok: false,
    message: `Ошибка отчёта: ${error?.message || error}`,
  });
}

function unpickedLoadError(error) {
  renderUnpickedTops({
    ok: false,
    message: `Ошибка свободных: ${error?.message || error}`,
  });
}

async function fetchJson(url, options = {}, timeoutMs = 0) {
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.code = data.code;
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

async function loadSquadReport(fresh) {
  showSquadReport();
  const teamSelect = document.getElementById("premium-team");
  const selectedTeam = teamSelect?.value || "";
  const meta = document.getElementById("premium-squad-report-meta");
  if (!selectedTeam) {
    renderSquadReport({
      ok: false,
      message: "Выбери команду — минуты, оценка и статус по сезону.",
    });
    return;
  }
  if (meta) meta.textContent = "Отчёт…";
  const body = document.getElementById("premium-squad-report-body");
  if (body && !body.querySelector(".premium-squad-grid")) {
    body.innerHTML = `<tr><td colspan="9" class="live-empty">Отчёт…</td></tr>`;
  }
  const qs = new URLSearchParams({ teamId: selectedTeam });
  if (fresh) qs.set("fresh", "1");
  const data = await fetchJson(`/api/expected11/premium/squad-report?${qs}`, {}, 12000);
  renderSquadReport(data);
}

async function loadUnpickedTops(fresh) {
  showUnpickedTops();
  const teamSelect = document.getElementById("premium-team");
  const selectedTeam = teamSelect?.value || "";
  const meta = document.getElementById("premium-unpicked-tops-meta");
  const body = document.getElementById("premium-unpicked-tops-body");
  if (!selectedTeam) {
    renderUnpickedTops({
      ok: false,
      message: "Выбери команду — лучшие невзятые по позициям.",
    });
    return;
  }
  if (meta) meta.textContent = "Свободные…";
  if (body && !body.querySelector(".premium-squad-grid")) {
    body.innerHTML = `<p class="live-empty">Свободные…</p>`;
  }
  const qs = new URLSearchParams({ teamId: selectedTeam });
  if (fresh) qs.set("fresh", "1");
  const data = await fetchJson(`/api/expected11/premium/unpicked-tops?${qs}`, {}, 12000);
  renderUnpickedTops(data);
}

function applyBestXi() {
  const teamSelect = document.getElementById("premium-team");
  const selectedTeam = teamSelect?.value || "";
  if (!selectedTeam) {
    selectedIds = new Set();
    benchIds = new Set();
    renderPremium();
    renderPickedXi({
      error: "Выбери команду — XI собирается по одному составу.",
    });
    return;
  }
  const picked = pickBestPremiumXi(
    selectedTeamSquad(),
    premiumData?.formations || [],
    premiumData?.positionOrder || [],
  );
  selectedIds = new Set(
    (picked.best?.assignments || [])
      .map((item) => Number(item.player?.mantraPlayerId))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  benchIds = new Set(
    (picked.best?.bench || [])
      .map((item) => Number(item.player?.mantraPlayerId))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  renderPremium();
  renderPickedXi(picked);
}

function renderPremium() {
  if (!premiumData) return;
  const teamSelect = document.getElementById("premium-team");
  const selectedTeam = teamSelect?.value || "";
  const rows = sortPremiumRows(
    (premiumData.rows || []).filter((row) => {
      if (selectedTeam && String(row.managerTeamId) !== selectedTeam) return false;
      return true;
    }),
    premiumSort,
  );
  for (const button of document.querySelectorAll("[data-premium-sort]")) {
    const key = button.dataset.premiumSort;
    const sorted = premiumSort?.key === key;
    const direction = sorted ? premiumSort.dir : null;
    const label = button.dataset.sortLabel || button.textContent.trim();
    button.closest("th")?.setAttribute(
      "aria-sort",
      direction === "desc" ? "descending" : direction === "asc" ? "ascending" : "none",
    );
    button.setAttribute(
      "aria-label",
      sorted
        ? `${label}: по ${direction === "desc" ? "убыванию" : "возрастанию"}. Сортировать по ${
            direction === "desc" ? "возрастанию" : "убыванию"
          }`
        : `${label}: сортировать по убыванию`,
    );
    const indicator = button.querySelector(".premium-sort-indicator");
    if (indicator) {
      indicator.textContent =
        direction === "desc" ? "▼" : direction === "asc" ? "▲" : "";
    }
  }
  const rounds = [
    ...new Set(rows.map((row) => row.roundLabel).filter(Boolean)),
  ];
  document.getElementById("premium-meta").textContent = rows.length
    ? `${rows.length} игроков · ${new Set(rows.map((row) => row.managerTeamId)).size} команд · ${
        rounds.join(", ") || "тур неизвестен"
      }`
    : premiumData.message || "Нет игроков";
  document.getElementById("premium-help").textContent =
    premiumData.selectionLogic || "";
  document.getElementById("premium-manager-message").textContent =
    premiumData.managerIdConfigured
      ? ""
      : "Сначала укажи Mantra Manager ID в настройках аккаунта.";
  document.getElementById("premium-body").innerHTML = rows.length
    ? rows
        .map((row) => {
          const id = Number(row.mantraPlayerId);
          const inXi = selectedIds.has(id);
          const onBench = benchIds.has(id);
          return `<tr${inXi ? ' class="premium-row-xi"' : onBench ? ' class="premium-row-bench"' : ""}>
            <td class="premium-select-col">
              <input type="checkbox" class="premium-player-select"
                data-premium-player-id="${esc(row.mantraPlayerId)}"
                ${inXi ? "checked" : ""}
                aria-label="${esc(
                  inXi
                    ? `XI: ${row.displayName || "игрок"}`
                    : onBench
                      ? `Скамейка: ${row.displayName || "игрок"}`
                      : `Выбрать ${row.displayName || "игрока"}`,
                )}">
            </td>
            <td>${esc(mantraPositionsText(row))}</td>
            <td class="premium-score-col" title="${esc(row.xiScoreTitle || "")}">${formatXiScore(row.xiScore)}</td>
            <td>${playerCell(row)}</td>
            <td>${esc(row.clubName || "—")}</td>
            <td>${expected11Cell(row)}</td>
            <td>${formatXiPct(row.displayedPercentage)}</td>
            <td>${formatFootmopsPct(row)}</td>
            <td>${esc(row.matchLabel || row.opponent || "—")}<small>${
              row.kickoffKnown
                ? esc(formatUiDateTime(row.kickoff))
                : row.kickoff
                  ? "время неизвестно"
                  : "—"
            }</small></td>
            <td>${formatProb(row.winProbability)}</td>
            <td>${formatProb(row.cleanSheetProbability)}</td>
            <td>${formatProb(row.opponentCleanSheetProbability)}</td>
            <td>${esc(dash(row.popularScore))}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="13" class="live-empty">${esc(
        premiumData.message || "Нет игроков по выбранным фильтрам",
      )}</td></tr>`;
  renderSelectionCount(rows);
}

function fillFilters(data) {
  const teamSelect = document.getElementById("premium-team");
  if (!teamSelect) return;
  const selectedTeam = teamSelect.value;
  const hadChoice = Boolean(selectedTeam) || premiumTeamChosen;
  teamSelect.innerHTML =
    `<option value="">Все команды</option>` +
    (data.teams || [])
      .map(
        (team) =>
          `<option value="${esc(team.id)}">${esc(teamOptionLabel(team))}</option>`,
      )
      .join("");
  if (hadChoice && (data.teams || []).some((team) => String(team.id) === selectedTeam)) {
    teamSelect.value = selectedTeam;
  } else if (!hadChoice && (data.teams || []).length) {
    teamSelect.value = String(data.teams[0].id);
    premiumTeamChosen = true;
  }
  syncAuctionRefreshButton();
}

function teamOptionLabel(team) {
  if (team.label) return team.label;
  const league = team.mantraLeagueName || team.leagueName;
  return league && league !== team.name ? `${team.name} · ${league}` : team.name || "";
}

function isPremiumAdmin() {
  return Boolean(accountState.authenticated && accountState.entitlements?.expected11Admin);
}

function selectedPremiumTeamId() {
  return document.getElementById("premium-team")?.value || "";
}

function syncAuctionRefreshButton() {
  const button = document.getElementById("premium-refresh-auctions");
  if (!button) return;
  const admin = isPremiumAdmin();
  button.hidden = !admin;
  if (!admin) return;
  if (button.getAttribute("aria-busy") === "true") return;
  button.disabled = !selectedPremiumTeamId();
}

async function loadPremium(refresh) {
  const refreshButton = document.getElementById("premium-refresh");
  if (refreshButton) refreshButton.disabled = true;
  document.getElementById("premium-meta").textContent = refresh
    ? "Обновляю состав…"
    : "Загрузка Premium…";
  try {
    const data = refresh
      ? await fetchJson("/api/expected11/premium/refresh", { method: "POST" }, 20000)
      : await fetchJson("/api/expected11/premium", {}, 20000);
    premiumData = data;
    const liveIds = new Set(
      (data.rows || []).map((row) => Number(row.mantraPlayerId)),
    );
    selectedIds = new Set([...selectedIds].filter((id) => liveIds.has(id)));
    decoratePremiumScores(data.rows);
    fillFilters(data);
    applyBestXi();
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
  loadSquadReport(refresh).catch(reportLoadError);
  loadUnpickedTops(refresh).catch(unpickedLoadError);
}

document.getElementById("premium-team")?.addEventListener("change", () => {
  premiumTeamChosen = true;
  syncAuctionRefreshButton();
  applyBestXi();
  loadSquadReport().catch(reportLoadError);
  loadUnpickedTops().catch(unpickedLoadError);
});
document.getElementById("view-premium")?.addEventListener("click", (event) => {
  const squadTh = event.target.closest("#premium-squad-report th[data-squad-sort]");
  if (squadTh) {
    const key = squadTh.getAttribute("data-squad-sort");
    if (SQUAD_SORT_KEYS.has(key)) {
      squadSort = nextToggleSort(squadSort, key);
      renderSquadReport(squadReportData);
    }
    return;
  }
  const unpickedTh = event.target.closest("#premium-unpicked-tops th[data-unpicked-sort]");
  if (unpickedTh) {
    const key = unpickedTh.getAttribute("data-unpicked-sort");
    const pos = unpickedTh.closest("[data-unpicked-pos]")?.getAttribute("data-unpicked-pos");
    if (key && pos && SQUAD_SORT_KEYS.has(key)) {
      unpickedSortByPos.set(pos, nextToggleSort(unpickedSortByPos.get(pos) || null, key));
      renderUnpickedTops(unpickedTopsData);
    }
    return;
  }
  const button = event.target.closest("button[data-premium-sort]");
  if (!button) return;
  premiumSort = nextPremiumSort(premiumSort, button.dataset.premiumSort);
  renderPremium();
});
document.getElementById("view-premium")?.addEventListener("change", (event) => {
  const input = event.target.closest("input.premium-player-select");
  if (!input) return;
  const id = Number(input.dataset.premiumPlayerId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (input.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  renderSelectionCount(
    [...document.querySelectorAll("#premium-body .premium-player-select")].map(
      (checkbox) => ({ mantraPlayerId: Number(checkbox.dataset.premiumPlayerId) }),
    ),
  );
});
document.getElementById("premium-generate")?.addEventListener("click", applyBestXi);
document.getElementById("premium-refresh")?.addEventListener("click", () => {
  loadPremium(true).catch((error) => {
    document.getElementById("premium-meta").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("premium-refresh-auctions")?.addEventListener("click", () => {
  refreshAuctionStatus().catch((error) => {
    const meta = document.getElementById("premium-meta");
    if (meta) meta.textContent = `Ошибка: ${error.message}`;
  });
});

async function refreshAuctionStatus() {
  const button = document.getElementById("premium-refresh-auctions");
  const teamId = selectedPremiumTeamId();
  const meta = document.getElementById("premium-meta");
  if (!isPremiumAdmin() || !teamId) return;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  if (meta) meta.textContent = "Обновляю аукцион выбранной лиги…";
  try {
    const data = await fetchJson(
      "/api/expected11/premium/refresh-auctions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: Number(teamId) }),
      },
      300000,
    );
    const warning = data.auctions?.warning ? ` · ${data.auctions.warning}` : "";
    if (meta) {
      meta.textContent = `Лига ${data.league}: составы ${data.teams}, аукционы ${data.auctions?.imported ?? 0}/${data.auctions?.discovered ?? 0}${warning}`;
    }
    loadSquadReport(true).catch(reportLoadError);
    loadUnpickedTops(true).catch(unpickedLoadError);
  } finally {
    if (button) {
      button.removeAttribute("aria-busy");
      button.disabled = !selectedPremiumTeamId();
    }
  }
}

export async function start(page) {
  if (page === "premium" && !accountState.entitlements?.expected11Premium) {
    location.replace("/clubs");
    return;
  }
  syncAuctionRefreshButton();
  showSquadReport();
  showUnpickedTops();
  renderSquadReport({
    ok: false,
    message: "Отчёт…",
  });
  renderUnpickedTops({
    ok: false,
    message: "Свободные…",
  });
  try {
    await loadPremium();
  } catch (err) {
    const el = document.getElementById("premium-meta");
    if (el) el.textContent = `Ошибка: ${err.message}`;
    loadSquadReport().catch(reportLoadError);
    loadUnpickedTops().catch(unpickedLoadError);
  }
}
