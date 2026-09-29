// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Well Kill & Bullhead (wellkill)
//
// PURPOSE
//   A. Kill-weight fluid from reservoir pressure and top-perforation TVD
//      with an overbalance (ppg, SG, kg/m³, gradient).
//   B. Bullhead volume per string section (tubing to the packer, casing or
//      liner below the packer to the top perforation, perforated interval,
//      rathole to PBTD) from the shared tubular table (40-calc-tubulars.js,
//      window.WTS_tubulars), plus over-displacement, pump strokes and time,
//      and a static pumping schedule.
//   C. Maximum static surface pressure against the fracture gradient at the
//      perforations (and at the casing shoe when entered), at the start and
//      the end of the bullhead, with verdicts.
//   D. U-tube check at the packer / circulating point and the static fluid
//      level if the formation takes fluid.
//   E. Clear-brine selection guide (guidance values).
//   F. Liquid / mixed gradient card: static liquid column, gas cap with an
//      average-Z gas gradient and a mixed gas/liquid column, surface ↔
//      bottomhole conversion (window.WTS_gradient_compute).
//
// UNITS
//   Field units throughout: psi, ft (MD / TVD), ppg, bbl, bbl/stroke, °F.
//   Hydrostatic constant 0.052 psi/ft per ppg (API well-control convention);
//   SG = ppg / 8.33; kg/m³ = ppg × 119.826. The units layer converts tagged
//   inputs, so the calc always reads imperial values.
//
// PUBLIC API (window.*)
//   renderWellKill(body)          paints the page into #pgBody
//   calcWellKill()                reads the DOM, validates, computes, renders (both cards)
//   WTS_wellkill_compute(input)   → {ok, kill, bullhead, limits, utube, brines, …} or {ok:false, errors, bad}
//   WTS_gradient_compute(input)   → {ok, pSurf, pBot, sections[], avgGrad, …} or {ok:false, errors, bad}
//   WTS_wellkill_brines           the brine guide rows
//
// STATE
//   WTS_state.wellkill = {kwf, kwfUsed, bullheadVol, pumpedVol, strokes, maspStart, maspEnd, ts, result}
//   WTS_state.gradient = {pSurf, pBot, avgGrad, ts, result}
//
// Registers window.WTS_calcRegistry.wellkill (group "Test System Safety").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var HYD = 0.052;                  // psi/ft per ppg
    var PPG_PER_SG = 8.33;            // fresh water, ppg
    var KGM3_PER_PPG = 119.826;       // kg/m³ per ppg
    var PSIFT_TO_KPAM = 6.894757 / 0.3048;   // 22.6206 kPa/m per psi/ft
    var PATM = 14.696;                // psia
    // Gas gradient: dp/dh = P·M/(Z·R·T)/144, M = 28.9647·SG, R = 10.7316 → 0.018743·SG·P/(Z·T)
    var GAS_C = 28.9647 / (10.7316 * 144);
    var K_CAP = Math.PI / 4 * 12 / 9702;       // bbl/ft per in² (fallback if WTS_tubulars is absent)
    var WINDOW_FRAC = 0.10;           // ⚠ when the start bullhead window is below 10 % of fracture pressure

    // Clear-brine guide: typical maximum density at surface temperature (about 70 °F),
    // conservative published values. Guidance only.
    var BRINES = [
        { name: 'Fresh water', short: 'fresh water', ppg: 8.33, note: 'Freezes at 32 °F. Clay swelling without an inhibitor.' },
        { name: 'Seawater', short: 'seawater', ppg: 8.55, note: 'Filter it. Sulphate scale risk with some formation waters.' },
        { name: 'Potassium chloride, KCl', short: 'KCl', ppg: 9.7, note: 'Clay and shale inhibition. Salt crystallises out as it cools near saturation.' },
        { name: 'Sodium chloride, NaCl', short: 'NaCl', ppg: 10.0, note: 'Low cost. Check the crystallisation temperature near saturation.' },
        { name: 'Sodium formate', short: 'Na formate', ppg: 11.0, note: 'Low corrosion, biodegradable. Higher cost.' },
        { name: 'Calcium chloride, CaCl2', short: 'CaCl2', ppg: 11.6, note: 'Heats up when mixed. Scale risk with sulphate or carbonate formation water.' },
        { name: 'Sodium bromide, NaBr', short: 'NaBr', ppg: 12.5, note: 'Use where calcium is incompatible with the formation water.' },
        { name: 'Potassium formate', short: 'K formate', ppg: 13.1, note: 'Low corrosion, good elastomer compatibility. High cost.' },
        { name: 'Calcium bromide, CaBr2', short: 'CaBr2', ppg: 14.2, note: 'Standard stock fluid. Heavier blends raise the crystallisation temperature.' },
        { name: 'CaCl2 / CaBr2 blend', short: 'CaCl2/CaBr2', ppg: 15.1, note: 'Crystallisation temperature set by the blend ratio. Confirm with the supplier.' },
        { name: 'Cesium formate', short: 'Cs formate', ppg: 19.2, note: 'Very high cost, often rented. Low corrosion.' },
        { name: 'ZnBr2 / CaBr2 blend', short: 'ZnBr2/CaBr2', ppg: 19.2, note: 'Corrosive and acidic. Handling hazard. Zinc discharge restricted. Check elastomers.' }
    ];
    BRINES.forEach(function (b) { b.sg = b.ppg / PPG_PER_SG; b.kgm3 = b.ppg * KGM3_PER_PPG; });

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _fixed(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    // value in the display system; impLabel is the imperial text
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (_metric() && U.format) {
            var f = U.format(v, cat);
            return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label;
        }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _grad(psiFt) { return _metric() ? _fmt(psiFt * PSIFT_TO_KPAM, 3) + ' kPa/m' : _fmt(psiFt, 4) + ' psi/ft'; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x == null || x === '' || (typeof x === 'number' && (isNaN(x) || x === 0)); }
    function _tub(key) {
        var T = G.WTS_tubulars;
        return (T && T.find) ? T.find(String(key)) : null;
    }
    function _cap(idIn) {
        var T = G.WTS_tubulars;
        return (T && T.capacity) ? T.capacity(idIn) : idIn * idIn * K_CAP;
    }

    // ── Pure compute: kill & bullhead ───────────────────────────────
    // input = {pres, tvd, ob, kwo, fg, wf, ann, stvd, sfg, tub, cas, pmd, ptvd, tmd, bmd, pbtd, to, od, pump, spm}
    //   pres psi at top perfs; tvd = top-perforation TVD ft; ob psi; kwo ppg (blank/0 → calculated
    //   kill weight rounded up to 0.1 ppg); fg, sfg fracture gradient EMW ppg; wf = well fluid EMW ppg
    //   before the kill; ann = annulus fluid ppg; stvd shoe TVD ft (blank/0 → no shoe check);
    //   tub / cas = WTS_tubulars keys; pmd/ptvd packer MD/TVD; tmd/bmd top/bottom perf MD; pbtd MD;
    //   to = 'top' | 'bot' | 'pbtd' (displace to); od over-displacement %; pump bbl/stroke; spm (blank → no time).
    function wellkill(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var pres = Number(i.pres), tvd = Number(i.tvd), ob = Number(i.ob), fg = Number(i.fg), wf = Number(i.wf), ann = Number(i.ann);
        var kwo = _blank(i.kwo) ? null : Number(i.kwo);
        var stvd = _blank(i.stvd) ? null : Number(i.stvd);
        var sfg = _blank(i.sfg) ? null : Number(i.sfg);
        var pmd = Number(i.pmd), ptvd = Number(i.ptvd), tmd = Number(i.tmd), bmd = Number(i.bmd), pbtd = Number(i.pbtd);
        var od = Number(i.od), pump = Number(i.pump);
        var spm = _blank(i.spm) ? null : Number(i.spm);
        var to = (i.to === 'bot' || i.to === 'pbtd') ? i.to : 'top';
        var tub = _tub(i.tub), cas = _tub(i.cas);

        need(_fin(pres) && pres > 0 && pres <= 30000, 'pres', 'Reservoir pressure must be above 0 and no more than 30,000 psi.');
        var tvdOk = need(_fin(tvd) && tvd > 0 && tvd <= 40000, 'tvd', 'Top perforation TVD must be above 0 and no more than 40,000 ft.');
        need(_fin(ob) && ob >= 0 && ob <= 5000, 'ob', 'Overbalance must be between 0 and 5,000 psi.');
        if (kwo != null) need(_fin(kwo) && kwo >= 6 && kwo <= 25, 'kwo', 'Kill fluid density to use must be between 6 and 25 ppg, or blank.');
        var wfOk = need(_fin(wf) && wf >= 0 && wf < 25, 'wf', 'Well fluid density must be 0 ppg or more and below 25 ppg.');
        need(_fin(fg) && fg >= 6 && fg <= 25 && (!wfOk || fg > wf), 'fg', 'Fracture gradient must be between 6 and 25 ppg EMW and above the well fluid density.');
        need(_fin(ann) && ann > 0 && ann <= 25, 'ann', 'Annulus fluid density must be above 0 and no more than 25 ppg.');
        if (stvd != null) need(_fin(stvd) && stvd > 0 && (!tvdOk || stvd <= tvd), 'stvd', 'Casing shoe TVD must be above 0 and no deeper than the top perforation TVD, or blank.');
        if (stvd != null) need(sfg != null && _fin(sfg) && sfg >= 6 && sfg <= 25 && (!wfOk || sfg > wf), 'sfg', 'Shoe fracture gradient must be between 6 and 25 ppg EMW and above the well fluid density.');
        var tubOk = need(!!tub, 'tub', 'Select a tubing size.');
        var casOk = need(!!cas, 'cas', 'Select a casing or liner size.');
        if (tubOk && casOk) need(tub.od < cas.id, 'tub', 'Tubing OD does not fit inside the casing / liner ID.');
        var pmdOk = need(_fin(pmd) && pmd > 0 && pmd <= 50000, 'pmd', 'Packer MD must be above 0 and no more than 50,000 ft.');
        need(_fin(ptvd) && ptvd > 0 && (!pmdOk || ptvd <= pmd + 1e-6) && (!tvdOk || ptvd <= tvd + 1e-6), 'ptvd', 'Packer TVD must be above 0, no more than the packer MD and no deeper than the top perforation TVD.');
        var tmdOk = need(_fin(tmd) && (!pmdOk || tmd >= pmd) && (!tvdOk || tmd >= tvd - 1e-6) && tmd <= 50000, 'tmd', 'Top perforation MD must be at or below the packer MD and not less than the top perforation TVD.');
        var bmdOk = need(_fin(bmd) && (!tmdOk || bmd >= tmd) && bmd <= 50000, 'bmd', 'Bottom perforation MD must be at or below the top perforation MD.');
        need(_fin(pbtd) && (!bmdOk || pbtd >= bmd) && pbtd <= 50000, 'pbtd', 'PBTD must be at or below the bottom perforation MD.');
        need(_fin(od) && od >= 0 && od <= 100, 'od', 'Over-displacement must be between 0 and 100 %.');
        need(_fin(pump) && pump >= 0.001 && pump <= 2, 'pump', 'Pump output must be between 0.001 and 2 bbl per stroke.');
        if (spm != null) need(_fin(spm) && spm >= 1 && spm <= 300, 'spm', 'Pump speed must be between 1 and 300 strokes per minute, or blank.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        // A. Kill fluid
        var balance = pres / (HYD * tvd);
        var obPpg = ob / (HYD * tvd);
        var kwf = (pres + ob) / (HYD * tvd);
        var auto = kwo == null;
        var used = auto ? Math.ceil(kwf * 10 - 1e-9) / 10 : kwo;
        var grad = HYD * used;
        var hyd = grad * tvd;
        var kill = {
            balance: balance, obPpg: obPpg, kwf: kwf, used: used, auto: auto,
            sg: used / PPG_PER_SG, kgm3: used * KGM3_PER_PPG, grad: grad, gradKpaM: grad * PSIFT_TO_KPAM,
            kwfSg: kwf / PPG_PER_SG, kwfKgm3: kwf * KGM3_PER_PPG,
            hyd: hyd, obActual: hyd - pres,
            belowKwf: used < kwf - 1e-9, belowBalance: used < balance - 1e-9
        };

        // B. Bullhead volumes
        var tubCap = _cap(tub.id), casCap = _cap(cas.id);
        var sections = [
            { key: 'tubing', name: 'Tubing', from: 0, to: pmd, idIn: tub.id, cap: tubCap },
            { key: 'casing', name: 'Casing below packer', from: pmd, to: tmd, idIn: cas.id, cap: casCap },
            { key: 'perfs', name: 'Perforated interval', from: tmd, to: bmd, idIn: cas.id, cap: casCap },
            { key: 'rathole', name: 'Rathole', from: bmd, to: pbtd, idIn: cas.id, cap: casCap }
        ];
        var nIn = to === 'top' ? 2 : to === 'bot' ? 3 : 4;
        var vol = 0;
        sections.forEach(function (s, k) {
            s.len = s.to - s.from; s.vol = s.len * s.cap; s.included = k < nIn;
            if (s.included) vol += s.vol;
        });
        var pumped = vol * (1 + od / 100);
        var strokes = pumped / pump;
        var bullhead = {
            sections: sections, to: to, vol: vol, extra: pumped - vol, pumped: pumped,
            strokes: strokes, minutes: spm ? strokes / spm : null, tubCap: tubCap, casCap: casCap,
            annCap: (cas.id * cas.id - tub.od * tub.od) * K_CAP
        };

        // C. Surface pressure limits (static, no friction)
        var pFrac = HYD * fg * tvd;
        var hydWf = HYD * wf * tvd;
        var sithp = Math.max(0, pres - hydWf);
        var perfStart = pFrac - hydWf, perfEnd = pFrac - hyd;
        var shoe = null;
        if (stvd != null) {
            var pFs = HYD * sfg * stvd;
            shoe = { tvd: stvd, fg: sfg, pFrac: pFs, start: pFs - HYD * wf * stvd, end: pFs - grad * stvd };
        }
        var maspStart = shoe ? Math.min(perfStart, shoe.start) : perfStart;
        var maspEnd = shoe ? Math.min(perfEnd, shoe.end) : perfEnd;
        var endReq = Math.max(0, pres - hyd);
        var limits = {
            pFrac: pFrac, fgGrad: HYD * fg, sithp: sithp, hydWf: hydWf,
            perfStart: perfStart, perfEnd: perfEnd, shoe: shoe,
            maspStart: maspStart, maspEnd: maspEnd, endReq: endReq,
            windowStart: maspStart - sithp,
            governs: shoe && (shoe.start < perfStart || shoe.end < perfEnd) ? 'shoe' : 'perfs',
            killFracs: used >= fg - 1e-9
        };

        // Static pumping schedule, 0 → 100 % of the bullhead volume (MD → TVD linear between
        // surface, packer and top perforation; below the top perforation the front is at the perfs).
        function tvdAt(md) {
            if (md <= pmd) return pmd > 0 ? md / pmd * ptvd : 0;
            if (md <= tmd) return tmd > pmd ? ptvd + (md - pmd) / (tmd - pmd) * (tvd - ptvd) : tvd;
            return tvd;
        }
        function frontMd(v) {
            var left = v, md = 0;
            for (var k = 0; k < nIn; k++) {
                var s = sections[k];
                if (left <= s.vol || k === nIn - 1) { md = s.from + (s.cap > 0 ? Math.min(left, s.vol) / s.cap : 0); break; }
                left -= s.vol;
            }
            return md;
        }
        var schedule = [];
        for (var n = 0; n <= 10; n++) {
            var v = vol * n / 10, fmd = frontMd(v), ftvd = Math.min(tvd, tvdAt(fmd));
            var h = HYD * (used * ftvd + wf * (tvd - ftvd));
            var sf = shoe ? Math.min(stvd, ftvd) : 0;
            var mShoe = shoe ? shoe.pFrac - HYD * (used * sf + wf * (stvd - sf)) : Infinity;
            schedule.push({
                pct: n * 10, vol: v, strokes: v / pump, frontMd: fmd, frontTvd: ftvd,
                sitp: Math.max(0, pres - h), masp: Math.min(pFrac - h, mShoe)
            });
        }
        bullhead.schedule = schedule;

        // D. U-tube and fluid level
        var dU = HYD * (used - ann) * ptvd;
        var level = tvd - pres / grad;
        var utube = {
            dp: dU, heavier: dU > 1e-9 ? 'tubing' : dU < -1e-9 ? 'annulus' : 'none',
            level: level > 0 ? level : 0, onVacuum: level > 0
        };

        // E. Brine guide
        var brines = BRINES.map(function (b) {
            return { name: b.name, short: b.short, ppg: b.ppg, sg: b.sg, kgm3: b.kgm3, note: b.note, reaches: b.ppg >= used - 1e-9 };
        });
        var reach = brines.filter(function (b) { return b.reaches && b.ppg > 8.6; });
        return {
            ok: true, kill: kill, bullhead: bullhead, limits: limits, utube: utube,
            brines: brines, brineOk: brines.some(function (b) { return b.reaches; }),
            brineList: (used <= 8.55 ? brines.filter(function (b) { return b.reaches; }) : reach).slice(0, 4).map(function (b) { return b.short; }),
            tubing: tub, casing: cas
        };
    }

    // ── Pure compute: liquid / mixed gradient ───────────────────────
    // input = {dir:'s2b'|'b2s', p psig (known pressure), tvd ft, gasLen ft, mixLen ft, hl % (liquid
    //          holdup in the mixed column), rho ppg, sg (gas), t °F (average), z (average)}
    // Column from surface: gas cap [0, gasLen], mixed [gasLen, gasLen+mixLen], liquid to tvd.
    // Each section solves dp/dh = a + b·P (P psia): a = liquid part, b = gas part (average Z, T):
    //   P(h) = (P0 + a/b)·e^(b·h) − a/b   (b > 0);   P(h) = P0 + a·h   (b = 0).
    function gradient(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var dir = i.dir === 'b2s' ? 'b2s' : 's2b';
        var p = Number(i.p), tvd = Number(i.tvd), lg = _blank(i.gasLen) ? 0 : Number(i.gasLen), lm = _blank(i.mixLen) ? 0 : Number(i.mixLen);
        var hl = Number(i.hl), rho = Number(i.rho), sg = Number(i.sg), t = Number(i.t), z = Number(i.z);
        need(_fin(p) && p >= 0 && p <= 30000, 'p', 'Known pressure must be between 0 and 30,000 psig.');
        var tvdOk = need(_fin(tvd) && tvd > 0 && tvd <= 40000, 'tvd', 'Column TVD must be above 0 and no more than 40,000 ft.');
        var lgOk = need(_fin(lg) && lg >= 0 && (!tvdOk || lg <= tvd), 'gasLen', 'Gas cap length must be 0 or more and no longer than the column.');
        need(_fin(lm) && lm >= 0 && (!tvdOk || !lgOk || lg + lm <= tvd + 1e-9), 'mixLen', 'Mixed column length must be 0 or more; gas cap plus mixed column cannot exceed the column TVD.');
        need(_fin(hl) && hl >= 0 && hl <= 100, 'hl', 'Liquid holdup must be between 0 and 100 %.');
        need(_fin(rho) && rho > 0 && rho <= 25, 'rho', 'Liquid density must be above 0 and no more than 25 ppg.');
        need(_fin(sg) && sg >= 0.55 && sg <= 3, 'sg', 'Gas gravity must be between 0.55 and 3.');
        need(_fin(t) && t >= -40 && t <= 500, 't', 'Average temperature must be between -40 and 500 °F.');
        need(_fin(z) && z >= 0.2 && z <= 2, 'z', 'Average Z-factor must be between 0.2 and 2.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var TR = t + 459.67, gL = HYD * rho, bg = GAS_C * sg / (z * TR), H = hl / 100;
        var ll = Math.max(0, tvd - lg - lm);
        var secs = [
            { key: 'gas', name: 'Gas cap', len: lg, a: 0, b: bg },
            { key: 'mixed', name: 'Mixed column', len: lm, a: H * gL, b: (1 - H) * bg },
            { key: 'liquid', name: 'Liquid column', len: ll, a: gL, b: 0 }
        ];
        function down(P0, s) { return s.b > 0 ? (P0 + s.a / s.b) * Math.exp(s.b * s.len) - s.a / s.b : P0 + s.a * s.len; }
        function up(P1, s) { return s.b > 0 ? (P1 + s.a / s.b) * Math.exp(-s.b * s.len) - s.a / s.b : P1 - s.a * s.len; }
        var top = 0;
        secs.forEach(function (s) { s.top = top; s.bottom = top + s.len; top = s.bottom; });
        if (dir === 's2b') {
            var P = p + PATM;
            secs.forEach(function (s) { s.pTop = P; P = down(P, s); s.pBot = P; });
        } else {
            var Q = p + PATM;
            for (var k = secs.length - 1; k >= 0; k--) {
                secs[k].pBot = Q; Q = up(Q, secs[k]); secs[k].pTop = Q;
                if (!(Q > 0)) return { ok: false, errors: ['Bottomhole pressure is too low to hold this column to surface; the liquid level would stand below surface.'], bad: ['p'] };
            }
        }
        var pSurfA = secs[0].pTop, pBotA = secs[2].pBot;
        secs.forEach(function (s) {
            s.pTop -= PATM; s.pBot -= PATM;
            s.grad = s.len > 0 ? (s.pBot - s.pTop) / s.len : null;
            delete s.a; delete s.b;
        });
        return {
            ok: true, dir: dir, pSurf: pSurfA - PATM, pBot: pBotA - PATM, tvd: tvd,
            avgGrad: (pBotA - pSurfA) / tvd, liqGrad: gL, liqLen: ll,
            gasGradSurf: bg * pSurfA, gasGradBot: bg * pBotA, sections: secs
        };
    }

    G.WTS_wellkill_compute = wellkill;
    G.WTS_gradient_compute = gradient;
    G.WTS_wellkill_brines = BRINES.map(function (b) { return { name: b.name, ppg: b.ppg, sg: b.sg, kgm3: b.kgm3, note: b.note }; });

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Well Kill & Bullhead';
    var SUB = 'Kill-weight fluid, bullhead volumes and strokes, surface pressure limits against fracture gradient, U-tube check, brine guide and liquid / gas gradients';
    var UNITS = {
        wk_pres: 'pressure', wk_tvd: 'length', wk_ob: 'pressure', wk_kwo: 'densityLiquid', wk_fg: 'densityLiquid',
        wk_wf: 'densityLiquid', wk_ann: 'densityLiquid', wk_stvd: 'length', wk_sfg: 'densityLiquid',
        wk_pmd: 'length', wk_ptvd: 'length', wk_tmd: 'length', wk_bmd: 'length', wk_pbtd: 'length',
        wk_od: 'percent', wk_pump: 'volume', wk_spm: 'count',
        wk_gp: 'pressureG', wk_gtvd: 'length', wk_glen: 'length', wk_gmix: 'length', wk_ghl: 'percent',
        wk_grho: 'densityLiquid', wk_gsg: 'sg', wk_gt: 'temperature', wk_gz: 'dimensionless'
    };
    var KILL_IDS = {
        pres: 'wk_pres', tvd: 'wk_tvd', ob: 'wk_ob', kwo: 'wk_kwo', fg: 'wk_fg', wf: 'wk_wf', ann: 'wk_ann',
        stvd: 'wk_stvd', sfg: 'wk_sfg', tub: 'wk_tub', cas: 'wk_cas', pmd: 'wk_pmd', ptvd: 'wk_ptvd',
        tmd: 'wk_tmd', bmd: 'wk_bmd', pbtd: 'wk_pbtd', od: 'wk_od', pump: 'wk_pump', spm: 'wk_spm'
    };
    var GRAD_IDS = { p: 'wk_gp', tvd: 'wk_gtvd', gasLen: 'wk_glen', mixLen: 'wk_gmix', hl: 'wk_ghl', rho: 'wk_grho', sg: 'wk_gsg', t: 'wk_gt', z: 'wk_gz' };

    // Validation messages in the display system (limits are imperial).
    function _den(v) { return _u(v, 'densityLiquid', 2, 'ppg', 3); }
    var MSG = {
        pres: function () { return 'Reservoir pressure must be above 0 and no more than ' + _u(30000, 'pressure', 0, 'psi') + '.'; },
        tvd: function () { return 'Top perforation TVD must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        ob: function () { return 'Overbalance must be between 0 and ' + _u(5000, 'pressure', 0, 'psi') + '.'; },
        kwo: function () { return 'Kill fluid density to use must be between ' + _den(6) + ' and ' + _den(25) + ', or blank.'; },
        wf: function () { return 'Well fluid density must be 0 or more and below ' + _den(25) + '.'; },
        fg: function () { return 'Fracture gradient must be between ' + _den(6) + ' and ' + _den(25) + ' EMW and above the well fluid density.'; },
        ann: function () { return 'Annulus fluid density must be above 0 and no more than ' + _den(25) + '.'; },
        stvd: function () { return 'Casing shoe TVD must be above 0 and no deeper than the top perforation TVD, or blank.'; },
        sfg: function () { return 'Shoe fracture gradient must be between ' + _den(6) + ' and ' + _den(25) + ' EMW and above the well fluid density.'; },
        pmd: function () { return 'Packer MD must be above 0 and no more than ' + _u(50000, 'length', 0, 'ft') + '.'; },
        od: function () { return 'Over-displacement must be between 0 and 100 %.'; },
        pump: function () { return 'Pump output must be between ' + _u(0.001, 'volume', 3, 'bbl', 5) + ' and ' + _u(2, 'volume', 0, 'bbl', 3) + ' per stroke.'; },
        spm: function () { return 'Pump speed must be between 1 and 300 strokes per minute, or blank.'; },
        p: function () { return 'Known pressure must be between 0 and ' + _u(30000, 'pressureG', 0, 'psig') + '.'; },
        gtvd: function () { return 'Column TVD must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        rho: function () { return 'Liquid density must be above 0 and no more than ' + _den(25) + '.'; },
        t: function () { return 'Average temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(500, 'temperature', 0, '°F') + '.'; }
    };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) {
            if (o.group != null) { h += (o.group ? '<optgroup label="' + o.group + '">' : '</optgroup>'); return; }
            h += '<option value="' + o.v + '"' + (o.v === val ? ' selected' : '') + '>' + o.t + '</option>';
        });
        return h + '</select></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _note(t) { return '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> ' + t + '</div>'; }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function _ppgTriple(ppg) {
        return _fixed(ppg, 2) + ' ppg · SG ' + _fixed(ppg / PPG_PER_SG, 3) + ' · ' + _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³';
    }

    // A single density in ppg, with its kg/m³ companion in Metric mode (imperial text unchanged).
    function _ppgMet(ppg) {
        return _fixed(ppg, 2) + ' ppg' + (_metric() ? ' (' + _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³)' : '');
    }

    function _errors(resId, ids, bad, errs) {
        var res = _byId(resId), items = '', seen = {};
        for (var k = 0; k < bad.length; k++) {
            var key = bad[k], el = _byId(ids[key]);
            if (el && el.classList) el.classList.add('input-err');
            if (seen[key]) continue;
            seen[key] = 1;
            var mk = (resId === 'wk_gres' && key === 'tvd') ? 'gtvd' : key;
            items += '<li>' + (MSG[mk] ? MSG[mk]() : errs[k]) + '</li>';
        }
        if (res) {
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
        }
    }

    function _paintKill(r) {
        var res = _byId('wk_res');
        if (!res) return;
        if (!r.ok) { _errors('wk_res', KILL_IDS, r.bad, r.errors); return; }
        var k = r.kill, b = r.bullhead, L = r.limits, U = r.utube;
        var P = function (v) { return _u(v, 'pressure', 0, 'psi'); };
        var V = function (v) { return _u(v, 'volume', 1, 'bbl', 2); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var h = '';

        // Kill fluid
        var kv = '';
        if (k.belowBalance) kv += _bad('Selected kill fluid is below the balance density; it will not kill the well.');
        else if (k.belowKwf) kv += _warn('Selected kill fluid is below the calculated kill weight; overbalance is ' + P(k.obActual) + '.');
        else kv += _ok('Kill fluid gives ' + P(k.obActual) + ' overbalance at the top perforation.');
        h += '<div class="rbox"><div class="rbox-title">Kill Fluid</div>' +
            _row('Balance density', _ppgTriple(k.balance)) +
            _row('Overbalance as density', _ppgMet(k.obPpg)) +
            _row('Kill weight', _ppgTriple(k.kwf)) +
            _row('Kill fluid used', _ppgTriple(k.used) + (k.auto ? ' (rounded up)' : ' (selected)')) +
            _row('Kill fluid gradient', _grad(k.grad)) +
            _row('Hydrostatic at top perforation', P(k.hyd)) +
            _row('Overbalance at top perforation', P(k.obActual)) +
            kv + '</div>';

        // Bullhead
        var toTxt = { top: 'top perforation', bot: 'bottom perforation', pbtd: 'PBTD' }[b.to];
        h += '<div class="rbox"><div class="rbox-title">Bullhead Volume</div>' +
            _tbl(['Section', 'From', 'To', 'ID', 'Capacity', 'Volume', 'Pumped'], b.sections.map(function (s) {
                return [s.name, ft(s.from), ft(s.to), _metric() ? _u(s.idIn, 'lengthSmall', 3, 'in', 1) : _fixed(s.idIn, 3) + ' in',
                    _u(s.cap, 'capacity', 5, 'bbl/ft', 5), V(s.vol), s.included ? 'yes' : 'no'];
            })) +
            _row('Tubing', r.tubing.label) +
            _row('Casing / liner below packer', r.casing.label) +
            _row('Bullhead volume to ' + toTxt, V(b.vol)) +
            _row('Over-displacement', V(b.extra)) +
            _row('Total to pump', V(b.pumped)) +
            _row('Pump strokes', _fmt(Math.ceil(b.strokes - 1e-9), 0) + ' strokes') +
            (b.minutes != null ? _row('Pumping time', _fmt(b.minutes, 1) + ' min') : '') +
            _row('Tubing x casing annular capacity', _u(b.annCap, 'capacity', 5, 'bbl/ft', 5)) +
            '</div>';

        // Pressure limits
        var pv = '';
        if (L.killFracs) pv += _bad('Kill fluid gradient is at or above the fracture gradient. Expect losses; use a lighter fluid with back-pressure or a loss plan.');
        if (L.windowStart <= 0) pv += _bad('Shut-in tubing pressure is at or above the maximum surface pressure: bullheading would fracture the formation.');
        else if (L.windowStart < WINDOW_FRAC * L.pFrac) pv += _warn('Narrow bullhead window at the start: ' + P(L.windowStart) + ' between shut-in pressure and the fracture limit.');
        else pv += _ok('Bullhead window at the start is ' + P(L.windowStart) + ' above the shut-in tubing pressure.');
        if (L.maspEnd <= 0 && !L.killFracs) pv += _bad('Maximum surface pressure reaches zero before the kill fluid reaches the perforations.');
        h += '<div class="rbox"><div class="rbox-title">Surface Pressure Limits</div>' +
            _row('Fracture pressure at top perforation', P(L.pFrac)) +
            _row('Fracture gradient', _grad(L.fgGrad)) +
            _row('Shut-in tubing pressure, estimated', P(L.sithp)) +
            _row('Max surface pressure at start', P(L.maspStart)) +
            _row('Max surface pressure at end', P(L.maspEnd)) +
            _row('Surface pressure needed at end', P(L.endReq)) +
            (L.shoe ? _row('Shoe: fracture pressure', P(L.shoe.pFrac)) +
                _row('Shoe: max surface pressure start / end', P(L.shoe.start) + ' / ' + P(L.shoe.end)) +
                _row('Governing limit', L.governs === 'shoe' ? 'casing shoe' : 'top perforation') : '') +
            pv +
            '<div class="rbox-title" style="margin-top:10px">Static Pumping Schedule</div>' +
            _tbl(['Pumped', 'Volume', 'Strokes', 'Front MD', 'Shut-in pressure', 'Max surface pressure'], b.schedule.map(function (s) {
                return [s.pct + ' %', V(s.vol), _fmt(Math.round(s.strokes), 0), ft(s.frontMd), P(s.sitp), P(s.masp)];
            })) +
            _note('Static values: no pipe friction, no gas migration, and fluids are assumed incompressible. Pipe friction at ' +
                'the pump rate adds to the surface pressure. Keep the pump pressure below the maximum surface pressure and the ' +
                'wellhead / treating-iron rating. The shoe limit applies where the casing sees the pressure, e.g. no packer or a leak.') +
            '</div>';

        // U-tube
        var uv = '';
        if (U.heavier === 'tubing') uv += _warn('Kill fluid is heavier than the annulus fluid: if tubing and annulus communicate, the tubing will U-tube with up to ' + P(U.dp) + ' difference at the packer.');
        else if (U.heavier === 'annulus') uv += _warn('Annulus fluid is heavier: on communication the annulus will U-tube into the tubing, up to ' + P(-U.dp) + ' difference at the packer.');
        else uv += _ok('Tubing and annulus fluids balance at the packer.');
        if (U.onVacuum) uv += _warn('If the formation takes fluid, the tubing will go on vacuum with a static fluid level at about ' + ft(U.level) + ' TVD.');
        else uv += _ok('Kill fluid column does not exceed reservoir pressure; the tubing stays full.');
        h += '<div class="rbox"><div class="rbox-title">U-tube Check</div>' +
            _row('Pressure difference at packer, tubing minus annulus', P(U.dp)) +
            _row('Static fluid level if the formation takes fluid', U.onVacuum ? ft(U.level) + ' TVD' : 'surface') +
            uv + '</div>';

        // Brines
        var bv = '';
        if (!r.brineOk) bv = _bad('No clear brine in the guide reaches ' + _ppgMet(k.used) + '. Use a weighted fluid.');
        else bv = _ok('Clear brines that reach ' + _ppgMet(k.used) + ': ' + r.brineList.join(', ') + '.');
        h += '<div class="rbox"><div class="rbox-title">Brine Selection Guide</div>' +
            _tbl(['Brine', 'Max ppg', 'Max SG', 'Max kg/m³', 'Reaches kill fluid', 'Crystallisation / notes'], r.brines.map(function (x) {
                return [x.name, _fixed(x.ppg, 2), _fixed(x.sg, 2), _fmt(x.kgm3, 0), x.reaches ? 'yes' : 'no', x.note];
            })) +
            bv +
            _note('Guidance only. Maximum densities are typical values at about 70 °F. Crystallisation temperature rises steeply ' +
                'near the maximum density, and pressure raises it further. Brine density falls as temperature rises. Confirm ' +
                'density at well temperature, crystallisation temperature and compatibility with the fluid supplier.') +
            '</div>';

        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _paintGrad(r) {
        var res = _byId('wk_gres');
        if (!res) return;
        if (!r.ok) { _errors('wk_gres', GRAD_IDS, r.bad, r.errors); return; }
        var P = function (v) { return _u(v, 'pressureG', 1, 'psig', 0); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var h = '<div class="rbox"><div class="rbox-title">Column Pressures</div>' +
            _row('Surface pressure', P(r.pSurf)) +
            _row('Bottomhole pressure', P(r.pBot)) +
            _row('Average gradient', _grad(r.avgGrad)) +
            _row('Liquid gradient', _grad(r.liqGrad)) +
            _row('Gas gradient at surface', _grad(r.gasGradSurf)) +
            _tbl(['Section', 'Top', 'Bottom', 'Pressure at top', 'Pressure at bottom', 'Gradient'], r.sections.map(function (s) {
                return [s.name, ft(s.top), ft(s.bottom), P(s.pTop), P(s.pBot), s.grad == null ? '—' : _grad(s.grad)];
            })) +
            (r.pSurf < 0 ? _warn('Surface pressure is below atmospheric: the column would not stand to surface.') : '') +
            _note('Static column, top to bottom: gas cap, mixed gas/liquid column, liquid. The gas gradient uses one average Z ' +
                'and temperature for the column. The mixed column uses a fixed liquid holdup with no slip or friction. ' +
                'Liquid gradient = 0.052 × density.') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _readKill() {
        return {
            pres: _num('wk_pres'), tvd: _num('wk_tvd'), ob: _num('wk_ob'), kwo: _num('wk_kwo'), fg: _num('wk_fg'),
            wf: _num('wk_wf'), ann: _num('wk_ann'), stvd: _num('wk_stvd'), sfg: _num('wk_sfg'),
            tub: _str('wk_tub'), cas: _str('wk_cas'), pmd: _num('wk_pmd'), ptvd: _num('wk_ptvd'),
            tmd: _num('wk_tmd'), bmd: _num('wk_bmd'), pbtd: _num('wk_pbtd'), to: _str('wk_to'),
            od: _num('wk_od'), pump: _num('wk_pump'), spm: _num('wk_spm')
        };
    }
    function _readGrad() {
        return {
            dir: _str('wk_gdir'), p: _num('wk_gp'), tvd: _num('wk_gtvd'), gasLen: _num('wk_glen'), mixLen: _num('wk_gmix'),
            hl: _num('wk_ghl'), rho: _num('wk_grho'), sg: _num('wk_gsg'), t: _num('wk_gt'), z: _num('wk_gz')
        };
    }

    function _calcImpl() {
        var root = _byId('wk_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var a = wellkill(_readKill());
        var g = gradient(_readGrad());
        _paintKill(a);
        _paintGrad(g);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.wellkill = {
            kwf: a.ok ? a.kill.kwf : null, kwfUsed: a.ok ? a.kill.used : null,
            bullheadVol: a.ok ? a.bullhead.vol : null, pumpedVol: a.ok ? a.bullhead.pumped : null,
            strokes: a.ok ? a.bullhead.strokes : null,
            maspStart: a.ok ? a.limits.maspStart : null, maspEnd: a.ok ? a.limits.maspEnd : null,
            ts: Date.now(), result: a
        };
        G.WTS_state.gradient = {
            pSurf: g.ok ? g.pSurf : null, pBot: g.ok ? g.pBot : null, avgGrad: g.ok ? g.avgGrad : null,
            ts: Date.now(), result: g
        };
        return { kill: a, gradient: g };
    }
    G.calcWellKill = function () { return _canon(_calcImpl); };

    function _tubOpts() {
        var T = G.WTS_tubulars, o = [];
        if (!T) return o;
        o.push({ group: 'Tubing' });
        T.tubing.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' }, { group: 'Casing sizes used as tubing' });
        T.casing.filter(function (e) { return e.od <= 7.625; }).forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' });
        return o;
    }
    function _casOpts() {
        var T = G.WTS_tubulars, o = [];
        if (!T) return o;
        o.push({ group: 'Casing' });
        T.casing.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' }, { group: 'Liner' });
        T.liners.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' });
        return o;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var btn = function (id) { return '<div class="btn-row"><button class="btn btn-primary" id="' + id + '" onclick="calcWellKill()">Calculate</button></div>'; };
        body.innerHTML =
            '<div id="wk_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Well &amp; Kill Fluid</div><div class="fg">' +
            _fg('wk_pres', 'Reservoir pressure at top perforation (psi)', '5400', ' min="0"') +
            _fg('wk_tvd', 'Top perforation TVD (ft)', '10000', ' min="0"') +
            _fg('wk_ob', 'Overbalance (psi)', '200', ' min="0"') +
            _fg('wk_kwo', 'Kill fluid density to use, blank = calculated (ppg)', '', ' min="0"') +
            _fg('wk_fg', 'Fracture gradient at top perforation, EMW (ppg)', '15', ' min="0"') +
            _fg('wk_wf', 'Well fluid density before the kill, EMW (ppg)', '1.9', ' min="0"') +
            _fg('wk_ann', 'Annulus / packer fluid density (ppg)', '8.6', ' min="0"') +
            _fg('wk_stvd', 'Casing shoe TVD, optional (ft)', '', ' min="0"') +
            _fg('wk_sfg', 'Fracture gradient at shoe, EMW (ppg)', '', ' min="0"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Completion &amp; Pumping</div><div class="fg">' +
            _sel('wk_tub', 'Tubing', _tubOpts(), 'tubing-2.875-6.5') +
            _sel('wk_cas', 'Casing / liner below packer', _casOpts(), 'casing-7-29') +
            _fg('wk_pmd', 'Packer MD (ft)', '9800', ' min="0"') +
            _fg('wk_ptvd', 'Packer TVD (ft)', '9620', ' min="0"') +
            _fg('wk_tmd', 'Top perforation MD (ft)', '10150', ' min="0"') +
            _fg('wk_bmd', 'Bottom perforation MD (ft)', '10250', ' min="0"') +
            _fg('wk_pbtd', 'PBTD, MD (ft)', '10400', ' min="0"') +
            _sel('wk_to', 'Displace to', [{ v: 'top', t: 'Top perforation' }, { v: 'bot', t: 'Bottom perforation' }, { v: 'pbtd', t: 'PBTD, rathole included' }], 'top') +
            _fg('wk_od', 'Over-displacement (%)', '10', ' min="0" max="100"') +
            _fg('wk_pump', 'Pump output per stroke (bbl)', '0.1', ' min="0"') +
            _fg('wk_spm', 'Pump speed, strokes per minute', '40', ' min="0"') +
            '</div>' + btn('wk_calc') + '</div>' +
            '<div class="card"><div class="card-title">Liquid / Mixed Gradient</div><div class="fg">' +
            _sel('wk_gdir', 'Pressure given at', [{ v: 's2b', t: 'Surface, find bottomhole' }, { v: 'b2s', t: 'Bottomhole, find surface' }], 's2b') +
            _fg('wk_gp', 'Known pressure (psig)', '1500', ' min="0"') +
            _fg('wk_gtvd', 'Column TVD (ft)', '10000', ' min="0"') +
            _fg('wk_glen', 'Gas cap length (ft)', '2000', ' min="0"') +
            _fg('wk_gmix', 'Mixed column length (ft)', '1000', ' min="0"') +
            _fg('wk_ghl', 'Liquid holdup in mixed column (%)', '40', ' min="0" max="100"') +
            _fg('wk_grho', 'Liquid density (ppg)', '8.6', ' min="0"') +
            _fg('wk_gsg', 'Gas gravity, air = 1', '0.65', ' min="0"') +
            _fg('wk_gt', 'Average temperature (°F)', '150') +
            _fg('wk_gz', 'Average Z-factor', '0.9', ' min="0"') +
            '</div>' + btn('wk_gcalc') +
            '<div id="wk_gres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '<div><div id="wk_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('wk_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^wk_/.test(e.target.id || '')) G.calcWellKill();
            });
        }
        G.calcWellKill();
    }
    G.renderWellKill = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.wellkill = {
        key: 'wellkill',
        title: TITLE,
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9660;',
        badge: 'Well control',
        bc: 'dc-b-orange',
        desc: 'Kill-weight fluid, bullhead volumes and strokes, fracture-limited surface pressure, U-tube check, brine guide and gradients.',
        render: function (body) { return G.renderWellKill(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['wk_res', 'wk_gres'];
            for (var n = 0; n < ids.length; n++) {
                var r = _byId(ids[n]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcWellKill(); return; }
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
        if (!(isFinite(a) && Math.abs(a - b) <= (tol || 1e-3) * Math.max(1e-12, Math.abs(b)))) fails.push(what + ': got ' + a + ', expected ' + b);
    }
    function yes(c, what) { n++; if (!c) fails.push(what); }
    if (!G.WTS_tubulars) { if (typeof console !== 'undefined') console.log('[wellkill self-test] skipped (no WTS_tubulars)'); return; }
    var base = { pres: 5400, tvd: 10000, ob: 200, fg: 15, wf: 1.9, ann: 8.6, tub: 'tubing-2.875-6.5', cas: 'casing-7-29',
        pmd: 9800, ptvd: 9620, tmd: 10150, bmd: 10250, pbtd: 10400, to: 'top', od: 10, pump: 0.1, spm: 40 };
    var r = G.WTS_wellkill_compute(base);
    yes(r.ok, 'default ok');
    rel(r.kill.kwf, 5600 / 520, 1e-9, 'KWF'); rel(r.kill.used, 10.8, 1e-12, 'rounded'); rel(r.kill.balance, 5400 / 520, 1e-9, 'balance');
    var K = Math.PI / 4 * 12 / 9702;
    rel(r.bullhead.vol, 2.441 * 2.441 * K * 9800 + 6.184 * 6.184 * K * 350, 1e-9, 'bullhead');
    rel(r.limits.maspStart, 0.052 * (15 - 1.9) * 10000, 1e-9, 'MASP start');
    rel(r.limits.maspEnd, 0.052 * (15 - 10.8) * 10000, 1e-9, 'MASP end');
    rel(r.utube.dp, 0.052 * (10.8 - 8.6) * 9620, 1e-9, 'U-tube');
    var g = G.WTS_gradient_compute({ dir: 's2b', p: 1000, tvd: 5000, gasLen: 0, mixLen: 0, hl: 100, rho: 10, sg: 0.65, t: 150, z: 0.9 });
    rel(g.pBot, 1000 + 0.052 * 10 * 5000, 1e-9, 'liquid column');
    var g2 = G.WTS_gradient_compute({ dir: 'b2s', p: g.pBot, tvd: 5000, gasLen: 1000, mixLen: 1000, hl: 30, rho: 10, sg: 0.7, t: 150, z: 0.9 });
    var g3 = G.WTS_gradient_compute({ dir: 's2b', p: g2.pSurf, tvd: 5000, gasLen: 1000, mixLen: 1000, hl: 30, rho: 10, sg: 0.7, t: 150, z: 0.9 });
    rel(g3.pBot, g.pBot, 1e-9, 'round trip');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[wellkill self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[wellkill self-test] ' + n + '/' + n + ' checks passed');
    }
})();
