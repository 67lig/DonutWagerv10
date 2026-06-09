import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { getConfig } from "./db.js";
import { OWNER_IDS } from "./owners.js";

export { OWNER_IDS };

type AnyInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

/**
 * The "withdraw staff" Discord role. Holders may run `/admin withdraw`,
 * `/admin help`, and approve verification tickets
 * but cannot use the rest of `/admin`, `/coupon`, etc.
 */
export const WITHDRAW_ROLE_ID = "1498454419123998800";

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
 */
export function isWithdrawStaff(interaction: AnyInteraction): boolean {
  if (isOwner(interaction)) return true;
  return memberHasRole(
    interaction.member as GuildMember | null,
    WITHDRAW_ROLE_ID,
  );
}

/**
 * True if the invoking user is an owner. Alias kept for call-site clarity.
 */
export function isModOrOwner(interaction: AnyInteraction): boolean {
  return isOwner(interaction);
}

/**
 * True if the invoking member is staff: owner or withdraw-staff role
 * or the configured mod role set via `/admin setmodrole`.
 */
export async function isMod(interaction: AnyInteraction): Promise<boolean> {
  if (isOwner(interaction)) return true;
  const member = interaction.member as GuildMember | null;
  if (memberHasRole(member, WITHDRAW_ROLE_ID)) return true;
  const modRoleId = await getConfig("mod_role_id");
  if (modRoleId && memberHasRole(member, modRoleId)) return true;
  return false;
}

/**
 * Mask a username so non-mods can't read it.
 */
export function maskUsername(name: string | null | undefined): string {
  if (!name) return "*******";
  const len = Math.min(Math.max(name.length, 5), 12);
  return "*".repeat(len);
}
