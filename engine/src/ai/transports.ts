/**
 * The computer opponent's Transports.
 */
import { Mem, s16, scratchRecord } from "../mem.ts";
import { ARMY, CITY_P2, DAY, LAND, OPPONENT_OF, PIECE_COUNT, PIECE_HASH, TRANSPORT } from "../globals.ts";
import { distance, inSet, onMap, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_CENTERS, ISLAND_COUNT, islandAt } from "../mapgen.ts";
import { wakeAllAt } from "../moveops.ts";
import { AI_LIMIT_10 } from "../newgame.ts";
import { type Dir, rotate } from "../path.ts";
import { isWeakened } from "../battle.ts";
import { pCargo, pieceAt, pOwner, pState, pStrength, pType, pX, pY, setCargo, setState } from "../piece.ts";
import { countAt, enemyAdjacent, foundEnemy, topIs } from "../query.ts";
import { qdRandom } from "../random.ts";
import { cityRec } from "../units.ts";
import {
  BUILDING, BUILDING_TOTAL, ISLAND_ALLOWANCE, ISLAND_BYTES, ISLAND_WORDS, islandRec,
} from "./data.ts";
import { closedTerrain, evade, foundCell, fullStrength, setReply } from "./moves.ts";
import { CLEARED_CENTRE_X, CLEARED_CENTRE_Y, TARGET_ISLAND, wakeLightTransports } from "./production.ts";
import { nearestPort, randomSeaTarget, shipGoTo } from "./ships.ts";
import { wakeTransports } from "./survey.ts";

/** Cities of either player (terrain 2, 4). */
const PLAYER_CITIES = 0x14;
/** Land or any city (terrain 1-4). */
const LAND_OR_CITY = 0x1e;
/** Land or a player's city (terrain 2-4). */
const SHORE = 0x1c;

/**
 * CODE 6 + 0x605E: the island a piece record is on or next to. A piece on land is on its
 * island. A Transport or Army at sea is next to the island of its piece's point A (the
 * start of its current go-to) if that is beside it, otherwise the last island seen beside
 * it; other pieces, the first island beside them.
 */
export function pieceIsland(m: Mem, idx: number, rec: Uint8Array): number {
  const x = (rec[7] << 24) >> 24, y = (rec[6] << 24) >> 24;
  const here = islandAt(m, x, y);
  if (here !== 0) return here;
  const type = rec[10] & 0x0f;
  if (type === TRANSPORT || type === ARMY) {
    const a = pieceAt(idx);
    let home = islandAt(m, m.sb(a + 1), m.sb(a));
    if (home === 0) home = -34;
    let last = 0;
    for (let cx = x - 1; cx <= x + 1; cx++) {
      for (let cy = y - 1; cy <= y + 1; cy++) {
        const v = islandAt(m, cx, cy);
        if (v === home) return home;
        if (v !== 0) last = v;
      }
    }
    return last;
  }
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) {
      const v = islandAt(m, cx, cy);
      if (v !== 0) return v;
    }
  }
  return 0;
}

/**
 * CODE 6 + 0x4928: one of the computer's Transports, `idx`, during its production. Its
 * cargo field takes the number of Armies aboard (0 in a city; the count also clears those
 * Armies' island field). An asleep Transport wakes. A loading Transport beside land looks
 * round the eight squares from a random direction, turning a random way; for each one of
 * land or a city on the map, the island it is beside decides: an unclaimed island (0) with
 * land beside the Transport counts another Transport there; an enemy island wakes it; a
 * cleared island with land beside it counts another Transport, and the first one wakes the
 * island's Armies (those after it in the piece table) and stops the search.
 */
