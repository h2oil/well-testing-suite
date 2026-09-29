// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Separator Sampling & GOR QC (sepqc)
//
// PURPOSE (docs/ROADMAP.md §1.2 #8, method notes §1.3)
//   Quality control of separator samples and of the GOR handed to the PVT
//   laboratory for recombination, following API RP 44 (Sampling Petroleum
//   Reservoir Fluids) practice:
//     • separator vs stock-tank GOR through the separator oil shrinkage
//       (Standing Bo at separator conditions, or a user / laboratory value);
//     • gas rate re-computed with the laboratory gas gravity and Z:
//         q_corr = q_field · √(SG_field / SG_lab) · (Fpv,lab / Fpv,field),
//         Fpv = 1/√Z at the meter (separator) conditions  — AGA-3 /
//         API MPMS 14.3 flow equation, q ∝ Fgr·Fpv with Fgr = 1/√G;
//     • the recombination GOR for the laboratory (scf of separator gas per
//       barrel of separator liquid at separator conditions);
//     • sample validity checks per bottle: opening pressure vs separator
//       pressure, laboratory saturation pressure vs separator conditions,
//       and duplicate-sample agreement, each with ✓ / ⚠ / ✗ verdicts.
//
// SHRINKAGE AND GOR
//   Shrinkage S = stock-tank barrels per barrel of separator oil at
//   separator conditions (S = 1/Bo,sep ≤ 1). The separator volume factor
//   Bsep = 1/S (separator bbl per STB).
//     GOR_ST  [scf sep gas/STB]      = GOR_sep · Bsep = GOR_sep / S
//     GOR_sep [scf sep gas/sep bbl]  = GOR_ST · S
//   (the ROADMAP note writes "GOR_ST = GOR_sep × shrinkage" with the shrinkage
//   taken as the separator volume factor Bsep; with S ≤ 1 defined as above the
//   same relation reads GOR_ST = GOR_sep / S.)
//   Standing (1947), separator oil at its bubble point (as the host Fluid
//   Properties → Shrinkage tab):
//     Rs = γg·[(p/18.2 + 1.4)·10^(0.0125·API − 0.00091·T)]^1.2048   (p psia, T °F)
//     F  = Rs·(γg/γo)^0.5 + 1.25·T ;  Bo = 0.9759 + 0.00012·F^1.2 ;  S = 1/Bo
//   Standing, M.B., "A Pressure-Volume-Temperature Correlation for Mixtures of
//   California Oils and Gases", API Drilling & Production Practice (1947).
//
// Z-FACTOR
//   WTS_gaspvt_compute (46-calc-gaspvt.js: Sutton pseudo-criticals, Kay mixing
//   of N2/CO2/H2S, Wichert–Aziz, Dranchuk–Abou-Kassem Z) at separator
//   pressure and temperature; falls back to the host WTS_aga3_compute Z
//   (Standing pseudo-criticals + DAK) when 46 is not loaded. Either Z can be
//   typed instead (e.g. the Z the field flow computer used).
//
// UNITS
//   Field units inside: psig / psia, °F, MSCFD, bbl/d, scf/bbl. Tagged inputs
//   read imperial inside calcSepQC(); results use the active unit system.
//
// PUBLIC API (window.*)
//   renderSepQC(body), calcSepQC()
//   WTS_sepqc_compute(input) → {ok, …} | {ok:false, errors[], bad[]}
//   WTS_sepqc_standing(psepPsig, tsepF, api, sgGas) → {Rs, F, Bo, S}
// STATE
//   WTS_state.sepqc = {ok, S, Bsep, qGasCorr, gorSepCorr, gorSTCorr, fails, warns, ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    var P_ATM = 14.696, RANKINE = 459.67;
    var NB = 6;                           // bottle rows in the sample table

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x === '' || x == null || (typeof x === 'number' && isNaN(x)); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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

    // ── Pure compute ─────────────────────────────────────────────────

    // Standing (1947) separator oil: Rs, Bo and shrinkage at separator p (psig), T (°F).
    function standing(psepPsig, tF, api, sg) {
        var go = 141.5 / (api + 131.5);
        var Rs = sg * Math.pow(((psepPsig + 14.7) / 18.2 + 1.4) * Math.pow(10, 0.0125 * api - 0.00091 * tF), 1.2048);
        var F = Rs * Math.sqrt(sg / go) + 1.25 * tF;
        var Bo = 0.9759 + 0.00012 * Math.pow(Math.max(F, 0), 1.2);
        return { Rs: Rs, F: F, Bo: Bo, S: 1 / Bo, go: go };
    }

    // Z at separator conditions: 46-calc-gaspvt (Sutton + DAK) or host AGA-3 (Standing + DAK).
    function zAt(sg, pPsia, tF, co2, h2s, n2) {
        if (typeof G.WTS_gaspvt_compute === 'function') {
            var r = G.WTS_gaspvt_compute({ sg: sg, p: pPsia, t: tF, co2: co2, h2s: h2s, n2: n2 });
            if (r && r.ok) return { z: r.z, src: 'Sutton + DAK (Gas PVT)' };
            if (r && r.errors) return { z: NaN, err: r.errors[0] };
        }
        if (typeof G.WTS_aga3_compute === 'function') {
            // Only Z is used; the orifice geometry is a placeholder the Z does not depend on.
            var a = G.WTS_aga3_compute({ D: 4, d: 2, hw: 50, Ps: pPsia - P_ATM, TfF: tF, SG: sg, co2: co2, h2s: h2s, n2: n2 });
            if (a && a.ok) return { z: a.Z, src: 'Standing + DAK (AGA-3)' };
        }
        return { z: NaN, err: 'No Z-factor engine is loaded; type the Z-factors.' };
    }

    function compute(input) {
        var i = input || {};
        var n = function (x) { return _blank(x) ? NaN : Number(x); };
        var psep = n(i.psep), tsep = n(i.tsep), api = n(i.api), sgF = n(i.sgField), sgL = n(i.sgLab);
        var co2 = _blank(i.co2) ? 0 : Number(i.co2), h2s = _blank(i.h2s) ? 0 : Number(i.h2s), n2 = _blank(i.n2) ? 0 : Number(i.n2);
        var zF = n(i.zField), zL = n(i.zLab), qg = n(i.qGas), qo = n(i.qOil);
        var basis = i.oilBasis === 'st' ? 'st' : 'sep';
        var shrM = i.shrMethod === 'user' ? 'user' : 'standing', shrU = n(i.shrUser);
        var tolOpen = _blank(i.tolOpen) ? 5 : Number(i.tolOpen), tolSat = _blank(i.tolSat) ? 5 : Number(i.tolSat), tolDup = _blank(i.tolDup) ? 2 : Number(i.tolDup);
        var bottlesIn = Array.isArray(i.bottles) ? i.bottles : [];
        var errors = [], bad = [], keys = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        if (!(_fin(psep) && psep >= 0 && psep <= 15000)) err('psep', 'Separator pressure must be between 0 and 15,000 psig.');
        if (!(_fin(tsep) && tsep >= -20 && tsep <= 350)) err('tsep', 'Separator temperature must be between -20 and 350 °F.');
        if (!(_fin(api) && api >= 5 && api <= 90)) err('api', 'Stock-tank oil gravity must be between 5 and 90 °API.');
        if (!(_fin(sgF) && sgF >= 0.55 && sgF <= 2)) err('sgField', 'Field (meter) gas gravity must be between 0.55 and 2.0.');
        if (!(_fin(qg) && qg > 0)) err('qGas', 'Field gas rate must be greater than zero.');
        if (!(_fin(qo) && qo > 0)) err('qOil', 'Oil rate must be greater than zero.');
        if (!(_fin(co2) && co2 >= 0 && co2 < 100 && _fin(h2s) && h2s >= 0 && h2s < 100 && _fin(n2) && n2 >= 0 && n2 < 100 && co2 + h2s + n2 < 95)) err('co2', 'Laboratory CO2, H2S and N2 must each be 0–100 mol % and total below 95 %.');
        if (!_blank(i.zField) && !(_fin(zF) && zF > 0.2 && zF < 2)) err('zField', 'Field Z-factor must be between 0.2 and 2, or blank.');
        if (!_blank(i.zLab) && !(_fin(zL) && zL > 0.2 && zL < 2)) err('zLab', 'Laboratory Z-factor must be between 0.2 and 2, or blank.');
        if (shrM === 'user' && !(_fin(shrU) && shrU > 0.3 && shrU <= 1)) err('shrUser', 'Shrinkage factor must be above 0.3 and no more than 1 (stock-tank bbl per separator bbl).');
        if (!(_fin(tolOpen) && tolOpen > 0 && tolOpen <= 50)) err('tolOpen', 'Opening-pressure tolerance must be between 0 and 50 %.');
        if (!(_fin(tolSat) && tolSat > 0 && tolSat <= 50)) err('tolSat', 'Saturation-pressure tolerance must be between 0 and 50 %.');
        if (!(_fin(tolDup) && tolDup > 0 && tolDup <= 50)) err('tolDup', 'Duplicate-agreement tolerance must be between 0 and 50 %.');

        // Bottles: a row is used when it has an opening pressure, a saturation pressure or a gravity.
        var bottles = [];
        bottlesIn.forEach(function (b, k) {
            if (!b) return;
            var po = n(b.pOpen), to = n(b.tOpen), ps = n(b.psat), sg = n(b.sg);
            if (!_fin(po) && !_fin(ps) && !_fin(sg)) return;
            var kind = b.kind === 'gas' ? 'gas' : 'oil', row = k + 1;
            if (!_blank(b.pOpen) && !(_fin(po) && po >= 0 && po <= 15000)) err('b' + row, 'Bottle ' + row + ': opening pressure must be between 0 and 15,000 psig.');
            if (!_blank(b.tOpen) && !(_fin(to) && to >= -20 && to <= 350)) err('b' + row, 'Bottle ' + row + ': opening temperature must be between -20 and 350 °F.');
            if (!_blank(b.psat) && !(_fin(ps) && ps >= 0 && ps <= 15000)) err('b' + row, 'Bottle ' + row + ': saturation pressure must be between 0 and 15,000 psig.');
            if (!_blank(b.sg) && !(_fin(sg) && sg >= 0.55 && sg <= 2)) err('b' + row, 'Bottle ' + row + ': gas gravity must be between 0.55 and 2.0.');
            bottles.push({ row: row, id: String(b.id == null ? '' : b.id).slice(0, 40), kind: kind, pOpen: po, tOpen: to, psat: ps, sg: sg });
        });
        // Laboratory gas gravity: typed, else the mean of the gas bottles' gravities.
        var sgLabSrc = 'input';
        if (!_fin(sgL) && _blank(i.sgLab)) {
            var gs = bottles.filter(function (b) { return b.kind === 'gas' && _fin(b.sg) && b.sg >= 0.55 && b.sg <= 2; });
            if (gs.length) { sgL = gs.reduce(function (s, b) { return s + b.sg; }, 0) / gs.length; sgLabSrc = 'bottles'; }
        }
        if (!(_fin(sgL) && sgL >= 0.55 && sgL <= 2)) err('sgLab', 'Laboratory gas gravity must be between 0.55 and 2.0 (or blank with gas bottle gravities entered).');
        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };

        var psepA = psep + P_ATM, tsepR = tsep + RANKINE;

        // Z-factors at the meter (separator) conditions.
        var zFsrc = 'input', zLsrc = 'input';
        if (!_fin(zF)) { var a = zAt(sgF, psepA, tsep, 0, 0, 0); zF = a.z; zFsrc = a.src; if (!_fin(zF)) { err('zField', 'Field Z could not be computed: ' + (a.err || '') + ' Type the Z-factor.'); } }
        if (!_fin(zL)) { var b2 = zAt(sgL, psepA, tsep, co2, h2s, n2); zL = b2.z; zLsrc = b2.src; if (!_fin(zL)) { err('zLab', 'Laboratory Z could not be computed: ' + (b2.err || '') + ' Type the Z-factor.'); } }
        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };

        // Shrinkage.
        var st = standing(psep, tsep, api, sgL);
        var S = shrM === 'user' ? shrU : st.S, Bsep = 1 / S;

        // Gas-rate correction (AGA-3: q ∝ Fgr·Fpv; Fgr = 1/√G, Fpv = 1/√Z).
        var fgrRatio = Math.sqrt(sgF / sgL);
        var fpvF = 1 / Math.sqrt(zF), fpvL = 1 / Math.sqrt(zL), fpvRatio = fpvL / fpvF;
        var corr = fgrRatio * fpvRatio, qgc = qg * corr;

        // Oil rates on both bases.
        var qoSep = basis === 'sep' ? qo : qo / S, qoST = basis === 'st' ? qo : qo * S;
        var gorSepF = 1000 * qg / qoSep, gorSTF = 1000 * qg / qoST;
        var gorSepC = 1000 * qgc / qoSep, gorSTC = 1000 * qgc / qoST;
        // Total producing GOR estimate: separator gas + stock-tank flash gas (Standing Rs at separator).
        var gorTot = gorSTC + st.Rs;

        // ── Sample checks ───────────────────────────────────────────
        var checks = [];
        function chk(level, text, row) { checks.push({ level: level, text: text, row: row || 0 }); }
        bottles.forEach(function (b) {
            b.checks = [];
            var add = function (level, text) { b.checks.push(level); chk(level, text, b.row); };
            var label = 'Bottle ' + b.row;
            if (_fin(b.pOpen)) {
                var tO = _fin(b.tOpen) ? b.tOpen : tsep, poA = b.pOpen + P_ATM, exp;
                if (b.kind === 'gas') {
                    // Constant-volume gas bottle: p/T constant (ideal gas; Z ratio neglected).
                    exp = psepA * (tO + RANKINE) / tsepR;
                } else {
                    exp = psepA;
                }
                b.pOpenExpG = exp - P_ATM;
                b.openDev = 100 * (poA - exp) / exp;
                if (b.kind === 'oil' && Math.abs(tO - tsep) > 5) {
                    add('warn', label + ' (oil): opened at ' + _fmt(tO, 0) + ' °F, not at separator temperature; the opening-pressure check is indicative only.');
                }
                if (b.openDev < -tolOpen) add('bad', label + ': opening pressure is ' + _fmt(-b.openDev, 1) + ' % below the expected value: possible leak or lost gas.');
                else if (b.openDev > tolOpen) add('warn', label + ': opening pressure is ' + _fmt(b.openDev, 1) + ' % above the expected value: check the bottle temperature and filling.');
                else add('ok', label + ': opening pressure within ' + _fmt(tolOpen, 1) + ' % of the expected value.');
            }
            if (b.kind === 'oil' && _fin(b.psat)) {
                var psA = b.psat + P_ATM;
                b.satDev = 100 * (psA - psepA) / psepA;
                if (b.satDev < -tolSat) add('bad', label + ': saturation pressure is ' + _fmt(-b.satDev, 1) + ' % below separator pressure: gas lost from the sample (leak or poor transfer).');
                else if (b.satDev > tolSat) add('bad', label + ': saturation pressure is ' + _fmt(b.satDev, 1) + ' % above separator pressure: free gas in the sample (carry-under) or separator not at equilibrium.');
                else add('ok', label + ': saturation pressure within ' + _fmt(tolSat, 1) + ' % of separator pressure.');
            } else if (b.kind === 'oil') {
                add('warn', label + ' (oil): no laboratory saturation pressure entered.');
            }
            if (b.kind === 'gas' && _fin(b.psat)) add('warn', label + ': a saturation pressure is only checked for oil bottles.');
            b.verdict = b.checks.indexOf('bad') !== -1 ? 'bad' : b.checks.indexOf('warn') !== -1 ? 'warn' : 'ok';
        });
        function spread(vals) {
            var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
            return { max: mx, min: mn, mean: mean, pct: 100 * (mx - mn) / mean };
        }
        var dup = {};
        var oilPs = bottles.filter(function (b) { return b.kind === 'oil' && _fin(b.psat); }).map(function (b) { return b.psat + P_ATM; });
        if (oilPs.length >= 2) {
            dup.oil = spread(oilPs);
            if (dup.oil.pct <= tolDup) chk('ok', 'Duplicate oil samples: saturation pressures agree within ' + _fmt(dup.oil.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
            else chk('bad', 'Duplicate oil samples: saturation pressures differ by ' + _fmt(dup.oil.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
        } else chk('warn', 'Fewer than two oil samples with a saturation pressure: no duplicate check (API RP 44 recommends duplicates).');
        var gasSg = bottles.filter(function (b) { return b.kind === 'gas' && _fin(b.sg); }).map(function (b) { return b.sg; });
        if (gasSg.length >= 2) {
            dup.gas = spread(gasSg);
            if (dup.gas.pct <= tolDup) chk('ok', 'Duplicate gas samples: gas gravities agree within ' + _fmt(dup.gas.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
            else chk('bad', 'Duplicate gas samples: gas gravities differ by ' + _fmt(dup.gas.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
        } else chk('warn', 'Fewer than two gas samples with a laboratory gravity: no duplicate check.');
        var gasCorrPct = 100 * (corr - 1);
        if (Math.abs(gasCorrPct) > 2) chk('warn', 'Laboratory gravity and Z change the gas rate by ' + _fmt(gasCorrPct, 2) + ' %: report the corrected GOR to the laboratory.');

        var fails = checks.filter(function (c) { return c.level === 'bad'; }).length;
        var warns = checks.filter(function (c) { return c.level === 'warn'; }).length;
        return {
            ok: true, psep: psep, psepA: psepA, tsep: tsep, api: api, sgField: sgF, sgLab: sgL, sgLabSrc: sgLabSrc,
            co2: co2, h2s: h2s, n2: n2, zField: zF, zLab: zL, zFieldSrc: zFsrc, zLabSrc: zLsrc,
            fpvField: fpvF, fpvLab: fpvL, fgrRatio: fgrRatio, fpvRatio: fpvRatio, corr: corr, gasCorrPct: gasCorrPct,
            qGas: qg, qGasCorr: qgc, qOil: qo, oilBasis: basis, qOilSep: qoSep, qOilST: qoST,
            shrMethod: shrM, S: S, Bsep: Bsep, standing: st,
            gorSepField: gorSepF, gorSTField: gorSTF, gorSepCorr: gorSepC, gorSTCorr: gorSTC, gorTotal: gorTot,
            tolOpen: tolOpen, tolSat: tolSat, tolDup: tolDup,
            bottles: bottles, dup: dup, checks: checks, fails: fails, warns: warns
        };
    }

    G.WTS_sepqc_compute = compute;
    G.WTS_sepqc_standing = standing;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Separator Sampling & GOR QC';
    var SUB = 'Separator vs stock-tank GOR, gas rate re-computed with laboratory gravity and Z, recombination GOR and sample validity checks (API RP 44)';
    var UNITS = {
        sq_psep: 'pressureG', sq_tsep: 'temperature', sq_api: 'api', sq_sgf: 'sg', sq_sgl: 'sg',
        sq_co2: 'percent', sq_h2s: 'percent', sq_n2: 'percent',
        sq_qg: 'gasRateSmall', sq_qo: 'liquidRate',
        sq_tolo: 'percent', sq_tols: 'percent', sq_told: 'percent'
    };
    for (var bi = 1; bi <= NB; bi++) { UNITS['sq_bpo' + bi] = 'pressureG'; UNITS['sq_bto' + bi] = 'temperature'; UNITS['sq_bps' + bi] = 'pressureG'; UNITS['sq_bsg' + bi] = 'sg'; }
    var IDS = {
        psep: 'sq_psep', tsep: 'sq_tsep', api: 'sq_api', sgField: 'sq_sgf', sgLab: 'sq_sgl', co2: 'sq_co2',
        zField: 'sq_zf', zLab: 'sq_zl', qGas: 'sq_qg', qOil: 'sq_qo', shrUser: 'sq_shr',
        tolOpen: 'sq_tolo', tolSat: 'sq_tols', tolDup: 'sq_told'
    };
    var MSG = {
        psep: function () { return 'Separator pressure must be between ' + _u(0, 'pressureG', 0, 'psig') + ' and ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        tsep: function () { return 'Separator temperature must be between ' + _u(-20, 'temperature', 0, '°F') + ' and ' + _u(350, 'temperature', 0, '°F') + '.'; }
    };
    // [id, kind, pOpen, tOpen, psat, sg]
    var DEF_B = [
        ['A-101', 'oil', '495', '100', '505', ''],
        ['A-102', 'oil', '490', '100', '498', ''],
        ['G-201', 'gas', '470', '70', '', '0.752'],
        ['G-202', 'gas', '468', '70', '', '0.748']
    ];

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _selHtml(id, opts, val, aria) {
        var h = '<select id="' + id + '"' + (aria ? ' aria-label="' + aria + '"' : '') + '>';
        opts.forEach(function (o) { h += '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; });
        return h + '</select>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _v(c) { return c.level === 'bad' ? _bad(c.text) : c.level === 'warn' ? _warn(c.text) : _ok(c.text); }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function _gor(v, basis) {   // basis: 'st' (per STB) or 'sep' (per separator bbl)
        if (!_fin(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, 'gor'); return _fmt(f.value, 2) + ' ' + f.label + (basis === 'sep' ? ' (separator liquid)' : ' (stock tank)'); }
        return _fmt(v, 1) + (basis === 'sep' ? ' scf/sep bbl' : ' scf/STB');
    }

    function _resultsHtml(r) {
        var h = '';
        var Q = function (v) { return _u(v, 'gasRateSmall', 1, 'MSCFD', 1); };
        var L = function (v) { return _u(v, 'liquidRate', 1, 'BPD', 2); };
        // 1 — gas-rate re-computation
        h += '<div class="rbox"><div class="rbox-title">Gas Rate Re-computation</div>' +
            _row('Field gas gravity (meter)', _fmt(r.sgField, 4)) +
            _row('Laboratory gas gravity', _fmt(r.sgLab, 4) + (r.sgLabSrc === 'bottles' ? ' (mean of gas bottles)' : '')) +
            _row('Z, field gravity', _fmt(r.zField, 4) + ' (' + (r.zFieldSrc === 'input' ? 'typed' : r.zFieldSrc) + ')') +
            _row('Z, laboratory gas', _fmt(r.zLab, 4) + ' (' + (r.zLabSrc === 'input' ? 'typed' : r.zLabSrc) + ')') +
            _row('Gravity factor ratio √(SG field / SG lab)', _fmt(r.fgrRatio, 5)) +
            _row('Supercompressibility ratio Fpv,lab / Fpv,field', _fmt(r.fpvRatio, 5)) +
            _row('Combined correction', _fmt(r.corr, 5) + ' (' + (r.gasCorrPct >= 0 ? '+' : '') + _fmt(r.gasCorrPct, 2) + ' %)') +
            _row('Field gas rate', Q(r.qGas)) +
            _row('Corrected gas rate', Q(r.qGasCorr)) +
            '</div>';
        // 2 — shrinkage and GOR
        var st = r.standing;
        h += '<div class="rbox"><div class="rbox-title">Shrinkage and GOR</div>' +
            (r.shrMethod === 'standing' ?
                _row('Solution GOR of separator oil (Standing)', _gor(st.Rs, 'st')) +
                _row('Bo of separator oil (Standing)', _fmt(st.Bo, 4)) : '') +
            _row('Shrinkage factor S (STB per separator bbl)', _fmt(r.S, 4) + (r.shrMethod === 'user' ? ' (typed)' : ' (Standing)')) +
            _row('Separator volume factor 1/S (separator bbl per STB)', _fmt(r.Bsep, 4)) +
            _row('Oil rate, separator conditions', L(r.qOilSep) + (r.oilBasis === 'sep' ? ' (entered)' : '')) +
            _row('Oil rate, stock tank', L(r.qOilST) + (r.oilBasis === 'st' ? ' (entered)' : '')) +
            _row('Field GOR, separator basis', _gor(r.gorSepField, 'sep')) +
            _row('Field GOR, stock-tank basis', _gor(r.gorSTField, 'st')) +
            _row('Corrected GOR, stock-tank basis', _gor(r.gorSTCorr, 'st')) +
            _row('Total producing GOR estimate (+ stock-tank gas)', _gor(r.gorTotal, 'st')) +
            '</div>';
        // 3 — recombination
        h += '<div class="rbox"><div class="rbox-title">Recombination GOR for the Laboratory</div>' +
            _row('Recombination GOR (separator gas / separator liquid)', _gor(r.gorSepCorr, 'sep')) +
            _row('Separator pressure', _u(r.psep, 'pressureG', 1, 'psig', 0)) +
            _row('Separator temperature', _u(r.tsep, 'temperature', 1, '°F')) +
            _ok('Recombine the separator gas and liquid samples at ' + _fmt(_metric() ? G.WTS_units.format(r.gorSepCorr, 'gor').value : r.gorSepCorr, _metric() ? 2 : 1) +
                ' ' + (_metric() ? 'sm³/m³' : 'scf/bbl') + ' of separator liquid at separator conditions.') +
            '</div>';
        // 4 — samples
        var ex = function (v) { return v == null || !_fin(v) ? '—' : _fmt(_dv(v, 'pressureG'), _metric() ? 0 : 1); };
        var pc = function (v) { return _fin(v) ? (v >= 0 ? '+' : '') + _fmt(v, 2) + ' %' : '—'; };
        var mark = { ok: '✓', warn: '⚠', bad: '✗' };
        var rows = r.bottles.map(function (b) {
            return [String(b.row), b.id ? _esc(b.id) : '—', b.kind === 'gas' ? 'Gas' : 'Oil',
                ex(b.pOpen), ex(b.pOpenExpG), pc(b.openDev), ex(b.psat), pc(b.satDev), _fin(b.sg) ? _fmt(b.sg, 3) : '—', mark[b.verdict]];
        });
        var pl = _lab('pressureG', 'psig');
        h += '<div class="rbox"><div class="rbox-title">Sample Validity</div>' +
            (rows.length ? _tbl(['#', 'Bottle', 'Type', 'Opening p (' + pl + ')', 'Expected (' + pl + ')', 'Deviation',
                'Saturation p (' + pl + ')', 'vs separator', 'Gas gravity', 'Verdict'], rows) : _warn('No sample bottles entered.')) +
            (r.dup.oil ? _row('Oil duplicates: saturation pressure spread', _fmt(r.dup.oil.pct, 2) + ' %') : '') +
            (r.dup.gas ? _row('Gas duplicates: gravity spread', _fmt(r.dup.gas.pct, 2) + ' %') : '') +
            r.checks.map(_v).join('') +
            (r.fails ? _bad(r.fails + ' check(s) failed: resample or reject the flagged bottles before recombination.') :
                r.warns ? _warn('No check failed; review the ' + r.warns + ' warning(s).') : _ok('All sample checks passed.')) +
            '</div>';
        h += '<div><b>Notes</b> API RP 44 practice. Gas rate: AGA-3 / API MPMS 14.3 flow is proportional to Fgr·Fpv, so ' +
            'q_corr = q_field·√(SG_field/SG_lab)·(Fpv,lab/Fpv,field) with Fpv = 1/√Z at separator conditions; the field Z uses ' +
            'the field gravity with no impurities, the laboratory Z the laboratory gravity and composition. The correction ' +
            'does not depend on the base conditions. Shrinkage S = 1/Bo of the separator oil (Standing 1947) unless typed ' +
            '(use the laboratory separator test when available). GOR per STB = GOR per separator bbl / S. The total GOR ' +
            'adds Standing Rs at separator conditions as the stock-tank flash gas and is an estimate. Opening pressure: oil ' +
            'bottles are compared with separator pressure (open at separator temperature); gas bottles with separator ' +
            'pressure scaled by absolute temperature (ideal gas, Z ratio neglected). Duplicate spread = (max − min)/mean. ' +
            'Tolerances are user choices; RP 44 gives no fixed values.</div>';
        return h;
    }

    function _readInputs() {
        var bottles = [];
        for (var k = 1; k <= NB; k++) {
            bottles.push({ id: _str('sq_bid' + k), kind: _str('sq_bk' + k), pOpen: _num('sq_bpo' + k), tOpen: _num('sq_bto' + k), psat: _num('sq_bps' + k), sg: _num('sq_bsg' + k) });
        }
        return {
            psep: _num('sq_psep'), tsep: _num('sq_tsep'), api: _num('sq_api'), sgField: _num('sq_sgf'), sgLab: _num('sq_sgl'),
            co2: _num('sq_co2'), h2s: _num('sq_h2s'), n2: _num('sq_n2'), zField: _num('sq_zf'), zLab: _num('sq_zl'),
            qGas: _num('sq_qg'), qOil: _num('sq_qo'), oilBasis: _str('sq_basis'), shrMethod: _str('sq_shrm'), shrUser: _num('sq_shr'),
            tolOpen: _num('sq_tolo'), tolSat: _num('sq_tols'), tolDup: _num('sq_told'), bottles: bottles
        };
    }

    function _calcImpl() {
        var root = _byId('sq_root'), res = _byId('sq_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var r = compute(_readInputs());
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.sepqc = { ok: false, errors: r.errors.slice(), ts: Date.now() };
            var items = '';
            for (var j = 0; j < r.errors.length; j++) items += '<li>' + (MSG[r.keys[j]] ? MSG[r.keys[j]]() : _esc(r.errors[j])) + '</li>';
            for (var b = 0; b < r.bad.length; b++) {
                var k = r.bad[b], m = /^b(\d+)$/.exec(k);
                var ids = m ? ['sq_bpo' + m[1], 'sq_bto' + m[1], 'sq_bps' + m[1], 'sq_bsg' + m[1]] : [IDS[k]];
                ids.forEach(function (id) { var el = _byId(id); if (el && el.classList && (!m || String(el.value).trim() !== '')) el.classList.add('input-err'); });
            }
            if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
            return r;
        }
        G.WTS_state.sepqc = {
            ok: true, S: r.S, Bsep: r.Bsep, zField: r.zField, zLab: r.zLab, corr: r.corr, qGasCorr: r.qGasCorr,
            qOilSep: r.qOilSep, qOilST: r.qOilST, gorSepField: r.gorSepField, gorSTField: r.gorSTField,
            gorSepCorr: r.gorSepCorr, gorSTCorr: r.gorSTCorr, gorTotal: r.gorTotal,
            fails: r.fails, warns: r.warns, ts: Date.now()
        };
        if (res) { res.innerHTML = _resultsHtml(r); res.setAttribute('data-done', '1'); }
        return r;
    }
    G.calcSepQC = function () { return _canon(_calcImpl); };

    function _pageHtml() {
        var h = '<div id="sq_root"><div class="cols-2"><div style="min-width:0">';
        h += '<div class="card"><div class="card-title">Separator and Rates</div><div class="fg">' +
            _fg('sq_psep', 'Separator pressure (psig)', '500') +
            _fg('sq_tsep', 'Separator temperature (°F)', '100') +
            _fg('sq_api', 'Stock-tank oil gravity (°API)', '40') +
            _fg('sq_qg', 'Field gas rate (MSCFD)', '5000', ' min="0"') +
            _fg('sq_qo', 'Oil rate (BPD)', '2000', ' min="0"') +
            '<div class="fg-item"><label for="sq_basis">Oil rate basis</label>' +
            _selHtml('sq_basis', [['sep', 'Separator conditions (metered)'], ['st', 'Stock tank']], 'sep') + '</div>' +
            '</div></div>';
        h += '<div class="card"><div class="card-title">Gas Gravity and Z</div><div class="fg">' +
            _fg('sq_sgf', 'Field gas gravity used by the meter (air = 1)', '0.70') +
            _fg('sq_sgl', 'Laboratory gas gravity (blank = mean of gas bottles)', '', ' placeholder="blank = bottles"') +
            _fg('sq_co2', 'Laboratory CO2 (mol %)', '2') +
            _fg('sq_h2s', 'Laboratory H2S (mol %)', '0') +
            _fg('sq_n2', 'Laboratory N2 (mol %)', '0.5') +
            _fg('sq_zf', 'Field Z-factor (blank = calculate)', '', ' placeholder="blank = calculate"') +
            _fg('sq_zl', 'Laboratory Z-factor (blank = calculate)', '', ' placeholder="blank = calculate"') +
            '</div></div>';
        h += '<div class="card"><div class="card-title">Shrinkage and Tolerances</div><div class="fg">' +
            '<div class="fg-item"><label for="sq_shrm">Shrinkage source</label>' +
            _selHtml('sq_shrm', [['standing', 'Standing Bo at separator conditions'], ['user', 'Typed value (laboratory / meter)']], 'standing') + '</div>' +
            _fg('sq_shr', 'Shrinkage factor, typed (STB per separator bbl)', '0.90') +
            _fg('sq_tolo', 'Opening-pressure tolerance (%)', '5') +
            _fg('sq_tols', 'Saturation-pressure tolerance (%)', '5') +
            _fg('sq_told', 'Duplicate-agreement tolerance (%)', '2') +
            '</div></div>';
        // Sample table
        var pl = 'psig', tl = '°F';
        h += '<div class="card"><div class="card-title">Sample Bottles</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="sq_bottles"><thead><tr><th>#</th><th>Bottle ID</th><th>Type</th>' +
            '<th data-wts-unit-label="pressureG">Opening p (' + pl + ')</th>' +
            '<th data-wts-unit-label="temperature">Opening T (' + tl + ')</th>' +
            '<th data-wts-unit-label="pressureG">Lab saturation p at sep. T (' + pl + ')</th>' +
            '<th>Lab gas gravity</th></tr></thead><tbody>';
        for (var k = 1; k <= NB; k++) {
            var d = DEF_B[k - 1] || ['', k <= 2 ? 'oil' : 'gas', '', '', '', ''];
            var cell = function (id, val, aria) {
                return '<td><input type="number" step="any" id="' + id + '" value="' + val + '" aria-label="' + aria + '" style="width:100%;min-width:64px"></td>';
            };
            h += '<tr><td>' + k + '</td>' +
                '<td><input type="text" id="sq_bid' + k + '" value="' + d[0] + '" aria-label="Bottle ' + k + ' ID" maxlength="40" style="width:100%;min-width:64px"></td>' +
                '<td>' + _selHtml('sq_bk' + k, [['oil', 'Oil'], ['gas', 'Gas']], d[1], 'Bottle ' + k + ' type') + '</td>' +
                cell('sq_bpo' + k, d[2], 'Bottle ' + k + ' opening pressure') +
                cell('sq_bto' + k, d[3], 'Bottle ' + k + ' opening temperature') +
                cell('sq_bps' + k, d[4], 'Bottle ' + k + ' saturation pressure') +
                cell('sq_bsg' + k, d[5], 'Bottle ' + k + ' gas gravity') + '</tr>';
        }
        h += '</tbody></table></div>' +
            '<div class="info-bar" style="margin-top:12px">A row is used when it has an opening pressure, a saturation pressure or a gas gravity. ' +
            'Oil bottles: opening and saturation pressures at separator temperature. Gas bottles: opening pressure at the stated temperature.</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="sq_calc" onclick="calcSepQC()">Calculate</button></div></div>';
        h += '</div><div style="min-width:0"><div id="sq_res"></div></div></div></div>';
        return h;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('sq_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^sq_/.test(e.target.id || '')) G.calcSepQC();
            });
        }
        G.calcSepQC();
    }
    G.renderSepQC = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.sepqc = {
        key: 'sepqc',
        title: TITLE,
        navTitle: 'Sampling & GOR QC',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9878;',
        badge: 'Sampling',
        bc: 'dc-b-blue',
        desc: 'Separator and stock-tank GOR through shrinkage, gas rate with laboratory gravity and Z, recombination GOR and bottle checks (API RP 44).',
        render: function (body) { return G.renderSepQC(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('sq_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcSepQC();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var F = G.WTS_sepqc_compute;
    if (typeof F !== 'function') return;
    var fails = [], n = 0;
    function rel(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol * Math.abs(b))) fails.push(what + ': got ' + a + ', want ' + b); }
    // Standing shrinkage, host Shrinkage-tab defaults (710 psig, 121 °F, 0.751, 52 °API)
    var s = G.WTS_sepqc_standing(710, 121, 52, 0.751);
    rel(s.S, 1 / s.Bo, 1e-12, 'S = 1/Bo');
    // Typed Z and shrinkage: correction = √(0.70/0.80)·√(0.90/0.85)
    var r = F({ psep: 500, tsep: 100, api: 40, sgField: 0.7, sgLab: 0.8, zField: 0.90, zLab: 0.85, qGas: 1000, qOil: 500, oilBasis: 'sep', shrMethod: 'user', shrUser: 0.8 });
    rel(r.corr, Math.sqrt(0.7 / 0.8) * Math.sqrt(0.9 / 0.85), 1e-12, 'correction');
    rel(r.gorSepCorr, 2000 * r.corr, 1e-12, 'recombination GOR');
    rel(r.gorSTCorr, 2000 * r.corr / 0.8, 1e-12, 'stock-tank GOR');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[sepqc self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined' && typeof window === 'undefined') console.log('[sepqc self-test] ' + n + '/' + n + ' checks passed');
})();
