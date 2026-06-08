import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  adjustBalance,
  getOrCreateUser,
  recordBalanceEvent,
  setLastDaily,
} from "../lib/db.js";
import { formatCoins } from "../lib/format.js";
import { requireVerified } from "../lib/guards.js";
import type { SlashCommand } from "../lib/types.js";

const DAILY_AMOUNT = 10_000n;
const COOLDOWN_MS = 22 * 60 * 60 * 1000;

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily coin reward"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const verified = await requireVerified(interaction);
    if (!verified) return;

    const user = await getOrCreateUser(interaction.user.id);

    if (user.last_daily) {
      const elapsed = Date.now() - new Date(user.last_daily).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - elapsed;
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xfacc15)
              .setTitle("Daily Already Claimed")
              .setDescription(
                `Come back in **${hours}h ${mins}m** to claim your next daily reward.`,
              ),
          ],
          ephemeral: true,
        });
        return;
      }
    }

    const newBalance = await adjustBalance(interaction.user.id, DAILY_AMOUNT);
    await setLastDaily(interaction.user.id);
    await recordBalanceEvent({
      discordId: interaction.user.id,
      delta: DAILY_AMOUNT,
      source: "daily",
      detail: "Daily reward",
    });

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("Daily Reward Claimed")
          .setDescription(
            `You received ${formatCoins(DAILY_AMOUNT)}.\nYour new balance: ${formatCoins(newBalance)}`,
          )
          .setFooter({ text: "Come back in 22 hours for another reward." }),
      ],
    });
  },
};

export default command;
