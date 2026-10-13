"""Network games between two pages of the browser game, in headless Chromium.

Usage: python3 -I tools/web/test_netgame.py [seconds] [seed] [page]

One page invites (the Master, player 1), the other joins (the Slave, player 2), through the
setup dialog and the connection dialogs. Both players then answer every dialog with its
default button and move the piece they are asked to move a random way, or give it Random
orders, or put it to sleep (with a seeded generator, so a run can be repeated). Whenever the
Slave is asked to move a piece, the Master is waiting for its answer, so both pages must
hold the same game state (but for the bytes each page keeps for itself): that is checked
each time. The day must advance on both pages together, and neither page may raise an
error.

Midway the Master saves the game (File > Save As; without a file picker the game is
downloaded at the start of the next day). Two new pages then go on with it: the Master
chooses File > Resume Game at the setup screen and invites the other player again; the game
must go on from the saved day, with the same checks. Finally the Slave's page closes, and
the Master must say the connection was lost.
"""
import os
import random
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ARGS = ["--disable-features=WebRtcHideLocalIpsWithMdns"]
NO_PICKERS = "delete window.showSaveFilePicker; delete window.showOpenFilePicker;"
DIRECTION_KEYS = ["Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad6", "Numpad7", "Numpad8", "Numpad9"]
GLOBALS_SIZE = 0x55C4
LOCAL_ONLY = [(-0x2D0A, 1), (-0x23A, 4), (-0x1386, 4), (-0x1920, 4)]
SKIP = set()
for _off, _size in LOCAL_ONLY:
    SKIP.update(range(GLOBALS_SIZE + _off, GLOBALS_SIZE + _off + _size))


def differences(a, b):
    return [i - GLOBALS_SIZE for i in range(len(a)) if a[i] != b[i] and i not in SKIP]


def state(page):
    return page.evaluate("() => Array.from(window.scState())")


def day_of(image):
    k = GLOBALS_SIZE - 0x2D08
    return (image[k] << 8) | image[k + 1]


def menu(page, title, item):
    page.click(f".menubar .title:text-is('{title}')")
    page.click(f".menubar .items button:has-text('{item}')")


