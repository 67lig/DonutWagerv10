import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import {
  adjustBalance,
  getOrCreateUser,
  getPendingWithdrawalByChannel,
  markPendingWithdrawalPaid,
  recordBalanceEvent,
} from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import type { SlashCommand } from "../lib/types.js";
import { isModOrOwner, isWithdrawStaff } from "../lib/permissions.js";
import {
  PAID_TICKET_PREFIX,
  VOUCH_CHANNEL_ID,
} from "../lib/constants.js";
import {
  logAdminAction,
  logWithdraw,
  postVouch,
} from "../lib/gamblelog.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Moderator-only administrative commands")
    .setDefaultMemberPermissions(0n)
    .addSubcommand((sc) =>
      sc
        .setName("withdraw")
        .setDescription("Mark a casino withdrawal as paid and deduct user balance")
        .addUserOption((o) =>
          o.setName("user").setDescription("User").setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("amount")
            .setDescription("Amount paid out (e.g. 500m, 1bil)")
            .setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(false) ?? "";
    const withdrawStaff = isWithdrawStaff(interaction);

    if (sub === "withdraw" && !isModOrOwner(interaction) && !withdrawStaff) {
      await interaction.reply({
        content: "Withdraw staff only.",
        ephemeral: true,
      });
      return;
    }

    if (sub === "withdraw") {
      const target = interaction.options.getUser("user", true);
      const rawAmount = interaction.options.getString("amount", true);
      const amount = parseAmount(rawAmount);
      if (!amount || amount <= 0n) {
        await interaction.reply({
          content: "Invalid amount. Try `500m`, `1bil`, or a plain number.",
          ephemeral: true,
        });
        return;
      }

      const pending = interaction.channelId
        ? await getPendingWithdrawalByChannel(interaction.channelId)
        : null;
      const pendingMatches =
        pending &&
        pending.status === "pending" &&
        pending.discord_id === target.id &&
        BigInt(pending.amount) === amount;

      let newBal: bigint;
      if (pendingMatches && pending) {
        await markPendingWithdrawalPaid(pending.id);
        const u = await getOrCreateUser(target.id);
        newBal = BigInt(u.balance);
      } else {
        const u = await getOrCreateUser(target.id);
        if (BigInt(u.balance) < amount) {
          await interaction.reply({
            content: `User only has ${formatCoins(BigInt(u.balance))}.`,
            ephemeral: true,
          });
          return;
        }
        newBal = await adjustBalance(target.id, -amount);
        await recordBalanceEvent({
          discordId: target.id,
          delta: -amount,
          source: "withdraw",
          detail: `Casino payout by ${interaction.user.tag}`,
        });
      }
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
            .setFooter({ text: `Paid out by ${interaction.user.tag}` }),
        ],
      });

      await postVouch({
        vouchChannelId: VOUCH_CHANNEL_ID,
        discordId: target.id,
        amount,
      });

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
                  "Payout is complete. Only **moderators** can close this ticket from here.",
                ),
            ],
          });
        } catch {
          /* ignore rename failures */
        }
      }
      return;
    }
  },
};

export default command;
