import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordGame } from "../lib/db.js";
import { formatCoins, MAX_BET, parseBet } from "../lib/format.js";
import { antiSpam } from "../lib/guards.js";
import { getHouseRates, rateForBet } from "../lib/houserates.js";
import { logGamble } from "../lib/gamblelog.js";
import { checkRig } from "../lib/rig.js";
import type { SlashCommand } from "../lib/types.js";
import { endSession, getSession, startSession } from "../games/sessions.js";

const COLS = 5;
const ROWS = 5;
const GRID = COLS * ROWS;
const MAX_MINES = GRID - 1;
const DEFAULT_MINES = 3;

// Flat house cut applied to every cashout multiplier. 0.93 = 7% rake.
const HOUSE_CUT = 0.93;

// Once the player's current multiplier hits this, the next click is forced
// to bust — keeps the house edge on long runs (automine protection).
const AUTO_BUST_MULT = 18.0;

// Per-click rig probability when the house is scheduled to win this session.
// This is a moderate uniform chance applied to every click; combined with the
// ceiling bust above it produces the target overall win rates.
const HOUSE_RIG_CHANCE = 0.14;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MinesState {
  bet: bigint;
  mines: number;
  revealed: Set<number>;
  exploded: boolean;
  cashedOut: boolean;
  timedOut: boolean;
  willHouseWin: boolean;
  forceWin: boolean;
  forceFirstClick: boolean;
  mineTiles: Set<number>;
  safeTiles: Set<number>;
}

type EndSummary = {
  multiplier: number;
  netDelta: bigint;
  newBalance: bigint;
};

function formatSigned(delta: bigint): string {
  if (delta >= 0n) return `+${formatCoins(delta)}`;
  return `-${formatCoins(-delta)}`;
}

function fairMultiplier(picks: number, mines: number): number {
  if (picks === 0) return 1;
  let m = 1;
  for (let i = 0; i < picks; i++) {
    const safeRemaining = GRID - mines - i;
    const totalRemaining = GRID - i;
    if (safeRemaining <= 0) return m;
    m *= totalRemaining / safeRemaining;
  }
  return m;
}

function multiplierFor(picks: number, mines: number): number {
  return fairMultiplier(picks, mines) * HOUSE_CUT;
}

function liveRig(state: MinesState): number {
  if (!state.willHouseWin) return 0;
  return HOUSE_RIG_CHANCE;
}

function buildBoard(state: MinesState, gameOver: boolean) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < ROWS; r++) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const isRevealed = state.revealed.has(idx);
      const isMine = state.mineTiles.has(idx);

      const btn = new ButtonBuilder().setCustomId(`mines:tile:${idx}`);

      if (gameOver) {
        if (isRevealed && !isMine) {
          btn.setLabel("💎").setStyle(ButtonStyle.Success).setDisabled(true);
        } else if (isMine) {
          btn.setLabel("💣").setStyle(ButtonStyle.Danger).setDisabled(true);
        } else {
          btn.setLabel("·").setStyle(ButtonStyle.Secondary).setDisabled(true);
        }
      } else if (isRevealed) {
        btn.setLabel("💎").setStyle(ButtonStyle.Success).setDisabled(true);
      } else {
        btn.setLabel("\u200b").setStyle(ButtonStyle.Primary);
      }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

function buildCashoutRow(enabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("mines:cashout")
      .setLabel("Cash Out")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!enabled),
  );
}

