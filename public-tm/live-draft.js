import { initI18n, tr } from "./i18n.js?v=33";
import {
  googleSignInEnabled,
  liveDraftAccess,
  liveDraftCopy,
} from "./live-draft-access.js?v=2";
import {
  liveDraftBidStep,
  liveDraftErrorText,
  liveDraftMaxBid,
  managerHeading,
  managerPresence,
  managerSquadId,
  renderAllManagerSquads,
  renderSquadPositionTally,
} from "./live-draft-view.js?v=12";

initI18n();

let accountState = {
  authenticated: false,
  googleConfigured: false,
  user: null,
  entitlements: { liveDraft: false },
};
const LIVE_DRAFT_HEARTBEAT_MS = 5000;
let liveDraftRoom = null;
let liveDraftPoll = 0;
let liveDraftHeartbeat = 0;
let lastPingMs = null;
let liveDraftSearchTimer = 0;
let liveDraftSelectedPlayer = null;
let liveDraftPickerOpen = false;
let liveDraftWishlist = [];
let liveDraftWishlistSelectedPlayer = null;
let liveDraftWishlistSearchTimer = 0;
let liveDraftLotClock = 0;
let liveDraftBidLotId = null;
let liveDraftBidFloor = null;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function apiJson(url, options) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function liveDraftAccountAccess() {
  return liveDraftAccess({
    authenticated: accountState.authenticated,
    googleConfigured: accountState.googleConfigured,
    liveDraft: Boolean(accountState.entitlements?.liveDraft),
  });
}

function applyGate(access) {
  const copy = liveDraftCopy(access);
  const meta = document.getElementById("live-draft-meta");
  const text = document.getElementById("live-draft-copy");
  const hint = document.getElementById("live-draft-hint");
  const login = document.getElementById("live-draft-login");
  const gate = document.getElementById("live-draft-access");
  const board = document.getElementById("live-draft-board");
  if (meta) meta.textContent = copy.meta;
  if (text) text.textContent = copy.copy;
  if (hint) hint.textContent = copy.hint;
  if (login) login.hidden = !copy.showLogin;
  if (gate) gate.hidden = access === "ready";
  if (board) board.hidden = access !== "ready";
  if (access !== "ready") stopLiveDraftPoll();
}

function renderAccountBar() {
  const login = document.getElementById("live-draft-account-login");
  if (!login) return;
  const googleOk = googleSignInEnabled(accountState);
  login.hidden = accountState.authenticated;
  login.textContent = googleOk ? "Войти через Google" : "Google-вход не настроен";
}

function renderLiveDraftGate() {
  applyGate(liveDraftAccountAccess());
}

function liveDraftPhoto(url) {
  if (!url) return "";
  return `<img src="${esc(url)}" alt="" width="40" height="40" loading="lazy" />`;
}

function liveDraftPauseCopy(room) {
  if (!room?.paused) return "";
  if (room.pauseReason === "offline") return tr("Пауза: менеджер офлайн");
  if (room.pauseReason === "stop") return tr("Пауза: STOP");
  return tr("Пауза");
}

function liveDraftSecondsLeft(room) {
  const lot = room?.lot;
  if (!lot) return null;
  if (room.paused && lot.hammerRemainingMs != null) {
    return Math.max(0, Math.ceil(lot.hammerRemainingMs / 1000));
  }
  if (!lot.hammerEndsAt) return null;
  return Math.max(0, Math.ceil((lot.hammerEndsAt - Date.now()) / 1000));
}

function liveDraftLotOpen(room) {
  if (!room?.lot || room.status !== "running") return false;
  if (room.paused) return true;
  const left = liveDraftSecondsLeft(room);
  return left == null || left > 0;
}

function showActionError(error) {
  const actionMeta = document.getElementById("live-draft-action-meta");
  if (actionMeta) actionMeta.textContent = liveDraftErrorText(error, tr);
}

function actingManagerEmail() {
  return liveDraftAsEmail("live-draft-bid-as") || liveDraftRoom?.you;
}

function actingManager() {
  const email = actingManagerEmail();
  return (liveDraftRoom?.managers || []).find((manager) => manager.email === email);
}

function actingMaxBid() {
  const manager = actingManager();
  if (manager) return liveDraftMaxBid(manager.budgetLeft, manager.squadSize);
  if (liveDraftRoom?.yourMaxBid != null) return liveDraftRoom.yourMaxBid;
  return liveDraftMaxBid(260, 0);
}

