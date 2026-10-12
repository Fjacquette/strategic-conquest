/**
 * What the computer opponent's cities build.
 */
import { Mem, s16 } from "../mem.ts";
import {
  ARMY, BATTLESHIP, BOMBER, CARRIER, CITY_COUNT, DAY, DESTROYER, FIGHTER, PIECE_COUNT, SKILL, SUBMARINE, TRANSPORT, WATER,
} from "../globals.ts";
import { distance, terrainNear } from "../map.ts";
import { ISLAND_CENTERS, ISLAND_COUNT } from "../mapgen.ts";
import { pCargo, pieceAt, pOwner, pState, pType, pX, pY, setCargo, setState } from "../piece.ts";
import { cityRec, setCityOwner } from "../units.ts";
import { BUILDING, ISLAND_BYTES, ISLAND_WORDS, islandRec, PIECES_OF } from "./data.ts";
import { aiPlan } from "./plan.ts";
import { aiSurvey, islandAt, wakeTransports } from "./survey.ts";
import { aiTransport } from "./transports.ts";

/** Ship and aircraft shares (percent) the computer aims for, early and later in the game. */
const AIMS_LATE: Record<number, number> = { [FIGHTER]: 14, [BOMBER]: 12, [DESTROYER]: 16, [SUBMARINE]: 15, [TRANSPORT]: 17, [CARRIER]: 10, [BATTLESHIP]: 16 };
const AIMS_EARLY: Record<number, number> = { [FIGHTER]: 20, [BOMBER]: -100, [DESTROYER]: 40, [SUBMARINE]: -100, [TRANSPORT]: 40, [CARRIER]: -100, [BATTLESHIP]: -100 };

/**
 * CODE 6 + 0x5B78 (by way of CODE 1 + 0x0626): after city `city` of the computer's has
 * built a piece, choose what it builds next.
 *
 * Each ship and aircraft type's share of the side's pieces and production (Bombers count
 * more as the days go by) is compared with an aim. Early in the game (until day 50 less the
 * skill level) an island with more than two of something gets a Transport, then a
 * Destroyer, from a port city if the side has none; inland cities build Armies once there
 * are two Fighters; Armies while the island needs them. Later, Armies while the island
 * needs them. Otherwise a port city builds the ship (or Fighter) furthest below its aim,
 * and an inland city a Bomber, a Fighter or an Army.
 */
export function aiNewPiece(m: Mem, city: number): void {
  const c = cityRec(city);
  const owner = m.sb(c + 4);
  const x = m.sb(c + 7), y = m.sb(c + 6);
  const day = m.sw(DAY);
  const late = day > 50 - m.sb(SKILL);
  const aims = late ? AIMS_LATE : AIMS_EARLY;
  const count = (type: number) => s16(m.sb(BUILDING[type]) + m.sw(PIECES_OF[type]));
  const share: Record<number, number> = {
    [FIGHTER]: count(FIGHTER),
    [BOMBER]: s16(m.sw(PIECES_OF[BOMBER]) + m.sb(BUILDING[BOMBER]) * (Math.trunc(day / 140) + 1)),
    [DESTROYER]: count(DESTROYER),
    [SUBMARINE]: count(SUBMARINE),
    [TRANSPORT]: count(TRANSPORT),
    [CARRIER]: count(CARRIER),
    [BATTLESHIP]: count(BATTLESHIP),
  };
  const types = [FIGHTER, BOMBER, DESTROYER, SUBMARINE, TRANSPORT, CARRIER, BATTLESHIP];
  const total = s16(types.reduce((n, t) => n + share[t], 0));
  for (const t of types) share[t] = total === 0 ? 0 : s16(Math.trunc(s16(100 * share[t]) / total) - aims[t]);

  const set = (type: number) => setCityOwner(m, type, city, owner);
  const isl = islandRec(m.b(c + 9));
  const armiesNeeded = () => s16(m.sw(isl) + m.sb(isl + 8) - 6 * m.sb(isl + 18));
  const port = () => terrainNear(m, x, y, 1 << WATER);
  if (late) {
    if ((m.b(isl + 14) & 3) === 3 || armiesNeeded() < 8) {
      set(ARMY);
      return;
    }
  } else {
    const crowded = m.sb(isl + 12) > 2;
    if (crowded && port() && count(TRANSPORT) === 0) {
      set(TRANSPORT);
      return;
    }
    if (crowded && port() && count(DESTROYER) === 0) {
      set(DESTROYER);
      return;
    }
    if (!port() && count(FIGHTER) >= 2) {
      set(ARMY);
      return;
    }
    if (armiesNeeded() < 5) {
      set(ARMY);
      return;
    }
  }
  if (port()) {
    let type = TRANSPORT, low = share[TRANSPORT];
    if (low > share[DESTROYER]) { low = share[DESTROYER]; type = DESTROYER; }
    if (low > share[SUBMARINE]) { low = share[SUBMARINE]; type = SUBMARINE; }
    if (low > share[CARRIER] && count(CARRIER) < 3) { low = share[CARRIER]; type = CARRIER; }
    if (low > share[BATTLESHIP]) { low = share[BATTLESHIP]; type = BATTLESHIP; }
    if (low > share[FIGHTER]) { type = FIGHTER; }
    set(type);
  } else if (share[FIGHTER] > share[BOMBER] && late && share[BOMBER] < 4) {
    set(BOMBER);
  } else {
    set(share[FIGHTER] < aims[FIGHTER] ? FIGHTER : ARMY);
  }
}

