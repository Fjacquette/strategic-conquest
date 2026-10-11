/**
 * The day loop (CODE 1 + 0x170A, the loop at 0x195C): one day is player 1's turn, player
 * 2's turn, and the processing around them.
 *
 * The original's user-interface and network work in the loop becomes host events and
 * requests: the hand-off screens of the two-players-one-Mac game, the day message and
 * battle summary, autosave, and the end-of-game alerts. The network game's transport
 * (game mode 2) and menu actions deferred to the end of the day are left to the host.
 */
import { Mem } from "./mem.ts";
import {
  ARMY, AUTOSAVE_OFF, AUTO_PLAY, AUTO_PLAY_REQUESTED, CITIES_P1, CITIES_P2, CITY_COUNT, COMPUTER_FLAG, DAY,
  GAME_MODE, LOCAL_PLAYER, NET_TURN, OPPONENT_OF, OWN_CITY_CODE, PIECE_COUNT, PLAYER_MAP_SIZE, PRNG_SEED,
  REGION_START, VIEW_PLAYER,
} from "./globals.ts";
import { CLEAR_LINE, type Host, messageA, Reply, Request, RequestCode } from "./host.ts";
import { inSet, playerMap, setTerrain, terrainNear } from "./map.ts";
import { enemyAdjacent } from "./query.ts";
import { pieceAt, pOwner, pSpotted, pType, pX, pY, setAttacks, setMoved, setOwner, setSpotted, setStep } from "./piece.ts";
import { playerTurn } from "./turn.ts";
import { cityRec } from "./units.ts";

/** "day # ^0" (STR 1021). */
const DAY_MESSAGE = 1021;
/** Game modes with end-of-game checks in the day loop (not the network game). */
const CHECKED_MODES = 0x03;
/** Game modes (two players) that autosave every day after day 10. */
const EARLY_SAVE_MODES = 0x06;

/**
 * State the original keeps in the day loop's registers and frame across days: whether the
 * end of the game has been announced (D7), whether the first hand-off screen is still to
 * come (D4), and the request record of the hand-off requests.
 */
export class DayLoop {
  decided = false;
  firstHandoff = true;
  readonly req = new Request();
  readonly reply = new Reply();
}

/** End-of-game outcomes found at the end of a day. */
export interface DayEnd {
  /** Player 1 has lost: "I have smashed your forces. Tough luck!" (STR 1040); the game ends. */
  p1Defeated: boolean;
  /** Player 2 offers its surrender (DLOG 330); declining continues the game. */
  p2Surrenders: boolean;
}

/**
 * CODE 1 + 0x1628: the controllers for the game mode, before the first day of a new or
 * loaded game. Against the computer, player 1 is human and player 2 the computer, unless
 * Auto Play is on (the computer then keeps both sides). With two players both are human and
 * Auto Play is off. (The original also sets up its menus here.)
 */
export function setUpControllers(m: Mem): void {
  const mode = m.sb(GAME_MODE);
  if (mode === 0 && m.b(AUTO_PLAY) !== 0) return;
  if (mode < 0 || mode > 2) return;
  m.setB(playerMap(1) + COMPUTER_FLAG, 0);
  m.setB(playerMap(2) + COMPUTER_FLAG, mode === 0 ? 1 : 0);
  m.setB(AUTO_PLAY, 0);
  m.setB(AUTO_PLAY_REQUESTED, 0);
}

/**
 * CODE 1 + 0x158C: whether `player` has anything to do, so the two-players-one-Mac game
 * hands the Mac over: any piece, or a city that completes a unit this day.
 */
export function handOffNeeded(m: Mem, player: number): boolean {
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    if (pOwner(m, pieceAt(i)) === player) return true;
  }
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    if (m.sb(cr + 4) === player && m.b(cr + 5) === 1) return true;
  }
  return false;
}