class Game:
    """Two pages, the Master's and the Slave's, and the checks made while they play."""

    def __init__(self, ctx, url, rng, out):
        self.rng, self.out = rng, out
        self.errors = []
        self.checks = self.mismatches = 0
        self.moves = {"master": 0, "slave": 0}
        self.saved = None
        self.a, self.b = ctx.new_page(), ctx.new_page()
        for name, page in (("master", self.a), ("slave", self.b)):
            page.on("pageerror", lambda e, n=name: self.errors.append(f"{n}: {e}"))
            page.goto(url)
            page.wait_for_selector("#dialog button.default")

    def connect(self, resume=None):
        a, b = self.a, self.b
        if resume:
            with a.expect_file_chooser() as fc:
                menu(a, "File", "Resume Game")
            fc.value.set_files(resume)
            a.wait_for_selector("#dialog :text('network game')")
            a.click("#dialog button.default")
        else:
            a.click("#dialog label:text-is('Network Game: Invite')")
            a.click("#dialog button.default")
        a.wait_for_selector("#dialog textarea.code[readonly]", timeout=20000)
        invitation = a.input_value("#dialog textarea.code[readonly]")
        b.click("#dialog label:text-is('Network Game: Join')")
        b.click("#dialog button.default")
        b.fill("#dialog textarea.code", invitation)
        b.click("#dialog button.default")
        b.wait_for_selector("#dialog textarea.code[readonly]", timeout=20000)
        reply = b.input_value("#dialog textarea.code[readonly]")
        a.fill("#dialog textarea.code:not([readonly])", reply)
        a.click("#dialog button.default")
        print(f"codes: invitation {len(invitation)}, reply {len(reply)} characters")

    def dialog(self, name, page):
        text = page.inner_text("#dialog")
        if "Save current game as" in text:
            with page.expect_download() as dl:
                page.click("#dialog button.default")
            self.saved = os.path.join(self.out, "network.sav")
            dl.value.save_as(self.saved)
            print(f"{name}: saved on day {day_of(state(page))}")
        elif page.is_visible("#dialog button.default") and page.is_enabled("#dialog button.default"):
            try:
                page.click("#dialog button.default", timeout=2000)
            except Exception:  # the dialog closed meanwhile
                pass

    def play(self, seconds, save_after=None):
        a, b = self.a, self.b
        start = time.time()
        asked = False
        while time.time() - start < seconds:
            if save_after is not None and not asked and time.time() - start > save_after and not a.is_visible("#overlay"):
                menu(a, "File", "Save as")
                asked = True
            for name, page in (("master", a), ("slave", b)):
                if page.is_visible("#overlay"):
                    self.dialog(name, page)
                    continue
                if not page.query_selector("#turn-icon canvas"):
                    continue
                if name == "slave":
                    diff = differences(state(a), state(b))
                    self.checks += 1
                    if diff:
                        self.mismatches += 1
                        if self.mismatches <= 3:
                            print(f"state differs at {len(diff)} bytes, first {[hex(d) for d in diff[:8]]}")
                roll = self.rng.random()
                page.keyboard.press(self.rng.choice(DIRECTION_KEYS) if roll < 0.6 else "r" if roll < 0.9 else "s")
                self.moves[name] += 1
            a.wait_for_timeout(40)
        days = {"master": day_of(state(a)), "slave": day_of(state(b))}
        print(f"days: {days}, moves answered: {self.moves}, state checks: {self.checks}, mismatches: {self.mismatches}")
        return days

    def slave_leaves(self, seconds=20):
        """The Slave's page closes; whether the Master then says the connection was lost
        (the Master's player goes on moving until the game next needs the Slave)."""
        self.b.close()
        a, start = self.a, time.time()
        while time.time() - start < seconds:
            if a.is_visible("#overlay"):
                if "connection to the other player was lost" in a.inner_text("#dialog"):
                    return True
                self.dialog("master", a)
            elif a.query_selector("#turn-icon canvas"):
                a.keyboard.press("s")
            a.wait_for_timeout(100)
        return False

    def close(self):
        self.a.close()
        self.b.close()


def main(seconds, url, seed):
    rng = random.Random(seed)
    ok = True
    with tempfile.TemporaryDirectory() as out, sync_playwright() as p:
        browser = p.chromium.launch(args=ARGS)
        ctx = browser.new_context(viewport={"width": 1000, "height": 650}, accept_downloads=True)
        ctx.add_init_script(NO_PICKERS)

        g = Game(ctx, url, rng, out)
        g.connect()
        days = g.play(seconds, save_after=seconds / 2)
        ok &= not g.errors and g.mismatches == 0 and g.checks > 0 and days["master"] > 2
        ok &= 0 <= days["master"] - days["slave"] <= 1 and g.saved is not None
        print("errors:", g.errors[:5])
        saved = g.saved
        g.close()

        if saved:
            saved_day = (open(saved, "rb").read()[6] << 8) | open(saved, "rb").read()[7]
            g = Game(ctx, url, rng, out)
            g.connect(resume=saved)
            days = g.play(seconds / 2)
            print(f"resumed from day {saved_day}")
            # Player 2 may have no piece left to command by now (all asleep or on Random orders),
            # so this part need not reach a state check.
            ok &= not g.errors and g.mismatches == 0 and days["master"] > saved_day
            ok &= 0 <= days["master"] - days["slave"] <= 1
            print("errors:", g.errors[:5])
            g.a.screenshot(path=os.path.join(os.environ.get("OUT", out), "net-master.png"))
            g.b.screenshot(path=os.path.join(os.environ.get("OUT", out), "net-slave.png"))
            lost = g.slave_leaves()
            print("the Master is told the connection was lost" if lost else "the Master is not told the connection was lost")
            ok &= lost
            g.a.close()
        browser.close()
    print("passed" if ok else "FAILED")
    return ok


if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 60
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    page = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, "web", "dist", "play.html")
    sys.exit(0 if main(secs, "file://" + os.path.abspath(page), seed) else 1)
