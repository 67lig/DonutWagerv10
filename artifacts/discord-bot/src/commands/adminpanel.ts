import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type User,
} from "discord.js";
import { clearRig, getRigRow, setRig } from "../lib/rig.js";
import { OWNER_IDS } from "../lib/owners.js";
import { isModOrOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";
import {
  getOrCreateUser,
  resetUserStats,
  setBalance,
  recordBalanceEvent,
  listCoupons,
  createCoupon,
  deleteCoupon,
  getConfig,
  setConfig,
  setVerified,
  findUserByMinecraftUsername,
  getGameHistory,
  pool,
  type BotUser,
} from "../lib/db.js";
import { formatCoins, formatCoinsShort, parseAmount } from "../lib/format.js";
import { logAdminAction, logInviteAction } from "../lib/gamblelog.js";
import { buildPanelMessage } from "../lib/panel_flow.js";
import {
  getInviteStats,
  getInviteList,
  getNextClaimMin,
  COINS_PER_INVITE,
  getInviteConfig,
  setInviteConfig,
} from "../lib/invite_flow.js";
import { CATEGORY_CONFIG_KEYS } from "../lib/tickets.js";
import { getHouseRates, saveHouseRates, DEFAULT_RATES, type HouseRates } from "../lib/houserates.js";
import { CHANNELS } from "../lib/config.js";
import {
  getThreshold,
  getStickyText,
  setThreshold,
  setStickyText,
  updateStickyMessage,
} from "../lib/suggestions_flow.js";

export const AP_BTN_PREFIX = "ap";
export const AP_MODAL_PREFIX = "ap_modal";

const BOT_START_TIME = Date.now();

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
//  SERVER MANAGEMENT PANEL  (no user arg)
// ═══════════════════════════════════════════════════════════════════════════

interface ServerConfig {
  modRole: string | null;
  depCat: string | null;
  wdCat: string | null;
  vfCat: string | null;
  gambleCat: string | null;
  paymentCat: string | null;
  inviteFlagsCat: string | null;
  activeCoupons: number;
  totalCoupons: number;
  houseRates: HouseRates;
  inviteCoinsPerInvite: bigint;
  inviteClaimTiers: number[];
  inviteLogChannelId: string | null;
  payLogsChannelId: string | null;
}

async function fetchServerConfig(): Promise<ServerConfig> {
  const [modRole, depCat, wdCat, vfCat, gambleCat, paymentCat, inviteFlagsCat, coupons, houseRates, invCfg, inviteLogChannelId, payLogsChannelId] = await Promise.all([
    getConfig("mod_role_id"),
    getConfig(CATEGORY_CONFIG_KEYS.deposit),
    getConfig(CATEGORY_CONFIG_KEYS.withdraw),
    getConfig(CATEGORY_CONFIG_KEYS.verify),
    getConfig(CATEGORY_CONFIG_KEYS.gamble),
    getConfig(CATEGORY_CONFIG_KEYS.payment),
    getConfig(CATEGORY_CONFIG_KEYS.inviteflags),
    listCoupons(),
    getHouseRates(),
    getInviteConfig(),
    getConfig("invite_flag_log_channel_id"),
    getConfig("pay_log_channel_id"),
  ]);
  const now = Date.now();
  const activeCoupons = coupons.filter(
    (c) =>
      c.uses_count < c.max_uses &&
      (!c.expires_at || new Date(c.expires_at).getTime() > now),
  ).length;
  return {
    modRole, depCat, wdCat, vfCat,
    gambleCat: gambleCat ?? null,
    paymentCat: paymentCat ?? null,
    inviteFlagsCat: inviteFlagsCat ?? null,
    activeCoupons, totalCoupons: coupons.length,
    houseRates,
    inviteCoinsPerInvite: invCfg.coinsPerInvite,
    inviteClaimTiers: invCfg.claimTiers,
    inviteLogChannelId: inviteLogChannelId ?? null,
    payLogsChannelId: payLogsChannelId ?? null,
  };
}

function buildServerEmbed(cfg: ServerConfig): EmbedBuilder {
  const r = cfg.houseRates;
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle("Server Panel")
    .addFields(
      {
        name: "Mod Role",
        value: cfg.modRole ? `<@&${cfg.modRole}>` : "_not set_",
        inline: true,
      },
      {
        name: "Coupons",
        value: `${cfg.activeCoupons} active / ${cfg.totalCoupons} total`,
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: true },
      {
        name: "Deposit Category",
        value: cfg.depCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Withdraw Category",
        value: cfg.wdCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Linking Category",
        value: cfg.vfCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Gamble Category",
        value: cfg.gambleCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Payment Category",
        value: cfg.paymentCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Invite Flags Category",
        value: cfg.inviteFlagsCat ? "Set" : "_not set_",
        inline: true,
      },
      {
        name: "Pay Logs Channel",
        value: cfg.payLogsChannelId ? `<#${cfg.payLogsChannelId}>` : "_not set_",
        inline: true,
      },
      {
        name: "House Edge",
        value: `Base: **${(r.base * 100).toFixed(1)}%** · >49M: **${(r.big * 100).toFixed(1)}%** · >74M: **${(r.whale * 100).toFixed(1)}%** · >99M: **${(r.mega * 100).toFixed(1)}%**`,
        inline: false,
      },
      {
        name: "Invite Rewards",
        value: `**${formatCoins(cfg.inviteCoinsPerInvite)}** per invite · Milestones: **${cfg.inviteClaimTiers.join(" → ")}**`,
        inline: false,
      },
      {
        name: "Invite Log Channel",
        value: cfg.inviteLogChannelId
          ? `<#${cfg.inviteLogChannelId}> (\`${cfg.inviteLogChannelId}\`)`
          : "_not set_",
        inline: false,
      },
    )
    .setTimestamp();
}

function buildServerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_postpanel`)
      .setLabel("Post Casino Panel")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_modrole`)
      .setLabel("Set Mod Role")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_setcat`)
      .setLabel("Set Category")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_refresh`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_uptime`)
      .setLabel("Uptime")
      .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_ccreate`)
      .setLabel("Create Coupon")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_clist`)
      .setLabel("List Coupons")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_cdelete`)
      .setLabel("Delete Coupon")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_houseedge`)
      .setLabel("Regulations")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_gamblerules`)
      .setLabel("Gamble Settings")
      .setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_inviteconfig`)
      .setLabel("Invite Rewards")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_setinvitelog`)
      .setLabel("Set Invite Log")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_setpaylogs`)
      .setLabel("Set Pay Logs")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:srv_suggestions`)
      .setLabel("Suggestions")
      .setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3];
}

