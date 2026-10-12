/**
 * What the engine needs from its surroundings: the side's controller (human interface or
 * computer opponent), messages, sounds and the battle summary.
 *
 * The original routes every decision and notification through one routine
 * (CODE 5 + 0x5CBA) with a 12-byte request record:
 *
 *   0     request code (see RequestCode)
 *   1     player
 *   2     piece type (some codes)
 *   4-5   position (y, x)
 *   6-7   moves left, or the step number (code 1)
 *   8-9   piece index
 *   10    flag (codes 21/22: the piece is visible to the local player)
 *
 * A production request (code 6) is answered in byte 2, the type chosen. A password request
 * (code 24) carries the password in bytes 2-7 (a Pascal string of up to 5 characters); byte
 * 8 is 1 to set it, 0 to check it.
 *
 * Fields a request does not set keep whatever the record held before; the engine keeps one
 * record per caller frame, as the original does, so they match.
 *
 * Requests are the engine's only waits: every function that leads to one is async, and
 * test/promises.ts checks that each such call is awaited.
 */
import { Mem } from "./mem.ts";

export const RequestCode = {
  PIECE_BUILT: 0,
  MOVED: 1,
  BEFORE_STEP: 3,
  CITY_REPELLED_OR_NEUTRAL: 4,
  DIRECTION: 5,
  PRODUCTION: 6,
  HANDOFF_SCREEN: 8,
  SHOW_MAP: 15,
  BATTLE: 16,
  HIDE_MAP: 17,
  BOMBER_BLAST_DONE: 18,
  SHOW_POSITION: 19,
  TURN_START: 20,
  STEP_DONE: 21,
  STEP_DONE_NOTEWORTHY: 22,
  PASSWORD: 24,
} as const;

export class Request {
  readonly rec = new Uint8Array(12);

  get code(): number { return this.rec[0]; }
  set code(v: number) { this.rec[0] = v & 0xff; }
  get player(): number { return this.rec[1]; }
  set player(v: number) { this.rec[1] = v & 0xff; }
  get ptype(): number { return this.rec[2]; }
  set ptype(v: number) { this.rec[2] = v & 0xff; }
  get pos(): number { return (this.rec[4] << 8) | this.rec[5]; }
  set pos(v: number) { this.rec[4] = (v >> 8) & 0xff; this.rec[5] = v & 0xff; }
  get w6(): number { return (this.rec[6] << 8) | this.rec[7]; }
  set w6(v: number) { this.rec[6] = (v >> 8) & 0xff; this.rec[7] = v & 0xff; }
  get index(): number { return (this.rec[8] << 8) | this.rec[9]; }
  set index(v: number) { this.rec[8] = (v >> 8) & 0xff; this.rec[9] = v & 0xff; }
  get flag(): number { return this.rec[10]; }
  set flag(v: number) { this.rec[10] = v & 0xff; }
}

/** Reply buffer for a request: a direction (dx, dy) for code 5. */
export class Reply {
  readonly buf = new Uint8Array(2);

  get dx(): number { return (this.buf[0] << 24) >> 24; }
  set dx(v: number) { this.buf[0] = v & 0xff; }
  get dy(): number { return (this.buf[1] << 24) >> 24; }
  set dy(v: number) { this.buf[1] = v & 0xff; }
}

/**
 * A message for a player: STR resource `id` with substitutions. From messageA, `subst1` is a
 * number for ^0 (-1 for none) and `subst2` is -1. From messageB, `subst1` is a STR ID for ^0
 * and `subst2` a number for ^1. `player` sees it, or everyone when `all` is set. `line` and
 * `wait` are the original's display arguments (message line, and whether the message
 * pauses).
 */
export interface Message {
  id: number;
  subst1: number;
  subst2: number;
  line: number;
  player: number;
  all: number;
  wait: number;
}

/** The empty message (STR 1013, no number), which clears a message line. */
export const CLEAR_LINE = 0xffff03f5;

/** CODE 1 + 0x3520: message from a long (number << 16 | id). */
export function messageA(m: Mem, host: Host, msg: number, line: number, player: number, all: number, wait: number): void {
  host.message(m, { id: msg & 0xffff, subst1: (msg << 0) >> 16, subst2: -1, line, player, all, wait });
}

/** CODE 1 + 0x35E2: message from a long (STR ID << 16 | id) and a second long (line << 16 | number). */
export function messageB(m: Mem, host: Host, msg: number, flags: number, player: number, all: number, wait: number): void {
  host.message(m, {
    id: msg & 0xffff, subst1: (msg << 0) >> 16, subst2: (flags << 16) >> 16, line: flags >>> 16, player, all, wait,
  });
}

export interface Host {
  /**
   * CODE 5 + 0x5CBA: a request to the controller of `req.player`. The engine waits for it:
   * a human player's answer comes from the user interface, or from the other browser in a
   * network game.
   */
  request(m: Mem, req: Request, reply: Reply): Promise<void>;
  /** A message shown to a player. */
  message(m: Mem, msg: Message): void;
  /** CODE 1 + 0x0928: the error beep for a human player's refused move. */
  beep(m: Mem, player: number): void;
  /** An entry for the battle summary (CODE 1 + 0x2140 and relatives). */
  report(m: Mem, entry: Record<string, number>): void;
  /**
   * Notifications for the user interface only. "sound": the system beep, which cuts off any
   * sound playing (CODE 1 + 0x123E).
   */
  event(m: Mem, name: string, data: Record<string, number>): void;
  /** CODE 7 + 0x11EA: the computer opponent plans (start of its turn, after each build). */
  aiPlan(m: Mem): void;
  /** CODE 1 + 0x0626: the computer opponent handles a piece just built in city `city`. */
  aiNewPiece(m: Mem, city: number): void;
  /** CODE 2 + 0x2E3A: the computer opponent's start-of-game analysis of the world (game mode 0). */
  aiNewGame(m: Mem): void;
  /**
   * CODE 2 + 0x24DE: the computer opponent's start-of-game set-up for the side whose data is
   * current; called for each side, the sides being swapped in between.
   */
  aiNewSide(m: Mem): void;
  /**
   * CODE 1 + 0x1A18: the start of a day, after the autosave, where the original carries out
   * menu actions deferred until the day's end (CODE 10 + 0x0A8A): saving, resuming a saved
   * game, starting a new game, quitting. A resumed game replaces the globals; the day goes
   * on with it.
   */
  dayStart(m: Mem): Promise<void>;
  /** The clock (ReadDateTime: seconds since 1904) that reseeds the game PRNG each day. */
  dateTime(m: Mem): number;
}
