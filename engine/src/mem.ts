/**
 * The game's global state, laid out exactly as the original's A5 globals.
 *
 * The original keeps all game state in globals below register A5. The engine keeps the same
 * bytes in one array so routines can be translated faithfully and their results compared
 * byte for byte with the original running in the emulator harness. Offsets are the negative
 * A5 offsets used by the original code (see globals.ts).
 */

/** Bytes of globals below A5. */
export const GLOBALS_SIZE = 0x55c4;

/**
 * Scratch piece records above A5 (offsets 0, 14, ...), standing for the record copies the
 * original keeps on its stack and passes to routines that take a record pointer. They are
 * not part of the globals image.
 */
export const SCRATCH_RECORDS = 4;
const SCRATCH_SIZE = SCRATCH_RECORDS * 14;

export class Mem {
  /** The globals image (the scratch records follow it in the same buffer). */
  readonly u8: Uint8Array;
  private readonly all: Uint8Array;

  constructor(raw?: Uint8Array) {
    if (raw && raw.length !== GLOBALS_SIZE) {
      throw new Error(`globals image must be ${GLOBALS_SIZE} bytes, got ${raw.length}`);
    }
    this.all = new Uint8Array(GLOBALS_SIZE + SCRATCH_SIZE);
    if (raw) this.all.set(raw);
    this.u8 = this.all.subarray(0, GLOBALS_SIZE);
  }

  private at(off: number): number {
    const i = off + GLOBALS_SIZE;
    if (i < 0 || i >= GLOBALS_SIZE + SCRATCH_SIZE) throw new RangeError(`global ${off} out of range`);
    return i;
  }

  /** Unsigned byte. */
  b(off: number): number {
    return this.all[this.at(off)];
  }

  /** Signed byte. */
  sb(off: number): number {
    return (this.all[this.at(off)] << 24) >> 24;
  }

  /** Unsigned big-endian word. */
  w(off: number): number {
    const i = this.at(off);
    return (this.all[i] << 8) | this.all[i + 1];
  }

  /** Signed big-endian word. */
  sw(off: number): number {
    return (this.w(off) << 16) >> 16;
  }

  /** Unsigned big-endian long. */
  l(off: number): number {
    const i = this.at(off);
    return ((this.all[i] << 24) | (this.all[i + 1] << 16) | (this.all[i + 2] << 8) | this.all[i + 3]) >>> 0;
  }

  setB(off: number, v: number): void {
    this.all[this.at(off)] = v & 0xff;
  }

  setW(off: number, v: number): void {
    const i = this.at(off);
    this.all[i] = (v >> 8) & 0xff;
    this.all[i + 1] = v & 0xff;
  }

  setL(off: number, v: number): void {
    const i = this.at(off);
    this.all[i] = (v >>> 24) & 0xff;
    this.all[i + 1] = (v >>> 16) & 0xff;
    this.all[i + 2] = (v >>> 8) & 0xff;
    this.all[i + 3] = v & 0xff;
  }

  bytes(off: number, size: number): Uint8Array {
    const i = this.at(off);
    return this.all.subarray(i, i + size);
  }

  /** Copy `size` bytes from `from` to `to`. */
  copy(to: number, from: number, size: number): void {
    const i = this.at(from);
    this.all.copyWithin(this.at(to), i, i + size);
  }
}

/** Scratch record `k` (0 to SCRATCH_RECORDS - 1). */
export function scratchRecord(k: number): number {
  return k * 14;
}

/** 16-bit two's-complement value. */
export function s16(v: number): number {
  return (v << 16) >> 16;
}

/** 8-bit two's-complement value. */
export function s8(v: number): number {
  return (v << 24) >> 24;
}

/** 68k DIVS quotient: truncates toward zero. */
export function divs(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** 68k DIVS remainder: takes the sign of the dividend. */
export function rems(a: number, b: number): number {
  return a % b;
}
