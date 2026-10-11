/**
 * A human player's commands, as the original carries them out: the Moves menu and its
 * keys (Domenu, CODE 16 + 0x0028), clicks and drags on the map (CODE 13 + 0x0028), and the
 * production dialog (CODE 18). The user interface gathers the clicks; these functions
 * apply them to the game state.
 *
 * Commands are given while the player's controller is handling a request, usually a
 * direction request (code 5) for the piece `req.index` at `req.pos`. A command that
 * answers the request writes `reply` and returns true; the controller then hands the
 * reply back to the mover. `player` is the commanding player (the original's local player,
 * which on the AppleTalk Slave is player 2).
 */
import { Mem } from "./mem.ts";
import {
  AUTO_PLAY_REQUESTED, MAX_PIECES, OWN_CITY_CODE, PIECE_DEFERRED, PIECE_DONE, TRANSPORT, WATER,
} from "./globals.ts";
import { topPieceAt } from "./hash.ts";
import { Reply, Request, RequestCode } from "./host.ts";
import { inSet, terrainAt, terrainNear } from "./map.ts";
import { setDestination } from "./moveops.ts";
import { lineDirection } from "./path.ts";
import {
  pieceAt, pOwner, pType, pX, pY, setBit5, setOrders, setPatrol, setState,
} from "./piece.ts";
import { pieceCount } from "./query.ts";
import { cityAt, cityRec, setCityOwner } from "./units.ts";

const AIRCRAFT = 0x82;
const SHIPS = 0x7c;
const WATER_SET = 1 << WATER;

const reqX = (req: Request) => (req.pos << 24) >> 24;
const reqY = (req: Request) => (req.pos << 16) >> 24;

/** Answer the request with no move: (0, 0). */
function answerNoMove(reply: Reply): true {
  reply.dx = 0;
  reply.dy = 0;
  return true;
}

/** The request is a direction request for one of `player`'s pieces. */
function ownDirectionRequest(m: Mem, req: Request, player: number): boolean {
  return req.code === RequestCode.DIRECTION && pOwner(m, pieceAt((req.index << 16) >> 16)) === player;
}

/** Sleep (S): the piece being moved goes to sleep. */
export function sleep(m: Mem, req: Request, reply: Reply, player: number): boolean {
  if (!ownDirectionRequest(m, req, player)) return false;
  setState(m, pieceAt(req.index), 2);
  return answerNoMove(reply);
}

/** Random (R): the piece being moved moves at random from now on. */
export function random(m: Mem, req: Request, reply: Reply, player: number): boolean {
  if (!ownDirectionRequest(m, req, player)) return false;
  const p = pieceAt(req.index);
  setState(m, p, 0);
  setBit5(m, p, 1);
  return answerNoMove(reply);
}

/** Skip (N): the piece being moved stops for the day. */
export function skip(m: Mem, reply: Reply): boolean {
  m.setB(PIECE_DONE, 1);
  return answerNoMove(reply);
}

/** Move Later (B): the piece being moved is revisited after the other pieces. */
export function moveLater(m: Mem, reply: Reply): boolean {
  m.setB(PIECE_DEFERRED, 1);
  return answerNoMove(reply);
}

/**
 * Wake (W) and a click on (x, y): every piece on the cell wakes, whoever owns it
 * (CODE 4 + 0x0C08; quirk Q13).
 */
export function wake(m: Mem, x: number, y: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pX(m, p) === x && pY(m, p) === y) setState(m, p, 1);
  }
}

/** Transport Load (L) and a click on (x, y): the player's Transport there waits to load. */
export function load(m: Mem, req: Request, reply: Reply, player: number, x: number, y: number): boolean {
  const t = topPieceAt(m, x, y);
  const p = pieceAt(t);
  if (pType(m, p) !== TRANSPORT || pOwner(m, p) !== player) return false;
  setState(m, p, 3);
  return t === req.index ? answerNoMove(reply) : false;
}

/**
 * City Aircraft Destination (C): a click on the player's city at (x, y) and a drag to
 * (tx, ty). New aircraft built there will fly to the target. An aircraft being moved from
 * that city is sent there too.
 */
export function aircraftDestination(
  m: Mem, req: Request, reply: Reply, player: number, x: number, y: number, tx: number, ty: number,
): boolean {
  if (terrainAt(m, x, y) !== m.sb(OWN_CITY_CODE + player)) return false;
  const c = cityRec(cityAt(m, x, y));
  m.setB(c + 3, tx);
  m.setB(c + 2, ty);
  if (req.code !== RequestCode.DIRECTION) return false;
  const p = pieceAt((req.index << 16) >> 16);
  if (m.sb(c + 7) !== reqX(req) || m.sb(c + 6) !== reqY(req) || !inSet(AIRCRAFT, pType(m, p))) return false;
  setDestination(m, p, tx, ty);
  return answerNoMove(reply);
}

/**
 * Army Destination (A): a click on the player's city at (x, y) and a drag to (tx, ty).
 * New Armies built there will go to the target.
 */
