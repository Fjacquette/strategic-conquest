/**
 * How the computer opponent moves its pieces (CODE 6 + 0x5102 and the routines it calls).
 */
import { Mem } from "../mem.ts";
import {
  ARMY, BATTLESHIP, BOMBER, CARRIER, CITY_COUNT, CITY_P2, DESTROYER, FIGHTER, FOUND_X, FOUND_Y, OPPONENT_OF,
  OWN_CITY_CODE, SUBMARINE,
} from "../globals.ts";
import { topPieceAt } from "../hash.ts";
import { type Reply } from "../host.ts";
import { distance, hypot, inSet, onMap, terrainAt, terrainNear } from "../map.ts";
import { islandAt } from "../mapgen.ts";
import { s16 } from "../mem.ts";
import { setDestination } from "../moveops.ts";
import { chooseDetour, type Dir, lineClear, nextStep, PATH_DECIDED, PATH_STEP_X, PATH_STEP_Y, rotate } from "../path.ts";
import { isWeakened } from "../battle.ts";
import { pCargo, pieceAt, pOwner, pStrength, pType, pX, pY, setState } from "../piece.ts";
import { qdRandom, randomBool } from "../random.ts";
import { findPieceNear } from "../turn.ts";
import { cityRec } from "../units.ts";
import { REPLY_DX, REPLY_DY } from "./data.ts";

/** CODE 4 + 0x109E: a type's full strength. */
export function fullStrength(type: number): number {
  return [1, 1, 4, 3, 10, 3, 18, 1][type] ?? 0;
}

/**
 * CODE 4 + 0x0A50: the terrain a piece of `type` belonging to `owner` may not enter of its
 * own accord: water for Armies; neutral cities and the enemy's for Fighters; neutral
 * cities, the enemy's and land for ships; neutral cities for Bombers. A terrain set (bits
 * 0-7).
 */
export function closedTerrain(m: Mem, owner: number, type: number): number {
  const enemyCity = 1 << m.sb(OWN_CITY_CODE + m.sb(OPPONENT_OF + owner));
  if (type === ARMY) return 0x01;
  if (type === FIGHTER) return (enemyCity | 0x02) & 0xff;
  if (type === BOMBER) return 0x02;
  if (type >= DESTROYER && type <= BATTLESHIP) return (enemyCity | 0x0a) & 0xff;
  return 0;
}

/**
 * CODE 6 + 0x5388: whether a computer piece `mover` takes on the piece `other` in its way:
 * an Army anything on land or in a city, or (with its island field set) Armies, aircraft
 * and Transports; a Fighter aircraft, Submarines and Transports; a Destroyer Submarines,
 * Transports and Bombers, and when not weakened aircraft and Destroyers; a Submarine
 * Submarines and larger ships; a Carrier Submarines, Transports and Bombers, and when not
 * weakened Fighters, Destroyers and Carriers; a Battleship Submarines, Transports and
 * Bombers, or anything when not weakened; a Bomber Armies, Carriers, Transports and
 * Battleships. A Transport takes on nothing.
 */
export function takesOn(m: Mem, other: number, mover: number): boolean {
  const weak = isWeakened(pType(m, mover), pStrength(m, mover));
  const t = pType(m, other);
  switch (pType(m, mover)) {
    case ARMY:
      return inSet(0x1e, terrainAt(m, pX(m, other), pY(m, other))) || (pCargo(m, mover) !== 0 && inSet(0xa3, t));
    case FIGHTER:
      return inSet(0xaa, t);
    case DESTROYER:
      return inSet(0xa8, t) || (!weak && inSet(0x06, t));
    case SUBMARINE:
      return inSet(0x78, t);
    case CARRIER:
      return inSet(0xa8, t) || (!weak && inSet(0x16, t));
    case BATTLESHIP:
      return inSet(0xa8, t) || !weak;
    case BOMBER:
      return inSet(0x71, t);
    default:
      return false;
  }
}

/** Ships (types 2-6). */
const SHIPS = 0x7c;
/** Types that may stack with their own side's pieces: Armies and aircraft. */
const STACKERS = 0x83;

/**
 * CODE 6 + 0x4DEE: the step of a computer piece `idx` that follows its orders: the
 * direction the path finder chose, turned an eighth (the same random way each time) while
 * it is blocked, up to eight times. A Fighter goes where nothing is, or where it takes on
 * what is there; it turns once at most. Other pieces turn away from terrain closed to them,
 * from the edge of the map, and from their own side's pieces unless they may stack; a
 * ship at full strength also turns away from player 2's cities. A piece blocked all round
 * stays put; one that had to turn gets go-to orders to the square it now steps to.
 */
