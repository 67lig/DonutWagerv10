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
} from "discord.js";
import { isModOrOwner, isFullOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";
import {
  adjustBalance,
  getOrCreateUser,
  recordBalanceEvent,
  getBalanceHistory,
  getGameHistory,
  pool,
} from "../lib/db.js";
import { formatCoins, formatCoinsShort, parseAmount } from "../lib/format.js";
import { logAdminAction, logWithdraw, postVouch } from "../lib/gamblelog.js";
import { DEPOSIT_LOG_CHANNEL_IDS } from "../lib/config.js";
import { VOUCH_CHANNEL_ID } from "../lib/constants.js";
import { setSecondOwnerIdCache, getSecondOwnerId } from "../lib/owners.js";
import { setConfig } from "../lib/db.js";

export const SP_BTN_PREFIX = "gp";
export const SP_MODAL_PREFIX = "gp_modal";

interface PendingRow {
  id: string;
  discord_id: string;
  channel_id: string;
  amount: string;
  created_at: Date;
}

async function fetchPending(): Promise<PendingRow[]> {
  const r = await pool.query<PendingRow>(
    `SELECT id, discord_id, channel_id, amount, created_at
       FROM bot_pending_deposits
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 20`,
  );
  return r.rows;
}

const HIST_SOURCE_LABEL: Record<string, string> = {
  coupon: "Coupon", daily: "Daily", admin: "Admin",
  deposit: "Deposit", invite: "Invite", withdraw: "Withdraw",
  irlwithdraw: "IRL Sale",
};

function histFormatTime(d: Date): string {
  return `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
}
function histFormatDelta(deltaStr: string): string {
  const n = BigInt(deltaStr);
  return n >= 0n ? `+${formatCoinsShort(n)}` : `-${formatCoinsShort(-n)}`;
}

function buildQueueEmbed(rows: PendingRow[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x6b7280)
    .setTitle("Server Panel - Deposit Queue")
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription("No pending deposits.");
    return embed;
  }

  const lines = rows.map((r) => {
    const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
    return `<@${r.discord_id}> - **${formatCoins(BigInt(r.amount))}** - <t:${ts}:R> - <#${r.channel_id}>`;
  });

  embed.setDescription(lines.join("\n"));
  return embed;
}

function buildQueueComponents(showOwnerWidget = false): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:approve`)
        .setLabel("Approve Deposit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:deny`)
        .setLabel("Deny Deposit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:deposit`)
        .setLabel("Direct Deposit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:refresh`)
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:balhistory`)
        .setLabel("Balance History")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:gamehistory`)
        .setLabel("Game History")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${SP_BTN_PREFIX}:markpaid`)
        .setLabel("Mark Paid")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (showOwnerWidget) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${SP_BTN_PREFIX}:set2ndowner`)
          .setLabel("Set 2nd Owner")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return rows;
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("serverpanel")
    .setDescription(".")
    .setDefaultMemberPermissions(0n),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isModOrOwner(interaction)) {
      await interaction.reply({ content: "Staff only.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const rows = await fetchPending();
    await interaction.editReply({
      embeds: [buildQueueEmbed(rows)],
      components: buildQueueComponents(isFullOwner(interaction)),
    });
  },
};

export default command;

export async function handleServerPanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isModOrOwner(interaction)) {
    await interaction.reply({ content: "Staff only.", ephemeral: true });
    return;
  }

  const action = interaction.customId.split(":")[1];

  if (action === "approve") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:approve`)
      .setTitle("Approve Deposit");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID (right-click user -> Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount to credit (e.g. 10m, 500k)")
          .setPlaceholder("50m")
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "deny") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:deny`)
      .setTitle("Deny Deposit");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID")
          .setPlaceholder("123456789012345678")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason for denial")
          .setPlaceholder("Payment not received")
          .setMinLength(1)
          .setMaxLength(200)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "deposit") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:deposit`)
      .setTitle("Direct Deposit");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID")
          .setPlaceholder("123456789012345678")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount to deposit (e.g. 10m, 500k)")
          .setPlaceholder("50m")
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "balhistory") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:balhistory`)
      .setTitle("Balance History");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID (right-click user -> Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17).setMaxLength(20).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "gamehistory") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:gamehistory`)
      .setTitle("Game History");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID (right-click user -> Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17).setMaxLength(20).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "markpaid") {
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:markpaid`)
      .setTitle("Mark Withdrawal Paid");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("userid")
          .setLabel("User ID (right-click user -> Copy ID)")
          .setPlaceholder("123456789012345678")
          .setMinLength(17).setMaxLength(20).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount to debit (e.g. 500m, 1bil)")
          .setPlaceholder("500m")
          .setMinLength(1).setMaxLength(20).setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "set2ndowner") {
    if (!isFullOwner(interaction)) {
      await interaction.reply({ content: "Only the Full Owner can set a 2nd owner.", ephemeral: true });
      return;
    }
    const currentId = getSecondOwnerId();
    const modal = new ModalBuilder()
      .setCustomId(`${SP_MODAL_PREFIX}:set2ndowner`)
      .setTitle("Set 2nd Owner");
    const userIdInput = new TextInputBuilder()
      .setCustomId("userid")
      .setLabel("Discord User ID of new 2nd owner")
      .setPlaceholder(currentId ?? "123456789012345678")
      .setMinLength(17)
      .setMaxLength(20)
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
    if (currentId) userIdInput.setValue(currentId);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(userIdInput),
    );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();
  const rows = await fetchPending();
  await interaction.editReply({
    embeds: [buildQueueEmbed(rows)],
    components: buildQueueComponents(isFullOwner(interaction)),
  });
}

