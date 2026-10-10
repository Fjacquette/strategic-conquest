"""List instructions referencing an A5-relative global, with a few instructions of context.

Usage: python3 -I globalrefs.py <resource-fork-file> <a5-offset, e.g. -0x5138> [context] [max]
"""
import sys, struct, rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000

def linear(d):
    md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
    out, pos = [], 4
    while pos < len(d) - 1:
        w = struct.unpack(">H", d[pos:pos + 2])[0]
        if (w & 0xF000) == 0xA000:
            out.append((pos, f"trap {w:#06x}")); pos += 2; continue
        ins = next(md.disasm(d[pos:pos + 10], pos), None)
        if ins is None:
            out.append((pos, "dc.w")); pos += 2; continue
        out.append((pos, f"{ins.mnemonic} {ins.op_str}")); pos += ins.size
    return out

def main():
    rf = rsrcfork.open(sys.argv[1], fork="data")
    off = int(sys.argv[2], 0)
    ctx = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9
    needle = f"-${-off:x}(a5)" if off < 0 else f"${off:x}(a5)"
    code = rf[b"CODE"]
    shown = 0
    for rid in sorted(code.keys()):
        if rid == 0:
            continue
        ins = linear(code[rid].data_raw)
        name = code[rid].name.decode("mac_roman") if code[rid].name else ""
        for i, (pos, text) in enumerate(ins):
            if needle in text:
                print(f"--- CODE {rid} {name} {pos:#06x}")
                for p, t in ins[max(0, i - ctx):i + ctx + 1]:
                    print(f"   {p:06x}: {t}")
                shown += 1
                if shown >= limit:
                    return

if __name__ == "__main__":
    main()
