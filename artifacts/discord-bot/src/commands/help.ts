import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { CLAIM_TIERS, COINS_PER_INVITE } from "../lib/invite_flow.js";
import { formatCoinsShort } from "../lib/format.js";

const PANEL_URL = "https://discord.com/channels/1497757397165408376/1506062502474289334";

const HOW_TO_PLAY: Record<
  string,
  { title: string; color: number; description: string }
> = {
  coinflip: {
    title: "Coinflip",
    color: 0xfacc15,
    description:
      "`/coinflip <bet> <heads|tails>`\n\n" +
      "Pick heads or tails. Win → **2×** your bet. Lose → gone.\n\n" +
      "50/50 odds. Simple as that.",
  },
  dice: {
    title: "Dice",
    color: 0x3b82f6,
    description:
      "`/dice <bet> <target>`\n\n" +
      "Pick a target number (2–98). The bot rolls 1–100.\n" +
      "You win if the roll lands **over** your target.\n\n" +
      "Low target = easier win, lower payout.\n" +
      "High target = harder win, bigger payout.",
  },
  mines: {
    title: "Mines",
    color: 0xef4444,
    description:
      "`/mines <bet> [mines]`\n\n" +
      "A 5×5 grid of tiles hiding gems and bombs.\n\n" +
      "Reveal a gem → multiplier goes up, keep going or cash out\n" +
      "Hit a bomb → lose your bet\n" +
      "Click **Cash Out** anytime to secure your winnings\n\n" +
      "More mines = higher risk, higher multiplier.",
  },
  blackjack: {
    title: "Blackjack",
    color: 0x22c55e,
    description:
      "`/blackjack <bet>`\n\n" +
      "Beat the dealer by getting closer to 21 without going over.\n\n" +
      "**Hit** — draw a card · **Stand** — end your turn · **Double** — double bet, one card\n\n" +
      "Win → **2×** · Blackjack → **2.5×** · Tie → bet returned\n\n" +
      "Aces count as 1 or 11. J/Q/K = 10.",
  },
  roulette: {
    title: "Roulette",
    color: 0xa855f7,
    description:
      "`/roulette <bet> <choice>`\n\n" +
      "The wheel spins 0–36. Pick where it lands.\n\n" +
      "`red` / `black` / `even` / `odd` / `1-18` / `19-36` → **2×**\n" +
      "`1st12` / `2nd12` / `3rd12` → **3×**\n" +
      "Single number (e.g. `7`) → **35×**\n\n" +
      "Landing on **0** loses all outside bets.",
  },
  towers: {
    title: "Towers",
    color: 0xf97316,
    description:
      "`/towers <bet> [difficulty]`\n\n" +
      "Climb 4 rows. Each row has tiles — one safe, rest are traps.\n\n" +
      "`easy` — 1 trap out of 3 tiles\n" +
      "`medium` — 1 trap out of 2 tiles (50/50)\n" +
      "`hard` — 3 traps out of 4 tiles\n\n" +
      "Pick the safe tile to advance and grow your multiplier.\n" +
      "**Cash Out** after any row, or reach the top for max payout.",
  },
};

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all commands, or learn how to play a game")
    .addStringOption((opt) =>
      opt
        .setName("game")
        .setDescription("Learn how to play a specific game")
        .setRequired(false)
        .addChoices(
          { name: "Coinflip", value: "coinflip" },
          { name: "Dice", value: "dice" },
          { name: "Mines", value: "mines" },
          { name: "Blackjack", value: "blackjack" },
          { name: "Roulette", value: "roulette" },
          { name: "Towers", value: "towers" },
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = interaction.options.getString("game");

    if (game) {
      const info = HOW_TO_PLAY[game];
      if (!info) {
        await interaction.reply({ content: "Unknown game.", ephemeral: true });
        return;
      }
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(info.color)
            .setTitle(info.title)
            .setDescription(info.description)
            .setFooter({ text: "All games are provably fair." }),
        ],
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xfacc15)
      .setTitle("DonutSMP Casino")
      .setDescription(
        `Head to the [command panel](${PANEL_URL}) to deposit, withdraw, and manage your account.`,
      )
      .addFields(
        {
          name: "Account",
          value:
            "`/balance` — check your coins\n" +
            "`/daily` — free daily reward\n" +
            "`/history balance` — coin history\n" +
            "`/history games` — recent game results",
        },
        {
          name: "Invites",
          value:
            "`/invites` — view your invite stats and claim rewards\n" +
            `Earn **${formatCoinsShort(COINS_PER_INVITE)} coins** per verified invite.\n` +
            `Milestones: ${CLAIM_TIERS.join(" → ")} invites.`,
        },
        {
          name: "Games",
          value:
            "`/coinflip` `/dice` `/mines` `/blackjack` `/roulette` `/towers`\n\n" +
            "Use `/help game:<name>` for full rules on any game.",
        },
        {
          name: "Extras",
          value:
            "`/redeem <code>` — use a promo code\n" +
            "`/provablyfair <game>` — verify a game result\n" +
            "`/resethash` — rotate your seed\n" +
            "`/close` — close your ticket",
        },
        {
          name: "Bet Format",
          value: "`1k`  `500k`  `1mil`  `10mil`  `1bil`  —  also `all` and `half`",
        },
      )
      .setFooter({ text: "All games are provably fair." });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default command;
