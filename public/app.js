const SEASON = 2026;

const statusEl = document.getElementById("status");
const teamsEl = document.getElementById("teams");
const boardEl = document.getElementById("board");
const pitchEl = document.getElementById("pitch");
const backupsEl = document.getElementById("backups");
const statsEl = document.getElementById("stats");

/** @type {Map<number, any>} */
const teamById = new Map();

/** @type {any[]} */
let boardPlayers = [];
let boardMinRating = 40;
/** @type {{ id: number, label: string }[]} */
let mantraLeagues = [];

function formatMoney(value) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

function formatPct(n) {
  return `${Math.round(n * 100)}%`;
}

/** Interpolate rating badge: red at xiMin → dark green at 100. */
function ratingBadgeColor(rating, xiMin) {
  const lo = Math.min(xiMin, 40);
  const hi = 100;
  const t = Math.max(0, Math.min(1, (rating - lo) / Math.max(hi - lo, 1)));
  // bright red → amber → dark green
  const stops = [
    { t: 0, r: 220, g: 38, b: 38 }, // #dc2626
    { t: 0.45, r: 234, g: 179, b: 8 }, // #eab308
    { t: 1, r: 20, g: 83, b: 45 }, // #14532d dark green
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

function renderTeams(teams) {
  teamsEl.innerHTML = "";
  for (const team of teams) {
    teamById.set(team.id, team);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-chip";
    btn.dataset.teamId = String(team.id);
    btn.innerHTML = `<img src="${team.logo}" alt="" loading="lazy" /><span>${team.name}</span>`;
    btn.addEventListener("click", () => selectTeam(team.id));
    teamsEl.appendChild(btn);
  }
}

function setSelectedChip(teamId) {
  for (const btn of teamsEl.querySelectorAll(".team-chip")) {
    btn.setAttribute("aria-selected", btn.dataset.teamId === String(teamId) ? "true" : "false");
  }
}

function renderPrediction(team, pred) {
  boardEl.hidden = false;
  document.getElementById("team-logo").src = team.logo;
  document.getElementById("team-logo").alt = team.name;
  document.getElementById("team-name").textContent = pred.teamName;
  document.getElementById("team-meta").textContent =
    `${pred.formation} · ${pred.formationReason}`;

  const pre = pred.preseason;
  statsEl.innerHTML = `
    <div class="stat"><b>${formatPct(pred.confidence)}</b><span>confidence</span></div>
    <div class="stat"><b>${pre.played}</b><span>friendlies</span></div>
    <div class="stat"><b>${pre.wins}-${pre.draws}-${pre.losses}</b><span>W-D-L</span></div>
    <div class="stat"><b>${pre.gf}:${pre.ga}</b><span>goals</span></div>
  `;

  pitchEl.innerHTML = `<div class="formation-label">${pred.formation}</div>`;

  const ratings = pred.xi.map((s) => Number(s.starter.score) || 0);
  const xiMin = ratings.length ? Math.min(...ratings) : 40;

  pred.xi.forEach((slot, i) => {
    const el = document.createElement("div");
    el.className = "player";
    el.style.left = `${slot.x}%`;
    el.style.top = `${slot.y}%`;
    el.style.animationDelay = `${i * 40}ms`;
    const mv = formatMoney(slot.starter.marketValueEur);
    const slotLabel = slot.label || slot.role || "—";
    const rating = Math.round(Number(slot.starter.score) || 0);
    const { bg, fg } = ratingBadgeColor(rating, xiMin);
    el.innerHTML = `
      <span class="kit" style="background:${bg};color:${fg}">${slotLabel}</span>
      <span class="name">${slot.starter.name}</span>
      <span class="sub">${mv} · рейтинг ${rating}</span>
    `;
    const natural = slot.starter.roleLabel || slot.starter.role;
    el.title = [
      `Слот: ${slotLabel}`,
      `Роль: ${natural}`,
      `Рейтинг ${rating} (шкала от ${Math.round(xiMin)} на поле → 100)`,
      `Состав: stats + market value + предсезон`,
      slot.backup ? `Backup: ${slot.backup.name}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    pitchEl.appendChild(el);
  });

  backupsEl.innerHTML = "";
  const withBackup = pred.xi.filter((s) => s.backup);
  if (withBackup.length === 0) {
    backupsEl.innerHTML = `<li><span class="who">No role-fit backups available</span></li>`;
    return;
  }
  for (const s of withBackup) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="slot">${s.label}</span>
      <span class="who">${s.backup.name}</span>
      <span class="for">${s.backup.roleLabel || s.backup.role} → covers ${s.starter.name} · ${formatMoney(s.backup.marketValueEur)}</span>
    `;
    backupsEl.appendChild(li);
  }
}

async function selectTeam(teamId) {
  setSelectedChip(teamId);
  statusEl.textContent = "Loading prediction…";
  const res = await fetch(`/ekstraklasa/${SEASON}/teams/${teamId}/predicted-xi`);
  if (!res.ok) {
    statusEl.textContent = `Failed to load team ${teamId}`;
    return;
  }
  const pred = await res.json();
  const team = teamById.get(teamId);
  renderPrediction(team, pred);
  statusEl.textContent = pred.method;
  history.replaceState(null, "", `#team=${teamId}`);
  const clubFilter = document.getElementById("filter-club");
  if (clubFilter && clubFilter.value !== String(teamId)) {
    // keep table independent unless user wants sync — no auto filter
  }
}

function xiTag(status, slot) {
  if (status === "starter") return `<span class="tag tag-starter">XI ${slot || ""}</span>`;
  if (status === "backup") return `<span class="tag tag-backup">Backup ${slot || ""}</span>`;
  return `<span class="tag tag-squad">Состав</span>`;
}

function filteredBoard() {
  const club = document.getElementById("filter-club").value;
  const pos = document.getElementById("filter-pos").value;
  const mantraPos = document.getElementById("filter-mantra").value;
  const freeLeague = document.getElementById("filter-free-league").value;
  const xi = document.getElementById("filter-xi").value;
  const sort = document.getElementById("filter-sort").value;
  const q = document.getElementById("filter-q").value.trim().toLowerCase();

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
      const taken = p.mantra.takenLeagueIds || [];
      return !taken.includes(leagueId);
    });
  }
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));

  rows.sort((a, b) => {
    if (sort === "rating-asc") return a.rating - b.rating;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "value-desc") return (b.marketValueEur || 0) - (a.marketValueEur || 0);
    return b.rating - a.rating;
  });
  return rows;
}

