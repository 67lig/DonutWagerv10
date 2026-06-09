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
  { amount:         10_000n, label:       "10,000", weight: 25,  minStreak: 0,  emoji: "⚪" },
  { amount:         25_000n, label:       "25,000", weight: 20,  minStreak: 0,  emoji: "🔵" },
  { amount:        100_000n, label:      "100,000", weight: 20,  minStreak: 0,  emoji: "🟢" },
  { amount:        250_000n, label:      "250,000", weight: 15,  minStreak: 0,  emoji: "🟡" },
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

const MIN_CYCLES = 2; // every prize gets highlighted at least 2 times before landing
const FAST_MS   = 150; // fastest frame (Discord reliably renders ~150ms intervals)
const SLOW_MS   = 400; // slowest frame at the very end — keeps total ~3-4s

/**
 * Cycle through ALL_PRIZES in strict sequential order, starting at a random
 * position, and stop ONLY when we've done MIN_CYCLES full laps AND we land
 * naturally on the winner. This guarantees no prize is ever skipped.
 */
function buildFrameSequence(winner: Prize): Prize[] {
  const n = ALL_PRIZES.length;
  const winnerIdx = ALL_PRIZES.findIndex((p) => p.label === winner.label);
  const startIdx  = Math.floor(Math.random() * n);
  const frames: Prize[] = [];
  let i = 0;
  while (true) {
    const cur = (startIdx + i) % n;
    frames.push(ALL_PRIZES[cur]!);
    i++;
    if (i >= MIN_CYCLES * n && cur === winnerIdx) break;
  }
  return frames;
}

/**
 * Build per-frame delay values for `count` frames using a quadratic ease-out:
 * starts at FAST_MS, ends at SLOW_MS.
 */
function buildDelays(count: number): number[] {
  const delays: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const t = count > 2 ? i / (count - 2) : 1;
    delays.push(Math.round(FAST_MS + (SLOW_MS - FAST_MS) * t * t));
  }
  return delays;
}

function buildWheelEmbed(
  eligible: Prize[],
  activePrize: Prize | null,
  spinning: boolean,
  streak: number,
): EmbedBuilder {
  const lines = ALL_PRIZES.map((p) => {
    const active = activePrize && p.label === activePrize.label;
    const arrow = active ? "  ◀" : "";
    return `${active ? "**" : ""}${p.label} coins${active ? "**" : ""}${arrow}`;
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
    .setTitle(`You landed on ${prize.label} coins!`)
    .setDescription(
      `**+${formatCoins(prize.amount)}** added to your balance.\nNew balance: **${formatCoins(newBalance)}**\n\nKeep your streak going. A higher streak unlocks better prizes and improves your odds!`,
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

    // Build the spin sequence — visits every prize in order, no skipping
    const frames = buildFrameSequence(winner);
    const delays = buildDelays(frames.length);

    for (let i = 0; i < frames.length; i++) {
      const isLast = i === frames.length - 1;
      await interaction.editReply({
        embeds: [buildWheelEmbed(eligible, frames[i]!, !isLast, currentStreak)],
      });
      if (!isLast) await sleep(delays[i]!);
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
