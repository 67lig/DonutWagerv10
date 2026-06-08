import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreateSeed, VERIFIER_SCRIPTS } from "../lib/seeds.js";
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
    .setName("provablyfair")
    .setDescription("View the provably-fair verifier script and your seeds")
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Which game to view")
        .setRequired(true)
        .addChoices(...GAMES),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const game = interaction.options.getString("game", true);
    const entry = getOrCreateSeed(interaction.user.id, game);
    const script = VERIFIER_SCRIPTS[game] ?? "// No script available.";

    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle(`🔐 Provably Fair — ${game.charAt(0).toUpperCase() + game.slice(1)}`)
      .setDescription(
        "Every roll is generated from a server seed (committed in advance via SHA-256 hash), your client seed, and a per-roll nonce. You can re-run the script below with these values to verify any past round.",
      )
      .addFields(
        {
          name: "Server Seed Hash (committed)",
          value: `\`${entry.serverSeedHash}\``,
        },
        {
          name: "Client Seed",
          value: `\`${entry.clientSeed}\``,
          inline: true,
        },
        { name: "Nonce", value: `\`${entry.nonce}\``, inline: true },
        {
          name: "Verifier Script",
          value: `\`\`\`js\n${script.slice(0, 950)}\n\`\`\``,
        },
      )
      .setFooter({
        text: "Use /resethash to rotate your seed. The previous server seed is revealed on rotation so old rounds can be verified.",
      });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default command;
