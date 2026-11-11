// Well Performance page test double (WP9) — NOT shipped, NOT an engine.
//
// The page (49-calc-wellperf.js) is built against the WP0 contracts while the engines (WP1–WP7) land on their own branches.
// installWellPerfMock(G, opts) replaces the WP0 stubs of window G with small closed-form stand-ins that return the CONTRACT
// SHAPES (tests/_wellperf-shapes.js: SHAPE.R, SHAPE.I, the W / schematic / loading / check / Job objects of the stub headers),
// so the page tests and the screenshot run exercise every page path. The numbers are plausible, not physics: a straight-line or
// Vogel-like inflow, a VLP with a gas-lightening gravity term, a q² friction term and a Gilbert-form choke; minimum curvature
// for the survey. Real engine results are covered by the engines' own tests (wellperf-pvt / -ipr / -vlp / -well / -system …).
//
// Also loaded by the screenshot script as plain browser code (the function is self-contained; module.exports is optional).
'use strict';

function installWellPerfMock(G, opts) {
    opts = opts || {};
    var calls = { solve: 0, build: 0, schematic: 0, check: 0 };
    var PATM = 14.696, D2R = Math.PI / 180;
    function fin(v) { return typeof v === 'number' && isFinite(v); }
    function num(v, d) { return fin(v) ? v : d; }
    function w(code, msg, sev) { return { code: code, msg: msg, sev: sev || 'warn' }; }

    // ── well path: minimum curvature (3-column survey) or MD / TVD pairs ───────
    function stations(survey) {
        var sv = (survey || []).slice(), out = [];
        if (!sv.length) return out;
        if (sv[0].length >= 3) {
            var n = 0, e = 0, tvd = sv[0][0] * Math.cos(sv[0][1] * D2R);
            out.push({ md: sv[0][0], tvd: tvd, inc: sv[0][1], azi: sv[0][2], n: 0, e: 0, dep: 0, dls: 0 });
            for (var i = 1; i < sv.length; i++) {
                var a = sv[i - 1], b = sv[i], dm = b[0] - a[0];
                var i1 = a[1] * D2R, i2 = b[1] * D2R, a1 = a[2] * D2R, a2 = b[2] * D2R;
                var cosb = Math.cos(i2 - i1) - Math.sin(i1) * Math.sin(i2) * (1 - Math.cos(a2 - a1)), beta = Math.acos(Math.max(-1, Math.min(1, cosb)));
                var rf = beta > 1e-9 ? (2 / beta) * Math.tan(beta / 2) : 1;
                n += dm / 2 * (Math.sin(i1) * Math.cos(a1) + Math.sin(i2) * Math.cos(a2)) * rf;
                e += dm / 2 * (Math.sin(i1) * Math.sin(a1) + Math.sin(i2) * Math.sin(a2)) * rf;
                tvd += dm / 2 * (Math.cos(i1) + Math.cos(i2)) * rf;
                out.push({ md: b[0], tvd: tvd, inc: b[1], azi: b[2], n: n, e: e, dep: Math.hypot(n, e), dls: dm > 0 ? beta / D2R * 100 / dm : 0 });
            }
        } else {
            var dep = 0;
            out.push({ md: sv[0][0], tvd: sv[0][1], inc: 0, azi: 0, n: 0, e: 0, dep: 0, dls: 0 });
            for (var j = 1; j < sv.length; j++) {
                var dmd = sv[j][0] - sv[j - 1][0], dt = sv[j][1] - sv[j - 1][1], h = Math.sqrt(Math.max(0, dmd * dmd - dt * dt));
                dep += h;
                out.push({ md: sv[j][0], tvd: sv[j][1], inc: dmd > 0 ? Math.acos(Math.max(-1, Math.min(1, dt / dmd))) / D2R : 0, azi: 0, n: dep, e: 0, dep: dep, dls: 0 });
            }
        }
        return out;
    }
    function tvdAt(st, md) {
        if (!st.length) return md;
        for (var i = 1; i < st.length; i++) if (md <= st[i].md) { var a = st[i - 1], b = st[i], t = (md - a.md) / ((b.md - a.md) || 1); return a.tvd + t * (b.tvd - a.tvd); }
        var l = st[st.length - 1]; return l.tvd + (md - l.md) * Math.cos((l.inc || 0) * D2R);
    }
    function incAt(st, md) { for (var i = 1; i < st.length; i++) if (md <= st[i].md) return st[i].inc; return st.length ? st[st.length - 1].inc : 0; }
    function build(well) {
        calls.build++;
        well = well || {};
        var st = stations(well.survey);
        if (st.length < 2) return { ok: false, code: 'NO_SURVEY', errors: ['The survey needs at least two stations.'], warnings: [], segments: [], stations: st };
        var strs = (well.strings || []).filter(function (s) { return s.kind === 'tubing'; });
        var mid = num(well.midPerfMd, st[st.length - 1].md);
        var segs = [], step = 500;
        for (var m = 0; m < mid; m += step) {
            var m1 = Math.min(mid, m + step), s = strs.filter(function (x) { return x.topMd <= m && x.botMd >= m1 - 1; })[0] || strs[0] || { id: 2.441 };
            segs.push({ name: 'seg', len: m1 - m, id: s.id, dz: tvdAt(st, m1) - tvdAt(st, m), md0: m, md1: m1, tvd0: tvdAt(st, m), tvd1: tvdAt(st, m1), inc: incAt(st, m1) });
        }
        var geo = (well.geo && well.geo.points) || [], surfT = num(well.geo && well.geo.surfT_F, 60);
        var gb = geo.length ? geo[geo.length - 1] : [tvdAt(st, mid), 200];
        var tAt = function (md) { return surfT + (gb[1] - surfT) * tvdAt(st, md) / (gb[0] || 1); };
        var warnings = [];
        if (st.some(function (x) { return x.inc > 30; }) && (well.corrWell === 'hb')) warnings.push(w('VERTICAL_CORR', 'Hagedorn & Brown is a vertical correlation; the well is deviated above 30°.'));
        return { ok: true, errors: [], warnings: warnings, segments: segs, stations: st, nodes: { wellheadMd: 0, midPerfMd: mid, midPerfTvd: tvdAt(st, mid), gauges: [] }, tAt: tAt };
    }
    function schematic(W, R) {
        calls.schematic++;
        if (!W || !W.ok) return { ok: false, code: 'NO_WELL', errors: ['no well path'], warnings: [] };
        var M = schematic._M || {};
        var well = M.well || {};
        var prof = (R && R.traverse && R.traverse.profile) ? R.traverse.profile.map(function (r) { return { md: r.md, tvd: r.tvd, inc: r.inc, p: r.p, t: r.t, hl: r.hl, vm: r.vm, pattern: r.pattern }; }) : [];
        return { ok: true, trajectory: W.stations.map(function (s) { return { md: s.md, tvd: s.tvd, dep: s.dep, n: s.n, e: s.e, inc: s.inc, azi: s.azi }; }),
                 strings: (well.strings || []).map(function (s) { return Object.assign({}, s); }),
                 restrictions: (well.restrictions || []).map(function (r) { return { kind: r.kind, md: r.md, tvd: tvdAt(W.stations, r.md), id: r.id, k: r.k, beta: r.id / 2.441 }; }),
                 perfs: { topMd: well.perfTopMd, botMd: well.perfBotMd, midMd: well.midPerfMd },
                 gauges: (M.tests || []).filter(function (t) { return fin(t.gaugeMd); }).map(function (t) { return { md: t.gaugeMd, tvd: tvdAt(W.stations, t.gaugeMd), name: t.id }; }),
                 choke: { present: !!(M.surface && M.surface.choke && M.surface.choke.present), bean64: M.surface && M.surface.choke && M.surface.choke.bean64 },
                 profile: prof, warnings: [], errors: [] };
    }

    // ── fluid / inflow ─────────────────────────────────────────────────────────
    function isGas(type) { return type === 'gas' || type === 'condensate' || type === 'gasinj'; }
    function fluidBuild(f) {
        f = f || {};
        var gor = num(f.gor, 0), api = num(f.api, 35), sgg = num(f.sgg, 0.65), Tpb = 200;
        var pb = fin(f.pbUser) ? f.pbUser : 18.2 * (Math.pow(gor / sgg, 0.83) * Math.pow(10, 0.00091 * Tpb - 0.0125 * api) - 1.4);
        var at = function (p, T) {
            var rs = p >= pb ? gor : gor * Math.pow(Math.max(p, 14.7) / pb, 1 / 0.83);
            return { rs: rs, bo: 0.9759 + 0.00012 * Math.pow(rs * Math.sqrt(sgg / (141.5 / (131.5 + api))) + 1.25 * T, 1.2), muo: 0.6 + 600 / (p + 400), z: 1 - p / 12000 + Math.pow(p / 9000, 2), mug: 0.012 + p * 2e-6 };
        };
        return { ok: true, type: f.type || 'oil', pvt: {}, pb: function () { return pb; }, at: at, sgg: sgg, validity: [{ corr: 'Standing', inRange: api <= 63.8 && gor <= 1425, msg: 'Standing: API 16.5–63.8, Rs 20–1,425 scf/STB' }], warnings: [], errors: [],
                 table: function (pl, T) { return pl.map(function (p) { var r = at(p, T); r.p = p; return r; }); } };
    }
    function fluidTable(F, pList, T) { return { ok: true, rows: F && F.table ? F.table(pList, T) : [], warnings: [] }; }
    function iprCurve(res, F) {
        res = res || {};
        var pr = res.pr, P = res.params || {}, model = res.model || 'pi';
        if (!fin(pr)) return { ok: false, code: 'NEEDS', errors: ['p̄r needed'], warnings: [] };
        var kind = (model === 'litP2' || model === 'backPressure' || model === 'litMp' || model === 'darcyGas') ? 'gas' : 'oil';
        var qAt, pwfAt, J = null, aof;
        if (kind === 'gas') {
            var a = num(P.a, 500), b = num(P.b, 0.05);
            qAt = function (pwf) { var d = pr * pr - pwf * pwf; return d <= 0 ? 0 : (-a + Math.sqrt(a * a + 4 * b * d)) / (2 * b); };
            pwfAt = function (q) { var v = pr * pr - a * q - b * q * q; return v > 0 ? Math.sqrt(v) : 0; };
        } else if (model === 'vogel') {
            var qmax = num(P.qmax, 3000);
            qAt = function (pwf) { var x = Math.max(0, pwf) / pr; return qmax * (1 - 0.2 * x - 0.8 * x * x); };
            pwfAt = function (q) { var r = Math.min(1, Math.max(0, q / qmax)); return pr * (-0.2 + Math.sqrt(0.04 + 3.2 * (1 - r))) / 1.6; };
        } else {
            J = num(P.J, 1);
            qAt = function (pwf) { return Math.max(0, J * (pr - pwf)); };
            pwfAt = function (q) { return Math.max(0, pr - q / J); };
        }
        aof = qAt(kind === 'gas' ? 14.65 : 0);
        var curve = []; for (var i = 0; i <= 40; i++) { var pw = pr * (1 - i / 40); curve.push({ q: qAt(pw), pwf: pw }); }
        return { ok: true, key: model, label: model, kind: kind, verified: true, pr: pr, pb: fin(res.pb) ? res.pb : null, aof: aof, J: J, qAt: qAt, pwfAt: pwfAt, curve: curve, skin: null, warnings: [], errors: [] };
    }

    // ── system ─────────────────────────────────────────────────────────────────
    function model(M) {
        var gas = isGas(M.fluid.type), W = build(M.well), I = iprCurve(M.res, fluidBuild(M.fluid));
        var tub = (M.well.strings || []).filter(function (s) { return s.kind === 'tubing'; })[0] || { id: 2.441 };
        var tvd = W.ok ? W.nodes.midPerfTvd : 8000, md = W.ok ? W.nodes.midPerfMd : 8000, d = tub.id || 2.441;
        var wc = num(M.fluid.wc, 0), gor = num(M.fluid.gor, 500), bean = num(M.surface.choke.bean64, 32), choke = M.surface.choke.present !== false;
        var psep = num(M.surface.psep_psig, 100), thpFix = num(M.system.thp_psig, 150);
        var flowDp = function (q) { return (M.surface.flowline || []).reduce(function (a, s) { return a + (gas ? 4e-7 : 3e-6) * q * q * s.len / 1000 * Math.pow(3 / (s.id || 3), 5); }, 0); };
        var thpOf = function (q) {          // psig
            if (!choke) return thpFix;
            var down = psep + flowDp(q);
            if (gas) return Math.max(down * 1.05, q * 0.22 * Math.pow(24 / bean, 2));
            var R = Math.max(0.05, gor * (1 - wc) / 1000);
            return Math.max(down * 1.3, 435 * Math.pow(R, 0.546) * q / Math.pow(bean, 1.89));
        };
        var vlp = function (q) {
            var thp = thpOf(q) + PATM;
            if (gas) { var s = 0.0375 * num(M.fluid.sgg, 0.65) * tvd / (660 * 0.9); return Math.sqrt(Math.exp(s) * thp * thp + 1.84e6 * Math.pow(q / 1000, 2) * md / 10000 * Math.pow(2.441 / d, 5)) + num(M.fluid.cgr, 0) * 0.4 * Math.exp(-q / 2500) * tvd / 1000; }
            var g = 0.36 + 0.05 * wc - 0.2 * (1 - wc) * (1 - Math.exp(-q / 400));
            return thp + tvd * g + 6e-6 * q * q * md / 1000 * Math.pow(2.441 / d, 5);
        };
        return { gas: gas, W: W, I: I, vlp: vlp, thpOf: thpOf, tvd: tvd, md: md, d: d, wc: wc, gor: gor, flowDp: flowDp, psep: psep };
    }
    function brent(f, a, b) { var fa = f(a); for (var k = 0; k < 60; k++) { var m = (a + b) / 2, fm = f(m); if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m; } return (a + b) / 2; }
    function solve(M, ctx) {
        calls.solve++;
        schematic._M = M;
        if (opts.solveFails) return { ok: false, code: 'NO_SOLUTION', errors: ['No operating point.'], warnings: [], roots: [], flags: [] };
        var S = model(M);
        if (!S.I.ok) return { ok: false, code: 'NEEDS', errors: S.I.errors, warnings: [], roots: [], flags: [] };
        var D = function (q) { return S.vlp(q) - S.I.pwfAt(q); };
        var qmax = S.I.aof * 0.999, n = 60, roots = [], prev = D(1), qp = 1, curve = [];
        for (var i = 1; i <= n; i++) {
            var q = qmax * i / n, d = D(q);
            curve.push({ q: q, ipr: S.I.pwfAt(q), vlp: S.vlp(q) });
            if ((d > 0) !== (prev > 0)) { var r = brent(D, qp, q), h = Math.max(1, r * 1e-3); roots.push({ q: r, p: S.I.pwfAt(r), stable: (D(r + h) - D(r - h)) > 0, dDdq: (D(r + h) - D(r - h)) / (2 * h) }); }
            prev = d; qp = q;
        }
        var vmin = curve.reduce(function (a, c) { return c.vlp < a.p ? { q: c.q, p: c.vlp } : a; }, { q: null, p: Infinity });
        var stable = roots.filter(function (r) { return r.stable; }), unst = roots.filter(function (r) { return !r.stable; });
        var op = stable.length ? { q: stable[stable.length - 1].q, p: stable[stable.length - 1].p, stable: true } : null;
        var qs = unst.length ? { q: unst[0].q, p: unst[0].p } : null;
        var thp = op ? S.thpOf(op.q) : null;
        // traverse: bottom → top, 100 ft MD stations
        var profile = [];
        if (op && S.W.ok) {
            var pBot = op.p, pTop = thp + PATM, st = S.W.stations, tAt = S.W.tAt, tht = num(M.well.heat.tht_F, 110), bht = tAt(S.md);
            for (var m = 0; m <= S.md + 1e-6; m += Math.max(50, S.md / 120)) {
                var tv = tvdAt(st, m), fr = tv / S.tvd, curv = Math.pow(fr, 1.18);
                var p = pTop + (pBot - pTop) * curv, hl = S.gas ? Math.max(0.02, 0.12 * fr) : Math.min(1, 0.32 + 0.68 * Math.pow(Math.min(1, p / 2400), 1.4));
                var A = S.d * S.d / 4 * Math.PI / 144, vm = S.gas ? op.q * 1000 / 86400 * (14.7 / p) * 1.15 / A : op.q * 5.615 / 86400 * (1 + (1 - hl) * 2.5) / A;
                var pat = S.gas ? (fr > 0.85 ? 'annular' : 'mist') : (hl > 0.88 ? 'bubble' : hl > 0.6 ? 'slug' : hl > 0.42 ? 'churn' : 'annular');
                var t = tht + (bht - tht) * fr;
                profile.push({ md: m, tvd: tv, inc: incAt(st, m), p: p, t: t, hl: hl, pattern: pat, vm: vm, vsl: vm * hl, vsg: vm * (1 - hl), rhoS: 62.4 * hl * 0.85, gradEl: 0.3, gradF: 0.01, gradAcc: 0, ero: vm / (100 / Math.sqrt(Math.max(1, S.gas ? p / 300 : 62.4 * hl * 0.85 + 2))), tHyd: S.gas ? 45 + 0.012 * p : null });
            }
        }
        var qo = op ? (S.gas ? op.q * num(M.fluid.cgr, 0) / 1000 : op.q * (1 - S.wc)) : 0;
        var qw = op ? (S.gas ? op.q * num(M.fluid.wgr, 0) / 1000 : op.q * S.wc) : 0;
        var qg = op ? (S.gas ? op.q : op.q * (1 - S.wc) * S.gor / 1000) : 0;
        var pr = M.res.pr, pwf = op ? op.p : null;
        var grav = profile.length ? (S.gas ? 0.75 : 0.88) * (pwf - (thp + PATM)) : 0;
        var breakdown = op ? [{ key: 'reservoir', dp: pr - pwf }, { key: 'gravity', dp: grav }, { key: 'friction', dp: (pwf - thp - PATM) - grav },
            { key: 'restrictions', dp: 0 }, { key: 'choke', dp: thp - (S.psep + S.flowDp(op.q)) }, { key: 'flowline', dp: S.flowDp(op.q) }] : [];
        var thtHyd = S.gas ? 58 : 48, tht = num(M.well.heat.tht_F, 110);
        var flags = [];
        var eroMax = profile.reduce(function (a, r) { return Math.max(a, r.ero); }, 0);
        if (eroMax > 0.8) flags.push(w('EROSION', 'Mixture velocity reaches ' + Math.round(eroMax * 100) + ' % of the erosional velocity.', eroMax > 1 ? 'warn' : 'info'));
        var loading = S.gas && op ? { ok: true, method: 'turner', suggested: 'turner', qc_MMscfd: 4.2, limitingMd: S.md, margin: op.q / 1000 / 4.2 - 1, perDepth: profile.filter(function (_, i) { return i % 6 === 0; }).map(function (r) { return { md: r.md, tvd: r.tvd, vg: r.vm, vc: 6 + 4 * r.tvd / S.tvd, qc: 2.4 + 0.7 * r.tvd / S.tvd }; }) } : null;
        return { ok: !!op, node: M.system.node || 'bottom', roots: roots, op: op, qs: qs, vlpMin: fin(vmin.q) ? vmin : null,
                 traverse: op ? { profile: profile } : null, breakdown: breakdown,
                 surface: { thp: thp != null ? thp + PATM : null, thp_psig: thp, tht: tht, thtHyd: thtHyd, pChokeDn: op ? S.psep + S.flowDp(op.q) + PATM : null, choke: { regime: M.surface.choke.present ? 'critical' : 'none', ratio: 0.42 } },
                 rates: { qo: qo, qw: qw, qg: qg, qL: qo + qw }, velocities: { eroMax: eroMax }, flags: flags, discontinuities: [], loading: loading,
                 curves: { ipr: curve.map(function (c) { return { q: c.q, p: c.ipr }; }), vlp: curve.map(function (c) { return { q: c.q, p: c.vlp }; }) },
                 pwf: pwf, warnings: op ? [] : [w('NO_OP', 'The tubing curve lies above the inflow curve: the well does not flow at these settings.')], errors: op ? [] : ['no operating point'], evals: n + 10 };
    }
    function job(fnStep, n, resultFn) {
        var i = 0, out = [];
        return { step: function () { if (i < n) out.push(fnStep(i++)); return { done: i >= n, progress: i / n, label: 'case ' + i + ' of ' + n }; }, done: function () { return i >= n; }, progress: function () { return i / n; }, result: function () { return resultFn(out); }, cancel: function () { i = n; } };
    }
    function patch(M, path, v) { var c = JSON.parse(JSON.stringify(M)), ks = path.split('.'), o = c; for (var k = 0; k < ks.length - 1; k++) o = o[ks[k]]; o[ks[ks.length - 1]] = v; return c; }
    var PATH = { pr: 'res.pr', wc: 'fluid.wc', gor: 'fluid.gor', bean: 'surface.choke.bean64', thp: 'system.thp_psig', psep: 'surface.psep_psig', J: 'res.params.J', tubingId: 'well.strings.0.id' };

    var api = {
        well: { build: build, schematic: schematic, segmentsFor: function (W) { return W.segments; }, restrictions: function () { return []; }, temperature: function () { return { ok: true, warnings: [] }; } },
        fluid: { build: fluidBuild, table: fluidTable, check: function () { return { errors: [], warnings: [], validity: [] }; }, recombine: function () { return { ok: true }; }, flowlineFluid: function () { return {}; } },
        ipr: { curve: iprCurve },
        system: {
            solve: solve,
            maxRate: function (M) { var R = solve(patch(M, 'surface.choke.present', false)); return { ok: R.ok, q: R.op && R.op.q, thp: M.surface.psep_psig, R: R }; },
            shutIn: function (M) { var S = model(M); var sithp = S.gas ? M.res.pr * Math.exp(-0.0375 * 0.65 * S.tvd / 600) - PATM : Math.max(0, M.res.pr - 0.36 * S.tvd - PATM); var r = M.surface.rating && M.surface.rating.wellhead_psi; return { ok: true, gasFilled: M.res.pr * Math.exp(-0.0375 * 0.65 * S.tvd / 600) - PATM, actualFluid: sithp, partLiquid: [], rating: { verdict: fin(r) ? (sithp <= r ? 'ok' : 'exceeded') : 'no rating', margin: fin(r) ? r - sithp : null } }; },
            designFor: function (M, target) { return job(function (i) { return solve(patch(M, 'surface.choke.bean64', 16 + i * 4)); }, 6, function (out) { var best = out.reduce(function (a, R, i) { return R.op && Math.abs(R.op.q - target.q) < Math.abs((a.R && a.R.op ? a.R.op.q : 1e9) - target.q) ? { bean: 16 + i * 4, R: R } : a; }, { bean: null, R: null }); return { ok: best.bean != null, bean: best.bean, R: best.R }; }); },
            beanSchedule: function (M, beans) { beans = beans || M.surface.beans; return job(function (i) { var R = solve(patch(M, 'surface.choke.bean64', beans[i])); return { bean: beans[i], q: R.op ? R.op.q : null, thp: R.surface ? R.surface.thp_psig : null, tht: R.surface ? R.surface.tht : null, dpChoke: R.breakdown && R.breakdown[4] ? R.breakdown[4].dp : null, regime: 'critical', stable: !!(R.op && R.op.stable), loadingMargin: R.loading ? R.loading.margin : null }; }, beans.length, function (out) { return out; }); }
        },
        loading: function (R) { return R && R.loading ? R.loading : { ok: true, method: 'turner', suggested: 'turner', qc_MMscfd: null, limitingMd: null, margin: null, perDepth: [] }; },
        check: function (M) {
            calls.check++;
            var errors = [], warnings = [];
            if (!fin(M.res.pr)) errors.push('p̄r needed');
            if (!(M.well.survey || []).length) errors.push('survey needed');
            var gas = isGas(M.fluid.type);
            return { ok: !errors.length, errors: errors, warnings: warnings, validity: gas
                ? [{ corr: 'Gray', inRange: true, msg: 'Gray: v_m < 50 ft/s, d ≤ 3.5 in, condensate ≤ 50 bbl/MMscf — inside the range.' }, { corr: 'Beggs & Brill (flowline)', inRange: true, msg: 'Beggs & Brill: any inclination.' }]
                : [{ corr: 'Hagedorn & Brown', inRange: true, msg: 'Hagedorn & Brown: vertical, tubing 1–2-1/2 in nominal — inside the range.', provisional: true }, { corr: 'Standing (PVT)', inRange: true, msg: 'Standing: API 16.5–63.8, Rs 20–1,425 scf/STB — inside the range.' }] };
        },
        sens: {
            matrix: function (vars) { var v = vars[0]; return { ok: true, cases: v.values.map(function (x) { var o = {}; o[v.key] = x; return { values: o }; }) }; },
            job: function (M, vars) { var v = vars[0]; return job(function (i) { var x = v.values[i]; var R = solve(patch(M, PATH[v.key] || v.key, v.key === 'wc' ? x / 100 : x)); return { values: { key: v.key, value: x }, R: { ok: R.ok, q: R.op && R.op.q, pwf: R.op && R.op.p, thp: R.surface && R.surface.thp_psig, curve: R.curves ? R.curves.vlp : [] } }; }, v.values.length, function (out) { return { ok: true, key: v.key, cases: out, table: { head: [v.key, 'q', 'pwf'], rows: out.map(function (c) { return [c.values.value, c.R.q, c.R.pwf]; }) } }; }); },
            table: function (r) { return r.table; }, csv: function (r) { return r.table.head.join(',') + '\n' + r.table.rows.map(function (x) { return x.join(','); }).join('\n'); }
        },
        match: {
            compare: function (M, test, corrs) { return { ok: true, rows: (corrs || ['hb', 'gray', 'bb', 'nsl']).map(function (c, i) { var e = [12, -35, 58, -140][i % 4]; return { corr: c, pCalc: test.gauge_psia + e, err: e, errPct: 100 * e / test.gauge_psia, rank: 0, verified: c === 'bb' }; }).sort(function (a, b) { return Math.abs(a.err) - Math.abs(b.err); }).map(function (r, i) { r.rank = i + 1; return r; }) }; },
            iprFromTest: function (M, test, sf) { return { ok: true, value: sf === 'pr' ? 2985 : sf === 'J' ? 2.05 : 1.8, pwf: 2640, method: 'gauge' }; }
        },
        qc: function (M, tests) { return { ok: true, rows: (tests || []).map(function (t) { return { id: t.id, score: 0.9, flags: [w('QC_GOR_LT_RSB', 'Not applicable: no bubble-point pressure entered.', 'info')] }; }) }; }
    };

    // install (replacing the WP0 stubs; the stub list keeps its names so WS3 still sees them as WP0 names)
    G.WTS_wp_well = Object.assign(G.WTS_wp_well || {}, api.well);
    G.WTS_wp_fluid = Object.assign(G.WTS_wp_fluid || {}, api.fluid);
    G.WTS_wp_ipr = Object.assign(G.WTS_wp_ipr || {}, { curve: api.ipr.curve });
    G.WTS_wp_system = Object.assign(G.WTS_wp_system || {}, api.system);
    G.WTS_wp_loading = api.loading;
    G.WTS_wp_check = api.check;
    G.WTS_wp_sens = Object.assign(G.WTS_wp_sens || {}, api.sens);
    G.WTS_wp_match = Object.assign(G.WTS_wp_match || {}, api.match);
    G.WTS_wp_qc = api.qc;
    G.__WP_MOCK = { calls: calls, opts: opts };
    return G.__WP_MOCK;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { installWellPerfMock: installWellPerfMock };
