# Version comparison: Strategic Conquest Plus 2.055 vs 3.01

## The two binaries

| | 2.055 | 3.01 |
|---|---|---|
| `vers` string | Strategic Conquest Plus, Ver. 2.055 © 1989 Premier Technology, Inc. | Strategic Conquest 3.01 © 1990 Delta Tao Software, Inc. |
| Creator code | `CZAR` | `SCÆ ` |
| Resource fork | 229,321 bytes | 460,383 bytes (3.01 embeds its sounds; 2.055 kept them as separate files) |
| CODE | 21 segments, 149 KB, names stripped | 21 segments, 147 KB, named |
| Save file type | `ZMAP` | `SC∂ ` |

2.055 was found on the System 7.5.3 disk image in folder `StrategicConquest`, with a
`Saved Game` from November 2025 and an `S.C.rules` file. Despite its name, `S.C.rules`
holds English-to-phoneme rules for 2.055's speech feature, not game rules.

## Identical

- All 93 STR resources: unit names and every game message.
- All 39 BITS images (unit graphics) and the TRIG table.
- The eight unit types.

## Menus

- Removed in 3.01: Options > Sound Off/Soft/Medium/Loud (replaced by a single Sound toggle),
  Pause After Attack, Talking; the Hide menu ("Boss Coming").
- Added in 3.01: standard Edit menu; color support.
- Moves and Displays menus: unchanged.

## Randomness

- 2.055 makes no calls to QuickDraw `Random`. Its game PRNG (multiplier 977) is present in
  CODE 1.
- 3.01 uses QuickDraw `Random` for map generation and setup. The same seed therefore does not
  produce the same world in both versions.

## Code, function by function

`tools/analysis/funcdiff.py` matches each 3.01 function to its most similar 2.055 function.
Instructions are compared with A5 offsets and branch targets normalized, immediates kept.
"Changed" can include differences from recompilation, not only logic changes.

| 3.01 segment | Identical | ≥95% similar | Changed | No match |
|---|---|---|---|---|
| Main | 39 | 17 | 25 | 19 |
| EMPINIT | 14 | 8 | 13 | 25 |
| battle | 0 | 2 | 2 | 2 |
| tools | 12 | 15 | 18 | 0 |
| Mover | 10 | 9 | 15 | 4 |
| machine | 5 | 15 | 22 | 1 |
| machine2 | 2 | 4 | 4 | 0 |
| XXXXXXXX | 1 | 1 | 1 | 0 |
| machine3 | 0 | 0 | 1 | 0 |
| Gstart | 14 | 4 | 5 | 1 |
| NetWork | 53 | 5 | 6 | 0 |
| MenuChange | 0 | 0 | 5 | 1 |
| userint2 | 3 | 1 | 2 | 5 |
| FullMap | 0 | 0 | 1 | 0 |
| SETTARGET | 0 | 0 | 3 | 0 |
| Domenu | 0 | 0 | 2 | 0 |
| userint | 0 | 2 | 8 | 5 |
| ReportCity | 1 | 2 | 13 | 2 |
| ReportPiece | 0 | 0 | 2 | 1 |
| **Total** | **154** | **85** | **148** | **66** |

57 functions in 2.055 have no 3.01 counterpart.

## Reproducing the comparison

```bash
tools/extract.sh
python3 -I tools/analysis/unzip_sparse.py originals/MacOS753.zip MacOS753.image build/MacOS753.image
hmount build/MacOS753.image
hcopy -m ':StrategicConquest:Strategic Conquest Plus 2.0' build/sc20.bin
humount
python3 -I tools/analysis/macbin_split.py build/sc20.bin build/sc20      # writes build/sc20.rsrc
python3 -I tools/analysis/funcdiff.py build/sc20.rsrc build/sc301.rsrc build/funcdiff.json
```

## Open

Whether the changed functions in battle, Mover and machine alter the rules (unit stats,
combat odds, movement) is not yet known. Each subsystem will be compared as it is decompiled,
and rule differences logged in [quirks.md](quirks.md).
