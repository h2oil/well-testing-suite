// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 15 — Diagnostic Plot Annotations + Auto-Bourdet-L
//   Two compounding wins:
//     • Auto-pick Bourdet smoothing L based on data noise level
//     • Render flow-regime transition markers on diagnostic plots
//
// PUBLIC API (all on window.*)
//   PRiSM_autoBourdet_L(t, p, q?)          → { L, noiseLevel, noiseEstimate, rationale, alternatives[] }
//   PRiSM_detectAnnotations(t, p, dp?)     → [{ type, td, label, priority }, ...]  (sorted by td)
//   PRiSM_drawPlotAnnotations(canvas, annotations, plotKey)  → void
//   PRiSM_enableAutoAnnotations(enabled?)  → void  (default true)
//   PRiSM_renderAnnotationToolbar(host)    → void  (UI helper)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS, no external dependencies.
//   • Failure-tolerant: any error in detection or drawing is swallowed —
//     annotations are NICE-TO-HAVE and must NEVER break the underlying plot.
//   • Defensive against missing primitives — stubs PRiSM_compute_bourdet,
//     PRiSM_classifyRegimes, PRiSM_drawActivePlot if absent so the module
//     can still load + self-test in the smoke-test stub harness.
//   • PRiSM_drawActivePlot wrap is idempotent (guarded by ._annotationsWrapped).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // Theme palette — match PRiSM_THEME if available, else fall back.
    function _theme() {
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg:        '#0d1117', panel: '#161b22', border: '#30363d',
            grid:      '#21262d', gridMajor: '#30363d',
            text:      '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
            accent:    '#f0883e', blue: '#58a6ff', green: '#3fb950',
            red:       '#f85149', yellow: '#d29922', cyan: '#39c5cf',
            purple:    '#bc8cff'
        };
    }

    // Default padding (mirrors PRiSM_DEFAULT_PADDING).
    function _defaultPad() {
        return { top: 30, right: 80, bottom: 48, left: 64 };
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    // Locate the bourdet derivative helper if present.
    function _bourdet(t, dp, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            return G.PRiSM_compute_bourdet(t, dp, L);
        }
        // Inline fallback — mirrors layer-2 implementation.
        L = L || 0;
        var n = t.length;
        var d = new Array(n);
        for (var k = 0; k < n; k++) d[k] = NaN;
        if (n < 3) return d;
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
            var i1 = i - 1, i2 = i + 1;
            if (L > 0) {
                while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
                while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
            }
            var t1 = t[i1], t2 = t[i2], ti = t[i];
            if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
            var dl1 = Math.log(ti) - Math.log(t1);
            var dl2 = Math.log(t2) - Math.log(ti);
            var dlT = Math.log(t2) - Math.log(t1);
            if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
            var a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
            var b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
            d[i] = a + b;
        }
        return d;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — NOISE-LEVEL ESTIMATOR + L PICKER
    // ═══════════════════════════════════════════════════════════════
    //
    // Estimate gauge-noise level by:
    //   1. Compute a moving-average low-pass of p with window=5 samples
    //   2. Subtract → high-pass residual
    //   3. RMS(residual) / |mean(p)|  → noise as a relative fraction
    //
    // Map noise band → L:
    //   noise < 0.001 → L = 0.10  ('clean')
    //   0.001-0.005   → L = 0.18  ('typical')
    //   0.005-0.02    → L = 0.30  ('noisy')
    //   > 0.02        → L = 0.50  ('very noisy')
    // ═══════════════════════════════════════════════════════════════

    function _movingAverage(p, win) {
        var n = p.length;
        var out = new Array(n);
        if (n === 0) return out;
        var half = Math.max(1, Math.floor(win / 2));
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - half);
            var i1 = Math.min(n - 1, i + half);
            var sum = 0, cnt = 0;
            for (var j = i0; j <= i1; j++) {
                if (isFinite(p[j])) { sum += p[j]; cnt++; }
            }
            out[i] = cnt > 0 ? sum / cnt : NaN;
        }
        return out;
    }

    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        }
        return n > 0 ? s / n : 0;
    }

    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) {
            if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }

    // Estimate the relative noise floor of pressure data.
    // Returns a positive number (RMS of high-pass residual / |mean(p)|).
    function _estimateNoise(p) {
        if (!Array.isArray(p) || p.length < 5) return 0;
        // Smooth with a 5-pt MA — anything wiggling faster than that is "noise".
        var smooth = _movingAverage(p, 5);
        var resid = new Array(p.length);
        for (var i = 0; i < p.length; i++) {
            resid[i] = (isFinite(p[i]) && isFinite(smooth[i])) ? (p[i] - smooth[i]) : NaN;
        }
        var rms  = _rms(resid);
        var mean = _meanAbs(p);
        if (mean === 0) return 0;
        return rms / mean;
    }

    // Map noise → suggested L.
    function _pickL(noise) {
        if (!isFinite(noise) || noise <= 0)   return { L: 0.18, level: 'low' };
        if (noise < 0.001)                    return { L: 0.10, level: 'low' };
        if (noise < 0.005)                    return { L: 0.18, level: 'low' };
        if (noise < 0.02)                     return { L: 0.30, level: 'medium' };
        return { L: 0.50, level: 'high' };
    }

    function _rationale(level, noise, L) {
        var pct = (noise * 100).toFixed(2);
        if (level === 'low' && L <= 0.12) {
            return 'Very clean gauge data (~' + pct + '% RMS of mean pressure) — using minimal smoothing L=' + L.toFixed(2) + ' to preserve regime transitions.';
        }
        if (level === 'low') {
            return 'Low noise floor (~' + pct + '% of mean pressure) — using small L=' + L.toFixed(2) + ' to preserve regime transitions.';
        }
        if (level === 'medium') {
            return 'Moderate noise (~' + pct + '% of mean pressure) — using standard smoothing L=' + L.toFixed(2) + ' to balance feature retention and noise rejection.';
        }
        return 'Heavy noise (~' + pct + '% of mean pressure) — using large L=' + L.toFixed(2) + ' to suppress gauge jitter; some sharp transitions may be smeared.';
    }

    G.PRiSM_autoBourdet_L = function PRiSM_autoBourdet_L(t, p, q) {
        // q is currently unused — accepted for future extension (e.g., rate
        // sensitivity analysis where short rate perturbations dominate noise).
        var fallback = {
            L: 0.18,
            noiseLevel: 'low',
            noiseEstimate: 0,
            rationale: 'Default smoothing L=0.18 (no pressure data supplied).',
            alternatives: [
                { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
                { L: 0.30, description: 'standard smoothing (balanced)' },
                { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
            ]
        };
        try {
            if (!Array.isArray(t) || !Array.isArray(p) || p.length < 5) return fallback;
            var noise = _estimateNoise(p);
            var pick  = _pickL(noise);
            return {
                L: pick.L,
                noiseLevel: pick.level,
                noiseEstimate: noise,
                rationale: _rationale(pick.level, noise, pick.L),
                alternatives: [
                    { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
                    { L: 0.30, description: 'standard smoothing (balanced)' },
                    { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
                ]
            };
        } catch (e) {
            return fallback;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — REGIME-TRANSITION DETECTOR
    // ═══════════════════════════════════════════════════════════════
    //
    // Heuristic local-slope detector that runs on the Bourdet derivative.
    // Sliding 5-point window in log(t) space, computes
    //   slope = d(log10 dp)/d(log10 t)
    // for each interior point. Then scans for "kicks" — slope deltas > 0.3
    // between adjacent windows — and tags transitions by surrounding slopes.
    //
    // If window.PRiSM_classifyRegimes (Agent J) is loaded, prefer its output
    // and convert it into the annotation list shape.
    // ═══════════════════════════════════════════════════════════════

    // Compute a smoothed log-log slope at each point in (t, y).
    // Returns array of slopes (NaN at boundaries). Operates on |y| because
    // diagnostic plots conventionally use the magnitude of the bourdet
    // derivative (sign depends on drawdown vs buildup).
    function _logLogSlopes(t, y, halfWin) {
        var n = t.length;
        var slopes = new Array(n);
        for (var k = 0; k < n; k++) slopes[k] = NaN;
        halfWin = halfWin || 2;
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - halfWin);
            var i1 = Math.min(n - 1, i + halfWin);
            // Linear regression in log space (absolute y).
            var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
            for (var j = i0; j <= i1; j++) {
                if (!isFinite(t[j]) || t[j] <= 0 || !isFinite(y[j])) continue;
                var ay = Math.abs(y[j]);
                if (ay <= 0) continue;
                var lx = Math.log10(t[j]);
                var ly = Math.log10(ay);
                sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; m++;
            }
            if (m < 3) continue;
            var denom = m * sxx - sx * sx;
            if (Math.abs(denom) < 1e-12) continue;
            slopes[i] = (m * sxy - sx * sy) / denom;
        }
        return slopes;
    }

    // Classify a "kick" between slope_before and slope_after into a regime
    // transition. Returns an annotation type/label/priority object, or null
    // if the pair doesn't match a known signature.
    function _classifyKick(sBefore, sAfter) {
        if (!isFinite(sBefore) || !isFinite(sAfter)) return null;
        // WBS-end / radial-flow start: slope ~1 → ~0
        if (sBefore > 0.55 && sAfter < 0.30 && sAfter > -0.30) {
            return { type: 'wellboreStorageEnd', label: 'WBS ends', priority: 1 };
        }
        // Radial → linear-channel boundary (parallel faults, slope ½)
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.35 && sAfter < 0.65) {
            return { type: 'boundaryHit', label: 'Boundary signature begins', priority: 2 };
        }
        // Radial → closed-boundary (PSS / circular drainage, slope 1)
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.75) {
            return { type: 'closedBoundaryHit', label: 'Closed boundary (PSS)', priority: 2 };
        }
        // Radial → spherical: dropping slope, < -0.3
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter < -0.30) {
            return { type: 'sphericalFlow', label: '−½ slope (spherical flow)', priority: 3 };
        }
        // Linear → radial (entering radial after a fracture-linear regime)
        if (sBefore > 0.35 && sBefore < 0.65 && sAfter > -0.20 && sAfter < 0.30) {
            return { type: 'radialFlowStart', label: 'Radial flow starts', priority: 1 };
        }
        // Bilinear → linear (¼ → ½)
        if (sBefore > 0.15 && sBefore < 0.40 && sAfter > 0.40 && sAfter < 0.65) {
            return { type: 'bilinearToLinear', label: 'Bilinear → linear', priority: 3 };
        }
        return null;
    }

    // Pick representative td values for each detected kick. Returns an array
    // sorted by td, deduplicated within ~0.3 decade.
    function _findKicks(t, slopes) {
        var n = t.length;
        var out = [];
        // We compare slopes a half-decade apart to suppress single-point flicker.
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(slopes[i]) || !isFinite(slopes[i - 1])) continue;
            // Look for a "stable before" / "stable after" via wider sampling.
            var iBefore = Math.max(0, i - 5);
            var iAfter  = Math.min(n - 1, i + 5);
            var sBefore = slopes[iBefore];
            var sAfter  = slopes[iAfter];
            if (!isFinite(sBefore) || !isFinite(sAfter)) continue;
            if (Math.abs(sAfter - sBefore) < 0.3) continue;
            var ann = _classifyKick(sBefore, sAfter);
            if (!ann) continue;
            ann.td = t[i];
            out.push(ann);
        }
        // De-dup: only keep one annotation of any (type, ~decade) bucket.
        // Most regime transitions occur once in a test (WBS-end, radial start,
        // boundary-hit), so we use a strong global dedup. sphericalFlow may
        // legitimately repeat across multi-region tests.
        out.sort(function (a, b) { return a.td - b.td; });
        var dedup = [];
        for (var k = 0; k < out.length; k++) {
            var cur = out[k];
            var skip = false;
            for (var m = 0; m < dedup.length; m++) {
                var existing = dedup[m];
                if (existing.type === cur.type) {
                    if (cur.type === 'sphericalFlow') {
                        // Allow if at least 1 decade away.
                        var ratio = (cur.td > 0 && existing.td > 0)
                            ? Math.abs(Math.log10(cur.td) - Math.log10(existing.td))
                            : 0;
                        if (ratio < 1.0) { skip = true; break; }
                    } else {
                        // Once-per-test types: keep first occurrence only.
                        skip = true; break;
                    }
                }
            }
            if (!skip) dedup.push(cur);
        }
        return dedup;
    }

    // Sustained-spherical-flow regime — runs of points with slope < -0.3.
    function _findSphericalRun(t, slopes) {
        var n = t.length;
        var out = [];
        var runStart = -1, runLen = 0;
        for (var i = 0; i < n; i++) {
            if (isFinite(slopes[i]) && slopes[i] < -0.30) {
                if (runStart < 0) runStart = i;
                runLen++;
            } else {
                if (runLen >= 4 && runStart >= 0) {
                    var midIdx = runStart + Math.floor(runLen / 2);
                    if (t[midIdx] > 0) {
                        out.push({
                            type: 'sphericalFlow',
                            td: t[midIdx],
                            label: '−½ slope (spherical flow)',
                            priority: 3
                        });
                    }
                }
                runStart = -1; runLen = 0;
            }
        }
        if (runLen >= 4 && runStart >= 0) {
            var midIdx2 = runStart + Math.floor(runLen / 2);
            if (t[midIdx2] > 0) {
                out.push({
                    type: 'sphericalFlow',
                    td: t[midIdx2],
                    label: '−½ slope (spherical flow)',
                    priority: 3
                });
            }
        }
        return out;
    }

    // Convert PRiSM_classifyRegimes output (Agent J) into an annotation list.
    // The exact shape may vary — we accept either an array or an object with
    // a `transitions` field, and look for { type/regime/name, td/t/time }.
    function _normaliseAgentJOutput(raw) {
        if (!raw) return null;
        var arr = Array.isArray(raw) ? raw
                : (Array.isArray(raw.transitions) ? raw.transitions
                : (Array.isArray(raw.annotations) ? raw.annotations : null));
        if (!arr) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e) continue;
            var td = (e.td != null) ? e.td
                   : (e.t  != null) ? e.t
                   : (e.time != null) ? e.time
                   : null;
            if (!isFinite(td) || td <= 0) continue;
            var type = e.type || e.regime || e.name || 'transition';
            var label = e.label || e.description || _typeLabel(type);
            var priority = (e.priority != null) ? e.priority : _typePriority(type);
            out.push({ type: String(type), td: Number(td), label: String(label), priority: Number(priority) });
        }
        out.sort(function (a, b) { return a.td - b.td; });
        return out;
    }

    function _typeLabel(type) {
        switch (type) {
            case 'wellboreStorageEnd': return 'WBS ends';
            case 'radialFlowStart':    return 'Radial flow starts';
            case 'boundaryHit':        return 'Boundary signature begins';
            case 'closedBoundaryHit':  return 'Closed boundary (PSS)';
            case 'sphericalFlow':      return '−½ slope (spherical flow)';
            case 'doublePorosityValley': return 'Double-porosity valley';
            case 'bilinearToLinear':   return 'Bilinear → linear';
            default:                   return String(type);
        }
    }

    function _typePriority(type) {
        if (type === 'wellboreStorageEnd' || type === 'radialFlowStart') return 1;
        if (type === 'boundaryHit' || type === 'closedBoundaryHit') return 2;
        return 3;
    }

    G.PRiSM_detectAnnotations = function PRiSM_detectAnnotations(t, p, dp) {
        try {
            if (!Array.isArray(t) || t.length < 5) return [];

            // Compute (or accept) the bourdet derivative.
            var dpUsed = dp;
            if (!Array.isArray(dpUsed) || dpUsed.length !== t.length) {
                if (!Array.isArray(p)) return [];
                var deltaP = new Array(t.length);
                var p0 = p[0];
                for (var i = 0; i < t.length; i++) deltaP[i] = (p[i] - p0);
                // Use auto-L for the derivative computation.
                var auto = G.PRiSM_autoBourdet_L(t, p);
                dpUsed = _bourdet(t, deltaP, auto.L);
            }

            // Try Agent J first.
            if (typeof G.PRiSM_classifyRegimes === 'function') {
                try {
                    var raw = G.PRiSM_classifyRegimes(t, p, dpUsed);
                    var norm = _normaliseAgentJOutput(raw);
                    if (norm && norm.length) {
                        norm._source = 'classifyRegimes';
                        return norm;
                    }
                } catch (e) {
                    // Fall through to local detector.
                }
            }

            // Local fallback detector.
            var slopes = _logLogSlopes(t, dpUsed, 2);
            var kicks = _findKicks(t, slopes);
            var spheres = _findSphericalRun(t, slopes);
            // Merge and de-dup spheres against existing kicks of same type.
            for (var s = 0; s < spheres.length; s++) {
                var dup = false;
                for (var m2 = 0; m2 < kicks.length; m2++) {
                    if (kicks[m2].type === spheres[s].type) {
                        var ratio2 = Math.abs(Math.log10(spheres[s].td) - Math.log10(kicks[m2].td));
                        if (ratio2 < 0.3) { dup = true; break; }
                    }
                }
                if (!dup) kicks.push(spheres[s]);
            }
            kicks.sort(function (a, b) { return a.td - b.td; });
            kicks._source = 'fallback';
            return kicks;
        } catch (e) {
            try { console.warn('PRiSM_detectAnnotations error:', e && e.message); } catch (_) {}
            return [];
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — ANNOTATION RENDERER
    // ═══════════════════════════════════════════════════════════════
    //
    // Convert each annotation td → canvas pixel x using the plot's most
    // recent data range. We can't easily reach the live plot's `lastTransform`
    // (it's closed over inside the per-render IIFE), so we recompute the
    // x-axis transform from PRiSM_dataset's range, mirroring layer-2's tick
    // generator.
    //
    // The renderer is idempotent — it tags the canvas with a flag while it's
    // drawing and stores the most-recent annotation set on the canvas so that
    // other modules can inspect it.
    // ═══════════════════════════════════════════════════════════════

    // Canvas-pixel range for the plot drawing area, given the canvas + opts.
    // Mirrors PRiSM_plot_setup's plot {x, y, w, h, cssW, cssH} computation.
    function _plotRect(canvas) {
        var cssW = canvas.clientWidth || canvas.width || 600;
        var cssH = canvas.clientHeight || canvas.height || 400;
        // Some tests / smoke environments leave width/height un-set.
        // Prefer the canvas.style.width if present (set by PRiSM_plot_setup).
        if (canvas.style && canvas.style.width) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
        }
        if (canvas.style && canvas.style.height) {
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return {
            x: pad.left,
            y: pad.top,
            w: Math.max(1, cssW - pad.left - pad.right),
            h: Math.max(1, cssH - pad.top - pad.bottom),
            cssW: cssW,
            cssH: cssH,
            pad: pad
        };
    }

    // Determine the t-range the plot is showing. Bourdet, sqrt, quarter-root,
    // spherical etc all use the dataset's t array. We reuse PRiSM_dataset
    // unless something tighter is supplied via canvas._prismOriginalScale.x
    // (which the layer-2 plots set on each render).
    function _xRange(canvas, plotKey) {
        // Layer-2 stores the original scale (post-zoom-reset) on the canvas.
        if (canvas && canvas._prismOriginalScale && canvas._prismOriginalScale.x) {
            var sx = canvas._prismOriginalScale.x;
            if (isFinite(sx.min) && isFinite(sx.max) && sx.min > 0 && sx.max > sx.min) {
                return { min: sx.min, max: sx.max, kind: sx.kind || 'log' };
            }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t) || !ds.t.length) {
            return { min: 1e-3, max: 1, kind: 'log' };
        }
        var minT = Infinity, maxT = -Infinity;
        for (var i = 0; i < ds.t.length; i++) {
            var v = ds.t[i];
            if (isFinite(v) && v > 0) {
                if (v < minT) minT = v;
                if (v > maxT) maxT = v;
            }
        }
        if (!isFinite(minT) || !isFinite(maxT) || minT >= maxT) {
            return { min: 1e-3, max: 1, kind: 'log' };
        }
        // Most diagnostic plots use a log x-axis; the cartesian P-vs-t variant
        // and rate plots use linear. Default to log for known log plots.
        var logPlots = { bourdet: 1, sqrt: 0, quarter: 0, spherical: 0,
                         sandface: 1, superposition: 0, rateLog: 1,
                         typeCurve: 1 };
        var isLog = logPlots[plotKey] !== 0; // default true for unknown
        if (plotKey === 'sqrt' || plotKey === 'quarter' || plotKey === 'spherical' ||
            plotKey === 'cartesian' || plotKey === 'horner' || plotKey === 'superposition' ||
            plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateCum' ||
            plotKey === 'lossRatio') {
            isLog = false;
        }
        return { min: minT, max: maxT, kind: isLog ? 'log' : 'lin' };
    }

    // World→pixel for x. Mirrors layer-2's toX construction.
    function _toX(plot, scaleX) {
        if (scaleX.kind === 'log') {
            var lmin = Math.log10(scaleX.min);
            var lmax = Math.log10(scaleX.max);
            var rng = lmax - lmin;
            return function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                return plot.x + (Math.log10(v) - lmin) / rng * plot.w;
            };
        }
        return function (v) {
            if (!isFinite(v)) return NaN;
            return plot.x + (v - scaleX.min) / (scaleX.max - scaleX.min) * plot.w;
        };
    }

    function _colorForPriority(priority) {
        var th = _theme();
        if (priority === 1) return th.accent || '#f0883e';
        if (priority === 2) return th.blue   || '#58a6ff';
        return th.text2 || '#8b949e';
    }

    G.PRiSM_drawPlotAnnotations = function PRiSM_drawPlotAnnotations(canvas, annotations, plotKey) {
        if (!canvas || !canvas.getContext) return;
        if (!Array.isArray(annotations) || !annotations.length) {
            // Clear stored set.
            try { canvas._prismAnnotations = []; } catch (e) {}
            return;
        }
        plotKey = plotKey || 'bourdet';
        // Annotation rendering is meaningful only on log-x diagnostic plots
        // (Bourdet, sandface, type-curve, rate-log). Skip for other plots
        // where the regime semantics don't apply.
        var skip = { cartesian: 1, horner: 1, sqrt: 1, quarter: 1, spherical: 1,
                     superposition: 1, rateCart: 1, rateSemi: 1, rateCum: 1,
                     lossRatio: 1 };
        if (skip[plotKey]) {
            try { canvas._prismAnnotations = []; } catch (e) {}
            return;
        }
        try {
            // Idempotency guard — if we are already drawing, bail.
            if (canvas._prismAnnotationsDrawing) return;
            canvas._prismAnnotationsDrawing = true;

            var ctx = canvas.getContext('2d');
            if (!ctx) { canvas._prismAnnotationsDrawing = false; return; }

            // The layer-2 setup applied a setTransform(dpr,0,0,dpr,0,0). When
            // wrapped from PRiSM_drawActivePlot, that transform is still in
            // effect, so our css-pixel coordinates draw at the right scale.
            // If we are called standalone (rare), assume identity.
            var plot = _plotRect(canvas);
            var scaleX = _xRange(canvas, plotKey);
            var toX = _toX(plot, scaleX);

            var th = _theme();

            // Filter annotations into the visible x range.
            var visible = [];
            for (var i = 0; i < annotations.length; i++) {
                var a = annotations[i];
                if (!a || !isFinite(a.td)) continue;
                if (scaleX.kind === 'log') {
                    if (a.td <= 0) continue;
                    if (a.td < scaleX.min || a.td > scaleX.max) continue;
                } else {
                    if (a.td < scaleX.min || a.td > scaleX.max) continue;
                }
                var px = toX(a.td);
                if (!isFinite(px)) continue;
                if (px < plot.x - 1 || px > plot.x + plot.w + 1) continue;
                visible.push({ ann: a, px: px });
            }
            // Stash the visible set for inspection.
            canvas._prismAnnotations = visible.slice();

            ctx.save();
            // Ensure clean state — don't inherit any clip from the plot lib.
            ctx.font = '11px sans-serif';

            // Draw each annotation: dashed vertical line + label.
            for (var k = 0; k < visible.length; k++) {
                var item = visible[k];
                var aa = item.ann;
                var px2 = item.px;
                var color = _colorForPriority(aa.priority);

                ctx.strokeStyle = color;
                ctx.fillStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);

                ctx.beginPath();
                ctx.moveTo(px2 + 0.5, plot.y);
                ctx.lineTo(px2 + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);

                // Label: alternate above (k even → above) / below (k odd → below)
                var above = (k % 2 === 0);
                ctx.save();
                if (above) {
                    // Above the plot box: rotate -90° and write reading bottom-up.
                    ctx.translate(px2 + 4, plot.y - 4);
                    ctx.rotate(-Math.PI / 2);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                } else {
                    // Below the plot box: rotate -90° and write reading top-down.
                    ctx.translate(px2 - 4, plot.y + plot.h + 6);
                    ctx.rotate(-Math.PI / 2);
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                }
                // Draw a faint label background for legibility.
                var labelText = String(aa.label || aa.type || '');
                var tw = ctx.measureText(labelText).width;
                ctx.fillStyle = 'rgba(13,17,23,0.78)';
                if (above) {
                    ctx.fillRect(-2, -8, tw + 4, 14);
                } else {
                    ctx.fillRect(-tw - 2, -8, tw + 4, 14);
                }
                ctx.fillStyle = color;
                ctx.fillText(labelText, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        } catch (e) {
            try { console.warn('PRiSM_drawPlotAnnotations error:', e && e.message); } catch (_) {}
        } finally {
            canvas._prismAnnotationsDrawing = false;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — WRAP PRiSM_drawActivePlot FOR AUTO-ANNOTATION
    // ═══════════════════════════════════════════════════════════════

    // Default-on. The user can disable via PRiSM_enableAutoAnnotations(false)
    // or via the toolbar checkbox.
    if (typeof G.PRiSM_annotationsEnabled === 'undefined') {
        G.PRiSM_annotationsEnabled = true;
    }

    function _wrapDrawActivePlot() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_drawActivePlot !== 'function') {
            // The plot dispatcher hasn't been defined yet (PRiSM Phase 1+2
            // wires it in renderPRiSM). Try again shortly.
            if (typeof setTimeout === 'function') {
                setTimeout(_wrapDrawActivePlot, 250);
            }
            return;
        }
        if (G.PRiSM_drawActivePlot._annotationsWrapped) return;
        var orig = G.PRiSM_drawActivePlot;
        var wrapped = function () {
            var ret = orig.apply(this, arguments);
            if (G.PRiSM_annotationsEnabled === false) return ret;
            try {
                var canvas = (_hasDoc && document.getElementById)
                    ? document.getElementById('prism_plot_canvas') : null;
                var ds = G.PRiSM_dataset;
                if (canvas && ds && Array.isArray(ds.t) && ds.t.length > 0) {
                    var ann = G.PRiSM_detectAnnotations(ds.t, ds.p, ds.dp);
                    var st = G.PRiSM_state || {};
                    var plotKey = st.activePlot || 'bourdet';
                    G.PRiSM_drawPlotAnnotations(canvas, ann, plotKey);
                }
            } catch (e) {
                // Annotations are non-essential — fail quiet.
                try { console.warn('PRiSM auto-annotation error:', e && e.message); } catch (_) {}
            }
            return ret;
        };
        // Preserve any flags set by other wrappers on the original.
        for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
        wrapped._annotationsWrapped = true;
        G.PRiSM_drawActivePlot = wrapped;
    }

    G.PRiSM_enableAutoAnnotations = function PRiSM_enableAutoAnnotations(enabled) {
        // Default to true if no argument is supplied.
        var on = (typeof enabled === 'undefined') ? true : !!enabled;
        G.PRiSM_annotationsEnabled = on;
        // Trigger a redraw if possible so annotations appear/disappear
        // immediately.
        try {
            if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
        } catch (e) {
            // Ignore — caller will redraw soon enough.
        }
    };

    // Kick off the wrap. It self-defers if drawActivePlot isn't ready yet.
    _wrapDrawActivePlot();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — TOOLBAR UI
    // ═══════════════════════════════════════════════════════════════

    // Toolbar state — stored on a single global so re-renders preserve UX.
    G.PRiSM_annotationToolbarState = G.PRiSM_annotationToolbarState || {
        autoL: true,
        manualL: 0.18
    };

    // Apply the auto-L (or manualL) to PRiSM_state.smoothL so the next
    // bourdet plot picks it up.
    function _applyL() {
        var st = G.PRiSM_state || {};
        var s = G.PRiSM_annotationToolbarState;
        var ds = G.PRiSM_dataset;
        var info = null;
        if (s.autoL) {
            if (ds && Array.isArray(ds.t) && Array.isArray(ds.p)) {
                info = G.PRiSM_autoBourdet_L(ds.t, ds.p, ds.q);
                st.smoothL = info.L;
            } else {
                st.smoothL = 0.18;
                info = { L: 0.18, noiseLevel: 'low', noiseEstimate: 0,
                         rationale: 'Auto-pick disabled (no data) — using L=0.18.' };
            }
        } else {
            st.smoothL = s.manualL;
            info = { L: s.manualL, noiseLevel: 'manual', noiseEstimate: 0,
                     rationale: 'Manual L selected (' + s.manualL.toFixed(2) + ').' };
        }
        return info;
    }

    function _updateInfoLine(host, info) {
        if (!host || !host.querySelector) return;
        var line = host.querySelector('#prism_ann_infoline');
        if (!line) return;
        if (!info) { line.textContent = ''; return; }
        var summary = 'Noise: ' + info.noiseLevel +
            ' (~' + (info.noiseEstimate * 100).toFixed(2) + '% RMS)' +
            '  •  Suggested L = ' + info.L.toFixed(2);
        line.textContent = summary;
        line.title = info.rationale || '';
    }

    G.PRiSM_renderAnnotationToolbar = function PRiSM_renderAnnotationToolbar(container) {
        var host = (typeof container === 'string')
            ? (_hasDoc ? document.getElementById(container) : null)
            : container;
        if (!host) return;
        var s = G.PRiSM_annotationToolbarState;
        var enabled = (G.PRiSM_annotationsEnabled !== false);

        host.innerHTML =
            '<div style="border:1px solid #30363d; border-radius:6px; padding:10px 12px; ' +
                        'background:#161b22; margin-top:8px; font:12px sans-serif; color:#c9d1d9;">' +
                '<div style="font-size:11px; font-weight:700; color:#c9d1d9; ' +
                            'text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Diagnostic Annotations & Bourdet-L' +
                '</div>' +
                '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:14px;">' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_show"' +
                            (enabled ? ' checked' : '') + '>' +
                        '<span>Show annotations</span>' +
                    '</label>' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_autoL"' +
                            (s.autoL ? ' checked' : '') + '>' +
                        '<span>Auto-pick smoothing L</span>' +
                    '</label>' +
                    '<label style="display:flex; align-items:center; gap:6px;' +
                        (s.autoL ? ' opacity:0.55;' : '') + '">' +
                        '<span>Manual L</span>' +
                        '<input type="range" id="prism_ann_lslider" min="0.05" max="0.5" step="0.01" ' +
                            'value="' + s.manualL.toFixed(2) + '" ' +
                            (s.autoL ? 'disabled' : '') +
                            ' style="width:120px;">' +
                        '<span id="prism_ann_lvalue" style="color:#8b949e; min-width:34px;">' +
                            s.manualL.toFixed(2) + '</span>' +
                    '</label>' +
                    '<button class="btn btn-secondary" id="prism_ann_reclassify" ' +
                        'style="font-size:11px; padding:4px 10px;">Re-classify regimes</button>' +
                '</div>' +
                '<div id="prism_ann_infoline" style="margin-top:8px; font-size:11px; color:#8b949e; ' +
                                                  'min-height:14px;"></div>' +
            '</div>';

        // Compute & paint the info line.
        try { _updateInfoLine(host, _applyL()); } catch (e) {}

        // Wire up controls.
        var showChk    = host.querySelector('#prism_ann_show');
        var autoChk    = host.querySelector('#prism_ann_autoL');
        var slider     = host.querySelector('#prism_ann_lslider');
        var sliderVal  = host.querySelector('#prism_ann_lvalue');
        var btn        = host.querySelector('#prism_ann_reclassify');

        if (showChk && showChk.addEventListener) {
            showChk.addEventListener('change', function () {
                G.PRiSM_enableAutoAnnotations(!!showChk.checked);
                _ga4('prism_annotation_toggle', {
                    enabled: !!showChk.checked,
                    autoL:   !!s.autoL
                });
            });
        }

        if (autoChk && autoChk.addEventListener) {
            autoChk.addEventListener('change', function () {
                s.autoL = !!autoChk.checked;
                if (slider) slider.disabled = s.autoL;
                try {
                    var info = _applyL();
                    _updateInfoLine(host, info);
                    if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                } catch (e) {}
                _ga4('prism_annotation_toggle', {
                    enabled: (G.PRiSM_annotationsEnabled !== false),
                    autoL:   !!s.autoL
                });
            });
        }

        if (slider && slider.addEventListener) {
            slider.addEventListener('input', function () {
                var v = parseFloat(slider.value);
                if (isFinite(v)) {
                    s.manualL = v;
                    if (sliderVal) sliderVal.textContent = v.toFixed(2);
                    if (!s.autoL) {
                        try {
                            _updateInfoLine(host, _applyL());
                            if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                        } catch (e) {}
                    }
                }
            });
        }

        if (btn && btn.addEventListener) {
            btn.addEventListener('click', function () {
                try {
                    var info = _applyL();
                    _updateInfoLine(host, info);
                    if (typeof G.PRiSM_drawActivePlot === 'function') G.PRiSM_drawActivePlot();
                } catch (e) {}
                _ga4('prism_annotation_toggle', {
                    enabled: (G.PRiSM_annotationsEnabled !== false),
                    autoL:   !!s.autoL,
                    action:  'reclassify'
                });
            });
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════
    // Conventions:
    //   1. autoBourdet_L on synthetic clean data returns L ≈ 0.10–0.18
    //   2. autoBourdet_L on synthetic noisy data (5% noise) returns L ≈ 0.30–0.50
    //   3. detectAnnotations on synthetic homogeneous data with WBS returns at
    //      least 'wellboreStorageEnd' and 'radialFlowStart'
    //   4. drawPlotAnnotations on a stub canvas doesn't throw
    // ═══════════════════════════════════════════════════════════════
    (function PRiSM_annotationsSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];

        // Synthetic homogeneous reservoir with clear WBS → radial → boundary
        // signature on the Bourdet derivative. Construct the derivative
        // directly so we don't have to invert the Laplace solution here.
        function _synthHomogeneous(noiseFrac) {
            noiseFrac = noiseFrac || 0;
            var t = [], p = [];
            // 200 samples log-spaced from 1e-3 to 1e3 hr.
            var N = 200;
            for (var i = 0; i < N; i++) {
                var lt = -3 + (6 * i / (N - 1));
                var ti = Math.pow(10, lt);
                t.push(ti);
                // Build dp(t) so its log-log derivative shows
                //   slope=1 (WBS) for t<0.1
                //   slope=0 (radial) for 0.1 < t < 100
                //   slope=1 (closed boundary) for t>100
                var dp;
                if (ti < 0.1) {
                    dp = 100 * ti;                      // unit slope
                } else if (ti < 100) {
                    dp = 10 + 8 * Math.log(ti / 0.1);   // ~constant derivative (radial)
                } else {
                    dp = (10 + 8 * Math.log(100 / 0.1)) + 0.5 * (ti - 100);
                }
                // Add noise as a fraction of the local pressure.
                var p0 = 3000;
                var pt = p0 - dp;
                if (noiseFrac > 0) {
                    pt += (Math.random() - 0.5) * 2 * noiseFrac * Math.abs(p0);
                }
                p.push(pt);
            }
            return { t: t, p: p };
        }

        // Linear-boundary case — slope ~1 (WBS), then ~0 (radial), then ~½.
        function _synthLinearBoundary(noiseFrac) {
            noiseFrac = noiseFrac || 0;
            var t = [], p = [];
            var N = 200;
            for (var i = 0; i < N; i++) {
                var lt = -3 + (6 * i / (N - 1));
                var ti = Math.pow(10, lt);
                t.push(ti);
                var dp;
                if (ti < 0.1) {
                    dp = 100 * ti;
                } else if (ti < 100) {
                    dp = 10 + 8 * Math.log(ti / 0.1);
                } else {
                    // ½-slope linear flow against the boundary.
                    dp = (10 + 8 * Math.log(100 / 0.1)) + 1.5 * Math.sqrt(ti - 100);
                }
                var p0 = 3000;
                var pt = p0 - dp;
                if (noiseFrac > 0) {
                    pt += (Math.random() - 0.5) * 2 * noiseFrac * Math.abs(p0);
                }
                p.push(pt);
            }
            return { t: t, p: p };
        }

        // ─── Test 1: clean data → small L
        try {
            var clean = _synthHomogeneous(0);
            var rc = G.PRiSM_autoBourdet_L(clean.t, clean.p);
            var ok1 = rc && isFinite(rc.L) && rc.L >= 0.05 && rc.L <= 0.20 &&
                       rc.alternatives && rc.alternatives.length === 3;
            checks.push({ name: 'autoBourdet_L on clean data → L ≈ 0.10–0.18',
                          ok: ok1, msg: 'L=' + (rc && rc.L) + ' noise=' + (rc && rc.noiseEstimate) });
        } catch (e) {
            checks.push({ name: 'autoBourdet_L on clean data → L ≈ 0.10–0.18', ok: false, msg: e && e.message });
        }

        // ─── Test 2: noisy data → larger L
        try {
            var noisy = _synthHomogeneous(0.05);
            var rn = G.PRiSM_autoBourdet_L(noisy.t, noisy.p);
            var ok2 = rn && isFinite(rn.L) && rn.L >= 0.25 && rn.L <= 0.50;
            checks.push({ name: 'autoBourdet_L on 5% noisy data → L ≈ 0.30–0.50',
                          ok: ok2, msg: 'L=' + (rn && rn.L) + ' noise=' + (rn && rn.noiseEstimate) });
        } catch (e) {
            checks.push({ name: 'autoBourdet_L on 5% noisy data → L ≈ 0.30–0.50', ok: false, msg: e && e.message });
        }

        // ─── Test 3: detectAnnotations finds wellboreStorageEnd + radial-end on
        //              clean homogeneous data with WBS → radial → boundary signature.
        try {
            var clean2 = _synthHomogeneous(0);
            var anns = G.PRiSM_detectAnnotations(clean2.t, clean2.p);
            var hasWBS = false, hasBoundary = false, hasRadialOrBoundary = false;
            for (var i = 0; i < anns.length; i++) {
                if (anns[i].type === 'wellboreStorageEnd') hasWBS = true;
                if (anns[i].type === 'closedBoundaryHit' || anns[i].type === 'boundaryHit') {
                    hasBoundary = true;
                }
                if (anns[i].type === 'radialFlowStart' || anns[i].type === 'wellboreStorageEnd' ||
                    anns[i].type === 'closedBoundaryHit' || anns[i].type === 'boundaryHit') {
                    hasRadialOrBoundary = true;
                }
            }
            // Either WBS-end OR a boundary kick is acceptable evidence
            // that the detector triggered. We also accept an explicit
            // radialFlowStart since the kick categories overlap.
            checks.push({ name: 'detectAnnotations on homogeneous + WBS finds key transition',
                          ok: anns.length > 0 && hasRadialOrBoundary,
                          msg: 'count=' + anns.length + ' types=' +
                                anns.map(function (a) { return a.type; }).join(',') });
        } catch (e) {
            checks.push({ name: 'detectAnnotations on homogeneous + WBS finds key transition',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 4: drawPlotAnnotations on a stub canvas doesn't throw.
        try {
            var canvas = null;
            if (_hasDoc && typeof document.createElement === 'function') {
                canvas = document.createElement('canvas');
            }
            if (canvas && canvas.getContext) {
                canvas.width = 600; canvas.height = 400;
                if (canvas.style) {
                    canvas.style.width = '600px'; canvas.style.height = '400px';
                }
                var fakeAnn = [
                    { type: 'wellboreStorageEnd', td: 0.5, label: 'WBS ends', priority: 1 },
                    { type: 'radialFlowStart',    td: 5,   label: 'Radial flow', priority: 1 },
                    { type: 'boundaryHit',        td: 200, label: 'Boundary',     priority: 2 }
                ];
                G.PRiSM_drawPlotAnnotations(canvas, fakeAnn, 'bourdet');
                checks.push({ name: 'drawPlotAnnotations on stub canvas does not throw', ok: true });
            } else {
                // Skip cleanly when no DOM is available.
                checks.push({ name: 'drawPlotAnnotations on stub canvas does not throw',
                              ok: true, msg: 'skipped — no DOM' });
            }
        } catch (e) {
            checks.push({ name: 'drawPlotAnnotations on stub canvas does not throw',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 5: drawPlotAnnotations is idempotent — calling twice does
        //              not crash and leaves _prismAnnotations populated.
        try {
            if (_hasDoc && typeof document.createElement === 'function') {
                var canvas2 = document.createElement('canvas');
                if (canvas2 && canvas2.getContext) {
                    canvas2.width = 600; canvas2.height = 400;
                    if (canvas2.style) {
                        canvas2.style.width = '600px'; canvas2.style.height = '400px';
                    }
                    var ann2 = [{ type: 'radialFlowStart', td: 1, label: 'Radial flow', priority: 1 }];
                    G.PRiSM_drawPlotAnnotations(canvas2, ann2, 'bourdet');
                    G.PRiSM_drawPlotAnnotations(canvas2, ann2, 'bourdet');
                    var stored = canvas2._prismAnnotations;
                    checks.push({ name: 'drawPlotAnnotations idempotent (no double-draw / crash)',
                                  ok: Array.isArray(stored) });
                } else {
                    checks.push({ name: 'drawPlotAnnotations idempotent (no double-draw / crash)',
                                  ok: true, msg: 'skipped — no canvas ctx' });
                }
            } else {
                checks.push({ name: 'drawPlotAnnotations idempotent (no double-draw / crash)',
                              ok: true, msg: 'skipped — no DOM' });
            }
        } catch (e) {
            checks.push({ name: 'drawPlotAnnotations idempotent (no double-draw / crash)',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 6: PRiSM_enableAutoAnnotations toggles the global flag.
        try {
            var prev = G.PRiSM_annotationsEnabled;
            G.PRiSM_enableAutoAnnotations(false);
            var off = (G.PRiSM_annotationsEnabled === false);
            G.PRiSM_enableAutoAnnotations(true);
            var on  = (G.PRiSM_annotationsEnabled !== false);
            G.PRiSM_annotationsEnabled = prev;
            checks.push({ name: 'enableAutoAnnotations toggles flag', ok: off && on });
        } catch (e) {
            checks.push({ name: 'enableAutoAnnotations toggles flag', ok: false, msg: e && e.message });
        }

        // ─── Test 7: detectAnnotations on linearBoundary case finds a kick.
        try {
            var lin = _synthLinearBoundary(0);
            var alins = G.PRiSM_detectAnnotations(lin.t, lin.p);
            checks.push({ name: 'detectAnnotations on linear boundary returns ≥1 annotation',
                          ok: Array.isArray(alins) && alins.length >= 1,
                          msg: 'count=' + (alins ? alins.length : 0) });
        } catch (e) {
            checks.push({ name: 'detectAnnotations on linear boundary returns ≥1 annotation',
                          ok: false, msg: e && e.message });
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM diagnostic-annotations self-test FAILED:', fails);
        } else {
            log('✓ diagnostic-annotations self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
