"""Differential test: engine/src/turn.ts (a player's whole turn) against the original
PlayerTurn (CODE 5 + 0x42D4).

Usage: python3 -I tools/emu/test_turn.py [cases] [seed] [--verbose]

Each case builds a random but plausible world around a small box (land and sea, cities
of both sides, pieces of every type with assorted states, orders, fuel and damage), then
runs one player's turn in the original and in the engine with the same scripted
controller: each direction request takes the next action from a shared list (a direction,
sleep, go-to orders, defer, or end moves). The whole globals image, the requests (fields
the request sites set), messages, beeps and computer-opponent calls are compared.

User-interface routines with no game effect are stubbed in the original: the battle
message composer (CODE 5 + 0x02B4). The computer opponent's planning (CODE 7 + 0x11EA)
and new-piece handler (CODE 1 + 0x0626) are stubbed and their calls compared. Two
uninitialised variables the original reads (quirks Q9 and Q11) are zeroed, matching the
engine's stand-ins.
"""
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import A5, Diff, LAND, WATER, EDGE, UI_GLOBALS  # noqa: E402
from jsbridge import GLOBALS_SIZE, read_globals  # noqa: E402
from unicorn import UC_HOOK_CODE  # noqa: E402
from unicorn.m68k_const import UC_M68K_REG_A6, UC_M68K_REG_A7, UC_M68K_REG_PC  # noqa: E402

PIECES, PIECE_COUNT, CITIES, TERRAIN, CITY_COUNT = -0x5138, -0x388E, -0x385E, -0x27D2, -0x1E4F
PLAYER_MAPS, GAME_MODE, DAY, LOCAL_PLAYER, SKILL = -0x2CD8, -0x1E71, -0x2D08, -0x2D0A, -0x2CE6
PIECE_DEFERRED, PIECE_DONE = -0x120B, -0x120A

# Request fields compared, by request code (bytes of the 12-byte record). Fields a request
# site does not set hold stack garbage in the original.
FIELDS = {3: (0, 1), 20: (0, 1), 5: (0, 1, 4, 5, 6, 7, 8, 9), 6: (0, 1, 4, 5)}
DEFAULT_FIELDS = (0, 1, 4, 5, 8, 9)

MAX_STR = {0: 1, 1: 1, 2: 4, 3: 3, 4: 10, 5: 3, 6: 18, 7: 1}


