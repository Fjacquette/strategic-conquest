"""Differential test: engine/src/savefile.ts (saved games) against the original's save
writer (CODE 10 + 0x0492) and loader (CODE 1 + 0x09D2).

Usage: python3 -I tools/emu/test_savefile.py [cases] [seed] [--verbose]

Saving: on random game states, the bytes the original writes through the File Manager are
compared with the engine's saveGame().

Loading: real saved games from saves/3.01, and variations of them (another seed, skill
level, game mode, day, piece count and piece records), are loaded over stale state by the
original and by the engine's loadGame(). The original runs as if the file had been chosen
already (as when a saved game is opened from the Finder), so the standard file dialog is
skipped. Map generation runs on the QuickDraw traps of quickdraw.py. Requests (the
hand-off screen, and the password checks with two players) and the globals image are
compared.

The File Manager is simulated: one open file, read and written sequentially.
"""
import glob
import os
import random
import sys

from unicorn import UC_HOOK_CODE
from unicorn.m68k_const import UC_M68K_REG_A0, UC_M68K_REG_A6, UC_M68K_REG_D0

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff  # noqa: E402
from harness import TrapError  # noqa: E402
from jsbridge import GLOBALS_SIZE, read_globals  # noqa: E402
from quickdraw import QuickDraw  # noqa: E402
from test_newgame import IGNORED, NewGameRecorder, compare, fresh_stack, stale  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
GAME_SEED, GAME_MODE, SKILL, DAY = -0x1E70, -0x1E71, -0x2CE6, -0x2D08
FILE_CHOSEN, REPLY_GOOD, REPLY_NAME = -0x1400, -0x13FE, -0x13F4
SAVE_SIZE = 11381
# File offsets of fields the variations change.
F_SEED, F_MODE, F_SKILL, F_DAY, F_PIECES, F_MODE2, F_PIECE_COUNT = 0, 4, 5, 6, 2408, 10006, 10467


class FileSystem:
    """One file, read or written sequentially through the File Manager's traps."""

    def __init__(self, m):
        self.m = m
        self.data = bytearray()
        self.pos = 0
        # Close, Create, GetFileInfo, SetFileInfo, SetEOF, FlushVol, SetFPos succeed.
        for trap in (0x01, 0x08, 0x0C, 0x0D, 0x12, 0x13, 0x44):
            m.os_traps[trap] = self._ok
        m.os_traps[0x00] = self._open
        m.os_traps[0x02] = self._read
        m.os_traps[0x03] = self._write

    def _pb(self):
        return self.m.uc.reg_read(UC_M68K_REG_A0)

    def _result(self, err):
        m = self.m
        m.w16(self._pb() + 16, err)
        m.uc.reg_write(UC_M68K_REG_D0, err & 0xFFFFFFFF)

    def _ok(self):
        self._result(0)

    def _open(self):
        self.pos = 0
        self.m.w16(self._pb() + 24, 7)          # ioRefNum
        self._result(0)

    def _read(self):
        m, pb = self.m, self._pb()
        buf, n = m.r32(pb + 32), m.r32(pb + 36)
        chunk = bytes(self.data[self.pos:self.pos + n])
        m.uc.mem_write(buf, chunk)
        self.pos += len(chunk)
        m.w32(pb + 40, len(chunk))
        self._result(0 if len(chunk) == n else -39)

    def _write(self):
        m, pb = self.m, self._pb()
        buf, n = m.r32(pb + 32), m.r32(pb + 36)
        self.data[self.pos:self.pos + n] = bytes(m.uc.mem_read(buf, n))
        self.pos += n
        m.w32(pb + 40, n)
        self._result(0)


def real_saves():
    out = []
    for path in sorted(glob.glob(os.path.join(ROOT, "saves", "3.01", "*.sav"))):
        with open(path, "rb") as f:
            data = f.read()
        if len(data) == SAVE_SIZE:
            out.append((os.path.basename(path), data))
    return out


