/**
 * The browser as the engine's host for two players sharing one device (game mode 1): the
 * human controller answers the engine's requests from the player's commands, shows
 * messages, and redraws the map as pieces move.
 */
import { Mem } from "../../engine/src/mem.ts";
import { DAY, LOCAL_PLAYER, MOVES_LEFT, WATER } from "../../engine/src/globals.ts";
import { type Host, type Message, Reply, Request, RequestCode } from "../../engine/src/host.ts";
import { terrainNear } from "../../engine/src/map.ts";
import { PASSWORDS } from "../../engine/src/newgame.ts";
import * as orders from "../../engine/src/orders.ts";
import {
  pBit5, pCargo, pieceAt, pOwner, pPatrol, pState, pStrength, pType, pX, pY,
} from "../../engine/src/piece.ts";
import { cityAt, cityRec, productionDays } from "../../engine/src/units.ts";
import { Input } from "./input.ts";
import { messageText } from "./text.ts";
import { UI, type ProductionChoice } from "./ui.ts";
import { MapView } from "./view.ts";

/** Seconds between 1904 (the Mac's epoch) and 1970. */
const MAC_EPOCH = 2082844800;
const SHIPS = [2, 3, 4, 5, 6];
const FUEL_TYPES = [1, 7];
const CARGO_TYPES = [4, 5];