function buildContainer(
  state: MinesState,
  currentMultiplier: number,
  gameOver: boolean,
  summary?: EndSummary,
): ContainerBuilder {
  const color = state.exploded
    ? 0xef4444
    : state.cashedOut
      ? 0x22c55e
      : 0x3b82f6;

  let header: string;
  let bodyLines: string[];

  if (state.cashedOut && summary) {
    header = "## Cashed Out!";
    bodyLines = [
      `**Tiles revealed:** ${state.revealed.size}`,
      `**Multiplier:** x${summary.multiplier.toFixed(2)}`,
      `**Gross:** ${formatSigned(summary.netDelta)} `,
      `**New Balance:** ${formatCoins(summary.newBalance)} `,
    ];
  } else if (state.exploded && summary) {
    header = "## 💥 BOOM: Mine Hit!";
    bodyLines = [
      `**Tiles revealed:** ${state.revealed.size}`,
      `**Multiplier:** x0.00`,
      `**Gross:** ${formatSigned(summary.netDelta)} `,
      `**New Balance:** ${formatCoins(summary.newBalance)} `,
    ];
  } else if (state.timedOut) {
    header = "## ⌛ Timed Out";
    bodyLines = [`Game expired after 5 minutes. Your bet was refunded.`];
  } else {
    header = "## 💎 Mines";
    const potential = BigInt(
      Math.floor(Number(state.bet) * currentMultiplier),
    );
    const profit = potential - state.bet;
    bodyLines = [
      `**Bet:** ${formatCoins(state.bet)} 🪙  •  **Mines:** ${state.mines} / ${GRID}  •  **Revealed:** ${state.revealed.size}`,
      `**Multiplier:** x${currentMultiplier.toFixed(2)}  •  **Cash out for:** ${formatCoins(potential)} 🪙 (${formatSigned(profit)})`,
    ];
  }

  const titleText = new TextDisplayBuilder().setContent(header);
  const bodyText = new TextDisplayBuilder().setContent(bodyLines.join("\n"));

  const cashoutEnabled =
    !gameOver &&
    !state.cashedOut &&
    !state.exploded &&
    state.revealed.size > 0;

  const container = new ContainerBuilder().setAccentColor(color);
  container.addTextDisplayComponents(titleText);
  for (const row of buildBoard(state, gameOver)) {
    container.addActionRowComponents(row);
  }
  container.addTextDisplayComponents(bodyText);
  container.addActionRowComponents(buildCashoutRow(cashoutEnabled));
  return container;
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mines")
    .setDescription("Reveal gems and avoid the mines (5x5 board)")
    .addStringOption((o) =>
      o.setName("bet").setDescription("Amount to bet").setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("mines")
        .setDescription(`Number of mines (1-${MAX_MINES}, default ${DEFAULT_MINES})`)
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_MINES),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // ── Fast synchronous guards (before defer) ──────────────────────────────
    if (!antiSpam(interaction.user.id)) {
      await interaction.reply({ content: "Slow down.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (getSession(interaction.user.id)) {
      await interaction.reply({ content: "Finish your active game first.", flags: MessageFlags.Ephemeral });
      return;
    }

    const minesOpt = interaction.options.getInteger("mines") ?? DEFAULT_MINES;
    if (!Number.isInteger(minesOpt) || minesOpt < 1 || minesOpt > MAX_MINES) {
      await interaction.reply({ content: `Mines must be a whole number between 1 and ${MAX_MINES}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // ── Defer before any DB work ────────────────────────────────────────────
    await interaction.deferReply();

    const user = await getOrCreateUser(interaction.user.id);

    if (!user.verified) {
      await interaction.editReply({ content: "You must verify before gambling. Use `/verify minecraft:<username>`." });
      return;
    }

    const balance = BigInt(user.balance);
    const rawBet = interaction.options.getString("bet", true);
    const betParsed = parseBet(rawBet, balance);

    if (!betParsed || betParsed <= 0n) {
      await interaction.editReply({ content: "Invalid bet. Try a number, `all`, `half`, or values like `100k`, `5mil`, `1bil`." });
      return;
    }
    if (betParsed < 10_000n) {
      await interaction.editReply({ content: "Minimum bet is **10,000 coins** (10k)." });
      return;
    }
    if (betParsed > MAX_BET) {
      await interaction.editReply({ content: `Maximum bet is **150,000,000 coins** (150M).` });
      return;
    }
    if (betParsed > balance) {
      await interaction.editReply({ content: `Not enough coins. Your balance is ${formatCoins(balance)}.` });
      return;
    }

    const bet = betParsed;

    if (!startSession(interaction.user.id, "mines")) {
      await interaction.editReply({ content: "Finish your active game first." });
      return;
    }
    const minesSession = getSession(interaction.user.id)!;
    await adjustBalance(interaction.user.id, -bet);

    const refundAndAbort = async (msg: string): Promise<void> => {
      try {
        await adjustBalance(interaction.user.id, bet);
      } finally {
        endSession(interaction.user.id);
      }
      try {
        await interaction.editReply({ content: msg });
      } catch { /* ignore */ }
    };

    const minePositions = new Set<number>();
    while (minePositions.size < minesOpt) {
      minePositions.add(Math.floor(Math.random() * GRID));
    }

    const rates = await getHouseRates();
    const baseWillHouseWin = Math.random() < rateForBet(rates, bet);
    const rigResult = await checkRig(interaction.user.id, minesSession.startedAt);
    const willHouseWin = rigResult.active && rigResult.forceLoss
      ? true
      : rigResult.active && rigResult.forceWin
        ? false
        : baseWillHouseWin;

    const state: MinesState = {
      bet,
      mines: minesOpt,
      revealed: new Set(),
      exploded: false,
      cashedOut: false,
      timedOut: false,
      willHouseWin,
      forceWin: rigResult.active && rigResult.forceWin,
      forceFirstClick: rigResult.active && rigResult.forceLoss,
      mineTiles: minePositions,
      safeTiles: new Set(),
    };

    let message;
    try {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildContainer(state, multiplierFor(0, state.mines), false)],
      });
      message = await interaction.fetchReply();
    } catch (err) {
      console.error("[mines] failed to send game message:", err);
      await refundAndAbort("Couldn't start the game. Your bet was refunded. Please try again.");
      return;
    }

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id,
    });

    collector.on("collect", async (btn: ButtonInteraction) => {
      if (state.exploded || state.cashedOut) return;
      const id = btn.customId;

      if (id === "mines:cashout") {
        if (state.revealed.size === 0) {
          await btn.reply({
            content: "Reveal at least one tile before cashing out.",
            ephemeral: true,
          });
          return;
        }

        state.cashedOut = true;
        try {
          const mult = multiplierFor(state.revealed.size, state.mines);
          const payout = BigInt(Math.floor(Number(state.bet) * mult));
          const newBalance = await adjustBalance(interaction.user.id, payout);
          await recordGame({
            discordId: interaction.user.id,
            game: "mines",
            bet: state.bet,
            payout,
            won: payout > state.bet,
            details: { picks: state.revealed.size, mines: state.mines, mult },
          });
          await logGamble({
            discordId: interaction.user.id,
            game: "mines",
            bet: state.bet,
            payout,
            won: payout > state.bet,
            detail: `cashout ${state.revealed.size} picks, ${state.mines} mines, x${mult.toFixed(2)}`,
          });
          let safety = 0;
          while (state.mineTiles.size < state.mines && safety++ < 200) {
            const candidate = Math.floor(Math.random() * GRID);
            if (!state.revealed.has(candidate) && !state.mineTiles.has(candidate))
              state.mineTiles.add(candidate);
          }
          try {
            await btn.update({
              components: [
                buildContainer(state, mult, true, {
                  multiplier: mult,
                  netDelta: payout - state.bet,
                  newBalance,
                }),
              ],
            });
          } catch {
            /* ignore */
          }
        } finally {
          endSession(interaction.user.id);
          collector.stop("cashout");
        }
        return;
      }

      const tileMatch = id.match(/^mines:tile:(\d+)$/);
      if (!tileMatch) return;
      const idx = parseInt(tileMatch[1]!, 10);

      if (state.revealed.has(idx)) {
        await btn.deferUpdate();
        return;
      }

      // ── Survival logic ─────────────────────────────────────────────────────
      const currentMult = multiplierFor(state.revealed.size, state.mines);
      const ceilingBust = currentMult >= AUTO_BUST_MULT;
      let rig: number;
      if (state.forceFirstClick && state.revealed.size === 0) {
        state.forceFirstClick = false;
        rig = 1;
      } else {
        rig = liveRig(state);
      }

      let survive: boolean;
      if (state.forceWin) {
        // 100% win rig — if this tile happened to be a mine, move it away
        if (state.mineTiles.has(idx)) {
          state.mineTiles.delete(idx);
          let safety2 = 0;
          while (state.mineTiles.size < state.mines && safety2++ < 200) {
            const candidate = Math.floor(Math.random() * GRID);
            if (!state.revealed.has(candidate) && !state.mineTiles.has(candidate) && candidate !== idx)
              state.mineTiles.add(candidate);
          }
        }
        survive = true;
      } else if (state.mineTiles.has(idx)) {
        survive = false;
      } else if (ceilingBust || Math.random() < rig) {
        const movable: number[] = [];
        for (const m of state.mineTiles) {
          if (!state.revealed.has(m)) movable.push(m);
        }
        if (movable.length > 0) {
          const remove = movable[Math.floor(Math.random() * movable.length)]!;
          state.mineTiles.delete(remove);
        }
        state.mineTiles.add(idx);
        survive = false;
      } else {
        survive = true;
      }

      if (!survive) {
        state.exploded = true;
        if (!state.mineTiles.has(idx)) state.mineTiles.add(idx);
        try {
          await recordGame({
            discordId: interaction.user.id,
            game: "mines",
            bet: state.bet,
            payout: 0n,
            won: false,
            details: {
              picks: state.revealed.size,
              mines: state.mines,
              blewUp: idx,
              rig,
              ceilingBust,
            },
          });
          await logGamble({
            discordId: interaction.user.id,
            game: "mines",
            bet: state.bet,
            payout: 0n,
            won: false,
            detail: `boom on tile ${idx} after ${state.revealed.size} picks (rig ${(rig * 100).toFixed(0)}%${ceilingBust ? ", ceiling" : ""})`,
          });
          const currentUser = await getOrCreateUser(interaction.user.id);
          try {
            await btn.update({
              components: [
                buildContainer(state, 0, true, {
                  multiplier: 0,
                  netDelta: -state.bet,
                  newBalance: BigInt(currentUser.balance),
                }),
              ],
            });
          } catch {
            /* ignore */
          }
        } finally {
          endSession(interaction.user.id);
          collector.stop("explode");
        }
        return;
      }

      state.revealed.add(idx);
      state.safeTiles.add(idx);
      const mult = multiplierFor(state.revealed.size, state.mines);
      try {
        await btn.update({
          components: [buildContainer(state, mult, false)],
        });
      } catch {
        /* ignore */
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "cashout" || reason === "explode") return;
      if (state.exploded || state.cashedOut) return;
      await adjustBalance(interaction.user.id, state.bet);
      endSession(interaction.user.id);
      state.timedOut = true;
      try {
        await message.edit({
          components: [
            buildContainer(
              state,
              multiplierFor(state.revealed.size, state.mines),
              true,
            ),
          ],
        });
      } catch {
        /* ignore */
      }
    });
  },
};

export default command;