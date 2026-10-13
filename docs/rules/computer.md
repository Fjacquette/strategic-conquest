# The computer opponent (3.01)

**Status: decoded; verified routine by routine and on whole games** (see the end). The
engine's computer opponent (`engine/src/ai/`) is a translation of the original's routines in
CODE 1, 2, 6, 7, 8 and 9. Each routine matches the original's on the states it meets in real
games of the original run in the emulator (`tools/emu/test_ai.py`), and whole games played
by the computer match day by day (`tools/emu/test_aigame.py`).

The computer always plays player 2 in a game against it, and also player 1 under Auto Play.
Its data (below) is kept for the side it is playing; under Auto Play the two sides' data are
swapped with the sides (`CODE 1 + 0x2C48`, see [day.md](day.md)).

## How it is called

- **Direction requests** (code 5) for its pieces go to its move chooser (`CODE 6 + 0x5102`).
- **Production requests** (code 6) and **the start of its turn** (code 20) go to its
  production routine (`CODE 6 + 0x4C72`).
- Its other requests (battles, Bomber blasts, steps) go to the human controller, which shows
  them to the human player.
- The game calls its **planning tallies** (`CODE 7 + 0x11EA`) at the start of its turn and
  after each piece it builds, its **new-piece routine** (`CODE 1 + 0x0626`) after each piece
  it builds, and its **start-of-game set-up** (`CODE 2 + 0x2E3A`, `+0x24DE`) for a new game
  or a resumed one.

In the engine, `computerRequest` and `computerHooks` (`engine/src/ai/opponent.ts`) are what a
host calls for these.

## What it knows

Everything is judged from what player 2 has explored and spotted, not from the true state.

- **Islands.** A 22-byte record per island: the side's Armies there, the enemy Armies it has
  spotted there, its own, the enemy's and neutral cities it has seen there, whether some or
  all of the island is explored, the island's *standing*, a scan row for exploring it, and
  how many Transports are loading there.
- **Standing**: 0 nothing known yet; 1 *cleared* (fully explored, no enemy or neutral
  cities, kept so over three reviews); 2 *unknown*; 3 *enemy* (enemy cities or Armies seen).
- **The target island**: the enemy island nearest the centre of the cleared islands; **the
  base island**: the cleared island nearest the target.
- **Tallies**: its pieces of each type, how many of its cities build each type, and how many
  islands have each standing. "Enough cities" below means the side's cities number at least
  10 (`ai_limit_10`), or 8 for some ships.
- Per island, the Transport assigned to it; per island, a marker byte; per city, how many
  Armies were sent to take it and from how near, and whether a Bomber has gone for it.

## Production

