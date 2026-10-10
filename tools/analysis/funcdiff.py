"""Match functions between two versions of the app and classify them as identical, changed, or unmatched.
Instruction text is normalized for A5 offsets and PC-relative/branch targets; immediates are kept."""
import sys, re, struct, difflib, rsrcfork
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000
md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
def funcs(rf):
    out = []
    for rid in sorted(rf[b"CODE"].keys()):
        if rid == 0: continue
        d = rf[b"CODE"][rid].data_raw
        starts = [p for p in range(4, len(d)-1, 2) if d[p:p+2] == b"\x4e\x56"]
        for i, s in enumerate(starts):
            e = starts[i+1] if i+1 < len(starts) else len(d)
            pos, ins_list = s, []
            while pos < e - 1:
                w = struct.unpack(">H", d[pos:pos+2])[0]
                if (w & 0xF000) == 0xA000: ins_list.append(f"trap {w:04x}"); pos += 2; continue
                ins = next(md.disasm(d[pos:pos+10], pos), None)
                if ins is None: ins_list.append("?"); pos += 2; continue
                op = ins.op_str
                op = re.sub(r"-?\$[0-9a-f]+\(a5\)", "G(a5)", op)
                if ins.mnemonic.startswith(("b", "db", "jsr", "jmp", "lea", "pea")) and "(pc)" in op or ins.mnemonic.startswith(("bra", "bsr", "beq", "bne", "bgt", "blt", "bge", "ble", "bhi", "bls", "bcc", "bcs", "bpl", "bmi", "bvc", "bvs", "db")):
                    op = re.sub(r"\$[0-9a-f]+", "T", op)
                ins_list.append(f"{ins.mnemonic} {op}")
                pos += ins.size
            out.append((rid, s, ins_list))
    return out
A = funcs(rsrcfork.open(sys.argv[1], fork="data"))
B = funcs(rsrcfork.open(sys.argv[2], fork="data"))
namesB = {rid: rsrcfork.open(sys.argv[2], fork="data")[b"CODE"][rid].name.decode("mac_roman") for rid in set(r for r,_,_ in B)}
import collections
used = set()
stats = collections.defaultdict(lambda: collections.Counter())
details = []
for rid, s, insB in B:
    best, br = None, 0.0
    for j, (ra, sa, insA) in enumerate(A):
        if j in used or abs(len(insA) - len(insB)) > max(10, 0.5 * len(insB)): continue
        sm = difflib.SequenceMatcher(None, insA, insB, autojunk=False)
        if sm.real_quick_ratio() <= br or sm.quick_ratio() <= br: continue
        r = sm.ratio()
        if r > br: best, br = j, r
    seg = namesB[rid]
    if best is not None and br >= 0.6:
        used.add(best)
        cls = "identical" if br == 1.0 else ("minor" if br >= 0.95 else "changed")
    else:
        cls = "new/unmatched"
    stats[seg][cls] += 1
    details.append((seg, s, len(insB), cls, round(br, 3), A[best][0] if best is not None else None, A[best][1] if best is not None else None))
print(f"{'segment':12} identical  minor(>=95%)  changed  new/unmatched")
tot = collections.Counter()
for seg in dict.fromkeys(n for n,*_ in details):
    c = stats[seg]; tot.update(c)
    print(f"{seg:12} {c['identical']:9} {c['minor']:13} {c['changed']:8} {c['new/unmatched']:14}")
print(f"{'TOTAL':12} {tot['identical']:9} {tot['minor']:13} {tot['changed']:8} {tot['new/unmatched']:14}")
print("2.055 functions with no 3.01 counterpart:", len(A) - len(used))
import json
json.dump(details, open(sys.argv[3], "w"))