export function followOrders(m: Mem, idx: number, reply: Reply): void {
  const p = pieceAt(idx);
  reply.dx = 0;
  reply.dy = 0;
  const d: Dir = { dx: (m.w(PATH_STEP_X) << 24) >> 24, dy: (m.w(PATH_STEP_Y) << 24) >> 24 };
  let blocked = false;
  let tries = 0;
  const turn = qdRandom(m) < 0 ? 1 : 0;
  const type = pType(m, p), owner = pOwner(m, p);
  let nx: number, ny: number;
  do {
    nx = pX(m, p) + d.dx;
    ny = pY(m, p) + d.dy;
    const top = topPieceAt(m, nx, ny);
    if (type === FIGHTER) {
      reply.dx = d.dx;
      reply.dy = d.dy;
      if (top === 0) return;
      if (!takesOn(m, pieceAt(top), p)) {
        rotate(turn, d);
        reply.dx = d.dx;
        reply.dy = d.dy;
        return;
      }
    } else if (inSet(SHIPS, type) && terrainAt(m, nx, ny) === CITY_P2 && pStrength(m, p) === fullStrength(type)) {
      rotate(turn, d);
      blocked = true;
    } else if (inSet(closedTerrain(m, owner, type), terrainAt(m, nx, ny))) {
      rotate(turn, d);
      blocked = true;
    } else if (!onMap(nx, ny)) {
      rotate(turn, d);
      blocked = true;
    } else if (pOwner(m, pieceAt(top)) === owner && !inSet(STACKERS, type)) {
      rotate(turn, d);
      blocked = true;
    } else {
      blocked = false;
    }
    tries++;
  } while (tries !== 8 && blocked);
  if (blocked) {
    reply.dx = 0;
    reply.dy = 0;
    return;
  }
  if (tries > 1) setDestination(m, p, pX(m, p) + d.dx, pY(m, p) + d.dy);
  reply.dx = d.dx;
  reply.dy = d.dy;
}

/** Set the computer's chosen step. */
export function setReply(m: Mem, dx: number, dy: number): void {
  m.setB(REPLY_DX, dx);
  m.setB(REPLY_DY, dy);
}

/** CODE 7 + 0x0004: step piece `p` onto the square of piece `target`. */
export function attackStep(m: Mem, p: number, target: number): void {
  const t = pieceAt(target);
  setReply(m, pX(m, t) - pX(m, p), pY(m, t) - pY(m, p));
}

/**
 * CODE 7 + 0x0050: step piece `p` into the first city (in city order) next to it whose
 * owner's city terrain is in `terrainSet`; the piece is then awake.
 */
export function cityStep(m: Mem, p: number, terrainSet: number): void {
  const n = m.sb(CITY_COUNT);
  for (let c = 1; c <= n; c++) {
    const cr = cityRec(c);
    if (!inSet(terrainSet, m.sb(OWN_CITY_CODE + m.sb(cr + 4)))) continue;
    const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
    if (distance(pX(m, p) - cx, pY(m, p) - cy) === 1) {
      setReply(m, cx - pX(m, p), cy - pY(m, p));
      setState(m, p, 1);
      return;
    }
  }
}

/**
 * CODE 1 + 0x05DE: the path finder's next step for piece `p` (a copy of it, so the piece's
 * own path state is left alone), avoiding the terrain closed to its type for player 2.
 */
export function pathStep(m: Mem, p: number): Dir {
  return nextStep(m, closedTerrain(m, 2, pType(m, p)), m.bytes(p, 14).slice());
}

/**
 * CODE 4 + 0x1972: whether piece `p` has no way round to its destination: simulating the
 * detour both ways (on a copy) found them equally long, so the choice was a coin toss.
 */
export function noRoute(m: Mem, p: number): boolean {
  chooseDetour(m, closedTerrain(m, pOwner(m, p), pType(m, p)), m.bytes(p, 14).slice());
  return (m.b(PATH_DECIDED) ^ 1) !== 0;
}

/** CODE 6 + 0x5932: a destination kept inside the playable area (x 2-79, y 2-59). */
export function clampToMap(x: number, y: number): [number, number] {
  return [Math.min(Math.max(x, 2), 79), Math.min(Math.max(y, 2), 59)];
}

