/**
 * Drawing into a 1-bit-style pixel buffer, the way the original's map is drawn: whole-pixel
 * colors, the original's bitmaps and patterns, and a small digit font for the rulers and
 * stack counts.
 */

const rgba = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** The colors of the Macintosh 16-color palette the original uses on the map. */
export const COLOR = {
  black: rgba(0, 0, 0),
  white: rgba(255, 255, 255),
  sea: rgba(0x02, 0xab, 0xea),
  green: rgba(0x1f, 0xb7, 0x14),
  red: rgba(0xdd, 0x08, 0x06),
} as const;

/** 3 × 5 digits, one row per string. */
const DIGITS = [
  ["111", "101", "101", "101", "111"], ["010", "110", "010", "010", "111"],
  ["111", "001", "111", "100", "111"], ["111", "001", "111", "001", "111"],
  ["101", "101", "111", "001", "001"], ["111", "100", "111", "001", "111"],
  ["111", "100", "111", "101", "111"], ["111", "001", "001", "001", "001"],
  ["111", "101", "111", "101", "111"], ["111", "101", "111", "001", "111"],
];

export class Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array;
  readonly image: ImageData;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.image = new ImageData(width, height);
    this.data = new Uint32Array(this.image.data.buffer);
  }

  fill(color: number): void {
    this.data.fill(color);
  }

  rect(x: number, y: number, w: number, h: number, color: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      this.data.fill(color, yy * this.width + Math.max(0, x), yy * this.width + Math.min(this.width, x + w));
    }
  }

  /** A 16 × 12 bitmap: set bits in `fg`, clear bits in `bg` (QuickDraw's srcCopy with colors). */
  bitmap(rows: readonly number[], x: number, y: number, fg: number, bg: number): void {
    for (let yy = 0; yy < 12; yy++) {
      const row = rows[yy];
      const base = (y + yy) * this.width + x;
      for (let xx = 0; xx < 16; xx++) this.data[base + xx] = (row >> (15 - xx)) & 1 ? fg : bg;
    }
  }

  /** Digits of `n` with their top-left corner at (x, y), 4 pixels apart. */
  number(n: number, x: number, y: number, color: number): void {
    const s = String(n);
    for (let i = 0; i < s.length; i++) {
      const glyph = DIGITS[s.charCodeAt(i) - 48];
      for (let yy = 0; yy < 5; yy++) {
        for (let xx = 0; xx < 3; xx++) {
          if (glyph[yy][xx] === "1") this.data[(y + yy) * this.width + x + 4 * i + xx] = color;
        }
      }
    }
  }
}

/** Width in pixels of `n` drawn with Pixels.number(). */
export function numberWidth(n: number): number {
  return String(n).length * 4 - 1;
}
