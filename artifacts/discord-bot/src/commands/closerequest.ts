import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { cancelPendingDepositByChannel, getConfig } from "../lib/db.js";
import { isTicketChannelName } from "../lib/tickets.js";

export const CLOSE_REQ_BTN_PREFIX = "closereq";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("closerequest")
    .setDescription("Request staff to close the current ticket"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      !interaction.channel ||
      !("name" in interaction.channel) ||
      !interaction.channel.name
    ) {
      await interaction.reply({ content: "Not a ticket channel.", ephemeral: true });
      return;
    }

    const name = interaction.channel.name;
    if (!isTicketChannelName(name)) {
      await interaction.reply({
        content: "This command can only be used inside a ticket channel.",
        ephemeral: true,
      });
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CLOSE_REQ_BTN_PREFIX}:accept:${interaction.channelId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CLOSE_REQ_BTN_PREFIX}:deny:${interaction.channelId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Close Request")
          .setDescription(
            `<@${interaction.user.id}> is requesting to close this ticket.\nA staff member can accept or deny below.`,
          )
          .setTimestamp(),
      ],
      components: [row],
    });
  },
};

export async function handleCloseRequestButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  const modRoleId = await getConfig("mod_role_id");
  const member = interaction.member;
  const isMod =
    modRoleId &&
    member &&
    "roles" in member &&
    typeof member.roles !== "string" &&
    "cache" in member.roles &&
    member.roles.cache.has(modRoleId);
  const hasManage =
    member?.permissions &&
    typeof member.permissions !== "string" &&
    member.permissions.has(PermissionFlagsBits.ManageChannels);

  if (!isMod && !hasManage) {
    await interaction.reply({
      content: "Only staff can accept or deny close requests.",
      ephemeral: true,
    });
    return;
  }

  if (action === "deny") {
    await interaction.message.delete().catch(() => null);
    await interaction.reply({ content: "Close request denied.", ephemeral: true });
    return;
  }

  if (action === "accept") {
    if (!interaction.channel || !("name" in interaction.channel)) {
      await interaction.reply({ content: "Channel not found.", ephemeral: true });
      return;
    }
    const name = (interaction.channel as { name: string }).name;
    if (name.startsWith("deposit-")) {
      await cancelPendingDepositByChannel(interaction.channelId);
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Closing Ticket")
          .setDescription("This channel will be deleted in 5 seconds."),
      ],
    });
    setTimeout(() => {
      if (interaction.channel && "delete" in interaction.channel) {
        (interaction.channel as { delete: () => Promise<unknown> })
          .delete()
          .catch(() => {});
      }
    }, 5000);
  }
}

export default command;
