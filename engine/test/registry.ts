/**
 * Engine routines callable from the differential tests, by name. Arguments arrive as a
 * JSON array; `log` collects host events (requests, messages) for comparison. A routine
 * may return a promise, which the bridge awaits.
 */
import { Mem } from "../src/mem.ts";
import { hashFind, hashInsert, hashRemove, topPieceAt } from "../src/hash.ts";
import { onMap, terrainNear } from "../src/map.ts";
import { boardingFull, countAt, enemyAdjacent, ownPiecesAt, topIs } from "../src/query.ts";
import { explore } from "../src/explore.ts";
import { carryCargo, movePiece, setDestination, wakeAdjacent, wakeAllAt } from "../src/moveops.ts";
import { compactPieces } from "../src/table.ts";
import { pieceAt } from "../src/piece.ts";
import { nextStep } from "../src/path.ts";
import { gameRandom, qdRandom } from "../src/random.ts";
import { attack, bomberBlast } from "../src/battle.ts";
import { playerTurn } from "../src/turn.ts";
import { buildPiece, movesPerDay, productionDays } from "../src/units.ts";
import {
  DayLoop, defeated, endChecks, handOffNeeded, runDay, setUpControllers, spottedDecay, swapSides,
} from "../src/day.ts";
import * as orders from "../src/orders.ts";
import { coastalCity, generateMap, inlandCity, islandOutline, placeCity, scatterCities } from "../src/mapgen.ts";
import { putLine, Region } from "../src/quickdraw.ts";
import { clearPlayerMaps, clearTables, newGame, startingCities } from "../src/newgame.ts";
import { initGlobals } from "../src/launch.ts";
import { loadGame, saveGame } from "../src/savefile.ts";
import { Reply, Request } from "../src/host.ts";
import { TestHost, type Action } from "./testhost.ts";

type Fn = (m: Mem, args: any[], log: unknown[]) => unknown;

