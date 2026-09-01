/**
 * Live-draft page access. Session wins over googleConfigured:
 * a valid Google session is enough even if the OAuth client is missing.
 *
 * @param {{ authenticated?: boolean, googleConfigured?: boolean, liveDraft?: boolean }} account
 * @returns {"ready" | "forbidden" | "login" | "unconfigured"}
 */
export function liveDraftAccess(account = {}) {
  if (account.authenticated) return account.liveDraft ? "ready" : "forbidden";
  return account.googleConfigured ? "login" : "unconfigured";
}

export function googleSignInEnabled(account = {}) {
  return Boolean(account.authenticated || account.googleConfigured);
}

export function liveDraftCopy(access) {
  if (access === "ready") {
    return {
      meta: "Живой аукцион АПЛ",
      copy: "Официальный live-аукцион Mantra: бюджет 260 млн, состав 26 игроков, минимум 3 вратаря.",
      hint: "Номинация по очереди от 1 млн. Шаг ставки по правилам. Молоток — 15 секунд.",
      showLogin: false,
    };
  }
  if (access === "forbidden") {
    return {
      meta: "Нет доступа",
      copy: "Нет доступа к живому драфту.",
      hint: "Этот раздел доступен только участникам драфта.",
      showLogin: false,
    };
  }
  if (access === "login") {
    return {
      meta: "Нужен вход",
      copy: "Войди через Google, чтобы открыть живой драфт.",
      hint: "",
      showLogin: true,
    };
  }
  return {
    meta: "Google-вход не настроен",
    copy: "Google-вход не настроен",
    hint: "Google-вход ещё не настроен на сервере.",
    showLogin: false,
  };
}
