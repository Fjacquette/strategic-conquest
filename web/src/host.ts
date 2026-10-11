/**
 * The browser as the engine's host for a game against the computer (game mode 0).
 *
 * Requests go to the controller of the player they are for, as in the original
 * (CODE 5 + 0x5CBA): a computer player's direction and production requests to the computer
 * opponent, everything else to the human controller, which shows it on the map, plays the
 * sounds and, for a direction request, takes the player's commands until one answers it.
 * Showing a fight also changes the game, as in the original: the attacker becomes spotted,
 * and an Army's fight draws a number from QuickDraw's generator (see docs/interface.md).
 * The computer opponent is not ported yet: its pieces stay where they are.
 */
import { Mem } from "../../engine/src/mem.ts";
import {
  ARMY, BOMBER, DAY, FIGHTER, GAME_MODE, LOCAL_PLAYER, MOVES_LEFT, OPPONENT_OF, OWN_CITY_CODE, PIECE_DONE, WATER,
} from "../../engine/src/globals.ts";
import { type Host, type Message, Reply, Request, RequestCode } from "../../engine/src/host.ts";
import { explored, isComputer, terrainNear } from "../../engine/src/map.ts";
import * as orders from "../../engine/src/orders.ts";
import { pieceAt, pOwner, pRadius, pSpotted, pState, pType, pX, pY, setSpotted } from "../../engine/src/piece.ts";
import { enemyAdjacent, foundEnemy } from "../../engine/src/query.ts";
import { qdRandom } from "../../engine/src/random.ts";
import { cityRec, productionDays } from "../../engine/src/units.ts";
import { Input } from "./input.ts";
import { CH, CW, MapView } from "./mapview.ts";
import { BATTLE, BLAST, EXPLOSION, Sound } from "./sound.ts";
import { Words } from "./text.ts";
import { UI, type ProductionChoice } from "./ui.ts";

/** Seconds between 1904 (the Mac's epoch) and 1970. */
const MAC_EPOCH = 2082844800;
const SHIPS = [2, 3, 4, 5, 6];
/** The piece being moved flashes: this long on, then this long off. */
const FLASH_MS = 300;
/** A step the player can see stays on screen this long. */
const STEP_MS = 60;
/** The system beep plays this long before the game goes on. */
const BEEP_MS = 200;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The original's waits are counted in ticks, sixtieths of a second. */
const ticks = (n: number) => delay((n * 1000) / 60);

export class BrowserHost implements Host {
  private readonly ui: UI;
  private readonly view: MapView;
  private readonly input: Input;
  private readonly words: Words;
  readonly sound: Sound;
  /** The game, while one is being played (for menu commands). */
  m: Mem | null = null;
  /** The direction request being answered, if any. */
  private current: { req: Request; reply: Reply } | null = null;
  private drawPending = false;

  constructor(ui: UI, view: MapView, input: Input, words: Words, sound: Sound) {
    this.ui = ui;
    this.view = view;
    this.input = input;
    this.words = words;
    this.sound = sound;
  }

