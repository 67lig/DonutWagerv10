import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ButtonInteraction,
  type GuildMember,
  type Interaction,
  type PartialGuildMember,
} from "discord.js";
import { commandMap, commands } from "./commands/index.js";
import { createHash } from "node:crypto";
import {
  findUserByMinecraftUsername,
  getConfig,
  getOrCreateUser,
  initSchema,
  setConfig,
  setVerified,
} from "./lib/db.js";
import { setSecondOwnerIdCache } from "./lib/owners.js";
import { setLogClient } from "./lib/gamblelog.js";
import { isMod } from "./lib/permissions.js";
import {
  WITHDRAW_BTN_PREFIX,
  handleWithdrawButton,
} from "./lib/withdraw_flow.js";
import {
  DEP_TICKET_BTN_PREFIX,
  PANEL_BTN_PREFIX,
  PANEL_MODAL_PREFIX,
  buildPanelMessage,
  handleDepositTicketButton,
  handlePanelButton,
  handlePanelModal,
} from "./lib/panel_flow.js";
import {
  AP_BTN_PREFIX,
  AP_MODAL_PREFIX,
  handleAdminPanelButton,
  handleAdminPanelModal,
} from "./commands/adminpanel.js";
import {
  SP_BTN_PREFIX,
  SP_MODAL_PREFIX,
  handleServerPanelButton,
  handleServerPanelModal,
} from "./commands/serverpanel.js";
import {
  handleInviteButton,
  handleMemberAdd,
  handleMemberRemove,
  handleMemberUpdate,
  initInviteCache,
} from "./lib/invite_flow.js";
import {
  PAYMENT_CHANNEL_ID,
  handlePaymentMessage,
} from "./lib/payment_flow.js";
import {
  handleSuggestionsMessage,
  handleSuggestionReaction,
  updateStickyMessage,
} from "./lib/suggestions_flow.js";
import { CHANNELS } from "./lib/config.js";

// DB keys for remembering where the panel is posted.
const PANEL_CHANNEL_KEY = "panel_channel_id";
const PANEL_MESSAGE_KEY = "panel_message_id";

// Cache the ready client so the MessageDelete handler can reference it.
let readyClient: Client<true> | null = null;

async function ensurePanelPosted(client: Client<true>): Promise<void> {
  const channelId = (await getConfig(PANEL_CHANNEL_KEY)) ?? CHANNELS.PANEL;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(
      `[bot] Skipping panel auto-post — channel ${channelId} not accessible.`,
    );
    return;
  }

  const existingId = await getConfig(PANEL_MESSAGE_KEY);
  if (existingId) {
    const existing = await (
      channel as { messages: { fetch: (id: string) => Promise<unknown> } }
    ).messages
      .fetch(existingId)
      .catch(() => null);
    if (existing) {
      console.log(`[bot] Casino panel already posted at message ${existingId}.`);
      return;
    }
  }

  const { embed, components } = buildPanelMessage();
  const sent = await (
    channel as { send: (opts: unknown) => Promise<{ id: string }> }
  )
    .send({ embeds: [embed], components })
    .catch((err) => {
      console.error("[bot] Failed to post casino panel:", err);
      return null;
    });

  if (sent) {
    await setConfig(PANEL_CHANNEL_KEY, channelId);
    await setConfig(PANEL_MESSAGE_KEY, sent.id);
    console.log(
      `[bot] Casino panel posted to channel ${channelId} as message ${sent.id}.`,
    );
  }
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN environment variable.");
  process.exit(1);
}

const COMMAND_HASH_KEY = "registered_guild_commands_hash";

