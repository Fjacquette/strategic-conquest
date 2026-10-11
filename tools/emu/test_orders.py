"""Differential test: engine/src/orders.ts (a human player's commands) against the
original's command handlers.

Usage: python3 -I tools/emu/test_orders.py [cases] [seed]

Each case builds a random world (as test_turn.py does), a pending request for the
commanding player (mostly a direction request for one of its pieces), and a command with
a clicked cell and a target cell. The original runs:

- the Moves menu commands through Domenu (CODE 16 + 0x0028), given the command's key;
- clicks and drags on the map through the map click handler (CODE 13 + 0x0028);
- a production choice through the production dialog's button handler (CODE 18 + 0x14BC),
  and the dialog's opening through its drawing routine (CODE 18 + 0x0EBC).

The user's input is scripted: the event fetch returns a click at the chosen cell, the
target selection (CODE 15 + 0x0004) returns the chosen target, and the Toolbox calls
for menus, windows and the clock are answered in Python. The engine's result (whether
the request was answered, and the reply) and the whole globals image are compared,
leaving out the production dialog's own variables and drawing.
"""
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff  # noqa: E402
from harness import HEAP  # noqa: E402
from test_turn import Recorder, build_world  # noqa: E402

GAME_MODE, LOCAL_PLAYER, PIECES, CITIES, CITY_COUNT = -0x1E71, -0x2D0A, -0x5138, -0x385E, -0x1E4F
SCROLL_X, SCROLL_Y, MAP_WINDOW = -0x296, -0x298, -0x1E54
TYPE_STR_IDS = -0x1324
DIALOG_GLOBALS = [(-0xB82, 0xB82 - 0xB44),   # the production dialog's controls and saved values
                  (-0x730, 0x730 - 0x71A)]   # its icon drawing (rectangle and bitmap)

SCRATCH = HEAP + 0xF0000
EV, QUIT, REQ, REPLY, DONE, FLAG = (SCRATCH + o for o in (0x00, 0x20, 0x30, 0x40, 0x50, 0x60))
FRAME, OUTBYTE, CTL_H, CTL_P = (SCRATCH + o for o in (0x80, 0xC0, 0xD0, 0x100))

MENU_KEYS = {"sleep": "S", "wake": "W", "load": "L", "random": "R", "aircraftDestination": "C",
             "armyDestination": "A", "stackMove": "M", "patrol": "P", "skip": "N", "moveLater": "B"}
MOVES_MENU = 103
MOVES_ITEMS = "SWLRCAMPNB"


def cell_point(x, y):
    """A pixel point inside cell (x, y) of the map window, with the view scrolled to 0."""
    return 12 * y + 6, 16 * x + 8


