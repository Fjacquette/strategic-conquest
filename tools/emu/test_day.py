"""Differential test: engine/src/day.ts (the day loop) against the original's main loop
(CODE 1 + 0x170A) and its helpers.

Usage: python3 -I tools/emu/test_day.py [cases] [seed] [--verbose]

First the helpers are compared on random worlds: the hand-off check (CODE 1 + 0x158C), the
defeat check (+0x149A), the Auto Play side swap (+0x2C48) and spotted decay (+0x1328).
Then whole days: the original's loop body runs from the day increment (0x195C) to the
reseeding of the game PRNG (0x1F82), in game modes 0 (against the computer) and 1 (two
players, one Mac), with both players' turns driven by the scripted controller of
test_turn.py. The globals image, requests, messages, beeps, computer-opponent calls, the
user-interface events (autosave, battle summary, clearing of the battle report list) and
the end-of-game alerts are compared.

User-interface routines are stubbed in the original. The scroll-bar calls of CODE 1 +
0x2BB6 are skipped, but its game effect (the movement sweep restarts at region 0) runs.
The surrender dialog is answered "No Way", so play continues.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import A5, Diff, UI_GLOBALS  # noqa: E402
from harness import STACK_TOP, TrapError  # noqa: E402
from jsbridge import GLOBALS_SIZE, read_globals  # noqa: E402
from test_turn import DEFAULT_FIELDS, FIELDS, Recorder, actions_for, build_world  # noqa: E402
from unicorn import UC_HOOK_CODE, UcError  # noqa: E402
from unicorn.m68k_const import (UC_M68K_REG_A5, UC_M68K_REG_A6, UC_M68K_REG_A7, UC_M68K_REG_D4,  # noqa: E402
                                UC_M68K_REG_D7, UC_M68K_REG_PC)

GAME_MODE, DAY, LOCAL_PLAYER = -0x1E71, -0x2D08, -0x2D0A
AUTO_PLAY, AUTO_PLAY_REQUESTED, NET_TURN, VIEW_PLAYER, AUTOSAVE_OFF = -0x120C, -0x120D, -0x1C07, -0x29A, -0x1401
DEFERRED_MENU = (-0x289, -0x28A, -0x288, -0x287)
# The computer opponent's data swapped by the Auto Play side swap: (current, other, scratch, size).
AI_SIDE_BLOCKS = [(-0x1BFC, -0xF86, -0xE26, 352), (-0x1C02, -0xCC6, -0xCC4, 2), (-0x1BFD, -0xCC2, -0xCC1, 1),
                  (-0x1C2E, -0xCC0, -0xCBE, 2), (-0x1C4E, -0xCBC, -0xC9C, 32), (-0x1C8C, -0xC7C, -0xC4E, 46),
                  (-0x1C5E, -0xC20, -0xC10, 16)]
AI_SIDE_BLOCKS += [(-0x1C0C - 2 * i, -0xC00 + 4 * i, -0xBFE + 4 * i, 2) for i in range(9)]
AI_SIDE_BLOCKS += [(-0x1C1D - i, -0xBDC + 2 * i, -0xBDB + 2 * i, 1) for i in range(8)]

DAY_FIELDS = {**FIELDS, 8: (0, 1), 15: (0, 1), 17: (0, 1)}
LOGGED = ("req", "msg", "beep", "aiPlan", "aiNewPiece", "event")
EVENTS = ("autosave", "battleSummary", "clearReports")


class DayRecorder(Recorder):
    """Recorder with the day loop's user-interface routines stubbed."""

    def __init__(self, d):
        super().__init__(d)
        m = self.m
        self.clock = 0
        self.ends = []

        def event(name, **data):
            self.log.append(["event", name, data])

        for seg, off, pop in ((5, 0x5C96, 0), (10, 0x0920, 0), (10, 0x15EE, 4), (10, 0x1648, 0),
                              (10, 0x17EA, 4), (1, 0x2894, 0), (1, 0x289E, 0), (2, 0x379C, 0),
                              (17, 0x0004, 0), (17, 0x12C8, 0), (15, 0x02EE, 0), (5, 0x0232, 8),
                              (1, 0x2B82, 8), (1, 0x2B68, 2), (12, 0x007A, 0), (12, 0x00DA, 0)):
            self._stub(seg, off, pop, lambda sp: None)
        self._stub(1, 0x11F2, 0, lambda sp: m.w8(sp + 4, 1))
        self._stub(1, 0x26BC, 0, lambda sp: event("clearReports"))
        self._stub(1, 0x2590, 2, lambda sp: event("battleSummary", player=m.r8(sp + 4)))
        self._stub(1, 0x328C, 6, lambda sp: self.ends.append(["alert", m.r16(sp + 8)]))

        def dialog(sp):
            self.ends.append(["dialog", m.r16(sp + 6)])
            m.w16(sp + 8, 2)                                  # "No Way"
        self._stub(10, 0x1562, 4, dialog)

        def clock(sp):
            m.w32(m.r32(sp + 4), self.clock)
        self._stub(1, 0x39AC, 4, clock)

        def autosave(uc, address, size, _):
            event("autosave")
        m.uc.hook_add(UC_HOOK_CODE, autosave, begin=m.addr(1, 0x1A0A), end=m.addr(1, 0x1A0A))

        # CODE 1 + 0x2BB6 sets the map's scroll bars, then restarts the movement sweep at
        # region 0: skip from its frame setup to the latter.
        def skip_controls(uc, address, size, _):
            uc.reg_write(UC_M68K_REG_PC, m.addr(1, 0x2BEA))
        m.uc.hook_add(UC_HOOK_CODE, skip_controls, begin=m.addr(1, 0x2BBA), end=m.addr(1, 0x2BBA))

    def run_day(self, decided, first_handoff, start=0x195C, stop=0x1F82, max_insns=400_000_000):
        """Run the original's loop body for one day (or the part from `start` to `stop`).
        Returns (decided, first_handoff, quit)."""
        m, uc = self.m, self.m.uc
        a6 = STACK_TOP - 0x200
        uc.mem_write(a6 - 0x6A, bytes(0x6A))
        uc.reg_write(UC_M68K_REG_A5, A5)
        uc.reg_write(UC_M68K_REG_A6, a6)
        uc.reg_write(UC_M68K_REG_A7, a6 - 0x6A - 20)
        uc.reg_write(UC_M68K_REG_D4, 1 if first_handoff else 0)
        uc.reg_write(UC_M68K_REG_D7, 1 if decided else 0)
        m._pending_error = None
        stop = m.addr(1, stop)
        try:
            uc.emu_start(m.addr(1, start), stop, count=max_insns)
        except UcError as e:
            raise RuntimeError(f"emulation error {e} at pc={uc.reg_read(UC_M68K_REG_PC):#x}") from e
        if m._pending_error:
            raise m._pending_error
        if uc.reg_read(UC_M68K_REG_PC) != stop:
            raise RuntimeError(f"day did not finish (pc={uc.reg_read(UC_M68K_REG_PC):#x})")
        return (uc.reg_read(UC_M68K_REG_D7) & 0xFF) != 0, (uc.reg_read(UC_M68K_REG_D4) & 0xFF) != 0, m.r8(a6 - 1)


