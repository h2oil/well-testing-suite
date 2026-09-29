// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 15 — Flow-regime markers + derivative smoothing (L)
//   • Auto-pick the Bourdet smoothing L from the gauge noise level
//   • Detect flow-regime transitions and mark them on the log-log plot
//
// PUBLIC API (all on window.*)
//   PRiSM_autoBourdet_L(t, p, q?)            → { L, noiseLevel, noiseEstimate, rationale, alternatives[] }
//   PRiSM_detectAnnotations(t, p, deriv?)    → [{ type, td, label, priority }, ...]  (sorted by td)
//   PRiSM_detectAnnotationsForData(adata)    → same, from C2 analysis data {t, dp, deriv}
//   PRiSM_drawPlotAnnotations(canvas, annotations, plotKey, axes?) → void
//   PRiSM_enableAutoAnnotations(enabled?)    → void  (default true)
//   PRiSM_renderAnnotationToolbar(host)      → void  (Tab 2 panel body)
//
// MOUNTING (C7 — no polling, no function wrapping)
//   • Post-draw hook in window.PRiSM_postDrawHooks draws the markers after
//     every PRiSM_drawActivePlot, from the same data (and L) as the plot.
//   • Tab 2 panel "Flow-regime markers" (PRiSM_registerTabPanel or the
//     PRiSM_tabPanels registry). L is stored in PRiSM_state.bourdetL.
//
// DETECTION
//   • Prefers the regime classifier (PRiSM_classifyRegimes → raw.regimes),
//     falls back to a local log-log slope detector.
//   • Storage-hump guard: a −½ slope is only reported as spherical flow when
//     it starts more than 1.5 log cycles after the derivative maximum, or is
//     preceded by a flat (radial) segment. Otherwise it is the falling limb
//     of the wellbore-storage hump of a damaged well.
//
// Δp is sign-aware (CLAUDE.md): Δp = sign·(p − p0), sign = +1 buildup, −1 drawdown.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined') && !!document && typeof document.createElement === 'function';
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // Theme palette — the plot layer's theme when available, else the dark defaults.
    function _theme() {
        /* global PRiSM_THEME */
        if (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME && typeof PRiSM_THEME === 'object') return PRiSM_THEME;
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg: '#0d1117', panel: '#161b22', border: '#30363d', grid: '#21262d', gridMajor: '#30363d',
            text: '#c9d1d9', text2: '#8b949e', text3: '#6e7681', accent: '#f0883e', blue: '#58a6ff',
            green: '#3fb950', red: '#f85149', yellow: '#d29922', cyan: '#39c5cf', purple: '#bc8cff'
        };
    }

    function _defaultPad() { return { top: 30, right: 80, bottom: 48, left: 64 }; }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _num(v) { return typeof v === 'number' && isFinite(v); }

    function _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _on(target, type, fn) {
        try { if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn); }
        catch (e) { /* stub environments */ }
    }

    function _registerTabPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
        arr.push(spec);
    }

    function _registerPostDraw(fn) {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
        hooks.push(fn);
    }

    function _redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    // Bourdet derivative (3-point, window L in ln t).
    function _bourdet(t, dp, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            try {
                var r = G.PRiSM_compute_bourdet(t, dp, L);
                if (r && r.length === t.length) return r;
            } catch (e) { /* inline fallback */ }
        }
        L = L || 0;
        var n = t.length, d = new Array(n), k;
        for (k = 0; k < n; k++) d[k] = NaN;
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
            d[i] = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT) + (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        }
        return d;
    }

    // Analysis data (C2) with a sign-aware local fallback.
    function _analysisData() {
        var st = G.PRiSM_state || {};
        var L = _num(st.bourdetL) ? st.bourdetL : 0.15;
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var o = { L: L };
                if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
                if (st.timeFn) o.timeFn = st.timeFn;
                var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
                if (ad && ad.ok && ad.t && ad.t.length) return ad;
            } catch (e) { /* fall back */ }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.p || ds.t.length < 5) return { ok: false, t: [], dp: [], deriv: [] };
        var n = ds.t.length, p0 = ds.p[0];
        var sign = (ds.p[n - 1] - p0) >= 0 ? 1 : -1;
        var t = [], p = [], dp = [];
        for (var i = 0; i < n; i++) {
            if (!(ds.t[i] > 0) || !_num(ds.p[i])) continue;
            t.push(ds.t[i]); p.push(ds.p[i]); dp.push(sign * (ds.p[i] - p0));
        }
        return { ok: t.length >= 5, t: t, p: p, dp: dp, deriv: _bourdet(t, dp, L), L: L,
                 pRefSource: 'first-sample', testType: sign > 0 ? 'buildup' : 'drawdown' };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — NOISE-LEVEL ESTIMATOR + L PICKER
    // ═══════════════════════════════════════════════════════════════
    //
    // Gauge noise = RMS(p − 5-point moving average) / mean|p|  (relative).
    // Map noise band → L:
    //   noise < 0.001 → L = 0.10  (clean)
    //   0.001-0.005   → L = 0.18  (typical)
    //   0.005-0.02    → L = 0.30  (noisy)
    //   > 0.02        → L = 0.50  (very noisy)
    // ═══════════════════════════════════════════════════════════════

    function _movingAverage(p, win) {
        var n = p.length, out = new Array(n);
        if (n === 0) return out;
        var half = Math.max(1, Math.floor(win / 2));
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - half), i1 = Math.min(n - 1, i + half), sum = 0, cnt = 0;
            for (var j = i0; j <= i1; j++) if (isFinite(p[j])) { sum += p[j]; cnt++; }
            out[i] = cnt > 0 ? sum / cnt : NaN;
        }
        return out;
    }

    function _meanAbs(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += Math.abs(arr[i]); n++; }
        return n > 0 ? s / n : 0;
    }

    function _rms(arr) {
        var s = 0, n = 0;
        for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) { s += arr[i] * arr[i]; n++; }
        return n > 0 ? Math.sqrt(s / n) : 0;
    }

    function _estimateNoise(p) {
        if (!p || p.length < 5) return 0;
        var smooth = _movingAverage(p, 5), resid = new Array(p.length);
        for (var i = 0; i < p.length; i++) {
            resid[i] = (isFinite(p[i]) && isFinite(smooth[i])) ? (p[i] - smooth[i]) : NaN;
        }
        var mean = _meanAbs(p);
        return mean === 0 ? 0 : _rms(resid) / mean;
    }

    function _pickL(noise) {
        if (!isFinite(noise) || noise <= 0) return { L: 0.18, level: 'low' };
        if (noise < 0.001) return { L: 0.10, level: 'low' };
        if (noise < 0.005) return { L: 0.18, level: 'low' };
        if (noise < 0.02)  return { L: 0.30, level: 'medium' };
        return { L: 0.50, level: 'high' };
    }

    function _rationale(level, noise, L) {
        var pct = (noise * 100).toFixed(2);
        if (level === 'low' && L <= 0.12) return 'Very clean gauge data (~' + pct + '% RMS of mean pressure) — minimal smoothing L=' + L.toFixed(2) + ' preserves regime transitions.';
        if (level === 'low')    return 'Low noise floor (~' + pct + '% of mean pressure) — small L=' + L.toFixed(2) + ' preserves regime transitions.';
        if (level === 'medium') return 'Moderate noise (~' + pct + '% of mean pressure) — standard smoothing L=' + L.toFixed(2) + ' balances detail and noise rejection.';
        return 'Heavy noise (~' + pct + '% of mean pressure) — large L=' + L.toFixed(2) + ' suppresses gauge jitter; sharp transitions may be smeared.';
    }

    var _ALTERNATIVES = [
        { L: 0.10, description: 'minimal smoothing (preserves all features, may be noisy)' },
        { L: 0.30, description: 'standard smoothing (balanced)' },
        { L: 0.50, description: 'heavy smoothing (clean curve, may hide transitions)' }
    ];

    G.PRiSM_autoBourdet_L = function PRiSM_autoBourdet_L(t, p, q) {
        var fallback = { L: 0.18, noiseLevel: 'low', noiseEstimate: 0,
                         rationale: 'Default smoothing L=0.18 (no pressure data supplied).',
                         alternatives: _ALTERNATIVES.slice() };
        try {
            if (!t || !p || typeof p.length !== 'number' || p.length < 5) return fallback;
            var noise = _estimateNoise(p), pick = _pickL(noise);
            return { L: pick.L, noiseLevel: pick.level, noiseEstimate: noise,
                     rationale: _rationale(pick.level, noise, pick.L), alternatives: _ALTERNATIVES.slice() };
        } catch (e) {
            return fallback;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — REGIME-TRANSITION DETECTOR
    // ═══════════════════════════════════════════════════════════════

    var LABELS = {
        wellboreStorageEnd:   'Storage ends',
        radialFlowStart:      'Radial flow',
        linearFlowStart:      '½-slope (linear flow)',
        bilinearFlowStart:    '¼-slope (bilinear flow)',
        bilinearToLinear:     'Bilinear → linear',
        sphericalFlow:        '−½ slope (spherical flow)',
        storageHump:          'Storage hump',
        boundaryHit:          'Boundary effect',
        closedBoundaryHit:    'Closed boundary',
        constPressureHit:     'Pressure support',
        sealingFault:         'Derivative doubling (fault)',
        doublePorosityValley: 'Dual-porosity dip'
    };

    // Classifier regime tag → marker type.
    var TAG_TYPE = {
        radialFlow: 'radialFlowStart', linearFlow: 'linearFlowStart', bilinearFlow: 'bilinearFlowStart',
        sphericalFlow: 'sphericalFlow', constPressure: 'constPressureHit', closedBoundary: 'closedBoundaryHit',
        sealingFault: 'sealingFault', doublePorosity: 'doublePorosityValley', storageHump: 'storageHump',
        wellboreStorage: 'wellboreStorage'
    };

    function _typePriority(type) {
        if (type === 'wellboreStorageEnd' || type === 'radialFlowStart') return 1;
        if (type === 'boundaryHit' || type === 'closedBoundaryHit' || type === 'constPressureHit' || type === 'sealingFault') return 2;
        return 3;
    }

    function _typeLabel(type) { return LABELS[type] || String(type); }

    // Smoothed log-log slope at each point (least squares over ±halfWin points).
    function _logLogSlopes(t, y, halfWin) {
        var n = t.length, slopes = new Array(n), k;
        for (k = 0; k < n; k++) slopes[k] = NaN;
        halfWin = halfWin || 2;
        for (var i = 0; i < n; i++) {
            var i0 = Math.max(0, i - halfWin), i1 = Math.min(n - 1, i + halfWin);
            var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
            for (var j = i0; j <= i1; j++) {
                if (!isFinite(t[j]) || t[j] <= 0 || !isFinite(y[j]) || y[j] <= 0) continue;
                var lx = Math.log10(t[j]), ly = Math.log10(y[j]);
                sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; m++;
            }
            if (m < 3) continue;
            var denom = m * sxx - sx * sx;
            if (Math.abs(denom) < 1e-12) continue;
            slopes[i] = (m * sxy - sx * sy) / denom;
        }
        return slopes;
    }

    function _classifyKick(sBefore, sAfter) {
        if (!isFinite(sBefore) || !isFinite(sAfter)) return null;
        if (sBefore > 0.55 && sAfter < 0.30 && sAfter > -0.30) return { type: 'wellboreStorageEnd' };
        if (sBefore < -0.20 && Math.abs(sAfter) < 0.15)        return { type: 'radialFlowStart' };   // end of a hump or of spherical flow
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.35 && sAfter < 0.65) return { type: 'boundaryHit' };
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter > 0.75) return { type: 'closedBoundaryHit' };
        if (sBefore > -0.20 && sBefore < 0.30 && sAfter < -0.30) return { type: 'sphericalFlow' };
        if (sBefore > 0.35 && sBefore < 0.65 && sAfter > -0.20 && sAfter < 0.30) return { type: 'radialFlowStart' };
        if (sBefore > 0.15 && sBefore < 0.40 && sAfter > 0.40 && sAfter < 0.65) return { type: 'bilinearToLinear' };
        return null;
    }

    function _mk(type, td, extra) {
        var a = { type: type, td: td, label: _typeLabel(type), priority: _typePriority(type) };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
        return a;
    }

    function _findKicks(t, slopes) {
        var n = t.length, out = [];
        for (var i = 1; i < n - 1; i++) {
            if (!isFinite(slopes[i]) || !isFinite(slopes[i - 1])) continue;
            var sBefore = slopes[Math.max(0, i - 5)], sAfter = slopes[Math.min(n - 1, i + 5)];
            if (!isFinite(sBefore) || !isFinite(sAfter)) continue;
            if (Math.abs(sAfter - sBefore) < 0.3) continue;
            var k = _classifyKick(sBefore, sAfter);
            if (!k) continue;
            out.push(_mk(k.type, t[i], { tdStart: t[i], source: 'local' }));
        }
        return out;
    }

    // Sustained runs with slope < −0.3 (≥ 4 points) → candidate spherical flow.
    function _findSphericalRun(t, slopes) {
        var n = t.length, out = [], runStart = -1, runLen = 0;
        function flush() {
            if (runLen >= 4 && runStart >= 0) {
                var mid = runStart + Math.floor(runLen / 2);
                if (t[mid] > 0) out.push(_mk('sphericalFlow', t[mid], { tdStart: t[runStart], source: 'local' }));
            }
            runStart = -1; runLen = 0;
        }
        for (var i = 0; i < n; i++) {
            if (isFinite(slopes[i]) && slopes[i] < -0.30) { if (runStart < 0) runStart = i; runLen++; }
            else flush();
        }
        flush();
        return out;
    }

    // Storage-hump guard. True when a −½ segment starting at tStart is real
    // spherical flow: it starts > 1.5 log cycles after the derivative maximum,
    // or a flat (radial) run of ≥ 3 points spanning ≥ 0.2 cycle precedes it.
    function _isRealSpherical(t, deriv, slopes, tStart) {
        var iMax = -1, vMax = -Infinity, iStart = -1;
        for (var i = 0; i < t.length; i++) {
            if (!(t[i] > 0) || !(t[i] <= tStart * (1 + 1e-9))) continue;
            iStart = i;
            if (deriv[i] > 0 && deriv[i] > vMax) { vMax = deriv[i]; iMax = i; }
        }
        if (iMax < 0) return false;
        if (Math.log10(tStart) - Math.log10(t[iMax]) > 1.5) return true;
        var run = 0, runT0 = 0;
        for (var j = iMax; j <= iStart; j++) {
            if (isFinite(slopes[j]) && Math.abs(slopes[j]) < 0.1) {
                if (run === 0) runT0 = t[j];
                run++;
                if (run >= 3 && Math.log10(t[j]) - Math.log10(runT0) >= 0.2) return true;
            } else {
                run = 0;
            }
        }
        return false;
    }

    function _humpGuard(t, deriv, anns) {
        var slopes = null;
        return anns.map(function (a) {
            if (!a || a.type !== 'sphericalFlow') return a;
            slopes = slopes || _logLogSlopes(t, deriv, 2);
            var tStart = _num(a.tdStart) ? a.tdStart : a.td;
            if (_isRealSpherical(t, deriv, slopes, tStart)) return a;
            return _mk('storageHump', a.td, { tdStart: tStart, source: a.source });
        });
    }

    // Classifier output → markers. Accepts { regimes:[{tag, tdStart, tdEnd,
    // confidence}] } (segments) and older transition-list shapes.
    function _fromClassifier(raw) {
        if (!raw) return null;
        if (!Array.isArray(raw.regimes)) {
            var arr = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions
                    : (Array.isArray(raw.annotations) ? raw.annotations : null));
            if (!arr) return null;
            var legacy = [];
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                if (!e) continue;
                var td = (e.td != null) ? e.td : (e.t != null) ? e.t : e.time;
                if (!isFinite(td) || td <= 0) continue;
                var type = String(e.type || e.regime || e.name || 'transition');
                legacy.push({ type: type, td: Number(td), tdStart: Number(td),
                              label: String(e.label || e.description || _typeLabel(type)),
                              priority: Number(e.priority != null ? e.priority : _typePriority(type)), source: 'classifier' });
            }
            return legacy;
        }
        function sure(r) { return r.confidence == null || r.confidence >= 0.45; }
        var segs = raw.regimes.filter(function (r) {
            return r && r.tag && r.tag !== 'unknown' && _num(r.tdStart) && r.tdStart > 0 &&
                   (r.confidence == null || r.confidence >= 0.3);
        });
        var shapes = segs.filter(function (r) { return (r.tag === 'sealingFault' || r.tag === 'doublePorosity') && sure(r); });
        var all = segs.filter(function (r) { return r.tag !== 'sealingFault' && r.tag !== 'doublePorosity'; })
                      .sort(function (a, b) { return a.tdStart - b.tdStart; });
        // Keep confident segments, plus weaker ones that run into a confident
        // segment of the same regime (so a regime is marked where it starts).
        var seq = all.filter(function (r, i) {
            if (sure(r)) return true;
            for (var j = i + 1; j < all.length && all[j].tag === r.tag; j++) if (sure(all[j])) return true;
            return false;
        });
        var out = [], prevTag = null;
        for (var k = 0; k < seq.length; k++) {
            var r = seq[k];
            if (r.tag === prevTag) continue;                    // merge consecutive segments
            if (prevTag === null) { prevTag = r.tag; continue; } // no marker at the first data point
            var ty = TAG_TYPE[r.tag] || r.tag;
            if (ty === 'wellboreStorage') { prevTag = r.tag; continue; }
            if (ty === 'radialFlowStart' && (prevTag === 'wellboreStorage' || prevTag === 'storageHump')) {
                out.push(_mk('radialFlowStart', r.tdStart, { tdStart: r.tdStart, source: 'classifier' }));
            } else {
                out.push(_mk(ty, r.tdStart, { tdStart: r.tdStart, tdEnd: r.tdEnd, source: 'classifier' }));
            }
            prevTag = r.tag;
        }
        shapes.forEach(function (r) {
            var tdm = _num(r.tdEnd) && r.tdEnd > 0 ? Math.sqrt(r.tdStart * r.tdEnd) : r.tdStart;
            out.push(_mk(TAG_TYPE[r.tag], tdm, { tdStart: r.tdStart, source: 'classifier' }));
        });
        return out;
    }

    var BOUNDARY_TYPES = { boundaryHit: 1, closedBoundaryHit: 1, constPressureHit: 1, sealingFault: 1 };

    function _dedup(anns) {
        anns.sort(function (a, b) { return a.td - b.td; });
        var out = [];
        for (var i = 0; i < anns.length; i++) {
            var cur = anns[i], skip = false;
            for (var j = 0; j < out.length; j++) {
                var gap = Math.abs(Math.log10(cur.td) - Math.log10(out[j].td));
                if (BOUNDARY_TYPES[cur.type] && BOUNDARY_TYPES[out[j].type] && out[j].type !== cur.type && gap < 0.3) {
                    out[j] = cur;              // keep the later, more specific boundary label
                    skip = true; break;
                }
                if (out[j].type !== cur.type) continue;
                var repeatable = cur.type === 'sphericalFlow' || cur.type === 'storageHump' || cur.type === 'radialFlowStart';
                if (!repeatable || gap < 1.0) { skip = true; break; }
            }
            if (!skip) out.push(cur);
        }
        return out;
    }

    // Core detector on sign-aware Δp and its derivative.
    function _detectCore(t, dp, deriv) {
        var anns = null, source = 'fallback';
        if (typeof G.PRiSM_classifyRegimes === 'function') {
            try {
                anns = _fromClassifier(G.PRiSM_classifyRegimes(t, dp, deriv));
                if (anns && anns.length) source = 'classifyRegimes';
            } catch (e) { anns = null; }
        }
        if (!anns || !anns.length) {
            var slopes = _logLogSlopes(t, deriv, 2);
            anns = _findKicks(t, slopes);
            var spheres = _findSphericalRun(t, slopes);
            for (var s = 0; s < spheres.length; s++) {
                var dup = false;
                for (var m = 0; m < anns.length; m++) {
                    if (anns[m].type !== 'sphericalFlow') continue;
                    var lk = Math.log10(anns[m].td);
                    if (Math.abs(Math.log10(spheres[s].td) - lk) < 0.3 ||
                        Math.abs(Math.log10(spheres[s].tdStart) - lk) < 0.3) { dup = true; break; }
                }
                if (!dup) anns.push(spheres[s]);
            }
            source = 'fallback';
        }
        var out = _dedup(_humpGuard(t, deriv, anns));
        out._source = source;
        return out;
    }

    function _toArr(a) {
        if (!a) return null;
        if (Array.isArray(a)) return a;
        try { return Array.prototype.slice.call(a); } catch (e) { return null; }
    }

    // Legacy signature: (t, p, deriv?) — p is pressure; Δp is sign-aware.
    G.PRiSM_detectAnnotations = function PRiSM_detectAnnotations(t, p, deriv) {
        try {
            t = _toArr(t); p = _toArr(p); deriv = _toArr(deriv);
            if (!t || t.length < 5 || !p || p.length !== t.length) return [];
            var n = t.length, sign = (p[n - 1] - p[0]) >= 0 ? 1 : -1, dp = new Array(n);
            for (var i = 0; i < n; i++) dp[i] = sign * (p[i] - p[0]);
            if (!deriv || deriv.length !== n) {
                deriv = _bourdet(t, dp, G.PRiSM_autoBourdet_L(t, p).L);
            } else {
                deriv = deriv.map(function (v) { return Math.abs(v); });
            }
            return _detectCore(t, dp, deriv);
        } catch (e) {
            try { console.warn('PRiSM_detectAnnotations error:', e && e.message); } catch (_) { /* ignore */ }
            return [];
        }
    };

    // From C2 analysis data {t, dp (≥0), deriv}.
    G.PRiSM_detectAnnotationsForData = function PRiSM_detectAnnotationsForData(ad) {
        try {
            if (!ad || !ad.t || !ad.dp || ad.t.length < 5) return [];
            var t = _toArr(ad.t), dp = _toArr(ad.dp), deriv = _toArr(ad.deriv);
            if (!deriv || deriv.length !== t.length) {
                var st = G.PRiSM_state || {};
                deriv = _bourdet(t, dp, _num(ad.L) ? ad.L : (_num(st.bourdetL) ? st.bourdetL : 0.15));
            }
            return _detectCore(t, dp, deriv);
        } catch (e) {
            return [];
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — MARKER RENDERER
    // ═══════════════════════════════════════════════════════════════
    // Uses the plot's own world→pixel transform (canvas._prismAxes, C6).
    // Markers make sense on plots whose x axis is Δt: log-log derivative and
    // semilog (MDH). Labels are drawn inside the plot box, near its top.
    // ═══════════════════════════════════════════════════════════════

    var ANN_PLOTS = { bourdet: 1, mdh: 1 };

    function _axisFwd(sc, off, len, flip) {
        if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
        if (sc.kind === 'log') {
            if (!(sc.min > 0 && sc.max > 0)) return null;
            var a = Math.log10(sc.min), b = Math.log10(sc.max);
            return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
        }
        return function (v) { var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
    }

    function _plotRectFromCanvas(canvas) {
        var cssW = canvas.clientWidth || canvas.width || 600, cssH = canvas.clientHeight || canvas.height || 400;
        if (canvas.style && canvas.style.width) { var w = parseInt(canvas.style.width, 10); if (w > 0) cssW = w; }
        if (canvas.style && canvas.style.height) { var h = parseInt(canvas.style.height, 10); if (h > 0) cssH = h; }
        var pad = _defaultPad();
        return { x: pad.left, y: pad.top, w: Math.max(1, cssW - pad.left - pad.right), h: Math.max(1, cssH - pad.top - pad.bottom) };
    }

    // → { toX, plot, xMin, xMax } or null
    function _xTransform(canvas, axes) {
        var ax = axes || (canvas && canvas._prismAxes) || null;
        if (ax && ax.plot && ax.scaleX) {
            var toX = (typeof ax.toX === 'function') ? ax.toX : _axisFwd(ax.scaleX, ax.plot.x, ax.plot.w, false);
            if (toX) return { toX: toX, plot: ax.plot, xMin: ax.scaleX.min, xMax: ax.scaleX.max, kind: ax.scaleX.kind };
        }
        var os = canvas && canvas._prismOriginalScale;
        if (os && os.x && _num(os.x.min) && _num(os.x.max)) {
            var pr = _plotRectFromCanvas(canvas);
            var fx = _axisFwd({ kind: os.x.kind || 'log', min: os.x.min, max: os.x.max }, pr.x, pr.w, false);
            if (fx) return { toX: fx, plot: pr, xMin: os.x.min, xMax: os.x.max, kind: os.x.kind || 'log' };
        }
        return null;
    }

    function _colorForPriority(priority) {
        var th = _theme();
        if (priority === 1) return th.accent || '#f0883e';
        if (priority === 2) return th.blue || '#58a6ff';
        return th.text2 || '#8b949e';
    }

    G.PRiSM_drawPlotAnnotations = function PRiSM_drawPlotAnnotations(canvas, annotations, plotKey, axes) {
        if (!canvas || !canvas.getContext) return;
        plotKey = plotKey || 'bourdet';
        if (!Array.isArray(annotations) || !annotations.length || !ANN_PLOTS[plotKey]) {
            try { canvas._prismAnnotations = []; } catch (e) { /* ignore */ }
            return;
        }
        if (canvas._prismAnnotationsDrawing) return;          // re-entrancy guard
        canvas._prismAnnotationsDrawing = true;
        try {
            var ctx = canvas.getContext('2d');
            var tr = _xTransform(canvas, axes);
            if (!ctx || !tr) { canvas._prismAnnotations = []; return; }
            var plot = tr.plot, visible = [];
            for (var i = 0; i < annotations.length; i++) {
                var a = annotations[i];
                if (!a || !_num(a.td)) continue;
                if (tr.kind === 'log' && a.td <= 0) continue;
                if (a.td < Math.min(tr.xMin, tr.xMax) || a.td > Math.max(tr.xMin, tr.xMax)) continue;
                var px = tr.toX(a.td);
                if (!_num(px) || px < plot.x - 1 || px > plot.x + plot.w + 1) continue;
                visible.push({ ann: a, px: px });
            }
            canvas._prismAnnotations = visible.slice();
            canvas._prismAnnotationsDrawCount = (canvas._prismAnnotationsDrawCount || 0) + 1;
            ctx.save();
            ctx.font = '11px sans-serif';
            for (var k = 0; k < visible.length; k++) {
                var aa = visible[k].ann, x = visible[k].px, color = _colorForPriority(aa.priority);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(x + 0.5, plot.y);
                ctx.lineTo(x + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);
                // Rotated label inside the plot box, reading bottom-to-top,
                // ending just below the top edge; alternate sides of the line.
                var text = String(aa.label || aa.type || '');
                var tw = ctx.measureText(text).width || 0;
                var off = (k % 2 === 0) ? -4 : 12;
                ctx.save();
                ctx.translate(x + off, plot.y + 6);
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(13,17,23,0.78)';
                ctx.fillRect(-tw - 2, -7, tw + 4, 13);
                ctx.fillStyle = color;
                ctx.fillText(text, 0, 0);
                ctx.restore();
            }
            ctx.restore();
        } catch (e) {
            try { console.warn('PRiSM_drawPlotAnnotations error:', e && e.message); } catch (_) { /* ignore */ }
        } finally {
            canvas._prismAnnotationsDrawing = false;
        }
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — POST-DRAW HOOK (C7)
    // ═══════════════════════════════════════════════════════════════

    if (typeof G.PRiSM_annotationsEnabled === 'undefined') G.PRiSM_annotationsEnabled = true;

    var _cache = { key: null, anns: null };

    function _sig(t, dp, deriv) {
        var n = t.length, mid = Math.floor(n / 2);
        return [n, t[0], t[n - 1], dp[0], dp[n - 1], deriv[mid], deriv[n - 2],
                typeof G.PRiSM_classifyRegimes === 'function' ? 1 : 0].join('|');
    }

    function _annotationsFor(t, dp, deriv) {
        var key = _sig(t, dp, deriv);
        if (_cache.key === key && _cache.anns) return _cache.anns;
        var anns = _detectCore(_toArr(t), _toArr(dp), _toArr(deriv));
        _cache = { key: key, anns: anns };
        return anns;
    }

    function _annotationsPostDraw(info) {
        if (!info || !info.canvas || G.PRiSM_annotationsEnabled === false) return;
        var st = G.PRiSM_state || {};
        var plotKey = info.plotKey || st.activePlot || 'bourdet';
        if (!ANN_PLOTS[plotKey]) return;
        var d = info.data, t, dp, deriv;
        if (d && d.t && d.dp && d.deriv && d.t.length >= 5 && d.dp.length === d.t.length && d.deriv.length === d.t.length) {
            t = d.t; dp = d.dp; deriv = d.deriv;         // exactly what the plot shows (same L)
        } else {
            var ad = _analysisData();
            if (!ad || !ad.ok || !ad.deriv) return;
            t = ad.t; dp = ad.dp; deriv = ad.deriv;
        }
        var anns = _annotationsFor(t, dp, deriv);
        G.PRiSM_drawPlotAnnotations(info.canvas, anns, plotKey, info.axes || info.canvas._prismAxes);
    }
    _annotationsPostDraw._prismId = 'flow-regime-markers';
    _registerPostDraw(_annotationsPostDraw);

    G.PRiSM_enableAutoAnnotations = function PRiSM_enableAutoAnnotations(enabled) {
        G.PRiSM_annotationsEnabled = (typeof enabled === 'undefined') ? true : !!enabled;
        _redraw();
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — TAB 2 PANEL: "Flow-regime markers"
    // ═══════════════════════════════════════════════════════════════

    function _currentL() {
        var st = G.PRiSM_state || {};
        return _num(st.bourdetL) ? st.bourdetL : 0.15;
    }

    function _setL(L) {
        var st = G.PRiSM_state;
        if (!st) return;
        st.bourdetL = Math.max(0, Math.min(0.5, L));
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
    }

    function _fmtT(t) {
        if (!_num(t)) return '—';
        if (t >= 100) return t.toFixed(0);
        if (t >= 1) return t.toPrecision(3).replace(/\.?0+$/, '');
        return t.toPrecision(2);
    }

    function _detectedText() {
        var ad = _analysisData();
        if (!ad || !ad.ok) return 'No pressure data to analyse.';
        var anns = _annotationsFor(ad.t, ad.dp, ad.deriv);
        if (!anns.length) return 'No clear flow-regime transition detected.';
        return 'Detected: ' + anns.map(function (a) { return a.label + ' (' + _fmtT(a.td) + ' hr)'; }).join(' · ');
    }

    function _updateInfo(host, info) {
        var line = host.querySelector('#prism_ann_infoline');
        if (line) {
            line.textContent = info ? ('Noise: ' + info.noiseLevel + ' (~' + (info.noiseEstimate * 100).toFixed(2) +
                                       '% RMS) · suggested L = ' + info.L.toFixed(2)) : '';
            if (info) line.title = info.rationale || '';
        }
        var list = host.querySelector('#prism_ann_list');
        if (list) { try { list.textContent = _detectedText(); } catch (e) { list.textContent = ''; } }
    }

    G.PRiSM_renderAnnotationToolbar = function PRiSM_renderAnnotationToolbar(container) {
        var host = (typeof container === 'string') ? (_hasDoc ? document.getElementById(container) : null) : container;
        if (!host) return;
        var enabled = (G.PRiSM_annotationsEnabled !== false);
        var L = _currentL();
        host.innerHTML =
            '<div class="prism-regimes" style="max-width:100%; box-sizing:border-box; font-size:12px; color:var(--text, #e6edf3);">' +
                '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px;">' +
                    '<label style="display:flex; align-items:center; gap:6px; cursor:pointer;">' +
                        '<input type="checkbox" id="prism_ann_show"' + (enabled ? ' checked' : '') + '>' +
                        '<span>Show flow-regime markers</span></label>' +
                    '<label style="display:flex; align-items:center; gap:6px;">' +
                        '<span>Derivative smoothing L</span>' +
                        '<input type="number" id="prism_ann_L" min="0" max="0.5" step="0.01" value="' + L.toFixed(2) + '" ' +
                            'style="width:72px; padding:4px 6px; background:var(--bg1, #0d1117); color:var(--text, #e6edf3); ' +
                            'border:1px solid var(--border, #30363d); border-radius:4px;"></label>' +
                    '<button type="button" class="btn btn-secondary" id="prism_ann_autoL" ' +
                        'style="font-size:12px; padding:5px 10px;">Auto L</button>' +
                '</div>' +
                '<div id="prism_ann_infoline" style="margin-top:6px; font-size:11px; color:var(--text2, #8b949e); min-height:14px;"></div>' +
                '<div id="prism_ann_list" role="status" style="margin-top:4px; font-size:12px; color:var(--text2, #8b949e); overflow-wrap:anywhere;"></div>' +
            '</div>';

        _updateInfo(host, null);
        var showChk = host.querySelector('#prism_ann_show');
        var lIn     = host.querySelector('#prism_ann_L');
        var autoBtn = host.querySelector('#prism_ann_autoL');

        if (showChk) showChk.addEventListener('change', function () {
            G.PRiSM_enableAutoAnnotations(!!showChk.checked);
            _ga4('prism_annotation_toggle', { enabled: !!showChk.checked });
        });
        if (lIn) lIn.addEventListener('change', function () {
            var v = parseFloat(lIn.value);
            if (!isFinite(v)) { lIn.value = _currentL().toFixed(2); return; }
            _setL(v);
            lIn.value = _currentL().toFixed(2);
            _redraw();
            _updateInfo(host, null);
        });
        if (autoBtn) autoBtn.addEventListener('click', function () {
            var ad = _analysisData();
            var info = G.PRiSM_autoBourdet_L(ad && (ad.tAbs || ad.t), ad && ad.p);
            _setL(info.L);
            if (lIn) lIn.value = _currentL().toFixed(2);
            _redraw();
            _updateInfo(host, info);
            _ga4('prism_annotation_toggle', { enabled: G.PRiSM_annotationsEnabled !== false, action: 'autoL', L: info.L });
        });
    };

    _registerTabPanel(2, {
        id: 'regimes',
        title: 'Flow-regime markers',
        order: 20,
        collapsed: false,
        render: function (host) { G.PRiSM_renderAnnotationToolbar(host); }
    });

    _on(G, 'prism:dataset-loaded', function () { _cache = { key: null, anns: null }; });


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════
    (function PRiSM_annotationsSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];
        var savedClassifier = G.PRiSM_classifyRegimes;

        function logspace(a, b, n) { var o = []; for (var i = 0; i < n; i++) o.push(Math.pow(10, a + (b - a) * i / (n - 1))); return o; }
        // Δp from a derivative shape: Δp = Δp0 + ∫ Δp′ d ln t.
        function integrate(t, d, dp0) {
            var dp = [dp0];
            for (var i = 1; i < t.length; i++) dp.push(dp[i - 1] + 0.5 * (d[i] + d[i - 1]) * Math.log(t[i] / t[i - 1]));
            return dp;
        }
        function types(a) { return a.map(function (x) { return x.type; }).join(','); }

        try {
            // 1-2. Auto L on clean vs noisy pressure.
            var tc = logspace(-3, 3, 200), pc = [], pn = [];
            for (var i = 0; i < tc.length; i++) {
                var dpv = tc[i] < 0.1 ? 100 * tc[i] : 10 + 8 * Math.log(tc[i] / 0.1);
                pc.push(3000 - dpv);
                pn.push(3000 - dpv + (((i * 7919) % 1000) / 1000 - 0.5) * 2 * 0.05 * 3000);
            }
            var rc = G.PRiSM_autoBourdet_L(tc, pc), rn = G.PRiSM_autoBourdet_L(tc, pn);
            checks.push({ name: 'auto L: clean data → small L', ok: rc.L >= 0.05 && rc.L <= 0.2 && rc.alternatives.length === 3 });
            checks.push({ name: 'auto L: 5% noise → large L', ok: rn.L >= 0.25 && rn.L <= 0.5 });

            G.PRiSM_classifyRegimes = undefined;       // exercise the local detector

            // 3. Storage hump then radial flow (damaged well): no spherical marker.
            var th = logspace(-2, 2, 60), dh = th.map(function (x) {
                return 52 + 300 * Math.exp(-Math.pow(Math.log10(x / 0.01), 2) / 0.3);
            });
            var ah = G.PRiSM_detectAnnotationsForData({ t: th, dp: integrate(th, dh, 340), deriv: dh });
            checks.push({ name: 'storage hump is not tagged spherical', msg: types(ah),
                          ok: ah.every(function (a) { return a.type !== 'sphericalFlow'; }) &&
                              ah.some(function (a) { return a.type === 'radialFlowStart' || a.type === 'storageHump'; }) });

            // 4. Partial penetration: early plateau → −½ slope → late plateau.
            var tp = logspace(-2, 3, 80), dpp = tp.map(function (x) {
                return x < 0.1 ? 200 : (x < 10 ? 200 * Math.pow(x / 0.1, -0.5) : 20);
            });
            var ap = G.PRiSM_detectAnnotationsForData({ t: tp, dp: integrate(tp, dpp, 50), deriv: dpp });
            checks.push({ name: 'spherical flow after a flat segment is kept', msg: types(ap),
                          ok: ap.some(function (a) { return a.type === 'sphericalFlow'; }) });

            // 5. Legacy signature on a drawdown (sign-aware Δp) finds transitions.
            var tw = logspace(-3, 3, 200), pw = tw.map(function (x) {
                return 3000 - (x < 0.1 ? 100 * x : (x < 100 ? 10 + 8 * Math.log(x / 0.1) : 10 + 8 * Math.log(1000) + 0.5 * (x - 100)));
            });
            var aw = G.PRiSM_detectAnnotations(tw, pw);
            checks.push({ name: 'drawdown (falling p) still yields markers', ok: aw.length > 0, msg: types(aw) });

            // 6. Classifier regimes are consumed.
            G.PRiSM_classifyRegimes = function () {
                return { regimes: [
                    { tag: 'wellboreStorage', tdStart: 0.001, tdEnd: 0.05, confidence: 0.9 },
                    { tag: 'sphericalFlow',   tdStart: 0.06,  tdEnd: 0.2,  confidence: 0.8 },
                    { tag: 'radialFlow',      tdStart: 0.3,   tdEnd: 50,   confidence: 0.9 },
                    { tag: 'closedBoundary',  tdStart: 60,    tdEnd: 500,  confidence: 0.8 }
                ] };
            };
            var tq = logspace(-3, 3, 100), dq = tq.map(function (x) {
                return x < 0.02 ? 1000 * x : 20 + 200 * Math.exp(-Math.pow(Math.log10(x / 0.02), 2) / 0.2) + (x > 60 ? x : 0);
            });
            var aq = G.PRiSM_detectAnnotationsForData({ t: tq, dp: integrate(tq, dq, 1), deriv: dq });
            checks.push({ name: 'classifier regimes → markers (hump guard applied)', msg: types(aq),
                          ok: aq._source === 'classifyRegimes' && aq.some(function (a) { return a.type === 'radialFlowStart'; }) &&
                              aq.some(function (a) { return a.type === 'closedBoundaryHit'; }) &&
                              aq.every(function (a) { return a.type !== 'sphericalFlow'; }) });

            // 7. Post-draw hook registered once.
            var hooks = G.PRiSM_postDrawHooks || [];
            checks.push({ name: 'post-draw hook registered once',
                          ok: hooks.filter(function (f) { return f && f._prismId === 'flow-regime-markers'; }).length === 1 });

            // 8. Toggle flag.
            var prev = G.PRiSM_annotationsEnabled;
            G.PRiSM_enableAutoAnnotations(false);
            var off = G.PRiSM_annotationsEnabled === false;
            G.PRiSM_enableAutoAnnotations(true);
            checks.push({ name: 'enableAutoAnnotations toggles the flag', ok: off && G.PRiSM_annotationsEnabled === true });
            G.PRiSM_annotationsEnabled = prev;
        } catch (e) {
            checks.push({ name: 'self-test ran without throwing', ok: false, msg: e && e.message });
        } finally {
            G.PRiSM_classifyRegimes = savedClassifier;
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) err('PRiSM flow-regime markers self-test FAILED:', JSON.stringify(fails));
        else log('✓ flow-regime markers self-test passed (' + checks.length + ' checks).');
    })();

})();
