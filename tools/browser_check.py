"""Cross-browser smoke test: Chromium, Firefox, WebKit (Safari's engine) and an iPad.

Usage: serve the repo locally (python tools/serve.py), then
       python tools/browser_check.py [http://localhost:8600/] [screenshot_dir] [chromium,firefox,webkit,ipad,offline]
Needs: pip install playwright && python -m playwright install chromium firefox webkit
Exit code is non-zero if any check fails.
"""
import re
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Results include symbols such as "€" and "−"; a Windows console may not be able to print them.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8600/"
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(tempfile.gettempdir()) / "agt-shots"
SHOTS.mkdir(parents=True, exist_ok=True)
CSV = "timestamp,price_eur_mwh\n" + "".join(
    f"2025-06-{2 + h // 24:02d} {h % 24:02d}:00,{40 + 30 * ((h % 24) in range(17, 21)) - 25 * ((h % 24) in range(11, 15))}\n"
    for h in range(24 * 4))
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# Cloudflare adds its analytics beacon to the live site. It is not part of the
# demo, and some networks block it, so failing to load it is not counted.
BEACON_HOST = "static.cloudflareinsights.com"


def counts_as_error(m):
    if m.type != "error" or "profile.jpg" in m.text or "404" in m.text:
        return False
    return BEACON_HOST not in (m.location or {}).get("url", "") and BEACON_HOST not in m.text