async function registerGuildCommands(client: Client<true>): Promise<void> {
  // Use the application ID from the live client — never rely on the
  // DISCORD_CLIENT_ID env var which is error-prone to set correctly.
  const appId = client.application.id;

  const body = commands.map((c) => c.data.toJSON());
  const hash = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");

  const lastHash = await getConfig(COMMAND_HASH_KEY);
  if (lastHash === hash && process.env.FORCE_REGISTER !== "1") {
    console.log(
      `[bot] Command spec unchanged (${body.length} commands) — skipping registration.`,
    );
    return;
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN!);
  const guilds = client.guilds.cache;
  if (guilds.size === 0) {
    console.warn("[bot] No guilds in cache — nothing to register.");
    return;
  }
  console.log(
    `[bot] Registering ${body.length} slash commands to ${guilds.size} guild(s) (appId: ${appId})…`,
  );
  let okCount = 0;
  for (const guild of guilds.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(appId, guild.id),
        { body },
      );
      console.log(`[bot] Registered for "${guild.name}" (${guild.id})`);
      okCount++;
    } catch (err) {
      console.error(
        `[bot] Failed to register for guild ${guild.id}:`,
        err,
      );
    }
  }
  if (okCount > 0) {
    await setConfig(COMMAND_HASH_KEY, hash);
    console.log(`[bot] Done — registered to ${okCount}/${guilds.size} guild(s).`);
  }
}

async function memberIsMod(interaction: ButtonInteraction): Promise<boolean> {
  return isMod(interaction);
}

