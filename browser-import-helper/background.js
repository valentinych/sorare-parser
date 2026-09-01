"use strict";

const IMPORT_URL = "https://mantra.panenka.games/api/sorareinside/browser-import";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type !== "mantra-browser-import" ||
    !sender.tab?.url?.startsWith("https://sorare.com/")
  ) {
    return false;
  }

  fetch(IMPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: message.code,
      projections: message.projections,
    }),
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      sendResponse(
        response.ok
          ? { ok: true, imported: body.imported }
          : { ok: false, error: body.error || `http_${response.status}` },
      );
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
