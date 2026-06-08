import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { isOwner } from "../lib/permissions.js";

const START_TIME = Date.now();

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Check how long the bot has been running (admin only)"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(interaction)) {
      await interaction.reply({ content: "You don't have permission to use this.", ephemeral: true });
      return;
    }

    const uptime = Date.now() - START_TIME;
    const startedAt = Math.floor(START_TIME / 1000);

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Bot Uptime")
      .addFields(
        { name: "Uptime", value: formatUptime(uptime), inline: true },
        { name: "Started", value: `<t:${startedAt}:R>`, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default command;
