// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Plot Suite (02-plots.js)
// 15 canvas plot functions + shared helpers for the PRiSM Well Test
// Analysis module. Pure vanilla JS, dark theme (host CSS variables),
// retina-aware, responsive (ResizeObserver) and touch-capable (Pointer
// Events: pan / box-zoom / pinch / long-press reset).
//
// This file is intentionally NOT wrapped in an IIFE: its `function
// PRiSM_plot_*` declarations hoist into the host main IIFE scope. Every
// public symbol is also published on window at the end of the file.
//
// Universal signature:   PRiSM_plot_<NAME>(canvas, data, opts)
//
// ── C6 plot data contract ───────────────────────────────────────────
//   Log-log (Bourdet)  data = { t: Δt[hr], dp: Δp[psi] (>0 plotted),
//                               deriv?: Δp′[psi], x?: time-function[],
//                               overlay?: { t[], dp[], deriv[] } }
//        dp and deriv are plotted EXACTLY as given. When deriv is present
//        the derivative is never recomputed. data.dp ALWAYS means Δp,
//        never the derivative. Without dp the plot derives a sign-aware
//        Δp from data.p (pRef = data.pRef, else p[0]) and warns once.
//   Horner   data = { t: Δt[], p: pws[], tp (required), line?: {m,b,x0,x1} }
//            line: p = b + m·X with X = log10((tp+Δt)/Δt); x0/x1 in X
//            (or t0/t1 in Δt hours). p* = b.
//   MDH      data = { t: Δt[], p[], line?: {m,b,t0,t1} }  p = b + m·log10(Δt)
//   Superposition (build-up / multi-rate)
//            data = { t: Δt[], p[], tStart?, periods? | rateHistory? | q?,
//                     x? (C2 time function), tp?, line?: {m,b,x0,x1} }
//            X = Σ (qᵢ−qᵢ₋₁)/q_ref · log10(T_n − Tᵢ₋₁ + Δt), q_ref = the
//            analysed rate, or the last NON-ZERO flowing rate for a shut-in
//            (single-rate build-up → log10((tp+Δt)/Δt), p* at X = 0).
//   Cartesian data = { t: tAbs[], p[], q?[], periods?[{t0,t1,start,end,q}],
//                      overlay?: { t[], p[] } }   (q drawn on a right axis)
//   Decline / RTA data = { t: days[], q[], overlay?: { t[], q[] } }
//            opts.timeUnit 'd' (default) | 'h' | 'mo' | 'yr', opts.xLabel,
//            opts.rateUnit, opts.showTangentEUR, opts.eurWindow.
//
// ── Common opts ─────────────────────────────────────────────────────
//   width, height, padding, title, xLabel, yLabel, showLegend, hover,
//   dragZoom, activePeriod, smoothL, plotKey, view {x:{min,max},y:{…}},
//   resetView, postDraw(info), postDrawHooks (bool)
//
// ── Axes (C6) ───────────────────────────────────────────────────────
//   canvas._prismAxes = { scaleX:{kind,min,max,label}, scaleY, toX, toY,
//       fromX(px), fromY(py), plot:{x,y,w,h,cssW,cssH}, plotKey,
//       xLog, yLog, x0,x1,y0,y1, dx0,dx1,dy0,dy1 (legacy flat keys),
//       userView, autoScale, dataSig, points, result }
//
// ── Interaction (installed ONCE per canvas; no per-draw listeners) ──
//   mouse : drag = box zoom, Shift/Alt/middle-drag = pan,
//           Ctrl/⌘+wheel or trackpad pinch = zoom, double-click = reset,
//           hover = nearest-point read-out
//   touch : one-finger drag = pan, two-finger pinch = zoom, tap = read-out,
//           long-press (600 ms) = reset view
//   The user view survives redraws of the same plot + same data; it is
//   dropped on new data, opts.resetView, or when canvas._prismAxes is
//   deleted (the Tab-2 "Reset view" button does this).
//   Internal repaints (zoom / pan / pinch / resize / reset) call
//   opts.postDraw(info) and — when opts.plotKey is given or
//   opts.postDrawHooks === true (and not === false) — each entry of
//   window.PRiSM_postDrawHooks with {canvas, plotKey, data, opts, axes,
//   reason}. The initial draw never runs hooks (drawActivePlot does).
//   Event 'prism:plot-view-changed' {plotKey, zoomed, view} bubbles from
//   the canvas after every view change.
// ════════════════════════════════════════════════════════════════════

const PRiSM_PLOT_G = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined' ? globalThis : {});

// ─────────────────────────────────────────────────────────────────────
// THEME — defaults = host dark theme; refreshed from the host CSS
// variables (--bg1, --bg2, --border, --text …) on every plot call.
// ─────────────────────────────────────────────────────────────────────
const PRiSM_THEME = {
    bg:        '#0d1117',
    panel:     '#161b22',
    border:    '#30363d',
    grid:      '#21262d',
    gridMajor: '#30363d',
    text:      '#c9d1d9',
    text2:     '#8b949e',
    text3:     '#848d97',   // P10 contrast (was #6e7681); synced from --text3
    accent:    '#f0883e', // orange — primary series
    blue:      '#58a6ff', // overlay / model curve
    green:     '#3fb950', // derivative / good fit
    red:       '#f85149', // boundaries / bad fit
    yellow:    '#d29922', // half-slope / linear flow
    cyan:      '#39c5cf', // secondary axis
    purple:    '#bc8cff'  // type-curve guides
};

const PRiSM_THEME_VARS = {
    bg: '--bg1', panel: '--bg2', border: '--border', grid: '--bg4', gridMajor: '--border',
    text: '--text', text2: '--text2', text3: '--text3', accent: '--accent',
    blue: '--blue', green: '--green', red: '--red', yellow: '--yellow', purple: '--purple'
};

function PRiSM_plot_syncTheme() {
    try {
        const G = PRiSM_PLOT_G;
        const doc = G.document;
        if (!doc || !doc.documentElement || typeof G.getComputedStyle !== 'function') return;
        const cs = G.getComputedStyle(doc.documentElement);
        if (!cs || typeof cs.getPropertyValue !== 'function') return;
        Object.keys(PRiSM_THEME_VARS).forEach(function (k) {
            const v = String(cs.getPropertyValue(PRiSM_THEME_VARS[k]) || '').trim();
            if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(v)) PRiSM_THEME[k] = v;
        });
    } catch (_) { /* theme stays on defaults */ }
}

// Desktop padding is kept identical to the historical value (other
// layers mirror it). Canvases narrower than 480 CSS px use the compact
// set so a 375 px phone keeps a usable plot area.
const PRiSM_DEFAULT_PADDING = { top: 30, right: 80, bottom: 48, left: 64 };
const PRiSM_COMPACT_PADDING = { top: 28, right: 14, bottom: 42, left: 52 };

// ─────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_isNum(v) {
    return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && isFinite(+v);
}
function PRiSM_plot_num() {
    for (let i = 0; i < arguments.length; i++) if (PRiSM_plot_isNum(arguments[i])) return +arguments[i];
    return NaN;
}
function PRiSM_plot_pos() {
    for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (PRiSM_plot_isNum(v) && +v > 0) return +v;
    }
    return NaN;
}
function PRiSM_plot_arr(a) {
    return (a && typeof a !== 'string' && typeof a.length === 'number' && a.length > 0) ? a : null;
}
function PRiSM_plot_isData(data) {
    return !!(data && PRiSM_plot_arr(data.t));
}
function PRiSM_plot_zip(xs, ys) {
    const n = Math.min(xs ? xs.length : 0, ys ? ys.length : 0);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [xs[i], ys[i]];
    return out;
}
function PRiSM_plot_copyScale(s) {
    return { kind: s.kind, min: s.min, max: s.max, label: s.label };
}
function PRiSM_plot_now() {
    const G = PRiSM_PLOT_G;
    try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (_) { /* ignore */ }
    return Date.now();
}
function PRiSM_plot_warnOnce(S, key, msg) {
    if (!S || S.warned[key]) return;
    S.warned[key] = true;
    try { console.warn(msg); } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────
// FORMATTING — engineering (k / M / G), scientific fallback.
// Trailing zeros are stripped ONLY after a decimal point, so 100 → '100',
// 120 → '120', 850 → '850' (the old /\.?0+$/ turned 100 into '1').
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_trimZeros(s) {
    s = String(s);
    const e = s.search(/e/i);
    if (e !== -1) {
        let exp = s.slice(e + 1).replace(/^\+/, '');
        exp = exp.replace(/^(-?)0+(\d)/, '$1$2');
        return PRiSM_plot_trimZeros(s.slice(0, e)) + 'e' + exp;
    }
    if (s.indexOf('.') === -1) return s;
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function PRiSM_plot_format_eng(n, sig) {
    if (n === null || n === undefined || n === '') return '';
    n = +n;
    if (!isFinite(n)) return '';
    sig = Math.max(1, Math.min(12, sig || 3));
    if (n === 0) return '0';
    // Round first so 999.95k promotes to 1M rather than '1000k'.
    const r = Number(n.toPrecision(sig));
    const a = Math.abs(r);
    if (a >= 1e12 || a < 1e-3) return PRiSM_plot_trimZeros(r.toExponential(Math.max(0, sig - 1)));
    if (a >= 1e9) return PRiSM_plot_trimZeros((r / 1e9).toPrecision(sig)) + 'G';
    if (a >= 1e6) return PRiSM_plot_trimZeros((r / 1e6).toPrecision(sig)) + 'M';
    if (a >= 1e3) return PRiSM_plot_trimZeros((r / 1e3).toPrecision(sig)) + 'k';
    return PRiSM_plot_trimZeros(r.toPrecision(sig));
}

// Tick label. Log axes: decades as plain numbers between 0.01 and 100k,
// else 1eK. Linear axes: fixed decimals derived from the tick step so the
// labels of one axis are consistent (3200, 3400 … / 0.5, 1.0 …); very
// large or very fine steps fall back to engineering notation.
function PRiSM_plot_format_tick(v, isLog, step) {
    if (!isFinite(v)) return '';
    if (isLog) {
        if (v <= 0) return '';
        const k = Math.round(Math.log10(Math.abs(v)));
        if (Math.abs(v - Math.pow(10, k)) / Math.pow(10, k) < 1e-6) {
            if (k >= -2 && k <= 5) return PRiSM_plot_format_eng(v);
            return '1e' + k;
        }
        return PRiSM_plot_format_eng(v);
    }
    if (isFinite(step) && step > 0) {
        const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        if (Math.abs(v) < step * 1e-6) return (0).toFixed(Math.min(dec, 6));
        if (Math.abs(v) < 1e5 && step < 1e4 && dec <= 6) return v.toFixed(dec);
        const sig = Math.max(3, Math.min(8, Math.floor(Math.log10(Math.abs(v))) - Math.floor(Math.log10(step) + 1e-9) + 1));
        return PRiSM_plot_format_eng(v, sig);
    }
    return PRiSM_plot_format_eng(v);
}

// Pressure-style value for plot annotations (p*, p1hr).
function PRiSM_plot_fmtP(v) {
    if (!isFinite(v)) return '—';
    return Math.abs(v) >= 100 ? v.toFixed(1) : PRiSM_plot_format_eng(v, 4);
}

// ─────────────────────────────────────────────────────────────────────
// TICKS — log decades & "nice" linear ticks
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_log_ticks(min, max) {
    // Returns { major: [10^k …], minor: [2·10^k, 3·10^k, …] } in the
    // visible decade span.
    if (!isFinite(min) || !isFinite(max) || min <= 0 || max <= 0 || max <= min) {
        return { major: [], minor: [] };
    }
    const k0 = Math.floor(Math.log10(min));
    const k1 = Math.ceil(Math.log10(max));
    const major = [], minor = [];
    const eps = 1e-9;
    for (let k = k0; k <= k1; k++) {
        const base = Math.pow(10, k);
        if (base >= min * (1 - eps) && base <= max * (1 + eps)) major.push(base);
        if (k1 - k0 > 12) continue; // too many decades — skip minors
        for (let m = 2; m <= 9; m++) {
            const v = m * base;
            if (v >= min && v <= max) minor.push(v);
        }
    }
    return { major, minor };
}

function PRiSM_plot_lin_ticks(min, max, target) {
    target = target || 6;
    if (!isFinite(min) || !isFinite(max) || max <= min) return [];
    const span = max - min;
    const rough = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm < 1.5)      step = 1 * mag;
    else if (norm < 3)   step = 2 * mag;
    else if (norm < 7)   step = 5 * mag;
    else                 step = 10 * mag;
    const k0 = Math.ceil(min / step - 1e-9);
    const ticks = [];
    for (let k = k0; k <= k0 + 1000; k++) {
        const v = k * step;
        if (v > max + step * 1e-9) break;
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    ticks.step = step;
    return ticks;
}

// ─────────────────────────────────────────────────────────────────────
// PER-CANVAS STATE (WeakMap → collected with the canvas)
// ─────────────────────────────────────────────────────────────────────
const PRiSM_PLOT_STATES = (typeof WeakMap === 'function') ? new WeakMap() : null;

function PRiSM_plot_getState(canvas) {
    if (!canvas) return null;
    return PRiSM_PLOT_STATES ? (PRiSM_PLOT_STATES.get(canvas) || null) : (canvas.__prismPlotState || null);
}

function PRiSM_plot_state(canvas) {
    let S = PRiSM_plot_getState(canvas);
    if (S) return S;
    const st = canvas.style || {};
    const aw = String(st.width || ''), ah = String(st.height || '');
    // An author size that is not a plain px value (100%, calc(), vw …)
    // stays CSS-controlled; everything else is pinned in px as before.
    const isRel = function (v) { return v !== '' && !/^\s*-?[\d.]+\s*(px)?\s*$/i.test(v); };
    const pxOf = function (v) { const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v); return m ? parseFloat(m[1]) : 0; };
    S = {
        canvas: canvas,
        relW: isRel(aw), relH: isRel(ah),
        authorPxW: pxOf(aw), authorPxH: pxOf(ah),
        authorTouch: String(st.touchAction || ''),
        touchSet: false,
        cssW: 0, cssH: 0,
        cur: null,
        installed: false, handlers: null, ro: null,
        pointers: (typeof Map === 'function') ? new Map() : null,
        gesture: null, lpTimer: null,
        snap: null, hover: null,
        raf: null, rafReason: null,
        warned: {}
    };
    if (PRiSM_PLOT_STATES) PRiSM_PLOT_STATES.set(canvas, S);
    else {
        try { Object.defineProperty(canvas, '__prismPlotState', { value: S, configurable: true }); }
        catch (_) { canvas.__prismPlotState = S; }
    }
    return S;
}

// ─────────────────────────────────────────────────────────────────────
// CANVAS SETUP — retina, padding, plot rect
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_padding(cssW, opts, extra) {
    const narrow = cssW < 480;
    const base = Object.assign({}, narrow ? PRiSM_COMPACT_PADDING : PRiSM_DEFAULT_PADDING);
    if (extra && extra.secondaryAxis) base.right = Math.max(base.right, narrow ? 46 : 64);
    return Object.assign(base, (opts && opts.padding) || {});
}

function PRiSM_plot_measure(canvas, opts, S) {
    const ow = +opts.width, oh = +opts.height;
    const pinW = ow > 0 || !S.relW;
    const pinH = oh > 0 || !S.relH;
    let w = ow > 0 ? ow : (canvas.clientWidth || 0);
    let h = oh > 0 ? oh : (canvas.clientHeight || 0);
    if (!(w > 0)) w = S.cssW || S.authorPxW || canvas.width || 600;
    if (!(h > 0)) h = S.cssH || S.authorPxH || canvas.height || 400;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), pinW: pinW, pinH: pinH };
}

