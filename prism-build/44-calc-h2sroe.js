// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — H2S Exposure & Scavenger (h2sroe)
//
// PURPOSE
//   Three independent H2S screening cards on one page:
//     A. Radius of exposure (ROE) for 100 ppm and 500 ppm H2S, using the
//        Pasquill-Gifford screening formulas of Texas Statewide Rule 36
//        (16 TAC §3.36(c)), also used in US federal onshore H2S rules.
//     B. SO2 generated (and H2S left unburned) when sour gas is flared.
//     C. Triazine-type H2S scavenger dosing for a gas stream.
//   A validation error in one card never blocks the other two.
//
// UNITS
//   Field units throughout: gas rates in MMSCFD (standard conditions
//   14.696 psia / 60 °F; 379.48 scf per lb-mol), concentrations in ppm
//   (mole), masses in lb, product volume in US gal. Metric companions
//   (m, kg, L, t) are shown next to the field values. The units layer
//   converts tagged inputs, so the calc always reads imperial values.
//
// PUBLIC API (window.*)
//   renderH2SSafety(body)            paints the page into #pgBody
//   calcH2S()                        reads the DOM, validates, computes, renders
//   WTS_h2s_roe(qMMscfd, ppm)        → {ok, mf, Q, x100_ft, x500_ft, x100_m, x500_m, h2s_lbd, h2s_kgd}
//   WTS_h2s_so2(qMMscfd, ppm, cePct) → {ok, so2_lbhr, so2_kghr, so2_td, h2s_lbhr, h2s_kghr}
//   WTS_h2s_scavenger(qMMscfd, cin, cout, galPerLb)
//                                    → {ok, lb_d, kg_d, gal_d, L_d, L_hr, gal_hr, gr_in, gr_out}
//   WTS_h2sroe_compute(input)        all three at once (registry contract)
//   WTS_h2sUseAOF()                  copies WTS_state.gasdeliv.aofCn into the escape rate
//   Each compute returns {ok:false, errors:[…], bad:[param…]} on bad input.
//
// STATE
//   WTS_state.h2sroe = {x100_ft, x500_ft, so2_lbhr, scav_gal_d, ts, roe, so2, scav}
//
// Registers window.WTS_calcRegistry.h2sroe (Round-9 contract; the host adds
// the route, sidebar button in "Test System Safety" and the dashboard tile).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var SCF_PER_LBMOL = 379.48;       // ideal gas, 14.696 psia and 60 °F
    var MW_H2S = 34.081;              // lb/lb-mol
    var MW_SO2 = 64.064;              // lb/lb-mol
    var LB_TO_KG = 0.45359237;
    var FT_TO_M = 0.3048;
    var GAL_TO_L = 3.785412;          // US gallon
    var SCF_TO_M3 = 0.028316847;
    // grains per 100 scf per ppm: 100 scf · 1e-6 / 379.48 · 34.081 lb · 7000 gr/lb
    var GR100_PER_PPM = 0.062867;
    var ROE_EXP = 0.6258;             // 16 TAC §3.36(c) exponent
    var ROE_K100 = 1.589;             // 100 ppm coefficient
    var ROE_K500 = 0.4546;            // 500 ppm coefficient
    var SALES_LIMIT_PPM = 4;          // common 0.25 gr/100 scf sales-gas limit

    // ── Helpers (page pattern, NEW-CALCS-SPEC §0.3) ─────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    // Auto decimals: about 4-5 significant figures without trailing zeros.
    function _fa(v) {
        if (v == null || !isFinite(v)) return '—';
        var a = Math.abs(v);
        return _fmt(v, a >= 10000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4);
    }
    // value in the display system; impLabel is the imperial text
    function _u(v, cat, d, impLabel) {
        var U = G.WTS_units;
        if (U && U.getSystem && U.getSystem() === 'metric' && U.format) {
            var f = U.format(v, cat);
            return _fmt(f.value, d) + ' ' + f.label;
        }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }

    // ── Pure compute (field units in and out, no DOM) ───────────────

    // Radius of exposure — 16 TAC §3.36(c)(1) (Texas Statewide Rule 36),
    // Pasquill-Gifford screening form:
    //   X100 = (1.589 · mf · Q)^0.6258 ft ;  X500 = (0.4546 · mf · Q)^0.6258 ft
    //   mf = H2S mole fraction, Q = maximum volume available for escape, scf/d
    //   (14.65 psia, 60 °F; for a producing well the current adjusted open flow).
    // H2S mass release = Q · mf / 379.48 · 34.081 lb/d.
    function roe(qMMscfd, ppm) {
        var q = Number(qMMscfd), c = Number(ppm), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 10000)) { errors.push('Maximum escape rate must be above 0 and no more than 10,000 MMSCFD.'); bad.push('q'); }
        if (!(_fin(c) && c > 0 && c <= 1e6)) { errors.push('H2S in gas must be above 0 and no more than 1,000,000 ppm.'); bad.push('ppm'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var mf = c / 1e6, Q = q * 1e6;
        var x100 = Math.pow(ROE_K100 * mf * Q, ROE_EXP);
        var x500 = Math.pow(ROE_K500 * mf * Q, ROE_EXP);
        var lbd = Q * mf / SCF_PER_LBMOL * MW_H2S;
        return {
            ok: true, mf: mf, Q: Q,
            x100_ft: x100, x500_ft: x500, x100_m: x100 * FT_TO_M, x500_m: x500 * FT_TO_M,
            h2s_lbd: lbd, h2s_kgd: lbd * LB_TO_KG
        };
    }

    // SO2 from flaring sour gas — stoichiometry H2S + 1.5 O2 → SO2 + H2O
    // (1 mol SO2 per mol H2S burned):
    //   n = q·1e6 / 379.48 / 24 lb-mol/hr
    //   SO2 = n · mf · CE · 64.064 lb/hr ; unburned H2S = n · mf · (1 − CE) · 34.081 lb/hr
    function so2(qMMscfd, ppm, cePct) {
        var q = Number(qMMscfd), c = Number(ppm), ce = Number(cePct), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 500)) { errors.push('Gas to flare must be above 0 and no more than 500 MMSCFD.'); bad.push('q'); }
        if (!(_fin(c) && c >= 0 && c <= 1e6)) { errors.push('H2S in flared gas must be between 0 and 1,000,000 ppm.'); bad.push('ppm'); }
        if (!(_fin(ce) && ce >= 50 && ce <= 100)) { errors.push('Combustion efficiency must be between 50 and 100 %.'); bad.push('ce'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var mf = c / 1e6, n = q * 1e6 / SCF_PER_LBMOL / 24, f = ce / 100;
        var so2lb = n * mf * f * MW_SO2;
        var h2slb = n * mf * (1 - f) * MW_H2S;
        return {
            ok: true, mf: mf, lbmol_hr: n,
            so2_lbhr: so2lb, so2_kghr: so2lb * LB_TO_KG, so2_td: so2lb * 24 * LB_TO_KG / 1000,
            h2s_lbhr: h2slb, h2s_kghr: h2slb * LB_TO_KG
        };
    }

    // Triazine-type scavenger dosing (mass balance on H2S removed):
    //   removed = q·1e6 · (cin − cout)·1e-6 / 379.48 · 34.081 lb/d
    //   product = removed · consumption (US gal per lb H2S, supplier figure)
    //   gr/100 scf = ppm · 0.062867
    function scavenger(qMMscfd, cin, cout, galPerLb) {
        var q = Number(qMMscfd), ci = Number(cin), co = Number(cout), r = Number(galPerLb), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 500)) { errors.push('Gas to treat must be above 0 and no more than 500 MMSCFD.'); bad.push('q'); }
        var ciOk = _fin(ci) && ci > 0 && ci <= 100000;
        if (!ciOk) { errors.push('Inlet H2S must be above 0 and no more than 100,000 ppm.'); bad.push('cin'); }
        if (!(_fin(co) && co >= 0 && (!ciOk || co < ci))) { errors.push('Target outlet H2S must be 0 ppm or more and below the inlet H2S.'); bad.push('cout'); }
        if (!(_fin(r) && r >= 0.1 && r <= 10)) { errors.push('Product consumption must be between 0.1 and 10 US gal per lb H2S.'); bad.push('ratio'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var lbd = q * 1e6 * (ci - co) * 1e-6 / SCF_PER_LBMOL * MW_H2S;
        var gal = lbd * r, L = gal * GAL_TO_L;
        return {
            ok: true, lb_d: lbd, kg_d: lbd * LB_TO_KG,
            gal_d: gal, L_d: L, L_hr: L / 24, gal_hr: gal / 24,
            gr_in: ci * GR100_PER_PPM, gr_out: co * GR100_PER_PPM, meetsSales: co <= SALES_LIMIT_PPM
        };
    }

    G.WTS_h2s_roe = roe;
    G.WTS_h2s_so2 = so2;
    G.WTS_h2s_scavenger = scavenger;
    // Registry contract: one pure compute for the whole page.
    // input = {q, ppm, fq, fppm, fce, sq, sin, sout, ratio}
    G.WTS_h2sroe_compute = function (input) {
        var i = input || {};
        var a = roe(i.q, i.ppm), b = so2(i.fq, i.fppm, i.fce), c = scavenger(i.sq, i.sin, i.sout, i.ratio);
        return { ok: a.ok && b.ok && c.ok, roe: a, so2: b, scav: c };
    };

    // ── Page ─────────────────────────────────────────────────────────
    var UNITS = {
        hs_q: 'gasRate', hs_ppm: 'concentration', hs_fq: 'gasRate', hs_fppm: 'concentration', hs_fce: 'percent',
        hs_sq: 'gasRate', hs_sin: 'concentration', hs_sout: 'concentration'
    };
    var TITLE = 'H2S Exposure & Scavenger';
    var SUB = 'Radius of exposure for 100 and 500 ppm H2S, SO2 from flaring sour gas, and H2S scavenger dosing';

    // Validation messages in the display system (limits are imperial).
    var MSG = {
        roe: {
            q: function () { return 'Maximum escape rate must be above 0 and no more than ' + _u(10000, 'gasRate', 0, 'MMSCFD') + '.'; },
            ppm: function () { return 'H2S in gas must be above 0 and no more than 1,000,000 ppm.'; }
        },
        so2: {
            q: function () { return 'Gas to flare must be above 0 and no more than ' + _u(500, 'gasRate', 0, 'MMSCFD') + '.'; },
            ppm: function () { return 'H2S in flared gas must be between 0 and 1,000,000 ppm.'; },
            ce: function () { return 'Combustion efficiency must be between 50 and 100 %.'; }
        },
        scv: {
            q: function () { return 'Gas to treat must be above 0 and no more than ' + _u(500, 'gasRate', 0, 'MMSCFD') + '.'; },
            cin: function () { return 'Inlet H2S must be above 0 and no more than 100,000 ppm.'; },
            cout: function () { return 'Target outlet H2S must be 0 ppm or more and below the inlet H2S.'; },
            ratio: function () { return 'Product consumption must be between 0.1 and 10 US gal per lb H2S.'; }
        }
    };
    var IDS = {
        roe: { q: 'hs_q', ppm: 'hs_ppm' },
        so2: { q: 'hs_fq', ppm: 'hs_fppm', ce: 'hs_fce' },
        scv: { q: 'hs_sq', cin: 'hs_sin', cout: 'hs_sout', ratio: 'hs_ratio' }
    };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _note(t) { return '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> ' + t + '</div>'; }
    function _calcBtn(id) {
        return '<button class="btn btn-primary" id="' + id + '" onclick="calcH2S()">Calculate</button>';
    }

    function _errors(resId, group, bad) {
        var res = _byId(resId);
        var items = '';
        for (var i = 0; i < bad.length; i++) {
            var k = bad[i];
            var el = _byId(IDS[group][k]);
            if (el && el.classList) el.classList.add('input-err');
            items += '<li>' + (MSG[group][k] ? MSG[group][k]() : 'Invalid input.') + '</li>';
        }
        if (res) {
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
        }
    }

    function _paintRoe(r) {
        var res = _byId('hs_roe_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_roe_res', 'roe', r.bad); return; }
        var v = '';
        if (r.x100_ft < 50) v += _ok('100 ppm radius of exposure is under 50 ft.');
        else v += _warn('100 ppm radius of exposure is ' + _fa(r.x100_ft) + ' ft — check for public areas inside it; a contingency plan may be required.');
        if (r.x100_ft > 3000) v += _warn('100 ppm radius of exposure exceeds 3,000 ft.');
        if (r.x500_ft >= 50) v += _warn('500 ppm radius of exposure is ' + _fa(r.x500_ft) + ' ft — check for public roads inside it.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Radius of Exposure</div>' +
            _row('H2S mole fraction', _fmt(r.mf, 6)) +
            _row('Escape rate', _fmt(r.Q, 0) + ' scf/d (' + _fa(r.Q * SCF_TO_M3) + ' m³/d)') +
            _row('100 ppm radius of exposure', _fa(r.x100_ft) + ' ft (' + _fa(r.x100_m) + ' m)') +
            _row('500 ppm radius of exposure', _fa(r.x500_ft) + ' ft (' + _fa(r.x500_m) + ' m)') +
            _row('H2S release', _fa(r.h2s_lbd) + ' lb/d (' + _fa(r.h2s_kgd) + ' kg/d)') +
            v +
            _note('Screening formula from Texas Statewide Rule 36 (also used in US federal onshore H2S rules). ' +
                'Escape rate = maximum volume available for escape, for a producing well the current adjusted ' +
                'open-flow rate, at 14.65 psia and 60 °F. Local regulations and site dispersion studies take precedence.') +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintSo2(r) {
        var res = _byId('hs_so2_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_so2_res', 'so2', r.bad); return; }
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">SO2 Generation</div>' +
            _row('SO2', _fa(r.so2_lbhr) + ' lb/hr (' + _fa(r.so2_kghr) + ' kg/hr)') +
            _row('SO2 per day', _fa(r.so2_td) + ' t/d') +
            _row('Unburned H2S', _fa(r.h2s_lbhr) + ' lb/hr (' + _fa(r.h2s_kghr) + ' kg/hr)') +
            _note('Ground-level SO2 concentration depends on flare height, plume rise and weather; a dispersion ' +
                'screening tool is planned (roadmap item 11). Use Flare Emissions for full-period reporting.') +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintScv(r, cin, cout) {
        var res = _byId('hs_scv_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_scv_res', 'scv', r.bad); return; }
        var v = r.meetsSales
            ? _ok('Outlet target meets a 4 ppm (0.25 gr/100 scf) limit.')
            : _warn('Outlet target is above the common 4 ppm (0.25 gr/100 scf) sales-gas limit.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Scavenger Requirement</div>' +
            _row('H2S removed', _fa(r.lb_d) + ' lb/d (' + _fa(r.kg_d) + ' kg/d)') +
            _row('Inlet H2S', _fa(cin) + ' ppm = ' + _fa(r.gr_in) + ' gr/100 scf') +
            _row('Outlet H2S', _fa(cout) + ' ppm = ' + _fa(r.gr_out) + ' gr/100 scf') +
            _row('Product', _fa(r.gal_d) + ' US gal/d (' + _fa(r.L_d) + ' L/d)') +
            _row('Injection rate', _fa(r.L_hr) + ' L/hr (' + _fa(r.gal_hr) + ' US gal/hr)') +
            v +
            _note('Consumption depends on product strength, contact time, temperature and injection design. ' +
                'Use the supplier\'s figure; published field trials of triazine products report about 1.2 to 1.9 ' +
                'US gal per lb H2S removed. Stoichiometric use is lower. Watch for solids from spent product.') +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _calcImpl() {
        var root = _byId('hs_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');

        var a = roe(_num('hs_q'), _num('hs_ppm'));
        var b = so2(_num('hs_fq'), _num('hs_fppm'), _num('hs_fce'));
        var sin = _num('hs_sin'), sout = _num('hs_sout');
        var c = scavenger(_num('hs_sq'), sin, sout, _num('hs_ratio'));
        _paintRoe(a);
        _paintSo2(b);
        _paintScv(c, sin, sout);

        G.WTS_state = G.WTS_state || {};
        G.WTS_state.h2sroe = {
            x100_ft: a.ok ? a.x100_ft : null,
            x500_ft: a.ok ? a.x500_ft : null,
            so2_lbhr: b.ok ? b.so2_lbhr : null,
            scav_gal_d: c.ok ? c.gal_d : null,
            ts: Date.now(),
            roe: a, so2: b, scav: c
        };
        return { roe: a, so2: b, scav: c };
    }

    G.calcH2S = function () { return _canon(_calcImpl); };

    // "Use AOF from Gas Deliverability": WTS_state.gasdeliv.aofCn is in Mscf/d.
    G.WTS_h2sUseAOF = function () {
        var st = G.WTS_state && G.WTS_state.gasdeliv;
        var aof = st ? Number(st.aofCn) : NaN;
        var el = _byId('hs_q');
        if (!el) return false;
        if (!(_fin(aof) && aof > 0)) {
            var res = _byId('hs_roe_res');
            if (res) res.innerHTML = _warn('Open Gas Deliverability &amp; AOF and calculate first.');
            return false;
        }
        var q = Number((aof / 1000).toPrecision(12));
        // Canonical assignment: in metric the units layer shows it converted.
        _canon(function () { el.value = String(q); });
        // Let the page autosave see the new value; the change listener recalculates.
        try {
            if (typeof Event === 'function' && el.dispatchEvent) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) { /* ignore */ }
        G.calcH2S();
        return true;
    };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="hs_root"><div class="cols-2">' +
            // left column
            '<div>' +
            '<div class="card"><div class="card-title">Radius of Exposure</div>' +
            '<div class="fg">' +
            _fg('hs_q', 'Maximum escape rate (MMSCFD)', '10', ' min="0"') +
            _fg('hs_ppm', 'H2S in gas (ppm)', '10000', ' min="0"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc') +
            '<button class="btn btn-secondary" id="hs_useaof" onclick="WTS_h2sUseAOF()">Use AOF from Gas Deliverability</button></div>' +
            '<div id="hs_roe_res" style="margin-top:14px"></div></div>' +
            '<div class="card"><div class="card-title">SO2 from Flaring Sour Gas</div>' +
            '<div class="fg">' +
            _fg('hs_fq', 'Gas to flare (MMSCFD)', '5', ' min="0"') +
            _fg('hs_fppm', 'H2S in flared gas (ppm)', '10000', ' min="0"') +
            _fg('hs_fce', 'Combustion efficiency (%)', '98', ' min="50" max="100"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc2') + '</div>' +
            '<div id="hs_so2_res" style="margin-top:14px"></div></div>' +
            '</div>' +
            // right column
            '<div>' +
            '<div class="card"><div class="card-title">H2S Scavenger Dosing (triazine-type)</div>' +
            '<div class="fg">' +
            _fg('hs_sq', 'Gas to treat (MMSCFD)', '5', ' min="0"') +
            _fg('hs_sin', 'Inlet H2S (ppm)', '50', ' min="0"') +
            _fg('hs_sout', 'Target outlet H2S (ppm)', '4', ' min="0"') +
            _fg('hs_ratio', 'Product consumption, US gal per lb H2S', '1.5', ' min="0.1" max="10"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc3') + '</div>' +
            '<div id="hs_scv_res" style="margin-top:14px"></div></div>' +
            '</div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('hs_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^hs_/.test(e.target.id || '')) G.calcH2S();
            });
        }
        G.calcH2S();
    }
    G.renderH2SSafety = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.h2sroe = {
        key: 'h2sroe',
        title: TITLE,
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9763;',
        badge: 'Safety',
        bc: 'dc-b-orange',
        desc: '100 and 500 ppm radius of exposure, SO2 from flaring sour gas and triazine-type scavenger dosing.',
        render: function (body) { return G.renderH2SSafety(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['hs_roe_res', 'hs_so2_res', 'hs_scv_res'];
            for (var i = 0; i < ids.length; i++) {
                var r = _byId(ids[i]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcH2S(); return; }
            }
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var fails = [], n = 0;
    function rel(a, b, tol, what) {
        n++;
        if (!(isFinite(a) && Math.abs(a - b) <= (tol || 1e-3) * Math.abs(b))) fails.push(what + ': got ' + a + ', expected ' + b);
    }
    function yes(c, what) { n++; if (!c) fails.push(what); }
    var R = G.WTS_h2s_roe, S = G.WTS_h2s_so2, V = G.WTS_h2s_scavenger;
    // Radius of exposure (NEW-CALCS-SPEC §4.3)
    var h1 = R(10, 10000);
    rel(h1.mf, 0.01, 1e-9, 'H1 mf'); rel(h1.x100_ft, 1798.3, 1e-3, 'H1 X100'); rel(h1.x500_ft, 821.8, 1e-3, 'H1 X500');
    rel(h1.x100_m, 548.1, 1e-3, 'H1 X100 m'); rel(h1.x500_m, 250.5, 1e-3, 'H1 X500 m');
    rel(h1.h2s_lbd, 8981.0, 1e-3, 'H1 lb/d'); rel(h1.h2s_kgd, 4073.7, 1e-3, 'H1 kg/d');
    var h2 = R(0.5, 100);
    rel(h2.x100_ft, 15.46, 1e-3, 'H2 X100'); rel(h2.x500_ft, 7.06, 1e-3, 'H2 X500'); rel(h2.x100_m, 4.71, 2e-3, 'H2 X100 m');
    rel(h2.h2s_lbd, 4.490, 1e-3, 'H2 lb/d'); yes(h2.x100_ft < 50, 'H2 under 50 ft');
    var h3 = R(25, 50000);
    rel(h3.x100_ft, 8735.9, 1e-3, 'H3 X100'); rel(h3.x500_ft, 3992.0, 1e-3, 'H3 X500'); rel(h3.h2s_lbd, 112262, 1e-3, 'H3 lb/d');
    yes(h3.x100_ft > 3000, 'H3 over 3000 ft');
    // SO2
    var a = S(5, 10000, 98);
    rel(a.so2_lbhr, 344.68, 1e-3, 'SO2a'); rel(a.so2_kghr, 156.34, 1e-3, 'SO2a kg'); rel(a.so2_td, 3.752, 1e-3, 'SO2a t/d');
    rel(a.h2s_lbhr, 3.742, 1e-3, 'SO2a H2S'); rel(a.h2s_kghr, 1.697, 1e-3, 'SO2a H2S kg');
    var b = S(10, 1000, 99);
    rel(b.so2_lbhr, 69.64, 1e-3, 'SO2b'); rel(b.so2_kghr, 31.59, 1e-3, 'SO2b kg'); rel(b.so2_td, 0.7581, 1e-3, 'SO2b t/d'); rel(b.h2s_lbhr, 0.3742, 1e-3, 'SO2b H2S');
    var c = S(25, 50000, 98);
    rel(c.so2_lbhr, 8616.9, 1e-3, 'SO2c'); rel(c.so2_td, 93.81, 1e-3, 'SO2c t/d'); rel(c.h2s_lbhr, 93.55, 1e-3, 'SO2c H2S');
    // Scavenger
    var s1 = V(5, 50, 4, 1.5);
    rel(s1.lb_d, 20.656, 1e-3, 'S1 lb/d'); rel(s1.kg_d, 9.3695, 1e-3, 'S1 kg/d'); rel(s1.gr_in, 3.143, 1e-3, 'S1 gr in'); rel(s1.gr_out, 0.2515, 1e-3, 'S1 gr out');
    rel(s1.gal_d, 30.98, 1e-3, 'S1 gal/d'); rel(s1.L_d, 117.29, 1e-3, 'S1 L/d'); rel(s1.L_hr, 4.887, 1e-3, 'S1 L/hr'); yes(s1.meetsSales, 'S1 meets 4 ppm');
    var s2 = V(20, 300, 4, 1.2);
    rel(s2.lb_d, 531.67, 1e-3, 'S2 lb/d'); rel(s2.kg_d, 241.16, 1e-3, 'S2 kg/d'); rel(s2.gr_in, 18.86, 1e-3, 'S2 gr in');
    rel(s2.gal_d, 638.0, 1e-3, 'S2 gal/d'); rel(s2.L_d, 2415.1, 1e-3, 'S2 L/d'); rel(s2.L_hr, 100.63, 1e-3, 'S2 L/hr'); yes(s2.meetsSales, 'S2 meets 4 ppm');
    var s3 = V(1, 1000, 16, 2.0);
    rel(s3.lb_d, 88.373, 1e-3, 'S3 lb/d'); rel(s3.gr_out, 1.006, 1e-3, 'S3 gr out'); rel(s3.gal_d, 176.75, 1e-3, 'S3 gal/d');
    rel(s3.L_d, 669.05, 1e-3, 'S3 L/d'); rel(s3.L_hr, 27.88, 1e-3, 'S3 L/hr'); yes(!s3.meetsSales, 'S3 above 4 ppm');
    // Validation
    yes(R(0, 100).ok === false && R(1, NaN).bad.length === 1, 'ROE validation');
    yes(S(5, 100, 40).bad[0] === 'ce' && S(5, 0, 98).ok === true, 'SO2 validation');
    yes(V(5, 50, 50, 1.5).bad[0] === 'cout' && V(5, 50, 4, 20).bad[0] === 'ratio', 'Scavenger validation');
    yes(G.WTS_calcRegistry && G.WTS_calcRegistry.h2sroe && G.WTS_calcRegistry.h2sroe.key === 'h2sroe', 'registered');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[h2sroe self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[h2sroe self-test] ' + n + '/' + n + ' checks passed');
    }
})();
