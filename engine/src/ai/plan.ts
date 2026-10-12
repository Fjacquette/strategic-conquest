/**
 * The computer opponent's planning tallies (CODE 7, machine2).
 */
import { Mem } from "../mem.ts";
import { CITY_COUNT } from "../globals.ts";
import { ISLAND_COUNT } from "../mapgen.ts";
import { cityRec } from "../units.ts";
import { BUILDING, BUILDING_TOTAL, IS_STATUS, islandRec, ISLANDS_BY_STATUS } from "./data.ts";

/**
 * CODE 7 + 0x11EA: count the computer's cities by what they build, and the islands by
 * status. Runs at the start of its turn and after each piece it builds.
 */
export function aiPlan(m: Mem): void {
  for (const off of BUILDING) m.setB(off, 0);
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) !== 2) continue;
    const type = m.sb(cr + 8);
    if (type < 0 || type > 7) continue;
    m.setB(BUILDING[type], m.sb(BUILDING[type]) + 1);
  }
  let total = 0;
  for (const off of BUILDING) total += m.sb(off);
  m.setW(BUILDING_TOTAL, total);
  for (const off of ISLANDS_BY_STATUS) m.setB(off, 0);
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) {
    const off = ISLANDS_BY_STATUS[m.b(islandRec(i) + IS_STATUS) & 3];
    m.setB(off, m.sb(off) + 1);
  }
}
