"""Differential test: whole games with the computer opponent, the engine against the
original.

Usage: python3 -I tools/emu/test_aigame.py [games] [days] [seed] [--verbose]

Games of the original run in the emulator with its computer opponent playing (aigame.py):
alternately with the computer on both sides (Auto Play) and against the scripted player
of test_turn.py. The new game, then each day, is run by the engine too, from the
original's state before it (the islands' outlines given as the engine keeps them), with
the computer opponent playing (engine/src/ai/opponent.ts) and the same clock and scripted
player; the globals after it, and the requests, messages and user-interface events that
reach the human controller, are compared. A game stops at its first mismatch.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from aigame import Game  # noqa: E402
from jsbridge import read_globals  # noqa: E402
from test_ai import island_bounds, with_bounds  # noqa: E402
from test_day import compare_globals, compare_logs  # noqa: E402
from test_newgame import IGNORED  # noqa: E402

GAME_MODE, SKILL, AUTO_PLAY, ISLAND_POLYS = -0x1E71, -0x2CE6, -0x120C, -0x1E36
AUTO_PLAY_REQUESTED, PLAYER_MAPS, PLAYER_MAP_SIZE, COMPUTER_FLAG = -0x120D, -0x2CD8, 642, 0x280
LOCAL_PLAYER, NET_TURN = -0x2D0A, -0x1C07


def report(label, problems, verbose, rec_log=None):
    print(f"MISMATCH {label}")
    for p in problems:
        print("   ", p)
    if verbose and rec_log:
        for e in rec_log[:80]:
            print("      ", e)


def play(seed, days, auto, verbose):
    g = Game(seed)
    d, m, rec, rng = g.d, g.m, g.rec, g.rng
    for off, size in IGNORED:
        for k in range(size):
            d.ignore.add(off + k)
    skill = rng.randint(1, 10)
    m.write_global(GAME_MODE, b"\x00")
    m.write_global(SKILL, bytes([skill]))
    m.write_global(AUTO_PLAY, bytes([1 if auto else 0]))
    m.write_global(AUTO_PLAY_REQUESTED, bytes([1 if auto else 0]))
    m.write_global(PLAYER_MAPS + COMPUTER_FLAG, bytes([1 if auto else 0]))
    m.write_global(PLAYER_MAPS + PLAYER_MAP_SIZE + COMPUTER_FLAG, b"\x01")
    m.write_global(ISLAND_POLYS, bytes(60))
    rec.clock = rng.getrandbits(32)
    rec.production = [rng.randint(0, 7) for _ in range(8)]
    production = list(rec.production)
    from test_turn import actions_for
    rec.actions, rec.next = actions_for(rng, 100000), 0
    rec.log = []
    before = read_globals(m)
    m.call(10, 0x093C, max_insns=500_000_000)
    after = read_globals(m)
    _, mem, log = d.js.call("newGame", before, [rec.clock, production, IGNORED, 1])
    label = f"game {seed} (skill {skill}, auto play {auto})"
    problems = []
    diff = compare_logs(rec.log, log)
    if diff:
        problems.append(f"log entry {diff[0]}: original {diff[1]}, engine {diff[2]}")
    compare_globals(d, after, mem, problems)
    d.count += 1
    if problems:
        report(f"{label}: new game", problems, verbose, rec.log)
        return False
    bounds = island_bounds(m)
    m.write_global(LOCAL_PLAYER, b"\x01")
    m.write_global(NET_TURN, b"\x01")
    m.call(1, 0x1628)                       # SetUpControllers
    for day in range(1, days + 1):
        rec.clock = (rec.clock + rng.randint(30, 600)) & 0xFFFFFFFF
        decided, first = g.decided, g.first_handoff
        actions = rec.actions[rec.next:rec.next + 4000]
        production = list(rec.production)
        rec.log, rec.ends = [], []
        before = with_bounds(read_globals(m), bounds)
        g.decided, g.first_handoff, quit_ = rec.run_day(decided, first)
        after = with_bounds(read_globals(m), bounds)
        result, mem, log = d.js.call("runDay", before, [actions, rec.clock, decided, first, 1, production])
        problems = []
        expect = [["alert", 0x410] in rec.ends, ["dialog", 0x14A] in rec.ends, g.decided, g.first_handoff]
        if result != expect:
            problems.append(f"result: original {expect} {rec.ends}, engine {result}")
        diff = compare_logs(rec.log, log)
        if diff:
            problems.append(f"log entry {diff[0]}: original {diff[1]}, engine {diff[2]}")
        compare_globals(d, after, mem, problems)
        d.count += 1
        if problems:
            report(f"{label}: day {day}", problems, verbose, rec.log)
            return False
        if verbose and day % 10 == 0:
            print(f"{label}: day {day} matches")
        if quit_:
            break
    print(f"{label}: {day} days match")
    return True


def run(games, days, seed, verbose):
    ok = True
    for gi in range(games):
        ok &= play(seed + gi, days, gi % 2 == 0, verbose)
    return ok


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    games = int(args[0]) if args else 2
    days = int(args[1]) if len(args) > 1 else 30
    seed = int(args[2]) if len(args) > 2 else 1
    sys.exit(0 if run(games, days, seed, "--verbose" in sys.argv) else 1)
