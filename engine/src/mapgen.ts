/**
 * Map generation (EMPINIT segment, CODE 2 + 0x1CDC and the routines it calls): the world
 * is built from the game seed. Loading a saved game regenerates it from the saved seed
 * before reading the saved state over it, and the network game's Slave builds its copy from
 * the seed the Master sends. Rules are documented in docs/rules/mapgen.md.
 *
 * Islands are random polygons (in pixels of the 16 × 12 map cells) turned into QuickDraw
 * regions; an island may not overlap those already placed, and a cell is land when its
 * centre lies in an island's region. The two home islands come first, sized by the skill
 * level, each with a set number of coastal and inland cities; up to 13 more islands
 * follow, then cities are scattered over them until there are 45.
 */
import { Mem, s16 } from "./mem.ts";
import {
  CITY_COUNT, EDGE, GAME_SEED, ISLAND_MAP, LAND, PRNG_SEED, QD_RANDSEED, SKILL, TERRAIN, WATER,
} from "./globals.ts";
import { terrainAt, setTerrain } from "./map.ts";
import { PolyRecorder, ptInRect, Region, sectRect, type Rect } from "./quickdraw.ts";
import { qdRandom } from "./random.ts";
import { cityRec } from "./units.ts";

/** Home island records, players 1 and 2: words x (low byte), size, roughness, coastal and inland cities. */
export const HOME_ISLAND = [0, -0x1e44, -0x1e4e];
/** Island centres: a word (y << 8 | x) per island 0-15. */
export const ISLAND_CENTERS = -0x2d06;
/** Cities on each island, a byte per island 0-15. */
export const ISLAND_CITIES = -0x386e;
/** Which islands touch: 16 rows of 16 bits. */
export const ISLAND_ADJACENT = -0x3692;
/** Word: cities created so far (its low byte is the city count). */
export const CITIES_MADE = -0x1e3a;
/** Byte: highest island number. */
export const ISLAND_COUNT = -0x1e50;

const CITY_CODE = 1;
const MAX_CITIES = 45;
const MAX_ISLAND_CITIES = 8;
const MAP_CLIP: Rect = { top: 2, left: 2, bottom: 59, right: 79 };
const CITY_AREA: Rect = { top: 3, left: 3, bottom: 58, right: 78 };

/** An island outline as recorded (pixel points [h, v], first and last equal). */
export type Outline = [number, number][];

const rand = (m: Mem, n: number) => (qdRandom(m) & 0x7fff) % n;

function islandCell(x: number, y: number): [number, number] {
  const row = y - 1;
  return [ISLAND_MAP + (x - 1) * 30 + (row >> 1), (row & 1) << 2];
}

export function islandAt(m: Mem, x: number, y: number): number {
  const [off, shift] = islandCell(x, y);
  return (m.b(off) >> shift) & 0x0f;
}

function setIsland(m: Mem, x: number, y: number, v: number): void {
  const [off, shift] = islandCell(x, y);
  m.setB(off, (m.b(off) & ~(0x0f << shift)) | ((v & 0x0f) << shift));
}

const centerX = (m: Mem, island: number) => m.sb(ISLAND_CENTERS + 2 * island + 1);
const centerY = (m: Mem, island: number) => m.sb(ISLAND_CENTERS + 2 * island);

