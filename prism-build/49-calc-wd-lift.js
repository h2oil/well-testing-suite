// =============================================================================
// WTS — 49-calc-wd-lift.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Dynamics — lift transients and the oil-heading detector (lane WD4). docs/WELL-DYNAMICS-PLAN.md §3.3 (the extension contract),
// §4.11 (foamer), §4.12 (gas lift, ESP, intermittent production), §4.13 (heading), §4.14 (method table), §5.3 (tests LF1–LF23).
// Engine extensions only: no DOM, no storage, no timers, no polling, no function wrapping. Field units (§3.0): psia inside (psig only
// where a name says *_psig), °F, ft (MD / TVD), in, STB/d, Mscf/d, lbm, s, ft³.
//
// The five extensions register in WTS_wd_engine.ext (WD-D13); the engine calls, once per step and in this order: control → sources
// (from the LAGGED state, fixed for the step) → faceDp (linearised at the lagged flux) → pressure solve → transport → after → sigma →
// labels. An extension writes only its own ctx and S.lift.* / S.foamer (two recorded exceptions, §11.4: the gas-lift label hook writes
// S.surface.qinj, which the engine's surface pass resets every step, and the ESP after hook writes S.surface.qvent, which it keeps).
//
//   foamer   continuous foamer (provisional, Q10): a tracer m_F carried with the water (the engine transports it); dosed at ppm by mass of
//            the formation water entering the well, at the injection MD (a capillary string) or — blank — at the end of the tubing (down
//            the annulus to the tubing shoe). Surface-tension factor per cell sigF = 1 − r(c), r(c) = r_max·c/(c + c_50), r_max 0.6,
//            c_50 500 ppm (ASSUMED), c = 10⁶·m_F/m_W of the cell. σ_e = σ_L·sigF lowers the critical velocity by sigF^¼ (C11) and
//            the drift velocity. Foam density reduction is not modelled.
//   cycle    intermittent production (a controller, no physics): 'timer' (open_h / shut_h / cycles — the open and shut-in events are
//            scheduled ahead, so each lands exactly on its time) or 'pressure' (open when THP — CHP for a gas-lift well — reaches
//            pOpen_psig after minShut_h; shut when the gas rate falls below qClose_Mscfd or THP below pClose_psig after minOpen_h). Each
//            open period is booked: liquid and gas produced, tubing liquid at the open and at the shut-in (the liquid removed per cycle).
//   heading  oil wells: labels heading when the THP ring (30 s samples, last 3 h) shows ≥ 3 peak pairs with a peak-to-peak above 5 % of
//            the mean, a period of 2 min – 3 h and a sustained amplitude (last peak-to-peak ≥ 0.8 × the first; review fix) (provisional
//            thresholds, Q15). Heading is not imposed: it emerges, or the well dies (not reproduced on the test wells, §11.7).
//   gaslift  'nodal' — the lift gas q_inj enters the tubing cell above the R0.lift.injMd break as a lift-gas (I) source (the gate, G5;
//            identity with the nodal C.gl.Finj); 'valves' (default when the model has installed valves) — the annulus is one control
//            volume from the surface to the packer holding a lift-gas mass m_a and a liquid column (the model's water) of volume V_al
//            with its top at MD z_L; casing pressure from the real-gas column p_c(tvd) = p_cs·exp(0.01875·γ_I/z̄·∫ dtvd / T_R) (one
//            Z iteration, Dranchuk-Abou-Kassem on Sutton pseudo-criticals as the gas-lift engine), below z_L + ρ_L·Δtvd/144; IPO valve
//            balance in gauge (open at p_vo = (p_d − R·p_t)/(1 − R), closed below p_vc = p_d; dome p_d from WTS_wp_gl.pdAt at the valve
//            temperature), orifice valves always open, dummy valves shut; gas through an open valve in the gas column by
//            Thornhill-Craver (WTS_wp_gl.tc) → an I source in the valve's tubing cell; annulus liquid below z_L through an open valve by
//            the orifice law q = C_d·A·√(2·g_c·144·Δp/ρ_L) (C_d 0.6) → a W source; check valves (no reverse flow). Surface injection at
//            q_inj while p_cs < the kickoff pressure (design p_ko, else p_inj + 100 psi), else none. The step's valve rates are limited so
//            one step never moves more annulus volume (liquid) or mass (gas) than lowers the casing-to-tubing Δp by half (a stable
//            explicit coupling of the stiff annulus). States gl_unloading / gl_lifting / gl_multipoint (> 1 valve passing gas for 10 min).
//   esp      the pump face Δp is the nodal pump model WTS_wp_esp.pump(P_f, F, q, p_int, T) of the prepared pump C.esp at the drive
//            frequency f(t) — the same call the nodal pump node makes (identity, G6, LF21) — with q the stock-tank stream of the pump face
//            at the face flux, linearised once per step (dp + ddpdQ·(Q − Q_lag), a ±1 % difference); a stopped pump (f < 1 Hz) and the
//            check valve at the discharge (Q_lag ≤ 1e-4 ft³/s) add a stiff resistance (no back-flow). Drive: f_drive follows f_cmd at
//            the ramp limit (default 1 Hz/s), the motor follows f_drive with a first-order lag τ_m = 0.5 s (ASSUMED). Vented gas
//            (natural separation, opt-in as the nodal natSep) leaves the cell below the pump (a negative G source) and is counted in
//            the surface gas rate (qvent) and cumOut (C8). Load = pump BHP / motor power at f (the motor nameplate, else 1.25 × the
//            stages' BHP at the best-efficiency point, ASSUMED). States esp_off / esp_ramp / esp_running / esp_pumpoff (intake < 50 psia
//            or the intake rate < 5 % of the BEP rate with f > 30 Hz, for 60 s) / esp_gaslock (intake gas fraction > 0.3 for 60 s) /
//            esp_tripped (load < 0.4 for 30 s → f_cmd = 0; a controller event 'esp' {on:false}); thresholds ASSUMED (provisional).
//
// PUBLIC: window.WTS_wd_lift = { VERSION, DEFAULTS, PRESETS, PROVISIONAL, annulus(sim | M), casingP(ann, p_cs, tvd), sigmaFactor(ppm, o),
//   valveBalance(v, pc_psia, pt_psia, open), pumpDp(sim, ctx, Q), describe(sim), balanceLevel(M) } and WTS_wd_engine.ext.{foamer, cycle, heading, gaslift,
//   esp}. Additive state (§11.4): S.lift.gl, S.lift.esp, S.lift.cycle, S.foamer.eff / cBottom_ppm / injMd, S.lift.heading.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WD_STUBS = G.__WD_STUBS || [];
    for (var si = STUBS.length - 1; si >= 0; si--) if (/^WTS_wd_lift/.test(STUBS[si]) || /^WTS_wd_engine\.ext/.test(STUBS[si])) STUBS.splice(si, 1);

    var VERSION = '1.0.0';
    var PATM = 14.696, RANK = 459.67, FT3 = 5.614583, GC = 32.174;
    var PROVISIONAL = 'provisional — not verified against a published example';
    var TAU_VALVE = 20;                     // s, lag of a gas-lift valve's throughput behind its target (ASSUMED; integration fix §11.7)
    var DEFAULTS = Object.freeze({
        foamer: Object.freeze({ rMax: 0.6, c50: 500 }),                              // ppm (ASSUMED, Q10)
        gaslift: Object.freeze({ cdLiq: 0.6, pkoAbove_psi: 100, staticCap_ft: 30, nodes: 60 }),
        esp: Object.freeze({ ramp_Hz_s: 1, tauM_s: 0.5, kStop: 1e7, kCheck: 1e7, lockTau_s: 10, qCheck: 1e-4, motorFactor: 1.25,
            pumpoff: Object.freeze({ pInt_psia: 50, qFrac: 0.05, fMin: 30, hold_s: 60, pLock_psia: 30, pRestart_psia: 150, idle_s: 900 }), gaslock: Object.freeze({ gvf: 0.3, hold_s: 60, lock: 0.5, relock_s: 30 }),
            underload: Object.freeze({ load: 0.4, hold_s: 30, fMin: 30 }) }),
        heading: Object.freeze({ every_s: 30, window_s: 10800, pp: 0.05, pairs: 3, periodMin_s: 120, periodMax_s: 10800, sustain: 0.8 }),
        cycle: Object.freeze({ minOpen_h: 0, minShut_h: 0 }),
        multipoint_s: 600
    });
    // scenario presets of the lift lane (§3.9 FIX.scenarios; the page has its own preset buttons) — events from t = 0, s
    var H = 3600;
    var PRESETS = Object.freeze({
        foamerOn: { label: 'Continuous foamer on a loaded gas well', opts: { fallback: true }, events: [{ t: 4 * H, type: 'foamer', args: { on: true, ppm: 1000, injMd: null } }], duration_s: 10 * H },
        cycleTimer: { label: 'Intermittent: 2 h open / 2 h shut × 3', opts: {}, events: [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 2, shut_h: 2, cycles: 3 } }], duration_s: 12 * H },
        cyclePressure: { label: 'Intermittent by pressure', opts: {}, events: [{ t: 0, type: 'cycle', args: { mode: 'pressure', pOpen_psig: 900, pClose_psig: 350, qClose_Mscfd: 0, minOpen_h: 0.5, minShut_h: 0.5, cycles: 3 } }], duration_s: 12 * H },
        glUnload: { label: 'Gas-lift unloading from a killed well', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } } },
            events: [{ t: 0, type: 'open' }, { t: 0, type: 'gl', args: { qinj_Mscfd: null, mode: 'valves' } }], duration_s: 12 * H },
        espStart: { label: 'ESP start-up from a static well', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } } },
            events: [{ t: 0, type: 'open' }, { t: 0, type: 'esp', args: { on: true, freq: null, ramp_Hz_s: 1 } }], duration_s: 2 * H }
    });

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; })); }
    function _mark(sim, k) { if (sim && typeof sim._mark === 'function') sim._mark(k); }
    function _emit(sim, type, p) { if (sim && typeof sim._emit === 'function') sim._emit(type, p); }
    function _flag(sim, code, msg, sev) { if (sim && typeof sim._flag === 'function') sim._flag(code, msg, sev || 'info'); }
    function _cellAtMd(grid, md) {
        var c = grid.cells;
        for (var i = 0; i < c.length; i++) if (md <= c[i].md0 + 1e-6 && md >= c[i].md1 - 1e-6) return i;
        return md > c[0].md0 ? 0 : c.length - 1;
    }
    function _faceAtMd(grid, md) { var b = -1, d = Infinity, f = grid.faces; for (var k = 0; k < f.length; k++) { var x = Math.abs(f[k].md - md); if (x < d) { d = x; b = k; } } return b; }
    // temperature (°F) at an MD from the cells (frozen / relaxing profile)
    function _tAtMd(sim, md) {
        var g = sim.grid, cs = sim.cs, n = sim.n;
        if (md >= g.cells[0].mdc) return cs.T[0];
        if (md <= g.cells[n - 1].mdc) return cs.T[n - 1];
        for (var i = 0; i < n - 1; i++) { var a = g.cells[i], b = g.cells[i + 1]; if (md <= a.mdc && md >= b.mdc) { var f = (a.mdc - md) / Math.max(1e-9, a.mdc - b.mdc); return cs.T[i] + (cs.T[i + 1] - cs.T[i]) * f; } }
        return cs.T[n - 1];
    }

    // ── foamer (§4.11, C11) ──────────────────────────────────────────────────────────────────────────────────────────
    function sigmaFactor(ppm, o) { o = o || DEFAULTS.foamer; var c = Math.max(0, +ppm || 0); return 1 - o.rMax * c / (c + o.c50); }
    var FOAMER = {
        label: 'Continuous foamer (surface-tension factor)', verified: false, provisional: PROVISIONAL,
        applies: function () { return true; },
        init: function (sim, opts) {
            var x = (opts && opts.ext && opts.ext.foamer) || {};
            return { rMax: _fin(+x.rMax) ? _clamp(+x.rMax, 0, 0.95) : DEFAULTS.foamer.rMax, c50: _fin(+x.c50) && +x.c50 > 0 ? +x.c50 : DEFAULTS.foamer.c50, any: false, dosed_lbm: 0, cell: -1, rate: 0 };
        },
        sources: function (sim, ctx, dt) {
            var S = sim.state, F = S.foamer || {};
            ctx.rate = 0;
            if (!F.on || !(F.ppm > 0)) return null;
            var g = sim.grid, cell = (_fin(F.injMd) && F.injMd > 1) ? _cellAtMd(g, F.injMd) : (g.eotCell >= 0 ? g.eotCell : 0);   // blank (the engine stores a blank as 0) = the end of the tubing
            // the water basis: the formation water entering the well (lbm/s), else the water through the injection cell's top face
            var fs = sim.fs, w = Math.max(0, fs.FW[0], fs.FW[cell + 1] || 0);
            ctx.cell = cell;
            if (!(w > 0)) { _flag(sim, 'FOAMER_NO_WATER', 'Foamer: no water reaches the injection point, so no foamer is dosed.', 'info'); return null; }
            var a = new Float64Array(sim.n); a[cell] = F.ppm * 1e-6 * w;
            ctx.rate = a[cell]; ctx.any = true;
            _mark(sim, 'foamer');
            return { F: a };
        },
        after: function (sim, ctx, info) { ctx.dosed_lbm += ctx.rate * info.dt; },
        sigma: function (sim, ctx) {
            if (!ctx.any) return null;
            var cs = sim.cs, n = sim.n, out = new Float64Array(n), o = { rMax: ctx.rMax, c50: ctx.c50 };
            for (var i = 0; i < n; i++) out[i] = cs.mW[i] > 0 ? sigmaFactor(1e6 * cs.mF[i] / cs.mW[i], o) : 1;
            var g = sim.grid, b = g.eotCell >= 0 ? g.eotCell : 0, S = sim.state;
            S.foamer.eff = out[b]; S.foamer.cBottom_ppm = cs.mW[b] > 0 ? 1e6 * cs.mF[b] / cs.mW[b] : 0; S.foamer.dosed_lbm = ctx.dosed_lbm;
            return out;
        },
        snapshot: function (ctx) { return _clone(ctx); },
        restore: function (j) { return _clone(j); }
    };

    // ── intermittent production (§4.12) ─────────────────────────────────────────────────────────────────────────────
    function _lastCycle(sim) {
        var L = sim.log || [];
        for (var i = L.length - 1; i >= 0; i--) if (L[i].type === 'cycle') return { idx: i, t: L[i].t, args: L[i].args || {} };
        return null;
    }
    function _cancelPending(sim) {
        if (!Array.isArray(sim.pend)) return 0;
        var n0 = sim.pend.length;
        sim.pend = sim.pend.filter(function (e) { return !(e.src === 'controller' && (e.type === 'open' || e.type === 'shutin')); });
        return n0 - sim.pend.length;
    }
    function _isOpen(sim) { var S = sim.state; return !!(S.open && (!sim.C.choke.present || S.beanEff > 1e-9 || (S.ctl && S.ctl.strokeLeft_s > 0))); }
    var CYCLE = {
        label: 'Intermittent production controller', verified: false, provisional: PROVISIONAL,
        applies: function () { return true; },
        init: function () { return { key: null, mode: null, n: 0, phase: null, tPhase: 0, cur: null, hist: [], nOpen: 0, prog: null }; },
        control: function (sim, ctx, t) {
            var S = sim.state, lc = _lastCycle(sim);
            if (!lc) return null;
            var key = lc.idx + '@' + lc.t, a = lc.args, out = [];
            if (ctx.key !== key) {
                ctx.key = key; _cancelPending(sim);
                var mode = a.mode === 'pressure' ? 'pressure' : (a.mode === 'timer' ? 'timer' : 'off');
                var cyc = _fin(+a.cycles) ? Math.max(0, Math.round(+a.cycles)) : 0;
                ctx.mode = mode; ctx.nOpen = 0; ctx.prog = { mode: mode, cycles: cyc, t0: t, open_h: _n(a.open_h), shut_h: _n(a.shut_h), pOpen_psig: _n(a.pOpen_psig), pClose_psig: _n(a.pClose_psig),
                    qClose_Mscfd: _n(a.qClose_Mscfd), minOpen_h: _fin(_n(a.minOpen_h)) ? _n(a.minOpen_h) : DEFAULTS.cycle.minOpen_h, minShut_h: _fin(_n(a.minShut_h)) ? _n(a.minShut_h) : DEFAULTS.cycle.minShut_h };
                if (mode === 'off' || (mode === 'timer' && !(cyc > 0 && ctx.prog.open_h > 0 && ctx.prog.shut_h > 0))) { ctx.mode = 'off'; return null; }
                if (mode === 'timer') {
                    // the whole programme is scheduled now (exact times): open now if shut, shut after open_h, re-open after shut_h, × cycles;
                    // the last re-open leaves the well flowing
                    var to = ctx.prog.open_h * H, ts = ctx.prog.shut_h * H, ev = [];
                    if (!S.open) out.push({ type: 'open', args: {}, src: 'controller' });
                    for (var c = 0; c < cyc; c++) { ev.push({ t: t + c * (to + ts) + to, type: 'shutin', args: {}, src: 'controller' }); ev.push({ t: t + (c + 1) * (to + ts), type: 'open', args: {}, src: 'controller' }); }
                    sim.schedule(ev);
                    ctx.prog.end = t + cyc * (to + ts);
                }
                ctx.phase = S.open || out.length ? 'open' : 'shut'; ctx.tPhase = t;
                _mark(sim, 'cycle');
            }
            if (ctx.mode !== 'pressure') return out.length ? out : null;
            var p = ctx.prog, gl = S.lift && S.lift.gl, thp = (gl && _fin(gl.pcs_psig)) ? gl.pcs_psig : S.surface.thp_psig, open = !!S.open;
            if (p.cycles > 0 && ctx.nOpen >= p.cycles && !open) return out.length ? out : null;
            if (!open) {
                if (t - ctx.tPhase >= p.minShut_h * H - 1e-9 && _fin(p.pOpen_psig) && _fin(thp) && thp >= p.pOpen_psig) { out.push({ type: 'open', args: {}, src: 'controller' }); ctx.phase = 'open'; ctx.tPhase = t; ctx.nOpen++; }
            } else if (t - ctx.tPhase >= p.minOpen_h * H - 1e-9) {
                var qg = sim.gasWell() ? S.surface.qgForm : S.surface.qg;
                var lowQ = _fin(p.qClose_Mscfd) && p.qClose_Mscfd > 0 && qg < p.qClose_Mscfd, lowP = _fin(p.pClose_psig) && _fin(S.surface.thp_psig) && S.surface.thp_psig < p.pClose_psig;
                if (lowQ || lowP) { out.push({ type: 'shutin', args: {}, src: 'controller' }); ctx.phase = 'shut'; ctx.tPhase = t; }
            }
            return out.length ? out : null;
        },
        after: function (sim, ctx, info) {
            if (!ctx.prog || ctx.mode === 'off') return;
            var S = sim.state, open = _isOpen(sim), dt = info.dt, inv = S.inventory;
            if (open && !ctx.cur) ctx.cur = { n: ctx.hist.length + 1, tOpen: S.t - dt, liqStart_bbl: inv.liqTubing_bbl, liq_bbl: 0, gas_Mscf: 0 };
            if (ctx.cur) {
                ctx.cur.liq_bbl += Math.max(0, S.surface.qL) * dt / 86400;
                ctx.cur.gas_Mscf += Math.max(0, sim.gasWell() ? S.surface.qgForm : S.surface.qg) * dt / 86400;
                if (!open) {
                    ctx.cur.tShut = S.t; ctx.cur.liqEnd_bbl = inv.liqTubing_bbl; ctx.cur.removed_bbl = ctx.cur.liqStart_bbl - ctx.cur.liqEnd_bbl;
                    ctx.hist.push(ctx.cur); if (ctx.hist.length > 50) ctx.hist.shift(); ctx.cur = null;
                    if (ctx.mode === 'timer') ctx.phase = 'shut';
                }
            }
            if (ctx.mode === 'timer') ctx.phase = open ? 'open' : 'shut';
            var nxt = null;
            if (Array.isArray(sim.pend)) for (var i = 0; i < sim.pend.length; i++) if (sim.pend[i].src === 'controller') { nxt = { t: sim.pend[i].t, type: sim.pend[i].type }; break; }
            S.lift.cycle = { mode: ctx.mode, phase: open ? 'open' : 'shut', n: ctx.hist.length + (ctx.cur ? 1 : 0), next: nxt, cur: ctx.cur ? _clone(ctx.cur) : null,
                hist: ctx.hist.slice(-20).map(_clone), prog: _clone(ctx.prog) };
        },
        snapshot: function (ctx) { return _clone(ctx); },
        restore: function (j) { return _clone(j); }
    };

    // ── oil heading detector (§4.13) ────────────────────────────────────────────────────────────────────────────────
    function headingOf(T, P, o) {
        o = o || DEFAULTS.heading;
        var n = T.length; if (n < 8) return null;
        var mean = 0; for (var i = 0; i < n; i++) mean += P[i]; mean /= n;
        var th = o.pp * Math.abs(mean); if (!(th > 0)) return null;
        // turning points with hysteresis: a maximum is accepted once the signal falls by th below it, a minimum once it rises by th
        var ext = [], dir = 0, cand = P[0], ct = T[0];
        for (var k = 1; k < n; k++) {
            var p = P[k];
            if (dir >= 0) { if (p > cand) { cand = p; ct = T[k]; } else if (cand - p >= th) { if (dir > 0 || ext.length === 0) ext.push({ t: ct, p: cand, max: true }); dir = -1; cand = p; ct = T[k]; } }
            if (dir < 0) { if (p < cand) { cand = p; ct = T[k]; } else if (p - cand >= th) { ext.push({ t: ct, p: cand, max: false }); dir = 1; cand = p; ct = T[k]; } }
            if (dir === 0 && Math.abs(p - P[0]) >= th) dir = p > P[0] ? 1 : -1;
        }
        var maxima = ext.filter(function (e) { return e.max; }), pairs = 0, periods = [];
        var pp = [];
        for (var a = 1; a < ext.length; a++) if (ext[a - 1].max && !ext[a].max && ext[a - 1].p - ext[a].p >= th) { pairs++; pp.push(ext[a - 1].p - ext[a].p); }
        // sustained (review fix): the last peak-to-peak ≥ sustain × the first, so a decaying oscillation (the THP tail after an unloading) is not heading
        var sus = _fin(+o.sustain) ? +o.sustain : 0.8, sustained = pp.length >= 2 && pp[pp.length - 1] >= sus * pp[0];
        for (var b = 1; b < maxima.length; b++) periods.push(maxima[b].t - maxima[b - 1].t);
        var per = periods.length ? periods.reduce(function (s, x) { return s + x; }, 0) / periods.length : NaN;
        var amp = 0; for (var c = 1; c < ext.length; c++) amp = Math.max(amp, Math.abs(ext[c].p - ext[c - 1].p));
        return { pairs: pairs, period_s: per, amp: amp, mean: mean, sustained: sustained,
            heading: pairs >= o.pairs && sustained && _fin(per) && per >= o.periodMin_s && per <= o.periodMax_s };
    }
    var HEADING = {
        label: 'Oil-well heading detector', verified: false, provisional: PROVISIONAL,
        applies: function (M) { return !!M && !!M.fluid && (M.fluid.type === 'oil' || M.fluid.type === 'water' || !M.fluid.type); },
        init: function () { return { T: [], P: [], next: 0, last: null }; },
        after: function (sim, ctx) {
            var S = sim.state, o = DEFAULTS.heading;
            if (!_isOpen(sim)) { ctx.T.length = 0; ctx.P.length = 0; ctx.next = S.t; ctx.last = null; return; }
            if (S.t + 1e-9 < ctx.next) return;
            ctx.T.push(S.t); ctx.P.push(S.surface.thp);
            while (ctx.T.length && ctx.T[0] < S.t - o.window_s) { ctx.T.shift(); ctx.P.shift(); }
            ctx.next = S.t + o.every_s;
            ctx.last = headingOf(ctx.T, ctx.P, o);
            S.lift.heading = ctx.last ? { heading: ctx.last.heading, pairs: ctx.last.pairs, period_s: ctx.last.period_s, amp_psi: ctx.last.amp } : null;
        },
        label: function (sim, ctx) {
            if (ctx.last && ctx.last.heading) { _mark(sim, 'states'); return { state: 'heading', reason: ctx.last.pairs + ' THP peak pairs in 3 h, period ' + Math.round(ctx.last.period_s / 60) + ' min' }; }
            return null;
        },
        snapshot: function (ctx) { return _clone(ctx); },
        restore: function (j) { return _clone(j); }
    };

    // ── gas lift (§4.12) ────────────────────────────────────────────────────────────────────────────────────────────
    function _zLib() { return G.PRiSM_pvt_correlations || null; }
    var _pcC = {};
    function _pcFor(sg) {
        var k = String(sg); if (_pcC[k]) return _pcC[k];
        var p = (typeof G.WTS_gaspvt_pseudoCriticals === 'function') ? G.WTS_gaspvt_pseudoCriticals(sg, 0, 0, 0) : null, L = _zLib();
        if (!(p && p.Tpc > 0) && L) p = { Tpc: L.Tpc_sutton(sg), Ppc: L.Ppc_sutton(sg) };
        _pcC[k] = p && p.Tpc > 0 ? { Tpc: p.Tpc, Ppc: p.Ppc } : null;
        return _pcC[k];
    }
    function _z(sg, p, T) {
        var L = _zLib(), pc = _pcFor(sg);
        if (!L || !pc || typeof L.Z_dranchukAbouKassem !== 'function') return 0.9;
        var z = L.Z_dranchukAbouKassem((T + RANK) / pc.Tpc, Math.max(15, p) / pc.Ppc);
        return _fin(z) && z > 0.1 ? z : 0.9;
    }
    // the annulus from the surface to the packer: nodes in MD with TVD, temperature, the area (ft²) of the interval below each node
    function annulus(sim, o) {
        o = o || {};
        var M = sim.M, W = sim.C && sim.C.W, gl = (M.lift && M.lift.gl) || {}, strings = (M.well && M.well.strings) || [];
        var shoe = W && W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : null, mid = W && W.nodes ? W.nodes.midPerfMd : null;
        var pk = (sim.C.gl && _fin(sim.C.gl.packerMd)) ? sim.C.gl.packerMd : _n(gl.packerMd);
        if (!(pk > 0)) pk = _fin(shoe) ? shoe : mid;
        if (!(pk > 0)) return null;
        var csgAt = function (md) { var b = null; strings.forEach(function (s) { if (s && (s.kind === 'casing' || s.kind === 'liner') && +s.topMd <= md + 1e-6 && +s.botMd >= md - 1e-6 && +s.id > 0 && (b == null || +s.id < b)) b = +s.id; }); return b; };
        var tbgAt = function (md) { var b = null; strings.forEach(function (s) { if (s && s.kind === 'tubing' && +s.topMd <= md + 1e-6 && +s.botMd >= md - 1e-6 && +s.od > 0) b = Math.max(b || 0, +s.od); }); return b; };
        var N = Math.max(8, Math.min(120, Math.round(o.nodes || DEFAULTS.gaslift.nodes))), md = [], tvd = [], T = [], A = [], bad = false;
        for (var j = 0; j <= N; j++) {
            var m = pk * j / N; md.push(m); tvd.push(W && typeof W.tvdAt === 'function' ? W.tvdAt(m) : m); T.push(_tAtMd(sim, m));
            if (j < N) { var mm = pk * (j + 0.5) / N, dc = csgAt(mm), dt = tbgAt(mm); if (!(dc > 0 && dt > 0 && dc > dt)) { bad = true; A.push(0); } else A.push(Math.PI / 4 * (dc * dc - dt * dt) / 144); }
        }
        if (bad) return { ok: false, code: 'GL_NO_ANNULUS', packerMd: pk };
        // cumulative ∫ dtvd / T_R from the surface (for the gas column) and the volume above each node
        var I = [0], Vab = [0];
        for (var k = 1; k <= N; k++) { I.push(I[k - 1] + (tvd[k] - tvd[k - 1]) * 0.5 * (1 / (T[k] + RANK) + 1 / (T[k - 1] + RANK))); Vab.push(Vab[k - 1] + A[k - 1] * (md[k] - md[k - 1])); }
        return { ok: true, N: N, md: md, tvd: tvd, T: T, A: A, I: I, Vab: Vab, V: Vab[N], packerMd: pk };
    }
    // MD of the liquid top for a liquid volume V_al measured from the packer upward
    function _zL(an, Val) {
        var Vg = an.V - Math.max(0, Math.min(an.V, Val));
        if (Vg <= 0) return 0;
        for (var k = 1; k <= an.N; k++) if (an.Vab[k] >= Vg - 1e-12) { var a = an.Vab[k - 1], f = an.A[k - 1] > 0 ? (Vg - a) / an.A[k - 1] : 0; return an.md[k - 1] + f; }
        return an.packerMd;
    }
    function _interpNode(an, key, md) {
        if (md <= 0) return an[key][0];
        if (md >= an.packerMd) return an[key][an.N];
        var x = md / an.packerMd * an.N, j = Math.min(an.N - 1, Math.floor(x)), f = x - j;
        return an[key][j] + (an[key][j + 1] - an[key][j]) * f;
    }
    // the gas column of the annulus: {a: 0.01875·γ/z̄ (1/ft·°R), z} for a surface pressure p_cs over the gas column to z_L (one Z iteration)
    function _col(an, sg, pcs, zL) {
        var tvdL = _interpNode(an, 'tvd', zL), IL = _interpNode(an, 'I', zL), tTop = an.T[0], tL = _interpNode(an, 'T', zL);
        var Tbar = 0.5 * (tTop + tL), z = _z(sg, pcs, Tbar);
        var pBot = pcs * Math.exp(0.01875 * sg * IL / z);
        z = _z(sg, 0.5 * (pcs + pBot), Tbar);
        return { a: 0.01875 * sg / z, z: z, tvdL: tvdL, IL: IL };
    }
    // casing pressure (psia) at a TVD for the annulus state {pcs psia, zL MD, rhoL lbm/ft³}
    function casingP(an, st, sg, md) {
        var c = st.col || _col(an, sg, st.pcs, st.zL), I = _interpNode(an, 'I', md);
        if (md <= st.zL) return st.pcs * Math.exp(c.a * I);
        var pL = st.pcs * Math.exp(c.a * c.IL), tvd = _interpNode(an, 'tvd', md);
        return pL + st.rhoL * Math.max(0, tvd - c.tvdL) / 144;
    }
    // the lift-gas mass (lbm) of the gas column above z_L at p_cs: Σ A·L·2.7·γ·p̄/(z̄·T_R)
    function _gasMass(an, sg, pcs, zL, col) {
        var c = col || _col(an, sg, pcs, zL), m = 0;
        for (var j = 0; j < an.N; j++) {
            var top = an.md[j], bot = Math.min(an.md[j + 1], zL);
            if (bot <= top) break;
            var mdm = 0.5 * (top + bot), Im = _interpNode(an, 'I', mdm), Tm = _interpNode(an, 'T', mdm);
            m += an.A[j] * (bot - top) * 2.6995 * sg * pcs * Math.exp(c.a * Im) / (c.z * (Tm + RANK));
        }
        return m;
    }
    // p_cs (psia) from the lift-gas mass (lbm) and z_L: m = p_cs·φ(z̄), two passes on z̄
    function _pcsFromMass(an, sg, m, zL, guess) {
        if (!(zL > 1e-6)) return guess;
        var p = guess > 0 ? guess : 500;
        for (var it = 0; it < 12; it++) { var c = _col(an, sg, p, zL), phi = _gasMass(an, sg, 1, zL, c); if (!(phi > 0)) return p; var pn = m / phi; if (Math.abs(pn - p) < 1e-9 * p) { p = pn; break; } p = pn; }
        return Math.max(1, p);
    }
    function valveBalance(v, pc, pt, open) {
        // IPO valve in gauge (R23): p_vo = (p_d − R·p_t,g)/(1 − R), p_vc = p_d; orifice always open; dummy shut
        if (v.kind === 'dummy') return { open: false, pvo: NaN, pvc: NaN };
        if (v.kind === 'orifice' || !_fin(v.pd)) return { open: true, pvo: NaN, pvc: NaN };
        var pcg = pc - PATM, ptg = pt - PATM, pvo = (v.pd - v.R * ptg) / (1 - v.R), pvc = v.pd;
        var now = open ? pcg >= pvc : pcg >= pvo;
        return { open: now, pvo: pvo, pvc: pvc };
    }
    function _glSpec(sim, opts) {
        var M = sim.M, gl = (M.lift && M.lift.gl) || {}, x = (opts && opts.ext && opts.ext.gaslift) || {};
        var valves = Array.isArray(gl.valves) ? gl.valves.filter(function (v) { return v && _fin(+v.md) && +v.md > 0; }) : [];
        var q0 = sim.C.gl && _fin(sim.C.gl.qinj) ? sim.C.gl.qinj : (_n(gl.qinj_Mscfd) || 0);
        var pinj = _n(gl.pinj_psig), d = gl.design || {};
        var pko = _n(d.pko_psig) > 0 ? _n(d.pko_psig) : (pinj > 0 ? pinj + DEFAULTS.gaslift.pkoAbove_psi : null);
        var mode = x.mode === 'nodal' || x.mode === 'valves' ? x.mode : (valves.length ? 'valves' : 'nodal');
        return { mode: mode, throttle: x.throttle !== false, valves: valves, qinj: q0, pinj: pinj, pko: _fin(+x.pko_psig) ? +x.pko_psig : pko, sg: sim.k.sgI, cdLiq: _fin(+x.cdLiq) ? +x.cdLiq : DEFAULTS.gaslift.cdLiq };
    }
    function _glQ(sim, ctx) {
        var c = sim.state.lift && sim.state.lift.glCmd;
        if (c && _fin(c.qinj_Mscfd)) return Math.max(0, c.qinj_Mscfd);
        return ctx.q0;
    }
    var GASLIFT = {
        label: 'Gas lift: annulus, IPO valves, Thornhill-Craver', verified: false, provisional: PROVISIONAL,
        applies: function (M) { return !!M && !!M.lift && M.lift.type === 'gaslift'; },
        init: function (sim, opts) {
            var sp = _glSpec(sim, opts), S = sim.state, g = sim.grid, k = sim.k;
            var ctx = { mode: sp.mode, throttle: sp.throttle, q0: sp.qinj, pinj: sp.pinj, pko: sp.pko, sg: sp.sg, cdLiq: sp.cdLiq, injCell: g.injCell, valves: [], ann: null, st: null,
                rate: { inj: 0, gas: [], liq: [] }, multiSince: null, opValve: 0, lastOp: 0, transfers: [], pcsHist: [], qSurf: 0, notes: [] };
            if (ctx.mode === 'nodal' && !(g.injCell >= 0)) {
                if (sp.valves.length) ctx.mode = 'valves';
                else { ctx.injCell = g.cells.length - 1; ctx.notes.push('no nodal injection depth: the lift gas enters the top cell'); }
            }
            if (ctx.mode === 'valves') {
                var an = annulus(sim);
                if (!an || !an.ok) { ctx.mode = 'nodal'; ctx.notes.push('no annulus in the strings table (casing around the tubing to the packer): nodal injection'); if (!(ctx.injCell >= 0)) ctx.injCell = g.cells.length - 1; }
                else {
                    ctx.ann = an;
                    ctx.valves = sp.valves.slice().sort(function (a, b) { return +a.md - +b.md; }).map(function (v, i) {
                        var md = +v.md, fk = _faceAtMd(g, md), cell = Math.min(g.n - 1, Math.max(0, fk)), T = _tAtMd(sim, md), port = _n(v.port) > 0 ? _n(v.port) : 16;
                        var R = _n(v.R) > 0 && _n(v.R) < 0.5 ? _n(v.R) : (G.WTS_wp_gl && G.WTS_wp_gl.portR ? G.WTS_wp_gl.portR(port) : 0.0637);
                        var kind = v.kind === 'orifice' || v.kind === 'dummy' ? v.kind : 'ipo', ptro = _n(v.ptro);
                        var pd = (kind === 'ipo' && _fin(ptro) && G.WTS_wp_gl && typeof G.WTS_wp_gl.pdAt === 'function') ? G.WTS_wp_gl.pdAt(ptro, R, T) : null;
                        return { n: i + 1, md: md, tvd: g.faces[fk] ? g.faces[fk].tvd : md, face: fk, cell: cell, port: port, R: R, kind: kind, ptro: ptro, pd: _fin(pd) ? pd : null, T: T,
                            open: false, passing: null, q: 0, pc: NaN, pt: NaN, pvo: NaN, pvc: NaN };
                    });
                    var rhoW = 62.366 * (sim.C.F.sgw || 1.07);
                    var stc = { pcs: NaN, zL: an.packerMd, Val: 0, m: 0, rhoL: rhoW };
                    var kind = opts && opts.start === 'static' ? ((opts.static && opts.static.kind) || 'gas') : (opts && opts.start === 'snapshot' ? 'snap' : 'steady');
                    if (kind === 'steady') { stc.pcs = (_fin(sp.pinj) ? sp.pinj : (S.surface.thp_psig || 0)) + PATM; stc.zL = an.packerMd; stc.Val = 0; }
                    else if (kind === 'liquid' || kind === 'level') {
                        // killed: the annulus full of the model's water up to a small gas cap at the tubing-head pressure
                        var cap = kind === 'level' && opts.static && _fin(+opts.static.liquidTopMd) ? Math.min(an.packerMd, +opts.static.liquidTopMd) : DEFAULTS.gaslift.staticCap_ft;
                        stc.zL = cap; stc.Val = an.V - _interpNode(an, 'Vab', cap); stc.pcs = sim.fs.p[sim.n];
                    } else { stc.pcs = sim.fs.p[sim.n]; stc.zL = an.packerMd; stc.Val = 0; }
                    if (!(stc.pcs > 0)) stc.pcs = (S.psep_psig || 0) + PATM;
                    stc.col = _col(an, sp.sg, stc.pcs, stc.zL); stc.m = _gasMass(an, sp.sg, stc.pcs, stc.zL, stc.col);
                    ctx.st = stc;
                    // the valve states at t = 0 from the initial pressures (a killed well has every submerged valve open)
                    ctx.valves.forEach(function (v) { var pc = casingP(an, stc, sp.sg, v.md), pt = sim.fs.p[v.face]; var b = valveBalance(v, pc, pt, false); v.open = b.open; v.pc = pc; v.pt = pt; v.pvo = b.pvo; v.pvc = b.pvc; });
                    _mark(sim, 'gl_valves');
                }
            }
            if (ctx.mode === 'nodal') _mark(sim, 'liftgas_mix');
            ctx.qSurf = _glQ(sim, ctx);
            _publishGl(sim, ctx);
            return ctx;
        },
        sources: function (sim, ctx, dt) {
            var n = sim.n, k = sim.k, S = sim.state, q = _glQ(sim, ctx);
            if (ctx.mode === 'nodal') {
                ctx.qSurf = q;
                if (!(q > 0)) return null;
                var a = new Float64Array(n); a[ctx.injCell] = q * 1000 / 86400 * k.I;
                return { I: a };
            }
            var an = ctx.ann, st = ctx.st, sg = ctx.sg, fs = sim.fs, X = sim.X;
            // surface injection: constant q while the casing is below the kickoff pressure
            var qs = (_fin(ctx.pko) && st.pcs - PATM >= ctx.pko) ? 0 : q;
            ctx.qSurf = qs;
            ctx.rate.inj = qs * 1000 / 86400 * k.I;
            st.col = _col(an, sg, st.pcs, st.zL);
            var Vg = Math.max(1e-6, an.V - st.Val), I = new Float64Array(n), Wt = new Float64Array(n), any = false, gasR = [], liqR = [], totLiq = 0, totGas = 0;
            ctx.valves.forEach(function (v, i) {
                var pc = casingP(an, st, sg, v.md), pt = fs.p[v.face], b = valveBalance(v, pc, pt, v.open);
                if (b.open !== v.open) _emit(sim, 'valve', { n: v.n, open: b.open, passing: v.passing, t: S.t });
                v.open = b.open; v.pc = pc; v.pt = pt; v.pvo = b.pvo; v.pvc = b.pvc; v.T = _tAtMd(sim, v.md);
                gasR[i] = 0; liqR[i] = 0;
                // the valve throughput follows its target with a lag of TAU_VALVE (provisional, integration fix §11.7): an explicit valve
                // rate that jumps with the lagged tubing pressure of a liquid-full string chattered step to step, a jump the
                // pressure-change limit cannot halve away (the runs ended STEP_FAIL); a lagged rate changes by dt / τ per step
                var wf = Math.min(1, dt / TAU_VALVE), fG = _fin(v.qfG) ? v.qfG : 0, fL = _fin(v.qfL) ? v.qfL : 0;
                if (!(pc > pt)) return;                                   // no reverse flow: the rate stops at once
                if (!v.open) {
                    // a closed valve's throughput decays over τ and stops below 0.1 % of the surface injection (gas) or 0.1 bbl/d (liquid)
                    var dG = fG * (1 - wf), dL = fL * (1 - wf);
                    if (dG > 1e-3 * Math.max(ctx.q0 || 0, 1) * 1000 / 86400 * k.I) gasR[i] = dG;
                    if (dL > 0.1 * FT3 / 86400) liqR[i] = dL;
                    return;
                }
                var dpv = pc - pt;
                if (v.md < st.zL) {
                    var t = G.WTS_wp_gl && G.WTS_wp_gl.tc ? G.WTS_wp_gl.tc({ port64: v.port, p1: pc, p2: pt, T: v.T, sg: sg }) : null;
                    // throttling (provisional): the stem travel and the effective port area grow linearly from the closing to the opening
                    // pressure (full port at and above p_vo) — an on / off valve cycles open and shut when its port passes more than the surface
                    // injection; a throttling one settles where it passes the injected gas
                    var thr = ctx.throttle && v.kind === 'ipo' && _fin(b.pvo) && b.pvo > b.pvc ? _clamp((pc - PATM - b.pvc) / (b.pvo - b.pvc), 0, 1) : 1;
                    v.thr = thr;
                    var qm = t && t.ok ? thr * t.q * 1000 / 86400 * k.I : 0;                           // lbm/s
                    // stable explicit coupling: one step never removes more gas than lowers p_c − p_t by half
                    var lim = 0.5 * dpv / Math.max(1, st.pcs) * st.m / Math.max(1e-9, dt);
                    gasR[i] = Math.max(0, Math.min(fG + (qm - fG) * wf, lim)); totGas += gasR[i];
                } else {
                    var A = Math.PI / 4 * Math.pow(v.port / 64, 2) / 144, rho = X.rhoW[v.cell] > 0 ? X.rhoW[v.cell] : st.rhoL;
                    var ql = ctx.cdLiq * A * Math.sqrt(2 * GC * 144 * dpv / rho);                   // ft³/s
                    var limL = 0.5 * dpv * Vg / Math.max(1, st.pcs) / Math.max(1e-9, dt);
                    liqR[i] = Math.max(0, Math.min(fL + (ql - fL) * wf, limL, st.Val / Math.max(1e-9, dt))); totLiq += liqR[i];
                }
            });
            totGas = 0; totLiq = 0; gasR.forEach(function (x) { totGas += x; }); liqR.forEach(function (x) { totLiq += x; });
            // the totals stay within the annulus contents
            if (totLiq * dt > st.Val && totLiq > 0) { var f1 = st.Val / (totLiq * dt); liqR = liqR.map(function (x) { return x * f1; }); totLiq *= f1; }
            if (totGas * dt > 0.9 * st.m && totGas > 0) { var f2 = 0.9 * st.m / (totGas * dt); gasR = gasR.map(function (x) { return x * f2; }); totGas *= f2; }
            ctx.valves.forEach(function (v, i) {
                var was = v.passing;
                v.passing = gasR[i] > 0 ? 'gas' : (liqR[i] > 0 ? 'liquid' : null);
                v.q = gasR[i] > 0 ? gasR[i] / k.I * 86400 / 1000 : (liqR[i] > 0 ? liqR[i] * 86400 / FT3 : 0);    // Mscf/d or bbl/d
                if (was !== v.passing) _emit(sim, 'valve', { n: v.n, open: v.open, passing: v.passing, t: S.t });
                if (gasR[i] > 0) { I[v.cell] += gasR[i]; any = true; }
                if (liqR[i] > 0) { var rhoW = X.rhoW[v.cell] > 0 ? X.rhoW[v.cell] : st.rhoL; Wt[v.cell] += liqR[i] * rhoW; any = true; }
            });
            ctx.rate.gas = gasR; ctx.rate.liq = liqR; ctx.rate.liqRho = st.rhoL;
            return any ? { I: I, W: Wt } : null;
        },
        after: function (sim, ctx, info) {
            var S = sim.state, dt = info.dt;
            if (ctx.mode === 'valves') {
                var an = ctx.ann, st = ctx.st, sg = ctx.sg, gs = 0, ls = 0;
                (ctx.rate.gas || []).forEach(function (x) { gs += x; }); (ctx.rate.liq || []).forEach(function (x) { ls += x; });
                ctx.valves.forEach(function (v, i) { v.qfG = (ctx.rate.gas || [])[i] || 0; v.qfL = (ctx.rate.liq || [])[i] || 0; });   // the lagged rates (§11.7)
                st.m = Math.max(1e-9, st.m + (ctx.rate.inj - gs) * dt);
                st.Val = Math.max(0, st.Val - ls * dt);
                st.zL = _zL(an, st.Val);
                if (st.zL <= 0) st.zL = 1e-3;
                st.pcs = _pcsFromMass(an, sg, st.m, st.zL, st.pcs);
                st.col = _col(an, sg, st.pcs, st.zL);
                // operating valve = the deepest valve passing gas; transfers are recorded with the casing pressure
                var op = 0, nGas = 0;
                ctx.valves.forEach(function (v) { if (v.passing === 'gas') { nGas++; op = v.n; } });
                if (op !== ctx.lastOp && op > 0) { ctx.transfers.push({ t: S.t, from: ctx.lastOp, to: op, pcs_psig: st.pcs - PATM }); if (ctx.transfers.length > 40) ctx.transfers.shift(); ctx.lastOp = op; }
                ctx.opValve = op;
                if (nGas > 1) { if (ctx.multiSince == null) ctx.multiSince = S.t; } else ctx.multiSince = null;
                if (!ctx.pcsHist.length || S.t - ctx.pcsHist[ctx.pcsHist.length - 1][0] >= 30) { ctx.pcsHist.push([S.t, st.pcs - PATM]); if (ctx.pcsHist.length > 480) ctx.pcsHist.shift(); }
            }
            _publishGl(sim, ctx);
        },
        label: function (sim, ctx) {
            var S = sim.state;
            S.surface.qinj = ctx.qSurf;                    // the engine's surface pass resets it every step (recorded in §11.4)
            if (!_isOpen(sim)) return null;
            if (ctx.mode === 'nodal') return ctx.qSurf > 0 ? { state: 'gl_lifting', reason: 'lift gas injected at ' + Math.round(sim.grid.cells[ctx.injCell].md0) + ' ft MD (nodal injection point)' } : null;
            var liq = ctx.valves.some(function (v) { return v.passing === 'liquid'; });
            var deepest = 0; ctx.valves.forEach(function (v) { if (v.kind !== 'dummy') deepest = v.n; });
            if (liq || (ctx.st.Val > 1e-3 && ctx.st.zL < (ctx.valves.length ? ctx.valves[ctx.valves.length - 1].md : 0) && !ctx.opValve)) return { state: 'gl_unloading', reason: 'annulus liquid passing into the tubing (liquid top ' + Math.round(ctx.st.zL) + ' ft MD)' };
            if (ctx.multiSince != null && S.t - ctx.multiSince >= DEFAULTS.multipoint_s) return { state: 'gl_multipoint', reason: 'more than one valve passes gas' };
            if (ctx.opValve > 0) return { state: 'gl_lifting', reason: 'lifting from valve ' + ctx.opValve + (ctx.opValve < deepest ? ' (above the deepest valve)' : '') };
            return null;
        },
        snapshot: function (ctx) { var c = _clone(ctx); if (c.st) delete c.st.col; return c; },
        restore: function (j) { return _clone(j); }
    };
    function _publishGl(sim, ctx) {
        var S = sim.state, out = { mode: ctx.mode, qinj: ctx.qSurf, sg: ctx.sg, opValve: ctx.opValve || 0, notes: ctx.notes.slice() };
        if (ctx.mode === 'nodal') {
            out.injMd = sim.grid.cells[ctx.injCell] ? sim.grid.cells[ctx.injCell].md0 : null;
            out.pcs_psig = _fin(ctx.pinj) ? ctx.pinj : NaN; out.pcs = out.pcs_psig + PATM;
        } else {
            var st = ctx.st;
            out.pcs = st.pcs; out.pcs_psig = st.pcs - PATM; out.liqTopMd = st.zL; out.annLiq_bbl = st.Val / FT3; out.liftGasAnn_lbm = st.m; out.packerMd = ctx.ann.packerMd;
            out.pko_psig = ctx.pko; out.multi = ctx.multiSince != null; out.transfers = ctx.transfers.slice();
            out.valves = ctx.valves.map(function (v) { return { n: v.n, md: v.md, kind: v.kind, port: v.port, open: v.open, passing: v.passing, q: v.q, pc_psig: v.pc - PATM, pt_psig: v.pt - PATM, pvo_psig: v.pvo, pvc_psig: v.pvc }; });
            out.qinjValves = 0; ctx.valves.forEach(function (v) { if (v.passing === 'gas') out.qinjValves += v.q; });
        }
        S.lift.gl = out;
    }

    // ── ESP (§4.12, R10) ────────────────────────────────────────────────────────────────────────────────────────────
    function _pf(P, f) { var c = {}; for (var k in P) if (Object.prototype.hasOwnProperty.call(P, k)) c[k] = P[k]; c.f = f; return c; }
    // the stock-tank stream {qo, qw, qg_Mscfd} through the pump face at the in-situ flux Q (ft³/s): the lagged face stream scaled to Q, else
    // the intake cell's composition per in-situ volume
    function _pumpStream(sim, k, Q) {
        var fs = sim.fs, cs = sim.cs, K = sim.k, X = sim.X, Ql = fs.Q[k];
        var qo, qw, qg;
        if (Ql > 1e-6 && (fs.FO[k] + fs.FW[k] + fs.FG[k]) > 0) {
            var s = Q / Ql; qo = fs.FO[k] / K.O * 86400 * s; qw = fs.FW[k] / K.W * 86400 * s; qg = fs.FG[k] / K.G * 86400 / 1000 * s;
        } else {
            var c = Math.max(0, k - 1), V = X.Vc[c] > 0 ? X.Vc[c] : X.vol[c], r = Math.max(0, Q) / V * 86400;
            qo = cs.mO[c] / K.O * r; qw = cs.mW[c] / K.W * r; qg = cs.mG[c] / K.G / 1000 * r;
        }
        return { qo: Math.max(0, qo), qw: Math.max(0, qw), qg_Mscfd: Math.max(0, qg) };
    }
    function pumpDp(sim, ctx, Q) {
        var k = sim.grid.pumpFace, P = sim.C.esp, F = sim.C.F;
        if (!(ctx.f >= 1)) return null;
        var pInt = sim.fs.p[k], T = sim.cs.T[Math.max(0, k - 1)];
        var st = G.WTS_wp_esp.pump(_pf(P, ctx.f), F, _pumpStream(sim, k, Q), pInt, T);
        return st && st.ok ? st : null;
    }
    function _motorHp(sim) {
        var P = sim.C.esp, m = P.motor || {};
        if (m.hp > 0) return { hp: m.hp, assumed: false };
        var c = G.WTS_wp_esp.curve(P.pump, P.pump.f0), b = c ? c.bhp(c.bep.q, 1) * P.N : null;
        return { hp: _fin(b) && b > 0 ? DEFAULTS.esp.motorFactor * b : 100, assumed: true };
    }
    var ESP = {
        label: 'ESP: ramp, motor lag and trips', verified: false, provisional: PROVISIONAL,
        applies: function (M) { return !!M && !!M.lift && M.lift.type === 'esp'; },
        init: function (sim, opts) {
            var P = sim.C.esp, x = (opts && opts.ext && opts.ext.esp) || {};
            if (!P || !P.ok || !(sim.grid.pumpFace >= 0) || !G.WTS_wp_esp || typeof G.WTS_wp_esp.pump !== 'function') return { off: true };
            var steady = !opts || opts.start === 'steady' || opts.start == null;
            var on = x.on != null ? !!x.on : steady, f0 = _fin(+x.freq) ? +x.freq : P.f;
            var mh = _motorHp(sim);
            var ctx = { f: on ? f0 : 0, fDrive: on ? f0 : 0, fCmd: on ? f0 : 0, ramp: _fin(+x.ramp_Hz_s) && +x.ramp_Hz_s > 0 ? +x.ramp_Hz_s : DEFAULTS.esp.ramp_Hz_s, on: on, cmdKey: null,
                tripped: null, tripNow: false, tPumpoff: null, tGas: null, tUnder: null, motorHp: mh.hp, motorAssumed: mh.assumed, vent: 0, st: null, qBep0: P.pump.bep.q };
            _mark(sim, 'esp_node'); _mark(sim, 'esp_start');
            _publishEsp(sim, ctx);
            return ctx;
        },
        control: function (sim, ctx, t) {
            if (ctx.off) return null;
            var S = sim.state, c = S.lift.espCmd, out = null;
            if (c) {
                var key = JSON.stringify(c);
                if (key !== ctx.cmdKey) {
                    ctx.cmdKey = key;
                    if (c.on === false) { ctx.on = false; ctx.fCmd = 0; }
                    else { ctx.on = true; ctx.tripped = null; ctx.fCmd = _fin(c.freq) && c.freq > 0 ? c.freq : sim.C.esp.f; if (_fin(c.ramp_Hz_s) && c.ramp_Hz_s > 0) ctx.ramp = c.ramp_Hz_s; ctx.tUnder = ctx.tPumpoff = ctx.tGas = null; }
                }
            }
            if (ctx.tripNow) {
                ctx.tripNow = false; ctx.on = false; ctx.fCmd = 0;
                _emit(sim, 'trip', { kind: ctx.tripped, t: t });
                out = [{ type: 'esp', args: { on: false, freq: 0, ramp_Hz_s: null, trip: ctx.tripped }, src: 'controller' }];
                ctx.cmdKey = JSON.stringify({ on: false, freq: 0, ramp_Hz_s: null });
            }
            return out;
        },
        sources: function (sim, ctx) {
            if (ctx.off || !(ctx.vent > 0)) return null;
            var k = sim.grid.pumpFace, c = Math.max(0, k - 1), K = sim.k, cs = sim.cs, dtG = ctx.vent * 1000 / 86400 * K.G;
            var a = new Float64Array(sim.n); a[c] = -Math.min(dtG, 0.5 * cs.mG[c] / Math.max(1, sim.dtPrev || 1));
            return { G: a };
        },
        // the step is capped while the drive ramps or the motor lags (≤ 1 Hz of frequency change per step, ≥ 0.25 s)
        dtLimit: function (sim, ctx) {
            if (ctx.off) return null;
            var d = Math.abs(ctx.fCmd - ctx.f), lv = ctx.lockLvl || 0;
            if (lv > 1e-6 && lv < 1 - 1e-6) return 1;
            if (d < 0.05) return null;
            return Math.max(0.25, Math.min(1 / Math.max(1e-6, ctx.ramp), d > 1 ? 1 / ctx.ramp : DEFAULTS.esp.tauM_s * 2));
        },
        faceDp: function (sim, ctx, k, Q) {
            if (ctx.off || k !== sim.grid.pumpFace) return null;
            var E = DEFAULTS.esp;
            // the engine evaluates dp + ddpdQ·(Q − Q_lag): a closed device anchors its resistance at Q = 0, not at the lagged flux
            if (!(ctx.f >= 1)) { ctx.dpLast = 0; return { dp: -E.kStop * Q, ddpdQ: -E.kStop }; }
            var a = pumpDp(sim, ctx, Q);
            if (!a) { ctx.dpLast = 0; return { dp: -E.kStop * Q, ddpdQ: -E.kStop }; }
            var h = Math.max(1e-4, 0.01 * Math.abs(Q)), b = pumpDp(sim, ctx, Q + h), sl = b ? (b.dp - a.dp) / h : 0;
            if (!(sl < 0)) sl = Math.min(sl, -1e-3);
            // the check valve at the discharge: no back-flow through the pump (the resistance anchored at Q = 0, as the closed pump)
            var cv = Q <= E.qCheck;
            if (cv) sl = Math.min(sl, -E.kCheck);
            // a locked pump (gas lock or pump-off, provisional) loses its head over τ_lock (the impeller spinning in gas or cavitating moves
            // no liquid): the rise fades rather than vanishing in one step (a quasi-steady column above an instantly stopped pump falls by
            // the whole pump rise at once)
            var keep = 1 - _clamp(ctx.lockLvl || 0, 0, 1);
            var dp = a.dp * keep; sl *= keep;
            if (cv) sl = Math.min(sl, -E.kCheck);
            ctx.dpLast = dp;
            if (cv && Q < 0) dp += -E.kCheck * Q;
            return { dp: dp, ddpdQ: sl };
        },
        after: function (sim, ctx, info) {
            if (ctx.off) return;
            var S = sim.state, dt = info.dt, E = DEFAULTS.esp;
            // the drive ramps toward the command; the motor follows with a first-order lag
            var d = ctx.fCmd - ctx.fDrive, mx = ctx.ramp * dt;
            ctx.fDrive += Math.abs(d) <= mx ? d : (d > 0 ? mx : -mx);
            ctx.f = ctx.fDrive + (ctx.f - ctx.fDrive) * Math.exp(-dt / E.tauM_s);
            if (ctx.f < 0.05 && ctx.fDrive === 0) ctx.f = 0;
            var k = sim.grid.pumpFace, st = ctx.f >= 1 ? pumpDp(sim, ctx, Math.max(E.qCheck, sim.fs.Q[k])) : null;
            ctx.st = st; ctx.vent = st && sim.C.esp.natSep ? (st.ventMscfd || 0) : (st && sim.C.esp.sepEff > 0 ? (st.ventMscfd || 0) : 0);
            S.surface.qvent = ctx.vent;
            var pInt = sim.fs.p[k], hp = ctx.motorHp * Math.max(0, ctx.f) / (sim.C.esp.pump.f0 || 60), load = st && hp > 0 ? st.bhp / hp : 0;
            ctx.load = load; ctx.pInt = pInt;
            // trips and flags (ASSUMED thresholds, provisional)
            var t = S.t, qb = ctx.qBep0 * ctx.f / (sim.C.esp.pump.f0 || 60), run = ctx.f > E.pumpoff.fMin;
            var poff = run && (pInt < E.pumpoff.pInt_psia || (st && st.Qin < E.pumpoff.qFrac * qb));
            ctx.tPumpoff = poff ? (ctx.tPumpoff == null ? t : ctx.tPumpoff) : null;
            // hydraulic gas lock (provisional): above the lock fraction the pump stops moving liquid; it restarts when the intake holds liquid
            // again (the gas fraction of the intake cell's contents below the label threshold, after 30 s)
            var gv = st ? st.gvfIn : 0;
            // pump-off (provisional): the intake drawn below p_lock (the liquid level at the pump: the pump cavitates and stops moving liquid);
            // it restarts once the intake has recovered above p_restart (the level built back), after an idle time of 15 min — a pump-off cycle
            if (!ctx.locked && run && st && gv > E.gaslock.lock) { ctx.locked = 'gas'; ctx.tLock = t; _emit(sim, 'trip', { kind: 'gaslock', t: t, restart: true }); }
            else if (!ctx.locked && run && pInt < E.pumpoff.pLock_psia) { ctx.locked = 'pumpoff'; ctx.tLock = t; _emit(sim, 'trip', { kind: 'pumpoff', t: t, restart: true }); }
            else if (ctx.locked === 'gas') { var zc = pumpDp(sim, ctx, E.qCheck), gc = zc ? zc.gvfIn : 1; if (gc < E.gaslock.gvf && t - ctx.tLock >= E.gaslock.relock_s) { ctx.locked = false; ctx.dpLast = NaN; } }
            else if (ctx.locked === 'pumpoff' && pInt > E.pumpoff.pRestart_psia && t - ctx.tLock >= E.pumpoff.idle_s) { ctx.locked = false; ctx.dpLast = NaN; }
            if (ctx.locked === 'pumpoff') ctx.tPumpoff = ctx.tPumpoff == null ? t : ctx.tPumpoff;
            var lt = ctx.locked ? 1 : 0, lv0 = ctx.lockLvl || 0, ls = dt / E.lockTau_s;
            ctx.lockLvl = lt > lv0 ? Math.min(lt, lv0 + ls) : Math.max(lt, lv0 - ls);
            var gl = run && st && (st.gvfIn > E.gaslock.gvf || ctx.locked);
            ctx.tGas = gl ? (ctx.tGas == null ? t : ctx.tGas) : null;
            var ul = ctx.f > E.underload.fMin && Math.abs(ctx.f - ctx.fCmd) < 0.5 && load < E.underload.load;
            ctx.tUnder = ul ? (ctx.tUnder == null ? t : ctx.tUnder) : null;
            if (ctx.tUnder != null && t - ctx.tUnder >= E.underload.hold_s && !ctx.tripped) { ctx.tripped = 'underload'; ctx.tripNow = true; }
            _publishEsp(sim, ctx);
        },
        label: function (sim, ctx) {
            if (ctx.off) return null;
            var S = sim.state, E = DEFAULTS.esp, t = S.t;
            if (ctx.tripped) return { state: 'esp_tripped', reason: 'motor underload trip (load below ' + Math.round(E.underload.load * 100) + ' % for ' + E.underload.hold_s + ' s)' };
            if (!(ctx.f >= 1) && !(ctx.fCmd > 0)) return { state: 'esp_off', reason: 'pump stopped' };
            if (Math.abs(ctx.f - ctx.fCmd) > 0.5) return { state: 'esp_ramp', reason: 'ramping to ' + ctx.fCmd.toFixed(1) + ' Hz' };
            if (ctx.locked === 'pumpoff' || (ctx.tPumpoff != null && t - ctx.tPumpoff >= E.pumpoff.hold_s)) return { state: 'esp_pumpoff', reason: 'pump-off: intake ' + Math.round(ctx.pInt) + ' psia' };
            if (ctx.locked === 'gas' || (ctx.tGas != null && t - ctx.tGas >= E.gaslock.hold_s)) return { state: 'esp_gaslock', reason: (ctx.locked === 'gas' ? 'gas-locked: no liquid pumped' : 'gas lock risk') + ': intake gas fraction above ' + Math.round(E.gaslock.gvf * 100) + ' %' };
            return { state: 'esp_running', reason: 'pump running at ' + ctx.f.toFixed(1) + ' Hz' };
        },
        snapshot: function (ctx) { var c = _clone(ctx); if (c) delete c.st; return c; },
        restore: function (j) { var c = _clone(j); if (c) c.st = null; return c; }
    };
    function _publishEsp(sim, ctx) {
        var st = ctx.st, k = sim.grid.pumpFace;
        sim.state.lift.esp = { on: !!ctx.on, freq: ctx.f, fCmd: ctx.fCmd, fDrive: ctx.fDrive, pint: sim.fs.p[k], pdis: st ? st.pDis : NaN, dp: st ? st.dp : 0, Qin: st ? st.Qin : 0,
            gvf: st ? st.gvfIn : 0, phi: st ? st.phi : 0, bhp: st ? st.bhp : 0, load: _fin(ctx.load) ? ctx.load : 0, vent_Mscfd: ctx.vent || 0, rangeStatus: st ? st.rangeStatus : null,
            tripped: ctx.tripped || null, motorHp: ctx.motorHp, motorAssumed: !!ctx.motorAssumed, pumpMd: sim.grid.faces[k] ? sim.grid.faces[k].md : null };
    }

    // ── a plain-text description of the lift state (page, reports) ───────────────────────────────────────────────────
    function describe(sim) {
        if (!sim || !sim.state) return [];
        var S = sim.state, L = S.lift || {}, out = [];
        if (L.gl) {
            var g = L.gl;
            if (g.mode === 'nodal') out.push('Gas lift (nodal injection point): ' + Math.round(g.qinj || 0) + ' Mscf/d at ' + Math.round(g.injMd || 0) + ' ft MD.');
            else {
                out.push('Gas lift (installed valves): casing ' + Math.round(g.pcs_psig) + ' psig, ' + Math.round(g.qinj || 0) + ' Mscf/d at surface, annulus liquid top ' + Math.round(g.liqTopMd || 0) + ' ft MD (' + (g.annLiq_bbl || 0).toFixed(1) + ' bbl).');
                (g.valves || []).forEach(function (v) { out.push('Valve ' + v.n + ' at ' + Math.round(v.md) + ' ft MD: ' + (v.open ? 'open' : 'closed') + (v.passing ? ', passing ' + v.passing + ' ' + Math.round(v.q) + (v.passing === 'gas' ? ' Mscf/d' : ' bbl/d') : '') + '.'); });
            }
        }
        if (L.esp) { var e = L.esp; out.push('ESP: ' + (e.freq || 0).toFixed(1) + ' Hz (command ' + (e.fCmd || 0).toFixed(1) + ' Hz), intake ' + Math.round(e.pint || 0) + ' psia, load ' + Math.round((e.load || 0) * 100) + ' %' + (e.tripped ? ', tripped (' + e.tripped + ')' : '') + '.'); }
        if (S.foamer && S.foamer.on) out.push('Foamer: ' + Math.round(S.foamer.ppm || 0) + ' ppm, surface-tension factor ' + (_fin(S.foamer.eff) ? S.foamer.eff.toFixed(2) : '1.00') + ' at the end of the tubing.');
        if (L.cycle && L.cycle.mode && L.cycle.mode !== 'off') out.push('Intermittent (' + L.cycle.mode + '): cycle ' + L.cycle.n + ', ' + L.cycle.phase + '.');
        if (L.heading && L.heading.heading) out.push('Heading: ' + L.heading.pairs + ' THP peak pairs, period ' + Math.round((L.heading.period_s || 0) / 60) + ' min.');
        return out;
    }

    // ── the static water level of a killed well (a preset helper) ───────────────────────────────────────────────────────
    // the MD where a column of the model's water from p̄r at the mid-perforations reaches the separator pressure, 150 ft shallower (slightly
    // overbalanced: a level below the balance pushes the gas cap out through the choke at the start). → {md, tvd} | null
    function balanceLevel(M) {
        if (!M || !M.res || !M.well || !M.fluid) return null;
        var W = G.WTS_wp_well && typeof G.WTS_wp_well.build === 'function' ? G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type || 'oil', surface: M.surface }) : null;
        if (!W || !W.ok || !W.nodes || typeof W.tvdAt !== 'function') return null;
        var pr = +M.res.pr, psep = ((M.surface && +M.surface.psep_psig) || 0) + PATM, grad = 0.433 * (+M.fluid.sgw || 1.07);
        // a well with no choke flows against its fixed wellhead pressure: the column balances against that (integration fix, §11.7)
        var thpF = M.surface && M.surface.choke && M.surface.choke.present === false && M.system && M.system.thp_psig != null ? +M.system.thp_psig : NaN;
        if (_fin(thpF) && thpF + PATM > psep) psep = thpF + PATM;
        if (!(pr > psep)) return null;
        var midTvd = W.tvdAt(W.nodes.midPerfMd), tvd = midTvd - (pr - psep) / grad - 150;
        if (!(tvd > 0)) return { md: 0, tvd: 0 };
        var md = typeof W.mdAt === 'function' ? W.mdAt(tvd) : tvd;
        return _fin(md) ? { md: md, tvd: tvd } : null;
    }

    // ── register ────────────────────────────────────────────────────────────────────────────────────────────────────
    var EN = G.WTS_wd_engine = G.WTS_wd_engine || {};
    EN.ext = EN.ext || {};
    // the extension keys are set here, not as object-literal keys (a literal key of a registry page name would make the help-guide source
    // hash of that page include this file)
    [['foamer', FOAMER], ['cycle', CYCLE], ['heading', HEADING], ['gaslift', GASLIFT], ['esp', ESP]].forEach(function (x) { x[1].key = x[0]; EN.ext[x[0]] = x[1]; });
    G.WTS_wd_lift = {
        VERSION: VERSION, DEFAULTS: DEFAULTS, PRESETS: PRESETS, PROVISIONAL: PROVISIONAL, sigmaFactor: sigmaFactor, annulus: annulus, casingP: casingP,
        gasMass: _gasMass, pcsFromMass: _pcsFromMass, column: _col, valveBalance: valveBalance, headingOf: headingOf, pumpDp: pumpDp, pumpStream: _pumpStream,
        describe: describe, balanceLevel: balanceLevel, EXT: ['foamer', 'cycle', 'heading', 'gaslift', 'esp']
    };
})();
// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, L = G.WTS_wd_lift;
    if (!L || Math.abs(L.sigmaFactor(500) - 0.7) > 1e-12 || Math.abs(L.sigmaFactor(0) - 1) > 1e-12) throw new Error('WTS_wd_lift self-test: foamer factor');
    var b = L.valveBalance({ kind: 'ipo', pd: 800, R: 0.1 }, 900 + 14.696, 400 + 14.696, false);
    if (!(b.open && Math.abs(b.pvo - (800 - 40) / 0.9) < 1e-9)) throw new Error('WTS_wd_lift self-test: valve balance');
})();