function PRiSM_plot_applySize(canvas, opts, S, extra) {
    const dpr = PRiSM_PLOT_G.devicePixelRatio || 1;
    const m = PRiSM_plot_measure(canvas, opts || {}, S);
    if (canvas.style) {
        if (m.pinW) canvas.style.width = m.w + 'px';
        if (m.pinH) canvas.style.height = m.h + 'px';
    }
    canvas.width = Math.max(1, Math.round(m.w * dpr));
    canvas.height = Math.max(1, Math.round(m.h * dpr));
    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // crisp on retina
    S.cssW = m.w; S.cssH = m.h; S.dpr = dpr;
    const pad = PRiSM_plot_padding(m.w, opts, extra);
    const plot = {
        x: pad.left,
        y: pad.top,
        w: Math.max(10, m.w - pad.left - pad.right),
        h: Math.max(10, m.h - pad.top - pad.bottom),
        cssW: m.w,
        cssH: m.h,
        pad: pad,
        dpr: dpr,
        narrow: m.w < 480
    };
    return { ctx: ctx, plot: plot, dpr: dpr };
}

function PRiSM_plot_setup(canvas, opts, extra) {
    opts = opts || {};
    PRiSM_plot_syncTheme();
    const S = PRiSM_plot_state(canvas);
    PRiSM_plot_abortGesture(S);
    S.cur = null; S.snap = null; S.hover = null;
    const prevAxes = canvas._prismAxes || null;
    try { canvas._prismAxes = null; } catch (_) { /* detached / frozen */ }
    const r = PRiSM_plot_applySize(canvas, opts, S, extra);
    return { ctx: r.ctx, plot: r.plot, dpr: r.dpr, S: S, prevAxes: prevAxes, opts: opts, extra: extra || null, canvas: canvas };
}

// Balanced helper: ONE save() — pair every call with ONE ctx.restore().
function PRiSM_plot_clip(ctx, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
}

// ─────────────────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_empty(ctx, plot, msg) {
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
    ctx.fillStyle = PRiSM_THEME.text3;
    ctx.font = (plot.narrow ? '12px' : '13px') + ' sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data', plot.x + plot.w / 2, plot.y + plot.h / 2, Math.max(40, plot.w - 12));
}

// Draws an empty-state message and records it so a resize repaints it.
function PRiSM_plot_noData(setup, msg) {
    const ctx = setup.ctx, plot = setup.plot, S = setup.S;
    const render = function () { PRiSM_plot_empty(ctx, plot, msg); };
    render();
    S.cur = { empty: true, msg: msg, canvas: setup.canvas, ctx: ctx, plot: plot, render: render,
              opts: setup.opts, extra: setup.extra };
    PRiSM_plot_install(setup.canvas, S);
}

// Public: themed, correctly sized status message on a plot canvas.
// Prefer this over clearing the canvas by hand — it also detaches the
// previous plot's interactions and keeps the message on resize.
function PRiSM_plot_message(canvas, msg, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const setup = PRiSM_plot_setup(canvas, opts || {});
    PRiSM_plot_noData(setup, msg || 'No data');
}

// ─────────────────────────────────────────────────────────────────────
// SCALE TRANSFORMS (invertible) — used by axes, gestures and consumers.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_makeTransform(scale, p0, len, invert) {
    const log = scale.kind === 'log';
    const a = log ? Math.log10(scale.min) : scale.min;
    const b = log ? Math.log10(scale.max) : scale.max;
    const span = (b - a) || 1;
    const to = invert
        ? function (v) { return p0 + len - ((log ? Math.log10(v) : v) - a) / span * len; }
        : function (v) { return p0 + ((log ? Math.log10(v) : v) - a) / span * len; };
    const from = invert
        ? function (px) { const u = a + (p0 + len - px) / len * span; return log ? Math.pow(10, u) : u; }
        : function (px) { const u = a + (px - p0) / len * span; return log ? Math.pow(10, u) : u; };
    return { to: to, from: from };
}

