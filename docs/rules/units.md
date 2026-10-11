# Units and production (3.01)

**Status: decoded and verified.** `engine/src/units.ts` matches the original routines for
every type, strength and game mode and a range of days, and builds the same pieces into
random worlds, piece table and position hash included, also with a full table
(`tools/emu/test_units.py`). The two-player
production times and Army moves were also confirmed in the running game.

## Game modes

| Mode | Setup choice |
|---|---|
| 0 | Single Player Game (against the computer) |
| 1 | 2 Player Single Mac Game (hot seat; confirmed from a save) |
| 2 | AppleTalk Master |
| 3 | AppleTalk Slave |

Modes 2 and 3 are inferred from the network code. Choosing a two-player mode sets skill
to 4 and hides the skill slider.

## Unit table

| Type | Code | Strength when built | Moves per day | Fuel | Build days | Max strength restored in port |
|---|---|---|---|---|---|---|
| Army | 0 | 1 | 1 | — | 4 | — |
| Fighter | 1 | 1 | 20 | 20 | 6 | — |
| Destroyer | 2 | 4 | 4; 3 at strength ≤ 2 | — | 8 | 4 |
| Submarine | 3 | 3 | 3; 2 at strength ≤ 1 | — | 10 | 3 |
| Carrier | 4 | 10 | 3; 2 at strength ≤ 4 | — | 14 | 10 |
| Transport | 5 | 3 | 3; 2 at strength ≤ 1 | — | 10 | 3 |
| Battleship | 6 | 18 | 3; 2 at strength ≤ 6 | — | 20 | 18 |
| Bomber | 7 | 1 | 10 | 30 | 20 + 5 × (day div 70) | — |

Routines: moves `CODE 4 + 0x11BA`, build days `CODE 1 + 0x021C`, new piece
`CODE 4 + 0x20EE`, repair `CODE 5 + 0x4110`.

## Two-player games run faster

| Rule | Single player (mode 0) | Two-player modes |
|---|---|---|
| Moves per day for Armies and ships | as in the table | **doubled** (modes 1, 2, 3) |
| Build days | as in the table | **halved**, rounded down (modes 1, 2, 3) |
| Repair in port per day | +1 | **+2** (modes 1 and 2 only) |
| Bomber blast radius divisor | 70 | **35** (modes 1 and 2 only) |

Aircraft moves are not doubled. See quirk Q7 about modes 2 and 3 differing.

## Production

- Each day, every city owned by the player counts its timer down by 1. At 0 it builds its
  current production type and the timer restarts at that type's build days.
- In single player at skill levels above 2, the computer gets **two** units each time one
  of its cities completes, until day 2 × (skill − 2) (`CODE 4 + 0x2496`).
- A new Army or ship whose city has an Army destination ("CAD") set starts with orders to
  go there.
- The piece table holds at most 449 pieces; see quirk Q6 for what happens when it is full.

## New units

All four position fields are set to the city's position, the "spotted" bits are cleared,
and the state field (byte 11, bits 6–7) is set to 1. Fighters and Bombers start with full
fuel; Transports and Carriers start empty.

**Bomber blast radius** is fixed when the Bomber is built: (day − 5) div 70, or div 35 in
modes 1 and 2. Bombers built before day 75 have radius 0 and hit only their own square.

## Repair in port

A Destroyer, Submarine, Transport, Carrier or Battleship that begins its move in one of its
own cities gains 1 strength (2 in modes 1 and 2), up to its maximum. Byte 13 of the record
marks that it has been repaired, so this happens once per stay.
