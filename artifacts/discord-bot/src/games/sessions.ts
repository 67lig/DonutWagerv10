/**
 * Shared in-memory store of active interactive game sessions.
 * Keyed by discord user id — each user can only run one interactive game
 * at a time, which prevents race conditions on balance updates.
 */

export interface ActiveSession {
  game: "mines" | "blackjack" | "towers";
  startedAt: number;
}

const sessions = new Map<string, ActiveSession>();

export function getSession(userId: string): ActiveSession | undefined {
  return sessions.get(userId);
}

export function startSession(userId: string, game: ActiveSession["game"]): boolean {
  if (sessions.has(userId)) return false;
  sessions.set(userId, { game, startedAt: Date.now() });
  return true;
}

export function endSession(userId: string): void {
  sessions.delete(userId);
}

// Auto-cleanup: drop stale sessions older than 6 minutes
// (collectors time out after 5 min, so anything older is definitely orphaned)
setInterval(
  () => {
    const cutoff = Date.now() - 6 * 60 * 1000;
    for (const [id, sess] of sessions) {
      if (sess.startedAt < cutoff) sessions.delete(id);
    }
  },
  60 * 1000,
).unref?.();
