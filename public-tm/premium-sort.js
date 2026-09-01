const PREMIUM_SORT_KEYS = new Set([
  "displayedPercentage",
  "footmopsPercentage",
  "winProbability",
  "cleanSheetProbability",
  "opponentCleanSheetProbability",
]);

function numericValue(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tieBreakPremiumRows(a, b) {
  return (
    String(a.clubName || "").localeCompare(String(b.clubName || "")) ||
    String(a.position || "").localeCompare(String(b.position || "")) ||
    String(a.surname || a.displayName || "").localeCompare(
      String(b.surname || b.displayName || ""),
    ) ||
    String(a.displayName || "").localeCompare(String(b.displayName || "")) ||
    Number(a.mantraPlayerId || 0) - Number(b.mantraPlayerId || 0)
  );
}

export function sortPremiumRows(rows, sort) {
  if (!sort || !PREMIUM_SORT_KEYS.has(sort.key)) return rows.slice();
  const direction = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const aValue = numericValue(a[sort.key]);
    const bValue = numericValue(b[sort.key]);
    if (aValue == null || bValue == null) {
      if (aValue == null && bValue == null) return tieBreakPremiumRows(a, b);
      return aValue == null ? 1 : -1;
    }
    return direction * (aValue - bValue) || tieBreakPremiumRows(a, b);
  });
}

export function nextPremiumSort(current, key) {
  if (!PREMIUM_SORT_KEYS.has(key)) return current;
  if (!current || current.key !== key) return { key, dir: "desc" };
  return { key, dir: current.dir === "desc" ? "asc" : "desc" };
}
