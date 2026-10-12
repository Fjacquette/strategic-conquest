/**
 * How the computer opponent moves an awake Fighter (CODE 6 + 0x2278 and the routines it
 * calls). The chosen step, when there is one, is left in REPLY_DX / REPLY_DY; otherwise the
 * Fighter gets go-to orders.
 */
import { Mem } from "../mem.ts";
import {
  BOMBER, CITY_COUNT, CITY_P2, FIGHTER, MOVE_STEP, OPPONENT_OF, OWN_CITY_CODE, PIECE_COUNT, REMOVED, TRANSPORT,
} from "../globals.ts";
import { topPieceAt } from "../hash.ts";
import { distance, explored, inSet, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_CENTERS, islandAt } from "../mapgen.ts";
import { setDestination } from "../moveops.ts";
import { rotate, type Dir } from "../path.ts";
import {
  pCargo, pieceAt, pOrders, pOwner, pSpotted, pState, pStrength, pType, pX, pY, setState, setType,
} from "../piece.ts";
import { enemyAdjacent, foundEnemy, topIs } from "../query.ts";
import { qdRandom } from "../random.ts";
import { findPieceNear } from "../turn.ts";
import { cityAt, cityRec, movesPerDay } from "../units.ts";
import { islandRec } from "./data.ts";
import { attackStep, cityStep, closedTerrain, evade, pathStep, setReply, takesOn } from "./moves.ts";
import { BASE_ISLAND, ENEMY_CENTRE_Y } from "./production.ts";

const standing = (m: Mem, island: number) => m.b(islandRec(island) + 14) & 3;
const fuel = (m: Mem, p: number) => pCargo(m, p);

/** Water, land and player 2's cities (terrain 0, 3, 4): squares a Fighter may look over. */
const OPEN_GROUND = 0x19;

/** CODE 6 + 0x013A: the moves piece `p` has left this turn, counting the current one. */
export function movesLeft(m: Mem, p: number): number {
  return movesPerDay(m, pType(m, p), pStrength(m, p)) - m.sw(MOVE_STEP) + 1;
}

/**
 * CODE 6 + 0x0160: the nearest of player 2's cities that it has explored to piece `p`
 * (the last of equally near ones) and its distance; with none, a random city and 5000.
 */
export function nearestOwnCity(m: Mem, p: number): [number, number] {
  const n = m.sb(CITY_COUNT);
  let city = (Math.abs(qdRandom(m)) % n) + 1;
  let dist = 5000;
  for (let c = 1; c <= n; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) !== 2) continue;
    const d = distance(m.sb(cr + 7) - pX(m, p), m.sb(cr + 6) - pY(m, p));
    if (d > dist) continue;
    if (!explored(m, 2, m.sb(cr + 7), m.sb(cr + 6))) continue;
    dist = d;
    city = c;
  }
  return [city, dist];
}

/**
 * CODE 6 + 0x027E: a city of player 2 for Fighter `p` to fly to, looking through the cities
 * from a random one: the nearest within its fuel less two on an island not fully explored
 * (not the city it is in); failing that, when there is a base island, the last city (in the
 * same order) the Fighter can reach with a move to spare that is nearer than it to the base
 * island's centre, which it is sent to. Returns the city, or 0.
 */
export function fighterBase(m: Mem, p: number): number {
  const n = m.sb(CITY_COUNT);
  let start = Math.abs(qdRandom(m)) % n;
  let best = 5000, city = 0;
  for (let k = 1; k <= n; k++) {
    const c = ((start + k) % n) + 1;
    const cr = cityRec(c);
    const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
    const d = distance(cx - pX(m, p), cy - pY(m, p));
    if (m.sb(cr + 4) !== 2) continue;
    if (fuel(m, p) - 2 < d) continue;
    if (m.b(islandRec(islandAt(m, cx, cy)) + 15) & 0x40) continue;
    if (d >= best || d === 0) continue;
    best = d;
    city = c;
  }
  if (best !== 5000) return city;

  best = 5000;
  start = Math.abs(qdRandom(m)) % n;
  const base = m.sw(BASE_ISLAND);
  const centre = base !== 0 ? ISLAND_CENTERS + 2 * base : ENEMY_CENTRE_Y;
  const tx = m.sb(centre + 1), ty = m.sb(centre);
  const fromHere = distance(tx - pX(m, p), ty - pY(m, p));
  for (let k = 1; k <= n; k++) {
    const c = ((start + k) % n) + 1;
    const cr = cityRec(c);
    const cx = m.sb(cr + 7), cy = m.sb(cr + 6);
    if (m.sb(cr + 4) !== 2) continue;
    if (cx === pX(m, p) && cy === pY(m, p)) continue;
    if (fuel(m, p) - 1 <= distance(pX(m, p) - cx, pY(m, p) - cy)) continue;
    const d = distance(tx - cx, ty - cy);
    if (d >= fromHere) continue;
    best = d;
    city = c;
  }
  if (best !== 5000 && base !== 0) {
    const cr = cityRec(city);
    setDestination(m, p, m.sb(cr + 7), m.sb(cr + 6));
    return city;
  }
  return 0;
}

