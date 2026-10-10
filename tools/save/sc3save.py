"""Reader for Strategic Conquest 3.01 save files.

Usage:
    python3 -I sc3save.py dump <file.sav>
    python3 -I sc3save.py render <file.sav> <out.png> [--player N] [--scale S]

The save routine (Gstart, CODE 10 + 0x0542..0x07FA) writes the globals listed in BLOCKS
with FSWrite, in order; the load routine (Main, CODE 1 + 0x0A9A..0x0DD2) reads them back
in the same order. Coordinates are 1-based: x (column) 1..80, y (row) 1..60. The outer
ring of cells is the map edge.
"""
import struct
import sys
from dataclasses import dataclass

MAP_W, MAP_H = 80, 60
MAX_PIECES = 450
MAX_CITIES = 45

# (name, A5 offset of the global, size). "cur_" globals belong to the player whose turn it
# is; "oth_" globals are the stored copy for the other player (Main + 0x2C8C swaps them).
BLOCKS = [
    ("seed",          -0x1E70,    4),
    ("game_mode",     -0x1E71,    1),
    ("skill",         -0x2CE6,    1),
    ("day",           -0x2D08,    2),
    ("terrain",       -0x27D2, 0x960),
    ("pieces",        -0x5138, 0x18AA),
    ("player_maps",   -0x2CD8, 0x504),
    ("game_mode_2",   -0x1E71,    1),
    ("cities",        -0x385E, 0x1CC),
    ("piece_count",   -0x388E,    2),
    ("cur_islands",   -0x1BFC, 0x160),
    ("oth_islands",   -0x0F86, 0x160),
    ("cur_1C4E",      -0x1C4E, 0x20),
    ("oth_0CBC",      -0x0CBC, 0x20),
    ("cur_1C8C",      -0x1C8C, 0x2E),
    ("oth_0C7C",      -0x0C7C, 0x2E),
    ("cur_1C5E",      -0x1C5E, 0x10),
    ("oth_0C20",      -0x0C20, 0x10),
    ("cur_1C02",      -0x1C02,    2),
    ("oth_0CC6",      -0x0CC6,    2),
    ("cur_1C2E",      -0x1C2E,    2),
    ("oth_0CC0",      -0x0CC0,    2),
    ("blk_2CE4",      -0x2CE4,  0xC),
]
FILE_SIZE = sum(size for _, _, size in BLOCKS)

TERRAIN = {0: "water", 1: "city (code 1)", 2: "city (code 2)", 3: "land", 4: "city (code 4)", 5: "edge"}
CITY_CODES = {1, 2, 4}

# Piece type codes, as stored in the low nibble of byte 10 of a piece record.
PIECE_TYPES = ["Army", "Fighter", "Destroyer", "Submarine", "Carrier", "Transport",
               "Battleship", "Bomber", "type 8", "empty"]
PIECE_LETTERS = "AFDSCTBb?."


@dataclass
class Piece:
    index: int
    raw: bytes
    @property
    def type(self): return self.raw[10] & 0x0F
    @property
    def type_name(self): return PIECE_TYPES[self.type]
    @property
    def owner(self): return (self.raw[10] >> 4) & 0x03
    @property
    def x(self): return self.raw[7]
    @property
    def y(self): return self.raw[6]
    @property
    def strength(self): return self.raw[12] & 0x1F
    @property
    def fuel_or_cargo(self): return (struct.unpack(">H", self.raw[8:10])[0] >> 5) & 0x1F
    @property
    def point_a(self): return (self.raw[1], self.raw[0])
    @property
    def point_b(self): return (self.raw[3], self.raw[2])
    @property
    def point_c(self): return (self.raw[5], self.raw[4])


@dataclass
class City:
    index: int
    raw: bytes
    @property
    def x(self): return self.raw[1]
    @property
    def y(self): return self.raw[0]
    @property
    def owner(self): return self.raw[4]
    @property
    def days_left(self): return self.raw[5]
    @property
    def producing(self): return self.raw[8]
    @property
    def island(self): return self.raw[9]
    @property
    def point_b(self): return (self.raw[3], self.raw[2])
    @property
    def point_c(self): return (self.raw[7], self.raw[6])


