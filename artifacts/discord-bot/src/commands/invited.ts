import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { getInviteList, getInviteStats, getNextClaimMin } from "../lib/invite_flow.js";
import { isOwner, isWithdrawStaff } from "../lib/permissions.js";

function statusIcon(row: {
  has_member_role: boolean;
  left_at: Date | null;
  claimed: boolean;
}): string {
  if (row.left_at !== null) return "❌";
  if (row.claimed) return "🏆";
  if (row.has_member_role) return "✅";
  return "⏳";
}

function statusLabel(row: {
  has_member_role: boolean;
  left_at: Date | null;
  claimed: boolean;
}): string {
  if (row.left_at !== null) return "Left";
  if (row.claimed) return "Claimed";
  if (row.has_member_role) return "Valid";
  return "Not Verified";
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("invited")
    .setDescription("Staff: view all members a user has invited")
    .addUserOption((o) =>
      o.setName("user").setDescription("User to look up").setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(interaction) && !isWithdrawStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);
    await interaction.deferReply({ ephemeral: true });

    const [list, stats] = await Promise.all([
      getInviteList(target.id),
      getInviteStats(target.id),
    ]);

    const nextMin = getNextClaimMin(stats.claimCount);

    if (list.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle(`🎟️ Invites — ${target.tag}`)
            .setDescription("This user has not invited anyone yet."),
        ],
      });
      return;
    }

    const lines = list.map((row) => {
      const icon = statusIcon(row);
      const label = statusLabel(row);
      const ts = Math.floor(new Date(row.joined_at).getTime() / 1000);
      return `${icon} <@${row.invitee_discord_id}> — **${label}** · joined <t:${ts}:R>`;
    });

    // Split into chunks of 20 to stay within embed description limit
    const chunkSize = 20;
    const chunks: string[][] = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      chunks.push(lines.slice(i, i + chunkSize));
    }

    const firstEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`🎟️ Invites — ${target.tag}`)
      .setDescription(chunks[0]!.join("\n"))
      .addFields(
        { name: "📨 Total", value: `${stats.totalInvited}`, inline: true },
        {
          name: "✅ Valid Unclaimed",
          value:
            stats.claimedAndLeft > 0
              ? `${stats.validUnclaimed - stats.claimedAndLeft} (${stats.validUnclaimed} − ${stats.claimedAndLeft} deducted)`
              : `${stats.validUnclaimed}`,
          inline: true,
        },
        { name: "⏳ Not Verified", value: `${stats.notVerified}`, inline: true },
        { name: "❌ Left", value: `${stats.leftServer}`, inline: true },
        { name: "🏆 Total Claimed", value: `${stats.totalClaimed}`, inline: true },
        ...(stats.claimedAndLeft > 0
          ? [
              {
                name: "⚠️ Deducted",
                value: `-${stats.claimedAndLeft} (claimed, now left)`,
                inline: true,
              },
            ]
          : []),
        {
          name: "🎯 Next Claim Needs",
          value: `${nextMin} net valid`,
          inline: true,
        },
      )
      .setFooter({
        text: "✅ Valid  ⏳ Not Verified  ❌ Left  🏆 Claimed  ⚠️ Deducted",
      });

    const embeds = [firstEmbed];
    for (let i = 1; i < chunks.length; i++) {
      embeds.push(
        new EmbedBuilder()
          .setColor(0x3b82f6)
          .setDescription(chunks[i]!.join("\n")),
      );
    }

    await interaction.editReply({ embeds });
  },
};

export default command;
