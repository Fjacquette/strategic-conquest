/**
 * The original game's artwork and sounds, extracted from the owner's copy at build time
 * (tools/assets/extract_assets.py) and embedded in the page by build.mjs.
 */

export interface Assets {
  /** BITS resources: 12 row words each, 16 pixels wide, most significant bit on the left. */
  bits: Record<string, number[]>;
  /** PAT resources: 8 row bytes each. */
  pats: Record<string, number[]>;
  /** Sampled sounds as data: URIs, by resource name (LArmy, LFighter, LShip, LExplosion, LBattle). */
  sounds: Record<string, string>;
  /** STR resources: the game's words. */
  strings: Record<string, string>;
}

declare global {
  interface Window {
    SC_ASSETS?: Assets;
  }
}

/** BITS numbers of the pictures the map uses. */
export const BITS = {
  /** Piece types 0-7 facing right; add 16 for facing left. */
  unitRight: [1, 2, 3, 4, 6, 5, 7, 8],
  unitLeft: [17, 18, 19, 20, 22, 21, 23, 24],
  city: 33,
  neutralCity: 34,
  edge: 37,
} as const;

/** The sea's pattern (PAT 100). */
export const SEA_PATTERN = 100;

export function assets(): Assets | null {
  return window.SC_ASSETS ?? null;
}