class OrderRig:
    """Scripted user input for the original's command handlers."""

    def __init__(self, d):
        self.d = d
        m = self.m = d.m
        self.rec = Recorder(d)
        self.click = (0, 0)
        self.target = (0, 0)
        self.mouse_up = True
        self.alerts = []
        for seg, off, pop in ((1, 0x30F2, 0), (1, 0x2894, 0), (1, 0x289E, 0), (18, 0x13E4, 4), (5, 0x00FE, 8)):
            self.rec._stub(seg, off, pop, lambda sp: None)

        def alert(sp):
            self.alerts.append(m.r16(sp + 6))
            m.w16(sp + 8, 1)
        self.rec._stub(1, 0x3124, 4, alert)

        def next_event(sp):
            ev = m.r32(sp + 4)
            v, h = cell_point(*self.click)
            m.uc.mem_write(ev, struct.pack(">HIIhhH", 1, 0, 0, v, h, 0))
            m.w8(sp + 10, 1)
        self.rec._stub(1, 0x27BC, 6, next_event)

        def select_target(sp):
            v, h = cell_point(*self.target)
            m.w16(m.r32(sp + 12), h)
            m.w16(m.r32(sp + 8), v)
        self.rec._stub(15, 0x0004, 16, select_target)

        def trap(pop, result_at=None, fn=None):
            def handler():
                sp = m._sp()
                if fn:
                    fn(sp)
                m._set_sp(sp + pop)
            return handler

        def menu_key(sp):
            ch = chr(m.r16(sp) & 0xFF).upper()
            item = MOVES_ITEMS.find(ch) + 1
            m.w32(sp + 2, (MOVES_MENU << 16) | item if item else 0)

        def find_window(sp):
            m.w32(m.r32(sp), m.r32(m.g(MAP_WINDOW)))
            m.w16(sp + 8, 3)

        def event_avail(sp):
            mask = m.r16(sp + 4)
            m.w16(sp + 6, 0x0100 if (mask == 4 and self.mouse_up) else 0)

        m.traps.update({
            0xA93E: trap(2, fn=menu_key),                                   # MenuKey
            0xA86A: trap(4, fn=lambda sp: m.w16(sp + 4, m.r32(sp) >> 16)),  # HiWord
            0xA86B: trap(4, fn=lambda sp: m.w16(sp + 4, m.r32(sp))),        # LoWord
            0xA938: trap(2),                                                # HiliteMenu
            0xA92C: trap(8, fn=find_window),                                # FindWindow
            0xA871: trap(4),                                                # GlobalToLocal
            0xA850: trap(0),                                                # InitCursor
            0xA9B4: trap(0),                                                # SystemTask
            0xA971: trap(6, fn=event_avail),                                # EventAvail
            0xA963: trap(6),                                                # SetCtlValue
            0xA8A7: trap(12),                                               # SetRect
            0xA969: trap(4),                                                # DrawControls
            0xA8EC: trap(22),                                               # CopyBits
            0xA89B: trap(4),                                                # PenSize
        })

    def setup(self, req, reply):
        m = self.m
        m.write_global(SCROLL_X, b"\x00\x00")
        m.write_global(SCROLL_Y, b"\x00\x00")
        m.uc.mem_write(REQ, bytes(req))
        m.uc.mem_write(REPLY, bytes(reply))
        m.uc.mem_write(DONE, b"\x00")
        m.uc.mem_write(FLAG, b"\x00")
        m.uc.mem_write(QUIT, b"\x00")

    def result(self):
        m = self.m
        return [m.r8(DONE), m.r8(REPLY), m.r8(REPLY + 1)]

    def menu_command(self, name, req, reply):
        """Run Domenu for the command's key."""
        m = self.m
        self.setup(req, reply)
        m.uc.mem_write(EV, struct.pack(">HIIhhH", 3, ord(MENU_KEYS[name]), 0, 0, 0, 0))
        m.call(16, 0x0028, args=[("l", EV), ("l", QUIT), ("l", REQ), ("l", REPLY), ("l", DONE), ("l", FLAG)])
        return self.result()

    def map_click(self, req, reply, player, drag):
        """Run the map click handler for a click (or a drag) starting at self.click."""
        m = self.m
        self.setup(req, reply)
        self.mouse_up = not drag
        v, h = cell_point(*self.click)
        m.uc.mem_write(EV, struct.pack(">HIIhhH", 1, 0, 0, v, h, 0))
        pos = (req[4] << 8) | req[5]
        m.call(13, 0x0028, args=[("l", EV), ("w", pos), ("l", DONE), ("l", REPLY), ("b", player), ("l", REQ)])
        return self.result()

    def open_production(self, x, y, owner, captured):
        """The production dialog opening on the city at (x, y): its check for water nearby
        (CODE 18 + 0x1820) and its first drawing (CODE 18 + 0x0EBC), which resets a captured
        city to Armies and remembers the production. Returns (city, type, days)."""
        m = self.m
        m.call(1, 0x28C6, args=[("l", m.g(-0x27D2)), ("w", x), ("w", y), ("w", 1)], result="b")
        city = next((c for c, _, cx, cy in cities(m) if (cx, cy) == (x & 0xFF, y & 0xFF)), 0)
        m.write_global(-0xB46, bytes([city]))
        m.write_global(-0xB45, bytes([1 if captured else 0]))
        m.write_global(-0xB59, bytes([owner]))
        m.call(18, 0x0EBC)
        return [city, struct.unpack("b", m.read_global(-0xB47, 1))[0], m.read_global(-0xB49, 1)[0]]

    def choose_production(self, city, saved_type, saved_days, ptype):
        """Run the production dialog's button handler for type `ptype`."""
        m = self.m
        display = struct.unpack(">h", m.read_global(TYPE_STR_IDS + 2 * ptype, 2))[0]
        m.uc.mem_write(CTL_P, bytes(0x30))
        m.w32(CTL_P + 0x24, 0x15 + display)
        m.w32(CTL_H, CTL_P)
        m.w32(FRAME + 8, OUTBYTE)
        m.write_global(-0xB46, bytes([city]))
        m.write_global(-0xB47, bytes([saved_type]))
        m.write_global(-0xB4A, saved_days.to_bytes(2, "big"))
        m.write_global(-0xB58, bytes(4))
        m.write_global(-0xB82, bytes(36))
        self.alerts = []
        m.call(18, 0x14BC, args=[("l", CTL_H), ("l", FRAME)])
        return 0 if 0x112 in self.alerts else 1


