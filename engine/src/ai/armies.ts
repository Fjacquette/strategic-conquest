/**
 * How the computer opponent moves an awake Army (CODE 7 + 0x0A4A and the routines it
 * calls). The chosen step, when there is one, is left in REPLY_DX / REPLY_DY; otherwise the
 * Army gets go-to orders, falls asleep, or stays put.
 */
import { Mem } from "../mem.ts";
import { ARMY, CITY_COUNT, CITY_P2, FIGHTER, OPPONENT_OF, PIECE_COUNT, TRANSPORT } from "../globals.ts";
import { topPieceAt } from "../hash.ts";
import { distance, explored, inSet, onMap, terrainAt, terrainNear } from "../map.ts";
import { ISLAND_ADJACENT, ISLAND_CENTERS, ISLAND_COUNT, islandAt } from "../mapgen.ts";
import { setDestination } from "../moveops.ts";
import { rotate, type Dir } from "../path.ts";
import {
  pCargo, pieceAt, pOwner, pSpotted, pState, pType, pX, pY, setState, setType,
} from "../piece.ts";
import { enemyAdjacent, foundEnemy } from "../query.ts";
import { qdRandom, randomBool } from "../random.ts";
import { cityRec } from "../units.ts";
import { CITY_SENT, CITY_SENT_DISTANCE, islandRec } from "./data.ts";
import {
  attackStep, cityStep, clampToMap, clearLine, closedTerrain, evade, foundCell, islandBeside, lineClearTo,
  noRoute, pathStep, setReply, takesOn,
} from "./moves.ts";
import { TARGET_ISLAND } from "./production.ts";
import { pieceIsland } from "./transports.ts";

const centreX = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i + 1);
const centreY = (m: Mem, i: number) => m.sb(ISLAND_CENTERS + 2 * i);
const standing = (m: Mem, r: number) => m.b(r + 14) & 3;
/** Cities on an island record that are the enemy's or neutral, as player 2 has seen them. */
const citiesToTake = (m: Mem, r: number) => m.sb(r + 13) + ((m.b(r + 14) >> 2) & 0x3f);

/** Neutral or player 1 cities (terrain 1, 2). */
const CITIES_TO_TAKE = 0x06;
/** Land or player 2's cities (terrain 3, 4). */
const LANDING = 0x18;
/** Water. */
const WATER_SET = 0x01;

/**
 * CODE 7 + 0x0A4A: an awake computer Army, `idx`.
 *
 * At sea (aboard a ship) it looks for somewhere to land if the ship is a Transport, and
 * otherwise falls asleep. On land it is woken if its destination is one of player 2's
 * cities, if its island has cities to take, or if a Transport is loading for the island.
 * Then the first of these that applies decides:
 *  - a neutral or player 1 city next to it: step in;
 *  - cities to take on the island: unless an enemy is next to it (or, with one next to it,
 *    on a coin toss when the island has enemy cities), head for the nearest city to take;
 *  - an enemy next to it: attack it if it is one an Army takes on, otherwise get away;
 *  - enemy Armies seen on the island: go after one in sight, or explore;
 *  - an island of no standing or the enemy's, or one not fully explored that no Transport
 *    is loading for: explore it;
 *  - the nearest adjacent island that is the enemy's, or of no standing with at most eight
 *    of the side's cities and Armies: go there;
 *  - a Transport loading for the island: step aboard one next to it, or go to the nearest
 *    one beside the island (see the note there);
 *  - otherwise head for the target island, and sleep if there is no way there.
 */