/**
 * CODE 1 + 0x1328: `owner`'s spotted pieces fade from the enemy's view. Each spotted piece
 * with no enemy city and no enemy piece beside it loses one level; at 0 the local player's
 * display is told (request 22).
 */
export async function spottedDecay(m: Mem, host: Host, owner: number): Promise<void> {
  const req = new Request();
  const reply = new Reply();
  req.player = m.sb(LOCAL_PLAYER);
  req.code = RequestCode.STEP_DONE_NOTEWORTHY;
  req.flag = 0;
  const enemyCity = m.sb(OWN_CITY_CODE + m.sb(OPPONENT_OF + owner));
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pOwner(m, p) !== owner || pSpotted(m, p) <= 0) continue;
    if (terrainNear(m, pX(m, p), pY(m, p), 1 << enemyCity)) continue;
    if (enemyAdjacent(m, i, pOwner(m, p), pX(m, p), pY(m, p))) continue;
    setSpotted(m, p, pSpotted(m, p) - 1);
    // The network game sends the changed piece to the other Mac here.
    if (pSpotted(m, p) !== 0) continue;
    req.index = i;
    req.pos = m.w(p + 6);
    await host.request(m, req, reply);
  }
}

/**
 * CODE 1 + 0x149A: whether `player` is beaten. Counts both players' cities into
 * CITIES_P1 and CITIES_P2 first. A player other than the local one is beaten when player 1
 * has more than five times its cities; any player is beaten with no city and no Army.
 */
export function defeated(m: Mem, player: number): boolean {
  m.setW(CITIES_P1, 0);
  m.setW(CITIES_P2, 0);
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const owner = m.sb(cityRec(c) + 4);
    if (owner === 1) m.setW(CITIES_P1, m.w(CITIES_P1) + 1);
    else if (owner === 2) m.setW(CITIES_P2, m.w(CITIES_P2) + 1);
  }
  if (player !== m.sb(LOCAL_PLAYER) && Math.trunc(m.sw(CITIES_P1) / 5) > m.sw(CITIES_P2)) return true;
  for (let c = 1; c <= cities; c++) {
    if (m.sb(cityRec(c) + 4) === player) return false;
  }
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    if (pOwner(m, p) === player && pType(m, p) === ARMY) return false;
  }
  return true;
}

/**
 * The computer opponent's working data for the side it plays, swapped with its saved data
 * for the other side: [current, other, scratch, size]. The scratch copy is left holding the
 * new "other" data, as in the original.
 */
const AI_SIDE_BLOCKS: [number, number, number, number][] = [
  [-0x1bfc, -0xf86, -0xe26, 352],
  [-0x1c02, -0xcc6, -0xcc4, 2],
  [-0x1bfd, -0xcc2, -0xcc1, 1],
  [-0x1c2e, -0xcc0, -0xcbe, 2],
  [-0x1c4e, -0xcbc, -0xc9c, 32],
  [-0x1c8c, -0xc7c, -0xc4e, 46],
  [-0x1c5e, -0xc20, -0xc10, 16],
  [-0x1c0c, -0xc00, -0xbfe, 2],
  [-0x1c0e, -0xbfc, -0xbfa, 2],
  [-0x1c10, -0xbf8, -0xbf6, 2],
  [-0x1c12, -0xbf4, -0xbf2, 2],
  [-0x1c14, -0xbf0, -0xbee, 2],
  [-0x1c16, -0xbec, -0xbea, 2],
  [-0x1c18, -0xbe8, -0xbe6, 2],
  [-0x1c1a, -0xbe4, -0xbe2, 2],
  [-0x1c1c, -0xbe0, -0xbde, 2],
  [-0x1c1d, -0xbdc, -0xbdb, 1],
  [-0x1c1e, -0xbda, -0xbd9, 1],
  [-0x1c1f, -0xbd8, -0xbd7, 1],
  [-0x1c20, -0xbd6, -0xbd5, 1],
  [-0x1c21, -0xbd4, -0xbd3, 1],
  [-0x1c22, -0xbd2, -0xbd1, 1],
  [-0x1c23, -0xbd0, -0xbcf, 1],
  [-0x1c24, -0xbce, -0xbcd, 1],
];
/** Scratch copy of a player map used by swapSides(). */
const MAP_SCRATCH = -0x1208;

