/**
 * How the computer opponent moves an awake Bomber (CODE 6 + 0x1D70 and the routines it
 * calls). A Bomber's blast reaches `radius` squares round where it strikes (piece field
 * 8, bits 10-15); it never strikes where one of its side's Armies or ships, or one of its
 * cities, would be caught in the blast.
 */
import { Mem } from "../mem.ts";
import { BOMBER, CITY_COUNT, CITY_P2, MOVE_STEP, OPPONENT_OF, PIECE_COUNT } from "../globals.ts";
import { distance, explored, inSet, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_COUNT } from "../mapgen.ts";
import { setDestination } from "../moveops.ts";
import { pCargo, pieceAt, pOwner, pRadius, pStrength, pType, pX, pY, setState } from "../piece.ts";
import { enemyAdjacent, foundEnemy } from "../query.ts";
import { qdRandom } from "../random.ts";
import { findPieceNear } from "../turn.ts";
import { cityRec, movesPerDay } from "../units.ts";
import { AI_LIMIT_10 } from "../newgame.ts";
import { BUILDING_TOTAL, CITY_MARKS, ISLAND_BYTES, islandRec } from "./data.ts";
import { fighterStep, movesLeft } from "./fighters.ts";
import { cityStep, closedTerrain, evade, foundCell, setReply, takesOn, terrainWithin } from "./moves.ts";
import { BASE_ISLAND, ENEMY_CENTRE_X, ENEMY_CENTRE_Y, TARGET_ISLAND } from "./production.ts";

/** Armies and ships (types 0, 2-6): the side's pieces a blast must not catch. */
const OWN_EXPOSED = 0x7d;
const OWN_CITY = 1 << CITY_P2;
/** Player 1's cities (terrain 2). */
const ENEMY_CITY = 0x04;
const fuel = (m: Mem, p: number) => pCargo(m, p);

/** Whether a blast at (x, y) by Bomber `p` would catch the side's pieces or cities. */
function blastHitsOwn(m: Mem, p: number, x: number, y: number): boolean {
  return findPieceNear(m, false, OWN_EXPOSED, 2, pRadius(m, p), y, x) !== 0 ||
    terrainWithin(m, x, y, OWN_CITY, pRadius(m, p));
}

/** CODE 6 + 0x1D0A: wake player 2's other Bombers (all but `idx`). */
export function wakeOtherBombers(m: Mem, idx: number): void {
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    if (pOwner(m, q) === 2 && pType(m, q) === BOMBER && i !== idx) setState(m, q, 1);
  }
}

/** Fly Bomber `p` to city `c`: a step straight in from next to it, otherwise go-to orders. */
function flyToCity(m: Mem, p: number, c: number): void {
  const cr = cityRec(c);
  const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
  setDestination(m, p, cx, cy);
  if (distance(pX(m, p) - cx, pY(m, p) - cy) > 1) fighterStep(m, p);
  else setReply(m, cx - pX(m, p), cy - pY(m, p));
}

/** Each city once, starting after a random one. */
function citiesFromRandom(m: Mem): number[] {
  const n = m.sb(CITY_COUNT);
  const start = Math.abs(qdRandom(m)) % n;
  const out: number[] = [];
  for (let k = 1; k <= n; k++) out.push(((start + k) % n) + 1);
  return out;
}

/**
 * CODE 6 + 0x146C: choose where Bomber `p` (`idx`) flies.
 *
 * On the attack (the side has enough cities, or an island's byte has bit 0 set): the
 * nearest explored player 1 city on a marked island or the target island, within half its
 * fuel, that it does not reach with exactly its last move, and whose blast would spare the
 * side's own; the city is marked. Failing that, with a base island: a city on the target
 * island (which has enemy cities) nearer than a safe range (fuel less five), else the last
 * city on the base island within that range when no enemy is next to the Bomber.
 * Otherwise: of the side's cities not on the target island and within the safe range, the
 * one farthest from the enemy's centre, when no enemy is next to the Bomber. Then, if none
 * of those, the nearest of the side's cities; with none at all its moves for the day end.
 *
 * When no city qualifies in that last search the original reads a city number it never
 * set (quirk Q18); here that is 0, which sends the Bomber to the nearest city.
 */
