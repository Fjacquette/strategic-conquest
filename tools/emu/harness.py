"""Run Strategic Conquest 3.01 routines directly on an emulated 68000 (Unicorn).

All CODE segments are loaded at fixed addresses, the jump table is written in its
"loaded" form (each entry jumps straight to its routine), and an A5 world is set up
with the game's globals below A5. Toolbox/OS traps that the exercised routines need
are implemented in Python; any other trap raises an error so gaps are visible.

Typical use:
    m = Machine("build/sc301.rsrc")
    m.call(2, 0x0004)                                   # EMPINIT: build combat table
    result = m.call(3, 0x0520, args=[("l", a), ("l", b), ("w", wc), ("w", wa), ("w", w8)],
                    result="b")
Routines use Pascal conventions: the result slot is pushed first, then parameters in
declaration order; the callee pops its parameters.
"""
import struct

import rsrcfork
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_INTR, UcError
from unicorn.m68k_const import (UC_CPU_M68K_M68040, UC_M68K_REG_A5, UC_M68K_REG_A7,
                                UC_M68K_REG_PC)

CODE_BASE = 0x100000       # segment n is loaded at CODE_BASE + n * SEG_STRIDE
SEG_STRIDE = 0x10000
A5 = 0x400000
GLOBALS_LOW = A5 - 0x10000
STACK_TOP = 0x50F000
STACK_LOW = 0x500000
SENTINEL = 0x600000        # return address that ends a call
HEAP = 0x700000


class TrapError(RuntimeError):
    pass


