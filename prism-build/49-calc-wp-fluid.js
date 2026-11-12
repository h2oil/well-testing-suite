// =============================================================================
// WTS — 49-calc-wp-fluid.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance fluid engine — docs/WELL-PERFORMANCE-PLAN.md §3.2, §4.1, Appendix A (WP1, increment A1).
//
// The module does NOT evaluate any fluid property itself. It builds the `pvt` object that 49-calc-flowline.js reads in
// WTS_flowline_props (fluid.pvt, WP0b) and every property (table, plot, traverse) goes through that one path (§3.2):
//   oil         Standing Rs / Bo (Rs capped at the producing GOR), Beggs-Robinson dead and live μo, above the bubble point
//               Bo = Bob·(p/pb)^(−A/1e5) (the integrated Vasquez-Beggs co, 16-pvt Bo_undersaturated) and the Vasquez-Beggs
//               undersaturated μo (pvt.undersat); a user bubble point shifts the correlation by one point (pvt.pbFactor =
//               Pb_corr(T_res) / Pb_user, so Rs(Pb_user) = GOR at the reservoir temperature)
//   gas         DAK Z with the Sutton pseudo-criticals; with N2 / CO2 / H2S the Wichert-Aziz corrected Z of WTS_gaspvt_z
//               (pvt.imp, mol %); Lee-Gonzalez-Eakin μg
//   wet gas     (type 'condensate', or 'gas' with a CGR; D14) pvt.liquidNoTransfer: the separator gas is all free gas, the
//               condensate is a liquid of constant volume B_c per stock-tank volume (Rs = 0, no mass transfer), dead-oil
//               viscosity at its API; water from the WGR. The recombined well-stream gravity (recombine) is returned as
//               F.sgWell for the reservoir m(p) table and the shut-in gas column only — never used in the march
//   water       Meehan Bw / μw (water producer and water injector)
//   gas injector  (B in the plan) built as a gas-only fluid with an info note
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_fluid
//     .build(fluidSpec, opts?)          fluidSpec = M.fluid (§3.1); opts {T_F reservoir °F (the one-point Pb shift; pass
//                                       M.res.T_F), table true | {dp, dT} (the (p, T)-binned property lookup of the marcher),
//                                       tMin / tMax °F, pMin / pMax psia (validity checks along the well), fmt {p, t}}
//         → F = {ok, type, rateBasis 'liquid'|'gas'|'water', rateUnit, pvt (frozen; the object for WTS_flowline_props
//                fluid.pvt), api, sgg (free-gas gravity used in the march), sgWell, sgw, gor, cgr, wgr, wc, bc, pbUser, T_F,
//                wet, rsb, refQ, at(p psia, T °F, q?) → props, pb(T) → psia | null, rates(q), table(pList, T, q?),
//                validity[], warnings[], errors[], bad[]}
//         at() is WTS_flowline_props(flowlineFluid(F, q ?? F.refQ), p, T): the one fluid-property path of the VLP
//     .table(F, pList, T, q?)           → {ok, T, rows:[{p, rs, bo, muo, co, z, bg, bgRB, mug, rhoO, rhoG, rhoW, bw, muw, sigO,
//                                          sigW, saturated}], pb, warnings}
//     .check(fluidSpec, opts?)          → {ok, errors[], bad[], warnings[], validity:[{corr, label, used, inRange, msg, out[]}]}
//                                         (Appendix A ranges; recorded from the plan, to verify against the papers — Q9)
//     .recombine({sgSep, gorSep, apiST, cgr})
//         → {ok, sgWell, gorTotal, geq, wellGasFactor, mo}  Standing / Craft & Hawkins well-stream gravity
//            γw = (R·γg + A·γo) / (R + B·γo / Mo), R = separator GOR scf/STB (gorSep, or 1e6 / CGR), Mo = 5954 / (API − 8.811);
//            A = ρw·Vm / M_air and B = ρw·Vm with the molar volume Vm at the base conditions (60 °F / 14.696 psia: A ≈ 4,588,
//            B ≈ 132,880; the books print 4,584 and 132,800), so the recombined mass and moles balance exactly.
//            gorTotal = separator + stock-tank gas per STB (A1: no stock-tank gas input, = R); geq = B·γo / Mo (the
//            condensate's gas equivalent, scf/STB); wellGasFactor = (R + geq) / R (well-stream gas per separator scf)
//     .separatorGravity({sgWell, gorSep, apiST, cgr}) → {ok, sgSep}   the inverse (a 'total' basis entered for a wet gas)
//     .families(slot?)                  (A2, WP13) the correlation options of each fluid slot {pb, rs, bo, muod, muo, co, z, mug, sigma}
//                                       → [{key, label, verified, note}] (the A1 default first, then PRiSM_pvt_corrInfo entries)
//     .compare(fluidSpec, {T_F, pList, pr?, slot:'family'|'muod'|'muo'|'co'|'z'|'sigma', keys?})  (A2, WP13) the same fluid built once per option of
//                                       the slot ('family' = Pb / Rs / Bo together) and tabulated through F.table: → {ok, slot, T,
//                                       pList, rows:[{key, label, verified, ok, pb, table:[…F.table rows], at:{pb: row, pr: row}, validity, inRange}], spreadPb}
//     A2 additions to build / check (WP13): corr.co ('vasquezBeggs' | 'petrosky') and corr.sigma ('bakerSwerdloff' | 'abdulMajeed')
//     reach the marcher (pvt.corr.co / .sigma only when not the default); a Vasquez-Beggs Pb / Rs / Bo with the separator pressure
//     and temperature sets pvt.sep {psep_psig, tsep_F} (the 100 psig gas-gravity normalisation); a blank water gravity with a
//     salinity takes the McCain standard density (γw = ρw,std / 62.368); validity verdicts for the Vasquez-Beggs, Glasø and
//     Petrosky-Farshad families (Appendix A) and a "provisional" note on every unverified correlation in use (D17); F.provisional
//     = labels of those; F.table rows gain rsw (McCain gas solubility in water, scf/STB) and co from the selected co key
//     .flowlineFluid(F, q)              q = a number on F.rateBasis (oil: liquid STB/d split by WC; gas: separator gas Mscf/d
//                                       with CGR / WGR; water: BWPD) or {qo, qw, qg_Mscfd}
//         → {qo STB/d, qw BWPD, qg MMscf/d (the flowline key), qg_MMscfd, api, sgg, sgw, pvt}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var RANK = 459.67, MW_AIR = 28.9647, R_GAS = 10.7316;
    var RHO_W_BBL = 62.37 * 5.614583;              // lbm per bbl of water (the 62.37 of the flowline oil density)
    var TYPES = ['oil', 'gas', 'condensate', 'water', 'gasinj', 'waterinj'];
    var CORR_DEFAULT = { pb: 'standing', rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson', muou: 'vasquezBeggs',
        co: 'vasquezBeggs', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin', sigma: 'bakerSwerdloff' };
    // library prefix of each correlation slot (16-pvt PRiSM_pvt_correlations); the march looks the keys up the same way
    var CORR_PREFIX = { rs: 'Rs_', bo: 'Bo_', muod: 'mu_oD_', muo: 'mu_o_', z: 'Z_', mug: 'mu_g_', pb: 'Pb_', co: 'co_', sigma: 'sigma_og_' };
    // the A1 default of each slot (outside the D17 gate) and its label; more options come from PRiSM_pvt_corrInfo (WP13)
    var SLOT_DEF = { pb: ['standing', 'Standing'], rs: ['standing', 'Standing'], bo: ['standing', 'Standing'], muod: ['beggsRobinson', 'Beggs-Robinson'],
        muo: ['beggsRobinson', 'Beggs-Robinson'], co: ['vasquezBeggs', 'Vasquez-Beggs'], z: ['dranchukAbouKassem', 'Dranchuk-Abou-Kassem'],
        mug: ['leeGonzalezEakin', 'Lee-Gonzalez-Eakin'], sigma: ['bakerSwerdloff', 'Baker-Swerdloff'] };
    var FAMILY_LABEL = { standing: 'Standing', vasquezBeggs: 'Vasquez-Beggs', glaso: 'Glasø', petrosky: 'Petrosky-Farshad', egbogah: 'Egbogah',
        bergmanSutton: 'Bergman-Sutton', chewConnally: 'Chew-Connally', abdulMajeed: 'Abdul-Majeed', hallYarborough: 'Hall-Yarborough',
        beggsRobinson: 'Beggs-Robinson', dranchukAbouKassem: 'Dranchuk-Abou-Kassem', leeGonzalezEakin: 'Lee-Gonzalez-Eakin', bakerSwerdloff: 'Baker-Swerdloff' };
    var PROV_NOTE = 'provisional — not verified against a published example';
    function _info(slot, key) {
        var I = G.PRiSM_pvt_corrInfo || {}, p = CORR_PREFIX[slot];
        return (p && I[p + key]) || null;
    }
    function _isProv(slot, key) { var e = _info(slot, key); return !!(e && e.verified === false); }
    function families(slot) {
        var L = _lib(), I = G.PRiSM_pvt_corrInfo || {}, out = {};
        Object.keys(SLOT_DEF).forEach(function (sl) {
            var list = [{ key: SLOT_DEF[sl][0], label: SLOT_DEF[sl][1], verified: true, note: '' }], pre = CORR_PREFIX[sl];
            Object.keys(I).forEach(function (k) {
                var e = I[k]; if (!e || e.slot !== sl || k.indexOf(pre) !== 0) return;
                var key = k.slice(pre.length);
                if (key === SLOT_DEF[sl][0] || (L && typeof L[k] !== 'function')) return;
                list.push({ key: key, label: FAMILY_LABEL[key] || e.label || key, verified: e.verified !== false, note: e.verified === false ? (e.note || PROV_NOTE) : '' });
            });
            out[sl] = list;
        });
        return slot ? (out[slot] || []) : out;
    }
    var REF_Q = { liquid: 1000, gas: 1000, water: 1000 };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v) { if (v === '' || v == null) return null; var n = Number(v); return _fin(n) ? n : NaN; }
    function _lib() { var L = G.PRiSM_pvt_correlations; return (L && L.Z_dranchukAbouKassem && L.Rs_standing) ? L : null; }
    function _basis() {
        var B = G.WTS_baseConditions, b = (B && B.resolve) ? B.resolve(60, 14.696) : null;
        return (b && _fin(b.Tb_F) && _fin(b.Pb_psia)) ? b : { Tb_F: 60, Pb_psia: 14.696 };
    }
    function _fmtN(v, d) {
        if (v == null || !_fin(v)) return '—';
        return G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, d == null ? 2 : d) : Number(v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d });
    }
    var FIELD_FMT = { p: function (v) { return _fmtN(v, 0) + ' psia'; }, t: function (v) { return _fmtN(v, 0) + ' °F'; } };
    function _deepFreeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { _deepFreeze(o[k]); }); }
        return o;
    }
    function _type(t) { return TYPES.indexOf(t) >= 0 ? t : null; }
    function _isGasType(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }
    function _rateBasis(t) { return t === 'oil' ? 'liquid' : (t === 'water' || t === 'waterinj') ? 'water' : 'gas'; }

    // ── Well-stream gravity (Standing; Craft & Hawkins form), constants from the base-condition molar volume ──
    function _wsConst() {
        var b = _basis(), vm = R_GAS * (b.Tb_F + RANK) / b.Pb_psia;     // scf per lb-mol
        return { A: RHO_W_BBL * vm / MW_AIR, B: RHO_W_BBL * vm, vm: vm };
    }
    function _mo(api) { return 5954 / (api - 8.811); }
    function recombine(o) {
        o = o || {};
        var sg = _num(o.sgSep), api = _num(o.apiST), cgr = _num(o.cgr), R = _num(o.gorSep), errors = [];
        if (!(_fin(sg) && sg >= 0.55 && sg <= 3)) errors.push('Separator gas gravity must be between 0.55 and 3.0 (air = 1).');
        if (!(R > 0)) R = (cgr > 0) ? 1e6 / cgr : null;
        if (R == null) {
            if (errors.length) return { ok: false, errors: errors, warnings: [] };
            return { ok: true, sgWell: sg, gorTotal: null, geq: 0, wellGasFactor: 1, mo: null, dry: true, errors: [], warnings: [] };
        }
        if (!(_fin(api) && api > 8.811 + 1e-6 && api <= 100)) errors.push('Condensate API gravity must be between 9 and 100 °API.');
        if (errors.length) return { ok: false, errors: errors, warnings: [] };
        var go = 141.5 / (131.5 + api), mo = _mo(api), C = _wsConst();
        var geq = C.B * go / mo;
        return { ok: true, sgWell: (R * sg + C.A * go) / (R + geq), gorTotal: R, geq: geq, wellGasFactor: (R + geq) / R, mo: mo,
            dry: false, errors: [], warnings: [] };
    }
    function separatorGravity(o) {
        o = o || {};
        var sw = _num(o.sgWell), api = _num(o.apiST), cgr = _num(o.cgr), R = _num(o.gorSep);
        if (!(R > 0)) R = (cgr > 0) ? 1e6 / cgr : null;
        if (!(_fin(sw) && sw > 0)) return { ok: false, errors: ['Well-stream gas gravity is needed.'], warnings: [] };
        if (R == null) return { ok: true, sgSep: sw, errors: [], warnings: [] };
        if (!(_fin(api) && api > 8.811 + 1e-6 && api <= 100)) return { ok: false, errors: ['Condensate API gravity must be between 9 and 100 °API.'], warnings: [] };
        var go = 141.5 / (131.5 + api), C = _wsConst(), sg = (sw * (R + C.B * go / _mo(api)) - C.A * go) / R;
        if (!(sg >= 0.55)) return { ok: false, sgSep: sg, errors: ['The separator gas gravity backed out of the well-stream gravity is below 0.55: check the gravity basis, CGR and API.'], warnings: [] };
        return { ok: true, sgSep: sg, errors: [], warnings: [] };
    }

    // ── Normalised specification (blank optional ratios → 0 with a note; never a default for a required input) ──
    function _norm(spec) {
        spec = spec || {};
        var t = _type(spec.type) || (spec.type == null ? 'oil' : null);
        var c = {}, sc = spec.corr || {};
        Object.keys(CORR_DEFAULT).forEach(function (k) { c[k] = (typeof sc[k] === 'string' && sc[k]) ? sc[k] : CORR_DEFAULT[k]; });
        return {
            type: t, typeRaw: spec.type, api: _num(spec.api), sgg: _num(spec.sgg), sggBasis: spec.sggBasis === 'total' ? 'total' : 'separator',
            psep_psig: _num(spec.psep_psig), tsep_F: _num(spec.tsep_F), gor: _num(spec.gor), cgr: _num(spec.cgr), wgr: _num(spec.wgr),
            wc: _num(spec.wc), sgw: _num(spec.sgw), salinity_ppm: _num(spec.salinity_ppm),
            yN2: _num(spec.yN2), yCO2: _num(spec.yCO2), yH2S: _num(spec.yH2S), pbUser: _num(spec.pbUser), bc: _num(spec.bc), corr: c,
            mult: (spec.match && spec.match.mult && typeof spec.match.mult === 'object') ? spec.match.mult : null
        };
    }

    // Appendix A (recorded from the plan; values from the original papers, to verify — owner Q9) + the gas engine's ranges
    var RANGES = {
        standing: { label: 'Standing Pb / Rs / Bo', api: [16.5, 63.8], t: [100, 258], rs: [20, 1425], sgg: [0.59, 0.95] },
        beggsRobinson: { label: 'Beggs-Robinson μo', api: [16, 58], t: [70, 295], rs: [20, 2070] },
        vasquezBeggs: { label: 'Vasquez-Beggs (undersaturated co, μo)', api: [15.3, 59.5], t: [75, 294], rs: [0, 2199], p: [15, 6055] },
        vasquezBeggsBo: { label: 'Vasquez-Beggs Pb / Rs / Bo', api: [15.3, 59.5], t: [75, 294], rs: [0, 2199], p: [15, 6055] },
        glaso: { label: 'Glasø Pb / Rs / Bo', api: [22.3, 48.1], t: [80, 280], rs: [90, 2637] },
        petrosky: { label: 'Petrosky-Farshad Pb / Rs / Bo / co', api: [16.3, 45], t: [114, 288], rs: [217, 1406] },
        dak: { label: 'Dranchuk & Abou-Kassem Z (Sutton pseudo-criticals)', tpr: [1.05, 3.0], ppr: [0, 15], sgHc: [0.57, 1.68] },
        wichertAziz: { label: 'Wichert-Aziz sour-gas correction', co2: [0, 54.4], h2s: [0, 73.8] }
    };

    function check(spec, opts) {
        opts = opts || {};
        var fmt = opts.fmt || FIELD_FMT;
        var s = (spec && spec.__wpNorm) ? spec : _norm(spec);
        var errors = [], bad = [], warnings = [], validity = [];
        function err(f, m) { errors.push(m); if (bad.indexOf(f) === -1) bad.push(f); }
        function warn(code, m, sev, f) { warnings.push({ code: code, msg: m, sev: sev || 'warn', field: f || null }); }
        var t = s.type;
        if (!t) { err('type', 'Fluid type must be one of oil, gas, condensate, water, gasinj, waterinj.'); return { ok: false, errors: errors, bad: bad, warnings: warnings, validity: validity }; }
        var gasT = _isGasType(t), oil = t === 'oil', water = t === 'water' || t === 'waterinj';
        var cgr = _fin(s.cgr) ? s.cgr : 0, wgr = _fin(s.wgr) ? s.wgr : 0, L0 = _lib();
        // required inputs
        if (oil || gasT) { if (!(_fin(s.sgg) && s.sgg >= 0.55 && s.sgg <= 3)) err('sgg', 'Gas gravity must be between 0.55 and 3.0 (air = 1).'); }
        if (oil) {
            if (!(_fin(s.api) && s.api >= 5 && s.api <= 80)) err('api', 'Oil gravity must be between 5 and 80 °API.');
            if (s.gor == null) err('gor', 'The producing GOR is needed (scf/STB).');
            else if (!(_fin(s.gor) && s.gor >= 0 && s.gor <= 50000)) err('gor', 'GOR must be between 0 and 50,000 scf/STB.');
        }
        if (gasT && t !== 'gasinj') {
            if (Number.isNaN(s.cgr) || cgr < 0 || cgr > 2000) err('cgr', 'CGR must be between 0 and 2,000 STB/MMscf.');
            if (cgr > 0 && !(_fin(s.api) && s.api > 8.811 + 1e-6 && s.api <= 100)) err('api', 'Condensate API gravity must be between 9 and 100 °API.');
            if (Number.isNaN(s.wgr) || wgr < 0 || wgr > 5000) err('wgr', 'WGR must be between 0 and 5,000 STB/MMscf.');
            if (s.cgr == null && t === 'condensate') warn('CGR_BLANK', 'CGR is blank: no condensate is carried.', 'info', 'cgr');
        }
        if (oil) {
            if (s.wc == null) warn('WC_BLANK', 'Water cut is blank: no water is carried.', 'info', 'wc');
            else if (!(_fin(s.wc) && s.wc >= 0 && s.wc <= 1)) err('wc', 'Water cut must be between 0 and 100 %.');
        }
        var needW = water || (oil && s.wc > 0) || (gasT && wgr > 0);
        var sgwSal = (s.sgw == null && _fin(s.salinity_ppm) && s.salinity_ppm >= 0 && L0 && typeof L0.rho_w_mcCain === 'function') ? L0.rho_w_mcCain(s.salinity_ppm) / 62.368 : null;
        if (s.salinity_ppm != null && !(_fin(s.salinity_ppm) && s.salinity_ppm >= 0 && s.salinity_ppm <= 350000)) err('salinity_ppm', 'Salinity must be between 0 and 350,000 ppm.');
        else if (needW && sgwSal != null && s.salinity_ppm > 0) warn('SGW_MCCAIN', 'Water specific gravity ' + _fmtN(sgwSal, 4) + ' from the salinity (McCain standard density, provisional).', 'info', 'sgw');
        if (needW && !(_fin(s.sgw) && s.sgw >= 0.95 && s.sgw <= 1.4) && !(sgwSal != null && s.salinity_ppm > 0 && sgwSal <= 1.4)) err('sgw', 'Water specific gravity must be between 0.95 and 1.40 (or give the salinity).');
        ['yN2', 'yCO2', 'yH2S'].forEach(function (k) {
            if (s[k] != null && !(_fin(s[k]) && s[k] >= 0 && s[k] < 100)) err(k, k.slice(1) + ' must be between 0 and 100 mol %.');
        });
        var yi = (+s.yN2 || 0) + (+s.yCO2 || 0) + (+s.yH2S || 0);
        if (yi >= 95) err('yN2', 'N2 + CO2 + H2S must be below 95 mol % (the gas must be mostly hydrocarbon).');
        if (s.bc != null && !(_fin(s.bc) && s.bc >= 0.5 && s.bc <= 2)) err('bc', 'The condensate volume factor B_c must be between 0.5 and 2.0.');
        if (s.pbUser != null) {
            if (!oil) warn('PB_NOT_OIL', 'A bubble point applies to an oil only: it is ignored for this fluid.', 'info', 'pbUser');
            else if (!(_fin(s.pbUser) && s.pbUser > 14.7 && s.pbUser <= 15000)) err('pbUser', 'Bubble point must be above 14.7 and no more than 15,000 psia.');
            else if (!_fin(+opts.T_F)) warn('PB_SHIFT_NO_T', 'The bubble-point shift needs the reservoir temperature: the correlation bubble point is used.', 'warn', 'pbUser');
        }
        if (t === 'gasinj') warn('GASINJ_B', 'Gas injection wells are planned for a later release: the fluid is treated as gas only.', 'info', 'type');
        // unknown correlation keys fall back to the defaults inside the march — say so
        var L = _lib();
        if (L) Object.keys(CORR_PREFIX).forEach(function (k) {
            var key = s.corr[k];
            if (key !== CORR_DEFAULT[k] && typeof L[CORR_PREFIX[k] + key] !== 'function') warn('CORR_UNKNOWN', 'Correlation "' + String(key).slice(0, 30) + '" (' + k + ') is not available here; ' + CORR_DEFAULT[k] + ' is used.', 'warn', 'corr_' + k);
        });
        if (oil && s.corr.pb !== s.corr.rs && L && typeof L['Rs_' + s.corr.rs] === 'function') warn('PB_FOLLOWS_RS', 'The bubble point follows the solution-GOR correlation (' + (FAMILY_LABEL[s.corr.rs] || s.corr.rs) + '), so that Rs reaches the GOR at the bubble point.', 'info', 'corr_pb');
        if (errors.length) return { ok: false, errors: errors, bad: bad, warnings: warnings, validity: validity };

        // validity ranges of the correlations actually used
        var tr = [opts.tMin, opts.tMax, opts.T_F].map(Number).filter(_fin);
        var tLo = tr.length ? Math.min.apply(null, tr) : null, tHi = tr.length ? Math.max.apply(null, tr) : null;
        var pr = [opts.pMin, opts.pMax].map(Number).filter(_fin);
        var pLo = pr.length ? Math.min.apply(null, pr) : null, pHi = pr.length ? Math.max.apply(null, pr) : null;
        function rng(key, items, used, note) {
            var R = RANGES[key], out = [];
            items.forEach(function (it) {
                var lim = R[it.v]; if (!lim || it.lo == null) return;
                var lo = it.lo, hi = it.hi == null ? it.lo : it.hi;
                if (lo < lim[0] - 1e-9 || hi > lim[1] + 1e-9) out.push({ v: it.v, name: it.name, lo: lo, hi: hi, range: lim });
            });
            var msg;
            if (!used) msg = R.label + ': not used' + (note ? ' (' + note + ')' : '') + '.';
            else if (!out.length) msg = '✓ ' + R.label + ': inputs inside the published data range.';
            else msg = '⚠ ' + R.label + ': ' + out.map(function (o) {
                var show = function (v) { return o.v === 't' ? fmt.t(v) : o.v === 'p' ? fmt.p(v) : _fmtN(v, o.v === 'sgg' || o.v === 'sgHc' || o.v === 'tpr' || o.v === 'ppr' ? 3 : 1); };
                var val = o.lo === o.hi ? show(o.lo) : show(o.lo) + '–' + show(o.hi);
                return o.name + ' ' + val + ' is outside ' + show(o.range[0]) + '–' + show(o.range[1]);
            }).join('; ') + ' (extrapolated).';
            var prov = !!(used && note === 'prov');
            if (prov) msg = msg.replace(/\.$/, '') + ' — ' + PROV_NOTE + '.';
            var e = { corr: key, label: R.label, used: !!used, inRange: !out.length, msg: msg, out: out, provisional: prov };
            validity.push(e);
            if (used && out.length) warn('RANGE_' + key.toUpperCase(), msg.replace(/^⚠ /, ''), 'warn');
            return e;
        }
        var rsb = oil ? s.gor : 0;
        if (oil) {
            rng('standing', [{ v: 'api', name: 'API', lo: s.api }, { v: 't', name: 'temperature', lo: tLo, hi: tHi }, { v: 'rs', name: 'GOR', lo: rsb },
                { v: 'sgg', name: 'gas gravity', lo: s.sgg }], s.corr.rs === 'standing' || s.corr.bo === 'standing');
            rng('beggsRobinson', [{ v: 'api', name: 'API', lo: s.api }, { v: 't', name: 'temperature', lo: tLo, hi: tHi }, { v: 'rs', name: 'GOR', lo: rsb }],
                s.corr.muo === 'beggsRobinson');
            rng('vasquezBeggs', [{ v: 'api', name: 'API', lo: s.api }, { v: 't', name: 'temperature', lo: tLo, hi: tHi }, { v: 'rs', name: 'GOR', lo: rsb },
                { v: 'p', name: 'pressure', lo: pLo, hi: pHi }], true);
            // WP13 families (each provisional, D17): Pb / Rs / Bo (and co for Petrosky-Farshad) when any of their slots is in use
            var famUsed = function (k) { return s.corr.rs === k || s.corr.bo === k || (k === 'petrosky' && s.corr.co === k); };
            if (famUsed('vasquezBeggs')) rng('vasquezBeggsBo', [{ v: 'api', name: 'API', lo: s.api }, { v: 't', name: 'temperature', lo: tLo, hi: tHi }, { v: 'rs', name: 'GOR', lo: rsb },
                { v: 'p', name: 'pressure', lo: pLo, hi: pHi }], true, 'prov');
            ['glaso', 'petrosky'].forEach(function (k) {
                if (famUsed(k)) rng(k, [{ v: 'api', name: 'API', lo: s.api }, { v: 't', name: 'temperature', lo: tLo, hi: tHi }, { v: 'rs', name: 'GOR', lo: rsb }], true, 'prov');
            });
            // the other WP13 options carry no recorded range: a provisional note only
            [['muod', s.corr.muod], ['muo', s.corr.muo], ['sigma', s.corr.sigma]].forEach(function (p) {
                var e = _isProv(p[0], p[1]) ? _info(p[0], p[1]) : null;
                if (e) validity.push({ corr: p[1], label: e.label, used: true, inRange: true, provisional: true, out: [], msg: '✓ ' + e.label + ': no data range recorded — ' + PROV_NOTE + '.' });
            });
        } else if (gasT && cgr > 0) {
            rng('standing', [], false, 'the condensate is a wet-gas liquid with Rs = 0, D14');
        }
        if (oil || gasT) {
            var yco2 = (+s.yCO2 || 0) / 100, yh2s = (+s.yH2S || 0) / 100, yn2 = (+s.yN2 || 0) / 100;
            var sgFree = s.sgg, pc = null;
            if (typeof G.WTS_gaspvt_pseudoCriticals === 'function') { try { pc = G.WTS_gaspvt_pseudoCriticals(sgFree, yco2, yh2s, yn2); } catch (e) { pc = null; } }
            if (!(pc && pc.Tpc > 0) && L) pc = { Tpc: L.Tpc_sutton(sgFree), Ppc: L.Ppc_sutton(sgFree), sgHc: sgFree };
            if (pc && pc.Tpc > 0) {
                rng('dak', [{ v: 'sgHc', name: 'hydrocarbon gas gravity', lo: pc.sgHc },
                    { v: 'tpr', name: 'Tpr', lo: tLo == null ? null : (tLo + RANK) / pc.Tpc, hi: tHi == null ? null : (tHi + RANK) / pc.Tpc },
                    { v: 'ppr', name: 'Ppr', lo: pLo == null ? null : pLo / pc.Ppc, hi: pHi == null ? null : pHi / pc.Ppc }], s.corr.z === 'dranchukAbouKassem' || yi > 0);
                if (s.corr.z !== 'dranchukAbouKassem' && _isProv('z', s.corr.z)) { var ez = _info('z', s.corr.z); validity.push({ corr: s.corr.z, label: ez.label, used: !(yi > 0), inRange: true, provisional: !(yi > 0), out: [], msg: yi > 0 ? ez.label + ': not used (N2 / CO2 / H2S: the corrected DAK Z of the gas PVT engine).' : '✓ ' + ez.label + ': ' + PROV_NOTE + '.' }); }
            }
            if (yco2 + yh2s > 0) rng('wichertAziz', [{ v: 'co2', name: 'CO2 (mol %)', lo: yco2 * 100 }, { v: 'h2s', name: 'H2S (mol %)', lo: yh2s * 100 }], true);
        }
        if (yi > 0 && typeof G.WTS_gaspvt_z !== 'function') warn('IMP_NO_ENGINE', 'The gas PVT engine is not loaded: Z is not corrected for N2 / CO2 / H2S.', 'warn');
        if (yi > 0) warn('IMP_MUG', 'Gas viscosity along the well is Lee-Gonzalez-Eakin without the impurity correction (Z is corrected).', 'info');
        return { ok: true, errors: errors, bad: bad, warnings: warnings, validity: validity };
    }

    // ── Rates: number on the fluid's rate basis or {qo, qw, qg_Mscfd} → the flowline fluid ──
    function _rates(F, q) {
        var t = F.type, qo = 0, qw = 0, qgM = 0;
        if (q && typeof q === 'object') {
            qo = Math.max(0, +q.qo || 0); qw = Math.max(0, +q.qw || 0); qgM = Math.max(0, +q.qg_Mscfd || 0);
        } else {
            var v = (q == null) ? F.refQ : Math.max(0, +q || 0);
            if (t === 'oil') { var wc = F.wc; qo = v * (1 - wc); qw = v * wc; qgM = qo * F.gor / 1000; }
            else if (t === 'water' || t === 'waterinj') qw = v;
            else { qgM = v; qo = F.cgr * v / 1000; qw = F.wgr * v / 1000; }
        }
        return { qo: qo, qw: qw, qg_Mscfd: qgM, qL: qo + qw };
    }
    function flowlineFluid(F, q) {
        if (!F || !F.ok || !F.pvt) return { ok: false, code: 'NO_FLUID', errors: ['the fluid is not built'], warnings: [] };
        var r = _rates(F, q);
        return { qo: r.qo, qw: r.qw, qg: r.qg_Mscfd / 1000, qg_MMscfd: r.qg_Mscfd / 1000, api: F.api, sgg: F.sgg, sgw: F.sgw, pvt: F.pvt };
    }

    function build(spec, opts) {
        opts = opts || {};
        var s = _norm(spec);
        s.__wpNorm = true;
        var chk = check(s, opts);
        var base = { ok: false, type: s.type, errors: chk.errors.slice(), bad: chk.bad.slice(), warnings: chk.warnings.slice(), validity: chk.validity };
        if (!chk.ok) return base;
        if (!_lib() || typeof G.WTS_flowline_props !== 'function') return Object.assign(base, { code: 'MISSING_ENGINE', name: !_lib() ? 'PRiSM_pvt_correlations' : 'WTS_flowline_props', errors: ['the fluid-property engines are not loaded'] });
        var t = s.type, gasT = _isGasType(t), oil = t === 'oil', water = t === 'water' || t === 'waterinj';
        var cgr = (gasT && t !== 'gasinj' && _fin(s.cgr)) ? s.cgr : 0, wgr = (gasT && t !== 'gasinj' && _fin(s.wgr)) ? s.wgr : 0;
        var warnings = chk.warnings.slice(), L0 = _lib();
        var sgFree = (oil || gasT) ? s.sgg : 0.65, sgWell = null;
        var apiUse = _fin(s.api) ? s.api : (gasT ? 55 : 35);   // a liquid-free gas or water: API only feeds unused oil terms
        if (gasT) {
            if (s.sggBasis === 'total' && cgr > 0) {
                var inv = separatorGravity({ sgWell: s.sgg, apiST: s.api, cgr: cgr });
                if (!inv.ok) return Object.assign(base, { errors: inv.errors, bad: ['sgg'] });
                sgFree = inv.sgSep; sgWell = s.sgg;
                warnings.push({ code: 'SGG_TOTAL', msg: 'The well-stream gas gravity ' + _fmtN(s.sgg, 3) + ' was converted to the separator gas gravity ' + _fmtN(sgFree, 3) + ' for the free gas (D14).', sev: 'info', field: 'sgg' });
            } else {
                var rc = recombine({ sgSep: s.sgg, apiST: s.api, cgr: cgr });
                sgWell = rc.ok ? rc.sgWell : s.sgg;
            }
        }
        var vbUsed = oil && (s.corr.rs === 'vasquezBeggs' || s.corr.bo === 'vasquezBeggs');
        var sepOk = _fin(s.psep_psig) && _fin(s.tsep_F) && s.psep_psig + 14.7 > 0;
        if (oil && !vbUsed && s.sggBasis === 'separator' && _fin(s.psep_psig) && Math.abs(s.psep_psig - 100) > 1) {
            warnings.push({ code: 'SGG_BASIS_A1', msg: 'Gas gravity is used as entered (the separator-pressure normalisation of the gravity applies to the Vasquez-Beggs family only).', sev: 'info', field: 'sgg' });
        }
        var pvt = { corr: { rs: s.corr.rs, bo: s.corr.bo, muod: s.corr.muod, muo: s.corr.muo, z: s.corr.z, mug: s.corr.mug } };
        if (oil && s.corr.co !== CORR_DEFAULT.co && typeof L0['co_' + s.corr.co] === 'function') pvt.corr.co = s.corr.co;
        if ((oil || s.cgr > 0) && s.corr.sigma !== CORR_DEFAULT.sigma && typeof L0['sigma_og_' + s.corr.sigma] === 'function') pvt.corr.sigma = s.corr.sigma;
        var sg100 = null;
        if (vbUsed && sepOk) {
            pvt.sep = { psep_psig: s.psep_psig, tsep_F: s.tsep_F };
            sg100 = L0.sg_gas100_vasquezBeggs(sgFree, apiUse, s.tsep_F, s.psep_psig);
            warnings.push({ code: 'VB_SG100', msg: 'Vasquez-Beggs uses the gas gravity corrected to a 100 psig separator: ' + _fmtN(sgFree, 4) + ' → ' + _fmtN(sg100, 4) + '.', sev: 'info', field: 'sgg' });
        } else if (vbUsed) warnings.push({ code: 'VB_SEP_BLANK', msg: 'Separator pressure or temperature is blank: Vasquez-Beggs takes the gas gravity as a 100 psig separator gravity.', sev: 'info', field: 'psep_psig' });
        var sgwUse = _fin(s.sgw) && s.sgw > 0 ? s.sgw : (_fin(s.salinity_ppm) && s.salinity_ppm > 0 && typeof L0.rho_w_mcCain === 'function' ? L0.rho_w_mcCain(s.salinity_ppm) / 62.368 : 1.07);
        if (oil) pvt.undersat = true;
        if (gasT || water) { pvt.liquidNoTransfer = true; pvt.bc = _fin(s.bc) && s.bc > 0 ? s.bc : 1; }
        var yi = (+s.yN2 || 0) + (+s.yCO2 || 0) + (+s.yH2S || 0);
        if (yi > 0 && !water) pvt.imp = { n2: +s.yN2 || 0, co2: +s.yCO2 || 0, h2s: +s.yH2S || 0 };
        if (s.mult) { var m = {}; ['rs', 'bo', 'muo', 'mug', 'z'].forEach(function (k) { if (_fin(+s.mult[k]) && +s.mult[k] > 0) m[k] = +s.mult[k]; }); if (Object.keys(m).length) pvt.mult = m; }
        if (opts.table) pvt.table = opts.table === true ? true : { dp: +opts.table.dp > 0 ? +opts.table.dp : 5, dT: +opts.table.dT > 0 ? +opts.table.dT : 2 };
        // one-point bubble-point shift at the reservoir temperature
        var L = _lib(), T_F = _fin(+opts.T_F) ? +opts.T_F : null, pbShift = null;
        if (oil && _fin(s.pbUser) && T_F != null && s.gor > 0) {
            var pbF = L['Pb_' + s.corr.rs], pbCorr = typeof pbF === 'function' ? (pvt.sep ? pbF(s.api, sgFree, s.gor, T_F, pvt.sep) : pbF(s.api, sgFree, s.gor, T_F)) : NaN;
            if (_fin(pbCorr) && pbCorr > 14.7) { pvt.pbFactor = pbCorr / s.pbUser; pbShift = { pbCorr: pbCorr, pbUser: s.pbUser, factor: pvt.pbFactor, T_F: T_F }; }
            else warnings.push({ code: 'PB_SHIFT_FAILED', msg: 'The correlation bubble point could not be evaluated: no shift is applied.', sev: 'warn', field: 'pbUser' });
        }
        _deepFreeze(pvt);
        var rb = _rateBasis(t);
        var F = {
            ok: true, type: t, rateBasis: rb, rateUnit: rb === 'liquid' ? 'STB/d' : rb === 'water' ? 'BWPD' : 'Mscf/d',
            pvt: pvt, api: apiUse, sgg: sgFree, sgWell: sgWell, sgw: sgwUse, sg100: sg100, salinity_ppm: _fin(s.salinity_ppm) ? s.salinity_ppm : null,
            corr: _deepFreeze(Object.assign({}, s.corr)), provisional: _provList(s, oil, gasT, cgr, yi),
            gor: oil ? s.gor : 0, cgr: cgr, wgr: wgr, wc: oil && _fin(s.wc) ? s.wc : 0, bc: pvt.bc || null,
            pbUser: oil ? s.pbUser : null, pbShift: pbShift, T_F: T_F, wet: gasT && cgr > 0, rsb: oil ? s.gor : 0,
            refQ: REF_Q[rb], imp: pvt.imp || null,
            validity: chk.validity, warnings: warnings, errors: [], bad: []
        };
        F.rates = function (q) { return _rates(F, q); };
        F.at = function (p, T, q) { return G.WTS_flowline_props(flowlineFluid(F, q), +p, +T); };
        // the bubble point at T through the same path (the undersaturated branch reports it): null when Rs never reaches the GOR
        F.pb = function (T) {
            if (!oil || !(F.gor > 0)) return null;
            var r = G.WTS_flowline_props(flowlineFluid(F, { qo: 1000, qw: 0, qg_Mscfd: F.gor }), 30000, +T);
            return r && _fin(r.pb) ? r.pb : null;
        };
        F.table = function (pList, T, q) { return table(F, pList, T, q); };
        return Object.freeze(F);
    }

    // labels of the unverified (D17) correlations this fluid uses
    function _provList(s, oil, gasT, cgr, yi) {
        var out = [], seen = {};
        function add(slot, key) { var e = _isProv(slot, key) ? _info(slot, key) : null; if (e && !seen[e.label]) { seen[e.label] = 1; out.push(e.label); } }
        if (oil) { add('rs', s.corr.rs); add('bo', s.corr.bo); add('muod', s.corr.muod); add('muo', s.corr.muo); add('co', s.corr.co); add('sigma', s.corr.sigma); }
        else if (gasT && cgr > 0) { add('muod', s.corr.muod); add('sigma', s.corr.sigma); }
        if ((oil || gasT) && !(yi > 0)) add('z', s.corr.z);
        return out;
    }
    function table(F, pList, T, q) {
        if (!F || !F.ok) return { ok: false, code: 'NO_FLUID', rows: [], errors: ['the fluid is not built'], warnings: [] };
        var Tn = +T;
        if (!_fin(Tn)) return { ok: false, code: 'BAD_T', rows: [], errors: ['temperature is needed'], warnings: [] };
        var L = _lib(), pb = F.pb(Tn), rows = [], warnings = [];
        (Array.isArray(pList) ? pList : []).forEach(function (pp) {
            var p = +pp;
            if (!(_fin(p) && p > 0)) return;
            var r = F.at(p, Tn, q);
            if (!r) return;
            var co = null;
            if (F.type === 'oil' && pb != null && p > pb) {
                var coF = (F.corr && F.corr.co && typeof L['co_' + F.corr.co] === 'function') ? L['co_' + F.corr.co] : L.co_vasquezBeggs;
                var c = coF(F.api, F.sgg, F.rsb, p, Tn); co = _fin(c) ? c : null;
            }
            var rsw = (r.qL > 0 && r.fw > 0 && typeof L.Rsw_mcCain === 'function') ? L.Rsw_mcCain(p, Tn, F.salinity_ppm || 0) : null;
            rows.push({ p: p, rs: r.rs, bo: r.bo, muo: r.muo, co: co, z: r.z, bg: r.bg, bgRB: r.bg * 1000 / 5.614583, mug: r.mug,
                rhoO: r.rhoO, rhoG: r.rhoG, rhoW: r.rhoW, bw: r.bw, muw: r.muw, sigO: r.sigO, sigW: r.sigW, rsw: _fin(rsw) ? rsw : null,
                saturated: F.type === 'oil' ? !(pb != null && p > pb) : null });
        });
        if (!rows.length) warnings.push({ code: 'NO_ROWS', msg: 'No valid pressures were given.', sev: 'warn' });
        return { ok: rows.length > 0, T: Tn, pb: pb, rows: rows, warnings: warnings, errors: [] };
    }

    // the same fluid once per option of a slot, tabulated through F.table (no numerics of its own)
    function compare(spec, opts) {
        opts = opts || {};
        var slot = ['muod', 'muo', 'co', 'z', 'sigma'].indexOf(opts.slot) >= 0 ? opts.slot : 'family';
        var T = +opts.T_F, pList = Array.isArray(opts.pList) ? opts.pList.map(Number).filter(function (p) { return _fin(p) && p > 0; }) : [];
        if (!_fin(T)) return { ok: false, code: 'BAD_T', errors: ['temperature is needed'], warnings: [], rows: [] };
        var fam = slot === 'family' ? families('rs').filter(function (o) { return families('bo').some(function (b) { return b.key === o.key; }); }) : families(slot);
        if (Array.isArray(opts.keys)) fam = fam.filter(function (o) { return opts.keys.indexOf(o.key) >= 0; });
        var base = spec || {}, rows = [];
        fam.forEach(function (o) {
            var c = Object.assign({}, base.corr || {});
            if (slot === 'family') { c.pb = o.key; c.rs = o.key; c.bo = o.key; } else c[slot] = o.key;
            var F = build(Object.assign({}, base, { corr: c }), { T_F: T, tMin: opts.tMin, tMax: opts.tMax, pMin: opts.pMin, pMax: opts.pMax });
            if (!F.ok) { rows.push({ key: o.key, label: o.label, verified: o.verified, ok: false, errors: F.errors }); return; }
            var tb = table(F, pList, T, opts.q), pb = F.pb(T), at = {};
            if (_fin(pb)) at.pb = (table(F, [pb], T, opts.q).rows || [])[0] || null;
            if (_fin(+opts.pr) && +opts.pr > 0) at.pr = (table(F, [+opts.pr], T, opts.q).rows || [])[0] || null;
            rows.push({ key: o.key, label: o.label, verified: o.verified, ok: tb.ok, pb: pb, table: tb.rows, at: at, validity: F.validity,
                inRange: (F.validity || []).every(function (v) { return v.used === false || v.inRange !== false; }) });
        });
        var pbs = rows.map(function (r) { return r.pb; }).filter(_fin);
        var spread = pbs.length > 1 ? (Math.max.apply(null, pbs) - Math.min.apply(null, pbs)) / Math.min.apply(null, pbs) : null;
        return { ok: rows.some(function (r) { return r.ok; }), slot: slot, T: T, pList: pList, rows: rows, spreadPb: spread, errors: [], warnings: [] };
    }

    var NS = G.WTS_wp_fluid = G.WTS_wp_fluid || {};
    NS.families = families; NS.compare = compare; NS.PROV_NOTE = PROV_NOTE;
    NS.build = build; NS.table = table; NS.check = check; NS.recombine = recombine; NS.separatorGravity = separatorGravity;
    NS.flowlineFluid = flowlineFluid; NS.RANGES = RANGES; NS.CORR_DEFAULT = CORR_DEFAULT; NS.TYPES = TYPES.slice();
    // this file is the implementation: drop the WP0 stub names
    var STUBS = G.__WP_STUBS;
    if (Array.isArray(STUBS)) for (var i = STUBS.length - 1; i >= 0; i--) if (/^WTS_wp_fluid\./.test(STUBS[i])) STUBS.splice(i, 1);
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, W = G.WTS_wp_fluid, bad = [];
    if (!W || typeof W.build !== 'function') return;
    var rc = W.recombine({ sgSep: 0.65, apiST: 55, cgr: 20 });
    if (!(rc.ok && rc.sgWell > 0.65 && rc.sgWell < 0.8)) bad.push('recombine');
    var inv = W.separatorGravity({ sgWell: rc.sgWell, apiST: 55, cgr: 20 });
    if (!(inv.ok && Math.abs(inv.sgSep - 0.65) < 1e-12)) bad.push('inverse');
    if (G.PRiSM_pvt_correlations && G.WTS_flowline_props) {
        var F = W.build({ type: 'oil', api: 35, sgg: 0.65, gor: 500, wc: 0.3, sgw: 1.07 }, { T_F: 200 });
        if (!(F.ok && F.at(1000, 150).rs > 0 && F.pb(200) > 1000)) bad.push('oil');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-fluid.js self-test] ' + bad.join('; '));
})();