function soldWishlistIds(room) {
  const ids = new Set();
  for (const manager of room?.managers || []) {
    for (const player of manager.squad || []) {
      if (player?.id != null) ids.add(player.id);
    }
  }
  for (const player of room?.squad || []) {
    if (player?.id != null) ids.add(player.id);
  }
  return ids;
}

function visibleWishlist() {
  const sold = soldWishlistIds(liveDraftRoom);
  return liveDraftWishlist.filter((item) => !sold.has(item.playerId));
}

function readBidAmount() {
  return Number(document.getElementById("live-draft-bid-amount")?.value);
}

function writeBidAmount(value) {
  const input = document.getElementById("live-draft-bid-amount");
  if (input) input.value = String(value);
}

function clampBidAmount(value, min, max) {
  let amount = Math.round(Number(value));
  if (!Number.isFinite(amount)) amount = min;
  if (amount < min) amount = min;
  if (Number.isFinite(max) && max >= min && amount > max) amount = max;
  return amount;
}

function nudgeBid(direction) {
  const room = liveDraftRoom;
  if (!liveDraftLotOpen(room) || room?.paused) return;
  const min = room?.lot?.minNextBid ?? 1;
  const max = actingMaxBid();
  if (max < min) return;
  const current = clampBidAmount(readBidAmount(), min, max);
  const step = liveDraftBidStep(current);
  writeBidAmount(clampBidAmount(current + direction * step, min, max));
}

function liveDraftLabel(email) {
  const manager = (liveDraftRoom?.managers || []).find((item) => item.email === email);
  return managerHeading(manager || { email }).label;
}

function fillLiveDraftAsSelect(id, hidden, fallbackEmail) {
  const wrap = document.getElementById(`${id}-wrap`);
  const select = document.getElementById(id);
  if (wrap) wrap.hidden = hidden;
  if (!select) return;
  if (hidden) {
    select.value = "";
    return;
  }
  const previous = select.value;
  const managers = liveDraftRoom?.managers || [];
  select.innerHTML = managers
    .map(
      (manager) =>
        `<option value="${esc(manager.email)}">${esc(managerHeading(manager).label)}</option>`,
    )
    .join("");
  const valid = managers.some((manager) => manager.email === previous);
  select.value = valid ? previous : fallbackEmail || managers[0]?.email || "";
}

function liveDraftAsEmail(id) {
  if (!liveDraftRoom?.admin) return undefined;
  return document.getElementById(id)?.value || undefined;
}

function renderLiveDraftPlayerResults(players) {
  const box = document.getElementById("live-draft-search-results");
  if (!box) return;
  box.innerHTML = (players || []).length
    ? players
        .map(
          (player) => `
            <button type="button" class="col-picker-btn" data-player-id="${player.id}">
              ${esc(player.name)} · ${esc((player.positions || []).join("/"))} · ${esc(player.clubName || "")}
            </button>`,
        )
        .join("")
    : `<p class="meta">${esc(tr("Нет игроков"))}</p>`;
}

async function loadLiveDraftPlayers(query = "") {
  const needle = query.trim();
  const url =
    needle.length >= 2
      ? `/api/live-draft/players?q=${encodeURIComponent(needle)}`
      : "/api/live-draft/players";
  const data = await apiJson(url);
  renderLiveDraftPlayerResults(data.players || []);
}

function wishlistMeta(text) {
  const meta = document.getElementById("live-draft-wishlist-meta");
  if (meta) meta.textContent = text || "";
}

function wishlistFilterValues() {
  return {
    club: document.getElementById("live-draft-wishlist-club")?.value || "",
    position: document.getElementById("live-draft-wishlist-position")?.value || "",
  };
}

function wishlistClubAndPositionSelected() {
  const { club, position } = wishlistFilterValues();
  return Boolean(club && position);
}

function fillWishlistFilterSelect(id, values, allLabel) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    `<option value="">${esc(allLabel)}</option>` +
    values
      .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
      .join("");
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function selectWishlistCandidate(playerId, label) {
  liveDraftWishlistSelectedPlayer = playerId;
  const search = document.getElementById("live-draft-wishlist-search");
  if (search) search.value = label;
  document.getElementById("live-draft-wishlist-amount")?.focus();
}

