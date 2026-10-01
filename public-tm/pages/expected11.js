import {
  accountState,
  activeCompetitionId,
  apiJson,
  builderInitials,
  competitionResolve,
  competitions,
  esc,
  formatDate,
  formatUiDateTime,
  loadCompetitionsList,
  currentPage,
  PAGE_PATHS,
  replacePathQuery,
  setActiveCompetitionId,
  slugifyLeagueName,
  tr,
} from "../core.js?v=11";
import {
  expected11AggregateText,
  expected11NarrativeBlocks,
  expected11PlayerProfileUrl,
  expected11PositionsText,
  expected11ScopeText,
  expected11VisibleMatches,
} from "../expected11-view.js?v=3";

let expected11Loaded = false;
let expected11Data = null;
/** Tour from `?tour=` / `?round=` until the dropdown is filled. */
let expected11PendingTour = "";

/** Same slugs as /live and /xi — header Чемпионат option values stay TM ids. */
const EXPECTED11_TM_TO_SLUG = {
  PL1: "ekstraklasa",
  IT1: "serie-a",
  L1: "bundesliga",
  GB1: "premier-league",
  GB2: "championship",
  TR1: "super-lig",
};
const EXPECTED11_SLUG_TO_TM = Object.fromEntries(
  Object.entries(EXPECTED11_TM_TO_SLUG).map(([tm, slug]) => [slug, tm]),
);

function ingestSourceLine(label, source) {
  if (!source) return `${esc(tr(label))}: ${esc(tr("Нет данных"))}`;
  const when = source.extractedAt || source.importedAt;
  return `${esc(tr(label))}: ${source.matchCount ?? 0} · ${esc(
    when ? formatUiDateTime(when) : "—",
  )}`;
}

function expected11LeagueSlug(compId = activeCompetitionId) {
  const id = String(compId || "");
  return (
    EXPECTED11_TM_TO_SLUG[id] ||
    EXPECTED11_TM_TO_SLUG[id.toUpperCase()] ||
    competitionResolve.find((c) => c.id === id)?.slug ||
    expected11Data?.league?.slug ||
    ""
  );
}

function expected11LeagueParam() {
  return (
    expected11LeagueSlug() ||
    expected11Data?.league?.slug ||
    expected11Data?.league?.tmCompetition ||
    "championship"
  );
}

function isExpected11UiCompetitionId(id) {
  const key = String(id || "");
  return Boolean(EXPECTED11_TM_TO_SLUG[key] || EXPECTED11_TM_TO_SLUG[key.toUpperCase()]);
}

function resolveExpected11CompetitionId(param) {
  if (param == null || param === "") return null;
  const raw = String(param).trim();
  if (!raw) return null;
  const rawLower = raw.toLowerCase();
  const slug = slugifyLeagueName(raw);
  const compact = slug.replace(/-/g, "");
  const fromSlug = EXPECTED11_SLUG_TO_TM[rawLower] || EXPECTED11_SLUG_TO_TM[slug];
  if (fromSlug) return fromSlug;
  if (isExpected11UiCompetitionId(raw)) return raw.toUpperCase();
  const catalog = [...competitions, ...competitionResolve];
  const hit = catalog.find((c) => {
    const id = String(c.id || "");
    const path = String(c.slug || "");
    return (
      id === raw ||
      id.toLowerCase() === rawLower ||
      path === raw ||
      path === slug ||
      path.replace(/-/g, "") === compact ||
      slugifyLeagueName(c.name).replace(/-/g, "") === compact
    );
  });
  return hit?.id && isExpected11UiCompetitionId(hit.id) ? hit.id : null;
}

function expected11TourParam() {
  return (
    document.getElementById("expected11-tour")?.value || expected11PendingTour || ""
  );
}

