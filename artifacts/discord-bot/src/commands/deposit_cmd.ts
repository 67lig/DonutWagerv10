import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordBalanceEvent } from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import { isModOrOwner } from "../lib/permissions.js";
import { logAdminAction } from "../lib/gamblelog.js";
import { DEPOSIT_LOG_CHANNEL_IDS } from "../lib/config.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deposit")
    .setDescription("Directly deposit coins into a user's account (owner only)")
    .setDefaultMemberPermissions(0n)
    .addUserOption((o) =>
      o.setName("user").setDescription("Target user").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount to deposit (e.g. 50m, 1.5b, 500k)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("note")
        .setDescription("Reason for the deposit (appears in payment logs)")
        .setRequired(false)
        .setMaxLength(200),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isModOrOwner(interaction)) {
      await interaction.reply({ content: "Staff only.", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const rawAmount = interaction.options.getString("amount", true);
    const note = interaction.options.getString("note") ?? null;
    const amount = parseAmount(rawAmount);

    if (amount === null || amount <= 0n) {
      await interaction.reply({
        content: "Invalid amount. Try `50m`, `1.5b`, `500k`.",
        ephemeral: true,
      });
      return;
    }

    await getOrCreateUser(target.id);
    const newBal = await adjustBalance(target.id, amount);

    await recordBalanceEvent({
      discordId: target.id,
      delta: amount,
      source: "deposit",
      detail: note
        ? `Direct deposit by ${interaction.user.tag}: ${note}`
        : `Direct deposit by ${interaction.user.tag}`,
    });

    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Direct Deposit",
      targetId: target.id,
      amount,
      detail: note
        ? `New balance: ${formatCoins(newBal)} | Note: ${note}`
        : `New balance: ${formatCoins(newBal)}`,
    });

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Deposit")
      .addFields(
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "New Balance", value: formatCoins(newBal), inline: true },
        { name: "By", value: `<@${interaction.user.id}>`, inline: true },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
      )
      .setFooter({ text: `Deposited by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });

    for (const channelId of DEPOSIT_LOG_CHANNEL_IDS) {
      try {
        const ch = await interaction.client.channels.fetch(channelId);
        if (ch?.isTextBased() && "send" in ch) {
          await (ch as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [embed] });
        }
      } catch { /* ignore */ }
    }
  },
};

export default command;
