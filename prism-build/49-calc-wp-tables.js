// =============================================================================
// WTS — 49-calc-wp-tables.js  (Round 9; helper module of the page 49-calc-wellperf.js: no entry in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance step ⑦ — lift-curve tables and PVT tables (WP20, increment B). docs/WELL-PERFORMANCE-PLAN.md §9, §10 (⑦ "(B)
// lift-table export"), §2.9, §13, D9, D17 and the owner GUI requirement (interactive plots, deviation first class, KPI chips).
//
// The page mounts this panel: WTS_wp_tables.html() inside the step ⑦ section, bind() after the page binds its root, and the summary
// box #wp_ltsum inside #wp_res (always visible, so the page PDF / PNG and the Quick Report carry the last table). The engine is
// WTS_wp_export (49-calc-wp-export.js); this file only reads the page model (WTS_wellperf_page.state().M / .R / .I / .W), drives the
// Job through PRiSM_autoInterp.drive (progress, Cancel) and draws.
//   Lift-curve table card: rate / THP / water-fraction / gas-fraction / lift-quantity axes in the table's field units (the export is
//   always field units, §13), table number, datum MD with its TVD read on the surveyed path; Fill from the model; point count and a
//   time estimate; Run (a Job); KPI chips (points, filled, THP monotone, single-minimum rows, datum MD · TVD); an interactive chart of
//   BHP against rate, one curve per THP (crosshair, zoom / pan, legend toggles), filled points hollow, the model's inflow curve with the
//   operating point at each THP where the slice is the model's own fluid, and a draggable rate line that reads every THP's BHP; sliders
//   pick the water-fraction / gas-fraction / lift slice; the slice table with the tubing-curve minimum of each row; downloads in the
//   lift-curve table text format and as CSV (long format).
//   PVT table card: the number of pressures, a preview chip (rows, bubble point, provisional families) and downloads (CSV in the
//   display units, the black-oil PVT table text format in field units).
// Controls carry ids wplt_* (autosaved with the page, not wp_*, so they never trigger a solve). No timers, no polling, no wrapping.
// Public (for the page and the tests): WTS_wp_tables = {html(), bind(), refresh(), run(), state(), act(name), handle(key, v, phase),
// last (the last download {name, size, text})}.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var PATM = 14.696, MS_PER_POINT = 13;          // container estimate per lift-table point (wellperf-validate --time)
    var S = { T: null, key: null, stale: false, job: null, autoSig: null, sel: { w: 0, g: 0, a: 0 }, cursor: null, pvt: null, bound: false };

    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _X() { return G.WTS_wp_export; }
    function _page() { var P = G.WTS_wellperf_page; return P && typeof P.state === 'function' ? P.state() : null; }
    function _M() { var st = _page(); return st && st.M ? st.M : null; }
    function _R() { var st = _page(); return st && st.R && st.R.ok ? st.R : null; }
    function _U() { return G.WTS_units; }
    function _metric() { var U = _U(); return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _dv(v, cat) { var U = _U(); return (_fin(v) && _metric() && U && U.CATEGORIES && U.CATEGORIES[cat] && U.convertCategory) ? U.convertCategory(v, cat, 'imperial', 'metric') : v; }
    function _lab(cat, imp) { var U = _U(); return (_metric() && U && U.CATEGORIES && U.CATEGORIES[cat]) ? U.CATEGORIES[cat].metric.label : imp; }
    function _fmt(v, d) { if (!_fin(v)) return '—'; var s = Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d == null ? 2 : d }); return s === '-0' ? '0' : s; }
    function _u(v, cat, d, imp) { return _fin(v) ? _fmt(_dv(v, cat), d) + ' ' + _lab(cat, imp) : '—'; }
    function _val(id) { var e = _byId(id); return e ? String(e.value == null ? '' : e.value) : ''; }
    function _set(id, v) { var e = _byId(id); if (e) e.value = v; }
    function _list(s) {
        // whitespace / ';' separated; ',' as a separator only without whitespace (field units, a decimal point)
        var t = String(s == null ? '' : s).trim(); if (!t) return [];
        var parts = /[\s;]/.test(t) ? t.split(/[\s;]+/) : t.split(',');
        return parts.map(function (x) { return parseFloat(String(x).replace(/,/g, '')); }).filter(_fin);
    }
    function _show(v) { return v.map(function (x) { return String(+(+x).toPrecision(6)); }).join(' '); }
    function _now() { try { return (G.performance && typeof G.performance.now === 'function') ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
    function _vh(st, t) { var col = { ok: 'green', warn: 'yellow', fail: 'red' }[st]; return '<div class="wp-v ' + st + '"' + (col ? ' style="color:var(--' + col + ')"' : '') + '>' + _esc(t) + '</div>'; }

    // ── markup ────────────────────────────────────────────────────────────────
    var CSS = '<style>' +
        '#wp_root #wp_ltsum:empty{display:none}#wp_root .wplt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px 14px}' +
        '#wp_root .wplt-ax{display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr);gap:8px;align-items:end;min-width:0}#wp_root .wplt-ax>div{min-width:0}' +
        '#wp_root .wplt-ax input,#wp_root .wplt-ax select{width:100%;min-width:0}' +
        '#wp_root .wplt-axes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:10px 18px;margin-top:10px}' +
        '#wp_root .wplt-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;font-size:12px;color:var(--text2)}' +
        '#wp_root .wplt-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;background:var(--bg3);border:1px solid var(--border);font-variant-numeric:tabular-nums;transition:border-color .2s,color .2s}' +
        '#wp_root .wplt-pill.warn{border-color:rgba(210,153,34,.5);color:var(--yellow,#d29922)}#wp_root .wplt-pill b{color:var(--text)}' +
        '#wp_root .wplt-fix{display:flex;align-items:center;min-height:36px;padding:0 10px;border:1px dashed var(--border);border-radius:6px;font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#wp_root .wplt-kp{grid-template-columns:repeat(auto-fit,minmax(min(100%,132px),1fr))}' +
        '#wp_root .wplt-res{margin-top:12px}#wp_root .wplt-res:empty{display:none}' +
        '#wp_root .wplt-sl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:8px 16px;margin:8px 0 4px}' +
        '#wp_root .wplt-sl label{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}#wp_root .wplt-sl label b{color:var(--text);text-transform:none;letter-spacing:0;font-variant-numeric:tabular-nums}' +
        '#wp_root .wplt-sl input[type=range]{width:100%;accent-color:var(--accent)}' +
        '#wp_root .wplt-read{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--text2);margin:6px 0 2px;min-height:18px}#wp_root .wplt-read span{white-space:nowrap;font-variant-numeric:tabular-nums}#wp_root .wplt-read i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}' +
        '#wp_root .wplt-tbl td.f{font-style:italic;color:var(--yellow,#d29922)}#wp_root .wplt-tbl td.min{box-shadow:inset 0 -2px 0 var(--accent)}' +
        '#wp_root .wplt-pv{display:flex;flex-wrap:wrap;gap:10px;align-items:end}#wp_root .wplt-pv .fg-item{min-width:140px;flex:0 1 180px}' +
        '@media (prefers-reduced-motion:reduce){#wp_root .wplt-pill,#wp_root .wplt-res *{transition:none!important}}' +
        '</style>';
    function _opts(reg, sel) { return Object.keys(reg).map(function (k) { return '<option value="' + _esc(k) + '"' + (k === sel ? ' selected' : '') + ' title="' + _esc(reg[k].label) + '">' + _esc(k ? reg[k].label + ' · ' + reg[k].unit : 'None') + '</option>'; }).join(''); }
    function html() {
        var X = _X(); if (!X) return '';
        var ax = function (key, title, reg, def) {
            return '<div class="wplt-ax" data-ltax="' + key + '"><div class="fg-item"><label for="wplt_' + key + 't">' + _esc(title) + '</label><select id="wplt_' + key + 't">' + _opts(reg, def) + '</select></div>' +
                '<div class="fg-item"><label for="wplt_' + key + 'v">Values</label><input id="wplt_' + key + 'v" type="text" spellcheck="false" autocomplete="off" inputmode="decimal" value=""></div></div>';
        };
        return CSS +
            '<div class="card wp-card" id="wplt_card"><div class="wp-card-h"><div class="card-title">Lift-curve tables</div><span class="wp-tools rp-skip"><span class="wp-chip" id="wplt_kind">producer</span></span></div>' +
            '<div class="wp-notes rp-skip">BHP at the datum for every combination of rate, THP, water fraction, gas fraction and lift quantity — one top-down traverse each with the model\'s correlation, temperature model, tuning and deviated path (the THP is the boundary: no choke, flowline or separator). Export in the lift-curve table text format (producer / injector) or as CSV. Axis values are in the table\'s field units: rates STB/d (gas Mscf/d), THP psia, WC fraction, WGR and OGR STB/Mscf, GOR and GLR Mscf/STB, lift gas Mscf/d.</div>' +
            '<div class="wplt-grid rp-skip" style="margin-top:10px">' +
            '<div class="fg-item"><label for="wplt_no">Table number</label><input id="wplt_no" type="number" min="1" step="1" value="1"></div>' +
            '<div class="fg-item"><label for="wplt_datum">Datum MD (ft) — blank = mid-perforations</label><input id="wplt_datum" type="number" step="any" inputmode="decimal" value="" placeholder="mid-perforations"><div class="wp-hint" id="wplt_datumtvd" aria-live="polite"></div></div>' +
            '</div>' +
            '<div class="wplt-axes rp-skip">' + ax('flo', 'Rate', X.FLO, 'OIL') +
            '<div class="wplt-ax" data-ltax="thp"><div class="fg-item"><label>THP</label><div class="wplt-fix">Wellhead pressure · psia</div></div><div class="fg-item"><label for="wplt_thpv">Values</label><input id="wplt_thpv" type="text" spellcheck="false" autocomplete="off" inputmode="decimal" value=""></div></div>' +
            ax('wfr', 'Water fraction', X.WFR, 'WCT') + ax('gfr', 'Gas fraction', X.GFR, 'GOR') + ax('alq', 'Lift quantity', X.ALQ, '') + '</div>' +
            '<div class="wplt-meta rp-skip" id="wplt_meta" aria-live="polite"></div>' +
            '<div class="wp-btns rp-skip"><button type="button" class="btn btn-secondary" data-lt="suggest">Fill from the model</button><button type="button" class="btn btn-primary" data-lt="run">Run lift table</button>' +
            '<button type="button" class="btn btn-secondary" data-lt="txt" disabled>Download table (text)</button><button type="button" class="btn btn-secondary" data-lt="csv" disabled>Download CSV</button></div>' +
            '<div id="wplt_job" class="rp-skip"></div><div class="wplt-res" id="wplt_res"></div></div>' +
            '<div class="card wp-card" id="wplt_pvtcard"><div class="card-title">PVT table export</div>' +
            '<div class="wp-notes rp-skip">Rs, Bo, μo, co, Z, Bg, μg, Bw, μw and densities against pressure at the reservoir temperature, from the same fluid path as the traverse; the bubble point is always a row. CSV in the page\'s unit system; the black-oil PVT table text format (live oil, dry gas, water) in field units.</div>' +
            '<div class="wplt-pv rp-skip" style="margin-top:10px"><div class="fg-item"><label for="wplt_pvtn">Pressures</label><input id="wplt_pvtn" type="number" min="6" max="40" step="1" value="15"></div>' +
            '<div class="wp-btns" style="margin-top:0"><button type="button" class="btn btn-secondary" data-lt="pvtcsv">Download PVT CSV</button><button type="button" class="btn btn-secondary" data-lt="pvttxt">Download PVT tables (text)</button></div></div>' +
            '<div class="wplt-meta" id="wplt_pvtmeta" aria-live="polite"></div></div>';
    }

    // ── spec from the controls ────────────────────────────────────────────────
    function _spec() {
        return { tableNo: parseInt(_val('wplt_no'), 10) || 1, datumMd: _val('wplt_datum').trim() === '' ? null : parseFloat(_val('wplt_datum')),
            flo: { type: _val('wplt_flot'), values: _list(_val('wplt_flov')) }, thp: _list(_val('wplt_thpv')),
            wfr: { type: _val('wplt_wfrt'), values: _list(_val('wplt_wfrv')) }, gfr: { type: _val('wplt_gfrt'), values: _list(_val('wplt_gfrv')) },
            alq: { type: _val('wplt_alqt'), values: _list(_val('wplt_alqv')) } };
    }
    function _fillSpec(sp) {
        if (!sp) return;
        _set('wplt_no', sp.tableNo || 1); _set('wplt_datum', sp.datumMd == null ? '' : sp.datumMd);
        _set('wplt_flot', sp.flo.type); _set('wplt_flov', _show(sp.flo.values)); _set('wplt_thpv', _show(sp.thp));
        if (sp.wfr) { _set('wplt_wfrt', sp.wfr.type); _set('wplt_wfrv', _show(sp.wfr.values)); }
        if (sp.gfr) { _set('wplt_gfrt', sp.gfr.type); _set('wplt_gfrv', _show(sp.gfr.values)); }
        if (sp.alq) { _set('wplt_alqt', sp.alq.type || ''); _set('wplt_alqv', _show(sp.alq.values)); }
    }
    function _sig() { try { return JSON.stringify(_spec()); } catch (e) { return ''; } }
    // auto = filled from the model and not edited since: such axes follow the model (an example, a new fluid type, a new solve)
    function _suggest(auto) { var X = _X(), M = _M(); if (!X || !M) return; _fillSpec(X.suggest(M, _R())); S.autoSig = auto ? _sig() : null; _meta(); }
    function _mkey(M) { if (!M) return ''; try { var s = JSON.parse(JSON.stringify(M.system || {})); delete s.target; return JSON.stringify([M.fluid, M.well, M.lift, s.corr, s.mult, s.stepFt, M.res && M.res.T_F]); } catch (e) { return ''; } }

    // the axis selects follow the fluid type (only applicable types are enabled); the kind chip; the datum TVD; the point count
    function _sync() {
        var X = _X(), M = _M(); if (!X || !M) return;
        var k = X.kind(M), t = M.fluid && M.fluid.type;
        var chip = _byId('wplt_kind'); if (chip) chip.textContent = k === 'inj' ? 'injector' : (k === 'prod' ? 'producer' : 'not available');
        [['flot', X.FLO], ['wfrt', X.WFR], ['gfrt', X.GFR], ['alqt', X.ALQ]].forEach(function (p) {
            var sel = _byId('wplt_' + p[0]); if (!sel || !sel.options) return;
            var firstOk = null;
            Array.prototype.forEach.call(sel.options, function (o) {
                var e = p[1][o.value], ok = !!e && e.types.indexOf(t) !== -1 && (!e.kinds || e.kinds.indexOf(k) !== -1);
                if (p[0] === 'alqt' && o.value === 'GRAT') ok = ok && !!(M.lift && M.lift.gl && +M.lift.gl.pinj_psig > 0);
                o.disabled = !ok; if (ok && firstOk == null) firstOk = o.value;
            });
            if (sel.selectedIndex >= 0 && sel.options[sel.selectedIndex].disabled && firstOk != null) sel.value = firstOk;
        });
        Array.prototype.forEach.call(document.querySelectorAll('#wplt_card [data-ltax]'), function (el) {
            var a = el.getAttribute('data-ltax'), on = k === 'prod' || a === 'flo' || a === 'thp';
            if (el.classList) el.classList.toggle('wp-off', !on);
        });
        if ((!_val('wplt_flov').trim() && !_val('wplt_thpv').trim()) || (S.autoSig && S.autoSig === _sig())) _suggest(true);
        else _meta();
        _pvt();                                            // the PVT preview pills (rows, temperature, bubble point, provisional)
        var key = _mkey(M);
        if (S.T && S.key && key !== S.key && !S.stale) { S.stale = true; _renderRes(); _renderSum(); }
    }
    function _meta() {
        var X = _X(), M = _M(), h = _byId('wplt_meta'); if (!X || !M || !h) return;
        var nz = X.normalize(M, _spec()), d = nz.datum, dt = _byId('wplt_datumtvd');
        if (dt) dt.textContent = d ? '= ' + _u(d.md, 'length', 0, 'ft') + ' MD · ' + _u(d.tvd, 'length', 0, 'ft') + ' TVD on the surveyed path' : '';
        var pills = [];
        if (nz.ok) {
            var s = nz.spec, dims = [s.flo.values.length + ' rates', s.thp.length + ' THP'];
            if (s.kind === 'prod') dims.push(s.wfr.values.length + ' ' + s.wfr.type, s.gfr.values.length + ' ' + s.gfr.type, s.alq.values.length + ' ' + (s.alq.type || 'no lift'));
            var lifted = s.kind === 'prod' && s.alq.type === 'GRAT' ? s.alq.values.filter(function (v) { return v > 0; }).length / s.alq.values.length : 0;
            var est = nz.n * MS_PER_POINT * (1 + 4 * lifted) / 1000;
            pills.push('<span class="wplt-pill"><b>' + _fmt(nz.n, 0) + '</b> points</span>', '<span class="wplt-pill">' + _esc(dims.join(' × ')) + '</span>', '<span class="wplt-pill">≈ ' + (est < 1 ? '< 1' : _fmt(est, est < 10 ? 1 : 0)) + ' s</span>');
        } else pills.push('<span class="wplt-pill warn">Cannot run: ' + _esc(nz.errors[0] || 'incomplete') + '</span>');
        (nz.warnings || []).slice(0, 2).forEach(function (w) { pills.push('<span class="wplt-pill' + (w.sev === 'info' ? '' : ' warn') + '">' + (w.sev === 'info' ? 'ℹ ' : '⚠ ') + _esc(w.msg) + '</span>'); });
        h.innerHTML = pills.join('');
        var run = document.querySelector && document.querySelector('#wplt_card [data-lt="run"]'); if (run) run.disabled = !nz.ok || !!S.job;
    }

    // ── run (a Job through the shared driver) ─────────────────────────────────
    function run() {
        var X = _X(), M = _M(), box = _byId('wplt_job'); if (!X || !M) return;
        if (S.job) return;
        var job = X.liftJob(M, _spec());
        var res0 = job && job.code ? job.result() : null;
        if (res0 && res0.ok === false) { if (box) box.innerHTML = _vh('warn', '⚠ ' + (res0.errors[0] || 'The lift table cannot run.')); return; }
        var cancelled = false, t0 = _now(), key = _mkey(M);
        S.job = { cancel: function () { cancelled = true; } };
        var show = function (p, l) { if (box) box.innerHTML = '<div class="wp-v info">Lift-curve table — ' + _esc(l || 'running') + ' <button type="button" class="btn btn-secondary" data-lt="cancel" style="padding:3px 9px;margin-left:8px">Cancel</button></div><div class="wp-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(100 * (p || 0)) + '"><i style="width:' + Math.round(100 * (p || 0)) + '%"></i></div>'; };
        show(0); _meta();
        var fin = function (T, err) {
            S.job = null;
            if (box) box.innerHTML = err ? _vh(err.code === 'CANCELLED' ? 'info' : 'fail', err.code === 'CANCELLED' ? 'ℹ Lift-curve table cancelled.' : '✗ Lift-curve table failed: ' + (err.message || err.code || err)) : '';
            if (!err) {
                if (!T || !T.ok) { if (box) box.innerHTML = _vh('fail', '✗ ' + ((T && T.errors && T.errors[0]) || 'no table')); }
                else { T.wallMs = _now() - t0; S.T = T; S.key = key; S.stale = false; S.sel = { w: _near(T.axes.wfr, _modelAx(M, T, 'wfr')), g: _near(T.axes.gfr, _modelAx(M, T, 'gfr')), a: 0 }; S.cursor = null; }
            }
            _meta(); _renderRes(); _renderSum(); _btns();
        };
        var AI = G.PRiSM_autoInterp;
        if (AI && typeof AI.drive === 'function') AI.drive(job, { shouldCancel: function () { return cancelled; }, onProgress: show }).then(function (r) { fin(r); }, function (e) { fin(null, e || { code: 'FAILED' }); });
        else { try { var s, n = 0; do { s = job.step(); n++; } while (!s.done && !cancelled && n < 1e6); fin(cancelled ? null : job.result(), cancelled ? { code: 'CANCELLED' } : null); } catch (e) { fin(null, e); } }
    }
    function _near(ax, v) { if (!_fin(v)) return 0; var b = 0; ax.forEach(function (x, i) { if (Math.abs(x - v) < Math.abs(ax[b] - v)) b = i; }); return b; }
    // the model's own value on a fraction axis (to open the slice the model sits in, and to know when the inflow overlay applies)
    function _modelAx(M, T, which) {
        var s = T.spec, f = M.fluid || {};
        if (which === 'wfr') return s.wfr.type === 'WCT' ? +f.wc || 0 : s.wfr.type === 'WOR' ? (+f.wc || 0) / Math.max(1e-9, 1 - (+f.wc || 0)) : s.wfr.type === 'WGR' ? (+f.wgr || 0) / 1000 : null;
        if (which === 'gfr') return s.gfr.type === 'GOR' ? (+f.gor || 0) / 1000 : s.gfr.type === 'GLR' ? (+f.gor || 0) * (1 - (+f.wc || 0)) / 1000 : s.gfr.type === 'OGR' ? (+f.cgr || 0) / 1000 : null;
        return null;
    }
    function _btns() { ['txt', 'csv'].forEach(function (k) { var b = document.querySelector && document.querySelector('#wplt_card [data-lt="' + k + '"]'); if (b) b.disabled = !(S.T && S.T.ok); }); }

    // ── results: KPI chips, the interactive chart, slice sliders, the slice table, notes ─────────────────────────────────
    function _kpi(label, val, sub, st) { return '<div class="wp-kpi kpi st-' + st + '"><div class="kpi-l">' + _esc(label) + '</div><div class="kpi-v">' + _esc(val) + '</div><div class="kpi-s">' + _esc(sub || '') + '</div></div>'; }
    function _axLabel(T, which, i) {
        var s = T.spec, v = T.axes[which][i];
        if (which === 'wfr') return s.wfr.type + ' ' + _fmt(v, 4) + (s.wfr.type === 'WCT' ? ' (' + _fmt(100 * v, 1) + ' %)' : ' ' + _X().WFR[s.wfr.type].unit);
        if (which === 'gfr') return s.gfr.type + ' ' + _fmt(v, 4) + ' ' + _X().GFR[s.gfr.type].unit + (s.gfr.type === 'GOR' || s.gfr.type === 'GLR' ? ' (' + _fmt(v * 1000, 0) + ' scf/STB)' : '');
        if (which === 'alq') return s.alq.type ? s.alq.type + ' ' + _fmt(v, 0) + ' ' + _X().ALQ[s.alq.type].unit : 'none';
        return String(v);
    }
    function _renderRes() {
        var h = _byId('wplt_res'), T = S.T; if (!h) return;
        if (!T || !T.ok) { h.innerHTML = ''; return; }
        var s = T.spec, prod = s.kind === 'prod', nF = T.filled.length, mt = T.monotone;
        var k = '<div class="wp-kpis wplt-kp" style="margin-top:4px">' +
            _kpi('Points', _fmt(T.n, 0), [T.axes.flo.length, T.axes.thp.length].concat(prod ? [T.axes.wfr.length, T.axes.gfr.length, T.axes.alq.length] : []).join(' × '), 'ok') +
            _kpi('Filled', _fmt(nF, 0), nF ? 'monotone extrapolation' : 'every point computed', nF ? 'warn' : 'ok') +
            _kpi('BHP vs THP', mt.thp.ok ? 'rising' : mt.thp.n + ' breaks', 'every column', mt.thp.ok ? 'ok' : 'warn') +
            _kpi('Rate rows', mt.rate.ok ? 'one minimum' : mt.rate.n + ' irregular', 'falling, then rising', mt.rate.ok ? 'ok' : 'warn') +
            _kpi('Datum', _u(T.datum.md, 'length', 0, 'ft') + ' MD', _u(T.datum.tvd, 'length', 0, 'ft') + ' TVD', 'info') +
            _kpi('Run', _fmt((T.wallMs || 0) / 1000, 1) + ' s', _fmt(T.evals, 0) + ' evaluations', 'info') + '</div>';
        var sl = '';
        if (prod) {
            sl = '<div class="wplt-sl rp-skip">' + [['w', 'wfr', 'Water fraction'], ['g', 'gfr', 'Gas fraction'], ['a', 'alq', 'Lift quantity']].map(function (p) {
                var n = T.axes[p[1]].length;
                return '<div><label for="wpltv_' + p[0] + '">' + _esc(p[2]) + ' <b id="wpltv_' + p[0] + 'l">' + _esc(_axLabel(T, p[1], S.sel[p[0]])) + '</b></label><input type="range" id="wpltv_' + p[0] + '" data-ltsl="' + p[0] + '" min="0" max="' + (n - 1) + '" step="1" value="' + S.sel[p[0]] + '"' + (n < 2 ? ' disabled' : '') + ' aria-valuetext="' + _esc(_axLabel(T, p[1], S.sel[p[0]])) + '"></div>';
            }).join('') + '</div>';
        }
        h.innerHTML = (S.stale ? '<div class="wp-stalechip" role="status">Table from the previous inputs — run it again</div>' : '') + k + sl +
            '<div class="chart-wrap"><canvas id="wplt_cv" aria-label="Lift-curve table: BHP against rate, one curve per THP; drag the rate line to read every THP\'s BHP; sliders pick the slice"></canvas></div>' +
            '<div class="wplt-read" id="wplt_read" aria-live="polite"></div>' +
            '<div class="wp-legend-hint rp-skip">Wheel or pinch to zoom, drag to pan, double-click to reset; click the legend to hide a curve; drag the rate line (or [ ] and the arrow keys) to read the BHP at every THP. Hollow points are filled (not computed).</div>' +
            '<div class="wp-tw rp-skip" id="wplt_tbl" style="margin-top:10px"></div>' +
            '<div class="wp-notes" style="margin-top:8px">' + T.notes.map(function (n) { return _esc(n); }).join('<br>') + '</div>';
        _draw(); _table();
    }
    function _rowCat(T) { return T.spec.flo.type === 'GAS' ? ['gasRateSmall', 'Mscf/d'] : ['liquidRate', 'STB/d']; }
    // the inflow curve on the table's rate basis (only where the slice is the model's own fluid and the datum is the mid-perforations)
    function _ipr(T) {
        var st = _page(), I = st && st.I, M = _M(); if (!I || !I.ok || !M || !_fin(I.aof) || T.spec.kind !== 'prod') return null;
        if (Math.abs(T.datum.md - (st.W && st.W.nodes ? st.W.nodes.midPerfMd : T.datum.md)) > 1) return null;
        var s = T.spec, wm = _modelAx(M, T, 'wfr'), gm = _modelAx(M, T, 'gfr');
        if (!(_fin(wm) && Math.abs(T.axes.wfr[S.sel.w] - wm) <= 1e-6 * Math.max(1, wm)) || !(_fin(gm) && Math.abs(T.axes.gfr[S.sel.g] - gm) <= 1e-6 * Math.max(1, gm))) return null;
        var wc = +M.fluid.wc || 0, gor = +M.fluid.gor || 0, gas = M.fluid.type === 'gas' || M.fluid.type === 'condensate';
        var toFlo = function (q) {      // q on the fluid's rate basis → the table's rate type
            if (gas) return s.flo.type === 'GAS' ? q : null;
            if (s.flo.type === 'LIQ') return q; if (s.flo.type === 'OIL') return q * (1 - wc); if (s.flo.type === 'GAS') return q * (1 - wc) * gor / 1000; if (s.flo.type === 'WAT') return q * wc; return null;
        };
        var pts = [];
        for (var i = 0; i <= 60; i++) { var q = I.aof * i / 60, p = I.pwfAt(q), x = toFlo(q); if (_fin(p) && _fin(x)) pts.push([x, p]); }
        return pts.length ? pts : null;
    }
    function _cross(row, ipr) {
        // the highest-rate crossing of the BHP row (piecewise linear) with the inflow (piecewise linear): the operating point at that THP
        var f = function (x, pts) { if (x < pts[0][0] || x > pts[pts.length - 1][0]) return null; for (var i = 1; i < pts.length; i++) if (x <= pts[i][0]) { var a = pts[i - 1], b = pts[i]; return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return null; };
        var xs = row.map(function (p) { return p[0]; }).concat(ipr.map(function (p) { return p[0]; })).sort(function (a, b) { return a - b; }), best = null, prev = null;
        xs.forEach(function (x) {
            var a = f(x, row), b = f(x, ipr); if (!_fin(a) || !_fin(b)) { prev = null; return; }
            var d = a - b;
            if (prev && prev.d * d <= 0 && prev.d !== d) { var fr = prev.d / (prev.d - d), xx = prev.x + fr * (x - prev.x); best = { x: xx, y: f(xx, row) }; }
            prev = { x: x, d: d };
        });
        return best;
    }
    function _draw() {
        var cv = _byId('wplt_cv'), V = G.WTS_wp_view, X = _X(), T = S.T; if (!cv || !V || !X || !T) return;
        var th = V.theme(), rc = _rowCat(T), sl = X.slice(T, S.sel), lo = T.axes.thp[0], hi = T.axes.thp[T.axes.thp.length - 1];
        var narrow = (cv.clientWidth || cv.width || 560) < 520;          // phones: the readout row carries the colours, no legend box
        var ser = [], mk = [], ipr = _ipr(T), xs = function (q) { return _dv(q, rc[0]); }, ys = function (p) { return _dv(p, 'pressure'); };
        sl.forEach(function (c, i) {
            var col = V.colorFor ? V.colorFor('pressure', c.thp, lo, hi === lo ? lo + 1 : hi) : th.accent;
            var pts = c.pts.map(function (p) { return [xs(p.q), ys(p.bhp)]; });
            ser.push({ key: 'thp' + i, label: 'THP ' + _u(c.thp, 'pressure', 0, 'psia'), legend: !narrow, color: col, width: 2.2, dash: S.stale ? [4, 4] : null, pts: pts });
            ser.push({ key: 'thpp' + i, label: '', legend: false, kind: 'points', color: col, pts: c.pts.filter(function (p) { return !p.filled; }).map(function (p) { return [xs(p.q), ys(p.bhp)]; }) });
            c.pts.filter(function (p) { return p.filled; }).forEach(function (p) { mk.push({ x: xs(p.q), y: ys(p.bhp), kind: 'hollow', color: th.red, r: 4, label: '' }); });
            if (ipr) { var op = _cross(c.pts.map(function (p) { return [p.q, p.bhp]; }), ipr); if (op) mk.push({ x: xs(op.x), y: ys(op.y), kind: 'filled', color: col, r: 5, label: i === sl.length - 1 || i === 0 ? _fmt(xs(op.x), 0) : '' }); }
        });
        if (ipr) ser.push({ key: 'ipr', label: 'Inflow (model)', legend: !narrow, color: th.green, width: 2, dash: [6, 4], pts: ipr.map(function (p) { return [xs(p[0]), ys(p[1])]; }) });
        var qMax = T.axes.flo[T.axes.flo.length - 1], qMin = 0;
        if (!_fin(S.cursor)) S.cursor = T.axes.flo[Math.floor(T.axes.flo.length / 2)];
        var handles = [{ key: 'rate', kind: 'lineX', value: xs(S.cursor), min: xs(T.axes.flo[0]), max: xs(qMax), step: _metric() ? 1 : Math.max(1, Math.round(qMax / 200)), label: 'rate', color: th.blue, fmt: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } }];
        V.chart(cv, { key: 'wplt:' + T.spec.kind + ':' + (_metric() ? 'm' : 'i'), aspect: 0.56, minH: 240, maxH: 400, w: 560, readout: 'x',
            x: { label: X.FLO[T.spec.flo.type].label + ' (' + _lab(rc[0], rc[1]) + ')', min: qMin, max: xs(qMax * 1.02), short: 'q', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab(rc[0], rc[1]); } },
            y: { label: 'BHP at the datum (' + _lab('pressure', 'psia') + ')', short: 'BHP', fmtR: function (v) { return _fmt(v, 0) + ' ' + _lab('pressure', 'psia'); } },
            series: ser, markers: mk, handles: handles, legendNote: narrow ? null : (S.stale ? 'Previous inputs — run the table again' : (ipr ? 'Dots on the inflow: the operating point at each THP' : null)),
            onHandle: _onHandle,
            empty: 'Run the lift table to see BHP against rate.' });
        _readout();
    }
    // the rate line (display units in, field units kept): every THP's BHP re-read from the table; a release redraws the chart
    function _onHandle(key, v, phase) {
        var T = S.T; if (key !== 'rate' || !T) return;
        var U = _U(), rc = _rowCat(T);
        S.cursor = (_metric() && U && U.convertCategory) ? U.convertCategory(v, rc[0], 'metric', 'imperial') : v;
        _readout(); if (phase === 'end') _draw();
    }
    function _readout() {
        var h = _byId('wplt_read'), X = _X(), T = S.T, V = G.WTS_wp_view; if (!h || !T || !X) return;
        var rc = _rowCat(T), lo = T.axes.thp[0], hi = T.axes.thp[T.axes.thp.length - 1], q = S.cursor;
        var parts = ['<span><b>' + _esc(_u(q, rc[0], 0, rc[1])) + '</b></span>'];
        T.axes.thp.forEach(function (thp) {
            var p = X.interp(T, { flo: q, thp: thp, wfr: T.axes.wfr[S.sel.w], gfr: T.axes.gfr[S.sel.g], alq: T.axes.alq[S.sel.a] });
            var col = V && V.colorFor ? V.colorFor('pressure', thp, lo, hi === lo ? lo + 1 : hi) : 'currentColor';
            parts.push('<span><i style="background:' + col + '"></i>' + _esc(_fmt(_dv(thp, 'pressure'), 0)) + ' → ' + _esc(_u(p, 'pressure', 0, 'psia')) + '</span>');
        });
        h.innerHTML = parts.join('');
    }
    function _table() {
        var h = _byId('wplt_tbl'), X = _X(), T = S.T; if (!h || !T || !X) return;
        var sl = X.slice(T, S.sel), rc = _rowCat(T);
        h.innerHTML = '<table class="dtable wplt-tbl" aria-label="Lift-curve table slice: BHP for each THP and rate"><thead><tr><th>THP (' + _esc(_lab('pressure', 'psia')) + ') \\ rate (' + _esc(_lab(rc[0], rc[1])) + ')</th>' +
            T.axes.flo.map(function (q) { return '<th class="num">' + _esc(_fmt(_dv(q, rc[0]), 0)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            sl.map(function (c) {
                var im = 0; c.pts.forEach(function (p, i) { if (p.bhp < c.pts[im].bhp) im = i; });
                return '<tr><th>' + _esc(_fmt(_dv(c.thp, 'pressure'), 0)) + '</th>' + c.pts.map(function (p, i) { return '<td class="num' + (p.filled ? ' f' : '') + (i === im && im > 0 && im < c.pts.length - 1 ? ' min' : '') + '"' + (p.filled ? ' title="filled (not computed)"' : '') + '>' + _esc(_fmt(_dv(p.bhp, 'pressure'), 0)) + (p.filled ? '*' : '') + '</td>'; }).join('') + '</tr>';
            }).join('') + '</tbody></table><div class="wp-hint">* filled point · underlined: the minimum of the row (the tubing-curve minimum at that THP)</div>';
    }
    // the summary inside #wp_res (reports and the Quick Report)
    function _renderSum() {
        var h = _byId('wp_ltsum'), T = S.T; if (!h) return;
        if (!T || !T.ok) { h.innerHTML = ''; return; }
        var s = T.spec, prod = s.kind === 'prod', row = function (l, v) { return '<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv">' + _esc(v) + '</span></div>'; };
        var all = []; T.points.forEach(function (p) { all.push(p.bhp); });
        var ax = prod ? T.axes.flo.length + ' ' + s.flo.type + ' × ' + T.axes.thp.length + ' THP × ' + T.axes.wfr.length + ' ' + s.wfr.type + ' × ' + T.axes.gfr.length + ' ' + s.gfr.type + ' × ' + T.axes.alq.length + ' ' + (s.alq.type || 'no lift') : T.axes.flo.length + ' ' + s.flo.type + ' × ' + T.axes.thp.length + ' THP';
        h.innerHTML = '<div class="rbox-title">Lift-curve table' + (S.stale ? ' (previous inputs)' : '') + '</div>' +
            row('Table', s.tableNo + ' · ' + (prod ? 'producer' : 'injector') + ' · ' + _fmt(T.n, 0) + ' points') + row('Axes', ax) +
            row('Datum', _fmt(T.datum.md, 0) + ' ft MD · ' + _fmt(T.datum.tvd, 0) + ' ft TVD') +
            row('Rates / THP', _fmt(T.axes.flo[0], 0) + '–' + _fmt(T.axes.flo[T.axes.flo.length - 1], 0) + ' ' + _X().FLO[s.flo.type].unit + ' · ' + _fmt(T.axes.thp[0], 0) + '–' + _fmt(T.axes.thp[T.axes.thp.length - 1], 0) + ' psia') +
            row('BHP range', _fmt(Math.min.apply(null, all), 0) + '–' + _fmt(Math.max.apply(null, all), 0) + ' psia (field units, as exported)') +
            row('Correlation', (T.corr && G.WTS_flowline_corr && G.WTS_flowline_corr[T.corr] && G.WTS_flowline_corr[T.corr].label) || T.corr || '—') +
            _vh(T.filled.length ? 'warn' : 'ok', (T.filled.length ? '⚠ ' + T.filled.length + ' point(s) filled by monotone extrapolation along the rate axis' : '✓ Every point computed')) +
            _vh(T.monotone.thp.ok ? 'ok' : 'warn', T.monotone.thp.ok ? '✓ BHP rises with THP on every column' : '⚠ BHP does not rise with THP at ' + T.monotone.thp.n + ' point(s)') +
            _vh(T.monotone.rate.ok ? 'ok' : 'warn', T.monotone.rate.ok ? '✓ Every rate row has a single minimum' : '⚠ ' + T.monotone.rate.n + ' rate row(s) with more than one minimum (flow-pattern changes)') +
            T.provisional.map(function (p) { return _vh('info', 'ℹ ' + p); }).join('');
    }

    // ── PVT export ────────────────────────────────────────────────────────────
    function _pvt() {
        var X = _X(), M = _M(); if (!X || !M) return null;
        var n = parseInt(_val('wplt_pvtn'), 10);
        S.pvt = X.pvtTable(M, { n: _fin(n) ? n : 15 });
        var h = _byId('wplt_pvtmeta');
        if (h) {
            var P = S.pvt;
            h.innerHTML = P && P.ok ? '<span class="wplt-pill"><b>' + P.rows.length + '</b> pressures</span><span class="wplt-pill">' + _esc(_u(P.T, 'temperature', 1, '°F')) + '</span>' +
                (P.pb ? '<span class="wplt-pill">p_b ' + _esc(_u(P.pb, 'pressure', 0, 'psia')) + '</span>' : '') + (P.provisional.length ? '<span class="wplt-pill warn">provisional families in use</span>' : '') :
                '<span class="wplt-pill warn">Not available: ' + _esc((P && P.errors && P.errors[0]) || 'no fluid') + '</span>';
        }
        return S.pvt;
    }
    // ── downloads ─────────────────────────────────────────────────────────────
    function _save(name, text, mime) {
        NS.last = { name: name, size: text.length, text: text };
        try {
            if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
            var blob = new Blob([text], { type: mime || 'text/plain' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = name; a.style.display = 'none';
            (document.body || _byId('wp_root')).appendChild(a); a.click(); if (a.parentNode) a.parentNode.removeChild(a);
            if (URL.revokeObjectURL) URL.revokeObjectURL(url);
        } catch (e) { /* no download in this environment */ }
    }
    function _stamp() { return new Date().toISOString().slice(0, 10); }
    function _act(a) {
        var X = _X(); if (!X) return;
        if (a === 'suggest') { _suggest(true); return; }
        if (a === 'run') { run(); return; }
        if (a === 'cancel') { if (S.job) S.job.cancel(); return; }
        if (a === 'txt' && S.T && S.T.ok) { _save('wellperf_lift_table_' + S.T.spec.tableNo + '_' + _stamp() + '.txt', X.text(S.T, { date: _stamp() })); return; }
        if (a === 'csv' && S.T && S.T.ok) { _save('wellperf_lift_table_' + S.T.spec.tableNo + '_' + _stamp() + '.csv', X.csv(S.T), 'text/csv'); return; }
        if (a === 'pvtcsv') { var P = _pvt(); if (P && P.ok) _save('wellperf_pvt_' + _stamp() + '.csv', X.pvtCsv(P, { metric: _metric() }), 'text/csv'); return; }
        if (a === 'pvttxt') { var P2 = _pvt(); if (P2 && P2.ok) _save('wellperf_pvt_tables_' + _stamp() + '.txt', X.pvtText(P2)); return; }
    }

    // ── binding (once per page render; the listeners sit on the cards, never on #pgBody) ─────────────────────────────────
    function bind() {
        var card = _byId('wplt_card'), pc = _byId('wplt_pvtcard'); if (!card) return;
        S.T = null; S.key = null; S.stale = false; S.job = null;
        [card, pc].forEach(function (el) {
            if (!el || !el.addEventListener) return;
            el.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-lt]') : null; if (b && !b.disabled) _act(b.getAttribute('data-lt')); });
            el.addEventListener('change', function (e) { var t = e.target; if (!t || !t.id) return; if (t.id === 'wplt_pvtn') { _pvt(); return; } if (/^wplt_/.test(t.id)) _meta(); });
            el.addEventListener('input', function (e) {
                var t = e.target; if (!t || !t.getAttribute) return;
                var k = t.getAttribute('data-ltsl');
                if (k && S.T) { S.sel[k] = +t.value || 0; var which = { w: 'wfr', g: 'gfr', a: 'alq' }[k], lb = _byId('wpltv_' + k + 'l'), txt = _axLabel(S.T, which, S.sel[k]); if (lb) lb.textContent = txt; t.setAttribute('aria-valuetext', txt); _draw(); _table(); return; }
                if (t.id === 'wplt_datum') _meta();
            });
        });
        _renderSum(); _btns();
        _sync();
    }
    function refresh() { if (_byId('wplt_card')) _sync(); }

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:wellperf-solved', function () { if (_byId('wplt_card')) _sync(); });
        document.addEventListener('wts:unit-system-changed', function () { if (_byId('wplt_card')) { _meta(); _renderRes(); } });
    }
    if (typeof G.addEventListener === 'function') G.addEventListener('resize', function () { var c = _byId('wplt_cv'); if (c && G.WTS_wp_view) G.WTS_wp_view.redraw(c); });

    var NS = G.WTS_wp_tables = G.WTS_wp_tables || {};
    NS.html = html; NS.bind = bind; NS.refresh = refresh; NS.run = run;
    NS.state = function () { return S; };
    NS.act = _act; NS.handle = function (k, v, ph) { _onHandle(k, v, ph || 'move'); };
    NS.last = null;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (!(G.WTS_wp_tables && typeof G.WTS_wp_tables.html === 'function') && typeof console !== 'undefined') console.error('[49-calc-wp-tables.js self-test] namespace');
})();