function expected11Query(extra = {}) {
  const params = new URLSearchParams();
  const league = extra.league || expected11LeagueParam();
  const tour = extra.tour ?? expected11TourParam();
  if (league) params.set("league", league);
  if (tour) params.set("tour", tour);
  if (extra.matchId) params.set("matchId", extra.matchId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function syncExpected11Hash() {
  if (currentPage() !== "sorare") return;
  const qs = new URLSearchParams();
  const league = expected11LeagueSlug();
  const tour = expected11TourParam();
  if (league) qs.set("league", league);
  if (tour) qs.set("tour", String(tour));
  replacePathQuery(PAGE_PATHS.sorare, qs);
}

function tourOptionLabel(tour) {
  const start = tour.startAt ? formatDate(tour.startAt) : "";
  const end = tour.endAt ? formatDate(tour.endAt) : "";
  const dates = start && end && start !== end ? `${start} – ${end}` : start || end;
  return dates ? `${tr("Тур")} ${tour.round} · ${dates}` : `${tr("Тур")} ${tour.round}`;
}

function fillExpected11TourSelect(data) {
  const selector = document.getElementById("expected11-tour");
  if (!selector) return;
  const tours = data?.tours || [];
  const selected =
    data?.tour != null && tours.some((tour) => String(tour.round) === String(data.tour))
      ? String(data.tour)
      : selector.value && tours.some((tour) => String(tour.round) === selector.value)
        ? selector.value
        : String(tours.find((tour) => tour.current)?.round ?? tours[0]?.round ?? "");
  selector.replaceChildren();
  if (!tours.length) {
    selector.add(new Option(tr("Нет туров в расписании"), ""));
    return;
  }
  for (const tour of tours) {
    selector.add(new Option(tourOptionLabel(tour), String(tour.round)));
  }
  selector.value = selected;
}

function fillExpected11CompetitionSelect() {
  const sel = document.getElementById("competition-select");
  if (!sel) return;
  let options = competitions.slice();
  if (!options.length) {
    sel.innerHTML = `<option value="${activeCompetitionId}">${activeCompetitionId}</option>`;
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId)) {
    setActiveCompetitionId(options[0].id);
  }
  sel.innerHTML = options
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`)
    .join("");
  sel.value = activeCompetitionId;
}

function renderExpected11Ingest(data) {
  const el = document.getElementById("expected11-ingest");
  if (!el) return;
  const canEdit = Boolean(
    accountState.entitlements?.expected11Admin || data?.canEditUrls,
  );
  if (!canEdit) {
    el.replaceChildren();
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const urls = Array.isArray(data?.ingest?.urls) ? data.ingest.urls.join("\n") : "";
  const skipped = data?.ingest?.skipped || [];
  el.innerHTML = `
    <h2>${esc(tr("Разбор Expected11"))}</h2>
    <p class="meta">${esc(
      tr(
        "Вставь ссылки expected11.com — по одной на строку. Пересобрать открывает установленный Google Chrome (профиль data/expected11/chrome-profile), как npm run expected11:web. В этом окне войди email и паролем Expected11 (не Google). Анонимный HTML XI% не видит.",
      ),
    )}</p>
    <form id="expected11-ingest-form" class="expected11-ingest-form">
      <label>
        ${esc(tr("Ссылки expected11.com"))}
        <textarea id="expected11-urls" name="urls" rows="6" autocomplete="off"
          placeholder="https://expected11.com/match/…">${esc(urls)}</textarea>
      </label>
      <div class="expected11-ingest-actions">
        <button type="submit" class="col-picker-btn" id="expected11-ingest-save">
          ${esc(tr("Сохранить ссылки"))}
        </button>
        <button type="button" class="col-picker-btn" id="expected11-ingest-rebuild">
          ${esc(tr("Пересобрать"))}
        </button>
        <p class="account-message" id="expected11-ingest-status" role="status"></p>
      </div>
    </form>
    ${
      skipped.length
        ? `<p class="meta">${esc(tr("Пропущено"))}: ${skipped
            .map((row) => `${esc(row.url)} (${esc(row.error)})`)
            .join(" · ")}</p>`
        : ""
    }`;
}

function renderMappingIngest(data) {
  const el = document.getElementById("mapping-ingest");
  if (!el) return;
  const tours = data?.ingest?.tours || [];
  if (!tours.length && !data?.ingest?.matchCount) {
    el.replaceChildren();
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const lines = tours.length
    ? tours.map(
        (tour) =>
          `<p class="meta">${ingestSourceLine(
            `${tour.league} · ${tr("Тур")} ${tour.tour}`,
            tour,
          )}</p>`,
      )
    : [`<p class="meta">${ingestSourceLine("Разбор Expected11", data.ingest)}</p>`];
  el.innerHTML = `
    <h2>${esc(tr("Разбор Expected11"))}</h2>
    ${lines.join("")}`;
}

function expected11PlayerRow(player) {
  const percentage =
    player.displayedPercentage == null ? "—" : `${Number(player.displayedPercentage)}%`;
  const profileUrl = expected11PlayerProfileUrl(player);
  const status =
    player.linkStatus === "ambiguous"
      ? tr("неоднозначно")
      : player.linkStatus !== "linked"
        ? tr("не найден")
        : profileUrl
          ? ""
          : tr("Профиль недоступен");
  const name = profileUrl
    ? `<a href="${esc(profileUrl)}" title="${esc(
        player.fullName || player.sourceName,
      )}">${esc(player.surname || player.sourceName)}</a>`
    : `<span class="expected11-player-name">${esc(player.sourceName)}${
        status ? `<small>${esc(status)}</small>` : ""
      }</span>`;
  return `<li class="expected11-player">
    ${name}
    <span class="expected11-percentage">${esc(percentage)}</span>
    <span class="expected11-position">${esc(expected11PositionsText(player))}</span>
  </li>`;
}

function expected11Narratives(team, match) {
  const blocks = expected11NarrativeBlocks(team, true);
  return `<section class="expected11-narratives" aria-label="${esc(
    tr("Комментарий аналитика"),
  )}">
    <h3>${esc(tr("Комментарий аналитика"))}</h3>
    <dl>${blocks
      .map(
        ({ label, text }) =>
          `<div><dt>${esc(tr(label))}</dt><dd>${esc(text)}</dd></div>`,
      )
      .join("")}</dl>
    <p class="meta">${esc(tr("Аналитик"))}: ${esc(team.author || "—")} ·
      <a href="${esc(match.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(
        tr("Источник"),
      )}: expected11.com ↗</a> ·
      ${esc(tr("Обновлено"))}: ${esc(formatUiDateTime(match.extractedAt))}
    </p>
  </section>`;
}

