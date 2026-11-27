/*
 * Offline support for baizakisaev.com (home page, the AI Grid Trader demo, the case studies and posts).
 * After the first visit every file is cached, so the site opens with no internet connection
 * (handy at venues with bad Wi-Fi). Files are served from the cache instantly and refreshed in
 * the background.
 *
 * Versioning: the Dockerfile replaces __BUILD__ with a new stamp on every deploy. That renames this
 * cache and changes the address of every stamped file (style.css?v=…), so a new release is never
 * mixed with old copies held by the browser or by a CDN such as Cloudflare. The pages reload once
 * when a new release takes over (site.js; a worker-side client.navigate() crashed Chromium).
 */
const BUILD = "__BUILD__";
const CACHE = `agt-${BUILD}`;
const V = `?v=${BUILD}`;
const ASSETS = [
  "./",                                   // home page (about me)
  "ai-grid-trader",                       // the demo (clean URL for ai-grid-trader.html)
  "ai-grid-trader-case-study",            // the write-ups
  "pitwall-case-study",
  "battery-wear-cost",                    // posts
  "perfect-hindsight-benchmark",
  "manifest.webmanifest",
  "assets/style.css" + V,
  "assets/site.js" + V,
  "assets/home.css" + V,
  "assets/home.js" + V,
  "assets/fonts/inter-latin-var.woff2",
  "assets/fonts/jetbrains-mono-latin-500.woff2",
  "assets/engine.js" + V,
  "assets/app.js" + V,
  "assets/data/markets.js" + V,
  "assets/data/services.js" + V,
  "assets/data/prices-caiso.js" + V,
  "assets/data/prices-de.js" + V,
  "assets/data/prices-sa.js" + V,
  "assets/img/profile.jpg" + V,
  "assets/img/profile-64.jpg" + V,
  "assets/img/demo-loop.jpg" + V,
  "assets/img/demo-loop-dark.jpg" + V,
  "assets/img/chart-replay.jpg" + V,
  "assets/img/chart-replay-dark.jpg" + V,
  "assets/img/project-chart-phone.webp" + V,
  "assets/img/project-chart-phone-dark.webp" + V,
  "assets/img/f1-dashboard.webp" + V,
  "assets/img/pitwall-tour.jpg" + V,
  "assets/img/pitwall-tour-dark.jpg" + V,
  "assets/img/f1-dashboard-phone.webp" + V,
  "assets/Baizak-Isaev-Resume.pdf" + V,
  "assets/vendor/plotly-basic-2.35.2.min.js",
  "assets/img/qr-linkedin.svg",
  "assets/img/qr-case-study.svg",           // presenter mode's closing screen
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
];

// Always ask the server, never a stored HTTP copy (browsers and CDNs may hold old ones).
const fresh = (req) => fetch(new Request(req, { cache: "no-cache" }));

self.addEventListener("install", (event) => {
  // Cache files one by one so a single missing file can't block installation.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((url) =>
        fresh(new Request(url)).then((res) => (res.ok ? cache.put(url, res) : null)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Videos stream with range requests straight from the network (Safari needs the ranges).
  if (/\.webm$/.test(new URL(req.url).pathname)) return;
  // Pages are cached by page, ignoring ?kiosk=1 / #… and the .html / index.html spelling:
  // "/", "/index.html" -> "/"; "/ai-grid-trader", "/ai-grid-trader.html" -> "/ai-grid-trader".
  // Other files are cached by their exact address, including the ?v= build stamp.
  let key = req;
  if (req.mode === "navigate") {
    const path = new URL(req.url).pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
    key = new Request(new URL(path, self.location.origin));
  }
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(req.mode === "navigate" ? req : new Request(req, { cache: "no-cache" }))
        .then((res) => {
          if (res && res.ok && res.type === "basic") cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached || Response.error());
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    })
  );
});
