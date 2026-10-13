/**
 * A game against the computer or over the network: the setup dialog, a new game, then day
 * after day. The menus work as the original's: Moves commands apply to the piece being moved,
 * Displays show the city list and the world map, Options switch the sound.
 */
import { GLOBALS_SIZE, Mem } from "../../engine/src/mem.ts";
import {
  AUTO_PLAY, AUTO_PLAY_REQUESTED, AUTOSAVE_OFF, CITY_COUNT, COMPUTER_FLAG, DAY, GAME_MODE, GAME_SEED, LOCAL_PLAYER, NET_TURN, SKILL, WATER,
} from "../../engine/src/globals.ts";
import { DayLoop, runDay, setUpControllers } from "../../engine/src/day.ts";
import { type Host } from "../../engine/src/host.ts";
import { initGlobals } from "../../engine/src/launch.ts";
import { playerMap, terrainNear } from "../../engine/src/map.ts";
import { generateMap } from "../../engine/src/mapgen.ts";
import { newGame } from "../../engine/src/newgame.ts";
import { toggleAutoPlay } from "../../engine/src/orders.ts";
import { ownPiecesAt } from "../../engine/src/query.ts";
import { cityRec } from "../../engine/src/units.ts";
import { assets } from "./assets.ts";
import { BrowserHost } from "./host.ts";
import { Input } from "./input.ts";
import { Link } from "./link.ts";
import { MapView, RULER_LEFT, RULER_TOP } from "./mapview.ts";
import { Channel, greet, LostConnection, MasterHost, runSlave } from "./net.ts";
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
  // The game state, for the browser's console and for tests.
  (window as unknown as { scState: () => Uint8Array | null }).scState = () => host.m?.u8 ?? null;
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
  const setup = (): void => {
    void ui.setup().then(async (s) => {
      if (s.mode === "single") {
        begin({ skill: s.skill, saved: null, net: null });
        return;
      }
      try {
        const channel = s.mode === "invite" ? await invite(ui) : await join(ui);
        if (!channel) {
          setup();
          return;
        }
        begin({ skill: s.mode === "invite" ? s.skill : 0, saved: null, net: { master: s.mode === "invite", channel } });
      } catch (e) {
        await ui.notice((e as Error).message);
        setup();
      }
    });
  };

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
      if ("problem" in chosen) {
        await ui.notice(chosen.problem);
        setup();
      } else if (!chosen.network) {
        begin({ skill: 0, saved: chosen.bytes, net: null });
      } else if (await ui.ask("This saved game is a network game. Invite the other player to go on with it?", "Invite", "Cancel")) {
        try {
          const channel = await invite(ui);
          if (channel) begin({ skill: 0, saved: chosen.bytes, net: { master: true, channel } });
          else setup();
        } catch (e) {
          await ui.notice((e as Error).message);
          setup();
        }
      } else {
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
    autoplay: () => {
      const m = host.m;
      if (!m) return;
      toggleAutoPlay(m);
      ui.check("autoplay", m.b(AUTO_PLAY_REQUESTED) !== 0);
    },
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

/**
 * How a game starts: a new game at a skill level, or a saved game; in a network game, this
 * page's role (the Master, player 1, runs the game) and its connection.
 */
interface StartChoice {
  skill: number;
  saved: Uint8Array | null;
  net: { master: boolean; channel: Channel } | null;
}

/** The inviting player's side of the connection; null if cancelled. */
async function invite(ui: UI): Promise<Channel | null> {
  ui.wait("Making your invitation…");
  const { link, code } = await Link.invite();
  const connected = await ui.invite(code, async (reply) => {
    await link.accept(reply);
    await link.ready.catch(() => {
      throw new Error("The two games could not connect. Cancel, then try again with a new invitation.");
    });
  });
  if (!connected) {
    link.close();
    return null;
  }
  const channel = new Channel(link);
  await greet(channel);
  return channel;
}

/** The joining player's side of the connection; null if cancelled. */
async function join(ui: UI): Promise<Channel | null> {
  const joined: { link: Link | null } = { link: null };
  const connected = await ui.join(async (code) => {
    joined.link?.close();
    const { link, reply } = await Link.join(code);
    joined.link = link;
    const ready = link.ready.catch(() => {
      throw new Error("The two games could not connect. Ask the other player for a new invitation.");
    });
    return { reply, connected: ready };
  });
  if (!connected || !joined.link) {
    joined.link?.close();
    return null;
  }
  const channel = new Channel(joined.link);
  await greet(channel);
  return channel;
}

async function main(ui: UI, view: MapView, host: BrowserHost, words: Words, started: Promise<StartChoice>): Promise<void> {
  const start = await started;
  ui.dismiss();
  view.revealAll = false;
  const net = start.net;
  // Only the Master runs the game, so only it saves; network games are not resumed yet.
  ui.enable("save", !net || net.master);
  ui.enable("saveas", !net || net.master);
  ui.enable("autoplay", !net);
  ui.enable("resume", !net);

  const m = new Mem(new Uint8Array(GLOBALS_SIZE));
  initGlobals(m);
  host.m = m;
  try {
    if (net && !net.master) {
      m.setB(LOCAL_PLAYER, 2);
      view.viewer = 2;
      await runSlave(net.channel, host, m);
    } else {
      await play(ui, host, words, m, start, net ? new MasterHost(host, net.channel) : host);
    }
  } catch (e) {
    if (!(e instanceof LostConnection)) throw e;
    await ui.notice(e.message);
  }
}

/** The game on this page: a new one or a saved one, then day after day until it ends. */
async function play(ui: UI, host: BrowserHost, words: Words, m: Mem, start: StartChoice, game: Host): Promise<void> {
  if (start.saved) {
    // As when the original is opened with a saved game, the day loop then counts the day
    // up before the first turn (quirk Q15).
    await host.resume(m, start.saved);
  } else {
    m.setB(GAME_MODE, start.net ? 2 : 0);
    m.setB(SKILL, start.skill);
    m.setB(playerMap(1) + COMPUTER_FLAG, 0);
    m.setB(playerMap(2) + COMPUTER_FLAG, start.net ? 0 : 1);
    m.setB(AUTO_PLAY, 0);
    m.setB(LOCAL_PLAYER, 1);
    m.setB(NET_TURN, 1);
    m.setW(DAY, 1);
    await newGame(m, game);
    m.setB(AUTOSAVE_OFF, 1);
    setUpControllers(m);
  }

  const loop = new DayLoop();
  for (;;) {
    const end = await runDay(m, game, loop);
    host.redraw(m);
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
