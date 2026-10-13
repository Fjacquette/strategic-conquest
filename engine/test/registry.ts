/**
 * Engine routines callable from the differential tests, by name. Arguments arrive as a
 * JSON array; `log` collects host events (requests, messages) for comparison. A routine
 * may return a promise, which the bridge awaits.
 */
import { Mem, SCRATCH_RECORDS, scratchRecord } from "../src/mem.ts";
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
import { aiPlan } from "../src/ai/plan.ts";
import { aiNewGame, aiNewSide } from "../src/ai/setup.ts";
import { aiFocus, aiIslandReview, aiNewPiece, aiProduction, wakeLightTransports } from "../src/ai/production.ts";
import {
  aiTransport, bestLanding, islandForArmies, landCount, nearestIsland, transportArrives, transportMove, transportSail,
} from "../src/ai/transports.ts";
import { nearestPort, randomSeaTarget, shipGoTo, shipMove } from "../src/ai/ships.ts";
import { bomberMove, bomberTarget, wakeOtherBombers } from "../src/ai/bombers.ts";
import { aiMoveChooser } from "../src/ai/chooser.ts";
import { clearLine, evade, followOrders, takesOn } from "../src/ai/moves.ts";
import { armyAboard, armyMove, exploreIsland, huntArmies, sendToCity } from "../src/ai/armies.ts";
import { hypot } from "../src/map.ts";
import {
  exploreAround, fighterBase, fighterMove, fighterReturn, fighterSearch, fighterStep, fighterTarget,
} from "../src/ai/fighters.ts";
import { aiSurvey, wakeTransports } from "../src/ai/survey.ts";
import { Reply, Request } from "../src/host.ts";
import { TestHost, type Action } from "./testhost.ts";

type Fn = (m: Mem, args: any[], log: unknown[]) => unknown;

/**
 * A piece record argument: a piece index, or a record copy the original kept on its stack
 * ({rec: its 14 bytes}), which is placed in a scratch record.
 */
function record(m: Mem, arg: number | { rec: number[] }): number {
  if (typeof arg === "number") return pieceAt(arg);
  const r = scratchRecord(SCRATCH_RECORDS - 1);
  m.bytes(r, 14).set(arg.rec);
  return r;
}

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
  aiPlan: (m) => aiPlan(m),
  aiNewGame: (m) => aiNewGame(m),
  aiNewSide: (m) => aiNewSide(m),
  aiNewPiece: (m, [city]) => aiNewPiece(m, city),
  aiSurvey: (m) => aiSurvey(m),
  aiProduction: (m) => aiProduction(m),
  aiIslandReview: (m, [_rec, island]) => aiIslandReview(m, island),
  wakeLightTransports: (m) => wakeLightTransports(m),
  aiFocus: (m) => aiFocus(m),
  aiTransport: (m, [_p, idx]) => aiTransport(m, idx),
  takesOn: (m, [mover, other]) => (takesOn(m, pieceAt(other), pieceAt(mover)) ? 1 : 0),
  followOrders: (m, [_req, _reply, idx]) => {
    const reply = new Reply();
    followOrders(m, idx, reply);
    return [reply.dx, reply.dy];
  },
  transportArrives: (m, [_p, idx, reply]) => [transportArrives(m, idx) ? 1 : 0, ...reply],
  hypot: (_m, [dx, dy]) => hypot(dx, dy),
  clearLine: (m, [x1, y1, x2, y2, set]) => (clearLine(m, x1, y1, x2, y2, set) ? 1 : 0),
  armyMove: (m, [_p, idx]) => armyMove(m, idx),
  armyAboard: (m, [p, _set, island]) => armyAboard(m, pieceAt(p), island),
  sendToCity: (m, [p, island]) => (sendToCity(m, pieceAt(p), island) ? 1 : 0),
  huntArmies: (m, [p, island, types]) => huntArmies(m, pieceAt(p), island, types),
  exploreIsland: (m, [p, island]) => (exploreIsland(m, pieceAt(p), island) ? 1 : 0),
  fighterMove: (m, [_p, idx]) => fighterMove(m, idx),
  fighterTarget: (m, [p, idx]) => (fighterTarget(m, pieceAt(p), idx) ? 1 : 0),
  fighterReturn: (m, [p]) => fighterReturn(m, pieceAt(p)),
  fighterSearch: (m, [p]) => fighterSearch(m, pieceAt(p)),
  fighterStep: (m, [p]) => fighterStep(m, pieceAt(p)),
  exploreAround: (m, [p, set, r]) => exploreAround(m, pieceAt(p), set, r),
  fighterBase: (m, [p]) => fighterBase(m, pieceAt(p)),
  evade: (m, [p, enemy, _dx, _dy, set, n, flag]) => {
    const d = evade(m, record(m, p), enemy, set, n, !!flag);
    return [d.dx, d.dy];
  },
  shipGoTo: (m, [p, x, y]) => shipGoTo(m, record(m, p), x, y),
  nearestPort: (m, [p]) => nearestPort(m, record(m, p)),
  randomSeaTarget: (m, [p]) => randomSeaTarget(m, record(m, p)),
  shipMove: (m, [_p, idx]) => shipMove(m, idx),
  islandForArmies: (m, [x, y]) => islandForArmies(m, x, y),
  landCount: (m, [x, y, island]) => landCount(m, x, y, island),
  bestLanding: (m, [x, y, island]) => {
    const d = bestLanding(m, x, y, island);
    return [d.dx, d.dy];
  },
  nearestIsland: (m, [x, y]) => nearestIsland(m, x, y),
  transportSail: (m, [p, idx]) => transportSail(m, record(m, p), idx),
  transportMove: (m, [_p, idx]) => transportMove(m, idx),
  wakeOtherBombers: (m, [idx]) => wakeOtherBombers(m, idx),
  bomberTarget: (m, [p, idx]) => bomberTarget(m, record(m, p), idx),
  bomberMove: (m, [_p, _req, idx]) => bomberMove(m, idx),
  aiMoveChooser: (m, [rec, replyInit]) => {
    const req = new Request();
    req.rec.set(rec);
    const reply = new Reply();
    reply.buf.set(replyInit.map((v: number) => v & 0xff));
    const moved = aiMoveChooser(m, req, reply);
    return [moved ? 1 : 0, reply.dx, reply.dy];
  },
  wakeTransports: (m) => wakeTransports(m),
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
  newGame: async (m, [clock, production, ignore, computer], log) => {
    const host = new TestHost([], log, ignore ?? []);
    host.clock = clock;
    host.production = production;
    host.computer = !!computer;
    await newGame(m, host);
  },
  runDay: async (m, [actions, clock, decided, firstHandoff, computer, production], log) => {
    const host = new TestHost(actions as Action[], log);
    host.clock = clock;
    host.computer = !!computer;
    host.production = production ?? [];
    const loop = new DayLoop();
    loop.decided = !!decided;
    loop.firstHandoff = !!firstHandoff;
    const end = await runDay(m, host, loop);
    return [end.p1Defeated, end.p2Surrenders, loop.decided, loop.firstHandoff];
  },
};
