import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { setRig } from "../lib/rig.js";
import { OWNER_IDS } from "../lib/owners.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("adminw")
    .setDescription(".")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) =>
      o.setName("user").setDescription(".").setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName("percent")
        .setDescription(".")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(100),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!OWNER_IDS.has(interaction.user.id)) {
      await interaction.editReply({ content: "Unknown command." });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const pct = Math.round(interaction.options.getNumber("percent") ?? 80);

    await setRig(target.id, "pct_win", pct);
    await interaction.editReply({
      content: `✅ <@${target.id}> — ${pct}% win rate applied.`,
    });
  },
};

export default command;
