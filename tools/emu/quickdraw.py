"""QuickDraw polygon and region traps for the emulator harness, as map generation uses them.

Polygons and regions live in the emulated heap in QuickDraw's own formats, since the game
reads polygon points and region bounding boxes directly:

    polygon: polySize (word), polyBBox (rect), points (v, h words)
    region:  rgnSize (word), rgnBBox (rect), rows of [v, h... 32767], final 32767

A region is a set of inversion points; PutLine, the point sorting and cancelling of
CloseRgn, and PackRgn follow Apple's QuickDraw. Region set operations work on pixels and
convert back, which gives the same canonical points QuickDraw's RgnOp produces.

    qd = QuickDraw(machine)
    qd.install()
"""
import struct

from unicorn.m68k_const import UC_M68K_REG_A7


def s16(v):
    v &= 0xFFFF
    return v - 0x10000 if v & 0x8000 else v


def fix_ratio(numer, denom):
    """FixRatio as in the IIci ROM: (numer << 16) / denom, truncated toward zero."""
    numer, denom = s16(numer), s16(denom)
    if denom == 0:
        return -0x7FFFFFFF if numer < 0 else 0x7FFFFFFF
    if numer == denom:
        return 0x10000
    q = abs(numer * 65536) // abs(denom)
    return q if (numer < 0) == (denom < 0) else -q


def put_line(out, h1, v1, h2, v2):
    """PutLine: the inversion points of a line, appended to `out` as (v, h)."""
    if h1 == h2:
        return
    if v1 == v2:
        out += [(v1, h1), (v2, h2)]
        return
    if v2 < v1:
        h1, v1, h2, v2 = h2, v2, h1, v1
    slope = fix_ratio(h2 - h1, v2 - v1)
    horiz = h1 * 65536 + 0x8000 + (slope >> 1)
    if slope >= 0:
        if slope < 0x10000:
            horiz += slope
    elif slope < -0x10000:
        horiz += 0x10000
    h, v = h1, v1
    while True:
        hi = horiz >> 16
        if hi != h:
            out += [(v, h), (v, hi)]
            h = hi
        v += 1
        horiz += slope
        if v == v2:
            break
    if h != h2:
        out += [(v, h), (v, h2)]


def canonical(points):
    odd = set()
    for p in points:
        odd ^= {p}
    return sorted(odd)


def bbox(points):
    """PackRgn's bounding box (top, left, bottom, right)."""
    if len(points) < 4:
        return (0, 0, 0, 0)
    if len(points) == 4:
        return (points[0][0], points[0][1], points[3][0], points[3][1])
    hs = [h for _, h in points]
    return (points[0][0], min(hs), points[-1][0], max(hs))


def rows(points):
    """[(v, toggles)] from each listed v down to the next."""
    out, state, i = [], set(), 0
    while i < len(points):
        v = points[i][0]
        while i < len(points) and points[i][0] == v:
            state ^= {points[i][1]}
            i += 1
        out.append((v, sorted(state)))
    return out


def inside(toggles, h):
    return sum(1 for t in toggles if t <= h) % 2 == 1


def combine(a, b, op):
    ra, rb = rows(a), rows(b)
    vs = sorted({v for v, _ in ra} | {v for v, _ in rb})
    out, prev = [], set()
    for v in vs:
        ta = next((t for rv, t in reversed(ra) if rv <= v), [])
        tb = next((t for rv, t in reversed(rb) if rv <= v), [])
        row, cur = [], False
        for h in sorted(set(ta) | set(tb)):
            now = op(inside(ta, h), inside(tb, h))
            if now != cur:
                row.append(h)
                cur = now
        out += [(v, h) for h in sorted(prev ^ set(row))]
        prev = set(row)
    return out


