// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Plot Suite (02-plots.js)
// 14 canvas plot functions + shared helpers for the PRiSM Well Test
// Analysis module. Pure vanilla JS, dark theme, retina-aware.
//
// All plots share the universal signature:
//   PRiSM_plot_<NAME>(canvas, data, opts)
//
//   data: { t, p, dp?, q?, periods?, overlay? }
//   opts: { width, height, padding, theme, title, xLabel, yLabel,
//           hover, dragZoom, showLegend, activePeriod }
//
// Designed to be pasted into the main IIFE of well-testing-app.html.
// No ES modules. No external chart libraries. ~1600 LOC.
// ════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// THEME — locked to dark theme of the host app (#0d1117 backdrop)
// ─────────────────────────────────────────────────────────────────────
const PRiSM_THEME = {
    bg:        '#0d1117',
    panel:     '#161b22',
    border:    '#30363d',
    grid:      '#21262d',
    gridMajor: '#30363d',
    text:      '#c9d1d9',
    text2:     '#8b949e',
    text3:     '#6e7681',
    accent:    '#f0883e', // orange — primary series
    blue:      '#58a6ff', // overlay / model curve
    green:     '#3fb950', // derivative / good fit
    red:       '#f85149', // boundaries / bad fit
    yellow:    '#d29922', // half-slope / linear flow
    cyan:      '#39c5cf', // secondary axis
    purple:    '#bc8cff'  // type-curve guides
};

const PRiSM_DEFAULT_PADDING = { top: 30, right: 80, bottom: 48, left: 64 };

// ─────────────────────────────────────────────────────────────────────
// FORMATTING — engineering (k / M / G), scientific fallback
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_format_eng(n, sig) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    sig = sig || 3;
    if (n === 0) return '0';
    const a = Math.abs(n);
    // Use scientific for tiny / huge numbers that don't sit in the
    // common engineering range — keeps tick text short.
    if (a >= 1e6) {
        if (a >= 1e9) return (n / 1e9).toPrecision(sig).replace(/\.?0+$/, '') + 'G';
        return (n / 1e6).toPrecision(sig).replace(/\.?0+$/, '') + 'M';
    }
    if (a >= 1e3) return (n / 1e3).toPrecision(sig).replace(/\.?0+$/, '') + 'k';
    if (a >= 1)   return n.toPrecision(sig).replace(/\.?0+$/, '');
    if (a >= 1e-3) return n.toPrecision(sig).replace(/\.?0+$/, '');
    // Scientific
    return n.toExponential(2).replace(/e([+-])0?(\d)/, 'e$1$2');
}

function PRiSM_plot_format_tick(v, isLog) {
    if (!isFinite(v)) return '';
    if (isLog) {
        // v is the actual decade value (10^k). Show as 10^k for clarity.
        const k = Math.round(Math.log10(Math.abs(v)));
        if (Math.abs(v - Math.pow(10, k)) / Math.pow(10, k) < 1e-6) {
            if (k >= -2 && k <= 5) return PRiSM_plot_format_eng(v);
            return '1e' + k;
        }
        return PRiSM_plot_format_eng(v);
    }
    return PRiSM_plot_format_eng(v);
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
    for (let k = k0; k <= k1; k++) {
        const base = Math.pow(10, k);
        if (base >= min && base <= max) major.push(base);
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
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) {
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
}

// ─────────────────────────────────────────────────────────────────────
// CANVAS SETUP — retina, padding, plot rect
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_setup(canvas, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    // Honour explicit width/height in opts; otherwise use the canvas's
    // CSS box. If the canvas was created with no CSS sizing (e.g. in
    // self-test) fall back to its existing intrinsic size.
    const cssW = opts.width || canvas.clientWidth || canvas.width || 600;
    const cssH = opts.height || canvas.clientHeight || canvas.height || 400;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // crisp on retina
    const pad = Object.assign({}, PRiSM_DEFAULT_PADDING, opts.padding || {});
    const plot = {
        x: pad.left,
        y: pad.top,
        w: cssW - pad.left - pad.right,
        h: cssH - pad.top - pad.bottom,
        cssW: cssW,
        cssH: cssH,
        pad: pad
    };
    return { ctx, plot, dpr };
}

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
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data', plot.x + plot.w / 2, plot.y + plot.h / 2);
}