// ─────────────────────────────────────────────────────────────────────
// AXES — paints background, grid, ticks, labels, title.
// scaleX / scaleY: { kind:'lin'|'log', min, max, label }
// opts.scaleY2 (optional): right-hand linear axis { min, max, label, color }
// Returns the world↔pixel transforms and stashes canvas._prismAxes.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_axes(ctx, plot, scaleX, scaleY, opts) {
    opts = opts || {};
    const narrow = !!plot.narrow;
    // Background
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.fillStyle = PRiSM_THEME.panel;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    const xLog = scaleX.kind === 'log';
    const yLog = scaleY.kind === 'log';
    const xTarget = Math.max(3, Math.min(8, Math.floor(plot.w / 70)));
    const yTarget = Math.max(3, Math.min(7, Math.floor(plot.h / 45)));
    const xTicks = xLog
        ? PRiSM_plot_log_ticks(scaleX.min, scaleX.max)
        : { major: PRiSM_plot_lin_ticks(scaleX.min, scaleX.max, xTarget), minor: [] };
    const yTicks = yLog
        ? PRiSM_plot_log_ticks(scaleY.min, scaleY.max)
        : { major: PRiSM_plot_lin_ticks(scaleY.min, scaleY.max, yTarget), minor: [] };
    const xStep = xTicks.major.step, yStep = yTicks.major.step;

    const tx = PRiSM_plot_makeTransform(scaleX, plot.x, plot.w, false);
    const ty = PRiSM_plot_makeTransform(scaleY, plot.y, plot.h, true);
    const toX = tx.to, toY = ty.to, fromX = tx.from, fromY = ty.from;

    // Minor grid (log only)
    if (xLog && xTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        xTicks.minor.forEach(function (v) {
            const px = Math.round(toX(v)) + 0.5;
            ctx.moveTo(px, plot.y);
            ctx.lineTo(px, plot.y + plot.h);
        });
        ctx.stroke();
    }
    if (yLog && yTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        yTicks.minor.forEach(function (v) {
            const py = Math.round(toY(v)) + 0.5;
            ctx.moveTo(plot.x, py);
            ctx.lineTo(plot.x + plot.w, py);
        });
        ctx.stroke();
    }

    // Major grid + tick labels (labels that would collide are skipped)
    ctx.strokeStyle = PRiSM_THEME.gridMajor;
    ctx.lineWidth = 1;
    ctx.fillStyle = PRiSM_THEME.text2;
    ctx.font = (narrow ? '10px' : '11px') + ' sans-serif';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    xTicks.major.forEach(function (v) {
        const px = Math.round(toX(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, plot.y);
        ctx.lineTo(px, plot.y + plot.h);
        ctx.stroke();
        const s = PRiSM_plot_format_tick(v, xLog, xStep);
        const w = ctx.measureText(s).width || 0;
        if (px - w / 2 < lastRight + 4) return;
        ctx.fillText(s, px, plot.y + plot.h + 6);
        lastRight = px + w / 2;
    });

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let lastY = Infinity;
    yTicks.major.forEach(function (v) {
        const py = Math.round(toY(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, py);
        ctx.lineTo(plot.x + plot.w, py);
        ctx.stroke();
        if (Math.abs(lastY - py) < (narrow ? 12 : 13)) return;
        ctx.fillText(PRiSM_plot_format_tick(v, yLog, yStep), plot.x - 6, py);
        lastY = py;
    });

    // Secondary (right) linear axis
    let toY2 = null, fromY2 = null;
    const s2 = opts.scaleY2;
    if (s2 && isFinite(s2.min) && isFinite(s2.max) && s2.max > s2.min) {
        const t2 = PRiSM_plot_makeTransform({ kind: 'lin', min: s2.min, max: s2.max }, plot.y, plot.h, true);
        toY2 = t2.to; fromY2 = t2.from;
        const ticks2 = PRiSM_plot_lin_ticks(s2.min, s2.max, yTarget);
        ctx.fillStyle = s2.color || PRiSM_THEME.cyan;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let last2 = Infinity;
        ticks2.forEach(function (v) {
            const py = Math.round(toY2(v)) + 0.5;
            if (Math.abs(last2 - py) < 13) return;
            ctx.fillText(PRiSM_plot_format_tick(v, false, ticks2.step), plot.x + plot.w + 5, py);
            last2 = py;
        });
    }

    // Border on top
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);

    // Axis labels
    ctx.fillStyle = PRiSM_THEME.text;
    ctx.font = (narrow ? '11px' : '12px') + ' sans-serif';
    if (scaleX.label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(scaleX.label, plot.x + plot.w / 2, plot.cssH - (narrow ? 4 : 8), Math.max(40, plot.cssW - 8));
    }
    if (scaleY.label) {
        ctx.save();
        ctx.translate(narrow ? 11 : 14, plot.y + plot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(scaleY.label, 0, 0, Math.max(40, plot.h + (plot.pad ? plot.pad.top : 0)));
        ctx.restore();
    }
    if (s2 && toY2 && s2.label) {
        ctx.save();
        ctx.fillStyle = s2.color || PRiSM_THEME.cyan;
        ctx.translate(plot.cssW - (narrow ? 8 : 10), plot.y + plot.h / 2);
        ctx.rotate(Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s2.label, 0, 0, Math.max(40, plot.h));
        ctx.restore();
    }

    // Title
    if (opts.title) {
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.font = 'bold ' + (narrow ? '12px' : '13px') + ' sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.title, plot.x, narrow ? 7 : 8, Math.max(40, plot.cssW - plot.x - 8));
    }

    // C6 axes object (+ the legacy flat keys read by the analysis-key and
    // overlay layers). Scales are copied so a stashed object stays
    // self-consistent after a later zoom.
    if (opts.canvas) {
        const sX = PRiSM_plot_copyScale(scaleX), sY = PRiSM_plot_copyScale(scaleY);
        const axes = {
            scaleX: sX, scaleY: sY,
            toX: toX, toY: toY, fromX: fromX, fromY: fromY,
            plot: { x: plot.x, y: plot.y, w: plot.w, h: plot.h, cssW: plot.cssW, cssH: plot.cssH },
            plotKey: opts.plotKey || null,
            xLog: xLog, yLog: yLog,
            x0: plot.x, x1: plot.x + plot.w, y0: plot.y, y1: plot.y + plot.h,
            dx0: sX.min, dx1: sX.max, dy0: sY.min, dy1: sY.max,
            dpr: plot.dpr || 1
        };
        if (toY2) {
            axes.scaleY2 = { kind: 'lin', min: s2.min, max: s2.max, label: s2.label };
            axes.toY2 = toY2; axes.fromY2 = fromY2;
        }
        try { opts.canvas._prismAxes = axes; } catch (_) { /* detached node */ }
    }

    return { toX: toX, toY: toY, fromX: fromX, fromY: fromY, xLog: xLog, yLog: yLog, toY2: toY2, fromY2: fromY2 };
}

// ─────────────────────────────────────────────────────────────────────
// LEGEND — top-right, drawn AFTER all series so it sits on top.
// items: [ { label, color, dash:bool, marker:'line'|'dot' } ]
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_legend(ctx, items, plot, opts) {
    if (!items || !items.length) return;
    opts = opts || {};
    ctx.save();
    const narrow = !!plot.narrow;
    ctx.font = (narrow ? '10px' : '11px') + ' sans-serif';
    ctx.textBaseline = 'middle';
    const padX = narrow ? 6 : 8, padY = narrow ? 4 : 6, lineH = narrow ? 14 : 16, swatch = narrow ? 14 : 18;
    let maxW = 0;
    items.forEach(function (it) { maxW = Math.max(maxW, ctx.measureText(it.label).width || 0); });
    const boxW = Math.min(plot.w - 8, swatch + 6 + maxW + padX * 2);
    const boxH = items.length * lineH + padY * 2 - 4;
    const bx = plot.x + plot.w - boxW - (narrow ? 4 : 8);
    const by = plot.y + (narrow ? 4 : 8);
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
    items.forEach(function (it, i) {
        const ly = by + padY + i * lineH + lineH / 2 - 2;
        ctx.strokeStyle = it.color;
        ctx.fillStyle = it.color;
        ctx.lineWidth = 2;
        if (it.marker === 'dot') {
            ctx.beginPath();
            ctx.arc(bx + padX + swatch / 2, ly, 3, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            if (it.dash) ctx.setLineDash([5, 3]);
            ctx.moveTo(bx + padX, ly);
            ctx.lineTo(bx + padX + swatch, ly);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.textAlign = 'left';
        ctx.fillText(it.label, bx + padX + swatch + 6, ly, Math.max(20, boxW - swatch - padX * 2 - 6));
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SHARED — line series, scatter series
// ─────────────────────────────────────────────────────────────────────
// P6 plot decimation (drawing only — data, fits and _prismAxes are untouched).
// A series longer than PRiSM_PLOT_DECIMATE_MIN points is drawn with the M4 rule:
// per pixel column keep the first, lowest, highest and last vertex in their
// original order, which rasterises to the same polyline (Jugel et al., "M4: A
// Visualization-Oriented Time Series Data Aggregation", PVLDB 7(10), 2014).
// Markers keep one dot per half-pixel cell.
const PRiSM_PLOT_DECIMATE_MIN = 1500;
function PRiSM_plot_pathM4(ctx, pts, toX, toY) {
    let started = false, col = null, b = null;
    const flush = function () {
        if (!b) return;
        let last = -1;
        [b.f, b.mn, b.mx, b.l].sort(function (a, c) { return a.i - c.i; }).forEach(function (q) {
            if (q.i === last) return;
            last = q.i;
            if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
        });
        b = null;
    };
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const x = (p && isFinite(p[0]) && isFinite(p[1])) ? toX(p[0]) : NaN;
        const y = isFinite(x) ? toY(p[1]) : NaN;
        if (!isFinite(x) || !isFinite(y)) { flush(); started = false; col = null; continue; }
        const c = Math.floor(x);
        if (b && c !== col) flush();
        col = c;
        const q = { i: i, x: x, y: y };
        if (!b) b = { f: q, mn: q, mx: q, l: q };
        else { if (y < b.mn.y) b.mn = q; if (y > b.mx.y) b.mx = q; b.l = q; }
    }
    flush();
}

function PRiSM_plot_line(ctx, pts, toX, toY, color, opts) {
    if (!pts || !pts.length) return;
    opts = opts || {};
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width || 2;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
    if (pts.length > PRiSM_PLOT_DECIMATE_MIN) {
        PRiSM_plot_pathM4(ctx, pts, toX, toY);
        ctx.stroke();
        ctx.restore();
        return;
    }
    let started = false;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) { started = false; continue; }
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
}

function PRiSM_plot_dots(ctx, pts, toX, toY, color, r) {
    if (!pts || !pts.length) return;
    r = r || 2.5;
    ctx.save();
    ctx.fillStyle = color;
    const seen = pts.length > PRiSM_PLOT_DECIMATE_MIN ? new Set() : null;
    pts.forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) return;
        if (seen) {
            const k = Math.round(x * 2) + ',' + Math.round(y * 2);
            if (seen.has(k)) return;
            seen.add(k);
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// AUTO-RANGE — computes min/max for an array, padded, log-safe.
// maxDecades (log only) floors min at max/10^maxDecades so a single
// noisy near-zero derivative cannot flatten the whole plot.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_range(arr, isLog, padFrac, maxDecades) {
    if (!arr || !arr.length) return { min: isLog ? 0.1 : 0, max: isLog ? 10 : 1 };
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (isLog && v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: isLog ? 0.1 : 0, max: isLog ? 10 : 1 };
    if (isLog && maxDecades > 0 && max / min > Math.pow(10, maxDecades)) min = max / Math.pow(10, maxDecades);
    if (min === max) {
        if (isLog) { min /= 2; max *= 2; }
        else if (min === 0) { max = 1; }
        else { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    }
    if (isLog) {
        // Snap to outer decades for nice ticks.
        const lo = Math.pow(10, Math.floor(Math.log10(min) + 1e-9));
        const hi = Math.pow(10, Math.ceil(Math.log10(max) - 1e-9));
        return { min: lo, max: hi > lo ? hi : lo * 10 };
    }
    const f = padFrac == null ? 0.05 : padFrac;
    const span = max - min;
    return { min: min - span * f, max: max + span * f };
}

// ─────────────────────────────────────────────────────────────────────
// PERIODS — every flow period shaded (shut-ins tinted blue), active
// period highlighted. Accepts {start,end} and {t0,t1} (C2 / C6).
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_periods(ctx, periods, activeIdx, toX, plot) {
    if (!periods || !periods.length) return;
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    for (let i = 0; i < periods.length; i++) {
        const pr = periods[i];
        if (!pr) continue;
        const s = PRiSM_plot_num(pr.start, pr.t0, pr.tStart);
        const e = PRiSM_plot_num(pr.end, pr.t1, pr.tEnd);
        if (!isFinite(s) || !isFinite(e)) continue;
        const x0 = toX(s), x1 = toX(e);
        if (!isFinite(x0) || !isFinite(x1)) continue;
        const lo = Math.min(x0, x1), w = Math.max(1, Math.abs(x1 - x0));
        const active = i === activeIdx;
        const shut = PRiSM_plot_isNum(pr.q) && Math.abs(+pr.q) < 1e-12;
        ctx.fillStyle = active ? 'rgba(240,136,62,0.14)'
            : (shut ? 'rgba(88,166,255,0.08)' : (i % 2 ? 'rgba(139,148,158,0.05)' : 'rgba(139,148,158,0.09)'));
        ctx.fillRect(lo, plot.y, w, plot.h);
        ctx.strokeStyle = active ? PRiSM_THEME.accent : 'rgba(139,148,158,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash(active ? [4, 3] : [2, 4]);
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
        ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = pr.label || (active ? 'Analysed period' : '');
        if (label && w > 30) {
            ctx.fillStyle = active ? PRiSM_THEME.accent : PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(label, lo + 4, plot.y + 4, Math.max(20, w - 6));
        }
    }
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SEMILOG STRAIGHT LINE  p = b + m·X  on a plot whose x value maps to X
// through xOf (Horner: log10 ratio, MDH: log10 Δt, superposition: X).
// win = [xa, xb] in PLOTTED x units (solid), the rest is dashed.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, xOf, win) {
    if (!line || !isFinite(line.m) || !isFinite(line.b)) return;
    const pAt = function (xv) { return line.b + line.m * xOf(xv); };
    const xa = scaleX.min, xb = scaleX.max;
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = 'rgba(88,166,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(tr.toX(xa), tr.toY(pAt(xa)));
    ctx.lineTo(tr.toX(xb), tr.toY(pAt(xb)));
    ctx.stroke();
    ctx.setLineDash([]);
    if (win && isFinite(win[0]) && isFinite(win[1])) {
        const w0 = Math.min(win[0], win[1]), w1 = Math.max(win[0], win[1]);
        ctx.strokeStyle = PRiSM_THEME.blue;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tr.toX(w0), tr.toY(pAt(w0)));
        ctx.lineTo(tr.toX(w1), tr.toY(pAt(w1)));
        ctx.stroke();
        ctx.fillStyle = PRiSM_THEME.blue;
        [w0, w1].forEach(function (xv) {
            ctx.beginPath();
            ctx.arc(tr.toX(xv), tr.toY(pAt(xv)), 3, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    ctx.restore();
}

// Marker + label at a key abscissa (p* at ratio 1, p1hr at 1 h …).
function PRiSM_plot_keyPoint(ctx, tr, plot, xv, pv, text, color) {
    const px = tr.toX(xv), py = tr.toY(pv);
    if (!isFinite(px) || !isFinite(py)) return;
    if (px < plot.x - 1 || px > plot.x + plot.w + 1 || py < plot.y - 1 || py > plot.y + plot.h + 1) return;
    ctx.save();
    ctx.fillStyle = color || PRiSM_THEME.green;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (plot.narrow ? '10px' : '11px') + ' sans-serif';
    ctx.textBaseline = 'bottom';
    const w = ctx.measureText(text).width || 0;
    const right = px + 8 + w > plot.x + plot.w;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(text, right ? px - 8 : px + 8, Math.max(plot.y + 12, py - 6));
    ctx.restore();
}

// ════════════════════════════════════════════════════════════════════
// ── INTERACTION LAYER (Pointer Events + ResizeObserver) ─────────────
// ════════════════════════════════════════════════════════════════════
function PRiSM_plot_signature(pts) {
    if (!pts || !pts.length) return '0';
    const f = function (v) { return isFinite(v) ? (+v).toPrecision(7) : 'x'; };
    const a = pts[0], b = pts[pts.length - 1], m = pts[pts.length >> 1];
    return pts.length + ':' + f(a[0]) + ',' + f(a[1]) + ':' + f(m[0]) + ',' + f(m[1]) + ':' + f(b[0]) + ',' + f(b[1]);
}

function PRiSM_plot_validRange(kind, r) {
    return r && isFinite(r.min) && isFinite(r.max) && r.max > r.min && (kind !== 'log' || r.min > 0);
}

function PRiSM_plot_applyView(sx, sy, view) {
    if (!view) return false;
    let ok = false;
    if (PRiSM_plot_validRange(sx.kind, view.x)) { sx.min = +view.x.min; sx.max = +view.x.max; ok = true; }
    if (PRiSM_plot_validRange(sy.kind, view.y)) { sy.min = +view.y.min; sy.max = +view.y.max; ok = true; }
    return ok;
}

// Finish a plot call: restore a persisted user view, paint, install the
// (once-per-canvas) interaction layer.
//   cfg = { scaleX, scaleY, points, sigPoints?, plotKey, data, xName,
//           yName, result? }
function PRiSM_plot_finish(setup, render, cfg) {
    const S = setup.S, canvas = setup.canvas, opts = setup.opts || {};
    const sx = cfg.scaleX, sy = cfg.scaleY;
    const plotKey = (typeof opts.plotKey === 'string' && opts.plotKey) ? opts.plotKey : (cfg.plotKey || null);
    const auto = { x: PRiSM_plot_copyScale(sx), y: PRiSM_plot_copyScale(sy) };
    const sig = PRiSM_plot_signature(cfg.sigPoints || cfg.points);
    let zoomed = false;
    if (opts.view && PRiSM_plot_applyView(sx, sy, opts.view)) zoomed = true;
    else if (!opts.resetView) {
        const pa = setup.prevAxes;
        const uv = pa && pa.userView;
        if (uv && pa.plotKey === plotKey && pa.dataSig === sig && uv.x && uv.y &&
            uv.x.kind === sx.kind && uv.y.kind === sy.kind && PRiSM_plot_applyView(sx, sy, uv)) {
            zoomed = true;
        }
    }
    try { canvas._prismOriginalScale = { x: PRiSM_plot_copyScale(auto.x), y: PRiSM_plot_copyScale(auto.y) }; }
    catch (_) { /* detached */ }
    PRiSM_plot_ariaSummary(canvas, opts, cfg, plotKey);
    S.cur = {
        canvas: canvas, ctx: setup.ctx, plot: setup.plot, render: render, opts: opts, extra: setup.extra,
        data: cfg.data || null, plotKey: plotKey, scaleX: sx, scaleY: sy, auto: auto, zoomed: zoomed,
        sig: sig, points: cfg.points || [], xName: cfg.xName || 'x', yName: cfg.yName || 'y',
        result: cfg.result || null
    };
    PRiSM_plot_paint(S, 'initial');
    PRiSM_plot_install(canvas, S);
}

// P10: the plot is an image to assistive technology — role="img" plus a text
// summary (plot, axes, point count and data ranges). An author-set label wins.
function PRiSM_plot_ariaSummary(canvas, opts, cfg, plotKey) {
    try {
        if (!canvas || typeof canvas.setAttribute !== 'function') return;
        if (canvas.hasAttribute && canvas.hasAttribute('aria-label') && !canvas.hasAttribute('data-a11y-auto')) return;
        const pts = cfg.sigPoints || cfg.points || [];   // the measured series (Bourdet: Δp, not Δp + derivative)
        let n = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
            n++;
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        const name = String(opts.title || plotKey || 'PRiSM') + ' plot';
        const xn = String(cfg.xName || 'x'), yn = String(cfg.yName || 'y');
        const f = function (v) { return PRiSM_plot_format_eng(v, 3); };
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('data-a11y-auto', '1');
        canvas.setAttribute('aria-label', name + ': ' + yn + ' against ' + xn + '. ' +
            (n ? n + ' points; ' + xn + ' ' + f(x0) + ' to ' + f(x1) + ', ' + yn + ' ' + f(y0) + ' to ' + f(y1) + '.' : 'No data points.'));
    } catch (_) { /* a label is a nicety — never break a plot */ }
}

function PRiSM_plot_decorate(S) {
    const cur = S.cur;
    const ax = cur && cur.canvas._prismAxes;
    if (!ax) return;
    ax.plotKey = cur.plotKey;
    ax.dataSig = cur.sig;
    ax.userView = cur.zoomed ? { x: PRiSM_plot_copyScale(cur.scaleX), y: PRiSM_plot_copyScale(cur.scaleY) } : null;
    ax.autoScale = { x: PRiSM_plot_copyScale(cur.auto.x), y: PRiSM_plot_copyScale(cur.auto.y) };
    ax.points = cur.points;
    if (cur.result) ax.result = cur.result;
}

function PRiSM_plot_runHooks(S, reason) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const o = cur.opts || {};
    const info = { canvas: cur.canvas, plotKey: cur.plotKey, data: cur.data, opts: o,
                   axes: cur.canvas._prismAxes || null, reason: reason };
    if (typeof o.postDraw === 'function') {
        try { o.postDraw(info); } catch (e) { try { console.warn('PRiSM plot postDraw failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    const want = o.postDrawHooks === true ||
        (o.postDrawHooks !== false && typeof o.plotKey === 'string' && !!o.plotKey);
    const hooks = PRiSM_PLOT_G.PRiSM_postDrawHooks;
    if (!want || !hooks || typeof hooks.length !== 'number') return;
    for (let i = 0; i < hooks.length; i++) {
        const h = hooks[i];
        const fn = typeof h === 'function' ? h : (h && typeof h.fn === 'function' ? h.fn : null);
        if (!fn) continue;
        try { fn(info); } catch (e) { try { console.warn('PRiSM post-draw hook failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
}

// Full repaint. reason: 'initial' | 'view' | 'reset' | 'resize'
function PRiSM_plot_paint(S, reason) {
    const cur = S.cur;
    if (!cur) return;
    if (reason === 'resize') {
        const r = PRiSM_plot_applySize(cur.canvas, cur.opts || {}, S, cur.extra);
        Object.assign(cur.plot, r.plot);
    }
    S.snap = null;
    if (reason !== 'initial') S.hover = null;
    try { cur.render(); }
    catch (e) { try { console.warn('PRiSM plot render failed:', e && e.message); } catch (_) { /* ignore */ } return; }
    if (cur.empty) return;
    PRiSM_plot_decorate(S);
    if (reason !== 'initial') PRiSM_plot_runHooks(S, reason);
}

function PRiSM_plot_schedule(S, reason) {
    S.rafReason = (S.rafReason === 'resize' || reason === 'resize') ? 'resize' : reason;
    if (S.raf != null) return;
    const G = PRiSM_PLOT_G;
    if (typeof G.requestAnimationFrame === 'function') {
        S.raf = G.requestAnimationFrame(function () { S.raf = null; PRiSM_plot_flushPaint(S); });
    } else {
        PRiSM_plot_flushPaint(S);
    }
}

function PRiSM_plot_flushPaint(S) {
    const G = PRiSM_PLOT_G;
    if (S.raf != null) {
        try { if (typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(S.raf); } catch (_) { /* ignore */ }
        S.raf = null;
    }
    const reason = S.rafReason;
    S.rafReason = null;
    if (reason) PRiSM_plot_paint(S, reason);
}

function PRiSM_plot_emitView(S) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const canvas = cur.canvas;
    const detail = { plotKey: cur.plotKey, zoomed: !!cur.zoomed,
                     view: { x: PRiSM_plot_copyScale(cur.scaleX), y: PRiSM_plot_copyScale(cur.scaleY) } };
    try {
        const CE = PRiSM_PLOT_G.CustomEvent;
        if (typeof CE === 'function' && typeof canvas.dispatchEvent === 'function') {
            canvas.dispatchEvent(new CE('prism:plot-view-changed', { bubbles: true, detail: detail }));
        }
    } catch (_) { /* ignore */ }
}

function PRiSM_plot_clearLongPress(S) {
    if (S.lpTimer != null) {
        try { PRiSM_PLOT_G.clearTimeout(S.lpTimer); } catch (_) { /* ignore */ }
        S.lpTimer = null;
    }
}

function PRiSM_plot_abortGesture(S) {
    if (!S) return;
    PRiSM_plot_clearLongPress(S);
    S.gesture = null;
    if (S.raf != null) {
        try { if (typeof PRiSM_PLOT_G.cancelAnimationFrame === 'function') PRiSM_PLOT_G.cancelAnimationFrame(S.raf); } catch (_) { /* ignore */ }
        S.raf = null;
    }
    S.rafReason = null;
}

// View maths in "u-space" (log10 for log axes, value for linear axes).
function PRiSM_plot_uRange(scale) {
    return scale.kind === 'log' ? [Math.log10(scale.min), Math.log10(scale.max)] : [scale.min, scale.max];
}

function PRiSM_plot_setU(scale, a, b) {
    if (!isFinite(a) || !isFinite(b)) return false;
    if (b < a) { const t = a; a = b; b = t; }
    let span = b - a;
    const mid = (a + b) / 2;
    if (scale.kind === 'log') {
        const s2 = Math.min(40, Math.max(0.02, span));
        if (s2 !== span) { span = s2; a = mid - span / 2; b = mid + span / 2; }
        if (a < -300 || b > 300) return false;
        scale.min = Math.pow(10, a);
        scale.max = Math.pow(10, b);
    } else {
        const minSpan = Math.max(Math.abs(mid) * 1e-9, 1e-12);
        if (!(span >= minSpan)) { span = minSpan; a = mid - span / 2; b = mid + span / 2; }
        if (!isFinite(span) || span > 1e300) return false;
        scale.min = a;
        scale.max = b;
    }
    return true;
}

function PRiSM_plot_viewU(cur) {
    return { x: PRiSM_plot_uRange(cur.scaleX), y: PRiSM_plot_uRange(cur.scaleY) };
}

function PRiSM_plot_localXY(canvas, S, e) {
    let r = null;
    try { r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null; } catch (_) { r = null; }
    const left = r ? (r.left || 0) : 0, top = r ? (r.top || 0) : 0;
    // CSS-scaled canvases (max-width:100% on a phone): map to plot px.
    const kx = (r && r.width > 0 && S.cssW > 0) ? S.cssW / r.width : 1;
    const ky = (r && r.height > 0 && S.cssH > 0) ? S.cssH / r.height : 1;
    return { x: ((+e.clientX || 0) - left) * kx, y: ((+e.clientY || 0) - top) * ky };
}

function PRiSM_plot_inPlot(plot, p, slop) {
    slop = slop || 0;
    return p.x >= plot.x - slop && p.x <= plot.x + plot.w + slop &&
           p.y >= plot.y - slop && p.y <= plot.y + plot.h + slop;
}

function PRiSM_plot_nearest(cur, pos, radius) {
    const ax = cur.canvas._prismAxes;
    if (!ax || !cur.points || !cur.points.length) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < cur.points.length; i++) {
        const p = cur.points[i];
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
        const x = ax.toX(p[0]), y = ax.toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        const d = (x - pos.x) * (x - pos.x) + (y - pos.y) * (y - pos.y);
        if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > radius * radius) return null;
    return {
        p: best,
        label: cur.xName + ' ' + PRiSM_plot_format_eng(best[0], 4) + ' · ' +
               (best[2] || cur.yName) + ' ' + PRiSM_plot_format_eng(best[1], 4)
    };
}

function PRiSM_plot_snapshot(canvas) {
    try {
        const doc = PRiSM_PLOT_G.document;
        if (!doc || typeof doc.createElement !== 'function') return null;
        const s = doc.createElement('canvas');
        s.width = canvas.width; s.height = canvas.height;
        const sc = s.getContext ? s.getContext('2d') : null;
        if (!sc || typeof sc.drawImage !== 'function') return null;
        sc.drawImage(canvas, 0, 0);
        return s;
    } catch (_) { return null; }
}

// Light-weight frame for hover / box-zoom: restore the cached frame
// (which includes whatever post-draw hooks painted) and draw on top.
function PRiSM_plot_overlayFrame(S) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const ctx = cur.ctx, plot = cur.plot;
    if (!S.snap) S.snap = PRiSM_plot_snapshot(cur.canvas);
    if (S.snap) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(S.snap, 0, 0);
        ctx.restore();
    } else {
        try { cur.render(); } catch (_) { return; }
        PRiSM_plot_decorate(S);
    }
    const g = S.gesture;
    if (g && g.mode === 'box') {
        ctx.save();
        ctx.fillStyle = 'rgba(88,166,255,0.10)';
        ctx.strokeStyle = PRiSM_THEME.blue;
        ctx.lineWidth = 1;
        const rx = Math.min(g.x0, g.x1), ry = Math.min(g.y0, g.y1);
        const rw = Math.abs(g.x1 - g.x0), rh = Math.abs(g.y1 - g.y0);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
        ctx.restore();
    }
    const ax = cur.canvas._prismAxes;
    if (S.hover && ax) {
        const px = ax.toX(S.hover.p[0]), py = ax.toY(S.hover.p[1]);
        if (isFinite(px) && isFinite(py)) {
            ctx.save();
            ctx.strokeStyle = PRiSM_THEME.text2;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(plot.x, py + 0.5); ctx.lineTo(plot.x + plot.w, py + 0.5);
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = PRiSM_THEME.accent;
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fill();
            const label = S.hover.label;
            ctx.font = '11px sans-serif';
            const tw = (ctx.measureText(label).width || 0) + 12;
            const th = 18;
            let tx = px + 8, ty = py - th - 8;
            if (tx + tw > plot.x + plot.w) tx = Math.max(plot.x, px - tw - 8);
            if (ty < plot.y) ty = py + 8;
            ctx.fillStyle = 'rgba(13,17,23,0.92)';
            ctx.fillRect(tx, ty, tw, th);
            ctx.strokeStyle = PRiSM_THEME.border;
            ctx.strokeRect(tx + 0.5, ty + 0.5, tw, th);
            ctx.fillStyle = PRiSM_THEME.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, tx + 6, ty + th / 2);
            ctx.restore();
        }
    }
}

function PRiSM_plot_zoomAbout(cur, pos, fx, fy) {
    const plot = cur.plot;
    const vx = PRiSM_plot_uRange(cur.scaleX), vy = PRiSM_plot_uRange(cur.scaleY);
    const fxr = (pos.x - plot.x) / plot.w, fyr = (plot.y + plot.h - pos.y) / plot.h;
    if (fx !== 1) {
        const sx = (vx[1] - vx[0]) * fx, ux = vx[0] + fxr * (vx[1] - vx[0]);
        PRiSM_plot_setU(cur.scaleX, ux - fxr * sx, ux - fxr * sx + sx);
    }
    if (fy !== 1) {
        const sy = (vy[1] - vy[0]) * fy, uy = vy[0] + fyr * (vy[1] - vy[0]);
        PRiSM_plot_setU(cur.scaleY, uy - fyr * sy, uy - fyr * sy + sy);
    }
    cur.zoomed = true;
}

function PRiSM_plot_applyPan(cur, v0, dx, dy) {
    const plot = cur.plot;
    const sx = v0.x[1] - v0.x[0], sy = v0.y[1] - v0.y[0];
    const ox = dx / plot.w * sx, oy = dy / plot.h * sy;
    PRiSM_plot_setU(cur.scaleX, v0.x[0] - ox, v0.x[1] - ox);
    PRiSM_plot_setU(cur.scaleY, v0.y[0] + oy, v0.y[1] + oy);
    cur.zoomed = true;
}

function PRiSM_plot_pinchPoints(S, g) {
    const a = S.pointers.get(g.ids[0]), b = S.pointers.get(g.ids[1]);
    return (a && b) ? [a, b] : null;
}

function PRiSM_plot_startPinch(S, cur) {
    const ids = Array.from(S.pointers.keys()).slice(-2);
    const g = { mode: 'pinch', ids: ids };
    const pts = PRiSM_plot_pinchPoints(S, g);
    if (!pts) return null;
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    g.d0 = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    g.dx0 = Math.max(1, Math.abs(dx));
    g.dy0 = Math.max(1, Math.abs(dy));
    g.axis = Math.abs(dx) > 2.5 * Math.abs(dy) ? 'x' : (Math.abs(dy) > 2.5 * Math.abs(dx) ? 'y' : 'xy');
    g.m0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    g.view0 = PRiSM_plot_viewU(cur);
    return g;
}

function PRiSM_plot_updatePinch(S, cur, g) {
    const pts = PRiSM_plot_pinchPoints(S, g);
    if (!pts) return false;
    const plot = cur.plot;
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    const d1 = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const m1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const rx = g.axis === 'y' ? 1 : (g.axis === 'x' ? g.dx0 / Math.max(1, Math.abs(dx)) : g.d0 / d1);
    const ry = g.axis === 'x' ? 1 : (g.axis === 'y' ? g.dy0 / Math.max(1, Math.abs(dy)) : g.d0 / d1);
    const v0 = g.view0;
    const sx0 = v0.x[1] - v0.x[0], sy0 = v0.y[1] - v0.y[0];
    const umx = v0.x[0] + (g.m0.x - plot.x) / plot.w * sx0;
    const sx1 = sx0 * rx;
    const ax = umx - (m1.x - plot.x) / plot.w * sx1;
    PRiSM_plot_setU(cur.scaleX, ax, ax + sx1);
    const umy = v0.y[0] + (plot.y + plot.h - g.m0.y) / plot.h * sy0;
    const sy1 = sy0 * ry;
    const ay = umy - (plot.y + plot.h - m1.y) / plot.h * sy1;
    PRiSM_plot_setU(cur.scaleY, ay, ay + sy1);
    cur.zoomed = true;
    return true;
}

function PRiSM_plot_zoomBox(S, cur, g) {
    const plot = cur.plot;
    const dx = Math.abs(g.x1 - g.x0), dy = Math.abs(g.y1 - g.y0);
    const zx = dx >= 6 && (dy >= 6 || dx >= 12);
    const zy = dy >= 6 && (dx >= 6 || dy >= 12);
    if (!zx && !zy) return false;
    const vx = PRiSM_plot_uRange(cur.scaleX), vy = PRiSM_plot_uRange(cur.scaleY);
    if (zx) {
        const f0 = (Math.min(g.x0, g.x1) - plot.x) / plot.w, f1 = (Math.max(g.x0, g.x1) - plot.x) / plot.w;
        PRiSM_plot_setU(cur.scaleX, vx[0] + f0 * (vx[1] - vx[0]), vx[0] + f1 * (vx[1] - vx[0]));
    }
    if (zy) {
        const f0 = (plot.y + plot.h - Math.max(g.y0, g.y1)) / plot.h, f1 = (plot.y + plot.h - Math.min(g.y0, g.y1)) / plot.h;
        PRiSM_plot_setU(cur.scaleY, vy[0] + f0 * (vy[1] - vy[0]), vy[0] + f1 * (vy[1] - vy[0]));
    }
    cur.zoomed = true;
    return true;
}

function PRiSM_plot_makeHandlers(canvas, S) {
    const G = PRiSM_PLOT_G;
    const LONG_PRESS_MS = 600, SLOP = 8;
    const live = function () { return (S.cur && !S.cur.empty) ? S.cur : null; };
    const finishView = function () {
        if (S.raf != null || S.rafReason) { S.rafReason = S.rafReason || 'view'; PRiSM_plot_flushPaint(S); }
        PRiSM_plot_emitView(S);
    };
    const startLongPress = function () {
        PRiSM_plot_clearLongPress(S);
        if (typeof G.setTimeout !== 'function') return;
        S.lpTimer = G.setTimeout(function () {
            S.lpTimer = null;
            const g = S.gesture;
            if (!g || g.mode !== 'press') return;
            g.consumed = true;
            PRiSM_plotResetView(canvas);
        }, LONG_PRESS_MS);
    };

    const down = function (e) {
        const cur = live();
        if (!cur || !S.pointers) return;
        const o = cur.opts || {};
        if (PRiSM_plot_dprChanged(S)) { S.rafReason = 'resize'; PRiSM_plot_flushPaint(S); }
        const pos = PRiSM_plot_localXY(canvas, S, e);
        const type = e.pointerType || 'mouse';
        // Clear the read-out, then drop the cached frame: click handlers of
        // other layers (analysis keys) may draw on this press, and the next
        // overlay must be built on top of their marks, not erase them.
        if (S.hover) { S.hover = null; PRiSM_plot_overlayFrame(S); }
        S.snap = null;
        S.pointers.set(e.pointerId, { x: pos.x, y: pos.y, type: type });
        const touchLike = type === 'touch' || type === 'pen';
        if (S.pointers.size === 1) {
            if (!PRiSM_plot_inPlot(cur.plot, pos, 4)) return;
            if (touchLike) {
                if (!o.dragZoom && !o.hover) return;
                S.gesture = { mode: 'press', id: e.pointerId, x0: pos.x, y0: pos.y, t0: PRiSM_plot_now(),
                              view0: PRiSM_plot_viewU(cur), touch: true, consumed: false };
                if (o.dragZoom) startLongPress();
            } else {
                if (!o.dragZoom) return;
                const btn = e.button || 0;
                if (btn === 1 || (btn === 0 && (e.shiftKey || e.altKey))) {
                    S.gesture = { mode: 'pan', id: e.pointerId, x0: pos.x, y0: pos.y, view0: PRiSM_plot_viewU(cur) };
                } else if (btn === 0) {
                    S.gesture = { mode: 'box', id: e.pointerId, x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
                } else return;
            }
            if (o.dragZoom) { try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
        } else if (S.pointers.size >= 2 && o.dragZoom) {
            PRiSM_plot_clearLongPress(S);
            const g = PRiSM_plot_startPinch(S, cur);
            if (g) {
                S.gesture = g;
                S.hover = null;
                try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            }
        }
    };

    const move = function (e) {
        const cur = live();
        if (!cur || !S.pointers) return;
        const o = cur.opts || {};
        const pos = PRiSM_plot_localXY(canvas, S, e);
        const rec = S.pointers.get(e.pointerId);
        if (rec) { rec.x = pos.x; rec.y = pos.y; }
        const g = S.gesture;
        if (g && g.mode === 'pinch') {
            if (rec && PRiSM_plot_updatePinch(S, cur, g)) PRiSM_plot_schedule(S, 'view');
            return;
        }
        if (g && g.mode === 'done') return;
        if (g && g.id === e.pointerId) {
            if (g.mode === 'box') {
                const p = cur.plot;
                g.x1 = Math.max(p.x, Math.min(p.x + p.w, pos.x));
                g.y1 = Math.max(p.y, Math.min(p.y + p.h, pos.y));
                if (!g.drawn && Math.abs(g.x1 - g.x0) < 3 && Math.abs(g.y1 - g.y0) < 3) return;
                g.drawn = true;
                PRiSM_plot_overlayFrame(S);
                return;
            }
            const dx = pos.x - g.x0, dy = pos.y - g.y0;
            if (g.mode === 'press') {
                if (Math.sqrt(dx * dx + dy * dy) < SLOP) return;
                PRiSM_plot_clearLongPress(S);
                if (!o.dragZoom) { S.gesture = null; return; }
                g.mode = 'pan';
            }
            if (g.mode === 'pan') {
                PRiSM_plot_applyPan(cur, g.view0, dx, dy);
                S.hover = null;
                PRiSM_plot_schedule(S, 'view');
            }
            return;
        }
        if (!g && o.hover && (e.pointerType || 'mouse') === 'mouse') {
            if (PRiSM_plot_dprChanged(S)) { S.rafReason = 'resize'; PRiSM_plot_flushPaint(S); }
            if (!PRiSM_plot_inPlot(cur.plot, pos)) {
                if (S.hover) { S.hover = null; PRiSM_plot_overlayFrame(S); }
                return;
            }
            const h = PRiSM_plot_nearest(cur, pos, 30);
            if (!h && !S.hover) return;
            S.hover = h;
            PRiSM_plot_overlayFrame(S);
        }
    };

    const end = function (e, cancelled) {
        if (S.pointers) S.pointers.delete(e.pointerId);
        try { if (canvas.releasePointerCapture) canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const g = S.gesture;
        const cur = live();
        if (!g) return;
        if (!cur) { S.gesture = null; PRiSM_plot_clearLongPress(S); return; }
        if (g.mode === 'pinch') {
            if (!S.pointers || S.pointers.size < 2) {
                S.gesture = (S.pointers && S.pointers.size) ? { mode: 'done' } : null;
                finishView();
            }
            return;
        }
        if (g.mode === 'done') { if (!S.pointers || !S.pointers.size) S.gesture = null; return; }
        if (g.id !== e.pointerId) return;
        PRiSM_plot_clearLongPress(S);
        S.gesture = null;
        if (g.mode === 'box') {
            if (!cancelled && PRiSM_plot_zoomBox(S, cur, g)) {
                PRiSM_plot_paint(S, 'view');
                PRiSM_plot_emitView(S);
            } else if (g.drawn) {
                PRiSM_plot_overlayFrame(S);      // wipe the rubber band only
            }
            return;
        }
        if (g.mode === 'pan') { finishView(); return; }
        if (g.mode === 'press' && !g.consumed && !cancelled && (cur.opts || {}).hover) {
            const pos = PRiSM_plot_localXY(canvas, S, e);
            S.hover = PRiSM_plot_nearest(cur, pos, 40);
            PRiSM_plot_overlayFrame(S);
        }
    };

    const up = function (e) { end(e, false); };
    const cancel = function (e) { end(e, true); };

    const leave = function (e) {
        if ((e.pointerType || 'mouse') !== 'mouse') return;
        if (S.hover && !S.gesture) { S.hover = null; PRiSM_plot_overlayFrame(S); }
        if (!S.gesture) S.snap = null;   // re-cache on re-entry (other layers may draw meanwhile)
    };

    const dbl = function () {
        const cur = live();
        if (cur && (cur.opts || {}).dragZoom) PRiSM_plotResetView(canvas);
    };

    const wheel = function (e) {
        const cur = live();
        if (!cur || !(cur.opts || {}).dragZoom) return;
        if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls the page
        const pos = PRiSM_plot_localXY(canvas, S, e);
        if (!PRiSM_plot_inPlot(cur.plot, pos)) return;
        if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
        let d = +e.deltaY || 0;
        if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
        d = Math.max(-100, Math.min(100, d));
        const f = Math.exp(d * 0.005);
        PRiSM_plot_zoomAbout(cur, pos, f, f);
        S.hover = null;
        S.rafReason = 'view';
        PRiSM_plot_flushPaint(S);
        PRiSM_plot_emitView(S);
    };

    const ctxmenu = function (e) {
        // Long-press on touch would open the system menu — suppress while a
        // finger is down on an interactive plot.
        let touching = false;
        if (S.pointers) S.pointers.forEach(function (p) { if (p.type === 'touch' || p.type === 'pen') touching = true; });
        if (touching && live() && (live().opts || {}).dragZoom && typeof e.preventDefault === 'function') e.preventDefault();
    };

    return { down: down, move: move, up: up, cancel: cancel, leave: leave, dbl: dbl, wheel: wheel, ctxmenu: ctxmenu };
}

// devicePixelRatio moved since the last paint (window dragged to another
// screen, browser zoom, host pane rescaled) → backing store must be rebuilt.
function PRiSM_plot_dprChanged(S) {
    const d = PRiSM_PLOT_G.devicePixelRatio || 1;
    return !!S.dpr && Math.abs(d - S.dpr) > 1e-6;
}

function PRiSM_plot_observe(canvas, S) {
    if (S.ro || !(S.relW || S.relH)) return;
    const RO = PRiSM_PLOT_G.ResizeObserver;
    if (typeof RO !== 'function' || !canvas.isConnected) return;
    try {
        S.ro = new RO(function (entries) {
            if (!S.cur) return;
            let w = 0, h = 0;
            for (let i = 0; i < (entries ? entries.length : 0); i++) {
                const en = entries[i];
                if (en && en.target && en.target !== canvas) continue;
                const r = en && en.contentRect;
                if (r) { w = r.width; h = r.height; }
            }
            if (!(w > 0 && h > 0)) { w = canvas.clientWidth; h = canvas.clientHeight; }
            if (!(w >= 2 && h >= 2)) return;          // hidden — redraw when shown
            if (Math.abs(w - S.cssW) < 1 && Math.abs(h - S.cssH) < 1 && !PRiSM_plot_dprChanged(S)) return;
            PRiSM_plot_schedule(S, 'resize');
        });
        S.ro.observe(canvas);
    } catch (_) { S.ro = null; }
}

function PRiSM_plot_install(canvas, S) {
    const cur = S.cur;
    if (!cur) return;
    const o = cur.opts || {};
    const pan = !!o.dragZoom && !cur.empty;
    const hov = !!o.hover && !cur.empty;
    const st = canvas.style;
    if (st) {
        if (pan) {
            st.touchAction = 'none';
            try {
                if (typeof st.setProperty === 'function') {
                    st.setProperty('-webkit-touch-callout', 'none');
                    st.setProperty('-webkit-user-select', 'none');
                    st.setProperty('user-select', 'none');
                }
            } catch (_) { /* ignore */ }
            S.touchSet = true;
        } else if (S.touchSet) {
            st.touchAction = S.authorTouch;
            S.touchSet = false;
        }
    }
    if ((pan || hov) && !S.installed && typeof canvas.addEventListener === 'function' && S.pointers) {
        const h = PRiSM_plot_makeHandlers(canvas, S);
        canvas.addEventListener('pointerdown', h.down);
        canvas.addEventListener('pointermove', h.move);
        canvas.addEventListener('pointerup', h.up);
        canvas.addEventListener('pointercancel', h.cancel);
        canvas.addEventListener('pointerleave', h.leave);
        canvas.addEventListener('dblclick', h.dbl);
        canvas.addEventListener('wheel', h.wheel, { passive: false });
        canvas.addEventListener('contextmenu', h.ctxmenu);
        S.handlers = h;
        S.installed = true;
    }
    PRiSM_plot_observe(canvas, S);
}

// ── Public view API ─────────────────────────────────────────────────
function PRiSM_plotResetView(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return false;
    const cur = S.cur;
    cur.scaleX.min = cur.auto.x.min; cur.scaleX.max = cur.auto.x.max;
    cur.scaleY.min = cur.auto.y.min; cur.scaleY.max = cur.auto.y.max;
    cur.zoomed = false;
    S.hover = null;
    PRiSM_plot_abortGesture(S);
    PRiSM_plot_paint(S, 'reset');
    PRiSM_plot_emitView(S);
    return true;
}

function PRiSM_plotSetView(canvas, view) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return false;
    const cur = S.cur;
    if (!PRiSM_plot_applyView(cur.scaleX, cur.scaleY, view)) return false;
    cur.zoomed = true;
    PRiSM_plot_abortGesture(S);
    PRiSM_plot_paint(S, 'view');
    PRiSM_plot_emitView(S);
    return true;
}

function PRiSM_plotGetView(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return null;
    return { x: PRiSM_plot_copyScale(S.cur.scaleX), y: PRiSM_plot_copyScale(S.cur.scaleY),
             zoomed: !!S.cur.zoomed, plotKey: S.cur.plotKey };
}

// Kept for backward compatibility (older callers / docs). Interaction is
// now installed once per canvas by PRiSM_plot_finish.
function PRiSM_plot_attach_interactions(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (S) PRiSM_plot_install(canvas, S);
}

// ════════════════════════════════════════════════════════════════════
// ── NUMERICAL HELPERS (exported) ────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// BOURDET DERIVATIVE — log-smoothed (unchanged algorithm)
//
//   d[i] = ((Δp[i] - Δp[i-1])/dl1) * (dl2/dlT)
//        + ((Δp[i+1] - Δp[i])/dl2) * (dl1/dlT)
//
//   where dl1 = ln t[i] - ln t[i-1], dl2 = ln t[i+1] - ln t[i],
//         dlT = ln t[i+1] - ln t[i-1].
// Feed it SIGN-AWARE Δp (see CLAUDE.md). t may be any positive,
// increasing time function (Δt, Agarwal, exp(superposition)).
// ─────────────────────────────────────────────────────────────────────
function PRiSM_compute_bourdet(t, dp, L) {
    L = (isFinite(L) && L > 0) ? L : 0; // optional smoothing window in log units
    const n = t.length;
    const d = new Array(n).fill(NaN);
    if (n < 3) return d;
    for (let i = 1; i < n - 1; i++) {
        if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
        // Walk outward to find points that are at least L apart in ln t
        let i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            const lnT = Math.log(t[i]);
            while (i1 > 0 && lnT - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - lnT < L) i2++;
        }
        const t1 = t[i1], t2 = t[i2], ti = t[i];
        if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
        const dl1 = Math.log(ti) - Math.log(t1);
        const dl2 = Math.log(t2) - Math.log(ti);
        const dlT = Math.log(t2) - Math.log(t1);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        const a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
        const b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        d[i] = a + b;
    }
    return d;
}

// Resolves the Bourdet implementation at call time (window override
// first) so a derivative computation is observable / replaceable.
function PRiSM_plot_bourdetImpl() {
    const w = PRiSM_PLOT_G.PRiSM_compute_bourdet;
    return typeof w === 'function' ? w : PRiSM_compute_bourdet;
}

// Sign-aware Δp from absolute pressure (CLAUDE.md rule):
//   sign = +1 build-up / injection (p rises), −1 drawdown / fall-off.
function PRiSM_plot_signedDp(p, pRef, sign) {
    const n = p.length;
    const ref = isFinite(pRef) ? pRef : p[0];
    const s = (sign === 1 || sign === -1) ? sign : ((p[n - 1] - p[0]) >= 0 ? 1 : -1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = s * (p[i] - ref);
    return { dp: out, sign: s, pRef: ref };
}

// Unit factor from opts.timeUnit to DAYS (decline volumes).
function PRiSM_plot_timeUnit(opts) {
    const u = String((opts && opts.timeUnit) || 'd').toLowerCase();
    if (/^(h|hr|hrs|hour|hours)$/.test(u)) return { label: 'hr', toDays: 1 / 24 };
    if (/^(mo|mon|month|months)$/.test(u)) return { label: 'months', toDays: 30.4375 };
    if (/^(y|yr|yrs|year|years)$/.test(u)) return { label: 'yr', toDays: 365.25 };
    return { label: 'days', toDays: 1 };
}

function PRiSM_plot_rateUnits(opts) {
    const r = String((opts && opts.rateUnit) || 'STB/d');
    const gas = /mscf|mcf|scf|m3/i.test(r);
    const vol = (opts && opts.volumeUnit) || (gas ? r.replace(/\s*\/\s*d(ay)?$/i, '') : 'STB');
    return { rate: r, volume: vol, cumName: gas ? 'Gp' : 'Np' };
}

// Cumulative production Np[i] = Σ ½(q_i + q_{i−1})·Δt_days (trapezoid).
function PRiSM_plot_cumulative(t, q, timeUnit) {
    const n = Math.min(t ? t.length : 0, q ? q.length : 0);
    const k = PRiSM_plot_timeUnit({ timeUnit: timeUnit }).toDays;
    const out = new Array(n);
    if (!n) return out;
    out[0] = 0;
    for (let i = 1; i < n; i++) {
        const dt = (t[i] - t[i - 1]) * k;
        const inc = 0.5 * ((+q[i] || 0) + (+q[i - 1] || 0)) * dt;
        out[i] = out[i - 1] + (isFinite(inc) ? inc : 0);
    }
    return out;
}

// Rate steps [{t (start), q}] from data.rateHistory / data.periods /
// (data.q + absolute time). Consecutive equal rates are merged.
function PRiSM_plot_rateSteps(data, tAbs) {
    let steps = [];
    const rh = PRiSM_plot_arr(data.rateHistory);
    const pr = PRiSM_plot_arr(data.periods);
    if (rh) {
        for (let i = 0; i < rh.length; i++) {
            const r = rh[i] || {};
            const ts = PRiSM_plot_num(r.t_start, r.t, r.t0, r.start);
            if (isFinite(ts) && PRiSM_plot_isNum(r.q)) steps.push({ t: ts, q: +r.q });
        }
    } else if (pr) {
        for (let i = 0; i < pr.length; i++) {
            const r = pr[i] || {};
            const ts = PRiSM_plot_num(r.t0, r.start, r.tStart);
            if (isFinite(ts) && PRiSM_plot_isNum(r.q)) steps.push({ t: ts, q: +r.q });
        }
    } else if (PRiSM_plot_arr(data.q) && tAbs && data.q.length === tAbs.length) {
        let last = NaN;
        for (let i = 0; i < tAbs.length; i++) {
            const q = +data.q[i];
            if (!isFinite(q) || !isFinite(tAbs[i])) continue;
            if (!(Math.abs(q - last) <= 1e-9 * Math.max(1, Math.abs(q)))) {
                // A rate sample holds over the interval that ends at it, so
                // the step starts at the previous sample time.
                const ts = steps.length ? tAbs[Math.max(0, i - 1)] : Math.min(0, tAbs[i]);
                steps.push({ t: ts, q: q });
                last = q;
            }
        }
    }
    steps = steps.filter(function (s) { return isFinite(s.t) && isFinite(s.q); })
                 .sort(function (a, b) { return a.t - b.t; });
    const merged = [];
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i], m = merged[merged.length - 1];
        if (m && Math.abs(s.q - m.q) <= 1e-9 * Math.max(1, Math.abs(s.q))) continue;
        if (m && Math.abs(s.t - m.t) < 1e-12) { m.q = s.q; continue; }
        merged.push({ t: s.t, q: s.q });
    }
    return merged.length ? merged : null;
}

// Superposition time function (Horner-generalised), see header.
//   dt[]    Δt since the start of the analysed step (hours)
//   steps[] [{t: start, q}] sorted; tStart = start of the analysed step
// Returns { x: X[], qRef, shutIn, n } or null.
function PRiSM_plot_superposition_x(dt, steps, tStart) {
    if (!steps || !steps.length || !dt || !dt.length) return null;
    let n = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i].t <= tStart + 1e-9) n = i;
    if (n < 0) return null;
    const qn = steps[n].q;
    let qRef = qn;
    const shutIn = Math.abs(qn) < 1e-12;
    if (shutIn) {
        qRef = 0;
        for (let i = n - 1; i >= 0; i--) if (Math.abs(steps[i].q) > 1e-12) { qRef = steps[i].q; break; }
    }
    if (!qRef) return null;
    const Tn = steps[n].t;
    const X = new Array(dt.length);
    for (let j = 0; j < dt.length; j++) {
        const d = dt[j];
        if (!(d > 0)) { X[j] = NaN; continue; }
        let s = 0;
        for (let i = 0; i <= n; i++) {
            const qPrev = i === 0 ? 0 : steps[i - 1].q;
            const arg = Tn - steps[i].t + d;
            if (!(arg > 0)) { s = NaN; break; }
            s += (steps[i].q - qPrev) / qRef * Math.log10(arg);
        }
        X[j] = s;
    }
    return { x: X, qRef: qRef, shutIn: shutIn, n: n };
}

// ════════════════════════════════════════════════════════════════════
// ── TRANSIENT (PTA) PLOTS ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 1. Cartesian P vs t (history) — periods shaded, rate on a right axis.
function PRiSM_plot_cartesian(canvas, data, opts) {
    opts = opts || {};
    const qArr = data && PRiSM_plot_arr(data.q);
    let qMax = -Infinity, qMin = Infinity;
    if (qArr && opts.showRate !== false) {
        for (let i = 0; i < qArr.length; i++) {
            const v = +qArr[i];
            if (isFinite(v)) { if (v > qMax) qMax = v; if (v < qMin) qMin = v; }
        }
    }
    const hasQ = isFinite(qMax) && (qMax !== 0 || qMin !== 0);
    const setup = PRiSM_plot_setup(canvas, opts, { secondaryAxis: hasQ });
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No pressure data');
    const tRange = PRiSM_plot_range(data.t, false);
    const pRange = PRiSM_plot_range(data.p, false);
    const overlayP = data.overlay && PRiSM_plot_arr(data.overlay.p) ? data.overlay.p : null;
    if (overlayP) {
        const oR = PRiSM_plot_range(overlayP, false);
        pRange.min = Math.min(pRange.min, oR.min);
        pRange.max = Math.max(pRange.max, oR.max);
    }
    const ru = PRiSM_plot_rateUnits(opts);
    const scaleX = { kind: 'lin', min: tRange.min, max: tRange.max, label: opts.xLabel || 'Time, t (hr)' };
    const scaleY = { kind: 'lin', min: pRange.min, max: pRange.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const scaleY2 = hasQ ? {
        min: Math.min(0, qMin), max: (qMax > 0 ? qMax : Math.abs(qMin) || 1) * 1.15,
        label: opts.y2Label || ('Rate, q (' + ru.rate + ')'), color: PRiSM_THEME.cyan
    } : null;
    const points = [];
    for (let i = 0; i < data.t.length; i++) points.push([data.t[i], data.p[i]]);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            canvas: canvas, title: opts.title || 'Cartesian P vs t', scaleY2: scaleY2
        });
        PRiSM_plot_periods(ctx, data.periods, opts.activePeriod, tr.toX, plot);
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        if (hasQ && tr.toY2) {
            // Step line of the rate history. Each rate sample covers the
            // interval that ENDS at it (a change is placed at the last sample
            // of the old rate — the same convention as the rate steps used by
            // the analysis), so the jump is drawn at the previous sample.
            ctx.save();
            ctx.strokeStyle = 'rgba(57,197,207,0.75)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false, lastX = NaN;
            for (let i = 0; i < data.t.length && i < qArr.length; i++) {
                const ti = data.t[i], qi = +qArr[i];
                if (!isFinite(ti) || !isFinite(qi)) continue;
                const x = tr.toX(ti), y = tr.toY2(qi);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else { ctx.lineTo(lastX, y); ctx.lineTo(x, y); }
                lastX = x;
            }
            ctx.stroke();
            ctx.restore();
        }
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        if (overlayP) {
            const opts_pts = PRiSM_plot_zip(data.overlay.t || data.t, overlayP);
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured p', color: PRiSM_THEME.accent }];
            if (overlayP) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (hasQ) legend.push({ label: 'Rate q', color: PRiSM_THEME.cyan });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'cartesian',
                                       data: data, xName: 't', yName: 'p' });
}

// 2. Horner — P vs (tp + Δt) / Δt on semi-log x. tp is REQUIRED.
//   The build-up sweeps from right (Δt small, ratio large) to left
//   (Δt large, ratio → 1). p* is read at ratio = 1.
function PRiSM_plot_horner(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No build-up data');
    const tp = PRiSM_plot_pos(data.tp, opts.tp);
    if (!(tp > 0)) return PRiSM_plot_noData(setup, 'Set tp on Tab 1 → Well & Test');
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const dt = data.t[i];
        if (!isFinite(dt) || dt <= 0 || !isFinite(data.p[i])) continue;
        xs.push((tp + dt) / dt);
        ys.push(data.p[i]);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid Horner points (Δt must be > 0)');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xRange = PRiSM_plot_range(xs, true);
    if (xRange.min > 1) xRange.min = 1;
    const yVals = ys.slice();
    if (line) yVals.push(line.b);
    const yRange = PRiSM_plot_range(yVals, false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || 'Horner time (tp + Δt) / Δt' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, pws (psia)' };
    const points = PRiSM_plot_zip(xs, ys);
    let win = null;
    if (line) {
        if (isFinite(line.x0) && isFinite(line.x1)) win = [Math.pow(10, line.x0), Math.pow(10, line.x1)];
        else if (line.t0 > 0 && line.t1 > 0) win = [(tp + line.t0) / line.t0, (tp + line.t1) / line.t1];
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Horner Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 1.5 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                const dt = ot[i];
                if (!isFinite(dt) || dt <= 0) continue;
                oxs.push((tp + dt) / dt);
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (R) { return Math.log10(R); }, win);
        }
        // p* guide at Horner ratio = 1.
        const px = tr.toX(1);
        if (px >= plot.x && px <= plot.x + plot.w) {
            ctx.save();
            ctx.strokeStyle = 'rgba(63,185,80,0.4)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
            if (!line) {        // with a line the p* value label below replaces it
                ctx.fillStyle = PRiSM_THEME.green;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('p* at ratio = 1', px + 4, plot.y + 14);
            }
            ctx.restore();
        }
        if (line) PRiSM_plot_keyPoint(ctx, tr, plot, 1, line.b, 'p* ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'horner',
                                       data: data, xName: 'ratio', yName: 'pws', result: { tp: tp } });
}

// 3. MDH — P vs log10 Δt (semilog drawdown / Miller-Dyes-Hutchinson).
function PRiSM_plot_mdh(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No pressure data');
    const points = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = data.t[i], p = data.p[i];
        if (isFinite(t) && t > 0 && isFinite(p)) points.push([t, p]);
    }
    if (!points.length) return PRiSM_plot_noData(setup, 'No valid points (Δt must be > 0)');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xRange = PRiSM_plot_range(points.map(function (p) { return p[0]; }), true);
    const yRange = PRiSM_plot_range(points.map(function (p) { return p[1]; }), false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, pwf (psia)' };
    let win = null;
    if (line) {
        if (line.t0 > 0 && line.t1 > 0) win = [line.t0, line.t1];
        else if (isFinite(line.x0) && isFinite(line.x1)) win = [Math.pow(10, line.x0), Math.pow(10, line.x1)];
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'MDH Semilog (p vs log Δt)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, 'rgba(240,136,62,0.45)', { width: 1 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const op = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) if (ot[i] > 0 && isFinite(data.overlay.p[i])) op.push([ot[i], data.overlay.p[i]]);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (t) { return Math.log10(t); }, win);
            PRiSM_plot_keyPoint(ctx, tr, plot, 1, line.b, 'p1hr ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent, marker: 'dot' }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'mdh',
                                       data: data, xName: 'Δt', yName: 'p' });
}

// 4. Bourdet log-log diagnostic — KEYSTONE plot (C6).
//   Δp as a line, Δp′ as filled circles, both exactly as supplied.
//   Slope guides: unit (WBS), ½ (linear), ¼ (bilinear), 0 (radial).
function PRiSM_plot_bourdet(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot, S = setup.S;
    if (!PRiSM_plot_isData(data) || !(PRiSM_plot_arr(data.dp) || PRiSM_plot_arr(data.p))) {
        return PRiSM_plot_noData(setup, 'No pressure data');
    }
    const t = data.t;
    const L = PRiSM_plot_isNum(opts.smoothL) ? +opts.smoothL : (PRiSM_plot_isNum(data.L) ? +data.L : 0.1);
    let dp, dpSign = NaN, dpRef = NaN, derivGiven = false;
    if (PRiSM_plot_arr(data.dp)) {
        dp = data.dp;
    } else {
        const sd = PRiSM_plot_signedDp(data.p, PRiSM_plot_num(data.pRef), PRiSM_plot_num(data.sign));
        dp = sd.dp; dpSign = sd.sign; dpRef = sd.pRef;
        PRiSM_plot_warnOnce(S, 'dpFallback', '[PRiSM plots] Bourdet: data.dp missing — Δp derived from p with pRef = ' +
            PRiSM_plot_fmtP(dpRef) + ' psia, sign ' + (dpSign > 0 ? '+1 (build-up)' : '−1 (drawdown)') +
            '. Pass sign-aware Δp from PRiSM_getAnalysisData for correct skin.');
    }
    let deriv;
    if (PRiSM_plot_arr(data.deriv) && data.deriv.length === t.length) {
        deriv = data.deriv; derivGiven = true;
    } else {
        const xs = (PRiSM_plot_arr(data.x) && data.x.length === t.length) ? data.x : t;
        deriv = PRiSM_plot_bourdetImpl()(xs, dp, L);
    }
    const dpPts = [], drPts = [];
    for (let i = 0; i < t.length; i++) {
        const ti = +t[i];
        if (!(ti > 0) || !isFinite(ti)) continue;
        const a = +dp[i], d = +deriv[i];
        if (isFinite(a) && a > 0) dpPts.push([ti, a, 'Δp']);
        if (isFinite(d) && d > 0) drPts.push([ti, d, 'Δp′']);
    }
    if (!dpPts.length && !drPts.length) {
        return PRiSM_plot_noData(setup, 'No positive Δp — check test type / pi on Tab 1');
    }
    const allX = dpPts.map(function (p) { return p[0]; }).concat(drPts.map(function (p) { return p[0]; }));
    const allY = dpPts.map(function (p) { return p[1]; }).concat(drPts.map(function (p) { return p[1]; }));
    const xR = PRiSM_plot_range(allX, true);
    const yR = PRiSM_plot_range(allY, true, null, 6);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Δp, Δp′ (psi)' };

    // Overlay (model): overlay.dp / overlay.deriv as given (C6).
    let modelDp = null, modelDr = null;
    const ov = data.overlay;
    if (ov && (PRiSM_plot_arr(ov.dp) || PRiSM_plot_arr(ov.p))) {
        const ot = PRiSM_plot_arr(ov.t) ? ov.t : t;
        let odp;
        if (PRiSM_plot_arr(ov.dp)) odp = ov.dp;
        else odp = PRiSM_plot_signedDp(ov.p, isFinite(dpRef) ? dpRef : PRiSM_plot_num(ov.pRef, data.pRef),
                                        isFinite(dpSign) ? dpSign : PRiSM_plot_num(ov.sign, data.sign)).dp;
        let odr;
        if (PRiSM_plot_arr(ov.deriv) && ov.deriv.length === ot.length) odr = ov.deriv;
        else {
            const oxs = (PRiSM_plot_arr(ov.x) && ov.x.length === ot.length) ? ov.x : ot;
            odr = PRiSM_plot_bourdetImpl()(oxs, odp, L);
        }
        modelDp = []; modelDr = [];
        for (let i = 0; i < ot.length; i++) {
            const ti = +ot[i];
            if (!(ti > 0)) continue;
            if (+odp[i] > 0) modelDp.push([ti, +odp[i]]);
            if (+odr[i] > 0) modelDr.push([ti, +odr[i]]);
        }
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            canvas: canvas,
            title: opts.title || 'Log-Log Bourdet Derivative'
        });
        // ── Slope guides anchored to the data ────────────────────────
        //   • WBS (1) through the EARLIEST derivative point;
        //   • radial (0) at the late-time derivative level;
        //   • ½ and ¼ at the geometric centre of the view.
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        let earlyAnchor = null, lateAnchor = null;
        if (drPts.length >= 2) {
            earlyAnchor = { x: drPts[0][0], y: drPts[0][1] };
            const nLate = Math.max(2, Math.floor(drPts.length * 0.25));
            let sumLog = 0;
            for (let li = drPts.length - nLate; li < drPts.length; li++) sumLog += Math.log(drPts[li][1]);
            lateAnchor = {
                x: drPts[Math.max(0, drPts.length - Math.floor(nLate / 2)) - 1][0],
                y: Math.exp(sumLog / nLate)
            };
        }
        const midX = Math.sqrt(scaleX.min * scaleX.max);
        const midY = Math.sqrt(scaleY.min * scaleY.max);
        const slopes = [
            { m: 1.0,  label: 'WBS (slope 1)',     color: 'rgba(248,81,73,0.55)',
              anchor: earlyAnchor || { x: scaleX.min, y: midY } },
            { m: 0.5,  label: 'Linear (slope ½)',  color: 'rgba(210,153,34,0.40)',
              anchor: { x: midX, y: midY } },
            { m: 0.25, label: 'Bilinear (¼)',      color: 'rgba(188,140,255,0.35)',
              anchor: { x: midX, y: midY * 0.6 } },
            { m: 0.0,  label: 'Radial (slope 0)',  color: 'rgba(63,185,80,0.55)',
              anchor: lateAnchor || { x: scaleX.max, y: midY } }
        ];
        slopes.forEach(function (s) {
            const xL = scaleX.min, xRr = scaleX.max;
            const yL = s.anchor.y * Math.pow(xL / s.anchor.x, s.m);
            const yRr = s.anchor.y * Math.pow(xRr / s.anchor.x, s.m);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = (s.m === 1.0 || s.m === 0.0) ? 1.5 : 1.0;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(xL), tr.toY(yL));
            ctx.lineTo(tr.toX(xRr), tr.toY(yRr));
            ctx.stroke();
            ctx.setLineDash([]);
            if (s.anchor && (earlyAnchor || lateAnchor) && (s.m === 1.0 || s.m === 0.0)) {
                ctx.fillStyle = s.color.replace(/0\.\d+\)/, '0.95)');
                ctx.beginPath();
                ctx.arc(tr.toX(s.anchor.x), tr.toY(s.anchor.y), 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.fillStyle = s.color.replace(/0\.\d+\)/, '0.95)');
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            const ly = Math.max(plot.y + 2, Math.min(plot.y + plot.h - 2, tr.toY(yRr)));
            ctx.fillText(s.label, plot.x + plot.w - 4, ly - 2);
        });
        // Series
        PRiSM_plot_line(ctx, dpPts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, drPts, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        if (modelDp) {
            PRiSM_plot_line(ctx, modelDp, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
            PRiSM_plot_line(ctx, modelDr, tr.toX, tr.toY, PRiSM_THEME.cyan, { width: 1.5, dash: [4, 3] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [
                { label: 'Δp', color: PRiSM_THEME.accent },
                { label: derivGiven ? 'Δp′' : 'Δp′ (Bourdet)', color: PRiSM_THEME.green, marker: 'dot' }
            ];
            if (modelDp) legend.push({ label: 'Model Δp', color: PRiSM_THEME.blue, dash: true });
            if (modelDr) legend.push({ label: 'Model Δp′', color: PRiSM_THEME.cyan, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, {
        scaleX: scaleX, scaleY: scaleY, points: dpPts.concat(drPts), sigPoints: dpPts.length ? dpPts : drPts,
        plotKey: 'bourdet', data: data, xName: 'Δt', yName: 'Δp',
        result: { derivGiven: derivGiven, L: derivGiven ? null : L, dpSource: isFinite(dpSign) ? 'p-fallback' : 'dp' }
    });
}

// Shared body for the three "p vs f(t)" linear diagnostic plots.
function PRiSM_plot_transformedTime(canvas, data, opts, cfg) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No data');
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = data.t[i];
        if (!isFinite(t) || !cfg.ok(t) || !isFinite(data.p[i])) continue;
        xs.push(cfg.f(t));
        ys.push(data.p[i]);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No data');
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || cfg.xLabel };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || cfg.title });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || !cfg.ok(ot[i])) continue;
                oxs.push(cfg.f(ot[i]));
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: cfg.plotKey,
                                       data: data, xName: cfg.xName, yName: 'p' });
}

// 5. Square-root time — P vs √t (linear) — diagnostic for linear flow
function PRiSM_plot_sqrt_time(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'sqrt', title: 'Square-Root Time', xLabel: '√Δt  (hr^½)', xName: '√t',
        ok: function (t) { return t >= 0; }, f: function (t) { return Math.sqrt(t); }
    });
}

// 6. Quarter-root time — P vs t^¼ — diagnostic for bilinear flow
function PRiSM_plot_quarter_root_time(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'quarter', title: 'Quarter-Root Time (Bilinear)', xLabel: 'Δt^¼  (hr^¼)', xName: 't^¼',
        ok: function (t) { return t >= 0; }, f: function (t) { return Math.pow(t, 0.25); }
    });
}

