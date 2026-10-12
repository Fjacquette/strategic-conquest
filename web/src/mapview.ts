/**
 * The map window, drawn as the original draws it: 16 × 12-pixel squares, black where the
 * player has not explored, the sea in light blue with its pattern and a dotted line every
 * third square, islands as their green polygons with the land grid over them, and cities
 * and pieces as the original's bitmaps on white (the player's in black, the enemy's in red,
 * neutral cities in green). The picture is drawn at its original size and scaled up with
 * square pixels; rulers along the top and left number the columns and rows.
 */
import { Mem } from "../../engine/src/mem.ts";
import {
  CITY_NEUTRAL, CITY_P1, CITY_P2, EDGE, EMPTY, GAME_SEED, MAP_H, MAP_W, OWN_CITY_CODE, REMOVED, SKILL, WATER,
} from "../../engine/src/globals.ts";
import { initGlobals } from "../../engine/src/launch.ts";
import { topPieceAt } from "../../engine/src/hash.ts";
import { explored, terrainAt } from "../../engine/src/map.ts";
import { generateMap, type Outline } from "../../engine/src/mapgen.ts";
import { pieceAt, pOwner, pSpotted, pType, pX, pY } from "../../engine/src/piece.ts";
import { ownPiecesAt, pieceCount } from "../../engine/src/query.ts";
import { Region } from "../../engine/src/quickdraw.ts";
import { type Assets, BITS, SEA_PATTERN } from "./assets.ts";
import { COLOR, numberWidth, Pixels } from "./pixels.ts";

export const CW = 16;
export const CH = 12;
const W = MAP_W * CW;
const H = MAP_H * CH;
export const RULER_TOP = 9;
export const RULER_LEFT = 14;
/** QuickDraw's dkGray pattern, which the Bomber's blast is drawn in. */
const DK_GRAY = [0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77];

/** What a square shows, besides its terrain. */
interface Occupant {
  idx: number;
  /** Own pieces on the square, for the stack count. */
  count: number;
}

export class MapView {
  readonly canvas: HTMLCanvasElement;
  readonly rulerTop: HTMLCanvasElement;
  readonly rulerLeft: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pixels = new Pixels(W, H);
  private readonly assets: Assets;
  /** Per pixel: 1 inside an island's polygon, 2 on its outline. */
  private readonly island = new Uint8Array(W * H);
  /** Left-facing pieces, keyed by owner, type and square. */
  private readonly facing = new Set<string>();
  /** The game seed and skill level the island outlines were made for. */
  private islandKey = "";
  /** The player whose knowledge is shown. */
  viewer = 1;
  /** The piece being moved (its index), which flashes. */
  focus = 0;
  /** The flash's off phase: the piece being moved is not drawn. */
  flashOff = false;
  /** Show the whole world (behind the setup dialog). */
  revealAll = false;
  /** The Land Grid option. */
  landGrid = true;
  /** A square shown inverted: the battle display's flash. */
  inverted: [number, number] | null = null;
  /** A Bomber's blast being shown: its square and radius. */
  blast: { x: number; y: number; radius: number } | null = null;
  scale = 2;

  constructor(canvas: HTMLCanvasElement, rulerTop: HTMLCanvasElement, rulerLeft: HTMLCanvasElement, assets: Assets) {
    this.canvas = canvas;
    this.rulerTop = rulerTop;
    this.rulerLeft = rulerLeft;
    this.assets = assets;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    this.ctx = ctx;
    this.drawRulers();
    this.setScale(this.scale);
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.canvas.style.width = `${W * scale}px`;
    this.canvas.style.height = `${H * scale}px`;
    this.rulerTop.style.width = `${W * scale}px`;
    this.rulerTop.style.height = `${RULER_TOP * scale}px`;
    this.rulerLeft.style.width = `${RULER_LEFT * scale}px`;
    this.rulerLeft.style.height = `${H * scale}px`;
  }

  /**
   * The island outlines follow from the game seed and skill level, as the world does (the
   * original keeps them from map generation; they are not saved), so they are made again
   * whenever the game changes.
   */
  private syncIslands(m: Mem): void {
    const key = `${m.l(GAME_SEED)}:${m.sb(SKILL)}`;
    if (key === this.islandKey) return;
    this.islandKey = key;
    const g = new Mem();
    initGlobals(g);
    g.setL(GAME_SEED, m.l(GAME_SEED));
    g.setB(SKILL, m.sb(SKILL));
    this.setIslands(generateMap(g));
  }

