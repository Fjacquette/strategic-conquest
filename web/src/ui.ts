/**
 * Everything around the map: the menu bar, the status strip (two message lines, whose move
 * it is and the piece being moved), and the dialogs, laid out as the original's: game
 * setup, city production, the city list, the world map and piece information.
 */
import { type Assets, BITS } from "./assets.ts";
import { iconCanvas } from "./mapview.ts";
import { Words } from "./text.ts";

const $ = <T extends HTMLElement>(id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

/** One line of the production dialog. */
export interface ProductionChoice {
  type: number;
  days: number;
  allowed: boolean;
}

/** One row of the city list. */
export interface CityRow {
  city: number;
  type: number;
  days: number;
  port: boolean;
  x: number;
  y: number;
  pieces: number;
  armyDest: string;
  airDest: string;
}

export class UI {
  readonly viewport = $<HTMLDivElement>("viewport");
  private readonly lines = [$<HTMLParagraphElement>("line1"), $<HTMLParagraphElement>("line2")];
  private readonly turn = $<HTMLSpanElement>("turn");
  private readonly turnIcon = $<HTMLSpanElement>("turn-icon");
  private readonly overlay = $<HTMLDivElement>("overlay");
  private readonly dialog = $<HTMLDivElement>("dialog");
  private readonly menubar = $<HTMLElement>("menubar");
  private readonly assets: Assets;
  private readonly words: Words;
  private openMenu: HTMLElement | null = null;

  constructor(assets: Assets, words: Words) {
    this.assets = assets;
    this.words = words;
  }

  /** A dialog is open: the map takes no input. */
  get modal(): boolean {
    return !this.overlay.hidden;
  }

  // ----- menu bar -----

  /** Menus open on click; choosing an item calls `run` with its command. */
  attachMenus(run: (cmd: string) => void): void {
    for (const title of this.menubar.querySelectorAll<HTMLButtonElement>(".title")) {
      title.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = title.parentElement!;
        const open = this.openMenu === menu;
        this.closeMenus();
        if (!open) {
          menu.classList.add("open");
          this.openMenu = menu;
        }
      });
    }
    for (const item of this.menubar.querySelectorAll<HTMLButtonElement>(".items button")) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeMenus();
        if (!item.disabled) run(item.dataset.cmd ?? "");
      });
    }
    document.addEventListener("click", () => this.closeMenus());
  }

  private closeMenus(): void {
    this.openMenu?.classList.remove("open");
    this.openMenu = null;
  }

  /** Tick or untick a menu item. */
  check(cmd: string, on: boolean): void {
    this.menubar.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle("checked", on);
  }

  // ----- status strip -----

  setLine(line: number, text: string): void {
    this.lines[line === 1 ? 0 : 1].textContent = text;
  }

  /** "Your Move" or "Enemy Move", and the piece being moved (its type), if any. */
  setTurn(yours: boolean | null, type: number | null): void {
    this.turn.textContent = yours === null ? "" : yours ? "Your Move" : "Enemy Move";
    this.turnIcon.replaceChildren(type === null ? "" : iconCanvas(this.assets, BITS.unitRight[type], 1.5));
  }

  // ----- dialogs -----

  private open(build: (d: HTMLDivElement) => void): void {
    this.closeMenus();
    this.dialog.replaceChildren();
    build(this.dialog);
    this.overlay.hidden = false;
    this.dialog.querySelector<HTMLElement>(".default, button")?.focus();
  }

  private close(): void {
    this.overlay.hidden = true;
    this.dialog.replaceChildren();
  }

  private button(label: string, isDefault: boolean, onClick: () => void): HTMLButtonElement {
    const b = el("button", { type: "button", class: isDefault ? "default" : "" }, label);
    b.addEventListener("click", onClick);
    return b;
  }

  /** "Choose a Game Setup": resolves with the skill level. */
  setup(): Promise<number> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog setup";
        const modes = el("div", { class: "modes", role: "radiogroup" });
        const options: [string, boolean][] = [["Single Player Game", true], ["Network Game (coming)", false]];
        options.forEach(([label, enabled], i) => {
          const id = `mode-${i}`;
          const r = el("input", { type: "radio", name: "mode", id });
          r.checked = i === 0;
          r.disabled = !enabled;
          modes.append(el("div", {}, r, el("label", { for: id }, label)));
        });
        const out = el("output", { id: "skill-out" }, "skill level 1");
        const range = el("input", { type: "range", id: "skill", min: "1", max: "15", value: "1", "aria-label": "Skill level" });
        range.addEventListener("input", () => { out.textContent = `skill level ${range.value}`; });
        d.append(
          el("p", {}, "Choose a Game Setup:"), modes,
          this.button("Continue", true, () => { this.close(); resolve(Number(range.value)); }),
          el("div", { class: "skill" }, out, range),
        );
      });
    });
  }

  /** "Select City Production": resolves with the type chosen. */
  production(
    day: number, armyDest: string, airDest: string, current: number, choices: ProductionChoice[], city: HTMLCanvasElement,
  ): Promise<number> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog production";
        let chosen = current;
        const list = el("div", { class: "types", role: "radiogroup", "aria-label": "Production" });
        for (const c of choices) {
          const id = `type-${c.type}`;
          const r = el("input", { type: "radio", name: "type", id });
          r.checked = c.type === current;
          r.disabled = !c.allowed;
          r.addEventListener("change", () => { chosen = c.type; });
          const label = el("label", { for: id }, iconCanvas(this.assets, BITS.unitRight[c.type], 1),
            el("span", { class: "name" }, this.words.typeName(c.type)), el("span", { class: "days" }, String(c.days)),
            el("span", {}, "days to produce."));
          list.append(el("div", { class: c.allowed ? "type" : "type off" }, r, label));
        }
        city.classList.add("preview");
        d.append(
          el("div", { class: "head" }, el("p", {}, "Select City Production"),
            el("p", {}, `Day # ${day}.  CAD: ${armyDest}  CAAD: ${airDest}`)),
          el("div", { class: "body" }, list,
            el("div", { class: "side" }, city, this.button("Continue", true, () => { this.close(); resolve(chosen); }))),
        );
      });
    });
  }

  /** The city list: resolves with a city to change, or 0. */
  cityList(day: number, skill: number, mine: number, his: number, rows: CityRow[]): Promise<number> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog citylist";
        const table = el("table");
        table.append(el("thead", {}, el("tr", {}, ...["Production", "When Ready", "Port City", "(v,h)", "Pieces", "CAD", "CAAD"]
          .map((h) => el("th", {}, h)))));
        const body = el("tbody");
        for (const r of rows) {
          const tr = el("tr", { tabindex: "0", title: "Change what this city builds" },
            el("td", {}, iconCanvas(this.assets, BITS.unitRight[r.type], 1), ` ${this.words.typeName(r.type)}`),
            el("td", {}, `${r.days} days`), el("td", {}, r.port ? "Yes" : "No"), el("td", {}, `${r.y},${r.x}`),
            el("td", {}, String(r.pieces)), el("td", {}, r.armyDest), el("td", {}, r.airDest));
          const pick = () => { this.close(); resolve(r.city); };
          tr.addEventListener("dblclick", pick);
          tr.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
          body.append(tr);
        }
        table.append(body);
        d.append(
          el("div", { class: "head" },
            el("p", {}, "City Summary List.", el("span", {}, `Skill Level:${skill}`)),
            el("p", {}, `Day # ${day}`, el("span", {}, `Total Cities: ${mine} to his ${his}`))),
          this.button("Continue", true, () => { this.close(); resolve(0); }),
          el("div", { class: "scroll" }, table),
          el("p", { class: "note" }, "Double-click a city to change its production."),
        );
      });
    });
  }

  /** The world map: the whole map, small. */
  worldMap(map: HTMLCanvasElement, skill: number, day: number): Promise<void> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog worldmap";
        const small = el("canvas", { width: String(map.width), height: String(map.height) });
        small.getContext("2d")?.drawImage(map, 0, 0);
        d.append(small, el("div", { class: "info" }, el("p", {}, `Level : ${skill}`), el("p", {}, `Day Number : ${day}`),
          this.button("Continue", true, () => { this.close(); resolve(); })));
      });
    });
  }

  /** A notice with one button. */
  notice(text: string, button = "OK"): Promise<void> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog notice";
        d.append(el("p", {}, text), this.button(button, true, () => { this.close(); resolve(); }));
      });
    });
  }

  /** A question with two answers: resolves true for the first. */
  ask(text: string, yes: string, no: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.open((d) => {
        d.classList.value = "dialog notice";
        d.append(el("p", {}, text), el("div", { class: "buttons" },
          this.button(no, false, () => { this.close(); resolve(false); }),
          this.button(yes, true, () => { this.close(); resolve(true); })));
      });
    });
  }
}