/** CODE 2 + 0x179C: the home islands for the skill level, mirrored left to right at random. */
export function homeIslands(m: Mem): void {
  // [x, size, roughness, coastal, inland] for player 1, then player 2, by skill 1-15.
  const t = Math.trunc;
  const table: number[][] = [
    [40, 3, 162, 5, 3, 75, t(15 / 3), t(750 / 3), 1, 1],
    [33, 3, 162, 5, 2, 70, t(13 / 3), t(662 / 3), 2, 1],
    [26, 3, 162, 4, 2, 65, t(11 / 3), t(574 / 3), 2, 2],
    [20, 3, 162, 3, 2, 60, 3, 162, 3, 2],
    [19, t(35 / 11), t(1870 / 11), 2, 3, 58, 3, 162, 4, 2],
    [18, t(37 / 11), t(1958 / 11), 2, 3, 56, 3, 162, 4, 3],
    [17, t(39 / 11), t(2046 / 11), 2, 2, 54, 3, 162, 5, 2],
    [16, t(41 / 11), t(2134 / 11), 2, 2, 52, 3, 162, 5, 3],
    [15, t(43 / 11), t(2222 / 11), 2, 2, 50, t(22 / 7), t(1134 / 7), 6, 3],
    [14, t(45 / 11), t(2310 / 11), 2, 1, 49, t(23 / 7), t(1134 / 7), 7, 3],
    [13, t(47 / 11), t(2398 / 11), 2, 1, 47, t(24 / 7), t(1134 / 7), 8, 3],
    [12, t(49 / 11), t(2486 / 11), 1, 2, 45, t(25 / 7), t(1134 / 7), 8, 4],
    [11, t(51 / 11), t(2574 / 11), 1, 1, 43, t(26 / 7), t(1134 / 7), 9, 4],
    [10, t(53 / 11), t(2662 / 11), 1, 1, 41, t(27 / 7), t(1134 / 7), 10, 4],
    [10, t(55 / 11), t(2750 / 11), 1, 1, 40, t(28 / 7), t(1134 / 7), 10, 5],
  ];
  const skill = m.sb(SKILL);
  if (skill >= 1 && skill <= 15) {
    const row = table[skill - 1];
    for (let i = 0; i < 5; i++) {
      m.setW(HOME_ISLAND[1] + 2 * i, row[i]);
      m.setW(HOME_ISLAND[2] + 2 * i, row[5 + i]);
    }
  }
  if (s16(qdRandom(m)) > 0) {
    m.setW(HOME_ISLAND[1], 80 - m.sw(HOME_ISLAND[1]));
    m.setW(HOME_ISLAND[2], 80 - m.sw(HOME_ISLAND[2]));
  }
}

/** CODE 2 + 0x05D4: a parabolic sine, 100 × sin(a) for a in degrees. */
export function sin100(a: number): number {
  const d = s16(a) % 360;
  if (d <= 180) return Math.trunc(s16((180 - d) * d) / 81);
  return -Math.trunc(s16((d - 180) * (360 - d)) / 81);
}

const mul32 = (a: number, b: number) => Math.imul(a, b);
const div32 = (a: number, b: number) => Math.trunc(a / b) | 0;

/**
 * CODE 2 + 0x0630: a random island outline around cell (cx, cy): `size` cells across
 * (in cells of 16 pixels), squashed vertically to `roughness` percent, with noisy points.
 */
export function islandOutline(m: Mem, cx: number, cy: number, size: number, roughness: number): Outline {
  const px = cx * 16 + 8, py = cy * 12 + 6;
  const n = s16(size + 3 + rand(m, size));
  const r = s16(size << 4);
  const poly = new PolyRecorder();
  poly.moveTo(s16(px + r), py);
  for (let k = 1; k <= n; k++) {
    const nx = rand(m, 40) - 20;
    const ny = rand(m, 40) - 20;
    const ang = s16(Math.trunc(s16(k * 350) / n));
    const h = s16(nx + px + div32(mul32(r, sin100(ang + 90)), 100));
    const v = s16(ny + py + div32(mul32(mul32(r, sin100(ang)), roughness), 10000));
    poly.lineTo(h, v);
  }
  poly.lineTo(s16(px + r), py);
  return poly.points;
}

/** CODE 2 + 0x0850: island `island` touches whatever lies around cell (x, y). */
function markNeighbours(m: Mem, island: number, x: number, y: number): void {
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const n = islandAt(m, x + dx, y + dy);
    m.setB(ISLAND_ADJACENT + 2 * island + (n >> 3), m.b(ISLAND_ADJACENT + 2 * island + (n >> 3)) | (1 << (n & 7)));
    m.setB(ISLAND_ADJACENT + 2 * n + (island >> 3), m.b(ISLAND_ADJACENT + 2 * n + (island >> 3)) | (1 << (island & 7)));
  }
}

