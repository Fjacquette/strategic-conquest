/**
 * Moving one piece one step (Mover segment, CODE 5). Rules are documented in
 * docs/rules/movement.md.
 *
 * Each per-type mover asks orderStep() whether the piece can carry on under its orders,
 * then stepExecutor() either executes that step or asks the side's controller for a
 * direction (repeating the question until the answer is acceptable), and executeMove()
 * carries the step out: boarding, attacking, or moving with cargo.
 */
import { Mem } from "./mem.ts";
import {
  ARMY, BOMBER, CARRIER, FIGHTER, GAME_MODE, LOCAL_PLAYER, MOVES_LEFT, MOVE_STEP, NET_SYNC,
  OPPONENT_OF, OWN_CITY_CODE, PIECE_DEFERRED, REMOVED, STEP_FLAG_1A95, SUBMARINE, TRANSPORT, WATER,
} from "./globals.ts";
import { topPieceAt } from "./hash.ts";
import { type Host, messageA, messageB, Reply, Request, RequestCode } from "./host.ts";
import { distance, explored, inSet, isComputer, onMap, terrainAt, terrainNear } from "./map.ts";
import { boardingFull, enemyAdjacent, foundEnemy, ownPiecesAt, pieceCount, topIs } from "./query.ts";
import { carryCargo, movePiece, wakeAdjacent } from "./moveops.ts";
import { type Dir, nextStep } from "./path.ts";
import { attack } from "./battle.ts";
import { explore } from "./explore.ts";
import { killPiece } from "./table.ts";
import { cityAt, cityRec, typeStrId } from "./units.ts";
import {
  pBit5, pCargo, pieceAt, pOwner, pPatrol, pSpotted, pState, pType, pX, pY, setCargo, setSpotted,
  setState, setType,
} from "./piece.ts";

const AIRCRAFT = 0x82;
const SHIPS = 0x7c;
const STACK_SHIPS = 0x30;
const SURFACE = 0x7d;
const ALL_TYPES = 0x00ff;

// Display-related globals the movement code maintains.
const SHOW_MOVE = -0x1a9c; // byte: the local player may see this move
const STEP_NOTEWORTHY = -0x1a9a; // byte: the last step revealed something (or a battle in network play)
const NET_VIEW = -0x120c; // byte: network play; visibility is judged for the local player

export const enemyCity = (m: Mem, player: number) => m.sb(OWN_CITY_CODE + m.sb(OPPONENT_OF + player));
export const ownCity = (m: Mem, player: number) => m.sb(OWN_CITY_CODE + player);
export const opponent = (m: Mem, player: number) => m.sb(OPPONENT_OF + player);

/**
 * CODE 5 + 0x1592: for a piece under orders (state 0), the next step toward its
 * destination, written to `d`. Arrival ends the orders (patrols turn around; aircraft
 * arriving at a human player's city with an aircraft destination are forwarded there).
 * Returns TRUE when the controller should be asked instead: an enemy next to a human
 * player's piece, an unusable next cell, a full Carrier, or an enemy city adjacent.
 */