// ─────────────────────────────────────────────────────────────────────
// AXES — paints background, grid, ticks, labels, title.
// scaleX / scaleY: { kind:'lin'|'log', min, max, label }
// Returns the world->pixel transforms.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_axes(ctx, plot, scaleX, scaleY, opts) {
    opts = opts || {};
    // Background
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.fillStyle = PRiSM_THEME.panel;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    // Tick generation
    const xLog = scaleX.kind === 'log';
    const yLog = scaleY.kind === 'log';
    const xTicks = xLog
        ? PRiSM_plot_log_ticks(scaleX.min, scaleX.max)
        : { major: PRiSM_plot_lin_ticks(scaleX.min, scaleX.max, 7), minor: [] };
    const yTicks = yLog
        ? PRiSM_plot_log_ticks(scaleY.min, scaleY.max)
        : { major: PRiSM_plot_lin_ticks(scaleY.min, scaleY.max, 6), minor: [] };

    // World→pixel transforms (closed over the scale objects so each
    // plot can re-use them after axes are drawn).
    const toX = xLog
        ? (v) => plot.x + (Math.log10(v) - Math.log10(scaleX.min)) /
                          (Math.log10(scaleX.max) - Math.log10(scaleX.min)) * plot.w
        : (v) => plot.x + (v - scaleX.min) / (scaleX.max - scaleX.min) * plot.w;
    const toY = yLog
        ? (v) => plot.y + plot.h - (Math.log10(v) - Math.log10(scaleY.min)) /
                                   (Math.log10(scaleY.max) - Math.log10(scaleY.min)) * plot.h
        : (v) => plot.y + plot.h - (v - scaleY.min) / (scaleY.max - scaleY.min) * plot.h;

    // Minor grid (log only)
    if (xLog && xTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        xTicks.minor.forEach(v => {
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
        yTicks.minor.forEach(v => {
            const py = Math.round(toY(v)) + 0.5;
            ctx.moveTo(plot.x, py);
            ctx.lineTo(plot.x + plot.w, py);
        });
        ctx.stroke();
    }

    // Major grid + tick labels
    ctx.strokeStyle = PRiSM_THEME.gridMajor;
    ctx.lineWidth = 1;
    ctx.fillStyle = PRiSM_THEME.text2;
    ctx.font = '11px sans-serif';

    // X major
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    xTicks.major.forEach(v => {
        const px = Math.round(toX(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, plot.y);
        ctx.lineTo(px, plot.y + plot.h);
        ctx.stroke();
        ctx.fillText(PRiSM_plot_format_tick(v, xLog), px, plot.y + plot.h + 6);
    });

    // Y major
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.major.forEach(v => {
        const py = Math.round(toY(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, py);
        ctx.lineTo(plot.x + plot.w, py);
        ctx.stroke();
        ctx.fillText(PRiSM_plot_format_tick(v, yLog), plot.x - 6, py);
    });

    // Border on top
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);

    // Axis labels
    ctx.fillStyle = PRiSM_THEME.text;
    ctx.font = '12px sans-serif';
    if (scaleX.label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(scaleX.label, plot.x + plot.w / 2, plot.cssH - 8);
    }
    if (scaleY.label) {
        ctx.save();
        ctx.translate(14, plot.y + plot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(scaleY.label, 0, 0);
        ctx.restore();
    }

    // Title
    if (opts.title) {
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.title, plot.x, 8);
    }

    return { toX, toY, xLog, yLog };
}

// ─────────────────────────────────────────────────────────────────────
// LEGEND — top-right, drawn AFTER all series so it sits on top.
// items: [ { label, color, dash:bool, marker:'line'|'dot' } ]
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_legend(ctx, items, plot, opts) {
    if (!items || !items.length) return;
    opts = opts || {};
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    // Measure to size the box
    const padX = 8, padY = 6, lineH = 16, swatch = 18;
    let maxW = 0;
    items.forEach(it => { maxW = Math.max(maxW, ctx.measureText(it.label).width); });
    const boxW = swatch + 6 + maxW + padX * 2;
    const boxH = items.length * lineH + padY * 2 - 4;
    const bx = plot.x + plot.w - boxW - 8;
    const by = plot.y + 8;
    // Background
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
    // Items
    items.forEach((it, i) => {
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
        ctx.fillText(it.label, bx + padX + swatch + 6, ly);
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SHARED — line series, scatter series
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_line(ctx, pts, toX, toY, color, opts) {
    if (!pts || !pts.length) return;
    opts = opts || {};
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width || 2;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
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
    pts.forEach(p => {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) return;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// AUTO-RANGE — computes min/max for an array, padded, log-safe
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_range(arr, isLog, padFrac) {
    if (!arr || !arr.length) return { min: 0, max: 1 };
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (isLog && v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    if (min === max) {
        if (isLog) { min /= 2; max *= 2; }
        else if (min === 0) { max = 1; }
        else { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    }
    if (isLog) {
        // Snap to outer decades for nice ticks.
        const lo = Math.pow(10, Math.floor(Math.log10(min)));
        const hi = Math.pow(10, Math.ceil(Math.log10(max)));
        return { min: lo, max: hi };
    }
    const f = padFrac == null ? 0.05 : padFrac;
    const span = max - min;
    return { min: min - span * f, max: max + span * f };
}

// ─────────────────────────────────────────────────────────────────────
// PERIODS — light shading behind active period
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_periods(ctx, periods, activeIdx, toX, plot) {
    if (!periods || !periods.length) return;
    ctx.save();
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    periods.forEach((pr, i) => {
        if (!pr || !isFinite(pr.start) || !isFinite(pr.end)) return;
        const x0 = toX(pr.start), x1 = toX(pr.end);
        if (i === activeIdx) {
            ctx.fillStyle = 'rgba(240,136,62,0.10)';
            ctx.fillRect(Math.min(x0, x1), plot.y, Math.abs(x1 - x0), plot.h);
            ctx.strokeStyle = PRiSM_THEME.accent;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
            ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = 'rgba(139,148,158,0.45)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
            ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        if (pr.label) {
            ctx.fillStyle = i === activeIdx ? PRiSM_THEME.accent : PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(pr.label, Math.min(x0, x1) + 4, plot.y + 4);
        }
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// HOVER + DRAG-TO-ZOOM — attached per render. Detached on next render
// by overwriting `canvas._prismHandlers`.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_attach_interactions(canvas, ctx, plot, render, ctxState) {
    // Tear down previous handlers if any.
    if (canvas._prismHandlers) {
        const h = canvas._prismHandlers;
        canvas.removeEventListener('mousemove', h.move);
        canvas.removeEventListener('mouseleave', h.leave);
        canvas.removeEventListener('mousedown', h.down);
        canvas.removeEventListener('mouseup', h.up);
        canvas.removeEventListener('dblclick', h.dbl);
    }
    if (!ctxState.opts.hover && !ctxState.opts.dragZoom) {
        canvas._prismHandlers = null;
        return;
    }

    const { toX, toY, xLog, yLog, scaleX, scaleY, points } = ctxState;

    // Cache the original scales so double-click can reset.
    if (!canvas._prismOriginalScale) {
        canvas._prismOriginalScale = { x: { ...scaleX }, y: { ...scaleY } };
    }

    let drag = null; // { x0, y0, x1, y1 }
    let hoverPt = null;

    function pixelFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    }

    function repaint() {
        // Re-run the render callback (which redraws axes + series) then
        // overlay hover/drag artefacts on top.
        render();
        if (drag) {
            ctx.save();
            ctx.fillStyle = 'rgba(88,166,255,0.10)';
            ctx.strokeStyle = PRiSM_THEME.blue;
            ctx.lineWidth = 1;
            const rx = Math.min(drag.x0, drag.x1), ry = Math.min(drag.y0, drag.y1);
            const rw = Math.abs(drag.x1 - drag.x0), rh = Math.abs(drag.y1 - drag.y0);
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
            ctx.restore();
        }
        if (hoverPt) {
            ctx.save();
            const { px, py, label } = hoverPt;
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
            // Tooltip
            ctx.font = '11px sans-serif';
            const tw = ctx.measureText(label).width + 12;
            const th = 18;
            let tx = px + 8, ty = py - th - 8;
            if (tx + tw > plot.x + plot.w) tx = px - tw - 8;
            if (ty < plot.y) ty = py + 8;
            ctx.fillStyle = 'rgba(13,17,23,0.92)';
            ctx.fillRect(tx, ty, tw, th);
            ctx.strokeStyle = PRiSM_THEME.border;
            ctx.lineWidth = 1;
            ctx.strokeRect(tx + 0.5, ty + 0.5, tw, th);
            ctx.fillStyle = PRiSM_THEME.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, tx + 6, ty + th / 2);
            ctx.restore();
        }
    }

    function findNearest(px, py) {
        if (!points || !points.length) return null;
        let best = null, bestD2 = Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
            const x = toX(p[0]), y = toY(p[1]);
            if (!isFinite(x) || !isFinite(y)) continue;
            const d2 = (x - px) * (x - px) + (y - py) * (y - py);
            if (d2 < bestD2) { bestD2 = d2; best = { x, y, p }; }
        }
        if (!best || bestD2 > 30 * 30) return null;
        return best;
    }

    const move = (e) => {
        const { px, py } = pixelFromEvent(e);
        if (drag) { drag.x1 = px; drag.y1 = py; repaint(); return; }
        if (!ctxState.opts.hover) return;
        if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) {
            if (hoverPt) { hoverPt = null; repaint(); }
            return;
        }
        const n = findNearest(px, py);
        if (n) {
            hoverPt = {
                px: n.x, py: n.y,
                label: PRiSM_plot_format_eng(n.p[0]) + ', ' + PRiSM_plot_format_eng(n.p[1])
            };
        } else {
            hoverPt = null;
        }
        repaint();
    };

    const leave = () => { hoverPt = null; drag = null; repaint(); };

    const down = (e) => {
        if (!ctxState.opts.dragZoom) return;
        const { px, py } = pixelFromEvent(e);
        if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) return;
        drag = { x0: px, y0: py, x1: px, y1: py };
    };

    const up = (e) => {
        if (!drag) return;
        const dx = Math.abs(drag.x1 - drag.x0), dy = Math.abs(drag.y1 - drag.y0);
        if (dx < 6 || dy < 6) { drag = null; repaint(); return; }
        // Convert pixel rect to world range and zoom.
        const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
        const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
        // Invert toX/toY by interpolating along the axis range.
        const fx0 = (x0 - plot.x) / plot.w, fx1 = (x1 - plot.x) / plot.w;
        const fy0 = 1 - (y1 - plot.y) / plot.h, fy1 = 1 - (y0 - plot.y) / plot.h;
        if (xLog) {
            const lo = Math.log10(scaleX.min), hi = Math.log10(scaleX.max);
            scaleX.min = Math.pow(10, lo + fx0 * (hi - lo));
            scaleX.max = Math.pow(10, lo + fx1 * (hi - lo));
        } else {
            const lo = scaleX.min, hi = scaleX.max;
            scaleX.min = lo + fx0 * (hi - lo);
            scaleX.max = lo + fx1 * (hi - lo);
        }
        if (yLog) {
            const lo = Math.log10(scaleY.min), hi = Math.log10(scaleY.max);
            scaleY.min = Math.pow(10, lo + fy0 * (hi - lo));
            scaleY.max = Math.pow(10, lo + fy1 * (hi - lo));
        } else {
            const lo = scaleY.min, hi = scaleY.max;
            scaleY.min = lo + fy0 * (hi - lo);
            scaleY.max = lo + fy1 * (hi - lo);
        }
        drag = null;
        repaint();
    };

    const dbl = () => {
        if (canvas._prismOriginalScale) {
            Object.assign(scaleX, canvas._prismOriginalScale.x);
            Object.assign(scaleY, canvas._prismOriginalScale.y);
            repaint();
        }
    };

    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mouseup', up);
    canvas.addEventListener('dblclick', dbl);
    canvas._prismHandlers = { move, leave, down, up, dbl };
}

// ─────────────────────────────────────────────────────────────────────
// COMMON — assemble pairs from data
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_zip(xs, ys) {
    const n = Math.min(xs ? xs.length : 0, ys ? ys.length : 0);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [xs[i], ys[i]];
    return out;
}

function PRiSM_plot_isData(data) {
    return data && Array.isArray(data.t) && data.t.length > 0;
}

// ════════════════════════════════════════════════════════════════════
// ── TRANSIENT (PTA) PLOTS ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 1. Cartesian P vs t
function PRiSM_plot_cartesian(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No pressure data');
        return;
    }
    const tRange = PRiSM_plot_range(data.t, false);
    const pRange = PRiSM_plot_range(data.p, false);
    const overlayP = data.overlay && data.overlay.p ? data.overlay.p : null;
    if (overlayP) {
        const oR = PRiSM_plot_range(overlayP, false);
        pRange.min = Math.min(pRange.min, oR.min);
        pRange.max = Math.max(pRange.max, oR.max);
    }
    const scaleX = { kind: 'lin', min: tRange.min, max: tRange.max, label: opts.xLabel || 'Time, t (hr)' };
    const scaleY = { kind: 'lin', min: pRange.min, max: pRange.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(data.t, data.p);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Cartesian P vs t' });
        PRiSM_plot_periods(ctx, data.periods, opts.activePeriod, tr.toX, plot);
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        if (overlayP) {
            const opts_pts = PRiSM_plot_zip(data.overlay.t || data.t, overlayP);
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (overlayP) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; },
        get yLog() { return false; }
    });
}

// 2. Horner — P vs (tp + Δt)/Δt on semi-log x
//   Semi-log convention: x increases left-to-right but Horner time
//   itself decreases as Δt grows, so the build-up sweeps from right
//   (Δt small, x → ∞) to left (Δt large, x → 1).
function PRiSM_plot_horner(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No build-up data');
        return;
    }
    const tp = isFinite(opts.tp) ? opts.tp : (data.tp || data.t[data.t.length - 1] || 1);
    // Horner ratio: (tp + Δt) / Δt. Δt = data.t (treated as Δt directly
    // for simplicity; UI passes shifted time).
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const dt = data.t[i];
        if (!isFinite(dt) || dt <= 0) continue;
        const h = (tp + dt) / dt;
        if (h <= 0) continue;
        xs.push(h);
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid Horner points'); return; }
    const xRange = PRiSM_plot_range(xs, true);
    const yRange = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || '(tp + Δt) / Δt' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, Pws (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Horner Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && data.overlay.p) {
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
        // Mark Horner ratio = 1 (P*) explicitly with a vertical guide.
        const px = tr.toX(1);
        if (px >= plot.x && px <= plot.x + plot.w) {
            ctx.save();
            ctx.strokeStyle = 'rgba(63,185,80,0.4)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.fillStyle = PRiSM_THEME.green;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('P* (ratio = 1)', px + 4, plot.y + 14);
            ctx.restore();
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return false; }
    });
}

// ─────────────────────────────────────────────────────────────────────
// BOURDET DERIVATIVE — log-smoothed
//
//   d[i] = ((Δp[i] - Δp[i-1])/dl1) * (dl2/dlT)
//        + ((Δp[i+1] - Δp[i])/dl2) * (dl1/dlT)
//
//   where dl1 = ln t[i] - ln t[i-1], dl2 = ln t[i+1] - ln t[i],
//         dlT = ln t[i+1] - ln t[i-1].
// ─────────────────────────────────────────────────────────────────────
function PRiSM_compute_bourdet(t, dp, L) {
    L = L || 0; // optional smoothing window in log units
    const n = t.length;
    const d = new Array(n).fill(NaN);
    if (n < 3) return d;
    for (let i = 1; i < n - 1; i++) {
        if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
        // Walk outward to find points that are at least L apart in ln t
        let i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            const lnT = Math.log(t[i]);
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
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

// 3. Bourdet log-log diagnostic — KEYSTONE plot.
//   Δp as a smooth line, t·dp/d(ln t) as small filled circles.
//   Slope guides shown faintly: unit (WBS), half (linear), quarter
//   (bilinear), zero (radial). The overlay (model) uses the same
//   computation pipeline if pressure is given.
function PRiSM_plot_bourdet(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !(data.p || data.dp)) {
        PRiSM_plot_empty(ctx, plot, 'No pressure data');
        return;
    }
    // Derive Δp if only p was given (assume first point is reference).
    const dp = data.dp ? data.dp.slice() : data.p.map(v => v - data.p[0]);
    const t  = data.t.slice();
    const deriv = PRiSM_compute_bourdet(t, dp, opts.smoothL || 0.1);
    const dpPts = [], drPts = [];
    for (let i = 0; i < t.length; i++) {
        if (t[i] > 0 && dp[i] > 0) dpPts.push([t[i], dp[i]]);
        if (t[i] > 0 && deriv[i] > 0) drPts.push([t[i], deriv[i]]);
    }
    if (!dpPts.length && !drPts.length) {
        PRiSM_plot_empty(ctx, plot, 'No positive Δp data');
        return;
    }
    const allY = dpPts.map(p => p[1]).concat(drPts.map(p => p[1]));
    const xR = PRiSM_plot_range(dpPts.map(p => p[0]), true);
    const yR = PRiSM_plot_range(allY, true);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Δp, Δp′ (psi)' };

    // Overlay (model)
    let modelDp = null, modelDr = null;
    if (data.overlay && (data.overlay.p || data.overlay.dp)) {
        const ot = data.overlay.t || t;
        const odp = data.overlay.dp ? data.overlay.dp.slice() : data.overlay.p.map(v => v - data.overlay.p[0]);
        const odr = PRiSM_compute_bourdet(ot, odp, opts.smoothL || 0.1);
        modelDp = []; modelDr = [];
        for (let i = 0; i < ot.length; i++) {
            if (ot[i] > 0 && odp[i] > 0) modelDp.push([ot[i], odp[i]]);
            if (ot[i] > 0 && odr[i] > 0) modelDr.push([ot[i], odr[i]]);
        }
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            title: opts.title || 'Log-Log Bourdet Derivative'
        });
        // Slope guides (dashed, very faint) — always informative
        ctx.save();
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        const slopes = [
            { m: 1.0, label: 'WBS (slope 1)',     color: 'rgba(248,81,73,0.40)' },
            { m: 0.5, label: 'Linear (slope ½)',  color: 'rgba(210,153,34,0.40)' },
            { m: 0.25, label: 'Bilinear (¼)',     color: 'rgba(188,140,255,0.35)' },
            { m: 0.0, label: 'Radial (slope 0)',  color: 'rgba(63,185,80,0.40)' }
        ];
        // Anchor at left-mid of plot
        const xA = scaleX.min, yMid = Math.sqrt(scaleY.min * scaleY.max);
        slopes.forEach(s => {
            const x1 = scaleX.max;
            const y1 = yMid * Math.pow(x1 / xA, s.m);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(xA), tr.toY(yMid));
            ctx.lineTo(tr.toX(x1), tr.toY(y1));
            ctx.stroke();
            ctx.setLineDash([]);
            // Tiny label
            ctx.fillStyle = s.color.replace(/0\.[34]0?\)/, '0.85)');
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            const ly = Math.max(plot.y + 2, Math.min(plot.y + plot.h - 2, tr.toY(y1)));
            ctx.fillText(s.label, plot.x + plot.w - 4, ly - 2);
        });
        ctx.restore();

        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        // Δp as line
        PRiSM_plot_line(ctx, dpPts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        // Derivative as filled circles
        PRiSM_plot_dots(ctx, drPts, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        // Overlay
        if (modelDp) {
            PRiSM_plot_line(ctx, modelDp, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
            PRiSM_plot_line(ctx, modelDr, tr.toX, tr.toY, PRiSM_THEME.cyan, { width: 1.5, dash: [4, 3] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [
                { label: 'Δp', color: PRiSM_THEME.accent },
                { label: 'Δp′ (Bourdet)', color: PRiSM_THEME.green, marker: 'dot' }
            ];
            if (modelDp) legend.push({ label: 'Model Δp', color: PRiSM_THEME.blue, dash: true });
            if (modelDr) legend.push({ label: 'Model Δp′', color: PRiSM_THEME.cyan, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    // Combine measurement + derivative as the hover point pool
    const points = dpPts.concat(drPts);
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// 4. Square-root time — P vs √t (linear) — diagnostic for linear flow
function PRiSM_plot_sqrt_time(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] < 0) continue;
        xs.push(Math.sqrt(data.t[i]));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || '√t  (hr^½)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Square-Root Time' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] < 0) continue;
                oxs.push(Math.sqrt(ot[i]));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 5. Quarter-root time — P vs t^¼ — diagnostic for bilinear flow
function PRiSM_plot_quarter_root_time(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] < 0) continue;
        xs.push(Math.pow(data.t[i], 0.25));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 't^¼  (hr^¼)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Quarter-Root Time (Bilinear)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] < 0) continue;
                oxs.push(Math.pow(ot[i], 0.25));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 6. Spherical flow — P vs t^(-½) — partial penetration diagnostic
function PRiSM_plot_spherical(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] <= 0) continue;
        xs.push(Math.pow(data.t[i], -0.5));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 't^(-½)  (hr^-½)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            title: opts.title || 'Spherical Flow (Partial Penetration)'
        });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] <= 0) continue;
                oxs.push(Math.pow(ot[i], -0.5));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 7. Sandface convolution — equivalent time = Σ(qi·Δti)/qn  vs P
//   For multi-rate cleanup, the equivalent time normalises
//   build-up against the variable-rate history.
function PRiSM_plot_sandface_convolution(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'Needs t, p and q for convolution');
        return;
    }
    // Equivalent time from rate history.
    const t = data.t, p = data.p, q = data.q;
    const qN = q[q.length - 1] || 1;
    const teq = new Array(t.length);
    let cum = 0;
    for (let i = 0; i < t.length; i++) {
        const dt = (i === 0) ? t[i] : (t[i] - t[i - 1]);
        cum += (q[i] || 0) * dt;
        teq[i] = qN === 0 ? NaN : cum / Math.abs(qN);
    }
    const xs = [], ys = [];
    for (let i = 0; i < t.length; i++) {
        if (!isFinite(teq[i]) || teq[i] <= 0) continue;
        xs.push(teq[i]); ys.push(p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid equivalent time'); return; }
    const xR = PRiSM_plot_range(xs, true);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Equivalent Time Σ(qi·Δti)/qn (hr)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Sandface-Rate Convolution' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const ot = data.overlay.t || t;
            const oxs = [], oys = [];
            // Recompute equivalent time on overlay if rate history given,
            // otherwise reuse measured equivalent time mapping by index.
            let oteq;
            if (data.overlay.q) {
                oteq = new Array(ot.length);
                let oq = data.overlay.q, oN = oq[oq.length - 1] || 1;
                let oc = 0;
                for (let i = 0; i < ot.length; i++) {
                    const dt = (i === 0) ? ot[i] : (ot[i] - ot[i - 1]);
                    oc += (oq[i] || 0) * dt;
                    oteq[i] = oN === 0 ? NaN : oc / Math.abs(oN);
                }
            } else {
                oteq = teq.slice();
            }
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(oteq[i]) || oteq[i] <= 0) continue;
                oxs.push(oteq[i]); oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Convolved', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return false; }
    });
}