/**
 * CODE 1 + 0x2C48: exchange the two sides, so that the computer opponent, which plays
 * player 2, can play player 1's side under Auto Play: the players' maps, the computer
 * opponent's per-side data, and the owners of every city and piece.
 */
export function swapSides(m: Mem): void {
  m.setB(VIEW_PLAYER, m.b(OPPONENT_OF + m.sb(VIEW_PLAYER)));
  m.copy(MAP_SCRATCH, playerMap(1), PLAYER_MAP_SIZE);
  m.copy(playerMap(1), playerMap(2), PLAYER_MAP_SIZE);
  m.copy(playerMap(2), MAP_SCRATCH, PLAYER_MAP_SIZE);
  for (const [cur, oth, tmp, size] of AI_SIDE_BLOCKS) {
    m.copy(tmp, cur, size);
    m.copy(cur, oth, size);
    m.copy(oth, tmp, size);
  }
  const cities = m.sb(CITY_COUNT);
  for (let c = 1; c <= cities; c++) {
    const cr = cityRec(c);
    m.setB(cr + 4, m.b(OPPONENT_OF + m.sb(cr + 4)));
    setTerrain(m, m.sb(cr + 7), m.sb(cr + 6), m.sb(OWN_CITY_CODE + m.sb(cr + 4)));
  }
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    setOwner(m, p, m.sb(OPPONENT_OF + pOwner(m, p)));
  }
}

/** Start of the day: every piece may move and attack again, and may be repaired again. */
export function dailyReset(m: Mem): void {
  const n = m.sw(PIECE_COUNT);
  for (let i = 1; i <= n; i++) {
    const p = pieceAt(i);
    setMoved(m, p, 0);
    m.setB(p + 13, 0);
    setStep(m, p, 0);
    setAttacks(m, p, 0);
  }
}

/** CODE 1 + 0x1474: "day # N" on message line 2 for `player`. */
function dayMessage(m: Mem, host: Host, player: number): void {
  messageA(m, host, (m.w(DAY) << 16) | DAY_MESSAGE, 2, player, 0, 1);
}

/** Clear both message lines, for every player's display. */
function clearLines(m: Mem, host: Host, player: number): void {
  messageA(m, host, CLEAR_LINE, 1, player, 1, 0);
  messageA(m, host, CLEAR_LINE, 2, player, 1, 0);
}

/** The two-players-one-Mac game hands the Mac to `player`, who then sees the day's news. */
async function handOff(m: Mem, host: Host, loop: DayLoop, player: number): Promise<void> {
  m.setB(LOCAL_PLAYER, player);
  m.setB(NET_TURN, player);
  loop.req.player = player;
  if (player === 1 && loop.firstHandoff) {
    loop.firstHandoff = false;
  } else {
    loop.req.code = RequestCode.HIDE_MAP;
    await host.request(m, loop.req, loop.reply);
    loop.req.code = RequestCode.HANDOFF_SCREEN;
    await host.request(m, loop.req, loop.reply);
  }
  // CODE 1 + 0x2BB6: the player's map view is restored, and the sweep starts at region 0.
  m.setB(REGION_START, 0);
  loop.req.code = RequestCode.SHOW_MAP;
  await host.request(m, loop.req, loop.reply);
  dayMessage(m, host, player);
  host.event(m, "battleSummary", { player });
}

/** The day's news for `player` (one-Mac games against the computer, and network games). */
function news(m: Mem, host: Host, player: number, summaryFor: number): void {
  dayMessage(m, host, player);
  host.event(m, "battleSummary", { player: summaryFor });
}

