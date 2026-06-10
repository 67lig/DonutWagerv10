import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type TextChannel,
} from "discord.js";
import {
  adjustBalance,
  confirmPendingWithdrawalIgn,
  getPendingWithdrawalById,
  markPendingWithdrawalCancelled,
  recordBalanceEvent,
} from "./db.js";
import { formatCoins } from "./format.js";
import { logAdminAction } from "./gamblelog.js";

export const WITHDRAW_BTN_PREFIX = "withdraw_pending";

/** Build the embed shown inside a withdraw ticket. */
export function buildWithdrawEmbed(params: {
  amount: bigint;
  ign: string;
  ignConfirmed: boolean;
}): { embed: EmbedBuilder } {
  const { amount, ign, ignConfirmed } = params;
  const embed = new EmbedBuilder()
    .setColor(ignConfirmed ? 0x22c55e : 0xfacc15)
    .setTitle("Withdrawal Request")
    .setDescription(
      ignConfirmed
        ? `Please wait for somebody to pay you in-game on **DonutSMP**. Staff will pay **\`${ign}\`** exactly.`
        : `Please wait for somebody to pay you. Your IGN is **\`${ign}\`**. Is that correct? If not, **Cancel** and tell a staff member.`,
    )
    .addFields(
      { name: "Amount", value: formatCoins(amount), inline: true },
      {
        name: "Status",
        value: ignConfirmed
          ? "✅ IGN confirmed. Awaiting staff payout"
          : "⏳ Confirm your IGN below",
        inline: true,
      },
      {
        name: "After staff pay you",
        value:
          "A moderator will run `/withdraw @user` here to log the payout, your `/vouch` command will still work as normal.",
      },
    )
    .setFooter({
      text: "Cancel any time before payout to refund your balance.",
    });
  return { embed };
}

export function buildWithdrawComponents(params: {
  pendingId: string;
  ignConfirmed: boolean;
}): ActionRowBuilder<ButtonBuilder>[] {
  const { pendingId, ignConfirmed } = params;
  if (ignConfirmed) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${WITHDRAW_BTN_PREFIX}:cancel:${pendingId}`)
          .setLabel("Cancel & Refund")
          .setStyle(ButtonStyle.Danger),
      ),
    ];
  }
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${WITHDRAW_BTN_PREFIX}:yes:${pendingId}`)
        .setLabel("Yes, that's my IGN")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${WITHDRAW_BTN_PREFIX}:cancel:${pendingId}`)
        .setLabel("Cancel & Refund")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export async function handleWithdrawButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  // withdraw_pending:<action>:<pendingId>
  const action = parts[1];
  const pendingId = parts[2];
  if (!action || !pendingId) return;

  // Defer the component update FIRST. This consumes the click immediately
  // so a Discord-side double-fire (or impatient user double-click) cannot
  // race two refund handlers against the same pending row.
  try {
    await interaction.deferUpdate();
  } catch {
    // Already acked — bail out so we don't double-process.
    return;
  }

  const pending = await getPendingWithdrawalById(pendingId);
  if (!pending) {
    await interaction.followUp({
      content: "This withdrawal is no longer active.",
      ephemeral: true,
    });
    return;
  }
  if (interaction.user.id !== pending.discord_id) {
    await interaction.followUp({
      content: "Only the requester can use these buttons.",
      ephemeral: true,
    });
    return;
  }
  if (pending.status !== "pending") {
    await interaction.followUp({
      content: `This withdrawal is already **${pending.status}**.`,
      ephemeral: true,
    });
    return;
  }

  const amount = BigInt(pending.amount);

  if (action === "yes") {
    await confirmPendingWithdrawalIgn(pendingId);
    const { embed } = buildWithdrawEmbed({
      amount,
      ign: pending.ign,
      ignConfirmed: true,
    });
    const components = buildWithdrawComponents({
      pendingId,
      ignConfirmed: true,
    });
    try {
      await interaction.editReply({ embeds: [embed], components });
    } catch {
      /* ignore */
    }
    await interaction.followUp({
      content: `Confirmed. Staff will pay **\`${pending.ign}\`** in-game.`,
      ephemeral: true,
    });
    return;
  }

  if (action === "cancel") {
    // Atomic flip: the DB only refunds the row that was still 'pending'.
    // If two clicks land at once, only one returns true, so only one refund.
    const flipped = await markPendingWithdrawalCancelled(pendingId);
    if (!flipped) {
      await interaction.followUp({
        content: "This withdrawal was already cancelled.",
        ephemeral: true,
      });
      return;
    }

    const newBalance = await adjustBalance(pending.discord_id, amount);
    await recordBalanceEvent({
      discordId: pending.discord_id,
      delta: amount,
      source: "withdraw",
      detail: `Refund — withdrawal cancelled in <#${pending.channel_id}>`,
    });
    void logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Withdrawal Cancelled",
      targetId: pending.discord_id,
      amount,
      detail: `Refunded — cancelled in <#${pending.channel_id}>. New balance: ${formatCoins(newBalance)}`,
      good: false,
    });

    const cancelEmbed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("Withdrawal Cancelled")
      .setDescription(
        `Your withdrawal was cancelled. **${formatCoins(amount)}** has been refunded.`,
      )
      .addFields({
        name: "New Balance",
        value: formatCoins(newBalance),
      })
      .setFooter({ text: "This channel will close in 10 seconds." });

    try {
      await interaction.editReply({
        embeds: [cancelEmbed],
        components: [],
      });
    } catch {
      /* ignore */
    }

    const ch = interaction.channel;
    if (ch && ch.type === ChannelType.GuildText) {
      const channel = ch as TextChannel;
      setTimeout(() => {
        channel.delete("Withdrawal cancelled — auto-close").catch(() => {});
      }, 10_000);
    }
    return;
  }
}
