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
      o.setName("user").setDescription("The player to pay").setRequired(true),
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
        content: `Maximum payment is ${formatCoins(PAY_MAX)} per transaction.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sender = await getOrCreateUser(interaction.user.id);

    // Block payments while the sender has an active wager requirement.
    // This prevents bonus/coupon coins from being laundered to friends
    // who can then withdraw them without wagering.
    const wagerReq = BigInt(sender.wager_requirement);
    if (wagerReq > 0n) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle("Payment Blocked")
            .setDescription(
              `You have a wager requirement of **${formatCoins(wagerReq)}** remaining.\n` +
              `You must wager that amount before you can pay other players.`,
            )
            .setTimestamp(),
        ],
      });
      return;
    }

    // Pre-check daily limit to give a precise remaining-amount message.
    const dailySent = await getDailyPaySent(interaction.user.id);
    const remaining = PAY_DAILY_LIMIT - dailySent;
    if (remaining <= 0n) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle("Daily Limit Reached")
            .setDescription(
              `You have reached the daily pay limit of **${formatCoins(PAY_DAILY_LIMIT)}**.\nTry again tomorrow.`,
            )
            .setTimestamp(),
        ],
      });
      return;
    }
    if (dailySent + amount > PAY_DAILY_LIMIT) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle("Daily Limit")
            .setDescription(
              `You can only send **${formatCoins(remaining)}** more today.\nDaily limit: ${formatCoins(PAY_DAILY_LIMIT)}.`,
            )
            .setTimestamp(),
        ],
      });
      return;
    }

    const result = await executePayment(interaction.user.id, target.id, amount);

    if (!result.ok) {
      const msg =
        result.reason === "insufficient_funds"
          ? "You do not have enough coins to send that amount."
          : result.reason === "daily_limit"
          ? `Daily pay limit of ${formatCoins(PAY_DAILY_LIMIT)} reached. Try again tomorrow.`
          : result.reason === "wager_required"
          ? `You must clear your wager requirement before paying others.`
          : "Payment failed. Please try again.";
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x6b7280)
            .setTitle("Payment Failed")
            .setDescription(msg)
            .setTimestamp(),
        ],
      });
      return;
    }

    const newDailySent = dailySent + amount;
    const newRemaining = PAY_DAILY_LIMIT - newDailySent;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x6b7280)
          .setTitle("Payment Sent")
          .addFields(
            { name: "Recipient", value: `<@${target.id}>`, inline: true },
            { name: "Amount", value: formatCoins(amount), inline: true },
            { name: "\u200b", value: "\u200b", inline: true },
            { name: "Your Balance", value: formatCoins(result.senderBalance), inline: true },
            {
              name: "Daily Limit Remaining",
              value: `${formatCoins(newRemaining)} of ${formatCoins(PAY_DAILY_LIMIT)}`,
              inline: true,
            },
          )
          .setTimestamp(),
      ],
    });

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