class Recorder:
    """Stubs and logs on the original side."""

    def __init__(self, d):
        self.d = d
        self.m = d.m
        self.log = []
        self.actions = []
        self.next = 0
        self.track = False
        m = self.m
        self._stub(5, 0x5CBA, 12, lambda sp: self.on_request(sp))
        self._stub(1, 0x3520, 12, self.on_msg_a)
        self._stub(1, 0x35E2, 14, self.on_msg_b)
        self._stub(1, 0x0928, 2, self.on_beep)
        self._stub(5, 0x02B4, 4, lambda sp: None)
        self._stub(7, 0x11EA, 0, lambda sp: self.log.append(["aiPlan"]))
        self._stub(1, 0x0626, 2, lambda sp: self.log.append(["aiNewPiece", m.r8(sp + 4)]))

        # MoveArmy passes an uninitialised local record to the exploration routine after a
        # capture (quirk Q9); zero it so the original matches the engine's stand-in.
        def zero_stray(uc, address, size, _):
            a6 = uc.reg_read(UC_M68K_REG_A6)
            uc.mem_write(a6 - 0x3C, bytes(14))
        m.uc.hook_add(UC_HOOK_CODE, zero_stray, begin=m.addr(5, 0x2C98), end=m.addr(5, 0x2C98))

        # The movers' direction variables are uninitialised; orderStep() leaves them unset
        # when a computer player's piece under orders has an enemy beside it, and the step
        # is then taken in a direction made of stack leftovers (quirk Q11). The engine uses
        # (0, 0), the usual leftover; zero them in the original too.
        def zero_dir(offset):
            def hook(uc, address, size, _):
                a6 = uc.reg_read(UC_M68K_REG_A6)
                uc.mem_write(a6 - offset, bytes(2))
            return hook
        for site, off in ((0x26D2, 0x16), (0x2F44, 0x12), (0x35CC, 0x12), (0x389E, 0x12), (0x39EC, 0x12),
                          (0x3B6E, 0x12), (0x3E5A, 0x12), (0x3FE2, 0x12)):
            m.uc.hook_add(UC_HOOK_CODE, zero_dir(off), begin=m.addr(5, site), end=m.addr(5, site))

    def _stub(self, seg, off, pop, fn):
        m = self.m
        addr = m.addr(seg, off)

        def hook(uc, address, size, _):
            sp = uc.reg_read(UC_M68K_REG_A7)
            ret = m.r32(sp)
            fn(sp)
            uc.reg_write(UC_M68K_REG_A7, sp + 4 + pop)
            uc.reg_write(UC_M68K_REG_PC, ret)
        m.uc.hook_add(UC_HOOK_CODE, hook, begin=addr, end=addr)

    def digest(self):
        data = bytearray(read_globals(self.m))
        for off, size in UI_GLOBALS:
            data[off + GLOBALS_SIZE:off + GLOBALS_SIZE + size] = bytes(size)
        h = 0x811C9DC5
        for b in data:
            h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
        return h

    def on_request(self, sp):
        m = self.m
        req, buf = m.r32(sp + 12), m.r32(sp + 8)
        rec = list(m.uc.mem_read(req, 12))
        self.log.append(["req", rec, self.digest() if self.track else 0])
        if rec[0] != 5:
            return
        a = self.actions[self.next] if self.next < len(self.actions) else ["dir", 0, 0]
        self.next += 1
        idx = (rec[8] << 8) | rec[9]
        x, y = struct.unpack("b", bytes([rec[5]]))[0], struct.unpack("b", bytes([rec[4]]))[0]
        p = A5 + PIECES + 14 * idx
        if a[0] == "dir":
            m.uc.mem_write(buf, bytes([a[1] & 0xFF, a[2] & 0xFF]))
            return
        m.uc.mem_write(buf, bytes(2))
        if a[0] == "sleep":
            b = m.r8(p + 11)
            m.w8(p + 11, (b & 0x3F) | 0x80)
        elif a[0] == "goto":
            tx, ty = x + a[1], y + a[2]
            r = bytearray(m.uc.mem_read(p, 14))
            r[4], r[5] = r[6], r[7]
            r[3], r[2] = tx & 0xFF, ty & 0xFF
            r[11] = (r[11] & 0xE7) | 0x10
            r[11] &= 0x3F
            r[11] &= 0xDF
            r[11] &= 0xFE
            if (r[10] & 0x0F) != 5:
                r[0], r[1] = r[6], r[7]
            m.uc.mem_write(p, bytes(r))
        elif a[0] == "defer":
            m.write_global(PIECE_DEFERRED, b"\x01")
        elif a[0] == "done":
            m.write_global(PIECE_DONE, b"\x01")

    def on_msg_a(self, sp):
        m = self.m
        msg, line, player, all_, wait = m.r32(sp + 12), m.r16(sp + 10), m.r8(sp + 8), m.r8(sp + 6), m.r8(sp + 4)
        s1 = struct.unpack(">h", struct.pack(">H", msg >> 16))[0]
        self.log.append(["msg", msg & 0xFFFF, s1, -1, line, player, all_, wait])

    def on_msg_b(self, sp):
        m = self.m
        msg, flags, player, all_, wait = m.r32(sp + 14), m.r32(sp + 10), m.r8(sp + 8), m.r8(sp + 6), m.r8(sp + 4)
        s1 = struct.unpack(">h", struct.pack(">H", msg >> 16))[0]
        s2 = struct.unpack(">h", struct.pack(">H", flags & 0xFFFF))[0]
        self.log.append(["msg", msg & 0xFFFF, s1, s2, flags >> 16, player, all_, wait])

    def on_beep(self, sp):
        self.log.append(["beep", self.m.r8(sp + 4)])


