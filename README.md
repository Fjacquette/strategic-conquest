# Strategic Conquest port

A browser-based, two-player-over-the-internet version of Strategic Conquest 3.01
(Delta Tao Software, 1990) for personal use among owners of the original game.

The original 68k Macintosh binary is the specification: it is disassembled to recover the
exact rules, turn engine, map generation and computer opponent, and a new engine reproduces
that behavior. The user interface is new (larger graphics) and multiplayer runs over the web.

The engine (`engine/`, TypeScript) is a routine-by-routine reimplementation of the
original game logic. It keeps the game state in the same byte layout as the original's
globals, so each routine can be checked against the original code running in a 68k
emulator on thousands of random cases (differential tests in `tools/emu/`).

## Project decisions

- **Reference version:** 3.01. Version 2.055 (Strategic Conquest Plus) is kept as a secondary
  reference; rule differences between the two are logged in [docs/quirks.md](docs/quirks.md).
- **Players:** two, as in the original. No three-player mode.
- **Computer opponent:** required, and should behave like the original.
- **Turn style:** one player at a time, live, alternating, as in the original.
- **Network play:** like the original AppleTalk game, one player's browser is the Master
  (runs the engine for both sides) and the other's is the Slave (player 2's view and
  orders); see [docs/network.md](docs/network.md). The two browsers connect directly,
  set up by exchanging an invitation code and a reply code; no game server.
- **Quirks and bugs:** each one is logged and reviewed individually before deciding whether
  to reproduce or fix it.
- **Verification:** the new engine is checked against the original. Map generation follows
  from the game seed; combat and computer-opponent randomness is reseeded from the Mac clock
  each day, so exact comparisons need a controlled clock or the original routines run
  directly in a CPU emulator (see [docs/findings.md](docs/findings.md#randomness)).

## Layout

| Path | Contents |
|---|---|
| `docs/findings.md` | What is known about the 3.01 binary: segments, compiler, randomness, resources |
| `docs/save-format.md` | Save-file structure, and how the original saves and loads |
| `docs/versions.md` | 2.055 vs 3.01 comparison |
| `docs/network.md` | The original's AppleTalk Master/Slave design |
| `docs/interface.md` | What the original's interface does besides drawing: sounds, the fight and blast displays |
| `docs/quirks.md` | Bugs, exploits and version differences awaiting a reproduce/fix decision |
| `docs/rules/` | Game rules recovered from the code, one file per subsystem |
| `tools/analysis/` | Resource-fork, disassembly, cross-reference and comparison scripts |
| `tools/save/sc3save.py` | Save-file reader: text dump and map rendering |
| `engine/` | The game engine in TypeScript: state layout, map generation and a new game, the day loop, movement, players' orders, combat, units, path finding, saved games (`engine/src`) and the computer opponent (`engine/src/ai`); bridge used by the tests (`engine/test`) |
| `web/` | The browser game, single player against the computer, drawn and sounding like the original. Its artwork, sounds and words come from the owner's copy: run `tools/assets/extract_assets.py` first; `npm run build` then writes one self-contained page to `web/dist/play.html`, for the owner's own use |
| `tools/emu/` | Harness that runs the original routines on an emulated 68040, and differential tests of the engine against them |
| `tools/extract.sh` | Unpacks the game archive into `build/sc301.rsrc` |
| `emulator/` | Headless Basilisk II setup and control scripts |
| `saves/3.01/` | Saved games produced in the emulator, with descriptions |
| `originals/` | Copyrighted inputs; not committed (see below) |

## Originals (not in git)

Place these in `originals/` before running the tools or emulator:

| File | Description | SHA-256 |
|---|---|---|
| `StrategicConquest-3.01.sit` | StuffIt 5 archive of the game | `ff79dda6d708fe443ae0cbcc43ca5039f66cb2deccb24168635c56425d8ac013` |
| `MacIIci.ROM` | 512 KB Mac IIci ROM, checksum 368CADFE | `0419966cfd7445680c0dd6ca78e8b1f4bc212e75caf56f4a5f523afa576ad3f2` |
| `MacOS753.zip` | Zip of a 4 GB HFS disk image with System 7.5.3 (`MacOS753.image`) | `cf39e922ceeba955c43e2b8e2fc7bdb6aac4f7eb46ca3e0c87688d9695c82327` |

## Quick start

```bash
pip install --break-system-packages -r tools/requirements.txt
(cd engine && npm install && npm run check)        # Node 22+; type-checks the engine
python3 -I tools/assets/extract_assets.py         # the original's artwork, sounds and words, from your copy
(cd web && npm install && npm run check && npm run build)   # the browser game: open web/dist/play.html
tools/extract.sh                                   # writes build/sc301.rsrc
python3 -I tools/emu/test_day.py 100              # whole days: original code vs the engine
python3 -I tools/emu/test_turn.py 500             # whole turns
python3 -I tools/emu/test_orders.py 100           # players' commands
python3 -I tools/emu/test_mapgen.py 50            # map generation
python3 -I tools/emu/test_savemaps.py saves/3.01/*.sav   # worlds of real games, from their seeds
python3 -I tools/emu/test_newgame.py 20           # starting a new game
python3 -I tools/emu/test_savefile.py 20          # saving and loading games
python3 -I tools/emu/test_ai.py 4 100             # the computer opponent's routines, on real games
python3 -I tools/emu/test_aigame.py 2 100         # whole games played by the computer, day by day
python3 -I tools/emu/test_battle.py               # also test_hash, test_tools, test_path, test_units
python3 -I tools/analysis/codeinfo.py build/sc301.rsrc
python3 -I tools/save/sc3save.py dump saves/3.01/s04-day58-autoplay.sav
python3 -I tools/save/sc3save.py render saves/3.01/s04-day58-autoplay.sav build/day58.png --player 1
emulator/setup.sh                                  # boots System 7.5.3 headless with the game installed
```

See [emulator/README.md](emulator/README.md) for driving the emulator.
