"""Whole games of the original in the emulator, with its computer opponent playing.

The original's new game (CODE 10 + 0x093C), the steps before its day loop (CODE 1 +
0x1936..0x195C) and then whole days (0x195C..0x1F82) run in game mode 0 with the computer
opponent live: ControllerRequest (CODE 5 + 0x5CBA) hands the computer's side to its move
chooser and production routines, and its planning, new-piece and start-of-game routines
run where the game calls them. Player 1 is the computer too (Auto Play), or a scripted
player whose direction requests take actions from test_turn.actions_for().

Only the human controller (CODE 5 + 0x51FE) and other user-interface routines are stubbed,
as in test_day.py and test_newgame.py; the human controller's requests are logged.

    g = Game(seed)
    g.new_game(skill=5, auto_play=True)
    for _ in range(40):
        g.day()

Calls of chosen routines can be captured (globals and arguments before, globals and result
after) to compare the engine's versions on realistic states: see Capture.
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from difftest import Diff  # noqa: E402
from jsbridge import GLOBALS_SIZE, read_globals  # noqa: E402
from quickdraw import QuickDraw  # noqa: E402
from test_day import DayRecorder  # noqa: E402
from test_newgame import NewGameRecorder  # noqa: E402
from test_turn import actions_for  # noqa: E402
from unicorn import UC_HOOK_CODE  # noqa: E402
from unicorn.m68k_const import UC_M68K_REG_A7  # noqa: E402

GAME_MODE, SKILL, AUTO_PLAY, ISLAND_POLYS = -0x1E71, -0x2CE6, -0x120C, -0x1E36
LOCAL_PLAYER, NET_TURN, DAY = -0x2D0A, -0x1C07, -0x2D08
AUTO_PLAY_REQUESTED, PLAYER_MAPS, PLAYER_MAP_SIZE, COMPUTER_FLAG = -0x120D, -0x2CD8, 642, 0x280
# The computer opponent's routines the test recorders stub; here they run.
LIVE = {(5, 0x5CBA), (7, 0x11EA), (1, 0x0626), (2, 0x2E3A), (2, 0x24DE)}


class GameRecorder(DayRecorder, NewGameRecorder):
    """The day loop's and the new game's stubs, without those of the computer opponent;
    the human controller is stubbed instead of ControllerRequest."""

    def __init__(self, d):
        self.stubbed = set()
        super().__init__(d)
        self._stub(5, 0x51FE, 12, self.on_request)

    def _stub(self, seg, off, pop, fn):
        # Both recorders stub some of the same routines; a routine is stubbed once.
        if (seg, off) not in LIVE and (seg, off) not in self.stubbed:
            self.stubbed.add((seg, off))
            super()._stub(seg, off, pop, fn)


class Capture:
    """Records calls of routine (seg, off): the globals and `argbytes` bytes of arguments
    at entry, and at return the globals and the function result (`result`: None, "b", "w"
    or "l", the size of the slot above the arguments). At most `limit` calls are kept,
    spread over the whole game: when the list fills, every other call is dropped and only
    every other call is recorded from then on.

    `enter(m, raw)` and `leave(m, raw)`, given the argument bytes, read what the arguments
    point to at entry (kept as call["argv"]) and at return (call["out"])."""

    def __init__(self, m, seg, off, argbytes, result=None, limit=200, enter=None, leave=None):
        self.m, self.argbytes, self.result, self.limit = m, argbytes, result, limit
        self.on_enter, self.on_leave = enter, leave
        self.calls = []
        self.pending = []
        self.seen = 0
        self.stride = 1
        m.uc.hook_add(UC_HOOK_CODE, self._enter, begin=m.addr(seg, off), end=m.addr(seg, off))

    def _enter(self, uc, address, size, _):
        self.seen += 1
        if (self.seen - 1) % self.stride:
            return
        if len(self.calls) >= self.limit:
            self.calls = self.calls[::2]
            self.stride *= 2
        m = self.m
        sp = uc.reg_read(UC_M68K_REG_A7)
        ret = m.r32(sp)
        raw = bytes(m.uc.mem_read(sp + 4, self.argbytes))
        call = {"before": read_globals(m), "args": raw, "sp": sp}
        if self.on_enter:
            call["argv"] = self.on_enter(m, raw)
        self.pending.append(call)

        def leave(uc2, address2, size2, _2):
            if uc2.reg_read(UC_M68K_REG_A7) <= sp:      # a deeper call returning here
                return
            uc2.hook_del(handle[0])
            self.pending.remove(call)
            call["after"] = read_globals(m)
            if self.on_leave:
                call["out"] = self.on_leave(m, call["args"])
            slot = sp + 4 + self.argbytes
            if self.result == "l":
                call["result"] = m.r32(slot)
            elif self.result == "w":
                call["result"] = m.r16(slot)
            elif self.result == "b":
                call["result"] = m.r8(slot)
            self.calls.append(call)
        handle = [uc.hook_add(UC_HOOK_CODE, leave, begin=ret, end=ret)]


class Game:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.d = Diff()
        self.m = self.d.m
        self.rec = GameRecorder(self.d)
        self.qd = QuickDraw(self.m)
        self.qd.install()
        self.decided = False
        self.first_handoff = False
        self.days = 0

    def new_game(self, skill, auto_play):
        m, rec, rng = self.m, self.rec, self.rng
        m.write_global(GAME_MODE, b"\x00")
        m.write_global(SKILL, bytes([skill]))
        m.write_global(AUTO_PLAY, bytes([1 if auto_play else 0]))
        m.write_global(AUTO_PLAY_REQUESTED, bytes([1 if auto_play else 0]))
        m.write_global(PLAYER_MAPS + COMPUTER_FLAG, bytes([1 if auto_play else 0]))
        m.write_global(PLAYER_MAPS + PLAYER_MAP_SIZE + COMPUTER_FLAG, b"\x01")
        m.write_global(ISLAND_POLYS, bytes(60))
        rec.clock = rng.getrandbits(32)
        rec.production = [rng.randint(0, 7) for _ in range(8)]
        rec.actions, rec.next = actions_for(rng, 100000), 0
        rec.log = []
        m.call(10, 0x093C, max_insns=500_000_000)
        m.write_global(LOCAL_PLAYER, b"\x01")
        m.write_global(NET_TURN, b"\x01")
        m.call(1, 0x1628)                       # SetUpControllers

    def day(self):
        rec = self.rec
        rec.clock = (rec.clock + self.rng.randint(30, 600)) & 0xFFFFFFFF
        self.decided, self.first_handoff, quit_ = rec.run_day(self.decided, self.first_handoff)
        self.days += 1
        return quit_

    def globals(self):
        return read_globals(self.m)


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    auto = "--auto" in sys.argv
    g = Game(seed)
    g.new_game(skill=g.rng.randint(1, 10), auto_play=auto)
    data = g.globals()
    for i in range(days):
        g.day()
        data = g.globals()
        pieces = sum(1 for k in range(1, 451)
                     if data[GLOBALS_SIZE - 0x5138 + 14 * k + 10] & 0x0F not in (8, 9))
        owners = [data[GLOBALS_SIZE - 0x385E + 10 * c + 4] for c in range(1, data[GLOBALS_SIZE - 0x1E4F] + 1)]
        print(f"day {int.from_bytes(data[GLOBALS_SIZE + DAY:GLOBALS_SIZE + DAY + 2], 'big')}: "
              f"{pieces} pieces, cities p1 {owners.count(1)} p2 {owners.count(2)} neutral {owners.count(0)}")
