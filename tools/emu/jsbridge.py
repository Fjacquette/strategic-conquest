"""Run engine routines (engine/src, TypeScript on Node) from Python differential tests.

    from jsbridge import Bridge, GLOBALS_SIZE, diff_globals
    js = Bridge()
    result, mem, log = js.call("hashFind", globals_bytes, [table, x, y])
"""
import base64
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
GLOBALS_SIZE = 0x55C4


class BridgeError(RuntimeError):
    pass


class Bridge:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "engine", "test", "bridge.ts")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def call(self, fn, mem, args=()):
        """Run engine function `fn` on a copy of the globals image `mem`.
        Returns (result, new globals image, host event log)."""
        if len(mem) != GLOBALS_SIZE:
            raise ValueError(f"globals image must be {GLOBALS_SIZE} bytes")
        req = {"fn": fn, "mem": base64.b64encode(bytes(mem)).decode(), "args": list(args)}
        self.proc.stdin.write(json.dumps(req) + "\n")
        line = self.proc.stdout.readline()
        if not line:
            raise BridgeError("engine bridge exited")
        out = json.loads(line)
        if "error" in out:
            raise BridgeError(out["error"])
        return out["result"], base64.b64decode(out["mem"]), out["log"]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


def read_globals(machine):
    return machine.read_global(-GLOBALS_SIZE, GLOBALS_SIZE)


def write_globals(machine, data):
    machine.write_global(-GLOBALS_SIZE, data)


def global_namer():
    """Function mapping an A5 offset to 'name+delta' using tools/analysis/symbols.json."""
    with open(os.path.join(ROOT, "tools", "analysis", "symbols.json")) as f:
        sym = json.load(f)
    blocks = sorted(((int(k, 16), v[0], v[1]) for k, v in sym["globals"].items()), reverse=True)

    def name(off):
        for base, label, size in blocks:
            if base <= off < base + size:
                return label if off == base else f"{label}+{off - base}"
        return None
    return name


def diff_globals(a, b, names=None, limit=12):
    """Describe the bytes that differ between two globals images (A5 offsets)."""
    out = []
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            off = i - GLOBALS_SIZE
            label = names(off) if names else None
            out.append(f"A5{off:+#06x}{' ' + label if label else ''}: original {x:#04x}, engine {y:#04x}")
            if len(out) >= limit:
                out.append("...")
                break
    return out
