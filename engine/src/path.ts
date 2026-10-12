/**
 * Choosing the next step for a piece under orders (tools segment, CODE 4).
 *
 * A piece with go-to orders follows the straight line from point C to its destination B.
 * When the next cell on that line is forbidden terrain, it follows the obstacle's edge,
 * turning clockwise (orders 1) or counterclockwise (orders 0 or 3) until a free cell is
 * found; point C is moved to each cell it steps to, and straight-line travel (orders 2)
 * resumes once the line from C to B is clear. Which way to go around is decided by
 * simulating both and taking the shorter, with a coin toss from the game PRNG on a tie.
 *
 * These routines also run on scratch copies of a piece record, so they take the record
 * as a 14-byte array.
 */
import { Mem, s8, s16 } from "./mem.ts";
import { ARMY, PIECE_SIZE, TRANSPORT } from "./globals.ts";
import { topPieceAt } from "./hash.ts";
import { distance, inSet, onMap, terrainAt } from "./map.ts";
import { topIs } from "./query.ts";
import { pCargo, pieceAt } from "./piece.ts";
import { gameRandom, qdRandom } from "./random.ts";

export interface Dir {
  dx: number;
  dy: number;
}

// Scratch globals written by the path finder.
export const PATH_STEP_X = -0x5142; // word: last direction chosen
export const PATH_STEP_Y = -0x5140;
export const PATH_DECIDED = -0x513b; // byte: the last detour choice was not a coin toss
const PATH_SIM_STEPS = -0x513a; // word: steps of the chosen simulated detour

const SHIPS = 0x7c;

const rY = (r: Uint8Array) => s8(r[6]);
const rX = (r: Uint8Array) => s8(r[7]);
const rOrders = (r: Uint8Array) => (r[11] >> 3) & 3;
const rType = (r: Uint8Array) => r[10] & 0x0f;
const rOwner = (r: Uint8Array) => (r[10] >> 4) & 3;

function setOrders(r: Uint8Array, v: number): void {
  r[11] = (r[11] & 0xe7) | ((v & 3) << 3);
}

/** CODE 4 + 0x1364: turn a direction one eighth clockwise (orders 1) or counterclockwise. */
export function rotate(orders: number, d: Dir): void {
  const { dx, dy } = d;
  if (orders === 1) {
    if (dx === 1) {
      if (dy === 1) [d.dx, d.dy] = [0, 1];
      else if (dy === 0) [d.dx, d.dy] = [1, 1];
      else [d.dx, d.dy] = [1, 0];
    } else if (dx === 0) {
      if (dy === 1) [d.dx, d.dy] = [-1, 1];
      else [d.dx, d.dy] = [1, -1];
    } else {
      if (dy === 1) [d.dx, d.dy] = [-1, 0];
      else if (dy === 0) [d.dx, d.dy] = [-1, -1];
      else [d.dx, d.dy] = [0, -1];
    }
  } else {
    if (dx === 1) {
      if (dy === 1) [d.dx, d.dy] = [1, 0];
      else if (dy === 0) [d.dx, d.dy] = [1, -1];
      else [d.dx, d.dy] = [0, -1];
    } else if (dx === 0) {
      if (dy === 1) [d.dx, d.dy] = [1, 1];
      else [d.dx, d.dy] = [-1, -1];
    } else {
      if (dy === 1) [d.dx, d.dy] = [0, 1];
      else if (dy === 0) [d.dx, d.dy] = [-1, 1];
      else [d.dx, d.dy] = [-1, 0];
    }
  }
}

/**
 * CODE 4 + 0x28E2: first step along the line from the origin to (totalX, totalY) that
 * leaves the current offset (curX, curY), where `traveled` steps have been made.
 */
function lineStep(traveled: number, totalX: number, totalY: number, curX: number, curY: number, total: number): Dir {
  let k = 0;
  let lx: number, ly: number;
  do {
    k++;
    lx = Math.trunc(s16((k + traveled) * totalX) / total);
    ly = Math.trunc(s16((k + traveled) * totalY) / total);
  } while (lx === curX && ly === curY);
  return { dx: s8((lx - curX) % 2), dy: s8((ly - curY) % 2) };
}

