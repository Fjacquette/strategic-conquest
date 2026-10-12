/**
 * The game's save file. Where the browser lets a page keep a file it was given (Chrome and
 * Edge), the game has its own file as in the original: Save writes to it, Save As picks
 * another, and the autosave writes to it. Elsewhere a saved game is downloaded, and a game
 * is resumed from a file the player picks.
 *
 * Files are in the original's format, so a game saved here opens in the original and the
 * reverse.
 */

/** The parts of the File System Access API used here (not in TypeScript's DOM types). */
interface FilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FilePickers {
  showSaveFilePicker?: (options: FilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
}

const TYPES = [{ description: "Strategic Conquest saved game", accept: { "application/octet-stream": [".sav"] } }];

/** The picker was cancelled: an AbortError. */
function cancelled(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export class GameFile {
  private handle: FileSystemFileHandle | null = null;
  /** The file's name, offered again when saving. */
  name: string;

  constructor(defaultName: string) {
    this.name = `${defaultName}.sav`;
  }

  private get pickers(): FilePickers {
    return window as unknown as FilePickers;
  }

  /** Whether the game has a file to write without asking. */
  get chosen(): boolean {
    return this.handle !== null;
  }

  /**
   * Pick the file to save the game in. Must run while handling a click or a key. Resolves
   * false if the player cancelled; true otherwise, also where the browser cannot keep a file
   * (the game is then downloaded when it is saved).
   */
  async chooseSave(): Promise<boolean> {
    const pick = this.pickers.showSaveFilePicker;
    if (!pick) return true;
    try {
      this.handle = await pick({ suggestedName: this.name, types: TYPES });
      this.name = this.handle.name;
      return true;
    } catch (e) {
      if (cancelled(e)) return false;
      this.handle = null;
      return true;
    }
  }

  /** Pick a saved game to open: its bytes, or null if the player cancelled. Must run while handling a click or a key. */
  async chooseOpen(): Promise<Uint8Array | null> {
    const pick = this.pickers.showOpenFilePicker;
    if (pick) {
      try {
        const [handle] = await pick({ types: TYPES });
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        // The game keeps the file it was resumed from, if the player lets it write there.
        this.handle = (await writable(handle)) ? handle : null;
        this.name = handle.name;
        return bytes;
      } catch (e) {
        if (cancelled(e)) return null;
      }
    }
    const file = await pickWithInput();
    if (!file) return null;
    this.handle = null;
    this.name = file.name;
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Write the game to its file. Resolves false if there is no file or writing failed. */
  async write(bytes: Uint8Array): Promise<boolean> {
    if (!this.handle) return false;
    try {
      const out = await this.handle.createWritable();
      await out.write(bytes);
      await out.close();
      return true;
    } catch (e) {
      console.warn("Saving failed:", e);
      return false;
    }
  }

  /** Download the game as a file (must run while handling a click). */
  download(bytes: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = this.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Ask to write to a file the player opened; whether that is allowed. */
async function writable(handle: FileSystemFileHandle): Promise<boolean> {
  const ask = (handle as unknown as { requestPermission?: (d: { mode: string }) => Promise<string> }).requestPermission;
  if (!ask) return false;
  try {
    return (await ask.call(handle, { mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** A file chosen with a file input, or null if none was chosen. */
function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sav,application/octet-stream";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
