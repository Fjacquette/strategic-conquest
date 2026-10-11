# Movement (3.01)

**Status: decoded and verified.** The engine's movement code (`engine/src/turn.ts`,
`mover.ts`, `path.ts` and the helpers they use) reproduces the original `PlayerTurn` and
everything it calls: on thousands of random turns the whole game state, every controller
request, message and beep match the original code run in the emulator harness
(`tools/emu/test_turn.py`), apart from the user-interface routines and the computer
opponent, which are stubbed. End-of-day processing and the computer opponent are not yet
decoded.

Source: Mover segment (CODE 5). `PlayerTurn` (`CODE 5 + 0x42D4`) runs one player's turn.
Per-type movers (`MoveArmy` `+0x2428`, `MoveFighter` `+0x349E`, `MoveBomber` `+0x2E50`,
`MoveDestroyer` `+0x3814`, `MoveSubmarine` `+0x3962`, `MoveTransport` `+0x3AB0`,
`MoveCarrier` `+0x3D4E`, `MoveBattleship` `+0x3F58`) each make one step, using the orders
step (`+0x1592`), the step executor (`+0x1B72`) and the move itself (`+0x0916`).

## Piece states and orders

Fields of the piece record are listed in [save-format.md](../save-format.md#pieces-offset-2408-6314-bytes).

| State (byte 11, bits 6–7) | Meaning |
|---|---|
| 0 | Under orders: moves by itself toward its destination (or at random) |
| 1 | Awake: the controller is asked for each step |
| 2 | Asleep: skipped (sentry, aboard ship, waiting for repair) |
| 3 | Transport loading: waits for Armies to board |

A piece under orders has a destination, point B. It travels along the straight line from
point C (where the current leg started) to B. Point A is the other end of a patrol.

- **Patrol** (byte 11 bit 0): on arrival, A and B are swapped and a new leg starts.
- **Random** (byte 11 bit 5): the piece moves in a random direction each step instead
  (QuickDraw `Random`), turning away from blocked cells.
- **Orders** (byte 11 bits 3–4): 2 while travelling straight; while going around an
  obstacle, 1 (turning clockwise) or 0 (counterclockwise).

New Armies get go-to orders to their city's Army destination, and new aircraft to the
city's aircraft destination, when those are set.

## Structure of a turn

1. **Production.** Each of the player's cities counts down one day; when a unit is
   complete it is built in the city (see [units.md](units.md)), and the controller is told
   (request 0). If anything was built, the piece table is compacted.
2. **Movement.** The map is divided into 16 overlapping regions (columns 1–23, 20–43,
   40–63, 60–80 × rows 1–18, 15–33, 30–48, 45–60). The sweep starts at the region after the
   one last processed. Within a region, the player's pieces are taken in piece-table order;
   each piece that has not moved yet this day makes all its steps.
3. A piece's steps continue while its step number is within its moves per day (recomputed
   each step, so damage slows a ship at once), unless the controller ends the piece's
   moves or defers it. A **deferred** piece is revisited in another full sweep after the
   current one.
4. **Two attacks per day:** after a piece's second attack of the day its moves end.
5. At the end of the turn the piece table is compacted: destroyed pieces are removed,
   Transports and then Carriers are moved to the front of the table (cargo is only carried
   by a ship that comes before it in the table), and the position hash is rebuilt.

## Before each step

- A Destroyer finds the nearest enemy Submarine within 1 square. If there is one, both
  wake and the Submarine becomes spotted. (The search, computer-opponent code, also
  requires the square to be explored by player 2, which is always the case here.)
- A piece with an enemy beside it wakes, unless that enemy is an unspotted Submarine.
  Otherwise, an Army or Transport next to an enemy or neutral city wakes.
- A player-2 ship next to the map edge (column 2 or 79, row 2 or 59) is given a random sea
  destination 3–12 squares away ([quirk Q10](../quirks.md)).
- Ships in their own city are repaired at the start of their first step (see below).

## The orders step

For a piece under orders (`CODE 5 + 0x1592`):

