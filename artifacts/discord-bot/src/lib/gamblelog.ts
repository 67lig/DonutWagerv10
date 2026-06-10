import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import { CHANNELS, WEBHOOK_URLS } from "./config.js";
import { formatCoins, formatCoinsShort } from "./format.js";
import { getConfig } from "./db.js";

let cachedClient: Client | null = null;

export function setLogClient(client: Client): void {
  cachedClient = client;
}

/** Fire-and-forget: post to a webhook URL if configured. */
async function postWebhook(url: string, content: string): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Append a one-line gamble log entry to the gambling log channel.
 * Also mirrors to WEBHOOK_URLS.GAMBLE_LOG if set.
 * Failures are swallowed — losing the log must never break a game.
 */
export async function logGamble(params: {
  discordId: string;
  game: string;
  bet: bigint;
  payout: bigint;
  won: boolean;
  detail?: string;
}): Promise<void> {
  const net = params.won ? params.payout - params.bet : params.bet;
  const verb = params.won ? "won" : "lost";
  const marker = params.won ? "✅" : "❌";
  const detail = params.detail ? ` · ${params.detail}` : "";
  const msg = `${marker} <@${params.discordId}> ${verb} ${formatCoins(net)} on **${params.game}** (bet ${formatCoins(params.bet)})${detail}`;

  void postWebhook(WEBHOOK_URLS.GAMBLE_LOG, msg);

  if (!cachedClient) return;
  try {
    const ch = await cachedClient.channels.fetch(CHANNELS.GAMBLE_LOG);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    await ch.send({ content: msg, allowedMentions: { parse: [] } });
  } catch {
    /* ignore */
  }
}

/**
 * Post a casino-withdraw vouch to the public vouches channel as a
 * polished green embed.
 */
export async function postVouch(params: {
  vouchChannelId: string;
  discordId: string;
  amount: bigint;
}): Promise<void> {
  if (!cachedClient) return;
  try {
    const ch = await cachedClient.channels.fetch(params.vouchChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) return;

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setAuthor({ name: "Casino Withdrawal" })
      .setDescription(
        `Vouch <@${params.discordId}> | **WITHDREW ${formatCoinsShort(params.amount)}** (Casino)`,
      )
      .setTimestamp(new Date());

    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    /* ignore */
  }
}

/**
 * Append a one-line entry to the dedicated withdraw-history channel.
 * Also mirrors to WEBHOOK_URLS.WITHDRAW_LOG if set.
 */
export async function logWithdraw(params: {
  discordId: string;
  staffId: string;
  staffTag: string;
  amount: bigint;
  kind: "casino" | "irl";
  usd?: number;
  detail?: string;
}): Promise<void> {
  const tag =
    params.kind === "irl"
      ? `IRL SALE · $${(params.usd ?? 0).toFixed(2)}`
      : "CASINO WITHDRAW";
  const detail = params.detail ? ` · ${params.detail}` : "";
  const msg =
    `📤 **${tag}** | <@${params.discordId}> · ` +
    `${formatCoinsShort(params.amount)} · ` +
    `staff: ${params.staffTag} (<@${params.staffId}>)${detail}`;

  void postWebhook(WEBHOOK_URLS.WITHDRAW_LOG, msg);

  if (!cachedClient) return;
  try {
    const ch = await cachedClient.channels.fetch(CHANNELS.WITHDRAW_LOG);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    await ch.send({ content: msg, allowedMentions: { parse: [] } });
  } catch {
    /* ignore */
  }
}

/**
 * Log an invite claim event (submitted / approved / denied) to the
 * configurable invite-flag log channel. Falls back to the hardcoded
 * CHANNELS.INVITE_FLAG_LOG if the DB config key is not set.
 */
