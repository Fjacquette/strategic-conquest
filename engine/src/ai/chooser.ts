/**
 * The computer opponent's answer to a direction request for one of its pieces
 * (CODE 6 + 0x5102, reached from ControllerRequest for request code 5).
 */
import { Mem } from "../mem.ts";
import { ARMY, BATTLESHIP, BOMBER, CARRIER, DESTROYER, FIGHTER, SUBMARINE, TRANSPORT } from "../globals.ts";
import { type Reply, type Request } from "../host.ts";
import { pieceAt, pState, pType } from "../piece.ts";
import { armyMove } from "./armies.ts";
import { bomberMove } from "./bombers.ts";
import { REPLY_DX, REPLY_DY } from "./data.ts";
import { fighterMove } from "./fighters.ts";
import { followOrders, setReply } from "./moves.ts";
import { shipMove } from "./ships.ts";
import { transportArrives, transportMove } from "./transports.ts";

/** Copy the computer's chosen step into the reply. */
function answer(m: Mem, reply: Reply): void {
  reply.dx = m.sb(REPLY_DX);
  reply.dy = m.sb(REPLY_DY);
}

/**
 * CODE 6 + 0x5102: the step for the computer's piece named by a direction request (code
 * 5). A piece under orders follows them (a Bomber decides afresh; a Transport that has
 * arrived at its island waits for the next request); an awake piece is moved by its
 * type's routine, which may instead give it orders or put it to sleep; asleep and loading
 * pieces are left alone. Returns whether a routine for the piece's type ran.
 */
export function aiMoveChooser(m: Mem, req: Request, reply: Reply): boolean {
  if (req.code !== 5) return false;
  const idx = req.index;
  const p = pieceAt(idx);
  const state = pState(m, p);
  if (state === 0) {
    reply.dx = 0;
    reply.dy = 0;
    switch (pType(m, p)) {
      case ARMY: case FIGHTER: case DESTROYER: case SUBMARINE: case CARRIER: case BATTLESHIP:
        followOrders(m, idx, reply);
        break;
      case TRANSPORT:
        if (!transportArrives(m, idx)) followOrders(m, idx, reply);
        break;
      case BOMBER:
        setReply(m, 0, 0);
        bomberMove(m, idx);
        answer(m, reply);
        break;
    }
    return true;
  }
  if (state !== 1) return false;
  setReply(m, 0, 0);
  reply.dx = 0;
  reply.dy = 0;
  let moved = true;
  switch (pType(m, p)) {
    case ARMY: armyMove(m, idx); break;
    case FIGHTER: fighterMove(m, idx); break;
    case DESTROYER: case SUBMARINE: case CARRIER: case BATTLESHIP: shipMove(m, idx); break;
    case TRANSPORT: transportMove(m, idx); break;
    case BOMBER: bomberMove(m, idx); break;
    default: moved = false;
  }
  answer(m, reply);
  return moved;
}