/** CODE 2 + 0x0B08: every water cell whose centre lies in the region becomes the island's land. */
function rasterize(m: Mem, rgn: Region, island: number): void {
  const b = rgn.bbox();
  const cells = sectRect({
    top: Math.trunc(b.top / 12), left: Math.trunc(b.left / 16),
    bottom: Math.trunc(b.bottom / 12), right: Math.trunc(b.right / 16),
  }, MAP_CLIP);
  for (let y = cells.top; y <= cells.bottom; y++) {
    for (let x = cells.left; x <= cells.right; x++) {
      if (!rgn.contains(x * 16 + 8, y * 12 + 6) || terrainAt(m, x, y) !== WATER) continue;
      setTerrain(m, x, y, LAND);
      setIsland(m, x, y, island);
      markNeighbours(m, island, x, y);
    }
  }
}

/** CODE 2 + 0x0D34: a cell around (x, y) has terrain `code`. */
function nextTo(m: Mem, code: number, x: number, y: number): boolean {
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    if (terrainAt(m, x + dx, y + dy) === code) return true;
  }
  return false;
}

/** CODE 1 + 0x0572: a neutral city at (x, y), building Armies. */
function createCity(m: Mem, idx: number, x: number, y: number): void {
  const c = cityRec(idx);
  m.setB(c + 4, 0);
  m.setB(c + 5, 0);
  m.setB(c + 7, x);
  m.setB(c + 6, y);
  m.setW(c + 2, m.w(c + 6));
  m.setW(c, m.w(c + 6));
  m.setB(c + 8, 0);
  const island = islandAt(m, m.sb(c + 7), m.sb(c + 6));
  m.setB(c + 9, island);
  m.setB(ISLAND_CITIES + m.sb(c + 9), m.b(ISLAND_CITIES + m.sb(c + 9)) + 1);
}

/**
 * CODE 2 + 0x0F48: put a city at (x, y) unless there are 45 already, a city is next to
 * it, or it is on an island other than a home island that has 8 cities.
 */
export function placeCity(m: Mem, x: number, y: number): boolean {
  if (m.sw(CITIES_MADE) >= MAX_CITIES || nextTo(m, CITY_CODE, x, y)) return false;
  const island = islandAt(m, x, y);
  if (island > 2 && m.b(ISLAND_CITIES + island) >= MAX_ISLAND_CITIES) return false;
  m.setW(CITIES_MADE, m.w(CITIES_MADE) + 1);
  m.setB(CITY_COUNT, m.b(CITIES_MADE + 1));
  setTerrain(m, x, y, CITY_CODE);
  createCity(m, m.sb(CITY_COUNT), x, y);
  return true;
}

/**
 * CODE 2 + 0x1038: look for a coastal city site on the island along up to 15 random rays
 * from its centre; a ray ends at water, the map edge, or another island.
 */
export function coastalCity(m: Mem, island: number): boolean {
  for (let ray = 1; ray <= 15; ray++) {
    const ang = rand(m, 360);
    const s = sin100(ang), c = sin100(ang + 90);
    for (let d = 1; ; d++) {
      const x = s16(centerX(m, island) + Math.trunc(s16(d * c) / 100));
      const y = s16(centerY(m, island) + Math.trunc(s16(d * s) / 100));
      const bx = (x << 24) >> 24, by = (y << 24) >> 24;
      const t = terrainAt(m, bx, by);
      if (t === WATER || t === EDGE) break;
      if (t !== LAND) continue;
      if (islandAt(m, x, y) !== island) break;
      if (nextTo(m, WATER, bx, by) && ptInRect(x, y, CITY_AREA) && placeCity(m, bx, by)) return true;
    }
  }
  return false;
}

