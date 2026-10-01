import {
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
  apiJson,
} from "../core.js?v=11";

let livePayload = null;
/** @type {string | null} selected round tab; null follows server currentRound */
let liveSelectedRound = null;
/** When false, polls follow server currentRound (auto-open next tour). */
let livePinnedRound = false;
/** @type {number | null} */
let liveSelectedId = null;
/** @type {ReturnType<typeof setInterval> | null} */
let liveClientTimer = null;
let liveLoading = false;
/** Bumps on each live fetch so rapid switches keep the latest response. */
let liveFetchGen = 0;
/** Same Latin names as the header league selector — not i18n Cyrillic. */
const LIVE_SELECT_LABELS = {
  ekstraklasa: "Ekstraklasa",
  "premier-league": "Premier League",
  championship: "Championship",
  "super-lig": "Süper Lig",
  "serie-a": "Serie A",
  bundesliga: "Bundesliga",
};
/** Live `#live` dropdown: only leagues wired in `/live/leagues`. */
const LIVE_SELECT_FALLBACK = [
  { slug: "ekstraklasa", name: LIVE_SELECT_LABELS.ekstraklasa, tmCompetition: "PL1" },
  { slug: "serie-a", name: LIVE_SELECT_LABELS["serie-a"], tmCompetition: "IT1" },
  { slug: "bundesliga", name: LIVE_SELECT_LABELS.bundesliga, tmCompetition: "L1" },
  { slug: "premier-league", name: LIVE_SELECT_LABELS["premier-league"], tmCompetition: "GB1" },
  { slug: "championship", name: LIVE_SELECT_LABELS.championship, tmCompetition: "GB2" },
  { slug: "super-lig", name: LIVE_SELECT_LABELS["super-lig"], tmCompetition: "TR1" },
];
/** @type {{ slug: string, name: string, tmCompetition: string }[]} */
let liveLeaguesCatalog = [];

function liveSelectCompetitions(allCompetitions, liveLeagues) {
  const catalog = liveLeagues?.length ? liveLeagues : LIVE_SELECT_FALLBACK;
  const byId = new Map((allCompetitions || []).map((c) => [c.id, c]));
  return catalog.map((l) => {
    const c = byId.get(l.tmCompetition);
    return {
      ...(c || { id: l.tmCompetition, name: l.name }),
      liveSlug: l.slug,
      liveName: l.name,
    };
  });
}

function liveRoundLabel(round) {
  if (round == null || round === "") return `${tr("Тур")} —`;
  return `${tr("Тур")} ${round}`;
}

function pinMyItemsFirst(items, isMine) {
  const mine = [];
  const rest = [];
  for (const item of items) {
    if (isMine(item)) mine.push(item);
    else rest.push(item);
  }
  return mine.concat(rest);
}

function livePinMyLeaguesOn() {
  return Boolean(
    accountState.authenticated &&
      (livePayload?.account?.pinMyLeagues ?? accountState.user?.pinMyLeagues),
  );
}

function myLiveLeagueIds() {
  return livePayload?.account?.myLeagueIds || [];
}

function orderedMantraTours(tours) {
  if (!livePinMyLeaguesOn()) return tours;
  const mine = new Set(myLiveLeagueIds());
  if (!mine.size) return tours;
  return pinMyItemsFirst(tours, (t) => mine.has(t.leagueId));
}

function syncLivePinCheckbox() {
  const wrap = document.getElementById("live-pin-leagues-wrap");
  const input = document.getElementById("live-pin-leagues");
  if (!wrap || !input) return;
  const loggedIn = Boolean(accountState.authenticated);
  wrap.hidden = !loggedIn;
  if (!loggedIn) return;
  const label = document.getElementById("live-pin-leagues-label");
  if (label) label.textContent = tr("Показывай мои лиги вверху");
  input.checked = livePinMyLeaguesOn();
}

function liveLeagueDisplayName(slug, c) {
  return (
    LIVE_SELECT_LABELS[slug] ||
    c?.liveName ||
    c?.name ||
    livePayload?.leagueName ||
    slug ||
    "Live"
  );
}

function liveLeagueChromeLabel() {
  const slug = competitionLeagueSlug();
  const liveList = liveSelectCompetitions(competitions, liveLeaguesCatalog);
  const cur = liveList.find((c) => c.liveSlug === slug || c.id === activeCompetitionId);
  return liveLeagueDisplayName(slug, cur);
}

function paintLiveLeagueChrome() {
  const label = liveLeagueChromeLabel();
  const nameEl = document.getElementById("league-name");
  if (nameEl) nameEl.textContent = label;
  const round = liveSelectedRound ?? livePayload?.round ?? livePayload?.currentRound ?? null;
  const metaEl = document.getElementById("league-meta");
  if (metaEl) metaEl.textContent = round != null && round !== "" ? liveRoundLabel(round) : "";
  document.title = `Live · ${label} · Mantra Helper`;
  const fotTitle = document.getElementById("live-fotmob-title");
  if (fotTitle) fotTitle.textContent = `FotMob · ${label}`;
}

async function loadLiveLeaguesFromApi() {
  try {
    const res = await fetch("/live/leagues");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.leagues || [];
    if (!list.length) return;
    liveLeaguesCatalog = list.map((l) => ({
      slug: l.slug,
      name: LIVE_SELECT_LABELS[l.slug] || l.name,
      tmCompetition: l.tmCompetition,
    }));
  } catch {
    /* keep fallback */
  }
}
const LIVE_PHASE_LABEL = {
  live: "Live",
  finished: "FT",
  upcoming: "Скоро",
  cancelled: "Отм.",
};

function scoreText(m) {
  if (m.phase === "upcoming" && m.scoreHome == null && m.scoreAway == null) return "—";
  return `${m.scoreHome ?? 0}:${m.scoreAway ?? 0}`;
}

function formatEventMinute(e) {
  if (e.time == null) return "—";
  if (e.overloadTime != null && e.overloadTime > 0) return `${e.time}+${e.overloadTime}'`;
  return `${e.time}'`;
}

function formatGoalLine(g) {
  const min = g.minuteLabel || formatEventMinute(g);
  const assist = g.assist ? ` (${g.assist})` : "";
  const og = g.ownGoal ? " OG" : "";
  return `${min} ⚽ ${g.scorer}${assist}${og}`;
}

function formatCardLine(c) {
  const min = c.minuteLabel || formatEventMinute(c);
  const kind =
    c.card === "Red" || c.card === "YellowRed" ? "🟥" : c.card === "Yellow" ? "🟨" : "🟨";
  return `${min} ${kind} ${c.playerName}`;
}

function formatLiveEventText(e) {
  if (e.type === "Substitution" && (e.playerOut || e.playerIn)) {
    const out = e.playerOut || "?";
    const inn = e.playerIn || "?";
    return `Замена · ${out} ⇄ ${inn}`;
  }
  if (e.type === "MissedPenalty" && e.playerName) {
    return `Незабитый пенальти · ${e.playerName}`;
  }
  if (e.type === "Goal" && e.playerName) {
    const assist = e.assistName ? ` (${e.assistName})` : "";
    const og = e.ownGoal ? " OG" : "";
    return `Гол · ${e.playerName}${assist}${og}`;
  }
  if (e.type === "Card" && e.playerName) {
    const kind = e.card === "Red" ? "красная" : e.card === "YellowRed" ? "вторая жёлтая" : "жёлтая";
    return `Карточка (${kind}) · ${e.playerName}`;
  }
  if (e.type === "Half") return e.time === 45 ? "Перерыв" : "Конец матча";
  return e.playerName ? `${e.type} · ${e.playerName}` : e.type;
}

