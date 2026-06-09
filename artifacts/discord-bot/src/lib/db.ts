import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

export async function initSchema(): Promise<void> {
  // Acquire a session-level advisory lock so concurrent bot startups (e.g. during
  // a rolling redeploy) never race on CREATE TABLE and crash with a pg_type conflict.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(8675309)");
    await client.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      discord_id VARCHAR(32) PRIMARY KEY,
      minecraft_username VARCHAR(64),
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      balance BIGINT NOT NULL DEFAULT 0,
      total_wagered BIGINT NOT NULL DEFAULT 0,
      total_won BIGINT NOT NULL DEFAULT 0,
      total_lost BIGINT NOT NULL DEFAULT 0,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      last_daily TIMESTAMP,
      last_command_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_log (
      id SERIAL PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      game VARCHAR(32) NOT NULL,
      bet BIGINT NOT NULL,
      payout BIGINT NOT NULL,
      won BOOLEAN NOT NULL,
      details JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_game_log_user ON game_log(discord_id);
    CREATE INDEX IF NOT EXISTS idx_game_log_created ON game_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS bot_coupons (
      code VARCHAR(64) PRIMARY KEY,
      amount BIGINT NOT NULL,
      max_uses INTEGER NOT NULL,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMP,
      created_by VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_coupon_redemptions (
      code VARCHAR(64) NOT NULL REFERENCES bot_coupons(code) ON DELETE CASCADE,
      discord_id VARCHAR(32) NOT NULL,
      redeemed_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (code, discord_id)
    );

    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user
      ON bot_coupon_redemptions(discord_id);

    CREATE TABLE IF NOT EXISTS bot_balance_ledger (
      id BIGSERIAL PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      delta BIGINT NOT NULL,
      source VARCHAR(32) NOT NULL,
      detail TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_balance_ledger_user
      ON bot_balance_ledger(discord_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bot_pending_withdrawals (
      id BIGSERIAL PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL UNIQUE,
      amount BIGINT NOT NULL,
      ign TEXT NOT NULL,
      ign_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_user
      ON bot_pending_withdrawals(discord_id, status);

    CREATE TABLE IF NOT EXISTS bot_invite_members (
      invitee_discord_id VARCHAR(32) PRIMARY KEY,
      inviter_discord_id VARCHAR(32) NOT NULL,
      invite_code        VARCHAR(32),
      joined_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      left_at            TIMESTAMP,
      has_member_role    BOOLEAN NOT NULL DEFAULT FALSE,
      claimed            BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_invite_members_inviter
      ON bot_invite_members(inviter_discord_id);

    -- Idempotently add columns introduced after initial schema
    ALTER TABLE bot_invite_members
      ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rejoined_count SMALLINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_rejoined_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS bot_invite_claims (
      id             SERIAL PRIMARY KEY,
      discord_id     VARCHAR(32) NOT NULL,
      claim_number   INT NOT NULL,
      invites_used   INT NOT NULL,
      coins_awarded  BIGINT NOT NULL,
      claimed_at     TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invite_claims_user
      ON bot_invite_claims(discord_id);

    CREATE TABLE IF NOT EXISTS bot_pending_deposits (
      id BIGSERIAL PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL UNIQUE,
      amount BIGINT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pending_deposits_user
      ON bot_pending_deposits(discord_id, status);

    CREATE TABLE IF NOT EXISTS bot_processed_messages (
      message_id VARCHAR(32) PRIMARY KEY,
      processed_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE bot_users
      ADD COLUMN IF NOT EXISTS wager_requirement BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE bot_coupons
      ADD COLUMN IF NOT EXISTS coupon_type VARCHAR(16) NOT NULL DEFAULT 'gamble';

    CREATE TABLE IF NOT EXISTS bot_rigged (
      discord_id VARCHAR(32) PRIMARY KEY,
      mode       VARCHAR(16) NOT NULL,
      value      INTEGER     NOT NULL DEFAULT 80,
      created_at TIMESTAMP   NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_pay_transactions (
      id                 BIGSERIAL PRIMARY KEY,
      sender_discord_id  VARCHAR(32) NOT NULL,
      receiver_discord_id VARCHAR(32) NOT NULL,
      amount             BIGINT NOT NULL,
      created_at         TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pay_tx_sender
      ON bot_pay_transactions(sender_discord_id, created_at DESC);
  `);
  } finally {
    await client.query("SELECT pg_advisory_unlock(8675309)");
    client.release();
  }
}

export interface BotCoupon {
  code: string;
  amount: string;
  coupon_type: string;
  max_uses: number;
  uses_count: number;
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
}

export async function createCoupon(params: {
  code: string;
  amount: bigint;
  maxUses: number;
  expiresAt: Date | null;
  createdBy: string;
  couponType: "gamble" | "nongamble";
}): Promise<BotCoupon | null> {
  const { code, amount, maxUses, expiresAt, createdBy, couponType } = params;
  try {
    const r = await pool.query<BotCoupon>(
      `INSERT INTO bot_coupons (code, amount, max_uses, expires_at, created_by, coupon_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
      [code, amount.toString(), maxUses, expiresAt, createdBy, couponType],
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getCoupon(code: string): Promise<BotCoupon | null> {
  const r = await pool.query<BotCoupon>(
    `SELECT * FROM bot_coupons WHERE code = $1`,
    [code],
  );
  return r.rows[0] ?? null;
}

export async function listCoupons(): Promise<BotCoupon[]> {
  const r = await pool.query<BotCoupon>(
    `SELECT * FROM bot_coupons ORDER BY created_at DESC LIMIT 25`,
  );
  return r.rows;
}

export async function deleteCoupon(code: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM bot_coupons WHERE code = $1`, [code]);
  return (r.rowCount ?? 0) > 0;
}

export type RedeemResult =
  | { ok: true; amount: bigint; newBalance: bigint; couponType: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "exhausted"
        | "already_used"
        | "error";
    };

/**
 * Atomically redeem a coupon for a user. Returns the credited amount on
 * success or a structured failure reason.
 */
export async function redeemCoupon(
  code: string,
  discordId: string,
): Promise<RedeemResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const couponRes = await client.query<BotCoupon>(
      `SELECT * FROM bot_coupons WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const coupon = couponRes.rows[0];
    if (!coupon) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "expired" };
    }
    if (coupon.uses_count >= coupon.max_uses) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "exhausted" };
    }
    const already = await client.query(
      `SELECT 1 FROM bot_coupon_redemptions WHERE code = $1 AND discord_id = $2`,
      [code, discordId],
    );
    if (already.rowCount && already.rowCount > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_used" };
    }
    await client.query(
      `INSERT INTO bot_users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [discordId],
    );
    await client.query(
      `INSERT INTO bot_coupon_redemptions (code, discord_id) VALUES ($1, $2)`,
      [code, discordId],
    );
    await client.query(
      `UPDATE bot_coupons SET uses_count = uses_count + 1 WHERE code = $1`,
      [code],
    );
    const isGamble = coupon.coupon_type === "gamble";
    const balRes = await client.query<{ balance: string }>(
      isGamble
        ? `UPDATE bot_users
             SET balance = balance + $2,
                 wager_requirement = wager_requirement + $2
           WHERE discord_id = $1
             RETURNING balance`
        : `UPDATE bot_users
             SET balance = balance + $2
           WHERE discord_id = $1
             RETURNING balance`,
      [discordId, coupon.amount],
    );
    await client.query(
      `INSERT INTO bot_balance_ledger (discord_id, delta, source, detail)
         VALUES ($1, $2, 'coupon', $3)`,
      [discordId, coupon.amount, `Code: ${code}`],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      amount: BigInt(coupon.amount),
      newBalance: BigInt(balRes.rows[0]!.balance),
      couponType: coupon.coupon_type,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[db] redeemCoupon failed:", err);
    return { ok: false, reason: "error" };
  } finally {
    client.release();
  }
}

export interface BotUser {
  discord_id: string;
  minecraft_username: string | null;
  verified: boolean;
  balance: string;
  wager_requirement: string;
  total_wagered: string;
  total_won: string;
  total_lost: string;
  games_played: number;
  games_won: number;
  last_daily: Date | null;
  last_command_at: Date | null;
  created_at: Date;
}

export async function getOrCreateUser(discordId: string): Promise<BotUser> {
  const existing = await pool.query<BotUser>(
    `SELECT * FROM bot_users WHERE discord_id = $1`,
    [discordId],
  );
  if (existing.rows.length > 0) return existing.rows[0]!;
  const inserted = await pool.query<BotUser>(
    `INSERT INTO bot_users (discord_id) VALUES ($1) RETURNING *`,
    [discordId],
  );
  return inserted.rows[0]!;
}

export async function getUser(discordId: string): Promise<BotUser | null> {
  const r = await pool.query<BotUser>(
    `SELECT * FROM bot_users WHERE discord_id = $1`,
    [discordId],
  );
  return r.rows[0] ?? null;
}

export async function unlinkUser(discordId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_users SET verified = FALSE, minecraft_username = NULL
       WHERE discord_id = $1`,
    [discordId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Wipe a user's economy: balance + win/loss tallies + game count + last_daily.
 * Keeps verification + minecraft_username intact (use unlinkUser for that).
 */
export async function resetUserStats(discordId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_users SET
       balance = 0,
       wager_requirement = 0,
       total_wagered = 0,
       total_won = 0,
       total_lost = 0,
       games_played = 0,
       games_won = 0,
       last_daily = NULL
     WHERE discord_id = $1`,
    [discordId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Find an existing verified user by their case-insensitive Minecraft username. */
export async function findUserByMinecraftUsername(
  minecraftUsername: string,
): Promise<BotUser | null> {
  const r = await pool.query<BotUser>(
    `SELECT * FROM bot_users
       WHERE LOWER(minecraft_username) = LOWER($1) AND verified = TRUE
       LIMIT 1`,
    [minecraftUsername],
  );
  return r.rows[0] ?? null;
}

export async function setVerified(
  discordId: string,
  minecraftUsername: string,
): Promise<void> {
  await pool.query(
    `UPDATE bot_users SET verified = TRUE, minecraft_username = $2 WHERE discord_id = $1`,
    [discordId, minecraftUsername],
  );
}

export async function adjustBalance(
  discordId: string,
  delta: bigint,
): Promise<bigint> {
  const r = await pool.query<{ balance: string }>(
    `UPDATE bot_users SET balance = balance + $2 WHERE discord_id = $1 RETURNING balance`,
    [discordId, delta.toString()],
  );
  return BigInt(r.rows[0]!.balance);
}

export async function setBalance(
  discordId: string,
  newBalance: bigint,
): Promise<void> {
  await pool.query(`UPDATE bot_users SET balance = $2 WHERE discord_id = $1`, [
    discordId,
    newBalance.toString(),
  ]);
}

export async function recordGame(params: {
  discordId: string;
  game: string;
  bet: bigint;
  payout: bigint;
  won: boolean;
  details?: unknown;
}): Promise<void> {
  const { discordId, game, bet, payout, won, details } = params;
  await pool.query(
    `INSERT INTO game_log (discord_id, game, bet, payout, won, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [discordId, game, bet.toString(), payout.toString(), won, details ?? null],
  );

  const wonAmount = won ? payout - bet : 0n;
  const lostAmount = won ? 0n : bet;

  await pool.query(
    `UPDATE bot_users
       SET total_wagered = total_wagered + $2,
           wager_requirement = GREATEST(0, wager_requirement - $2),
           total_won = total_won + $3,
           total_lost = total_lost + $4,
           games_played = games_played + 1,
           games_won = games_won + $5,
           last_command_at = NOW()
     WHERE discord_id = $1`,
    [
      discordId,
      bet.toString(),
      wonAmount.toString(),
      lostAmount.toString(),
      won ? 1 : 0,
    ],
  );
}

export type BalanceSource =
  | "coupon"
  | "daily"
  | "admin"
  | "deposit"
  | "invite"
  | "withdraw"
  | "irlwithdraw";

export async function recordBalanceEvent(params: {
  discordId: string;
  delta: bigint;
  source: BalanceSource;
  detail?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO bot_balance_ledger (discord_id, delta, source, detail)
       VALUES ($1, $2, $3, $4)`,
    [
      params.discordId,
      params.delta.toString(),
      params.source,
      params.detail ?? null,
    ],
  );
}

export interface BalanceEvent {
  id: string;
  delta: string;
  source: string;
  detail: string | null;
  created_at: Date;
}

export async function getBalanceHistory(
  discordId: string,
  limit = 25,
): Promise<BalanceEvent[]> {
  const r = await pool.query<BalanceEvent>(
    `SELECT id::text AS id, delta::text AS delta, source, detail, created_at
       FROM bot_balance_ledger
       WHERE discord_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
    [discordId, limit],
  );
  return r.rows;
}

export interface GameEvent {
  id: number;
  game: string;
  bet: string;
  payout: string;
  won: boolean;
  details: unknown;
  created_at: Date;
}

export async function getGameHistory(
  discordId: string,
  limit = 25,
): Promise<GameEvent[]> {
  const r = await pool.query<GameEvent>(
    `SELECT id, game, bet::text AS bet, payout::text AS payout, won, details, created_at
       FROM game_log
       WHERE discord_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
    [discordId, limit],
  );
  return r.rows;
}

export async function setLastDaily(discordId: string): Promise<void> {
  await pool.query(
    `UPDATE bot_users SET last_daily = NOW() WHERE discord_id = $1`,
    [discordId],
  );
}

export async function getLeaderboard(
  metric: "balance" | "total_won" | "games_won",
  limit = 10,
): Promise<Array<{ discord_id: string; minecraft_username: string | null; value: string }>> {
  const r = await pool.query(
    `SELECT discord_id, minecraft_username, ${metric}::text AS value
       FROM bot_users
       WHERE verified = TRUE
       ORDER BY ${metric} DESC
       LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export interface PendingWithdrawal {
  id: string;
  discord_id: string;
  channel_id: string;
  amount: string;
  ign: string;
  ign_confirmed: boolean;
  status: "pending" | "paid" | "cancelled";
  created_at: Date;
  resolved_at: Date | null;
}

export async function createPendingWithdrawal(params: {
  discordId: string;
  channelId: string;
  amount: bigint;
  ign: string;
}): Promise<PendingWithdrawal | null> {
  const r = await pool.query<PendingWithdrawal>(
    `INSERT INTO bot_pending_withdrawals
       (discord_id, channel_id, amount, ign)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text, discord_id, channel_id, amount::text, ign,
               ign_confirmed, status, created_at, resolved_at`,
    [
      params.discordId,
      params.channelId,
      params.amount.toString(),
      params.ign,
    ],
  );
  return r.rows[0] ?? null;
}

export async function getPendingWithdrawalById(
  id: string,
): Promise<PendingWithdrawal | null> {
  const r = await pool.query<PendingWithdrawal>(
    `SELECT id::text, discord_id, channel_id, amount::text, ign,
            ign_confirmed, status, created_at, resolved_at
       FROM bot_pending_withdrawals
       WHERE id = $1::bigint`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function getPendingWithdrawalByChannel(
  channelId: string,
): Promise<PendingWithdrawal | null> {
  const r = await pool.query<PendingWithdrawal>(
    `SELECT id::text, discord_id, channel_id, amount::text, ign,
            ign_confirmed, status, created_at, resolved_at
       FROM bot_pending_withdrawals
       WHERE channel_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
    [channelId],
  );
  return r.rows[0] ?? null;
}

export async function updatePendingWithdrawalIgn(
  id: string,
  ign: string,
): Promise<void> {
  await pool.query(
    `UPDATE bot_pending_withdrawals
       SET ign = $2, ign_confirmed = FALSE
     WHERE id = $1::bigint AND status = 'pending'`,
    [id, ign],
  );
}

export async function confirmPendingWithdrawalIgn(id: string): Promise<void> {
  await pool.query(
    `UPDATE bot_pending_withdrawals
       SET ign_confirmed = TRUE
     WHERE id = $1::bigint AND status = 'pending'`,
    [id],
  );
}

/**
 * Atomically flip a pending withdrawal to `cancelled`. Returns `true` only
 * if THIS call was the one that flipped it (i.e. the row was still
 * 'pending' when the UPDATE hit the row). The caller must use this return
 * value to gate the refund — otherwise simultaneous button clicks would
 * each refund the user, duplicating the balance.
 */
export async function markPendingWithdrawalCancelled(
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_pending_withdrawals
       SET status = 'cancelled', resolved_at = NOW()
     WHERE id = $1::bigint AND status = 'pending'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Atomically flip a pending withdrawal to `paid`. Returns `true` only if
 * THIS call was the one that flipped it. Callers should use this as the
 * "did the payout actually settle?" gate.
 */
export async function markPendingWithdrawalPaid(
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_pending_withdrawals
       SET status = 'paid', resolved_at = NOW()
     WHERE id = $1::bigint AND status = 'pending'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface PendingDeposit {
  id: string;
  discord_id: string;
  channel_id: string;
  amount: string;
  status: string;
  created_at: Date;
}

export async function createPendingDeposit(params: {
  discordId: string;
  channelId: string;
  amount: bigint;
}): Promise<PendingDeposit | null> {
  try {
    const r = await pool.query<PendingDeposit>(
      `INSERT INTO bot_pending_deposits (discord_id, channel_id, amount)
         VALUES ($1, $2, $3)
         RETURNING *`,
      [params.discordId, params.channelId, params.amount.toString()],
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getPendingDepositById(
  id: string,
): Promise<PendingDeposit | null> {
  const r = await pool.query<PendingDeposit>(
    `SELECT * FROM bot_pending_deposits WHERE id = $1::bigint`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function getPendingDepositByDiscordId(
  discordId: string,
): Promise<PendingDeposit | null> {
  const r = await pool.query<PendingDeposit>(
    `SELECT * FROM bot_pending_deposits
     WHERE discord_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [discordId],
  );
  return r.rows[0] ?? null;
}

export async function completePendingDeposit(id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_pending_deposits
       SET status = 'completed', resolved_at = NOW()
     WHERE id = $1::bigint AND status = 'pending'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function cancelPendingDepositByChannel(
  channelId: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_pending_deposits
       SET status = 'cancelled', resolved_at = NOW()
     WHERE channel_id = $1 AND status = 'pending'`,
    [channelId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getConfig(key: string): Promise<string | null> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM bot_config WHERE key = $1`,
    [key],
  );
  return r.rows[0]?.value ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function deleteConfig(key: string): Promise<void> {
  await pool.query(`DELETE FROM bot_config WHERE key = $1`, [key]);
}

/**
 * Atomically claim a payment message ID for processing.
 * Returns true if this instance is the first to claim it (should process it),
 * false if another instance already claimed it (skip — duplicate).
 */
export async function claimPaymentMessage(messageId: string): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO bot_processed_messages (message_id) VALUES ($1)`,
      [messageId],
    );
    return true;
  } catch {
    return false;
  }
}

/** How many coins the sender has paid out today (UTC day). */
export async function getDailyPaySent(senderId: string): Promise<bigint> {
  const r = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM bot_pay_transactions
      WHERE sender_discord_id = $1
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [senderId],
  );
  return BigInt(r.rows[0]?.total ?? "0");
}

export type PayResult =
  | { ok: true; senderBalance: bigint; receiverBalance: bigint }
  | { ok: false; reason: "insufficient_funds" | "daily_limit" | "wager_required" | "error" };

const PAY_DAILY_LIMIT = 50_000_000n; // 50 million

/**
 * Atomically transfer coins from sender to receiver.
 * Enforces a 50 million per-day send limit and prevents negative balances.
 */
export async function executePayment(
  senderId: string,
  receiverId: string,
  amount: bigint,
): Promise<PayResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock both users in a consistent order to prevent deadlocks.
    const [firstId, secondId] =
      senderId < receiverId
        ? [senderId, receiverId]
        : [receiverId, senderId];

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`pay:${firstId}:${secondId}`],
    );

    // Ensure both users exist.
    await client.query(
      `INSERT INTO bot_users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [senderId],
    );
    await client.query(
      `INSERT INTO bot_users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [receiverId],
    );

    // Block if sender has an outstanding wager requirement (anti-launder).
    const wagerRes = await client.query<{ wager_requirement: string }>(
      `SELECT wager_requirement FROM bot_users WHERE discord_id = $1`,
      [senderId],
    );
    const wagerReq = BigInt(wagerRes.rows[0]?.wager_requirement ?? "0");
    if (wagerReq > 0n) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "wager_required" };
    }

    // Check daily limit.
    const dailyRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM bot_pay_transactions
        WHERE sender_discord_id = $1
          AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
      [senderId],
    );
    const dailySent = BigInt(dailyRes.rows[0]?.total ?? "0");
    if (dailySent + amount > PAY_DAILY_LIMIT) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "daily_limit" };
    }

    // Deduct from sender (enforce non-negative).
    const senderRes = await client.query<{ balance: string }>(
      `UPDATE bot_users
          SET balance = balance - $2
        WHERE discord_id = $1
          AND balance >= $2
        RETURNING balance`,
      [senderId, amount.toString()],
    );
    if (!senderRes.rowCount || senderRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient_funds" };
    }

    // Credit receiver.
    const receiverRes = await client.query<{ balance: string }>(
      `UPDATE bot_users SET balance = balance + $2 WHERE discord_id = $1 RETURNING balance`,
      [receiverId, amount.toString()],
    );

    // Record the transaction.
    await client.query(
      `INSERT INTO bot_pay_transactions (sender_discord_id, receiver_discord_id, amount)
         VALUES ($1, $2, $3)`,
      [senderId, receiverId, amount.toString()],
    );

    // Ledger entries for both sides.
    await client.query(
      `INSERT INTO bot_balance_ledger (discord_id, delta, source, detail)
         VALUES ($1, $2, 'pay', $3), ($4, $5, 'pay', $6)`,
      [
        senderId,
        (-amount).toString(),
        `Paid to <@${receiverId}>`,
        receiverId,
        amount.toString(),
        `Received from <@${senderId}>`,
      ],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      senderBalance: BigInt(senderRes.rows[0]!.balance),
      receiverBalance: BigInt(receiverRes.rows[0]!.balance),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[db] executePayment failed:", err);
    return { ok: false, reason: "error" };
  } finally {
    client.release();
  }
}
