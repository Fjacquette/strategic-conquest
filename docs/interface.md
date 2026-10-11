# The human controller: sounds, fight and blast displays

Every request the engine makes goes through `ControllerRequest` (`CODE 5 + 0x5CBA`). For
a computer player, a direction request (5) goes to the computer opponent's move chooser,
production and turn-start requests (6, 20) to its production routine (20 also shows whose
turn it is), and everything else to the human controller (`CODE 5 + 0x51FE`), which shows
it on the map. This file records what the human controller does beyond drawing: when the
sounds play, the fight and Bomber-blast displays, and the two places where showing a fight
changes the game.

## Sounds

There are five sounds (`snd` 128–132: LFighter, LArmy, LShip, LExplosion, LBattle) and one
sound channel. The play routine (`CODE 1 + 0x114A`) takes a sound number and a "force"
flag:

| Number | Sound |
|---|---|
| 0 (Army) | LArmy |
| 1 (Fighter), 7 (Bomber) | LFighter |
| 2–6 (ships) | LShip |
| 8, 9 | LExplosion |
| 10 | LBattle |

While a sound is playing, a new one starts only if forced, and then cuts the old one off.
A sound counts as finished when it ends or 240 ticks (4 seconds) after it started
(`CODE 1 + 0x11F2`). With Sound off nothing plays. The system beep (`CODE 1 + 0x123E`)
cuts off any sound first.

Where sounds play:

| Occasion | Sound |
|---|---|
| A step shown to the player (requests 21 and 22 with the flag set; `CODE 5 + 0x5218`). Only on a square inside the map window that the local player has explored, and only for a piece that is not aboard another (state 2 or 3). | An Army next to an enemy piece: LBattle (forced) if that piece is spotted, LArmy (not forced) if not. An Army next to an enemy city: LBattle (forced). Any other Army: LArmy (not forced), the local player's own only. The local player's other pieces: their type's sound (forced), unless a piece of the same type is the last to have asked and its sound is still playing. The enemy's other pieces make no sound. |
| A fight (requests 4 and 16; `CODE 17 + 0x0CC2`) | LExplosion (forced). At the second of the four flashes, an Army's fight changes to LBattle (forced) if QuickDraw's `Random` is odd or the explosion has finished; any other piece's explosion starts again (forced). |
| A Bomber's blast (request 18; `CODE 17 + 0x0E56`) | LExplosion (forced) while the blast is shown. |
| The computer's Bomber reaches its target (`CODE 5 + 0x31CE`), then its blast is shown (`CODE 5 + 0x5BDA`, single player only) | The system beep; then the beep again before and after the map scrolls to the blast. |
| A refused move (`CODE 1 + 0x0928`) | The system beep, for a human player. |

## The fight display

Requests 4 (an attack on a neutral city, or on a city that repels it) and 16 (a battle)
scroll the map to the request's position, which is the attacker's square, and flash it:
the square is inverted for 4 ticks and restored for 8 ticks, four times (about 0.8 s).
In single player every fight is shown, the computer's included: the engine addresses fight
requests to the local player.

## The Bomber-blast display

A disc in QuickDraw's `dkGray` pattern covers the blast: `FillRoundRect` over the square
16·r pixels on each side of the centre of the target square (r is the blast radius, at
least 1), clipped to the map. It stays for 120 ticks (2 seconds); then the area is drawn
again.

## Where showing a fight changes the game

- The attacker becomes spotted (its spotted value goes from 0 to 1) when its fight is
  shown (`CODE 17 + 0x0CDE`).
- Showing an Army's fight draws one number from QuickDraw's `Random` (`CODE 17 + 0x0D7E`),
  the generator that path finding also uses, so later random choices depend on it.

The differential tests stand in for `ControllerRequest`, so neither happens in them; the
user interface must do both, as the browser host does. In a network game a fight is shown
on the mover's machine only (the engine addresses it to the mover); whether the attacker
is then spotted on the Master is not yet checked.
