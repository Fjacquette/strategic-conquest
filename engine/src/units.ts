/**
 * Unit statistics, production and new pieces. Rules are documented in docs/rules/units.md.
 */
import { Mem } from "./mem.ts";
import {
  ARMY, BATTLESHIP, BOMBER, CARRIER, CITIES, CITY_COUNT, CITY_SIZE, DAY, DESTROYER, FIGHTER,
  GAME_MODE, LOCAL_PLAYER, PIECE_COUNT, PIECE_HASH, SKILL, SUBMARINE, TRANSPORT, TYPE_STR_IDS,
} from "./globals.ts";
import { hashInsert } from "./hash.ts";
import { inSet, setTerrain } from "./map.ts";
import { OWN_CITY_CODE } from "./globals.ts";
import { pieceCount } from "./query.ts";
import {
  pieceAt, pSpotted, pOwner, pType, setCargo, setMoved, setBit5, setOrders, setOwner, setPatrol,
  setState, setStrength, setType,
} from "./piece.ts";

const TWO_PLAYER_MODES = 0x0e; // game modes 1-3
const FAST_MODES = 0x06; // game modes 1-2
const SURFACE = 0x7d;
const AIRCRAFT = 0x82;
const INIT_DONE = -0x1277;

export function typeStrId(m: Mem, ptype: number): number {
  return m.sw(TYPE_STR_IDS + 2 * ptype);
}

/**
 * CODE 4 + 0x11BA. For a type outside 0..7 the original returns whatever its caller held in
 * register D7, passed here as `stray` (PlayerTurn's loop index).
 */
export function movesPerDay(m: Mem, ptype: number, strength: number, stray = 0): number {
  let moves: number;
  switch (ptype) {
    case ARMY: moves = 1; break;
    case FIGHTER: moves = 20; break;
    case DESTROYER: moves = strength <= 2 ? 3 : 4; break;
    case SUBMARINE: moves = strength <= 1 ? 2 : 3; break;
    case CARRIER: moves = strength <= 4 ? 2 : 3; break;
    case TRANSPORT: moves = strength <= 1 ? 2 : 3; break;
    case BATTLESHIP: moves = strength <= 6 ? 2 : 3; break;
    case BOMBER: moves = 10; break;
    default: moves = stray;
  }
  if (inSet(TWO_PLAYER_MODES, m.sb(GAME_MODE)) && inSet(SURFACE, ptype)) moves *= 2;
  return moves;
}

/** CODE 1 + 0x021C: days to build a unit. */
export function productionDays(m: Mem, ptype: number): number {
  let days: number;
  switch (ptype) {
    case ARMY: days = 4; break;
    case FIGHTER: days = 6; break;
    case DESTROYER: days = 8; break;
    case SUBMARINE: days = 10; break;
    case CARRIER: days = 14; break;
    case TRANSPORT: days = 10; break;
    case BATTLESHIP: days = 20; break;
    case BOMBER: days = Math.trunc(m.sw(DAY) / 70) * 5 + 20; break;
    default: days = 0;
  }
  if (inSet(TWO_PLAYER_MODES, m.sb(GAME_MODE))) days = Math.trunc(days / 2);
  return days;
}

export function cityRec(idx: number): number {
  return CITIES + idx * CITY_SIZE;
}

/**
 * CODE 1 + 0x0364: one day of production in city `idx` for `player`. Returns the type built
 * when a unit is complete, or -1. (A city at 0 days left wraps to 255.)
 */
export function cityProductionTick(m: Mem, player: number, idx: number): number {
  const c = cityRec(idx);
  if (m.sb(c + 4) !== player) return -1;
  m.setB(c + 5, m.b(c + 5) - 1);
  if (m.b(c + 5) > 0) return -1;
  const ptype = m.sb(c + 8);
  m.setB(c + 5, productionDays(m, ptype));
  return ptype;
}

/**
 * CODE 1 + 0x0188: the city at (x, y), as its index, or 0.
 */
export function cityAt(m: Mem, x: number, y: number): number {
  const n = m.sb(CITY_COUNT);
  for (let i = 1; i <= n; i++) {
    const c = cityRec(i);
    if (m.b(c + 7) === (x & 0xff) && m.b(c + 6) === (y & 0xff)) return i;
  }
  return 0;
}

/**
 * CODE 1 + 0x02B6: city `idx` now belongs to `owner` and builds `ptype`. A change of owner
 * resets the city's Army and aircraft destinations to the city itself; a change of owner
 * or product restarts the production count.
 */
export function setCityOwner(m: Mem, ptype: number, idx: number, owner: number): void {
  const c = cityRec(idx);
  if (m.sb(c + 4) !== owner || m.sb(c + 8) !== ptype) m.setB(c + 5, productionDays(m, ptype));
  if (m.sb(c + 4) !== owner) {
    m.setW(c + 2, m.w(c + 6));
    m.setW(c, m.w(c + 6));
  }
  m.setB(c + 4, owner);
  m.setB(c + 8, ptype);
  setTerrain(m, m.sb(c + 7), m.sb(c + 6), m.sb(OWN_CITY_CODE + owner));
}

