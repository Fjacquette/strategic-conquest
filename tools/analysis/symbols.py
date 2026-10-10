import sys, struct, re, rsrcfork
rf = rsrcfork.open(sys.argv[1], fork="data")
code = rf[b"CODE"]
def macsbug_name(d, i):
    # i points just past RTS/JMP(A0)/RTD
    if i >= len(d): return None
    b = d[i]
    if 0x80 < b < 0xA0:  # variable-length: 0x80+len
        n = b - 0x80
        s = d[i+1:i+1+n]
        if len(s) == n and all(32 <= c < 127 for c in s): return s.decode()
    if b >= 0x80:  # fixed 8 or 16
        s = bytes([b & 0x7F]) + d[i+1:i+8]
        if all(32 <= c < 127 for c in s):
            if d[i+1] >= 0x80:
                s = bytes([b & 0x7F, d[i+1] & 0x7F]) + d[i+2:i+16]
            return s.decode(errors="replace").rstrip()
    return None
allnames = {}
for rid in sorted(code.keys()):
    if rid == 0: continue
    d = code[rid].data_raw
    names = []
    for m in re.finditer(rb"\x4e\x75|\x4e\xd0|\x4e\x74..", d, re.S):
        if m.start() % 2: continue
        n = macsbug_name(d, m.end())
        if n: names.append((m.end(), n))
    allnames[rid] = names
    nm = code[rid].name.decode("mac_roman")
    print(f"CODE {rid} {nm}: {len(names)} names")
    print("   ", ", ".join(n for _, n in names))