def pieces(m):
    n = int.from_bytes(m.read_global(-0x388E, 2), "big")
    out = []
    for i in range(1, n + 1):
        r = m.read_global(PIECES + 14 * i, 14)
        out.append((i, r[10] & 0xF, (r[10] >> 4) & 3, struct.unpack("b", r[7:8])[0], struct.unpack("b", r[6:7])[0]))
    return out


def cities(m):
    n = m.read_global(CITY_COUNT, 1)[0]
    out = []
    for c in range(1, n + 1):
        r = m.read_global(CITIES + 10 * c, 10)
        out.append((c, r[4], r[7], r[6]))
    return out


def make_request(rng, m, player, box):
    ps = pieces(m)
    own = [p for p in ps if p[2] == player and p[1] < 8]
    rec = bytearray(rng.getrandbits(8) for _ in range(12))
    rec[0] = 5 if rng.random() < 0.8 else rng.choice([0, 1, 3, 6, 21, 22])
    rec[1] = player
    pool = own if own and rng.random() < 0.85 else ps
    rec[4], rec[5] = rng.randint(box[1], box[3]), rng.randint(box[0], box[2])
    if rec[0] == 5:
        idx = rng.randint(0, 450)
        rec[8], rec[9] = idx >> 8, idx & 0xFF
    if pool:
        idx, _, _, x, y = rng.choice(pool)
        rec[8], rec[9] = idx >> 8, idx & 0xFF
        rec[4], rec[5] = y & 0xFF, x & 0xFF
        if rng.random() < 0.1:
            rec[4], rec[5] = rng.randint(box[1], box[3]), rng.randint(box[0], box[2])
    return rec


def pick_cell(rng, m, req, box):
    """A clicked cell: the requesting piece's, another piece's or a city's, or any cell
    near the action. Clicks always land on the map (columns 1-80, rows 1-60)."""
    ps, cs = pieces(m), cities(m)
    r = rng.random()
    x, y = struct.unpack("b", bytes([req[5]]))[0], struct.unpack("b", bytes([req[4]]))[0]
    if r < 0.3 and 1 <= x <= 80 and 1 <= y <= 60:
        return x, y
    if r < 0.55 and ps:
        return rng.choice(ps)[3:5]
    if r < 0.8 and cs:
        return rng.choice(cs)[2:4]
    return rng.randint(box[0], box[2]), rng.randint(box[1], box[3])


