import { formatUiDateTime, tr } from "./i18n.js?v=24";

const POLL_MS = 8_000;
/** Same slugs as `/live?league=` / `/xi?league=` — Latin labels match Live. */
const AUCTION_LEAGUE_SLUGS = [
  "ekstraklasa",
  "serie-a",
  "bundesliga",
  "premier-league",
  "championship",
  "super-lig",
];
const AUCTION_LEAGUE_LABELS = {
  ekstraklasa: "Ekstraklasa",
  "serie-a": "Serie A",
  bundesliga: "Bundesliga",
  "premier-league": "Premier League",
  championship: "Championship",
  "super-lig": "Süper Lig",
};
let active = false;
let timer = null;
let visibilityBound = false;
let scopes = [];
let coverage = [];
let auctions = [];
let selectedScope = "super-lig";
let page = 1;
let searchTimer = null;
let sortExplicit = false;
let reportTeams = [];
let reportPage = 1;
let reportAuctionKey = "";
let reportGeneration = 0;
let reportTeamData = null;
let reportSortKey = "actual";
let reportSortOrder = "desc";
let idealPickData = null;
let idealPickDetail = null;
let idealPickTeamId = "";
let idealPickSortOrder = "desc";
let idealPickGeneration = 0;
let auctionsGeneration = 0;
let fillingCompetitionSelect = false;
const historyCache = new Map();
const historyRequests = new Map();
const historyVersions = new Map();
let historyGeneration = 0;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function json(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function auctionHistoryCacheKey(scope, playerId) {
  return `${scope}:${playerId}`;
}

export function clearAuctionHistoryCache(scope) {
  historyGeneration += 1;
  for (const key of historyCache.keys()) {
    if (!scope || key.startsWith(`${scope}:`)) historyCache.delete(key);
  }
  for (const key of historyRequests.keys()) {
    if (!scope || key.startsWith(`${scope}:`)) historyRequests.delete(key);
  }
  if (scope) historyVersions.delete(scope);
  else historyVersions.clear();
}

function setAuctionHistoryVersion(scope, version) {
  if (!scope || !version) return;
  const previous = historyVersions.get(scope);
  if (previous && previous !== version) clearAuctionHistoryCache(scope);
  historyVersions.set(scope, version);
}

function mergeAuctionHistory(existing, pageData) {
  if (!existing || pageData.offset === 0) return pageData;
  const merged = {
    ...existing,
    partial: existing.partial || pageData.partial,
    truncated: pageData.truncated,
    nextOffset: pageData.nextOffset,
    returnedRows: Number(existing.returnedRows || 0) + Number(pageData.returnedRows || 0),
  };
  for (const nextLeague of pageData.leagues || []) {
    let league = merged.leagues.find(
      (item) => item.fantasyLeagueId === nextLeague.fantasyLeagueId,
    );
    if (!league) {
      merged.leagues.push(nextLeague);
      continue;
    }
    for (const nextAuction of nextLeague.auctions || []) {
      let auction = league.auctions.find(
        (item) => item.auctionId === nextAuction.auctionId,
      );
      if (!auction) {
        league.auctions.push(nextAuction);
        continue;
      }
      for (const nextStage of nextAuction.stages || []) {
        let stage = auction.stages.find((item) => item.stage === nextStage.stage);
        if (!stage) {
          auction.stages.push(nextStage);
          continue;
        }
        const bidIds = new Set(stage.bids.map((bid) => bid.id));
        stage.bids.push(...nextStage.bids.filter((bid) => !bidIds.has(bid.id)));
        stage.bids.sort(
          (left, right) =>
            Number(right.price ?? -1) - Number(left.price ?? -1) ||
            Number(right.id) - Number(left.id),
        );
      }
    }
  }
  return merged;
}

export function loadAuctionPlayerHistory(scope, playerId, dataVersion, offset = 0) {
  setAuctionHistoryVersion(scope, dataVersion);
  const cacheKey = auctionHistoryCacheKey(scope, playerId);
  const cached = historyCache.get(cacheKey);
  if (offset === 0 && cached?.version === dataVersion) {
    return Promise.resolve(cached.data);
  }
  const requestKey = `${cacheKey}:${offset}`;
  if (historyRequests.has(requestKey)) return historyRequests.get(requestKey);
  const generation = historyGeneration;
  const request = json(
    `/api/auctions/all/players/${encodeURIComponent(playerId)}/history?scope=${encodeURIComponent(
      scope,
    )}&offset=${encodeURIComponent(offset)}&limit=100`,
  )
    .then((data) => {
      const version = data.dataVersion || dataVersion;
      const current = historyCache.get(cacheKey);
      const merged = mergeAuctionHistory(offset > 0 ? current?.data : null, data);
      if (generation !== historyGeneration) return merged;
      setAuctionHistoryVersion(scope, version);
      historyCache.set(cacheKey, { version, data: merged });
      return merged;
    })
    .finally(() => historyRequests.delete(requestKey));
  historyRequests.set(requestKey, request);
  return request;
}

export function formatAuctionAmount(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(Number(value))}M`;
}

function graphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
      (part) => part.segment,
    );
  }
  return Array.from(value);
}

export function auctionPlayerInitials(name) {
  const tokens = String(name ?? "").match(
    /[\p{L}\p{N}\p{M}]+(?:[’'-][\p{L}\p{N}\p{M}]+)*/gu,
  ) || [];
  if (!tokens.length) return "?";
  const selected = tokens.length === 1 ? tokens : [tokens[0], tokens.at(-1)];
  return graphemes(selected.map((token) => graphemes(token)[0] || "").join("").toUpperCase())
    .slice(0, 2)
    .join("") || "?";
}

function auctionKey(auction) {
  return `${auction.mantraLeagueId}:${auction.auctionId}`;
}

export function auctionSelection(rows, previous = "") {
  const visible = (rows || []).filter((auction) => auction.browsable !== false);
  const selected = previous === "all"
    ? "all"
    : visible.some((auction) => auctionKey(auction) === previous)
    ? previous
    : "all";
  return { auctions: visible, selected };
}

export function auctionTeamReportSelection(
  rows,
  mainSelection,
  previousLeague = "",
  previousAuction = "",
) {
  const visible = (rows || []).filter(
    (auction) =>
      auction.browsable !== false &&
      (Number(auction.players || 0) > 0 || Number(auction.detailsTotal || 0) > 0),
  );
  if (mainSelection && mainSelection !== "all") {
    const auction = visible.find((row) => auctionKey(row) === mainSelection) || null;
    return {
      leagueIds: auction ? [String(auction.mantraLeagueId)] : [],
      leagueId: auction ? String(auction.mantraLeagueId) : "",
      auctions: auction ? [auction] : [],
      auctionKey: auction ? auctionKey(auction) : "",
      fixed: true,
    };
  }
  const leagueIds = [...new Set(visible.map((auction) => String(auction.mantraLeagueId)))];
  const leagueId = leagueIds.includes(String(previousLeague))
    ? String(previousLeague)
    : leagueIds[0] || "";
  const leagueAuctions = visible.filter(
    (auction) => String(auction.mantraLeagueId) === leagueId,
  );
  const selectedAuction = leagueAuctions.some(
    (auction) => auctionKey(auction) === previousAuction,
  )
    ? previousAuction
    : leagueAuctions[0]
      ? auctionKey(leagueAuctions[0])
      : "";
  return {
    leagueIds,
    leagueId,
    auctions: leagueAuctions,
    auctionKey: selectedAuction,
    fixed: false,
  };
}

export function auctionPlayerAvatarMarkup(player, name) {
  const label = `${tr("Фото игрока")}: ${name || "?"}`;
  const image = player.avatarUrl
    ? `<img class="auction-player-avatar-image" data-auction-avatar src="${esc(
        player.avatarUrl,
      )}" alt="" loading="lazy" decoding="async" />`
    : "";
  return `<span class="auction-player-avatar" role="img" aria-label="${esc(label)}">
    <span class="auction-player-initials" aria-hidden="true">${esc(
      auctionPlayerInitials(name),
    )}</span>${image}
  </span>`;
}

export function handleAuctionAvatarEvent(event) {
  const image = event.target;
  if (!image?.matches?.("[data-auction-avatar]")) return;
  if (event.type === "load") image.classList.add("is-loaded");
  if (event.type === "error") image.remove();
}

function allComplete() {
  const scope = scopes.find((item) => item.scopeKey === selectedScope);
  return Boolean(scope && scope.status === "complete" && scope.coverageComplete);
}

function clearPoll() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedulePoll() {
  clearPoll();
  if (!active || document.hidden || allComplete()) return;
  timer = setTimeout(() => {
    Promise.all([refreshProgress(), loadAuctions()]).catch(showError);
  }, POLL_MS);
}

function statusLabel(scope) {
  if (scope.status === "complete") return tr("Готово");
  if (scope.status === "partial") return tr("Частично готово");
  if (scope.status === "error") return tr("Ошибка");
  if (scope.status === "pending") return tr("Ожидает");
  return scope.phase || tr("Синхронизация");
}

function scopeMessage(scope) {
  if (scope.status === "partial") {
    return [
      `${tr("Не найдено лиг")}: ${Number(scope.missingLeagueCount || 0).toLocaleString()}`,
      `${tr("Не собрано аукционов")}: ${Number(scope.missingAuctionCount || 0).toLocaleString()}`,
      `${tr("Не обработано деталей")}: ${Number(scope.missingDetailCount || 0).toLocaleString()}`,
    ].join(" · ");
  }
  if (scope.status === "error") {
    return tr("Синхронизация недоступна; безопасные данные не опубликованы.");
  }
  return "";
}

function isAuctionLeagueSlug(value) {
  return AUCTION_LEAGUE_SLUGS.includes(String(value || "").trim().toLowerCase());
}