def day_state(d, rng):
    """Day-loop globals on top of a movement world."""
    m = d.m
    for block in AI_SIDE_BLOCKS:
        for off in block[:3]:
            m.write_global(off, bytes(rng.getrandbits(8) for _ in range(block[3])))
    m.write_global(GAME_MODE, bytes([rng.choice([0, 0, 1, 1])]))
    m.write_global(DAY, rng.choice([1, 9, 10, 11, 20, 21, 32, 50, 99, 99, 100, 100, 101, 140]).to_bytes(2, "big"))
    if rng.random() < 0.3:
        lopsided(m, rng, rng.choice([1, 2]))
    if rng.random() < 0.15:
        idle(m, rng.choice([1, 2]))
    m.write_global(LOCAL_PLAYER, bytes([rng.choice([1, 1, 2])]))
    auto = rng.random() < 0.25
    m.write_global(AUTO_PLAY, bytes([1 if auto else 0]))
    m.write_global(AUTO_PLAY_REQUESTED, bytes([(1 if auto else 0) if rng.random() < 0.7 else (0 if auto else 1)]))
    m.write_global(NET_TURN, bytes([rng.choice([1, 2])]))
    m.write_global(VIEW_PLAYER, bytes([rng.choice([0, 1, 2])]))
    m.write_global(AUTOSAVE_OFF, bytes([rng.choice([0, 0, 1])]))
    for off in DEFERRED_MENU:
        m.write_global(off, b"\x00")
    if auto:
        maps_flag = -0x2CD8 + 0x280
        m.write_global(maps_flag, b"\x01")


