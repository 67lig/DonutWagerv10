import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { findUserByMinecraftUsername, getOrCreateUser, setVerified } from "../lib/db.js";
import { isOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("forceverify")
    .setDescription("Force-verify a user with a given Minecraft username (mod only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) =>
      o.setName("user").setDescription("User to verify").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("ign")
        .setDescription("Minecraft username to link")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(40),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(interaction)) {
      await interaction.reply({ content: "Owner only.", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const ign = interaction.options.getString("ign", true).trim();

    const conflict = await findUserByMinecraftUsername(ign);
    if (conflict && conflict.discord_id !== target.id) {
      await interaction.reply({
        content: `Cannot verify: \`${ign}\` is already linked to <@${conflict.discord_id}>.`,
        ephemeral: true,
      });
      return;
    }

    await getOrCreateUser(target.id);
    await setVerified(target.id, ign);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("User Verified")
          .addFields(
            { name: "User", value: `<@${target.id}>`, inline: true },
            { name: "IGN", value: `\`${ign}\``, inline: true },
            { name: "By", value: `<@${interaction.user.id}>`, inline: true },
          )
          .setTimestamp(),
      ],
    });
  },
};

export default command;
