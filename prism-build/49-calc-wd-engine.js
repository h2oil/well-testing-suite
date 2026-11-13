// =============================================================================
// WTS — 49-calc-wd-engine.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Dynamics — the transient (time-stepping) well simulator engine (lane WD1). docs/WELL-DYNAMICS-PLAN.md §3.1–§3.6 (contracts),
// §4 (physics), §5.2 (tests EN1–EN30), §5.6 (budgets). Engine only: no DOM, no storage, no timers, no polling, no function wrapping.
// Field units (§3.0): psia inside (psig only where a name says *_psig), °F, ft (MD / TVD), in (diameters), ft² / ft³ (cells), STB/d,
// Mscf/d, lbm, s (time in the API), ft/s, dyn/cm.
//
// THE MODEL (§4). One well from the Well Performance model M (WTS_wp_model.read()), with the solve's own context
// (WTS_wp_system.context(M).C: the fluid F with its (p, T)-binned property table, the inflow I, the well W, the correlation keys, the
// per-section keys, the choke, the VLP-tuning multipliers, the lift context) — never a second fluid build (R18).
//   • Cells along MD from the mid-perforations (cell 0) to the wellhead (cell n − 1) on the marcher segments of the nodal traverse
//     (no cell straddles a bore change, a restriction, a section boundary, the end of tubing, a gas-lift valve, the nodal injection
//     depth or the pump); ΔZ on the segment's straight line (gravity on TVD, friction on MD — as the march).
//   • Conserved per cell: formation gas m_G, stock-tank oil / condensate m_O, water m_W, lift gas m_I (free only), foamer m_F (tracer
//     in the water); lbm. Black-oil flash per cell through the solve's props (WTS_flowline_props on a per-cell view whose GOR is the
//     cell's own ratio and whose oil / water fractions are the cell's — R13).
//   • Drift flux at every face j_g = α_g (C_0 j + v_d): the 'corr' closure sets C_0 = 1 and v_d from the well's gradient correlation
//     (WTS_flowline_gradAt: the march's own call incl. the tuning multipliers) so a steady column has the correlation's holdup; faces with
//     a small or counter-current flux blend into the Zuber-Findlay / Shi et al. drift-flux closure (provisional); the gas flux is the
//     bounded Godunov flux of f(α) = α (C_0(α) j + v_d(α)) (R11).
//   • Quasi-steady mixture momentum per cell (gravity at the start-of-step holdups, the correlation's friction gradient scaled by
//     (j / j_last)², the acceleration factor), a volume-balance pressure equation per cell (Σ ∂V/∂m_c ṁ_c + ∂V/∂p ṗ = residual), solved
//     once per step by a root on the wellhead pressure with inner Picard sweeps (no acoustic time-step limit).
//   • Explicit conservative first-order donor transport; Δt limited by a CFL on the phase and kinematic-wave speeds, a pressure-change
//     limit, the event times and dtMax; rejected steps halve; the mass balance is checked every step.
//   • Reservoir: WTS_wd_res (instantaneous IPR, or the line-source superposition; back-flow into the formation, provisional).
//   • Choke: the nodal rule (Gilbert family critical with the model's y_c, the isentropic gas nozzle, the liquid orifice); the
//     sub-critical multiphase branch is the provisional closing shape. Flowline back pressure: a p_dn(q) table marched once with the
//     solve's options (WTS_flowline_march), re-tabulated when the produced GOR / WC drift by more than 10 %.
//
// DETERMINISM (WD-D8). The step sequence depends only on the model, the settings and the event list: run(seconds) never splits a step
// to land on a frame; events cut a step at their time. snapshot() / restore() continue bit-identically in the same JavaScript engine.
//
// PUBLIC: window.WTS_wd_engine = { create, ext, COMP, REGIMES, STATES, STATE_ORDER, CHANNELS, METHODS, VERSION, engineId, hash, canon }
// (contracts §3.1–§3.6). Additive fields beyond §3.2 (documented in the plan §11.1): S.faces.p (face pressures, psia), S.faces.FG / FO /
// FW / FI / FF (face mass fluxes, lbm/s), sim.stats (step counters and timings), S.ctl (choke mode and the stroke).
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WD_STUBS = G.__WD_STUBS || [];
    ['WTS_wd_engine.create', 'WTS_wd_engine.hash'].forEach(function (n) { var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1); });

    var VERSION = '1.0.0';
    var PATM = 14.696, RANK = 459.67, FT3 = 5.614583, GC = 32.174, GRAV = 32.174, RHO_W = 62.366, RHO_OIL = 62.37;
    var SIG_LBF = 6.852e-5;                  // lbf/ft per dyn/cm
    var PROVISIONAL = 'provisional — not verified against a published example';
    var BIG = 1e30;

    // ── frozen orders (contract §3.2, §3.4) ──────────────────────────────────────────────────────────────────────────
    var COMP = Object.freeze(['G', 'O', 'W', 'I', 'F']);
    var REGIMES = Object.freeze(['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown']);
    var STATE_ORDER = Object.freeze(['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin',
        'gl_unloading', 'gl_lifting', 'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped']);
    var STATES = Object.freeze({
        stable: { label: 'Stable', sev: 'ok', kinds: ['gas', 'oil', 'gl', 'esp'] },
        startup: { label: 'Start-up', sev: 'info', kinds: ['gas', 'oil', 'gl', 'esp'] },
        unloading: { label: 'Unloading', sev: 'info', kinds: ['gas', 'oil'] },
        marginal: { label: 'Marginal', sev: 'warn', kinds: ['gas'] },
        loading: { label: 'Loading up', sev: 'warn', kinds: ['gas'] },
        heading: { label: 'Heading', sev: 'warn', kinds: ['oil', 'gl'] },
        dying: { label: 'Dying', sev: 'warn', kinds: ['oil'] },
        dead: { label: 'Dead', sev: 'fail', kinds: ['gas', 'oil', 'gl', 'esp'] },
        shutin: { label: 'Shut in', sev: 'info', kinds: ['gas', 'oil', 'gl', 'esp'] },
        gl_unloading: { label: 'Gas lift: unloading', sev: 'info', kinds: ['gl'] },
        gl_lifting: { label: 'Gas lift: lifting', sev: 'ok', kinds: ['gl'] },
        gl_multipoint: { label: 'Gas lift: multipointing', sev: 'warn', kinds: ['gl'] },
        esp_off: { label: 'ESP off', sev: 'info', kinds: ['esp'] },
        esp_ramp: { label: 'ESP ramping', sev: 'info', kinds: ['esp'] },
        esp_running: { label: 'ESP running', sev: 'ok', kinds: ['esp'] },
        esp_pumpoff: { label: 'ESP pump-off', sev: 'warn', kinds: ['esp'] },
        esp_gaslock: { label: 'ESP gas lock', sev: 'warn', kinds: ['esp'] },
        esp_tripped: { label: 'ESP tripped', sev: 'fail', kinds: ['esp'] }
    });
    function _ch(key, label, unit, cat, dp) { return Object.freeze({ key: key, label: label, unit: unit, cat: cat, dp: dp }); }
    var CHANNELS = Object.freeze([
        _ch('t', 'Time', 's', null, 0), _ch('thp', 'THP', 'psig', 'pressureG', 1), _ch('tht', 'THT', '°F', 'temperature', 1),
        _ch('pwf', 'BHP', 'psia', 'pressure', 1), _ch('pr', 'Reservoir pressure', 'psia', 'pressure', 1), _ch('pcs', 'Casing pressure', 'psig', 'pressureG', 1),
        _ch('qo', 'Oil rate', 'STB/d', 'liquidRate', 1), _ch('qw', 'Water rate', 'STB/d', 'liquidRate', 1), _ch('qL', 'Liquid rate', 'STB/d', 'liquidRate', 1),
        _ch('qg', 'Gas rate (total)', 'Mscf/d', 'gasRateSmall', 1), _ch('qo_res', 'Sandface oil rate', 'STB/d', 'liquidRate', 1),
        _ch('qw_res', 'Sandface water rate', 'STB/d', 'liquidRate', 1), _ch('qg_res', 'Sandface gas rate', 'Mscf/d', 'gasRateSmall', 1),
        _ch('gor', 'GOR (total)', 'scf/STB', 'gor', 0), _ch('wc', 'Water cut', 'fraction', null, 3), _ch('bean', 'Bean', '/64 in', null, 1),
        _ch('open', 'Open', '0/1', null, 0), _ch('state', 'Well state', 'index', null, 0), _ch('lratio', 'Rate / critical rate', '–', null, 3),
        _ch('qc', 'Critical rate', 'MMscf/d', null, 3), _ch('liq', 'Liquid in the tubing', 'bbl', null, 2), _ch('gascap', 'Gas–liquid interface', 'ft', 'length', 0),
        _ch('qinj', 'Lift gas injection', 'Mscf/d', 'gasRateSmall', 1), _ch('opValve', 'Operating valve', 'n', null, 0),
        _ch('pint', 'Pump intake pressure', 'psia', 'pressure', 1), _ch('freq', 'ESP frequency', 'Hz', null, 1), _ch('load', 'Motor load', 'fraction', null, 3),
        _ch('foam', 'Foamer at the bottom', 'ppm', null, 0), _ch('dt', 'Time step', 's', null, 3), _ch('massErr', 'Mass balance error', 'relative', null, 12),
        _ch('qgForm', 'Formation gas rate', 'Mscf/d', 'gasRateSmall', 1), _ch('gorForm', 'Formation GOR', 'scf/STB', 'gor', 0),
        _ch('qvent', 'ESP vent gas', 'Mscf/d', 'gasRateSmall', 1), _ch('liftgas', 'Lift gas in the tubing', 'Mscf', null, 2),
        _ch('qcVert', 'Critical rate (vertical)', 'MMscf/d', null, 3), _ch('qcBelfroid', 'Critical rate (Belfroid)', 'MMscf/d', null, 3)
    ]);
    // §4.14 method table (D17)
    var METHODS = Object.freeze({
        cons: { label: 'Conservative donor transport, black-oil flash, volume-balance coupling', verified: 'identity' },
        corr: { label: 'Correlation-consistent drift closure (the model\'s gradient correlation)', verified: 'as the correlation' },
        driftflux: { label: 'Zuber-Findlay / Shi et al. drift flux (counter-current, near-stagnant, shut-in)', verified: false },
        godunov: { label: 'Bounded counter-current face flux', verified: 'identity' },
        compliance: { label: 'Tubing compliance and water compressibility floor', verified: false },
        res_ipr: { label: 'Instantaneous IPR inflow', verified: 'identity' },
        res_back: { label: 'Reverse flow into the formation (IPR slope at p̄r)', verified: false },
        res_ls: { label: 'Line-source E1 reservoir', verified: true },
        res_sup: { label: 'Superposition of the IPR drawdown (bounded, r_w,eff, gas η)', verified: false },
        choke_crit: { label: 'Nodal critical choke', verified: 'as the nodal choke' },
        choke_sub: { label: 'Sub-critical choke closing shape', verified: false },
        liftgas_mix: { label: 'Lift gas as a separate free component', verified: 'identity' },
        esp_node: { label: 'Nodal pump model as a face Δp', verified: 'identity' },
        temp_relax: { label: 'Temperature relaxation', verified: false },
        settle: { label: 'Oil–water hindered settling', verified: false },
        fallback: { label: 'Liquid fallback below the critical velocity', verified: false },
        turner: { label: 'Turner et al. (1969) critical velocity', verified: false },
        coleman: { label: 'Coleman et al. (1991) critical velocity', verified: false },
        belfroid: { label: 'Belfroid et al. (2008) inclination correction', verified: false },
        foamer: { label: 'Foamer surface-tension factor', verified: false },
        regime_lowv: { label: 'Low-velocity regime labels (Taitel, Barnea & Dukler; Taitel & Dukler)', verified: false },
        gl_valves: { label: 'Annulus, IPO valves, Thornhill-Craver', verified: false },
        esp_start: { label: 'ESP ramp, motor lag and trips', verified: false },
        states: { label: 'Well-state thresholds', verified: false }
    });

    // drift-flux constants (Shi et al. 2005 form; "to verify" — Q9, provisional)
    var DF = { A: 1.2, B: 0.3, Fv: 1, a1: 0.06, a2: 0.21, m0: 1.27, n1: 0.24, n2: 1.08, CK: 75, Cw: 0.008 };
    var J_LO = 0.05, J_HI = 0.10;
    var VD_CAP = 20;                         // ft/s, base of the drift cap (§11.1)            // ft/s, blend window of the corr closure (C1)
    var SETTLE = { vs0: 0.05, dRho: 15, rz: 2.39 };      // ft/s, lbm/ft³, Richardson-Zaki exponent (ASSUMED)
    var FALLBACK_V = 0.5;                    // ft/s film fall-back velocity (ASSUMED)
    var STATE_HOLD = 120, RING_DT = 30, STEADY_DT = 10, STEADY_N = 240;
    var GLR_GAS_ON = 30000, GLR_GAS_OFF = 15000, GLR_LIQ = 10;

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _fail(code, errors, extra) { var o = { ok: false, code: code, errors: errors || [], warnings: [] }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
    function _clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
    function _ss(x) { x = _clamp(x, 0, 1); return x * x * (3 - 2 * x); }

    // ── canonical JSON + hash16 (the PRiSM_autoInterp algorithm; local copy when 53 is not loaded) ────────────────────
    function canon(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'string') return JSON.stringify(v);
        if (typeof v === 'function') return 'null';
        if (Array.isArray(v) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v))) {
            var a = []; for (var i = 0; i < v.length; i++) a.push(canon(v[i])); return '[' + a.join(',') + ']';
        }
        var keys = Object.keys(v).sort(), out = [];
        for (var k = 0; k < keys.length; k++) { var x = v[keys[k]]; if (x === undefined || typeof x === 'function') continue; out.push(JSON.stringify(keys[k]) + ':' + canon(x)); }
        return '{' + out.join(',') + '}';
    }
    function _fnv(s, basis) { var h = basis | 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
    function _hex8(x) { return ('0000000' + (x >>> 0).toString(16)).slice(-8); }
    function hash16(str) {
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.hash16 === 'function') return AI.hash16(str);
        var s = str == null ? '' : String(str);
        return _hex8(_fnv(s, 0x811c9dc5)) + _hex8(_fnv(s, 0x050c5d1f));
    }
    function hash(obj) { return hash16(canon(obj)); }
    // the JavaScript-engine fingerprint (R25): last-bit results of the transcendental functions on a fixed argument list
    var ENGINE_ID = (function () {
        var xs = [0.1, 0.7, 1.3, 2.9, 7.7, 31.4, 123.456, 1e-3, 0.999, 5.5e3], o = [];
        for (var i = 0; i < xs.length; i++) { var x = xs[i]; o.push(Math.exp(x / 10), Math.log(x), Math.pow(x, 0.25), Math.pow(x, 1.7), Math.sqrt(x), Math.sin(x)); }
        return hash16(o.map(function (v) { return v.toPrecision(17); }).join(','));
    })();
    function _modelOnly(M) { var o = {}; for (var k in M) if (Object.prototype.hasOwnProperty.call(M, k) && k !== 'dyn') o[k] = M[k]; return o; }

    // ── regime keys ──────────────────────────────────────────────────────────────────────────────────────────────────
    var RIX = {}; REGIMES.forEach(function (k, i) { RIX[k] = i; });
    var PAT_MAP = { single: 'liquid', liquid: 'liquid', bubble: 'bubble', distributed: 'bubble', dispersed: 'bubble', slug: 'slug', intermittent: 'slug', plug: 'slug',
        churn: 'churn', transition: 'churn', froth: 'churn', annular: 'annular', mist: 'mist', segregated: 'stratified', stratified: 'stratified', wavy: 'stratified',
        gas: 'gas', homogeneous: 'unknown' };
    var PAT_CACHE = {};
    function _patIdx(s) {
        if (s == null) return RIX.unknown;
        if (Object.prototype.hasOwnProperty.call(PAT_CACHE, s)) return PAT_CACHE[s];
        var str = String(s).toLowerCase(), r = RIX.unknown;
        for (var k in PAT_MAP) if (str.indexOf(k) !== -1) { r = RIX[PAT_MAP[k]]; break; }
        PAT_CACHE[s] = r; return r;
    }

    // ── grid (§4.2) ──────────────────────────────────────────────────────────────────────────────────────────────────
    function _path(W) {
        return (W.segments || []).filter(function (s) { return s && +s.len > 0 && +s.id > 0; }).map(function (s) {
            var len = +s.len, dz = _fin(+s.dz) ? +s.dz : len, m0 = +s.md0, m1 = +s.md1;
            var o = { name: s.name || '', len: len, id: +s.id, dz: dz, inc: _fin(+s.inc) ? +s.inc : Math.acos(_clamp(dz / len, -1, 1)) * 180 / Math.PI,
                rough: _fin(+s.rough) ? +s.rough : null, kind: s.kind || 'tubing', mdTop: Math.min(m0, m1), mdBot: Math.max(m0, m1) };
            var t0 = +s.tvd0, t1 = +s.tvd1;
            o.tvdTop = m0 <= m1 ? t0 : t1; o.tvdBot = m0 <= m1 ? t1 : t0;
            if (+s.area > 0) o.area = +s.area;
            if (s.restr && +s.restr.d > 0) o.restr = { d: +s.restr.d, k: s.restr.k == null ? null : +s.restr.k, kind: s.restr.kind || null };
            return o;
        });
    }
    function _roughOf(segs) {
        var L = 0, S = 0;
        segs.forEach(function (s) { if (s.rough > 0) { L += s.len; S += s.len * s.rough; } });
        return L > 0 ? S / L : 0.0006;
    }
    function _split(segs, mds) {
        var out = [];
        segs.forEach(function (s) {
            var cuts = mds.filter(function (m) { return m > s.mdTop + 0.01 && m < s.mdBot - 0.01; }).sort(function (a, b) { return b - a; });
            if (!cuts.length) { out.push(s); return; }
            var hi = s.mdBot;
            cuts.concat([s.mdTop]).forEach(function (m, j) {
                var len = hi - m, c = {}; Object.keys(s).forEach(function (k) { c[k] = s[k]; });
                c.mdTop = m; c.mdBot = hi; c.len = len; c.dz = s.dz * len / s.len;
                c.tvdTop = s.tvdTop + (s.tvdBot - s.tvdTop) * (m - s.mdTop) / s.len; c.tvdBot = s.tvdTop + (s.tvdBot - s.tvdTop) * (hi - s.mdTop) / s.len;
                if (j > 0) delete c.restr;
                out.push(c); hi = m;
            });
        });
        return out;
    }
    function buildGrid(C, R0, nWant, extra) {
        var W = C.W, segs = _path(W);
        if (!segs.length) return null;
        // per-section correlation keys exactly as the traverse (WTS_wp_vlp.sectionsFor runs: MD ranges with their key)
        var runs = null;
        if (C.sections && G.WTS_wp_vlp && typeof G.WTS_wp_vlp.sectionsFor === 'function') {
            var sf = G.WTS_wp_vlp.sectionsFor(W, C.sections, C.corrWell);
            if (sf && sf.ok && sf.active) runs = sf.runs;
        }
        var brk = [];
        if (runs) runs.forEach(function (r) { brk.push(r.mdTop, r.mdBot); });
        (extra || []).forEach(function (m) { if (_fin(m)) brk.push(m); });
        if (brk.length) segs = _split(segs, brk);
        segs.forEach(function (s) {
            s.theta = s.len > 0 ? Math.asin(_clamp(s.dz / s.len, -1, 1)) * 180 / Math.PI : 0;
            if (runs) { var mid = 0.5 * (s.mdTop + s.mdBot); s.corr = C.corrWell; for (var i = 0; i < runs.length; i++) if (mid >= runs[i].mdTop - 1e-6 && mid <= runs[i].mdBot + 1e-6) { s.corr = runs[i].corr; break; } }
        });
        // segments in flow order: the deepest first (W.segments already are; re-sort for the split pieces)
        segs.sort(function (a, b) { return b.mdBot - a.mdBot; });
        var total = 0; segs.forEach(function (s) { total += s.len; });
        var n = Math.max(nWant, segs.length);
        // largest remainder allotment, ≥ 1 per segment
        var share = segs.map(function (s) { return Math.max(1, (n * s.len) / total); }), alloc = share.map(function (x) { return Math.max(1, Math.floor(x)); });
        var used = alloc.reduce(function (a, b) { return a + b; }, 0);
        var order = share.map(function (x, i) { return { i: i, r: x - Math.floor(x) }; }).sort(function (a, b) { return b.r - a.r || a.i - b.i; });
        for (var k = 0; used < n && k < order.length * 4; k++) { alloc[order[k % order.length].i]++; used++; }
        for (var k2 = 0; used > n && k2 < order.length * 4; k2++) { var ii = order[order.length - 1 - (k2 % order.length)].i; if (alloc[ii] > 1) { alloc[ii]--; used--; } }
        var cells = [], faces = [], gsegs = [];
        segs.forEach(function (s, si) {
            var area = s.area > 0 ? s.area / 144 : Math.PI * s.id * s.id / 4 / 144;
            gsegs.push({ id: s.id, len: s.len, dz: s.dz, theta: s.theta, area: s.area > 0 ? s.area : undefined, corr: runs ? s.corr : undefined, restr: s.restr || null,
                inc: s.inc, kind: s.kind, mdTop: s.mdTop, mdBot: s.mdBot, tvdTop: s.tvdTop, tvdBot: s.tvdBot, name: s.name });
            var m = alloc[si], dl = s.len / m;
            for (var j = 0; j < m; j++) {
                var mdLo = s.mdBot - j * dl, mdHi = s.mdBot - (j + 1) * dl;
                if (j === m - 1) mdHi = s.mdTop;
                var fr0 = (mdLo - s.mdTop) / s.len, fr1 = (mdHi - s.mdTop) / s.len;
                var tv0 = s.tvdTop + (s.tvdBot - s.tvdTop) * fr0, tv1 = s.tvdTop + (s.tvdBot - s.tvdTop) * fr1, len = mdLo - mdHi;
                cells.push({ i: cells.length, md0: mdLo, md1: mdHi, mdc: 0.5 * (mdLo + mdHi), tvd0: tv0, tvd1: tv1, tvdc: 0.5 * (tv0 + tv1), len: len,
                    dz: s.dz * len / s.len, inc: s.inc, id: s.id, area: area, vol: area * len, kind: s.kind, seg: si, corr: runs ? s.corr : C.corrWell });
                faces.push({ md: mdLo, tvd: tv0, restr: (j === 0 && s.restr) ? s.restr : null });
            }
        });
        var top = cells[cells.length - 1];
        faces.push({ md: top.md1, tvd: top.tvd1, restr: null });
        var shoe = W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : null, eot = -1;
        if (_fin(shoe)) { for (var c = 0; c < cells.length; c++) if (cells[c].md0 <= shoe + 0.01) { eot = c; break; } }
        var gauges = (W.nodes && Array.isArray(W.nodes.gauges) ? W.nodes.gauges : []).map(function (g) { var md = +g.md || +g; return { md: md, cell: _cellAt(cells, md) }; });
        var traj = (W.stations || []).map(function (s) { return { md: s.md, tvd: s.tvd, dep: _fin(s.dep) ? s.dep : Math.sqrt((s.n || 0) * (s.n || 0) + (s.e || 0) * (s.e || 0)), n: s.n || 0, e: s.e || 0 }; });
        return { n: cells.length, cells: cells, segs: gsegs, rough: _roughOf(segs), faces: faces, eotCell: eot, pumpFace: -1, injCell: -1, valveCells: [],
            gaugeCells: gauges, traj: traj, mdTotal: total };
    }
    function _cellAt(cells, md) { for (var i = 0; i < cells.length; i++) if (md <= cells[i].md0 + 1e-6 && md >= cells[i].md1 - 1e-6) return i; return -1; }
    function _faceAt(faces, md) { var b = -1, d = Infinity; for (var k = 0; k < faces.length; k++) { var x = Math.abs(faces[k].md - md); if (x < d) { d = x; b = k; } } return b; }

    // ── Moody (Swamee-Jain) friction factor (Darcy) — the mixture form below j_lo ───────────────────────────────────────
    function _moody(Re, rr) {
        if (!(Re > 0)) return 0;
        if (Re < 2300) return 64 / Re;
        var a = Math.log10(rr / 3.7 + 5.74 / Math.pow(Re, 0.9));
        return 0.25 / (a * a);
    }

    // ── create ──────────────────────────────────────────────────────────────────────────────────────────────────────
    function create(M, opts) {
        opts = opts || {};
        var need = [['WTS_wp_system', 'context'], ['WTS_wp_system', 'solve'], ['WTS_wp_fluid', 'flowlineFluid']];
        for (var ni = 0; ni < need.length; ni++) { var ns = G[need[ni][0]]; if (!ns || typeof ns[need[ni][1]] !== 'function' || (G.__WP_STUBS || []).indexOf(need[ni].join('.')) !== -1) return _fail('MISSING_ENGINE', [need[ni].join('.') + ' is not available'], { name: need[ni].join('.') }); }
        var fnNeed = ['WTS_flowline_gradAt', 'WTS_flowline_props', 'WTS_flowline_march'];
        for (var nj = 0; nj < fnNeed.length; nj++) if (typeof G[fnNeed[nj]] !== 'function') return _fail('MISSING_ENGINE', [fnNeed[nj] + ' is not available'], { name: fnNeed[nj] });
        if (!G.WTS_wd_res || typeof G.WTS_wd_res.create !== 'function') return _fail('MISSING_ENGINE', ['WTS_wd_res is not available'], { name: 'WTS_wd_res' });
        if (!M || !M.fluid || !M.res || !M.well) return _fail('NO_MODEL', ['the model is incomplete']);
        var t0w = _now();
        var mHashModel = hash(_modelOnly(M));
        var ref = opts.ref && opts.ref.mHashModel === mHashModel && opts.ref.C && opts.ref.R0 ? opts.ref : null;
        var C, R0;
        if (ref) { C = ref.C; R0 = ref.R0; }
        else {
            var cx = G.WTS_wp_system.context(M);
            if (!cx || !cx.ok) return _fail(cx && cx.code || 'NO_CONTEXT', cx && cx.errors || ['the model could not be built']);
            C = cx.C;
            if (C.F && C.F.pvt && C.F.pvt.rv) return _fail('RV_NOT_IN_TRANSIENT', ['The fluid has a vaporised-condensate (Rv) table: the transient flash has no Rv. Set Rv to none to play the well in time.']);
            R0 = G.WTS_wp_system.solve(M);
        }
        if (C.F && C.F.pvt && C.F.pvt.rv) return _fail('RV_NOT_IN_TRANSIENT', ['The fluid has a vaporised-condensate (Rv) table: the transient flash has no Rv.']);
        var start = opts.start === 'static' ? 'static' : (opts.start === 'snapshot' ? 'snapshot' : 'steady');
        var haveOp = !!(R0 && R0.ok && R0.op && _fin(R0.op.q) && R0.op.q > 0 && R0.traverse && R0.traverse.profile && R0.traverse.profile.length);
        if (start === 'steady' && !haveOp) return _fail('NO_STEADY', ['The model has no stable operating point: start from a static well instead.'], { R0: R0 });
        var sim = new Sim(M, opts, C, R0, mHashModel, start);
        if (!sim.ok) return sim.fail;
        sim.stats.createMs = _now() - t0w;
        return sim;
    }
    function _now() { return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now(); }

    // ── the simulator object ────────────────────────────────────────────────────────────────────────────────────────
    function Sim(M, opts, C, R0, mHashModel, start) {
        var self = this;
        this.ok = true; this.version = VERSION; this.engineId = ENGINE_ID; this.M = M; this.R0 = R0; this.C = C;
        this.ref = { mHashModel: mHashModel, R0: R0, C: C };
        this.stats = { steps: 0, rejects: 0, iters: 0, sweeps: 0, props: 0, grads: 0, wallMs: 0, createMs: 0 };
        var o = this.o = _resolveOpts(opts, C, R0, start);
        this.opts = o;                       // the resolved options under the §3.1 name (integration: the recorder and the page read sim.opts)
        var F = C.F, gasWell = !!C.gas;
        // ── grid with the forced breaks ──
        var extra = [];
        var glInj = (C.gl && R0 && R0.lift && _fin(R0.lift.injMd)) ? R0.lift.injMd : null;
        if (_fin(glInj)) extra.push(glInj);
        var valves = (M.lift && M.lift.type === 'gaslift' && M.lift.gl && Array.isArray(M.lift.gl.valves)) ? M.lift.gl.valves.filter(function (v) { return v && _fin(+v.md); }) : [];
        valves.forEach(function (v) { extra.push(+v.md); });
        var pumpMd = C.esp && _fin(C.esp.md) ? C.esp.md : null;
        if (_fin(pumpMd)) extra.push(pumpMd);
        var grid = buildGrid(C, R0, o.cells, extra);
        if (!grid) { this.ok = false; this.fail = _fail('NEEDS_WELL', ['the well has no flow path']); return; }
        if (_fin(glInj)) { var fi = _faceAt(grid.faces, glInj); grid.injCell = fi >= 0 && fi < grid.n ? fi : grid.n - 1; }
        if (_fin(pumpMd)) grid.pumpFace = _faceAt(grid.faces, pumpMd);
        grid.valveCells = valves.map(function (v, i) { var fk = _faceAt(grid.faces, +v.md); return { n: _fin(+v.n) ? +v.n : i + 1, md: +v.md, cell: Math.min(grid.n - 1, Math.max(0, fk)) }; });
        this.grid = grid;
        var n = grid.n;
        this.n = n;
        // ── conversion constants (lbm per stock-tank unit), identical to the props basis ──
        var gO = 141.5 / (131.5 + F.api);
        var kO = RHO_OIL * FT3 * gO, kW = RHO_W * FT3 * F.sgw;
        var prG = G.WTS_flowline_props({ qo: 0, qw: 0, qg: 1, api: F.api, sgg: F.sgg, sgw: F.sgw, pvt: F.pvt }, 1000, 100);
        var kG = prG.rhoG * prG.bg;                                 // lbm/scf formation gas (base conditions of the props)
        var sgI = C.gl && C.gl.sg > 0 ? C.gl.sg : 0.65, kI = kG * sgI / F.sgg;
        this.k = { O: kO, W: kW, G: kG, I: kI, sgI: sgI };
        // the per-unit-rate stream of the formation (IPR basis q → stock-tank qo, qw STB/d, qg scf/d)
        var ff1 = G.WTS_wp_fluid.flowlineFluid(F, 1);
        this.unit = { qo: ff1.qo, qw: ff1.qw, qg: ff1.qg * 1e6 };
        // ── arrays ──
        function f64(m) { return new Float64Array(m); }
        var cs = this.cs = {
            p: f64(n), T: f64(n), ag: f64(n), ao: f64(n), aw: f64(n), mG: f64(n), mO: f64(n), mW: f64(n), mI: f64(n), mF: f64(n),
            vg: f64(n), vl: f64(n), vm: f64(n), rhoM: f64(n), vc: f64(n), sigF: f64(n), regime: new Uint8Array(n)
        };
        var X = this.X = {
            bo: f64(n), bw: f64(n), bg: f64(n), rs: f64(n), rhoO: f64(n), rhoW: f64(n), rhoG: f64(n), muo: f64(n), muw: f64(n), mug: f64(n),
            sigO: f64(n), sigW: f64(n), z: f64(n), Vc: f64(n), dG: f64(n), dO: f64(n), dW: f64(n), dI: f64(n), dP: f64(n), rd: f64(n), xI: f64(n),
            gfL: f64(n), jL: f64(n), Ek: f64(n), drho: f64(n), hl: f64(n), vdc: f64(n), haveCorr: new Uint8Array(n), pat: new Uint8Array(n),
            area: f64(n), len: f64(n), dz: f64(n), vol: f64(n), dft: f64(n), mthe: f64(n), inc: f64(n), vcv: f64(n), vcb: f64(n), T0: f64(n), Tgeo: f64(n), Tflow: f64(n)
        };
        var fs = this.fs = {
            p: f64(n + 1), Q: f64(n + 1), jg: f64(n + 1), jo: f64(n + 1), jw: f64(n + 1), xI: f64(n + 1), vd: f64(n + 1), c0: f64(n + 1), w: f64(n + 1),
            FG: f64(n + 1), FO: f64(n + 1), FW: f64(n + 1), FI: f64(n + 1), FF: f64(n + 1)
        };
        var Y = this.Y = {   // per-step face closure constants
            A: f64(n + 1), vdu: f64(n + 1), dfvc: f64(n + 1), dfvsgf: f64(n + 1), dfsq: f64(n + 1), dfm: f64(n + 1), dfKu: f64(n + 1), lam: f64(n + 1),
            elig: f64(n + 1), restrK: f64(n + 1), restrB2: f64(n + 1), rhoN: f64(n + 1), dpPump: f64(n + 1), ddpPump: f64(n + 1), Qlag: f64(n + 1), settle: f64(n + 1)
        };
        for (var i = 0; i < n; i++) {
            var gc = grid.cells[i];
            X.area[i] = gc.area; X.len[i] = gc.len; X.dz[i] = gc.dz; X.vol[i] = gc.vol; X.dft[i] = gc.id / 12; X.inc[i] = gc.inc;
            var th = _clamp(gc.inc, 0, 90) * Math.PI / 180;
            X.mthe[i] = gc.inc >= 90 ? 0 : DF.m0 * Math.pow(Math.cos(th), DF.n1) * Math.pow(1 + Math.sin(th), DF.n2);
            cs.sigF[i] = 1;
        }
        for (var k = 0; k <= n; k++) {
            Y.A[k] = X.area[k === 0 ? 0 : k - 1];
            var rr = grid.faces[k].restr;
            if (rr && rr.d > 0) {
                var cellAbove = Math.min(k, n - 1), beta = Math.min(1, rr.d / grid.cells[cellAbove].id), b2 = beta * beta;
                Y.restrK[k] = _fin(rr.k) ? rr.k : 0.5 * (1 - b2) + (1 - b2) * (1 - b2); Y.restrB2[k] = b2;
            }
            fs.vd[k] = NaN;
        }
        // temperatures: the steady reference's flowing profile (frozen) and the geotherm (relax)
        var trRows = (R0 && R0.traverse && R0.traverse.profile) ? R0.traverse.profile.filter(function (r) { return !r.restr; }) : null;
        var tAtMd = function (md, key) {
            if (trRows && trRows.length) {
                for (var r = 1; r < trRows.length; r++) if (trRows[r].md >= md) { var a = trRows[r - 1], b = trRows[r], f = b.md > a.md ? (md - a.md) / (b.md - a.md) : 0; var va = a[key], vb = b[key]; if (_fin(va) && _fin(vb)) return va + (vb - va) * f; break; }
                var last = trRows[trRows.length - 1][key]; if (_fin(last) && md >= trRows[trRows.length - 1].md) return last;
            }
            return C.W.tAt ? C.W.tAt(md) : 150;
        };
        for (var it = 0; it < n; it++) {
            var mdc = grid.cells[it].mdc;
            X.Tflow[it] = tAtMd(mdc, 't');
            var te = trRows ? tAtMd(mdc, 'te') : NaN;
            X.Tgeo[it] = _fin(te) ? te : X.Tflow[it];
            cs.T[it] = X.Tflow[it];
        }
        // a static start with the relaxing temperature begins at the geotherm (a shut-in well); 'frozen' keeps the flowing profile (§4.9)
        if (start === 'static' && o.temperature === 'relax') for (var it2 = 0; it2 < n; it2++) cs.T[it2] = X.Tgeo[it2];
        this.thtRef = (R0 && R0.surface && _fin(R0.surface.tht)) ? R0.surface.tht : (C.tht || X.Tflow[n - 1]);
        // ── per-cell views (one mutable fluid object per call) ──
        this.view = { qo: 0, qw: 0, qg: 0, api: F.api, sgg: F.sgg, sgw: F.sgw, pvt: F.pvt };
        var pvtLift = {}; Object.keys(F.pvt || {}).forEach(function (kk) { if (kk !== 'table') pvtLift[kk] = F.pvt[kk]; });
        pvtLift.injGas = { qg_MMscfd: 0, sg: sgI };
        this.pvtLift = pvtLift;
        this.gopt = { corr: C.corrWell, rough: grid.rough, payne: true, accel: true };
        if (C.mult) this.gopt.mult = C.mult;
        this.surfT = (C.W && C.W.geo && _fin(C.W.geo.surfT_F)) ? C.W.geo.surfT_F : 60;
        // ── state ──
        var S = this.state = {
            t: 0, dt: 0, n: 0, open: 1, bean64: C.choke.present ? (C.choke.bean || 0) : 0, beanEff: C.choke.present ? (C.choke.bean || 0) : 0,
            psep_psig: C.psep, tOpen: 0, qRef: 0,
            cells: cs,
            faces: fs,
            surface: { thp: NaN, thp_psig: NaN, tht: this.thtRef, pDn_psig: NaN, qo: 0, qw: 0, qL: 0, qg: 0, qgForm: 0, qinj: 0, qvent: 0, glr: 0, gor: 0, gorForm: 0, wc: 0,
                regime: 'none', y: NaN, yc: NaN },
            bottom: { pwf: NaN, pr: C.pr, qo: 0, qw: 0, qg: 0, drawdown: 0 },
            well: { state: 'startup', since: 0, reason: '', prev: null },
            loading: { method: null, both: false, liquid: null, qc_MMscfd: null, qcVert_MMscfd: null, qcBelfroid_MMscfd: null, belfroid: !!o.loading.belfroid,
                limitingMd: null, limitingTvd: null, ratio: null, vRatioMin: null, belowEot: null },
            inventory: { liq_bbl: 0, liqTubing_bbl: 0, gas_Mscf: 0, liftGas_Mscf: 0, liquidTopMd: NaN, gasCapBottomMd: NaN },
            balance: { m: { G: 0, O: 0, W: 0, I: 0 }, cumIn: { G: 0, O: 0, W: 0, I: 0 }, cumOut: { G: 0, O: 0, W: 0, I: 0 }, clamp: { G: 0, O: 0, W: 0, I: 0 }, errStep: 0, errCum: 0, volDrift: 0 },
            lift: { gl: null, esp: null, glCmd: null, espCmd: null },
            foamer: { on: false, ppm: 0, eff: 1, injMd: null },
            cycle: null,
            res: { mode: o.reservoir.mode, terms: 0, f0: 1, backflow: false },
            flags: [],
            provisional: [],
            ctl: { chokeMode: null, strokeLeft_s: 0, beanFrom: 0, beanTo: 0, strokeTime_s: o.choke.strokeTime_s, ended: false }
        };
        // ── reservoir ──
        var ro = Object.assign({}, o.reservoir, { F: F, qOp: haveOpQ(R0) });
        var res = G.WTS_wd_res.create(C.I, M, ro);
        if (!res || !res.ok) { this.ok = false; this.fail = _fail(res && res.code || 'NEEDS_IPR', res && res.errors || ['the inflow could not be built']); return; }
        this.res = res;
        S.res.mode = res.mode;
        (res.warnings || []).forEach(function (w) { S.flags.push(w); });
        // ── flowline back-pressure table ──
        this.line = null;
        // ── events, listeners, extensions ──
        this.pend = []; this.log = []; this.listeners = {};
        this.labels = { pending: null, ringT: [], ringLiq: [], ringQ: [], ringP: [], ringThp: [], lastRing: -Infinity, dying: { t0: null }, heading: null };
        this.steady = { ringT: [], ringQ: [], ringPwf: [], ringThp: [], next: 0 };
        this.bal = { m0: { G: 0, O: 0, W: 0, I: 0 } };
        this.prov = {};
        this.exts = [];
        this.dtPrev = 0;
        this.ended = false;
        this.src = { G: f64(n), O: f64(n), W: f64(n), I: f64(n), F: f64(n) };
        this.tmp = { p: f64(n + 1), Q: f64(n + 1), Q2: f64(n + 1), FG: f64(n + 1), FO: f64(n + 1), FW: f64(n + 1), FI: f64(n + 1), FF: f64(n + 1),
            jg: f64(n + 1), jo: f64(n + 1), jw: f64(n + 1), xI: f64(n + 1), pc: f64(n), bestP: f64(n + 1), bestQ: f64(n + 1) };
        this.fx = { FG: 0, FO: 0, FW: 0, FI: 0, FF: 0, jg: 0, jo: 0, jw: 0, xI: 0 };
        // ── initial state ──
        var init = start === 'steady' ? this._initSteady() : (start === 'static' ? this._initStatic(o.static) : { ok: true });
        if (!init.ok) { this.ok = false; this.fail = init; return; }
        this._mark('cons'); this._mark('compliance'); this._mark('states');
        if (o.reservoir.mode === 'transient' && res.mode === 'transient') { this._mark('res_ls'); this._mark('res_sup'); } else this._mark('res_ipr');
        if (o.temperature === 'relax') this._mark('temp_relax');
        if (o.loading.belfroid) this._mark('belfroid');
        if (gasWell) { this._mark('turner'); this._mark('coleman'); }
        var refLine = opts.ref && opts.ref.mHashModel === mHashModel && opts.ref.line && opts.ref.line.psep === this.state.psep_psig ? opts.ref.line : null;
        if (refLine) this._lineFrom(refLine); else this._buildLine(null);
        this.ref.line = { refGor: this.line.refGor, refWc: this.line.refWc, q: this.line.q.slice(), pdn: this.line.pdn.slice(), unit: this.line.unit, psep: this.line.psep, flowline: this.line.flowline };
        // extensions (WD-D13)
        var EXT = NS.ext || {};
        Object.keys(EXT).sort().forEach(function (key) {
            var e = EXT[key];
            if (!e || typeof e.applies !== 'function') return;
            var on = false; try { on = !!e.applies(M, o); } catch (er) { on = false; }
            if (!on) return;
            var ctx = typeof e.init === 'function' ? e.init(self, o) : {};
            self.exts.push({ key: key, e: e, ctx: ctx });
        });
        // the start-of-run evaluation (props, closures, surface) at t = 0
        if (start === 'snapshot' && opts.snapshot) { var rr2 = this.restore(opts.snapshot, true); if (!rr2.ok) { this.ok = false; this.fail = _fail(rr2.code || 'SNAPSHOT', ['the snapshot does not fit this model']); return; } }
        else {
            this._prep(true);
            this._post(0, true);
            this.bal.m0 = this._totals();
            this.state.balance.m = this._totals();
        }
        if (Array.isArray(o.events) && o.events.length) this.schedule(o.events);
        this.mHash = hash({ m: mHashModel, o: _hashOpts(o), res: res.params || null, prior: res.prior || null });
        // public views
        this.sim = this;
    }
    function haveOpQ(R0) { return R0 && R0.op && _fin(R0.op.q) ? R0.op.q : 0; }
    function _resolveOpts(opts, C, R0, start) {
        var r = opts.reservoir || {}, pr = r.prior || {};
        var o = {
            cells: _clamp(Math.round(_fin(+opts.cells) ? +opts.cells : 60), 20, 200), start: start,
            static: { kind: (opts.static && opts.static.kind) || 'gas', liquidTopMd: opts.static && _fin(+opts.static.liquidTopMd) ? +opts.static.liquidTopMd : null,
                liquid: (opts.static && opts.static.liquid) === 'water' ? 'water' : ((opts.static && opts.static.liquid) === 'oil' ? 'oil' : null) },
            reservoir: { mode: r.mode === 'transient' ? 'transient' : 'ipr', k: _n(r.k), h: _n(r.h), phi: _n(r.phi), ct: _n(r.ct), mu: _n(r.mu), B: _n(r.B), rw: _n(r.rw),
                re: _n(r.re), S: _n(r.S), potential: r.potential || 'auto', backflow: r.backflow !== false,
                prior: { kind: pr.kind || (start === 'steady' ? 'steady' : 'none'), t_h: _fin(+pr.t_h) ? +pr.t_h : 720, shut_h: _fin(+pr.shut_h) ? +pr.shut_h : 0 } },
            closure: opts.closure === 'driftflux' ? 'driftflux' : 'corr',
            closureOpt: { jLo: _fin(+(opts.closureOpt || {}).jLo) ? +opts.closureOpt.jLo : J_LO, jHi: _fin(+(opts.closureOpt || {}).jHi) ? +opts.closureOpt.jHi : J_HI,
                omega: _fin(+(opts.closureOpt || {}).omega) ? _clamp(+opts.closureOpt.omega, 0.01, 1) : 0.5 },
            fallback: opts.fallback === true, settle: opts.settle !== false,
            loading: { belfroid: !!(opts.loading && opts.loading.belfroid) },
            compliance: { pipe_psi: _fin(+(opts.compliance || {}).pipe_psi) ? +opts.compliance.pipe_psi : 3e-6, cwMin_psi: _fin(+(opts.compliance || {}).cwMin_psi) ? +opts.compliance.cwMin_psi : 3e-6 },
            order: opts.order === 2 ? 2 : 1, cfl: _fin(+opts.cfl) ? _clamp(+opts.cfl, 0.05, 1) : 0.5, dtMax: _fin(+opts.dtMax) ? Math.max(0.01, +opts.dtMax) : 60,
            dtMin: _fin(+opts.dtMin) ? Math.max(1e-6, +opts.dtMin) : 1e-3, dpMaxFrac: _fin(+opts.dpMaxFrac) ? _clamp(+opts.dpMaxFrac, 1e-4, 0.5) : 0.02,
            picard: { maxSweeps: _clamp(Math.round(_fin(+(opts.picard || {}).maxSweeps) ? +opts.picard.maxSweeps : 3), 1, 10), tolQ: _fin(+(opts.picard || {}).tolQ) ? +opts.picard.tolQ : 1e-6,
                tolQrel: _fin(+(opts.picard || {}).tolQrel) ? +opts.picard.tolQrel : 1e-4 },
            temperature: opts.temperature === 'relax' ? 'relax' : 'frozen', tauT_h: _fin(+opts.tauT_h) && +opts.tauT_h > 0 ? +opts.tauT_h : 2,
            choke: { subcritical: (opts.choke && opts.choke.subcritical) === 'shape' ? 'shape' : 'model', strokeTime_s: _fin(+(opts.choke || {}).strokeTime_s) ? Math.max(0, +opts.choke.strokeTime_s) : 10 },
            ext: opts.ext || {}, events: Array.isArray(opts.events) ? opts.events.slice() : []
        };
        return o;
    }
    function _hashOpts(o) { var c = {}; for (var k in o) if (k !== 'events' && k !== 'ext') c[k] = o[k]; c.ext = o.ext; return c; }

    var P = Sim.prototype;
    P._mark = function (k) { if (!this.prov[k]) { this.prov[k] = true; var m = METHODS[k]; if (m && m.verified === false) this.state.provisional.push(k); } };
    P._flag = function (code, msg, sev) {
        var f = this.state.flags;
        for (var i = 0; i < f.length; i++) if (f[i].code === code) return;
        f.push({ code: code, sev: sev || 'warn', msg: String(msg).slice(0, 299) });
        this._emit('warn', { code: code, msg: msg });
    };
    P._emit = function (type, payload) { var L = this.listeners[type]; if (!L) return; for (var i = 0; i < L.length; i++) { try { L[i](payload); } catch (e) { /* listeners never break the engine */ } } };
    P.on = function (type, fn) { if (typeof fn !== 'function') return; (this.listeners[type] = this.listeners[type] || []).push(fn); };
    P.off = function (type, fn) { var L = this.listeners[type]; if (!L) return; var i = L.indexOf(fn); if (i !== -1) L.splice(i, 1); };
    P.dispose = function () { this.listeners = {}; this.ended = true; };

    // ── flash: the cell's properties at pressure p (the per-cell view, R13) ──────────────────────────────────────────
    P._props = function (i, p, view) {
        var k = this.k, cs = this.cs;
        var No = cs.mO[i] / k.O, Nw = cs.mW[i] / k.W, Gs = cs.mG[i] / k.G, GI = cs.mI[i] / k.I;
        view.qo = No; view.qw = Nw; view.qg = Gs / 1e6;
        if (GI > 0) { this.pvtLift.injGas.qg_MMscfd = GI / 1e6; view.pvt = this.pvtLift; } else view.pvt = this.C.F.pvt;
        if (!(No > 0) && !(Nw > 0) && !(Gs > 0) && !(GI > 0)) view.qg = 1e-12;
        this.stats.props++;
        return G.WTS_flowline_props(view, p, cs.T[i]);
    };
    // content volume (ft³) at the props pr (the cell's masses)
    function _vol(pr, No, Nw, Gs, GI) {
        var Gd = No > 0 ? No * pr.rs : 0, Gf = Gs - Gd; if (Gf < 0) Gf = 0;
        return FT3 * No * pr.bo + FT3 * Nw * pr.bw + (Gf + GI) * pr.bg;
    }
    // ── the once-per-step evaluation at state n: flash, derivatives, correlation, closure constants (§4.1, §4.4) ────
    P._prep = function (first) {
        var n = this.n, cs = this.cs, X = this.X, fs = this.fs, Y = this.Y, k = this.k, o = this.o, view = this.view, grid = this.grid;
        var jlo = o.closureOpt.jLo, jhi = o.closureOpt.jHi, om = first ? 1 : o.closureOpt.omega, corrOn = o.closure === 'corr';
        var cpipe = o.compliance.pipe_psi, cwmin = o.compliance.cwMin_psi;
        var vdrift = 0;
        for (var i = 0; i < n; i++) {
            var p = cs.p[i], No = cs.mO[i] / k.O, Nw = cs.mW[i] / k.W, Gs = cs.mG[i] / k.G, GI = cs.mI[i] / k.I;
            var pr = this._props(i, p, view);
            X.bo[i] = pr.bo; X.bw[i] = pr.bw; X.bg[i] = pr.bg; X.rs[i] = No > 0 ? pr.rs : 0; X.rhoO[i] = pr.rhoO; X.rhoW[i] = pr.rhoW; X.rhoG[i] = pr.rhoG;
            X.muo[i] = pr.muo; X.muw[i] = pr.muw; X.mug[i] = pr.mug; X.sigO[i] = pr.sigO > 0 ? pr.sigO : (this.C.F && pr.sigO) || 20; X.sigW[i] = pr.sigW > 0 ? pr.sigW : 60; X.z[i] = pr.z;
            var Vo = FT3 * No * pr.bo, Vw = FT3 * Nw * pr.bw, Gd = No > 0 ? No * pr.rs : 0, Gf = Gs - Gd; if (Gf < 0) Gf = 0;
            var Vg = (Gf + GI) * pr.bg, V = Vo + Vw + Vg;
            X.Vc[i] = V; X.rd[i] = No > 0 ? Gd / No : 0; X.xI[i] = (Gf + GI) > 0 ? GI / (Gf + GI) : 0;
            cs.ao[i] = V > 0 ? Vo / V : 0; cs.aw[i] = V > 0 ? Vw / V : 0; cs.ag[i] = V > 0 ? Vg / V : 0;
            var dv = Math.abs(V - X.vol[i]) / X.vol[i]; if (dv > vdrift) vdrift = dv;
            // volume derivatives (ft³/lbm, ft³/psi)
            X.dW[i] = FT3 * pr.bw / k.W; X.dI[i] = pr.bg / k.I;
            if (Gf > 0 || !(No > 0)) { X.dG[i] = pr.bg / k.G; X.dO[i] = (FT3 * pr.bo - pr.bg * (No > 0 ? pr.rs : 0)) / k.O; }
            else {
                // undersaturated cell holding oil: (∂Bo/∂R)_p by a one-scf/STB difference of the same view (R13)
                view.qg = (Gs + No) / 1e6;
                var pr2 = G.WTS_flowline_props(view, p, cs.T[i]); this.stats.props++;
                var dBdR = (pr2.bo - pr.bo) / 1;
                if (pr2.rs < Gs / No + 1 - 1e-9) dBdR = (pr2.bo - pr.bo);       // the cap reached: still the difference (saturates)
                X.dG[i] = FT3 * dBdR / k.G; X.dO[i] = FT3 * (pr.bo - (Gs / No) * dBdR) / k.O;
                view.qg = Gs / 1e6;
            }
            var pr1 = G.WTS_flowline_props(view, p + 1, cs.T[i]); this.stats.props++;
            var V1 = _vol(pr1, No, Nw, Gs, GI), cw = pr.bw > 0 ? -(pr1.bw - pr.bw) / pr.bw : 0;
            X.dP[i] = (V1 - V) - X.vol[i] * (cpipe + Math.max(0, cwmin - cw) * cs.aw[i]);
            // mixture density at the start-of-step holdups (lbm/ft³)
            cs.rhoM[i] = cs.ao[i] * pr.rhoO + cs.aw[i] * pr.rhoW + cs.ag[i] * pr.rhoG;
        }
        this.state.balance.volDrift = vdrift;
        if (vdrift > 0.005) this._flag('VOL_DRIFT', 'The cell contents differ from the cell volumes by more than 0.5 % (linearisation residual).', 'info');
        // the correlation per cell (the march's own call through WTS_flowline_gradAt, at the cell centre — C2). Its stream is the
        // reference (formation) stream of the well — plus the lift gas above the nodal injection point — scaled so that its in-situ
        // mixture flux equals the cell's j (§11.1): v_d,corr = v_sg / (1 − H_L) − j then depends on (j, p, T) only, the flux function
        // j_g = α (j + v_d) is linear in α at fixed j (hyperbolic: no cell-to-cell feedback of the liquid accumulation into the
        // closure), and in steady flow — where the stream IS the produced stream — the cell gas fraction is exactly 1 − H_L of the
        // nodal march at the same (p, T, stream).
        var gopt = this.gopt, segs = grid.segs, anyLow = false, u1 = this.unit, glRef = this._glRef();
        // the correlation describes a produced stream: in a shut-in well (choke closed) every face takes the drift-flux closure (§4.4,
        // §4.10 — the counter-current, near-stagnant case; a correlation drift for a vanishing stream made the closed column slosh, §11.1)
        var Sx = this.state, producing = !Sx || (Sx.open && (!this.C.choke.present || Sx.beanEff > 1e-9 || (Sx.ctl && Sx.ctl.strokeLeft_s > 0)));
        if (!producing) corrOn = false;
        for (var c = 0; c < n; c++) {
            X.haveCorr[c] = 0;
            var A0 = X.area[c], qa = 0.5 * (fs.Q[c] + fs.Q[c + 1]) / A0;
            X.jL[c] = qa;
            var co = fs.Q[c] > 0 && fs.Q[c + 1] > 0 && fs.jg[c + 1] >= 0 && (fs.jo[c + 1] + fs.jw[c + 1]) >= 0 && qa >= jlo;
            if (co && corrOn) {
                var lift = glRef > 0 && grid.injCell >= 0 && c >= grid.injCell;
                view.qo = u1.qo; view.qw = u1.qw; view.qg = u1.qg / 1e6;
                if (lift) { this.pvtLift.injGas.qg_MMscfd = glRef / 1e6; view.pvt = this.pvtLift; } else view.pvt = this.C.F.pvt;
                var pU = G.WTS_flowline_props(view, cs.p[c], cs.T[c]); this.stats.props++;
                var tot1 = pU ? pU.qL + pU.qG : 0;
                if (tot1 > 0) {
                    var sc = qa * A0 / tot1;
                    view.qo = u1.qo * sc; view.qw = u1.qw * sc; view.qg = u1.qg * sc / 1e6;
                    if (lift) this.pvtLift.injGas.qg_MMscfd = glRef * sc / 1e6;
                    var g = G.WTS_flowline_gradAt(view, cs.p[c], cs.T[c], segs[grid.cells[c].seg], gopt); this.stats.grads++;
                    if (g && _fin(g.hl)) {
                        X.haveCorr[c] = 1; X.hl[c] = g.hl; X.gfL[c] = _fin(g.gradF) ? g.gradF : 0; X.Ek[c] = gopt.accel && _fin(g.Ek) ? Math.min(0.9, Math.max(0, g.Ek)) : 0;
                        X.pat[c] = _patIdx(g.pattern);
                        var vsl = g.vsl, vsg = g.vsg;
                        X.vdc[c] = (g.hl < 1 - 1e-12 && vsg > 0) ? vsg / (1 - g.hl) - (vsl + vsg) : 0;
                        X.jL[c] = vsl + vsg > 0 ? vsl + vsg : qa;
                        // a holdup at (or clamped to) 1 while gas flows — a VLP-tuning multiplier m_h > 1 near the bubble point — needs an
                        // unbounded drift: the drift is capped (VD_CAP + 2|j|, so the kinematic-wave CFL stays at the flow's own scale) and
                        // the momentum takes the correlation's density difference (lagged, §11.1): at steady state the column weighs what
                        // the march weighs while the transported gas fraction is the capped one
                        var cap = VD_CAP + 2 * Math.abs(qa);
                        if (vsg > 0 && (g.hl >= 1 - 1e-12 || X.vdc[c] > cap)) { X.vdc[c] = cap; X.drho[c] = _fin(g.rhoS) ? g.rhoS - cs.rhoM[c] : 0; }
                        else X.drho[c] = 0;
                    }
                }
            }
            if (!X.haveCorr[c]) { X.gfL[c] = 0; X.Ek[c] = 0; X.drho[c] = 0; }
        }
        // face closure constants (§4.4)
        for (var f = 1; f <= n; f++) {
            var d = f - 1, u = f < n ? f : d;
            var A = Y.A[f], jF = fs.Q[f] / A, jgF = fs.jg[f], jLF = fs.jo[f] + fs.jw[f];
            // eligibility for the corr closure from the last step (co-current: j > 0, j_g ≥ 0, j_L ≥ 0, a correlation at the donor); the
            // weight itself is w(j) = smoothstep((j − j_lo)/(j_hi − j_lo)) at the CURRENT j (inside the solve), so the face flux is a
            // continuous function of Q through j = 0 (a weight frozen at 1 jumped there and Newton stalled — §11.1)
            var w = (corrOn && X.haveCorr[d] && jF > 0 && jgF >= 0 && jLF >= 0) ? 1 : 0;
            Y.vdu[f] = 0;
            if (X.haveCorr[d]) {
                var prev = fs.vd[f];
                fs.vd[f] = _fin(prev) ? prev + om * (X.vdc[d] - prev) : X.vdc[d];
            }
            Y.elig[f] = w;
            fs.w[f] = w * (jF >= jhi ? 1 : (jF >= jlo ? _ss((jF - jlo) / (jhi - jlo)) : 0));
            if (fs.w[f] < 1) anyLow = true;
            // drift-flux constants at the face: the mean of the two cells' fluids (frozen for the step)
            var aoA = cs.ao[d] + cs.ao[u], awA = cs.aw[d] + cs.aw[u], aL = aoA + awA;
            var rhoL = aL > 0 ? (aoA * 0.5 * (X.rhoO[d] + X.rhoO[u]) + awA * 0.5 * (X.rhoW[d] + X.rhoW[u])) / aL : (this.gasWell() ? 0.5 * (X.rhoW[d] + X.rhoW[u]) : 0.5 * (X.rhoO[d] + X.rhoO[u]));
            var sig = aL > 0 ? (aoA * 0.5 * (X.sigO[d] + X.sigO[u]) + awA * 0.5 * (X.sigW[d] + X.sigW[u])) / aL : 0.5 * (X.sigW[d] + X.sigW[u]);
            sig *= 0.5 * (cs.sigF[d] + cs.sigF[u]);
            var rhoG = 0.5 * (X.rhoG[d] + X.rhoG[u]), dr = Math.max(1e-6, rhoL - rhoG);
            var sg = Math.max(1e-6, sig) * SIG_LBF * GC;           // lbm/s²
            Y.dfvc[f] = Math.pow(sg * GRAV * dr / (rhoL * rhoL), 0.25);
            var dft = X.dft[d], NB = dft * dft * GRAV * dr / sg;
            var Ku = Math.sqrt(Math.max(0, (DF.CK / Math.sqrt(NB)) * (-1 + Math.sqrt(1 + NB / (DF.CK * DF.CK * DF.Cw)))));
            Y.dfKu[f] = Ku;
            Y.dfvsgf[f] = Math.max(1e-6, Ku * Math.pow(sg * GRAV * dr / (rhoG * rhoG), 0.25));
            Y.dfsq[f] = Math.sqrt(rhoG / rhoL);
            Y.dfm[f] = X.mthe[d];
            // oil–water settling velocity at the face (provisional): water down relative to oil
            Y.settle[f] = (this.o.settle && aoA > 0 && awA > 0) ? SETTLE.vs0 * Math.max(0, 0.5 * (X.rhoW[d] + X.rhoW[u]) - 0.5 * (X.rhoO[d] + X.rhoO[u])) / SETTLE.dRho : 0;
            // restriction no-slip density (lagged)
            if (Y.restrK[f] > 0) { var jj = Math.abs(jF) > 1e-9 ? jF : 1; Y.rhoN[f] = Math.abs(jF) > 1e-9 ? (rhoL * jLF + rhoG * jgF) / jj : cs.rhoM[u]; }
        }
        Y.vdu[0] = 0;
        if (anyLow) this._mark('driftflux');
        if (Y.restrK[0] > 0) Y.rhoN[0] = cs.rhoM[0];
    };
    P.gasWell = function () { return !!this.C.gas; };
    // the lift gas of the reference stream per unit basis rate (scf per unit q): the nodal injection rate over the nodal rate
    P._glRef = function () { var C = this.C, q = haveOpQ(this.R0); return (C.gl && C.gl.qinj > 0 && q > 0) ? C.gl.qinj * 1000 / q : 0; };

    // drift-flux closure at face f: C0(α, j), vd(α, j) (§4.4) → returns α·(C0 j + vd)
    P._dfFlux = function (f, a, j) {
        var Y = this.Y, beta = Math.max(a, DF.Fv * a * Math.abs(j) / Y.dfvsgf[f]);
        var gam = _clamp((beta - DF.B) / (1 - DF.B), 0, 1), C0 = DF.A / (1 + (DF.A - 1) * gam * gam);
        var Kb = 1.53 / C0, K = a <= DF.a1 ? Kb : (a >= DF.a2 ? Y.dfKu[f] : Kb + (Y.dfKu[f] - Kb) * (a - DF.a1) / (DF.a2 - DF.a1));
        var aC = a * C0, num = (1 - aC), den = aC * Y.dfsq[f] + 1 - aC;
        var vd = (num > 0 && den > 0) ? num * C0 * K * Y.dfvc[f] * Y.dfm[f] / den : 0;
        return a * (C0 * j + vd);
    };
    // the blended flux function f(α) at face f (corr part linear in α)
    // the corr part is α (j + v_d) inside the co-current bounds −j ≤ v_d ≤ j α_L/α_g at the α evaluated (R4): clamp(α (j + v_d), 0, j),
    // so f(0) = 0 and f(1) = j hold for the blend too (no gas from a liquid-full cell, no liquid from a gas-full cell); j ≤ 0 → drift flux
    P._flux = function (f, a, j, vdc, w) {
        if (!(j > 0)) w = 0;
        var cf = 0;
        if (w > 0) { cf = a * (j + vdc); if (cf < 0) cf = 0; else if (cf > j) cf = j; if (w >= 1) return cf; }
        var df = this._dfFlux(f, a, j);
        return w > 0 ? w * cf + (1 - w) * df : df;
    };
    // Godunov extremum of f on [lo, hi]: min if aDn ≤ aUp, else max (R11)
    P._godunov = function (f, aDn, aUp, j, vdc, w) {
        var lo = Math.min(aDn, aUp), hi = Math.max(aDn, aUp), wantMin = aDn <= aUp, self = this;
        var fl = this._flux(f, lo, j, vdc, w), fh = this._flux(f, hi, j, vdc, w), best = wantMin ? Math.min(fl, fh) : Math.max(fl, fh);
        if (hi - lo < 1e-9) return this._flux(f, aDn, j, vdc, w);
        var g = 0.6180339887498949, a = lo, b = hi, x1 = b - g * (b - a), x2 = a + g * (b - a);
        var s = wantMin ? 1 : -1;
        var f1 = s * self._flux(f, x1, j, vdc, w), f2 = s * self._flux(f, x2, j, vdc, w);
        for (var it = 0; it < 10; it++) {
            if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = s * self._flux(f, x1, j, vdc, w); }
            else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = s * self._flux(f, x2, j, vdc, w); }
        }
        var m = Math.min(f1, f2) * s;
        return wantMin ? Math.min(best, m) : Math.max(best, m);
    };
    // phase and component fluxes at face f for a mixture volume rate Q (ft³/s) → this.fx; returns Σ_c ∂V/∂m_c(cell f−1) · F_c
    P._faceFlux = function (f, Q, out) {
        var n = this.n, cs = this.cs, X = this.X, Y = this.Y, fs = this.fs, k = this.k, A = Y.A[f], j = Q / A;
        var d = f - 1, u = f < n ? f : d, top = f === n;
        var jg, jL;
        if (top && j <= 0) { out.FG = out.FO = out.FW = out.FI = out.FF = 0; out.jg = out.jo = out.jw = 0; out.xI = X.xI[d]; return Q; }
        var vdc = fs.vd[f], jlo = this.o.closureOpt.jLo, jhi = this.o.closureOpt.jHi;
        var w = Y.elig[f] > 0 ? (j >= jhi ? 1 : (j > jlo ? _ss((j - jlo) / (jhi - jlo)) : 0)) : 0;
        if (!_fin(vdc)) { vdc = 0; w = 0; }
        var aDn = cs.ag[d], aUp = top ? aDn : cs.ag[u];
        if (!(j > 0)) w = 0;
        if (top) { jg = this._flux(f, aDn, j, vdc, w); if (jg < 0) jg = 0; else if (jg > j) jg = j; }
        else if (w >= 1) { jg = aDn * (j + vdc); if (jg < 0) jg = 0; else if (jg > j) jg = j; }     // co-current: the upwind value
        else jg = this._godunov(f, aDn, aUp, j, vdc, w);
        jL = j - jg;
        // liquid fallback below the critical velocity (option, provisional, §4.10)
        if (this.o.fallback && jg > 0 && !top) {
            var dg = d, vgl = cs.ag[dg] > 1e-9 ? jg / cs.ag[dg] : 0, vcr = cs.vc[dg];
            if (vcr > 0 && vgl < vcr && jL > -1e3) {
                var aLd = top ? 0 : 1 - cs.ag[u], dj = aLd * FALLBACK_V * (1 - vgl / vcr);          // the liquid that falls comes from the cell above
                if (dj > 0) { jL -= dj; jg += dj; this._fb = true; }
            }
        }
        // the oil / water split of the liquid (donor's water fraction) with the hindered settling flux (provisional)
        var ld = jL >= 0 ? d : u, aLq = cs.ao[ld] + cs.aw[ld], fw = aLq > 0 ? cs.aw[ld] / aLq : (this.k.wcRef || 0);
        var jw = fw * jL, phi = 0;
        if (Y.settle[f] > 0 && Math.abs(jL) < this.o.closureOpt.jHi && !top) {
            // upwind holdups: the water that sinks is the upper cell's, the oil that rises the lower cell's (positivity)
            var ao = cs.ao[d], aw = cs.aw[u], al = 0.5 * (cs.ao[d] + cs.aw[d] + cs.ao[u] + cs.aw[u]);
            if (al > 1e-9 && ao > 0 && aw > 0) { phi = ao * aw / al * Y.settle[f] * Math.pow(Math.max(0, 1 - 0.5 * (cs.aw[d] + aw)), SETTLE.rz); this._settled = true; }
        }
        jw -= phi;
        var jo = jL - jw;
        // donors per phase
        var gd = jg >= 0 ? d : u, wd = jw >= 0 ? d : u, od = jo >= 0 ? d : u;
        if (top) { gd = wd = od = d; }
        var Agas = A * jg, xI = X.xI[gd];
        var FGf = X.bg[gd] > 0 ? Agas * (1 - xI) / X.bg[gd] * k.G : 0, FI = X.bg[gd] > 0 ? Agas * xI / X.bg[gd] * k.I : 0;
        var Nof = X.bo[od] > 0 ? A * jo / (FT3 * X.bo[od]) : 0;                 // STB/s of stock-tank oil
        var FO = Nof * k.O, FGd = Nof * X.rd[od] * k.G;
        var FW = X.bw[wd] > 0 ? A * jw / (FT3 * X.bw[wd]) * k.W : 0;
        var FF = cs.mW[wd] > 0 ? FW * cs.mF[wd] / cs.mW[wd] : 0;
        // a donor that holds none of the phase moves none of it (round-off guard on α → 0)
        if (cs.mO[od] <= 0 && FO !== 0) { FO = 0; FGd = 0; }
        if (cs.mW[wd] <= 0 && FW !== 0) { FW = 0; FF = 0; }
        out.FG = FGf + FGd; out.FO = FO; out.FW = FW; out.FI = FI; out.FF = FF; out.jg = jg; out.jo = jo; out.jw = jw; out.xI = xI;
        if (top && j > 0) return out.FG * X.dG[d] + out.FO * X.dO[d] + out.FW * X.dW[d] + out.FI * X.dI[d];
        return out.FG * X.dG[d] + out.FO * X.dO[d] + out.FW * X.dW[d] + out.FI * X.dI[d];
    };
    // the volume balance of cell f−1 for the flux of its top face at fixed pressures: Σ_c ∂V/∂m_c F_c,f(Q) = rhs (g monotone increasing in
    // Q; bracketed secant / bisection — robust where the counter-current flux has a kink). Used to polish Newton's fluxes (§11.1).
    P._solveFace = function (f, rhs, Qg, out) {
        var X = this.X, d = f - 1, self = this;
        var g = function (Q) { self._faceFlux(f, Q, out); return out.FG * X.dG[d] + out.FO * X.dO[d] + out.FW * X.dW[d] + out.FI * X.dI[d]; };
        var tol = 1e-12 * Math.max(Math.abs(rhs), 1e-9) + 1e-15;
        var g0 = g(Qg); if (Math.abs(g0 - rhs) <= tol) return Qg;
        var step = Math.max(1e-6, 1e-3 * Math.abs(Qg)), a, b, ga, gb;
        if (g0 < rhs) { a = Qg; ga = g0; b = Qg + step; gb = g(b); for (var e = 0; gb < rhs && e < 80; e++) { a = b; ga = gb; step *= 2; b = b + step; gb = g(b); } }
        else { b = Qg; gb = g0; a = Qg - step; ga = g(a); for (var e2 = 0; ga > rhs && e2 < 80; e2++) { b = a; gb = ga; step *= 2; a = a - step; ga = g(a); } }
        var x = Qg;
        for (var it = 0; it < 80; it++) {
            x = (gb > ga && it % 3 !== 2) ? a + (rhs - ga) * (b - a) / (gb - ga) : 0.5 * (a + b);
            if (!(x > a && x < b)) x = 0.5 * (a + b);
            var gx = g(x);
            if (Math.abs(gx - rhs) <= tol || (b - a) <= 1e-15 * Math.max(1, Math.abs(x))) return x;
            if (gx < rhs) { a = x; ga = gx; } else { b = x; gb = gx; }
        }
        return x;
    };
    // ── friction gradient (psi/ft) of cell i at the mean flux j (§4.5) ──────────────────────────────────────────────
    // friction gradient (psi/ft) of cell i at the mean flux j (§4.5): the correlation's gradient scaled by (j / j_last)² with the sign of j,
    // blended into the single-phase mixture (Moody) form over j_lo ≤ |j| ≤ j_hi (smoothstep, C1) — a hard switch at j_lo made the
    // pressure profile jump and the closed column slosh (§11.1); below j_lo, or without a correlation call, the mixture form alone
    P._gfMoody = function (i, j) {
        if (j === 0) return 0;
        var cs = this.cs, X = this.X, rho = cs.rhoM[i], mu = cs.ag[i] * X.mug[i] + cs.ao[i] * X.muo[i] + cs.aw[i] * X.muw[i], d = X.dft[i];
        var Re = 1488 * rho * Math.abs(j) * d / Math.max(1e-4, mu), fM = _moody(Re, this.grid.rough / 12 / d);
        return fM * rho * j * Math.abs(j) / (2 * GC * d * 144);
    };
    P._gfMoodyD = function (i, j) {
        var cs = this.cs, X = this.X, rho = cs.rhoM[i], mu = cs.ag[i] * X.mug[i] + cs.ao[i] * X.muo[i] + cs.aw[i] * X.muw[i], d = X.dft[i];
        var Re = 1488 * rho * Math.max(Math.abs(j), 1e-6) * d / Math.max(1e-4, mu), fM = _moody(Re, this.grid.rough / 12 / d);
        return 2 * fM * rho * Math.abs(j) / (2 * GC * d * 144);
    };
    P._gfW = function (i, j) {
        var X = this.X, jl = this.o.closureOpt.jLo, jh = this.o.closureOpt.jHi;
        if (!X.haveCorr[i] || !(Math.abs(X.jL[i]) >= jl)) return 0;
        var aj = Math.abs(j); return aj >= jh ? 1 : (aj > jl ? _ss((aj - jl) / (jh - jl)) : 0);
    };
    P._gf = function (i, j) {
        var X = this.X, w = this._gfW(i, j), m = w < 1 ? this._gfMoody(i, j) : 0;
        if (w <= 0) return m;
        var r = j / X.jL[i], c = Math.abs(X.gfL[i]) * (j >= 0 ? 1 : -1) * r * r;
        return w * c + (1 - w) * m;
    };
    P._gfd = function (i, j) {
        var X = this.X, w = this._gfW(i, j);
        if (w <= 0) return this._gfMoodyD(i, j);
        var cd = 2 * Math.abs(X.gfL[i]) * Math.abs(j) / (X.jL[i] * X.jL[i]);
        if (w >= 1) return cd;
        var jl = this.o.closureOpt.jLo, jh = this.o.closureOpt.jHi, x = (Math.abs(j) - jl) / (jh - jl), dw = 6 * x * (1 - x) / (jh - jl) * (j >= 0 ? 1 : -1);
        var r = j / X.jL[i], c = Math.abs(X.gfL[i]) * (j >= 0 ? 1 : -1) * r * r, m = this._gfMoody(i, j);
        return w * cd + (1 - w) * this._gfMoodyD(i, j) + dw * (c - m);
    };
    // the inflow at face 0 (§4.7): stock-tank rates → mass rates; back-flow takes cell 0's contents (liquid first)
    P._inflow = function (q, p0, T) {
        var u = this.unit, k = this.k, X = this.X, cs = this.cs;
        T.q0 = q;
        if (q >= 0) {
            this._backflowNow = this._backflowNow || false;
            var qo = u.qo * q, qw = u.qw * q, qg = u.qg * q;
            T.FO[0] = qo * k.O / 86400; T.FW[0] = qw * k.W / 86400; T.FG[0] = qg * k.G / 86400; T.FI[0] = 0; T.FF[0] = 0;
            // the in-situ volume of the stream at cell 0's state (for the record)
            T.Q0 = X.dO[0] * T.FO[0] + X.dW[0] * T.FW[0] + X.dG[0] * T.FG[0];
            T.jg[0] = 0; T.jo[0] = 0; T.jw[0] = 0;
            return;
        }
        // back-flow: the formation stream's volume per unit rate at cell 0, then the drift-flux split (gas stays unless the downflow wins)
        var v1 = (u.qo * FT3 * X.bo[0] + u.qw * FT3 * X.bw[0] + Math.max(0, u.qg - u.qo * X.rs[0]) * X.bg[0]) / 86400;
        if (!(v1 > 0)) v1 = FT3 / 86400;
        var Q0 = q * v1, A = this.Y.A[0], j = Q0 / A, a0 = cs.ag[0];
        var jg = Math.min(0, this._dfFlux(1, a0, j)); if (jg < j) jg = j;
        var jL = j - jg, aL = cs.ao[0] + cs.aw[0], fw = aL > 0 ? cs.aw[0] / aL : 0, jw = fw * jL, jo = jL - jw;
        var FW = X.bw[0] > 0 ? A * jw / (FT3 * X.bw[0]) * k.W : 0, Nof = X.bo[0] > 0 ? A * jo / (FT3 * X.bo[0]) : 0;
        var FGf = X.bg[0] > 0 ? A * jg * (1 - X.xI[0]) / X.bg[0] * k.G : 0, FI = X.bg[0] > 0 ? A * jg * X.xI[0] / X.bg[0] * k.I : 0;
        if (cs.mW[0] <= 0) FW = 0; if (cs.mO[0] <= 0) Nof = 0;
        T.FW[0] = FW; T.FO[0] = Nof * k.O; T.FG[0] = FGf + Nof * X.rd[0] * k.G; T.FI[0] = FI; T.FF[0] = cs.mW[0] > 0 ? FW * cs.mF[0] / cs.mW[0] : 0;
        T.jg[0] = jg; T.jo[0] = jo; T.jw[0] = jw;
        T.Q0 = Q0;
        this._backflowNow = true;
    };

    // ── choke (§4.8): the stock-tank measure through the bean at the trial wellhead pressure ────────────────────────────
    P._chokePrep = function (tEnd) {
        var S = this.state, C = this.C, ctl = S.ctl, fs = this.fs, k = this.k, n = this.n;
        // the effective bean at the end of the step (area moves linearly over the stroke)
        var b = S.beanEff;
        if (ctl.strokeLeft_s > 0) {
            var tot = Math.max(1e-9, ctl.strokeTime_s), left = Math.max(0, ctl.strokeLeft_s - (tEnd - S.t)), fr = 1 - left / tot;
            var a0 = ctl.beanFrom * ctl.beanFrom, a1 = ctl.beanTo * ctl.beanTo;
            b = Math.sqrt(Math.max(0, a0 + (a1 - a0) * _clamp(fr, 0, 1)));
        }
        var ch = this.ch = { bean: b, closed: !C.choke.present ? false : !(b > 1e-9), mode: 'closed' };
        if (!C.choke.present) { ch.mode = _fin(C.thpFix) && !C.maxBC ? 'fixed' : 'line'; }
        // the lagged composition of the face-n stream (or of the top cell when nothing flowed)
        var FO = fs.FO[n], FW = fs.FW[n], FG = fs.FG[n], FI = fs.FI[n];
        var qL = (FO / k.O + FW / k.W) * 86400, qgT = (FG / k.G + FI / k.I) * 86400;          // STB/d, scf/d
        if (!(qL + qgT / 1000 > 1e-9)) {
            var c = n - 1; qL = this.cs.mO[c] / k.O + this.cs.mW[c] / k.W; qgT = this.cs.mG[c] / k.G + this.cs.mI[c] / k.I;
        }
        var glr = qL > 1e-9 ? qgT / qL : Infinity;
        ch.glr = glr;
        ch.sgL = qL > 0 ? (((FW > 0 ? FW / k.W : 0) * C.F.sgw + (FO > 0 ? FO / k.O : 0) * (141.5 / (131.5 + C.F.api))) / Math.max(1e-12, (FW > 0 ? FW / k.W : 0) + (FO > 0 ? FO / k.O : 0))) : C.F.sgw;
        if (!_fin(ch.sgL) || !(ch.sgL > 0)) ch.sgL = 1;
        // p_dn at the lagged basis rate
        var qb = this.gasWell() ? S.surface.qg : S.surface.qL;
        ch.pdn = this._pdn(qb);
        if (!ch.closed && C.choke.present) {
            if (this.gasWell()) ch.mode = 'gas';
            else {
                var prevGas = ctl.chokeMode === 'gasNozzle';
                ch.mode = (glr > (prevGas ? GLR_GAS_OFF : GLR_GAS_ON)) ? 'gasNozzle' : (glr < GLR_LIQ ? 'liquid' : 'multiphase');
            }
            ch.T = this.o.temperature === 'frozen' ? this.thtRef : this.cs.T[n - 1];
            if (ch.mode === 'gas' || ch.mode === 'gasNozzle') {
                ch.k = this._kGas(ch.T); ch.cd = (C.choke.cd >= 0.5 && C.choke.cd <= 1.2) ? C.choke.cd : 0.85;
                ch.sg = ch.mode === 'gas' ? C.F.sgg : Math.max(0.55, (qgT > 0 ? ((FG / k.G) * C.F.sgg + (FI / k.I) * k.sgI) / Math.max(1e-12, FG / k.G + FI / k.I) : C.F.sgg));
                if (!_fin(ch.sg)) ch.sg = C.F.sgg;
                ch.rc = Math.pow(2 / (ch.k + 1), ch.k / (ch.k - 1));
            } else if (ch.mode === 'multiphase') {
                var mp = G.WTS_chokeperf_multiphaseRate;
                ch.per = typeof mp === 'function' ? mp(C.choke.corr === 'sachdeva' ? 'gilbert' : C.choke.corr, 1, b, glr) : NaN;
                ch.yc = NS.GILBERT_YC();
                if (C.choke.sub === 'sachdeva' && typeof G.WTS_chokeperf_sachdeva === 'function') ch.sach = true;
            } else if (ch.mode === 'liquid') {
                ch.cd = (C.choke.cd >= 0.5 && C.choke.cd <= 1.2) ? C.choke.cd : 0.85;
            }
        }
        return ch;
    };
    P._kGas = function (T) {
        if (_fin(this.C.kGas)) return this.C.kGas;
        var st = typeof G.WTS_gaspvt_state === 'function' ? G.WTS_gaspvt_state(this.C.F.sgg, 1000, T) : null;
        return (st && st.k > 1 && st.k < 1.7) ? st.k : 1.28;
    };
    // choke measure at p_n (psia): gas wells Mscf/d (formation + lift gas), oil wells liquid STB/d or (gas nozzle) total gas Mscf/d
    P._chokeQ = function (pn) {
        var ch = this.ch, C = this.C;
        if (ch.mode === 'closed') return 0;
        var pdn = ch.pdn, y = pdn / pn;
        ch.y = y;
        if (ch.mode === 'gas' || ch.mode === 'gasNozzle') {
            var zz = (C.F.at(Math.max(pn, 15), ch.T) || {}).z || 0.9;
            var q = G.WTS_chokeperf_gasRate({ s64: ch.bean, cd: ch.cd, p1a: pn, p2a: pdn, tR: ch.T + RANK, sg: ch.sg, k: ch.k, z: zz });
            ch.regime = y <= ch.rc ? 'critical' : 'subcritical'; ch.ycNow = ch.rc;
            return _fin(q) && q > 0 ? q : 0;
        }
        if (ch.mode === 'liquid') {
            var dp = pn - pdn; ch.regime = 'liquid'; ch.ycNow = NaN;
            if (!(dp > 0)) return 0;
            var d = ch.bean / 64; return 1022.7 * ch.cd * d * d * Math.sqrt(dp / ch.sgL);
        }
        // multiphase (Gilbert family): critical q_c = per · p1_psig; sub-critical = the provisional closing shape (§4.8)
        var qc = ch.per > 0 ? ch.per * (pn - PATM) : 0, yc = ch.yc;
        ch.ycNow = yc;
        if (y <= yc) { ch.regime = 'critical'; return qc > 0 ? qc : 0; }
        ch.regime = 'subcritical';
        if (y >= 1) return 0;
        var x = (y - yc) / (1 - yc);
        return qc > 0 ? qc * Math.sqrt(Math.max(0, 1 - x * x)) : 0;
    };
    // the measure of the face-n stream (the trial's top-face fluxes)
    P._measure = function (T) {
        var k = this.k, n = this.n, ch = this.ch;
        if (ch.mode === 'gas' || ch.mode === 'gasNozzle') return (T.FG[n] / k.G + T.FI[n] / k.I) * 86400 / 1000;
        return (T.FO[n] / k.O + T.FW[n] / k.W) * 86400;
    };

    // ── flowline back pressure p_dn(q) (§4.8) ───────────────────────────────────────────────────────────────────────
    // the line table from stored rows (a ref of the same model, a Snap): no march
    P._lineFrom = function (src) {
        var L = { refGor: src.refGor, refWc: src.refWc, q: src.q.slice(), pdn: src.pdn.slice(), unit: src.unit, psep: src.psep, flowline: !!src.flowline };
        var pc = (G.WTS_wp_system && typeof G.WTS_wp_system._pchip === 'function' && L.q.length >= 3) ? G.WTS_wp_system._pchip(L.q, L.pdn) : null;
        L.f = function (q) {
            var xs = L.q, ys = L.pdn, nn = xs.length;
            if (!(q > 0)) return ys[0];
            if (q >= xs[nn - 1]) { var sl = (ys[nn - 1] - ys[nn - 2]) / (xs[nn - 1] - xs[nn - 2]); return ys[nn - 1] + sl * (q - xs[nn - 1]); }
            if (pc) return pc.f(q);
            for (var i2 = 1; i2 < nn; i2++) if (xs[i2] >= q) return ys[i2 - 1] + (ys[i2] - ys[i2 - 1]) * (q - xs[i2 - 1]) / (xs[i2] - xs[i2 - 1]);
            return ys[nn - 1];
        };
        this.line = L;
    };
    P._buildLine = function (refStream) {
        var C = this.C, S = this.state, gas = this.gasWell();
        var psepA = S.psep_psig + PATM;
        var flow = (C.flowline || []).filter(function (s) { return s && +s.len > 0 && +s.id > 0; });
        // the reference stream per unit basis rate: the produced stream (or the given composition)
        var u = refStream || { qo: this.unit.qo, qw: this.unit.qw, qg: this.unit.qg, qi: (C.gl ? C.gl.qinj * 1000 / Math.max(1e-9, haveOpQ(this.R0)) : 0) };
        var qop = haveOpQ(this.R0) || (gas ? 0.1 * C.aof : 0.1 * C.aof);
        var qmax = 1.5 * Math.max(qop, 0.1 * C.aof);
        var L = { refGor: u.qo > 0 ? u.qg / u.qo : 0, refWc: (u.qo + u.qw) > 0 ? u.qw / (u.qo + u.qw) : 0, q: [], pdn: [], unit: u, psep: S.psep_psig, flowline: flow.length > 0 };
        if (!flow.length) { L.q = [0, qmax]; L.pdn = [psepA, psepA]; }
        else {
            var segs = flow.map(function (s) { return { name: s.name || 'Flowline', len: +s.len, id: +s.id, dz: +s.dz || 0 }; });
            var mo = { reverse: true, corr: C.corrLine, stepFt: C.stepFtLine, rough: 0.0018, accel: true, payne: true, refine: C.refine, eroC: C.eroC };
            var tl = this.thtRef, last = psepA;
            for (var i = 0; i < 12; i++) {
                var q = qmax * i / 11;
                if (q === 0) { L.q.push(0); L.pdn.push(psepA); continue; }
                var view = { qo: u.qo * q, qw: u.qw * q, qg: (u.qg * q) / 1e6, api: C.F.api, sgg: C.F.sgg, sgw: C.F.sgw, pvt: C.F.pvt };
                if (u.qi > 0) { view.pvt = Object.assign({}, this.pvtLift, { injGas: { qg_MMscfd: u.qi * q / 1e6, sg: this.k.sgI } }); }
                var m = G.WTS_flowline_march(segs, view, S.psep_psig, tl, tl, mo);
                if (!m || m.ok === false || m.lost || !_fin(m.pOut)) break;
                last = m.pOut + PATM;
                L.q.push(q); L.pdn.push(last);
            }
            if (L.q.length < 2) { L.q = [0, qmax]; L.pdn = [psepA, psepA]; }
        }
        var pc = (G.WTS_wp_system && typeof G.WTS_wp_system._pchip === 'function' && L.q.length >= 3) ? G.WTS_wp_system._pchip(L.q, L.pdn) : null;
        L.f = function (q) {
            var xs = L.q, ys = L.pdn, nn = xs.length;
            if (!(q > 0)) return ys[0];
            if (q >= xs[nn - 1]) { var sl = (ys[nn - 1] - ys[nn - 2]) / (xs[nn - 1] - xs[nn - 2]); return ys[nn - 1] + sl * (q - xs[nn - 1]); }
            if (pc) return pc.f(q);
            for (var i2 = 1; i2 < nn; i2++) if (xs[i2] >= q) return ys[i2 - 1] + (ys[i2] - ys[i2 - 1]) * (q - xs[i2 - 1]) / (xs[i2] - xs[i2 - 1]);
            return ys[nn - 1];
        };
        this.line = L;
    };
    P._pdn = function (q) { return this.line ? this.line.f(q) : this.state.psep_psig + PATM; };

    // ── initial states ──────────────────────────────────────────────────────────────────────────────────────────────
    P._setCellFromHoldup = function (i, p, hl, stream) {
        // fill cell i at pressure p with liquid holdup hl of the given stream (stock-tank per unit: qo, qw STB, qg scf formation gas, qi scf
        // lift gas) and free gas 1 − hl; the free gas is split between formation and lift gas in their flowing ratio
        var cs = this.cs, X = this.X, k = this.k, V = X.vol[i], qi = stream.qi > 0 ? stream.qi : 0;
        var view = { qo: stream.qo, qw: stream.qw, qg: stream.qg / 1e6, api: this.C.F.api, sgg: this.C.F.sgg, sgw: this.C.F.sgw, pvt: this.C.F.pvt };
        if (qi > 0) { this.pvtLift.injGas.qg_MMscfd = qi / 1e6; view.pvt = this.pvtLift; }
        if (!(view.qo > 0) && !(view.qw > 0) && !(view.qg > 0)) view.qg = 1e-12;
        var pr = G.WTS_flowline_props(view, p, cs.T[i]);
        var VL = FT3 * stream.qo * pr.bo + FT3 * stream.qw * pr.bw;
        var rsU = stream.qo > 0 ? Math.min(pr.rs, stream.qg / stream.qo) : 0;
        var No = 0, Nw = 0, Gd = 0;
        if (VL > 0) { var sL = hl * V / VL; No = stream.qo * sL; Nw = stream.qw * sL; Gd = No * rsU; }
        var Gfree = (1 - hl) * V / pr.bg, freeForm = Math.max(0, stream.qg - stream.qo * rsU), shareI = qi > 0 ? qi / (qi + freeForm) : 0;
        cs.mO[i] = No * k.O; cs.mW[i] = Nw * k.W; cs.mG[i] = (Gd + Gfree * (1 - shareI)) * k.G; cs.mI[i] = Gfree * shareI * k.I; cs.mF[i] = 0;
        cs.p[i] = p;
    };
    P._initSteady = function () {
        var R0 = this.R0, rows = R0.traverse.profile.filter(function (r) { return !r.restr; }), n = this.n, g = this.grid, cs = this.cs, fs = this.fs;
        var at = function (md, key) {
            for (var r = 1; r < rows.length; r++) if (rows[r].md >= md) { var a = rows[r - 1], b = rows[r], f = b.md > a.md ? (md - a.md) / (b.md - a.md) : 0; return a[key] + (b[key] - a[key]) * f; }
            return rows[rows.length - 1][key];
        };
        var q = R0.op.q, u = this.unit, st = { qo: u.qo * q, qw: u.qw * q, qg: u.qg * q, qi: 0 }, glr = this._glRef();
        var stI = { qo: st.qo, qw: st.qw, qg: st.qg, qi: glr * q };
        var streamOf = function (i) { return (glr > 0 && g.injCell >= 0 && i >= g.injCell) ? stI : st; };
        for (var i = 0; i < n; i++) {
            var c = g.cells[i], p = at(c.mdc, 'p'), hl = _clamp(at(c.mdc, 'hl'), 0, 1);
            this._setCellFromHoldup(i, p, hl, streamOf(i));
        }
        for (var k2 = 0; k2 <= n; k2++) fs.p[k2] = at(g.faces[k2].md, 'p');
        // the face fluxes of the produced stream (stock-tank constant along the well; lift gas above the injection cell)
        var FO = st.qo * this.k.O / 86400, FW = st.qw * this.k.W / 86400, FG = st.qg * this.k.G / 86400;
        for (var f = 0; f <= n; f++) {
            fs.FO[f] = FO; fs.FW[f] = FW; fs.FG[f] = FG;
            fs.FI[f] = (glr > 0 && this.grid.injCell >= 0 && f > this.grid.injCell) ? glr * q * this.k.I / 86400 : 0;
        }
        // in-situ face volume rates and superficial velocities from the face's lower cell
        var self = this, X = this.X;
        var faceQ = function () {
            for (var f2 = 0; f2 <= n; f2++) {
                var d = f2 === 0 ? 0 : f2 - 1;
                var No = fs.FO[f2] / self.k.O, Nw = fs.FW[f2] / self.k.W, Gt = fs.FG[f2] / self.k.G, GI2 = fs.FI[f2] / self.k.I;
                var rsd = No > 0 ? Math.min(X.rs[d], Gt / No) : 0;
                var Vo = FT3 * No * X.bo[d], Vw = FT3 * Nw * X.bw[d], Vg = (Math.max(0, Gt - No * rsd) + GI2) * X.bg[d];
                var A = self.Y.A[f2];
                fs.Q[f2] = Vo + Vw + Vg; fs.jg[f2] = Vg / A; fs.jo[f2] = Vo / A; fs.jw[f2] = Vw / A; fs.xI[f2] = X.xI[d];
            }
        };
        this._prep(true); faceQ();
        // equilibrate: the engine's own discretised steady column (its march, its closure fixed point) from the nodal THP — so the
        // first step starts at rest in the engine's own discretisation, not at the traverse's 100 ft steps
        var thp = R0.surface.thp;
        for (var itq = 0; itq < 4; itq++) {
            this._prep(true);
            var pk = this.tmp.p; pk[n] = thp;
            for (var c2 = n - 1; c2 >= 0; c2--) {
                var jm = 0.5 * (fs.Q[c2] + fs.Q[c2 + 1]) / X.area[c2];
                var pc = pk[c2 + 1] + ((cs.rhoM[c2] + X.drho[c2]) * X.dz[c2] / 144 + this._gf(c2, jm) * X.len[c2]) / (1 - X.Ek[c2]);
                if (this.Y.restrK[c2] > 0) { var jr = fs.Q[c2] / this.Y.A[c2] / this.Y.restrB2[c2]; pc += this.Y.restrK[c2] * this.Y.rhoN[c2] * jr * Math.abs(jr) / (2 * GC * 144); }
                pk[c2] = pc;
            }
            for (var i2 = 0; i2 < n; i2++) {
                var hl2 = X.haveCorr[i2] ? X.hl[i2] : (1 - cs.ag[i2]);
                this._setCellFromHoldup(i2, 0.5 * (pk[i2] + pk[i2 + 1]), _clamp(hl2, 0, 1), streamOf(i2));
            }
            for (var k3 = 0; k3 <= n; k3++) fs.p[k3] = pk[k3];
            this._prep(true); faceQ();
        }
        this.state.surface.qL = st.qo + st.qw; this.state.surface.qg = st.qg / 1000;
        this.state.qRef = this.gasWell() ? st.qg / 1000 : st.qo + st.qw;
        return { ok: true };
    };
    P._initStatic = function (spec) {
        var n = this.n, cs = this.cs, X = this.X, k = this.k, C = this.C, F = C.F, g = this.grid, fs = this.fs;
        var kind = spec.kind === 'liquid' ? 'liquid' : (spec.kind === 'level' ? 'level' : 'gas');
        var liq = spec.liquid || (this.gasWell() ? 'water' : 'oil');
        var pr0 = C.pr, psepA = this.state.psep_psig + PATM;
        var topLiq = kind === 'liquid' ? g.cells[n - 1].md0 : (kind === 'level' ? (_fin(spec.liquidTopMd) ? spec.liquidTopMd : g.mdTotal / 2) : Infinity);
        var gasStream = { qo: 0, qw: 0, qg: 1e6 }, oilStream = { qo: 1, qw: 0, qg: Math.max(0, F.gor || 0) }, watStream = { qo: 0, qw: 1, qg: 0 };
        var liqStream = liq === 'water' ? watStream : oilStream;
        if (F.type !== 'oil' && liq === 'oil') liqStream = { qo: 1, qw: 0, qg: 0 };
        var isLiq = function (i) { return g.cells[i].mdc > topLiq; };
        // density of a cell's fluid at p (lbm/ft³)
        var self = this;
        function rhoAt(i, p) {
            var st = isLiq(i) ? liqStream : gasStream, view = { qo: st.qo, qw: st.qw, qg: st.qg / 1e6, api: F.api, sgg: F.sgg, sgw: F.sgw, pvt: F.pvt };
            var pr = G.WTS_flowline_props(view, p, cs.T[i]);
            if (st === gasStream) return pr.rhoG;
            if (st.qw > 0) return pr.rhoW;
            var Vo = pr.bo, rsU = Math.min(pr.rs, st.qg), free = Math.max(0, st.qg - rsU);
            return free > 0 ? (pr.rhoO * FT3 * Vo + pr.rhoG * free * pr.bg) / (FT3 * Vo + free * pr.bg) : pr.rhoO;
        }
        // hydrostatic column from p0 = p̄r upward; when that would put the wellhead below the separator pressure the column is
        // overbalanced: the wellhead is held at the separator pressure and the bottom exceeds p̄r (a kill column, §3.9 killColumn)
        function column(p0) {
            var pk = new Float64Array(n + 1); pk[0] = p0;
            for (var i = 0; i < n; i++) {
                var pa = pk[i], pc = pa;
                for (var it = 0; it < 3; it++) { var rh = rhoAt(i, Math.max(1, pc)); var pb = pa - rh * X.dz[i] / 144; pc = 0.5 * (pa + pb); }
                pk[i + 1] = pa - rhoAt(i, Math.max(1, pc)) * X.dz[i] / 144;
            }
            return pk;
        }
        var pk = column(pr0);
        if (kind !== 'gas' && pk[n] < psepA) {
            // march down from the separator pressure instead
            pk = new Float64Array(n + 1); pk[n] = psepA;
            for (var j = n - 1; j >= 0; j--) {
                var pa2 = pk[j + 1], pc2 = pa2;
                for (var it2 = 0; it2 < 3; it2++) { var rh2 = rhoAt(j, Math.max(1, pc2)); pc2 = pa2 + 0.5 * rh2 * X.dz[j] / 144; }
                pk[j] = pa2 + rhoAt(j, Math.max(1, pc2)) * X.dz[j] / 144;
            }
        }
        for (var f = 0; f <= n; f++) fs.p[f] = pk[f];
        for (var i = 0; i < n; i++) {
            var p = 0.5 * (pk[i] + pk[i + 1]);
            if (isLiq(i)) {
                if (liqStream.qw > 0) { this._setCellFromHoldup(i, p, 1, watStream); }
                else {
                    // oil with its solution gas at the cell pressure (free gas if the GOR exceeds Rs(p))
                    var view = { qo: 1, qw: 0, qg: liqStream.qg / 1e6, api: F.api, sgg: F.sgg, sgw: F.sgw, pvt: F.pvt };
                    var pr = G.WTS_flowline_props(view, p, cs.T[i]);
                    var rsU = Math.min(pr.rs, liqStream.qg), free = liqStream.qg - rsU, vU = FT3 * pr.bo + free * pr.bg, s = X.vol[i] / vU;
                    cs.mO[i] = s * k.O; cs.mG[i] = s * liqStream.qg * k.G; cs.mW[i] = 0; cs.mI[i] = 0; cs.mF[i] = 0; cs.p[i] = p;
                }
            } else this._setCellFromHoldup(i, p, 0, gasStream);
        }
        for (var f2 = 0; f2 <= n; f2++) { fs.Q[f2] = 0; fs.jg[f2] = 0; fs.jo[f2] = 0; fs.jw[f2] = 0; fs.FG[f2] = fs.FO[f2] = fs.FW[f2] = fs.FI[f2] = fs.FF[f2] = 0; }
        // a static well starts shut in; open() (an event) starts the flow
        var S = this.state;
        S.open = 0; S.beanEff = 0; S.well.state = 'shutin';
        return { ok: true };
    };

    // ── totals ───────────────────────────────────────────────────────────────────────────────────────────────────────
    P._totals = function () {
        var cs = this.cs, n = this.n, t = { G: 0, O: 0, W: 0, I: 0 };
        for (var i = 0; i < n; i++) { t.G += cs.mG[i]; t.O += cs.mO[i]; t.W += cs.mW[i]; t.I += cs.mI[i]; }
        return t;
    };

    // ── events (§3.5) ───────────────────────────────────────────────────────────────────────────────────────────────
    P.schedule = function (events) {
        var S = this.state, self = this, added = 0;
        (events || []).forEach(function (e) {
            if (!e || typeof e !== 'object' || !_fin(+e.t)) return;
            var t = Math.max(+e.t, S.t);
            self.pend.push({ t: t, type: String(e.type || ''), args: e.args ? JSON.parse(JSON.stringify(e.args)) : {}, src: e.src || 'scenario', seq: self._seq = (self._seq || 0) + 1 });
            added++;
        });
        this.pend.sort(function (a, b) { return a.t - b.t || a.seq - b.seq; });
        return { ok: true, n: added };
    };
    P._apply = function (e) {
        var S = this.state, ctl = S.ctl, C = this.C, a = e.args || {};
        var stroke = function (to) {
            ctl.beanFrom = S.beanEff; ctl.beanTo = to;
            ctl.strokeLeft_s = ctl.strokeTime_s > 0 ? ctl.strokeTime_s : 0;
            if (!(ctl.strokeLeft_s > 0)) S.beanEff = to;
        };
        switch (e.type) {
            case 'open':
                if (!S.open) { S.open = 1; S.tOpen = e.t; S.qRef = 0; this._resetLabels(e.t); }
                if (C.choke.present) stroke(S.bean64 > 0 ? S.bean64 : (C.choke.bean || 16));
                break;
            case 'shutin':
                S.open = 0;
                if (C.choke.present) stroke(0); else S.beanEff = 0;
                break;
            case 'bean':
                if (_fin(+a.bean64) && +a.bean64 >= 0) { S.bean64 = +a.bean64; if (S.open && C.choke.present) stroke(S.bean64); }
                break;
            case 'psep':
                if (_fin(+a.psig)) { S.psep_psig = +a.psig; this._buildLine(this.line ? this.line.unit : null); }
                break;
            case 'foamer':
                S.foamer.on = !!a.on; S.foamer.ppm = _fin(+a.ppm) ? +a.ppm : S.foamer.ppm; S.foamer.injMd = _fin(+a.injMd) ? +a.injMd : null;
                break;
            case 'gl': S.lift.glCmd = { qinj_Mscfd: _n(a.qinj_Mscfd), mode: a.mode || null }; break;
            case 'esp': S.lift.espCmd = { on: a.on !== false, freq: _n(a.freq), ramp_Hz_s: _n(a.ramp_Hz_s) }; break;
            case 'cycle': S.cycle = JSON.parse(JSON.stringify(a)); break;
            case 'end': ctl.ended = true; break;
            default: break;
        }
        var rec = { t: e.t, type: e.type, args: a, src: e.src || 'user' };
        this.log.push(rec);
        this._emit('event', rec);
    };
    P._userEvent = function (type, args) {
        var e = { t: this.state.t, type: type, args: args || {}, src: 'user' };
        this._apply(e);
        return { ok: true, event: e };
    };
    P.setChoke = function (bean64) { return this._userEvent('bean', { bean64: +bean64 }); };
    P.shutIn = function () { return this._userEvent('shutin', {}); };
    P.open = function () { return this._userEvent('open', {}); };
    P.setSeparator = function (psig) { return this._userEvent('psep', { psig: +psig }); };
    P.setFoamer = function (spec) { spec = spec || {}; return this._userEvent('foamer', { on: !!spec.on, ppm: _n(spec.ppm), injMd: _n(spec.injMd) }); };
    P.setLift = function (spec) {
        spec = spec || {};
        if (spec.type === 'esp') return this._userEvent('esp', { on: spec.on !== false, freq: _n(spec.freq), ramp_Hz_s: _n(spec.ramp_Hz_s) });
        return this._userEvent('gl', { qinj_Mscfd: _n(spec.qinj_Mscfd), mode: spec.mode || null });
    };

    // ── the time step (§4.6) ────────────────────────────────────────────────────────────────────────────────────────
    P._cflDt = function () {
        var n = this.n, cs = this.cs, fs = this.fs, X = this.X, Y = this.Y, o = this.o, vmax = 1e-6, best = Infinity;
        for (var f = 1; f <= n; f++) {
            var d = f - 1, A = Y.A[f], j = fs.Q[f] / A;
            var ag = cs.ag[d], aL = 1 - ag;
            var vg = ag > 1e-6 ? Math.abs(fs.jg[f]) / ag : Math.abs(fs.jg[f]) / 1e-6, vl = aL > 1e-6 ? Math.abs(fs.jo[f] + fs.jw[f]) / aL : 0;
            if (vg > 1e3) vg = 1e3;
            // kinematic-wave speed λ = ∂f/∂α (central, ±1e-3)
            var vdc = _fin(fs.vd[f]) ? fs.vd[f] : 0, w = Y.elig[f] > 0 ? fs.w[f] : 0, e = 1e-3;
            var lam = Math.abs((this._flux(f, Math.min(1, ag + e), j, vdc, w) - this._flux(f, Math.max(0, ag - e), j, vdc, w)) / (Math.min(1, ag + e) - Math.max(0, ag - e)));
            // a single-phase face pair moves nothing along that characteristic: λ is weighted by the minority-phase content of the pair
            var au = f < n ? cs.ag[f] : ag, minor = Math.min(Math.max(1 - ag, 1 - au), Math.max(ag, au));
            if (minor < 1e-4) lam *= minor / 1e-4;
            Y.lam[f] = lam;
            var v = Math.max(vg, vl, lam, 1e-6), dl = Math.min(X.len[d], f < n ? X.len[f] : X.len[d]);
            var dt = o.cfl * dl / v;
            if (dt < best) best = dt;
            if (v > vmax) vmax = v;
        }
        return best;
    };
    P.step = function (dtReq) {
        var S = this.state, o = this.o, t0w = _now();
        if (this.ended || S.ctl.ended) return { ok: false, t: S.t, dt: 0, code: 'ENDED', applied: [] };
        // events due now
        var applied = [];
        while (this.pend.length && this.pend[0].t <= S.t + 1e-9) { var e = this.pend.shift(); this._apply(e); applied.push(e); }
        if (S.ctl.ended) { this.ended = true; this._emit('end', { t: S.t }); return { ok: true, t: S.t, dt: 0, iters: 0, sweeps: 0, rejects: 0, massErr: { G: 0, O: 0, W: 0, I: 0 }, applied: applied, code: 'END' }; }
        // extension control (once per step, first)
        for (var xi = 0; xi < this.exts.length; xi++) {
            var X1 = this.exts[xi]; if (typeof X1.e.control !== 'function') continue;
            var evs = X1.e.control(this, X1.ctx, S.t);
            if (Array.isArray(evs)) for (var ej = 0; ej < evs.length; ej++) { var ev = Object.assign({ src: 'controller' }, evs[ej], { t: S.t }); this._apply(ev); applied.push(ev); }
        }
        // step size
        var dt = Math.min(o.dtMax, this.dtPrev > 0 ? 1.5 * this.dtPrev : 1, this._cflDt());
        var tEv = this.pend.length ? this.pend[0].t : Infinity, landing = false;
        if (S.ctl.strokeLeft_s > 0) dt = Math.min(dt, Math.max(S.ctl.strokeTime_s / 5, 1e-3), S.ctl.strokeLeft_s);
        if (_fin(+dtReq) && +dtReq > 0) dt = Math.min(dt, +dtReq);
        if (S.t + dt >= tEv - 1e-9) { dt = tEv - S.t; landing = true; }
        dt = Math.max(dt, o.dtMin);
        // sources from the extensions (lagged pressures, fixed for the step)
        var src = this.src, n = this.n;
        for (var si = 0; si < n; si++) { src.G[si] = 0; src.O[si] = 0; src.W[si] = 0; src.I[si] = 0; src.F[si] = 0; }
        for (var xk = 0; xk < this.exts.length; xk++) {
            var X2 = this.exts[xk]; if (typeof X2.e.sources !== 'function') continue;
            var sr = X2.e.sources(this, X2.ctx, dt);
            if (sr) COMP.forEach(function (cc) { var a = sr[cc]; if (a && a.length === n) for (var q = 0; q < n; q++) src[cc][q] += a[q]; });
        }
        // face Δp linearisation (pump)
        var Y = this.Y, fs = this.fs;
        for (var fk = 0; fk <= n; fk++) { Y.dpPump[fk] = 0; Y.ddpPump[fk] = 0; Y.Qlag[fk] = fs.Q[fk]; }
        for (var xf = 0; xf < this.exts.length; xf++) {
            var X3 = this.exts[xf]; if (typeof X3.e.faceDp !== 'function') continue;
            for (var fk2 = 0; fk2 <= n; fk2++) { var r = X3.e.faceDp(this, X3.ctx, fk2, fs.Q[fk2]); if (r && _fin(r.dp)) { Y.dpPump[fk2] += r.dp; Y.ddpPump[fk2] += _fin(r.ddpdQ) ? r.ddpdQ : 0; } }
        }
        var rejects = 0, res = null, code = null; this._dpRatio = 0;
        for (var att = 0; att <= 8; att++) {
            res = this._attempt(dt, this._dpRatio);
            if (!res.ok && res.code === 'DP_LIMIT') this._dpRatio = res.ratio;
            if (res.ok) break;
            code = res.code; rejects++; this.stats.rej = this.stats.rej || {}; this.stats.rej[code] = (this.stats.rej[code] || 0) + 1;
            dt = dt / 2; landing = false;
            if (dt < o.dtMin) break;
        }
        this.stats.rejects += rejects;
        if (!res || !res.ok) {
            this.ended = true;
            var msg = 'The time step failed (' + (code || 'STEP_FAIL') + ') at t = ' + S.t.toFixed(1) + ' s.';
            this._flag('STEP_FAIL', msg, 'warn');
            var infoF = { ok: false, t: S.t, dt: dt, iters: 0, sweeps: 0, rejects: rejects, massErr: { G: 0, O: 0, W: 0, I: 0 }, applied: applied, code: 'STEP_FAIL', cause: code };
            this._emit('step', infoF); this._emit('end', { t: S.t, code: 'STEP_FAIL' });
            return infoF;
        }
        this._commit(res, dt, landing ? tEv : null);
        this.stats.steps++;
        var info = { ok: true, t: S.t, dt: dt, iters: res.iters, sweeps: res.sweeps, rejects: rejects, massErr: res.massErr, applied: applied };
        this.stats.wallMs += _now() - t0w;
        this._emit('step', info);
        return info;
    };
    // one attempt with dt: the reservoir past sum, the coupled pressure / flux solve, the transport and the checks.
    // The volume balance (one equation per cell), the quasi-steady momentum (one per cell), the inflow at face 0 and the choke at
    // face n form one non-linear system in (p_0 … p_n, Q_1 … Q_n). It is solved by Newton's method; each linear step is a stable
    // forward (Riccati) sweep δQ_k = α_k δp_k + β_k from the bottom and a back substitution from the wellhead — the Thomas algorithm
    // of this two-point problem (deviation from the plan's wellhead root with Picard sweeps, recorded in §11.1: at small Δt the
    // Picard map amplifies the friction feedback through the column compressibility and diverges).
    P._attempt = function (dt, att) {
        var S = this.state, n = this.n, cs = this.cs, fs = this.fs, T = this.tmp, o = this.o, X = this.X, Y = this.Y, src = this.src, out = this.fx;
        this.res.begin(S.t, dt);
        var ch = this._chokePrep(S.t + dt);
        this._backflowNow = false; this._fb = false; this._settled = false;
        var W = this._nw || (this._nw = { gp: new Float64Array(n + 1), ip: new Float64Array(n + 1), G0: new Float64Array(n + 1), I0: new Float64Array(n + 1),
            al: new Float64Array(n + 1), be: new Float64Array(n + 1), Fm: new Float64Array(n + 1), dFm: new Float64Array(n + 1), D: new Float64Array(n + 1), a: new Float64Array(n + 1), b: new Float64Array(n + 1),
            Rm: new Float64Array(n + 1), dp: new Float64Array(n + 1), dQ: new Float64Array(n + 1) });
        var P_ = T.p, Q_ = T.Q;
        for (var k = 0; k <= n; k++) { P_[k] = fs.p[k]; Q_[k] = fs.Q[k]; }
        var closed = ch.mode === 'closed', fixedP = ch.mode === 'fixed' ? this.C.thpFix + PATM : null, lineBC = ch.mode === 'line';
        var self = this, conv = false, it, maxIt = 30, MS = this.k;
        var meas = function (FG, FO, FW, FI) { return (ch.mode === 'gas' || ch.mode === 'gasNozzle') ? (FG / MS.G + FI / MS.I) * 86.4 : (FO / MS.O + FW / MS.W) * 86400; };
        var basis = function (FG, FO, FW) { return self.gasWell() ? FG / MS.G * 86.4 : (FO / MS.O + FW / MS.W) * 86400; };
        var lastNorm = Infinity, lastMx = 0; W.cyc = false;
        for (it = 0; it < maxIt; it++) {
            // inflow at p0 and its slope
            var p0 = P_[0], dp0 = Math.max(1e-3, 1e-6 * p0);
            var q1 = this.res.qAt(p0 + dp0); this._inflow(q1, p0 + dp0, T); var In0b = T.Q0 + X.dG[0] * src.G[0] + X.dO[0] * src.O[0] + X.dW[0] * src.W[0] + X.dI[0] * src.I[0];
            var bf1 = this._backflowNow;
            var q0 = this.res.qAt(p0); this._backflowNow = false; this._inflow(q0, p0, T);
            var In0 = T.Q0 + X.dG[0] * src.G[0] + X.dO[0] * src.O[0] + X.dW[0] * src.W[0] + X.dI[0] * src.I[0];
            void bf1;
            Q_[0] = T.Q0;
            var alpha0 = (In0b - In0) / dp0;
            // face fluxes and slopes (each face once at Q and once at Q + δ)
            for (var f = 1; f <= n; f++) {
                var Q = Q_[f], dq = 1e-6 * Math.max(Math.abs(Q), 1e-3);
                this._faceFlux(f, Q + dq, out);
                var Gb = out.FG * X.dG[f - 1] + out.FO * X.dO[f - 1] + out.FW * X.dW[f - 1] + out.FI * X.dI[f - 1];
                var Fmb = out.FG + out.FO + out.FW + out.FI;
                if (f === n && Q + dq <= 0) Gb = Q + dq;
                var Ib = f < n ? out.FG * X.dG[f] + out.FO * X.dO[f] + out.FW * X.dW[f] + out.FI * X.dI[f] : meas(out.FG, out.FO, out.FW, out.FI);
                this._faceFlux(f, Q, out);
                var Ga = out.FG * X.dG[f - 1] + out.FO * X.dO[f - 1] + out.FW * X.dW[f - 1] + out.FI * X.dI[f - 1];
                if (f === n && Q <= 0) Ga = Q;
                var Ia = f < n ? out.FG * X.dG[f] + out.FO * X.dO[f] + out.FW * X.dW[f] + out.FI * X.dI[f] : meas(out.FG, out.FO, out.FW, out.FI);
                T.FG[f] = out.FG; T.FO[f] = out.FO; T.FW[f] = out.FW; T.FI[f] = out.FI; T.FF[f] = out.FF; T.jg[f] = out.jg; T.jo[f] = out.jo; T.jw[f] = out.jw; T.xI[f] = out.xI;
                W.G0[f] = Ga; W.gp[f] = (Gb - Ga) / dq; W.I0[f] = Ia; W.ip[f] = (Ib - Ia) / dq;
                W.Fm[f] = out.FG + out.FO + out.FW + out.FI; W.dFm[f] = (Fmb - W.Fm[f]) / dq;
            }
            W.Fm[0] = T.FG[0] + T.FO[0] + T.FW[0] + T.FI[0];
            // residuals and the forward sweep
            var al = alpha0, be = 0, norm = 0;
            W.al[0] = al; W.be[0] = 0;
            for (var i = 0; i < n; i++) {
                var A = X.area[i], jm = 0.5 * (Q_[i] + Q_[i + 1]) / A, E1 = 1 / (1 - X.Ek[i]);
                var gfv = this._gf(i, jm), gfdv = this._gfd(i, jm) * X.len[i] * E1 * 0.5 / A;
                var Mr = P_[i] - P_[i + 1] - ((cs.rhoM[i] + X.drho[i]) * X.dz[i] / 144 + gfv * X.len[i]) * E1;
                var a = gfdv, b = gfdv;
                if (Y.restrK[i] > 0) { var jr = Q_[i] / Y.A[i] / Y.restrB2[i], cR = Y.restrK[i] * Y.rhoN[i] / (2 * GC * 144); Mr -= cR * jr * Math.abs(jr); a += cR * 2 * Math.abs(jr) / (Y.A[i] * Y.restrB2[i]); }
                if (Y.dpPump[i] !== 0 || Y.ddpPump[i] !== 0) { Mr += Y.dpPump[i] + Y.ddpPump[i] * (Q_[i] - Y.Qlag[i]); a -= Y.ddpPump[i]; }
                var pcen = 0.5 * (P_[i] + P_[i + 1]);
                var In = i === 0 ? In0 : W.I0[i] + X.dG[i] * src.G[i] + X.dO[i] * src.O[i] + X.dW[i] * src.W[i] + X.dI[i] * src.I[i];
                var Vr = W.G0[i + 1] - In - X.dP[i] * (pcen - cs.p[i]) / dt - (X.Vc[i] - X.vol[i]) / dt;
                var inp = i === 0 ? 1 : W.ip[i], c = X.dP[i] / (2 * dt), gp = W.gp[i + 1];
                var D = 1 - a * al; if (!(D > 1e-12)) D = 1e-12;
                var K = (inp * al + c) / D, den = gp - K * b;
                if (!(Math.abs(den) > 1e-300)) den = den >= 0 ? 1e-300 : -1e-300;
                var aln = (K + c) / den, ben = (K * (a * be - Mr) - Vr + inp * be) / den;
                W.D[i] = D; W.a[i] = a; W.b[i] = b; W.Rm[i] = Mr;
                al = aln; be = ben; W.al[i + 1] = al; W.be[i + 1] = be;
                var sc = Math.max(Math.abs(Q_[i + 1]), 1e-4);
                norm = Math.max(norm, Math.abs(Mr) / Math.max(1, P_[i]) * 1e2, Math.abs(Vr) / sc * 1e-3);
            }
            // the wellhead boundary
            var Bres, Bq, Bp, pn = P_[n];
            if (closed) { Bres = Q_[n]; Bq = 1; Bp = 0; }
            else if (fixedP != null) { Bres = pn - fixedP; Bq = 0; Bp = 1; }
            else if (lineBC) { Bres = pn - this._pdn(basis(T.FG[n], T.FO[n], T.FW[n])); Bq = 0; Bp = 1; }
            else {
                var dpn = Math.max(1e-3, 1e-6 * pn), qa = this._chokeQ(pn + dpn), qb = this._chokeQ(pn);
                Bres = W.I0[n] - qb; Bq = W.ip[n]; Bp = -(qa - qb) / dpn;
                if (!(Bp < 0)) Bp = Math.min(Bp, -1e-12);
            }
            var dpN = (-Bres - Bq * be) / (Bq * al + Bp);
            if (!_fin(dpN)) return { ok: false, code: 'NEWTON' };
            W.dp[n] = dpN; W.dQ[n] = al * dpN + be;
            for (var j = n - 1; j >= 0; j--) {
                W.dp[j] = (W.dp[j + 1] + W.b[j] * W.dQ[j + 1] + W.a[j] * W.be[j] - W.Rm[j]) / W.D[j];
                W.dQ[j] = W.al[j] * W.dp[j] + W.be[j];
            }
            // damped update: no pressure below 1 psia, at most a 30 % change of a pressure per iteration; halved when the iteration
            // cycles (a non-smooth face flux: a donor or branch switch near Q = 0)
            var lam = it >= 3 && lastMx > 0 && W.cyc ? 0.5 : 1, mx = 0, mq = 0;
            for (var k2 = 0; k2 <= n; k2++) {
                var dpk = W.dp[k2];
                if (!_fin(dpk)) return { ok: false, code: 'NEWTON' };
                var lim = 0.3 * P_[k2] + 5;
                if (Math.abs(dpk) * lam > lim) lam = lim / Math.abs(dpk);
                if (P_[k2] + lam * dpk < 1) lam = Math.min(lam, 0.5 * (P_[k2] - 1) / Math.max(1e-12, -dpk));
            }
            for (var k3 = 0; k3 <= n; k3++) {
                P_[k3] += lam * W.dp[k3];
                if (k3 >= 1) Q_[k3] += lam * W.dQ[k3];
                var ap = Math.abs(W.dp[k3]); if (ap > mx) mx = ap;
                if (k3 >= 1) { var aq = Math.abs(W.dQ[k3]) / Math.max(Math.abs(Q_[k3]), 1e-3); if (aq > mq) mq = aq; }
            }
            this.stats.iters++;
            if (this._dbg) this._dbg({ it: it, lam: lam, mx: mx, mq: mq, norm: norm, pn: P_[n], p0: P_[0], Qn: Q_[n] });
            if (lam === 1 && mx <= 1e-6 * (1 + P_[n]) + 1e-7 && mq <= 1e-9) { conv = true; break; }
            if (lam === 1 && mx <= 1e-4 && mq <= 1e-7 && norm <= 1e-9) { conv = true; break; }
            // the plan's pressure tolerance (0.01 psi) once Newton stalls on a non-smooth flux: the small volume residual left is carried
            // by the (V^content − V)/Δt term of the next step; the mass balance is exact either way (the transport uses the final fluxes)
            if (it >= 4 && mx <= 0.01) { conv = true; this.stats.loose = (this.stats.loose || 0) + 1; break; }
            W.cyc = it >= 1 && mx > 0.5 * lastMx;
            lastMx = mx;
            lastNorm = norm;
        }
        void lastNorm;
        if (!conv) return { ok: false, code: 'NEWTON' };
        // the inflow at the final p0, then the face fluxes polished bottom-up so every cell's volume balance holds exactly at the converged
        // pressures (Newton leaves a small residual where it stalls on a flux kink; the wellhead flux stays Newton's — the choke boundary)
        var qf = this.res.qAt(P_[0]); this._backflowNow = false; this._inflow(qf, P_[0], T); Q_[0] = T.Q0;
        for (var f3 = 1; f3 <= n; f3++) {
            if (f3 < n) {
                var i3 = f3 - 1, pc3 = 0.5 * (P_[i3] + P_[i3 + 1]);
                var In3 = X.dG[i3] * (T.FG[i3] + src.G[i3]) + X.dO[i3] * (T.FO[i3] + src.O[i3]) + X.dW[i3] * (T.FW[i3] + src.W[i3]) + X.dI[i3] * (T.FI[i3] + src.I[i3]);
                var rhs3 = In3 + X.dP[i3] * (pc3 - cs.p[i3]) / dt + (X.Vc[i3] - X.vol[i3]) / dt;
                Q_[f3] = this._solveFace(f3, rhs3, Q_[f3], out);
            } else this._faceFlux(f3, Q_[f3], out);
            T.FG[f3] = out.FG; T.FO[f3] = out.FO; T.FW[f3] = out.FW; T.FI[f3] = out.FI; T.FF[f3] = out.FF; T.jg[f3] = out.jg; T.jo[f3] = out.jo; T.jw[f3] = out.jw; T.xI[f3] = out.xI;
        }
        if (!closed && ch.mode !== 'fixed' && ch.mode !== 'line') this._chokeQ(P_[n]);
        // transport (§4.3) with the converged face fluxes and the step's sources
        var massNeg = false;
        var nm = this._nm || (this._nm = { G: new Float64Array(n), O: new Float64Array(n), W: new Float64Array(n), I: new Float64Array(n), F: new Float64Array(n) });
        for (var c2 = 0; c2 < n; c2++) {
            var gG = cs.mG[c2] + dt * (T.FG[c2] - T.FG[c2 + 1] + src.G[c2]);
            var gO = cs.mO[c2] + dt * (T.FO[c2] - T.FO[c2 + 1] + src.O[c2]);
            var gW = cs.mW[c2] + dt * (T.FW[c2] - T.FW[c2 + 1] + src.W[c2]);
            var gI = cs.mI[c2] + dt * (T.FI[c2] - T.FI[c2 + 1] + src.I[c2]);
            var gF = cs.mF[c2] + dt * (T.FF[c2] - T.FF[c2 + 1] + src.F[c2]);
            var tolm = 1e-9 * (cs.mG[c2] + cs.mO[c2] + cs.mW[c2] + cs.mI[c2] + 1e-12);
            if (gG < -tolm || gO < -tolm || gW < -tolm || gI < -tolm || gF < -tolm * 1e3) { massNeg = true; if (this._dbgNeg) this._dbgNeg({ i: c2, gG: gG, gO: gO, gW: gW, gI: gI, gF: gF, dt: dt }); break; }
            nm.G[c2] = gG; nm.O[c2] = gO; nm.W[c2] = gW; nm.I[c2] = gI; nm.F[c2] = gF < 0 ? 0 : gF;
        }
        if (massNeg) return { ok: false, code: 'MASS_NEG' };
        // the pressure-change limit (§4.6): |Δp_k| ≤ dpMaxFrac·p_k. Part of a pressure change is instantaneous — when a gas–liquid interface
        // crosses a cell its lagged mixture density (or its correlation density) moves, and the hydrostatic column above each face with
        // it — and does not shrink with Δt. So a halving that did not reduce the largest relative change by a quarter shows the change is
        // not Δt-driven, and the step is accepted (§11.1); a Δt-driven change halves with Δt as the plan intends.
        var ratio = 0, kMax = -1;
        for (var kf = 0; kf <= n; kf++) { var rk = Math.abs(P_[kf] - fs.p[kf]) / (o.dpMaxFrac * Math.max(fs.p[kf], 50)); if (rk > ratio) { ratio = rk; kMax = kf; } }
        if (ratio > 1 && !(att != null && att > 0 && ratio > 0.75 * att)) {
            if (this._dbgDp) this._dbgDp({ k: kMax, p0: fs.p[kMax], p1: P_[kMax], dt: dt, it: it, ratio: ratio });
            return { ok: false, code: 'DP_LIMIT', ratio: ratio };
        }
        for (var f2 = 1; f2 <= n; f2++) {
            var dd = f2 - 1, vgx = cs.ag[dd] > 1e-6 ? Math.abs(T.jg[f2]) / cs.ag[dd] : 0, vlx = (1 - cs.ag[dd]) > 1e-6 ? Math.abs(T.jo[f2] + T.jw[f2]) / (1 - cs.ag[dd]) : 0;
            if (Math.max(vgx, vlx) * dt > 1.0 * Math.min(X.len[dd], f2 < n ? X.len[f2] : X.len[dd]) && dt > o.dtMin * 2) return { ok: false, code: 'CFL' };
        }
        var massErr = { G: 0, O: 0, W: 0, I: 0 }, clamp = { G: 0, O: 0, W: 0, I: 0 };
        var keys = ['G', 'O', 'W', 'I'], FK = { G: T.FG, O: T.FO, W: T.FW, I: T.FI }, MK = { G: cs.mG, O: cs.mO, W: cs.mW, I: cs.mI };
        for (var kc = 0; kc < 4; kc++) {
            var cc = keys[kc], s0 = 0, s1 = 0, ss = 0, NM = nm[cc];
            for (var ii = 0; ii < n; ii++) { s0 += MK[cc][ii]; s1 += NM[ii]; ss += src[cc][ii]; }
            var expect = s0 + dt * (FK[cc][0] - FK[cc][n] + ss);
            massErr[cc] = Math.abs(s1 - expect) / Math.max(s0, 1);
            // round-off negatives (within 1e-9 of the cell's mass) are set to zero and booked apart (S.balance.clamp)
            for (var i3 = 0; i3 < n; i3++) if (NM[i3] < 0) { clamp[cc] += -NM[i3]; NM[i3] = 0; }
        }
        return { ok: true, clamp: clamp, pn: P_[n], iters: it + 1, sweeps: it + 1, massErr: massErr, chMode: ch.mode, regime: ch.regime, y: ch.y, yc: ch.ycNow };
    };
    P._measureScale = function () { var S = this.state; return this.gasWell() ? S.surface.qg : S.surface.qL; };
    P._basisOf = function (T) { var k = this.k, n = this.n; return this.gasWell() ? (T.FG[n] / k.G) * 86400 / 1000 : (T.FO[n] / k.O + T.FW[n] / k.W) * 86400; };

    // ── commit the accepted step ────────────────────────────────────────────────────────────────────────────────────
    P._commit = function (res, dt, tLand) {
        var S = this.state, n = this.n, cs = this.cs, fs = this.fs, T = this.tmp, nm = this._nm, src = this.src, k = this.k, bal = S.balance;
        var t0 = S.t;
        for (var i = 0; i < n; i++) { cs.mG[i] = nm.G[i]; cs.mO[i] = nm.O[i]; cs.mW[i] = nm.W[i]; cs.mI[i] = nm.I[i]; cs.mF[i] = nm.F[i]; }
        for (var f = 0; f <= n; f++) {
            fs.p[f] = T.p[f]; fs.Q[f] = T.Q[f]; fs.FG[f] = T.FG[f]; fs.FO[f] = T.FO[f]; fs.FW[f] = T.FW[f]; fs.FI[f] = T.FI[f]; fs.FF[f] = T.FF[f];
            fs.jg[f] = T.jg[f]; fs.jo[f] = T.jo[f]; fs.jw[f] = T.jw[f]; fs.xI[f] = T.xI[f];
        }
        fs.Q[0] = T.Q0;
        for (var c = 0; c < n; c++) cs.p[c] = 0.5 * (fs.p[c] + fs.p[c + 1]);
        var jlo2 = this.o.closureOpt.jLo, jhi2 = this.o.closureOpt.jHi;
        for (var fw2 = 1; fw2 <= n; fw2++) { var jj = fs.Q[fw2] / this.Y.A[fw2]; fs.w[fw2] = this.Y.elig[fw2] > 0 ? (jj >= jhi2 ? 1 : (jj > jlo2 ? _ss((jj - jlo2) / (jhi2 - jlo2)) : 0)) : 0; }
        // cumulative in / out (face 0 in or out, face n out, sources)
        var comps = ['G', 'O', 'W', 'I'], FK = { G: fs.FG, O: fs.FO, W: fs.FW, I: fs.FI };
        for (var q = 0; q < 4; q++) {
            var cc = comps[q], f0 = FK[cc][0] * dt, fn = FK[cc][n] * dt, ss = 0;
            for (var ii = 0; ii < n; ii++) ss += src[cc][ii] * dt;
            if (f0 >= 0) bal.cumIn[cc] += f0; else bal.cumOut[cc] += -f0;
            bal.cumOut[cc] += fn;
            if (ss >= 0) bal.cumIn[cc] += ss; else bal.cumOut[cc] += -ss;
        }
        // time
        S.t = tLand != null ? tLand : t0 + dt;
        S.dt = dt; S.n++; this.dtPrev = dt;
        // the stroke
        var ctl = S.ctl;
        if (ctl.strokeLeft_s > 0) {
            ctl.strokeLeft_s = Math.max(0, ctl.strokeLeft_s - dt);
            S.beanEff = this.ch.bean;
            if (ctl.strokeLeft_s <= 1e-9) { ctl.strokeLeft_s = 0; S.beanEff = ctl.beanTo; }
        }
        ctl.chokeMode = res.chMode;
        // reservoir commit (the step's rate becomes a superposition term at the start of the step)
        this.res.commit(T.q0, t0);
        if (this._backflowNow) { this._mark('res_back'); S.res.backflow = true; }
        if (this.res.mode === 'ipr' && !this.res.backflow && fs.p[0] > this.C.pr + 0.5) this._flag('RES_NO_BACKFLOW', 'The well pressure exceeds p̄r and back-flow into the formation is switched off: the inflow is held at zero.', 'info');
        if (this._fb) this._mark('fallback');
        if (this._settled) this._mark('settle');
        if (res.regime === 'subcritical' && res.chMode === 'multiphase') this._mark('choke_sub');
        if (res.chMode && res.chMode !== 'closed') this._mark('choke_crit');
        // temperature (relax, provisional)
        if (this.o.temperature === 'relax') {
            var qb = this.gasWell() ? S.surface.qg : S.surface.qL, qop = haveOpQ(this.R0), fr = qop > 0 ? Math.sqrt(Math.min(1, Math.max(0, qb) / qop)) : 0, X = this.X;
            var e = Math.exp(-dt / (this.o.tauT_h * 3600));
            for (var tc = 0; tc < n; tc++) { var tg = S.open ? X.Tgeo[tc] + (X.Tflow[tc] - X.Tgeo[tc]) * fr : X.Tgeo[tc]; cs.T[tc] = tg + (cs.T[tc] - tg) * e; }
        }
        // the new state's evaluation (props, holdups, closures) for the next step and for the readouts
        this._prep(false);
        for (var xa = 0; xa < this.exts.length; xa++) { var E1 = this.exts[xa]; if (typeof E1.e.after === 'function') E1.e.after(this, E1.ctx, { dt: dt, t: S.t }); }
        var sig = null;
        for (var xs = 0; xs < this.exts.length; xs++) { var E2 = this.exts[xs]; if (typeof E2.e.sigma === 'function') { var sa = E2.e.sigma(this, E2.ctx); if (sa && sa.length === n) { if (!sig) { sig = new Float64Array(n); for (var z = 0; z < n; z++) sig[z] = 1; } for (var z2 = 0; z2 < n; z2++) sig[z2] *= sa[z2]; } } }
        for (var zs = 0; zs < n; zs++) cs.sigF[zs] = sig ? sig[zs] : 1;
        // surface, labels, loading, inventory, balance
        S.surface.regime = res.chMode === 'closed' ? 'closed' : (res.chMode === 'gas' || res.chMode === 'gasNozzle' || res.chMode === 'multiphase' ? (res.regime || 'critical') : (res.chMode === 'liquid' ? 'subcritical' : 'none'));
        S.surface.y = _fin(res.y) ? res.y : NaN; S.surface.yc = _fin(res.yc) ? res.yc : NaN;
        this._post(dt, false);
        var tot = this._totals(), m0 = this.bal.m0, errCum = 0;
        ['G', 'O', 'W', 'I'].forEach(function (cc2) { bal.clamp[cc2] += res.clamp[cc2]; });
        ['G', 'O', 'W', 'I'].forEach(function (cc2) {
            var exp = m0[cc2] + bal.cumIn[cc2] - bal.cumOut[cc2] + bal.clamp[cc2], e2 = Math.abs(tot[cc2] - exp) / Math.max(m0[cc2] + bal.cumIn[cc2], 1);
            if (e2 > errCum) errCum = e2;
        });
        bal.m = tot; bal.errStep = Math.max(res.massErr.G, res.massErr.O, res.massErr.W, res.massErr.I); bal.errCum = errCum;
    };
    P._post = function (dt, first, readOnly) {
        var S = this.state, n = this.n, cs = this.cs, fs = this.fs, X = this.X, k = this.k, C = this.C;
        var pn = fs.p[n];
        // surface (§4.8, C8)
        var FO = fs.FO[n], FW = fs.FW[n], FG = fs.FG[n], FI = fs.FI[n], su = S.surface;
        su.thp = pn; su.thp_psig = pn - PATM;
        su.tht = this.o.temperature === 'frozen' ? this.thtRef : cs.T[n - 1];
        su.qo = FO / k.O * 86400; su.qw = FW / k.W * 86400; su.qL = su.qo + su.qw;
        su.qgForm = FG / k.G * 86400 / 1000; su.qinj = 0; su.qvent = su.qvent || 0;
        var liftOut = FI / k.I * 86400 / 1000;
        su.qg = su.qgForm + liftOut + (su.qvent || 0);
        su.gor = su.qo > 1e-9 ? su.qg * 1000 / su.qo : 0; su.gorForm = su.qo > 1e-9 ? su.qgForm * 1000 / su.qo : 0;
        su.glr = su.qL > 1e-9 ? su.qg * 1000 / su.qL : 0; su.wc = su.qL > 1e-9 ? su.qw / su.qL : 0;
        su.pDn_psig = (this.ch ? this.ch.pdn : this._pdn(this.gasWell() ? su.qg : su.qL)) - PATM;
        if (first) { su.regime = !C.choke.present ? 'none' : (S.beanEff > 0 ? 'critical' : 'closed'); }
        // bottom (sandface stock-tank; negative = back-flow)
        var b = S.bottom; b.pwf = fs.p[0]; b.pr = C.pr;
        b.qo = fs.FO[0] / k.O * 86400; b.qw = fs.FW[0] / k.W * 86400; b.qg = fs.FG[0] / k.G * 86400 / 1000; b.drawdown = C.pr - fs.p[0];
        // the highest surface rate since the last open
        var qb = this.gasWell() ? su.qgForm : su.qL;
        if (S.open && qb > S.qRef) S.qRef = qb;
        // cell velocities and regimes
        for (var i = 0; i < n; i++) {
            var A = X.area[i], YA = this.Y.A, jgm = 0.5 * (fs.jg[i] * YA[i] + fs.jg[i + 1] * YA[i + 1]) / A, jLm = 0.5 * ((fs.jo[i] + fs.jw[i]) * YA[i] + (fs.jo[i + 1] + fs.jw[i + 1]) * YA[i + 1]) / A;
            cs.vg[i] = cs.ag[i] > 1e-6 ? jgm / cs.ag[i] : 0; cs.vl[i] = (1 - cs.ag[i]) > 1e-6 ? jLm / (1 - cs.ag[i]) : 0;
            cs.vm[i] = 0.5 * (fs.Q[i] + fs.Q[i + 1]) / A;
        }
        this._loading();
        this._regimes();
        this._inventory();
        S.res.terms = this.res.terms ? this.res.terms().length : 0;
        if (readOnly) return;
        this._labels(dt, first);
        this._steadyRing();
    };

    // ── critical velocity and loading (§4.11) ───────────────────────────────────────────────────────────────────────
    P._loading = function () {
        var S = this.state, n = this.n, cs = this.cs, X = this.X, C = this.C, L = S.loading, g = this.grid;
        var LOAD = (G.WTS_wp_system && G.WTS_wp_system.LOAD) || { turner: { coef: 1.912 }, coleman: { coef: 1.593 } };
        var F = C.F, water = (+F.wgr > 0) || (+F.wc > 0);
        var whp = S.surface.thp, method = !_fin(whp) ? 'turner' : (whp < 500 ? 'coleman' : 'turner');
        var coef = LOAD[method].coef, bel = !!this.o.loading.belfroid;
        var best = -1, bestB = -1, bestMd = null, bestTvd = null, vrMin = Infinity, below = -1, belowMd = null;
        var eot = g.eotCell;
        for (var i = 0; i < n; i++) {
            var rhoL = water ? X.rhoW[i] : X.rhoO[i], sig = (water ? X.sigW[i] : X.sigO[i]) * cs.sigF[i], rhoG = X.rhoG[i], z = X.z[i];
            if (!(rhoL > rhoG && rhoG > 0 && sig > 0 && z > 0)) { cs.vc[i] = 0; continue; }
            var base = Math.pow(sig, 0.25) * Math.pow(rhoL - rhoG, 0.25) / Math.sqrt(rhoG), vc = coef * base;
            var beta = Math.PI / 2 - _clamp(X.inc[i], 0, 90) * Math.PI / 180;
            var fb = (beta > 0 && beta < Math.PI / 2) ? Math.pow(Math.sin(1.7 * beta), 0.38) / 0.74 : 1;
            var vcB = vc * fb, use = bel ? vcB : vc;
            cs.vc[i] = use; X.vcv[i] = vc; X.vcb[i] = vcB;
            if (!this.gasWell()) continue;
            var qcOf = function (v) { return 3.067 * cs.p[i] * v * X.area[i] / ((cs.T[i] + 460) * z); };
            var qv = qcOf(vc), qb2 = qcOf(vcB);
            var isBelow = eot >= 0 && i < eot;
            if (isBelow) { var qu = bel ? qb2 : qv; if (qu > below) { below = qu; belowMd = g.cells[i].mdc; } continue; }
            if (qv > best) { best = qv; bestMd = g.cells[i].mdc; bestTvd = g.cells[i].tvdc; }
            if (qb2 > bestB) bestB = qb2;
            var vr = cs.vg[i] > 0 && use > 0 ? cs.vg[i] / use : 0; if (vr < vrMin) vrMin = vr;
        }
        if (!this.gasWell()) { L.method = null; return; }
        L.method = method; L.both = _fin(whp) && whp >= 500 && whp <= 1000; L.liquid = water ? 'water' : 'condensate';
        L.qcVert_MMscfd = best > 0 ? best : null; L.qcBelfroid_MMscfd = bestB > 0 ? bestB : null; L.belfroid = bel;
        L.qc_MMscfd = bel ? L.qcBelfroid_MMscfd : L.qcVert_MMscfd;
        L.limitingMd = bestMd; L.limitingTvd = bestTvd;
        L.ratio = L.qc_MMscfd > 0 ? (S.surface.qgForm / 1000) / L.qc_MMscfd : null;
        L.vRatioMin = _fin(vrMin) ? vrMin : null;
        L.belowEot = below > 0 ? { qc_MMscfd: below, md: belowMd } : null;
        // both methods side by side (additive, §11.1): the q_c of the other coefficient scales with it (same nodes, same σ, ρ, z)
        var other = method === 'turner' ? 'coleman' : 'turner';
        L.methods = {}; L.methods[method] = { qc_MMscfd: L.qcVert_MMscfd, coef: coef };
        L.methods[other] = { qc_MMscfd: L.qcVert_MMscfd != null ? L.qcVert_MMscfd * LOAD[other].coef / coef : null, coef: LOAD[other].coef };
        // the other method alongside (both always computed for the record)
        L.coef = coef;
    };
    // ── regime labels (§4.13) ───────────────────────────────────────────────────────────────────────────────────────
    P._regimes = function () {
        var n = this.n, cs = this.cs, X = this.X, jhi = this.o.closureOpt.jHi, low = false;
        var iface = this._interfaceCell();
        for (var i = 0; i < n; i++) {
            var j = Math.abs(cs.vm[i]), a = cs.ag[i], r;
            if (j >= jhi && X.haveCorr[i]) r = X.pat[i];
            else {
                low = true;
                if (a < 0.02) r = RIX.liquid; else if (a >= 0.98) r = RIX.gas;
                else if (X.inc[i] > 80) r = RIX.stratified;
                else if (a < 0.25) r = RIX.bubble; else if (a < 0.75) r = RIX.slug;
                else {
                    var rhoL = (cs.ao[i] * X.rhoO[i] + cs.aw[i] * X.rhoW[i]) / Math.max(1e-9, cs.ao[i] + cs.aw[i]), sig = (cs.aw[i] >= cs.ao[i] ? X.sigW[i] : X.sigO[i]) * cs.sigF[i];
                    var vsg = Math.abs(cs.vg[i] * a), crit = 3.1 * Math.pow(Math.max(1e-9, sig * SIG_LBF * GC * GRAV * Math.max(0, rhoL - X.rhoG[i])) / (X.rhoG[i] * X.rhoG[i]), 0.25);
                    r = vsg >= crit ? RIX.annular : RIX.churn;
                }
                if (i === iface) r = RIX.segregated;
            }
            cs.regime[i] = r;
        }
        if (low) this._mark('regime_lowv');
    };
    // the cell holding a shut-in gas–liquid interface (α_L crossing 0.5 from below), or −1
    P._interfaceCell = function () {
        var cs = this.cs, n = this.n;
        if (this.state.open && this.state.beanEff > 0) return -1;
        for (var i = 0; i < n - 1; i++) if ((1 - cs.ag[i]) >= 0.5 && (1 - cs.ag[i + 1]) < 0.5) return i + 1;
        return -1;
    };
    // ── inventory (§3.2) ────────────────────────────────────────────────────────────────────────────────────────────
    P._inventory = function () {
        var S = this.state, n = this.n, cs = this.cs, X = this.X, k = this.k, inv = S.inventory, g = this.grid, eot = g.eotCell;
        var liq = 0, liqT = 0, gas = 0, lg = 0;
        for (var i = 0; i < n; i++) {
            var vl = (cs.ao[i] + cs.aw[i]) * X.vol[i] / FT3;
            liq += vl; if (eot < 0 || i >= eot) liqT += vl;
            gas += cs.mG[i] / k.G / 1000; lg += cs.mI[i] / k.I / 1000;
        }
        inv.liq_bbl = liq; inv.liqTubing_bbl = liqT; inv.gas_Mscf = gas; inv.liftGas_Mscf = lg;
        // interface MDs: α_L crosses 0.5 from below (liquid top) / from above (gas-cap bottom), interpolated between cell centres
        inv.liquidTopMd = NaN; inv.gasCapBottomMd = NaN;
        for (var c = 0; c < n - 1; c++) {
            var a0 = 1 - cs.ag[c], a1 = 1 - cs.ag[c + 1];
            if (a0 >= 0.5 && a1 < 0.5) { var fr = (a0 - 0.5) / Math.max(1e-12, a0 - a1); inv.liquidTopMd = g.cells[c].mdc + (g.cells[c + 1].mdc - g.cells[c].mdc) * fr; }
        }
        for (var c2 = n - 1; c2 > 0; c2--) {
            var b0 = 1 - cs.ag[c2], b1 = 1 - cs.ag[c2 - 1];
            if (b0 < 0.5 && b1 >= 0.5) { var fr2 = (0.5 - b0) / Math.max(1e-12, b1 - b0); inv.gasCapBottomMd = g.cells[c2].mdc + (g.cells[c2 - 1].mdc - g.cells[c2].mdc) * fr2; break; }
        }
    };
    // ── well states (§4.13) ─────────────────────────────────────────────────────────────────────────────────────────
    P._resetLabels = function (t) { var L = this.labels; L.pending = null; L.dying = { t0: null }; };
    P._labels = function (dt, first) {
        var S = this.state, L = this.labels, t = S.t, gas = this.gasWell(), su = S.surface, inv = S.inventory, W = S.well, cs = this.cs;
        // the 30 s ring of (t, liq, q, p0) for the trends
        if (first || t - L.lastRing >= RING_DT - 1e-9) {
            L.ringT.push(t); L.ringLiq.push(inv.liqTubing_bbl); L.ringQ.push(gas ? su.qgForm : su.qL); L.ringP.push(S.bottom.pwf); L.ringThp.push(su.thp);
            L.lastRing = t;
            var cap = 120; if (L.ringT.length > cap) { L.ringT.shift(); L.ringLiq.shift(); L.ringQ.shift(); L.ringP.shift(); L.ringThp.shift(); }
        }
        var rate = function (arr, span) {        // d/dt per minute over the last span s
            var nT = L.ringT.length; if (nT < 2) return 0;
            var j = nT - 1, i = j; while (i > 0 && L.ringT[j] - L.ringT[i - 1] <= span + 1e-9) i--;
            var dtt = L.ringT[j] - L.ringT[i]; return dtt > 0 ? (arr[j] - arr[i]) / dtt * 60 : 0;
        };
        var dLiq = rate(L.ringLiq, 300), qNow = gas ? su.qgForm : su.qL, qRef = S.qRef > 0 ? S.qRef : qNow;
        var ratio = S.loading.ratio, cand, reason = '';
        var closed = !(S.beanEff > 1e-9) && this.C.choke.present;
        if (!S.open || closed) { cand = 'shutin'; reason = 'choke closed'; }
        else {
            var deadQ = (qRef > 0 && qNow < 0.02 * qRef) || (qRef > 0 && (gas ? S.bottom.qg : S.bottom.qo + S.bottom.qw) < 0.01 * qRef && (this.C.pr - S.bottom.pwf) < 1);
            var deadRef = qRef <= 0 && t - S.tOpen > 600 && qNow <= 1e-6;
            if (deadQ || deadRef) { if (L.deadSince == null) L.deadSince = t; } else L.deadSince = null;
            if (L.deadSince != null && t - L.deadSince >= 600) { cand = 'dead'; reason = 'no flow for 10 min'; }
            else if (t - S.tOpen < 600) { cand = 'startup'; reason = 'within 10 min of the open'; }
            else if (dLiq < -0.05 && (!gas || (ratio != null && ratio >= 0.9))) { cand = 'unloading'; reason = 'liquid inventory falling'; }
            else if (gas && ratio != null && ratio < 0.9) { cand = 'loading'; reason = (dLiq > 0.01 || this._bottomRising()) ? 'gas rate below the critical rate and liquid accumulating' : 'gas rate below the critical rate'; }
            else if (gas && ratio != null && ratio >= 0.9 && ratio < 1.1) { cand = 'marginal'; reason = 'gas rate within 10 % of the critical rate'; }
            else if (!gas && this._dying(t, qNow, dLiq)) { cand = 'dying'; reason = 'rate falling more than 10 % per hour with liquid rising'; }
            else { cand = 'stable'; reason = gas && ratio != null && ratio < 1.1 ? 'steady' : 'steady flow'; }
        }
        // lift labels override (extensions)
        for (var xi = 0; xi < this.exts.length; xi++) { var E = this.exts[xi]; if (typeof E.e.label === 'function') { var lb = E.e.label(this, E.ctx); if (lb && lb.state && STATES[lb.state]) { if (cand === 'stable' || cand === 'unloading' || cand === 'startup') { cand = lb.state; reason = lb.reason || reason; } break; } } }
        if (first) { W.state = cand; W.since = t; W.reason = reason; L.pending = null; return; }
        if (cand === W.state) { L.pending = null; return; }
        // shut-in and the immediate commands switch at once; others persist 120 s (no chatter)
        if (cand === 'shutin' || W.state === 'shutin') { this._switch(cand, t, reason); return; }
        if (!L.pending || L.pending.key !== cand) { L.pending = { key: cand, since: t }; return; }
        if (t - L.pending.since >= STATE_HOLD - 1e-9) this._switch(cand, t, reason);
    };
    P._switch = function (to, t, reason) {
        var W = this.state.well, from = W.state;
        W.prev = from; W.state = to; W.since = t; W.reason = reason; this.labels.pending = null;
        this._emit('state', { from: from, to: to, t: t, reason: reason });
    };
    P._bottomRising = function () {
        var L = this.labels, nT = L.ringT.length; if (nT < 3) return false;
        var cs = this.cs; var aL = (1 - cs.ag[0]) + (1 - cs.ag[1]) + (1 - cs.ag[2]);
        if (this._lastBot == null) { this._lastBot = aL; return false; }
        var r = aL > this._lastBot + 1e-4; this._lastBot = aL; return r;
    };
    P._dying = function (t, q, dLiq) {
        var L = this.labels, nT = L.ringT.length; if (nT < 4) return false;
        var j = nT - 1, i = j; while (i > 0 && L.ringT[j] - L.ringT[i - 1] <= 1800 + 1e-9) i--;
        var span = L.ringT[j] - L.ringT[i]; if (span < 1700) return false;
        var q0 = L.ringQ[i], q1 = L.ringQ[j]; if (!(q0 > 0)) return false;
        var perH = (q0 - q1) / q0 / (span / 3600);
        return perH > 0.10 && dLiq > 0;
    };
    // ── the steady buffer (§5.1): samples every 10 s of simulated time ──────────────────────────────────────────────
    P._steadyRing = function () {
        var S = this.state, R = this.steady, gas = this.gasWell();
        var q = gas ? S.surface.qgForm : S.surface.qL;
        while (R.next <= S.t + 1e-9) {
            R.ringT.push(R.next); R.ringQ.push(q); R.ringPwf.push(S.bottom.pwf); R.ringThp.push(S.surface.thp);
            if (R.ringT.length > STEADY_N) { R.ringT.shift(); R.ringQ.shift(); R.ringPwf.shift(); R.ringThp.shift(); }
            R.next += STEADY_DT;
        }
    };
    P.steadyCheck = function (win_s) {
        var R = this.steady, w = _fin(+win_s) && +win_s > 0 ? +win_s : 600, nW = Math.round(w / STEADY_DT), N = R.ringT.length;
        var out = { steady: false, qMean: NaN, pwfMean: NaN, thpMean: NaN, ampQ: NaN, ampP: NaN, dq: NaN, dp: NaN, dthp: NaN, n: N };
        if (N < 2 * nW) return out;
        function mean(a, i0, i1) { var s = 0; for (var i = i0; i < i1; i++) s += a[i]; return s / (i1 - i0); }
        function amp(a, i0, i1) { var lo = Infinity, hi = -Infinity; for (var i = i0; i < i1; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } return hi - lo; }
        var b1 = N - nW, b0 = N - 2 * nW;
        var q1 = mean(R.ringQ, b1, N), q0 = mean(R.ringQ, b0, b1), p1 = mean(R.ringPwf, b1, N), p0 = mean(R.ringPwf, b0, b1), t1 = mean(R.ringThp, b1, N), t0 = mean(R.ringThp, b0, b1);
        out.qMean = q1; out.pwfMean = p1; out.thpMean = t1;
        out.ampQ = amp(R.ringQ, b1, N); out.ampP = amp(R.ringPwf, b1, N);
        out.dq = q1 !== 0 ? Math.abs(q1 - q0) / Math.abs(q1) : Math.abs(q1 - q0); out.dp = Math.abs(p1 - p0); out.dthp = Math.abs(t1 - t0);
        out.steady = out.dq < 1e-3 && out.dp < 0.05 && out.dthp < 0.05;
        return out;
    };

    // ── run (§3.1): steps until the target time; never splits a step (WD-D8) ────────────────────────────────────────
    P.run = function (seconds, o) {
        o = o || {};
        var S = this.state, target = S.t + Math.max(0, +seconds || 0), t0w = _now(), steps = 0, stopped = 'target', code;
        var maxW = _fin(+o.maxWallMs) ? +o.maxWallMs : Infinity, maxS = _fin(+o.maxSteps) ? +o.maxSteps : Infinity;
        while (S.t < target - 1e-9) {
            if (this.ended || S.ctl.ended) { stopped = 'end'; break; }
            var r = this.step();
            steps++;
            if (!r.ok) { stopped = r.code === 'ENDED' ? 'end' : 'error'; code = r.code; break; }
            if (r.code === 'END') { stopped = 'end'; break; }
            if (steps >= maxS) { stopped = 'steps'; break; }
            if (_now() - t0w >= maxW) { stopped = 'wall'; break; }
        }
        var out = { ok: stopped !== 'error', t: S.t, steps: steps, wallMs: _now() - t0w, stopped: stopped };
        if (code) out.code = code;
        return out;
    };

    // ── snapshot / restore (§3.6) ───────────────────────────────────────────────────────────────────────────────────
    function _arr(a) { var o = new Array(a.length); for (var i = 0; i < a.length; i++) o[i] = _fin(a[i]) ? a[i] : null; return o; }
    function _put(dst, src) { for (var i = 0; i < dst.length; i++) dst[i] = (src && src[i] != null) ? +src[i] : NaN; }
    P.snapshot = function () {
        var S = this.state, cs = this.cs, fs = this.fs, self = this, ext = {};
        this.exts.forEach(function (x) { ext[x.key] = typeof x.e.snapshot === 'function' ? x.e.snapshot(x.ctx) : JSON.parse(JSON.stringify(x.ctx || null)); });
        var L = this.labels, St = this.steady, line = this.line;
        return {
            kind: 'wd-snap', v: 1, engine: VERSION, engineId: ENGINE_ID, mHash: this.mHash, n: this.n, t: S.t, steps: S.n, dtPrev: this.dtPrev,
            cells: { mG: _arr(cs.mG), mO: _arr(cs.mO), mW: _arr(cs.mW), mI: _arr(cs.mI), mF: _arr(cs.mF), T: _arr(cs.T), p: _arr(cs.p), sigF: _arr(cs.sigF), vc: _arr(cs.vc) },
            faces: { Q: _arr(fs.Q), jg: _arr(fs.jg), jo: _arr(fs.jo), jw: _arr(fs.jw), xI: _arr(fs.xI), vd: _arr(fs.vd), c0: _arr(fs.c0), w: _arr(fs.w), p: _arr(fs.p),
                FG: _arr(fs.FG), FO: _arr(fs.FO), FW: _arr(fs.FW), FI: _arr(fs.FI), FF: _arr(fs.FF) },
            ctl: { open: S.open, bean64: S.bean64, beanEff: S.beanEff, strokeLeft_s: S.ctl.strokeLeft_s, beanFrom: S.ctl.beanFrom, beanTo: S.ctl.beanTo,
                strokeTime_s: S.ctl.strokeTime_s, chokeMode: S.ctl.chokeMode, ended: !!S.ctl.ended, psep_psig: S.psep_psig, tOpen: S.tOpen, qRef: S.qRef },
            line: line ? { refGor: line.refGor, refWc: line.refWc, q: line.q.slice(), pdn: line.pdn.slice(), unit: line.unit, psep: line.psep, flowline: line.flowline } : null,
            res: this.res.snapshot(),
            labels: { state: S.well.state, since: S.well.since, prev: S.well.prev, reason: S.well.reason, pending: L.pending ? { key: L.pending.key, since: L.pending.since } : null,
                ringT: L.ringT.slice(), ringLiq: L.ringLiq.slice(), ringQ: L.ringQ.slice(), ringP: L.ringP.slice(), ringThp: L.ringThp.slice(), lastRing: _fin(L.lastRing) ? L.lastRing : null,
                deadSince: L.deadSince == null ? null : L.deadSince, lastBot: this._lastBot == null ? null : this._lastBot, dying: { t0: null }, heading: L.heading },
            steady: { ringT: St.ringT.slice(), ringQ: St.ringQ.slice(), ringPwf: St.ringPwf.slice(), ringThp: St.ringThp.slice(), next: St.next },
            surface: JSON.parse(JSON.stringify(S.surface, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; })),
            foamer: JSON.parse(JSON.stringify(S.foamer)), lift: { glCmd: S.lift.glCmd, espCmd: S.lift.espCmd, gl: S.lift.gl, esp: S.lift.esp }, cycle: S.cycle,
            pend: this.pend.map(function (e) { return { t: e.t, type: e.type, args: e.args, src: e.src, seq: e.seq }; }), seq: this._seq || 0,
            log: this.log.map(function (e) { return { t: e.t, type: e.type, args: e.args, src: e.src }; }), ext: ext,
            bal: { m0: Object.assign({}, this.bal.m0), cumIn: Object.assign({}, S.balance.cumIn), cumOut: Object.assign({}, S.balance.cumOut), clamp: Object.assign({}, S.balance.clamp) },
            prov: S.provisional.slice(), flags: S.flags.map(function (f) { return { code: f.code, sev: f.sev, msg: f.msg }; })
        };
        void self;
    };
    P.restore = function (snap, internal) {
        if (!snap || snap.kind !== 'wd-snap') return { ok: false, code: 'FORMAT' };
        if (String(snap.engine || '').split('.')[0] !== VERSION.split('.')[0]) return { ok: false, code: 'VERSION' };
        if (!internal && snap.mHash !== this.mHash) return { ok: false, code: 'MODEL_MISMATCH' };
        if (+snap.n !== this.n) return { ok: false, code: 'MODEL_MISMATCH' };
        var S = this.state, cs = this.cs, fs = this.fs, c = snap.cells, f = snap.faces;
        _put(cs.mG, c.mG); _put(cs.mO, c.mO); _put(cs.mW, c.mW); _put(cs.mI, c.mI); _put(cs.mF, c.mF); _put(cs.T, c.T); _put(cs.p, c.p);
        if (c.sigF) _put(cs.sigF, c.sigF); else for (var i = 0; i < this.n; i++) cs.sigF[i] = 1;
        if (c.vc) _put(cs.vc, c.vc);
        _put(fs.Q, f.Q); _put(fs.jg, f.jg); _put(fs.jo, f.jo); _put(fs.jw, f.jw); _put(fs.xI, f.xI); _put(fs.vd, f.vd); _put(fs.c0, f.c0); _put(fs.w, f.w); _put(fs.p, f.p);
        _put(fs.FG, f.FG); _put(fs.FO, f.FO); _put(fs.FW, f.FW); _put(fs.FI, f.FI); _put(fs.FF, f.FF);
        S.t = +snap.t; S.n = +snap.steps || 0; this.dtPrev = +snap.dtPrev || 0; S.dt = this.dtPrev;
        var k = snap.ctl || {};
        S.open = k.open ? 1 : 0; S.bean64 = +k.bean64 || 0; S.beanEff = +k.beanEff || 0; S.psep_psig = _fin(+k.psep_psig) ? +k.psep_psig : S.psep_psig; S.tOpen = +k.tOpen || 0; S.qRef = +k.qRef || 0;
        S.ctl.strokeLeft_s = +k.strokeLeft_s || 0; S.ctl.beanFrom = +k.beanFrom || 0; S.ctl.beanTo = +k.beanTo || 0; S.ctl.strokeTime_s = _fin(+k.strokeTime_s) ? +k.strokeTime_s : S.ctl.strokeTime_s;
        S.ctl.chokeMode = k.chokeMode || null; S.ctl.ended = !!k.ended; this.ended = !!k.ended;
        if (snap.line && Array.isArray(snap.line.q)) this._lineFrom(snap.line);
        if (snap.res) this.res.restore(snap.res);
        var L = this.labels, lb = snap.labels || {};
        S.well.state = lb.state || 'stable'; S.well.since = +lb.since || 0; S.well.prev = lb.prev || null; S.well.reason = lb.reason || '';
        L.pending = lb.pending ? { key: lb.pending.key, since: +lb.pending.since } : null;
        L.ringT = (lb.ringT || []).slice(); L.ringLiq = (lb.ringLiq || []).slice(); L.ringQ = (lb.ringQ || []).slice(); L.ringP = (lb.ringP || []).slice(); L.ringThp = (lb.ringThp || []).slice();
        L.lastRing = lb.lastRing == null ? -Infinity : +lb.lastRing; L.deadSince = lb.deadSince == null ? null : +lb.deadSince; this._lastBot = lb.lastBot == null ? null : +lb.lastBot;
        L.heading = lb.heading || null;
        var st = snap.steady || {}, R = this.steady;
        R.ringT = (st.ringT || []).slice(); R.ringQ = (st.ringQ || []).slice(); R.ringPwf = (st.ringPwf || []).slice(); R.ringThp = (st.ringThp || []).slice(); R.next = +st.next || 0;
        if (snap.surface) { var su = S.surface; for (var kk in snap.surface) su[kk] = snap.surface[kk] == null ? NaN : snap.surface[kk]; if (typeof snap.surface.regime === 'string') su.regime = snap.surface.regime; }
        if (snap.foamer) S.foamer = JSON.parse(JSON.stringify(snap.foamer));
        if (snap.lift) { S.lift.glCmd = snap.lift.glCmd || null; S.lift.espCmd = snap.lift.espCmd || null; S.lift.gl = snap.lift.gl || null; S.lift.esp = snap.lift.esp || null; }
        S.cycle = snap.cycle || null;
        this.pend = (snap.pend || []).map(function (e) { return { t: +e.t, type: e.type, args: e.args || {}, src: e.src, seq: +e.seq || 0 }; });
        this._seq = +snap.seq || 0;
        this.log = (snap.log || []).map(function (e) { return { t: +e.t, type: e.type, args: e.args || {}, src: e.src }; });
        var self = this;
        this.exts.forEach(function (x) { if (snap.ext && Object.prototype.hasOwnProperty.call(snap.ext, x.key)) x.ctx = typeof x.e.restore === 'function' ? x.e.restore(snap.ext[x.key]) : snap.ext[x.key]; });
        var b = snap.bal || {};
        this.bal.m0 = Object.assign({ G: 0, O: 0, W: 0, I: 0 }, b.m0); S.balance.cumIn = Object.assign({ G: 0, O: 0, W: 0, I: 0 }, b.cumIn); S.balance.cumOut = Object.assign({ G: 0, O: 0, W: 0, I: 0 }, b.cumOut); S.balance.clamp = Object.assign({ G: 0, O: 0, W: 0, I: 0 }, b.clamp);
        this.prov = {}; S.provisional.length = 0; (snap.prov || []).forEach(function (kx) { self.prov[kx] = true; S.provisional.push(kx); });
        Object.keys(METHODS).forEach(function (kx) { if (METHODS[kx].verified !== false && !self.prov[kx]) { /* verified keys are not listed */ } });
        S.flags.length = 0; (snap.flags || []).forEach(function (fl) { S.flags.push({ code: fl.code, sev: fl.sev, msg: fl.msg }); });
        // the derived quantities of the restored state (props, holdups, closures with the restored lagged v_d — no relaxation applied)
        var keepVd = new Float64Array(fs.vd);
        this._prep(false);
        for (var q = 0; q < fs.vd.length; q++) fs.vd[q] = keepVd[q];
        S.balance.m = this._totals();
        this._post(0, false, true);
        this.ch = null;
        this._restored = true;
        return { ok: true };
    };

    // ── namespace ────────────────────────────────────────────────────────────────────────────────────────────────────
    var NS = G.WTS_wd_engine = G.WTS_wd_engine || {};
    NS.ext = NS.ext || {};
    NS.create = create; NS.COMP = COMP; NS.REGIMES = REGIMES; NS.STATES = STATES; NS.STATE_ORDER = STATE_ORDER; NS.CHANNELS = CHANNELS; NS.METHODS = METHODS;
    NS.VERSION = VERSION; NS.engineId = ENGINE_ID; NS.hash = hash; NS.canon = canon; NS.PROVISIONAL = PROVISIONAL;
    NS.GILBERT_YC = function () { return (G.WTS_wp_system && _fin(G.WTS_wp_system.GILBERT_YC)) ? G.WTS_wp_system.GILBERT_YC : 0.588; };
    NS.DF = DF; NS.buildGrid = buildGrid; NS._Sim = Sim;
})();
// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, E = G.WTS_wd_engine;
    if (!E || E.STATE_ORDER.length !== 18 || E.CHANNELS.length !== 36 || E.REGIMES.length !== 10) throw new Error('WTS_wd_engine self-test: frozen orders');
})();
