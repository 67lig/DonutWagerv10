import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { OWNER_IDS } from "../lib/owners.js";
import type { SlashCommand } from "../lib/types.js";
import { getOrCreateUser } from "../lib/db.js";
import { getRigRow } from "../lib/rig.js";
import {
  buildUserEmbed,
  buildUserComponents,
  fetchUserInviteStats,
} from "./adminpanel.js";

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("userpanel")
    .setDescription(".")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) =>
      o.setName("user").setDescription(".").setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!OWNER_IDS.has(interaction.user.id)) {
      await interaction.editReply({ content: "Unknown command." });
      return;
    }

    const target = interaction.options.getUser("user", true);

    const [rig, dbUser, inv] = await Promise.all([
      getRigRow(target.id),
      getOrCreateUser(target.id),
      fetchUserInviteStats(target.id),
    ]);

    await interaction.editReply({
      embeds: [buildUserEmbed(target, rig, dbUser, inv)],
      components: buildUserComponents(target.id),
    });
  },
};

export default command;
