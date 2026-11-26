/*
 * Home page motion & micro-interactions. ~2 KB, no dependencies.
 * Loaded by index.html after site.js.
 *
 * Principles: IntersectionObserver instead of scroll listeners; rAF-batched writes;
 * only transform/opacity animate; everything degrades to a static, fully visible page.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const hasIO = "IntersectionObserver" in window;

  // ------------------------------------------------------------------ 1. Scroll reveal
  // CSS hides [data-reveal] only under .reveal-on, which is set here — so if this file
  // never loads, nothing is hidden. Children of [data-stagger] get --i for a cascade.
  document.querySelectorAll("[data-stagger]").forEach((group) => {
    [...group.children].forEach((child, i) => {
      child.setAttribute("data-reveal", "");
      child.style.setProperty("--i", i);
    });
  });

  const revealEls = document.querySelectorAll("[data-reveal]");
  if (hasIO && revealEls.length) {
    root.classList.add("reveal-on");
    const revealIO = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        revealIO.unobserve(entry.target);          // reveal once; no work after that
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0 });
    revealEls.forEach((el) => revealIO.observe(el));
  }

  // ------------------------------------------------------------------ 2. Header state
  // A 1px sentinel at the top of the page: when it leaves the viewport, frost the header.
  const header = document.querySelector(".site-header");
  if (header && hasIO) {
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none";
    document.body.prepend(sentinel);
    new IntersectionObserver(([entry]) => {
      header.classList.toggle("is-scrolled", !entry.isIntersecting);
    }).observe(sentinel);
  }

  // Name handoff: show the header's name only once the hero's name row has scrolled under the
  // header (the top margin is the header's height), and hide it again on the way back up.
  const heroId = document.querySelector(".hero-id");
  if (header && heroId && hasIO) {
    new IntersectionObserver(([entry]) => {
      header.classList.toggle("show-brand", !entry.isIntersecting);
    }, { rootMargin: `-${header.offsetHeight}px 0px 0px 0px` }).observe(heroId);
  } else if (header) {
    header.classList.add("show-brand");
  }

  // ------------------------------------------------------------------ 3. Scroll-spy
  // Marks the nav link of the section crossing the middle of the viewport.
  const navLinks = [...document.querySelectorAll('.nav-link[href^="#"]')];
  if (navLinks.length && hasIO) {
    const byId = new Map(navLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const spyIO = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        navLinks.forEach((a) => a.removeAttribute("aria-current"));
        const link = byId.get(entry.target.id);
        if (link) link.setAttribute("aria-current", "true");
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main > section[id]").forEach((s) => spyIO.observe(s));
  }

  // ------------------------------------------------------------------ 4. Count-up metrics
  // Markup already holds the final value (no-JS + screen readers get it; the animated
  // copy is aria-hidden). Width is locked first so neighbours never shift.
  const counters = document.querySelectorAll("[data-count]");
  if (counters.length && hasIO && !reduceMotion.matches) {
    const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
    const run = (el) => {
      const target = parseFloat(el.dataset.count);
      const decimals = parseInt(el.dataset.decimals || "0", 10);
      const prefix = el.dataset.prefix || "";
      const suffix = el.dataset.suffix || "";
      const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      const duration = 1400;
      el.style.minWidth = el.getBoundingClientRect().width + "px";
      let start = 0;
      const tick = (now) => {
        if (!start) start = now;
        const t = Math.min((now - start) / duration, 1);
        el.textContent = prefix + fmt.format(target * easeOutExpo(t)) + suffix;
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const countIO = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        countIO.unobserve(entry.target);
        run(entry.target);
      }
    }, { threshold: 0.6 });
    counters.forEach((el) => countIO.observe(el));
  }

  // ------------------------------------------------------------------ 5. Card spotlight
  // Mouse/trackpad only. One rAF write per frame; the CSS moves a pseudo-element with
  // transform, so the browser composites instead of repainting the card.
  if (finePointer.matches && !reduceMotion.matches) {
    document.querySelectorAll("[data-spotlight]").forEach((card) => {
      let rect = null, frame = 0, x = 0, y = 0;
      card.addEventListener("pointerenter", () => { rect = card.getBoundingClientRect(); }, { passive: true });
      card.addEventListener("pointermove", (e) => {
        if (!rect) rect = card.getBoundingClientRect();
        x = e.clientX - rect.left;
        y = e.clientY - rect.top;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          card.style.setProperty("--mx", x + "px");
          card.style.setProperty("--my", y + "px");
          frame = 0;
        });
      }, { passive: true });
      card.addEventListener("pointerleave", () => { rect = null; }, { passive: true });
    });
  }

  // ------------------------------------------------------------------ 5b. Demo loops on the project cards
  // A silent loop (AI Grid Trader's presenter mode, Pitwall's seasons) replaces the screenshots on
  // wider screens. It loads nothing until the card is near the screen, plays only while visible,
  // follows the theme (Pitwall is dark-only: one video for both), and has a pause button. The screenshots stay until the video is really playing, so phones (the phone
  // crop reads better), reduced motion and browsers that can't play WebM/VP9 keep them.
  document.querySelectorAll(".demo-loop").forEach((loop) => {
    if (!hasIO) return;
    const media = loop.closest(".project-media");
    const toggle = media.querySelector(".loop-toggle");
    const toggleLabel = toggle.querySelector(".sr-only");
    const wide = matchMedia("(min-width: 641px)");
    const canPlay = !!loop.canPlayType && loop.canPlayType('video/webm; codecs="vp9"') !== "";
    let visible = false, userPaused = false, theme = "", playing = false;
    loop.addEventListener("timeupdate", () => { if (!playing && loop.currentTime > 0) { playing = true; sync(); } });

    const sync = () => {
      const on = canPlay && wide.matches && !reduceMotion.matches;
      media.classList.toggle("has-loop", on && playing);
      toggle.hidden = !(on && playing);
      if (!on) { loop.pause(); return; }
      const want = (window.Site && window.Site.theme()) === "dark" ? "dark" : "light";
      if (want !== theme) {
        const at = loop.currentTime || 0;
        theme = want;
        loop.poster = loop.dataset[want + "Poster"];
        if (loop.getAttribute("src") !== loop.dataset[want]) {
          loop.src = loop.dataset[want];
          if (at) loop.addEventListener("loadedmetadata", () => { loop.currentTime = at; }, { once: true });
        }
      }
      if (visible && !userPaused) loop.play().catch(() => {});
      else loop.pause();
    };
    toggle.addEventListener("click", () => {
      userPaused = !userPaused;
      toggle.setAttribute("aria-pressed", String(userPaused));
      toggleLabel.textContent = userPaused ? "Play the demo video" : "Pause the demo video";
      sync();
    });
    // Starts a little before the card scrolls into view, so it is already moving when it arrives.
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) loop.preload = "auto";
      sync();
    }, { rootMargin: "250px 0px" }).observe(media);
    wide.addEventListener("change", sync);
    reduceMotion.addEventListener("change", sync);
    document.addEventListener("site:theme", sync);
    sync();
  });


  // ------------------------------------------------------------------ 5c. Case study section bar
  // Shows once the hero has scrolled under the header, marks the section being read, and fills a
  // reading-progress line (one rAF write per frame, transform only).
  const subnav = document.querySelector(".cs-subnav");
  const csHero = document.querySelector(".cs-hero");
  if (subnav && csHero && hasIO) {
    new IntersectionObserver(([entry]) => {
      subnav.classList.toggle("is-shown", !entry.isIntersecting && entry.boundingClientRect.top < 0);
    }, { rootMargin: `-${header ? header.offsetHeight : 0}px 0px 0px 0px` }).observe(csHero);

    const links = [...subnav.querySelectorAll('a[href^="#"]')];
    const byId = new Map(links.map((a) => [a.hash.slice(1), a]));
    const mark = (id) => {
      links.forEach((a) => a.removeAttribute("aria-current"));
      const a = byId.get(id);
      if (!a) return;
      a.setAttribute("aria-current", "true");
      // Keep the current link in view when the bar scrolls sideways (phones), without moving the page.
      const bar = a.closest("ol");
      if (bar.scrollWidth > bar.clientWidth) {
        bar.scrollTo({ left: a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2, behavior: reduceMotion.matches ? "auto" : "smooth" });
      }
    };
    const spy = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) mark(entry.target.id);
    }, { rootMargin: "-40% 0px -55% 0px" });
    document.querySelectorAll("main section[id]").forEach((s) => spy.observe(s));

    const bar = subnav.querySelector(".cs-progress span");
    const article = document.querySelector("main article") || document.querySelector("main");
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = article.getBoundingClientRect().top + scrollY;
      const span = Math.max(1, article.offsetHeight - innerHeight);
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, (scrollY - top) / span))})`;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll, { passive: true });
    update();
  }

  // ------------------------------------------------------------------ 5d. Case study chart replay
  // Wide screens only: the clip loads when its card nears the screen, plays while it is on screen and
  // follows the theme. With reduced motion it waits for the play button. The still stays underneath,
  // so nothing changes size, and a browser that can't play the clip just keeps showing the still.
  const wide = matchMedia("(min-width: 641px)");
  document.querySelectorAll("[data-clip]").forEach((box) => {
    const video = box.querySelector("video");
    const btn = box.querySelector(".clip-toggle");
    if (!video || !btn || !hasIO || !video.canPlayType || !video.canPlayType('video/webm; codecs="vp9"')) return;
    let paused = reduceMotion.matches;
    let near = false;
    const src = () => video.dataset[window.Site && window.Site.theme() === "dark" ? "srcDark" : "srcLight"];
    const label = () => {
      const text = paused ? "Play the animation" : "Pause the animation";
      btn.setAttribute("aria-label", text);
      btn.title = text;
      btn.classList.toggle("is-paused", paused);
    };
    const sync = () => {
      btn.hidden = !wide.matches;
      if (near && wide.matches && !paused) {
        if (video.getAttribute("src") !== src()) { box.classList.remove("is-playing"); video.src = src(); }
        const p = video.play();
        if (p) p.catch(() => {});        // autoplay refused: the still stays
      } else if (!video.paused) {
        video.pause();
      }
    };
    // Shown once frames are actually moving ("playing" alone isn't reliable in every WebKit build).
    const shown = () => { if (!video.paused && video.currentTime > 0) box.classList.add("is-playing"); };
    video.addEventListener("playing", shown);
    video.addEventListener("timeupdate", shown);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();               // the card behind is a link
      paused = !paused;
      label();
      sync();
    });
    new IntersectionObserver(([entry]) => { near = entry.isIntersecting; sync(); }, { rootMargin: "200px 0px" }).observe(box);
    wide.addEventListener("change", sync);
    document.addEventListener("site:theme", sync);
    label();
  });

  // ------------------------------------------------------------------ 6. Copy email + toast
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");          // announced politely by screen readers
    document.body.append(toast);
  }
  let toastTimer = 0;
  const showToast = (msg) => {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  };

  document.querySelectorAll("[data-copy-email]").forEach((btn) => {
    const label = btn.querySelector("span");
    btn.addEventListener("click", async () => {
      // site.js assembles the address at runtime (kept out of the HTML for scrapers).
      const email = window.Site && window.Site.email;
      if (!email) return;
      try {
        await navigator.clipboard.writeText(email);
        btn.setAttribute("data-copied", "");
        if (label) label.textContent = "Copied";
        showToast("Email address copied");
        setTimeout(() => { btn.removeAttribute("data-copied"); if (label) label.textContent = "Copy"; }, 2000);
      } catch (e) {
        location.href = "mailto:" + email;           // clipboard blocked: fall back to mail app
      }
    });
  });
})();
