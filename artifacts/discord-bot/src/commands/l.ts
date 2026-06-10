import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { clearRig, setRig } from "../lib/rig.js";
import { isOwnerById } from "../lib/owners.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("adminl")
    .setDescription(".")
    .setDefaultMemberPermissions(0n)
    .addSubcommand((sub) =>
      sub
        .setName("next")
        .setDescription(".")
        .addUserOption((o) =>
          o.setName("user").setDescription(".").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription(".")
        .addUserOption((o) =>
          o.setName("user").setDescription(".").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription(".")
        .addUserOption((o) =>
          o.setName("user").setDescription(".").setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!isOwnerById(interaction.user.id)) {
      await interaction.editReply({ content: "Unknown command." });
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    const target = interaction.options.getUser("user", true);

    if (sub === "next") {
      await setRig(target.id, "next_loss");
      await interaction.editReply({
        content: `✅ <@${target.id}>: next game will lose.`,
      });
      return;
    }

    if (sub === "add") {
      await setRig(target.id, "pct_win", 20);
      await interaction.editReply({
        content: `✅ <@${target.id}>: 20% win rate applied.`,
      });
      return;
    }

    if (sub === "remove") {
      const removed = await clearRig(target.id);
      await interaction.editReply({
        content: removed
          ? `✅ <@${target.id}>: rig removed.`
          : `ℹ️ <@${target.id}> had no active rig.`,
      });
    }
  },
};

export default command;
