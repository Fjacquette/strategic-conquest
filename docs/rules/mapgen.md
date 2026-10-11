# Map generation and a new game (3.01)

**Status: decoded and verified.** The engine (`engine/src/mapgen.ts`, `quickdraw.ts`,
`newgame.ts`) reproduces the original:

- `tools/emu/test_mapgen.py` compares whole worlds for random seeds and skill levels (globals
  image and every island outline), the outline routine, and the city-placement routines on
  maps altered to reach their rare cases. The original runs on a Python reimplementation of
  the QuickDraw calls it makes; the two reimplementations are also compared directly.
- `tools/emu/test_savemaps.py` regenerates the worlds of the saved games in `saves/3.01/`
  (two different maps, made by the original on a Mac emulator with Apple's QuickDraw) from
  their seeds: terrain, city positions and island numbers match exactly.
- `tools/emu/test_newgame.py` compares whole new games in game modes 0, 1 and 2, with Auto
  Play on and off: the globals image, every request (with a digest of the globals at each),
  the messages and the calls of the computer opponent's start-of-game analysis.

Sources: `CODE 2 + 0x1CDC` (map generation) and the routines it calls; `CODE 10 + 0x093C`
(new game) and `CODE 10 + 0x0004` (starting cities).

## A new game

The *New Game* setup dialog (`CODE 2 + 0x2ACC`) sets the game mode and the skill level
(1–15), then (`CODE 2 + 0x2C20`):

1. Every table is cleared: the piece table, the position hash, the path finder's state; the
   combat results table is built ([combat.md](combat.md)).
2. **The game seed is the Mac's clock** (seconds since 1904). It seeds both random
   generators ([findings.md](../findings.md#randomness)).
3. **The world is generated** (below).
4. Both players know only the map edge. The day count is 0.
5. **Starting cities.** Player 1 gets the first city made on home island 1 and player 2 the
   first city made on home island 2 (the city numbered after all of home island 1's). Each
   player sees the 3 × 3 block around its city.
   - Player 1 chooses the city's production. With two human players (modes 1 and 2),
     player 1 first sets a password.
   - Then player 2: with two human players, a password, then the production choice; against
     the computer (mode 0), the city builds Fighters.
   - Under Auto Play, player 1's city builds Fighters and no password is asked.
   - Each player's map is scrolled to its city.
6. Against the computer, the computer opponent studies the world and each side
   (`CODE 2 + 0x2E3A` and `0x24DE`; not yet decoded).
7. The hand-off screen for player 1 (request 8).
8. Two of the computer opponent's limits are set to 10 and 8 (also on loading a game).
9. The game is marked as not yet saved: there is no autosave until it is.

Passwords are made upper case and kept as their first 6 bytes (a length and up to 5
characters); see [quirk Q14](../quirks.md).

## The world

The map is 80 × 60 cells; the outer ring is the map edge. Island shapes are worked out in
pixels, a cell being 16 pixels wide and 12 high, so cell (x, y) has its centre at pixel
(16x + 8, 12y + 6). Islands are numbered: 1 and 2 are the home islands, then 3–15. The
island number of each land cell is kept (`A5-$3672`, not saved: a loaded game regenerates
the world from its seed before reading the saved state over it).

`rand(n)` below is QuickDraw `Random`, made non-negative (low 15 bits), modulo n.

### Home islands

The skill level sets each home island's column, size, roughness (vertical squash, in
percent) and its numbers of coastal and inland cities. Player 1 is the human player;
against the computer, player 2 is the computer.

| Skill | P1 column | P1 size | P1 roughness | P1 coastal | P1 inland | P2 column | P2 size | P2 roughness | P2 coastal | P2 inland |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 40 | 3 | 162 | 5 | 3 | 75 | 5 | 250 | 1 | 1 |
| 2 | 33 | 3 | 162 | 5 | 2 | 70 | 4 | 220 | 2 | 1 |
| 3 | 26 | 3 | 162 | 4 | 2 | 65 | 3 | 191 | 2 | 2 |
| 4 | 20 | 3 | 162 | 3 | 2 | 60 | 3 | 162 | 3 | 2 |
| 5 | 19 | 3 | 170 | 2 | 3 | 58 | 3 | 162 | 4 | 2 |
| 6 | 18 | 3 | 178 | 2 | 3 | 56 | 3 | 162 | 4 | 3 |
| 7 | 17 | 3 | 186 | 2 | 2 | 54 | 3 | 162 | 5 | 2 |
| 8 | 16 | 3 | 194 | 2 | 2 | 52 | 3 | 162 | 5 | 3 |
| 9 | 15 | 3 | 202 | 2 | 2 | 50 | 3 | 162 | 6 | 3 |
| 10 | 14 | 4 | 210 | 2 | 1 | 49 | 3 | 162 | 7 | 3 |
| 11 | 13 | 4 | 218 | 2 | 1 | 47 | 3 | 162 | 8 | 3 |
| 12 | 12 | 4 | 226 | 1 | 2 | 45 | 3 | 162 | 8 | 4 |
| 13 | 11 | 4 | 234 | 1 | 1 | 43 | 3 | 162 | 9 | 4 |
| 14 | 10 | 4 | 242 | 1 | 1 | 41 | 3 | 162 | 10 | 4 |
| 15 | 10 | 5 | 250 | 1 | 1 | 40 | 4 | 162 | 10 | 5 |

So at low skill levels the human starts on a large island with several neutral cities to
take, and the computer on a small one; at high levels the reverse. The first QuickDraw
`Random` value decides whether the map is mirrored: if it is positive, both columns become
80 − column.

### Building the world

1. The terrain, the island numbers and the island tables are cleared, and the map edge is
   drawn.
2. **Home island 1, then home island 2**, each at its column and a random row
   (rand(30) + 16), with its coastal cities and then its inland cities. An island that
   would overlap one already placed is tried again at another row.
3. If a home island's cities cannot all be placed (below), the whole world is started again,
   with the random sequence continuing. After a failed inland search the home island keeps
   the reduced count of inland cities for the next attempts. After 16 attempts the original
   gives up with an alert and quits.
4. **Islands 3–15**, each with up to 15 attempts (below). The first island that cannot be
   placed ends the series.
5. **Scattered cities** (below) until there are 45 cities.

Every city starts neutral, building Armies, and records its island.

### Island shapes

An island of size s around cell (x, y), with roughness q:

- Its outline has n = s + 3 + rand(s) points around the centre pixel (px, py), at radius
  r = 16s pixels. Point k (1..n) is at angle a = 350k ÷ n degrees (integer division), with
  noise dh = rand(40) − 20 and dv = rand(40) − 20 (drawn in that order):
  h = px + dh + r · cos(a) ÷ 100, v = py + dv + r · sin(a) · q ÷ 10000. The outline starts
  and ends at (px + r, py).
- Sine and cosine are the game's parabolic approximation: for a in 0–180 degrees,
  100 · sin(a) ≈ (180 − a) · a ÷ 81, negative from 180 to 360; cos(a) = sin(a + 90).
- The outline becomes a QuickDraw region. An island **overlaps** the islands already placed
  when its region and theirs share a pixel.
- A cell becomes land of the island when its centre pixel is inside the region and it is
  still water. Only rows 2–59 and columns 2–79 are considered. Islands whose land touches
  (in the 8 neighbouring cells) are recorded as adjacent.

Regions follow QuickDraw's rules exactly: the pixels inside a polygon's region are those
between its edges as QuickDraw's line-to-region conversion (`PutLine`) traces them, with
fixed-point slopes truncated toward zero. The engine reproduces these rules
(`engine/src/quickdraw.ts`); see "Verification" above.

### Cities

A city may be placed on a cell unless there are already 45 cities, another city is in one
of the 8 neighbouring cells, or the cell is on an island other than a home island that
already has 8 cities.

**Coastal city.** Up to 15 rays at random angles (rand(360)) from the island's centre cell.
Each ray walks outward a hundredth of a cell at a time. It ends at water, at the map edge,
or at land of another island. It passes over city cells. The first cell of the island next
to water, within rows 3–57 and columns 3–77, where a city can be placed gets the city.

**Coastal cities of a home island.** Coastal searches until the island has its number of
coastal cities; more than 60 failed searches fail the home island.

**Inland cities of a home island.** In a box around the island's centre (x, y), columns
x − s − 3 to x + s + 1 and rows y − h − 1 to y + h − 1 with h = 2 + q · s ÷ 100 (cut to rows
3–57 and columns 3–77): for each city, up to 16 random cells of the island that are not
next to water and where a city can be placed. More than 60 failed searches in all fail the
home island.

**Islands 3–15.** Island k's centre is a random cell in one quarter of the map:
x = rand(37) + 3, plus 37 when k is odd; y = rand(27) + 3, plus 27 when bit 1 of k is set.
Size rand(4) + 2, roughness rand(176) + 75. When the island fits (no overlap), it gets one
coastal city search with probability 80% (rand(100) < 80).

**Scattered cities.** Random cells, taking the quarters of the map in turn; a cell that is
land of islands 3–15 gets a city if one can be placed there. More than 60 failures end the
scattering early.

## Outlines

The original keeps each island's outline as a QuickDraw polygon (`A5-$1E36`). The outlines
are passed to the computer opponent (`CODE 8 + 0x0004`) and drawn by `CODE 17`; they follow
from the seed and are not saved. The engine's `generateMap` returns them.