export function armyMove(m: Mem, idx: number): void {
  const p = pieceAt(idx);
  const x = pX(m, p), y = pY(m, p);
  const island = islandAt(m, x, y);
  if (island === 0) {
    const t = topPieceAt(m, x, y);
    const shipIsland = pieceIsland(m, t, m.bytes(pieceAt(t), 14));
    if (pType(m, pieceAt(t)) === TRANSPORT) armyAboard(m, p, shipIsland);
    else setState(m, p, 2);
    return;
  }
  const r = islandRec(island);
  const goingHome = inSet(1 << CITY_P2, terrainAt(m, m.sb(p + 3), m.sb(p + 2)));
  if (goingHome || citiesToTake(m, r) !== 0 || m.sb(r + 18) !== 0) setState(m, p, 1);
  if (pState(m, p) === 0) return;

  if (terrainNear(m, x, y, CITIES_TO_TAKE)) {
    cityStep(m, p, CITIES_TO_TAKE);
    return;
  }
  if (citiesToTake(m, r) !== 0) {
    let go = !enemyAdjacent(m, idx, 2, x, y);
    if (!go) go = (qdRandom(m) & 1) !== 0 && m.sb(r + 13) !== 0;
    if (go) {
      setDestination(m, p, x, y);
      if (sendToCity(m, p, island)) return;
    }
  }
  if (enemyAdjacent(m, idx, 2, x, y)) {
    if (takesOn(m, pieceAt(foundEnemy(m)), p)) attackStep(m, p, foundEnemy(m));
    else evade(m, p, m.sb(OPPONENT_OF + pOwner(m, p)), WATER_SET, 2, false);
    return;
  }
  if (m.sw(r + 2) !== 0) {
    huntArmies(m, p, island, 1 << ARMY);
    return;
  }
  if (inSet(0x09, standing(m, r)) || ((m.b(r + 15) & 0x40) === 0 && m.sb(r + 18) === 0)) {
    if (exploreIsland(m, p, island)) return;
  }

  let best = 0, bestDist = 5000;
  const islands = m.sb(ISLAND_COUNT);
  for (let i = 1; i <= islands; i++) {
    if (i === island) continue;
    if (((m.b(ISLAND_ADJACENT + 2 * island + (i >> 3)) >> (i & 7)) & 1) === 0) continue;
    const ri = islandRec(i);
    const s = standing(m, ri);
    if (s === 3 || (s === 0 && m.sb(ri + 12) + m.sw(ri) <= 8)) {
      const d = distance(x - centreX(m, i), y - centreY(m, i));
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
  }
  if (bestDist !== 5000) {
    setDestination(m, p, centreX(m, best), centreY(m, best));
    return;
  }

  if (m.sb(r + 18) !== 0) {
    // Transports come first in the piece table; the loop runs through them.
    let nearest = 5000;
    for (let i = 1; pType(m, pieceAt(i)) === TRANSPORT; i++) {
      const t = pieceAt(i);
      if (pState(m, t) !== 3 || pOwner(m, t) !== 2 || pCargo(m, t) >= 6) continue;
      const d = distance(x - pX(m, t), y - pY(m, t));
      if (d === 1) {
        setReply(m, pX(m, t) - x, pY(m, t) - y);
        setState(m, p, 1);
        return;
      }
      if (islandBeside(m, pX(m, t), pY(m, t), island) && d < nearest) {
        setDestination(m, p, pX(m, t), pY(m, t));
        nearest = d;
      }
    }
    if (nearest !== 5000) {
      // The step is planned as if the Army could cross water; if it leads onto water, the
      // Army heads for the shore instead.
      setType(m, p, FIGHTER);
      const d = pathStep(m, p);
      setType(m, p, ARMY);
      setReply(m, d.dx, d.dy);
      if (!inSet(WATER_SET, terrainAt(m, x + d.dx, y + d.dy))) return;
      // Where the original means the chosen Transport it uses piece 1 (the first
      // Transport in the table) and island 1's centre: quirk Q16.
      const chosen = 1;
      const ship = pieceAt(chosen);
      if (islandBeside(m, pX(m, ship), pY(m, ship), island)) {
        const [fx, fy] = foundCell(m);
        setDestination(m, p, fx, fy);
      } else {
        setDestination(m, p, centreX(m, chosen), centreY(m, chosen));
      }
      return;
    }
  }

  const target = m.sw(TARGET_ISLAND);
  if (target === 0) return;
  setDestination(m, p, centreX(m, target), centreY(m, target));
  if (terrainNear(m, pX(m, p), pY(m, p), WATER_SET) && noRoute(m, p)) setState(m, p, 2);
}

/**
 * CODE 7 + 0x0850: an awake computer Army `p` aboard a Transport beside `island`. Unless
 * asleep, it steps into a neutral or player 1 city next to it; with no land or player 2
 * city next to it, it falls asleep. Otherwise, from a random direction turning a random
 * way, each of the eight squares on `island` decides by the island's standing: of no
 * standing, go there if the side has fewer than five Armies on it (and sleep otherwise),
 * looking on; cleared, sleep; unknown or the enemy's, go there.
 */
export function armyAboard(m: Mem, p: number, island: number): void {
  if (pState(m, p) === 2) return;
  const x = pX(m, p), y = pY(m, p);
  if (terrainNear(m, x, y, CITIES_TO_TAKE)) {
    cityStep(m, p, CITIES_TO_TAKE);
    return;
  }
  if (!terrainNear(m, x, y, LANDING)) {
    setState(m, p, 2);
    return;
  }
  const d: Dir = { dx: qdRandom(m) % 2, dy: qdRandom(m) % 2 };
  const turn = randomBool(m) ? 1 : 0;
  for (let k = 1; k <= 8; k++) {
    rotate(turn, d);
    const nx = x + d.dx, ny = y + d.dy;
    if (islandAt(m, nx, ny) !== island) continue;
    const r = islandRec(island);
    switch (standing(m, r)) {
      case 0:
        if (m.sw(r) < 5) setDestination(m, p, nx, ny);
        else setState(m, p, 2);
        break;
      case 1:
        setState(m, p, 2);
        return;
      default:
        setDestination(m, p, nx, ny);
        return;
    }
  }
}

/**
 * CODE 6 + 0x630C: send Army `p` to the nearest city on `island` that player 2 has
 * explored and does not own, among those fewer than three Armies have been sent to or
 * from which this one is nearer than any sent so far; the city's count and distance are
 * updated. Without such a city the Army's destination is its own square. Returns whether
 * a city was found.
 */
export function sendToCity(m: Mem, p: number, island: number): boolean {
  let best = 5000, bestCity = 0;
  const n = m.sb(CITY_COUNT);
  for (let c = 1; c <= n; c++) {
    const cr = cityRec(c);
    if (m.b(cr + 9) !== island) continue;
    if (!explored(m, 2, m.sb(cr + 7), m.sb(cr + 6))) continue;
    if (m.sb(cr + 4) === 2) continue;
    const d = distance(m.sb(cr + 7) - pX(m, p), m.sb(cr + 6) - pY(m, p));
    if (m.sw(CITY_SENT + 2 * c) < 3 || d < m.sw(CITY_SENT_DISTANCE + 2 * c)) {
      if (d < best) {
        best = d;
        bestCity = c;
      }
    }
  }
  if (best === 5000) {
    setDestination(m, p, pX(m, p), pY(m, p));
    return false;
  }
  const cr = cityRec(bestCity);
  m.setW(CITY_SENT + 2 * bestCity, m.sw(CITY_SENT + 2 * bestCity) + 1);
  if (best < m.sw(CITY_SENT_DISTANCE + 2 * bestCity)) m.setW(CITY_SENT_DISTANCE + 2 * bestCity, best);
  setDestination(m, p, m.sb(cr + 7), m.sb(cr + 6));
  return true;
}

/**
 * CODE 6 + 0x6462: send Army `p` after the first spotted player 1 piece with a type in
 * `typeSet` on `island` that it can see past water and player 2's cities; with none,
 * explore the island.
 */
export function huntArmies(m: Mem, p: number, island: number, typeSet: number): void {
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    const qx = pX(m, q), qy = pY(m, q);
    if (islandAt(m, qx, qy) !== island) continue;
    if (pOwner(m, q) !== 1) continue;
    if (pSpotted(m, q) === 0) continue;
    if (!inSet(typeSet, pType(m, q), 15)) continue;
    if (clearLine(m, qx, qy, pX(m, p), pY(m, p), 0x11)) {
      setDestination(m, p, qx, qy);
      return;
    }
  }
  exploreIsland(m, p, island);
}