- **Arrival** at B ends the orders (the piece wakes), except that a patroller turns
  around, and an aircraft arriving at a human player's city that has an aircraft
  destination elsewhere is sent on to it.
- The next step comes from the path finder (below). If the destination cannot be reached
  the piece wakes, with "Unable to reach Destination, path is blocked." for a human player.
- The controller is asked instead of moving on when: a human player's piece has an enemy
  beside it (not an unspotted Submarine); the next square is off the map, holds a visible
  enemy, holds another of the player's ships at sea, or is terrain the piece cannot enter
  (an Army heading for a Transport with room may step onto it); a computer player's Carrier
  (or a Transport not at its destination) would enter one of its cities; or an enemy city
  is adjacent.

## Path finding

`CODE 4 + 0x19DA` and its helpers.

- The straight line from C to B gives the next step. An Army whose straight-line step is
  onto one of its own Transports at sea with room takes it.
- When the next square is terrain the piece cannot enter: if B itself is such terrain, the
  orders end. Otherwise the piece chooses a way around by simulating both turning
  directions from its current position, each for up to max(80, twice the distance)
  steps, and takes the one that reaches B in fewer steps; on a tie, a coin toss from the
  game PRNG. Going around, the piece turns (in its chosen direction) until the square ahead
  is free, at most 8 tries, and starts a new leg (C) on every square. Straight travel
  resumes when the first direction tried is free and the line from there to B is clear.

## Executing a step

The step executor (`CODE 5 + 0x1B72`) takes the orders step's move, or asks the controller
for a direction (request 5) and checks the answer:

| Answer | Result |
|---|---|
| Onto the edge or off the map | "You can't go off the edge of the world."; asked again |
| An Army onto a full Transport (6 Armies) | "The ship is full! Don't make that move." |
| Onto one of the player's own pieces, outside an own city, that is not a Transport to board, a Carrier to land on, another Army, or an aircraft (or with an aircraft) | "You're attacking your *piece*." |
| An Army into water with no own Transport or enemy piece there | "You will lose the Army with that move!" |
| A ship onto land or a city not its own, except a Destroyer, Carrier or Battleship attacking an Army or aircraft there | "You will lose the *ship* with that move!" |

