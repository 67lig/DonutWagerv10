import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreateUser, setBalance, recordBalanceEvent } from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import { isModOrOwner } from "../lib/permissions.js";
import { logAdminAction } from "../lib/gamblelog.js";
import { DEPOSIT_LOG_CHANNEL_IDS } from "../lib/config.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("setbalance")
    .setDescription("Set a user's balance (owner only)")
    .setDefaultMemberPermissions(0n)
    .addUserOption((o) =>
      o.setName("user").setDescription("Target user").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("amount")
        .setDescription("New balance (e.g. 50m, 1.5b, 500k)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("note")
        .setDescription("Reason for the change (appears in payment logs)")
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

    if (amount === null || amount < 0n) {
      await interaction.reply({
        content: "Invalid amount. Try `50m`, `1.5b`, `500k`.",
        ephemeral: true,
      });
      return;
    }

    const existing = await getOrCreateUser(target.id);
    const oldBal = BigInt(existing.balance);
    const delta = amount - oldBal;

    await setBalance(target.id, amount);

    const logDetail = note
      ? `Old: ${formatCoins(oldBal)} | Note: ${note}`
      : `Old: ${formatCoins(oldBal)}`;

    if (delta !== 0n) {
      await recordBalanceEvent({
        discordId: target.id,
        delta,
        source: "admin",
        detail: note
          ? `Balance set by ${interaction.user.tag}: ${note}`
          : `Balance set by ${interaction.user.tag}`,
      });
    }

    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Balance Set",
      targetId: target.id,
      amount,
      detail: logDetail,
    });

    const paylogEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle("Balance Set")
      .addFields(
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "New Balance", value: formatCoins(amount), inline: true },
        { name: "Old Balance", value: formatCoins(oldBal), inline: true },
        { name: "By", value: `<@${interaction.user.id}>`, inline: true },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
      )
      .setFooter({ text: `Set by ${interaction.user.tag}` })
      .setTimestamp();
    for (const chId of DEPOSIT_LOG_CHANNEL_IDS) {
      try {
        const ch = await interaction.client.channels.fetch(chId);
        if (ch?.isTextBased() && "send" in ch) {
          await (ch as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [paylogEmbed] });
        }
      } catch { /* ignore */ }
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Balance Set")
          .addFields(
            { name: "User", value: `<@${target.id}>`, inline: true },
            { name: "New Balance", value: formatCoins(amount), inline: true },
            { name: "Previous", value: formatCoins(oldBal), inline: true },
            ...(note ? [{ name: "Note", value: note, inline: false }] : []),
          )
          .setFooter({ text: `Set by ${interaction.user.tag}` })
          .setTimestamp(),
      ],
      ephemeral: true,
    });
  },
};

export default command;
