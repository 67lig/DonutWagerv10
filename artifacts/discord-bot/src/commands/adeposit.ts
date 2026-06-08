import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordBalanceEvent } from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import { isOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";
import { CHANNELS } from "../lib/config.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("adeposit")
    .setDescription("Deposit coins into a user's balance")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) =>
      o.setName("user").setDescription("User to deposit to").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount to deposit (e.g. 10m, 500k, 1bil)")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(interaction)) {
      await interaction.reply({ content: "Bot owner only.", ephemeral: true });
      return;
    }
    const target = interaction.options.getUser("user", true);
    const rawAmount = interaction.options.getString("amount", true);
    const amount = parseAmount(rawAmount);
    if (!amount || amount <= 0n) {
      await interaction.reply({
        content: "Invalid amount. Try `10m`, `500k`, `1bil`, or a plain number.",
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
      detail: "deposit",
    });
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("💰 Deposit")
      .addFields(
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "New Balance", value: formatCoins(newBal), inline: true },
        { name: "By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Deposited by ${interaction.user.tag}` });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    try {
      const logChannel = await interaction.client.channels.fetch(CHANNELS.WITHDRAW_LOG);
      if (logChannel?.isTextBased() && "send" in logChannel) {
        await (logChannel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [embed] });
      }
    } catch {
      /* ignore */
    }
  },
};

export default command;
