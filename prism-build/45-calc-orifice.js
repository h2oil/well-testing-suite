// ════════════════════════════════════════════════════════════════════
// WTS ─ Round-9 plug-in calculator 45 — Orifice Plate Selection
//
// PURPOSE
//   Inverse AGA-3 (roadmap #6). For a target gas rate, meter run ID, line
//   pressure/temperature, gas gravity (+ CO2 / N2 / H2S) and the DP
//   transmitter range, pick the orifice bore that keeps the differential
//   between the low and high % of range (default 20–80 %) at the target
//   rate, with β = d/D inside the AGA-3 RG limits 0.10–0.75. Shows the next
//   plate up and down and the plate-change points (the rates at which each
//   plate reaches the low / high % of range).
//
// METHOD
//   Every rate comes from the host's pure AGA-3 engine
//   window.WTS_aga3_compute (API MPMS 14.3.1 RG flange-tap Cd with Re
//   iteration, Y1 upstream expansion factor, Standing + Wichert-Aziz
//   pseudo-criticals, Dranchuk-Abou-Kassem Z) — the same numbers as the
//   AGA-3 Gas Metering page. Z does not depend on bore or differential, so
//   it is solved once and passed back in (identical value, faster).
//     • Exact bore d*: bisection on d in [0.10·D, 0.75·D] so that the rate
//       at the design differential (default 50 % of range) equals the target.
//     • Differential at the target for a given plate: bisection on hw.
//     • Plate-change points: forward rate at low % and high % of range.
//   Plate list: every 0.125" bore from 0.125" up to the largest bore with
//   β ≤ 0.75 (bores below β 0.10 are dropped). The chosen plate is d*
//   rounded to the nearest 0.125" when that plate keeps the differential
//   inside the window; otherwise the plate inside the window closest to the
//   design %; otherwise (none inside) the nearest plate, flagged ✗.
//   Plate sizes are always shown as decimal inches (1.875", 2.000") — in
//   Metric mode with the mm conversion alongside (1.875" (47.63 mm)).
//
// REFERENCES
//   • AGA Report No. 3 / API MPMS Ch. 14.3.1–14.3.3 (1992+, 2012/2013):
//     orifice equation, RG Cd, β 0.10–0.75, D ≥ 2 in, x1 = hw/(N3·Pf1).
//   • ISO 5167-1/-2 (2003) — flow measurement practice: keep the working
//     differential in the upper part of the transmitter span (the 20–80 %
//     window is common field practice, not a standard requirement).
//
// FIELD UNITS (canonical): rate MSCFD, lengths in, pressure psig / psia,
//   differential inH2O @ 60 °F, temperature °F.
//
// PUBLIC API (window.*)
//   renderOrificeSelect(body)      paint the page into #pgBody
//   calcOrificeSelect()            read DOM → validate → compute → render
//   WTS_orifice_compute(input)     pure; field units in and out, no DOM
//       input  {q, D, Ps, TfF, SG, co2, n2, h2s, urv, lo, hi, des, TbF, Pb}
//              (a legacy `mode` from an earlier build is accepted and ignored)
//       output {ok, errors[], errorIds[], dStar, betaStar, dStarFlag, candidates[],
//               chosen, up, down, table[], verdicts[], warnings[], Z, ...}
//   WTS_state.orifice              last result (in memory only)
//   WTS_calcRegistry.orifice       Round-9 registration
//
// CONVENTIONS: single outer IIFE, 'use strict', no dependencies, no timers,
//   loads without document / WTS_units / drawLineChart / WTS_aga3_compute.
//   Self-test block at the end is stripped by concat-round9.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'op_';

    // ── Page helpers (shared calculator pattern) ─────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
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
    function _nv(v) { return (v === null || v === undefined || v === '') ? NaN : Number(v); }
    function _opt(v, def) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) ? def : Number(v); }
    var STEP = 0.125;   // plate bores in 0.125" increments over the whole range
    // Plate size text: always decimal inches; Metric mode adds the mm conversion.
    function _boreTxt(d, dp) {
        if (d == null || !isFinite(d)) return '—';
        var t = d.toFixed(dp == null ? 3 : dp) + '"';
        return _metric() ? t + ' (' + (d * 25.4).toFixed(dp == null ? 2 : 3) + ' mm)' : t;
    }

    var BETA_MIN = 0.1, BETA_MAX = 0.75;
    var N3 = 27.707;   // inH2O (60 °F) per psi — same constant as the AGA-3 engine

    // ═════════════════════════════════════════════════════════════════
    // PURE COMPUTE — field units
    // ═════════════════════════════════════════════════════════════════
    function compute(inp) {
        inp = inp || {};
        var errors = [], errorIds = [];
        function err(msg, id) { errors.push(msg); errorIds.push(id || null); }
        function fail() { return { ok: false, errors: errors, errorIds: errorIds, verdicts: [], warnings: [], candidates: [], table: [] }; }

        var aga = G.WTS_aga3_compute;
        if (typeof aga !== 'function') { err('The AGA-3 engine (WTS_aga3_compute) is not loaded.', null); return fail(); }

        var q = _nv(inp.q), D = _nv(inp.D), Ps = _nv(inp.Ps), TfF = _nv(inp.TfF), SG = _nv(inp.SG);
        var co2 = _opt(inp.co2, 0), n2 = _opt(inp.n2, 0), h2s = _opt(inp.h2s, 0);
        var urv = _nv(inp.urv), lo = _opt(inp.lo, 20), hi = _opt(inp.hi, 80), des = _opt(inp.des, 50);
        var TbF = _opt(inp.TbF, 60), Pb = _opt(inp.Pb, 14.696);

        if (!(q > 0)) err('Target gas rate must be greater than zero.', P + 'q');
        if (!(D > 0)) err('Meter run internal diameter must be greater than zero.', P + 'D');
        else if (D > 48) err('Meter run internal diameter must not exceed ' + _u(48, 'lengthSmall', 3, 'in', 0) + '.', P + 'D');
        if (!isFinite(Ps) || Ps + 14.696 <= 0) err('Enter a valid static (line) pressure.', P + 'P');
        if (!(TfF > -459.67)) err('Flowing temperature must be above absolute zero.', P + 'T');
        if (!(SG >= 0.5 && SG <= 1.8)) err('Gas specific gravity must be between 0.5 and 1.8.', P + 'SG');
        if (!(co2 >= 0 && co2 <= 100)) err('CO2 must be between 0 and 100 %.', P + 'CO2');
        if (!(n2 >= 0 && n2 <= 100)) err('N2 must be between 0 and 100 %.', P + 'N2');
        if (!(h2s >= 0 && h2s <= 100)) err('H2S must be between 0 and 100 %.', P + 'H2S');
        if (co2 >= 0 && h2s >= 0 && n2 >= 0 && co2 + h2s + n2 > 100) err('CO2 + N2 + H2S must not exceed 100 %.', P + 'CO2');
        if (!(urv > 0)) err('DP transmitter range must be greater than zero.', P + 'urv');
        if (!(lo > 0 && lo < 100)) err('Low limit must be between 0 and 100 % of range.', P + 'lo');
        if (!(hi > 0 && hi <= 100)) err('High limit must be above 0 and at most 100 % of range.', P + 'hi');
        else if (lo > 0 && lo < 100 && !(hi > lo)) err('High limit must be above the low limit.', P + 'hi');
        if (!(des >= lo && des <= hi)) err('Design differential must lie between the low and high limits.', P + 'des');
        if (!(TbF > -459.67)) err('Base temperature must be above absolute zero.', P + 'Tb');
        if (!(Pb > 0)) err('Base pressure must be greater than zero.', P + 'Pb');
        if (errors.length) return fail();

        var base = { D: D, Ps: Ps, TfF: TfF, SG: SG, co2: co2, h2s: h2s, n2: n2, TbF: TbF, Pb: Pb, tap: 'flange' };
        var probe = aga(Object.assign({}, base, { d: D / 2, hw: urv * des / 100 }));
        if (!probe.ok) { probe.errors.forEach(function (m) { err(m, null); }); return fail(); }
        base.Z = probe.Z;   // Z is independent of bore and differential
        var Pf1 = probe.Pf1, hwCap = 0.5 * N3 * Pf1;   // x1 = 0.5: far beyond the Y1 validity (0.2)

        function run(d, hw) { return aga(Object.assign({}, base, { d: d, hw: hw })); }
        function qAt(d, hw) { return run(d, hw).Qmscfd; }
        // Differential that passes q through bore d (bisection on hw; q rises with hw below x1 ≈ 0.57).
        function hwFor(d, qq) {
            if (qAt(d, hwCap) < qq) return Infinity;
            var a = 0, b = hwCap;
            for (var i = 0; i < 100; i++) { var m = (a + b) / 2; if (qAt(d, m) < qq) a = m; else b = m; }
            return (a + b) / 2;
        }

        // Exact bore at the design differential (bisection on d; q rises with d).
        var hwDes = urv * des / 100, dMin = BETA_MIN * D, dMax = BETA_MAX * D;
        var dStar = null, dStarFlag = '';
        if (qAt(dMin, hwDes) > q) dStarFlag = 'low';
        else if (qAt(dMax, hwDes) < q) dStarFlag = 'high';
        else {
            var a = dMin, b = dMax;
            for (var i = 0; i < 100; i++) { var m = (a + b) / 2; if (qAt(m, hwDes) < q) a = m; else b = m; }
            dStar = (a + b) / 2;
        }

        // Candidate plates: every 0.125" bore with β in 0.10–0.75.
        var list = [], tolB = 1e-9;
        for (var k = 1; k * STEP <= BETA_MAX * D * (1 + tolB); k++) if (k * STEP >= BETA_MIN * D * (1 - tolB)) list.push(k * STEP);
        if (!list.length) { err('No 0.125" bore gives β between 0.10 and 0.75 in this meter run.', P + 'D'); return fail(); }

        var hwLo = urv * lo / 100, hwHi = urv * hi / 100;
        var candidates = list.map(function (d) {
            var hw = hwFor(d, q);
            var at = isFinite(hw) ? run(d, hw) : null;
            var pct = hw / urv * 100;
            return {
                d: d, bore: d.toFixed(3), beta: d / D, hw: hw, pct: pct,
                inWindow: isFinite(pct) && pct >= lo - 1e-9 && pct <= hi + 1e-9,
                qLo: qAt(d, hwLo), qHi: qAt(d, hwHi),
                Cd: at ? at.Cd : null, Y1: at ? at.Y1 : null, x1: at ? at.x1 : null, Re: at ? at.Re_D : null
            };
        });

        // Choose.
        var idx = -1, rule = '';
        if (dStar != null) {
            var r8 = Math.round(dStar / STEP) * STEP;
            for (var j = 0; j < candidates.length; j++) if (Math.abs(candidates[j].d - r8) < 1e-9 && candidates[j].inWindow) { idx = j; rule = 'rounded'; }
        }
        if (idx < 0) {
            var best = Infinity;
            candidates.forEach(function (c, j) { if (c.inWindow && Math.abs(c.pct - des) < best) { best = Math.abs(c.pct - des); idx = j; rule = 'window'; } });
        }
        var inWin = idx >= 0;
        if (!inWin) {
            // No plate keeps the differential in the window: take the nearest (in % of range).
            var bestD = Infinity;
            candidates.forEach(function (c, j) {
                var dist = !isFinite(c.pct) ? 1e12 : (c.pct < lo ? lo - c.pct : c.pct - hi);
                if (dist < bestD) { bestD = dist; idx = j; }
            });
            rule = 'nearest';
        }
        var chosen = candidates[idx];
        var up = idx + 1 < candidates.length ? candidates[idx + 1] : null;     // larger bore → lower DP
        var down = idx > 0 ? candidates[idx - 1] : null;                        // smaller bore → higher DP
        var t0 = Math.max(0, idx - 3), t1 = Math.min(candidates.length, idx + 4);
        // Exact DP-vs-rate curves (5 … 100 % of range) for the chart.
        [chosen, up, down].forEach(function (c) {
            if (!c) return;
            c.curve = [];
            for (var k = 1; k <= 20; k++) c.curve.push({ pct: k * 5, q: qAt(c.d, urv * k * 5 / 100) });
        });
        var table = candidates.slice(t0, t1).map(function (c) { return Object.assign({ role: c === chosen ? 'chosen' : (c === up ? 'up' : (c === down ? 'down' : '')) }, c); });

        // Verdicts.
        var verdicts = [];
        function v(level, text) { verdicts.push({ level: level, text: text }); }
        var bTxt = _boreTxt(chosen.d);
        if (inWin) v('ok', '✓ ' + bTxt + ' plate (β ' + chosen.beta.toFixed(3) + ') reads ' + _fmt(chosen.pct, 1) + ' % of range at the target rate — inside ' + _fmt(lo, 0) + '–' + _fmt(hi, 0) + ' %.');
        // Review fix: an exact bore exists inside β 0.10–0.75, so the miss is the
        // 0.125" plate step against a narrow window — not the meter run size.
        else if (dStar != null)
            v('bad', '✗ No 0.125" plate lands inside ' + _fmt(lo, 0) + '–' + _fmt(hi, 0) + ' % of range at the target rate (exact bore ' + _boreTxt(dStar, 4) +
                '; nearest plate ' + bTxt + ' reads ' + (isFinite(chosen.pct) ? _fmt(chosen.pct, 1) + ' %' : 'off scale') + ') — widen the window or change the transmitter range.');
        else if (dStarFlag === 'high' || (isFinite(chosen.pct) === false) || chosen.pct > hi)
            v('bad', '✗ No plate with β ≤ 0.75 keeps the differential below ' + _fmt(hi, 0) + ' % of range at the target rate — use a larger meter run or a higher-range transmitter.');
        else
            v('bad', '✗ No plate with β ≥ 0.10 lifts the differential above ' + _fmt(lo, 0) + ' % of range at the target rate — use a smaller meter run or a lower-range transmitter.');
        if (inWin && chosen.x1 > 0.2) v('warn', '⚠ x1 = hw/(N3·Pf1) is ' + chosen.x1.toFixed(3) + ' at the target rate — above 0.2 the Y1 expansion factor is outside its validated range.');
        else if (hwHi / (N3 * Pf1) > 0.2) v('warn', '⚠ At ' + _fmt(hi, 0) + ' % of range x1 exceeds 0.2 — line pressure is low for this transmitter range.');
        if (D < 2) v('warn', '⚠ Meter run ID is below the AGA-3 minimum of 2 in.');
        if (chosen.beta > 0.6 && inWin) v('warn', '⚠ β above 0.6 needs longer upstream straight lengths (AGA-3 Part 2).');

        return {
            ok: true, errors: [], errorIds: [], step: STEP, rule: rule,
            q: q, D: D, Ps: Ps, TfF: TfF, SG: SG, co2: co2, n2: n2, h2s: h2s, urv: urv, lo: lo, hi: hi, des: des, TbF: TbF, Pb: Pb,
            Z: probe.Z, Pf1: Pf1, Tpr: probe.Tpr, Ppr: probe.Ppr,
            hwDes: hwDes, dStar: dStar, betaStar: dStar != null ? dStar / D : null, dStarFlag: dStarFlag,
            candidates: candidates, chosen: chosen, up: up, down: down, inWindow: inWin, table: table,
            verdicts: verdicts,
            warnings: verdicts.filter(function (x) { return x.level !== 'ok'; }).map(function (x) { return x.text; })
        };
    }
    G.WTS_orifice_compute = compute;

    // ═════════════════════════════════════════════════════════════════
    // PAGE
    // ═════════════════════════════════════════════════════════════════
    var TITLE = 'Orifice Plate Selection';
    var SUB = 'Pick the orifice bore that keeps the differential inside the transmitter range at a target gas rate (inverse AGA-3)';
    var UNITS = { op_q: 'gasRateSmall', op_D: 'lengthSmall', op_P: 'pressureG', op_T: 'temperature', op_urv: 'pressureSmall60', op_Tb: 'temperature', op_Pb: 'pressureBase' };

    function _field(id, label, value, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" step="any" id="' + id + '" value="' + value + '"' + (extra || '') + '></div>';
    }
    function _pageHtml() {
        var h = '<div id="op_root"><div class="cols-2"><div style="min-width:0">';
        h += '<div class="card"><div class="card-title">Target Flow &amp; Meter Run</div><div class="fg">';
        h += _field('op_q', 'Target gas rate (MSCFD)', 5000);
        h += _field('op_D', 'Meter run internal diameter (in)', 4.026);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Operating Conditions</div><div class="fg">';
        h += _field('op_P', 'Static (line) pressure (psig)', 500);
        h += _field('op_T', 'Flowing temperature (°F)', 80);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Gas Composition</div><div class="fg">';
        h += _field('op_SG', 'Gas specific gravity (air = 1)', 0.65, ' min="0.5" max="1.8"');
        h += _field('op_CO2', 'CO2 (%)', 0.5);
        h += _field('op_N2', 'N2 (%)', 1.0);
        h += _field('op_H2S', 'H2S (%)', 0);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">DP Transmitter</div><div class="fg">';
        h += _field('op_urv', 'Transmitter range, 0 to (inH2O)', 200);
        h += _field('op_lo', 'Low limit (% of range)', 20);
        h += _field('op_hi', 'High limit (% of range)', 80);
        h += _field('op_des', 'Design differential (% of range)', 50);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Base Conditions</div><div class="fg">';
        h += _field('op_Tb', 'Base temperature (°F)', 60);
        h += _field('op_Pb', 'Base pressure, absolute (psia)', 14.696);
        h += '</div>';
        h += '<div class="btn-row"><button class="btn btn-primary" id="op_calc" onclick="calcOrificeSelect()">Select Plate</button></div>';
        h += '</div>';
        h += '</div><div style="min-width:0"><div id="op_res"></div></div></div></div>';
        return h;
    }

    function renderOrificeSelect(body) {
        body = body || _byId('pgBody');
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('op_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = e && e.target && e.target.id;
                if (id && id.indexOf(P) === 0) G.calcOrificeSelect();
            });
        }
        G.calcOrificeSelect();
    }
    G.renderOrificeSelect = renderOrificeSelect;

    function _readInputs() {
        return {
            q: _num('op_q'), D: _num('op_D'), Ps: _num('op_P'), TfF: _num('op_T'), SG: _num('op_SG'),
            co2: _num('op_CO2'), n2: _num('op_N2'), h2s: _num('op_H2S'),
            urv: _num('op_urv'), lo: _num('op_lo'), hi: _num('op_hi'), des: _num('op_des'),
            TbF: _num('op_Tb'), Pb: _num('op_Pb')
        };
    }

    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _bore(c) { return _boreTxt(c.d); }
    function _dp(c) { return isFinite(c.hw) ? _u(c.hw, 'pressureSmall60', 1, 'inH2O', 1) + ' — ' + _fmt(c.pct, 1) + ' % of range' : 'above x1 = 0.5 (off scale)'; }
    var VCOL = { ok: 'var(--green)', warn: 'var(--yellow)', bad: 'var(--red)' };

    function _resultsHtml(r) {
        var c = r.chosen, h = '';
        r.verdicts.forEach(function (x) {
            h += '<div style="color:' + (VCOL[x.level] || 'var(--yellow)') + ';margin:6px 0;font-size:13px">' + x.text + '</div>';
        });
        h += '<div class="rbox"><div class="rbox-title">Selected Plate</div>';
        h += _row('Orifice bore', _bore(c));
        h += _row('Beta ratio (d/D)', c.beta.toFixed(4));
        h += _row('Differential at target rate', _dp(c));
        h += _row('Rate at ' + _fmt(r.lo, 0) + ' % of range (change down below)', _u(c.qLo, 'gasRateSmall', 1, 'MSCFD', 0));
        h += _row('Rate at ' + _fmt(r.hi, 0) + ' % of range (change up above)', _u(c.qHi, 'gasRateSmall', 1, 'MSCFD', 0));
        h += _row('Discharge coefficient (Cd)', c.Cd != null ? c.Cd.toFixed(5) : '—');
        h += _row('Expansion factor (Y1)', c.Y1 != null ? c.Y1.toFixed(5) : '—');
        h += _row('Pipe Reynolds number', c.Re != null ? _fmt(c.Re, 0) : '—');
        h += '</div>';
        h += '<div class="rbox"><div class="rbox-title">Exact Bore &amp; Neighbours</div>';
        h += _row('Exact bore at ' + _fmt(r.des, 0) + ' % of range', r.dStar != null ? _boreTxt(r.dStar, 4) + ' (β ' + r.betaStar.toFixed(4) + ')' :
            (r.dStarFlag === 'high' ? 'above β 0.75' : 'below β 0.10'));
        h += _row('Next plate up (larger bore)', r.up ? _bore(r.up) + ' — ' + (isFinite(r.up.pct) ? _fmt(r.up.pct, 1) + ' % of range' : 'off scale') : 'none within β 0.75');
        h += _row('Next plate down (smaller bore)', r.down ? _bore(r.down) + ' — ' + (isFinite(r.down.pct) ? _fmt(r.down.pct, 1) + ' % of range' : 'off scale') : 'none within β 0.10');
        h += _row('Z-factor (DAK)', r.Z.toFixed(4));
        h += _row('Flowing pressure Pf1', _u(r.Pf1, 'pressure', 1, 'psia', 0));
        h += '</div>';
        // Plate-change table (values written already converted)
        var ql = _lab('gasRateSmall', 'MSCFD'), dl = _lab('pressureSmall60', 'inH2O'), bl = _metric() ? 'in (mm)' : 'in';
        h += '<div class="rbox"><div class="rbox-title">Plate-Change Points</div><div style="overflow-x:auto"><table class="dtable"><thead><tr>' +
            '<th>Plate</th><th>Bore, ' + bl + '</th><th>β</th>' +
            '<th data-wts-unit-label="pressureSmall60">DP at target (' + dl + ')</th><th>% of range</th>' +
            '<th data-wts-unit-label="gasRateSmall">Rate at ' + _fmt(r.lo, 0) + ' % (' + ql + ')</th>' +
            '<th data-wts-unit-label="gasRateSmall">Rate at ' + _fmt(r.hi, 0) + ' % (' + ql + ')</th></tr></thead><tbody>';
        var ROLE = { chosen: 'Selected', up: 'Next up', down: 'Next down' };
        r.table.forEach(function (t) {
            var bd = t.d.toFixed(3) + (_metric() ? ' (' + (t.d * 25.4).toFixed(2) + ')' : '');
            h += '<tr' + (t.role === 'chosen' ? ' style="font-weight:600"' : '') + '><td>' + (ROLE[t.role] || '') + '</td><td>' + bd + '</td><td>' + t.beta.toFixed(3) + '</td><td>' +
                (isFinite(t.hw) ? _fmt(_dv(t.hw, 'pressureSmall60'), 1) : '&gt; scale') + '</td><td>' + (isFinite(t.pct) ? _fmt(t.pct, 1) : '—') + '</td><td>' +
                _fmt(_dv(t.qLo, 'gasRateSmall'), 0) + '</td><td>' + _fmt(_dv(t.qHi, 'gasRateSmall'), 0) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
        h += '<div class="chart-wrap"><canvas id="op_chart" width="600" height="320"></canvas></div>';
        h += '<div><b>Notes</b> Rates use the AGA-3 page engine (flange taps, RG Cd, DAK Z with Standing + Wichert-Aziz pseudo-criticals; N2 is recorded but not in the Z correction). ' +
            'Plate list: every 0.125" bore from 0.125" to the largest bore with β ≤ 0.75; the exact bore is rounded to the nearest 0.125" — confirm the plates on site.' +
            ' The 20–80 % window is field practice. Standard volumes are at the entered base conditions (they follow the header "Std" setting until you type your own).</div>';
        return h;
    }

    function _drawChart(r) {
        var cv = _byId('op_chart');
        if (!cv || typeof drawLineChart !== 'function') return;
        var colors = { down: '#58a6ff', chosen: '#f0883e', up: '#3fb950' };
        var ds = [], qMax = 0;
        [['down', r.down], ['chosen', r.chosen], ['up', r.up]].forEach(function (p) {
            var c = p[1]; if (!c) return;
            var pts = (c.curve || []).map(function (pt) { qMax = Math.max(qMax, pt.q); return { x: _dv(pt.q, 'gasRateSmall'), y: pt.pct }; });
            pts.sort(function (a, b) { return a.x - b.x; });
            ds.push({ label: (p[0] === 'chosen' ? 'Selected ' : p[0] === 'up' ? 'Next up ' : 'Next down ') + _boreTxt(c.d), color: colors[p[0]], data: pts, points: false, width: 2 });
        });
        var xm = _dv(qMax, 'gasRateSmall');
        ds.push({ label: _fmt(r.lo, 0) + ' % limit', color: '#8b949e', data: [{ x: 0, y: r.lo }, { x: xm, y: r.lo }], points: false, dash: [6, 4], width: 1 });
        ds.push({ label: _fmt(r.hi, 0) + ' % limit', color: '#8b949e', data: [{ x: 0, y: r.hi }, { x: xm, y: r.hi }], points: false, dash: [6, 4], width: 1 });
        ds.push({ label: 'Target rate', color: '#d2a8ff', data: [{ x: _dv(r.q, 'gasRateSmall'), y: 0 }, { x: _dv(r.q, 'gasRateSmall'), y: 100 }], points: false, dash: [3, 3], width: 1 });
        try {
            drawLineChart(cv, ds, { xLabel: 'Gas rate (' + _lab('gasRateSmall', 'MSCFD') + ')', yLabel: 'DP (% of range)', xMin: 0, yMin: 0, yMax: 100, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _calcImpl() {
        var res = _byId('op_res'), root = _byId('op_root');
        if (root && root.querySelectorAll) {
            var all = root.querySelectorAll('input, select');
            for (var i = 0; i < all.length; i++) if (all[i].classList) all[i].classList.remove('input-err');
        }
        var inp = _readInputs();
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.orifice = { ok: false, errors: r.errors.slice(), d: null, ts: Date.now() };
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                    r.errors.map(function (m) { return '<li>' + m + '</li>'; }).join('') + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            r.errorIds.forEach(function (id) { var e = id && _byId(id); if (e && e.classList) e.classList.add('input-err'); });
            return r;
        }
        var c = r.chosen;
        function brief(x) { return x ? { d: x.d, bore: x.bore, beta: x.beta, hw: x.hw, pct: x.pct, qLo: x.qLo, qHi: x.qHi } : null; }
        G.WTS_state.orifice = {
            ok: true, inWindow: r.inWindow, q: r.q, D: r.D, urv: r.urv, lo: r.lo, hi: r.hi,
            d: c.d, bore: c.bore, beta: c.beta, hw: c.hw, pct: c.pct, qLo: c.qLo, qHi: c.qHi, Cd: c.Cd,
            dStar: r.dStar, Z: r.Z, up: brief(r.up), down: brief(r.down), ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            _drawChart(r);
            res.setAttribute('data-done', '1');
        }
        return r;
    }
    G.calcOrificeSelect = function () { return _canon(_calcImpl); };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('op_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcOrificeSelect();
        });
    }

    // ── Round-9 registration (merge, never replace) ──────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.orifice = {
        key: 'orifice',
        title: TITLE,
        navTitle: 'Orifice Plate Selection',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9678;',
        badge: 'Metering',
        bc: 'dc-b-blue',
        desc: 'Inverse AGA-3: the plate bore that keeps DP between 20 % and 80 % of the transmitter range at a target rate, with plate-change points.',
        render: function (body) { G.renderOrificeSelect(body); }
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var f = G.WTS_orifice_compute;
    if (typeof G.WTS_aga3_compute !== 'function') return;   // host engine not present standalone
    var fails = [], checks = 0;
    function ok(c, what) { checks++; if (!c) fails.push(what); }
    function rel(a, b, tol, what) { checks++; if (!(isFinite(a) && Math.abs(a - b) <= tol * Math.abs(b))) fails.push(what + ': got ' + a + ', want ' + b); }
    var r = f({ q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0, urv: 200 });
    ok(r.ok && r.inWindow, 'default in window');
    ok(r.chosen.pct >= 20 && r.chosen.pct <= 80, 'default pct');
    rel(G.WTS_aga3_compute({ D: 4.026, d: r.chosen.d, hw: r.chosen.hw, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5 }).Qmscfd, 5000, 1e-8, 'DP → q');
    ok(!f({ q: 0, D: 4 }).ok, 'q = 0 rejected');
    var msg = '[45-calc-orifice] self-test: ' + (checks - fails.length) + '/' + checks + ' checks pass';
    if (fails.length) throw new Error(msg + '\n  ' + fails.join('\n  '));
})();
