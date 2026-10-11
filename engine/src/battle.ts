/**
 * Combat (battle segment, CODE 3). Rules are documented in docs/rules/combat.md.
 */
import { Mem } from "./mem.ts";
import {
  ARMY, BATTLESHIP, BOMBER, CARRIER, CITY_COUNT, CITY_NEUTRAL, CITIES, CITY_SIZE, COMBAT_TABLE,
  DESTROYER, FIGHTER, NET_SYNC, PIECE_SIZE, SUBMARINE, TRANSPORT, WATER,
} from "./globals.ts";
import { distance, inSet, setTerrain, terrainAt } from "./map.ts";
import { pieceCount } from "./query.ts";
import { gameRandom } from "./random.ts";
import { killPiece, killTypesAt } from "./table.ts";
import { pieceAt, pOwner, pRadius, pStrength, pType, pX, pY, setStrength } from "./piece.ts";

const SHIPS = 0x7c; // Destroyer..Battleship
const AIRCRAFT = 0x82; // Fighter, Bomber
const SURFACE = 0x7d; // everything except aircraft
const WARSHIPS = 0x5c; // ships except the Transport
const FIGHTER_BONUS = 0xa8; // Submarine, Transport, Bomber
const CITY_TERRAIN = 0x16; // neutral and owned cities
const OWNED_CITY = 0x14;
const LAND_OR_NEUTRAL = 0x0a;
const STACK_SHIPS = 0x30; // Carrier, Transport
const CARRIER_STACK = 0x12; // Fighter, Carrier

export const ATTACKER_WINS = 0;
export const ATTACKER_LOSES = 1;

/** Mac key codes of the original's debug keys (Option-W / Option-L force a result). */
export const KEY_OPTION = 0x3a;
export const KEY_W = 0x0d;
export const KEY_L = 0x25;

/** CODE 4 + 0x1110: a piece at or below its type's threshold fights at reduced damage. */
export function isWeakened(ptype: number, strength: number): boolean {
  switch (ptype) {
    case ARMY: case FIGHTER: case BOMBER: return strength <= 0;
    case DESTROYER: case SUBMARINE: case TRANSPORT: return strength <= 2;
    case CARRIER: return strength <= 7;
    case BATTLESHIP: return strength <= 10;
    default: return false;
  }
}

function column(m: Mem, a: number, b: number): number {
  const ratio = Math.trunc((pStrength(m, a) * 10) / pStrength(m, b));
  let col: number;
  if (ratio <= 1) col = 1;
  else if (ratio === 2) col = 2;
  else if (ratio <= 5) col = 3;
  else if (ratio <= 10) col = 4;
  else if (ratio <= 20) col = 5;
  else if (ratio <= 40) col = 6;
  else col = 7;
  const at = pType(m, a), dt = pType(m, b);
  if (at === DESTROYER && dt === TRANSPORT) col += 2;
  if (at === FIGHTER && inSet(FIGHTER_BONUS, dt)) col += 1;
  if (at === SUBMARINE && inSet(SHIPS, dt)) col += 4;
  if (at === DESTROYER && dt === SUBMARINE) col += 4;
  if (at === ARMY && inSet(WARSHIPS, dt)) col -= 1;
  if (at === BOMBER && inSet(AIRCRAFT, dt)) col -= 1;
  if (at === BOMBER && inSet(SHIPS, dt)) col = 1;
  if (inSet(CITY_TERRAIN, terrainAt(m, pX(m, b), pY(m, b))) && inSet(SHIPS, dt)) col += 4;
  if (col > 7) col = 7;
  if (col < 1) col = 1;
  return col;
}

/** CODE 3 + 0x0004: one roll on the combat results table (from the globals). */
export function resolveCombat(m: Mem, a: number, b: number, keys: ReadonlySet<number>): number {
  if (keys.has(KEY_OPTION) && keys.has(KEY_W)) return ATTACKER_WINS;
  if (keys.has(KEY_OPTION) && keys.has(KEY_L)) return ATTACKER_LOSES;
  const col = column(m, a, b);
  const die = (Math.abs(Math.trunc(gameRandom(m) / 113)) % 6) + 1;
  return m.sb(COMBAT_TABLE + (die - 1) * 8 + col - 1);
}

/**
 * CODE 2 + 0x0004: the combat results table, a row of 8 bytes per die roll with columns 1-7
 * used: 0 the attacker wins, 1 the attacker loses, 2 the attack is repelled.
 */
export function initCombatTable(m: Mem): void {
  const rows = [
    [1, 1, 1, 1, 1, 2, 2],
    [1, 1, 1, 1, 2, 2, 0],
    [1, 1, 1, 2, 2, 0, 0],
    [1, 1, 2, 2, 0, 0, 0],
    [1, 2, 2, 0, 0, 0, 0],
    [1, 2, 0, 0, 0, 0, 0],
  ];
  rows.forEach((row, die) => m.bytes(COMBAT_TABLE + die * 8, 7).set(row));
}

/** CODE 3 + 0x0332: destroy piece `idx`, then restore `ownerSrc`'s owner bits. */
function killKeepOwner(m: Mem, ownerSrc: number, idx: number): void {
  const owner = pOwner(m, ownerSrc);
  killPiece(m, idx);
  m.setB(ownerSrc + 10, (m.b(ownerSrc + 10) & 0xcf) | (owner << 4));
}

/**
 * CODE 3 + 0x0374: destroy a Transport or Carrier and everything on its cell. In an owned
 * city only the first piece found on the cell is destroyed, and the ship's owner bits are
 * written back over it (the defect logged as quirk Q4).
 */
