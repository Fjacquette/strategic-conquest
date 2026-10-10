"""Find call sites of a routine, both through the jump table and PC-relative within its segment.

Usage: python3 -I xref.py <resource-fork-file> <segment> <offset>
<offset> is the routine's offset within the CODE resource (as printed by disasm.py and adis.py).
"""
import sys, struct, rsrcfork

def main():
    rf = rsrcfork.open(sys.argv[1], fork="data")
    code = rf[b"CODE"]
    seg, target = int(sys.argv[2]), int(sys.argv[3], 0)
    c0 = code[0].data_raw
    entries = [struct.unpack(">HHHH", c0[16 + 8 * i:24 + 8 * i]) for i in range((len(c0) - 16) // 8)]
    jt = [i for i, (off, _, s, _) in enumerate(entries) if s == seg and off + 4 == target]
    a5disp = [32 + 8 * i + 2 for i in jt]
    print(f"CODE {seg} + {target:#x}: jump table entries {jt}")
    for rid in sorted(code.keys()):
        if rid == 0:
            continue
        d = code[rid].data_raw
        name = code[rid].name.decode("mac_roman") if code[rid].name else ""
        for p in range(4, len(d) - 3, 2):
            op = d[p:p + 2]
            disp = struct.unpack(">h", d[p + 2:p + 4])[0]
            if op in (b"\x4e\xad", b"\x4e\xed") and disp in a5disp:
                print(f"  CODE {rid:2} {name:11} {p:#06x}  via jump table")
            if rid == seg and op in (b"\x4e\xba", b"\x4e\xfa", b"\x61\x00") and p + 2 + disp == target:
                print(f"  CODE {rid:2} {name:11} {p:#06x}  PC-relative")

if __name__ == "__main__":
    main()
