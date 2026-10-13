/**
 * The player's input, turned into commands and queued until the game asks for one: keys,
 * clicks, drags and double-clicks on the map, and the command buttons.
 */
import { CH, CW, MapView, RULER_LEFT, RULER_TOP } from "./mapview.ts";

/** While a drag is held past an edge of the map in view, the map scrolls a square this often. */
const SCROLL_MS = 120;

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
const COMMAND_KEYS = new Set(["s", "w", "l", "r", "c", "a", "m", "p", "n", "b", "escape", "i"]);

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

  /**
   * Called while the pointer is dragged on the map, while the game waits for the player: the
   * square the drag started on and the square now under the pointer; with nulls when the drag
   * ends.
   */
  onDrag: (from: [number, number] | null, to: [number, number] | null) => void = () => {};

  /** Listen to the keyboard and to pointer gestures on the map shown in `viewport`. */
  attach(view: MapView, viewport: HTMLElement, blocked: () => boolean): void {
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
    let current: [number, number] | null = null;
    let pointer = { x: 0, y: 0 };
    let scroller: ReturnType<typeof setInterval> | null = null;
    // The part of the viewport the map shows (inside the rulers), in page coordinates.
    const visible = () => {
      const r = viewport.getBoundingClientRect();
      return { left: r.left + RULER_LEFT * view.scale, top: r.top + RULER_TOP * view.scale, right: r.right, bottom: r.bottom };
    };
    // The square under the pointer, the pointer held to the part of the map in view (as the
    // original clamps it to its window).
    const track = () => {
      if (!start) return;
      const v = visible();
      const cx = Math.min(Math.max(pointer.x, v.left + 1), v.right - 1);
      const cy = Math.min(Math.max(pointer.y, v.top + 1), v.bottom - 1);
      const cell = view.cellAt(cx, cy);
      if (!cell || (current && cell[0] === current[0] && cell[1] === current[1])) return;
      current = cell;
      if (this.enabled) this.onDrag(start, current);
    };
    // Once a drag has left its square, at an edge of the map in view (within half a square
    // of it, or past it) the map scrolls a square at a time, as the original's does past the
    // edge of its window.
    const scroll = () => {
      if (!start || !current || (current[0] === start[0] && current[1] === start[1])) return;
      const v = visible();
      const mx = (CW * view.scale) / 2, my = (CH * view.scale) / 2;
      const dx = pointer.x < v.left + mx ? -1 : pointer.x > v.right - mx ? 1 : 0;
      const dy = pointer.y < v.top + my ? -1 : pointer.y > v.bottom - my ? 1 : 0;
      if (dx === 0 && dy === 0) return;
      viewport.scrollLeft += dx * CW * view.scale;
      viewport.scrollTop += dy * CH * view.scale;
      track();
    };
    const finish = () => {
      if (scroller) clearInterval(scroller);
      scroller = null;
      const from = start, to = current;
      start = current = null;
      this.onDrag(null, null);
      return [from, to];
    };
    view.canvas.addEventListener("pointerdown", (e) => {
      if (blocked() || e.button !== 0) return;
      start = current = view.cellAt(e.clientX, e.clientY);
      if (!start) return;
      pointer = { x: e.clientX, y: e.clientY };
      view.canvas.setPointerCapture(e.pointerId);
      scroller = setInterval(scroll, SCROLL_MS);
    });
    view.canvas.addEventListener("pointermove", (e) => {
      if (!start) return;
      pointer = { x: e.clientX, y: e.clientY };
      track();
    });
    view.canvas.addEventListener("pointercancel", () => { finish(); });
    view.canvas.addEventListener("pointerup", () => {
      if (!start) return;
      const [from, to] = finish();
      if (blocked() || !from || !to) return;
      if (from[0] === to[0] && from[1] === to[1]) this.push({ kind: "click", x: to[0], y: to[1] });
      else this.push({ kind: "drag", x: from[0], y: from[1], tx: to[0], ty: to[1] });
    });
    view.canvas.addEventListener("dblclick", (e) => {
      const cell = view.cellAt(e.clientX, e.clientY);
      if (!blocked() && cell) this.push({ kind: "open", x: cell[0], y: cell[1] });
    });
  }
}
