/**
 * The computer opponent's survey of the world, made before it decides what its cities
 * build (CODE 8 + 0x0004, by way of CODE 1 + 0x0702).
 */
import { Mem } from "../mem.ts";
import { ARMY, CITY_COUNT, ISLAND_MAP, PIECE_COUNT, TRANSPORT } from "../globals.ts";
import { explored } from "../map.ts";
import { ISLAND_BOUNDS, ISLAND_COUNT } from "../mapgen.ts";
import { pieceAt, pOwner, pSpotted, pState, pType, pX, pY, setState } from "../piece.ts";
import { cityRec } from "../units.ts";
import { CITY_MARKS, ISLAND_BYTES, ISLAND_WORDS, islandRec, PIECES_OF } from "./data.ts";

/** Per city: two words the survey resets (a distance, 5000 when none is known, and another). */
const CITY_WORD_A = -0x1cee;
const CITY_DISTANCE = -0x1d4a;
/** A byte set once the side has three Transports. */
export const HAS_TRANSPORTS = -0x1bfd;

/** The island number of square (x, y). */
export function islandAt(m: Mem, x: number, y: number): number {
  const row = y - 1;
  return (m.b(ISLAND_MAP + (x - 1) * 30 + (row >> 1)) >> ((row & 1) << 2)) & 0x0f;
}

/** Cities on island record `r` that player 2 has seen: its own, the enemy's, neutral. */
const ownCities = (m: Mem, r: number) => m.sb(r + 12);
const enemyCities = (m: Mem, r: number) => m.sb(r + 13);
const neutralCities = (m: Mem, r: number) => (m.b(r + 14) >> 2) & 0x3f;

/**
 * CODE 1 + 0x078A: clear the islands' words, and wake player 2's Transports that are
 * under orders or asleep.
 */
export function wakeTransports(m: Mem): void {
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) m.setW(ISLAND_WORDS + 2 * i, 0);
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pOwner(m, p) === 2 && pType(m, p) === TRANSPORT && (pState(m, p) === 0 || pState(m, p) === 2)) setState(m, p, 1);
  }
}

/**
 * CODE 8 + 0x0004: count the side's pieces by type, and for each island what player 2 has
 * seen there: its own, the enemy's and neutral cities, its own Armies and the enemy's
 * spotted Armies, and whether any or all of the island is explored. Armies on an island
 * with enemy or neutral cities or enemy Armies are woken. With a new count of Transports
 * the islands' words are cleared; three or more Transports set HAS_TRANSPORTS.
 */
export function aiSurvey(m: Mem): void {
  const cities = m.sb(CITY_COUNT);
  for (let c = 0; c <= cities; c++) {
    m.setW(CITY_WORD_A + 2 * c, 0);
    m.setW(CITY_DISTANCE + 2 * c, 5000);
  }
  const transportsBefore = m.sw(PIECES_OF[TRANSPORT]);
  for (const off of PIECES_OF) m.setW(off, 0);

  const islands = m.sb(ISLAND_COUNT);
  let lastCities = 0;
  for (let i = 1; i <= islands; i++) {
    const r = islandRec(i);
    m.setW(r + 20, m.w(r + 20) + 1);
    m.setB(r + 15, m.b(r + 15) & 0x7f);
    for (let k = 0; k < 8; k += 2) m.setW(r + k, 0);
    lastCities = ownCities(m, r) + enemyCities(m, r) + neutralCities(m, r);
    m.setB(r + 12, 0);
    m.setB(r + 13, 0);
    m.setB(r + 8, 0);
    m.setB(r + 9, 0);
    m.setB(r + 10, 0);
    m.setB(r + 14, m.b(r + 14) & 0x03);
    m.setB(r + 11, 0);
    m.setB(r + 18, 0);
    m.setB(r + 15, m.b(r + 15) | 0x40);
    const b = ISLAND_BOUNDS + 4 * (i - 1);
    const top = Math.max(2, m.sb(b)), left = Math.max(2, m.sb(b + 1));
    const bottom = Math.min(59, m.sb(b + 2)), right = Math.min(79, m.sb(b + 3));
    for (let x = left; x <= right; x++) {
      for (let y = top; y <= bottom; y++) {
        if (islandAt(m, x, y) !== i) continue;
        const seen = explored(m, 2, x, y);
        // Bit 7: some of the island is explored; bit 6: all of it.
        if (seen) m.setB(r + 15, m.b(r + 15) | 0x80);
        else m.setB(r + 15, m.b(r + 15) & 0xbf);
      }
    }
  }

  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    const x = m.sb(cr + 7), y = m.sb(cr + 6);
    if (!explored(m, 2, x, y)) continue;
    const r = islandRec(islandAt(m, x, y));
    const owner = m.sb(cr + 4);
    if (owner === 1) m.setB(r + 13, m.sb(r + 13) + 1);
    else if (owner === 0) m.setB(r + 14, (m.b(r + 14) & 0x03) | (((neutralCities(m, r) + 1) & 0x3f) << 2));
    else if (owner === 2) m.setB(r + 12, m.sb(r + 12) + 1);
  }

  for (let i = 1; i <= islands; i++) {
    const r = islandRec(i);
    if (ownCities(m, r) === 0) m.setB(ISLAND_BYTES + i, 0);
    // The last island's count of cities before the survey stands for every island here.
    if (lastCities === 0 && ownCities(m, r) + enemyCities(m, r) + neutralCities(m, r) !== 0) {
      m.setW(ISLAND_WORDS + 2 * i, 0);
      wakeTransports(m);
    }
  }

  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    const type = pType(m, p), owner = pOwner(m, p);
    if (owner === 2 && type <= 7) m.setW(PIECES_OF[type], m.w(PIECES_OF[type]) + 1);
    if (type !== ARMY || !explored(m, 2, pX(m, p), pY(m, p))) continue;
    const r = islandRec(islandAt(m, pX(m, p), pY(m, p)));
    if (owner === 1) {
      if (pSpotted(m, p) !== 0) m.setW(r + 2, m.w(r + 2) + 1);
    } else {
      m.setW(r, m.w(r) + 1);
    }
  }
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pOwner(m, p) !== 2 || pType(m, p) !== ARMY) continue;
    const r = islandRec(islandAt(m, pX(m, p), pY(m, p)));
    if (neutralCities(m, r) + enemyCities(m, r) + m.sw(r + 2) > 0) setState(m, p, 1);
  }

  if (m.sw(PIECES_OF[TRANSPORT]) >= 3) m.setB(HAS_TRANSPORTS, 1);
  if (m.sw(PIECES_OF[TRANSPORT]) !== transportsBefore) {
    for (let i = 1; i <= islands; i++) m.setW(ISLAND_WORDS + 2 * i, 0);
  }
  for (let c = 1; c <= cities; c++) m.setB(CITY_MARKS + c, 0);
}
