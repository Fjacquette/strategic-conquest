/**
 * The computer opponent's start-of-game set-up (CODE 2, EMPINIT).
 */
import { Mem } from "../mem.ts";
import { CITY_COUNT } from "../globals.ts";
import { ISLAND_CENTERS, ISLAND_COUNT, islandAt } from "../mapgen.ts";
import {
  BUILDING, BUILDING_TOTAL, CITY_MARKS, ISLAND_SIZE, ISLANDS, islandRec, ISLAND_BYTES, ISLAND_WORDS, OTHER_ISLANDS,
  SIDE_WORDS,
} from "./data.ts";

/**
 * CODE 2 + 0x2E3A: at the start of a game against the computer, the other side's data
 * starts as a copy of the island records, with its tallies cleared.
 */
export function aiNewGame(m: Mem): void {
  for (let i = 0; i <= 15; i++) {
    m.setW(-0x0cbc + 2 * i, 0);
    m.setB(-0x0c20 + i, 0);
  }
  m.bytes(-0x0c7c, 46).fill(0);
  m.copy(OTHER_ISLANDS, ISLANDS, 16 * ISLAND_SIZE);
  m.setW(-0x0cc6, m.w(-0x1c02));
  m.setB(-0x0cc2, m.b(-0x1bfd));
  m.setW(-0x0cc0, m.w(-0x1c2e));
  for (let i = 0; i < 18; i++) m.setW(-0x0c00 + 2 * i, 0);
  m.bytes(-0x0bdc, 16).fill(0);
  for (const off of BUILDING) m.setB(off, 0);
}

/**
 * CODE 2 + 0x24DE: the start-of-game set-up of the side whose data is current: tallies
 * cleared, and each island's record reset, with the top row of the island in its centre's
 * column. (Island 0's record keeps that row from before, plus one.)
 */
export function aiNewSide(m: Mem): void {
  for (const off of SIDE_WORDS) m.setW(off, 0);
  m.setW(BUILDING_TOTAL, 0);
  for (const off of BUILDING) m.setB(off, 0);
  const cities = m.sb(CITY_COUNT);
  for (let c = 0; c <= cities; c++) m.setB(CITY_MARKS + c, 0);
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 0; i <= islands; i++) {
    const r = islandRec(i);
    m.setW(ISLAND_WORDS + 2 * i, 0);
    m.setB(ISLAND_BYTES + i, 0);
    m.setW(r + 20, 0);
    for (let k = 0; k < 8; k += 2) m.setW(r + k, 0);
    m.bytes(r + 8, 6).fill(0);
    m.setB(r + 14, 2);
    m.setB(r + 15, m.b(r + 15) & 0x3e);
    m.setB(r + 16, 1);
    if (i !== 0) {
      const cx = m.sb(ISLAND_CENTERS + 2 * i + 1);
      m.setB(r + 17, m.sb(ISLAND_CENTERS + 2 * i));
      do {
        m.setB(r + 17, m.sb(r + 17) - 1);
      } while (islandAt(m, cx, m.sb(r + 17)) === i && m.sb(r + 17) !== 1);
    }
    m.setB(r + 17, m.sb(r + 17) + 1);
    m.setB(r + 16, 0);
    m.setB(r + 18, 0);
  }
  m.setB(-0x1bfd, 0);
  m.setW(-0x1c02, 0);
  m.setB(-0x1c91, 0);
}
