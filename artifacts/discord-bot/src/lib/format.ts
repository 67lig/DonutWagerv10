export const CURRENCY_EMOJI = "🪙";
export const CURRENCY_NAME = "coins";
export const MAX_BET = 150_000_000n;

export function formatCoins(amount: bigint | number): string {
  const n = typeof amount === "bigint" ? Number(amount) : amount;
  return `${CURRENCY_EMOJI} ${n.toLocaleString("en-US")}`;
}

/**
 * Plain comma-formatted number with no emoji — ideal for code-block fields
 * where emojis cause line wraps. e.g. 3000000 -> "3,000,000"
 */
export function formatCoinsRaw(amount: bigint | number): string {
  const n = typeof amount === "bigint" ? Number(amount) : amount;
  return n.toLocaleString("en-US");
}

/**
 * Compact suffix form, no emoji: "500m", "1.5bil", "10k", "750".
 * Matches the `parseAmount` suffix vocabulary so what we display can be
 * pasted back into a command.
 */
export function formatCoinsShort(amount: bigint | number): string {
  const n =
    typeof amount === "bigint"
      ? amount < 0n
        ? -Number(-amount)
        : Number(amount)
      : amount;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (x: number): string =>
    x.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}bil`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${abs.toLocaleString("en-US")}`;
}

/**
 * Parse a coin/money amount with friendly suffixes.
 *
 * Accepted forms (case-insensitive):
 *   - plain numbers:        100, 5000, 1500000
 *   - thousands separators: 1,000,000   1_000_000   1 000 000
 *   - decimal multipliers:  1.5k, 2.5m, 0.5b
 *   - short suffixes:       k, m, b, t (thousand, million, billion, trillion)
 *   - long suffixes:        thousand, thou, mil, mill, million, bil, bill, billion, tril, trillion
 *   - keywords (require balance): all, max, half
 *
 * Returns null on parse failure.
 */
export function parseAmount(input: string): bigint | null {
  const trimmed = input.trim().toLowerCase();
  const cleaned = trimmed.replace(/[, _]/g, "");
  // Allow space or no space between number and suffix.
  const m = cleaned.match(
    /^(\d+(?:\.\d+)?)(thousand|thou|million|mill|mil|billion|bill|bil|trillion|tril|k|m|b|t)?$/,
  );
  if (!m) return null;
  let value = parseFloat(m[1]!);
  const suffix = m[2];
  switch (suffix) {
    case "k":
    case "thou":
    case "thousand":
      value *= 1_000;
      break;
    case "m":
    case "mil":
    case "mill":
    case "million":
      value *= 1_000_000;
      break;
    case "b":
    case "bil":
    case "bill":
    case "billion":
      value *= 1_000_000_000;
      break;
    case "t":
    case "tril":
    case "trillion":
      value *= 1_000_000_000_000;
      break;
    default:
      break;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.floor(value));
}

export function parseBet(input: string, balance: bigint): bigint | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "max") return balance;
  if (trimmed === "half") return balance / 2n;
  return parseAmount(trimmed);
}
