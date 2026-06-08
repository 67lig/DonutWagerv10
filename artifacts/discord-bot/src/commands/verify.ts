import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { findUserByMinecraftUsername, getOrCreateUser } from "../lib/db.js";
import { createTicketChannel } from "../lib/tickets.js";
import { JAVA_IGN_REGEX, lookupJavaProfile } from "../lib/mojang.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link your Java Edition Minecraft account to start playing")
    .addStringOption((o) =>
      o
        .setName("minecraft")
        .setDescription("Your Java Edition username (e.g. Notch)")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(16),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const ign = interaction.options.getString("minecraft", true).trim();

    if (!JAVA_IGN_REGEX.test(ign)) {
      await interaction.reply({
        content: "Invalid username. Java Edition usernames are 3-16 characters: letters, numbers, and underscores only.",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.guild) {
      await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const user = await getOrCreateUser(interaction.user.id);
    if (user.verified && user.minecraft_username) {
      await interaction.editReply({
        content: `You are already verified as \`${user.minecraft_username}\`. Contact a moderator if you need to change your linked account.`,
      });
      return;
    }

    const conflict = await findUserByMinecraftUsername(ign);
    if (conflict && conflict.discord_id !== interaction.user.id) {
      await interaction.editReply({
        content: "That Minecraft account is already linked to another Discord user. Contact a moderator if this is a mistake.",
      });
      return;
    }

    // Validate against Mojang — Bedrock accounts have no Java UUID and will return null
    const profile = await lookupJavaProfile(ign);
    if (!profile) {
      await interaction.editReply({
        content: `No Java Edition account found for **${ign}**. Make sure the spelling is exact. Bedrock accounts cannot be linked.`,
      });
      return;
    }

    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: "verify",
      topic: `Linking ticket - Java: ${profile.name}`,
      allowAttachments: true,
    });
    if (!ticket) {
      await interaction.editReply({
        content: "Couldn't create the linking ticket. Make sure the bot has **Manage Channels** permission.",
      });
      return;
    }

    const discordTs = Math.floor(interaction.user.createdTimestamp / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Account Linking Request")
      .setDescription(
        `<@${interaction.user.id}> wants to link Java account **${profile.name}**.\n\nA staff member will verify ownership in-game on DonutSMP and approve below.`,
      )
      .addFields(
        { name: "Minecraft", value: `\`${profile.name}\``, inline: true },
        { name: "UUID", value: `\`${profile.id}\``, inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        {
          name: "Discord Account Age",
          value: `Created <t:${discordTs}:D> (<t:${discordTs}:R>)`,
          inline: false,
        },
      )
      .setThumbnail(`https://mc-heads.net/avatar/${profile.id}/128`)
      .setFooter({ text: "Mods: confirm in-game ownership, then click Approve." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify:approve:${interaction.user.id}:${profile.name}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`verify:deny:${interaction.user.id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const mention = ticket.modRoleId
      ? `<@${interaction.user.id}> · <@&${ticket.modRoleId}>`
      : `<@${interaction.user.id}>`;
    await ticket.channel.send({ content: mention, embeds: [embed], components: [row] });

    await interaction.editReply({
      content: `Linking ticket created: <#${ticket.channel.id}>\nA staff member will confirm your account in-game on DonutSMP. Make sure you are online and reachable.`,
    });
  },
};

export default command;
