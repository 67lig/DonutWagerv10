import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { getConfig } from "./db.js";

type AnyInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

/**
 * Hard-coded bot owners. ONLY these users can run financial admin commands
 * (approve deposits, set balances, payouts, reset stats, mint coupons, etc.).
 * Discord's built-in "Administrator" / "Manage Guild" permissions intentionally
 * do NOT grant access to bot admin commands.
 */
export const OWNER_IDS: ReadonlySet<string> = new Set([
  "1493049287511375993",
  "1384009855043633237",
]);

/**
 * The "withdraw staff" Discord role. Holders may run `/admin withdraw`,
 * `/admin help`, and approve verification tickets
 * but cannot use the rest of `/admin`, `/coupon`, etc.
 */
export const WITHDRAW_ROLE_ID = "1498454419123998800";

/**
 * Default mod role. Holders have full staff access: every panel,
 * every transaction, and are invited to all tickets.
 * Can be overridden per-server via `/admin setmodrole`.
 */
export const DEFAULT_MOD_ROLE_ID = "1513738658711207937";

export function isOwner(interaction: AnyInteraction): boolean {
  return OWNER_IDS.has(interaction.user.id);
}

function memberHasRole(
  member: GuildMember | null,
  roleId: string,
): boolean {
  if (!member) return false;
  if (
    "roles" in member &&
    typeof member.roles !== "string" &&
    "cache" in member.roles
  ) {
    return member.roles.cache.has(roleId);
  }
  return false;
}

/**
 * True if the invoking user is owner or has the dedicated withdraw-staff role.
 * Used to gate `/admin withdraw` and `/admin help`.
 */
export function isWithdrawStaff(interaction: AnyInteraction): boolean {
  if (isOwner(interaction)) return true;
  return memberHasRole(
    interaction.member as GuildMember | null,
    WITHDRAW_ROLE_ID,
  );
}

/**
 * Synchronous check: true if the invoking user is an owner OR has the default
 * mod role (DEFAULT_MOD_ROLE_ID). Use this to gate any staff-only command or
 * interaction handler (slash commands, button handlers, modal handlers).
 */
export function isModOrOwner(interaction: AnyInteraction): boolean {
  if (isOwner(interaction)) return true;
  return memberHasRole(
    interaction.member as GuildMember | null,
    DEFAULT_MOD_ROLE_ID,
  );
}

/**
 * True if the invoking member is staff for ticket-style operations:
 * the bot owner, a member of the configured mod role, the default mod role,
 * or the withdraw-staff role.
 *
 * Discord's built-in Administrator / Manage Guild perms do NOT grant
 * staff status: only the explicit mod role (set via `/admin setmodrole`),
 * the default mod role, or the withdraw-staff role.
 */
export async function isMod(interaction: AnyInteraction): Promise<boolean> {
  if (isOwner(interaction)) return true;
  const member = interaction.member as GuildMember | null;
  if (memberHasRole(member, WITHDRAW_ROLE_ID)) return true;
  if (memberHasRole(member, DEFAULT_MOD_ROLE_ID)) return true;
  const modRoleId = await getConfig("mod_role_id");
  if (modRoleId && memberHasRole(member, modRoleId)) return true;
  return false;
}

/**
 * Mask a username so non-mods can't read it. Returns the same number of
 * asterisks as characters in the original (capped at 12) so the UI shape
 * is preserved without leaking length info.
 */
export function maskUsername(name: string | null | undefined): string {
  if (!name) return "*******";
  const len = Math.min(Math.max(name.length, 5), 12);
  return "*".repeat(len);
}
