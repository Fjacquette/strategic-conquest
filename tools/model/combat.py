"""Reference model of Strategic Conquest 3.01 combat (battle segment, CODE 3).

Mirrors the original routines step by step, including every draw from the game PRNG,
so it can be checked against the original code run in tools/emu/harness.py.

    attack()        CODE 3 + 0x0520  one attack, with all side effects
    resolve()       CODE 3 + 0x0004  one roll on the combat results table
    apply_damage()  CODE 3 + 0x0492  damage or destroy the loser
    kill_stack()    CODE 3 + 0x0374  destroy a Transport/Carrier and everything with it
    weakened()      CODE 4 + 0x1110  per-type "weakened" threshold
"""
from dataclasses import dataclass

# Piece type codes
ARMY, FIGHTER, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP, BOMBER = range(8)
REMOVED, EMPTY = 8, 9

# Terrain codes
WATER, CITY_NEUTRAL, CITY_P1, LAND, CITY_P2, EDGE = 0, 1, 2, 3, 4, 5

SHIPS = {DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP}
AIRCRAFT = {FIGHTER, BOMBER}
WARSHIPS = {DESTROYER, SUBMARINE, CARRIER, BATTLESHIP}          # ships except Transport
FIGHTER_BONUS_TARGETS = {SUBMARINE, TRANSPORT, BOMBER}
CITY_TERRAIN = {CITY_NEUTRAL, CITY_P1, CITY_P2}
OWNED_CITY = {CITY_P1, CITY_P2}
LAND_OR_NEUTRAL_CITY = {CITY_NEUTRAL, LAND}
STACK_CARRIERS = {CARRIER, TRANSPORT}

# Combat results table (EMPINIT, CODE 2 + 0x0004): CRT[die-1][column-1]
ATTACKER_WINS, ATTACKER_LOSES, REPELLED = 0, 1, 2
CRT = [
    [1, 1, 1, 1, 1, 2, 2],
    [1, 1, 1, 1, 2, 2, 0],
    [1, 1, 1, 2, 2, 0, 0],
    [1, 1, 2, 2, 0, 0, 0],
    [1, 2, 2, 0, 0, 0, 0],
    [1, 2, 0, 0, 0, 0, 0],
]

# "Weakened" thresholds (CODE 4 + 0x1110): strength at or below this value
WEAK_THRESHOLD = {ARMY: 0, FIGHTER: 0, DESTROYER: 2, SUBMARINE: 2, CARRIER: 7,
                  TRANSPORT: 2, BATTLESHIP: 10, BOMBER: 0}

KEY_OPTION, KEY_W, KEY_L = 0x3A, 0x0D, 0x25


def to_s16(v):
    v &= 0xFFFF
    return v - 0x10000 if v & 0x8000 else v


