# Findings: Strategic Conquest 3.01 binary

Offsets are given as `CODE n + 0xXXXX`, counted from the start of the CODE resource
(including its 4-byte segment header), which is what `tools/analysis/disasm.py` expects.
Globals are given as A5-relative offsets.

## The file

- StuffIt 5 archive containing folder `StratCon 3.0`: the application, `Last Minute Notes`
  (text), and TeachText 1.2.
- Application type `APPL`, creator `SCÆ ` (`53 43 C6 20`). Everything is in the resource
  fork (460,383 bytes); the data fork is empty.
- `vers 1`: "Strategic Conquest 3.01 © 1990 Delta Tao Software, Inc."
- Save files: type `SC∂ ` (`53 43 B6 20`), creator `SCÆ `, data fork only.

## Compiler and runtime

- Built with MPW. The `%A5Init` segment and the runtime routine names left in `Main`
  (`__CplusInit`, `dtors__Fv`, `_RTInit`, `exit`, `_RTExit`, `%INITHEAP`) are MPW runtime.
- Game code follows Pascal calling conventions: function results are returned on the stack
  above the parameters, and Booleans are stored as bytes. Long multiply, divide and modulo
  go through runtime helpers in `Main` (multiply `CODE 1 + 0x4BC6`, divide wrapper
  `CODE 1 + 0x4BFA`, modulo wrapper `CODE 1 + 0x4C20` / jump-table entry 97, signed core
  routine `CODE 1 + 0x4C46`).
- No MacsBug symbol names for game code; every game routine must be named during analysis.
- No floating point: neither SANE trap (`_FP68K`, `_Elems68K`) is called. All game math is
  integer, so exact reproduction in JavaScript is straightforward.

## Segments

A5 world: 2,384 bytes above A5 (jump table of 294 entries), 21,956 bytes of globals below A5.
Function counts are approximate (count of `LINK A6` instructions).

| CODE | Name | Bytes | Functions | Role (tentative, from name) |
|---|---|---|---|---|
| 1 | Main | 20,092 | ~100 | Event loop, game PRNG, MPW runtime |
| 2 | EMPINIT | 14,288 | ~60 | New game setup, map generation |
| 3 | battle | 3,208 | ~6 | Combat |
| 4 | tools | 10,662 | ~45 | Shared utilities |
| 5 | Mover | 24,326 | ~38 | Piece movement |
| 6 | machine | 26,114 | ~43 | Computer opponent |
| 7 | machine2 | 5,466 | ~10 | Computer opponent |
| 8 | XXXXXXXX | 1,816 | ~3 | Unknown |
| 9 | machine3 | 118 | 1 | Computer opponent |
| 10 | Gstart | 6,618 | ~24 | Game start / load |
| 11 | NetWork | 8,632 | ~64 | AppleTalk play |
| 12 | MenuChange | 396 | ~6 | Menu state |
| 13 | userint2 | 2,884 | ~11 | User interface |
| 14 | FullMap | 1,132 | 1 | World map display |
| 15 | SETTARGET | 918 | ~3 | Target selection (probably computer opponent) |
| 16 | Domenu | 4,070 | ~2 | Menu commands |
| 17 | userint | 5,162 | ~15 | User interface |
| 18 | ReportCity | 6,524 | ~18 | City list / production dialogs |
| 19 | ReportPiece | 1,698 | ~3 | Piece info |
| 20 | %A5Init | 436 | — | MPW global data initialization |

Total ~147 KB of code, ~450 functions, ~47,000 instructions.

## Randomness

The game uses two generators. At new-game time both are seeded from the same 32-bit value,
the game seed in global `A5-$1E70` (`CODE 2 + 0x1D10` and `+ 0x1D16`), which is also the
first field of a save file.

