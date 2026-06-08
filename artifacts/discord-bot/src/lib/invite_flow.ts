import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { pool, getOrCreateUser, setConfig, getConfig, deleteConfig } from "./db.js";
import { formatCoins, formatCoinsShort } from "./format.js";
import { createTicketChannel } from "./tickets.js";
import { isMod } from "./permissions.js";
import { VOUCH_CHANNEL_ID } from "./constants.js";
import { logInviteAction } from "./gamblelog.js";

export const MEMBER_ROLE_ID = "1498005198990344322";

// ─── INVITE REWARD RATE ───────────────────────────────────────────────────────
// Change this number to adjust how many coins each valid invite is worth.
// Examples: 10_000_000n = 10m | 15_000_000n = 15m | 5_000_000n = 5m
export const COINS_PER_INVITE = 5_000_000n;
// ─────────────────────────────────────────────────────────────────────────────
// ─── CLAIM MILESTONES ─────────────────────────────────────────────────────────
// Change these numbers to adjust how many valid invites are needed per claim.
// The last number repeats for every claim beyond the list length.
export const CLAIM_TIERS = [3, 5, 10, 15, 20, 25];
// ─────────────────────────────────────────────────────────────────────────────

export function getNextClaimMin(claimCount: number, tiers?: number[]): number {
  const t = tiers ?? CLAIM_TIERS;
  return t[Math.min(claimCount, t.length - 1)] ?? t[t.length - 1] ?? 25;
}

export async function getInviteConfig(): Promise<{ coinsPerInvite: bigint; claimTiers: number[] }> {
  const [coinsStr, tiersStr] = await Promise.all([
    getConfig("invite_coins_per_invite"),
    getConfig("invite_claim_tiers"),
  ]);
  const coinsPerInvite = coinsStr ? BigInt(coinsStr) : COINS_PER_INVITE;
  const claimTiers = tiersStr
    ? tiersStr.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [...CLAIM_TIERS];
  return { coinsPerInvite, claimTiers };
}

export async function setInviteConfig(cfg: {
  coinsPerInvite?: bigint;
  claimTiers?: number[];
}): Promise<void> {
  const ops: Promise<void>[] = [];
  if (cfg.coinsPerInvite !== undefined) {
    ops.push(setConfig("invite_coins_per_invite", cfg.coinsPerInvite.toString()));
  }
  if (cfg.claimTiers !== undefined) {
    ops.push(setConfig("invite_claim_tiers", cfg.claimTiers.join(",")));
  }
  await Promise.all(ops);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Extract the UTC creation date from a Discord snowflake ID. */
function snowflakeToDate(id: string): Date {
  const ms = Number(BigInt(id) >> 22n) + 1420070400000;
  return new Date(ms);
}

/**
 * Extra WHERE conditions (after `inviter_discord_id = $1`) that define a
 * "valid" invite for claim purposes:
 *   - has the member role
 *   - still in server
 *   - not yet claimed
 *   - Discord account was ≥ 14 days old when they joined  (alt guard)
 *   - not rejoined in the last 7 days
 */
const VALID_INVITE_EXTRA = `
  AND has_member_role = TRUE
  AND left_at IS NULL
  AND claimed = FALSE
  AND (account_created_at IS NULL OR account_created_at <= joined_at - INTERVAL '14 days')
  AND (last_rejoined_at IS NULL OR last_rejoined_at < NOW() - INTERVAL '7 days')
`;

// guildId -> inviteCode -> uses
const inviteCache = new Map<string, Map<string, number>>();

export async function initInviteCache(client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      const map = new Map<string, number>();
      for (const inv of invites.values()) map.set(inv.code, inv.uses ?? 0);
      inviteCache.set(guild.id, map);
    } catch {
      // bot may lack MANAGE_GUILD
    }
  }
}