function renderSideIncidents(items, formatter) {
  const home = items.filter((x) => x.isHome);
  const away = items.filter((x) => !x.isHome);
  if (!home.length && !away.length) return "";
  const cell = (rows) =>
    rows.length
      ? rows.map((r) => `<div class="live-inc-line">${esc(formatter(r))}</div>`).join("")
      : `<div class="live-inc-empty">—</div>`;
  return `<div class="live-incidents">
    <div class="home">${cell(home)}</div>
    <div class="mid"></div>
    <div class="away">${cell(away)}</div>
  </div>`;
}

function renderTopStars(m) {
  const home = m.topBySide?.home;
  const away = m.topBySide?.away;
  if (!home && !away) {
    return m.potm
      ? `<div class="live-card-stars"><span class="meta">POTM ${esc(m.potm.name)}</span></div>`
      : "";
  }
  const side = (p, align) =>
    p
      ? `<div class="live-star ${align}"><span class="star" aria-hidden="true">★</span> ${esc(
          p.name,
        )} <strong>${Number(p.rating).toFixed(2)}</strong></div>`
      : `<div class="live-star ${align} muted">—</div>`;
  return `<div class="live-card-stars">${side(home, "home")}${side(away, "away")}</div>`;
}

function renderDreamTeamPlaque() {
  const slot = document.getElementById("dream-team-slot");
  if (!slot) return;
  const dt = livePayload?.mantra?.dreamTeam;
  if (!dt?.starters?.length) {
    slot.hidden = true;
    slot.innerHTML = "";
    return;
  }
  const db =
    dt.defenceBonus > 0
      ? ` +${dt.defenceBonus}`
      : dt.defenceBonus
        ? ` ${dt.defenceBonus}`
        : "";
  const avg =
    dt.avgBase != null ? ` · avg BS ${Number(dt.avgBase).toFixed(2)}` : "";
  const goals = Number(dt.goals) || 0;
  const goalsBadge =
    goals > 0
      ? `<span class="dream-goal-badge" title="${esc(`${goals} Mantra-гол`)}">${esc(String(goals))}</span><span class="dream-goal-ball" aria-hidden="true">⚽</span>`
      : "";
  slot.hidden = false;
  slot.innerHTML = `<button type="button" class="dream-team-plaque" id="dream-team-open">
    <span class="dream-team-plaque-label">Dream Team of the Round ${esc(String(dt.round))}</span>
    <span class="dream-team-plaque-meta">${esc(dt.formation)} · ${esc(formatMantraPts(dt.playersTotal))}${esc(db)}${esc(avg)} · <strong>${esc(formatMantraPts(dt.totalScore))} ts</strong>${goalsBadge ? ` · ${goalsBadge}` : ""}</span>
  </button>`;
  document.getElementById("dream-team-open")?.addEventListener("click", () => {
    openDreamTeamDialog(dt);
  });
}

function dreamTeamPlayerIds() {
  const starters = livePayload?.mantra?.dreamTeam?.starters || [];
  const fotmob = new Set();
  const mantra = new Set();
  const names = new Set();
  for (const p of starters) {
    if (p.fotmobPlayerId != null) fotmob.add(Number(p.fotmobPlayerId));
    if (p.mantraPlayerId != null) mantra.add(Number(p.mantraPlayerId));
    if (p.name) names.add(String(p.name).toLowerCase());
  }
  return { fotmob, mantra, names };
}

function isDreamTeamPlayer(calc, fallbackName) {
  if (!calc && !fallbackName) return false;
  const ids = dreamTeamPlayerIds();
  if (calc?.fotmobPlayerId != null && ids.fotmob.has(Number(calc.fotmobPlayerId))) {
    return true;
  }
  if (calc?.playerId != null && ids.mantra.has(Number(calc.playerId))) return true;
  const name = String(calc?.name || fallbackName || "").toLowerCase();
  return Boolean(name && ids.names.has(name));
}

function dreamTeamFire(calc, fallbackName) {
  return isDreamTeamPlayer(calc, fallbackName)
    ? `<span class="dream-team-fire" title="Dream Team of the Round" aria-label="Dream Team">🔥</span>`
    : "";
}

