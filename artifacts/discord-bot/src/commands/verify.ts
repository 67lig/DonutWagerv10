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

const BEDROCK_IGN_REGEX = /^.{1,64}$/;

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link your Minecraft account to start playing")
    .addStringOption((o) =>
      o
        .setName("edition")
        .setDescription("Java Edition or Bedrock Edition?")
        .setRequired(true)
        .addChoices(
          { name: "Java Edition", value: "java" },
          { name: "Bedrock Edition", value: "bedrock" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("minecraft")
        .setDescription("Your Minecraft username (e.g. Notch or .Player123)")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(64),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const edition = interaction.options.getString("edition", true) as "java" | "bedrock";
    const ign = interaction.options.getString("minecraft", true).trim();

    if (!interaction.guild) {
      await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
      return;
    }

    // Validate IGN format
    const regex = edition === "java" ? JAVA_IGN_REGEX : BEDROCK_IGN_REGEX;
    if (!regex.test(ign)) {
      const hint =
        edition === "java"
          ? "Java Edition usernames are 3–16 characters: letters, numbers, and underscores only."
          : "Bedrock Edition usernames are 3–16 characters: letters, numbers, underscores, and spaces only.";
      await interaction.reply({ content: `Invalid username. ${hint}`, ephemeral: true });
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
        content:
          "That Minecraft account is already linked to another Discord user. Contact a moderator if this is a mistake.",
      });
      return;
    }

    // ── Java: validate against Mojang ────────────────────────────────────────
    let resolvedName = ign;
    let uuid: string | null = null;

    if (edition === "java") {
      const profile = await lookupJavaProfile(ign);
      if (!profile) {
        await interaction.editReply({
          content: `No Java Edition account found for **${ign}**. Make sure the spelling is exact.`,
        });
        return;
      }
      resolvedName = profile.name;
      uuid = profile.id;
    }

    // ── Create ticket ─────────────────────────────────────────────────────────
    const editionLabel = edition === "java" ? "Java" : "Bedrock";
    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: "verify",
      topic: `Linking ticket - ${editionLabel}: ${resolvedName}`,
      allowAttachments: true,
    });
    if (!ticket) {
      await interaction.editReply({
        content:
          "Couldn't create the linking ticket. Make sure the bot has **Manage Channels** permission.",
      });
      return;
    }

    const discordTs = Math.floor(interaction.user.createdTimestamp / 1000);

    const embed = new EmbedBuilder()
      .setColor(edition === "java" ? 0x22c55e : 0x3b82f6)
      .setTitle("Account Linking Request")
      .setDescription(
        `<@${interaction.user.id}> wants to link their **${editionLabel} Edition** account **${resolvedName}**.\n\nA staff member will verify ownership in-game on DonutSMP and approve below.`,
      )
      .addFields(
        { name: "Edition", value: `${editionLabel} Edition`, inline: true },
        { name: "Minecraft IGN", value: `\`${resolvedName}\``, inline: true },
        ...(uuid ? [{ name: "UUID", value: `\`${uuid}\``, inline: true }] : [{ name: "\u200b", value: "\u200b", inline: true }]),
        {
          name: "Discord Account Age",
          value: `Created <t:${discordTs}:D> (<t:${discordTs}:R>)`,
          inline: false,
        },
      )
      .setFooter({ text: "Mods: confirm in-game ownership, then click Approve." });

    if (uuid) {
      embed.setThumbnail(`https://mc-heads.net/avatar/${uuid}/128`);
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify:approve:${interaction.user.id}:${resolvedName}`)
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
