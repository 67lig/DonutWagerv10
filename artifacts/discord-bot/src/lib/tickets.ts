import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import { getConfig } from "./db.js";
import { PAID_TICKET_PREFIX } from "./constants.js";

export type TicketKind = "deposit" | "withdraw" | "verify" | "invite";

const CATEGORY_DISPLAY_NAMES: Record<TicketKind, string> = {
  deposit: "Deposits",
  withdraw: "Withdrawals",
  verify: "Linking",
  invite: "Invites",
};

const CATEGORY_CONFIG_KEYS: Record<TicketKind, string> = {
  deposit: "ticket_category_deposit",
  withdraw: "ticket_category_withdraw",
  verify: "ticket_category_verify",
  invite: "ticket_category_invite",
};

/**
 * Resolve (and lazily create) the per-kind ticket category. Each ticket type
 * gets its own Discord category section so deposits, withdrawals, and account
 * linking are visually segregated.
 */
export async function findOrCreateTicketCategory(
  guild: Guild,
  kind: TicketKind,
): Promise<string | null> {
  const configKey = CATEGORY_CONFIG_KEYS[kind];
  const categoryId = await getConfig(configKey);
  if (categoryId) {
    const ch = guild.channels.cache.get(categoryId);
    if (ch && ch.type === ChannelType.GuildCategory) return ch.id;
  }
  const wantedName = CATEGORY_DISPLAY_NAMES[kind].toLowerCase();
  const existing = guild.channels.cache.find(
    (c: GuildBasedChannel) =>
      c.type === ChannelType.GuildCategory &&
      c.name.toLowerCase() === wantedName,
  );
  if (existing) return existing.id;
  try {
    const cat = await guild.channels.create({
      name: CATEGORY_DISPLAY_NAMES[kind],
      type: ChannelType.GuildCategory,
    });
    return cat.id;
  } catch {
    return null;
  }
}

export interface CreateTicketOptions {
  guild: Guild;
  ownerId: string;
  ownerUsername: string;
  kind: TicketKind;
  topic: string;
  /** Allow the owner to upload images/files. */
  allowAttachments?: boolean;
}

export async function createTicketChannel(
  opts: CreateTicketOptions,
): Promise<{ channel: TextChannel; modRoleId: string | null } | null> {
  const { guild, ownerId, ownerUsername, kind, topic, allowAttachments } = opts;
  const modRoleId = await getConfig("mod_role_id");
  const categoryId = await findOrCreateTicketCategory(guild, kind);

  const safeUsername = ownerUsername
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60) || "user";
  const channelName = `${kind}-${safeUsername}`.slice(0, 90);

  const ownerAllow: bigint[] = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (allowAttachments) ownerAllow.push(PermissionFlagsBits.AttachFiles);

  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, allow: ownerAllow },
  ];
  if (modRoleId) {
    overwrites.push({
      id: modRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      permissionOverwrites: overwrites,
      topic,
    });
    return { channel, modRoleId };
  } catch {
    return null;
  }
}

export const TICKET_PREFIXES = [
  "deposit-",
  "withdraw-",
  "verify-",
  "invite-",
  PAID_TICKET_PREFIX,
];

export function isTicketChannelName(name: string): boolean {
  return TICKET_PREFIXES.some((p) => name.startsWith(p));
}

export function isPaidTicketName(name: string): boolean {
  return name.startsWith(PAID_TICKET_PREFIX);
}

export { CATEGORY_CONFIG_KEYS };