// 7. Spherical flow — P vs t^(-½) — partial penetration diagnostic
function PRiSM_plot_spherical(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'spherical', title: 'Spherical Flow (Partial Penetration)', xLabel: 'Δt^(-½)  (hr^-½)', xName: 't^-½',
        ok: function (t) { return t > 0; }, f: function (t) { return Math.pow(t, -0.5); }
    });
}

// 8. Material-balance time — P vs te = Σq·Δt / q_n (log x).
//   te is the equivalent constant-rate time of each flowing sample; it is
//   undefined while q = 0 (shut-in), so those points are left out.
function PRiSM_plot_sandface_convolution(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p) || !PRiSM_plot_arr(data.q)) {
        return PRiSM_plot_noData(setup, 'Needs t, p and q for material-balance time');
    }
    const t = data.t, p = data.p, q = data.q;
    let qScale = 0;
    for (let i = 0; i < q.length; i++) if (isFinite(+q[i])) qScale = Math.max(qScale, Math.abs(+q[i]));
    const teq = new Array(t.length);
    let cum = 0, skipped = 0;
    for (let i = 0; i < t.length; i++) {
        const dt = (i === 0) ? t[i] : (t[i] - t[i - 1]);
        const qi = +q[i] || 0;
        if (isFinite(dt) && dt > 0) cum += qi * dt;
        if (Math.abs(qi) <= 1e-9 * Math.max(1, qScale)) { teq[i] = NaN; skipped++; continue; }
        teq[i] = cum / qi;
    }
    const xs = [], ys = [];
    for (let i = 0; i < t.length; i++) {
        if (!isFinite(teq[i]) || teq[i] <= 0 || !isFinite(p[i])) continue;
        xs.push(teq[i]); ys.push(p[i]);
    }
    if (!xs.length) {
        return PRiSM_plot_noData(setup, skipped
            ? 'Material-balance time is undefined while q = 0 (shut-in) — use the Horner or superposition plot'
            : 'No valid material-balance time');
    }
    const xR = PRiSM_plot_range(xs, true);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Material-balance time Σq·Δt/q_n (hr)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Material-Balance Time' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            // Overlay values are mapped by sample index onto the same te.
            const op = [];
            for (let i = 0; i < t.length && i < data.overlay.p.length; i++) {
                if (isFinite(teq[i]) && teq[i] > 0) op.push([teq[i], data.overlay.p[i]]);
            }
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (skipped) {
            ctx.fillStyle = PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(skipped + ' shut-in point' + (skipped > 1 ? 's' : '') + ' (q = 0) not shown',
                plot.x + 6, plot.y + plot.h - 4);
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'sandface',
                                       data: data, xName: 'te', yName: 'p', result: { skipped: skipped } });
}

