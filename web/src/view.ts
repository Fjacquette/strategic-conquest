/**
 * The map: 80 × 60 cells drawn on a canvas as one player knows them. Unexplored cells are
 * fog; the player's own pieces are always shown, enemy pieces while they are spotted.
 */
import { Mem } from "../../engine/src/mem.ts";
import {
  CITY_NEUTRAL, CITY_P1, CITY_P2, EDGE, EMPTY, MAP_H, MAP_W, REMOVED, WATER,
} from "../../engine/src/globals.ts";
import { topPieceAt } from "../../engine/src/hash.ts";
import { explored, terrainAt } from "../../engine/src/map.ts";
import { pieceAt, pOwner, pSpotted, pType, pX, pY } from "../../engine/src/piece.ts";
import { pieceCount } from "../../engine/src/query.ts";
import { PIECE_LETTERS } from "./text.ts";

export const CELL = 16;

/** Colors, read from the page's CSS custom properties. */
interface Colors {
  fog: string; sea: string; land: string; edge: string; neutral: string; grid: string;
  p1: string; p2: string; ink: string; focus: string;
}

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    fog: v("--map-fog"), sea: v("--map-sea"), land: v("--map-land"), edge: v("--map-edge"),
    neutral: v("--city-neutral"), grid: v("--map-grid"), p1: v("--p1"), p2: v("--p2"),
    ink: v("--map-ink"), focus: v("--focus"),
  };
}

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private colors: Colors;
  /** The player whose knowledge is shown. */
  viewer = 1;
  /** The piece being moved (its index), highlighted. */
  focus = 0;
  /** Show the whole world (the preview behind the setup screen). */
  revealAll = false;
  /** Show nothing (while the device is handed to the other player). */
  hidden = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MAP_W * CELL * dpr;
    canvas.height = MAP_H * CELL * dpr;
    canvas.style.width = `${MAP_W * CELL}px`;
    canvas.style.height = `${MAP_H * CELL}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
    this.colors = readColors();
  }

  private ownerColor(owner: number): string {
    return owner === 1 ? this.colors.p1 : owner === 2 ? this.colors.p2 : this.colors.neutral;
  }

  private known(m: Mem, x: number, y: number): boolean {
    return this.revealAll || explored(m, this.viewer, x, y);
  }

  /** Whether piece `p` shows on the map for the viewer. */
  private visible(m: Mem, p: number): boolean {
    const t = pType(m, p);
    if (t === REMOVED || t === EMPTY) return false;
    if (this.revealAll || pOwner(m, p) === this.viewer) return true;
    return pSpotted(m, p) > 0 && explored(m, this.viewer, pX(m, p), pY(m, p));
  }

  draw(m: Mem): void {
    const { ctx, colors } = this;
    ctx.fillStyle = colors.fog;
    ctx.fillRect(0, 0, MAP_W * CELL, MAP_H * CELL);
    if (this.hidden) return;
    for (let x = 1; x <= MAP_W; x++) {
      for (let y = 1; y <= MAP_H; y++) {
        if (!this.known(m, x, y)) continue;
        const t = terrainAt(m, x, y);
        const px = (x - 1) * CELL, py = (y - 1) * CELL;
        ctx.fillStyle = t === WATER ? colors.sea : t === EDGE ? colors.edge : colors.land;
        ctx.fillRect(px, py, CELL, CELL);
        if (t === CITY_NEUTRAL || t === CITY_P1 || t === CITY_P2) {
          const owner = t === CITY_P1 ? 1 : t === CITY_P2 ? 2 : 0;
          ctx.fillStyle = colors.ink;
          ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
          ctx.fillStyle = this.ownerColor(owner);
          ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
        }
      }
    }
    this.drawGrid();
    this.drawPieces(m);
  }

  /** A faint line every ten cells, as on a chart. */
  private drawGrid(): void {
    const { ctx, colors } = this;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 10; x < MAP_W; x += 10) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, MAP_H * CELL);
    }
    for (let y = 10; y < MAP_H; y += 10) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(MAP_W * CELL, y * CELL + 0.5);
    }
    ctx.stroke();
  }

  private drawPieces(m: Mem): void {
    const { ctx, colors } = this;
    const counted = new Map<number, number>();
    const n = pieceCount(m);
    for (let i = 1; i <= n; i++) {
      const p = pieceAt(i);
      if (!this.visible(m, p)) continue;
      const key = pX(m, p) * 100 + pY(m, p);
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${CELL * 0.62}px "IBM Plex Mono", ui-monospace, monospace`;
    for (const [key, count] of counted) {
      const x = Math.floor(key / 100), y = key % 100;
      let idx = topPieceAt(m, x, y);
      if (idx === 0 || !this.visible(m, pieceAt(idx))) idx = this.firstVisibleAt(m, x, y);
      if (idx === 0) continue;
      const p = pieceAt(idx);
      const cx = (x - 1) * CELL + CELL / 2, cy = (y - 1) * CELL + CELL / 2;
      ctx.fillStyle = colors.ink;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.ownerColor(pOwner(m, p));
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.ink;
      ctx.fillText(PIECE_LETTERS[pType(m, p)] ?? "?", cx, cy + 0.5);
      if (count > 1) {
        ctx.fillStyle = colors.focus;
        ctx.fillRect((x - 1) * CELL + CELL - 4, (y - 1) * CELL, 4, 4);
      }
    }
    if (this.focus > 0 && this.focus <= n) {
      const p = pieceAt(this.focus);
      if (pType(m, p) !== REMOVED && pType(m, p) !== EMPTY) {
        ctx.strokeStyle = colors.focus;
        ctx.lineWidth = 2;
        ctx.strokeRect((pX(m, p) - 1) * CELL + 1, (pY(m, p) - 1) * CELL + 1, CELL - 2, CELL - 2);
      }
    }
  }

  private firstVisibleAt(m: Mem, x: number, y: number): number {
    const n = pieceCount(m);
    for (let i = 1; i <= n; i++) {
      const p = pieceAt(i);
      if (pX(m, p) === x && pY(m, p) === y && this.visible(m, p)) return i;
    }
    return 0;
  }

  /** The cell under a pointer position, or null off the map. */
  cellAt(clientX: number, clientY: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / CELL) + 1;
    const y = Math.floor((clientY - r.top) / CELL) + 1;
    return x >= 1 && x <= MAP_W && y >= 1 && y <= MAP_H ? [x, y] : null;
  }

  /** Scroll the map's container so that cell (x, y) is in view, with a margin. */
  reveal(x: number, y: number, container: HTMLElement): void {
    const px = (x - 1) * CELL, py = (y - 1) * CELL, margin = CELL * 4;
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = container;
    if (px < scrollLeft + margin || px > scrollLeft + clientWidth - margin) {
      container.scrollLeft = px - clientWidth / 2;
    }
    if (py < scrollTop + margin || py > scrollTop + clientHeight - margin) {
      container.scrollTop = py - clientHeight / 2;
    }
  }
}
