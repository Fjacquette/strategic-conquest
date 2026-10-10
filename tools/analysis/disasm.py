import sys, struct, rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000
md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
rf = rsrcfork.open(sys.argv[1], fork="data")
seg = int(sys.argv[2]); start = int(sys.argv[3], 0); end = int(sys.argv[4], 0)
d = rf[b"CODE"][seg].data_raw
pos = start
while pos < end:
    w = struct.unpack(">H", d[pos:pos+2])[0]
    if (w & 0xF000) == 0xA000:
        print(f"{pos:06x}: {w:04x}            trap {w:#06x}"); pos += 2; continue
    ins = next(md.disasm(d[pos:pos+10], pos), None)
    if ins is None:
        print(f"{pos:06x}: {w:04x}            dc.w"); pos += 2; continue
    print(f"{pos:06x}: {d[pos:pos+ins.size].hex():16} {ins.mnemonic} {ins.op_str}")
    pos += ins.size