// 9. Build-up / multi-rate superposition — P vs the superposition time
//   function X (see header). Normalised by the analysed rate, or by the
//   last NON-ZERO flowing rate for a shut-in. p* at X = 0.
function PRiSM_plot_buildup_superposition(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No data');
    const p = data.p;
    let X = null, shutIn = null, qRef = NaN, mode = '';
    const tStartGiven = PRiSM_plot_num(data.tStart);
    const tAbs = PRiSM_plot_arr(data.tAbs) ? data.tAbs : (isFinite(tStartGiven) ? null : data.t);
    const steps = PRiSM_plot_rateSteps(data, tAbs);
    if (steps) {
        let dts, tStart;
        if (isFinite(tStartGiven)) { tStart = tStartGiven; dts = data.t; }
        else {
            tStart = steps[steps.length - 1].t;
            dts = tAbs.map(function (v) { return v - tStart; });
        }
        const sx = PRiSM_plot_superposition_x(dts, steps, tStart);
        if (sx) { X = sx.x; shutIn = sx.shutIn; qRef = sx.qRef; mode = 'rates'; }
    }
    if (!X && PRiSM_plot_arr(data.x) && data.x.length === data.t.length) {
        const tt = String(data.testType || '').toLowerCase();
        shutIn = /build|fall/.test(tt) || (PRiSM_plot_num(data.sign) === 1 && !/inj/.test(tt));
        X = Array.prototype.map.call(data.x, function (v) { return v > 0 ? (shutIn ? -1 : 1) * Math.log10(v) : NaN; });
        mode = 'x';
    }
    if (!X) {
        const tp = PRiSM_plot_pos(data.tp, opts.tp);
        if (tp > 0) {
            X = Array.prototype.map.call(data.t, function (dt) { return dt > 0 ? Math.log10((tp + dt) / dt) : NaN; });
            shutIn = true; mode = 'tp';
        }
    }
    if (!X) return PRiSM_plot_noData(setup, 'Set tp on Tab 1 → Well & Test (or load a rate history)');
    const xs = [], ys = [];
    for (let i = 0; i < X.length && i < p.length; i++) {
        if (isFinite(X[i]) && isFinite(p[i])) { xs.push(X[i]); ys.push(p[i]); }
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid superposition points');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xR = PRiSM_plot_range(shutIn ? xs.concat([0]) : xs, false);
    const yVals = ys.slice();
    if (line && shutIn) yVals.push(line.b);
    const yR = PRiSM_plot_range(yVals, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max,
                     label: opts.xLabel || (shutIn ? 'Superposition time Σ(Δqᵢ/q)·log((T−Tᵢ+Δt)/Δt)' : 'Superposition time Σ(Δqᵢ/q)·log(T−Tᵢ+Δt)') };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);
    const win = line && isFinite(line.x0) && isFinite(line.x1) ? [line.x0, line.x1] : null;

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Superposition Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 1.5 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p) && data.overlay.p.length === X.length) {
            const op = [];
            for (let i = 0; i < X.length; i++) if (isFinite(X[i])) op.push([X[i], data.overlay.p[i]]);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (shutIn) {
            const px = tr.toX(0);
            if (px >= plot.x && px <= plot.x + plot.w) {
                ctx.strokeStyle = 'rgba(63,185,80,0.4)';
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (x) { return x; }, win);
            if (shutIn) PRiSM_plot_keyPoint(ctx, tr, plot, 0, line.b, 'p* ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: shutIn ? 'Build-up' : 'Flowing', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'superposition',
                                       data: data, xName: 'X', yName: 'p',
                                       result: { mode: mode, shutIn: !!shutIn, qRef: qRef } });
}

