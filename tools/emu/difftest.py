"""Shared setup for differential tests of engine routines against the original code.

    d = Diff()
    world = d.random_world(rng)            # random but plausible game state in the emulator
    ok = d.check("label", lambda: d.m.call(...), "engineFn", [args])

`check` snapshots the globals, runs the original routine, runs the engine routine on the
snapshot through the Node bridge, and compares the results and the globals images (minus
globals that only the user interface uses).
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from harness import A5, Machine  # noqa: E402
from jsbridge import Bridge, GLOBALS_SIZE, global_namer, read_globals, write_globals  # noqa: E402

RSRC = os.path.join(HERE, "..", "..", "build", "sc301.rsrc")

PIECES, PIECE_COUNT, HASH, CITIES, TERRAIN = -0x5138, -0x388E, -0x5592, -0x385E, -0x27D2
PLAYER_MAPS, GAME_MODE, DAY, CITY_COUNT = -0x2CD8, -0x1E71, -0x2D08, -0x1E4F
OWN_CITY_CODE = -0x1284
WATER, NEUTRAL, CITY_P1, LAND, CITY_P2, EDGE = 0, 1, 2, 3, 4, 5
ARMY, FIGHTER, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP, BOMBER = range(8)
SHIPS = (DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP)

# Globals written only by user-interface code (message parameters, battle report list).
UI_GLOBALS = [(-0x1386, 4), (-0x1920, 4)]


class World:
    """Python-side description of a generated state, for picking test arguments."""

    def __init__(self):
        self.terrain = {}
        self.pieces = []          # (index, type, owner, x, y)
        self.cities = []          # (x, y, owner)
        self.box = None

    def t(self, x, y):
        return self.terrain.get((x, y), WATER if 1 < x < 80 and 1 < y < 60 else EDGE)


class Diff:
    def __init__(self):
        self.m = Machine(RSRC)
        m = self.m
        m.call(2, 0x2DEA)
        m.call(2, 0x2CE2, args=[("w", 1)], result="l")
        m.call(2, 0x0004)
        self.js = Bridge()
        self.names = global_namer()
        self.count = 0
        self.ignore = set()
        for off, size in UI_GLOBALS:
            for i in range(size):
                self.ignore.add(off + i)

    # ----- state generation -----
    def random_world(self, rng, box=None, n_pieces=None):
        """Fill terrain, cities, pieces, player maps and a few scalars with random but
        plausible values concentrated in a small box, then compact the piece table with
        the original routine (which also builds the position hash)."""
        m = self.m
        w = World()
        x0, y0 = box or (rng.randint(2, 66), rng.randint(2, 46))
        w.box = (x0, y0, x0 + 12, y0 + 12)
        nib = [WATER] * 4800
        for x in range(1, 81):
            for y in range(1, 61):
                if x in (1, 80) or y in (1, 60):
                    nib[(x - 1) * 60 + (y - 1)] = EDGE
        land_frac = rng.choice([0.2, 0.4, 0.6])
        for x in range(x0, x0 + 13):
            for y in range(y0, y0 + 13):
                if 1 < x < 80 and 1 < y < 60 and rng.random() < land_frac:
                    nib[(x - 1) * 60 + (y - 1)] = LAND
        land = [(x, y) for x in range(x0, x0 + 13) for y in range(y0, y0 + 13)
                if 1 < x < 80 and 1 < y < 60 and nib[(x - 1) * 60 + (y - 1)] == LAND]
        rng.shuffle(land)
        cities = land[:rng.randint(0, min(10, len(land)))]
        craw = bytearray(460)
        for i, (x, y) in enumerate(cities, start=1):
            owner = rng.choice([0, 1, 2])
            nib[(x - 1) * 60 + (y - 1)] = 1 << owner
            rec = bytearray(rng.getrandbits(8) for _ in range(10))
            rec[0], rec[1], rec[2], rec[3], rec[6], rec[7] = y, x, y, x, y, x
            if rng.random() < 0.3:
                rec[0], rec[1] = rng.randint(y0, y0 + 12), rng.randint(x0, x0 + 12)
            if rng.random() < 0.3:
                rec[2], rec[3] = rng.randint(y0, y0 + 12), rng.randint(x0, x0 + 12)
            rec[4] = owner
            craw[10 * i:10 * i + 10] = rec
            w.cities.append((x, y, owner))
        tb = bytearray(2400)
        for i in range(0, 4800, 2):
            tb[i // 2] = (nib[i] & 0xF) | ((nib[i + 1] & 0xF) << 4)
        m.write_global(TERRAIN, tb)
        m.write_global(CITIES, craw)
        m.write_global(CITY_COUNT, bytes([len(cities)]))
        for x in range(1, 81):
            for y in range(1, 61):
                w.terrain[(x, y)] = nib[(x - 1) * 60 + (y - 1)]

        n = n_pieces if n_pieces is not None else rng.randint(1, 60)
        raw = bytearray(14 * 451)
        for i in range(1, 451):
            raw[14 * i + 10] = 9
        water = [(x, y) for x in range(x0, x0 + 13) for y in range(y0, y0 + 13)
                 if 1 < x < 80 and 1 < y < 60 and w.t(x, y) == WATER]
        anywhere = [(x, y) for x in range(x0, x0 + 13) for y in range(y0, y0 + 13) if 1 < x < 80 and 1 < y < 60]
        placed = []
        for i in range(1, n + 1):
            ptype = rng.choice([0, 0, 0, 1, 1, 2, 3, 4, 5, 5, 6, 7])
            owner = rng.choice([1, 2])
            own_city = [(x, y) for (x, y, o) in w.cities if o == owner]
            if placed and rng.random() < 0.35:
                x, y = rng.choice(placed)
            elif ptype == ARMY:
                x, y = rng.choice(land + own_city) if land or own_city else rng.choice(anywhere)
            elif ptype in SHIPS:
                x, y = rng.choice(water + own_city) if water or own_city else rng.choice(anywhere)
            else:
                x, y = rng.choice(anywhere)
            placed.append((x, y))
            rec = bytearray(rng.getrandbits(8) for _ in range(14))
            for k in (0, 2, 4):
                if rng.random() < 0.6:
                    rec[k], rec[k + 1] = rng.randint(y0, y0 + 12), rng.randint(x0, x0 + 12)
                else:
                    rec[k], rec[k + 1] = y, x
            rec[6], rec[7] = y, x
            rec[10] = (rec[10] & 0xC0) | (owner << 4) | ptype
            rec[12] = (rec[12] & 0xE0) | rng.randint(1, 18)
            w8 = (rng.getrandbits(6) << 10) | (rng.randint(0, 20) << 5) | rng.randint(0, 6)
            rec[8], rec[9] = w8 >> 8, w8 & 0xFF
            if rng.random() < 0.05:
                rec[10] = (rec[10] & 0xF0) | 8
            raw[14 * i:14 * i + 14] = rec
            w.pieces.append((i, ptype, owner, x, y))
        if rng.random() < 0.5:
            raw[0:14] = bytes(14)
        m.write_global(PIECES, raw)
        m.write_global(PIECE_COUNT, n.to_bytes(2, "big"))
        maps = bytearray(rng.getrandbits(8) for _ in range(1284))
        maps[640], maps[641] = rng.choice([0, 1]), 0
        maps[642 + 640], maps[642 + 641] = rng.choice([0, 1]), 0
        m.write_global(PLAYER_MAPS, maps)
        m.write_global(GAME_MODE, bytes([rng.choice([0, 1, 3])]))
        m.write_global(DAY, rng.randint(1, 150).to_bytes(2, "big"))
        m.call(4, 0x259A)
        w.pieces = self.read_pieces()
        return w

    def read_pieces(self):
        m = self.m
        n = int.from_bytes(m.read_global(PIECE_COUNT, 2), "big")
        out = []
        for i in range(1, n + 1):
            r = m.read_global(PIECES + 14 * i, 14)
            out.append((i, r[10] & 0xF, (r[10] >> 4) & 3, r[7], r[6]))
        return out

    # ----- comparison -----
    def check(self, label, orig, fn, args, result_map=None):
        """Run `orig()` in the emulator and engine function `fn(*args)` on the same globals;
        compare results and globals. Returns True when they match."""
        before = read_globals(self.m)
        expect = orig()
        after = read_globals(self.m)
        result, mem, log = self.js.call(fn, before, args)
        if result_map:
            result = result_map(result)
        self.count += 1
        problems = []
        if result != expect:
            problems.append(f"result: original {expect!r}, engine {result!r}")
        for i, (a, b) in enumerate(zip(after, mem)):
            off = i - GLOBALS_SIZE
            if a != b and off not in self.ignore:
                name = self.names(off)
                problems.append(f"A5{off:+#06x}{' ' + name if name else ''}: original {a:#04x}, engine {b:#04x}")
                if len(problems) > 12:
                    problems.append("...")
                    break
        if problems:
            print(f"MISMATCH {label}: {fn}{tuple(args)}")
            for p in problems:
                print("   ", p)
            return False
        return True

    def restore(self, data):
        write_globals(self.m, data)

    def snapshot(self):
        return read_globals(self.m)


def bool_result(r):
    return 1 if r else 0