function auctionLeagueFromSearch(search = location.search) {
  const raw = new URLSearchParams(search).get("league");
  if (raw == null || raw === "") return "";
  const slug = String(raw).trim().toLowerCase();
  return isAuctionLeagueSlug(slug) ? slug : "";
}

function syncAuctionLeagueUrl() {
  const qs = new URLSearchParams();
  if (selectedScope) qs.set("league", selectedScope);
  const next = qs.toString() ? `/auctions?${qs}` : "/auctions";
  const cur = `${location.pathname}${location.search}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}

function fillAuctionCompetitionSelect() {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  const keys = AUCTION_LEAGUE_SLUGS.slice();
  for (const scope of scopes) {
    if (scope.scopeKey && !keys.includes(scope.scopeKey)) keys.push(scope.scopeKey);
  }
  const nextHtml = keys
    .map((slug) => {
      const fromScope = scopes.find((item) => item.scopeKey === slug);
      const label = AUCTION_LEAGUE_LABELS[slug] || fromScope?.name || slug;
      return `<option value="${esc(slug)}">${esc(label)}</option>`;
    })
    .join("");
  if (sel.innerHTML === nextHtml && sel.value === selectedScope) return;
  fillingCompetitionSelect = true;
  sel.innerHTML = nextHtml;
  sel.value = selectedScope;
  setTimeout(() => {
    fillingCompetitionSelect = false;
  }, 0);
}

function hideLegacyPageStatus() {
  const el = document.getElementById("status");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function applyAuctionScope(next) {
  if (!next || next === selectedScope) return false;
  clearAuctionHistoryCache();
  selectedScope = next;
  reportGeneration += 1;
  reportAuctionKey = "";
  reportTeams = [];
  reportSortKey = "actual";
  reportSortOrder = "desc";
  idealPickGeneration += 1;
  idealPickTeamId = "";
  idealPickSortOrder = "desc";
  clearIdealPick();
  clearTeamSpending();
  clearTeamReport();
  page = 1;
  return true;
}

function selectAuctionScope(next) {
  if (!applyAuctionScope(next)) return;
  syncAuctionLeagueUrl();
  fillAuctionCompetitionSelect();
  renderScopes();
  renderCoverage();
  loadAuctions().catch(showError);
}

function renderScopes() {
  const root = document.getElementById("auction-scopes");
  if (!root) return;
  root.innerHTML = scopes
    .map((scope) => {
      const selected = scope.scopeKey === selectedScope;
      const percent = scope.percent == null ? null : Math.round(Number(scope.percent));
      const message = scopeMessage(scope);
      const counters =
        scope.total == null
          ? tr("Определяем объём данных")
          : `${Number(scope.completed).toLocaleString()} / ${Number(scope.total).toLocaleString()}`;
      return `<button type="button" class="auction-scope-card" data-auction-scope="${esc(
        scope.scopeKey,
      )}" aria-pressed="${selected}" data-status="${esc(scope.status)}">
        <span class="auction-scope-title">${esc(scope.name)}</span>
        <span class="auction-scope-status">${esc(statusLabel(scope))}</span>
        ${
          percent == null
            ? `<span class="auction-discovery">${esc(counters)}</span>`
            : `<span class="auction-progress" aria-label="${esc(`${percent}%`)}">
                <span style="width:${Math.min(100, Math.max(0, percent))}%"></span>
              </span>
              <span class="auction-progress-label">${percent}% · ${esc(counters)}</span>`
        }
        <span class="auction-scope-counts">
          ${esc(tr("Доступные fantasy-лиги"))}: ${scope.availableLeagues} / ${scope.discoveredLeagues}<br />
          ${esc(tr("Лиги с аукционами"))}: ${scope.leaguesWithAuctions}<br />
          ${esc(tr("Собрано аукционов"))}: ${scope.collectedAuctions} / ${scope.availableAuctions}<br />
          ${esc(tr("Обработано деталей игроков"))}: ${scope.detailsProcessed} / ${scope.detailsTotal}
        </span>
        <span class="auction-scope-updated">${esc(tr("Обновлено"))}: ${esc(
          formatUiDateTime(scope.updatedAt),
        )}</span>
        ${
          scope.lastRetryAt
            ? `<span class="auction-scope-retry">${esc(
                tr("Последняя попытка"),
              )}: ${esc(formatUiDateTime(scope.lastRetryAt))}</span>`
            : ""
        }
        ${
          message
            ? `<span class="auction-scope-error">${esc(message)}</span>`
            : ""
        }
      </button>`;
    })
    .join("");
  for (const button of root.querySelectorAll("[data-auction-scope]")) {
    button.addEventListener("click", () => {
      selectAuctionScope(button.dataset.auctionScope);
    });
  }
}

function coverageStatus(league, auction) {
  if (!auction) {
    if (league.auctionState === "no-auction") return tr("Аукцион не опубликован");
    if (league.accessState === "restricted") return tr("Доступ ограничен");
    if (league.accessState === "archived") return tr("Архив");
    return tr("Недоступно");
  }
  if (auction.collectionStatus === "complete") return tr("Готово");
  if (auction.collectionStatus === "partial") return tr("Частично готово");
  if (auction.collectionStatus === "missing") return tr("Не собрано");
  return tr("Ожидает");
}

function renderCoverage() {
  const root = document.getElementById("auction-coverage-list");
  if (!root) return;
  const leagues = coverage.filter((league) => league.scopeKey === selectedScope);
  root.innerHTML = leagues.length
    ? leagues
        .map((league) => {
          const rows = league.auctions.length ? league.auctions : [null];
          return rows
            .map(
              (auction, index) => `<div class="auction-coverage-row">
                <div>
                  <strong>${esc(`${league.division || ""} | ${league.name}`)}</strong>
                  <span>${esc(tr("Лига"))} ${league.mantraLeagueId}</span>
                </div>
                <div>
                  ${
                    auction
                      ? `<a href="${esc(auction.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(
                          `${tr("Аукцион")} ${auction.auctionId}`,
                        )} ↗</a>
                        <span>${auction.detailsProcessed} / ${
                          auction.detailsTotal ?? "?"
                        } ${esc(tr("деталей"))}</span>`
                      : `<span>${esc(tr("Аукцион"))}: —</span>`
                  }
                </div>
                <span class="auction-coverage-status" data-status="${esc(
                  auction?.collectionStatus || league.auctionState,
                )}">${esc(coverageStatus(league, auction))}</span>
              </div>`,
            )
            .join("");
        })
        .join("")
    : `<p class="auction-empty">${esc(tr("Покрытие ещё не обнаружено"))}</p>`;
}

function selectedAuction() {
  const raw = document.getElementById("auction-select")?.value || "";
  const [leagueId, auctionId] = raw.split(":").map(Number);
  return auctions.find(
    (auction) =>
      Number(auction.mantraLeagueId) === leagueId &&
      Number(auction.auctionId) === auctionId,
  );
}

function allAuctionsSelected() {
  return document.getElementById("auction-select")?.value === "all";
}

function setDefaultSort() {
  const sort = document.getElementById("auction-sort");
  if (allAuctionsSelected() && sort?.value.startsWith("finalPrice:")) {
    sort.value = "maxBid:desc";
    return;
  }
  if (sortExplicit) return;
  if (sort) sort.value = allAuctionsSelected() ? "maxBid:desc" : "finalPrice:desc";
}

function fillAuctionSelect(selected = "") {
  const select = document.getElementById("auction-select");
  if (!select) return;
  select.innerHTML = `<option value="all">${esc(tr("Все аукционы"))}</option>${auctions
    .map(
      (auction) =>
        `<option value="${auction.mantraLeagueId}:${auction.auctionId}">${esc(
          auction.leagueLabel || `League ${auction.mantraLeagueId}`,
        )} · ${esc(auction.label || `#${auction.auctionId}`)}</option>`,
    )
    .join("")}`;
  select.value = selected || "all";
  setDefaultSort();
  fillStageSelect();
}

function fillStageSelect() {
  const stageSelect = document.getElementById("auction-stage");
  const auction = selectedAuction();
  if (!stageSelect) return;
  const previous = stageSelect.value;
  const stageCount = allAuctionsSelected()
    ? Math.max(0, ...auctions.map((row) => Number(row.stages || 0)))
    : Number(auction?.stages || 0);
  stageSelect.innerHTML = `<option value="">${esc(tr("Все"))}</option>${Array.from(
    { length: stageCount },
    (_, index) => `<option value="${index + 1}">${esc(tr("Этап"))} ${index + 1}</option>`,
  ).join("")}`;
  if ([...stageSelect.options].some((option) => option.value === previous)) {
    stageSelect.value = previous;
  }
}

function currentReportAuction() {
  const rawKey = reportAuctionKey.split("|").at(-1) || "";
  const [leagueId, auctionId] = rawKey.split(":").map(Number);
  return auctions.find(
    (auction) =>
      Number(auction.mantraLeagueId) === leagueId &&
      Number(auction.auctionId) === auctionId,
  ) || null;
}

function setReportStatus(message, error = false) {
  const status = document.getElementById("auction-team-report-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.error = String(error);
}

function clearTeamReport() {
  const summary = document.getElementById("auction-team-report-summary");
  const picks = document.getElementById("auction-team-report-picks");
  const pagination = document.getElementById("auction-team-report-pagination");
  if (summary) summary.innerHTML = "";
  if (picks) picks.innerHTML = "";
  if (pagination) pagination.innerHTML = "";
}

function fillReportTeamSelect(previous = "") {
  const select = document.getElementById("auction-report-team");
  const search = document.getElementById("auction-report-team-search");
  if (!select) return;
  const query = String(search?.value || "").trim().toLocaleLowerCase();
  const visible = reportTeams.filter(
    (team) =>
      String(team.fantasyTeamId) === String(previous) ||
      `${team.name || ""} ${team.fantasyTeamId}`.toLocaleLowerCase().includes(query),
  );
  select.innerHTML = `<option value="">${esc(tr("Выберите fantasy-команду"))}</option>${visible
    .map(
      (team) =>
        `<option value="${esc(team.fantasyTeamId)}">${esc(
          team.name || `#${team.fantasyTeamId}`,
        )} · #${esc(team.fantasyTeamId)} · ${esc(team.wonPickCount)} ${esc(
          tr("куплено"),
        )}</option>`,
    )
    .join("")}`;
  select.disabled = reportTeams.length === 0;
  if (visible.some((team) => String(team.fantasyTeamId) === String(previous))) {
    select.value = String(previous);
  }
}