class Machine:
    def __init__(self, rsrc_path):
        rf = rsrcfork.open(rsrc_path, fork="data")
        self.code = {rid: rf[b"CODE"][rid].data_raw for rid in rf[b"CODE"].keys()}
        self.uc = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
        uc = self.uc
        # Unicorn defaults to a ColdFire core, which lacks 68k instructions the game uses
        # (e.g. MOVEM with predecrement). The emulated Mac is a 68040.
        uc.ctl_set_cpu_model(UC_CPU_M68K_M68040)
        uc.mem_map(CODE_BASE, SEG_STRIDE * 32)
        uc.mem_map(GLOBALS_LOW, 0x20000)
        uc.mem_map(STACK_LOW, 0x10000)
        uc.mem_map(SENTINEL, 0x1000)
        uc.mem_map(HEAP, 0x100000)
        for seg, data in self.code.items():
            if seg:
                uc.mem_write(CODE_BASE + seg * SEG_STRIDE, data)
        c0 = self.code[0]
        for i in range((len(c0) - 16) // 8):
            off, _, seg, _ = struct.unpack(">HHHH", c0[16 + 8 * i:24 + 8 * i])
            entry = A5 + 32 + 8 * i
            target = self.addr(seg, off + 4)
            uc.mem_write(entry, struct.pack(">HHI", seg, 0x4EF9, target))
        # QuickDraw: (A5) points at thePort, which sits at A5-$1BC; randSeed is 126 bytes below it
        self.w32(A5, A5 - 0x1BC)
        uc.mem_write(SENTINEL, b"\x4e\x71" * 8)
        uc.hook_add(UC_HOOK_INTR, self._intr)
        self.trap_log = []
        self.traps = {
            0xA858: self._bitand,
            0xA861: self._random,
            0xA976: self._getkeys,
            0xA9F0: self._noop_pop4,      # _LoadSeg (segments are preloaded)
            0xA9F1: self._noop_pop4,      # _UnloadSeg
        }
        self.keys_down = set()

    # ----- memory helpers -----
    @staticmethod
    def addr(seg, off):
        return CODE_BASE + seg * SEG_STRIDE + off

    def r8(self, a): return self.uc.mem_read(a, 1)[0]
    def r16(self, a): return struct.unpack(">H", self.uc.mem_read(a, 2))[0]
    def r32(self, a): return struct.unpack(">I", self.uc.mem_read(a, 4))[0]
    def w8(self, a, v): self.uc.mem_write(a, bytes([v & 0xFF]))
    def w16(self, a, v): self.uc.mem_write(a, struct.pack(">H", v & 0xFFFF))
    def w32(self, a, v): self.uc.mem_write(a, struct.pack(">I", v & 0xFFFFFFFF))

    def g(self, a5off):
        """Absolute address of an A5-relative global."""
        return A5 + a5off

    def read_global(self, a5off, size):
        return bytes(self.uc.mem_read(A5 + a5off, size))

    def write_global(self, a5off, data):
        self.uc.mem_write(A5 + a5off, bytes(data))

    # ----- traps -----
    def _intr(self, uc, intno, _):
        pc = uc.reg_read(UC_M68K_REG_PC)
        op = self.r16(pc)
        if intno != 10 or (op & 0xF000) != 0xA000:   # vector 10: line-A (Toolbox/OS trap)
            raise TrapError(f"unexpected exception {intno} at {pc:#x} (opcode {op:#06x})")
        handler = self.traps.get(op)
        if handler is None:
            uc.emu_stop()
            self._pending_error = TrapError(f"unimplemented trap {op:#06x} at {pc:#x}")
            return
        self.trap_log.append(op)
        handler()
        uc.reg_write(UC_M68K_REG_PC, pc + 2)

    def _sp(self): return self.uc.reg_read(UC_M68K_REG_A7)
    def _set_sp(self, v): self.uc.reg_write(UC_M68K_REG_A7, v)

    def _noop_pop4(self):
        self._set_sp(self._sp() + 4)

    def _bitand(self):
        sp = self._sp()
        b, a = self.r32(sp), self.r32(sp + 4)
        self._set_sp(sp + 8)
        self.w32(sp + 8, a & b)

    def _random(self):
        # QuickDraw Random: Park-Miller step on randSeed, result is the low word (-32768 maps to 0).
        seed_addr = A5 - 0x23A
        seed = self.r32(seed_addr)
        seed = (seed * 16807) % 0x7FFFFFFF
        self.w32(seed_addr, seed)
        r = seed & 0xFFFF
        if r == 0x8000:
            r = 0
        self.w16(self._sp(), r)

    def _getkeys(self):
        sp = self._sp()
        ptr = self.r32(sp)
        km = bytearray(16)
        for k in self.keys_down:
            km[k >> 3] |= 1 << (k & 7)
        self.uc.mem_write(ptr, bytes(km))
        self._set_sp(sp + 4)

    # ----- calling -----
    def call(self, seg, off, args=(), result=None, max_insns=5_000_000):
        """Call a Pascal routine. args: list of ("b"|"w"|"l", value) in declaration order.
        result: None, "b" (Boolean/char, returned in a word slot), "w" or "l"."""
        uc = self.uc
        sp = STACK_TOP
        if result in ("b", "w"):
            sp -= 2
            self.w16(sp, 0)
        elif result == "l":
            sp -= 4
            self.w32(sp, 0)
        result_addr = sp
        for kind, val in args:
            if kind in ("b", "w"):
                sp -= 2
                if kind == "b":
                    self.uc.mem_write(sp, bytes([val & 0xFF, 0]))
                else:
                    self.w16(sp, val)
            else:
                sp -= 4
                self.w32(sp, val)
        sp -= 4
        self.w32(sp, SENTINEL)
        uc.reg_write(UC_M68K_REG_A7, sp)
        uc.reg_write(UC_M68K_REG_A5, A5)
        self._pending_error = None
        try:
            uc.emu_start(self.addr(seg, off), SENTINEL, count=max_insns)
        except UcError as e:
            pc = uc.reg_read(UC_M68K_REG_PC)
            raise RuntimeError(f"emulation error {e} at pc={pc:#x}") from e
        if self._pending_error:
            raise self._pending_error
        pc = uc.reg_read(UC_M68K_REG_PC)
        if pc != SENTINEL:
            raise RuntimeError(f"routine did not return (pc={pc:#x})")
        if uc.reg_read(UC_M68K_REG_A7) != result_addr:
            raise RuntimeError("stack imbalance after call")
        if result == "b":
            return self.r8(result_addr)
        if result == "w":
            v = self.r16(result_addr)
            return v - 0x10000 if v & 0x8000 else v
        if result == "l":
            return self.r32(result_addr)
        return None