  /** Redraw at the next frame. */
  redraw(m: Mem): void {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => {
      this.drawPending = false;
      this.view.draw(m);
    });
  }

  async request(m: Mem, req: Request, reply: Reply): Promise<void> {
    if (isComputer(m, req.player)) {
      if (req.code === RequestCode.DIRECTION) {
        // The computer opponent is not ported yet: its pieces stand still.
        m.setB(PIECE_DONE, 1);
        reply.dx = 0;
        reply.dy = 0;
        return;
      }
      if (req.code === RequestCode.PRODUCTION) return;
      if (req.code === RequestCode.TURN_START) {
        this.ui.setTurn(false, null);
        this.redraw(m);
        return;
      }
    }
    await this.display(m, req, reply);
  }

  /** The human controller (CODE 5 + 0x51FE). */
  private async display(m: Mem, req: Request, reply: Reply): Promise<void> {
    const local = m.sb(LOCAL_PLAYER);
    switch (req.code) {
      case RequestCode.DIRECTION:
        await this.direction(m, req, reply);
        return;
      case RequestCode.PRODUCTION:
        await this.production(m, req.pos & 0xff, req.pos >> 8, local, true).then((t) => { req.ptype = t; });
        return;
      case RequestCode.TURN_START:
        this.ui.setTurn(req.player === local, null);
        this.redraw(m);
        return;
      case RequestCode.SHOW_POSITION:
        if (req.player === local) this.view.reveal(req.pos & 0xff, req.pos >> 8, this.ui.viewport);
        this.redraw(m);
        return;
      case RequestCode.CITY_REPELLED_OR_NEUTRAL:
      case RequestCode.BATTLE:
        this.view.reveal(req.pos & 0xff, req.pos >> 8, this.ui.viewport);
        await this.battle(m, req);
        return;
      case RequestCode.BOMBER_BLAST_DONE:
        await this.bomberBlast(m, req);
        return;
      case RequestCode.MOVED:
        this.view.noteMove(m, req.index, req.pos);
        return;
      case RequestCode.STEP_DONE:
      case RequestCode.STEP_DONE_NOTEWORTHY:
        if (req.flag) {
          this.stepSound(m, req);
          this.view.draw(m);
          await delay(STEP_MS);
        } else {
          this.redraw(m);
        }
        return;
      default:
        this.redraw(m);
    }
  }

  /**
   * The sound of a step (CODE 5 + 0x5218), made only where the player can see it: on a
   * square in view that he has explored, by a piece not aboard another. An Army sounds the
   * battle beside a spotted enemy piece or an enemy city; otherwise it marches, if it is his
   * own, without cutting off another sound. His Fighters, ships and Bombers sound their
   * own, cutting off any other sound, but not the same sound for the same type of piece.
   */
  private stepSound(m: Mem, req: Request): void {
    const local = m.sb(LOCAL_PLAYER);
    const x = req.pos & 0xff, y = req.pos >> 8;
    const p = pieceAt(req.index);
    if (!this.view.shows(x, y, this.ui.viewport) || !explored(m, local, x, y) || pState(m, p) >= 2) return;
    const type = pType(m, p), owner = pOwner(m, p);
    if (type === ARMY) {
      if (enemyAdjacent(m, req.index, owner, x, y)) {
        if (pSpotted(m, pieceAt(foundEnemy(m))) !== 0) this.sound.play(BATTLE, true);
        else this.sound.play(ARMY, false);
      } else if (terrainNear(m, x, y, 1 << m.sb(OWN_CITY_CODE + m.sb(OPPONENT_OF + owner)))) {
        this.sound.play(BATTLE, true);
      } else if (owner === local) {
        this.sound.play(ARMY, false);
      }
    } else if (owner === local && type >= FIGHTER && type <= BOMBER) {
      if (this.sound.done() || this.sound.last() !== type) this.sound.play(type, true);
    }
  }

  /**
   * A fight (CODE 17 + 0x0CC2), for a battle and for an attack on a city: the attacker
   * becomes spotted, the explosion sounds and the square flashes four times. At the second
   * flash an Army's fight changes to the battle sound (when the explosion has finished, or
   * on a coin toss with QuickDraw's generator), and any other piece's explosion starts again.
   */
  private async battle(m: Mem, req: Request): Promise<void> {
    const p = pieceAt(req.index);
    if (pSpotted(m, p) === 0) setSpotted(m, p, 1);
    const x = req.pos & 0xff, y = req.pos >> 8;
    this.sound.play(EXPLOSION, true);
    for (let flash = 1; flash <= 4; flash++) {
      if (flash === 2) {
        if (pType(m, p) === ARMY) {
          if ((qdRandom(m) & 1) !== 0 || this.sound.done()) this.sound.play(BATTLE, true);
        } else {
          this.sound.play(EXPLOSION, true);
        }
      }
      this.view.inverted = [x, y];
      this.view.draw(m);
      await ticks(4);
      this.view.inverted = null;
      this.view.draw(m);
      await ticks(8);
    }
  }

  /**
   * A Bomber's blast (CODE 5 + 0x5BDA, CODE 17 + 0x0E56). The computer's blast is announced
   * with a beep before and after the map scrolls to it. The blast's area is covered in dark
   * gray for two seconds, with the explosion.
   */
  private async bomberBlast(m: Mem, req: Request): Promise<void> {
    const x = req.pos & 0xff, y = req.pos >> 8;
    const enemy = m.sb(GAME_MODE) === 0 && req.player !== m.sb(LOCAL_PLAYER);
    if (enemy) await this.alert();
    this.view.reveal(x, y, this.ui.viewport);
    if (enemy) await this.alert();
    this.view.blast = { x, y, radius: Math.max(1, pRadius(m, pieceAt(req.index))) };
    this.sound.play(BLAST, true);
    this.view.draw(m);
    await ticks(121);
    this.view.blast = null;
    this.view.draw(m);
  }

  /** CODE 1 + 0x123E: the sound playing is cut off for the system beep. */
  private async alert(): Promise<void> {
    this.sound.stop();
    this.sound.beep();
    await delay(BEEP_MS);
  }

  /** The direction request: the player commands until one of the commands answers it. */
  private async direction(m: Mem, req: Request, reply: Reply): Promise<void> {
    const player = m.sb(LOCAL_PLAYER);
    const p = pieceAt(req.index);
    this.current = { req, reply };
    this.view.focus = req.index;
    this.view.reveal(pX(m, p), pY(m, p), this.ui.viewport);
    this.ui.setTurn(true, pType(m, p));
    let mode = "";
    const status = () => {
      this.ui.setLine(1, this.words.pieceStatus(m, p, m.sw(MOVES_LEFT)));
      if (mode) this.ui.setLine(2, this.words.str(MODE_HINTS[mode]));
    };
    status();
    this.view.flashOff = false;
    this.view.draw(m);
    const timer = setInterval(() => {
      this.view.flashOff = !this.view.flashOff;
      this.view.draw(m);
    }, FLASH_MS);
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
            default: if (c.key in MODE_HINTS) mode = c.key;
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
        status();
        this.view.draw(m);
      }
    } finally {
      clearInterval(timer);
      this.input.enabled = false;
      this.current = null;
      this.view.focus = 0;
      this.view.flashOff = false;
      this.ui.setTurn(true, null);
      this.view.draw(m);
    }
  }

  /** The production dialog for the city at (x, y); `captured`: a new city, set to Armies first. */
  async production(m: Mem, x: number, y: number, player: number, captured: boolean): Promise<number> {
    this.view.reveal(x, y, this.ui.viewport);
    const dlg = orders.openProduction(m, x, y, player, captured);
    const c = cityRec(dlg.city);
    const coastal = terrainNear(m, x, y, 1 << WATER);
    const choices: ProductionChoice[] = [0, 1, 2, 3, 5, 4, 6, 7].map((type) => ({
      type, days: productionDays(m, type), allowed: coastal || !SHIPS.includes(type),
    }));
    const dest = (dx: number, dy: number) => (dx === x && dy === y ? "None" : `${dy},${dx}`);
    this.view.draw(m);
    const type = await this.ui.production(m.sw(DAY), dest(m.sb(c + 1), m.sb(c)), dest(m.sb(c + 3), m.sb(c + 2)),
      m.sb(c + 8), choices, this.cellPicture(x, y));
    orders.chooseProduction(m, dlg, type);
    this.redraw(m);
    return type;
  }

  /** A copy of square (x, y) as the map shows it, enlarged, for the production dialog. */
  private cellPicture(x: number, y: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = CW * 3;
    c.height = CH * 3;
    c.getContext("2d")?.drawImage(this.view.canvas, (x - 2) * CW, (y - 2) * CH, CW * 3, CH * 3, 0, 0, CW * 3, CH * 3);
    return c;
  }

  /** A double-click on one of the player's cities opens its production dialog. */
  private async openCity(m: Mem, player: number, x: number, y: number): Promise<void> {
    if (!this.ownCityAt(m, player, x, y)) return;
    this.input.enabled = false;
    await this.production(m, x, y, player, false);
    this.input.enabled = true;
  }

  private ownCityAt(m: Mem, player: number, x: number, y: number): boolean {
    const n = m.sb(-0x1e4f);
    for (let i = 1; i <= n; i++) {
      const c = cityRec(i);
      if (m.sb(c + 7) === x && m.sb(c + 6) === y) return m.sb(c + 4) === player;
    }
    return false;
  }

  /** Whether the player is being asked to move a piece (menu commands that change orders work then). */
  get waiting(): boolean {
    return this.current !== null;
  }

  message(m: Mem, msg: Message): void {
    if (!msg.all && msg.player !== m.sb(LOCAL_PLAYER)) return;
    this.ui.setLine(msg.line, this.words.message(msg));
  }

  /** CODE 1 + 0x0928: a beep for a player at this computer. */
  beep(m: Mem, player: number): void {
    if (isComputer(m, player)) return;
    this.sound.stop();
    this.sound.beep();
  }

  report(_m: Mem, _entry: Record<string, number>): void {}

  /** The engine's "sound" event is the system beep (CODE 1 + 0x123E). */
  event(_m: Mem, name: string, _data: Record<string, number>): void {
    if (name !== "sound") return;
    this.sound.stop();
    this.sound.beep();
  }

  aiPlan(_m: Mem): void {}

  aiNewPiece(_m: Mem, _city: number): void {}

  aiNewGame(_m: Mem): void {}

  aiNewSide(_m: Mem): void {}

  dateTime(_m: Mem): number {
    return (Math.floor(Date.now() / 1000) + MAC_EPOCH) >>> 0;
  }
}

/** The message (STR number) shown while a command waits for a click or a drag. */
const MODE_HINTS: Record<string, number> = { w: 1014, l: 1047, p: 1049, m: 1048, a: 1063, c: 1046 };