function expected11MatchFilterLabel() {
  return document.getElementById("expected11-filter")?.closest(".expected11-filter");
}

function renderExpected11Gazette(data) {
  const url = data?.gazette?.url;
  if (!url) return false;
  const meta = document.getElementById("expected11-meta");
  const scope = document.getElementById("expected11-match");
  const results = document.getElementById("expected11-clubs");
  const selector = document.getElementById("expected11-filter");
  const filterLabel = expected11MatchFilterLabel();
  if (filterLabel) filterLabel.hidden = true;
  if (selector) selector.replaceChildren(new Option("Все матчи / все клубы", ""));
  const leagueName = data.league?.name || "";
  meta.textContent = leagueName
    ? `Газетка · ${leagueName} · ${tr("Тур")} ${data.tour}`
    : `Газетка · ${tr("Тур")} ${data.tour}`;
  if (scope) {
    scope.replaceChildren();
    scope.hidden = true;
  }
  results.innerHTML = `<iframe class="expected11-gazette" src="${esc(
    url,
  )}" title="${esc(tr("Газетка"))}"></iframe>`;
  return true;
}

function renderExpected11(data) {
  const meta = document.getElementById("expected11-meta");
  const scope = document.getElementById("expected11-match");
  const results = document.getElementById("expected11-clubs");
  const selector = document.getElementById("expected11-filter");
  expected11Data = data;
  fillExpected11TourSelect(data);
  expected11PendingTour = "";
  syncExpected11Hash();
  renderExpected11Ingest(data);
  const filterLabel = expected11MatchFilterLabel();
  if (filterLabel) filterLabel.hidden = false;
  if (scope) scope.hidden = false;
  if (renderExpected11Gazette(data)) return;
  if (!data.matches?.length) {
    meta.textContent = "Прогнозы Expected 11 ещё не импортированы";
    scope.innerHTML = `<p class="live-empty">Нет данных</p>`;
    results.replaceChildren();
    selector.replaceChildren(new Option("Все матчи / все клубы", ""));
    return;
  }
  const selectedMatchId = data.matches.some((match) => match.id === selector.value)
    ? selector.value
    : "";
  selector.replaceChildren(new Option("Все матчи / все клубы", ""));
  for (const match of data.matches) {
    selector.add(new Option(match.title, match.id));
  }
  selector.value = selectedMatchId;
  const visibleMatches = expected11VisibleMatches(data, selectedMatchId);
  meta.textContent = expected11AggregateText(data);
  scope.innerHTML = `
    <h2>${selectedMatchId ? "Выбранный матч" : "Все матчи / все клубы"}</h2>
    <p class="meta">${esc(expected11ScopeText(data, selectedMatchId))}</p>`;
  results.innerHTML = visibleMatches
    .map((match) => {
      const clubs = match.teams
        .map((team) => {
          const groups = [
            ["starting", "STARTING"],
            ["bench", "BENCH"],
            ["out", "OUT"],
          ]
            .map(([key, label]) => {
              const players = team.players.filter((player) => player.lineupGroup === key);
              return `<section class="expected11-group">
                <h3>${label}</h3>
                <div class="expected11-player expected11-player-header" aria-hidden="true">
                  <span>${esc(tr("Игрок"))}</span>
                  <span>${esc(tr("Expected11, %"))}</span>
                  <span>${esc(tr("Позиции Mantra"))}</span>
                </div>
                <ul class="expected11-list">${
                  players.length
                    ? players.map(expected11PlayerRow).join("")
                    : `<li class="live-empty">Нет игроков</li>`
                }</ul>
              </section>`;
            })
            .join("");
          return `<article class="expected11-club">
            <h2>${esc(team.mantraClubName || team.sourceName)}</h2>
            <p class="meta">${
              team.linkStatus === "linked"
                ? "Связано с Mantra"
                : `Mantra: ${esc(team.linkStatus)}`
            }</p>
            ${groups}
            ${selectedMatchId ? expected11Narratives(team, match) : ""}
          </article>`;
        })
        .join("");
      return `<section class="expected11-match-group">
        <header class="expected11-match-header">
          <div>
            <h2>${esc(match.title)}</h2>
            <p class="meta">
              В этом матче: ${match.teams.length} клуба · связано ${match.counts.linked} ·
              не найдено ${match.counts.unmatched} · неоднозначно ${match.counts.ambiguous}
            </p>
            <p class="meta">Expected 11 · ${esc(formatUiDateTime(match.extractedAt))}</p>
          </div>
          <a href="${esc(match.sourceUrl)}" target="_blank" rel="noopener noreferrer">
            Источник: expected11.com ↗
          </a>
        </header>
        <div class="expected11-clubs">${clubs}</div>
      </section>`;
    })
    .join("");
}

async function loadExpected11({ force = false, matchId = "" } = {}) {
  if (expected11Loaded && !force) return;
  document.getElementById("expected11-meta").textContent =
    "Загрузка прогнозов Expected 11…";
  const data = await apiJson(`/api/expected11${expected11Query({ matchId })}`);
  renderExpected11(data);
  expected11Loaded = true;
}