def lopsided(m, rng, winner):
    """Give most cities to `winner`, for the end-of-game checks."""
    n = m.read_global(-0x1E4F, 1)[0]
    terrain = bytearray(m.read_global(-0x27D2, 2400))
    for c in range(1, n + 1):
        rec = bytearray(m.read_global(-0x385E + 10 * c, 10))
        owner = winner if rng.random() < 0.85 else rng.choice([0, 3 - winner])
        rec[4] = owner
        y, x = rec[6], rec[7]
        i, shift = (x - 1) * 30 + ((y - 1) >> 1), ((y - 1) & 1) * 4
        terrain[i] = (terrain[i] & ~(0xF << shift) & 0xFF) | ((1 << owner) << shift)
        m.write_global(-0x385E + 10 * c, rec)
    m.write_global(-0x27D2, terrain)


def idle(m, player):
    """Leave `player` nothing to do this day: no pieces, no city completing a unit."""
    n = int.from_bytes(m.read_global(-0x388E, 2), "big")
    for i in range(1, n + 1):
        off = -0x5138 + 14 * i + 10
        b = m.read_global(off, 1)[0]
        if (b >> 4) & 3 == player:
            m.write_global(off, bytes([(b & 0xCF) | ((3 - player) << 4)]))
    for c in range(1, m.read_global(-0x1E4F, 1)[0] + 1):
        rec = -0x385E + 10 * c
        if m.read_global(rec + 4, 1)[0] == player and m.read_global(rec + 5, 1)[0] == 1:
            m.write_global(rec + 5, b"\x02")


def compare_logs(a, b):
    """First difference between the original's log `a` and the engine's `b`, or None."""
    def keep(e):
        return e[0] in LOGGED and (e[0] != "event" or e[1] in EVENTS)
    ea, eb = [e for e in a if keep(e)], [e for e in b if keep(e)]
    for i, (x, y) in enumerate(zip(ea, eb)):
        if x[0] != y[0]:
            return i, x, y
        if x[0] == "req":
            fields = DAY_FIELDS.get(x[1][0], DEFAULT_FIELDS)
            if [x[1][k] for k in fields] != [y[1][k] for k in fields]:
                return i, x, y
        elif x != y:
            return i, x, y
    if len(ea) != len(eb):
        i = min(len(ea), len(eb))
        return i, ea[i] if i < len(ea) else None, eb[i] if i < len(eb) else None
    return None


def compare_globals(d, after, mem, problems):
    for k, (a, b) in enumerate(zip(after, mem)):
        off = k - GLOBALS_SIZE
        if a != b and off not in d.ignore:
            name = d.names(off)
            problems.append(f"A5{off:+#06x}{' ' + name if name else ''}: original {a:#04x}, engine {b:#04x}")
            if len(problems) > 14:
                problems.append("...")
                break


def check_helpers(d, rec, rng, cases):
    m = d.m
    ok = True
    as_bool = lambda r: 1 if r else 0  # noqa: E731
    for case in range(cases):
        build_world(d, rng)
        day_state(d, rng)
        for player in (1, 2):
            ok &= d.check(f"handoff {case}", lambda: m.call(1, 0x158C, args=[("b", player)], result="b"),
                          "handOffNeeded", [player], as_bool)
            ok &= d.check(f"defeated {case}", lambda: m.call(1, 0x149A, args=[("b", player)], result="b"),
                          "defeated", [player], as_bool)
        ok &= d.check(f"swap {case}", lambda: m.call(1, 0x2C48), "swapSides", [])
        owner = rng.choice([1, 2])
        before = read_globals(m)
        rec.log = []
        m.call(1, 0x1328, args=[("b", owner)])
        after = read_globals(m)
        _, mem, log = d.js.call("spottedDecay", before, [owner])
        problems = []
        diff = compare_logs(rec.log, log)
        if diff:
            problems.append(f"log entry {diff[0]}: original {diff[1]}, engine {diff[2]}")
        compare_globals(d, after, mem, problems)
        d.count += 1
        if problems:
            print(f"MISMATCH spotted decay case {case} (owner {owner}):")
            for p in problems:
                print("   ", p)
            ok = False
        if not ok:
            return False
    return True