/**
 * The end-of-game checks after both turns (not in the network game). Player 1 is beaten
 * with no city, or when defeated() says so after day 100; player 2 likewise offers its
 * surrender. Once either has happened, only a player left with no city triggers them again.
 */
export function endChecks(m: Mem, loop: DayLoop): DayEnd {
  const end: DayEnd = { p1Defeated: false, p2Surrenders: false };
  if (!inSet(CHECKED_MODES, m.sb(GAME_MODE))) return end;
  const late = () => m.sw(DAY) > 100;
  const p1 = (defeated(m, 1) && late()) || m.w(CITIES_P1) === 0;
  if (p1 && (!loop.decided || m.w(CITIES_P1) === 0)) {
    end.p1Defeated = true;
    loop.decided = true;
  }
  const p2 = (defeated(m, 2) && late()) || m.w(CITIES_P2) === 0;
  if (p2 && (!loop.decided || m.w(CITIES_P2) === 0)) {
    end.p2Surrenders = true;
    loop.decided = true;
  }
  return end;
}

/** One day: from the day count's increment to the reseeding of the game PRNG. */
export async function runDay(m: Mem, host: Host, loop: DayLoop): Promise<DayEnd> {
  const mode = () => m.sb(GAME_MODE);
  m.setW(DAY, m.w(DAY) + 1);
  const day = () => m.sw(DAY);

  const everyThird = day() % 3 === 0 && day() > 20;
  const early = inSet(EARLY_SAVE_MODES, mode()) && day() > 10;
  if ((everyThird || early) && m.b(AUTOSAVE_OFF) === 0) host.event(m, "autosave", {});

  if (mode() === 1) {
    if (handOffNeeded(m, 1)) await handOff(m, host, loop, 1);
  } else if (mode() === 0) {
    news(m, host, 1, m.sb(LOCAL_PLAYER));
  } else if (mode() === 2) {
    host.beep(m, 1);
    news(m, host, 1, 1);
  }
  host.event(m, "clearReports", {});
  dailyReset(m);

  if (m.b(AUTO_PLAY) !== 0) {
    m.setB(LOCAL_PLAYER, 2);
    m.setB(NET_TURN, 2);
    swapSides(m);
    await playerTurn(m, host, 2);
    messageA(m, host, CLEAR_LINE, 1, 2, 1, 0);
    await spottedDecay(m, host, 1);
    swapSides(m);
    m.setB(NET_TURN, 1);
    m.setB(LOCAL_PLAYER, 1);
  } else {
    m.setB(LOCAL_PLAYER, 1);
    m.setB(NET_TURN, 1);
    await playerTurn(m, host, 1);
    await spottedDecay(m, host, 2);
    clearLines(m, host, 1);
    m.setB(NET_TURN, 2);
  }

  if (mode() === 1) {
    if (handOffNeeded(m, 2)) await handOff(m, host, loop, 2);
  }
  if (mode() === 2) {
    host.beep(m, 2);
    news(m, host, 2, 2);
  }
  host.event(m, "clearReports", {});
  await playerTurn(m, host, 2);
  clearLines(m, host, 2);
  await spottedDecay(m, host, 1);

  const end = endChecks(m, loop);

  const requested = m.b(AUTO_PLAY_REQUESTED), active = m.b(AUTO_PLAY);
  if (requested !== 0 && (requested & (active ^ 1)) !== 0) {
    m.setB(playerMap(1) + COMPUTER_FLAG, 1);
    m.setB(AUTO_PLAY, requested);
    host.event(m, "autoPlay", { on: 1 });
  } else if (((requested ^ 1) & active) !== 0) {
    host.event(m, "autoPlay", { on: 0 });
    m.setB(playerMap(1) + COMPUTER_FLAG, 0);
    m.setB(AUTO_PLAY, requested);
  }

  m.setL(PRNG_SEED, host.dateTime(m));
  return end;
}