def build_world(d, rng):
    """A random world for movement: returns (box, player)."""
    m = d.m
    x0, y0 = rng.randint(2, 64), rng.randint(2, 44)
    if rng.random() < 0.15:
        x0 = rng.choice([2, 66])
    if rng.random() < 0.15:
        y0 = rng.choice([2, 46])
    x1, y1 = min(79, x0 + 13), min(59, y0 + 13)
    nib = [WATER] * 4800
    for x in range(1, 81):
        for y in range(1, 61):
            if x in (1, 80) or y in (1, 60):
                nib[(x - 1) * 60 + (y - 1)] = EDGE
    # a few land blobs
    for _ in range(rng.randint(1, 4)):
        cx, cy, r = rng.randint(x0, x1), rng.randint(y0, y1), rng.randint(1, 4)
        for x in range(cx - r, cx + r + 1):
            for y in range(cy - r, cy + r + 1):
                if 1 < x < 80 and 1 < y < 60 and rng.random() < 0.85:
                    nib[(x - 1) * 60 + (y - 1)] = LAND
    land = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) if nib[(x - 1) * 60 + (y - 1)] == LAND]
    rng.shuffle(land)
    cities = land[:rng.randint(0, min(8, len(land)))]
    craw = bytearray(460)
    city_owner = {}
    for i, (x, y) in enumerate(cities, start=1):
        owner = rng.choice([0, 1, 2, 1, 2])
        nib[(x - 1) * 60 + (y - 1)] = 1 << owner
        rec = bytearray(10)
        rec[6], rec[7] = y, x
        rec[0], rec[1] = (y, x) if rng.random() < 0.7 else (rng.randint(y0, y1), rng.randint(x0, x1))
        rec[2], rec[3] = (y, x) if rng.random() < 0.7 else (rng.randint(y0, y1), rng.randint(x0, x1))
        rec[4] = owner
        rec[5] = rng.choice([1, 1, 2, 3, 9])
        rec[8] = rng.randint(0, 7)
        rec[9] = rng.getrandbits(8)
        craw[10 * i:10 * i + 10] = rec
        city_owner[(x, y)] = owner
    tb = bytearray(2400)
    for i in range(0, 4800, 2):
        tb[i // 2] = (nib[i] & 0xF) | ((nib[i + 1] & 0xF) << 4)
    m.write_global(TERRAIN, tb)
    m.write_global(CITIES, craw)
    m.write_global(CITY_COUNT, bytes([len(cities)]))

    def t(x, y):
        return nib[(x - 1) * 60 + (y - 1)]
    water = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) if t(x, y) == WATER]
    anywhere = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) if t(x, y) != EDGE]
    variant = rng.choice(["mixed", "mixed", "mixed", "boarding", "carriers", "full"])
    n = {"mixed": rng.randint(1, 40), "boarding": rng.randint(8, 40), "carriers": rng.randint(8, 40),
         "full": 449}[variant]
    type_pool = {"mixed": [0, 0, 0, 0, 1, 1, 2, 3, 4, 5, 5, 6, 7], "boarding": [0, 0, 0, 0, 0, 5, 5, 2],
                 "carriers": [1, 1, 1, 4, 4, 7, 2, 0], "full": [0, 0, 0, 1, 2, 3, 4, 5, 6, 7]}[variant]
    raw = bytearray(14 * 451)
    for i in range(1, 451):
        raw[14 * i + 10] = 9
    placed = []
    for i in range(1, n + 1):
        ptype = rng.choice(type_pool)
        owner = rng.choice([1, 2])
        if variant == "full" and i > 40:
            # far from the action: anywhere on the map, mostly asleep
            x, y = rng.randint(2, 79), rng.randint(2, 59)
            r = bytearray(14)
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7] = y, x, y, x, y, x, y, x
            r[10] = (owner << 4) | ptype
            r[11] = 0x80 if rng.random() < 0.9 else 0x40
            r[12] = (rng.choice([0, 0, 1]) << 6) | MAX_STR[ptype]
            w8 = (20 << 5) if ptype == 1 else (30 << 5) if ptype == 7 else 0
            r[8], r[9] = w8 >> 8, w8 & 0xFF
            raw[14 * i:14 * i + 14] = r
            continue
        own_cities = [c for c, o in city_owner.items() if o == owner]
        if variant == "boarding" and ptype == 0 and placed and rng.random() < 0.6:
            ships = [(px, py) for (pt, po, px, py) in placed if pt == 5 and po == owner]
            if ships:
                sx, sy = rng.choice(ships)
                x, y = min(79, max(2, sx + rng.choice([-1, 0, 1]))), min(59, max(2, sy + rng.choice([-1, 0, 1])))
            else:
                x, y = rng.choice(land or anywhere)
        elif variant == "carriers" and ptype == 1 and placed and rng.random() < 0.6:
            car = [(px, py) for (pt, po, px, py) in placed if pt == 4 and po == owner]
            if car:
                sx, sy = rng.choice(car)
                x, y = min(79, max(2, sx + rng.choice([-1, 0, 1]))), min(59, max(2, sy + rng.choice([-1, 0, 1])))
            else:
                x, y = rng.choice(anywhere)
        elif ptype in (0,) and placed and rng.random() < 0.2:
            # Armies aboard a Transport
            ships = [(px, py) for (pt, po, px, py) in placed if pt == 5 and po == owner]
            x, y = rng.choice(ships) if ships else rng.choice(land or anywhere)
        elif ptype == 1 and rng.random() < 0.2:
            car = [(px, py) for (pt, po, px, py) in placed if pt == 4 and po == owner]
            x, y = rng.choice(car) if car else rng.choice(anywhere)
        elif ptype == 0:
            x, y = rng.choice(land + own_cities) if (land or own_cities) else rng.choice(anywhere)
        elif ptype in (2, 3, 4, 5, 6):
            x, y = rng.choice(water + own_cities) if (water or own_cities) else rng.choice(anywhere)
        else:
            x, y = rng.choice(anywhere)
        placed.append((ptype, owner, x, y))
        r = bytearray(14)
        r[6], r[7] = y, x
        r[4], r[5] = y, x
        r[0], r[1] = y, x
        r[2], r[3] = y, x
        state = rng.choice([1, 1, 1, 1, 0, 2, 3]) if ptype == 5 else rng.choice([1, 1, 1, 0, 0, 2])
        if variant == "boarding" and ptype == 5:
            state = rng.choice([3, 3, 1, 0])
        orders = 0
        if state == 0:
            orders = rng.choice([2, 2, 2, 0, 1, 3])
            r[2], r[3] = rng.randint(max(2, y0 - 6), min(59, y1 + 6)), rng.randint(max(2, x0 - 6), min(79, x1 + 6))
            if rng.random() < 0.5:
                r[4], r[5] = rng.randint(y0, y1), rng.randint(x0, x1)
            if rng.random() < 0.15:
                r[11] |= 0x01           # patrol
                r[0], r[1] = rng.randint(y0, y1), rng.randint(x0, x1)
            if rng.random() < 0.1:
                r[11] |= 0x20           # random moves
        r[11] |= (orders << 3) | (state << 6)
        if rng.random() < 0.1:
            r[11] |= 0x04               # already moved
        cargo = 0
        if ptype == 1:
            cargo = rng.choice([20, 15, 10, 5, 2, 1, 0])
        elif ptype == 7:
            cargo = rng.choice([30, 20, 16, 15, 5, 1, 0])
        elif ptype in (4, 5):
            cargo = rng.randint(0, 6)
            if variant == "boarding" and ptype == 5:
                cargo = rng.choice([5, 6, 6, 4])
        step = rng.choice([0, 0, 0, 1, 2])
        radius = rng.randint(0, 3) if ptype == 7 else rng.randint(0, 2)
        w8 = (radius << 10) | (cargo << 5) | step
        r[8], r[9] = w8 >> 8, w8 & 0xFF
        b10hi = rng.choice([0, 0, 0, 0, 1, 2])
        r[10] = (b10hi << 6) | (owner << 4) | ptype
        strength = rng.randint(1, MAX_STR[ptype]) if rng.random() < 0.4 else MAX_STR[ptype]
        spotted = rng.choice([0, 0, 1, 2])
        r[12] = (spotted << 6) | strength
        r[13] = rng.choice([0, 0, 1])
        raw[14 * i:14 * i + 14] = r
    if rng.random() < 0.3:
        raw[14 * 1 + 10] = (raw[14 * 1 + 10] & 0xF0) | 8   # a removed piece in the table
    m.write_global(PIECES, raw)
    m.write_global(PIECE_COUNT, n.to_bytes(2, "big"))
    maps = bytearray(1284)
    for i in range(0, 640):
        maps[i] = rng.getrandbits(8) if rng.random() < 0.5 else 0
        maps[642 + i] = rng.getrandbits(8) if rng.random() < 0.5 else 0
    player = rng.choice([1, 2])
    maps[640] = 0
    maps[642 + 640] = 0
    if rng.random() < 0.2:
        maps[640 if player == 2 else 642 + 640] = 1     # the opponent is the computer
    if rng.random() < 0.15:
        maps[640 if player == 1 else 642 + 640] = 1     # the mover is the computer (AI stubbed)
    m.write_global(PLAYER_MAPS, maps)
    m.write_global(GAME_MODE, bytes([rng.choice([0, 0, 1, 3])]))
    m.write_global(DAY, rng.choice([1, 5, 20, 31, 45, 70, 140]).to_bytes(2, "big"))
    m.write_global(LOCAL_PLAYER, bytes([rng.choice([1, 2])]))
    m.write_global(SKILL, bytes([rng.randint(1, 5)]))
    m.write_global(-0x127C, rng.getrandbits(32).to_bytes(4, "big"))
    m.write_global(-0x23A, rng.randint(1, 0x7FFFFFFE).to_bytes(4, "big"))
    m.write_global(-0x28D, bytes([rng.randint(0, 15)]))
    m.write_global(-0x1277, b"\x01")
    m.call(4, 0x259A)
    return (x0, y0, x1, y1), player