A warning refuses the move and asks again, but **giving the same direction twice in a row
carries it out**: the Army drowns ("The Army drowned in the sea."), a ship runs aground,
an Army boarding a full ship falls in, and the piece is destroyed ("Your *ship* was
lost!"). A controller that puts the piece to sleep ends its step; one that gives it orders
has the path finder choose the step.

After the step, enemy pieces beside the piece wake (not when a Submarine moved), the piece
wakes if an enemy city is adjacent, and it looks around (exploration, below).

## The move itself

`CODE 5 + 0x0916`:

- **Leaving a ship:** an Army leaving a Transport, or a Fighter leaving a Carrier, lowers
  the ship's cargo count.
- **Boarding:** onto an own Transport (Army) or Carrier (Fighter): cargo +1; the Army goes
  to sleep aboard. A Transport that becomes full wakes (in single-player games all of
  player 2's Armies wake too). Boarding a full ship: "The *piece* fell off the ship and into
  the sea." and it is destroyed. A Carrier moving onto its own Fighter picks it up (+1).
- **An Army aboard a Transport attacking an enemy at sea** drowns: "You can't attack at
  sea with an Army. The Army drowned."
- **Attack:** moving onto an enemy piece (or own piece, when confirmed) fights it (see
  [combat.md](combat.md)). The attacker never moves into the square. Both pieces wake; a
  Submarine that attacks or is attacked becomes spotted; the battle is added to the
  battle summary. A Carrier involved in a fight wakes the computer's Fighters that are
  within 10 squares of their destinations.
- **Bomber:** a Bomber moving onto an enemy city or an enemy surface piece moves there and
  stops (its blast follows in `MoveBomber`).
- **Otherwise the piece moves.** A Transport or Carrier takes along up to 6 Armies or 15
  Fighters on its square that come after it in the piece table; carried Fighters are
  refuelled and, if under orders, woken. The ship's cargo count becomes the number carried.

## Per-type rules

**Army.** An Army asleep aboard a Transport (or anywhere) wakes when next to an enemy or
neutral city; an awake Army with no land or city around it (aboard at sea) goes to sleep,
unless it has been woken by hand. A human player's Army next to one of its Transports
that is loading gets go-to orders onto it. Moving into an enemy or neutral city attempts a
capture (below).

**Destroyer, Submarine, Battleship.** Cannot enter land or cities other than their own.

**Transport.** As a ship; when next to an enemy or neutral city, everything on its square
wakes. A loading Transport that is full wakes. In single-player games, player 2's
Transport at its destination with Armies aboard wakes them.

**Carrier.** Its cargo is recounted each step as the Fighters on its square.

**Fighter.** One fuel per step (also when it stays put); 20 fuel when it ends a step in an
own city or on an own Carrier. A Fighter asleep away from a city or Carrier burns one fuel
per step, and its moves for the day end when it goes to sleep. At 0 fuel it crashes ("Your
Fighter crashed after running out of fuel!"). A computer Fighter under orders at 10 fuel,
not heading for a refuelling point, wakes to replan.

**Bomber.** As a Fighter, with 30 fuel (refuelled in own cities only) and replanning at
15. On reaching its target both players see the area, the blast destroys what is in range
(see [combat.md](combat.md)), and the Bomber is destroyed; the computer's Bombers and
nearby Fighters wake.

**Repair.** A ship in its own city is repaired by 1 strength (2 in game modes 1 and 2) at
the start of its first step, once per day, up to its full strength; a ship asleep waiting
for repair wakes when fully repaired.

## Exploration and spotting

After each step (and when attacking), a piece looks at the 3×3 block around it
(`CODE 4 + 0x0500`): every square becomes explored for its owner. Enemy pieces there
become visible ("spotted"): Armies get spotted value 2, other pieces 1, and Submarines only
when the observer is a Destroyer. When enemies are in view, the observer itself becomes
spotted, and computer-controlled pieces of either side whose destination is within 6
squares of the observer wake. An enemy city in view also spots the observer.

## City capture

An Army that moves into a city that is not its own (with no enemy piece in it) tries to
capture it. The outcome depends only on the day (`CODE 5 + 0x23C4`, QuickDraw `Random`):

- before day 30: always succeeds;
- days 30–59: fails with probability ((day − 30) div 6 + 1) / 16;
- from day 60: fails with probability 6/16.

**The Army is used up either way.** On success the city changes owner, its Army and
aircraft destinations reset to the city itself, its production restarts as Army, and the
new owner is asked for a production choice (request 6). The computer's Fighters within 10
squares of their destinations and the capturing player's computer Bombers wake. Messages:
"You have captured the City!", and to the previous owner "The enemy captured your City!".
On failure: "Your attempt to conquer the City failed; the Army was destroyed." or "Your
City repelled an enemy invasion!".

## Controller interface

All controller traffic goes through `CODE 5 + 0x5CBA` with a 12-byte request record
(`engine/src/host.ts`). A human player's requests go to the user interface; a computer
player's go to the computer opponent (code 5 to its move chooser, `CODE 6 + 0x5102`;
codes 6 and 20 to its production planner, `CODE 6 + 0x4C72`), the rest to the user
interface for display.

| Code | When | Answer |
|---|---|---|
| 0 | A piece was built, or a city changed hands | — |
| 1 | A piece moved (from the position given) | — |
| 3 | Before each step | — |
| 4 | An attack on an own piece, or an Army entering a neutral city | — |
| 5 | A piece needs a direction | (dx, dy); or the controller changes the piece's orders |
| 6 | A captured city needs a production choice | — (the city is updated) |
| 16 | A battle, or an Army entering an enemy city | — |
| 18 | A Bomber blast finished | — |
| 19 | A Bomber attack begins | — |
| 20 | Start of the player's turn | — |
| 21 | A step finished | — |
| 22 | A step finished with something noteworthy (new territory, an enemy, a ship moving), or a piece was destroyed | — |

The controller can also end a piece's moves for the day or defer it to a later sweep.
