"""Differential test: engine/src/newgame.ts (starting a new game) against the original's
CODE 10 + 0x093C and its parts: clearing the tables (CODE 2 + 0x00EA) and the players' maps
(+0x20B0), and the starting cities (CODE 10 + 0x0004).

Usage: python3 -I tools/emu/test_newgame.py [cases] [seed] [--verbose]

The parts run on random stale state; the starting cities also on random pairs of cities in
game modes 0-3. Whole new games run in modes 0 (against the computer), 1 (two players, one
Mac) and 2 (the network game's Master), with Auto Play on or off, at random skill levels
and clock values; map
generation runs on the QuickDraw traps of quickdraw.py. Requests (with a digest of the
globals at each), messages and the call of the computer opponent's start-of-game analysis
are compared, then the globals image. The controller is scripted: production requests get
a random type, password requests the test password of engine/test/testhost.ts.

User-interface routines (cursor, event pump, the zoom animation of CODE 1 + 0x2F94) are
stubbed. So is the computer opponent's start-of-game analysis (CODE 2 + 0x2E3A and
+0x24DE), whose calls are logged; the side swaps between them run. In mode 2 the network
routines (CODE 11) are stubbed: sending state succeeds, and requests sent to the Slave are
answered by the same scripted controller.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff, UI_GLOBALS  # noqa: E402
from harness import STACK_TOP, TrapError  # noqa: E402
from jsbridge import GLOBALS_SIZE, read_globals  # noqa: E402
from quickdraw import QuickDraw  # noqa: E402
from test_turn import Recorder  # noqa: E402

GAME_MODE, SKILL, AUTO_PLAY, CITY_COUNT, CITIES = -0x1E71, -0x2CE6, -0x120C, -0x1E4F, -0x385E
ISLAND_POLYS = -0x1E36
NET_PACKET = -0x1604             # the network routines' packet buffer (to -$1405)
IGNORED = UI_GLOBALS + [(ISLAND_POLYS, 60), (NET_PACKET, 0x200)]
# Globals a new game sets, filled with stale data first.
STALE = [(-0x55C2, 48), (-0x5142, 4), (-0x513C, 1), (-0x1401, 1), (-0x2CE4, 12), (-0x1C8E, 2),
         (-0x1C90, 2), (-0x1E70, 4), (-0x2D08, 2), (-0x3672, 2400), (-0x3692, 32), (-0x386E, 16),
         (-0x2D06, 32), (-0x1E3A, 2), (-0x1E50, 1), (-0x1E44, 10), (-0x1E4E, 10)]
LOGGED = ("req", "msg", "beep", "aiNewGame", "aiNewSide", "aiPlan", "aiNewPiece")


def test_password(player):
    """The password the scripted controller gives (testPassword in testhost.ts)."""
    return bytes([3, 0x50, 0x57, 0x30 + player, 0, 0])


class NewGameRecorder(Recorder):
    def __init__(self, d):
        super().__init__(d)
        m = self.m
        self.clock = 0
        self.production = []
        self.track = True
        for seg, off, pop in ((1, 0x28A8, 0), (1, 0x2894, 0), (1, 0x38F6, 4), (5, 0x5C96, 0),
                              (1, 0x2F94, 0)):
            self._stub(seg, off, pop, lambda sp: None)
        self._stub(2, 0x2E3A, 0, lambda sp: self.log.append(["aiNewGame"]))
        self._stub(2, 0x24DE, 0, lambda sp: self.log.append(["aiNewSide"]))
        self._stub(1, 0x39AC, 4, lambda sp: m.w32(m.r32(sp + 4), self.clock))
        m.traps[0xA850] = lambda: None      # InitCursor
        # Network routines: sends succeed; a request to the Slave goes to the controller.
        self._stub(11, 0x127E, 4, lambda sp: m.w8(sp + 8, 1))
        self._stub(11, 0x14B2, 8, lambda sp: m.w8(sp + 12, 1))
        self._stub(11, 0x1A8C, 0, lambda sp: None)
        self._stub(11, 0x14EE, 4, lambda sp: None)
        self._stub(11, 0x0AD0, 0, lambda sp: m.w8(sp + 4, 1))

        def to_slave(sp):
            self.on_request(sp + 2)
            m.w8(sp + 18, 1)
        self._stub(11, 0x1510, 14, to_slave)

    def digest(self):
        data = bytearray(read_globals(self.m))
        for off, size in IGNORED:
            data[off + GLOBALS_SIZE:off + GLOBALS_SIZE + size] = bytes(size)
        h = 0x811C9DC5
        for b in data:
            h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
        return h

    def on_request(self, sp):
        super().on_request(sp)
        m = self.m
        req = m.r32(sp + 12)
        code = m.r8(req)
        if code == 24 and m.r8(req + 8) == 1:
            m.uc.mem_write(req + 2, test_password(m.r8(req + 1)))
        elif code == 6 and self.production:
            m.w8(req + 2, self.production.pop(0))


def compare(d, label, rec, after, log, mem, verbose):
    problems = []
    ea = [e for e in rec.log if e[0] in LOGGED]
    eb = [e for e in log if e[0] in LOGGED]
    for i, (x, y) in enumerate(zip(ea, eb)):
        if x != y:
            problems.append(f"event {i}: original {x}, engine {y}")
            break
    if len(ea) != len(eb) and not problems:
        problems.append(f"{len(ea)} events in the original, {len(eb)} in the engine")
    for k, (a, b) in enumerate(zip(after, mem)):
        off = k - GLOBALS_SIZE
        if a != b and off not in d.ignore:
            name = d.names(off)
            problems.append(f"A5{off:+#06x}{' ' + name if name else ''}: original {a:#04x}, engine {b:#04x}")
            if len(problems) > 14:
                problems.append("...")
                break
    if problems:
        print(f"MISMATCH {label}")
        for p in problems:
            print("   ", p)
        return False
    if verbose:
        print(f"{label}: {len(ea)} events")
    return True


def stale(d, rng):
    m = d.m
    d.random_world(rng)
    for off, size in STALE:
        m.write_global(off, bytes(rng.getrandbits(8) for _ in range(size)))


def fresh_stack(d):
    d.m.uc.mem_write(STACK_TOP - 0x2000, bytes(0x2000))


def check_parts(d, rng, cases):
    m = d.m
    bad = 0
    for i in range(cases):
        stale(d, rng)
        bad += not d.check(f"clearTables {i}", lambda: m.call(2, 0x00EA), "clearTables", [])
        stale(d, rng)
        bad += not d.check(f"clearPlayerMaps {i}", lambda: m.call(2, 0x20B0), "clearPlayerMaps", [])
    return bad


def check_starting_cities(d, rec, qd, mark, rng, cases, verbose):
    """CODE 10 + 0x0004 on a generated map, for random pairs of cities."""
    m = d.m
    bad = 0
    for i in range(cases):
        m.heap_next = mark
        qd.reset()
        stale(d, rng)
        m.write_global(SKILL, bytes([rng.randint(1, 15)]))
        m.write_global(-0x1E70, rng.getrandbits(32).to_bytes(4, "big"))
        m.call(2, 0x1CDC, result="b", max_insns=500_000_000)
        m.call(2, 0x20B0)
        n = m.read_global(CITY_COUNT, 1)[0]
        a, b = rng.sample(range(1, n + 1), 2)
        mode = rng.choice([0, 1, 2, 3])
        m.write_global(GAME_MODE, bytes([mode]))
        m.write_global(AUTO_PLAY, bytes([1 if rng.random() < 0.3 else 0]))
        if rng.random() < 0.3:          # an owner and product already set
            city = CITIES + 10 * rng.choice([a, b])
            m.write_global(city + 4, bytes([rng.randint(0, 2)]))
            m.write_global(city + 8, bytes([rng.randint(0, 7)]))
        production = [rng.randint(0, 7) for _ in range(2)]
        rec.log, rec.production = [], list(production)
        fresh_stack(d)
        before = read_globals(m)
        m.call(10, 0x0004, args=[("b", 1), ("b", a), ("b", b)], max_insns=50_000_000)
        after = read_globals(m)
        _, mem, log = d.js.call("startingCities", before, [1, a, b, production, IGNORED])
        d.count += 1
        if not compare(d, f"startingCities {i} (mode {mode}, cities {a}, {b})", rec, after, log, mem, verbose):
            bad += 1
            if bad > 3:
                break
    return bad


def check_new_games(d, rec, qd, mark, rng, cases, verbose):
    m = d.m
    bad = 0
    for i in range(cases):
        m.heap_next = mark
        qd.reset()
        stale(d, rng)
        mode = rng.choice([0, 1, 2])
        skill = rng.randint(1, 15)
        auto = 1 if rng.random() < 0.3 else 0
        m.write_global(GAME_MODE, bytes([mode]))
        m.write_global(SKILL, bytes([skill]))
        m.write_global(AUTO_PLAY, bytes([auto]))
        m.write_global(ISLAND_POLYS, bytes(60))
        clock = rng.getrandbits(32)
        production = [rng.randint(0, 7) for _ in range(2)]
        rec.log, rec.clock, rec.production = [], clock, list(production)
        fresh_stack(d)
        before = read_globals(m)
        m.call(10, 0x093C, max_insns=500_000_000)
        after = read_globals(m)
        _, mem, log = d.js.call("newGame", before, [clock, production, IGNORED])
        d.count += 1
        label = f"newGame {i} (mode {mode}, skill {skill}, auto play {auto}, clock {clock:#010x})"
        if not compare(d, label, rec, after, log, mem, verbose):
            bad += 1
            if bad > 3:
                break
    return bad


def run(cases, seed, verbose):
    rng = random.Random(seed)
    d = Diff()
    for off, size in IGNORED:
        for k in range(size):
            d.ignore.add(off + k)
    rec = NewGameRecorder(d)
    qd = QuickDraw(d.m)
    qd.install()
    mark = d.m.heap_next
    bad = check_parts(d, rng, 5 * cases)
    bad += check_starting_cities(d, rec, qd, mark, rng, cases, verbose)
    bad += check_new_games(d, rec, qd, mark, rng, cases, verbose)
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
