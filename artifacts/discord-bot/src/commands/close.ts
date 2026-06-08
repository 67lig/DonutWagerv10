import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { cancelPendingDepositByChannel, getConfig } from "../lib/db.js";
import { isPaidTicketName, isTicketChannelName } from "../lib/tickets.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket channel"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.channel || !("name" in interaction.channel) || !interaction.channel.name) {
      await interaction.reply({
        content: "Not a ticket channel.",
        ephemeral: true,
      });
      return;
    }
    const name = interaction.channel.name;
    if (!isTicketChannelName(name)) {
      await interaction.reply({
        content: "This isn't a ticket channel.",
        ephemeral: true,
      });
      return;
    }

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

    // Invite claim tickets are always staff-only to close — protects the audit trail.
    if (name.startsWith("invite-") && !isMod && !hasManage) {
      await interaction.reply({
        content: "Invite claim tickets can only be closed by a moderator.",
        ephemeral: true,
      });
      return;
    }

    // Withdrawal tickets that have been paid out are mod-only to close so the
    // payout receipt + vouch trail can't be deleted by the customer.
    if (isPaidTicketName(name) && !isMod && !hasManage) {
      await interaction.reply({
        content:
          "This payout ticket can only be closed by a moderator now that the withdrawal is complete.",
        ephemeral: true,
      });
      return;
    }

    if (!isMod && !hasManage) {
      // Allow user to close their own ticket (channel name embeds username slug).
      if (!name.includes(interaction.user.username.toLowerCase())) {
        await interaction.reply({
          content: "Only staff or the ticket owner can close this.",
          ephemeral: true,
        });
        return;
      }
    }

    // If it's a deposit ticket, cancel the pending deposit record.
    if (name.startsWith("deposit-")) {
      await cancelPendingDepositByChannel(interaction.channelId);
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("Closing Ticket")
          .setDescription("This channel will be deleted in 5 seconds."),
      ],
    });

    setTimeout(() => {
      if (interaction.channel && "delete" in interaction.channel) {
        interaction.channel.delete().catch(() => {});
      }
    }, 5000);
  },
};

export default command;
