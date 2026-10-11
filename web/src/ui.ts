/**
 * The page around the map: the status bar, the piece panel, the message lines, the command
 * buttons, and the dialogs (game setup, passing the device, passwords, production).
 */
import { PIECE_NAMES } from "./text.ts";

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

/** What the piece panel shows about the piece being moved. */
export interface PieceInfo {
  player: number;
  type: number;
  x: number;
  y: number;
  movesLeft: number;
  strength: number;
  /** Fuel for aircraft, pieces aboard for Transports and Carriers, else -1. */
  extra: number;
  orders: string;
}

/** One line of the production dialog. */
export interface ProductionChoice {
  type: number;
  days: number;
  allowed: boolean;
}

export class UI {
  readonly mapWrap = $<HTMLDivElement>("map-wrap");
  private readonly status = $<HTMLSpanElement>("status");
  private readonly piece = $<HTMLDivElement>("piece");
  private readonly lines = [$<HTMLParagraphElement>("line1"), $<HTMLParagraphElement>("line2")];
  private readonly hint = $<HTMLParagraphElement>("hint");
  private readonly overlay = $<HTMLDivElement>("overlay");
  private readonly card = $<HTMLDivElement>("card");

  /** A dialog is open: the map takes no input. */
  get modal(): boolean {
    return !this.overlay.hidden;
  }

  setStatus(day: number, player: number): void {
    this.status.replaceChildren(
      el("span", { class: "day" }, `Day ${day}`),
      el("span", { class: `who p${player}` }, `Player ${player}`),
    );
  }

  showPiece(info: PieceInfo | null): void {
    if (!info) {
      this.piece.replaceChildren(el("p", { class: "quiet" }, "Waiting for the next piece."));
      return;
    }
    const rows: [string, string][] = [
      ["Position", `${info.x}, ${info.y}`],
      ["Moves left", String(info.movesLeft)],
      ["Strength", String(info.strength)],
    ];
    if (info.extra >= 0) rows.push([info.type === 1 || info.type === 7 ? "Fuel" : "Aboard", String(info.extra)]);
    if (info.orders) rows.push(["Orders", info.orders]);
    const dl = el("dl");
    for (const [k, v] of rows) dl.append(el("dt", {}, k), el("dd", {}, v));
    this.piece.replaceChildren(el("h2", { class: `p${info.player}` }, PIECE_NAMES[info.type] ?? "Piece"), dl);
  }

  setLine(line: number, text: string): void {
    const p = this.lines[line === 1 ? 0 : 1];
    p.textContent = text;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
  }

  private open(build: (card: HTMLDivElement) => void): void {
    this.card.replaceChildren();
    build(this.card);
    this.overlay.hidden = false;
    const focus = this.card.querySelector<HTMLElement>("[autofocus], input, button");
    focus?.focus();
  }

  private close(): void {
    this.overlay.hidden = true;
    this.card.replaceChildren();
  }

  /** The new-game dialog: returns the skill level chosen. */
  setup(): Promise<number> {
    return new Promise((resolve) => {
      this.open((card) => {
        card.append(
          el("h2", {}, "New game"),
          el("p", {}, "Two players on this device, taking turns. Each player starts with one city; the world beyond it is unexplored."),
        );
        const label = el("label", { for: "skill" }, "Skill level");
        const out = el("output", { id: "skill-out", for: "skill" }, "5");
        const range = el("input", { id: "skill", type: "range", min: "1", max: "15", value: "5" });
        range.addEventListener("input", () => { out.textContent = range.value; });
        const note = el("p", { class: "quiet" },
          "Low levels give player 1 the larger home island; high levels give it to player 2.");
        const go = el("button", { class: "primary", type: "button" }, "Start game");
        go.addEventListener("click", () => {
          this.close();
          resolve(Number(range.value));
        });
        card.append(el("div", { class: "field" }, label, range, out), note, el("div", { class: "actions" }, go));
      });
    });
  }

  /** The device goes to `player`; resolves when that player is ready. */
  passTo(player: number, text: string): Promise<void> {
    return new Promise((resolve) => {
      this.open((card) => {
        const go = el("button", { class: "primary", type: "button" }, `I'm player ${player}`);
        go.addEventListener("click", () => {
          this.close();
          resolve();
        });
        card.append(el("h2", { class: `p${player}` }, `Player ${player}`), el("p", {}, text), el("div", { class: "actions" }, go));
      });
    });
  }

  /**
   * A password: to set one (empty for none), or to check one, retried until it matches.
   * Passwords are up to 5 letters or digits, in capitals (quirk Q14).
   */
  password(player: number, check: string | null): Promise<string> {
    return new Promise((resolve) => {
      this.open((card) => {
        const input = el("input", { id: "password", type: "password", maxlength: "5", autocomplete: "off", autofocus: "" });
        const error = el("p", { class: "error", role: "alert" });
        const form = el("form");
        const go = el("button", { class: "primary", type: "submit" }, check === null ? "Set password" : "Continue");
        form.append(el("label", { for: "password" }, check === null ? "Choose a password (or leave it empty)" : "Your password"), input, error,
          el("div", { class: "actions" }, go));
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
          if (check !== null && value !== check) {
            error.textContent = "That isn't player " + player + "'s password. Try again.";
            input.select();
            return;
          }
          this.close();
          resolve(value);
        });
        card.append(el("h2", { class: `p${player}` }, `Player ${player}`), form);
      });
    });
  }

  /** The production dialog: resolves with the type chosen. */
  production(player: number, x: number, y: number, current: number, choices: ProductionChoice[]): Promise<number> {
    return new Promise((resolve) => {
      this.open((card) => {
        let chosen = current;
        const list = el("div", { class: "types", role: "radiogroup", "aria-label": "Piece to build" });
        for (const c of choices) {
          const id = `type-${c.type}`;
          const radio = el("input", { type: "radio", name: "type", id, value: String(c.type) });
          radio.checked = c.type === current;
          radio.disabled = !c.allowed;
          radio.addEventListener("change", () => { chosen = c.type; });
          const label = el("label", { for: id });
          label.append(el("span", { class: "name" }, PIECE_NAMES[c.type]), el("span", { class: "days" }, c.allowed ? `${c.days} days` : "needs water"));
          list.append(el("div", { class: "type" }, radio, label));
        }
        const go = el("button", { class: "primary", type: "button" }, "Build");
        go.addEventListener("click", () => {
          this.close();
          resolve(chosen);
        });
        card.append(el("h2", { class: `p${player}` }, `City at ${x}, ${y}`), el("p", {}, "What should this city build?"), list,
          el("div", { class: "actions" }, go));
      });
    });
  }

  /** A notice with one button. */
  notice(title: string, text: string, button: string): Promise<void> {
    return new Promise((resolve) => {
      this.open((card) => {
        const go = el("button", { class: "primary", type: "button" }, button);
        go.addEventListener("click", () => {
          this.close();
          resolve();
        });
        card.append(el("h2", {}, title), el("p", {}, text), el("div", { class: "actions" }, go));
      });
    });
  }

  /** A question with two answers: resolves true for the first. */
  ask(title: string, text: string, yes: string, no: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.open((card) => {
        const a = el("button", { class: "primary", type: "button" }, yes);
        const b = el("button", { type: "button" }, no);
        a.addEventListener("click", () => { this.close(); resolve(true); });
        b.addEventListener("click", () => { this.close(); resolve(false); });
        card.append(el("h2", {}, title), el("p", {}, text), el("div", { class: "actions" }, a, b));
      });
    });
  }
}
