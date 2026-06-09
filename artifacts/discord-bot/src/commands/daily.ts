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

const COOLDOWN_MS = 22 * 60 * 60 * 1000;

interface Prize {
  amount: bigint;
  label: string;
  weight: number;
  minStreak: number;
  emoji: string;
}

const ALL_PRIZES: Prize[] = [
  { amount:         10_000n, label:       "10,000", weight: 20,  minStreak: 0,  emoji: "⚪" },
  { amount:         25_000n, label:       "25,000", weight: 20,  minStreak: 0,  emoji: "🔵" },
  { amount:        100_000n, label:      "100,000", weight: 20,  minStreak: 0,  emoji: "🟢" },
  { amount:        250_000n, label:      "250,000", weight: 20,  minStreak: 0,  emoji: "🟡" },
  { amount:      1_000_000n, label:    "1,000,000", weight: 10,  minStreak: 5,  emoji: "🟠" },
  { amount:     10_000_000n, label:   "10,000,000", weight: 7.5, minStreak: 10, emoji: "🔴" },
  { amount:    100_000_000n, label:  "100,000,000", weight: 2.5, minStreak: 20, emoji: "💎" },
];

function getEligiblePrizes(streak: number): Prize[] {
  return ALL_PRIZES.filter((p) => streak >= p.minStreak);
}

function spinWheel(prizes: Prize[]): Prize {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let roll = Math.random() * total;
  for (const p of prizes) {
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return prizes[prizes.length - 1]!;
}

function buildWheelEmbed(
  prizes: Prize[],
  activePrize: Prize | null,
  spinning: boolean,
  streak: number,
): EmbedBuilder {
  const lines = ALL_PRIZES.map((p) => {
    const locked = streak < p.minStreak;
    const active = activePrize && p.label === activePrize.label;
    const arrow = active ? " ◀" : "   ";
    const lockStr = locked ? ` 🔒 (${p.minStreak}-day streak)` : "";
    const dimmed = locked ? "~~" : "";
    return `${active ? "**" : ""}${dimmed}${p.emoji} ${p.label} coins${dimmed}${lockStr}${active ? "**" : ""}${arrow}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(spinning ? "🎰 Spinning..." : "🎰 Daily Spin")
    .setDescription(lines.join("\n"))
    .setColor(spinning ? 0xfbbf24 : 0x22c55e);

  if (!spinning && streak > 0) {
    embed.setFooter({ text: `🔥 Day streak: ${streak}` });
  }

  return embed;
}

function buildResultEmbed(prize: Prize, newBalance: bigint, streak: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`${prize.emoji} You landed on ${prize.label} coins!`)
    .setDescription(
      `**+${formatCoins(prize.amount)}** added to your balance.\nNew balance: **${formatCoins(newBalance)}**`,
    )
    .setFooter({ text: `🔥 Day streak: ${streak} · Come back in 22 hours` })
    .setTimestamp();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Spin the wheel and claim your daily coin reward"),

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
                `Come back in **${hours}h ${mins}m** to claim your next daily spin.`,
              )
              .setFooter({ text: `🔥 Current streak: ${user.daily_streak} day${user.daily_streak === 1 ? "" : "s"}` }),
          ],
          ephemeral: true,
        });
        return;
      }
    }

    const currentStreak = user.daily_streak ?? 0;
    const eligible = getEligiblePrizes(currentStreak);
    const winner = spinWheel(eligible);

    await interaction.deferReply();

    // Animation frame 1 — fast random highlight
    const frame1 = eligible[Math.floor(Math.random() * eligible.length)]!;
    await interaction.editReply({
      embeds: [buildWheelEmbed(ALL_PRIZES, frame1, true, currentStreak)],
    });
    await sleep(700);

    // Animation frame 2 — another random highlight
    const others = eligible.filter((p) => p.label !== frame1.label);
    const frame2 = others.length > 0
      ? others[Math.floor(Math.random() * others.length)]!
      : eligible[0]!;
    await interaction.editReply({
      embeds: [buildWheelEmbed(ALL_PRIZES, frame2, true, currentStreak)],
    });
    await sleep(700);

    // Animation frame 3 — slow down near the winner
    const nearWinner = eligible.filter((p) => p.label !== winner.label);
    const frame3 = nearWinner.length > 0
      ? nearWinner[Math.floor(Math.random() * nearWinner.length)]!
      : winner;
    await interaction.editReply({
      embeds: [buildWheelEmbed(ALL_PRIZES, frame3, true, currentStreak)],
    });
    await sleep(900);

    // Credit the prize and update streak
    const newBalance = await adjustBalance(interaction.user.id, winner.amount);
    const newStreak = await setLastDaily(interaction.user.id);
    await recordBalanceEvent({
      discordId: interaction.user.id,
      delta: winner.amount,
      source: "daily",
      detail: `Daily spin: ${winner.label} coins (streak ${newStreak})`,
    });

    // Final result
    await interaction.editReply({
      embeds: [buildResultEmbed(winner, newBalance, newStreak)],
    });
  },
};

export default command;