  /** The islands' outlines (map-generation pixels: square (x, y) spans 16x..16x+15, 12y..12y+11). */
  private setIslands(outlines: (Outline | null)[]): void {
    this.island.fill(0);
    for (const outline of outlines) {
      if (!outline) continue;
      this.fillRegion(Region.fromOutline(outline));
    }
    for (const outline of outlines) {
      if (!outline) continue;
      for (let i = 1; i < outline.length; i++) {
        this.line(outline[i - 1][0] - CW, outline[i - 1][1] - CH, outline[i][0] - CW, outline[i][1] - CH);
      }
    }
  }

  private fillRegion(r: Region): void {
    const p = r.points;
    let state: number[] = [];
    let i = 0;
    const box = r.bbox();
    for (let v = box.top; v < box.bottom; v++) {
      while (i < p.length && p[i] === v) {
        const h = p[i + 1];
        const k = state.indexOf(h);
        if (k >= 0) state.splice(k, 1);
        else state.push(h);
        i += 2;
      }
      state = state.sort((a, b) => a - b);
      const y = v - CH;
      if (y < 0 || y >= H) continue;
      for (let s = 0; s + 1 < state.length; s += 2) {
        const x0 = Math.max(0, state[s] - CW), x1 = Math.min(W, state[s + 1] - CW);
        if (x1 > x0) this.island.fill(1, y * W + x0, y * W + x1);
      }
    }
  }

  /** A one-pixel line, both ends included. */
  private line(x0: number, y0: number, x1: number, y1: number): void {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) this.island[y0 * W + x0] = 2;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  private drawRulers(): void {
    const top = new Pixels(W, RULER_TOP);
    top.fill(COLOR.white);
    for (let x = 1; x <= MAP_W; x++) top.number(x, (x - 1) * CW + Math.floor((CW - numberWidth(x)) / 2), 2, COLOR.black);
    top.rect(0, RULER_TOP - 1, W, 1, COLOR.black);
    this.rulerTop.width = W;
    this.rulerTop.height = RULER_TOP;
    this.rulerTop.getContext("2d")?.putImageData(top.image, 0, 0);
    const left = new Pixels(RULER_LEFT, H);
    left.fill(COLOR.white);
    for (let y = 1; y <= MAP_H; y++) left.number(y, RULER_LEFT - 2 - numberWidth(y), (y - 1) * CH + 4, COLOR.black);
    left.rect(RULER_LEFT - 1, 0, 1, H, COLOR.black);
    this.rulerLeft.width = RULER_LEFT;
    this.rulerLeft.height = H;
    this.rulerLeft.getContext("2d")?.putImageData(left.image, 0, 0);
  }

  /** Forget what was shown of a game (another game takes over). */
  forget(): void {
    this.facing.clear();
    this.focus = 0;
    this.flashOff = false;
    this.inverted = null;
    this.blast = null;
  }

  /** A piece moved from `from` (a position word): it now faces the way it went. */
  noteMove(m: Mem, idx: number, from: number): void {
    const p = pieceAt(idx);
    const dx = pX(m, p) - (from & 0xff);
    const fromKey = `${pOwner(m, p)}:${pType(m, p)}:${from & 0xff}:${from >> 8}`;
    const left = dx < 0 || (dx === 0 && this.facing.has(fromKey));
    this.facing.delete(fromKey);
    const key = `${pOwner(m, p)}:${pType(m, p)}:${pX(m, p)}:${pY(m, p)}`;
    if (left) this.facing.add(key);
    else this.facing.delete(key);
  }

  private faces(m: Mem, p: number): boolean {
    return this.facing.has(`${pOwner(m, p)}:${pType(m, p)}:${pX(m, p)}:${pY(m, p)}`);
  }

  private known(m: Mem, x: number, y: number): boolean {
    return this.revealAll || explored(m, this.viewer, x, y);
  }

  private visible(m: Mem, p: number): boolean {
    const t = pType(m, p);
    if (t === REMOVED || t === EMPTY) return false;
    if (this.revealAll || pOwner(m, p) === this.viewer) return true;
    return pSpotted(m, p) > 0 && explored(m, this.viewer, pX(m, p), pY(m, p));
  }

  draw(m: Mem): void {
    this.syncIslands(m);
    const px = this.pixels;
    px.fill(COLOR.black);
    for (let x = 1; x <= MAP_W; x++) {
      for (let y = 1; y <= MAP_H; y++) {
        if (this.known(m, x, y)) this.drawTerrain(m, x, y);
      }
    }
    for (const [key, occ] of this.occupants(m)) {
      this.drawPiece(m, Math.floor(key / 100), key % 100, occ);
    }
    if (this.blast) this.drawBlast(this.blast.x, this.blast.y, this.blast.radius);
    if (this.inverted) this.invert(this.inverted[0], this.inverted[1]);
    this.ctx.putImageData(px.image, 0, 0);
  }

