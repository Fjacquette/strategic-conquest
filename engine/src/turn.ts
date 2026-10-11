/**
 * Per-type movers and the player's turn (Mover segment, CODE 5).
 */
import { Mem } from "./mem.ts";
import {
  ANY_DEFERRED, ARMY, BATTLESHIP, BOMBER, CARRIER, CITY_COUNT, CITY_NEUTRAL, DAY, DESTROYER, FIGHTER,
  GAME_MODE, LOCAL_PLAYER, MOVES_LEFT, MOVE_STEP, PIECE_DEFERRED, PIECE_DONE, REGION_START, REMOVED,
  STEP_FLAG_1A95, SUBMARINE, TRANSPORT,
} from "./globals.ts";
import { topPieceAt } from "./hash.ts";
import { type Host, messageA, messageB, Reply, Request, RequestCode } from "./host.ts";
import { distance, explored, inSet, isComputer, terrainAt, terrainNear } from "./map.ts";
import { enemyAdjacent, foundEnemy, pieceCount, topIs } from "./query.ts";
import { setDestination, wakeAllAt } from "./moveops.ts";
import { type Dir, rotate } from "./path.ts";
import { bomberBlast } from "./battle.ts";
import { compactPieces, killPiece, killTypesAt } from "./table.ts";
import { buildPiece, cityAt, cityProductionTick, cityRec, movesPerDay, setCityOwner, typeStrId } from "./units.ts";
import { explore } from "./explore.ts";
import { qdRandom } from "./random.ts";
import { enemyCity, opponent, orderStep, ownCity, stepExecutor } from "./mover.ts";
import {
  pAttacks, pCargo, pieceAt, pMoved, pOwner, pRadius, pSpotted, pState, pStep, pStrength, pType, pX, pY,
  setCargo, setMoved, setSpotted, setState, setStep, setStrength,
} from "./piece.ts";

const SHIPS = 0x7c;
const FAST_MODES = 0x06;
const NO_TERRAIN = 0x0000; // aircraft may cross any terrain
const ARMY_FORBIDDEN = 0x0001; // water
const SHIP_FORBIDDEN = 0x000a; // neutral city, land (plus the enemy's cities)


/** CODE 5 + 0x23C4: whether an Army's attempt to capture a city succeeds (QuickDraw Random). */
export function dayRandomCheck(m: Mem): boolean {
  const day = m.sw(DAY);
  if (day < 30) return true;
  const d = day < 60 ? Math.trunc((day - 30) / 6) + 1 : 6;
  const r = (qdRandom(m) & 0x7fff) % 16;
  return d <= r;
}

/** CODE 5 + 0x40A6 */
function repairStep(m: Mem, p: number, max: number): void {
  if (pStrength(m, p) < max) {
    setStrength(m, p, pStrength(m, p) + 1);
    if (pState(m, p) === 2 && pStrength(m, p) === max) setState(m, p, 1);
  }
}

/**
 * CODE 5 + 0x4110: a ship in one of its own cities is repaired once per stay (twice as fast
 * in games modes 1 and 2), up to `max`. Fighters on a Carrier would also be repaired, but
 * this is only ever called for ships.
 */
export function repairInPort(m: Mem, max: number, player: number, p: number): void {
  if (terrainAt(m, pX(m, p), pY(m, p)) === ownCity(m, player) && m.b(p + 13) === 0) {
    m.setB(p + 13, 1);
    if (inSet(FAST_MODES, m.sb(GAME_MODE))) {
      repairStep(m, p, max);
      repairStep(m, p, max);
    } else {
      repairStep(m, p, max);
    }
  }
  if (pType(m, p) === FIGHTER && topIs(m, pX(m, p), pY(m, p), 1 << CARRIER, 1 << player)) {
    repairStep(m, p, max);
  }
}

/** CODE 5 + 0x4C42: the overlapping map region (x0, y0, x1, y1) for region 0..15. */
export function regionBounds(m: Mem, region: number): [number, number, number, number] {
  const col = region % 4, row = Math.trunc(region / 4);
  const xs = [[1, 23], [20, 43], [40, 63], [60, 80]][col];
  const ys = [[1, 18], [15, 33], [30, 48], [45, 60]][row];
  m.setB(REGION_START, row * 4 + col);
  return [xs[0], ys[0], xs[1], ys[1]];
}

