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
 *
 * With `computer` set, the computer opponent plays its players' sides, as in the original
 * with its routines running: its requests are answered by it (and not logged), and its
 * planning, new-piece and start-of-game routines run (unlogged). A human player's
 * production request then also does what the production dialog does to the city: it
 * becomes the player's and builds the type chosen (Armies if that is a ship and the city is
 * not next to water), as tools/emu/aigame.py does for the original.
 */
import { Mem } from "../src/mem.ts";
import { ARMY, PIECE_DEFERRED, PIECE_DONE, WATER } from "../src/globals.ts";
import { RequestCode, type Host, type Message, type Reply, type Request } from "../src/host.ts";
import { setDestination } from "../src/moveops.ts";
import { inSet, isComputer, terrainAt } from "../src/map.ts";
import { pieceAt, setState } from "../src/piece.ts";
import { cityAt, setCityOwner } from "../src/units.ts";
import { computerHooks, computerRequest } from "../src/ai/opponent.ts";

export type Action = [string, ...number[]];

/** Ships (types 2-6). */
const SHIPS = 0x7c;

/**
 * The production dialog's effect on the city of production request `req` (a player's
 * starting city, or one just captured): the city becomes the player's and builds the type
 * in the request, or Armies if that is a ship and the city is not next to water.
 */
function chooseCityProduction(m: Mem, req: Request): void {
  const x = (req.rec[5] << 24) >> 24, y = (req.rec[4] << 24) >> 24;
  const city = cityAt(m, x, y);
  let coastal = false;
  for (let cx = x - 1; cx <= x + 1; cx++) {
    for (let cy = y - 1; cy <= y + 1; cy++) if (terrainAt(m, cx, cy) === WATER) coastal = true;
  }
  const ptype = inSet(SHIPS, req.ptype) && !coastal ? ARMY : req.ptype;
  setCityOwner(m, ARMY, city, req.player);
  setCityOwner(m, ptype, city, req.player);
}

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

  /** Whether the computer opponent plays its players' sides. */
  computer = false;

  async request(m: Mem, req: Request, reply: Reply): Promise<void> {
    if (this.computer && isComputer(m, req.player) && computerRequest(m, req, reply)) return;
    if (this.count++ === this.snapAt) this.log.push(["snap", Buffer.from(m.u8).toString("base64")]);
    this.log.push(["req", Array.from(req.rec), this.digest(m)]);
    if (req.code === RequestCode.PASSWORD && req.rec[8] === 1) req.rec.set(testPassword(req.player), 2);
    if (req.code === RequestCode.PRODUCTION && this.production.length > 0) req.ptype = this.production.shift()!;
    if (req.code === RequestCode.PRODUCTION && this.computer) chooseCityProduction(m, req);
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

  aiPlan(m: Mem): void {
    if (this.computer) computerHooks.aiPlan(m);
    else this.log.push(["aiPlan"]);
  }

  aiNewPiece(m: Mem, city: number): void {
    if (this.computer) computerHooks.aiNewPiece(m, city);
    else this.log.push(["aiNewPiece", city]);
  }

  aiNewGame(m: Mem): void {
    if (this.computer) computerHooks.aiNewGame(m);
    else this.log.push(["aiNewGame"]);
  }

  aiNewSide(m: Mem): void {
    if (this.computer) computerHooks.aiNewSide(m);
    else this.log.push(["aiNewSide"]);
  }

  /** Value returned for the clock. */
  clock = 0;

  async dayStart(_m: Mem): Promise<void> {}

  dateTime(_m: Mem): number {
    return this.clock;
  }
}
