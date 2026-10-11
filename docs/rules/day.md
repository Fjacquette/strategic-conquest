# The day (3.01)

**Status: decoded and verified** for games against the computer (game mode 0) and two
players on one Mac (mode 1). The engine's day loop (`engine/src/day.ts`) reproduces the
original's: on random days, with both players' turns driven by a scripted controller, the
whole game state, every request, message and beep, the user-interface events and the
end-of-game outcomes match the original code run in the emulator harness
(`tools/emu/test_day.py`). The network game (mode 2) follows the same loop, but its
network traffic is not decoded and is left to the host; it is not covered by the test.

Source: the main loop, `CODE 1 + 0x170A`; one day is the loop body from `0x195C` to the
reseeding of the game PRNG at `0x1F74`.

## A day

1. The day count goes up by one.
2. **Autosave**, if the game has been saved to a file: every third day after day 20, and
   in two-player games (modes 1 and 2) every day after day 10.
3. Menu actions chosen during the day that must wait for its end, such as *Play Again*
   after a surrender, are carried out (`CODE 10 + 0x0A8A`; not decoded, left to the host).
4. **News for player 1**: the day message ("day # *N*", message line 2) and the battle
   summary. With two players on one Mac this comes with the hand-off (below), and only
   when player 1 has something to do; in the network game a beep comes first.
5. The battle reports are cleared.
6. **Every piece is reset for the day**: its moved flag, attack count, step count and
   repaired-in-port flag are cleared.
7. **Player 1's turn** ([movement.md](movement.md)). Under Auto Play the computer plays it
   (below).
8. Player 2's spotted pieces fade (below), and player 1's message lines are cleared.
9. **News for player 2** (hand-off on one Mac; beep and news in the network game), and the
   battle reports are cleared.
10. **Player 2's turn**, then player 2's message lines are cleared and player 1's spotted
    pieces fade.
11. **End-of-game checks** (below), except in the network game.
12. Auto Play is switched on or off if it was chosen in the menu during the day.
13. The game PRNG is reseeded from the clock ([quirk Q2](../quirks.md)).

## Spotted pieces fade

A piece the enemy has seen is *spotted* (byte 12, bits 6–7: Armies get 2 when seen, other
pieces 1; see [movement.md](movement.md#exploration-and-spotting)). After the opponent's
turn (`CODE 1 + 0x1328`), each of a player's spotted pieces loses one level, unless an
enemy city or an enemy piece is in the 3×3 block around it. When it reaches 0 the piece is
hidden from the enemy again, and the display is told (request 22).

## End of the game

Checked after both turns, in games against the computer and on one Mac (`CODE 1 + 0x1E16`).
The check of a player (`Defeated`, `CODE 1 + 0x149A`) first counts both players' cities;
a player is beaten when it has no city and no Army, and a player other than the local one
also when player 1 has more than five times its cities (player 1's cities div 5 > its
cities).

- **Player 1 loses** when it has no city, or after day 100 when `Defeated(1)`: "I have
  smashed your forces. Tough luck!" (STR 1040). The game is saved and ends.
- **Player 2 offers its surrender** when it has no city, or after day 100 when
  `Defeated(2)`: "General, will you accept my surrender?" (DLOG 330). *Yes* leads to
  "Congratulations, General. The world is yours." with *Play Again* or *Quit* (which saves
  first); *No Way* continues the game.
- Once either has happened in a session, they happen again only for a player with no city.
  (The original keeps this in a register of the main loop, so it is not saved.)

Against the computer the local player is always player 1 at this point, so the five-to-one
rule applies to player 2 only. On one Mac the local player is the one the Mac was last
handed to, usually player 2, and the rule is then applied to player 1: a player 1 that is far
ahead after day 100 is told it has lost ([quirk Q12](../quirks.md)).

## Two players on one Mac (mode 1)

Before a player's turn, if that player has anything to do (any piece, or a city that
completes a unit this day; `CODE 1 + 0x158C`), the Mac is handed over: the map is hidden
(request 17) and a hand-off screen shown (request 8), except before player 1's first turn
in a session; the player's own map view is restored, which also **restarts the movement
sweep at region 0** for that turn; the map is shown (request 15), then the day message and
battle summary. The player handed to becomes the local player.

## Auto Play

The computer can play player 1's side (menu option; the mouse button still held down at
launch also turns it on, `_StillDown` at `CODE 1 + 0x1852`). The computer opponent is written to play
player 2, so for player 1's turn the game exchanges the two sides (`CODE 1 + 0x2C48`): the
players' maps (explored areas and computer flags), the computer opponent's data for the
side it plays and its copy for the other side, and the owner of every city (with its map
cell) and piece. It then plays the turn as player 2, fades the other side's spotted pieces,
and exchanges the sides back. Switching Auto Play on or off takes effect at the end of the
day; it sets player 1's computer flag.

## In the engine

`runDay` plays one day; the day loop's state across days (`DayLoop`: the end-of-game
announcement flag and the first hand-off) belongs to the session. User-interface work is
reported to the host: requests 8, 15 and 17, the day message, events `autosave`,
`battleSummary`, `clearReports` and `autoPlay`, and the end-of-game outcome returned by
`runDay`. The clock for the reseed comes from the host (`dateTime`).