def trunc_div(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


class GamePRNG:
    """Game PRNG (CODE 1 + 0x2AFA); state is the 32-bit global at A5-$127C."""

    def __init__(self, seed):
        self.seed = seed & 0xFFFFFFFF

    def next(self):
        self.seed = ((((self.seed + 1) & 0x7FFF) * 977) + 113) & 0xFFFFFFFF
        r = to_s16(self.seed << 7)
        return -32767 if r == -32768 else r


class Pieces:
    """View over the 14-byte piece records (A5-$5138)."""

    def __init__(self, raw: bytearray, count: int):
        self.raw = raw
        self.count = count

    def rec(self, i):
        return Piece(self.raw, i * 14)


@dataclass
class Piece:
    raw: bytearray
    base: int

    @property
    def type(self): return self.raw[self.base + 10] & 0x0F
    @type.setter
    def type(self, v): self.raw[self.base + 10] = (self.raw[self.base + 10] & 0xF0) | (v & 0x0F)
    @property
    def owner(self): return (self.raw[self.base + 10] >> 4) & 3
    @owner.setter
    def owner(self, v): self.raw[self.base + 10] = (self.raw[self.base + 10] & 0xCF) | ((v & 3) << 4)
    @property
    def strength(self): return self.raw[self.base + 12] & 0x1F
    @strength.setter
    def strength(self, v): self.raw[self.base + 12] = (self.raw[self.base + 12] & 0xE0) | (v & 0x1F)
    @property
    def x(self): return self.raw[self.base + 7]
    @property
    def y(self): return self.raw[self.base + 6]
    @property
    def state_bits(self): return (self.raw[self.base + 12] >> 6) & 3

    def swap_with(self, other):
        a = bytes(self.raw[self.base:self.base + 14])
        self.raw[self.base:self.base + 14] = other.raw[other.base:other.base + 14]
        other.raw[other.base:other.base + 14] = a


def weakened(ptype, strength):
    return strength <= WEAK_THRESHOLD.get(ptype, -1)


def column(att, dfn, terrain_at_defender):
    ratio = trunc_div(att.strength * 10, dfn.strength)
    if ratio <= 1:
        col = 1
    elif ratio == 2:
        col = 2
    elif ratio <= 5:
        col = 3
    elif ratio <= 10:
        col = 4
    elif ratio <= 20:
        col = 5
    elif ratio <= 40:
        col = 6
    else:
        col = 7
    a, d = att.type, dfn.type
    if a == DESTROYER and d == TRANSPORT:
        col += 2
    if a == FIGHTER and d in FIGHTER_BONUS_TARGETS:
        col += 1
    if a == SUBMARINE and d in SHIPS:
        col += 4
    if a == DESTROYER and d == SUBMARINE:
        col += 4
    if a == ARMY and d in WARSHIPS:
        col -= 1
    if a == BOMBER and d in AIRCRAFT:
        col -= 1
    if a == BOMBER and d in SHIPS:
        col = 1
    if terrain_at_defender in CITY_TERRAIN and d in SHIPS:
        col += 4
    return max(1, min(7, col))


def roll_die(prng):
    q = trunc_div(prng.next(), 113)
    return abs(q) % 6 + 1


def resolve(att, dfn, terrain_at_defender, prng, keys=frozenset()):
    if KEY_OPTION in keys and KEY_W in keys:
        return ATTACKER_WINS
    if KEY_OPTION in keys and KEY_L in keys:
        return ATTACKER_LOSES
    col = column(att, dfn, terrain_at_defender)
    return CRT[roll_die(prng) - 1][col - 1]


def kill_piece(pieces, idx):
    """CODE 4 + 0x27EE: mark the slot 'removed' and clear its owner (strength is left)."""
    p = pieces.rec(idx)
    p.type = REMOVED
    p.owner = 0


def kill_keep_owner(pieces, idx, owner_source):
    """CODE 3 + 0x0332: kill slot idx, then rewrite owner_source's owner bits."""
    saved = owner_source.owner
    kill_piece(pieces, idx)
    owner_source.owner = saved


def kill_stack(pieces, loser, terrain):
    """CODE 3 + 0x0374."""
    for i in range(1, pieces.count + 1):
        p = pieces.rec(i)
        if p.x == loser.x and p.y == loser.y:
            if loser.type in STACK_CARRIERS and terrain(loser.x, loser.y) in OWNED_CITY:
                kill_keep_owner(pieces, i, loser)
                return
            saved = p.owner
            kill_piece(pieces, i)
            p.owner = saved


def apply_damage(pieces, loser, loser_idx, damage, terrain):
    """CODE 3 + 0x0492."""
    if loser.strength <= damage:
        if loser.type in STACK_CARRIERS:
            kill_stack(pieces, loser, terrain)
        else:
            kill_keep_owner(pieces, loser_idx, loser)
    else:
        loser.strength = loser.strength - damage


def battleship_damage(strength, stale):
    if 1 <= strength <= 6:
        return 3
    if 7 <= strength <= 10:
        return 4
    if 11 <= strength <= 14:
        return 5
    if 15 <= strength <= 18:
        return 6
    return stale


SURFACE = {ARMY, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP}
CARRIER_STACK_TYPES = {FIGHTER, CARRIER}


def blast_radius(bomber):
    """Bits 2-7 of byte 8 of the Bomber's record."""
    return (bomber.raw[bomber.base + 8] >> 2) & 0x3F


def kill_types_at(pieces, x, y, types):
    """CODE 4 + 0x0E62: kill every piece at (x, y) whose type is in `types`."""
    for i in range(1, pieces.count + 1):
        p = pieces.rec(i)
        if p.x == x and p.y == y and p.type in types:
            p.owner = 0
            p.type = REMOVED


def bomber_blast(pieces, bomber, cities_raw, city_count, terrain, set_terrain):
    """CODE 3 + 0x0A30: everything within the blast radius (Chebyshev distance) is hit.
    Surface pieces are destroyed (a Carrier together with its Fighters); aircraft are
    destroyed only when parked in an owned city; cities in range become neutral."""
    radius = blast_radius(bomber)
    bx, by = bomber.x, bomber.y
    for i in range(1, pieces.count + 1):
        p = pieces.rec(i)
        if max(abs(bx - p.x), abs(by - p.y)) > radius:
            continue
        if p.type in SURFACE:
            if p.type == CARRIER:
                kill_types_at(pieces, p.x, p.y, CARRIER_STACK_TYPES)
            else:
                kill_piece(pieces, i)
        elif p.type in AIRCRAFT and terrain(p.x, p.y) in OWNED_CITY:
            kill_piece(pieces, i)
    for c in range(1, city_count + 1):
        base = c * 10
        cy, cx = cities_raw[base], cities_raw[base + 1]
        if max(abs(cx - bx), abs(cy - by)) <= radius:
            set_terrain(cx, cy, CITY_NEUTRAL)
            cities_raw[base + 4] = 0
            cities_raw[base + 5] = 0
            cities_raw[base + 8] = 0


def attack(pieces, a_idx, b_idx, w8, terrain, prng, keys=frozenset(), stale_d7=0):
    """CODE 3 + 0x0520. Returns the Boolean result (TRUE only when a Submarine is lost
    attacking a target on land or in a neutral city)."""
    A, B = pieces.rec(a_idx), pieces.rec(b_idx)
    t_b = terrain(B.x, B.y)
    if A.type == ARMY and B.type == SUBMARINE and t_b == WATER:
        return False
    if A.type == TRANSPORT:
        return False
    if A.type == SUBMARINE and B.type in AIRCRAFT:
        return False
    if A.type == SUBMARINE and t_b in LAND_OR_NEUTRAL_CITY:
        kill_keep_owner(pieces, a_idx, A)
        return True
    swapped = A.type in SHIPS and B.type == SUBMARINE and w8 == 0
    if swapped:
        A.swap_with(B)
    outcome = resolve(A, B, terrain(B.x, B.y), prng, keys)
    if outcome == ATTACKER_WINS:
        if A.type == SUBMARINE:
            dmg = 1 if B.type == DESTROYER else A.strength * 3
        elif A.type == BATTLESHIP:
            dmg = battleship_damage(A.strength, stale_d7)
        else:
            dmg = 2 if weakened(A.type, A.strength) else 3
        apply_damage(pieces, B, b_idx, dmg, terrain)
    elif outcome == ATTACKER_LOSES:
        if B.type != TRANSPORT and (A.type != FIGHTER or B.type != SUBMARINE):
            dmg = 2 if weakened(B.type, B.strength) else 3
            apply_damage(pieces, A, a_idx, dmg, terrain)
    if swapped:
        A.swap_with(B)
    for p in (A, B):
        if p.strength > 1:
            r = prng.next()
            if abs(r) % 10 < 5:
                p.strength = p.strength - 1
    return False
