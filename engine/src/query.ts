/**
 * Questions about the pieces on and around a cell (tools segment, CODE 4).
 */
import { Mem } from "./mem.ts";
import {
  ARMY, CARRIER, DESTROYER, FOUND_ENEMY, PIECE_COUNT, REMOVED, SUBMARINE, TRANSPORT,
} from "./globals.ts";
import { hashOf, topPieceAt } from "./hash.ts";
import { HASH_MAX_PROBE, HASH_SLOTS, PIECE_HASH } from "./globals.ts";
import { inSet } from "./map.ts";
import {
  pCargo, pieceAt, pOwner, pSpotted, pType, pX, pY, setCargo, setSpotted,
} from "./piece.ts";

/** CODE 4 + 0x12C4: an enemy piece (not REMOVED) is top of a cell in the 3x3 block. */
export function enemyAdjacent(m: Mem, _unused: number, player: number, x: number, y: number): boolean {
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) {
      const t = topPieceAt(m, cx, cy);
      if (t === 0) continue;
      const q = pieceAt(t);
      if (pOwner(m, q) !== player && pType(m, q) !== REMOVED) {
        m.setW(FOUND_ENEMY, t);
        return true;
      }
    }
  }
  return false;
}

/** CODE 4 + 0x12B6: the piece found by the last successful enemyAdjacent(). */
export function foundEnemy(m: Mem): number {
  return m.sw(FOUND_ENEMY);
}

/**
 * CODE 4 + 0x0C96: the top piece of (x, y) has a type in `typeSet` and an owner in
 * `ownerSet`. With no piece on the cell the unused record 0 is tested.
 */
export function topIs(m: Mem, x: number, y: number, typeSet: number, ownerSet: number): boolean {
  const q = pieceAt(topPieceAt(m, x, y));
  return inSet(typeSet, pType(m, q), 15) && inSet(ownerSet, pOwner(m, q));
}

/**
 * CODE 4 + 0x0D20: moving a piece of `ptype` onto (x, y) would board a full ship of
 * `player`. Only a full Transport (6 Armies) refuses an Army; the Carrier test that
 * follows can never succeed, so Carriers are never reported full.
 */
export function boardingFull(m: Mem, x: number, y: number, player: number, ptype: number): boolean {
  const t = topPieceAt(m, x, y);
  if (t === 0) return false;
  const q = pieceAt(t);
  if (pOwner(m, q) !== player) return false;
  if (!(pType(m, q) === TRANSPORT && pCargo(m, q) >= 6)) return false;
  if (ptype === ARMY) return true;
  return pType(m, q) === CARRIER && pCargo(m, q) >= 15 && ptype === 1;
}

/** CODE 4 + 0x0004: the "spotted" value a piece gets when seen. */
export function spottedValue(observerType: number, spotted: number, ptype: number): number {
  if (ptype === ARMY) return 2;
  if (ptype === SUBMARINE) return observerType === DESTROYER ? 1 : spotted;
  return 1;
}

/**
 * CODE 4 + 0x03A2: count the pieces on (x, y) with an owner in `ownerSet` and a type in
 * `typeSet`, walking the hash chain. Along the way, every Army on the cell gets its cargo
 * field set to `armyCargo` when `setArmyCargo`, and counted pieces get a new spotted value
 * when `updateSpotted`.
 */
export function countAt(
  m: Mem, table: number, x: number, y: number, ownerSet: number, typeSet: number,
  armyCargo: number, setArmyCargo: boolean, updateSpotted: boolean, observerType: number,
): number {
  let count = 0;
  let probe = 0;
  let h = hashOf(x, y);
  do {
    h = (h + probe) % HASH_SLOTS;
    const v = m.sw(table + 2 * h);
    if (v === -1) return count;
    if (v !== -2) {
      const q = pieceAt(v);
      if (pX(m, q) === x && pY(m, q) === y && pType(m, q) !== REMOVED) {
        if (pType(m, q) === ARMY && setArmyCargo) setCargo(m, q, armyCargo);
        if (inSet(ownerSet, pOwner(m, q)) && inSet(typeSet, pType(m, q), 15)) {
          count++;
          if (updateSpotted) setSpotted(m, q, spottedValue(observerType, pSpotted(m, q), pType(m, q)));
        }
      }
    }
    probe++;
  } while (probe <= m.sw(table + HASH_MAX_PROBE));
  return count;
}

/** CODE 4 + 0x24FC: number of `owner`'s pieces on (x, y). */
export function ownPiecesAt(m: Mem, x: number, y: number, owner: number): number {
  return countAt(m, PIECE_HASH, x, y, 1 << owner, 0x00ff, 0, false, false, 9);
}

/** Number of live pieces (highest record in use). */
export function pieceCount(m: Mem): number {
  return m.sw(PIECE_COUNT);
}
