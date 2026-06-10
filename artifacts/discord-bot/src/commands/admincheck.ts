import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getRigRow } from "../lib/rig.js";
import { isOwnerById } from "../lib/owners.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admincheck")
    .setDescription(".")
    .setDefaultMemberPermissions(0n)
    .addUserOption((o) =>
      o.setName("user").setDescription(".").setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!isOwnerById(interaction.user.id)) {
      await interaction.editReply({ content: "Unknown command." });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const rig = await getRigRow(target.id);

    let status: string;
    let color: number;

    if (!rig) {
      status = "No active rig.";
      color = 0x6b7280;
    } else if (rig.mode === "next_loss") {
      status = "⚠️ **Next game forced loss** (one-shot)";
      color = 0xef4444;
    } else {
      status = `🟢 **${rig.value}% win rate** (persistent)`;
      color = 0x22c55e;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`Rig Status: ${target.username}`)
      .setDescription(status)
      .setThumbnail(target.displayAvatarURL());

    await interaction.editReply({ embeds: [embed] });
  },
};

export default command;
