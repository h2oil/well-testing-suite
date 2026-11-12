// =============================================================================
// WTS — 49-calc-wp-esp.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance — electrical submersible pump (B, WP26). docs/WELL-PERFORMANCE-PLAN.md §7.3, §1.3 US17, §3.5, §6.1, §9, §15.1,
// §16, D3, D9, D17. Engine only: no storage, no DOM, no timers. Field units (§3.0): psia inside, ft, °F, bbl/d, hp, V, A.
//
// THE PUMP NODE. In the system solve (WTS_wp_system, M.lift.type 'esp') the pump is a node Δp(q) between the intake segment (the
// mid-perforations up to the pump setting depth, formation fluid) and the discharge segment (the pump up to the wellhead, the stream
// the pump ingests). Both segments are marched by the ONE marcher (WTS_wp_vlp.traverse on WTS_flowline_march, D3) on the deviated
// path; this file supplies the pump: prepare() (the setting and the equipment) and pump() (the stage-by-stage pressure rise at one
// rate from the intake pressure the inflow delivers). The solver does the roots, the stability and the operating point.
//
// PUMP CURVE. A user table at the base frequency f0 (default 60 Hz): rate (bbl/d, in situ), head per stage (ft), efficiency (%) and
// BHP per stage (hp, water); a monotone cubic (Fritsch-Carlson) through the rows, the head continued linearly past the last row (a
// negative head = the pump is a restriction; the curve stays continuous for the root search). Missing efficiency → from the BHP
// column (η = q·H / (135,770·BHP)); missing BHP → from the efficiency. The best-efficiency point (BEP) = the efficiency maximum.
// Recommended operating range at f0: the table's qMin / qMax, else 70 % / 130 % of the BEP rate (an assumption, stated).
//   Affinity laws (exact for a centrifugal pump at a fixed impeller): q ∝ f, H ∝ f², P ∝ f³ — the 60 Hz water curve is mapped to f.
//   Stages: TDH / head per stage (sizeStages; the system's required pressure rise at a target rate over the pump's own rise).
//
// VISCOSITY (Turzo, Takacs & Zsuga 2000; a closed-form fit of the Hydraulic Institute charts), provisional (D17: coefficients as
//   published in the fit, to verify against the paper — Q9): with the BEP rate Q (gpm) and head H (ft per stage) at the operating
//   frequency and ν (cSt) at the intake,
//     y  = −112.1374 + 6.6504 ln H + 12.8429 ln Q,   Q* = exp[(39.5276 + 26.5605 ln ν − y) / 51.6565]
//     C_Q = 1 − 4.0327e-3 Q* − 1.724e-4 Q*²,   C_η = 1 − 3.3075e-2 Q* + 2.8875e-4 Q*²
//     C_H at 0.6 / 0.8 / 1.0 / 1.2 Q_BEP = 1 − 3.68e-3 Q* − 4.36e-5 Q*² / 1 − 4.4723e-3 Q* − 4.18e-5 Q*² / 1 − 7.00763e-3 Q* − 1.41e-5 Q*²
//                                          / 1 − 9.01e-3 Q* + 1.31e-5 Q*² (linear between, constant outside)
//   Each factor is divided by its value at ν = 1 cSt (water), so a water curve is returned unchanged (a deliberate normalisation:
//   the catalogue curve is a water curve); factors are clamped to [0.1, 1]; beyond Q* = 40 (the charts end, the polynomials
//   turn back) the factors are held at their Q* = 40 values and the point is flagged as outside the charts.
//
// GAS AT THE INTAKE. Free gas at the intake pressure and temperature (the fluid engine's free gas). Natural separation after
//   Alhanati (1993) in the simplified form E_n = v∞ / (v∞ + v_SL): v∞ = 1.53 [g σ (ρ_L − ρ_G) / ρ_L²]^¼ (Harmathy 1960 bubble rise),
//   v_SL = in-situ liquid rate / the casing-to-pump annulus; a rotary gas separator of efficiency E_s in series: E = 1 − (1 − E_n)(1 − E_s).
//   The separated gas goes up the annulus and rejoins the stream at the wellhead (the choke and flowline carry the full stream); the
//   discharge segment carries the formation stream less the vented gas. Gas handling (Turpin, Lea & Bearden 1986): φ = 2000 (V_g / V_L)
//   / (3 p_intake) with the in-situ volumes after separation, p psia; φ > 1 → gas interference expected. Both provisional (D17).
//
// STAGE BY STAGE. The pump is marched in ≤ 20 groups of stages: at each group the in-situ volume rate (liquid + ingested free gas,
//   homogeneous, gas dissolving as the pressure rises), the mixture density, the head per stage at that rate (affinity + viscosity),
//   Δp = ρ_mix · H · n / 144 (midpoint rule), hydraulic hp = Q · H · n · SG / 135,770 and BHP = hydraulic hp / η. TDH = Δp · 144 /
//   ρ̄ (the mean density through the pump). The temperature rise through the pump is not modelled.
//
// MOTOR AND CABLE (basics, provisional; the host's electrical engines are not exported, so this file computes them): motor power,
//   voltage and current at f = nameplate × f / f0 (constant V/Hz); load = pump BHP / available power; current ≈ nameplate current ×
//   load (a linear estimate); cable copper resistance per gauge at 20 °C (Ω/1,000 ft: 1/0 0.0983, 1 0.1239, 2 0.1563, 4 0.2485, 6
//   0.3951) at the mean cable temperature (α = 0.00393 /°C); ΔV = √3 · I · R · L; surface voltage = motor voltage + ΔV; surface kVA.
//   Motor cooling: the velocity of the whole intake stream past the motor (casing-to-motor annulus) ≥ 1 ft/s.
//
// FLAGS (R.lift.flags, ✓ / ⚠ / ✗ on the page): operating range (downthrust left of the range, upthrust right of it), gas
//   interference (φ), intake gas volume fraction (> 10 % warn), motor load (> 100 % fail, > 90 % warn, < 50 % info), cable drop (> 5 %
//   warn), motor cooling (< 1 ft/s warn), pump below the perforations (no flow past the motor), dogleg at the setting depth (> 3°/100 ft
//   over the pump and motor), viscosity outside the charts.
//
// Interfaces (every result {ok, errors[], warnings[{code, msg, sev}]}; nothing throws for user data):
//   WTS_wp_esp
//     .example()                 a generic example pump record (60 Hz, ≈ 1,500 bbl/d BEP; not any catalogue pump)
//     .normPump(rec)             → {ok, pump:{name, f0, rows, q[], h[], eff[], bhp[], qMax, bep:{q, h, eff}, range:{qMin, qMax, assumed}, od}, …}
//     .curve(pump, f, nu?)       → {head(Q), eff(Q), bhp(Q, sg), range:{qMin, qMax}, bep, visc, f}  per stage, at f and ν (cSt)
//     .fan(pump, freqs, stages, nu?) → [{f, pts:[[Q, H_total]], range, bep}]   (the frequency fan of the total head)
//     .turzo(qBep_bpd, hBep_ft, nu) → {CQ, CE, CH:[c0.6, c0.8, c1.0, c1.2], Qstar, outside, normalised}
//     .natSep({qL, casingId, od, rhoL, rhoG, sigma}) → {E, vInf, vSL}   (qL ft³/s, in; lbm/ft³, dyn/cm)
//     .turpin(qG, qL, p)         → φ
//     .prepare(M, W)             → P = {ok, md, tvd, inc, dls, f, N, pump, sepEff, natSep, visc, od, casingId, motor, cable, warnings}
//     .pump(P, F, q, pInt, T)    → {ok, pInt, pDis, dp, Qin, Qout, gvfIn, phi, En, E, ventMscfd, qIng, nu, visc, hIn, tdh, rho,
//                                   hydHp, bhp, eff, range, rangeStatus, groups}
//     .motor(P, st, {T_pump, T_surf}) → {ok, hpAvail, load, amps, vMotor, cable:{len, awg, R, dV, pct}, vSurf, kva, vCool, flags}
//     .flags(P, st, mo)          → [{code, msg, sev:'ok'|'info'|'warn'|'fail', field}]
//     .sizeStages(M, q)          → {ok, stages, q, tdh, dpNeed, dpPerStage, hPerStage, evals}   (two evaluations at the target rate)
//     .sweep(M, {freqs})         → Job: result() → {ok, rows:[{f, ok, q, qL, pwf, pInt, Qin, rangeStatus, load, gvf, phi, stable}], evals}
//     .METHODS, .PROVISIONAL, .VERSION
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var VERSION = '4.5-wp26';
    var PROVISIONAL = 'provisional — not verified against a published example';
    var PATM = 14.696, BBL_FT3 = 5.614583, HHP = 135770, RHO_W = 62.428;
    var MAX_GROUPS = 20, MAX_ROWS = 40;
    var CU_R20 = { '1/0': 0.0983, '1': 0.1239, '2': 0.1563, '4': 0.2485, '6': 0.3951 };   // Ω / 1,000 ft, copper, 20 °C
    var METHODS = {
        affinity: { key: 'affinity', label: 'Affinity laws (q ∝ f, H ∝ f², P ∝ f³)', verified: true, note: 'exact similarity relations' },
        turzo: { key: 'turzo', label: 'Turzo, Takacs & Zsuga (2000) viscosity correction', verified: false },
        alhanati: { key: 'alhanati', label: 'Natural gas separation after Alhanati (1993)', verified: false },
        turpin: { key: 'turpin', label: 'Turpin, Lea & Bearden (1986) gas-handling criterion', verified: false },
        motor: { key: 'motor', label: 'Motor load and cable voltage drop (basics)', verified: false }
    };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev, field) { var o = { code: code, msg: String(msg).slice(0, 299), sev: sev || 'warn' }; if (field) o.field = field; return o; }
    function _clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function _f(x, dp) {
        if (!_fin(x)) return '–';
        var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
        var p = s.split('.'), ip = p[0], out = '';
        while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
        return (neg ? '−' : '') + ip + out + (p[1] ? '.' + p[1] : '');
    }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

    // ── monotone cubic (Fritsch-Carlson) with linear continuation past the ends ──
    function _pchip(xs, ys) {
        var n = xs.length, h = [], d = [], m = new Array(n), i;
        for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
        if (n === 1) return function () { return ys[0]; };
        if (n === 2) return function (x) { return ys[0] + d[0] * (x - xs[0]); };
        var end = function (h0, h1, d0, d1) { var s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1); if (s * d0 <= 0) s = 0; else if (d0 * d1 <= 0 && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0; return s; };
        m[0] = end(h[0], h[1], d[0], d[1]); m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
        for (i = 1; i < n - 1; i++) { if (d[i - 1] * d[i] <= 0) m[i] = 0; else { var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); } }
        return function (x) {
            if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
            if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
            var k = 0; while (k < n - 2 && x > xs[k + 1]) k++;
            var t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
            return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
        };
    }

    // ── the example pump (generic, synthetic; not a catalogue pump) ──────────
    function example() {
        var rows = [], qMax = 2900;
        [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700].forEach(function (q) {
            var x = q / qMax, h = 31 * (1 - x * x) - 1.5 * x, eff = 64 * (1 - Math.pow((q - 1550) / 1550, 2));
            eff = Math.max(0, eff);
            var bhp = q > 0 && eff > 0 ? q * h / (HHP * eff / 100) : 0.17;
            rows.push([q, +h.toFixed(2), +eff.toFixed(1), +bhp.toFixed(3)]);
        });
        return { v: 1, name: 'Example pump (generic, 60 Hz)', f0: 60, rows: rows, qMin: 1000, qMax: 2100, od_in: 4.0, example: true };
    }

    // ── the pump record ───────────────────────────────────────────────────────
    function normPump(rec) {
        var out = { ok: false, errors: [], warnings: [] };
        if (!rec || typeof rec !== 'object') { out.code = 'NEEDS_PUMP'; out.errors.push('ESP: enter the pump curve (step ④: a table of rate, head per stage and efficiency, or the example pump).'); return out; }
        var rows = (Array.isArray(rec.rows) ? rec.rows : []).filter(Array.isArray).map(function (r) { return [_n(r[0]), _n(r[1]), _n(r[2]), _n(r[3])]; })
            .filter(function (r) { return _fin(r[0]) && r[0] >= 0 && _fin(r[1]); }).sort(function (a, b) { return a[0] - b[0]; }).slice(0, MAX_ROWS);
        rows = rows.filter(function (r, i) { return i === 0 || r[0] > rows[i - 1][0]; });
        if (rows.length < 3) { out.code = 'NEEDS_PUMP'; out.errors.push('ESP: the pump curve needs at least three rows of rate and head per stage.'); return out; }
        if (!(rows[0][1] > 0)) { out.code = 'BAD_PUMP'; out.errors.push('ESP: the head per stage at the first rate must be above zero.'); return out; }
        var f0 = _n(rec.f0); if (!(f0 >= 30 && f0 <= 90)) f0 = 60;
        var effCol = rows.every(function (r) { return !_fin(r[2]) || r[2] <= 1.0001; }) && rows.some(function (r) { return _fin(r[2]) && r[2] > 0; }) ? 100 : 1;
        var q = rows.map(function (r) { return r[0]; }), h = rows.map(function (r) { return r[1]; });
        var eff = rows.map(function (r) { return _fin(r[2]) ? r[2] * effCol / 100 : null; }), bhp = rows.map(function (r) { return _fin(r[3]) && r[3] > 0 ? r[3] : null; });
        // fill: efficiency from BHP, BHP from efficiency (water, SG 1)
        for (var i = 0; i < rows.length; i++) {
            if (eff[i] == null && bhp[i] != null) eff[i] = q[i] > 0 ? Math.max(0, q[i] * h[i] / (HHP * bhp[i])) : 0;
            if (bhp[i] == null && eff[i] != null && eff[i] > 0 && q[i] > 0) bhp[i] = q[i] * h[i] / (HHP * eff[i]);
        }
        if (eff.some(function (e) { return e == null; })) { out.code = 'BAD_PUMP'; out.errors.push('ESP: every row needs an efficiency or a BHP per stage.'); return out; }
        if (eff.some(function (e) { return e > 0.95; })) out.warnings.push(_w('PUMP_EFF', 'ESP: an efficiency above 95 % in the pump table — check the column is in %.'));
        if (bhp.some(function (b) { return b == null; })) {
            // the shut-in BHP: extrapolated from the next two rows
            for (var j = 0; j < bhp.length; j++) if (bhp[j] == null) { var a = bhp.slice(j + 1).filter(_fin); bhp[j] = a.length ? a[0] * 0.5 : 0.1; }
        }
        for (var k = 1; k < h.length; k++) if (h[k] > h[k - 1] * 1.02) { out.warnings.push(_w('PUMP_RISING', 'ESP: the head per stage rises with rate between ' + _f(q[k - 1]) + ' and ' + _f(q[k]) + ' bbl/d (an unstable branch of the curve).', 'info')); break; }
        var hF = _pchip(q, h), eF = _pchip(q, eff), bF = _pchip(q, bhp);
        // BEP: the efficiency maximum on a fine grid
        var bep = { q: q[0], eff: -1 };
        for (var s = 0; s <= 400; s++) { var qq = q[0] + (q[q.length - 1] - q[0]) * s / 400, ee = eF(qq); if (ee > bep.eff) bep = { q: qq, eff: ee }; }
        bep.h = hF(bep.q);
        var qMin = _n(rec.qMin), qMax = _n(rec.qMax), assumed = false;
        if (!(qMin > 0 && qMax > qMin)) { qMin = 0.7 * bep.q; qMax = 1.3 * bep.q; assumed = true; }
        out.ok = true;
        out.pump = { name: String(rec.name == null ? 'Pump' : rec.name).slice(0, 48), f0: f0, rows: rows.map(function (r, i2) { return [q[i2], h[i2], eff[i2] * 100, bhp[i2]]; }),
            q: q, h: h, eff: eff, bhp: bhp, qTab: q[q.length - 1], bep: bep, range: { qMin: qMin, qMax: qMax, assumed: assumed }, od: _n(rec.od_in) > 2 ? _n(rec.od_in) : null,
            example: rec.example === true, _h: hF, _e: eF, _b: bF };
        if (assumed) out.warnings.push(_w('PUMP_RANGE_ASSUMED', 'ESP: no recommended range in the pump table — 70 % to 130 % of the best-efficiency rate (' + _f(qMin) + '–' + _f(qMax) + ' bbl/d at ' + f0 + ' Hz) is assumed.', 'info'));
        return out;
    }

    // ── Turzo, Takacs & Zsuga (2000) viscosity correction factors ───────────
    function _turzoRaw(qGpm, hFt, nu) {
        var y = -112.1374 + 6.6504 * Math.log(hFt) + 12.8429 * Math.log(qGpm);
        var Qs = Math.exp((39.5276 + 26.5605 * Math.log(Math.max(nu, 1e-6)) - y) / 51.6565);
        return { Qs: Qs, CQ: 1 - 4.0327e-3 * Qs - 1.724e-4 * Qs * Qs, CE: 1 - 3.3075e-2 * Qs + 2.8875e-4 * Qs * Qs,
            CH: [1 - 3.68e-3 * Qs - 4.36e-5 * Qs * Qs, 1 - 4.4723e-3 * Qs - 4.18e-5 * Qs * Qs, 1 - 7.00763e-3 * Qs - 1.41e-5 * Qs * Qs, 1 - 9.01e-3 * Qs + 1.31e-5 * Qs * Qs] };
    }
    function turzo(qBep_bpd, hBep_ft, nu) {
        var one = { CQ: 1, CE: 1, CH: [1, 1, 1, 1], Qstar: null, outside: false, normalised: true };
        if (!(qBep_bpd > 0) || !(hBep_ft > 0) || !(nu > 1)) return one;
        // the fit is used up to Q* = 40 (the extent of the charts; its polynomials turn back beyond): constant there, flagged
        var qg = qBep_bpd * 42 / 1440, a = _turzoRaw(qg, hBep_ft, nu), w = _turzoRaw(qg, hBep_ft, 1);
        if (a.Qs > 40) { var Qs0 = a.Qs, nu40 = Math.exp(Math.log(40) * 51.6565 / 26.5605 - (39.5276 - (-112.1374 + 6.6504 * Math.log(hBep_ft) + 12.8429 * Math.log(qg))) / 26.5605); a = _turzoRaw(qg, hBep_ft, nu40); a.QsTrue = Qs0; }
        var cl = function (v, v0) { return _clamp(v0 > 0 ? v / v0 : v, 0.1, 1); };
        return { CQ: cl(a.CQ, w.CQ), CE: cl(a.CE, w.CE), CH: a.CH.map(function (c, i) { return cl(c, w.CH[i]); }), Qstar: a.QsTrue || a.Qs, outside: !!a.QsTrue, normalised: true };
    }
    function _chAt(CH, x) {   // x = Q / Q_BEP (corrected); the four chart points 0.6, 0.8, 1.0, 1.2, linear between, constant outside
        var X = [0.6, 0.8, 1.0, 1.2];
        if (x <= X[0]) return CH[0]; if (x >= X[3]) return CH[3];
        for (var i = 0; i < 3; i++) if (x <= X[i + 1]) return CH[i] + (CH[i + 1] - CH[i]) * (x - X[i]) / (X[i + 1] - X[i]);
        return CH[3];
    }

    // ── the stage curve at a frequency and viscosity ─────────────────────────
    function curve(pump, f, nu) {
        var P = pump && pump._h ? pump : (normPump(pump).pump || null);
        if (!P) return null;
        var r = (_fin(f) && f > 0 ? f : P.f0) / P.f0;
        var vf = turzo(P.bep.q * r, P.bep.h * r * r, _fin(nu) ? nu : 1), CQ = vf.CQ, CE = vf.CE, qb = P.bep.q * r * CQ;
        var head = function (Q) { var Qw = Math.max(0, Q) / r / CQ; return r * r * _chAt(vf.CH, Q / qb) * P._h(Qw); };
        var eff = function (Q) { var Qw = Math.max(0, Q) / r / CQ; return Math.max(0, CE * P._e(Qw)); };
        var bhp = function (Q, sg) { var e = eff(Q), H = head(Q); return (Q > 0 && e > 0.02) ? Q * Math.max(H, 0) * (sg || 1) / (HHP * e) : r * r * r * P._b(0) * (sg || 1); };
        return { f: r * P.f0, ratio: r, head: head, eff: eff, bhp: bhp, visc: vf, bep: { q: qb, h: head(qb), eff: eff(qb) },
            range: { qMin: P.range.qMin * r * CQ, qMax: P.range.qMax * r * CQ, assumed: P.range.assumed }, qZero: _zeroHead(head, P.qTab * r * CQ * 1.6) };
    }
    function _zeroHead(head, hi) {   // the rate where the head reaches zero (bisection), else the table end
        var a = 0, b = hi; if (head(b) > 0) return b;
        for (var i = 0; i < 50; i++) { var m = 0.5 * (a + b); if (head(m) > 0) a = m; else b = m; }
        return 0.5 * (a + b);
    }
    function fan(pump, freqs, stages, nu) {
        var N = _fin(stages) && stages > 0 ? stages : 1;
        return (freqs || [40, 45, 50, 55, 60, 65, 70]).map(function (f) {
            var c = curve(pump, f, nu); if (!c) return null;
            var pts = [], n = 40;
            for (var i = 0; i <= n; i++) { var Q = c.qZero * i / n; pts.push([Q, Math.max(0, c.head(Q)) * N]); }
            return { f: f, pts: pts, range: c.range, bep: { q: c.bep.q, h: c.bep.h * N } };
        }).filter(Boolean);
    }

    // ── gas at the intake ─────────────────────────────────────────────────────
    function natSep(o) {
        o = o || {};
        var Dc = _n(o.casingId), Dp = _n(o.od), qL = _n(o.qL), rL = _n(o.rhoL), rG = _n(o.rhoG), sig = _n(o.sigma);
        if (!(Dc > 0 && Dp > 0 && Dc > Dp && qL >= 0 && rL > 0 && rG >= 0 && rL > rG && sig > 0)) return { E: 0, vInf: null, vSL: null, ok: false };
        var A = Math.PI / 4 * (Dc * Dc - Dp * Dp) / 144, vSL = qL / A;
        // Harmathy (1960) in SI, then ft/s: σ N/m, ρ kg/m³
        var vInf = 1.53 * Math.pow(9.81 * sig * 1e-3 * (rL - rG) * 16.0185 / Math.pow(rL * 16.0185, 2), 0.25) / 0.3048;
        return { E: vInf / (vInf + vSL), vInf: vInf, vSL: vSL, ok: true };
    }
    function turpin(qG, qL, p) { return (qL > 0 && p > 0) ? 2000 * (qG / qL) / (3 * p) : (qG > 0 ? Infinity : 0); }

    // ── the setting and the equipment ─────────────────────────────────────────
    function _casingAt(strings, md) {
        var best = null;
        (strings || []).forEach(function (s) { if (s && (s.kind === 'casing' || s.kind === 'liner') && +s.topMd <= md + 1e-6 && +s.botMd >= md - 1e-6 && +s.id > 0 && (best == null || +s.id < best)) best = +s.id; });
        return best;
    }
    function prepare(M, W) {
        var e = (M && M.lift && M.lift.esp) || {}, out = { ok: false, errors: [], warnings: [] };
        if (!W || !W.ok || !W.nodes) { out.code = 'NEEDS_WELL'; out.errors.push('ESP: the well path is needed (step ③).'); return out; }
        var np = normPump(e.pump);
        out.warnings = out.warnings.concat(np.warnings || []);
        if (!np.ok) { out.code = np.code || 'NEEDS_PUMP'; out.errors = np.errors; return out; }
        var mid = +W.nodes.midPerfMd, shoe = _fin(W.nodes.tubingShoeMd) ? +W.nodes.tubingShoeMd : null;
        var md = _n(e.pumpMd), dflt = (shoe != null && shoe < mid - 1) ? shoe : Math.max(0, mid - 100);
        if (!(md > 0)) { md = dflt; out.mdDefault = true; }
        if (md > mid - 1) { out.warnings.push(_w('ESP_BELOW_PERFS', 'ESP: the pump is set at or below the mid-perforations; the intake is taken at ' + _f(Math.max(0, mid - 1)) + ' ft MD (a pump below the perforations needs a shroud for motor cooling).', 'warn', 'wp_esp_md')); md = Math.max(0, mid - 1); out.belowPerfs = true; }
        if (shoe != null && md > shoe + 1) { out.warnings.push(_w('ESP_BELOW_SHOE', 'ESP: the pump is set ' + _f(md - shoe) + ' ft below the end of the tubing; the tubing is taken down to the pump.', 'info', 'wp_esp_md')); }
        var f = _n(e.freq); if (f == null) f = 60;
        if (!(f >= 30 && f <= 90)) { out.code = 'ESP_FREQ'; out.errors.push('ESP: the frequency must be between 30 and 90 Hz.'); return out; }
        var N = _n(e.stages);
        if (!(N >= 1)) { out.code = 'NEEDS_STAGES'; out.errors.push('ESP: enter the number of stages (or size them for a target rate in step ④).'); return out; }
        N = Math.round(N);
        var sep = _n(e.sepEff); sep = _fin(sep) ? _clamp(sep, 0, 0.99) : 0;
        var od = _n(e.od_in); if (!(od > 2 && od < 12)) od = np.pump.od || 4.0;
        var at = typeof W.at === 'function' ? W.at(md) : null, st = (W.stations || []).filter(function (s) { return s.md >= md - 100 && s.md <= md + 150; });
        var dls = st.reduce(function (a, s) { return Math.max(a, +s.dls || 0); }, 0);
        var mo = e.motor || {}, cb = e.cable || {};
        var awg = String(cb.awg == null || cb.awg === '' ? '2' : cb.awg); if (!CU_R20[awg]) awg = '2';
        out.ok = true; out.errors = [];
        out.md = md; out.tvd = typeof W.tvdAt === 'function' ? W.tvdAt(md) : md; out.inc = at && _fin(at.inc) ? at.inc : null; out.dls = dls;
        out.f = f; out.N = N; out.pump = np.pump; out.sepEff = sep; out.natSep = e.natSep === true; out.visc = e.visc === true;   // D17 (review fix v4.5): both provisional → opt-in, never a default
        out.od = od;
        out.casingId = _casingAt(M.well && M.well.strings, md);
        out.motor = { hp: _n(mo.hp), volt: _n(mo.volt), amp: _n(mo.amp) };
        out.cable = { awg: awg, len: _n(cb.len_ft) > 0 ? _n(cb.len_ft) : md + 100, lenDefault: !(_n(cb.len_ft) > 0) };
        if (out.natSep && !(out.casingId > od)) out.warnings.push(_w('ESP_NO_CASING', 'ESP: no casing around the pump at ' + _f(md) + ' ft MD in the strings table — natural gas separation is not applied.', 'info'));
        return out;
    }

    // ── the pump at one rate ───────────────────────────────────────────────────
    function _vol(s) { return { qL: s.qL, qG: s.qG, Q: (s.qL + s.qG) * 86400 / BBL_FT3, rho: (s.qL + s.qG) > 0 ? (s.qL * s.rhoL + s.qG * s.rhoG) / (s.qL + s.qG) : s.rhoL }; }
    function pump(P, F, q, pInt, T, o) {
        o = o || {};
        if (!P || !P.ok || !F || typeof F.at !== 'function') return { ok: false, code: 'NO_PUMP', errors: ['ESP: the pump is not prepared'], warnings: [] };
        if (!(pInt > 1)) return { ok: false, code: 'NO_INTAKE', errors: ['ESP: no intake pressure'], warnings: [] };
        var WF = G.WTS_wp_fluid, s0 = F.at(pInt, T, q);
        if (!s0 || !_fin(s0.qL)) return { ok: false, code: 'NO_PROPS', errors: ['ESP: no fluid properties at the intake'], warnings: [] };
        var ns = P.natSep ? natSep({ qL: s0.qL, casingId: P.casingId, od: P.od, rhoL: s0.rhoL, rhoG: s0.rhoG, sigma: s0.sigL }) : { E: 0 };
        var En = ns.E || 0, E = 1 - (1 - En) * (1 - P.sepEff);
        var ff = WF.flowlineFluid(F, q), qgScf = ff.qg_MMscfd * 1e6, vent = E * Math.max(0, +s0.freeGas || 0);
        var qIng = { qo: ff.qo, qw: ff.qw, qg_Mscfd: Math.max(0, qgScf - vent) / 1000 };
        var s1 = vent > 0 ? F.at(pInt, T, qIng) : s0;
        var v1 = _vol(s1), nu = s1.qL > 0 && s1.rhoL > 0 ? Math.max(0.5, (+s1.muL || 1) / (s1.rhoL / RHO_W)) : 1;
        var C = curve(P.pump, P.f, P.visc ? nu : 1);
        var K = Math.min(MAX_GROUPS, P.N), n = P.N / K, p = pInt, hyd = 0, bhp = 0, rhoSum = 0, Qout = v1.Q, hIn = C.head(v1.Q), groups = [];
        for (var k = 0; k < K; k++) {
            var a = k === 0 ? v1 : _vol(F.at(Math.max(15, p), T, qIng));
            var dp1 = a.rho * C.head(a.Q) * n / 144;
            var b = _vol(F.at(Math.max(15, p + 0.5 * dp1), T, qIng)), H = C.head(b.Q), dp = b.rho * H * n / 144;
            var hh = b.Q * Math.max(H, 0) * n * (b.rho / RHO_W) / HHP, e = Math.max(0.05, C.eff(b.Q));
            hyd += hh; bhp += hh / e; rhoSum += b.rho;
            p += dp; Qout = b.Q;
            if (o.groups) groups.push({ k: k, p: p, Q: b.Q, H: H, rho: b.rho });
        }
        // the shaft power at no flow / reverse head is not hydraulic: at least the affinity-scaled shut-in BHP (water) × SG
        var rhoAvg = rhoSum / K, bhpMin = P.N * C.bhp(0, rhoAvg / RHO_W);
        if (bhp < bhpMin) bhp = bhpMin;
        var dpT = p - pInt, gvf = (v1.qL + v1.qG) > 0 ? v1.qG / (v1.qL + v1.qG) : 0, phi = turpin(v1.qG, v1.qL, pInt);
        var rs = v1.Q < C.range.qMin ? 'down' : (v1.Q > C.range.qMax ? 'up' : 'ok');
        if (rs === 'ok' && Qout > C.range.qMax) rs = 'up';
        return { ok: true, pInt: pInt, pDis: p, dp: dpT, T: T, Qin: v1.Q, Qout: Qout, gvfIn: gvf, phi: phi, En: En, E: E, ventMscfd: vent / 1000, qIng: qIng,
            freeIn: Math.max(0, +s0.freeGas || 0) / 1000, nu: nu, visc: C.visc, hIn: hIn, tdh: dpT * 144 / rhoAvg, rho: rhoAvg, hydHp: hyd, bhp: bhp, eff: bhp > 0 ? hyd / bhp : 0,
            range: C.range, rangeStatus: rs, bep: C.bep, f: P.f, N: P.N, qLin: s0.qL, rhoLin: s0.rhoL, groups: groups, errors: [], warnings: [] };
    }

    // ── motor and cable ───────────────────────────────────────────────────────
    function motor(P, st, o) {
        o = o || {};
        var r = P.f / (P.pump && P.pump.f0 ? P.pump.f0 : 60), m = P.motor || {}, out = { ok: false, missing: [] };
        // motor cooling: the whole intake stream past the motor (casing-to-motor annulus)
        if (st && st.ok && P.casingId > P.od && !P.belowPerfs) out.vCool = (st.qLin + 0) / (Math.PI / 4 * (P.casingId * P.casingId - P.od * P.od) / 144);
        if (!(m.hp > 0)) out.missing.push('motor power'); if (!(m.volt > 0)) out.missing.push('motor voltage'); if (!(m.amp > 0)) out.missing.push('motor current');
        if (out.missing.length || !st || !st.ok) return out;
        out.ok = true;
        out.hpAvail = m.hp * r; out.load = st.bhp / out.hpAvail; out.vMotor = m.volt * r; out.amps = m.amp * Math.max(0.2, out.load);
        var tp = _fin(o.T_pump) ? o.T_pump : 180, ts = _fin(o.T_surf) ? o.T_surf : 80, tc = ((tp + ts) / 2 - 32) * 5 / 9;
        var R = CU_R20[P.cable.awg] * (1 + 0.00393 * (tc - 20)), dV = Math.sqrt(3) * out.amps * R * P.cable.len / 1000;
        out.cable = { awg: P.cable.awg, len: P.cable.len, lenDefault: P.cable.lenDefault, R: R, dV: dV, tMean: (tp + ts) / 2 };
        out.vSurf = out.vMotor + dV; out.cable.pct = dV / out.vSurf; out.kva = Math.sqrt(3) * out.vSurf * out.amps / 1000;
        return out;
    }

    // ── flags ─────────────────────────────────────────────────────────────────
    function flags(P, st, mo) {
        var F = [], add = function (code, sev, msg, field) { F.push({ code: code, sev: sev, msg: String(msg).slice(0, 290), field: field || null }); };
        if (!st || !st.ok) return F;
        var rg = st.range;
        if (st.rangeStatus === 'down') add('ESP_DOWNTHRUST', 'warn', 'The pump runs left of its recommended range (' + _f(st.Qin) + ' bbl/d against ' + _f(rg.qMin) + '–' + _f(rg.qMax) + ' bbl/d at ' + _f(P.f, 1) + ' Hz): downthrust and low efficiency — fewer stages or a lower frequency.', 'wp_esp_freq');
        else if (st.rangeStatus === 'up') add('ESP_UPTHRUST', 'warn', 'The pump runs right of its recommended range (' + _f(Math.max(st.Qin, st.Qout)) + ' bbl/d against ' + _f(rg.qMin) + '–' + _f(rg.qMax) + ' bbl/d at ' + _f(P.f, 1) + ' Hz): upthrust — more stages or a lower frequency.', 'wp_esp_freq');
        else add('ESP_RANGE', 'ok', 'Inside the recommended range: ' + _f(st.Qin) + ' bbl/d at the intake (' + _f(rg.qMin) + '–' + _f(rg.qMax) + ' bbl/d at ' + _f(P.f, 1) + ' Hz)' + (rg.assumed ? ', range assumed ±30 % of the BEP' : '') + '.');
        if (st.phi > 1) add('ESP_GAS', 'fail', 'Gas interference expected: Turpin φ = ' + _f(st.phi, 2) + ' > 1 at the intake (' + _f(st.gvfIn * 100, 0) + ' % free gas by volume after ' + _f(st.E * 100, 0) + ' % separation) — a gas separator, a deeper setting or a gas-handling pump.', 'wp_esp_sep');
        else if (st.gvfIn > 0.1) add('ESP_GVF', 'warn', 'Free gas at the intake ' + _f(st.gvfIn * 100, 0) + ' % by volume (Turpin φ ' + _f(st.phi, 2) + ' ≤ 1): head degradation likely above about 10 %.', 'wp_esp_sep');
        else add('ESP_GAS_OK', 'ok', 'Gas at the intake: ' + _f(st.gvfIn * 100, 1) + ' % by volume, Turpin φ ' + _f(st.phi, 2) + ' (≤ 1).');
        if (st.visc && st.visc.Qstar != null && st.visc.CQ < 0.999) add('ESP_VISC', st.visc.outside ? 'warn' : 'info', 'Viscosity ' + _f(st.nu, 1) + ' cSt at the intake: rate × ' + _f(st.visc.CQ, 3) + ', head × ' + _f(st.visc.CH[2], 3) + ', efficiency × ' + _f(st.visc.CE, 3) + (st.visc.outside ? ' (outside the chart range, Q* ' + _f(st.visc.Qstar, 0) + ')' : '') + '.', 'wp_esp_visc');
        if (mo && mo.ok) {
            var L = mo.load;
            add(L > 1 ? 'ESP_OVERLOAD' : (L > 0.9 ? 'ESP_LOAD_HIGH' : (L < 0.5 ? 'ESP_LOAD_LOW' : 'ESP_LOAD')), L > 1 ? 'fail' : (L > 0.9 ? 'warn' : (L < 0.5 ? 'info' : 'ok')),
                'Motor load ' + _f(L * 100, 0) + ' % (' + _f(st.bhp, 0) + ' hp of ' + _f(mo.hpAvail, 0) + ' hp at ' + _f(P.f, 1) + ' Hz)' + (L > 1 ? ' — overloaded.' : (L < 0.5 ? ' — lightly loaded (a smaller motor runs cooler and at a better power factor).' : '.')), 'wp_esp_hp');
            add(mo.cable.pct > 0.05 ? 'ESP_CABLE' : 'ESP_CABLE_OK', mo.cable.pct > 0.05 ? 'warn' : 'ok', 'Cable drop ' + _f(mo.cable.dV, 0) + ' V (' + _f(mo.cable.pct * 100, 1) + ' %) on ' + _f(mo.cable.len, 0) + ' ft of #' + mo.cable.awg + ' copper; surface ' + _f(mo.vSurf, 0) + ' V, ' + _f(mo.kva, 0) + ' kVA.', 'wp_esp_awg');
        } else if (mo && mo.missing && mo.missing.length) add('ESP_MOTOR_MISSING', 'info', 'Enter the motor ' + mo.missing.join(', ') + ' for the motor load and the cable check (BHP ' + _f(st.bhp, 0) + ' hp needed).', 'wp_esp_hp');
        if (mo && _fin(mo.vCool)) add(mo.vCool < 1 ? 'ESP_COOLING' : 'ESP_COOLING_OK', mo.vCool < 1 ? 'warn' : 'ok', 'Fluid velocity past the motor ' + _f(mo.vCool, 2) + ' ft/s' + (mo.vCool < 1 ? ' (below about 1 ft/s: a shroud or a smaller casing gap).' : '.'), 'wp_esp_od');
        if (P.belowPerfs) add('ESP_BELOW_PERFS', 'warn', 'The pump sits at the perforations: no flow past the motor without a shroud.', 'wp_esp_md');
        if (P.dls > 3) add('ESP_DOGLEG', P.dls > 6 ? 'fail' : 'warn', 'Dogleg ' + _f(P.dls, 1) + '°/100 ft at the setting depth (' + _f(P.md, 0) + ' ft MD): above 3°/100 ft the pump and motor housings bend — choose a straighter interval.', 'wp_esp_md');
        return F;
    }

    // ── stages for a target rate: the system's required rise over the pump's rise per stage ──
    function sizeStages(M, q) {
        var SY = G.WTS_wp_system;
        if (!SY || typeof SY.evalAt !== 'function') return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_wp_system.evalAt is not available'], warnings: [] };
        if (!(q > 0)) return { ok: false, code: 'BAD_TARGET', errors: ['ESP: a target rate above zero is needed'], warnings: [] };
        var Mx = _clone(M); Mx.lift = Mx.lift || {}; Mx.lift.type = 'esp'; Mx.lift.esp = Mx.lift.esp || {};
        if (!(_n(Mx.lift.esp.stages) >= 1)) Mx.lift.esp.stages = 100;
        Mx.system = Mx.system || {}; Mx.system.node = 'bottom';
        var N = Math.round(+Mx.lift.esp.stages), ev = 0, last = null;
        for (var it = 0; it < 3; it++) {
            Mx.lift.esp.stages = N;
            var e = SY.evalAt(Mx, q); ev++;
            if (!e || !e.ok && e.code) return { ok: false, code: e.code, errors: e.errors || ['the evaluation failed'], warnings: [] };
            var es = e.tr && e.tr.esp;
            if (!es || !es.ok) return { ok: false, code: 'NO_EVAL', errors: ['ESP: no pump state at ' + _f(q) + (e.lost ? ' (' + (e.lost.reason || 'lost') + ')' : '')], warnings: [], evals: ev };
            last = es;
            if (!(es.dp > 0)) return { ok: false, code: 'PUMP_NO_HEAD', errors: ['ESP: the pump makes no head at this rate at ' + _f(es.f, 1) + ' Hz (' + _f(es.Qin) + ' bbl/d is beyond the curve)'], warnings: [], evals: ev, state: es };
            var need = Math.max(0, es.dpNeed), Nn = Math.max(1, Math.ceil(N * need / es.dp - 1e-9));
            if (Nn === N || Math.abs(Nn - N) <= 0) break;
            N = Nn;
        }
        var per = last.dp / last.N;
        return { ok: true, stages: Math.max(1, Math.ceil(last.dpNeed / per - 1e-9)), q: q, dpNeed: last.dpNeed, dpPerStage: per, hPerStage: last.tdh / last.N, tdh: last.dpNeed * 144 / last.rho,
            pInt: last.pInt, Qin: last.Qin, rangeStatus: last.rangeStatus, evals: ev, errors: [], warnings: last.dpNeed <= 0 ? [_w('ESP_NOT_NEEDED', 'The well flows this rate without the pump at these settings.', 'info')] : [] };
    }

    // ── rate against frequency (a Job; tracking solves warm-started from the previous frequency) ──
    function sweep(M, o) {
        o = o || {};
        var SY = G.WTS_wp_system, freqs = (Array.isArray(o.freqs) && o.freqs.length ? o.freqs : [40, 45, 50, 55, 60, 65, 70]).map(Number).filter(function (f) { return f >= 30 && f <= 90; }).sort(function (a, b) { return a - b; });
        var rows = [], prev = null, ev = 0, cancelled = false;
        var res = null;
        var finish = function () {
            if (res) return res;
            res = { ok: rows.some(function (r) { return r.ok; }), rows: rows, evals: ev, cancelled: cancelled, verified: false, provisional: PROVISIONAL, errors: rows.length ? [] : ['no frequency to run'], warnings: [] };
            return res;
        };
        var i = 0;
        return {
            step: function () {
                if (!cancelled && i < freqs.length && SY) {
                    var f = freqs[i], Mx = _clone(M); Mx.lift = Mx.lift || {}; Mx.lift.type = 'esp'; Mx.lift.esp = Mx.lift.esp || {}; Mx.lift.esp.freq = f;
                    var so = {};
                    if (prev && prev.R && prev.R.ok) so = { warm: prev.R.grid, track: { q: prev.R.op.q * f / prev.f, slope: prev.R.op.dDdq } };
                    var R = SY.solve(Mx, so); ev += (R && R.evals) || 0;
                    var ok = !!(R && R.ok && R.op), L = ok ? R.lift : null;
                    rows.push({ f: f, ok: ok, q: ok ? R.op.q : null, qL: ok ? R.rates.qL : null, qo: ok ? R.rates.qo : null, pwf: ok ? R.pwf : null, pInt: L ? L.pInt : null, Qin: L ? L.Qin : null,
                        rangeStatus: L ? L.rangeStatus : null, load: L && L.motor && L.motor.ok ? L.motor.load : null, gvf: L ? L.gvfIn : null, phi: L ? L.phi : null, bhp: L ? L.bhp : null,
                        stable: ok ? !!R.op.stable : false, code: ok ? null : (R && R.code) || 'NO_FLOW', evals: R ? R.evals : 0 });
                    if (ok) prev = { f: f, R: R };
                    i++;
                }
                var done = cancelled || i >= freqs.length || !SY;
                if (done) finish();
                return { done: done, progress: done ? 1 : i / freqs.length, label: i < freqs.length ? freqs[i] + ' Hz' : '' };
            },
            done: function () { return cancelled || i >= freqs.length; },
            progress: function () { return freqs.length ? i / freqs.length : 1; },
            result: finish,
            cancel: function () { cancelled = true; }
        };
    }

    var NS = G.WTS_wp_esp = G.WTS_wp_esp || {};
    NS.VERSION = VERSION; NS.PROVISIONAL = PROVISIONAL; NS.METHODS = METHODS; NS.CU_R20 = CU_R20; NS.MAX_GROUPS = MAX_GROUPS;
    NS.example = example; NS.normPump = normPump; NS.curve = curve; NS.fan = fan; NS.turzo = turzo; NS.natSep = natSep; NS.turpin = turpin;
    NS.prepare = prepare; NS.pump = pump; NS.motor = motor; NS.flags = flags; NS.sizeStages = sizeStages; NS.sweep = sweep;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, E = G.WTS_wp_esp, bad = [];
    try {
        var p = E.normPump(E.example());
        if (!p.ok || Math.abs(p.pump.bep.q - 1550) > 60) bad.push('bep ' + (p.pump && p.pump.bep.q));
        var c60 = E.curve(p.pump, 60), c50 = E.curve(p.pump, 50), r = 50 / 60;
        if (Math.abs(c50.head(1000 * r) - r * r * c60.head(1000)) > 1e-9) bad.push('affinity');
        var t = E.turzo(1500, 22, 1);
        if (t.CQ !== 1) bad.push('turzo water');
    } catch (e) { bad.push('threw ' + e.message); }
    if (bad.length && typeof console !== 'undefined') console.error('[wp-esp self-test] FAILED: ' + bad.join('; '));
})();
