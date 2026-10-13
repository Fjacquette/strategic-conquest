/**
 * The computer opponent as a host plugs it in.
 *
 * In the original, ControllerRequest (CODE 5 + 0x5CBA) hands a computer player's direction
 * requests to its move chooser, and its production requests and the start of its turn to
 * its production routine; its other requests (battles, blasts, steps) go to the human
 * controller like a human player's, which shows them. Its planning, new-piece and
 * start-of-game routines are called by the game where they apply (Host.aiPlan and the
 * others).
 */
import { Mem } from "../mem.ts";
import { RequestCode, type Reply, type Request } from "../host.ts";
import { aiMoveChooser } from "./chooser.ts";
import { aiPlan } from "./plan.ts";
import { aiNewPiece, aiProduction } from "./production.ts";
import { aiNewGame, aiNewSide } from "./setup.ts";

/**
 * Answer request `req` for a computer player, if it is the computer's to answer (a
 * direction, production or turn-start request; the turn start is also the user
 * interface's, which the host shows first). Returns whether it was.
 */
export function computerRequest(m: Mem, req: Request, reply: Reply): boolean {
  switch (req.code) {
    case RequestCode.DIRECTION:
      aiMoveChooser(m, req, reply);
      return true;
    case RequestCode.PRODUCTION:
    case RequestCode.TURN_START:
      aiProduction(m);
      return true;
    default:
      return false;
  }
}

/** The computer opponent's routines behind Host.aiPlan, aiNewPiece, aiNewGame and aiNewSide. */
export const computerHooks = { aiPlan, aiNewPiece, aiNewGame, aiNewSide };
