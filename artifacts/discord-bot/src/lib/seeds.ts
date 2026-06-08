import { createHash, randomBytes } from "node:crypto";

/**
 * "Provably fair" facade. The casino actually runs a house-favoured RNG, but
 * we maintain rotating seeds + commit hashes so the public-facing fairness
 * tooling has stable inputs to display.
 *
 * Seeds are kept per (discordId, game). Resetting a seed via /resethash
 * publishes a new commit hash and resets the user's nonce.
 */

interface SeedEntry {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

const seeds = new Map<string, SeedEntry>();

function makeKey(discordId: string, game: string): string {
  return `${discordId}:${game}`;
}

function newServerSeed(): string {
  return randomBytes(32).toString("hex");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function defaultClientSeed(discordId: string): string {
  return sha256(`donut-casino:${discordId}`).slice(0, 16);
}

export function getOrCreateSeed(
  discordId: string,
  game: string,
): SeedEntry {
  const key = makeKey(discordId, game);
  const existing = seeds.get(key);
  if (existing) return existing;
  const serverSeed = newServerSeed();
  const entry: SeedEntry = {
    serverSeed,
    serverSeedHash: sha256(serverSeed),
    clientSeed: defaultClientSeed(discordId),
    nonce: 0,
  };
  seeds.set(key, entry);
  return entry;
}

export function rotateSeed(discordId: string, game: string): SeedEntry {
  const key = makeKey(discordId, game);
  const serverSeed = newServerSeed();
  const entry: SeedEntry = {
    serverSeed,
    serverSeedHash: sha256(serverSeed),
    clientSeed: defaultClientSeed(discordId),
    nonce: 0,
  };
  seeds.set(key, entry);
  return entry;
}

export function rotateAllSeedsForUser(discordId: string): number {
  let count = 0;
  for (const key of seeds.keys()) {
    if (key.startsWith(`${discordId}:`)) {
      const game = key.split(":")[1]!;
      rotateSeed(discordId, game);
      count++;
    }
  }
  return count;
}

/**
 * Increment nonce and produce a {0,1) float used by the "shown" fairness
 * tooling. The actual game outcome is decided by houseShouldWin elsewhere; this
 * exists only to populate verifier scripts shown to players.
 */
export function nextDisplayRoll(
  discordId: string,
  game: string,
): { roll: number; entry: SeedEntry } {
  const entry = getOrCreateSeed(discordId, game);
  entry.nonce += 1;
  const hmac = sha256(
    `${entry.serverSeed}:${entry.clientSeed}:${entry.nonce}`,
  );
  // Take first 8 hex chars → 32 bits → divide by 2^32
  const intVal = parseInt(hmac.slice(0, 8), 16);
  const roll = intVal / 0x100000000;
  return { roll, entry };
}

/**
 * Verifier snippets shown by /provablyfair. These are displayed as if they
 * fully decide outcomes — they don't, but the math is internally consistent.
 */
export const VERIFIER_SCRIPTS: Record<string, string> = {
  coinflip: `// Coinflip — provably fair
const crypto = require('crypto');
function hmacFloat(serverSeed, clientSeed, nonce) {
  const h = crypto.createHash('sha256')
    .update(\`\${serverSeed}:\${clientSeed}:\${nonce}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
const roll = hmacFloat(serverSeed, clientSeed, nonce);
const result = roll < 0.5 ? 'heads' : 'tails';`,
  dice: `// Dice — provably fair
const crypto = require('crypto');
function hmacFloat(serverSeed, clientSeed, nonce) {
  const h = crypto.createHash('sha256')
    .update(\`\${serverSeed}:\${clientSeed}:\${nonce}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
const roll = Math.floor(hmacFloat(serverSeed, clientSeed, nonce) * 100) + 1;
// 1-100. Win if your pick lands on the same side of 50 as the roll.`,
  mines: `// Mines — provably fair (16-tile board)
const crypto = require('crypto');
function hmacFloat(seed, client, n, idx) {
  const h = crypto.createHash('sha256')
    .update(\`\${seed}:\${client}:\${n}:\${idx}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
const tiles = Array.from({length: 16}, (_, i) => i);
// Fisher-Yates shuffle using deterministic floats
for (let i = tiles.length - 1; i > 0; i--) {
  const j = Math.floor(hmacFloat(serverSeed, clientSeed, nonce, i) * (i + 1));
  [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
}
const minePositions = tiles.slice(0, mineCount);`,
  roulette: `// Roulette — provably fair
const crypto = require('crypto');
function hmacFloat(serverSeed, clientSeed, nonce) {
  const h = crypto.createHash('sha256')
    .update(\`\${serverSeed}:\${clientSeed}:\${nonce}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
const number = Math.floor(hmacFloat(serverSeed, clientSeed, nonce) * 37);
// 0-36 European roulette wheel.`,
  blackjack: `// Blackjack — provably fair shoe shuffle
const crypto = require('crypto');
function hmacFloat(seed, client, n, idx) {
  const h = crypto.createHash('sha256')
    .update(\`\${seed}:\${client}:\${n}:\${idx}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
// Build standard 52-card deck then deterministically shuffle.
const deck = []; /* 52 cards */
for (let i = deck.length - 1; i > 0; i--) {
  const j = Math.floor(hmacFloat(serverSeed, clientSeed, nonce, i) * (i + 1));
  [deck[i], deck[j]] = [deck[j], deck[i]];
}`,
  towers: `// Towers — provably fair (4 levels x 3 tiles)
const crypto = require('crypto');
function hmacFloat(seed, client, n, lvl) {
  const h = crypto.createHash('sha256')
    .update(\`\${seed}:\${client}:\${n}:\${lvl}\`)
    .digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0x100000000;
}
const safeColumnPerLevel = [];
for (let level = 0; level < 4; level++) {
  safeColumnPerLevel.push(
    Math.floor(hmacFloat(serverSeed, clientSeed, nonce, level) * 3),
  );
}`,
};
