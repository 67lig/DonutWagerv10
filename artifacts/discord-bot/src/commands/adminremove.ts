import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { clearRig } from "../lib/rig.js";
import { OWNER_IDS } from "../lib/owners.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("adminremove")
    .setDescription(".")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) =>
      o.setName("user").setDescription(".").setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!OWNER_IDS.has(interaction.user.id)) {
      await interaction.editReply({ content: "Unknown command." });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const removed = await clearRig(target.id);
    await interaction.editReply({
      content: removed
        ? `✅ <@${target.id}> — rig removed.`
        : `ℹ️ <@${target.id}> had no active rig.`,
    });
  },
};

export default command;
