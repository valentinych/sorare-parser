import {
  formatUiDateTime,
  getUiLocale,
  getUiTimeZone,
  initI18n,
  setUiPreferences,
  tr,
} from "./i18n.js?v=28";
import { googleSignInEnabled } from "./live-draft-access.js?v=1";

initI18n();

export const PAGE_PATHS = {
  clubs: "/clubs",
  players: "/players",
  matches: "/matches",
  live: "/live",
  auctions: "/auctions",
  xi: "/xi",
  sorare: "/sorare",
  mapping: "/mapping",
  premium: "/premium",
  "league-one": "/league-one",
  builder: "/builder",
  ref: "/ref",
  "live-draft": "/live-draft",
};

export const TM_PAGES = new Set(["clubs", "players", "matches", "xi", "builder", "ref"]);
export const LEAGUE_PAGES = new Set(["clubs", "players", "matches", "live", "xi", "builder"]);

/** @type {{ authenticated: boolean, googleConfigured: boolean, user: any, entitlements: any, sorare: any, sorareInside: any }} */
export let accountState = {
  authenticated: false,
  googleConfigured: false,
  user: null,
  entitlements: { expected11Premium: false, expected11Admin: false, liveDraft: false },
  sorare: { source: "sorare_jwt", configured: false, authenticated: false, status: "disabled" },
  sorareInside: { enabled: true, connected: false, status: "empty", count: 0 },
};

/** @type {any[]} */
export let competitions = [];
/** Hidden championships stay off the dropdown but still resolve ?league=. */
/** @type {{ id: string, slug?: string, name?: string }[]} */
export let competitionResolve = [];
/** @type {string} */
export let activeCompetitionId = localStorage.getItem("tmCompetition") || "PL1";

export function setAccountState(next) {
  accountState = next;
}

export function setCompetitions(next, resolve = []) {
  competitions = next;
  competitionResolve = resolve;
}

export function setActiveCompetitionId(id) {
  activeCompetitionId = id;
  localStorage.setItem("tmCompetition", id);
}

/** Page hooks so account save/logout can refresh the open feature. */
export const pageHooks = {
  onAccountChanged: () => {},
  onLoggedOut: () => {},
};

let contentLoadingDepth = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let contentLoadingHideTimer = null;

export function showContentLoading() {
  contentLoadingDepth += 1;
  if (contentLoadingHideTimer) {
    clearTimeout(contentLoadingHideTimer);
    contentLoadingHideTimer = null;
  }
  const el = document.getElementById("content-loading");
  if (!el) return;
  el.hidden = false;
  el.setAttribute("aria-hidden", "false");
  el.setAttribute("aria-busy", "true");
  document.body.setAttribute("aria-busy", "true");
}

export function hideContentLoading() {
  contentLoadingDepth = Math.max(0, contentLoadingDepth - 1);
  if (contentLoadingDepth > 0) return;
  if (contentLoadingHideTimer) clearTimeout(contentLoadingHideTimer);
  contentLoadingHideTimer = setTimeout(() => {
    contentLoadingHideTimer = null;
    if (contentLoadingDepth > 0) return;
    const el = document.getElementById("content-loading");
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("aria-busy", "false");
    document.body.removeAttribute("aria-busy");
  }, 80);
}

