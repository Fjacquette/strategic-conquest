"""Differential test: tools/model/units.py against the original unit-statistics routines.

Usage: python3 -I tools/emu/test_units.py
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "model"))
from harness import Machine, A5  # noqa: E402
import units  # noqa: E402
from test_combat import RSRC  # noqa: E402

GAME_MODE, DAY, PIECES, HASH = -0x1E71, -0x2D08, -0x5138, -0x5592


def main():
    m = Machine(RSRC)
    bad = 0
    checked = 0
    for mode in range(4):
        m.write_global(GAME_MODE, bytes([mode]))
        for t in range(8):
            for s in range(0, 32):
                got = m.call(4, 0x11BA, args=[("b", t), ("w", s)], result="w")
                want = units.moves_per_day(t, s, mode)
                checked += 1
                if got != want:
                    bad += 1
                    print(f"moves: mode {mode} type {t} str {s}: emu {got} model {want}")
            for day in list(range(0, 400, 7)) + [69, 70, 139, 140]:
                m.write_global(DAY, day.to_bytes(2, "big"))
                got = m.call(1, 0x021C, args=[("b", t), ("b", 1)], result="w")
                want = units.production_days(t, day, mode)
                checked += 1
                if got != want:
                    bad += 1
                    print(f"build: mode {mode} type {t} day {day}: emu {got} model {want}")
    rng = random.Random(5)
    for n in range(2000):
        mode = rng.randrange(4)
        day = rng.randrange(0, 600)
        t, owner = rng.randrange(8), rng.randrange(1, 3)
        x, y = rng.randint(2, 79), rng.randint(2, 59)
        idx = rng.randint(1, 449)
        old = bytes(rng.getrandbits(8) for _ in range(14))
        m.write_global(GAME_MODE, bytes([mode]))
        m.write_global(DAY, day.to_bytes(2, "big"))
        m.write_global(PIECES + 14 * idx, old)
        m.write_global(HASH, b"\xff\xff" * 551 + bytes(2))
        m.write_global(HASH + 0x44E, (550).to_bytes(2, "big"))
        # f4_20EE is a nested procedure of f4_22E2: it reads type/owner/y/x from its parent's
        # frame. Build a fake parent frame in the heap: $8 type, $a owner, $c y, $e x.
        frame = 0x780000
        m.uc.mem_write(frame, bytes(0x20))
        m.uc.mem_write(frame + 8, bytes([t, 0, owner, 0, y, 0, x, 0]))
        m.call(4, 0x20EE, args=[("w", idx), ("l", frame)])
        got = m.read_global(PIECES + 14 * idx, 14)
        want = units.new_piece(old, t, owner, x, y, day, mode)
        checked += 1
        if got != want:
            bad += 1
            if bad < 6:
                print(f"new piece: mode {mode} day {day} type {t}: emu {got.hex(' ')} model {want.hex(' ')}")
    print(f"{checked} checks, {bad} mismatches")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
