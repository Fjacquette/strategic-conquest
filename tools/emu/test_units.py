"""Differential test: engine/src/units.ts (unit statistics, production, new pieces) against
the original routines.

Usage: python3 -I tools/emu/test_units.py [cases] [seed]

Moves per day (CODE 4 + 0x11BA) and build times (CODE 1 + 0x021C) for every type, strength,
game mode and a spread of days; then building pieces (CODE 4 + 0x2496) into random worlds,
including a full piece table, every game mode, skill and local player.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff  # noqa: E402

GAME_MODE, DAY, SKILL, LOCAL_PLAYER, PIECE_COUNT = -0x1E71, -0x2D08, -0x2CE6, -0x2D0A, -0x388E


def run(cases, seed):
    rng = random.Random(seed)
    d = Diff()
    m = d.m
    d.random_world(rng)
    for mode in range(4):
        m.write_global(GAME_MODE, bytes([mode]))
        for t in range(8):
            for s in range(0, 32):
                if not d.check(f"moves mode {mode}", lambda: m.call(4, 0x11BA, args=[("b", t), ("w", s)], result="w"),
                               "movesPerDay", [t, s]):
                    return False
            for day in list(range(0, 400, 7)) + [69, 70, 139, 140]:
                m.write_global(DAY, day.to_bytes(2, "big"))
                if not d.check(f"build mode {mode} day {day}",
                               lambda: m.call(1, 0x021C, args=[("b", t), ("b", 1)], result="w"),
                               "productionDays", [t]):
                    return False
    for case in range(cases):
        w = d.random_world(rng)
        m.write_global(GAME_MODE, bytes([rng.randrange(4)]))
        m.write_global(DAY, rng.randrange(0, 300).to_bytes(2, "big"))
        m.write_global(SKILL, bytes([rng.randint(1, 5)]))
        m.write_global(LOCAL_PLAYER, bytes([rng.choice([1, 2])]))
        m.write_global(-0x1277, bytes([rng.choice([0, 1, 1, 1])]))
        if rng.random() < 0.2:
            m.write_global(PIECE_COUNT, rng.choice([448, 449, 450]).to_bytes(2, "big"))
        if not w.cities:
            continue
        x, y, _ = rng.choice(w.cities)
        owner, t = rng.choice([1, 2]), rng.randrange(8)
        if not d.check(f"case {case} build", lambda: m.call(4, 0x2496, args=[("b", x), ("b", y), ("b", owner), ("b", t)], result="b"),
                       "buildPiece", [x, y, owner, t], result_map=lambda r: 1 if r else 0):
            return False
    print(f"{d.count} checks: all match")
    return True


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 500
    s = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sys.exit(0 if run(n, s) else 1)
