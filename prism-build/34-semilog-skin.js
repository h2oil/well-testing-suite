// =============================================================================
// PRiSM — 34-semilog-skin.js  (Round 8)
// Straight-line (semilog) analysis and skin deliverables
// =============================================================================
//
// What this file provides
//   window.PRiSM_semilogAnalysis(adata?, well?, opts?) → result (also st.semilog)
//       MDH (drawdown / injection), Horner (single-rate build-up / fall-off),
//       superposition (multi-rate) and Agarwal equivalent-time straight lines.
//       Auto IARF window from the derivative, m, kh, k, p1hr, p*, S, log-log
//       cross-check, unit-slope C / CD, IARF-start check, rinv.
//   window.PRiSM_skinSummary(o)        → ΔpS, FE, DR, J, J_ideal, rw′, CD·e^2S
//   window.PRiSM_skinDecomposition(o)  → S_pp, S_θ, S_f, D·q, S_mech
//   window.PRiSM_rateDependentSkin(rows) → least-squares S′ = S + D·q
//   window.PRiSM_renderSemilogPanel(hostEl)  (Tab 2 panel, C7)
//   window.PRiSM_semilogPlotLine(plotKey)    → C6 line object for mdh / horner
//   window.PRiSM_semilog_plot_mdh(canvas, data, opts)  (delegates to
//       window.PRiSM_plot_mdh when the plot layer provides it)
//   window.PRiSM_semilog = { helpers used by tests and other layers }
//
// Contracts used (all optional — local fallbacks keep this file standalone):
//   C1 PRiSM_getWell, C2 PRiSM_getAnalysisData, C6 canvas._prismAxes,
//   C7 PRiSM_registerTabPanel / PRiSM_tabPanels / PRiSM_postDrawHooks /
//   PRiSM_PLOT_REGISTRY, pseudo-skin library PRiSM_pseudoSkin.
//
// Units: field units. Δt in hours, p in psia, q in STB/d (oil / water) or
// Mscf/d (gas), B in RB/STB (or RB/Mscf), μ in cp, ct in 1/psi, h, rw in ft.
//
// Equations (field units)
//   Superposition time for analysed period n (steps i = 1..n start at T_i,
//   rate q_i, q_0 = 0):
//     X(Δt) = Σ_i (q_i − q_{i−1})/(q_n − q_{n−1}) · log10(T_n − T_i + Δt)
//   n = 1 gives MDH (X = log10 Δt); single-rate build-up gives
//   X = −log10((tp+Δt)/Δt) (Horner).
//   Line on the window: Δp = a + s·X.   |m| = |s| psi/cycle.
//   kh = 162.6·|Δq_n|·B·μ/|m|    (gas Δm(p): kh = 1637·|Δq_n|·T/|m|)
//   K  = a/s + W,  W = Σ_{i<n} (Δq_i/Δq_n)·log10(T_n − T_i)   (Δp from the
//        pressure at the start of the period)
//   K  = a·Δq_n/(s·q_n)                                         (Δp from pi)
//   S  = 1.1513·[K − log10(k/(φ μ ct rw²)) + 3.2275]
//   For MDH this is S = 1.1513[(pi − p1hr)/|m| − log10(k/(φμct rw²)) + 3.2275];
//   for Horner S = 1.1513[(p1hr − pwf0)/|m| − log10(k/(φμct rw²)) + 3.2275
//   + log10((tp+1)/tp)].
//   Log-log check: kh = 70.6·q·B·μ/Δp′_r,
//   S_ll = 0.5·[Δp/Δp′_r − ln(0.0002637·k·t/(φμct rw²)) − 0.80907].
//   Unit slope: C = q·B·Δt/(24·Δp), CD = 0.8936·C/(φ·ct·h·rw²).
//   IARF start ≈ (200000 + 12000·S)·C·μ/kh  hours.
//   rinv = √(k·t/(948·φ·μ·ct)).
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var HAS_DOC = (typeof document !== 'undefined') && document && typeof document.createElement === 'function';

    var LN10 = Math.LN10;

    // Default-sample metadata (C1). WP8 defines window.PRiSM_DEFAULT_SAMPLE_META;
    // this copy is used only when that is absent.
    var SAMPLE_META_FALLBACK = {
        pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5,
        h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil'
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — SMALL NUMERIC HELPERS
    // ═══════════════════════════════════════════════════════════════

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function pos(v) { return isNum(v) && v > 0; }
    function firstNum() {
        for (var i = 0; i < arguments.length; i++) {
            var v = arguments[i];
            if (typeof v === 'string' && v.trim() !== '') v = parseFloat(v);
            if (isNum(v)) return v;
        }
        return null;
    }
    function median(arr) {
        var a = [];
        for (var i = 0; i < arr.length; i++) if (isNum(arr[i])) a.push(arr[i]);
        if (!a.length) return NaN;
        a.sort(function (x, y) { return x - y; });
        var m = a.length >> 1;
        return (a.length % 2) ? a[m] : 0.5 * (a[m - 1] + a[m]);
    }
    function toArr(v) {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        try { return Array.prototype.slice.call(v); } catch (e) { return []; }
    }

    // Ordinary least squares y = a + b·x (centred for numerical stability).
    function linfit(xs, ys) {
        var n = 0, mx = 0, my = 0, i;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            n++; mx += xs[i]; my += ys[i];
        }
        if (n < 2) return { ok: false, n: n };
        mx /= n; my /= n;
        var sxx = 0, sxy = 0, syy = 0;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            var dx = xs[i] - mx, dy = ys[i] - my;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
        if (!(sxx > 0)) return { ok: false, n: n };
        var b = sxy / sxx, a = my - b * mx;
        var sse = 0;
        for (i = 0; i < xs.length; i++) {
            if (!isNum(xs[i]) || !isNum(ys[i])) continue;
            var r = ys[i] - (a + b * xs[i]);
            sse += r * r;
        }
        var r2 = syy > 0 ? 1 - sse / syy : 1;
        var seB = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN;
        return { ok: true, a: a, b: b, r2: r2, n: n, sse: sse, seSlope: seB };
    }

    // Bourdet derivative d(y)/d(ln x) with smoothing window L (natural-log
    // units); one-sided differences at the ends so the last point is usable.
    function bourdet(x, y, L) {
        var n = x.length, d = new Array(n), i;
        L = isNum(L) && L > 0 ? L : 0;
        var lx = new Array(n);
        for (i = 0; i < n; i++) lx[i] = x[i] > 0 ? Math.log(x[i]) : NaN;
        for (i = 0; i < n; i++) {
            d[i] = NaN;
            if (!isNum(lx[i]) || !isNum(y[i])) continue;
            // Nearest neighbours at least L (and strictly > 0) away in ln x.
            var i1 = i - 1, i2 = i + 1;
            while (i1 >= 0 && !(isNum(lx[i1]) && lx[i] - lx[i1] > 0 && lx[i] - lx[i1] >= L)) i1--;
            while (i2 < n && !(isNum(lx[i2]) && lx[i2] - lx[i] > 0 && lx[i2] - lx[i] >= L)) i2++;
            var hasL = i1 >= 0 && isNum(y[i1]), hasR = i2 < n && isNum(y[i2]);
            if (hasL && hasR) {
                var dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = dl1 + dl2;
                d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
            } else if (hasL) {
                d[i] = (y[i] - y[i1]) / (lx[i] - lx[i1]);
            } else if (hasR) {
                d[i] = (y[i2] - y[i]) / (lx[i2] - lx[i]);
            }
        }
        return d;
    }

    // Local log-log slope of v against x: LS of ln v vs ln x over the points
    // within ±hw (ln units) of each point. NaN where fewer than 3 points.
    function localLogSlope(x, v, hw) {
        var n = x.length, out = new Array(n), lx = [], lv = [], i, j;
        for (i = 0; i < n; i++) {
            lx.push(x[i] > 0 ? Math.log(x[i]) : NaN);
            lv.push(v[i] > 0 ? Math.log(v[i]) : NaN);
        }
        for (i = 0; i < n; i++) {
            out[i] = NaN;
            if (!isNum(lx[i]) || !isNum(lv[i])) continue;
            var xs = [], ys = [];
            for (j = i; j >= 0 && (!isNum(lx[j]) || lx[i] - lx[j] <= hw); j--) {
                if (isNum(lx[j]) && isNum(lv[j])) { xs.push(lx[j]); ys.push(lv[j]); }
            }
            for (j = i + 1; j < n && (!isNum(lx[j]) || lx[j] - lx[i] <= hw); j++) {
                if (isNum(lx[j]) && isNum(lv[j])) { xs.push(lx[j]); ys.push(lv[j]); }
            }
            if (xs.length < 3) continue;
            var f = linfit(xs, ys);
            if (f.ok) out[i] = f.b;
        }
        return out;
    }

    function dsHash(ds) {
        if (!ds || !ds.t || !ds.p) return '';
        var t = toArr(ds.t), p = toArr(ds.p), n = t.length, s = 0;
        for (var i = 0; i < n; i++) if (isNum(p[i])) s += p[i] * ((i % 7) + 1);
        return n + ':' + t[0] + ':' + t[n - 1] + ':' + p[0] + ':' + p[n - 1] + ':' + s.toFixed(3);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — WELL + ANALYSIS DATA (C1 / C2 with local fallbacks)
    // ═══════════════════════════════════════════════════════════════

    function _isDefaultSample(ds) {
        var csv = G.PRiSM_DEFAULT_SAMPLE_CSV;
        if (!ds || !ds.t || !ds.p || typeof csv !== 'string') return false;
        var lines = csv.trim().split(/\r?\n/), rows = [];
        for (var i = 1; i < lines.length; i++) {
            var c = lines[i].split(',');
            var tt = parseFloat(c[0]), pp = parseFloat(c[1]);
            if (isNum(tt) && isNum(pp)) rows.push([tt, pp]);
        }
        var t = toArr(ds.t), p = toArr(ds.p);
        if (t.length !== rows.length) return false;
        for (var k = 0; k < rows.length; k++) {
            if (Math.abs(t[k] - rows[k][0]) > 1e-9 || Math.abs(p[k] - rows[k][1]) > 1e-6) return false;
        }
        return true;
    }

    function _lastNonZero(q) {
        q = toArr(q);
        for (var i = q.length - 1; i >= 0; i--) if (isNum(q[i]) && q[i] !== 0) return q[i];
        return null;
    }

    // Local well reader used only when window.PRiSM_getWell (C1, WP1) is absent.
    function localWell(ds) {
        var pvt = G.PRiSM_pvt || {};
        var c = pvt._computed || {};
        if ((c.B == null || c.mu == null || c.ct == null) && typeof G.PRiSM_pvt_compute === 'function') {
            try { var cc = G.PRiSM_pvt_compute(); if (cc && typeof cc === 'object') c = cc; } catch (e) { /* ignore */ }
        }
        var fluid = pvt.fluidType || 'oil';
        var w = {
            fluid: fluid,
            q: firstNum(_lastNonZero(ds && ds.q), pvt.q),
            B: fluid === 'gas' ? firstNum(pvt.Bg, c.Bg, c.B) : (fluid === 'water' ? firstNum(pvt.Bw, 1) : firstNum(pvt.Bo, c.Bo, c.B)),
            mu: fluid === 'gas' ? firstNum(pvt.mu_g, c.mu_g, c.mu) : (fluid === 'water' ? firstNum(pvt.mu_w, c.mu) : firstNum(pvt.mu_o, c.mu_o, c.mu)),
            ct: firstNum(pvt.ct, c.ct),
            h: firstNum(pvt.h), phi: firstNum(pvt.phi), rw: firstNum(pvt.rw),
            pi: null,
            T_R: isNum(pvt.T_res) ? pvt.T_res + 459.67 : null,
            testType: pvt.testType || 'auto',
            tp: firstNum(pvt.tp), tShut: firstNum(pvt.tShut), pwf0: firstNum(pvt.pwf0),
            defaulted: [], missing: [], source: 'local'
        };
        var prov = pvt.provenance && pvt.provenance.p_res;
        if (prov === 'user' || prov === 'sample' || prov === 'deconvolution') w.pi = firstNum(pvt.p_res);
        if (_isDefaultSample(ds)) {
            var M = G.PRiSM_DEFAULT_SAMPLE_META || SAMPLE_META_FALLBACK;
            w.pi = M.pi; w.testType = M.testType || 'drawdown'; w.q = M.q; w.B = M.Bo; w.mu = M.mu_o;
            w.ct = M.ct; w.h = M.h; w.phi = M.phi; w.rw = M.rw; w.fluid = M.fluidType || 'oil';
            w.source = 'sample';
        }
        ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].forEach(function (k) { if (!pos(w[k])) w.missing.push(k); });
        w.complete = w.missing.length === 0;
        return w;
    }

    function getWell(ds) {
        if (typeof G.PRiSM_getWell === 'function') {
            try {
                var w = G.PRiSM_getWell(ds);
                if (w && typeof w === 'object') return w;
            } catch (e) { /* fall through */ }
        }
        return localWell(ds);
    }

    // Rate steps from a q column: [{t0, q}] merging changes < 1 % relative.
    function _stepsFromRates(t, q) {
        var steps = [];
        for (var i = 0; i < t.length; i++) {
            if (!isNum(q[i]) || !isNum(t[i])) continue;
            var last = steps[steps.length - 1];
            if (last) {
                var ref = Math.max(Math.abs(last.q), Math.abs(q[i]));
                if (ref === 0 || Math.abs(q[i] - last.q) <= 0.01 * ref) continue;
            }
            steps.push({ t0: steps.length ? t[i] : Math.min(0, t[i]), q: q[i], idx: i });
        }
        return steps;
    }

    function _interp(t, p, tx) {
        for (var i = 1; i < t.length; i++) {
            if (t[i] >= tx) {
                var f = (tx - t[i - 1]) / ((t[i] - t[i - 1]) || 1);
                return p[i - 1] + f * (p[i] - p[i - 1]);
            }
        }
        return p[p.length - 1];
    }

    // Local analysis-data builder used only when PRiSM_getAnalysisData (C2) is
    // absent. Handles single drawdown / injection, and a single build-up or
    // fall-off following one or more flow steps in the q column.
    function localAnalysisData(ds, well, opts) {
        opts = opts || {};
        well = well || {};
        var out = { ok: false, reason: '', warnings: [], source: 'local' };
        if (!ds || !ds.t || !ds.p) { out.reason = 'No data loaded'; return out; }
        var T = toArr(ds.t), P = toArr(ds.p), Q = toArr(ds.q);
        var t = [], p = [], q = [];
        for (var i = 0; i < T.length; i++) {
            if (isNum(T[i]) && isNum(P[i])) { t.push(T[i]); p.push(P[i]); q.push(isNum(Q[i]) ? Q[i] : NaN); }
        }
        if (t.length < 3) { out.reason = 'Need at least 3 data points'; return out; }
        var hasQ = q.some(isNum);
        var steps = hasQ ? _stepsFromRates(t, q) : [];
        var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
        var tShut = isNum(well.tShut) ? well.tShut : null;
        var shutIdx = -1;
        // Detect a shut-in: first zero-rate sample after a flowing sample.
        if (hasQ) {
            for (var k = 1; k < q.length; k++) {
                if (q[k] === 0 && isNum(q[k - 1]) && q[k - 1] !== 0) { shutIdx = k; break; }
            }
        }
        if (!testType) {
            if (shutIdx > 0) testType = (q[shutIdx - 1] < 0) ? 'falloff' : 'buildup';
            else if (hasQ && q.every(function (v) { return !isNum(v) || v <= 0; }) && q.some(function (v) { return v < 0; })) testType = 'injection';
            else testType = (p[p.length - 1] - p[0]) >= 0 ? 'buildup' : 'drawdown';   // CLAUDE.md sign rule
        }
        var isShut = (testType === 'buildup' || testType === 'falloff');
        out.testType = testType;
        out.fluid = well.fluid || 'oil';

        if (!isShut) {
            var pRef = null, src = null;
            if (isNum(well.pi)) { pRef = well.pi; src = 'pi'; }
            else {
                for (var r = 0; r < t.length; r++) if (t[r] <= 0) { pRef = p[r]; src = 't0-row'; }
                if (pRef == null) { pRef = p[0]; src = 'first-sample'; }
            }
            var sgn = (testType === 'injection') ? 1 : -1;       // Δp = sgn·(p − pRef)
            out.t = []; out.tAbs = []; out.p = []; out.dp = [];
            for (var a = 0; a < t.length; a++) {
                if (!(t[a] > 0)) continue;
                out.t.push(t[a]); out.tAbs.push(t[a]); out.p.push(p[a]); out.dp.push(sgn * (p[a] - pRef));
            }
            out.pRef = pRef; out.pRefSource = src; out.sign = sgn;
            out.tStart = 0; out.tShut = null; out.tp = null;
            out.qRef = firstNum(_lastNonZero(q), well.q);
            var flowSteps = steps.filter(function (s) { return s.q !== 0; });
            out.rateHistory = flowSteps.map(function (s) { return { t: s.t0, q: s.q }; });
            if (flowSteps.length > 1) {
                out.tStart = flowSteps[flowSteps.length - 1].t0;
                out.qRef = flowSteps[flowSteps.length - 1].q;
            }
            if (src === 'first-sample') out.warnings.push('Initial pressure pi not set: Δp is measured from the first sample, so skin is biased.');
        } else {
            var ts = tShut;
            if (ts == null && shutIdx > 0) ts = t[shutIdx - 1];
            var pw = isNum(well.pwf0) ? well.pwf0 : null, pwSrc = 'pwf0';
            if (ts == null) {
                // No rate information: treat t as Δt measured from shut-in.
                ts = 0;
                if (pw == null) {
                    var z = -1;
                    for (var zz = 0; zz < t.length; zz++) if (t[zz] <= 0) z = zz;
                    if (z >= 0) { pw = p[z]; pwSrc = 't0-row'; }
                    else { pw = p[0]; pwSrc = 'first-sample'; out.warnings.push('Shut-in pressure pwf(Δt=0) not set: the first sample is used, so skin is biased.'); }
                }
            } else if (pw == null) { pw = _interp(t, p, ts); pwSrc = 'interp-tShut'; }
            var sg2 = (testType === 'buildup') ? 1 : -1;
            out.t = []; out.tAbs = []; out.p = []; out.dp = [];
            for (var b = 0; b < t.length; b++) {
                var dtb = t[b] - ts;
                if (!(dtb > 0)) continue;
                out.t.push(dtb); out.tAbs.push(t[b]); out.p.push(p[b]); out.dp.push(sg2 * (p[b] - pw));
            }
            out.pRef = pw; out.pRefSource = pwSrc; out.sign = sg2;
            out.tShut = ts; out.tStart = ts;
            // Rate history before shut-in (steps with t0 < tShut).
            var prior = steps.filter(function (s) { return s.t0 < ts - 1e-12; });
            var qLast = prior.length ? prior[prior.length - 1].q : null;
            out.qRef = firstNum(qLast, well.q);
            var tp = isNum(well.tp) ? well.tp : null;
            if (tp == null && prior.length && isNum(qLast) && qLast !== 0) {
                // tp = Np / q_last  (Horner-equivalent producing time)
                var Np = 0;
                for (var s = 0; s < prior.length; s++) {
                    var tEnd = (s + 1 < prior.length) ? prior[s + 1].t0 : ts;
                    Np += prior[s].q * (tEnd - prior[s].t0);
                }
                tp = Np / qLast;
            }
            out.tp = tp;
            out.rateHistory = prior.map(function (s) { return { t: s.t0, q: s.q }; }).concat([{ t: ts, q: 0 }]);
        }
        out.n = out.t.length;
        out.ok = out.n >= 3;
        if (!out.ok) out.reason = 'Fewer than 3 points after the analysis start';
        out.timeFn = 'dt';
        out.L = isNum(opts.L) ? opts.L : 0.1;
        return out;
    }

    function getAnalysisData(ds, well, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_getAnalysisData === 'function' && !opts.forceLocal) {
            try {
                var st = G.PRiSM_state || {};
                var o = { period: st.activePeriod, timeFn: 'auto' };
                if (isNum(opts.tmin)) o.tmin = opts.tmin;
                if (isNum(opts.tmax)) o.tmax = opts.tmax;
                var a = G.PRiSM_getAnalysisData(ds, o);
                if (a && a.ok) return a;
                if (a && !a.ok) return a;
            } catch (e) { /* fall through */ }
        }
        return localAnalysisData(ds, well, opts);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — RATE STEPS FOR THE ANALYSED PERIOD
    // ═══════════════════════════════════════════════════════════════
    // Returns { steps:[{T, q}], n } in PRODUCTION sign convention where the
    // last step is the analysed period (T = its start, absolute hours).

    function _steps(adata, method, testType) {
        var qRef = firstNum(adata.qRef);
        var tp = firstNum(adata.tp);
        var isShut = (testType === 'buildup' || testType === 'falloff');
        var inj = (testType === 'injection' || testType === 'falloff');
        var qSign = inj ? -1 : 1;              // injection rates → negative production
        var qAbs = isNum(qRef) ? Math.abs(qRef) : null;
        if (method === 'mdh') {
            return [{ T: 0, q: qSign * (qAbs || 1) }];
        }
        if (method === 'horner' || method === 'agarwal') {
            if (!isNum(tp) || tp <= 0) return null;
            return [{ T: 0, q: qSign * (qAbs || 1) }, { T: tp, q: 0 }];
        }
        // superposition — build from periods / rateHistory
        var raw = [];
        var per = toArr(adata.periods);
        // periods carry explicit start times (t0, hours); start/end may be
        // row indices, so they are not used as times.
        if (per.length && per.every(function (x) { return x && isNum(x.t0) && isNum(x.q); })) {
            per.forEach(function (x) { raw.push({ T: x.t0, q: x.q }); });
        } else {
            toArr(adata.rateHistory).forEach(function (x) {
                if (x && isNum(x.t) && isNum(x.q)) raw.push({ T: x.t, q: x.q });
            });
        }
        raw.sort(function (a, b) { return a.T - b.T; });
        var tStart = firstNum(adata.tStart, adata.tShut, 0);
        var steps = [];
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].T > tStart + 1e-9) break;
            var last = steps[steps.length - 1];
            if (last && Math.abs(last.q - raw[i].q) <= 0.01 * Math.max(Math.abs(last.q), Math.abs(raw[i].q))) continue;
            steps.push({ T: raw[i].T, q: raw[i].q });
        }
        // Leading zero-rate steps carry no information (q_0 = 0 already).
        while (steps.length && steps[0].q === 0) steps.shift();
        if (!steps.length) return null;
        if (Math.abs(steps[steps.length - 1].T - tStart) > 1e-6) {
            // The analysed period did not appear as its own step: add it.
            var qn = isShut ? 0 : (isNum(qRef) ? qRef : steps[steps.length - 1].q);
            steps.push({ T: tStart, q: qn });
        }
        // Injection sign: if all flowing rates are positive but the test is an
        // injection / fall-off, flip them to the production convention.
        if (inj && steps.every(function (s) { return s.q >= 0; })) {
            steps = steps.map(function (s) { return { T: s.T, q: -s.q }; });
        }
        return steps;
    }

    // Superposition X for Δt (hours) and W constant (see header).
    function supX(steps, dt) {
        var n = steps.length, Tn = steps[n - 1].T;
        var dqn = steps[n - 1].q - (n > 1 ? steps[n - 2].q : 0);
        if (dqn === 0) return NaN;
        var x = 0;
        for (var i = 0; i < n; i++) {
            var dq = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            var arg = Tn - steps[i].T + dt;
            if (!(arg > 0)) return NaN;
            x += dq / dqn * Math.log10(arg);
        }
        return x;
    }
    function supW(steps) {
        var n = steps.length, Tn = steps[n - 1].T;
        var dqn = steps[n - 1].q - (n > 1 ? steps[n - 2].q : 0);
        var w = 0;
        for (var i = 0; i < n - 1; i++) {
            var dq = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            w += dq / dqn * Math.log10(Tn - steps[i].T);
        }
        return w;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — IARF WINDOW
    // ═══════════════════════════════════════════════════════════════
    // Longest contiguous run (in log cycles of x) where |d ln Δp′/d ln x| < 0.1
    // and every Δp′ is within ±10 % of the run median; ≥ 5 points and
    // ≥ 0.5 log cycle. Returns {found, i0, i1} (indices into the arrays).

    function findIARFWindow(x, deriv, o) {
        o = o || {};
        var slopeTol = isNum(o.slopeTol) ? o.slopeTol : 0.1;
        var bandTol = isNum(o.bandTol) ? o.bandTol : 0.10;
        var minPts = o.minPts || 5, minCycles = isNum(o.minCycles) ? o.minCycles : 0.5;
        var n = x.length;
        var sl = localLogSlope(x, deriv, isNum(o.halfWindow) ? o.halfWindow : 0.35);
        var okp = new Array(n);
        for (var i = 0; i < n; i++) okp[i] = x[i] > 0 && deriv[i] > 0 && isNum(sl[i]) && Math.abs(sl[i]) < slopeTol;
        var best = null;
        var a = 0;
        while (a < n) {
            if (!okp[a]) { a++; continue; }
            var b = a;
            while (b + 1 < n && okp[b + 1]) b++;
            // Two-pointer band search within [a, b].
            var sorted = [], l = a;
            for (var r = a; r <= b; r++) {
                _sortedInsert(sorted, deriv[r]);
                while (sorted.length) {
                    var med = _sortedMedian(sorted);
                    if (sorted[0] >= (1 - bandTol) * med && sorted[sorted.length - 1] <= (1 + bandTol) * med) break;
                    _sortedRemove(sorted, deriv[l]); l++;
                }
                var cnt = r - l + 1;
                var cyc = Math.log10(x[r] / x[l]);
                if (cnt >= minPts && cyc >= minCycles - 1e-12) {
                    if (!best || cyc > best.cycles + 1e-12) best = { i0: l, i1: r, cycles: cyc, n: cnt };
                }
            }
            a = b + 1;
        }
        if (!best) return { found: false };
        best.found = true;
        // Refinement. The tail of the storage / skin hump decays slowly (≈ 1/t)
        // and stays inside the ±10 % band for a log cycle or more, which biases
        // m high and S low. The plateau is the median of the later half of the
        // run (in log time). The start moves past the last point in the early
        // half that still sits on the hump side of the plateau by more than
        // max(0.5 %, 1.5 × the plateau scatter). The end drops trailing points
        // more than 3 % off the plateau (end effects, boundary onset). The
        // window always keeps ≥ minPts points and ≥ minCycles log cycles.
        if (o.refine !== false) {
            var lxa = Math.log(x[best.i0]), lxb = Math.log(x[best.i1]), lmid = 0.5 * (lxa + lxb);
            var late = [], early = [], k2, midIdx = best.i0;
            for (k2 = best.i0; k2 <= best.i1; k2++) {
                if (Math.log(x[k2]) >= lmid) late.push(deriv[k2]); else { early.push(deriv[k2]); midIdx = k2; }
            }
            var plateau = median(late.length >= 3 ? late : deriv.slice(best.i0, best.i1 + 1));
            var dev = late.map(function (v) { return v / plateau - 1; });
            var mdev = median(dev);
            var noise = 1.4826 * median(dev.map(function (v) { return Math.abs(v - mdev); }));
            var tolS = Math.min(0.03, Math.max(isNum(o.startTol) ? o.startTol : 0.005, 1.5 * (isNum(noise) ? noise : 0)));
            var eMed = median(early.slice(0, Math.max(1, Math.ceil(early.length / 2))));
            var eSign = isNum(eMed) ? (eMed >= plateau ? 1 : -1) : 1;
            var i0 = best.i0, i1 = best.i1;
            var canKeep = function (n0, n1) { return n1 - n0 + 1 >= minPts && Math.log10(x[n1] / x[n0]) >= minCycles - 1e-12; };
            var newStart = i0;
            for (k2 = best.i0; k2 <= midIdx; k2++) if (eSign * (deriv[k2] / plateau - 1) > tolS) newStart = k2 + 1;
            while (newStart > i0 && !canKeep(newStart, i1)) newStart--;
            i0 = newStart;
            while (Math.abs(deriv[i1] / plateau - 1) > 0.03 && canKeep(i0, i1 - 1)) i1--;
            best.trimmed = (i0 !== best.i0 || i1 !== best.i1);
            best.run = { i0: best.i0, i1: best.i1 };
            best.i0 = i0; best.i1 = i1; best.n = i1 - i0 + 1;
            best.cycles = Math.log10(x[i1] / x[i0]);
            best.plateau = plateau; best.startTol = tolS;
        }
        return best;
    }
    function _sortedInsert(arr, v) {
        var lo = 0, hi = arr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
        arr.splice(lo, 0, v);
    }
    function _sortedRemove(arr, v) {
        var lo = 0, hi = arr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
        if (lo < arr.length && arr[lo] === v) arr.splice(lo, 1);
    }
    function _sortedMedian(arr) {
        var m = arr.length >> 1;
        return (arr.length % 2) ? arr[m] : 0.5 * (arr[m - 1] + arr[m]);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — SKIN SUMMARY / DECOMPOSITION / RATE-DEPENDENT SKIN
    // ═══════════════════════════════════════════════════════════════

    function skinSummary(o) {
        o = o || {};
        var r = { ok: false, warnings: [] };
        var S = firstNum(o.S), kh = firstNum(o.kh), m = firstNum(o.m);
        var q = firstNum(o.q), B = firstNum(o.B), mu = firstNum(o.mu);
        if (!isNum(S)) { r.warnings.push('Skin not available'); return r; }
        q = isNum(q) ? Math.abs(q) : q;
        var dpS = NaN;
        if (pos(kh) && pos(q) && pos(B) && pos(mu)) dpS = 141.2 * q * B * mu * S / kh;
        else if (pos(Math.abs(m || 0))) dpS = 0.8686 * Math.abs(m) * S;
        r.dpS = dpS;
        if (isNum(o.rw) && o.rw > 0) r.rwEff = o.rw * Math.exp(-S);
        if (pos(o.CD)) r.CDe2S = o.CD * Math.exp(2 * S);
        var pbar = firstNum(o.pbar), pwf = firstNum(o.pwf);
        if (isNum(pbar) && isNum(pwf)) {
            var dd = Math.abs(pbar - pwf);
            if (dd > 0) {
                r.drawdown = dd;
                if (isNum(dpS)) {
                    r.FE = (dd - dpS) / dd;
                    r.DR = r.FE !== 0 ? 1 / r.FE : NaN;
                }
                if (pos(q)) {
                    r.J = q / dd;
                    if (isNum(dpS) && dd - dpS > 0) r.J_ideal = q / (dd - dpS);
                }
            }
        } else r.warnings.push('Average / initial pressure or flowing pressure unknown: FE, DR and J not computed');
        r.ok = isNum(dpS);
        return r;
    }

    // Local pseudo-skin fallbacks (used when window.PRiSM_pseudoSkin is absent).
    function _bronsMarting(b, hD) {
        if (!(b > 0) || b > 1 || !(hD > 0)) return 0;
        if (b >= 1) return 0;
        var Gb = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
        return (1 / b - 1) * (Math.log(hD) - Gb);
    }
    function _cincoLey(thetaDeg, kvkh, hD) {
        if (!isNum(thetaDeg) || thetaDeg === 0) return 0;
        var an = isNum(kvkh) && kvkh > 0 ? Math.sqrt(kvkh) : 1;
        var thp = Math.atan(an * Math.tan(thetaDeg * Math.PI / 180)) * 180 / Math.PI;
        var hd = hD > 0 ? hD : 100;
        return -Math.pow(thp / 41, 2.06) - Math.pow(thp / 56, 1.865) * Math.log10(hd / 100);
    }
    function _fracSkin(xf, rw) {
        if (!(xf > 0) || !(rw > 0)) return 0;
        return -Math.log(xf / (2 * rw));     // infinite-conductivity: rw′ = xf/2
    }

    function skinDecomposition(o) {
        o = o || {};
        var params = o.params || {};
        var geom = o.geom || {};
        var lib = G.PRiSM_pseudoSkin || {};
        var S_total = firstNum(o.S_total);
        var h = firstNum(geom.h), rw = firstNum(geom.rw);
        var kvkh = firstNum(geom.kvkh, params.KvKh, params.kvkh, 1);
        var b = null;
        if (pos(geom.hp) && pos(h)) b = geom.hp / h;
        if (b == null) b = firstNum(geom.b, params.hp_to_h, params.b);
        var theta = firstNum(geom.theta, params.theta_deg, params.theta);
        var xf = firstNum(geom.xf, params.xf);
        var hD = (pos(h) && pos(rw)) ? (h / rw) * Math.sqrt(1 / (kvkh > 0 ? kvkh : 1)) : firstNum(params.__h_rw ? params.__h_rw / Math.sqrt(kvkh || 1) : null, 100);
        var r = { S_total: S_total, S_pp: 0, S_theta: 0, S_f: 0, Dq: 0, S_model: 0, warnings: [], used: [] };
        if (isNum(b) && b > 0 && b < 1) {
            var spp = NaN;
            if (typeof lib.bronsMarting === 'function') { try { spp = lib.bronsMarting(b, hD); } catch (e) { spp = NaN; } }
            if (!isNum(spp)) spp = _bronsMarting(b, hD);
            r.S_pp = spp; r.used.push('partial penetration (Brons-Marting)');
        }
        if (isNum(theta) && theta !== 0) {
            var sth = NaN;
            if (typeof lib.cincoLey === 'function') { try { sth = lib.cincoLey(theta, kvkh, hD); } catch (e) { sth = NaN; } }
            if (!isNum(sth)) sth = _cincoLey(theta, kvkh, hD);
            r.S_theta = sth; r.used.push('well deviation (Cinco-Ley)');
        }
        if (pos(xf) && pos(rw)) {
            var sf = NaN;
            if (typeof lib.fracture === 'function') { try { sf = lib.fracture(xf, rw, 'infinite'); } catch (e) { sf = NaN; } }
            if (!isNum(sf)) sf = _fracSkin(xf, rw);
            r.S_f = sf; r.used.push('hydraulic fracture (rw′ = xf/2)');
        }
        // A model-level pseudo-skin when no geometric inputs applied.
        if (!r.used.length && o.modelKey && G.PRiSM_MODELS && G.PRiSM_MODELS[o.modelKey] &&
            typeof G.PRiSM_MODELS[o.modelKey].pseudoSkin === 'function') {
            try {
                var sm = G.PRiSM_MODELS[o.modelKey].pseudoSkin(params, geom);
                if (isNum(sm)) { r.S_model = sm; r.used.push('model pseudo-skin'); }
            } catch (e) { /* ignore */ }
        }
        var D = firstNum(o.D), q = firstNum(o.q);
        if (isNum(D) && isNum(q)) r.Dq = D * Math.abs(q);
        r.S_pseudo = r.S_pp + r.S_theta + r.S_f + r.S_model;
        r.S_mech = isNum(S_total) ? S_total - r.S_pseudo - r.Dq : NaN;
        r.ok = isNum(r.S_mech);
        if (!isNum(S_total)) r.warnings.push('Total skin not available');
        return r;
    }

    // Least-squares S′ = S + D·q over [{q, S′}] rows.
    function rateDependentSkin(rows) {
        var xs = [], ys = [];
        toArr(rows).forEach(function (r) {
            if (!r) return;
            var q = firstNum(r.q), s = firstNum(r.S, r.Sp, r["S'"], r['S′'], r.Sprime, r.skin);
            if (isNum(q) && isNum(s)) { xs.push(Math.abs(q)); ys.push(s); }
        });
        if (xs.length < 2) return { ok: false, n: xs.length, reason: 'Need at least two flow periods with a skin value' };
        var f = linfit(xs, ys);
        if (!f.ok) return { ok: false, n: xs.length, reason: 'All rates are equal: D cannot be separated from S' };
        return { ok: true, S: f.a, D: f.b, r2: f.r2, n: f.n, units: 'D in 1/(STB/d) or 1/(Mscf/d)' };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — STRAIGHT-LINE ANALYSIS
    // ═══════════════════════════════════════════════════════════════

    var METHOD_LABEL = {
        mdh: 'MDH (Δp vs log Δt)',
        horner: 'Horner (p vs log (tp+Δt)/Δt)',
        superposition: 'Superposition time',
        agarwal: 'Agarwal equivalent time'
    };

    function semilogAnalysis(adata, well, opts) {
        opts = opts || {};
        var ds = G.PRiSM_dataset;
        if (!well) well = getWell(ds);
        if (!adata) adata = getAnalysisData(ds, well, opts);
        var res = { ok: false, source: 'semilog', warnings: [], timestamp: Date.now() };
        if (!adata || !adata.ok) { res.reason = (adata && adata.reason) || 'No analysis data'; return res; }
        (adata.warnings || []).forEach(function (w) { if (res.warnings.indexOf(w) === -1) res.warnings.push(w); });

        var testType = adata.testType || (well && well.testType) || 'drawdown';
        if (testType === 'auto') testType = 'drawdown';
        var isShut = (testType === 'buildup' || testType === 'falloff');
        var fluid = adata.fluid || well.fluid || 'oil';
        var pseudo = !!(adata.pseudo || opts.pseudo || adata.dpUnits === 'psi2/cp');

        // ── Data (Δt > 0, finite Δp) ─────────────────────────────
        var T = toArr(adata.t), PP = toArr(adata.p), DP = toArr(adata.dp);
        var t = [], p = [], y = [];
        for (var i = 0; i < T.length; i++) {
            if (!(T[i] > 0) || !isNum(DP[i])) continue;
            if (isNum(opts.tmin) && T[i] < opts.tmin) continue;
            if (isNum(opts.tmax) && T[i] > opts.tmax) continue;
            t.push(T[i]); y.push(DP[i]); p.push(isNum(PP[i]) ? PP[i] : NaN);
        }
        if (t.length < 3) { res.reason = 'Fewer than 3 points with Δt > 0'; return res; }
        // Pressure-space reference. With pseudo-pressure, C2 carries pRef in
        // Δm units and the pressure in pRefPressure; pressure-space results
        // (p1hr, p*, FE, J) are then not produced.
        var pRef = pseudo ? NaN : firstNum(adata.pRefPressure, adata.pRef);
        // p = pRef + dir·Δp  (dir from the data, robust to sign conventions)
        var dirAcc = 0;
        for (var d0 = 0; d0 < t.length; d0++) if (isNum(p[d0]) && isNum(pRef)) dirAcc += (p[d0] - pRef) * y[d0];
        var dir = dirAcc > 0 ? 1 : (dirAcc < 0 ? -1 : (isShut || testType === 'injection' ? 1 : -1));
        if (testType === 'falloff' && dirAcc === 0) dir = -1;

        // ── Method ────────────────────────────────────────────────
        var tp = firstNum(adata.tp, well.tp);
        if (isNum(tp) && tp <= 0) tp = null;
        var adTp = { qRef: firstNum(adata.qRef, well.q), tp: tp, periods: adata.periods, rateHistory: adata.rateHistory,
            tStart: adata.tStart, tShut: adata.tShut };
        var supSteps = _steps(adTp, 'superposition', testType);
        var nFlow = supSteps ? supSteps.filter(function (s) { return s.q !== 0; }).length : 0;
        var multi = !!(supSteps && (isShut ? nFlow > 1 : supSteps.length > 1));
        var method = opts.method && opts.method !== 'auto' ? opts.method : null;
        if (!method) {
            if (!isShut) method = multi ? 'superposition' : 'mdh';
            else if (multi) method = 'superposition';
            else if (isNum(tp)) method = 'horner';
            else method = 'mdh';
        }
        var steps = (method === 'superposition') ? supSteps : _steps(adTp, method, testType);
        if (!steps) {
            if (method === 'horner' || method === 'agarwal') res.warnings.push('Producing time tp unknown: MDH on Δt used instead (valid only for Δt much shorter than tp).');
            else if (method === 'superposition') res.warnings.push('Rate history unavailable: MDH on Δt used instead.');
            method = 'mdh';
            steps = _steps(adTp, 'mdh', testType);
        }
        if (isShut && method === 'mdh' && !opts.method) {
            res.warnings.push('Build-up analysed with MDH on Δt: set tp for a Horner analysis.');
        }
        var nS = steps.length;
        var qn = steps[nS - 1].q, dqn = qn - (nS > 1 ? steps[nS - 2].q : 0);
        var qAnal = Math.abs(dqn);
        var qProvided = isNum(firstNum(adata.qRef, well.q));
        // Δp measured from pi (C2 dRef 'pi', or pRefSource 'pi') or from the
        // pressure at the start of the analysed period.
        var fromPi = adata.dRef ? adata.dRef === 'pi' : adata.pRefSource === 'pi';
        var refMode = (fromPi && nS >= 2 && qn !== 0) ? 'pi' : 'start';
        var W = refMode === 'start' ? supW(steps) : 0;

        // ── Time function + derivative ───────────────────────────
        var X = new Array(t.length), xw = new Array(t.length);
        for (var j = 0; j < t.length; j++) { X[j] = supX(steps, t[j]); xw[j] = Math.pow(10, X[j]); }
        // Derivative smoothing for window picking and the plateau check (ln units).
        var L = isNum(opts.L) ? opts.L : 0.3;
        var deriv = bourdet(xw, y, L);

        // ── Window ────────────────────────────────────────────────
        var i0 = -1, i1 = -1, winAuto = true, winFound = false;
        var mw = opts.window;
        if (mw && (isNum(firstNum(mw.t0)) || isNum(firstNum(mw.t1)))) {
            var w0 = firstNum(mw.t0, -Infinity), w1 = firstNum(mw.t1, Infinity);
            for (var k = 0; k < t.length; k++) {
                if (t[k] >= w0 && t[k] <= w1) { if (i0 < 0) i0 = k; i1 = k; }
            }
            winAuto = false; winFound = true;
            if (i0 < 0 || i1 - i0 + 1 < 2) {
                res.warnings.push('Manual window contains fewer than 2 points: automatic window used.');
                i0 = -1; winAuto = true;
            }
        }
        if (i0 < 0) {
            var fw = findIARFWindow(xw, deriv, opts.windowOpts);
            if (fw.found) { i0 = fw.i0; i1 = fw.i1; winFound = true; }
            else {
                var tEnd = t[t.length - 1];
                i1 = t.length - 1; i0 = i1;
                while (i0 > 0 && t[i0 - 1] >= tEnd / 10) i0--;
                if (i1 - i0 + 1 < 3) i0 = Math.max(0, i1 - 2);
                winFound = false;
                res.warnings.push('No clear radial-flow (IARF) plateau in the derivative: the last log cycle was used, so results are indicative only.');
            }
        }

        // ── Straight line ─────────────────────────────────────────
        var xsW = X.slice(i0, i1 + 1), ysW = y.slice(i0, i1 + 1);
        var f = linfit(xsW, ysW);
        if (!f.ok) { res.reason = 'Straight-line fit failed (window has no spread in time)'; return res; }
        var a = f.a, s = f.b, mAbs = Math.abs(s);
        if (!(mAbs > 0)) { res.reason = 'Zero semilog slope'; return res; }
        if (s < 0) res.warnings.push('Δp decreases with time in the chosen window: check the test type and the window.');

        // ── kh, k ─────────────────────────────────────────────────
        var B = firstNum(well.B), mu = firstNum(well.mu), h = firstNum(well.h), phi = firstNum(well.phi);
        var ct = firstNum(well.ct), rw = firstNum(well.rw);
        var TR = firstNum(well.T_R, isNum(well.T_res) ? well.T_res + 459.67 : null);
        var kh = NaN, khLL = NaN;
        var qU = qProvided ? qAnal : NaN;
        var missing = [];
        if (!qProvided) missing.push('q');
        if (fluid === 'gas' && pseudo) {
            if (pos(TR) && pos(qU)) kh = 1637 * qU * TR / mAbs; else if (!pos(TR)) missing.push('T');
            if (!pos(mu)) missing.push('mu');
        } else {
            if (!pos(B)) missing.push('B');
            if (!pos(mu)) missing.push('mu');
            if (pos(qU) && pos(B) && pos(mu)) kh = 162.6 * qU * B * mu / mAbs;
        }
        if (!pos(h)) missing.push('h');
        var k = (isNum(kh) && pos(h)) ? kh / h : NaN;
        var diffusGroup = (pos(phi) && pos(mu) && pos(ct) && pos(rw)) ? phi * mu * ct * rw * rw : NaN;
        ['phi', 'ct', 'rw'].forEach(function (key) { if (!pos(well[key])) missing.push(key); });

        // ── Skin, p1hr, p* ────────────────────────────────────────
        var K = refMode === 'pi' ? a * dqn / (s * qn) : a / s + W;
        var S = (isNum(k) && isNum(diffusGroup)) ? 1.1513 * (K - Math.log10(k / diffusGroup) + 3.2275) : NaN;
        var X1 = supX(steps, 1);
        var Y1 = a + s * X1;
        var p1hr = isNum(pRef) ? pRef + dir * Y1 : NaN;
        var pStar = (qn === 0 && isNum(pRef)) ? pRef + dir * a : NaN;
        // Gas with pseudo-pressure: the line lives in m(p). m1hr = m_ref ± Δm(1 h)
        // and m* = m_ref ± a are converted back to pressure with the same m(p)
        // table (Al-Hussainy, Ramey & Crawford 1966; Lee, Rollins & Spivey 2003,
        // SPE Textbook 9, §3 gas-well build-up: p* from m* by inverting m(p)).
        var mTbl = null, yRef0 = firstNum(adata.pRef);
        if (pseudo && fluid === 'gas' && adata.mpSpec && typeof G.PRiSM_mpTable === 'function') {
            try { mTbl = G.PRiSM_mpTable(adata.mpSpec); } catch (eT) { mTbl = null; }
        }
        var pRefP = pseudo ? firstNum(adata.pRefPressure) : pRef;
        if (mTbl && isNum(yRef0)) {
            p1hr = mTbl.pOf(yRef0 + dir * Y1);
            if (qn === 0) pStar = mTbl.pOf(yRef0 + dir * a);
        }

        // ── Log-log cross-check ──────────────────────────────────
        var dW = deriv.slice(i0, i1 + 1);
        var dpr = median(dW);
        var cross = { dpPrime_r: dpr };
        if (dpr > 0) {
            if (fluid === 'gas' && pseudo) { if (pos(TR) && pos(qU)) khLL = 711 * qU * TR / dpr; }
            else if (pos(qU) && pos(B) && pos(mu)) khLL = 70.6 * qU * B * mu / dpr;
            cross.kh_ll = khLL;
            cross.k_ll = (isNum(khLL) && pos(h)) ? khLL / h : NaN;
            if (isNum(cross.k_ll) && isNum(diffusGroup)) {
                var sll = [], sLL = s >= 0 ? LN10 * dpr : -LN10 * dpr;
                for (var c = i0; c <= i1; c++) {
                    var Kc = refMode === 'pi' ? (y[c] - sLL * X[c]) * dqn / (sLL * qn) : y[c] / sLL - X[c] + W;
                    sll.push(1.1513 * (Kc - Math.log10(cross.k_ll / diffusGroup) + 3.2275));
                }
                cross.S_ll = median(sll);
            }
            if (isNum(kh) && isNum(khLL)) cross.khDiffPct = Math.abs(kh - khLL) / khLL * 100;
            if (isNum(S) && isNum(cross.S_ll)) cross.dS = Math.abs(S - cross.S_ll);
            cross.pass = (isNum(cross.khDiffPct) ? cross.khDiffPct <= 5 : true) && (isNum(cross.dS) ? cross.dS <= 0.3 : true) &&
                (isNum(cross.khDiffPct) || isNum(cross.dS));
            if (cross.pass === false) {
                res.warnings.push('Straight-line and derivative-plateau results disagree (kh ' +
                    (isNum(cross.khDiffPct) ? cross.khDiffPct.toFixed(1) + ' %' : '—') + ', ΔS ' +
                    (isNum(cross.dS) ? cross.dS.toFixed(2) : '—') + '): the window may not be in radial flow.');
            }
        }

        // ── Unit slope (wellbore storage) ────────────────────────
        var us = { found: false };
        var lsl = localLogSlope(t, y, 0.2);
        var run = [];
        for (var u = 0; u < t.length; u++) {
            if (isNum(lsl[u]) && Math.abs(lsl[u] - 1) <= 0.1) run.push(u);
            else if (run.length) break;
            else if (u >= 2) break;         // storage must be at the start of the period
        }
        if (run.length >= 3 && pos(qU) && pos(B)) {
            // Gas m(p): storage needs the real pressure change, not Δm.
            var cs = run.map(function (ix) {
                var dpu = (pseudo && isNum(pRefP) && isNum(p[ix])) ? Math.abs(p[ix] - pRefP) : y[ix];
                return qU * B * t[ix] / (24 * dpu);
            });
            us = { found: true, n: run.length, t0: t[run[0]], t1: t[run[run.length - 1]], C: median(cs) };
            if (pos(phi) && pos(ct) && pos(h) && pos(rw)) us.CD = 0.8936 * us.C / (phi * ct * h * rw * rw);
        } else {
            res.warnings.push('No unit-slope (wellbore storage) points at early time: data starts after storage, so C is not determined from the data.');
        }
        var tIARF = NaN;
        if (us.found && isNum(S) && isNum(kh) && pos(mu)) {
            tIARF = (200000 + 12000 * S) * us.C * mu / kh;
            if (isNum(tIARF) && t[i0] < 0.5 * tIARF) res.warnings.push('The straight-line window starts before the end of storage effects (≈ ' + tIARF.toPrecision(3) + ' h).');
        }

        // ── rinv at the end of the period ────────────────────────
        var tEndA = t[t.length - 1];
        var rinv = (isNum(k) && pos(phi) && pos(mu) && pos(ct)) ? Math.sqrt(k * tEndA / (948 * phi * mu * ct)) : NaN;

        // ── Skin deliverables ─────────────────────────────────────
        var pbar = null, pwf = null;
        if (isShut) { pbar = isNum(pStar) ? pStar : null; pwf = pRefP; }
        else {
            pbar = pRefP;
            var lastP = null;
            for (var lp = p.length - 1; lp >= 0; lp--) if (isNum(p[lp])) { lastP = p[lp]; break; }
            pwf = isNum(lastP) ? lastP : (isNum(pRef) ? pRef + dir * y[y.length - 1] : null);
        }
        var summary;
        if (fluid === 'gas' && pseudo) {
            // Δm_S = 0.8686·|m|·S in m(p) units, converted to a pressure drop at pwf;
            // FE from m(p) drawdowns (52-prism-gas.js PRiSM_gasSkinSummary).
            summary = (typeof G.PRiSM_gasSkinSummary === 'function' && mTbl)
                ? G.PRiSM_gasSkinSummary({ S: S, m: mAbs, rw: rw, CD: us.CD, pbar: pbar, pwf: pwf, table: mTbl })
                : skinSummary({ S: S, m: mAbs, rw: rw, CD: us.CD });
            if (!summary || !isNum(summary.dpS)) summary = skinSummary({ S: S, m: mAbs, rw: rw, CD: us.CD });
            res.warnings.push(summary && summary.gas
                ? 'Gas pseudo-pressure analysis: p1hr, p* and ΔpS are converted from m(p) back to pressure with the same m(p) table; FE uses m(p) drawdowns; J is not computed (use the deliverability panel for AOF).'
                : 'Gas pseudo-pressure analysis: ΔpS is in Δm(p) units; FE and J are not computed.');
        } else {
            summary = skinSummary({ S: S, kh: kh, m: mAbs, q: qU, B: B, mu: mu, rw: rw, pbar: pbar, pwf: pwf, CD: us.CD, testType: testType });
        }

        // ── Bias warnings (pRef) ─────────────────────────────────
        var src = adata.pRefSource;
        if (!isShut && (src === 'first-sample' || src === 'extrapolated')) {
            var msg = src === 'first-sample'
                ? 'Initial pressure pi not set: Δp is measured from the first sample, so skin is biased. Enter pi in Well & Test.'
                : 'Initial pressure pi extrapolated from the first points: skin may be biased. Enter pi in Well & Test.';
            if (!res.warnings.some(function (w) { return /biased/.test(w); })) res.warnings.push(msg);
        }
        if (isShut && src === 'first-sample' && !res.warnings.some(function (w) { return /biased/.test(w); })) {
            res.warnings.push('Shut-in pressure pwf(Δt=0) not known: the first sample is used, so skin is biased.');
        }
        if (missing.length) {
            var uniq = missing.filter(function (v, ix) { return missing.indexOf(v) === ix; });
            res.warnings.push('Missing inputs: ' + uniq.join(', ') + ' — enter them in Well & Test.');
            res.missing = uniq;
        }

        // ── Line objects in display coordinates ──────────────────
        var line;
        if (method === 'horner') {
            // p = b + m·log10((tp+Δt)/Δt), log10 ratio = −X
            line = { kind: 'horner', m: -dir * s, b: pRef + dir * a, x0: (tp + t[i0]) / t[i0], x1: (tp + t[i1]) / t[i1] };
        } else if (method === 'agarwal') {
            var ltp = Math.log10(tp);
            line = { kind: 'agarwal', m: dir * s, b: pRef + dir * (a - s * ltp), t0: tp * t[i0] / (tp + t[i0]), t1: tp * t[i1] / (tp + t[i1]) };
        } else if (method === 'superposition') {
            line = { kind: 'superposition', m: dir * s, b: pRef + dir * a, x0: X[i0], x1: X[i1] };
        } else {
            line = { kind: 'mdh', m: dir * s, b: pRef + dir * a, t0: t[i0], t1: t[i1] };
        }

        res.ok = true;
        res.method = method;
        res.methodLabel = METHOD_LABEL[method];
        res.testType = testType;
        res.fluid = fluid;
        res.pseudo = pseudo;
        res.n = t.length;
        res.window = { t0: t[i0], t1: t[i1], i0: i0, i1: i1, n: i1 - i0 + 1, auto: winAuto, found: winFound,
            cycles: Math.log10(xw[i1] / xw[i0]) };
        res.m = mAbs;
        res.slope = line.m;
        res.intercept = line.b;
        res.line = line;
        res.r2 = f.r2;
        res.kh = kh; res.k = k;
        res.p1hr = p1hr; res.pStar = pStar; res.S = S;
        res.dpS = summary.dpS; res.FE = summary.FE; res.DR = summary.DR; res.J = summary.J; res.J_ideal = summary.J_ideal;
        res.rwEff = summary.rwEff; res.CDe2S = summary.CDe2S;
        res.rinv = rinv; res.tEnd = tEndA;
        res.C = us.found ? us.C : NaN; res.CD = us.found && isNum(us.CD) ? us.CD : NaN;
        res.unitSlope = us; res.tIARF = tIARF;
        res.crossCheck = cross;
        res.pRef = pRef; res.yRef = firstNum(adata.pRef); res.pRefSource = src || null; res.pbar = pbar; res.pwf = pwf;
        if (pseudo) {
            res.dm1hr = Y1; res.dmStar = (qn === 0) ? a : NaN;
            res.pRefPressure = pRefP; res.gasConverted = !!mTbl;
            res.dmS = summary.dmS; res.m1hr = isNum(yRef0) ? yRef0 + dir * Y1 : NaN;
            res.mStar = (qn === 0 && isNum(yRef0)) ? yRef0 + dir * a : NaN;
        }
        res.tp = tp; res.qRef = qU; res.dq = dqn; res.steps = steps; res.refMode = refMode;
        res.inputs = { q: qU, B: B, mu: mu, h: h, phi: phi, ct: ct, rw: rw, T_R: TR };
        res.datasetHash = dsHash(G.PRiSM_dataset);
        res.opts = { method: opts.method || 'auto', window: winAuto ? null : { t0: res.window.t0, t1: res.window.t1 } };
        res.plot = { t: t, y: y, X: X, deriv: deriv };
        return res;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — STATE, EVENTS, SEED
    // ═══════════════════════════════════════════════════════════════

    var _busy = false;

    function _state() {
        if (!G.PRiSM_state) G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    function _fire(name, detail) {
        if (typeof G.dispatchEvent !== 'function' || typeof G.CustomEvent !== 'function') return;
        try { G.dispatchEvent(new G.CustomEvent(name, { detail: detail })); } catch (e) { /* ignore */ }
    }
    function _sig(r) {
        if (!r || !r.ok) return 'x';
        return [r.method, r.m, r.k, r.S, r.window && r.window.t0, r.window && r.window.t1].map(function (v) {
            return isNum(v) ? v.toPrecision(6) : String(v);
        }).join('|');
    }

    // Run the analysis on the current dataset and store it in st.semilog.
    // Dispatches prism:fit-updated {source:'semilog'} when the result changed
    // (or always when opts.notify === true). Never touches st.lastFit.
    function runAndStore(opts) {
        opts = opts || {};
        if (_busy) return _state().semilog || null;
        _busy = true;
        try {
            var st = _state();
            var prev = st.semilog;
            var o = {};
            for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
            var r = semilogAnalysis(o.adata || null, o.well || null, o);
            if (prev && prev.pinned && r.ok) r.pinned = true;
            // Keep the plotting arrays off the persisted object (they are big).
            if (r.plot) Object.defineProperty(r, 'plot', { value: r.plot, enumerable: false, writable: true, configurable: true });
            st.semilog = r;
            if (opts.notify === true || _sig(prev) !== _sig(r)) {
                _fire('prism:fit-updated', { source: 'semilog', semilog: r });
            }
            return r;
        } finally { _busy = false; }
    }

    function useAsSeed(r) {
        r = r || _state().semilog;
        if (!r || !r.ok) return false;
        var st = _state();
        st.phys = st.phys || {};
        if (isNum(r.k)) st.phys.k = r.k;
        if (isNum(r.kh)) st.phys.kh = r.kh;
        if (isNum(r.S)) st.phys.S = r.S;
        if (isNum(r.C)) st.phys.C = r.C;
        if (isNum(r.pStar)) st.phys.pStarSemilog = r.pStar;
        st.params = st.params || {};
        if (isNum(r.S) && Object.prototype.hasOwnProperty.call(st.params, 'S')) st.params.S = r.S;
        if (isNum(r.CD) && Object.prototype.hasOwnProperty.call(st.params, 'Cd')) st.params.Cd = r.CD;
        _fire('prism:model-changed', { source: 'semilog-seed', model: st.model, phys: st.phys });
        return true;
    }

    // Line object in C6 format for the plot layer (and our post-draw hook).
    //   mdh:    {m, b, t0, t1}  → p = b + m·log10(Δt)
    //   horner: {m, b, x0, x1, tp, pStar} → p = b + m·log10(R), R = (tp+Δt)/Δt
    //           (x0 / x1 are Horner-ratio values, not logs)
    function plotLine(plotKey) {
        var r = _state().semilog;
        if (!r || !r.ok || !r.line || !isNum(r.line.b) || !isNum(r.line.m)) return null;
        var L = r.line;
        if (plotKey === 'mdh' && L.kind === 'mdh') return { m: L.m, b: L.b, t0: L.t0, t1: L.t1 };
        if (plotKey === 'horner' && L.kind === 'horner') return { m: L.m, b: L.b, x0: L.x0, x1: L.x1, tp: r.tp, pStar: r.pStar };
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — POST-DRAW HOOK + MDH PLOT REGISTRATION
    // ═══════════════════════════════════════════════════════════════

    function _postDraw(info) {
        try {
            info = info || {};
            var canvas = info.canvas;
            var axes = info.axes || (canvas && canvas._prismAxes);
            var plotKey = info.plotKey || (axes && axes.plotKey);
            if (plotKey !== 'mdh' && plotKey !== 'horner') return;
            if (!canvas || !axes || typeof axes.toX !== 'function' || typeof axes.toY !== 'function') return;
            var line = plotLine(plotKey);
            if (!line) return;
            var ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) return;
            var pl = axes.plot || { x: 0, y: 0, w: canvas.width, h: canvas.height };
            var sx = axes.scaleX || {};
            var xa = isNum(sx.min) ? sx.min : null, xb = isNum(sx.max) ? sx.max : null;
            var w0 = plotKey === 'mdh' ? line.t0 : line.x0, w1 = plotKey === 'mdh' ? line.t1 : line.x1;
            if (xa == null || xb == null) { xa = Math.min(w0, w1); xb = Math.max(w0, w1); }
            var lo = Math.max(1e-12, Math.min(xa, xb)), hi = Math.max(xa, xb);
            function py(xv) { return line.b + line.m * Math.log10(xv); }
            ctx.save();
            ctx.beginPath(); ctx.rect(pl.x, pl.y, pl.w, pl.h); ctx.clip();
            var drawLine = !(info.data && info.data.line);
            if (drawLine) {
                ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.2;
                if (ctx.setLineDash) ctx.setLineDash([6, 4]);
                ctx.beginPath(); ctx.moveTo(axes.toX(lo), axes.toY(py(lo))); ctx.lineTo(axes.toX(hi), axes.toY(py(hi))); ctx.stroke();
                if (ctx.setLineDash) ctx.setLineDash([]);
                ctx.lineWidth = 2.2;
                ctx.beginPath(); ctx.moveTo(axes.toX(w0), axes.toY(py(w0))); ctx.lineTo(axes.toX(w1), axes.toY(py(w1))); ctx.stroke();
            }
            // Window markers
            ctx.strokeStyle = 'rgba(210,153,34,0.8)'; ctx.lineWidth = 1;
            if (ctx.setLineDash) ctx.setLineDash([3, 3]);
            [w0, w1].forEach(function (xv) {
                var px = axes.toX(xv);
                if (!isNum(px)) return;
                ctx.beginPath(); ctx.moveTo(px + 0.5, pl.y); ctx.lineTo(px + 0.5, pl.y + pl.h); ctx.stroke();
            });
            if (ctx.setLineDash) ctx.setLineDash([]);
            var r = _state().semilog;
            ctx.fillStyle = '#58a6ff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
            var label = 'm = ' + _fmt(r.m, 4) + ' psi/cycle' + (isNum(r.k) ? '  k = ' + _fmt(r.k, 3) + ' md' : '') +
                (isNum(r.S) ? '  S = ' + _fmt(r.S, 3) : '');
            ctx.fillText(label, pl.x + 8, pl.y + pl.h - 8);
            ctx.restore();
        } catch (e) { /* never break a plot */ }
    }
    _postDraw._prismId = 'semilog-line';

    // Fallback MDH renderer: delegates to the plot layer when it provides
    // window.PRiSM_plot_mdh, otherwise draws a minimal p vs log Δt plot using
    // the shared plot helpers when they are in scope.
    function plotMdhFallback(canvas, data, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_plot_mdh === 'function') return G.PRiSM_plot_mdh(canvas, data, opts);
        /* global PRiSM_plot_setup, PRiSM_plot_axes, PRiSM_plot_dots, PRiSM_plot_line, PRiSM_plot_empty, PRiSM_plot_range, PRiSM_plot_zip, PRiSM_THEME */
        if (typeof PRiSM_plot_setup !== 'function' || typeof PRiSM_plot_axes !== 'function') return;
        var setup = PRiSM_plot_setup(canvas, opts);
        var ctx = setup.ctx, plot = setup.plot;
        var tt = [], pp = [];
        var src = (data && data.t && data.p) ? data : null;
        if (src) {
            var T = toArr(src.t), P = toArr(src.p);
            for (var j = 0; j < T.length; j++) if (T[j] > 0 && isNum(P[j])) { tt.push(T[j]); pp.push(P[j]); }
        }
        if (!tt.length) { if (typeof PRiSM_plot_empty === 'function') PRiSM_plot_empty(ctx, plot, 'No data for the MDH plot'); return; }
        var xr = PRiSM_plot_range(tt, true), yr = PRiSM_plot_range(pp, false);
        var scaleX = { kind: 'log', min: xr.min, max: xr.max, label: 'Δt (hr)' };
        var scaleY = { kind: 'lin', min: yr.min, max: yr.max, label: 'Pressure (psia)' };
        var tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Semilog MDH' });
        var pts = PRiSM_plot_zip(tt, pp);
        var col = (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME.accent) || '#f0883e';
        if (typeof PRiSM_plot_dots === 'function') PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, col, 2.5);
        if (data && data.line && isNum(data.line.m) && isNum(data.line.b)) {
            var l = data.line;
            ctx.save(); ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(tr.toX(xr.min), tr.toY(l.b + l.m * Math.log10(xr.min)));
            ctx.lineTo(tr.toX(xr.max), tr.toY(l.b + l.m * Math.log10(xr.max))); ctx.stroke(); ctx.restore();
        }
        if (!canvas._prismAxes || canvas._prismAxes.plotKey !== 'mdh') {
            canvas._prismAxes = { scaleX: scaleX, scaleY: scaleY, toX: tr.toX, toY: tr.toY, plot: plot, plotKey: 'mdh' };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — UI PANEL (Tab 2, C7)
    // ═══════════════════════════════════════════════════════════════

    function _fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential((sig || 4) - 1);
        if (a >= 1000) return v.toFixed(1);
        return Number(v.toPrecision(sig || 4)).toString();
    }
    function _esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function _byId(id) { return HAS_DOC ? document.getElementById(id) : null; }

    var PANEL_CSS =
        '.prism-sl-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px}' +
        '.prism-sl-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text2);min-width:0;flex:1 1 110px;max-width:220px}' +
        '.prism-sl-field input,.prism-sl-field select{width:100%;box-sizing:border-box;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:5px 6px;font-size:12px}' +
        '.prism-sl-btns{display:flex;flex-wrap:wrap;gap:6px}' +
        '.prism-sl-tablewrap{overflow-x:auto;max-width:100%}' +
        '.prism-sl-table{width:100%;border-collapse:collapse;font-size:12px}' +
        '.prism-sl-table td{padding:4px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top}' +
        '.prism-sl-table td.prism-sl-l{color:var(--text2)}' +
        '.prism-sl-table td.prism-sl-v{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
        '.prism-sl-warn{font-size:12px;color:var(--yellow);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin:6px 0}' +
        '.prism-sl-badge{display:inline-block;font-size:11px;padding:2px 7px;border-radius:10px;margin:2px 4px 2px 0;border:1px solid var(--border)}' +
        '.prism-sl-ok{color:var(--green)}.prism-sl-bad{color:var(--red)}' +
        '.prism-sl-note{font-size:11px;color:var(--text3);margin:4px 0}' +
        '.prism-sl-sub{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}' +
        '.prism-sl-sub summary{cursor:pointer;color:var(--text);font-size:13px;margin-bottom:6px}' +
        '.prism-sl-dtable input{width:100%;box-sizing:border-box;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px;font-size:12px}';

    function _ensureCss() {
        if (!HAS_DOC || _byId('prism_sl_css')) return;
        var s = document.createElement('style');
        s.id = 'prism_sl_css';
        s.textContent = PANEL_CSS;
        (document.head || document.body || document.documentElement).appendChild(s);
    }

    function _resultsHTML(r) {
        if (!r) return '<div class="prism-sl-note">Press “Analyse straight line” to compute.</div>';
        if (!r.ok) return '<div class="prism-sl-warn">' + _esc(r.reason || 'Analysis not possible') + '</div>';
        var gas = !!(r.pseudo && r.fluid === 'gas');
        var rows = [
            ['Method', _esc(r.methodLabel || r.method) + (gas ? ' — on m(p)' : '')],
            ['Window Δt (h)', _fmt(r.window.t0, 3) + ' – ' + _fmt(r.window.t1, 4) + ' (' + r.window.n + ' pts' + (r.window.auto ? ', auto' : ', manual') + ')'],
            [gas ? 'Semilog slope m (psi²/cp per cycle)' : 'Semilog slope m (psi/cycle)', _fmt(r.m, 4)],
            ['kh (md·ft)', _fmt(r.kh, 4)],
            ['Permeability k (md)', _fmt(r.k, 4)],
            ['p at 1 h on the line, p1hr (psia)' + (gas ? ' — from m(p)' : ''), _fmt(r.p1hr, 5)],
            ['Skin S', _fmt(r.S, 3)]
        ];
        if (isNum(r.pStar)) rows.push(['Extrapolated pressure p* (psia)' + (gas ? ' — from m*' : ''), _fmt(r.pStar, 5)]);
        if (gas && isNum(r.dmS)) rows.push(['Skin Δm(p)S (psi²/cp)', _fmt(r.dmS, 4)]);
        rows.push(['Skin pressure drop ΔpS (psi)', _fmt(r.dpS, 4)]);
        rows.push(['Flow efficiency FE', _fmt(r.FE, 3)]);
        rows.push(['Damage ratio DR', _fmt(r.DR, 3)]);
        rows.push(['Productivity index J (per psi)', _fmt(r.J, 3)]);
        rows.push(['Undamaged J_ideal (per psi)', _fmt(r.J_ideal, 3)]);
        rows.push(['Effective wellbore radius rw′ (ft)', _fmt(r.rwEff, 3)]);
        rows.push(['Radius of investigation at ' + _fmt(r.tEnd, 3) + ' h (ft)', _fmt(r.rinv, 4)]);
        rows.push(['Storage C from unit slope (bbl/psi)', r.unitSlope && r.unitSlope.found ? _fmt(r.C, 3) : 'not seen']);
        rows.push(['Dimensionless storage CD', r.unitSlope && r.unitSlope.found ? _fmt(r.CD, 3) : '—']);
        rows.push(['Line fit R²', _fmt(r.r2, 5)]);
        var html = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_table">';
        rows.forEach(function (row) {
            html += '<tr><td class="prism-sl-l">' + row[0] + '</td><td class="prism-sl-v">' + row[1] + '</td></tr>';
        });
        html += '</table></div>';
        var c = r.crossCheck || {};
        if (isNum(c.dpPrime_r)) {
            var okCls = c.pass ? 'prism-sl-ok' : 'prism-sl-bad';
            html += '<div id="prism_sl_cross" style="margin-top:6px">' +
                '<span class="prism-sl-badge ' + okCls + '">' + (c.pass ? '✓' : '✗') + ' Derivative-plateau check</span>' +
                '<span class="prism-sl-badge">plateau Δp′ ' + _fmt(c.dpPrime_r, 4) + ' psi</span>' +
                '<span class="prism-sl-badge">k ' + _fmt(c.k_ll, 4) + ' md (' + (isNum(c.khDiffPct) ? c.khDiffPct.toFixed(1) + ' %' : '—') + ')</span>' +
                '<span class="prism-sl-badge">S ' + _fmt(c.S_ll, 3) + ' (ΔS ' + (isNum(c.dS) ? c.dS.toFixed(2) : '—') + ')</span></div>';
        }
        return html;
    }

    function _warnHTML(r) {
        if (!r || !r.warnings || !r.warnings.length) return '';
        return r.warnings.map(function (w) { return '<div class="prism-sl-warn">⚠ ' + _esc(w) + '</div>'; }).join('');
    }

    function _decompDefaults() {
        var st = _state();
        var params = st.params || {};
        var w = null;
        try { w = getWell(G.PRiSM_dataset); } catch (e) { w = {}; }
        w = w || {};
        var h = firstNum(w.h);
        var b = firstNum(params.hp_to_h);
        return {
            h: h, rw: firstNum(w.rw),
            hp: (isNum(b) && isNum(h)) ? b * h : null,
            kvkh: firstNum(params.KvKh, 1),
            theta: firstNum(params.theta_deg),
            xf: firstNum(params.xf)
        };
    }

    function _panelHTML() {
        var st = _state();
        var r = st.semilog;
        var o = (r && r.opts) || {};
        var mw = o.window || {};
        var d = _decompDefaults();
        function opt(v, label) { return '<option value="' + v + '"' + ((o.method || 'auto') === v ? ' selected' : '') + '>' + label + '</option>'; }
        function num(id, label, val, ph) {
            return '<label class="prism-sl-field">' + label + '<input id="' + id + '" type="number" step="any" inputmode="decimal" value="' +
                (isNum(val) ? val : '') + '" placeholder="' + (ph || '') + '"></label>';
        }
        var html = '<div id="prism_sl_root" class="prism-sl">' +
            '<div class="prism-sl-note">Fits a straight line to the radial-flow part of the data and derives permeability, skin and the skin-related results. The window is picked automatically from the flat part of the derivative; you can override it.</div>' +
            '<div class="prism-sl-row">' +
            '<label class="prism-sl-field">Method<select id="prism_sl_method">' +
            opt('auto', 'Automatic (from test type)') + opt('mdh', 'MDH — Δp vs log Δt') + opt('horner', 'Horner — build-up') +
            opt('superposition', 'Superposition — multi-rate') + opt('agarwal', 'Agarwal equivalent time') +
            '</select></label>' +
            num('prism_sl_t0', 'Window start Δt (h)', mw.t0, r && r.ok ? String(_fmt(r.window.t0, 3)) : 'auto') +
            num('prism_sl_t1', 'Window end Δt (h)', mw.t1, r && r.ok ? String(_fmt(r.window.t1, 4)) : 'auto') +
            '</div>' +
            '<div class="prism-sl-btns" style="margin-bottom:8px">' +
            '<button type="button" class="btn btn-primary" id="prism_sl_run">Analyse straight line</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_auto">Auto window</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_plot">Show on semilog plot</button>' +
            '</div>' +
            '<div id="prism_sl_warn">' + _warnHTML(r) + '</div>' +
            '<div id="prism_sl_results">' + _resultsHTML(r) + '</div>' +
            '<div class="prism-sl-btns" style="margin-top:8px">' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_seed">Use as regression start values</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_report">Store in report</button>' +
            '</div>' +
            '<div id="prism_sl_msg" class="prism-sl-note"></div>' +
            // ── Skin decomposition sub-card ──
            '<details class="prism-sl-sub" id="prism_sl_decomp"><summary>Skin decomposition (mechanical vs geometric vs rate-dependent)</summary>' +
            '<div class="prism-sl-row">' +
            num('prism_sl_h', 'Net pay h (ft)', d.h) + num('prism_sl_hp', 'Perforated interval hp (ft)', d.hp, 'full') +
            num('prism_sl_rw', 'Wellbore radius rw (ft)', d.rw) + num('prism_sl_kvkh', 'kv/kh', d.kvkh) +
            num('prism_sl_theta', 'Well deviation θ (deg)', d.theta, '0') + num('prism_sl_xf', 'Fracture half-length xf (ft)', d.xf, 'none') +
            num('prism_sl_D', 'Non-Darcy D (1/rate)', null, '0') + num('prism_sl_q', 'Rate q for D·q', r && r.ok ? r.qRef : null) +
            '</div>' +
            '<div class="prism-sl-btns"><button type="button" class="btn btn-secondary" id="prism_sl_decomp_run">Split the skin</button></div>' +
            '<div id="prism_sl_decomp_out"></div>' +
            '<div class="prism-sl-sub"><div style="font-size:12px;color:var(--text);margin-bottom:4px">Rate-dependent skin from several flow periods (S′ = S + D·q)</div>' +
            '<div class="prism-sl-tablewrap"><table class="prism-sl-table prism-sl-dtable" id="prism_sl_dtable"><tr><td class="prism-sl-l">Rate q</td><td class="prism-sl-l">Apparent skin S′</td></tr>' +
            [0, 1, 2].map(function (i) {
                return '<tr><td><input id="prism_sl_dq_' + i + '" type="number" step="any" inputmode="decimal"></td><td><input id="prism_sl_ds_' + i + '" type="number" step="any" inputmode="decimal"></td></tr>';
            }).join('') + '</table></div>' +
            '<div class="prism-sl-btns" style="margin-top:6px"><button type="button" class="btn btn-secondary" id="prism_sl_drow">Add period</button>' +
            '<button type="button" class="btn btn-secondary" id="prism_sl_dfit">Fit S and D</button></div>' +
            '<div id="prism_sl_dout"></div></div>' +
            '</details>' +
            '</div>';
        return html;
    }

    function _readNum(id) {
        var el = _byId(id);
        if (!el || el.value === '' || el.value == null) return null;
        var v = parseFloat(el.value);
        return isNum(v) ? v : null;
    }

    function _currentOpts() {
        var o = {};
        var m = _byId('prism_sl_method');
        if (m && m.value && m.value !== 'auto') o.method = m.value;
        var t0 = _readNum('prism_sl_t0'), t1 = _readNum('prism_sl_t1');
        if (isNum(t0) || isNum(t1)) o.window = { t0: t0, t1: t1 };
        return o;
    }

    function _refreshPanel() {
        var r = _state().semilog;
        var w = _byId('prism_sl_warn'); if (w) w.innerHTML = _warnHTML(r);
        var res = _byId('prism_sl_results'); if (res) res.innerHTML = _resultsHTML(r);
        var t0 = _byId('prism_sl_t0'), t1 = _byId('prism_sl_t1');
        if (r && r.ok) {
            if (t0) t0.placeholder = String(_fmt(r.window.t0, 3));
            if (t1) t1.placeholder = String(_fmt(r.window.t1, 4));
        }
        var q = _byId('prism_sl_q');
        if (q && q.value === '' && r && r.ok && isNum(r.qRef)) q.value = r.qRef;
    }

    function _redrawPlot() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    function _msg(text) { var m = _byId('prism_sl_msg'); if (m) m.textContent = text; }

    function _wirePanel() {
        var run = _byId('prism_sl_run');
        if (run) run.onclick = function () {
            runAndStore(Object.assign(_currentOpts(), { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        var auto = _byId('prism_sl_auto');
        if (auto) auto.onclick = function () {
            var a = _byId('prism_sl_t0'), b = _byId('prism_sl_t1');
            if (a) a.value = ''; if (b) b.value = '';
            var o = _currentOpts(); delete o.window;
            runAndStore(Object.assign(o, { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        var meth = _byId('prism_sl_method');
        if (meth) meth.onchange = function () {
            runAndStore(Object.assign(_currentOpts(), { notify: true }));
            _refreshPanel(); _redrawPlot();
        };
        ['prism_sl_t0', 'prism_sl_t1'].forEach(function (id) {
            var el = _byId(id);
            if (el) el.onchange = function () {
                runAndStore(Object.assign(_currentOpts(), { notify: true }));
                _refreshPanel(); _redrawPlot();
            };
        });
        var plotBtn = _byId('prism_sl_plot');
        if (plotBtn) plotBtn.onclick = function () {
            var r = _state().semilog;
            var key = (r && r.ok && r.method === 'horner') ? 'horner' : 'mdh';
            var st = _state();
            st.activePlot = key;
            var sel = _byId('prism_plot_select') || _byId('prism_plot_picker');
            if (sel) { try { sel.value = key; } catch (e) { /* ignore */ } }
            _fire('prism:plot-changed', { plot: key, source: 'semilog' });
            _redrawPlot();
            _msg('Semilog plot selected (' + (key === 'horner' ? 'Horner' : 'MDH') + ').');
        };
        var seed = _byId('prism_sl_seed');
        if (seed) seed.onclick = function () {
            var r = _state().semilog;
            if (useAsSeed(r)) _msg('Start values set: k = ' + _fmt(r.k, 4) + ' md, S = ' + _fmt(r.S, 3) + (isNum(r.C) ? ', C = ' + _fmt(r.C, 3) + ' bbl/psi' : '') + '.');
            else _msg('Run the straight-line analysis first.');
        };
        var rep = _byId('prism_sl_report');
        if (rep) rep.onclick = function () {
            var r = _state().semilog;
            if (!r || !r.ok) { _msg('Run the straight-line analysis first.'); return; }
            r.pinned = true;
            _fire('prism:fit-updated', { source: 'semilog', semilog: r, pinned: true });
            _msg('Straight-line results will be included in the report.');
        };
        var dr = _byId('prism_sl_decomp_run');
        if (dr) dr.onclick = function () {
            var r = _state().semilog || {};
            var st = _state();
            var out = skinDecomposition({
                S_total: r.S, modelKey: st.model, params: st.params || {},
                geom: { h: _readNum('prism_sl_h'), hp: _readNum('prism_sl_hp'), rw: _readNum('prism_sl_rw'),
                    kvkh: _readNum('prism_sl_kvkh'), theta: _readNum('prism_sl_theta'), xf: _readNum('prism_sl_xf') },
                D: _readNum('prism_sl_D'), q: _readNum('prism_sl_q')
            });
            if (r && r.ok) r.decomposition = out;
            var el = _byId('prism_sl_decomp_out');
            if (!el) return;
            if (!isNum(out.S_total)) { el.innerHTML = '<div class="prism-sl-warn">Run the straight-line analysis first (total skin needed).</div>'; return; }
            var rows = [['Total skin S', out.S_total], ['Partial penetration S_pp', out.S_pp], ['Well deviation S_θ', out.S_theta],
                ['Fracture S_f', out.S_f]];
            if (out.S_model) rows.push(['Model pseudo-skin', out.S_model]);
            rows.push(['Rate-dependent D·q', out.Dq], ['Mechanical skin S_mech', out.S_mech]);
            el.innerHTML = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_decomp_table">' +
                rows.map(function (rw) { return '<tr><td class="prism-sl-l">' + rw[0] + '</td><td class="prism-sl-v">' + _fmt(rw[1], 3) + '</td></tr>'; }).join('') +
                '</table></div><div class="prism-sl-note">' +
                (out.S_mech > 0.5 ? 'Mechanical damage remains after removing geometric terms: stimulation may help.' :
                    'Little mechanical damage: the measured skin is mostly geometric or rate-dependent.') + '</div>';
        };
        var addRow = _byId('prism_sl_drow');
        if (addRow) addRow.onclick = function () {
            var tb = _byId('prism_sl_dtable');
            if (!tb) return;
            var nRows = 0;
            while (_byId('prism_sl_dq_' + nRows)) nRows++;
            var tr = document.createElement('tr');
            tr.innerHTML = '<td><input id="prism_sl_dq_' + nRows + '" type="number" step="any" inputmode="decimal"></td><td><input id="prism_sl_ds_' + nRows + '" type="number" step="any" inputmode="decimal"></td>';
            (tb.tBodies && tb.tBodies[0] ? tb.tBodies[0] : tb).appendChild(tr);
        };
        var dfit = _byId('prism_sl_dfit');
        if (dfit) dfit.onclick = function () {
            var rows = [];
            for (var i = 0; _byId('prism_sl_dq_' + i); i++) rows.push({ q: _readNum('prism_sl_dq_' + i), S: _readNum('prism_sl_ds_' + i) });
            var fr = rateDependentSkin(rows);
            var el = _byId('prism_sl_dout');
            if (!el) return;
            if (!fr.ok) { el.innerHTML = '<div class="prism-sl-warn">' + _esc(fr.reason) + '</div>'; return; }
            var st = _state();
            if (st.semilog && st.semilog.ok) st.semilog.rateDependent = fr;
            el.innerHTML = '<div class="prism-sl-tablewrap"><table class="prism-sl-table" id="prism_sl_dres">' +
                '<tr><td class="prism-sl-l">Rate-independent skin S</td><td class="prism-sl-v">' + _fmt(fr.S, 4) + '</td></tr>' +
                '<tr><td class="prism-sl-l">Non-Darcy coefficient D (per unit rate)</td><td class="prism-sl-v">' + _fmt(fr.D, 4) + '</td></tr>' +
                '<tr><td class="prism-sl-l">Fit R² (' + fr.n + ' periods)</td><td class="prism-sl-v">' + _fmt(fr.r2, 4) + '</td></tr></table></div>';
            var dIn = _byId('prism_sl_D');
            if (dIn) dIn.value = fr.D;
        };
    }

    function renderSemilogPanel(hostEl) {
        if (!HAS_DOC) return;
        var host = hostEl || _byId('prism_semilog_host');
        if (!host) return;
        _ensureCss();
        var st = _state();
        var ds = G.PRiSM_dataset;
        var hash = dsHash(ds);
        if (ds && ds.t && ds.t.length && (!st.semilog || st.semilog.datasetHash !== hash)) {
            var prevOpts = (st.semilog && st.semilog.datasetHash === hash && st.semilog.opts) || {};
            var o = {};
            if (prevOpts.method && prevOpts.method !== 'auto') o.method = prevOpts.method;
            runAndStore(o);
        } else if (st.semilog && st.semilog.ok && !st.semilog.plot && ds && ds.t && ds.t.length) {
            // Restored from storage without plotting arrays: recompute quietly.
            var ro = {};
            var so = st.semilog.opts || {};
            if (so.method && so.method !== 'auto') ro.method = so.method;
            if (so.window) ro.window = so.window;
            runAndStore(ro);
        }
        host.innerHTML = _panelHTML();
        _wirePanel();
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — REGISTRATION (C7) + EVENT LISTENERS
    // ═══════════════════════════════════════════════════════════════

    var PANEL_SPEC = {
        id: 'semilog',
        title: 'Straight-line analysis & skin',
        order: 5,
        when: function () { return !(G.PRiSM && G.PRiSM.mode === 'decline'); },
        render: function (el) { renderSemilogPanel(el); },
        collapsed: false
    };

    function _registerPanel() {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(2, PANEL_SPEC); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[2] = G.PRiSM_tabPanels[2] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === PANEL_SPEC.id) { arr[i] = PANEL_SPEC; return; }
        arr.push(PANEL_SPEC);
    }

    function _registerHooks() {
        var hooks = G.PRiSM_postDrawHooks = G.PRiSM_postDrawHooks || [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === _postDraw._prismId) { hooks[i] = _postDraw; return; }
        hooks.push(_postDraw);
    }

    function _registerPlot() {
        var reg = G.PRiSM_PLOT_REGISTRY = G.PRiSM_PLOT_REGISTRY || {};
        if (!reg.mdh) {
            reg.mdh = { fn: 'PRiSM_semilog_plot_mdh', label: 'Semilog MDH (p vs log Δt)', mode: 'transient' };
        }
    }

    function _installListeners() {
        if (typeof G.addEventListener !== 'function' || G.__prismSemilogListeners) return;
        G.__prismSemilogListeners = true;
        function recompute() {
            var ds = G.PRiSM_dataset;
            if (!ds || !ds.t || !ds.t.length) return;
            var st = _state();
            var o = {};
            var so = (st.semilog && st.semilog.opts) || {};
            if (so.method && so.method !== 'auto') o.method = so.method;
            runAndStore(o);
            if (_byId('prism_sl_root')) _refreshPanel();
        }
        G.addEventListener('prism:dataset-loaded', recompute);
        G.addEventListener('prism:well-changed', recompute);
    }

    // ── Public API ──────────────────────────────────────────────────
    G.PRiSM_semilogAnalysis = function (adata, well, opts) {
        // Called with no data arguments → analyse the current dataset and store.
        if (!adata && !well) return runAndStore(opts || {});
        var r = semilogAnalysis(adata, well, opts);
        if (opts && opts.store) {
            var st = _state(); var prev = st.semilog; st.semilog = r;
            if (_sig(prev) !== _sig(r)) _fire('prism:fit-updated', { source: 'semilog', semilog: r });
        }
        return r;
    };
    G.PRiSM_skinSummary = skinSummary;
    G.PRiSM_skinDecomposition = skinDecomposition;
    G.PRiSM_rateDependentSkin = rateDependentSkin;
    G.PRiSM_renderSemilogPanel = renderSemilogPanel;
    G.PRiSM_semilogPlotLine = plotLine;
    G.PRiSM_semilog_plot_mdh = plotMdhFallback;
    G.PRiSM_semilog = {
        version: 1,
        analyse: semilogAnalysis,
        run: runAndStore,
        useAsSeed: useAsSeed,
        localWell: localWell,
        localAnalysisData: localAnalysisData,
        getWell: getWell,
        getAnalysisData: getAnalysisData,
        bourdet: bourdet,
        localLogSlope: localLogSlope,
        findIARFWindow: findIARFWindow,
        supX: supX,
        linfit: linfit,
        postDrawHook: _postDraw,
        panelSpec: PANEL_SPEC,
        bronsMarting: _bronsMarting,
        cincoLey: _cincoLey
    };

    _registerPanel();
    _registerHooks();
    _registerPlot();
    _installListeners();
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var log = (typeof console !== 'undefined') ? console : { log: function () {}, error: function () {} };
    var fails = 0, n = 0;
    function check(name, cond, extra) {
        n++;
        if (!cond) { fails++; log.error('[34-semilog-skin self-test] FAIL ' + name + (extra ? ' — ' + extra : '')); }
    }
    function near(a, b, tol) { return typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= tol; }
    var well = { q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200, fluid: 'oil' };
    var kTrue = 45, sTrue = 2.5;
    var mTrue = 162.6 * 850 * 1.25 * 1.1 / (kTrue * 35);
    var logTerm = Math.log10(kTrue / (0.18 * 1.1 * 1.2e-5 * 0.354 * 0.354)) - 3.2275;
    function pwfIARF(t) { return 4200 - mTrue * (Math.log10(t) + logTerm + 0.8686 * sTrue); }
    try {
        // 1. Synthetic IARF drawdown (exact semilog line).
        var t = [], p = [];
        for (var i = 0; i <= 40; i++) { var tt = Math.pow(10, -1 + i * 0.075); t.push(tt); p.push(pwfIARF(tt)); }
        var ad = G.PRiSM_semilog.localAnalysisData({ t: t, p: p, q: t.map(function () { return 850; }) }, Object.assign({ testType: 'drawdown' }, well));
        var r = G.PRiSM_semilog.analyse(ad, well, {});
        check('mdh ok', r.ok, r.reason);
        check('mdh method', r.method === 'mdh', r.method);
        check('mdh m', near(r.m, mTrue, 1e-6), r.m);
        check('mdh k', near(r.k, kTrue, 1e-6), r.k);
        check('mdh S', near(r.S, sTrue, 2e-3), r.S);
        check('cross-check', r.crossCheck && r.crossCheck.pass === true);
        // 2. Horner build-up after tp = 24 h.
        var tp = 24, pwf0 = pwfIARF(tp), tb = [], pb = [], qb = [];
        tb.push(tp); pb.push(pwf0); qb.push(850);
        for (var j = 0; j <= 40; j++) {
            var dt = Math.pow(10, -1 + j * 0.075);
            tb.push(tp + dt); qb.push(0);
            pb.push(4200 - mTrue * (Math.log10(tp + dt) - Math.log10(dt)));
        }
        var ab = G.PRiSM_semilog.localAnalysisData({ t: [0].concat(tb), p: [4200].concat(pb), q: [850].concat(qb) }, Object.assign({}, well, { pi: null, testType: 'auto' }));
        var rb = G.PRiSM_semilog.analyse(ab, well, {});
        check('horner ok', rb.ok, rb.reason);
        check('horner method', rb.method === 'horner', rb.method);
        check('horner tp', near(rb.tp, 24, 1e-9), rb.tp);
        check('horner k', near(rb.k, kTrue, 1e-6), rb.k);
        check('horner S', near(rb.S, sTrue, 2e-3), rb.S);
        check('horner p*', near(rb.pStar, 4200, 1e-6), rb.pStar);
        // 3. Rate-dependent skin.
        var rd = G.PRiSM_rateDependentSkin([{ q: 500, S: 2.5 }, { q: 1000, S: 3 }, { q: 1500, S: 3.5 }]);
        check('rate-dependent S', near(rd.S, 2, 1e-9), rd.S);
        check('rate-dependent D', near(rd.D, 0.001, 1e-12), rd.D);
        // 4. Decomposition (partial penetration b = 0.2).
        var dc = G.PRiSM_skinDecomposition({ S_total: 12.79, modelKey: 'partialPen', params: { hp_to_h: 0.2, KvKh: 1 }, geom: { h: 35, rw: 0.354, kvkh: 1 } });
        check('decomposition S_mech', near(dc.S_mech, 2.0, 0.05), dc.S_mech);
        // 5. Skin summary on the plan's reference numbers.
        var sm = G.PRiSM_skinSummary({ S: 2.5, kh: 1575, q: 850, B: 1.25, mu: 1.1, rw: 0.354, pbar: 4200, pwf: 3089.8 });
        check('ΔpS', near(sm.dpS, 261.9, 0.5), sm.dpS);
        check('FE', near(sm.FE, 0.764, 0.002), sm.FE);
        check('J', near(sm.J, 0.766, 0.002), sm.J);
        check('rw′', near(sm.rwEff, 0.0291, 0.0002), sm.rwEff);
    } catch (e) {
        fails++; log.error('[34-semilog-skin self-test] threw: ' + (e && e.stack || e));
    }
    if (fails) log.error('[34-semilog-skin self-test] ' + fails + '/' + n + ' checks failed');
    else log.log('[34-semilog-skin self-test] ' + n + '/' + n + ' checks passed');
})();
