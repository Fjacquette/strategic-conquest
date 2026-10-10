import sys, rsrcfork
path = sys.argv[1]
rf = rsrcfork.open(path, fork="data")
total = 0
for rtype in sorted(rf.keys()):
    m = rf[rtype]
    sizes = [len(m[rid].data_raw) for rid in m]
    total += sum(sizes)
    ids = sorted(m.keys())
    idstr = ",".join(str(i) for i in ids[:12]) + ("..." if len(ids) > 12 else "")
    print(f"{rtype.decode('mac_roman'):6} count={len(ids):4} bytes={sum(sizes):7}  ids={idstr}")
print("total resource bytes", total)