async function submitExpected11Ingest(mode) {
  const status = document.getElementById("expected11-ingest-status");
  const saveButton = document.getElementById("expected11-ingest-save");
  const rebuildButton = document.getElementById("expected11-ingest-rebuild");
  const urls = document.getElementById("expected11-urls")?.value || "";
  const league = expected11LeagueParam();
  const tour = Number(expected11TourParam());
  if (saveButton) saveButton.disabled = true;
  if (rebuildButton) rebuildButton.disabled = true;
  if (status) status.textContent = mode === "rebuild" ? tr("Парсинг…") : tr("Сохранение…");
  try {
    const path = mode === "rebuild" ? "/api/expected11/rebuild" : "/api/expected11/urls";
    const result = await apiJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        league,
        tour,
        ...(mode === "save" || urls.trim() ? { urls } : {}),
      }),
    });
    expected11Loaded = true;
    renderExpected11(result);
    const nextStatus = document.getElementById("expected11-ingest-status");
    if (nextStatus) {
      nextStatus.textContent =
        mode === "rebuild"
          ? `${tr("Разобрано")}: ${result.import?.importedMatches ?? result.matches?.length ?? 0}${
              result.ingest?.lastError ? ` · ${result.ingest.lastError}` : ""
            }`
          : tr("Сохранено");
    }
  } catch (error) {
    if (status) status.textContent = `Ошибка: ${error.message}`;
  } finally {
    if (saveButton) saveButton.disabled = false;
    if (rebuildButton) rebuildButton.disabled = false;
  }
}

let mappingData = null;

function mappingLeagueFilter() {
  return document.getElementById("mapping-league")?.value || "";
}

function mappingLeagueMatches(row, selected) {
  if (!selected) return true;
  return row?.league === selected || row?.tmCompetition === selected;
}

function fillMappingLeagueSelect(data) {
  const select = document.getElementById("mapping-league");
  if (!select) return;
  const selected = select.value;
  const leagues = data.leagues || [];
  select.innerHTML =
    `<option value="">Все лиги</option>` +
    leagues
      .map((league) => `<option value="${esc(league.slug)}">${esc(league.name)}</option>`)
      .join("");
  if (leagues.some((league) => league.slug === selected)) select.value = selected;
}

function renderMapping(data) {
  mappingData = data;
  fillMappingLeagueSelect(data);
  renderMappingIngest(data);
  const selected = mappingLeagueFilter();
  const selectedName =
    (data.leagues || []).find((league) => league.slug === selected)?.name || selected;
  const groups = (data.groups || []).filter((group) =>
    mappingLeagueMatches(group, selected),
  );
  const mappings = (data.mappings || []).filter((mapping) =>
    mappingLeagueMatches(mapping, selected),
  );
  document.getElementById("mapping-meta").textContent =
    `Связано ${data.counts?.linked ?? 0} · не найдено ${data.counts?.unmatched ?? 0} · ` +
    `неоднозначно ${data.counts?.ambiguous ?? 0}` +
    (selected ? ` · ${selectedName}` : "");
  const results = document.getElementById("mapping-results");
  results.innerHTML = groups.length
    ? groups
        .map(
          (group, groupIndex) => `
            <article class="mapping-group">
              <header class="expected11-match-header">
                <div>
                  <h2>${esc(group.mantraClubName)}</h2>
                  <p class="meta">${
                    group.leagueName || group.league
                      ? `${esc(group.leagueName || group.league)} · `
                      : ""
                  }${esc(group.matchTitle)} · ${esc(formatUiDateTime(group.extractedAt))}</p>
                </div>
                <a href="${esc(group.sourceUrl)}" target="_blank" rel="noopener noreferrer">Expected 11 ↗</a>
              </header>
              <div class="mapping-player-list">
                ${(group.players || [])
                  .map((player, playerIndex) => {
                    const selectId = `mapping-target-${groupIndex}-${playerIndex}`;
                    return `<div class="mapping-player">
                      <div>
                        <strong>${esc(player.sourceName)}</strong>
                        <span>${esc(String(player.lineupGroup).toUpperCase())} · ${
                          player.displayedPercentage == null
                            ? "—"
                            : `${esc(player.displayedPercentage)}%`
                        }</span>
                      </div>
                      <select id="${selectId}" class="mapping-target">
                        <option value="">Выбери игрока Mantra…</option>
                        ${(group.candidates || [])
                          .map(
                            (candidate) =>
                              `<option value="${candidate.id}">${esc(candidate.fullName)} · ${esc(
                                candidate.position || "—",
                              )} · #${candidate.id}</option>`,
                          )
                          .join("")}
                      </select>
                      <button type="button" class="col-picker-btn mapping-save"
                        data-select="${selectId}"
                        data-source="${esc(player.sourceName)}"
                        data-club="${group.mantraClubId}">Связать</button>
                    </div>`;
                  })
                  .join("")}
              </div>
            </article>`,
        )
        .join("")
    : `<p class="live-empty">${
        selected ? "Нет несвязанных игроков в этой лиге" : "Все игроки связаны"
      }</p>`;

  const audit = document.getElementById("mapping-audit");
  audit.innerHTML = mappings.length
    ? mappings
        .map(
          (mapping) => `<div class="mapping-audit-row">
            <span><strong>${esc(mapping.normalizedSourceName)}</strong> → ${esc(
              mapping.mantraPlayerName || mapping.mantraSurname,
            )} · #${mapping.mantraPlayerId}</span>
            <span class="meta">${
              mapping.leagueName || mapping.league
                ? `${esc(mapping.leagueName || mapping.league)} · `
                : ""
            }${esc(mapping.mappedBy)} · ${esc(
              formatUiDateTime(mapping.updatedAt),
            )}</span>
            <button type="button" class="col-picker-btn danger mapping-remove"
              data-source="${esc(mapping.normalizedSourceName)}"
              data-club="${mapping.mantraClubId}">Удалить</button>
          </div>`,
        )
        .join("")
    : `<p class="meta">${
        selected ? "Нет ручных связей в этой лиге" : "Ручных связей пока нет"
      }</p>`;
}