/**
 * CODE 6 + 0x054E: send piece `p` to look round within `r` squares: squares are taken
 * from one at a random offset (up to `r` each way), wrapping from one side of the square
 * to the other (and kept on the map), and the first one of `terrainSet` that player 2 has
 * not explored is chosen; failing that, the last square taken.
 */
export function exploreAround(m: Mem, p: number, terrainSet: number, r: number): void {
  const cx = pX(m, p) + (qdRandom(m) % (r + 1));
  const cy = pY(m, p) + (qdRandom(m) % (r + 1));
  const x0 = Math.max(pX(m, p) - r, 2), x1 = Math.min(pX(m, p) + r, 78);
  const y0 = Math.max(pY(m, p) - r, 2), y1 = Math.min(pY(m, p) + r, 58);
  let x = 0, y = 0;
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      x = i + cx;
      if (x < x0) x = Math.min(x + 2 * r, 78);
      else if (x > x1) x = Math.max(x - 2 * r, 2);
      y = j + cy;
      if (y < y0) y = Math.min(y + 2 * r, 58);
      else if (y > y1) y = Math.max(y - 2 * r, 2);
      if (!inSet(terrainSet, terrainAt(m, x, y))) continue;
      if (explored(m, 2, x, y)) continue;
      setDestination(m, p, x, y);
      return;
    }
  }
  setDestination(m, p, x, y);
}

/**
 * CODE 6 + 0x077E: make sure aircraft `p` is not blocked on its way. The path finder's
 * next step (planned as for a Fighter) is kept when nothing is on that square, when a
 * Fighter would meet one of player 2's pieces there, or when it is one of the side's
 * cities. Otherwise (the original retests the same square twice, to no effect, before)
 * the step is turned in the piece's turning direction until it reaches an empty square,
 * one of the side's own pieces, or a piece it takes on, up to eight tries; the piece then
 * gets go-to orders one step that way (except when the first square was empty).
 */
export function fighterStep(m: Mem, p: number): void {
  const type = pType(m, p);
  setType(m, p, FIGHTER);
  const d = pathStep(m, p);
  setType(m, p, type);
  const x = pX(m, p), y = pY(m, p);
  const fighterBlockedByOwn = (top: number) => pType(m, p) === FIGHTER && pOwner(m, pieceAt(top)) === 2;
  let top = topPieceAt(m, x + d.dx, y + d.dy);
  if (top === 0) return;
  if (fighterBlockedByOwn(top)) return;
  if (terrainAt(m, x + d.dx, y + d.dy) === m.sb(OWN_CITY_CODE + pOwner(m, p))) return;
  const closed = closedTerrain(m, 2, pType(m, p));
  for (const turn of [0, 1]) {
    const turned: Dir = { dx: d.dx, dy: d.dy };
    rotate(turn, turned);
    if (inSet(closed, terrainAt(m, x + d.dx, y + d.dy))) continue;
    top = topPieceAt(m, x + d.dx, y + d.dy);
    if (fighterBlockedByOwn(top)) return;
    if (top !== 0) continue;
    setDestination(m, p, x + turned.dx, y + turned.dy);
    return;
  }
  for (let k = 1; k <= 8; k++) {
    top = topPieceAt(m, x + d.dx, y + d.dy);
    if (top === 0) {
      if (k !== 1) setDestination(m, p, x + d.dx, y + d.dy);
      return;
    }
    if (pOwner(m, pieceAt(top)) === pOwner(m, p) || takesOn(m, pieceAt(top), p)) {
      setDestination(m, p, x + d.dx, y + d.dy);
      return;
    }
    rotate(pOrders(m, p), d);
  }
}