function renderWishlistPlayerResults(players) {
  const box = document.getElementById("live-draft-wishlist-results");
  if (!box) return;
  if (wishlistClubAndPositionSelected()) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = (players || []).length
    ? players
        .map(
          (player) => `
            <button type="button" class="col-picker-btn" data-wishlist-player-id="${player.id}">
              ${esc(player.name)} · ${esc((player.positions || []).join("/"))} · ${esc(player.clubName || "")}
            </button>`,
        )
        .join("")
    : `<p class="meta">${esc(tr("Нет игроков"))}</p>`;
}

function renderWishlistSuggestions(players, active) {
  const box = document.getElementById("live-draft-wishlist-suggestions");
  const meta = document.getElementById("live-draft-wishlist-filter-meta");
  if (!box) return;
  if (!active) {
    box.hidden = true;
    box.innerHTML = "";
    if (meta) meta.hidden = true;
    return;
  }
  box.hidden = false;
  if (meta) {
    meta.hidden = false;
    meta.textContent = tr("Топ-5 по средней цене Mantra");
  }
  box.innerHTML = (players || []).length
    ? players
        .map((player) => {
          const price =
            player.averagePrice == null ? "" : ` · ${Math.round(player.averagePrice)}`;
          return `
            <button type="button" class="col-picker-btn" data-wishlist-player-id="${player.id}">
              ${esc(player.name)} · ${esc((player.positions || []).join("/"))} · ${esc(player.clubName || "")}${esc(price)}
            </button>`;
        })
        .join("")
    : `<p class="meta">${esc(tr("Нет игроков"))}</p>`;
}

async function loadWishlistPlayers(query = "") {
  if (wishlistClubAndPositionSelected()) {
    renderWishlistPlayerResults([]);
    return;
  }
  const needle = query.trim();
  const url =
    needle.length >= 2
      ? `/api/live-draft/players?q=${encodeURIComponent(needle)}`
      : "/api/live-draft/players";
  const data = await apiJson(url);
  renderWishlistPlayerResults(data.players || []);
}

async function refreshWishlistFilters() {
  const { club, position } = wishlistFilterValues();
  const params = new URLSearchParams();
  if (club) params.set("club", club);
  if (position) params.set("position", position);
  const query = params.toString();
  const data = await apiJson(
    `/api/live-draft/wishlist-filters${query ? `?${query}` : ""}`,
  );
  fillWishlistFilterSelect(
    "live-draft-wishlist-club",
    data.clubs || [],
    tr("Все"),
  );
  fillWishlistFilterSelect(
    "live-draft-wishlist-position",
    data.positions || [],
    tr("Все"),
  );
  renderWishlistSuggestions(data.players || [], Boolean(club || position));
  if (club && position) {
    renderWishlistPlayerResults([]);
    return;
  }
  const results = document.getElementById("live-draft-wishlist-results");
  if (results) results.hidden = false;
}

function applyWishlist(data) {
  liveDraftWishlist = data?.items || [];
  renderWishlist();
}

