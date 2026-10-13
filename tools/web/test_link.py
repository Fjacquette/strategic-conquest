"""Test of the players' direct connection (web/src/link.ts) in headless Chromium.

Usage: python3 -I tools/web/test_link.py

Two pages connect through invitation and reply codes, without a STUN server (both are on
this machine), and exchange messages both ways, small and large. Codes of the wrong kind,
mistyped or cut short are refused with a message, and closing one page's connection is
noticed by the other.
"""
import os
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(ROOT, "web")

# Host candidates as plain addresses (not mDNS names), so two pages on one machine connect.
ARGS = ["--disable-features=WebRtcHideLocalIpsWithMdns"]

SETUP = """
window.received = [];
window.closedCount = 0;
window.watch = (link) => {
  link.onMessage = (d) => window.received.push(Array.from(d.slice(0, 4)).concat([d.length]));
  link.onClose = () => { window.closedCount++; };
};
"""


def build(out_dir):
    js = subprocess.run(
        ["npx", "esbuild", "test/linkpage.ts", "--bundle", "--format=iife", "--target=es2022"],
        cwd=WEB, check=True, capture_output=True, text=True).stdout
    path = os.path.join(out_dir, "link.html")
    with open(path, "w") as f:
        f.write(f"<!doctype html><meta charset=utf-8><script>{js}</script><script>{SETUP}</script>")
    return "file://" + path


def main():
    failures = []

    def check(label, ok, detail=""):
        print(f"{'ok ' if ok else 'FAIL'} {label}{(': ' + str(detail)) if detail else ''}")
        if not ok:
            failures.append(label)

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        url = build(tmp)
        browser = p.chromium.launch(args=ARGS)
        a, b = browser.new_page(), browser.new_page()
        for page in (a, b):
            page.goto(url)
        invite = a.evaluate("""async () => {
            const { link, code } = await window.SC_LINK.Link.invite([]);
            window.link = link; window.watch(link); return code; }""")
        check("invitation code", invite.startswith("SCI1-"), f"{len(invite)} characters")

        for bad, want in ((invite.replace("SCI1", "SCR1"), "reply code, not an invitation"),
                          ("hello", "not a Strategic Conquest code"),
                          (invite[:len(invite) // 2], "incomplete or mistyped")):
            msg = b.evaluate("""async (code) => {
                try { await window.SC_LINK.Link.join(code, []); return "accepted"; }
                catch (e) { return (e instanceof window.SC_LINK.CodeError ? "" : "other: ") + e.message; } }""", bad)
            check(f"bad invitation refused ({want})", want in msg and not msg.startswith("other"), msg)

        # A code pasted with line breaks still works.
        wrapped = "\n".join(invite[i:i + 60] for i in range(0, len(invite), 60))
        reply = b.evaluate("""async (code) => {
            const { link, reply } = await window.SC_LINK.Link.join(code, []);
            window.link = link; window.watch(link); return reply; }""", wrapped)
        check("reply code", reply.startswith("SCR1-"), f"{len(reply)} characters")
        msg = a.evaluate("""async (code) => {
            try { await window.link.accept(code); return "accepted"; }
            catch (e) { return e.message; } }""", invite)
        check("invitation refused as a reply", "not a reply code" in msg, msg)
        a.evaluate("async (code) => { await window.link.accept(code); }", reply)
        a.evaluate("() => window.link.ready")
        b.evaluate("() => window.link.ready")
        check("connected", True)

        a.evaluate("() => window.link.send(new Uint8Array([1, 2, 3, 4]))")
        big = 60000
        b.evaluate(f"() => {{ const d = new Uint8Array({big}); d[0] = 9; d[3] = 7; window.link.send(d); "
                   "window.link.send(new Uint8Array([5, 6])); }")
        a.wait_for_function("() => window.received.length >= 2", timeout=5000)
        b.wait_for_function("() => window.received.length >= 1", timeout=5000)
        check("message from the inviting page", b.evaluate("() => window.received") == [[1, 2, 3, 4, 4]])
        check("large message, then a small one, in order",
              a.evaluate("() => window.received") == [[9, 0, 0, 7, big], [5, 6, 2]], a.evaluate("() => window.received"))

        b.evaluate("() => window.link.close()")
        a.wait_for_function("() => window.closedCount === 1", timeout=10000)
        check("closing is noticed by the other page", a.evaluate("() => window.closedCount") == 1)
        check("closing page notified once", b.evaluate("() => window.closedCount") == 1)
        browser.close()

    print("all passed" if not failures else f"{len(failures)} failed")
    return not failures


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
