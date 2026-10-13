# The AppleTalk game: Master and Slave (3.01)

**Status: architecture identified from the code; the packet formats are not decoded.** The
port keeps the same division of work between the two machines but uses its own wire format
(see [the port's network game](#the-ports-network-game)), so the AppleTalk protocol itself is
not needed.

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

## The port's network game

The browser game keeps the Master and Slave roles (`web/src/net.ts`) and connects the two
pages directly (`web/src/link.ts`, a WebRTC data channel).

**Connecting.** In the setup dialog one player chooses *Network Game: Invite* and becomes
the Master (player 1); the other chooses *Network Game: Join* and becomes the Slave
(player 2). The Master's page shows an invitation code (the connection offer, compressed,
about 550 characters); the other player pastes it into their page, which shows a reply code
to send back; the Master pastes that and the pages connect. The codes go between the players
by any means (email, a chat). A public STUN server (Google's) tells each browser how it is
seen from the internet, which is how two home networks find each other; no game data goes
through it, and there is no relay, so networks that allow no direct path cannot connect.
Both pages must be the same version (they exchange a protocol number first).

**Packets.** Each packet is a kind, a small JSON header and the bytes of the game state
(the globals image) that changed since the other page last had it, as runs of offset,
length and bytes. Each page keeps for itself the local player number, QuickDraw's random
seed (the fight display draws on it) and two words of the user interface's.

- The Master sends a **request** for each notification both players see, whoever's piece
  it is (codes 0, 1, 16, 18, 20, 21 and 22, the original's set), showing it itself at the
  same time, and for each of player 2's other requests but code 3 (player 2's moves and
  production choices). It waits for the Slave's **answer**: the request record and reply as
  player 2's interface left them, with what player 2's commands changed in the state (orders
  given, a city's production, a piece put to sleep). The original sends the step
  notifications (codes 1, 21, 22) with `NET_SYNC` off and mirrors the moves themselves;
  here they go as requests, so player 2 sees player 1's moves as they happen.
- **Messages** for player 2 or for everyone, **beeps** for player 2, and the start of player
  2's day news go to the Slave without waiting.
- A password request is answered on the Master: network games have no passwords here.

The Master's File > Save writes the game (game mode 2), and its autosave works as in the
original. A saved network game goes on from the setup screen: the Master chooses File >
Resume Game, picks it, and invites the other player again. If the connection is lost, each
page says so and the game stops; the Master's last save is where it goes on from.

Tested with two pages in headless Chromium (`tools/web/test_netgame.py`): a game with both
players moving at random, saved midway and resumed in two new pages, with the two pages'
game states compared each time the Slave is asked to move; and the connection itself
(`tools/web/test_link.py`).