export async function logInviteAction(params: {
  action: "submitted" | "approved" | "denied";
  inviterId: string;
  inviterTag: string;
  invitesCount: number;
  claimNumber: number;
  staffId?: string;
  staffTag?: string;
  detail?: string;
}): Promise<void> {
  if (!cachedClient) return;
  try {
    const overrideChannelId = await getConfig("invite_flag_log_channel_id").catch(() => null);
    const channelId = overrideChannelId ?? CHANNELS.INVITE_FLAG_LOG;

    const ch = await cachedClient.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) return;

    const colorMap = { submitted: 0xfacc15, approved: 0x22c55e, denied: 0xef4444 };
    const titleMap = {
      submitted: "📋 Invite Claim Submitted",
      approved: "✅ Invite Claim Approved",
      denied: "❌ Invite Claim Denied",
    };

    const embed = new EmbedBuilder()
      .setColor(colorMap[params.action])
      .setTitle(titleMap[params.action])
      .addFields(
        { name: "User", value: `<@${params.inviterId}> (${params.inviterTag})`, inline: true },
        { name: "Claim #", value: `${params.claimNumber}`, inline: true },
        { name: "Invites", value: `${params.invitesCount}`, inline: true },
      )
      .setTimestamp();

    if (params.staffId) {
      embed.addFields({ name: "Staff", value: `<@${params.staffId}> (${params.staffTag ?? ""})`, inline: true });
    }
    if (params.detail) {
      embed.addFields({ name: "Detail", value: params.detail, inline: false });
    }

    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    /* ignore */
  }
}

/**
 * Log a player-to-player /pay transaction to the pay log channel.
 */
export async function logPayAction(params: {
  senderId: string;
  senderTag: string;
  receiverId: string;
  receiverTag: string;
  amount: bigint;
  senderBalance: bigint;
}): Promise<void> {
  if (!cachedClient) return;
  try {
    const ch = await cachedClient.channels.fetch(CHANNELS.PAY_LOG);
    if (!ch || ch.type !== ChannelType.GuildText) return;

    const embed = new EmbedBuilder()
      .setColor(0x6b7280)
      .setTitle("Player Payment")
      .addFields(
        { name: "From", value: `<@${params.senderId}> (${params.senderTag})`, inline: true },
        { name: "To", value: `<@${params.receiverId}> (${params.receiverTag})`, inline: true },
        { name: "Amount", value: formatCoins(params.amount), inline: true },
        { name: "Sender Balance After", value: formatCoins(params.senderBalance), inline: true },
      )
      .setTimestamp();

    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    /* ignore */
  }
}

/** Default fallback admin log channel if none is configured in DB. */
const DEFAULT_ADMIN_LOG_CHANNEL = "1514111616638128229";

/**
 * Audit-log a sensitive admin / economy action.
 * Posts to the configurable admin_log_channel_id (DB key), falling back to
 * DEFAULT_ADMIN_LOG_CHANNEL. Also mirrors to WEBHOOK_URLS.ADMIN_LOG if set.
 */
export async function logAdminAction(params: {
  actorId: string;
  actorTag: string;
  action: string;
  targetId?: string;
  amount?: bigint;
  detail?: string;
  good?: boolean;
}): Promise<void> {
  if (!cachedClient) return;
  try {
    const overrideChannelId = await getConfig("admin_log_channel_id").catch(() => null);
    const channelId = overrideChannelId ?? DEFAULT_ADMIN_LOG_CHANNEL;

    const embed = new EmbedBuilder()
      .setColor(params.good === false ? 0xef4444 : 0x22c55e)
      .setTitle(params.action)
      .setTimestamp(new Date())
      .setFooter({ text: `By ${params.actorTag} (${params.actorId})` });

    const fields: { name: string; value: string; inline?: boolean }[] = [];
    if (params.targetId) {
      fields.push({ name: "Target", value: `<@${params.targetId}>`, inline: true });
    }
    if (params.amount !== undefined) {
      fields.push({ name: "Amount", value: formatCoins(params.amount), inline: true });
    }
    if (params.detail) {
      fields.push({ name: "Detail", value: params.detail, inline: false });
    }
    if (fields.length) embed.addFields(...fields);

    const ch = await cachedClient.channels.fetch(channelId);
    if (ch && ch.type === ChannelType.GuildText) {
      await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (WEBHOOK_URLS.ADMIN_LOG) {
      void postWebhook(
        WEBHOOK_URLS.ADMIN_LOG,
        `**${params.action}** by ${params.actorTag}` +
          (params.detail ? ` · ${params.detail}` : ""),
      );
    }
  } catch {
    /* ignore */
  }
}