// ════════════════════════════════════════════════════════════════════
// ── DECLINE (DCA) PLOTS ─────────────────────────────────────────────
// t in DAYS by default (opts.timeUnit), q in opts.rateUnit (STB/d).
// ════════════════════════════════════════════════════════════════════

function PRiSM_plot_rateTime(canvas, data, opts, cfg) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts), ru = PRiSM_plot_rateUnits(opts);
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = +data.t[i], q = +data.q[i];
        if (!isFinite(t) || !isFinite(q)) continue;
        if (cfg.xLog && !(t > 0)) continue;
        if (cfg.yLog && !(q > 0)) continue;
        pts.push([t, q]);
    }
    if (!pts.length) return PRiSM_plot_noData(setup, 'No positive data');
    const xR = PRiSM_plot_range(pts.map(function (p) { return p[0]; }), cfg.xLog);
    const yR = PRiSM_plot_range(pts.map(function (p) { return p[1]; }), cfg.yLog);
    const scaleX = { kind: cfg.xLog ? 'log' : 'lin', min: xR.min, max: xR.max, label: opts.xLabel || ('Time, t (' + tu.label + ')') };
    const scaleY = { kind: cfg.yLog ? 'log' : 'lin', min: cfg.yLog ? yR.min : Math.max(0, yR.min), max: yR.max,
                     label: opts.yLabel || ('Rate, q (' + ru.rate + ')') };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || cfg.title });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const op = [];
            for (let i = 0; i < ot.length; i++) {
                const t = +ot[i], q = +data.overlay.q[i];
                if (cfg.xLog && !(t > 0)) continue;
                if (cfg.yLog && !(q > 0)) continue;
                op.push([t, q]);
            }
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: pts, plotKey: cfg.plotKey,
                                       data: data, xName: 't', yName: 'q' });
}