/** CODE 4 + 0x15A4: the next step on the line from point C to point B. */
export function lineDirection(r: Uint8Array): Dir {
  const tx = s8(r[3]) - s8(r[5]);
  const ty = s8(r[2]) - s8(r[4]);
  const total = distance(tx, ty);
  if (total === 0) return { dx: 0, dy: 0 };
  const cx = rX(r) - s8(r[5]);
  const cy = rY(r) - s8(r[4]);
  return lineStep(distance(cx, cy), tx, ty, cx, cy, total);
}

/** CODE 4 + 0x1460: no forbidden terrain on the line from point C to point B. */
export function lineClear(m: Mem, terrainSet: number, r: Uint8Array): boolean {
  const c = r.slice(0, PIECE_SIZE);
  const tx = s8(c[3]) - s8(c[5]);
  const ty = s8(c[2]) - s8(c[4]);
  const total = distance(tx, ty);
  if (total === 0) return true;
  let k = 0;
  for (;;) {
    const lx = Math.trunc(s16(k * tx) / total);
    const ly = Math.trunc(s16(k * ty) / total);
    k++;
    const reached = s8(c[5]) + lx === s8(c[3]) && s8(c[4]) + ly === s8(c[2]);
    if (reached) return true;
    if (inSet(terrainSet, terrainAt(m, s8(c[5]) + lx, s8(c[4]) + ly))) return false;
  }
}

/**
 * CODE 4 + 0x166A: turn `d` (in the piece's turning direction) until it leads to a free
 * cell, at most 8 tries; point C moves to that cell. If no turn was needed and the line
 * from there to B is clear, straight-line travel resumes.
 */
export function followEdge(m: Mem, r: Uint8Array, terrainSet: number, d: Dir): void {
  let tries = 0;
  let found = false;
  let nx = 0, ny = 0;
  while (!found && tries < 8) {
    nx = rX(r) + d.dx;
    ny = rY(r) + d.dy;
    if (inSet(terrainSet, terrainAt(m, nx, ny)) || !onMap(nx, ny)) rotate(rOrders(r), d);
    else found = true;
    tries++;
  }
  r[5] = nx & 0xff;
  r[4] = ny & 0xff;
  if (tries === 1 && lineClear(m, terrainSet & 0xff, r)) setOrders(r, 2);
}

/** CODE 4 + 0x1D82: one step of the path finder, without the detour decision. */
function simStep(m: Mem, r: Uint8Array, terrainSet: number): Dir {
  const d = lineDirection(r);
  if (rOrders(r) !== 2) {
    const save = { ...d };
    rotate(rOrders(r), d);
    if (!onMap(rX(r) + d.dx, rY(r) + d.dy)) {
      d.dx = save.dx;
      d.dy = save.dy;
    }
  }
  if (rOrders(r) !== 2 || inSet(terrainSet, terrainAt(m, rX(r) + d.dx, rY(r) + d.dy))) {
    followEdge(m, r, terrainSet & 0xff, d);
  }
  return d;
}

/**
 * CODE 4 + 0x1EE8: decide which way to go around an obstacle by simulating both ways
 * (at most max(80, twice the distance) steps each). Returns the turning direction to use
 * as orders: 1 (clockwise) or 0 (counterclockwise).
 */
export function chooseDetour(m: Mem, terrainSet: number, piece: Uint8Array): number {
  const orig = piece.slice(0, PIECE_SIZE);
  let sim = orig.slice();
  sim.copyWithin(4, 6, 8);
  lineDirection(sim);
  let limit = distance(s8(sim[3]) - rX(sim), s8(sim[2]) - rY(sim)) * 2;
  if (limit < 80) limit = 80;
  let cw = 0;
  let x = rX(sim), y = rY(sim);
  setOrders(sim, 1);
  while (cw <= limit && (x !== s8(sim[3]) || y !== s8(sim[2]))) {
    const d = simStep(m, sim, terrainSet);
    x += d.dx;
    y += d.dy;
    sim[7] = x & 0xff;
    sim[6] = y & 0xff;
    cw++;
  }
  sim = orig.slice();
  let ccw = 0;
  x = rX(sim);
  y = rY(sim);
  setOrders(sim, 0);
  while (ccw <= limit && (x !== s8(sim[3]) || y !== s8(sim[2]))) {
    const d = simStep(m, sim, terrainSet);
    x += d.dx;
    y += d.dy;
    sim[7] = x & 0xff;
    sim[6] = y & 0xff;
    ccw++;
  }
  if (cw < ccw) {
    m.setB(PATH_DECIDED, 1);
    m.setW(PATH_SIM_STEPS, cw);
    return 1;
  }
  if (ccw < cw) {
    m.setB(PATH_DECIDED, 1);
    m.setW(PATH_SIM_STEPS, ccw);
    return 0;
  }
  m.setB(PATH_DECIDED, 0);
  m.setW(PATH_SIM_STEPS, cw);
  return Math.abs(gameRandom(m)) % 10 < 5 ? 1 : 0;
}