/**
 * CODE 7 + 0x0348: send Army `p` to explore `island`. In order:
 *  - the first of the eight squares round it (from a random direction, turning a random
 *    way) that is on the map, open to an Army and next to a square player 2 has not
 *    explored;
 *  - the first unexplored land square, on the rings 2 to 5 squares out, from which the
 *    island's centre is in a straight line over land (the rings are centred on the
 *    Army's x for both coordinates: quirk Q17);
 *  - the island's scan: rows of the island's centre column are taken in turn downwards
 *    from its top (the row kept in the island record, back to the top past water or the
 *    map's foot); from the centre the row is walked to its end (left on even turns, right
 *    on odd ones), then back over explored land, to the first unexplored square (or
 *    while the row has none and the scan has not wrapped);
 *  - with every square explored, a random square two away (kept on the map), and the
 *    answer is no.
 * Returns whether a square to explore was found.
 */
export function exploreIsland(m: Mem, p: number, island: number): boolean {
  const px = pX(m, p), py = pY(m, p);
  const d: Dir = { dx: qdRandom(m) % 2, dy: qdRandom(m) % 2 };
  const turn = randomBool(m) ? 1 : 0;
  for (let k = 1; k <= 8; k++) {
    rotate(turn, d);
    const nx = px + d.dx, ny = py + d.dy;
    if (!onMap(nx, ny)) continue;
    if (inSet(closedTerrain(m, 2, ARMY), terrainAt(m, nx, ny))) continue;
    if (unexploredNear(m, nx, ny)) {
      setDestination(m, p, nx, ny);
      return true;
    }
  }
  for (let ring = 2; ring <= 5; ring++) {
    const found = ringSearch(m, ring, ring, px, px, island);
    if (found) {
      setDestination(m, p, found[0], found[1]);
      return true;
    }
  }

  const r = islandRec(island);
  const cx = centreX(m, island);
  const top = () => m.sb(r + 17);
  const row = () => m.sb(r + 16);
  const land = (x: number, y: number) => terrainAt(m, x, y) !== 0;
  const seen = (x: number, y: number) => explored(m, 2, x, y);
  let x: number, y: number;
  do {
    m.setB(r + 16, row() + 1);
    if (!land(cx, row() + top()) || top() + row() >= 59) m.setB(r + 16, 0);
    y = top() + row();
    x = cx;
    if (row() % 2 === 0) {
      while (land(x, y) && onMap(x, y)) x--;
      x++;
      while (seen(x, y) && land(x, y) && onMap(x, y)) x++;
    } else {
      while (land(x, y) && onMap(x, y)) x++;
      x--;
      while (seen(x, y) && land(x, y) && onMap(x, y)) x--;
    }
  } while (seen(x, y) && land(cx, top() + row()) && row() !== 0);

  if (!seen(x, y)) {
    if (terrainAt(m, x, y) === CITY_P2) x++;
    setDestination(m, p, x, y);
    return true;
  }
  [x, y] = clampToMap(px + (qdRandom(m) % 2) * 2, py + (qdRandom(m) % 2) * 2);
  setDestination(m, p, x, y);
  return false;
}

