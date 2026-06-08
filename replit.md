# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Houses a Discord casino/gambling bot
plus the standard API server scaffold.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Database**: PostgreSQL (Replit-managed) via `pg`
- **Discord bot**: discord.js v14 (`artifacts/discord-bot/`)
- **API framework**: Express 5 (`artifacts/api-server/`)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`

## Discord Bot (`artifacts/discord-bot`)

Long-running Node.js process. Started via `Start Discord Bot` workflow in dev,
or `scripts/start-production.sh` in production (runs health check server + bot directly).
Uses two secrets: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`.

### Commands
- Account: `/verify`, `/balance`, `/daily`, `/leaderboard`
- Banking (creates private staff tickets): `/deposit`, `/withdraw`, `/pay`, `/close`
- Games: `/coinflip`, `/roulette`, `/blackjack`, `/mines`, `/towers`, `/dice`
- Moderator: `/admin approve|deny|withdraw|setbalance|setmodrole|config|forceverify|...`
- Help: `/help`

### House edge

Blackjack uses its own rigging in `blackjack.ts`:
- `HOUSE_WIN_RATE = 0.55` (base, bets under 49M)
- `BIG_BET_HOUSE_RATE = 0.58` (49M–74M)
- `WHALE_BET_HOUSE_RATE = 0.61` (74M–99M)
- `MEGA_WHALE_BET_HOUSE_RATE = 0.63` (99M+)

Mines and Towers use `src/lib/house.ts`.

### Bet limits

- Minimum: **10,000 coins (10k)** — all games
- Maximum: **150,000,000 coins (150M)** — all games (`MAX_BET` in `format.ts`)

### Withdraw flow

`/withdraw <amount>` validates balance, opens a private ticket, **debits the
user immediately**, and inserts a row in `bot_pending_withdrawals` keyed by
the channel id. The ticket embed asks `your IGN is X — is that correct?`
with two buttons: **Yes** (confirms) and **Cancel** (refunds + auto-deletes
the channel after 10s). If the IGN is wrong, the user cancels and tells
staff — no in-bot rename to keep the flow dupe-proof.

`/admin withdraw <user> <amount>` checks for a pending row in the current
channel: if one exists and matches the user/amount, it just marks it `paid`
(no second debit). Otherwise it falls back to the legacy debit-now flow.

**Dupe protection:** `markPendingWithdrawalCancelled` and
`markPendingWithdrawalPaid` use `WHERE status = 'pending'` and return a
`boolean` reporting whether the UPDATE actually flipped the row. The cancel
handler ALSO defers the interaction first, then only calls `adjustBalance`
when the flip returned `true` — so simultaneous button clicks (or Discord
double-fires) can never refund twice.

### Casino panel

A header embed with **⚙️ Settings**, **📥 Deposit**, **📤 Withdraw**,
**💰 Balance** buttons. Auto-posted on bot startup to channel
`1498881450643296400` (configurable via `bot_config.panel_channel_id`); the
posted message id is remembered in `bot_config.panel_message_id` so reboots
don't dupe the panel. Owners can re-post anywhere with `/admin panel`.

Settings opens a verification ticket (same flow as `/verify`). Deposit and
Withdraw open a modal asking for the amount, then create the matching
ticket — withdraw uses the same debit-now flow as the slash command.

### Database tables (auto-created on boot)

- `bot_users` — discord_id, minecraft_username, verified, balance, stats
- `bot_config` — key/value config (mod role, ticket category)
- `bot_balance_ledger` — every balance change with source + detail
- `bot_pending_withdrawals` — open withdrawal tickets (one per channel)
- `bot_pending_deposits` — open deposit tickets (one per channel)
- `bot_processed_messages` — deduplication table for payment webhook messages
- `bot_coupons` / `bot_coupon_redemptions` — promo codes
- `game_log` — every bet logged for analytics

### Duplicate bot warning

**Never run the `Start Discord Bot` dev workflow while the published production
bot is live.** Both share the same `DISCORD_BOT_TOKEN` — Discord delivers every
interaction to both instances, causing 10062 Unknown Interaction errors and
duplicate responses.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/discord-bot run start` — run the bot locally
- `pnpm --filter @workspace/api-server run dev` — run the API server locally

## Saved: watchdog-bot.sh

The user removed the watchdog in favour of Replit autoscale + UptimeRobot.
Restore by creating `scripts/watchdog-bot.sh` with the content below and
changing `start-production.sh` line 17 back to `exec bash scripts/watchdog-bot.sh`.

```bash
#!/bin/bash

RESTART_DELAY=180
SHUTTING_DOWN=0
LOG_CHANNEL_ID="1500275139311439942"

send_embed() {
  local title="$1"
  local description="$2"
  local color="$3"
  curl -s -X POST "https://discord.com/api/v10/channels/${LOG_CHANNEL_ID}/messages" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"embeds\":[{\"title\":\"${title}\",\"description\":\"${description}\",\"color\":${color},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" \
    > /dev/null 2>&1
}

cleanup() {
  SHUTTING_DOWN=1
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') — Stopped by signal."
  send_embed "Bot Stopped" "The workflow was stopped manually." "6316128"
  exit 0
}

trap cleanup SIGTERM SIGINT

while true; do
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') — Starting Discord bot..."

  pnpm --filter @workspace/discord-bot run start
  EXIT_CODE=$?

  if [ $SHUTTING_DOWN -eq 1 ]; then
    exit 0
  fi

  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') — Bot stopped (code: $EXIT_CODE). Restarting in ${RESTART_DELAY}s..."

  if [ $EXIT_CODE -ne 0 ]; then
    send_embed "Bot Crashed" "Exited with code \`${EXIT_CODE}\`. Restarting in ${RESTART_DELAY}s..." "15548997"
  else
    send_embed "Bot Restarting" "Bot exited cleanly. Restarting in ${RESTART_DELAY}s..." "16776960"
  fi

  sleep $RESTART_DELAY
done
```