/**
 * CODE 4 + 0x178E: a random step for a piece with Random orders (byte 11 bit 5), using
 * QuickDraw Random. Blocked directions (off the map, forbidden terrain, or a ship onto a
 * ship) are turned away from, up to 9 times.
 */
function randomStep(m: Mem, terrainSet: number, r: Uint8Array): Dir {
  const d: Dir = { dx: 0, dy: 0 };
  do {
    d.dx = s8(s16(qdRandom(m)) % 2);
    d.dy = s8(s16(qdRandom(m)) % 2);
  } while (d.dx === 0 && d.dy === 0);
  let x = rX(r) + d.dx, y = rY(r) + d.dy;
  let tries = 1;
  let top = topPieceAt(m, x, y);
  for (;;) {
    const blocked = !onMap(x, y) || inSet(terrainSet, terrainAt(m, x, y)) ||
      (inSet(SHIPS, rType(r)) && inSet(SHIPS, m.b(pieceAt(top) + 10) & 0x0f));
    if (!(blocked && tries <= 9)) break;
    rotate(rOrders(r), d);
    x = rX(r) + d.dx;
    y = rY(r) + d.dy;
    top = topPieceAt(m, x, y);
    tries++;
  }
  return d;
}

/**
 * CODE 4 + 0x19DA: the direction piece `r` moves next under its orders. `terrainSet` is
 * the terrain the piece may not enter. May change the piece's orders, state and point C.
 */
export function nextStep(m: Mem, terrainSet: number, r: Uint8Array): Dir {
  m.setB(PATH_DECIDED, 1);
  let out: Dir;
  if ((r[11] >> 5) & 1) {
    out = randomStep(m, terrainSet, r);
  } else {
    const d = lineDirection(r);
    const straight = { ...d };
    if (rOrders(r) !== 2) {
      const save = { ...d };
      rotate(rOrders(r), d);
      if (!onMap(rX(r) + d.dx, rY(r) + d.dy)) {
        d.dx = save.dx;
        d.dy = save.dy;
      }
    }
    if (rType(r) === ARMY) {
      const tx = rX(r) + straight.dx, ty = rY(r) + straight.dy;
      if (inSet(0x01, terrainAt(m, tx, ty)) && topIs(m, tx, ty, 1 << TRANSPORT, 1 << rOwner(r)) &&
          pCargo(m, pieceAt(topPieceAt(m, tx, ty))) < 6) {
        m.setW(PATH_STEP_X, straight.dx);
        m.setW(PATH_STEP_Y, straight.dy);
        return straight;
      }
    }
    if (rOrders(r) !== 2 || inSet(terrainSet, terrainAt(m, rX(r) + d.dx, rY(r) + d.dy))) {
      if (rOrders(r) === 2) {
        if (inSet(terrainSet, terrainAt(m, s8(r[3]), s8(r[2])))) {
          r[11] = (r[11] & 0x3f) | 0x40;
          m.setB(PATH_DECIDED, 0);
          return { dx: 0, dy: 0 };
        }
        setOrders(r, chooseDetour(m, terrainSet, r));
      }
      followEdge(m, r, terrainSet & 0xff, d);
    }
    out = d;
  }
  m.setW(PATH_STEP_X, out.dx);
  m.setW(PATH_STEP_Y, out.dy);
  return out;
}
