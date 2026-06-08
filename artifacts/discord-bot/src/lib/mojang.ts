export const JAVA_IGN_REGEX = /^[A-Za-z0-9_]{3,16}$/;

export interface MojangProfile {
  id: string;
  name: string;
}

/**
 * Look up a Java Edition Minecraft account via the Mojang API.
 * Returns the profile (with canonical name + UUID) on success, null if the
 * account does not exist or the request fails.
 * Bedrock accounts are NOT accepted — Mojang only knows Java accounts.
 */
export async function lookupJavaProfile(
  username: string,
): Promise<MojangProfile | null> {
  try {
    const r = await fetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (r.status !== 200) return null;
    return (await r.json()) as MojangProfile;
  } catch {
    return null;
  }
}