**The game is not replayable from that seed alone.** At the end of every day, the main day
loop (`CODE 1 + 0x195C`, which increments the day counter, through `CODE 1 + 0x1F86`)
overwrites the game PRNG's seed with the Macintosh clock in seconds (`_ReadDateTime` via
glue at `CODE 1 + 0x39AC`, called at `CODE 1 + 0x1F74`). So:

- Map generation, which uses QuickDraw `Random`, follows from the game seed.
- Combat and computer-opponent randomness on day 1 follows from the game seed; from then
  on, each day starts from that moment's clock reading.
- Neither generator's current state is saved, so a resumed game does not continue the
  original random sequence.

Exact verification of combat and the computer opponent therefore needs a controlled clock:
the emulator's host clock (for example with libfaketime), or running the game's routines
directly in a CPU emulator with a chosen seed.

### 1. QuickDraw `Random` (trap `A861`)

- Seed is QuickDraw's `randSeed` at `A5-$23A` (`thePort` is `A5-$1BC`, from the `InitGraf`
  call at `CODE 1 + 0x176A`; `randSeed` sits 126 bytes below `thePort`).
- 14 call sites: 13 in EMPINIT (map generation and setup), 1 in Mover (`CODE 5 + 0x23FE`).
- Park–Miller generator (multiplier 16807, modulus 2³¹−1), returning the low 16 bits
  (−32768 maps to 0). The game also carries its own copy (`CODE 1 + 0x0102`), which the
  engine's implementation matches, edge cases included.

### 2. Game PRNG

- `CODE 1 + 0x2AFA`, jump-table entry 42. Seed in global `A5-$127C`.
- Algorithm:

  ```
  seed = ((seed + 1) & 0x7FFF) * 977 + 113
  r    = low 16 bits of (seed << 7), as a signed integer
  if r == -32768: r = -32767
  return r
  ```

- The masking leaves 15 bits of effective state; the period is 16,384 calls.
- 8 call sites: battle ×3, machine ×4, tools ×1 (path finding: a coin toss between two equally long detours).
- Reseeded from the clock at the end of every day, as described above.

### Day-dependent random check in Mover

