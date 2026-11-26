/*
 * Shared by every page: the light/dark switch, the contact email and offline support.
 *
 * Exposes window.Site so the demo (app.js) can redraw its charts when the theme changes and
 * postpone an update reload while someone is presenting.
 */
(function () {
  "use strict";

  const SUN = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  // ---------------------------------------------------------------------------- light / dark
  // The theme follows the system unless the visitor picks one; the choice is remembered in this
  // browser (an inline script in each page's <head> applies it before first paint).
  const root = document.documentElement;
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const theme = () => root.getAttribute("data-theme") || (systemDark.matches ? "dark" : "light");
  const button = document.getElementById("btn-theme");

  function paintButton() {
    if (!button) return;
    const dark = theme() === "dark";
    button.innerHTML = dark ? SUN : MOON;
    button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
  // Pages that draw their own colours (the demo's charts) listen for this event.
  const announce = () => document.dispatchEvent(new CustomEvent("site:theme", { detail: theme() }));

  function toggleTheme() {
    const next = theme() === "dark" ? "light" : "dark";
    const apply = () => {
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("agt-theme", next); } catch (e) { /* storage unavailable: still switches */ }
      paintButton();
      announce();
    };
    // Home page: cross-fade the switch (View Transitions; timing in home.css). Not on the demo,
    // whose charts redraw after the switch and would be caught mid-way.
    const fade = document.startViewTransition && document.body.classList.contains("about-page") &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (fade) document.startViewTransition(apply); else apply();
  }

  if (button) button.addEventListener("click", toggleTheme);
  systemDark.addEventListener("change", () => { paintButton(); announce(); });
  paintButton();

  // ---------------------------------------------------------------------------- contact email
  // The address is assembled at runtime to keep it away from simple scrapers.
  const email = ["baizak", "baizakisaev.com"].join("@");
  const emailButton = document.getElementById("email-link");
  const emailText = document.getElementById("email-text");
  const mailto = `mailto:${email}?subject=${encodeURIComponent("Hello from your website")}`;
  if (emailButton) { emailButton.href = mailto; emailButton.title = email; }
  if (emailText) { emailText.href = mailto; emailText.textContent = email; }

  // A bare mailto: link does nothing for people with no desktop mail app (most Gmail and
  // Outlook web users), so "Email me" opens a short menu: Gmail, Outlook, mail app, copy.
  const triggers = [emailButton, emailText].filter(Boolean);
  if (triggers.length) {
    let anchor = triggers[0];
    const subject = encodeURIComponent("Hello from your website");
    const to = encodeURIComponent(email);
    const menu = document.createElement("div");
    menu.className = "mail-menu";
    menu.id = "mail-menu";
    menu.hidden = true;
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Ways to email " + email);
    const item = (label, href) =>
      `<a class="mail-menu-item" href="${href}"${href.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
    menu.innerHTML =
      `<p class="mail-menu-to">${email}</p>` +
      item("Open in Gmail", `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}`) +
      item("Open in Outlook", `https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${subject}`) +
      item("Use my mail app", mailto) +
      `<button class="mail-menu-item" type="button" data-mail-copy>Copy address</button>`;
    document.body.append(menu);
    triggers.forEach((t) => { t.setAttribute("aria-expanded", "false"); t.setAttribute("aria-controls", menu.id); });

    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;
      const below = innerHeight - r.bottom >= h + 16 || r.top < h + 16;
      const left = Math.min(Math.max(16, r.left), innerWidth - w - 16);
      menu.style.left = `${left + scrollX}px`;
      menu.style.top = `${(below ? r.bottom + 8 : r.top - h - 8) + scrollY}px`;
    };
    const close = (refocus) => {
      if (menu.hidden) return;
      menu.hidden = true;
      anchor.setAttribute("aria-expanded", "false");
      if (refocus) anchor.focus();
    };
    const open = () => {
      menu.hidden = false;
      anchor.setAttribute("aria-expanded", "true");
      place();
      menu.querySelector(".mail-menu-item").focus({ preventScroll: true });
    };
    triggers.forEach((t) => t.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;        // modified clicks keep the plain link
      e.preventDefault();
      if (!menu.hidden && anchor === t) { close(true); return; }
      close(false);
      anchor = t;
      open();
    }));
    menu.addEventListener("click", async (e) => {
      const target = e.target.closest(".mail-menu-item");
      if (!target) return;
      if (!target.hasAttribute("data-mail-copy")) { setTimeout(() => close(false), 0); return; }
      try {
        await navigator.clipboard.writeText(email);
        target.textContent = "Copied";
        setTimeout(() => { target.textContent = "Copy address"; close(true); }, 1200);
      } catch (err) {
        const range = document.createRange();                  // clipboard blocked: select it instead
        range.selectNodeContents(menu.querySelector(".mail-menu-to"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(true); });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.contains(e.target) && !triggers.some((t) => t.contains(e.target))) close(false);
    });
    menu.addEventListener("focusout", (e) => {
      if (e.relatedTarget && !menu.contains(e.relatedTarget) && !triggers.includes(e.relatedTarget)) close(false);
    });
    addEventListener("resize", () => { if (!menu.hidden) place(); });
  }

  const Site = { theme, toggleTheme, email, canReload: () => true };
  window.Site = Site;

  // ---------------------------------------------------------------------------- offline support
  // The service worker caches the site after the first visit (only over http/https, not file://).
  // When a new release takes over from an older one, reload once so the page and its files match.
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    const updating = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updating && !reloaded && Site.canReload()) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
