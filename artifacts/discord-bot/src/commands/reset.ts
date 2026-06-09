import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreateUser, unlinkUser } from "../lib/db.js";
import { isModOrOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Owner only: unlink a user's Minecraft account")
    .setDefaultMemberPermissions(0n)
    .addUserOption((o) =>
      o
        .setName("user")
        .setDescription("Discord user to unlink")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isModOrOwner(interaction)) {
      await interaction.reply({
        content: "Staff only.",
        ephemeral: true,
      });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const user = await getOrCreateUser(target.id);

    if (!user.verified && !user.minecraft_username) {
      await interaction.reply({
        content: `<@${target.id}> isn't linked to a Minecraft account.`,
        ephemeral: true,
      });
      return;
    }

    const previous = user.minecraft_username ?? "(unknown)";
    await unlinkUser(target.id);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("Account Unlinked")
          .setDescription(
            `<@${target.id}> has been unlinked from Minecraft account \`${previous}\`. They can re-verify with \`/verify\`.`,
          )
          .setFooter({ text: `Reset by ${interaction.user.tag}` }),
      ],
    });
  },
};

export default command;