/**
 * CODE 6 + 0x583E: the nearest piece of `owner` with a type in `typeSet` within `maxDist`
 * of (x, y) on a cell player 2 has explored (only spotted ones when `spottedOnly`).
 */
export function findPieceNear(
  m: Mem, spottedOnly: boolean, typeSet: number, owner: number, maxDist: number, y: number, x: number,
): number {
  let best = 5000, found = 0;
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const q = pieceAt(i);
    if (spottedOnly && pSpotted(m, q) === 0) continue;
    if (pOwner(m, q) !== owner || !inSet(typeSet, pType(m, q), 15)) continue;
    const dist = distance(pX(m, q) - x, pY(m, q) - y);
    if (dist <= maxDist && explored(m, 2, pX(m, q), pY(m, q)) && dist < best) {
      best = dist;
      found = i;
    }
  }
  return found;
}

/**
 * CODE 6 + 0x0004: computer-opponent code applied to every player-2 ship next to the map
 * edge: pick a random sea destination 3 to 12 cells away (quirk Q10).
 */
export function rerouteEdgeShip(m: Mem, p: number): void {
  const d: Dir = { dx: Math.trunc(((qdRandom(m) << 16) >> 16) % 2), dy: 0 };
  d.dy = Math.trunc(((qdRandom(m) << 16) >> 16) % 2);
  const turn = qdRandom(m) < 0 ? 1 : 0;
  for (let k = 1; k <= 8; k++) {
    rotate(turn, d);
    const ox = (Math.abs(qdRandom(m) % 10) + 3) * d.dx;
    const oy = (Math.abs(qdRandom(m) % 10) + 3) * d.dy;
    const tx = pX(m, p) + ox, ty = pY(m, p) + oy;
    if (tx > 2 && tx < 79 && ty > 2 && ty < 59 && inSet(0x01, terrainAt(m, tx, ty))) setDestination(m, p, tx, ty);
  }
}

function lostMessage(m: Mem, host: Host, ptype: number, player: number): void {
  messageB(m, host, (typeStrId(m, ptype) << 16) | 0x03f4, 0x0002ffff, player, 0, 1);
}

