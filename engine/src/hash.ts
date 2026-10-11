/**
 * Position hash (tools segment, CODE 4): finds the pieces on a cell.
 *
 * 551 word slots, then a word holding the longest probe sequence used so far. A slot holds
 * a piece index, EMPTY_SLOT, or DELETED_SLOT. Probing is triangular: h, h+1, h+3, h+6, ...
 *
 * Insertion orders pieces on the same cell so that a Transport is found before the Armies
 * with it and a Carrier before its Fighters; lookups return the first live piece found,
 * so the "top" piece of a stack is the Transport or Carrier.
 */
import { Mem, s16 } from "./mem.ts";
import {
  ARMY, CARRIER, EMPTY, FIGHTER, HASH_MAX_PROBE, HASH_SLOTS, PIECE_HASH, REMOVED, TRANSPORT,
} from "./globals.ts";
import { pieceAt, pType, pX, pY } from "./piece.ts";

export const EMPTY_SLOT = -1;
export const DELETED_SLOT = -2;
const NONE = -5000;

const slot = (m: Mem, table: number, i: number) => m.sw(table + 2 * i);
const setSlot = (m: Mem, table: number, i: number, v: number) => m.setW(table + 2 * i, v);
const maxProbe = (m: Mem, table: number) => m.sw(table + HASH_MAX_PROBE);

/** CODE 4 + 0x0042 */
export function hashOf(x: number, y: number): number {
  return s16(x * 0x61 + y * 0x71) % HASH_SLOTS;
}

/** CODE 4 + 0x006C */
export function hashClear(m: Mem, table: number): void {
  for (let i = 0; i < HASH_SLOTS; i++) setSlot(m, table, i, EMPTY_SLOT);
  m.setW(table + HASH_MAX_PROBE, 0);
}

/** CODE 4 + 0x00A0: add piece `idx` of type `ptype` at (x, y). */
export function hashInsert(m: Mem, table: number, x: number, y: number, idx: number, ptype: number): void {
  let probe = 0;
  let freeSlot = NONE; // first deleted slot on the chain
  let transportSlot = NONE; // a Transport on this cell, seen after freeSlot
  let carrierSlot = NONE; // a Carrier on this cell, seen after freeSlot
  let h = hashOf(x, y);
  do {
    h = (h + probe) % HASH_SLOTS;
    const v = slot(m, table, h);
    if (v === EMPTY_SLOT || (probe > maxProbe(m, table) && freeSlot !== NONE)) {
      if (freeSlot === NONE) {
        setSlot(m, table, h, idx);
        probe++;
        if (probe > maxProbe(m, table)) m.setW(table + HASH_MAX_PROBE, probe);
      } else if (ptype === ARMY && transportSlot !== NONE) {
        setSlot(m, table, freeSlot, slot(m, table, transportSlot));
        setSlot(m, table, transportSlot, idx);
      } else if (ptype === FIGHTER && carrierSlot !== NONE) {
        setSlot(m, table, freeSlot, slot(m, table, carrierSlot));
        setSlot(m, table, carrierSlot, idx);
      } else {
        setSlot(m, table, freeSlot, idx);
      }
      return;
    }
    if (v === DELETED_SLOT && freeSlot === NONE) freeSlot = h;
    const cur = slot(m, table, h);
    if (cur !== DELETED_SLOT) {
      const q = pieceAt(cur);
      if (pX(m, q) === x && pY(m, q) === y) {
        switch (pType(m, q)) {
          case ARMY:
            if (ptype === TRANSPORT && freeSlot === NONE) {
              setSlot(m, table, h, idx);
              idx = cur;
            }
            break;
          case FIGHTER:
            if (ptype === CARRIER && freeSlot === NONE) {
              setSlot(m, table, h, idx);
              idx = cur;
            }
            break;
          case CARRIER:
            if (freeSlot !== NONE) carrierSlot = h;
            break;
          case TRANSPORT:
            if (freeSlot !== NONE) transportSlot = h;
            break;
        }
      }
    }
    probe++;
  } while (probe !== HASH_SLOTS);
}

/** CODE 4 + 0x02EE: first live piece at (x, y), or 0. */
export function hashFind(m: Mem, table: number, x: number, y: number): number {
  let probe = 0;
  let h = hashOf(x, y);
  do {
    h = (h + probe) % HASH_SLOTS;
    const v = slot(m, table, h);
    if (v === EMPTY_SLOT) return 0;
    if (v !== DELETED_SLOT) {
      const q = pieceAt(v);
      if (pX(m, q) === x && pY(m, q) === y && pType(m, q) !== REMOVED && pType(m, q) !== EMPTY) return v;
    }
    probe++;
  } while (probe <= maxProbe(m, table));
  return 0;
}

/** CODE 4 + 0x026C: remove piece `idx` (found by its current position). */
export function hashRemove(m: Mem, table: number, idx: number): void {
  const p = pieceAt(idx);
  let probe = 0;
  let h = hashOf(pX(m, p), pY(m, p));
  do {
    h = (h + probe) % HASH_SLOTS;
    const v = slot(m, table, h);
    if (v === EMPTY_SLOT) return;
    if (v === idx) {
      setSlot(m, table, h, DELETED_SLOT);
      return;
    }
    probe++;
  } while (probe <= maxProbe(m, table));
}

/** CODE 4 + 0x257E: top piece at (x, y) in the main position hash, or 0. */
export function topPieceAt(m: Mem, x: number, y: number): number {
  return hashFind(m, PIECE_HASH, x, y);
}
