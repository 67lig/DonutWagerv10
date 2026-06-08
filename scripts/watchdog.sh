#!/usr/bin/env bash

# =============================================================================
#  Discord Bot Watchdog
# =============================================================================
#  Keeps the Discord bot running. When it stops for any reason it restarts it.
#
#  Usage:
#    bash scripts/watchdog.sh
#
#  Environment variables (all optional):
#    RESTART_DELAY      Seconds to wait before restarting after a crash (default: 5)
#    MAX_RETRIES        Max consecutive crashes before a longer cooldown (default: 5)
#    BACKOFF_SECONDS    Cooldown wait time after hitting max retries (default: 300)
#    LOG_FILE           Path to log file (default: scripts/watchdog.log)
# =============================================================================

RESTART_DELAY=${RESTART_DELAY:-5}
MAX_RETRIES=${MAX_RETRIES:-5}
BACKOFF_SECONDS=${BACKOFF_SECONDS:-300}
LOG_FILE=${LOG_FILE:-"scripts/watchdog.log"}

RETRY_COUNT=0

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() {
  local level="$1"
  shift
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

cleanup() {
  log "INFO" "Watchdog received shutdown signal. Exiting."
  exit 0
}

trap cleanup SIGINT SIGTERM

# -----------------------------------------------------------------------------
# Startup
# -----------------------------------------------------------------------------

mkdir -p "$(dirname "$LOG_FILE")"

log "INFO" "============================================"
log "INFO" " Discord Bot Watchdog starting"
log "INFO" "  Restart delay : ${RESTART_DELAY}s"
log "INFO" "  Max retries   : ${MAX_RETRIES}"
log "INFO" "  Backoff       : ${BACKOFF_SECONDS}s after ${MAX_RETRIES} crashes"
log "INFO" "  Log file      : ${LOG_FILE}"
log "INFO" "============================================"

# -----------------------------------------------------------------------------
# Main loop — bot runs in foreground so when it exits we know immediately
# -----------------------------------------------------------------------------

while true; do
  log "INFO" "Starting bot: pnpm --filter @workspace/discord-bot run start"

  # Run the bot in the foreground — script waits here until the bot exits
  /bin/sh -c 'pnpm --filter @workspace/discord-bot run start'
  EXIT_CODE=$?

  RETRY_COUNT=$((RETRY_COUNT + 1))
  log "WARN" "Bot exited with code $EXIT_CODE (crash #$RETRY_COUNT)."

  if [[ $RETRY_COUNT -ge $MAX_RETRIES ]]; then
    log "ERROR" "Bot has crashed $RETRY_COUNT times in a row."
    log "ERROR" "Cooling down for ${BACKOFF_SECONDS}s before next restart..."
    sleep "$BACKOFF_SECONDS"
    RETRY_COUNT=0
  else
    log "INFO" "Restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
  fi
dones