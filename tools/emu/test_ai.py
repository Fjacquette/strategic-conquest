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


PIECES = -0x5138


def signed(b):
    return b - 256 if b > 127 else b


def arg_slots(fmt):
    """(kind, offset in the argument bytes) of each Pascal argument, in declaration order:
    the last declared is nearest the stack pointer. Kinds: 'b' byte, 'w' word, 'l' long,
    'p' pointer to a piece, 'q' pointer to a request record, 'r' pointer to a reply."""
    slots, pos = [], 0
    for kind in reversed(fmt):
        slots.append((kind, pos))
        pos += 2 if kind in "bw" else 4
    return list(reversed(slots))


def argbytes(fmt):
    return sum(2 if k in "bw" else 4 for k in fmt)


def read_args(fmt):
    """The arguments at entry, as the engine takes them: a piece pointer as the piece's
    index, a request as its 12 bytes, a reply as its two (signed) bytes."""
    def read(m, raw):
        out = []
        for kind, pos in arg_slots(fmt):
            if kind == "b":
                out.append(struct.unpack(">b", raw[pos:pos + 1])[0])
            elif kind == "w":
                out.append(struct.unpack(">h", raw[pos:pos + 2])[0])
            elif kind == "l":
                out.append(struct.unpack(">i", raw[pos:pos + 4])[0])
            else:
                ptr = struct.unpack(">I", raw[pos:pos + 4])[0]
                if kind == "p":
                    k, r = divmod(ptr - m.g(PIECES), 14)
                    assert r == 0, f"not a piece pointer: {ptr:#x}"
                    out.append(k)
                elif kind == "q":
                    out.append(list(m.uc.mem_read(ptr, 12)))
                else:
                    out.append([signed(b) for b in m.uc.mem_read(ptr, 2)])
        return out
    return read


def read_replies(fmt):
    """The replies at return (the bytes reply pointers point to), or None if there are none."""
    if "r" not in fmt:
        return None

    def read(m, raw):
        out = []
        for kind, pos in arg_slots(fmt):
            if kind == "r":
                ptr = struct.unpack(">I", raw[pos:pos + 4])[0]
                out += [signed(b) for b in m.uc.mem_read(ptr, 2)]
        return out
    return read


# name: (segment, offset, argument format (see arg_slots), result kind, engine routine).
# A routine with reply arguments returns, in the engine, its result (if it has one) and then
# the replies, as one list.
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
    "takesOn": (6, 0x5388, "pp", "b", "takesOn"),
    "followOrders": (6, 0x4DEE, "qrp", None, "followOrders"),
    "transportArrives": (6, 0x2694, "pwr", "b", "transportArrives"),
    "hypot": (1, 0x0004, "ww", "w", "hypot"),
    "clearLine": (1, 0x03E2, "wwwww", "b", "clearLine"),
    "armyMove": (7, 0x0A4A, "pw", None, "armyMove"),
    "armyAboard": (7, 0x0850, "pww", None, "armyAboard"),
    "sendToCity": (6, 0x630C, "pb", "b", "sendToCity"),
    "huntArmies": (6, 0x6462, "pbww", None, "huntArmies"),
    "exploreIsland": (7, 0x0348, "pbw", "b", "exploreIsland"),
    "fighterMove": (6, 0x2278, "pw", None, "fighterMove"),
    "fighterTarget": (6, 0x11CC, "pw", "b", "fighterTarget"),
    "fighterReturn": (6, 0x0F50, "p", None, "fighterReturn"),
    "fighterSearch": (6, 0x0BB2, "p", None, "fighterSearch"),
    "fighterStep": (6, 0x077E, "p", None, "fighterStep"),
    "exploreAround": (6, 0x054E, "pwwb", None, "exploreAround"),
    "fighterBase": (6, 0x027E, "p", "b", "fighterBase"),
}


def compare(js, names, name, spec, call, bounds):
    seg, off, fmt, result, fn = spec
    args = call["argv"]
    call = dict(call, before=with_bounds(call["before"], bounds), after=with_bounds(call["after"], bounds))
    res, mem, _ = js.call(fn, call["before"], args)
    problems = []
    want = []
    if result is not None:
        want.append(1 if call["result"] and result == "b" else call["result"] if result != "b" else 0)
    if call.get("out") is not None:
        want += call["out"]
        got = list(res)
    else:
        got = [res] if result is not None else []
    if result == "b" and got:
        got[0] = 1 if got[0] else 0
    if got != want:
        problems.append(f"result: original {want}, engine {got}")
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
        caps = {k: Capture(g.m, v[0], v[1], argbytes(v[2]), v[3], limit=60,
                           enter=read_args(v[2]), leave=read_replies(v[2])) for k, v in targets.items()}
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