def actions_for(rng, n=400):
    out = []
    for _ in range(n):
        r = rng.random()
        if r < 0.80:
            out.append(["dir", rng.choice([-1, 0, 1]), rng.choice([-1, 0, 1])])
        elif r < 0.86:
            out.append(["goto", rng.randint(-8, 8), rng.randint(-8, 8)])
        elif r < 0.90:
            out.append(["sleep"])
        elif r < 0.95:
            out.append(["defer"])
        else:
            out.append(["done"])
    # Repeat some directions back to back so warnings get confirmed.
    for i in range(1, len(out)):
        if out[i - 1][0] == "dir" and rng.random() < 0.25:
            out[i] = list(out[i - 1])
    return out


def compare_logs(a, b):
    """First difference between the original's log `a` and the engine's `b`, or None."""
    ea = [e for e in a if e[0] in ("req", "msg", "beep", "aiPlan", "aiNewPiece")]
    eb = [e for e in b if e[0] in ("req", "msg", "beep", "aiPlan", "aiNewPiece")]
    for i, (x, y) in enumerate(zip(ea, eb)):
        if x[0] != y[0]:
            return i, x, y
        if x[0] == "req":
            fields = FIELDS.get(x[1][0], DEFAULT_FIELDS)
            if [x[1][k] for k in fields] != [y[1][k] for k in fields]:
                return i, x, y
            if x[2] and x[2] != y[2]:
                return i, x, ["state differs before this request"] + list(y)
        elif x != y:
            return i, x, y
    if len(ea) != len(eb):
        i = min(len(ea), len(eb))
        return i, ea[i] if i < len(ea) else None, eb[i] if i < len(eb) else None
    return None


