/**
 * How the computer opponent moves its awake warships (CODE 6 + 0x35D0 and the routines it
 * calls), and how it sends any ship somewhere by sea (CODE 6 + 0x2E22).
 */
import { Mem, s16 } from "../mem.ts";
import { BATTLESHIP, CARRIER, CITY_COUNT, CITY_P1, CITY_P2, OPPONENT_OF, SUBMARINE } from "../globals.ts";
import { distance, explored, hypot, inSet, onMap, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_CENTERS, islandAt } from "../mapgen.ts";
import { setDestination } from "../moveops.ts";
import { isWeakened } from "../battle.ts";
import { pieceAt, pOwner, pSpotted, pStrength, pType, pX, pY, setState } from "../piece.ts";
import { enemyAdjacent, foundEnemy } from "../query.ts";
import { gameRandom, qdRandom } from "../random.ts";
import { findPieceNear } from "../turn.ts";
import { cityRec } from "../units.ts";
import { AI_LIMIT_10, AI_LIMIT_8 } from "../newgame.ts";
import { BUILDING_TOTAL, islandRec } from "./data.ts";
import { exploreAround, movesLeft } from "./fighters.ts";
import {
  attackStep, clampToMap, closedTerrain, evade, fullStrength, islandBeside, noRoute, takesOn,
} from "./moves.ts";
import { BASE_ISLAND, ENEMY_CENTRE_X, ENEMY_CENTRE_Y, TARGET_ISLAND } from "./production.ts";

const WATER = 0x01;
/** Water and player 2's cities (terrain 0, 4). */
const SEA_LANE = 0x11;
/** Neutral and player 1 cities (terrain 1, 2). */
const CITIES_TO_TAKE = 0x06;
const centreX = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i + 1);
const centreY = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i);
const standing = (m: Mem, island: number) => m.b(islandRec(island) + 14) & 3;

/**
 * CODE 6 + 0x2E22: send ship `p` towards (x, y) by sea. It gets go-to orders there (and
 * that becomes its point A). If the path finder finds no way round, the straight line
 * from the ship is walked instead, in hypot() steps: up to the first square that is not
 * water or one of player 2's cities, or off the map; reaching the far end (or stopping on
 * it), the ship goes there; stopping off the map, it goes to that square; stopping on land,
 * the walk goes on over the land: if it comes to water on the map, along that water to
 * its end or the far end (the last water square on the way, or one past the end); if not,
 * to the last water square before the land (or the original destination when that square
 * is not water).
 */
export function shipGoTo(m: Mem, p: number, x: number, y: number): void {
  setDestination(m, p, x, y);
  m.setB(p + 1, x);
  m.setB(p, y);
  if (!noRoute(m, p)) return;
  const px = pX(m, p), py = pY(m, p);
  const dx = s16(x - px), dy = s16(y - py);
  const n = hypot(dx, dy);
  if (n === 0) {
    setDestination(m, p, px, py);
    return;
  }
  const at = (k: number): [number, number] => [Math.trunc(s16(k * dx) / n), Math.trunc(s16(k * dy) / n)];
  const terrain = (sx: number, sy: number) => terrainAt(m, px + sx, py + sy);
  const on = (sx: number, sy: number) => onMap(px + sx, py + sy);
  let k = 0, sx = 0, sy = 0, lastWater = 0;
  do {
    [sx, sy] = at(k);
    lastWater = k - 1;
    k++;
  } while (inSet(SEA_LANE, terrain(sx, sy)) && on(sx, sy) && !(n < k));
  if (n < k || (px + sx === x && py + sy === y)) {
    setDestination(m, p, px + sx, py + sy);
    return;
  }
  if (!on(sx, sy)) {
    k--;
    [sx, sy] = at(k);
    setDestination(m, p, px + sx, py + sy);
    return;
  }
  do {
    [sx, sy] = at(k);
    k++;
  } while (!inSet(WATER, terrain(sx, sy)) && on(sx, sy) && !(n < k));
  k--;
  if (!on(sx, sy) || !inSet(WATER, terrain(sx, sy))) {
    const [ax, ay] = at(lastWater);
    if (terrainAt(m, px + ax, py + ay) !== 0) setDestination(m, p, x, y);
    else setDestination(m, p, px + ax, py + ay);
    return;
  }
  do {
    [sx, sy] = at(k);
    if (inSet(WATER, terrain(sx, sy))) lastWater = k;
    k++;
  } while (inSet(WATER, terrain(sx, sy)) && on(sx, sy) && !(n < k));
  if (n < k && inSet(WATER, terrain(sx, sy))) {
    setDestination(m, p, px + sx, py + sy);
    return;
  }
  if (!inSet(WATER, terrain(sx, sy))) k = lastWater;
  const [ex, ey] = at(k);
  setDestination(m, p, px + ex, py + ey);
}

