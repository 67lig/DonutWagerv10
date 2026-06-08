import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordGame } from "../lib/db.js";
import { formatCoins, MAX_BET, parseBet } from "../lib/format.js";
import { antiSpam } from "../lib/guards.js";
import { getHouseRates, shouldHouseWin, riggingBiasFor, type HouseRates } from "../lib/houserates.js";
import { logGamble } from "../lib/gamblelog.js";
import { checkRig } from "../lib/rig.js";
import type { SlashCommand } from "../lib/types.js";
import { endSession, getSession, startSession } from "../games/sessions.js";

// 4 levels x N columns. 4 button rows + 1 cashout row = 5 (Discord max).
const ROWS = 4;

// Display-side house edge applied once on top of the fair multiplier.
// At HOUSE_WIN_RATE = 0.5 this stays as the only edge. As the rate
// climbs above 0.5, `riggingBias` dials in the per-row swing.
const HOUSE_EDGE_FACTOR = 0.95;

// Baseline rig factor applied to every tower row, on every difficulty.
// Shifts the player's per-row survival rate down by this much, e.g. a
// 50/50 row becomes 40% survive / 60% house win.
const RIG_FACTOR = 0.1;

type Difficulty = "easy" | "medium" | "hard";

// Each row has exactly 1 bomb. `cols` = tiles per row (so cols-1 are safe).
// Easy   = 1 bomb of 4 tiles (3 safe, ~1.33x per row — smallest reward).
// Medium = 1 bomb of 3 tiles (2 safe, 1.5x per row).
// Hard   = 1 bomb of 2 tiles (1 safe, 50/50, 2x per row — biggest reward).
const DIFFICULTY_COLS: Record<Difficulty, number> = {
  easy: 4,
  medium: 3,
  hard: 2,
};

interface TowersState {
  bet: bigint;
  cols: number;
  difficulty: Difficulty;
  currentRow: number;
  failed: boolean;
  failedRow: number; // -1 if not failed
  cashedOut: boolean;
  picks: number[];
  bombs: Map<number, number[]>;
  willHouseWin: boolean;
  forceWin: boolean;
  forceFirstFail: boolean;
  rates: HouseRates;
}

function multiplierFor(level: number, cols: number): number {
  if (level <= 0) return 1;
  // Fair payout per cleared row is `cols / (cols - 1)` because (cols - 1)
  // of the tiles are safe and only 1 is a bomb. Apply the display edge
  // once at the end so it doesn't compound row by row.
  return Math.pow(cols / (cols - 1), level) * HOUSE_EDGE_FACTOR;
}

function survivalThreshold(
  cols: number,
  willHouseWin: boolean,
  rig: number,
): number {
  // (cols - 1) of `cols` tiles are safe per row, shifted down by the
  // baseline RIG_FACTOR so the house always has at least that much edge
  // on every row of every difficulty (e.g. a 50/50 becomes 40% survive).
  const fair = Math.max(0, (cols - 1) / cols - RIG_FACTOR);
  // At rig = 0 (HOUSE_WIN_RATE <= 0.5) every round uses the rigged base
  // rate above. As rig ramps up, house-flagged rounds slide toward 0%
  // survival and user-flagged rounds slide toward 100% survival.
  if (willHouseWin) return fair * (1 - rig);
  return fair + (1 - fair) * rig;
}

