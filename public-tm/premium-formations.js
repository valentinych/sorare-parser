function stablePlayerId(player) {
  const id = Number(player?.mantraPlayerId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function positionRank(player, positionOrder) {
  const positions = Array.isArray(player?.positions) ? player.positions : [];
  let rank = positionOrder.length;
  for (const position of positions) {
    const index = positionOrder.indexOf(position);
    if (index >= 0 && index < rank) rank = index;
  }
  return rank;
}

export function comparePremiumFormationPlayers(a, b, positionOrder = []) {
  return (
    positionRank(a, positionOrder) - positionRank(b, positionOrder) ||
    String(a.clubName || "").localeCompare(String(b.clubName || "")) ||
    String(a.displayName || a.surname || "").localeCompare(
      String(b.displayName || b.surname || ""),
    ) ||
    (stablePlayerId(a) ?? Number.MAX_SAFE_INTEGER) -
      (stablePlayerId(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function dedupePremiumPlayers(players, positionOrder = []) {
  const byId = new Map();
  for (const player of players || []) {
    const id = stablePlayerId(player);
    if (id == null || byId.has(id)) continue;
    byId.set(id, player);
  }
  return [...byId.values()].sort((a, b) =>
    comparePremiumFormationPlayers(a, b, positionOrder),
  );
}

function playerFitsSlot(player, slot) {
  const positions = Array.isArray(player?.positions) ? player.positions : [];
  return (slot?.accepted || []).some((position) => positions.includes(position));
}

export function matchPremiumFormation(players, formation, positionOrder = []) {
  const orderedPlayers = dedupePremiumPlayers(players, positionOrder);
  const slots = Array.isArray(formation?.slots) ? formation.slots : [];
  const slotPlayers = Array(slots.length).fill(null);
  const playerSlots = new Map();

  function assignSlot(slotIndex, seenSlots, seenPlayers) {
    if (seenSlots.has(slotIndex)) return false;
    seenSlots.add(slotIndex);
    const slot = slots[slotIndex];
    for (const player of orderedPlayers) {
      const playerId = stablePlayerId(player);
      if (
        playerId == null ||
        seenPlayers.has(playerId) ||
        !playerFitsSlot(player, slot)
      ) {
        continue;
      }
      seenPlayers.add(playerId);
      const previousSlot = playerSlots.get(playerId);
      if (
        previousSlot == null ||
        assignSlot(previousSlot, seenSlots, seenPlayers)
      ) {
        slotPlayers[slotIndex] = player;
        playerSlots.set(playerId, slotIndex);
        return true;
      }
    }
    return false;
  }

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    assignSlot(slotIndex, new Set(), new Set());
  }

  const assignments = slots.flatMap((slot, slotIndex) => {
    const player = slotPlayers[slotIndex];
    return player ? [{ slot, slotIndex, player }] : [];
  });
  const assignedIds = new Set(
    assignments.map(({ player }) => stablePlayerId(player)),
  );
  const extras = orderedPlayers.filter(
    (player) => !assignedIds.has(stablePlayerId(player)),
  );
  const deficits = slots.flatMap((slot, slotIndex) =>
    slotPlayers[slotIndex]
      ? []
      : [
          {
            slot,
            slotIndex,
            eligibleCount: orderedPlayers.filter((player) =>
              playerFitsSlot(player, slot),
            ).length,
          },
        ],
  );

  return {
    formation: formation?.name || "",
    compatible: slots.length === 11 && assignments.length === slots.length,
    assignments,
    extras,
    deficits,
    matchedSlots: assignments.length,
  };
}

export function compatiblePremiumFormations(
  players,
  formations,
  positionOrder = [],
) {
  return (formations || [])
    .map((formation) =>
      matchPremiumFormation(players, formation, positionOrder),
    )
    .filter((result) => result.compatible);
}

export function closestPremiumFormation(
  players,
  formations,
  positionOrder = [],
) {
  let best = null;
  for (const formation of formations || []) {
    const result = matchPremiumFormation(players, formation, positionOrder);
    if (!best || result.matchedSlots > best.matchedSlots) best = result;
  }
  return best;
}

function isGoalkeeper(player) {
  return (Array.isArray(player?.positions) ? player.positions : []).some(
    (position) => String(position).toUpperCase() === "GK",
  );
}

export function premiumSquadRoles(players) {
  let gk = 0;
  let outfield = 0;
  for (const player of dedupePremiumPlayers(players)) {
    if (isGoalkeeper(player)) gk += 1;
    else outfield += 1;
  }
  return { gk, outfield, total: gk + outfield };
}

export function generatePremiumLineups(players, formations, positionOrder = []) {
  const selected = dedupePremiumPlayers(players, positionOrder);
  const { gk, outfield } = premiumSquadRoles(selected);
  if (gk < 1 || outfield < 10) {
    return {
      error: `Нужен минимум 1 вратарь и 10 полевых, которые сложатся в схему Mantra. Сейчас: ${gk} вр. и ${outfield} полевых.`,
      compatible: [],
    };
  }
  const compatible = compatiblePremiumFormations(
    selected,
    formations,
    positionOrder,
  );
  if (!compatible.length) {
    return {
      error:
        "Нужен минимум 1 вратарь и 10 полевых, которые сложатся в схему Mantra. Выбранные игроки не заполняют ни одну схему.",
      compatible: [],
    };
  }
  return { error: null, compatible };
}

export function premiumSelectionCounts(selectedIds, visibleRows) {
  const selected = new Set(
    [...(selectedIds || [])]
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const visible = new Set(
    (visibleRows || [])
      .map(stablePlayerId)
      .filter((id) => id != null && selected.has(id)),
  );
  return { total: selected.size, visible: visible.size };
}
