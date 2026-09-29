// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Choke Performance & Critical Flow (chokeperf)
//
// PURPOSE (roadmap #9, method notes §1.3)
//   One surface bean (choke), sized in 64ths or decimal inches:
//     • critical pressure ratio (p2/p1)c = (2/(k+1))^(k/(k−1)), k = Cp/Cv from
//       the Gas PVT engine (WTS_gaspvt_k) or entered;
//     • dry-gas rate through the bean, subcritical and critical, from the
//       compressible-orifice (isentropic nozzle) equation with a discharge
//       coefficient Cd and Z at upstream conditions (WTS_gaspvt_compute, DAK);
//     • multiphase (gas–liquid) bean correlations of the form
//         q = p1 · S^b / (a · GLR^c)
//       with the published Gilbert, Ros, Baxendell and Achong constants;
//     • a chart of rate vs wellhead pressure for several bean sizes, with the
//       well's wellhead performance curve when the shut-in WHP is given;
//     • a bean-up planning table: next bean → expected rate and WHP.
//
// REFERENCES
//   Gas through a bean — isentropic nozzle flow of a perfect gas with a real-gas
//   Z at upstream conditions (e.g. Guo, Lyons & Ghalambor, Petroleum Production
//   Engineering, 2007, §5.2, Eqs. 5.3–5.8; Beggs, Gas Production Operations,
//   1984, ch. 5):
//       ṁ   = Cd·A·p1·√( 2·gc·M/(Z1·R·T1) · k/(k−1)·(r^(2/k) − r^((k+1)/k)) )
//       q_sc = ṁ / ρ_sc ,  ρ_sc = Pb·M/(R·Tb) ,  r = max(p2/p1, rc)
//   which in field units is
//       q[Mscf/d] = K_G · Cd · A[in²] · p1[psia] · √( k/(k−1)·(r^(2/k) − r^((k+1)/k)) / (γg·T1[°R]·Z1) )
//       K_G = 86.4 · Tb/(144·Pb) · √(2·gc·R/M_air) = 1243.2 at 60 °F / 14.696 psia
//   (Guo et al. round it to 1,248; the sonic form 879·√(2k/(k+1)·…) is the same
//   equation at r = rc: 879·√2 = 1243.1).
//   Critical ratio — (2/(k+1))^(k/(k−1)): 0.5283 for k = 1.4, 0.5457 for k = 1.3.
//   Multiphase bean correlations (critical flow), p1 psig, S bean in 64ths,
//   GLR scf/STB, q gross liquid STB/d — constants as tabulated by Guo et al.
//   (2007) Table 5.1 and Brown & Beggs, The Technology of Artificial Lift
//   Methods, Vol. 1 (1977):
//       Gilbert (1954)   a = 10.00  b = 1.89  c = 0.546
//       Ros (1960)       a = 17.40  b = 2.00  c = 0.500
//       Baxendell (1958) a =  9.56  b = 1.93  c = 0.546
//       Achong (1961)    a =  3.82  b = 1.88  c = 0.650
//     Gilbert, W.E. (1954) "Flowing and Gas-Lift Well Performance", API
//     Drilling & Production Practice, 126–157. Ros, N.C.J. (1960) "An Analysis
//     of Critical Simultaneous Gas/Liquid Flow Through a Restriction", Appl.
//     Sci. Res. 9, 374. Baxendell, P.B. (1958) and Achong, I. (1961) "Revised
//     Bean Performance Formula for Lake Maracaibo Wells" (Shell reports, as
//     tabulated in the references above).
//     Validity: critical flow through the bean — Gilbert: upstream pressure at
//     least 1.7 × downstream (p2/p1 ≤ 0.588, absolute).
//   Bean-up (Gilbert 1954 graphical method: the new rate is where the bean
//   performance line crosses the wellhead performance curve):
//     gas     wellhead back-pressure curve q = Cw·(pws² − pwh²)^n (Rawlins &
//             Schellhardt 1936 form written at the wellhead, psia), Cw from
//             the current point;
//     liquid  straight wellhead performance line from the shut-in WHP through
//             the current point (psig): pwh = pws − (pws − p1)·q/q0.
//   A measured current rate, when given, tunes the bean equation by
//   f = q_measured / q_calculated and is carried to the next beans.
//
// UNITS
//   Field units in and out (psig, °F, Mscf/d, STB/d, scf/STB). Standard gas
//   volumes at the app standard-conditions setting (WTS_baseConditions;
//   calculator default 60 °F / 14.696 psia). Bean sizes stay in 64ths and
//   inches (mm shown in Metric mode).
//
// PUBLIC API (window.*)
//   renderChokePerf(body)          paints the page into #pgBody
//   calcChokePerf()                reads the DOM, validates, computes, renders
//   WTS_chokeperf_compute(input)   pure → {ok, …} | {ok:false, errors[], keys[], bad[]}
//   WTS_chokeperf_criticalRatio(k)
//   WTS_chokeperf_gasRate({s64, cd, p1a, p2a, tR, sg, k, z, Tb_R, Pb})   Mscf/d
//   WTS_chokeperf_multiphaseRate(corrKey, p1psig, s64, glr)                STB/d
//   WTS_chokeperf_CORR             correlation constants {key: {name, a, b, c}}
//   WTS_chokeperf_BEANS            standard bean sizes, 64ths
//
// STATE
//   WTS_state.chokeperf = {ok, fluid, s64, sizeIn, q, qOil, rc, ratio, critical, k, z, f, beanUp[], ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var PATM = 14.696;                 // psia
    var RANKINE = 459.67;
    var GC = 32.174;                   // lbm·ft/(lbf·s²)
    var R_FT_LBF = 1545.35;            // ft·lbf/(lb-mol·°R)
    var MW_AIR = 28.9647;              // lb/lb-mol
    var GILBERT_CRIT = 0.588;          // p2/p1 (absolute) for critical multiphase flow — Gilbert (1954): p1 ≥ 1.7·p2
    var CORR = {
        gilbert:   { key: 'gilbert',   name: 'Gilbert (1954)',   a: 10.00, b: 1.89, c: 0.546 },
        ros:       { key: 'ros',       name: 'Ros (1960)',       a: 17.40, b: 2.00, c: 0.500 },
        baxendell: { key: 'baxendell', name: 'Baxendell (1958)', a: 9.56,  b: 1.93, c: 0.546 },
        achong:    { key: 'achong',    name: 'Achong (1961)',    a: 3.82,  b: 1.88, c: 0.650 }
    };
    var CORR_KEYS = ['gilbert', 'ros', 'baxendell', 'achong'];
    // Standard positive / adjustable bean sizes, 64ths of an inch.
    var BEANS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 104, 112, 120, 128];
    var N_BEANUP = 4;

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _opt(x) { return (x === '' || x == null) ? NaN : Number(x); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel, dMet) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _basis() {
        var B = G.WTS_baseConditions;
        if (B && typeof B.resolve === 'function') { try { var b = B.resolve(60, PATM); if (b && b.Tb_R > 0 && b.Pb_psia > 0) return b; } catch (e) { /* fall through */ } }
        return { Tb_F: 60, Tb_R: 519.67, Pb_psia: PATM, label: '60 °F / 14.696 psia', fromSetting: false };
    }
    function _size(s64) {
        var inch = s64 / 64;
        return s64.toFixed(Math.abs(s64 - Math.round(s64)) < 1e-9 ? 0 : 1) + '/64" (' + inch.toFixed(4) + '"' + (_metric() ? ', ' + _fmt(inch * 25.4, 2) + ' mm' : '') + ')';
    }

    // ── Pure compute ─────────────────────────────────────────────────
    function criticalRatio(k) { return Math.pow(2 / (k + 1), k / (k - 1)); }

    // K_G of the field-unit compressible-orifice equation (see header).
    function gasConst(Tb_R, Pb) { return 86.4 * Tb_R / (144 * Pb) * Math.sqrt(2 * GC * R_FT_LBF / MW_AIR); }

    // Dry-gas rate (Mscf/d at Tb/Pb) through a bean of s64/64 in, Cd, upstream
    // p1a psia, downstream p2a psia, T1 °R, gravity sg, Cp/Cv k, Z at upstream.
    function gasRate(o) {
        var k = o.k, rc = criticalRatio(k);
        var r = Math.max(o.p2a / o.p1a, rc);
        if (r >= 1) return 0;
        var br = k / (k - 1) * (Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k));
        if (!(br > 0)) return 0;
        var d = o.s64 / 64, A = Math.PI / 4 * d * d;
        var Tb = o.Tb_R > 0 ? o.Tb_R : 519.67, Pb = o.Pb > 0 ? o.Pb : PATM;
        return gasConst(Tb, Pb) * o.cd * A * o.p1a * Math.sqrt(br / (o.sg * o.tR * o.z));
    }

    // Gross liquid rate STB/d, p1 psig, S 64ths, GLR scf/STB.
    function multiphaseRate(key, p1, s64, glr) {
        var c = CORR[key];
        if (!c || !(glr > 0)) return NaN;
        return p1 * Math.pow(s64, c.b) / (c.a * Math.pow(glr, c.c));
    }

    function _nextBeans(s64) {
        var up = [], below = null;
        for (var i = 0; i < BEANS.length; i++) {
            if (BEANS[i] > s64 + 1e-9 && up.length < N_BEANUP) up.push(BEANS[i]);
            if (BEANS[i] < s64 - 1e-9) below = BEANS[i];
        }
        return { up: up, below: below };
    }

    function compute(input) {
        var i = input || {};
        var fluid = i.fluid === 'liquid' ? 'liquid' : 'gas';
        var s64 = Number(i.s64), p1 = Number(i.p1), p2 = _opt(i.p2);
        var tF = _opt(i.t), sg = _opt(i.sg), cd = _opt(i.cd);
        var co2 = _fin(_opt(i.co2)) ? Number(i.co2) : 0, h2s = _fin(_opt(i.h2s)) ? Number(i.h2s) : 0, n2 = _fin(_opt(i.n2)) ? Number(i.n2) : 0;
        var kIn = _opt(i.k), zIn = _opt(i.z);
        var glr = _opt(i.glr), wc = _fin(_opt(i.wc)) ? Number(i.wc) : 0;
        var corrKey = CORR[i.corr] ? i.corr : 'gilbert';
        var pws = _opt(i.pws), qm = _opt(i.qm), nBp = _fin(_opt(i.n)) ? Number(i.n) : 1;
        var errors = [], keys = [], bad = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        if (!(_fin(s64) && s64 >= 2 && s64 <= 192)) err('size', 'Bean size must be between 2/64" and 192/64" (0.031" to 3").');
        if (!(_fin(p1) && p1 > 0 && p1 <= 20000)) err('p1', 'Upstream (wellhead) pressure must be above 0 and no more than 20,000 psig.');
        if (fluid === 'gas') {
            if (!(_fin(p2) && p2 > -PATM)) err('p2', 'Downstream pressure is required for gas and must be above full vacuum (−14.696 psig).');
            else if (_fin(p1) && !(p2 < p1)) err('p2', 'Downstream pressure must be below the upstream pressure.');
            if (!(_fin(tF) && tF >= -40 && tF <= 400)) err('t', 'Upstream temperature must be between −40 and 400 °F.');
            if (!(_fin(sg) && sg >= 0.55 && sg <= 3)) err('sg', 'Gas gravity must be between 0.55 and 3.0 (air = 1).');
            if (!(_fin(cd) && cd >= 0.5 && cd <= 1.2)) err('cd', 'Discharge coefficient Cd must be between 0.5 and 1.2.');
            if (!(co2 >= 0 && co2 < 100 && h2s >= 0 && h2s < 100 && n2 >= 0 && n2 < 100 && co2 + h2s + n2 < 95)) err('co2', 'CO2, H2S and N2 must each be 0–100 mol % and total below 95 %.');
            if (_fin(kIn) && !(kIn > 1 && kIn <= 1.67)) err('k', 'Cp/Cv (k) must be above 1.0 and no more than 1.67 (or leave blank to calculate it).');
            if (_fin(zIn) && !(zIn >= 0.2 && zIn <= 2)) err('z', 'Z must be between 0.2 and 2.0 (or leave blank to calculate it).');
            if (_fin(nBp) && !(nBp >= 0.5 && nBp <= 1)) err('n', 'Back-pressure exponent n must be between 0.5 and 1.0.');
        } else {
            if (_fin(p2) && !(p2 > -PATM && p2 < p1)) err('p2', 'Downstream pressure must be above full vacuum and below the upstream pressure (or leave it blank).');
            if (!(_fin(glr) && glr >= 10 && glr <= 100000)) err('glr', 'Gas–liquid ratio must be between 10 and 100,000 scf/STB.');
            if (!(wc >= 0 && wc < 100)) err('wc', 'Water cut must be at least 0 and below 100 %.');
        }
        if (_fin(pws) && _fin(p1) && !(pws > p1)) err('pws', 'Shut-in wellhead pressure must be above the flowing (upstream) pressure (or leave it blank).');
        if (_fin(pws) && !(pws <= 20000)) err('pws', 'Shut-in wellhead pressure must be no more than 20,000 psig.');
        if (_fin(qm) && !(qm > 0)) err('qm', 'Measured rate must be above 0 (or leave it blank).');
        if (errors.length) return { ok: false, errors: errors, keys: keys, bad: bad };

        var nb = _nextBeans(s64);
        var out = { ok: true, fluid: fluid, s64: s64, sizeIn: s64 / 64, areaIn2: Math.PI / 4 * Math.pow(s64 / 64, 2), p1: p1, p2: _fin(p2) ? p2 : null,
            pws: _fin(pws) ? pws : null, qm: _fin(qm) ? qm : null, warnings: [], beanUp: [], chartBeans: [] };
        out.chartBeans = (nb.below != null ? [nb.below] : []).concat([s64], nb.up.slice(0, 3));

        if (fluid === 'gas') {
            var basis = _basis();
            var TR = tF + RANKINE, p1a = p1 + PATM, p2a = p2 + PATM;
            // k and Z: entered, or from the Gas PVT engine (Sutton + Kay + Wichert–Aziz, DAK Z; ideal-gas Cp°/Cv°).
            var pvt = null, L = G.PRiSM_pvt_correlations;
            var needPvt = !_fin(kIn) || !_fin(zIn);
            if (needPvt) {
                if (typeof G.WTS_gaspvt_compute !== 'function' || !L) {
                    return { ok: false, keys: ['k'], bad: ['k', 'z'], errors: ['The Gas PVT engine is not loaded: enter Cp/Cv (k) and Z.'] };
                }
                pvt = G.WTS_gaspvt_compute({ sg: sg, p: p1a, t: tF, co2: co2, h2s: h2s, n2: n2 });
                if (!pvt.ok) return { ok: false, keys: pvt.keys || [], bad: (pvt.bad || []).map(function (b) { return b === 'p' ? 'p1' : b; }), errors: pvt.errors.slice() };
            }
            var k = _fin(kIn) ? kIn : pvt.k;
            var zAt = _fin(zIn) ? function () { return zIn; } : function (pa) { return L.Z_dranchukAbouKassem(TR / pvt.Tpc, pa / pvt.Ppc); };
            var z1 = _fin(zIn) ? zIn : pvt.z;
            var rc = criticalRatio(k), ratio = p2a / p1a;
            function qc(s, pa, f) {
                return (f || 1) * gasRate({ s64: s, cd: cd, p1a: pa, p2a: p2a, tR: TR, sg: sg, k: k, z: zAt(pa), Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            }
            var q = gasRate({ s64: s64, cd: cd, p1a: p1a, p2a: p2a, tR: TR, sg: sg, k: k, z: z1, Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            var qCrit = gasRate({ s64: s64, cd: cd, p1a: p1a, p2a: 0, tR: TR, sg: sg, k: k, z: z1, Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            var f = _fin(qm) ? qm / q : 1;
            Object.assign(out, {
                k: k, kSrc: _fin(kIn) ? 'input' : 'gaspvt', z: z1, zSrc: _fin(zIn) ? 'input' : 'gaspvt',
                rc: rc, ratio: ratio, critical: ratio <= rc, q: q, qCrit: qCrit, f: f, q0: _fin(qm) ? qm : q,
                p2CritMax: rc * p1a - PATM, KG: gasConst(basis.Tb_R, basis.Pb_psia), basis: basis, tF: tF, sg: sg, cd: cd, n: nBp
            });
            if (_fin(qm) && (f < 0.7 || f > 1.3)) out.warnings.push('Measured rate is ' + _fmt(100 * (f - 1), 0) + ' % off the bean equation: check the bean size, Cd, erosion of the bean, or liquid loading.');
            // Bean-up: wellhead back-pressure curve through the current point.
            if (_fin(pws)) {
                var pwsa = pws + PATM, q0 = out.q0;
                var Cw = q0 / Math.pow(pwsa * pwsa - p1a * p1a, nBp);
                out.Cw = Cw;
                var qw = function (pa) { return pa >= pwsa ? 0 : Cw * Math.pow(pwsa * pwsa - pa * pa, nBp); };
                out.qwAt = qw;
                nb.up.forEach(function (s) {
                    var lo = p2a, hi = pwsa;
                    for (var it = 0; it < 100; it++) { var m = (lo + hi) / 2; if (qc(s, m, f) > qw(m)) hi = m; else lo = m; }
                    var pwh = (lo + hi) / 2, qn = qw(pwh);
                    out.beanUp.push({ s64: s, q: qn, pwh: pwh - PATM, dqPct: 100 * (qn / q0 - 1), critical: p2a / pwh <= rc });
                });
            } else {
                nb.up.forEach(function (s) {
                    var qn = qc(s, p1a, f);
                    out.beanUp.push({ s64: s, q: qn, pwh: null, dqPct: 100 * (qn / out.q0 - 1), critical: ratio <= rc });
                });
            }
            out.qcAt = function (s, pwhG) { return qc(s, pwhG + PATM, f); };
            out.pMin = p2;
        } else {
            var rates = {}, table = [];
            CORR_KEYS.forEach(function (key) {
                var qq = multiphaseRate(key, p1, s64, glr);
                rates[key] = qq;
                table.push({ key: key, name: CORR[key].name, a: CORR[key].a, b: CORR[key].b, c: CORR[key].c, q: qq, qOil: qq * (1 - wc / 100) });
            });
            var qSel = rates[corrKey], fl = _fin(qm) ? qm / qSel : 1;
            var qMin = Math.min.apply(null, CORR_KEYS.map(function (k2) { return rates[k2]; }));
            var qMax = Math.max.apply(null, CORR_KEYS.map(function (k2) { return rates[k2]; }));
            var ratioL = _fin(p2) ? (p2 + PATM) / (p1 + PATM) : null;
            var Kof = function (s) { return fl * Math.pow(s, CORR[corrKey].b) / (CORR[corrKey].a * Math.pow(glr, CORR[corrKey].c)); };
            Object.assign(out, {
                corr: corrKey, corrName: CORR[corrKey].name, glr: glr, wc: wc, table: table, rates: rates,
                q: qSel, qOil: qSel * (1 - wc / 100), f: fl, q0: _fin(qm) ? qm : qSel, spreadPct: 100 * (qMax / qMin - 1),
                rc: GILBERT_CRIT, ratio: ratioL, critical: ratioL == null ? null : ratioL <= GILBERT_CRIT,
                p2CritMax: GILBERT_CRIT * (p1 + PATM) - PATM
            });
            if (_fin(qm) && (fl < 0.7 || fl > 1.3)) out.warnings.push('Measured rate is ' + _fmt(100 * (fl - 1), 0) + ' % off ' + CORR[corrKey].name + ': the correlation constants are field fits — tuning is applied to the bean-up.');
            if (_fin(pws)) {
                var q0l = out.q0;
                nb.up.forEach(function (s) {
                    // Straight wellhead line through (0, pws) and (q0, p1) meets q = K(S)·pwh:
                    //   pwh = q0·pws / (K(S)·(pws − p1) + q0)
                    var K = Kof(s), pwhN = q0l * pws / (K * (pws - p1) + q0l), qn = K * pwhN;
                    out.beanUp.push({ s64: s, q: qn, qOil: qn * (1 - wc / 100), pwh: pwhN, dqPct: 100 * (qn / q0l - 1),
                        critical: _fin(p2) ? (p2 + PATM) / (pwhN + PATM) <= GILBERT_CRIT : null });
                });
                out.qwAt = function (pwhG) { return pwhG >= pws ? 0 : q0l * (pws - pwhG) / (pws - p1); };
            } else {
                nb.up.forEach(function (s) {
                    var qn = Kof(s) * p1;
                    out.beanUp.push({ s64: s, q: qn, qOil: qn * (1 - wc / 100), pwh: null, dqPct: 100 * (qn / out.q0 - 1), critical: out.critical });
                });
            }
            out.qcAt = function (s, pwhG) { return Kof(s) * pwhG; };
            out.pMin = 0;
        }
        if (!nb.up.length) out.warnings.push('The bean is at or above the largest standard size (128/64"): no bean-up rows.');
        if (!_fin(pws)) out.warnings.push('Shut-in WHP not given: bean-up rates are at the current WHP (an upper bound; the WHP falls as the rate rises).');
        return out;
    }

    G.WTS_chokeperf_compute = compute;
    G.WTS_chokeperf_criticalRatio = criticalRatio;
    G.WTS_chokeperf_gasRate = gasRate;
    G.WTS_chokeperf_multiphaseRate = multiphaseRate;
    G.WTS_chokeperf_CORR = CORR;
    G.WTS_chokeperf_BEANS = BEANS.slice();

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Choke Performance & Critical Flow';
    var SUB = 'Critical pressure ratio, gas and multiphase flow through a bean (Gilbert, Ros, Baxendell, Achong), rate vs WHP for several beans and bean-up planning';
    var UNITS = {
        ck_p1: 'pressureG', ck_p2: 'pressureG', ck_t: 'temperature', ck_sg: 'sg',
        ck_co2: 'percent', ck_h2s: 'percent', ck_n2: 'percent',
        ck_glr: 'gor', ck_wc: 'percent', ck_pws: 'pressureG', ck_qmg: 'gasRateSmall', ck_qml: 'liquidRate'
    };
    var IDS = { size: 'ck_size', p1: 'ck_p1', p2: 'ck_p2', t: 'ck_t', sg: 'ck_sg', cd: 'ck_cd', co2: 'ck_co2', h2s: 'ck_h2s', n2: 'ck_n2',
        k: 'ck_k', z: 'ck_z', n: 'ck_n', glr: 'ck_glr', wc: 'ck_wc', pws: 'ck_pws', qm: 'ck_qmg', qmL: 'ck_qml' };
    var GAS_ONLY = ['ck_t', 'ck_sg', 'ck_cd', 'ck_co2', 'ck_h2s', 'ck_n2', 'ck_k', 'ck_z', 'ck_n', 'ck_qmg'];
    var LIQ_ONLY = ['ck_glr', 'ck_wc', 'ck_corr', 'ck_qml'];
    // Validation messages in the display system (limits are imperial).
    var MSG = {
        p1: function () { return 'Upstream (wellhead) pressure must be above 0 and no more than ' + _u(20000, 'pressureG', 0, 'psig') + '.'; },
        t: function () { return 'Upstream temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        glr: function () { return 'Gas–liquid ratio must be between ' + _u(10, 'gor', 0, 'scf/STB', 1) + ' and ' + _u(100000, 'gor', 0, 'scf/STB') + '.'; }
    };

    function _fg(id, label, val, extra, hint) {
        return '<div class="fg-item" id="' + id + '_fg"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '>' +
            (hint ? '<span style="font-size:10px;color:var(--text3)">' + hint + '</span>' : '') + '</div>';
    }
    function _sel(id, label, opts) {
        return '<div class="fg-item" id="' + id + '_fg"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
            opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[2] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _qTxt(r, q, d) { return r.fluid === 'gas' ? _u(q, 'gasRateSmall', d == null ? 0 : d, 'MSCF/D') : _u(q, 'liquidRate', d == null ? 0 : d, 'BPD', 1); }

    function _resultsHtml(r) {
        var h = '', met = _metric();
        h += '<div class="rbox"><div class="rbox-title">Bean</div>' +
            _row('Bean size', _size(r.s64)) +
            _row('Bean area', met ? _fmt(r.areaIn2 * 645.16, 1) + ' mm²' : _fmt(r.areaIn2, 5) + ' in²') +
            _row('Upstream (wellhead) pressure', _u(r.p1, 'pressureG', 0, 'psig')) +
            (r.p2 != null ? _row('Downstream pressure', _u(r.p2, 'pressureG', 0, 'psig')) : '') + '</div>';
        if (r.fluid === 'gas') {
            h += '<div class="rbox"><div class="rbox-title">Gas Flow Through the Bean</div>' +
                _row('Cp/Cv (k)', _fmt(r.k, 4) + (r.kSrc === 'input' ? ' (entered)' : ' (Gas PVT, ideal gas at T1)')) +
                _row('Z at upstream conditions', _fmt(r.z, 4) + (r.zSrc === 'input' ? ' (entered)' : ' (Gas PVT, DAK)')) +
                _row('Critical pressure ratio (p2/p1)c', _fmt(r.rc, 4)) +
                _row('Actual ratio p2/p1 (absolute)', _fmt(r.ratio, 4)) +
                _row('Flow regime', r.critical ? 'Critical (sonic)' : 'Subcritical') +
                _row('Gas rate', _qTxt(r, r.q, 0) + (met ? '' : ' (' + _fmt(r.q / 1000, 3) + ' MMSCF/D)')) +
                _row('Critical-flow rate at this p1', _qTxt(r, r.qCrit, 0)) +
                _row('Highest downstream pressure for critical flow', _u(r.p2CritMax, 'pressureG', 0, 'psig')) +
                _row('Discharge coefficient Cd', _fmt(r.cd, 3)) +
                (r.qm != null ? _row('Tuning factor f = measured / calculated', _fmt(r.f, 3)) : '') + '</div>';
        } else {
            h += '<div class="rbox"><div class="rbox-title">Multiphase Bean Correlations</div>' +
                _row('Selected correlation', r.corrName) +
                _row('Liquid rate (selected)', _qTxt(r, r.q, 0)) +
                _row('Oil rate (selected)', _qTxt(r, r.qOil, 0)) +
                _row('Gas–liquid ratio', _u(r.glr, 'gor', 0, 'scf/STB', 1)) +
                (r.ratio != null ? _row('Actual ratio p2/p1 (absolute)', _fmt(r.ratio, 4)) : '') +
                _row('Highest downstream pressure for critical flow', _u(r.p2CritMax, 'pressureG', 0, 'psig')) +
                _row('Spread between correlations', _fmt(r.spreadPct, 1) + ' %') +
                (r.qm != null ? _row('Tuning factor f = measured / calculated', _fmt(r.f, 3)) : '') +
                '<div style="overflow-x:auto"><table class="dtable"><thead><tr><th>Correlation</th><th>a</th><th>b</th><th>c</th>' +
                '<th>Liquid (' + _lab('liquidRate', 'BPD') + ')</th><th>Oil (' + _lab('liquidRate', 'BPD') + ')</th></tr></thead><tbody>';
            r.table.forEach(function (t) {
                h += '<tr><td>' + t.name + (t.key === r.corr ? ' *' : '') + '</td><td>' + _fmt(t.a, 2) + '</td><td>' + _fmt(t.b, 2) + '</td><td>' + _fmt(t.c, 3) +
                    '</td><td>' + _fmt(_dv(t.q, 'liquidRate'), met ? 1 : 0) + '</td><td>' + _fmt(_dv(t.qOil, 'liquidRate'), met ? 1 : 0) + '</td></tr>';
            });
            h += '</tbody></table></div><div style="font-size:11px;color:var(--text3)">q = p1·S^b / (a·GLR^c): p1 psig, S in 64ths, GLR scf/STB, q STB/d gross liquid. * selected.</div></div>';
        }
        // Checks
        var v = '';
        if (r.fluid === 'gas') {
            v += r.critical ? _ok('Critical (sonic) flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' ≤ ' + _fmt(r.rc, 3) + ' — the rate does not depend on the downstream pressure.')
                : _warn('Subcritical flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' > ' + _fmt(r.rc, 3) + ' — the rate depends on the downstream pressure.');
        } else if (r.critical == null) {
            v += _warn('Downstream pressure not given: critical flow (p2/p1 ≤ 0.588) is assumed; the correlations do not apply to subcritical flow.');
        } else {
            v += r.critical ? _ok('Critical flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' ≤ 0.588 (Gilbert) — the bean correlations apply.')
                : _warn('Not critical: p2/p1 = ' + _fmt(r.ratio, 3) + ' > 0.588 — the bean correlations over-predict the rate.');
        }
        r.warnings.forEach(function (w) { v += _warn(w); });
        h += '<div class="rbox"><div class="rbox-title">Checks</div>' + v + '</div>';
        // Bean-up
        var qL = r.fluid === 'gas' ? _lab('gasRateSmall', 'MSCF/D') : _lab('liquidRate', 'BPD');
        h += '<div class="rbox"><div class="rbox-title">Bean-up Planning</div>';
        if (r.beanUp.length) {
            h += '<div style="overflow-x:auto"><table class="dtable" id="ck_btbl"><thead><tr><th>Bean</th><th>Rate (' + qL + ')</th>' +
                (r.fluid === 'liquid' ? '<th>Oil (' + qL + ')</th>' : '') + '<th>WHP (' + _lab('pressureG', 'psig') + ')</th><th>Change</th><th>Flow</th></tr></thead><tbody>';
            var qd = r.fluid === 'gas' ? 0 : (met ? 1 : 0);
            h += '<tr><td>' + _size(r.s64) + ' now</td><td>' + _fmt(_dv(r.q0, r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate'), qd) + '</td>' +
                (r.fluid === 'liquid' ? '<td>' + _fmt(_dv(r.q0 * (1 - r.wc / 100), 'liquidRate'), qd) + '</td>' : '') +
                '<td>' + _fmt(_dv(r.p1, 'pressureG'), 0) + '</td><td>—</td><td>' + (r.critical === false ? 'subcritical' : 'critical') + '</td></tr>';
            r.beanUp.forEach(function (b) {
                h += '<tr><td>' + _size(b.s64) + '</td><td>' + _fmt(_dv(b.q, r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate'), qd) + '</td>' +
                    (r.fluid === 'liquid' ? '<td>' + _fmt(_dv(b.qOil, 'liquidRate'), qd) + '</td>' : '') +
                    '<td>' + (b.pwh == null ? '(held)' : _fmt(_dv(b.pwh, 'pressureG'), 0)) + '</td><td>' + (b.dqPct >= 0 ? '+' : '') + _fmt(b.dqPct, 1) + ' %</td>' +
                    '<td>' + (b.critical == null ? '—' : b.critical ? 'critical' : 'subcritical') + '</td></tr>';
            });
            h += '</tbody></table></div>';
            if (r.fluid === 'liquid' && r.beanUp.some(function (b) { return b.critical === false; })) h += _warn('Some bean-up rows are not in critical flow: the WHP falls below 1.7 × the downstream pressure, so those rates read high.');
            if (r.fluid === 'gas' && r.beanUp.some(function (b) { return b.critical === false; })) h += _warn('Some bean-up rows are subcritical: the downstream pressure now controls the rate.');
        }
        h += '<div class="chart-wrap"><canvas id="ck_chart" width="600" height="340"></canvas></div></div>';
        // Notes
        h += '<div><b>Notes</b> ' + (r.fluid === 'gas'
            ? 'Gas: isentropic compressible-orifice (nozzle) equation with discharge coefficient Cd, ideal-gas k and Z at upstream conditions; q = ' + _fmt(r.KG, 1) +
              '·Cd·A·p1·√(k/(k−1)·(r^(2/k) − r^((k+1)/k))/(γg·T1·Z1)), r = max(p2/p1, rc). Dry gas only — liquids raise the pressure drop. Standard volumes at ' + r.basis.label + '. ' +
              'Bean-up: wellhead back-pressure curve q = Cw·(pws² − pwh²)^n (absolute pressures, n = ' + _fmt(r.n, 2) + ') through the current point. '
            : 'Multiphase: Gilbert (1954), Ros (1960), Baxendell (1958) and Achong (1961) bean correlations, q = p1·S^b/(a·GLR^c), valid for critical flow (p1 ≥ 1.7·p2). ' +
              'They give gross liquid; oil = liquid × (1 − water cut). Upstream pressure is gauge, as in Gilbert\'s original chart. ' +
              'Bean-up: straight wellhead performance line from the shut-in WHP through the current point. ') +
            'A measured current rate tunes the bean equation and is carried to the next beans. Bean-up is a planning screen — the real wellhead performance ' +
            'bends with GLR and reservoir drawdown; step up one bean at a time and re-test.</div>';
        return h;
    }

    var COLORS = ['#8b949e', '#f0883e', '#58a6ff', '#3fb950', '#d2a8ff'];
    function _drawChart(r) {
        var cv = _byId('ck_chart');
        if (!cv || typeof drawLineChart !== 'function') return;   // host-scope helper when injected
        var qCat = r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate';
        var pTop = Math.max(r.pws != null ? r.pws : 0, r.p1 * 1.25);
        var p0 = r.fluid === 'gas' ? r.pMin : 0;
        var ds = [], N = 40;
        r.chartBeans.forEach(function (s, j) {
            var pts = [];
            for (var i = 0; i <= N; i++) {
                var p = p0 + (pTop - p0) * i / N, q = r.qcAt(s, p);
                if (_fin(q)) pts.push({ x: _dv(p, 'pressureG'), y: _dv(q, qCat) });
            }
            ds.push({ label: s + '/64"' + (s === r.s64 ? ' (now)' : ''), color: s === r.s64 ? COLORS[1] : COLORS[(j + 2) % COLORS.length], data: pts, points: false, width: s === r.s64 ? 2.5 : 1.5, dash: s < r.s64 ? [4, 4] : undefined });
        });
        if (r.pws != null && r.qwAt) {
            var w = [];
            for (var k = 0; k <= N; k++) {
                var pw = p0 + (r.pws - p0) * k / N;
                w.push({ x: _dv(pw, 'pressureG'), y: _dv(r.fluid === 'gas' ? r.qwAt(pw + PATM) : r.qwAt(pw), qCat) });
            }
            ds.push({ label: 'Wellhead performance', color: '#e6edf3', data: w, points: false, width: 1.5, dash: [6, 4] });
        }
        var op = [{ x: _dv(r.p1, 'pressureG'), y: _dv(r.q0, qCat) }];
        r.beanUp.forEach(function (b) { if (b.pwh != null) op.push({ x: _dv(b.pwh, 'pressureG'), y: _dv(b.q, qCat) }); });
        ds.push({ label: 'Operating points', color: '#ff7b72', data: op, points: true, width: 0.001 });
        try {
            drawLineChart(cv, ds, { xLabel: 'Wellhead pressure (' + _lab('pressureG', 'psig') + ')', yLabel: 'Rate (' + _lab(qCat, r.fluid === 'gas' ? 'MSCF/D' : 'BPD') + ')', xMin: _dv(p0, 'pressureG'), yMin: 0, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _readInputs() {
        var fluid = _str('ck_fluid') === 'liquid' ? 'liquid' : 'gas';
        var size = _num('ck_size'), unit = _str('ck_sunit');
        return {
            fluid: fluid, s64: unit === 'in' ? size * 64 : size,
            p1: _num('ck_p1'), p2: _num('ck_p2'), t: _num('ck_t'), sg: _num('ck_sg'), cd: _num('ck_cd'),
            co2: _num('ck_co2'), h2s: _num('ck_h2s'), n2: _num('ck_n2'), k: _num('ck_k'), z: _num('ck_z'), n: _num('ck_n'),
            glr: _num('ck_glr'), wc: _num('ck_wc'), corr: _str('ck_corr'), pws: _num('ck_pws'),
            qm: fluid === 'gas' ? _num('ck_qmg') : _num('ck_qml')
        };
    }

    function _showFields(fluid) {
        GAS_ONLY.forEach(function (id) { var e = _byId(id + '_fg'); if (e && e.style) e.style.display = fluid === 'gas' ? '' : 'none'; });
        LIQ_ONLY.forEach(function (id) { var e = _byId(id + '_fg'); if (e && e.style) e.style.display = fluid === 'liquid' ? '' : 'none'; });
    }

    function _calcImpl() {
        var root = _byId('ck_root'), res = _byId('ck_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input, select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var inp = _readInputs();
        _showFields(inp.fluid);
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.chokeperf = { ok: false, errors: r.errors.slice(), q: null, ts: Date.now() };
            var items = '';
            for (var j = 0; j < r.errors.length; j++) {
                var k = r.keys && r.keys[j];
                items += '<li>' + (k && MSG[k] ? MSG[k](r) : r.errors[j]) + '</li>';
            }
            for (var b = 0; b < r.bad.length; b++) {
                var id = r.bad[b] === 'qm' && inp.fluid === 'liquid' ? IDS.qmL : IDS[r.bad[b]];
                var el = _byId(id); if (el && el.classList) el.classList.add('input-err');
            }
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            return r;
        }
        G.WTS_state.chokeperf = {
            ok: true, fluid: r.fluid, s64: r.s64, sizeIn: r.sizeIn, q: r.q, qOil: r.qOil == null ? null : r.qOil, q0: r.q0,
            rc: r.rc, ratio: r.ratio, critical: r.critical, k: r.k == null ? null : r.k, z: r.z == null ? null : r.z,
            kSrc: r.kSrc || null, zSrc: r.zSrc || null, qCrit: r.qCrit == null ? null : r.qCrit, f: r.f, corr: r.corr || null,
            rates: r.rates || null, beanUp: r.beanUp.map(function (x) { return { s64: x.s64, q: x.q, pwh: x.pwh, critical: x.critical }; }),
            ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            res.setAttribute('data-done', '1');
            _drawChart(r);
        }
        return r;
    }

    G.calcChokePerf = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="ck_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Bean and Pressures</div><div class="fg">' +
            _sel('ck_fluid', 'Flow through the bean', [['gas', 'Dry gas', true], ['liquid', 'Oil well — gas + liquid (multiphase)']]) +
            _fg('ck_size', 'Bean size', '24', ' min="0"') +
            _sel('ck_sunit', 'Bean size in', [['64', '64ths of an inch', true], ['in', 'Decimal inches']]) +
            _fg('ck_p1', 'Upstream pressure, WHP (psig)', '1500') +
            _fg('ck_p2', 'Downstream pressure (psig)', '400', '', 'Gas: required. Multiphase: optional, for the critical-flow check.') +
            _fg('ck_cd', 'Discharge coefficient Cd', '0.85', ' min="0.5" max="1.2"', 'Typical 0.82–0.86 for positive beans.') +
            _sel('ck_corr', 'Bean correlation (for bean-up)', CORR_KEYS.map(function (k) { return [k, CORR[k].name, k === 'gilbert']; })) +
            '</div></div>' +
            '<div class="card"><div class="card-title">Fluid</div><div class="fg">' +
            _fg('ck_t', 'Upstream temperature (°F)', '120') +
            _fg('ck_sg', 'Gas gravity (air = 1)', '0.7', ' min="0.55"') +
            _fg('ck_co2', 'CO2 (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_h2s', 'H2S (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_n2', 'N2 (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_k', 'Cp/Cv k (blank = Gas PVT)', '', ' min="1" placeholder="calculated"') +
            _fg('ck_z', 'Z at upstream (blank = Gas PVT)', '', ' min="0" placeholder="calculated"') +
            _fg('ck_glr', 'Gas–liquid ratio (SCF/STB)', '800', ' min="0"') +
            _fg('ck_wc', 'Water cut (%)', '0', ' min="0" max="100"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Bean-up Planning</div><div class="fg">' +
            _fg('ck_pws', 'Shut-in wellhead pressure (psig)', '2500', ' min="0" placeholder="blank = hold WHP"') +
            _fg('ck_qmg', 'Measured gas rate now, optional (MSCFD)', '', ' min="0" placeholder="blank = calculated"') +
            _fg('ck_qml', 'Measured liquid rate now, optional (BPD)', '', ' min="0" placeholder="blank = calculated"') +
            _fg('ck_n', 'Back-pressure exponent n (gas)', '1', ' min="0.5" max="1"', '1 = laminar; 0.5 = fully turbulent.') +
            '</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="ck_calc" onclick="calcChokePerf()">Calculate</button></div>' +
            '</div>' +
            '</div>' +
            '<div id="ck_res"></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('ck_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^ck_/.test(e.target.id || '')) G.calcChokePerf();
            });
        }
        G.calcChokePerf();
    }
    G.renderChokePerf = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.chokeperf = {
        key: 'chokeperf',
        title: TITLE,
        navTitle: 'Choke Performance',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9678;',
        badge: 'Well Testing',
        bc: 'dc-b-green',
        desc: 'Critical ratio, gas rate through a bean (Cd), Gilbert/Ros/Baxendell/Achong multiphase beans, rate vs WHP chart and bean-up planning.',
        render: function (body) { return G.renderChokePerf(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('ck_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcChokePerf();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (typeof G.WTS_chokeperf_compute !== 'function') return;
    var fails = [], n = 0;
    function near(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol)) fails.push(what + ': got ' + a + ', expected ' + b); }
    // Critical ratio: 0.5283 at k = 1.4, 0.5457 at k = 1.3 (textbook values)
    near(G.WTS_chokeperf_criticalRatio(1.4), 0.5283, 1e-4, 'rc 1.4');
    near(G.WTS_chokeperf_criticalRatio(1.3), 0.5457, 1e-4, 'rc 1.3');
    // Gilbert, 1500 psig, 32/64, GLR 1000 scf/STB: 1500·32^1.89/(10·1000^0.546)
    near(G.WTS_chokeperf_multiphaseRate('gilbert', 1500, 32, 1000), 1500 * Math.pow(32, 1.89) / (10 * Math.pow(1000, 0.546)), 1e-6, 'gilbert');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[chokeperf self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[chokeperf self-test] ' + n + '/' + n + ' checks passed');
    }
})();