async function handleVerifyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const targetId = parts[2];
  const mcName = parts[3];
  if (!action || !targetId) return;

  if (!(await memberIsMod(interaction))) {
    await interaction.reply({
      content: "Only staff can review verifications.",
      ephemeral: true,
    });
    return;
  }

  if (action === "approve") {
    if (!mcName) {
      await interaction.reply({
        content: "Missing Minecraft name on this button.",
        ephemeral: true,
      });
      return;
    }
    const conflict = await findUserByMinecraftUsername(mcName);
    if (conflict && conflict.discord_id !== targetId) {
      await interaction.reply({
        content: `Cannot approve: \`${mcName}\` is already linked to <@${conflict.discord_id}>.`,
        ephemeral: true,
      });
      return;
    }
    await getOrCreateUser(targetId);
    await setVerified(targetId, mcName);
    await interaction.update({
      embeds: [
        EmbedBuilder.from(interaction.message.embeds[0]!)
          .setColor(0x22c55e)
          .setTitle("✅ Verification Approved")
          .setFooter({ text: `Approved by ${interaction.user.tag}` }),
      ],
      components: [],
    });
    const channel = interaction.channel;
    try {
      if (channel && "send" in channel) {
        await channel.send(
          `<@${targetId}> you've been verified! Use \`/balance\` and claim your \`/daily\`. This ticket closes in 10 seconds.`,
        );
      }
    } catch {
      /* ignore */
    }

    if (
      channel &&
      "delete" in channel &&
      "name" in channel &&
      typeof channel.name === "string" &&
      channel.name.startsWith("verify-")
    ) {
      const ticketChannel = channel;
      setTimeout(() => {
        void (async () => {
          try {
            await ticketChannel.delete("Verification approved — auto-close");
          } catch {
            /* already deleted or no perms */
          }
        })();
      }, 10_000);
    }
  } else if (action === "deny") {
    await interaction.update({
      embeds: [
        EmbedBuilder.from(interaction.message.embeds[0]!)
          .setColor(0xef4444)
          .setTitle("❌ Verification Denied")
          .setFooter({ text: `Denied by ${interaction.user.tag}` }),
      ],
      components: [],
    });
    try {
      const channel = interaction.channel;
      if (channel && "send" in channel) {
        await channel.send(
          `<@${targetId}> your verification was denied. Please re-check your Minecraft username and try again, or contact a moderator.`,
        );
      }
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  console.log("[bot] Initializing database schema…");
  await initSchema();

  // Load 2nd owner from DB into memory so permission checks stay synchronous.
  const storedSecondOwner = await getConfig("second_owner_id");
  if (storedSecondOwner) {
    setSecondOwnerIdCache(storedSecondOwner);
    console.log(`[bot] 2nd owner loaded: ${storedSecondOwner}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  setLogClient(client);

  client.once(Events.ClientReady, (c) => {
    readyClient = c;
    console.log(`[bot] Logged in as ${c.user.tag}`);

    void registerGuildCommands(c).catch((err) => {
      console.error("[bot] Guild command registration failed:", err);
    });
    void ensurePanelPosted(c).catch((err) => {
      console.error("[bot] Panel auto-post failed:", err);
    });
    void initInviteCache(c).catch((err) => {
      console.error("[bot] Invite cache init failed:", err);
    });
  });

  // ── Auto-repost panel if its message is deleted ───────────────────────────
  client.on(Events.MessageDelete, (message) => {
    void (async () => {
      try {
        const storedId = await getConfig(PANEL_MESSAGE_KEY);
        if (!storedId || message.id !== storedId) return;
        console.log("[bot] Panel message was deleted — re-posting…");
        // Clear stored ID so ensurePanelPosted will post a fresh one.
        await setConfig(PANEL_MESSAGE_KEY, "");
        if (readyClient) {
          await ensurePanelPosted(readyClient);
        }
      } catch {
        /* ignore */
      }
    })();
  });

  client.on(Events.GuildMemberAdd, (member) => {
    void handleMemberAdd(member as GuildMember).catch((err) => {
      console.error("[bot] GuildMemberAdd handler failed:", err);
    });
  });

  client.on(Events.GuildMemberRemove, (member) => {
    void handleMemberRemove(member as GuildMember | PartialGuildMember).catch((err) => {
      console.error("[bot] GuildMemberRemove handler failed:", err);
    });
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    void handleMemberUpdate(
      oldMember as GuildMember | PartialGuildMember,
      newMember as GuildMember,
    ).catch((err) => {
      console.error("[bot] GuildMemberUpdate handler failed:", err);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    if (!client.isReady()) return;
    if (message.channelId === PAYMENT_CHANNEL_ID) {
      void handlePaymentMessage(message, client).catch((err) => {
        console.error("[bot] PaymentMessage handler failed:", err);
      });
    }
    if (message.channelId === CHANNELS.SUGGESTIONS) {
      void handleSuggestionsMessage(message).catch((err) => {
        console.error("[bot] SuggestionsMessage handler failed:", err);
      });
    }
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleSuggestionReaction(reaction, user).catch((err) => {
      console.error("[bot] SuggestionReaction handler failed:", err);
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    console.log(`[bot] Joined new guild ${guild.name} (${guild.id}) — registering commands.`);
    if (client.isReady()) {
      void registerGuildCommands(client).catch((err) => {
        console.error("[bot] Re-register on guildCreate failed:", err);
      });
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const cmd = commandMap.get(interaction.commandName);
        if (!cmd) return;
        await cmd.execute(interaction);
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith("verify:")) {
          await handleVerifyButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${WITHDRAW_BTN_PREFIX}:`)) {
          await handleWithdrawButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${PANEL_BTN_PREFIX}:`)) {
          await handlePanelButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${AP_BTN_PREFIX}:`)) {
          await handleAdminPanelButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${SP_BTN_PREFIX}:`)) {
          await handleServerPanelButton(interaction);
          return;
        }
        if (interaction.customId.startsWith("invite:")) {
          await handleInviteButton(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${DEP_TICKET_BTN_PREFIX}:`)) {
          await handleDepositTicketButton(interaction);
          return;
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith(`${PANEL_MODAL_PREFIX}:`)) {
          await handlePanelModal(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${AP_MODAL_PREFIX}:`)) {
          await handleAdminPanelModal(interaction);
          return;
        }
        if (interaction.customId.startsWith(`${SP_MODAL_PREFIX}:`)) {
          await handleServerPanelModal(interaction);
          return;
        }
        return;
      }
    } catch (err) {
      console.error("[bot] Interaction failed:", err);
      if (!interaction.isRepliable()) return;
      const reply = { content: "Something went wrong handling that.", ephemeral: true };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      } catch {
        /* ignore */
      }
    }
  });

  await client.login(TOKEN);
}

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