async function loadReportTeams(previousTeam = "", preserveDetail = false) {
  const generation = ++reportGeneration;
  const auction = currentReportAuction();
  const search = document.getElementById("auction-report-team-search");
  if (!preserveDetail) {
    reportTeams = [];
    fillReportTeamSelect();
    clearTeamSpending();
    clearTeamReport();
  }
  if (search) search.disabled = !auction;
  if (!auction) {
    setReportStatus(tr("Выберите аукцион и fantasy-команду"));
    return;
  }
  setReportStatus(tr("Загрузка fantasy-команд…"));
  try {
    const data = await json(
      `/api/auctions/${auction.mantraLeagueId}/${auction.auctionId}/teams?scope=${encodeURIComponent(
        selectedScope,
      )}`,
    );
    if (generation !== reportGeneration) return;
    reportTeams = data.teams || [];
    reportTeamData = data;
    fillReportTeamSelect(previousTeam);
    renderTeamSpending();
    const selectedTeam = document.getElementById("auction-report-team")?.value;
    if (!reportTeams.length) {
      clearTeamReport();
      setReportStatus(tr("В этом аукционе нет купленных игроков"));
      return;
    }
    setReportStatus(
      data.partial
        ? tr("Данные аукциона неполные; отчёт будет предварительным")
        : tr("Выберите fantasy-команду"),
    );
    if (selectedTeam) await loadTeamReport(1);
    else clearTeamReport();
  } catch (error) {
    if (generation !== reportGeneration) return;
    if (!preserveDetail) clearTeamSpending();
    setReportStatus(`${tr("Не удалось загрузить fantasy-команды")}: ${error.message}`, true);
  }
}

