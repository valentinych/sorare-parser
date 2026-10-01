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

export function dedupePremiumPlayers(players, positionOrder = [], compare) {
  const byId = new Map();
  for (const player of players || []) {
    const id = stablePlayerId(player);
    if (id == null || byId.has(id)) continue;
    byId.set(id, player);
  }
  const cmp =
    compare ||
    ((a, b) => comparePremiumFormationPlayers(a, b, positionOrder));
  return [...byId.values()].sort(cmp);
}

function playerFitsSlot(player, slot) {
  const positions = Array.isArray(player?.positions) ? player.positions : [];
  return (slot?.accepted || []).some((position) => positions.includes(position));
}

export function matchPremiumFormation(
  players,
  formation,
  positionOrder = [],
  compare,
) {
  const orderedPlayers = dedupePremiumPlayers(
    players,
    positionOrder,
    compare,
  );
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

/**
 * Premium XI score. Ratings ÷10 so 6–8 sit next to 0–1 probabilities.
 * Typical starter ≈ 8.5; OUT / no XI% drops ~3–4 vs an 85% starter.
 *
 * score = w_season * seasonAvg/10
 *       + w_form   * last5Avg/10
 *       + w_xi     * xiProb          // E11 % or footmops; OUT / no fixture = 0
 *       + w_win    * pWin
 *       + w_cs     * pCs * csFactor // mantraScoring CS bonus / 1.5; slot ∩ native
 *       + w_goals  * pGoals * goalW
 *       − w_nf     * noFixture
 *
 * pGoals: teamScoreProbability, else 1 − opponent CS (P(team scores ≥1)).
 * CS/goals use the assigned slot when given, else native POS.
 */
export const PREMIUM_XI_WEIGHTS = {
  season: 2.0,
  form: 2.5,
  xi: 4.0,
  win: 1.5,
  cs: 2.0,
  goals: 1.5,
  noFixture: 0.8,
};

const CS_BONUS = {
  GK: 1.5,
  CB: 1.0,
  RB: 1.0,
  LB: 1.0,
  WB: 0.5,
  DM: 0.5,
};

const GOAL_WEIGHT = {
  ST: 1,
  FW: 1,
  AM: 0.8,
  W: 0.8,
  CM: 0.45,
  DM: 0.25,
  WB: 0.25,
  CB: 0.1,
  RB: 0.1,
  LB: 0.1,
  GK: 0,
};

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  if (value == null) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function upperPositions(value) {
  return (Array.isArray(value) ? value : [])
    .map((position) => String(position || "").toUpperCase())
    .filter(Boolean);
}

function maxMapped(positions, table) {
  let best = null;
  for (const position of positions) {
    const mapped = table[position];
    if (mapped == null) continue;
    if (best == null || mapped > best) best = mapped;
  }
  return best;
}

export function hasPremiumFixture(player) {
  return Boolean(player?.matchLabel || player?.opponent || player?.kickoff);
}

export function isPremiumOut(player) {
  return (
    player?.footmopsGroup === "out" ||
    String(player?.lineupGroup || "").toLowerCase() === "out"
  );
}

export function premiumXiProb(player) {
  if (isPremiumOut(player)) return 0;
  if (!hasPremiumFixture(player)) return 0;
  const pct = finiteNumber(
    player?.displayedPercentage ?? player?.footmopsPercentage,
  );
  if (pct == null) return 0;
  return clamp01(pct / 100);
}

export function premiumGoalsProb(player) {
  const direct = finiteNumber(player?.teamScoreProbability);
  if (direct != null) return clamp01(direct);
  const oppCs = finiteNumber(player?.opponentCleanSheetProbability);
  if (oppCs != null) return clamp01(1 - oppCs);
  return 0;
}

export function premiumCsFactor(native, slotAccepted) {
  const nativeMax = maxMapped(upperPositions(native), CS_BONUS);
  const slotMax = maxMapped(
    upperPositions(slotAccepted && slotAccepted.length ? slotAccepted : native),
    CS_BONUS,
  );
  if (nativeMax == null || slotMax == null) return 0;
  return Math.min(nativeMax, slotMax) / CS_BONUS.GK;
}

export function premiumGoalWeight(positions) {
  const weight = maxMapped(upperPositions(positions), GOAL_WEIGHT);
  return weight == null ? 0 : weight;
}

export function premiumPlayerScore(player, slotAccepted) {
  const native = Array.isArray(player?.positions) ? player.positions : [];
  const slot = slotAccepted && slotAccepted.length ? slotAccepted : native;
  const season = finiteNumber(player?.seasonAvgRating);
  const form = finiteNumber(player?.last5AvgRating);
  const xiProb = premiumXiProb(player);
  const pWin = clamp01(finiteNumber(player?.winProbability) ?? 0);
  const pCs = clamp01(finiteNumber(player?.cleanSheetProbability) ?? 0);
  const pGoals = premiumGoalsProb(player);
  const csFactor = premiumCsFactor(native, slot);
  const goalW = premiumGoalWeight(slot);
  const noFixture = hasPremiumFixture(player) ? 0 : 1;
  const w = PREMIUM_XI_WEIGHTS;
  const total =
    w.season * ((season ?? 0) / 10) +
    w.form * ((form ?? 0) / 10) +
    w.xi * xiProb +
    w.win * pWin +
    w.cs * pCs * csFactor +
    w.goals * pGoals * goalW -
    w.noFixture * noFixture;
  const title = [
    season != null ? `сезон ${season.toFixed(1)}` : null,
    form != null ? `форма ${form.toFixed(1)}` : null,
    `XI ${(xiProb * 100).toFixed(0)}%`,
    `win ${(pWin * 100).toFixed(0)}%`,
    csFactor > 0 ? `CS ${(pCs * 100).toFixed(0)}%×${csFactor.toFixed(2)}` : null,
    goalW > 0 ? `гол ${(pGoals * 100).toFixed(0)}%×${goalW.toFixed(2)}` : null,
    noFixture ? "нет матча" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    total: Number(total.toFixed(2)),
    xiProb,
    pWin,
    pCs,
    pGoals,
    csFactor,
    goalWeight: goalW,
    noFixture: Boolean(noFixture),
    title,
  };
}

export function comparePremiumPlayersByScore(a, b, positionOrder = []) {
  return (
    (finiteNumber(b?.xiScore) ?? 0) - (finiteNumber(a?.xiScore) ?? 0) ||
    comparePremiumFormationPlayers(a, b, positionOrder)
  );
}

export function pickBestPremiumXi(players, formations, positionOrder = []) {
  const scored = dedupePremiumPlayers(players, positionOrder).map((player) => {
    const nativeScore = premiumPlayerScore(player);
    return {
      ...player,
      xiScore: nativeScore.total,
      xiScoreTitle: nativeScore.title,
    };
  });
  const available = [];
  const outPlayers = [];
  for (const player of scored) {
    if (isPremiumOut(player)) outPlayers.push(player);
    else available.push(player);
  }
  const compare = (a, b) =>
    comparePremiumPlayersByScore(a, b, positionOrder);
  let best = null;
  for (const formation of formations || []) {
    const result = matchPremiumFormation(
      available,
      formation,
      positionOrder,
      compare,
    );
    if (!result.compatible) continue;
    const assignments = result.assignments.map((item) => {
      const slotScore = premiumPlayerScore(item.player, item.slot?.accepted);
      return { ...item, slotScore: slotScore.total, xiScoreTitle: slotScore.title };
    });
    const totalScore = Number(
      assignments
        .reduce((sum, item) => sum + (item.slotScore || 0), 0)
        .toFixed(2),
    );
    if (
      !best ||
      totalScore > best.totalScore ||
      (totalScore === best.totalScore &&
        String(result.formation).localeCompare(String(best.formation)) < 0)
    ) {
      const leftover = [...result.extras, ...outPlayers];
      const bench = pickPremiumBench(leftover, assignments, positionOrder);
      const benchIds = new Set(
        bench.map((item) => stablePlayerId(item.player)).filter((id) => id != null),
      );
      best = {
        ...result,
        assignments,
        bench,
        extras: leftover.filter(
          (player) => !benchIds.has(stablePlayerId(player)),
        ),
        totalScore,
      };
    }
  }
  if (!best) {
    const { gk, outfield } = premiumSquadRoles(scored);
    return {
      error:
        gk < 1 || outfield < 10
          ? `Нужен минимум 1 вратарь и 10 полевых, которые сложатся в схему Mantra. Сейчас: ${gk} вр. и ${outfield} полевых.`
          : "Нужен минимум 1 вратарь и 10 полевых, которые сложатся в схему Mantra. Игроки не заполняют ни одну схему.",
      compatible: [],
      best: null,
    };
  }
  return { error: null, compatible: [best], best };
}

const PREMIUM_BENCH_GK = 1;
const PREMIUM_BENCH_OUTFIELD = 8;

function assignmentKey(item, index) {
  return item?.slotIndex != null ? item.slotIndex : index;
}

function isGoalkeeperSlot(slot) {
  return (slot?.accepted || []).some(
    (position) => String(position).toUpperCase() === "GK",
  );
}

function comparePremiumBenchCandidates(a, b, positionOrder = []) {
  return (
    premiumPlayerScore(b).total - premiumPlayerScore(a).total ||
    comparePremiumFormationPlayers(a, b, positionOrder)
  );
}

function uncoveredSlotCount(player, slots, covered) {
  let count = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const item = slots[index];
    const key = assignmentKey(item, index);
    if (covered.has(key) || !playerFitsSlot(player, item.slot)) continue;
    count += 1;
  }
  return count;
}

