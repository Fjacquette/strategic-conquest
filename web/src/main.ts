/**
 * A game against the computer: the setup dialog, a new game, then day after day. The menus
 * work as the original's: Moves commands apply to the piece being moved, Displays show the
 * city list and the world map, Options switch the sound.
 */
import { GLOBALS_SIZE, Mem } from "../../engine/src/mem.ts";
import {
  AUTO_PLAY, AUTOSAVE_OFF, CITY_COUNT, COMPUTER_FLAG, DAY, GAME_MODE, GAME_SEED, LOCAL_PLAYER, NET_TURN, SKILL, WATER,
} from "../../engine/src/globals.ts";
import { DayLoop, runDay, setUpControllers } from "../../engine/src/day.ts";
import { initGlobals } from "../../engine/src/launch.ts";
import { playerMap, terrainNear } from "../../engine/src/map.ts";
import { generateMap } from "../../engine/src/mapgen.ts";
import { newGame } from "../../engine/src/newgame.ts";
import { ownPiecesAt } from "../../engine/src/query.ts";
import { cityRec } from "../../engine/src/units.ts";
import { assets } from "./assets.ts";
import { BrowserHost } from "./host.ts";
import { Input } from "./input.ts";
import { MapView, RULER_LEFT, RULER_TOP } from "./mapview.ts";
import { Sound } from "./sound.ts";
import { Words } from "./text.ts";
import { type CityRow, UI } from "./ui.ts";

const SCALES = [1, 2, 3, 4];

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A convenience only.
  }
}

