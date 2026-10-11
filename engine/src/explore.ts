/**
 * What a piece sees (CODE 4 + 0x0500).
 */
import { Mem } from "./mem.ts";
import { OPPONENT_OF, OWN_CITY_CODE, PIECE_HASH } from "./globals.ts";
import { distance, explored, isComputer, setExplored, terrainAt } from "./map.ts";
import { countAt, pieceCount, spottedValue } from "./query.ts";
import { pieceAt, pOwner, setState } from "./piece.ts";

/**
 * The observing piece: a record in the piece table (its A5 offset), or a scratch 14-byte
 * record (the original once passes an uninitialised local record; see quirk Q9).
 */
export type Observer = number | Uint8Array;

function obsByte(m: Mem, p: Observer, k: number): number {
  return typeof p === "number" ? m.b(p + k) : p[k];
}

function obsSetSpotted(m: Mem, p: Observer, v: number): void {
  const b = (obsByte(m, p, 12) & 0x3f) | ((v & 3) << 6);
  if (typeof p === "number") m.setB(p + 12, b);
  else p[12] = b;
}

const obsType = (m: Mem, p: Observer) => obsByte(m, p, 10) & 0x0f;
const obsSpotted = (m: Mem, p: Observer) => (obsByte(m, p, 12) >> 6) & 3;
const obsX = (m: Mem, p: Observer) => (obsByte(m, p, 7) << 24) >> 24;
const obsY = (m: Mem, p: Observer) => (obsByte(m, p, 6) << 24) >> 24;

/**
 * Piece `p` of `player` looks at the 3x3 block centred on (x, y): every cell becomes
 * explored for the player, and enemy pieces there get their spotted value updated. When a
 * cell holds enemy pieces, computer-controlled pieces of either side whose destination is
 * within 6 of `p` are woken, and `p` itself becomes spotted. Returns whether anything
 * noteworthy was seen: an unexplored cell, an enemy piece or an enemy city.
 */
export function explore(m: Mem, p: Observer, x: number, y: number, player: number): boolean {
  let noteworthy = false;
  const opp = m.sb(OPPONENT_OF + player);
  const oppCity = m.sb(OWN_CITY_CODE + opp);
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) {
      noteworthy = noteworthy || !explored(m, player, cx, cy);
      setExplored(m, player, cx, cy);
      const enemies = countAt(m, PIECE_HASH, cx, cy, 1 << opp, 0x00ff, 0, false, true, obsType(m, p));
      if (enemies !== 0) {
        if (isComputer(m, opp)) wakeNear(m, opp, p);
        if (isComputer(m, player)) wakeNear(m, player, p);
        obsSetSpotted(m, p, spottedValue(9, obsSpotted(m, p), obsType(m, p)));
        noteworthy = true;
      } else if (terrainAt(m, cx, cy) === oppCity) {
        obsSetSpotted(m, p, spottedValue(9, obsSpotted(m, p), obsType(m, p)));
        noteworthy = true;
      }
    }
  }
  return noteworthy;
}

/** Wake `owner`'s pieces whose destination (point B) is within 6 of the observer. */
function wakeNear(m: Mem, owner: number, p: Observer): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    if (pOwner(m, q) !== owner) continue;
    if (distance(m.sb(q + 2) - obsY(m, p), m.sb(q + 3) - obsX(m, p)) <= 6) setState(m, q, 1);
  }
}