export async function handleMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) return;

  let usedCode: string | null = null;
  let inviterId: string | null = null;

  try {
    const current = await member.guild.invites.fetch();
    const cached = inviteCache.get(member.guild.id) ?? new Map<string, number>();

    for (const inv of current.values()) {
      const prev = cached.get(inv.code) ?? 0;
      if ((inv.uses ?? 0) > prev) {
        usedCode = inv.code;
        inviterId = inv.inviter?.id ?? null;
        break;
      }
    }

    // Refresh cache
    const newMap = new Map<string, number>();
    for (const inv of current.values()) newMap.set(inv.code, inv.uses ?? 0);
    inviteCache.set(member.guild.id, newMap);
  } catch {
    return;
  }

  if (!inviterId || inviterId === member.id) return;

  const hasMemberRole = member.roles.cache.has(MEMBER_ROLE_ID);
  const accountCreatedAt = snowflakeToDate(member.id);

  await pool.query(
    `INSERT INTO bot_invite_members
       (invitee_discord_id, inviter_discord_id, invite_code, has_member_role, account_created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (invitee_discord_id) DO UPDATE
       SET inviter_discord_id  = EXCLUDED.inviter_discord_id,
           invite_code         = EXCLUDED.invite_code,
           left_at             = NULL,
           has_member_role     = EXCLUDED.has_member_role,
           account_created_at  = COALESCE(bot_invite_members.account_created_at, EXCLUDED.account_created_at),
           rejoined_count      = CASE WHEN bot_invite_members.left_at IS NOT NULL
                                      THEN bot_invite_members.rejoined_count + 1
                                      ELSE bot_invite_members.rejoined_count END,
           last_rejoined_at    = CASE WHEN bot_invite_members.left_at IS NOT NULL
                                      THEN NOW()
                                      ELSE bot_invite_members.last_rejoined_at END`,
    [member.id, inviterId, usedCode, hasMemberRole, accountCreatedAt],
  );
}

export async function handleMemberRemove(
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  if (member.user?.bot) return;
  await pool.query(
    `UPDATE bot_invite_members
       SET left_at = NOW()
     WHERE invitee_discord_id = $1 AND left_at IS NULL`,
    [member.id],
  );
  try {
    const invites = await member.guild.invites.fetch();
    const newMap = new Map<string, number>();
    for (const inv of invites.values()) newMap.set(inv.code, inv.uses ?? 0);
    inviteCache.set(member.guild.id, newMap);
  } catch {
    /* ignore */
  }
}

export async function handleMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  if (newMember.user.bot) return;
  const hadRole = oldMember.roles?.cache?.has(MEMBER_ROLE_ID) ?? false;
  const hasRole = newMember.roles.cache.has(MEMBER_ROLE_ID);
  if (hadRole === hasRole) return;
  await pool.query(
    `UPDATE bot_invite_members SET has_member_role = $2 WHERE invitee_discord_id = $1`,
    [newMember.id, hasRole],
  );
}

export interface InviteStats {
  totalInvited: number;
  validUnclaimed: number;
  notVerified: number;
  leftServer: number;
  claimedAndLeft: number;
  totalClaimed: number;
  claimCount: number;
  fakeAccounts: number;
  rejoinedRecently: number;
  totalRejoined: number;
}

export async function getInviteStats(discordId: string): Promise<InviteStats> {
  const [totRes, leftRes, validRes, notVerRes, claimedLeftRes, claimedRes, countRes, fakeRes, rejoinRecentRes, rejoinTotRes] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members WHERE inviter_discord_id = $1`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1 AND left_at IS NOT NULL AND claimed = FALSE`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1 ${VALID_INVITE_EXTRA}`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1
             AND has_member_role = FALSE AND left_at IS NULL`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1 AND claimed = TRUE AND left_at IS NOT NULL`,
        [discordId],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(invites_used), 0) AS total FROM bot_invite_claims WHERE discord_id = $1`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_claims WHERE discord_id = $1`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1
             AND left_at IS NULL
             AND account_created_at IS NOT NULL
             AND account_created_at > joined_at - INTERVAL '14 days'`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1
             AND left_at IS NULL
             AND last_rejoined_at IS NOT NULL
             AND last_rejoined_at >= NOW() - INTERVAL '7 days'`,
        [discordId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bot_invite_members
           WHERE inviter_discord_id = $1
             AND rejoined_count > 0`,
        [discordId],
      ),
    ]);
  return {
    totalInvited: parseInt(totRes.rows[0]?.count ?? "0"),
    leftServer: parseInt(leftRes.rows[0]?.count ?? "0"),
    validUnclaimed: parseInt(validRes.rows[0]?.count ?? "0"),
    notVerified: parseInt(notVerRes.rows[0]?.count ?? "0"),
    claimedAndLeft: parseInt(claimedLeftRes.rows[0]?.count ?? "0"),
    totalClaimed: parseInt(claimedRes.rows[0]?.total ?? "0"),
    claimCount: parseInt(countRes.rows[0]?.count ?? "0"),
    fakeAccounts: parseInt(fakeRes.rows[0]?.count ?? "0"),
    rejoinedRecently: parseInt(rejoinRecentRes.rows[0]?.count ?? "0"),
    totalRejoined: parseInt(rejoinTotRes.rows[0]?.count ?? "0"),
  };
}

