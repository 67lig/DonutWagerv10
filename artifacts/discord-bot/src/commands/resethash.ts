import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreateSeed, rotateSeed } from "../lib/seeds.js";
import type { SlashCommand } from "../lib/types.js";

const GAMES = [
  { name: "Coinflip", value: "coinflip" },
  { name: "Dice", value: "dice" },
  { name: "Mines", value: "mines" },
  { name: "Roulette", value: "roulette" },
  { name: "Blackjack", value: "blackjack" },
  { name: "Towers", value: "towers" },
];

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("resethash")
    .setDescription("Rotate your server seed and publish a fresh hash commit")
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Which game to rotate (defaults to all)")
        .setRequired(false)
        .addChoices(...GAMES),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = interaction.options.getString("game");

    if (!game) {
      // Rotate all
      let last = "";
      for (const g of GAMES) {
        const old = getOrCreateSeed(interaction.user.id, g.value);
        const next = rotateSeed(interaction.user.id, g.value);
        last = `${g.value}: revealed \`${old.serverSeed.slice(0, 16)}...\` → new hash \`${next.serverSeedHash.slice(0, 16)}...\``;
      }
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle("🔁 All Seeds Rotated")
            .setDescription(
              "All your per-game server seeds have been rotated. The previous seeds were revealed so you can verify every past round, and fresh commits have been published for future rolls.",
            )
            .setFooter({ text: last }),
        ],
        ephemeral: true,
      });
      return;
    }

    const old = getOrCreateSeed(interaction.user.id, game);
    const next = rotateSeed(interaction.user.id, game);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle(`🔁 Seed Rotated — ${game}`)
          .addFields(
            {
              name: "Previous Server Seed (revealed)",
              value: `\`${old.serverSeed}\``,
            },
            {
              name: "Previous Hash",
              value: `\`${old.serverSeedHash}\``,
            },
            {
              name: "New Server Seed Hash (committed)",
              value: `\`${next.serverSeedHash}\``,
            },
          )
          .setFooter({
            text: "Use /provablyfair game:" + game + " to verify past rounds with the revealed seed.",
          }),
      ],
      ephemeral: true,
    });
  },
};

export default command;
