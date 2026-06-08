import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { requireVerified } from "../lib/guards.js";
import { getConfig } from "../lib/db.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Submit your payment screenshot inside a deposit ticket")
    .addAttachmentOption((o) =>
      o
        .setName("screenshot")
        .setDescription("Screenshot of your payment")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("notes")
        .setDescription("Any additional notes (txid, sender name, etc.)")
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const verified = await requireVerified(interaction);
    if (!verified) return;

    if (!interaction.channel || !("name" in interaction.channel) || !interaction.channel.name) {
      await interaction.reply({
        content: "Use this inside your deposit ticket channel.",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.channel.name.startsWith("deposit-")) {
      await interaction.reply({
        content:
          "This command can only be used inside your deposit ticket. Run `/deposit` first.",
        ephemeral: true,
      });
      return;
    }

    const attachment = interaction.options.getAttachment("screenshot", true);
    const notes = interaction.options.getString("notes");

    if (!attachment.contentType?.startsWith("image/")) {
      await interaction.reply({
        content: "The screenshot must be an image.",
        ephemeral: true,
      });
      return;
    }

    const modRoleId = await getConfig("mod_role_id");

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle("📸 Payment Proof Submitted")
      .setDescription(
        `<@${interaction.user.id}> has submitted payment proof. A moderator will verify and approve.`,
      )
      .setImage(attachment.url)
      .setFooter({
        text: "Mods: use /admin approve <user> <amount> to credit, or /admin deny <user> <reason>.",
      });

    if (notes) embed.addFields({ name: "Notes", value: notes });

    await interaction.reply({
      content: modRoleId ? `<@&${modRoleId}> new payment proof` : undefined,
      embeds: [embed],
    });
  },
};

export default command;