/**
 * CODE 6 + 0x0BB2: send Fighter `p` looking for something to do: look round within nine
 * squares (from a player 2 city on an island of no standing, only that). If that square
 * has been explored: on a Carrier, look round within its moves left halved (at most
 * seven); then fly to the nearest of the side's Carriers it can reach (with its fuel less
 * four moves, or none) when it has the fuel to keep with it, or can reach it with a day's
 * flying to spare, unless the Fighter is in one of the side's cities; otherwise to a city
 * fighterBase() chooses. (The original also works out whether the target island has
 * enemy cities and passes that to the look round, which does not use it.)
 */
export function fighterSearch(m: Mem, p: number): void {
  const x = pX(m, p), y = pY(m, p);
  if (terrainAt(m, x, y) === CITY_P2 && standing(m, islandAt(m, x, y)) === 0) {
    exploreAround(m, p, OPEN_GROUND, 9);
    return;
  }
  exploreAround(m, p, OPEN_GROUND, 9);
  if (!explored(m, 2, m.sb(p + 3), m.sb(p + 2))) return;
  if (topIs(m, x, y, 1 << 4, 1 << 2)) {
    const left = movesLeft(m, p);
    exploreAround(m, p, OPEN_GROUND, Math.trunc(left / 2) < 7 ? Math.trunc(left / 2) : 7);
  }
  let reach = movesLeft(m, p);
  if (reach > fuel(m, p) - 4) reach = fuel(m, p) - 4;
  if (reach <= 0) reach = 0;
  const t = findPieceNear(m, false, 1 << 4, 2, reach, y, x);
  if (t !== 0) {
    const c = pieceAt(t);
    const d = distance(x - pX(m, c), y - pY(m, c));
    const keepsUp = d <= fuel(m, p) && fuel(m, p) <= movesLeft(m, c);
    if ((keepsUp || d <= fuel(m, p) - movesPerDay(m, pType(m, c), pStrength(m, c))) && terrainAt(m, x, y) !== CITY_P2) {
      setDestination(m, p, pX(m, c), pY(m, c));
      return;
    }
  }
  const city = fighterBase(m, p);
  if (city !== 0) {
    const cr = cityRec(city);
    setDestination(m, p, m.sb(cr + 7), m.sb(cr + 6));
  }
}

/**
 * CODE 6 + 0x0F50: Fighter `p` looks for somewhere to go with the fuel it has: a spotted
 * player 1 Transport or Bomber within its fuel less two; one of the side's cities next to
 * it (step in); one of the side's Carriers within its fuel, if it has six to spare or
 * can reach it with a day's flying (unless the Carrier is in a player 2 city); the nearest
 * explored player 2 city within its fuel. With nowhere to go its moves for the day end
 * where it is.
 */
export function fighterReturn(m: Mem, p: number): void {
  const x = pX(m, p), y = pY(m, p);
  let t = findPieceNear(m, true, 0xa0, 1, fuel(m, p) - 2, y, x);
  if (t !== 0) {
    setDestination(m, p, pX(m, pieceAt(t)), pY(m, pieceAt(t)));
    return;
  }
  if (terrainNear(m, x, y, 1 << CITY_P2)) {
    cityStep(m, p, 1 << CITY_P2);
    return;
  }
  const [city, cityDist] = nearestOwnCity(m, p);
  t = findPieceNear(m, false, 1 << 4, 2, fuel(m, p), y, x);
  if (t !== 0) {
    const c = pieceAt(t);
    const d = distance(x - pX(m, c), y - pY(m, c));
    const ok = fuel(m, p) - 6 >= d || (fuel(m, p) >= d && d >= movesPerDay(m, pType(m, p), pStrength(m, p)));
    if (ok && terrainAt(m, pX(m, c), pY(m, c)) !== CITY_P2) {
      setDestination(m, p, pX(m, c), pY(m, c));
      return;
    }
  }
  if (fuel(m, p) >= cityDist) {
    const cr = cityRec(city);
    setDestination(m, p, m.sb(cr + 7), m.sb(cr + 6));
    return;
  }
  setReply(m, 0, 0);
  setState(m, p, 1);
  m.setW(MOVE_STEP, movesPerDay(m, pType(m, p), pStrength(m, p)));
}

/**
 * CODE 6 + 0x11CC: a spotted player 1 piece for Fighter `p` (`idx`) to attack, among those
 * on squares player 2 has explored: a Bomber it can reach this turn with fuel to spare,
 * nearer than any other such Bomber, is preferred; otherwise the nearest piece whose top
 * piece the Fighter takes on, from which it could still reach one of its cities, and that
 * it can reach this turn (or is a Transport). The Fighter is sent there. Returns whether
 * a target was found.
 */