/** CODE 5 + 0x2428 */
export function moveArmy(m: Mem, host: Host, p: number, player: number, idx: number): void {
  const req = new Request();
  const reply = new Reply();
  const startPos = m.w(p + 6);
  if (!isComputer(m, player) && terrainAt(m, pX(m, p), pY(m, p)) !== 0) {
    for (let i = 1; pType(m, pieceAt(i)) === TRANSPORT; i++) {
      const t = pieceAt(i);
      if (pState(m, t) === 3 && pCargo(m, t) < 6 && pOwner(m, t) === player &&
          distance(pX(m, p) - pX(m, t), pY(m, p) - pY(m, t)) === 1) {
        setDestination(m, p, pX(m, t), pY(m, t));
      }
    }
  }
  if (pState(m, p) === 2) {
    if (terrainNear(m, pX(m, p), pY(m, p), (1 << enemyCity(m, player)) | 0x0002) && inSet(0x21, pType(m, p))) {
      setState(m, p, 1);
    } else {
      return;
    }
  } else if (pState(m, p) === 1 && pCargo(m, p) === 0) {
    if (!terrainNear(m, pX(m, p), pY(m, p), 0x001e) && inSet(0x21, pType(m, p))) {
      setState(m, p, 2);
      return;
    }
  }
  req.code = RequestCode.DIRECTION;
  req.pos = m.w(p + 6);
  req.player = player;
  req.index = idx;
  req.w6 = m.w(MOVES_LEFT);
  const d: Dir = { dx: 0, dy: 0 };
  const interrupt = orderStep(m, host, p, player, idx, d, ARMY_FORBIDDEN);
  const r = stepExecutor(m, host, p, player, idx, d, ARMY_FORBIDDEN, interrupt, reply);
  if (r.lost) {
    killPiece(m, idx);
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.player = player;
    req.pos = m.w(p + 6);
    host.request(m, req, reply);
  }
  const x = pX(m, p), y = pY(m, p);
  const t = terrainAt(m, x, y);
  if (!inSet((1 << enemyCity(m, player)) | 0x0002, t, 15)) return;
  const local = m.sb(LOCAL_PLAYER);
  if ((isComputer(m, player) && explored(m, local, x, y) && t !== CITY_NEUTRAL) || pOwner(m, p) === local ||
      m.sb(GAME_MODE) === 2) {
    if (t !== CITY_NEUTRAL) {
      req.code = RequestCode.BATTLE;
      explore(m, p, x, y, local);
    } else {
      req.code = RequestCode.CITY_REPELLED_OR_NEUTRAL;
    }
    req.player = m.sb(GAME_MODE) === 2 ? player : local;
    req.pos = startPos;
    req.index = idx;
    const save = m.w(p + 6);
    m.setW(p + 6, startPos);
    host.request(m, req, reply);
    m.setW(p + 6, save);
  }
  if (dayRandomCheck(m)) {
    const n1 = pieceCount(m);
    for (let i = 1; i <= n1; i++) {
      const r2 = pieceAt(i);
      if (pType(m, r2) === FIGHTER && isComputer(m, pOwner(m, r2)) &&
          distance(m.sb(r2 + 3) - x, m.sb(r2 + 2) - y) <= 10) setState(m, r2, 1);
    }
    const n2 = pieceCount(m);
    for (let i = 1; i <= n2; i++) {
      const r2 = pieceAt(i);
      if (pType(m, r2) === BOMBER && isComputer(m, pOwner(m, r2)) && pOwner(m, r2) === player) setState(m, r2, 1);
    }
    const wasEnemy = t !== CITY_NEUTRAL;
    const ci = cityAt(m, x, y);
    const oldOwner = m.sb(cityRec(ci) + 4);
    setCityOwner(m, 0, ci, player);
    if (explored(m, opponent(m, player), x, y) && wasEnemy) {
      host.report(m, {
        kind: 1, outcome: 1, unitType: pType(m, p), unitPos: m.w(p + 6), cityPos: m.w(cityRec(ci) + 6),
        terrain: terrainAt(m, x, y),
      });
    }
    req.player = local;
    req.code = RequestCode.PIECE_BUILT;
    req.pos = m.w(p + 6);
    host.request(m, req, reply);
    if (oldOwner !== 0) {
      const id = player === local ? 0x03f8 : 0x040c;
      messageA(m, host, 0xffff0000 | id, 2, player, 1, 1);
    } else {
      messageA(m, host, 0xffff03f8, 2, player, 0, 1);
    }
    req.player = player;
    req.code = RequestCode.PRODUCTION;
    req.ptype = 0;
    req.pos = m.w(p + 6);
    host.request(m, req, reply);
    // The original passes an uninitialised local record here (quirk Q9); a zeroed one stands in.
    explore(m, new Uint8Array(14), x, y, player);
  } else {
    killPiece(m, idx);
    const ci = cityAt(m, x, y);
    if (t !== CITY_NEUTRAL) {
      host.report(m, {
        kind: 2, outcome: 0, unitType: pType(m, p), unitPos: m.w(p + 6), cityPos: m.w(cityRec(ci) + 6),
        terrain: t,
      });
      const id = player === local ? 0x0408 : 0x040d;
      messageA(m, host, 0xffff0000 | id, 2, player, 1, 1);
    } else {
      messageA(m, host, 0xffff0408, 2, player, 0, 1);
    }
  }
  killPiece(m, idx);
  req.player = player;
  req.code = RequestCode.MOVED;
  req.pos = startPos;
  host.request(m, req, reply);
  req.code = RequestCode.PIECE_BUILT;
  req.pos = m.w(p + 6);
  host.request(m, req, reply);
}

/** CODE 5 + 0x3814 (Destroyer), 0x3962 (Submarine), 0x3F58 (Battleship). */
export function moveShip(m: Mem, host: Host, p: number, player: number, idx: number): void {
  if (pState(m, p) === 2) return;
  const ptype = pType(m, p);
  const req = new Request();
  const reply = new Reply();
  req.code = RequestCode.DIRECTION;
  req.pos = m.w(p + 6);
  req.player = player;
  req.index = idx;
  req.w6 = m.w(MOVES_LEFT);
  const set = (1 << enemyCity(m, player)) | SHIP_FORBIDDEN;
  const d: Dir = { dx: 0, dy: 0 };
  const interrupt = orderStep(m, host, p, player, idx, d, set);
  const r = stepExecutor(m, host, p, player, idx, d, set, interrupt, reply);
  if (r.lost) {
    killPiece(m, idx);
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.pos = m.w(p + 6);
    req.player = player;
    host.request(m, req, reply);
    lostMessage(m, host, ptype, player);
  }
}