At the start of its turn and whenever one of its cities asks, it surveys the world (above),
reviews each island's standing, sets cities on islands with more than one enemy city to
build Armies, notes in each Army the island it is on, works out the target and base
islands, and looks at each Transport (counting its Armies aboard; a loading Transport
beside an island decides whether to call that island's Armies).

After a city builds a piece it chooses what the city builds next: Armies while the island
needs them; early in the game a Transport and then a Destroyer for an island with more than
two of something; otherwise a port city builds the ship or Fighter furthest below the share
it aims for (Bombers count for more as the days go by), and an inland city a Bomber, a
Fighter or an Army.

## Moves

A piece **under orders** follows them: it steps the way the path finder chose, turning an
eighth at a time (the same random way) away from closed terrain, the map's edge and its own
pieces; a Fighter turns once at most, and only for a piece it does not take on. A Transport
that has reached the island it was sent to wakes its Armies (or everything at the island's
centre) and waits. A Bomber decides afresh, as an awake one does.

An **awake** piece is moved by its type's routine, which either gives the step at once, gives
the piece go-to orders, or puts it to sleep.

### Armies (`CODE 7 + 0x0A4A`)

- Aboard a Transport: step into a neutral or player 1 city next to it; otherwise land on the
  island the Transport is beside, according to its standing (not on a cleared island; on one
  of no standing only while the side has fewer than five Armies there). Aboard anything else,
  or with no land in reach, sleep.
- On land, the first of these that applies:
  - a neutral or player 1 city next to it: step in;
  - cities to take on its island: head for the nearest city it has explored and does not own,
    of those fewer than three Armies have been sent to (unless an enemy is next to it, when it
    does so only on a coin toss and if the island has enemy cities);
  - an enemy next to it: attack it if an Army takes it on, else get away (two squares);
  - enemy Armies seen on its island: go after one in sight, else explore;
  - an island of no standing or the enemy's, or not fully explored: explore it (a square next
    to unexplored ground; else unexplored land 2–5 squares out in sight of the island's
    centre, [quirk Q17](../quirks.md); else the island's scan, row by row);
  - the nearest adjacent island that is the enemy's, or of no standing with at most eight of
    the side's cities and Armies: go there;
  - a Transport loading for its island: step aboard one next to it, else go to the nearest
    one beside the island ([quirk Q16](../quirks.md));
  - otherwise head for the target island, and sleep if there is no way there.

### Fighters (`CODE 6 + 0x2278`)

- An enemy next to it that a Fighter takes on is attacked.
- A **target**: a spotted player 1 Bomber it can reach this turn with fuel to spare is
  preferred; otherwise the nearest spotted enemy piece it takes on, that it can reach this
  turn (or a Transport) and from which it can still get home.
- With ten fuel or less it goes for a target or heads back: a spotted Transport or Bomber
  within reach, a city of its own next to it, one of its Carriers it can reach, or its
  nearest city; with nowhere to go its moves end.
- With more fuel: a target; or, on its last move next to an enemy, get away; or look round
  (over 13 fuel), or head back.
- In one of its cities it looks for a target, or searches: it looks round within nine
  squares, then goes to one of its Carriers or to a city of its own nearer the base island.
- Every move but an attack or an escape is checked so the Fighter is not blocked by a piece in
  its way.

### Warships (`CODE 6 + 0x35D0`)

Destroyers, Submarines, Carriers and Battleships:

- Damaged in one of its cities (not on an enemy island) with no enemy next to it: sleep, to
  be repaired.
- A spotted enemy next to it (not in a player 1 city): attack it if the ship takes it on and is
  not in port, else get away. Next to a neutral or enemy city: keep away.
- Damaged: make for the nearest of its ports.
- Hunt: a spotted enemy ship, Transport or Bomber within ten squares (a Battleship with none
  goes for an Army on the coast within its moves; a Destroyer, Carrier or Battleship prefers
  a Submarine within its moves).
- With enough cities, go on the attack round the target island; otherwise patrol, now and
  then heading for the target island or the enemy's centre.

A ship sent somewhere by sea goes by the path finder's route, or, when there is none, along
the straight line as far as water allows.

### Transports (`CODE 6 + 0x40B6`)

- Damaged in one of its cities: sleep. Damaged elsewhere: make for port.
- Beside an island not yet cleared: sail with its Armies to an island to land them (one the
  side has no Armies or cities on, or the one it is assigned; with enough cities, the target
  island on odd 30-day spells); empty, go and pick up Armies.
- Beside a cleared island: sail when six Armies are aboard; otherwise, at the island chosen
  for pick-up (the nearest cleared island with at least five of the side's Armies to spare),
  move to the water square touching most of the island and start loading there, waking the
  island's Armies.
- Enemies next to it are escaped; with nowhere to go it goes home to the port nearest the
  cleared islands' centre.

### Bombers (`CODE 6 + 0x1D70`)

A Bomber never strikes where the blast would catch the side's own Armies, ships or cities.

- Next to a player 1 city: strike it (and wake the side's other Bombers).
- Next to an enemy it takes on, on its last move or when the enemy is a Carrier or
  Battleship: strike it; otherwise, on its last move, get away.
- Otherwise choose where to fly: with enough cities (or a marked island), the nearest
  explored player 1 city on a marked island or the target island, within half its fuel;
  failing that a city near the target island or on the base island; without enough cities,
  the side's city farthest from the enemy's centre within safe range
  ([quirk Q18](../quirks.md)); else its nearest city.

## Verification

- `tools/emu/test_ai.py`: each routine above (and its helpers) is captured in real games of
  the original run in the emulator with its computer opponent playing, and the engine's
  version is run on each captured entry state; globals, results and replies match.
- `tools/emu/test_aigame.py`: whole games, Auto Play and against a scripted player, run
  through the engine day by day from the original's state; the globals and the requests that
  reach the human controller match. Four games of 100 days (two under Auto Play, two against
  the scripted player, who lost the second on day 91) match on every day. The scripted
  player's production requests do what the production dialog does to the city (it becomes
  the player's and builds the type chosen), on both sides of the comparison.
