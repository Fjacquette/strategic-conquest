"""Differential test: engine/src/mapgen.ts (map generation) against the original's
CODE 2 + 0x1CDC and its island outline routine (+0x0630).

Usage: python3 -I tools/emu/test_mapgen.py [cases] [seed] [--verbose]

The original runs with the QuickDraw polygon and region traps of quickdraw.py. The two
QuickDraw implementations (engine/src/quickdraw.ts and quickdraw.py) are compared directly on
random lines and on the regions of the outlines, since a one-pixel difference in a region
seldom changes which cells are land. Outlines are compared point by point; whole maps through
the globals image (terrain, island map, cities, island tables, both random seeds) and the
outline of every island. The polygon handles the original keeps at A5-$1E36 are heap
addresses and are not compared. Some maps use seeds whose first QuickDraw Random() is 0, the
edge case of the left-right mirroring of the home islands.

Whether the QuickDraw implementations agree with Apple's is checked against maps from real
games (test_savemaps.py).
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff  # noqa: E402
from harness import TrapError  # noqa: E402
from quickdraw import QuickDraw, bbox, canonical, put_line  # noqa: E402

GAME_SEED, SKILL, QD_RANDSEED = -0x1E70, -0x2CE6, -0x23A
ISLAND_POLYS = -0x1E36          # PolyHandle per island 1-15
TERRAIN, ISLAND_MAP, ISLAND_CENTERS, ISLAND_CITIES = -0x27D2, -0x3672, -0x2D06, -0x386E
CITIES_MADE, CITY_COUNT, ISLAND_COUNT = -0x1E3A, -0x1E4F, -0x1E50
LAND = 3
# Globals map generation writes or reads, filled with stale data before each case.
STALE = [(-0x27D2, 2400), (-0x3672, 2400), (-0x385E, 460), (-0x3692, 32), (-0x386E, 16),
         (-0x2D06, 32), (-0x1E3A, 2), (-0x1E4F, 1), (-0x1E50, 1), (-0x1E44, 10), (-0x1E4E, 10)]


M31 = 0x7FFFFFFF


def fresh_heap(d, qd, mark):
    d.m.heap_next = mark
    qd.reset()


def zero_draw_seed(rng):
    """A game seed whose first QuickDraw Random() is 0 (low word of the new seed 0 or $8000)."""
    s1 = (rng.randint(1, 0x7FFE) << 16) | rng.choice([0, 0x8000])
    return s1 * pow(16807, -1, M31) % M31


def flat(points):
    return [c for p in points for c in p]


def region_of(outline):
    raw = []
    for (h1, v1), (h2, v2) in zip(outline, outline[1:]):
        put_line(raw, h1, v1, h2, v2)
    pts = canonical(raw)
    return [flat(pts), list(bbox(pts))]


def line_cases(d, rng, n):
    """putLine in the engine against quickdraw.py, including the slopes PutLine treats
    specially (vertical, horizontal, 45 degrees either way, steeper and shallower)."""
    bad = 0
    for i in range(n):
        h1, v1 = rng.randint(-200, 1500), rng.randint(-200, 900)
        kind = i % 6
        dv = rng.randint(-120, 120)
        dh = (0, dv, -dv, rng.randint(-3, 3), rng.randint(-400, 400), dv * rng.randint(2, 5))[kind]
        if kind == 3:
            dv = 0 if i % 12 == 3 else dv
        args = [h1, v1, h1 + dh, v1 + dv]
        expect = []
        put_line(expect, *args)
        got, _, _ = d.js.call("putLine", d.snapshot(), args)
        if got != flat(expect):
            bad += 1
            print(f"MISMATCH putLine{tuple(args)}")
            print("    quickdraw.py", flat(expect))
            print("    engine      ", got)
            if bad > 5:
                break
    return bad


def outline_cases(d, qd, mark, rng, n, verbose):
    m = d.m
    bad = 0
    for i in range(n):
        fresh_heap(d, qd, mark)
        cx, cy = rng.randint(-5, 85), rng.randint(-5, 65)
        size = rng.randint(1, 8)
        rough = rng.randint(40, 260)
        m.write_global(QD_RANDSEED, rng.getrandbits(31).to_bytes(4, "big"))
        handle = None

        def orig():
            nonlocal handle
            handle = m.call(2, 0x0630, args=[("w", ((cy & 0xFF) << 8) | (cx & 0xFF)), ("w", size), ("w", rough)],
                            result="l")
            return 0

        got = []
        ok = d.check(f"outline {i}", orig, "islandOutline", [cx, cy, size, rough],
                     result_map=lambda r: got.append(r) or 0)
        expect = qd.polygon(handle)
        if got and got[0] != expect:
            ok = False
            print(f"MISMATCH outline {i}: islandOutline({cx}, {cy}, {size}, {rough})")
            print("    original", expect)
            print("    engine  ", got[0])
        rgn, _, _ = d.js.call("outlineRegion", d.snapshot(), [expect])
        if rgn != region_of(expect):
            ok = False
            print(f"MISMATCH outline {i}: region of islandOutline({cx}, {cy}, {size}, {rough})")
            print("    quickdraw.py", region_of(expect))
            print("    engine      ", rgn)
        if not ok:
            bad += 1
            if bad > 5:
                break
        elif verbose:
            print(f"outline {i}: {len(expect)} points")
    return bad


def set_nibble(m, base, x, y, v):
    i = (x - 1) * 60 + (y - 1)
    a = base + (i >> 1)
    b = m.read_global(a, 1)[0]
    shift = (i & 1) * 4
    m.write_global(a, bytes([(b & ~(0x0F << shift) & 0xFF) | (v << shift)]))


def perturb(m, rng):
    """Make the rare cases of city placement likely: land of an island running to the map
    edge or into another island, islands with many cities, the 45-city limit near."""
    count = max(m.read_global(ISLAND_COUNT, 1)[0], 3)
    for _ in range(rng.randint(0, 3)):
        island = rng.randint(1, min(count, 15))
        cy, cx = m.read_global(ISLAND_CENTERS + 2 * island, 2)
        if not (2 <= cx <= 79 and 2 <= cy <= 59):
            continue
        dx, dy = rng.choice([(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)])
        other = rng.randint(0, min(count, 15)) if rng.random() < 0.4 else island
        x, y = cx, cy
        while 2 <= x <= 79 and 2 <= y <= 59:
            set_nibble(m, TERRAIN, x, y, LAND)
            set_nibble(m, ISLAND_MAP, x, y, island if (x, y) == (cx, cy) or rng.random() < 0.7 else other)
            x, y = x + dx, y + dy
    for island in range(16):
        if rng.random() < 0.3:
            m.write_global(ISLAND_CITIES + island, bytes([rng.randint(5, 9)]))
    if rng.random() < 0.5:
        made = rng.choice([43, 44, 45])
        m.write_global(CITIES_MADE, made.to_bytes(2, "big"))
        m.write_global(CITY_COUNT, bytes([made]))


def flood(m, rng):
    """A square of one island's land around its centre, with a ring of another island's
    land inside it: coastal-city rays from the centre stop at the ring. Returns the island."""
    count = max(m.read_global(ISLAND_COUNT, 1)[0], 3)
    island = rng.randint(1, min(count, 15))
    cy, cx = m.read_global(ISLAND_CENTERS + 2 * island, 2)
    other = rng.choice([k for k in range(1, 16) if k != island])
    half = rng.randint(5, 9)
    ring = rng.randint(2, half - 3)
    for x in range(cx - half, cx + half + 1):
        for y in range(cy - half, cy + half + 1):
            if 2 <= x <= 79 and 2 <= y <= 59:
                set_nibble(m, TERRAIN, x, y, LAND)
                near = max(abs(x - cx), abs(y - cy))
                set_nibble(m, ISLAND_MAP, x, y, other if ring <= near <= ring + 1 else island)
    m.write_global(ISLAND_CITIES + island, bytes([rng.randint(0, 7)]))
    made = rng.randint(10, 40)
    m.write_global(CITIES_MADE, made.to_bytes(2, "big"))
    m.write_global(CITY_COUNT, bytes([made]))
    return island


def helper_cases(d, qd, mark, rng, n, verbose):
    """City placement routines on generated maps made awkward by perturb()."""
    m = d.m
    bad = 0
    for i in range(n):
        fresh_heap(d, qd, mark)
        m.write_global(GAME_SEED, rng.getrandbits(32).to_bytes(4, "big"))
        m.write_global(SKILL, bytes([rng.randint(1, 15)]))
        m.call(2, 0x1CDC, result="b", max_insns=500_000_000)
        perturb(m, rng)
        m.write_global(QD_RANDSEED, rng.getrandbits(31).to_bytes(4, "big"))
        kind = i % 4
        if kind == 0:
            x, y = rng.randint(1, 80), rng.randint(1, 60)
            ok = d.check(f"placeCity {i}", lambda: m.call(2, 0x0F48, args=[("w", (y << 8) | x)], result="b"),
                         "placeCity", [x, y])
        elif kind == 1:
            island = flood(m, rng) if rng.random() < 0.5 else rng.randint(0, 15)
            ok = d.check(f"coastalCity {i}", lambda: m.call(2, 0x1038, args=[("w", island)], result="b",
                                                             max_insns=50_000_000),
                         "coastalCity", [island])
        elif kind == 2:
            top, left = rng.randint(1, 56), rng.randint(1, 76)
            area = [top, left, top + rng.randint(1, 12), left + rng.randint(1, 15)]
            ptr = m._alloc(8)
            m.uc.mem_write(ptr, b"".join(v.to_bytes(2, "big") for v in area))
            island = rng.randint(0, 15)
            ok = d.check(f"inlandCity {i}", lambda: m.call(2, 0x122C, args=[("l", ptr), ("w", island)], result="b"),
                         "inlandCity", area + [island])
        else:
            made = rng.randint(10, 44)
            m.write_global(CITIES_MADE, made.to_bytes(2, "big"))
            m.write_global(CITY_COUNT, bytes([made]))
            for island in range(3, 16):
                if rng.random() < 0.8:
                    m.write_global(ISLAND_CITIES + island, bytes([8]))
            ok = d.check(f"scatterCities {i}", lambda: m.call(2, 0x1466, max_insns=100_000_000), "scatterCities", [],
                         result_map=lambda r: None)
        if not ok:
            bad += 1
            if bad > 5:
                break
    return bad


def map_cases(d, qd, mark, rng, n, verbose):
    m = d.m
    bad = 0
    for i in range(n):
        fresh_heap(d, qd, mark)
        for off, size in STALE:
            m.write_global(off, bytes(rng.getrandbits(8) for _ in range(size)))
        m.write_global(ISLAND_POLYS, bytes(60))
        seed = zero_draw_seed(rng) if i % 5 == 4 else rng.getrandbits(32)
        skill = rng.randint(1, 15)
        m.write_global(GAME_SEED, seed.to_bytes(4, "big"))
        m.write_global(SKILL, bytes([skill]))
        got = []
        ok = d.check(f"map {i}", lambda: m.call(2, 0x1CDC, result="b", max_insns=500_000_000),
                     "generateMap", [], result_map=lambda r: got.append(r) or 1)
        for island in range(1, 16):
            handle = m.r32(m.g(ISLAND_POLYS + 4 * (island - 1)))
            expect = qd.polygon(handle) if handle else None
            if got and got[0][island] != expect:
                ok = False
                print(f"MISMATCH map {i} (seed {seed:#x}, skill {skill}): island {island} outline")
                print("    original", expect)
                print("    engine  ", got[0][island])
        if not ok:
            bad += 1
            if bad > 3:
                break
        elif verbose:
            cities = m.read_global(-0x1E4F, 1)[0]
            islands = m.read_global(-0x1E50, 1)[0]
            print(f"map {i}: seed {seed:#010x} skill {skill}: {islands} islands, {cities} cities")
    return bad


def run(n, seed, verbose):
    rng = random.Random(seed)
    d = Diff()
    for off in range(ISLAND_POLYS, ISLAND_POLYS + 60):
        d.ignore.add(off)
    qd = QuickDraw(d.m)
    qd.install()
    mark = d.m.heap_next
    bad = line_cases(d, rng, 200 * n)
    bad += outline_cases(d, qd, mark, rng, 20 * n, verbose)
    bad += helper_cases(d, qd, mark, rng, 4 * n, verbose)
    bad += map_cases(d, qd, mark, rng, n, verbose)
    print(f"{d.count} checks, {bad} mismatches")
    return bad == 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 20
    s = int(args[1]) if len(args) > 1 else 1
    try:
        sys.exit(0 if run(n, s, "--verbose" in sys.argv) else 1)
    except TrapError as e:
        print("trap:", e)
        sys.exit(1)
