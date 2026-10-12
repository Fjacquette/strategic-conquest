"""Extract Strategic Conquest 3.01's artwork and sounds from the owner's copy, for the browser
game. The output is the owner's own copy of the assets and is not committed (web/assets/ is
in .gitignore).

Usage: python3 -I tools/assets/extract_assets.py [build/sc301.rsrc] [web/assets/original]

Writes:
  assets.json     the bitmaps and patterns as numbers, for the web build: "bits" maps each
                  BITS id to its 12 row words (16 pixels wide, most significant bit left),
                  "pats" each PAT id to its 8 row bytes, "strings" each STR id to its text,
                  "dialogs" each DITL id to its items' texts ([item type, text], in order)
  bits-<id>.png   the 39 BITS bitmaps (16 x 12, 1 bit: black pixels opaque, white transparent)
  pat-<id>.png    the PAT patterns (8 x 8)
  <name>.wav      the five sampled sounds ('snd ' format 2, 8-bit)
  sheet.png       every bitmap on one sheet, numbered, enlarged (for reference)
"""
import json
import os
import struct
import sys
import wave
import zlib

import rsrcfork

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def png(path, width, height, rows):
    """Write an RGBA PNG; `rows` is a list of lists of (r, g, b, a)."""
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def bits_rows(data):
    """A BITS resource: width, height (words), then one word per row, most significant bit left."""
    w, h = struct.unpack(">HH", data[:4])
    rows = []
    for y in range(h):
        word = struct.unpack(">H", data[4 + 2 * y:6 + 2 * y])[0]
        rows.append([(word >> (15 - x)) & 1 for x in range(w)])
    return w, h, rows


def snd_samples(data):
    """A format-2 'snd ' resource with one sampled-sound header: (rate, unsigned 8-bit samples)."""
    fmt, _ref, ncmd = struct.unpack(">HHH", data[:6])
    if fmt != 2:
        raise ValueError(f"'snd ' format {fmt}")
    pos = 6
    offset = None
    for _ in range(ncmd):
        cmd, _p1, p2 = struct.unpack(">HHI", data[pos:pos + 8])
        pos += 8
        if cmd & 0x7FFF in (0x50, 0x51):            # soundCmd / bufferCmd: p2 is the header offset
            offset = p2
    if offset is None:
        raise ValueError("no sound header")
    _ptr, length, rate, _ls, _le, encode, _base = struct.unpack(">IIIIIBB", data[offset:offset + 22])
    if encode != 0:
        raise ValueError(f"encoding {encode}")
    return rate / 65536.0, data[offset + 22:offset + 22 + length]


def ditl_items(data):
    """A dialog item list's items as [type, text]: buttons (4), static (8) and edit (16) text."""
    count = struct.unpack(">h", data[:2])[0] + 1
    pos, items = 2, []
    for _ in range(count):
        pos += 12                        # handle placeholder, bounds
        kind, length = data[pos] & 0x7F, data[pos + 1]
        body = data[pos + 2:pos + 2 + length]
        pos += 2 + length + (length & 1)
        if kind in (4, 5, 6, 8, 16):
            items.append([kind, body.decode("mac_roman")])
    return items


def main(src, out):
    rf = rsrcfork.open(src, fork="data")
    os.makedirs(out, exist_ok=True)
    black, clear = (0, 0, 0, 255), (0, 0, 0, 0)
    sheet = []
    numbers = {"bits": {}, "pats": {}, "strings": {}, "dialogs": {}}
    for rid in sorted(rf[b"DITL"].keys()):
        numbers["dialogs"][str(rid)] = ditl_items(rf[b"DITL"][rid].data_raw)
    for rid in sorted(rf[b"STR "].keys()):
        d = rf[b"STR "][rid].data_raw
        numbers["strings"][str(rid)] = d[1:1 + d[0]].decode("mac_roman")
    for rid in sorted(rf[b"BITS"].keys()):
        d = rf[b"BITS"][rid].data_raw
        numbers["bits"][str(rid)] = list(struct.unpack(">12H", d[4:28]))
    for rid in sorted(rf[b"PAT "].keys()):
        numbers["pats"][str(rid)] = list(rf[b"PAT "][rid].data_raw[:8])
    with open(os.path.join(out, "assets.json"), "w") as f:
        json.dump(numbers, f)
    for rid in sorted(rf[b"BITS"].keys()):
        w, h, rows = bits_rows(rf[b"BITS"][rid].data_raw)
        png(os.path.join(out, f"bits-{rid}.png"), w, h, [[black if b else clear for b in r] for r in rows])
        sheet.append((rid, rows))
    for rid in sorted(rf[b"PAT "].keys()):
        d = rf[b"PAT "][rid].data_raw
        rows = [[black if (d[y] >> (7 - x)) & 1 else clear for x in range(8)] for y in range(8)]
        png(os.path.join(out, f"pat-{rid}.png"), 8, 8, rows)
    for rid in sorted(rf[b"snd "].keys()):
        res = rf[b"snd "][rid]
        name = (res.name or f"snd-{rid}".encode()).decode("mac_roman")
        rate, samples = snd_samples(res.data_raw)
        with wave.open(os.path.join(out, f"{name}.wav"), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(1)
            wf.setframerate(round(rate))
            wf.writeframes(samples)
    # Reference sheet: 8 per row, each bitmap scaled 4x on white with a gap.
    scale, cols = 4, 8
    cw, ch = 16 * scale + 8, 12 * scale + 8
    nrows = (len(sheet) + cols - 1) // cols
    W, H = cols * cw, nrows * ch
    canvas = [[(255, 255, 255, 255)] * W for _ in range(H)]
    for i, (_rid, rows) in enumerate(sheet):
        ox, oy = (i % cols) * cw + 4, (i // cols) * ch + 4
        for y in range(12):
            for x in range(16):
                c = (0, 0, 0, 255) if rows[y][x] else (230, 236, 240, 255)
                for dy in range(scale):
                    for dx in range(scale):
                        canvas[oy + y * scale + dy][ox + x * scale + dx] = c
    png(os.path.join(out, "sheet.png"), W, H, canvas)
    print(f"wrote {len(sheet)} bitmaps, {len(rf[b'PAT '].keys())} patterns, "
          f"{len(rf[b'snd '].keys())} sounds to {out}")


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0] if a else os.path.join(ROOT, "build", "sc301.rsrc"),
         a[1] if len(a) > 1 else os.path.join(ROOT, "web", "assets", "original"))