function applyLinkedMapping(result, sourceName, mantraClubId) {
  if (!mappingData) return;
  mappingData.counts = result.counts;
  const group = (mappingData.groups || []).find(
    (row) => Number(row.mantraClubId) === Number(mantraClubId),
  );
  mappingData.groups = (mappingData.groups || [])
    .map((row) => {
      if (Number(row.mantraClubId) !== Number(mantraClubId)) return row;
      return {
        ...row,
        players: (row.players || []).filter(
          (player) => player.sourceName !== sourceName,
        ),
      };
    })
    .filter((row) => (row.players || []).length > 0);
  const mapping = result.mapping;
  mappingData.mappings = [
    {
      ...mapping,
      league: mapping.league || group?.league || null,
      leagueName: mapping.leagueName || group?.leagueName || null,
      tmCompetition: mapping.tmCompetition || group?.tmCompetition || null,
    },
    ...(mappingData.mappings || []).filter(
      (row) =>
        !(
          row.normalizedSourceName === mapping.normalizedSourceName &&
          Number(row.mantraClubId) === Number(mapping.mantraClubId)
        ),
    ),
  ];
}

async function loadMapping() {
  document.getElementById("mapping-meta").textContent =
    "Загрузка несвязанных игроков…";
  renderMapping(await apiJson("/api/expected11/mapping"));
}

let sorareLoaded = false;
let sorareLeagueView = null;
let sorareTeamView = null;
let sorareGameView = null;
let sorarePrivateProjectionMap = new Map();

function sorarePct(value) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : `${Math.round(Number(value) * 100)}%`;
}

function sorarePrivatePct(value) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : `${Math.round(Number(value))}%`;
}

function sorarePrivateProjection(player) {
  return sorarePrivateProjectionMap.get(player?.slug) || null;
}

function sorarePrivateMetrics(projection) {
  if (!projection) return "";
  const metrics = [
    projection.projectedScore != null ? `PS ${Math.round(projection.projectedScore)}` : null,
    projection.teamWinOdds != null ? `W ${sorarePrivatePct(projection.teamWinOdds)}` : null,
    projection.playerExpectedGoals != null ? `xG ${Number(projection.playerExpectedGoals).toFixed(2)}` : null,
    projection.teamCleanSheetOdds != null
      ? `CS ${sorarePrivatePct(projection.teamCleanSheetOdds)}`
      : null,
  ].filter(Boolean);
  return metrics.length
    ? `<span class="sorare-private-metrics">${metrics.map(esc).join(" · ")}</span>`
    : "";
}

function sorarePlayerCard(player) {
  const privateProjection = sorarePrivateProjection(player);
  const photo = player.pictureUrl
    ? `<img src="${esc(player.pictureUrl)}" alt="" loading="lazy" />`
    : `<span class="sorare-player-fallback">${esc(builderInitials(player.name))}</span>`;
  return `<article class="sorare-player-card">
    ${photo}
    <span class="sorare-player-name">${esc(player.name)}</span>
    <span class="sorare-player-pos">${esc(player.position || "—")}</span>
    ${
      privateProjection?.startingPercentage != null
        ? `<strong>${sorarePrivatePct(privateProjection.startingPercentage)}</strong>`
        : player.starter != null
          ? `<strong>${sorarePct(player.starter)}</strong>`
          : ""
    }
    ${sorarePrivateMetrics(privateProjection)}
  </article>`;
}

function sorarePrivateExpectedXi(teamSlug, players) {
  const candidates = players
    .map((player) => ({ player, projection: sorarePrivateProjection(player) }))
    .filter(
      (item) =>
        item.projection &&
        (item.projection.teamSlug == null || item.projection.teamSlug === teamSlug) &&
        item.projection.startingPercentage != null,
    );
  const quotas = { Goalkeeper: 1, Defender: 4, Midfielder: 3, Forward: 3 };
  const selected = [];
  for (const [position, count] of Object.entries(quotas)) {
    selected.push(
      ...candidates
        .filter((item) => item.player.position === position)
        .sort((a, b) => b.projection.startingPercentage - a.projection.startingPercentage)
        .slice(0, count)
        .map((item) => item.player),
    );
  }
  return selected;
}

