/**
 * The part of QuickDraw that map generation depends on: polygons recorded with
 * MoveTo/LineTo, regions built from their outlines (OpenRgn/LineTo/CloseRgn), region
 * intersection and union, and point and rectangle tests.
 *
 * Map generation tests islands for overlap pixel by pixel and decides which cells are
 * land by testing their centres against island regions, so the pixels a region covers must
 * be exactly QuickDraw's. A QuickDraw region is a set of "inversion points": a pixel (h, v)
 * is inside when an odd number of points lie at or above and left of it (h' <= h,
 * v' <= v). A region built from lines takes the points that `PutLine` produces for each
 * line, sorted, with duplicate pairs cancelled. The algorithm here follows Apple's
 * QuickDraw (PutLine, PackRgn, PtInRgn; the 1984 source published by the Computer History
 * Museum), checked against the Mac IIci ROM the game was verified with: its PutLine is the
 * same, and its FixRatio truncates toward zero.
 *
 * A region is kept as its canonical point list. Two regions with the same pixels have the
 * same points, so set operations can be computed on pixels and converted back, and give
 * QuickDraw's result.
 */

/** A rectangle as QuickDraw stores it. */
export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A point list in QuickDraw order: by v, then by h. */
export type Points = number[]; // v0, h0, v1, h1, ...

const s16 = (v: number) => (v << 16) >> 16;

/** FixRatio as in the IIci ROM: (numer << 16) / denom, truncated toward zero. */
export function fixRatio(numer: number, denom: number): number {
  numer = s16(numer);
  denom = s16(denom);
  if (denom === 0) return numer < 0 ? -0x7fffffff : 0x7fffffff;
  if (numer === denom) return 0x10000;
  return Math.trunc((numer * 65536) / denom) | 0;
}

/** PutLine: the inversion points of the line from (h1, v1) to (h2, v2). */
export function putLine(out: number[], h1: number, v1: number, h2: number, v2: number): void {
  if (h1 === h2) return;
  if (v1 === v2) {
    out.push(v1, h1, v2, h2);
    return;
  }
  let topV = v1, topH = h1, botV = v2, botH = h2;
  if (v2 < v1) {
    topV = v2; topH = h2; botV = v1; botH = h1;
  }
  const slope = fixRatio(botH - topH, botV - topV);
  let horiz = ((topH << 16) | 0x8000) + (slope >> 1);
  if (slope >= 0) {
    if (slope < 0x10000) horiz += slope;
  } else if (slope < -0x10000) {
    horiz += 0x10000;
  }
  horiz |= 0;
  let h = topH;
  let v = topV;
  do {
    const hi = horiz >> 16;
    if (hi !== h) {
      out.push(v, h, v, hi);
      h = hi;
    }
    v++;
    horiz = (horiz + slope) | 0;
  } while (v !== botV);
  if (h !== botH) out.push(v, h, v, botH);
}

/** Sort points by v, then h, and cancel duplicate pairs (SortPoints, CullPoints). */
function canonical(raw: number[]): Points {
  const odd = new Set<number>();
  for (let i = 0; i < raw.length; i += 2) {
    const key = (raw[i] + 32768) * 65536 + (raw[i + 1] + 32768);
    if (odd.has(key)) odd.delete(key);
    else odd.add(key);
  }
  const pts: Points = [];
  for (const k of [...odd].sort((a, b) => a - b)) {
    const v = Math.floor(k / 65536);
    pts.push(v - 32768, k - v * 65536 - 32768);
  }
  return pts;
}

export class Region {
  readonly points: Points;
  private readonly box: Rect;

  constructor(points: Points = []) {
    this.points = points;
    this.box = packedBBox(points);
  }

  /** CloseRgn after MoveTo(pts[0]) and LineTo(pts[1]) ... LineTo(pts[n-1]); pts as [h, v]. */
  static fromOutline(pts: [number, number][]): Region {
    const raw: number[] = [];
    for (let i = 1; i < pts.length; i++) putLine(raw, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return new Region(canonical(raw));
  }

  /** The bounding box PackRgn stores (all zero for an empty region). */
  bbox(): Rect {
    return { ...this.box };
  }

  /** EmptyRgn: an empty bounding box. */
  isEmpty(): boolean {
    const b = this.bbox();
    return b.top >= b.bottom || b.left >= b.right;
  }

  /** PtInRgn. */
  contains(h: number, v: number): boolean {
    const b = this.box;
    if (h < b.left || h >= b.right || v < b.top || v >= b.bottom) return false;
    let inside = false;
    const p = this.points;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] > v) break;
      if (p[i + 1] <= h) inside = !inside;
    }
    return inside;
  }

  /** SectRgn. */
  sect(other: Region): Region {
    return combine(this, other, (a, b) => a && b);
  }

  /** UnionRgn. */
  union(other: Region): Region {
    return combine(this, other, (a, b) => a || b);
  }
}