export function armyDestination(m: Mem, player: number, x: number, y: number, tx: number, ty: number): void {
  if (terrainAt(m, x, y) !== m.sb(OWN_CITY_CODE + player)) return;
  const c = cityRec(cityAt(m, x, y));
  m.setB(c + 1, tx);
  m.setB(c, ty);
}

/**
 * Stack Move (M): a click on a cell (x, y) with any piece on it and a drag to (tx, ty).
 * All of the player's pieces on the cell get go-to orders to the target.
 */
export function stackMove(
  m: Mem, req: Request, reply: Reply, player: number, x: number, y: number, tx: number, ty: number,
): boolean {
  if (topPieceAt(m, x, y) === 0) return false;
  let done = false;
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pX(m, p) !== x || pY(m, p) !== y || pOwner(m, p) !== player) continue;
    setDestination(m, p, tx, ty);
    if (i === req.index) done = answerNoMove(reply);
  }
  return done;
}

/**
 * Patrol (P): a drag from (x, y) to (tx, ty). The piece being moved, if the request has
 * one, or else the top piece at (x, y), patrols between where it is and the target.
 */
export function patrol(
  m: Mem, req: Request, reply: Reply, player: number, x: number, y: number, tx: number, ty: number,
): boolean {
  const cur = req.index <= MAX_PIECES ? req.index : 0;
  const pc = pieceAt(cur);
  const idx = pX(m, pc) === reqX(req) && pY(m, pc) === reqY(req) && pOwner(m, pc) === player
    ? cur
    : topPieceAt(m, x, y);
  if (idx === 0) return false;
  const p = pieceAt(idx);
  if (pOwner(m, p) !== player) return false;
  setDestination(m, p, tx, ty);
  setPatrol(m, p, 1);
  return idx === req.index ? answerNoMove(reply) : false;
}

/**
 * A click on (x, y) next to the piece being moved (or on it): the direction toward the
 * cell.
 */
export function clickDirection(req: Request, reply: Reply, x: number, y: number): boolean {
  const dx = x - reqX(req), dy = y - reqY(req);
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return false;
  reply.dx = dx;
  reply.dy = dy;
  return true;
}

/**
 * A drag from the player's piece at (x, y) to (tx, ty): go-to orders for the top piece
 * there, or for the piece being moved when it is on that cell. The reply holds the first
 * step toward the target; it answers the request when the piece is the one being moved.
 */
export function goTo(
  m: Mem, req: Request, reply: Reply, player: number, x: number, y: number, tx: number, ty: number,
): boolean {
  let idx = topPieceAt(m, x, y);
  if (idx === 0 || pOwner(m, pieceAt(idx)) !== player) return false;
  tx = Math.min(tx, 80);
  ty = Math.min(ty, 60);
  if (req.code === RequestCode.DIRECTION && idx !== req.index) {
    const pc = pieceAt((req.index << 16) >> 16);
    if (pX(m, pc) === x && pY(m, pc) === y) idx = req.index;
  }
  if (tx === x && ty === y) return false;
  const p = pieceAt(idx);
  m.setB(p + 5, x);
  m.setB(p + 4, y);
  m.setW(p, m.w(p + 4));
  setState(m, p, 0);
  setBit5(m, p, 0);
  setPatrol(m, p, 0);
  m.setB(p + 3, tx);
  m.setB(p + 2, ty);
  setOrders(m, p, 2);
  const d = lineDirection(m.bytes(p, 14));
  reply.dx = d.dx;
  reply.dy = d.dy;
  return idx === req.index;
}

/** Options > Auto Play: request the computer to play (or stop playing) player 1's side. */
export function toggleAutoPlay(m: Mem): void {
  m.setB(AUTO_PLAY_REQUESTED, m.b(AUTO_PLAY_REQUESTED) ^ 1);
}

/** What the production dialog remembers about the city when it opens. */
export interface ProductionDialog {
  city: number;
  type: number;
  days: number;
}

/**
 * The production dialog opens for the city at (x, y) (a double-click on the player's city,
 * the city list, or a request to choose production after a capture, `captured`). Ship
 * types are offered only next to water. A captured city is set to build Armies.
 */
export function openProduction(m: Mem, x: number, y: number, owner: number, captured: boolean): ProductionDialog {
  terrainNear(m, x, y, WATER_SET);
  const city = cityAt(m, x, y);
  const c = cityRec(city);
  if (captured) setCityOwner(m, 0, city, owner);
  return { city, type: m.sb(c + 8), days: m.b(c + 5) };
}

/**
 * A choice in the production dialog. Ships can only be built in a city next to water;
 * returns false (the original shows an alert) for a ship in an inland city. Choosing again
 * the type the city was building when the dialog opened restores its progress; any other
 * change restarts the count.
 */
export function chooseProduction(m: Mem, dlg: ProductionDialog, ptype: number): boolean {
  const c = cityRec(dlg.city);
  if (inSet(SHIPS, ptype) && !terrainNear(m, m.sb(c + 7), m.sb(c + 6), WATER_SET)) return false;
  setCityOwner(m, ptype, dlg.city, m.sb(c + 4));
  if (ptype === dlg.type) m.setB(c + 5, dlg.days);
  return true;
}