function fillMantraPositionFilter() {
  const select = document.getElementById("filter-mantra");
  const prev = select.value;
  const set = new Set();
  for (const p of boardPlayers) {
    for (const pos of p.mantra?.positions || []) {
      if (pos) set.add(pos);
    }
  }
  const positions = [...set].sort((a, b) => a.localeCompare(b));
  select.innerHTML =
    `<option value="">Все</option>` + positions.map((pos) => `<option value="${pos}">${pos}</option>`).join("");
  if (prev && positions.includes(prev)) select.value = prev;
}

function fillFreeLeagueFilter() {
  const select = document.getElementById("filter-free-league");
  const prev = select.value;
  select.innerHTML =
    `<option value="">Все</option>` +
    mantraLeagues.map((l) => `<option value="${l.id}">${l.label}</option>`).join("");
  if (prev && mantraLeagues.some((l) => String(l.id) === prev)) select.value = prev;
}

function renderRosterTable() {
  const body = document.getElementById("roster-body");
  const meta = document.getElementById("roster-meta");
  const rows = filteredBoard();
  meta.textContent = `${rows.length} игроков · matched Mantra ${boardPlayers.filter((p) => p.mantra).length}/${boardPlayers.length}`;
  body.innerHTML = "";
  for (const p of rows) {
    const rating = Math.round(p.rating);
    const { bg, fg } = ratingBadgeColor(rating, boardMinRating);
    const mantraPos = (p.mantra?.positions || []).map((x) => `<span class="tag tag-pos">${x}</span>`).join("") || "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.name}</td>
      <td>${p.teamName}</td>
      <td>${p.roleLabel || p.role || "—"}</td>
      <td>${mantraPos}</td>
      <td>${xiTag(p.xiStatus, p.xiSlot)}</td>
      <td><span class="rating-pill" style="background:${bg};color:${fg}">${rating}</span></td>
      <td>${formatMoney(p.marketValueEur)}</td>
    `;
    body.appendChild(tr);
  }
}

function teamAvgRating(teamId) {
  const rows = boardPlayers.filter((p) => p.teamId === teamId);
  if (!rows.length) return 0;
  return rows.reduce((sum, p) => sum + p.rating, 0) / rows.length;
}

/** Worst → best by mean squad board rating. */
function sortTeamsByAvgRating(teams) {
  return [...teams].sort((a, b) => teamAvgRating(a.id) - teamAvgRating(b.id));
}

function setupRosterFilters(teams) {
  const club = document.getElementById("filter-club");
  club.innerHTML = `<option value="">Все</option>` + teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  for (const id of [
    "filter-club",
    "filter-pos",
    "filter-mantra",
    "filter-free-league",
    "filter-xi",
    "filter-sort",
    "filter-q",
  ]) {
    document.getElementById(id).addEventListener("input", renderRosterTable);
    document.getElementById(id).addEventListener("change", renderRosterTable);
  }
}

async function loadBoard() {
  const res = await fetch(`/ekstraklasa/${SEASON}/board`);
  if (!res.ok) throw new Error(`board HTTP ${res.status}`);
  const data = await res.json();
  boardPlayers = data.players || [];
  mantraLeagues = data.mantraLeagues || [];
  boardMinRating = boardPlayers.length ? Math.min(...boardPlayers.map((p) => p.rating)) : 40;
  fillMantraPositionFilter();
  fillFreeLeagueFilter();
  const meta = document.getElementById("roster-meta");
  meta.textContent = `${data.counts.players} игроков · Mantra ${data.counts.mantraMatched}/${data.counts.mantra} (profiles ${data.counts.mantraProfiles})`;
  renderRosterTable();
  return data;
}

async function boot() {
  try {
    const [teamsRes, boardRes] = await Promise.all([
      fetch(`/ekstraklasa/${SEASON}/teams`),
      fetch(`/ekstraklasa/${SEASON}/board`),
    ]);
    if (!teamsRes.ok) throw new Error(`HTTP ${teamsRes.status}`);
    if (!boardRes.ok) throw new Error(`board HTTP ${boardRes.status}`);

    let teams = await teamsRes.json();
    const boardData = await boardRes.json();
    boardPlayers = boardData.players || [];
    mantraLeagues = boardData.mantraLeagues || [];
    boardMinRating = boardPlayers.length ? Math.min(...boardPlayers.map((p) => p.rating)) : 40;

    teams = sortTeamsByAvgRating(teams);
    renderTeams(teams);
    setupRosterFilters(teams);
    fillMantraPositionFilter();
    fillFreeLeagueFilter();
    const meta = document.getElementById("roster-meta");
    meta.textContent = `${boardData.counts.players} игроков · Mantra ${boardData.counts.mantraMatched}/${boardData.counts.mantra} (profiles ${boardData.counts.mantraProfiles})`;
    renderRosterTable();
    statusEl.textContent = `${teams.length} clubs · season ${SEASON}/${SEASON + 1}`;

    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const fromHash = Number(hash.get("team"));
    const initial = teamById.has(fromHash) ? fromHash : teams[0]?.id;
    if (initial) await selectTeam(initial);
  } catch (err) {
    statusEl.textContent = `Could not load clubs: ${err.message}`;
  }
}

boot();
