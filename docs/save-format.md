# Save-file format (3.01)

Status: early. Only what the first diffs show is recorded here; everything marked
*hypothesis* still needs confirming.

## General

- Fixed size: 11,381 bytes, data fork only.
- Mac type `SC∂ `, creator `SCÆ `.
- Written only at the end of a round (after the computer's move).

## Header

| Offset | Size | Value in saves | Meaning |
|---|---|---|---|
| 0 | 6 | `E6 F0 01 66 00 01` in all four saves | Unknown (constant so far) |
| 6 | 2 | 5, 6, 57, 58 | Day number of the next turn (word; low byte at offset 7) |

## Diff: `s01-day4` → `s02-day5-army-east`

Between these saves the human Army moved one square east from the city at column 38,
row 28; the computer also took its turn.

| Offset | s01 | s02 | Interpretation |
|---|---|---|---|
| 7 | `05` | `06` | Day number |
| 2425–2433 | `26 1C 26 1C 26 00 22 10 44` | `27 1C 27 1C 27 00 22 10 14` | Army record: column 0x26→0x27 (38→39), row 0x1C (28), stored twice; the column appears a third time |
| 9037 | `00` | `1C` | Unknown |
| 10022 | `04` | `03` | *Hypothesis:* production countdown |
| 10102 | `02` | `01` | *Hypothesis:* production countdown |
| 10512 + 22·k, k = 0..14 | `04` (one `03`) | `05` (one `04`) | 15 records of 22 bytes, each with a counter incremented by 1 |

Bytes 8 onward begin with long runs of `0x55`, then values such as `0x35`, `0x33`,
`0x00`. *Hypothesis:* map data.

## Next steps

- Locate the read/write routines (`_Write`/`_Read` call sites in Gstart and Main) and read
  the structure layout directly from the code, rather than only from diffs.
- Use the mid-game saves (day 57, day 58) to confirm the map encoding against screenshots.