def run(pw, label, browser_type, **ctx):
    print(f"\n== {label}")
    browser = browser_type.launch()
    context = browser.new_context(service_workers="block", **ctx)
    context.add_init_script("window.print = () => { window.__printed = true; };")
    if browser_type is pw.webkit:
        # Playwright's WebKit build says it plays WebM/VP9, but loading the demo loop stalls its page
        # screenshots. Real Safari only says yes when it can play it. Here WebKit checks the fallback:
        # the screenshots stay when the video can't play.
        context.add_init_script("HTMLMediaElement.prototype.canPlayType = () => '';")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: counts_as_error(m) and errors.append(m.text))
    page.goto(URL + "ai-grid-trader", wait_until="networkidle")

    kpis = page.locator("#kpis .value").all_inner_texts()
    check("page renders 5 headline numbers", len(kpis) == 5 and all(kpis), " | ".join(kpis))
    check("main chart drawn", page.locator("#chart-main .main-svg").count() > 0)

    pts = page.locator("#chart-main .scatterlayer .trace .points path")
    if pts.count():
        pts.nth(min(3, pts.count() - 1)).click(force=True)
        page.wait_for_timeout(400)
    check("clicking a trade opens 'Why this trade?'", page.is_visible("#explain") and "MW" in page.inner_text("#explain-body"))

    page.click(".chip[data-key=de]")          # loads Germany's prices on demand
    try:
        page.wait_for_function("document.querySelector('#kpis .value').textContent.includes('€')", timeout=15000)
    except Exception:
        pass
    check("real market (Germany) loads", "€" in page.locator("#kpis .value").first.inner_text())
    check("source line shows data provenance", "SMARD" in page.inner_text("#source"))
    try:
        page.wait_for_function("!document.getElementById('stack').classList.contains('pending')"
                               " && document.getElementById('life-kpis').children.length === 4", timeout=180000)
        ok = True
    except Exception:
        ok = False
    check("full-year simulation finishes (revenue streams + lifetime)", ok)
    if ok:
        check("revenue streams total shown", "Total per year" in page.inner_text("#stack-table"))
        life = page.locator("#life-kpis .value").all_inner_texts()
        check("lifetime figures shown", len(life) == 4 and all(life), " | ".join(life))
        # Charts below the fold are drawn when they come near the screen (faster first load).
        page.locator("#lifetime").scroll_into_view_if_needed()
        try:
            page.wait_for_function("document.querySelector('#chart-health .main-svg') && document.querySelector('#chart-cash .main-svg')"
                                   " && document.querySelector('#chart-cum .main-svg')", timeout=8000)
        except Exception:
            pass
        check("lifetime and profit charts drawn once scrolled to",
              page.locator("#chart-health .main-svg").count() > 0 and page.locator("#chart-cash .main-svg").count() > 0
              and page.locator("#chart-cum .main-svg").count() > 0)
        # Dragging a slider end to end must not move it up or down in its card (values such as
        # "none" -> "$40 per kW per year" used to re-wrap the label; text above it changed length).
        moved = page.evaluate("""async () => {
            const out = [];
            for (const id of ['in-capp', 'in-solar', 'in-clife', 'in-res']) {
                const input = document.getElementById(id), card = input.closest('.card'), start = input.value, tops = new Set();
                for (let i = 0; i <= 8; i++) {
                    input.value = +input.min + (input.max - input.min) * i / 8;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                    tops.add(Math.round(input.getBoundingClientRect().top - card.getBoundingClientRect().top));
                }
                input.value = start; input.dispatchEvent(new Event('input', { bubbles: true }));
                const t = [...tops];
                if (Math.max(...t) - Math.min(...t) > 2) out.push(id + ' ' + t.join('/'));
            }
            return out;
        }""")
        check("sliders stay level while dragged", not moved, "; ".join(moved))
        # The drags re-run the full year, which dims three cards while it works. Let it finish and the
        # cards fade back, so the checks that follow (the accessibility audit too) see the settled page.
        try:
            page.wait_for_function("""['annual', 'stack', 'lifetime'].every((id) => !document.getElementById(id).classList.contains('pending'))
                && !document.querySelector('#annual-status .spinner')""", timeout=120000)
        except Exception:
            pass
        page.wait_for_timeout(600)

    page.click("#explain-first")                  # keyboard-friendly route to "Why this trade?"
    page.wait_for_timeout(300)
    check("'explain the first trade' button works", page.is_visible("#explain") and "trades" in page.inner_text("#explain-body"))
    if label.startswith("Chromium"):
        # Automated accessibility audit (axe-core: contrast, labels, roles, ...), both themes.
        page.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js")
        audit = "async () => (await axe.run(document, {resultTypes: ['violations']})).violations.map(v => v.id + ' x' + v.nodes.length)"
        for theme in ("light", "dark"):
            page.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
            page.wait_for_timeout(500)
            found = page.evaluate(audit)
            check(f"no accessibility violations ({theme} theme)", not found, ", ".join(found))
        page.evaluate("document.documentElement.removeAttribute('data-theme')")

    # Presenter mode: Present opens a step-by-step walkthrough that the arrow keys move through.
    page.click("#btn-present")
    page.wait_for_selector("#stage:not([hidden])")
    step = lambda: page.evaluate("document.getElementById('stage-slide').dataset.step")
    def callout(word):
        try:
            page.wait_for_function(f"(() => {{ const c = document.getElementById('stage-callout');"
                                   f" return c && !c.hidden && c.textContent.includes('{word}'); }})()", timeout=15000)
            return page.inner_text("#stage-callout")
        except Exception:
            return ""
    dots = page.locator("#stage-dots .stage-dot").count()
    check("presenter: opens on the market step, the page behind made inert",
          step() == "market" and dots == 6 and page.evaluate("document.querySelector('main').inert"), f"{step()}, {dots} steps")
    page.keyboard.press("ArrowRight")
    text = callout("Buys")
    check("presenter: replays to the first buy and explains it", "MW" in text and "/MWh" in text, text.replace("\n", " ")[:80])
    page.keyboard.press("ArrowRight")
    text = callout("Sells")
    check("presenter: then the first sell", "MW" in text, text.replace("\n", " ")[:80])
    page.keyboard.press("ArrowRight")
    try:
        page.wait_for_function("document.getElementById('stage-title').textContent.includes('48 hours')", timeout=15000)
    except Exception:
        pass
    check("presenter: then the rest of the 48 hours", page.is_hidden("#stage-callout") and "trades in 48 hours" in page.inner_text("#stage-title"),
          page.inner_text("#stage-title"))
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(1300)                   # headline numbers count up
    big = page.locator("#stage-slide .stage-kpi .value").all_inner_texts()
    check("presenter: result step shows the numbers and the chart", step() == "result" and len(big) == 4 and all(big)
          and page.locator("#stage-chart-a .main-svg").count() > 0, " | ".join(big))
    page.keyboard.press("ArrowLeft")
    try:
        page.wait_for_function("document.getElementById('stage-title').textContent.includes('48 hours')", timeout=5000)
    except Exception:
        pass
    check("presenter: going back returns to the finished trades", step() == "trades" and "48 hours" in page.inner_text("#stage-title"))
    page.click("#stage-dots .stage-dot[data-i='3']")
    page.wait_for_timeout(600)
    check("presenter: step dots jump to the full year", step() == "year" and page.locator("#stage-chart-a .main-svg").count() > 0)
    page.keyboard.press("End")
    try:
        page.wait_for_function("[...document.querySelectorAll('.stage-qr img')].every((i) => i.complete && i.naturalWidth > 0)", timeout=5000)
    except Exception:
        pass
    check("presenter: closing screen has both QR codes and the email",
          step() == "contact" and page.evaluate("[...document.querySelectorAll('.stage-qr img')].filter((i) => i.naturalWidth > 0).length") == 2
          and "baizak@baizakisaev.com" in page.inner_text("#stage-slide"))
    if label.startswith("Chromium"):
        page.wait_for_timeout(700)                # the slide has finished fading in
        found = page.evaluate("async () => (await axe.run('#stage', {resultTypes: ['violations']})).violations"
                              ".map(v => v.id + ' ' + v.nodes.map(n => n.target.join(' ')).join(', '))")
        check("presenter: no accessibility violations", not found, ", ".join(found))
    page.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_present.png"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check("presenter: Esc leaves and gives the page back",
          page.is_hidden("#stage") and not page.evaluate("document.querySelector('main').inert")
          and page.evaluate("document.activeElement.id") == "btn-present")

    page.click(".seg button[data-mode=hindsight]")
    try:   # the emulated iPad draws slowly (a frame can take 250 ms there), so wait for the re-plan
        page.wait_for_function("document.querySelectorAll('#kpis .value')[2].textContent === '100%'", timeout=5000)
    except Exception:
        pass
    third = page.locator("#kpis .value").nth(2).inner_text()
    check("hindsight switch works", third == "100%", third)
    page.click(".seg button[data-mode=forecast]")

    before = page.evaluate("getComputedStyle(document.body).backgroundColor")
    page.click("#btn-theme")
    try:   # the colour change is a short CSS transition
        page.wait_for_function(f"getComputedStyle(document.body).backgroundColor !== '{before}'", timeout=3000)
    except Exception:
        pass
    after = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check("light/dark switch changes theme", before != after, f"{before} -> {after}")

    # Business case for Germany (a real market, so every part of the page is exercised).
    page.click("#btn-report")
    page.fill("[name=client]", "Test Client")
    page.click(".dialog .btn-primary")
    page.wait_for_function("window.__printed === true", timeout=15000)
    report = page.evaluate("document.getElementById('report').textContent")
    check("business case builds (chart image + print)", page.locator("#report img").count() == 1)
    check("business case defaults to your name", "Baizak Isaev" in report)
    check("business case text is fully filled in", "${" not in report and "undefined" not in report
          and re.search(r"\d{4} market average", report) is not None)

    page.set_input_files("#file-input", files=[{"name": "prices.csv", "mimeType": "text/csv", "buffer": CSV.encode()}])
    page.wait_for_timeout(500)
    check("CSV upload adds 'Your data'", page.locator(".chip[data-key=upload]").count() == 1)

    check("project page has no 'Built by' card", page.locator("#contact").count() == 0)
    names = [page.get_attribute(f"#btn-{b}", "aria-label") for b in ("play", "report", "share", "present", "theme")]
    check("header buttons have accessible names", all(names), str(names))
    check("demo: header and intro both link to the case study",
          page.get_attribute(".demo-header .nav-case", "href") == "ai-grid-trader-case-study" and page.is_visible(".demo-header .nav-case")
          and page.get_attribute(".intro .case-card", "href") == "ai-grid-trader-case-study" and page.is_visible(".intro .case-card"))
    check("demo: footer links to the how-to guide", page.locator('footer a[href="ai-grid-trader-case-study#guide"]').count() == 1)
    swatches = page.evaluate("""[...document.querySelectorAll('.chart-head .legend .sw')].map((i) => {
        const s = getComputedStyle(i); return i.offsetHeight > 0 && (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth) > 0); })""")
    check("demo: chart legend swatches are visible", len(swatches) == 3 and all(swatches), str(swatches))
    check("demo: the 'Agent sees' switch shows its sliding pill", page.evaluate("document.querySelector('.seg').classList.contains('has-ind')"))

    about = context.new_page()
    about.on("pageerror", lambda e: errors.append(str(e)))
    about.goto(URL, wait_until="networkidle")
    text = about.inner_text("main")
    words = about.text_content("main")             # as written (inner_text applies CSS uppercase)
    check("Home page introduces me and the project", "North American University" in words and "AI Grid Trader" in words
          and "About me" in words)
    check("Home page: business email link", about.get_attribute("#email-link", "href").startswith("mailto:baizak@baizakisaev.com"))
    check("Home page: photo loads", about.evaluate("(() => { const i = document.querySelector('.hero-id .avatar img'); return !!i && i.naturalWidth > 0; })()"))
    check("Home page: hero shows the project's numbers", about.locator(".proof .metric").count() == 3)
    check("Home page: copy-email button present", about.locator("[data-copy-email]").count() == 1)
    ctas = about.evaluate("[...document.querySelectorAll('.hero-ctas a')].map((a) => a.getAttribute('href'))")
    check("Home page: hero buttons open the demo and the case study", ctas == ["ai-grid-trader", "ai-grid-trader-case-study"], str(ctas))
    about.locator("#email-link").scroll_into_view_if_needed()
    about.click("#email-link")
    menu = about.locator("#mail-menu")
    hrefs = menu.locator("a").evaluate_all("(as) => as.map((a) => a.href)")
    check("Home page: Email me opens Gmail / Outlook / mail app / copy",
          menu.is_visible() and about.get_attribute("#email-link", "aria-expanded") == "true"
          and len(hrefs) == 3 and "mail.google.com" in hrefs[0] and "outlook.office.com" in hrefs[1]
          and hrefs[2].startswith("mailto:") and menu.locator("[data-mail-copy]").count() == 1
          and about.evaluate("document.activeElement.closest('#mail-menu') !== null"), str(hrefs))
    about.keyboard.press("Escape")
    check("Home page: Escape closes the email menu and returns focus",
          menu.is_hidden() and about.evaluate("document.activeElement.id") == "email-link")
    # The hero leads with the full-year results; the card lists its stack; About has the Now line.
    proof = about.text_content(".proof")              # includes the screen-reader values (the visible ones count up)
    check("Home page: hero shows the full-year results",
          "€2.54 million" in proof and "plus €3.09 million" in proof and "93–95%" in proof, " ".join(proof.split())[:160])
    check("Home page: AI Grid Trader card lists its stack", "JavaScript · Python" in about.inner_text("#work .project >> nth=0"))
    check("Home page: Now line in About", "summer 2027 internship" in about.inner_text("#about .now"))
    # Recruiter details: the internship in the hero and contact, the method, Pitwall's numbers, Skills.
    check("Home page: hero status and contact say internship",
          "summer 2027 internship" in about.inner_text(".hero .status")
          and "summer 2027 internship" in about.inner_text("#contact .contact-lede"))
    check("Home page: AI Grid Trader card names its method", "dynamic programming" in about.inner_text("#work .project >> nth=0"))
    f1 = about.inner_text("#work .project >> nth=1")
    check("Home page: Pitwall card has its coverage, finding and stack",
          "12,700+" in f1 and "33%" in f1 and "PostgreSQL" in f1, " ".join(f1.split())[-200:])
    skills = about.evaluate("[...document.querySelectorAll('#about .skills-list > div')].map(d => d.querySelector('dt').textContent + ':' + d.querySelectorAll('li').length)")
    check("Home page: Skills in About, in four groups", len(skills) == 4 and all(not s.endswith(":0") for s in skills), str(skills))
    # The screenshot is lazy: Firefox picks its source only once it starts loading, so load it now.
    about.evaluate("document.querySelectorAll('#work .project:nth-of-type(2) picture img').forEach((i) => { i.loading = 'eager'; })")
    try:
        about.wait_for_function("[...document.querySelectorAll('#work .project:nth-of-type(2) picture img')].some((i) => i.currentSrc && i.complete)", timeout=8000)
    except Exception:
        pass
    webp = about.evaluate("""() => [...document.querySelectorAll('#work .project:nth-of-type(2) picture img')].filter(i => i.currentSrc)
        .map(i => i.currentSrc.split('/').pop().split('?')[0])""")
    check("Home page: Pitwall screenshot loads as WebP", webp and all(w.endswith(".webp") for w in webp), str(webp))
    # The demo loop: plays in view where WebM/VP9 plays, otherwise the screenshots stay.
    loop = """() => { const v = document.querySelector('.demo-loop'), m = v.closest('.project-media');
        return {on: m.classList.contains('has-loop'), paused: v.paused, t: v.currentTime, src: v.currentSrc.split('/').pop().split('?')[0],
                button: !m.querySelector('.loop-toggle').hidden,
                shots: [...m.querySelectorAll('picture img')].filter((i) => getComputedStyle(i).display !== 'none').length}; }"""
    about.evaluate("document.querySelector('#work .project-media').scrollIntoView({block: 'center', behavior: 'instant'})")
    if browser_type is pw.webkit:
        about.wait_for_timeout(800)
        st = about.evaluate(loop)
        check("Home page: card keeps its screenshot where the video can't play", not st["on"] and st["shots"] == 1 and not st["button"], str(st))
        check("Home page: Pitwall card keeps its screenshot too",
              not about.evaluate("document.querySelector('#work .project:nth-of-type(2) .project-media').classList.contains('has-loop')"))
    else:
        try:
            about.wait_for_function("document.querySelector('.project-media').classList.contains('has-loop')", timeout=10000)
        except Exception:
            pass
        about.wait_for_timeout(600)
        st = about.evaluate(loop)
        check("Home page: demo loop plays in view, replacing the screenshot",
              st["on"] and not st["paused"] and st["t"] > 0 and st["shots"] == 0 and st["button"]
              and st["src"] == ("demo-loop-dark.webm" if about.evaluate("Site.theme()") == "dark" else "demo-loop.webm"), str(st))
        about.click(".loop-toggle")
        st = about.evaluate(loop)
        check("Home page: the pause button pauses the demo loop",
              st["paused"] and about.get_attribute(".loop-toggle", "aria-pressed") == "true", str(st))
        # Back and forward a slide: the arrows appear with the pointer over the video, and jump
        # between the slides' start times (wrapping round). Paused, they land once a slide has settled.
        opacity = "+getComputedStyle(document.querySelector('.loop-next')).opacity"
        box = about.locator("#work .project-media >> nth=0").bounding_box()
        below = min(box["y"] + box["height"] + 30, about.viewport_size["height"] - 4)   # the card's text
        about.mouse.move(box["x"] + box["width"] / 2, below)
        about.wait_for_timeout(400)
        away = about.evaluate(opacity)
        about.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        about.wait_for_timeout(400)
        check("Home page: slide arrows appear only with the pointer over the demo video",
              away == 0 and about.evaluate(opacity) == 1, f"{away} -> {about.evaluate(opacity)}")
        seek = """async (sel) => { const v = document.querySelector('.demo-loop');
            const done = new Promise((r) => v.addEventListener('seeked', r, {once: true}));
            document.querySelector(sel).click(); await done; return +v.currentTime.toFixed(2); }"""
        about.evaluate("""() => new Promise((r) => { const v = document.querySelector('.demo-loop');
            v.addEventListener('seeked', r, {once: true}); v.currentTime = 1; })""")
        hops = [about.evaluate(seek, s) for s in (".loop-next", ".loop-next", ".loop-prev", ".loop-prev", ".loop-prev")]
        scenes = [float(x) for x in about.get_attribute(".demo-loop", "data-scenes").split()]
        want = [round(scenes[i] + 1.2, 2) for i in (1, 2, 1, 0, len(scenes) - 1)]
        check("Home page: slide arrows step back and forward through the demo",
              all(abs(h - w) < 0.05 for h, w in zip(hops, want)) and about.evaluate("document.querySelector('.demo-loop').paused"),
              f"{hops}, expected {want}")
        about.click(".loop-toggle")
        # It starts a little before the card arrives, so "away" is the bottom of the page.
        about.evaluate("scrollTo({top: document.body.scrollHeight, behavior: 'instant'})")
        about.wait_for_timeout(500)
        check("Home page: demo loop pauses when scrolled away", about.evaluate(loop)["paused"])
        check("Home page: the wide still is the loop's first frame (no visible swap)",
              about.evaluate("[...document.querySelectorAll('#work .project:nth-of-type(1) .project-media picture img')].every((i) => /demo-loop(-dark)?\.jpg/.test(i.src))"))
        # Pitwall's card has its own loop through five seasons: one video for both themes.
        about.evaluate("document.querySelector('#work .project:nth-of-type(2) .project-media').scrollIntoView({block: 'center', behavior: 'instant'})")
        try:
            about.wait_for_function("document.querySelector('#work .project:nth-of-type(2) .project-media').classList.contains('has-loop')", timeout=10000)
        except Exception:
            pass
        about.wait_for_timeout(600)
        pit = about.evaluate("""() => { const m = document.querySelector('#work .project:nth-of-type(2) .project-media'), v = m.querySelector('.demo-loop');
            return {on: m.classList.contains('has-loop'), paused: v.paused, t: v.currentTime, src: v.currentSrc.split('/').pop().split('?')[0],
                    button: !m.querySelector('.loop-toggle').hidden, ratio: +(v.offsetWidth / v.offsetHeight).toFixed(2)}; }""")
        check("Home page: Pitwall loop plays in view, at its own shape",
              pit["on"] and not pit["paused"] and pit["t"] > 0 and pit["button"] and pit["src"] in ("pitwall-loop.webm", "pitwall-loop-dark.webm")
              and abs(pit["ratio"] - 2272 / 1764) < 0.02, str(pit))
    about.evaluate("document.activeElement.blur(); scrollTo({top: 0, behavior: 'instant'})")
    about.wait_for_timeout(600)
    check("Home page: degree and graduation year shown", "Computer Science" in words and "May 2027" in words)
    resume = about.evaluate("""async () => {
        const links = [...document.querySelectorAll('a[href*="Baizak-Isaev-Resume.pdf"]')];
        const r = links.length ? await fetch(links[0].href) : null;
        return { header: !!document.querySelector('.site-header a[href*="Resume.pdf"]'),
                 contact: !!document.querySelector('#contact a[href*="Resume.pdf"]'),
                 status: r && r.status, type: r && r.headers.get('content-type') };
    }""")
    check("Home page: résumé links in header and contact open the PDF",
          resume["header"] and resume["contact"] and resume["status"] == 200 and "pdf" in (resume["type"] or ""), str(resume))
    # The header's name appears only once the hero's name row has scrolled away.
    brand = "getComputedStyle(document.querySelector('.site-header .brand-link')).visibility"
    # Jumps are instant (the page scrolls smoothly, which is slow on CI) and each state is awaited.
    def settle(want):
        try:
            about.wait_for_function(f"{brand} === '{want}'", timeout=4000)
        except Exception:
            pass
    settle("hidden")                                # earlier checks scrolled down and back up
    at_top = about.evaluate(brand)
    about.evaluate("scrollTo({top: 600, behavior: 'instant'})")
    settle("visible")
    scrolled = about.evaluate(brand)
    about.evaluate("scrollTo({top: 0, behavior: 'instant'})")
    settle("hidden")
    check("Home page: header name hidden at top, shown after scrolling, hidden again",
          (at_top, scrolled, about.evaluate(brand)) == ("hidden", "visible", "hidden"), f"{at_top} / {scrolled}")
    about.click(".project-link")
    about.wait_for_load_state("networkidle")
    check("Home page: project card opens the demo", about.url.split("#")[0].split("?")[0].rstrip("/").endswith("ai-grid-trader") and about.locator("#chart-main").count() == 1, about.url)
    about.go_back(wait_until="networkidle")
    old = context.new_page()
    old.goto(URL + "#p=de&mode=forecast", wait_until="networkidle")
    check("old shared demo links still open the demo", "ai-grid-trader" in old.url and "p=de" in old.url, old.url)
    old.goto(URL + "about.html", wait_until="networkidle")
    check("old about.html link reaches the home page", old.locator(".hero").count() == 1, old.url)
    missing = old.goto(URL + "no-such-page", wait_until="load")
    check("unknown address shows the 'Page not found' page", missing.status == 404 and "Page not found" in old.inner_text("body"),
          f"status {missing.status}")
    old.close()
    if label.startswith("Chromium"):
        about.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js")
        found = about.evaluate("async () => (await axe.run(document, {resultTypes: ['violations']})).violations.map(v => v.id + ' x' + v.nodes.length)")
        check("Home page: no accessibility violations", not found, ", ".join(found))
    # Sections fade in as they scroll into view: scroll through like a reader, then check that
    # every one of them ended up visible before taking the full-page screenshot.
    # Each section is brought into view in turn: a fast sweep can skip past one before headless
    # WebKit on CI has reported it on screen.
    about.evaluate("""async () => {
        for (const el of document.querySelectorAll('[data-reveal]')) {
            el.scrollIntoView({block: 'center', behavior: 'instant'});
            await new Promise((r) => setTimeout(r, 150));
        }
        scrollTo({top: 0, behavior: 'instant'}); await new Promise((r) => setTimeout(r, 900));
    }""")
    # Checks that each one was revealed (is-visible), not how far its fade has got: headless WebKit
    # on CI can stall a transition part way.
    try:
        about.wait_for_function("[...document.querySelectorAll('[data-reveal]')].every((e) => e.classList.contains('is-visible'))", timeout=8000)
    except Exception:
        # Headless WebKit on CI can miss a section during the quick sweep: bring any it missed back
        # into view, more slowly. A section that never reveals still fails below.
        about.evaluate("""async () => {
            for (let round = 0; round < 3; round++) {
                const left = [...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-visible'));
                if (!left.length) break;
                for (const el of left) {
                    el.scrollIntoView({block: 'center', behavior: 'instant'});
                    await new Promise((r) => setTimeout(r, 600));
                }
            }
            scrollTo({top: 0, behavior: 'instant'}); await new Promise((r) => setTimeout(r, 300));
        }""")
    hidden = about.evaluate("""[...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-visible'))
        .map((e) => (e.closest('[id]') || {}).id + ' ' + e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' ' + Math.round(e.getBoundingClientRect().height) + 'px')""")
    check("Home page: every section is visible after scrolling", not hidden, f"{len(hidden)} still hidden: " + "; ".join(hidden))
    about.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_about.png"), full_page=True)
    # The project screenshot has a light and a dark version: exactly one shows in each theme.
    # Where the demo loop plays it covers them, so they're checked as the fallback (loop off).
    pair = """() => {
        const media = document.querySelector('.project-media'), had = media.classList.contains('has-loop');
        media.classList.remove('has-loop');
        const shown = Object.fromEntries(['light', 'dark'].map((t) => {
            const img = document.querySelector('.project-media img.only-' + t);
            return [t, getComputedStyle(img).display !== 'none'];
        }));
        if (had) media.classList.add('has-loop');
        return shown;
    }"""
    about.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    shown = about.evaluate(pair)
    check("Home page: light theme shows only the light screenshot", shown == {"light": True, "dark": False}, str(shown))
    about.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
    about.locator(".project").first.scroll_into_view_if_needed()
    if about.evaluate("document.querySelector('.project-media').classList.contains('has-loop')"):
        # The loop covers the screenshots (the lazy dark one never loads): it must switch to the dark video.
        about.evaluate("document.dispatchEvent(new CustomEvent('site:theme', {detail: 'dark'}))")
        about.wait_for_timeout(400)
        src = about.evaluate("document.querySelector('.demo-loop').currentSrc")
        check("Home page: dark theme plays the dark demo loop", "demo-loop-dark.webm" in src, src)
    else:
        try:
            about.wait_for_function("(() => { const i = document.querySelector('.project-media img.only-dark'); return i.complete && i.naturalWidth > 0; })()", timeout=10000)
        except Exception:
            pass
        shots = about.evaluate("""() => Object.fromEntries(['light', 'dark'].map((t) => {
            const img = document.querySelector('.project-media img.only-' + t);
            return [t, getComputedStyle(img).display !== 'none' && img.naturalWidth > 0];
        }))""")
        check("Home page: dark theme shows the dark screenshot", shots == {"light": False, "dark": True}, str(shots))
    cards = about.evaluate("[...document.querySelectorAll('#work .project-link')].map((a) => a.getAttribute('href'))")
    subs = about.evaluate("[...document.querySelectorAll('#work .project-sub')].map((a) => a.getAttribute('href'))")
    check("Home page: both cards link to their case studies", subs == ["ai-grid-trader-case-study", "pitwall-case-study"], str(subs))
    check("Home page: AI Grid Trader and Pitwall project cards",
          len(cards) == 2 and cards[0] == "ai-grid-trader" and cards[1] == "pitwall/", str(cards))
    posts = about.evaluate("""() => Promise.all([...document.querySelectorAll('#writing .post-row')]
        .map(async (a) => (await fetch(a.href)).status))""")
    check("Home page: two posts listed, both open", posts == [200, 200], str(posts))
    about.evaluate("document.documentElement.removeAttribute('data-theme')")
    about.click(".project-sub")                    # sits above the card's stretched link
    about.wait_for_load_state("networkidle")
    check("Home page: 'Read the case study' opens the case study", about.url.rstrip("/").endswith("ai-grid-trader-case-study"), about.url)
    about.close()

    cs = context.new_page()
    cs.on("pageerror", lambda e: errors.append(str(e)))
    cs.goto(URL + "ai-grid-trader-case-study", wait_until="networkidle")
    sections = cs.evaluate("[...document.querySelectorAll('main section[id]')].map((s) => s.id).join(',')")
    check("Case study: summary, problem, approach, results, engineering, next, guide", sections == "summary,problem,approach,results,engineering,next,guide,contact", sections)
    summary = cs.evaluate("""() => ({ rows: document.querySelectorAll('#summary .cs-tldr-rows > div').length,
        tags: document.querySelectorAll('#summary .cs-tags li').length,
        arch: document.querySelectorAll('#engineering .cs-arch-flow li').length,
        why: !!document.querySelector('#problem .cs-why'),
        og: document.querySelector('meta[property="og:image"]').content })""")
    check("Case study: 30-second summary, skills, architecture and 'Why I built this'",
          summary["rows"] == 4 and summary["tags"] >= 10 and summary["arch"] == 8 and summary["why"], str(summary))
    og = cs.evaluate("async (u) => (await fetch(u.replace('https://baizakisaev.com/', ''))).status", summary["og"])
    check("Case study: its own link-preview image", summary["og"].endswith("og-case-study.png") and og == 200, f"{summary['og']} {og}")
    bar = cs.evaluate("""async () => {
        const nav = document.querySelector('.cs-subnav'), atTop = nav.classList.contains('is-shown');
        document.documentElement.style.scrollBehavior = 'auto';
        document.getElementById('results').scrollIntoView({ block: 'start' });
        await new Promise((r) => setTimeout(r, 600));
        const cur = nav.querySelector('a[aria-current]');
        const res = { atTop, shown: nav.classList.contains('is-shown'), current: cur && cur.getAttribute('href'),
                      progress: nav.querySelector('.cs-progress span').style.transform };
        scrollTo(0, 0); document.documentElement.style.scrollBehavior = '';
        return res; }""")
    check("Case study: section bar shows after the hero, marks the section and fills its progress line",
          not bar["atTop"] and bar["shown"] and bar["current"] == "#results" and bar["progress"] not in ("", "scaleX(0)"), str(bar))
    if label.startswith("Chromium") and cs.viewport_size["width"] > 640:
        # The figure's chart replay: plays exactly over its still; its pause button stays on the page.
        cs.locator(".cs-figure-media[data-clip]").scroll_into_view_if_needed()
        try:
            cs.wait_for_function("document.querySelector('.cs-figure-media[data-clip]').classList.contains('is-playing')", timeout=8000)
        except Exception:
            pass
        clip = cs.evaluate("""() => { const b = document.querySelector('.cs-figure-media[data-clip]'), v = b.querySelector('video');
            const img = [...b.querySelectorAll('img')].find((i) => i.offsetParent), vr = v.getBoundingClientRect(), ir = img.getBoundingClientRect();
            return { playing: b.classList.contains('is-playing') && !v.paused, src: v.currentSrc.split('/').pop().split('?')[0],
                     fits: Math.abs(vr.left - ir.left - 24) < 2 && Math.abs(vr.width - (ir.width - 48)) < 2 && Math.abs(vr.top - ir.top - 20) < 2 }; }""")
        check("Case study: chart replay plays, exactly over its still",
              clip["playing"] and clip["fits"] and clip["src"].startswith("chart-replay"), str(clip))
        before = cs.url
        cs.click(".cs-figure-media .clip-toggle")
        cs.wait_for_timeout(300)
        check("Case study: pause button pauses the chart replay",
              cs.evaluate("document.querySelector('.cs-figure-media video').paused") and cs.url == before
              and cs.get_attribute(".cs-figure-media .clip-toggle", "aria-label") == "Play the animation")
        cs.evaluate("scrollTo(0, 0)")
    check("Case study: both results tables", cs.locator("table[aria-labelledby^='t-'] tbody tr").count() == 6)
    guide = cs.evaluate("""() => {
        const links = [...document.querySelectorAll('#guide .cs-toc a')].map((a) => a.getAttribute('href'));
        return { links: links.length, broken: links.filter((h) => !document.querySelector(h)),
                 features: document.querySelectorAll('#guide .cs-features > div').length,
                 keys: document.querySelectorAll('#guide .cs-table tbody tr').length,
                 hero: document.querySelector('.cs-hero a[href="#guide"]') !== null };
    }""")
    check("Case study: guide has contents, feature lists and shortcuts, all links work",
          guide["links"] == 12 and not guide["broken"] and guide["features"] >= 30 and guide["keys"] == 10 and guide["hero"], str(guide))
    cs.click('.cs-hero a[href="#guide"]')
    cs.wait_for_function("document.getElementById('guide-title').getBoundingClientRect().top < innerHeight / 2", timeout=5000)
    check("Case study: 'How to use the demo' jumps to the guide", cs.url.endswith("#guide"), cs.url)
    shown = cs.evaluate("[...document.querySelectorAll('.cs-figure img')].filter((i) => getComputedStyle(i).display !== 'none').length")
    check("Case study: one chart screenshot shown", shown == 1, f"{shown} shown")
    check("Case study: header name always shown", cs.evaluate("getComputedStyle(document.querySelector('.site-header .brand-link')).visibility") == "visible")
    check("Case study: email link filled in", (cs.get_attribute("#email-link", "href") or "").startswith("mailto:"))
    if label.startswith("Chromium"):
        cs.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js")
        audit = "async () => (await axe.run(document, {resultTypes: ['violations']})).violations.map(v => v.id + ' x' + v.nodes.length)"
        for theme in ("light", "dark"):
            cs.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
            cs.wait_for_timeout(400)
            found = cs.evaluate(audit)
            check(f"Case study: no accessibility violations ({theme} theme)", not found, ", ".join(found))
        cs.evaluate("document.documentElement.removeAttribute('data-theme')")
    # Same method as the posts below: bring each section into view, then check it was told to show
    # (is-visible), not how far its fade has got (headless WebKit on CI can stall a transition).
    cs.evaluate("""async () => {
        for (const el of document.querySelectorAll('[data-reveal]')) {
            el.scrollIntoView({block: 'center', behavior: 'instant'});
            await new Promise((r) => setTimeout(r, 150));
        }
        scrollTo({top: 0, behavior: 'instant'}); await new Promise((r) => setTimeout(r, 900));
    }""")
    try:
        cs.wait_for_function("[...document.querySelectorAll('[data-reveal]')].every((e) => e.classList.contains('is-visible'))", timeout=8000)
    except Exception:
        pass
    hidden = cs.evaluate("""[...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-visible'))
        .map((e) => e.className)""")
    check("Case study: every section is visible after scrolling", not hidden, "; ".join(hidden))
    cs.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_case_study.png"), full_page=True)

    # The Pitwall case study: the same design, its own sections, preview image and loop.
    cs.goto(URL + "pitwall-case-study", wait_until="networkidle")
    sections = cs.evaluate("[...document.querySelectorAll('main section[id]')].map((s) => s.id).join(',')")
    check("Pitwall case study: summary, problem, approach, findings, engineering, team, next",
          sections == "summary,problem,approach,findings,engineering,team,next,contact", sections)
    info = cs.evaluate("""() => ({ rows: document.querySelectorAll('#summary .cs-tldr-rows > div').length,
        tags: document.querySelectorAll('#summary .cs-tags li').length,
        arch: document.querySelectorAll('#engineering .cs-arch-flow li').length,
        tables: document.querySelectorAll('#findings .cs-table tbody tr').length,
        team: document.querySelectorAll('#team .cs-features > div').length,
        why: !!document.querySelector('#problem .cs-why'),
        og: document.querySelector('meta[property="og:image"]').content })""")
    og = cs.evaluate("async (u) => (await fetch(u.replace('https://baizakisaev.com/', ''))).status", info["og"])
    check("Pitwall case study: summary, 'Why I built this', skills, architecture, both tables, credits, its own preview image",
          info["rows"] == 4 and info["why"] and info["tags"] >= 10 and info["arch"] == 8 and info["tables"] == 10 and info["team"] == 3
          and info["og"].endswith("og-pitwall.png") and og == 200, f"{info} {og}")
    if label.startswith("Chromium") and cs.viewport_size["width"] > 640:
        cs.locator(".cs-figure-media[data-clip]").scroll_into_view_if_needed()
        try:
            cs.wait_for_function("document.querySelector('.cs-figure-media[data-clip]').classList.contains('is-playing')", timeout=8000)
        except Exception:
            pass
        clip = cs.evaluate("""() => { const b = document.querySelector('.cs-figure-media[data-clip]'), v = b.querySelector('video');
            const img = [...b.querySelectorAll('img')].find((i) => i.offsetParent), vr = v.getBoundingClientRect(), ir = img.getBoundingClientRect();
            return { playing: b.classList.contains('is-playing') && !v.paused, src: v.currentSrc.split('/').pop().split('?')[0],
                     fits: Math.abs(vr.left - ir.left) < 2 && Math.abs(vr.width - ir.width) < 2 && Math.abs(vr.top - ir.top) < 2
                           && Math.abs(vr.height - ir.height) < 3 }; }""")
        check("Pitwall case study: season loop plays, exactly over its still", clip["playing"] and clip["fits"] and clip["src"] in ("pitwall-loop.webm", "pitwall-loop-dark.webm"), str(clip))
        cs.evaluate("scrollTo(0, 0)")
    if label.startswith("Chromium"):
        for theme in ("light", "dark"):
            cs.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js")
            cs.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
            cs.wait_for_timeout(400)
            found = cs.evaluate(audit)
            check(f"Pitwall case study: no accessibility violations ({theme} theme)", not found, ", ".join(found))
        cs.evaluate("document.documentElement.removeAttribute('data-theme')")
    cs.evaluate("""async () => {
        for (const el of document.querySelectorAll('[data-reveal]')) {
            el.scrollIntoView({block: 'center', behavior: 'instant'});
            await new Promise((r) => setTimeout(r, 150));
        }
        scrollTo({top: 0, behavior: 'instant'}); await new Promise((r) => setTimeout(r, 900));
    }""")
    try:
        cs.wait_for_function("[...document.querySelectorAll('[data-reveal]')].every((e) => e.classList.contains('is-visible'))", timeout=8000)
    except Exception:
        pass
    hidden = cs.evaluate("[...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-visible')).map((e) => e.className)")
    check("Pitwall case study: every section is visible after scrolling", not hidden, "; ".join(hidden))
    cs.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_pitwall_case_study.png"), full_page=True)
    for slug, tables in (("battery-wear-cost", 2), ("perfect-hindsight-benchmark", 2)):
        cs.goto(URL + slug, wait_until="networkidle")
        check(f"Post {slug}: title, {tables} tables, header name, email link",
              cs.locator("h1#post-title").count() == 1 and cs.locator(".cs-table").count() == tables
              and cs.evaluate("getComputedStyle(document.querySelector('.site-header .brand-link')).visibility") == "visible"
              and (cs.get_attribute("#email-link", "href") or "").startswith("mailto:"))
        if label.startswith("Chromium"):
            cs.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js")
            for theme in ("light", "dark"):
                cs.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
                cs.wait_for_timeout(400)
                found = cs.evaluate(audit)
                check(f"Post {slug}: no accessibility violations ({theme} theme)", not found, ", ".join(found))
            cs.evaluate("document.documentElement.removeAttribute('data-theme')")
        # Bring each fading section into view in turn (timed scroll steps were too fast for CI's iPad run).
        cs.evaluate("""async () => {
            for (const el of document.querySelectorAll('[data-reveal]')) {
                el.scrollIntoView({block: 'center', behavior: 'instant'});
                await new Promise((r) => setTimeout(r, 150));
            }
        }""")
        try:
            cs.wait_for_function("[...document.querySelectorAll('[data-reveal]')].every((e) => e.classList.contains('is-visible'))", timeout=8000)
        except Exception:
            pass
        # Checks that each section was told to show (is-visible), not how far its CSS fade has got:
        # headless WebKit on CI sometimes stalls a transition part-way when nothing else repaints.
        hidden = cs.evaluate("""[...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-visible'))
            .map((e) => `${e.className} (top ${Math.round(e.getBoundingClientRect().top)} of ${innerHeight})`)""")
        check(f"Post {slug}: every section revealed after scrolling", not hidden, "; ".join(hidden))
        cs.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_{slug}.png"), full_page=True)
    if label.startswith("Chromium"):
        for page_url in ("", "ai-grid-trader-case-study", "pitwall-case-study", "battery-wear-cost", "perfect-hindsight-benchmark"):
            cs.set_viewport_size({"width": 360, "height": 760})
            cs.goto(URL + page_url, wait_until="networkidle")
            wide = cs.evaluate("document.documentElement.scrollWidth - innerWidth")
            check(f"phone width: no sideways scroll ({page_url or 'home'})", wide <= 0, f"{wide}px too wide")
            if page_url == "":
                cs.evaluate("document.querySelector('#work').scrollIntoView({behavior: 'instant'})")
                shown = "[...document.querySelectorAll('#work .project-media img')].filter((i) => getComputedStyle(i).display !== 'none')"
                try:
                    cs.wait_for_function(f"{shown}.every((i) => i.complete && i.naturalWidth > 0)", timeout=10000)
                except Exception:
                    pass
                files = cs.evaluate(f"{shown}.map((i) => i.currentSrc.split('/').pop().split('?')[0])")
                check("phone width: project cards use the phone crops",
                      len(files) == 2 and all("-phone" in f for f in files), str(files))
                check("phone width: no demo loops (the phone crops read better)",
                      not cs.evaluate("[...document.querySelectorAll('.project-media')].some((m) => m.classList.contains('has-loop'))")
                      and cs.evaluate("[...document.querySelectorAll('.demo-loop')].every((v) => v.networkState !== 2)"))
        cs.screenshot(path=str(SHOTS / "Chromium_phone_case_study.png"), full_page=True)
    cs.close()

    page.click("#btn-play")
    page.wait_for_timeout(3500)
    labels = page.locator("#kpis .label").all_inner_texts()
    check("auto-play running with live numbers", page.evaluate("document.body.classList.contains('kiosk')") and "so far" in labels[0], labels[0])
    fit = page.evaluate("""() => { const c = document.getElementById('chart-main').getBoundingClientRect();
        const s = document.querySelector('#chart-main .main-svg').getBoundingClientRect();
        return { chartBottom: Math.round(c.bottom), vh: innerHeight, svg: Math.round(s.height), box: Math.round(c.height) }; }""")
    check("auto-play chart sized to its box", abs(fit["svg"] - fit["box"]) <= 2, str(fit))
    page.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}_kiosk.png"))
    page.evaluate("window.scrollBy(0, 300)")          # works on desktop and touch devices
    page.wait_for_timeout(200)
    check("scrolling keeps auto-play running", page.evaluate("document.body.classList.contains('kiosk')"))
    page.locator("#chart-main").click()
    page.wait_for_timeout(300)
    check("tap/click exits auto-play", not page.evaluate("document.body.classList.contains('kiosk')"))

    # Cards below the chart fade in as they scroll into view: bring each one in, then check.
    page.evaluate("""async () => {
        for (const el of document.querySelectorAll('[data-reveal]')) {
            el.scrollIntoView({block: 'center', behavior: 'instant'});
            await new Promise((r) => setTimeout(r, 150));
        }
        scrollTo({top: 0, behavior: 'instant'});
    }""")
    unrevealed = page.evaluate("""[...document.querySelectorAll('[data-reveal]')]
        .filter((e) => e.offsetParent && !e.classList.contains('is-visible')).map((e) => e.className)""")
    check("demo: every card revealed after scrolling", not unrevealed, "; ".join(unrevealed))
    page.wait_for_timeout(900)
    page.screenshot(path=str(SHOTS / f"{label.replace(' ', '_')}.png"), full_page=True)
    if label.startswith("Chromium"):
        # Phone width: header buttons collapse to icons, but "New day" keeps its label.
        page.set_viewport_size({"width": 390, "height": 800})
        page.wait_for_timeout(300)
        check("phone width: header labels hidden, 'New day' label kept",
              not page.is_visible("#btn-share .lbl") and page.is_visible("#btn-shuffle .lbl"))
        wide = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        check("phone width: demo has no sideways scroll and keeps the case-study link",
              wide <= 0 and page.is_visible(".demo-header .nav-case"), f"{wide}px too wide")
        page.screenshot(path=str(SHOTS / "Chromium_phone.png"))
        page_transitions_with_slow_css(browser, ctx, errors)
    check("no JavaScript errors", not errors, "; ".join(errors[:3]))
    browser.close()


