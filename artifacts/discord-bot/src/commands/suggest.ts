import {
  EmbedBuilder,
  SlashCommandBuilder,
  TextChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommand } from "../lib/types.js";
import { CHANNELS, SUGGESTION_EMOJI_ID } from "../lib/config.js";
import { updateStickyMessage } from "../lib/suggestions_flow.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Submit a suggestion to the suggestions channel")
    .addStringOption((opt) =>
      opt
        .setName("suggestion")
        .setDescription("Your suggestion (5-1000 characters)")
        .setMinLength(5)
        .setMaxLength(1000)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const text = interaction.options.getString("suggestion", true);

    const channel = await interaction.client.channels
      .fetch(CHANNELS.SUGGESTIONS)
      .catch(() => null);

    if (!channel || !(channel instanceof TextChannel)) {
      await interaction.reply({
        content: "Suggestions channel is not accessible right now.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: "Suggestion submitted!", ephemeral: true });

    const embed = new EmbedBuilder()
      .setAuthor({
        name: interaction.user.username,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setDescription(text)
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    await msg.react(SUGGESTION_EMOJI_ID).catch(() => null);

    await updateStickyMessage(interaction.client);
  },
};

export default command;