/**
 * CODE 6 + 0x597A: move piece `p` away from danger. From the path finder's next step,
 * turning a random way, the first of the eight directions whose square has no piece of
 * `enemy` (Transports aside) that player 2 has spotted within one square, is on the map
 * and not of `closedSet` terrain, and (when `avoidCities`) is not next to a neutral or
 * player 1 city, is taken: it is returned, and the piece gets go-to orders `n` steps that
 * way (one step when that would be the square 0, 0), kept on the map. Returns 0, 0 if no
 * direction qualifies.
 */
export function evade(m: Mem, p: number, enemy: number, closedSet: number, n: number, avoidCities: boolean): Dir {
  const d = pathStep(m, p);
  const turn = randomBool(m) ? 1 : 0;
  for (let k = 1; k <= 8; k++) {
    rotate(turn, d);
    const nx = pX(m, p) + d.dx, ny = pY(m, p) + d.dy;
    if (findPieceNear(m, true, 0xdf, enemy, 1, ny, nx) !== 0) continue;
    if (!onMap(nx, ny)) continue;
    if (inSet(closedSet, terrainAt(m, nx, ny))) continue;
    if (terrainNear(m, nx, ny, 0x06) && avoidCities) continue;
    let tx = s16(pX(m, p) + d.dx * n), ty = s16(pY(m, p) + d.dy * n);
    if (tx === 0 && ty === 0) {
      tx = nx;
      ty = ny;
    }
    [tx, ty] = clampToMap(tx, ty);
    setDestination(m, p, tx, ty);
    return { dx: d.dx, dy: d.dy };
  }
  return { dx: 0, dy: 0 };
}

/**
 * CODE 1 + 0x2A56: whether island `island` touches the 3x3 block centred on (x, y); the
 * first such square (columns, then rows) is recorded in FOUND_X / FOUND_Y.
 */
export function islandBeside(m: Mem, x: number, y: number, island: number): boolean {
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) {
      if (islandAt(m, cx, cy) === island) {
        m.setB(FOUND_X, cx);
        m.setB(FOUND_Y, cy);
        return true;
      }
    }
  }
  return false;
}

/** CODE 1 + 0x2AEC: the square last recorded by terrainNear, islandBeside or terrainWithin. */
export function foundCell(m: Mem): [number, number] {
  return [m.sb(FOUND_X), m.sb(FOUND_Y)];
}

/**
 * CODE 1 + 0x296E: whether terrain in `terrainSet` lies within `r` squares of (x, y), the
 * square searched being kept inside the playable area; the first such square (columns,
 * then rows) is recorded in FOUND_X / FOUND_Y.
 */
export function terrainWithin(m: Mem, x: number, y: number, terrainSet: number, r: number): boolean {
  const x0 = Math.max(x - r, 2), x1 = Math.min(r + x, 79);
  const y0 = Math.max(y - r, 2), y1 = Math.min(r + y, 59);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      if (inSet(terrainSet, terrainAt(m, cx, cy))) {
        m.setB(FOUND_X, cx);
        m.setB(FOUND_Y, cy);
        return true;
      }
    }
  }
  return false;
}

/**
 * CODE 6 + 0x62D0: whether the straight line from (x, y) to (tx, ty) crosses no terrain in
 * `terrainSet` (the path finder's line test).
 */
export function lineClearTo(m: Mem, x: number, y: number, tx: number, ty: number, terrainSet: number): boolean {
  const r = new Uint8Array(14);
  r[2] = ty & 0xff;
  r[3] = tx & 0xff;
  r[4] = y & 0xff;
  r[5] = x & 0xff;
  return lineClear(m, terrainSet & 0xff, r);
}

/**
 * CODE 1 + 0x03E2: whether (x2, y2) can be seen from (x1, y1): stepping along the line in
 * hypot() steps, the walk stops at the last step before the far end, at a square of
 * `terrainSet` or off the map; the answer is whether the square it stopped on is not of
 * `terrainSet` (the far end itself when the points are one step apart, and yes when they
 * are the same).
 */
export function clearLine(m: Mem, x1: number, y1: number, x2: number, y2: number, terrainSet: number): boolean {
  const dx = s16(x2 - x1), dy = s16(y2 - y1);
  const n = hypot(dx, dy);
  if (n === 0) return true;
  let k = 1, sx = 0, sy = 0;
  for (;;) {
    sx = Math.trunc(s16(k * dx) / n);
    sy = Math.trunc(s16(k * dy) / n);
    k++;
    if (n <= k) break;
    if (inSet(terrainSet, terrainAt(m, sx + x1, sy + y1))) break;
    if (!onMap(sx + x1, sy + y1)) break;
  }
  return !inSet(terrainSet, terrainAt(m, sx + x1, sy + y1));
}
