// =============================================================================
// WTS — 49-calc-wp-well.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance well path (WP4, docs/WELL-PERFORMANCE-PLAN.md §2.3, §2.5, §3.1, §4.5, §4.6, §15.1): deviation (minimum
// curvature through WTS_wellbore.surveyMC), strings → flow segments on the true inclination, restrictions, the linear flowing
// temperature with the Joule-Thomson hydrate THT, and the data of the interactive well schematic. Pure: no DOM, storage, timers or
// events; nothing throws for user data. Field units: ft (MD / TVD), in (diameters, roughness), °F, psia.
//
// Interfaces (the WP0 contract; every result {ok, errors[], warnings[{code, msg, sev:'info'|'warn'}], …}):
//   WTS_wp_well
//     .build(well /*M.well*/, o?)
//         o: {res /*M.res: T_F = the flowing BHT at mid-perf*/, fluidType, tests /*M.tests: gauge MDs*/, gauges /*[md]*/,
//             surface /*M.surface: the choke for the schematic*/, maxDoglegDeg /*segment dogleg limit, default 5°*/, fmt}
//         → W = {ok, segments /*segmentsFor(W, {})*/, nodes:{wellheadMd, wellheadTvd, midPerfMd, midPerfTvd, perfTopMd, perfBotMd,
//                perfTopTvd, perfBotTvd, tubingShoeMd, gauges:[{md, tvd, source}]}, stations:[{md, tvd, inc, azi, n, e, dep, hd, dls}],
//                tAt(md) °F, tvdAt(md), mdAt(tvd), at(md) → {md, tvd, inc, azi, n, e, dep, hd}, xToMd(x, {fromTop?}),
//                survey:{kind:'mc'|'tvd'|'vertical', tdMd, maxInc, maxDls, aziKnown, vsAzi}, strings[], restrictions[], path,
//                rough /*length-weighted along the flow path — the marcher takes one roughness*/, deviated:[{md0, md1, incMax}],
//                temp /*temperature(W)*/, heat, geo, bht, choke, column /*WTS_wellbore.column or null*/, warnings, errors}
//     .segmentsFor(W, o /*{from, toMd, path, maxDoglegDeg}*/)
//         → [{name, len ft, id in, dz ft (+ = the flow goes up), area? in², restr? {d, k}, md0, md1, tvd0, tvd1, inc, incMin, incMax,
//             kind, rough}] in flow order; md0 / tvd0 = the segment's flow inlet, md1 / tvd1 = its outlet (production from the
//             mid-perforations up: md0 > md1). Segments break at every bore change and restriction and wherever the hole turns by more
//             than maxDoglegDeg; dz is the exact minimum-curvature ΔTVD, so the march takes the hydrostatic term on TVD and friction on
//             MD, and each segment carries its own inclination for the correlations. A restriction at MD r is the restr of the segment
//             whose flow inlet is r (the WP0b marcher applies it there).
//     .restrictions(W)
//         → [{kind, md, tvd, id, k, beta, bore, applied, label}]
//     .temperature(W, o /*{mode, tht_F, thtMeasured, F, fluidType, dpTubing, pwf, thp, pMean /*psia*/, bht_F, sg}*/)
//         → {ok, mode, tAt(md), geoAt(tvd), tht, bht, thtHyd, muJT, dpTubing, pMean, verdict:'measured'|'jt-corrected'|'upper-bound'|
//            'geotherm', verdictText, warnings, errors}
//         Linear (A1): T(MD) = THT + (BHT − THT)·MD / MD_midperf (§4.6); BHT = the reservoir temperature, else the geotherm at the
//         mid-perforation TVD. Hydrate THT (gas / condensate, THT not measured): THT_hyd = THT − μ_JT·Δp_tubing, μ_JT (°F/psi) from
//         WTS_gaspvt_isenthalpic at the mean tubing pressure and temperature; without Δp or μ_JT the verdict is "upper-bound THT, not
//         conservative". No THT: the static geotherm, and the surface geotherm temperature for the hydrate check.
//         A2 (WP14): mode 'relax' with o.q (a rate on F.rateBasis or {qo, qw, qg_Mscfd}) and o.F → mode 'relax', tAt = the relaxation
//         profile at that rate, tht = its wellhead value (an estimate: the J-T hydrate correction applies), relax = the relax() result;
//         without a rate (the build) the linear profile stands in (relaxAsked true).
//     .relax(W, F, q, o? /*{heat: overrides of M.well.heat, pMean}*/)     (A2, WP14; §4.6)
//         → {ok, mode:'relax', tAt(md), teAt(md), tht, bht, teTop, offsetTop, A ft, fTD, tD, U_to, U_in, Ubasis, r_to, r_ti, rwb, rwbSource,
//            ke, alpha, t_hr, tProd_d, w lbm/hr, cp, cpSource, frac{oil, water, gas}, cpParts, q, profile, provisional, verified:false}
//         WTS_wellbore.flowingTemp (produce) on this well's trajectory: geotherm on TVD (M.well.geo points / surface + reservoir
//         temperature), relaxation along MD from the reservoir temperature at the mid-perforations; U from M.well.heat.U_to on the
//         Ubasis 'to' (outside radius, default) or 'ti' (inside radius, converted), producing time tProd_d (30 d, Q14), k_e, α, hole
//         diameter dwb_in (default the largest string OD); w and c_p from heatFlow.
//     .heatFlow(F, q, o? /*{T, p, cp}*/) → {ok, w lbm/hr, cp Btu/lbm·°F, mass, frac, cpParts{oil (Gambill), water 1.0, gas
//         (WTS_gaspvt_state real-gas c_p)}} — mass rates at standard conditions from the flowline fluid at q
//     .fitU(W, F, q, thtF, o? /*{heat, Umin, Umax}*/) → {ok, U (on the model's basis), U_to, Ubasis, tht, tFit, resid, evals, A, w, cp,
//         range{tAtUmin, tAtUmax}} | {ok:false, code:'OUT_OF_RANGE', range}: U fitted to a measured THT (1-D Brent on ln U)
//     .schematic(W, R /*a WTS_wp_system result or null*/, o?)
//         → {ok, trajectory:[{md, tvd, dep, n, e, vs, inc, azi}], vsAzi, extents, strings[] (outermost first), restrictions[],
//            perfs:{topMd, botMd, midMd, topTvd, botTvd, midTvd}, gauges[], choke, surface, profile:[{md, tvd, inc, vs, p, t, hl, vm,
//            pattern, …}], ranges:{p, t, hl, vm, ero → [min, max] | null}, props[], at(md) (hover readout), norm(prop, v) → 0..1}
//         Everything the page needs to draw the side view (vertical section), the plan view, the strings, restrictions, perforations,
//         gauges and choke, the hover readout at any depth and the heat-map colouring along the well.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // WP4 replaces the WP0 stub file: its names leave window.__WP_STUBS (they are never added by this file)
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    ['WTS_wp_well.build', 'WTS_wp_well.segmentsFor', 'WTS_wp_well.restrictions', 'WTS_wp_well.temperature', 'WTS_wp_well.schematic'].forEach(function (n) {
        var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1);
    });

    var DEG = Math.PI / 180;
    var DEF_DOGLEG = 5;                   // ° per flow segment (inclination resolution of the march)
    var DEF_ROUGH = 0.0006;               // in, new steel (owner Q10, wells) when WTS_tubulars.roughness is absent
    var HIGH_DLS = 10;                    // °/100 ft: warning
    var DEVIATED_INC = 30;                // ° from vertical: sections listed for the vertical-only correlations (§4.4)
    var STRING_KINDS = ['tubing', 'casing', 'liner'];
    var RESTR_KINDS = ['sssv', 'nipple', 'sleeve', 'xo', 'downholeChoke'];
    var RESTR_LABEL = { sssv: 'SSSV', nipple: 'Nipple', sleeve: 'Sliding sleeve', xo: 'Crossover', downholeChoke: 'Downhole choke' };

    // ── helpers ──────────────────────────────────────────────────────────────
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v) {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v === 'string' && v.trim() !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) return +v.trim();
        return null;
    }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _f(x, dp) {
        if (!_fin(x)) return '–';
        var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), neg = s.charAt(0) === '-';
        if (neg) s = s.slice(1);
        var parts = s.split('.'), ip = parts[0], out = '';
        while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
        return (neg ? '−' : '') + ip + out + (parts[1] ? '.' + parts[1] : '');
    }
    var FIELD_FMT = {
        len: function (v) { return _f(v, 0) + ' ft'; },
        t: function (v) { return _f(v, 1) + ' °F'; },
        p: function (v) { return _f(v, 0) + ' psia'; },
        d: function (v) { return _f(v, 3) + ' in'; }
    };
    function _fmt(o) {
        var f = (o && o.fmt) || {}, r = {};
        Object.keys(FIELD_FMT).forEach(function (k) { r[k] = typeof f[k] === 'function' ? f[k] : FIELD_FMT[k]; });
        return r;
    }
    function _clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    function _tan(inc, azi) { var i = inc * DEG, a = azi * DEG; return [Math.sin(i) * Math.cos(a), Math.sin(i) * Math.sin(a), Math.cos(i)]; }
    function _angle(t1, t2) {
        var d = t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2];
        var x = [t1[1] * t2[2] - t1[2] * t2[1], t1[2] * t2[0] - t1[0] * t2[2], t1[0] * t2[1] - t1[1] * t2[0]];
        return Math.atan2(Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]), d) / DEG;
    }
    function _missing(name) { return { ok: false, code: 'MISSING_ENGINE', name: name, errors: [name + ' is not loaded'], warnings: [] }; }

    // ── trajectory: minimum curvature ([md, inc, azi]), TVD pairs ([md, tvd]) or vertical ──────────────────────────
    function _isMc(rows) {
        if (!Array.isArray(rows) || !rows.length) return false;
        for (var i = 0; i < rows.length; i++) if (!Array.isArray(rows[i]) || rows[i].length < 3 || !_fin(_num(rows[i][2]))) return false;
        return true;
    }
    function _trajVertical() {
        var st = [{ md: 0, tvd: 0, inc: 0, azi: 0, n: 0, e: 0, dep: 0, hd: 0, dls: 0, dogleg: 0 }];
        return { kind: 'vertical', stations: st, tdMd: 0, maxInc: 0, maxDls: 0, aziKnown: false, warnings: [],
                 at: function (md) { return { md: md, tvd: _fin(md) ? md : NaN, inc: 0, azi: 0, n: 0, e: 0, dep: 0, hd: 0 }; } };
    }
    // [md, tvd] pairs: straight lines between stations (the convention of WTS_wellbore.column), inclination = acos(ΔTVD / ΔMD)
    function _trajTvd(rows, warnings) {
        var sv = [[0, 0]];
        rows.forEach(function (r) {
            var md = _num(r && r[0]), tvd = _num(r && r[1]), last = sv[sv.length - 1];
            if (!_fin(md) || !_fin(tvd)) { warnings.push(_w('SURVEY_ROW_DROPPED', 'A survey row that is not two numbers (MD, TVD) was dropped.')); return; }
            if (md === 0 && tvd === 0) return;
            if (md > last[0] && tvd >= last[1] - 1e-9 && tvd - last[1] <= md - last[0] + 1e-6) sv.push([md, tvd]);
            else warnings.push(_w('SURVEY_ROW_DROPPED', 'The survey row at ' + _f(md, 0) + ' ft MD was dropped (MD must rise and TVD may not rise faster than MD).'));
        });
        var st = [], maxInc = 0, maxDls = 0;
        sv.forEach(function (p, i) {
            var o = { md: p[0], tvd: p[1], inc: 0, azi: 0, n: 0, e: 0, dep: 0, hd: 0, dls: 0, dogleg: 0 };
            if (i > 0) {
                var q = st[i - 1], L = p[0] - q.md, dz = p[1] - q.tvd, h = Math.sqrt(Math.max(0, L * L - dz * dz));
                o.inc = Math.acos(_clamp(dz / L, -1, 1)) / DEG; o.hd = q.hd + h; o.n = o.hd; o.dep = o.hd;
                if (i > 1) { o.dogleg = Math.abs(o.inc - q.inc); o.dls = o.dogleg / L * 100; }
            }
            if (o.inc > maxInc) maxInc = o.inc;
            if (o.dls > maxDls) maxDls = o.dls;
            st.push(o);
        });
        if (st.length > 1) st[0].inc = st[1].inc;
        function at(md) {
            if (!_fin(md) || md < 0) return { md: md, tvd: NaN, inc: NaN, azi: 0, n: NaN, e: 0, dep: NaN, hd: NaN };
            var k = 1;
            while (k < st.length - 1 && md > st[k].md) k++;
            if (st.length === 1) return { md: md, tvd: md, inc: 0, azi: 0, n: 0, e: 0, dep: 0, hd: 0 };
            var a = st[k - 1], b = st[k], L = b.md - a.md, f = (md - a.md) / L;
            var tvd = a.tvd + f * (b.tvd - a.tvd), hd = a.hd + f * (b.hd - a.hd);
            return { md: md, tvd: tvd, inc: b.inc, azi: 0, n: hd, e: 0, dep: hd, hd: hd };
        }
        return { kind: 'tvd', stations: st, tdMd: st[st.length - 1].md, maxInc: maxInc, maxDls: maxDls, aziKnown: false, warnings: [], at: at };
    }
    function _trajectory(rows, warnings) {
        rows = Array.isArray(rows) ? rows : [];
        if (!rows.length) return _trajVertical();
        if (_isMc(rows)) {
            var WB = G.WTS_wellbore;
            if (!WB || typeof WB.surveyMC !== 'function') return null;
            var mc = WB.surveyMC(rows.map(function (r) { return [_num(r[0]), _num(r[1]), _num(r[2])]; }));
            if (!mc || !mc.ok) {
                warnings.push(_w('NO_SURVEY', 'The survey has no usable row; the well is treated as vertical.'));
                return _trajVertical();
            }
            (mc.warnings || []).forEach(function (x) { warnings.push(_w(x.code, x.text || x.msg || '', x.level === 'info' ? 'info' : 'warn')); });
            return { kind: 'mc', stations: mc.stations, tdMd: mc.tdMd, maxInc: mc.maxInc, maxDls: mc.maxDls, aziKnown: true, at: mc.at };
        }
        return _trajTvd(rows, warnings);
    }

    // ── strings ──────────────────────────────────────────────────────────────
    function _roughDefault() {
        var T = G.WTS_tubulars;
        if (T && typeof T.roughness === 'function') { var r = T.roughness('well'); if (_fin(r) && r > 0) return r; }
        return DEF_ROUGH;
    }
    function _strings(list, warnings) {
        var T = G.WTS_tubulars, rd = _roughDefault(), out = [];
        (Array.isArray(list) ? list : []).forEach(function (s, i) {
            if (!s || typeof s !== 'object') return;
            var e = (s.tubKey && T && typeof T.find === 'function') ? T.find(s.tubKey) : null;
            var id = _num(s.id), od = _num(s.od), wall = _num(s.wall);
            if (!_fin(id) && e) id = e.id;
            if (!_fin(od) && e) od = e.od;
            if (!_fin(wall)) wall = (e && _fin(e.wall)) ? e.wall : (_fin(id) && _fin(od) ? (od - id) / 2 : null);
            var top = _num(s.topMd), bot = _num(s.botMd);
            if (!(_fin(id) && id > 0 && _fin(od) && od > id && _fin(top) && _fin(bot) && bot > top && top >= 0)) {
                warnings.push(_w('STRING_DROPPED', 'String row ' + (i + 1) + ' was dropped (it needs 0 < ID < OD and top MD < bottom MD).'));
                return;
            }
            var rough = _num(s.rough), roughSrc = 'string';
            if (!(_fin(rough) && rough >= 0)) { rough = rd; roughSrc = 'default'; }
            var kind = STRING_KINDS.indexOf(s.kind) !== -1 ? s.kind : 'tubing';
            out.push({ idx: i, kind: kind, tubKey: e ? s.tubKey : null, id: id, od: od, wall: wall, rough: rough, roughSrc: roughSrc, topMd: top, botMd: bot,
                       label: (kind === 'tubing' ? 'Tubing' : kind === 'liner' ? 'Liner' : 'Casing') + ' ' + _f(od, 3) + ' in (ID ' + _f(id, 3) + ' in)' });
        });
        // overlapping tubing strings (a tapered string is end to end)
        var tub = out.filter(function (s) { return s.kind === 'tubing'; }).sort(function (a, b) { return a.topMd - b.topMd; });
        for (var k = 1; k < tub.length; k++) if (tub[k].topMd < tub[k - 1].botMd - 0.5)
            warnings.push(_w('STRING_OVERLAP', 'Tubing rows overlap between ' + _f(tub[k].topMd, 0) + ' and ' + _f(Math.min(tub[k].botMd, tub[k - 1].botMd), 0) + ' ft MD; the smaller bore is used there.'));
        // tubing that does not fit inside the casing around it
        tub.forEach(function (t) {
            out.forEach(function (c) {
                if (c.kind === 'tubing' || c.botMd <= t.topMd || c.topMd >= t.botMd) return;
                if (t.od >= c.id) warnings.push(_w('TUBING_NOT_INSIDE', 'The ' + _f(t.od, 3) + ' in tubing does not fit inside the ' + _f(c.id, 3) + ' in ID ' + c.kind + ' between ' + _f(Math.max(t.topMd, c.topMd), 0) + ' and ' + _f(Math.min(t.botMd, c.botMd), 0) + ' ft MD.'));
            });
        });
        return out;
    }
    function _covering(strings, md, kinds) {
        return strings.filter(function (s) { return md >= s.topMd - 1e-9 && md <= s.botMd + 1e-9 && (!kinds || kinds.indexOf(s.kind) !== -1); });
    }
    function _minBy(list, key) { var b = null; list.forEach(function (s) { if (!b || s[key] < b[key]) b = s; }); return b; }
    // the flow bore at an MD: tubing path = the innermost string; annulus = casing / liner ID around the tubing OD (below the tubing:
    // the casing bore). null when no string covers the depth.
    function _boreAt(strings, md, path) {
        var all = _covering(strings, md, null);
        if (!all.length) return null;
        if (path === 'annulus') {
            var tub = _minBy(_covering(strings, md, ['tubing']), 'id');
            if (tub) {
                var cas = _minBy(all.filter(function (s) { return s.kind !== 'tubing' && s.id > tub.od; }), 'id');
                if (!cas) return { annulusMissing: true };
                var area = Math.PI / 4 * (cas.id * cas.id - tub.od * tub.od);
                return { id: cas.id - tub.od, area: area, kind: 'annulus', rough: cas.rough, outer: cas, inner: tub,
                         key: 'a|' + cas.id + '|' + tub.od + '|' + cas.rough, label: 'Annulus ' + _f(cas.id, 3) + ' × ' + _f(tub.od, 3) + ' in' };
            }
        }
        var s = _minBy(all, 'id');
        return { id: s.id, area: null, kind: s.kind, rough: s.rough, str: s, key: 'b|' + s.id + '|' + s.rough + '|' + s.kind,
                 label: (s.kind === 'tubing' ? 'Tubing' : s.kind === 'liner' ? 'Liner' : 'Casing') + ' ' + _f(s.id, 3) + ' in' };
    }

    // ── geotherm and BHT ─────────────────────────────────────────────────────
    function _geo(geo, bhtRes, midTvd) {
        var pts = (geo && Array.isArray(geo.points) ? geo.points : []).map(function (p) { return [_num(p && p[0]), _num(p && p[1])]; })
            .filter(function (p) { return _fin(p[0]) && _fin(p[1]) && p[0] >= 0; }).sort(function (a, b) { return a[0] - b[0]; });
        var surf = geo ? _num(geo.surfT_F) : null;
        if (_fin(surf) && !(pts.length && pts[0][0] === 0)) pts.unshift([0, surf]);
        if (pts.length === 1 && _fin(bhtRes) && _fin(midTvd) && midTvd > 0) pts.push([midTvd, bhtRes]);
        if (!pts.length) return null;
        return function (tvd) {
            if (!_fin(tvd)) return NaN;
            if (pts.length === 1) return pts[0][1];
            var k = 1;
            while (k < pts.length - 1 && tvd > pts[k][0]) k++;
            var a = pts[k - 1], b = pts[k];
            return b[0] > a[0] ? a[1] + (b[1] - a[1]) * (tvd - a[0]) / (b[0] - a[0]) : a[1];
        };
    }

    // ── build ────────────────────────────────────────────────────────────────
    function build(well, o) {
        o = o || {};
        var fmt = _fmt(o), warnings = [], errors = [];
        well = (well && typeof well === 'object') ? well : {};
        var traj = _trajectory(well.survey, warnings);
        if (!traj) return _missing('WTS_wellbore.surveyMC');
        (traj.warnings || []).forEach(function (x) { warnings.push(x); });
        var strings = _strings(well.strings, warnings);
        // mid-perforations
        var pTop = _num(well.perfTopMd), pBot = _num(well.perfBotMd);
        if (_fin(pTop) && _fin(pBot) && pTop > pBot) { warnings.push(_w('PERF_ORDER', 'The perforation top is below the bottom; they are swapped.')); var sw = pTop; pTop = pBot; pBot = sw; }
        var mid = _num(well.midPerfMd), midSrc = 'input';
        if (!_fin(mid) && _fin(pTop) && _fin(pBot)) { mid = (pTop + pBot) / 2; midSrc = 'perfs'; }
        if (!_fin(mid)) {
            var deep = 0;
            strings.forEach(function (s) { if (s.botMd > deep) deep = s.botMd; });
            if (traj.tdMd > deep) deep = traj.tdMd;
            if (deep > 0) { mid = deep; midSrc = 'default'; warnings.push(_w('MIDPERF_DEFAULT', 'No mid-perforation depth: ' + fmt.len(mid) + ' MD (the deepest survey station or string) is used.')); }
        }
        if (!(_fin(mid) && mid > 0)) errors.push('The mid-perforation depth (MD) is needed.');
        if (!strings.length) errors.push('At least one string (tubing or casing) is needed for the flow path.');
        var path = well.path === 'annulus' ? 'annulus' : 'tubing';
        if (errors.length) return { ok: false, code: !strings.length ? 'NO_STRINGS' : 'NO_MIDPERF', errors: errors, warnings: warnings, segments: [], path: path };
        if (_fin(pTop) && _fin(pBot) && (mid < pTop - 1e-6 || mid > pBot + 1e-6)) warnings.push(_w('MIDPERF_OUTSIDE', 'The mid-perforation depth ' + fmt.len(mid) + ' MD lies outside the perforated interval.'));
        if (traj.kind !== 'vertical' && mid > traj.tdMd + 1) warnings.push(_w('SURVEY_EXTRAPOLATED', 'The survey ends at ' + fmt.len(traj.tdMd) + ' MD, above the mid-perforations; the hole is continued along the last station\'s direction.'));
        if (traj.kind === 'vertical') warnings.push(_w('NO_SURVEY', 'No survey: the well is treated as vertical (TVD = MD).', 'info'));
        if (traj.maxDls > HIGH_DLS) warnings.push(_w('HIGH_DLS', 'The survey has a dogleg severity of ' + _f(traj.maxDls, 1) + '°/100 ft (above ' + HIGH_DLS + '°/100 ft): check the survey.'));
        if (traj.maxInc > 90 + 1e-9) warnings.push(_w('HOLE_RISES', 'The hole rises (inclination up to ' + _f(traj.maxInc, 1) + '°); TVD falls with MD there.', 'info'));

        var at = function (md) { return traj.at(md); };
        var tvdAt = function (md) { return traj.at(md).tvd; };
        var W = {
            ok: true, errors: [], warnings: warnings, path: path, strings: strings, stations: traj.stations,
            survey: { kind: traj.kind, tdMd: traj.tdMd, maxInc: traj.maxInc, maxDls: traj.maxDls, aziKnown: traj.aziKnown, vsAzi: 0 },
            at: at, tvdAt: tvdAt,
            geo: well.geo || null, heat: well.heat || {}, fluidType: o.fluidType || null,
            choke: (o.surface && o.surface.choke) ? { present: !!o.surface.choke.present, bean64: _num(o.surface.choke.bean64) } : null,
            _restrIn: [], _maxDogleg: _fin(_num(o.maxDoglegDeg)) && o.maxDoglegDeg > 0 ? +o.maxDoglegDeg : DEF_DOGLEG, _fmt: fmt
        };
        W.mdAt = function (tvd) { return _mdAt(W, tvd); };
        var midTvd = tvdAt(mid);
        // vertical-section azimuth: the closure direction at the mid-perforations
        var pm = at(mid);
        if (traj.aziKnown && pm.dep > 1) { var az = Math.atan2(pm.e, pm.n) / DEG; W.survey.vsAzi = az < 0 ? az + 360 : az; }
        var shoe = null;
        strings.forEach(function (s) { if (s.kind === 'tubing' && (shoe === null || s.botMd > shoe)) shoe = s.botMd; });
        // gauges
        var gauges = [];
        function addGauge(md, src) {
            md = _num(md);
            if (!_fin(md) || md < 0) return;
            if (gauges.some(function (g) { return Math.abs(g.md - md) < 0.5; })) return;
            gauges.push({ md: md, tvd: tvdAt(md), source: src });
            if (md > mid + 1) warnings.push(_w('GAUGE_BELOW_MIDPERF', 'The gauge at ' + fmt.len(md) + ' MD is below the mid-perforations.'));
        }
        (Array.isArray(o.gauges) ? o.gauges : []).forEach(function (g) { addGauge(g && typeof g === 'object' ? g.md : g, 'input'); });
        (Array.isArray(o.tests) ? o.tests : []).forEach(function (t) { if (t && t.use !== false) addGauge(t.gaugeMd, 'test ' + (t.id || '')); });
        gauges.sort(function (a, b) { return a.md - b.md; });
        W.nodes = { wellheadMd: 0, wellheadTvd: 0, midPerfMd: mid, midPerfTvd: midTvd, midPerfSource: midSrc,
                    perfTopMd: _fin(pTop) ? pTop : null, perfBotMd: _fin(pBot) ? pBot : null,
                    perfTopTvd: _fin(pTop) ? tvdAt(pTop) : null, perfBotTvd: _fin(pBot) ? tvdAt(pBot) : null,
                    tubingShoeMd: shoe, tubingShoeTvd: shoe === null ? null : tvdAt(shoe), gauges: gauges };
        if (path === 'tubing' && shoe !== null && shoe > mid + 1) warnings.push(_w('TUBING_BELOW_MIDPERF', 'The tubing reaches below the mid-perforations; the flow enters it at ' + fmt.len(mid) + ' MD.', 'info'));
        // restrictions (normalised; applied by segmentsFor)
        (Array.isArray(well.restrictions) ? well.restrictions : []).forEach(function (r, i) {
            if (!r || typeof r !== 'object') return;
            var md = _num(r.md), d = _num(r.id), k = _num(r.k);
            if (!(_fin(md) && md >= 0 && _fin(d) && d > 0)) { warnings.push(_w('RESTR_DROPPED', 'Restriction row ' + (i + 1) + ' was dropped (it needs an MD and an ID).')); return; }
            var kind = RESTR_KINDS.indexOf(r.kind) !== -1 ? r.kind : 'nipple';
            W._restrIn.push({ idx: i, kind: kind, md: md, id: d, k: _fin(k) && k >= 0 ? k : null, label: RESTR_LABEL[kind] });
        });
        W._restrIn.sort(function (a, b) { return a.md - b.md; });
        // the flow segments (mid-perforations → wellhead)
        var segs = segmentsFor(W, {});
        if (segs && segs.ok === false) return { ok: false, code: segs.code, errors: segs.errors, warnings: warnings, segments: [], path: path };
        W.segments = segs;
        var lsum = 0, rsum = 0, rset = {};
        segs.forEach(function (s) { lsum += s.len; rsum += s.len * s.rough; rset[s.rough] = 1; });
        W.rough = lsum > 0 ? rsum / lsum : _roughDefault();
        if (Object.keys(rset).length > 1) warnings.push(_w('ROUGH_MIXED', 'The strings have different roughness; the march takes one value, the length-weighted ' + _f(W.rough, 5) + ' in.', 'info'));
        // deviated sections (> 30° from vertical) for the vertical-only correlations
        var dev = [];
        segs.slice().sort(function (a, b) { return Math.min(a.md0, a.md1) - Math.min(b.md0, b.md1); }).forEach(function (s) {
            if (s.incMax <= DEVIATED_INC) return;
            var a = Math.min(s.md0, s.md1), b = Math.max(s.md0, s.md1), last = dev[dev.length - 1];
            if (last && Math.abs(last.md1 - a) < 1e-6) { last.md1 = b; last.incMax = Math.max(last.incMax, s.incMax); }
            else dev.push({ md0: a, md1: b, incMax: s.incMax });
        });
        W.deviated = dev;
        W.restrictions = restrictions(W);
        W.xToMd = function (x, oo) { return _xToMd(W.segments, x, oo); };
        // flowing temperature (linear, A1)
        var resT = o.res ? _num(o.res.T_F) : null, geoFn = _geo(W.geo, resT, midTvd);
        W.bht = _fin(resT) ? resT : geoFn ? geoFn(midTvd) : null;
        if (_fin(resT) && geoFn && W.geo && Array.isArray(W.geo.points) && W.geo.points.length) {
            var gb = geoFn(midTvd);
            if (_fin(gb) && Math.abs(gb - resT) > 5) warnings.push(_w('BHT_GEOTHERM', 'The reservoir temperature ' + fmt.t(resT) + ' differs from the geotherm at the mid-perforations (' + fmt.t(gb) + '); the reservoir temperature is used.', 'info'));
        }
        W.temp = temperature(W, {});
        W.tAt = W.temp.tAt;
        (W.temp.warnings || []).forEach(function (x) { warnings.push(x); });
        // the WTS_wellbore column (hydrostatic / capacity helpers for the shut-in column)
        W.column = null;
        if (G.WTS_wellbore && typeof G.WTS_wellbore.column === 'function' && midTvd > 0) {
            var col = G.WTS_wellbore.column({ datumTvd: midTvd, datumMd: mid, survey: Array.isArray(well.survey) ? well.survey : [],
                strings: strings.map(function (s) { return { tubKey: s.tubKey, id: s.id, od: s.od, wall: s.wall, rough: s.rough, topMd: s.topMd, botMd: s.botMd }; }) });
            if (col && col.ok) W.column = col;
        }
        return W;
    }
    function _mdAt(W, tvd) {
        if (!_fin(tvd)) return NaN;
        var st = W.stations;
        if (W.survey.kind === 'vertical') return tvd;
        for (var i = 1; i < st.length; i++) if (tvd <= st[i].tvd + 1e-9 && tvd >= st[i - 1].tvd - 1e-9 && st[i].tvd > st[i - 1].tvd) {
            var lo = st[i - 1].md, hi = st[i].md;
            for (var it = 0; it < 60 && hi - lo > 1e-7; it++) { var m = 0.5 * (lo + hi); if (W.tvdAt(m) < tvd) lo = m; else hi = m; }
            return 0.5 * (lo + hi);
        }
        var z = st[st.length - 1], t = _tan(z.inc, z.azi);
        return t[2] > 1e-9 ? z.md + (tvd - z.tvd) / t[2] : NaN;
    }
    // distance along the flow from the first segment's inlet (or, fromTop, from the last segment's outlet) → MD
    function _xToMd(segs, x, o) {
        if (!Array.isArray(segs) || !segs.length || !_fin(x)) return NaN;
        var list = (o && o.fromTop) ? segs.slice().reverse() : segs, acc = 0;
        for (var i = 0; i < list.length; i++) {
            var s = list[i], a = (o && o.fromTop) ? s.md1 : s.md0, b = (o && o.fromTop) ? s.md0 : s.md1;
            if (x <= acc + s.len + 1e-9 || i === list.length - 1) return a + (b - a) * _clamp((x - acc) / s.len, 0, 1);
            acc += s.len;
        }
        return NaN;
    }

    // ── segmentsFor ──────────────────────────────────────────────────────────
    function segmentsFor(W, o) {
        o = o || {};
        if (!W || !Array.isArray(W.strings) || !W.nodes || typeof W.at !== 'function') return { ok: false, code: 'NO_WELL', errors: ['segmentsFor needs a well from WTS_wp_well.build'], warnings: [] };
        var from = _num(o.from), to = _num(o.toMd);
        if (!_fin(from)) from = W.nodes.midPerfMd;
        if (!_fin(to)) to = 0;
        var path = o.path === 'annulus' || o.path === 'tubing' ? o.path : W.path;
        var tol = _fin(_num(o.maxDoglegDeg)) && o.maxDoglegDeg > 0 ? +o.maxDoglegDeg : (W._maxDogleg || DEF_DOGLEG);
        var lo = Math.min(from, to), hi = Math.max(from, to), up = from > to;
        if (!(hi > lo)) return [];
        var fmt = W._fmt || FIELD_FMT, warns = W.warnings || [];
        function warnOnce(code, msg, sev) { if (!warns.some(function (x) { return x.code === code; })) warns.push(_w(code, msg, sev)); }
        // forced breaks: the ends, every string end, every restriction inside the interval
        var cuts = [lo, hi];
        W.strings.forEach(function (s) { [s.topMd, s.botMd].forEach(function (m) { if (m > lo && m < hi) cuts.push(m); }); });
        var restr = (W._restrIn || []).filter(function (r) { return r.md > lo + 1e-6 && r.md < hi - 1e-6 || (r.md === from && from !== 0); });
        restr.forEach(function (r) { if (r.md > lo && r.md < hi) cuts.push(r.md); });
        cuts.sort(function (a, b) { return a - b; });
        var forced = [];
        cuts.forEach(function (m) { if (!forced.length || m - forced[forced.length - 1] > 0.5) forced.push(m); else if (m === hi) forced[forced.length - 1] = hi; });
        // the bore of each forced span; uncovered spans take the nearest string above (else below)
        var spans = [];
        for (var i = 1; i < forced.length; i++) {
            var a = forced[i - 1], b = forced[i], bore = _boreAt(W.strings, 0.5 * (a + b), path);
            if (bore && bore.annulusMissing) return { ok: false, code: 'ANNULUS_NO_CASING', errors: ['Annulus flow needs a casing or liner around the tubing at ' + fmt.len(0.5 * (a + b)) + ' MD.'], warnings: [] };
            spans.push({ a: a, b: b, bore: bore });
        }
        spans.forEach(function (sp, k) {
            if (sp.bore) return;
            var j;
            for (j = k - 1; j >= 0 && !spans[j].bore; j--) { /* search up */ }
            var src = j >= 0 ? spans[j] : null;
            if (!src) for (j = k + 1; j < spans.length && !spans[j].bore; j++) { /* search down */ }
            if (!src && j < spans.length) src = spans[j];
            sp.bore = src ? src.bore : null;
            warnOnce('STRING_GAP', 'No string covers ' + fmt.len(sp.a) + ' to ' + fmt.len(sp.b) + ' MD; the nearest string\'s bore is used there.');
        });
        if (spans.some(function (sp) { return !sp.bore; })) return { ok: false, code: 'NO_STRINGS', errors: ['No string covers the flow path.'], warnings: [] };
        // subdivide each span on the trajectory: a new segment wherever the hole has turned by more than tol
        var st = W.stations || [], pieces = [];
        spans.forEach(function (sp) {
            var pts = [sp.a];
            st.forEach(function (s) { if (s.md > sp.a + 0.5 && s.md < sp.b - 0.5) pts.push(s.md); });
            pts.push(sp.b);
            var start = sp.a, tStart = _tanAt(W, sp.a, +1), prev = sp.a;
            for (var k = 1; k < pts.length; k++) {
                var p = pts[k], tP = _tanAt(W, p, -1), ang = _angle(tStart, tP);
                if (ang <= tol + 1e-9) { prev = p; continue; }
                if (prev > start) {          // close the segment at the previous station and re-test this interval
                    pieces.push({ a: start, b: prev, bore: sp.bore }); start = prev; tStart = _tanAt(W, prev, +1); k--; continue;
                }
                // one curved interval turns by more than tol: equal parts
                var nP = Math.ceil(ang / tol), L = (p - start) / nP;
                for (var q = 1; q < nP; q++) { pieces.push({ a: start, b: start + L, bore: sp.bore }); start += L; }
                prev = p; tStart = _tanAt(W, start, +1);
                pieces.push({ a: start, b: p, bore: sp.bore }); start = p; tStart = _tanAt(W, p, +1);
            }
            if (sp.b > start + 1e-9) pieces.push({ a: start, b: sp.b, bore: sp.bore });
        });
        // segments in flow order
        if (up) pieces.reverse();
        var restrBy = {};
        restr.forEach(function (r) { restrBy[r.md] = r; });
        return pieces.map(function (pc) {
            var ta = W.tvdAt(pc.a), tb = W.tvdAt(pc.b), len = pc.b - pc.a;
            var md0 = up ? pc.b : pc.a, md1 = up ? pc.a : pc.b, tvd0 = up ? tb : ta, tvd1 = up ? ta : tb;
            var ia = W.at(pc.a).inc, ib = W.at(pc.b).inc, mid = W.at(0.5 * (pc.a + pc.b)).inc;
            var incAvg = Math.acos(_clamp((tb - ta) / len, -1, 1)) / DEG;
            var bore = pc.bore, seg = {
                name: bore.label + ' ' + _f(Math.min(md0, md1), 0) + '–' + _f(Math.max(md0, md1), 0) + ' ft MD',
                len: len, id: bore.id, dz: tvd0 - tvd1, md0: md0, md1: md1, tvd0: tvd0, tvd1: tvd1, inc: incAvg,
                incMin: Math.min(ia, ib, mid), incMax: Math.max(ia, ib, mid), kind: bore.kind, rough: bore.rough
            };
            if (bore.area) seg.area = bore.area;
            var r = restrBy[md0];
            if (r) {
                if (path === 'annulus' && bore.kind === 'annulus') warnOnce('RESTR_ANNULUS', 'Tubing restrictions are not in the annulus flow path; they are ignored.', 'info');
                else if (r.id >= bore.id - 1e-9) warnOnce('RESTR_NOT_SMALLER', 'The ' + r.label + ' at ' + fmt.len(r.md) + ' MD (ID ' + fmt.d(r.id) + ') is not smaller than the bore (' + fmt.d(bore.id) + '); no loss is applied.');
                else seg.restr = { d: r.id, k: r.k };
            }
            return seg;
        });
    }
    // unit tangent at an MD (side −1: the direction arriving at md; +1: leaving it — equal on a minimum-curvature arc)
    function _tanAt(W, md, side) {
        var p = W.at(md);
        if (W.survey && W.survey.kind === 'tvd') {
            var q = W.at(md + (side > 0 ? 1e-6 : -1e-6));
            return _tan(_fin(q.inc) ? q.inc : p.inc, 0);
        }
        return _tan(p.inc, p.azi);
    }

    // ── restrictions ─────────────────────────────────────────────────────────
    function restrictions(W) {
        if (!W || !Array.isArray(W._restrIn)) return [];
        var applied = {};
        (W.segments || []).forEach(function (s) { if (s.restr) applied[s.md0] = 1; });
        return W._restrIn.map(function (r) {
            var bore = _boreAt(W.strings, r.md + (W.nodes && W.nodes.midPerfMd > r.md ? -0.25 : 0.25), 'tubing');
            var bid = bore && bore.id ? bore.id : null;
            return { kind: r.kind, md: r.md, tvd: W.tvdAt(r.md), id: r.id, k: r.k, beta: bid ? Math.min(1, r.id / bid) : null, bore: bid,
                     applied: !!applied[r.md], label: r.label };
        });
    }

    // ── temperature (A1 linear + J-T hydrate THT, §4.6) ───────────────────────
    function _muJT(sg, p, t, imp) {
        var f = G.WTS_gaspvt_isenthalpic, x;
        imp = imp || {};
        if (typeof f === 'function') {
            x = f({ sg: sg, p1: p, t1: t, p2: p, co2: imp.co2 || 0, h2s: imp.h2s || 0, n2: imp.n2 || 0 });
            if (x && x.ok && _fin(x.muJT1_Fpsi)) return { mu: x.muJT1_Fpsi, src: 'WTS_gaspvt_isenthalpic' };
        }
        var e = G.WTS_gaspvt_enthalpy;
        if (typeof e === 'function') {
            x = e({ sg: sg, p: p, t: t, co2: imp.co2 || 0, h2s: imp.h2s || 0, n2: imp.n2 || 0 });
            if (x && x.ok !== false && _fin(x.muJT_Fpsi)) return { mu: x.muJT_Fpsi, src: 'WTS_gaspvt_enthalpy' };
        }
        return null;
    }
    function temperature(W, o) {
        o = o || {};
        if (!W || !W.nodes || typeof W.tvdAt !== 'function') return { ok: false, code: 'NO_WELL', errors: ['temperature needs a well from WTS_wp_well.build'], warnings: [] };
        var fmt = W._fmt || FIELD_FMT, warnings = [];
        var heat = W.heat || {}, mid = W.nodes.midPerfMd, midTvd = W.nodes.midPerfTvd;
        var mode = o.mode || heat.mode || 'linear';
        var rx = null;
        if (mode === 'relax') {
            if (_fin(o.q) && o.q > 0 && o.F) {
                rx = relax(W, o.F, o.q, { heat: o.heat, pMean: o.pMean });
                if (!rx.ok) { warnings.push(_w('RELAX_FALLBACK', 'Relaxation model not available (' + ((rx.errors || [])[0] || rx.code) + '): the linear THT → BHT profile is used.')); rx = null; }
            } else if (o.mode === 'relax') warnings.push(_w('TEMP_RELAX_NO_RATE', 'The relaxation profile depends on the rate: it is computed per rate in the solve; the linear THT → BHT profile stands in here.', 'info'));
        }
        var tht = _num(o.tht_F != null ? o.tht_F : heat.tht_F);
        var measured = o.thtMeasured != null ? !!o.thtMeasured : !!heat.thtMeasured;
        if (rx) { tht = rx.tht; measured = false; }                          // the relaxation THT is an estimate (the U fit honours a measurement)
        var bht = _num(o.bht_F); if (!_fin(bht)) bht = _num(W.bht);
        var resT = _fin(bht) ? bht : null;
        var geoFn = _geo(W.geo, resT, midTvd);
        if (!_fin(bht) && geoFn) bht = geoFn(midTvd);
        var res = { ok: true, mode: 'linear', relaxAsked: mode === 'relax', geoAt: geoFn, tht: tht, bht: _fin(bht) ? bht : null, thtHyd: null, muJT: null, dpTubing: null, pMean: null,
                    measured: measured, verdict: null, verdictText: '', warnings: warnings, errors: [] };
        if (!_fin(tht)) {
            if (geoFn) {
                res.mode = 'static';
                res.tAt = function (md) { return geoFn(W.tvdAt(_clamp(md, 0, Infinity))); };
                res.tht = geoFn(0);
                res.thtHyd = res.tht; res.verdict = 'geotherm';
                res.verdictText = 'No THT entered: the static geotherm is used (low for the fluid properties); the hydrate check uses the surface geotherm temperature ' + fmt.t(res.tht) + ' (cold, conservative).';
                warnings.push(_w('NO_THT', 'No wellhead temperature (THT): the static geotherm is used along the well, which under-estimates the flowing temperature.'));
                if (!_fin(bht)) res.bht = geoFn(midTvd);
                return res;
            }
            if (_fin(bht)) {
                res.tht = bht; res.tAt = function () { return bht; }; res.thtHyd = bht; res.verdict = 'upper-bound';
                res.verdictText = 'No THT and no geotherm: the bottom-hole temperature is used everywhere — an upper-bound THT, not conservative for the hydrate check.';
                warnings.push(_w('NO_THT', 'No wellhead temperature (THT) and no geotherm: the bottom-hole temperature ' + fmt.t(bht) + ' is used along the well.'));
                return res;
            }
            return { ok: false, code: 'NO_TEMPERATURE', errors: ['A wellhead temperature (THT), a reservoir temperature or a geotherm is needed.'], warnings: warnings };
        }
        if (!_fin(bht)) { bht = tht; res.bht = null; warnings.push(_w('NO_BHT', 'No reservoir temperature or geotherm: the THT ' + fmt.t(tht) + ' is used along the well.')); }
        var b = bht;
        res.tAt = function (md) { return (_fin(md) && mid > 0) ? tht + (b - tht) * _clamp(md / mid, 0, 1) : tht; };
        if (rx) {
            res.mode = 'relax'; res.tAt = rx.tAt; res.relax = rx;
            res.relaxText = 'Flowing temperature from the heat-transfer relaxation (Ramey / Hasan-Kabir): U ' + _f(rx.U_in, 2) + ' Btu/hr·ft²·°F (' + (rx.Ubasis === 'ti' ? 'inside' : 'outside') + '-radius basis), ' +
                _f(rx.tProd_d, 0) + ' d producing, relaxation distance A ' + fmt.len(rx.A) + ' — ' + RELAX_LABEL + '.';
        }
        if (_fin(bht) && tht > bht + 1e-9) warnings.push(_w('THT_ABOVE_BHT', 'The THT ' + fmt.t(tht) + ' is above the bottom-hole temperature ' + fmt.t(bht) + '.'));
        // the THT of the hydrate check
        var type = o.fluidType || (o.F && o.F.type) || W.fluidType || null;
        var gasLike = type === 'gas' || type === 'condensate';
        if (measured) {
            res.thtHyd = tht; res.verdict = 'measured';
            res.verdictText = 'Measured THT ' + fmt.t(tht) + ' used for the hydrate check.';
            return res;
        }
        if (gasLike) {
            var dp = _num(o.dpTubing), pwf = _num(o.pwf), thp = _num(o.thp), pm = _num(o.pMean);
            if (!_fin(dp) && _fin(pwf) && _fin(thp)) dp = pwf - thp;
            if (!_fin(pm)) pm = (_fin(pwf) && _fin(thp)) ? 0.5 * (pwf + thp) : (_fin(thp) && _fin(dp)) ? thp + dp / 2 : (_fin(pwf) && _fin(dp)) ? pwf - dp / 2 : null;
            var sg = _num(o.sg), imp = (o.F && o.F.pvt && o.F.pvt.imp) || o.imp || null;
            if (!_fin(sg) && o.F) {
                if (typeof o.F.at === 'function' && _fin(pm)) { try { var pr = o.F.at(pm, 0.5 * (tht + b)); if (pr && _fin(pr.sgGas)) sg = pr.sgGas; } catch (e) { /* fluid fixture without at */ } }
                if (!_fin(sg)) sg = _num(o.F.sgg);
                if (!_fin(sg) && o.F.pvt) sg = _num(o.F.pvt.sgGas);
            }
            var mj = (_fin(dp) && dp >= 0 && _fin(pm) && pm > 0 && _fin(sg) && sg > 0) ? _muJT(sg, pm, 0.5 * (tht + b), imp) : null;
            if (mj) {
                var mu = mj.mu;
                res.muJT = mu; res.dpTubing = dp; res.pMean = pm; res.muJTSource = mj.src;
                if (mu < 0) {
                    res.thtHyd = tht; res.verdict = 'jt-corrected';
                    res.verdictText = 'Joule-Thomson coefficient below zero at ' + fmt.p(pm) + ' (inversion): no cooling credit, the THT ' + fmt.t(tht) + ' is used.';
                    warnings.push(_w('JT_INVERSION', 'The gas is above its Joule-Thomson inversion at the mean tubing pressure; no J-T cooling is applied.', 'info'));
                } else {
                    res.thtHyd = tht - mu * dp; res.verdict = 'jt-corrected';
                    res.verdictText = 'Estimated THT corrected for Joule-Thomson cooling: ' + fmt.t(tht) + ' − ' + _f(mu, 4) + ' °F/psi × ' + _f(dp, 0) + ' psi = ' + fmt.t(res.thtHyd) + ' for the hydrate check.';
                }
                return res;
            }
        }
        res.thtHyd = tht; res.verdict = 'upper-bound';
        res.verdictText = 'Estimated THT ' + fmt.t(tht) + ' without a Joule-Thomson correction: upper-bound THT, not conservative for the hydrate check.';
        return res;
    }

    // ── flowing temperature, relaxation (A2, WP14; §4.6) ─────────────────────
    // Decoupled from pressure: one profile per rate, computed before the march and handed to it as tAt (tProfile). The geotherm is
    // read on TVD and the relaxation runs along MD on this well's own trajectory (the same at(md) as the march), from the reservoir
    // temperature at the mid-perforations up to the wellhead, through WTS_wellbore.flowingTemp (direction 'produce').
    var RELAX_DEF = { U_to: 2, tProd_d: 30, ke: 1.4, alpha: 0.04 };       // Appendix B; Q14: 30 d
    var RELAX_LABEL = 'provisional — not verified against a published example';
    var STD_AIR = 0.0764;                                                  // lbm/scf of air at 60 °F, 14.696 psia
    var LBM_PER_BBL_W = 350.17;                                            // lbm per bbl of fresh water (62.37 lbm/ft³ × 5.6146)
    function heatFlow(F, q, o) {
        o = o || {};
        if (!F || !F.ok) return { ok: false, code: 'NO_FLUID', errors: ['the fluid is not built'], warnings: [] };
        var qOk = (q && typeof q === 'object') ? ((+q.qo > 0) || (+q.qw > 0) || (+q.qg_Mscfd > 0)) : q > 0;   // a rate on F.rateBasis or {qo, qw, qg_Mscfd}
        if (!qOk) return { ok: false, code: 'NO_RATE', errors: ['the rate must be above zero'], warnings: [] };
        var ff = (G.WTS_wp_fluid && typeof G.WTS_wp_fluid.flowlineFluid === 'function') ? G.WTS_wp_fluid.flowlineFluid(F, q) : null;
        if (!ff || ff.ok === false) return { ok: false, code: 'NO_FLUID', errors: ['the flowline fluid is not available'], warnings: [] };
        var api = _fin(ff.api) ? ff.api : (_fin(F.api) ? F.api : 35), go = 141.5 / (131.5 + api);
        var gw = _fin(ff.sgw) && ff.sgw > 0 ? ff.sgw : (_fin(F.sgw) && F.sgw > 0 ? F.sgw : 1.0);
        var gg = _fin(ff.sgg) && ff.sgg > 0 ? ff.sgg : (_fin(F.sgg) && F.sgg > 0 ? F.sgg : 0.65);
        var mo = Math.max(0, ff.qo || 0) * LBM_PER_BBL_W * go / 24, mw = Math.max(0, ff.qw || 0) * LBM_PER_BBL_W * gw / 24;
        var mg = Math.max(0, ff.qg_MMscfd || 0) * 1e6 * STD_AIR * gg / 24;
        var w = mo + mw + mg;
        if (!(w > 0)) return { ok: false, code: 'NO_RATE', errors: ['no mass flow at this rate'], warnings: [] };
        var T = _fin(o.T) ? o.T : 150, p = _fin(o.p) && o.p > 0 ? o.p : 1000;
        var cpO = (0.388 + 0.00045 * T) / Math.sqrt(go);                    // Gambill (1957), Btu/lbm·°F
        var cpW = 1.0, cpG = null, src = 'gaspvt_state';
        if (typeof G.WTS_gaspvt_state === 'function') {
            var imp = (F.pvt && F.pvt.imp) || {};
            var st = G.WTS_gaspvt_state(gg, p, T, imp.co2 || 0, imp.h2s || 0, imp.n2 || 0);
            if (st && _fin(st.cpReal) && st.M > 0) cpG = st.cpReal / 4.1868 / st.M;
            else if (st && _fin(st.cp) && st.M > 0) cpG = st.cp / 4.1868 / st.M;
        }
        if (!_fin(cpG) || cpG <= 0) { cpG = 0.55; src = 'default 0.55'; }
        var cpUser = _num(o.cp);
        var cp = _fin(cpUser) && cpUser > 0 ? cpUser : (mo * cpO + mw * cpW + mg * cpG) / w;
        return { ok: true, w: w, cp: cp, cpSource: _fin(cpUser) && cpUser > 0 ? 'input' : 'mass fractions', mass: { oil: mo, water: mw, gas: mg },
                 frac: { oil: mo / w, water: mw / w, gas: mg / w }, cpParts: { oil: cpO, water: cpW, gas: cpG, gasSource: src }, T: T, p: p, warnings: [] };
    }
    function _rto(W) {
        // length-weighted outside radius of the flow conduit along the flow path (the outer string for an annulus path)
        var L = 0, S = 0, tubOd = null;
        (W.strings || []).forEach(function (s) { if (s.kind === 'tubing' && (tubOd === null || s.topMd < 1)) tubOd = s.od; });
        (W.segments || []).forEach(function (sg) {
            var a = Math.min(sg.md0, sg.md1), b = Math.max(sg.md0, sg.md1), od = null;
            (W.strings || []).forEach(function (s) {
                if (od !== null || !(s.topMd < b && s.botMd > a)) return;
                if (W.path === 'annulus' ? s.kind !== 'tubing' : Math.abs(s.id - sg.id) < 1e-6) od = s.od;
            });
            if (od === null) od = tubOd;
            if (_fin(od) && od > 0) { L += sg.len; S += sg.len * od; }
        });
        var odm = L > 0 ? S / L : (tubOd || 2.875);
        var idT = null; (W.strings || []).forEach(function (s) { if (s.kind === 'tubing' && idT === null) idT = s.id; });
        return { r_to: odm / 24, r_ti: (idT || odm * 0.85) / 24, od: odm };
    }
    function _geoPts(geo, bhtRes, midTvd) {
        var pts = (geo && Array.isArray(geo.points) ? geo.points : []).map(function (p) { return [_num(p && p[0]), _num(p && p[1])]; })
            .filter(function (p) { return _fin(p[0]) && _fin(p[1]) && p[0] >= 0; }).sort(function (a, b) { return a[0] - b[0]; });
        var surf = geo ? _num(geo.surfT_F) : null;
        if (_fin(surf) && !(pts.length && pts[0][0] === 0)) pts.unshift([0, surf]);
        if (pts.length === 1 && _fin(bhtRes) && _fin(midTvd) && midTvd > 0) pts.push([midTvd, bhtRes]);
        return pts;
    }
    function relax(W, F, q, o) {
        o = o || {};
        if (!W || !W.ok || !W.nodes) return { ok: false, code: 'NO_WELL', errors: ['relax needs a well from WTS_wp_well.build'], warnings: [] };
        var WB = G.WTS_wellbore;
        if (!WB || typeof WB.flowingTemp !== 'function') return _missing('WTS_wellbore.flowingTemp');
        var heat = {}, k;
        for (k in RELAX_DEF) heat[k] = RELAX_DEF[k];
        var hs = [W.heat || {}, o.heat || {}];
        hs.forEach(function (h) { for (var kk in h) if (h[kk] !== null && h[kk] !== undefined && h[kk] !== '') heat[kk] = h[kk]; });
        var mid = W.nodes.midPerfMd, midTvd = W.nodes.midPerfTvd;
        var pts = _geoPts(W.geo, W.bht, midTvd);
        if (pts.length < 2) return { ok: false, code: 'NO_GEOTHERM', errors: ['The relaxation model needs a geotherm: the surface temperature and the reservoir temperature (or geothermal points).'], warnings: [] };
        var geoFn = _geo(W.geo, W.bht, midTvd), tbh = _fin(W.bht) ? W.bht : geoFn(midTvd);
        var hf = heatFlow(F, q, { T: 0.5 * (tbh + geoFn(0)), p: o.pMean, cp: heat.cp });
        if (!hf.ok) return hf;
        var rr = _rto(W), U = _num(heat.U_to), basis = heat.Ubasis === 'ti' ? 'ti' : 'to';
        var dwb = _num(heat.dwb_in);
        var stations = (W.stations || []).map(function (s) { return [s.md, s.tvd]; });
        var col = { tvdAt: W.tvdAt, mdAt: W.mdAt, datumMd: mid, datumTvd: midTvd, survey: stations,
                    segments: (W.strings || []).map(function (s) { return { od: s.od, id: s.id, topMd: s.topMd, botMd: s.botMd }; }) };
        var opts = { direction: 'produce', w: hf.w, cp: hf.cp, r_to: rr.r_to, ke: _num(heat.ke), alpha: _num(heat.alpha),
                     t_hr: 24 * _num(heat.tProd_d), Tin: tbh, geo: { points: pts }, fromMd: mid, toMd: 0, stepFt: 50 };
        if (_fin(dwb) && dwb > 0) opts.rwb = dwb / 24;
        if (basis === 'ti') { opts.U_ti = U; opts.r_ti = rr.r_ti; } else opts.U_to = U;
        if (o.fit) return { ok: true, col: col, opts: opts, hf: hf, rr: rr, basis: basis };
        var r = WB.flowingTemp(col, opts);
        if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'RELAX_FAILED', errors: (r && r.errors) || ['the relaxation model failed'], warnings: [] };
        return { ok: true, mode: 'relax', tAt: r.tAt, teAt: r.teAt, tht: r.tOut, bht: tbh, teTop: r.teOut, offsetTop: r.offsetOut,
                 A: r.A, fTD: r.fTD, tD: r.tD, U_to: r.U_to, U_in: U, Ubasis: basis, r_to: r.r_to, r_ti: rr.r_ti, rwb: r.rwb, rwbSource: r.rwbSource,
                 ke: r.ke, alpha: r.alpha, t_hr: r.t_hr, tProd_d: r.t_hr / 24, w: hf.w, cp: hf.cp, cpSource: hf.cpSource, frac: hf.frac, cpParts: hf.cpParts,
                 q: q, profile: r.profile, provisional: RELAX_LABEL, verified: false, warnings: r.warnings || [] };
    }
    // U fitted to a measured THT at a rate (1-D Brent on ln U through WTS_wellbore.flowingTempFitU). The fitted value is returned on
    // the basis the model uses (Ubasis 'ti' → U_ti = U_to·r_to / r_ti); the page adopts it into the U field.
    function fitU(W, F, q, thtF, o) {
        o = o || {};
        var T = _num(thtF);
        if (!_fin(T)) return { ok: false, code: 'NO_TARGET', errors: ['A measured wellhead temperature is needed for the U fit.'], warnings: [] };
        var c = relax(W, F, q, { heat: o.heat, pMean: o.pMean, fit: true });
        if (!c.ok) return c;
        var WB = G.WTS_wellbore;
        if (typeof WB.flowingTempFitU !== 'function') return _missing('WTS_wellbore.flowingTempFitU');
        var opts = Object.assign({}, c.opts); delete opts.U_ti; delete opts.r_ti;
        var f = WB.flowingTempFitU(c.col, opts, { T: T, md: 0, Umin: _fin(o.Umin) ? o.Umin : 0.01, Umax: _fin(o.Umax) ? o.Umax : 1000 });
        var toBasis = function (u) { return c.basis === 'ti' ? u * c.rr.r_to / c.rr.r_ti : u; };
        if (!f.ok) {
            var out = { ok: false, code: f.code, errors: f.errors, warnings: [], q: q, tht: T };
            if (f.range) out.range = { tAtUmin: f.range.tAtUmin, tAtUmax: f.range.tAtUmax, Umin: toBasis(f.range.Umin), Umax: toBasis(f.range.Umax) };
            return out;
        }
        return { ok: true, U: toBasis(f.U_to), U_to: f.U_to, Ubasis: c.basis, tht: T, tFit: f.T, resid: f.resid, evals: f.evals, A: f.A, q: q, w: c.hf.w, cp: c.hf.cp,
                 range: { tAtUmin: f.range.tAtUmin, tAtUmax: f.range.tAtUmax }, provisional: RELAX_LABEL, warnings: f.warnings || [] };
    }

    // ── schematic data (the interactive well view, owner GUI requirement 2026-11-11) ─────────────────────────
    var PROFILE_KEYS = ['p', 't', 'hl', 'vm', 'vsl', 'vsg', 'rhoS', 'ero', 'gradEl', 'gradF', 'gradAcc', 'te', 'dte'];   // te, dte (A2): earth T, T − T_earth
    function schematic(W, R, o) {
        o = o || {};
        if (!W || !W.ok || !W.nodes) return { ok: false, code: 'NO_WELL', errors: ['schematic needs a well from WTS_wp_well.build'], warnings: [] };
        var mid = W.nodes.midPerfMd, td = Math.max(mid, W.survey.tdMd || 0);
        W.strings.forEach(function (s) { if (s.botMd > td) td = s.botMd; });
        var vsAz = (W.survey.vsAzi || 0) * DEG, cv = Math.cos(vsAz), sv = Math.sin(vsAz);
        function pt(md) {
            var a = W.at(md);
            return { md: md, tvd: a.tvd, dep: a.dep, n: a.n, e: a.e, vs: W.survey.aziKnown ? a.n * cv + a.e * sv : a.hd, inc: a.inc, azi: a.azi };
        }
        // trajectory: every station + a point at most every step ft (≤ ~400 points)
        var step = Math.max(25, td / 300), mds = [0], seen = {};
        for (var m = step; m < td; m += step) mds.push(m);
        (W.stations || []).forEach(function (s) { if (s.md > 0 && s.md < td) mds.push(s.md); });
        [mid, td].forEach(function (x) { mds.push(x); });
        mds = mds.filter(function (x) { var k = x.toFixed(3); if (seen[k]) return false; seen[k] = 1; return _fin(x); }).sort(function (a, b) { return a - b; });
        var traj = mds.map(pt), ext = { mdMax: td, tvdMax: 0, tvdMin: 0, depMax: 0, vsMin: 0, vsMax: 0, nMin: 0, nMax: 0, eMin: 0, eMax: 0 };
        traj.forEach(function (p) {
            ext.tvdMax = Math.max(ext.tvdMax, p.tvd); ext.tvdMin = Math.min(ext.tvdMin, p.tvd); ext.depMax = Math.max(ext.depMax, p.dep);
            ext.vsMin = Math.min(ext.vsMin, p.vs); ext.vsMax = Math.max(ext.vsMax, p.vs);
            ext.nMin = Math.min(ext.nMin, p.n); ext.nMax = Math.max(ext.nMax, p.n); ext.eMin = Math.min(ext.eMin, p.e); ext.eMax = Math.max(ext.eMax, p.e);
        });
        var strings = W.strings.map(function (s) {
            return { idx: s.idx, kind: s.kind, label: s.label, id: s.id, od: s.od, rough: s.rough, topMd: s.topMd, botMd: s.botMd,
                     topTvd: W.tvdAt(s.topMd), botTvd: W.tvdAt(s.botMd), inFlow: false };
        }).sort(function (a, b) { return b.od - a.od || a.topMd - b.topMd; });
        (W.segments || []).forEach(function (sg) {
            var a = Math.min(sg.md0, sg.md1), b = Math.max(sg.md0, sg.md1);
            strings.forEach(function (s) { if (s.topMd < b && s.botMd > a && (sg.kind === s.kind || sg.kind === 'annulus')) s.inFlow = true; });
        });
        var restr = (W.restrictions || restrictions(W)).map(function (r) { var p = pt(r.md); return Object.assign({}, r, { vs: p.vs, dep: p.dep, n: p.n, e: p.e }); });
        var n = W.nodes, perfs = { topMd: n.perfTopMd, botMd: n.perfBotMd, midMd: n.midPerfMd, topTvd: n.perfTopTvd, botTvd: n.perfBotTvd, midTvd: n.midPerfTvd,
            midVs: pt(n.midPerfMd).vs };
        var gauges = (n.gauges || []).map(function (g) { var p = pt(g.md); return { md: g.md, tvd: g.tvd, vs: p.vs, source: g.source }; });
        var surf = (R && R.surface) ? R.surface : null;
        var choke = (surf && surf.choke) ? Object.assign({ present: true, bean64: W.choke ? W.choke.bean64 : null }, surf.choke) : (W.choke ? Object.assign({}, W.choke) : null);
        // per-depth solution profile (md ascending); the temperature profile alone without a solution
        var prof = [], tr = R && R.traverse && Array.isArray(R.traverse.profile) ? R.traverse.profile : null;
        if (tr) {
            tr.forEach(function (q) {
                if (!q || q.restr) return;
                var md = _fin(q.md) ? q.md : (_fin(q.x) ? W.xToMd(q.x, { fromTop: !!(R.traverse.fromTop) }) : NaN);
                if (!_fin(md)) return;
                var p = pt(md), e = { md: md, tvd: _fin(q.tvd) ? q.tvd : p.tvd, inc: _fin(q.inc) ? q.inc : p.inc, vs: p.vs, dep: p.dep, pattern: q.pattern || null };
                PROFILE_KEYS.forEach(function (k) { e[k] = _fin(q[k]) ? q[k] : null; });
                if (e.t === null && typeof W.tAt === 'function') e.t = W.tAt(md);
                if (e.te === null && W.temp && typeof W.temp.geoAt === 'function') { var te0 = W.temp.geoAt(e.tvd); e.te = _fin(te0) ? te0 : null; }
                e.dte = (_fin(e.t) && _fin(e.te)) ? e.t - e.te : null;
                prof.push(e);
            });
            prof.sort(function (a, b) { return a.md - b.md; });
        } else if (typeof W.tAt === 'function') {
            traj.forEach(function (p) {
                if (p.md > mid + 1e-9) return;
                var e = { md: p.md, tvd: p.tvd, inc: p.inc, vs: p.vs, dep: p.dep, pattern: null };
                PROFILE_KEYS.forEach(function (k) { e[k] = null; });
                e.t = W.tAt(p.md);
                if (W.temp && typeof W.temp.geoAt === 'function') { var te1 = W.temp.geoAt(p.tvd); e.te = _fin(te1) ? te1 : null; }
                e.dte = (_fin(e.t) && _fin(e.te)) ? e.t - e.te : null;
                prof.push(e);
            });
        }
        var ranges = {}, props = [];
        PROFILE_KEYS.forEach(function (k) {
            var lo = Infinity, hi = -Infinity;
            prof.forEach(function (e) { if (_fin(e[k])) { if (e[k] < lo) lo = e[k]; if (e[k] > hi) hi = e[k]; } });
            ranges[k] = lo <= hi ? [lo, hi] : null;
            if (ranges[k]) props.push(k);
        });
        if (prof.some(function (e) { return e.pattern; })) props.push('pattern');
        function at(md) {
            if (!_fin(md)) return null;
            var p = pt(_clamp(md, 0, td)), r = { md: p.md, tvd: p.tvd, inc: p.inc, azi: p.azi, dep: p.dep, vs: p.vs, pattern: null };
            PROFILE_KEYS.forEach(function (k) { r[k] = null; });
            if (prof.length) {
                var k = 0;
                while (k < prof.length - 1 && prof[k + 1].md < md) k++;
                var a = prof[k], b = prof[Math.min(k + 1, prof.length - 1)], f = (b.md > a.md) ? _clamp((md - a.md) / (b.md - a.md), 0, 1) : 0;
                if (md <= prof[prof.length - 1].md + 1e-6 && md >= prof[0].md - 1e-6) {
                    PROFILE_KEYS.forEach(function (key) { r[key] = (_fin(a[key]) && _fin(b[key])) ? a[key] + f * (b[key] - a[key]) : (_fin(a[key]) ? a[key] : null); });
                    r.pattern = f < 0.5 ? a.pattern : b.pattern;
                }
            }
            if (r.t === null && typeof W.tAt === 'function' && md <= mid + 1e-6) r.t = W.tAt(md);
            r.string = null;
            (W.segments || []).forEach(function (sg) { if (md >= Math.min(sg.md0, sg.md1) - 1e-9 && md <= Math.max(sg.md0, sg.md1) + 1e-9) r.string = sg.name; });
            return r;
        }
        function norm(prop, v) {
            var rg = ranges[prop];
            if (!rg || !_fin(v)) return null;
            return rg[1] > rg[0] ? _clamp((v - rg[0]) / (rg[1] - rg[0]), 0, 1) : 0.5;
        }
        return { ok: true, trajectory: traj, vsAzi: W.survey.vsAzi || 0, aziKnown: !!W.survey.aziKnown, surveyKind: W.survey.kind, extents: ext,
                 strings: strings, restrictions: restr, perfs: perfs, gauges: gauges, choke: choke,
                 surface: surf ? { thp: _num(surf.thp), tht: _num(surf.tht), thtHyd: _num(surf.thtHyd) } : null,
                 deviated: (W.deviated || []).slice(), profile: prof, ranges: ranges, props: props, at: at, norm: norm, warnings: [], errors: [] };
    }

    // ── namespace (merge, never replace) ─────────────────────────────────────
    function _safe(name, fn) {
        return function () {
            try { return fn.apply(null, arguments); }
            catch (e) { return { ok: false, code: 'INTERNAL', errors: ['WTS_wp_well.' + name + ' failed: ' + (e && e.message ? e.message : 'error')], warnings: [] }; }
        };
    }
    var NS = G.WTS_wp_well = G.WTS_wp_well || {};
    NS.build = _safe('build', build);
    NS.segmentsFor = _safe('segmentsFor', segmentsFor);
    NS.restrictions = _safe('restrictions', restrictions);
    NS.temperature = _safe('temperature', temperature);
    NS.schematic = _safe('schematic', schematic);
    NS.relax = _safe('relax', relax);
    NS.fitU = _safe('fitU', fitU);
    NS.heatFlow = _safe('heatFlow', heatFlow);
    NS.RELAX_DEFAULTS = Object.freeze(Object.assign({}, RELAX_DEF));
    NS.DEFAULTS = Object.freeze({ maxDoglegDeg: DEF_DOGLEG, highDls: HIGH_DLS, deviatedInc: DEVIATED_INC, rough: DEF_ROUGH });
    NS.version = '4.4-wp14';
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var N = G.WTS_wp_well, bad = [];
    try {
        var W = N.build({ survey: [[0, 0], [8000, 8000]], midPerfMd: 8000, strings: [{ kind: 'tubing', id: 2.441, od: 2.875, topMd: 0, botMd: 7950 },
            { kind: 'casing', id: 6.276, od: 7, topMd: 7950, botMd: 8100 }], geo: { surfT_F: 60, points: [] }, heat: { tht_F: 120 } }, { res: { T_F: 200 } });
        if (!W.ok || W.segments.length !== 2 || Math.abs(W.segments[0].dz - 50) > 1e-9 || W.segments[1].id !== 2.441) bad.push('vertical segments');
        if (Math.abs(W.tAt(4000) - 160) > 1e-9) bad.push('linear temperature');
    } catch (e) { bad.push('threw ' + (e && e.message)); }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-well.js self-test] ' + bad.join('; '));
})();