/**
 * CODE 5 + 0x3AB0. A Transport loading Armies (state 3) stops loading when full. In
 * single-player games, player 2's Transport arriving at its destination with Armies aboard
 * wakes them (and itself).
 */
export function moveTransport(m: Mem, host: Host, p: number, player: number, idx: number): void {
  if (pState(m, p) !== 2 && pState(m, p) !== 3) {
    const req = new Request();
    const reply = new Reply();
    req.code = RequestCode.DIRECTION;
    req.pos = m.w(p + 6);
    req.player = player;
    req.index = idx;
    req.w6 = m.w(MOVES_LEFT);
    const set = ((1 << enemyCity(m, player)) | SHIP_FORBIDDEN) & 0xff;
    const d: Dir = { dx: 0, dy: 0 };
    const interrupt = orderStep(m, host, p, player, idx, d, set);
    const r = stepExecutor(m, host, p, player, idx, d, set, interrupt, reply);
    if (terrainNear(m, pX(m, p), pY(m, p), (1 << enemyCity(m, player)) | 0x0002)) wakeAllAt(m, pX(m, p), pY(m, p));
    if (r.lost) {
      killPiece(m, idx);
      killTypesAt(m, pX(m, p), pY(m, p), 1 << TRANSPORT);
      killTypesAt(m, pX(m, p), pY(m, p), 1 << ARMY);
      req.code = RequestCode.STEP_DONE_NOTEWORTHY;
      req.pos = m.w(p + 6);
      req.player = player;
      host.request(m, req, reply);
      lostMessage(m, host, TRANSPORT, player);
      return;
    }
  }
  if (pState(m, p) === 3 && pCargo(m, p) >= 6) setState(m, p, 1);
  if (m.sb(GAME_MODE) === 0 && pOwner(m, p) === 2 && pState(m, p) === 0 && pX(m, p) === m.sb(p + 3) &&
      pY(m, p) === m.sb(p + 2) && pCargo(m, p) > 0) {
    wakeAllAt(m, pX(m, p), pY(m, p));
  }
}

/** CODE 5 + 0x3D4E */
export function moveCarrier(m: Mem, host: Host, p: number, player: number, idx: number): void {
  if (pState(m, p) === 2) return;
  const req = new Request();
  const reply = new Reply();
  req.code = RequestCode.DIRECTION;
  req.pos = m.w(p + 6);
  req.player = player;
  req.index = idx;
  req.w6 = m.w(MOVES_LEFT);
  setCargo(m, p, 0);
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const f = pieceAt(i);
    if (pType(m, f) === FIGHTER && pX(m, f) === pX(m, p) && pY(m, f) === pY(m, p)) setCargo(m, p, pCargo(m, p) + 1);
  }
  const set = (1 << enemyCity(m, player)) | SHIP_FORBIDDEN;
  const d: Dir = { dx: 0, dy: 0 };
  const interrupt = orderStep(m, host, p, player, idx, d, set);
  const r = stepExecutor(m, host, p, player, idx, d, set, interrupt, reply);
  if (r.lost) {
    killPiece(m, idx);
    killTypesAt(m, pX(m, p), pY(m, p), 1 << CARRIER);
    killTypesAt(m, pX(m, p), pY(m, p), 1 << FIGHTER);
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.pos = m.w(p + 6);
    req.player = player;
    host.request(m, req, reply);
    lostMessage(m, host, CARRIER, player);
  }
}

/** CODE 5 + 0x340A / 0x2DD6: an aircraft out of fuel crashes. */
function outOfFuel(m: Mem, host: Host, p: number, player: number, idx: number, req: Request, reply: Reply, msg: number, all: number): boolean {
  if (pCargo(m, p) > 0) return false;
  messageA(m, host, msg, 2, player, 0, all);
  killPiece(m, idx);
  req.player = player;
  req.code = RequestCode.MOVED;
  req.pos = m.w(p + 6);
  req.index = idx;
  host.request(m, req, reply);
  return true;
}

