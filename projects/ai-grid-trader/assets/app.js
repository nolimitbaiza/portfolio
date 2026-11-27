/*
 * AI Grid Trader: the page (controls, charts, presenting tools).
 *
 * The model itself (markets, the RL agent, forecasts, benchmarks, accounting, the full-year
 * simulation and CSV parsing) lives in assets/engine.js as window.GridEngine, so it can also run
 * in a background worker and in the automated tests.
 *
 * Runs entirely in the visitor's browser (no server): host it anywhere, embed it, or open it from disk.
 * Needs site.js (theme switch, offline support) to be loaded first.
 */
(function () {
  "use strict";

  const E = window.GridEngine;
  const { N, DT, IDLE, CHARGE, DISCHARGE, DAY_MS, STEP_MS, STEPS_PER_DAY } = E;

  // Simulated scenarios (48 hours each).
  const SIM = {
    typical:  { label: "Typical day",   seed: 42, volatility: 5,  morning: 38, evening: 75,  solar: 34, spikes: [1, 3], spikeSize: [25, 80] },
    volatile: { label: "Volatile",      seed: 7,  volatility: 11, morning: 38, evening: 75,  solar: 34, spikes: [3, 5], spikeSize: [40, 120] },
    solar:    { label: "Solar surplus", seed: 21, volatility: 5,  morning: 30, evening: 70,  solar: 72, spikes: [0, 1], spikeSize: [20, 50] },
    heatwave: { label: "Heatwave",      seed: 99, volatility: 7,  morning: 50, evening: 140, solar: 25, spikes: [2, 4], spikeSize: [50, 120] },
  };
  // Real markets: a full calendar year of 15-minute prices each (see tools/build_markets.py).
  const REAL = window.GRID_MARKETS || {};
  // Build stamp: the site's build replaces __BUILD__ on every deploy, so file addresses change with
  // each release and no browser or CDN cache can serve an old copy next to a new page.
  const BUILD = "__BUILD__";
  let uploaded = null;                    // a market built from the visitor's CSV

  // Chart colours, mirrored from style.css (charts are drawn in JS, and the PDF always uses light).
  const PALETTES = {
    light: { ink: "#0c0a09", muted: "#6f6863", line: "#e7e5e4", surface: "#ffffff", price: "#d97706", forecast: "#a8a29e",
             soc: "#3b82f6", socFill: "rgba(59,130,246,0.12)", charge: "#16a34a", discharge: "#dc2626", bot: "#a8a29e" },
    dark:  { ink: "#f5f5f4", muted: "#a1a1aa", line: "#27272a", surface: "#151517", price: "#fbbf24", forecast: "#71717a",
             soc: "#60a5fa", socFill: "rgba(96,165,250,0.14)", charge: "#22c55e", discharge: "#f87171", bot: "#71717a" },
  };

  // Currency of the market on screen (real markets trade in their own currency).
  let CUR = "$";
  const fmtNum = (v) => Math.round(Math.abs(v)).toLocaleString("en-US");
  const money = (v) => (v < 0 ? "−" : "") + CUR + fmtNum(v);
  const signedMoney = (v) => (v >= 0 ? "+" : "−") + CUR + fmtNum(v);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  // Slider definitions. `main` sliders are always visible; the rest sit under "More settings".
  const CONTROLS = [
    { key: "cap",   label: "Battery size",          min: 10,  max: 500,   step: 10,  fmt: (v) => `${v} MWh`, main: true },
    { key: "pw",    label: "Power rating",          min: 5,   max: 200,   step: 5,   fmt: (v) => `${v} MW`, main: true },
    { key: "wear",  label: "Wear cost per cycle",   min: 0,   max: 20000, step: 50,  fmt: (v) => money(v), main: true },
    { key: "fe",    label: "Forecast error",        min: 0,   max: 40,    step: 5,   fmt: (v) => (v === 0 ? "none" : `±${v}%`), main: true },
    { key: "vol",   label: "Price volatility",      min: 0,   max: 15,    step: 0.5, fmt: (v) => `±${CUR}${v}/MWh`, simOnly: true },
    { key: "eff",   label: "Round-trip efficiency", min: 70,  max: 98,    step: 1,   fmt: (v) => `${v}%` },
    { key: "frag",  label: "Micro-cycling penalty", min: 0,   max: 2000,  step: 50,  fmt: (v) => `${money(v)} / run` },
    { key: "capex", label: "Installed cost",        min: 50,  max: 600,   step: 5,   fmt: (v) => `${CUR}${v}/kWh` },
    { key: "itc",   label: "Tax credit on installed cost", min: 0, max: 50, step: 5,  fmt: (v) => (v ? `${v}%` : "none") },
    { key: "lo",    label: "Lowest charge level",   min: 0,   max: 45,    step: 5,   fmt: (v) => `${v}%` },
    { key: "hi",    label: "Highest charge level",  min: 55,  max: 100,   step: 5,   fmt: (v) => `${v}%` },
    // Revenue streams
    { key: "res",   label: "Power reserved for grid services", min: 0, max: 50, step: 5, fmt: (v) => (v ? `${v}%` : "none"), group: "stack" },
    { key: "svc",   label: "Grid services price",   min: 0,   max: 40,    step: 0.1,  fmt: (v) => `${CUR}${v} per MW per hour`, group: "stack" },
    { key: "capp",  label: "Capacity payment",      min: 0,   max: 200,   step: 5,   fmt: (v) => (v ? `${CUR}${v} per kW per year` : "none"), group: "stack" },
    { key: "solar", label: "Co-located solar",      min: 0,   max: 500,   step: 10,  fmt: (v) => (v ? `${v} MW of panels` : "none"), group: "stack" },
    // Battery lifetime
    { key: "life",  label: "Project life",          min: 10,  max: 20,    step: 1,   fmt: (v) => `${v} years`, group: "life" },
    { key: "disc",  label: "Discount rate",         min: 0,   max: 15,    step: 0.5, fmt: (v) => `${v}%`, group: "life" },
    { key: "clife", label: "Cycle life (to 80% health)", min: 2000, max: 12000, step: 500, fmt: (v) => `${v.toLocaleString("en-US")} cycles`, group: "life" },
    { key: "aug",   label: "Cost of new cells",     min: 30,  max: 400,   step: 5,   fmt: (v) => `${CUR}${v}/kWh`, group: "life" },
  ];

  // Per-market starting points. Costs are 2025 benchmarks for a utility-scale 4-hour battery,
  // all-in (equipment, installation and grid connection), in the market's currency:
  //   California: BNEF 2025 US turnkey average ($219/kWh) + ~$60/kWh installation and grid connection
  //               (Ember, 2025); 30% federal investment tax credit (IRC §48E, kept for storage in 2025).
  //   Germany:    BNEF 2025 Europe turnkey ($177/kWh ≈ €155) + ~€50/kWh installation and grid connection.
  //   S Australia: CSIRO GenCost 2025-26, 4-hour battery, A$385/kWh total (A$265 battery + A$120 balance of plant).
  // New cells (augmentation) cost the battery part only. The agent's wear price defaults to the
  // physical wear these imply (see impliedWear). Grid-services prices are yearly averages of real
  // market results (assets/data/services.js, built by tools/build_services.py and refreshed with
  // the price data); capacity payments are illustrative.
  const SV = Object.assign({ year: 2025, caiso: { svc: 7.2 }, de: { svc: 15.2, afrr: 33.6 }, sa: { svc: 5.6 } },
                           window.GRID_SERVICES || {});
  // Where each real market's defaults come from (shown on the page and in the business case).
  const MARKET_INFO = {
    caiso: {
      svc: `California's ${SV.year} day-ahead average for regulation up plus regulation down: $${SV.caiso.svc} per MW per hour (CAISO OASIS; mileage payments not included)`,
      cost: "$280/kWh all-in: BloombergNEF's 2025 US turnkey average ($219/kWh) plus about $60/kWh for installation and grid connection (Ember, 2025)",
      itc: "the US federal investment tax credit for storage, IRC §48E",
    },
    de: {
      svc: `Germany's ${SV.year} average FCR (primary frequency reserve) price: €${SV.de.svc} per MW per hour (regelleistung.net)`
        + (SV.de.afrr ? `. aFRR paid ${SV.de.afrr > SV.de.svc ? "more" : "less"} on average (about €${SV.de.afrr} per MW per hour for up plus down) and is less predictable` : ""),
      cost: "€205/kWh all-in: BloombergNEF's 2025 Europe turnkey average ($177/kWh, about €155) plus about €50/kWh for installation and grid connection",
    },
    sa: {
      svc: `South Australia's ${SV.year} average for the six contingency FCAS markets combined (raise and lower, 6 s / 60 s / 5 min): A$${SV.sa.svc} per MW per hour (AEMO). Power is not reserved by default because trading pays far more here`,
      cost: "A$385/kWh all-in: CSIRO GenCost 2025-26, 4-hour battery (A$265 battery + A$120 balance of plant)",
    },
  };

  const MARKET_DEFAULTS = {
    sim:    { capex: 250, aug: 150, itc: 0,  res: 20, svc: 8,  capp: 40 },
    caiso:  { capex: 280, aug: 150, itc: 30, res: 20, svc: SV.caiso.svc, capp: 60 },
    de:     { capex: 205, aug: 120, itc: 0,  res: 20, svc: SV.de.svc, capp: 0 },
    sa:     { capex: 385, aug: 265, itc: 0,  res: 0,  svc: SV.sa.svc, capp: 0 },
    upload: { capex: 250, aug: 150, itc: 0,  res: 0,  svc: 0,  capp: 0 },
  };
  // Physical wear per full cycle implied by the lifetime assumptions: new cells for the 20% of
  // capacity a cycle-life's worth of cycles uses up.
  const wearFor = (s) => (0.2 * s.cap * 1000 * s.aug) / s.clife;
  const streamDefaults = (key, s) => {
    const d = { ...(MARKET_DEFAULTS[SIM[key] ? "sim" : key] || MARKET_DEFAULTS.upload) };
    d.wear = Math.round(wearFor({ ...s, ...d }) / 50) * 50;
    return d;
  };
  const solarSite = (key) => (SIM[key] || key === "upload" ? "sim" : key);

  // Fixed lifetime assumptions (shown on the page).
  const LIFE = { calendarFade: 0.01, augmentAt: 0.8, augDecline: 0.03, omPct: 0.015, warrantyCycles: 365, availability: 0.95 };

  const DEFAULTS = { p: "typical", d: null, mode: "forecast", cap: 100, pw: 25, wear: 500, fe: 20, vol: 5,
                     eff: 88, frag: 300, capex: 250, itc: 0, lo: 10, hi: 90, seed: 42,
                     res: 20, svc: 8, capp: 40, solar: 0, life: 15, disc: 8, clife: 6000, aug: 150 };

  // ------------------------------------------------------------------------------------
  // Dates (market local time, handled as naive UTC)
  // ------------------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseNaive = E.parseNaive, fmtNaive = E.fmtNaive;
  const fmtDay = (ms) => { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const fmtShortDay = (ms) => { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`; };
  const fmtClock = (ms) => { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

  // ------------------------------------------------------------------------------------
  // Markets
  // ------------------------------------------------------------------------------------
  const realMarket = (key) => (key === "upload" ? uploaded : REAL[key]);
  // Number of 15-minute prices; known from the index even before a market's prices are loaded.
  const priceCount = (m) => (m.prices ? m.prices.length : (m.days || 0) * STEPS_PER_DAY);
  const dayCount = (m) => Math.max(1, Math.floor(priceCount(m) / STEPS_PER_DAY) - 1);   // possible 48h windows

  // Real prices are loaded only when a market is opened (assets/data/prices-<market>.js), so the
  // first visit downloads just the page; the offline cache stores them in the background.
  const marketLoads = {};
  const isLoaded = (key) => !!(SIM[key] || key === "upload" || (REAL[key] && REAL[key].prices));
  function ensureMarket(key) {
    if (isLoaded(key)) return Promise.resolve();
    if (!marketLoads[key]) {
      marketLoads[key] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `assets/data/prices-${key}.js?v=${BUILD}`;
        s.onload = () => (REAL[key] && REAL[key].prices ? resolve() : reject(new Error("no prices")));
        s.onerror = () => { delete marketLoads[key]; s.remove(); reject(new Error("load failed")); };
        document.head.appendChild(s);
      });
    }
    return marketLoads[key];
  }
  // Default 48 hours for a real market: a representative (median-spread) window, not the best one.
  const defaultDay = (key) => { const m = realMarket(key); return m ? Math.min(m.typical || 0, dayCount(m) - 1) : 0; };

  // The 48 hours of prices to trade, plus labels for the chosen market.
  function marketFor(state) {
    const sim = SIM[state.p];
    if (sim) {
      return {
        prices: E.generateMarket({ ...sim, seed: state.seed, volatility: state.vol }),
        startMs: E.todayMs(), currency: "$", label: sim.label, real: false,
      };
    }
    const m = realMarket(state.p);
    const d = Math.min(Math.max(0, state.d | 0), dayCount(m) - 1);
    return {
      prices: Float64Array.from(m.prices.slice(d * STEPS_PER_DAY, d * STEPS_PER_DAY + N)),
      startMs: parseNaive(m.start) + d * DAY_MS, currency: m.currency, label: m.label, real: true, meta: m, d,
    };
  }

  // The battery as the trading engine sees it: power reserved for grid services can't be traded.
  const tradingBattery = (s) => ({ ...s, pw: Math.max(1, s.pw * (1 - s.res / 100)) });

  function simulate(state) {
    const mk = marketFor(state);
    CUR = mk.currency;
    const t0 = performance.now();
    const free = state.solar > 0 ? E.solarClipping(mk.startMs, N, solarSite(state.p), state.solar, 1 + (state.d | 0)).free : null;
    const w = E.runWindow(mk.prices, tradingBattery(state), { mode: state.mode, fe: state.fe, seed: state.seed, free });
    const ms = performance.now() - t0;
    // Upfront cost net of any investment tax credit.
    const capexGross = state.cap * 1000 * state.capex;
    const capex = capexGross * (1 - state.itc / 100);
    // Annual figures: the full-year simulation when it's available for this market, otherwise
    // (simulated markets) the 48-hour result scaled to a year.
    const year = mk.real ? annualCache.get(annualKey(state)) || null : null;
    const X = Array.from({ length: N }, (_, t) => fmtNaive(mk.startMs + t * STEP_MS));
    const r = {
      mk, X, XEND: fmtNaive(mk.startMs + N * STEP_MS), prices: mk.prices, ms, w,
      ai: w.ai, hind: w.hind, bot: w.bot, forecast: w.forecast, useForecast: w.useForecast,
      capex, capexGross, year, captured: w.hind.net > 1 ? (w.ai.net / w.hind.net) * 100 : null,
    };
    // Annual figures use every revenue stream: energy trading (full-year simulation when available,
    // otherwise the 48 hours scaled up) plus grid services and capacity payments.
    r.stack = revenueStack(r, state);
    r.annual = r.stack ? r.stack.total : w.ai.net * 182.5;
    r.roi = (r.annual / capex) * 100;
    r.payback = r.annual > 0 ? capex / r.annual : Infinity;
    return r;
  }

  // ------------------------------------------------------------------------------------
  // Revenue streams per year
  // ------------------------------------------------------------------------------------
  function revenueStack(r, s) {
    const pending = r.mk.real && !r.year && hasYearData(s.p);
    if (pending) return null;
    const k = r.year ? r.year.scale : 182.5;                  // full year, or 48 hours scaled up
    const src = r.year ? { ai: r.year.ai, bot: r.year.bot } : { ai: r.ai, bot: r.bot };
    const reservedMW = s.pw * s.res / 100;
    const services = reservedMW * s.svc * 8760 * LIFE.availability;
    const duration = s.cap / s.pw;
    const capacity = s.capp * s.pw * 1000 * Math.min(1, duration / 4);   // shorter than 4 h counts less
    const energy = src.ai.net * k;
    return {
      basis: r.year ? (r.year.scale > 1.01 ? `scaled from ${r.year.days} days` : `full year ${r.mk.meta.year || ""}`.trim()) : "scaled from 48 hours",
      energy, energyGross: src.ai.revenue * k, cycles: src.ai.cycles * k,
      botGross: src.bot.revenue * k, botCycles: src.bot.cycles * k,
      solarMWh: (src.ai.solarMWh || 0) * k, solarValue: (src.ai.solarValue || 0) * k,
      services, capacity, reservedMW, duration, total: energy + services + capacity,
    };
  }

  // ------------------------------------------------------------------------------------
  // Full-year simulation (real markets): runs in a background worker so the page stays smooth.
  // A fresh worker per run keeps it fast, and moving a slider simply cancels the old run.
  // ------------------------------------------------------------------------------------
  const annualCache = new Map();
  let annualJob = null, annualTimer = 0;
  const BATTERY_KEYS = ["cap", "pw", "wear", "eff", "frag", "lo", "hi", "res", "solar"];
  const hasYearData = (key) => { const m = realMarket(key); return !!m && priceCount(m) >= 28 * STEPS_PER_DAY; };
  function annualKey(s) {
    const src = s.p === "upload" && uploaded ? `${uploaded.name}:${uploaded.prices.length}` : "";
    return [s.p, src, ...BATTERY_KEYS.map((k) => s[k]), s.mode, s.fe, s.seed].join("|");
  }

  function requestAnnual() {
    if (SIM[state.p] || !hasYearData(state.p) || kiosk.on) return;
    const key = annualKey(state);
    if (annualCache.has(key) || (annualJob && annualJob.key === key)) return;
    if (annualJob) annualJob.cancel();
    clearTimeout(annualTimer);
    annualJob = { key, progress: 0, cancel() { this.cancelled = true; } };
    annualTimer = setTimeout(() => startAnnual(key), 350);     // wait for slider drags to settle
  }

  function startAnnual(key) {
    const job = annualJob;
    if (!job || job.key !== key || job.cancelled) return;
    const m = realMarket(state.p);
    const b = {};
    for (const k of BATTERY_KEYS) b[k] = state[k];
    b.pw = tradingBattery(state).pw;
    const opts = { mode: state.mode, fe: state.fe, seed: state.seed,
                   solar: state.solar > 0 ? { site: solarSite(state.p), mwDC: state.solar, seed: 1 } : null };
    let worker = null;
    job.cancel = () => { job.cancelled = true; if (worker) worker.terminate(); };
    const done = (res) => {
      if (job.cancelled) return;
      annualCache.set(key, res);
      if (annualJob === job) annualJob = null;
      if (!kiosk.on) scheduleRender();
    };
    const runHere = () => setTimeout(() => {          // fallback when workers are unavailable
      if (!job.cancelled) done(E.annual(Float64Array.from(m.prices), parseNaive(m.start), b, opts));
    }, 30);
    try {
      // createEngine (engine.js) is serialised into the worker, so this also works from file://.
      const src = `const E = (${createEngine.toString()})();
        onmessage = (e) => { const d = e.data;
          const res = E.annual(new Float64Array(d.prices), d.startMs, d.b, d.opts, (p) => postMessage({ progress: p }));
          postMessage({ result: res }); };`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        URL.revokeObjectURL(url);
        if (e.data.progress != null) { job.progress = e.data.progress; if (annualJob === job) renderAnnualStatus(); return; }
        worker.terminate();
        done(e.data.result);
      };
      worker.onerror = (e) => { if (e.preventDefault) e.preventDefault(); worker.terminate(); runHere(); };
      const buf = Float64Array.from(m.prices).buffer;
      worker.postMessage({ prices: buf, startMs: parseNaive(m.start), b, opts }, [buf]);
    } catch (err) {
      runHere();
    }
  }

  // ------------------------------------------------------------------------------------
  // State ⇄ URL hash, so a scenario can be shared as a link
  // ------------------------------------------------------------------------------------
  function readState() {
    const s = { ...DEFAULTS };
    const params = new URLSearchParams(location.hash.slice(1));
    const p = params.get("p");
    if (SIM[p] || REAL[p]) s.p = p;
    if (SIM[s.p]) { s.vol = SIM[s.p].volatility; s.seed = SIM[s.p].seed; }
    Object.assign(s, streamDefaults(s.p, s));
    if (params.get("mode") === "hindsight") s.mode = "hindsight";
    for (const c of CONTROLS) {
      const v = parseFloat(params.get(c.key));
      if (Number.isFinite(v)) s[c.key] = Math.min(c.max, Math.max(c.min, v));
    }
    const seed = parseInt(params.get("seed"), 10);
    if (Number.isFinite(seed)) s.seed = Math.abs(seed) % 100000;
    const d = parseInt(params.get("d"), 10);
    if (Number.isFinite(d) && d >= 0) s.d = d;
    if (s.d == null) s.d = SIM[s.p] ? 0 : defaultDay(s.p);
    return s;
  }
  function writeState() {
    const params = new URLSearchParams();
    params.set("p", state.p);
    if (!SIM[state.p]) params.set("d", state.d);
    params.set("mode", state.mode);
    for (const c of CONTROLS) if (!(c.simOnly && !SIM[state.p])) params.set(c.key, state[c.key]);
    if (SIM[state.p]) params.set("seed", state.seed);
    history.replaceState(null, "", location.pathname + location.search + "#" + params.toString());
  }

  // ------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const palette = () => PALETTES[window.Site.theme()];
  const PLOT_CONFIG = { displayModeBar: false, responsive: true };

  function baseLayout(c, r) {
    return {
      margin: { l: 48, r: 44, t: 8, b: 28 },
      showlegend: false,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: getComputedStyle(document.body).fontFamily, size: 12, color: c.muted },
      hovermode: "x unified",
      hoverlabel: { bgcolor: c.surface, bordercolor: c.line, font: { color: c.ink, size: 12 } },
      xaxis: { type: "date", tickformat: "%a %H:%M", showgrid: false, linecolor: c.line, fixedrange: true, range: [r.X[0], r.XEND] },
      yaxis: { gridcolor: c.line, zeroline: false, fixedrange: true, tickprefix: CUR },
    };
  }

  // Contiguous charge/discharge runs (for the shaded bands), clipped at `upto`.
  function blocks(modes, upto) {
    const out = [];
    let start = -1;
    for (let t = 0; t <= upto; t++) {
      const m = t < upto ? modes[t] : IDLE;
      if (start >= 0 && m !== modes[start]) { out.push([modes[start], start, t]); start = -1; }
      if (start < 0 && m !== IDLE) start = t;
    }
    return out;
  }

  // Main chart. `upto` < N draws the battery's decisions only up to that step (auto-play).
  function renderMainChart(r, c, upto, el, opts = {}) {
    const { ai, prices, X } = r;
    const pick = (mode) => { const idx = []; for (let t = 0; t < upto; t++) if (ai.modes[t] === mode) idx.push(t); return idx; };
    const buys = pick(CHARGE), sells = pick(DISCHARGE);
    const traces = [
      {
        x: X.slice(0, upto), y: ai.socPct.slice(0, upto), yaxis: "y2", name: "Battery", type: "scatter", mode: "lines",
        line: { color: c.soc, width: 1.5 }, fill: "tozeroy", fillcolor: c.socFill,
        hovertemplate: "Battery %{y:.0f}%<extra></extra>",
      },
    ];
    if (r.forecast) {
      traces.push({
        x: X, y: Array.from(r.forecast), name: "Forecast", type: "scatter", mode: "lines",
        line: { color: c.forecast, width: 1.5, dash: "dash" }, hovertemplate: `Forecast ${CUR}%{y:.0f}<extra></extra>`,
      });
    }
    traces.push(
      {
        x: X, y: Array.from(prices), name: "Price", type: "scatter", mode: "lines",
        line: { color: c.price, width: 2 }, hovertemplate: `Price ${CUR}%{y:.0f}/MWh<extra></extra>`,
      },
      {
        x: buys.map((t) => X[t]), y: buys.map((t) => prices[t]), name: "AI buys", type: "scatter", mode: "markers",
        marker: { symbol: "triangle-up", size: 9, color: c.charge, line: { width: 1, color: c.surface } },
        customdata: buys.map((t) => [t, ai.moves[t] / DT]), hovertemplate: "Buy %{customdata[1]:.0f} MW<extra></extra>",
      },
      {
        x: sells.map((t) => X[t]), y: sells.map((t) => prices[t]), name: "AI sells", type: "scatter", mode: "markers",
        marker: { symbol: "triangle-down", size: 9, color: c.discharge, line: { width: 1, color: c.surface } },
        customdata: sells.map((t) => [t, -ai.moves[t] / DT]), hovertemplate: "Sell %{customdata[1]:.0f} MW<extra></extra>",
      }
    );
    const shapes = blocks(ai.modes, upto).map(([mode, i0, i1]) => ({
      type: "rect", xref: "x", yref: "paper", x0: X[i0], x1: i1 < N ? X[i1] : r.XEND, y0: 0, y1: 1,
      fillcolor: mode === CHARGE ? c.charge : c.discharge, opacity: 0.07, line: { width: 0 }, layer: "below",
    }));
    shapes.push({ type: "line", xref: "x", yref: "paper", x0: X[N / 2], x1: X[N / 2], y0: 0, y1: 1, line: { color: c.line, width: 1, dash: "dot" } });
    if (upto < N && !opts.pricesOnly) {
      const at = upto > 0 ? X[upto - 1] : X[0];
      shapes.push({ type: "line", xref: "x", yref: "paper", x0: at, x1: at, y0: 0, y1: 1, line: { color: c.ink, width: 1.5 } });
    }
    const layout = baseLayout(c, r);
    if (opts.big) {
      layout.font.size = 16; layout.hoverlabel.font.size = 16;
      if ($(el).offsetWidth < 600) {      // phones: one label per day, the time on hover
        Object.assign(layout.xaxis, { tickformat: "%a", dtick: DAY_MS, hoverformat: "%a %H:%M" });
      }
    }
    layout.shapes = shapes;
    layout.yaxis2 = {
      overlaying: "y", side: "right", range: [0, 105], tickmode: "array",
      tickvals: [0, 25, 50, 75, 100], ticktext: ["0%", "25%", "50%", "75%", "100%"],
      showgrid: false, zeroline: false, fixedrange: true, visible: !opts.pricesOnly,
    };
    return Plotly.react(el, traces, layout, PLOT_CONFIG);
  }

  function renderCumChart(r, c, el = "chart-cum") {
    const traces = [
      { x: r.X, y: Array.from(r.bot.cum), name: "Bot", type: "scatter", mode: "lines",
        line: { color: c.bot, width: 2, dash: "dot" }, hovertemplate: "Bot %{y:,.0f}<extra></extra>" },
    ];
    if (r.useForecast) {
      traces.push({ x: r.X, y: Array.from(r.hind.cum), name: "Hindsight", type: "scatter", mode: "lines",
        line: { color: c.soc, width: 1.5, dash: "dash" }, hovertemplate: "Hindsight %{y:,.0f}<extra></extra>" });
    }
    traces.push({ x: r.X, y: Array.from(r.ai.cum), name: "AI", type: "scatter", mode: "lines",
      line: { color: c.ink, width: 2.5 }, hovertemplate: "AI %{y:,.0f}<extra></extra>" });
    const layout = baseLayout(c, r);
    layout.margin = { l: 56, r: 8, t: 8, b: 28 };
    layout.yaxis.tickformat = ",.2s";
    layout.yaxis.zeroline = true;
    layout.yaxis.zerolinecolor = c.muted;
    return Plotly.react(el, traces, layout, PLOT_CONFIG);
  }

  // Headline numbers. During an auto-play replay (t < N) they show the running totals so far.
  function kpiList(r, t = N) {
    const { ai, bot, hind } = r;
    if (t < N) {
      const i = Math.max(0, t - 1);
      const net = t ? ai.cum[i] : 0, botNet = t ? bot.cum[i] : 0, up = net - botNet;
      return [
        { label: "Net profit so far", value: money(net), sub: "after battery wear", cls: net < 0 ? "neg" : "" },
        { label: "vs. rule-based bot so far", value: signedMoney(up), sub: `bot: ${money(botNet)}`, cls: up >= 0 ? "pos" : "neg" },
        { label: "Of hindsight maximum", value: "…", sub: "after 48 hours" },
        { label: "Battery cycles so far", value: (t ? ai.cumCycles[i] : 0).toFixed(2), sub: `bot: ${(t ? bot.cumCycles[i] : 0).toFixed(2)}` },
        { label: "Estimated annual ROI", value: "…", sub: "after 48 hours" },
      ];
    }
    const uplift = ai.net - bot.net;
    const payback = Number.isFinite(r.payback) ? `${r.payback.toFixed(1)}-yr payback` : "no payback here";
    const captured = r.captured == null ? "—" : `${Math.round(r.captured)}%`;
    // Real markets: ROI comes from the full-year simulation (shown as pending while it runs).
    const yearPending = r.mk.real && !r.year && hasYearData(state.p);
    const roiKpi = yearPending
      ? { label: "Estimated annual ROI", value: "…", sub: "simulating full year" }
      : { label: "Estimated annual ROI", value: `${r.roi.toFixed(1)}%`, cls: r.roi < 0 ? "neg" : "",
          sub: `${payback} · ${r.year ? (r.year.scale > 1.01 ? `from ${r.year.days} days` : `full year ${r.mk.meta.year || ""}`.trim()) : "scaled from 48 h"}` };
    return [
      { label: "Net profit, 48 hours", value: money(ai.net), sub: "after battery wear", cls: ai.net < 0 ? "neg" : "" },
      { label: "vs. rule-based bot", value: signedMoney(uplift), sub: `bot: ${money(bot.net)}`, cls: uplift >= 0 ? "pos" : "neg" },
      { label: "Of hindsight maximum", value: captured,
        sub: r.useForecast ? `max: ${money(hind.net)}` : "agent sees the future" },
      { label: "Battery cycles used", value: ai.cycles.toFixed(2), sub: `bot: ${bot.cycles.toFixed(2)}` },
      roiKpi,
    ];
  }

  function renderKpis(r, t = N) {
    $("kpis").innerHTML = kpiList(r, t).map((k) => `
      <div class="kpi">
        <div class="label">${k.label}</div>
        <div class="value ${k.cls || ""}">${k.value}</div>
        <div class="sub">${k.sub}</div>
      </div>`).join("");
  }

  function renderInsight(r) {
    const { ai, bot } = r;
    const uplift = ai.net - bot.net;
    const saved = bot.cycles - ai.cycles;
    const cyclePart = saved > 0.05
      ? `while using <b>${saved.toFixed(1)} fewer cycles</b>`
      : saved < -0.05 ? `using <b>${(-saved).toFixed(1)} more cycles</b> where they pay off` : "with a similar number of cycles";
    let text = ai.runs === 0
      ? `In these 48 hours no price gap was big enough to pay for battery wear and efficiency losses, so the AI <b>held</b> and saved the battery${bot.net < 0 ? `, while the rule-based bot <b>lost ${money(-bot.net)}</b> by trading anyway` : ""}.`
        + (r.year ? " The full-year results below show where it does trade." : "")
      : uplift >= 0
      ? `The AI earns <b>${signedMoney(uplift).slice(1)} more</b> than a rule-based bot over 48 hours, ${cyclePart}, in <b>${ai.runs}</b> charge and discharge runs (bot: ${bot.runs}).`
      : `Here the AI earns ${money(-uplift)} less than the bot, using ${ai.runs} runs to the bot's ${bot.runs}.`;
    if (ai.runs === 0) { $("insight").innerHTML = text; return; }
    if (r.useForecast && r.captured != null) {
      text += ` Trading on a forecast with ±${state.fe}% error, it still captures <b>${Math.round(r.captured)}%</b> of what perfect hindsight would earn.`;
    } else if (!r.useForecast) {
      text += " In this view the agent knows future prices exactly: the theoretical upper bound.";
    }
    const hurdle = state.wear / state.cap;
    text += hurdle > 0.5
      ? ` It only cycles when the price gap beats about <b>${CUR}${Math.round(hurdle)}/MWh</b> of battery wear.`
      : " With wear priced at zero, it trades on almost any price gap.";
    $("insight").innerHTML = text;
  }

  function sourceText(r) {
    if (!r.mk.real) return "Simulated prices. Choose a real market above to trade on historical data.";
    const m = r.mk.meta;
    return `${state.p === "upload" ? "Your prices" : "Real prices"}: ${m.name}, ${fmtDay(r.mk.startMs)} – ${fmtDay(r.mk.startMs + DAY_MS)} · ${m.tz} · ${m.unit} · Source: ${m.source}`;
  }

  function compareRows(r) {
    const { ai, hind, bot } = r;
    return [
      ["Trading revenue", money(ai.revenue), money(hind.revenue), money(bot.revenue)],
      ["Battery wear", money(-ai.wear), money(-hind.wear), money(-bot.wear)],
      ["Net profit", money(ai.net), money(hind.net), money(bot.net), "total"],
      ["Cycles used", ai.cycles.toFixed(2), hind.cycles.toFixed(2), bot.cycles.toFixed(2)],
      ["Charge / discharge runs", ai.runs, hind.runs, bot.runs],
    ];
  }

  function renderCompare(r, c) {
    const aiName = r.useForecast ? "AI (forecast)" : "AI";
    $("compare").innerHTML = `
      <thead><tr><th><span class="sr-only">Measure</span></th>
        <th><span class="dot" style="background:${c.ink}"></span>${aiName}</th>
        <th><span class="dot" style="background:${c.soc}"></span>Hindsight</th>
        <th><span class="dot" style="background:${c.bot}"></span>Bot</th></tr></thead>
      <tbody>${compareRows(r).map(([k, a, h, b, cls]) =>
        `<tr class="${cls || ""}"><td>${k}</td><td class="ai">${a}</td><td>${h}</td><td>${b}</td></tr>`).join("")}</tbody>`;
  }

  // ------------------------------------------------------------------------------------
  // Full-year section (real markets)
  // ------------------------------------------------------------------------------------
  function annualRows(y) {
    const s = y.scale;
    return [
      ["Net revenue per year", money(y.ai.net * s), money(y.hind.net * s), money(y.bot.net * s), "total"],
      ["Battery wear per year", money(-y.ai.wear * s), money(-y.hind.wear * s), money(-y.bot.wear * s)],
      ["Cycles per year", Math.round(y.ai.cycles * s), Math.round(y.hind.cycles * s), Math.round(y.bot.cycles * s)],
      ["Charge / discharge runs", fmtNum(y.ai.runs * s), fmtNum(y.hind.runs * s), fmtNum(y.bot.runs * s)],
    ];
  }

  function renderAnnualStatus() {
    const pct = annualJob ? Math.round((annualJob.progress || 0) * 100) : 100;
    $("annual-status").innerHTML = annualJob
      ? `<span class="spinner" aria-hidden="true"></span>Simulating every hour of the year… ${pct}%`
      : "";
    if (stage.on && $("stage-progress")) $("stage-progress").textContent = annualProgressText();
    keepInPlace();                        // the progress line can wrap and push the cards below it
  }

  function renderAnnual(r) {
    const sec = $("annual");
    if (!r || !r.mk.real || !hasYearData(state.p)) { sec.hidden = true; return; }
    sec.hidden = false;
    const m = r.mk.meta, y = r.year;
    const days = Math.floor(m.prices.length / STEPS_PER_DAY);
    $("annual-title").textContent = days >= 365 ? `A full year: ${m.label}, ${m.year || ""}`.trim() : `${days} days: ${m.label}`;
    const agent = r.useForecast
      ? `The AI re-plans every hour on a forecast with ±${state.fe}% error and a 24-hour look-ahead`
      : "Perfect-hindsight view: the AI sees every price in advance";
    $("annual-note").textContent = `${agent}. Hindsight is one optimisation over the whole period: the most any strategy could earn.`
      + (days < 365 ? ` Annual figures are scaled from ${days} days.` : "");
    renderAnnualStatus();
    sec.classList.toggle("pending", !y);
    if (!y) return;
    const s = y.scale;
    const annualNet = y.ai.net * s;
    const roi = (annualNet / r.capex) * 100;
    const payback = annualNet > 0 ? `${(r.capex / annualNet).toFixed(1)}-year payback` : "no payback at these settings";
    const pctMax = y.hind.net > 1 ? `${Math.round((y.ai.net / y.hind.net) * 100)}%` : "—";
    const kpis = [
      { label: days >= 365 ? "Net revenue in the year" : "Net revenue per year", value: money(annualNet), sub: "after battery wear", cls: annualNet < 0 ? "neg" : "" },
      { label: "vs. rule-based bot", value: signedMoney((y.ai.net - y.bot.net) * s), sub: `bot: ${money(y.bot.net * s)}`,
        cls: y.ai.net >= y.bot.net ? "pos" : "neg" },
      { label: "Of hindsight maximum", value: pctMax, sub: `max: ${money(y.hind.net * s)}` },
      { label: "Annual ROI", value: `${roi.toFixed(1)}%`, sub: payback, cls: roi < 0 ? "neg" : "" },
    ];
    $("annual-kpis").innerHTML = kpis.map((k) => `
      <div class="kpi"><div class="label">${k.label}</div><div class="value ${k.cls || ""}">${k.value}</div><div class="sub">${k.sub}</div></div>`).join("");
    const c = palette();
    $("annual-compare").innerHTML = `
      <thead><tr><th><span class="sr-only">Measure</span></th>
        <th><span class="dot" style="background:${c.ink}"></span>AI</th>
        <th><span class="dot" style="background:${c.soc}"></span>Hindsight</th>
        <th><span class="dot" style="background:${c.bot}"></span>Bot</th></tr></thead>
      <tbody>${annualRows(y).map(([k, a, h, b, cls]) =>
        `<tr class="${cls || ""}"><td>${k}</td><td class="ai">${a}</td><td>${h}</td><td>${b}</td></tr>`).join("")}</tbody>`;
    renderMonthlyChart(y, c, "chart-monthly");
  }

  // Monthly net revenue: AI bars against the hindsight maximum.
  function renderMonthlyChart(y, c, el, print) {
    const x = y.ai.monthly.map((mo) => `${MO[mo.month]}${y.ai.monthly.length > 12 ? " " + String(mo.year).slice(2) : ""}`);
    const traces = [
      { x, y: y.hind.monthly.map((mo) => mo.net), name: "Hindsight", type: "scatter", mode: "lines+markers",
        line: { color: c.soc, width: 1.5, dash: "dash" }, marker: { size: 5, color: c.soc },
        hovertemplate: `Hindsight ${CUR}%{y:,.0f}<extra></extra>` },
      { x, y: y.ai.monthly.map((mo) => mo.net), name: "AI", type: "bar", marker: { color: c.ink },
        hovertemplate: `AI ${CUR}%{y:,.0f}<extra></extra>` },
    ];
    const layout = {
      margin: { l: 56, r: 8, t: 8, b: 28 }, showlegend: false, bargap: 0.35,
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: print ? "Helvetica, Arial, sans-serif" : getComputedStyle(document.body).fontFamily, size: 12, color: c.muted },
      hovermode: "x unified", hoverlabel: { bgcolor: c.surface, bordercolor: c.line, font: { color: c.ink, size: 12 } },
      xaxis: { showgrid: false, linecolor: c.line, fixedrange: true },
      yaxis: { gridcolor: c.line, fixedrange: true, tickprefix: CUR, tickformat: ",.2s", zeroline: true, zerolinecolor: c.muted },
    };
    return Plotly.react(el, traces, layout, PLOT_CONFIG);
  }


  // ------------------------------------------------------------------------------------
  // Revenue streams section
  // ------------------------------------------------------------------------------------
  function renderStack(r) {
    const st = r.stack, sec = $("stack");
    sec.classList.toggle("pending", !st);
    // While the full year re-runs, the card dims and keeps its text (a shorter "Waiting..." line
    // would move the sliders under it).
    if (!st) { if (!$("stack-note").textContent) $("stack-note").textContent = "Waiting for the full-year simulation…"; return; }
    $("stack-note").textContent = `Per year, ${st.basis}. Energy trading is after battery wear; grid services and capacity payments are paid for availability.`;
    const c = palette();
    const parts = [
      { label: "Energy trading", value: st.energy, color: c.ink },
      { label: "Grid services", value: st.services, color: c.soc },
      { label: "Capacity payments", value: st.capacity, color: c.price },
    ];
    const pos = parts.filter((x) => x.value > 0);
    const sum = pos.reduce((a, x) => a + x.value, 0) || 1;
    $("stack-bar").innerHTML = pos.map((x) =>
      `<div class="seg-part" style="flex:${x.value / sum};background:${x.color}" title="${x.label}: ${money(x.value)}"></div>`).join("");
    const roi = (st.total / r.capex) * 100, roiEnergy = (st.energy / r.capex) * 100;
    const rows = [
      [`<span class="dot" style="background:${c.ink}"></span>Energy trading`, money(st.energy),
        st.solarMWh > 0.5 ? `includes ${fmtNum(st.solarMWh)} MWh of free clipped solar (worth about ${money(st.solarValue)} at market prices)` : "buying low and selling high, after battery wear"],
      [`<span class="dot" style="background:${c.soc}"></span>Grid services`, money(st.services),
        st.reservedMW > 0 ? `${st.reservedMW.toFixed(1)} MW kept back for frequency services, ${Math.round(LIFE.availability * 100)}% availability` : "no power reserved"],
      [`<span class="dot" style="background:${c.price}"></span>Capacity payments`, money(st.capacity),
        state.capp > 0 ? `paid for being available at peak${st.duration < 4 ? `; counts ${Math.round(Math.min(1, st.duration / 4) * 100)}% for a ${st.duration.toFixed(1)}-hour battery` : ""}` : "this market has no capacity payment set"],
    ];
    $("stack-table").innerHTML = `<tbody>${rows.map(([k, v, note]) =>
      `<tr><td>${k}<div class="row-note">${note}</div></td><td class="ai">${v}</td></tr>`).join("")}
      <tr class="total"><td>Total per year</td><td>${money(st.total)}</td></tr>
      <tr><td>Annual ROI, all streams</td><td class="ai ${roi < 0 ? "neg" : ""}">${roi.toFixed(1)}%</td></tr>
      <tr><td>Annual ROI, energy trading only</td><td>${roiEnergy.toFixed(1)}%</td></tr></tbody>`;
    const solarTxt = state.solar > 0
      ? ` Solar: ${state.solar} MW of panels on a ${(state.solar / E.DC_AC_RATIO).toFixed(0)} MW inverter (simulated output typical for the region, not measured). The battery stores the midday output the inverter can't export, for free; on its own that adds little, since the main benefits of pairing with solar (shared grid connection, tax credits) aren't modelled.`
      : "";
    const info = MARKET_INFO[state.p];
    const svcTxt = info ? `Grid-services price: ${info.svc}.` : "Grid-services price: an illustrative assumption for this market.";
    $("stack-source").textContent = `${svcTxt} Capacity payments are an illustrative assumption: California pays for capacity through resource adequacy contracts, whose prices vary widely; Germany and Australia's NEM have no capacity payment. Power kept back for grid services is not available for trading, and the simulations reflect that.` + solarTxt;
  }

  // ------------------------------------------------------------------------------------
  // Battery lifetime section
  // ------------------------------------------------------------------------------------
  function lifeInputs(r, who) {
    const st = r.stack;
    return {
      years: state.life, capex: r.capex, omBase: r.capexGross, capKWh: state.cap * 1000,
      trading: who === "bot" ? st.botGross : st.energyGross,
      cyclesPerYear: who === "bot" ? st.botCycles : st.cycles,
      other: st.services + st.capacity,
      cycleLife: state.clife, calendarFade: LIFE.calendarFade, augmentAt: LIFE.augmentAt, augCost: state.aug,
      augDecline: LIFE.augDecline, omPct: LIFE.omPct, discount: state.disc / 100, warrantyCycles: LIFE.warrantyCycles,
    };
  }
  const impliedWear = () => wearFor(state);

  function renderLifetime(r) {
    const sec = $("lifetime");
    sec.classList.toggle("pending", !r.stack);
    if (!r.stack) { if (!$("life-note").textContent) $("life-note").textContent = "Waiting for the full-year simulation…"; return; }
    const ai = E.lifetime(lifeInputs(r, "ai")), bot = E.lifetime(lifeInputs(r, "bot"));
    r.life = { ai, bot };
    $("life-note").textContent = `${state.life} years of cash flow with physical battery wear. Revenue per year comes from the revenue streams above (${r.stack.basis}); here battery wear is paid for when new cells are needed, instead of the agent's internal wear price.`;
    const yrs = (v) => (v == null ? "—" : `${v.toFixed(1)} yrs`);
    const kpis = [
      { label: `Lifetime value (NPV at ${state.disc}%)`, value: money(ai.npv), sub: `rule-based bot: ${money(bot.npv)}`, cls: ai.npv < 0 ? "neg" : "pos" },
      { label: "Internal rate of return", value: ai.irr == null ? "—" : `${(ai.irr * 100).toFixed(1)}%`, sub: bot.irr == null ? "bot: —" : `bot: ${(bot.irr * 100).toFixed(1)}%` },
      { label: "Payback", value: yrs(ai.payback), sub: `${ai.payback == null ? `not within ${state.life} years · ` : ""}bot: ${yrs(bot.payback)}` },
      { label: "New cells needed", value: ai.augments ? `${ai.augments}×` : "none", sub: `${ai.firstAug ? `first in year ${ai.firstAug} · ` : ""}bot: ${bot.augments}×` },
    ];
    $("life-kpis").innerHTML = kpis.map((k) =>
      `<div class="kpi"><div class="label">${k.label}</div><div class="value ${k.cls || ""}">${k.value}</div><div class="sub">${k.sub}</div></div>`).join("");

    const cyc = Math.round(r.stack.cycles), botCyc = Math.round(r.stack.botCycles);
    const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
    const warn = (n) => (n <= LIFE.warrantyCycles ? `within a typical ${LIFE.warrantyCycles}-cycle-a-year warranty` : `<b>over</b> a typical ${LIFE.warrantyCycles}-cycle-a-year warranty limit`);
    let text = `The AI uses <b>${cyc} cycles a year</b>, ${warn(cyc)}, and ${ai.augments ? `needs new cells ${times(ai.augments)}` : "never needs new cells"} in ${state.life} years.`
      + ` The rule-based bot uses <b>${botCyc}</b>, ${warn(botCyc)}, and ${bot.augments ? `needs them ${times(bot.augments)}${bot.firstAug ? ` (first in year ${bot.firstAug})` : ""}` : "never needs them"}`
      + (bot.augTotal > ai.augTotal ? `, costing ${money(bot.augTotal - ai.augTotal)} more in replacement cells.` : ".");
    const iw = impliedWear();
    text += ` These assumptions put physical wear at about <b>${money(iw)} per full cycle</b>; the agent currently prices it at ${money(state.wear)}.`
      + (Math.abs(iw - state.wear) >= 50 ? ` <button type="button" class="link-btn" id="use-wear">Use ${money(Math.round(iw / 50) * 50)}</button>` : "");
    $("life-insight").innerHTML = text;
    const useBtn = $("use-wear");
    if (useBtn) useBtn.onclick = () => { state.wear = Math.min(20000, Math.max(0, Math.round(iw / 50) * 50)); syncControls(); scheduleRender(); toast("Wear price updated: the AI re-plans"); };

    $("life-assumptions").textContent = `Assumptions: battery health falls 20% over the cycle life plus ${LIFE.calendarFade * 100}% a year with age; when it drops below ${LIFE.augmentAt * 100}%, new cells restore it to 100% at the cost above, getting ${LIFE.augDecline * 100}% cheaper each year; operation and maintenance ${LIFE.omPct * 100}% of the installed cost a year; trading revenue scales with battery health; ${MARKET_INFO[state.p] ? `default installed cost ${MARKET_INFO[state.p].cost}; ` : ""}${state.itc ? `a ${state.itc}% investment tax credit${MARKET_INFO[state.p] && MARKET_INFO[state.p].itc ? ` (${MARKET_INFO[state.p].itc})` : ""} reduces the upfront cost; no other tax` : "no tax"}, financing or residual value.`;
    drawWhenNear("chart-health", () => renderLifeCharts(r, ai, bot, palette(), "chart-health", "chart-cash"));
  }

  function renderLifeCharts(r, ai, bot, c, healthEl, cashEl, print) {
    const health = (res) => {
      const x = [0], y = [100];
      for (const row of res.rows) {
        x.push(row.year); y.push(row.healthEnd * 100);
        if (row.healthAfter > row.healthEnd) { x.push(row.year); y.push(100); }
      }
      return { x, y };
    };
    const font = { family: print ? "Helvetica, Arial, sans-serif" : getComputedStyle(document.body).fontFamily, size: 12, color: c.muted };
    const base = (extra) => ({
      margin: { l: 56, r: 8, t: 8, b: 32 }, showlegend: false, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font, hovermode: "x unified", hoverlabel: { bgcolor: c.surface, bordercolor: c.line, font: { color: c.ink, size: 12 } },
      xaxis: { title: { text: "Year", font: { size: 11 } }, showgrid: false, linecolor: c.line, fixedrange: true, dtick: 1 },
      ...extra,
    });
    const ha = health(ai), hb = health(bot);
    const p1 = Plotly.react(healthEl, [
      { x: hb.x, y: hb.y, name: "Bot", type: "scatter", mode: "lines", line: { color: c.bot, width: 2, dash: "dot" }, hovertemplate: "Bot %{y:.0f}%<extra></extra>" },
      { x: ha.x, y: ha.y, name: "AI", type: "scatter", mode: "lines", line: { color: c.ink, width: 2.5 }, hovertemplate: "AI %{y:.0f}%<extra></extra>" },
    ], base({
      yaxis: { gridcolor: c.line, fixedrange: true, ticksuffix: "%", range: [Math.min(75, Math.min(...ha.y, ...hb.y) - 2), 101] },
      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: LIFE.augmentAt * 100, y1: LIFE.augmentAt * 100, line: { color: c.discharge, width: 1, dash: "dot" } }],
    }), PLOT_CONFIG);
    const cum = (res) => ({ x: [0, ...res.rows.map((row) => row.year)], y: [-r.capex, ...res.rows.map((row) => row.cum)] });
    const ca = cum(ai), cb = cum(bot);
    const p2 = Plotly.react(cashEl, [
      { x: cb.x, y: cb.y, name: "Bot", type: "scatter", mode: "lines", line: { color: c.bot, width: 2, dash: "dot" }, hovertemplate: `Bot ${CUR}%{y:,.0f}<extra></extra>` },
      { x: ca.x, y: ca.y, name: "AI", type: "scatter", mode: "lines", line: { color: c.ink, width: 2.5 }, hovertemplate: `AI ${CUR}%{y:,.0f}<extra></extra>` },
    ], base({ yaxis: { gridcolor: c.line, fixedrange: true, tickprefix: CUR, tickformat: ",.2s", zeroline: true, zerolinecolor: c.muted } }), PLOT_CONFIG);
    return Promise.all([p1, p2]);
  }

  // ------------------------------------------------------------------------------------
  // "Why this trade?"
  // ------------------------------------------------------------------------------------
  function hideExplain() { $("explain").hidden = true; }

  // Start of each AI trade (a run of buying or selling), for keyboard navigation between trades.
  const tradeStarts = (r) => r.ai.modes.reduce((a, m, i) => (m !== IDLE && (i === 0 || r.ai.modes[i - 1] !== m) ? (a.push(i), a) : a), []);
  let explainT = null;

  function showExplain(t, focus) {
    const r = last;
    const x = E.explainTrade(r.prices, r.w, tradingBattery(state), t);
    if (!x) { hideExplain(); return; }
    const p2 = (v) => `${CUR}${Math.round(v).toLocaleString("en-US")}`;
    const at = (i) => fmtClock(parseNaive(r.X[i]));
    const span = (o) => (o.from === o.to ? `at ${at(o.from)}` : `${at(o.from)}–${r.X[o.to + 1] ? r.X[o.to + 1].slice(11) : "end"}`);
    const source = r.useForecast ? `The forecast it had at ${at(x.planTau)}` : "Knowing the actual prices, the plan";
    const bot = x.botMove > 1e-9 ? "bought" : x.botMove < -1e-9 ? "sold" : "did nothing";
    let lead, cells, notes = [];
    if (x.kind === "buy") {
      lead = `<b>Bought ${x.mw.toFixed(0)} MW at ${p2(x.price)}/MWh</b> <span class="muted">${at(t)}</span>`;
      notes.push(x.expected
        ? `${source} expected prices around <b>${p2(x.expected.price)}</b> ${span(x.expected)}, when it planned to sell this energy.`
        : "Its plan didn't sell this energy within the 48 hours: it was topping the battery up to finish at least as full as it started.");
      if (x.price <= x.cheapestAhead + 0.5) notes.push("This was the cheapest price in its forecast for the next 24 hours.");
      if (x.freeMWh) notes.push(`${x.freeMWh.toFixed(1)} MWh of this came from solar the inverter couldn't export, so that part was free.`);
      cells = [
        ["Cost per stored MWh", p2(x.costPerStored), "after efficiency losses"],
        ["Expected sale per MWh", x.expected ? p2(x.expected.price * x.eta) : "—", "after efficiency losses"],
        ["Battery wear", p2(x.wearRound), "per MWh in and out"],
        ["Expected margin", x.margin == null ? "—" : p2(x.margin), "per MWh", x.margin == null ? "" : x.margin >= 0 ? "pos" : "neg"],
      ];
      if (r.useForecast && x.actual) notes.push(`What actually happened: it sold this energy at about ${p2(x.actual.price)} ${span(x.actual)}.`);
    } else {
      lead = `<b>Sold ${x.mw.toFixed(0)} MW at ${p2(x.price)}/MWh</b> <span class="muted">${at(t)}</span>`;
      if (x.bought) notes.push(`This energy was bought ${span(x.bought)} at about <b>${p2(x.bought.price)}</b>/MWh.`);
      else if (x.rebuy) notes.push(`This was energy already in the battery at the start; ${source.toLowerCase()} refilled it ${span(x.rebuy)} at about <b>${p2(x.rebuy.price)}</b>/MWh, so selling now and buying back later pays.`);
      else notes.push("This was energy already in the battery at the start, valued at the average price.");
      if (x.aheadMax && x.aheadMax.price > x.price * 1.03) notes.push(`The forecast showed higher prices later (about ${p2(x.aheadMax.price)} ${at(x.aheadMax.at)}); with limited power it sells some now and keeps some for then.`);
      else notes.push("This was the best price in its forecast for the next 12 hours.");
      cells = [
        ["Sale per MWh", p2(x.price * x.eta), "after efficiency losses"],
        [x.rebuy && !x.bought ? "Cost to refill" : "Cost per stored MWh", p2(x.costPerStored), "after efficiency losses"],
        ["Battery wear", p2(x.wearRound), "per MWh in and out"],
        ["Margin", p2(x.margin), "per MWh", x.margin >= 0 ? "pos" : "neg"],
      ];
    }
    if (x.margin != null && x.margin < 0) notes.push("On its own this step doesn't pay: the plan makes it to set up a better trade later (for example making room to recharge more cheaply), or the forecast it relied on was wrong.");
    notes.push(`The rule-based bot ${bot} at this moment.`);
    explainT = t;
    const starts = tradeStarts(r);
    const prev = starts.filter((s) => s < t).pop(), next = starts.find((s) => s > t);
    const nav = `<div class="explain-nav">
        <button type="button" class="link-btn" data-t="${prev == null ? "" : prev}" ${prev == null ? "disabled" : ""}>‹ Previous trade</button>
        <span class="muted">${starts.filter((s) => s <= t).length || 1} of ${starts.length} trades</span>
        <button type="button" class="link-btn" data-t="${next == null ? "" : next}" ${next == null ? "disabled" : ""}>Next trade ›</button></div>`;
    $("explain-body").innerHTML = `
      <div class="explain-lead" tabindex="-1">${lead}</div>
      <div class="explain-cells">${cells.map(([k, v, sub, cls]) => `<div><div class="label">${k}</div><div class="value ${cls || ""}">${v}</div><div class="sub">${sub}</div></div>`).join("")}</div>
      <ul class="explain-notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>${nav}`;
    $("explain").hidden = false;
    $("explain-body").querySelectorAll(".explain-nav button[data-t]").forEach((b) => {
      b.onclick = () => { if (b.dataset.t !== "") showExplain(+b.dataset.t, true); };
    });
    if (focus) $("explain-body").querySelector(".explain-lead").focus();
  }

  // Describe the main chart for screen readers (the chart itself is a picture).
  function describeMainChart(r) {
    const starts = tradeStarts(r);
    const buys = starts.filter((t) => r.ai.modes[t] === CHARGE).length, sells = starts.length - buys;
    const lo = Math.min(...r.prices), hi = Math.max(...r.prices);
    $("chart-main").setAttribute("aria-label",
      `Electricity price over 48 hours, from ${money(lo)} to ${money(hi)} per MWh, with the battery's charge level. ` +
      `The AI made ${buys} buying and ${sells} selling runs; net profit ${signedMoney(r.ai.net)}. ` +
      `Use "Explain the first trade" below the chart to step through each decision.`);
  }

  function onChartClick(ev) {
    if (kiosk.on || !last || !ev || !ev.points || !ev.points.length) return;
    let t = null;
    for (const pt of ev.points) if (pt.data && (pt.data.name === "AI buys" || pt.data.name === "AI sells") && pt.customdata) t = pt.customdata[0];
    if (t == null) {
      const i = last.X.indexOf(String(ev.points[0].x).slice(0, 16));
      if (i >= 0 && last.ai.modes[i] !== IDLE) t = i;
    }
    if (t == null) { hideExplain(); return; }
    showExplain(t);
  }

  function updateDaySelect(r) {
    const sel = $("day-select");
    if (!r.mk.real) { sel.hidden = true; return; }
    const m = r.mk.meta, days = dayCount(m), key = `${state.p}:${priceCount(m)}:${m.start}`;
    if (sel.dataset.key !== key) {
      const start = parseNaive(m.start);
      sel.innerHTML = Array.from({ length: days }, (_, d) =>
        `<option value="${d}">${fmtShortDay(start + d * DAY_MS)} – ${fmtShortDay(start + (d + 1) * DAY_MS)}</option>`).join("");
      sel.dataset.key = key;
    }
    sel.value = String(r.mk.d);
    sel.hidden = false;
  }

  let state = readState();
  let last = null;
  let clickBound = false;
  let firstDraw = true;                   // the first chart draw waits a moment (see render)
  let fresh = true;                       // a new scenario (first load, market, mode, day): animate it in

  // Motion for a new scenario: the headline numbers rise into place and the chart draws in from
  // the left (style.css, "Motion"). Not for slider drags, which re-render every frame.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  function playScenarioMotion() {
    if (reduceMotion.matches) return;
    $("kpis").querySelectorAll(".value").forEach((v, i) => { v.style.setProperty("--i", i); v.classList.add("bump"); });
    const chart = $("chart-main");
    chart.classList.remove("draw-in");
    void chart.offsetWidth;               // restart the animation
    chart.classList.add("draw-in");
    clearTimeout(playScenarioMotion.timer);
    playScenarioMotion.timer = setTimeout(() => chart.classList.remove("draw-in"), 1300);
  }

  // "Agent sees" switch: a pill slides under the selected option. Measured from the buttons, so it
  // follows the font, the language of the labels and the window size.
  function placeSeg() {
    const seg = document.querySelector(".seg");
    const on = seg && seg.querySelector('button[aria-pressed="true"]');
    if (!on || !on.offsetWidth) return;  // hidden (auto-play): placed again when it shows
    seg.style.setProperty("--seg-x", on.offsetLeft + "px");
    seg.style.setProperty("--seg-w", on.offsetWidth + "px");
    if (!seg.classList.contains("has-ind")) {
      seg.classList.add("has-ind");
      requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.add("ind-ready")));
    }
  }

  function render(upto = N) {
    if (!isLoaded(state.p)) {                       // fetch this market's prices first
      const key = state.p;
      document.body.classList.add("loading-data");
      $("source").textContent = `Loading ${REAL[key] ? REAL[key].label : ""} prices…`;
      ensureMarket(key).then(() => {
        document.body.classList.remove("loading-data");
        if (kiosk.on) return;                       // auto-play continues on its own
        scheduleRender();
      }, () => {
        document.body.classList.remove("loading-data");
        toast("Couldn't load the price data. Check the connection and try again.");
        if (state.p === key) { state.p = DEFAULTS.p; state.d = 0; syncControls(); scheduleRender(); }
      });
      return last;
    }
    const r = simulate(state);
    last = r;
    const c = palette();
    renderKpis(r, upto);
    const drawMain = () => {
      if (last !== r) return;              // a newer render (auto-play, a click) has drawn since
      renderMainChart(r, palette(), upto, "chart-main");
      if (fresh && upto === N && !kiosk.on) { fresh = false; playScenarioMotion(); }
      if (!clickBound && $("chart-main").on) { $("chart-main").on("plotly_click", onChartClick); clickBound = true; }
    };
    // On page load the chart is drawn in the next task, so the numbers and text show first and the
    // page isn't blocked for one long stretch on a phone (Plotly's first draw is its slowest).
    if (firstDraw) { firstDraw = false; setTimeout(drawMain, 0); } else drawMain();
    describeMainChart(r);
    renderInsight(r);
    $("source").textContent = sourceText(r);
    renderCompare(r, c);
    drawWhenNear("chart-cum", () => renderCumChart(r, palette()));
    $("lg-forecast").hidden = !r.useForecast;
    $("lg-hind").hidden = !r.useForecast;
    updateOutputs();
    updateDaySelect(r);
    requestAnnual();
    renderAnnual(r);
    renderStack(r);
    renderLifetime(r);
    hideExplain();
    $("solve-time").textContent = `Agent planned ${N} intervals in ${Math.max(1, Math.round(r.ms))} ms`;
    writeState();
    keepInPlace();
    refreshStage();
    return r;
  }

  // The slider being dragged stays where it is on screen. A new value re-renders text above it (the
  // summary under the chart, table notes, and the full-year results a few seconds later), which can
  // grow or shrink by a line; the page scrolls by that amount so the slider never moves under the
  // pointer. The browser's own scroll anchoring is paused meanwhile (older Safari has none, newer
  // browsers would correct a second time), so every browser behaves the same. The hold ends as soon
  // as the visitor scrolls, clicks or types anywhere else, so the page never pulls them back.
  let anchor = null;
  function holdInPlace(el) {
    if (anchor && anchor.el === el) return;
    anchor = { el, top: el.getBoundingClientRect().top };
    document.documentElement.style.overflowAnchor = "none";
  }
  function release() {
    anchor = null;
    document.documentElement.style.overflowAnchor = "";
  }
  function keepInPlace() {
    if (!anchor) return;
    if (kiosk.on || !anchor.el.offsetParent) { release(); return; }
    const shift = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) >= 1) window.scrollBy({ top: shift, behavior: "instant" });
  }
  // Content that changes size outside a render (chart redraws, the full-year progress line) is caught
  // here: the observer runs after layout and before the frame is painted, so nothing visibly jumps.
  if ("ResizeObserver" in window) new ResizeObserver(() => keepInPlace()).observe(document.querySelector("main"));
  const letGo = (e) => { if (anchor && !(e.target && e.target.type === "range")) release(); };
  for (const type of ["wheel", "touchmove", "mousedown", "keydown"]) addEventListener(type, letGo, { capture: true, passive: true });

  // Charts below the fold are drawn when they come near the screen, not during the first render:
  // drawing them up front kept a phone busy for about a quarter of a second before the page responded.
  // Once a chart has been near the screen it is redrawn on every render, like the rest of the page.
  const lazyDraws = new Map();            // chart id -> its latest draw, waiting to be near the screen
  const nearScreen = new Set();
  const lazyIO = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.id;
      nearScreen.add(id);
      lazyIO.unobserve(entry.target);
      const draw = lazyDraws.get(id);
      lazyDraws.delete(id);
      if (draw) draw();
    }
  }, { rootMargin: "600px 0px" }) : null;
  function drawWhenNear(id, draw) {
    if (!lazyIO || nearScreen.has(id)) { lazyDraws.delete(id); draw(); return; }
    if (!lazyDraws.has(id)) lazyIO.observe($(id));
    lazyDraws.set(id, draw);
  }

  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }

  // ------------------------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------------------------
  function setPct(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty("--pct", pct + "%");
  }

  function buildControls() {
    for (const c of CONTROLS) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.id = "field-" + c.key;
      wrap.innerHTML = `
        <label for="in-${c.key}"><span>${c.label}</span><output id="out-${c.key}"></output></label>
        <input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}">`;
      $(c.group ? `${c.group}-controls` : c.main ? "main-controls" : "more-controls").appendChild(wrap);
      if (fieldObserver) fieldObserver.observe(wrap);
      const input = wrap.querySelector("input");
      input.addEventListener("input", () => {
        holdInPlace(input);
        state[c.key] = parseFloat(input.value);
        setPct(input);
        scheduleRender();
      });
    }
    $("sim-chips").innerHTML = Object.entries(SIM)
      .map(([k, s]) => `<button type="button" class="chip" data-key="${k}">${s.label}</button>`).join("");
    buildRealChips();
    for (const id of ["sim-chips", "real-chips"]) {
      $(id).addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) selectMarket(b.dataset.key); });
    }
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  }

  function buildRealChips() {
    const entries = Object.entries(REAL).map(([k, m]) => [k, m.label]);
    if (uploaded) entries.push(["upload", "Your data"]);
    $("real-chips").innerHTML = entries
      .map(([k, label]) => `<button type="button" class="chip" data-key="${k}">${esc(label)}</button>`).join("");
  }

  // Slider values change length as they move ("none" -> "$40 per kW per year"). Each value keeps the
  // width of its longest possible text, so its label never re-wraps and the slider never moves up or
  // down while it is dragged. A field too narrow for name and value side by side gives the value a
  // line of its own (.stacked), whatever the value.
  const measure = document.createElement("canvas").getContext("2d");
  let fittedFor = "";
  function fitOutputs(force) {
    const cs = getComputedStyle($("out-cap"));
    const key = CUR + cs.fontWeight + cs.fontSize + cs.fontFamily;
    if (!force && key === fittedFor) return;
    fittedFor = key;
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    for (const c of CONTROLS) {
      const n = Math.round((c.max - c.min) / c.step);
      const every = Math.max(1, Math.ceil(n / 400));
      const texts = c.simOnly ? ["real data"] : [];
      for (let i = 0; i <= n; i += every) texts.push(c.fmt(+(c.min + i * c.step).toFixed(6)));
      texts.push(c.fmt(c.max));
      const widest = Math.max(...texts.map((t) => measure.measureText(t).width));
      $("out-" + c.key).style.minWidth = Math.ceil(widest * 1.06 + 2) + "px";   // + room for tabular digits
    }
    document.querySelectorAll(".field").forEach(stackIfNarrow);
  }
  function stackIfNarrow(field) {
    const width = field.clientWidth;
    if (!width) return;                   // hidden (closed settings, section not shown yet): done when it appears
    field.classList.toggle("stacked", parseFloat(field.querySelector("output").style.minWidth) > width * 0.5);
  }
  const fieldObserver = "ResizeObserver" in window
    ? new ResizeObserver((entries) => entries.forEach((e) => stackIfNarrow(e.target))) : null;

  function updateOutputs() {
    fitOutputs();
    for (const c of CONTROLS) {
      const disabled = !!(c.simOnly && !SIM[state.p]);
      $("in-" + c.key).disabled = disabled;
      $("field-" + c.key).classList.toggle("disabled", disabled);
      $("out-" + c.key).textContent = disabled ? "real data" : c.fmt(state[c.key]);
    }
  }

  function syncControls() {
    for (const c of CONTROLS) {
      const input = $("in-" + c.key);
      input.value = state[c.key];
      setPct(input);
    }
    document.querySelectorAll(".chip[data-key]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === state.p)));
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
    placeSeg();
    updateOutputs();
  }

  function selectMarket(key) {
    fresh = true;
    state.p = key;
    state.d = SIM[key] ? 0 : defaultDay(key);
    if (SIM[key]) { state.seed = SIM[key].seed; state.vol = SIM[key].volatility; }
    Object.assign(state, streamDefaults(key, state));
    syncControls();
    scheduleRender();
  }

  function setMode(mode) {
    fresh = true;
    state.mode = mode;
    syncControls();
    scheduleRender();
  }

  function newDay() {
    fresh = true;
    if (SIM[state.p]) {
      state.seed = Math.floor(Math.random() * 100000);
      toast("New simulated market");
    } else {
      state.d = (state.d + 1) % dayCount(realMarket(state.p));
    }
    scheduleRender();
  }

  function toast(msg, ms = 2000) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), ms);
  }

  async function share() {
    const url = location.href;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "AI Grid Trader", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(state.p === "upload" ? "Link copied (uploaded data isn't included in links)" : "Link to this scenario copied");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      window.prompt("Copy this link:", url);
    }
  }

  // Full screen, including Safari/iPadOS (webkit-prefixed API). iPhone has none: Present still works,
  // as a full-window walkthrough.
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const fsRequest = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  const fsExit = () => (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  function fsEnter() {
    if (!fsRequest || fsElement()) return;
    stage.fs = true;
    const p = fsRequest.call(document.documentElement);
    if (p && p.catch) p.catch(() => { stage.fs = false; });
  }

  // ------------------------------------------------------------------------------------
  // Presenter mode: the demo as a short full-screen walkthrough, for talking someone through it.
  // Next: → ↓ Page Down Space Enter (what presentation clickers send). Back: ← ↑ Page Up.
  // 1–7 switch market, T theme, F full screen, Esc leaves. The trades step plays the 48 hours in
  // stages: up to the first buy, then the first sell (each explained), then the rest.
  // Large type, no settings, the chart fills the screen: readable from across a table.
  // ------------------------------------------------------------------------------------
  const STAGE_LABELS = { market: "The market", trades: "What the AI does", result: "The result",
    year: "A full year", life: "Over its lifetime", contact: "Thank you" };
  const stage = { on: false, i: 0, name: "market", sub: 0, steps: [], marks: [N], upto: 0, timer: 0, token: 0, key: "", fs: false, ownExit: false };
  const stageKey = () => [state.p, state.d, state.seed, state.mode, uploaded ? uploaded.name : ""].join("|");
  const timesWord = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
  const unitPrice = (v) => `${v < 0 ? "−" : ""}${CUR}${Math.round(Math.abs(v)).toLocaleString("en-US")}`;

  function stageSteps(r) {
    const year = r.mk.real && hasYearData(state.p);
    return ["market", "trades", "result", ...(year ? ["year"] : []), ...(r.stack || year ? ["life"] : []), "contact"];
  }

  // The trades step's stops: the first buy, the first sell after it, then the end of the 48 hours.
  function stageMarks(r) {
    const starts = tradeStarts(r);
    const buy = starts.find((t) => r.ai.modes[t] === CHARGE);
    const sell = starts.find((t) => r.ai.modes[t] === DISCHARGE && (buy == null || t > buy));
    return [buy, sell].filter((t) => t != null).sort((a, b) => a - b).concat(N);
  }

  function marketOptions() {
    return kioskQueue().map((k, n) =>
      `<option value="${k}">${n + 1}. ${esc((SIM[k] || REAL[k]).label)}${REAL[k] ? " (real prices)" : ""}</option>`).join("")
      + (uploaded ? `<option value="upload">Your data</option>` : "");
  }

  function openStage() {
    if (stage.on || !last) return;
    if (kiosk.on) stopKiosk();
    hideExplain();
    stage.on = true;
    if (state.mode !== "forecast") { state.mode = "forecast"; syncControls(); render(); }   // the realistic story
    Object.assign(stage, { i: 0, name: "market", sub: 0, upto: 0, key: stageKey(), openKey: stageKey(), fs: false });
    document.body.classList.add("presenting");
    for (const el of document.querySelectorAll("body > header, body > main, body > footer")) el.inert = true;
    $("stage-market").innerHTML = marketOptions();
    $("stage").hidden = false;
    fsEnter();
    $("stage").focus({ preventScroll: true });
    renderStage(1, true);
  }

  function closeStage() {
    if (!stage.on) return;
    stage.on = false;
    clearTimeout(stage.timer);
    for (const el of $("stage").querySelectorAll(".js-plotly-plot")) Plotly.purge(el);
    $("stage-slide").innerHTML = "";
    $("stage").hidden = true;
    document.body.classList.remove("presenting");
    for (const el of document.querySelectorAll("body > header, body > main, body > footer")) el.inert = false;
    if (stage.fs && fsElement()) { stage.ownExit = true; fsExit(); }
    stage.fs = false;
    if (stageKey() !== stage.openKey) { syncControls(); scheduleRender(); }   // a market chosen while presenting
    $("btn-present").focus({ preventScroll: true });
  }

  function stageGo(i, dir, atEnd) {
    stage.i = Math.max(0, Math.min(stage.steps.length - 1, i));
    stage.name = stage.steps[stage.i];
    if (stage.name === "trades") {
      stage.sub = atEnd ? stage.marks.length - 1 : 0;
      stage.upto = atEnd ? N : 0;
    }
    renderStage(dir, !atEnd);
  }
  function stageNext() {
    if (stage.name === "trades" && stage.sub < stage.marks.length - 1) { stage.sub++; updateTrades(true); }
    else if (stage.i < stage.steps.length - 1) stageGo(stage.i + 1, 1);
    else closeStage();
  }
  function stagePrev() {
    if (stage.name === "trades" && stage.sub > 0) { stage.sub--; updateTrades(false); }
    else if (stage.i > 0) stageGo(stage.i - 1, -1, true);
  }

  // After each render of the page: a new market starts its walkthrough again at the same step; the
  // full-year results arriving fill in the steps waiting for them.
  function refreshStage() {
    if (!stage.on || !last) return;
    if (stageKey() !== stage.key) {
      stage.key = stageKey();
      stage.sub = 0; stage.upto = 0;
      const steps = stageSteps(last);
      stage.i = Math.max(0, steps.indexOf(stage.name));
      stage.name = steps[stage.i];
      renderStage(1, true);
    } else if (stage.name === "year" || stage.name === "life") {
      const ready = stage.name === "year" ? !!last.year : !!(last.stack && last.life);
      if (ready !== !$("stage-progress")) renderStage(0, false, true);   // was waiting: show the results
    }
  }

  const stageKpis = (list, cls = "") => `<div class="stage-kpis ${cls}">${list.map((k) =>
    `<div class="stage-kpi"><div class="label">${k.label}</div><div class="value ${k.cls || ""}" data-final="${esc(k.value)}">${k.value}</div></div>`).join("")}</div>`;

  function legendHtml(...items) {
    return `<div class="stage-legend" aria-hidden="true">${items.map(([label, color, kind]) =>
      `<span><i class="sw sw-${kind}" style="--sw:${color}"></i>${label}</span>`).join("")}</div>`;
  }
  const pendingHtml = () => `<div class="stage-pending"><span class="spinner" aria-hidden="true"></span><span id="stage-progress">${annualProgressText()}</span></div>`;
  const annualProgressText = () => `Simulating every hour of the year… ${annualJob ? Math.round((annualJob.progress || 0) * 100) : 0}%`;

  // Charts on the stage are read from across a room: larger text.
  function bigFont(id) {
    const div = $(id);
    if (div && div.layout) return Plotly.relayout(div, { "font.size": 16, "hoverlabel.font.size": 16, "xaxis.title.text": "" });
  }

  // Builds the step on screen. dir: 1 forward, -1 back, 0 in place. play: replay the trades.
  function renderStage(dir, play, count) {
    const r = last, c = palette();
    clearTimeout(stage.timer);
    stage.steps = stageSteps(r);
    stage.marks = stageMarks(r);
    stage.i = Math.min(stage.i, stage.steps.length - 1);
    stage.name = stage.steps[stage.i];
    stage.sub = Math.min(stage.sub, stage.marks.length - 1);
    const step = stage.name, last1 = stage.i === stage.steps.length - 1;
    for (const el of $("stage-slide").querySelectorAll(".js-plotly-plot")) Plotly.purge(el);

    $("stage-market").value = state.p;
    $("stage-dots").innerHTML = stage.steps.map((s, n) =>
      `<li><button type="button" class="stage-dot" data-i="${n}" aria-label="Step ${n + 1}: ${STAGE_LABELS[s]}"${n === stage.i ? ' aria-current="step"' : ""}><span>${STAGE_LABELS[s]}</span></button></li>`).join("");
    $("stage-count").textContent = `${stage.i + 1} / ${stage.steps.length}`;
    $("stage-prev").disabled = stage.i === 0;
    $("stage-next").querySelector(".lbl").textContent = last1 ? "Finish" : "Next";

    const where = r.mk.real ? r.mk.label : `a simulated market (${r.mk.label.toLowerCase()})`;
    let title = "", sub = "", body = "", after = null;

    if (step === "market") {
      const lo = Math.min(...r.prices), hi = Math.max(...r.prices);
      title = `Electricity prices in ${esc(where)} swung from ${unitPrice(lo)} to ${unitPrice(hi)} per MWh in two days.`;
      sub = "A battery earns by charging when power is cheap and plentiful and selling when it is scarce. Every cycle wears it out a little, and that wear has a price.";
      body = legendHtml(["Price", c.price, "line"], ...(r.forecast ? [["The AI's forecast", c.forecast, "dash"]] : []))
        + `<div class="stage-chart" id="stage-chart-a"></div>`;
      after = () => renderMainChart(r, c, 0, "stage-chart-a", { big: true, pricesOnly: true });
    } else if (step === "trades") {
      title = "&nbsp;";
      body = legendHtml(["Price", c.price, "line"], ["Battery charge", c.soc, "area"], ["Buys", c.charge, "up"], ["Sells", c.discharge, "down"])
        + `<div class="stage-split"><div class="stage-chart" id="stage-chart-a"></div>
          <aside class="stage-side"><div id="stage-ticker"></div><div class="stage-callout" id="stage-callout" aria-live="polite" hidden></div></aside></div>`;
      after = () => updateTrades(play);
    } else if (step === "result") {
      const k = kpiList(r, N);
      title = r.ai.net >= 0 ? `${money(r.ai.net)} profit in 48 hours, after battery wear.` : `${money(r.ai.net)} over 48 hours, after battery wear.`;
      sub = `${signedMoney(r.ai.net - r.bot.net)} compared with a rule-based bot trading the same prices`
        + (r.captured != null ? `, and ${Math.round(r.captured)}% of the most any strategy could earn knowing every price in advance.` : ".");
      body = stageKpis(k.slice(0, 4))
        + legendHtml(["AI agent", c.ink, "line"], ...(r.useForecast ? [["Perfect hindsight", c.soc, "dash"]] : []), ["Rule-based bot", c.bot, "dot"])
        + `<div class="stage-chart" id="stage-chart-a"></div>`;
      after = () => { renderCumChart(r, c, "stage-chart-a"); bigFont("stage-chart-a"); };
    } else if (step === "year") {
      const y = r.year, m = r.mk.meta;
      if (!y) {
        title = `Next: every hour of ${m.year || "the year"} in ${esc(r.mk.label)}.`;
        sub = "The same agent, re-planning every hour on a forecast, through a full year of real prices.";
        body = pendingHtml();
      } else {
        const s = y.scale, net = y.ai.net * s, roi = (net / r.capex) * 100;
        const pct = y.hind.net > 1 ? Math.round((y.ai.net / y.hind.net) * 100) : null;
        const days = Math.floor(m.prices.length / STEPS_PER_DAY);
        title = `${money(net)} net revenue ${days >= 365 ? `in ${m.year || "a year"}` : "a year"} in ${esc(r.mk.label)}, on real prices.`;
        sub = `Re-planning every hour on a forecast, the agent earns ${pct == null ? "" : `${pct}% of the hindsight maximum and `}${signedMoney((y.ai.net - y.bot.net) * s)} more than the rule-based bot`
          + (days < 365 ? ` (scaled from ${days} days).` : ".");
        body = stageKpis([
          { label: "Net revenue in the year", value: money(net), cls: net < 0 ? "neg" : "" },
          { label: "vs. rule-based bot", value: signedMoney((y.ai.net - y.bot.net) * s), cls: y.ai.net >= y.bot.net ? "pos" : "neg" },
          { label: "Of hindsight maximum", value: pct == null ? "—" : `${pct}%` },
          { label: "Annual return on investment", value: `${roi.toFixed(1)}%`, cls: roi < 0 ? "neg" : "" },
        ]) + legendHtml(["AI net revenue per month", c.ink, "bar"], ["Hindsight maximum", c.soc, "dash"])
          + `<div class="stage-chart" id="stage-chart-a"></div>`;
        after = () => renderMonthlyChart(y, c, "stage-chart-a").then(() => bigFont("stage-chart-a"));
      }
    } else if (step === "life") {
      if (!r.stack || !r.life) {
        title = `Next: ${state.life} years of cash flow, with real battery wear.`;
        sub = "This builds on the full-year results.";
        body = pendingHtml();
      } else {
        const { ai, bot } = r.life;
        const cyc = Math.round(r.stack.cycles);
        const yrs = (v) => (v == null ? "—" : `${v.toFixed(1)} yrs`);
        title = `${money(ai.npv)} lifetime value over ${state.life} years.`;
        sub = `The AI uses ${cyc} cycles a year and ${ai.augments ? `needs new cells ${timesWord(ai.augments)}` : "never needs new cells"}; the rule-based bot ${bot.augments ? `needs them ${timesWord(bot.augments)}` : "never needs them"}`
          + (bot.augTotal > ai.augTotal ? `, costing ${money(bot.augTotal - ai.augTotal)} more in replacement cells.` : ".");
        body = stageKpis([
          { label: `Net present value at ${state.disc}%`, value: money(ai.npv), cls: ai.npv < 0 ? "neg" : "pos" },
          { label: "Internal rate of return", value: ai.irr == null ? "—" : `${(ai.irr * 100).toFixed(1)}%` },
          { label: "Payback", value: yrs(ai.payback) },
          { label: "New cells needed", value: ai.augments ? `${ai.augments}×` : "none" },
        ]) + legendHtml(["AI agent", c.ink, "line"], ["Rule-based bot", c.bot, "dot"])
          + `<div class="stage-split stage-split-even">
            <figure class="stage-fig"><figcaption>Battery health, by year</figcaption><div class="stage-chart" id="stage-chart-a"></div></figure>
            <figure class="stage-fig"><figcaption>Cumulative cash flow, by year</figcaption><div class="stage-chart" id="stage-chart-b"></div></figure>
          </div>`;
        after = () => renderLifeCharts(r, ai, bot, c, "stage-chart-a", "stage-chart-b").then(() => Promise.all([bigFont("stage-chart-a"), bigFont("stage-chart-b")]));
      }
    } else {
      title = `Thank you. I'm ${OWNER.name}.`;
      sub = "Computer Science student at North American University, focused on renewable energy. I'm looking for a summer 2027 internship in energy software, and glad to answer questions about AI Grid Trader.";
      body = `<div class="stage-contact">
          <div class="stage-qr"><img src="assets/img/qr-case-study.svg" alt="QR code for the AI Grid Trader case study" width="200" height="200">
            <b>Read the case study</b><span>baizakisaev.com/ai-grid-trader-case-study</span></div>
          <div class="stage-qr"><img src="assets/img/qr-linkedin.svg" alt="QR code for Baizak Isaev's LinkedIn" width="200" height="200">
            <b>Connect on LinkedIn</b><span>${OWNER.linkedin}</span></div>
          <div class="stage-reach"><span class="label">Email</span><b>${esc(OWNER.email)}</b>
            <span class="label">Website</span><b>baizakisaev.com</b></div>
        </div>`;
    }

    const slide = $("stage-slide");
    slide.dataset.step = step;
    slide.innerHTML = `<p class="stage-kicker">${step === "contact" ? "" : `${stage.i + 1} · `}${STAGE_LABELS[step]}</p>
      <h2 class="stage-title" id="stage-title">${title}</h2>
      <p class="stage-sub" id="stage-sub"${sub ? "" : " hidden"}>${sub}</p>
      <div class="stage-body">${body}</div>`;
    if (dir) {
      slide.classList.remove("in-next", "in-prev");
      void slide.offsetWidth;             // restart the entrance
      slide.classList.add(dir > 0 ? "in-next" : "in-prev");
      $("stage-status").textContent = `Step ${stage.i + 1} of ${stage.steps.length}: ${STAGE_LABELS[step]}. ${slide.querySelector(".stage-title").textContent}`;
    }
    if (dir || count) countUp(slide);
    // After layout, so the charts take their full size; skipped if the step changed meanwhile.
    const token = ++stage.token;
    if (after) requestAnimationFrame(() => { if (stage.on && stage.token === token) after(); });
  }

  // Trades step: the title, the running totals, the chart up to `stage.upto` and the "why" card.
  function updateTrades(play) {
    const r = last, key = stage.key;
    const mark = stage.marks[stage.sub], t = mark === N ? null : mark;
    const target = t == null ? N : t + 1;
    const n = tradeStarts(r).length;
    const buy = t != null && r.ai.modes[t] === CHARGE;
    $("stage-title").textContent = t == null
      ? (n ? `${n} trades in 48 hours: ${money(r.ai.net)} profit after battery wear.` : "No trade was worth the battery wear in these 48 hours.")
      : buy ? "It buys when power is cheap…" : "…and sells when it is scarce.";
    const sub = $("stage-sub");
    sub.hidden = false;
    sub.textContent = t == null
      ? `${signedMoney(r.ai.net - r.bot.net)} compared with a rule-based bot on the same prices.`
      : "Every 15 minutes it decides to buy, sell or wait. It never sees the real future, only a forecast, and re-plans every hour.";
    $("stage-prev").disabled = stage.i === 0 && stage.sub === 0;
    const box = $("stage-callout");
    box.hidden = true;

    const draw = () => {
      renderMainChart(r, palette(), stage.upto, "stage-chart-a", { big: true });
      const done = tradeStarts(r).filter((s) => s < stage.upto).length;
      const k = kpiList(r, stage.upto);
      $("stage-ticker").innerHTML = stageKpis([
        { ...k[0], label: stage.upto >= N ? "Net profit, 48 hours" : "Net profit so far" },
        { ...k[1], label: stage.upto >= N ? "vs. rule-based bot" : "vs. rule-based bot so far" },
        { label: stage.upto >= N ? "Trades" : "Trades so far", value: String(done) },
      ], "stage-kpis-stack");
    };
    const finish = () => {
      stage.upto = target;
      draw();
      if (t != null) { box.innerHTML = tradeCallout(r, t); box.hidden = false; }
    };
    clearTimeout(stage.timer);
    if (!play || reduceMotion.matches || stage.upto >= target) { finish(); return; }
    const tick = () => {
      if (!stage.on || stage.key !== key || stage.name !== "trades") return;
      stage.upto = Math.min(target, stage.upto + 2);
      if (stage.upto >= target) { finish(); return; }
      draw();
      stage.timer = setTimeout(tick, 30);
    };
    draw();
    stage.timer = setTimeout(tick, 350);
  }

  // The "why" card for one trade, in a few large lines (the page's "Why this trade?" has the detail).
  function tradeCallout(r, t) {
    const x = E.explainTrade(r.prices, r.w, tradingBattery(state), t);
    if (!x) return "";
    const at = (i) => fmtClock(parseNaive(r.X[i]));
    const buy = x.kind === "buy";
    const why = buy
      ? (x.expected ? `Its forecast says it can sell this energy for about <b>${unitPrice(x.expected.price)}</b> ${at(x.expected.from)}.`
        : "It tops the battery up so it ends the two days as full as it started.")
      : x.bought ? `It bought this energy for about <b>${unitPrice(x.bought.price)}</b> ${at(x.bought.from)}.`
      : x.rebuy ? `It can refill for about <b>${unitPrice(x.rebuy.price)}</b> ${at(x.rebuy.from)}, so selling now pays.`
      : "It sells energy that was already in the battery.";
    const margin = x.margin == null ? ""
      : `<p class="stage-margin"><b class="${x.margin >= 0 ? "pos" : "neg"}">${x.margin >= 0 ? "+" : "−"}${unitPrice(Math.abs(x.margin))}</b> per MWh ${buy ? "expected margin" : "margin"}, after losses and ${unitPrice(x.wearRound)} of battery wear</p>`;
    return `<p class="stage-callout-kicker"><i class="sw sw-${buy ? "up" : "down"}" style="--sw:${buy ? palette().charge : palette().discharge}"></i>Why this trade? · ${at(t)}</p>
      <p class="stage-callout-lead">${buy ? "Buys" : "Sells"} ${x.mw.toFixed(0)} MW at ${unitPrice(x.price)}/MWh</p>
      <p class="stage-why">${why}</p>${margin}`;
  }

  // Headline numbers count up when a step opens. The exact text is put back at the end.
  function countUp(root) {
    if (reduceMotion.matches) return;
    for (const el of root.querySelectorAll(".stage-kpis:not(.stage-kpis-stack) .value")) {
      const final = el.dataset.final;
      const m = final.match(/^([^\d]*)([\d,]+(?:\.\d+)?)(.*)$/);
      if (!m) continue;
      const target = parseFloat(m[2].replace(/,/g, ""));
      const decimals = (m[2].split(".")[1] || "").length;
      const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      const start = performance.now(), dur = 1000;
      const tick = (now) => {
        if (!el.isConnected) return;
        const k = Math.min(1, (now - start) / dur);
        el.textContent = k === 1 ? final : m[1] + fmt.format(target * (1 - Math.pow(2, -10 * k))) + m[3];
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  function onStageKey(e) {
    if (!stage.on || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === "SELECT" && e.key !== "Escape") return;        // the market list uses its own keys
    if (tag === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;   // the focused button clicks
    let handled = true;
    if (/^(ArrowRight|ArrowDown|PageDown| |Enter)$/.test(e.key)) stageNext();
    else if (/^(ArrowLeft|ArrowUp|PageUp|Backspace)$/.test(e.key)) stagePrev();
    else if (e.key === "Home") stageGo(0, -1);
    else if (e.key === "End") stageGo(stage.steps.length - 1, 1);
    else if (e.key === "Escape") closeStage();
    else if (/^[1-9]$/.test(e.key) && kioskQueue()[+e.key - 1]) selectMarket(kioskQueue()[+e.key - 1]);
    else if (/^t$/i.test(e.key)) window.Site.toggleTheme();
    else if (/^f$/i.test(e.key) && fsRequest) {
      if (fsElement()) { stage.ownExit = true; stage.fs = false; fsExit(); } else fsEnter();
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  // Leaving full screen with the browser's own Esc (pages don't receive that key) ends the walkthrough.
  function onFullscreenChange() {
    if (stage.ownExit) { stage.ownExit = false; return; }
    if (stage.on && stage.fs && !fsElement()) { stage.fs = false; closeStage(); }
  }

  function bindStage() {
    $("btn-present").addEventListener("click", openStage);
    $("stage-close").addEventListener("click", closeStage);
    $("stage-prev").addEventListener("click", stagePrev);
    $("stage-next").addEventListener("click", stageNext);
    $("stage-dots").addEventListener("click", (e) => {
      const b = e.target.closest(".stage-dot");
      if (b && +b.dataset.i !== stage.i) stageGo(+b.dataset.i, +b.dataset.i > stage.i ? 1 : -1);
    });
    $("stage-market").addEventListener("change", (e) => { selectMarket(e.target.value); $("stage").focus({ preventScroll: true }); });
    document.addEventListener("keydown", onStageKey, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }

  // ------------------------------------------------------------------------------------
  // Light / dark
  // ------------------------------------------------------------------------------------
  // The switch itself lives in site.js (shared with the home page); the charts are drawn in
  // JavaScript, so they are redrawn here in the new colours.
  function onThemeChange() {
    // Let the browser paint the new colours first, then redraw the charts (that can take a moment).
    requestAnimationFrame(() => setTimeout(() => {
      if (kiosk.on) renderMainChart(last, palette(), kiosk.t, "chart-main");
      else scheduleRender();
      if (stage.on) renderStage(0, true);
    }, 0));
  }

  // ------------------------------------------------------------------------------------
  // Kiosk / auto-play: loops every market, replaying the AI's decisions in time.
  // ?kiosk=1 starts it on load and restarts it after 60 s without interaction.
  // ------------------------------------------------------------------------------------
  const kiosk = { on: false, timer: 0, idle: 0, i: 0, t: N, auto: new URLSearchParams(location.search).has("kiosk") };
  const kioskQueue = () => [...Object.keys(SIM), ...Object.keys(REAL)];

  function updateBanner(r, t) {
    const at = r.X[Math.max(0, t - 1)];
    $("kb-status").innerHTML = `
      <span class="kb-live"><span class="live"></span>Auto-play</span>
      <span class="kb-market">${esc(r.mk.label)} · ${r.mk.real ? "real prices" : "simulated"}</span>
      <span class="kb-time">${t >= N ? "48 hours done" : fmtClock(parseNaive(at))}</span>
      <span class="kb-hint">Tap anywhere to explore</span>`;
  }

  function playNextMarket() {
    if (!kiosk.on) return;
    const q = kioskQueue();
    const key = q[kiosk.i % q.length];
    if (!isLoaded(key)) {                            // load a real market's prices, then play it
      ensureMarket(key).then(playNextMarket, () => { kiosk.i++; playNextMarket(); });
      return;
    }
    kiosk.i++;
    state.p = key; state.d = SIM[key] ? 0 : defaultDay(key); state.mode = "forecast";
    if (SIM[key]) { state.seed = SIM[key].seed; state.vol = SIM[key].volatility; }
    syncControls();
    kiosk.t = 0;
    const r = render(0);
    Plotly.Plots.resize("chart-main");          // the kiosk layout gives the chart a new size
    updateBanner(r, 0);
    const tick = () => {
      if (!kiosk.on) return;
      kiosk.t = Math.min(N, kiosk.t + 2);
      renderMainChart(r, palette(), kiosk.t, "chart-main");
      renderKpis(r, kiosk.t);
      updateBanner(r, kiosk.t);
      kiosk.timer = setTimeout(kiosk.t < N ? tick : playNextMarket, kiosk.t < N ? 90 : 6000);
    };
    kiosk.timer = setTimeout(tick, 1200);
  }

  function startKiosk() {
    if (kiosk.on || stage.on) return;
    kiosk.on = true;
    document.body.classList.add("kiosk");
    window.scrollTo({ top: 0 });
    kiosk.i = Math.max(0, kioskQueue().indexOf(state.p));
    playNextMarket();
  }

  function stopKiosk() {
    if (!kiosk.on) return;
    kiosk.on = false;
    clearTimeout(kiosk.timer);
    kiosk.t = N;
    document.body.classList.remove("kiosk");
    render();
    placeSeg();
    Plotly.Plots.resize("chart-main");
  }

  function armIdle() {
    if (!kiosk.auto) return;
    clearTimeout(kiosk.idle);
    kiosk.idle = setTimeout(startKiosk, 60000);
  }

  // ------------------------------------------------------------------------------------
  // Business case PDF: fills a print-only page, then opens the print dialog
  // ------------------------------------------------------------------------------------
  const FIELDS = ["client", "project", "author", "contact"];
  // Owner details for the business-case PDF (the address is assembled in site.js).
  const OWNER = { name: "Baizak Isaev", email: window.Site.email, linkedin: "linkedin.com/in/baizakisaev" };

  function openReportDialog() {
    const dlg = $("report-dialog");
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("agt-report") || "{}"); } catch (e) { saved = {}; }
    const defaults = { author: saved.author || OWNER.name, contact: saved.contact || OWNER.email };
    for (const f of ["author", "contact"]) if (!dlg.querySelector(`[name=${f}]`).value) dlg.querySelector(`[name=${f}]`).value = defaults[f];
    if (typeof dlg.showModal === "function") dlg.showModal();
    else createReport({});
  }

  async function createReport(fields) {
    const r = last;
    const c = PALETTES.light;
    // Draw a light-theme chart off screen and turn it into an image: the monthly results when a
    // full-year simulation exists, otherwise the 48-hour dispatch.
    const tmp = document.createElement("div");
    tmp.style.cssText = "position:fixed;left:-12000px;top:0;width:1000px;height:400px;";
    document.body.appendChild(tmp);
    let img = "";
    try {
      if (r.year) {
        await renderMonthlyChart(r.year, c, tmp, true);
      } else {
        await renderMainChart(r, c, N, tmp);
        await Plotly.relayout(tmp, { font: { family: "Helvetica, Arial, sans-serif", size: 12, color: c.muted }, "xaxis.tickformat": "%a %d %b %H:%M" });
      }
      img = await Plotly.toImage(tmp, { format: "png", width: 1000, height: r.year ? 340 : 400, scale: 2 });
    } finally {
      Plotly.purge(tmp);
      tmp.remove();
    }
    $("report").innerHTML = reportHtml(r, fields, img);
    const pic = $("report").querySelector("img");
    if (pic && pic.decode) { try { await pic.decode(); } catch (e) { /* print anyway */ } }
    window.print();
  }

  function reportHtml(r, f, img) {
    const today = new Date();
    const dateStr = `${today.getDate()} ${MO[today.getMonth()]} ${today.getFullYear()}`;
    const y = r.year;
    const m = r.mk.meta;
    const days = y ? y.days : 2;
    const period = !r.mk.real
      ? `Simulated market (“${esc(r.mk.label)}” scenario), 48 hours`
      : y ? `${esc(m.name)}, ${fmtDay(parseNaive(m.start))} – ${fmtDay(parseNaive(m.start) + (days - 1) * DAY_MS)} (${days} days, ${esc(m.tz)})`
          : `${esc(m.name)}, ${fmtDay(r.mk.startMs)} – ${fmtDay(r.mk.startMs + DAY_MS)}`;
    const source = r.mk.real ? esc(m.source) : "Simulated prices";
    const agent = r.useForecast
      ? `Forecast-driven: ±${state.fe}% forecast error, re-planned every hour${y ? " with a 24-hour look-ahead" : ""}`
      : "Perfect hindsight (theoretical maximum)";
    const kpi = (label, value, sub) => `<div class="rp-kpi"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
    const payback = r.annual > 0 ? `${(r.capex / r.annual).toFixed(1)}-year payback` : "no payback at these settings";
    let kpis, table, chartTitle, legend;
    if (y) {
      const s = y.scale;
      kpis = kpi(days >= 365 ? `Net revenue, ${m.year || "full year"}` : "Net revenue per year", money(y.ai.net * s), "after battery wear")
        + kpi("Annual ROI", `${r.roi.toFixed(1)}%`, payback)
        + kpi("Of the hindsight maximum", y.hind.net > 1 ? `${Math.round((y.ai.net / y.hind.net) * 100)}%` : "—", `max: ${money(y.hind.net * s)}`)
        + kpi("Cycles per year", Math.round(y.ai.cycles * s), `rule-based bot: ${Math.round(y.bot.cycles * s)}`);
      table = annualRows(y);
      chartTitle = `Monthly net revenue${days >= 365 && m.year ? ", " + m.year : ""}`;
      legend = "Black bars: AI agent · blue dashed: perfect-hindsight maximum.";
    } else {
      const k = kpiList(r);
      kpis = kpi("Net profit over 48 hours", k[0].value, "after battery wear")
        + kpi("Annualised net revenue", money(r.annual), "48 hours × 182.5")
        + kpi("Estimated annual ROI", `${r.roi.toFixed(1)}%`, payback)
        + kpi("Of the hindsight maximum", k[2].value, `vs. rule-based bot: ${k[1].value}`);
      table = compareRows(r);
      chartTitle = "48-hour dispatch";
      legend = `Orange: actual price${r.forecast ? " · grey dashed: forecast at start" : ""} · blue area: battery charge (right axis) · green ▲ buy · red ▼ sell.`;
    }
    const rows = table.map(([name, a, h, b]) => `<tr><td>${name}</td><td><b>${a}</b></td><td>${h}</td><td>${b}</td></tr>`).join("");
    const asset = [
      ["Energy capacity", `${state.cap} MWh`],
      ["Power rating", `${state.pw} MW (${(state.cap / state.pw).toFixed(1)}-hour)`],
      ["Round-trip efficiency", `${state.eff}%`],
      ["Operating charge window", `${state.lo}% – ${state.hi}%`],
      ["Wear cost per full cycle", money(state.wear)],
      ["Installed cost", `${CUR}${state.capex}/kWh (${money(r.capexGross)} total)`],
      ...(state.itc ? [["After tax credit", `${state.itc}% credit: ${money(r.capex)} net`]] : []),
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
    const contactLine = [f.author, f.contact].filter(Boolean).map(esc).join(" · ");
    let streamsHtml = "";
    if (r.stack) {
      const st = r.stack, lifeAi = E.lifetime(lifeInputs(r, "ai")), lifeBot = E.lifetime(lifeInputs(r, "bot"));
      const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
      const yrsTxt = (v) => (v == null ? `not within ${state.life} years` : `${v.toFixed(1)} years`);
      const streamRows = [
        ["Energy trading (after wear)", money(st.energy)],
        [`Grid services (${st.reservedMW.toFixed(1)} MW at ${CUR}${state.svc}/MW·h)`, money(st.services)],
        [`Capacity payments (${CUR}${state.capp}/kW·yr)`, money(st.capacity)],
        ["<b>Total per year</b>", `<b>${money(st.total)}</b>`],
      ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
      const lifeRows = [
        [`Lifetime value (NPV, ${state.life} yrs at ${state.disc}%)`, `<b>${money(lifeAi.npv)}</b>`, money(lifeBot.npv)],
        ["Internal rate of return", pct(lifeAi.irr), pct(lifeBot.irr)],
        ["Payback", yrsTxt(lifeAi.payback), yrsTxt(lifeBot.payback)],
        ["Cycles per year", Math.round(st.cycles), Math.round(st.botCycles)],
        ["New cells needed", `${lifeAi.augments}×`, `${lifeBot.augments}×`],
      ].map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join("");
      streamsHtml = `
      <div class="rp-cols">
        <div><h3>Revenue streams per year</h3><table class="rp-table"><tbody>${streamRows}</tbody></table></div>
        <div><h3>Over the project life</h3><table class="rp-table"><thead><tr><th></th><th>AI</th><th>Rule-based bot</th></tr></thead><tbody>${lifeRows}</tbody></table></div>
      </div>`;
    }
    const annualNote = y
      ? (days >= 365
        ? "Annual figures come from operating the battery through every hour of the year on actual prices; past prices don't guarantee future revenue."
        : `Annual figures are scaled from ${days} days of prices; real revenue varies with season and market conditions.`)
      : "Annual figures scale a 48-hour result to a year; real revenue varies with season and market conditions.";
    return `
      <div class="rp-head">
        <div>
          <div class="rp-kicker">Battery trading business case</div>
          <div class="rp-title">${f.client ? "Prepared for " + esc(f.client) : "AI battery trading: what it earns"}</div>
          <div>${f.project ? esc(f.project) : `${state.cap} MWh / ${state.pw} MW battery`}</div>
        </div>
        <div class="rp-meta"><div class="rp-brand"><svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M13.5 2 5 14h5.5L9 22l8.5-12H12z" fill="currentColor"/></svg> AI Grid Trader</div>${dateStr}${contactLine ? "<br>" + contactLine : ""}</div>
      </div>
      <div class="rp-kpis">${kpis}</div>
      <h3>${chartTitle}</h3>
      <img class="rp-chart" src="${img}" alt="${chartTitle}">
      <div class="rp-legend">${legend}</div>
      <div class="rp-cols">
        <div>
          <h3>${y ? "Results per year" : "Results compared"}</h3>
          <table class="rp-table"><thead><tr><th></th><th>AI</th><th>Hindsight</th><th>Rule-based bot</th></tr></thead><tbody>${rows}</tbody></table>
        </div>
        <div>
          <h3>Asset assumptions</h3>
          <table class="rp-table"><tbody>${asset}</tbody></table>
        </div>
      </div>
      ${streamsHtml}
      <h3>Market and method</h3>
      <table class="rp-table"><tbody>
        <tr><td>Prices</td><td>${period}</td></tr>
        <tr><td>Data source</td><td>${source}</td></tr>
        <tr><td>Agent</td><td>${agent}</td></tr>
      </tbody></table>
      <ul class="rp-notes">
        <li>${annualNote}</li>
        <li>${r.stack && (r.stack.services || r.stack.capacity) ? `Grid services at ${CUR}${state.svc} per MW per hour${MARKET_INFO[state.p] && state.svc === MARKET_DEFAULTS[state.p].svc ? ` (${SV.year} market average)` : ""}; capacity payments are an assumption.` : "Energy arbitrage only; grid services and capacity payments are not included."}${MARKET_INFO[state.p] && state.capex === MARKET_DEFAULTS[state.p].capex ? ` Installed cost: ${esc(MARKET_INFO[state.p].cost)}.` : ""} Lifetime: health falls 20% over ${state.clife.toLocaleString("en-US")} cycles plus 1% a year; new cells at ${CUR}${state.aug}/kWh below 80% health; O&amp;M 1.5% of installed cost a year; ${state.itc ? `${state.itc}% investment tax credit on the installed cost; no other tax` : "no tax"} or financing.</li>
        <li>Battery wear is charged at the stated cost per full cycle. Forecast error is simulated on top of actual prices.</li>
        <li>Illustrative estimate, not a financial forecast or investment advice.</li>
      </ul>
      <div class="rp-foot"><span>AI Grid Trader by ${OWNER.name} · ${OWNER.linkedin}</span><span>${esc(location.origin + location.pathname)}</span></div>`;
  }

  // ------------------------------------------------------------------------------------
  // Wire everything up
  // ------------------------------------------------------------------------------------
  function init() {
    if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embed");
    if (state.p === "upload" || !(SIM[state.p] || REAL[state.p])) state.p = DEFAULTS.p;
    buildControls();
    syncControls();
    render();

    // A new release reloads open pages once (site.js). The scenario lives in the URL, so nothing
    // is lost, but a presenter who started auto-play by hand is not interrupted.
    window.Site.canReload = () => !(kiosk.on && !kiosk.auto) && !stage.on;

    $("btn-share").addEventListener("click", share);
    bindStage();
    $("btn-shuffle").addEventListener("click", newDay);
    const dataYear = (Object.values(REAL)[0] || {}).year;
    if (dataYear) document.querySelectorAll(".data-year").forEach((el) => { el.textContent = dataYear; });
    document.addEventListener("site:theme", onThemeChange);
    $("explain-close").addEventListener("click", hideExplain);
    $("explain-first").addEventListener("click", () => { const s = last && tradeStarts(last); if (s && s.length) showExplain(s[0], true); });
    $("btn-play").addEventListener("click", () => (kiosk.on ? stopKiosk() : startKiosk()));
    $("btn-report").addEventListener("click", openReportDialog);
    $("day-select").addEventListener("change", (e) => { fresh = true; state.d = parseInt(e.target.value, 10) || 0; scheduleRender(); });
    addEventListener("resize", placeSeg, { passive: true });
    if (document.fonts) document.fonts.ready.then(() => { placeSeg(); fitOutputs(true); });   // Inter swaps in after first paint

    $("report-dialog").addEventListener("close", () => {
      const dlg = $("report-dialog");
      if (dlg.returnValue !== "ok") return;
      const fields = {};
      for (const f of FIELDS) fields[f] = dlg.querySelector(`[name=${f}]`).value.trim();
      try { localStorage.setItem("agt-report", JSON.stringify({ author: fields.author, contact: fields.contact })); } catch (e) { /* optional */ }
      createReport(fields).catch(() => toast("Couldn't create the PDF in this browser"));
    });

    $("file-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 20e6) { toast("That file is too large (20 MB max)", 3500); return; }
      try {
        uploaded = E.parseUpload(await file.text(), file.name);
        buildRealChips();
        selectMarket("upload");
        toast(uploaded.note, 3500);
      } catch (err) {
        toast(err.message || "Couldn't read that file", 4500);
      }
    });

    // Leaving kiosk: a tap/click or a key hands control back to the visitor. Scrolling (wheel,
    // touch swipe, scroll keys) does not, so people can look around while it keeps playing.
    const SCROLL_KEYS = /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/;
    for (const ev of ["click", "keydown", "wheel", "touchstart", "scroll"]) {
      document.addEventListener(ev, (e) => {
        const exits = ev === "click" ? !e.target.closest("#btn-play")
          : ev === "keydown" ? !/^k$/i.test(e.key) && !SCROLL_KEYS.test(e.key)
          : false;
        if (kiosk.on && exits) stopKiosk();
        armIdle();
      }, { capture: true, passive: true });
    }

    // Keyboard shortcuts: 1–7 markets, N new day, H hindsight/forecast, F present, K auto-play, T theme.
    document.addEventListener("keydown", (e) => {
      if (stage.on) return;                  // presenter mode has its own keys (onStageKey)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(input|textarea|select)$/i.test(e.target.tagName) && e.target.type !== "range") return;
      if ($("report-dialog").open) return;
      const q = kioskQueue();
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= q.length) selectMarket(q[n - 1]);
      else if (/^n$/i.test(e.key)) newDay();
      else if (/^h$/i.test(e.key)) setMode(state.mode === "forecast" ? "hindsight" : "forecast");
      else if (/^f$/i.test(e.key)) openStage();
      else if (/^k$/i.test(e.key)) (kiosk.on ? stopKiosk() : startKiosk());
      else if (/^t$/i.test(e.key)) window.Site.toggleTheme();
    });

    window.addEventListener("hashchange", () => {
      const next = readState();
      if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; syncControls(); scheduleRender(); }
    });

    if (kiosk.auto) startKiosk();
  }

  init();
})();
