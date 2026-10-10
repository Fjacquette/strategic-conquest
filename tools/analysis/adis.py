"""Annotated 68k disassembly of Strategic Conquest CODE segments.

Usage:
    python3 -I adis.py <rsrc> <segment>                  # whole segment
    python3 -I adis.py <rsrc> <segment> <offset>         # one function starting at offset
    python3 -I adis.py <rsrc> funcs <segment>            # list functions with callers

Offsets are relative to the start of the CODE resource. Annotations:
  - jump-table calls (JSR d16(A5)) resolve to the target segment/offset and its name
  - PC-relative calls resolve to their target and name
  - A5-relative globals resolve to names from symbols.json (name+offset)
  - A-line traps get Toolbox/OS names where known
  - branch targets get labels
"""
import json
import os
import re
import struct
import sys

import rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000

sys.path.insert(0, os.path.dirname(__file__))
from traps import TRAPS  # noqa: E402

TRAPS = dict(TRAPS)
TRAPS.update({0xA039: "_ReadDateTime", 0xA963: "_SetCtlValue", 0xA960: "_GetCtlValue",
              0xA9C0: "_GetIndString?", 0xA946: "_DrawMenuBar?", 0xA032: "_FlushEvents"})

HERE = os.path.dirname(os.path.abspath(__file__))