class QuickDraw:
    def __init__(self, m):
        self.m = m
        self.pen = (0, 0)                # (h, v)
        self.poly = None                 # (handle, points) while a polygon is open
        self.rgn_lines = None            # inversion points while a region is open
        self.regions = {}                # handle -> canonical points
        self.capacity = {}               # handle -> bytes allocated for its block

    def reset(self):
        """Forget all regions and polygons (after the harness heap has been reset)."""
        self.pen = (0, 0)
        self.poly = None
        self.rgn_lines = None
        self.regions.clear()
        self.capacity.clear()

    # ----- emulated memory -----
    def _new_handle(self, size):
        m = self.m
        h = m._alloc(16)
        p = m._alloc(max(size, 4))
        m.uc.mem_write(p, bytes(size))
        m.w32(h, p)
        self.capacity[h] = max(size, 4)
        return h

    def _block(self, handle, size):
        """The handle's block, grown to at least `size` bytes."""
        m = self.m
        if self.capacity.get(handle, 0) < size:
            m.w32(handle, m._alloc(size))
            self.capacity[handle] = size
        return m.r32(handle)

    def _store_region(self, handle, points):
        m = self.m
        self.regions[handle] = points
        data = bytearray()
        if len(points) > 4:
            i = 0
            while i < len(points):
                v = points[i][0]
                data += struct.pack(">h", v)
                while i < len(points) and points[i][0] == v:
                    data += struct.pack(">h", points[i][1])
                    i += 1
                data += struct.pack(">h", 32767)
            data += struct.pack(">h", 32767)
        size = 10 + len(data)
        p = self._block(handle, size)
        m.uc.mem_write(p, struct.pack(">h4h", size, *bbox(points)) + bytes(data))

    # ----- traps -----
    def install(self):
        m = self.m

        def trap(pop, fn):
            def handler():
                sp = m._sp()
                fn(sp)
                m._set_sp(sp + pop)
            return handler

        def new_rgn(sp):
            h = self._new_handle(10)
            self._store_region(h, [])
            m.w32(sp, h)

        def open_rgn(sp):
            self.rgn_lines = []

        def close_rgn(sp):
            self._store_region(m.r32(sp), canonical(self.rgn_lines or []))
            self.rgn_lines = None

        def move_to(sp):
            self.pen = (s16(m.r16(sp + 2)), s16(m.r16(sp)))

        def line_to(sp):
            new = (s16(m.r16(sp + 2)), s16(m.r16(sp)))
            if self.poly is not None:
                pts = self.poly[1]
                if not pts:
                    pts.append(self.pen)
                pts.append(new)
            elif self.rgn_lines is not None:
                put_line(self.rgn_lines, self.pen[0], self.pen[1], new[0], new[1])
            self.pen = new

        def open_poly(sp):
            h = self._new_handle(10)
            m.w16(m.r32(h), 10)
            self.poly = (h, [])
            m.w32(sp, h)

        def close_poly(sp):
            h, pts = self.poly
            self.poly = None
            size = 10 + 4 * len(pts)
            vs, hs = [v for _, v in pts] or [0], [x for x, _ in pts] or [0]
            p = self._block(h, size)
            m.uc.mem_write(p, struct.pack(">h4h", size, min(vs), min(hs), max(vs), max(hs)))
            for i, (x, v) in enumerate(pts):
                m.uc.mem_write(p + 10 + 4 * i, struct.pack(">hh", v, x))

        def region_op(op):
            def fn(sp):
                dst, b, a = m.r32(sp), m.r32(sp + 4), m.r32(sp + 8)
                self._store_region(dst, combine(self.regions[a], self.regions[b], op))
            return fn

        def empty_rgn(sp):
            t, l, b, r = bbox(self.regions[m.r32(sp)])
            m.w16(sp + 4, 0x0100 if (t >= b or l >= r) else 0)

        def pt_in_rgn(sp):
            rgn, v, h = m.r32(sp), s16(m.r16(sp + 4)), s16(m.r16(sp + 6))
            pts = self.regions[rgn]
            t, l, b, r = bbox(pts)
            res = False
            if l <= h < r and t <= v < b:
                res = sum(1 for pv, ph in pts if pv <= v and ph <= h) % 2 == 1
            m.w16(sp + 8, 0x0100 if res else 0)

        def sect_rect(sp):
            dst, b, a = m.r32(sp), m.r32(sp + 4), m.r32(sp + 8)
            ra = struct.unpack(">4h", m.uc.mem_read(a, 8))
            rb = struct.unpack(">4h", m.uc.mem_read(b, 8))
            t, l, bo, r = max(ra[0], rb[0]), max(ra[1], rb[1]), min(ra[2], rb[2]), min(ra[3], rb[3])
            ok = bo > t and r > l
            m.uc.mem_write(dst, struct.pack(">4h", *((t, l, bo, r) if ok else (0, 0, 0, 0))))
            m.w16(sp + 12, 0x0100 if ok else 0)

        def pt_in_rect(sp):
            rect, v, h = m.r32(sp), s16(m.r16(sp + 4)), s16(m.r16(sp + 6))
            t, l, b, r = struct.unpack(">4h", m.uc.mem_read(rect, 8))
            m.w16(sp + 8, 0x0100 if (t <= v < b and l <= h < r) else 0)

        m.traps.update({
            0xA8D8: trap(0, new_rgn),            # NewRgn
            0xA8D9: trap(4, lambda sp: None),    # DisposeRgn
            0xA8DA: trap(0, open_rgn),           # OpenRgn
            0xA8DB: trap(4, close_rgn),          # CloseRgn
            0xA893: trap(4, move_to),            # MoveTo
            0xA891: trap(4, line_to),            # LineTo
            0xA8CB: trap(0, open_poly),          # OpenPoly
            0xA8CC: trap(0, close_poly),         # ClosePoly
            0xA8CD: trap(4, lambda sp: None),    # KillPoly
            0xA8E4: trap(12, region_op(lambda x, y: x and y)),   # SectRgn
            0xA8E5: trap(12, region_op(lambda x, y: x or y)),    # UnionRgn
            0xA8E2: trap(4, empty_rgn),          # EmptyRgn
            0xA8E8: trap(8, pt_in_rgn),          # PtInRgn
            0xA8AA: trap(12, sect_rect),         # SectRect
            0xA8AD: trap(8, pt_in_rect),         # PtInRect
        })

    def polygon(self, handle):
        """The points of a polygon handle, as [h, v] pairs."""
        m = self.m
        p = m.r32(handle)
        size = s16(m.r16(p))
        return [[s16(m.r16(p + 12 + 4 * i)), s16(m.r16(p + 10 + 4 * i))] for i in range((size - 10) // 4)]
