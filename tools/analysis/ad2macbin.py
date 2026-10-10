"""Convert an AppleDouble file (as written by unar -forks visible) into MacBinary II."""
import sys, struct
def crc16_xmodem(data):
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc
def pad128(b): return b + bytes((-len(b)) % 128)
src, name, dst = sys.argv[1], sys.argv[2], sys.argv[3]
datafork_path = sys.argv[4] if len(sys.argv) > 4 else None
b = open(src, "rb").read()
assert struct.unpack(">I", b[:4])[0] == 0x00051607
n = struct.unpack(">H", b[24:26])[0]
finfo = bytes(16); rsrc = b""
for i in range(n):
    eid, off, ln = struct.unpack(">III", b[26+12*i:38+12*i])
    if eid == 9: finfo = b[off:off+16]
    if eid == 2: rsrc = b[off:off+ln]
data = open(datafork_path, "rb").read() if datafork_path else b""
nm = name.encode("mac_roman")
h = bytearray(128)
h[1] = len(nm); h[2:2+len(nm)] = nm
h[65:73] = finfo[0:8]                # type + creator
h[73] = finfo[8]                     # finder flags high byte
h[83:87] = struct.pack(">I", len(data))
h[87:91] = struct.pack(">I", len(rsrc))
h[101] = finfo[9]                    # finder flags low byte
h[122] = 129; h[123] = 129
h[124:126] = struct.pack(">H", crc16_xmodem(bytes(h[:124])))
open(dst, "wb").write(bytes(h) + pad128(data) + pad128(rsrc))
print("wrote", dst, "data", len(data), "rsrc", len(rsrc), "type/creator", finfo[0:8])
