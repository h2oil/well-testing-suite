// =============================================================================
// WTS — 49-calc-wd-rec.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Dynamics recorder, replay files and cases (lane WD3; docs/WELL-DYNAMICS-PLAN.md §3.4, §3.7, §3.8, §7).
// Pure data code: no DOM, no storage of its own (cases go through WTS_wp_model.write, the one writer of the well model), no timers.
//
//   WTS_wd_rec.create(o) → rec       o {every_s 10, snapEvery_s 60, capMB 32, channels null (all)}
//     rec.attach(sim)                 subscribes to the sim's 'step' / 'event' / 'state' (synchronous engine events, §3.5); samples when
//                                     t crosses the next sample time and on every event / state change; snapshots every snapEvery_s
//     rec.sample(sim, force?) → bool, rec.snap(sim) → bool, rec.channels() → [{key, label, unit, cat, dp}] (= WTS_wd_engine.CHANNELS)
//     rec.times() / rec.series(key)   Float64Array views (same length)
//     rec.at(t) → {t, values}         linear between samples; step channels (bean, open, state, opValve) hold the earlier sample
//     rec.snapAt(t) → Snap | null     the latest snapshot at or before t
//     rec.frameAt(t) → {t, cells, liquidTopMd, gasCapMd} | null   (additive) the display arrays kept with the latest snapshot at or
//                                     before t — a Snap holds masses, p and T only, so a scrubbed wellbore draws from these
//     rec.truncate(t)                 drops samples, snapshots, events and marks after t (the "Continue from here" branch)
//     rec.mark(t0, t1, label) → id, rec.marks(), rec.unmark(id), rec.events() → the applied Event log
//     rec.csv(o) → string             o {cols, from, to, every_s, system:'field'|'metric', u(v, cat) → display value, decimalComma, marks}
//     rec.toFile(meta) → RunFile (§3.7), rec.bytes(), rec.clear(), rec.count(), rec.span() → [t0, t1]
//   WTS_wd_rec.fromFile(obj | text) → {ok, run, rec, warnings, code?: 'FORMAT'|'VERSION'|'TOO_BIG'}
//   WTS_wd_rec.compare(stored, rerun, o?) → {ok, n, firstDiff_t, maxRel, maxDp}   the cross-engine replay check (R25: 0.5 % rates, 1 psi)
//   WTS_wd_rec.summarize(rec, sim?) → Summary (§3.8)
//   WTS_wd_rec.RUN_FORMAT 'wts-welldyn-run', RUN_VERSION 1, EXT '.wdrun', MAX_FILE 5 MB (snapshots dropped above), MAX_OPEN 64 MB,
//   WTS_wd_rec.engineId() (the engine's fingerprint, else this module's of the same function list), hash(o), channelMeta()
//
//   WTS_wd_cases.list(M) → Case[] (M.dyn.cases), save(case) → the WTS_wp_model.write result (≤ 20 cases, ≤ 24 kB of dyn: the oldest
//   unnamed cases go first, then the oldest), remove(id), toScenario(case) → {settings, events, duration_s}, make(o) → Case, MAX 20,
//   CAP_BYTES 24,000, readDyn() → the stored dyn record or null
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var RUN_FORMAT = 'wts-welldyn-run', RUN_VERSION = 1, EXT = '.wdrun';
    var MAX_FILE = 5 * 1024 * 1024, MAX_OPEN = 64 * 1024 * 1024;
    var CASE_MAX = 20, CASE_CAP = 24000;
    var PATM = 14.696;
    // the frozen channel order of §3.4 (the engine's own CHANNELS win when it is loaded; these are the fallback copies)
    var CH_KEYS = ['t', 'thp', 'tht', 'pwf', 'pr', 'pcs', 'qo', 'qw', 'qL', 'qg', 'qo_res', 'qw_res', 'qg_res', 'gor', 'wc', 'bean', 'open', 'state',
        'lratio', 'qc', 'liq', 'gascap', 'qinj', 'opValve', 'pint', 'freq', 'load', 'foam', 'dt', 'massErr', 'qgForm', 'gorForm', 'qvent', 'liftgas', 'qcVert', 'qcBelfroid'];
    var STATE_ORDER = ['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin', 'gl_unloading',
        'gl_lifting', 'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped'];
    // key: [label, field unit, units-layer category | null, decimals]
    var META = {
        t: ['Time', 's', null, 0], thp: ['THP', 'psig', 'pressureG', 1], tht: ['THT', '°F', 'temperature', 1], pwf: ['BHP', 'psia', 'pressure', 1],
        pr: ['Reservoir pressure', 'psia', 'pressure', 1], pcs: ['Casing pressure', 'psig', 'pressureG', 1], qo: ['Oil / condensate rate', 'STB/d', 'liquidRate', 1],
        qw: ['Water rate', 'STB/d', 'liquidRate', 1], qL: ['Liquid rate', 'STB/d', 'liquidRate', 1], qg: ['Gas rate (total)', 'Mscf/d', 'gasRateSmall', 1],
        qo_res: ['Oil rate at the sandface', 'STB/d', 'liquidRate', 1], qw_res: ['Water rate at the sandface', 'STB/d', 'liquidRate', 1],
        qg_res: ['Gas rate at the sandface', 'Mscf/d', 'gasRateSmall', 1], gor: ['GOR (total)', 'scf/STB', 'gor', 0], wc: ['Water cut', 'fraction', null, 4],
        bean: ['Bean', '/64 in', null, 1], open: ['Open', '0/1', null, 0], state: ['Well state (index)', '-', null, 0], lratio: ['Rate / critical rate', '-', null, 3],
        qc: ['Critical rate', 'MMscf/d', 'gasRate', 3], liq: ['Liquid in the tubing and liner', 'bbl', 'volume', 2], gascap: ['Gas-liquid interface (MD)', 'ft', 'length', 0],
        qinj: ['Lift-gas rate', 'Mscf/d', 'gasRateSmall', 1], opValve: ['Operating valve', 'n', null, 0], pint: ['Pump intake pressure', 'psia', 'pressure', 1],
        freq: ['Frequency', 'Hz', null, 2], load: ['Motor load', 'fraction', null, 3], foam: ['Foamer at the bottom', 'ppm', null, 0], dt: ['Time step', 's', null, 3],
        massErr: ['Mass balance error (cumulative)', 'relative', null, 8], qgForm: ['Formation gas rate', 'Mscf/d', 'gasRateSmall', 1], gorForm: ['GOR (formation)', 'scf/STB', 'gor', 0],
        qvent: ['Vented gas rate', 'Mscf/d', 'gasRateSmall', 1], liftgas: ['Lift gas in the tubing', 'Mscf', null, 3], qcVert: ['Critical rate (vertical)', 'MMscf/d', 'gasRate', 3],
        qcBelfroid: ['Critical rate (Belfroid)', 'MMscf/d', 'gasRate', 3]
    };
    var HOLD = { bean: 1, open: 1, state: 1, opValve: 1 };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _num(v) { return _fin(v) ? v : NaN; }
    function _E() { return G.WTS_wd_engine || null; }
    function _keys() { var E = _E(); return (E && Array.isArray(E.CHANNELS) && E.CHANNELS.length) ? E.CHANNELS.slice() : CH_KEYS.slice(); }
    function _stateOrder() { var E = _E(); return (E && Array.isArray(E.STATE_ORDER) && E.STATE_ORDER.length) ? E.STATE_ORDER : STATE_ORDER; }
    function _canon(o) {
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.canon === 'function') { try { return AI.canon(o); } catch (e) { /* fall through */ } }
        return JSON.stringify(o, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; });
    }
    function _fnv(s, h) { for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
    function _hash(o) {
        var s = typeof o === 'string' ? o : _canon(o), AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.hash16 === 'function') return AI.hash16(s);
        var a = _fnv(s, 0x811c9dc5), b = _fnv(s, 0x01000193);
        return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
    }
    var _eid = null;
    function engineId() {
        var E = _E();
        if (E && typeof E.engineId === 'string' && E.engineId) return E.engineId;
        if (E && typeof E.engineId === 'function') { try { var v = E.engineId(); if (v) return String(v); } catch (e) { /* ignore */ } }
        if (!_eid) _eid = _hash([Math.exp(1.1), Math.log(7.3), Math.pow(2.2, 3.3), Math.sqrt(5.1), Math.sin(0.7), Math.exp(-3.7), Math.log(0.37), Math.pow(10, -0.43)]);
        return _eid;
    }
    function channelMeta(key) {
        var m = META[key] || [key, '', null, 3];
        return { key: key, label: m[0], unit: m[1], cat: m[2], dp: m[3] };
    }

    // ── the channel values of one engine state (§3.2 → §3.4) ────────────────────
    function _values(S, keys) {
        var su = S.surface || {}, bo = S.bottom || {}, lo = S.loading || {}, inv = S.inventory || {}, li = S.lift || {}, gl = li.gl || null, esp = li.esp || null;
        var c = S.cells || {}, foam = NaN;
        if (c.mF && c.mW && c.mW.length) foam = c.mW[0] > 0 ? 1e6 * c.mF[0] / c.mW[0] : 0;
        else if (S.foamer && _fin(S.foamer.ppm)) foam = S.foamer.on ? S.foamer.ppm : 0;
        var st = S.well && S.well.state, si = _stateOrder().indexOf(st);
        var pcs = gl ? (_fin(gl.pcs_psig) ? gl.pcs_psig : _fin(gl.chp_psig) ? gl.chp_psig : _fin(gl.pcs) ? gl.pcs - PATM : NaN) : NaN;
        var bal = S.balance || {};
        var v = {
            t: S.t, thp: su.thp_psig, tht: su.tht, pwf: bo.pwf, pr: bo.pr, pcs: pcs, qo: su.qo, qw: su.qw, qL: su.qL, qg: su.qg,
            qo_res: bo.qo, qw_res: bo.qw, qg_res: bo.qg, gor: su.gor, wc: su.wc, bean: _fin(S.beanEff) ? S.beanEff : S.bean64, open: S.open ? 1 : 0,
            state: si < 0 ? NaN : si, lratio: lo.ratio, qc: lo.qc_MMscfd, liq: _fin(inv.liqTubing_bbl) ? inv.liqTubing_bbl : inv.liq_bbl,
            gascap: S.open ? NaN : inv.gasCapBottomMd, qinj: su.qinj, opValve: gl ? (_fin(gl.opValve) ? gl.opValve : 0) : NaN,
            pint: esp ? esp.pint : NaN, freq: esp ? esp.freq : NaN, load: esp ? esp.load : NaN, foam: foam, dt: S.dt,
            massErr: _fin(bal.errCum) ? bal.errCum : NaN, qgForm: su.qgForm, gorForm: su.gorForm, qvent: su.qvent,
            liftgas: inv.liftGas_Mscf, qcVert: lo.qcVert_MMscfd, qcBelfroid: lo.qcBelfroid_MMscfd
        };
        return keys.map(function (k) { return _num(v[k]); });
    }

    // display arrays of one state for a scrubbed wellbore (4 significant digits; regimes as codes)
    var DISP = ['p', 'T', 'ag', 'ao', 'aw', 'vg', 'vl', 'vm', 'vc'];
    function _r4(v) { return _fin(v) ? +v.toPrecision(4) : null; }
    function _disp(S) {
        var c = S && S.cells; if (!c || !c.p) return null;
        var o = { cells: {} };
        DISP.forEach(function (k) { if (c[k]) o.cells[k] = Array.prototype.map.call(c[k], _r4); });
        if (c.regime) o.cells.regime = Array.prototype.slice.call(c.regime);
        var inv = S.inventory || {};
        o.liquidTopMd = _fin(inv.liquidTopMd) ? inv.liquidTopMd : null;
        o.gasCapMd = (!S.open && _fin(inv.gasCapBottomMd)) ? inv.gasCapBottomMd : null;
        return o;
    }

    // ── recorder ──────────────────────────────────────────────────────────────
    function create(o) {
        o = o || {};
        var every = _fin(o.every_s) && o.every_s > 0 ? o.every_s : 10;
        var snapEvery = _fin(o.snapEvery_s) && o.snapEvery_s > 0 ? o.snapEvery_s : 60;
        var capB = (_fin(o.capMB) && o.capMB > 0 ? o.capMB : 32) * 1024 * 1024;
        var keys = _keys();
        if (Array.isArray(o.channels) && o.channels.length) keys = keys.filter(function (k) { return k === 't' || o.channels.indexOf(k) !== -1; });
        var K = keys.length, cap = 256, n = 0, cols = keys.map(function () { return new Float64Array(cap); });
        var snaps = [], snapBytes = 0, ev = [], mk = [], mkSeq = 0, nextT = -Infinity, nextSnap = -Infinity, sim = null, subs = null;
        function grow() {
            cap *= 2;
            cols = cols.map(function (a) { var b = new Float64Array(cap); b.set(a); return b; });
        }
        function push(vals) {
            var t = vals[0];
            if (n && t < cols[0][n - 1] - 1e-9) return false;
            if (n && Math.abs(t - cols[0][n - 1]) <= 1e-9) n--;                      // the same moment again: the later values win
            if (n >= cap) grow();
            for (var j = 0; j < K; j++) cols[j][n] = vals[j];
            n++;
            return true;
        }
        function capRule() {
            // §3.4: above capMB drop every second snapshot older than the last hour of simulated time (repeatable); series never
            var guard = 0;
            while (rec.bytes() > capB && guard++ < 64) {
                var tEnd = n ? cols[0][n - 1] : 0, keep = [], drop = false, dropped = 0;
                snaps.forEach(function (s) {
                    if (s.t < tEnd - 3600) { if (drop) { snapBytes -= s.b; dropped++; } else keep.push(s); drop = !drop; }
                    else keep.push(s);
                });
                snaps = keep;
                if (!dropped) break;
            }
        }
        function onStep(info) {
            if (!sim) return;
            var t = sim.state.t;
            if (t >= nextT - 1e-9) { rec.sample(sim); }
            if (t >= nextSnap - 1e-9) { rec.snap(sim); }
        }
        function onEvent(e) { if (!sim) return; ev.push(_clone(e)); rec.sample(sim, true); }
        function onState() { if (sim) rec.sample(sim, true); }
        var rec = {
            every_s: every, snapEvery_s: snapEvery, capMB: capB / 1048576,
            attach: function (s) {
                rec.detach();
                sim = s;
                if (!s || typeof s.on !== 'function') return false;
                subs = { step: onStep, event: onEvent, state: onState };
                s.on('step', onStep); s.on('event', onEvent); s.on('state', onState);
                var t = s.state ? s.state.t : 0;
                if (!n || t > cols[0][n - 1] + 1e-9) { rec.sample(s, true); }
                if (!snaps.length || t > snaps[snaps.length - 1].t + 1e-9) rec.snap(s);
                return true;
            },
            detach: function () {
                if (sim && subs && typeof sim.off === 'function') { sim.off('step', subs.step); sim.off('event', subs.event); sim.off('state', subs.state); }
                sim = null; subs = null;
            },
            sample: function (s, force) {
                s = s || sim; if (!s || !s.state) return false;
                var t = s.state.t;
                if (!force && t < nextT - 1e-9) return false;
                var ok = push(_values(s.state, keys));
                if (t >= nextT - 1e-9) nextT = (Math.floor(t / every + 1e-9) + 1) * every;
                return ok;
            },
            snap: function (s) {
                s = s || sim; if (!s || typeof s.snapshot !== 'function') return false;
                var sn; try { sn = s.snapshot(); } catch (e) { return false; }
                if (!sn) return false;
                var t = _fin(sn.t) ? sn.t : s.state.t;
                while (snaps.length && snaps[snaps.length - 1].t >= t - 1e-9) { snapBytes -= snaps[snaps.length - 1].b; snaps.pop(); }
                var d = _disp(s.state), b = JSON.stringify(sn).length + (d ? JSON.stringify(d).length : 0);
                snaps.push({ t: t, s: sn, d: d, b: b }); snapBytes += b;
                nextSnap = (Math.floor(t / snapEvery + 1e-9) + 1) * snapEvery;
                capRule();
                return true;
            },
            channels: function () { return keys.map(channelMeta); },
            keys: function () { return keys.slice(); },
            count: function () { return n; },
            span: function () { return n ? [cols[0][0], cols[0][n - 1]] : [0, 0]; },
            times: function () { return cols[0].subarray(0, n); },
            series: function (key) { var j = keys.indexOf(key); return j < 0 ? null : cols[j].subarray(0, n); },
            at: function (t) {
                var out = { t: t, values: {} };
                if (!n) return out;
                var T = cols[0], lo = 0, hi = n - 1;
                if (t <= T[0]) { lo = hi = 0; } else if (t >= T[n - 1]) { lo = hi = n - 1; }
                else { while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; } }
                var f = (hi > lo && T[hi] > T[lo]) ? (t - T[lo]) / (T[hi] - T[lo]) : 0;
                for (var j = 0; j < K; j++) {
                    var a = cols[j][lo], b = cols[j][hi], k = keys[j];
                    out.values[k] = (k === 't') ? t : (HOLD[k] || !_fin(a) || !_fin(b)) ? (f >= 1 - 1e-12 ? b : a) : a + f * (b - a);
                }
                return out;
            },
            snapAt: function (t) {
                var best = null;
                for (var i = 0; i < snaps.length; i++) { if (snaps[i].t <= t + 1e-9) best = snaps[i]; else break; }
                return best ? best.s : null;
            },
            snaps: function () { return snaps.map(function (x) { return x.s; }); },
            // the display arrays kept with each snapshot (a Snap holds masses, p and T only): the scrubbed wellbore draws from them
            frameAt: function (t) {
                var best = null;
                for (var i = 0; i < snaps.length; i++) { if (snaps[i].t <= t + 1e-9) { if (snaps[i].d) best = snaps[i]; } else break; }
                return best ? { t: best.t, cells: best.d.cells, liquidTopMd: best.d.liquidTopMd, gasCapMd: best.d.gasCapMd } : null;
            },
            frames: function () { return snaps.map(function (x) { return x.d || null; }); },
            truncate: function (t) {
                var m = n; while (m > 0 && cols[0][m - 1] > t + 1e-9) m--;
                n = m;
                snaps = snaps.filter(function (x) { if (x.t <= t + 1e-9) return true; snapBytes -= x.b; return false; });
                ev = ev.filter(function (e) { return !(e.t > t + 1e-9); });
                mk = mk.filter(function (m0) { return m0.t0 <= t + 1e-9; }).map(function (m0) { if (m0.t1 > t) m0.t1 = t; return m0; });
                nextT = n ? (Math.floor(cols[0][n - 1] / every + 1e-9) + 1) * every : -Infinity;
                nextSnap = snaps.length ? (Math.floor(snaps[snaps.length - 1].t / snapEvery + 1e-9) + 1) * snapEvery : -Infinity;
                return n;
            },
            mark: function (t0, t1, label) {
                if (!_fin(t0)) return null;
                if (!_fin(t1)) t1 = t0;
                if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
                var id = 'm' + (++mkSeq);
                mk.push({ id: id, t0: t0, t1: t1, label: String(label == null ? '' : label).replace(/[\u0000-\u001f]/g, ' ').slice(0, 60) });
                mk.sort(function (a, b) { return a.t0 - b.t0; });
                return id;
            },
            marks: function () { return _clone(mk); },
            unmark: function (id) { var l = mk.length; mk = mk.filter(function (m0) { return m0.id !== id; }); return mk.length !== l; },
            events: function () { return _clone(ev); },
            logEvent: function (e) { if (e && _fin(e.t)) ev.push(_clone(e)); },
            bytes: function () { return n * K * 8 + snapBytes + ev.length * 120; },
            clear: function () { n = 0; snaps = []; snapBytes = 0; ev = []; mk = []; nextT = -Infinity; nextSnap = -Infinity; },
            csv: function (co) { return _csv(rec, keys, co || {}); },
            toFile: function (meta) { return _toFile(rec, keys, meta || {}); },
            _load: function (t, ch, marks, events, snapList, sev, frameList) {
                n = 0; snaps = []; snapBytes = 0; mk = []; ev = [];
                var m = t.length;
                while (cap < m) cap *= 2;
                cols = keys.map(function () { return new Float64Array(cap); });
                for (var i = 0; i < m; i++) {
                    cols[0][i] = t[i];
                    for (var j = 1; j < K; j++) { var a = ch[keys[j]]; var v = a ? a[i] : null; cols[j][i] = (v === null || v === undefined) ? NaN : +v; }
                }
                n = m;
                (marks || []).forEach(function (x) { if (x && _fin(x.t0)) { var id = rec.mark(x.t0, x.t1, x.label); if (id && x.id) mk[mk.length - 1].id = String(x.id).slice(0, 12); } });
                ev = _clone(events || []);
                (snapList || []).forEach(function (s, i) {
                    if (!(s && s.kind === 'wd-snap' && _fin(s.t))) return;
                    var d = frameList && frameList[i] && _isObj(frameList[i].cells) ? frameList[i] : null, b = JSON.stringify(s).length + (d ? JSON.stringify(d).length : 0);
                    snaps.push({ t: s.t, s: s, d: d, b: b }); snapBytes += b;
                });
                snaps.sort(function (a, b) { return a.t - b.t; });
                nextT = n ? (Math.floor(t[n - 1] / every + 1e-9) + 1) * every : -Infinity;
                if (sev) snapEvery = sev;
            }
        };
        return rec;
    }

    // ── CSV (§3.4, §6.3) ──────────────────────────────────────────────────────
    function _defaultU(system) {
        var U = G.WTS_units;
        return function (v, cat) {
            if (system !== 'metric' || !cat || !_fin(v) || !U || !U.CATEGORIES || !U.CATEGORIES[cat] || typeof U.convertCategory !== 'function') return v;
            return U.convertCategory(v, cat, 'imperial', 'metric');
        };
    }
    function _unitLabel(meta, system) {
        var U = G.WTS_units;
        if (system === 'metric' && meta.cat && U && U.CATEGORIES && U.CATEGORIES[meta.cat]) return U.CATEGORIES[meta.cat].metric.label;
        return meta.unit;
    }
    function _cell(s, sep) {
        s = String(s == null ? '' : s);
        if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;                // a spreadsheet must not read a label as a formula
        if (s.indexOf(sep) !== -1 || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
    function _num2s(v, dp, dc) {
        if (!_fin(v)) return '';
        var s = (Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-6 && dp > 6)) ? v.toExponential(6) : v.toFixed(Math.max(0, Math.min(10, dp)));
        if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
        return dc ? s.replace('.', ',') : s;
    }
    function _csv(rec, keys, o) {
        var sys = o.system === 'metric' ? 'metric' : 'field', dc = !!o.decimalComma, sep = dc ? ';' : ',';
        var u = typeof o.u === 'function' ? o.u : _defaultU(sys);
        var cols = (Array.isArray(o.cols) && o.cols.length ? o.cols.filter(function (k) { return keys.indexOf(k) !== -1; }) : keys.slice());
        if (cols.indexOf('t') === -1) cols.unshift('t');
        var T = rec.times(), n = T.length, from = _fin(o.from) ? o.from : -Infinity, to = _fin(o.to) ? o.to : Infinity, ev = _fin(o.every_s) && o.every_s > 0 ? o.every_s : 0;
        var L = [];
        var head = cols.map(function (k) {
            var m = channelMeta(k);
            if (k === 't') return _cell('Time (s)', sep);
            var un = _unitLabel(m, sys);
            return _cell(m.label + (un ? ' (' + un + ')' : ''), sep);
        });
        if (o.title) L.push(_cell('# ' + String(o.title).replace(/[\r\n]+/g, ' '), sep));
        L.push(head.concat(o.hms ? [_cell('Time (h:mm:ss)', sep)] : []).join(sep));
        var series = cols.map(function (k) { return rec.series(k); }), metas = cols.map(channelMeta), next = -Infinity;
        for (var i = 0; i < n; i++) {
            var t = T[i];
            if (t < from - 1e-9 || t > to + 1e-9) continue;
            if (ev) { if (t < next - 1e-9) continue; next = (Math.floor(t / ev + 1e-9) + 1) * ev; }
            var row = [];
            for (var j = 0; j < cols.length; j++) {
                var k = cols[j], v = series[j][i], m = metas[j];
                if (k === 'state' && o.stateNames) { var so = _stateOrder(); row.push(_cell(_fin(v) ? (so[v] || '') : '', sep)); continue; }
                row.push(_num2s(m.cat ? u(v, m.cat) : v, m.dp + (sys === 'metric' && m.cat ? 1 : 0), dc));
            }
            if (o.hms) row.push(_hms(t));
            L.push(row.join(sep));
        }
        if (o.marks !== false) {
            var mk = rec.marks().filter(function (m0) { return m0.t1 >= from && m0.t0 <= to; });
            if (mk.length) {
                L.push('');
                L.push(['Mark', 'From (s)', 'To (s)'].map(function (x) { return _cell(x, sep); }).join(sep));
                mk.forEach(function (m0) { L.push([_cell(m0.label || m0.id, sep), _num2s(m0.t0, 0, dc), _num2s(m0.t1, 0, dc)].join(sep)); });
            }
        }
        return L.join('\r\n') + '\r\n';
    }
    function _hms(t) {
        if (!_fin(t)) return '';
        var s = Math.max(0, Math.round(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
    }

    // ── replay files (§3.7) ───────────────────────────────────────────────────
    function _jsonNum(v) { return _fin(v) ? v : null; }
    function _toFile(rec, keys, meta) {
        var T = rec.times(), ch = {};
        keys.forEach(function (k) { if (k === 't') return; var a = rec.series(k), out = new Array(a.length); for (var i = 0; i < a.length; i++) out[i] = _jsonNum(a[i]); ch[k] = out; });
        var model = _clone(meta.model) || { scalars: {}, tables: {} }, settings = _clone(meta.settings) || {};
        if (settings) { delete settings.snapshot; delete settings.ref; }
        var events = _clone(meta.events || rec.events()) || [];
        var run = {
            format: RUN_FORMAT, v: RUN_VERSION, app: meta.app || _appVer(), created: meta.created || new Date().toISOString(),
            engine: meta.engine || ((_E() && _E().VERSION) || ''), engineId: meta.engineId || engineId(),
            well: { name: String((meta.well && meta.well.name) || '').slice(0, 80) },
            model: model, settings: settings, events: events, duration_s: _fin(meta.duration_s) ? meta.duration_s : (T.length ? T[T.length - 1] : 0),
            rec: { every_s: rec.every_s, t: Array.prototype.slice.call(T), ch: ch, marks: rec.marks() },
            snaps: { every_s: rec.snapEvery_s, list: rec.snaps(), frames: rec.frames() },   // frames: additive (display arrays per snapshot)
            summary: meta.summary || null,
            hash: _hash({ model: model, settings: settings, events: events })
        };
        var size = JSON.stringify(run).length;
        if (size > (meta.maxBytes || MAX_FILE)) { run.snaps = null; run.notes = ['snapshots dropped: the file would exceed ' + Math.round((meta.maxBytes || MAX_FILE) / 1048576) + ' MB']; }
        return run;
    }
    function _appVer() { try { var R = G.RELEASE_NOTES; return (R && R[0] && R[0].ver) ? String(R[0].ver) : ''; } catch (e) { return ''; } }
    function fromFile(src) {
        var obj = src, warnings = [];
        if (typeof src === 'string') {
            if (src.length > MAX_OPEN) return { ok: false, code: 'TOO_BIG', errors: ['the replay file is larger than ' + Math.round(MAX_OPEN / 1048576) + ' MB'], warnings: [] };
            try { obj = JSON.parse(src); } catch (e) { return { ok: false, code: 'FORMAT', errors: ['the file is not a Well Dynamics replay file (malformed JSON)'], warnings: [] }; }
        }
        if (!_isObj(obj) || obj.format !== RUN_FORMAT) return { ok: false, code: 'FORMAT', errors: ['the file is not a Well Dynamics replay file'], warnings: [] };
        if (!(obj.v === RUN_VERSION)) return { ok: false, code: 'VERSION', errors: ['replay file version ' + String(obj.v).slice(0, 8) + ' is not supported by this version (' + RUN_VERSION + ')'], warnings: [] };
        var r = obj.rec;
        if (!_isObj(r) || !Array.isArray(r.t) || !_isObj(r.ch)) return { ok: false, code: 'FORMAT', errors: ['the replay file has no recorded series'], warnings: [] };
        var t = r.t.map(function (x) { return +x; }), bad = false;
        for (var i = 0; i < t.length; i++) if (!_fin(t[i]) || (i && t[i] < t[i - 1])) { bad = true; break; }
        if (bad) return { ok: false, code: 'FORMAT', errors: ['the recorded times are not ascending numbers'], warnings: [] };
        var ch = {}, keys = _keys();
        Object.keys(r.ch).forEach(function (k) {
            if (keys.indexOf(k) === -1) { warnings.push({ code: 'UNKNOWN_CHANNEL', msg: 'channel ' + String(k).slice(0, 24) + ' is not known to this version and was skipped', sev: 'info' }); return; }
            var a = r.ch[k]; if (!Array.isArray(a) || a.length !== t.length) { warnings.push({ code: 'CHANNEL_LENGTH', msg: 'channel ' + k + ' has the wrong length and was skipped', sev: 'warn' }); return; }
            ch[k] = a;
        });
        var rec = create({ every_s: _fin(r.every_s) ? r.every_s : 10, snapEvery_s: obj.snaps && _fin(obj.snaps.every_s) ? obj.snaps.every_s : 60 });
        var snaps = obj.snaps && Array.isArray(obj.snaps.list) ? obj.snaps.list : [];
        if (!obj.snaps) warnings.push({ code: 'NO_SNAPSHOTS', msg: 'the file has no snapshots (dropped to keep it under 5 MB): the recording can be viewed, not continued', sev: 'info' });
        rec._load(t, ch, Array.isArray(r.marks) ? r.marks : [], Array.isArray(obj.events) ? obj.events : [], snaps, obj.snaps && obj.snaps.every_s,
            obj.snaps && Array.isArray(obj.snaps.frames) ? obj.snaps.frames : null);
        var run = _clone(obj);
        run.well = { name: String((obj.well && obj.well.name) || '').slice(0, 80) };
        if (!_isObj(run.model)) run.model = { scalars: {}, tables: {} };
        if (!_isObj(run.settings)) run.settings = {};
        if (!Array.isArray(run.events)) run.events = [];
        var h = _hash({ model: run.model, settings: run.settings, events: run.events });
        if (obj.hash && obj.hash !== h) warnings.push({ code: 'HASH', msg: 'the model or settings in the file were changed after it was saved', sev: 'warn' });
        if (obj.engineId && obj.engineId !== engineId()) warnings.push({ code: 'ENGINE', msg: 'made with a different JavaScript engine: a re-run is compared with the recording (0.5 % in rates, 1 psi in pressures)', sev: 'info' });
        return { ok: true, run: run, rec: rec, warnings: warnings, sameEngine: !obj.engineId || obj.engineId === engineId() };
    }
    // the replay re-run check (R25): equal at the stored samples within 0.5 % in rates and 1 psi in pressures, up to the first difference
    var RATE_KEYS = ['qo', 'qw', 'qL', 'qg', 'qgForm', 'qo_res', 'qw_res', 'qg_res', 'qinj'], P_KEYS = ['thp', 'pwf', 'pcs', 'pint'];
    function compare(a, b, o) {
        o = o || {};
        var relTol = _fin(o.relTol) ? o.relTol : 0.005, pTol = _fin(o.pTol) ? o.pTol : 1;
        var Ta = a.times(), out = { ok: true, n: 0, identical: true, firstDiff_t: null, maxRel: 0, maxDp: 0 };
        for (var i = 0; i < Ta.length; i++) {
            var t = Ta[i], sp = b.span(); if (t > sp[1] + 1e-9) break;
            var vb = b.at(t).values; out.n++;
            RATE_KEYS.forEach(function (k) {
                var sa = a.series(k), x = sa ? sa[i] : NaN, y = vb[k];
                if (!_fin(x) || !_fin(y)) return;
                if (x !== y) out.identical = false;
                var scale = Math.max(Math.abs(x), Math.abs(y), 1), r = Math.abs(x - y) / scale;
                if (r > out.maxRel) out.maxRel = r;
                if (r > relTol && out.firstDiff_t === null) out.firstDiff_t = t;
            });
            P_KEYS.forEach(function (k) {
                var sa = a.series(k), x = sa ? sa[i] : NaN, y = vb[k];
                if (!_fin(x) || !_fin(y)) return;
                if (x !== y) out.identical = false;
                var d = Math.abs(x - y); if (d > out.maxDp) out.maxDp = d;
                if (d > pTol && out.firstDiff_t === null) out.firstDiff_t = t;
            });
        }
        out.ok = out.firstDiff_t === null;
        return out;
    }

    // ── run summary (§3.8) ────────────────────────────────────────────────────
    function summarize(rec, sim) {
        var T = rec.times(), n = T.length, so = _stateOrder();
        var s = function (k) { return rec.series(k) || new Float64Array(n); };
        var last = function (k) { var a = s(k); return n ? (_fin(a[n - 1]) ? a[n - 1] : null) : null; };
        var mx = function (k, f) { var a = s(k), v = null; for (var i = 0; i < n; i++) if (_fin(a[i])) v = v === null ? a[i] : f(v, a[i]); return v; };
        var gas = false;
        try { var Mx = sim && sim.M; gas = !!(Mx && Mx.fluid && /gas|condensate/.test(Mx.fluid.type)); } catch (e) { gas = false; }
        var qk = gas ? 'qg' : 'qL';
        var states = [], st = s('state'), cur = null;
        for (var i = 0; i < n; i++) {
            var k = _fin(st[i]) ? so[st[i]] : null;
            if (k !== (cur && cur.key)) { if (cur) cur.to = T[i]; if (k) { cur = { key: k, from: T[i], to: T[i] }; states.push(cur); } else cur = null; }
        }
        if (cur) cur.to = n ? T[n - 1] : 0;
        if (states.length > 50) states = states.slice(states.length - 50);
        var tIn = function (key) { var h = 0; states.forEach(function (x) { if (x.key === key) h += x.to - x.from; }); return h / 3600; };
        // cumulative production (trapezoid, rates per day)
        var cum = function (k) { var a = s(k), c = 0; for (var i = 1; i < n; i++) { var x = a[i - 1], y = a[i]; if (_fin(x) && _fin(y)) c += 0.5 * (x + y) * (T[i] - T[i - 1]) / 86400; } return c; };
        var buildup = null, open = s('open');
        if (n > 3 && open[n - 1] === 0) {
            var k0 = n - 1; while (k0 > 0 && open[k0 - 1] === 0) k0--;
            var tShut = T[k0], pw = s('pwf');
            var i2 = n - 1, i1 = k0; for (var j = n - 1; j > k0; j--) { if ((T[j] - tShut) <= 0.5 * (T[n - 1] - tShut)) { i1 = j; break; } }
            var d1 = T[i1] - tShut, d2 = T[i2] - tShut;
            if (d1 > 0 && d2 > d1 && _fin(pw[i1]) && _fin(pw[i2])) {
                var m = (pw[i2] - pw[i1]) / Math.log(d2 / d1), k_est = null;
                try {
                    var R = sim && sim.opts && sim.opts.reservoir, q = k0 > 0 ? s(gas ? 'qg' : 'qL')[k0 - 1] : NaN;
                    if (R && R.mode === 'transient' && _fin(R.h) && R.h > 0 && _fin(R.mu) && _fin(R.B) && _fin(q) && m > 0 && !gas) k_est = 70.6 * q * R.B * R.mu / (R.h * m);
                } catch (e) { k_est = null; }
                buildup = { pws_end: pw[i2], dpdlnDt: m, k_est: k_est };
            }
        }
        var gate = null;
        if (sim && typeof sim.steadyCheck === 'function') { try { var g = sim.steadyCheck(); if (g && _fin(g.dq)) gate = { dq: g.dq, dp: g.dp, ampQ: g.ampQ, ampP: g.ampP }; } catch (e) { gate = null; } }
        var prior = null; try { prior = _clone(sim && sim.opts && sim.opts.reservoir && sim.opts.reservoir.prior) || null; } catch (e) { prior = null; }
        var prov = []; try { prov = (sim && sim.state && sim.state.provisional) ? sim.state.provisional.slice() : []; } catch (e) { prov = []; }
        return {
            duration_s: n ? T[n - 1] - T[0] : 0, endState: states.length ? states[states.length - 1].key : null, states: states,
            qo: last('qo'), qw: last('qw'), qg: last('qg'), qgForm: last('qgForm'), gorForm: last('gorForm'), prior: prior,
            thp_psig: last('thp'), pwf: last('pwf'), qMax: mx(qk, Math.max), qMin: mx(qk, Math.min), thpMax_psig: mx('thp', Math.max),
            pwfMax: mx('pwf', Math.max), liqMax_bbl: mx('liq', Math.max), tLoading_h: tIn('loading'), tDead_h: tIn('dead'),
            cumO_STB: cum('qo'), cumW_STB: cum('qw'), cumG_MMscf: cum('qg') / 1000, buildup: buildup, gate: gate, provisional: prov,
            massErr: last('massErr'), engineId: engineId()
        };
    }

    // ── cases (§3.8, §7) — the dyn key of the shared well model ─────────────────
    function _M() { var W = G.WTS_wp_model; if (!W || typeof W.read !== 'function') return null; try { return W.read(); } catch (e) { return null; } }
    function readDyn() {
        var W = G.WTS_wp_model; if (!W || typeof W.readRaw !== 'function') return null;
        var r = W.readRaw(); if (!r || r.status !== 'ok' || !r.rec) return null;
        var d = r.rec.dyn; if (!_isObj(d)) return null;
        var v = typeof W.validate === 'function' ? W.validate(r.rec).rec.dyn : d;
        return _isObj(v) ? _clone(v) : null;
    }
    function list(M) {
        M = M || _M();
        var d = M && M.dyn; if (!_isObj(d) || !Array.isArray(d.cases)) return [];
        return _clone(d.cases);
    }
    function _cleanText(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
    var _seq = 0;
    function make(o) {
        o = o || {};
        var id = (typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(o.id)) ? o.id : 'c' + Date.now().toString(36) + (++_seq).toString(36);
        var st = _clone(o.settings) || {}; delete st.snapshot; delete st.ref;
        return { id: id, name: _cleanText(o.name, 60), created: typeof o.created === 'string' ? o.created.slice(0, 24) : new Date().toISOString().slice(0, 16).replace('T', ' '),
            settings: st, events: (Array.isArray(o.events) ? _clone(o.events) : []).slice(0, 200), duration_s: _fin(o.duration_s) ? o.duration_s : 0,
            summary: _isObj(o.summary) ? _clone(o.summary) : null, note: _cleanText(o.note, 200) };
    }
    function _size(d) { return JSON.stringify(d).length; }
    function _fit(d) {
        // ≤ 20 cases, ≤ 24 kB: the oldest unnamed cases go first, then the oldest (never the newest one)
        var dropped = [];
        while (d.cases.length > CASE_MAX || (_size(d) > CASE_CAP && d.cases.length > 1)) {
            var idx = -1;
            for (var i = 0; i < d.cases.length - 1; i++) if (!d.cases[i].name) { idx = i; break; }
            if (idx < 0) idx = 0;
            dropped.push(d.cases[idx].id); d.cases.splice(idx, 1);
        }
        if (_size(d) > CASE_CAP && d.cases.length === 1 && d.cases[0].summary) { d.cases[0].summary = null; dropped.push(d.cases[0].id + ':summary'); }
        return dropped;
    }
    function _write(d) {
        var W = G.WTS_wp_model;
        if (!W || typeof W.write !== 'function') return { ok: false, code: 'MISSING_ENGINE', errors: ['WTS_wp_model.write is not available'], warnings: [] };
        if (!W.TABLE_KEYS || W.TABLE_KEYS.indexOf('dyn') === -1) return { ok: false, code: 'NO_DYN_KEY', errors: ['this version of the well model has no Well Dynamics cases'], warnings: [] };
        return W.write({ dyn: d });
    }
    function _baseDyn() { var d = readDyn() || {}; return { v: 1, cases: Array.isArray(d.cases) ? d.cases : [], res: _isObj(d.res) ? d.res : null, preset: typeof d.preset === 'string' ? d.preset : null }; }
    function save(c) {
        var cc = c && c.id && c.settings ? make(c) : make(c || {});
        var d = _baseDyn(), i = -1;
        d.cases.forEach(function (x, j) { if (x && x.id === cc.id) i = j; });
        if (i < 0 && cc.name) d.cases.forEach(function (x, j) { if (i < 0 && x && x.name && x.name.toLowerCase() === cc.name.toLowerCase()) i = j; });
        if (i >= 0) { cc.id = d.cases[i].id; d.cases.splice(i, 1); }
        d.cases.push(cc);
        var dropped = _fit(d);
        var r = _write(d);
        if (r && r.ok) { r.id = cc.id; r.dropped = dropped; r.replaced = i >= 0; }
        return r;
    }
    function remove(id) {
        var d = _baseDyn(), l = d.cases.length;
        d.cases = d.cases.filter(function (x) { return x && x.id !== id; });
        if (d.cases.length === l) return { ok: false, code: 'NOT_FOUND', errors: ['no case ' + String(id).slice(0, 24)], warnings: [] };
        return _write(d);
    }
    function setRes(res, preset) {
        var d = _baseDyn();
        if (res !== undefined) d.res = _isObj(res) ? _clone(res) : null;
        if (preset !== undefined) d.preset = typeof preset === 'string' ? preset.slice(0, 24) : null;
        return _write(d);
    }
    function toScenario(c) {
        if (!_isObj(c)) return null;
        return { settings: _clone(c.settings) || {}, events: _clone(c.events) || [], duration_s: _fin(c.duration_s) ? c.duration_s : 0 };
    }

    var NS = G.WTS_wd_rec = G.WTS_wd_rec || {};
    NS.create = create; NS.fromFile = fromFile; NS.compare = compare; NS.summarize = summarize; NS.engineId = engineId; NS.hash = _hash;
    NS.channelMeta = channelMeta; NS.hms = _hms;
    NS.RUN_FORMAT = RUN_FORMAT; NS.RUN_VERSION = RUN_VERSION; NS.EXT = EXT; NS.MAX_FILE = MAX_FILE; NS.MAX_OPEN = MAX_OPEN;
    NS.CHANNELS_FALLBACK = CH_KEYS.slice(); NS.STATE_ORDER_FALLBACK = STATE_ORDER.slice();
    var CS = G.WTS_wd_cases = G.WTS_wd_cases || {};
    CS.list = list; CS.save = save; CS.remove = remove; CS.toScenario = toScenario; CS.make = make; CS.readDyn = readDyn; CS.setRes = setRes;
    CS.MAX = CASE_MAX; CS.CAP_BYTES = CASE_CAP;
    // WD0 stub contract: a lane's file removes its own names from window.__WD_STUBS when it loads
    if (Array.isArray(G.__WD_STUBS)) G.__WD_STUBS = G.__WD_STUBS.filter(function (s) { return !/^WTS_wd_(rec|cases)\b/.test(String(s)); });
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, R = G.WTS_wd_rec, bad = [];
    if (!R || typeof R.create !== 'function') return;
    var r = R.create({ every_s: 10 });
    if (r.count() !== 0) bad.push('empty');
    var f = R.fromFile('{"format":"x"}'); if (f.ok || f.code !== 'FORMAT') bad.push('format');
    if (bad.length && typeof console !== 'undefined') console.error('[wd-rec self-test] ' + bad.join(', '));
})();