async function configureTeamReport() {
  const mainSelection = document.getElementById("auction-select")?.value || "all";
  const leagueSelect = document.getElementById("auction-report-league");
  const auctionSelect = document.getElementById("auction-report-auction");
  const leagueWrap = document.getElementById("auction-report-league-wrap");
  const auctionWrap = document.getElementById("auction-report-auction-wrap");
  const previousLeague = leagueSelect?.value || "";
  const previousAuction = auctionSelect?.value || "";
  const previousTeam = document.getElementById("auction-report-team")?.value || "";
  const selection = auctionTeamReportSelection(
    auctions,
    mainSelection,
    previousLeague,
    previousAuction,
  );
  if (leagueWrap) leagueWrap.hidden = selection.fixed;
  if (auctionWrap) auctionWrap.hidden = selection.fixed;
  if (leagueSelect) {
    leagueSelect.innerHTML = selection.leagueIds
      .map((leagueId) => {
        const auction = auctions.find(
          (row) => String(row.mantraLeagueId) === String(leagueId),
        );
        return `<option value="${esc(leagueId)}">${esc(
          auction?.leagueLabel || `${tr("Лига")} #${leagueId}`,
        )}</option>`;
      })
      .join("");
    leagueSelect.value = selection.leagueId;
  }
  if (auctionSelect) {
    auctionSelect.innerHTML = selection.auctions
      .map(
        (auction) =>
          `<option value="${esc(auctionKey(auction))}">${esc(
            auction.label || `${tr("Аукцион")} #${auction.auctionId}`,
          )}</option>`,
      )
      .join("");
    auctionSelect.value = selection.auctionKey;
  }
  const nextKey = selection.auctionKey
    ? `${selectedScope}|${selection.auctionKey}`
    : "";
  const sameAuction = nextKey === reportAuctionKey;
  reportAuctionKey = nextKey;
  reportPage = 1;
  if (!sameAuction) {
    reportSortKey = "actual";
    reportSortOrder = "desc";
    const search = document.getElementById("auction-report-team-search");
    if (search) search.value = "";
    idealPickTeamId = "";
    idealPickSortOrder = "desc";
  }
  await loadReportTeams(sameAuction ? previousTeam : "", sameAuction);
  await loadIdealPickSummaries(sameAuction ? idealPickTeamId : "");
}

function reportTeamLogoMarkup(team) {
  return team?.fantasyTeamLogoUrl || team?.logoUrl
    ? `<img src="${esc(team.fantasyTeamLogoUrl || team.logoUrl)}" alt="" width="28" height="28" loading="lazy" />`
    : '<span class="auction-team-placeholder" aria-hidden="true"></span>';
}

function clearIdealPick() {
  idealPickData = null;
  idealPickDetail = null;
  const section = document.getElementById("auction-ideal-pick");
  const summary = document.getElementById("auction-ideal-pick-summary");
  const outbid = document.getElementById("auction-ideal-pick-outbid");
  const picks = document.getElementById("auction-ideal-pick-picks");
  if (section) section.hidden = true;
  if (summary) summary.innerHTML = "";
  if (outbid) outbid.innerHTML = "";
  if (picks) picks.innerHTML = "";
}

function setIdealPickStatus(message, error = false) {
  const status = document.getElementById("auction-ideal-pick-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.error = String(error);
}

function teamSummarySortValue(team, key) {
  if (key === "picks") return Number(team.wonPickCount);
  const countKey = `${key}KnownCount`;
  const knownKey = `${key}Known`;
  const count = Number(team.completeness?.[countKey] ?? 0);
  if (team[key] != null && Number.isFinite(Number(team[key]))) return Number(team[key]);
  if (count > 0 && Number.isFinite(Number(team[knownKey]))) return Number(team[knownKey]);
  return null;
}

export function sortAuctionTeamSummaries(teams, key = "actual", order = "desc") {
  const direction = order === "asc" ? 1 : -1;
  return [...(teams || [])].sort((left, right) => {
    const leftValue = teamSummarySortValue(left, key);
    const rightValue = teamSummarySortValue(right, key);
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue != null) return 1;
      if (rightValue == null && leftValue != null) return -1;
    } else if (leftValue !== rightValue) {
      return (leftValue - rightValue) * direction;
    }
    return (
      String(left.name || "").localeCompare(String(right.name || "")) ||
      Number(left.fantasyTeamId) - Number(right.fantasyTeamId)
    );
  });
}

export function nextAuctionTeamSummarySort(currentKey, currentOrder, nextKey) {
  return currentKey === nextKey
    ? { key: nextKey, order: currentOrder === "desc" ? "asc" : "desc" }
    : { key: nextKey, order: "desc" };
}

export function sortIdealPickSummaries(teams, order = "desc") {
  const direction = order === "asc" ? 1 : -1;
  return [...(teams || [])].sort((left, right) => {
    const leftValue = Number(left.idealTotal ?? left.provisionalIdealTotal);
    const rightValue = Number(right.idealTotal ?? right.provisionalIdealTotal);
    if (leftValue !== rightValue) return (leftValue - rightValue) * direction;
    return (
      String(left.name || "").localeCompare(String(right.name || "")) ||
      Number(left.fantasyTeamId) - Number(right.fantasyTeamId)
    );
  });
}

function idealKnownCount(exact, known) {
  return exact == null ? `${known}*` : String(exact);
}

function idealCompleteness(team) {
  if (team.partial) return tr("Предварительно");
  if (team.deficit > 0) return `${tr("Не хватает игроков")}: ${team.deficit}`;
  return tr("Полный расчёт");
}

export function idealPickSummaryMarkup(
  data,
  selectedTeamId = "",
  sortOrder = "desc",
) {
  const teams = sortIdealPickSummaries(data?.teams, sortOrder);
  if (!teams.length) {
    return `<p class="auction-empty">${esc(tr("Нет известных fantasy-команд для расчёта"))}</p>`;
  }
  const indicator = sortOrder === "asc" ? "↑" : "↓";
  const partial = data.partial
    ? `<p class="auction-team-summary-note" role="status">${esc(
        tr("Предварительный расчёт: отсутствующие детали могут изменить выбор, суммы и исторических владельцев."),
      )} ${esc(`${data.completeness?.detailsProcessed || 0}/${
        data.completeness?.detailsTotal || 0
      } ${tr("деталей")}`)}</p>`
    : "";
  return `${partial}<div class="auction-team-summary-wrap">
    <table class="auction-team-summary-table auction-ideal-summary-table">
      <caption>${esc(tr("Идеальный пик"))}</caption>
      <thead><tr>
        <th scope="col">${esc(tr("Fantasy-команда"))}</th>
        <th scope="col">${esc(tr("Выбрано игроков"))}</th>
        <th scope="col" aria-sort="${sortOrder === "asc" ? "ascending" : "descending"}">
          <button type="button" data-ideal-sort>${esc(tr("Идеальная сумма"))}<span aria-hidden="true">${indicator}</span></button>
        </th>
        <th scope="col">${esc(tr("Забрал из идеальных"))}</th>
        <th scope="col">${esc(tr("Упущено"))}</th>
        <th scope="col">${esc(tr("Чаще забирал"))}</th>
        <th scope="col">${esc(tr("Полнота данных"))}</th>
      </tr></thead>
      <tbody>${teams
        .map((team) => {
          const selected = String(team.fantasyTeamId) === String(selectedTeamId);
          const top = team.topCompetitor;
          return `<tr data-ideal-team="${esc(team.fantasyTeamId)}" data-selected="${selected}" tabindex="0" aria-label="${esc(
            `${team.name || `#${team.fantasyTeamId}`}, ${tr("открыть Идеальный пик")}`,
          )}">
            <td data-label="${esc(tr("Fantasy-команда"))}">
              <button type="button" class="auction-team-summary-name" data-ideal-team="${esc(
                team.fantasyTeamId,
              )}" ${selected ? 'aria-current="true"' : ""}>
                ${reportTeamLogoMarkup(team)}
                <span><strong>${esc(team.name || `#${team.fantasyTeamId}`)}</strong><small>#${esc(
                  team.fantasyTeamId,
                )}</small></span>
              </button>
            </td>
            <td data-label="${esc(tr("Выбрано игроков"))}"><strong>${esc(
              `${team.selectedCount}/${team.targetCount}`,
            )}</strong></td>
            <td data-label="${esc(tr("Идеальная сумма"))}"><strong>${esc(
              team.idealTotal == null
                ? `${formatAuctionAmount(team.provisionalIdealTotal)}*`
                : formatAuctionAmount(team.idealTotal),
            )}</strong></td>
            <td data-label="${esc(tr("Забрал из идеальных"))}"><strong>${esc(
              idealKnownCount(team.actuallyAcquiredCount, team.actuallyAcquiredKnownCount),
            )}</strong></td>
            <td data-label="${esc(tr("Упущено"))}"><strong>${esc(
              idealKnownCount(team.missedTargetCount, team.missedTargetKnownCount),
            )}</strong></td>
            <td data-label="${esc(tr("Чаще забирал"))}">${
              top
                ? `${reportTeamLogoMarkup(top)}<span>${esc(
                    top.name || `#${top.fantasyTeamId}`,
                  )} · <strong>${esc(idealKnownCount(top.exactCount, top.count))}</strong></span>`
                : "—"
            }</td>
            <td data-label="${esc(tr("Полнота данных"))}">${esc(idealCompleteness(team))}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>
  </div>`;
}

function idealActualStatus(pick) {
  const winner = pick.actualWinner;
  if (pick.actualRelationship === "manager_won") return tr("Менеджер забрал игрока");
  if (pick.actualRelationship === "same_stage_outbid") {
    return `${tr("Перебил на этапе")} ${winner?.winningStage ?? pick.stage}`;
  }
  if (pick.actualRelationship === "won_later") {
    return `${tr("Забрал позже")} · ${tr("Этап")} ${winner?.winningStage ?? "—"}`;
  }
  if (pick.actualRelationship === "no_winner") return tr("Нет победителя");
  return tr("Исход неизвестен");
}

export function idealWhoOutbidMarkup(data) {
  const groups = data?.whoOutbid || [];
  if (!groups.length) {
    return `<div class="auction-ideal-outbid"><h4>${esc(tr("Кто перебил"))}</h4>
      <p>${esc(tr("Среди известных исходов другие команды не забирали идеальные цели."))}</p></div>`;
  }
  return `<div class="auction-ideal-outbid">
    <h4>${esc(tr("Кто перебил"))}</h4>
    <p>${esc(
      tr("Историческое сравнение: кто реально забрал идеальные цели при исходных ставках."),
    )}</p>
    <div class="auction-ideal-outbid-groups">${groups
      .map(
        (group) => `<details>
          <summary>
            ${reportTeamLogoMarkup(group)}
            <strong>${esc(group.name || `#${group.fantasyTeamId}`)}</strong>
            <span>${esc(tr("Игроков"))}: ${esc(
              idealKnownCount(group.exactCount, group.count),
            )} · ${esc(tr("Фактическая сумма"))}: ${esc(
              group.actualWinningBidTotal == null
                ? `${formatAuctionAmount(group.actualWinningBidKnownTotal)}*`
                : formatAuctionAmount(group.actualWinningBidTotal),
            )}</span>
          </summary>
          <ul>${group.players
            .map(
              (player) => `<li>${esc(player.name)} · ${esc(
                player.relationship === "same_stage_outbid"
                  ? tr("Перебил на этапе")
                  : player.relationship === "won_later"
                    ? tr("Забрал позже")
                    : tr("Исход неизвестен"),
              )}</li>`,
            )
            .join("")}</ul>
        </details>`,
      )
      .join("")}</div>
  </div>`;
}

export function idealPickDetailMarkup(data) {
  const summary = data.summary || {};
  const cards = `<div class="auction-team-report-cards auction-ideal-cards">
    <div><span>${esc(tr("Выбрано игроков"))}</span><strong>${esc(
      `${summary.selectedCount || 0}/${summary.targetCount || 26}`,
    )}</strong></div>
    <div><span>${esc(tr("Идеальная сумма"))}</span><strong>${esc(
      summary.idealTotal == null
        ? `${formatAuctionAmount(summary.provisionalIdealTotal)}*`
        : formatAuctionAmount(summary.idealTotal),
    )}</strong></div>
    <div><span>${esc(tr("Забрал из идеальных"))}</span><strong>${esc(
      idealKnownCount(summary.actuallyAcquiredCount, summary.actuallyAcquiredKnownCount),
    )}</strong></div>
    <div><span>${esc(tr("Упущено"))}</span><strong>${esc(
      idealKnownCount(summary.missedTargetCount, summary.missedTargetKnownCount),
    )}</strong></div>
  </div>`;
  const rows = (data.picks || []).length
    ? `<div class="auction-team-report-table auction-ideal-picks" role="table" aria-label="${esc(
        tr("26 игроков Идеального пика"),
      )}">
        <div class="auction-team-report-columns" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">${esc(tr("Игрок"))}</span>
          <span role="columnheader">${esc(tr("Этап"))}</span>
          <span role="columnheader">${esc(tr("Ставка менеджера"))}</span>
          <span role="columnheader">${esc(tr("Максимум этапа"))}</span>
          <span role="columnheader">${esc(tr("Средняя этапа"))}</span>
          <span role="columnheader">${esc(tr("Ближайший конкурент"))}</span>
          <span role="columnheader">${esc(tr("Идеальная ставка"))}</span>
          <span role="columnheader">${esc(tr("Фактический исход"))}</span>
        </div>
        ${(data.picks || [])
          .map((pick) => {
            const name = `${pick.player?.firstName || ""} ${pick.player?.name || ""}`.trim();
            const playerName = pick.player?.profileUrl
              ? `<a href="${esc(pick.player.profileUrl)}">${esc(name)}</a>`
              : `<span>${esc(name)}</span>`;
            const nearest = pick.nearestOtherTeam;
            const winner = pick.actualWinner;
            return `<article class="auction-team-report-pick" role="row" data-complete="${esc(
              pick.complete,
            )}" data-actual-relationship="${esc(pick.actualRelationship)}">
              <div role="cell" data-label="#">${esc(pick.pickOrder)}</div>
              <div class="auction-report-player" role="cell" data-label="${esc(tr("Игрок"))}">
                ${auctionPlayerAvatarMarkup(pick.player || {}, name)}<strong>${playerName}</strong>
              </div>
              <div role="cell" data-label="${esc(tr("Этап"))}"><a href="${esc(
                pick.source?.stageUrl || pick.source?.auctionUrl || "#",
              )}" target="_blank" rel="noopener noreferrer">${esc(pick.stage)} ↗</a></div>
              <div role="cell" data-label="${esc(tr("Ставка менеджера"))}"><strong>${esc(
                formatAuctionAmount(pick.managerOriginalBid),
              )}</strong></div>
              <div role="cell" data-label="${esc(tr("Максимум этапа"))}"><strong>${esc(
                formatAuctionAmount(pick.stageMaxBid),
              )}</strong></div>
              <div role="cell" data-label="${esc(tr("Средняя этапа"))}"><strong>${esc(
                formatAuctionAmount(pick.stageAverageBid),
              )}</strong><small>${esc(
                `${pick.stageAverageBidNumerator}/${pick.stageAverageBidCount}`,
              )}</small></div>
              <div class="auction-report-runner" role="cell" data-label="${esc(
                tr("Ближайший конкурент"),
              )}">${
                nearest
                  ? `${reportTeamLogoMarkup(nearest)}<span>${esc(
                      nearest.name || `#${nearest.fantasyTeamId}`,
                    )} · <strong>${esc(formatAuctionAmount(nearest.amount))}</strong></span>`
                  : `<span>${esc(tr("Нет конкурента"))}</span>`
              }</div>
              <div role="cell" data-label="${esc(tr("Идеальная ставка"))}"><strong>${esc(
                formatAuctionAmount(pick.requiredIdealBid),
              )}</strong></div>
              <div class="auction-report-runner" role="cell" data-label="${esc(
                tr("Фактический исход"),
              )}">${
                winner
                  ? `${reportTeamLogoMarkup(winner)}<span><strong>${esc(
                      idealActualStatus(pick),
                    )}</strong> · ${esc(winner.name || `#${winner.fantasyTeamId}`)}${
                      winner.winningBid == null
                        ? ""
                        : ` · ${esc(formatAuctionAmount(winner.winningBid))}`
                    }${
                      pick.actualWinningBidGap == null
                        ? ""
                        : ` · ${esc(tr("Разница"))} ${esc(
                            formatAuctionAmount(pick.actualWinningBidGap),
                          )}`
                    }${pick.actualOutcomeAmbiguous ? ` · ${esc(tr("Неоднозначный исход"))}` : ""}</span>`
                  : `<span>${esc(idealActualStatus(pick))}</span>`
              }</div>
            </article>`;
          })
          .join("")}
      </div>`
    : `<p class="auction-empty">${esc(tr("Нет доступных кандидатов"))}</p>`;
  return `${cards}${rows}`;
}

function renderIdealPickSummary() {
  const root = document.getElementById("auction-ideal-pick-summary");
  if (!root) return;
  root.innerHTML = idealPickData
    ? idealPickSummaryMarkup(idealPickData, idealPickTeamId, idealPickSortOrder)
    : "";
}

function renderIdealPickDetail() {
  const outbid = document.getElementById("auction-ideal-pick-outbid");
  const picks = document.getElementById("auction-ideal-pick-picks");
  if (!outbid || !picks) return;
  outbid.innerHTML = idealPickDetail ? idealWhoOutbidMarkup(idealPickDetail) : "";
  picks.innerHTML = idealPickDetail ? idealPickDetailMarkup(idealPickDetail) : "";
}

async function loadIdealPickDetail(teamId) {
  const auction = currentReportAuction();
  if (!auction || !/^[1-9]\d*$/.test(String(teamId || ""))) {
    idealPickDetail = null;
    renderIdealPickDetail();
    return;
  }
  const generation = ++idealPickGeneration;
  setIdealPickStatus(tr("Загрузка Идеального пика…"));
  try {
    const data = await json(
      `/api/auctions/${auction.mantraLeagueId}/${auction.auctionId}/ideal-picks/${encodeURIComponent(
        teamId,
      )}?scope=${encodeURIComponent(selectedScope)}`,
    );
    if (generation !== idealPickGeneration) return;
    idealPickDetail = data;
    renderIdealPickDetail();
    setIdealPickStatus(
      data.partial
        ? tr("Предварительный Идеальный пик · данные неполные")
        : data.incomplete
          ? tr("Недостаточно доступных игроков")
          : tr("Идеальный пик готов"),
    );
  } catch (error) {
    if (generation !== idealPickGeneration) return;
    idealPickDetail = null;
    renderIdealPickDetail();
    setIdealPickStatus(`${tr("Не удалось загрузить Идеальный пик")}: ${error.message}`, true);
  }
}

async function loadIdealPickSummaries(previousTeamId = "") {
  const auction = currentReportAuction();
  const section = document.getElementById("auction-ideal-pick");
  const generation = ++idealPickGeneration;
  if (!auction) {
    clearIdealPick();
    return;
  }
  if (section) section.hidden = false;
  setIdealPickStatus(tr("Загрузка Идеального пика…"));
  try {
    const data = await json(
      `/api/auctions/${auction.mantraLeagueId}/${auction.auctionId}/ideal-picks?scope=${encodeURIComponent(
        selectedScope,
      )}`,
    );
    if (generation !== idealPickGeneration) return;
    idealPickData = data;
    idealPickTeamId = (data.teams || []).some(
      (team) => String(team.fantasyTeamId) === String(previousTeamId),
    )
      ? String(previousTeamId)
      : "";
    idealPickDetail = null;
    renderIdealPickSummary();
    renderIdealPickDetail();
    if (idealPickTeamId) await loadIdealPickDetail(idealPickTeamId);
    else {
      setIdealPickStatus(
        data.partial
          ? tr("Предварительный расчёт · выберите fantasy-команду")
          : tr("Выберите fantasy-команду"),
      );
    }
  } catch (error) {
    if (generation !== idealPickGeneration) return;
    idealPickData = null;
    idealPickDetail = null;
    renderIdealPickSummary();
    renderIdealPickDetail();
    setIdealPickStatus(`${tr("Не удалось загрузить Идеальный пик")}: ${error.message}`, true);
  }
}

function teamSummaryAmount(team, key) {
  const count = Number(team.completeness?.[`${key}KnownCount`] ?? 0);
  if (team[key] != null) return formatAuctionAmount(team[key]);
  if (count === 0) return "—*";
  const amount = formatAuctionAmount(team[`${key}Known`]);
  return key === "difference" ? `${amount}*` : `≥${amount}*`;
}

function teamSummaryHeader(key, label, activeKey, order) {
  const active = key === activeKey;
  const direction = active ? (order === "asc" ? "ascending" : "descending") : "none";
  const indicator = active ? (order === "asc" ? "↑" : "↓") : "";
  return `<th scope="col" aria-sort="${direction}">
    <button type="button" data-team-summary-sort="${esc(key)}">
      ${esc(tr(label))}<span aria-hidden="true">${indicator}</span>
    </button>
  </th>`;
}

export function auctionTeamSpendingMarkup(
  data,
  selectedTeamId = "",
  sortKey = "actual",
  sortOrder = "desc",
) {
  const teams = sortAuctionTeamSummaries(data?.teams, sortKey, sortOrder);
  if (!teams.length) {
    return `<p class="auction-empty">${esc(tr("В этом аукционе нет купленных игроков"))}</p>`;
  }
  const partialNote = data?.partial
    ? `<p class="auction-team-summary-note" role="status">${esc(
        tr("Частичные данные: ≥ — известная нижняя граница, * — сумма может измениться."),
      )} ${esc(`${data.detailsProcessed || 0}/${data.detailsTotal || 0} ${tr("деталей")}`)}</p>`
    : "";
  return `${partialNote}
    <div class="auction-team-summary-wrap">
      <table class="auction-team-summary-table">
        <caption>${esc(tr("Расходы fantasy-команд"))}</caption>
        <thead><tr>
          <th scope="col">${esc(tr("Fantasy-команда"))}</th>
          <th scope="col">${esc(tr("Куплено игроков"))}</th>
          ${teamSummaryHeader("minimum", "Минимум", sortKey, sortOrder)}
          ${teamSummaryHeader("actual", "Фактически", sortKey, sortOrder)}
          ${teamSummaryHeader("difference", "Разница", sortKey, sortOrder)}
        </tr></thead>
        <tbody>${teams
          .map((team) => {
            const selected = String(team.fantasyTeamId) === String(selectedTeamId);
            return `<tr data-team-summary-team="${esc(team.fantasyTeamId)}" data-selected="${selected}" tabindex="0" aria-label="${esc(
              `${team.name || `#${team.fantasyTeamId}`}, ${tr("открыть подробный отчёт")}`,
            )}">
              <td data-label="${esc(tr("Fantasy-команда"))}">
                <button type="button" class="auction-team-summary-name" data-team-summary-team="${esc(
                  team.fantasyTeamId,
                )}" ${selected ? 'aria-current="true"' : ""}>
                  ${reportTeamLogoMarkup(team)}
                  <span><strong>${esc(team.name || `#${team.fantasyTeamId}`)}</strong><small>#${esc(
                    team.fantasyTeamId,
                  )}${team.isPartial ? ` · ${esc(tr("частично"))}` : ""}</small></span>
                </button>
              </td>
              <td data-label="${esc(tr("Куплено игроков"))}"><strong>${esc(
                team.wonPickCount,
              )}${data.collectionComplete ? "" : "*"}</strong></td>
              <td data-label="${esc(tr("Минимум"))}"><strong>${esc(
                teamSummaryAmount(team, "minimum"),
              )}</strong></td>
              <td data-label="${esc(tr("Фактически"))}"><strong>${esc(
                teamSummaryAmount(team, "actual"),
              )}</strong></td>
              <td data-label="${esc(tr("Разница"))}"><strong>${esc(
                teamSummaryAmount(team, "difference"),
              )}</strong></td>
            </tr>`;
          })
          .join("")}</tbody>
      </table>
    </div>`;
}

