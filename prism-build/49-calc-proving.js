// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Meter Proving & Net Standard Volume (proving)
//
// PURPOSE (docs/ROADMAP.md §1.2 #13, with #18 folded in)
//   • Meter factor from pipe-prover runs (API MPMS Ch. 4.8 / 12.2.3):
//       MF = GSVp / ISVm = (BPV·CTSp·CPSp·CTLp·CPLp) / (IVm·CTLm·CPLm)
//     average-data method for the final MF (run averages of IV, T and P), plus
//     each run's intermediate MF and the average-meter-factor method;
//     repeatability = (max − min)/min of the run meter factors against the
//     MPMS 4.8 Table A-1 limits for ±0.027 % MF uncertainty
//     (3 runs 0.02 %, 4 0.03 %, 5 0.05 %, 6 0.06 %, 7 0.08 %, 8 0.09 %, 9 0.10 %, 10 0.12 %).
//   • CTL from API MPMS 11.1 (1980) / ASTM D1250 Tables 6A–6D, closed form:
//       α60 = K0/ρ60² + K1/ρ60   (transition zone: α60 = A + B/ρ60²)
//       CTL = exp[−α60·Δt·(1 + 0.8·α60·Δt)],  Δt = t − 60 °F
//     crude oils K0 = 341.0957, K1 = 0 (the host Fluid Properties / Oil & Gas
//     Rate pages use the same equation); refined-product groups are offered.
//     Observed API at the hydrometer temperature → API @ 60 °F by the Table 5
//     iteration with the glass-hydrometer correction 1 − 1.278e-5·Δt − 6.2e-9·Δt².
//   • CPL from API MPMS 11.2.1 (1984) / 11.1-2004 compressibility:
//       F = exp(−1.9947 + 0.00013427·t + (793920 + 2326·t)/ρ60²) × 10⁻⁵  [1/psi]
//       CPL = 1 / [1 − F·(P − Pe)],  P and Pe gauge (Pe below 0 psig taken as 0)
//   • Prover steel: CTSp = 1 + (Tp − 60)·Gc, CPSp = 1 + Pp·ID/(E·wt)
//     (API MPMS 12.2.3 / 12.2 Part 1 steel constants).
//   • Measurement ticket (API MPMS 12.2.2): IV → CCF = CTL·CPL·MF → GSV = IV·CCF
//     → CSW = 1 − S&W/100 → NSV = GSV·CSW, with an audit-trail table.
//     Optional MPMS 12.2 discrimination levels: ticket CTL, CPL, CCF, CSW to
//     4 decimals and volumes to 0.01 bbl; proving factors to 5 decimals and the
//     meter factor to 4 decimals.
//   • #18 Oil & gas BS&W / shrinkage audit trail: reproduces the Oil & Gas
//     Rate page's net-oil chain one factor at a time:
//       rate = (m1 − m0)·MF·VCF(Table 6A)·(1 − BS&W)·shrinkage·1440/interval
//
// PUBLIC API (window.*)
//   renderProving(body), calcProving(), copyOilGasToProving()
//   WTS_proving_compute(input)          → {ok, liquid, prove, ticket, audit, errors[]}
//   WTS_proving_ctl(api60, tF, group)   → CTL (unrounded)
//   WTS_proving_fp(api60, tF)           → F (1/psi)
//   WTS_proving_api60(apiObs, tF, group)→ {api60, rho60, ctl}
//   WTS_proving_ticketChain({iv, ctl, cpl, mf, sw, round}) → audit rows
// STATE
//   WTS_state.proving = {ok, mf, mfAvgMethod, rangePct, repeatOk, gsv, nsv, auditRate, ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var RHO_W = 999.012;   // kg/m³, water at 60 °F (MPMS 11.1-1980)
    var NR = 10;           // prover-run rows

    // API MPMS 11.1 (1980) commodity groups, ρ60 in kg/m³.
    var GROUPS = {
        crude:    { name: 'Crude oil (Table 6A)', K0: 341.0957, K1: 0, lo: 610.5, hi: 1075.0 },
        gasoline: { name: 'Gasolines (Table 6B)', K0: 192.4571, K1: 0.2438, lo: 653.0, hi: 770.5 },
        trans:    { name: 'Transition zone (Table 6B)', A: -0.00186840, B: 1489.0670, lo: 770.5, hi: 788.0 },
        jet:      { name: 'Jet fuels (Table 6B)', K0: 330.3010, K1: 0, lo: 788.0, hi: 839.0 },
        fuel:     { name: 'Fuel oils (Table 6B)', K0: 103.8720, K1: 0.2701, lo: 839.0, hi: 1075.0 },
        lube:     { name: 'Lubricating oils (Table 6D)', K0: 0, K1: 0.34878, lo: 800.9, hi: 1163.5 }
    };
    // Prover steel: cubical expansion Gc (1/°F) and modulus E (psi) — API MPMS 12.2.
    var STEELS = {
        cs:    { name: 'Carbon steel', Gc: 1.86e-5, E: 3.0e7 },
        ss304: { name: 'Stainless 304', Gc: 2.88e-5, E: 2.8e7 },
        ss316: { name: 'Stainless 316', Gc: 2.65e-5, E: 2.8e7 },
        ph17:  { name: 'Stainless 17-4PH', Gc: 1.20e-5, E: 2.85e7 }
    };
    // MPMS 4.8 Table A-1: range limit (%) for ±0.027 % MF uncertainty by number of runs.
    var REPEAT = { 3: 0.02, 4: 0.03, 5: 0.05, 6: 0.06, 7: 0.08, 8: 0.09, 9: 0.10, 10: 0.12 };

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _chk(id) { var e = _byId(id); return !!(e && e.checked); }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x === '' || x == null || (typeof x === 'number' && isNaN(x)); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _fx(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d); }
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
    // MPMS 12.2 rounding: round half away from zero at the stated decimal.
    function _rnd(x, dp) { var f = Math.pow(10, dp); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * f + 0.5 + 1e-9) / f; }

    // ── Pure compute ─────────────────────────────────────────────────
    function _grp(g) { return GROUPS[g] || GROUPS.crude; }
    function rho60Of(api60) { return 141.5 * RHO_W / (api60 + 131.5); }
    function alpha60(rho, group) {
        var c = _grp(group);
        return c.A != null ? c.A + c.B / (rho * rho) : c.K0 / (rho * rho) + c.K1 / rho;
    }
    function ctlRho(rho, tF, group) {
        var a = alpha60(rho, group), dt = tF - 60;
        return Math.exp(-a * dt * (1 + 0.8 * a * dt));
    }
    function ctl(api60, tF, group) { return ctlRho(rho60Of(api60), tF, group); }
    // Table 5 style: observed hydrometer API at tF → API @ 60 °F (iterative, glass-hydrometer correction).
    function api60(apiObs, tF, group) {
        var dt = tF - 60;
        var rhoObs = 141.5 * RHO_W / (apiObs + 131.5) * (1 - 1.278e-5 * dt - 6.2e-9 * dt * dt);
        var rho = rhoObs, c = 1;
        for (var i = 0; i < 50; i++) {
            c = ctlRho(rho, tF, group);
            var nx = rhoObs / c;
            if (Math.abs(nx - rho) < 1e-9) { rho = nx; break; }
            rho = nx;
        }
        return { api60: 141.5 * RHO_W / rho - 131.5, rho60: rho, ctl: c };
    }
    // MPMS 11.2.1 compressibility factor, 1/psi.
    function fpRho(rho, tF) { return 1e-5 * Math.exp(-1.9947 + 0.00013427 * tF + (793920 + 2326 * tF) / (rho * rho)); }
    function fp(api60v, tF) { return fpRho(rho60Of(api60v), tF); }
    function cplOf(F, pPsig, pe) {
        var d = pPsig - Math.max(pe || 0, 0);
        return d > 0 ? 1 / (1 - F * d) : 1;
    }

    // MPMS 12.2.2 ticket chain from the factors.
    function ticketChain(t) {
        var R = t.round !== false;
        var iv = R ? _rnd(t.iv, 2) : t.iv;
        var CTL = R ? _rnd(t.ctl, 4) : t.ctl, CPL = R ? _rnd(t.cpl, 4) : t.cpl, MF = R ? _rnd(t.mf, 4) : t.mf;
        var CCF = CTL * CPL * MF; if (R) CCF = _rnd(CCF, 4);
        var gsv = iv * CCF; if (R) gsv = _rnd(gsv, 2);
        var csw = 1 - (t.sw || 0) / 100; if (R) csw = _rnd(csw, 4);
        var nsv = gsv * csw; if (R) nsv = _rnd(nsv, 2);
        return { iv: iv, ctl: CTL, cpl: CPL, mf: MF, ccf: CCF, gsv: gsv, csw: csw, nsv: nsv, swv: R ? _rnd(gsv - nsv, 2) : gsv - nsv, round: R };
    }

    function _proveFactors(o, liq, steel, R) {
        // o = {iv, tp, pp, tm, pm}
        var r5 = function (x) { return R ? _rnd(x, 5) : x; };
        var ctsp = r5(1 + (o.tp - 60) * steel.Gc);
        var cpsp = r5(1 + o.pp * liq.proverId / (steel.E * liq.wall));
        var ctlp = r5(ctlRho(liq.rho60, o.tp, liq.group));
        var cplp = r5(cplOf(fpRho(liq.rho60, o.tp), o.pp, liq.pe));
        var ctlm = r5(ctlRho(liq.rho60, o.tm, liq.group));
        var cplm = r5(cplOf(fpRho(liq.rho60, o.tm), o.pm, liq.pe));
        var ccfp = r5(ctsp * cpsp * ctlp * cplp);
        var ccfm = r5(ctlm * cplm);
        var gsvp = liq.bpv * ccfp, isvm = o.iv * ccfm;
        return { ctsp: ctsp, cpsp: cpsp, ctlp: ctlp, cplp: cplp, ccfp: ccfp, ctlm: ctlm, cplm: cplm, ccfm: ccfm, gsvp: gsvp, isvm: isvm, mf: gsvp / isvm };
    }

    function compute(input) {
        var i = input || {};
        var n = function (x) { return _blank(x) ? NaN : Number(x); };
        var R = i.round !== false;
        var errors = [], bad = [], keys = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        // Liquid
        var group = GROUPS[i.group] ? i.group : 'crude';
        var apiObs = n(i.apiObs), tHyd = n(i.tHyd), pe = _blank(i.pe) ? 0 : Number(i.pe);
        if (!(_fin(apiObs) && apiObs >= 0 && apiObs <= 100)) err('apiObs', 'Observed gravity must be between 0 and 100 °API.');
        if (!(_fin(tHyd) && tHyd >= 0 && tHyd <= 300)) err('tHyd', 'Hydrometer temperature must be between 0 and 300 °F.');
        if (!(_fin(pe) && pe >= -14.696 && pe <= 1000)) err('pe', 'Equilibrium vapour pressure must be between -14.7 and 1,000 psig.');
        // Prover
        var steel = STEELS[i.steel] || STEELS.cs;
        var bpv = n(i.bpv), pid = n(i.proverId), wall = n(i.wall);
        if (!(_fin(bpv) && bpv > 0 && bpv <= 10000)) err('bpv', 'Prover base volume must be above 0 and no more than 10,000 bbl.');
        if (!(_fin(pid) && pid > 0 && pid <= 60)) err('proverId', 'Prover inside diameter must be above 0 and no more than 60 in.');
        if (!(_fin(wall) && wall > 0 && wall < pid / 2)) err('wall', 'Prover wall thickness must be above 0 and less than half the inside diameter.');
        var liqErr = errors.length > 0;
        var liq = null;
        if (!liqErr) {
            var a = api60(apiObs, tHyd, group);
            liq = { group: group, apiObs: apiObs, tHyd: tHyd, api60: a.api60, rho60: a.rho60, ctlHyd: a.ctl, pe: pe,
                bpv: bpv, proverId: pid, wall: wall, steel: steel, warnings: [] };
            var gr = _grp(group);
            if (liq.rho60 < gr.lo || liq.rho60 > gr.hi) liq.warnings.push('Density at 60 °F (' + _fmt(liq.rho60, 1) + ' kg/m³) is outside the ' + gr.name + ' range ' + _fmt(gr.lo, 1) + '–' + _fmt(gr.hi, 1) + ' kg/m³.');
        }

        // Prover runs
        var runs = [];
        (Array.isArray(i.runs) ? i.runs : []).forEach(function (r, k) {
            if (!r) return;
            var iv = n(r.iv), tp = n(r.tp), pp = n(r.pp), tm = n(r.tm), pm = n(r.pm);
            if (!_fin(iv)) return;
            var row = k + 1;
            if (!(iv > 0)) err('run' + row, 'Run ' + row + ': meter volume must be greater than zero.');
            else if (!(_fin(tp) && _fin(tm) && tp >= -40 && tp <= 300 && tm >= -40 && tm <= 300)) err('run' + row, 'Run ' + row + ': prover and meter temperatures must be between -40 and 300 °F.');
            else if (!(_fin(pp) && _fin(pm) && pp >= 0 && pm >= 0 && pp <= 3000 && pm <= 3000)) err('run' + row, 'Run ' + row + ': prover and meter pressures must be between 0 and 3,000 psig.');
            else runs.push({ row: row, iv: iv, tp: tp, pp: pp, tm: tm, pm: pm });
        });
        var prevMf = n(i.prevMf), mfTol = _blank(i.mfTol) ? 0.25 : Number(i.mfTol);
        if (!_blank(i.prevMf) && !(_fin(prevMf) && prevMf > 0.5 && prevMf < 1.5)) err('prevMf', 'Previous meter factor must be between 0.5 and 1.5, or blank.');
        if (!(_fin(mfTol) && mfTol > 0 && mfTol <= 10)) err('mfTol', 'Meter-factor change limit must be between 0 and 10 %.');

        var prove = null;
        if (liq && !errors.length) {
            if (runs.length < 3) {
                prove = { ok: false, reason: 'At least three prover runs with a meter volume are needed (MPMS 4.8); ' + runs.length + ' entered.' };
            } else {
                runs.forEach(function (r) { r.f = _proveFactors(r, liq, steel, R); r.mfRun = R ? _rnd(r.f.mf, 4) : r.f.mf; r.mfRaw = r.f.mf; });
                var mean = function (k) { return runs.reduce(function (s, r) { return s + r[k]; }, 0) / runs.length; };
                var avg = { iv: mean('iv'), tp: mean('tp'), pp: mean('pp'), tm: mean('tm'), pm: mean('pm') };
                if (R) { avg.tp = _rnd(avg.tp, 1); avg.tm = _rnd(avg.tm, 1); avg.pp = _rnd(avg.pp, 0); avg.pm = _rnd(avg.pm, 0); avg.iv = _rnd(avg.iv, 4); }
                var fa = _proveFactors(avg, liq, steel, R);
                var mf = R ? _rnd(fa.mf, 4) : fa.mf;
                var mfs = runs.map(function (r) { return r.mfRaw; });
                var mx = Math.max.apply(null, mfs), mn = Math.min.apply(null, mfs);
                var rangePct = 100 * (mx - mn) / mn;
                var ivs = runs.map(function (r) { return r.iv; });
                var ivRangePct = 100 * (Math.max.apply(null, ivs) - Math.min.apply(null, ivs)) / Math.min.apply(null, ivs);
                var lim = REPEAT[runs.length];
                var mfAvgMethod = mfs.reduce(function (s, v) { return s + v; }, 0) / mfs.length;
                if (R) mfAvgMethod = _rnd(mfAvgMethod, 4);
                prove = {
                    ok: true, runs: runs, avg: avg, factors: fa, mf: mf, mfRaw: fa.mf, mfAvgMethod: mfAvgMethod,
                    rangePct: rangePct, ivRangePct: ivRangePct, limitPct: lim, repeatOk: rangePct <= lim + 1e-12,
                    prevMf: _fin(prevMf) ? prevMf : null, mfTol: mfTol,
                    mfChangePct: _fin(prevMf) ? 100 * (mf - prevMf) / prevMf : null
                };
            }
        }

        // Ticket
        var t = i.ticket || {};
        var ticket = null;
        var tO = n(t.open), tC = n(t.close), tT = n(t.tm), tP = n(t.pm), tSW = n(t.sw), tMF = n(t.mf);
        if (!(_fin(tO) && _fin(tC) && tC > tO)) err('tclose', 'Ticket: closing meter reading must be above the opening reading.');
        if (!(_fin(tT) && tT >= -40 && tT <= 300)) err('ttm', 'Ticket: meter temperature must be between -40 and 300 °F.');
        if (!(_fin(tP) && tP >= 0 && tP <= 3000)) err('tpm', 'Ticket: meter pressure must be between 0 and 3,000 psig.');
        if (!(_fin(tSW) && tSW >= 0 && tSW < 100)) err('tsw', 'Ticket: S&W must be between 0 and 100 %.');
        if (!_blank(t.mf) && !(_fin(tMF) && tMF > 0.5 && tMF < 1.5)) err('tmf', 'Ticket: meter factor must be between 0.5 and 1.5, or blank to use the proven factor.');
        if (liq && !errors.length) {
            var mfT = _fin(tMF) ? tMF : (prove && prove.ok ? prove.mf : NaN);
            if (!_fin(mfT)) ticket = { ok: false, reason: 'No meter factor: prove the meter (three or more runs) or type the factor.' };
            else {
                var cTL = ctlRho(liq.rho60, tT, group), F = fpRho(liq.rho60, tT), cPL = cplOf(F, tP, liq.pe);
                var ch = ticketChain({ iv: tC - tO, ctl: cTL, cpl: cPL, mf: mfT, sw: tSW, round: R });
                ch.ok = true; ch.mfSrc = _fin(tMF) ? 'typed' : 'proven'; ch.ctlRaw = cTL; ch.cplRaw = cPL; ch.F = F; ch.tm = tT; ch.pm = tP; ch.sw = tSW;
                ticket = ch;
            }
        }

        // #18 audit trail (the Oil & Gas Rate page's net-oil chain; crude Table 5A/6A as that page)
        var au = i.audit || {};
        var audit = null;
        var aInt = n(au.interval), aApi = n(au.apiObs), aHt = n(au.tHyd), aM0 = n(au.m0), aM1 = n(au.m1), aT = n(au.tLine),
            aBsw = n(au.bsw), aMf = n(au.mf), aShr = n(au.shr), aP = n(au.pLine), aGas = n(au.gas);
        if (!(_fin(aInt) && aInt > 0)) err('aint', 'Audit trail: interval must be greater than zero.');
        if (!(_fin(aApi) && aApi > 0 && aApi <= 100)) err('aapi', 'Audit trail: API gravity must be above 0 and no more than 100.');
        if (!(_fin(aHt) && _fin(aT))) err('aht', 'Audit trail: enter the hydrometer and oil line temperatures.');
        if (!(_fin(aM0) && _fin(aM1) && aM1 >= aM0)) err('am1', 'Audit trail: current meter reading must not be below the previous reading.');
        if (!(_fin(aBsw) && aBsw >= 0 && aBsw <= 100)) err('absw', 'Audit trail: BS&W must be between 0 and 100 %.');
        if (!_blank(au.mf) && !(_fin(aMf) && aMf > 0)) err('amf', 'Audit trail: meter factor must be greater than zero, or blank to use the proven factor.');
        if (!(_fin(aShr) && aShr > 0)) err('ashr', 'Audit trail: shrinkage factor must be greater than zero.');
        if (!_blank(au.pLine) && !(_fin(aP) && aP >= 0 && aP <= 3000)) err('ap', 'Audit trail: oil line pressure must be between 0 and 3,000 psig, or blank.');
        if (!_blank(au.gas) && !(_fin(aGas) && aGas >= 0)) err('agas', 'Audit trail: gas rate must be 0 or more, or blank.');
        if (!errors.length) {
            var mfA = _fin(aMf) ? aMf : (prove && prove.ok ? prove.mf : NaN);
            if (!_fin(mfA)) audit = { ok: false, reason: 'No meter factor for the audit trail: prove the meter or type the factor.' };
            else {
                var h5 = api60(aApi, aHt, 'crude');
                var vcf = ctl(h5.api60, aT, 'crude');
                var iv = aM1 - aM0, gross = iv * mfA, gsvA = gross * vcf, nsvA = gsvA * (1 - aBsw / 100), sto = nsvA * aShr;
                var perDay = 1440 / aInt, rate = sto * perDay;
                var cplA = _fin(aP) ? cplOf(fp(h5.api60, aT), aP, 0) : null;
                audit = {
                    ok: true, mf: mfA, mfSrc: _fin(aMf) ? 'typed' : 'proven', api60: h5.api60, vcf: vcf, iv: iv, gross: gross, gsv: gsvA,
                    csw: 1 - aBsw / 100, nsv: nsvA, shr: aShr, sto: sto, perDay: perDay, rate: rate, bsw: aBsw, interval: aInt,
                    cpl: cplA, rateCpl: cplA != null ? rate * cplA : null, pLine: _fin(aP) ? aP : null,
                    gas: _fin(aGas) ? aGas : null, gor: (_fin(aGas) && rate > 0) ? 1000 * aGas / rate : null, tLine: aT, tHyd: aHt, apiObs: aApi
                };
            }
        }

        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };
        return { ok: true, round: R, liquid: liq, prove: prove, ticket: ticket, audit: audit };
    }

    G.WTS_proving_compute = compute;
    G.WTS_proving_ctl = ctl;
    G.WTS_proving_fp = fp;
    G.WTS_proving_api60 = api60;
    G.WTS_proving_ticketChain = ticketChain;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Meter Proving & Net Standard Volume';
    var SUB = 'Meter factor from prover runs with repeatability, CTL/CPL (API MPMS 11.1), S&W and net standard volume (API MPMS 12.2), with a net-oil audit trail';
    var UNITS = {
        pv_bpv: 'volume', pv_pid: 'lengthSmall', pv_wall: 'lengthSmall', pv_api: 'api', pv_th: 'temperature', pv_pe: 'pressureG',
        pv_mft: 'percent',
        pv_to: 'volume', pv_tc: 'volume', pv_ttm: 'temperature', pv_tpm: 'pressureG', pv_tsw: 'percent',
        pv_aint: 'timeMin', pv_aapi: 'api', pv_aht: 'temperature', pv_am0: 'volume', pv_am1: 'volume', pv_at: 'temperature',
        pv_absw: 'percent', pv_ap: 'pressureG', pv_agas: 'gasRateSmall'
    };
    for (var ri = 1; ri <= NR; ri++) { UNITS['pv_iv' + ri] = 'volume'; UNITS['pv_tp' + ri] = 'temperature'; UNITS['pv_pp' + ri] = 'pressureG'; UNITS['pv_tm' + ri] = 'temperature'; UNITS['pv_pm' + ri] = 'pressureG'; }
    var IDS = {
        apiObs: 'pv_api', tHyd: 'pv_th', pe: 'pv_pe', bpv: 'pv_bpv', proverId: 'pv_pid', wall: 'pv_wall', prevMf: 'pv_prev', mfTol: 'pv_mft',
        tclose: 'pv_tc', ttm: 'pv_ttm', tpm: 'pv_tpm', tsw: 'pv_tsw', tmf: 'pv_tmf',
        aint: 'pv_aint', aapi: 'pv_aapi', aht: 'pv_aht', am1: 'pv_am1', absw: 'pv_absw', amf: 'pv_amf', ashr: 'pv_ashr', ap: 'pv_ap', agas: 'pv_agas'
    };
    // [iv, tp, pp, tm, pm]
    var DEF_RUNS = [
        ['49.950', '78.2', '95', '78.0', '100'],
        ['49.960', '78.2', '95', '78.0', '100'],
        ['49.950', '78.3', '95', '78.1', '100'],
        ['49.970', '78.3', '95', '78.1', '100'],
        ['49.960', '78.2', '95', '78.0', '100']
    ];
    // Oil & Gas Rate page ids → this page's audit-trail ids.
    var OG_MAP = { og_int: 'pv_aint', og_api: 'pv_aapi', og_ht: 'pv_aht', og_m0: 'pv_am0', og_m1: 'pv_am1', og_olt: 'pv_at', og_bsw: 'pv_absw', og_mf: 'pv_amf', og_sf: 'pv_ashr' };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) { h += '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; });
        return h + '</select></div>';
    }
    // v3.1: Metric mode shows the coefficients per °C / per kPa and the standard basis in SI first.
    // α per °C = α per °F × 1.8; F per kPa = F per psi ÷ 6.894757.
    function _alphaTxt(aF) { return _metric() ? (aF * 1.8 * 1e6).toFixed(3) + ' ×10⁻⁶ /°C (' + (aF * 1e6).toFixed(3) + ' ×10⁻⁶ /°F)' : (aF * 1e6).toFixed(3) + ' ×10⁻⁶ /°F'; }
    function _fTxt(fPsi) { return _metric() ? (fPsi / 6.894757 * 1e6).toFixed(4) + ' ×10⁻⁶ /kPa (' + (fPsi * 1e6).toFixed(3) + ' ×10⁻⁶ /psi)' : (fPsi * 1e6).toFixed(3) + ' ×10⁻⁶ /psi'; }
    function _stdTxt() { return _metric() ? '15.56 °C (60 °F), 0 kPa(g)' : '60 °F, 0 psig'; }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }

    function _resultsHtml(r) {
        var h = '', L = r.liquid, R = r.round;
        var V = function (v, d) { return _u(v, 'volume', d == null ? 2 : d, 'bbl', 3); };
        var T = function (v) { return _u(v, 'temperature', 1, '°F'); };
        var P = function (v) { return _u(v, 'pressureG', 0, 'psig'); };
        var f5 = R ? 5 : 6, f4 = R ? 4 : 6;
        // Liquid
        h += '<div class="rbox"><div class="rbox-title">Liquid Properties</div>' +
            _row('Commodity group', GROUPS[L.group].name) +
            _row('API @ 60 °F', _fx(L.api60, 2)) +
            _row('Density @ 60 °F', _fmt(L.rho60, 1) + ' kg/m³') +
            _row('Thermal expansion α60', _alphaTxt(alpha60(L.rho60, L.group))) +
            _row('Compressibility F at ' + (_metric() ? '15.56 °C (60 °F)' : '60 °F'), _fTxt(fpRho(L.rho60, 60))) +
            L.warnings.map(_warn).join('') + '</div>';
        // Proving
        var pv = r.prove;
        if (pv && pv.ok) {
            var runRows = pv.runs.map(function (x) {
                return [String(x.row), _fx(_dv(x.iv, 'volume'), _metric() ? 4 : 3), _fx(_dv(x.tp, 'temperature'), 1), _fx(_dv(x.pp, 'pressureG'), 0),
                    _fx(x.f.ctsp, f5), _fx(x.f.cpsp, f5), _fx(x.f.ctlp, f5), _fx(x.f.cplp, f5), _fx(x.f.ccfp, f5),
                    _fx(_dv(x.tm, 'temperature'), 1), _fx(_dv(x.pm, 'pressureG'), 0), _fx(x.f.ctlm, f5), _fx(x.f.cplm, f5), _fx(x.mfRaw, 5)];
            });
            var tl = _lab('temperature', '°F'), pl = _lab('pressureG', 'psig'), vl = _lab('volume', 'bbl');
            var fa = pv.factors;
            var rv = pv.repeatOk ? _ok('Repeatability ' + _fx(pv.rangePct, 4) + ' % over ' + pv.runs.length + ' runs is within the ' + _fx(pv.limitPct, 2) + ' % limit (MPMS 4.8, ±0.027 %).')
                : _bad('Repeatability ' + _fx(pv.rangePct, 4) + ' % over ' + pv.runs.length + ' runs exceeds the ' + _fx(pv.limitPct, 2) + ' % limit: do more runs or find the cause.');
            var mv = '';
            if (pv.prevMf != null) {
                mv = Math.abs(pv.mfChangePct) <= pv.mfTol ? _ok('Meter factor changed ' + _fx(pv.mfChangePct, 3) + ' % from the previous proving (limit ' + _fx(pv.mfTol, 2) + ' %).')
                    : _warn('Meter factor changed ' + _fx(pv.mfChangePct, 3) + ' % from the previous proving (limit ' + _fx(pv.mfTol, 2) + ' %): check the meter.');
            }
            h += '<div class="rbox"><div class="rbox-title">Meter Proving</div>' +
                _tbl(['Run', 'IVm (' + vl + ')', 'Tp (' + tl + ')', 'Pp (' + pl + ')', 'CTSp', 'CPSp', 'CTLp', 'CPLp', 'CCFp',
                    'Tm (' + tl + ')', 'Pm (' + pl + ')', 'CTLm', 'CPLm', 'Run MF'], runRows) +
                _row('Prover base volume', V(L.bpv, 4)) +
                _row('Average IVm', V(pv.avg.iv, 4)) +
                _row('Average Tp / Tm', T(pv.avg.tp) + ' / ' + T(pv.avg.tm)) +
                _row('Average Pp / Pm', P(pv.avg.pp) + ' / ' + P(pv.avg.pm)) +
                _row('CTSp · CPSp', _fx(fa.ctsp, f5) + ' · ' + _fx(fa.cpsp, f5)) +
                _row('CTLp · CPLp', _fx(fa.ctlp, f5) + ' · ' + _fx(fa.cplp, f5)) +
                _row('CCFp', _fx(fa.ccfp, f5)) +
                _row('CTLm · CPLm = CCFm', _fx(fa.ctlm, f5) + ' · ' + _fx(fa.cplm, f5) + ' = ' + _fx(fa.ccfm, f5)) +
                _row('GSVp (prover at ' + _stdTxt() + ')', V(fa.gsvp, 4)) +
                _row('ISVm (meter at ' + _stdTxt() + ')', V(fa.isvm, 4)) +
                _row('Meter factor (average data method)', _fx(pv.mf, f4)) +
                _row('Meter factor (average meter factor method)', _fx(pv.mfAvgMethod, f4)) +
                _row('Repeatability, run meter factors', _fx(pv.rangePct, 4) + ' %') +
                _row('Range of meter volumes', _fx(pv.ivRangePct, 4) + ' %') +
                _row('Repeatability limit for ' + pv.runs.length + ' runs', _fx(pv.limitPct, 2) + ' %') +
                rv + mv + '</div>';
        } else if (pv) {
            h += '<div class="rbox"><div class="rbox-title">Meter Proving</div>' + _bad(pv.reason) + '</div>';
        }
        // Ticket
        var tk = r.ticket;
        if (tk && tk.ok) {
            h += '<div class="rbox"><div class="rbox-title">Net Standard Volume</div>' +
                _tbl(['Step', 'Factor / volume', 'Value'], [
                    ['1', 'Indicated volume IV = closing − opening', V(tk.iv)],
                    ['2', 'CTL at ' + T(tk.tm) + ' (MPMS 11.1)', _fx(tk.ctl, f4)],
                    ['3', 'CPL at ' + P(tk.pm) + ' (F = ' + _fTxt(tk.F) + ')', _fx(tk.cpl, f4)],
                    ['4', 'Meter factor MF (' + tk.mfSrc + ')', _fx(tk.mf, f4)],
                    ['5', 'CCF = CTL × CPL × MF', _fx(tk.ccf, f4)],
                    ['6', 'Gross standard volume GSV = IV × CCF', V(tk.gsv)],
                    ['7', 'S&W ' + _fx(tk.sw, 3) + ' % → CSW = 1 − S&W/100', _fx(tk.csw, f4)],
                    ['8', 'Net standard volume NSV = GSV × CSW', V(tk.nsv)],
                    ['9', 'S&W volume = GSV − NSV', V(tk.swv)]
                ]) +
                _row('Gross standard volume', V(tk.gsv)) +
                _row('Net standard volume', V(tk.nsv)) +
                _row('S&W volume', V(tk.swv)) +
                (R ? _ok('Factors and volumes rounded to the API MPMS 12.2 discrimination levels.') : _warn('MPMS 12.2 rounding is off: factors and volumes are unrounded.')) +
                '</div>';
        } else if (tk) {
            h += '<div class="rbox"><div class="rbox-title">Net Standard Volume</div>' + _bad(tk.reason) + '</div>';
        }
        // Audit trail (#18)
        var a = r.audit;
        if (a && a.ok) {
            var rows = [
                ['1', 'Observed API ' + _fx(a.apiObs, 1) + ' at ' + T(a.tHyd) + ' → API @ 60 °F (Table 5A)', _fx(a.api60, 2)],
                ['2', 'Indicated volume = current − previous meter', V(a.iv, 3)],
                ['3', '× meter factor (' + a.mfSrc + ') ' + _fx(a.mf, 4), V(a.gross, 3)],
                ['4', '× VCF / CTL at ' + T(a.tLine) + ' (Table 6A) ' + _fx(a.vcf, 6) + ' = GSV', V(a.gsv, 3)],
                ['5', '× (1 − BS&W ' + _fx(a.bsw, 2) + ' %) ' + _fx(a.csw, 4) + ' = NSV', V(a.nsv, 3)],
                ['6', '× shrinkage ' + _fx(a.shr, 4) + ' = stock-tank oil', V(a.sto, 3)],
                ['7', '× 1440 / ' + _fmt(a.interval, 0) + ' min = oil rate', _u(a.rate, 'liquidRate', 2, 'BPD', 3)]
            ];
            if (a.cpl != null) rows.push(['8', 'with CPL ' + _fx(a.cpl, 5) + ' at ' + P(a.pLine) + ' (not applied on the Oil & Gas Rate page)', _u(a.rateCpl, 'liquidRate', 2, 'BPD', 3)]);
            h += '<div class="rbox"><div class="rbox-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div>' +
                _tbl(['Step', 'Operation', 'Result'], rows) +
                _row('Net oil rate', _u(a.rate, 'liquidRate', 2, 'BPD', 3)) +
                (a.gor != null ? _row('GOR (gas rate / net oil rate)', _u(a.gor, 'gor', 0, 'scf/bbl', 1)) : '') +
                _ok('Same chain and factors as the Oil & Gas Rate page: rate = IV × MF × VCF × (1 − BS&W) × shrinkage × 1440 / interval.') +
                '</div>';
        } else if (a) {
            h += '<div class="rbox"><div class="rbox-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div>' + _bad(a.reason) + '</div>';
        }
        h += '<div><b>Notes</b> CTL: API MPMS 11.1 (1980) / ASTM D1250 closed-form equations, α60 = K0/ρ60² + K1/ρ60 ' +
            '(crude K0 341.0957, K1 0; transition zone α60 = A + B/ρ60²), no table rounding of density or α. CPL: MPMS 11.2.1 ' +
            'F = 10⁻⁵·exp(−1.9947 + 0.00013427·t + (793920 + 2326·t)/ρ60²) per psi, CPL = 1/(1 − F·(P − Pe)). Prover: CTSp = ' +
            '1 + (Tp − 60)·Gc, CPSp = 1 + Pp·ID/(E·wt) for an unrestrained pipe prover. MF = GSVp/ISVm by the average data ' +
            'method (MPMS 12.2.3); repeatability is the range of the run meter factors, (max − min)/min, against MPMS 4.8 ' +
            'Table A-1. Ticket: MPMS 12.2.2, CCF = CTL·CPL·MF. The audit trail repeats the Oil & Gas Rate page (crude, ' +
            'Table 5A/6A, no CPL) so each factor can be checked.</div>';
        return h;
    }

    function _readInputs() {
        var runs = [];
        for (var k = 1; k <= NR; k++) runs.push({ iv: _num('pv_iv' + k), tp: _num('pv_tp' + k), pp: _num('pv_pp' + k), tm: _num('pv_tm' + k), pm: _num('pv_pm' + k) });
        return {
            round: _chk('pv_round'), group: _str('pv_grp'), apiObs: _num('pv_api'), tHyd: _num('pv_th'), pe: _num('pv_pe'),
            steel: _str('pv_steel'), bpv: _num('pv_bpv'), proverId: _num('pv_pid'), wall: _num('pv_wall'),
            prevMf: _num('pv_prev'), mfTol: _num('pv_mft'), runs: runs,
            ticket: { open: _num('pv_to'), close: _num('pv_tc'), tm: _num('pv_ttm'), pm: _num('pv_tpm'), sw: _num('pv_tsw'), mf: _num('pv_tmf') },
            audit: { interval: _num('pv_aint'), apiObs: _num('pv_aapi'), tHyd: _num('pv_aht'), m0: _num('pv_am0'), m1: _num('pv_am1'),
                tLine: _num('pv_at'), bsw: _num('pv_absw'), mf: _num('pv_amf'), shr: _num('pv_ashr'), pLine: _num('pv_ap'), gas: _num('pv_agas') }
        };
    }

    function _calcImpl() {
        var root = _byId('pv_root'), res = _byId('pv_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var r = compute(_readInputs());
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.proving = { ok: false, errors: r.errors.slice(), mf: null, ts: Date.now() };
            var items = r.errors.map(function (e) { return '<li>' + e.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>'; }).join('');
            r.bad.forEach(function (k) {
                var m = /^run(\d+)$/.exec(k);
                var ids = m ? ['pv_iv' + m[1], 'pv_tp' + m[1], 'pv_pp' + m[1], 'pv_tm' + m[1], 'pv_pm' + m[1]] : [IDS[k]];
                ids.forEach(function (id) { var el = _byId(id); if (el && el.classList) el.classList.add('input-err'); });
            });
            if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
            return r;
        }
        var pv = r.prove, tk = r.ticket, a = r.audit;
        G.WTS_state.proving = {
            ok: true, api60: r.liquid.api60, rho60: r.liquid.rho60,
            mf: pv && pv.ok ? pv.mf : null, mfAvgMethod: pv && pv.ok ? pv.mfAvgMethod : null,
            rangePct: pv && pv.ok ? pv.rangePct : null, repeatOk: pv && pv.ok ? pv.repeatOk : null,
            gsv: tk && tk.ok ? tk.gsv : null, nsv: tk && tk.ok ? tk.nsv : null, ccf: tk && tk.ok ? tk.ccf : null,
            auditRate: a && a.ok ? a.rate : null, ts: Date.now()
        };
        if (res) { res.innerHTML = _resultsHtml(r); res.setAttribute('data-done', '1'); }
        return r;
    }
    G.calcProving = function () { return _canon(_calcImpl); };

    // Copy the Oil & Gas Rate page's saved inputs into the audit-trail card.
    // Saved values are canonical imperial (page autosave record, else the page's own list).
    G.copyOilGasToProving = function () {
        var src = null;
        try {
            var ls = G.localStorage;
            var rec = ls ? JSON.parse(ls.getItem('wts_page_oilgas') || 'null') : null;
            if (rec && rec.f) src = rec.f;
            if (!src) { var leg = ls ? JSON.parse(ls.getItem('wts_oilgas') || 'null') : null; if (leg && typeof leg === 'object') src = leg; }
        } catch (e) { src = null; }
        var msg = _byId('pv_copymsg');
        if (!src) { if (msg) msg.textContent = 'No saved Oil & Gas Rate inputs found: open that page and calculate first.'; return false; }
        var U = G.WTS_units, met = _metric(), n = 0;
        Object.keys(OG_MAP).forEach(function (k) {
            var el = _byId(OG_MAP[k]);
            if (!el || src[k] == null || String(src[k]).trim() === '') return;
            var v = parseFloat(src[k]);
            if (!isFinite(v)) return;
            var cat = UNITS[OG_MAP[k]];
            if (met && cat && U && U.convertCategory) { var c = U.convertCategory(v, cat, 'imperial', 'metric'); if (isFinite(c)) v = Number(c.toPrecision(10)); }
            el.value = String(v);
            n++;
        });
        if (msg) msg.textContent = n ? 'Copied ' + n + ' inputs from the Oil & Gas Rate page.' : 'No usable Oil & Gas Rate inputs found.';
        G.calcProving();
        return n > 0;
    };

    function _pageHtml() {
        var h = '<div id="pv_root"><div class="cols-2"><div style="min-width:0">';
        var grpOpts = Object.keys(GROUPS).map(function (k) { return [k, GROUPS[k].name]; });
        var stOpts = Object.keys(STEELS).map(function (k) { return [k, STEELS[k].name]; });
        h += '<div class="card"><div class="card-title">Liquid and Prover</div><div class="fg">' +
            _sel('pv_grp', 'Commodity group (MPMS 11.1)', grpOpts, 'crude') +
            _fg('pv_api', 'Observed gravity (°API)', '32.5') +
            _fg('pv_th', 'Hydrometer temperature (°F)', '75') +
            _fg('pv_pe', 'Equilibrium vapour pressure (psig)', '0') +
            _fg('pv_bpv', 'Prover base volume (bbl)', '50.0000') +
            _sel('pv_steel', 'Prover steel', stOpts, 'cs') +
            _fg('pv_pid', 'Prover inside diameter (in)', '15.25') +
            _fg('pv_wall', 'Prover wall thickness (in)', '0.375') +
            _fg('pv_prev', 'Previous meter factor (optional)', '1.0005', ' placeholder="blank = skip"') +
            _fg('pv_mft', 'Meter-factor change limit (%)', '0.25') +
            '<div class="fg-item"><label for="pv_round">Round per API MPMS 12.2</label><input type="checkbox" id="pv_round" checked></div>' +
            '</div></div>';
        // Runs
        h += '<div class="card"><div class="card-title">Prover Runs</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="pv_runs"><thead><tr><th>Run</th>' +
            '<th data-wts-unit-label="volume">Meter volume IVm (bbl)</th>' +
            '<th data-wts-unit-label="temperature">Prover T (°F)</th>' +
            '<th data-wts-unit-label="pressureG">Prover P (psig)</th>' +
            '<th data-wts-unit-label="temperature">Meter T (°F)</th>' +
            '<th data-wts-unit-label="pressureG">Meter P (psig)</th></tr></thead><tbody>';
        for (var k = 1; k <= NR; k++) {
            var d = DEF_RUNS[k - 1] || ['', '', '', '', ''];
            var cell = function (id, val, aria) {
                return '<td><input type="number" step="any" id="' + id + '" value="' + val + '" aria-label="' + aria + '" style="width:100%;min-width:64px"></td>';
            };
            h += '<tr><td>' + k + '</td>' + cell('pv_iv' + k, d[0], 'Run ' + k + ' meter volume') + cell('pv_tp' + k, d[1], 'Run ' + k + ' prover temperature') +
                cell('pv_pp' + k, d[2], 'Run ' + k + ' prover pressure') + cell('pv_tm' + k, d[3], 'Run ' + k + ' meter temperature') +
                cell('pv_pm' + k, d[4], 'Run ' + k + ' meter pressure') + '</tr>';
        }
        h += '</tbody></table></div>' +
            '<div class="info-bar" style="margin-top:12px">A run is used when its meter volume is filled in. Meter volume IVm = meter pulses / nominal K-factor. At least 3 runs; 5 is usual.</div></div>';
        // Ticket
        h += '<div class="card"><div class="card-title">Measurement Ticket</div><div class="fg">' +
            _fg('pv_to', 'Opening meter reading (bbl)', '125000.00') +
            _fg('pv_tc', 'Closing meter reading (bbl)', '131250.40') +
            _fg('pv_ttm', 'Average meter temperature (°F)', '78.0') +
            _fg('pv_tpm', 'Average meter pressure (psig)', '100') +
            _fg('pv_tsw', 'S&W (%)', '0.35') +
            _fg('pv_tmf', 'Meter factor (blank = proven)', '', ' placeholder="blank = proven"') +
            '</div></div>';
        // #18 audit trail
        h += '<div class="card"><div class="card-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div><div class="fg">' +
            _fg('pv_aint', 'Calc interval (min)', '60') +
            _fg('pv_aapi', 'API gravity (observed)', '35') +
            _fg('pv_aht', 'Hydrometer temperature (°F)', '80') +
            _fg('pv_am0', 'Previous meter (bbl)', '1000') +
            _fg('pv_am1', 'Current meter (bbl)', '1004.5') +
            _fg('pv_at', 'Oil line temperature (°F)', '120') +
            _fg('pv_absw', 'BS&W (%)', '2') +
            _fg('pv_amf', 'Meter factor (blank = proven)', '1.0') +
            _fg('pv_ashr', 'Shrinkage factor', '0.95') +
            _fg('pv_ap', 'Oil line pressure for CPL (psig, optional)', '', ' placeholder="blank = no CPL"') +
            _fg('pv_agas', 'Gas rate for GOR (MSCFD, optional)', '', ' placeholder="blank = skip"') +
            '</div>' +
            '<div class="btn-row"><button class="btn btn-secondary" id="pv_copy" onclick="copyOilGasToProving()">Copy from Oil &amp; Gas Rate</button>' +
            '<button class="btn btn-primary" id="pv_calc" onclick="calcProving()">Calculate</button></div>' +
            '<div class="info-bar" id="pv_copymsg" style="margin-top:8px">Defaults match the Oil &amp; Gas Rate page.</div></div>';
        h += '</div><div style="min-width:0"><div id="pv_res"></div></div></div></div>';
        return h;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('pv_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^pv_/.test(e.target.id || '')) G.calcProving();
            });
        }
        G.calcProving();
    }
    G.renderProving = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.proving = {
        key: 'proving',
        title: TITLE,
        navTitle: 'Meter Proving & NSV',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9878;',
        badge: 'Metering',
        bc: 'dc-b-orange',
        desc: 'Meter factor from prover runs with the MPMS 4.8 repeatability check, CTL/CPL, S&W and net standard volume, plus a net-oil audit trail.',
        render: function (body) { return G.renderProving(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('pv_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcProving();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (typeof G.WTS_proving_ticketChain !== 'function') return;
    var fails = [], n = 0;
    function near(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol)) fails.push(what + ': got ' + a + ', want ' + b); }
    // API MPMS 12.2 Part 1, Example 3: MF 1.0253, CTL 1.0000, CPL 1.0006 → CCF 1.0259; IV 47,082.85 → GSV 48,302.30 bbl
    var c = G.WTS_proving_ticketChain({ iv: 47082.85, ctl: 1.0, cpl: 1.0006, mf: 1.0253, sw: 0, round: true });
    near(c.ccf, 1.0259, 1e-12, 'CCF'); near(c.gsv, 48302.30, 1e-9, 'GSV');
    // ASTM D1250 Table 6A: 35.0 °API at 100 °F → VCF 0.9810 (4 dp)
    near(Math.round(G.WTS_proving_ctl(35, 100, 'crude') * 1e4) / 1e4, 0.9810, 1e-12, 'Table 6A 35/100');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[proving self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined' && typeof window === 'undefined') console.log('[proving self-test] ' + n + '/' + n + ' checks passed');
})();
