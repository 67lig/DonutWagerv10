import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import {
  getPendingWithdrawalByChannel,
  markPendingWithdrawalPaid,
  getOrCreateUser,
  recordBalanceEvent,
} from "../lib/db.js";
import { formatCoins } from "../lib/format.js";
import { isModOrOwner } from "../lib/permissions.js";
import { PAID_TICKET_PREFIX, VOUCH_CHANNEL_ID } from "../lib/constants.js";
import { logAdminAction, logWithdraw, postVouch } from "../lib/gamblelog.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("withdraw")
    .setDescription("Mark the pending withdrawal in this channel as paid")
    .setDefaultMemberPermissions(0n)
    .addUserOption((o) =>
      o.setName("user").setDescription("User to pay out").setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isModOrOwner(interaction)) {
      await interaction.reply({ content: "Staff only.", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);

    const pending = interaction.channelId
      ? await getPendingWithdrawalByChannel(interaction.channelId)
      : null;

    if (!pending || pending.status !== "pending" || pending.discord_id !== target.id) {
      await interaction.reply({
        content: `No pending withdrawal found for <@${target.id}> in this channel.`,
        ephemeral: true,
      });
      return;
    }

    const amount = BigInt(pending.amount);
    const flipped = await markPendingWithdrawalPaid(pending.id);
    if (!flipped) {
      await interaction.reply({ content: "Withdrawal already processed.", ephemeral: true });
      return;
    }

    const u = await getOrCreateUser(target.id);
    const newBal = BigInt(u.balance);

    await recordBalanceEvent({
      discordId: target.id,
      delta: 0n,
      source: "irlwithdraw",
      detail: `Casino payout by ${interaction.user.tag}`,
    });

    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Casino Withdrawal Paid",
      targetId: target.id,
      amount,
      detail: `Remaining balance: ${formatCoins(newBal)}`,
    });

    await logWithdraw({
      discordId: target.id,
      staffId: interaction.user.id,
      staffTag: interaction.user.tag,
      amount,
      kind: "casino",
    });

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Withdrawal Paid")
          .setDescription(
            `Paid out ${formatCoins(amount)} to <@${target.id}>.\nRemaining balance: ${formatCoins(newBal)}`,
          )
          .setFooter({ text: `Paid by ${interaction.user.tag}` })
          .setTimestamp(),
      ],
    });

    await postVouch({ vouchChannelId: VOUCH_CHANNEL_ID, discordId: target.id, amount });

    const ch = interaction.channel;
    if (
      ch &&
      "name" in ch &&
      typeof ch.name === "string" &&
      ch.name.startsWith("withdraw-") &&
      "setName" in ch
    ) {
      const newName = `${PAID_TICKET_PREFIX}${ch.name.slice("withdraw-".length)}`.slice(0, 90);
      try {
        await (ch as TextChannel).setName(newName);
        await (ch as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x22c55e)
              .setTitle("Ticket Locked")
              .setDescription(
                "Payout is complete. Only moderators can close this ticket from here.",
              ),
          ],
        });
      } catch {
        /* ignore rename failures */
      }
    }
  },
};

export default command;
