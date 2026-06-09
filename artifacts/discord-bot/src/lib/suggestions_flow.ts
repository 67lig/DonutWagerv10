import {
  Client,
  EmbedBuilder,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { getConfig, setConfig } from "./db.js";
import { CHANNELS, SUGGESTION_EMOJI_ID } from "./config.js";

const STICKY_MSG_KEY = "suggestions_sticky_msg_id";
const THRESHOLD_KEY = "suggestions_threshold";

export async function getThreshold(): Promise<number> {
  const v = await getConfig(THRESHOLD_KEY);
  return v ? parseInt(v, 10) : 1;
}

export async function setThreshold(n: number): Promise<void> {
  await setConfig(THRESHOLD_KEY, String(n));
}

function buildStickyContent(threshold: number): string {
  return `When your suggestion gets ${threshold} <:donutemoji:${SUGGESTION_EMOJI_ID}> reactions it will be put in top suggestions.`;
}

export async function updateStickyMessage(
  client: Client,
  threshold?: number,
): Promise<void> {
  const t = threshold ?? (await getThreshold());
  try {
    const channel = await client.channels
      .fetch(CHANNELS.SUGGESTIONS)
      .catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const ch = channel as {
      messages: { fetch: (id: string) => Promise<Message | null> };
      send: (opts: { content: string }) => Promise<{ id: string }>;
    };

    const oldId = await getConfig(STICKY_MSG_KEY);
    if (oldId) {
      const old = await ch.messages.fetch(oldId).catch(() => null);
      if (old) await (old as Message).delete().catch(() => null);
    }

    const sent = await ch.send({ content: buildStickyContent(t) });
    await setConfig(STICKY_MSG_KEY, sent.id);
  } catch (err) {
    console.error("[suggestions] updateStickyMessage failed:", err);
  }
}

export async function handleSuggestionsMessage(
  message: Message | PartialMessage,
): Promise<void> {
  if (message.channelId !== CHANNELS.SUGGESTIONS) return;
  if (message.author?.bot) return;

  await updateStickyMessage(message.client as Client);
}

export async function handleSuggestionReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (reaction.message.channelId !== CHANNELS.SUGGESTIONS) return;
  if (user.bot) return;
  if (reaction.emoji.id !== SUGGESTION_EMOJI_ID) return;

  const stickyId = await getConfig(STICKY_MSG_KEY);
  if (reaction.message.id === stickyId) return;

  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const count = fullReaction.count ?? 0;
  const threshold = await getThreshold();
  if (count < threshold) return;

  const promotedKey = `suggestions_promoted_${reaction.message.id}`;
  const alreadyPromoted = await getConfig(promotedKey);
  if (alreadyPromoted) return;

  await setConfig(promotedKey, "1");

  const msg = reaction.message.partial
    ? await reaction.message.fetch()
    : reaction.message;

  const topChannel = await reaction.client.channels
    .fetch(CHANNELS.TOP_SUGGESTIONS)
    .catch(() => null);
  if (!topChannel || !topChannel.isTextBased() || !("send" in topChannel)) return;

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setDescription(msg.content || "*[no text]*")
    .setAuthor({
      name: msg.author?.tag ?? "Unknown",
      iconURL: msg.author?.displayAvatarURL() ?? undefined,
    })
    .addFields({
      name: "Reactions",
      value: `${count} <:donutemoji:${SUGGESTION_EMOJI_ID}>`,
      inline: true,
    })
    .setURL(msg.url)
    .setTimestamp(msg.createdAt ?? undefined);

  await (
    topChannel as { send: (opts: unknown) => Promise<unknown> }
  ).send({ embeds: [embed] });
}