def page_transitions_with_slow_css(browser, ctx, errors):
    """Chromium decides whether a page takes part in the cross-fade before a slow stylesheet has
    applied. With the opt-in only in home.css it cancelled the fade and threw an InvalidStateError
    ("ViewTransition opt-in disabled") whenever the stylesheets came late, so the full suite failed
    now and then. Each page opts in inline in its <head>; here every stylesheet is slowed down so a
    page that lost that inline rule fails every time, not only on a busy machine."""
    context = browser.new_context(service_workers="block", **ctx)
    context.route(re.compile(r"\.css(\?|$)"), lambda route: (time.sleep(0.4), route.continue_()))
    context.add_init_script("addEventListener('pagereveal', (e) => {"
                            " (window.__reveals = window.__reveals || []).push(!!e.viewTransition); });")
    tab = context.new_page()
    tab.on("pageerror", lambda e: errors.append(str(e)))
    tab.goto(URL, wait_until="networkidle")
    tab.click("#writing .post-row")
    tab.wait_for_load_state("networkidle")
    to_post = tab.evaluate("window.__reveals")
    tab.go_back(wait_until="networkidle")
    back_home = tab.evaluate("window.__reveals")
    check("page transitions run with slow stylesheets (home page -> post -> back)",
          to_post[-1:] == [True] and back_home[-1:] == [True], f"{to_post} / {back_home}")  # last: the page just shown
    context.close()


