# Findings: Strategic Conquest 3.01 binary

Offsets are given as `CODE n + 0xXXXX`, counted from the start of the CODE resource
(including its 4-byte segment header), which is what `tools/analysis/dis.py` expects.
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
global `A5-$1E70` (`CODE 2 + 0x1D10` and `+ 0x1D16`). Given that seed and the sequence of
player moves, a game should replay exactly.

### 1. QuickDraw `Random` (trap `A861`)

- Seed is QuickDraw's `randSeed` at `A5-$23A` (`thePort` is `A5-$1BC`, from the `InitGraf`
  call at `CODE 1 + 0x176A`; `randSeed` sits 126 bytes below `thePort`).
- 14 call sites: 13 in EMPINIT (map generation and setup), 1 in Mover (`CODE 5 + 0x23FE`).
- The ROM implementation is believed to be the Park–Miller generator (multiplier 16807,
  modulus 2³¹−1), returning the low 16 bits. To be confirmed against the emulator,
  including edge cases.

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
- 8 call sites: battle ×3, machine ×4, tools ×1.
- `CODE 1 + 0x1F76` passes the seed's address to the routine at `CODE 1 + 0x39AC`; its
  purpose (save/load or network synchronization) is not yet identified.

### Turn-dependent random check in Mover

Routine at `CODE 5 + 0x23C4` (not in the jump table, so called only from within Mover) returns
a Boolean based on an unidentified 16-bit global `g` at `A5-$2D08`:

- `g < 30`: always TRUE.
- `30 ≤ g < 60`: FALSE with probability d/16, where d = (g − 30) div 6 + 1 (1/16 up to 5/16).
- `g ≥ 60`: FALSE with probability 6/16.

The random draw is `(Random & 0x7FFF) mod 16`, using QuickDraw `Random`. What the routine
gates, and whether `g` is the day number, are not yet known.

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

Army, Fighter, Destroyer, Submarine, Transport, Carrier, Battleship, Bomber.

Production time in days, from the in-game production dialog:

| Army | Fighter | Destroyer | Submarine | Transport | Carrier | Battleship | Bomber |
|---|---|---|---|---|---|---|---|
| 4 | 6 | 8 | 10 | 10 | 14 | 20 | 20 |

Observed: a new Army has 1 move per day and strength 1. A Transport observed mid-game
showed 3 moves remaining, strength 3, and 6 Armies on board.

## Observed in emulation

- Setup dialog choices: Single Player Game, 2 Player Single Mac Game, AppleTalk Master,
  AppleTalk Slave; skill level slider.
- The map grid shows columns 1–61 and rows 1–54 in the unscrolled 1024×768 window; the full
  map size is not yet known.
- Save is deferred to the end of the round.
