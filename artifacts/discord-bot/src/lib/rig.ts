import { pool } from "./db.js";

export type RigMode = "next_loss" | "pct_win";

export type RigResult =
  | { active: false }
  | { active: true; forceLoss: true; forceWin: false }
  | { active: true; forceLoss: false; forceWin: true };

export async function setRig(
  discordId: string,
  mode: RigMode,
  value = 80,
): Promise<void> {
  await pool.query(
    `INSERT INTO bot_rigged (discord_id, mode, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_id) DO UPDATE SET mode = $2, value = $3, created_at = NOW()`,
    [discordId, mode, value],
  );
}

export async function clearRig(discordId: string): Promise<boolean> {
  const r = await pool.query(
    "DELETE FROM bot_rigged WHERE discord_id = $1 RETURNING discord_id",
    [discordId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getRigRow(
  discordId: string,
): Promise<{ mode: RigMode; value: number } | null> {
  const r = await pool.query<{ mode: RigMode; value: number }>(
    "SELECT mode, value FROM bot_rigged WHERE discord_id = $1",
    [discordId],
  );
  return r.rows[0] ?? null;
}

/**
 * Resolve the rig for a user at game start.
 *
 * @param sessionStartedAt - ms epoch when this game's session was started.
 *   For next_loss, if the rig was SET after the session started (race condition),
 *   it is NOT consumed — it will fire on the next game instead.
 */
export async function checkRig(
  discordId: string,
  sessionStartedAt?: number,
): Promise<RigResult> {
  const r = await pool.query<{ mode: RigMode; value: number; created_ms: number }>(
    `SELECT mode, value,
            EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
     FROM bot_rigged WHERE discord_id = $1`,
    [discordId],
  );
  const rig = r.rows[0];
  if (!rig) return { active: false };

  if (rig.mode === "next_loss") {
    // If the rig was set AFTER this session started, save it for the next game.
    if (sessionStartedAt !== undefined && rig.created_ms > sessionStartedAt) {
      return { active: false };
    }
    const del = await pool.query(
      "DELETE FROM bot_rigged WHERE discord_id = $1 AND mode = 'next_loss' RETURNING discord_id",
      [discordId],
    );
    if ((del.rowCount ?? 0) === 0) return { active: false };
    return { active: true, forceLoss: true, forceWin: false };
  }

  if (rig.mode === "pct_win") {
    const p = Math.min(100, Math.max(0, rig.value)) / 100;
    return Math.random() < p
      ? { active: true, forceLoss: false, forceWin: true }
      : { active: false };
  }

  return { active: false };
}
