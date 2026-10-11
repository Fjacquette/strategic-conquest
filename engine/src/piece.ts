/**
 * Field access for 14-byte piece records. A piece is addressed by the A5 offset of its
 * record, as the original passes record pointers.
 *
 *   0-1   point A (y, x)          patrol end / start of the current go-to
 *   2-3   point B (y, x)          go-to destination
 *   4-5   point C (y, x)
 *   6-7   position (y, x)
 *   8-9   word: bits 0-4 move step, bits 5-9 fuel or cargo, bits 10-15 Bomber blast radius
 *   10    bits 0-3 type, bits 4-5 owner, bits 6-7 attacks made this day
 *   11    bit 0 patrol, bit 2 moved this day, bits 3-4 orders, bit 5, bits 6-7 state
 *   12    bits 0-4 strength, bit 5, bits 6-7 spotted
 *   13    repaired during this stay in port
 */
import { Mem } from "./mem.ts";
import { PIECES, PIECE_SIZE } from "./globals.ts";

export function pieceAt(idx: number): number {
  return PIECES + PIECE_SIZE * idx;
}

export function pieceIndex(p: number): number {
  return (p - PIECES) / PIECE_SIZE;
}

export const pY = (m: Mem, p: number) => m.sb(p + 6);
export const pX = (m: Mem, p: number) => m.sb(p + 7);
export const pType = (m: Mem, p: number) => m.b(p + 10) & 0x0f;
export const pOwner = (m: Mem, p: number) => (m.b(p + 10) >> 4) & 3;
export const pAttacks = (m: Mem, p: number) => (m.b(p + 10) >> 6) & 3;
export const pStep = (m: Mem, p: number) => m.w(p + 8) & 0x1f;
export const pCargo = (m: Mem, p: number) => (m.w(p + 8) >> 5) & 0x1f;
export const pRadius = (m: Mem, p: number) => (m.w(p + 8) >> 10) & 0x3f;
export const pPatrol = (m: Mem, p: number) => m.b(p + 11) & 1;
export const pMoved = (m: Mem, p: number) => (m.b(p + 11) >> 2) & 1;
export const pOrders = (m: Mem, p: number) => (m.b(p + 11) >> 3) & 3;
export const pBit5 = (m: Mem, p: number) => (m.b(p + 11) >> 5) & 1;
export const pState = (m: Mem, p: number) => (m.b(p + 11) >> 6) & 3;
export const pStrength = (m: Mem, p: number) => m.b(p + 12) & 0x1f;
export const pSpotted = (m: Mem, p: number) => (m.b(p + 12) >> 6) & 3;

function setBits(m: Mem, off: number, mask: number, shift: number, v: number): void {
  m.setB(off, (m.b(off) & ~(mask << shift)) | ((v & mask) << shift));
}

function setWordBits(m: Mem, off: number, mask: number, shift: number, v: number): void {
  m.setW(off, (m.w(off) & ~(mask << shift)) | ((v & mask) << shift));
}

export const setType = (m: Mem, p: number, v: number) => setBits(m, p + 10, 0x0f, 0, v);
export const setOwner = (m: Mem, p: number, v: number) => setBits(m, p + 10, 3, 4, v);
export const setAttacks = (m: Mem, p: number, v: number) => setBits(m, p + 10, 3, 6, v);
export const setStep = (m: Mem, p: number, v: number) => setWordBits(m, p + 8, 0x1f, 0, v);
export const setCargo = (m: Mem, p: number, v: number) => setWordBits(m, p + 8, 0x1f, 5, v);
export const setPatrol = (m: Mem, p: number, v: number) => setBits(m, p + 11, 1, 0, v);
export const setMoved = (m: Mem, p: number, v: number) => setBits(m, p + 11, 1, 2, v);
export const setOrders = (m: Mem, p: number, v: number) => setBits(m, p + 11, 3, 3, v);
export const setBit5 = (m: Mem, p: number, v: number) => setBits(m, p + 11, 1, 5, v);
export const setState = (m: Mem, p: number, v: number) => setBits(m, p + 11, 3, 6, v);
export const setStrength = (m: Mem, p: number, v: number) => setBits(m, p + 12, 0x1f, 0, v);
export const setSpotted = (m: Mem, p: number, v: number) => setBits(m, p + 12, 3, 6, v);

/** Copy a (y, x) point: the word at `from` into the word at `to`. */
export function copyPoint(m: Mem, to: number, from: number): void {
  m.setW(to, m.w(from));
}