/**
 * CODE 6 + 0x4C72: the computer opponent's production, at the start of its turn and when
 * one of its cities asks: it surveys the world; a city on an island with more than one
 * enemy city builds Armies; each island's standing is reviewed; every Army notes the island
 * it is on (in its cargo field); the tallies and the islands to attack and defend are
 * updated; and each of its Transports is looked at.
 */
export function aiProduction(m: Mem): void {
  aiSurvey(m);
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) !== 2) continue;
    const r = islandRec(islandAt(m, m.sb(cr + 7), m.sb(cr + 6)));
    if (m.sb(r + 13) > 1) setCityOwner(m, ARMY, c, 2);
  }
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) aiIslandReview(m, i);
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pType(m, p) === ARMY) setCargo(m, p, islandAt(m, pX(m, p), pY(m, p)));
  }
  aiPlan(m);
  aiFocus(m);
  // Transports come first in the piece table (it is compacted with them at the front).
  for (let i = 1; pType(m, pieceAt(i)) === TRANSPORT; i++) {
    if (pOwner(m, pieceAt(i)) === 2) aiTransport(m, i);
  }
}

/** An island's standing (record byte 14, bits 0-1). */
export const STANDING_CLEARED = 1;
export const STANDING_UNKNOWN = 2;
export const STANDING_ENEMY = 3;

function setStanding(m: Mem, r: number, v: number): void {
  m.setB(r + 14, (m.b(r + 14) & 0xfc) | v);
}

/** Wake the piece an island's word holds (a Transport assigned to it), and clear the word. */
function releaseAssigned(m: Mem, island: number): void {
  const idx = m.sw(ISLAND_WORDS + 2 * island);
  if (idx === 0) return;
  setState(m, pieceAt(idx), 1);
  m.setW(ISLAND_WORDS + 2 * island, 0);
}

/**
 * CODE 7 + 0x13AE: review island `island`'s standing. Once some of it is explored: with
 * enemy cities or Armies seen there it becomes an enemy island (3); fully explored with no
 * enemy or neutral cities, after more than two reviews in its standing, it becomes cleared
 * (1); otherwise a cleared or unknown island goes back to 0. A change wakes Transports and
 * restarts the review count.
 */
