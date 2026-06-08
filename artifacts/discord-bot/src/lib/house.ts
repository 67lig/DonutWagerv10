/**
 * House edge engine.
 *
 * Default house win share is ~58% / user 42%. For larger ("whale") bets the
 * house win share scales up in tiers so the casino can't be drained by a
 * few lucky max-bet rolls.
 *
 * Tiers:
 *   bet  > 49,000,000  → 0.56
 *   bet  > 74,000,000  → 0.62
 *   bet  > 99,000,000  → 0.64
 *
 * All games consult `houseShouldWin(bet)` before resolving any randomized
 * outcome. Pass the bet (as bigint) so the rate can be tilted automatically.
 */

export const HOUSE_WIN_RATE = 0.56;

export const BIG_BET_THRESHOLD = 49_000_000n; // > 49m
export const BIG_BET_HOUSE_RATE = 0.58;

export const WHALE_BET_THRESHOLD = 74_000_000n; // > 74m
export const WHALE_BET_HOUSE_RATE = 0.62;

export const MEGA_WHALE_BET_THRESHOLD = 99_000_000n; // > 99m
export const MEGA_WHALE_BET_HOUSE_RATE = 0.64;

/** Effective house win rate for a given bet. */
export function houseRateFor(bet?: bigint): number {
  if (bet !== undefined) {
    if (bet > MEGA_WHALE_BET_THRESHOLD) return MEGA_WHALE_BET_HOUSE_RATE;
    if (bet > WHALE_BET_THRESHOLD) return WHALE_BET_HOUSE_RATE;
    if (bet > BIG_BET_THRESHOLD) return BIG_BET_HOUSE_RATE;
  }
  return HOUSE_WIN_RATE;
}

/**
 * How rigged a single in-game decision should be.
 *
 * Returns 0 when the rate is at or below 0.5 (the game is fully fair —
 * `houseShouldWin` already coin-flips evenly so no extra bias is needed),
 * and ramps linearly to 1.0 when the rate hits 1.0 (auto-loss in any game
 * pre-flagged as `willHouseWin`).
 *
 * Games use this to interpolate their per-action bias so the same dial
 * (HOUSE_WIN_RATE) controls both "how often does the house win the round"
 * and "how aggressively the round is steered toward that outcome".
 */
export function riggingBias(bet?: bigint): number {
  const rate = houseRateFor(bet);
  if (rate <= 0.5) return 0;
  return Math.min(1, (rate - 0.5) * 2);
}

/**
 * Returns true when the HOUSE should win this round.
 * Returns false when the USER should win this round.
 */
export function houseShouldWin(bet?: bigint): boolean {
  return Math.random() < houseRateFor(bet);
}

export function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function pickRandomExcept<T>(items: readonly T[], exclude: T): T {
  const filtered = items.filter((i) => i !== exclude);
  return filtered[Math.floor(Math.random() * filtered.length)]!;
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
