/**
 * The network game: the original's AppleTalk Master and Slave (docs/network.md), over a
 * direct connection between the two players' pages (link.ts).
 *
 * The Master (player 1) runs the whole game: every day, both players' turns, all the rules.
 * The Slave (player 2) keeps a copy of the game state and runs player 2's user interface.
 * As in the original, the Master sends the Slave the requests player 2's controller answers
 * (moves, production) and the notifications both players see (moves, battles, the start of
 * a turn), and waits for the Slave to finish each one; what player 2's commands change comes
 * back with the answer. Instead of mirroring each state routine as the original does, each
 * packet carries the bytes of the game state that changed since the last one.
 */
import { GLOBALS_SIZE, Mem } from "../../engine/src/mem.ts";
import { LOCAL_PLAYER, QD_RANDSEED } from "../../engine/src/globals.ts";
import { type Host, type Message, Reply, Request, RequestCode } from "../../engine/src/host.ts";
import { BrowserHost } from "./host.ts";
import { Link } from "./link.ts";

/** Which version of this protocol a page speaks; both players need the same. */
export const PROTOCOL = 1;

/** Packet kinds. */
const HELLO = 1;
const REQUEST = 2;
const ANSWER = 3;
const MESSAGE = 4;
const BEEP = 5;
const EVENT = 6;

/**
 * Notifications shown to both players, whoever's piece it is (CODE 5 + 0x5CBA, the set at
 * 0x5F06): a piece built, a step, a battle, a Bomber's blast, the start of a turn, the end of
 * a step.
 */
const SHOWN_TO_BOTH = new Set<number>([
  RequestCode.PIECE_BUILT, RequestCode.MOVED, RequestCode.BATTLE, RequestCode.BOMBER_BLAST_DONE,
  RequestCode.TURN_START, RequestCode.STEP_DONE, RequestCode.STEP_DONE_NOTEWORTHY,
]);

/**
 * Bytes of the state each page keeps for itself: which player is at this page, QuickDraw's
 * random seed (the battle display draws on it), and two words of the user interface's.
 */
const LOCAL_ONLY: readonly [number, number][] = [[LOCAL_PLAYER, 1], [QD_RANDSEED, 4], [-0x1386, 4], [-0x1920, 4]];
const LOCAL = new Uint8Array(GLOBALS_SIZE);
for (const [off, size] of LOCAL_ONLY) LOCAL.fill(1, off + GLOBALS_SIZE, off + GLOBALS_SIZE + size);

/** Equal bytes a run of changes may span rather than starting a new run. */
const RUN_GAP = 4;

/**
 * The bytes of `cur` that differ from `base` (local bytes excepted), as runs: a 16-bit
 * offset, a 16-bit length, the bytes.
 */
export function diffImage(cur: Uint8Array, base: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = cur.length;
  let i = 0;
  while (i < n) {
    if (cur[i] === base[i] || LOCAL[i]) {
      i++;
      continue;
    }
    let end = i + 1;
    for (let j = end; j < n && j - end <= RUN_GAP && !LOCAL[j]; j++) {
      if (cur[j] !== base[j]) end = j + 1;
    }
    out.push(i >> 8, i & 0xff, (end - i) >> 8, (end - i) & 0xff);
    for (let k = i; k < end; k++) out.push(cur[k]);
    i = end;
  }
  return Uint8Array.from(out);
}

/** Write the runs of `diff` into `image`. */
export function applyDiff(image: Uint8Array, diff: Uint8Array): void {
  let pos = 0;
  while (pos + 4 <= diff.length) {
    const off = (diff[pos] << 8) | diff[pos + 1];
    const len = (diff[pos + 2] << 8) | diff[pos + 3];
    image.set(diff.subarray(pos + 4, pos + 4 + len), off);
    pos += 4 + len;
  }
}

/** A packet: its kind, a small JSON header, and state changes. */
interface Packet {
  kind: number;
  head: any;
  diff: Uint8Array;
}

function encodePacket(kind: number, head: unknown, diff: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(head ?? null));
  const out = new Uint8Array(5 + json.length + diff.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, json.length);
  out.set(json, 5);
  out.set(diff, 5 + json.length);
  return out;
}

function decodePacket(data: Uint8Array): Packet {
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
  const head = JSON.parse(new TextDecoder().decode(data.subarray(5, 5 + size)));
  return { kind: data[0], head, diff: data.subarray(5 + size) };
}

/** The connection lost while a page waited on it. */
export class LostConnection extends Error {
  constructor() {
    super("The connection to the other player was lost.");
  }
}

/**
 * Packets in order of arrival, for one page; and the image of the game state as the other
 * page last had it, against which changes are sent.
 */
export class Channel {
  readonly synced = new Uint8Array(GLOBALS_SIZE);
  private readonly link: Link;
  private readonly queue: Packet[] = [];
  private readonly waiters: { resolve: (p: Packet) => void; reject: (e: Error) => void }[] = [];
  private lost = false;

