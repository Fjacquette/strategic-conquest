/**
 * The computer opponent's data, for the side it is playing (player 2; under Auto Play also
 * player 1, the sides being swapped in turn, see day.ts swapSides). Names follow what the
 * code does with each value; offsets are A5 offsets.
 */

/** 16 island records of 22 bytes (index 0 unused), for the side being played. */
export const ISLANDS = -0x1bfc;
export const ISLAND_SIZE = 22;
/** The same records kept for the other side. */
export const OTHER_ISLANDS = -0x0f86;

/** Island record fields. */
export const IS_STATUS = 14; // bits 0-1: the island's standing, counted by AIPlan

/**
 * Per production type, how many of the side's cities are building it (CODE 7 + 0x11EA),
 * and the total (a word).
 */
export const BUILDING = [-0x1c1d, -0x1c1e, -0x1c20, -0x1c1f, -0x1c22, -0x1c21, -0x1c23, -0x1c24];
export const BUILDING_TOTAL = -0x1c1c;

/** How many islands have each status (0-3). */
export const ISLANDS_BY_STATUS = [-0x1c25, -0x1c29, -0x1c2a, -0x1c2b];

export function islandRec(i: number): number {
  return ISLANDS + ISLAND_SIZE * i;
}