function start(): void {
  const A = assets();
  if (!A) {
    const box = document.createElement("div");
    box.className = "missing";
    box.textContent = "This page was built without the original game's artwork and sounds. " +
      "Build it from your own copy: python3 -I tools/assets/extract_assets.py, then npm run build in web/.";
    document.getElementById("mac")?.replaceChildren(box);
    return;
  }
  const words = new Words(A.strings, A.dialogs ?? {});
  const ui = new UI(A, words);
  const view = new MapView(
    document.getElementById("map") as HTMLCanvasElement,
    document.getElementById("ruler-top") as HTMLCanvasElement,
    document.getElementById("ruler-left") as HTMLCanvasElement,
    A,
  );
  const corner = document.getElementById("corner") as HTMLDivElement;
  const input = new Input();
  input.attach(view, () => ui.modal);
  const sound = new Sound(A.sounds);
  const host = new BrowserHost(ui, view, input, words, sound);
  for (const type of ["pointerdown", "click", "touchend", "keydown"]) {
    window.addEventListener(type, () => sound.unlock(), { capture: true });
  }

  const applyScale = (s: number) => {
    view.setScale(s);
    corner.style.width = `${RULER_LEFT * s}px`;
    corner.style.height = `${RULER_TOP * s}px`;
    remember("sc-scale", String(s));
  };
  applyScale(Number(remembered("sc-scale", "2")) || 2);
  sound.enabled = remembered("sc-sound", "1") === "1";
  ui.check("sound", sound.enabled);

  const zoom = (step: number) => {
    const i = Math.max(0, Math.min(SCALES.length - 1, SCALES.indexOf(view.scale) + step));
    applyScale(SCALES[i]);
  };
  window.addEventListener("keydown", (e) => {
    if (ui.modal || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoom(1);
    if (e.key === "-" || e.key === "_") zoom(-1);
  });

  // The game starts from the setup dialog, or from a saved game chosen while it is shown.
  let begin: (choice: StartChoice) => void = () => {};
  const started = new Promise<StartChoice>((resolve) => { begin = resolve; });
  const setup = () => { void ui.setup().then((skill) => begin({ skill, saved: null })); };

  const commands: Record<string, () => void | Promise<void>> = {
    new: async () => {
      if (await ui.ask(words.str(1027), "OK", "Cancel")) location.reload();
    },
    resume: async () => {
      if (host.m) {
        await host.menuResume();
        return;
      }
      const chosen = await host.chooseSavedGame();
      if (!chosen) return;
      if ("bytes" in chosen) {
        begin({ skill: 0, saved: chosen.bytes });
      } else {
        await ui.notice(chosen.problem);
        setup();
      }
    },
    save: async () => {
      if (host.m) await host.menuSave(false);
    },
    saveas: async () => {
      if (host.m) await host.menuSave(true);
    },
    current: () => host.showCurrent(),
    pieceinfo: async () => {
      if (host.m) await host.showPieceInfo(host.m);
    },
    citylist: async () => {
      const m = host.m;
      if (!m) return;
      const city = await ui.cityList(m.sw(DAY), m.sb(SKILL), ...cityTotals(m), cityRows(m));
      if (city !== 0 && host.waiting) {
        const c = cityRec(city);
        await host.production(m, m.sb(c + 7), m.sb(c + 6), m.sb(LOCAL_PLAYER), false);
      }
    },
    worldmap: async () => {
      const m = host.m;
      if (m) await ui.worldMap(view.canvas, m.sb(SKILL), m.sw(DAY));
    },
    landgrid: () => {
      view.landGrid = !view.landGrid;
      ui.check("landgrid", view.landGrid);
      if (host.m) view.draw(host.m);
    },
    zoomin: () => zoom(1),
    zoomout: () => zoom(-1),
    sound: () => {
      sound.enabled = !sound.enabled;
      if (!sound.enabled) sound.stop();
      ui.check("sound", sound.enabled);
      remember("sc-sound", sound.enabled ? "1" : "0");
    },
  };
  ui.attachMenus((cmd) => {
    if (cmd.startsWith("key:")) input.push({ kind: "key", key: cmd.slice(4) });
    else void commands[cmd]?.();
  });

  preview(view);
  setup();
  void main(ui, view, host, words, started);
}

/** The player's cities and the computer's. */
function cityTotals(m: Mem): [number, number] {
  let mine = 0, his = 0;
  for (let i = 1; i <= m.sb(CITY_COUNT); i++) {
    const owner = m.sb(cityRec(i) + 4);
    if (owner === 1) mine++;
    else if (owner === 2) his++;
  }
  return [mine, his];
}

function cityRows(m: Mem): CityRow[] {
  const rows: CityRow[] = [];
  const player = m.sb(LOCAL_PLAYER);
  const dest = (x: number, y: number, dx: number, dy: number) => (dx === x && dy === y ? "" : `${dy},${dx}`);
  for (let i = 1; i <= m.sb(CITY_COUNT); i++) {
    const c = cityRec(i);
    if (m.sb(c + 4) !== player) continue;
    const x = m.sb(c + 7), y = m.sb(c + 6);
    rows.push({
      city: i, type: m.sb(c + 8), days: m.b(c + 5), port: terrainNear(m, x, y, 1 << WATER), x, y,
      pieces: ownPiecesAt(m, x, y, player), armyDest: dest(x, y, m.sb(c + 1), m.sb(c)), airDest: dest(x, y, m.sb(c + 3), m.sb(c + 2)),
    });
  }
  return rows;
}

/** A world for the setup dialog's background. */
function preview(view: MapView): void {
  const m = new Mem(new Uint8Array(GLOBALS_SIZE));
  initGlobals(m);
  m.setB(SKILL, 5);
  m.setL(GAME_SEED, (Math.random() * 0x100000000) >>> 0);
  generateMap(m);
  view.revealAll = true;
  view.draw(m);
}

/** How a game starts: a new game at a skill level, or a saved game. */
interface StartChoice {
  skill: number;
  saved: Uint8Array | null;
}

async function main(ui: UI, view: MapView, host: BrowserHost, words: Words, started: Promise<StartChoice>): Promise<void> {
  const start = await started;
  ui.dismiss();
  view.revealAll = false;
  ui.enable("save", true);
  ui.enable("saveas", true);

  const m = new Mem(new Uint8Array(GLOBALS_SIZE));
  initGlobals(m);
  host.m = m;
  if (start.saved) {
    // As when the original is opened with a saved game, the day loop then counts the day
    // up before the first turn (quirk Q15).
    await host.resume(m, start.saved);
  } else {
    m.setB(GAME_MODE, 0);
    m.setB(SKILL, start.skill);
    m.setB(playerMap(1) + COMPUTER_FLAG, 0);
    m.setB(playerMap(2) + COMPUTER_FLAG, 1);
    m.setB(AUTO_PLAY, 0);
    m.setB(LOCAL_PLAYER, 1);
    m.setB(NET_TURN, 1);
    m.setW(DAY, 1);
    await newGame(m, host);
    m.setB(AUTOSAVE_OFF, 1);
    setUpControllers(m);
  }

  const loop = new DayLoop();
  for (;;) {
    const end = await runDay(m, host, loop);
    view.draw(m);
    if (end.p1Defeated) {
      await ui.notice(words.str(1040));
      return;
    }
    if (end.p2Surrenders && await ui.ask(words.str(1066), "Yes", "No Way")) {
      await ui.notice(words.str(1067));
      return;
    }
  }
}

start();