def focus(rng, m, name, player, req, rig):
    """Steer some commands to the cases that do something: a click on one of the player's
    cities or Transports, with the request for a piece there."""
    if rng.random() < 0.5:
        return
    if name == "clickDirection":
        x, y = struct.unpack("b", bytes([req[5]]))[0], struct.unpack("b", bytes([req[4]]))[0]
        rig.click = (min(80, max(1, x + rng.randint(-2, 2))), min(60, max(1, y + rng.randint(-2, 2))))
        return
    own_cities = [c for c in cities(m) if c[1] == player]
    ps = [p for p in pieces(m) if p[2] == player]
    if name in ("aircraftDestination", "armyDestination") and own_cities:
        c, _, x, y = rng.choice(own_cities)
        rig.click = (x, y)
        aircraft = [p for p in ps if p[1] in (1, 7)]
        if aircraft and rng.random() < 0.7:
            idx = rng.choice(aircraft)[0]
            req[0], req[4], req[5], req[8], req[9] = 5, y, x, idx >> 8, idx & 0xFF
    elif name == "load":
        transports = [p for p in ps if p[1] == 5]
        if transports:
            idx, _, _, x, y = rng.choice(transports)
            rig.click = (x, y)
            if rng.random() < 0.6:
                req[0], req[4], req[5], req[8], req[9] = 5, y & 0xFF, x & 0xFF, idx >> 8, idx & 0xFF


def pick_target(rng, click, box):
    r = rng.random()
    if r < 0.1:
        return click
    if r < 0.2:
        return click[0] + rng.choice([-1, 0, 1]), click[1] + rng.choice([-1, 0, 1])
    if r < 0.25:
        return rng.randint(78, 84), rng.randint(58, 64)
    return rng.randint(max(1, box[0] - 8), min(80, box[2] + 8)), rng.randint(max(1, box[1] - 8), min(60, box[3] + 8))


def run(cases, seed):
    rng = random.Random(seed)
    d = Diff()
    rig = OrderRig(d)
    m = d.m
    for start, size in DIALOG_GLOBALS:
        d.ignore.update(range(start, start + size))
    names = list(MENU_KEYS) + ["clickDirection", "goTo"]
    counts = {}
    ok = True
    for case in range(cases):
        box, _ = build_world(d, rng)
        player = rng.choice([1, 2])
        m.write_global(LOCAL_PLAYER, bytes([player]))
        m.write_global(GAME_MODE, bytes([rng.choice([0, 1])]))
        for _ in range(8):
            name = rng.choice(names)
            req = make_request(rng, m, player, box)
            reply = [rng.getrandbits(8), rng.getrandbits(8)]
            rig.click = pick_cell(rng, m, req, box)
            focus(rng, m, name, player, req, rig)
            rig.target = pick_target(rng, rig.click, box)
            args = [*rig.click, *rig.target]
            if name in MENU_KEYS:
                orig = lambda: rig.menu_command(name, req, reply)  # noqa: E731
            else:
                drag = name == "goTo"
                orig = lambda: rig.map_click(req, reply, player, drag)  # noqa: E731
            before = d.snapshot()
            good = d.check(f"{name} case {case}", orig, "order", [name, list(req), reply, player, args])
            changed = d.snapshot() != before
            key = f"{name}{' done' if m.r8(DONE) else ''}{' changed' if changed else ''}"
            counts[key] = counts.get(key, 0) + 1
            if not good:
                print(f"    request {list(req)}, click {rig.click}, target {rig.target}")
                return False
        cs = cities(m)
        if cs:
            c, owner, _, _ = rng.choice(cs)
            saved = rng.randint(0, 7), rng.randint(0, 30)
            ptype = rng.randint(0, 7)
            ok &= d.check(f"production case {case}", lambda: rig.choose_production(c, *saved, ptype),
                          "chooseProduction", [c, saved[0], saved[1], ptype])
            key = "production refused" if rig.alerts else "production"
            counts[key] = counts.get(key, 0) + 1
            c, owner, x, y = rng.choice(cs)
            captured = rng.random() < 0.5
            ok &= d.check(f"open production case {case}", lambda: rig.open_production(x, y, owner, captured),
                          "openProduction", [x, y, owner, captured])
            counts["open production"] = counts.get("open production", 0) + 1
            if not ok:
                return False
    print(f"{cases} worlds, {d.count} commands: all match")
    for k, v in sorted(counts.items()):
        print(f"    {k}: {v}")
    return True


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(args[0]) if args else 50
    s = int(args[1]) if len(args) > 1 else 1
    sys.exit(0 if run(n, s) else 1)