/** PackRgn's bounding box of a sorted point list. */
function packedBBox(p: Points): Rect {
  const n = p.length / 2;
  if (n < 4) return { top: 0, left: 0, bottom: 0, right: 0 };
  if (n === 4) return { top: p[0], left: p[1], bottom: p[6], right: p[7] };
  let left = p[1], right = p[1];
  for (let i = 1; i < p.length; i += 2) {
    if (p[i] < left) left = p[i];
    else if (p[i] > right) right = p[i];
  }
  return { top: p[0], left, bottom: p[p.length - 2], right };
}

/** Rows of a region: from each listed v down to the next, the sorted toggle positions. */
function bands(r: Region): { v: number; toggles: number[] }[] {
  const out: { v: number; toggles: number[] }[] = [];
  let state: number[] = [];
  const p = r.points;
  for (let i = 0; i < p.length;) {
    const v = p[i];
    const row: number[] = [];
    while (i < p.length && p[i] === v) {
      row.push(p[i + 1]);
      i += 2;
    }
    state = xorSorted(state, row);
    out.push({ v, toggles: state });
  }
  return out;
}

/** Symmetric difference of two sorted lists of distinct numbers. */
function xorSorted(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out.push(a[i++]);
    else if (i >= a.length || b[j] < a[i]) out.push(b[j++]);
    else { i++; j++; }
  }
  return out;
}

/** Combine two rows of toggles with a boolean operation. */
function combineRow(a: number[], b: number[], op: (x: boolean, y: boolean) => boolean): number[] {
  const out: number[] = [];
  let i = 0, j = 0, inA = false, inB = false, cur = false;
  while (i < a.length || j < b.length) {
    const h = Math.min(i < a.length ? a[i] : Infinity, j < b.length ? b[j] : Infinity);
    if (i < a.length && a[i] === h) { inA = !inA; i++; }
    if (j < b.length && b[j] === h) { inB = !inB; j++; }
    const next = op(inA, inB);
    if (next !== cur) {
      out.push(h);
      cur = next;
    }
  }
  return out;
}

function combine(a: Region, b: Region, op: (x: boolean, y: boolean) => boolean): Region {
  const ba = bands(a), bb = bands(b);
  const vs = [...new Set([...ba.map((x) => x.v), ...bb.map((x) => x.v)])].sort((x, y) => x - y);
  const raw: number[] = [];
  let ia = -1, ib = -1;
  let prev: number[] = [];
  for (const v of vs) {
    while (ia + 1 < ba.length && ba[ia + 1].v <= v) ia++;
    while (ib + 1 < bb.length && bb[ib + 1].v <= v) ib++;
    const row = combineRow(ia >= 0 ? ba[ia].toggles : [], ib >= 0 ? bb[ib].toggles : [], op);
    for (const h of xorSorted(prev, row)) raw.push(v, h);
    prev = row;
  }
  return new Region(raw);
}

/** SectRect: the intersection, or (0, 0, 0, 0) when it is empty. */
export function sectRect(a: Rect, b: Rect): Rect {
  const top = Math.max(a.top, b.top), left = Math.max(a.left, b.left);
  const bottom = Math.min(a.bottom, b.bottom), right = Math.min(a.right, b.right);
  if (bottom <= top || right <= left) return { top: 0, left: 0, bottom: 0, right: 0 };
  return { top, left, bottom, right };
}

/** PtInRect. */
export function ptInRect(h: number, v: number, r: Rect): boolean {
  return v >= r.top && h >= r.left && v < r.bottom && h < r.right;
}

/**
 * A polygon recorded between OpenPoly and ClosePoly: the pen position at the first LineTo,
 * then every LineTo point, as [h, v].
 */
export class PolyRecorder {
  private pen: [number, number] = [0, 0];
  readonly points: [number, number][] = [];

  moveTo(h: number, v: number): void {
    this.pen = [h, v];
  }

  lineTo(h: number, v: number): void {
    if (this.points.length === 0) this.points.push(this.pen);
    this.points.push([h, v]);
    this.pen = [h, v];
  }
}
