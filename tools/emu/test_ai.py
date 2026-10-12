"""Differential test: the computer opponent (engine/src/ai) against the original's, on the
states it meets in real games.

Usage: python3 -I tools/emu/test_ai.py [games] [days] [seed] [--only name,name] [--verbose]

Whole games of the original run in the emulator with its computer opponent playing
(aigame.py): some with the computer playing both sides (Auto Play), some against a
scripted player. Calls of the computer opponent's routines are captured there (the
globals and arguments at entry, the globals and result at return), then the engine's
version of each routine runs on the captured entry state through the Node bridge, and the
globals and results are compared.
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from aigame import Capture, Game  # noqa: E402
from difftest import UI_GLOBALS  # noqa: E402
from jsbridge import GLOBALS_SIZE, diff_globals  # noqa: E402

# Globals no routine here should be judged on: the user interface's.
IGNORED = set()
for _off, _size in UI_GLOBALS:
    IGNORED.update(range(_off, _off + _size))

ISLAND_BOUNDS = -0x1E36


def island_bounds(m):
    """The engine's form of the island polygons (engine/src/mapgen.ts ISLAND_BOUNDS): for
    islands 1-15, the polygon's bounding box divided into squares, from the original's
    polygon handles in the emulator."""
    out = bytearray(60)
    for i in range(15):
        handle = m.r32(m.g(ISLAND_BOUNDS) + 4 * i)
        if not handle:
            continue
        top, left, bottom, right = struct.unpack(">4h", m.uc.mem_read(m.r32(handle) + 2, 8))
        vals = [int(top / 12) + 1, int(left / 16) + 1, int(bottom / 12) + 1, int(right / 16) + 1]
        out[4 * i:4 * i + 4] = bytes(v & 0xFF for v in vals)
    return bytes(out)


def with_bounds(image, bounds):
    data = bytearray(image)
    k = GLOBALS_SIZE + ISLAND_BOUNDS
    data[k:k + 60] = bounds
    return bytes(data)


def words(fmt):
    """Decode Pascal arguments: `fmt` lists them in declaration order ('b' byte, 'w' word,
    'l' long); the last declared is nearest the stack pointer."""
    def decode(raw):
        out, pos = [], 0
        for kind in reversed(fmt):
            if kind == "l":
                out.append(struct.unpack(">i", raw[pos:pos + 4])[0])
                pos += 4
            elif kind == "w":
                out.append(struct.unpack(">h", raw[pos:pos + 2])[0])
                pos += 2
            else:
                out.append(struct.unpack(">b", raw[pos:pos + 1])[0])
                pos += 2
        return list(reversed(out))
    return decode


def argbytes(fmt):
    return sum(4 if k == "l" else 2 for k in fmt)


# name: (segment, offset, argument format, result kind, engine routine)
ROUTINES = {
    "aiPlan": (7, 0x11EA, "", None, "aiPlan"),
    "aiNewGame": (2, 0x2E3A, "", None, "aiNewGame"),
    "aiNewSide": (2, 0x24DE, "", None, "aiNewSide"),
    "aiNewPiece": (1, 0x0626, "b", None, "aiNewPiece"),
    "aiSurvey": (1, 0x0702, "", None, "aiSurvey"),
    "wakeTransports": (1, 0x078A, "", None, "wakeTransports"),
    "aiProduction": (6, 0x4C72, "", None, "aiProduction"),
    "aiIslandReview": (7, 0x13AE, "lb", None, "aiIslandReview"),
    "wakeLightTransports": (1, 0x0850, "", None, "wakeLightTransports"),
    "aiFocus": (6, 0x5630, "", None, "aiFocus"),
    "aiTransport": (6, 0x4928, "lw", None, "aiTransport"),
}


def compare(js, names, name, spec, call, bounds):
    seg, off, fmt, result, fn = spec
    args = words(fmt)(call["args"]) if fmt else []
    call = dict(call, before=with_bounds(call["before"], bounds), after=with_bounds(call["after"], bounds))
    res, mem, _ = js.call(fn, call["before"], args)
    problems = []
    if result is not None:
        want = call["result"]
        if result == "b":
            want = 1 if want else 0
            res = 1 if res else 0
        if res != want:
            problems.append(f"result: original {want}, engine {res}")
    diffs = [d for d in diff_globals(call["after"], mem, names, limit=1000)
             if int(d.split(":")[0][2:].split()[0], 16) not in IGNORED] if call["after"] != mem else []
    problems += diffs[:12]
    return problems


def run(games, days, seed, only, verbose):
    from jsbridge import Bridge, global_namer
    js = Bridge()
    names = global_namer()
    targets = {k: v for k, v in ROUTINES.items() if not only or k in only}
    checks = bad = 0
    for gi in range(games):
        g = Game(seed + gi)
        auto = gi % 2 == 0
        caps = {k: Capture(g.m, v[0], v[1], argbytes(v[2]), v[3], limit=60) for k, v in targets.items()}
        g.new_game(skill=g.rng.randint(1, 10), auto_play=auto)
        bounds = island_bounds(g.m)
        for _ in range(days):
            g.day()
        for name, cap in caps.items():
            for i, call in enumerate(cap.calls):
                checks += 1
                problems = compare(js, names, name, targets[name], call, bounds)
                if problems:
                    bad += 1
                    print(f"MISMATCH {name} game {gi} call {i}")
                    for p in problems:
                        print("   ", p)
                    if bad > 5:
                        print(f"{checks} checks, {bad} mismatches (stopped)")
                        return False
            if verbose:
                print(f"game {gi}: {name}: {len(cap.calls)} calls")
    js.close()
    print(f"{checks} checks, {bad} mismatches")
    return bad == 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
        args = [a for a in args if a != sys.argv[sys.argv.index("--only") + 1]]
    games = int(args[0]) if args else 2
    days = int(args[1]) if len(args) > 1 else 40
    seed = int(args[2]) if len(args) > 2 else 1
    sys.exit(0 if run(games, days, seed, only, "--verbose" in sys.argv) else 1)
