"""Differential test: combat.bomber_blast against the original (CODE 3 + 0x0A30).

Usage: python3 -I tools/emu/test_bomber.py [cases] [seed]
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "model"))
from harness import Machine, A5  # noqa: E402
import combat  # noqa: E402
from test_combat import RSRC  # noqa: E402

PIECES, PIECE_COUNT, TERRAIN, CITIES, CITY_COUNT, HASH = -0x5138, -0x388E, -0x27D2, -0x385E, -0x1E4F, -0x5592


def main():
    cases = int(sys.argv[1]) if len(sys.argv) > 1 else 500
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    m = Machine(RSRC)
    bad = 0
    for n in range(cases):
        nib = [0] * 4800
        def cell(x, y): return nib[(x - 1) * 60 + (y - 1)]
        def set_cell(x, y, v): nib[(x - 1) * 60 + (y - 1)] = v
        for x in range(1, 81):
            for y in range(1, 61):
                set_cell(x, y, 5 if x in (1, 80) or y in (1, 60) else rng.choice([0, 0, 3]))
        bx, by = rng.randint(10, 70), rng.randint(10, 50)
        cities = bytearray(460)
        for c in range(1, 46):
            cx, cy = bx + rng.randint(-8, 8), by + rng.randint(-8, 8)
            owner = rng.randrange(3)
            cities[c * 10:c * 10 + 10] = bytes([cy, cx, cy, cx, owner, rng.randrange(20), cy, cx,
                                                 rng.randrange(8), rng.randrange(1, 15)])
            set_cell(cx, cy, 1 << owner)
        count = rng.randint(5, 60)
        raw = bytearray(14 * 451)
        for i in range(count + 1, 451):
            raw[i * 14 + 10] = combat.EMPTY
        for i in range(1, count + 1):
            rec = bytearray(rng.getrandbits(8) for _ in range(14))
            if rng.random() < 0.3 and i > 1:
                src = rng.randint(1, i - 1)
                rec[6], rec[7] = raw[src * 14 + 6], raw[src * 14 + 7]
            else:
                rec[6], rec[7] = by + rng.randint(-8, 8), bx + rng.randint(-8, 8)
            rec[10] = (rec[10] & 0xC0) | (rng.randrange(1, 3) << 4) | rng.randrange(10)
            raw[i * 14:i * 14 + 14] = rec
        b_idx = rng.randint(1, count)
        raw[b_idx * 14 + 6], raw[b_idx * 14 + 7] = by, bx
        raw[b_idx * 14 + 10] = (raw[b_idx * 14 + 10] & 0xF0) | combat.BOMBER
        raw[b_idx * 14 + 8] = (rng.randrange(0, 8) << 2) | (raw[b_idx * 14 + 8] & 3)
        tb = bytearray(2400)
        for i in range(0, 4800, 2):
            tb[i // 2] = nib[i] | (nib[i + 1] << 4)

        m.write_global(PIECES, raw)
        m.write_global(PIECE_COUNT, count.to_bytes(2, "big"))
        m.write_global(TERRAIN, tb)
        m.write_global(CITIES, cities)
        m.write_global(CITY_COUNT, bytes([45]))
        m.write_global(HASH, b"\xff\xff" * 551 + bytes(2))
        m.write_global(HASH + 0x44E, (550).to_bytes(2, "big"))
        m.call(3, 0x0A30, args=[("l", A5 + PIECES + 14 * b_idx), ("w", b_idx)])
        e_pieces, e_cities, e_terr = (m.read_global(PIECES, 14 * 451), m.read_global(CITIES, 460),
                                      m.read_global(TERRAIN, 2400))

        mp = combat.Pieces(bytearray(raw), count)
        mc = bytearray(cities)
        combat.bomber_blast(mp, mp.rec(b_idx), mc, 45, cell, set_cell)
        mt = bytearray(2400)
        for i in range(0, 4800, 2):
            mt[i // 2] = nib[i] | (nib[i + 1] << 4)
        if bytes(mp.raw) != e_pieces or bytes(mc) != e_cities or bytes(mt) != e_terr:
            bad += 1
            if bad <= 3:
                print(f"case {n}: pieces {'ok' if bytes(mp.raw) == e_pieces else 'DIFF'} "
                      f"cities {'ok' if bytes(mc) == e_cities else 'DIFF'} terrain {'ok' if bytes(mt) == e_terr else 'DIFF'}")
    print(f"{cases} bomber cases, {bad} mismatches")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