/** CODE 2 + 0x11E2: `wanted` coastal cities on the island; gives up after 61 failed searches. */
function coastalCities(m: Mem, island: number, wanted: number): boolean {
  let made = 0, failed = 0;
  for (;;) {
    if (coastalCity(m, island)) {
      if (++made >= wanted) return true;
    } else if (++failed > 60) {
      return false;
    }
  }
}

/** CODE 2 + 0x122C: up to 16 random tries for an inland city site in `area` on the island. */
export function inlandCity(m: Mem, area: Rect, island: number): boolean {
  for (let k = 0; k <= 15; k++) {
    const x = (area.left + rand(m, area.right - area.left)) << 24 >> 24;
    const y = (area.top + rand(m, area.bottom - area.top)) << 24 >> 24;
    if (terrainAt(m, x, y) === LAND && islandAt(m, x, y) === island && !nextTo(m, WATER, x, y) &&
        placeCity(m, x, y)) {
      return true;
    }
  }
  return false;
}

/**
 * CODE 2 + 0x135E: the home island's inland cities, in a box around its centre. The number
 * made is written back to the record.
 */
function inlandCities(m: Mem, rec: number, island: number): boolean {
  const size = m.sw(rec + 2), roughness = m.sw(rec + 4);
  const halfH = Math.trunc(31 / 12) + Math.trunc(s16(roughness * size) / 100);
  const halfW = Math.trunc(31 / 12) + size;
  const cx = centerX(m, island), cy = centerY(m, island);
  const area = sectRect({ top: cy - halfH - 1, left: cx - halfW - 1, bottom: cy + halfH, right: cx + halfW }, CITY_AREA);
  let made = 0, failed = 0;
  for (;;) {
    if (inlandCity(m, area, island)) {
      if (++made >= m.sw(rec + 8)) {
        m.setW(rec + 8, made);
        return true;
      }
    } else if (++failed > 60) {
      m.setW(rec + 8, made);
      return false;
    }
  }
}

/** The islands placed so far: their outlines and the union of their regions. */
export interface Islands {
  outlines: (Outline | null)[];
  land: Region;
}

/** CODE 2 + 0x152A: a home island with its cities, at a random row; false if its cities don't fit. */
function homeIsland(m: Mem, rec: number, islands: Islands, island: number): boolean {
  const x = m.sb(rec + 1);
  for (;;) {
    const y = rand(m, 30) + 16;
    const outline = islandOutline(m, x, y, m.sw(rec + 2), m.sw(rec + 4));
    const rgn = Region.fromOutline(outline);
    if (!islands.land.sect(rgn).isEmpty()) continue;
    islands.outlines[island] = outline;
    m.setW(ISLAND_CENTERS + 2 * island, (y << 8) | (x & 0xff));
    rasterize(m, rgn, island);
    if (!coastalCities(m, island, m.sw(rec + 6)) || !inlandCities(m, rec, island)) return false;
    islands.land = rgn.union(islands.land);
    return true;
  }
}

/** CODE 2 + 0x0C7E: a random cell in the quarter of the map chosen by `q` (bit 0 right, bit 1 lower). */
function randomCell(m: Mem, q: number): [number, number] {
  let x = rand(m, 37) + 3;
  let y = rand(m, 27) + 3;
  if (q & 1) x = (x + 37) & 0xff;
  if (q & 2) y = (y + 27) & 0xff;
  return [(x << 24) >> 24, (y << 24) >> 24];
}

/** CODE 2 + 0x163C: island `island` somewhere in its quarter, with a coastal city 80% of the time. */
function otherIsland(m: Mem, islands: Islands, island: number): boolean {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const [cx, cy] = randomCell(m, island);
    const size = rand(m, 4) + 2;
    const roughness = rand(m, 176) + 75;
    const outline = islandOutline(m, cx, cy, size, roughness);
    const rgn = Region.fromOutline(outline);
    if (!islands.land.sect(rgn).isEmpty()) continue;
    islands.outlines[island] = outline;
    m.setW(ISLAND_CENTERS + 2 * island, ((cy & 0xff) << 8) | (cx & 0xff));
    rasterize(m, rgn, island);
    if (rand(m, 100) < 80) coastalCity(m, island);
    islands.land = rgn.union(islands.land);
    return true;
  }
  return false;
}

