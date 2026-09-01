(() => {
  "use strict";

  const SAFE_ID = /^[A-Za-z0-9:_.,|/-]+$/;
  const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;

  function safeText(value, maxLength, pattern) {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      pattern.test(value)
      ? value
      : null;
  }

  function numberInRange(value, min, max) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const number = Number(value.replace(/%$/u, ""));
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function cardPosition(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "FW") return "FWD";
    return ["GK", "DEF", "MID", "FWD"].includes(normalized) ? normalized : null;
  }

  function reliability(title) {
    const match = String(title || "").match(/Reliability:\s*([A-Za-z0-9 _-]{1,30})/iu);
    if (!match || match[1].toLowerCase() === "unknown") return null;
    return match[1];
  }

  function visible(element) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    if (
      style &&
      (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
    ) {
      return false;
    }
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function parseVisibleProjections(root = document, options = {}) {
    const isVisible = options.isVisible || visible;
    const ribbons = root.querySelectorAll(
      ".si-companion-ribbon[data-state='ready'], " +
        ".si-companion-detail-ribbon[data-state='ready']",
    );
    const projections = new Map();

    for (const ribbon of ribbons) {
      if (!isVisible(ribbon)) continue;
      const data = ribbon.dataset;
      const gameId = safeText(data.gameId, 160, SAFE_ID);
      const playerId = safeText(data.playerId, 160, SAFE_ID);
      const playerSlug = safeText(data.playerSlug, 160, SAFE_SLUG);
      const position = cardPosition(data.cardPosition);
      if (!gameId || (!playerId && !playerSlug) || !position) continue;

      const clientCardId = safeText(data.clientCardId, 300, SAFE_ID);
      const key = `${gameId}|${playerSlug || playerId}`;
      const projection = projections.get(key) || {
        clientCardId,
        playerId,
        playerSlug,
        gameId,
        teamSlug: null,
        projectedScore: null,
        startingPercentage: null,
        reliability: null,
        teamWinOdds: null,
        playerExpectedGoals: null,
        teamCleanSheetOdds: null,
        cardPosition: position,
      };

      projection.clientCardId ||= clientCardId;
      projection.playerId ||= playerId;
      projection.playerSlug ||= playerSlug;
      projection.reliability ||= reliability(ribbon.title);
      projection.startingPercentage ??= numberInRange(
        data.startingPercentage,
        0,
        100,
      );

      if (ribbon.classList.contains("si-companion-ribbon")) {
        projection.projectedScore = numberInRange(data.score, 0, 200);
      } else if (data.kind === "start") {
        projection.startingPercentage ??= numberInRange(data.value, 0, 100);
      } else if (data.kind === "win") {
        projection.teamWinOdds = numberInRange(data.value, 0, 100);
      } else if (data.kind === "xg") {
        projection.playerExpectedGoals = numberInRange(data.value, 0, 10);
      } else if (data.kind === "cs") {
        projection.teamCleanSheetOdds = numberInRange(data.value, 0, 100);
      }
      projections.set(key, projection);
    }

    return [...projections.values()].filter(
      (projection) =>
        projection.projectedScore != null ||
        projection.startingPercentage != null ||
        projection.teamWinOdds != null ||
        projection.playerExpectedGoals != null ||
        projection.teamCleanSheetOdds != null,
    );
  }

  globalThis.MantraSorareImportParser = { parseVisibleProjections };
})();
