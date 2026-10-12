/**
 * Saved games in the original's file format (docs/save-format.md): 11,381 bytes holding the
 * values of 23 globals one after another, so a game saved here opens in the original and
 * the reverse.
 */
import { Mem } from "./mem.ts";
import {
  AUTOSAVE_OFF, CITIES, CITY_COUNT, DAY, GAME_MODE, GAME_SEED, PIECE_COUNT, PIECES, PLAYER_MAPS, SKILL, TERRAIN,
} from "./globals.ts";
import { swapSides } from "./day.ts";
import { type Host, Reply, Request, RequestCode } from "./host.ts";
import { inSet } from "./map.ts";
import { generateMap, ISLAND_CITIES } from "./mapgen.ts";
import { AI_LIMIT_10, AI_LIMIT_8, clearTables, PASSWORDS } from "./newgame.ts";
import { compactPieces } from "./table.ts";
import { cityRec } from "./units.ts";

/**
 * The saved globals in file order (A5 offset, size). The game mode is written twice. From
 * the ninth block on, the computer opponent's data for the side it plays and for the other
 * side, then both players' passwords.
 */
export const SAVED: readonly (readonly [number, number])[] = [
  [GAME_SEED, 4], [GAME_MODE, 1], [SKILL, 1], [DAY, 2], [TERRAIN, 2400], [PIECES, 6314], [PLAYER_MAPS, 1284],
  [GAME_MODE, 1], [CITIES, 460], [PIECE_COUNT, 2],
  [-0x1bfc, 352], [-0x0f86, 352], [-0x1c4e, 32], [-0x0cbc, 32], [-0x1c8c, 46], [-0x0c7c, 46],
  [-0x1c5e, 16], [-0x0c20, 16], [-0x1c02, 2], [-0x0cc6, 2], [-0x1c2e, 2], [-0x0cc0, 2],
  [PASSWORDS[1], 12],
];

export const SAVE_SIZE = SAVED.reduce((n, [, size]) => n + size, 0);

/** Game modes that check both players' passwords after loading (two players). */
const PASSWORD_MODES = 0x06;

/** CODE 10 + 0x0492: the saved game's bytes. */
export function saveGame(m: Mem): Uint8Array {
  const out = new Uint8Array(SAVE_SIZE);
  let pos = 0;
  for (const [off, size] of SAVED) {
    out.set(m.bytes(off, size), pos);
    pos += size;
  }
  return out;
}

/**
 * CODE 1 + 0x09D2: load a saved game. The world is generated again from the saved seed and
 * skill level (for the island map, which is not saved), then the saved values replace the
 * rest; against the computer, its start-of-game analysis runs once the pieces are loaded. Each island's city count is recounted and the piece table compacted, which rebuilds
 * the position hash. Player 1 is then shown the hand-off screen, and with two players both
 * passwords are checked. (In a network game the original also sends the seed to the Slave
 * before generating the world; the network game is not modelled here.)
 */
export async function loadGame(m: Mem, host: Host, file: Uint8Array): Promise<void> {
  if (file.length < SAVE_SIZE) throw new Error(`a saved game has ${SAVE_SIZE} bytes, not ${file.length}`);
  clearTables(m);
  m.setB(AUTOSAVE_OFF, 0);
  let pos = 0;
  for (const [i, [off, size]] of SAVED.entries()) {
    if (i === 3) generateMap(m);
    if (i === 10 && m.sb(GAME_MODE) === 0) {
      // The computer opponent analyses the world for both sides, before its saved data
      // replaces most of what it worked out.
      host.aiNewGame(m);
      host.aiNewSide(m);
      swapSides(m);
      host.aiNewSide(m);
      swapSides(m);
    }
    m.bytes(off, size).set(file.subarray(pos, pos + size));
    pos += size;
  }
  m.setW(AI_LIMIT_10, 10);
  m.setW(AI_LIMIT_8, 8);
  // CODE 2 + 0x0578
  m.bytes(ISLAND_CITIES, 16).fill(0);
  for (let i = 1; i <= m.sb(CITY_COUNT); i++) {
    const island = m.sb(cityRec(i) + 9);
    m.setB(ISLAND_CITIES + island, m.b(ISLAND_CITIES + island) + 1);
  }
  compactPieces(m);

  const req = new Request();
  const reply = new Reply();
  req.code = RequestCode.HANDOFF_SCREEN;
  req.player = 1;
  await host.request(m, req, reply);
  if (!inSet(PASSWORD_MODES, m.sb(GAME_MODE))) return;
  for (const player of [1, 2]) {
    req.rec[8] = 0;
    req.player = player;
    req.rec.set(m.bytes(PASSWORDS[player], 6), 2);
    req.code = RequestCode.PASSWORD;
    await host.request(m, req, reply);
  }
}