  constructor(link: Link) {
    this.link = link;
    link.onMessage = (data) => {
      const p = decodePacket(data);
      const w = this.waiters.shift();
      if (w) w.resolve(p);
      else this.queue.push(p);
    };
    link.onClose = () => {
      this.lost = true;
      for (const w of this.waiters.splice(0)) w.reject(new LostConnection());
    };
  }

  /** Send a packet with the state's changes since the last one (none if `m` is null). */
  send(kind: number, head: unknown, m: Mem | null): void {
    let diff = new Uint8Array(0);
    if (m) {
      diff = diffImage(m.u8, this.synced);
      this.synced.set(m.u8);
    }
    this.link.send(encodePacket(kind, head, diff));
  }

  /** The next packet; its state changes are applied to `m` (and to the synced image). */
  async next(m: Mem | null): Promise<Packet> {
    const p = this.queue.shift() ?? await new Promise<Packet>((resolve, reject) => {
      if (this.lost) reject(new LostConnection());
      else this.waiters.push({ resolve, reject });
    });
    if (m) applyDiff(m.u8, p.diff);
    applyDiff(this.synced, p.diff);
    return p;
  }

  close(): void {
    this.link.close();
  }
}

/** Exchange protocol versions; throws if the other page speaks another. */
export async function greet(channel: Channel): Promise<void> {
  channel.send(HELLO, { protocol: PROTOCOL }, null);
  const p = await channel.next(null);
  if (p.kind !== HELLO || p.head?.protocol !== PROTOCOL) {
    throw new Error("The other player's game is a different version. Both players need the same game page.");
  }
}

/**
 * The Master's host: player 1's user interface here, player 2's at the Slave. Network games
 * have no computer player and, in this version, no passwords: a password request keeps the
 * blank password it carries.
 */
export class MasterHost implements Host {
  private readonly local: BrowserHost;
  private readonly channel: Channel;

  constructor(local: BrowserHost, channel: Channel) {
    this.local = local;
    this.channel = channel;
  }

  async request(m: Mem, req: Request, reply: Reply): Promise<void> {
    if (req.code === RequestCode.PASSWORD) return;
    const both = SHOWN_TO_BOTH.has(req.code);
    if (!both && (req.player !== 2 || req.code === RequestCode.BEFORE_STEP)) {
      await this.local.request(m, req, reply);
      return;
    }
    this.channel.send(REQUEST, { req: Array.from(req.rec), reply: Array.from(reply.buf) }, m);
    if (both) await this.local.request(m, req, reply);
    const answer = await this.channel.next(m);
    if (answer.kind !== ANSWER) throw new Error(`unexpected packet ${answer.kind}`);
    req.rec.set(answer.head.req);
    reply.buf.set(answer.head.reply);
  }

  message(m: Mem, msg: Message): void {
    this.local.message(m, msg);
    if (msg.all || msg.player === 2) this.channel.send(MESSAGE, msg, null);
  }

  beep(m: Mem, player: number): void {
    if (player === 2) this.channel.send(BEEP, null, null);
    else this.local.beep(m, player);
  }

  report(m: Mem, entry: Record<string, number>): void {
    this.local.report(m, entry);
  }

  event(m: Mem, name: string, data: Record<string, number>): void {
    this.local.event(m, name, data);
    if (name === "clearReports" || (name === "battleSummary" && data.player === 2)) {
      this.channel.send(EVENT, { name, data }, null);
    }
  }

  dayStart(m: Mem): Promise<void> {
    return this.local.dayStart(m);
  }

  aiPlan(_m: Mem): void {}

  aiNewPiece(_m: Mem, _city: number): void {}

  aiNewGame(_m: Mem): void {}

  aiNewSide(_m: Mem): void {}

  dateTime(m: Mem): number {
    return this.local.dateTime(m);
  }
}

/**
 * The Slave: player 2's user interface for the Master's game, until the connection is lost
 * (which throws LostConnection).
 */
export async function runSlave(channel: Channel, local: BrowserHost, m: Mem): Promise<void> {
  for (;;) {
    const p = await channel.next(m);
    m.setB(LOCAL_PLAYER, 2);
    switch (p.kind) {
      case REQUEST: {
        const req = new Request();
        const reply = new Reply();
        req.rec.set(p.head.req);
        reply.buf.set(p.head.reply);
        await local.request(m, req, reply);
        channel.send(ANSWER, { req: Array.from(req.rec), reply: Array.from(reply.buf) }, m);
        break;
      }
      case MESSAGE:
        local.message(m, p.head as Message);
        break;
      case BEEP:
        local.beep(m, 2);
        break;
      case EVENT:
        local.event(m, p.head.name, p.head.data);
        break;
    }
  }
}
