"""Count Macintosh Toolbox/OS trap calls per CODE segment.

Usage: python3 -I traps.py <resource-fork-file>

Performs a linear-sweep 68k disassembly of each CODE segment and counts A-line
trap words found at instruction boundaries. Trap names are given only for traps
whose identity is certain; others print as hex.
"""
import sys, struct, collections, rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000

TRAPS = {
    0xA000: "_Open", 0xA001: "_Close", 0xA002: "_Read", 0xA003: "_Write", 0xA03B: "_Delay",
    0xA858: "_BitAnd", 0xA860: "_WaitNextEvent", 0xA861: "_Random", 0xA86E: "_InitGraf",
    0xA873: "_SetPort", 0xA874: "_GetPort", 0xA884: "_DrawString", 0xA885: "_DrawText",
    0xA88C: "_StringWidth", 0xA891: "_LineTo", 0xA893: "_MoveTo", 0xA8A1: "_FrameRect",
    0xA8A2: "_PaintRect", 0xA8A3: "_EraseRect", 0xA8A5: "_FillRect", 0xA8A9: "_InsetRect",
    0xA8D8: "_NewRgn", 0xA8D9: "_DisposeRgn", 0xA8EC: "_CopyBits", 0xA8EF: "_ScrollRect",
    0xA8F6: "_DrawPicture", 0xA8FE: "_InitFonts", 0xA912: "_InitWindows", 0xA970: "_GetNextEvent",
    0xA975: "_TickCount", 0xA97C: "_GetNewDialog", 0xA985: "_Alert", 0xA986: "_StopAlert",
    0xA98B: "_ParamText", 0xA991: "_ModalDialog", 0xA9A0: "_GetResource", 0xA9A1: "_GetNamedResource",
    0xA9A2: "_LoadResource", 0xA9A3: "_ReleaseResource", 0xA9BA: "_GetString", 0xA9C8: "_SysBeep",
    0xA9EB: "_FP68K (SANE)", 0xA9EC: "_Elems68K (SANE)", 0xA9ED: "_Pack6", 0xA9EE: "_Pack7",
    0xA9F0: "_LoadSeg", 0xA9F1: "_UnloadSeg", 0xA9FF: "_Debugger",
    0xA805: "_SndPlay", 0xA807: "_SndNewChannel",
}

def trap_counts(data):
    md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
    pos, counts = 4, collections.Counter()
    while pos < len(data) - 1:
        w = struct.unpack(">H", data[pos:pos + 2])[0]
        if (w & 0xF000) == 0xA000:
            counts[w] += 1
            pos += 2
            continue
        ins = next(md.disasm(data[pos:pos + 10], pos), None)
        pos += ins.size if ins else 2
    return counts

def main():
    rf = rsrcfork.open(sys.argv[1], fork="data")
    code = rf[b"CODE"]
    total = collections.Counter()
    print("Random-related trap counts by segment:")
    for rid in sorted(code.keys()):
        if rid == 0:
            continue
        c = trap_counts(code[rid].data_raw)
        total.update(c)
        if c.get(0xA861) or c.get(0xA975):
            name = code[rid].name.decode("mac_roman") if code[rid].name else ""
            print(f"  CODE {rid:2} {name:12} _Random={c.get(0xA861, 0)} _TickCount={c.get(0xA975, 0)}")
    print("\nMost frequent traps:")
    for w, n in total.most_common(50):
        print(f"  {w:04X} {TRAPS.get(w, ''):20} {n}")

if __name__ == "__main__":
    main()
