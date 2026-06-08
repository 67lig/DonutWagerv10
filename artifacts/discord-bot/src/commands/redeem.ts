import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { redeemCoupon } from "../lib/db.js";
import { formatCoins } from "../lib/format.js";
import { antiSpam } from "../lib/guards.js";
import type { SlashCommand } from "../lib/types.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("Redeem a coupon code for free coins")
    .addStringOption((o) =>
      o
        .setName("code")
        .setDescription("The coupon code")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(32),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!antiSpam(interaction.user.id, 3000)) {
      await interaction.reply({
        content: "Slow down — wait a moment before redeeming again.",
        ephemeral: true,
      });
      return;
    }

    const code = interaction.options.getString("code", true).trim().toUpperCase();
    const result = await redeemCoupon(code, interaction.user.id);

    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        not_found: `No coupon with code \`${code}\` exists.`,
        expired: `That coupon has expired.`,
        exhausted: `That coupon has already been claimed the maximum number of times.`,
        already_used: `You've already redeemed \`${code}\`.`,
        error: `Something went wrong redeeming that code. Try again in a moment.`,
      };
      await interaction.reply({
        content: messages[result.reason],
        ephemeral: true,
      });
      return;
    }

    const requirementLine = result.couponType === "gamble"
      ? `\n\n⚠️ Must gamble before withdraw.`
      : `\n\n✅ No gamble required — you can withdraw this balance freely.`;

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Coupon Redeemed")
          .setDescription(
            `You received ${formatCoins(result.amount)}.\nNew balance: ${formatCoins(result.newBalance)}` +
            requirementLine,
          )
          .setFooter({ text: `Code: ${code}` }),
      ],
      ephemeral: true,
    });
  },
};

export default command;
