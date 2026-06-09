import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreateUser } from "../lib/db.js";
import { formatCoinsRaw } from "../lib/format.js";
import { isMod } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your casino profile")
    .addUserOption((o) =>
      o
        .setName("user")
        .setDescription("Check another user's balance (mod only)")
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const isSelf = target.id === interaction.user.id;
    await interaction.deferReply({ ephemeral: !isSelf });

    const [user, viewerIsMod] = await Promise.all([
      getOrCreateUser(target.id),
      isMod(interaction),
    ]);

    if (!isSelf && !viewerIsMod) {
      await interaction.editReply({ content: "You can only check your own balance." });
      return;
    }

    const balance = BigInt(user.balance);
    const wagered = BigInt(user.total_wagered);
    const won    = BigInt(user.total_won);
    const lost   = BigInt(user.total_lost);
    const net    = won - lost;
    const netRaw = formatCoinsRaw(net < 0n ? -net : net);
    const netStr = net >= 0n ? `+${netRaw}` : `-${netRaw}`;
    const winRate = user.games_played > 0
      ? ((user.games_won / user.games_played) * 100).toFixed(1)
      : "0.0";

    const verifiedBadge = user.verified ? "Verified" : "Not Verified";

    // Use inline code (single backtick) — never wraps unlike triple-backtick blocks
    const v = (s: string) => `\`${s}\``;

    const embed = new EmbedBuilder()
      .setColor(0x16a34a)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setAuthor({
        name: `${target.displayName ?? target.username}`,
        iconURL: target.displayAvatarURL({ size: 64 }),
      })
      .setTitle("Casino Profile")
      .setDescription(`${verifiedBadge}  ·  <@${target.id}>`)
      .addFields(
        { name: "Balance",       value: v(formatCoinsRaw(balance)), inline: true },
        { name: "Net P/L",       value: v(netStr),                  inline: true },
        { name: "Total Wagered", value: v(formatCoinsRaw(wagered)), inline: true },
        { name: "Total Won",     value: v(formatCoinsRaw(won)),     inline: true },
        { name: "Total Lost",    value: v(formatCoinsRaw(lost)),    inline: true },
        { name: "Win Rate",      value: v(`${winRate}%`),           inline: true },
        { name: "Games Played",  value: v(user.games_played.toLocaleString()), inline: true },
        { name: "Games Won",     value: v(user.games_won.toLocaleString()),    inline: true },
        { name: "\u200b",        value: "\u200b",                   inline: true },
      )
      .setFooter({ text: "DonutSMP Casino", iconURL: interaction.client.user?.displayAvatarURL() })
      .setTimestamp();

    const wagerReq = BigInt(user.wager_requirement ?? "0");
    if (wagerReq > 0n) {
      const withdrawable = balance > wagerReq ? balance - wagerReq : 0n;
      embed.addFields(
        { name: "Withdrawable", value: v(formatCoinsRaw(withdrawable)), inline: true },
        { name: "Locked",       value: v(formatCoinsRaw(wagerReq)),     inline: true },
      );
    }

    if (viewerIsMod && user.minecraft_username) {
      embed.addFields({
        name: "Linked IGN (staff only)",
        value: `\`${user.minecraft_username}\``,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default command;