/** CODE 5 + 0x349E. Returns whether the Fighter ended the step refuelled. */
export function moveFighter(m: Mem, host: Host, p: number, player: number, idx: number): boolean {
  const req = new Request();
  const reply = new Reply();
  if (pState(m, p) === 2) {
    if (terrainAt(m, pX(m, p), pY(m, p)) !== ownCity(m, player) &&
        !topIs(m, pX(m, p), pY(m, p), 1 << CARRIER, 1 << player)) {
      if (!outOfFuel(m, host, p, player, idx, req, reply, 0xffff03f7, isComputer(m, player) ? 0 : 1)) {
        setCargo(m, p, pCargo(m, p) - 1);
      }
    }
    return false;
  }
  req.code = RequestCode.DIRECTION;
  req.pos = m.w(p + 6);
  req.player = player;
  req.index = idx;
  req.w6 = m.w(MOVES_LEFT);
  if (outOfFuel(m, host, p, player, idx, req, reply, 0xffff03f7, isComputer(m, player) ? 0 : 1)) return false;
  let refuelled = false;
  const startPos = m.w(p + 6);
  const d: Dir = { dx: 0, dy: 0 };
  const interrupt = orderStep(m, host, p, player, idx, d, NO_TERRAIN);
  const r = stepExecutor(m, host, p, player, idx, d, NO_TERRAIN, interrupt, reply);
  if (pCargo(m, p) > 0) setCargo(m, p, pCargo(m, p) - 1);
  if (m.b(STEP_FLAG_1A95)) setCargo(m, p, 20);
  if (pCargo(m, p) === 10 && pState(m, p) === 0 && isComputer(m, player) &&
      terrainAt(m, m.sb(p + 3), m.sb(p + 2)) !== ownCity(m, player) &&
      !topIs(m, m.sb(p + 3), m.sb(p + 2), 1 << CARRIER, 1 << player)) setState(m, p, 1);
  if (terrainAt(m, pX(m, p), pY(m, p)) === ownCity(m, player)) {
    refuelled = true;
    setCargo(m, p, 20);
  }
  if (topIs(m, pX(m, p), pY(m, p), 1 << CARRIER, 1 << player)) {
    refuelled = true;
    setCargo(m, p, 20);
  }
  if (r.lost) {
    killPiece(m, idx);
    req.player = player;
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.pos = startPos;
    host.request(m, req, reply);
  }
  return refuelled;
}

/** CODE 5 + 0x2E50. Returns whether the Bomber ended the step in one of its cities. */
export function moveBomber(m: Mem, host: Host, p: number, player: number, idx: number): boolean {
  const req = new Request();
  const reply = new Reply();
  if (pState(m, p) === 2) {
    if (terrainAt(m, pX(m, p), pY(m, p)) !== ownCity(m, player)) {
      if (!outOfFuel(m, host, p, player, idx, req, reply, 0xffff0412, 1)) setCargo(m, p, pCargo(m, p) - 1);
    }
    return false;
  }
  if (outOfFuel(m, host, p, player, idx, req, reply, 0xffff0412, 1)) return false;
  req.code = RequestCode.DIRECTION;
  req.pos = m.w(p + 6);
  req.player = player;
  req.index = idx;
  req.w6 = m.w(MOVES_LEFT);
  const startPos = m.w(p + 6);
  const d: Dir = { dx: 0, dy: 0 };
  const interrupt = orderStep(m, host, p, player, idx, d, NO_TERRAIN);
  const r = stepExecutor(m, host, p, player, idx, d, NO_TERRAIN, interrupt, reply);
  if (pCargo(m, p) > 0) setCargo(m, p, pCargo(m, p) - 1);
  if (pCargo(m, p) === 15 && pState(m, p) === 0 && isComputer(m, player) &&
      terrainAt(m, m.sb(p + 3), m.sb(p + 2)) !== ownCity(m, player)) setState(m, p, 1);
  if (terrainAt(m, pX(m, p), pY(m, p)) === ownCity(m, player)) setCargo(m, p, 30);
  const x = pX(m, p), y = pY(m, p);
  if (terrainAt(m, x, y) === enemyCity(m, player) || topIs(m, x, y, 0x007d, 1 << opponent(m, player))) {
    req.player = m.sb(LOCAL_PLAYER);
    req.pos = m.w(p + 6);
    explore(m, p, x, y, 1);
    const seen2 = explore(m, p, x, y, 2);
    host.report(m, { kind: 3, radius: pRadius(m, p), pos: req.pos });
    req.index = idx;
    req.code = RequestCode.BOMBER_ATTACK;
    host.request(m, req, reply);
    if (player !== m.sb(LOCAL_PLAYER)) host.event(m, "sound", { id: 2 });
    req.flag = 0;
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    host.request(m, req, reply);
    req.player = player;
    bomberBlast(m, p, idx, seen2 ? 1 : 0);
    req.code = RequestCode.BOMBER_BLAST_DONE;
    host.request(m, req, reply);
    killPiece(m, idx);
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.pos = startPos;
    host.request(m, req, reply);
    if (isComputer(m, req.player)) {
      const n = pieceCount(m);
      for (let i = 1; i <= n; i++) {
        const b = pieceAt(i);
        if (pType(m, b) === BOMBER && isComputer(m, pOwner(m, b)) && pOwner(m, b) === player) setState(m, b, 1);
      }
    }
    const n = pieceCount(m);
    for (let i = 1; i <= n; i++) {
      const f = pieceAt(i);
      if (pType(m, f) === FIGHTER && isComputer(m, pOwner(m, f)) &&
          distance(m.sb(f + 3) - pX(m, p), m.sb(f + 2) - pY(m, p)) <= 10) setState(m, f, 1);
    }
    return false;
  }
  if (r.lost) {
    killPiece(m, idx);
    req.player = player;
    req.code = RequestCode.STEP_DONE_NOTEWORTHY;
    req.pos = startPos;
    host.request(m, req, reply);
    return false;
  }
  return terrainAt(m, x, y) === ownCity(m, player);
}