// 8. Build-up superposition — P vs Σ log((tp+Δt)/Δt) for multi-rate
//   For single-rate this collapses back to the Horner X.
//   periods: array of { tp_i, q_i } describing the rate history; if
//   absent, falls back to the simple Horner ratio.
function PRiSM_plot_buildup_superposition(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    // If a rate history (data.q) was provided, build the multi-rate
    // superposition time. Otherwise default to ln((tp+Δt)/Δt).
    const t = data.t, p = data.p;
    const tp = isFinite(opts.tp) ? opts.tp : (data.tp || (t[t.length - 1] || 1));
    const xs = [], ys = [];
    if (data.q && data.q.length === t.length) {
        // Discretised superposition: assemble rate steps from the q
        // history; each step (qj - qj-1) contributes a log term.
        // Here we use a simple step-detection: any change in q.
        const steps = [];
        let lastQ = 0, lastT = 0;
        for (let i = 0; i < t.length; i++) {
            if (i === 0 || Math.abs(data.q[i] - lastQ) > 1e-9) {
                steps.push({ ti: t[i], qPrev: lastQ, qNew: data.q[i] });
                lastQ = data.q[i];
                lastT = t[i];
            }
        }
        const qLast = data.q[data.q.length - 1] || 1;
        // For each measured point at time t_meas, compute superposition X.
        for (let i = 0; i < t.length; i++) {
            const dt = t[i];
            if (dt <= 0) continue;
            // X = Σ (qj - qj-1)/qN · log((t - t_j-1)/(t - t_j))
            let X = 0, valid = true;
            for (let j = 1; j < steps.length; j++) {
                const dq = (steps[j].qNew - steps[j].qPrev) / qLast;
                const num = (t[i] - steps[j - 1].ti);
                const den = (t[i] - steps[j].ti);
                if (num <= 0 || den <= 0) { valid = false; break; }
                X += dq * Math.log10(num / den);
            }
            if (valid && isFinite(X)) {
                xs.push(X);
                ys.push(p[i]);
            }
        }
    }
    // Fallback to plain Horner-form
    if (!xs.length) {
        for (let i = 0; i < t.length; i++) {
            const dt = t[i];
            if (!isFinite(dt) || dt <= 0) continue;
            const ratio = (tp + dt) / dt;
            if (ratio <= 0) continue;
            xs.push(Math.log10(ratio));
            ys.push(p[i]);
        }
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid superposition points'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Σ log((tp + Δt)/Δt)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Build-up Superposition' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const ot = data.overlay.t || t;
            const oxs = [], oys = [];
            for (let i = 0; i < ot.length; i++) {
                const dt = ot[i];
                if (!isFinite(dt) || dt <= 0) continue;
                oxs.push(Math.log10((tp + dt) / dt));
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// ════════════════════════════════════════════════════════════════════
// ── DECLINE (DCA) PLOTS ─────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 9. Rate vs time, linear (cartesian)
function PRiSM_plot_rate_time_cartesian(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const xR = PRiSM_plot_range(data.t, false);
    const yR = PRiSM_plot_range(data.q, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };
    const points = PRiSM_plot_zip(data.t, data.q);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Cartesian)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const op = PRiSM_plot_zip(data.overlay.t || data.t, data.overlay.q);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 10. Semi-log: rate-time with log y-axis (exponential decline → straight)
function PRiSM_plot_rate_time_semilog(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const xR = PRiSM_plot_range(data.t, false);
    const yR = PRiSM_plot_range(data.q.filter(v => v > 0), true);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        if (data.q[i] > 0) pts.push([data.t[i], data.q[i]]);
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Semi-log)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const opts_pts = [];
            for (let i = 0; i < ot.length; i++) {
                if (data.overlay.q[i] > 0) opts_pts.push([ot[i], data.overlay.q[i]]);
            }
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return true; }
    });
}