export function orderStep(m: Mem, host: Host, p: number, player: number, idx: number, d: Dir, terrainSet: number): boolean {
  let stop = false;
  if (pState(m, p) === 0) {
    if (pX(m, p) === m.sb(p + 3) && pY(m, p) === m.sb(p + 2) && pBit5(m, p) === 0) {
      if (pPatrol(m, p)) {
        const b = m.w(p + 2);
        m.setW(p + 2, m.w(p));
        m.setW(p, b);
        m.setW(p + 4, m.w(p + 6));
      } else {
        const ci = cityAt(m, pX(m, p), pY(m, p));
        if (ci !== 0) {
          const c = cityRec(ci);
          if (inSet(AIRCRAFT, pType(m, p)) && terrainAt(m, m.sb(p + 3), m.sb(p + 2)) === ownCity(m, player) &&
              !isComputer(m, m.sb(c + 4)) && (m.b(c + 3) !== m.b(p + 7) || m.b(c + 2) !== m.b(p + 6))) {
            m.setW(p + 4, m.w(c + 6));
            m.setW(p, m.w(c + 6));
            m.setW(p + 2, m.w(c + 2));
          } else {
            setState(m, p, 1);
          }
        } else {
          setState(m, p, 1);
        }
      }
    }
    if (enemyAdjacent(m, idx, player, pX(m, p), pY(m, p)) && pType(m, pieceAt(foundEnemy(m))) !== SUBMARINE) {
      if (!isComputer(m, player)) stop = true;
    } else {
      const oldB = m.w(p + 2);
      const nd = nextStep(m, terrainSet & 0xff, m.bytes(p, 14));
      d.dx = nd.dx;
      d.dy = nd.dy;
      if (pState(m, p) !== 0 && m.w(p + 6) !== oldB) {
        host.beep(m, player);
        if (!isComputer(m, player)) messageA(m, host, 0xffff0413, 2, player, 0, 0);
      }
      const tx = pX(m, p) + d.dx, ty = pY(m, p) + d.dy;
      if (isComputer(m, player)) {
        const t = pType(m, p);
        if ((t === CARRIER || (t === TRANSPORT && (tx !== m.sb(p + 3) || ty !== m.sb(p + 2)))) &&
            terrainAt(m, tx, ty) === ownCity(m, player)) stop = true;
      }
      if (!onMap(tx, ty)) stop = true;
      const top = topPieceAt(m, tx, ty);
      if (top !== 0) {
        const q = pieceAt(top);
        if (pOwner(m, q) === pOwner(m, p)) {
          if (terrainAt(m, tx, ty) === WATER && inSet(SHIPS, pType(m, p)) && inSet(SHIPS, pType(m, q))) stop = true;
        } else if (pSpotted(m, q) !== 0) {
          stop = true;
        }
      }
      if (inSet(terrainSet, terrainAt(m, tx, ty))) {
        stop = true;
        if (pType(m, p) === ARMY && topIs(m, tx, ty, 1 << TRANSPORT, 1 << pOwner(m, p))) {
          if (pCargo(m, pieceAt(topPieceAt(m, m.sb(p + 3), m.sb(p + 2)))) < 6) stop = false;
        }
      }
    }
    if (pType(m, p) === FIGHTER && boardingFull(m, pX(m, p) + d.dx, pY(m, p) + d.dy, player, FIGHTER)) {
      host.beep(m, player);
      messageA(m, host, 0xffff03fa, 2, player, 0, 1);
      stop = true;
    }
  }
  if (terrainNear(m, pX(m, p), pY(m, p), 1 << enemyCity(m, player))) stop = true;
  return stop;
}

/** The two results of stepExecutor(). */
export interface StepResult {
  /** The piece was lost (drowned, ran aground) or a warning was confirmed. */
  lost: boolean;
  /** An Army stepped into one of its own cities. */
  armyInOwnCity: boolean;
}

/**
 * CODE 5 + 0x1B72: carry out one step. A piece under orders that was not interrupted takes
 * the step `d` chosen by orderStep(). Otherwise the controller is asked for a direction
 * until it gives one that is acceptable; a dangerous move (onto a full ship, attacking an
 * own piece, into water or onto land) is refused with a warning unless the same direction
 * is given twice in a row.
 */
