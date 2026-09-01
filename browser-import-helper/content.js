(() => {
  "use strict";

  const copy = {
    en: {
      title: "Mantra browser import",
      privacy: "Reads visible Companion ribbons only.",
      placeholder: "One-time import code",
      button: "Import visible projections",
      visible: (count) => `${count} visible projection${count === 1 ? "" : "s"}`,
      code: "Paste a valid code from mantra.panenka.games.",
      empty: "No visible ready Companion ribbons found.",
      many: "More than 200 projections are visible. Narrow the Sorare page.",
      sending: "Uploading sanitized projection fields…",
      done: (count) => `Imported ${count}. This code is now consumed.`,
      failed: (error) => `Import failed: ${error}`,
    },
    ru: {
      title: "Browser import в Mantra",
      privacy: "Читает только видимые ленты Companion.",
      placeholder: "Одноразовый код импорта",
      button: "Импортировать видимые прогнозы",
      visible: (count) => `Видимых прогнозов: ${count}`,
      code: "Вставьте код с mantra.panenka.games.",
      empty: "Нет видимых готовых лент Companion.",
      many: "Видно больше 200 прогнозов. Сузьте страницу Sorare.",
      sending: "Загрузка очищенных полей прогнозов…",
      done: (count) => `Импортировано: ${count}. Код использован.`,
      failed: (error) => `Ошибка импорта: ${error}`,
    },
    uk: {
      title: "Browser import у Mantra",
      privacy: "Читає лише видимі стрічки Companion.",
      placeholder: "Одноразовий код імпорту",
      button: "Імпортувати видимі прогнози",
      visible: (count) => `Видимих прогнозів: ${count}`,
      code: "Вставте код із mantra.panenka.games.",
      empty: "Немає видимих готових стрічок Companion.",
      many: "Видно понад 200 прогнозів. Звузьте сторінку Sorare.",
      sending: "Завантаження очищених полів прогнозів…",
      done: (count) => `Імпортовано: ${count}. Код використано.`,
      failed: (error) => `Помилка імпорту: ${error}`,
    },
    be: {
      title: "Browser import у Mantra",
      privacy: "Чытае толькі бачныя стужкі Companion.",
      placeholder: "Аднаразовы код імпарту",
      button: "Імпартаваць бачныя прагнозы",
      visible: (count) => `Бачных прагнозаў: ${count}`,
      code: "Устаўце код з mantra.panenka.games.",
      empty: "Няма бачных гатовых стужак Companion.",
      many: "Бачна больш за 200 прагнозаў. Звузьце старонку Sorare.",
      sending: "Загрузка ачышчаных палёў прагнозаў…",
      done: (count) => `Імпартавана: ${count}. Код выкарыстаны.`,
      failed: (error) => `Памылка імпарту: ${error}`,
    },
  };
  const language = (navigator.language || "en").toLowerCase();
  const locale = language.startsWith("ru")
    ? "ru"
    : language.startsWith("uk")
      ? "uk"
      : language.startsWith("be")
        ? "be"
        : "en";
  const text = copy[locale];

  const host = document.createElement("div");
  host.id = "mantra-sorare-browser-import";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
        box-sizing: border-box; width: min(340px, calc(100vw - 24px));
        padding: 12px; border: 1px solid #3d3d46; border-radius: 12px;
        background: #17171c; color: #f6f6f7; box-shadow: 0 8px 28px #0008;
        font: 13px/1.35 system-ui, sans-serif;
      }
      strong { display: block; margin-right: 32px; font-size: 14px; }
      p { margin: 4px 0 10px; color: #b8b8c2; }
      input, button { box-sizing: border-box; width: 100%; min-height: 38px; border-radius: 8px; }
      input { margin-bottom: 7px; border: 1px solid #555560; padding: 8px 10px; background: #0d0d11; color: white; }
      button { border: 0; padding: 8px 10px; background: #ef3340; color: white; font-weight: 700; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .65; }
      .status { min-height: 18px; margin: 8px 0 0; font-size: 12px; }
      .close { position: absolute; top: 7px; right: 8px; width: 28px; min-height: 28px; background: transparent; font-size: 19px; }
      .open { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: auto; min-height: 38px; padding: 8px 12px; border-radius: 20px; }
      [hidden] { display: none !important; }
      @media (max-width: 520px) {
        .panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
        .open { right: 8px; bottom: 8px; }
      }
    </style>
    <button class="open" type="button" hidden>Mantra import</button>
    <section class="panel">
      <button class="close" type="button" aria-label="Close">×</button>
      <strong></strong>
      <p class="privacy"></p>
      <input type="text" maxlength="35" autocomplete="off" spellcheck="false" />
      <button class="upload" type="button"></button>
      <p class="status" role="status"></p>
    </section>
  `;
  const panel = shadow.querySelector(".panel");
  const open = shadow.querySelector(".open");
  const input = shadow.querySelector("input");
  const upload = shadow.querySelector(".upload");
  const status = shadow.querySelector(".status");
  shadow.querySelector("strong").textContent = text.title;
  shadow.querySelector(".privacy").textContent = text.privacy;
  input.placeholder = text.placeholder;
  upload.textContent = text.button;

  function projections() {
    return globalThis.MantraSorareImportParser.parseVisibleProjections(document);
  }

  function refreshCount() {
    if (!upload.disabled) status.textContent = text.visible(projections().length);
  }

  shadow.querySelector(".close").addEventListener("click", () => {
    panel.hidden = true;
    open.hidden = false;
  });
  open.addEventListener("click", () => {
    open.hidden = true;
    panel.hidden = false;
    refreshCount();
  });

  upload.addEventListener("click", () => {
    const code = input.value.trim();
    if (!/^mi_[A-Za-z0-9_-]{32}$/.test(code)) {
      status.textContent = text.code;
      return;
    }
    const rows = projections();
    if (!rows.length) {
      status.textContent = text.empty;
      return;
    }
    if (rows.length > 200) {
      status.textContent = text.many;
      return;
    }
    upload.disabled = true;
    status.textContent = text.sending;
    chrome.runtime.sendMessage(
      { type: "mantra-browser-import", code, projections: rows },
      (response) => {
        upload.disabled = false;
        if (chrome.runtime.lastError) {
          status.textContent = text.failed(chrome.runtime.lastError.message);
        } else if (!response?.ok) {
          status.textContent = text.failed(response?.error || "unknown_error");
        } else {
          input.value = "";
          status.textContent = text.done(response.imported);
        }
      },
    );
  });

  document.documentElement.appendChild(host);
  refreshCount();
  let refreshTimer = 0;
  new MutationObserver(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshCount, 250);
  }).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "data-score", "data-value", "hidden"],
  });
})();