function renderWishlist() {
  const list = document.getElementById("live-draft-wishlist");
  if (!list) return;
  const active = document.activeElement;
  if (list.contains(active) && active?.matches?.("[data-wishlist-bid]")) return;
  const items = visibleWishlist();
  list.innerHTML = items.length
    ? items
        .map((item) => {
          const player = item.player || {};
          return `
            <article class="live-draft-wishlist-row">
              ${liveDraftPhoto(player.photoUrl)}
              <span class="live-draft-wishlist-name">${esc(player.name || `#${item.playerId}`)} · ${esc((player.positions || []).join("/"))}</span>
              <input
                type="number"
                min="1"
                max="260"
                step="1"
                value="${item.targetBid}"
                data-wishlist-bid="${item.playerId}"
                aria-label="${esc(tr("Ставка"))}"
              />
              <button type="button" class="col-picker-btn danger" data-wishlist-remove="${item.playerId}">
                ${esc(tr("Убрать"))}
              </button>
            </article>`;
        })
        .join("")
    : `<p class="meta">${esc(tr("Пока пусто"))}</p>`;
}

async function refreshLiveDraftWishlist() {
  applyWishlist(await apiJson("/api/live-draft/wishlist"));
}

function renderManagers() {
  const managers = document.getElementById("live-draft-managers");
  if (!managers) return;
  managers.innerHTML = (liveDraftRoom?.managers || [])
    .map((manager) => {
      const heading = managerHeading(manager);
      const squadId = managerSquadId(manager);
      const presence = managerPresence(manager);
      const nameClass = heading.named
        ? "live-draft-manager-name"
        : "live-draft-manager-name is-unnamed";
      const unnamed = heading.named
        ? ""
        : `<span class="meta live-draft-unnamed">${esc(tr("названия ещё нет"))}</span>`;
      const pingMs =
        presence.online && presence.pingMs != null
          ? `${presence.pingMs} ${tr("мс")}`
          : "";
      const pingTitle = presence.online ? tr("онлайн") : tr("офлайн");
      return `
          <article class="live-draft-manager${manager.turn ? " is-turn" : ""}${
            liveDraftRoom?.lot?.highBidder === manager.email ? " is-leader" : ""
          }${manager.folded ? " is-folded" : ""}">
            <strong class="${nameClass}">${esc(heading.label)}</strong>
            <span class="live-draft-ping${presence.online ? " is-online" : ""}" title="${esc(pingTitle)}">
              <span class="live-draft-ping-dot" aria-hidden="true"></span>
              ${pingMs ? `<span class="live-draft-ping-ms">${esc(pingMs)}</span>` : ""}
            </span>
            ${unnamed}
            <span class="meta">${manager.budgetLeft} млн · ${manager.squadSize}/26 · GK ${manager.goalkeepers}${
              squadId != null ? ` · ID ${squadId}` : ""
            }</span>
            ${manager.folded ? `<span class="meta">${esc(tr("Не бидить"))}</span>` : ""}
          </article>`;
    })
    .join("");
}

function renderLiveDraftRoom() {
  const room = liveDraftRoom;
  if (!room) return;
  applyGate("ready");
  const meta = document.getElementById("live-draft-meta");
  const admin = document.getElementById("live-draft-admin");
  const lotBox = document.getElementById("live-draft-lot");
  const nominate = document.getElementById("live-draft-nominate");
  const bid = document.getElementById("live-draft-bid");
  const bidAmount = document.getElementById("live-draft-bid-amount");
  const actionMeta = document.getElementById("live-draft-action-meta");
  if (admin) admin.hidden = !room.admin;
  const stop = document.getElementById("live-draft-stop");
  if (stop) stop.hidden = room.status !== "running";
  const paused = Boolean(room.paused);
  const pauseCopy = liveDraftPauseCopy(room);
  const teamNameInput = document.getElementById("live-draft-team-name-input");
  if (teamNameInput && document.activeElement !== teamNameInput) {
    teamNameInput.value = room.yourTeamName || "";
  }
  if (meta) {
    const you = room.managers.find((manager) => manager.email === room.you);
    const nominatorName = room.nominatorName || liveDraftLabel(room.nominator);
    meta.textContent =
      room.status === "running"
        ? `${pauseCopy ? `${pauseCopy} · ` : `Ход: ${nominatorName || "—"} · `}бюджет ${you?.budgetLeft ?? "—"} · состав ${you?.squadSize ?? 0}/26`
        : room.status === "complete"
          ? "Аукцион завершён"
          : "Лобби · старт от aharodnik";
  }
  if (lotBox) {
    lotBox.classList.toggle("is-open", Boolean(room.lot) && liveDraftLotOpen(room) && !paused);
    lotBox.classList.toggle("is-paused", Boolean(room.lot && paused));
    lotBox.classList.toggle("is-you-leader", Boolean(room.lot?.youAreLeader || room.lot?.highBidder === room.you));
    if (room.lot) {
      const player = room.lot.player || {};
      const left = liveDraftSecondsLeft(room);
      const highBidderName = room.lot.highBidderName || liveDraftLabel(room.lot.highBidder);
      const foldCount = room.lot.foldCount ?? (room.lot.folds || []).length;
      const youLead = room.lot.youAreLeader || room.lot.highBidder === room.you;
      lotBox.innerHTML = `
        <div class="live-draft-lot-head">
          ${liveDraftPhoto(player.photoUrl)}
          <div>
            <strong>${esc(player.name || `#${player.id}`)}</strong>
            <p class="meta">${esc((player.positions || []).join(" / ") || "—")} · ${esc(player.clubName || "")}</p>
            ${youLead ? `<p class="live-draft-lot-flag">${esc(tr("Ты лидер лота"))}</p>` : ""}
          </div>
        </div>
        <p>Ставка ${room.lot.highBid} · ${esc(highBidderName)} · молоток <span id="live-draft-hammer">${left ?? "—"}</span>с · ${esc(tr("Не бидить"))} ${foldCount}${pauseCopy ? ` · ${esc(pauseCopy)}` : ""}</p>
        ${
          room.admin && room.lot.canAutopick
            ? `<button type="button" class="live-draft-autopick" id="live-draft-autopick">${esc(tr("Автопик"))}</button>`
            : ""
        }
        <p class="meta">${(room.lot.bids || [])
          .map((item) => `${esc(item.name || liveDraftLabel(item.email))} ${item.amount}`)
          .join(" · ")}</p>`;
    } else if (room.status === "running") {
      const nominatorName = room.nominatorName || liveDraftLabel(room.nominator);
      lotBox.innerHTML = pauseCopy
        ? `<p>${esc(pauseCopy)}</p>`
        : room.yourTurn
          ? `<p>Твой ход — номинируй игрока АПЛ минимум за 1 млн.</p>`
          : `<p>Ждём номинацию от ${esc(nominatorName || "менеджера")}.</p>`;
    } else {
      lotBox.innerHTML =
        room.status === "complete"
          ? `<p>Все доступные слоты закрыты.</p>`
          : `<p>Админ может начать live-аукцион. Сброс тоже только у aharodnik.</p>`;
    }
  }
  const showNominate =
    room.status === "running" && !paused && !room.lot && (room.yourTurn || room.admin);
  if (nominate) {
    if (showNominate && !liveDraftPickerOpen) {
      liveDraftPickerOpen = true;
      loadLiveDraftPlayers(
        document.getElementById("live-draft-search")?.value || "",
      ).catch(() => {});
    }
    if (!showNominate) liveDraftPickerOpen = false;
    nominate.hidden = !showNominate;
    const nominateAmount = document.getElementById("live-draft-nominate-amount");
    if (nominateAmount) {
      const as = liveDraftAsEmail("live-draft-nominate-as") || room.you;
      const manager = (room.managers || []).find((item) => item.email === as);
      const nominateMax = manager
        ? liveDraftMaxBid(manager.budgetLeft, manager.squadSize)
        : actingMaxBid();
      nominateAmount.max = String(Math.max(1, nominateMax));
    }
  }
  fillLiveDraftAsSelect(
    "live-draft-nominate-as",
    !(room.admin && showNominate),
    room.nominator || room.you,
  );
  const youLead = Boolean(room.lot?.youAreLeader || room.lot?.highBidder === room.you);
  const lotOpen = liveDraftLotOpen(room) && !paused;
  const minNext = room.lot?.minNextBid ?? 1;
  const maxBid = actingMaxBid();
  const canAffordNext = maxBid >= minNext;
  const showBid =
    lotOpen &&
    (room.admin || (!youLead && !room.lot.youFolded)) &&
    canAffordNext;
  if (bid) {
    bid.hidden = !showBid;
    if (bidAmount && room.lot) {
      bidAmount.min = String(minNext);
      bidAmount.max = String(Math.max(minNext, maxBid));
      const lotChanged = liveDraftBidLotId !== room.lot.id;
      const floorChanged = liveDraftBidFloor !== minNext;
      if (lotChanged || floorChanged || document.activeElement !== bidAmount) {
        if (lotChanged || floorChanged) {
          bidAmount.value = String(minNext);
          liveDraftBidLotId = room.lot.id;
          liveDraftBidFloor = minNext;
        } else if (document.activeElement !== bidAmount) {
          const current = Number(bidAmount.value);
          if (!Number.isFinite(current) || current < minNext) {
            bidAmount.value = String(minNext);
          } else if (current > maxBid && maxBid >= minNext) {
            bidAmount.value = String(maxBid);
          }
        }
      }
    }
    const submit = bid.querySelector(".live-draft-bid-submit");
    if (submit) submit.disabled = !showBid;
  }
  const bidCap = document.getElementById("live-draft-bid-cap");
  if (bidCap) {
    if (room.lot && lotOpen) {
      bidCap.hidden = false;
      bidCap.textContent = canAffordNext
        ? `${tr("макс.")} ${maxBid}`
        : `${tr("Нельзя перебить")}: ${tr("макс.")} ${maxBid}, ${tr("минимум")} ${minNext}`;
    } else {
      bidCap.hidden = true;
      bidCap.textContent = "";
    }
  }
  fillLiveDraftAsSelect("live-draft-bid-as", !(room.admin && showBid), room.you);
  const foldBtn = document.getElementById("live-draft-fold");
  if (foldBtn) {
    const folded = Boolean(room.lot?.youFolded);
    const showFold = lotOpen && !youLead;
    foldBtn.hidden = !showFold;
    foldBtn.classList.toggle("is-pressed", folded);
    foldBtn.setAttribute("aria-pressed", folded ? "true" : "false");
    foldBtn.disabled = paused || folded || !lotOpen;
    if (!room.lot) {
      foldBtn.classList.remove("is-pressed");
      foldBtn.setAttribute("aria-pressed", "false");
    }
  }
  if (actionMeta) actionMeta.textContent = "";
  renderManagers();
  renderWishlist();
  const squad = document.getElementById("live-draft-squad");
  if (squad) {
    const rows = (room.squad || []).length
      ? room.squad
          .map(
            (player) => `
              <article class="live-draft-squad-row">
                ${liveDraftPhoto(player.photoUrl)}
                <span>${esc(player.name)} · ${esc((player.positions || []).join("/"))} · ${player.amount}</span>
              </article>`,
          )
          .join("")
      : `<p class="meta">Пока пусто</p>`;
    squad.innerHTML = `${renderSquadPositionTally(room.squad)}${rows}`;
  }
  const allSquads = document.getElementById("live-draft-all-squads");
  if (allSquads) {
    const active = document.activeElement;
    if (
      !(
        allSquads.contains(active) &&
        active?.closest?.(".live-draft-correct, .live-draft-release")
      )
    ) {
      allSquads.innerHTML = renderAllManagerSquads(room.managers, {
        emptyLabel: tr("Пока пусто"),
        admin: Boolean(room.admin),
        saveLabel: "OK",
        amountLabel: tr("Ставка"),
        ownerLabel: tr("За менеджера"),
        releaseLabel: tr("Удалить в аукцион"),
      });
    }
  }
  if (room.lot) startLiveDraftLotClock();
  else stopLiveDraftLotClock();
}

function stopLiveDraftHeartbeat() {
  if (liveDraftHeartbeat) {
    clearInterval(liveDraftHeartbeat);
    liveDraftHeartbeat = 0;
  }
}

async function sendLiveDraftHeartbeat() {
  const started = Date.now();
  try {
    await apiJson("/api/live-draft/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pingMs: lastPingMs }),
    });
    lastPingMs = Date.now() - started;
  } catch {
    // Room poll still flips the manager red after 15s without a beat.
  }
}

function startLiveDraftHeartbeat() {
  stopLiveDraftHeartbeat();
  sendLiveDraftHeartbeat().catch(() => {});
  liveDraftHeartbeat = setInterval(() => {
    sendLiveDraftHeartbeat().catch(() => {});
  }, LIVE_DRAFT_HEARTBEAT_MS);
}

function stopLiveDraftLotClock() {
  if (liveDraftLotClock) {
    clearInterval(liveDraftLotClock);
    liveDraftLotClock = 0;
  }
}

function startLiveDraftLotClock() {
  if (liveDraftLotClock) return;
  liveDraftLotClock = setInterval(() => {
    const room = liveDraftRoom;
    if (!room?.lot) {
      stopLiveDraftLotClock();
      return;
    }
    const hammer = document.getElementById("live-draft-hammer");
    const left = liveDraftSecondsLeft(room);
    if (hammer) hammer.textContent = left ?? "—";
    if (!liveDraftLotOpen(room) && !document.getElementById("live-draft-bid")?.hidden) {
      renderLiveDraftRoom();
    }
  }, 200);
}

function stopLiveDraftPoll() {
  if (liveDraftPoll) {
    clearInterval(liveDraftPoll);
    liveDraftPoll = 0;
  }
  stopLiveDraftHeartbeat();
  stopLiveDraftLotClock();
}

async function refreshLiveDraftRoom() {
  liveDraftRoom = await apiJson("/api/live-draft/room");
  renderLiveDraftRoom();
  if (liveDraftRoom?.lot) startLiveDraftLotClock();
  else stopLiveDraftLotClock();
}

function startLiveDraftPoll() {
  stopLiveDraftPoll();
  liveDraftPoll = setInterval(() => {
    refreshLiveDraftRoom().catch(() => {});
  }, 1000);
}

function bindGoogleLogin(id) {
  document.getElementById(id)?.addEventListener("click", (event) => {
    if (googleSignInEnabled(accountState)) return;
    event.preventDefault();
    alert(tr("Google-вход ещё не настроен на сервере."));
  });
}

bindGoogleLogin("live-draft-account-login");
bindGoogleLogin("live-draft-login");

document.getElementById("live-draft-start")?.addEventListener("click", async () => {
  try {
    liveDraftRoom = await apiJson("/api/live-draft/start", { method: "POST" });
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-stop")?.addEventListener("click", async () => {
  try {
    liveDraftRoom = await apiJson("/api/live-draft/stop", { method: "POST" });
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-reset")?.addEventListener("click", async () => {
  if (!confirm(tr("Сбросить аукцион?"))) return;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/reset", { method: "POST" });
    liveDraftSelectedPlayer = null;
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-search")?.addEventListener("input", (event) => {
  const query = event.target.value.trim();
  clearTimeout(liveDraftSearchTimer);
  liveDraftSearchTimer = setTimeout(async () => {
    try {
      await loadLiveDraftPlayers(query);
    } catch (error) {
      const box = document.getElementById("live-draft-search-results");
      if (box) box.textContent = liveDraftErrorText(error, tr);
    }
  }, 250);
});

document.getElementById("live-draft-search-results")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-player-id]");
  if (!button) return;
  liveDraftSelectedPlayer = Number(button.dataset.playerId);
  const search = document.getElementById("live-draft-search");
  if (search) search.value = button.textContent.trim();
});

document.getElementById("live-draft-nominate")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = document.getElementById("live-draft-nominate-amount")?.value;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/nominate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: liveDraftSelectedPlayer,
        amount,
        asEmail: liveDraftAsEmail("live-draft-nominate-as"),
      }),
    });
    liveDraftSelectedPlayer = null;
    const search = document.getElementById("live-draft-search");
    if (search) search.value = "";
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-team-name")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const teamName = document.getElementById("live-draft-team-name-input")?.value ?? "";
  try {
    liveDraftRoom = await apiJson("/api/live-draft/team-name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamName }),
    });
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-bid")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = document.getElementById("live-draft-bid-amount")?.value;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/bid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount,
        asEmail: liveDraftAsEmail("live-draft-bid-as"),
      }),
    });
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-bid-up")?.addEventListener("click", () => nudgeBid(1));
document.getElementById("live-draft-bid-down")?.addEventListener("click", () => nudgeBid(-1));

document.getElementById("live-draft-bid")?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    nudgeBid(1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    nudgeBid(-1);
  }
});

document.getElementById("live-draft-all-squads")?.addEventListener("submit", async (event) => {
  const releaseForm = event.target.closest("[data-release-player]");
  if (releaseForm) {
    event.preventDefault();
    if (
      !confirm(
        tr(
          "Снять игрока со состава и вернуть в живой аукцион? Текущие ставки и уже купленные игроки не сбросятся. Это нельзя легко отменить.",
        ),
      )
    ) {
      return;
    }
    const playerId = Number(releaseForm.dataset.releasePlayer);
    const email = releaseForm.dataset.releaseEmail;
    try {
      liveDraftRoom = await apiJson("/api/live-draft/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, email }),
      });
      renderLiveDraftRoom();
    } catch (error) {
      showActionError(error);
    }
    return;
  }
  const form = event.target.closest("[data-correct-player]");
  if (!form) return;
  event.preventDefault();
  const playerId = Number(form.dataset.correctPlayer);
  const amount = form.querySelector("[data-correct-amount]")?.value;
  const email = form.querySelector("[data-correct-owner]")?.value;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/correct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, amount, email }),
    });
    renderLiveDraftRoom();
  } catch (error) {
    showActionError(error);
  }
});

document.getElementById("live-draft-fold")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.disabled || button.classList.contains("is-pressed")) return;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/fold", { method: "POST" });
    renderLiveDraftRoom();
  } catch (error) {
    button.classList.remove("is-pressed");
    button.setAttribute("aria-pressed", "false");
    showActionError(error);
  }
});

document.getElementById("live-draft-lot")?.addEventListener("click", async (event) => {
  const button = event.target.closest("#live-draft-autopick");
  if (!button || button.disabled) return;
  if (
    !confirm(tr("Закрыть лот сейчас? Игрок уйдёт текущему лидеру."))
  ) {
    return;
  }
  button.disabled = true;
  try {
    liveDraftRoom = await apiJson("/api/live-draft/autopick", { method: "POST" });
    renderLiveDraftRoom();
  } catch (error) {
    button.disabled = false;
    showActionError(error);
  }
});

document.getElementById("live-draft-wishlist-search")?.addEventListener("focus", () => {
  if (wishlistClubAndPositionSelected()) return;
  if (document.getElementById("live-draft-wishlist-results")?.childElementCount) return;
  loadWishlistPlayers(
    document.getElementById("live-draft-wishlist-search")?.value || "",
  ).catch(() => {});
});

document.getElementById("live-draft-wishlist-search")?.addEventListener("input", (event) => {
  const query = event.target.value.trim();
  clearTimeout(liveDraftWishlistSearchTimer);
  liveDraftWishlistSearchTimer = setTimeout(async () => {
    try {
      await loadWishlistPlayers(query);
    } catch (error) {
      const box = document.getElementById("live-draft-wishlist-results");
      if (box) box.textContent = liveDraftErrorText(error, tr);
    }
  }, 250);
});

document.getElementById("live-draft-wishlist-results")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-wishlist-player-id]");
  if (!button) return;
  selectWishlistCandidate(Number(button.dataset.wishlistPlayerId), button.textContent.trim());
});

document.getElementById("live-draft-wishlist-suggestions")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-wishlist-player-id]");
  if (!button) return;
  selectWishlistCandidate(Number(button.dataset.wishlistPlayerId), button.textContent.trim());
});

document.getElementById("live-draft-wishlist-club")?.addEventListener("change", () => {
  refreshWishlistFilters().catch((error) => {
    wishlistMeta(liveDraftErrorText(error, tr));
  });
});

document.getElementById("live-draft-wishlist-position")?.addEventListener("change", () => {
  refreshWishlistFilters().catch((error) => {
    wishlistMeta(liveDraftErrorText(error, tr));
  });
});

document.getElementById("live-draft-wishlist-add")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = document.getElementById("live-draft-wishlist-amount")?.value;
  try {
    if (!liveDraftWishlistSelectedPlayer) {
      wishlistMeta(tr("Выбери игрока из поиска"));
      return;
    }
    applyWishlist(
      await apiJson("/api/live-draft/wishlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: liveDraftWishlistSelectedPlayer,
          targetBid: amount,
        }),
      }),
    );
    liveDraftWishlistSelectedPlayer = null;
    const search = document.getElementById("live-draft-wishlist-search");
    const results = document.getElementById("live-draft-wishlist-results");
    if (search) search.value = "";
    if (results) results.innerHTML = "";
    wishlistMeta("");
  } catch (error) {
    wishlistMeta(liveDraftErrorText(error, tr));
  }
});

document.getElementById("live-draft-wishlist")?.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-wishlist-bid]");
  if (!input) return;
  const playerId = Number(input.dataset.wishlistBid);
  try {
    applyWishlist(
      await apiJson("/api/live-draft/wishlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, targetBid: input.value }),
      }),
    );
    wishlistMeta("");
  } catch (error) {
    wishlistMeta(liveDraftErrorText(error, tr));
  }
});

document.getElementById("live-draft-wishlist")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-wishlist-remove]");
  if (!button) return;
  const playerId = Number(button.dataset.wishlistRemove);
  try {
    applyWishlist(
      await apiJson(`/api/live-draft/wishlist?playerId=${encodeURIComponent(playerId)}`, {
        method: "DELETE",
      }),
    );
    wishlistMeta("");
  } catch (error) {
    wishlistMeta(liveDraftErrorText(error, tr));
  }
});

async function boot() {
  const [accountSettled, roomSettled] = await Promise.allSettled([
    apiJson("/api/me"),
    apiJson("/api/live-draft/room"),
  ]);
  if (accountSettled.status === "fulfilled") {
    accountState = accountSettled.value;
  }
  renderAccountBar();
  if (roomSettled.status === "fulfilled") {
    liveDraftRoom = roomSettled.value;
    renderLiveDraftRoom();
    startLiveDraftPoll();
    startLiveDraftHeartbeat();
    refreshLiveDraftWishlist().catch(() => {});
    refreshWishlistFilters().catch(() => {});
    return;
  }
  renderLiveDraftGate();
  const error = roomSettled.reason;
  if (error?.status === 401) {
    applyGate(accountState.googleConfigured ? "login" : "unconfigured");
    return;
  }
  if (error?.status === 403) {
    applyGate("forbidden");
    return;
  }
  const meta = document.getElementById("live-draft-meta");
  if (meta) meta.textContent = liveDraftErrorText(error, tr);
}

window.addEventListener("pagehide", () => {
  stopLiveDraftPoll();
});

boot();
