import { EmbedBuilder, type Client, type Message } from "discord.js";
import {
  adjustBalance,
  claimPaymentMessage,
  completePendingDeposit,
  findUserByMinecraftUsername,
  getPendingDepositByDiscordId,
  getOrCreateUser,
  recordBalanceEvent,
} from "./db.js";
import { formatCoins, parseAmount } from "./format.js";
import { CHANNELS, WEBHOOK_IDS } from "./config.js";

export const PAYMENT_CHANNEL_ID = CHANNELS.PAYMENT;

// Matches: "💰 Payment received: $1 million from player123"
// or      "💰 Payment received: 1 thousand from player123"
// or      "💰 Payment received: $500 from player123"
const PAYMENT_REGEX =
  /Payment received:\s*\$?([\d,]+(?:\.\d+)?(?:\s*(?:thousand|million|billion))?)\s+from\s+(\w+)/i;

export async function handlePaymentMessage(
  message: Message,
  client: Client,
): Promise<void> {
  // Only process webhook messages from our payment webhook
  if (!message.webhookId) return;
  if (message.webhookId !== WEBHOOK_IDS.PAYMENT) return;

  const match = PAYMENT_REGEX.exec(message.content);
  if (!match) return;

  const [, rawAmount, playerName] = match;
  if (!rawAmount || !playerName) return;

  // Deduplicate: claim the message ID atomically
  const claimed = await claimPaymentMessage(message.id);
  if (!claimed) return;

  // Parse the amount
  const amount = parseAmount(rawAmount.trim());
  if (!amount || amount <= 0n) return;

  // Look up by Minecraft username
  const user = await findUserByMinecraftUsername(playerName);
  if (!user) {
    console.warn(
      `[payment] Received payment from unknown Minecraft user: ${playerName}`,
    );
    return;
  }

  // Try to complete a pending deposit first
  const pendingDeposit = await getPendingDepositByDiscordId(user.discord_id);
  if (pendingDeposit) {
    const completed = await completePendingDeposit(pendingDeposit.id);
    if (completed) {
      await adjustBalance(user.discord_id, amount);
      await recordBalanceEvent({
        discordId: user.discord_id,
        delta: amount,
        source: "deposit",
        detail: `Auto-detected /pay from ${playerName} — ticket <#${pendingDeposit.channel_id}>`,
      });

      // Notify the deposit ticket channel
      try {
        const ch = await client.channels.fetch(pendingDeposit.channel_id);
        if (ch && ch.isTextBased() && "send" in ch) {
          const newBal = await getOrCreateUser(user.discord_id);
          await (ch as { send: (opts: unknown) => Promise<unknown> }).send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x22c55e)
                .setTitle("✅ Deposit Received")
                .setDescription(
                  `Payment of **${formatCoins(amount)}** detected from \`${playerName}\`.\nYour balance has been updated automatically.`,
                )
                .addFields(
                  { name: "Amount", value: formatCoins(amount), inline: true },
                  { name: "New Balance", value: formatCoins(BigInt(newBal.balance)), inline: true },
                )
                .setFooter({ text: "This ticket will close in 30 seconds." }),
            ],
          });
          setTimeout(() => {
            (ch as { delete?: (reason: string) => Promise<unknown> })
              .delete?.("Deposit completed — auto-close")
              .catch(() => {});
          }, 30_000);
        }
      } catch {
        /* ignore */
      }
      return;
    }
  }

  // No pending deposit — still credit the balance as a direct payment
  await adjustBalance(user.discord_id, amount);
  await recordBalanceEvent({
    discordId: user.discord_id,
    delta: amount,
    source: "deposit",
    detail: `Direct /pay detected from ${playerName}`,
  });
}
