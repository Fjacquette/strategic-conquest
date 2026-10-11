/**
 * The original's sounds (CODE 1 + 0x114A): one sound at a time, chosen by piece type: the
 * Army's for Armies, the Fighter's for Fighters and Bombers, the Ship's for ships; the
 * explosion when a piece is destroyed, and the battle. A sound plays for at most four
 * seconds. Asked for a sound while another plays, the original either leaves it alone or
 * cuts it off and starts the new one.
 */
import { ARMY, BOMBER, EMPTY, FIGHTER, REMOVED } from "../../engine/src/globals.ts";

export type SoundName = "LArmy" | "LFighter" | "LShip" | "LExplosion" | "LBattle";

/** The sound for a piece type (8 and 9, a destroyed piece: the explosion). */
export function soundFor(type: number): SoundName {
  if (type === ARMY) return "LArmy";
  if (type === FIGHTER || type === BOMBER) return "LFighter";
  if (type === REMOVED || type === EMPTY) return "LExplosion";
  return "LShip";
}

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
  private playing: { name: SoundName; node: AudioBufferSourceNode; ends: number } | null = null;

  constructor(sources: Record<string, string>) {
    this.sources = sources;
  }

  /**
   * Called from every click, tap and key press: browsers start audio only from one, and some
   * (Safari) only from a click or a key, not from a pointer press.
   */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
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
      } catch {
        // That sound stays silent.
      }
    }
  }

  /** Whether the last sound has finished. */
  done(): boolean {
    return !this.playing || !this.ctx || this.ctx.currentTime >= this.playing.ends;
  }

  current(): SoundName | null {
    return this.done() ? null : this.playing!.name;
  }

  /** Play `name`; while another sound plays, only if `force` (which cuts the other off). */
  play(name: SoundName, force: boolean): void {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    if (!this.done()) {
      if (!force) return;
      this.stop();
    }
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    node.start();
    node.stop(this.ctx.currentTime + LIMIT);
    this.playing = { name, node, ends: this.ctx.currentTime + Math.min(LIMIT, buffer.duration) };
  }

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