function openDreamTeamDialog(dt) {
  const dialog = document.getElementById("dream-team-dialog");
  if (!dialog || !dt) return;
  document.getElementById("dream-team-dialog-title").textContent =
    `Dream Team of the Round ${dt.round}`;
  document.getElementById("dream-team-dialog-meta").textContent = [
    dt.formation,
    `${formatMantraPts(dt.totalScore)} ts`,
    dt.goals != null ? `${dt.goals} гол` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const dbLabel =
    dt.defenceBonus != null
      ? `DB ${dt.defenceBonus > 0 ? `+${dt.defenceBonus}` : dt.defenceBonus}${
          dt.defenceAvg != null ? ` (avg ${Number(dt.defenceAvg).toFixed(2)})` : ""
        }`
      : "";
  const goalsBadge =
    Number(dt.goals) > 0
      ? `<span class="dream-goal-badge" title="${esc(`${dt.goals} Mantra-гол`)}">${esc(String(dt.goals))}</span><span class="dream-goal-ball" aria-hidden="true">⚽</span>`
      : "";
  document.getElementById("dream-team-dialog-sum").innerHTML = `
    <span class="dream-team-sum-form">${esc(dt.formation)}</span>
    <span class="dream-team-sum-pts">${esc(formatMantraPts(dt.playersTotal))}${
      dt.defenceBonus ? ` <span class="dream-team-sum-db">+${dt.defenceBonus}</span>` : ""
    } → <strong>${esc(formatMantraPts(dt.totalScore))}</strong>${
      goalsBadge ? ` · ${goalsBadge}` : ""
    }</span>
    ${dbLabel ? `<span class="muted dream-team-sum-db-label">${esc(dbLabel)}</span>` : ""}
  `;
  document.getElementById("dream-team-dialog-body").innerHTML = (dt.starters || [])
    .map((p) => {
      const native = (p.positions || []).join("/") || "—";
      const icons = formatMantraScoreIcons(p.events);
      return `<tr>
        <td class="dream-td-native">${mantraPosPill(native)}</td>
        <td class="dream-td-player">
          <div class="dream-team-name">${esc(p.displayName || p.name)}</div>
          <div class="muted dream-team-club">${esc(p.clubName || "—")}</div>
        </td>
        <td class="dream-td-slot">${mantraPosPill(p.slotLabel)}</td>
        <td class="num dream-td-bs"><span class="dream-mobile-lab">BS</span>${esc(formatMantraPts(p.baseScore))}</td>
        <td class="num dream-team-ts dream-td-ts"><span class="dream-mobile-lab">TS</span>${esc(formatMantraPts(p.totalScore))}</td>
        <td class="dream-team-icos dream-td-icos">${icons}</td>
      </tr>`;
    })
    .join("");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function formatMantraPts(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}

function idealPctClass(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return "";
  if (pct >= 90) return "ideal-pct-good";
  if (pct >= 75) return "ideal-pct-mid";
  return "ideal-pct-low";
}

function formatIdealPct(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return "—";
  return `${Number(pct).toFixed(1)}%`;
}

function renderIdealStandings() {
  const slot = document.getElementById("ideal-standings-slot");
  if (!slot) return;
  const data = livePayload?.mantra?.idealStandings;
  const rows = data?.rows || [];
  if (!rows.length) {
    slot.hidden = true;
    slot.innerHTML = "";
    return;
  }
  slot.hidden = false;
  const byDiv = new Map();
  for (const r of rows) {
    const key = r.divisionLabel || "—";
    if (!byDiv.has(key)) byDiv.set(key, []);
    byDiv.get(key).push(r);
  }
  const pinnedLabels = new Set();
  if (livePinMyLeaguesOn()) {
    const mine = new Set(myLiveLeagueIds());
    for (const t of livePayload?.mantra?.tours || []) {
      if (mine.has(t.leagueId) && t.label) pinnedLabels.add(t.label);
    }
  }
  const sections = pinMyItemsFirst(
    [...byDiv.entries()],
    ([label]) => pinnedLabels.has(label),
  )
    .map(([label, list]) => {
      const body = list
        .map((r, i) => {
          const pctCls = idealPctClass(r.idealPct);
          return `<tr data-ideal-team="${esc(String(r.teamId))}" tabindex="0">
            <td class="num muted">${i + 1}</td>
            <td class="ideal-td-team">${esc(r.teamName)}</td>
            <td class="num">${esc(formatMantraPts(r.idealTotal))}</td>
            <td class="num">${esc(formatMantraPts(r.realTotal))}</td>
            <td class="num ideal-td-pct ${pctCls}" title="Насколько реальный XI близок к идеалу (реал / идеал)">
              ${esc(formatIdealPct(r.idealPct))}
            </td>
          </tr>`;
        })
        .join("");
      return `<div class="ideal-standings-division">
        <p class="meta ideal-standings-div-label">${esc(label)}</p>
        <div class="table-wrap ideal-standings-table-wrap">
          <table class="data-table compact-table ideal-standings-table">
            <thead>
              <tr>
                <th class="num">#</th>
                <th>Команда</th>
                <th class="num" title="Лучший возможный XI из 26">Ideal XI</th>
                <th class="num" title="Заблокированный состав тура">Real XI</th>
                <th class="num" title="Real / Ideal × 100">% к идеалу</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join("");

  slot.innerHTML = `<div class="ideal-standings-block">
    <div class="ideal-standings-head">
      <h3 class="ideal-standings-title">Ideal vs Real · тур ${esc(String(data.round))}</h3>
      <p class="meta">клик по строке — сравнение XI</p>
    </div>
    ${sections}
  </div>`;

  for (const tr of slot.querySelectorAll("[data-ideal-team]")) {
    const open = () => {
      const id = Number(tr.getAttribute("data-ideal-team"));
      const row = rows.find((r) => Number(r.teamId) === id);
      if (row) openIdealVsRealDialog(row);
    };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  }
}

/** Prefer Mantra surname (`name`); else last token of display/full name. */
function idealPlayerSurname(p) {
  const mantraName = String(p?.name || "").trim();
  if (mantraName) return mantraName;
  const display = String(p?.displayName || "").trim();
  if (!display) return "—";
  const parts = display.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || display;
}

function idealXiTableRows(players, { surnameOnly = false } = {}) {
  return (players || [])
    .map((p) => {
      const native = (p.positions || []).join("/") || "—";
      const icons = formatMantraScoreIcons(p.events);
      const subMark = p.substitutedIn
        ? ` <span class="muted" title="smart-sub">↑</span>`
        : p.substitutedOut
          ? ` <span class="muted" title="DNP">↓</span>`
          : "";
      const label = surnameOnly
        ? idealPlayerSurname(p)
        : p.displayName || p.name || "—";
      return `<tr>
        <td class="dream-td-native">${mantraPosPill(native)}</td>
        <td class="dream-td-player">
          <div class="dream-team-name">${esc(label)}${subMark}</div>
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

function openIdealVsRealDialog(row) {
  const dialog = document.getElementById("ideal-vs-real-dialog");
  if (!dialog || !row) return;
  document.getElementById("ideal-vs-real-title").textContent = row.teamName;
  document.getElementById("ideal-vs-real-meta").textContent = [
    row.divisionLabel,
    row.formation ? `ideal ${row.formation}` : null,
    row.realModule ? `real ${row.realModule}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const pct = formatIdealPct(row.idealPct);
  const pctCls = idealPctClass(row.idealPct);
  const idealDb =
    row.idealDefenceBonus > 0 ? ` +${row.idealDefenceBonus}` : "";
  const realDb =
    row.realDefenceBonusReady && row.realDefenceBonus
      ? ` +${row.realDefenceBonus}`
      : "";
  document.getElementById("ideal-vs-real-sum").innerHTML = `
    <span>Ideal <strong>${esc(formatMantraPts(row.idealTotal))}</strong>${esc(idealDb ? ` (${formatMantraPts(row.idealPlayersTotal)}${idealDb})` : "")}</span>
    <span>Real <strong>${esc(formatMantraPts(row.realTotal))}</strong>${esc(realDb ? ` (${formatMantraPts(row.realPlayersTotal)}${realDb})` : "")}</span>
    <span class="${pctCls}">% к идеалу <strong>${esc(pct)}</strong></span>
  `;

  const col = (title, meta, players, opts) => `
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
          <tbody>${idealXiTableRows(players, opts) || `<tr><td colspan="6" class="muted">Нет данных</td></tr>`}</tbody>
        </table>
      </div>
    </section>`;

  document.getElementById("ideal-vs-real-body").innerHTML =
    col(
      "Ideal XI",
      `${row.formation || "—"} · ${formatMantraPts(row.idealTotal)} ts`,
      row.idealXi,
      { surnameOnly: true },
    ) +
    col(
      "Real XI",
      `${row.realModule || "—"} · ${formatMantraPts(row.realTotal)} ts`,
      row.realXi,
    );

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function renderMantraTours() {
  const grid = document.getElementById("mantra-tours-grid");
  const meta = document.getElementById("mantra-tours-meta");
  if (!grid || !meta) return;
  syncLivePinCheckbox();

  const mantra = livePayload?.mantra;
  if (!mantra) {
    grid.innerHTML = "";
    meta.textContent = "—";
    renderDreamTeamPlaque();
    renderIdealStandings();
    return;
  }
  if (!mantra.configured) {
    meta.textContent = "нет MANTRA_EMAIL / MANTRA_PASSWORD";
    grid.innerHTML = `<p class="live-empty">Добавь креденшалы Mantra в .env на сервере.</p>`;
    renderDreamTeamPlaque();
    renderIdealStandings();
    return;
  }
  if (mantra.error && !(mantra.tours || []).length) {
    meta.textContent = `ошибка: ${mantra.error}`;
    grid.innerHTML = `<p class="live-empty">${esc(mantra.error)}</p>`;
    renderDreamTeamPlaque();
    renderIdealStandings();
    return;
  }

  const tours = orderedMantraTours(mantra.tours || []);
  const liveN = tours.filter((t) => t.live).length;
  const source = livePayload?.poll?.lastMantraSync?.source;
  const sourceLabel =
    source === "live" ? "live" : source === "file" ? "файл" : source === "db" ? "кэш" : "";
  meta.textContent =
    `${tours.length} дивизионов` +
    (mantra.syncedAt ? ` · sync ${formatDate(mantra.syncedAt)}` : "") +
    (liveN ? ` · live ${liveN}` : "") +
    (sourceLabel ? ` · ${sourceLabel}` : "") +
    (mantra.error && !tours.length ? ` · ⚠ ${mantra.error}` : "");

  grid.innerHTML = tours
    .map((t) => {
      const computed = mantra.computed || {};
      const matches = (t.matches || [])
        .map((m) => {
          const hasMatchId = m.matchId != null && Number.isFinite(Number(m.matchId));
          const calc = hasMatchId ? computed[String(m.matchId)] : null;
          const homeGoals = calc ? calc.home.goals : m.home.goals;
          const awayGoals = calc ? calc.away.goals : m.away.goals;
          const hg = homeGoals ?? "—";
          const ag = awayGoals ?? "—";
          const pendingXi = !calc;
          const cls =
            `mantra-match` +
            (calc ? " is-computed" : "") +
            (pendingXi ? " is-pending-xi" : "") +
            (!hasMatchId ? " is-pair-only" : "");
          const tag = hasMatchId ? "button" : "div";
          const attrs = hasMatchId
            ? `type="button" data-mantra-match="${m.matchId}"`
            : `role="group" title="Пара тура · XI ещё не выставлен"`;
          return `<${tag} class="${cls}" ${attrs}>
            ${renderMantraMatchHalf("home", m.home, calc?.home)}
            <span class="mantra-match-score" aria-label="${esc(`${hg}:${ag}`)}">
              <span class="mantra-score-box">
                <span class="mantra-score-num">${esc(String(hg))}</span>
                <span class="mantra-score-div" aria-hidden="true"></span>
                <span class="mantra-score-num">${esc(String(ag))}</span>
              </span>
              ${pendingXi ? `<span class="mantra-xi-pending">XI</span>` : ""}
            </span>
            ${renderMantraMatchHalf("away", m.away, calc?.away)}
          </${tag}>`;
        })
        .join("");
      const pairN = (t.matches || []).length;
      return `<article class="mantra-division${t.live ? " is-live" : ""}">
        <header class="mantra-division-head">
          <div>
            <h3>${esc(t.label)}</h3>
            <p class="meta">${t.round != null ? `Тур ${t.round}` : "Тур —"}${
              pairN ? ` · ${pairN} пар` : ""
            }${t.live ? " · LIVE" : ""}${
              t.deadline
                ? ` · дедлайн ${esc(formatUiDateTime(t.deadline))}`
                : t.deadlineLabel
                  ? ` · дедлайн ${esc(t.deadlineLabel)}`
                  : ""
            }${
              mantra.lineupsSyncedAt ? " · XI sync" : ""
            }</p>
          </div>
        </header>
        <div class="mantra-match-list">${matches || `<p class="live-empty">Нет матчей</p>`}</div>
      </article>`;
    })
    .join("");

  renderDreamTeamPlaque();
  renderIdealStandings();
  syncLivePinCheckbox();

  for (const btn of grid.querySelectorAll("[data-mantra-match]")) {
    btn.addEventListener("click", () => {
      openMantraMatchDialog(Number(btn.getAttribute("data-mantra-match")));
    });
  }
}

/** Players who actually appeared — denominator for avg (DNP / not on pitch excluded). */
function mantraActiveCount(calcSide) {
  const xi = (calcSide?.players || []).filter((p) => p.appeared).length;
  const subs = (calcSide?.bench || []).filter(
    (p) => p.substitutedIn && p.appeared,
  ).length;
  return xi + subs;
}

function mantraSideIsLive(calcSide) {
  return (calcSide?.players || []).some((p) => p.clubPhase === "live");
}

/** Slot ∩ native — which role the player actually occupies. */
function occupiedPositionToken(native, slotLabel) {
  const slotAcc = String(slotLabel || "")
    .split("/")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const nat = new Set((native || []).map((s) => String(s).toUpperCase()));
  const inter = slotAcc.filter((p) => nat.has(p));
  if (inter.length) return inter[0];
  // OoP: no intersection — fall back to first slot token (what they fill)
  return slotAcc[0] || [...nat][0] || "?";
}

/**
 * Live + Upcoming chips under points:
 * - XI → coloured position; black if no points
 * - smart-sub (↑) → coloured target-slot position
 * - other bench → "B" grey if playing, black if not
 * - Upcoming only when FotMob XI is published (inStartingXi / squad row)
 */
function renderMantraBenchB(p) {
  const playing = Boolean(p.appeared || p.breakdown);
  const title = `${p.name}${playing ? " · играет" : " · не играет"}`;
  return `<span class="mantra-mini-pos is-bench ${playing ? "is-on" : "is-off"}" title="${esc(title)}">B</span>`;
}

function renderMantraCoverChip(p) {
  const slot = p.coversSlot || p.slotLabel;
  const token = occupiedPositionToken(p.native, slot);
  const title = `${p.name} → ${slot}${p.appeared ? " · на поле" : " · не на поле"}`;
  if (p.breakdown) {
    const color = MANTRA_POS_COLOR[token] || "#737373";
    return `<span class="mantra-mini-pos" style="background:${color}" title="${esc(title)}">${esc(token)}</span>`;
  }
  if (p.appeared) {
    return `<span class="mantra-mini-pos is-bench is-on" title="${esc(title)}">${esc(token)}</span>`;
  }
  return `<span class="mantra-mini-pos is-out" title="${esc(title)}">${esc(token)}</span>`;
}

function renderMantraBenchChip(p) {
  if (p.substitutedIn && p.coversSlot) return renderMantraCoverChip(p);
  return renderMantraBenchB(p);
}

function renderMantraXiChip(p) {
  const token = occupiedPositionToken(p.native, p.slotLabel);
  const title = `${p.name} · ${token}${p.slotLabel ? ` (${p.slotLabel})` : ""}`;
  if (p.breakdown) {
    const color = MANTRA_POS_COLOR[token] || "#737373";
    return `<span class="mantra-mini-pos" style="background:${color}" title="${esc(title)}">${esc(token)}</span>`;
  }
  return `<span class="mantra-mini-pos is-out" title="${esc(title)}">${esc(token)}</span>`;
}

function renderMantraMiniPosLines(calcSide) {
  const players = calcSide?.players || [];
  const bench = calcSide?.bench || [];
  if (!players.length && !bench.length) return "";

  const livePills = [
    ...players
      .filter((p) => p.clubPhase === "live")
      .map((p) => renderMantraXiChip(p)),
    ...bench
      .filter((p) => p.clubPhase === "live")
      .map((p) => renderMantraBenchChip(p)),
  ];

  const upcomingPills = [
    ...players
      .filter((p) => p.clubPhase === "upcoming" && p.inStartingXi)
      .map((p) => {
        const token = occupiedPositionToken(p.native, p.slotLabel);
        const color = MANTRA_POS_COLOR[token] || "#737373";
        const title = `${p.name} · ${token} · Upcoming XI`;
        return `<span class="mantra-mini-pos" style="background:${color}" title="${esc(title)}">${esc(token)}</span>`;
      }),
    ...bench.filter((p) => {
      if (p.clubPhase !== "upcoming") return false;
      // only after FotMob lineup is published for that match
      if (p.substitutedIn && p.coversSlot) return Boolean(p.inStartingXi);
      return Boolean(p.fotmobPlayerId);
    }).map((p) => renderMantraBenchChip(p)),
  ];

  const lines = [];
  if (livePills.length) {
    lines.push(`<div class="mantra-mini-pos-line">
      <span class="mantra-mini-pos-label is-live">live</span>
      <div class="mantra-mini-pos-row">${livePills.join("")}</div>
    </div>`);
  }
  if (upcomingPills.length) {
    lines.push(`<div class="mantra-mini-pos-line">
      <span class="mantra-mini-pos-label is-upcoming">Upcoming</span>
      <div class="mantra-mini-pos-row">${upcomingPills.join("")}</div>
    </div>`);
  }
  if (!lines.length) return "";
  return `<div class="mantra-mini-pos-block">${lines.join("")}</div>`;
}

function renderMantraMatchHalf(side, team, calcSide) {
  const name = team?.teamName || "—";
  const total = calcSide ? calcSide.total : team?.score;
  const n = mantraActiveCount(calcSide);
  const live = mantraSideIsLive(calcSide);
  const ptsLabel =
    total != null && Number.isFinite(Number(total)) ? formatMantraPts(total) : "—";
  const countLabel = `${n}/11`;
  const dbReady = Boolean(calcSide?.defenceBonusReady);
  const dbPts = calcSide?.defenceBonus;
  // Avg is players only — DB is shown separately and already in total when ready
  const ptsForAvg =
    total != null && Number.isFinite(Number(total))
      ? dbReady && dbPts != null
        ? Number(total) - Number(dbPts)
        : Number(total)
      : null;
  const avg =
    n > 0 && ptsForAvg != null ? (ptsForAvg / n).toFixed(2) : "—";
  const dbBadge = dbReady
    ? `<span class="mantra-db-badge" title="Defence Bonus${
        dbPts != null ? ` +${dbPts}` : ""
      }${calcSide?.defenceAvg != null ? ` · avg ${Number(calcSide.defenceAvg).toFixed(2)}` : ""}">DB <span class="mantra-db-check" aria-hidden="true">✓</span></span>`
    : "";
  const avgTitle =
    n > 0 && ptsForAvg != null ? `${formatMantraPts(ptsForAvg)} / ${n} = ${avg}` : "";
  const liveDot = live
    ? `<span class="mantra-live-dot" title="Live" aria-label="Live"></span>`
    : "";

  return `<div class="mantra-match-half ${side}">
    <span class="mantra-match-avg" title="${esc(avgTitle)}">${esc(avg)}</span>
    <div class="mantra-match-stack">
      <span class="name">${esc(name)}</span>
      <span class="pts${live ? " is-live" : ""}">${liveDot}${esc(ptsLabel)} <small>${esc(countLabel)}</small>${dbBadge}</span>
      ${renderMantraMiniPosLines(calcSide)}
    </div>
  </div>`;
}

function livePhaseLabel(phase) {
  if (phase === "live") return "live";
  if (phase === "finished") return "FT";
  if (phase === "upcoming") return "NS";
  return "—";
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

function mantraPhasePill(phase) {
  const label = livePhaseLabel(phase);
  const cls =
    phase === "live" ? "is-live" : phase === "finished" ? "is-ft" : "is-ns";
  return `<span class="mantra-phase-pill ${cls}">${esc(label)}</span>`;
}

function mantraStatusBadge(calc) {
  const phase = calc?.clubPhase || "upcoming";
  const parts = [mantraPhasePill(phase)];

  if (calc?.substitutedIn) {
    parts.push(
      `<span class="mantra-sub-in" title="Умная замена${
        calc.coversSlot ? ` → ${esc(calc.coversSlot)}` : ""
      }">↑</span>`,
    );
  } else if (calc?.substitutedOut) {
    // ↓ только для стартеров, которых меняем; бенч без стрелки
    parts.push(`<span class="mantra-sub-out" title="Не играл · замена">↓</span>`);
  } else if (phase === "finished" && !calc?.appeared) {
    parts.push(`<span class="mantra-dnp" title="Не играл">✕</span>`);
  }

  return `<span class="mantra-status">${parts.join("")}</span>`;
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

function renderMantraRosterSide(side, computedSide) {
  const byName = new Map();
  for (const p of computedSide?.players || []) {
    const key = `${String(p.name).toLowerCase()}|${String(p.clubName || "").toLowerCase()}`;
    if (!byName.has(key)) byName.set(key, p);
  }
  const byIdx = computedSide?.players || [];

  const xi = (side.lineup || [])
    .map((slot, idx) => {
      const name = slot.playerName;
      const clubKey = String(slot.clubName || "").toLowerCase();
      const calc =
        byName.get(`${String(name).toLowerCase()}|${clubKey}`) ||
        byIdx[idx] ||
        null;
      const displayName = calc?.name || name;
      const total = calc?.breakdown?.total;
      const base = calc?.breakdown?.base;
      const icons = formatMantraScoreIcons(calc?.breakdown?.events);
      const club = calc?.clubName || slot.clubName || "";
      const slotLab = calc?.slotLabel || (slot.positions || []).join("/") || "—";
      const htmlLab = (slot.positions || []).join("/");
      const slotMismatch = htmlLab && slotLab !== htmlLab;
      const posLab = (calc?.native || slot.nativePositions || slot.positions || []).join("/") || "—";
      const dnp = Boolean(calc?.substitutedOut) || (calc?.clubPhase === "finished" && !calc?.appeared);
      const rowCls = [dnp ? "is-dnp" : "", slotMismatch ? "is-slot-mismatch" : ""]
        .filter(Boolean)
        .join(" ");
      return `<tr${rowCls ? ` class="${rowCls}"` : ""}>
        <td title="${
          slotMismatch ? esc(`HTML: ${htmlLab}`) : ""
        }">${mantraPosPill(slotLab)}${
          slotMismatch ? `<div class="mantra-slot-mismatch">HTML ${esc(htmlLab)}</div>` : ""
        }</td>
        <td>${mantraPosPill(posLab)}</td>
        <td>
          <div class="mantra-roster-name">${dreamTeamFire(calc, displayName)}${esc(displayName)}${icons}</div>
          <div class="meta">${esc(club)}</div>
        </td>
        <td>${mantraStatusBadge(calc)}</td>
        <td>${base != null ? Number(base).toFixed(2) : "—"}</td>
        <td><strong>${total != null ? Number(total).toFixed(2) : "—"}</strong></td>
      </tr>`;
    })
    .join("");

  const bench = (side.substitutes || [])
    .map((p, idx) => {
      const calc =
        (computedSide?.bench || []).find(
          (b) =>
            String(b.name).toLowerCase() === String(p.name).toLowerCase() &&
            (!p.clubName ||
              String(b.clubName || "").toLowerCase() === String(p.clubName || "").toLowerCase()),
        ) ||
        computedSide?.bench?.[idx] ||
        null;
      const total = calc?.breakdown?.total;
      const base = calc?.breakdown?.base;
      const icons = formatMantraScoreIcons(calc?.breakdown?.events);
      const dnp = calc?.clubPhase === "finished" && !calc?.appeared && !calc?.substitutedIn;
      const subIn = Boolean(calc?.substitutedIn);
      const posLab = (calc?.native || p.nativePositions || p.positions || []).join("/") || "—";
      const club = calc?.clubName || p.clubName || "";
      const rowCls = ["is-bench", dnp ? "is-dnp" : "", subIn ? "is-sub-in" : ""]
        .filter(Boolean)
        .join(" ");
      return `<tr class="${rowCls}">
        <td>${
          subIn && calc?.coversSlot
            ? mantraPosPill(calc.coversSlot)
            : `<span class="mantra-bench-b" title="Запас">Bench</span>`
        }</td>
        <td>${mantraPosPill(posLab)}</td>
        <td>
          <div class="mantra-roster-name">${dreamTeamFire(calc, p.name)}${esc(p.name)}${icons}</div>
          <div class="meta">${esc(club)}</div>
        </td>
        <td>${mantraStatusBadge(calc)}</td>
        <td>${base != null ? Number(base).toFixed(2) : "—"}</td>
        <td><strong>${total != null ? Number(total).toFixed(2) : "—"}</strong></td>
      </tr>`;
    })
    .join("");

  const total = computedSide?.total;
  const goals = computedSide?.goals;
  const db = computedSide?.defenceBonus;
  const dbAvg = computedSide?.defenceAvg;
  const dbReady = Boolean(computedSide?.defenceBonusReady);
  const dbLabel =
    db != null
      ? dbReady
        ? ` · <span class="mantra-db-badge is-inline">DB +${db} <span class="mantra-db-check">✓</span></span>${
            dbAvg != null ? ` <span class="muted">(avg ${Number(dbAvg).toFixed(2)})</span>` : ""
          }`
        : ` · Predicted DB ${db > 0 ? `+${db}` : db}${
            dbAvg ? ` <span class="muted">(avg ${Number(dbAvg).toFixed(2)})</span>` : ""
          }`
      : "";
  const idx = computedSide?.formationIndex || [];
  const idxLabel = idx.length
    ? `<div class="mantra-formation-index">индекс: ${idx.map((l) => mantraPosPill(l)).join(" ")}</div>`
    : "";
  const mism = computedSide?.slotMismatches || [];
  const mismLabel = mism.length
    ? `<div class="mantra-formation-mismatch">⚠ HTML ≠ индекс: ${mism
        .map(
          (m) =>
            `#${m.index} ${esc(m.playerName)}: ${esc(m.html)} → ${esc(m.expected)}`,
        )
        .join("; ")}</div>`
    : "";
  return `<section class="mantra-roster-side">
    <header>
      <h3>${esc(side.teamName)}</h3>
      <p class="meta">${side.module ? `модуль ${esc(side.module)}` : ""}${
        total != null
          ? ` · ${Number(total).toFixed(2)} pts · ${goals ?? 0} гол${dbLabel}`
          : ""
      }</p>
      ${idxLabel}
      ${mismLabel}
    </header>
    <div class="table-wrap">
      <table class="data-table compact-table">
        <thead>
          <tr>
            <th>Слот</th>
            <th>Поз</th>
            <th>Игрок</th>
            <th></th>
            <th>Base</th>
            <th>Σ</th>
          </tr>
        </thead>
        <tbody>
          ${xi || `<tr><td colspan="6" class="live-empty">Нет XI</td></tr>`}
          ${bench}
        </tbody>
      </table>
    </div>
  </section>`;
}

/** @type {number | null} */
let mantraDialogMatchId = null;
/** @type {string} */
let mantraDialogXiSig = "";

function computedMatchFromLive(matchId) {
  return livePayload?.mantra?.computed?.[String(matchId)] ?? null;
}

function tourMatchFromLive(matchId) {
  for (const t of livePayload?.mantra?.tours || []) {
    const m = (t.matches || []).find((x) => Number(x.matchId) === Number(matchId));
    if (m) return m;
  }
  return null;
}

function mantraXiSignature(match) {
  const names = (side) => (side?.lineup || []).map((s) => s.playerName).join(",");
  return `${names(match?.home)}||${names(match?.away)}`;
}

function matchStubFromComputed(calc, tour) {
  const side = (c, t) => ({
    teamName: c?.teamName || t?.teamName || "",
    module: c?.module || null,
    fantasyScore: c?.total ?? t?.score ?? null,
    goals: c?.goals ?? t?.goals ?? null,
    lineup: (c?.players || []).map((p) => ({
      playerName: p.name,
      positions: p.slotLabel ? [p.slotLabel] : [],
      nativePositions: p.native || [],
      clubName: p.clubName || null,
    })),
    substitutes: (c?.bench || []).map((p) => ({
      name: p.name,
      positions: p.native || [],
      nativePositions: p.native || [],
      clubName: p.clubName || null,
    })),
  });
  return {
    home: side(calc?.home, tour?.home),
    away: side(calc?.away, tour?.away),
  };
}

function mantraDialogHasRoster() {
  return Boolean(document.querySelector("#mantra-dialog-body table"));
}

function paintMantraMatchDialog(data, { keepRosterIfPending = false } = {}) {
  const match = data.match;
  const calc = data.computed;
  const hasXi = Boolean(match?.home?.lineup?.length || match?.away?.lineup?.length);
  if (!hasXi && data.pendingXi) {
    if (keepRosterIfPending && mantraDialogHasRoster()) return;
    document.getElementById("mantra-dialog-title").textContent =
      match?.home?.teamName && match?.away?.teamName
        ? `${match.home.teamName} — ${match.away.teamName}`
        : "XI ещё не выставлен";
    document.getElementById("mantra-dialog-meta").textContent =
      data.error || "XI ещё не выставлен";
    document.getElementById("mantra-dialog-body").innerHTML =
      `<p class="live-empty">Пара тура есть; Real XI появится после лока менеджеров.</p>`;
    return;
  }
  document.getElementById("mantra-dialog-title").textContent =
    `${match.home.teamName} — ${match.away.teamName}`;
  document.getElementById("mantra-dialog-meta").textContent =
    (data.pendingXi
      ? "XI ещё не выставлен"
      : match.home.module || match.away.module
        ? `${match.home.module || "—"} vs ${match.away.module || "—"}`
        : "модуль —") +
    (data.lineupsSyncedAt ? ` · XI ${formatDate(data.lineupsSyncedAt)}` : "");

  const hs = calc ? calc.home.total : match.home.fantasyScore;
  const as = calc ? calc.away.total : match.away.fantasyScore;
  const hg = calc ? calc.home.goals : match.home.goals;
  const ag = calc ? calc.away.goals : match.away.goals;
  document.getElementById("mantra-dialog-score").innerHTML =
    `<span>${formatMantraPts(hs)}</span>` +
    `<span class="mantra-dialog-goals">${hg ?? "—"}:${ag ?? "—"}</span>` +
    `<span>${formatMantraPts(as)}</span>`;

  const nextSig = mantraXiSignature(match);
  const keepTable = keepRosterIfPending && nextSig && nextSig === mantraDialogXiSig && mantraDialogHasRoster();
  if (!keepTable) {
    document.getElementById("mantra-dialog-body").innerHTML =
      (data.pendingXi
        ? `<p class="live-empty">Команды в паре есть, но составы (XI) пока пустые на Mantra.</p>`
        : "") +
      renderMantraRosterSide(match.home, calc?.home) +
      renderMantraRosterSide(match.away, calc?.away);
    mantraDialogXiSig = nextSig;
    return;
  }
  document.getElementById("mantra-dialog-body").innerHTML =
    renderMantraRosterSide(match.home, calc?.home) +
    renderMantraRosterSide(match.away, calc?.away);
}

function refreshOpenMantraDialogFromLive() {
  if (mantraDialogMatchId == null) return;
  const dlg = document.getElementById("mantra-dialog");
  if (!dlg?.open) return;
  const calc = computedMatchFromLive(mantraDialogMatchId);
  if (!calc?.home?.players?.length && !calc?.away?.players?.length) return;
  const tour = tourMatchFromLive(mantraDialogMatchId);
  paintMantraMatchDialog(
    {
      match: matchStubFromComputed(calc, tour),
      computed: calc,
      pendingXi: false,
      lineupsSyncedAt: livePayload?.mantra?.lineupsSyncedAt,
    },
    { keepRosterIfPending: true },
  );
}

async function openMantraMatchDialog(matchId) {
  const dlg = document.getElementById("mantra-dialog");
  if (!dlg || matchId == null) return;
  const alreadyOpen = mantraDialogMatchId === matchId && dlg.open;
  mantraDialogMatchId = matchId;
  if (!alreadyOpen) {
    const calc = computedMatchFromLive(matchId);
    const tour = tourMatchFromLive(matchId);
    const cachedXi = Boolean(calc?.home?.players?.length || calc?.away?.players?.length);
    if (cachedXi) {
      paintMantraMatchDialog({
        match: matchStubFromComputed(calc, tour),
        computed: calc,
        pendingXi: false,
        lineupsSyncedAt: livePayload?.mantra?.lineupsSyncedAt,
      });
    } else {
      document.getElementById("mantra-dialog-title").textContent = "Загрузка…";
      document.getElementById("mantra-dialog-meta").textContent = "";
      document.getElementById("mantra-dialog-score").textContent = "";
    }
    dlg.showModal();
  }

  try {
    const qs = new URLSearchParams();
    const league = competitionLeagueSlug();
    if (league) qs.set("league", league);
    const round =
      liveSelectedRound ?? livePayload?.round ?? livePayload?.currentRound ?? null;
    if (round != null && round !== "") qs.set("round", String(round));
    const q = qs.toString() ? `?${qs}` : "";
    const res = await fetch(`/live/mantra/match/${matchId}${q}`);
    const data = await res.json().catch(() => ({}));
    if (mantraDialogMatchId !== matchId) return;
    if (!res.ok) {
      const calc = computedMatchFromLive(matchId);
      if (calc?.home?.players?.length || calc?.away?.players?.length || mantraDialogHasRoster()) {
        return;
      }
      paintMantraMatchDialog(
        {
          ...data,
          match: data.match || matchStubFromComputed(null, tourMatchFromLive(matchId)),
          pendingXi: true,
        },
        { keepRosterIfPending: true },
      );
      return;
    }
    paintMantraMatchDialog(data, { keepRosterIfPending: alreadyOpen || mantraDialogHasRoster() });
  } catch (err) {
    if (mantraDialogMatchId !== matchId) return;
    if (mantraDialogHasRoster()) return;
    document.getElementById("mantra-dialog-title").textContent = "Ошибка";
    document.getElementById("mantra-dialog-meta").textContent = err.message;
  }
}

/** @type {any | null} */
let liveDetailPlayers = null;
/** @type {{ key: string, dir: "asc" | "desc" }} */
let liveRatingSort = { key: "rating", dir: "desc" };

function sortLivePlayers(players) {
  const rows = players.slice();
  const { key, dir } = liveRatingSort;
  const mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (key === "name") return mul * String(a.name).localeCompare(String(b.name));
    if (key === "team") return mul * String(a.teamName || "").localeCompare(String(b.teamName || ""));
    return mul * ((a.displayRating || 0) - (b.displayRating || 0)) || a.name.localeCompare(b.name);
  });
  return rows;
}

function renderLiveRatingsTable() {
  const body = document.getElementById("live-ratings");
  if (!body) return;
  if (!liveDetailPlayers?.length) {
    body.innerHTML = `<tr><td colspan="4" class="live-empty">Оценок ещё нет</td></tr>`;
    return;
  }
  const players = sortLivePlayers(liveDetailPlayers);
  body.innerHTML = players
    .map(
      (p) =>
        `<tr>
          <td>${p.starter ? "XI" : "sub"}</td>
          <td>${esc(p.name)}</td>
          <td>${esc(p.teamName || "")}</td>
          <td><span class="rating-pill${p.ratingDefaulted ? " is-default" : ""}">${Number(
            p.displayRating,
          ).toFixed(2)}</span></td>
        </tr>`,
    )
    .join("");

  for (const th of document.querySelectorAll("#live-ratings-table th.sortable")) {
    const k = th.getAttribute("data-live-sort");
    th.classList.toggle("is-sorted", k === liveRatingSort.key);
    th.dataset.dir = k === liveRatingSort.key ? liveRatingSort.dir : "";
  }
}

function renderLiveRoundTabs() {
  const el = document.getElementById("live-round-tabs");
  if (!el) return;
  const rounds = livePayload?.rounds || [];
  const current = livePayload?.currentRound ?? livePayload?.round ?? null;
  const selected = livePayload?.round ?? current;
  if (!rounds.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = rounds
    .map((r) => {
      const isSel = String(r.round) === String(selected);
      const isCur = r.current || String(r.round) === String(current);
      return `<button type="button" class="tab${isCur ? " is-current" : ""}" role="tab" aria-selected="${
        isSel ? "true" : "false"
      }" data-live-round="${esc(String(r.round))}">${esc(liveRoundLabel(r.round))}</button>`;
    })
    .join("");
  for (const btn of el.querySelectorAll("[data-live-round]")) {
    btn.addEventListener("click", () => {
      const round = btn.getAttribute("data-live-round");
      if (!round) return;
      const current = livePayload?.currentRound ?? livePayload?.round ?? null;
      livePinnedRound = String(round) !== String(current);
      liveSelectedRound = round;
      liveSelectedId = null;
      syncLiveHash();
      void fetchLiveRound({ silent: false });
    });
  }
}

function renderLiveList() {
  const list = document.getElementById("live-list");
  const meta = document.getElementById("live-meta");
  if (!list || !meta) return;

  renderLiveRoundTabs();

  if (!livePayload) {
    list.innerHTML = `<p class="live-empty">Нет данных. Подождите обновления poller.</p>`;
    meta.textContent = "—";
    return;
  }

  const round = liveRoundLabel(livePayload.round);
  const synced = livePayload.syncedAt ? formatDate(livePayload.syncedAt) : "ещё нет";
  const liveN = (livePayload.matches || []).filter((m) => m.phase === "live").length;
  meta.textContent = `${round} · sync ${synced} · ${getUiTimeZone()} · live ${liveN} · poll ${livePayload.poll?.intervalSec ?? 300}с`;

  const matches = livePayload.matches || [];
  if (!matches.length) {
    list.innerHTML = `<p class="live-empty">Матчей текущего тура пока нет.</p>`;
    return;
  }

  if (liveSelectedId == null || !matches.some((m) => m.id === liveSelectedId)) {
    const prefer = matches.find((m) => m.phase === "live") || matches[0];
    liveSelectedId = prefer?.id ?? null;
  }

  list.innerHTML = matches
    .map((m) => {
      const phase = LIVE_PHASE_LABEL[m.phase] || m.statusShort || m.phase;
      const goalsHtml = renderSideIncidents(m.goals || [], formatGoalLine);
      const cardsHtml = renderSideIncidents(m.cards || [], formatCardLine);
      return `<button type="button" class="live-card${m.phase === "live" ? " is-live" : ""}${
        m.id === liveSelectedId ? " is-selected" : ""
      }" data-live-id="${m.id}">
        <div class="live-card-top">
          <span class="live-phase ${m.phase === "live" ? "live" : ""}">${esc(phase)}</span>
          <span class="meta">${esc(formatDate(m.kickoff))}</span>
        </div>
        <div class="live-scoreline">
          <span class="home">${esc(m.home.name)}</span>
          <span class="score">${esc(scoreText(m))}</span>
          <span class="away">${esc(m.away.name)}</span>
        </div>
        ${renderTopStars(m)}
        ${goalsHtml ? `<div class="live-card-block">${goalsHtml}</div>` : ""}
        ${cardsHtml ? `<div class="live-card-block live-card-cards">${cardsHtml}</div>` : ""}
      </button>`;
    })
    .join("");

  for (const btn of list.querySelectorAll("[data-live-id]")) {
    btn.addEventListener("click", () => {
      liveSelectedId = Number(btn.getAttribute("data-live-id"));
      renderLiveList();
      loadLiveDetail(liveSelectedId);
    });
  }
}

async function loadLiveDetail(matchId) {
  const detail = document.getElementById("live-detail");
  if (!detail || matchId == null) return;
  detail.hidden = false;
  document.getElementById("live-detail-title").textContent = "Загрузка…";
  document.getElementById("live-events").innerHTML = "";
  document.getElementById("live-ratings").innerHTML = "";
  liveDetailPlayers = null;

  try {
    const res = await fetch(`/live/${matchId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();
    document.getElementById("live-detail-title").textContent = `${m.home.name} — ${m.away.name}`;
    document.getElementById("live-detail-meta").textContent =
      `${LIVE_PHASE_LABEL[m.phase] || m.phase}` +
      (m.statusShort ? ` · ${m.statusShort}` : "") +
      (m.round ? ` · тур ${m.round}` : "") +
      (m.detailsSyncedAt ? ` · детали ${formatDate(m.detailsSyncedAt)}` : "");
    document.getElementById("live-detail-score").textContent = scoreText(m);
    const link = document.getElementById("live-detail-fotmob");
    link.href = m.fotmobUrl || "#";

    const events = m.events || [];
    document.getElementById("live-events").innerHTML = events.length
      ? events
          .map((e) => {
            const side =
              e.isHome == null ? "" : e.isHome ? '<span class="ev-side home">H</span> ' : '<span class="ev-side away">A</span> ';
            return `<li class="${e.isHome === true ? "is-home" : e.isHome === false ? "is-away" : ""}">
              <span class="min">${esc(formatEventMinute(e))}</span>
              <span>${side}<span class="ev-type">${esc(formatLiveEventText(e))}</span></span>
            </li>`;
          })
          .join("")
      : `<li class="live-empty">Событий пока нет</li>`;

    liveDetailPlayers = m.players || [];
    liveRatingSort = { key: "rating", dir: "desc" };
    renderLiveRatingsTable();
  } catch (err) {
    document.getElementById("live-detail-title").textContent = "Ошибка загрузки";
    document.getElementById("live-detail-meta").textContent = err.message;
  }
}

async function fetchIdealStandings({ retryOnMiss = true } = {}) {
  const gen = liveFetchGen;
  try {
    const qs = new URLSearchParams();
    const league = competitionLeagueSlug();
    if (league) qs.set("league", league);
    if (liveSelectedRound != null && liveSelectedRound !== "") {
      qs.set("round", String(liveSelectedRound));
    }
    const q = qs.toString() ? `?${qs}` : "";
    const res = await fetch(`/live/ideal-standings${q}`);
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== liveFetchGen) return;
    if (!livePayload) return;
    if (!livePayload.mantra) livePayload.mantra = {};
    livePayload.mantra.idealStandings = data.idealStandings ?? null;
    renderIdealStandings();
    if (!livePayload.mantra.idealStandings && retryOnMiss) {
      setTimeout(() => {
        if (gen === liveFetchGen) void fetchIdealStandings({ retryOnMiss: false });
      }, 2000);
    }
  } catch {
    /* standings are optional — fixtures already painted */
  }
}

const LIVE_FETCH_RETRIES = 3;
const LIVE_FETCH_RETRY_MS = 800;

function liveFetchRetryable(status, err) {
  if (status === 502 || status === 503 || status === 504) return true;
  if (err && (err.name === "TypeError" || /failed to fetch|network|load failed/i.test(err.message || ""))) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLiveRound({ silent = true } = {}) {
  const gen = ++liveFetchGen;
  liveLoading = true;
  const btn = document.getElementById("live-refresh");
  if (btn) btn.disabled = true;
  if (!silent) showContentLoading();
  let attempt = 0;
  try {
    const qs = new URLSearchParams();
    const league = competitionLeagueSlug();
    if (league) qs.set("league", league);
    if (livePinnedRound && liveSelectedRound != null && liveSelectedRound !== "") {
      qs.set("round", String(liveSelectedRound));
    }
    qs.set("format", "json");
    const q = `?${qs}`;
    let payload = null;
    while (true) {
      try {
        const res = await fetch(`/live${q}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) {
          if (liveFetchRetryable(res.status) && attempt < LIVE_FETCH_RETRIES) {
            attempt += 1;
            await sleep(LIVE_FETCH_RETRY_MS * attempt);
            if (gen !== liveFetchGen) return;
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const type = res.headers.get("content-type") || "";
        if (!type.includes("json")) throw new Error("ожидался JSON Live");
        payload = await res.json();
        break;
      } catch (err) {
        if (gen !== liveFetchGen) return;
        if (String(err?.message || "").startsWith("HTTP ")) throw err;
        if (liveFetchRetryable(0, err) && attempt < LIVE_FETCH_RETRIES) {
          attempt += 1;
          await sleep(LIVE_FETCH_RETRY_MS * attempt);
          continue;
        }
        throw err;
      }
    }
    if (gen !== liveFetchGen) return;
    livePayload = payload;
    const current = livePayload?.currentRound ?? livePayload?.round ?? null;
    if (!livePinnedRound) {
      liveSelectedRound = current != null ? String(current) : null;
    } else if (
      liveSelectedRound != null &&
      current != null &&
      String(liveSelectedRound) === String(current)
    ) {
      livePinnedRound = false;
    }
    syncLiveHash();
    paintLiveLeagueChrome();
    renderLiveList();
    renderMantraTours();
    void fetchIdealStandings();
    refreshOpenMantraDialogFromLive();
    if (liveSelectedId != null) void loadLiveDetail(liveSelectedId);
  } catch (err) {
    if (gen !== liveFetchGen) return;
    const meta = document.getElementById("live-meta");
    if (meta) meta.textContent = `Ошибка Live: ${err.message}`;
  } finally {
    if (!silent) hideContentLoading();
    if (gen === liveFetchGen) {
      liveLoading = false;
      if (btn) btn.disabled = false;
    }
  }
}

function ensureLiveLoaded() {
  if (livePayload) {
    renderLiveList();
    renderMantraTours();
  }
  if (!liveLoading) void fetchLiveRound({ silent: true });
  if (liveClientTimer) return;
  // Soft client refresh aligned with server poll (5m) — no overlay (background).
  liveClientTimer = setInterval(() => {
    void fetchLiveRound({ silent: true });
    void fetchIdealStandings();
  }, 5 * 60 * 1000);
}

function syncLiveHash() {
  const qs = new URLSearchParams();
  const league = competitionLeagueSlug();
  if (league) qs.set("league", league);
  if (liveSelectedRound != null && liveSelectedRound !== "") {
    qs.set("round", String(liveSelectedRound));
  }
  const next = qs.toString() ? `/live?${qs}` : "/live";
  const cur = `${location.pathname}${location.search}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}

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
    const slug = competitionLeagueSlug() || "premier-league";
    const label = liveLeagueDisplayName(slug);
    sel.innerHTML = `<option value="${esc(slug)}">${esc(label)}</option>`;
    paintLiveLeagueChrome();
    return;
  }
  if (!options.some((c) => c.id === activeCompetitionId || c.liveSlug === competitionLeagueSlug())) {
    setActiveCompetitionId(options[0].id);
  }
  sel.innerHTML = options
    .map((c) => {
      const slug = c.liveSlug || competitionLeagueSlug(c.id);
      const label = liveLeagueDisplayName(slug, c);
      return `<option value="${esc(slug)}">${esc(label)}</option>`;
    })
    .join("");
  sel.value = competitionLeagueSlug();
  paintLiveLeagueChrome();
}

function bindLivePage() {
  document.getElementById("mantra-dialog")?.addEventListener("close", () => {
    mantraDialogMatchId = null;
    mantraDialogXiSig = "";
  });
  document.getElementById("competition-select")?.addEventListener("change", (e) => {
    const slug = String(e.target.value || "").trim();
    if (!slug) return;
    const id = resolveCompetitionIdFromLeagueParam(slug);
    if (id) setActiveCompetitionId(id);
    liveSelectedRound = null;
    livePinnedRound = false;
    liveSelectedId = null;
    livePayload = null;
    paintLiveLeagueChrome();
    renderLiveList();
    renderMantraTours();
    syncLiveHash();
    void fetchLiveRound({ silent: false });
  });
  document.getElementById("live-pin-leagues")?.addEventListener("change", async (e) => {
    const on = Boolean(e.target.checked);
    if (!accountState.authenticated) {
      e.target.checked = false;
      return;
    }
    if (!livePayload) livePayload = {};
    if (!livePayload.account) {
      livePayload.account = { pinMyLeagues: on, myLeagueIds: [] };
    } else {
      livePayload.account.pinMyLeagues = on;
    }
    if (accountState.user) accountState.user.pinMyLeagues = on;
    renderMantraTours();
    try {
      const data = await apiJson("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinMyLeagues: on }),
      });
      if (data?.user) accountState.user = data.user;
    } catch {
      if (livePayload.account) livePayload.account.pinMyLeagues = !on;
      if (accountState.user) accountState.user.pinMyLeagues = !on;
      e.target.checked = !on;
      renderMantraTours();
    }
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
    syncLivePinCheckbox();
    if (livePayload) {
      renderLiveRoundTabs();
      renderLiveList();
      renderMantraTours();
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
    if (round != null && round !== "") {
      liveSelectedRound = round;
      livePinnedRound = true;
    }
    fillLiveCompetitionSelect();
    syncLivePinCheckbox();
    syncLiveHash();
    await fetchLiveRound({ silent: true });
  } catch (err) {
    const meta = document.getElementById("live-meta");
    if (meta) meta.textContent = `Ошибка: ${err.message}`;
  } finally {
    hideContentLoading();
  }
}
