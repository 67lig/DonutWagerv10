import { randomInt } from "node:crypto";
import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordGame } from "../lib/db.js";
import { formatCoins } from "../lib/format.js";
import { antiSpam, requireVerified, resolveBet } from "../lib/guards.js";
import { logGamble } from "../lib/gamblelog.js";
import { checkRig } from "../lib/rig.js";
import { getHouseRates, shouldHouseWin } from "../lib/houserates.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Bet on a coin flip — heads or tails (50/50)")
    .addStringOption((o) =>
      o
        .setName("side")
        .setDescription("Heads or Tails")
        .setRequired(true)
        .addChoices(
          { name: "Heads", value: "heads" },
          { name: "Tails", value: "tails" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("bet")
        .setDescription("Amount to bet (e.g. 100, 1k, all)")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!antiSpam(interaction.user.id)) {
      await interaction.reply({
        content: "Slow down — wait a moment between commands.",
        ephemeral: true,
      });
      return;
    }
    const verified = await requireVerified(interaction);
    if (!verified) return;

    const side = interaction.options.getString("side", true);
    const rawBet = interaction.options.getString("bet", true);
    const user = await getOrCreateUser(interaction.user.id);
    const bet = await resolveBet(interaction, user, rawBet);
    if (!bet) return;

    const rigResult = await checkRig(interaction.user.id);
    const rates = await getHouseRates();
    await adjustBalance(interaction.user.id, -bet);

    const won = rigResult.active && rigResult.forceLoss
      ? false
      : rigResult.active && rigResult.forceWin
        ? true
        : !shouldHouseWin(rates, bet);
    const result = won ? side : side === "heads" ? "tails" : "heads";

    void randomInt(0, 1_000_000);

    const payout = won ? bet * 2n : 0n;
    if (payout > 0n) await adjustBalance(interaction.user.id, payout);

    await recordGame({
      discordId: interaction.user.id,
      game: "coinflip",
      bet,
      payout,
      won,
      details: { side, result },
    });
    await logGamble({
      discordId: interaction.user.id,
      game: "coinflip",
      bet,
      payout,
      won,
      detail: `picked ${side}, got ${result}`,
    });

    const after = await getOrCreateUser(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(won ? 0x22c55e : 0xef4444)
      .setTitle(`🪙 Coinflip — ${result.toUpperCase()}`)
      .setDescription(
        won
          ? `**You won ${formatCoins(payout - bet)}!**\nYour balance: ${formatCoins(BigInt(after.balance))}`
          : `**You lost ${formatCoins(bet)}.**\nYour balance: ${formatCoins(BigInt(after.balance))}`,
      )
      .addFields(
        { name: "Picked", value: side, inline: true },
        { name: "Result", value: result, inline: true },
        { name: "Odds", value: "50/50", inline: true },
        { name: "Bet", value: formatCoins(bet), inline: true },
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default command;