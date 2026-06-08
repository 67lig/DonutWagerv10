import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import {
  getInviteConfig,
  getInviteStats,
  getNextClaimMin,
  refreshInviteeMemberRoles,
} from "../lib/invite_flow.js";
import { formatCoins, formatCoinsShort } from "../lib/format.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("invites")
    .setDescription("View your invite stats and claim your coin rewards"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Re-sync member roles before computing stats so manually-granted roles
    // are always reflected even if the bot missed the roleUpdate event.
    if (interaction.guild) {
      // 3-second hard cap — if REST fetches stall, proceed with cached DB data
      await Promise.race([
        refreshInviteeMemberRoles(interaction.guild, interaction.user.id),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => null);
    }

    const [stats, cfg] = await Promise.all([
      getInviteStats(interaction.user.id),
      getInviteConfig(),
    ]);

    const nextMin = getNextClaimMin(stats.claimCount, cfg.claimTiers);
    const netValid = stats.validUnclaimed - stats.claimedAndLeft;
    const canClaim = netValid >= nextMin;
    const coinsNow = cfg.coinsPerInvite * BigInt(Math.max(0, netValid));
    const needMore = nextMin - netValid;

    const statusLine = canClaim
      ? "✅ Ready to claim!"
      : `❌ Need ${needMore} more valid invite${needMore !== 1 ? "s" : ""}`;

    const netValidDisplay =
      stats.claimedAndLeft > 0
        ? `${netValid} (${stats.validUnclaimed} − ${stats.claimedAndLeft} deducted)`
        : `${stats.validUnclaimed}`;

    const rejoinedValue = stats.totalRejoined > 0
      ? `${stats.totalRejoined} total · ${stats.rejoinedRecently} excluded (<7d ago)`
      : "0";

    const fields: { name: string; value: string; inline: boolean }[] = [
      // Row 1 — 3 inline
      { name: "📨 Total Invited",  value: `${stats.totalInvited}`, inline: true },
      { name: "✅ Valid Unclaimed", value: netValidDisplay,          inline: true },
      { name: "❌ Left Server",     value: `${stats.leftServer}`,    inline: true },
      // Row 2 — 3 inline
      { name: "⏳ Not Verified",    value: `${stats.notVerified}`,   inline: true },
      {
        name: "🏆 Total Claimed",
        value: `${stats.totalClaimed} invite${stats.totalClaimed !== 1 ? "s" : ""}`,
        inline: true,
      },
      { name: "🎯 Next Claim Needs", value: `${nextMin} net valid`, inline: true },
      // Row 3 — 3 inline (fake + rejoined + spacer)
      {
        name: "🚫 Fake Accounts",
        value: stats.fakeAccounts > 0 ? `${stats.fakeAccounts} excluded` : "0",
        inline: true,
      },
      {
        name: "🔄 Rejoined",
        value: rejoinedValue,
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: true },
    ];

    if (stats.claimedAndLeft > 0) {
      fields.push({
        name: "⚠️ Deducted (claimed, now left)",
        value: `-${stats.claimedAndLeft}. Earn ${stats.claimedAndLeft} extra invite${stats.claimedAndLeft !== 1 ? "s" : ""} to offset`,
        inline: false,
      });
    }

    fields.push(
      { name: "📊 Status", value: statusLine, inline: false },
      {
        name: "💰 Claimable Now",
        value: canClaim
          ? `${formatCoins(coinsNow)} (${netValid} invites × ${formatCoinsShort(cfg.coinsPerInvite)} per invite)`
          : `Reach ${nextMin} net valid invites to unlock`,
        inline: false,
      },
    );

    const tierStr = cfg.claimTiers.join(" → ");
    const embed = new EmbedBuilder()
      .setColor(canClaim ? 0x22c55e : 0xfacc15)
      .setTitle("🎟️ Your Invite Stats")
      .addFields(...fields)
      .setFooter({
        text: `Not Verified = joined but hasn't verified yet  •  Earn ${formatCoinsShort(cfg.coinsPerInvite)} per valid invite  •  Milestones: ${tierStr}`,
      });

    if (canClaim) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("invite:claim")
          .setLabel("Claim Reward")
          .setStyle(ButtonStyle.Success),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  },
};

export default command;