export function stepExecutor(
  m: Mem, host: Host, p: number, player: number, idx: number, d: Dir, terrainSet: number,
  interrupt: boolean, reply: Reply,
): StepResult {
  const res: StepResult = { lost: false, armyInOwnCity: false };
  const start = m.w(p + 6);
  if (pState(m, p) === 0 && !interrupt) {
    reply.dx = d.dx;
    reply.dy = d.dy;
    executeMove(m, host, idx, player, p, reply.dx, reply.dy, start);
  } else {
    const req = new Request();
    req.code = RequestCode.DIRECTION;
    req.pos = m.w(p + 6);
    req.player = player;
    req.index = idx;
    req.w6 = m.w(MOVES_LEFT);
    let lastDx = 0, lastDy = 0;
    let repeated = false;
    let ordered = false;
    let tx: number, ty: number;
    for (;;) {
      const stateBefore = pState(m, p);
      host.request(m, req, reply);
      if (pState(m, p) === 2) return { lost: false, armyInOwnCity: false };
      if (!repeated && pState(m, p) === 0 && stateBefore !== 0) {
        const nd = nextStep(m, terrainSet & 0xff, m.bytes(p, 14));
        d.dx = nd.dx;
        d.dy = nd.dy;
        ordered = true;
        reply.dx = d.dx;
        reply.dy = d.dy;
      }
      tx = pX(m, p) + reply.dx;
      ty = pY(m, p) + reply.dy;
      res.lost = false;
      if (boardingFull(m, tx, ty, player, pType(m, p)) && !(reply.dx === 0 && reply.dy === 0)) {
        host.beep(m, player);
        res.lost = true;
        messageA(m, host, 0xffff03fa, 2, player, 0, 1);
      }
      if (reply.dx === lastDx && reply.dy === lastDy) repeated = true;
      lastDx = reply.dx;
      lastDy = reply.dy;
      let attackOwn = false;
      const top = topPieceAt(m, tx, ty);
      const q = pieceAt(top);
      const air = inSet(AIRCRAFT, pType(m, p)) || inSet(AIRCRAFT, pType(m, q));
      const armies = pType(m, p) === ARMY && pType(m, q) === ARMY && pOwner(m, p) === pOwner(m, q);
      if (top !== 0 && top !== idx && !armies && (pOwner(m, p) !== pOwner(m, q) || !air) && pOwner(m, q) === player) {
        if (pType(m, p) === ARMY && pType(m, q) === TRANSPORT) {
          // boarding
        } else if (pType(m, p) === FIGHTER && pType(m, q) === CARRIER) {
          // landing
        } else if (inSet(0x0100, pType(m, p), 15)) {
          // (never: the mover is never REMOVED)
        } else if (terrainAt(m, tx, ty) !== ownCity(m, player)) {
          host.beep(m, player);
          attackOwn = true;
          if (!isComputer(m, player)) {
            messageB(m, host, (typeStrId(m, pType(m, q)) << 16) | 0x0409, 0x0002ffff, player, 0, 1);
          }
        }
      }
      if (inSet(terrainSet, terrainAt(m, tx, ty))) {
        if (pType(m, p) === ARMY) {
          if (!topIs(m, tx, ty, 1 << TRANSPORT, 1 << player) && !topIs(m, tx, ty, ALL_TYPES, 1 << opponent(m, player))) {
            if (repeated) {
              res.lost = true;
              messageA(m, host, 0xffff03ec, 2, player, 0, 1);
            } else {
              host.beep(m, player);
              res.lost = true;
              messageB(m, host, (typeStrId(m, pType(m, p)) << 16) | 0x03eb, 0x0002ffff, player, 0, 1);
            }
          }
        } else if (!(inSet(0x54, pType(m, p)) && topIs(m, tx, ty, 0x0083, 1 << opponent(m, player)))) {
          host.beep(m, player);
          res.lost = true;
          messageB(m, host, (typeStrId(m, pType(m, p)) << 16) | 0x03eb, 0x0002ffff, player, 0, 1);
        }
      }
      res.armyInOwnCity = terrainAt(m, tx, ty) === ownCity(m, player) && pType(m, p) === ARMY;
      if (!onMap(tx, ty)) {
        host.beep(m, player);
        messageA(m, host, 0xffff03ef, 2, player, 0, 1);
      }
      if (((!res.lost && !attackOwn) || repeated) && onMap(tx, ty)) break;
    }
    executeMove(m, host, idx, player, p, reply.dx, reply.dy, start);
    if (interrupt || ordered) m.setW(p + 4, m.w(p + 6));
  }
  m.setB(NET_SYNC, 0);
  if (pType(m, p) !== SUBMARINE) wakeAdjacent(m, pX(m, p), pY(m, p), opponent(m, player), ALL_TYPES, idx);
  if (terrainNear(m, pX(m, p), pY(m, p), 1 << enemyCity(m, player))) setState(m, p, 1);
  explore(m, p, pX(m, p), pY(m, p), player);
  m.setB(NET_SYNC, 1);
  return res;
}

/**
 * CODE 5 + 0x0916: piece `p` (index `idx`) takes the step (dx, dy) from `start`. Handles a
 * Bomber reaching its target, leaving and boarding Transports and Carriers, Armies
 * attacking from a ship at sea, attacks (CODE 5 + 0x0676), and the move itself with cargo.
 */
