import sys, struct
src, dst = sys.argv[1], sys.argv[2]
b = open(src, "rb").read()
magic, ver = struct.unpack(">II", b[:8])
assert magic == 0x00051607, hex(magic)
n = struct.unpack(">H", b[24:26])[0]
for i in range(n):
    eid, off, ln = struct.unpack(">III", b[26+12*i:38+12*i])
    print("entry", eid, "off", off, "len", ln)
    if eid == 9:
        fi = b[off:off+16]
        print("  type", fi[0:4], "creator", fi[4:8])
    if eid == 2:
        open(dst, "wb").write(b[off:off+ln])
