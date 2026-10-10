"""Differential test: tools/model/combat.py against the original battle code.

Usage: python3 -I tools/emu/test_combat.py [cases] [seed]

Each case places an attacker next to a defender (sometimes with extra pieces stacked on
the defender's square), picks terrain, strengths, state bits and a PRNG seed at random,
then runs the original attack routine (CODE 3 + 0x0520) in the emulator and the model,
and compares the whole piece table, the PRNG state and the result.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "model"))
from harness import Machine, A5  # noqa: E402
from unicorn.m68k_const import UC_M68K_REG_D7  # noqa: E402
import combat  # noqa: E402

PIECES, PIECE_COUNT, TERRAIN, PRNG, HASH = -0x5138, -0x388E, -0x27D2, -0x127C, -0x5592
RSRC = os.path.join(HERE, "..", "..", "build", "sc301.rsrc")


def make_terrain(cells):
    """cells: {(x, y): value}; everything else water inside an edge ring."""
    nib = [0] * (80 * 60)
    for x in range(1, 81):
        for y in range(1, 61):
            if x in (1, 80) or y in (1, 60):
                nib[(x - 1) * 60 + (y - 1)] = 5
    for (x, y), v in cells.items():
        nib[(x - 1) * 60 + (y - 1)] = v
    out = bytearray(2400)
    for i in range(0, 4800, 2):
        out[i // 2] = (nib[i] & 0xF) | ((nib[i + 1] & 0xF) << 4)
    return out, (lambda x, y: nib[(x - 1) * 60 + (y - 1)])


def rand_piece(rng, ptype, owner, x, y):
    rec = bytearray(rng.getrandbits(8) for _ in range(14))
    rec[6], rec[7] = y, x
    rec[10] = (rec[10] & 0xC0) | ((owner & 3) << 4) | ptype
    strength = rng.choice([1, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 25, 31])
    rec[12] = (rec[12] & 0xE0) | strength
    return rec


def build_case(rng):
    ax, ay = 40, 30
    bx, by = 41, 30
    t_def = rng.choice([0, 0, 1, 2, 3, 3, 4])
    t_att = rng.choice([0, 3, 2])
    terrain_bytes, terrain = make_terrain({(ax, ay): t_att, (bx, by): t_def})
    count = rng.randint(2, 12)
    raw = bytearray(14 * 451)
    for i in range(count + 1, 451):
        raw[i * 14 + 10] = combat.EMPTY
    slots = list(range(1, count + 1))
    rng.shuffle(slots)
    a_idx, b_idx = slots[0], slots[1]
    raw[a_idx * 14:a_idx * 14 + 14] = rand_piece(rng, rng.randrange(8), 1, ax, ay)
    raw[b_idx * 14:b_idx * 14 + 14] = rand_piece(rng, rng.randrange(8), 2, bx, by)
    for i in slots[2:]:
        if rng.random() < 0.6:
            rec = rand_piece(rng, rng.randrange(8), 2, bx, by)
        else:
            rec = rand_piece(rng, rng.randrange(10), rng.randrange(3), rng.randint(2, 79), rng.randint(2, 59))
        raw[i * 14:i * 14 + 14] = rec
    w8 = (raw[b_idx * 14 + 12] >> 6) & 3
    seed = rng.getrandbits(32)
    return raw, count, terrain_bytes, terrain, a_idx, b_idx, w8, seed


def main():
    cases = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    m = Machine(RSRC)
    m.call(2, 0x0004)  # build the combat results table
    hash_table = b"\xff\xff" * 551 + bytes(2)
    mismatches = 0
    stats = {"swapped": 0, "stack_kills": 0}
    for n in range(cases):
        raw, count, tbytes, terrain, a_idx, b_idx, w8, seed = build_case(rng)
        m.write_global(PIECES, raw)
        m.write_global(PIECE_COUNT, count.to_bytes(2, "big"))
        m.write_global(TERRAIN, tbytes)
        m.write_global(PRNG, seed.to_bytes(4, "big"))
        m.write_global(HASH, hash_table)
        m.write_global(HASH + 0x44E, (550).to_bytes(2, "big"))
        stale = rng.randrange(8)
        m.uc.reg_write(UC_M68K_REG_D7, stale)
        a_ptr, b_ptr = A5 + PIECES + 14 * a_idx, A5 + PIECES + 14 * b_idx
        res_emu = m.call(3, 0x0520, args=[("l", a_ptr), ("l", b_ptr), ("w", a_idx), ("w", b_idx), ("w", w8)],
                         result="b")
        emu_raw = m.read_global(PIECES, 14 * 451)
        emu_seed = int.from_bytes(m.read_global(PRNG, 4), "big")

        model_raw = bytearray(raw)
        pieces = combat.Pieces(model_raw, count)
        prng = combat.GamePRNG(seed)
        res_model = combat.attack(pieces, a_idx, b_idx, w8, terrain, prng, stale_d7=stale)
        A, B = combat.Pieces(raw, count).rec(a_idx), combat.Pieces(raw, count).rec(b_idx)
        if A.type in combat.SHIPS and B.type == combat.SUBMARINE and w8 == 0:
            stats["swapped"] += 1
        if bytes(model_raw) != emu_raw or prng.seed != emu_seed or bool(res_emu) != bool(res_model):
            mismatches += 1
            if mismatches <= 5:
                print(f"case {n}: A#{a_idx} type {A.type} str {A.strength}  B#{b_idx} type {B.type} str {B.strength} "
                      f"w8 {w8} terrain(B) {terrain(41, 30)} seed {seed:#x}")
                print(f"   result emu {res_emu} model {res_model}; seed emu {emu_seed:#x} model {prng.seed:#x}")
                for i in range(1, count + 1):
                    e, mo = emu_raw[i * 14:i * 14 + 14], bytes(model_raw[i * 14:i * 14 + 14])
                    if e != mo:
                        print(f"   slot {i}: emu {e.hex(' ')}  model {mo.hex(' ')}  start {raw[i*14:i*14+14].hex(' ')}")
    print(f"{cases} cases, {mismatches} mismatches; role swaps exercised: {stats['swapped']}")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
