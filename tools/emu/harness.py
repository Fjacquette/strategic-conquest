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
        self.resources = {(t, rid): rf[t][rid].data_raw for t in rf.keys() for rid in rf[t].keys()}
        self.resource_handles = {}
        self.uc = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
        uc = self.uc
        # Unicorn defaults to a ColdFire core, which lacks 68k instructions the game uses
        # (e.g. MOVEM with predecrement). The emulated Mac is a 68040.
        uc.ctl_set_cpu_model(UC_CPU_M68K_M68040)
        uc.mem_map(0, 0x4000)                  # Mac low-memory globals (MemErr, Ticks, Time, ...)
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
            0xA9A0: self._get_resource,
            0xA9BA: self._get_string,
            0xA9A2: self._noop_pop4,      # LoadResource
            0xA9A3: self._noop_pop4,      # ReleaseResource
            0xA992: self._noop_pop4,      # DetachResource
            0xA9EE: self._pack7,          # Binary-decimal conversion package
        }
        self.keys_down = set()
        self.heap_next = HEAP + 0x1000
        # No-op Toolbox traps for dialogs and drawing: (bytes of parameters popped,
        # bytes of function result left on the stack or None). Results are zero unless
        # a handler above returns something specific.
        self.noop_traps = {
            0xA873: (4, None),    # SetPort
            0xA874: (4, None),    # GetPort(VAR port) - writes a fake port below
            0xA884: (4, None),    # DrawString
            0xA885: (8, None),    # DrawText(ptr, first, count)
            0xA887: (2, None),    # TextFont
            0xA888: (2, None),    # TextFace
            0xA88A: (2, None),    # TextSize
            0xA891: (4, None),    # LineTo
            0xA893: (4, None),    # MoveTo
            0xA89E: (4, None),    # PenPat
            0xA8A1: (4, None),    # FrameRect
            0xA8A2: (4, None),    # PaintRect
            0xA8A3: (4, None),    # EraseRect
            0xA8A5: (8, None),    # FillRect
            0xA8A9: (8, None),    # InsetRect
            0xA915: (4, None),    # ShowWindow
            0xA916: (4, None),    # HideWindow
            0xA982: (4, None),    # CloseDialog
            0xA983: (4, None),    # DisposeDialog
            0xA98F: (8, None),    # SetIText
            0xA9C8: (2, None),    # SysBeep
            0xA975: (0, 4),       # TickCount
            0xA8D9: (4, None),    # DisposeRgn
            0xA8DA: (0, None),    # OpenRgn
            0xA8DB: (4, None),    # CloseRgn
            0xA8DC: (8, None),    # CopyRgn
            0xA8DD: (4, None),    # SetEmptyRgn
            0xA8DF: (8, None),    # RectRgn
            0xA8D2: (4, None),    # FrameRgn
            0xA8D3: (4, None),    # PaintRgn
            0xA8D4: (4, None),    # EraseRgn
            0xA8D6: (8, None),    # FillRgn
            0xA8D7: (4, None),    # InvertRgn
            0xA8E0: (12, None),   # OffsetRgn(rgn, dh, dv) - rgn 4 + 2 + 2 = 8
            0xA8E4: (12, None),   # UnionRgn
            0xA8E5: (12, None),   # SectRgn
            0xA8E6: (12, None),   # DiffRgn
            0xA8E7: (12, None),   # XorRgn
            0xA8BD: (8, None),    # ? (FramePoly)
            0xA8C5: (8, None),    # ? (FillPoly)
            0xA8CB: (0, 4),       # OpenPoly: result PolyHandle
            0xA8CC: (0, None),    # ClosePoly
            0xA8CD: (4, None),    # KillPoly
            0xA8C6: (4, None),    # PaintPoly
            0xA8C3: (4, None),    # ErasePoly
            0xA8BE: (4, None),    # FramePoly
        }
        self.noop_traps[0xA8E0] = (8, None)
        # OS traps (register based). Keyed by the low byte; modifier bits in the high
        # byte (e.g. A1xx/A3xx "clear"/"sys" variants) are accepted.
        self.handle_sizes = {}
        self.os_traps = {
            0x29: self._os_ok,          # HLock
            0x2A: self._os_ok,          # HUnlock
            0x49: self._os_ok,          # HPurge
            0x4A: self._os_ok,          # HNoPurge
            0x64: self._os_ok,          # MoveHHi
            0x23: self._os_ok,          # DisposeHandle
            0x1F: self._os_ok,          # DisposePtr
            0x22: self._new_handle,     # NewHandle
            0x1E: self._new_ptr,        # NewPtr
            0x25: self._get_handle_size,
            0x24: self._set_handle_size,
            0x2E: self._block_move,     # BlockMove
            0x3B: self._os_ok,          # Delay
        }

    def _d0(self, v=None):
        from unicorn.m68k_const import UC_M68K_REG_D0
        if v is None:
            return self.uc.reg_read(UC_M68K_REG_D0)
        self.uc.reg_write(UC_M68K_REG_D0, v & 0xFFFFFFFF)

    def _a(self, n, v=None):
        from unicorn.m68k_const import UC_M68K_REG_A0, UC_M68K_REG_A1
        reg = (UC_M68K_REG_A0, UC_M68K_REG_A1)[n]
        if v is None:
            return self.uc.reg_read(reg)
        self.uc.reg_write(reg, v & 0xFFFFFFFF)

    def _os_ok(self):
        self._d0(0)

    def _new_handle(self):
        size = self._d0()
        h = self._alloc(16)
        p = self._alloc(max(size, 4))
        self.uc.mem_write(p, bytes(size))
        self.w32(h, p)
        self.handle_sizes[h] = size
        self._a(0, h)
        self._d0(0)

    def _new_ptr(self):
        size = self._d0()
        p = self._alloc(max(size, 4))
        self.uc.mem_write(p, bytes(size))
        self._a(0, p)
        self._d0(0)

    def _get_handle_size(self):
        self._d0(self.handle_sizes.get(self._a(0), 0))

    def _set_handle_size(self, ):
        h, size = self._a(0), self._d0()
        old = self.handle_sizes.get(h, 0)
        if size > old:
            p = self._alloc(size)
            if old:
                self.uc.mem_write(p, bytes(self.uc.mem_read(self.r32(h), old)))
            self.w32(h, p)
        self.handle_sizes[h] = size
        self._d0(0)

    def _block_move(self):
        src, dst, n = self._a(0), self._a(1), self._d0()
        if n:
            self.uc.mem_write(dst, bytes(self.uc.mem_read(src, n)))
        self._d0(0)

    def _alloc(self, size):
        p = self.heap_next
        self.heap_next += (size + 15) & ~15
        return p

    def _noop(self, op):
        pop, res = self.noop_traps[op]
        sp = self._sp()
        if op == 0xA874:
            port = self._alloc(128)
            self.w32(self.r32(sp), port)
        self._set_sp(sp + pop)
        if res:
            self.uc.mem_write(sp + pop, bytes(res))

    def _resource_handle(self, rtype, rid):
        key = (rtype, rid)
        if key not in self.resources:
            return 0
        if key not in self.resource_handles:
            data = self.resources[key]
            h = self._alloc(16)
            p = self._alloc(max(len(data), 4))
            self.uc.mem_write(p, data)
            self.w32(h, p)
            self.handle_sizes[h] = len(data)
            self.resource_handles[key] = h
        return self.resource_handles[key]

    def _get_resource(self):
        # GetResource(theType: ResType; theID: INTEGER): Handle
        sp = self._sp()
        rid = self.r16(sp)
        rid = rid - 0x10000 if rid & 0x8000 else rid
        rtype = bytes(self.uc.mem_read(sp + 2, 4))
        self._set_sp(sp + 6)
        self.w32(sp + 6, self._resource_handle(rtype, rid))

    def _get_string(self):
        # GetString(stringID: INTEGER): StringHandle
        sp = self._sp()
        rid = self.r16(sp)
        self._set_sp(sp + 2)
        self.w32(sp + 2, self._resource_handle(b"STR ", rid))

    def _pack7(self):
        # Selector on the stack (word). 0: NumToString(D0 = number, A0 = Str255 out).
        # 1: StringToNum(A0 = Str255 in, D0 = number out).
        sp = self._sp()
        selector = self.r16(sp)
        self._set_sp(sp + 2)
        if selector == 0:
            n = self._d0()
            n = n - (1 << 32) if n & 0x80000000 else n
            s = str(n).encode()
            self.uc.mem_write(self._a(0), bytes([len(s)]) + s)
        elif selector == 1:
            a = self._a(0)
            s = bytes(self.uc.mem_read(a + 1, self.r8(a))).decode(errors="replace")
            try:
                self._d0(int(s))
            except ValueError:
                self._d0(0)

    def _get_new_dialog(self):
        sp = self._sp()
        self._set_sp(sp + 10)
        self.w32(sp + 10, self._alloc(256))

    def _get_ditem(self):
        sp = self._sp()
        box, item, itype = self.r32(sp), self.r32(sp + 4), self.r32(sp + 8)
        self.uc.mem_write(box, bytes(8))
        h = self._alloc(16)
        self.w32(h, self._alloc(256))
        self.w32(item, h)
        self.w16(itype, 0)
        self._set_sp(sp + 18)

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
        if handler is None and op in self.noop_traps:
            handler = lambda: self._noop(op)  # noqa: E731
        if handler is None and (op & 0x0800) == 0 and (op & 0xFF) in self.os_traps:   # A0xx-A7xx: OS traps
            handler = lambda: self.os_traps[op & 0xFF]()  # noqa: E731
        if handler is None and op == 0xA8D8:          # NewRgn: function result RgnHandle
            def handler():
                sp = self._sp()
                h = self._alloc(16)
                self.w32(h, self._alloc(64))
                self.w32(sp, h)
        if handler is None and op == 0xA97C:
            handler = self._get_new_dialog
        if handler is None and op == 0xA98D:
            handler = self._get_ditem
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
