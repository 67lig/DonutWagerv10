/**
 * Re-exports from config.ts for backwards compatibility.
 * Edit channel IDs and webhooks in config.ts — not here.
 */
export { CHANNELS, WEBHOOK_IDS, WEBHOOK_URLS, DEPOSIT_LOG_CHANNEL_IDS } from "./config.js";

import { CHANNELS } from "./config.js";

export const VOUCH_CHANNEL_ID      = CHANNELS.VOUCH;
export const GAMBLE_LOG_CHANNEL_ID = CHANNELS.GAMBLE_LOG;
export const ADMIN_LOG_CHANNEL_ID  = CHANNELS.ADMIN_LOG;
export const WITHDRAW_LOG_CHANNEL_ID = CHANNELS.WITHDRAW_LOG;

/** Channel-name prefix marking a ticket that has been paid out. */
export const PAID_TICKET_PREFIX = "paid-";