/** Hints shown while a command waits for a click or a drag. */
const MODE_HINTS: Record<string, string> = {
  w: "Wake: click a square.",
  l: "Load: click your Transport.",
  p: "Patrol: drag from the piece to the far end of the patrol.",
  m: "Stack move: drag from the square to the destination.",
  a: "Army destination: drag from your city to the destination.",
  c: "Aircraft destination: drag from your city to the destination.",
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class BrowserHost implements Host {
  /** The player at the device, as far as the screen is concerned. */
  private present = 0;
  private beeper: AudioContext | null = null;
  private readonly ui: UI;
  private readonly view: MapView;
  private readonly input: Input;

  constructor(ui: UI, view: MapView, input: Input) {
    this.ui = ui;
    this.view = view;
    this.input = input;
  }

  redraw(m: Mem): void {
    this.ui.setStatus(m.sw(DAY), m.sb(LOCAL_PLAYER));
    this.view.draw(m);
  }

  async request(m: Mem, req: Request, reply: Reply): Promise<void> {
    switch (req.code) {
      case RequestCode.DIRECTION:
        await this.direction(m, req, reply);
        return;
      case RequestCode.PRODUCTION:
        await this.production(m, req);
        return;
      case RequestCode.PASSWORD:
        await this.password(m, req);
        return;
      case RequestCode.HANDOFF_SCREEN:
        await this.handoff(m, req.player);
        return;
      case RequestCode.HIDE_MAP:
        this.view.hidden = true;
        this.redraw(m);
        return;
      case RequestCode.SHOW_MAP:
        this.view.hidden = false;
        this.view.viewer = m.sb(LOCAL_PLAYER);
        this.redraw(m);
        return;
      case RequestCode.TURN_START:
        this.view.viewer = m.sb(LOCAL_PLAYER);
        this.redraw(m);
        return;
      case RequestCode.SHOW_POSITION:
        if (req.player === this.view.viewer) this.view.reveal(req.pos & 0xff, req.pos >> 8, this.ui.mapWrap);
        return;
      case RequestCode.STEP_DONE:
      case RequestCode.STEP_DONE_NOTEWORTHY:
        // A step the viewer can see is shown briefly, so moves under orders can be followed.
        if (req.flag && !this.view.hidden && req.player === this.view.viewer) {
          this.redraw(m);
          await delay(40);
        }
        return;
      default:
        return;
    }
  }

  /** The device goes to `player` unless they already have it. */
  private async passTo(m: Mem, player: number, text: string): Promise<void> {
    if (this.present === player) return;
    this.view.hidden = true;
    this.redraw(m);
    await this.ui.passTo(player, text);
    this.present = player;
    this.view.hidden = false;
    this.view.viewer = player;
    this.redraw(m);
  }

  private async handoff(m: Mem, player: number): Promise<void> {
    this.present = 0;
    await this.passTo(m, player, `Pass the device to player ${player} for their turn.`);
    const stored = this.storedPassword(m, player);
    if (stored) await this.ui.password(player, stored);
  }

  private storedPassword(m: Mem, player: number): string {
    const at = PASSWORDS[player];
    const len = Math.min(m.b(at), 5);
    let s = "";
    for (let i = 1; i <= len; i++) s += String.fromCharCode(m.b(at + i));
    return s;
  }

  private async password(m: Mem, req: Request): Promise<void> {
    if (req.rec[8] !== 1) return;
    await this.passTo(m, req.player, `Player ${req.player} sets up first.`);
    const value = await this.ui.password(req.player, null);
    req.rec.fill(0, 2, 8);
    req.rec[2] = value.length;
    for (let i = 0; i < value.length; i++) req.rec[3 + i] = value.charCodeAt(i);
  }

  private async production(m: Mem, req: Request): Promise<void> {
    const x = req.pos & 0xff, y = req.pos >> 8;
    await this.passTo(m, req.player, `Player ${req.player} chooses what the city builds.`);
    this.view.reveal(x, y, this.ui.mapWrap);
    const dlg = orders.openProduction(m, x, y, req.player, true);
    req.ptype = await this.chooseProduction(m, req.player, x, y, dlg);
    this.redraw(m);
  }

  private async chooseProduction(m: Mem, player: number, x: number, y: number, dlg: orders.ProductionDialog): Promise<number> {
    const coastal = terrainNear(m, x, y, 1 << WATER);
    const choices: ProductionChoice[] = [0, 1, 2, 3, 5, 4, 6, 7].map((type) => ({
      type, days: productionDays(m, type), allowed: coastal || !SHIPS.includes(type),
    }));
    const type = await this.ui.production(player, x, y, m.sb(cityRec(dlg.city) + 8), choices);
    orders.chooseProduction(m, dlg, type);
    return type;
  }

  /** The direction request: the player commands until one of the commands answers it. */
  private async direction(m: Mem, req: Request, reply: Reply): Promise<void> {
    const player = m.sb(LOCAL_PLAYER);
    const p = pieceAt(req.index);
    this.view.focus = req.index;
    this.view.reveal(pX(m, p), pY(m, p), this.ui.mapWrap);
    let mode = "";
    const show = () => {
      this.ui.showPiece({
        player: pOwner(m, p), type: pType(m, p), x: pX(m, p), y: pY(m, p), movesLeft: m.sw(MOVES_LEFT),
        strength: pStrength(m, p), orders: describeOrders(m, p),
        extra: FUEL_TYPES.includes(pType(m, p)) || CARGO_TYPES.includes(pType(m, p)) ? pCargo(m, p) : -1,
      });
      this.ui.setHint(MODE_HINTS[mode] ?? "Move with the keypad or arrow keys, click a square next to the piece, or drag to a destination.");
      this.redraw(m);
    };
    show();
    await frame();
    this.input.clear();
    this.input.enabled = true;
    try {
      for (;;) {
        const c = await this.input.next();
        let done = false;
        if (c.kind === "dir") {
          reply.dx = c.dx;
          reply.dy = c.dy;
          done = true;
        } else if (c.kind === "key") {
          switch (c.key) {
            case "s": done = orders.sleep(m, req, reply, player); break;
            case "r": done = orders.random(m, req, reply, player); break;
            case "n": done = orders.skip(m, reply); break;
            case "b": done = orders.moveLater(m, reply); break;
            case "escape": mode = ""; break;
            default: mode = c.key;
          }
        } else if (c.kind === "click") {
          if (mode === "w") orders.wake(m, c.x, c.y);
          else if (mode === "l") done = orders.load(m, req, reply, player, c.x, c.y);
          else done = orders.clickDirection(req, reply, c.x, c.y);
          if (mode === "w" || mode === "l") mode = "";
        } else if (c.kind === "drag") {
          switch (mode) {
            case "p": done = orders.patrol(m, req, reply, player, c.x, c.y, c.tx, c.ty); break;
            case "m": done = orders.stackMove(m, req, reply, player, c.x, c.y, c.tx, c.ty); break;
            case "a": orders.armyDestination(m, player, c.x, c.y, c.tx, c.ty); break;
            case "c": done = orders.aircraftDestination(m, req, reply, player, c.x, c.y, c.tx, c.ty); break;
            default: done = orders.goTo(m, req, reply, player, c.x, c.y, c.tx, c.ty);
          }
          mode = "";
        } else if (c.kind === "open") {
          await this.openCity(m, player, c.x, c.y);
        }
        if (done) break;
        show();
      }
    } finally {
      this.input.enabled = false;
      this.view.focus = 0;
      this.ui.showPiece(null);
      this.ui.setHint("");
    }
  }

  /** A double-click on one of the player's cities opens its production dialog. */
  private async openCity(m: Mem, player: number, x: number, y: number): Promise<void> {
    const city = cityAt(m, x, y);
    if (city === 0 || m.sb(cityRec(city) + 4) !== player) return;
    this.input.enabled = false;
    const dlg = orders.openProduction(m, x, y, player, false);
    await this.chooseProduction(m, player, x, y, dlg);
    this.input.enabled = true;
  }

  message(m: Mem, msg: Message): void {
    if (!msg.all && msg.player !== m.sb(LOCAL_PLAYER)) return;
    this.ui.setLine(msg.line, messageText(msg));
  }

  beep(_m: Mem, _player: number): void {
    try {
      this.beeper ??= new AudioContext();
      const ctx = this.beeper;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch {
      // Sound is optional.
    }
  }

  report(_m: Mem, _entry: Record<string, number>): void {}

  event(_m: Mem, _name: string, _data: Record<string, number>): void {}

  aiPlan(_m: Mem): void {}

  aiNewPiece(_m: Mem, _city: number): void {}

  aiNewGame(_m: Mem): void {}

  aiNewSide(_m: Mem): void {}

  dateTime(_m: Mem): number {
    return (Math.floor(Date.now() / 1000) + MAC_EPOCH) >>> 0;
  }
}

/** The piece's standing orders, in words. */
function describeOrders(m: Mem, p: number): string {
  switch (pState(m, p)) {
    case 0:
      if (pBit5(m, p)) return "Random moves";
      if (pPatrol(m, p)) return `Patrol to ${m.sb(p + 3)}, ${m.sb(p + 2)}`;
      return `Go to ${m.sb(p + 3)}, ${m.sb(p + 2)}`;
    case 2: return "Asleep";
    case 3: return "Loading";
    default: return "";
  }
}
