"""Find runs of immediate stores into globals (likely table initialization) and print them."""
import sys, re, struct, rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000
md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
rf = rsrcfork.open(sys.argv[1], fork="data")
minrun = int(sys.argv[2]) if len(sys.argv) > 2 else 6
for rid in sorted(rf[b"CODE"].keys()):
    if rid == 0: continue
    d = rf[b"CODE"][rid].data_raw; nm = rf[b"CODE"][rid].name.decode("mac_roman")
    pos, run = 4, []
    def flush():
        if len(run) >= minrun:
            print(f"CODE {rid} {nm} @{run[0][0]:#06x} ({len(run)} stores):")
            print("   ", "  ".join(f"{dst}={val}" for _, dst, val in run))
    while pos < len(d) - 1:
        w = struct.unpack(">H", d[pos:pos+2])[0]
        if (w & 0xF000) == 0xA000:
            flush(); run = []; pos += 2; continue
        ins = next(md.disasm(d[pos:pos+10], pos), None)
        if ins is None: flush(); run = []; pos += 2; continue
        m = re.match(r"#\$?(-?[0-9a-fx]+), (-?\$[0-9a-f]+\(a5\))$", ins.op_str)
        if ins.mnemonic in ("move.w", "move.b", "move.l") and m:
            v = m.group(1); val = int(v, 16) if not v.startswith("-") else -int(v[1:], 16)
            run.append((pos, m.group(2).replace("(a5)", ""), val))
        elif ins.mnemonic in ("clr.w", "clr.b", "clr.l") and re.match(r"-?\$[0-9a-f]+\(a5\)$", ins.op_str):
            run.append((pos, ins.op_str.replace("(a5)", ""), 0))
        else:
            flush(); run = []
        pos += ins.size
    flush()
