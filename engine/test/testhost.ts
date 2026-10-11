/**
 * A scripted host for differential tests: answers direction requests from a list of
 * actions shared with the Python harness, and logs everything the engine emits.
 *
 * Actions (consumed one per direction request):
 *   ["dir", dx, dy]        reply with a direction
 *   ["sleep"]              put the piece to sleep (state 2)
 *   ["goto", ox, oy]       give go-to orders to (x + ox, y + oy)
 *   ["defer"]              defer the piece (PIECE_DEFERRED)
 *   ["done"]               end the piece's moves (PIECE_DONE)
 * When the list runs out, the reply is (0, 0).
 *
 * A production request (code 6) takes the next type from `production`, if any; a request to
 * set a password (code 24) is answered with testPassword(player).
 */
import { Mem } from "../src/mem.ts";
import { PIECE_DEFERRED, PIECE_DONE } from "../src/globals.ts";
import { RequestCode, type Host, type Message, type Reply, type Request } from "../src/host.ts";
import { setDestination } from "../src/moveops.ts";
import { pieceAt, setState } from "../src/piece.ts";

export type Action = [string, ...number[]];

/** The password a test controller gives for `player`: a Pascal string in 6 bytes. */
export function testPassword(player: number): number[] {
  return [3, 0x50, 0x57, 0x30 + player, 0, 0];
}

export class TestHost implements Host {
  private next = 0;
  private actions: Action[];
  private log: unknown[];
  private ignore: [number, number][];

  /** `ignore`: [A5 offset, size] ranges left out of the state digest logged with requests. */
  constructor(actions: Action[], log: unknown[], ignore: [number, number][] = []) {
    this.actions = actions;
    this.log = log;
    this.ignore = ignore;
  }

  /** FNV-1a digest of the globals, with the ignored ranges zeroed. */
  private digest(m: Mem): number {
    const copy = m.u8.slice();
    for (const [off, size] of this.ignore) copy.fill(0, off + copy.length, off + copy.length + size);
    let h = 0x811c9dc5;
    for (let i = 0; i < copy.length; i++) {
      h ^= copy[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  /** Production choices, one per production request. */
  production: number[] = [];

  /** Request number (counting all requests) at which to log a full globals snapshot. */
  snapAt = -1;
  private count = 0;

  request(m: Mem, req: Request, reply: Reply): void {
    if (this.count++ === this.snapAt) this.log.push(["snap", Buffer.from(m.u8).toString("base64")]);
    this.log.push(["req", Array.from(req.rec), this.digest(m)]);
    if (req.code === RequestCode.PASSWORD && req.rec[8] === 1) req.rec.set(testPassword(req.player), 2);
    if (req.code === RequestCode.PRODUCTION && this.production.length > 0) req.ptype = this.production.shift()!;
    if (req.code !== 5) return;
    const a = this.actions[this.next++] ?? ["dir", 0, 0];
    const p = pieceAt(req.index);
    const x = (req.pos << 24) >> 24, y = (req.pos << 16) >> 24;
    switch (a[0]) {
      case "dir":
        reply.dx = a[1];
        reply.dy = a[2];
        break;
      case "sleep":
        setState(m, p, 2);
        reply.dx = 0;
        reply.dy = 0;
        break;
      case "goto":
        setDestination(m, p, x + a[1], y + a[2]);
        reply.dx = 0;
        reply.dy = 0;
        break;
      case "defer":
        m.setB(PIECE_DEFERRED, 1);
        reply.dx = 0;
        reply.dy = 0;
        break;
      case "done":
        m.setB(PIECE_DONE, 1);
        reply.dx = 0;
        reply.dy = 0;
        break;
    }
  }

  message(_m: Mem, msg: Message): void {
    this.log.push(["msg", msg.id, msg.subst1, msg.subst2, msg.line, msg.player, msg.all, msg.wait]);
  }

  beep(_m: Mem, player: number): void {
    this.log.push(["beep", player]);
  }

  report(_m: Mem, entry: Record<string, number>): void {
    this.log.push(["report", entry]);
  }

  event(_m: Mem, name: string, data: Record<string, number>): void {
    this.log.push(["event", name, data]);
  }

  aiPlan(_m: Mem): void {
    this.log.push(["aiPlan"]);
  }

  aiNewPiece(_m: Mem, city: number): void {
    this.log.push(["aiNewPiece", city]);
  }

  aiNewGame(_m: Mem): void {
    this.log.push(["aiNewGame"]);
  }

  aiNewSide(_m: Mem): void {
    this.log.push(["aiNewSide"]);
  }

  /** Value returned for the clock. */
  clock = 0;

  dateTime(_m: Mem): number {
    return this.clock;
  }
}
