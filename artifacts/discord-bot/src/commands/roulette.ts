import { randomInt } from "node:crypto";
import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordGame } from "../lib/db.js";
import { formatCoins } from "../lib/format.js";
import { antiSpam, requireVerified, resolveBet } from "../lib/guards.js";
import { logGamble } from "../lib/gamblelog.js";
import { checkRig } from "../lib/rig.js";
import { getHouseRates, shouldHouseWin } from "../lib/houserates.js";
import type { SlashCommand } from "../lib/types.js";

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

function colorOf(n: number): "red" | "black" | "green" {
  if (n === 0) return "green";
  return RED_NUMBERS.has(n) ? "red" : "black";
}

function securePick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length)]!;
}

interface BetSpec {
  label: string;
  payout: number;
  matches: (n: number) => boolean;
  rigToSatisfy: (satisfy: boolean) => number;
}

function rigByPredicate(
  pred: (n: number) => boolean,
  satisfy: boolean,
): number {
  const candidates: number[] = [];
  for (let i = 0; i <= 36; i++) {
    if (pred(i) === satisfy) candidates.push(i);
  }
  return securePick(candidates);
}

function buildBet(choice: string): BetSpec | null {
  switch (choice) {
    case "red":
      return {
        label: "Red",
        payout: 1,
        matches: (n) => colorOf(n) === "red",
        rigToSatisfy: (s) => rigByPredicate((n) => colorOf(n) === "red", s),
      };
    case "black":
      return {
        label: "Black",
        payout: 1,
        matches: (n) => colorOf(n) === "black",
        rigToSatisfy: (s) => rigByPredicate((n) => colorOf(n) === "black", s),
      };
    case "green":
      return {
        label: "Green (0)",
        payout: 35,
        matches: (n) => n === 0,
        rigToSatisfy: (s) => (s ? 0 : randomInt(1, 37)),
      };
    case "even":
      return {
        label: "Even",
        payout: 1,
        matches: (n) => n !== 0 && n % 2 === 0,
        rigToSatisfy: (s) =>
          rigByPredicate((n) => n !== 0 && n % 2 === 0, s),
      };
    case "odd":
      return {
        label: "Odd",
        payout: 1,
        matches: (n) => n % 2 === 1,
        rigToSatisfy: (s) => rigByPredicate((n) => n % 2 === 1, s),
      };
    case "low":
      return {
        label: "1-18",
        payout: 1,
        matches: (n) => n >= 1 && n <= 18,
        rigToSatisfy: (s) => rigByPredicate((n) => n >= 1 && n <= 18, s),
      };
    case "high":
      return {
        label: "19-36",
        payout: 1,
        matches: (n) => n >= 19 && n <= 36,
        rigToSatisfy: (s) => rigByPredicate((n) => n >= 19 && n <= 36, s),
      };
    default:
      return null;
  }
}

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("roulette")
    .setDescription("Spin the roulette wheel")
    .addStringOption((o) =>
      o
        .setName("choice")
        .setDescription("What to bet on")
        .setRequired(true)
        .addChoices(
          { name: "Red (2x)", value: "red" },
          { name: "Black (2x)", value: "black" },
          { name: "Green / 0 (36x)", value: "green" },
          { name: "Even (2x)", value: "even" },
          { name: "Odd (2x)", value: "odd" },
          { name: "Low 1-18 (2x)", value: "low" },
          { name: "High 19-36 (2x)", value: "high" },
        ),
    )
    .addStringOption((o) =>
      o.setName("bet").setDescription("Amount to bet").setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!antiSpam(interaction.user.id)) {
      await interaction.reply({ content: "Slow down.", ephemeral: true });
      return;
    }
    const verified = await requireVerified(interaction);
    if (!verified) return;

    const choice = interaction.options.getString("choice", true);
    const rawBet = interaction.options.getString("bet", true);
    const user = await getOrCreateUser(interaction.user.id);
    const bet = await resolveBet(interaction, user, rawBet);
    if (!bet) return;

    const spec = buildBet(choice);
    if (!spec) {
      await interaction.reply({ content: "Unknown bet.", ephemeral: true });
      return;
    }

    const rigResult = await checkRig(interaction.user.id);
    const rates = await getHouseRates();
    await adjustBalance(interaction.user.id, -bet);

    const houseWins = rigResult.active && rigResult.forceLoss
      ? true
      : rigResult.active && rigResult.forceWin
        ? false
        : shouldHouseWin(rates, bet);
    const number = spec.rigToSatisfy(!houseWins);
    const won = spec.matches(number);
    const payout = won ? bet + bet * BigInt(spec.payout) : 0n;
    if (payout > 0n) await adjustBalance(interaction.user.id, payout);

    await recordGame({
      discordId: interaction.user.id,
      game: "roulette",
      bet,
      payout,
      won,
      details: { choice, number },
    });
    await logGamble({
      discordId: interaction.user.id,
      game: "roulette",
      bet,
      payout,
      won,
      detail: `bet ${spec.label}, landed ${number}`,
    });

    const after = await getOrCreateUser(interaction.user.id);
    const color = colorOf(number);
    const colorEmoji =
      color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";

    const embed = new EmbedBuilder()
      .setColor(won ? 0x22c55e : 0xef4444)
      .setTitle(`🎡 Roulette — ${colorEmoji} ${number}`)
      .setDescription(
        won
          ? `**You won ${formatCoins(payout - bet)}!**\nYour balance: ${formatCoins(BigInt(after.balance))}`
          : `**You lost ${formatCoins(bet)}.**\nYour balance: ${formatCoins(BigInt(after.balance))}`,
      )
      .addFields(
        { name: "Bet On", value: spec.label, inline: true },
        { name: "Stake", value: formatCoins(bet), inline: true },
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default command;