function buildRows(state: TowersState, gameOver: boolean) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Top of tower at top of message, bottom row is "level 1".
  for (let r = ROWS - 1; r >= 0; r--) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const isCurrent = r === state.currentRow && !gameOver && !state.failed;
    const isCleared = r < state.currentRow;
    const isFailedRow = state.failed && r === state.failedRow;
    const bombCols = state.bombs.get(r) ?? [];
    const userPick = state.picks[r];

    for (let c = 0; c < state.cols; c++) {
      const btn = new ButtonBuilder().setCustomId(`towers:pick:${r}:${c}`);
      const isBomb = bombCols.includes(c);
      const isUserTile = userPick === c;

      if (isCleared) {
        // Row was cleared — user's pick was safe. Of the remaining tiles,
        // exactly one was the bomb and the rest were also safe.
        if (isUserTile) {
          btn.setLabel("💎").setStyle(ButtonStyle.Success).setDisabled(true);
        } else if (isBomb) {
          btn.setLabel("💣").setStyle(ButtonStyle.Danger).setDisabled(true);
        } else {
          btn.setLabel("✅").setStyle(ButtonStyle.Success).setDisabled(true);
        }
      } else if (isFailedRow) {
        // The row they died on — user's tile is the bomb, the rest were safe.
        if (isUserTile) {
          btn.setLabel("💥").setStyle(ButtonStyle.Danger).setDisabled(true);
        } else if (isBomb) {
          btn.setLabel("💣").setStyle(ButtonStyle.Danger).setDisabled(true);
        } else {
          // The would-have-been-safe tile.
          btn.setLabel("✅").setStyle(ButtonStyle.Success).setDisabled(true);
        }
      } else if (gameOver) {
        // Unreached row after game over — leave shrouded.
        btn.setLabel("?").setStyle(ButtonStyle.Secondary).setDisabled(true);
      } else if (isCurrent) {
        btn.setLabel(`L${r + 1}`).setStyle(ButtonStyle.Primary);
      } else {
        btn.setLabel("?").setStyle(ButtonStyle.Secondary).setDisabled(true);
      }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("towers")
    .setDescription("Climb the tower. Pick the safe tile each level")
    .addStringOption((o) =>
      o.setName("bet").setDescription("Amount to bet").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("difficulty")
        .setDescription("Tiles per row (1 bomb each). Default: medium")
        .setRequired(false)
        .addChoices(
          { name: "Easy: 1 bomb of 4 tiles (~1.33x per level)", value: "easy" },
          { name: "Medium: 1 bomb of 3 tiles (1.5x per level)", value: "medium" },
          { name: "Hard: 1 bomb of 2 tiles, 50/50 (2x per level)", value: "hard" },
        ),
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

    const rawBet = interaction.options.getString("bet", true);
    const difficulty =
      (interaction.options.getString("difficulty") as Difficulty | null) ?? "medium";
    const cols = DIFFICULTY_COLS[difficulty];

    // ── Defer before any DB work ────────────────────────────────────────────
    await interaction.deferReply();

    const user = await getOrCreateUser(interaction.user.id);

    if (!user.verified) {
      await interaction.editReply({ content: "You must verify before gambling. Use `/verify minecraft:<username>`." });
      return;
    }

    const balance = BigInt(user.balance);
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

    if (!startSession(interaction.user.id, "towers")) {
      await interaction.editReply({ content: "Finish your active game first." });
      return;
    }
    const towersSession = getSession(interaction.user.id)!;
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

    const rigResult = await checkRig(interaction.user.id, towersSession.startedAt);
    const rates = await getHouseRates();
    const state: TowersState = {
      bet,
      cols,
      difficulty,
      currentRow: 0,
      failed: false,
      failedRow: -1,
      cashedOut: false,
      picks: new Array(ROWS),
      bombs: new Map(),
      willHouseWin: rigResult.active && rigResult.forceLoss
        ? true
        : rigResult.active && rigResult.forceWin
          ? false
          : shouldHouseWin(rates, bet),
      forceWin: rigResult.active && rigResult.forceWin,
      forceFirstFail: rigResult.active && rigResult.forceLoss,
      rates,
    };

    const cashoutDisabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("towers:cashout")
        .setLabel("Cash Out")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
    );
    const cashoutEnabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("towers:cashout")
        .setLabel("Cash Out")
        .setStyle(ButtonStyle.Success),
    );

    const buildEmbed = (status: string, mult: number) => {
      const potential = BigInt(Math.floor(Number(state.bet) * mult));
      return new EmbedBuilder()
        .setColor(state.failed ? 0xef4444 : state.cashedOut ? 0x22c55e : 0x3b82f6)
        .setTitle("Towers")
        .setDescription(status)
        .addFields(
          { name: "Bet", value: formatCoins(state.bet), inline: true },
          {
            name: "Difficulty",
            value: `${state.difficulty} (1 bomb of ${state.cols})`,
            inline: true,
          },
          {
            name: "Level",
            value: `${state.currentRow} / ${ROWS}`,
            inline: true,
          },
          { name: "Multiplier", value: `x${mult.toFixed(2)}`, inline: true },
          {
            name: state.cashedOut ? "Won" : "Potential",
            value: formatCoins(potential),
            inline: true,
          },
        );
    };

    let message;
    try {
      await interaction.editReply({
        embeds: [buildEmbed("Pick a tile in the bottom row.", multiplierFor(0, cols))],
        components: [...buildRows(state, false), cashoutDisabled],
      });
      message = await interaction.fetchReply();
    } catch (err) {
      console.error("[towers] failed to send game message:", err);
      await refundAndAbort("Couldn't start the game. Your bet was refunded.");
      return;
    }

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id,
    });

    collector.on("collect", async (btn: ButtonInteraction) => {
      if (state.failed || state.cashedOut) return;

      if (btn.customId === "towers:cashout") {
        if (state.currentRow === 0) {
          await btn.reply({
            content: "Climb at least one row before cashing out.",
            ephemeral: true,
          });
          return;
        }
        state.cashedOut = true;
        try {
          const mult = multiplierFor(state.currentRow, state.cols);
          const payout = BigInt(Math.floor(Number(state.bet) * mult));
          await adjustBalance(interaction.user.id, payout);
          await recordGame({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout,
            won: payout > state.bet,
            details: {
              level: state.currentRow,
              difficulty: state.difficulty,
              cols: state.cols,
            },
          });
          await logGamble({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout,
            won: payout > state.bet,
            detail: `cashout at level ${state.currentRow} (${state.difficulty})`,
          });
          try {
            await btn.update({
              embeds: [buildEmbed(`**Cashed out for ${formatCoins(payout)}!**`, mult)],
              components: buildRows(state, true),
            });
          } catch { /* ignore */ }
        } finally {
          endSession(interaction.user.id);
          collector.stop("cashout");
        }
        return;
      }

      const m = btn.customId.match(/^towers:pick:(\d+):(\d+)$/);
      if (!m) return;
      const r = parseInt(m[1]!, 10);
      const c = parseInt(m[2]!, 10);
      if (r !== state.currentRow) {
        await btn.deferUpdate();
        return;
      }

      let survive: boolean;
      if (state.forceFirstFail && state.currentRow === 0) {
        state.forceFirstFail = false;
        survive = false;
      } else if (state.forceWin) {
        survive = true;
      } else {
        const threshold = survivalThreshold(
          state.cols,
          state.willHouseWin,
          riggingBiasFor(state.rates, state.bet),
        );
        survive = Math.random() < threshold;
      }

      if (!survive) {
        // Their pick is the bomb. With (cols - 1) safe tiles per row, the
        // user's tile is the only bomb on this row — every other tile would
        // have been safe.
        state.bombs.set(r, [c]);
        state.picks[r] = c;
        state.failedRow = r;
        state.failed = true;
        try {
          await recordGame({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout: 0n,
            won: false,
            details: {
              failedRow: r,
              difficulty: state.difficulty,
              cols: state.cols,
            },
          });
          await logGamble({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout: 0n,
            won: false,
            detail: `fell at level ${r + 1} (${state.difficulty})`,
          });
          try {
            await btn.update({
              embeds: [
                buildEmbed(
                  `**BOOM: bomb on level ${r + 1}.** Lost ${formatCoins(state.bet)}.`,
                  0,
                ),
              ],
              components: buildRows(state, true),
            });
          } catch { /* ignore */ }
        } finally {
          endSession(interaction.user.id);
          collector.stop("explode");
        }
        return;
      }

      // Survived — pick a random one of the *other* tiles to record as the
      // (would-have-been) bomb for this row, since only 1 of cols is a bomb.
      state.picks[r] = c;
      const otherCols = Array.from({ length: state.cols }, (_, i) => i).filter(
        (x) => x !== c,
      );
      const bombCol = otherCols[Math.floor(Math.random() * otherCols.length)]!;
      state.bombs.set(r, [bombCol]);
      state.currentRow += 1;

      if (state.currentRow >= ROWS) {
        state.cashedOut = true;
        try {
          const mult = multiplierFor(ROWS, state.cols);
          const payout = BigInt(Math.floor(Number(state.bet) * mult));
          await adjustBalance(interaction.user.id, payout);
          await recordGame({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout,
            won: true,
            details: {
              level: ROWS,
              maxedOut: true,
              difficulty: state.difficulty,
              cols: state.cols,
            },
          });
          await logGamble({
            discordId: interaction.user.id,
            game: "towers",
            bet: state.bet,
            payout,
            won: true,
            detail: `topped the tower (${state.difficulty}, all ${ROWS} levels)`,
          });
          try {
            await btn.update({
              embeds: [
                buildEmbed(
                  `**Reached the top! Won ${formatCoins(payout)}.**`,
                  mult,
                ),
              ],
              components: buildRows(state, true),
            });
          } catch { /* ignore */ }
        } finally {
          endSession(interaction.user.id);
          collector.stop("topped");
        }
        return;
      }

      const mult = multiplierFor(state.currentRow, state.cols);
      await btn.update({
        embeds: [buildEmbed("Safe. Keep climbing or cash out.", mult)],
        components: [...buildRows(state, false), cashoutEnabled],
      });
    });

    collector.on("end", async (_c, reason) => {
      if (
        reason === "cashout" ||
        reason === "explode" ||
        reason === "topped"
      )
        return;
      if (!state.failed && !state.cashedOut) {
        await adjustBalance(interaction.user.id, state.bet);
        endSession(interaction.user.id);
        try {
          await message.edit({
            embeds: [
              buildEmbed(
                "Timed out. Bet refunded.",
                multiplierFor(state.currentRow, state.cols),
              ),
            ],
            components: buildRows(state, true),
          });
        } catch {
          /* ignore */
        }
      }
    });
  },
};

export default command;