function buildApSuggestionsEmbed(threshold: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Suggestions Settings")
    .setDescription(
      `Suggestions channel: <#${CHANNELS.SUGGESTIONS}>\n` +
      `Top Suggestions channel: <#${CHANNELS.TOP_SUGGESTIONS}>\n\n` +
      `Current reaction threshold: \`${threshold}\`\n` +
      `Users who react ${threshold} times promote a suggestion to top suggestions.\n\n` +
      `Use the buttons below to change the threshold or refresh the sticky message.`,
    )
    .setTimestamp();
}

function buildApSuggestionsComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AP_BTN_PREFIX}:srv_sugg_setmin`)
        .setLabel("Set Threshold")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${AP_BTN_PREFIX}:srv_sugg_edit`)
        .setLabel("Edit Sticky Message")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${AP_BTN_PREFIX}:srv_sugg_refresh`)
        .setLabel("Refresh Sticky")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${AP_BTN_PREFIX}:srv_refresh`)
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
//  USER PANEL  (user arg provided)
// ═══════════════════════════════════════════════════════════════════════════

interface PanelInviteStats {
  realInvited: number;
  fakeInvited: number;
  realValid: number;
  realLeft: number;
  realNotVerified: number;
  claimCount: number;
  nextClaimMin: number;
  netValid: number;
  claimedAndLeft: number;
}

export async function fetchUserInviteStats(discordId: string): Promise<PanelInviteStats> {
  const stats = await getInviteStats(discordId);

  const [fakeRes, realValidRes, realLeftRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bot_invite_members
       WHERE inviter_discord_id = $1 AND invitee_discord_id LIKE 'test_%'`,
      [discordId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bot_invite_members
       WHERE inviter_discord_id = $1
         AND has_member_role = TRUE
         AND left_at IS NULL
         AND invitee_discord_id NOT LIKE 'test_%'`,
      [discordId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bot_invite_members
       WHERE inviter_discord_id = $1
         AND left_at IS NOT NULL
         AND invitee_discord_id NOT LIKE 'test_%'`,
      [discordId],
    ),
  ]);

  const fakeInvited = parseInt(fakeRes.rows[0]?.count ?? "0", 10);
  const realInvited = stats.totalInvited - fakeInvited;
  const realValid = parseInt(realValidRes.rows[0]?.count ?? "0", 10);
  const realLeft = parseInt(realLeftRes.rows[0]?.count ?? "0", 10);
  const netValid = stats.validUnclaimed - stats.claimedAndLeft;

  return {
    realInvited,
    fakeInvited,
    realValid,
    realLeft,
    realNotVerified: Math.max(0, realInvited - realValid - realLeft),
    claimCount: stats.claimCount,
    nextClaimMin: getNextClaimMin(stats.claimCount),
    netValid,
    claimedAndLeft: stats.claimedAndLeft,
  };
}

export function buildUserEmbed(
  target: User,
  rig: { mode: string; value: number } | null,
  dbUser: BotUser | null,
  inv: PanelInviteStats,
): EmbedBuilder {
  let rigLine: string;
  let color: number;

  if (!rig) {
    rigLine = "No rig active - playing fair.";
    color = 0x3b82f6;
  } else if (rig.mode === "next_loss") {
    rigLine = "**Next game: forced loss** (one-shot, auto-removes after firing)";
    color = 0xef4444;
  } else {
    rigLine = `**${rig.value}% win rate** applied to every game`;
    color = 0x22c55e;
  }

  const discordTs = Math.floor(target.createdTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("User Panel")
    .setThumbnail(target.displayAvatarURL({ size: 64 }))
    .addFields({
      name: "Discord",
      value: `<@${target.id}>\n\`${target.username}\`\nCreated <t:${discordTs}:D> (<t:${discordTs}:R>)`,
      inline: true,
    });

  if (dbUser) {
    const balance = BigInt(dbUser.balance);
    const wagered = BigInt(dbUser.total_wagered);
    const won = BigInt(dbUser.total_won);
    const lost = BigInt(dbUser.total_lost);
    const gamesPlayed = dbUser.games_played;
    const gamesWon = dbUser.games_won;
    const winRate =
      gamesPlayed > 0
        ? `${((gamesWon / gamesPlayed) * 100).toFixed(1)}%`
        : "N/A";

    embed.addFields(
      {
        name: "Minecraft IGN",
        value:
          dbUser.verified && dbUser.minecraft_username
            ? `\`${dbUser.minecraft_username}\``
            : "_not linked_",
        inline: true,
      },
      {
        name: "Verified",
        value: dbUser.verified ? "Yes" : "No",
        inline: true,
      },
      {
        name: "Balance",
        value: formatCoins(balance),
        inline: true,
      },
      {
        name: "Win Rate",
        value: `${winRate} (${gamesWon}W / ${gamesPlayed - gamesWon}L)`,
        inline: true,
      },
      {
        name: "Games Played",
        value: `${gamesPlayed.toLocaleString()}`,
        inline: true,
      },
      {
        name: "Total Wagered",
        value: formatCoins(wagered),
        inline: true,
      },
      {
        name: "Total Won",
        value: formatCoins(won),
        inline: true,
      },
      {
        name: "Total Lost",
        value: formatCoins(lost),
        inline: true,
      },
      {
        name: "Last Active",
        value: dbUser.last_command_at
          ? `<t:${Math.floor(new Date(dbUser.last_command_at).getTime() / 1000)}:R>`
          : "_never_",
        inline: true,
      },
    );
  } else {
    embed.addFields({
      name: "Account",
      value: "_No account found. User has never interacted with the bot._",
      inline: false,
    });
  }

  // ── Active Rig (shown before invite stats so button order matches) ────────
  embed.addFields({
    name: "Active Rig",
    value: rigLine,
    inline: false,
  });

  // ── Invite stats ──────────────────────────────────────────────────────────
  const needed = Math.max(0, inv.nextClaimMin - inv.netValid);
  const canClaim = inv.netValid >= inv.nextClaimMin;

  embed.addFields(
    {
      name: "Real Invites",
      value: [
        `**${inv.realInvited}** total`,
        `Valid: **${inv.realValid}**`,
        `Left: **${inv.realLeft}**`,
        `Unverified: **${inv.realNotVerified}**`,
      ].join("  ·  "),
      inline: false,
    },
    {
      name: "Net Valid",
      value:
        inv.claimedAndLeft > 0
          ? `**${inv.netValid}** (${inv.realValid} − ${inv.claimedAndLeft} deducted)`
          : `**${inv.netValid}**`,
      inline: true,
    },
    {
      name: "Claims Made",
      value: `**${inv.claimCount}**`,
      inline: true,
    },
    {
      name: "Next Claim",
      value: canClaim
        ? `Can claim now! (needs ${inv.nextClaimMin} net valid)`
        : `Needs **${inv.nextClaimMin}** net valid, **${needed}** more to go`,
      inline: false,
    },
  );

  embed
    .setFooter({ text: "Rig changes apply at the start of the player's next game." })
    .setTimestamp();

  return embed;
}

