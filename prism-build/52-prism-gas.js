// =============================================================================
// PRiSM — 52-prism-gas.js  (Round 8)
// -----------------------------------------------------------------------------
// Gas & deliverability inside PRiSM (ROADMAP §2.1 N3):
//
//   • m(p) end to end. 33 (C2) already turns gas pressures into Δm(p) with the
//     16-pvt m(p) table and 33 (C3) evaluates the models in m(p) (1422·q·T/kh).
//     This layer adds the pieces that were missing: real-pressure results
//     back from m(p) (gas skin summary: ΔpS in psi, FE from m(p) drawdowns;
//     34 converts p1hr and p* with the same table), the gas basis card and the
//     report section.
//   • Normalised pseudo-time for PTA (st.gasOpts.pseudoTime → C2 replaces the
//     elapsed time of the analysed period with t_a).
//   • Rate-dependent skin from several flow periods: one straight-line
//     analysis per period, S′ = S + D·q by least squares, S′-vs-q plot.
//   • AOF / IPR inside PRiSM: the test points come from the flow periods of
//     the dataset and go through the SAME pure compute functions as the
//     calculators — WTS_gasdeliv_compute (41-calc-gasdeliv.js) and
//     WTS_oilipr_compute (42-calc-oilipr.js). No deliverability maths here.
//
// REFERENCES
//   Al-Hussainy, R., Ramey, H.J. & Crawford, P.B. (1966) "The flow of real
//     gases through porous media", JPT 18(5) 624-636 — m(p) = 2∫ p/(μZ) dp.
//   Agarwal, R.G. (1979) "Real gas pseudo-time — a new function for pressure
//     buildup analysis of MHF gas wells", SPE 8279.
//   Lee, W.J. & Holditch, S.A. (1982) "Application of pseudotime to buildup
//     test analysis of low-permeability gas wells with long-duration wellbore
//     storage distortion", JPT 34(12) 2877-2887 — normalised pseudo-time
//     t_a = (μ ct)_ref ∫ dt / (μ(p)·ct(p)).
//   Lee, W.J., Rollins, J.B. & Spivey, J.P. (2003) Pressure Transient Testing,
//     SPE Textbook Series 9, §3 (gas wells): kh = 1637 q T/|m|,
//     Δm_S = 0.869·|m|·S, p* and p1hr from m* and m1hr by inverting m(p).
//   ERCB (1975) Gas Well Testing — Theory and Practice, Directive 034:
//     S′ = S + D·q from several flow rates; AOF at 14.65 psia back-pressure.
//   Ramey, H.J. Jr. (1965) "Non-Darcy flow and wellbore storage effects in
//     pressure build-up and drawdown of gas wells", JPT 17(2) 223-233.
//
// PUBLIC API (window.*)
//   PRiSM_gasPseudoTime(dt[], p[], {p0, T_F, SG_g, ct, pNorm, Sg}) → {ok, ta[], info}
//   PRiSM_gasSkinSummary({S, m | (kh, q, T_R), pbar, pwf, table, rw, CD})
//   PRiSM_gasBasis()                    → gas m(p) basis for the panel / report
//   PRiSM_skinVsRate(opts?)             → {ok, rows[], fit{S, D, r2}}; st.rateSkin
//   PRiSM_deliverabilityPoints(opts?)   → {ok, type, pr, prSource, pb, points[]}
//   PRiSM_gasDeliverability(input?)     → {ok, input, result}  (WTS_gasdeliv_compute)
//   PRiSM_oilDeliverability(input?)     → {ok, input, result}  (WTS_oilipr_compute)
//   PRiSM_deliverability(opts?)         → gas or oil by the well's fluid
//   PRiSM_setGasOption(key, value)      → st.gasOpts (pseudoTime)
//   PRiSM_renderGasPanel(host) / PRiSM_renderRateSkinPanel(host) /
//   PRiSM_renderDeliverabilityPanel(host)      (Tab 2 panels, C7)
//
// STATE (C8, saved by PRiSM_saveState and carried in project files):
//   st.gasOpts {pseudoTime}, st.rateSkin {S, D, r2, n, rows, datasetHash},
//   st.deliverability {kind, input, summary, datasetHash}.
//
// UNITS — field units: t hours, p psia, q Mscf/d (gas) or STB/d (oil),
//   m(p) psi²/cp, D per unit rate, AOF Mscf/d.
//
// CONVENTIONS — single outer IIFE, window.PRiSM_* names, no timers, no
//   polling, no function wrapping; every cross-module call is typeof-guarded.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;

    // =========================================================================
    // SECTION 1 — HELPERS
    // =========================================================================
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isPos(v) { return isNum(v) && v > 0; }
    function isArr(a) { return !!a && typeof a !== 'string' && typeof a.length === 'number'; }
    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        var x = (typeof v === 'number') ? v : parseFloat(v);
        return isNum(x) ? x : null;
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
    }
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e7 || a < 1e-3) return v.toExponential((sig || 4) - 1);
        return String(+v.toPrecision(sig || 4));
    }
    function median(a) {
        var b = a.filter(isNum).sort(function (x, y) { return x - y; });
        if (!b.length) return NaN;
        var m = b.length >> 1;
        return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function $(id) { try { return D && D.getElementById ? D.getElementById(id) : null; } catch (e) { return null; } }
    function st() {
        if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
            if (CE) G.dispatchEvent(new CE(type, { detail: detail || {} }));
        } catch (e) { /* a listener threw — never break the caller */ }
    }
    function on(type, fn) { try { if (typeof G.addEventListener === 'function') G.addEventListener(type, fn); } catch (e) { /* stub */ } }
    function save() { if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* storage optional */ } } }
    function dsHash() { try { return typeof G.PRiSM_datasetHash === 'function' ? G.PRiSM_datasetHash() : null; } catch (e) { return null; } }
    function getWell() { try { return typeof G.PRiSM_getWell === 'function' ? G.PRiSM_getWell() : null; } catch (e) { return null; } }
    function hasData(ds) { return !!(ds && isArr(ds.t) && ds.t.length); }
    function corr() { return G.PRiSM_pvt_correlations || null; }

    // =========================================================================
    // SECTION 2 — GAS PROPERTIES AT PRESSURE (16-pvt correlation library)
    // =========================================================================
    // Z: Dranchuk & Abou-Kassem (1975); μg: Lee, Gonzalez & Eakin (1966);
    // cg = 1/p − (1/Z)·dZ/dp; pseudo-criticals: Sutton (1985). Same functions
    // as the m(p) table, so pseudo-time and m(p) use one PVT basis.
    function gasPropsFn(T_F, sg) {
        var C = corr();
        if (!C || !isNum(T_F) || !isPos(sg)) return null;
        var Tpc = C.Tpc_sutton(sg), Ppc = C.Ppc_sutton(sg);
        if (!isPos(Tpc) || !isPos(Ppc)) return null;
        var Tpr = (T_F + 459.67) / Tpc;
        return function (P) {
            var Z = C.Z_dranchukAbouKassem(Tpr, P / Ppc);
            var mu = C.mu_g_leeGonzalezEakin(sg, T_F, Z, P);
            var cg = C.cg_realGas(P, T_F, Z, sg);
            return { Z: Z, mu: mu, cg: cg };
        };
    }

    function gasSaturation(o) {
        if (isNum(o && o.Sg)) return Math.max(0, Math.min(1, o.Sg));
        var s = G.PRiSM_pvt || {};
        var c = s._computed || {};
        if (isNum(c.Sg) && c.Sg > 0 && c.Sg <= 1) return c.Sg;
        var sw = isNum(s.Sw) ? s.Sw : (isNum(s.Swc) ? s.Swc : 0);
        return Math.max(0, Math.min(1, 1 - sw));
    }

    // Normalised pseudo-time (Agarwal 1979; Lee & Holditch 1982):
    //   t_a(Δt) = ∫₀^Δt (μ ct)_ref / (μ(p) ct(p)) dτ,
    //   ct(p) = ct_ref + Sg·(cg(p) − cg(p_ref))   (only the gas term varies).
    // The reference is the pressure at which the well store's μ and ct are
    // evaluated (the PVT pressure p_res), so the models keep using the store's
    // μ and ct. Trapezoidal rule over the samples, starting at (Δt = 0, p0).
    function gasPseudoTime(dt, p, o) {
        o = o || {};
        var props = gasPropsFn(o.T_F, o.SG_g);
        if (!props) return { ok: false, reason: 'Pseudo-time needs the gas temperature and gravity (Well & Test) and the 16-pvt correlations.' };
        if (!isArr(dt) || !isArr(p) || dt.length !== p.length || dt.length < 2) return { ok: false, reason: 'Pseudo-time needs matching time and pressure arrays.' };
        var pNorm = isPos(o.pNorm) ? o.pNorm : o.p0;
        var p0 = isPos(o.p0) ? o.p0 : p[0];
        if (!isPos(pNorm) || !isPos(p0)) return { ok: false, reason: 'Pseudo-time needs a reference pressure.' };
        var Sg = gasSaturation(o);
        var ref = props(pNorm);
        if (!isPos(ref.mu) || !isPos(ref.cg)) return { ok: false, reason: 'Gas properties at the reference pressure are not defined.' };
        var ctRef = isPos(o.ct) ? o.ct : Sg * ref.cg;
        var ctOther = ctRef - Sg * ref.cg;
        var warn = null;
        if (ctOther < 0) { ctOther = 0; warn = 'The entered ct is below Sg·cg at the reference pressure: ct(p) = Sg·cg(p) was used.'; ctRef = Sg * ref.cg; }
        function w(P) {
            var g = props(P);
            var ct = ctOther + Sg * g.cg;
            if (!isPos(g.mu) || !isPos(ct)) return NaN;
            return (ref.mu * ctRef) / (g.mu * ct);
        }
        var ta = new Array(dt.length);
        var tPrev = 0, wPrev = w(p0), acc = 0, rMin = Infinity, rMax = -Infinity;
        if (!isNum(wPrev)) return { ok: false, reason: 'Gas properties are not defined at the reference pressure p0.' };
        for (var i = 0; i < dt.length; i++) {
            var wi = w(p[i]);
            if (!isNum(wi) || !(dt[i] > tPrev)) return { ok: false, reason: 'Pseudo-time integrand undefined at sample ' + (i + 1) + '.' };
            acc += 0.5 * (wPrev + wi) * (dt[i] - tPrev);
            ta[i] = acc;
            if (wi < rMin) rMin = wi;
            if (wi > rMax) rMax = wi;
            tPrev = dt[i]; wPrev = wi;
        }
        return {
            ok: true, ta: ta,
            info: { pNorm: pNorm, p0: p0, Sg: Sg, ctRef: ctRef, ctOther: ctOther, muRef: ref.mu, cgRef: ref.cg,
                    ratioMin: rMin, ratioMax: rMax, warning: warn }
        };
    }

    // =========================================================================
    // SECTION 3 — GAS SKIN SUMMARY (real pressure back from m(p))
    // =========================================================================
    // Δm_S = 0.8686·|m|·S (m in psi²/cp per log cycle), or 1422·q·T·S/kh.
    // ΔpS = |p(m(pwf) ± Δm_S) − pwf|: the flowing pressure the well would have
    // with zero skin, read back through the m(p) table (Lee et al. 2003 §3).
    // FE = (Δm_drawdown − Δm_S)/Δm_drawdown with Δm_drawdown = |m(p̄) − m(pwf)|.
    function gasSkinSummary(o) {
        o = o || {};
        var r = { ok: false, gas: true, warnings: [] };
        var S = num(o.S);
        if (!isNum(S)) { r.warnings.push('Skin not available'); return r; }
        var tbl = o.table || null;
        var dmS = NaN;
        if (isPos(Math.abs(o.m || 0))) dmS = 0.8686 * Math.abs(o.m) * S;
        else if (isPos(o.kh) && isPos(o.q) && isPos(o.T_R)) dmS = 1422 * Math.abs(o.q) * o.T_R * S / o.kh;
        r.dmS = dmS;
        if (isPos(o.rw)) r.rwEff = o.rw * Math.exp(-S);
        if (isPos(o.CD)) r.CDe2S = o.CD * Math.exp(2 * S);
        var pbar = num(o.pbar), pwf = num(o.pwf);
        if (tbl && typeof tbl.mOf === 'function' && isPos(pwf) && isNum(dmS)) {
            var prod = !(isNum(pbar) && pbar < pwf);
            var mwf = tbl.mOf(pwf);
            var pIdeal = tbl.pOf(mwf + (prod ? 1 : -1) * dmS);
            r.pwfIdeal = pIdeal;
            r.dpS = prod ? pIdeal - pwf : pwf - pIdeal;
            if (isPos(pbar)) {
                var ddm = Math.abs(tbl.mOf(pbar) - mwf);
                r.drawdown = Math.abs(pbar - pwf);
                r.dmDrawdown = ddm;
                if (ddm > 0) { r.FE = (ddm - dmS) / ddm; r.DR = r.FE !== 0 ? 1 / r.FE : NaN; }
            } else r.warnings.push('Average / initial pressure unknown: FE and DR not computed');
        } else {
            r.dpS = NaN;
            r.warnings.push('m(p) table or flowing pressure unavailable: ΔpS not converted to pressure');
        }
        r.ok = isNum(r.dpS);
        return r;
    }

    // Gas basis for the panel / report.
    function gasBasis() {
        var w = getWell() || {};
        var out = { ok: false, fluid: w.fluid || 'oil' };
        if (w.fluid !== 'gas') { out.reason = 'The fluid on Well & Test is not gas.'; return out; }
        var C = corr();
        var sg = w.sg, T_F = w.T_F;
        out.T_F = T_F; out.SG_g = sg;
        if (!C || !isPos(sg) || !isNum(T_F)) { out.reason = 'Enter the gas gravity and reservoir temperature on Well & Test.'; return out; }
        out.Tpc = C.Tpc_sutton(sg); out.Ppc = C.Ppc_sutton(sg);
        var ad = null;
        try { ad = typeof G.PRiSM_getAnalysisData === 'function' ? G.PRiSM_getAnalysisData() : null; } catch (e) { ad = null; }
        var spec = (ad && ad.ok && ad.mpSpec) ? ad.mpSpec : { T_F: T_F, SG_g: sg, pmax: 1.2 * (isPos(w.piStored) ? w.piStored : 5000) };
        var tbl = null;
        try { tbl = typeof G.PRiSM_mpTable === 'function' ? G.PRiSM_mpTable(spec) : null; } catch (e2) { tbl = null; }
        out.table = tbl;
        out.pNorm = isPos(w.piStored) ? w.piStored : null;
        if (tbl && isPos(w.piStored)) out.mPi = tbl.mOf(w.piStored);
        if (ad && ad.ok) {
            out.pseudo = !!ad.pseudo; out.pRefPressure = ad.pRefPressure; out.mRef = ad.pseudo ? ad.pRef : null;
            out.pseudoTime = !!ad.pseudoTime; out.pseudoTimeInfo = ad.pseudoTimeInfo || null;
        }
        var props = gasPropsFn(T_F, sg);
        if (props && isPos(out.pNorm)) {
            var g = props(out.pNorm);
            out.Z = g.Z; out.mu = g.mu; out.cg = g.cg;
        }
        out.correlations = 'Z: Dranchuk & Abou-Kassem (1975); μg: Lee, Gonzalez & Eakin (1966); Tpc/Ppc: Sutton (1985); m(p) = 2∫p/(μZ)dp (Al-Hussainy, Ramey & Crawford 1966)';
        out.ok = !!tbl;
        return out;
    }

    function setGasOption(key, value) {
        var s = st();
        s.gasOpts = (s.gasOpts && typeof s.gasOpts === 'object') ? s.gasOpts : {};
        if (key === 'pseudoTime') s.gasOpts.pseudoTime = !!value;
        else return false;
        s.modelCurveData = null;          // the model curve depends on the time function
        save();
        dispatch('prism:well-changed', { source: 'gas-options', key: key });
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
        return true;
    }

    // =========================================================================
    // SECTION 4 — RATE-DEPENDENT SKIN FROM SEVERAL FLOW PERIODS
    // =========================================================================
    // Each period with enough samples gets its own straight-line analysis
    // (34: superposition for later flow periods, Horner/superposition for
    // build-ups). Its apparent skin S′ belongs to the rate that drove it
    // (the period's rate for a flow period, the rate before shut-in for a
    // build-up). S′ = S + D·q by least squares (ERCB 1975; Ramey 1965).
    function skinVsRate(opts) {
        opts = opts || {};
        var ds = opts.dataset || G.PRiSM_dataset;
        if (!hasData(ds) || !isArr(ds.p)) return { ok: false, reason: 'Load pressure and rate data first.', rows: [] };
        if (typeof G.PRiSM_getAnalysisData !== 'function' || typeof G.PRiSM_semilogAnalysis !== 'function') {
            return { ok: false, reason: 'The analysis layers are not loaded.', rows: [] };
        }
        var rh = typeof G.PRiSM_rateHistory === 'function' ? G.PRiSM_rateHistory(ds) : null;
        var periods = (rh && rh.ok) ? rh.periods : [];
        var minN = isPos(opts.minPoints) ? opts.minPoints : 5;
        var include = opts.include || 'all';        // 'flow' | 'buildup' | 'all'
        var well = getWell();
        var rows = [], skipped = [];
        periods.forEach(function (per, i) {
            var isFlow = per.type === 'flow' || per.type === 'injection';
            var isShut = per.type === 'shut-in';
            if (!isFlow && !isShut) return;
            if ((include === 'flow' && !isFlow) || (include === 'buildup' && !isShut)) return;
            if (isShut && i === 0) return;
            if (per.n < minN) { skipped.push('Period ' + (i + 1) + ': ' + per.n + ' samples'); return; }
            var ad = null, sl = null;
            try { ad = G.PRiSM_getAnalysisData(ds, { period: i }); } catch (e) { ad = null; }
            if (!ad || !ad.ok) { skipped.push('Period ' + (i + 1) + ': ' + ((ad && ad.reason) || 'no analysis data')); return; }
            try { sl = G.PRiSM_semilogAnalysis(ad, well, {}); } catch (e2) { sl = null; }
            if (!sl || !sl.ok || !isNum(sl.S)) { skipped.push('Period ' + (i + 1) + ': ' + ((sl && (sl.reason || (sl.missing && 'missing ' + sl.missing.join(', ')))) || 'no skin')); return; }
            rows.push({
                period: i, label: 'P' + (i + 1) + (isShut ? ' build-up' : ' flow'), type: per.type,
                q: Math.abs(ad.qFlow), S: sl.S, k: sl.k, kh: sl.kh, method: sl.method,
                windowFound: !!(sl.window && sl.window.found), t0: per.t0, t1: per.t1
            });
        });
        var fit = (typeof G.PRiSM_rateDependentSkin === 'function') ? G.PRiSM_rateDependentSkin(rows.map(function (r) { return { q: r.q, S: r.S }; }))
            : { ok: false, reason: 'PRiSM_rateDependentSkin missing' };
        var out = { ok: !!fit.ok, rows: rows, skipped: skipped, fit: fit, fluid: (well && well.fluid) || 'oil',
            rateUnit: (well && well.qUnit) || 'STB/d', datasetHash: dsHash() };
        if (!fit.ok) out.reason = fit.reason || 'Not enough flow periods.';
        var nNoWin = rows.filter(function (r) { return !r.windowFound; }).length;
        out.warnings = [];
        if (nNoWin) out.warnings.push(nNoWin + ' period' + (nNoWin > 1 ? 's have' : ' has') + ' no clear radial-flow plateau: its S′ is indicative only.');
        if (fit.ok && fit.D < 0) out.warnings.push('D < 0: skin falls with rate — check the periods (clean-up during the test gives the same trend).');
        if (fit.ok && opts.store !== false) {
            st().rateSkin = { S: fit.S, D: fit.D, r2: fit.r2, n: fit.n, rateUnit: out.rateUnit,
                rows: clone(rows), datasetHash: out.datasetHash, at: new Date().toISOString() };
            save();
            dispatch('prism:rateskin-updated', { S: fit.S, D: fit.D });
        }
        return out;
    }

    // =========================================================================
    // SECTION 5 — DELIVERABILITY POINTS, AOF (gas) AND IPR (oil)
    // =========================================================================
    function periodSamples(ds, per) {
        var t = [], p = [];
        for (var i = 0; i < ds.t.length; i++) {
            var ti = +ds.t[i], pi = +ds.p[i];
            if (!isNum(ti) || !isNum(pi)) continue;
            if (ti > per.t0 + 1e-12 && ti <= per.t1 + 1e-12) { t.push(ti); p.push(pi); }
        }
        return { t: t, p: p };
    }

    // Average reservoir pressure for the deliverability: explicit value, then
    // the semilog p* of an analysed build-up, then pi, then the highest sample.
    function resolvePr(opts, well, ds) {
        if (isPos(num(opts.pr))) return { pr: num(opts.pr), source: 'entered' };
        var sl = st().semilog;
        if (sl && sl.ok && isPos(sl.pStar) && (!sl.datasetHash || sl.datasetHash === dsHash())) return { pr: sl.pStar, source: 'p* (straight line)' };
        if (well && isPos(well.pi)) return { pr: well.pi, source: 'pi (Well & Test)' };
        var mx = -Infinity;
        if (hasData(ds) && isArr(ds.p)) ds.p.forEach(function (v) { if (isNum(+v) && +v > mx) mx = +v; });
        return isPos(mx) ? { pr: mx, source: 'highest pressure in the data (estimate)' } : { pr: null, source: 'unknown' };
    }

    function deliverabilityPoints(opts) {
        opts = opts || {};
        var ds = opts.dataset || G.PRiSM_dataset;
        var well = getWell() || {};
        var out = { ok: false, points: [], warnings: [], fluid: well.fluid || 'oil' };
        if (!hasData(ds) || !isArr(ds.p)) { out.reason = 'Load pressure and rate data first.'; return out; }
        var rh = typeof G.PRiSM_rateHistory === 'function' ? G.PRiSM_rateHistory(ds) : null;
        var periods = (rh && rh.ok) ? rh.periods : [];
        var flows = [];
        periods.forEach(function (per, i) {
            if (per.type !== 'flow' || !isPos(per.q)) return;
            var s = periodSamples(ds, per);
            if (!s.p.length) return;
            var prev = i > 0 ? periods[i - 1] : null;
            var pws = null;
            if (prev && prev.type === 'shut-in') {
                var sp = periodSamples(ds, prev);
                if (sp.p.length) pws = sp.p[sp.p.length - 1];
            }
            flows.push({ period: i, q: per.q, pwf: s.p[s.p.length - 1], pws: pws, duration: per.t1 - per.t0,
                         afterShutIn: !!(prev && prev.type === 'shut-in') });
        });
        if (!flows.length) { out.reason = 'No flowing period with pressure samples: deliverability needs flow periods with a rate.'; return out; }
        var pr = resolvePr(opts, well, ds);
        out.pr = pr.pr; out.prSource = pr.source;
        out.pb = isNum(num(opts.pb)) ? num(opts.pb) : 14.65;
        // Test type: consecutive flows → flow-after-flow; flows separated by
        // shut-ins → modified isochronal (Katz et al. 1959), the last flow is
        // the stabilised (extended) point when it is at least twice as long as
        // the median of the others.
        var separated = flows.length > 1 && flows.slice(1).every(function (f) { return f.afterShutIn; });
        var type = opts.type || (flows.length === 1 ? 'single' : (separated ? 'miso' : 'faf'));
        out.type = type;
        var pts = flows.map(function (f) { return { kind: 'stab', q: f.q, pwf: f.pwf, pws: f.pws, period: f.period, duration: f.duration }; });
        if (type === 'miso' || type === 'iso') {
            var durs = flows.slice(0, -1).map(function (f) { return f.duration; });
            var last = flows[flows.length - 1];
            var extended = durs.length && last.duration >= 2 * median(durs);
            pts.forEach(function (p, k) { p.kind = (k === pts.length - 1 && extended) ? 'stab' : 'trans'; });
            if (!extended) out.warnings.push('No extended (stabilised) flow period was found: mark the stabilised point in the table, or the isochronal analysis cannot give an AOF.');
            // The first flow of a modified isochronal test starts from p̄r.
            if (!isPos(pts[0].pws) && isPos(out.pr)) pts[0].pws = out.pr;
        }
        out.points = pts;
        out.ok = true;
        return out;
    }

    function gasDeliverability(input) {
        input = input || {};
        if (typeof G.WTS_gasdeliv_compute !== 'function') return { ok: false, reason: 'The gas deliverability engine (WTS_gasdeliv_compute) is not loaded.' };
        var auto = (input.points && input.points.length) ? null : deliverabilityPoints(input);
        if (auto && !auto.ok) return { ok: false, reason: auto.reason };
        var inp = {
            type: input.type || (auto && auto.type) || 'faf',
            pr: isPos(num(input.pr)) ? num(input.pr) : (auto ? auto.pr : null),
            pb: isNum(num(input.pb)) ? num(input.pb) : (auto ? auto.pb : 14.65),
            nAssumed: isNum(num(input.nAssumed)) ? num(input.nAssumed) : 0.85,
            pwfDesign: num(input.pwfDesign), qTarget: num(input.qTarget),
            points: (input.points && input.points.length ? input.points : auto.points).map(function (p, i) {
                return { kind: p.kind === 'trans' ? 'trans' : 'stab', q: num(p.q), pwf: num(p.pwf), pws: num(p.pws), row: i + 1 };
            })
        };
        var res = G.WTS_gasdeliv_compute(inp);
        var out = { ok: !!(res && res.ok), kind: 'gas', input: inp, result: res, prSource: auto ? auto.prSource : 'entered',
                    warnings: (auto ? auto.warnings : []).concat(res && res.warnings ? res.warnings : []) };
        if (!out.ok) out.reason = (res && res.errors && res.errors.join(' ')) || 'Deliverability failed.';
        if (out.ok) {
            st().deliverability = {
                kind: 'gas', input: clone(inp), prSource: out.prSource, datasetHash: dsHash(), at: new Date().toISOString(),
                summary: { n: res.cn.n, C: res.cn.C, r2: res.cn.r2, aofCn: res.cn.aof,
                           a: res.lit.ok ? res.lit.a : null, b: res.lit.ok ? res.lit.b : null, aofLit: res.lit.ok ? res.lit.aof : null,
                           type: res.type, pr: res.pr, pb: res.pb }
            };
            save();
        }
        return out;
    }

    function oilDeliverability(input) {
        input = input || {};
        if (typeof G.WTS_oilipr_compute !== 'function') return { ok: false, reason: 'The oil IPR engine (WTS_oilipr_compute) is not loaded.' };
        var auto = (input.points && input.points.length) ? null : deliverabilityPoints(input);
        if (auto && !auto.ok) return { ok: false, reason: auto.reason };
        var pvt = G.PRiSM_pvt || {};
        var pb = num(input.pb);
        if (!isNum(pb)) pb = isPos(pvt.Pb) ? pvt.Pb : ((pvt._computed && isPos(pvt._computed.Pb)) ? pvt._computed.Pb : null);
        var fe = num(input.fe), feSource = 'entered';
        if (!isNum(fe)) {
            var sl = st().semilog;
            if (sl && sl.ok && isNum(sl.FE) && (!sl.datasetHash || sl.datasetHash === dsHash())) { fe = Math.max(0.3, Math.min(2, sl.FE)); feSource = 'straight-line FE'; }
            else { fe = 1; feSource = 'default 1.0'; }
        }
        var pts = (input.points && input.points.length ? input.points : auto.points);
        var method = input.method || (isPos(pb) ? 'vogel' : 'pi');
        // Vogel / PI use test point 1: the last (longest-flowing) period is the most stabilised.
        if (method !== 'fetk' && pts.length > 1) pts = [pts[pts.length - 1]];
        var inp = {
            method: method,
            pr: isPos(num(input.pr)) ? num(input.pr) : (auto ? auto.pr : null),
            pb: isNum(pb) ? pb : '', fe: fe,
            pwfDesign: input.pwfDesign != null ? input.pwfDesign : '', qTarget: input.qTarget != null ? input.qTarget : '',
            prFuture: input.prFuture != null ? input.prFuture : '',
            points: pts.slice(0, 4).map(function (p) { return { q: num(p.q), pwf: num(p.pwf) }; })
        };
        var res = G.WTS_oilipr_compute(inp);
        var out = { ok: !!(res && res.ok), kind: 'oil', input: inp, result: res, feSource: feSource,
                    prSource: auto ? auto.prSource : 'entered', warnings: (auto ? auto.warnings : []).concat(res && res.warnings ? res.warnings : []) };
        if (!out.ok) out.reason = (res && res.errors && res.errors.join(' ')) || 'IPR failed.';
        if (out.ok) {
            st().deliverability = {
                kind: 'oil', input: clone(inp), prSource: out.prSource, feSource: feSource, datasetHash: dsHash(), at: new Date().toISOString(),
                summary: { mode: res.mode, J: res.J, qmax: res.qmax, qb: res.qb, n: res.n, C: res.C, pr: inp.pr, pb: inp.pb, fe: fe }
            };
            save();
        }
        return out;
    }

    function deliverability(opts) {
        var w = getWell() || {};
        return w.fluid === 'gas' ? gasDeliverability(opts) : oilDeliverability(opts);
    }

    // =========================================================================
    // SECTION 6 — PANELS (C7, Tab 2)
    // =========================================================================
    var STYLE_ID = 'prism_gas_style';
    var CSS = [
        '.prism-gas { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-gas-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px; }',
        '.prism-gas-grid label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text2); }',
        '.prism-gas input, .prism-gas select { width:100%; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 7px; font:inherit; font-size:12.5px; }',
        '.prism-gas input[type=checkbox] { width:auto; }',
        '.prism-gas-tw { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-gas table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-gas th, .prism-gas td { padding:5px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-gas th { color:var(--text2); font-weight:600; }',
        '.prism-gas-kv { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(170px,100%),1fr)); gap:6px; }',
        '.prism-gas-kv > div { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:6px 8px; min-width:0; }',
        '.prism-gas-kv .k { font-size:11px; color:var(--text3); } .prism-gas-kv .v { font-size:14px; font-weight:600; overflow-wrap:anywhere; }',
        '.prism-gas-btns { display:flex; flex-wrap:wrap; gap:8px; }',
        '.prism-gas-btn { padding:7px 12px; border-radius:6px; border:1px solid var(--border); background:var(--bg2); color:var(--text); font-size:12px; cursor:pointer; min-height:34px; }',
        '.prism-gas-btn--primary { background:var(--accent); border-color:var(--accent); color:#fff; }',
        '.prism-gas-note { font-size:11.5px; color:var(--text2); line-height:1.45; }',
        '.prism-gas-warn { font-size:12px; color:var(--yellow, #d29922); }',
        '.prism-gas-bad { font-size:12px; color:var(--red, #f85149); }',
        '.prism-gas canvas { width:100%; height:240px; display:block; background:var(--bg1); border-radius:6px; }'
    ].join('\n');
    function ensureCss() {
        if (!D || !D.head || typeof D.createElement !== 'function' || $(STYLE_ID)) return;
        try { var s = D.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; D.head.appendChild(s); } catch (e) { /* ignore */ }
    }
    function kv(pairs) {
        return '<div class="prism-gas-kv">' + pairs.map(function (p) {
            return '<div><div class="k">' + esc(p[0]) + '</div><div class="v">' + esc(p[1]) + '</div></div>';
        }).join('') + '</div>';
    }
    function warnList(list) {
        return (list || []).map(function (w) { return '<div class="prism-gas-warn">⚠ ' + esc(w) + '</div>'; }).join('');
    }
    function rerender(rootId, fn) {
        var root = $(rootId);
        if (root && root.parentNode) { try { fn(root.parentNode); } catch (e) { /* ignore */ } }
    }

    // ── Gas basis + pseudo-time ─────────────────────────────────────────────
    function renderGasPanel(host) {
        if (!host) return;
        ensureCss();
        var b = gasBasis();
        var opts = st().gasOpts || {};
        var h = '<div class="prism-gas" id="prism_gas_root">';
        if (!b.ok) {
            h += '<div class="prism-gas-note">' + esc(b.reason || 'Gas basis unavailable.') + '</div></div>';
            host.innerHTML = h; return;
        }
        h += '<div class="prism-gas-note">Gas is analysed in pseudo-pressure m(p) = 2∫p/(μZ)dp (psi²/cp). The models, the straight line (kh = 1637·q·T/|m|) and the fit work in Δm(p); p1hr, p* and the skin pressure drop are converted back to psia with the same m(p) table.</div>';
        h += kv([
            ['Reservoir temperature', fmt(b.T_F, 4) + ' °F'], ['Gas gravity', fmt(b.SG_g, 4)],
            ['Tpc / Ppc (Sutton)', fmt(b.Tpc, 4) + ' °R / ' + fmt(b.Ppc, 4) + ' psia'],
            ['m(p) at pi', isNum(b.mPi) ? fmt(b.mPi, 5) + ' psi²/cp' : '—'],
            ['Z, μg at pi', isNum(b.Z) ? fmt(b.Z, 4) + ', ' + fmt(b.mu, 4) + ' cp' : '—'],
            ['cg at pi', isNum(b.cg) ? fmt(b.cg, 4) + ' 1/psi' : '—'],
            ['Reference pressure (Δt = 0)', isNum(b.pRefPressure) ? fmt(b.pRefPressure, 5) + ' psia' : '—'],
            ['Pseudo-pressure in use', b.pseudo ? 'yes' : 'no']
        ]);
        h += '<label class="prism-gas-note" style="display:flex;gap:8px;align-items:center;"><input type="checkbox" id="prism_gas_pt"' + (opts.pseudoTime ? ' checked' : '') + '> ' +
             'Use normalised pseudo-time t<sub>a</sub> = (μ·ct)<sub>ref</sub>∫dt/(μ·ct) for the analysed period (large pressure changes, long storage)</label>';
        if (b.pseudoTime && b.pseudoTimeInfo) {
            var pi = b.pseudoTimeInfo;
            h += '<div class="prism-gas-note">Pseudo-time on: normalised at ' + esc(fmt(pi.pNorm, 5)) + ' psia, Sg = ' + esc(fmt(pi.Sg, 3)) +
                 '; (μct)ref/(μct) ranges ' + esc(fmt(pi.ratioMin, 4)) + '–' + esc(fmt(pi.ratioMax, 4)) + '.</div>';
            if (pi.warning) h += warnList([pi.warning]);
        }
        h += '<div class="prism-gas-note">' + esc(b.correlations) + '. Pseudo-time: Agarwal (1979), Lee &amp; Holditch (1982); ct(p) = ct,ref + Sg·(cg(p) − cg,ref).</div>';
        h += '</div>';
        host.innerHTML = h;
        var cb = $('prism_gas_pt');
        if (cb) cb.onchange = function () { setGasOption('pseudoTime', !!cb.checked); rerender('prism_gas_root', renderGasPanel); };
    }

    // ── Skin vs rate ─────────────────────────────────────────────────────────
    function drawScatter(canvas, pts, line, labels) {
        if (!canvas || typeof canvas.getContext !== 'function') return;
        var ctx; try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return;
        var dpr = G.devicePixelRatio || 1;
        var w = canvas.clientWidth || 480, h = canvas.clientHeight || 240;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var pad = { l: 52, r: 12, t: 12, b: 36 };
        var P = { x: pad.l, y: pad.t, w: Math.max(40, w - pad.l - pad.r), h: Math.max(40, h - pad.t - pad.b) };
        ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, w, h);
        var xs = pts.map(function (p) { return p[0]; }).concat([0]), ys = pts.map(function (p) { return p[1]; });
        if (line) ys = ys.concat([line.a, line.a + line.b * Math.max.apply(null, xs)]);
        var x0 = 0, x1 = Math.max.apply(null, xs) * 1.1 || 1;
        var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
        var pdY = 0.1 * (y1 - y0); y0 -= pdY; y1 += pdY;
        var toX = function (v) { return P.x + (v - x0) / (x1 - x0) * P.w; };
        var toY = function (v) { return P.y + P.h - (v - y0) / (y1 - y0) * P.h; };
        ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1; ctx.strokeRect(P.x + 0.5, P.y + 0.5, P.w, P.h);
        ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (var i = 0; i <= 4; i++) {
            var xv = x0 + (x1 - x0) * i / 4, yv = y0 + (y1 - y0) * i / 4;
            ctx.fillText(fmt(xv, 3), toX(xv), P.y + P.h + 4);
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(yv, 3), P.x - 4, toY(yv));
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        }
        ctx.fillText(labels.x, P.x + P.w / 2, h - 14);
        ctx.save(); ctx.translate(11, P.y + P.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(labels.y, 0, 0); ctx.restore();
        if (line) {
            ctx.strokeStyle = '#a371f7'; ctx.lineWidth = 1.5;
            if (ctx.setLineDash) ctx.setLineDash([6, 4]);
            ctx.beginPath(); ctx.moveTo(toX(x0), toY(line.a + line.b * x0)); ctx.lineTo(toX(x1), toY(line.a + line.b * x1)); ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]);
        }
        ctx.fillStyle = '#58a6ff';
        pts.forEach(function (p) { ctx.beginPath(); ctx.arc(toX(p[0]), toY(p[1]), 4, 0, 2 * Math.PI); ctx.fill(); });
        try { canvas._prismAxes = { toX: toX, toY: toY, plot: { x: P.x, y: P.y, w: P.w, h: P.h }, plotKey: 'skinVsRate', scaleX: { kind: 'lin', min: x0, max: x1 }, scaleY: { kind: 'lin', min: y0, max: y1 } }; } catch (e) { /* ignore */ }
    }

    function rateSkinHTML(r) {
        if (!r) return '<div class="prism-gas-note">Press “Analyse each period” to run one straight-line analysis per flow period.</div>';
        var h = '';
        if (r.rows.length) {
            h += '<div class="prism-gas-tw"><table id="prism_rs_table"><thead><tr><th>Period</th><th>Rate q (' + esc(r.rateUnit) + ')</th><th>Apparent skin S′</th><th>k (md)</th><th>Method</th></tr></thead><tbody>' +
                r.rows.map(function (x) {
                    return '<tr><td>' + esc(x.label) + '</td><td>' + esc(fmt(x.q, 5)) + '</td><td>' + esc(fmt(x.S, 4)) + (x.windowFound ? '' : ' ⚠') + '</td><td>' + esc(fmt(x.k, 4)) + '</td><td>' + esc(x.method || '') + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        }
        if (r.ok) {
            h += kv([['Rate-independent skin S', fmt(r.fit.S, 4)], ['Non-Darcy coefficient D', fmt(r.fit.D, 4) + ' per ' + r.rateUnit],
                     ['Fit R² (' + r.fit.n + ' periods)', fmt(r.fit.r2, 4)]]);
        } else h += '<div class="prism-gas-bad">' + esc(r.reason || 'Not enough periods.') + '</div>';
        h += warnList(r.warnings);
        if (r.skipped && r.skipped.length) h += '<div class="prism-gas-note">Skipped: ' + esc(r.skipped.join('; ')) + '</div>';
        return h;
    }

    var _lastRateSkin = null;
    function renderRateSkinPanel(host) {
        if (!host) return;
        ensureCss();
        var cur = _lastRateSkin && _lastRateSkin.datasetHash === dsHash() ? _lastRateSkin : null;
        var h = '<div class="prism-gas" id="prism_rs_root">' +
            '<div class="prism-gas-note">Each flow period (and each build-up) is analysed with its own straight line; its apparent skin S′ is plotted against the rate that drove it and S′ = S + D·q is fitted. D is the non-Darcy (turbulence) coefficient; S is the rate-independent skin used for the skin decomposition.</div>' +
            '<div class="prism-gas-grid"><label>Periods<select id="prism_rs_include"><option value="all">Flow periods and build-ups</option><option value="flow">Flow periods only</option><option value="buildup">Build-ups only</option></select></label></div>' +
            '<div class="prism-gas-btns"><button type="button" class="prism-gas-btn prism-gas-btn--primary" id="prism_rs_run">Analyse each period</button></div>' +
            '<div class="chart-wrap"><canvas id="prism_rs_canvas" width="480" height="240"></canvas></div>' +
            '<div id="prism_rs_out">' + rateSkinHTML(cur) + '</div></div>';
        host.innerHTML = h;
        if (cur) paintRateSkin(cur);
        var run = $('prism_rs_run');
        if (run) run.onclick = function () {
            var inc = $('prism_rs_include');
            var r = skinVsRate({ include: inc ? inc.value : 'all' });
            _lastRateSkin = r;
            var o = $('prism_rs_out'); if (o) o.innerHTML = rateSkinHTML(r);
            paintRateSkin(r);
        };
    }
    function paintRateSkin(r) {
        var c = $('prism_rs_canvas');
        if (!c || !r || !r.rows.length) return;
        drawScatter(c, r.rows.map(function (x) { return [x.q, x.S]; }), r.ok ? { a: r.fit.S, b: r.fit.D } : null,
                    { x: 'Rate q (' + r.rateUnit + ')', y: 'Apparent skin S′' });
    }

    // ── Deliverability ───────────────────────────────────────────────────────
    var _lastDeliv = null;
    function delivHTML(r) {
        if (!r) return '';
        if (!r.ok) return '<div class="prism-gas-bad">' + esc(r.reason || 'Not computed.') + '</div>' + warnList(r.warnings);
        var res = r.result, h = '';
        if (r.kind === 'gas') {
            h += kv([
                ['Average reservoir pressure p̄r', fmt(r.input.pr, 5) + ' psia (' + (r.prSource || '') + ')'],
                ['Back-pressure exponent n', fmt(res.cn.n, 4)], ['C', fmt(res.cn.C, 4) + ' Mscf/d/psia²ⁿ'],
                ['AOF (back-pressure)', fmt(res.cn.aof, 5) + ' Mscf/d'],
                ['LIT a', res.lit.ok ? fmt(res.lit.a, 4) + ' psia²/(Mscf/d)' : '—'], ['LIT b', res.lit.ok ? fmt(res.lit.b, 4) + ' psia²/(Mscf/d)²' : '—'],
                ['AOF (LIT)', res.lit.ok ? fmt(res.lit.aof, 5) + ' Mscf/d' : (res.lit.reason || '—')]
            ]);
            h += '<div class="prism-gas-tw"><table id="prism_dl_table"><thead><tr><th>pwf (psia)</th><th>q back-pressure (Mscf/d)</th><th>q LIT (Mscf/d)</th></tr></thead><tbody>' +
                res.table.map(function (x) { return '<tr><td>' + esc(fmt(x.pwf, 5)) + '</td><td>' + esc(fmt(x.qCn, 5)) + '</td><td>' + esc(fmt(x.qLit, 5)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
            h += (res.verdicts || []).map(function (v) { return '<div class="' + (v.level === 'ok' ? 'prism-gas-note' : 'prism-gas-warn') + '">' + esc(v.text) + '</div>'; }).join('');
        } else {
            var modeLabel = { 'vogel-sat': 'Vogel (saturated)', composite: 'Composite (PI above pb, Vogel below)', fetkovich: 'Fetkovich', pi: 'Straight-line PI' }[res.mode] || res.mode;
            h += kv([
                ['Average reservoir pressure p̄r', fmt(r.input.pr, 5) + ' psia (' + (r.prSource || '') + ')'],
                ['Method', modeLabel], ['Bubble point pb', isNum(num(r.input.pb)) ? fmt(num(r.input.pb), 5) + ' psia' : '—'],
                ['Flow efficiency FE', fmt(r.input.fe, 3) + ' (' + r.feSource + ')'],
                ['Productivity index J', isNum(res.J) ? fmt(res.J, 4) + ' STB/d/psi' : '—'],
                ['Maximum rate qmax', fmt(res.qmax, 5) + ' STB/d']
            ]);
            h += '<div class="prism-gas-tw"><table id="prism_dl_table"><thead><tr><th>pwf (psia)</th><th>q (STB/d)</th></tr></thead><tbody>' +
                res.table.map(function (x) { return '<tr><td>' + esc(fmt(x.pwf, 5)) + '</td><td>' + esc(fmt(x.q, 5)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
        }
        h += warnList(r.warnings.filter(function (w) { return !/^✓/.test(w); }));
        return h;
    }
    function pointsFromForm() {
        var pts = [];
        for (var i = 0; $('prism_dl_q' + i); i++) {
            var q = num($('prism_dl_q' + i).value), pwf = num($('prism_dl_pwf' + i).value);
            var pws = $('prism_dl_pws' + i) ? num($('prism_dl_pws' + i).value) : null;
            var kind = $('prism_dl_k' + i) ? $('prism_dl_k' + i).value : 'stab';
            if (isNum(q) || isNum(pwf)) pts.push({ q: q, pwf: pwf, pws: pws, kind: kind });
        }
        return pts;
    }
    function renderDeliverabilityPanel(host) {
        if (!host) return;
        ensureCss();
        var w = getWell() || {};
        var gas = w.fluid === 'gas';
        var auto = deliverabilityPoints({});
        var saved = st().deliverability;
        var sameData = saved && saved.datasetHash === dsHash() && saved.kind === (gas ? 'gas' : 'oil');
        var inp = sameData ? saved.input : null;
        var pts = (inp && inp.points && inp.points.length) ? inp.points : (auto.ok ? auto.points : []);
        var h = '<div class="prism-gas" id="prism_dl_root">' +
            '<div class="prism-gas-note">' + (gas
                ? 'AOF and deliverability from the flow periods of this test, computed with the same engine as the Gas Deliverability calculator (back-pressure C·(p̄r² − pwf²)ⁿ and LIT a·q + b·q²).'
                : 'Inflow performance from the flow periods of this test, computed with the same engine as the Oil Well IPR calculator (PI, Vogel / composite with Standing FE, Fetkovich).') + '</div>';
        if (!auto.ok && !pts.length) {
            host.innerHTML = h + '<div class="prism-gas-note">' + esc(auto.reason || 'No flow periods.') + '</div></div>';
            return;
        }
        var prV = inp ? inp.pr : auto.pr;
        h += '<div class="prism-gas-grid">' +
            '<label>p̄r (psia)<input id="prism_dl_pr" type="number" step="any" value="' + (isNum(prV) ? +prV.toPrecision(7) : '') + '"></label>';
        if (gas) {
            var typ = (inp && inp.type) || auto.type || 'faf';
            h += '<label>Test type<select id="prism_dl_type">' + [['faf', 'Flow-after-flow'], ['iso', 'Isochronal'], ['miso', 'Modified isochronal'], ['single', 'Single point']].map(function (o) {
                    return '<option value="' + o[0] + '"' + (o[0] === typ ? ' selected' : '') + '>' + o[1] + '</option>';
                }).join('') + '</select></label>' +
                '<label>AOF back-pressure (psia)<input id="prism_dl_pb" type="number" step="any" value="' + (inp && isNum(inp.pb) ? inp.pb : (isNum(auto.pb) ? auto.pb : 14.65)) + '"></label>';
        } else {
            var pbV = inp && isNum(num(inp.pb)) ? num(inp.pb) : null;
            h += '<label>Bubble point pb (psia)<input id="prism_dl_pbub" type="number" step="any" value="' + (isNum(pbV) ? pbV : '') + '" placeholder="from PVT"></label>' +
                 '<label>Flow efficiency FE<input id="prism_dl_fe" type="number" step="any" value="' + (inp && isNum(inp.fe) ? inp.fe : '') + '" placeholder="from straight line"></label>';
        }
        h += '</div>';
        h += '<div class="prism-gas-tw"><table><thead><tr><th>#</th><th>q (' + esc(gas ? 'Mscf/d' : 'STB/d') + ')</th><th>pwf (psia)</th>' + (gas ? '<th>pws before (psia)</th><th>Point</th>' : '') + '</tr></thead><tbody>' +
            pts.map(function (p, i) {
                return '<tr><td>' + (i + 1) + '</td><td><input id="prism_dl_q' + i + '" type="number" step="any" value="' + (isNum(num(p.q)) ? +num(p.q).toPrecision(7) : '') + '"></td>' +
                    '<td><input id="prism_dl_pwf' + i + '" type="number" step="any" value="' + (isNum(num(p.pwf)) ? +num(p.pwf).toPrecision(7) : '') + '"></td>' +
                    (gas ? '<td><input id="prism_dl_pws' + i + '" type="number" step="any" value="' + (isNum(num(p.pws)) ? +num(p.pws).toPrecision(7) : '') + '"></td>' +
                           '<td><select id="prism_dl_k' + i + '"><option value="trans"' + (p.kind === 'trans' ? ' selected' : '') + '>Transient</option><option value="stab"' + (p.kind !== 'trans' ? ' selected' : '') + '>Stabilised</option></select></td>' : '') +
                    '</tr>';
            }).join('') + '</tbody></table></div>' +
            '<div class="prism-gas-btns"><button type="button" class="prism-gas-btn prism-gas-btn--primary" id="prism_dl_run">' + (gas ? 'Compute AOF' : 'Compute IPR') + '</button>' +
            '<button type="button" class="prism-gas-btn" id="prism_dl_reset">Points from the flow periods</button></div>' +
            warnList(auto.warnings) +
            '<div id="prism_dl_out">' + delivHTML(_lastDeliv && _lastDeliv.kind === (gas ? 'gas' : 'oil') ? _lastDeliv : null) + '</div></div>';
        host.innerHTML = h;
        var run = $('prism_dl_run');
        if (run) run.onclick = function () {
            var input = { pr: num(($('prism_dl_pr') || {}).value), points: pointsFromForm() };
            if (gas) { input.type = ($('prism_dl_type') || {}).value; input.pb = num(($('prism_dl_pb') || {}).value); }
            else { input.pb = num(($('prism_dl_pbub') || {}).value); input.fe = num(($('prism_dl_fe') || {}).value); input.method = input.points.length > 1 && !isNum(input.pb) ? 'fetk' : undefined; }
            var r = gas ? gasDeliverability(input) : oilDeliverability(input);
            _lastDeliv = r;
            var o = $('prism_dl_out'); if (o) o.innerHTML = delivHTML(r);
        };
        var reset = $('prism_dl_reset');
        if (reset) reset.onclick = function () {
            var s = st();
            if (s.deliverability) s.deliverability.input = null;
            _lastDeliv = null;
            rerender('prism_dl_root', renderDeliverabilityPanel);
        };
    }

    function flowPeriodCount() {
        var ds = G.PRiSM_dataset;
        if (!hasData(ds) || !isArr(ds.p) || typeof G.PRiSM_rateHistory !== 'function') return 0;
        try {
            var rh = G.PRiSM_rateHistory(ds);
            return (rh && rh.ok) ? rh.periods.filter(function (p) { return p.type === 'flow' || p.type === 'injection'; }).length : 0;
        } catch (e) { return 0; }
    }
    function transientMode() { return !(G.PRiSM && G.PRiSM.mode === 'decline'); }

    function registerPanels() {
        var specs = [
            [2, { id: 'prism_gas_basis', title: 'Gas analysis: m(p) and pseudo-time', order: 4,
                  when: function () { var w = getWell(); return transientMode() && !!(w && w.fluid === 'gas'); }, render: renderGasPanel }],
            [2, { id: 'prism_rate_skin', title: 'Rate-dependent skin (S′ vs rate)', order: 7, collapsed: true,
                  when: function () { return transientMode() && flowPeriodCount() >= 2; }, render: renderRateSkinPanel }],
            [2, { id: 'prism_deliverability', title: 'Deliverability: AOF (gas) / IPR (oil)', order: 8, collapsed: true,
                  when: function () { return transientMode() && flowPeriodCount() >= 1; }, render: renderDeliverabilityPanel }]
        ];
        specs.forEach(function (x) {
            if (typeof G.PRiSM_registerTabPanel === 'function') {
                try { if (G.PRiSM_registerTabPanel(x[0], x[1])) return; } catch (e) { /* fall back */ }
            }
            G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
            var arr = G.PRiSM_tabPanels[x[0]] = G.PRiSM_tabPanels[x[0]] || [];
            for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === x[1].id) { arr[i] = x[1]; return; }
            arr.push(x[1]);
        });
    }
    registerPanels();

    // Pseudo-time label on the log-log plot (post-draw hook, C6/C7).
    function gasPostDraw(info) {
        if (!info || !info.canvas || info.plotKey !== 'bourdet') return;
        var ad = info.adata || null;
        var s = st();
        if (!(s.gasOpts && s.gasOpts.pseudoTime)) return;
        var w = getWell();
        if (!w || w.fluid !== 'gas') return;
        var ax = info.axes || info.canvas._prismAxes;
        if (!ax || !ax.plot) return;
        var ctx; try { ctx = info.canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return;
        ctx.save();
        ctx.fillStyle = '#d29922'; ctx.font = '11px sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.fillText('Time axis: normalised pseudo-time t_a (h)' + (ad && ad.pseudoTime === false ? ' — unavailable' : ''), ax.plot.x + 6, ax.plot.y + 4);
        ctx.restore();
    }
    gasPostDraw._prismId = 'gas-pseudotime-label';
    (function registerHook() {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === gasPostDraw._prismId) { hooks[i] = gasPostDraw; return; }
        hooks.push(gasPostDraw);
    })();

    // =========================================================================
    // SECTION 7 — REPORT SECTIONS (36-report.js PRiSM_reportSections)
    // =========================================================================
    function reportGas(m) {
        var w = (m && m.well) || getWell() || {};
        if (w.fluid !== 'gas') return null;
        var b = gasBasis();
        if (!b.ok) return null;
        var kvs = [
            ['Pressure function', b.pseudo ? 'pseudo-pressure m(p), psi²/cp' : 'pressure (m(p) not in use)'],
            ['Reservoir temperature', fmt(b.T_F, 4) + ' °F'], ['Gas gravity', fmt(b.SG_g, 4)],
            ['m(p) at pi', isNum(b.mPi) ? fmt(b.mPi, 5) + ' psi²/cp' : '—'],
            ['Time function', b.pseudoTime ? 'normalised pseudo-time (reference ' + fmt(b.pseudoTimeInfo && b.pseudoTimeInfo.pNorm, 5) + ' psia)' : 'real time']
        ];
        var sl = st().semilog;
        if (sl && sl.ok && sl.pseudo) {
            kvs.push(['p1hr (from m(p))', fmt(sl.p1hr, 5) + ' psia']);
            if (isNum(sl.pStar)) kvs.push(['p* (from m*)', fmt(sl.pStar, 5) + ' psia']);
            if (isNum(sl.dmS)) kvs.push(['Skin Δm(p)S', fmt(sl.dmS, 4) + ' psi²/cp']);
        }
        return { id: 'gas', title: 'Gas analysis basis', order: 20, kv: kvs, notes: [b.correlations + '.'] };
    }
    function reportRateSkin() {
        var r = st().rateSkin;
        if (!r || !isNum(r.D) || (r.datasetHash && r.datasetHash !== dsHash())) return null;
        return {
            id: 'rateSkin', title: 'Rate-dependent skin', order: 25,
            kv: [['Rate-independent skin S', fmt(r.S, 4)], ['Non-Darcy coefficient D', fmt(r.D, 4) + ' per ' + (r.rateUnit || 'unit rate')], ['Fit R²', fmt(r.r2, 4)]],
            table: { head: ['Period', 'Rate q', 'S′'], rows: (r.rows || []).map(function (x) { return [x.label, fmt(x.q, 5), fmt(x.S, 4)]; }) },
            notes: ['S′ = S + D·q fitted to one straight-line skin per flow period (ERCB 1975).']
        };
    }
    function reportDeliv() {
        var d = st().deliverability;
        if (!d || !d.summary || (d.datasetHash && d.datasetHash !== dsHash())) return null;
        var s = d.summary;
        if (d.kind === 'gas') {
            return { id: 'deliverability', title: 'Gas deliverability (AOF)', order: 30,
                kv: [['p̄r', fmt(s.pr, 5) + ' psia (' + (d.prSource || '') + ')'], ['Back-pressure n', fmt(s.n, 4)], ['C', fmt(s.C, 4) + ' Mscf/d/psia²ⁿ'],
                     ['AOF (back-pressure)', fmt(s.aofCn, 5) + ' Mscf/d'], ['LIT a, b', isNum(s.a) ? fmt(s.a, 4) + ', ' + fmt(s.b, 4) : '—'],
                     ['AOF (LIT)', isNum(s.aofLit) ? fmt(s.aofLit, 5) + ' Mscf/d' : '—']],
                notes: ['Computed with the Gas Deliverability calculator engine; AOF at ' + fmt(s.pb, 4) + ' psia sandface back-pressure.'] };
        }
        return { id: 'deliverability', title: 'Oil inflow performance (IPR)', order: 30,
            kv: [['p̄r', fmt(s.pr, 5) + ' psia (' + (d.prSource || '') + ')'], ['Method', String(s.mode || '')], ['J', isNum(s.J) ? fmt(s.J, 4) + ' STB/d/psi' : '—'],
                 ['qmax', fmt(s.qmax, 5) + ' STB/d'], ['FE', fmt(s.fe, 3) + ' (' + (d.feSource || '') + ')']],
            notes: ['Computed with the Oil Well IPR calculator engine.'] };
    }
    (function registerReport() {
        var reg = G.PRiSM_reportSections = Array.isArray(G.PRiSM_reportSections) ? G.PRiSM_reportSections : [];
        [['gas-basis', reportGas], ['gas-rateskin', reportRateSkin], ['gas-deliverability', reportDeliv]].forEach(function (x) {
            x[1]._prismId = x[0];
            for (var i = 0; i < reg.length; i++) if (reg[i] && reg[i]._prismId === x[0]) { reg[i] = x[1]; return; }
            reg.push(x[1]);
        });
    })();

    // Refresh mounted panels on the shared events (no polling).
    if (!G.__PRiSM_gasListeners) {
        G.__PRiSM_gasListeners = true;
        ['prism:dataset-loaded', 'prism:well-changed', 'prism:period-changed'].forEach(function (type) {
            on(type, function (ev) {
                var src = ev && ev.detail && ev.detail.source;
                if (src === 'gas-options') return;
                rerender('prism_gas_root', renderGasPanel);
            });
        });
        on('prism:dataset-loaded', function () { _lastRateSkin = null; _lastDeliv = null; rerender('prism_rs_root', renderRateSkinPanel); rerender('prism_dl_root', renderDeliverabilityPanel); });
    }

    // =========================================================================
    // SECTION 8 — EXPORTS
    // =========================================================================
    G.PRiSM_gasPseudoTime = gasPseudoTime;
    G.PRiSM_gasSkinSummary = gasSkinSummary;
    G.PRiSM_gasBasis = gasBasis;
    G.PRiSM_setGasOption = setGasOption;
    G.PRiSM_skinVsRate = skinVsRate;
    G.PRiSM_deliverabilityPoints = deliverabilityPoints;
    G.PRiSM_gasDeliverability = gasDeliverability;
    G.PRiSM_oilDeliverability = oilDeliverability;
    G.PRiSM_deliverability = deliverability;
    G.PRiSM_renderGasPanel = renderGasPanel;
    G.PRiSM_renderRateSkinPanel = renderRateSkinPanel;
    G.PRiSM_renderDeliverabilityPanel = renderDeliverabilityPanel;

})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (typeof G.PRiSM_gasSkinSummary !== 'function') return;
    var checks = [];
    // Linear m(p) = 2p (μZ = 1): Δm_S = 0.8686·100·2 = 173.72 → ΔpS = 86.86 psi at pwf 1000.
    var tbl = { mOf: function (p) { return 2 * p; }, pOf: function (m) { return m / 2; } };
    var r = G.PRiSM_gasSkinSummary({ S: 2, m: 100, pbar: 2000, pwf: 1000, table: tbl });
    checks.push(['ΔpS', Math.abs(r.dpS - 86.86) < 1e-9]);
    checks.push(['FE', Math.abs(r.FE - (2000 - 173.72) / 2000) < 1e-12]);
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[52-prism-gas self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_gas_selfTest = checks;
})();
