"""Map generation against real games: regenerate the world of each saved game from its seed
and skill level, with the original routine (CODE 2 + 0x1CDC, on the QuickDraw traps of
quickdraw.py) and with engine/src/mapgen.ts, and compare both with the saved terrain and
cities.

Usage: python3 -I tools/emu/test_savemaps.py <file.sav>...

The saves come from the original running on a Mac emulator with Apple's QuickDraw, so a
match shows that the reimplemented QuickDraw produces the same islands. Terrain is compared
with city cells merged (their codes change with the owner); cities by position and island.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "save"))
from difftest import Diff  # noqa: E402
from jsbridge import read_globals  # noqa: E402
from quickdraw import QuickDraw  # noqa: E402
from sc3save import Save  # noqa: E402

GAME_SEED, SKILL, TERRAIN, CITIES, CITY_COUNT = -0x1E70, -0x2CE6, -0x27D2, -0x385E, -0x1E4F
CITY_CODES = (1, 2, 4)


def cells(terrain_bytes):
    """Terrain codes by (x, y), with every city as code 1."""
    out = {}
    for x in range(1, 81):
        for y in range(1, 61):
            i = (x - 1) * 60 + (y - 1)
            t = (terrain_bytes[i >> 1] >> ((i & 1) * 4)) & 0x0F
            out[(x, y)] = 1 if t in CITY_CODES else t
    return out


def city_sites(cities_bytes, count):
    """(x, y, island) of cities 1..count."""
    return [(cities_bytes[10 * i + 7], cities_bytes[10 * i + 6], cities_bytes[10 * i + 9])
            for i in range(1, count + 1)]


def compare(label, terrain, cities, save):
    problems = []
    want_t = cells(save.raw("terrain"))
    got_t = cells(terrain)
    diff = [k for k in want_t if want_t[k] != got_t[k]]
    if diff:
        problems.append(f"{len(diff)} terrain cells differ, e.g. " +
                        ", ".join(f"({x},{y}) saved {want_t[(x, y)]} got {got_t[(x, y)]}" for x, y in diff[:5]))
    want_c = city_sites(save.raw("cities"), 45)
    got_c = city_sites(cities, 45)
    if want_c != got_c:
        first = next(i for i in range(45) if want_c[i] != got_c[i])
        problems.append(f"city {first + 1}: saved {want_c[first]}, got {got_c[first]}")
    print(f"{label}: {'match' if not problems else 'MISMATCH'}")
    for p in problems:
        print("   ", p)
    return not problems


def run(paths):
    d = Diff()
    qd = QuickDraw(d.m)
    qd.install()
    mark = d.m.heap_next
    ok = True
    for path in paths:
        save = Save.load(path)
        name = os.path.basename(path)
        print(f"{name}: seed {save.seed:#010x}, skill {save.skill}, day {save.day}")
        d.m.heap_next = mark
        qd.reset()
        d.m.write_global(GAME_SEED, save.raw("seed"))
        d.m.write_global(SKILL, save.raw("skill"))
        before = read_globals(d.m)
        d.m.call(2, 0x1CDC, result="b", max_insns=500_000_000)
        ok &= compare("  original", d.m.read_global(TERRAIN, 2400), d.m.read_global(CITIES, 460), save)
        _, mem, _ = d.js.call("generateMap", before, [])
        base = len(mem)
        ok &= compare("  engine  ", mem[base + TERRAIN:base + TERRAIN + 2400],
                      mem[base + CITIES:base + CITIES + 460], save)
    return ok


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(0 if run(sys.argv[1:]) else 1)
