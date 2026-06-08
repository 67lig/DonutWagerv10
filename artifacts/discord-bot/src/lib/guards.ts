import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder, MessageFlags } from "discord.js";
import { getOrCreateUser, type BotUser } from "./db.js";
import { formatCoins, MAX_BET, parseBet } from "./format.js";

export async function requireVerified(
  interaction: ChatInputCommandInteraction,
): Promise<BotUser | null> {
  const user = await getOrCreateUser(interaction.user.id);
  if (!user.verified) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff5555)
          .setTitle("Verification Required")
          .setDescription(
            "You must verify your account before using this command.\n\nUse `/verify minecraft:<your_username>` to begin.",
          ),
      ],
      ephemeral: true,
    });
    return null;
  }
  return user;
}

export async function resolveBet(
  interaction: ChatInputCommandInteraction,
  user: BotUser,
  rawAmount: string,
): Promise<bigint | null> {
  const balance = BigInt(user.balance);
  const bet = parseBet(rawAmount, balance);
  if (bet === null || bet <= 0n) {
    await interaction.reply({
      content: `Invalid bet amount. Try a number, \`all\`, \`half\`, or values like \`100k\`, \`5mil\`, \`1bil\`.`,
      ephemeral: true,
    });
    return null;
  }
  if (bet > balance) {
    await interaction.reply({
      content: `Not enough coins. Your balance is ${formatCoins(balance)}.`,
      ephemeral: true,
    });
    return null;
  }
  if (bet < 10_000n) {
    await interaction.reply({
      content: "Minimum bet is **10,000 coins** (10k).",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (bet > MAX_BET) {
    await interaction.reply({
      content: `Maximum bet is **150,000,000 coins** (150M).`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return bet;
}

const cooldowns = new Map<string, number>();

export function antiSpam(userId: string, ms = 1500): boolean {
  const now = Date.now();
  const last = cooldowns.get(userId) ?? 0;
  if (now - last < ms) return false;
  cooldowns.set(userId, now);
  return true;
}