def offline(pw):
    print("\n== Chromium offline (service worker)")
    browser = pw.chromium.launch()
    context = browser.new_context()
    page = context.new_page()
    page.goto(URL, wait_until="networkidle")
    page.evaluate("navigator.serviceWorker.ready")
    page.wait_for_timeout(1500)
    page.reload(wait_until="networkidle")          # now controlled by the service worker
    context.set_offline(True)
    page.goto(URL, wait_until="load")
    check("home page opens with no network", page.locator(".hero").count() == 1)
    page.goto(URL + "ai-grid-trader-case-study", wait_until="load")
    check("case study opens with no network", page.locator("#results").count() == 1)
    page.goto(URL + "pitwall-case-study", wait_until="load")
    check("Pitwall case study opens with no network", page.locator("#findings").count() == 1)
    page.goto(URL + "battery-wear-cost", wait_until="load")
    check("posts open with no network", page.locator("#post-title").count() == 1)
    page.goto(URL + "ai-grid-trader?kiosk=1", wait_until="load")
    page.wait_for_timeout(1500)
    kpis = page.locator("#kpis .value").all_inner_texts()
    check("opens with no network after first visit", len(kpis) == 5 and all(kpis), " | ".join(kpis))
    browser.close()


with sync_playwright() as pw:
    only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
    want = lambda name: only is None or name in only
    if want("chromium"): run(pw, "Chromium desktop", pw.chromium, viewport={"width": 1366, "height": 768})
    if want("firefox"): run(pw, "Firefox desktop", pw.firefox, viewport={"width": 1366, "height": 768})
    if want("webkit"): run(pw, "WebKit desktop", pw.webkit, viewport={"width": 1366, "height": 768})
    if want("ipad"): run(pw, "WebKit iPad", pw.webkit, **pw.devices["iPad Pro 11 landscape"])
    if want("offline"): offline(pw)

print(f"\nScreenshots: {SHOTS}")
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
