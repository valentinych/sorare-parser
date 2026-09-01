/** Official Mantra live-auction rules from https://mantrafootball.org/rules#auction */

export const LIVE_AUCTION_RULES = {
  startingBudget: 260,
  squadSize: 26,
  minGoalkeepers: 3,
  minBid: 1,
  hammerMs: 15_000,
  earlyHammerFolds: 7,
  league: "premier-league",
  tournamentId: 2,
} as const;

export function lotShouldHammer(input: {
  now: number;
  lastBidAtMs: number;
  foldCount: number;
  rivalCount: number;
  foldedRivalCount: number;
}): boolean {
  if (input.foldCount >= LIVE_AUCTION_RULES.earlyHammerFolds) return true;
  if (input.rivalCount > 0 && input.foldedRivalCount >= input.rivalCount) return true;
  if (!Number.isFinite(input.lastBidAtMs)) return false;
  return input.now - input.lastBidAtMs >= LIVE_AUCTION_RULES.hammerMs;
}

export function bidStep(current: number): number {
  if (!Number.isSafeInteger(current) || current < LIVE_AUCTION_RULES.minBid) {
    return LIVE_AUCTION_RULES.minBid;
  }
  return current < 20 ? 1 : Math.floor(current / 10);
}

export function minNextBid(current: number): number {
  return current + bidStep(current);
}

/** 1 credit reserved for each empty slot after winning the current lot. */
export function reservedCreditsAfterWin(squadSize: number): number {
  if (!Number.isSafeInteger(squadSize) || squadSize < 0) return LIVE_AUCTION_RULES.squadSize - 1;
  return Math.max(0, LIVE_AUCTION_RULES.squadSize - squadSize - 1);
}

export function maxLegalBid(budgetLeft: number, squadSize: number): number {
  return budgetLeft - reservedCreditsAfterWin(squadSize);
}

export function isGoalkeeper(positions: string[]): boolean {
  return positions.some((position) => position.toUpperCase() === "GK");
}

export function canAfford(budgetLeft: number, amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= LIVE_AUCTION_RULES.minBid && amount <= budgetLeft;
}

/** True if this manager can legally bid `nextBid` on the open lot. */
export function managerCanEnterNextBid(input: {
  budgetLeft: number;
  squadSize: number;
  goalkeepers: number;
  playerIsGk: boolean;
  nextBid: number;
}): boolean {
  if (!canAfford(input.budgetLeft, input.nextBid)) return false;
  if (input.nextBid > maxLegalBid(input.budgetLeft, input.squadSize)) return false;
  return canAddPlayer(input.squadSize, input.goalkeepers, input.playerIsGk);
}

export function canAddPlayer(
  squadSize: number,
  goalkeepers: number,
  playerIsGk: boolean,
): boolean {
  if (squadSize >= LIVE_AUCTION_RULES.squadSize) return false;
  const remainingAfter = LIVE_AUCTION_RULES.squadSize - squadSize - 1;
  const gkAfter = goalkeepers + (playerIsGk ? 1 : 0);
  return gkAfter + remainingAfter >= LIVE_AUCTION_RULES.minGoalkeepers;
}

export function parseBidAmount(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    if (!/^\d+$/.test(value.trim())) return null;
    value = Number(value.trim());
  }
  if (!Number.isSafeInteger(value)) return null;
  const amount = value as number;
  if (amount < LIVE_AUCTION_RULES.minBid || amount > LIVE_AUCTION_RULES.startingBudget) {
    return null;
  }
  return amount;
}