class Save:
    def __init__(self, data: bytes):
        if len(data) != FILE_SIZE:
            raise ValueError(f"expected {FILE_SIZE} bytes, got {len(data)}")
        self.data = data
        self.blocks = {}
        pos = 0
        for name, _, size in BLOCKS:
            self.blocks[name] = (pos, data[pos:pos + size])
            pos += size
        terrain = self.blocks["terrain"][1]
        self._terrain = [v for b in terrain for v in (b & 0x0F, b >> 4)]

    @classmethod
    def load(cls, path):
        with open(path, "rb") as f:
            return cls(f.read())

    def raw(self, name):
        return self.blocks[name][1]

    @property
    def seed(self): return struct.unpack(">I", self.raw("seed"))[0]
    @property
    def game_mode(self): return self.raw("game_mode")[0]
    @property
    def skill(self): return self.raw("skill")[0]
    @property
    def day(self): return struct.unpack(">h", self.raw("day"))[0]
    @property
    def piece_count(self): return struct.unpack(">h", self.raw("piece_count"))[0]

    def terrain(self, x, y):
        return self._terrain[(x - 1) * MAP_H + (y - 1)]

    def explored(self, player, x, y):
        maps = self.raw("player_maps")
        base = (player - 1) * 0x282 + (x - 1) * 8
        bit = y - 1
        return (maps[base + bit // 8] >> (bit % 8)) & 1

    def pieces(self):
        table = self.raw("pieces")
        for i in range(1, self.piece_count + 1):
            p = Piece(i, table[i * 14:(i + 1) * 14])
            if p.type != 9:
                yield p

    def cities(self):
        table = self.raw("cities")
        for i in range(1, MAX_CITIES + 1):
            yield City(i, table[i * 10:(i + 1) * 10])


def dump(save):
    print(f"seed {save.seed:#010x}  game_mode {save.game_mode}  skill {save.skill}  day {save.day}  "
          f"piece slots in use {save.piece_count}")
    print("\nCities: idx (x,y) owner days_left producing island  point_b point_c")
    for c in save.cities():
        prod = PIECE_TYPES[c.producing] if c.producing < len(PIECE_TYPES) else c.producing
        print(f"  {c.index:2} ({c.x:2},{c.y:2}) {c.owner} {c.days_left:3} {prod:10} {c.island:2}  "
              f"{c.point_b} {c.point_c}  terrain={save.terrain(c.x, c.y)}")
    print("\nPieces: idx type owner (x,y) strength fuel/cargo  a b c  raw")
    for p in save.pieces():
        print(f"  {p.index:3} {p.type_name:10} {p.owner} ({p.x:2},{p.y:2}) {p.strength:2} {p.fuel_or_cargo:2}  "
              f"{p.point_a} {p.point_b} {p.point_c}  {p.raw.hex(' ')}")


def render(save, out_path, player=None, scale=12):
    from PIL import Image, ImageDraw
    colors = {0: (40, 110, 200), 3: (60, 160, 60), 5: (30, 30, 30)}
    owner_colors = {0: (230, 230, 230), 1: (250, 250, 120), 2: (230, 70, 70)}
    img = Image.new("RGB", (MAP_W * scale, MAP_H * scale), (0, 0, 0))
    d = ImageDraw.Draw(img)
    city_owner = {(c.x, c.y): c.owner for c in save.cities()}
    for x in range(1, MAP_W + 1):
        for y in range(1, MAP_H + 1):
            if player and not save.explored(player, x, y):
                continue
            t = save.terrain(x, y)
            box = ((x - 1) * scale, (y - 1) * scale, x * scale - 1, y * scale - 1)
            if t in CITY_CODES:
                d.rectangle(box, fill=colors[3])
                d.rectangle(box, outline=owner_colors[city_owner.get((x, y), 0)], width=2)
            else:
                d.rectangle(box, fill=colors.get(t, (255, 0, 255)))
    for p in save.pieces():
        if player and not save.explored(player, p.x, p.y):
            continue
        cx, cy = (p.x - 1) * scale, (p.y - 1) * scale
        d.text((cx + 2, cy), PIECE_LETTERS[p.type], fill=owner_colors.get(p.owner, (255, 0, 255)))
    img.save(out_path)


def main(argv):
    if len(argv) >= 3 and argv[1] == "dump":
        dump(Save.load(argv[2]))
    elif len(argv) >= 4 and argv[1] == "render":
        player = int(argv[argv.index("--player") + 1]) if "--player" in argv else None
        scale = int(argv[argv.index("--scale") + 1]) if "--scale" in argv else 12
        render(Save.load(argv[2]), argv[3], player, scale)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