export function bomberTarget(m: Mem, p: number, idx: number): void {
  let marked = 0;
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) if (marked === 0) marked = m.b(ISLAND_BYTES + i);
  const x = pX(m, p), y = pY(m, p);
  let nearestOwn = 5000, nearestCity = 0;
  const noteOwn = (c: number, d: number) => {
    if (d < nearestOwn) {
      nearestOwn = d;
      nearestCity = c;
    }
  };
  const safeRange = () => (fuel(m, p) - 5 < 0 ? fuel(m, p) : fuel(m, p) - 5);
  let best: number, chosen = 0;

  if (m.sw(BUILDING_TOTAL) >= m.sw(AI_LIMIT_10) || (marked & 1) !== 0) {
    best = 5000;
    for (const c of citiesFromRandom(m)) {
      const cr = cityRec(c);
      if (m.sb(cr + 4) !== 1) continue;
      const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
      if (!explored(m, 2, cx, cy)) continue;
      const island = m.b(cr + 9);
      if (m.b(ISLAND_BYTES + island) === 0 && island !== m.sw(TARGET_ISLAND)) continue;
      const d = distance(x - cx, y - cy);
      if (d >= best) continue;
      if (Math.trunc(fuel(m, p) / 2) < d) continue;
      if (movesLeft(m, p) === d - 1) continue;
      if (blastHitsOwn(m, p, cx, cy)) continue;
      best = d;
      chosen = c;
    }
    if (best !== 5000) {
      flyToCity(m, p, chosen);
      m.setB(CITY_MARKS + chosen, 1);
      return;
    }
    best = 5000;
    let bestTarget = 5000, targetCity = 0;
    const order = citiesFromRandom(m);
    const base = m.sw(BASE_ISLAND);
    if (base !== 0) {
      for (const c of order) {
        const cr = cityRec(c);
        if (m.sb(cr + 4) !== 2) continue;
        const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
        if (cx === x && cy === y) continue;
        const d = distance(x - cx, y - cy);
        noteOwn(c, d);
        if (m.b(cr + 9) === base && distance(x - cx, y - cy) < safeRange() && !enemyAdjacent(m, idx, 2, x, y)) {
          best = d;
          chosen = c;
        }
        const island = m.b(cr + 9);
        if (island === m.sw(TARGET_ISLAND) && m.sb(islandRec(island) + 13) !== 0) {
          const range = safeRange();
          if (d < bestTarget && distance(x - cx, y - cy) < range) {
            bestTarget = d;
            targetCity = c;
          }
        }
      }
    }
    if (bestTarget !== 5000) {
      flyToCity(m, p, targetCity);
      return;
    }
  } else {
    best = 0;
    for (const c of citiesFromRandom(m)) {
      const cr = cityRec(c);
      if (m.sb(cr + 4) !== 2) continue;
      const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
      noteOwn(c, distance(x - cx, y - cy));
      if (m.b(cr + 9) === m.sw(TARGET_ISLAND)) continue;
      if (cx === x && cy === y) continue;
      const d = distance(m.sb(ENEMY_CENTRE_X) - cx, m.sb(ENEMY_CENTRE_Y) - cy);
      if (best >= d) continue;
      if (fuel(m, p) - 5 <= distance(x - cx, y - cy)) continue;
      if (enemyAdjacent(m, idx, 2, x, y)) continue;
      best = d;
      chosen = c;
    }
  }

  if (best !== 5000 && chosen >= 1 && chosen <= 45) {
    flyToCity(m, p, chosen);
    return;
  }
  if (nearestOwn !== 5000) {
    flyToCity(m, p, nearestCity);
    return;
  }
  setReply(m, 0, 0);
  setState(m, p, 1);
  m.setW(MOVE_STEP, movesPerDay(m, pType(m, p), pStrength(m, p)));
}

/**
 * CODE 6 + 0x1D70: an awake computer Bomber, `idx`.
 *
 * Next to a player 1 city: it strikes it if the blast would spare the side's own (then
 * waking the side's other Bombers, unless one of its cities is in range of the blast);
 * with its own in range it steps for the city instead, which the checks after cancel.
 * Otherwise, in one of the side's cities, on its last move next to an enemy it gets away,
 * and else chooses where to fly (bomberTarget). Elsewhere, next to an enemy it takes on,
 * on its last move or when the enemy is a Carrier or Battleship, it strikes when the blast
 * would spare the side's own (waking the enemy piece's state, as the original does), and
 * gets away otherwise; next to another enemy on its last move it gets away; otherwise it
 * chooses where to fly.
 */
export function bomberMove(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  const enemy = () => m.sb(OPPONENT_OF + pOwner(m, p));

  if (terrainNear(m, x, y, ENEMY_CITY)) {
    let [fx, fy] = foundCell(m);
    if (distance(x - fx, y - fy) === 1) {
      [fx, fy] = foundCell(m);
      if (findPieceNear(m, false, OWN_EXPOSED, 2, pRadius(m, p), fy, fx) === 0) {
        setState(m, p, 1);
        setReply(m, fx - x, fy - y);
      } else {
        cityStep(m, p, ENEMY_CITY);
      }
    }
    [fx, fy] = foundCell(m);
    if (findPieceNear(m, false, OWN_EXPOSED, 2, pRadius(m, p), fy, fx) === 0) {
      [fx, fy] = foundCell(m);
      if (!terrainWithin(m, fx, fy, OWN_CITY, pRadius(m, p))) {
        wakeOtherBombers(m, idx);
        return;
      }
    }
    setReply(m, 0, 0);
  }

  if (terrainAt(m, x, y) === CITY_P2) {
    if (enemyAdjacent(m, idx, 2, x, y) && movesLeft(m, p) === 1) {
      evade(m, p, enemy(), 0, 4, true);
      return;
    }
    bomberTarget(m, p, idx);
    return;
  }

  if (!enemyAdjacent(m, idx, 2, x, y)) {
    bomberTarget(m, p, idx);
    return;
  }
  const e = pieceAt(foundEnemy(m));
  if (takesOn(m, e, p) && (movesLeft(m, p) === 1 || inSet(0x50, pType(m, e)))) {
    const ex = pX(m, e), ey = pY(m, e);
    if (!terrainWithin(m, ex, ey, OWN_CITY, pRadius(m, p)) &&
        findPieceNear(m, false, OWN_EXPOSED, 2, pRadius(m, p), ey, ex) === 0) {
      setState(m, e, 1);
      setReply(m, ex - x, ey - y);
    } else {
      evade(m, p, enemy(), 0, 1, true);
    }
    return;
  }
  if (movesLeft(m, p) === 1) evade(m, p, enemy(), closedTerrain(m, 2, pType(m, p)), 1, false);
  else bomberTarget(m, p, idx);
}