class Program:
    def __init__(self, path, symbols_path=os.path.join(HERE, "symbols.json")):
        rf = rsrcfork.open(path, fork="data")
        self.code = {rid: rf[b"CODE"][rid].data_raw for rid in rf[b"CODE"].keys()}
        self.segname = {rid: (rf[b"CODE"][rid].name or b"").decode("mac_roman") for rid in rf[b"CODE"].keys()}
        c0 = self.code[0]
        self.jt = [struct.unpack(">HHHH", c0[16 + 8 * i:24 + 8 * i]) for i in range((len(c0) - 16) // 8)]
        with open(symbols_path) as f:
            sym = json.load(f)
        self.globals = sorted(((int(k, 16), v[0], v[1]) for k, v in sym["globals"].items()), reverse=True)
        self.funcnames = {}
        for k, v in sym["functions"].items():
            seg, off = k.split(":")
            self.funcnames[(int(seg), int(off, 16))] = v
        self.md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)

    def jt_target(self, disp):
        if disp < 34 or (disp - 34) % 8:
            return None
        i = (disp - 34) // 8
        if i >= len(self.jt):
            return None
        off, _, seg, _ = self.jt[i]
        return seg, off + 4, i

    def fname(self, seg, off):
        return self.funcnames.get((seg, off), f"f{seg}_{off:04X}")

    def gname(self, a5off):
        for base, name, size in self.globals:
            if base <= a5off < base + size:
                return name if a5off == base else f"{name}+{a5off - base}"
        return None

    def linear(self, seg, start=4, end=None, stops=()):
        """Linear-sweep decode. `stops` are known instruction starts (function entries);
        an instruction that would straddle one is emitted as data so decoding realigns."""
        d = self.code[seg]
        end = end or len(d)
        stops = sorted(stops)
        pos, out = start, []
        while pos < end - 1:
            w = struct.unpack(">H", d[pos:pos + 2])[0]
            if (w & 0xF000) == 0xA000:
                out.append((pos, 2, "trap", f"{w:#06x}", w))
                pos += 2
                continue
            ins = next(self.md.disasm(d[pos:pos + 10], pos), None)
            size = ins.size if ins else 2
            straddled = [s for s in stops if pos < s < pos + size]
            if ins is None or straddled:
                out.append((pos, 2, "dc.w", f"${w:04x}", None))
                pos += 2
                continue
            out.append((pos, ins.size, ins.mnemonic, ins.op_str, None))
            pos += ins.size
        return out

    def functions(self, seg):
        d = self.code[seg]
        starts = {p for p in range(4, len(d) - 1, 2) if d[p:p + 2] == b"\x4e\x56"}
        starts |= {off + 4 for off, _, s, _ in self.jt if s == seg}
        for (s, off) in self.funcnames:
            if s == seg:
                starts.add(off)
        return sorted(starts)

    def annotate(self, seg, mnem, ops):
        notes = []
        m = re.search(r"(-?)\$([0-9a-f]+)\(a5\)", ops)
        if m:
            val = int(m.group(2), 16) * (-1 if m.group(1) else 1)
            if val > 0 and mnem in ("jsr", "jmp", "pea.l", "lea.l"):
                t = self.jt_target(val)
                if t:
                    tseg, toff, i = t
                    notes.append(f"-> {self.fname(tseg, toff)} [CODE {tseg}+{toff:#x}, jt{i}]")
            elif val < 0:
                g = self.gname(val)
                if g:
                    notes.append(g)
        m = re.search(r"\$([0-9a-f]+)\(pc\)", ops)
        if m and mnem in ("jsr", "jmp", "bsr", "bsr.w", "bsr.b"):
            notes.append(f"-> {self.fname(seg, int(m.group(1), 16))}")
        return notes

    def listing(self, seg, start=None):
        funcs = self.functions(seg)
        if start is None:
            lo, hi = 4, len(self.code[seg])
        else:
            later = [f for f in funcs if f > start]
            lo, hi = start, (later[0] if later else len(self.code[seg]))
        ins = self.linear(seg, lo, hi, stops=funcs)
        targets = set()
        for pos, size, mnem, ops, _ in ins:
            if mnem.startswith(("b", "db")) and not mnem.startswith(("bchg", "bclr", "bset", "btst")):
                m = re.search(r"\$([0-9a-f]+)$", ops)
                if m:
                    targets.add(int(m.group(1), 16))
        lines = []
        for pos, size, mnem, ops, trap in ins:
            if pos in funcs:
                lines.append(f"\n; ---------- {self.fname(seg, pos)}  (CODE {seg} {self.segname[seg]} + {pos:#06x})")
            if pos in targets:
                lines.append(f"L{pos:04x}:")
            if trap is not None:
                text = f"{TRAPS.get(trap, '') or ('trap ' + ops)}"
                if not TRAPS.get(trap):
                    text = f"trap {ops}"
                lines.append(f"  {pos:05x}  {text}")
                continue
            notes = self.annotate(seg, mnem, ops)
            ops2 = re.sub(r"\$([0-9a-f]+)$", lambda m: f"L{int(m.group(1), 16):04x}", ops) \
                if mnem.startswith(("b", "db")) and not mnem.startswith(("bchg", "bclr", "bset", "btst")) else ops
            note = ("    ; " + "; ".join(notes)) if notes else ""
            lines.append(f"  {pos:05x}  {mnem:9} {ops2}{note}")
        return "\n".join(lines)

    def callers(self):
        """Map (seg, off) -> list of (seg, pos) call sites."""
        res = {}
        for seg in self.code:
            if seg == 0:
                continue
            d = self.code[seg]
            for p in range(4, len(d) - 3, 2):
                op = d[p:p + 2]
                disp = struct.unpack(">h", d[p + 2:p + 4])[0]
                if op == b"\x4e\xad":
                    t = self.jt_target(disp)
                    if t:
                        res.setdefault((t[0], t[1]), []).append((seg, p))
                elif op == b"\x4e\xba":
                    res.setdefault((seg, p + 2 + disp), []).append((seg, p))
        return res


def main(argv):
    prog = Program(argv[1])
    if argv[2] == "funcs":
        seg = int(argv[3])
        calls = prog.callers()
        for f in prog.functions(seg):
            cs = calls.get((seg, f), [])
            where = ", ".join(f"{s}:{p:#x}" for s, p in cs[:8]) + (" ..." if len(cs) > 8 else "")
            print(f"{f:#06x}  {prog.fname(seg, f):24} callers={len(cs):3}  {where}")
        return
    seg = int(argv[2])
    start = int(argv[3], 0) if len(argv) > 3 else None
    print(prog.listing(seg, start))


if __name__ == "__main__":
    main(sys.argv)
