/**
 * The one permanent Full Owner. Only this ID can assign a 2nd owner.
 * No other file should hard-code owner IDs.
 */
export const FULL_OWNER_ID = "1384009855043633237";

/**
 * In-memory cache of the DB-stored 2nd owner. Populated on startup via
 * loadSecondOwner() and updated live when the Full Owner sets a new one.
 */
let _secondOwnerId: string | null = null;

export function getSecondOwnerId(): string | null {
  return _secondOwnerId;
}

export function setSecondOwnerIdCache(id: string | null): void {
  _secondOwnerId = id;
}

/**
 * Returns true if the given Discord user ID has owner-level access
 * (either the Full Owner or the current 2nd owner).
 */
export function isOwnerById(userId: string): boolean {
  if (userId === FULL_OWNER_ID) return true;
  if (_secondOwnerId && userId === _secondOwnerId) return true;
  return false;
}

/**
 * Returns true if the given Discord user ID is the Full Owner specifically.
 */
export function isFullOwnerById(userId: string): boolean {
  return userId === FULL_OWNER_ID;
}