/**
 * CODE 5 + 0x42D4: one player's turn. Cities produce, then every piece of the player moves
 * its moves for the day, region by region (16 overlapping regions starting from the one
 * after last turn's), in piece-table order within a region. Pieces whose step the
 * controller deferred are revisited in further sweeps. The table is compacted at the end.
 */
export function playerTurn(m: Mem, host: Host, player: number): void {
  const req = new Request();
  const reply = new Reply();
  let anyBuilt = false;
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) !== player) continue;
    const ptype = cityProductionTick(m, player, c);
    if (ptype < 0) continue;
    const built = buildPiece(m, m.sb(cr + 7), m.sb(cr + 6), player, ptype);
    if (ptype === ARMY && !isComputer(m, player) && (m.b(cr + 1) !== m.b(cr + 7) || m.b(cr) !== m.b(cr + 6))) {
      setDestination(m, pieceAt(pieceCount(m)), m.sb(cr + 1), m.sb(cr));
    }
    if (built) {
      setStep(m, pieceAt(pieceCount(m)), 0);
      if (isComputer(m, player)) {
        host.aiNewPiece(m, c);
        if (isComputer(m, player)) host.aiPlan(m);
      }
      req.index = pieceCount(m);
      req.pos = m.w(cr + 6);
      req.player = player;
      req.code = RequestCode.PIECE_BUILT;
      host.request(m, req, reply);
    }
    anyBuilt = anyBuilt || built;
  }
  if (anyBuilt) compactPieces(m);
  if (isComputer(m, player)) host.aiPlan(m);
  req.player = player;
  req.code = RequestCode.TURN_START;
  host.request(m, req, reply);
  req.code = RequestCode.BEFORE_STEP;
  host.request(m, req, reply);
  do {
    const start = m.sb(REGION_START);
    m.setB(ANY_DEFERRED, 0);
    for (let k = 0; k <= 15; k++) {
      const [x0, y0, x1, y1] = regionBounds(m, (k + start) % 16);
      for (let i = 1; i <= pieceCount(m); i++) {
        const p = pieceAt(i);
        if (pMoved(m, p) || pX(m, p) < x0 || pX(m, p) > x1 || pY(m, p) < y0 || pY(m, p) > y1 ||
            pOwner(m, p) !== player || pType(m, p) === REMOVED) continue;
        setMoved(m, p, 1);
        if (pStep(m, p) === 0) {
          m.setW(MOVE_STEP, 1);
          setStep(m, p, 1);
        } else {
          m.setW(MOVE_STEP, pStep(m, p));
        }
        m.setB(PIECE_DONE, 0);
        m.setB(PIECE_DEFERRED, 0);
        while (m.sw(MOVE_STEP) <= movesPerDay(m, pType(m, p), pStrength(m, p), i) &&
               !m.b(PIECE_DONE) && !m.b(PIECE_DEFERRED)) {
          m.setW(MOVES_LEFT, movesPerDay(m, pType(m, p), pStrength(m, p), i) - m.sw(MOVE_STEP) + 1);
          req.code = RequestCode.BEFORE_STEP;
          req.player = player;
          host.request(m, req, reply);
          m.setB(STEP_FLAG_1A95, 0);
          const x = pX(m, p), y = pY(m, p);
          if (pType(m, p) === DESTROYER) {
            const sub = findPieceNear(m, false, 1 << SUBMARINE, opponent(m, player), 1, y, x);
            if (sub !== 0) {
              setState(m, p, 1);
              setSpotted(m, pieceAt(sub), 1);
              setState(m, pieceAt(sub), 1);
            }
          }
          if (enemyAdjacent(m, 0, player, x, y)) {
            const e = pieceAt(foundEnemy(m));
            if (pType(m, e) !== SUBMARINE || pSpotted(m, e) !== 0) setState(m, p, 1);
          } else if (terrainNear(m, x, y, (1 << enemyCity(m, player)) | 0x0002) && inSet(0x21, pType(m, p))) {
            setState(m, p, 1);
          }
          if (inSet(SHIPS, pType(m, p)) && player === 2 && (x === 2 || x === 79 || y === 2 || y === 59)) {
            rerouteEdgeShip(m, p);
          }
          switch (pType(m, p)) {
            case ARMY:
              moveArmy(m, host, p, player, i);
              break;
            case FIGHTER: {
              m.setB(STEP_FLAG_1A95, 0);
              const fuel = pCargo(m, p);
              moveFighter(m, host, p, player, i);
              if (m.b(PIECE_DEFERRED)) setCargo(m, p, fuel);
              if (pState(m, p) === 2) m.setW(MOVE_STEP, movesPerDay(m, pType(m, p), pStrength(m, p), i));
              break;
            }
            case DESTROYER:
              if (m.sw(MOVE_STEP) === 1) repairInPort(m, 4, player, p);
              moveShip(m, host, p, player, i);
              break;
            case SUBMARINE:
              if (m.sw(MOVE_STEP) === 1) repairInPort(m, 3, player, p);
              moveShip(m, host, p, player, i);
              break;
            case TRANSPORT:
              if (m.sw(MOVE_STEP) === 1) repairInPort(m, 3, player, p);
              moveTransport(m, host, p, player, i);
              break;
            case CARRIER:
              if (m.sw(MOVE_STEP) === 1) repairInPort(m, 10, player, p);
              moveCarrier(m, host, p, player, i);
              break;
            case BATTLESHIP:
              if (m.sw(MOVE_STEP) === 1) repairInPort(m, 18, player, p);
              moveShip(m, host, p, player, i);
              break;
            case BOMBER: {
              const fuel = pCargo(m, p);
              moveBomber(m, host, p, player, i);
              if (m.b(PIECE_DEFERRED)) setCargo(m, p, fuel);
              if (pState(m, p) === 2) m.setW(MOVE_STEP, movesPerDay(m, pType(m, p), pStrength(m, p), i));
              break;
            }
          }
          if (pAttacks(m, p) >= 2) m.setW(MOVE_STEP, movesPerDay(m, pType(m, p), pStrength(m, p), i));
          if (m.b(PIECE_DEFERRED)) {
            m.setB(ANY_DEFERRED, 1);
            setMoved(m, p, 0);
            if (pType(m, p) !== REMOVED) setStep(m, p, pStep(m, p) - 1);
          }
          if (pType(m, p) === ARMY) {
            const t = pieceAt(topPieceAt(m, pX(m, p), pY(m, p)));
            if (pType(m, t) === TRANSPORT && !pMoved(m, t)) setMoved(m, p, 0);
          }
          m.setW(MOVE_STEP, m.sw(MOVE_STEP) + 1);
          if (pType(m, p) !== REMOVED) setStep(m, p, pStep(m, p) + 1);
        }
      }
    }
  } while (m.b(ANY_DEFERRED));
  compactPieces(m);
}