/** CODE 7 + 0x02EE: a square of the 3x3 block centred on (x, y) player 2 has not explored. */
function unexploredNear(m: Mem, x: number, y: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!explored(m, 2, x + dx, y + dy)) return true;
    }
  }
  return false;
}

/**
 * CODE 7 + 0x01EE: the first square on the rectangle `hw` across and `hh` up and down
 * from (cx, cy) (top side, bottom side, right side, left side) that is on the map,
 * unexplored by player 2, not water, and in a straight line over land with the centre of
 * `island` (CODE 7 + 0x011E for each square).
 */
function ringSearch(m: Mem, hw: number, hh: number, cx: number, cy: number, island: number): [number, number] | null {
  const probe = (x: number, y: number): boolean =>
    onMap(x, y) && !explored(m, 2, x, y) && terrainAt(m, x, y) !== 0 &&
    lineClearTo(m, x, y, centreX(m, island), centreY(m, island), WATER_SET);
  for (let k = -hw; k <= hw; k++) if (probe(k + cx, cy - hh)) return [k + cx, cy - hh];
  for (let k = -hw; k <= hw; k++) if (probe(k + cx, cy + hh)) return [k + cx, cy + hh];
  for (let k = -hh; k <= hh; k++) if (probe(hw + cx, cy + k)) return [hw + cx, cy + k];
  for (let k = -hh; k <= hh; k++) if (probe(cx - hw, cy + k)) return [cx - hw, cy + k];
  return null;
}
