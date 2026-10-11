/**
 * The tables the original sets up once at launch (CODE 2 + 0x2CE2, CODE 2 + 0x2DEA and the
 * combat table), so that an empty globals image can start a game.
 */
import { Mem } from "./mem.ts";
import { INIT_DONE, OPPONENT_OF, OWN_CITY_CODE, TYPE_STR_IDS } from "./globals.ts";
import { initCombatTable } from "./battle.ts";

/** Words: a picture number per piece type (types 0-7 and 9). */
export const TYPE_PICTURES = -0x1310;
/** Bytes: the piece types in the order the user interface lists them (Transport before Carrier). */
export const TYPE_ORDER = -0x132e;
/** Words: cosines (× 100) in steps of about 7 degrees, from the TRIG resource. */
export const TRIG_TABLE = -0x12ec;

const TRIG = [
  100, 99, 97, 93, 88, 81, 73, 64, 54, 43, 31, 19, 6, 0, -6, -19, -31, -43, -54, -64, -73, -81, -88,
  -93, -97, -99, -100, -99, -97, -93, -88, -81, -73, -64, -54, -43, -31, -19, -6, 0, 6, 19, 31, 43, 54,
  64, 73, 81, 88, 93, 97, 99,
];

/** CODE 2 + 0x2CE2, CODE 2 + 0x2DEA and CODE 2 + 0x0004. */
export function initGlobals(m: Mem): void {
  const pictures = [1, 2, 3, 4, 6, 5, 7, 8];
  pictures.forEach((v, t) => m.setW(TYPE_PICTURES + 2 * t, v));
  m.setW(TYPE_PICTURES + 2 * 9, 39);
  const strIds = [1, 2, 3, 4, 6, 5, 7, 8, 9, 10];
  strIds.forEach((v, t) => m.setW(TYPE_STR_IDS + 2 * t, v));
  m.bytes(TYPE_ORDER, 10).set([0, 1, 2, 3, 5, 4, 6, 7, 8, 9]);
  m.bytes(OPPONENT_OF, 3).set([0, 2, 1]);
  m.bytes(OWN_CITY_CODE, 3).set([1, 2, 4]);
  TRIG.forEach((v, i) => m.setW(TRIG_TABLE + 2 * i, v));
  m.setB(INIT_DONE, 1);
  initCombatTable(m);
}
