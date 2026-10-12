/**
 * Terrain, explored-cell bitmaps and simple geometry.
 */
import { Mem } from "./mem.ts";
import { COMPUTER_FLAG, FOUND_X, FOUND_Y, PLAYER_MAPS, PLAYER_MAP_SIZE, TERRAIN } from "./globals.ts";

/** Byte offset of cell (x, y) in the terrain block and the shift of its nibble. */
function terrainCell(x: number, y: number): [number, number] {
  const row = y - 1;
  return [TERRAIN + (x - 1) * 30 + (row >> 1), (row & 1) << 2];
}

export function terrainAt(m: Mem, x: number, y: number): number {
  const [off, shift] = terrainCell(x, y);
  return (m.b(off) >> shift) & 0x0f;
}

export function setTerrain(m: Mem, x: number, y: number, v: number): void {
  const [off, shift] = terrainCell(x, y);
  m.setB(off, (m.b(off) & ~(0x0f << shift)) | ((v & 0x0f) << shift));
}

/** Offset of a player's 642-byte map block (player 1 or 2). */
export function playerMap(player: number): number {
  return PLAYER_MAPS + (player - 1) * PLAYER_MAP_SIZE;
}

export function isComputer(m: Mem, player: number): boolean {
  return m.b(playerMap(player) + COMPUTER_FLAG) === 1;
}

function exploredCell(player: number, x: number, y: number): [number, number] {
  const row = y - 1;
  return [playerMap(player) + x * 8 + (row >> 3) - 8, row & 7];
}

export function explored(m: Mem, player: number, x: number, y: number): boolean {
  const [off, bit] = exploredCell(player, x, y);
  return ((m.b(off) >> bit) & 1) !== 0;
}

export function setExplored(m: Mem, player: number, x: number, y: number): void {
  const [off, bit] = exploredCell(player, x, y);
  m.setB(off, m.b(off) | (1 << bit));
}

/** Pascal set membership with the compiler's range check: values above `bound` are out. */
export function inSet(set: number, v: number, bound = 7): boolean {
  return v >= 0 && v <= bound && ((set >> v) & 1) !== 0;
}

/** CODE 4 + 0x28A8: Chebyshev distance of an offset. */
export function distance(dx: number, dy: number): number {
  return Math.max(Math.abs(dx), Math.abs(dy));
}

/**
 * CODE 1 + 0x0004: the length of an offset, approximately (to within a square or so):
 * twice the longer side plus a series in the squared ratio of the sides, all in 16-bit
 * unsigned fixed point, halved.
 */
export function hypot(dx: number, dy: number): number {
  let lo = Math.abs(dx) & 0xffff, hi = Math.abs(dy) & 0xffff;
  if (lo >= hi) [lo, hi] = [hi, lo];
  if (hi === 0) return 0;
  if (lo === 0) return hi;
  if (lo === hi) return ((hi * 0x5a82) >>> 14) & 0xffff;
  const q = Math.floor(((lo << 8) & 0xffff) / hi) & 0xffff;
  const t = (q * q) >>> 8;
  const t2 = (t << 1) & 0xffff;
  const next = (term: number) => ((term * t2) >>> 8) & 0xffff;
  let term = ((t * hi) & 0xffff) >>> 8;
  let sum = (hi << 1) + term;
  const steps: ((v: number) => number)[] = [
    (v) => -(v >>> 3),
    (v) => v >>> 2,
    (v) => -(((v * 5) & 0xffff) >>> 4),
    (v) => Math.floor(((v >>> 1) * 7) / 10),
    (v) => -(((v * 3) & 0xffff) >>> 3),
    (v) => Math.floor(((v >>> 1) * 11) / 14),
    (v) => -(((v * 13) & 0xffff) >>> 5),
  ];
  for (const step of steps) {
    if (term <= 1) break;
    const signed = step(next(term));
    term = Math.abs(signed);
    sum += signed;
  }
  return (sum & 0xffff) >>> 1;
}

/** CODE 4 + 0x2960: inside the playable area (the edge ring excluded). */
export function onMap(x: number, y: number): boolean {
  return x > 1 && x < 80 && y > 1 && y < 60;
}

/**
 * CODE 1 + 0x28C6: whether any cell of the 3x3 block centred on (x, y) has terrain in
 * `terrainSet`. The first match (columns, then rows, in increasing order) is recorded in
 * FOUND_X / FOUND_Y.
 */
export function terrainNear(m: Mem, x: number, y: number, terrainSet: number): boolean {
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) {
      if (inSet(terrainSet, terrainAt(m, cx, cy))) {
        m.setB(FOUND_Y, cy);
        m.setB(FOUND_X, cx);
        return true;
      }
    }
  }
  return false;
}
