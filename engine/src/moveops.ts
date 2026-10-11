/**
 * Primitive piece updates used by movement (tools segment CODE 4, and CODE 1 + 0x06AC).
 */
import { Mem } from "./mem.ts";
import { ARMY, CARRIER, FIGHTER, PIECE_HASH, TRANSPORT } from "./globals.ts";
import { hashInsert, hashRemove } from "./hash.ts";
import { inSet } from "./map.ts";
import { pieceCount, topIs } from "./query.ts";
import {
  pieceAt, pOwner, pState, pType, pX, pY, setCargo, setOrders, setPatrol, setState, setBit5,
} from "./piece.ts";

/**
 * CODE 4 + 0x082A: put piece `idx` (record `p`) on (x, y), keeping the position hash
 * current. Byte 12 bit 5 records the last horizontal direction (set when moving left).
 */
export function movePiece(m: Mem, p: number, x: number, y: number, idx: number, dx: number): void {
  if (dx === 1) m.setW(p + 12, m.w(p + 12) & 0xdfff);
  else if (dx === -1) m.setW(p + 12, (m.w(p + 12) & 0xdfff) | 0x2000);
  hashRemove(m, PIECE_HASH, idx);
  m.setB(p + 7, x);
  m.setB(p + 6, y);
  hashInsert(m, PIECE_HASH, x, y, idx, pType(m, p));
}

/**
 * CODE 4 + 0x0F2C: a Transport or Carrier (piece `idx`) has moved from (oldX, oldY) to
 * (newX, newY); take its cargo along. Only Armies (Transport, up to 6) or Fighters
 * (Carrier, up to 15) that come after it in the piece table are carried. Carried Fighters
 * are refuelled and, if under orders, woken. The ship's cargo count becomes the number
 * carried.
 */
export function carryCargo(m: Mem, oldX: number, oldY: number, newX: number, newY: number, idx: number): void {
  const ship = pieceAt(idx);
  let cap: number, cargoType: number;
  if (pType(m, ship) === CARRIER) {
    cap = 15;
    cargoType = FIGHTER;
  } else {
    cap = 6;
    cargoType = ARMY;
  }
  let count = 0;
  const n = pieceCount(m);
  for (let i = idx + 1; i <= n; i++) {
    const r = pieceAt(i);
    if (pX(m, r) === oldX && pY(m, r) === oldY && count < cap && pType(m, r) === cargoType) {
      count++;
      if (pType(m, r) === FIGHTER) {
        setCargo(m, r, 20);
        if (pState(m, r) === 0) setState(m, r, 1);
      }
      hashRemove(m, PIECE_HASH, i);
      m.setB(r + 7, newX);
      m.setB(r + 6, newY);
      hashInsert(m, PIECE_HASH, newX, newY, i, pType(m, r));
      m.setB(r + 5, newX);
      m.setB(r + 4, newY);
    }
  }
  setCargo(m, ship, count);
}

/**
 * CODE 4 + 0x08D4: wake `owner`'s pieces with a type in `typeSet` in the 3x3 block
 * around (x, y), except on (x, y) itself and except Armies aboard a Transport.
 */
export function wakeAdjacent(m: Mem, x: number, y: number, owner: number, typeSet: number, _idx: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const r = pieceAt(i);
    const rx = pX(m, r), ry = pY(m, r);
    if (rx < x - 1 || rx > x + 1 || ry < y - 1 || ry > y + 1) continue;
    if (pOwner(m, r) !== owner || !inSet(typeSet, pType(m, r), 15)) continue;
    if (rx === x && ry === y) continue;
    if (pType(m, r) === ARMY) {
      if (!topIs(m, rx, ry, 1 << TRANSPORT, 1 << pOwner(m, r))) setState(m, r, 1);
    } else {
      setState(m, r, 1);
    }
  }
}

/** CODE 4 + 0x0DD4: wake every piece on (x, y). */
export function wakeAllAt(m: Mem, x: number, y: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const r = pieceAt(i);
    if (pX(m, r) === x && pY(m, r) === y) setState(m, r, 1);
  }
}

/**
 * CODE 1 + 0x06AC: give piece `p` go-to orders to (x, y). The trip starts from the current
 * position (point C, and point A except for Transports); patrol, bit 5 and the state are
 * cleared.
 */
export function setDestination(m: Mem, p: number, x: number, y: number): void {
  m.setW(p + 4, m.w(p + 6));
  m.setB(p + 3, x);
  m.setB(p + 2, y);
  setOrders(m, p, 2);
  setState(m, p, 0);
  setBit5(m, p, 0);
  setPatrol(m, p, 0);
  if (pType(m, p) !== TRANSPORT) m.setW(p, m.w(p + 6));
}
