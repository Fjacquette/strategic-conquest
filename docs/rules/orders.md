# Orders (3.01)

**Status: decoded and verified.** `engine/src/orders.ts` carries out every command a human
player can give that changes the game, and matches the original handlers on thousands of
random commands (`tools/emu/test_orders.py`, which drives the original's menu, map-click
and production-dialog code with scripted clicks).

Sources: the human controller (`CODE 5 + 0x51FE`), the Moves menu (`Domenu`,
`CODE 16 + 0x0028`), clicks on the map (`CODE 13 + 0x0028`), Wake (`CODE 4 + 0x0C08`), the
production dialog (`CODE 18 + 0x1820`, drawing `+0x0EBC`, buttons `+0x14BC`).

## When orders are given

The controller of a human player handles every request addressed to it
([movement.md](movement.md#controller-interface)). For a direction request (code 5) it
shows the piece's status and waits until a command answers the request; for any other
request it handles one pending event. Commands can be given at any of these moments; some
apply only to the piece of a direction request (*the piece being moved*). A command that
answers the request gives the mover a direction, or (0, 0) when the piece's orders or
state were changed instead.

The Moves menu's letters work without the Command key: every key press is looked up as a
menu shortcut.

## Commands

| Command | Input | Effect | Answers the request |
|---|---|---|---|
| Direction | Click on a cell next to the piece being moved, or on it | That direction (any request; only the 3×3 block around the request's position counts) | Yes |
| Go to | Drag from a cell with one of the player's pieces on top to a target | The piece (the piece being moved, if it stands on that cell) gets go-to orders: point C and point A become its cell, B the target (column at most 80, row at most 60); random moves and patrol are cleared. The reply is its first step toward the target | If it is the piece being moved |
| Sleep (S) | — | The piece being moved goes to sleep | Yes |
| Wake (W) | Click on a cell | Every piece on the cell wakes, whoever owns it ([quirk Q13](../quirks.md)) | No |
| Transport Load (L) | Click on a cell | The player's Transport on top of the cell starts loading | If it is the piece being moved |
| Random (R) | — | The piece being moved moves at random from now on | Yes |
| City Aircraft Destination (C) | Click on one of the player's cities, drag to a target | Aircraft built there will fly to the target. If the piece being moved is a Fighter or Bomber in that city, it gets go-to orders to the target | In that case |
| Army Destination (A) | Click on one of the player's cities, drag to a target | Armies built there will go to the target | No |
| Stack Move (M) | Click on a cell with any piece, drag to a target | Every piece of the player on the cell gets go-to orders | If the piece being moved is among them |
| Patrol (P) | Drag to a target | The piece being moved (or, without one, the player's top piece where the drag starts) patrols between its cell and the target | If it is the piece being moved |
| Skip (N) | — | The piece being moved is done for the day | Yes |
| Move Later (B) | — | The piece being moved is revisited after the other pieces | Yes |
| Production | Double-click on one of the player's cities, or the City List | The production dialog (below) | No |
| Auto Play | Options menu | Requests the computer to play (or stop playing) player 1's side, from the end of the day ([day.md](day.md#auto-play)) | No |

Go-to orders given through the menu commands (Stack Move, Patrol, aircraft sent from a
city) are set by `SetDestination` (`CODE 1 + 0x06AC`), which leaves point A alone for a
Transport; the drag sets point A for every piece. Neither checks that the target can be
reached; the path finder deals with that on the way
([movement.md](movement.md#path-finding)).

Double-clicking one of the player's pieces shows its details; nothing changes.

## Production

The production dialog lists the eight types. Ships (Destroyer, Submarine, Transport,
Carrier, Battleship) can only be chosen in a city with water in the 3×3 block around it;
inland, their buttons are disabled and choosing one is refused with an alert. Bombers can
be built anywhere.

Choosing another type restarts the count with the new type's build days. Choosing again
the type the city was building when the dialog opened restores the days it had left
then, so looking at other types costs nothing. (The dialog takes these values whenever it
redraws, for example after the alert.) After a capture (request 6) the dialog opens with
the city set to build Armies.

## On the AppleTalk Slave

The Slave runs the same handlers for player 2. A command on the piece being moved changes
the Slave's copy of the piece, which goes back to the Master with the reply; commands on
other pieces and on cities are sent to the Master as separate messages
([network.md](../network.md)).

## Menus that give no orders

The Debug menu in the resources (Compact Mem, ShowMem, List Piece, AllVis, CopyVis, list
cities) is never installed. The Options handler also has two items beyond the four in its
menu, one of which reveals the whole map and every enemy piece; they cannot be chosen.