// 10. Rate vs time, linear (cartesian)
function PRiSM_plot_rate_time_cartesian(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateCart', title: 'Rate vs Time (Cartesian)', xLog: false, yLog: false });
}

// 11. Semi-log: rate-time with log y-axis (exponential decline → straight)
function PRiSM_plot_rate_time_semilog(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateSemi', title: 'Rate vs Time (Semi-log)', xLog: false, yLog: true });
}

// 12. Log-log rate-time (hyperbolic / harmonic curvature visible)
function PRiSM_plot_rate_time_loglog(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateLog', title: 'Rate vs Time (Log-Log)', xLog: true, yLog: true });
}

// Least-squares window for the rate-cumulative EUR tangent.
//   eurWindow: fraction (0,1] of the last points (default 0.3), an
//   integer count ≥ 2, or {t0, t1} in the plot's time unit.
function PRiSM_plot_eurWindow(t, n, w) {
    if (w && typeof w === 'object' && (PRiSM_plot_isNum(w.t0) || PRiSM_plot_isNum(w.t1))) {
        const a = PRiSM_plot_num(w.t0, -Infinity), b = PRiSM_plot_num(w.t1, Infinity);
        const idx = [];
        for (let i = 0; i < n; i++) if (t[i] >= a && t[i] <= b) idx.push(i);
        return idx;
    }
    let k;
    if (PRiSM_plot_isNum(w) && +w > 1) k = Math.round(+w);
    else k = Math.round(n * ((PRiSM_plot_isNum(w) && +w > 0) ? +w : 0.3));
    k = Math.max(2, Math.min(n, k));
    const idx = [];
    for (let i = n - k; i < n; i++) idx.push(i);
    return idx;
}

// 13. Rate vs cumulative — q vs Np (trapezoid, Δt converted to days)
function PRiSM_plot_rate_cumulative(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts), ru = PRiSM_plot_rateUnits(opts);
    const Np = (PRiSM_plot_arr(opts.cum) && opts.cum.length === data.t.length)
        ? Array.prototype.slice.call(opts.cum)
        : PRiSM_plot_cumulative(data.t, data.q, opts.timeUnit);
    const pts = [];
    for (let i = 0; i < Np.length; i++) if (isFinite(Np[i]) && isFinite(+data.q[i])) pts.push([Np[i], +data.q[i]]);
    if (!pts.length) return PRiSM_plot_noData(setup, 'No valid cumulative data');
    // EUR tangent (only on request): LS line q = a + s·Np over the window.
    let eur = null;
    if (opts.showTangentEUR && pts.length >= 2) {
        const tIdx = [];
        for (let i = 0; i < data.t.length; i++) if (isFinite(Np[i]) && isFinite(+data.q[i])) tIdx.push(+data.t[i]);
        const idx = PRiSM_plot_eurWindow(tIdx, pts.length, opts.eurWindow);
        if (idx.length >= 2) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            idx.forEach(function (i) { const x = pts[i][0], y = pts[i][1]; sx += x; sy += y; sxy += x * y; sxx += x * x; });
            const n = idx.length, den = n * sxx - sx * sx;
            if (den !== 0) {
                const s = (n * sxy - sx * sy) / den, a = (sy - s * sx) / n;
                if (s < 0 && isFinite(s) && isFinite(a) && a > 0) eur = { value: -a / s, slope: s, intercept: a, from: pts[idx[0]][0] };
            }
        }
    }
    const xVals = pts.map(function (p) { return p[0]; });
    if (eur) xVals.push(eur.value);
    const xR = PRiSM_plot_range(xVals, false);
    const yR = PRiSM_plot_range(pts.map(function (p) { return p[1]; }), false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max,
                     label: opts.xLabel || ('Cumulative, ' + ru.cumName + ' (' + ru.volume + ')') };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || ('Rate, q (' + ru.rate + ')') };
    if (eur) scaleY.min = 0;

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Rate vs Cumulative' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const oNp = PRiSM_plot_cumulative(ot, data.overlay.q, opts.timeUnit);
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oNp, data.overlay.q), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (eur) {
            ctx.strokeStyle = 'rgba(63,185,80,0.7)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(eur.from), tr.toY(eur.intercept + eur.slope * eur.from));
            ctx.lineTo(tr.toX(eur.value), tr.toY(0));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = PRiSM_THEME.green;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText('EUR ≈ ' + PRiSM_plot_format_eng(eur.value, 3) + ' ' + ru.volume,
                Math.min(plot.x + plot.w - 4, tr.toX(eur.value)), tr.toY(0) - 6);
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            if (eur) legend.push({ label: 'EUR tangent', color: PRiSM_THEME.green, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, {
        scaleX: scaleX, scaleY: scaleY, points: pts, plotKey: 'rateCum', data: data, xName: ru.cumName, yName: 'q',
        result: { npLast: pts[pts.length - 1][0], eur: eur ? eur.value : null, timeUnit: tu.label }
    });
}

// 14. Loss-ratio: 1/D vs t  where D = -d(ln q)/dt
//   Exponential → constant 1/D; hyperbolic → 1/D = a + b·t (slope b);
//   harmonic → straight line through origin.
function PRiSM_plot_loss_ratio(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts);
    const t = data.t, q = data.q;
    const xs = [], ys = [];
    for (let i = 1; i < t.length - 1; i++) {
        if (q[i] <= 0 || q[i - 1] <= 0 || q[i + 1] <= 0) continue;
        const dlnq = Math.log(q[i + 1]) - Math.log(q[i - 1]);
        const dt = t[i + 1] - t[i - 1];
        if (dt === 0) continue;
        const D = -dlnq / dt;
        if (!isFinite(D) || D <= 0) continue;
        xs.push(t[i]);
        ys.push(1 / D);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid 1/D points (rate must decline)');
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || ('Time, t (' + tu.label + ')') };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || ('Loss ratio 1/D = -dt/d(ln q) (' + tu.label + ')') };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Loss-Ratio (1/D vs t)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        if (points.length >= 3) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            const n = points.length;
            for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
            const denom = n * sxx - sx * sx;
            if (denom !== 0) {
                const m = (n * sxy - sx * sy) / denom;
                const c = (sy - m * sx) / n;
                ctx.strokeStyle = 'rgba(88,166,255,0.7)';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(scaleX.min), tr.toY(c + m * scaleX.min));
                ctx.lineTo(tr.toX(scaleX.max), tr.toY(c + m * scaleX.max));
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = PRiSM_THEME.blue;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('b ≈ ' + m.toFixed(3) + ',  1/Di ≈ ' + PRiSM_plot_format_eng(c) + ' ' + tu.label,
                    plot.x + 8, plot.y + plot.h - 8);
            }
        }
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const oq = data.overlay.q;
            const oxs = [], oys = [];
            for (let i = 1; i < ot.length - 1; i++) {
                if (oq[i] <= 0 || oq[i - 1] <= 0 || oq[i + 1] <= 0) continue;
                const dlnq = Math.log(oq[i + 1]) - Math.log(oq[i - 1]);
                const dt = ot[i + 1] - ot[i - 1];
                if (dt === 0) continue;
                const D = -dlnq / dt;
                if (!isFinite(D) || D <= 0) continue;
                oxs.push(ot[i]); oys.push(1 / D);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: '1/D measured', color: PRiSM_THEME.green, marker: 'dot' }];
            if (data.overlay) legend.push({ label: 'Model 1/D', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'lossRatio',
                                       data: data, xName: 't', yName: '1/D' });
}

