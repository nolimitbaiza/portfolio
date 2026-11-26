"""Build assets/og-card.png, the link preview for the home page and the posts (1200x630).

LinkedIn, Slack, email and X show it when someone shares a link: photo, name, role, the
headline and the project's full-year result. The demo and the case study keep assets/og.png,
the trading chart.

    python tools/serve.py &
    python tools/build_og_card.py [http://localhost:8600/]

Keep the numbers in step with the hero on index.html (node tools/writing_numbers.js).
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8600/"
OUT = Path(__file__).resolve().parent.parent / "assets" / "og-card.png"

HTML = """<!doctype html><html><head><meta charset="utf-8"><base href="{url}"><style>
@font-face {{ font-family: Inter; src: url("assets/fonts/inter-latin-var.woff2") format("woff2"); font-weight: 100 900; }}
@font-face {{ font-family: Mono; src: url("assets/fonts/jetbrains-mono-latin-500.woff2") format("woff2"); }}
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: 1200px; height: 630px; }}
body {{
  font-family: Inter, sans-serif; color: #0c0a09; padding: 64px 72px 56px;
  display: flex; flex-direction: column; font-feature-settings: "cv11", "ss01";
  background: radial-gradient(900px 520px at 100% 0%, #ecf6f1, transparent 70%), #fafaf9;
}}
.who {{ display: flex; align-items: center; gap: 24px; }}
.who img {{ width: 104px; height: 104px; border-radius: 50%; box-shadow: 0 0 0 4px #fff, 0 0 0 5px #e7e5e4; }}
.name {{ font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }}
.role {{ margin-top: 6px; font-size: 22px; color: #57534e; }}
h1 {{ margin-top: 40px; font-size: 62px; line-height: 1.08; font-weight: 700; letter-spacing: -0.035em; max-width: 24ch; }}
h1 em {{ font-style: normal; text-decoration: underline; text-decoration-color: #047857;
        text-decoration-thickness: 5px; text-underline-offset: 8px; }}
.seek {{ margin-top: 26px; display: flex; align-items: center; gap: 12px; font-size: 24px; color: #0c0a09; font-weight: 500; }}
.seek i {{ width: 10px; height: 10px; border-radius: 50%; background: #047857; box-shadow: 0 0 0 5px #04785722; }}
.foot {{ margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }}
.stats {{ display: flex; gap: 12px; }}
.stat {{ padding: 12px 18px; border: 1px solid #e7e5e4; border-radius: 14px; background: #fff; font-size: 20px; color: #57534e; }}
.stat b {{ color: #0c0a09; font-weight: 700; }}
.stat b.pos {{ color: #047857; }}
.site {{ font: 500 22px Mono, monospace; color: #047857; white-space: nowrap; }}
</style></head><body>
<div class="who"><img src="assets/img/profile.jpg" alt="">
  <div><div class="name">Baizak Isaev</div>
  <div class="role">Computer Science · North American University · Class of 2027</div></div></div>
<h1>I build software that helps batteries put more <em>solar and wind</em> on the grid.</h1>
<div class="seek"><i></i>Looking for a summer 2027 internship in energy software</div>
<div class="foot">
  <div class="stats">
    <div class="stat">AI Grid Trader: <b>€2.54M</b> a year in Germany</div>
    <div class="stat"><b class="pos">93–95%</b> of perfect hindsight</div>
  </div>
  <div class="site">baizakisaev.com</div>
</div>
</body></html>"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 630})
    page.goto(URL + "robots.txt")                    # same origin as the fonts, so they load
    page.set_content(HTML.format(url=URL), wait_until="networkidle")
    page.evaluate("document.fonts.ready")
    assert page.evaluate("document.fonts.check('700 62px Inter')"), "Inter did not load"
    page.screenshot(path=str(OUT))
    browser.close()
print(f"{OUT.name}: {OUT.stat().st_size / 1e3:.0f} kB")