/** CODE 2 + 0x1466: scatter cities over the other islands until there are 45. */
export function scatterCities(m: Mem): void {
  let failed = 0;
  for (let q = 0; m.sw(CITIES_MADE) < MAX_CITIES; q++) {
    const [x, y] = randomCell(m, q);
    if (terrainAt(m, x, y) === LAND && islandAt(m, x, y) > 2 && !placeCity(m, x, y)) {
      if (++failed > 60) break;
    }
  }
}

/**
 * Where the original keeps each island's polygon (A5-$1E36, a handle for each of islands
 * 1-15), the engine keeps what the computer opponent takes from it (CODE 8 + 0x0004): the
 * polygon's bounding box in squares, as four signed bytes per island: top / 12 + 1,
 * left / 16 + 1, bottom / 12 + 1, right / 16 + 1 (the box's pixel edges, divided with
 * truncation).
 */
export const ISLAND_BOUNDS = -0x1e36;

/** The polygon bounds of an island outline, in the form ISLAND_BOUNDS keeps. */
export function outlineBounds(outline: Outline): [number, number, number, number] {
  const hs = outline.map(([h]) => h), vs = outline.map(([, v]) => v);
  const t = Math.trunc;
  return [t(Math.min(...vs) / 12) + 1, t(Math.min(...hs) / 16) + 1, t(Math.max(...vs) / 12) + 1, t(Math.max(...hs) / 16) + 1];
}

/**
 * CODE 2 + 0x1CDC: generate the world from the game seed, which also seeds both random
 * generators. Up to 16 tries to place the home islands (the original then gives up with an
 * alert and quits). Returns the island outlines, which the original keeps as polygons: they
 * are drawn by CODE 17, and the computer opponent uses their bounds (ISLAND_BOUNDS). They
 * follow from the seed, so they are not saved.
 */
export function generateMap(m: Mem): (Outline | null)[] {
  m.setL(QD_RANDSEED, m.l(GAME_SEED));
  m.setL(PRNG_SEED, m.l(GAME_SEED));
  homeIslands(m);
  let islands: Islands;
  for (let failures = 0; ; failures++) {
    if (failures > 15) throw new Error("map generation failed: home islands do not fit");
    m.bytes(TERRAIN, 2400).fill(0);
    m.bytes(ISLAND_MAP, 2400).fill(0);
    m.bytes(ISLAND_ADJACENT, 32).fill(0);
    m.bytes(ISLAND_CITIES, 16).fill(0);
    m.setW(CITIES_MADE, 0);
    m.setB(CITY_COUNT, 0);
    for (let x = 1; x <= 80; x++) {
      setTerrain(m, x, 1, EDGE);
      setTerrain(m, x, 60, EDGE);
    }
    for (let y = 1; y <= 60; y++) {
      setTerrain(m, 1, y, EDGE);
      setTerrain(m, 80, y, EDGE);
    }
    islands = { outlines: new Array(16).fill(null), land: new Region() };
    if (homeIsland(m, HOME_ISLAND[1], islands, 1) && homeIsland(m, HOME_ISLAND[2], islands, 2)) break;
  }
  for (let island = 3; island <= 15; island++) {
    if (!otherIsland(m, islands, island)) break;
    m.setB(ISLAND_COUNT, island);
  }
  scatterCities(m);
  for (let island = 1; island <= 15; island++) {
    const outline = islands.outlines[island];
    const bounds = outline ? outlineBounds(outline) : [0, 0, 0, 0];
    bounds.forEach((v, k) => m.setB(ISLAND_BOUNDS + 4 * (island - 1) + k, v));
  }
  return islands.outlines;
}
