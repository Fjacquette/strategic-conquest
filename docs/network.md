# The AppleTalk game: Master and Slave (3.01)

**Status: architecture identified from the code; the packet formats are not decoded.** The
port will keep the same division of work between the two machines but use its own wire
format, so the AppleTalk protocol itself is not needed.

Sources: NetWork segment (CODE 11), the Slave's loop in Gstart (`CODE 10 + 0x1490`,
`+0x0CB0`), and the network branches of the main loop, `ControllerRequest`
(`CODE 5 + 0x5CBA`), `MessageA`/`MessageB` and the shared state routines of CODE 3 and 4.

## Roles

| | Master (game mode 2) | Slave (game mode 3) |
|---|---|---|
| Player | 1 (local player 1) | 2 (local player 2) |
| Game loop | The main loop: every day, both players' turns, production, combat | None |
| Game state | Authoritative | A mirror, kept in step by the Master |
| User interface | Player 1's | Player 2's |
| Saved games | Written here | — |

The Slave (`CODE 10 + 0x1490`) clears its tables, connects to the Master, and then loops:
it handles the Master's packets (`CODE 10 + 0x0CB0`, about 30 packet types) and otherwise
runs player 2's user interface. None of the rule routines (the turn, production, repair,
new pieces) are reachable from it.

## How the Slave's state is kept in step

The state routines shared by both sides (`MovePiece`, `Explore`, `CarryCargo`,
`WakeAdjacent`, `WakeAllAt`, `KillPiece`, `KillTypesAt`, `BomberBlast`, city changes,
compaction and others) test `game mode = 2` and `NET_SYNC`: on the Master they run and also
send the call to the Slave, which runs the same routine on its copy. `NET_SYNC` is cleared
around a call that is itself sent, so the routines it calls are not sent again. A new game
is started on the Slave from the game seed, so the Slave generates the same map itself.

## Controller requests and messages

On the Master, `ControllerRequest` routes each request by the player's controller:

- Display notifications (codes 0, 1, 16, 18, 20, 21 and 22, for either player) are shown on
  the Master and sent to the Slave.
- Player 2's other requests (all but code 3) are sent to the Slave, and the Master waits
  for the answer. For a direction request (code 5) the answer carries the piece's record
  as player 2's controller left it, so orders given on the Slave (sleep, go to, patrol)
  come back with it; the Master copies it into its piece table.
- Messages for player 2, or for everyone, are sent to the Slave.

## Consequences

- All rules run on the Master in mode 2, for both players. Rules that test the game mode
  therefore apply equally to both sides of a network game (this settles quirk Q7).
- The end-of-game checks of the main loop are skipped in mode 2 ([rules/day.md](rules/day.md#end-of-the-game)).
- The Slave holds the whole game state, including enemy pieces player 2 cannot see.
