import sys, struct
b = open(sys.argv[1], "rb").read()
dl, rl = struct.unpack(">II", b[83:91])
d0 = 128; r0 = 128 + dl + ((-dl) % 128)
open(sys.argv[2] + ".data", "wb").write(b[d0:d0+dl])
open(sys.argv[2] + ".rsrc", "wb").write(b[r0:r0+rl])
print(sys.argv[1], "type/creator", b[65:73], "data", dl, "rsrc", rl)
