import sys, struct, rsrcfork
rf = rsrcfork.open(sys.argv[1], fork="data")
code = rf[b"CODE"]
c0 = code[0].data_raw
above, below, jtsize, jtoff = struct.unpack(">IIII", c0[:16])
print(f"CODE 0: above A5={above} below A5 (globals)={below} jumptable bytes={jtsize} offset={jtoff} entries={jtsize//8}")
for rid in sorted(code.keys()):
    r = code[rid]
    name = r.name.decode("mac_roman") if r.name else ""
    d = r.data_raw
    extra = ""
    if rid != 0:
        first, n = struct.unpack(">HH", d[:4])
        extra = f"jt_first_off={first} jt_entries={n}"
    print(f"CODE {rid:3} {len(d):7} bytes  name={name!r:24} {extra}")
for rid in rf[b"vers"]:
    d = rf[b"vers"][rid].data_raw
    sl = d[6]; short = d[7:7+sl].decode("mac_roman"); ll = d[7+sl]; long_ = d[8+sl:8+sl+ll].decode("mac_roman")
    print("vers", rid, d[:4].hex(), short, "|", long_)