/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
export async function withContentLoading(fn) {
  showContentLoading();
  try {
    return await fn();
  } finally {
    hideContentLoading();
  }
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatMoney(value) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

export function formatHeight(h) {
  if (h == null) return "—";
  return `${Number(h).toFixed(2)} m`;
}

export function formatDate(iso) {
  return formatUiDateTime(iso);
}

export function playerHref(id) {
  return `/player.html?id=${encodeURIComponent(id)}`;
}

export function formatPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

export function builderInitials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export function currentPage() {
  return document.body?.dataset?.page || "clubs";
}

export function slugifyLeagueName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Human names for the six UI championships — same labels as the header dropdown. */
export const LEAGUE_UI_LABELS = {
  ekstraklasa: "Экстракласса",
  "serie-a": "Серия А",
  bundesliga: "Бундеслига",
  "premier-league": "Премьер-лига",
  championship: "Чемпионшип",
  "super-lig": "Суперлига",
};

const TM_TO_LEAGUE_SLUG = {
  PL1: "ekstraklasa",
  IT1: "serie-a",
  L1: "bundesliga",
  GB1: "premier-league",
  GB2: "championship",
  TR1: "super-lig",
};

/**
 * Localized championship name. Never returns a URL slug like `championship`.
 * English API names ("Championship") map to «Чемпионшип», not generic «Чемпионат».
 */
export function leagueUiLabel(parts = {}) {
  const slug = String(parts.slug || "").trim().toLowerCase();
  const tmId = String(parts.tmId || "").trim();
  const name = String(parts.name || "").trim();
  const fromTm = TM_TO_LEAGUE_SLUG[tmId] || TM_TO_LEAGUE_SLUG[tmId.toUpperCase()];
  const fromName = name ? slugifyLeagueName(name) : "";
  const key = [slug, fromTm, fromName].find((k) => k && LEAGUE_UI_LABELS[k]);
  if (key) return tr(LEAGUE_UI_LABELS[key]);
  if (name && name !== slug) return tr(name);
  return "";
}

export function replacePathQuery(path, qs) {
  const next = qs && [...qs].length ? `${path}?${qs}` : path;
  const cur = `${location.pathname}${location.search}`;
  if (cur === next) return;
  history.replaceState(null, "", next);
}

function fillAccountTimeZones(selectedTimeZone) {
  const select = document.getElementById("account-time-zone");
  if (!select) return;
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [browserTimeZone, "UTC"];
  const selected = selectedTimeZone || getUiTimeZone() || browserTimeZone;
  if (!timeZones.includes(selected)) timeZones.push(selected);
  select.innerHTML = [...new Set(timeZones)]
    .sort((a, b) => a.localeCompare(b))
    .map((timeZone) => `<option value="${esc(timeZone)}">${esc(timeZone)}</option>`)
    .join("");
  select.value = selected;
}

function renderSorareInsideConnection() {
  const connection = accountState.sorareInside || {
    enabled: true,
    connected: false,
    status: "empty",
    count: 0,
  };
  const accountStatus = document.getElementById("account-si-status");
  const accountConnect = document.getElementById("account-si-connect");
  const accountDisconnect = document.getElementById("account-si-disconnect");
  const connected = Boolean(connection.connected);
  let status = "Импортов пока нет";
  if (connection.status === "ready" && connection.importedAt) {
    status = `${connection.count || 0} прогнозов · ${formatUiDateTime(
      new Date(connection.importedAt).toISOString(),
    )}`;
  }
  if (accountStatus) accountStatus.textContent = status;
  if (accountConnect) accountConnect.hidden = !accountState.authenticated;
  if (accountDisconnect) accountDisconnect.hidden = !connected;
}

function renderSorareAuthentication() {
  const authentication = accountState.sorare || {
    configured: false,
    authenticated: false,
    status: "disabled",
    expiresAt: null,
  };
  const element = document.getElementById("account-sorare-status");
  if (!element) return;
  let status = "Sorare JWT не настроен на сервере";
  if (authentication.status === "not_checked") {
    status = "Sorare JWT настроен · вход при первом запросе";
  } else if (authentication.status === "ready" && authentication.expiresAt) {
    status = `Sorare JWT подключён до ${formatUiDateTime(authentication.expiresAt)}`;
  } else if (authentication.status === "two_factor_required") {
    status = "Sorare требует 2FA · автоматический вход остановлен";
  } else if (authentication.status === "terms_required") {
    status = "Sorare требует принять обновлённые условия";
  } else if (authentication.status === "error") {
    status = "Ошибка входа Sorare";
  }
  element.textContent = status;
}

export function renderAccount() {
  const login = document.getElementById("account-login");
  const button = document.getElementById("account-button");
  const user = accountState.user;
  if (login) login.hidden = accountState.authenticated;
  if (button) button.hidden = !accountState.authenticated;
  const googleOk = googleSignInEnabled(accountState);
  if (login) {
    login.textContent = googleOk ? "Войти через Google" : "Google-вход не настроен";
    login.setAttribute("aria-disabled", googleOk ? "false" : "true");
  }
  const expected11Premium = Boolean(
    accountState.authenticated && accountState.entitlements?.expected11Premium,
  );
  const expected11Admin = Boolean(
    accountState.authenticated && accountState.entitlements?.expected11Admin,
  );
  const mappingTab = document.querySelector(`.tab[data-view="mapping"]`);
  if (mappingTab) mappingTab.hidden = !expected11Admin;
  const leagueOneTab = document.querySelector(`.tab[data-view="league-one"]`);
  if (leagueOneTab) leagueOneTab.hidden = !expected11Admin;
  const premiumTab = document.querySelector(`.tab[data-view="premium"]`);
  if (premiumTab) premiumTab.hidden = !expected11Premium;
  const liveDraft = Boolean(
    accountState.authenticated && accountState.entitlements?.liveDraft,
  );
  const liveDraftTab = document.querySelector(`.tab[data-view="live-draft"]`);
  if (liveDraftTab) liveDraftTab.hidden = !liveDraft;

  const localeEl = document.getElementById("account-locale");
  if (user) {
    setUiPreferences({
      locale: user.locale || getUiLocale(),
      timeZone: user.timeZone || getUiTimeZone(),
    });
    const nameEl = document.getElementById("account-name");
    if (nameEl) nameEl.textContent = user.name || user.email;
    const avatar = document.getElementById("account-avatar");
    if (avatar) {
      avatar.hidden = !user.pictureUrl;
      avatar.src = user.pictureUrl || "";
    }
    const dialogName = document.getElementById("account-dialog-name");
    if (dialogName) dialogName.textContent = user.name || "Аккаунт";
    const dialogEmail = document.getElementById("account-dialog-email");
    if (dialogEmail) dialogEmail.textContent = user.email;
    const dialogAvatar = document.getElementById("account-dialog-avatar");
    if (dialogAvatar) {
      dialogAvatar.hidden = !user.pictureUrl;
      dialogAvatar.src = user.pictureUrl || "";
    }
    const managerId = document.getElementById("account-manager-id");
    if (managerId) managerId.value = user.mantraManagerId || "";
    if (localeEl) localeEl.value = user.locale || getUiLocale();
    fillAccountTimeZones(user.timeZone || getUiTimeZone());
  } else if (localeEl) {
    localeEl.value = getUiLocale();
    fillAccountTimeZones(getUiTimeZone());
  }

  renderSorareAuthentication();
  renderSorareInsideConnection();
  pageHooks.onAccountChanged();
}

export async function loadAccount() {
  try {
    accountState = await apiJson("/api/me");
  } catch {
    accountState = {
      authenticated: false,
      googleConfigured: false,
      user: null,
      entitlements: { expected11Premium: false, expected11Admin: false, liveDraft: false },
      sorare: {
        source: "sorare_jwt",
        configured: false,
        authenticated: false,
        status: "disabled",
      },
      sorareInside: { enabled: true, connected: false, status: "empty", count: 0 },
    };
  }
  renderAccount();
}

export async function loadCompetitionsList() {
  const res = await fetch("/api/competitions");
  const data = res.ok ? await res.json() : { competitions: [] };
  competitions = data.competitions || [];
  competitionResolve = data.resolve || [];
}

function bindAccountListeners() {
  document.getElementById("account-login")?.addEventListener("click", (e) => {
    if (googleSignInEnabled(accountState)) return;
    e.preventDefault();
    alert(tr("Google-вход ещё не настроен на сервере."));
  });
  document.getElementById("account-button")?.addEventListener("click", async () => {
    const message = document.getElementById("account-message");
    if (message) message.textContent = "";
    await loadAccount();
    document.getElementById("account-dialog")?.showModal();
  });
  document.getElementById("account-si-generate")?.addEventListener("click", async () => {
    const message = document.getElementById("account-message");
    const codeWrap = document.getElementById("account-si-code-wrap");
    const codeElement = document.getElementById("account-si-code");
    const expiry = document.getElementById("account-si-code-expiry");
    if (message) message.textContent = "Создание кода…";
    try {
      const data = await apiJson("/api/me/sorareinside/import-code", {
        method: "POST",
      });
      if (codeElement) codeElement.textContent = data.code;
      if (expiry) {
        expiry.textContent = `Код действует до ${formatUiDateTime(
          new Date(data.expiresAt).toISOString(),
        )} и только для одной загрузки.`;
      }
      if (codeWrap) codeWrap.hidden = false;
      if (message) message.textContent = "Код готов — вставь его в панель Mantra import на sorare.com";
    } catch (error) {
      if (message) message.textContent = `Ошибка: ${error.message}`;
    }
  });
  document.getElementById("account-si-disconnect")?.addEventListener("click", async () => {
    const message = document.getElementById("account-message");
    if (message) message.textContent = "Очистка импорта…";
    try {
      const data = await apiJson("/api/me/sorareinside", { method: "DELETE" });
      accountState.sorareInside = data.connection;
      renderAccount();
      if (message) message.textContent = "Импортированные прогнозы удалены";
    } catch (error) {
      if (message) message.textContent = `Ошибка: ${error.message}`;
    }
  });
  document.getElementById("account-save")?.addEventListener("click", async () => {
    const message = document.getElementById("account-message");
    const input = document.getElementById("account-manager-id");
    const locale = document.getElementById("account-locale")?.value;
    const timeZone = document.getElementById("account-time-zone")?.value;
    if (message) message.textContent = "Сохранение…";
    try {
      const data = await apiJson("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mantraManagerId: input?.value.trim() || null,
          locale,
          timeZone,
        }),
      });
      accountState.user = data.user;
      setUiPreferences({ locale: data.user.locale, timeZone: data.user.timeZone });
      renderAccount();
      if (message) message.textContent = tr("Настройки сохранены");
    } catch (error) {
      if (message) message.textContent = `Ошибка: ${error.message}`;
    }
  });
  document.getElementById("account-logout")?.addEventListener("click", async () => {
    try {
      await apiJson("/api/logout", { method: "POST" });
      accountState = {
        authenticated: false,
        googleConfigured: accountState.googleConfigured,
        user: null,
        entitlements: { expected11Premium: false, expected11Admin: false, liveDraft: false },
        sorare: accountState.sorare,
        sorareInside: {
          enabled: true,
          connected: false,
          status: "empty",
          count: 0,
        },
      };
      document.getElementById("account-dialog")?.close();
      renderAccount();
      pageHooks.onLoggedOut();
    } catch (error) {
      const message = document.getElementById("account-message");
      if (message) message.textContent = `Ошибка: ${error.message}`;
    }
  });
}

let accountBound = false;

export async function bootCore() {
  if (!accountBound) {
    bindAccountListeners();
    accountBound = true;
  }
  await loadAccount();
}

export { formatUiDateTime, getUiLocale, getUiTimeZone, setUiPreferences, tr, googleSignInEnabled };
