// =============================================================================
// PRiSM — 39-prism-fieldtools.js  (Round 8)
// -----------------------------------------------------------------------------
// Field-data tools for the analysis workflow (ROADMAP §2.1 R12, R13, R15):
//
//   R12 Gauge register — serial, type, range, resolution, accuracy,
//       calibration date and depth per gauge. The primary gauge's resolution
//       is checked against the expected semilog slope (current fit, semilog
//       analysis or physical model) and against the data: derivative points
//       whose differentiation window changes by less than one resolution
//       step are flagged on the log-log diagnostic plot (post-draw hook).
//   R13 Sequence-of-events log — tool open/close, choke and rate changes,
//       sampling, gauge runs, notes, with times on the dataset clock (hours)
//       or wall-clock times converted with the log's clock zero. Events are
//       drawn as markers on the history, log-log and MDH plots, and can seed
//       the multi-rate table (the C2 rate history / flow periods), undoable
//       through the workflow undo stack. Host pages and the simulator append
//       events with window.PRiSM_addEvent(evt).
//   R15 Total-compressibility builder — ct = So·co + Sw·cw + Sg·cg + cf with
//       co / cw / cg from the 16-pvt correlation library and cf from a rock
//       correlation; writes ct through PRiSM_setWell({ct}, {source:
//       'correlation'}) and reports which inputs were defaults.
//
// PUBLIC API (window.*)
//   PRiSM_listGauges() / PRiSM_setGauge(g) / PRiSM_removeGauge(id)
//   PRiSM_setPrimaryGauge(id) / PRiSM_primaryGauge()
//   PRiSM_gaugeResolutionCheck(opts?)        → check result (see below)
//   PRiSM_gaugeSamplingLimit(m, dtSample, resolution) → Δt (h)
//   PRiSM_addEvent(evt) / PRiSM_listEvents() / PRiSM_removeEvent(id)
//   PRiSM_clearEvents() / PRiSM_setEventClock(time)
//   PRiSM_eventsToRateSchedule(events?)      → {ok, rows:[{t,q}], warnings}
//   PRiSM_seedPeriodsFromEvents(opts?)       → writes PRiSM.multiRate (undoable)
//   PRiSM_rockCompressibility(phi, method)   → cf (1/psi)
//   PRiSM_ctBuild(input?) / PRiSM_ctApply(result?)
//   PRiSM_renderGaugeRegister(host) / PRiSM_renderEventsLog(host)
//   PRiSM_renderCtBuilder(host) / PRiSM_renderGaugeCheckPanel(host)
//
// STATE — PRiSM_state.fieldTools {gauges[], primaryGauge, events[], clockZero,
//   ctBuild}; saved by PRiSM_saveState (C8) and carried in project files by
//   the 'prism' module. Events fired: prism:gauges-changed,
//   prism:events-changed, prism:period-changed {source:'events'} (seeding).
//
// UNITS — field units: t hours, p psia, resolution / accuracy / range psi,
//   depth ft, q STB/d (oil, water) or Mscf/d (gas), compressibility 1/psi.
//
// CONVENTIONS — single outer IIFE, window.PRiSM_* names, no timers, no
//   polling, no function wrapping; every cross-module call is typeof-guarded.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;
    var LN10 = Math.log(10);

    // =========================================================================
    // SECTION 1 — HELPERS
    // =========================================================================

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isPos(v) { return isNum(v) && v > 0; }
    function isArr(a) { return !!a && typeof a !== 'string' && typeof a.length === 'number'; }
    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        var x = (typeof v === 'number') ? v : parseFloat(v);
        return isNum(x) ? x : null;
    }
    function str(v, max) {
        if (v == null) return '';
        var s = String(v).replace(/[\u0000-\u001f]+/g, ' ').trim();
        return s.length > (max || 200) ? s.slice(0, max || 200) : s;
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
    }
    function median(a) {
        var b = [];
        for (var i = 0; i < a.length; i++) if (isNum(a[i])) b.push(a[i]);
        if (!b.length) return NaN;
        b.sort(function (x, y) { return x - y; });
        var m = b.length >> 1;
        return (b.length % 2) ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e6 || a < 1e-3) return v.toExponential((sig || 3) - 1);
        return String(+v.toPrecision(sig || 4));
    }
    function $(id) { try { return D && D.getElementById ? D.getElementById(id) : null; } catch (e) { return null; } }
    function now() { try { return Date.now(); } catch (e) { return 0; } }

    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
            if (CE) G.dispatchEvent(new CE(type, { detail: detail || {} }));
        } catch (e) { /* a listener threw — never break the caller */ }
    }
    function on(type, fn) {
        try { if (typeof G.addEventListener === 'function') G.addEventListener(type, fn); } catch (e) { /* stub */ }
    }

    function st() {
        if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    // Field-tools store inside the analysis state (C8: saved by PRiSM_saveState).
    function ft() {
        var s = st();
        var f = s.fieldTools;
        if (!f || typeof f !== 'object') f = s.fieldTools = {};
        if (!Array.isArray(f.gauges)) f.gauges = [];
        if (!Array.isArray(f.events)) f.events = [];
        if (f.primaryGauge === undefined) f.primaryGauge = null;
        if (f.clockZero === undefined) f.clockZero = null;
        return f;
    }
    function save() {
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* storage optional */ } }
    }
    function redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }
    function newId(prefix, list) {
        var n = list.length + 1, id;
        do { id = prefix + n; n++; } while (list.some(function (x) { return x && x.id === id; }));
        return id;
    }

    // Wall-clock parser: ms epoch, Date, or an ISO-like string. A string with no
    // zone is read as UTC so the log's clock zero and event times always use
    // the same convention (only differences matter).
    function parseClock(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number') return isNum(v) ? v : null;
        if (v instanceof Date) { var d = v.getTime(); return isNum(d) ? d : null; }
        var s = String(v).trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
        else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = s + 'T00:00:00Z';
        var ms = Date.parse(s);
        return isNum(ms) ? ms : null;
    }
    function clockText(ms) {
        if (!isNum(ms)) return '';
        try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return ''; }
    }
    function validDate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        var ms = Date.parse(s + 'T00:00:00Z');
        return isNum(ms) && new Date(ms).toISOString().slice(0, 10) === s;
    }

    // Analysis data (C2) for the analysed period.
    function analysisData(opts) {
        opts = opts || {};
        if (typeof G.PRiSM_getAnalysisData !== 'function') return { ok: false, reason: 'Analysis data layer not loaded.' };
        var s = st();
        var o = {};
        if (isNum(opts.L)) o.L = opts.L; else if (isNum(s.bourdetL)) o.L = s.bourdetL;
        if (opts.period != null) o.period = opts.period;
        else if (isNum(s.activePeriod) && s.activePeriod >= 0) o.period = s.activePeriod;
        if (opts.timeFn) o.timeFn = opts.timeFn; else if (s.timeFn) o.timeFn = s.timeFn;
        try { return G.PRiSM_getAnalysisData(G.PRiSM_dataset, o) || { ok: false, reason: 'No analysis data.' }; }
        catch (e) { return { ok: false, reason: 'Analysis data: ' + (e && e.message) }; }
    }

    // =========================================================================
    // SECTION 2 — R12 GAUGE REGISTER
    // =========================================================================

    var GAUGE_TYPES = { quartz: 'Quartz', sapphire: 'Sapphire', strain: 'Strain gauge', piezo: 'Piezo-resistive', other: 'Other' };

    // Normalises a gauge record. Returns {gauge, errors[]}.
    function normGauge(g, prev) {
        var errors = [];
        g = g || {};
        var out = prev ? clone(prev) : {};
        function setNum(key, min, label, strictPos) {
            if (!Object.prototype.hasOwnProperty.call(g, key)) return;
            var v = num(g[key]);
            if (g[key] === null || g[key] === '') { out[key] = null; return; }
            if (v == null || v < min || (strictPos && v <= 0)) { errors.push(label + ' must be ' + (strictPos ? '> ' : '≥ ') + min + '.'); return; }
            out[key] = v;
        }
        if (Object.prototype.hasOwnProperty.call(g, 'serial')) out.serial = str(g.serial, 60);
        if (Object.prototype.hasOwnProperty.call(g, 'type')) out.type = GAUGE_TYPES[g.type] ? g.type : 'other';
        setNum('range', 0, 'Range (psi)', true);
        setNum('resolution', 0, 'Resolution (psi)', true);
        setNum('accuracy', 0, 'Accuracy (psi)', false);
        setNum('depth', 0, 'Depth (ft)', false);
        if (Object.prototype.hasOwnProperty.call(g, 'calDate')) {
            var cd = str(g.calDate, 10);
            if (cd === '') out.calDate = null;
            else if (validDate(cd)) out.calDate = cd;
            else errors.push('Calibration date must be YYYY-MM-DD.');
        }
        if (Object.prototype.hasOwnProperty.call(g, 'note')) out.note = str(g.note, 200);
        if (!out.type) out.type = 'quartz';
        ['serial', 'note'].forEach(function (k) { if (out[k] == null) out[k] = ''; });
        ['range', 'resolution', 'accuracy', 'depth', 'calDate'].forEach(function (k) { if (out[k] === undefined) out[k] = null; });
        return { gauge: out, errors: errors };
    }

    function listGauges() { return clone(ft().gauges) || []; }

    function setGauge(g) {
        var f = ft();
        if (!g || typeof g !== 'object') return { ok: false, errors: ['No gauge given.'] };
        var idx = -1;
        if (g.id != null) for (var i = 0; i < f.gauges.length; i++) if (f.gauges[i].id === String(g.id)) { idx = i; break; }
        var r = normGauge(g, idx >= 0 ? f.gauges[idx] : null);
        if (r.errors.length) return { ok: false, errors: r.errors };
        var rec = r.gauge;
        rec.id = idx >= 0 ? f.gauges[idx].id : (g.id != null && str(g.id, 40) ? str(g.id, 40) : newId('g', f.gauges));
        if (idx >= 0) f.gauges[idx] = rec; else f.gauges.push(rec);
        if (g.primary === true || !f.primaryGauge || !f.gauges.some(function (x) { return x.id === f.primaryGauge; })) f.primaryGauge = rec.id;
        save();
        dispatch('prism:gauges-changed', { id: rec.id, action: idx >= 0 ? 'update' : 'add' });
        return { ok: true, gauge: clone(rec), errors: [] };
    }

    function removeGauge(id) {
        var f = ft(), n = f.gauges.length;
        f.gauges = f.gauges.filter(function (x) { return x.id !== String(id); });
        if (f.gauges.length === n) return false;
        if (f.primaryGauge === String(id)) f.primaryGauge = f.gauges.length ? f.gauges[0].id : null;
        save();
        dispatch('prism:gauges-changed', { id: String(id), action: 'remove' });
        return true;
    }

    function setPrimaryGauge(id) {
        var f = ft();
        if (!f.gauges.some(function (x) { return x.id === String(id); })) return false;
        f.primaryGauge = String(id);
        save();
        dispatch('prism:gauges-changed', { id: String(id), action: 'primary' });
        return true;
    }

    function primaryGauge() {
        var f = ft();
        for (var i = 0; i < f.gauges.length; i++) if (f.gauges[i].id === f.primaryGauge) return clone(f.gauges[i]);
        return f.gauges.length ? clone(f.gauges[0]) : null;
    }

    // Radial flow: p = a + (m/ln10)·ln Δt, so successive readings Δs hours
    // apart differ by (m/ln10)·Δs/Δt. They fall below one resolution step r for
    //   Δt > m·Δs / (ln10 · r)
    // (semilog straight line: Matthews & Russell 1967, Earlougher 1977 eq. 2.4).
    function samplingLimit(m, dtSample, resolution) {
        if (!isPos(m) || !isPos(dtSample) || !isPos(resolution)) return NaN;
        return m * dtSample / (LN10 * resolution);
    }

    // Expected semilog slope m (psi/log cycle) for the analysed period:
    //   m = 162.6 q B μ / (k h)            (Earlougher 1977, eq. 2.5; field units)
    // from the current fit (C4) → the semilog analysis → the physical-model
    // parameters in PRiSM_state.phys.
    function expectedSlope(ad) {
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        w = w || {};
        var pseudo = !!(ad && ad.pseudo);
        var q = (ad && isPos(ad.qRef)) ? ad.qRef : (isPos(w.q) ? w.q : null);
        function fromKh(kh, src) {
            if (pseudo || !isPos(kh) || !isPos(q) || !isPos(w.B) || !isPos(w.mu)) return null;
            return { m: 162.6 * q * w.B * w.mu / kh, source: src, kh: kh, q: q, B: w.B, mu: w.mu };
        }
        var fit = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { fit = G.PRiSM_getLastFit(); } catch (e) { fit = null; } }
        if (fit && !fit.stale && fit.phys) {
            var kh = isPos(fit.phys.kh) ? fit.phys.kh : (isPos(fit.phys.k) && isPos(w.h) ? fit.phys.k * w.h : null);
            var r = fromKh(kh, 'fit');
            if (r) return r;
        }
        var sl = st().semilog;
        if (sl && sl.ok !== false && isPos(sl.m) && !pseudo) return { m: sl.m, source: 'semilog', kh: sl.kh || null };
        var ph = st().phys;
        if (ph && isPos(ph.k) && isPos(w.h)) {
            var r2 = fromKh(ph.k * w.h, 'model');
            if (r2) return r2;
        }
        return { m: null, source: pseudo ? 'gas-pseudo' : 'none' };
    }

    // Bourdet differentiation window of point i on ln x with smoothing L
    // (Bourdet, Ayoub & Pirard 1989): the nearest points at least L away in
    // ln x on each side (the immediate neighbours when L = 0).
    function bourdetWindow(lx, i, L) {
        var n = lx.length, i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
            while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
        }
        return [i1, i2];
    }

    // opts: {gauge, resolution, L, period, adata, refDate}
    function gaugeResolutionCheck(opts) {
        opts = opts || {};
        var g = opts.gauge || primaryGauge();
        var res = isPos(opts.resolution) ? opts.resolution : (g && isPos(g.resolution) ? g.resolution : null);
        var out = { ok: false, gauge: g ? clone(g) : null, resolution: res, warnings: [], checks: [] };
        if (!isPos(res)) {
            out.reason = g ? 'The primary gauge has no resolution: enter it in the gauge register.' : 'No gauge in the register: add the gauge used for the analysis.';
            return out;
        }
        var ad = opts.adata || analysisData(opts);
        if (!ad || !ad.ok) { out.reason = (ad && ad.reason) || 'No analysis data.'; return out; }
        var n = ad.t.length;
        var lx = (ad.lnx && ad.lnx.length === n) ? ad.lnx : ad.x.map(function (v) { return Math.log(v); });
        var L = isNum(ad.L) ? ad.L : 0.1;
        var P = (ad.p && ad.p.length === n) ? ad.p : ad.dp;     // absolute psia (dp only as a fallback)
        var points = [], nBelow = 0;
        for (var i = 1; i < n - 1; i++) {
            var w = bourdetWindow(lx, i, L);
            var dpWin = Math.abs(P[w[1]] - P[w[0]]);
            if (!isNum(dpWin)) continue;
            var below = dpWin < res;
            if (below) nBelow++;
            points.push({ i: i, t: ad.t[i], deriv: ad.deriv ? ad.deriv[i] : NaN, dpWin: dpWin, relErr: dpWin > 0 ? res / dpWin : Infinity, below: below });
        }
        // Late-time run: the trailing contiguous block of below-resolution points.
        var flagged = [];
        for (var k = points.length - 1; k >= 0 && points[k].below; k--) flagged.unshift(points[k].i);
        out.ok = true;
        out.L = L;
        out.n = n;
        out.points = points;
        out.nBelow = nBelow;
        out.flagged = flagged;
        out.tFlagStart = flagged.length ? ad.t[flagged[0]] : null;
        out.tStart = ad.tStart;
        out.testType = ad.testType;
        // Expected-slope check.
        var ms = expectedSlope(ad);
        out.m = ms.m;
        out.mSource = ms.source;
        var span = L > 0 ? 2 * L : median(points.map(function (p) {
            var ww = bourdetWindow(lx, p.i, 0); return lx[ww[1]] - lx[ww[0]];
        }));
        out.windowLn = span;
        if (isPos(ms.m)) {
            // Radial flow: pressure change across the derivative window = m·Δln x / ln10.
            out.windowChange = ms.m * span / LN10;
            out.ratio = out.windowChange / res;
            // Conservative engineering threshold (open decision): the resolution
            // step is ≤ 10 % of the window change → derivative error ≤ ~10 %.
            out.verdict = out.ratio >= 10 ? 'ok' : (out.ratio >= 1 ? 'marginal' : 'unresolved');
            var dts = [];
            for (var j = Math.max(1, n - 10); j < n; j++) dts.push(ad.t[j] - ad.t[j - 1]);
            out.dtSample = median(dts);
            out.tLimit = samplingLimit(ms.m, out.dtSample, res);
            if (isNum(out.tLimit) && out.tLimit < ad.t[n - 1]) {
                out.warnings.push('After Δt ≈ ' + fmt(out.tLimit, 3) + ' h successive readings (every ' + fmt(out.dtSample * 3600, 3) +
                                  ' s) change by less than the gauge resolution in radial flow.');
            }
        } else {
            out.verdict = null;
            out.warnings.push(ms.source === 'gas-pseudo'
                ? 'Gas pseudo-pressure analysis: the expected slope is not in psi, so only the data check is made.'
                : 'No fit, semilog line or model permeability yet: only the data check is made.');
        }
        if (flagged.length) {
            out.warnings.push(flagged.length + ' late-time derivative point' + (flagged.length > 1 ? 's' : '') + ' (Δt ≥ ' + fmt(out.tFlagStart, 3) +
                              ' h) change by less than the ' + fmt(res, 3) + ' psi gauge resolution across the derivative window: treat their derivative as noise.');
        }
        // Range and calibration checks.
        var pMax = -Infinity, ds = G.PRiSM_dataset;
        if (ds && isArr(ds.p)) for (var q = 0; q < ds.p.length; q++) if (isNum(+ds.p[q]) && +ds.p[q] > pMax) pMax = +ds.p[q];
        if (g && isPos(g.range) && isNum(pMax)) {
            out.pMax = pMax;
            out.checks.push({ key: 'range', ok: pMax <= g.range, text: 'Maximum pressure ' + fmt(pMax, 5) + ' psia vs gauge range ' + fmt(g.range, 5) + ' psi' });
        }
        if (g && g.calDate) {
            var ref = parseClock(opts.refDate) || (isNum(ft().clockZero) ? ft().clockZero : now());
            var age = (ref - parseClock(g.calDate)) / 86400000;
            out.calAgeDays = age;
            // Conservative choice (open decision): calibration older than 12 months is flagged.
            out.checks.push({ key: 'calibration', ok: age <= 365 && age >= 0, text: 'Calibrated ' + g.calDate + ' (' + Math.round(age) + ' days before the test)' });
        }
        return out;
    }

    // =========================================================================
    // SECTION 3 — R13 SEQUENCE-OF-EVENTS LOG
    // =========================================================================

    var EVENT_TYPES = {
        open: 'Open / flow start', close: 'Close / shut-in', choke: 'Choke or rate change', rate: 'Rate measurement',
        sampling: 'Sampling', 'gauge-in': 'Gauge run in', 'gauge-out': 'Gauge pulled', note: 'Note'
    };
    var EVENT_ALIASES = {
        'tool-open': 'open', 'well-open': 'open', flow: 'open', 'flow-start': 'open', start: 'open',
        'tool-close': 'close', 'well-close': 'close', 'shut-in': 'close', shutin: 'close', shut: 'close',
        'choke-change': 'choke', 'rate-change': 'choke', 'gauge-run': 'gauge-in', 'gauge-pull': 'gauge-out',
        sample: 'sampling', comment: 'note'
    };
    var EVENT_COLORS = { open: '#3fb950', close: '#f85149', choke: '#f0883e', rate: '#d29922', sampling: '#58a6ff', 'gauge-in': '#a371f7', 'gauge-out': '#a371f7', note: '#8b949e' };
    var EVENT_CAP = 2000;

    function eventType(v) {
        var k = String(v == null ? '' : v).toLowerCase().trim().replace(/[\s_]+/g, '-');
        if (EVENT_TYPES[k]) return k;
        return EVENT_ALIASES[k] || null;
    }
    function sortEvents(list) {
        list.forEach(function (e, i) { e._o = i; });
        list.sort(function (a, b) {
            var ta = isNum(a.t) ? a.t : Infinity, tb = isNum(b.t) ? b.t : Infinity;
            return (ta - tb) || (a._o - b._o);
        });
        list.forEach(function (e) { delete e._o; });
    }

    // evt: {type, t (h) | time (ms / ISO / Date), q?, choke?, label?, note?, gaugeId?, source?, id?}
    function addEvent(evt) {
        if (!evt || typeof evt !== 'object') return null;
        var type = eventType(evt.type);
        if (!type) return null;
        var f = ft();
        var time = parseClock(evt.time);
        var t = num(evt.t);
        if (t == null && time != null && isNum(f.clockZero)) t = (time - f.clockZero) / 3600000;
        var e = {
            type: type,
            t: t,
            time: time,
            q: num(evt.q),
            choke: num(evt.choke),
            label: str(evt.label, 80),
            note: str(evt.note, 200),
            gaugeId: evt.gaugeId != null ? str(evt.gaugeId, 40) : null,
            source: str(evt.source || 'user', 40) || 'user'
        };
        var idx = -1;
        if (evt.id != null) for (var i = 0; i < f.events.length; i++) if (f.events[i].id === String(evt.id)) { idx = i; break; }
        if (idx < 0 && f.events.length >= EVENT_CAP) return null;
        e.id = idx >= 0 ? f.events[idx].id : (evt.id != null && str(evt.id, 40) ? str(evt.id, 40) : newId('e', f.events));
        if (idx >= 0) f.events[idx] = e; else f.events.push(e);
        sortEvents(f.events);
        save();
        dispatch('prism:events-changed', { id: e.id, action: idx >= 0 ? 'update' : 'add', source: e.source });
        redraw();
        return clone(e);
    }

    function listEvents() { return clone(ft().events) || []; }

    function removeEvent(id) {
        var f = ft(), n = f.events.length;
        f.events = f.events.filter(function (x) { return x.id !== String(id); });
        if (f.events.length === n) return false;
        save();
        dispatch('prism:events-changed', { id: String(id), action: 'remove' });
        redraw();
        return true;
    }

    function clearEvents() {
        var f = ft();
        if (!f.events.length) return false;
        f.events = [];
        save();
        dispatch('prism:events-changed', { action: 'clear' });
        redraw();
        return true;
    }

    // Sets the wall-clock time of t = 0 on the dataset clock and places every
    // event that has a wall-clock time.
    function setEventClock(time) {
        var f = ft();
        var ms = parseClock(time);
        if (time != null && time !== '' && ms == null) return false;
        f.clockZero = ms;
        if (ms != null) f.events.forEach(function (e) { if (isNum(e.time)) e.t = (e.time - ms) / 3600000; });
        sortEvents(f.events);
        save();
        dispatch('prism:events-changed', { action: 'clock' });
        redraw();
        return true;
    }

    // Rate schedule from the events: open → the event's rate (or the first rate
    // measured before the next close), choke / rate → the new rate, close → 0.
    // Consecutive equal rates are merged. Rows are the multi-rate table's
    // {t (h), q} step starts (C2 rate history).
    function eventsToRateSchedule(events) {
        var list = isArr(events) ? Array.prototype.slice.call(events).map(function (e) {
            return { type: eventType(e.type), t: num(e.t), q: num(e.q) };
        }) : listEvents();
        var warnings = [];
        var placed = list.filter(function (e) { return e.type && isNum(e.t); });
        var unplaced = list.length - placed.length;
        if (unplaced > 0) warnings.push(unplaced + ' event' + (unplaced > 1 ? 's have' : ' has') + ' no time on the dataset clock and ' + (unplaced > 1 ? 'were' : 'was') + ' ignored: set the clock zero or enter t.');
        placed.sort(function (a, b) { return a.t - b.t; });
        var rows = [], open = false, qCur = 0, used = 0;
        function push(t, q) {
            if (rows.length && Math.abs(rows[rows.length - 1].t - t) < 1e-9) rows.pop();
            if (rows.length ? rows[rows.length - 1].q === q : q === 0) { qCur = q; return; }
            rows.push({ t: t, q: q });
            qCur = q;
        }
        for (var i = 0; i < placed.length; i++) {
            var e = placed[i];
            if (e.type === 'open') {
                var q = e.q;
                if (q == null) {
                    for (var j = i + 1; j < placed.length; j++) {
                        if (placed[j].type === 'close' || placed[j].type === 'open') break;
                        if ((placed[j].type === 'rate' || placed[j].type === 'choke') && placed[j].q != null) { q = placed[j].q; break; }
                    }
                }
                open = true;
                if (q == null) { warnings.push('Open at t = ' + fmt(e.t, 4) + ' h has no rate and no later rate before the next close: add a rate to seed this period.'); continue; }
                push(e.t, q); used++;
            } else if (e.type === 'choke' || e.type === 'rate') {
                if (e.q == null) continue;
                if (!open) {
                    if (e.q === 0) continue;
                    warnings.push('A rate at t = ' + fmt(e.t, 4) + ' h comes before any open event: it is taken as the flow start.');
                    open = true;
                }
                push(e.t, e.q); used++;
            } else if (e.type === 'close') {
                if (!open && qCur === 0) continue;
                open = false;
                push(e.t, 0); used++;
            }
        }
        var any = rows.some(function (r) { return r.q !== 0; });
        return { ok: any, rows: rows, warnings: warnings, used: used, reason: any ? null : 'The events give no flowing rate: add open / rate events with rates.' };
    }

    function persistMultiRate(rows) {
        try {
            var ls = G.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (ls) ls.setItem('wts_prism_mrate', JSON.stringify(rows || []));
        } catch (e) { /* quota / private mode */ }
    }

    // Writes the schedule into the multi-rate table (PRiSM.multiRate), which
    // PRiSM_rateHistory / PRiSM_getAnalysisData use as the rate history. The
    // change goes on the workflow undo stack (PRiSM_undo restores the table).
    function seedPeriodsFromEvents(opts) {
        opts = opts || {};
        var r = eventsToRateSchedule(opts.events);
        if (!r.ok) return { ok: false, reason: r.reason, rows: r.rows, warnings: r.warnings };
        if (typeof G.PRiSM_recordSnapshot === 'function') { try { G.PRiSM_recordSnapshot('before-seed-events'); } catch (e) { /* optional */ } }
        if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
        G.PRiSM.multiRate = r.rows.map(function (x) { return { t: x.t, q: x.q }; });
        persistMultiRate(G.PRiSM.multiRate);
        try { if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows(); } catch (e) { /* host-scope editor absent */ }   // eslint-disable-line no-undef
        var s = st();
        s.activePeriod = null;                      // period indices changed: re-select automatically
        ft().lastSeed = { at: now(), rows: r.rows.length };
        save();
        dispatch('prism:period-changed', { source: 'events', period: null });
        redraw();
        var undoable = (typeof G.PRiSM_canUndo === 'function') ? !!G.PRiSM_canUndo() : false;
        return { ok: true, rows: clone(r.rows), warnings: r.warnings, undoable: undoable };
    }

    // =========================================================================
    // SECTION 4 — R15 TOTAL-COMPRESSIBILITY BUILDER
    // =========================================================================
    //
    // ct = So·co + Sw·cw + Sg·cg + cf      (Earlougher 1977 eq. 2.25;
    //                                       Ramey 1964)
    // Rock (pore-volume) compressibility cf, φ as a fraction, 1/psi:
    //   Hall (1953), consolidated rock:  cf = 1.782e-6 / φ^0.438
    //   Newman (1973), consolidated sandstone: cf = 97.32e-6 / (1 + 55.8721 φ)^1.42859
    //   Newman (1973), limestone:              cf = 0.853531 / (1 + 2.47664e6 φ)^0.92990
    //   (Hall, Trans. AIME 198, 1953, p. 309; Newman, JPT Feb 1973, pp. 129-134;
    //    coefficients as tabulated in Ahmed, Reservoir Engineering Handbook, ch. 4.)
    // co: Vasquez-Beggs (1980), above Pb; cw: Osif (1988) with the
    // Dodson-Standing dissolved-gas factor; cg: real-gas 1/p − (1/Z)dZ/dp with
    // DAK Z — all from the 16-pvt correlation library.

    var CF_METHODS = {
        hall: 'Hall (1953)',
        'newman-sandstone': 'Newman (1973) consolidated sandstone',
        'newman-limestone': 'Newman (1973) limestone',
        user: 'Entered value'
    };

    function rockCompressibility(phi, method) {
        if (!(isNum(phi) && phi > 0 && phi < 1)) return NaN;
        method = method || 'hall';
        if (method === 'newman-sandstone') return 97.32e-6 / Math.pow(1 + 55.8721 * phi, 1.42859);
        if (method === 'newman-limestone') return 0.853531 / Math.pow(1 + 2.47664e6 * phi, 0.92990);
        if (method === 'hall') return 1.782e-6 / Math.pow(phi, 0.438);
        return NaN;
    }

    function corr() { return G.PRiSM_pvt_correlations || {}; }

    // input (all optional): fluid, So, Sw, Sg, co, cw, cg, cf, cfMethod, phi, p, T, API, SG_g, Rs, Rsw
    function ctBuild(input) {
        input = input || {};
        var s = G.PRiSM_pvt || {};
        var prov = s.provenance || {};
        var comp = s._computed || {};
        if ((!comp || !comp.timestamp) && typeof G.PRiSM_pvt_compute === 'function') { try { comp = G.PRiSM_pvt_compute() || {}; } catch (e) { comp = {}; } }
        var C = corr();
        var warnings = [], defaulted = [], sources = {};
        var fluid = (input.fluid === 'oil' || input.fluid === 'gas' || input.fluid === 'water') ? input.fluid : (s.fluidType || 'oil');
        function isDefault(key) { var p = prov[key]; return !p || p === 'default'; }
        // Store value with provenance; `need` marks it as used.
        function fromStore(inKey, storeKey) {
            var v = num(input[inKey]);
            if (v != null) { sources[inKey] = 'input'; return v; }
            v = num(s[storeKey]);
            if (v == null) return null;
            sources[inKey] = isDefault(storeKey) ? 'default' : (prov[storeKey] || 'user');
            if (sources[inKey] === 'default' && defaulted.indexOf(inKey) < 0) defaulted.push(inKey);
            return v;
        }
        var p = fromStore('p', 'p_res');
        var T = fromStore('T', 'T_res');

        // Saturations.
        var Sw = num(input.Sw), So = num(input.So), Sg = num(input.Sg);
        if (fluid === 'water') {
            if (Sw == null) { Sw = 1; sources.Sw = 'fluid'; } else sources.Sw = 'input';
            if (So == null) So = 0; if (Sg == null) Sg = 0;
        } else {
            if (Sw == null) Sw = fromStore('Sw', 'Sw'); else sources.Sw = 'input';
            if (Sw == null) return { ok: false, reason: 'Water saturation Sw is required.' };
            if (fluid === 'gas') {
                if (So == null) So = 0;
                if (Sg == null) { Sg = 1 - Sw - So; sources.Sg = 'balance'; } else sources.Sg = 'input';
            } else {
                if (Sg == null) {
                    Sg = 0; sources.Sg = 'assumed';
                    if (isNum(comp.Pb) && isNum(p) && p < comp.Pb) warnings.push('Reservoir pressure is below the bubble point (' + fmt(comp.Pb, 4) + ' psia): enter the free-gas saturation Sg; 0 is assumed.');
                } else sources.Sg = 'input';
                if (So == null) { So = 1 - Sw - Sg; sources.So = 'balance'; } else sources.So = 'input';
            }
        }
        var sum = So + Sw + Sg;
        if (!(So >= 0 && Sw >= 0 && Sg >= 0 && So <= 1 && Sw <= 1 && Sg <= 1) || Math.abs(sum - 1) > 0.005) {
            return { ok: false, reason: 'Saturations must lie in [0, 1] and add up to 1 (So + Sw + Sg = ' + fmt(sum, 4) + ').' };
        }

        // Phase compressibilities.
        var co = null, cw = null, cg = null;
        if (So > 0) {
            co = num(input.co);
            if (co != null) sources.co = 'input';
            else if (num(s.co) != null && !isDefault('co')) { co = s.co; sources.co = prov.co; }
            else if (typeof C.co_vasquezBeggs === 'function') {
                var API = fromStore('API', 'API'), SG = fromStore('SG_g', 'SG_g');
                var Rs = num(input.Rs);
                if (Rs == null) Rs = (num(s.Rs) != null) ? fromStore('Rs', 'Rs') : (isNum(comp.Rs) ? comp.Rs : null);
                if (Rs != null && sources.Rs == null) sources.Rs = 'correlation';
                co = C.co_vasquezBeggs(API, SG, Rs, p, T);
                sources.co = 'correlation';
                if (isNum(comp.Pb) && isNum(p) && p < comp.Pb) warnings.push('Vasquez-Beggs co applies above the bubble point only.');
            }
            if (!isPos(co)) return { ok: false, reason: 'Oil compressibility co could not be found: enter it.' };
        }
        if (Sw > 0) {
            cw = num(input.cw);
            if (cw != null) sources.cw = 'input';
            else if (num(s.cw) != null && !isDefault('cw')) { cw = s.cw; sources.cw = prov.cw; }
            else if (typeof C.cw_dodson === 'function') {
                var Rsw = num(input.Rsw); if (Rsw == null) Rsw = fromStore('Rsw', 'Rsw');
                cw = C.cw_dodson(p, T, Rsw);
                sources.cw = 'correlation';
            }
            if (!isPos(cw)) return { ok: false, reason: 'Water compressibility cw could not be found: enter it.' };
        }
        if (Sg > 0) {
            cg = num(input.cg);
            if (cg != null) sources.cg = 'input';
            else if (num(s.cg) != null && !isDefault('cg')) { cg = s.cg; sources.cg = prov.cg; }
            else if (typeof C.cg_realGas === 'function' && typeof C.Z_dranchukAbouKassem === 'function') {
                var SGg = fromStore('SG_g', 'SG_g');
                var Tpc = C.Tpc_sutton(SGg), Ppc = C.Ppc_sutton(SGg);
                var Z = (fluid === 'gas' && isNum(comp.z)) ? comp.z : C.Z_dranchukAbouKassem((T + 459.67) / Tpc, p / Ppc);
                cg = C.cg_realGas(p, T, Z, SGg);
                sources.cg = 'correlation';
            }
            if (!isPos(cg)) return { ok: false, reason: 'Gas compressibility cg could not be found: enter it.' };
        }

        // Rock compressibility.
        var method = CF_METHODS[input.cfMethod] ? input.cfMethod : (num(input.cf) != null ? 'user' : 'hall');
        var cf = null, phi = null;
        if (method === 'user') {
            cf = num(input.cf);
            if (cf == null) { cf = fromStore('cf', 'cf'); }
            else sources.cf = 'input';
        } else {
            phi = fromStore('phi', 'phi');
            cf = rockCompressibility(phi, method);
            sources.cf = 'correlation';
            if (isNum(phi) && (phi < 0.02 || phi > 0.35)) warnings.push('Porosity ' + fmt(phi, 3) + ' is outside the range of the rock-compressibility data (≈ 0.02-0.35).');
        }
        if (!(isNum(cf) && cf >= 0)) return { ok: false, reason: 'Rock compressibility cf could not be found: enter φ or cf.' };

        var terms = {
            oil: So > 0 ? So * co : 0,
            water: Sw > 0 ? Sw * cw : 0,
            gas: Sg > 0 ? Sg * cg : 0,
            rock: cf
        };
        var ct = terms.oil + terms.water + terms.gas + terms.rock;
        // Only the base inputs that fed a used term count as "defaulted".
        var used = { p: 1, T: 1 };
        if (So > 0 && sources.co === 'correlation') { used.API = 1; used.SG_g = 1; used.Rs = 1; }
        if (Sw > 0 && sources.cw === 'correlation') used.Rsw = 1;
        if (Sg > 0 && sources.cg === 'correlation') used.SG_g = 1;
        if (fluid !== 'water' && sources.Sw !== 'input') used.Sw = 1;
        if (method !== 'user') used.phi = 1; else used.cf = 1;
        if (!(So > 0 && sources.co === 'correlation') && !(Sw > 0 && sources.cw === 'correlation') && !(Sg > 0 && sources.cg === 'correlation')) { delete used.p; delete used.T; }
        defaulted = defaulted.filter(function (k) { return used[k]; });
        return {
            ok: true, ct: ct, fluid: fluid, terms: terms,
            inputs: { So: So, Sw: Sw, Sg: Sg, co: co, cw: cw, cg: cg, cf: cf, phi: phi, p: p, T: T },
            sources: sources, cfMethod: method, cfMethodLabel: CF_METHODS[method],
            defaulted: defaulted, isDefaulted: defaulted.length > 0, warnings: warnings
        };
    }

    // Writes ct to the well store (C1) with provenance 'correlation'.
    function ctApply(result) {
        var r = result || ctBuild(ft().ctInput || {});
        if (!r || !r.ok || !isPos(r.ct)) return { ok: false, reason: (r && r.reason) || 'No ct result.' };
        if (typeof G.PRiSM_setWell !== 'function') return { ok: false, reason: 'Well store (PRiSM_setWell) not loaded.' };
        ft().ctBuild = { ct: r.ct, at: now(), defaulted: (r.defaulted || []).slice(), cfMethod: r.cfMethod, terms: clone(r.terms), inputs: clone(r.inputs) };
        save();
        G.PRiSM_setWell({ ct: r.ct }, { source: 'correlation', origin: 'ct-builder' });
        return { ok: true, ct: r.ct, defaulted: (r.defaulted || []).slice(), isDefaulted: !!r.isDefaulted };
    }

    // =========================================================================
    // SECTION 5 — POST-DRAW HOOK: event markers + resolution flags (C6/C7)
    // =========================================================================

    var _chkCache = { key: null, res: null };
    function checkForPlot(data) {
        var g = primaryGauge();
        if (!g || !isPos(g.resolution)) return null;
        var t = data && data.t, dp = data && data.dp;
        var n = t ? t.length : 0;
        var key = [n, n ? t[0] : 0, n ? t[n - 1] : 0, dp && n ? dp[0] : 0, dp && n ? dp[n - 1] : 0,
                   g.id, g.resolution, st().bourdetL, st().activePeriod, G.PRiSM_datasetHash ? G.PRiSM_datasetHash() : ''].join('|');
        if (_chkCache.key === key) return _chkCache.res;
        var r = null;
        try { r = gaugeResolutionCheck({ gauge: g }); } catch (e) { r = null; }
        _chkCache = { key: key, res: r };
        return r;
    }

    function tStartFor(plotKey) {
        if (plotKey === 'cartesian') return 0;
        var ad = analysisData();
        return (ad && ad.ok && isNum(ad.tStart)) ? ad.tStart : null;
    }

    var EVENT_PLOTS = { cartesian: 1, bourdet: 1, mdh: 1 };

    function fieldToolsPostDraw(info) {
        if (!info || !info.canvas || typeof info.canvas.getContext !== 'function') return;
        var ax = info.axes || info.canvas._prismAxes;
        if (!ax || typeof ax.toX !== 'function' || !ax.plot) return;
        var plotKey = info.plotKey || st().activePlot;
        var ctx;
        try { ctx = info.canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return;
        var plot = ax.plot;
        var sx = ax.scaleX || {};
        var xMin = isNum(sx.min) ? Math.min(sx.min, sx.max) : -Infinity, xMax = isNum(sx.max) ? Math.max(sx.min, sx.max) : Infinity;
        ctx.save();
        try {
            // Event markers.
            var evs = ft().events.filter(function (e) { return isNum(e.t); });
            if (EVENT_PLOTS[plotKey] && evs.length) {
                var t0 = tStartFor(plotKey);
                if (t0 != null) {
                    ctx.font = '10px sans-serif';
                    ctx.textBaseline = 'top';
                    evs.forEach(function (e, k) {
                        var x = e.t - t0;
                        if (sx.kind === 'log' && !(x > 0)) return;
                        if (x < xMin || x > xMax) return;
                        var px = ax.toX(x);
                        if (!isNum(px) || px < plot.x - 1 || px > plot.x + plot.w + 1) return;
                        var col = EVENT_COLORS[e.type] || '#8b949e';
                        ctx.strokeStyle = col;
                        ctx.lineWidth = 1;
                        if (ctx.setLineDash) ctx.setLineDash([2, 3]);
                        ctx.beginPath(); ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h); ctx.stroke();
                        if (ctx.setLineDash) ctx.setLineDash([]);
                        ctx.fillStyle = col;
                        var lbl = e.label || EVENT_TYPES[e.type] || e.type;
                        ctx.fillText(String(lbl).slice(0, 18), px + 3, plot.y + 3 + (k % 3) * 11);
                    });
                }
            }
            // Resolution flags on the log-log diagnostic plot.
            if (plotKey === 'bourdet' && typeof ax.toY === 'function') {
                var r = checkForPlot(info.data);
                if (r && r.ok && r.nBelow > 0) {
                    var late = {};
                    r.flagged.forEach(function (i) { late[i] = 1; });
                    r.points.forEach(function (pt) {
                        if (!pt.below || !(pt.t > 0)) return;
                        var px = ax.toX(pt.t);
                        var py = (isPos(pt.deriv)) ? ax.toY(pt.deriv) : plot.y + plot.h - 5;
                        if (!isNum(px) || !isNum(py) || px < plot.x || px > plot.x + plot.w) return;
                        py = Math.max(plot.y + 4, Math.min(plot.y + plot.h - 4, py));
                        ctx.strokeStyle = late[pt.i] ? '#f85149' : 'rgba(248,81,73,0.45)';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.stroke();
                    });
                    ctx.fillStyle = '#f85149';
                    ctx.font = '11px sans-serif';
                    ctx.textBaseline = 'top';
                    ctx.fillText('⚠ ' + r.nBelow + ' derivative point' + (r.nBelow > 1 ? 's' : '') + ' below gauge resolution (' + fmt(r.resolution, 3) + ' psi)',
                                 plot.x + 6, plot.y + plot.h - 18);
                }
            }
        } catch (e) { /* drawing is best-effort */ }
        ctx.restore();
    }
    fieldToolsPostDraw._prismId = 'fieldtools-markers';

    (function registerHook() {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fieldToolsPostDraw._prismId) { hooks[i] = fieldToolsPostDraw; return; }
        hooks.push(fieldToolsPostDraw);
    })();

    // =========================================================================
    // SECTION 6 — PANELS (C7)
    // =========================================================================

    var STYLE_ID = 'prism_ft_style';
    var CSS = [
        '.prism-ft { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-ft-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; }',
        '.prism-ft-grid label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text2); }',
        '.prism-ft input, .prism-ft select { width:100%; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 7px; font:inherit; font-size:12.5px; }',
        '.prism-ft-tw { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-ft table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-ft th, .prism-ft td { padding:5px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-ft th { color:var(--text2); font-weight:600; font-size:11px; }',
        '.prism-ft td.num { text-align:right; font-variant-numeric:tabular-nums; }',
        '.prism-ft-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }',
        '.prism-ft-btn { appearance:none; background:var(--bg3, var(--bg2)); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 10px; font:inherit; font-size:12px; cursor:pointer; min-height:32px; }',
        '.prism-ft-btn:hover { border-color:var(--accent); }',
        '.prism-ft-btn--primary { background:var(--accent); border-color:var(--accent); color:#111; font-weight:700; }',
        '.prism-ft-msg { line-height:1.45; padding:6px 9px; border-radius:4px; border-left:3px solid var(--blue); background:var(--bg2); }',
        '.prism-ft-msg--ok { border-left-color:var(--green); }',
        '.prism-ft-msg--warn { border-left-color:var(--yellow); }',
        '.prism-ft-msg--bad { border-left-color:var(--red); }',
        '.prism-ft-hint { font-size:11px; color:var(--text3); line-height:1.4; }'
    ].join('\n');
    function ensureStyle() {
        if (!D || !D.createElement || $(STYLE_ID)) return;
        try {
            var s = D.createElement('style');
            s.id = STYLE_ID;
            s.textContent = CSS;
            var parent = D.head || D.body || D.documentElement;
            if (parent) parent.appendChild(s);
        } catch (e) { /* ignore */ }
    }
    function val(id) { var e = $(id); return e ? e.value : ''; }
    function msg(kind, text) { return '<div class="prism-ft-msg prism-ft-msg--' + kind + '">' + text + '</div>'; }
    function field(id, label, value, type, extra) {
        return '<label>' + esc(label) + '<input id="' + id + '" type="' + (type || 'number') + '" step="any" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '></label>';
    }
    function rerender(rootId, fn) {
        var root = $(rootId);
        if (root && root.parentNode) { try { fn(root.parentNode); } catch (e) { /* ignore */ } }
    }

    // ── Gauge register (Tab 1) ───────────────────────────────────────────────
    function renderGaugeRegister(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var h = '<div class="prism-ft" id="prism_ft_gauges_root">';
        if (f.gauges.length) {
            h += '<div class="prism-ft-tw"><table><thead><tr><th>Primary</th><th>Serial</th><th>Type</th><th>Range (psi)</th><th>Resolution (psi)</th><th>Accuracy (psi)</th><th>Calibrated</th><th>Depth (ft)</th><th></th></tr></thead><tbody>';
            f.gauges.forEach(function (g) {
                var prim = g.id === (primaryGauge() || {}).id;
                h += '<tr><td><input type="radio" name="prism_ft_primary" data-ft-primary="' + esc(g.id) + '"' + (prim ? ' checked' : '') + ' aria-label="Primary gauge ' + esc(g.serial || g.id) + '"></td>' +
                     '<td>' + esc(g.serial || '—') + '</td><td>' + esc(GAUGE_TYPES[g.type] || g.type) + '</td>' +
                     '<td class="num">' + fmt(g.range, 5) + '</td><td class="num">' + fmt(g.resolution, 3) + '</td><td class="num">' + fmt(g.accuracy, 3) + '</td>' +
                     '<td>' + esc(g.calDate || '—') + '</td><td class="num">' + fmt(g.depth, 5) + '</td>' +
                     '<td><button type="button" class="prism-ft-btn" data-ft-rmgauge="' + esc(g.id) + '" aria-label="Remove gauge ' + esc(g.serial || g.id) + '">×</button></td></tr>';
            });
            h += '</tbody></table></div>';
        } else {
            h += '<div class="prism-ft-hint">No gauges yet. Add the gauge whose data you analyse; its resolution is checked against the expected semilog slope and the late-time data.</div>';
        }
        var types = Object.keys(GAUGE_TYPES).map(function (k) { return '<option value="' + k + '">' + GAUGE_TYPES[k] + '</option>'; }).join('');
        h += '<div class="prism-ft-grid">' +
             field('prism_ft_g_serial', 'Serial', '', 'text') +
             '<label>Type<select id="prism_ft_g_type">' + types + '</select></label>' +
             field('prism_ft_g_range', 'Range (psi)', '') +
             field('prism_ft_g_res', 'Resolution (psi)', '') +
             field('prism_ft_g_acc', 'Accuracy (psi)', '') +
             field('prism_ft_g_cal', 'Calibration date (YYYY-MM-DD)', '', 'text') +
             field('prism_ft_g_depth', 'Depth (ft MD)', '') +
             '</div><div class="prism-ft-row"><button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_g_add">Add gauge</button>' +
             '<span id="prism_ft_g_msg" class="prism-ft-hint"></span></div>';
        var chk = gaugeResolutionCheck();
        h += '<div id="prism_ft_g_check">' + checkSummaryHTML(chk) + '</div>';
        h += '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_gauges_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute) return;
            var rm = t.getAttribute('data-ft-rmgauge');
            if (rm) { removeGauge(rm); return; }
            var pr = t.getAttribute('data-ft-primary');
            if (pr) { setPrimaryGauge(pr); return; }
            if (t.id === 'prism_ft_g_add') {
                var r = setGauge({
                    serial: val('prism_ft_g_serial'), type: val('prism_ft_g_type') || 'quartz',
                    range: val('prism_ft_g_range'), resolution: val('prism_ft_g_res'), accuracy: val('prism_ft_g_acc'),
                    calDate: val('prism_ft_g_cal'), depth: val('prism_ft_g_depth')
                });
                if (!r.ok) { var m = $('prism_ft_g_msg'); if (m) m.textContent = r.errors.join(' '); }
            }
        });
    }

    function checkSummaryHTML(chk) {
        if (!chk) return '';
        if (!chk.ok) return msg('warn', esc(chk.reason || 'Resolution check unavailable.'));
        var h = '';
        var g = chk.gauge || {};
        if (isPos(chk.m)) {
            var kind = chk.verdict === 'ok' ? 'ok' : (chk.verdict === 'marginal' ? 'warn' : 'bad');
            var mark = chk.verdict === 'ok' ? '✓' : (chk.verdict === 'marginal' ? '⚠' : '✗');
            h += msg(kind, mark + ' Expected semilog slope m = ' + fmt(chk.m, 4) + ' psi/cycle (' + esc(chk.mSource) + '): the derivative window (' +
                     fmt(chk.windowLn, 3) + ' in ln t) spans ' + fmt(chk.windowChange, 3) + ' psi = ' + fmt(chk.ratio, 3) + ' × the ' +
                     fmt(chk.resolution, 3) + ' psi resolution' + (g.serial ? ' of gauge ' + esc(g.serial) : '') + '.');
        }
        if (chk.flagged.length) h += msg('bad', '✗ ' + esc(chk.warnings.filter(function (w) { return /late-time/.test(w); })[0] || ''));
        else h += msg('ok', '✓ No late-time derivative point changes by less than the gauge resolution (' + chk.nBelow + ' of ' + chk.points.length + ' points below overall).');
        chk.warnings.forEach(function (w) { if (!/late-time/.test(w)) h += msg('warn', '⚠ ' + esc(w)); });
        chk.checks.forEach(function (c) { h += msg(c.ok ? 'ok' : 'warn', (c.ok ? '✓ ' : '⚠ ') + esc(c.text)); });
        h += '<div class="prism-ft-hint">Flag rule: a derivative point is below resolution when the pressure change across its Bourdet window is smaller than one resolution step. ' +
             'The ✓ threshold (window change ≥ 10 × resolution, derivative error ≲ 10 %) is an engineering choice.</div>';
        return h;
    }

    // ── Resolution check (Tab 2, Diagnose) ───────────────────────────────────
    function renderGaugeCheckPanel(host) {
        if (!host) return;
        ensureStyle();
        host.innerHTML = '<div class="prism-ft" id="prism_ft_gcheck_root">' + checkSummaryHTML(gaugeResolutionCheck()) + '</div>';
    }

    // ── Sequence of events (Tab 1) ───────────────────────────────────────────
    function renderEventsLog(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var h = '<div class="prism-ft" id="prism_ft_events_root">';
        h += '<div class="prism-ft-grid">' + field('prism_ft_clock', 'Clock at t = 0 (UTC, YYYY-MM-DD HH:MM)', clockText(f.clockZero), 'text') +
             '<label>&nbsp;<button type="button" class="prism-ft-btn" id="prism_ft_clock_set">Set clock</button></label></div>';
        if (f.events.length) {
            h += '<div class="prism-ft-tw"><table><thead><tr><th>t (h)</th><th>Clock</th><th>Event</th><th>Rate</th><th>Choke (/64 in)</th><th>Note</th><th>Source</th><th></th></tr></thead><tbody>';
            f.events.forEach(function (e) {
                h += '<tr><td class="num">' + (isNum(e.t) ? fmt(e.t, 5) : '—') + '</td><td>' + esc(clockText(e.time)) + '</td>' +
                     '<td>' + esc(e.label || EVENT_TYPES[e.type] || e.type) + '</td><td class="num">' + fmt(e.q, 5) + '</td><td class="num">' + fmt(e.choke, 3) + '</td>' +
                     '<td>' + esc(e.note) + '</td><td>' + esc(e.source) + '</td>' +
                     '<td><button type="button" class="prism-ft-btn" data-ft-rmevent="' + esc(e.id) + '" aria-label="Remove event">×</button></td></tr>';
            });
            h += '</tbody></table></div>';
        } else {
            h += '<div class="prism-ft-hint">No events yet. Log tool open / close, choke and rate changes, sampling and gauge runs; the history and diagnostic plots show them as markers.</div>';
        }
        var types = Object.keys(EVENT_TYPES).map(function (k) { return '<option value="' + k + '">' + EVENT_TYPES[k] + '</option>'; }).join('');
        h += '<div class="prism-ft-grid">' +
             '<label>Event<select id="prism_ft_e_type">' + types + '</select></label>' +
             field('prism_ft_e_t', 't (h, dataset clock)', '') +
             field('prism_ft_e_time', 'or clock (UTC)', '', 'text') +
             field('prism_ft_e_q', 'Rate (STB/d or Mscf/d)', '') +
             field('prism_ft_e_choke', 'Choke (/64 in)', '') +
             field('prism_ft_e_note', 'Note', '', 'text') +
             '</div><div class="prism-ft-row">' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_e_add">Add event</button>' +
             '<button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_seed">Seed flow periods from events</button>' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_undo"' + ((typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo()) ? '' : ' disabled') + '>Undo</button>' +
             '<button type="button" class="prism-ft-btn" id="prism_ft_e_clear">Clear events</button></div>' +
             '<div id="prism_ft_e_msg"></div>' +
             '<div class="prism-ft-hint">Seeding writes the rate schedule (open → rate, choke / rate change → new rate, close → 0) to the multi-rate table that drives the flow periods; Undo restores the previous table.</div>';
        h += '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_events_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute) return;
            var rm = t.getAttribute('data-ft-rmevent');
            if (rm) { removeEvent(rm); return; }
            var box = $('prism_ft_e_msg');
            if (t.id === 'prism_ft_clock_set') {
                if (!setEventClock(val('prism_ft_clock')) && box) box.innerHTML = msg('bad', '✗ Clock not recognised: use YYYY-MM-DD HH:MM.');
            } else if (t.id === 'prism_ft_e_add') {
                var r = addEvent({ type: val('prism_ft_e_type'), t: val('prism_ft_e_t'), time: val('prism_ft_e_time') || null,
                                   q: val('prism_ft_e_q'), choke: val('prism_ft_e_choke'), note: val('prism_ft_e_note'), source: 'user' });
                if (!r && box) box.innerHTML = msg('bad', '✗ Event not added.');
                else if (r && !isNum(r.t) && box) box.innerHTML = msg('warn', '⚠ Event has no time on the dataset clock: set the clock at t = 0.');
            } else if (t.id === 'prism_ft_seed') {
                var s = seedPeriodsFromEvents();
                var html = s.ok ? msg('ok', '✓ ' + s.rows.length + ' rate step' + (s.rows.length > 1 ? 's' : '') + ' written to the rate history' + (s.undoable ? ' (Undo restores the previous table).' : '.'))
                                : msg('bad', '✗ ' + esc(s.reason));
                (s.warnings || []).forEach(function (w) { html += msg('warn', '⚠ ' + esc(w)); });
                var b2 = $('prism_ft_e_msg');
                if (b2) b2.innerHTML = html;
                var u = $('prism_ft_undo'); if (u) u.disabled = !(typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo());
            } else if (t.id === 'prism_ft_undo') {
                if (typeof G.PRiSM_undo === 'function') G.PRiSM_undo();
            } else if (t.id === 'prism_ft_e_clear') {
                clearEvents();
            }
        });
    }

    // ── ct builder (Tab 1) ───────────────────────────────────────────────────
    function ctInputFromForm() {
        var o = {};
        ['So', 'Sw', 'Sg', 'co', 'cw', 'cg', 'cf', 'phi'].forEach(function (k) {
            var v = num(val('prism_ft_ct_' + k));
            if (v != null) o[k] = v;
        });
        o.cfMethod = val('prism_ft_ct_method') || 'hall';
        if (o.cfMethod !== 'user') delete o.cf;
        return o;
    }
    function ctResultHTML(r) {
        if (!r) return '';
        if (!r.ok) return msg('bad', '✗ ' + esc(r.reason));
        var rows = [
            ['So · co', r.inputs.So, r.inputs.co, r.terms.oil, r.sources.co],
            ['Sw · cw', r.inputs.Sw, r.inputs.cw, r.terms.water, r.sources.cw],
            ['Sg · cg', r.inputs.Sg, r.inputs.cg, r.terms.gas, r.sources.cg],
            ['cf', null, r.inputs.cf, r.terms.rock, r.cfMethodLabel]
        ];
        var h = '<div class="prism-ft-tw"><table><thead><tr><th>Term</th><th>Saturation</th><th>c (1/psi)</th><th>Contribution (1/psi)</th><th>Source</th></tr></thead><tbody>';
        rows.forEach(function (x) {
            h += '<tr><td>' + x[0] + '</td><td class="num">' + fmt(x[1], 3) + '</td><td class="num">' + fmt(x[2], 4) + '</td><td class="num">' + fmt(x[3], 4) + '</td><td>' + esc(x[4] || '—') + '</td></tr>';
        });
        h += '</tbody></table></div>';
        h += msg(r.isDefaulted ? 'warn' : 'ok', (r.isDefaulted ? '⚠ ' : '✓ ') + 'ct = ' + fmt(r.ct, 4) + ' 1/psi' +
                 (r.isDefaulted ? ' — uses default inputs: ' + esc(r.defaulted.join(', ')) + '. Enter measured values before relying on it.' : ''));
        r.warnings.forEach(function (w) { h += msg('warn', '⚠ ' + esc(w)); });
        return h;
    }
    function renderCtBuilder(host) {
        if (!host) return;
        ensureStyle();
        var f = ft();
        var inp = f.ctInput || {};
        var methods = Object.keys(CF_METHODS).map(function (k) {
            return '<option value="' + k + '"' + ((inp.cfMethod || 'hall') === k ? ' selected' : '') + '>' + CF_METHODS[k] + '</option>';
        }).join('');
        var h = '<div class="prism-ft" id="prism_ft_ct_root">' +
            '<div class="prism-ft-hint">ct = So·co + Sw·cw + Sg·cg + cf. Blank fields come from Well &amp; Test and the PVT correlations (Vasquez-Beggs co, Osif / Dodson-Standing cw, real-gas cg).</div>' +
            '<div class="prism-ft-grid">' +
            field('prism_ft_ct_So', 'So', inp.So) + field('prism_ft_ct_Sw', 'Sw', inp.Sw) + field('prism_ft_ct_Sg', 'Sg', inp.Sg) +
            field('prism_ft_ct_co', 'co (1/psi)', inp.co) + field('prism_ft_ct_cw', 'cw (1/psi)', inp.cw) + field('prism_ft_ct_cg', 'cg (1/psi)', inp.cg) +
            '<label>Rock compressibility<select id="prism_ft_ct_method">' + methods + '</select></label>' +
            field('prism_ft_ct_phi', 'φ (fraction)', inp.phi) + field('prism_ft_ct_cf', 'cf (1/psi, entered)', inp.cf) +
            '</div><div class="prism-ft-row"><button type="button" class="prism-ft-btn" id="prism_ft_ct_calc">Calculate</button>' +
            '<button type="button" class="prism-ft-btn prism-ft-btn--primary" id="prism_ft_ct_apply">Write ct to Well &amp; Test</button></div>' +
            '<div id="prism_ft_ct_res">' + ctResultHTML(ctBuild(inp)) + '</div>' +
            (f.ctBuild && isPos(f.ctBuild.ct) ? '<div class="prism-ft-hint">Last written: ct = ' + fmt(f.ctBuild.ct, 4) + ' 1/psi (' + esc(CF_METHODS[f.ctBuild.cfMethod] || '') + ').</div>' : '') +
            '</div>';
        host.innerHTML = h;
        var root = $('prism_ft_ct_root');
        if (!root || typeof root.addEventListener !== 'function') return;
        root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t) return;
            if (t.id !== 'prism_ft_ct_calc' && t.id !== 'prism_ft_ct_apply') return;
            var input = ctInputFromForm();
            ft().ctInput = input;
            save();
            var r = ctBuild(input);
            var box = $('prism_ft_ct_res');
            if (box) box.innerHTML = ctResultHTML(r);
            if (t.id === 'prism_ft_ct_apply' && r.ok) {
                ctApply(r);
                var b2 = $('prism_ft_ct_res');
                if (b2) b2.innerHTML = ctResultHTML(r) + msg('ok', '✓ ct written to Well &amp; Test (provenance: correlation).');
            }
        });
    }

    function registerPanels() {
        var specs = [
            [1, { id: 'prism_ct_builder', title: 'Total compressibility (ct) builder', order: 12, collapsed: true, render: renderCtBuilder }],
            [1, { id: 'prism_gauge_register', title: 'Gauge register', order: 30, render: renderGaugeRegister }],
            [1, { id: 'prism_events_log', title: 'Sequence of events', order: 35, render: renderEventsLog }],
            [2, { id: 'prism_gauge_resolution', title: 'Gauge resolution check', order: 40, when: function () { return ft().gauges.length > 0; }, render: renderGaugeCheckPanel }]
        ];
        specs.forEach(function (x) {
            if (typeof G.PRiSM_registerTabPanel === 'function') {
                try { if (G.PRiSM_registerTabPanel(x[0], x[1])) return; } catch (e) { /* fall back */ }
            }
            G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
            var arr = G.PRiSM_tabPanels[x[0]] = G.PRiSM_tabPanels[x[0]] || [];
            for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === x[1].id) { arr[i] = x[1]; return; }
            arr.push(x[1]);
        });
    }
    registerPanels();

    // Refresh mounted panels on the shared events (no polling).
    if (!G.__PRiSM_fieldToolsListeners) {
        G.__PRiSM_fieldToolsListeners = true;
        on('prism:gauges-changed', function () {
            _chkCache.key = null;
            rerender('prism_ft_gauges_root', renderGaugeRegister);
            rerender('prism_ft_gcheck_root', renderGaugeCheckPanel);
            redraw();
        });
        on('prism:events-changed', function () { rerender('prism_ft_events_root', renderEventsLog); });
        ['prism:fit-updated', 'prism:dataset-loaded', 'prism:period-changed', 'prism:well-changed'].forEach(function (type) {
            on(type, function () {
                _chkCache.key = null;
                rerender('prism_ft_gcheck_root', renderGaugeCheckPanel);
                var c = $('prism_ft_g_check');
                if (c) { try { c.innerHTML = checkSummaryHTML(gaugeResolutionCheck()); } catch (e) { /* ignore */ } }
            });
        });
        on('prism:period-changed', function (ev) {
            var src = ev && ev.detail && ev.detail.source;
            if (src === 'undo' || src === 'events') {
                var u = $('prism_ft_undo');
                if (u) u.disabled = !(typeof G.PRiSM_canUndo === 'function' && G.PRiSM_canUndo());
            }
        });
    }

    // =========================================================================
    // SECTION 7 — EXPORTS
    // =========================================================================

    G.PRiSM_listGauges = listGauges;
    G.PRiSM_setGauge = setGauge;
    G.PRiSM_removeGauge = removeGauge;
    G.PRiSM_setPrimaryGauge = setPrimaryGauge;
    G.PRiSM_primaryGauge = primaryGauge;
    G.PRiSM_gaugeResolutionCheck = gaugeResolutionCheck;
    G.PRiSM_gaugeSamplingLimit = samplingLimit;
    G.PRiSM_addEvent = addEvent;
    G.PRiSM_listEvents = listEvents;
    G.PRiSM_removeEvent = removeEvent;
    G.PRiSM_clearEvents = clearEvents;
    G.PRiSM_setEventClock = setEventClock;
    G.PRiSM_eventsToRateSchedule = eventsToRateSchedule;
    G.PRiSM_seedPeriodsFromEvents = seedPeriodsFromEvents;
    G.PRiSM_rockCompressibility = rockCompressibility;
    G.PRiSM_ctBuild = ctBuild;
    G.PRiSM_ctApply = ctApply;
    G.PRiSM_renderGaugeRegister = renderGaugeRegister;
    G.PRiSM_renderEventsLog = renderEventsLog;
    G.PRiSM_renderCtBuilder = renderCtBuilder;
    G.PRiSM_renderGaugeCheckPanel = renderGaugeCheckPanel;
    G.PRiSM_EVENT_TYPES = EVENT_TYPES;

})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (typeof G.PRiSM_rockCompressibility !== 'function') return;
    var checks = [];
    function near(a, b, tol) { return Math.abs(a - b) <= tol * Math.abs(b); }
    // Hand values: Hall φ=0.2 → 1.782e-6/0.2^0.438 = 3.6063e-6; Newman sandstone φ=0.2 → 2.7387e-6.
    checks.push(['Hall cf(0.2)', near(G.PRiSM_rockCompressibility(0.2, 'hall'), 3.6063e-6, 1e-4)]);
    checks.push(['Newman ss cf(0.2)', near(G.PRiSM_rockCompressibility(0.2, 'newman-sandstone'), 2.7387e-6, 1e-4)]);
    // Sampling limit: m = 20 psi/cycle, Δs = 0.01 h, r = 0.01 psi → 20·0.01/(ln10·0.01) = 8.686 h.
    checks.push(['sampling limit', near(G.PRiSM_gaugeSamplingLimit(20, 0.01, 0.01), 8.686, 1e-3)]);
    var r = G.PRiSM_eventsToRateSchedule([{ type: 'open', t: 0, q: 800 }, { type: 'choke', t: 10, q: 1200 }, { type: 'close', t: 24 }]);
    checks.push(['schedule', r.ok && r.rows.length === 3 && r.rows[2].q === 0]);
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[39-prism-fieldtools self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_fieldTools_selfTest = checks;
})();