def check_end(d, rec, rng, cases):
    """The end-of-game checks alone (CODE 1 + 0x1E16 to 0x1F22), on lopsided worlds."""
    m = d.m
    for case in range(cases):
        build_world(d, rng)
        day_state(d, rng)
        if rng.random() < 0.7:
            lopsided(m, rng, rng.choice([1, 2]))
        m.write_global(DAY, rng.choice([1, 50, 100, 101, 102, 200]).to_bytes(2, "big"))
        decided = rng.random() < 0.4
        rec.log, rec.ends = [], []
        before = read_globals(m)
        o_decided, _, _ = rec.run_day(decided, False, 0x1E16, 0x1F22)
        after = read_globals(m)
        result, mem, _ = d.js.call("endChecks", before, [decided])
        expect = [["alert", 0x410] in rec.ends, ["dialog", 0x14A] in rec.ends, o_decided]
        problems = []
        if result != expect:
            problems.append(f"result: original {expect} {rec.ends}, engine {result}")
        compare_globals(d, after, mem, problems)
        d.count += 1
        if problems:
            print(f"MISMATCH end checks case {case} (decided {decided}):")
            for p in problems:
                print("   ", p)
            return False
    return True


def run(cases, seed, verbose=False):
    rng = random.Random(seed)
    d = Diff()
    rec = DayRecorder(d)
    m = d.m
    if not check_helpers(d, rec, rng, max(1, cases)):
        return False
    if not check_end(d, rec, rng, 10 * max(1, cases)):
        return False
    print(f"helpers and end checks: {d.count} checks match")
    seen = {}
    for case in range(cases):
        build_world(d, rng)
        day_state(d, rng)
        actions = actions_for(rng, 800)
        decided, first = rng.random() < 0.3, rng.random() < 0.3
        rec.clock = rng.getrandbits(32)
        rec.log, rec.actions, rec.next, rec.ends = [], actions, 0, []
        before = read_globals(m)
        mode = m.read_global(GAME_MODE, 1)[0]
        auto = m.read_global(AUTO_PLAY, 1)[0], m.read_global(AUTO_PLAY_REQUESTED, 1)[0]
        o_decided, o_first, o_quit = rec.run_day(decided, first)
        after = read_globals(m)
        result, mem, log = d.js.call("runDay", before, [actions, rec.clock, decided, first])
        problems = []
        o_p1 = ["alert", 0x410] in rec.ends
        o_p2 = ["dialog", 0x14A] in rec.ends
        expect = [o_p1, o_p2, o_decided, o_first]
        if result != expect:
            problems.append(f"result: original {expect} {rec.ends}, engine {result}")
        if o_quit != (1 if o_p1 else 0):
            problems.append(f"original quit flag {o_quit} with ends {rec.ends}")
        diff = compare_logs(rec.log, log)
        if diff:
            problems.append(f"log entry {diff[0]}: original {diff[1]}, engine {diff[2]}")
        compare_globals(d, after, mem, problems)
        d.count += 1
        for key in [f"mode {mode}", f"auto play {auto}"] + [" ".join(map(str, e)) for e in rec.ends] + \
                [f"request {e[1][0]}" for e in rec.log if e[0] == "req" and e[1][0] in (8, 15, 17, 22)] + \
                [e[1] for e in rec.log if e[0] == "event"]:
            seen[key] = seen.get(key, 0) + 1
        if problems:
            print(f"MISMATCH day case {case} (mode {mode}, decided {decided}, first hand-off {first}):")
            for p in problems:
                print("   ", p)
            if verbose:
                for e in [e for e in rec.log if e[0] in LOGGED][:120]:
                    print("      ", e)
            return False
    print(f"{cases} days: all match")
    if verbose:
        for k in sorted(seen):
            print(f"    {k}: {seen[k]}")
    return True


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 20
    s = int(args[1]) if len(args) > 1 else 1
    try:
        sys.exit(0 if run(n, s, "--verbose" in sys.argv) else 1)
    except TrapError as e:
        print("trap:", e)
        sys.exit(1)