// 11. Log-log rate-time (hyperbolic / harmonic curvature visible)
function PRiSM_plot_rate_time_loglog(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        if (data.t[i] > 0 && data.q[i] > 0) pts.push([data.t[i], data.q[i]]);
    }
    if (!pts.length) { PRiSM_plot_empty(ctx, plot, 'No positive data'); return; }
    const xR = PRiSM_plot_range(pts.map(p => p[0]), true);
    const yR = PRiSM_plot_range(pts.map(p => p[1]), true);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Log-Log)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const opts_pts = [];
            for (let i = 0; i < ot.length; i++) {
                if (ot[i] > 0 && data.overlay.q[i] > 0) opts_pts.push([ot[i], data.overlay.q[i]]);
            }
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// 12. Rate vs cumulative — q vs Np (trapezoidal integration of q dt)
function PRiSM_plot_rate_cumulative(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    // Trapezoidal Np (in volume units consistent with q*t). If the
    // caller pre-supplies cumulative, use that directly via opts.cum.
    const Np = opts.cum && opts.cum.length === data.t.length
        ? opts.cum.slice()
        : (function() {
            const out = new Array(data.t.length);
            out[0] = 0;
            for (let i = 1; i < data.t.length; i++) {
                const dt = data.t[i] - data.t[i - 1];
                out[i] = out[i - 1] + 0.5 * (data.q[i] + data.q[i - 1]) * dt;
            }
            return out;
        })();

    const pts = PRiSM_plot_zip(Np, data.q);
    const xR = PRiSM_plot_range(Np, false);
    const yR = PRiSM_plot_range(data.q, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Cumulative, Np (bbl)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Cumulative' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const oNp = new Array(ot.length); oNp[0] = 0;
            for (let i = 1; i < ot.length; i++) {
                const dt = ot[i] - ot[i - 1];
                oNp[i] = oNp[i - 1] + 0.5 * (data.overlay.q[i] + data.overlay.q[i - 1]) * dt;
            }
            const op = PRiSM_plot_zip(oNp, data.overlay.q);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        // EUR: extend a tangent through last two points to q=0 (Arps
        // exponential intercept on cumulative axis is the simplest hint).
        if (pts.length >= 2 && opts.showEur !== false) {
            const a = pts[pts.length - 2], b = pts[pts.length - 1];
            const slope = (b[1] - a[1]) / (b[0] - a[0]);
            if (slope < 0 && isFinite(slope)) {
                const xEur = b[0] + (-b[1] / slope);
                ctx.save();
                ctx.strokeStyle = 'rgba(63,185,80,0.5)';
                ctx.lineWidth = 1.2;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(b[0]), tr.toY(b[1]));
                if (xEur > scaleX.min && xEur < scaleX.max) {
                    ctx.lineTo(tr.toX(xEur), tr.toY(0));
                    ctx.stroke();
                    ctx.fillStyle = PRiSM_THEME.green;
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText('EUR ≈ ' + PRiSM_plot_format_eng(xEur), tr.toX(xEur) + 4, tr.toY(0) - 6);
                }
                ctx.restore();
            }
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 13. Loss-ratio: 1/D vs t  where D = -d(ln q)/dt
//   Exponential → constant 1/D
//   Hyperbolic   → 1/D = a + b·t  (straight line, slope = b)
//   Harmonic     → straight line through origin
function PRiSM_plot_loss_ratio(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const t = data.t, q = data.q;
    // Numerical derivative of ln q with central differences. Skip endpoints.
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
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid 1/D points'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || '1/D = -dt/d(ln q)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Loss-Ratio (1/D vs t)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.green, 3);

        // Linear trend line (least-squares) — slope ≈ b (Arps exponent),
        // intercept ≈ 1/Di.
        if (points.length >= 3) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0, n = points.length;
            for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
            const denom = n * sxx - sx * sx;
            if (denom !== 0) {
                const m = (n * sxy - sx * sy) / denom;
                const c = (sy - m * sx) / n;
                ctx.save();
                ctx.strokeStyle = 'rgba(88,166,255,0.7)';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(scaleX.min), tr.toY(c + m * scaleX.min));
                ctx.lineTo(tr.toX(scaleX.max), tr.toY(c + m * scaleX.max));
                ctx.stroke();
                ctx.fillStyle = PRiSM_THEME.blue;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('b ≈ ' + m.toFixed(3) + ',  1/Di ≈ ' + PRiSM_plot_format_eng(c),
                    plot.x + 8, plot.y + plot.h - 8);
                ctx.restore();
            }
        }

        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const oxs = [], oys = [];
            for (let i = 1; i < ot.length - 1; i++) {
                if (data.overlay.q[i] <= 0 || data.overlay.q[i - 1] <= 0 || data.overlay.q[i + 1] <= 0) continue;
                const dlnq = Math.log(data.overlay.q[i + 1]) - Math.log(data.overlay.q[i - 1]);
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 14. Type-curve overlay — generic dimensionless qD vs tD type-curve
//   Plots data in dimensionless units (qD = q/qi, tD = t·Di) on log-log
//   axes and overlays a small family of Arps b-factor curves for visual
//   matching. The active curve (opts.b) is drawn bold.
function PRiSM_plot_typecurve_overlay(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    // Normalisation: caller may pass qi and Di; otherwise infer from
    // first non-zero rate and unit Di.
    const qi = isFinite(opts.qi) ? opts.qi : (data.q.find(v => v > 0) || 1);
    const Di = isFinite(opts.Di) ? opts.Di : 1;
    const dataPts = [];
    for (let i = 0; i < data.t.length; i++) {
        const td = data.t[i] * Di;
        const qd = data.q[i] / qi;
        if (td > 0 && qd > 0) dataPts.push([td, qd]);
    }
    if (!dataPts.length) { PRiSM_plot_empty(ctx, plot, 'No positive data'); return; }
    // Type-curve family
    const bList = (opts.bList && opts.bList.length) ? opts.bList : [0, 0.25, 0.5, 0.75, 1];
    const bActive = isFinite(opts.b) ? opts.b : 0.5;
    // Span tD across at least two decades on each side of the data
    const xData = PRiSM_plot_range(dataPts.map(p => p[0]), true);
    const xCurve = { min: Math.min(xData.min, 0.01), max: Math.max(xData.max, 100) };
    const curves = bList.map(b => {
        const pts = [];
        // Sample 80 points log-spaced
        const n = 80;
        const lo = Math.log10(xCurve.min), hi = Math.log10(xCurve.max);
        for (let i = 0; i <= n; i++) {
            const td = Math.pow(10, lo + (hi - lo) * i / n);
            // Arps generalised: qD = (1 + b·tD)^(-1/b)  for b > 0
            //                  qD = exp(-tD)            for b = 0
            let qd;
            if (b === 0) qd = Math.exp(-td);
            else         qd = Math.pow(1 + b * td, -1 / b);
            if (qd > 0 && isFinite(qd)) pts.push([td, qd]);
        }
        return { b, pts };
    });
    const allY = dataPts.map(p => p[1]).concat(...curves.map(c => c.pts.map(p => p[1])));
    const yR = PRiSM_plot_range(allY, true);
    // Tighten lower bound — Arps tail can vanish to zero
    yR.min = Math.max(yR.min, 1e-3);
    const scaleX = { kind: 'log', min: xCurve.min, max: xCurve.max, label: opts.xLabel || 'tD = t · Di' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'qD = q / qi' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Type-Curve Overlay (Arps qD-tD)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        // Background curves (thin)
        curves.forEach(c => {
            const isActive = Math.abs(c.b - bActive) < 1e-6;
            const color = isActive ? PRiSM_THEME.purple : 'rgba(139,148,158,0.45)';
            const w = isActive ? 2.5 : 1;
            PRiSM_plot_line(ctx, c.pts, tr.toX, tr.toY, color, { width: w });
            // b-label at the right end of the curve, where space allows
            const last = c.pts[c.pts.length - 1];
            if (last) {
                const lx = tr.toX(last[0]);
                const ly = tr.toY(last[1]);
                if (lx > plot.x && lx < plot.x + plot.w && ly > plot.y && ly < plot.y + plot.h) {
                    ctx.fillStyle = isActive ? PRiSM_THEME.purple : PRiSM_THEME.text3;
                    ctx.font = isActive ? 'bold 10px sans-serif' : '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('b=' + c.b, lx + 4, ly);
                }
            }
        });
        // Data on top (bold dots)
        PRiSM_plot_dots(ctx, dataPts, tr.toX, tr.toY, PRiSM_THEME.accent, 3.5);
        ctx.restore();
        if (opts.showLegend !== false) {
            PRiSM_plot_legend(ctx, [
                { label: 'Data', color: PRiSM_THEME.accent, marker: 'dot' },
                { label: 'Active b=' + bActive, color: PRiSM_THEME.purple },
                { label: 'Other b values', color: PRiSM_THEME.text3 }
            ], plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: dataPts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// ════════════════════════════════════════════════════════════════════
// === SELF-TEST ======================================================
// Runs once at script load if a window+document are available. Logs
// a single check line to console; does NOT throw on failure (the host
// page should remain usable even if a plot stub is missing).
// ════════════════════════════════════════════════════════════════════
(function PRiSM_plot_selftest() {
    if (typeof document === 'undefined') return;
    try {
        function logspace(a, b, n) {
            const lo = Math.log10(a), hi = Math.log10(b);
            const out = new Array(n);
            for (let i = 0; i < n; i++) out[i] = Math.pow(10, lo + (hi - lo) * i / (n - 1));
            return out;
        }
        function linspace(a, b, n) {
            const out = new Array(n);
            for (let i = 0; i < n; i++) out[i] = a + (b - a) * i / (n - 1);
            return out;
        }

        // PTA synthetic dataset
        const ptaT = logspace(0.01, 1000, 100);
        const ptaP = ptaT.map(t => Math.sqrt(t));
        const ptaDp = ptaT.map(t => Math.sqrt(t));      // base Δp
        const ptaDeriv = ptaT.map(t => 0.5 * Math.sqrt(t)); // textbook half-slope
        const ptaQ = ptaT.map(() => 1000);

        // Multi-rate q step for superposition test
        const ptaMultiQ = ptaT.map((_, i) => i < 50 ? 1200 : 800);

        const ptaData = {
            t: ptaT, p: ptaP, dp: ptaDp, q: ptaQ,
            tp: 100,
            periods: [
                { start: 0.01, end: 10,   label: 'BU1' },
                { start: 10,   end: 1000, label: 'FL1' }
            ],
            overlay: { t: ptaT, p: ptaP.map(v => v * 1.02), dp: ptaDp.map(v => v * 1.02) }
        };

        // DCA synthetic dataset
        const dcaT = linspace(0, 365, 100);
        const dcaQ = dcaT.map(t => 1000 * Math.exp(-0.005 * t));
        const dcaData = {
            t: dcaT, q: dcaQ,
            overlay: { t: dcaT, q: dcaT.map(t => 950 * Math.exp(-0.0048 * t)) }
        };

        // Make 14 offscreen canvases, one per plot.
        function mk() {
            const c = document.createElement('canvas');
            c.width = 600; c.height = 400;
            // Provide a virtual layout box so retina sizing has a target
            // even when the canvas is detached. clientWidth/Height read
            // 0 on a detached canvas, so we let setup() fall back to the
            // intrinsic width/height we just set.
            return c;
        }

        const calls = [
            ['cartesian',                () => PRiSM_plot_cartesian(mk(), ptaData, {})],
            ['horner',                   () => PRiSM_plot_horner(mk(), ptaData, { tp: 100 })],
            ['bourdet',                  () => PRiSM_plot_bourdet(mk(), { t: ptaT, dp: ptaDp, p: ptaP }, {})],
            ['sqrt_time',                () => PRiSM_plot_sqrt_time(mk(), ptaData, {})],
            ['quarter_root_time',        () => PRiSM_plot_quarter_root_time(mk(), ptaData, {})],
            ['spherical',                () => PRiSM_plot_spherical(mk(), ptaData, {})],
            ['sandface_convolution',     () => PRiSM_plot_sandface_convolution(mk(), { t: ptaT, p: ptaP, q: ptaMultiQ }, {})],
            ['buildup_superposition',    () => PRiSM_plot_buildup_superposition(mk(), { t: ptaT, p: ptaP, q: ptaMultiQ, tp: 100 }, {})],
            ['rate_time_cartesian',      () => PRiSM_plot_rate_time_cartesian(mk(), dcaData, {})],
            ['rate_time_semilog',        () => PRiSM_plot_rate_time_semilog(mk(), dcaData, {})],
            ['rate_time_loglog',         () => PRiSM_plot_rate_time_loglog(mk(), dcaData, {})],
            ['rate_cumulative',          () => PRiSM_plot_rate_cumulative(mk(), dcaData, {})],
            ['loss_ratio',               () => PRiSM_plot_loss_ratio(mk(), dcaData, {})],
            ['typecurve_overlay',        () => PRiSM_plot_typecurve_overlay(mk(), dcaData, { qi: 1000, Di: 0.005, b: 0.5 })]
        ];

        const failed = [];
        calls.forEach(([name, fn]) => {
            try { fn(); }
            catch (e) { failed.push(name + ': ' + (e && e.message ? e.message : e)); }
        });
        if (failed.length === 0) {
            // Single tidy line as required
            // eslint-disable-next-line no-console
            console.log('✓ all 14 plots rendered without throwing');
        } else {
            // eslint-disable-next-line no-console
            console.warn('PRiSM plot self-test failures (' + failed.length + '/14):', failed);
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('PRiSM plot self-test crashed:', e);
    }
})();