/**
 * Re-fetches the guild member object for every current invitee and syncs
 * has_member_role in the DB.  Call this before computing stats so manually-
 * granted roles are picked up even if the roleUpdate event was missed.
 */
export async function refreshInviteeMemberRoles(
  guild: Guild,
  inviterId: string,
): Promise<void> {
  const res = await pool.query<{ invitee_discord_id: string }>(
    `SELECT invitee_discord_id FROM bot_invite_members
     WHERE inviter_discord_id = $1 AND left_at IS NULL`,
    [inviterId],
  );
  if (res.rows.length === 0) return;

  const ids = res.rows.map((r) => r.invitee_discord_id);

  // Use individual REST fetches (GET /guilds/{id}/members/{user}) — fast and
  // reliable. guild.members.fetch({ user: ids[] }) uses the WebSocket gateway
  // and can hang indefinitely waiting for a GUILD_MEMBERS_CHUNK event.
  const results = await Promise.allSettled(
    ids.map((id) => guild.members.fetch(id)),
  );

  await Promise.allSettled(
    results.flatMap((r) =>
      r.status === "fulfilled"
        ? [
            pool.query(
              `UPDATE bot_invite_members SET has_member_role = $2
               WHERE invitee_discord_id = $1 AND left_at IS NULL`,
              [r.value.id, r.value.roles.cache.has(MEMBER_ROLE_ID)],
            ),
          ]
        : [],
    ),
  );
}

export interface InviteMemberRow {
  invitee_discord_id: string;
  invite_code: string | null;
  joined_at: Date;
  left_at: Date | null;
  has_member_role: boolean;
  claimed: boolean;
}

export async function getInviteList(discordId: string): Promise<InviteMemberRow[]> {
  const r = await pool.query<InviteMemberRow>(
    `SELECT invitee_discord_id, invite_code, joined_at, left_at, has_member_role, claimed
       FROM bot_invite_members
       WHERE inviter_discord_id = $1
       ORDER BY joined_at DESC`,
    [discordId],
  );
  return r.rows;
}

export async function processInviteClaim(discordId: string): Promise<
  | { ok: true; invitesUsed: number; coinsAwarded: bigint; claimNumber: number }
  | { ok: false; reason: string }
