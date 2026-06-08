import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getBalanceHistory, getGameHistory } from "../lib/db.js";
import { formatCoinsShort } from "../lib/format.js";
import { isOwner, isWithdrawStaff } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";

const SOURCE_LABEL: Record<string, string> = {
  coupon: "🎟️ Coupon",
  daily: "🎁 Daily",
  admin: "🛠️ Admin",
  deposit: "📥 Deposit",
  invite: "🎟️ Invite Reward",
  withdraw: "📤 Withdraw",
  irlwithdraw: "💵 IRL Sale",
};

function formatTime(d: Date): string {
  const t = Math.floor(new Date(d).getTime() / 1000);
  return `<t:${t}:R>`;
}

function formatDelta(deltaStr: string): string {
  const n = BigInt(deltaStr);
  if (n >= 0n) return `+${formatCoinsShort(n)}`;
  return `-${formatCoinsShort(-n)}`;
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Staff: view a user's recent balance changes or game results")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName("balance")
        .setDescription("Where the coins came from / went (coupons, admin, withdrawals)")
        .addUserOption((o) =>
          o
            .setName("user")
            .setDescription("User to inspect (defaults to you)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("games")
        .setDescription("Most recent games and whether they won or lost")
        .addUserOption((o) =>
          o
            .setName("user")
            .setDescription("User to inspect (defaults to you)")
            .setRequired(false),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();

    if (!isOwner(interaction) && !isWithdrawStaff(interaction)) {
      await interaction.reply({
        content: "Staff only.",
        ephemeral: true,
      });
      return;
    }

    const target =
      interaction.options.getUser("user", false) ?? interaction.user;
    const isSelf = target.id === interaction.user.id;
    const subjectLabel = isSelf ? "" : ` for <@${target.id}>`;

    if (sub === "balance") {
      const events = await getBalanceHistory(target.id, 15);
      const title = isSelf ? "Balance History" : `Balance History — ${target.tag}`;
      if (events.length === 0) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3b82f6)
              .setTitle(title)
              .setDescription(
                isSelf
                  ? "No non-game balance changes yet. Use `/history games` to see gambling results."
                  : `No non-game balance changes${subjectLabel} yet.`,
              ),
          ],
          ephemeral: true,
        });
        return;
      }
      const lines = events.map((e) => {
        const label = SOURCE_LABEL[e.source] ?? e.source;
        const delta = formatDelta(e.delta);
        const detail = e.detail ? ` — ${e.detail}` : "";
        return `${label} · **${delta}** · ${formatTime(e.created_at)}${detail}`;
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle(title)
            .setDescription(lines.join("\n"))
            .setFooter({
              text: "Coupons, daily, admin actions, withdrawals — last 15 events.",
            }),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === "games") {
      const games = await getGameHistory(target.id, 15);
      const title = isSelf ? "Game History" : `Game History — ${target.tag}`;
      if (games.length === 0) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3b82f6)
              .setTitle(title)
              .setDescription(
                isSelf
                  ? "You haven't played any games yet."
                  : `<@${target.id}> hasn't played any games yet.`,
              ),
          ],
          ephemeral: true,
        });
        return;
      }
      const lines = games.map((g) => {
        const bet = BigInt(g.bet);
        const payout = BigInt(g.payout);
        const net = g.won ? payout - bet : -bet;
        const marker = g.won ? "✅" : "❌";
        const verb = g.won ? "won" : "lost";
        return `${marker} **${g.game}** · ${verb} **${formatCoinsShort(net < 0n ? -net : net)}** (bet ${formatCoinsShort(bet)}) · ${formatTime(g.created_at)}`;
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle(title)
            .setDescription(lines.join("\n"))
            .setFooter({ text: "Last 15 games." }),
        ],
        ephemeral: true,
      });
      return;
    }
  },
};

export default command;
