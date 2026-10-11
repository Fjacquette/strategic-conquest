"""Differential test: engine/src/path.ts (next step under orders) against CODE 4 + 0x19DA.

Usage: python3 -I tools/emu/test_path.py [cases] [seed]

Random worlds with land masses, random go-to destinations and points C, all order values
(straight, both detour directions, Random), and Army/ship terrain sets. Also checks the
software QuickDraw Random (CODE 1 + 0x2B56) on random seeds.
"""
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import A5, Diff  # noqa: E402

SCRATCH = 0x50F800
PIECES = -0x5138


def run(cases, seed):
    rng = random.Random(seed)
    d = Diff()
    m = d.m
    for case in range(cases):
        w = d.random_world(rng)
        x0, y0, x1, y1 = w.box
        if not w.pieces:
            continue
        m.write_global(-0x127C, rng.getrandbits(32).to_bytes(4, "big"))
        m.write_global(-0x23A, rng.randint(1, 0x7FFFFFFE).to_bytes(4, "big"))
        for _ in range(8):
            idx, ptype, owner, px, py = rng.choice(w.pieces)
            rec = bytearray(m.read_global(PIECES + 14 * idx, 14))
            far = rng.random() < 0.3
            bx = rng.randint(2, 79) if far else min(79, max(2, px + rng.randint(-12, 12)))
            by = rng.randint(2, 59) if far else min(59, max(2, py + rng.randint(-12, 12)))
            rec[2], rec[3] = by, bx
            if rng.random() < 0.5:
                rec[4], rec[5] = py, px
            else:
                rec[4], rec[5] = min(59, max(2, py + rng.randint(-3, 3))), min(79, max(2, px + rng.randint(-3, 3)))
            orders = rng.choice([2, 2, 2, 0, 1, 3])
            rec[11] = (rec[11] & 0xE7) | (orders << 3)
            rec[11] = (rec[11] & 0xDF) | (0x20 if rng.random() < 0.15 else 0)
            m.write_global(PIECES + 14 * idx, rec)
            tset = rng.choice([0x01, 0x1A, 0x0E, 0x08 | 0x02 | 0x10, rng.getrandbits(6)])
            base = d.snapshot()

            def orig(idx=idx, tset=tset):
                m.uc.mem_write(SCRATCH, bytes(4))
                m.call(4, 0x19DA, args=[("l", SCRATCH), ("l", SCRATCH + 1), ("l", A5 + PIECES + 14 * idx), ("w", tset)])
                b = m.uc.mem_read(SCRATCH, 2)
                return [struct.unpack("b", b[0:1])[0], struct.unpack("b", b[1:2])[0]]
            d.restore(base)
            if not d.check(f"case {case}", orig, "nextStep", [tset, idx]):
                return False
            # Repeat from the resulting state a few times, as successive steps would.
            for _ in range(3):
                after = d.snapshot()
                r = m.read_global(PIECES + 14 * idx, 14)
                if (r[11] >> 6) & 3:
                    break
                dx, dy = orig()
                d.restore(after)
                # Move the piece by the chosen step (no hash update needed for path finding
                # beyond the moving piece, which is not looked up).
                r = bytearray(m.read_global(PIECES + 14 * idx, 14))
                nx, ny = r[7] + dx, r[6] + dy
                if not (1 < nx < 80 and 1 < ny < 60):
                    break
                r[7], r[6] = nx, ny
                m.write_global(PIECES + 14 * idx, r)
                if not d.check(f"case {case} follow-on", orig, "nextStep", [tset, idx]):
                    return False
        # QuickDraw Random in software
        for _ in range(5):
            s = rng.choice([0, 1, 0x7FFFFFFE, 0x7FFFFFFF, 0x80000000, rng.getrandbits(32), rng.getrandbits(31)])
            m.write_global(-0x23A, s.to_bytes(4, "big"))
            if not d.check(f"case {case} qdRandom seed={s:#x}", lambda: m.call(1, 0x2B56, result="w"), "qdRandom", []):
                return False
    print(f"{cases} cases, {d.count} checks: all match")
    return True


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    s = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sys.exit(0 if run(n, s) else 1)
