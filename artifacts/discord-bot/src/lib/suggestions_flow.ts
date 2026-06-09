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

export const STICKY_MSG_KEY = "suggestions_sticky_msg_id";
const THRESHOLD_KEY = "suggestions_threshold";
const COUNT_KEY = "suggestions_count";
const STICKY_TEXT_KEY = "suggestions_sticky_text";

const EMOJI_STR = `<:donutemoji:${SUGGESTION_EMOJI_ID}>`;

const DEFAULT_STICKY_TEXT =
  `When your suggestion gets {threshold} {emoji} reactions it will be put in top suggestions.`;

export async function getStickyText(): Promise<string> {
  return (await getConfig(STICKY_TEXT_KEY)) ?? DEFAULT_STICKY_TEXT;
}

export async function setStickyText(text: string): Promise<void> {
  await setConfig(STICKY_TEXT_KEY, text);
}

export async function getThreshold(): Promise<number> {
  const v = await getConfig(THRESHOLD_KEY);
  return v ? parseInt(v, 10) : 1;
}

export async function setThreshold(n: number): Promise<void> {
  await setConfig(THRESHOLD_KEY, String(n));
}

async function nextSuggestionNumber(): Promise<number> {
  const v = await getConfig(COUNT_KEY);
  const next = (v ? parseInt(v, 10) : 0) + 1;
  await setConfig(COUNT_KEY, String(next));
  return next;
}

async function buildStickyContent(threshold: number): Promise<string> {
  const template = await getStickyText();
  const resolved = template
    .replace("{threshold}", String(threshold))
    .replace("{emoji}", EMOJI_STR);
  return `-# ${resolved}`;
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

  // Auto-react with the suggestion emoji so users can click it
  try {
    const fullMsg = message.partial ? await message.fetch() : message;
    await fullMsg.react(SUGGESTION_EMOJI_ID);
  } catch (err) {
    console.error("[suggestions] Auto-react failed:", err);
  }

  // Move sticky to bottom
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

  const num = await nextSuggestionNumber();
  const authorName = msg.author?.username ?? msg.author?.tag ?? "Unknown";
  const authorAvatar = msg.author?.displayAvatarURL() ?? undefined;

  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setAuthor({ name: authorName, iconURL: authorAvatar })
    .setDescription(msg.content || "*[no text]*")
    .addFields({
      name: "\u200b",
      value: `<#${CHANNELS.SUGGESTIONS}>\n[Jump to message](${msg.url})`,
    })
    .setTimestamp(msg.createdAt ?? undefined);

  await (
    topChannel as { send: (opts: unknown) => Promise<unknown> }
  ).send({
    content: `${EMOJI_STR} **#${num}**`,
    embeds: [embed],
  });
}