/**
 * CODE 6 + 0x33A2: send ship `p` to the nearest of its side's cities on the coast, not on
 * an enemy island. Returns the city, or 0.
 */
export function nearestPort(m: Mem, p: number): number {
  let best = 5000, city = 0;
  const n = m.sb(CITY_COUNT);
  for (let c = 1; c <= n; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) !== pOwner(m, p)) continue;
    const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
    if (!terrainNear(m, cx, cy, WATER)) continue;
    if (standing(m, m.b(cr + 9)) === 3) continue;
    const d = distance(pX(m, p) - cx, pY(m, p) - cy);
    if (d < best) {
      city = c;
      best = d;
    }
  }
  if (best === 5000) return 0;
  const cr = cityRec(city);
  shipGoTo(m, p, m.sb(cr + 7), m.sb(cr + 6));
  return city;
}

/**
 * CODE 6 + 0x34A4: send ship `p` to a random square (x 2-78, y 2-58), trying up to four for
 * one that is water player 2 has not explored.
 */
export function randomSeaTarget(m: Mem, p: number): void {
  let x: number, y: number, tries = 0;
  for (;;) {
    x = (qdRandom(m) % 39) + 40;
    y = (qdRandom(m) % 29) + 30;
    tries++;
    if (!explored(m, 2, x, y) && terrainAt(m, x, y) === 0) break;
    if (tries > 3) break;
  }
  shipGoTo(m, p, x, y);
}

/** CODE 6 + 0x3556: send ship `p` past the target island, three times as far beyond it as it is now. */
function beyondTarget(m: Mem, p: number): void {
  const target = m.sw(TARGET_ISLAND);
  const cx = centreX(m, target), cy = centreY(m, target);
  const [x, y] = clampToMap(cx + s16((cx - pX(m, p)) * 3), cy + s16((cy - pY(m, p)) * 3));
  shipGoTo(m, p, x, y);
}

/** Get away from danger (see evade) with the given reach, then sail where that leads. */
function retreat(m: Mem, p: number, n: number): void {
  evade(m, p, m.sb(OPPONENT_OF + pOwner(m, p)), closedTerrain(m, 2, pType(m, p)), n, true);
  shipGoTo(m, p, m.sb(p + 3), m.sb(p + 2));
}

/**
 * CODE 6 + 0x35D0: an awake computer Destroyer, Submarine, Carrier or Battleship, `idx`.
 *
 * Damaged in one of its side's cities on an island not the enemy's, with no enemy next to
 * it, it sleeps (to be repaired). A spotted enemy next to it (not in a player 1 city) is
 * attacked if the ship takes it on and is not in port, and otherwise escaped. Next to a
 * neutral or player 1 city it keeps away. Damaged, it makes for port. It then hunts: a
 * spotted enemy warship, Transport or Bomber within ten squares (for a Battleship with
 * none, an Army on the coast within its moves; for a Destroyer, Carrier or Battleship, a
 * Submarine within its moves when the first target was spotted). With no target: when the
 * side has enough cities (ten, or eight for a Submarine, Carrier or Battleship) it goes on
 * the attack round the target island (or looks round when there is none); otherwise it
 * patrols, now and then heading for the target island or the enemy's centre.
 */