export function aiTransport(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  if (inSet(PLAYER_CITIES, terrainAt(m, x, y))) {
    setCargo(m, p, 0);
  } else {
    setCargo(m, p, countAt(m, PIECE_HASH, x, y, 1 << pOwner(m, p), 1 << ARMY, 0, true, false, 9));
  }
  if (pState(m, p) === 2) {
    setState(m, p, 1);
    return;
  }
  if (pState(m, p) !== 3 || !terrainNear(m, x, y, LAND_OR_CITY)) return;
  const d: Dir = { dx: qdRandom(m) % 2, dy: qdRandom(m) % 2 };
  const turn = qdRandom(m) < 0 ? 1 : 0;
  for (let k = 1; k <= 8; k++) {
    rotate(turn, d);
    const nx = x + d.dx, ny = y + d.dy;
    if (!inSet(SHORE, terrainAt(m, nx, ny)) || !onMap(nx, ny)) continue;
    const island = pieceIsland(m, idx, m.bytes(p, 14).slice());
    const r = islandRec(island);
    const standing = m.b(r + 14) & 3;
    if (standing === 0) {
      if (terrainNear(m, x, y, 1 << LAND)) m.setB(r + 18, m.sb(r + 18) + 1);
    } else if (standing === 3) {
      setState(m, p, 1);
    } else if (standing === 1 && terrainNear(m, x, y, 1 << LAND)) {
      m.setB(r + 18, m.sb(r + 18) + 1);
      if (m.sb(r + 18) === 1) {
        const n = m.sw(PIECE_COUNT);
        for (let i = idx; i <= n; i++) {
          const q = pieceAt(i);
          if (pOwner(m, q) === pOwner(m, p) && pType(m, q) === ARMY && pCargo(m, q) === island) setState(m, q, 1);
        }
      }
      return;
    }
  }
}

/** CODE 9 + 0x0004: wake player 2's Armies whose island field is `island`. */
export function wakeIslandArmies(m: Mem, island: number): void {
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    if (pOwner(m, q) === 2 && pType(m, q) === ARMY && pCargo(m, q) === island) setState(m, q, 1);
  }
}

/**
 * CODE 6 + 0x2694: a computer Transport `idx` under orders, beside land, whose go-to
 * destination is the centre of the island it is beside, has arrived: if it is empty and
 * beside land or a player 2 city it wakes the lightly loaded Transports and the island's
 * Armies (its own state is set to loading only in a copy, which is dropped); otherwise it
 * wakes everything at the island's centre. Returns whether it arrived (the move is then
 * left for the next request).
 */
export function transportArrives(m: Mem, idx: number): boolean {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  if (!terrainNear(m, x, y, LAND_OR_CITY)) return false;
  const island = pieceIsland(m, idx, m.bytes(p, 14).slice());
  const cx = m.sb(ISLAND_CENTERS + 2 * island + 1), cy = m.sb(ISLAND_CENTERS + 2 * island);
  if (cx !== m.sb(p + 3) || cy !== m.sb(p + 2)) return false;
  if (pCargo(m, p) === 0 && terrainNear(m, x, y, (1 << LAND) | (1 << CITY_P2))) {
    wakeLightTransports(m);
    wakeIslandArmies(m, island);
  } else {
    wakeAllAt(m, cx, cy);
  }
  return true;
}

const centreX = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i + 1);
const centreY = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i);
const standing = (m: Mem, island: number) => m.b(islandRec(island) + 14) & 3;
/** Distance from (x, y) to island `i`'s centre, less the island's allowance. */
const islandDistance = (m: Mem, i: number, x: number, y: number) =>
  s16(distance(centreX(m, i) - x, centreY(m, i) - y) - m.sw(ISLAND_ALLOWANCE + 2 * (i - 1)));
/** The side's Armies on an island record, and its cities there. */
const armiesOn = (m: Mem, r: number) => m.sw(r);
const citiesOn = (m: Mem, r: number) => m.sb(r + 12);

/** CODE 6 + 0x403C: the island whose centre is nearest (x, y). */
export function nearestIsland(m: Mem, x: number, y: number): number {
  let best = 5000, island = 1;
  const n = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= n; i++) {
    const d = islandDistance(m, i, x, y);
    if (d < best) {
      best = d;
      island = i;
    }
  }
  return island;
}