function renderTeamSpending() {
  const root = document.getElementById("auction-team-spending");
  if (!root) return;
  const selectedTeamId = document.getElementById("auction-report-team")?.value || "";
  root.innerHTML = reportTeamData
    ? auctionTeamSpendingMarkup(
        reportTeamData,
        selectedTeamId,
        reportSortKey,
        reportSortOrder,
      )
    : "";
}

function clearTeamSpending() {
  reportTeamData = null;
  const root = document.getElementById("auction-team-spending");
  if (root) root.innerHTML = "";
}

function reportKnownAmount(exact, known, lowerBound = true) {
  return exact == null
    ? `${lowerBound ? "≥" : ""}${formatAuctionAmount(known)}*`
    : formatAuctionAmount(exact);
}

export function auctionTeamReportSummaryMarkup(data) {
  const totals = data.totals || {};
  const counts = data.completeness || {};
  return `${
    data.partial
      ? `<p class="auction-team-report-warning" role="status">${esc(
          tr("Предварительный отчёт: показаны известные суммы; точный минимум недоступен для неполных данных."),
        )} ${esc(`${data.detailsProcessed || 0}/${data.detailsTotal || 0} ${tr(
          "деталей",
        )} · ${counts.minimumKnownCount || 0}/${data.total || 0} ${tr(
          "минимумов рассчитано для известных покупок",
        )}`)}</p>`
      : ""
  }
  <div class="auction-team-report-cards">
    <div><span>${esc(tr("Куплено игроков"))}</span><strong>${esc(data.total || 0)}${
      data.collectionComplete ? "" : "*"
    }</strong></div>
    <div><span>${esc(tr("Фактически потрачено"))}</span><strong>${esc(
      reportKnownAmount(totals.actual, totals.actualKnown),
    )}</strong></div>
    <div><span>${esc(tr("Гарантированный минимум +1M"))}</span><strong>${esc(
      reportKnownAmount(
        totals.theoreticalMinimum,
        totals.theoreticalMinimumKnown,
      ),
    )}</strong></div>
    <div><span>${esc(tr("Разница / переплата"))}</span><strong>${esc(
      reportKnownAmount(totals.difference, totals.differenceKnown, false),
    )}</strong></div>
  </div>`;
}