export async function handleServerPanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!isModOrOwner(interaction)) {
    await interaction.reply({ content: "Staff only.", ephemeral: true });
    return;
  }

  const action = interaction.customId.split(":")[1];

  if (action === "set2ndowner") {
    if (!isFullOwner(interaction)) {
      await interaction.reply({ content: "Only the Full Owner can set a 2nd owner.", ephemeral: true });
      return;
    }
    const userId = interaction.fields.getTextInputValue("userid").trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID — must be a 17–20 digit number.", ephemeral: true });
      return;
    }
    await setConfig("second_owner_id", userId);
    setSecondOwnerIdCache(userId);
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle("2nd Owner Updated")
          .setDescription(`<@${userId}> now has full owner commands.\nThey cannot change this setting.`)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (action === "approve" || action === "deposit") {
    const userId = interaction.fields.getTextInputValue("userid").trim();
    const rawAmount = interaction.fields.getTextInputValue("amount").trim();

    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID - must be a 17-20 digit number.", ephemeral: true });
      return;
    }
    const amount = parseAmount(rawAmount);
    if (!amount || amount <= 0n) {
      await interaction.reply({ content: "Invalid amount - try `10m`, `500k`, `1bil`.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    await getOrCreateUser(userId);
    const newBal = await adjustBalance(userId, amount);
    await recordBalanceEvent({
      discordId: userId,
      delta: amount,
      source: "deposit",
      detail: action === "approve"
        ? `Deposit approved by ${interaction.user.tag}`
        : `Direct deposit by ${interaction.user.tag}`,
    });
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: action === "approve" ? "Deposit Approved" : "Direct Deposit",
      targetId: userId,
      amount,
      detail: `New balance: ${formatCoins(newBal)}`,
    });

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle(action === "approve" ? "Deposit Approved" : "Direct Deposit")
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "New Balance", value: formatCoins(newBal), inline: true },
        { name: "By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.followUp({ embeds: [embed], ephemeral: true });

    for (const channelId of DEPOSIT_LOG_CHANNEL_IDS) {
      try {
        const ch = await interaction.client.channels.fetch(channelId);
        if (ch?.isTextBased() && "send" in ch) {
          await (ch as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [embed] });
        }
      } catch { /* ignore */ }
    }

    if (action === "approve") {
      await pool.query(
        `UPDATE bot_pending_deposits SET status = 'completed', resolved_at = NOW()
           WHERE discord_id = $1 AND status = 'pending'`,
        [userId],
      );
    }

    const rows = await fetchPending();
    await interaction.editReply({ embeds: [buildQueueEmbed(rows)], components: buildQueueComponents() });
    return;
  }

  if (action === "balhistory") {
    const userId = interaction.fields.getTextInputValue("userid").trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID - must be a 17-20 digit number.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const events = await getBalanceHistory(userId, 15);
    if (events.length === 0) {
      await interaction.followUp({
        ephemeral: true,
        embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle("Balance History").setDescription(`No balance history for <@${userId}>.`)],
      });
      return;
    }
    const lines = events.map((e) => {
      const label = HIST_SOURCE_LABEL[e.source] ?? e.source;
      const delta = histFormatDelta(e.delta);
      const detail = e.detail ? ` - ${e.detail}` : "";
      return `${label} · **${delta}** · ${histFormatTime(e.created_at)}${detail}`;
    });
    await interaction.followUp({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`Balance History - <@${userId}>`)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({ text: "Last 15 non-game balance events" })],
    });
    return;
  }

  if (action === "gamehistory") {
    const userId = interaction.fields.getTextInputValue("userid").trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID - must be a 17-20 digit number.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const games = await getGameHistory(userId, 15);
    if (games.length === 0) {
      await interaction.followUp({
        ephemeral: true,
        embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle("Game History").setDescription(`No game history for <@${userId}>.`)],
      });
      return;
    }
    const lines = games.map((g) => {
      const bet = BigInt(g.bet);
      const payout = BigInt(g.payout);
      const net = g.won ? payout - bet : -bet;
      const marker = g.won ? "[W]" : "[L]";
      const verb = g.won ? "won" : "lost";
      return `${marker} **${g.game}** · ${verb} **${formatCoinsShort(net < 0n ? -net : net)}** (bet ${formatCoinsShort(bet)}) · ${histFormatTime(g.created_at)}`;
    });
    await interaction.followUp({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`Game History - <@${userId}>`)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({ text: "Last 15 games" })],
    });
    return;
  }

  if (action === "markpaid") {
    const userId = interaction.fields.getTextInputValue("userid").trim();
    const rawAmount = interaction.fields.getTextInputValue("amount").trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID - must be a 17-20 digit number.", ephemeral: true });
      return;
    }
    const amount = parseAmount(rawAmount);
    if (!amount || amount <= 0n) {
      await interaction.reply({ content: "Invalid amount - try `500m`, `1bil`.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const u = await getOrCreateUser(userId);
    if (BigInt(u.balance) < amount) {
      await interaction.followUp({ ephemeral: true, content: `User only has ${formatCoins(BigInt(u.balance))}.` });
      return;
    }
    const newBal = await adjustBalance(userId, -amount);
    await recordBalanceEvent({ discordId: userId, delta: -amount, source: "withdraw", detail: `Casino payout via panel by ${interaction.user.tag}` });
    await logAdminAction({ actorId: interaction.user.id, actorTag: interaction.user.tag, action: "Casino Withdrawal Paid", targetId: userId, amount, detail: `Remaining balance: ${formatCoins(newBal)}` });
    await logWithdraw({ discordId: userId, staffId: interaction.user.id, staffTag: interaction.user.tag, amount, kind: "casino" });
    await postVouch({ vouchChannelId: VOUCH_CHANNEL_ID, discordId: userId, amount });
    await interaction.followUp({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle("Withdrawal Paid")
        .addFields(
          { name: "User", value: `<@${userId}>`, inline: true },
          { name: "Amount", value: formatCoins(amount), inline: true },
          { name: "Remaining Balance", value: formatCoins(newBal), inline: true },
          { name: "By", value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp()],
    });
    return;
  }

  if (action === "deny") {
    const userId = interaction.fields.getTextInputValue("userid").trim();
    const reason = interaction.fields.getTextInputValue("reason").trim();

    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: "Invalid user ID - must be a 17-20 digit number.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    await pool.query(
      `UPDATE bot_pending_deposits SET status = 'cancelled', resolved_at = NOW()
         WHERE discord_id = $1 AND status = 'pending'`,
      [userId],
    );

    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("Deposit Denied")
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Reason", value: reason, inline: false },
        { name: "By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.followUp({ embeds: [embed], ephemeral: false });

    const rows = await fetchPending();
    await interaction.editReply({ embeds: [buildQueueEmbed(rows)], components: buildQueueComponents() });
    return;
  }
}