/** Arguments of the original's AllocPiece, read by its nested InitNewPiece. */
interface NewPiece {
  x: number;
  y: number;
  owner: number;
  ptype: number;
}

/** CODE 4 + 0x20EE: initialise record `idx` for a new piece. */
function initNewPiece(m: Mem, np: NewPiece, idx: number): void {
  const p = pieceAt(idx);
  setMoved(m, p, 0);
  setBit5(m, p, 0);
  setType(m, p, np.ptype);
  setOwner(m, p, np.owner);
  m.setB(p + 7, np.x);
  m.setB(p + 6, np.y);
  const div = inSet(FAST_MODES, m.sb(GAME_MODE)) ? 35 : 70;
  const radius = Math.trunc((m.sw(DAY) - 5) / div) & 0x3f;
  m.setB(p + 8, (m.b(p + 8) & 0x03) | (radius << 2));
  m.setB(p + 3, np.x);
  m.setB(p + 2, np.y);
  m.setB(p + 5, np.x);
  m.setB(p + 4, np.y);
  m.setB(p + 1, np.x);
  m.setB(p + 0, np.y);
  m.setB(p + 12, m.b(p + 12) & 0x3f);
  setMoved(m, p, 0);
  hashInsert(m, PIECE_HASH, np.x, np.y, idx, np.ptype);
  setState(m, p, 1);
  setPatrol(m, p, 0);
  switch (np.ptype) {
    case ARMY: setStrength(m, p, 1); break;
    case FIGHTER: setStrength(m, p, 1); setCargo(m, p, 20); break;
    case DESTROYER: setStrength(m, p, 4); break;
    case SUBMARINE: setStrength(m, p, 3); break;
    case CARRIER: setStrength(m, p, 10); setCargo(m, p, 0); break;
    case TRANSPORT: setStrength(m, p, 3); setCargo(m, p, 0); break;
    case BATTLESHIP: setStrength(m, p, 18); break;
    case BOMBER: setStrength(m, p, 1); setCargo(m, p, 30); break;
  }
}

/**
 * CODE 4 + 0x22E2: add a piece. With the table full (449 pieces), the local player's piece
 * replaces the last unspotted enemy Army, Fighter or Destroyer in single-player games
 * (quirk Q6); otherwise nothing is built, and the post-processing below is applied to the
 * last piece of the table. New aircraft are sent to their city's aircraft destination.
 */
function allocPiece(m: Mem, x: number, y: number, owner: number, ptype: number): boolean {
  const np: NewPiece = { x, y, owner, ptype };
  let built = false;
  if (pieceCount(m) < 0x1c1) {
    m.setW(PIECE_COUNT, pieceCount(m) + 1);
    initNewPiece(m, np, pieceCount(m));
    built = true;
  } else if (owner === m.sb(LOCAL_PLAYER)) {
    if (m.sb(GAME_MODE) === 0) {
      for (let i = pieceCount(m); i >= 1; i--) {
        const q = pieceAt(i);
        if (pOwner(m, q) !== owner && pSpotted(m, q) === 0 && inSet(0x07, pType(m, q))) {
          initNewPiece(m, np, i);
          return true;
        }
      }
    } else {
      built = false;
    }
  }
  const last = pieceAt(pieceCount(m));
  if (m.b(INIT_DONE) === 0) {
    setType(m, last, ARMY);
    setStrength(m, last, 1);
  }
  if (inSet(AIRCRAFT, pType(m, last))) {
    const ci = cityAt(m, x, y);
    const c = cityRec(ci);
    if (m.b(c + 3) !== m.b(last + 7) || m.b(c + 2) !== m.b(last + 6)) {
      m.setW(last + 4, m.w(last + 6));
      m.setW(last, m.w(last + 6));
      m.setW(last + 2, m.w(c + 2));
      setState(m, last, 0);
      setPatrol(m, last, 0);
      setBit5(m, last, 0);
      setOrders(m, last, 2);
    }
  }
  return built;
}

/**
 * CODE 4 + 0x2496: build a piece in a city. In single-player games the computer (player 2)
 * gets a second piece while day < 2 x (skill - 2).
 */
export function buildPiece(m: Mem, x: number, y: number, owner: number, ptype: number): boolean {
  let built = allocPiece(m, x, y, owner, ptype);
  if (m.sb(GAME_MODE) === 0 && owner === 2 && m.sb(LOCAL_PLAYER) === 1 && (m.sb(SKILL) - 2) * 2 > m.sw(DAY)) {
    built = allocPiece(m, x, y, owner, ptype);
  }
  return built;
}
