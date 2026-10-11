/**
 * The player's input, turned into commands and queued until the game asks for one: keys,
 * clicks, drags and double-clicks on the map, and the command buttons.
 */
import { MapView } from "./view.ts";

export type Command =
  | { kind: "dir"; dx: number; dy: number }
  | { kind: "key"; key: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; tx: number; ty: number }
  | { kind: "open"; x: number; y: number };

/** Numeric keypad and arrow keys: the eight directions, and 5 / Clear for "stay". */
const DIRECTIONS: Record<string, [number, number]> = {
  Numpad7: [-1, -1], Numpad8: [0, -1], Numpad9: [1, -1],
  Numpad4: [-1, 0], Numpad5: [0, 0], Numpad6: [1, 0],
  Numpad1: [-1, 1], Numpad2: [0, 1], Numpad3: [1, 1],
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  Home: [-1, -1], PageUp: [1, -1], End: [-1, 1], PageDown: [1, 1], Clear: [0, 0],
};

/** Keys of the Moves menu, as in the original (no Command key needed). */
const COMMAND_KEYS = new Set(["s", "w", "l", "r", "c", "a", "m", "p", "n", "b", "escape"]);

export class Input {
  private queue: Command[] = [];
  private waiter: ((c: Command) => void) | null = null;
  /** Commands are taken only while the game waits for the player. */
  enabled = false;

  push(c: Command): void {
    if (!this.enabled) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(c);
    } else {
      this.queue.push(c);
    }
  }

  next(): Promise<Command> {
    const c = this.queue.shift();
    if (c) return Promise.resolve(c);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  clear(): void {
    this.queue = [];
  }

  /** Listen to the keyboard and to pointer gestures on the map. */
  attach(view: MapView, blocked: () => boolean): void {
    window.addEventListener("keydown", (e) => {
      if (blocked() || e.metaKey || e.ctrlKey || e.altKey) return;
      const d = DIRECTIONS[e.code];
      if (d) {
        e.preventDefault();
        this.push({ kind: "dir", dx: d[0], dy: d[1] });
        return;
      }
      const key = e.key.toLowerCase();
      if (COMMAND_KEYS.has(key)) {
        e.preventDefault();
        this.push({ kind: "key", key });
      }
    });
    let start: [number, number] | null = null;
    view.canvas.addEventListener("pointerdown", (e) => {
      if (blocked()) return;
      start = view.cellAt(e.clientX, e.clientY);
    });
    view.canvas.addEventListener("pointerup", (e) => {
      const end = view.cellAt(e.clientX, e.clientY);
      const from = start;
      start = null;
      if (blocked() || !from || !end) return;
      if (from[0] === end[0] && from[1] === end[1]) this.push({ kind: "click", x: end[0], y: end[1] });
      else this.push({ kind: "drag", x: from[0], y: from[1], tx: end[0], ty: end[1] });
    });
    view.canvas.addEventListener("dblclick", (e) => {
      const cell = view.cellAt(e.clientX, e.clientY);
      if (!blocked() && cell) this.push({ kind: "open", x: cell[0], y: cell[1] });
    });
  }
}
