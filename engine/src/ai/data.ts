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

/** The side's nine planning words (cleared at the start of a game). */
export const SIDE_WORDS = [-0x1c0c, -0x1c0e, -0x1c10, -0x1c12, -0x1c14, -0x1c16, -0x1c18, -0x1c1a];

/** A word per island (16). */
export const ISLAND_WORDS = -0x1c4e;
/**
 * A word per island (island i at index i - 1) subtracted from distances to the island's
 * centre when the computer picks islands for its Transports. Nothing writes it, so it is
 * always 0.
 */
export const ISLAND_ALLOWANCE = -0x388c;

/** A byte per island (16). */
export const ISLAND_BYTES = -0x1c5e;
/** A byte per city (46). */
export const CITY_MARKS = -0x1c8c;

/**
 * Per city (words): how many Armies have been sent to take it, and the shortest distance
 * from which one was sent (5000 when none). The survey resets them.
 */
export const CITY_SENT = -0x1cee;
export const CITY_SENT_DISTANCE = -0x1d4a;

/** The step the computer chose for the piece it is moving (signed bytes). */
export const REPLY_DX = -0x1bff;
export const REPLY_DY = -0x1bfe;

/** The side's pieces of each type, by piece type (words). */
export const PIECES_OF = [-0x1c0c, -0x1c0e, -0x1c12, -0x1c10, -0x1c16, -0x1c14, -0x1c18, -0x1c1a];

/** How many islands have each status (0-3). */
export const ISLANDS_BY_STATUS = [-0x1c25, -0x1c29, -0x1c2a, -0x1c2b];

export function islandRec(i: number): number {
  return ISLANDS + ISLAND_SIZE * i;
}