// 15. Type-curve overlay — dimensionless qD = q/qi vs tD = Di·t on log-log
//   with a family of Arps b curves. opts.qi / opts.Di (1/time unit) /
//   opts.b (active curve, drawn bold) / opts.bList.
function PRiSM_plot_typecurve_overlay(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    let qFirst = 1;
    for (let i = 0; i < data.q.length; i++) if (+data.q[i] > 0) { qFirst = +data.q[i]; break; }
    const qi = PRiSM_plot_pos(opts.qi) || qFirst;
    const Di = PRiSM_plot_pos(opts.Di) || 1;
    const dataPts = [];
    for (let i = 0; i < data.t.length; i++) {
        const td = data.t[i] * Di;
        const qd = data.q[i] / qi;
        if (td > 0 && qd > 0) dataPts.push([td, qd]);
    }
    if (!dataPts.length) return PRiSM_plot_noData(setup, 'No positive data');
    const bList = (opts.bList && opts.bList.length) ? opts.bList : [0, 0.25, 0.5, 0.75, 1];
    const bActive = PRiSM_plot_isNum(opts.b) ? +opts.b : 0.5;
    const xData = PRiSM_plot_range(dataPts.map(function (p) { return p[0]; }), true);
    const xCurve = { min: Math.min(xData.min, 0.01), max: Math.max(xData.max, 100) };
    const curves = bList.map(function (b) {
        const pts = [];
        const n = 80;
        const lo = Math.log10(xCurve.min), hi = Math.log10(xCurve.max);
        for (let i = 0; i <= n; i++) {
            const td = Math.pow(10, lo + (hi - lo) * i / n);
            const qd = (b === 0) ? Math.exp(-td) : Math.pow(1 + b * td, -1 / b);
            if (qd > 0 && isFinite(qd)) pts.push([td, qd]);
        }
        return { b: b, pts: pts };
    });
    const allY = dataPts.map(function (p) { return p[1]; });
    curves.forEach(function (c) { c.pts.forEach(function (p) { allY.push(p[1]); }); });
    const yR = PRiSM_plot_range(allY, true);
    yR.min = Math.max(yR.min, 1e-3);
    const scaleX = { kind: 'log', min: xCurve.min, max: xCurve.max, label: opts.xLabel || 'tD = Di · t' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'qD = q / qi' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Type-Curve Overlay (Arps qD-tD)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        curves.forEach(function (c) {
            const isActive = Math.abs(c.b - bActive) < 1e-6;
            const color = isActive ? PRiSM_THEME.purple : 'rgba(139,148,158,0.45)';
            PRiSM_plot_line(ctx, c.pts, tr.toX, tr.toY, color, { width: isActive ? 2.5 : 1 });
            const last = c.pts[c.pts.length - 1];
            if (last) {
                const lx = tr.toX(last[0]), ly = tr.toY(last[1]);
                if (lx > plot.x && lx < plot.x + plot.w && ly > plot.y && ly < plot.y + plot.h) {
                    ctx.fillStyle = isActive ? PRiSM_THEME.purple : PRiSM_THEME.text3;
                    ctx.font = isActive ? 'bold 10px sans-serif' : '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('b=' + c.b, lx + 4, ly);
                }
            }
        });
        PRiSM_plot_dots(ctx, dataPts, tr.toX, tr.toY, PRiSM_THEME.accent, 3.5);
        ctx.restore();
        if (opts.showLegend !== false) {
            PRiSM_plot_legend(ctx, [
                { label: 'Data', color: PRiSM_THEME.accent, marker: 'dot' },
                { label: 'Active b=' + bActive, color: PRiSM_THEME.purple },
                { label: 'Other b values', color: PRiSM_THEME.text3 }
            ], plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: dataPts, plotKey: 'typeCurve',
                                       data: data, xName: 'tD', yName: 'qD', result: { qi: qi, Di: Di, b: bActive } });
}

// ════════════════════════════════════════════════════════════════════
// ── WINDOW EXPORTS ──────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════
(function PRiSM_plot_exports() {
    const G = PRiSM_PLOT_G;
    const api = {
        PRiSM_THEME: PRiSM_THEME,
        PRiSM_compute_bourdet: PRiSM_compute_bourdet,
        PRiSM_plot_cartesian: PRiSM_plot_cartesian,
        PRiSM_plot_horner: PRiSM_plot_horner,
        PRiSM_plot_mdh: PRiSM_plot_mdh,
        PRiSM_plot_bourdet: PRiSM_plot_bourdet,
        PRiSM_plot_sqrt_time: PRiSM_plot_sqrt_time,
        PRiSM_plot_quarter_root_time: PRiSM_plot_quarter_root_time,
        PRiSM_plot_spherical: PRiSM_plot_spherical,
        PRiSM_plot_sandface_convolution: PRiSM_plot_sandface_convolution,
        PRiSM_plot_buildup_superposition: PRiSM_plot_buildup_superposition,
        PRiSM_plot_rate_time_cartesian: PRiSM_plot_rate_time_cartesian,
        PRiSM_plot_rate_time_semilog: PRiSM_plot_rate_time_semilog,
        PRiSM_plot_rate_time_loglog: PRiSM_plot_rate_time_loglog,
        PRiSM_plot_rate_cumulative: PRiSM_plot_rate_cumulative,
        PRiSM_plot_loss_ratio: PRiSM_plot_loss_ratio,
        PRiSM_plot_typecurve_overlay: PRiSM_plot_typecurve_overlay,
        // helpers other layers reuse
        PRiSM_plot_format_eng: PRiSM_plot_format_eng,
        PRiSM_plot_format_tick: PRiSM_plot_format_tick,
        PRiSM_plot_setup: PRiSM_plot_setup,
        PRiSM_plot_axes: PRiSM_plot_axes,
        PRiSM_plot_range: PRiSM_plot_range,
        PRiSM_plot_log_ticks: PRiSM_plot_log_ticks,
        PRiSM_plot_lin_ticks: PRiSM_plot_lin_ticks,
        PRiSM_plot_line: PRiSM_plot_line,
        PRiSM_plot_dots: PRiSM_plot_dots,
        PRiSM_plot_legend: PRiSM_plot_legend,
        PRiSM_plot_periods: PRiSM_plot_periods,
        PRiSM_plot_message: PRiSM_plot_message,
        PRiSM_plot_cumulative: PRiSM_plot_cumulative,
        PRiSM_plot_superposition_x: PRiSM_plot_superposition_x,
        PRiSM_plotResetView: PRiSM_plotResetView,
        PRiSM_plotSetView: PRiSM_plotSetView,
        PRiSM_plotGetView: PRiSM_plotGetView
    };
    Object.keys(api).forEach(function (k) {
        try { G[k] = api[k]; } catch (_) { /* read-only global */ }
    });
})();

// ════════════════════════════════════════════════════════════════════
// === SELF-TEST ======================================================
// Runs when this file is executed on its own (node prism-build/02-plots.js)
// — stripped by concat-phase1-2.js. Uses a recording mock canvas, so it
// needs no DOM. Logs one line; never throws.
// ════════════════════════════════════════════════════════════════════
(function PRiSM_plot_selftest() {
    const results = [];
    const check = function (name, ok, info) { results.push({ name: name, ok: !!ok, info: info }); };
    function mockCanvas(w, h) {
        const log = [];
        const state = {};
        const ctx = new Proxy(state, {
            get: function (t, p) {
                if (p in t) return t[p];
                if (p === 'measureText') return function (s) { return { width: String(s).length * 6 }; };
                return function () { log.push([p].concat(Array.prototype.slice.call(arguments))); };
            },
            set: function (t, p, v) { t[p] = v; log.push(['set', p, v]); return true; }
        });
        return {
            width: w, height: h, style: {}, clientWidth: 0, clientHeight: 0, isConnected: false,
            getContext: function () { return ctx; },
            getBoundingClientRect: function () { return { left: 0, top: 0, width: w, height: h }; },
            addEventListener: function () {}, removeEventListener: function () {},
            _log: log
        };
    }
    try {
        // 1. Formatting
        check('format_eng 100/120/850', PRiSM_plot_format_eng(100) === '100' && PRiSM_plot_format_eng(120) === '120' &&
              PRiSM_plot_format_eng(850) === '850');
        check('format_eng 750/1e5/0.0125', PRiSM_plot_format_eng(750) === '750' && PRiSM_plot_format_eng(1e5) === '100k' &&
              PRiSM_plot_format_eng(0.0125) === '0.0125');
        check('format_eng rounding / tiny', PRiSM_plot_format_eng(999950) === '1M' && PRiSM_plot_format_eng(5e-4) === '5e-4');
        check('format_tick linear', PRiSM_plot_format_tick(3400, false, 200) === '3400' &&
              PRiSM_plot_format_tick(0.5, false, 0.5) === '0.5' && PRiSM_plot_format_tick(100, true) === '100');

        // 2. Axes inverse (log + linear)
        const c1 = mockCanvas(600, 400);
        PRiSM_plot_bourdet(c1, { t: [0.1, 1, 10, 100], dp: [10, 40, 90, 140], deriv: [8, 20, 21, 20] }, {});
        const ax = c1._prismAxes;
        let inv = !!ax;
        if (ax) [0.37, 5, 88].forEach(function (v) {
            inv = inv && Math.abs(ax.fromX(ax.toX(v)) / v - 1) < 1e-9 && Math.abs(ax.fromY(ax.toY(v)) / v - 1) < 1e-9;
        });
        check('axes inverse log-log', inv);
        const c2 = mockCanvas(600, 400);
        PRiSM_plot_cartesian(c2, { t: [0, 1, 2, 3], p: [4000, 3900, 3850, 3820] }, {});
        const ax2 = c2._prismAxes;
        check('axes inverse linear', !!ax2 && Math.abs(ax2.fromX(ax2.toX(1.7)) - 1.7) < 1e-9 &&
              Math.abs(ax2.fromY(ax2.toY(3876.5)) - 3876.5) < 1e-6 && ax2.x0 === ax2.plot.x);

        // 3. Bourdet derivative of Δp = 300 + 50·ln t → 50
        const tt = [], dd = [];
        for (let i = 0; i < 40; i++) { const t = Math.pow(10, -2 + i * 0.1); tt.push(t); dd.push(300 + 50 * Math.log(t)); }
        const der = PRiSM_compute_bourdet(tt, dd, 0);
        check('compute_bourdet semilog slope', Math.abs(der[20] - 50) < 1e-9);

        // 4. C6: deriv given → no recomputation
        // (Loaded as a plain page script, top-level function declarations ARE
        // window properties — capture the implementation before wrapping.)
        const G = PRiSM_PLOT_G;
        const prev = G.PRiSM_compute_bourdet;
        const impl = PRiSM_compute_bourdet;
        let calls = 0;
        G.PRiSM_compute_bourdet = function (a, b, c) { calls++; return impl(a, b, c); };
        try {
            PRiSM_plot_bourdet(mockCanvas(600, 400), { t: tt, dp: dd, deriv: der.map(function (v) { return isFinite(v) ? v : 50; }) }, {});
            const noCalls = calls === 0;
            PRiSM_plot_bourdet(mockCanvas(600, 400), { t: tt, dp: dd }, {});
            check('bourdet uses deriv as given', noCalls && calls === 1);
        } finally {
            G.PRiSM_compute_bourdet = prev;
        }

        // 5. Cumulative in days
        const td = [], qd = [];
        for (let i = 0; i <= 30; i++) { td.push(i); qd.push(1000); }
        const np = PRiSM_plot_cumulative(td, qd, 'd');
        check('cumulative 30 d x 1000', Math.abs(np[30] - 30000) < 1e-9);

        // 6. Superposition X (single-rate build-up) == Horner
        const sx = PRiSM_plot_superposition_x([1, 10], [{ t: 0, q: 850 }, { t: 24, q: 0 }], 24);
        check('superposition = Horner', !!sx && Math.abs(sx.x[0] - Math.log10(25)) < 1e-12 &&
              Math.abs(sx.x[1] - Math.log10(3.4)) < 1e-12 && sx.qRef === 850 && sx.shutIn);

        // 7. Every plot renders on a mock canvas
        const ptaT = [], ptaP = [], ptaQ = [];
        for (let i = 0; i < 60; i++) { const t = Math.pow(10, -2 + i * 0.07); ptaT.push(t); ptaP.push(4200 - 60 * Math.log(t + 1) - 100); ptaQ.push(i < 30 ? 1200 : 800); }
        const pta = { t: ptaT, p: ptaP, q: ptaQ, dp: ptaP.map(function (v) { return 4200 - v; }), tp: 100,
                      periods: [{ t0: 0.01, t1: 1, q: 1200 }, { start: 1, end: 100, q: 800 }],
                      line: { m: -25, b: 4100, t0: 1, t1: 10 } };
        const dca = { t: td, q: td.map(function (t) { return 1000 * Math.exp(-0.01 * t); }) };
        const fns = [PRiSM_plot_cartesian, PRiSM_plot_horner, PRiSM_plot_mdh, PRiSM_plot_bourdet, PRiSM_plot_sqrt_time,
                     PRiSM_plot_quarter_root_time, PRiSM_plot_spherical, PRiSM_plot_sandface_convolution,
                     PRiSM_plot_buildup_superposition];
        const dfns = [PRiSM_plot_rate_time_cartesian, PRiSM_plot_rate_time_semilog, PRiSM_plot_rate_time_loglog,
                      PRiSM_plot_rate_cumulative, PRiSM_plot_loss_ratio, PRiSM_plot_typecurve_overlay];
        let thrown = [];
        fns.forEach(function (f) { try { f(mockCanvas(600, 400), pta, { hover: true, dragZoom: true }); } catch (e) { thrown.push(f.name + ': ' + e.message); } });
        dfns.forEach(function (f) { try { f(mockCanvas(360, 300), dca, { showTangentEUR: true }); } catch (e) { thrown.push(f.name + ': ' + e.message); } });
        check('15 plots render', thrown.length === 0, thrown.join('; '));
    } catch (e) {
        check('self-test crashed', false, e && e.message);
    }
    const bad = results.filter(function (r) { return !r.ok; });
    try {
        if (!bad.length) console.log('✓ PRiSM plots self-test: ' + results.length + '/' + results.length + ' checks passed');
        else console.warn('PRiSM plots self-test failures (' + bad.length + '/' + results.length + '):',
            bad.map(function (r) { return r.name + (r.info ? ' — ' + r.info : ''); }));
    } catch (_) { /* no console */ }
})();