export function auctionTeamReportPickMarkup(pick) {
  const name = `${pick.player?.firstName || ""} ${pick.player?.name || ""}`.trim();
  const playerName = pick.player?.profileUrl
    ? `<a href="${esc(pick.player.profileUrl)}">${esc(name)}</a>`
    : `<span>${esc(name)}</span>`;
  const runner = pick.runnerUp;
  return `<article class="auction-team-report-pick" role="row" data-complete="${esc(
    pick.complete,
  )}">
    <div class="auction-report-player" role="cell" data-label="${esc(tr("Игрок"))}">
      ${auctionPlayerAvatarMarkup(pick.player || {}, name)}
      <strong>${playerName}</strong>
    </div>
    <div role="cell" data-label="${esc(tr("Этап"))}"><strong>${esc(
      pick.stage,
    )}</strong></div>
    <div role="cell" data-label="${esc(tr("Фактическая ставка"))}"><strong>${esc(
      formatAuctionAmount(pick.actual),
    )}</strong>${
      pick.actualProvenance === "stage_outcome"
        ? `<small>${esc(tr("Сумма из результата этапа"))}</small>`
        : ""
    }</div>
    <div class="auction-report-runner" role="cell" data-label="${esc(
      tr("Ближайший конкурент"),
    )}">
      ${
        runner
          ? `${reportTeamLogoMarkup(runner)}<span>${esc(
              runner.fantasyTeamName || `#${runner.fantasyTeamId}`,
            )} · <strong>${esc(formatAuctionAmount(runner.amount))}</strong></span>`
          : pick.theoreticalMinimum == null
            ? `<span>${esc(tr("Неизвестно"))}</span>`
            : `<span>${esc(tr("Нет конкурента"))}</span>`
      }
    </div>
    <div role="cell" data-label="${esc(tr("Минимум +1M"))}"><strong>${esc(
      formatAuctionAmount(pick.theoreticalMinimum),
    )}</strong></div>
    <div role="cell" data-label="${esc(tr("Разница"))}"><strong>${esc(
      formatAuctionAmount(pick.difference),
    )}</strong>${
      pick.complete
        ? ""
        : `<small>${esc(tr("Неполные записи ставок"))}</small>`
    }</div>
  </article>`;
}

function renderTeamReport(data) {
  const summary = document.getElementById("auction-team-report-summary");
  const picks = document.getElementById("auction-team-report-picks");
  const pagination = document.getElementById("auction-team-report-pagination");
  if (!summary || !picks || !pagination) return;
  summary.innerHTML = auctionTeamReportSummaryMarkup(data);
  picks.innerHTML = data.picks?.length
    ? `<div class="auction-team-report-table" role="table" aria-label="${esc(
        tr("Разбивка ставок по купленным игрокам"),
      )}">
        <div class="auction-team-report-columns" role="row">
          <span role="columnheader">${esc(tr("Игрок"))}</span>
          <span role="columnheader">${esc(tr("Этап"))}</span>
          <span role="columnheader">${esc(tr("Фактическая ставка"))}</span>
          <span role="columnheader">${esc(tr("Ближайший конкурент"))}</span>
          <span role="columnheader">${esc(tr("Минимум +1M"))}</span>
          <span role="columnheader">${esc(tr("Разница"))}</span>
        </div>
        ${data.picks.map(auctionTeamReportPickMarkup).join("")}
      </div>`
    : `<p class="auction-empty">${esc(tr("Нет купленных игроков"))}</p>`;
  pagination.innerHTML =
    data.pages > 1
      ? `<button type="button" class="col-picker-btn" data-report-page="${
          data.page - 1
        }" ${data.page <= 1 ? "disabled" : ""}>← ${esc(tr("Назад"))}</button>
         <span>${data.page} / ${data.pages}</span>
         <button type="button" class="col-picker-btn" data-report-page="${
          data.page + 1
        }" ${data.page >= data.pages ? "disabled" : ""}>${esc(tr("Далее"))} →</button>`
      : "";
  for (const button of pagination.querySelectorAll("[data-report-page]")) {
    button.addEventListener("click", () => {
      loadTeamReport(Number(button.dataset.reportPage));
    });
  }
}

async function loadTeamReport(nextPage = 1) {
  const auction = currentReportAuction();
  const teamId = document.getElementById("auction-report-team")?.value || "";
  renderTeamSpending();
  if (!auction || !/^[1-9]\d*$/.test(teamId)) {
    clearTeamReport();
    setReportStatus(tr("Выберите fantasy-команду"));
    return;
  }
  const generation = ++reportGeneration;
  reportPage = nextPage;
  setReportStatus(tr("Загрузка отчёта fantasy-команды…"));
  try {
    const data = await json(
      `/api/auctions/${auction.mantraLeagueId}/${auction.auctionId}/teams/${encodeURIComponent(
        teamId,
      )}/report?scope=${encodeURIComponent(selectedScope)}&page=${encodeURIComponent(
        reportPage,
      )}&limit=25`,
    );
    if (generation !== reportGeneration) return;
    renderTeamReport(data);
    setReportStatus(
      data.partial
        ? tr("Предварительный отчёт · данные неполные")
        : tr("Отчёт готов"),
    );
  } catch (error) {
    if (generation !== reportGeneration) return;
    clearTeamReport();
    setReportStatus(`${tr("Не удалось загрузить отчёт")}: ${error.message}`, true);
  }
}

function renderProvenance(data) {
  const root = document.getElementById("auction-provenance");
  const auction = selectedAuction();
  if (!root) return;
  if (data?.mode === "all") {
    root.innerHTML = `<span>${esc(tr("Все аукционы"))}</span>
      <span>${esc(tr("Агрегация по чемпионату"))}: ${esc(data.scopeName || selectedScope)}</span>
      <span>${Number(data.contentAuctionCount || 0).toLocaleString()} ${esc(
        tr("аукционов с данными"),
      )}</span>
      ${data.preliminary ? `<span>${esc(tr("Предварительно · синхронизация не завершена"))}</span>` : ""}`;
    return;
  }
  if (!auction) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = `<span>${esc(auction.status || tr("Статус неизвестен"))}</span>
    <span>${auction.stages} ${esc(tr("этапов"))}</span>
    <span>${auction.players} ${esc(tr("игроков"))}</span>
    <span>${esc(tr("Обновлено"))}: ${esc(formatUiDateTime(auction.fetchedAt))}</span>
    <a href="${esc(auction.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(
      tr("Источник"),
    )} ↗</a>`;
}

function bidMarkup(bid) {
  const teamName = bid.teamName || tr("Команда не указана");
  const winner = bid.winner || bid.status === "success";
  const amount = formatAuctionAmount(bid.price);
  return `<li class="auction-bid ${winner ? "is-winner" : ""}" aria-label="${esc(
    `${teamName} · ${amount}${winner ? ` · ${tr("Успешно")}` : ""}`,
  )}">
    ${
      bid.teamLogoUrl
        ? `<img src="${esc(bid.teamLogoUrl)}" alt="" width="28" height="28" loading="lazy" />`
        : '<span class="auction-team-placeholder" aria-hidden="true"></span>'
    }
    <span class="auction-bid-team" title="${esc(teamName)}">${esc(teamName)}</span>
    <span class="auction-bid-separator" aria-hidden="true">·</span>
    <strong title="${esc(String(bid.price ?? ""))}">${esc(amount)}</strong>
  </li>`;
}