export function buildUserComponents(targetId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:setbal:${targetId}`)
      .setLabel("Set Balance")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:changeverify:${targetId}`)
      .setLabel("Change Verify")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:resetstats:${targetId}`)
      .setLabel("Reset Stats")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:gamble:${targetId}`)
      .setLabel("Gamble")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:refresh:${targetId}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:adduncounted:${targetId}`)
      .setLabel("Add Invites")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:viewinv:${targetId}`)
      .setLabel("View Invites")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:resetinv:${targetId}`)
      .setLabel("Reset Invites")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:invited:${targetId}`)
      .setLabel("Invited")
      .setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:gamblelog:${targetId}`)
      .setLabel("Gamble Log")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${AP_BTN_PREFIX}:userstats:${targetId}`)
      .setLabel("Stats")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

// ═══════════════════════════════════════════════════════════════════════════
//  SLASH COMMAND
// ═══════════════════════════════════════════════════════════════════════════

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("gamblepanel")
    .setDescription(".")
    .setDefaultMemberPermissions(0n),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!isModOrOwner(interaction)) {
      await interaction.editReply({ content: "Staff only." });
      return;
    }

    const cfg = await fetchServerConfig();
    await interaction.editReply({
      embeds: [buildServerEmbed(cfg)],
      components: buildServerComponents(),
    });
  },
};

export default command;

