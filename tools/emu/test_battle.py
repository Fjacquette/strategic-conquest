"""Differential test: engine/src/battle.ts against the original combat code (CODE 3).

Usage: python3 -I tools/emu/test_battle.py [cases] [seed]

Random worlds; each case picks an attacker and a defender among the pieces (usually
adjacent, often stacked, any types and strengths, spotted or not) and runs Attack
(CODE 3 + 0x0520) on both sides, then a Bomber blast (CODE 3 + 0x0A30) from a random
piece made into a Bomber. The whole globals image is compared, including the position
hash.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import A5, Diff  # noqa: E402

PIECES = -0x5138


def run(cases, seed):
    rng = random.Random(seed)
    d = Diff()
    m = d.m
    for case in range(cases):
        w = d.random_world(rng)
        live = [p for p in w.pieces if p[1] < 8]
        if len(live) < 2:
            continue
        m.write_global(-0x127C, rng.getrandbits(32).to_bytes(4, "big"))
        for _ in range(6):
            a = rng.choice(live)
            near = [p for p in live if p[0] != a[0] and abs(p[3] - a[3]) <= 1 and abs(p[4] - a[4]) <= 1]
            b = rng.choice(near) if near and rng.random() < 0.9 else rng.choice([p for p in live if p[0] != a[0]])
            spotted = rng.choice([0, 0, 1, 2])
            base = d.snapshot()
            ap, bp = A5 + PIECES + 14 * a[0], A5 + PIECES + 14 * b[0]
            ok = d.check(f"case {case} attack {a} -> {b}",
                         lambda: m.call(3, 0x0520, args=[("l", ap), ("l", bp), ("w", a[0]), ("w", b[0]), ("w", spotted)], result="b"),
                         "attack", [a[0], b[0], spotted, []],
                         result_map=lambda r: 1 if r else 0)
            if not ok:
                return False
            d.restore(base)
        bomber = rng.choice(live)
        rec = bytearray(m.read_global(PIECES + 14 * bomber[0], 14))
        rec[10] = (rec[10] & 0xF0) | 7
        rec[8] = (rec[8] & 0x03) | (rng.randint(0, 4) << 2)
        m.write_global(PIECES + 14 * bomber[0], rec)
        bp = A5 + PIECES + 14 * bomber[0]
        if not d.check(f"case {case} blast", lambda: m.call(3, 0x0A30, args=[("l", bp), ("w", bomber[0])]),
                       "bomberBlast", [bomber[0]]):
            return False
    print(f"{cases} cases, {d.count} checks: all match")
    return True


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    s = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sys.exit(0 if run(n, s) else 1)
