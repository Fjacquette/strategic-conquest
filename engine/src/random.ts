/**
 * The original's two random generators. Both keep their state in the globals.
 */
import { Mem, s16 } from "./mem.ts";
import { PRNG_SEED, QD_RANDSEED } from "./globals.ts";

/**
 * CODE 1 + 0x2AFA: the game PRNG used for combat, path-finding ties and the computer
 * opponent. 15 bits of state; returns a signed word, never -32768.
 */
export function gameRandom(m: Mem): number {
  const seed = (((m.l(PRNG_SEED) + 1) & 0x7fff) * 977 + 113) >>> 0;
  m.setL(PRNG_SEED, seed);
  const r = s16(seed << 7);
  return r === -32768 ? -32767 : r;
}

/**
 * QuickDraw Random (trap A861, and its copy at CODE 1 + 0x0102): Park-Miller minimal
 * standard generator on randSeed; returns the low word of the new seed as a signed word,
 * with -32768 mapped to 0.
 */
export function qdRandom(m: Mem): number {
  const seed = Number((BigInt(m.l(QD_RANDSEED)) * 16807n) % 0x7fffffffn);
  m.setL(QD_RANDSEED, seed);
  const r = s16(seed & 0xffff);
  return r === -32768 ? 0 : r;
}

/** CODE 1 + 0x068E: a coin toss from QuickDraw Random (true when it is negative). */
export function randomBool(m: Mem): boolean {
  return qdRandom(m) < 0;
}
