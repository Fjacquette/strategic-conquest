/**
 * The original's sounds (CODE 1 + 0x0F3E..0x123E): one sound at a time, asked for by
 * number. Numbers 0–7 are the piece types: the Army's sound for Armies, the Fighter's for
 * Fighters and Bombers, the Ship's for ships. 8 and 9 are the explosion, 10 the battle.
 * A sound counts as finished when it ends or four seconds after it started. Asked for a
 * sound while another plays, the original either leaves it alone or cuts it off and starts
 * the new one.
 */
import { ARMY, BOMBER, FIGHTER } from "../../engine/src/globals.ts";

export type SoundName = "LArmy" | "LFighter" | "LShip" | "LExplosion" | "LBattle";

/** The explosion: a battle or a Bomber's blast. */
export const EXPLOSION = 8;
/** The Bomber's blast (the explosion). */
export const BLAST = 9;
/** Armies fighting. */
export const BATTLE = 10;

/** CODE 1 + 0x1196: the sound for each number. */
function soundName(n: number): SoundName {
  if (n === ARMY) return "LArmy";
  if (n === FIGHTER || n === BOMBER) return "LFighter";
  if (n === EXPLOSION || n === BLAST) return "LExplosion";
  if (n === BATTLE) return "LBattle";
  return "LShip";
}

/** Seconds after which a sound counts as finished (240 ticks). */
const LIMIT = 4;

/** The bytes of a base64 data: URL. */
function dataUrlBytes(url: string): ArrayBuffer {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private readonly sources: Record<string, string>;
  private playing: { node: AudioBufferSourceNode; ends: number } | null = null;
  /** The number of the last sound asked for (CODE 1 + 0x11E4). */
  private lastNumber = -1;

  constructor(sources: Record<string, string>) {
    this.sources = sources;
  }

  /**
   * Called from every click, tap and key press: browsers start audio only from one, and some
   * (Safari) only from a click or a key, not from a pointer press. The sounds are decoded
   * from the page's own bytes, not fetched, so a page whose security policy forbids
   * fetching (as an embedded preview may) still has them.
   */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch (e) {
        console.warn("Sound unavailable:", e);
        return;
      }
      void this.load(this.ctx);
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  private async load(ctx: AudioContext): Promise<void> {
    for (const [name, url] of Object.entries(this.sources)) {
      try {
        this.buffers.set(name as SoundName, await ctx.decodeAudioData(dataUrlBytes(url)));
      } catch (e) {
        console.warn(`Sound ${name} unavailable:`, e);
      }
    }
  }

  /** CODE 1 + 0x11F2: whether the last sound has finished. */
  done(): boolean {
    return !this.enabled || !this.playing || !this.ctx || this.ctx.currentTime >= this.playing.ends;
  }

  /** The number of the last sound asked for. */
  last(): number {
    return this.lastNumber;
  }

  /** CODE 1 + 0x114A: play sound `n`; while another plays, only if `force`, which cuts the other off. */
  play(n: number, force: boolean): void {
    if (!this.enabled) return;
    if (!this.done()) {
      if (!force) return;
      this.stop();
    }
    if (!this.ctx) return;
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    this.lastNumber = n;
    const buffer = this.buffers.get(soundName(n));
    if (!buffer) return;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    node.start();
    node.stop(this.ctx.currentTime + LIMIT);
    this.playing = { node, ends: this.ctx.currentTime + Math.min(LIMIT, buffer.duration) };
  }

  /** CODE 1 + 0x0F3E: cut off the sound playing. */
  stop(): void {
    try {
      this.playing?.node.stop();
    } catch {
      // Already stopped.
    }
    this.playing = null;
  }

  /** The system beep. */
  beep(): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.05, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }
}
