import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { getOrCreateUser, executePayment, getDailyPaySent } from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import { logPayAction } from "../lib/gamblelog.js";

const PAY_MIN = 1n;
const PAY_MAX = 50_000_000n;
const PAY_DAILY_LIMIT = 50_000_000n;

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Send coins to another player")
    .addUserOption((o) =>
      o
        .setName("user")
        .setDescription("The player to pay")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount to send (e.g. 1m, 500k, 50m)")
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser("user", true);
    const rawAmount = interaction.options.getString("amount", true).trim();

    if (target.id === interaction.user.id) {
      await interaction.reply({ content: "You cannot pay yourself.", ephemeral: true });
      return;
    }
    if (target.bot) {
      await interaction.reply({ content: "You cannot pay a bot.", ephemeral: true });
      return;
    }

    const amount = parseAmount(rawAmount);
    if (!amount || amount < PAY_MIN) {
      await interaction.reply({
        content: `Minimum payment is ${formatCoins(PAY_MIN)}.`,
        ephemeral: true,
      });
      return;
    }
    if (amount > PAY_MAX) {
      await interaction.reply({
        content: `Maximum payment per transaction is ${formatCoins(PAY_MAX)}.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Pre-check daily limit so we can give a clear error with remaining amount.
    const dailySent = await getDailyPaySent(interaction.user.id);
    const remaining = PAY_DAILY_LIMIT - dailySent;
    if (remaining <= 0n) {
      await interaction.editReply({
        content: `You have reached your daily pay limit of ${formatCoins(PAY_DAILY_LIMIT)}. Try again tomorrow.`,
      });
      return;
    }
    if (dailySent + amount > PAY_DAILY_LIMIT) {
      await interaction.editReply({
        content: `You can only send ${formatCoins(remaining)} more today (daily limit: ${formatCoins(PAY_DAILY_LIMIT)}).`,
      });
      return;
    }

    // Ensure sender exists in DB.
    await getOrCreateUser(interaction.user.id);

    const result = await executePayment(interaction.user.id, target.id, amount);

    if (!result.ok) {
      if (result.reason === "insufficient_funds") {
        await interaction.editReply({ content: "You do not have enough coins to send that amount." });
        return;
      }
      if (result.reason === "daily_limit") {
        await interaction.editReply({
          content: `Daily pay limit of ${formatCoins(PAY_DAILY_LIMIT)} reached. Try again tomorrow.`,
        });
        return;
      }
      await interaction.editReply({ content: "Payment failed. Please try again." });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x6b7280)
      .setTitle("Payment Sent")
      .addFields(
        { name: "From", value: `<@${interaction.user.id}>`, inline: true },
        { name: "To", value: `<@${target.id}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "Your Balance", value: formatCoins(result.senderBalance), inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Log to pay log channel.
    void logPayAction({
      senderId: interaction.user.id,
      senderTag: interaction.user.tag,
      receiverId: target.id,
      receiverTag: target.tag,
      amount,
      senderBalance: result.senderBalance,
    });
  },
};

export default command;