export function fighterTarget(m: Mem, p: number, idx: number): boolean {
  let best = 5000, bestBomber = 5000, target = 0, bomber = 0;
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    if (pOwner(m, q) !== 1) continue;
    if (pType(m, q) === REMOVED) continue;
    if (i === idx) continue;
    if (pSpotted(m, q) === 0) continue;
    if (!explored(m, 2, pX(m, q), pY(m, q))) continue;
    const top = topPieceAt(m, pX(m, q), pY(m, q));
    const d = distance(pX(m, q) - pX(m, p), pY(m, q) - pY(m, p));
    if (d < best && takesOn(m, pieceAt(top), p)) {
      const [, home] = nearestOwnCity(m, q);
      if (fuel(m, p) - d - 1 >= home && (d <= movesLeft(m, p) || pType(m, q) === TRANSPORT)) {
        target = i;
        best = d;
      }
    }
    if (d < bestBomber && pType(m, q) === BOMBER && movesLeft(m, p) >= best && fuel(m, p) > bestBomber) {
      bestBomber = d;
      bomber = i;
    }
  }
  if (bestBomber !== 5000) {
    setDestination(m, p, pX(m, pieceAt(bomber)), pY(m, pieceAt(bomber)));
    return true;
  }
  if (best !== 5000) {
    setDestination(m, p, pX(m, pieceAt(target)), pY(m, pieceAt(target)));
    return true;
  }
  return false;
}

/**
 * CODE 6 + 0x2278: an awake computer Fighter, `idx`.
 *
 * In one of the side's cities: attack an enemy next to it that it takes on; else, with no
 * target to attack, from a city on an enemy island it searches; on its last move it gets
 * away from enemies; otherwise it searches. With a target, it goes for it (avoiding
 * blockages). Elsewhere: attack an enemy next to it that it takes on; with ten or less
 * fuel, look for a target or head back; with more, go for a target if there is one, else
 * on its last move next to an enemy get away, else look round (with the fuel over 13) or
 * head back. Every move that is not an attack or an escape is checked for blockages
 * (fighterStep).
 */
export function fighterMove(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  if (pState(m, p) !== 1) return;
  const x = pX(m, p), y = pY(m, p);
  const enemy = m.sb(OPPONENT_OF + pOwner(m, p));
  const getAway = () => {
    const d = evade(m, p, enemy, closedTerrain(m, 2, pType(m, p)), 1, false);
    setReply(m, d.dx, d.dy);
  };

  if (terrainAt(m, x, y) === CITY_P2) {
    let attacks = false;
    if (enemyAdjacent(m, idx, 2, x, y)) {
      const e = pieceAt(foundEnemy(m));
      attacks = takesOn(m, pieceAt(topPieceAt(m, pX(m, e), pY(m, e))), p);
    }
    if (attacks) {
      attackStep(m, p, foundEnemy(m));
      return;
    }
    const idle = !fighterTarget(m, p, idx);
    if (idle && terrainAt(m, x, y) === CITY_P2) {
      const city = cityAt(m, x, y);
      if (city !== 0 && standing(m, m.b(cityRec(city) + 9)) === 3) {
        fighterSearch(m, p);
        fighterStep(m, p);
        return;
      }
    }
    if (!idle) {
      fighterStep(m, p);
      return;
    }
    if (movesLeft(m, p) === 1) {
      getAway();
    } else {
      fighterSearch(m, p);
      fighterStep(m, p);
    }
    return;
  }

  const adjacent = enemyAdjacent(m, idx, 2, x, y);
  if (adjacent && takesOn(m, pieceAt(foundEnemy(m)), p)) {
    attackStep(m, p, foundEnemy(m));
    return;
  }
  if (fuel(m, p) <= 10) {
    if (!fighterTarget(m, p, idx)) fighterReturn(m, p);
    fighterStep(m, p);
    return;
  }
  if (fighterTarget(m, p, idx)) {
    fighterStep(m, p);
    return;
  }
  if (movesLeft(m, p) === 1 && adjacent) {
    getAway();
    return;
  }
  if (fuel(m, p) > 13) exploreAround(m, p, OPEN_GROUND, fuel(m, p) - 13);
  else fighterReturn(m, p);
  fighterStep(m, p);
}