function killStack(m: Mem, loser: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pX(m, p) !== pX(m, loser) || pY(m, p) !== pY(m, loser)) continue;
    if (inSet(STACK_SHIPS, pType(m, loser)) && inSet(OWNED_CITY, terrainAt(m, pX(m, loser), pY(m, loser)))) {
      killKeepOwner(m, loser, i);
      return;
    }
    const owner = pOwner(m, p);
    killPiece(m, i);
    m.setB(p + 10, (m.b(p + 10) & 0xcf) | (owner << 4));
  }
}

/** CODE 3 + 0x0492 */
function applyDamage(m: Mem, loser: number, idx: number, damage: number): void {
  if (pStrength(m, loser) <= damage) {
    if (inSet(STACK_SHIPS, pType(m, loser))) killStack(m, loser);
    else killKeepOwner(m, loser, idx);
  } else {
    setStrength(m, loser, pStrength(m, loser) - damage);
  }
}

function battleshipDamage(strength: number, stale: number): number {
  if (strength >= 1 && strength <= 6) return 3;
  if (strength >= 7 && strength <= 10) return 4;
  if (strength >= 11 && strength <= 14) return 5;
  if (strength >= 15 && strength <= 18) return 6;
  return stale;
}

function swapRecords(m: Mem, a: number, b: number): void {
  const tmp = m.bytes(a, PIECE_SIZE).slice();
  m.bytes(a, PIECE_SIZE).set(m.bytes(b, PIECE_SIZE));
  m.bytes(b, PIECE_SIZE).set(tmp);
}

/**
 * CODE 3 + 0x0520: piece `a` (index aIdx) attacks piece `b` (index bIdx). `spotted` is the
 * defender's spotted value before the fight; 0 lets a Submarine attacked by a ship strike
 * first. Returns TRUE only when a Submarine is lost attacking a target on land or in a
 * neutral city. `staleDamage` stands in for a register the original leaves unset when a
 * Battleship's strength is out of range (it cannot be, in play).
 */
export function attack(
  m: Mem, a: number, b: number, aIdx: number, bIdx: number, spotted: number,
  keys: ReadonlySet<number> = new Set(), staleDamage = 0,
): boolean {
  const tb = terrainAt(m, pX(m, b), pY(m, b));
  if (pType(m, a) === ARMY && pType(m, b) === SUBMARINE && tb === WATER) return false;
  if (pType(m, a) === TRANSPORT) return false;
  if (pType(m, a) === SUBMARINE && inSet(AIRCRAFT, pType(m, b))) return false;
  if (pType(m, a) === SUBMARINE && inSet(LAND_OR_NEUTRAL, tb)) {
    killKeepOwner(m, a, aIdx);
    return true;
  }
  const swapped = inSet(SHIPS, pType(m, a)) && pType(m, b) === SUBMARINE && spotted === 0;
  if (swapped) swapRecords(m, a, b);
  const outcome = resolveCombat(m, a, b, keys);
  if (outcome === ATTACKER_WINS) {
    let dmg: number;
    if (pType(m, a) === SUBMARINE) dmg = pType(m, b) === DESTROYER ? 1 : pStrength(m, a) * 3;
    else if (pType(m, a) === BATTLESHIP) dmg = battleshipDamage(pStrength(m, a), staleDamage);
    else dmg = isWeakened(pType(m, a), pStrength(m, a)) ? 2 : 3;
    applyDamage(m, b, bIdx, dmg);
  } else if (outcome === ATTACKER_LOSES) {
    if (pType(m, b) !== TRANSPORT && (pType(m, a) !== FIGHTER || pType(m, b) !== SUBMARINE)) {
      const dmg = isWeakened(pType(m, b), pStrength(m, b)) ? 2 : 3;
      applyDamage(m, a, aIdx, dmg);
    }
  }
  if (swapped) swapRecords(m, a, b);
  for (const p of [a, b]) {
    if (pStrength(m, p) > 1) {
      const r = gameRandom(m);
      if (Math.abs(r) % 10 < 5) setStrength(m, p, pStrength(m, p) - 1);
    }
  }
  return false;
}

/**
 * CODE 3 + 0x0A30: a Bomber's blast. Everything within the blast radius (Chebyshev
 * distance) is hit: surface pieces are destroyed (a Carrier together with its Fighters),
 * aircraft only when parked in an owned city; cities in range become neutral.
 */
export function bomberBlast(m: Mem, bomber: number, _idx: number, strayD5 = 0): void {
  const radius = pRadius(m, bomber);
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (distance(pX(m, bomber) - pX(m, p), pY(m, bomber) - pY(m, p)) > radius) continue;
    if (inSet(SURFACE, pType(m, p))) {
      if (pType(m, p) === CARRIER) killTypesAt(m, pX(m, p), pY(m, p), CARRIER_STACK);
      else killPiece(m, i);
    } else if (inSet(AIRCRAFT, pType(m, p)) && inSet(OWNED_CITY, terrainAt(m, pX(m, p), pY(m, p)))) {
      killPiece(m, i);
    }
  }
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const rec = CITIES + c * CITY_SIZE;
    const cy = m.sb(rec + 6), cx = m.sb(rec + 7);
    if (distance(cx - pX(m, bomber), cy - pY(m, bomber)) <= radius) {
      setTerrain(m, cx, cy, CITY_NEUTRAL);
      m.setB(rec + 4, 0);
      m.setB(rec + 5, 0);
      m.setB(rec + 8, 0);
    }
  }
  // The original ends with CODE 1 + 0x0176(D5) when D5 is non-zero; outside network play
  // D5 still holds the caller's value (MoveBomber: its last exploration result).
  if (strayD5 & 0xff) m.setB(NET_SYNC, strayD5);
}

