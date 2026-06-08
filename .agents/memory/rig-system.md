---
name: Rig system
description: Hidden /l and /w admin commands that rig player outcomes across all 6 games.
---

## Overview
`src/lib/rig.ts` — core engine. `bot_rigged` table (discord_id PK, mode, value, created_at).

## Modes
- `next_loss` — atomically consumed after one game (DELETE … RETURNING pattern)
- `pct_loss` — persistent, value = loss % (default 80)
- `pct_win` — persistent, value = win % (default 80)

## Commands
- `/l next <user>` — one-shot next game loses
- `/l add <user>` — 80% persistent lose rate
- `/l remove <user>` — clear rig
- `/w <user> [percent]` — persistent win rate, default 80%

Both commands: setDefaultMemberPermissions(Administrator) + OWNER_IDS code-level check.

## Integration pattern per game
Call `checkRig(userId)` BEFORE `adjustBalance` so the rig is resolved before money moves.

- **coinflip / dice**: override the `won` boolean
- **roulette**: override `houseWins` (feeds into `rigToSatisfy`)
- **blackjack**: override `willHouseWin` and `rig` (set to 1.0 for forceLoss, 0.0 for forceWin) on BJState at deal time
- **mines**: `forceFirstClick: boolean` added to MinesState; on first tile click `rig = 1` forces bomb-move to that tile (no extra mines added)
- **towers**: `forceFirstFail: boolean` added to TowersState; first-row click bypasses survivalThreshold and forces fail

**Why:** checkRig before adjustBalance ensures next_loss is consumed atomically before the bet is placed — avoids the rig being wasted if balance deduction fails.