export function shipMove(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  const type = pType(m, p);
  if (fullStrength(type) > pStrength(m, p) && terrainAt(m, x, y) === CITY_P2 && !enemyAdjacent(m, idx, 2, x, y) &&
      standing(m, islandAt(m, x, y)) !== 3) {
    setState(m, p, 2);
    return;
  }

  let engage = enemyAdjacent(m, idx, 2, x, y);
  if (engage) {
    const e = pieceAt(foundEnemy(m));
    engage = terrainAt(m, pX(m, e), pY(m, e)) !== CITY_P1;
  }
  if (engage && pSpotted(m, pieceAt(foundEnemy(m))) !== 0) {
    if (takesOn(m, pieceAt(foundEnemy(m)), p) && terrainAt(m, x, y) !== CITY_P2) attackStep(m, p, foundEnemy(m));
    else retreat(m, p, 4);
    return;
  }
  if (terrainNear(m, x, y, CITIES_TO_TAKE)) {
    retreat(m, p, 10);
    return;
  }
  if (isWeakened(type, pStrength(m, p)) && nearestPort(m, p) !== 0) return;

  let target = findPieceNear(m, true, 0xf4, 1, 10, y, x);
  if (target === 0 && type === BATTLESHIP) {
    target = findPieceNear(m, true, 0x01, 1, movesLeft(m, p), y, x);
    if (target !== 0 && !terrainNear(m, pX(m, pieceAt(target)), pY(m, pieceAt(target)), WATER)) target = 0;
  }
  if (inSet(0x54, type)) {
    const sub = findPieceNear(m, true, 1 << SUBMARINE, 1, movesLeft(m, p), y, x);
    // The original tests the first target's record (record 0 when there was none).
    if (sub !== 0 && pSpotted(m, pieceAt(target)) !== 0) target = sub;
  }
  if (target !== 0 && pSpotted(m, pieceAt(target)) !== 0) {
    shipGoTo(m, p, pX(m, pieceAt(target)), pY(m, pieceAt(target)));
    return;
  }

  const total = m.sw(BUILDING_TOTAL);
  if ((total >= m.sw(AI_LIMIT_8) && inSet(0x58, type)) || total >= m.sw(AI_LIMIT_10)) {
    const island = m.sw(TARGET_ISLAND);
    if (island === 0) {
      if (qdRandom(m) % 2 !== 0) exploreAround(m, p, SEA_LANE, 10);
      else randomSeaTarget(m, p);
      return;
    }
    if (islandBeside(m, x, y, island)) {
      if (type === SUBMARINE) retreat(m, p, 10);
      else if (qdRandom(m) & 1) beyondTarget(m, p);
      else retreat(m, p, 5);
      return;
    }
    if (type === CARRIER) {
      // With a base island, on a coin toss the Carrier is left as it is.
      if ((gameRandom(m) & 1) !== 0 && m.sw(BASE_ISLAND) !== 0) return;
    }
    shipGoTo(m, p, centreX(m, island), centreY(m, island));
    return;
  }

  exploreAround(m, p, SEA_LANE, 10);
  shipGoTo(m, p, m.sb(p + 3), m.sb(p + 2));
  const roll = () => Math.abs(gameRandom(m)) % 10;
  const island = m.sw(TARGET_ISLAND);
  if ((roll() < 5 || m.sw(BUILDING_TOTAL) >= m.sw(AI_LIMIT_10)) && island !== 0) {
    if (roll() < 5) {
      randomSeaTarget(m, p);
    } else if (roll() < 5) {
      shipGoTo(m, p, centreX(m, island), centreY(m, island));
    } else if (m.sb(ENEMY_CENTRE_X) === 0) {
      if (qdRandom(m) % 10 > 0) exploreAround(m, p, SEA_LANE, 10);
      else randomSeaTarget(m, p);
    } else {
      shipGoTo(m, p, m.sb(ENEMY_CENTRE_X), m.sb(ENEMY_CENTRE_Y));
    }
    return;
  }
  if (qdRandom(m) % 10 > 0) exploreAround(m, p, SEA_LANE, 10);
  else randomSeaTarget(m, p);
}
