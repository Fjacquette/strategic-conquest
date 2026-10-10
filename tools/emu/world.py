"""Load a saved game into the emulator harness and stub out the player interface,
so original game routines (movement, turns) can run with scripted decisions.

    m = Machine(RSRC)
    w = World(m, Save.load("saves/3.01/s01-day4.sav"))
    w.controller = lambda req: ...          # answer decision requests
    m.call(5, 0x42D4, args=[("b", 1), ("b", 0)])   # PlayerTurn(player 1)
    w.messages                               # message IDs the game tried to show
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "save"))
from harness import A5  # noqa: E402
from sc3save import BLOCKS  # noqa: E402
from unicorn import UC_HOOK_CODE  # noqa: E402
from unicorn.m68k_const import UC_M68K_REG_A7, UC_M68K_REG_PC  # noqa: E402

CITY_COUNT = -0x1E4F


class Request:
    """A decision request posted through f5_5CBA (CODE 5 + 0x5CBA)."""

    def __init__(self, machine, req_addr, buf_addr, third):
        self.m = machine
        self.addr = req_addr
        self.buf = buf_addr
        self.third = third
        self.code = machine.r8(req_addr)
        self.player = machine.r8(req_addr + 1)
        self.raw = bytes(machine.uc.mem_read(req_addr, 12))

    def reply_direction(self, dx, dy):
        """Answer to code 5 (move a piece): one step (dx, dy)."""
        self.m.uc.mem_write(self.buf, bytes([dx & 0xFF, dy & 0xFF]))

    def __repr__(self):
        return f"Request(code={self.code}, player={self.player}, raw={self.raw.hex(' ')})"


class World:
    def __init__(self, machine, save, city_count=45):
        self.m = machine
        self.requests = []
        self.messages = []
        self.controller = None
        # Setup normally done at launch and at new-game/load time: launch globals, the
        # constant tables (own-city code and opponent per player, type-name IDs), which
        # f2_2CE2 fills as a side effect of loading a BITS resource, and the combat table.
        machine.call(2, 0x2DEA)
        machine.call(2, 0x2CE2, args=[("w", 1)], result="l")
        machine.call(2, 0x0004)
        for name, a5off, size in BLOCKS:
            machine.write_global(a5off, save.raw(name))
        machine.write_global(CITY_COUNT, bytes([city_count]))
        machine.call(4, 0x259A)          # compact removed pieces, rebuild the position hash
        machine.call(2, 0x0578)          # per-island city counts
        self._stub(5, 0x5CBA, 12, self._on_request)
        self._stub(1, 0x3520, 12, self._on_message_3520)
        self._stub(1, 0x35E2, 14, self._on_message_35e2)

    def _stub(self, seg, off, pop, fn):
        """Replace a Pascal procedure: run fn(sp) instead, then return and pop `pop` bytes."""
        addr = self.m.addr(seg, off)

        def hook(uc, address, size, _):
            sp = uc.reg_read(UC_M68K_REG_A7)
            ret = self.m.r32(sp)
            fn(sp)
            uc.reg_write(UC_M68K_REG_A7, sp + 4 + pop)
            uc.reg_write(UC_M68K_REG_PC, ret)

        self.m.uc.hook_add(UC_HOOK_CODE, hook, begin=addr, end=addr)

    def _on_request(self, sp):
        third, buf, req = self.m.r32(sp + 4), self.m.r32(sp + 8), self.m.r32(sp + 12)
        r = Request(self.m, req, buf, third)
        self.requests.append(r)
        if self.controller:
            self.controller(r)

    def _on_message_3520(self, sp):
        # f1_3520(longArg, word, byte, word, byte): the message ID is in the long's low word.
        long_arg = self.m.r32(sp + 4 + 8)
        self.messages.append(long_arg & 0xFFFF)

    def _on_message_35e2(self, sp):
        # f1_35E2(msg: long, flags: long, player: byte, word, byte): the message ID is the
        # low word of the first long; its high word is the STR ID substituted for ^0.
        long_arg = self.m.r32(sp + 4 + 10)
        self.messages.append(long_arg & 0xFFFF)

    # ----- state access -----
    def piece(self, idx):
        return bytes(self.m.read_global(-0x5138 + 14 * idx, 14))

    def set_piece(self, idx, rec):
        self.m.write_global(-0x5138 + 14 * idx, rec)

    def piece_count(self):
        return struct.unpack(">h", self.m.read_global(-0x388E, 2))[0]

    def terrain(self, x, y):
        b = self.m.read_global(-0x27D2 + (x - 1) * 30 + (y - 1) // 2, 1)[0]
        return (b >> 4) if (y - 1) & 1 else (b & 0x0F)

    def set_terrain(self, x, y, v):
        a = -0x27D2 + (x - 1) * 30 + (y - 1) // 2
        b = self.m.read_global(a, 1)[0]
        b = (b & 0x0F) | (v << 4) if (y - 1) & 1 else (b & 0xF0) | v
        self.m.write_global(a, bytes([b]))

    def rebuild_hash(self):
        self.m.call(4, 0x259A)