function stageHistoryMarkup(stages) {
  return stages
    .map(
      (stage) => `<section class="auction-stage-block" role="group" aria-label="${esc(
        `${tr("Этап")} ${stage.stage}`,
      )}">
        <h4>${esc(tr("Этап"))} ${stage.stage}
          <span data-outcome="${esc(stage.outcome || "unknown")}">${
            stage.outcome === "success"
              ? esc(tr("Успешно"))
              : stage.outcome === "failed"
                ? esc(tr("Неуспешно"))
                : esc(tr("Статус неизвестен"))
          }</span>
        </h4>
        ${
          stage.bids.length
            ? `<ol class="auction-bids" aria-label="${esc(
                `${tr("Этап")} ${stage.stage} · ${tr("Записи ставок API")}`,
              )}">${stage.bids.map(bidMarkup).join("")}</ol>`
            : `<p class="meta">${esc(tr("Ставок нет"))}</p>`
        }
      </section>`,
    )
    .join("");
}

function collectionStatusText(status) {
  if (status === "complete") return tr("Готово");
  if (status === "partial") return tr("Частично готово");
  return tr("Ожидает");
}

export function auctionHistoryMarkup(data) {
  const counts = data.counts || {};
  const summary = `${Number(counts.fantasyLeagues || 0).toLocaleString()} ${tr(
    "fantasy-лиг",
  )} · ${Number(counts.auctions || 0).toLocaleString()} ${tr(
    "аукционов",
  )} · ${Number(counts.stages || 0).toLocaleString()} ${tr(
    "этапов",
  )} · ${Number(counts.bids || 0).toLocaleString()} ${tr("записей ставок")}`;
  const leagues = (data.leagues || [])
    .map((league) => {
      const leagueTitle =
        league.fantasyLeagueName || `#${league.fantasyLeagueId}`;
      const headingId = `auction-history-league-${data.mantraPlayerId}-${league.fantasyLeagueId}`;
      return `<section class="auction-history-league" role="group" aria-labelledby="${esc(
        headingId,
      )}">
        <h4 id="${esc(headingId)}">${
          league.sourceUrl
            ? `<a href="${esc(
                league.sourceUrl,
              )}" target="_blank" rel="noopener noreferrer">${esc(leagueTitle)}</a>`
            : esc(leagueTitle)
        } <span>#${esc(league.fantasyLeagueId)}</span></h4>
        <div class="auction-history-auctions">
          ${(league.auctions || [])
            .map(
              (auction) => `<article class="auction-history-auction">
                <h5><a href="${esc(
                  auction.sourceUrl,
                )}" target="_blank" rel="noopener noreferrer">${esc(
                  auction.label || `${tr("Аукцион")} ${auction.auctionId}`,
                )} ↗</a>
                  <span data-status="${esc(auction.collectionStatus)}">${esc(
                    collectionStatusText(auction.collectionStatus),
                  )}${auction.status ? ` · ${esc(auction.status)}` : ""}</span>
                </h5>
                <div class="auction-history-stages">
                  ${stageHistoryMarkup(auction.stages || [])}
                </div>
              </article>`,
            )
            .join("")}
        </div>
      </section>`;
    })
    .join("");
  return `<div class="auction-history-summary">${esc(summary)}</div>
    ${
      data.partial
        ? `<p class="auction-history-warning" role="status">${esc(
            tr("История предварительная: один или несколько аукционов собраны не полностью."),
          )}</p>`
        : ""
    }
    <div class="auction-history-leagues">${leagues}</div>
    ${
      data.truncated
        ? `<div class="auction-history-more">
            <p>${esc(
              tr("Показана не вся история. Загрузите продолжение."),
            )}</p>
            <button type="button" class="col-picker-btn" data-auction-history-more="${esc(
              data.nextOffset,
            )}">${esc(tr("Загрузить ещё"))}</button>
          </div>`
        : ""
    }`;
}

function maxBidMarkup(player) {
  const bid = player.maxBid;
  if (!bid) return `<span>${esc(tr("Максимальная ставка API не указана"))}</span>`;
  const teamName = bid.fantasyTeamName || tr("Fantasy-команда не указана");
  const leagueName = bid.fantasyLeagueName || `#${bid.fantasyLeagueId ?? "—"}`;
  const provenance = `${tr("Аукцион")} ${bid.auctionId ?? "—"} · ${tr("Этап")} ${
    bid.stage ?? "—"
  }`;
  return `<span class="auction-max-team">
      ${
        bid.fantasyTeamLogoUrl
          ? `<img src="${esc(bid.fantasyTeamLogoUrl)}" alt="" width="28" height="28" loading="lazy" />`
          : '<span class="auction-team-placeholder" aria-hidden="true"></span>'
      }
      <span><b>${esc(tr("Менеджер / fantasy-команда"))}:</b> ${esc(teamName)}</span>
    </span>
    <span><b>${esc(tr("Fantasy-лига"))}:</b> ${esc(leagueName)}${
      bid.fantasyLeagueId == null ? "" : ` · #${esc(bid.fantasyLeagueId)}`
    }</span>
    <span>${
      bid.sourceUrl
        ? `<a href="${esc(bid.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(
            provenance,
          )} ↗</a>`
        : esc(provenance)
    }${bid.winner ? ` · ${esc(tr("Источник помечает ставку выигрышной"))}` : ""}</span>`;
}

export function auctionPlayerCardMarkup(player, preliminary = false, mode = "single") {
  const finalStage = player.stages.find((stage) => stage.outcome === "success");
  const final =
    finalStage == null
      ? tr("Не куплен")
      : `${tr("Этап")} ${finalStage.stage} · ${formatAuctionAmount(
          finalStage.winningPrice,
        )} · ${finalStage.winningTeamName || tr("Команда не указана")}`;
  const name = `${player.firstName || ""} ${player.name}`.trim();
  const nameMarkup = player.profileUrl
    ? `<a href="${esc(player.profileUrl)}">${esc(name)}</a>`
    : `<span>${esc(name)}</span>`;
  const result = mode === "all"
    ? `<strong aria-label="${esc(tr("Максимальная ставка API"))}">${esc(
        formatAuctionAmount(player.maxBidAmount),
      )}</strong>
       <span>${esc(tr("Максимальная ставка API"))}</span>`
    : `<strong>${esc(formatAuctionAmount(player.finalPrice))}</strong>
       <span>${esc(final)}</span>`;
  const historyId = `auction-history-${mode}-${player.mantraPlayerId ?? player.playerBidId}`;
  return `<article class="auction-player-card" data-auction-mode="${esc(mode)}">
    <div class="auction-player-head">
      ${auctionPlayerAvatarMarkup(player, name)}
      <div class="auction-player-identity">
        <h3>${nameMarkup}</h3>
        <p>${esc(player.clubName || tr("Без клуба"))}</p>
        <div class="auction-positions">${player.positions
          .map((position) => `<span>${esc(position)}</span>`)
          .join("")}</div>
      </div>
      <div class="auction-player-result">
        ${result}
      </div>
    </div>
    <dl class="auction-player-aggregates">
      <div>
        <dt>${esc(tr("Записи ставок API"))}</dt>
        <dd>${Number(player.bidRecordCount || 0).toLocaleString()}</dd>
      </div>
      <div>
        <dt>${esc(tr("Этапы игрока"))}</dt>
        <dd>${Number(player.stageCount || 0).toLocaleString()}</dd>
      </div>
      <div>
        <dt>${esc(tr("Сумма записей ставок API"))}</dt>
        <dd title="${esc(String(player.bidAmountSum ?? 0))}">${esc(
          formatAuctionAmount(Number(player.bidAmountSum || 0)),
        )}</dd>
      </div>
      <div class="auction-max-bid">
        <dt>${esc(tr("Максимальная ставка API"))}</dt>
        <dd title="${esc(String(player.maxBidAmount ?? ""))}">${esc(
          formatAuctionAmount(player.maxBidAmount),
        )}</dd>
        <dd class="auction-max-provenance">${maxBidMarkup(player)}</dd>
      </div>
      ${
        preliminary
          ? `<div class="auction-aggregate-partial"><dt>${esc(
              tr("Статус данных"),
            )}</dt><dd>${esc(tr("Предварительно · синхронизация не завершена"))}</dd></div>`
          : ""
      }
    </dl>
    ${
      mode === "single"
        ? `<details class="auction-history-details">
      <summary aria-expanded="false" aria-controls="${esc(historyId)}">${esc(
        tr("История этапов и ставок"),
      )} · ${player.stages.length}</summary>
      <div class="auction-stage-history">
        <p class="auction-aggregate-note">${esc(
          tr("Счётчик и сумма включают только записи ставок, возвращённые API, включая выигрышную запись без повторного добавления."),
        )}</p>
        <div id="${esc(historyId)}">${stageHistoryMarkup(player.stages)}</div>
      </div>
    </details>`
        : `<p class="auction-cross-note">${esc(
            tr("Суммы и счётчики объединяют уникальные записи ставок API во всех аукционах выбранного чемпионата."),
          )}</p>
          <details class="auction-history-details" data-auction-history-player="${esc(
            player.mantraPlayerId,
          )}" data-auction-history-scope="${esc(
            player.historyScope,
          )}" data-auction-history-version="${esc(player.historyVersion)}">
            <summary aria-expanded="false" aria-controls="${esc(historyId)}">${esc(
              tr("История по fantasy-лигам"),
            )} · ${Number(player.stageCount || 0).toLocaleString()}</summary>
            <div id="${esc(
              historyId,
            )}" class="auction-stage-history auction-lazy-history" data-auction-history-content aria-live="polite"></div>
          </details>`
    }
    <p class="auction-player-source"><a href="${esc(
      player.sourceUrl,
    )}" target="_blank" rel="noopener noreferrer">${esc(tr("Источник"))} ↗</a> · ${esc(
      formatUiDateTime(player.fetchedAt),
    )}</p>
  </article>`;
}

function playerMarkup(player, preliminary, mode) {
  return auctionPlayerCardMarkup(player, preliminary, mode);
}

async function loadHistoryForDetails(details, offset = 0) {
  const playerId = details.dataset.auctionHistoryPlayer;
  const scope = details.dataset.auctionHistoryScope;
  const version = details.dataset.auctionHistoryVersion;
  const content = details.querySelector("[data-auction-history-content]");
  if (!content || !scope || !/^[1-9]\d*$/.test(playerId || "")) return;
  if (offset === 0) {
    content.innerHTML = `<p class="auction-history-loading" role="status">${esc(
      tr("Загрузка истории ставок…"),
    )}</p>`;
  }
  try {
    const data = await loadAuctionPlayerHistory(scope, playerId, version, offset);
    if (!details.isConnected) return;
    content.innerHTML = auctionHistoryMarkup(data);
    content.dataset.loaded = "true";
  } catch (error) {
    if (!details.isConnected) return;
    content.innerHTML = `<div class="auction-history-error" role="alert">
      <p>${esc(tr("Не удалось загрузить историю ставок"))}: ${esc(error.message)}</p>
      <button type="button" class="col-picker-btn" data-auction-history-retry="${esc(
        offset,
      )}">${esc(tr("Повторить"))}</button>
    </div>`;
    delete content.dataset.loaded;
  }
}

function renderPlayers(data) {
  const root = document.getElementById("auction-players");
  const pagination = document.getElementById("auction-pagination");
  if (!root || !pagination) return;
  if (data.mode === "all") setAuctionHistoryVersion(data.scopeKey, data.dataVersion);
  root.innerHTML = data.players.length
    ? data.players
        .map((player) =>
          playerMarkup(
            {
              ...player,
              historyScope: data.scopeKey,
              historyVersion: data.dataVersion,
            },
            data.preliminary,
            data.mode,
          )
        )
        .join("")
    : `<p class="auction-empty">${esc(
        tr(data.mode === "all"
          ? "Нет игроков в аукционах выбранного чемпионата по этим фильтрам"
          : "Нет игроков по выбранным фильтрам"),
      )}</p>`;
  pagination.innerHTML =
    data.pages > 1
      ? `<button type="button" class="col-picker-btn" data-page="${
          data.page - 1
        }" ${data.page <= 1 ? "disabled" : ""}>← ${esc(tr("Назад"))}</button>
         <span>${data.page} / ${data.pages}</span>
         <button type="button" class="col-picker-btn" data-page="${
           data.page + 1
         }" ${data.page >= data.pages ? "disabled" : ""}>${esc(tr("Далее"))} →</button>`
      : "";
  for (const button of pagination.querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => {
      page = Number(button.dataset.page);
      loadPlayers().catch(showError);
    });
  }
}