export function aiIslandReview(m: Mem, island: number): void {
  const r = islandRec(island);
  const enemyCities = m.sb(r + 13), neutralCities = (m.b(r + 14) >> 2) & 0x3f;
  if (enemyCities + neutralCities !== 0) m.setB(r + 16, 0);
  if ((m.b(r + 15) & 0x80) === 0) return;
  const standing = m.b(r + 14) & 3;
  if (enemyCities !== 0 || m.sw(r + 2) !== 0) {
    if (standing === STANDING_ENEMY) return;
    if (standing === STANDING_CLEARED) m.setB(ISLAND_BYTES + island, 1);
    releaseAssigned(m, island);
    wakeLightTransports(m);
    setStanding(m, r, STANDING_ENEMY);
    m.setW(r + 20, 0);
    wakeTransports(m);
  } else if ((m.b(r + 15) & 0x40) !== 0 && enemyCities + neutralCities === 0) {
    if (standing !== STANDING_CLEARED && m.sw(r + 20) > 2) {
      releaseAssigned(m, island);
      wakeTransports(m);
      setStanding(m, r, STANDING_CLEARED);
      m.setW(r + 20, 0);
    }
  } else if (standing !== 0 && standing !== STANDING_ENEMY) {
    wakeLightTransports(m);
    setStanding(m, r, 0);
    m.setW(r + 20, 0);
  }
}

/**
 * CODE 1 + 0x0850: clear the islands' words, and wake player 2's Transports with fewer
 * than six Armies aboard that are under orders or asleep.
 */
export function wakeLightTransports(m: Mem): void {
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) m.setW(ISLAND_WORDS + 2 * i, 0);
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pOwner(m, p) !== 2 || pType(m, p) !== TRANSPORT || pCargo(m, p) >= 6) continue;
    if (pState(m, p) === 0 || pState(m, p) === 2) setState(m, p, 1);
  }
}

/** The centre of the enemy islands and of the cleared ones (x, y bytes), and the chosen pair. */
export const ENEMY_CENTRE_X = -0x1c05;
export const ENEMY_CENTRE_Y = -0x1c06;
export const CLEARED_CENTRE_X = -0x1c09;
export const CLEARED_CENTRE_Y = -0x1c0a;
/** The enemy island nearest the cleared islands' centre (word). */
export const TARGET_ISLAND = -0x1c02;
/** The cleared island nearest the target island (word). */
export const BASE_ISLAND = -0x1c04;

/**
 * CODE 6 + 0x5630: the centres of the enemy islands and of the cleared ones (40, 30 when
 * there are none), the enemy island nearest the cleared islands' centre (the target) and
 * the cleared island nearest the target (the base).
 */
export function aiFocus(m: Mem): void {
  const islands = m.sb(ISLAND_COUNT);
  const cx = (i: number) => m.sb(ISLAND_CENTERS + 2 * i + 1);
  const cy = (i: number) => m.sb(ISLAND_CENTERS + 2 * i);
  const standing = (i: number) => m.b(islandRec(i) + 14) & 3;
  let ex = 0, ey = 0, en = 0, clx = 0, cly = 0, cln = 0;
  for (let i = 1; i <= islands; i++) {
    if (standing(i) === STANDING_ENEMY) {
      ex += cx(i); ey += cy(i); en++;
    } else if (standing(i) === STANDING_CLEARED) {
      clx += cx(i); cly += cy(i); cln++;
    }
  }
  m.setB(ENEMY_CENTRE_X, en ? Math.trunc(s16(ex) / en) : 40);
  m.setB(ENEMY_CENTRE_Y, en ? Math.trunc(s16(ey) / en) : 30);
  m.setB(CLEARED_CENTRE_X, cln ? Math.trunc(s16(clx) / cln) : 40);
  m.setB(CLEARED_CENTRE_Y, cln ? Math.trunc(s16(cly) / cln) : 30);
  m.setW(TARGET_ISLAND, 0);
  if (en) {
    let best = 5000;
    for (let i = 1; i <= islands; i++) {
      const d = distance(cx(i) - m.sb(CLEARED_CENTRE_X), cy(i) - m.sb(CLEARED_CENTRE_Y));
      if (d < best && standing(i) === STANDING_ENEMY) {
        best = d;
        m.setW(TARGET_ISLAND, i);
      }
    }
  }
  m.setW(BASE_ISLAND, 0);
  const target = m.sw(TARGET_ISLAND);
  if (target) {
    let best = 5000;
    const tx = cx(target), ty = cy(target);
    for (let i = 1; i <= islands; i++) {
      const d = distance(cx(i) - tx, cy(i) - ty);
      if (d < best && standing(i) === STANDING_CLEARED) {
        best = d;
        m.setW(BASE_ISLAND, i);
      }
    }
  }
}