Routine at `CODE 5 + 0x23C4` decides whether an Army's attempt to capture a city succeeds;
see [rules/movement.md](rules/movement.md#city-capture). It uses QuickDraw `Random`:

- Day < 30: always TRUE.
- Days 30–59: FALSE with probability d/16, where d = (day − 30) div 6 + 1 (1/16 up to 5/16).
- Day ≥ 60: FALSE with probability 6/16.

QuickDraw `Random` is also used for Random orders and by computer-opponent code applied to
player-2 ships at the map edge; the game PRNG also breaks ties in path finding.

### Other day-loop behavior noted

- The check at `CODE 1 + 0x199A` (every third day after day 20, or every day after day 10
  in two-player games) is the autosave. See [rules/day.md](rules/day.md).

## Loading a saved game

The load routine (`CODE 1 + 0x0A9A..0x0E60`) reads the game seed, then calls the new-game
setup (`CODE 2 + 0x1CDC`), which **regenerates the world from that seed** and reseeds both
random generators with it, before reading the rest of the file over the top. It then
rebuilds per-island data (`CODE 2 + 0x24DE`) and compacts the piece table, which also
rebuilds the position hash (`CODE 4 + 0x259A`). So after loading, the random generators
are back at their starting state.

## Map generation uses QuickDraw regions

Map generation (`CODE 2 + 0x1CDC`) builds island shapes with QuickDraw polygon and region
calls (`OpenPoly`, `OpenRgn`/`LineTo`/`CloseRgn`, `SectRgn`, `UnionRgn`, `EmptyRgn`,
`PtInRgn`), so exact maps need QuickDraw's region rules. The engine reimplements the part it
uses (`engine/src/quickdraw.ts`): line-to-region conversion as in Apple's QuickDraw source
(`PutLine`), with `FixRatio` truncating toward zero as in the Mac IIci ROM. Worlds
regenerated from the seeds of saved games match the originals exactly. See
[rules/mapgen.md](rules/mapgen.md).

## Resources

| Type | Count | Notes |
|---|---|---|
| CODE | 21 | See above |
| BITS | 39 | 1-bit images, 4-byte header (width 16, height 12) then 12 rows of 16 bits. IDs 1–8 are the unit types in STR order; the rest are not yet identified |
| STR | 93 | Unit names (1–8), terrain/city labels, all game messages (1000–1070, 2009–3009) |
| MENU | 7 | Includes MENU 106 "Debug" (Compact Mem, ShowMem, List Piece, AllVis, CopyVis, list cities), not shown in the menu bar at run time |
| TRIG | 1 | 53 signed 16-bit values forming a 100·cos table; use not yet identified |
| PICT | 2 | Splash screen art |
| snd | 5 | 271 KB of sounds |
| DLOG/DITL/ALRT/CNTL/WIND | | Dialogs and controls |
| FONT | 2 | IDs 16000, 16009 |
| icl4/ICN#/BNDL/FREF | | Finder icons |

## Unit types (3.01)

Army, Fighter, Destroyer, Submarine, Transport, Carrier, Battleship, Bomber (the order of the
STR list and the production dialog). The internal type codes swap Transport and Carrier; see
[save-format.md](save-format.md#pieces-offset-2408-6314-bytes).

Production time in days, from the in-game production dialog:

| Army | Fighter | Destroyer | Submarine | Transport | Carrier | Battleship | Bomber |
|---|---|---|---|---|---|---|---|
| 4 | 6 | 8 | 10 | 10 | 14 | 20 | 20 |

Observed: a new Army has 1 move per day and strength 1. A Transport observed mid-game
showed 3 moves remaining, strength 3, and 6 Armies on board.

## Map

80 columns × 60 rows including a one-cell edge, so the playable area is 78 × 58. 45 cities.
Layout details are in [save-format.md](save-format.md).

## Observed in emulation

- Setup dialog choices: Single Player Game, 2 Player Single Mac Game, AppleTalk Master,
  AppleTalk Slave; skill level slider.
- The 1024×768 window shows 61 columns and 54 rows of the map at a time.
- Save and Resume Game are both deferred to the end of the day. The Resume Game prompt reads
  "A new game will be created after this day has completed."
- Auto Play state is stored in the save, so a game saved during Auto Play resumes in
  Auto Play.

## Position hash

Besides the piece table, the game keeps a hash from map cell to pieces (`A5-$5592`, 551
word slots plus the longest probe length, `CODE 4 + 0x0042..0x02EE`). Lookups return the
first live piece on a cell in probe order, and insertion keeps a Transport ahead of the
Armies on its cell and a Carrier ahead of its Fighters, so "the piece on a cell" is the
ship when there is one. The hash is not saved: loading and every compaction of the piece
table rebuild it. The engine keeps it byte for byte, since which piece a lookup returns
affects the rules.

## Reads of uninitialised memory

A few routines read variables that were never set, so their behavior depends on what
earlier calls left on the stack. The engine replaces each with the value the original
usually sees, and the differential tests set the original's variable to that value:

- `MovesPerDay` (`CODE 4 + 0x11BA`) for a destroyed piece (type 8) returns its caller's
  register D7, which in `PlayerTurn` is the piece's index. The turn loop therefore keeps
  stepping a piece destroyed earlier in its turn, posting "before step" requests, until
  the step count passes its index. No game state changes.
- The capture exploration in `MoveArmy` uses an uninitialised piece record (quirk Q9).
- The movers' direction variables are unset in one branch of the orders step (quirk Q11).
- `BomberBlast` ends by passing register D5 to `CODE 1 + 0x0176` when it is non-zero; it
  holds `MoveBomber`'s last exploration result.
- Request records are built field by field in the caller's frame, so fields a request
  does not set hold leftovers. Controllers should only read the fields each request sets.