// ═══════════════════════════════════════════════════════════════════════════
//  BUTTON HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleAdminPanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isModOrOwner(interaction)) {
    await interaction.reply({ content: "Staff only.", ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(":");
  const action = parts[1];
  if (!action) return;

  // ── Server panel actions ───────────────────────────────────────────────
  if (action.startsWith("srv_")) {
    await handleServerButton(interaction, action);
    return;
  }

  // ── User panel actions — require targetId ──────────────────────────────
  const targetId = parts[2];
  if (!targetId) return;

  // ── Modal-triggering actions (must NOT deferUpdate first) ─────────────
  if (action === "gamble") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:gamble:${targetId}`)
      .setTitle("Gamble Controls");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("rig")
          .setLabel("win [%]  /  nextloss  /  remove")
          .setPlaceholder("win 80")
          .setMinLength(3)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "changeverify") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:changeverify:${targetId}`)
      .setTitle("Change Verify");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("Minecraft username to link")
          .setPlaceholder("Steve")
          .setMinLength(1)
          .setMaxLength(40)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "setbal") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:setbal:${targetId}`)
      .setTitle("Set Balance");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("New balance (e.g. 50m, 1.5b, 500k)")
          .setPlaceholder("100m")
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "adduncounted") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:adduncounted:${targetId}`)
      .setTitle("Add Missed Invites");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Missed invites to add as valid (1–50)")
          .setPlaceholder("5")
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "resetinv") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:resetinv:${targetId}`)
      .setTitle("Confirm Invite Reset");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("confirm")
          .setLabel("Type CONFIRM to wipe all invite data")
          .setPlaceholder("CONFIRM")
          .setMinLength(7)
          .setMaxLength(7)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ── Public-reply actions ───────────────────────────────────────────────
  if (action === "invited") {
    await interaction.deferReply({ ephemeral: false });
    const [list, stats] = await Promise.all([
      getInviteList(targetId),
      getInviteStats(targetId),
    ]);

    const target = await interaction.client.users.fetch(targetId);

    if (list.length === 0) {
      await interaction.editReply({ content: `**${target.username}** has not invited anyone yet.` });
      return;
    }

    const realRows = list.filter((r) => !r.invitee_discord_id.startsWith("test_"));
    if (realRows.length === 0) {
      await interaction.editReply({ content: `**${target.username}** has no real (non-test) invites.` });
      return;
    }

    const lines = realRows.map((row) => {
      const icon = row.left_at !== null ? "✗" : row.has_member_role ? "✓" : "?";
      const label = row.left_at !== null ? "Left" : row.has_member_role ? "Valid" : "Not Verified";
      const ts = Math.floor(new Date(row.joined_at).getTime() / 1000);
      return `${icon} <@${row.invitee_discord_id}> ${label} <t:${ts}:R>`;
    });

    const header = `**Invited by ${target.username}** | ${stats.totalInvited} total · ${stats.validUnclaimed} valid · ${stats.leftServer} left\n\n`;
    const body = lines.join("\n");
    const content = (header + body).slice(0, 2000);
    await interaction.editReply({ content });
    return;
  }

  // ── Ephemeral-reply actions ────────────────────────────────────────────
  if (action === "viewinv") {
    await interaction.deferReply({ ephemeral: true });
    const [stats, target] = await Promise.all([
      getInviteStats(targetId),
      interaction.client.users.fetch(targetId),
    ]);
    const nextMin = getNextClaimMin(stats.claimCount);
    const netValid = stats.validUnclaimed - stats.claimedAndLeft;

    const claimRows = await pool.query<{
      claim_number: number;
      invites_used: string;
      coins_awarded: string;
      claimed_at: Date;
    }>(
      `SELECT claim_number, invites_used, coins_awarded, claimed_at
         FROM bot_invite_claims WHERE discord_id = $1
         ORDER BY claim_number ASC`,
      [targetId],
    );

    const history =
      claimRows.rows.length === 0
        ? "No claims yet."
        : claimRows.rows
            .map(
              (r) =>
                `Claim #${r.claim_number} - ${r.invites_used} invites - ${formatCoins(BigInt(r.coins_awarded))} - <t:${Math.floor(new Date(r.claimed_at).getTime() / 1000)}:d>`,
            )
            .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`Invite Stats - ${target.username}`)
      .addFields(
        { name: "Total Invited", value: `${stats.totalInvited}`, inline: true },
        { name: "Valid Unclaimed", value: `${stats.validUnclaimed}`, inline: true },
        { name: "Left Server", value: `${stats.leftServer}`, inline: true },
        { name: "Not Verified", value: `${stats.notVerified}`, inline: true },
        { name: "Deducted", value: `${stats.claimedAndLeft}`, inline: true },
        { name: "Net Valid", value: `${netValid}`, inline: true },
        { name: "Total Claims", value: `${stats.claimCount}`, inline: true },
        { name: "Next Claim Needs", value: `${nextMin} net valid`, inline: true },
        { name: "Rate", value: formatCoins(COINS_PER_INVITE) + " per invite", inline: true },
        { name: "Claim History", value: history.slice(0, 1024), inline: false },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (action === "gamblelog") {
    await interaction.deferReply({ ephemeral: true });
    const rows = await getGameHistory(targetId, 25);
    const target = await interaction.client.users.fetch(targetId);
    if (rows.length === 0) {
      await interaction.editReply({ content: `No game history found for **${target.username}**.` });
      return;
    }
    const lines = rows.map((r) => {
      const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
      const net = r.won ? BigInt(r.payout) - BigInt(r.bet) : BigInt(r.bet);
      const prefix = r.won ? "W" : "L";
      return `${prefix} ${r.game.padEnd(10)} ${r.won ? "+" : "-"}${formatCoins(net).padStart(14)}  bet ${formatCoins(BigInt(r.bet))}  <t:${ts}:R>`;
    });
    const header = `**Gamble Log - ${target.username}** (last ${rows.length})\n`;
    await interaction.editReply({ content: header + "```\n" + lines.join("\n") + "\n```" });
    return;
  }

  if (action === "userstats") {
    await interaction.deferReply({ ephemeral: true });
    const target = await interaction.client.users.fetch(targetId);
    const perGame = await pool.query<{
      game: string;
      plays: string;
      wins: string;
      total_bet: string;
      total_payout: string;
    }>(
      `SELECT game,
              COUNT(*)::text AS plays,
              COUNT(*) FILTER (WHERE won)::text AS wins,
              SUM(bet)::text AS total_bet,
              SUM(payout)::text AS total_payout
         FROM game_log
        WHERE discord_id = $1
        GROUP BY game
        ORDER BY COUNT(*) DESC`,
      [targetId],
    );
    if (perGame.rows.length === 0) {
      await interaction.editReply({ content: `No game data found for **${target.username}**.` });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(`Game Stats - ${target.username}`)
      .setTimestamp();
    for (const r of perGame.rows) {
      const plays = parseInt(r.plays, 10);
      const wins = parseInt(r.wins, 10);
      const wagered = BigInt(r.total_bet);
      const paid = BigInt(r.total_payout);
      const net = paid - wagered;
      const wr = plays > 0 ? `${((wins / plays) * 100).toFixed(1)}%` : "N/A";
      embed.addFields({
        name: r.game,
        value: `${plays} plays | ${wins}W / ${plays - wins}L (${wr}) | Wagered: ${formatCoins(wagered)} | Net: ${net >= 0n ? "+" : ""}${formatCoins(net < 0n ? -net : net)}`,
        inline: false,
      });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── In-place update actions ────────────────────────────────────────────
  await interaction.deferUpdate();

  if (action === "resetstats") {
    const dbUserPre = await getOrCreateUser(targetId);
    await resetUserStats(targetId);
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Stats Reset",
      targetId,
      detail: `Balance wiped from ${formatCoins(BigInt(dbUserPre.balance))} to 0. All stats cleared.`,
      good: false,
    });
  }
  // "refresh" and unknown actions — just re-fetch

  const [target, rig, dbUser, inv] = await Promise.all([
    interaction.client.users.fetch(targetId),
    getRigRow(targetId),
    getOrCreateUser(targetId),
    fetchUserInviteStats(targetId),
  ]);

  await interaction.editReply({
    embeds: [buildUserEmbed(target, rig, dbUser, inv)],
    components: buildUserComponents(targetId),
  });
}

// ── Server button sub-handler ─────────────────────────────────────────────────

async function handleServerButton(
  interaction: ButtonInteraction,
  action: string,
): Promise<void> {
  // Modal-triggering actions
  if (action === "srv_modrole") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_modrole`)
      .setTitle("Set Mod Role");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("roleid")
          .setLabel("Role ID (right-click role → Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_setcat") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_setcat`)
      .setTitle("Set Ticket Category");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("kind")
          .setLabel("Kind: deposit | withdraw | verify | gamble | payment | inviteflags")
          .setPlaceholder("deposit")
          .setMinLength(4)
          .setMaxLength(12)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("catid")
          .setLabel("Category Channel ID (right-click → Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_ccreate") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_ccreate`)
      .setTitle("Create Coupon");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("code")
          .setLabel("Coupon code (3-32 chars, letters/numbers/-/_)")
          .setPlaceholder("SUMMER25")
          .setMinLength(3)
          .setMaxLength(32)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Coins per redemption (e.g. 10m, 1.5b)")
          .setPlaceholder("10m")
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("maxuses")
          .setLabel("Max uses (total redemptions allowed)")
          .setPlaceholder("100")
          .setMinLength(1)
          .setMaxLength(7)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("type")
          .setLabel("Type: gamble  |  nongamble")
          .setPlaceholder("gamble")
          .setMinLength(6)
          .setMaxLength(10)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("expires")
          .setLabel("Expires in hours (leave blank = never)")
          .setPlaceholder("24")
          .setRequired(false)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_houseedge") {
    const rates = await getHouseRates();
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_houseedge`)
      .setTitle("Set House Edge");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("base")
          .setLabel(`Base rate % (any bet, currently ${(rates.base * 100).toFixed(1)}%)`)
          .setPlaceholder(`${(rates.base * 100).toFixed(0)}`)
          .setMinLength(1).setMaxLength(5).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("big")
          .setLabel(`>49M bet rate % (currently ${(rates.big * 100).toFixed(1)}%)`)
          .setPlaceholder(`${(rates.big * 100).toFixed(0)}`)
          .setMinLength(1).setMaxLength(5).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("whale")
          .setLabel(`>74M bet rate % (currently ${(rates.whale * 100).toFixed(1)}%)`)
          .setPlaceholder(`${(rates.whale * 100).toFixed(0)}`)
          .setMinLength(1).setMaxLength(5).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mega")
          .setLabel(`>99M bet rate % (currently ${(rates.mega * 100).toFixed(1)}%)`)
          .setPlaceholder(`${(rates.mega * 100).toFixed(0)}`)
          .setMinLength(1).setMaxLength(5).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_setinvitelog") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_setinvitelog`)
      .setTitle("Set Invite Log Channel");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channelid")
          .setLabel("Channel ID (right-click channel → Copy ID)")
          .setPlaceholder("paste channel ID here")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_inviteconfig") {
    const invCfg = await getInviteConfig();
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_inviteconfig`)
      .setTitle("Invite Rewards Config");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("coins")
          .setLabel(`Coins per invite (currently ${formatCoins(invCfg.coinsPerInvite)})`)
          .setPlaceholder("e.g. 5m or 10000000")
          .setMinLength(1).setMaxLength(20).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tiers")
          .setLabel(`Claim milestones (currently ${invCfg.claimTiers.join(",")})`)
          .setPlaceholder("e.g. 3,5,10,15,20,25")
          .setMinLength(1).setMaxLength(100).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_uptime") {
    const uptime = Date.now() - BOT_START_TIME;
    const startedAt = Math.floor(BOT_START_TIME / 1000);
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Bot Uptime")
          .addFields(
            { name: "Uptime", value: formatUptime(uptime), inline: true },
            { name: "Started", value: `<t:${startedAt}:R>`, inline: true },
          )
          .setTimestamp(),
      ],
    });
    return;
  }

  if (action === "srv_gamblerules") {
    const rates = await getHouseRates();
    const isDefault = (
      rates.base === DEFAULT_RATES.base &&
      rates.big === DEFAULT_RATES.big &&
      rates.whale === DEFAULT_RATES.whale &&
      rates.mega === DEFAULT_RATES.mega
    );
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Gamble Settings - Edge")
          .setDescription(
            "These rates control how often the house wins across all games " +
            "(coinflip, dice, roulette, mines, towers, blackjack).\n" +
            (isDefault ? "_Currently using default rates._" : "_Custom rates active._"),
          )
          .addFields(
            { name: "Base (any bet)", value: `**${(rates.base * 100).toFixed(1)}%**`, inline: true },
            { name: ">49M bets", value: `**${(rates.big * 100).toFixed(1)}%**`, inline: true },
            { name: ">74M bets", value: `**${(rates.whale * 100).toFixed(1)}%**`, inline: true },
            { name: ">99M bets", value: `**${(rates.mega * 100).toFixed(1)}%**`, inline: true },
            {
              name: "Defaults",
              value: `Base ${(DEFAULT_RATES.base * 100).toFixed(1)}% · >49M ${(DEFAULT_RATES.big * 100).toFixed(1)}% · >74M ${(DEFAULT_RATES.whale * 100).toFixed(1)}% · >99M ${(DEFAULT_RATES.mega * 100).toFixed(1)}%`,
              inline: false,
            },
          )
          .setFooter({ text: "Use Regulations to change · Reset Rates restores defaults" }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${AP_BTN_PREFIX}:srv_resetrates`)
            .setLabel("Reset to Defaults")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (action === "srv_cdelete") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_cdelete`)
      .setTitle("Delete Coupon");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("code")
          .setLabel("Coupon code to delete")
          .setPlaceholder("SUMMER25")
          .setMinLength(3)
          .setMaxLength(32)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_setpaylogs") {
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_setpaylogs`)
      .setTitle("Set Pay Logs Channel");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channelid")
          .setLabel("Channel ID (right-click channel and Copy ID)")
          .setPlaceholder("paste channel ID here")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_suggestions") {
    await interaction.deferUpdate();
    const threshold = await getThreshold();
    await interaction.editReply({
      embeds: [buildApSuggestionsEmbed(threshold)],
      components: buildApSuggestionsComponents(),
    });
    return;
  }

  if (action === "srv_sugg_setmin") {
    const currentThreshold = await getThreshold();
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_sugg_setmin`)
      .setTitle("Set Reaction Threshold");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("threshold")
          .setLabel("Minimum reactions to promote a suggestion")
          .setPlaceholder("5")
          .setValue(String(currentThreshold))
          .setMinLength(1)
          .setMaxLength(3)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_sugg_edit") {
    const currentText = await getStickyText();
    const modal = new ModalBuilder()
      .setCustomId(`${AP_MODAL_PREFIX}:srv_sugg_edit`)
      .setTitle("Edit Sticky Message");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("Sticky message text")
          .setPlaceholder("Use {threshold} and {emoji} as placeholders")
          .setValue(currentText)
          .setMinLength(5)
          .setMaxLength(300)
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "srv_sugg_refresh") {
    await interaction.deferUpdate();
    await updateStickyMessage(interaction.client);
    const threshold = await getThreshold();
    await interaction.editReply({
      embeds: [buildApSuggestionsEmbed(threshold)],
      components: buildApSuggestionsComponents(),
    });
    return;
  }

  // In-place update actions
  await interaction.deferUpdate();

  if (action === "srv_resetrates") {
    await saveHouseRates(DEFAULT_RATES);
  }

  if (action === "srv_postpanel") {
    const ch = interaction.channel;
    if (ch && "send" in ch) {
      const { embed, components } = buildPanelMessage();
      await (ch as TextChannel).send({ embeds: [embed], components }).catch(() => null);
    }
  }

  if (action === "srv_clist") {
    const all = await listCoupons();
    await interaction.followUp({
      ephemeral: true,
      embeds: [buildCouponListEmbed(all)],
    });
    return;
  }

  // Refresh (and post/clist fall through to here to also refresh the panel)
  const cfg = await fetchServerConfig();
  await interaction.editReply({
    embeds: [buildServerEmbed(cfg)],
    components: buildServerComponents(),
  });
}

function buildCouponListEmbed(coupons: Awaited<ReturnType<typeof listCoupons>>): EmbedBuilder {
  if (coupons.length === 0) {
    return new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle("Coupons")
      .setDescription("No coupons yet. Click **Create Coupon** to mint one.");
  }
  const now = Date.now();
  const lines = coupons.map((c) => {
    const expired = c.expires_at && new Date(c.expires_at).getTime() < now;
    const exhausted = c.uses_count >= c.max_uses;
    const status = expired ? "[exp]" : exhausted ? "[full]" : "[ok]";
    const expires = c.expires_at
      ? ` · exp <t:${Math.floor(new Date(c.expires_at).getTime() / 1000)}:R>`
      : "";
    const typeTag = c.coupon_type === "nongamble" ? "free" : "gamble";
    return `${status} \`${c.code}\` - ${formatCoins(BigInt(c.amount))} - ${c.uses_count}/${c.max_uses} used - ${typeTag}${expires}`;
  });
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("Coupons")
    .setDescription(lines.join("\n").slice(0, 4000))
    .setFooter({ text: "[ok] active  [full] exhausted  [exp] expired" });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODAL HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleAdminPanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!isModOrOwner(interaction)) {
    await interaction.reply({ content: "Staff only.", ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(":");
  const action = parts[1];
  if (!action) return;

  // ── Server panel modals ────────────────────────────────────────────────
  if (action.startsWith("srv_")) {
    await handleServerModal(interaction, action);
    return;
  }

  // ── User panel modals — require targetId ───────────────────────────────
  const targetId = parts[2];
  if (!targetId) return;

  // ── Gamble modal ───────────────────────────────────────────────────────
  if (action === "gamble") {
    const raw = interaction.fields.getTextInputValue("rig").trim().toLowerCase();
    let rigErr = "";

    if (raw === "nextloss") {
      await interaction.deferUpdate();
      await setRig(targetId, "next_loss");
    } else if (raw === "remove") {
      await interaction.deferUpdate();
      await clearRig(targetId);
    } else if (raw.startsWith("win ")) {
      const pct = parseInt(raw.slice(4), 10);
      if (isNaN(pct) || pct < 1 || pct > 100) {
        rigErr = "Invalid. Enter `win 80` with a % between 1 and 100.";
      } else {
        await interaction.deferUpdate();
        await setRig(targetId, "pct_win", pct);
      }
    } else {
      rigErr = "Unknown input. Try: `win 80`, `nextloss`, or `remove`.";
    }

    if (rigErr) {
      await interaction.reply({ content: rigErr, ephemeral: true });
      return;
    }

    const [target, rig, dbUser, inv] = await Promise.all([
      interaction.client.users.fetch(targetId),
      getRigRow(targetId),
      getOrCreateUser(targetId),
      fetchUserInviteStats(targetId),
    ]);
    await interaction.editReply({ embeds: [buildUserEmbed(target, rig, dbUser, inv)], components: buildUserComponents(targetId) });
    return;
  }

  // ── Change verify modal ────────────────────────────────────────────────
  if (action === "changeverify") {
    const ign = interaction.fields.getTextInputValue("ign").trim();
    if (!ign) {
      await interaction.reply({ content: "Username cannot be empty.", ephemeral: true });
      return;
    }

    const conflict = await findUserByMinecraftUsername(ign);
    if (conflict && conflict.discord_id !== targetId) {
      await interaction.reply({
        content: `That username is already linked to <@${conflict.discord_id}>. Unlink them first or use a different name.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();
    await setVerified(targetId, ign);
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Verify Changed",
      targetId,
      detail: `Linked to Minecraft: \`${ign}\``,
      good: true,
    });

    const [target, rig, dbUser, inv] = await Promise.all([
      interaction.client.users.fetch(targetId),
      getRigRow(targetId),
      getOrCreateUser(targetId),
      fetchUserInviteStats(targetId),
    ]);
    await interaction.editReply({ embeds: [buildUserEmbed(target, rig, dbUser, inv)], components: buildUserComponents(targetId) });
    return;
  }

  // ── Add uncounted invites modal ────────────────────────────────────────
  if (action === "adduncounted") {
    const raw = interaction.fields.getTextInputValue("amount").trim();
    const amount = parseInt(raw, 10);
    if (isNaN(amount) || amount < 1 || amount > 50) {
      await interaction.reply({ content: "Invalid amount. Must be between 1 and 50.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    const now = Date.now();
    for (let i = 0; i < amount; i++) {
      const missedId = `missed_${now}_${i}`;
      await pool.query(
        `INSERT INTO bot_invite_members
           (invitee_discord_id, inviter_discord_id, invite_code, has_member_role)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (invitee_discord_id) DO NOTHING`,
        [missedId, targetId, "admin-missed"],
      );
    }

    const [target, rig, dbUser, inv] = await Promise.all([
      interaction.client.users.fetch(targetId),
      getRigRow(targetId),
      getOrCreateUser(targetId),
      fetchUserInviteStats(targetId),
    ]);
    await interaction.editReply({ embeds: [buildUserEmbed(target, rig, dbUser, inv)], components: buildUserComponents(targetId) });
    return;
  }

  // ── Reset invites modal ────────────────────────────────────────────────
  if (action === "resetinv") {
    const confirm = interaction.fields.getTextInputValue("confirm").trim();
    if (confirm !== "CONFIRM") {
      await interaction.reply({ content: "Cancelled. You must type CONFIRM exactly.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    await Promise.all([
      pool.query(`DELETE FROM bot_invite_members WHERE inviter_discord_id = $1`, [targetId]),
      pool.query(`DELETE FROM bot_invite_claims WHERE discord_id = $1`, [targetId]),
      pool.query(`DELETE FROM bot_config WHERE key = $1`, [`invite_pending_${targetId}`]),
    ]);

    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Invite Reset",
      targetId,
      detail: "All invite rows, claims, and pending claim cleared.",
      good: false,
    });

    const [target, rig, dbUser, inv] = await Promise.all([
      interaction.client.users.fetch(targetId),
      getRigRow(targetId),
      getOrCreateUser(targetId),
      fetchUserInviteStats(targetId),
    ]);
    await interaction.editReply({ embeds: [buildUserEmbed(target, rig, dbUser, inv)], components: buildUserComponents(targetId) });
    return;
  }

  // ── Set balance modal ──────────────────────────────────────────────────
  if (action === "setbal") {
    const raw = interaction.fields.getTextInputValue("amount").trim();
    const parsed = parseAmount(raw);
    if (parsed === null || parsed < 0n) {
      await interaction.reply({
        content: "Invalid amount. Use a number or abbreviation like `50m`, `1.5b`, `500k`.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    const existing = await getOrCreateUser(targetId);
    const oldBal = BigInt(existing.balance);
    const newBal = parsed;
    await setBalance(targetId, newBal);

    const delta = newBal - oldBal;
    if (delta !== 0n) {
      await recordBalanceEvent({
        discordId: targetId,
        delta,
        source: "admin",
        detail: `Balance set by ${interaction.user.tag} (${formatCoins(oldBal)} → ${formatCoins(newBal)})`,
      });
    }
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Balance Set",
      targetId,
      amount: newBal,
      detail: `Was ${formatCoins(oldBal)} → now ${formatCoins(newBal)}`,
    });

    const [target, rig, dbUser, inv] = await Promise.all([
      interaction.client.users.fetch(targetId),
      getRigRow(targetId),
      getOrCreateUser(targetId),
      fetchUserInviteStats(targetId),
    ]);

    await interaction.editReply({
      embeds: [buildUserEmbed(target, rig, dbUser, inv)],
      components: buildUserComponents(targetId),
    });
    return;
  }

}

// ── Server modal sub-handler ──────────────────────────────────────────────────

async function handleServerModal(
  interaction: ModalSubmitInteraction,
  action: string,
): Promise<void> {
  if (action === "srv_houseedge") {
    const rawBase = interaction.fields.getTextInputValue("base").trim();
    const rawBig = interaction.fields.getTextInputValue("big").trim();
    const rawWhale = interaction.fields.getTextInputValue("whale").trim();
    const rawMega = interaction.fields.getTextInputValue("mega").trim();
    const parse = (s: string) => parseFloat(s.replace("%", "")) / 100;
    const base = parse(rawBase);
    const big = parse(rawBig);
    const whale = parse(rawWhale);
    const mega = parse(rawMega);
    if ([base, big, whale, mega].some(v => isNaN(v) || v < 0 || v > 1)) {
      await interaction.reply({
        content: "Invalid rates. Enter numbers between 0 and 100 (e.g. `56` for 56%).",
        ephemeral: true,
      });
      return;
    }
    if (!(base <= big && big <= whale && whale <= mega)) {
      await interaction.reply({
        content: "Rates must be non-decreasing: Base ≤ >49M ≤ >74M ≤ >99M.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferUpdate();
    await saveHouseRates({ base, big, whale, mega });
    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }

  if (action === "srv_modrole") {
    const roleId = interaction.fields.getTextInputValue("roleid").trim();
    if (!/^\d{17,20}$/.test(roleId)) {
      await interaction.reply({
        content: "Invalid role ID. Must be a 17-20 digit number. Right-click a role and Copy ID.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferUpdate();
    await setConfig("mod_role_id", roleId);
    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }

  if (action === "srv_setcat") {
    const VALID_KINDS = ["deposit", "withdraw", "verify", "gamble", "payment", "inviteflags"] as const;
    type ValidKind = typeof VALID_KINDS[number];
    const kind = interaction.fields.getTextInputValue("kind").trim().toLowerCase();
    const catId = interaction.fields.getTextInputValue("catid").trim();
    if (!VALID_KINDS.includes(kind as ValidKind)) {
      await interaction.reply({
        content: "Invalid kind. Must be one of: `deposit`, `withdraw`, `verify`, `gamble`, `payment`, `inviteflags`.",
        ephemeral: true,
      });
      return;
    }
    if (!/^\d{17,20}$/.test(catId)) {
      await interaction.reply({
        content: "Invalid category ID. Must be a 17-20 digit number. Right-click the category channel and Copy ID.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferUpdate();
    await setConfig(CATEGORY_CONFIG_KEYS[kind as ValidKind], catId);
    try {
      const cfg = await fetchServerConfig();
      await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    } catch {
      await interaction.followUp({ content: "Category saved.", ephemeral: true }).catch(() => null);
    }
    return;
  }

  if (action === "srv_setpaylogs") {
    const channelId = interaction.fields.getTextInputValue("channelid").trim();
    if (!/^\d{17,20}$/.test(channelId)) {
      await interaction.reply({
        content: "Invalid channel ID. Must be a 17-20 digit number. Right-click the channel and Copy ID.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferUpdate();
    await setConfig("pay_log_channel_id", channelId);
    try {
      const cfg = await fetchServerConfig();
      await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    } catch {
      await interaction.followUp({ content: "Pay logs channel saved.", ephemeral: true }).catch(() => null);
    }
    return;
  }

  if (action === "srv_sugg_setmin") {
    const raw = interaction.fields.getTextInputValue("threshold").trim();
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 100) {
      await interaction.reply({ content: "Please enter a number between 1 and 100.", ephemeral: true });
      return;
    }
    await setThreshold(n);
    await updateStickyMessage(interaction.client);
    const threshold = await getThreshold();
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setTitle("Threshold Updated")
          .setDescription(`Reaction threshold set to **${threshold}**. Sticky message refreshed.`)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (action === "srv_sugg_edit") {
    const text = interaction.fields.getTextInputValue("text").trim();
    await setStickyText(text);
    await updateStickyMessage(interaction.client);
    const threshold = await getThreshold();
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setTitle("Sticky Updated")
          .setDescription(`New sticky message saved and refreshed in <#${CHANNELS.SUGGESTIONS}>.\n\nPreview:\n${text.replace("{threshold}", String(threshold)).replace("{emoji}", "[emoji]")}`)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (action === "srv_ccreate") {
    const CODE_REGEX = /^[A-Z0-9_-]{3,32}$/i;
    const rawCode = interaction.fields.getTextInputValue("code").trim();
    const code = rawCode.toUpperCase();

    if (!CODE_REGEX.test(code)) {
      await interaction.reply({ content: "Invalid code. 3-32 chars: letters, numbers, dashes, underscores.", ephemeral: true });
      return;
    }
    const rawAmount = interaction.fields.getTextInputValue("amount").trim();
    const amount = parseAmount(rawAmount);
    if (!amount || amount <= 0n) {
      await interaction.reply({ content: "Invalid amount. Try `10m`, `1.5b`, `500k`.", ephemeral: true });
      return;
    }
    const rawMaxUses = interaction.fields.getTextInputValue("maxuses").trim();
    const maxUses = parseInt(rawMaxUses, 10);
    if (isNaN(maxUses) || maxUses < 1 || maxUses > 1_000_000) {
      await interaction.reply({ content: "Invalid max uses. Must be a number between 1 and 1,000,000.", ephemeral: true });
      return;
    }
    const rawType = interaction.fields.getTextInputValue("type").trim().toLowerCase();
    if (rawType !== "gamble" && rawType !== "nongamble") {
      await interaction.reply({ content: "Invalid type. Must be exactly `gamble` or `nongamble`.", ephemeral: true });
      return;
    }
    const rawExpires = interaction.fields.getTextInputValue("expires").trim();
    let expiresAt: Date | null = null;
    if (rawExpires) {
      const hours = parseInt(rawExpires, 10);
      if (isNaN(hours) || hours < 1) {
        await interaction.reply({ content: "Invalid expiry. Enter hours (e.g. `24`) or leave blank for never.", ephemeral: true });
        return;
      }
      expiresAt = new Date(Date.now() + hours * 3600 * 1000);
    }

    await interaction.deferUpdate();

    const coupon = await createCoupon({ code, amount, maxUses, expiresAt, createdBy: interaction.user.id, couponType: rawType });

    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Coupon Created",
      amount,
      detail: `Code: \`${code}\` · Type: ${rawType} · Max: ${maxUses}${expiresAt ? ` · Exp in ${rawExpires}h` : ""}`,
    });

    await interaction.followUp({
      ephemeral: true,
      embeds: [
        coupon
          ? new EmbedBuilder()
              .setColor(0x22c55e)
              .setTitle("Coupon Created")
              .addFields(
                { name: "Code", value: `\`${code}\``, inline: true },
                { name: "Amount", value: formatCoins(amount), inline: true },
                { name: "Type", value: rawType, inline: true },
                { name: "Max Uses", value: maxUses.toLocaleString(), inline: true },
                { name: "Expires", value: expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : "Never", inline: true },
                { name: "Total Liability", value: formatCoins(amount * BigInt(maxUses)), inline: true },
              )
          : new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle("Code Already Exists")
              .setDescription(`A coupon with code \`${code}\` already exists.`),
      ],
    });

    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }

  if (action === "srv_cdelete") {
    const code = interaction.fields.getTextInputValue("code").trim().toUpperCase();
    await interaction.deferUpdate();
    const ok = await deleteCoupon(code);
    if (ok) {
      await logAdminAction({
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        action: "Coupon Deleted",
        detail: `Code: \`${code}\``,
        good: false,
      });
    }
    await interaction.followUp({
      ephemeral: true,
      content: ok ? `Deleted coupon \`${code}\`.` : `No coupon found with code \`${code}\`.`,
    });
    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }

  if (action === "srv_setinvitelog") {
    const channelId = interaction.fields.getTextInputValue("channelid").trim();
    if (!/^\d{17,20}$/.test(channelId)) {
      await interaction.reply({
        content: "Invalid channel ID. Must be a 17-20 digit number. Right-click a channel and Copy ID.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferUpdate();
    await setConfig("invite_flag_log_channel_id", channelId);
    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }

  if (action === "srv_inviteconfig") {
    const rawCoins = interaction.fields.getTextInputValue("coins").trim();
    const rawTiers = interaction.fields.getTextInputValue("tiers").trim();

    const parsed = parseAmount(rawCoins);
    if (parsed === null || parsed <= 0n) {
      await interaction.reply({
        content: "Invalid coins value. Use a number like `5000000` or a suffix like `5m`.",
        ephemeral: true,
      });
      return;
    }

    const tierNums = rawTiers
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    if (tierNums.length === 0) {
      await interaction.reply({
        content: "Invalid tiers. Enter comma-separated positive numbers, e.g. `3,5,10,15,20,25`.",
        ephemeral: true,
      });
      return;
    }
    tierNums.sort((a, b) => a - b);

    await interaction.deferUpdate();
    await setInviteConfig({ coinsPerInvite: parsed, claimTiers: tierNums });
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Invite Config Updated",
      detail: `Coins/invite: ${formatCoins(parsed)} · Tiers: ${tierNums.join(" → ")}`,
      good: true,
    });
    const cfg = await fetchServerConfig();
    await interaction.editReply({ embeds: [buildServerEmbed(cfg)], components: buildServerComponents() });
    return;
  }
}