export function executeMove(m: Mem, host: Host, idx: number, player: number, p: number, dx: number, dy: number, start: number): void {
  const req = new Request();
  const reply = new Reply();
  const tx0 = pX(m, p) + dx, ty0 = pY(m, p) + dy;
  if (pType(m, p) === BOMBER &&
      (terrainAt(m, tx0, ty0) === enemyCity(m, player) || topIs(m, tx0, ty0, SURFACE, 1 << opponent(m, player)))) {
    m.setB(p + 7, pX(m, p) + dx);
    m.setB(p + 6, pY(m, p) + dy);
    req.player = player;
    req.index = idx;
    req.code = RequestCode.MOVED;
    req.ptype = pType(m, p);
    req.pos = start;
    host.request(m, req, reply);
    return;
  }
  let battle = false;
  const me = pieceAt(idx);
  const under = topPieceAt(m, pX(m, p), pY(m, p));
  if ((pType(m, me) === ARMY && pType(m, pieceAt(under)) === TRANSPORT) ||
      (pType(m, me) === FIGHTER && pType(m, pieceAt(under)) === CARRIER)) {
    if (pCargo(m, pieceAt(under)) !== 0) setCargo(m, pieceAt(under), pCargo(m, pieceAt(under)) - 1);
  }
  const target = topPieceAt(m, tx0, ty0);
  const q = pieceAt(target);
  const air = inSet(AIRCRAFT, pType(m, p)) || inSet(AIRCRAFT, pType(m, q));
  const armies = pType(m, p) === ARMY && pType(m, q) === ARMY && pOwner(m, p) === pOwner(m, q);
  if (pOwner(m, q) === pOwner(m, p)) {
    if (pType(m, q) === CARRIER && pType(m, p) === FIGHTER) setCargo(m, q, pCargo(m, q) + 1);
    else if (pType(m, q) === FIGHTER && pType(m, p) === CARRIER) setCargo(m, p, pCargo(m, p) + 1);
  }
  if (pOwner(m, q) === pOwner(m, p) && pType(m, p) === ARMY && pType(m, q) === TRANSPORT && m.b(PIECE_DEFERRED) === 0) {
    setState(m, p, 2);
  }

  const fight = () => {
    // CODE 5 + 0x0676 (nested in the original)
    const spottedBefore = pSpotted(m, q);
    m.setB(p + 10, (m.b(p + 10) & 0x3f) | ((((m.b(p + 10) >> 6) + 1) & 3) << 6));
    req.player = m.sb(GAME_MODE) === 2 ? player : m.sb(LOCAL_PLAYER);
    req.pos = m.w(p + 6);
    explore(m, p, pX(m, p), pY(m, p), player);
    req.index = idx;
    req.flag = 0;
    if (pOwner(m, q) !== player) {
      if (pType(m, p) === SUBMARINE) setSpotted(m, p, 1);
      if (pType(m, q) === SUBMARINE) setSpotted(m, q, 1);
      req.code = RequestCode.STEP_DONE_NOTEWORTHY;
      host.request(m, req, reply);
      req.code = RequestCode.BATTLE;
    } else {
      req.code = RequestCode.STEP_DONE_NOTEWORTHY;
      host.request(m, req, reply);
      req.code = RequestCode.CITY_REPELLED_OR_NEUTRAL;
    }
    host.request(m, req, reply);
    battle = true;
    const attTypeBefore = pType(m, p), defTypeBefore = pType(m, q);
    const attackerPos = m.w(p + 6), defenderPos = m.w(q + 6);
    const result = attack(m, p, q, idx, target, spottedBefore);
    host.report(m, {
      defenderType: defTypeBefore, attackerType: attTypeBefore, defenderPos, attackerPos,
      outcome: pType(m, q) === REMOVED ? 1 : pType(m, p) === REMOVED ? 0 : 2, defenderStrength: m.b(q + 12) & 0x1f,
    });
    if (!result || ownPiecesAt(m, pX(m, q), pY(m, q), pOwner(m, q)) !== 0) {
      dx = 0;
      dy = 0;
    }
    host.event(m, "battleOutcome", { player, attacker: idx, defender: target });
    setState(m, p, 1);
    setState(m, q, 1);
  };

  if (target !== idx && target !== 0 && terrainAt(m, tx0, ty0) !== ownCity(m, player) &&
      (pOwner(m, p) !== pOwner(m, q) || !air) && !armies) {
    if (pType(m, me) === ARMY && topIs(m, pX(m, me), pY(m, me), 1 << TRANSPORT, 1 << player) &&
        terrainAt(m, pX(m, me) + dx, pY(m, me) + dy) === WATER && pOwner(m, me) !== pOwner(m, q)) {
      messageA(m, host, 0xffff040a, 2, player, 0, 1);
      setType(m, me, REMOVED);
      return;
    }
    if ((pType(m, me) === ARMY && pType(m, q) === TRANSPORT) || (pType(m, me) === FIGHTER && pType(m, q) === CARRIER)) {
      if (boardingFull(m, tx0, ty0, player, pType(m, me))) {
        messageB(m, host, (typeStrId(m, pType(m, p)) << 16) | 0x03fb, 0x0002ffff, player, 0, 1);
        killPiece(m, idx);
      } else if (pOwner(m, q) === pOwner(m, me)) {
        m.setB(STEP_FLAG_1A95, 1);
        setCargo(m, q, pCargo(m, q) + 1);
        if (pType(m, q) === TRANSPORT) {
          if (pCargo(m, q) === 6) {
            setState(m, q, 1);
            if (m.sb(GAME_MODE) === 0) wakePlayer2Types(m, 1 << ARMY);
          }
          if (pState(m, q) === 3) setState(m, p, 2);
        }
      } else {
        if (pType(m, p) === CARRIER || pType(m, q) === CARRIER) {
          const n = pieceCount(m);
          for (let i = 1; i <= n; i++) {
            const r = pieceAt(i);
            if (pType(m, r) === FIGHTER && isComputer(m, pOwner(m, r)) &&
                distance(m.sb(r + 3) - pX(m, r), m.sb(r + 2) - pY(m, r)) <= 10) setState(m, r, 1);
          }
        }
        fight();
      }
    } else {
      fight();
    }
  }
  if (battle) {
    dx = 0;
    dy = 0;
    req.flag = 0;
    // Report the survivor: the mover when the defender was destroyed, and the reverse.
    if (pType(m, q) === REMOVED) {
      req.player = m.sb(LOCAL_PLAYER);
      req.index = idx;
      req.ptype = pType(m, me);
      req.pos = m.w(me + 6);
      req.code = RequestCode.STEP_DONE_NOTEWORTHY;
      host.request(m, req, reply);
    } else if (pType(m, me) === REMOVED) {
      req.player = m.sb(LOCAL_PLAYER);
      req.index = target;
      req.ptype = pType(m, q);
      req.pos = m.w(q + 6);
      req.code = RequestCode.STEP_DONE_NOTEWORTHY;
      host.request(m, req, reply);
    }
  }
  if (dx !== 0 || dy !== 0) {
    const sy = (start << 16) >> 24, sx = (start << 24) >> 24;
    m.setB(NET_SYNC, 0);
    movePiece(m, p, sx + dx, sy + dy, idx, dx);
    const noteworthy = explore(m, p, pX(m, p), pY(m, p), player) || inSet(STACK_SHIPS, pType(m, p));
    m.setB(NET_SYNC, 1);
    if (m.b(NET_VIEW)) {
      const local = m.sb(LOCAL_PLAYER);
      m.setB(SHOW_MOVE, player === local || (explored(m, local, pX(m, p), pY(m, p)) && pSpotted(m, p) !== 0) ? 1 : 0);
    } else {
      m.setB(SHOW_MOVE, !isComputer(m, player) || (explored(m, player, pX(m, p), pY(m, p)) && pSpotted(m, p) !== 0) ? 1 : 0);
    }
    m.setB(NET_SYNC, 0);
    if (inSet(STACK_SHIPS, pType(m, p))) {
      m.setB(NET_SYNC, 0);
      carryCargo(m, sx, sy, pX(m, p), pY(m, p), idx);
    }
    req.player = player;
    req.index = idx;
    req.code = RequestCode.MOVED;
    req.w6 = m.w(MOVE_STEP);
    req.ptype = pType(m, p);
    req.pos = start;
    host.request(m, req, reply);
    m.setB(STEP_NOTEWORTHY, noteworthy ? 1 : 0);
    if (pType(m, p) !== REMOVED) {
      req.pos = m.w(p + 6);
      req.code = noteworthy ? RequestCode.STEP_DONE_NOTEWORTHY : RequestCode.STEP_DONE;
      req.flag = m.b(SHOW_MOVE);
      host.request(m, req, reply);
    }
    m.setB(NET_SYNC, 1);
  }
  if (m.sb(GAME_MODE) === 2 && battle) m.setB(STEP_NOTEWORTHY, 1);
}

/** CODE 6 + 0x658A: wake player 2's pieces with a type in `typeSet` (single-player games). */
export function wakePlayer2Types(m: Mem, typeSet: number): void {
  const n = pieceCount(m);
  for (let i = 1; i <= n; i++) {
    const r = pieceAt(i);
    if (pOwner(m, r) === 2 && inSet(typeSet, pType(m, r), 15)) setState(m, r, 1);
  }
}