def run(cases, seed, verbose=False, track=False):
    rng = random.Random(seed)
    d = Diff()
    rec = Recorder(d)
    rec.track = track
    m = d.m
    for case in range(cases):
        box, player = build_world(d, rng)
        actions = actions_for(rng)
        before = read_globals(m)
        rec.log, rec.actions, rec.next = [], actions, 0
        m.call(5, 0x42D4, args=[("b", player), ("b", 0)], max_insns=200_000_000)
        after = read_globals(m)
        result, mem, log = d.js.call("playerTurn", before, [player, actions, UI_GLOBALS if rec.track else []])
        problems = []
        diff = compare_logs(rec.log, log)
        if diff:
            i, x, y = diff
            problems.append(f"log entry {i}: original {x}, engine {y}")
        for k, (a, b) in enumerate(zip(after, mem)):
            off = k - GLOBALS_SIZE
            if a != b and off not in d.ignore:
                name = d.names(off)
                problems.append(f"A5{off:+#06x}{' ' + name if name else ''}: original {a:#04x}, engine {b:#04x}")
                if len(problems) > 14:
                    problems.append("...")
                    break
        d.count += 1
        if problems:
            print(f"MISMATCH case {case} (player {player}, box {box}):")
            for p in problems:
                print("   ", p)
            if verbose:
                ea = [e for e in rec.log if e[0] in ("req", "msg", "beep", "aiPlan", "aiNewPiece")]
                for e in ea[:80]:
                    print("      ", e)
            return False
    print(f"{cases} turns: all match")
    return True


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 50
    s = int(args[1]) if len(args) > 1 else 1
    sys.exit(0 if run(n, s, "--verbose" in sys.argv, "--track" in sys.argv) else 1)