/** CODE 6 + 0x3E3A: how many squares of the 3x3 block centred on (x, y) are on `island`. */
export function landCount(m: Mem, x: number, y: number, island: number): number {
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (islandAt(m, x + dx, y + dy) === island) n++;
    }
  }
  return n;
}

/**
 * CODE 6 + 0x3EA2: the step from (x, y) to the water square next to it, well inside the
 * map and with no ship on it, that touches the most of `island` (more than (x, y) does);
 * 0, 0 if there is none.
 */
export function bestLanding(m: Mem, x: number, y: number, island: number): Dir {
  let best = landCount(m, x, y, island);
  const d: Dir = { dx: 0, dy: 0 };
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const nx = i + x, ny = j + y;
      if (nx <= 2 || nx >= 79 || ny <= 2 || ny >= 59) continue;
      if (islandAt(m, nx, ny) !== 0) continue;
      if (topIs(m, nx, ny, 0x7c, 0x06)) continue;
      const c = landCount(m, nx, ny, island);
      if (c > best) {
        best = c;
        d.dx = i;
        d.dy = j;
      }
    }
  }
  return d;
}

/**
 * CODE 6 + 0x2D64: the nearest cleared island to (x, y) with at least five of the side's
 * Armies besides six for each Transport already loading there (and five counting the
 * cities building Armies); 0 if none.
 */
export function islandForArmies(m: Mem, x: number, y: number): number {
  let best = 5000, island = 0;
  const n = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= n; i++) {
    const r = islandRec(i);
    if (standing(m, i) !== 1) continue;
    if (s16(armiesOn(m, r) - m.sb(r + 18) * 6) < 5) continue;
    const d = distance(x - centreX(m, i), y - centreY(m, i));
    if (d < best && m.sb(BUILDING[ARMY]) + armiesOn(m, r) >= 5) {
      best = d;
      island = i;
    }
  }
  return best !== 5000 ? island : 0;
}

/**
 * CODE 6 + 0x279E: send Transport `p` (`idx`) with its Armies somewhere to land them.
 * Beside land or a neutral city on an island of no or unknown standing where the side has
 * no Armies or cities, it heads for that island's centre (and gives up any island it was
 * assigned). Otherwise, among the islands of no standing that are partly explored, and
 * those with their byte set, the nearest where the side has no Armies or cities and that it
 * is nearer than the Transport assigned there; or the one it is assigned already. Far from
 * any such island (over 15) with a target island and enough cities, it heads for the
 * target island on odd 30-day spells, and otherwise for the nearest partly explored enemy
 * island. Taking an island over from another Transport of the side wakes that Transport.
 * With nowhere to go it sleeps in port, or sails to a random square.
 */