function markCoveredSlots(player, slots, covered) {
  for (let index = 0; index < slots.length; index += 1) {
    const item = slots[index];
    if (playerFitsSlot(player, item.slot)) covered.add(assignmentKey(item, index));
  }
}

function benchAssignment(player) {
  const native = Array.isArray(player?.positions) ? player.positions : [];
  const scored = premiumPlayerScore(player);
  return {
    player,
    slot: {
      label: native.filter(Boolean).join("/") || "—",
      accepted: native,
    },
    slotScore: scored.total,
    xiScoreTitle: scored.title,
  };
}

/**
 * Bench after a legal XI: 1 GK + 8 outfield, never OUT.
 * Greedy set-cover of starting slots via native `slot.accepted`, then score.
 */
export function pickPremiumBench(players, xiAssignments, positionOrder = []) {
  const xiIds = new Set(
    (xiAssignments || [])
      .map((item) => stablePlayerId(item?.player))
      .filter((id) => id != null),
  );
  const pool = dedupePremiumPlayers(players, positionOrder).filter((player) => {
    const id = stablePlayerId(player);
    return id != null && !xiIds.has(id) && !isPremiumOut(player);
  });
  const assignments = Array.isArray(xiAssignments) ? xiAssignments : [];
  const gkSlots = assignments.filter((item) => isGoalkeeperSlot(item.slot));
  const fieldSlots = assignments.filter((item) => !isGoalkeeperSlot(item.slot));
  const covered = new Set();
  const used = new Set();
  const bench = [];
  const compare = (a, b) => comparePremiumBenchCandidates(a, b, positionOrder);

  const gks = pool.filter(isGoalkeeper).sort(compare);
  for (let i = 0; i < PREMIUM_BENCH_GK && i < gks.length; i += 1) {
    const keeper = gks[i];
    used.add(stablePlayerId(keeper));
    markCoveredSlots(keeper, gkSlots, covered);
    bench.push(benchAssignment(keeper));
  }

  for (let seat = 0; seat < PREMIUM_BENCH_OUTFIELD; seat += 1) {
    const candidates = pool.filter((player) => {
      const id = stablePlayerId(player);
      return id != null && !used.has(id) && !isGoalkeeper(player);
    });
    if (!candidates.length) break;
    candidates.sort((a, b) => {
      const cover =
        uncoveredSlotCount(b, fieldSlots, covered) -
        uncoveredSlotCount(a, fieldSlots, covered);
      if (cover) return cover;
      return compare(a, b);
    });
    const pick = candidates[0];
    used.add(stablePlayerId(pick));
    markCoveredSlots(pick, fieldSlots, covered);
    bench.push(benchAssignment(pick));
  }

  return bench;
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
