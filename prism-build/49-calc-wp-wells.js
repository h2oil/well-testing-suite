// =============================================================================
// WTS — 49-calc-wp-wells.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// The "All wells" card of the Well Performance page (docs/WELL-PERFORMANCE-PLAN.md §18.3 WP28, §1.4 K1 / K2; owner GUI requirement:
// interactive, deviation first). It runs WTS_wp_batch.job() through the page's Job driver (PRiSM_autoInterp.drive, progress and
// Cancel) and draws the result inside #wp_res (so the page report and the Quick Report carry it):
//   KPI chips (wells solved, total oil / water / gas of the stable wells, unstable or unsolved wells, loading risk),
//   an interactive map of the operating points with three views — normalised (q / AOF against p_wf / p̄r: every well, oil and
//   gas, on one plot with its inflow and outflow curves), rate against flowing BHP (liquid or gas wells) and the well paths
//   (vertical section against TVD with the mid-perforation of each well, MD and TVD in the read-out) — crosshair read-out,
//   zoom / pan (WTS_wp_view.chart), click or keyboard selection of a well, "Open this well" (WTS_wells.switchTo), and a
//   summary table (dtable) with a ✓ / ! / ✕ chip per well, MD · TVD of the mid-perforation and the deviation of each well.
// Read-only per well: the engine never writes; only "Open this well" (a user action) switches the active well.
//
// API used by the page (49-calc-wellperf.js calls each at call time, when this module is present):
//   WTS_wp_wellsUi.html()           the #wp_wells placeholder inside #wp_res
//   WTS_wp_wellsUi.stepHtml()       the step ⑦ card (Run all wells)
//   WTS_wp_wellsUi.render()         draw / refresh the card (after every page render; the stale chip follows the open well's inputs)
//   WTS_wp_wellsUi.act(act, btn)    data-act 'wellsrun' | 'wellsopen' | 'wellscsv' | 'wellsview' | 'wellskind' | 'wellssel'
//   WTS_wp_wellsUi.summary()        compact copy for WTS_state.wellperf.wells (null without a run)
//   WTS_wp_wellsUi.csvLines(q)      lines for the page's CSV bundle (display units)
//   WTS_wp_wellsUi.redraw()         canvas redraw (resize)
// It reads the page helpers from WTS_wellperf_page.ui (units, escaping, the Job driver, the live controls).
// No timers, no polling, no function wrapping.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var S = { res: null, sel: null, err: null };
    var PAL = ['#f0883e', '#58a6ff', '#3fb950', '#bc8cff', '#d29922', '#39c5cf', '#ff7b72', '#a5d6ff', '#e3b341', '#7ee787', '#d2a8ff', '#ffa657'];
    var CHIP = { ok: '✓', warn: '!', fail: '✕', none: '–' };
    var CHIP_T = { ok: 'stable, no warnings', warn: 'stable, with warnings', fail: 'unstable or no operating point', none: 'no Well Performance inputs' };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function U() {
        var P = G.WTS_wellperf_page, u = P && P.ui;
        if (u) return u;
        var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
        var fmt = function (v, d) { return _fin(v) ? Number(v).toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }) : '—'; };
        return { esc: esc, fmt: fmt, dv: function (v) { return v; }, lab: function (c, imp) { return imp; }, u: function (v, c, d, imp) { return _fin(v) ? fmt(v, d) + ' ' + imp : '—'; }, liveScalars: function () { return null; }, drive: null, vHtml: function (v) { return '<div>' + esc(v.t) + '</div>'; } };
    }
    function _pref(k, d) { try { var s = (typeof localStorage !== 'undefined') ? localStorage.getItem('wtspref_wp_plots') : null, p = s ? JSON.parse(s) : null; return p && p[k] != null ? p[k] : d; } catch (e) { return d; } }
    function _prefSet(k, v) {
        try {
            var s = (typeof localStorage !== 'undefined') ? localStorage.getItem('wtspref_wp_plots') : null, p = (s && JSON.parse(s)) || {};
            p[k] = v; if (typeof G.WTS_lsSet === 'function') G.WTS_lsSet('wtspref_wp_plots', JSON.stringify(p));
        } catch (e) { /* device pref only */ }
    }
    function _wells() { try { return (G.WTS_wells && typeof G.WTS_wells.list === 'function') ? G.WTS_wells.list() || [] : []; } catch (e) { return []; } }
    function _activeId() { try { return (G.WTS_wells && typeof G.WTS_wells.active === 'function') ? G.WTS_wells.active() : null; } catch (e) { return null; } }
    function _color(i) { return PAL[i % PAL.length]; }
    function _rows() { return (S.res && S.res.rows) || []; }
    function _rowIdx(id) { var r = _rows(); for (var i = 0; i < r.length; i++) if (String(r[i].id) === String(id)) return i; return -1; }

    // ── the open well's inputs against the run (stale chip) ────────────────────────────────────────────────────────
    function _stale() {
        if (!S.res) return null;
        var ids = _wells().map(function (w) { return w.id; }), ran = _rows().map(function (r) { return r.id; });
        if (ids.length && (ids.length !== ran.length || ids.some(function (id) { return ran.indexOf(id) === -1; }))) return 'the well list changed';
        var P = G.WTS_wellperf_page, st = P && P.state ? P.state() : null, B = G.WTS_wp_batch, act = _activeId();
        var r = _rows()[_rowIdx(act)] || (ran.length === 1 ? _rows()[0] : null);
        if (r && st && st.M && B && r.status !== 'none' && r.key && B.key(st.M) !== r.key) return 'the open well\'s inputs changed';
        return null;
    }

    // ── markup ─────────────────────────────────────────────────────────────────────────────────────────────────────
    function html() { return '<div id="wp_wells" class="wp-wells-host"></div>'; }
    function stepHtml() {
        var u = U(), w = _wells(), n = Math.max(1, w.length);
        return '<div class="card wp-card"><div class="card-title">All wells in the project</div>' +
            '<div class="wp-notes">' + (n > 1 ? 'This project has ' + n + ' wells: ' + u.esc(w.map(function (x) { return x.name; }).join(', ')) + '. ' : 'This project has one well; add wells with the well menu in the page header. ') +
            'Each well is read from its own saved inputs (the open well from this page) and solved with its own model; no well is changed. The result — the operating points of every well on one map and a summary table — is part of the page report.</div>' +
            '<div class="wp-btns rp-skip"><button type="button" class="btn btn-primary" data-act="wellsrun">Run all wells</button></div></div>';
    }

    function _kpi(l, v, s, st) {
        var u = U();
        return '<div class="kpi wp-kpi st-' + (st || 'none') + '" role="group" aria-label="' + u.esc(l + ' ' + v) + '"><div class="kpi-l">' + u.esc(l) + '</div><div class="kpi-v">' + u.esc(v) + '</div>' + (s ? '<div class="kpi-s">' + u.esc(s) + '</div>' : '') + '</div>';
    }
    function _rate(r) { var u = U(); if (!_fin(r.q)) return '—'; return r.gas ? u.u(r.q, 'gasRateSmall', 0, 'Mscf/d') : u.u(r.q, 'liquidRate', 0, 'STB/d'); }
    function _depth(md, tvd) { var u = U(); if (!_fin(md)) return '—'; return u.u(md, 'length', 0, 'ft') + ' MD' + (_fin(tvd) ? ' · ' + u.u(tvd, 'length', 0, 'ft') + ' TVD' : ''); }
    function _dev(g) { var u = U(); if (!g || !_fin(g.tdMd)) return '—'; var t = _fin(g.incMax) && g.incMax >= 0.5 ? u.fmt(g.incMax, 0) + '°' : 'vertical'; if (_fin(g.hzMd) && g.hzMd > 0) t += ' · horizontal ' + u.u(g.hzMd, 'length', 0, 'ft'); else if (_fin(g.dep) && g.dep > 1) t += ' · departure ' + u.u(g.dep, 'length', 0, 'ft'); return t; }
    function _corr(r) { var e = r.corr && G.WTS_flowline_corr ? G.WTS_flowline_corr[r.corr] : null; var n = e ? String(e.label || r.corr).replace(/\s*\(.*$/, '') : (r.corr || '—'); return n + (r.provisional ? ' (provisional)' : ''); }

    function _kpis() {
        var u = U(), c = S.res.counts || {}, t = S.res.totals || {}, out = [], rows = _rows();
        var nIn = (c.n || 0) - (c.none || 0);
        out.push(_kpi('Wells solved', (c.solved || 0) + ' / ' + nIn, (c.none ? c.none + ' without inputs' : 'every well with inputs'), nIn === 0 ? 'none' : (c.solved === nIn ? (c.warn ? 'warn' : 'ok') : 'fail')));
        if (t.nOil || !t.nGas) out.push(_kpi('Oil (stable)', u.u(t.qo, 'liquidRate', 0, 'STB/d'), t.nOil + ' oil well' + (t.nOil === 1 ? '' : 's'), 'info'));
        out.push(_kpi('Water', u.u(t.qw, 'liquidRate', 0, 'BWPD'), 'stable wells', 'info'));
        out.push(_kpi('Gas', u.u((t.qg || 0) / 1000, 'gasRate', 2, 'MMscf/d'), t.nGas ? t.nGas + ' gas well' + (t.nGas === 1 ? '' : 's') : 'solution gas', 'info'));
        var bad = (c.unstable || 0) + (c.failed || 0);
        out.push(_kpi('Unstable', String(bad), bad ? rows.filter(function (r) { return r.verdict === 'fail' && r.status !== 'none'; }).map(function (r) { return r.name; }).slice(0, 3).join(', ') : 'none', bad ? 'fail' : 'ok'));
        var gasR = rows.filter(function (r) { return r.gas && r.status === 'ok'; }), risk = gasR.filter(function (r) { return _fin(r.loadingMargin) && r.loadingMargin < 0.1; });
        if (gasR.length) out.push(_kpi('Loading risk', String(risk.length), risk.length ? risk.map(function (r) { return r.name; }).slice(0, 3).join(', ') : 'margins ≥ 10 %', risk.length ? (risk.some(function (r) { return r.loadingMargin < 0; }) ? 'fail' : 'warn') : 'ok'));
        return out.join('');
    }
    function _table() {
        var u = U(), act = _activeId();
        var head = ['', 'Well', 'Fluid', 'Rate', 'Flowing BHP (' + u.lab('pressure', 'psia') + ')', 'THP (' + u.lab('pressureG', 'psig') + ')', 'THT (' + u.lab('temperature', '°F') + ')', 'Bean (/64 in)', 'Stability', 'Mid-perforation', 'Deviation', 'Correlation'];
        var body = _rows().map(function (r, i) {
            var st = r.verdict || 'none', sel = String(r.id) === String(S.sel);
            var stab = r.status !== 'ok' ? (r.status === 'none' ? 'no inputs' : (r.error || 'no solution')) : (r.stable ? 'stable' : 'unstable') + (_fin(r.marginQs) ? ' · q/q_s ' + u.fmt(1 + r.marginQs, 2) : '') + (_fin(r.loadingMargin) ? ' · loading ' + (r.loadingMargin >= 0 ? '+' : '') + u.fmt(100 * r.loadingMargin, 0) + ' %' : '');
            return '<tr data-well="' + u.esc(r.id) + '" tabindex="0" class="wp-wrow' + (sel ? ' wp-sel' : '') + '" aria-selected="' + (sel ? 'true' : 'false') + '">' +
                '<td class="qc"><span class="wp-qcb ' + st + '" title="' + u.esc(CHIP_T[st]) + '">' + CHIP[st] + '</span></td>' +
                '<td><span class="wp-cdot" style="background:' + _color(i) + '"></span>' + u.esc(r.name) + (String(r.id) === String(act) || (r.active && !act) ? ' <span class="wp-chip">open</span>' : '') + '</td>' +
                '<td>' + u.esc(r.fluid || '—') + '</td><td class="num">' + u.esc(_rate(r)) + '</td>' +
                '<td class="num">' + (_fin(r.pwf) ? u.fmt(u.dv(r.pwf, 'pressure'), 0) : '—') + '</td><td class="num">' + (_fin(r.thp) ? u.fmt(u.dv(r.thp, 'pressureG'), 0) : '—') + '</td>' +
                '<td class="num">' + (_fin(r.tht) ? u.fmt(u.dv(r.tht, 'temperature'), 0) : '—') + '</td><td class="num">' + (r.choke ? (_fin(r.bean) ? u.fmt(r.bean, 0) : '—') : 'no choke') + '</td>' +
                '<td>' + u.esc(stab) + '</td><td>' + u.esc(_depth(r.well && r.well.midMd, r.well && r.well.midTvd)) + '</td><td>' + u.esc(_dev(r.well)) + '</td><td>' + u.esc(r.status === 'none' ? '—' : _corr(r)) + '</td></tr>';
        }).join('');
        return '<div class="wp-tw"><table class="dtable wp-cmpt wp-wtbl wp-dense" aria-label="Operating point of every well"><thead><tr>' + head.map(function (h) { return '<th>' + u.esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }
    function _selHtml() {
        var u = U(), i = _rowIdx(S.sel), r = _rows()[i], act = _activeId();
        if (!r) return '';
        var isOpen = String(r.id) === String(act) || (r.active && !act);
        var parts = [_rate(r), _fin(r.pwf) ? 'BHP ' + u.u(r.pwf, 'pressure', 0, 'psia') : null, _fin(r.thp) ? 'THP ' + u.u(r.thp, 'pressureG', 0, 'psig') : null,
            r.well && _fin(r.well.midMd) ? 'mid-perf ' + _depth(r.well.midMd, r.well.midTvd) : null, r.well ? _dev(r.well) : null].filter(Boolean);
        return '<div class="wp-wsel"><span class="wp-cdot" style="background:' + _color(i) + '"></span><b>' + u.esc(r.name) + '</b><span class="wp-wsel-t">' + u.esc(r.status === 'ok' ? parts.join(' · ') : (r.error || 'no operating point')) + '</span>' +
            (isOpen ? '<span class="wp-chip">open on this page</span>' : (r.id != null ? '<button type="button" class="btn btn-secondary" data-act="wellsopen" data-well="' + u.esc(r.id) + '">Open this well</button>' : '')) + '</div>';
    }

    // ── the map (three views) ──────────────────────────────────────────────────────────────────────────────────────
    function _view() { var v = _pref('wellsView', 'norm'); return (v === 'abs' || v === 'paths') ? v : 'norm'; }
    function _kinds() { var r = _rows().filter(function (x) { return x.status === 'ok'; }); return { gas: r.some(function (x) { return x.gas; }), liq: r.some(function (x) { return !x.gas; }) }; }
    function _kind() { var k = _kinds(), p = _pref('wellsKind', 'liq'); if (k.gas && !k.liq) return 'gas'; if (k.liq && !k.gas) return 'liq'; return p === 'gas' ? 'gas' : 'liq'; }
    function _spec() {
        var u = U(), V = G.WTS_wp_view, T = V && V.theme ? V.theme() : {}, view = _view(), rows = _rows(), sel = S.sel, many = rows.length > 8;
        var series = [], markers = [], picks = [];
        var dimmed = function (i, r) { return sel != null && String(r.id) !== String(sel); };
        if (view === 'paths') {
            rows.forEach(function (r, i) {
                var g = r.well || {}, tr = g.traj || [];
                if (tr.length < 2) return;
                var pts = tr.map(function (p) { return [u.dv(p[0], 'length'), u.dv(p[1], 'length')]; });
                series.push({ key: 'w' + i, label: r.name, color: _color(i), pts: pts, width: dimmed(i, r) ? 1.4 : 2.6, legend: rows.length <= 10,
                              info: tr.map(function (p) { return [r.name, u.u(p[2], 'length', 0, 'ft') + ' MD · ' + u.u(p[1], 'length', 0, 'ft') + ' TVD', 'section ' + u.u(p[0], 'length', 0, 'ft')]; }) });
                if (_fin(g.midMd) && _fin(g.midTvd)) {
                    // the mid-perforation on the path (the trajectory point nearest in MD)
                    var best = tr[0]; tr.forEach(function (p) { if (Math.abs(p[2] - g.midMd) < Math.abs(best[2] - g.midMd)) best = p; });
                    var x = u.dv(best[0], 'length'), y = u.dv(g.midTvd, 'length');
                    markers.push({ x: x, y: y, kind: r.status === 'ok' ? (r.stable ? 'filled' : 'hollow') : 'diamond', color: _color(i), r: String(r.id) === String(sel) ? 8 : 6, label: r.name + (r.status === 'ok' ? ' · ' + _rate(r) : '') });
                    picks.push({ id: r.id, x: x, y: y });
                }
            });
            return { key: 'wells-paths', aspect: 0.62, minH: 300, maxH: 560, w: 760,
                x: { label: 'Vertical section (' + u.lab('length', 'ft') + ')', short: 'VS' }, y: { label: 'TVD (' + u.lab('length', 'ft') + ')', invert: true, min: 0, short: 'TVD' },
                series: series, markers: markers, readout: 'near', empty: 'No well has a survey yet.', _picks: picks };
        }
        if (view === 'abs') {
            var kind = _kind(), gas = kind === 'gas', rc = gas ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d'];
            rows.forEach(function (r, i) {
                if (r.status !== 'ok' || !!r.gas !== gas) return;
                var dim = dimmed(i, r), show = !many || !dim;
                if (show && r.curves && r.curves.ipr.length) series.push({ key: 'i' + i, label: r.name + ' inflow', color: _color(i), pts: r.curves.ipr.map(function (p) { return [u.dv(p[0], rc[0]), u.dv(p[1], 'pressure')]; }), width: dim ? 1 : 2.2, legend: false });
                if (show && r.curves && r.curves.vlp.length) series.push({ key: 'o' + i, label: r.name + ' outflow', color: _color(i), pts: r.curves.vlp.map(function (p) { return [u.dv(p[0], rc[0]), u.dv(p[1], 'pressure')]; }), width: dim ? 1 : 2, dash: [6, 4], legend: false });
                var x = u.dv(r.op.q, rc[0]), y = u.dv(r.op.p, 'pressure');
                markers.push({ x: x, y: y, kind: r.stable ? 'filled' : 'hollow', color: _color(i), r: String(r.id) === String(sel) ? 8 : 6, label: r.name });
                series.push({ key: 'p' + i, kind: 'points', color: _color(i), pts: [[x, y]], legend: false, info: [[r.name, _rate(r) + ' · BHP ' + u.u(r.op.p, 'pressure', 0, 'psia'), _fin(r.thp) ? 'THP ' + u.u(r.thp, 'pressureG', 0, 'psig') + (r.choke && _fin(r.bean) ? ' · bean ' + r.bean + '/64' : '') : '', r.well && _fin(r.well.midMd) ? 'mid-perf ' + _depth(r.well.midMd, r.well.midTvd) : '']] });
                picks.push({ id: r.id, x: x, y: y });
            });
            return { key: 'wells-abs', aspect: 0.56, minH: 280, maxH: 520, w: 760,
                x: { label: (gas ? 'Gas rate' : 'Liquid rate') + ' (' + u.lab(rc[0], rc[1]) + ')', min: 0, short: 'q' }, y: { label: 'Flowing BHP (' + u.lab('pressure', 'psia') + ')', min: 0, short: 'p_wf' },
                series: series, markers: markers, readout: 'near', legendNote: 'solid: inflow · dashed: outflow · filled: stable · hollow: unstable', empty: 'No ' + (gas ? 'gas' : 'liquid') + ' well has an operating point.', _picks: picks };
        }
        // normalised: q / AOF against p_wf / p̄r — oil and gas wells together
        rows.forEach(function (r, i) {
            if (r.status !== 'ok' || !_fin(r.aof) || !(r.aof > 0) || !_fin(r.pr) || !(r.pr > 0)) return;
            var dim = dimmed(i, r), show = !many || !dim, nz = function (p) { return [p[0] / r.aof, p[1] / r.pr]; };
            if (show && r.curves && r.curves.ipr.length) series.push({ key: 'i' + i, label: r.name, color: _color(i), pts: r.curves.ipr.map(nz), width: dim ? 1 : 2.2, legend: rows.length <= 10 });
            if (show && r.curves && r.curves.vlp.length) series.push({ key: 'o' + i, label: r.name + ' outflow', color: _color(i), pts: r.curves.vlp.map(nz).filter(function (p) { return p[0] <= 1.05 && p[1] <= 1.6; }), width: dim ? 1 : 1.8, dash: [6, 4], legend: false });
            var x = r.q / r.aof, y = r.op.p / r.pr;
            markers.push({ x: x, y: y, kind: r.stable ? 'filled' : 'hollow', color: _color(i), r: String(r.id) === String(sel) ? 8 : 6, label: r.name });
            series.push({ key: 'p' + i, kind: 'points', color: _color(i), pts: [[x, y]], legend: false, info: [[r.name, _rate(r) + ' · ' + U().fmt(100 * x, 0) + ' % of AOF', 'BHP ' + U().u(r.op.p, 'pressure', 0, 'psia') + ' · ' + U().fmt(100 * y, 0) + ' % of p̄r', r.well && _fin(r.well.midMd) ? 'mid-perf ' + _depth(r.well.midMd, r.well.midTvd) : '']] });
            picks.push({ id: r.id, x: x, y: y });
        });
        return { key: 'wells-norm', aspect: 0.56, minH: 280, maxH: 520, w: 760,
            x: { label: 'Rate / AOF (–)', min: 0, max: 1.02, short: 'q/AOF' }, y: { label: 'Flowing BHP / p̄r (–)', min: 0, max: 1.05, short: 'p_wf/p̄r' },
            series: series, markers: markers, readout: 'near', legendNote: 'solid: inflow · dashed: outflow · filled: stable · hollow: unstable', empty: 'No well has an operating point and an AOF.', _picks: picks };
    }
    function _draw() {
        var cv = _byId('wp_cv_wells'), V = G.WTS_wp_view; if (!cv || !V) return;
        var sp = _spec();
        S.picks = sp._picks; delete sp._picks;
        V.chart(cv, sp);
        if (!cv._wwBound && cv.addEventListener) {
            cv._wwBound = true;
            var down = null;
            cv.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
            cv.addEventListener('click', function (e) {
                if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;      // a pan, not a pick
                var ax = cv._wpAxes, r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : null; if (!ax || !r || !S.picks) return;
                var px = (e.clientX - r.left) * (r.width > 0 ? ax.w / r.width : 1), py = (e.clientY - r.top) * (r.height > 0 ? ax.h / r.height : 1), best = null, bd = 22 * 22;
                S.picks.forEach(function (p) { var d = Math.pow(ax.toX(p.x) - px, 2) + Math.pow(ax.toY(p.y) - py, 2); if (d < bd) { bd = d; best = p; } });
                if (best) select(best.id);
            });
        }
    }
    function select(id) {
        S.sel = (S.sel != null && String(S.sel) === String(id)) ? null : id;
        var h = _byId('wp_wsel'); if (h) h.innerHTML = _selHtml();
        Array.prototype.forEach.call((_byId('wp_wells') || { querySelectorAll: function () { return []; } }).querySelectorAll('tr.wp-wrow'), function (tr) {
            var on = S.sel != null && tr.getAttribute('data-well') === String(S.sel);
            if (tr.classList) tr.classList.toggle('wp-sel', on); tr.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        _draw();
    }

    function render() {
        var host = _byId('wp_wells'); if (!host) return;
        var u = U(), n = _wells().length;
        if (!S.res) {
            host.className = 'wp-wells-host';
            host.innerHTML = (n > 1 ? '<div class="wp-wells-cta rp-skip"><span>This project has ' + n + ' wells.</span><button type="button" class="btn btn-secondary" data-act="wellsrun">Run all wells</button><span class="wp-hint" style="margin:0">operating points of every well on one map</span></div>' : '') +
                '<div id="wp_wellsjob" class="rp-skip"></div>' + (S.err ? u.vHtml({ st: 'fail', t: '✗ ' + S.err }) : '');
            return;
        }
        var view = _view(), k = _kinds(), stale = _stale(), c = S.res.counts || {};
        var seg = function (key, vals, cur) { return '<span class="wp-seg">' + vals.map(function (v) { return '<button type="button" data-act="' + key + '" data-v="' + v[0] + '" class="' + (v[0] === cur ? 'on' : '') + '" aria-pressed="' + (v[0] === cur) + '">' + v[1] + '</button>'; }).join('') + '</span>'; };
        var tools = seg('wellsview', [['norm', 'Normalised'], ['abs', 'Rate – BHP'], ['paths', 'Well paths']], view) + (view === 'abs' && k.gas && k.liq ? seg('wellskind', [['liq', 'Liquid'], ['gas', 'Gas']], _kind()) : '');
        host.className = 'card wp-card wp-wells';
        host.innerHTML = '<div class="wp-card-h"><div class="card-title">All wells — operating points</div><span class="wp-tools rp-skip">' + tools + '</span></div>' +
            '<div class="wp-hint">' + u.esc((c.n || 0) + ' well' + (c.n === 1 ? '' : 's') + ' solved with their own saved inputs (read only)' + (S.res.ts ? ', ' + new Date(S.res.ts).toLocaleString() : '') + (S.res.cancelled ? ' — cancelled, partial' : '')) + '</div>' +
            (stale ? '<span class="wp-stalechip">Previous inputs: ' + u.esc(stale) + ' — run again</span>' : '') +
            '<div class="wp-kpis wp-wkpis">' + _kpis() + '</div>' +
            '<div class="chart-wrap"><canvas id="wp_cv_wells" aria-label="Map of the operating points of every well; click a point to pick a well" tabindex="0"></canvas></div>' +
            '<div class="wp-legend-hint rp-skip">Hover for each well\'s numbers (MD and TVD in the well-path view); click a point or a table row to pick a well; wheel or pinch to zoom, drag to pan, double-click to reset.</div>' +
            '<div id="wp_wsel" class="rp-skip">' + _selHtml() + '</div>' + _table() +
            '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-act="wellsrun">Run again</button><button type="button" class="btn btn-secondary" data-act="wellscsv">Export CSV</button></div>' +
            '<div id="wp_wellsjob" class="rp-skip"></div>';
        _draw();
    }

    // ── actions ────────────────────────────────────────────────────────────────────────────────────────────────────
    function run() {
        var u = U(), B = G.WTS_wp_batch;
        if (!B || typeof B.job !== 'function') { S.err = 'the batch engine is not available'; render(); return; }
        var job = B.job({ liveScalars: u.liveScalars ? u.liveScalars() : null });
        S.err = null;
        if (!_byId('wp_wellsjob')) render();
        var done = function (r) {
            if (r && (r.ok || (r.rows && r.rows.length))) { S.res = r; if (S.sel != null && _rowIdx(S.sel) === -1) S.sel = null; }
            else S.err = (r && r.errors && r.errors[0]) || 'no well could be solved';
            render();
            var P = G.WTS_wellperf_page; if (P && typeof P.publishWells === 'function') P.publishWells();
        };
        if (u.drive) u.drive(job, done, 'All wells', 'wp_wellsjob');
        else { var s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 100000); done(job.result()); }
    }
    function act(a, btn) {
        if (a === 'wellsrun') { run(); return; }
        if (a === 'wellsview') { _prefSet('wellsView', btn.getAttribute('data-v')); render(); return; }
        if (a === 'wellskind') { _prefSet('wellsKind', btn.getAttribute('data-v')); render(); return; }
        if (a === 'wellssel') { select(btn.getAttribute('data-well')); return; }
        if (a === 'wellscsv') {
            var B = G.WTS_wp_batch; if (!B || !S.res) return;
            var csv = B.csv(S.res); S.lastCsv = csv;
            try {
                var blob = new Blob([csv], { type: 'text/csv' }), el = document.createElement('a');
                el.href = URL.createObjectURL(blob); el.download = 'well_performance_all_wells_' + new Date().toISOString().slice(0, 10) + '.csv'; el.click();
                if (URL.revokeObjectURL) URL.revokeObjectURL(el.href);
            } catch (e) { /* no download in this environment */ }
            return;
        }
        if (a === 'wellsopen') {
            var id = btn.getAttribute('data-well'), W = G.WTS_wells;
            if (W && typeof W.switchTo === 'function' && id) { S.sel = id; W.switchTo(id); }
        }
    }
    function onKey(e) {
        var t = e.target, tr = t && t.closest ? t.closest('tr.wp-wrow') : null;
        if (!tr) return false;
        if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); select(tr.getAttribute('data-well')); return true; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            var sib = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
            if (sib && sib.focus) { if (e.preventDefault) e.preventDefault(); sib.focus(); }
            return true;
        }
        return false;
    }
    function onClick(e) {
        var t = e.target, tr = t && t.closest ? t.closest('tr.wp-wrow') : null;
        if (!tr || (t.closest && t.closest('button'))) return false;
        select(tr.getAttribute('data-well'));
        return true;
    }
    function summary() {
        if (!S.res) return null;
        return { ts: S.res.ts, counts: S.res.counts, totals: S.res.totals, cancelled: !!S.res.cancelled,
                 rows: _rows().map(function (r) { return { id: r.id, name: r.name, status: r.status, verdict: r.verdict, gas: !!r.gas, q: r.q, qo: r.qo, qw: r.qw, qg: r.qg, pwf: r.pwf, thp: r.thp, tht: r.tht, stable: !!r.stable,
                     midMd: r.well ? r.well.midMd : null, midTvd: r.well ? r.well.midTvd : null, incMax: r.well ? r.well.incMax : null }; }) };
    }
    function csvLines(q) {
        if (!S.res || !G.WTS_wp_batch) return [];
        var T = G.WTS_wp_batch.table(S.res), L = ['', 'All wells (field units)'];
        L.push(T.head.map(q).join(','));
        T.rows.forEach(function (r) { L.push(r.map(function (v) { return v == null ? '' : (typeof v === 'number' ? (isFinite(v) ? String(+v.toPrecision(8)) : '') : q(v)); }).join(',')); });
        return L;
    }

    G.WTS_wp_wellsUi = {
        html: html, stepHtml: stepHtml, render: render, act: act, onKey: onKey, onClick: onClick, select: select, summary: summary, csvLines: csvLines,
        redraw: function () { if (S.res) _draw(); }, state: function () { return S; }, reset: function () { S.res = null; S.sel = null; S.err = null; }, spec: _spec, VERSION: '1.0.0'
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, W = G.WTS_wp_wellsUi;
    if (!(W && typeof W.render === 'function' && /wp_wells/.test(W.html())) && typeof console !== 'undefined') console.error('[wp-wells self-test] module malformed');
})();
