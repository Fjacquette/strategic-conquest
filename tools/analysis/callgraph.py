"""Call graph of Strategic Conquest CODE segments.

Usage:
    python3 -I callgraph.py <rsrc> <seg>:<offset> [--stop seg,seg,...]

Prints the routines reachable from the given entry point, depth first, with each
routine's size and the traps it uses. Calls into segments listed after --stop are
shown but not followed.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adis import Program  # noqa: E402


def body(prog, seg, off):
    funcs = prog.functions(seg)
    later = [f for f in funcs if f > off]
    end = later[0] if later else len(prog.code[seg])
    return prog.linear(seg, off, end, stops=funcs), end - off


def calls(prog, seg, off):
    ins, size = body(prog, seg, off)
    out, traps = [], set()
    for pos, sz, mnem, ops, trap in ins:
        if trap is not None:
            traps.add(trap)
            continue
        if mnem not in ("jsr", "bsr", "bsr.w", "bsr.b", "jmp"):
            continue
        m = re.search(r"\$([0-9a-f]+)\(a5\)", ops)
        if m:
            t = prog.jt_target(int(m.group(1), 16))
            if t:
                out.append((t[0], t[1]))
            continue
        m = re.search(r"\$([0-9a-f]+)\(pc\)", ops)
        if m:
            out.append((seg, int(m.group(1), 16)))
    return out, traps, size


def main(argv):
    prog = Program(argv[1])
    seg, off = argv[2].split(":")
    stop = set()
    if "--stop" in argv:
        stop = {int(s) for s in argv[argv.index("--stop") + 1].split(",")}
    seen = set()
    from traps import TRAPS

    def walk(s, o, depth):
        key = (s, o)
        name = prog.fname(s, o)
        if key in seen:
            print("  " * depth + f"{name} (above)")
            return
        seen.add(key)
        cs, traps, size = calls(prog, s, o)
        tnames = sorted(TRAPS.get(t, f"{t:#06x}") or f"{t:#06x}" for t in traps)
        print("  " * depth + f"{name} [CODE {s}+{o:#06x}, {size} bytes]" + (f"  traps: {', '.join(tnames)}" if tnames else ""))
        if s in stop and depth > 0:
            return
        for c in dict.fromkeys(cs):
            walk(c[0], c[1], depth + 1)

    walk(int(seg), int(off, 16), 0)
    print(f"\n{len(seen)} routines")


if __name__ == "__main__":
    main(sys.argv)
