/**
 * A5 offsets of the original's globals, and the constants that describe them.
 * Layouts of the larger blocks are documented in docs/save-format.md.
 */

// ----- saved game state -----
export const PIECE_HASH = -0x5592; // 551 word slots + max probe length (word at +0x44E)
export const PIECES = -0x5138; // 451 records of 14 bytes; record 0 unused
export const PIECE_COUNT = -0x388e; // word: highest record in use
export const CITIES = -0x385e; // 46 records of 10 bytes; record 0 unused
export const ISLAND_MAP = -0x3672;
export const MOVE_STEP = -0x2d10; // word: step number of the piece being moved (1-based)
export const LOCAL_PLAYER = -0x2d0a;
export const DAY = -0x2d08; // word
export const SKILL = -0x2ce6;
export const PLAYER_MAPS = -0x2cd8; // 2 x 642 bytes: explored bitmap, computer flag, spare
export const TERRAIN = -0x27d2; // 80 x 60 nibbles, column-major
export const GAME_MODE = -0x1e71;
export const GAME_SEED = -0x1e70;
export const CITY_COUNT = -0x1e4f;

// ----- tables built at launch -----
export const COMBAT_TABLE = -0x55c2;
export const TYPE_STR_IDS = -0x1324;
export const OWN_CITY_CODE = -0x1284; // [player] -> terrain code of that player's cities
export const OPPONENT_OF = -0x1280; // [player] -> other player
export const INIT_DONE = -0x1277; // byte: the launch tables are in place

// ----- turn state -----
export const FOUND_ENEMY = -0x513e; // word: piece found by enemyAdjacent()
export const NET_SYNC = -0x513c; // byte: set around moves (CODE 1 + 0x0176); gates network updates
export const REGION_START = -0x28d; // byte: first of the 16 map regions to move this turn
export const MOVES_LEFT = -0x1a98; // word: moves left for the piece being moved, this step included
export const ANY_DEFERRED = -0x1a99; // byte: some piece's step was deferred; sweep again
export const STEP_FLAG_1A95 = -0x1a95; // byte: cleared before each step
export const PIECE_DONE = -0x120a; // byte: the piece being moved has finished for the day
export const PIECE_DEFERRED = -0x120b; // byte: the piece's step is deferred to a later sweep
export const FOUND_Y = -0x12fc; // byte: cell found by terrainNear()
export const FOUND_X = -0x12fb;

// ----- day loop -----
export const AUTO_PLAY = -0x120c; // byte: the computer plays player 1's side
export const AUTO_PLAY_REQUESTED = -0x120d; // byte: Auto Play menu choice, applied at the end of the day
export const NET_TURN = -0x1c07; // byte: whose turn it is, for the network game
export const VIEW_PLAYER = -0x29a; // byte: player whose view the map window shows
export const CITIES_P1 = -0x138e; // word: player 1's cities, counted by defeated()
export const CITIES_P2 = -0x138c; // word: player 2's cities
export const AUTOSAVE_OFF = -0x1401; // byte: no save file yet, so no autosave

// ----- random generators -----
export const PRNG_SEED = -0x127c; // game PRNG (CODE 1 + 0x2AFA)
export const QD_RANDSEED = -0x23a; // QuickDraw randSeed

// ----- sizes -----
export const PIECE_SIZE = 14;
export const MAX_PIECES = 450;
export const CITY_SIZE = 10;
export const PLAYER_MAP_SIZE = 0x282;
export const COMPUTER_FLAG = 0x280; // offset within a player map
export const HASH_SLOTS = 551;
export const HASH_MAX_PROBE = 0x44e; // offset within the hash block
export const MAP_W = 80;
export const MAP_H = 60;

// ----- piece types -----
export const ARMY = 0;
export const FIGHTER = 1;
export const DESTROYER = 2;
export const SUBMARINE = 3;
export const CARRIER = 4;
export const TRANSPORT = 5;
export const BATTLESHIP = 6;
export const BOMBER = 7;
export const REMOVED = 8; // destroyed this turn; slot freed by compaction
export const EMPTY = 9;

// ----- terrain codes -----
export const WATER = 0;
export const CITY_NEUTRAL = 1;
export const CITY_P1 = 2;
export const LAND = 3;
export const CITY_P2 = 4;
export const EDGE = 5;