def variation(rng, data):
    """A saved game changed in ways the loader must handle like the original."""
    d = bytearray(data)
    notes = []
    if rng.random() < 0.5:
        d[F_SEED:F_SEED + 4] = rng.getrandbits(32).to_bytes(4, "big")
        notes.append("seed")
    if rng.random() < 0.4:
        d[F_SKILL] = rng.randint(1, 15)
        notes.append(f"skill {d[F_SKILL]}")
    if rng.random() < 0.4:
        d[F_MODE] = d[F_MODE2] = rng.choice([0, 1])
        notes.append(f"mode {d[F_MODE]}")
    if rng.random() < 0.3:
        d[F_DAY:F_DAY + 2] = rng.randint(1, 400).to_bytes(2, "big")
    if rng.random() < 0.4:
        for _ in range(rng.randint(1, 30)):        # pieces destroyed, or slots emptied
            k = rng.randint(1, 450)
            off = F_PIECES + 14 * k + 10
            d[off] = (d[off] & 0xF0) | rng.choice([8, 9])
        notes.append("removed pieces")
    if rng.random() < 0.2:
        d[F_PIECE_COUNT:F_PIECE_COUNT + 2] = rng.randint(0, 450).to_bytes(2, "big")
        notes.append("piece count")
    return bytes(d), notes


def check_saves(d, fs, rng, cases, verbose):
    m = d.m
    bad = 0
    for i in range(cases):
        stale(d, rng)
        for off, size in ((GAME_SEED, 4), (DAY, 2), (-0x1BFC, 352), (-0x0F86, 352), (-0x2CE4, 12)):
            m.write_global(off, bytes(rng.getrandbits(8) for _ in range(size)))
        m.write_global(GAME_MODE, bytes([rng.choice([0, 1, 2, 3])]))
        m.write_global(SKILL, bytes([rng.randint(1, 15)]))
        before = read_globals(m)
        fs.data = bytearray()
        fresh_stack(d)
        m.call(10, 0x0492, max_insns=5_000_000)
        result, _, _ = d.js.call("saveGame", before, [])
        d.count += 1
        if bytes(fs.data) != bytes(result):
            bad += 1
            first = next((k for k, (a, b) in enumerate(zip(fs.data, result)) if a != b), min(len(fs.data), len(result)))
            print(f"MISMATCH save {i}: {len(fs.data)} bytes written, engine {len(result)}; first difference at {first}")
            if bad > 3:
                break
        elif verbose:
            print(f"save {i}: {len(result)} bytes")
    return bad


def check_loads(d, rec, qd, fs, mark, rng, cases, verbose):
    m = d.m
    saves = real_saves()
    if not saves:
        print("no saved games in saves/3.01")
        return 1
    bad = 0
    for i in range(cases):
        name, data = saves[i % len(saves)]
        notes = []
        if i >= len(saves):
            data, notes = variation(rng, data)
        m.heap_next = mark
        qd.reset()
        stale(d, rng)
        m.write_global(FILE_CHOSEN, bytes([1]))
        m.write_global(REPLY_GOOD, bytes([1]))
        m.write_global(REPLY_NAME, bytes([4]) + b"game")
        fs.data = bytearray(data)
        rec.log = []
        fresh_stack(d)
        before = read_globals(m)
        m.call(1, 0x09D2, max_insns=500_000_000)
        after = read_globals(m)
        _, mem, log = d.js.call("loadGame", before, [list(data), IGNORED])
        d.count += 1
        label = f"load {i} ({name}{', ' + ', '.join(notes) if notes else ''})"
        if not compare(d, label, rec, after, log, mem, verbose):
            bad += 1
            if bad > 3:
                break
    return bad


def run(cases, seed, verbose):
    rng = random.Random(seed)
    d = Diff()
    for off, size in IGNORED + [(FILE_CHOSEN, 2), (REPLY_GOOD, 1)]:
        for k in range(size):
            d.ignore.add(off + k)
    rec = NewGameRecorder(d)
    qd = QuickDraw(d.m)
    qd.install()
    fs = FileSystem(d.m)
    mark = d.m.heap_next

    # The loader's request record is a local that only some requests fill; clear its frame
    # so that the unset bytes match the engine's fresh record.
    def clear_frame(uc, address, size, _):
        a6 = uc.reg_read(UC_M68K_REG_A6)
        uc.mem_write(a6 - 0x274, bytes(0x274))
    d.m.uc.hook_add(UC_HOOK_CODE, clear_frame, begin=d.m.addr(1, 0x09D6), end=d.m.addr(1, 0x09D6))

    bad = check_saves(d, fs, rng, cases, verbose)
    bad += check_loads(d, rec, qd, fs, mark, rng, cases, verbose)
    print(f"{d.count} checks, {bad} mismatches")
    return bad == 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 20
    s = int(args[1]) if len(args) > 1 else 1
    try:
        sys.exit(0 if run(n, s, "--verbose" in sys.argv) else 1)
    except TrapError as e:
        print("trap:", e)
        sys.exit(1)
