// ═══════════════════════════════════════════════════════════════════════════
//  BOT CONFIG  —  change every channel ID, webhook ID, and webhook URL here.
//  Nothing else in the codebase should hard-code these values.
// ═══════════════════════════════════════════════════════════════════════════

// ── Channel IDs ──────────────────────────────────────────────────────────────
export const CHANNELS = {
  /** Live feed of every bet placed (wins + losses). */
  GAMBLE_LOG: "1498036843428577330",

  /** Sensitive admin actions: coupons, balance edits, payouts. */
  ADMIN_LOG: "1498419875021066240",

  /** Every withdrawal + IRL sale payout — full history. */
  WITHDRAW_LOG: "1498440931026927817",

  /** Public-facing vouch / withdrawal announcements. */
  VOUCH: "1498009841451536584",

  /** Channel where the casino panel embed is auto-posted on startup. */
  PANEL: "1498881450643296400",

  /** In-game /pay webhook listener — deposit detection. */
  PAYMENT: "1499922045843144875",
} as const;

// ── Webhook IDs ───────────────────────────────────────────────────────────────
export const WEBHOOK_IDS = {
  /** Minecraft plugin webhook that posts /pay receipts (used to detect deposits). */
  PAYMENT: "1499922327771680798",
} as const;

// ── Webhook URLs (optional extra log destinations) ────────────────────────────
// Set a Discord webhook URL to mirror logs to an additional destination.
// Leave as "" to disable that mirror — the channel log still runs as normal.
export const WEBHOOK_URLS = {
  GAMBLE_LOG: "",
  ADMIN_LOG: "",
  WITHDRAW_LOG: "",
} as const;

// ── Deposit log channels ──────────────────────────────────────────────────────
// Every admin deposit / payout gets echoed to all channels listed here.
export const DEPOSIT_LOG_CHANNEL_IDS: readonly string[] = [
  CHANNELS.ADMIN_LOG,
  CHANNELS.WITHDRAW_LOG,
] as const;
