/**
 * The computer opponent's Transports.
 */
import { Mem } from "../mem.ts";
import { ARMY, CITY_P2, LAND, PIECE_COUNT, PIECE_HASH, TRANSPORT } from "../globals.ts";
import { inSet, onMap, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_CENTERS, islandAt } from "../mapgen.ts";
import { wakeAllAt } from "../moveops.ts";
import { type Dir, rotate } from "../path.ts";
import { pCargo, pieceAt, pOwner, pState, pType, pX, pY, setCargo, setState } from "../piece.ts";
import { countAt } from "../query.ts";
import { qdRandom } from "../random.ts";
import { islandRec } from "./data.ts";
import { wakeLightTransports } from "./production.ts";

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
