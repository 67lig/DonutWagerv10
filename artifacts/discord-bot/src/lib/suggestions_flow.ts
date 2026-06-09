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
import { getConfig, setConfig, pool } from "./db.js";
import { CHANNELS, SUGGESTION_EMOJI_ID } from "./config.js";

export const STICKY_MSG_KEY = "suggestions_sticky_msg_id";
const THRESHOLD_KEY = "suggestions_threshold";
const COUNT_KEY = "suggestions_count";
const STICKY_TEXT_KEY = "suggestions_sticky_text";

const EMOJI_STR = `<:donutemoji:${SUGGESTION_EMOJI_ID}>`;

const DEFAULT_STICKY_TEXT =
  `When your suggestion gets {threshold} {emoji} reactions it will be put in top suggestions.\nTo submit a suggestion, use /suggest`;

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
  return resolved
    .split("\n")
    .map((line) => `-# ${line}`)
    .join("\n");
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
      // Clear stored key BEFORE deleting so the MessageDelete watcher
      // does not trigger a second updateStickyMessage call mid-update.
      await setConfig(STICKY_MSG_KEY, "");
      const old = await ch.messages.fetch(oldId).catch(() => null);
      if (old) await (old as Message).delete().catch(() => null);
    }

    const sent = await ch.send({ content: await buildStickyContent(t) });
    await setConfig(STICKY_MSG_KEY, sent.id);
  } catch (err) {
    console.error("[suggestions] updateStickyMessage failed:", err);
  }
}

const _processedMsgIds = new Set<string>();
const _recentlyDmedUsers = new Set<string>();

export async function handleSuggestionsMessage(
  message: Message | PartialMessage,
): Promise<void> {
  if (message.channelId !== CHANNELS.SUGGESTIONS) return;

  // Bot-posted messages are managed externally (e.g. /suggest handles sticky).
  if (message.author?.bot) return;

  // Message-level dedup: catches same-message double-fires from discord.js partials.
  if (_processedMsgIds.has(message.id)) return;
  _processedMsgIds.add(message.id);
  setTimeout(() => _processedMsgIds.delete(message.id), 10_000);

  // Delete the message and notify the user via DM.
  try {
    const fullMsg = message.partial ? await message.fetch() : message;
    if (fullMsg.author?.bot) return;

    await (fullMsg as Message).delete().catch(() => null);

    // User-level dedup: only send one DM per user per 30s regardless of cause.
    const uid = (fullMsg as Message).author?.id;
    if (uid && !_recentlyDmedUsers.has(uid)) {
      _recentlyDmedUsers.add(uid);
      setTimeout(() => _recentlyDmedUsers.delete(uid), 30_000);
      await (fullMsg as Message).author
        ?.send(
          "Use **/suggest** to submit a suggestion. Direct messages in that channel are not allowed.",
        )
        .catch(() => null);
    }
  } catch (err) {
    console.error("[suggestions] Failed to delete direct message:", err);
  }
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
  const originalEmbed = msg.embeds?.[0];
  const suggestionText = originalEmbed?.description ?? msg.content ?? "*[no text]*";
  const authorAvatar =
    originalEmbed?.author?.iconURL ?? msg.author?.displayAvatarURL() ?? undefined;

  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setAuthor({ name: "\u200b", iconURL: authorAvatar })
    .setDescription(suggestionText)
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

export async function clearAllSuggestions(client: Client): Promise<void> {
  // Wipe promoted-tracking keys and reset counter.
  await pool.query(`DELETE FROM bot_config WHERE key LIKE 'suggestions_promoted_%'`);
  await setConfig(COUNT_KEY, "0");
  await setConfig(STICKY_MSG_KEY, "");

  // Bulk-delete messages in #suggestions.
  const sugCh = await client.channels.fetch(CHANNELS.SUGGESTIONS).catch(() => null);
  if (sugCh && sugCh.isTextBased() && "bulkDelete" in sugCh) {
    const msgs = await (sugCh as { messages: { fetch: (opts: { limit: number }) => Promise<Map<string, unknown>> } })
      .messages.fetch({ limit: 100 })
      .catch(() => null);
    if (msgs && msgs.size > 0) {
      await (sugCh as { bulkDelete: (ids: unknown[], force?: boolean) => Promise<unknown> })
        .bulkDelete([...msgs.keys()], true)
        .catch(() => null);
    }
  }

  // Bulk-delete messages in #top-suggestions.
  const topCh = await client.channels.fetch(CHANNELS.TOP_SUGGESTIONS).catch(() => null);
  if (topCh && topCh.isTextBased() && "bulkDelete" in topCh) {
    const msgs = await (topCh as { messages: { fetch: (opts: { limit: number }) => Promise<Map<string, unknown>> } })
      .messages.fetch({ limit: 100 })
      .catch(() => null);
    if (msgs && msgs.size > 0) {
      await (topCh as { bulkDelete: (ids: unknown[], force?: boolean) => Promise<unknown> })
        .bulkDelete([...msgs.keys()], true)
        .catch(() => null);
    }
  }

  // Re-post the sticky.
  await updateStickyMessage(client);
}