> {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");

    const invConfig = await getInviteConfig();
    const ccRes = await conn.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM bot_invite_claims WHERE discord_id = $1`,
      [discordId],
    );
    const claimCount = parseInt(ccRes.rows[0]?.count ?? "0");
    const nextMin = getNextClaimMin(claimCount, invConfig.claimTiers);

    const validRes = await conn.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT invitee_discord_id FROM bot_invite_members
           WHERE inviter_discord_id = $1 ${VALID_INVITE_EXTRA}
           FOR UPDATE
       ) sub`,
      [discordId],
    );
    const validCount = parseInt(validRes.rows[0]?.count ?? "0");

    const deductRes = await conn.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM bot_invite_members
         WHERE inviter_discord_id = $1 AND claimed = TRUE AND left_at IS NOT NULL`,
      [discordId],
    );
    const deducted = parseInt(deductRes.rows[0]?.count ?? "0");
    const effectiveValid = validCount - deducted;

    if (effectiveValid < nextMin) {
      await conn.query("ROLLBACK");
      const msg =
        deducted > 0
          ? `Net valid invites: **${effectiveValid}** (${validCount} valid − ${deducted} previously claimed who left). Need **${nextMin}**.`
          : `Need **${nextMin}** valid unclaimed invites — you have **${validCount}**.`;
      return { ok: false, reason: msg };
    }

    await conn.query(
      `UPDATE bot_invite_members SET claimed = TRUE
         WHERE inviter_discord_id = $1 ${VALID_INVITE_EXTRA}`,
      [discordId],
    );

    const coinsAwarded = invConfig.coinsPerInvite * BigInt(validCount);
    const claimNumber = claimCount + 1;

    await conn.query(
      `INSERT INTO bot_invite_claims (discord_id, claim_number, invites_used, coins_awarded)
         VALUES ($1, $2, $3, $4)`,
      [discordId, claimNumber, validCount, coinsAwarded.toString()],
    );
    await conn.query(
      `INSERT INTO bot_users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [discordId],
    );
    await conn.query(
      `UPDATE bot_users SET balance = balance + $2 WHERE discord_id = $1`,
      [discordId, coinsAwarded.toString()],
    );
    await conn.query(
      `INSERT INTO bot_balance_ledger (discord_id, delta, source, detail)
         VALUES ($1, $2, 'invite', $3)`,
      [discordId, coinsAwarded.toString(), `Claim #${claimNumber} — ${validCount} invites`],
    );

    await conn.query("COMMIT");
    return { ok: true, invitesUsed: validCount, coinsAwarded, claimNumber };
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    console.error("[invites] claim failed:", err);
    return { ok: false, reason: "An error occurred. Please try again." };
  } finally {
    conn.release();
  }
}

const DEPOSIT_LOG_CHANNEL_IDS = ["1498419875021066240", "1498440931026927817"];

interface PendingClaim {
  inviteeIds: string[];
  invitesUsed: number;
  claimNumber: number;
}