export function transportSail(m: Mem, p: number, idx: number): void {
  const x = pX(m, p), y = pY(m, p);
  const islands = m.sb(ISLAND_COUNT);
  const assigned = (i: number) => m.sw(ISLAND_WORDS + 2 * i);
  if (terrainNear(m, x, y, 0x0a)) {
    const [fx, fy] = foundCell(m);
    const island = islandAt(m, fx, fy);
    const r = islandRec(island);
    if (inSet(0x05, standing(m, island)) && citiesOn(m, r) + armiesOn(m, r) === 0) {
      for (let i = 1; i <= islands; i++) if (assigned(i) === idx) m.setW(ISLAND_WORDS + 2 * i, 0);
      shipGoTo(m, p, centreX(m, island), centreY(m, island));
      return;
    }
  }

  let best = 5000, chosen = 0, bestFree = 5000, chosenFree = 0;
  for (let i = 1; i <= islands; i++) {
    const r = islandRec(i);
    const candidate = (standing(m, i) === 0 && (m.b(r + 15) & 0x80) !== 0) || m.b(ISLAND_BYTES + i) !== 0;
    if (!candidate) continue;
    if (assigned(i) === idx) {
      shipGoTo(m, p, centreX(m, i), centreY(m, i));
      m.setW(ISLAND_WORDS + 2 * i, idx);
      return;
    }
    let other = 5000;
    if (assigned(i) !== 0) {
      const q = pieceAt(assigned(i));
      other = islandDistance(m, i, pX(m, q), pY(m, q));
    }
    const d = islandDistance(m, i, x, y);
    if (d >= other) continue;
    if (d < best && armiesOn(m, r) === 0 && citiesOn(m, r) === 0) {
      best = d;
      chosen = i;
    }
    if (d < bestFree && citiesOn(m, r) === 0 && armiesOn(m, r) === 0) {
      bestFree = d;
      chosenFree = i;
    }
  }

  const target = m.sw(TARGET_ISLAND);
  if (bestFree > 15 && target !== 0 && m.sw(BUILDING_TOTAL) >= m.sw(AI_LIMIT_10)) {
    if (Math.trunc(m.sw(DAY) / 30) & 1) {
      shipGoTo(m, p, centreX(m, target), centreY(m, target));
      return;
    }
    let nearest = 5000, island = 1;
    for (let i = 1; i <= islands; i++) {
      if (standing(m, i) !== 3 || (m.b(islandRec(i) + 15) & 0x80) === 0) continue;
      const d = islandDistance(m, i, x, y);
      if (d < nearest) {
        nearest = d;
        island = i;
      }
    }
    if (nearest !== 5000) {
      shipGoTo(m, p, centreX(m, island), centreY(m, island));
      return;
    }
  }

  const takeOver = (island: number, resetPointA: boolean) => {
    if (assigned(island) !== 0) {
      const q = pieceAt(assigned(island));
      if (pOwner(m, q) === pOwner(m, p)) {
        setState(m, q, 1);
        if (resetPointA) m.setW(q, m.w(q + 6));
      }
    }
    shipGoTo(m, p, centreX(m, island), centreY(m, island));
    m.setW(ISLAND_WORDS + 2 * island, idx);
  };
  if (bestFree !== 5000) {
    takeOver(chosenFree, true);
    return;
  }
  if (best !== 5000) {
    takeOver(chosen, false);
    return;
  }
  if (terrainAt(m, x, y) === CITY_P2) setState(m, p, 2);
  else randomSeaTarget(m, p);
}

/**
 * CODE 6 + 0x3F8E (within CODE 6 + 0x40B6): send Transport `p` to the side's coastal city
 * nearest the cleared islands' centre (worked out on a copy of the Transport placed
 * there), or, when it is in that city already, put it to sleep.
 */
function goHome(m: Mem, p: number): void {
  const rec = scratchRecord(0);
  m.copy(rec, p, 14);
  m.setB(rec + 7, m.b(CLEARED_CENTRE_X));
  m.setB(rec + 6, m.b(CLEARED_CENTRE_Y));
  const city = nearestPort(m, rec);
  if (city === 0) return;
  const cr = cityRec(city);
  if (m.b(p + 7) !== m.b(cr + 7) || m.b(p + 6) !== m.b(cr + 6)) {
    shipGoTo(m, p, m.sb(cr + 7), m.sb(cr + 6));
  } else {
    setState(m, p, 2);
    setReply(m, 0, 0);
  }
}

/**
 * CODE 6 + 0x40B6: an awake computer Transport, `idx`.
 *
 * Damaged in one of its side's cities, it sleeps. Beside land: by the standing of the
 * island it is beside (or the nearest island), on one not yet cleared it unloads
 * (transportSail; with Armies aboard it then wakes everything on its square when it is at
 * its go-to start's island, or the island is unclaimed and empty of the side, or the
 * island's byte says so); empty, it escapes enemies next to it, or goes to pick up Armies
 * (islandForArmies), leaving a player 2 city by a step, or home. On a cleared island it
 * escapes enemy warships and Bombers next to it, makes for port damaged, sails with six
 * aboard, and otherwise loads: at the island chosen for pick-up it moves to the best
 * landing square or, there, starts loading (waking the island's Armies); elsewhere it heads
 * for that island, or home. At sea: it escapes enemies, sails with Armies aboard, makes
 * for port damaged, and otherwise heads for Armies to pick up, or home.
 */
