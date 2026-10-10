# Movement (3.01)

**Status: partly decoded.** The rules below were confirmed by running the original movement
code in the emulator harness with scripted moves (`tools/emu/probe_move.py`). Orders
(sleep, sentry, patrol, go-to, transport loading) and the full step logic are still being
decoded, and there is no verified Python model yet.

Source: Mover segment (CODE 5). `PlayerTurn` (`CODE 5 + 0x42D4`) runs one player's turn;
per-type handlers (`MoveArmy` `+0x2428`, `MoveFighter` `+0x349E`, `MoveDestroyer` `+0x3814`,
`MoveSubmarine` `+0x3962`, `MoveTransport` `+0x3AB0`, `MoveCarrier` `+0x3D4E`,
`MoveBattleship` `+0x3F58`, `MoveBomber` `+0x2E50`) call the step executor
(`CODE 5 + 0x1B72`).

## Structure of a turn

1. **Production** for each city the player owns (see [units.md](units.md)).
2. **Movement.** The map is split into 16 regions, processed starting from a rotating
   region. Within a region, pieces are taken in piece-table order. A piece that has not
   moved this day moves step by step until its moves for the day are used up.
3. For each step the game asks the side's controller for a direction: the human interface,
   the computer opponent, or (AppleTalk) the network. All of these requests go through one
   routine (`CODE 5 + 0x5CBA`); see "Controller interface" below.

## Confirmed step rules

| Situation | Result |
|---|---|
| Army onto land, into its own city, or onto another of its own Armies | Moves; Armies can share a square |
| Army into water with no Transport | Warning "You will lose the Army with that move!"; the move does not happen. **Repeating the same move** confirms it: "The Army drowned in the sea." and the Army is destroyed |
| Army onto its own Transport at sea | Boards: moves onto the Transport's square, Transport cargo +1, Army state becomes 2 |
| Army onto a Transport already carrying 6 | "The ship is full! Don't make that move."; refused |
| Transport moves | Armies aboard move with it |
| Ship onto land, or into a city it does not own | Same warning; refused unless repeated |
| Ship into its own city | Moves into port |
| Destroyer moves at sea | 4 steps per day |
| Fighter onto its own Carrier | Boards; Carrier cargo +1; Fighter refueled to full |
| Fighter in its own city | Refueled to full |
| Aircraft runs out of fuel away from a city or Carrier | "Your Fighter crashed after running out of fuel!"; destroyed |
| Any move off the map | "You can't go off the edge of the world."; refused |
| Moving into an enemy piece | Attack ([combat.md](combat.md)); the attacker does not move into the square, even when it wins |
| Standing still (direction 0, 0) | Uses one move; aircraft also use fuel |

## City capture

An Army moving into a city that is not its own (and holds no enemy pieces) tries to capture
it. The outcome depends only on the day (`DayRandomCheck`, `CODE 5 + 0x23C4`):

- before day 30: always succeeds;
- days 30–59: fails with probability ((day − 30) div 6 + 1) / 16;
- from day 60: fails with probability 6/16.

**The Army is used up either way.** On success the city changes owner (its map cell takes
the new owner's code) and the new owner chooses production; the messages are "You have
captured the City!" and, to the previous owner, "The enemy captured your City!". On
failure: "Your attempt to conquer the City failed; the Army was destroyed." (neutral city)
or "Your City repelled an enemy invasion!" (to the defender).

Units inside a city must be attacked first; capture is only attempted on a city with no
enemy pieces.

## Controller interface

The engine posts numbered requests; the controller answers some of them. Observed so far:

| Code | When | Answer |
|---|---|---|
| 20 | start of a player's turn | — |
| 3 | before each step | — |
| 5 | a piece needs a direction | (dx, dy), each −1, 0 or 1 |
| 1 | a piece moved | — |
| 22 | a piece finished its step | — |
| 16 | a battle | — |
| 6 | a captured city needs a production choice | production type |
| 0, 21 | not yet identified | — |

For a computer-controlled side, code 5 goes to the computer opponent's move chooser
(`CODE 6 + 0x5102`), codes 6 and 20 to its production chooser (`CODE 6 + 0x4C72`).

## Still to decode

- Piece states (byte 11, bits 6–7: 1 when awake; 2 for Armies aboard, which are then not
  asked to move until woken) and the orders that set them: Sleep, Wake, Transport Load,
  Random, Patrol, Army/Aircraft Destination, Stack Move.
- Unloading Armies from a Transport; Carrier capacity; Bomber attack trigger.
- Exploration: how far each piece sees and how the explored map is updated.
- End-of-day resets (moved flags, repair flags) and the compaction pass, which removes
  destroyed pieces and was observed to reorder the table (Transports placed ahead of the
  Armies in our tests).
