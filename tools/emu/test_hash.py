"""Differential test: engine/src/hash.ts against the original position-hash routines.

Usage: python3 -I tools/emu/test_hash.py [cases] [seed]

Each case builds a random piece table (many pieces stacked on a few cells, so chains are
long and hold Transports with Armies and Carriers with Fighters), fills the hash with the
original insert routine, then applies random inserts, removes and lookups. Every operation
runs on the original and on the engine from the same globals, and the results and the
whole globals image are compared.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from harness import Machine, A5  # noqa: E402
from jsbridge import Bridge, diff_globals, global_namer, read_globals, write_globals  # noqa: E402

RSRC = os.path.join(HERE, "..", "..", "build", "sc301.rsrc")
PIECES, HASH = -0x5138, -0x5592
TYPES = [0, 0, 0, 0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 5, 6, 7, 8, 9]


def orig_insert(m, x, y, idx, ptype):
    m.call(4, 0x00A0, args=[("l", A5 + HASH), ("w", x), ("w", y), ("w", idx), ("b", ptype)])


def orig_remove(m, idx):
    m.call(4, 0x026C, args=[("l", A5 + HASH), ("w", idx)])


def orig_find(m, x, y):
    return m.call(4, 0x02EE, args=[("l", A5 + HASH), ("w", x), ("w", y)], result="w")


def set_pos(m, idx, x, y):
    m.write_global(PIECES + 14 * idx + 6, bytes([y, x]))


def build(m, rng):
    count = rng.randint(10, 450)
    cells = [(rng.randint(2, 79), rng.randint(2, 59)) for _ in range(rng.randint(3, 60))]
    raw = bytearray(14 * 451)
    for i in range(1, count + 1):
        rec = bytearray(rng.getrandbits(8) for _ in range(14))
        x, y = rng.choice(cells) if rng.random() < 0.8 else (rng.randint(2, 79), rng.randint(2, 59))
        rec[6], rec[7] = y, x
        rec[10] = (rec[10] & 0xF0) | rng.choice(TYPES)
        raw[14 * i:14 * i + 14] = rec
    m.write_global(PIECES, raw)
    m.write_global(HASH, b"\xff\xff" * 551 + b"\x00\x00")
    order = list(range(1, count + 1))
    rng.shuffle(order)
    for i in order:
        orig_insert(m, raw[14 * i + 7], raw[14 * i + 6], i, raw[14 * i + 10] & 0x0F)
    in_hash = set(order)
    # Churn: remove some, move them, reinsert some, to leave deleted slots on the chains.
    for i in rng.sample(order, k=len(order) // 3):
        orig_remove(m, i)
        in_hash.discard(i)
        if rng.random() < 0.5:
            x, y = rng.choice(cells)
            set_pos(m, i, x, y)
        if rng.random() < 0.5:
            rec = m.read_global(PIECES + 14 * i, 14)
            orig_insert(m, rec[7], rec[6], i, rec[10] & 0x0F)
            in_hash.add(i)
    return count, cells, in_hash


def run(cases, seed):
    rng = random.Random(seed)
    m = Machine(RSRC)
    js = Bridge()
    names = global_namer()
    ops = 0
    for case in range(cases):
        count, cells, in_hash = build(m, rng)
        for _ in range(40):
            before = read_globals(m)
            kind = rng.choice(["insert", "remove", "find", "find"])
            if kind == "insert":
                out = [i for i in range(1, count + 1) if i not in in_hash]
                if not out:
                    continue
                i = rng.choice(out)
                if rng.random() < 0.5:
                    x, y = rng.choice(cells)
                    set_pos(m, i, x, y)
                    before = read_globals(m)
                rec = m.read_global(PIECES + 14 * i, 14)
                args = [HASH, rec[7], rec[6], i, rec[10] & 0x0F]
                orig_insert(m, *args[1:])
                expect, fn = None, "hashInsert"
                in_hash.add(i)
            elif kind == "remove":
                if not in_hash:
                    continue
                i = rng.choice(sorted(in_hash))
                args = [HASH, i]
                orig_remove(m, i)
                expect, fn = None, "hashRemove"
                in_hash.discard(i)
            else:
                x, y = rng.choice(cells) if rng.random() < 0.9 else (rng.randint(2, 79), rng.randint(2, 59))
                args = [HASH, x, y]
                expect, fn = orig_find(m, x, y), "hashFind"
            after = read_globals(m)
            result, mem, _ = js.call(fn, before, args)
            ops += 1
            problems = diff_globals(after, mem, names)
            if result != expect:
                problems.insert(0, f"result: original {expect}, engine {result}")
            if problems:
                print(f"case {case} op {fn}{tuple(args)}: MISMATCH")
                for p in problems:
                    print("   ", p)
                js.close()
                return False
            write_globals(m, after)
    js.close()
    print(f"{cases} cases, {ops} operations: all match")
    return True


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    s = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sys.exit(0 if run(n, s) else 1)