export function transportMove(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  const enemy = () => m.sb(OPPONENT_OF + pOwner(m, p));
  const escape = () => {
    evade(m, p, enemy(), closedTerrain(m, 2, pType(m, p)), 4, true);
    shipGoTo(m, p, m.sb(p + 3), m.sb(p + 2));
  };
  const stepOut = () => evade(m, p, enemy(), LAND_OR_CITY, 1, true);
  if (fullStrength(pType(m, p)) > pStrength(m, p) && terrainAt(m, x, y) === CITY_P2) {
    setState(m, p, 2);
    return;
  }
  if (pState(m, p) !== 1) return;

  if (!terrainNear(m, x, y, LAND_OR_CITY)) {
    if (enemyAdjacent(m, idx, 2, x, y)) {
      escape();
      return;
    }
    if (pCargo(m, p) !== 0) {
      transportSail(m, p, idx);
      return;
    }
    if (isWeakened(pType(m, p), pStrength(m, p)) && nearestPort(m, p) !== 0) return;
    const pickUp = islandForArmies(m, x, y);
    if (pickUp === 0) goHome(m, p);
    else if (terrainAt(m, x, y) === CITY_P2) stepOut();
    else shipGoTo(m, p, centreX(m, pickUp), centreY(m, pickUp));
    return;
  }

  let island = pieceIsland(m, idx, m.bytes(p, 14).slice());
  if (island === 0) island = nearestIsland(m, x, y) & 0xff;
  island = (island << 24) >> 24;
  const r = islandRec(island);
  if (standing(m, island) !== 1) {
    transportSail(m, p, idx);
    if (pCargo(m, p) > 0) {
      const atStart = island === islandAt(m, m.sb(p + 1), m.sb(p));
      const empty = inSet(0x05, standing(m, island)) && citiesOn(m, r) + armiesOn(m, r) === 0;
      if (atStart || empty || (m.b(ISLAND_BYTES + island) & 1) !== 0) {
        wakeAllAt(m, x, y);
        wakeTransports(m);
      }
      return;
    }
    if (enemyAdjacent(m, idx, 2, x, y)) {
      escape();
      return;
    }
    const pickUp = islandForArmies(m, x, y);
    if (pickUp === 0) goHome(m, p);
    else if (terrainAt(m, x, y) === CITY_P2) stepOut();
    else shipGoTo(m, p, centreX(m, pickUp), centreY(m, pickUp));
    return;
  }

  if (enemyAdjacent(m, idx, 2, x, y) && inSet(0xdc, pType(m, pieceAt(foundEnemy(m))))) {
    escape();
    return;
  }
  if (isWeakened(pType(m, p), pStrength(m, p)) && nearestPort(m, p) !== 0) return;
  if (pCargo(m, p) >= 6) {
    transportSail(m, p, idx);
    return;
  }
  const pickUp = islandForArmies(m, x, y);
  if (pickUp === island) {
    if (terrainAt(m, x, y) === CITY_P2) {
      stepOut();
      return;
    }
    const d = bestLanding(m, x, y, island);
    if (d.dx === 0 && d.dy === 0) {
      m.setB(r + 18, m.sb(r + 18) + 1);
      setState(m, p, 3);
      wakeIslandArmies(m, island);
      wakeLightTransports(m);
    } else {
      setReply(m, d.dx, d.dy);
      setState(m, p, 1);
    }
    return;
  }
  if (pickUp === 0) goHome(m, p);
  else shipGoTo(m, p, centreX(m, pickUp), centreY(m, pickUp));
}
