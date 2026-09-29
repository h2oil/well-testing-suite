// ═══════════════════════════════════════════════════════════════════════
// 42-calc-oilipr.js — Oil Well IPR (plug-in calculator, Round 9)
//
// Registers window.WTS_calcRegistry.oilipr. The host adds the route, the
// sidebar button (Production & Reservoir) and the dashboard tile.
//
// Inflow performance from one or more stabilised test points:
//   • Straight-line PI:          q = J·(p̄r − pwf)
//   • Vogel (saturated, pb ≥ p̄r) with Standing's flow efficiency FE
//   • Composite (p̄r > pb):       PI above pb, Vogel below pb
//   • Fetkovich multipoint:       q = C·(p̄r² − pwf²)ⁿ  (log-log least squares)
//   • Future IPR:                 Vogel cube rule / Fetkovich C·(prf/p̄r)
//
// References
//   Vogel, J.V. (1968) "Inflow Performance Relationships for Solution-Gas
//     Drive Wells", JPT 20(1) 83-92.  V(x) = 1 − 0.2x − 0.8x², x = pwf/p̄r.
//   Standing, M.B. (1970) "Inflow Performance Relationships for Damaged
//     Wells Producing by Solution-Gas Drive", JPT 22(11) 1399-1400.
//     pwf′ = p̄r − FE·(p̄r − pwf).
//   Fetkovich, M.J. (1973) "The Isochronal Testing of Oil Wells", SPE 4529.
//     q = C·(p̄r² − pwf²)ⁿ; future C_f = C·(p̄r,f / p̄r).
//   Fetkovich / Eickmeier future Vogel: qmax,f = qmax·(p̄r,f / p̄r)³.
//   Brown, K.E., Technology of Artificial Lift Methods, Vol. 1 — composite
//     IPR: q_b = J·(p̄r − pb), q_v = J·pb/1.8.
//
// Units: field units throughout (psia, BPD). The units layer converts the
// tagged inputs; calcOilIPR reads imperial inside a canonical context.
//
// Public API (window.*)
//   WTS_oilipr_compute(input[, fmt])  pure, field units in and out, no DOM
//   renderOilIPR(body)                paints the page into body
//   calcOilIPR()                      read DOM → validate → compute → render
//   WTS_state.oilipr                  last result {ok, mode, J, qb, qmax, …}
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'oi_';
    var NPTS = 4;
    var METHODS = ['vogel', 'fetk', 'pi'];
    var METHOD_LABEL = { vogel: 'Vogel / composite (automatic)', fetk: 'Fetkovich (multipoint)', pi: 'Straight-line PI' };
    var MODE_LABEL = {
        'vogel-sat': 'Vogel (saturated)',
        'composite': 'Composite (PI above pb, Vogel below)',
        'fetkovich': 'Fetkovich (C and n)',
        'pi': 'Straight-line PI'
    };
    var TITLE = 'Oil Well IPR';
    var SUB = 'Inflow performance from a test point — straight-line PI, Vogel, composite (above and below bubble point) and Fetkovich, with flow efficiency and future IPR';

    // ── Page helpers (shared calculator pattern) ─────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) { if (v == null || !isFinite(v)) return '—'; return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }); }
    function _fix(v, d) { if (v == null || !isFinite(v)) return '—'; return Number(v).toFixed(d); }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    // value in the display system; impLabel is the imperial text ('psia' where the category says 'psi')
    function _u(v, cat, d, impLabel) {
        var U = G.WTS_units;
        if (_metric()) { var f = U.format(v, cat); return _fmt(f.value, d) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _disp(v, cat) { if (v == null || !isFinite(v)) return v; return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(0, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }

    function _blankV(v) { return v == null || v === '' || (typeof v === 'number' && isNaN(v)); }
    function _n(v) { return _blankV(v) ? NaN : Number(v); }

    // Field-unit text formatters (the page swaps in display-unit versions)
    var FIELD_FMT = {
        p: function (v) { return _fmt(v, 1) + ' psia'; },
        q: function (v) { return _fmt(v, 1) + ' BPD'; }
    };

    // ── Engineering core ────────────────────────────────────────────────
    // Vogel (1968) dimensionless IPR
    function V(x) { return 1 - 0.2 * x - 0.8 * x * x; }
    // Inverse of V: V(x) = y → x = [−0.2 + √(0.04 + 3.2·(1 − y))]/1.6
    function Vinv(y) { return (-0.2 + Math.sqrt(0.04 + 3.2 * (1 - y))) / 1.6; }

    function _validate(inp, fmt) {
        var errors = [], keys = [];
        function err(key, msg) { errors.push(msg); keys.push(key); }
        var method = inp.method == null ? 'vogel' : String(inp.method);
        if (METHODS.indexOf(method) === -1) { err('method', 'Unknown IPR method.'); method = 'vogel'; }
        var pr = _n(inp.pr), pb = _n(inp.pb), fe = _blankV(inp.fe) ? 1 : _n(inp.fe);
        var pwfd = _n(inp.pwfDesign), qt = _n(inp.qTarget), prf = _n(inp.prFuture);
        var prOk = false;
        if (!isFinite(pr)) err('pr', 'Average reservoir pressure is required.');
        else if (pr <= 0) err('pr', 'Average reservoir pressure must be above 0.');
        else if (pr < 50 || pr > 30000) err('pr', 'Average reservoir pressure must be between ' + fmt.p(50) + ' and ' + fmt.p(30000) + '.');
        else prOk = true;

        if (method === 'vogel') {
            if (!isFinite(pb)) err('pb', 'Bubble-point pressure is required for the Vogel / composite method.');
            else if (pb < 0) err('pb', 'Bubble-point pressure cannot be negative.');
            else if (pb > 30000) err('pb', 'Bubble-point pressure must not exceed ' + fmt.p(30000) + '.');
        }
        if (!isFinite(fe) || fe < 0.3 || fe > 2.0) err('fe', 'Flow efficiency FE must be between 0.3 and 2.0.');
        if (!_blankV(inp.pwfDesign)) {
            if (!isFinite(pwfd) || pwfd < 0) err('pwfd', 'Flowing pressure for the rate readout cannot be negative.');
            else if (prOk && pwfd >= pr) err('pwfd', 'Flowing pressure for the rate readout must be below the average reservoir pressure.');
        }
        if (!_blankV(inp.qTarget) && (!isFinite(qt) || qt <= 0)) err('qt', 'Target rate for the pressure readout must be above 0.');
        if (!_blankV(inp.prFuture)) {
            if (!isFinite(prf) || prf <= 0) err('prf', 'Future average reservoir pressure must be above 0.');
            else if (prOk && prf >= pr) err('prf', 'Future average reservoir pressure must be below the current average reservoir pressure.');
        }

        var raw = Array.isArray(inp.points) ? inp.points : [];
        var used = [], row1 = null;
        for (var i = 0; i < Math.min(raw.length, NPTS); i++) {
            var pt = raw[i] || {}, k = i + 1;
            var qb = _blankV(pt.q), pbk = _blankV(pt.pwf);
            if (qb && pbk) continue;
            if (qb || pbk) { err(qb ? 'q' + k : 'pwf' + k, 'Test point ' + k + ': enter both the rate and the flowing pressure.'); continue; }
            var q = _n(pt.q), pwf = _n(pt.pwf), good = true;
            if (!isFinite(q) || q <= 0) { err('q' + k, 'Test point ' + k + ': rate must be above 0.'); good = false; }
            if (!isFinite(pwf) || pwf < 0) { err('pwf' + k, 'Test point ' + k + ': flowing pressure cannot be negative.'); good = false; }
            else if (prOk && pwf >= pr) { err('pwf' + k, 'Test point ' + k + ': flowing pressure must be below the average reservoir pressure.'); good = false; }
            if (good) { var o = { q: q, pwf: pwf, row: k }; used.push(o); if (k === 1) row1 = o; }
        }
        if ((method === 'vogel' || method === 'pi') && !row1 && _blankV((raw[0] || {}).q) && _blankV((raw[0] || {}).pwf)) {
            err('q1', 'Test point 1 is required for the ' + METHOD_LABEL[method] + ' method.');
        }
        if (method === 'fetk') {
            if (!used.length && !errors.some(function (m, j) { return /^(q|pwf)\d$/.test(keys[j]); })) err('q1', 'Fetkovich needs at least one test point.');
            for (var a = 0; a < used.length; a++) for (var b = a + 1; b < used.length; b++) {
                if (used[a].pwf === used[b].pwf) err('pwf' + used[b].row, 'Test points ' + used[a].row + ' and ' + used[b].row + ' have the same flowing pressure — Fetkovich needs distinct pressures.');
            }
        }
        return { errors: errors, keys: keys, method: method, pr: pr, pb: pb, fe: fe, pwfd: pwfd, qt: qt, prf: prf, used: used, row1: row1 };
    }

    // Pure compute — field units in and out.
    //   input: {method, pr, pb, fe, pwfDesign, qTarget, prFuture, points:[{q, pwf}]}
    //   fmt (optional): {p(v), q(v)} text formatters for messages (default field units)
    function compute(input, fmt) {
        fmt = fmt || FIELD_FMT;
        var v = _validate(input || {}, fmt);
        var out = {
            ok: false, errors: v.errors, errorKeys: v.keys, warnings: [], verdicts: [], mode: null,
            J: null, qb: null, qmax: null, qmaxFE1: null, pwfLimitFE: null, n: null, C: null, r2: null,
            qAtPwf: null, pwfAtQ: null, future: null, table: [], points: v.used
        };
        if (v.errors.length) return out;

        var pr = v.pr, fe = v.fe, prf = v.prf, method = v.method;
        var hasPwfd = isFinite(v.pwfd), hasQt = isFinite(v.qt), hasPrf = isFinite(prf);
        var qAt, pwfAt, qfAt = null;          // q(pwf) → {q, held}; pwf(q) → number|null
        function warn(level, text) { out.verdicts.push({ level: level, text: text }); out.warnings.push(text); }
        function fail(key, msg) { out.errors.push(msg); out.errorKeys.push(key); return out; }

        if (method === 'pi') {
            // (1) Straight-line PI: J = q₁/(p̄r − pwf₁); q = J·(p̄r − pwf)
            var t = v.row1;
            var J = t.q / (pr - t.pwf);
            out.mode = 'pi'; out.J = J; out.qmax = J * pr;
            qAt = function (pwf) { return { q: J * (pr - pwf), held: false }; };
            pwfAt = function (q) { return pr - q / J; };
            if (isFinite(v.pb) && v.pb > t.pwf) warn('warn', '⚠ Test pwf is below the bubble point — a straight-line PI overstates the rate; use Vogel/composite.');
            if (hasPrf) warn('warn', '⚠ Future IPR is available for saturated Vogel and Fetkovich only.');
        } else if (method === 'vogel' && v.pb >= pr) {
            // (2) Saturated Vogel with Standing (1970) flow efficiency
            var t2 = v.row1;
            var pwf1p = pr - fe * (pr - t2.pwf);
            if (pwf1p < 0) {
                return fail('pwf1', 'Test point 1 lies below the flow-efficiency validity limit (pwf = ' + fmt.p(pr * (1 - 1 / fe)) + '), so qmax cannot be backed out. Use a test point above this pressure or a lower FE.');
            }
            var qm1 = t2.q / V(pwf1p / pr);
            out.mode = 'vogel-sat';
            out.qmaxFE1 = qm1;
            out.qmax = fe <= 1 ? qm1 * V(1 - fe) : qm1;
            if (fe > 1) out.pwfLimitFE = pr * (1 - 1 / fe);
            var mkQ = function (p, qmax1) {
                return function (pwf) {
                    var pp = p - fe * (p - pwf);
                    if (pp < 0) return { q: qmax1, held: true };
                    return { q: qmax1 * V(pp / p), held: false };
                };
            };
            var mkPwf = function (p, qmax1) {
                return function (q) { var x = Vinv(q / qmax1); return p - (p - x * p) / fe; };
            };
            qAt = mkQ(pr, qm1);
            pwfAt = mkPwf(pr, qm1);
            if (fe > 1) warn('warn', '⚠ Standing\'s FE > 1 curve is valid down to pwf = ' + fmt.p(out.pwfLimitFE) + '; below that the rate is held at qmax (FE = 1).');
            if (hasPrf) {
                // Fetkovich/Eickmeier cube rule
                var qmf1 = qm1 * Math.pow(prf / pr, 3);
                qfAt = mkQ(prf, qmf1);
                out.future = { pr: prf, qmaxFE1: qmf1, qmax: fe <= 1 ? qmf1 * V(1 - fe) : qmf1, qAtPwf: null };
            }
        } else if (method === 'vogel') {
            // (3) Composite (undersaturated): PI above pb, Vogel below pb
            var pb = v.pb, t3 = v.row1, Jc;
            if (t3.pwf >= pb) Jc = t3.q / (pr - t3.pwf);
            else Jc = t3.q / ((pr - pb) + (pb / 1.8) * V(t3.pwf / pb));
            var qbub = Jc * (pr - pb), qv = Jc * pb / 1.8;
            out.mode = 'composite'; out.J = Jc; out.qb = qbub; out.qmax = qbub + qv;
            qAt = function (pwf) { return { q: pwf >= pb ? Jc * (pr - pwf) : qbub + qv * V(pwf / pb), held: false }; };
            pwfAt = function (q) { return q <= qbub ? pr - q / Jc : pb * Vinv((q - qbub) / qv); };
            if (fe !== 1) warn('warn', '⚠ Flow efficiency applies to saturated (Vogel) wells only — FE ignored.');
            if (hasPrf) warn('warn', '⚠ Future IPR is available for saturated Vogel and Fetkovich only.');
        } else {
            // (4) Fetkovich (1973): log10 q = log10 C + n·log10(p̄r² − pwf²)
            var pts = v.used, m = pts.length, n, C, r2 = null;
            if (m === 1) {
                n = 1; C = pts[0].q / (pr * pr - pts[0].pwf * pts[0].pwf);
                warn('warn', '⚠ One point — n assumed 1.0.');
            } else {
                var X = [], Y = [], sx = 0, sy = 0;
                for (var i = 0; i < m; i++) {
                    X.push(Math.log10(pr * pr - pts[i].pwf * pts[i].pwf)); Y.push(Math.log10(pts[i].q));
                    sx += X[i]; sy += Y[i];
                }
                var xb = sx / m, yb = sy / m, sxx = 0, sxy = 0, syy = 0;
                for (i = 0; i < m; i++) { sxx += (X[i] - xb) * (X[i] - xb); sxy += (X[i] - xb) * (Y[i] - yb); syy += (Y[i] - yb) * (Y[i] - yb); }
                n = sxy / sxx;
                C = Math.pow(10, yb - n * xb);
                if (m >= 3) {
                    var ssr = 0;
                    for (i = 0; i < m; i++) { var e = Y[i] - (Math.log10(C) + n * X[i]); ssr += e * e; }
                    r2 = syy > 0 ? 1 - ssr / syy : 1;
                }
                if (!(n > 0) || !isFinite(C)) {
                    return fail('q1', 'The Fetkovich fit gives n ≤ 0 — rates must increase as the flowing pressure falls. Check the test points.');
                }
            }
            out.mode = 'fetkovich'; out.n = n; out.C = C; out.r2 = r2;
            out.qmax = C * Math.pow(pr, 2 * n);
            qAt = function (pwf) { return { q: C * Math.pow(pr * pr - pwf * pwf, n), held: false }; };
            pwfAt = function (q) { return Math.sqrt(pr * pr - Math.pow(q / C, 1 / n)); };
            if (m > 1 && (n < 0.5 || n > 1.0)) warn('warn', '⚠ Fetkovich exponent n = ' + _fix(n, 4) + ' is outside 0.5–1.0 — check the test points for unstabilised or non-Darcy data.');
            if (hasPrf) {
                var Cf = C * (prf / pr);
                qfAt = function (pwf) { return { q: Cf * Math.pow(prf * prf - pwf * pwf, n), held: false }; };
                out.future = { pr: prf, C: Cf, qmax: Cf * Math.pow(prf, 2 * n), qAtPwf: null };
            }
        }

        // Readouts
        if (hasPwfd) out.qAtPwf = qAt(v.pwfd).q;
        if (hasQt) {
            if (v.qt >= out.qmax) warn('bad', '✗ Target rate exceeds the maximum rate ' + fmt.q(out.qmax) + '.');
            else out.pwfAtQ = pwfAt(v.qt);
        }
        if (out.future && hasPwfd && v.pwfd < prf) out.future.qAtPwf = qfAt(v.pwfd).q;

        // (6) IPR table: pwf_k = p̄r·(1 − k/10), k = 0…10
        for (var k = 0; k <= 10; k++) {
            var pw = pr * (1 - k / 10), r = qAt(pw), rf = (qfAt && pw < prf) ? qfAt(pw) : null;
            out.table.push({ pwf: pw, q: r.q, qf: rf ? rf.q : null, heldAtMax: r.held, heldFuture: rf ? rf.held : false });
        }
        // Dense curves for the chart
        out.curve = []; out.curveF = [];
        for (var c = 0; c <= 40; c++) {
            var pc = pr * (1 - c / 40);
            out.curve.push({ pwf: pc, q: qAt(pc).q });
            if (qfAt) { var pcf = prf * (1 - c / 40); out.curveF.push({ pwf: pcf, q: qfAt(pcf).q }); }
        }
        out.ok = true;
        return out;
    }
    G.WTS_oilipr_compute = compute;

    // ── Page ─────────────────────────────────────────────────────────────
    var UNITS = { oi_pr: 'pressure', oi_pb: 'pressure', oi_pwfd: 'pressure', oi_prf: 'pressure', oi_qt: 'liquidRate' };
    for (var ui = 1; ui <= NPTS; ui++) { UNITS['oi_q' + ui] = 'liquidRate'; UNITS['oi_pwf' + ui] = 'pressure'; }

    function _field(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }

    function render(body) {
        if (!body) body = _byId('pgBody');
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var opts = METHODS.map(function (m) { return '<option value="' + m + '"' + (m === 'vogel' ? ' selected' : '') + '>' + METHOD_LABEL[m] + '</option>'; }).join('');
        var rows = '';
        for (var i = 1; i <= NPTS; i++) {
            rows += '<tr><td>' + i + '</td>' +
                '<td><input type="number" id="oi_q' + i + '" value="' + (i === 1 ? '100' : '') + '" step="any" style="width:100%;min-width:72px" aria-label="Test point ' + i + ' rate q"></td>' +
                '<td><input type="number" id="oi_pwf' + i + '" value="' + (i === 1 ? '1800' : '') + '" step="any" style="width:100%;min-width:72px" aria-label="Test point ' + i + ' flowing pressure pwf, absolute"></td></tr>';
        }
        body.innerHTML =
            '<div id="oi_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Reservoir &amp; Method</div><div class="fg">' +
            '<div class="fg-item"><label for="oi_method">IPR method</label><select id="oi_method">' + opts + '</select></div>' +
            _field('oi_pr', 'Average reservoir pressure, absolute (psia)', '2400') +
            _field('oi_pb', 'Bubble-point pressure, absolute (psia)', '2400') +
            _field('oi_fe', 'Flow efficiency FE, Standing', '1.0') +
            _field('oi_pwfd', 'Flowing pressure for rate readout, absolute (psia)', '1200') +
            _field('oi_qt', 'Target rate for pressure readout (BPD)', '150') +
            _field('oi_prf', 'Future average reservoir pressure, absolute (psia)', '') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Test Points</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="oi_pts"><thead><tr><th>#</th>' +
            '<th data-wts-unit-label="liquidRate">Rate q (' + _lab('liquidRate', 'BPD') + ')</th>' +
            '<th data-wts-unit-label="pressure">pwf, abs (' + _lab('pressure', 'psia') + ')</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<div style="font-size:12px;color:var(--text2);margin-top:6px">Vogel and straight-line PI use test point 1; Fetkovich fits every filled row.</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="oi_go" onclick="calcOilIPR()">Calculate</button></div>' +
            '</div>' +
            '</div>' +
            '<div><div id="oi_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('oi_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = e && e.target && e.target.id;
                if (id && id.indexOf(P) === 0 && id !== 'oi_go') G.calcOilIPR();
            });
        }
        G.calcOilIPR();
    }

    function _row(label, value) { return '<div class="rrow"><span class="rl">' + label + '</span><span class="rv">' + value + '</span></div>'; }

    function _readInputs() {
        var pts = [];
        for (var i = 1; i <= NPTS; i++) pts.push({ q: _num('oi_q' + i), pwf: _num('oi_pwf' + i) });
        var me = _byId('oi_method');
        var m = me ? String(me.value) : 'vogel';
        return {
            method: m, pr: _num('oi_pr'), pb: _num('oi_pb'), fe: _num('oi_fe'),
            pwfDesign: _num('oi_pwfd'), qTarget: _num('oi_qt'), prFuture: _num('oi_prf'), points: pts
        };
    }

    function _calcImpl() {
        var res = _byId('oi_res');
        var root = _byId('oi_root');
        if (root && root.querySelectorAll) {
            var all = root.querySelectorAll('input, select');
            for (var a = 0; a < all.length; a++) if (all[a].classList) all[a].classList.remove('input-err');
        }
        var inp = _readInputs();
        var fmtUI = {
            p: function (v) { return _u(v, 'pressure', 1, 'psia'); },
            q: function (v) { return _u(v, 'liquidRate', 1, 'BPD'); }
        };
        var r = compute(inp, fmtUI);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            var seen = {};
            r.errorKeys.forEach(function (k) {
                if (seen[k]) return; seen[k] = 1;
                var el = _byId(P + k); if (el && el.classList) el.classList.add('input-err');
            });
            G.WTS_state.oilipr = { ok: false, errors: r.errors.slice(), mode: null, ts: Date.now() };
            if (res) {
                res.removeAttribute('data-done');
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                    r.errors.map(function (e) { return '<li>' + _esc(e) + '</li>'; }).join('') + '</ul></div>';
            }
            return r;
        }

        G.WTS_state.oilipr = {
            ok: true, mode: r.mode, J: r.J, qb: r.qb, qmax: r.qmax, qmaxFE1: r.qmaxFE1, n: r.n, C: r.C, r2: r.r2,
            qAtPwf: r.qAtPwf, pwfAtQ: r.pwfAtQ, qmaxFuture: r.future ? r.future.qmax : null,
            qAtPwfFuture: r.future ? r.future.qAtPwf : null, ts: Date.now()
        };
        if (!res) return r;

        var fe = isFinite(inp.fe) ? inp.fe : 1;
        var h = '<div class="rbox"><div class="rbox-title">IPR Result — ' + MODE_LABEL[r.mode] + '</div>';
        if (r.J != null) h += _row('Productivity index J', _metric() ? _u(r.J, 'productivityIndex', 5, 'BPD/psi') : _fix(r.J, 4) + ' BPD/psi');
        if (r.qb != null) h += _row('Rate at bubble point q_b', fmtUI.q(r.qb));
        h += _row('Maximum rate qmax (AOF)', fmtUI.q(r.qmax));
        if (r.mode === 'vogel-sat' && fe !== 1) h += _row('qmax at FE = 1', fmtUI.q(r.qmaxFE1));
        if (r.pwfLimitFE != null) h += _row('FE validity limit pwf', fmtUI.p(r.pwfLimitFE));
        if (r.n != null) h += _row('Fetkovich n', _fix(r.n, 4));
        if (r.C != null) h += _row('Fetkovich C', Number(r.C).toExponential(4) + ' BPD/psia²ⁿ');
        if (r.r2 != null) h += _row('Fit R²', _fix(r.r2, 4));
        if (isFinite(inp.pwfDesign)) h += _row('Rate at pwf = ' + fmtUI.p(inp.pwfDesign), fmtUI.q(r.qAtPwf));
        if (isFinite(inp.qTarget)) h += _row('pwf at q = ' + fmtUI.q(inp.qTarget), r.pwfAtQ == null ? '—' : fmtUI.p(r.pwfAtQ));
        h += '</div>';

        if (r.future) {
            h += '<div class="rbox"><div class="rbox-title">Future IPR at p̄r = ' + fmtUI.p(r.future.pr) + '</div>';
            h += _row('Maximum rate qmax (future)', fmtUI.q(r.future.qmax));
            if (isFinite(inp.pwfDesign)) h += _row('Rate at pwf = ' + fmtUI.p(inp.pwfDesign) + ' (future)', r.future.qAtPwf == null ? '—' : fmtUI.q(r.future.qAtPwf));
            h += '</div>';
        }

        r.verdicts.forEach(function (vd) {
            var col = vd.level === 'bad' ? 'var(--red)' : vd.level === 'ok' ? 'var(--green)' : 'var(--yellow)';
            h += '<div style="color:' + col + ';margin:6px 0">' + _esc(vd.text) + '</div>';
        });

        var qL = _lab('liquidRate', 'BPD'), pL = _lab('pressure', 'psia'), anyHeld = false;
        h += '<div class="rbox"><div class="rbox-title">IPR Table</div><div style="overflow-x:auto"><table class="dtable" id="oi_tbl"><thead><tr>' +
            '<th>pwf (' + pL + ')</th><th>q (' + qL + ')</th>' + (r.future ? '<th>q future (' + qL + ')</th>' : '') + '</tr></thead><tbody>';
        r.table.forEach(function (row) {
            if (row.heldAtMax || row.heldFuture) anyHeld = true;
            h += '<tr><td>' + _fmt(_disp(row.pwf, 'pressure'), 1) + '</td><td>' + _fmt(_disp(row.q, 'liquidRate'), 1) + (row.heldAtMax ? ' *' : '') + '</td>' +
                (r.future ? '<td>' + (row.qf == null ? '' : _fmt(_disp(row.qf, 'liquidRate'), 1) + (row.heldFuture ? ' *' : '')) + '</td>' : '') + '</tr>';
        });
        h += '</tbody></table></div>';
        if (anyHeld) h += '<div style="font-size:12px;color:var(--text2);margin-top:4px">* Below the FE validity limit — rate held at qmax (FE = 1).</div>';
        h += '</div>';

        h += '<div class="chart-wrap"><canvas id="oi_chart" width="600" height="340"></canvas></div>';
        h += '<div style="font-size:12px;color:var(--text2);margin-top:8px"><b>Notes</b> Use absolute pressures consistently; Vogel curves are dimensionless ratios, so gauge-pressure inputs change results by less than about 1 % at typical reservoir pressures.</div>';
        res.innerHTML = h;
        _chart(r);
        res.setAttribute('data-done', '1');
        return r;
    }

    function _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _chart(r) {
        var cv = _byId('oi_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw || !cv.getContext) return;
        function xy(p) { return { x: _disp(p.q, 'liquidRate'), y: _disp(p.pwf, 'pressure') }; }
        var ds = [{ label: 'IPR (present)', color: '#f0883e', data: r.curve.map(xy), points: false, width: 2 }];
        if (r.curveF && r.curveF.length) ds.push({ label: 'Future IPR', color: '#bc8cff', dash: [4, 4], data: r.curveF.map(xy), points: false, width: 2 });
        var tp = r.points.slice().sort(function (a, b) { return a.q - b.q; }).map(xy);
        if (tp.length) ds.push({ label: 'Test points', color: '#3fb950', data: tp, points: true, width: 0.001 });
        try {
            draw(cv, ds, {
                xLabel: 'Rate q (' + _lab('liquidRate', 'BPD') + ')', yLabel: 'pwf (' + _lab('pressure', 'psia') + ')',
                xMin: 0, yMin: 0, xDec: 0, yDec: 0
            });
        } catch (e) { /* chart is decorative; results stay valid */ }
    }

    G.calcOilIPR = function () { return _canon(_calcImpl); };
    G.renderOilIPR = render;

    // ── Registry entry (merge, never replace) ────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.oilipr = {
        key: 'oilipr',
        title: TITLE,
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8600;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Straight-line PI, Vogel, composite and Fetkovich IPR with Standing flow efficiency, future IPR and rate/pressure readouts.',
        render: render
    };

    // Unit flip: re-render results in the new display system
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('oi_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcOilIPR();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var f = G.WTS_oilipr_compute;
    var fails = [], count = 0;
    function rel(a, b, tol, what) {
        count++;
        if (!(a != null && isFinite(a) && Math.abs(a - b) <= (tol || 1e-3) * Math.max(1e-12, Math.abs(b)))) fails.push(what + ': expected ' + b + ', got ' + a);
    }
    function yes(c, what) { count++; if (!c) fails.push(what); }
    function qAt(r, pwf) { for (var i = 0; i < r.table.length; i++) if (Math.abs(r.table[i].pwf - pwf) < 1e-9) return r.table[i]; return null; }
    function base(o) {
        var b = { method: 'vogel', pr: 2400, pb: 2400, fe: 1, pwfDesign: null, qTarget: null, prFuture: null, points: [{ q: 100, pwf: 1800 }] };
        for (var k in o) b[k] = o[k];
        return b;
    }
    var r;
    // O1 — Vogel saturated (textbook qmax = 250)
    r = f(base({ pwfDesign: 800, qTarget: 150, prFuture: 2000 }));
    yes(r.ok && r.mode === 'vogel-sat', 'O1 mode');
    rel(r.qmax, 250.0, 1e-3, 'O1 qmax'); rel(r.qAtPwf, 211.1, 1e-3, 'O1 q@800');
    rel(qAt(r, 1200).q, 175.0, 1e-3, 'O1 q@1200'); rel(r.pwfAtQ, 1423.4, 1e-3, 'O1 pwf@150');
    rel(r.future.qmax, 144.7, 1e-3, 'O1 qmax_f'); rel(r.future.qAtPwf, 114.6, 1e-3, 'O1 qf@800');
    // O2a — composite, test above pb
    r = f({ method: 'vogel', pr: 4000, pb: 3000, pwfDesign: 2000, qTarget: 4000, points: [{ q: 1000, pwf: 3500 }] });
    yes(r.ok && r.mode === 'composite', 'O2a mode');
    rel(r.J, 2.0, 1e-3, 'O2a J'); rel(r.qb, 2000, 1e-3, 'O2a qb'); rel(r.qmax, 5333.3, 1e-3, 'O2a qmax');
    rel(r.qAtPwf, 3703.7, 1e-3, 'O2a q@2000'); rel(qAt(r, 3200).q, 1600, 1e-3, 'O2a q@3200');
    rel(r.pwfAtQ, 1779.2, 1e-3, 'O2a pwf@4000');
    rel(f({ method: 'vogel', pr: 4000, pb: 3000, qTarget: 1500, points: [{ q: 1000, pwf: 3500 }] }).pwfAtQ, 3250, 1e-3, 'O2a pwf@1500');
    // O2b — composite, test below pb
    r = f({ method: 'vogel', pr: 4000, pb: 3000, pwfDesign: 1000, points: [{ q: 3000, pwf: 2000 }] });
    rel(r.J, 1.620, 1e-3, 'O2b J'); rel(r.qb, 1620, 1e-3, 'O2b qb'); rel(r.qmax, 4320, 1e-3, 'O2b qmax');
    rel(r.qAtPwf, 3900, 1e-3, 'O2b q@1000');
    rel(f({ method: 'vogel', pr: 4000, pb: 3000, pwfDesign: 3500, points: [{ q: 3000, pwf: 2000 }] }).qAtPwf, 810, 1e-3, 'O2b q@3500');
    // O2c — straight-line PI on the O2a point: no bubble-point verdict
    r = f({ method: 'pi', pr: 4000, pb: 3000, points: [{ q: 1000, pwf: 3500 }] });
    rel(r.J, 2.0, 1e-3, 'O2c J'); rel(r.qmax, 8000, 1e-3, 'O2c qmax');
    yes(!r.warnings.some(function (w) { return /bubble point/.test(w); }), 'O2c no bubble-point verdict');
    // O3 — Standing flow efficiency
    r = f(base({ fe: 0.7, pwfDesign: 1200, qTarget: 150 }));
    rel(r.qmaxFE1, 344.2, 1e-3, 'O3 qmax(FE=1) 0.7'); rel(r.qAtPwf, 183.1, 1e-3, 'O3 q@1200 0.7');
    rel(r.qmax, 298.8, 1e-3, 'O3 qmax 0.7'); rel(r.pwfAtQ, 1454.0, 1e-3, 'O3 pwf@150 0.7');
    r = f(base({ fe: 1.3, pwfDesign: 1200 }));
    rel(r.qmaxFE1, 199.8, 1e-3, 'O3 qmax(FE=1) 1.3'); rel(r.pwfLimitFE, 553.8, 1e-3, 'O3 pwf_lim');
    rel(r.qAtPwf, 166.2, 1e-3, 'O3 q@1200 1.3');
    rel(f(base({ fe: 1.3, pwfDesign: 1000 })).qAtPwf, 180.8, 1e-3, 'O3 q@1000 1.3');
    yes(r.warnings.some(function (w) { return /FE > 1/.test(w); }), 'O3 FE>1 verdict');
    yes(r.table.every(function (t) { return t.pwf < 553.8 ? (t.heldAtMax && Math.abs(t.q - r.qmaxFE1) < 1e-9) : !t.heldAtMax; }), 'O3 held rows');
    // O4 — Fetkovich multipoint
    r = f({ method: 'fetk', pr: 2000, pwfDesign: 1000, qTarget: 1000, prFuture: 1800,
            points: [{ q: 500, pwf: 1800 }, { q: 900, pwf: 1600 }, { q: 1200, pwf: 1400 }] });
    yes(r.ok && r.mode === 'fetkovich', 'O4 mode');
    count++; if (!(Math.abs(r.n - 0.8907) <= 1e-4)) fails.push('O4 n: expected 0.8907, got ' + r.n);
    rel(r.C, 2.9027e-3, 1e-3, 'O4 C'); rel(r.r2, 0.9993, 1e-3, 'O4 R2'); rel(r.qmax, 2205.5, 1e-3, 'O4 qmax');
    rel(r.qAtPwf, 1707.0, 1e-3, 'O4 q@1000'); rel(r.pwfAtQ, 1534.3, 1e-3, 'O4 pwf@1000');
    rel(r.future.C, 2.6124e-3, 1e-3, 'O4 C_f'); rel(r.future.qmax, 1645.3, 1e-3, 'O4 qmax_f');
    // Validation — messages, never NaN
    r = f({ method: 'vogel', pr: '', pb: 2400, points: [{ q: 100, pwf: 1800 }] });
    yes(!r.ok && r.errors.length && r.errorKeys.indexOf('pr') !== -1, 'blank pr → error');
    r = f(base({ points: [{ q: 100, pwf: null }] }));
    yes(!r.ok && r.errorKeys.indexOf('pwf1') !== -1, 'partly filled row → error');
    r = f({ method: 'fetk', pr: 2000, points: [{ q: 500, pwf: 1600 }, { q: 900, pwf: 1600 }] });
    yes(!r.ok && /same flowing pressure/.test(r.errors.join(' ')), 'equal pwf → error');
    r = f(base({ fe: 2.5 }));
    yes(!r.ok && r.errorKeys.indexOf('fe') !== -1, 'FE range → error');
    r = f(base({ qTarget: 300 }));
    yes(r.ok && r.pwfAtQ == null && r.warnings.some(function (w) { return /^✗ Target rate exceeds/.test(w); }), 'qt ≥ qmax → ✗ verdict');

    if (fails.length) throw new Error('[42-calc-oilipr] self-test failed (' + fails.length + '/' + count + '):\n  ' + fails.join('\n  '));
    if (typeof window === 'undefined' && typeof console !== 'undefined') console.log('[42-calc-oilipr] self-test: ' + count + '/' + count + ' checks passed');
})();
