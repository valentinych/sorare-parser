import {
  accountState,
  apiJson,
  esc,
  formatPct,
  formatUiDateTime,
} from "../core.js?v=7";
import {
  nextPremiumSort,
  sortPremiumRows,
} from "../premium-sort.js?v=3";
import {
  generatePremiumLineups,
  premiumSelectionCounts,
} from "../premium-formations.js?v=1";

let premiumData = null;
let premiumSort = null;
let selectedIds = new Set();

function dash(value) {
  return value == null || value === "" ? "—" : value;
}

function formatXiPct(value) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${esc(number)}%` : "—";
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

function selectedPlayers() {
  return (premiumData?.rows || []).filter((row) =>
    selectedIds.has(Number(row.mantraPlayerId)),
  );
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

function renderFormationResult(result, open) {
  const extras = (result.extras || [])
    .map((player) => player.displayName || player.surname || `#${player.mantraPlayerId}`)
    .filter(Boolean);
  return `<details class="premium-formation"${open ? " open" : ""}>
    <summary>${esc(result.formation)}</summary>
    <ul class="premium-formation-xi">
      ${(result.assignments || [])
        .map(
          (item) => `<li>
            <strong>${esc(item.slot?.label || "—")}</strong>
            <span>${esc(item.player?.displayName || "—")}</span>
            <small>${esc(
              [item.player?.clubName, mantraPositionsText(item.player || {})]
                .filter((part) => part && part !== "—")
                .join(" · ") || "—",
            )}</small>
          </li>`,
        )
        .join("")}
    </ul>
    ${
      extras.length
        ? `<p class="premium-formation-bench">Не в XI: ${esc(extras.join(", "))}</p>`
        : ""
    }
  </details>`;
}

function generatePremiumSquad() {
  const messageEl = document.getElementById("premium-selection-message");
  const listEl = document.getElementById("premium-formations");
  if (!messageEl || !listEl) return;
  const { error, compatible } = generatePremiumLineups(
    selectedPlayers(),
    premiumData?.formations || [],
    premiumData?.positionOrder || [],
  );
  messageEl.textContent = error || (compatible.length === 1
    ? "Подходит 1 схема Mantra."
    : `Подходят схемы Mantra: ${compatible.map((item) => item.formation).join(", ")}.`);
  listEl.innerHTML = error
    ? ""
    : compatible
        .map((result, index) => renderFormationResult(result, index === 0))
        .join("");
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
        .map(
          (row) => `<tr>
            <td class="premium-select-col">
              <input type="checkbox" class="premium-player-select"
                data-premium-player-id="${esc(row.mantraPlayerId)}"
                ${selectedIds.has(Number(row.mantraPlayerId)) ? "checked" : ""}
                aria-label="Выбрать ${esc(row.displayName || "игрока")}">
            </td>
            <td>${esc(mantraPositionsText(row))}</td>
            <td>${playerCell(row)}</td>
            <td>${esc(row.clubName || "—")}</td>
            <td>${expected11Cell(row)}</td>
            <td>${formatXiPct(row.displayedPercentage)}</td>
            <td>${formatXiPct(row.footmopsPercentage)}</td>
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
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="12" class="live-empty">${esc(
        premiumData.message || "Нет игроков по выбранным фильтрам",
      )}</td></tr>`;
  renderSelectionCount(rows);
}

function fillFilters(data) {
  const teamSelect = document.getElementById("premium-team");
  if (!teamSelect) return;
  const selectedTeam = teamSelect.value;
  teamSelect.innerHTML =
    `<option value="">Все команды</option>` +
    (data.teams || [])
      .map(
        (team) =>
          `<option value="${esc(team.id)}">${esc(teamOptionLabel(team))}</option>`,
      )
      .join("");
  if ((data.teams || []).some((team) => String(team.id) === selectedTeam)) {
    teamSelect.value = selectedTeam;
  }
}

function teamOptionLabel(team) {
  if (team.label) return team.label;
  const league = team.mantraLeagueName || team.leagueName;
  return league && league !== team.name ? `${team.name} · ${league}` : team.name || "";
}

async function loadPremium(refresh) {
  const refreshButton = document.getElementById("premium-refresh");
  if (refreshButton) refreshButton.disabled = true;
  document.getElementById("premium-meta").textContent = refresh
    ? "Обновляю состав…"
    : "Загрузка Premium…";
  try {
    const data = refresh
      ? await apiJson("/api/expected11/premium/refresh", { method: "POST" })
      : await apiJson("/api/expected11/premium");
    premiumData = data;
    const liveIds = new Set(
      (data.rows || []).map((row) => Number(row.mantraPlayerId)),
    );
    selectedIds = new Set([...selectedIds].filter((id) => liveIds.has(id)));
    fillFilters(data);
    renderPremium();
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

document.getElementById("premium-team")?.addEventListener("change", renderPremium);
document.getElementById("view-premium")?.addEventListener("click", (event) => {
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
document.getElementById("premium-generate")?.addEventListener("click", generatePremiumSquad);
document.getElementById("premium-refresh")?.addEventListener("click", () => {
  loadPremium(true).catch((error) => {
    document.getElementById("premium-meta").textContent = `Ошибка: ${error.message}`;
  });
});

export async function start(page) {
  if (page === "premium" && !accountState.entitlements?.expected11Premium) {
    location.replace("/clubs");
    return;
  }
  try {
    await loadPremium();
  } catch (err) {
    const el = document.getElementById("premium-meta");
    if (el) el.textContent = `Ошибка: ${err.message}`;
  }
}
