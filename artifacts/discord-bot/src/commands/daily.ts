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
import { FULL_OWNER_ID } from "../lib/owners.js";
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
  { amount:      1_000_000n, label:    "1,000,000", weight: 7.5, minStreak: 5,  emoji: "🟠" },
  { amount:     10_000_000n, label:   "10,000,000", weight: 2,   minStreak: 10, emoji: "🔴" },
  { amount:    100_000_000n, label:  "100,000,000", weight: 0.5, minStreak: 20, emoji: "💎" },
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

/**
 * Build an animation sequence of prize indices that:
 * - Starts at a random position
 * - Cycles forward through ALL_PRIZES
 * - Lands exactly on the winner at the final frame
 */
function buildFrameSequence(winner: Prize, totalFrames: number): Prize[] {
  const n = ALL_PRIZES.length;
  const winnerIdx = ALL_PRIZES.findIndex((p) => p.label === winner.label);
  const startIdx = Math.floor(Math.random() * n);

  const frames: Prize[] = [];
  for (let i = 0; i < totalFrames - 1; i++) {
    frames.push(ALL_PRIZES[(startIdx + i) % n]!);
  }
  // Last frame is always the winner
  frames.push(winner);
  return frames;
}

// Delays per frame: starts fast, slows down toward the end
const FRAME_DELAYS = [100, 120, 150, 190, 240, 310, 400, 520, 680, 880];

function buildWheelEmbed(
  eligible: Prize[],
  activePrize: Prize | null,
  spinning: boolean,
  streak: number,
): EmbedBuilder {
  const eligibleLabels = new Set(eligible.map((p) => p.label));
  const lines = ALL_PRIZES.map((p) => {
    const locked = !eligibleLabels.has(p.label);
    const active = activePrize && p.label === activePrize.label;
    const arrow = active ? " ◀" : "   ";
    const dimmed = locked ? "~~" : "";
    return `${active ? "**" : ""}${dimmed}${p.emoji} ${p.label} coins${dimmed}${active ? "**" : ""}${arrow}`;
  });

  return new EmbedBuilder()
    .setTitle(spinning ? "🎰 Spinning..." : "🎰 Daily Spin")
    .setDescription(lines.join("\n"))
    .setColor(spinning ? 0xfbbf24 : 0x22c55e)
    .setFooter({ text: `🔥 Day streak: ${streak} · The higher your streak, the better your chances!` });
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
    const isOwner = interaction.user.id === FULL_OWNER_ID;

    if (!isOwner && user.last_daily) {
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

    // Build the spin sequence — fast start, slow finish
    const frames = buildFrameSequence(winner, FRAME_DELAYS.length);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const isLast = i === frames.length - 1;
      await interaction.editReply({
        embeds: [buildWheelEmbed(eligible, frame, !isLast, currentStreak)],
      });
      if (!isLast) await sleep(FRAME_DELAYS[i]!);
    }

    // Credit the prize and update streak
    const newBalance = await adjustBalance(interaction.user.id, winner.amount);
    const newStreak = await setLastDaily(interaction.user.id);
    await recordBalanceEvent({
      discordId: interaction.user.id,
      delta: winner.amount,
      source: "daily",
      detail: `Daily spin: ${winner.label} coins (streak ${newStreak})`,
    });

    await interaction.editReply({
      embeds: [buildResultEmbed(winner, newBalance, newStreak)],
    });
  },
};

export default command;
