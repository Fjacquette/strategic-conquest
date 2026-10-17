# Combat (3.01)

**Status: decoded and verified.** `engine/src/battle.ts` reproduces the original battle code
exactly: run on the emulated 68040 against the original routines on random attacks and
Bomber blasts, the whole game state (pieces, position hash, cities, terrain, PRNG) and the
return value match in every case (`tools/emu/test_battle.py`), and battles inside whole
turns match too (`tools/emu/test_turn.py`).

Source: battle segment (CODE 3). `Attack` (`CODE 3 + 0x0520`) is called from Mover through
`AttackAndReport` (`CODE 1 + 0x2140`), which also logs the fight for the battle summary.

Piece types: 0 Army, 1 Fighter, 2 Destroyer, 3 Submarine, 4 Carrier, 5 Transport,
6 Battleship, 7 Bomber. "Ships" are types 2–6; "aircraft" are 1 and 7.

## 1. Attacks that do not happen

Checked in this order:

1. An Army attacking a Submarine at sea: nothing happens.
2. A Transport cannot attack: nothing happens.
3. A Submarine attacking an aircraft: nothing happens.
4. A Submarine attacking a target on land or in a neutral city: **the Submarine is
   destroyed.** Targets in an owned city (ships in port) can be attacked normally.

Other restrictions, such as which pieces may move onto which squares, are enforced by the
movement code and are documented with movement.

## 2. Unspotted Submarines strike first

