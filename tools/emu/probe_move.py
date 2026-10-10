"""Probe the original movement rules: run PlayerTurn on small scenarios with scripted moves
and report what the game did.

Usage: python3 -I tools/emu/probe_move.py [scenario-name ...]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "save"))
from harness import Machine  # noqa: E402
from world import World  # noqa: E402
from sc3save import Save, PIECE_TYPES  # noqa: E402

RSRC = os.path.join(HERE, "..", "..", "build", "sc301.rsrc")
TEST_BOX = (36, 54, 18, 22)   # x0, x1, y0, y1: rows 18-22 hold no city in the base save
BASE = os.path.join(HERE, "..", "..", "saves", "3.01", "s01-day4.sav")

ARMY, FIGHTER, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP, BOMBER = range(8)
WATER, NEUTRAL, CITY1, LAND, CITY2 = 0, 1, 2, 3, 4
MSG = {1003: "You will lose the ^0 with that move!", 1004: "The Army drowned in the sea.",
       1007: "You can't go off the edge of the world.", 1015: "Fighter crashed (fuel)",
       1016: "You have captured the City!", 1018: "The ship is full!", 1019: "fell off the ship",
       1032: "attempt to conquer failed", 1033: "You're attacking your ^0.",
       1034: "can't attack at sea with an Army; drowned", 1036: "enemy captured your City",
       1037: "City repelled invasion", 1042: "Bomber crashed (fuel)", 1012: "Your ^0 was lost!"}


def rec(ptype, owner, x, y, strength=None, fuel=0, state=1):
    from_units = {ARMY: 1, FIGHTER: 1, DESTROYER: 4, SUBMARINE: 3, CARRIER: 10, TRANSPORT: 3,
                  BATTLESHIP: 18, BOMBER: 1}
    s = from_units[ptype] if strength is None else strength
    r = bytearray(14)
    r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7] = y, x, y, x, y, x, y, x
    w8 = (fuel & 0x1F) << 5
    r[8], r[9] = w8 >> 8, w8 & 0xFF
    r[10] = ((owner & 3) << 4) | ptype
    r[11] = (state & 3) << 6
    r[12] = s
    return bytes(r)


class Scenario:
    def __init__(self, name, terrain, pieces, moves, player=1, day=5, keys=()):
        self.name, self.terrain, self.pieces, self.moves = name, terrain, pieces, moves
        self.player, self.day = player, day

    def run(self, verbose=True):
        m = Machine(RSRC)
        w = World(m, Save.load(BASE))
        m.write_global(-0x2D08, self.day.to_bytes(2, "big"))
        # the test area (TEST_BOX) holds no city in the base save; make it all water,
        # then apply the scenario's terrain
        cities_now = m.read_global(-0x385E, 460)
        x0, x1, y0, y1 = TEST_BOX
        for c in range(1, 46):
            cy, cx = cities_now[c * 10], cities_now[c * 10 + 1]
            assert not (x0 <= cx <= x1 and y0 <= cy <= y1), f"city {c} inside the test box"
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                w.set_terrain(x, y, WATER)
        for (x, y), v in self.terrain.items():
            w.set_terrain(x, y, v)
        # neutralise the save's cities and pieces so only the scenario acts
        cities = bytearray(m.read_global(-0x385E, 460))
        for c in range(1, 46):
            cities[c * 10 + 5] = 99          # no production during the probe
        used_cities = set()
        for (x, y), v in self.terrain.items():
            if v in (CITY1, CITY2, NEUTRAL):
                c = next(i for i in range(1, 46) if i not in used_cities and cities[i * 10 + 4] == 0)
                used_cities.add(c)
                ox, oy = cities[c * 10 + 1], cities[c * 10]
                w.set_terrain(ox, oy, LAND)
                cities[c * 10:c * 10 + 10] = bytes([y, x, y, x, {NEUTRAL: 0, CITY1: 1, CITY2: 2}[v], 99, y, x, 0, 1])
        m.write_global(-0x385E, cities)
        raw = bytearray(14 * 451)
        for i in range(1, 451):
            raw[i * 14 + 10] = 9
        for i, p in enumerate(self.pieces, start=1):
            raw[i * 14:i * 14 + 14] = p
        m.write_global(-0x5138, raw)
        m.write_global(-0x388E, len(self.pieces).to_bytes(2, "big"))
        w.rebuild_hash()
        # moves: list of directions for the first scenario piece (the "actor"), or a dict
        # {(type, x, y): [directions]}. Requests are matched by the piece's type and current
        # position, tracked as it moves; every other piece stays put.
        p0 = self.pieces[0]
        script = self.moves if isinstance(self.moves, dict) else {(p0[10] & 15, p0[7], p0[6]): list(self.moves)}
        tracks = {key: [(key[1], key[2]), list(dirs), key[0]] for key, dirs in script.items()}
        log = []

        def ctl(r):
            if r.code == 5:
                idx = r.raw[8] << 8 | r.raw[9]
                pos = (r.raw[5], r.raw[4])
                ptype = w.piece(idx)[10] & 15
                d = (0, 0)
                for start, t in tracks.items():
                    moved_to = (t[0][0] + t[3][0], t[0][1] + t[3][1]) if len(t) > 3 else t[0]
                    if t[2] == ptype and pos in (t[0], moved_to) and t[1]:
                        d = t[1].pop(0)
                        t[0] = pos
                        t[3:] = [d]
                        break
                if d != (0, 0):
                    log.append(f"move piece {idx} at {pos}: {d}")
                r.reply_direction(*d)
        w.controller = ctl
        before = [w.piece(i) for i in range(1, len(self.pieces) + 1)]
        try:
            m.call(5, 0x42D4, args=[("b", self.player), ("b", 0)], max_insns=80_000_000)
            status = "ok"
        except Exception as e:  # noqa: BLE001
            status = f"STOPPED: {e}"
        if verbose:
            print(f"=== {self.name}: {status}")
            print("   requests:", [r.code for r in w.requests])
            for line in log:
                print("  ", line)
            print("   messages:", [MSG.get(x, x) for x in w.messages])
            n = w.piece_count()
            for i in range(1, max(n, len(before)) + 1):
                after = w.piece(i)
                t, o = after[10] & 15, (after[10] >> 4) & 3
                b = before[i - 1] if i <= len(before) else None
                tag = "" if b == after else "  CHANGED"
                print(f"   #{i} {PIECE_TYPES[t]:10} owner {o} at ({after[7]},{after[6]}) str {after[12] & 31} "
                      f"w8 {after[8]:02x}{after[9]:02x} b11 {after[11]:02x}{tag}")
            print("   terrain at tested squares:", {k: w.terrain(*k) for k in self.terrain})
        return w


def land_strip(x0, x1, y):
    return {(x, y): LAND for x in range(x0, x1 + 1)}


SCENARIOS = {
    "army_land": Scenario("Army steps east on land", land_strip(38, 41, 20),
                          [rec(ARMY, 1, 39, 20)], [(1, 0)]),
    "army_water": Scenario("Army steps into empty water", land_strip(38, 39, 20),
                           [rec(ARMY, 1, 39, 20)], [(1, 0)]),
    "army_drown": Scenario("Army steps into water twice (repeat confirms)", land_strip(38, 39, 20),
                           [rec(ARMY, 1, 39, 20)], [(1, 0), (1, 0)]),
    "army_board": Scenario("Army boards own Transport at sea", land_strip(38, 39, 20),
                           [rec(ARMY, 1, 39, 20), rec(TRANSPORT, 1, 40, 20)], [(1, 0)]),
    "army_full": Scenario("Army onto a full Transport (6 aboard)", land_strip(38, 39, 20),
                          [rec(TRANSPORT, 1, 40, 20, fuel=6)] + [rec(ARMY, 1, 40, 20) for _ in range(6)]
                          + [rec(ARMY, 1, 39, 20)], {(ARMY, 39, 20): [(1, 0), (1, 0)]}),
    "army_attack": Scenario("Army attacks enemy Army on land", land_strip(38, 41, 20),
                            [rec(ARMY, 1, 39, 20), rec(ARMY, 2, 40, 20)], [(1, 0)]),
    "army_neutral_city": Scenario("Army into neutral city (day 5)", {**land_strip(38, 39, 20), (40, 20): NEUTRAL},
                                  [rec(ARMY, 1, 39, 20)], [(1, 0)]),
    "army_own_city": Scenario("Army into own city", {**land_strip(38, 39, 20), (40, 20): CITY1},
                              [rec(ARMY, 1, 39, 20)], [(1, 0)]),
    "army_stack": Scenario("Army onto own Army on land", land_strip(38, 41, 20),
                           [rec(ARMY, 1, 39, 20), rec(ARMY, 1, 40, 20)], [(1, 0)]),
    "ship_land": Scenario("Destroyer steps onto land", land_strip(41, 42, 20),
                          [rec(DESTROYER, 1, 40, 20)], [(1, 0), (0, 0)]),
    "ship_own_city": Scenario("Destroyer into own city", {(41, 20): CITY1},
                              [rec(DESTROYER, 1, 40, 20)], [(1, 0)]),
    "ship_moves": Scenario("Destroyer 4 steps at sea", {},
                           [rec(DESTROYER, 1, 40, 20)], [(1, 0), (1, 0), (1, 0), (1, 0)]),
    "transport_carry": Scenario("Transport with 2 Armies moves 2 steps", {},
                                [rec(TRANSPORT, 1, 40, 20, fuel=2), rec(ARMY, 1, 40, 20), rec(ARMY, 1, 40, 20)],
                                [(1, 0), (1, 0), (0, 0)]),
    "fighter_fuel": Scenario("Fighter with 2 fuel moves 3 steps", {},
                             [rec(FIGHTER, 1, 40, 20, fuel=2)], [(1, 0), (1, 0), (1, 0)]),
    "fighter_city": Scenario("Fighter (5 fuel) lands in own city", {(41, 20): CITY1},
                             [rec(FIGHTER, 1, 40, 20, fuel=5)], [(1, 0), (0, 0)]),
    "fighter_carrier": Scenario("Fighter lands on own Carrier", {},
                                [rec(FIGHTER, 1, 40, 20, fuel=5), rec(CARRIER, 1, 41, 20)], [(1, 0), (0, 0)]),
    "army_unload": Scenario("Army aboard a Transport steps onto land", land_strip(41, 42, 20),
                            [rec(TRANSPORT, 1, 40, 20, fuel=1), rec(ARMY, 1, 40, 20, state=2)], {(ARMY, 40, 20): [(1, 0)]}),
    "ship_attack": Scenario("Destroyer attacks enemy Transport", {},
                            [rec(DESTROYER, 1, 40, 20), rec(TRANSPORT, 2, 41, 20)], [(1, 0)]),
    "army_enemy_city_defended": Scenario("Army into enemy city with an enemy Army in it",
                                         {**land_strip(38, 39, 20), (40, 20): CITY2},
                                         [rec(ARMY, 1, 39, 20), rec(ARMY, 2, 40, 20)], [(1, 0)]),
    "army_enemy_city_empty": Scenario("Army into empty enemy city (day 80)", {**land_strip(38, 39, 20), (40, 20): CITY2},
                                      [rec(ARMY, 1, 39, 20)], [(1, 0)], day=80),
    "ship_enemy_city": Scenario("Destroyer into empty enemy city", {(41, 20): CITY2},
                                [rec(DESTROYER, 1, 40, 20)], [(1, 0)]),
    "fighter_attack": Scenario("Fighter attacks enemy Army on land", land_strip(41, 41, 20),
                               [rec(FIGHTER, 1, 40, 20, fuel=10), rec(ARMY, 2, 41, 20)], [(1, 0)]),
    "army_edge": Scenario("Army at x=2 steps west onto the edge", {(2, 20): LAND, (3, 20): LAND},
                          [rec(ARMY, 1, 2, 20)], [(-1, 0)]),
}


def main(argv):
    names = argv[1:] or list(SCENARIOS)
    for n in names:
        SCENARIOS[n].run()


if __name__ == "__main__":
    main(sys.argv)