function renderSorareTeam() {
  const profile = document.getElementById("sorare-profile");
  const expected = document.getElementById("sorare-expected");
  const players = document.getElementById("sorare-players");
  if (!profile || !expected || !players) return;
  if (!sorareTeamView) {
    profile.hidden = true;
    expected.innerHTML = `<p class="live-empty">Выбери команду</p>`;
    players.innerHTML = `<tr><td colspan="6">Нет данных</td></tr>`;
    return;
  }
  const { team } = sorareTeamView;
  const privateExpected = sorarePrivateExpectedXi(team.slug, sorareTeamView.players);
  const expectedXi = privateExpected.length ? privateExpected : sorareTeamView.expectedXi;
  profile.hidden = false;
  profile.innerHTML = `
    ${team.pictureUrl ? `<img src="${esc(team.pictureUrl)}" alt="" />` : ""}
    <div>
      <h2>${esc(team.name)}</h2>
      <p class="meta">${esc(team.country?.name || "—")}${
        team.ranking != null ? ` · #${team.ranking}` : ""
      }${team.founded ? ` · ${esc(team.founded)}` : ""}</p>
      <p class="meta">Sorare · ${sorareTeamView.stale ? "кэш" : "live"} · ${esc(
        formatDate(sorareTeamView.fetchedAt),
      )}</p>
    </div>`;
  expected.innerHTML = expectedXi.length
    ? expectedXi.map(sorarePlayerCard).join("")
    : `<p class="live-empty">SorareInside ещё не опубликовал вероятности</p>`;
  document.getElementById("sorare-expected-meta").textContent = expectedXi.length
    ? `4-3-3 · ${expectedXi.length}/11 · ${
        privateExpected.length ? "Browser import" : "SorareInside"
      }`
    : "Появится после публикации вероятностей SorareInside";
  players.innerHTML = sorareTeamView.players.length
    ? sorareTeamView.players
        .map(
          (player) => {
            const privateProjection = sorarePrivateProjection(player);
            return `<tr>
            <td><span class="sorare-player-cell">${
              player.pictureUrl ? `<img src="${esc(player.pictureUrl)}" alt="" loading="lazy" />` : ""
            }<span>${esc(player.name)}${sorarePrivateMetrics(privateProjection)}</span></span></td>
            <td>${esc(player.position || "—")}</td>
            <td class="num">${
              privateProjection?.startingPercentage != null
                ? sorarePrivatePct(privateProjection.startingPercentage)
                : sorarePct(player.prediction?.starter)
            }</td>
            <td class="num">${sorarePct(player.prediction?.substitute)}</td>
            <td class="num">${sorarePct(player.prediction?.nonPlaying)}</td>
            <td>${esc(privateProjection?.reliability || player.prediction?.reliability || "—")}</td>
          </tr>`;
          },
        )
        .join("")
    : `<tr><td colspan="6">Нет игроков</td></tr>`;
}

async function loadSorareInsideProjections(gameId) {
  sorarePrivateProjectionMap = new Map();
  const connection = accountState.sorareInside;
  if (!accountState.authenticated || !connection?.connected || !gameId) {
    renderSorareTeam();
    return;
  }
  const leagueSlug = document.getElementById("sorare-league").value;
  try {
    const data = await apiJson(
      `/api/sorare/leagues/${encodeURIComponent(leagueSlug)}/games/${encodeURIComponent(
        gameId,
      )}/private-projections`,
    );
    sorarePrivateProjectionMap = new Map(
      (data.projections || []).map((projection) => [projection.playerSlug, projection]),
    );
    renderSorareTeam();
    const status = document.getElementById("sorare-private-status");
    if (status) {
      status.textContent = `Browser import · ${data.projections?.length || 0} projections`;
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 409) {
      accountState.sorareInside = {
        ...connection,
        connected: false,
        status: error.status === 401 ? "expired" : "disconnected",
      };
      renderSorareInsideConnection();
    }
    renderSorareTeam();
  }
}

function renderSorareConfirmedSide(label, formation) {
  if (!formation?.available) {
    return `<article><h3>${esc(label)}</h3><p class="live-empty">Состав ещё не опубликован</p></article>`;
  }
  const starters = formation.rows.flat();
  return `<article>
    <h3>${esc(label)}</h3>
    <div class="sorare-confirmed-list">${starters.map(sorarePlayerCard).join("")}</div>
    <p class="meta">Запас: ${formation.bench.map((player) => esc(player.name)).join(", ") || "—"}</p>
  </article>`;
}

function renderSorareGame() {
  const confirmed = document.getElementById("sorare-confirmed");
  const oddsEl = document.getElementById("sorare-odds");
  if (!confirmed || !oddsEl) return;
  if (!sorareGameView) {
    confirmed.innerHTML = `<p class="live-empty">Выбери матч</p>`;
    oddsEl.innerHTML = `<p class="live-empty">Нет данных</p>`;
    return;
  }
  const game = sorareGameView.game;
  confirmed.innerHTML =
    renderSorareConfirmedSide(game.homeTeam?.name || "Home", sorareGameView.homeFormation) +
    renderSorareConfirmedSide(game.awayTeam?.name || "Away", sorareGameView.awayFormation);
  document.getElementById("sorare-confirmed-meta").textContent =
    sorareGameView.homeFormation.available || sorareGameView.awayFormation.available
      ? `${formatDate(game.date)} · Sorare`
      : "Появится после публикации состава";

  const local = sorareGameView.bookmakerOdds;
  const fallback = sorareGameView.sorareOdds;
  if (local) {
    oddsEl.innerHTML = `
      <p class="meta">${esc(local.bookmaker || "API-Football")} · ${formatDate(local.kickoff || game.date)}</p>
      <div class="sorare-odds-grid">
        <div><span>1</span><strong>${Number(local.homeOdd).toFixed(2)}</strong><small>${sorarePct(local.homeWinProb)}</small></div>
        <div><span>X</span><strong>${Number(local.drawOdd).toFixed(2)}</strong><small>${sorarePct(local.drawProb)}</small></div>
        <div><span>2</span><strong>${Number(local.awayOdd).toFixed(2)}</strong><small>${sorarePct(local.awayWinProb)}</small></div>
      </div>`;
  } else if (fallback && [fallback.home, fallback.draw, fallback.away].some((value) => value != null)) {
    oddsEl.innerHTML = `
      <p class="meta">Sorare probabilities · bookmaker недоступен</p>
      <div class="sorare-odds-grid">
        <div><span>1</span><strong>${sorarePct(fallback.home)}</strong></div>
        <div><span>X</span><strong>${sorarePct(fallback.draw)}</strong></div>
        <div><span>2</span><strong>${sorarePct(fallback.away)}</strong></div>
      </div>`;
  } else {
    oddsEl.innerHTML = `<p class="live-empty">Коэффициенты пока недоступны</p>`;
  }
}

async function loadSorareTeam(teamSlug) {
  if (!teamSlug || !sorareLeagueView) {
    sorareTeamView = null;
    renderSorareTeam();
    return;
  }
  const leagueSlug = document.getElementById("sorare-league").value;
  document.getElementById("sorare-meta").textContent = "Загрузка профиля команды…";
  try {
    sorareTeamView = await apiJson(
      `/api/sorare/leagues/${encodeURIComponent(leagueSlug)}/teams/${encodeURIComponent(teamSlug)}`,
    );
    renderSorareTeam();
    document.getElementById("sorare-meta").textContent = `${sorareTeamView.team.name} · ${
      sorareTeamView.players.length
    } игроков`;
  } catch (error) {
    document.getElementById("sorare-meta").textContent = `Ошибка Sorare: ${error.message}`;
  }
}

async function loadSorareGame(gameId) {
  if (!gameId || !sorareLeagueView) {
    sorareGameView = null;
    renderSorareGame();
    return;
  }
  const leagueSlug = document.getElementById("sorare-league").value;
  try {
    sorareGameView = await apiJson(
      `/api/sorare/leagues/${encodeURIComponent(leagueSlug)}/games/${encodeURIComponent(gameId)}`,
    );
    renderSorareGame();
    await loadSorareInsideProjections(gameId);
  } catch (error) {
    document.getElementById("sorare-meta").textContent = `Ошибка Sorare: ${error.message}`;
  }
}

async function loadSorareLeague(leagueSlug) {
  const gameSelect = document.getElementById("sorare-game");
  const teamSelect = document.getElementById("sorare-team");
  document.getElementById("sorare-meta").textContent = "Загрузка матчей Sorare…";
  sorareLeagueView = await apiJson(`/api/sorare/leagues/${encodeURIComponent(leagueSlug)}`);
  gameSelect.innerHTML =
    `<option value="">Выбери матч…</option>` +
    sorareLeagueView.games
      .map(
        (game) =>
          `<option value="${esc(game.id)}">${esc(game.homeTeam?.name || "—")} — ${esc(
            game.awayTeam?.name || "—",
          )} · ${esc(formatDate(game.date))}</option>`,
      )
      .join("");
  teamSelect.innerHTML =
    `<option value="">Выбери команду…</option>` +
    sorareLeagueView.teams
      .map((team) => `<option value="${esc(team.slug)}">${esc(team.name)}</option>`)
      .join("");
  const firstGame = sorareLeagueView.games[0];
  if (firstGame) {
    gameSelect.value = firstGame.id;
    const firstTeam = firstGame.homeTeam?.slug || sorareLeagueView.teams[0]?.slug;
    if (firstTeam) teamSelect.value = firstTeam;
    await Promise.all([loadSorareGame(firstGame.id), loadSorareTeam(firstTeam)]);
  } else {
    document.getElementById("sorare-meta").textContent = "Нет предстоящих матчей";
  }
}

async function ensureSorareLoaded() {
  if (!sorareLoaded) {
    const data = await apiJson("/api/sorare/leagues");
    const select = document.getElementById("sorare-league");
    select.innerHTML = data.leagues
      .map((league) => `<option value="${esc(league.id)}">${esc(league.name)}</option>`)
      .join("");
    const preferred = localStorage.getItem("sorareLeague") || "premier-league";
    select.value = data.leagues.some((league) => league.id === preferred)
      ? preferred
      : data.leagues[0]?.id || "";
    sorareLoaded = true;
  }
  const league = document.getElementById("sorare-league").value;
  if (league) await loadSorareLeague(league);
}

document.getElementById("sorare-league")?.addEventListener("change", async (event) => {
  const league = event.target.value;
  if (!league) return;
  localStorage.setItem("sorareLeague", league);
  sorareTeamView = null;
  sorareGameView = null;
  renderSorareTeam();
  renderSorareGame();
  try {
    await loadSorareLeague(league);
  } catch (error) {
    document.getElementById("sorare-meta").textContent = `Ошибка Sorare: ${error.message}`;
  }
});
document.getElementById("sorare-team")?.addEventListener("change", (event) => {
  loadSorareTeam(event.target.value);
});
document.getElementById("sorare-game")?.addEventListener("change", (event) => {
  loadSorareGame(event.target.value);
});
document.getElementById("expected11-refresh")?.addEventListener("click", () => {
  loadExpected11({
    force: true,
    matchId: document.getElementById("expected11-filter")?.value || "",
  }).catch((error) => {
    document.getElementById("expected11-meta").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("competition-select")?.addEventListener("change", (event) => {
  if (currentPage() !== "sorare") return;
  setActiveCompetitionId(event.target.value);
  expected11PendingTour = "";
  const tourSelect = document.getElementById("expected11-tour");
  if (tourSelect) tourSelect.value = "";
  syncExpected11Hash();
  loadExpected11({ force: true }).catch((error) => {
    document.getElementById("expected11-meta").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("expected11-tour")?.addEventListener("change", () => {
  loadExpected11({ force: true }).catch((error) => {
    document.getElementById("expected11-meta").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("expected11-ingest")?.addEventListener("click", async (event) => {
  if (event.target?.id !== "expected11-ingest-rebuild") return;
  event.preventDefault();
  await submitExpected11Ingest("rebuild");
});
document.getElementById("expected11-ingest")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitExpected11Ingest("save");
});
document.getElementById("expected11-filter")?.addEventListener("change", () => {
  const matchId = document.getElementById("expected11-filter")?.value || "";
  loadExpected11({ force: true, matchId }).catch((error) => {
    document.getElementById("expected11-meta").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("mapping-refresh")?.addEventListener("click", () => {
  loadMapping().catch((error) => {
    document.getElementById("mapping-status").textContent = `Ошибка: ${error.message}`;
  });
});
document.getElementById("mapping-league")?.addEventListener("change", () => {
  if (!mappingData) return;
  renderMapping(mappingData);
});
function mappingWait(ms) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mappingFlash(el, className) {
  if (!el) return;
  el.classList.remove("is-link-ok", "is-link-fail", "is-leaving", "is-ok", "is-err");
  void el.offsetWidth;
  el.classList.add(className);
}

document.getElementById("mapping-results")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".mapping-save");
  if (!button) return;
  const row = button.closest(".mapping-player");
  const target = document.getElementById(button.dataset.select);
  const mantraPlayerId = Number(target?.value);
  const status = document.getElementById("mapping-status");
  if (!Number.isSafeInteger(mantraPlayerId) || mantraPlayerId <= 0) {
    status.textContent = "Выбери игрока Mantra из того же клуба.";
    mappingFlash(status, "is-err");
    mappingFlash(row, "is-link-fail");
    return;
  }
  button.disabled = true;
  try {
    const result = await apiJson("/api/expected11/mapping", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceName: button.dataset.source,
        mantraClubId: Number(button.dataset.club),
        mantraPlayerId,
      }),
    });
    status.textContent =
      `Связано: ${result.mapping.sourceName} → ${result.mapping.mantraPlayerName}. ` +
      `Итого ${result.counts.linked}, не найдено ${result.counts.unmatched}.`;
    mappingFlash(status, "is-ok");
    mappingFlash(row, "is-link-ok");
    button.textContent = "Связано";
    applyLinkedMapping(result, button.dataset.source, Number(button.dataset.club));
    await mappingWait(420);
    row?.classList.add("is-leaving");
    await mappingWait(280);
    expected11Loaded = false;
    renderMapping(mappingData);
  } catch (error) {
    status.textContent = `Ошибка: ${error.message}`;
    mappingFlash(status, "is-err");
    mappingFlash(row, "is-link-fail");
    button.disabled = false;
  }
});
document.getElementById("mapping-audit")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".mapping-remove");
  if (!button) return;
  const status = document.getElementById("mapping-status");
  button.disabled = true;
  try {
    const result = await apiJson("/api/expected11/mapping", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceName: button.dataset.source,
        mantraClubId: Number(button.dataset.club),
      }),
    });
    status.textContent =
      `Связь удалена. Связано ${result.counts.linked}, не найдено ${result.counts.unmatched}.`;
    expected11Loaded = false;
    await loadMapping();
  } catch (error) {
    status.textContent = `Ошибка: ${error.message}`;
    button.disabled = false;
  }
});
export async function start(page) {
  if (page === "mapping" && !accountState.entitlements?.expected11Admin) {
    location.replace("/clubs");
    return;
  }
  try {
    if (page === "mapping") await loadMapping();
    else {
      await loadCompetitionsList();
      const qs = new URLSearchParams(location.search);
      const fromParam = resolveExpected11CompetitionId(qs.get("league"));
      if (fromParam) setActiveCompetitionId(fromParam);
      expected11PendingTour = qs.get("tour") || qs.get("round") || "";
      fillExpected11CompetitionSelect();
      syncExpected11Hash();
      await loadExpected11();
    }
  } catch (err) {
    const id = page === "mapping" ? "mapping-meta" : "expected11-meta";
    const el = document.getElementById(id);
    if (el) el.textContent = `Ошибка: ${err.message}`;
  }
}
