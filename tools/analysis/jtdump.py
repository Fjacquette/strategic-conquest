import sys, struct, rsrcfork
rf = rsrcfork.open(sys.argv[1], fork="data")
code = rf[b"CODE"]
c0 = code[0].data_raw
seg_want = int(sys.argv[2])
d = code[seg_want].data_raw
for i in range((len(c0)-16)//8):
    off, mv, seg, trap = struct.unpack(">HHHH", c0[16+8*i:24+8*i])
    if seg == seg_want:
        print(i, f"off={off:#06x}", d[off+4:off+12].hex(), d[off:off+8].hex())
