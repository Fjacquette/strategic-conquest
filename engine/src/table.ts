/**
 * Piece-table maintenance (tools segment, CODE 4).
 */
import { Mem } from "./mem.ts";
import { CARRIER, EMPTY, PIECE_COUNT, PIECE_HASH, PIECE_SIZE, REMOVED, TRANSPORT } from "./globals.ts";
import { hashClear, hashInsert, hashRemove } from "./hash.ts";
import { inSet } from "./map.ts";
import { pieceAt, pType, pX, pY, setType } from "./piece.ts";
import { pieceCount } from "./query.ts";

function swapRecords(m: Mem, a: number, b: number): void {
  const tmp = m.bytes(a, PIECE_SIZE).slice();
  m.bytes(a, PIECE_SIZE).set(m.bytes(b, PIECE_SIZE));
  m.bytes(b, PIECE_SIZE).set(tmp);
}

/**
 * CODE 4 + 0x259A: drop REMOVED pieces (later records shift down; the freed last record
 * is marked EMPTY), move Transports and then Carriers to the front of the table so they
 * precede their cargo, and rebuild the position hash.
 */
export function compactPieces(m: Mem): void {
  if (pieceCount(m) === 0) return;
  for (let i = 1; i <= pieceCount(m); i++) {
    while (pType(m, pieceAt(i)) === REMOVED) {
      const last = pieceCount(m) - 1;
      for (let j = i; j <= last; j++) m.bytes(pieceAt(j), PIECE_SIZE).set(m.bytes(pieceAt(j + 1), PIECE_SIZE));
      setType(m, pieceAt(pieceCount(m)), EMPTY);
      m.setW(PIECE_COUNT, pieceCount(m) - 1);
    }
  }
  let front = 1;
  while (front < pieceCount(m) && pType(m, pieceAt(front)) === TRANSPORT) front++;
  let n = pieceCount(m);
  for (let i = front + 1; i <= n; i++) {
    if (pType(m, pieceAt(i)) === TRANSPORT) {
      swapRecords(m, pieceAt(front), pieceAt(i));
      front++;
    }
  }
  while (front < pieceCount(m) && pType(m, pieceAt(front)) === CARRIER) front++;
  n = pieceCount(m);
  for (let i = front + 1; i <= n; i++) {
    if (pType(m, pieceAt(i)) === CARRIER) {
      swapRecords(m, pieceAt(front), pieceAt(i));
      front++;
    }
  }
  hashClear(m, PIECE_HASH);
  n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    hashInsert(m, PIECE_HASH, pX(m, p), pY(m, p), i, pType(m, p));
  }
}

/** CODE 4 + 0x27EE: destroy piece `idx`: drop it from the hash, mark it REMOVED and clear its owner. */
export function killPiece(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  hashRemove(m, PIECE_HASH, idx);
  setType(m, p, REMOVED);
  m.setB(p + 10, m.b(p + 10) & 0xcf);
}

/** CODE 4 + 0x0E62: destroy every piece on (x, y) with a type in `typeSet`. */
export function killTypesAt(m: Mem, x: number, y: number, typeSet: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pX(m, p) === x && pY(m, p) === y && inSet(typeSet, pType(m, p), 15)) {
      hashRemove(m, PIECE_HASH, i);
      m.setB(p + 10, m.b(p + 10) & 0xcf);
      setType(m, p, REMOVED);
    }
  }
}
