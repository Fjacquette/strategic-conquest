/**
 * Engine routines callable from the differential tests, by name. Arguments arrive as a
 * JSON array; `log` collects host events (requests, messages) for comparison.
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
  playerTurn: (m, [player, actions, ignore, snapAt], log) => {
    const host = new TestHost(actions as Action[], log, ignore ?? []);
    host.snapAt = snapAt ?? -1;
    playerTurn(m, host, player);
  },
  gameRandom: (m) => gameRandom(m),
};
