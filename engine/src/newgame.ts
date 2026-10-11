/**
 * Starting a new game (CODE 10 + 0x093C): the tables are cleared, the world is generated
 * from a new seed, each player is given the first city of a home island, and the computer
 * opponent studies the world. Rules are documented in docs/rules/mapgen.md.
 *
 * The network game (mode 2) also sends the seed, the terrain, the cities and the skill
 * level to the Slave, and player 2's requests go to the Slave; that is the host's part.
 */
import { Mem, s8 } from "./mem.ts";
import {
  AUTO_PLAY, AUTOSAVE_OFF, DAY, EMPTY, FIGHTER, GAME_MODE, GAME_SEED, MAX_PIECES, NET_SYNC,
  OPPONENT_OF, PIECE_COUNT, PIECE_HASH,
} from "./globals.ts";
import { initCombatTable } from "./battle.ts";
import { swapSides } from "./day.ts";
import { explore } from "./explore.ts";
import { hashClear } from "./hash.ts";
import { CLEAR_LINE, type Host, messageA, Reply, Request, RequestCode } from "./host.ts";
import { inSet, playerMap, setExplored } from "./map.ts";
import { generateMap, HOME_ISLAND } from "./mapgen.ts";
import { PATH_STEP_X, PATH_STEP_Y } from "./path.ts";
import { pieceAt, setOwner, setType } from "./piece.ts";
import { cityAt, cityRec, setCityOwner } from "./units.ts";

/** Each player's password, a Pascal string of up to 5 characters in 6 bytes (players 1, 2). */
export const PASSWORDS = [0, -0x2ce4, -0x2cde];
/** Words set to 10 and 8 at the start of a game and on loading; the computer opponent's limits. */
export const AI_LIMIT_10 = -0x1c8e;
export const AI_LIMIT_8 = -0x1c90;

/** Game modes with two human players (one Mac, or the network game's Master). */
const PASSWORD_MODES = 0x06;
const EXPLORED_BYTES = 0x280;

/** CODE 2 + 0x00EA: empty piece table and position hash; the combat table. */
export function clearTables(m: Mem): void {
  m.setB(NET_SYNC, 1);
  initCombatTable(m);
  m.setW(PATH_STEP_X, 0);
  m.setW(PATH_STEP_Y, 0);
  hashClear(m, PIECE_HASH);
  m.setW(PIECE_COUNT, 0);
  for (let i = 0; i <= MAX_PIECES; i++) {
    setType(m, pieceAt(i), EMPTY);
    setOwner(m, pieceAt(i), 0);
  }
}

/** CODE 2 + 0x20B0: both players know only the map edge. */
export function clearPlayerMaps(m: Mem): void {
  for (let player = 1; player <= 2; player++) {
    m.bytes(playerMap(player), EXPLORED_BYTES).fill(0);
    for (let x = 1; x <= 80; x++) {
      setExplored(m, player, x, 1);
      setExplored(m, player, x, 60);
    }
    for (let y = 1; y <= 60; y++) {
      setExplored(m, player, 1, y);
      setExplored(m, player, 80, y);
    }
  }
}

/** The stand-in piece record the original explores a starting city with (type empty). */
function lookout(scratch: Uint8Array, x: number, y: number): Uint8Array {
  scratch[10] = (scratch[10] & 0xf0) | EMPTY;
  scratch[7] = x;
  scratch[6] = y;
  return scratch;
}

/**
 * CODE 10 + 0x0004: `player` gets city `cityA` and the opponent city `cityB`. Each side sees
 * the 3 × 3 block around its city. Two human players each set a password first, then
 * choose their city's production. The computer's city builds Fighters, and so does
 * player 1's under Auto Play.
 */
export function startingCities(m: Mem, host: Host, player: number, cityA: number, cityB: number): void {
  const req = new Request();
  const reply = new Reply();
  const scratch = new Uint8Array(14);
  const mode = m.sb(GAME_MODE);
  const opp = m.sb(OPPONENT_OF + player);

  let c = cityRec(cityA);
  let x = m.sb(c + 7), y = m.sb(c + 6);
  explore(m, lookout(scratch, x, y), x, y, player);
  req.rec[5] = x;
  req.rec[4] = y;
  req.player = player;
  if (m.b(AUTO_PLAY)) {
    setCityOwner(m, FIGHTER, cityAt(m, x, y), 1);
  } else {
    if (inSet(PASSWORD_MODES, mode)) setPassword(m, host, req, reply, 1);
    req.rec[5] = x;
    req.rec[4] = y;
    req.player = player;
    req.code = RequestCode.TURN_START;
    host.request(m, req, reply);
    req.code = RequestCode.PRODUCTION;
    host.request(m, req, reply);
  }
  req.code = RequestCode.SHOW_POSITION;
  host.request(m, req, reply);

  c = cityRec(cityB);
  x = m.sb(c + 7);
  y = m.sb(c + 6);
  explore(m, lookout(scratch, x, y), x, y, opp);
  req.rec[5] = x;
  req.rec[4] = y;
  req.player = opp;
  const city = cityAt(m, x, y);
  if (inSet(PASSWORD_MODES, mode)) setPassword(m, host, req, reply, 2);
  if (mode === 1 || mode === 2) {
    req.rec[5] = x;
    req.rec[4] = y;
    req.player = opp;
    req.code = RequestCode.PRODUCTION;
    req.ptype = 0;
    host.request(m, req, reply);
    setCityOwner(m, req.ptype, city, mode === 2 ? 2 : opp);
  } else {
    setCityOwner(m, FIGHTER, city, 2);
  }
  req.code = RequestCode.SHOW_POSITION;
  host.request(m, req, reply);
  messageA(m, host, CLEAR_LINE, 1, player, 1, 0);
}

/** The request's player sets a password, kept as password `slot`. */
function setPassword(m: Mem, host: Host, req: Request, reply: Reply, slot: number): void {
  req.code = RequestCode.PASSWORD;
  req.rec[8] = 1;
  host.request(m, req, reply);
  m.bytes(PASSWORDS[slot], 6).set(req.rec.subarray(2, 8));
}

/**
 * CODE 10 + 0x093C: a new game in the current game mode and skill level. Player 1 starts
 * with the first city of home island 1 and player 2 with the first of home island 2. The
 * caller (CODE 2 + 0x2C20) then marks the game as not yet saved (AUTOSAVE_OFF).
 */
export function newGame(m: Mem, host: Host): void {
  m.setB(AUTOSAVE_OFF, 0);
  clearTables(m);
  m.setL(GAME_SEED, host.dateTime(m));
  generateMap(m);
  clearPlayerMaps(m);
  m.setW(DAY, 0);
  const home = HOME_ISLAND[1];
  startingCities(m, host, 1, 1, s8(m.sw(home + 6) + m.sw(home + 8) + 1));
  if (m.sb(GAME_MODE) === 0) {
    host.aiNewGame(m);
    host.aiNewSide(m);
    swapSides(m);
    host.aiNewSide(m);
    swapSides(m);
  }
  const req = new Request();
  req.code = RequestCode.HANDOFF_SCREEN;
  req.player = 1;
  host.request(m, req, new Reply());
  m.setW(AI_LIMIT_10, 10);
  m.setW(AI_LIMIT_8, 8);
}
