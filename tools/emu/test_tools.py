"""Differential test: engine helpers used by movement against the original routines.

Usage: python3 -I tools/emu/test_tools.py [cases] [seed]

Each case generates a random world (difftest.random_world) and checks every helper on
random arguments: lookups around cells, boarding checks, counting, exploration, moving a
piece, carrying cargo, waking, go-to orders and compaction of the piece table.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import A5, Diff, HASH, TERRAIN  # noqa: E402


def run(cases, seed):
    rng = random.Random(seed)
    d = Diff()
    m = d.m
    for case in range(cases):
        w = d.random_world(rng)
        x0, y0, x1, y1 = w.box
        base = d.snapshot()

        def cell():
            if w.pieces and rng.random() < 0.7:
                _, _, _, x, y = rng.choice(w.pieces)
                return x + rng.choice([-1, 0, 0, 1]), y + rng.choice([-1, 0, 0, 1])
            return rng.randint(x0, x1), rng.randint(y0, y1)

        checks = []
        for _ in range(6):
            x, y = cell()
            s = rng.getrandbits(16) & 0x003F
            checks.append(("terrainNear", lambda x=x, y=y, s=s: m.call(
                1, 0x28C6, args=[("l", A5 + TERRAIN), ("w", x), ("w", y), ("w", s)], result="b"),
                "terrainNear", [x, y, s]))
            player = rng.choice([1, 2])
            checks.append(("enemyAdjacent", lambda x=x, y=y, p=player: m.call(
                4, 0x12C4, args=[("w", x), ("w", y), ("b", p), ("w", 0)], result="b"),
                "enemyAdjacent", [0, player, x, y]))
            ts, os_ = rng.getrandbits(10), rng.choice([2, 4, 6, 1, 7])
            checks.append(("topIs", lambda x=x, y=y, ts=ts, os_=os_: m.call(
                4, 0x0C96, args=[("w", x), ("w", y), ("w", ts), ("w", os_)], result="b"),
                "topIs", [x, y, ts, os_]))
            ptype = rng.choice([0, 0, 1, 2])
            checks.append(("boardingFull", lambda x=x, y=y, p=player, t=ptype: m.call(
                4, 0x0D20, args=[("w", x), ("w", y), ("b", p), ("b", t)], result="b"),
                "boardingFull", [x, y, player, ptype]))
            cargo, sc, upd, obs = rng.randint(0, 31), rng.choice([0, 1]), rng.choice([0, 1]), rng.randint(0, 9)
            checks.append(("countAt", lambda x=x, y=y, os_=os_, ts=ts, c=cargo, sc=sc, u=upd, o=obs: m.call(
                4, 0x03A2, args=[("l", A5 + HASH), ("w", x), ("w", y), ("w", os_), ("w", ts), ("w", c),
                                 ("b", sc), ("b", u), ("b", o)], result="w"),
                "countAt", [HASH, x, y, os_, ts, cargo, sc, upd, obs]))
            checks.append(("ownPiecesAt", lambda x=x, y=y, p=player: m.call(
                4, 0x24FC, args=[("w", x), ("w", y), ("b", p)], result="w"),
                "ownPiecesAt", [x, y, player]))
            checks.append(("wakeAllAt", lambda x=x, y=y: m.call(4, 0x0DD4, args=[("w", x), ("w", y)]),
                           "wakeAllAt", [x, y]))
            checks.append(("wakeAdjacent", lambda x=x, y=y, p=player, ts=ts: m.call(
                4, 0x08D4, args=[("w", x), ("w", y), ("b", p), ("w", ts), ("w", 1)]),
                "wakeAdjacent", [x, y, player, ts, 1]))
        if w.pieces:
            for _ in range(4):
                idx, ptype, owner, px, py = rng.choice(w.pieces)
                checks.append(("explore", lambda i=idx, x=px, y=py, o=owner: m.call(
                    4, 0x0500, args=[("b", o), ("w", x), ("w", y), ("l", A5 - 0x5138 + 14 * i)], result="b"),
                    "explore", [idx, px, py, owner]))
                dx, dy = rng.choice([-1, 0, 1]), rng.choice([-1, 0, 1])
                nx, ny = px + dx, py + dy
                checks.append(("movePiece", lambda i=idx, x=nx, y=ny, dx=dx: m.call(
                    4, 0x082A, args=[("l", A5 - 0x5138 + 14 * i), ("w", x), ("w", y), ("w", i), ("w", dx)]),
                    "movePiece", [idx, nx, ny, dx]))
                checks.append(("carryCargo", lambda i=idx, ox=px, oy=py, x=nx, y=ny: m.call(
                    4, 0x0F2C, args=[("w", ox), ("w", oy), ("w", x), ("w", y), ("w", i)]),
                    "carryCargo", [px, py, nx, ny, idx]))
                tx, ty = cell()
                checks.append(("setDestination", lambda i=idx, x=tx, y=ty: m.call(
                    1, 0x06AC, args=[("l", A5 - 0x5138 + 14 * i), ("w", x), ("w", y)]),
                    "setDestination", [idx, tx, ty]))
        if rng.random() < 0.5 and w.pieces:
            # Mark a few pieces removed, then compact.
            raw = bytearray(m.read_global(-0x5138, 14 * 451))
            for idx, *_ in rng.sample(w.pieces, k=min(len(w.pieces), rng.randint(1, 5))):
                raw[14 * idx + 10] = (raw[14 * idx + 10] & 0xF0) | 8
            m.write_global(-0x5138, raw)
            base = d.snapshot()
            checks.append(("compact", lambda: m.call(4, 0x259A), "compactPieces", []))

        for label, orig, fn, args in checks:
            d.restore(base)
            if not d.check(f"case {case} {label}", orig, fn, args, result_map=lambda r: (1 if r is True else 0 if r is False else r)):
                return False
    print(f"{cases} cases, {d.count} checks: all match")
    return True


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    s = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sys.exit(0 if run(n, s) else 1)