  /**
   * A Bomber's blast (CODE 17 + 0x0E56): a disc in the dkGray pattern, centred on the
   * square, with a radius of 16 pixels (a square's width) for each square of blast radius.
   */
  private drawBlast(x: number, y: number, radius: number): void {
    const cx = (x - 1) * CW + CW / 2, cy = (y - 1) * CH + CH / 2, r = radius * CW;
    const d = this.pixels.data;
    for (let yy = Math.max(0, cy - r); yy < Math.min(H, cy + r); yy++) {
      const row = DK_GRAY[yy & 7];
      for (let xx = Math.max(0, cx - r); xx < Math.min(W, cx + r); xx++) {
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) d[yy * W + xx] = (row >> (7 - (xx & 7))) & 1 ? COLOR.black : COLOR.white;
      }
    }
  }

  /** Square (x, y) in inverse colors, as QuickDraw's InvertRect leaves it. */
  private invert(x: number, y: number): void {
    const d = this.pixels.data;
    for (let yy = (y - 1) * CH; yy < y * CH; yy++) {
      for (let xx = (x - 1) * CW; xx < x * CW; xx++) d[yy * W + xx] ^= 0x00ffffff;
    }
  }

  private drawTerrain(m: Mem, x: number, y: number): void {
    const px = this.pixels;
    const t = terrainAt(m, x, y);
    const x0 = (x - 1) * CW, y0 = (y - 1) * CH;
    if (t === EDGE) {
      px.bitmap(this.assets.bits[BITS.edge], x0, y0, COLOR.black, COLOR.white);
      return;
    }
    const pat = this.assets.pats[SEA_PATTERN];
    const d = px.data, isl = this.island;
    for (let yy = y0; yy < y0 + CH; yy++) {
      const row = pat[yy & 7];
      for (let xx = x0; xx < x0 + CW; xx++) {
        const i = yy * W + xx, v = isl[i];
        d[i] = v === 2 ? COLOR.black : v === 1 ? COLOR.green : (row >> (7 - (xx & 7))) & 1 ? COLOR.black : COLOR.sea;
      }
    }
    if (t === WATER) {
      // A dotted line along the left of every third column and the top of every third row.
      if ((x - 2) % 3 === 0) for (let yy = y0; yy < y0 + CH; yy++) d[yy * W + x0] = (x0 + yy) & 1 ? COLOR.white : COLOR.black;
      if ((y - 2) % 3 === 0) for (let xx = x0; xx < x0 + CW; xx++) d[y0 * W + xx] = (xx + y0) & 1 ? COLOR.white : COLOR.black;
      return;
    }
    if (this.landGrid) {
      // Each land square is framed; neighbouring squares share their lines.
      px.rect(x0, y0, CW, 1, COLOR.black);
      px.rect(x0, y0, 1, CH, COLOR.black);
      if (!this.isLand(m, x + 1, y)) px.rect(x0 + CW - 1, y0, 1, CH, COLOR.black);
      if (!this.isLand(m, x, y + 1)) px.rect(x0, y0 + CH - 1, CW, 1, COLOR.black);
    }
    if (t === CITY_NEUTRAL || t === CITY_P1 || t === CITY_P2) this.drawCity(m, x, y, t, 0);
  }

  private isLand(m: Mem, x: number, y: number): boolean {
    if (x > MAP_W || y > MAP_H || !this.known(m, x, y)) return false;
    const t = terrainAt(m, x, y);
    return t !== WATER && t !== EDGE;
  }

  /** A city's bitmap, and how many of the viewer's pieces are in it (less `minus`). */
  private drawCity(m: Mem, x: number, y: number, t: number, minus: number): void {
    const x0 = (x - 1) * CW, y0 = (y - 1) * CH;
    const own = m.sb(OWN_CITY_CODE + this.viewer);
    const color = t === CITY_NEUTRAL ? COLOR.green : t === own ? COLOR.black : COLOR.red;
    const rows = this.assets.bits[t === CITY_NEUTRAL ? BITS.neutralCity : BITS.city];
    this.pixels.bitmap(rows, x0, y0, color, COLOR.white);
    if (t === own) {
      const n = ownPiecesAt(m, x, y, this.viewer) - minus;
      if (n > 0) this.count(n, x0, y0 + CH - 7);
    }
  }

  /** The stack count in a white box. */
  private count(n: number, x: number, y: number): void {
    this.pixels.rect(x, y, numberWidth(n) + 2, 7, COLOR.white);
    this.pixels.number(n, x + 1, y + 1, COLOR.black);
  }

  /** The squares with a visible piece: the top piece shown, and the viewer's count there. */
  private occupants(m: Mem): Map<number, Occupant> {
    const out = new Map<number, Occupant>();
    const n = pieceCount(m);
    for (let i = 1; i <= n; i++) {
      const p = pieceAt(i);
      if (!this.visible(m, p)) continue;
      const x = pX(m, p), y = pY(m, p), key = x * 100 + y;
      const cur = out.get(key);
      const top = topPieceAt(m, x, y);
      if (!cur) out.set(key, { idx: top !== 0 && this.visible(m, pieceAt(top)) ? top : i, count: 0 });
      if (pOwner(m, p) === this.viewer) out.get(key)!.count++;
    }
    return out;
  }

  private drawPiece(m: Mem, x: number, y: number, occ: Occupant): void {
    const t = terrainAt(m, x, y);
    const isCity = t === CITY_NEUTRAL || t === CITY_P1 || t === CITY_P2;
    const flashing = this.flashOff && this.focus !== 0 && pX(m, pieceAt(this.focus)) === x && pY(m, pieceAt(this.focus)) === y;
    if (isCity) {
      // Pieces in a city are shown by the city's count; the city itself stays visible.
      this.drawCity(m, x, y, t, flashing ? 1 : 0);
      return;
    }
    let idx = occ.idx;
    if (flashing) {
      if (idx === this.focus) idx = this.otherPieceAt(m, x, y, this.focus);
      if (idx === 0) {
        this.drawTerrain(m, x, y);
        return;
      }
    }
    const p = pieceAt(idx);
    const type = pType(m, p);
    const rows = this.assets.bits[(this.faces(m, p) ? BITS.unitLeft : BITS.unitRight)[type]];
    const x0 = (x - 1) * CW, y0 = (y - 1) * CH;
    this.pixels.bitmap(rows, x0, y0, pOwner(m, p) === this.viewer ? COLOR.black : COLOR.red, COLOR.white);
    const n = occ.count - (flashing ? 1 : 0);
    if (n > 1) this.count(n, x0, y0);
  }

  private otherPieceAt(m: Mem, x: number, y: number, except: number): number {
    const n = pieceCount(m);
    for (let i = 1; i <= n; i++) {
      const p = pieceAt(i);
      if (i !== except && pX(m, p) === x && pY(m, p) === y && this.visible(m, p)) return i;
    }
    return 0;
  }

  /** The square under a pointer position, or null off the map. */
  cellAt(clientX: number, clientY: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / (CW * this.scale)) + 1;
    const y = Math.floor((clientY - r.top) / (CH * this.scale)) + 1;
    return x >= 1 && x <= MAP_W && y >= 1 && y <= MAP_H ? [x, y] : null;
  }

  /** Whether square (x, y) lies wholly in the part of the map the viewport shows. */
  shows(x: number, y: number, viewport: HTMLElement): boolean {
    const s = this.scale;
    const px = this.canvas.offsetLeft + (x - 1) * CW * s, py = this.canvas.offsetTop + (y - 1) * CH * s;
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = viewport;
    return px >= scrollLeft + RULER_LEFT * s && px + CW * s <= scrollLeft + clientWidth &&
      py >= scrollTop + RULER_TOP * s && py + CH * s <= scrollTop + clientHeight;
  }

  /** Scroll the viewport so that square (x, y) is in view, away from the edges. */
  reveal(x: number, y: number, viewport: HTMLElement): void {
    const s = this.scale;
    const px = this.canvas.offsetLeft + (x - 1) * CW * s, py = this.canvas.offsetTop + (y - 1) * CH * s;
    const marginX = CW * s * 3, marginY = CH * s * 3;
    const left = RULER_LEFT * s, top = RULER_TOP * s;
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = viewport;
    if (px < scrollLeft + left + marginX || px > scrollLeft + clientWidth - marginX) {
      viewport.scrollLeft = px - (clientWidth + left) / 2;
    }
    if (py < scrollTop + top + marginY || py > scrollTop + clientHeight - marginY) {
      viewport.scrollTop = py - (clientHeight + top) / 2;
    }
  }
}

/** A piece type's bitmap, drawn black on white at `scale`, for dialogs and the status strip. */
export function iconCanvas(assets: Assets, bitsId: number, scale: number, color: number = COLOR.black): HTMLCanvasElement {
  const px = new Pixels(CW, CH);
  px.bitmap(assets.bits[bitsId], 0, 0, color, COLOR.white);
  const c = document.createElement("canvas");
  c.width = CW;
  c.height = CH;
  c.getContext("2d")?.putImageData(px.image, 0, 0);
  c.style.width = `${CW * scale}px`;
  c.style.height = `${CH * scale}px`;
  c.className = "icon";
  return c;
}
