// =============================================================================
// WTS — 49-calc-dfit-triage.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// DFIT triage and data-health gate (docs/DFIT-PLAN.md §3.5a, §4.18, §6.3; owner WPT):
//   window.PRiSM_dfit_triage(prep, events, ctx)   → Triage  (21 checks Q1–Q21, windows, blunders, re-pump verdict, grade, salvage)
//   window.PRiSM_dfit_blunders(prep, events, ctx) → [{id, hypothesis, score, bf:null, fix:{field, from, to, also?}, text}]
//   window.PRiSM_dfit_repump(triage, ctx)         → {verdict:'continue'|'caution'|'repump', rules:[{id, level, text}], ack:false}
//   window.PRiSM_dfit_grade(triage, consensus, aca, opts?) → {letter:'A'|'B'|'C'|'D', why:[string]}
// Pure: no DOM, storage, timers or events; no unseeded random numbers. Resolved at call time by the Round-8 DFIT pipeline (57), which
// returns triage:null and shows "triage unavailable" when this file is absent. WTS_wellbore (48) is resolved at call time too,
// only for the theory storage / wave speed / hydrostatic when ctx does not carry them; its WP0 stubs are skipped.
//
// ctx (§3.5a): {isip, derivs, hammer, ramps, stepDown, inputs, well, plan}; optional extras read when present:
//   ds (the raw DfitDataset: units, raw channels, pAnn), stepRate, picks ([ClosurePick]), csys ({VwCw, waveSpeed}) or
//   VwCwTheory, bleed (WTS_wellbore.bleedOff output, t1psi h), strapVolume (bbl), tCloseS (valve closing time, s), align
//   (WTS_wellbore.align output, offsetS), tide ({ampPsi, dpPsi, removed}), classification, frac, consensus, aca.
//   strapVolume is the volume pumped after the wellbore fill: the rate integral to shut-in minus Events.Vfill is compared with it.
//   provenance (optional, inputs.provenance or ctx.provenance): {'rock.sigmaVGrad': 'user'|'logged'|…|'default'}. The input clamp
//   always fills rock.sigmaVGrad, so at its default (1.0 psi/ft) it counts as entered only when a provenance says so.
// Hydrostatics: one model for the static check and the blunder bands — WTS_wellbore.hydrostatic(p_s static, 0, TVD, column,
//   null, {fluid}) with the column built once from the inputs (survey, strings, fluid, temp, datum), else 0.052·ρ·TVD.
// R2 (ISIP-gradient band) is a warning, not a fail, when the violated bound is a generic prior: the lower bound when p_i comes
//   from the fluid hydrostatic, the upper bound when S_v is the default and not entered.
// Evidence ids: Q1–Q21 = the checks in CHECKS order; Q0 = the triage summary (Triage.ev).
// Grade mapping choices (§6.3 leaves them open): a failed check inside an analysed window (red light) grades C, like a failed
//   check outside the windows; a surface vacuum on a surface-converted analysis is masked (excluded window), so its fail is
//   recorded inWindow:false; a gauge thermal transient above the limit outside the pick window is reported as a warning.
// Thresholds: every value of DEFAULTS below is editable through inputs.options.triage[checkId][key] (finite numbers only).
// Clock convention: a positive offsetS means the rate record lags the pressure record (rate events appear offsetS later on
// the common clock); the fix writes channels.clockOffsetH = current − offsetS / 3600 (the shift applied to the rate clock).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var VERSION = 't1';
    var PSI_PER_FT_PER_PPG = 0.052;
    var BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/g;

    // ── thresholds (user-editable through inputs.options.triage[id]) ──
    var DEFAULTS = {
        units:       { gapFrac: 0.01, gapFactor: 5 },
        clock:       { passS: 1, warnCorrS: 2, contradictS: 10 },
        stiffness:   { lo: 0.5, warn: 2, fail: 4 },
        air:         { pass: 0.25, warn: 1.5, fail: 2 },
        surface:     { warnPsig: 15, failPsig: 0 },
        hydrostatic: { warn: 0.02, fail: 0.05 },
        isolation:   { flatPsi: 10, linR2: 0.995, curvRatio: 2 },
        sampling:    { pass: 10, fail: 3 },
        shutin:      { warn: 2, fail: 4 },
        stepdown:    { passSteps: 4, warnSteps: 3, passRange: 0.6, failRange: 0.3 },
        steprate:    { warn: 1, fail: 2 },
        friction:    { warn: 1, fail: 3 },
        bleed:       { warn: 2 },
        volume:      { warn: 0.05, fail: 0.10 },
        temperature: {},
        gaugeThermal: { fail: 1 },
        noise:       { warn: 0.05, fail: 0.15 },
        thermal:     { warn: 0.3, fail: 0.6, minN: 20 },
        sink:        { slopeMin: 0.9, slopeMax: 1.1, cycles: 0.3, dtDmin: 1 },
        tides:       { warn: 0.10, fail: 0.30 },
        annulus:     { dpMin: 50, corr: 0.6 },
        blunders:    { psigZero: 2, sigmaVPlus: 0.05, hydro: 0.02, pumpMinLo: 1, pumpMinHi: 60, volTol: 0.10, hourTolS: 120, rampRatioTol: 1.5 },
        repump:      { nwbFrac: 0.30, vwcw: 2, rvisLo: 0.3, rvisHi: 0.5, jouk: 0.5, breakdownPsi: 50 }
    };
    // check id → [evidence id, title]; the order is the order of Triage.checks
    var CHECKS = [
        ['units', 'Q1', 'Units and time base'],
        ['clock', 'Q2', 'Clock alignment'],
        ['stiffness', 'Q3', 'Wellbore stiffness'],
        ['air', 'Q4', 'Air or gas cross-check'],
        ['surface', 'Q5', 'Surface liquid-supported'],
        ['hydrostatic', 'Q6', 'Static hydrostatic check'],
        ['isolation', 'Q7', 'Gauge isolation'],
        ['sampling', 'Q8', 'Sampling vs hammer'],
        ['shutin', 'Q9', 'Shut-in duration'],
        ['stepdown', 'Q10', 'Step-down quality'],
        ['steprate', 'Q11', 'Step-rate stabilisation'],
        ['friction', 'Q12', 'Surface-gauge friction share'],
        ['bleed', 'Q13', 'Bleed-off window'],
        ['volume', 'Q14', 'Volume reconciliation'],
        ['temperature', 'Q15', 'Temperature channel'],
        ['gaugeThermal', 'Q16', 'Gauge thermal transient'],
        ['noise', 'Q17', 'Derivative noise'],
        ['thermal', 'Q18', 'Thermal correlation'],
        ['sink', 'Q19', 'Constant-rate sink'],
        ['tides', 'Q20', 'Tides and barometric'],
        ['annulus', 'Q21', 'Annulus communication']
    ];
    var CRITICAL = { units: 1, isolation: 1 };   // a fail here makes the test uninterpretable

    // ═══════════════════════════════════════════════════════════════════════
    // small numeric helpers
    // ═══════════════════════════════════════════════════════════════════════
    function fin(v) { return typeof v === 'number' && isFinite(v); }
    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function arrLike(v) { return !!v && typeof v.length === 'number' && typeof v !== 'string'; }
    function gp(o, path, def) {
        var parts = path.split('.'), x = o;
        for (var i = 0; i < parts.length; i++) { if (x == null || typeof x !== 'object') return def; x = x[parts[i]]; }
        return x === undefined ? def : x;
    }
    function median(a) {
        var b = [];
        for (var i = 0; i < a.length; i++) if (fin(a[i])) b.push(a[i]);
        if (!b.length) return NaN;
        b.sort(function (x, y) { return x - y; });
        var m = b.length >> 1;
        return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function mad(a) {
        var m = median(a), d = [];
        for (var i = 0; i < a.length; i++) if (fin(a[i])) d.push(Math.abs(a[i] - m));
        return 1.4826 * median(d);
    }
    function linreg(x, y) {
        var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, i;
        for (i = 0; i < x.length; i++) {
            if (!fin(x[i]) || !fin(y[i])) continue;
            n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; syy += y[i] * y[i];
        }
        if (n < 2) return null;
        var vx = sxx - sx * sx / n, vy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
        if (!(vx > 0)) return null;
        var b = cxy / vx, a = (sy - b * sx) / n;
        var r2 = vy > 0 ? (cxy * cxy) / (vx * vy) : 1;
        return { a: a, b: b, r2: r2, n: n, r: vy > 0 ? cxy / Math.sqrt(vx * vy) : 0 };
    }
    function corr(x, y) { var r = linreg(x, y); return r ? r.r : NaN; }
    function ranks(a) {
        var ix = a.map(function (_, i) { return i; }).sort(function (i, j) { return a[i] - a[j]; }), r = new Array(a.length), i = 0;
        while (i < ix.length) { var j = i; while (j + 1 < ix.length && a[ix[j + 1]] === a[ix[i]]) j++; for (var k = i; k <= j; k++) r[ix[k]] = 0.5 * (i + j); i = j + 1; }
        return r;
    }
    function interp(xs, ys, x) {
        var n = xs.length;
        if (!n) return NaN;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
        var dx = xs[hi] - xs[lo];
        return dx > 0 ? ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / dx : ys[lo];
    }
    function clampTxt(s) {
        s = String(s == null ? '' : s).replace(BANNED, 'n/a');
        return s.length > 299 ? s.slice(0, 296) + '...' : s;
    }
    function fmt(v, dp) {
        if (!fin(v)) return 'n/a';
        dp = dp == null ? 0 : dp;
        var neg = v < 0, s = Math.abs(v).toFixed(dp), parts = s.split('.');
        if (parts[0].length > 3) parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        var out = parts.join('.');
        return (neg && +s !== 0 ? '-' : '') + out;
    }
    function rnd(v, dp) { if (!fin(v)) return null; var f = Math.pow(10, dp); return Math.round(v * f) / f; }
    function sig(v, n) { if (!fin(v) || v === 0) return fin(v) ? v : null; var d = Math.ceil(Math.log(Math.abs(v)) / Math.LN10); var f = Math.pow(10, n - d); return Math.round(v * f) / f; }
    function failure(code, errors, bad) { return { ok: false, code: code, errors: errors || [], bad: bad || [] }; }
    function isRealFn(f) { return typeof f === 'function' && !f._dfitStub; }
    function okRes(r) { return r && typeof r === 'object' && r.ok === true; }

    // threshold lookup: DEFAULTS[id] overridden by inputs.options.triage[id][key] (finite numbers only)
    function thr(C, id) {
        var d = DEFAULTS[id] || {}, o = gp(C.inputs, 'options.triage.' + id, null), out = {}, k;
        for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
        if (isObj(o)) for (k in o) if (Object.prototype.hasOwnProperty.call(o, k) && fin(o[k])) out[k] = o[k];
        return out;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // context: resolved quantities shared by the checks, the blunders and the re-pump rules
    // ═══════════════════════════════════════════════════════════════════════
    function buildCtx(prep, events, ctx) {
        ctx = isObj(ctx) ? ctx : {};
        var C = {
            prep: prep, ev: isObj(events) && events.ok !== false ? events : null, raw: ctx,
            inputs: isObj(ctx.inputs) ? ctx.inputs : {}, well: isObj(ctx.well) ? ctx.well : {},
            isip: okRes(ctx.isip) ? ctx.isip : null, derivs: okRes(ctx.derivs) ? ctx.derivs : null,
            hammer: okRes(ctx.hammer) ? ctx.hammer : null, ramps: Array.isArray(ctx.ramps) ? ctx.ramps.filter(okRes) : [],
            stepDown: okRes(ctx.stepDown) ? ctx.stepDown : null, stepRate: okRes(ctx.stepRate) ? ctx.stepRate : null,
            plan: isObj(ctx.plan) ? ctx.plan : null, ds: isObj(ctx.ds) ? ctx.ds : null,
            picks: Array.isArray(ctx.picks) ? ctx.picks.filter(function (p) { return p && p.ok !== false && fin(p.dt); }) : []
        };
        var t = prep.t, pw = prep.pw, n = t.length;
        C.t = t; C.pw = pw; C.n = n;
        C.q = arrLike(prep.q) && prep.q.length === n ? prep.q : null;
        C.pSurf = arrLike(prep.pSurf) && prep.pSurf.length === n ? prep.pSurf : null;
        C.T = arrLike(prep.T) && prep.T.length === n ? prep.T : null;
        if (C.T) { var anyT = false; for (var i = 0; i < n; i++) if (fin(C.T[i])) { anyT = true; break; } if (!anyT) C.T = null; }
        C.src = prep.src === 'surface-converted' ? 'surface-converted' : 'bh';
        C.sigma = fin(prep.sigma) ? prep.sigma : 0;
        C.atm = fin(gp(C.inputs, 'channels.atmPsia', null)) ? gp(C.inputs, 'channels.atmPsia') : 14.696;
        // events (fallbacks from the record when the events stage failed)
        var ev = C.ev;
        C.tStart = ev && fin(ev.tStart) ? ev.tStart : t[0];
        C.ts = ev && fin(ev.ts) ? ev.ts : NaN;
        if (!fin(C.ts)) { var dropI = largestDrop(C); C.ts = dropI >= 0 ? t[dropI] : t[0]; }
        C.tEnd = t[n - 1];
        C.iFall = firstIndexAfter(t, C.ts);        // first sample after shut-in
        C.qLast = ev && fin(ev.qLast) ? ev.qLast : null;
        C.qMax = ev && fin(ev.qMax) ? ev.qMax : null;
        if (C.q && !fin(C.qMax)) { var qm = 0; for (var j = 0; j < n; j++) if (fin(C.q[j]) && C.q[j] > qm) qm = C.q[j]; C.qMax = qm; }
        // geometry, fluid, priors
        var tvd = gp(C.inputs, 'datumTvd', null);
        C.tvd = fin(tvd) && tvd > 0 ? tvd : null;
        var md = gp(C.inputs, 'datumMd', null);
        C.md = fin(md) && md > 0 ? md : C.tvd;
        var rho = gp(C.inputs, 'fluid.rhoPpg', null);
        C.rho = fin(rho) && rho > 0 ? rho : 8.43;
        C.hydroGrad = PSI_PER_FT_PER_PPG * C.rho;
        C.fluid = fluidOf(C);
        priorsInto(C);
        // ISIP: the ISIP stage, else the first falloff sample
        C.isipVal = C.isip && fin(C.isip.value) ? C.isip.value : (C.iFall < n ? pw[C.iFall] : NaN);
        C.gradIsip = C.tvd && fin(C.isipVal) ? C.isipVal / C.tvd : null;
        // last pumping pressure
        C.iLastPump = C.iFall > 0 ? C.iFall - 1 : 0;
        C.pLast = pw[C.iLastPump];
        // theory storage and wave speed
        theory(C);
        return C;
    }
    // the fluid handed to WTS_wellbore: the inputs' fluid with the resolved density (its own default never replaces ours)
    function fluidOf(C) {
        var f = isObj(C.inputs.fluid) ? C.inputs.fluid : {}, out = {}, k;
        for (k in f) if (Object.prototype.hasOwnProperty.call(f, k)) out[k] = f[k];
        out.rhoPpg = C.rho;
        return out;
    }
    // entered vs generic priors: a provenance other than an entered one (or none, with the value at its default) is generic
    var SV_DEFAULT = 1.0, ENTERED = { user: 1, logged: 1, entered: 1, dataset: 1, dfit: 1, measured: 1 };
    function provOf(C, path) {
        var srcs = [gp(C.inputs, 'provenance', null), gp(C.raw, 'provenance', null)];
        for (var i = 0; i < srcs.length; i++) {
            var p = srcs[i];
            if (!isObj(p)) continue;
            var v = Object.prototype.hasOwnProperty.call(p, path) ? p[path] : gp(p, path, null);
            if (typeof v === 'string') return v;
        }
        return null;
    }
    // p_i gradient (lower bound) and S_v gradient (upper bound) of the ISIP-gradient band, each with its generic flag
    function priorsInto(C) {
        var piGrad = gp(C.inputs, 'priors.piGrad', null), wpi = gp(C.well, 'pi', null);
        if (fin(piGrad)) { C.piGrad = piGrad; C.piGradSrc = 'prior'; }
        else if (fin(wpi) && C.tvd) { C.piGrad = wpi / C.tvd; C.piGradSrc = 'well'; }
        else { C.piGrad = C.hydroGrad; C.piGradSrc = 'hydrostatic'; }
        var sv = gp(C.inputs, 'rock.sigmaVGrad', null), svProv = provOf(C, 'rock.sigmaVGrad');
        C.svGrad = fin(sv) ? sv : SV_DEFAULT;
        // the input clamp always fills rock.sigmaVGrad: at its default it counts as entered only when a provenance says so
        C.svGeneric = svProv ? !ENTERED[svProv] : (!fin(sv) || Math.abs(sv - SV_DEFAULT) < 1e-12);
        C.piGeneric = C.piGradSrc === 'hydrostatic';
        var sg = gp(C.inputs, 'priors.sigmaGrad', null);
        C.sigmaGrad = fin(sg) ? sg : null;
        C.generic = C.piGeneric && C.svGeneric && C.sigmaGrad == null;
    }
    function firstIndexAfter(t, x) { for (var i = 0; i < t.length; i++) if (t[i] > x) return i; return t.length; }
    function largestDrop(C) {
        var best = -1, bd = 0;
        for (var i = 0; i + 1 < C.n; i++) {
            var d = C.pw[i] - C.pw[i + 1];
            if (fin(d) && d > bd) { bd = d; best = i; }
        }
        return best;
    }
    function theory(C) {
        var cs = C.raw.csys, vw = null, c = null, W = G.WTS_wellbore;
        if (isObj(cs)) { if (fin(cs.VwCw) && cs.VwCw > 0) vw = cs.VwCw; if (fin(cs.waveSpeed) && cs.waveSpeed > 0) c = cs.waveSpeed; }
        if (vw == null && fin(C.raw.VwCwTheory) && C.raw.VwCwTheory > 0) vw = C.raw.VwCwTheory;
        // the wellbore column, built once (survey, strings, fluid, temperature, datum); shared by the storage and the hydrostatics
        C.col = null;
        if (C.tvd && W && isRealFn(W.column)) {
            try {
                var col = W.column({ survey: C.inputs.survey || null, strings: C.inputs.strings || [], fluid: C.fluid,
                                     temp: C.inputs.temp || {}, datumTvd: C.tvd, datumMd: C.md });
                if (okRes(col)) C.col = col;
            } catch (e) { C.col = null; }
        }
        if ((vw == null || c == null) && C.col && isRealFn(W.csys)) {
            try {
                var r = W.csys(C.col, C.fluid, null);
                if (okRes(r)) { if (vw == null && fin(r.VwCw) && r.VwCw > 0) vw = r.VwCw; if (c == null && fin(r.waveSpeed) && r.waveSpeed > 0) c = r.waveSpeed; }
            } catch (e) { /* theory unavailable */ }
        }
        if (c == null && C.hammer && fin(C.hammer.c) && C.hammer.c > 0) c = C.hammer.c;
        C.VwCwTheory = vw;
        C.waveSpeed = c;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // clock alignment (local method; WTS_wellbore.align or ctx.align take precedence)
    // pressure-up start fitted on the pre-breakdown ramp p − p0 = V(t + L)/C; stop event = rate stop vs the largest
    // negative pressure difference. Returns {ok, offsetS, uncS, stopS, stopUncS, slopePsiPerBbl, method}
    // ═══════════════════════════════════════════════════════════════════════
    function alignLocal(C) {
        var t = C.t, p = C.pw, q = C.q, n = C.n, qMaxRec = 0, ii;
        if (!q || n < 8) return { ok: false };
        for (ii = 0; ii < n; ii++) if (fin(q[ii]) && q[ii] > qMaxRec) qMaxRec = q[ii];   // the record's own scale (a unit blunder)
        if (!(qMaxRec > 0)) return { ok: false };
        // cumulative volume of the rate record (bbl; t h, q bbl/min)
        var V = new Array(n); V[0] = 0;
        for (var i = 1; i < n; i++) {
            var qa = fin(q[i - 1]) ? q[i - 1] : 0, qb = fin(q[i]) ? q[i] : 0;
            V[i] = V[i - 1] + 0.5 * (qa + qb) * (t[i] - t[i - 1]) * 60;
        }
        // rate start (first up-crossing of 2 % of the maximum) and its sampling resolution
        var lev = 0.02 * qMaxRec, kq = -1;
        for (i = 1; i < n; i++) if (fin(q[i]) && q[i] >= lev && !(q[i - 1] >= lev)) { kq = i; break; }
        if (kq < 1) return { ok: false };
        var q0 = fin(q[kq - 1]) ? q[kq - 1] : 0;
        var tq0 = t[kq - 1] + (lev - q0) / (q[kq] - q0) * (t[kq] - t[kq - 1]);
        var uncQ = 0.5 * (t[kq] - t[kq - 1]) * 3600;
        if (q[kq] - q0 < 0.5 * qMaxRec) uncQ = Math.min(uncQ, 0.5);   // a resolved ramp, not a sampled step
        // pressure-up start: baseline from the samples before the first rise
        var m0 = Math.min(5, n), base = [];
        for (i = 0; i < m0; i++) base.push(p[i]);
        var p0 = median(base), thrP = Math.max(10, 10 * C.sigma), ku = -1;
        for (i = 1; i < n; i++) if (p[i] - p0 > thrP) { ku = i; break; }
        if (ku < 1 || ku + 1 >= n) return { ok: false };
        var pre = [];
        for (i = 0; i < ku; i++) pre.push(p[i]);
        p0 = median(pre);
        // peak (breakdown) after the rise
        var kmax = ku;
        for (i = ku; i < n; i++) { if (p[i] > p[kmax]) kmax = i; if (p[i] < p[kmax] - Math.max(50, 0.05 * (p[kmax] - p0))) break; }
        var top = p0 + 0.9 * (p[kmax] - p0), kEnd = ku;
        while (kEnd + 1 <= kmax && p[kEnd + 1] <= top) kEnd++;
        var slope1 = (p[ku] - p[ku - 1]) / (t[ku] - t[ku - 1]);
        var tp0 = slope1 > 0 ? t[ku] - (p[ku] - p0) / slope1 : t[ku];
        var uncP = 0.5 * (t[ku] - t[ku - 1]) * 3600;
        if (kEnd - ku >= 1) uncP = Math.min(uncP, 0.5);
        var L0 = (tq0 - tp0);                        // h
        // fit window: a few baseline samples, then the ramp up to 90 % of the breakdown rise
        var j0 = Math.max(0, ku - 3), idx = [];
        for (i = j0; i <= kEnd; i++) idx.push(i);
        var span = (Math.max(3 * (t[ku] - t[ku - 1]), 2 / 3600) + 2 / 3600), best = null;
        function ssr(L) {
            var sxy = 0, sxx = 0, syy = 0;
            for (var k = 0; k < idx.length; k++) {
                var x = interp(t, V, t[idx[k]] + L), y = p[idx[k]] - p0;
                sxy += x * y; sxx += x * x; syy += y * y;
            }
            if (!(sxx > 0)) return { s: syy, b: NaN };
            var b = sxy / sxx;
            return { s: syy - b * sxy, b: b };
        }
        if (idx.length >= 3) {
            var steps = 400, h = 2 * span / steps, sv = [];
            for (var s = 0; s <= steps; s++) {
                var L = L0 - span + s * h, r = ssr(L);
                sv.push(r.s);
                if (!best || r.s < best.s) best = { s: r.s, L: L, b: r.b, k: s };
            }
            if (best.k > 0 && best.k < steps) {           // parabolic refinement
                var a1 = sv[best.k - 1], a2 = sv[best.k], a3 = sv[best.k + 1], den = a1 - 2 * a2 + a3;
                if (den > 0) { var dl = 0.5 * (a1 - a3) / den * h; var rr = ssr(best.L + dl); if (rr.s <= best.s) best = { s: rr.s, L: best.L + dl, b: rr.b }; }
            }
        } else best = { L: L0, b: NaN };
        var offsetS = best.L * 3600;
        var uncS = Math.max(uncQ, uncP);
        // stop event: last down-crossing of 50 % of the last rate vs the largest negative pressure difference
        var stopS = null, stopUnc = null, qlr = fin(q[C.iLastPump]) && q[C.iLastPump] > 0.05 * qMaxRec ? q[C.iLastPump] : qMaxRec, lvl = 0.5 * qlr, kd = -1;
        for (i = n - 1; i >= 1; i--) if (fin(q[i]) && q[i] < lvl && q[i - 1] >= lvl) { kd = i; break; }
        var iDrop = largestDrop(C);
        if (kd > 0 && iDrop >= 0) {
            var tq1 = t[kd - 1] + (q[kd - 1] - lvl) / (q[kd - 1] - q[kd]) * (t[kd] - t[kd - 1]);
            var tp1 = 0.5 * (t[iDrop] + t[iDrop + 1]);
            stopS = (tq1 - tp1) * 3600;
            stopUnc = 0.5 * (t[kd] - t[kd - 1]) * 3600 + 0.5 * (t[iDrop + 1] - t[iDrop]) * 3600;
        }
        return { ok: true, offsetS: offsetS, uncS: uncS, stopS: stopS, stopUncS: stopUnc,
                 slopePsiPerBbl: fin(best.b) ? best.b : null, method: 'event', rampIdx: idx, p0: p0, tq0: tq0, tp0: tp0 };
    }
    function getAlign(C) {
        if (C._align) return C._align;
        var a = null, r = C.raw.align;
        if (isObj(r) && fin(r.offsetS)) a = { ok: true, offsetS: r.offsetS, uncS: 0, stopS: null, stopUncS: null, method: r.method || 'xcorr', slopePsiPerBbl: null };
        var loc = alignLocal(C);
        if (!a) a = loc;
        else if (loc.ok) { a.stopS = loc.stopS; a.stopUncS = loc.stopUncS; a.slopePsiPerBbl = loc.slopePsiPerBbl; }
        if (loc && loc.ok) { a.rampIdx = loc.rampIdx; a.p0 = loc.p0; }
        C._align = a;
        return a;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // the checks (each returns {level, value, threshold, text, inWindow?, excluded?})
    // ═══════════════════════════════════════════════════════════════════════
    var CK = {};

    CK.units = function (C, T) {
        var ds = C.ds, reasons = [];
        if (ds && arrLike(ds.t)) {
            for (var i = 1; i < ds.t.length; i++) if (fin(ds.t[i]) && fin(ds.t[i - 1]) && ds.t[i] <= ds.t[i - 1]) { reasons.push('time reverses or repeats at row ' + (i + 1)); break; }
            if (ds.timeUnit != null && ds.timeUnit !== 'h') reasons.push('time unit ' + String(ds.timeUnit).slice(0, 12) + ' is not converted to hours');
            if (ds.q && ds.rateUnit != null && ds.rateUnit !== 'bbl/d' && ds.rateUnit !== 'STB/d') reasons.push('rate unit ' + String(ds.rateUnit).slice(0, 12) + ' is not recognised');
        }
        (C.prep.flags || []).forEach(function (f) { if (f && /REVERS|DUPLIC|UNKNOWN_UNIT/.test(String(f.code))) reasons.push(String(f.text || f.code).slice(0, 80)); });
        for (var k = 1; k < C.n; k++) if (C.t[k] < C.t[k - 1]) { reasons.push('the prepared time is not monotonic'); break; }
        if (reasons.length) return { level: 'fail', value: null, threshold: null, inWindow: true, text: 'Units or time base invalid: ' + reasons.join('; ') + '.' };
        // gaps: an interval longer than gapFactor × the median of its neighbours (log spacing is not a gap)
        var t = C.t, n = C.n, dts = [], gap = 0;
        for (i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
        for (i = 0; i < dts.length; i++) {
            var nb = [];
            for (var j = Math.max(0, i - 3); j <= Math.min(dts.length - 1, i + 3); j++) if (j !== i) nb.push(dts[j]);
            var ref = median(nb);
            if (fin(ref) && ref > 0 && dts[i] > T.gapFactor * ref) gap += dts[i] - ref;
        }
        var span = t[n - 1] - t[0], frac = span > 0 ? gap / span : 0;
        if (frac > T.gapFrac) return { level: 'warn', value: rnd(frac, 4), threshold: T.gapFrac, text: 'Columns mapped and time monotonic, but gaps cover ' + fmt(100 * frac, 1) + ' % of the record (limit ' + fmt(100 * T.gapFrac, 1) + ' %).' };
        return { level: 'pass', value: rnd(frac, 4), threshold: T.gapFrac, text: 'Columns mapped, time monotonic, no significant gaps.' };
    };

    CK.clock = function (C, T) {
        if (!C.q) return { level: 'na', value: null, threshold: T.passS, text: 'No rate record: clock alignment not checked.' };
        var a = getAlign(C);
        if (!a || !a.ok) return { level: 'na', value: null, threshold: T.passS, text: 'Rate and pressure events could not both be found: clock alignment not checked.' };
        var off = a.offsetS, applied = 3600 * (fin(gp(C.prep, 'applied.clockOffsetH', null)) ? C.prep.applied.clockOffsetH : 0);
        if (a.stopS != null && Math.abs(a.stopS - off) > Math.max(T.contradictS, 2 * ((a.uncS || 0) + (a.stopUncS || 0))))
            return { level: 'fail', value: rnd(off, 1), threshold: T.contradictS, inWindow: true,
                     text: 'Events contradict: the rate starts ' + fmt(off, 1) + ' s after the pressure rise but stops ' + fmt(a.stopS, 1) + ' s after the shut-in drop.' };
        var tol = Math.max(T.passS, a.uncS || 0);
        if (Math.abs(off) > tol) {
            var hours = Math.round(off / 3600);
            var tz = hours !== 0 && Math.abs(off - 3600 * hours) < 120 ? ' (a whole number of hours: time zone or daylight saving)' : '';
            return { level: 'warn', value: rnd(off, 1), threshold: T.passS,
                     text: 'Rate events lag the pressure by ' + fmt(off, 1) + ' s' + tz + '; confirm and apply the clock offset before picking events.' };
        }
        if (Math.abs(applied) > T.warnCorrS)
            return { level: 'warn', value: rnd(off, 1), threshold: T.warnCorrS, text: 'Clocks aligned after a correction of ' + fmt(applied, 1) + ' s; the residual offset is ' + fmt(off, 1) + ' s.' };
        return { level: 'pass', value: rnd(off, 1), threshold: T.passS, text: 'Rate and pressure clocks agree within ' + fmt(tol, 1) + ' s (offset ' + fmt(off, 1) + ' s).' };
    };

    function measuredVwCw(C) {
        for (var i = 0; i < C.ramps.length; i++) if (fin(C.ramps[i].VwCwRamp) && C.ramps[i].VwCwRamp > 0) return { v: C.ramps[i].VwCwRamp, src: 'ramp' };
        if (C.ev && fin(C.ev.VwCwMeasured) && C.ev.VwCwMeasured > 0) return { v: C.ev.VwCwMeasured, src: 'events' };
        var a = getAlign(C);
        if (a && a.ok && fin(a.slopePsiPerBbl) && a.slopePsiPerBbl > 0) return { v: 1 / a.slopePsiPerBbl, src: 'record' };
        return null;
    }
    CK.stiffness = function (C, T) {
        var m = measuredVwCw(C);
        if (!m || !C.VwCwTheory) return { level: 'na', value: null, threshold: T.warn, text: !m ? 'No pre-breakdown ramp: wellbore stiffness not checked.' : 'No theory storage (string and fluid inputs): wellbore stiffness not checked.' };
        var r = m.v / C.VwCwTheory;
        C._stiffRatio = r;
        var txt = 'Ramp storage ' + fmt(m.v * 1e4, 3) + 'e-4 bbl/psi is ' + fmt(r, 2) + ' times the theory value';
        if (r > T.fail) return { level: 'fail', value: rnd(r, 3), threshold: T.fail, inWindow: true, text: txt + ': air or gas in the well, a leak, or an open fracture.' };
        if (r > T.warn) return { level: 'warn', value: rnd(r, 3), threshold: T.warn, text: txt + ': the wellbore is softer than expected.' };
        if (r < T.lo) return { level: 'warn', value: rnd(r, 3), threshold: T.lo, text: txt + ': stiffer than theory; check the rate record and the string volume.' };
        return { level: 'pass', value: rnd(r, 3), threshold: T.warn, text: txt + '.' };
    };

    CK.air = function (C, T) {
        var m = measuredVwCw(C), h = C.hammer;
        var known = h && fin(h.VwCwHammer) && h.VwCwHammer > 0 && h.reflectorMatch && h.reflectorMatch !== 'unknown';
        if (!m || !C.VwCwTheory || !known) return { level: 'na', value: null, threshold: T.fail, text: 'The air cross-check needs the ramp storage, the theory value and a hammer period with a known reflector.' };
        var r1 = m.v / C.VwCwTheory, r2 = h.VwCwHammer / C.VwCwTheory, mx = Math.max(r1, r2);
        C._airRatios = [r1, r2];
        var txt = 'Ramp ' + fmt(r1, 2) + ' and hammer ' + fmt(r2, 2) + ' times the theory storage';
        if (r1 > T.fail && r2 > T.fail) return { level: 'fail', value: rnd(Math.min(r1, r2), 3), threshold: T.fail, inWindow: true, text: txt + ': air or gas confirmed by two independent detectors.' };
        if (mx > T.warn) return { level: 'warn', value: rnd(mx, 3), threshold: T.warn, text: txt + ': one detector suggests air or gas; the other does not confirm it.' };
        if (Math.abs(r1 - 1) <= T.pass && Math.abs(r2 - 1) <= T.pass) return { level: 'pass', value: rnd(mx, 3), threshold: T.warn, text: txt + ': both within ' + fmt(100 * T.pass, 0) + ' % of theory.' };
        return { level: 'pass', value: rnd(mx, 3), threshold: T.warn, text: txt + ': no sign of air or gas.' };
    };

    CK.surface = function (C, T) {
        if (!C.pSurf) return { level: 'na', value: null, threshold: T.warnPsig, text: 'No surface pressure channel.' };
        var minPsig = Infinity, tVac = null;
        for (var i = C.iFall; i < C.n; i++) {
            var g = C.pSurf[i] - C.atm;
            if (!fin(g)) continue;
            if (g < minPsig) minPsig = g;
            if (tVac == null && g < T.failPsig) tVac = C.t[i];
        }
        if (!fin(minPsig)) return { level: 'na', value: null, threshold: T.warnPsig, text: 'The surface channel has no data after shut-in.' };
        if (C.src === 'surface-converted') {
            if (tVac != null) return { level: 'fail', value: rnd(minPsig, 1), threshold: T.failPsig, inWindow: false,
                                       excluded: { t0: tVac, t1: C.tEnd, why: 'surface gauge on vacuum: the converted bottomhole pressure is not valid' },
                                       text: 'Surface pressure falls below ' + fmt(T.failPsig, 0) + ' psig at ' + fmt(tVac - C.ts, 2) + ' h of shut-in; the converted data after it are masked.' };
            if (minPsig < T.warnPsig) return { level: 'warn', value: rnd(minPsig, 1), threshold: T.warnPsig, text: 'Surface pressure reaches ' + fmt(minPsig, 1) + ' psig; the column may not stay liquid-supported.' };
            return { level: 'pass', value: rnd(minPsig, 1), threshold: T.warnPsig, text: 'Surface pressure stays above ' + fmt(T.warnPsig, 0) + ' psig throughout.' };
        }
        if (tVac != null) return { level: 'pass', value: rnd(minPsig, 1), threshold: T.warnPsig, text: 'The surface gauge goes on vacuum, but the analysis uses the bottomhole gauge.' };
        return { level: 'pass', value: rnd(minPsig, 1), threshold: T.warnPsig, text: 'Surface pressure stays at or above ' + fmt(minPsig, 1) + ' psig.' };
    };

    // median static surface pressure before pumping (psia), or null
    function staticSurf(C) {
        if (!C.pSurf || C.src !== 'bh') return null;
        var d = [];
        for (var i = 0; i < C.n && C.t[i] < C.tStart; i++) if (fin(C.pw[i]) && fin(C.pSurf[i])) d.push(C.pSurf[i]);
        return d.length ? median(d) : null;
    }
    // model static column p(tvd) − p_s (psi): WTS_wellbore.hydrostatic with the column and the inputs' fluid when present,
    // else 0.052·ρ·TVD. One model for the check and the blunder bands; cached per depth.
    function hydroModel(C, tvd) {
        if (!(tvd > 0)) return NaN;
        C._hydroCache = C._hydroCache || {};
        var key = String(tvd);
        if (Object.prototype.hasOwnProperty.call(C._hydroCache, key)) return C._hydroCache[key];
        var model = C.hydroGrad * tvd, W = G.WTS_wellbore, ps = staticSurf(C);
        if (W && isRealFn(W.hydrostatic) && fin(ps)) {
            try {
                var h = W.hydrostatic(ps, 0, tvd, C.col, null, { fluid: C.fluid });
                if (okRes(h) && fin(h.dp) && h.dp > 0) model = h.dp;
            } catch (e) { /* simple model */ }
        }
        C._hydroCache[key] = model;
        return model;
    }
    // measured static p_w − p_s before pumping (psi), or null
    function staticDiff(C, pwScale, psScale) {
        if (!C.pSurf || C.src !== 'bh') return null;
        var d = [];
        for (var i = 0; i < C.n && C.t[i] < C.tStart; i++) if (fin(C.pw[i]) && fin(C.pSurf[i])) d.push(C.pw[i] * (pwScale || 1) - C.pSurf[i] * (psScale || 1));
        return d.length ? median(d) : null;
    }
    CK.hydrostatic = function (C, T) {
        var meas = staticDiff(C);
        if (meas == null || !C.tvd) return { level: 'na', value: null, threshold: T.warn, text: 'Needs a bottomhole and a surface channel before pumping and the datum TVD.' };
        var model = hydroModel(C, C.tvd);
        var err = Math.abs(meas - model) / model;
        C._hydroErr = err;
        var txt = 'Static p_w - p_s is ' + fmt(meas, 0) + ' psi against ' + fmt(model, 0) + ' psi for the column (' + fmt(100 * err, 1) + ' %)';
        if (err > T.fail) return { level: 'fail', value: rnd(err, 4), threshold: T.fail, inWindow: true, text: txt + ': check the datum depth, the gauge depth and the fluid density.' };
        if (err > T.warn) return { level: 'warn', value: rnd(err, 4), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(err, 4), threshold: T.warn, text: txt + '.' };
    };

    CK.isolation = function (C, T) {
        if (C.hammer && C.hammer.regime && C.hammer.regime !== 'none') return { level: 'pass', value: null, threshold: null, text: 'Water hammer is seen at shut-in, so the gauge sees the well.' };
        var x = [], y = [];
        for (var i = C.iFall; i < C.n; i++) if (fin(C.pw[i])) { x.push(C.t[i] - C.ts); y.push(C.pw[i]); }
        if (x.length < 5) return { level: 'na', value: null, threshold: null, text: 'Too few falloff samples to check the gauge isolation.' };
        var lo = Math.min.apply(null, y), hi = Math.max.apply(null, y), span = x[x.length - 1];
        if (hi - lo < T.flatPsi) return { level: 'fail', value: rnd(hi - lo, 2), threshold: T.flatPsi, inWindow: true, text: 'The falloff is flat (' + fmt(hi - lo, 1) + ' psi over ' + fmt(span, 2) + ' h): is the gauge on the pump side of the valve?' };
        var r = linreg(x, y);
        var early = [], late = [];
        for (i = 0; i < x.length; i++) { if (x[i] <= 0.1 * span) early.push(i); if (x[i] >= 0.5 * span) late.push(i); }
        function rate(ix) { if (ix.length < 2) return NaN; var a = ix[0], b = ix[ix.length - 1]; return (y[a] - y[b]) / (x[b] - x[a]); }
        var re = rate(early), rl = rate(late), ratio = fin(re) && fin(rl) && rl > 0 ? re / rl : NaN;
        if (r && r.r2 >= T.linR2 && fin(ratio) && ratio < T.curvRatio)
            return { level: 'fail', value: rnd(ratio, 3), threshold: T.curvRatio, inWindow: true, text: 'The falloff is a straight-line bleed (R2 ' + fmt(r.r2, 4) + '): is the gauge on the pump side of the valve?' };
        return { level: 'pass', value: fin(ratio) ? rnd(ratio, 3) : null, threshold: T.curvRatio, text: 'The falloff has a decline shape.' };
    };

    function twoLc(C) {
        if (C.hammer && fin(C.hammer.T) && C.hammer.T > 0 && fin(C.hammer.Lquarter) && C.hammer.Lquarter > 0 && fin(C.hammer.c) && C.hammer.c > 0) return 2 * C.hammer.Lquarter / C.hammer.c;
        if (C.md && C.waveSpeed) return 2 * C.md / C.waveSpeed;
        return null;
    }
    function shutinSampling(C) {
        var d = [];
        for (var i = C.iFall; i < Math.min(C.n, C.iFall + 6); i++) if (i > 0) d.push((C.t[i] - C.t[i - 1]) * 3600);
        var m = median(d);
        return fin(m) && m > 0 ? m : null;
    }
    CK.sampling = function (C, T) {
        var per = null;
        if (C.hammer && C.hammer.sampling && fin(C.hammer.sampling.per2Lc)) per = C.hammer.sampling.per2Lc;
        else { var p2 = twoLc(C), dtS = shutinSampling(C); if (p2 && dtS) per = p2 / dtS; }
        if (per == null) return { level: 'na', value: null, threshold: T.pass, text: 'Needs the well depth and wave speed (or a hammer window) to compare the sampling with 2L/c.' };
        var txt = fmt(per, 1) + ' samples per 2L/c';
        if (per < T.fail) return { level: 'fail', value: rnd(per, 2), threshold: T.fail, inWindow: false, text: txt + ': the water hammer cannot be analysed.' };
        if (per < T.pass) return { level: 'warn', value: rnd(per, 2), threshold: T.pass, text: txt + ': the hammer period is resolved only coarsely.' };
        return { level: 'pass', value: rnd(per, 2), threshold: T.pass, text: txt + '.' };
    };

    function closeTimeS(C) {
        if (fin(C.raw.tCloseS) && C.raw.tCloseS >= 0) return C.raw.tCloseS;
        if (!C.q || !(C.qLast > 0)) return null;
        var hiL = 0.95 * C.qLast, loL = 0.05 * C.qLast, i, kd = -1;
        for (i = C.n - 1; i >= 1; i--) if (fin(C.q[i]) && C.q[i] <= loL && C.q[i - 1] > loL) { kd = i; break; }
        if (kd < 1) return null;
        var t1 = C.t[kd - 1] + (C.q[kd - 1] - loL) / (C.q[kd - 1] - C.q[kd]) * (C.t[kd] - C.t[kd - 1]);
        var k0 = kd - 1;
        while (k0 > 0 && C.q[k0] < hiL) k0--;
        var t0;
        if (C.q[k0] >= hiL && C.q[k0 + 1] < hiL) t0 = C.t[k0] + (C.q[k0] - hiL) / (C.q[k0] - C.q[k0 + 1]) * (C.t[k0 + 1] - C.t[k0]);
        else t0 = C.t[k0];
        return Math.max(0, (t1 - t0) * 3600);
    }
    CK.shutin = function (C, T) {
        var p2 = twoLc(C), tc = closeTimeS(C);
        if (p2 == null || tc == null) return { level: 'na', value: null, threshold: null, text: 'Needs the valve closing time and 2L/c.' };
        var Lc = p2 / 2, txt = 'Valve closed in ' + fmt(tc, 1) + ' s against 2L/c = ' + fmt(p2, 1) + ' s';
        if (tc > T.fail * Lc) return { level: 'fail', value: rnd(tc, 2), threshold: rnd(T.fail * Lc, 2), inWindow: false, text: txt + ': the Joukowsky check is off.' };
        if (tc >= T.warn * Lc) return { level: 'warn', value: rnd(tc, 2), threshold: rnd(T.warn * Lc, 2), text: txt + ': the hammer amplitude is reduced.' };
        return { level: 'pass', value: rnd(tc, 2), threshold: rnd(T.warn * Lc, 2), text: txt + '.' };
    };

    CK.stepdown = function (C, T) {
        var st = (C.ev && Array.isArray(C.ev.steps) ? C.ev.steps : []).filter(function (s) { return s && s.dir === 'down' && fin(s.q); });
        if (!st.length) return { level: 'na', value: null, threshold: T.passSteps, text: 'No step-down in the record.' };
        var qs = st.map(function (s) { return s.q; }), qmax = Math.max.apply(null, qs.concat(fin(C.qLast) ? [C.qLast] : [])), qmin = Math.min.apply(null, qs);
        var range = qmax > 0 ? (qmax - qmin) / qmax : 0, n = st.length;
        var txt = n + ' steps over ' + fmt(100 * range, 0) + ' % of the rate range';
        if (n < T.warnSteps || range < T.failRange) return { level: 'fail', value: n, threshold: T.passSteps, inWindow: false, text: txt + ': the friction split is not determinable.' };
        if (n < T.passSteps || range < T.passRange) return { level: 'warn', value: n, threshold: T.passSteps, text: txt + ': the friction split is weakly determined.' };
        return { level: 'pass', value: n, threshold: T.passSteps, text: txt + '.' };
    };

    CK.steprate = function (C, T) {
        var sr = C.stepRate;
        if (!sr || !Array.isArray(sr.steps) || !sr.steps.length) return { level: 'na', value: null, threshold: T.warn, text: 'No step-rate test in the record.' };
        var bad = 0;
        sr.steps.forEach(function (s) { if (s && s.stabilised === false) bad++; });
        if (bad >= T.fail) return { level: 'fail', value: bad, threshold: T.fail, inWindow: false, text: bad + ' steps did not stabilise: the parting pressure is not reliable.' };
        if (bad >= T.warn) return { level: 'warn', value: bad, threshold: T.warn, text: bad + ' step did not stabilise.' };
        return { level: 'pass', value: 0, threshold: T.warn, text: 'Every step stabilised.' };
    };

    CK.friction = function (C, T) {
        var sd = C.stepDown, at = sd && sd.at;
        if (!at || !fin(at.dpPipe) || !(at.dpPipe > 0) || !fin(at.dpPerf) || !(at.dpPerf > 0)) return { level: 'na', value: null, threshold: T.warn, text: 'No pipe friction in the step-down (bottomhole gauge or no step-down).' };
        var r = at.dpPipe / at.dpPerf, txt = 'Pipe friction is ' + fmt(r, 2) + ' times the perforation friction at the top rate';
        if (r > T.fail) return { level: 'fail', value: rnd(r, 3), threshold: T.fail, inWindow: false, text: txt + ': the number of open perforations is not determinable.' };
        if (r >= T.warn) return { level: 'warn', value: rnd(r, 3), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(r, 3), threshold: T.warn, text: txt + '.' };
    };

    function dtAtGmin(C) {
        var d = C.derivs;
        if (!d || !arrLike(d.G) || !fin(d.gMin)) return null;
        for (var i = 0; i < d.G.length; i++) if (d.G[i] >= d.gMin) return d.dt[i];
        return null;
    }
    CK.bleed = function (C, T) {
        var b = C.raw.bleed, t1 = isObj(b) && fin(b.t1psi) ? b.t1psi : null, dtG = dtAtGmin(C);
        if (t1 == null || dtG == null) return { level: 'na', value: null, threshold: null, text: 'Needs the bleed-off prediction and G_min.' };
        var inside = C.picks.filter(function (p) { return p.dt < t1; });
        if (inside.length) return { level: 'fail', value: rnd(inside[0].dt, 4), threshold: rnd(t1, 4), inWindow: true, text: 'A closure pick at ' + fmt(inside[0].dt * 60, 1) + ' min lies inside the bleed-off (1 psi at ' + fmt(t1 * 60, 1) + ' min).' };
        if (dtG >= t1) return { level: 'pass', value: rnd(dtG, 4), threshold: rnd(t1, 4), text: 'G_min at ' + fmt(dtG * 60, 1) + ' min is past the predicted bleed-off (' + fmt(t1 * 60, 1) + ' min).' };
        return { level: 'warn', value: rnd(dtG, 4), threshold: rnd(t1, 4), text: 'G_min at ' + fmt(dtG * 60, 1) + ' min is ' + (dtG >= t1 / T.warn ? 'within ' + fmt(T.warn, 0) + ' times' : 'well before') + ' the predicted bleed-off end (' + fmt(t1 * 60, 1) + ' min).' };
    };

    // rate integral to shut-in with the wellbore fill excluded (Events.Vfill, when finite): the basis of ctx.strapVolume
    function pumpedVolume(C) {
        if (!C.q) return null;
        var v = 0;
        for (var i = 1; i < C.n && C.t[i - 1] < C.ts; i++) {
            var qa = fin(C.q[i - 1]) ? C.q[i - 1] : 0, qb = fin(C.q[i]) ? C.q[i] : 0;
            v += 0.5 * (qa + qb) * (C.t[i] - C.t[i - 1]) * 60;
        }
        if (C.ev && fin(C.ev.Vfill) && C.ev.Vfill > 0 && C.ev.Vfill < v) v -= C.ev.Vfill;
        return v;
    }
    CK.volume = function (C, T) {
        var strap = C.raw.strapVolume, v = pumpedVolume(C);
        if (!fin(strap) || !(strap > 0) || v == null) return { level: 'na', value: null, threshold: T.warn, text: 'No strap or stroke volume entered.' };
        var err = Math.abs(v - strap) / strap, txt = 'Rate integral ' + fmt(v, 1) + ' bbl against ' + fmt(strap, 1) + ' bbl from straps (' + fmt(100 * err, 1) + ' %)';
        if (err > T.fail) return { level: 'fail', value: rnd(err, 4), threshold: T.fail, inWindow: true, text: txt + ': check the rate unit and the meter.' };
        if (err > T.warn) return { level: 'warn', value: rnd(err, 4), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(err, 4), threshold: T.warn, text: txt + '.' };
    };

    CK.temperature = function (C) {
        if (C.T && C.src === 'bh') return { level: 'pass', value: null, threshold: null, text: 'Bottomhole temperature recorded.' };
        if (C.T) return { level: 'warn', value: null, threshold: null, text: 'Only a surface temperature is recorded.' };
        if (C.src === 'surface-converted') return { level: 'fail', value: null, threshold: null, inWindow: false, text: 'No temperature channel with a surface-gauge analysis: the column density cannot be checked.' };
        return { level: 'na', value: null, threshold: null, text: 'No temperature channel; the thermal checks are not run.' };
    };

    // pick window on the record clock: [t at G_min, ts + 1.5 × the latest pick Δt], else after G_min to the end
    function pickWindow(C) {
        var dtG = dtAtGmin(C), t0 = C.ts + (dtG != null ? dtG : 0), t1 = C.tEnd;
        if (C.picks.length) { var mx = 0; C.picks.forEach(function (p) { if (p.dt > mx) mx = p.dt; }); t1 = Math.min(C.tEnd, C.ts + 1.5 * mx); }
        return [t0, t1];
    }
    CK.gaugeThermal = function (C, T) {
        if (!C.T) return { level: 'na', value: null, threshold: T.fail, text: 'No temperature channel.' };
        var dtG = dtAtGmin(C), tFrom = C.ts + (dtG != null ? dtG : 0), win = pickWindow(C), worst = 0, tWorst = null;
        for (var i = C.iFall; i < C.n; i++) {
            if (C.t[i] < tFrom || !fin(C.T[i])) continue;
            var j = i + 1;
            while (j < C.n && (C.t[j] - C.t[i]) * 60 < 1) j++;      // differences over at least one minute
            if (j >= C.n || !fin(C.T[j])) continue;
            var r = Math.abs(C.T[j] - C.T[i]) / ((C.t[j] - C.t[i]) * 60);
            if (r > worst) { worst = r; tWorst = C.t[i]; }
        }
        if (worst > T.fail && tWorst >= win[0] && tWorst <= win[1]) return { level: 'fail', value: rnd(worst, 3), threshold: T.fail, inWindow: true, text: 'Gauge temperature changes ' + fmt(worst, 2) + ' F/min inside the pick window.' };
        if (worst > T.fail) return { level: 'warn', value: rnd(worst, 3), threshold: T.fail, text: 'Gauge temperature changes ' + fmt(worst, 2) + ' F/min, outside the pick window.' };
        return { level: 'pass', value: rnd(worst, 3), threshold: T.fail, text: 'Gauge temperature settles below ' + fmt(T.fail, 1) + ' F/min after G_min.' };
    };

    CK.noise = function (C, T) {
        var d = C.derivs;
        if (!d || !arrLike(d.GdPdG) || d.GdPdG.length < 9) return { level: 'na', value: null, threshold: T.warn, text: 'No derivatives.' };
        var y = d.GdPdG, n = y.length, ref = -1, i;
        var votes = C.picks.filter(function (p) { return p.vote && fin(p.G); });
        var Gt = votes.length ? median(votes.map(function (p) { return p.G; })) : NaN;
        if (fin(Gt)) { var bd = Infinity; for (i = 0; i < n; i++) if (fin(d.G[i]) && Math.abs(d.G[i] - Gt) < bd) { bd = Math.abs(d.G[i] - Gt); ref = i; } }
        var lo, hi;
        if (ref >= 0) { lo = Math.max(0, ref - 10); hi = Math.min(n - 1, ref + 10); }
        else { lo = 0; while (lo < n && !(d.G[lo] >= d.gMin)) lo++; hi = n - 1; }
        var rel = [];
        for (i = lo; i <= hi; i++) {
            if (!fin(y[i])) continue;
            var w = [];
            for (var k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (fin(y[k])) w.push(y[k]);
            var s = median(w);
            if (fin(s) && s > 0) rel.push((y[i] - s) / s);
        }
        if (rel.length < 5) return { level: 'na', value: null, threshold: T.warn, text: 'Too few derivative points near the pick.' };
        var sd = mad(rel);
        var txt = 'Derivative noise ' + (ref >= 0 ? 'at the pick' : 'after G_min') + ' is ' + fmt(100 * sd, 1) + ' % of G dP/dG';
        if (sd > T.fail) return { level: 'fail', value: rnd(sd, 4), threshold: T.fail, inWindow: true, text: txt + ': widen the window L or check the gauge.' };
        if (sd > T.warn) return { level: 'warn', value: rnd(sd, 4), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(sd, 4), threshold: T.warn, text: txt + '.' };
    };

    // residuals from a local quadratic in ln Δt over ±0.05 decade (at least 5 points); the same linear filter on p and T
    function localResid(x, y) {
        var n = x.length, out = new Array(n), lx = x.map(function (v) { return Math.log(v); }), hw = 0.05 * Math.LN10;
        for (var i = 0; i < n; i++) {
            var a = i, b = i;
            while (a > 0 && lx[i] - lx[a - 1] <= hw) a--;
            while (b < n - 1 && lx[b + 1] - lx[i] <= hw) b++;
            while (b - a + 1 < 5 && (a > 0 || b < n - 1)) { if (a > 0) a--; if (b < n - 1 && b - a + 1 < 5) b++; }
            // quadratic least squares about lx[i]
            var S = [0, 0, 0, 0, 0], R = [0, 0, 0];
            for (var k = a; k <= b; k++) {
                var u = lx[k] - lx[i], u2 = u * u;
                S[0] += 1; S[1] += u; S[2] += u2; S[3] += u2 * u; S[4] += u2 * u2;
                R[0] += y[k]; R[1] += u * y[k]; R[2] += u2 * y[k];
            }
            var M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
            var det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
            if (!(Math.abs(det) > 1e-30)) { out[i] = 0; continue; }
            var c0 = (R[0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (R[1] * M[2][2] - M[1][2] * R[2]) + M[0][2] * (R[1] * M[2][1] - M[1][1] * R[2])) / det;
            out[i] = y[i] - c0;
        }
        return out;
    }
    CK.thermal = function (C, T) {
        if (!C.T) return { level: 'na', value: null, threshold: T.warn, text: 'No temperature channel.' };
        var win = pickWindow(C), x = [], yp = [], yt = [];
        for (var i = C.iFall; i < C.n; i++) if (C.t[i] >= win[0] && C.t[i] <= win[1] && fin(C.pw[i]) && fin(C.T[i]) && C.t[i] > C.ts) { x.push(C.t[i] - C.ts); yp.push(C.pw[i]); yt.push(C.T[i]); }
        if (x.length < T.minN) return { level: 'na', value: null, threshold: T.warn, text: 'Too few samples with temperature in the pick window.' };
        var rp0 = localResid(x, yp), rt0 = localResid(x, yt), lim = 3 * mad(rt0), rp = [], rt = [];
        // only samples whose temperature departs from its trend by more than 3 robust sigmas carry a thermal signal;
        // rank correlation, so a few residuals of a kink (closure, a step) cannot dominate it
        for (i = 0; i < x.length; i++) if (Math.abs(rt0[i]) > lim) { rp.push(rp0[i]); rt.push(rt0[i]); }
        if (rp.length < Math.max(5, T.minN / 2)) return { level: 'pass', value: 0, threshold: T.warn, text: 'No thermal signal in the pick window beyond the temperature noise.' };
        var r = corr(ranks(rt), ranks(rp)), reg = linreg(rt, rp);
        if (!fin(r)) return { level: 'pass', value: 0, threshold: T.warn, text: 'Detrended pressure and temperature are uncorrelated.' };
        var a = Math.abs(r), txt = 'Detrended pressure and temperature correlate at r = ' + fmt(r, 2) + (reg ? ' (dp/dT ' + fmt(reg.b, 2) + ' psi/F)' : '');
        if (a > T.fail) return { level: 'fail', value: rnd(a, 3), threshold: T.fail, inWindow: true, text: txt + ' inside the pick window: thermal effects on the gauge or the column.' };
        if (a > T.warn) return { level: 'warn', value: rnd(a, 3), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(a, 3), threshold: T.warn, text: txt + '.' };
    };

    CK.sink = function (C, T) {
        var cl = C.raw.classification, d = C.derivs;
        if (cl && cl.features && cl.features.unitSlopeSink === true) return { level: 'warn', value: null, threshold: T.cycles, text: 'Constant-rate sink (leak?): unit log-log slope before closure; see the leak plot and the annulus check.' };
        if (!d || !arrLike(d.D) || !arrLike(d.dt) || !arrLike(d.dtD)) return { level: 'na', value: null, threshold: T.cycles, text: 'No derivatives.' };
        var dtc = Infinity;
        var votes = C.picks.filter(function (p) { return p.vote; });
        if (votes.length) dtc = median(votes.map(function (p) { return p.dt; }));
        var best = 0, runStart = null, prev = null, n = d.dt.length;
        for (var i = 0; i < n; i++) {
            if (!(d.dtD[i] >= T.dtDmin) || !(d.dt[i] < dtc) || !fin(d.D[i]) || !(d.D[i] > 0)) { runStart = null; prev = null; continue; }
            if (prev == null) { prev = i; continue; }
            // slope over a span of at least 0.05 decade
            if (Math.log(d.dt[i] / d.dt[prev]) / Math.LN10 < 0.05) continue;
            var s = Math.log(d.D[i] / d.D[prev]) / Math.log(d.dt[i] / d.dt[prev]);
            if (s >= T.slopeMin && s <= T.slopeMax) {
                if (runStart == null) runStart = prev;
                var cyc = Math.log(d.dt[i] / d.dt[runStart]) / Math.LN10;
                if (cyc > best) best = cyc;
            } else runStart = null;
            prev = i;
        }
        if (best >= T.cycles) return { level: 'warn', value: rnd(best, 3), threshold: T.cycles, text: 'Constant-rate sink (leak?): unit log-log slope over ' + fmt(best, 2) + ' log cycles before closure; see the leak plot and the annulus check.' };
        return { level: 'pass', value: rnd(best, 3), threshold: T.cycles, text: 'No constant-rate sink before closure.' };
    };

    CK.tides = function (C, T) {
        var td = C.raw.tide;
        if (!isObj(td) || !fin(td.ampPsi)) return { level: 'na', value: null, threshold: T.warn, text: 'No tidal or barometric analysis.' };
        if (td.removed === true) return { level: 'pass', value: null, threshold: T.warn, text: 'Tidal and barometric signal removed.' };
        var dp = fin(td.dpPsi) && td.dpPsi > 0 ? td.dpPsi : null;
        if (!dp) return { level: 'na', value: null, threshold: T.warn, text: 'No after-closure pressure change to compare the tide with.' };
        var f = td.ampPsi / dp, txt = 'Tidal amplitude ' + fmt(td.ampPsi, 2) + ' psi is ' + fmt(100 * f, 0) + ' % of the after-closure change';
        if (f > T.fail) return { level: 'fail', value: rnd(f, 3), threshold: T.fail, inWindow: true, text: txt + ': remove it before the after-closure analysis.' };
        if (f > T.warn) return { level: 'warn', value: rnd(f, 3), threshold: T.warn, text: txt + '.' };
        return { level: 'pass', value: rnd(f, 3), threshold: T.warn, text: txt + '.' };
    };

    CK.annulus = function (C, T) {
        var ds = C.ds, pa = ds && arrLike(ds.pAnn) ? ds.pAnn : null, idx = C.prep.idx;
        if (!pa || !arrLike(idx)) return { level: 'na', value: null, threshold: T.dpMin, text: 'No annulus pressure channel.' };
        var base = [], x = [], y = [], mx = -Infinity, tp = C.ts - C.tStart;
        for (var i = 0; i < C.n; i++) {
            var v = pa[idx[i]];
            if (!fin(v)) continue;
            if (C.t[i] < C.tStart) base.push(v);
            if (C.t[i] >= C.tStart && C.t[i] <= C.ts && v > mx) mx = v;
            if (C.t[i] >= C.tStart - tp && C.t[i] <= C.ts + tp && C.q) { x.push(fin(C.q[i]) ? C.q[i] : 0); y.push(v); }
        }
        if (!base.length || !fin(mx)) return { level: 'na', value: null, threshold: T.dpMin, text: 'The annulus channel does not cover the start of pumping.' };
        var b0 = median(base), sd = mad(base), rise = mx - b0, r = x.length > 3 ? corr(x, y) : NaN;
        if (rise > Math.max(T.dpMin, 5 * (fin(sd) ? sd : 0)) && (!fin(r) || r > T.corr))
            return { level: 'fail', value: rnd(rise, 1), threshold: T.dpMin, inWindow: true, text: 'Annulus pressure rises ' + fmt(rise, 0) + ' psi with pumping: communication behind the pipe or a packer leak.' };
        return { level: 'pass', value: rnd(rise, 1), threshold: T.dpMin, text: 'No annulus response to pumping (' + fmt(rise, 1) + ' psi).' };
    };

    // ═══════════════════════════════════════════════════════════════════════
    // blunder library (rule flags on the well's own bands; Bayes factors are on the slip list: bf null)
    // ═══════════════════════════════════════════════════════════════════════
    function bands(C, o) {
        // o: {f (pressure factor on p), off (psi), tvd} → {isip:bool|null, hydro:bool|null}
        var B = thr(C, 'blunders'), tvd = o.tvd || C.tvd, f = o.f || 1, off = o.off || 0, res = { isip: null, hydro: null };
        if (tvd && fin(C.isipVal)) {
            var g = (C.isipVal * f + off) / tvd;
            res.grad = g;
            res.isip = g >= C.piGrad - 1e-9 && g <= C.svGrad + B.sigmaVPlus;
        }
        if (tvd && o.hydro !== false) {
            var meas = staticDiff(C, f, 1);
            if (meas != null) { var model = hydroModel(C, tvd); res.hydroErr = Math.abs(meas + off - model) / model; res.hydro = res.hydroErr <= B.hydro; }
        }
        return res;
    }
    function allPass(b) { return b.isip !== false && b.hydro !== false && (b.isip === true || b.hydro === true); }
    function anyFail(b) { return b.isip === false || b.hydro === false; }
    function curUnitFix(C, ch) { var v = gp(C.inputs, 'channels.unitFix.' + ch, null); return v === undefined ? null : v; }
    function rawChannel(C, ch) {
        if (C.ds && arrLike(C.ds[ch])) return { arr: C.ds[ch], t: C.ds.t, raw: true };
        if (ch === 'p') return { arr: C.pw, t: C.t, raw: false };
        if (ch === 'pSurf' && C.pSurf) return { arr: C.pSurf, t: C.t, raw: false };
        return null;
    }

    function blundersCore(C) {
        var B = thr(C, 'blunders'), out = [], base = bands(C, {});
        // 1. psig read as psia (per channel): the source unit flag, or a reading within ±2 psi of zero before pressure-up
        ['p', 'pSurf'].forEach(function (ch) {
            if (gp(C.inputs, 'channels.psig.' + ch, false) === true) return;
            if (gp(C.ds, 'meta.psigConverted.' + ch, null) != null) return;
            var flag = false, near = false, why = [];
            var mu = gp(C.ds, 'meta.unit', null), mus = gp(C.ds, 'meta.units.' + ch, null);
            if ((ch === 'p' && mu === 'psig') || mus === 'psig') { flag = true; why.push('the source marks the channel psig'); }
            var rc = rawChannel(C, ch);
            if (rc) {
                var pre = [];
                for (var i = 0; i < rc.arr.length && rc.t[i] < C.tStart; i++) if (fin(rc.arr[i])) pre.push(rc.arr[i]);
                var m = median(pre);
                if (pre.length && fin(m) && Math.abs(m) <= B.psigZero) { near = true; why.push('it reads ' + fmt(m, 1) + ' psi with the well open before pressure-up'); }
            }
            if (!flag && !near) return;
            out.push({ id: 'psig-' + ch, hypothesis: (ch === 'p' ? 'Primary' : 'Surface') + ' pressure recorded in psig but read as psia', score: flag && near ? 1 : 0.8, bf: null,
                       fix: { field: 'channels.psig.' + ch, from: false, to: true },
                       text: clampTxt('Psig read as psia: ' + why.join(' and ') + '. Apply fix adds ' + fmt(C.atm, 3) + ' psi to the channel (dataset unchanged).') });
        });
        // 2. kPa / bar / MPa read as psi (primary channel)
        if (base.isip === false || base.hydro === false) {
            var bestU = null;
            [['kPa', 0.145038], ['bar', 14.5038], ['MPa', 145.038]].forEach(function (u) {
                var b = bands(C, { f: u[1] });
                if (allPass(b) && (!bestU || Math.abs(Math.log(b.grad / 0.75)) < Math.abs(Math.log(bestU.b.grad / 0.75)))) bestU = { u: u, b: b };
            });
            if (bestU) out.push({ id: 'unit-' + bestU.u[0], hypothesis: 'Pressure recorded in ' + bestU.u[0] + ' but read as psi', score: 1, bf: null,
                                  fix: { field: 'channels.unitFix.p', from: curUnitFix(C, 'p'), to: { kind: bestU.u[0] + '->psi', factor: bestU.u[1], offset: 0 } },
                                  text: clampTxt('The ISIP gradient ' + fmt(base.grad, 3) + ' psi/ft is outside the band; read as ' + bestU.u[0] + ' it is ' + fmt(bestU.b.grad, 3) + ' psi/ft.') });
        }
        // 3. MD used as TVD (deviated survey)
        var sv = Array.isArray(C.inputs.survey) ? C.inputs.survey.filter(function (r) { return Array.isArray(r) && fin(r[0]) && fin(r[1]); }) : [];
        if (C.tvd && sv.length >= 2 && (C.inputs.datumMd == null || C.inputs.datumMd === C.tvd)) {
            var mdA = sv.map(function (r) { return r[0]; }), tvA = sv.map(function (r) { return r[1]; });
            if (C.tvd <= mdA[mdA.length - 1] * 1.0001) {
                var tvd2 = interp(mdA, tvA, C.tvd);
                if (fin(tvd2) && Math.abs(tvd2 - C.tvd) > 0.01 * C.tvd) {
                    var b2 = bands(C, { tvd: tvd2 });
                    if (anyFail(base) && allPass(b2)) out.push({ id: 'md-as-tvd', hypothesis: 'Measured depth entered as the datum TVD', score: 1, bf: null,
                        fix: { field: 'datumTvd', from: C.tvd, to: rnd(tvd2, 1), also: [{ field: 'datumMd', from: C.inputs.datumMd == null ? null : C.inputs.datumMd, to: C.tvd }] },
                        text: clampTxt('The datum ' + fmt(C.tvd, 0) + ' ft looks like MD: the survey gives TVD ' + fmt(tvd2, 0) + ' ft, which ' + (b2.hydro ? 'matches the static column' : 'puts the ISIP gradient in the band') + '.') });
                }
            }
        }
        // 4. gauge depth used as datum (the pressure is at the gauge, not referred to the datum)
        var gTvd = gp(C.inputs, 'gauge.bhTvd', null);
        if (C.tvd && fin(gTvd) && Math.abs(gTvd - C.tvd) > 10 && base.hydro === false && C.inputs.channels && C.inputs.channels.depthFix == null) {
            var b3 = bands(C, { tvd: gTvd, hydro: true });
            if (b3.hydro === true) {
                var dpShift = hydroModel(C, C.tvd) - hydroModel(C, gTvd);
                out.push({ id: 'gauge-as-datum', hypothesis: 'Gauge pressure used as the datum pressure', score: 1, bf: null,
                           fix: { field: 'channels.depthFix', from: null, to: { kind: 'gauge-to-datum', fromTvd: gTvd, toTvd: C.tvd, dpPsi: rnd(dpShift, 2) } },
                           text: clampTxt('The static column matches the gauge depth ' + fmt(gTvd, 0) + ' ft, not the datum ' + fmt(C.tvd, 0) + ' ft: refer the pressure to the datum (' + fmt(dpShift, 1) + ' psi).') });
            }
        }
        // 5. time unit s / min / h (pump time outside 1–60 min)
        var tpMin = C.ev && C.ev.tp && fin(C.ev.tp.pump) ? C.ev.tp.pump * 60 : (fin(C.ts) && fin(C.tStart) ? (C.ts - C.tStart) * 60 : NaN);
        if (fin(tpMin) && tpMin > 0 && (tpMin < B.pumpMinLo || tpMin > B.pumpMinHi)) {
            var cand = [[1 / 60, 'min read as h'], [1 / 3600, 's read as h'], [60, 'h read as min'], [3600, 'h read as s']], bestT = null;
            cand.forEach(function (c) { var v = tpMin * c[0]; if (v >= B.pumpMinLo && v <= B.pumpMinHi) { var d = Math.abs(Math.log(v / 8)); if (!bestT || d < bestT.d) bestT = { c: c, d: d, v: v }; } });
            if (bestT) out.push({ id: 'time-unit', hypothesis: 'Time unit ' + bestT.c[1], score: 1, bf: null,
                                  fix: { field: 'channels.unitFix.t', from: curUnitFix(C, 't'), to: { kind: bestT.c[1].replace(/ /g, '-'), factor: bestT.c[0], offset: 0 } },
                                  text: clampTxt('The pump time ' + fmt(tpMin, 1) + ' min is outside ' + fmt(B.pumpMinLo, 0) + '-' + fmt(B.pumpMinHi, 0) + ' min; with the time ' + bestT.c[1] + ' it is ' + fmt(bestT.v, 1) + ' min.') });
        }
        // 6. bbl/d ↔ bbl/min (× 1440): volume vs straps, else the ramp-implied rate vs the recorded rate
        var vol = pumpedVolume(C), strap = C.raw.strapVolume, rf = null, rWhy = '';
        if (fin(strap) && strap > 0 && vol != null && vol > 0) {
            var ratio = vol / strap;
            if (Math.abs(ratio / 1440 - 1) <= B.volTol) { rf = 1 / 1440; rWhy = 'the rate integral is 1440 times the strap volume'; }
            else if (Math.abs(ratio * 1440 - 1) <= B.volTol) { rf = 1440; rWhy = 'the rate integral is 1/1440 of the strap volume'; }
        } else if (C.VwCwTheory && C.q) {
            var a = getAlign(C);
            if (a && a.ok && fin(a.slopePsiPerBbl) && a.slopePsiPerBbl > 0) {
                var rr = (1 / a.slopePsiPerBbl) / C.VwCwTheory;     // implied storage / theory = recorded volume scale
                if (rr / 1440 < B.rampRatioTol && rr / 1440 > 1 / B.rampRatioTol) { rf = 1 / 1440; rWhy = 'the ramp needs 1/1440 of the recorded volume for the theory storage'; }
                else if (rr * 1440 < B.rampRatioTol && rr * 1440 > 1 / B.rampRatioTol) { rf = 1440; rWhy = 'the ramp needs 1440 times the recorded volume for the theory storage'; }
            }
        }
        if (rf != null) out.push({ id: 'rate-unit', hypothesis: rf < 1 ? 'Rate in bbl/d read as bbl/min' : 'Rate in bbl/min read as bbl/d', score: 1, bf: null,
                                   fix: { field: 'channels.unitFix.q', from: curUnitFix(C, 'q'), to: { kind: rf < 1 ? 'bbl/d->bbl/min' : 'bbl/min->bbl/d', factor: rf, offset: 0 } },
                                   text: clampTxt('Rate unit: ' + rWhy + '; Apply fix scales the rate by ' + (rf < 1 ? '1/1440' : '1440') + '.') });
        // 7. ± 1 h clock
        if (C.q) {
            var al = getAlign(C);
            if (al && al.ok && Math.abs(al.offsetS) > 1800) {
                var hrs = Math.round(al.offsetS / 3600);
                if (hrs !== 0 && Math.abs(al.offsetS - 3600 * hrs) <= B.hourTolS) {
                    var cur = fin(gp(C.inputs, 'channels.clockOffsetH', null)) ? C.inputs.channels.clockOffsetH : 0;
                    out.push({ id: 'clock-hour', hypothesis: 'Rate logger clock off by ' + Math.abs(hrs) + ' h (time zone or daylight saving)', score: 1, bf: null,
                               fix: { field: 'channels.clockOffsetH', from: cur, to: rnd(cur - al.offsetS / 3600, 6) },
                               text: clampTxt('The rate events lag the pressure by ' + fmt(al.offsetS / 3600, 3) + ' h, a whole number of hours.') });
                }
            }
        }
        out.sort(function (a, b) { return b.score - a.score; });
        return out;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // re-pump verdict (advisory; first hour; needs an acknowledgement in the UI)
    // ═══════════════════════════════════════════════════════════════════════
    function checkOf(triage, id) {
        var a = triage && Array.isArray(triage.checks) ? triage.checks : [];
        for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i];
        return null;
    }
    function repumpCore(triage, C) {
        var R = thr(C, 'repump'), B = thr(C, 'blunders'), rules = [], g = C.gradIsip;
        function add(id, level, text) { rules.push({ id: id, level: level, text: clampTxt(text) }); }
        // R1 breakdown and the overburden
        var pb = C.ev && fin(C.ev.pb) ? C.ev.pb : NaN;
        var broke = fin(pb) && fin(C.pLast) && pb - C.pLast > Math.max(R.breakdownPsi, 0.02 * pb);
        if (g == null) add('R1', 'pass', 'Datum TVD missing: the ISIP gradient rules are not assessed.');
        else if (!broke && g >= C.svGrad) add('R1', 'warn', 'No breakdown and the ISIP gradient ' + fmt(g, 3) + ' psi/ft is at or above the overburden ' + fmt(C.svGrad, 3) + ' psi/ft: possible horizontal fracture or no fracture.');
        else add('R1', 'pass', broke ? 'Breakdown seen at ' + fmt(pb, 0) + ' psia.' : 'No distinct breakdown, but the ISIP gradient is below the overburden.');
        // R2 ISIP gradient band
        if (g != null) {
            var lo = C.piGrad, hi = C.svGrad + B.sigmaVPlus;
            if (g < lo - 1e-9 || g > hi) {
                // downgraded to a warning when the violated bound is a generic prior (§6.3)
                var below = g < lo - 1e-9, gen = below ? C.piGeneric : C.svGeneric;
                var note = gen ? (below ? ' (generic prior: p_i gradient from the fluid hydrostatic)' : ' (generic prior: overburden ' + fmt(C.svGrad, 2) + ' psi/ft by default, not entered)') : '';
                add('R2', gen ? 'warn' : 'fail', 'ISIP gradient ' + fmt(g, 3) + ' psi/ft lies ' + (below ? 'below' : 'above') + ' the band ' + fmt(lo, 3) + '-' + fmt(hi, 3) + ' psi/ft: a unit or depth blunder, or not a fracture' + note + '.');
            } else add('R2', 'pass', 'ISIP gradient ' + fmt(g, 3) + ' psi/ft lies between the pore (' + fmt(lo, 3) + ') and overburden (' + fmt(hi, 3) + ') gradients.');
        }
        // R3 near-wellbore (tortuosity) loss
        if (C.sigmaGrad != null && C.tvd && fin(C.isipVal) && fin(C.pLast)) {
            var pipe = C.src === 'surface-converted' && C.stepDown && C.stepDown.at && fin(C.stepDown.at.dpPipe) ? C.stepDown.at.dpPipe : 0;
            var dNwb = C.pLast - C.isipVal - pipe, ref = C.isipVal - C.sigmaGrad * C.tvd;
            if (ref > 0 && dNwb > R.nwbFrac * ref) add('R3', 'warn', 'Near-wellbore loss ' + fmt(dNwb, 0) + ' psi exceeds ' + fmt(100 * R.nwbFrac, 0) + ' % of the net pressure ' + fmt(ref, 0) + ' psi: tortuosity dominated; re-pump at a higher rate or with a viscous pill.');
            else add('R3', 'pass', 'Near-wellbore loss ' + fmt(dNwb, 0) + ' psi is not dominant.');
        }
        // R4 air or gas in the well
        var st = checkOf(triage, 'stiffness'), air = checkOf(triage, 'air');
        var r1 = C._stiffRatio != null ? C._stiffRatio : (st && st.level !== 'na' && fin(st.value) ? st.value : null);
        if (r1 != null && r1 > R.vwcw) {
            var both = C._airRatios ? C._airRatios[1] > R.vwcw : (air && air.level === 'fail');
            add('R4', both ? 'fail' : 'warn', 'Measured storage is ' + fmt(r1, 2) + ' times the theory value' + (both ? ', confirmed by the hammer: air or gas in the well; circulate and re-pump.' : '; the hammer does not confirm air or gas.'));
        } else if (r1 != null) add('R4', 'pass', 'Measured storage ' + fmt(r1, 2) + ' times the theory value.');
        // R5 closure visibility
        var rvis = gp(C.raw, 'classification.features.Rvis', null);
        if (!fin(rvis)) rvis = gp(C.raw, 'frac.Rvis', null);
        if (fin(rvis)) {
            if (rvis < R.rvisLo || (rvis < R.rvisHi && r1 != null && r1 > R.vwcw)) add('R5', 'warn', 'Storage-consistent closure visibility ' + fmt(rvis, 2) + ': closure may be invisible.');
            else add('R5', 'pass', 'Closure visibility ' + fmt(rvis, 2) + '.');
        }
        // R6 Joukowsky
        var jr = C.hammer && C.hammer.joukowsky && fin(C.hammer.joukowsky.ratio) ? C.hammer.joukowsky.ratio : null;
        if (jr != null) {
            if (Math.abs(jr - 1) > R.jouk) add('R6', 'warn', 'Hammer amplitude is ' + fmt(jr, 2) + ' times the Joukowsky value: check the rate record or the valve.');
            else add('R6', 'pass', 'Hammer amplitude matches the Joukowsky value (' + fmt(jr, 2) + ').');
        }
        // R7 designer minimum volume
        var vmin = C.plan ? (fin(C.plan.Vmin) ? C.plan.Vmin : gp(C.plan, 'summary.Vmin', null)) : null;
        var vf = C.ev && fin(C.ev.ViFrac) ? C.ev.ViFrac : null;
        if (fin(vmin) && vf != null) {
            if (vf < vmin) add('R7', 'fail', 'Volume into the fracture ' + fmt(vf, 1) + ' bbl is below the designed minimum ' + fmt(vmin, 1) + ' bbl.');
            else add('R7', 'pass', 'Volume into the fracture ' + fmt(vf, 1) + ' bbl meets the designed minimum ' + fmt(vmin, 1) + ' bbl.');
        }
        var hardFail = rules.some(function (r) { return r.level === 'fail' && (r.id === 'R2' || r.id === 'R4' || r.id === 'R7'); });
        var nWarn = rules.filter(function (r) { return r.level === 'warn' || r.level === 'fail'; }).length;
        var verdict = hardFail || nWarn >= 2 ? 'repump' : (nWarn === 1 ? 'caution' : 'continue');
        return { verdict: verdict, rules: rules, ack: false };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // grade A–D
    // ═══════════════════════════════════════════════════════════════════════
    var LRANK = { high: 3, medium: 2, low: 1 };
    function gradeCore(triage, consensus, aca, opts) {
        var why = [], light = triage && triage.light, verdict = triage && triage.verdict;
        var checks = triage && Array.isArray(triage.checks) ? triage.checks : [];
        var failIn = checks.filter(function (c) { return c.level === 'fail' && c.inWindow !== false; });
        var failOut = checks.filter(function (c) { return c.level === 'fail' && c.inWindow === false; });
        var rp = triage && triage.repump ? triage.repump.verdict : 'continue';
        if (verdict === 'uninterpretable') return { letter: 'D', why: ['Triage: the record is uninterpretable.'] };
        if (rp === 'repump') return { letter: 'D', why: ['The re-pump verdict says re-pump.'] };
        var mode = null, label = null;
        if (isObj(consensus) && consensus.ok !== false) {
            mode = consensus.mode || null;
            label = consensus.confidence || consensus.label || null;
            if (label === 'stale' || label === 'not-estimable') label = mode === 'none' ? 'not-estimable' : (label === 'stale' ? null : label);
        }
        var piLabel = isObj(aca) && aca.ok !== false && aca.pi ? aca.pi.label : null;
        var closureOnly = !!(opts && opts.closureOnly);
        var c = [];
        if (failIn.length) c.push('a failed check inside an analysed window (' + failIn.map(function (x) { return x.title; }).join(', ') + ')');
        if (failOut.length) c.push('a failed check outside the analysed windows (' + failOut.map(function (x) { return x.title; }).join(', ') + ')');
        if (verdict === 'partly') c.push('the record is partly interpretable');
        if (mode === 'none') c.push('closure is not estimable');
        else if (label === 'low') c.push('the closure label is low');
        if (c.length) return { letter: 'C', why: [clampTxt('Grade C: ' + c.join('; ') + '.')] };
        if (mode == null) {
            // triage-only grade (closure and p_i not yet graded)
            if (light === 'green') return { letter: 'A', why: ['Triage green; closure and p_i not graded yet.'] };
            return { letter: 'B', why: ['Triage amber; closure and p_i not graded yet.'] };
        }
        var piOk = (piLabel && LRANK[piLabel] >= 2) || closureOnly;
        if (light === 'green' && mode === 'single' && (label === 'high' || label === 'medium') && piOk)
            return { letter: 'A', why: [clampTxt('Triage green; closure single with label ' + label + '; ' + (closureOnly && !(piLabel && LRANK[piLabel] >= 2) ? 'designed outcome closure only.' : 'p_i label ' + piLabel + '.'))] };
        if (light !== 'green') why.push('triage ' + (light || 'not run'));
        if (mode === 'range') why.push('closure a range');
        else if (label) why.push('closure label ' + label);
        if (!piOk) why.push('p_i label ' + (piLabel || 'not available'));
        return { letter: 'B', why: [clampTxt('Grade B: ' + why.join('; ') + '.')] };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // public functions
    // ═══════════════════════════════════════════════════════════════════════
    function validPrep(prep) {
        if (!isObj(prep) || prep.ok === false) return 'prep';
        if (!arrLike(prep.t) || !arrLike(prep.pw) || prep.t.length < 3 || prep.t.length !== prep.pw.length) return 'prep.t';
        return null;
    }
    function inWin(t, w) { return t >= w[0] && t <= w[1]; }
    function salvageFor(C, checks, usable, excluded) {
        var s = [];
        usable.forEach(function (w) { s.push(clampTxt('Use ' + fmt(w[0] - C.ts, 2) + '-' + fmt(w[1] - C.ts, 2) + ' h of shut-in for closure' + (w[1] >= C.tEnd - 1e-9 ? ' and after-closure analysis.' : '.'))); });
        excluded.forEach(function (x) { s.push(clampTxt('Data after ' + fmt(x.t0 - C.ts, 2) + ' h of shut-in are excluded: ' + x.why + '.')); });
        if (excluded.some(function (x) { return x.t1 >= C.tEnd - 1e-9; }) && C.src === 'surface-converted') s.push('p_i not observable from this gauge.');
        checks.forEach(function (c) { if (c.level === 'fail' && c.inWindow !== false) s.push(clampTxt('Fix before analysis: ' + c.title.toLowerCase() + '.')); });
        return s;
    }

    function triage(prep, events, ctx) {
        try {
            var bad = validPrep(prep);
            if (bad) return failure('BAD_PREPARED', ['Triage needs a prepared record (t and pw of equal length, at least three samples).'], [bad]);
            var C = buildCtx(prep, events, ctx), checks = [], excluded = [];
            CHECKS.forEach(function (row) {
                var r;
                try { r = CK[row[0]](C, thr(C, row[0])); }
                catch (e) { r = { level: 'na', value: null, threshold: null, text: 'Check not run (internal error).' }; }
                var item = { id: row[0], title: row[2], level: r.level, value: (fin(r.value) || typeof r.value === 'string') ? r.value : null,
                             threshold: (fin(r.threshold) || typeof r.threshold === 'string') ? r.threshold : null, text: clampTxt(r.text), ev: [row[1]] };
                if (r.level === 'fail') item.inWindow = r.inWindow !== false;
                if (r.excluded) excluded.push({ t0: r.excluded.t0, t1: r.excluded.t1, why: clampTxt(r.excluded.why) });
                checks.push(item);
            });
            // usable windows: the falloff minus the excluded spans
            var usable = [[C.ts, C.tEnd]];
            excluded.forEach(function (x) {
                var next = [];
                usable.forEach(function (w) {
                    if (x.t1 <= w[0] || x.t0 >= w[1]) { next.push(w); return; }
                    if (x.t0 > w[0]) next.push([w[0], x.t0]);
                    if (x.t1 < w[1]) next.push([x.t1, w[1]]);
                });
                usable = next;
            });
            usable = usable.filter(function (w) { return w[1] > w[0]; });
            var blunders = [];
            try { blunders = blundersCore(C); } catch (e) { blunders = []; }
            var failIn = checks.some(function (c) { return c.level === 'fail' && c.inWindow; });
            var failAny = checks.some(function (c) { return c.level === 'fail'; });
            var warnAny = checks.some(function (c) { return c.level === 'warn'; });
            var critical = checks.some(function (c) { return c.level === 'fail' && CRITICAL[c.id]; });
            var light = failIn ? 'red' : ((failAny || warnAny || blunders.length) ? 'amber' : 'green');
            var verdict = (critical || !usable.length) ? 'uninterpretable' : ((failAny || excluded.length || blunders.length) ? 'partly' : 'interpretable');
            var out = { ok: true, version: VERSION, light: light, verdict: verdict, checks: checks,
                        windows: { usable: usable, excluded: excluded }, blunders: blunders,
                        repump: { verdict: 'continue', rules: [], ack: false }, grade: { letter: 'D', why: [] }, salvage: [], ev: ['Q0'] };
            out.repump = repumpCore(out, C);
            out.grade = gradeCore(out, isObj(C.raw.consensus) ? C.raw.consensus : null, isObj(C.raw.aca) ? C.raw.aca : null, { closureOnly: gp(C.plan, 'outcome.label', null) === 'closure-only' });
            out.salvage = (verdict === 'interpretable' && !excluded.length) ? [] : salvageFor(C, checks, usable, excluded);
            return out;
        } catch (e) {
            return failure('TRIAGE_ERROR', ['Triage failed: ' + clampTxt(e && e.message ? e.message : 'internal error')], []);
        }
    }
    function blunders(prep, events, ctx) {
        try {
            var bad = validPrep(prep);
            if (bad) return failure('BAD_PREPARED', ['Blunder scoring needs a prepared record.'], [bad]);
            return blundersCore(buildCtx(prep, events, ctx));
        } catch (e) { return failure('BLUNDER_ERROR', ['Blunder scoring failed.'], []); }
    }
    function repump(tri, ctx) {
        try {
            if (!isObj(tri) || tri.ok === false) return failure('BAD_TRIAGE', ['The re-pump verdict needs a triage result.'], ['triage']);
            ctx = isObj(ctx) ? ctx : {};
            var prep = ctx.prep, C;
            if (!validPrep(prep)) C = buildCtx(prep, ctx.events, ctx);
            else {
                C = { raw: ctx, inputs: isObj(ctx.inputs) ? ctx.inputs : {}, well: isObj(ctx.well) ? ctx.well : {}, ev: isObj(ctx.events) ? ctx.events : null,
                      isip: okRes(ctx.isip) ? ctx.isip : null, hammer: okRes(ctx.hammer) ? ctx.hammer : null, stepDown: okRes(ctx.stepDown) ? ctx.stepDown : null,
                      plan: isObj(ctx.plan) ? ctx.plan : null, src: 'bh', pLast: NaN };
                var tvd = gp(C.inputs, 'datumTvd', null); C.tvd = fin(tvd) && tvd > 0 ? tvd : null;
                var rho = gp(C.inputs, 'fluid.rhoPpg', null); C.hydroGrad = PSI_PER_FT_PER_PPG * (fin(rho) && rho > 0 ? rho : 8.43);
                priorsInto(C);
                C.isipVal = C.isip && fin(C.isip.value) ? C.isip.value : NaN;
                C.gradIsip = C.tvd && fin(C.isipVal) ? C.isipVal / C.tvd : null;
                if (fin(ctx.pLast)) C.pLast = ctx.pLast;
            }
            return repumpCore(tri, C);
        } catch (e) { return failure('REPUMP_ERROR', ['The re-pump verdict failed.'], []); }
    }
    function grade(tri, consensus, aca, opts) {
        try {
            if (!isObj(tri) || tri.ok === false) return failure('BAD_TRIAGE', ['The grade needs a triage result.'], ['triage']);
            return gradeCore(tri, consensus, aca, opts);
        } catch (e) { return failure('GRADE_ERROR', ['Grading failed.'], []); }
    }

    function freezeDeep(o) { Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') freezeDeep(o[k]); }); return Object.freeze(o); }
    triage.version = VERSION;
    triage.defaults = freezeDeep(JSON.parse(JSON.stringify(DEFAULTS)));
    triage.checkIds = CHECKS.map(function (r) { return r[0]; });
    G.PRiSM_dfit_triage = triage;
    G.PRiSM_dfit_blunders = blunders;
    G.PRiSM_dfit_repump = repump;
    G.PRiSM_dfit_grade = grade;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var t = [], p = [], q = [], i;
    for (i = 0; i < 10; i++) { t.push(i / 300); p.push(4500); q.push(0); }
    for (i = 1; i <= 20; i++) { t.push(t[9] + i / 1440); p.push(4500 + 100 * i); q.push(5); }
    for (i = 1; i <= 40; i++) { t.push(t[29] + Math.pow(10, -3 + i / 10)); p.push(6400 - 300 * Math.log(1 + i)); q.push(0); }
    var idx = t.map(function (_, k) { return k; });
    var prep = { ok: true, t: t, pw: p, q: q, pSurf: null, T: null, idx: idx, band: null, src: 'bh', sigma: 0.01, quantum: 0.01,
                 applied: { atmDelta: 0, unitFix: null, clockOffsetH: 0, masked: 0 }, flags: [], hf: null };
    var r = G.PRiSM_dfit_triage(prep, { ok: true, tStart: t[9], ts: t[29], qLast: 5, qMax: 5, pb: 6400, steps: [] }, { inputs: { datumTvd: 10000 } });
    var bad = !r || r.ok !== true || r.checks.length !== 21 || G.PRiSM_dfit_grade(r, null, null).letter == null;
    if (bad && typeof console !== 'undefined') console.warn('[49-calc-dfit-triage self-test] failed');
})();
