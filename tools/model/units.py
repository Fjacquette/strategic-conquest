"""Unit statistics of Strategic Conquest 3.01, as computed by the original routines.

    moves_per_day()     CODE 4 + 0x11BA
    production_days()   CODE 1 + 0x021C
    new_piece()         CODE 4 + 0x20EE  (initial record of a newly built piece)
    repair_max          maximum strength restored in port (Mover dispatch, CODE 5 + 0x4926..)
"""
ARMY, FIGHTER, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP, BOMBER = range(8)
NAMES = ["Army", "Fighter", "Destroyer", "Submarine", "Carrier", "Transport", "Battleship", "Bomber"]

SURFACE = {ARMY, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP}
TWO_PLAYER_MODES = {1, 2, 3}          # game_mode values that double surface moves, halve build times
FAST_MODES = {1, 2}                   # game_mode values that double repair and halve the Bomber radius divisor

# (full-speed moves, reduced moves, strength at or below which the reduced value applies)
_MOVES = {
    ARMY: (1, 1, None), FIGHTER: (20, 20, None), DESTROYER: (4, 3, 2), SUBMARINE: (3, 2, 1),
    CARRIER: (3, 2, 4), TRANSPORT: (3, 2, 1), BATTLESHIP: (3, 2, 6), BOMBER: (10, 10, None),
}
INITIAL_STRENGTH = {ARMY: 1, FIGHTER: 1, DESTROYER: 4, SUBMARINE: 3, CARRIER: 10, TRANSPORT: 3,
                    BATTLESHIP: 18, BOMBER: 1}
INITIAL_FUEL = {FIGHTER: 20, BOMBER: 30, CARRIER: 0, TRANSPORT: 0}   # Carrier/Transport: cargo count
REPAIR_MAX = {DESTROYER: 4, SUBMARINE: 3, TRANSPORT: 3, CARRIER: 10, BATTLESHIP: 18}
_BUILD = {ARMY: 4, FIGHTER: 6, DESTROYER: 8, SUBMARINE: 10, CARRIER: 14, TRANSPORT: 10, BATTLESHIP: 20}


def trunc_div(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def moves_per_day(ptype, strength, game_mode):
    full, reduced, limit = _MOVES[ptype]
    moves = reduced if (limit is not None and strength <= limit) else full
    if game_mode in TWO_PLAYER_MODES and ptype in SURFACE:
        moves *= 2
    return moves


def production_days(ptype, day, game_mode):
    days = _BUILD[ptype] if ptype != BOMBER else 20 + 5 * trunc_div(day, 70)
    if game_mode in TWO_PLAYER_MODES:
        days = trunc_div(days, 2)
    return days


def bomber_radius(day, game_mode):
    return trunc_div(day - 5, 35 if game_mode in FAST_MODES else 70) & 0x3F


def new_piece(old: bytes, ptype, owner, x, y, day, game_mode):
    """Record written into a slot for a newly built piece. `old` is the slot's previous
    contents: a few bits survive, exactly as in the original."""
    r = bytearray(old)
    w10 = (r[10] << 8) | r[11]
    w10 &= 0xFFFB & 0xFFDF
    r[10], r[11] = w10 >> 8, w10 & 0xFF
    r[10] = (r[10] & 0xF0) | (ptype & 0x0F)
    r[10] = (r[10] & 0xCF) | ((owner & 3) << 4)
    r[7], r[6] = x, y
    r[8] = (r[8] & 0x03) | ((bomber_radius(day, game_mode) & 0x3F) << 2)
    r[3], r[2], r[5], r[4], r[1], r[0] = x, y, x, y, x, y
    r[12] &= 0x3F
    r[11] &= 0xFB
    r[11] = (r[11] & 0x3F) | 0x40
    r[11] &= 0xFE
    w8 = (r[8] << 8) | r[9]
    r[12] = (r[12] & 0xE0) | INITIAL_STRENGTH[ptype]
    if ptype in INITIAL_FUEL:
        w8 = (w8 & 0xFC1F) | (INITIAL_FUEL[ptype] << 5)
    r[8], r[9] = w8 >> 8, w8 & 0xFF
    return bytes(r)
