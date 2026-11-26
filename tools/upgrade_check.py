"""Release-upgrade check: a returning visitor must get a new release, not old cached files.

Emulates the live setup's worst case: every response says "keep for 4 hours" (what Cloudflare tells
browsers). Publishes build 1001, visits both pages, publishes build 1002 with a changed stylesheet,
visits again and expects the new stylesheet without a manual refresh.

The releases are put together exactly as the Dockerfile does it (tools/assemble.py).

Usage: python tools/upgrade_check.py [repo_dir] [work_dir] [--from OLD_RELEASE_DIR]
       --from: publish an older release first (e.g. a `git archive` of a previous commit of this
       repository, including its projects/ folder)
Needs: pip install playwright && python -m playwright install chromium
Exit code is non-zero if the new release doesn't arrive.
"""
import argparse
import http.server
import os
import shutil
import sys
import tempfile
import threading
import time
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assemble  # noqa: E402

PORT = 8611

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("repo", nargs="?", type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument("work", nargs="?", type=Path)
parser.add_argument("--from", dest="old_release", type=Path)
args = parser.parse_args()

work = args.work or Path(tempfile.mkdtemp(prefix="agt-upgrade-"))
site, profile = work / "site", work / "profile"


def deploy(build, marker, source):
    """Publish `source` as release `build`; `marker` is a CSS value the test can read back."""
    if site.exists():
        shutil.rmtree(site)
    site.mkdir(parents=True)
    assemble.build(site, stamp=build, root=source)
    css = site / "assets" / "style.css"
    css.write_text(css.read_text(encoding="utf-8") + f"\n:root {{ --deploy-marker: {marker}; }}\n", encoding="utf-8")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        local = super().translate_path(path)
        return local + ".html" if not os.path.exists(local) and os.path.exists(local + ".html") else local

    def end_headers(self):
        self.send_header("Cache-Control", "public, max-age=14400")   # what Cloudflare tells browsers
        super().end_headers()

    def log_message(self, *args):
        pass


MARKER = "getComputedStyle(document.documentElement).getPropertyValue('--deploy-marker').trim()"
# The home page's layout comes from home.css: its two-column hero only appears if that file is current.
HOME_LAYOUT = """(() => {
    const hero = document.querySelector('.hero');
    return !!hero && getComputedStyle(hero).display === 'grid';
})()"""

if profile.exists():
    shutil.rmtree(profile)
deploy("1001", 1, args.old_release or args.repo)
server = http.server.ThreadingHTTPServer(("", PORT), partial(Handler, directory=str(site)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://localhost:{PORT}/"
ok = True

with sync_playwright() as pw:
    context = pw.chromium.launch_persistent_context(str(profile), viewport={"width": 1280, "height": 900})
    page = context.new_page()

    # First visit: both pages, long enough for the offline copy to be stored.
    page.goto(url, wait_until="networkidle")
    page.evaluate("navigator.serviceWorker.ready")
    page.wait_for_timeout(1500)
    page.goto(url + "ai-grid-trader", wait_until="networkidle")
    page.wait_for_timeout(800)
    page.goto(url, wait_until="networkidle")
    controlled = page.evaluate("!!navigator.serviceWorker.controller")
    print(f"visit 1 (build 1001): marker {page.evaluate(MARKER)} | offline copy active: {controlled}")

    deploy("1002", 2, args.repo)                    # publish a new version

    def read_marker():
        try:
            return page.evaluate(MARKER)
        except Exception:                           # the page is reloading itself
            page.wait_for_load_state("networkidle")
            return None

    for path in ["", "ai-grid-trader"]:
        page.goto(url + path, wait_until="networkidle")
        deadline = time.time() + 15
        while time.time() < deadline and read_marker() != "2":
            page.wait_for_timeout(500)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        marker = page.evaluate(MARKER)
        if path == "":
            drawn = page.evaluate(HOME_LAYOUT)
            detail = f"home layout applied: {drawn}"
        else:
            drawn = page.locator('#chart-main .main-svg').count() > 0
            detail = f"chart drawn: {drawn}"
        print(f"after deploy, /{path}: marker {marker} | {detail}")
        ok = ok and marker == "2" and drawn
    context.close()

server.shutdown()
print("UPGRADE OK" if ok else "UPGRADE FAILED")
sys.exit(0 if ok else 1)