When a ship attacks a Submarine that is not spotted (bits 6–7 of byte 12 of its record are
0; see [movement.md](movement.md#exploration-and-spotting)), the two exchange roles for the
fight: the Submarine is resolved as the attacker and the ship as the defender.

## 3. The roll

**Strength ratio.** R = trunc(10 × attacker strength ÷ defender strength).

| R | ≤ 1 | 2 | 3–5 | 6–10 | 11–20 | 21–40 | > 40 |
|---|---|---|---|---|---|---|---|
| Column | 1 | 2 | 3 | 4 | 5 | 6 | 7 |

**Column modifiers**, applied in this order:

| Attacker | Defender | Modifier |
|---|---|---|
| Destroyer | Transport | +2 |
| Fighter | Submarine, Transport or Bomber | +1 |
| Submarine | any ship | +4 |
| Destroyer | Submarine | +4 |
| Army | Destroyer, Submarine, Carrier or Battleship | −1 |
| Bomber | aircraft | −1 |
| Bomber | any ship | column set to 1 |
| any | a ship in a city (any owner) | +4 |

The column is then limited to 1–7.

**Die.** d = (|trunc(r ÷ 113)| mod 6) + 1, where r is the next value from the game PRNG.

**Combat results table** (W = attacker wins, L = attacker loses, R = repelled, no loser):

| Die \ Column | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| 1 | L | L | L | L | L | R | R |
| 2 | L | L | L | L | R | R | W |
| 3 | L | L | L | R | R | W | W |
| 4 | L | L | R | R | W | W | W |
| 5 | L | R | R | W | W | W | W |
| 6 | L | R | W | W | W | W | W |

Example: two strength-1 Armies give R = 10, column 4: the attacker loses on 1–2, is
repelled on 3–4 and wins on 5–6.

With the die's six faces equally likely, the columns give (attacker loses / repelled /
attacker wins, in sixths): 1: 6/0/0; 2: 4/2/0; 3: 3/2/1; 4: 2/2/2; 5: 1/2/3; 6: 0/2/4;
7: 0/1/5.

### Odds at full strength

Attackers down the side, defenders across the top; each cell is the chance, in percent, that
the attacker wins / is repelled / loses, at full strength, with the defender in the open and
a defending Submarine spotted (`tools/analysis/combat_odds.py`). The game's generator gives
each die face 16–18% of the time, so these are good to about a point. "No fight": nothing
happens; "sub lost": the Submarine is destroyed; "blast": a Bomber blasts instead of fighting.

| Attacker ↓ Defender → | Army | Fighter | Destroyer | Submarine | Carrier | Transport | Battleship | Bomber |
|---|---|---|---|---|---|---|---|---|
| **Army** | 33/33/33 | 33/33/33 | 0/0/100 | no fight | 0/0/100 | 17/33/50 | 0/0/100 | 33/33/33 |
| **Fighter** | 33/33/33 | 33/33/33 | 0/33/67 | 33/33/33 | 0/0/100 | 33/33/33 | 0/0/100 | 50/33/17 |
| **Destroyer** | 67/33/0 | 67/33/0 | 33/33/33 | 83/17/0 | 17/33/50 | 83/17/0 | 0/33/67 | 67/33/0 |
| **Submarine** | sub lost | no fight | 83/17/0 | 83/17/0 | 83/17/0 | 83/17/0 | 50/33/17 | no fight |
| **Carrier** | 83/17/0 | 83/17/0 | 67/33/0 | 67/33/0 | 33/33/33 | 67/33/0 | 17/33/50 | 83/17/0 |
| **Transport** | can't attack | can't attack | can't attack | can't attack | can't attack | can't attack | can't attack | can't attack |
| **Battleship** | 83/17/0 | 83/17/0 | 83/17/0 | 83/17/0 | 50/33/17 | 83/17/0 | 33/33/33 | 83/17/0 |
| **Bomber** | blast | 17/33/50 | blast | blast | blast | blast | blast | 17/33/50 |

A ship defending in a city is attacked at +4 columns (an Army against a Destroyer in port:
50/33/17). A ship attacking an unspotted Submarine fights as the defender. Lower strength
(damage, wear) moves the ratio and so the column.

## 4. Damage to the loser

The loser takes damage determined by the winner. If the damage is at least the loser's
strength, the loser is destroyed; otherwise its strength drops by the damage.

**Attacker wins**, damage to the defender:

| Attacker | Damage |
|---|---|
| Submarine | 1 against a Destroyer; otherwise 3 × the Submarine's strength |
| Battleship | strength 1–6: 3; 7–10: 4; 11–14: 5; 15–18: 6 |
| Any other | 3, or 2 if the attacker is weakened |

**Attacker loses**, damage to the attacker: 3, or 2 if the defender is weakened. No damage
if the defender is a Transport, or if a Fighter attacked a Submarine.

**Weakened** means strength at or below the type's threshold:

| Army | Fighter | Destroyer | Submarine | Carrier | Transport | Battleship | Bomber |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 2 | 2 | 7 | 2 | 10 | 0 |

So Armies, Fighters and Bombers always deal full damage.

**Transports and Carriers** take everything on their square with them when destroyed
(cargo, embarked Fighters). In a city with an owner, only one piece is meant to be lost;
see quirk Q4.

## 5. Wear after every fight

After any fight that reaches the roll, the attacker and then the defender each make a wear
check: if its strength is above 1, it loses 1 strength with probability 1/2
(|r| mod 10 < 5, r the next PRNG value). The check also runs for a piece just destroyed in
the fight; this has no visible effect but does consume a random number.

PRNG draws per attack: none for the cases in section 1; otherwise one for the die plus one
per piece with strength above 1.

## 6. Bomber blast

`BomberBlast` (`CODE 3 + 0x0A30`). The Bomber's record holds a blast radius in bits 2–7 of
byte 8, fixed when it is built (see [units.md](units.md)); the blast happens when the Bomber
reaches an enemy city or enemy surface piece (see [movement.md](movement.md#per-type-rules)).
Every square within that radius (Chebyshev distance: the larger of the column and row
differences) is hit:

- Armies and ships are destroyed, the Bomber's own side included. A Carrier is destroyed
  together with every Fighter and Carrier on its square.
- Aircraft in flight are unaffected; aircraft parked in an owned city are destroyed.
- Every city in range (by its position, bytes 6–7 of the city record) becomes neutral:
  owner, production countdown and production type are reset, and the map cell becomes a
  neutral city.

No random numbers are used.

## 7. Implementation notes for the port

- A destroyed piece is first marked type 8 ("removed") with its owner restored, so the
  battle summary can report it; it is dropped from the position hash at once and its slot
  is freed when the table is compacted.
- The original also contains a debugging cheat and a bug; both are listed in
  [quirks.md](../quirks.md) (Q3, Q4) for a decision.
- A Battleship-versus-Submarine modifier is evaluated but never applied (dead code), so
  it has no effect. Listed as Q5 for information.