export const registry: Record<string, Fn> = {
  hashInsert: (m, [table, x, y, idx, ptype]) => hashInsert(m, table, x, y, idx, ptype),
  hashFind: (m, [table, x, y]) => hashFind(m, table, x, y),
  hashRemove: (m, [table, idx]) => hashRemove(m, table, idx),
  topPieceAt: (m, [x, y]) => topPieceAt(m, x, y),
  onMap: (_m, [x, y]) => onMap(x, y),
  terrainNear: (m, [x, y, set]) => terrainNear(m, x, y, set),
  enemyAdjacent: (m, [u, player, x, y]) => enemyAdjacent(m, u, player, x, y),
  topIs: (m, [x, y, typeSet, ownerSet]) => topIs(m, x, y, typeSet, ownerSet),
  boardingFull: (m, [x, y, player, ptype]) => boardingFull(m, x, y, player, ptype),
  countAt: (m, [table, x, y, os, ts, cargo, setCargo, upd, obs]) =>
    countAt(m, table, x, y, os, ts, cargo, !!setCargo, !!upd, obs),
  ownPiecesAt: (m, [x, y, owner]) => ownPiecesAt(m, x, y, owner),
  explore: (m, [idx, x, y, player]) => explore(m, pieceAt(idx), x, y, player),
  movePiece: (m, [idx, x, y, dx]) => movePiece(m, pieceAt(idx), x, y, idx, dx),
  carryCargo: (m, [ox, oy, nx, ny, idx]) => carryCargo(m, ox, oy, nx, ny, idx),
  wakeAdjacent: (m, [x, y, owner, ts, idx]) => wakeAdjacent(m, x, y, owner, ts, idx),
  wakeAllAt: (m, [x, y]) => wakeAllAt(m, x, y),
  setDestination: (m, [idx, x, y]) => setDestination(m, pieceAt(idx), x, y),
  compactPieces: (m) => compactPieces(m),
  nextStep: (m, [set, idx]) => {
    const d = nextStep(m, set, m.bytes(pieceAt(idx), 14));
    return [d.dx, d.dy];
  },
  qdRandom: (m) => qdRandom(m),
  attack: (m, [aIdx, bIdx, spotted, keys]) =>
    attack(m, pieceAt(aIdx), pieceAt(bIdx), aIdx, bIdx, spotted, new Set(keys ?? [])),
  bomberBlast: (m, [idx]) => bomberBlast(m, pieceAt(idx), idx),
  movesPerDay: (m, [ptype, strength]) => movesPerDay(m, ptype, strength),
  productionDays: (m, [ptype]) => productionDays(m, ptype),
  buildPiece: (m, [x, y, owner, ptype]) => buildPiece(m, x, y, owner, ptype),
  playerTurn: async (m, [player, actions, ignore, snapAt], log) => {
    const host = new TestHost(actions as Action[], log, ignore ?? []);
    host.snapAt = snapAt ?? -1;
    await playerTurn(m, host, player);
  },
  gameRandom: (m) => gameRandom(m),
  handOffNeeded: (m, [player]) => handOffNeeded(m, player),
  defeated: (m, [player]) => defeated(m, player),
  swapSides: (m) => swapSides(m),
  spottedDecay: (m, [owner], log) => spottedDecay(m, new TestHost([], log), owner),
  endChecks: (m, [decided]) => {
    const loop = new DayLoop();
    loop.decided = !!decided;
    const end = endChecks(m, loop);
    return [end.p1Defeated, end.p2Surrenders, loop.decided];
  },
  order: (m, [name, rec, replyInit, player, a]) => {
    const req = new Request();
    req.rec.set(rec);
    const reply = new Reply();
    reply.buf.set(replyInit);
    const [x, y, tx, ty] = a ?? [];
    let done = false;
    switch (name) {
      case "sleep": done = orders.sleep(m, req, reply, player); break;
      case "random": done = orders.random(m, req, reply, player); break;
      case "skip": done = orders.skip(m, reply); break;
      case "moveLater": done = orders.moveLater(m, reply); break;
      case "wake": orders.wake(m, x, y); break;
      case "load": done = orders.load(m, req, reply, player, x, y); break;
      case "aircraftDestination": done = orders.aircraftDestination(m, req, reply, player, x, y, tx, ty); break;
      case "armyDestination": orders.armyDestination(m, player, x, y, tx, ty); break;
      case "stackMove": done = orders.stackMove(m, req, reply, player, x, y, tx, ty); break;
      case "patrol": done = orders.patrol(m, req, reply, player, x, y, tx, ty); break;
      case "clickDirection": done = orders.clickDirection(req, reply, x, y); break;
      case "goTo": done = orders.goTo(m, req, reply, player, x, y, tx, ty); break;
      default: throw new Error(`unknown order ${name}`);
    }
    return [done ? 1 : 0, reply.buf[0], reply.buf[1]];
  },
  chooseProduction: (m, [city, type, days, ptype]) => (orders.chooseProduction(m, { city, type, days }, ptype) ? 1 : 0),
  openProduction: (m, [x, y, owner, captured]) => {
    const d = orders.openProduction(m, x, y, owner, !!captured);
    return [d.city, d.type, d.days];
  },
  generateMap: (m) => generateMap(m),
  islandOutline: (m, [cx, cy, size, roughness]) => islandOutline(m, cx, cy, size, roughness),
  placeCity: (m, [x, y]) => (placeCity(m, x, y) ? 1 : 0),
  coastalCity: (m, [island]) => (coastalCity(m, island) ? 1 : 0),
  inlandCity: (m, [top, left, bottom, right, island]) => (inlandCity(m, { top, left, bottom, right }, island) ? 1 : 0),
  scatterCities: (m) => scatterCities(m),
  putLine: (_m, [h1, v1, h2, v2]) => {
    const out: number[] = [];
    putLine(out, h1, v1, h2, v2);
    return out;
  },
  outlineRegion: (_m, [outline]) => {
    const r = Region.fromOutline(outline);
    const b = r.bbox();
    return [r.points, [b.top, b.left, b.bottom, b.right]];
  },
  initGlobals: (m) => initGlobals(m),
  saveGame: (m) => Array.from(saveGame(m)),
  loadGame: async (m, [file, ignore], log) => {
    const host = new TestHost([], log, ignore ?? []);
    await loadGame(m, host, Uint8Array.from(file as number[]));
  },
  setUpControllers: (m) => setUpControllers(m),
  clearTables: (m) => clearTables(m),
  clearPlayerMaps: (m) => clearPlayerMaps(m),
  startingCities: async (m, [player, cityA, cityB, production, ignore], log) => {
    const host = new TestHost([], log, ignore ?? []);
    host.production = production;
    await startingCities(m, host, player, cityA, cityB);
  },
  newGame: async (m, [clock, production, ignore], log) => {
    const host = new TestHost([], log, ignore ?? []);
    host.clock = clock;
    host.production = production;
    await newGame(m, host);
  },
  runDay: async (m, [actions, clock, decided, firstHandoff], log) => {
    const host = new TestHost(actions as Action[], log);
    host.clock = clock;
    const loop = new DayLoop();
    loop.decided = !!decided;
    loop.firstHandoff = !!firstHandoff;
    const end = await runDay(m, host, loop);
    return [end.p1Defeated, end.p2Surrenders, loop.decided, loop.firstHandoff];
  },
};
