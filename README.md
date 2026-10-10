# Strategic Conquest port

A browser-based, two-player-over-the-internet version of Strategic Conquest 3.01
(Delta Tao Software, 1990) for personal use among owners of the original game.

The original 68k Macintosh binary is the specification: it is disassembled to recover the
exact rules, turn engine, map generation and computer opponent, and a new engine reproduces
that behavior. The user interface is new (larger graphics) and multiplayer runs over the web.

## Project decisions

- **Reference version:** 3.01. Version 2.055 (Strategic Conquest Plus) is kept as a secondary
  reference; rule differences between the two are logged in [docs/quirks.md](docs/quirks.md).
- **Players:** two, as in the original. No three-player mode.
- **Computer opponent:** required, and should behave like the original.
- **Turn style:** one player at a time, live, alternating, as in the original.
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
| `docs/save-format.md` | Save-file structure, as mapped so far |
| `docs/versions.md` | 2.055 vs 3.01 comparison |
| `docs/quirks.md` | Bugs, exploits and version differences awaiting a reproduce/fix decision |
| `tools/analysis/` | Resource-fork, disassembly, cross-reference and comparison scripts |
| `tools/save/sc3save.py` | Save-file reader: text dump and map rendering |
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
tools/extract.sh                                   # writes build/sc301.rsrc
python3 -I tools/analysis/codeinfo.py build/sc301.rsrc
python3 -I tools/save/sc3save.py dump saves/3.01/s04-day58-autoplay.sav
python3 -I tools/save/sc3save.py render saves/3.01/s04-day58-autoplay.sav build/day58.png --player 1
emulator/setup.sh                                  # boots System 7.5.3 headless with the game installed
```

See [emulator/README.md](emulator/README.md) for driving the emulator.