async function loadPlayers() {
  const auction = selectedAuction();
  const allMode = allAuctionsSelected();
  if (!allMode && !auction) {
    renderPlayers({ players: [], page: 1, pages: 0 });
    return;
  }
  const params = new URLSearchParams({
    page: String(page),
    limit: "30",
  });
  const q = document.getElementById("auction-q")?.value.trim();
  const stage = document.getElementById("auction-stage")?.value;
  const outcome = document.getElementById("auction-outcome")?.value;
  if (q) params.set("q", q);
  if (stage) params.set("stage", stage);
  if (outcome) params.set("outcome", outcome);
  for (const [id, key] of [
    ["auction-bids-min", "bidRecordsMin"],
    ["auction-bids-max", "bidRecordsMax"],
    ["auction-stages-min", "stagesMin"],
    ["auction-stages-max", "stagesMax"],
    ["auction-amount-min", "bidAmountMin"],
    ["auction-amount-max", "bidAmountMax"],
  ]) {
    const value = document.getElementById(id)?.value;
    if (value != null && value !== "") params.set(key, value);
  }
  const [sort, direction] = (
    document.getElementById("auction-sort")?.value || "finalPrice:desc"
  ).split(":");
  params.set("sort", sort);
  params.set("direction", direction);
  const data = await json(
    allMode
      ? `/api/auctions/all/players?scope=${encodeURIComponent(selectedScope)}&${params}`
      : `/api/auctions/${auction.mantraLeagueId}/${auction.auctionId}/players?${params}`,
  );
  renderProvenance(data);
  renderPlayers(data);
  document.getElementById("auctions-meta").textContent = `${data.total} ${tr("игроков")}`;
}

async function loadAuctions() {
  const generation = ++auctionsGeneration;
  const scope = selectedScope;
  const data = await json(`/api/auctions?scope=${encodeURIComponent(scope)}`);
  if (generation !== auctionsGeneration || scope !== selectedScope) return;
  const previous = document.getElementById("auction-select")?.value || "";
  const selection = auctionSelection(data.auctions, previous);
  if (previous && selection.selected !== previous) page = 1;
  auctions = selection.auctions;
  fillAuctionSelect(selection.selected);
  await configureTeamReport();
  await loadPlayers();
}

async function refreshProgress() {
  const [data, coverageData] = await Promise.all([
    json("/api/auctions/scopes"),
    json("/api/auctions/coverage"),
  ]);
  scopes = data.scopes || [];
  coverage = coverageData.leagues || [];
  if (!scopes.some((scope) => scope.scopeKey === selectedScope) && !isAuctionLeagueSlug(selectedScope)) {
    selectedScope = scopes[0]?.scopeKey || "super-lig";
  }
  fillAuctionCompetitionSelect();
  renderScopes();
  renderCoverage();
  schedulePoll();
}

function showError(error) {
  const meta = document.getElementById("auctions-meta");
  if (meta) meta.textContent = `${tr("Ошибка")}: ${error.message}`;
  schedulePoll();
}

function visibilityChanged() {
  if (!active) return;
  if (document.hidden) clearPoll();
  else {
    Promise.all([refreshProgress(), loadAuctions()]).catch(showError);
  }
}

function bind() {
  if (!visibilityBound) {
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityBound = true;
  }
  const players = document.getElementById("auction-players");
  players?.addEventListener("load", handleAuctionAvatarEvent, true);
  players?.addEventListener("error", handleAuctionAvatarEvent, true);
  players?.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (!details?.matches?.(".auction-history-details")) return;
      details
        .querySelector("summary")
        ?.setAttribute("aria-expanded", String(details.open));
      if (
        details.open &&
        details.dataset.auctionHistoryPlayer &&
        !details.querySelector("[data-auction-history-content]")?.dataset.loaded
      ) {
        loadHistoryForDetails(details);
      }
    },
    true,
  );
  players?.addEventListener("click", (event) => {
    const button = event.target.closest?.(
      "[data-auction-history-more], [data-auction-history-retry]",
    );
    if (!button) return;
    const details = button.closest(".auction-history-details");
    if (!details) return;
    const offset = Number(
      button.dataset.auctionHistoryMore ?? button.dataset.auctionHistoryRetry ?? 0,
    );
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    button.disabled = true;
    button.textContent = tr("Загрузка…");
    loadHistoryForDetails(details, offset);
  });
  document.getElementById("competition-select")?.addEventListener("change", (event) => {
    if (fillingCompetitionSelect) return;
    const next = String(event.target.value || "").trim();
    if (!next || next === selectedScope) return;
    selectAuctionScope(next);
  });
  document.getElementById("auctions-refresh")?.addEventListener("click", () => {
    Promise.all([refreshProgress(), loadAuctions()]).catch(showError);
  });
  document.getElementById("auction-select")?.addEventListener("change", async () => {
    page = 1;
    setDefaultSort();
    fillStageSelect();
    try {
      await configureTeamReport();
      await loadPlayers();
    } catch (error) {
      showError(error);
    }
  });
  document.getElementById("auction-report-league")?.addEventListener("change", () => {
    reportPage = 1;
    configureTeamReport().catch((error) =>
      setReportStatus(`${tr("Ошибка")}: ${error.message}`, true),
    );
  });
  document.getElementById("auction-report-auction")?.addEventListener("change", () => {
    const value = document.getElementById("auction-report-auction")?.value || "";
    reportAuctionKey = value ? `${selectedScope}|${value}` : "";
    reportPage = 1;
    reportSortKey = "actual";
    reportSortOrder = "desc";
    idealPickTeamId = "";
    idealPickSortOrder = "desc";
    const search = document.getElementById("auction-report-team-search");
    if (search) search.value = "";
    Promise.all([loadReportTeams(), loadIdealPickSummaries()]).catch((error) => {
      setReportStatus(`${tr("Ошибка")}: ${error.message}`, true);
      setIdealPickStatus(`${tr("Ошибка")}: ${error.message}`, true);
    });
  });
  document.getElementById("auction-report-team-search")?.addEventListener("input", () => {
    const previous = document.getElementById("auction-report-team")?.value || "";
    fillReportTeamSelect(previous);
  });
  document.getElementById("auction-report-team")?.addEventListener("change", () => {
    reportPage = 1;
    loadTeamReport(1);
  });
  const teamSpending = document.getElementById("auction-team-spending");
  teamSpending?.addEventListener("click", (event) => {
    const sortButton = event.target.closest?.("[data-team-summary-sort]");
    if (sortButton) {
      const key = sortButton.dataset.teamSummarySort;
      if (!["minimum", "actual", "difference"].includes(key)) return;
      const next = nextAuctionTeamSummarySort(reportSortKey, reportSortOrder, key);
      reportSortKey = next.key;
      reportSortOrder = next.order;
      renderTeamSpending();
      return;
    }
    const teamTarget = event.target.closest?.("[data-team-summary-team]");
    const teamId = teamTarget?.dataset.teamSummaryTeam;
    const select = document.getElementById("auction-report-team");
    if (!select || !reportTeams.some((team) => String(team.fantasyTeamId) === teamId)) {
      return;
    }
    select.value = teamId;
    reportPage = 1;
    renderTeamSpending();
    loadTeamReport(1);
  });
  teamSpending?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || event.target.closest?.("button")) return;
    const row = event.target.closest?.("tr[data-team-summary-team]");
    if (!row) return;
    event.preventDefault();
    row.querySelector(".auction-team-summary-name")?.click();
  });
  const idealSummary = document.getElementById("auction-ideal-pick-summary");
  idealSummary?.addEventListener("click", (event) => {
    const sortButton = event.target.closest?.("[data-ideal-sort]");
    if (sortButton) {
      idealPickSortOrder = idealPickSortOrder === "desc" ? "asc" : "desc";
      renderIdealPickSummary();
      return;
    }
    const teamTarget = event.target.closest?.("[data-ideal-team]");
    const teamId = teamTarget?.dataset.idealTeam;
    if (
      !teamId ||
      !idealPickData?.teams?.some(
        (team) => String(team.fantasyTeamId) === String(teamId),
      )
    ) {
      return;
    }
    idealPickTeamId = String(teamId);
    renderIdealPickSummary();
    loadIdealPickDetail(idealPickTeamId);
  });
  idealSummary?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || event.target.closest?.("button")) return;
    const row = event.target.closest?.("tr[data-ideal-team]");
    if (!row) return;
    event.preventDefault();
    row.querySelector(".auction-team-summary-name")?.click();
  });
  for (const id of ["auction-stage", "auction-outcome"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      page = 1;
      loadPlayers().catch(showError);
    });
  }
  document.getElementById("auction-sort")?.addEventListener("change", () => {
    sortExplicit = true;
    page = 1;
    loadPlayers().catch(showError);
  });
  for (const id of [
    "auction-bids-min",
    "auction-bids-max",
    "auction-stages-min",
    "auction-stages-max",
    "auction-amount-min",
    "auction-amount-max",
  ]) {
    document.getElementById(id)?.addEventListener("change", () => {
      page = 1;
      loadPlayers().catch(showError);
    });
  }
  document.getElementById("auction-reset-filters")?.addEventListener("click", () => {
    for (const id of [
      "auction-stage",
      "auction-outcome",
      "auction-q",
      "auction-bids-min",
      "auction-bids-max",
      "auction-stages-min",
      "auction-stages-max",
      "auction-amount-min",
      "auction-amount-max",
    ]) {
      const element = document.getElementById(id);
      if (element) element.value = "";
    }
    sortExplicit = false;
    setDefaultSort();
    page = 1;
    loadPlayers().catch(showError);
  });
  document.getElementById("auction-q")?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      loadPlayers().catch(showError);
    }, 300);
  });
}

let bound = false;

export async function startAuctionsView() {
  active = true;
  if (!bound) {
    bind();
    bound = true;
  }
  hideLegacyPageStatus();
  const fromUrl = auctionLeagueFromSearch();
  if (fromUrl) selectedScope = fromUrl;
  fillAuctionCompetitionSelect();
  await refreshProgress();
  await loadAuctions();
}

export function stopAuctionsView() {
  active = false;
  reportGeneration += 1;
  idealPickGeneration += 1;
  clearPoll();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
}

export function auctionPollingActive() {
  return active && timer != null;
}