async function finalizeClaim(
  discordId: string,
  invitesUsed: number,
  claimNumber: number,
  coinsPerInvite: bigint,
): Promise<bigint> {
  const coinsAwarded = coinsPerInvite * BigInt(invitesUsed);
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await conn.query(
      `INSERT INTO bot_users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [discordId],
    );
    await conn.query(
      `UPDATE bot_users SET balance = balance + $2 WHERE discord_id = $1`,
      [discordId, coinsAwarded.toString()],
    );
    await conn.query(
      `INSERT INTO bot_balance_ledger (discord_id, delta, source, detail) VALUES ($1, $2, 'invite', $3)`,
      [discordId, coinsAwarded.toString(), `Claim #${claimNumber} — ${invitesUsed} invites`],
    );
    await conn.query(
      `INSERT INTO bot_invite_claims (discord_id, claim_number, invites_used, coins_awarded) VALUES ($1, $2, $3, $4)`,
      [discordId, claimNumber, invitesUsed, coinsAwarded.toString()],
    );
    await conn.query("COMMIT");
    return coinsAwarded;
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function handleInviteButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const targetId = parts[2];

  // ── Claim ─────────────────────────────────────────────────────────────────
  if (action === "claim") {
    if (!interaction.guild) {
      await interaction.reply({ content: "Use this in a server.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const claimUser = await getOrCreateUser(interaction.user.id);
    if (!claimUser.verified || !claimUser.minecraft_username) {
      await interaction.editReply({
        content:
          "You must verify your Minecraft account in <#1497805898977120369> before claiming invite rewards.\n" +
          "Open the panel, tap **Settings**, and link your IGN first.",
      });
      return;
    }

    const invCfg = await getInviteConfig();
    const stats = await getInviteStats(interaction.user.id);
    const nextMin = getNextClaimMin(stats.claimCount, invCfg.claimTiers);
    const netValid = stats.validUnclaimed - stats.claimedAndLeft;
    if (netValid < nextMin) {
      await interaction.editReply({
        content:
          stats.claimedAndLeft > 0
            ? `Net valid invites: **${netValid}** (${stats.validUnclaimed} valid − ${stats.claimedAndLeft} deducted). Need **${nextMin}**.`
            : `You need at least **${nextMin}** valid unclaimed invites. You have **${stats.validUnclaimed}**.`,
      });
      return;
    }

    // Lock invites immediately so they can't be claimed twice
    const lockRes = await pool.query<{ invitee_discord_id: string }>(
      `UPDATE bot_invite_members SET claimed = TRUE
         WHERE inviter_discord_id = $1 ${VALID_INVITE_EXTRA}
         RETURNING invitee_discord_id`,
      [interaction.user.id],
    );
    const inviteeIds = lockRes.rows.map((r) => r.invitee_discord_id);
    const invitesLocked = inviteeIds.length;
    const claimNumber = stats.claimCount + 1;

    if (invitesLocked === 0) {
      await interaction.editReply({ content: "No valid invites to lock. Please try again." });
      return;
    }

    // Store pending claim so approve/deny can finalize or revert
    await setConfig(
      `invite_pending_${interaction.user.id}`,
      JSON.stringify({ inviteeIds, invitesUsed: invitesLocked, claimNumber } satisfies PendingClaim),
    );

    const coinsToAward = invCfg.coinsPerInvite * BigInt(invitesLocked);
    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: "invite",
      topic: `Invite claim — ${invitesLocked} invites`,
      allowAttachments: false,
    });
    if (!ticket) {
      // Revert lock on ticket creation failure
      await pool.query(
        `UPDATE bot_invite_members SET claimed = FALSE WHERE invitee_discord_id = ANY($1)`,
        [inviteeIds],
      );
      await deleteConfig(`invite_pending_${interaction.user.id}`);
      await interaction.editReply({ content: "Couldn't create the claim ticket. Contact a moderator." });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xfacc15)
      .setTitle("Invite Claim Request")
      .setDescription(`<@${interaction.user.id}> is requesting their invite reward.`)
      .addFields(
        { name: "User", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Valid Invites", value: `${invitesLocked}`, inline: true },
        { name: "Coins to Award", value: formatCoins(coinsToAward), inline: true },
        { name: "Claim #", value: `${claimNumber}`, inline: true },
        { name: "Status", value: "Invites locked — awaiting staff review", inline: false },
      )
      .setTimestamp()
      .setFooter({ text: "Verify the invites are legitimate before approving." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`invite:approve:${interaction.user.id}`)
        .setLabel("Approve & Pay")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`invite:deny:${interaction.user.id}`)
        .setLabel("Deny & Return")
        .setStyle(ButtonStyle.Danger),
    );

    const mention = ticket.modRoleId
      ? `<@${interaction.user.id}> · <@&${ticket.modRoleId}>`
      : `<@${interaction.user.id}>`;
    await ticket.channel.send({ content: mention, embeds: [embed], components: [row] });
    void logInviteAction({
      action: "submitted",
      inviterId: interaction.user.id,
      inviterTag: interaction.user.tag,
      invitesCount: invitesLocked,
      claimNumber,
    });
    await interaction.editReply({
      content: `Claim ticket opened: <#${ticket.channel.id}>\nYour **${invitesLocked}** invite${invitesLocked !== 1 ? "s" : ""} are locked pending staff review. Your \`/invites\` will show 0 until this is resolved.`,
    });
    return;
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  if (action === "approve" && targetId) {
    if (!(await isMod(interaction))) {
      await interaction.reply({ content: "Only staff can approve claims.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();

    const pendingRaw = await getConfig(`invite_pending_${targetId}`);
    if (!pendingRaw) {
      await interaction.followUp({
        content: "No pending claim found for this user — it may have already been processed.",
        ephemeral: true,
      });
      return;
    }
    const pending = JSON.parse(pendingRaw) as PendingClaim;

    const approveCfg = await getInviteConfig();
    let coinsAwarded: bigint;
    try {
      coinsAwarded = await finalizeClaim(targetId, pending.invitesUsed, pending.claimNumber, approveCfg.coinsPerInvite);
    } catch {
      await interaction.followUp({ content: "Database error while processing payout. Contact a developer.", ephemeral: true });
      return;
    }
    await deleteConfig(`invite_pending_${targetId}`);

    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    const approvedEmbed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Invite Claim Approved")
      .setDescription(`**${targetUser?.tag ?? targetId}**'s invite reward has been paid out.`)
      .addFields(
        { name: "User", value: `<@${targetId}>`, inline: true },
        { name: "Invites Paid", value: `${pending.invitesUsed}`, inline: true },
        { name: "Coins Awarded", value: formatCoins(coinsAwarded), inline: true },
        { name: "Claim #", value: `${pending.claimNumber}`, inline: true },
        { name: "Approved By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Approved by ${interaction.user.tag}` });

    await interaction.editReply({ embeds: [approvedEmbed], components: [] });
    void logInviteAction({
      action: "approved",
      inviterId: targetId,
      inviterTag: targetUser?.tag ?? targetId,
      invitesCount: pending.invitesUsed,
      claimNumber: pending.claimNumber,
      staffId: interaction.user.id,
      staffTag: interaction.user.tag,
      detail: `Awarded ${formatCoins(coinsAwarded)}`,
    });

    if (interaction.channel && "send" in interaction.channel) {
      await interaction.channel.send(
        `<@${targetId}> **${formatCoins(coinsAwarded)}** (${pending.invitesUsed} invite${pending.invitesUsed !== 1 ? "s" : ""} × ${formatCoinsShort(approveCfg.coinsPerInvite)}) has been added to your balance!`,
      );
    }

    for (const channelId of DEPOSIT_LOG_CHANNEL_IDS) {
      try {
        const logChannel = await interaction.client.channels.fetch(channelId);
        if (logChannel?.isTextBased() && "send" in logChannel) {
          await (logChannel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [approvedEmbed] });
        }
      } catch {
        // channel unreachable — payout still went through
      }
    }

    // Post a clean vouch to the vouch channel.
    const vouchEmbed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Invite Reward Vouch")
      .addFields(
        { name: "User", value: `<@${targetId}>`, inline: true },
        { name: "Invites Paid", value: `${pending.invitesUsed}`, inline: true },
        { name: "Coins Rewarded", value: formatCoins(coinsAwarded), inline: true },
        { name: "Claim #", value: `${pending.claimNumber}`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Approved by ${interaction.user.tag}` });

    try {
      const vouchChannel = await interaction.client.channels.fetch(VOUCH_CHANNEL_ID);
      if (vouchChannel?.isTextBased() && "send" in vouchChannel) {
        await (vouchChannel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [vouchEmbed] });
      }
    } catch {
      // vouch channel unreachable — payout still went through
    }
    return;
  }

  // ── Deny ──────────────────────────────────────────────────────────────────
  if (action === "deny" && targetId) {
    if (!(await isMod(interaction))) {
      await interaction.reply({ content: "Only staff can deny claims.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();

    const pendingRaw = await getConfig(`invite_pending_${targetId}`);
    let deniedPending: PendingClaim | null = null;
    if (pendingRaw) {
      deniedPending = JSON.parse(pendingRaw) as PendingClaim;
      // Revert the locked invites so the user can try again
      await pool.query(
        `UPDATE bot_invite_members SET claimed = FALSE WHERE invitee_discord_id = ANY($1)`,
        [deniedPending.inviteeIds],
      );
      await deleteConfig(`invite_pending_${targetId}`);
    }

    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (deniedPending) {
      void logInviteAction({
        action: "denied",
        inviterId: targetId,
        inviterTag: targetUser?.tag ?? targetId,
        invitesCount: deniedPending.invitesUsed,
        claimNumber: deniedPending.claimNumber,
        staffId: interaction.user.id,
        staffTag: interaction.user.tag,
      });
    }
    const deniedEmbed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("❌ Invite Claim Denied")
      .setDescription(`**${targetUser?.tag ?? targetId}**'s invite claim was denied. Their invites have been returned.`)
      .addFields(
        { name: "👤 User", value: `<@${targetId}>`, inline: true },
        { name: "❌ Denied By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Denied by ${interaction.user.tag}` });

    await interaction.editReply({ embeds: [deniedEmbed], components: [] });

    if (interaction.channel && "send" in interaction.channel) {
      await interaction.channel.send(
        `<@${targetId}> your invite claim was denied and your invites have been returned. Contact a moderator for more info.`,
      );
    }
    return;
  }
}
