// =============================================================================
// WTS — 49-calc-wp-glui.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance page part for the gas-lift design and diagnostics (B, WP25) — docs/WELL-PERFORMANCE-PLAN.md §1.3 US16, §7.2, §2.9 and
// the owner GUI requirement (interactive, deviation first: every depth MD · TVD; KPI chips; every result captured by the reports).
//
// Registered as window.WTS_wellperf_ext.gldesign (the page's extension hooks, 49-calc-wellperf.js). It draws with the page helpers
// (WTS_wellperf_page.ui()) and the engines of 49-calc-wp-gldesign.js (WTS_wp_gl.design / setValve / diagnose / parseSurvey /
// matchSurvey / asheim / tc) — no numerics of its own.
//
//   #wp_res card "Gas-lift valves" (with gas lift selected): KPI chips (valves, operating valve MD · TVD, port throughput against the
//     injection rate, Asheim F1 / F2, diagnosis, survey RMS), the valve chart (pressure against MD or TVD: kickoff and operating casing
//     lines, design tubing line, unloading gradients, the tubing with and without lift gas; in the Diagnosis view the casing from the
//     test CHP, the tubing from the test THP and each valve's opening pressure; the survey points and their gradient break) with a
//     drag knob per valve (vertical drag moves the valve: a design valve is re-set on the same design lines, an installed valve keeps
//     its setting and is written on release; keyboard [ ] then arrows), the valve table and the verdicts.
//   Step ④ card "Gas-lift design — unloading valves": the design settings (kickoff pressure, kill-fluid gradient, tubing effect,
//     spacing, pressure drop per valve, port, R, design rate, deepest mandrel), Design (a Job), Use this design (writes the model table
//     glValves), Use the recommended port, the installed-valve editor (MD with TVD, port, test-rack pressure, kind).
//   Step ④ card "Diagnosis and gradient survey": the test (M.tests rows with CHP and lift gas), the survey text (MD or TVD, p, T) and
//     Match the survey.
//   Schematic: a side-pocket mandrel per valve (state from the diagnosis or the design), click → its editor row, drag along the hole →
//     a new depth (live), arrow keys on a focused mandrel move it by 50 ft (Shift 10 ft). Traverse: valve lines and the survey points.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function P() { var pg = G.WTS_wellperf_page; return pg && typeof pg.ui === 'function' ? pg.ui() : null; }
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _L() { return G.WTS_wp_gl && typeof G.WTS_wp_gl.design === 'function' ? G.WTS_wp_gl : null; }
    function _on(M) { return !!(M && M.lift && M.lift.type === 'gaslift' && M.fluid && (M.fluid.type === 'oil' || M.fluid.type === 'water' || !M.fluid.type)); }
    var PATM = 14.696;
    var STATE_COL = { operating: 'accent', open: 'green', closed: 'text2', orifice: 'blue', dummy: 'text2' };
    var PORTS = [8, 12, 16, 20, 24, 28, 32];
    var PORT_TXT = { 8: '1/8', 12: '3/16', 16: '1/4', 20: '5/16', 24: '3/8', 28: '7/16', 32: '1/2' };

    // results kept per page instance (cleared on a well switch / project open; never stored except through the model table glValves)
    var S = { des: null, desKey: null, desRows: null, desEdited: false, diag: null, diagKey: null, ash: null, ashR: null, sur: null, surR: null, surRows: null, surKey: null,
        drag: null, sdrag: null, noClick: false, msg: null };

    var CSS = '<style>' +
        '#wp_root .wpg-ctl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px;align-items:end}' +
        '#wp_root .wpg-ctl .fg-item{margin:0;min-width:0}#wp_root .wpg-ctl input,#wp_root .wpg-ctl select{width:100%;min-width:0}' +
        '#wp_root .wpg-go{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0 4px}#wp_root .wpg-go .btn{padding:7px 13px;font-size:12px}' +
        '#wp_root .wpg-seg{display:inline-flex;border:1px solid var(--border);border-radius:14px;overflow:hidden}#wp_root .wpg-seg button{font-size:11px;padding:4px 10px;border:0;background:transparent;color:var(--text2);cursor:pointer;transition:background .15s,color .15s}' +
        '#wp_root .wpg-seg button.on{background:var(--accent);color:var(--on-accent,#fff)}#wp_root .wpg-seg button:focus-visible{outline:2px solid var(--focus,#58a6ff);outline-offset:-2px}' +
        '#wp_root .wpg-read{min-height:18px;font-size:12px;color:var(--text2);margin:4px 2px;font-variant-numeric:tabular-nums}' +
        '#wp_root .wpg-ed td input,#wp_root .wpg-ed td select{width:100%;min-width:62px}#wp_root .wpg-ed td.ro{color:var(--text2);white-space:nowrap}' +
        '#wp_root .wpg-ed tr.wp-flash td{animation:wpgFlash 1.2s ease-out}@keyframes wpgFlash{from{background:rgba(240,136,62,.28)}to{background:transparent}}' +
        '#wp_root .wpg-tbl td.st{white-space:nowrap}#wp_root .wpg-tbl td.op{color:var(--accent);font-weight:700}#wp_root .wpg-tbl tr.drag td{background:rgba(88,166,255,.12)}' +
        '#wp_root .wpg-sv textarea{width:100%;min-height:92px;font-family:var(--mono,monospace);font-size:12px;resize:vertical}' +
        '#wp_root .wpg-badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.3px;padding:1px 7px;border-radius:9px;border:1px solid var(--border);color:var(--text2);margin-left:6px;vertical-align:1px}' +
        '#wp_root #wp_sch [data-comp^="mandrel:"]{cursor:ns-resize}#wp_root #wp_sch [data-comp^="mandrel:"]:focus-visible{outline:2px solid var(--focus,#58a6ff)}' +
        '@media (prefers-reduced-motion: reduce){#wp_root .wpg-ed tr.wp-flash td{animation:none}#wp_root .wpg-seg button{transition:none}}' +
        '@media (max-width:600px){#wp_root .wpg-ctl{grid-template-columns:1fr 1fr}#wp_root .wpg-tbl{font-size:11.5px}}' +
        '</style>';

    // ── helpers ──────────────────────────────────────────────────────────────
    function _num(v) { if (typeof v === 'number') return isFinite(v) ? v : null; var s = String(v == null ? '' : v).trim(); if (!s) return null; var x = parseFloat(s.replace(',', '.')); return isFinite(x) ? x : null; }
    function _mkey(M) { try { var l = JSON.parse(JSON.stringify(M.lift || {})); if (l.gl) { delete l.gl.valves; } return JSON.stringify([M.fluid, M.res, M.well, M.surface && M.surface.choke, M.system, l]); } catch (e) { return ''; } }
    function _depthAx(p) { var d = (p.plots().glvDepth || p.plots().depth); return d === 'md' ? 'md' : 'tvd'; }
    function _view(p) { var v = p.plots().glvView; return v === 'diag' || v === 'design' ? v : (S.diag && S.diag.ok ? 'diag' : 'design'); }
    function _tests(M) { return ((M && M.tests) || []).map(function (t, i) { return { t: t, i: i }; }).filter(function (x) { return x.t && x.t.use !== false && _num(x.t.chp_psig) > 0; }); }
    function _testSel(p, M) {
        var ts = _tests(M), pi = p.plots().glTest, hit = ts.filter(function (x) { return x.i === pi; })[0];
        return hit || ts[ts.length - 1] || null;
    }
    function _ref(p) {
        var g = p.ST.gl;
        if (g && g.ok && !g.stale) {
            if (g.economic && g.economic.rule === 'slope') return { q: g.economic.qinj, src: 'the economic point of the performance curve' };
            if (g.optimum) return { q: g.optimum.qinj, src: 'the optimum of the performance curve' };
        }
        return null;
    }
    // the valve set shown: the installed valves of the model (table glValves), else the last design (possibly moved by a drag)
    function _vset(p) {
        var M = p.ST.M, inst = (M && M.lift && M.lift.gl && Array.isArray(M.lift.gl.valves)) ? M.lift.gl.valves : [];
        var W = p.ST.W, tvdAt = function (md) { return p.tvdAt(md); }, rows;
        if (inst.length) {
            rows = inst.map(function (v, i) { return { i: i, md: +v.md, tvd: tvdAt(+v.md), port: v.port || 16, ptro: v.ptro, R: v.R, kind: v.kind || 'ipo', src: 'installed' }; });
            if (S.drag && S.drag.src === 'installed' && rows[S.drag.i]) { rows[S.drag.i].md = S.drag.md; rows[S.drag.i].tvd = tvdAt(S.drag.md); rows[S.drag.i].dragging = true; }
            return { src: 'installed', rows: rows };
        }
        if (S.desRows && S.desRows.length) {
            rows = S.desRows.map(function (v, i) { var r = {}; Object.keys(v).forEach(function (k) { r[k] = v[k]; }); r.i = i; r.src = 'design'; r.kind = 'ipo'; r.tvd = tvdAt(r.md); return r; });
            if (S.drag && S.drag.src === 'design' && rows[S.drag.i] && S.drag.row) { var d0 = S.drag.row; Object.keys(d0).forEach(function (k) { rows[S.drag.i][k] = d0[k]; }); rows[S.drag.i].i = S.drag.i; rows[S.drag.i].tvd = tvdAt(rows[S.drag.i].md); rows[S.drag.i].dragging = true; }
            return { src: 'design', rows: rows };
        }
        void W;
        return { src: 'none', rows: [] };
    }
    function _state(row) {
        var dg = S.diag && S.diag.ok ? S.diag.valves.filter(function (x) { return Math.abs(x.md - row.md) < 0.5; })[0] : null;
        if (row.kind === 'dummy') return 'dummy';
        if (dg) { if (S.diag.operating && S.diag.operating.n === dg.n) return 'operating'; if (dg.passing || dg.open) return dg.kind === 'orifice' ? 'orifice' : 'open'; return 'closed'; }
        if (row.kind === 'orifice') return 'orifice';
        if (row.role === 'Operating') return 'operating';
        return 'closed';
    }
    function _commitValves(rows) {
        var Mm = G.WTS_wp_model; if (!Mm || typeof Mm.write !== 'function') return null;
        return Mm.write({ glValves: rows.map(function (r) { return { md: Math.round(r.md), port: r.port, ptro: _fin(r.ptro) ? Math.round(r.ptro) : null, R: _fin(r.R) ? +(+r.R).toFixed(4) : null, kind: r.kind || 'ipo' }; }) });
    }

    // ── markup ───────────────────────────────────────────────────────────────
    function resHtml() {
        var p = P(); if (!p) return '';
        var tools = '<span class="wpg-seg" role="group" aria-label="Valve chart view"><button type="button" data-act="wpg_view" data-v="design">Design</button><button type="button" data-act="wpg_view" data-v="diag">Diagnosis</button></span> ' +
            '<span class="wpg-seg" role="group" aria-label="Depth axis"><button type="button" data-act="wpg_depth" data-v="tvd">TVD</button><button type="button" data-act="wpg_depth" data-v="md">MD</button></span>';
        return CSS + '<div data-lift="gaslift">' + p.card('Gas-lift valves — design, throughput and diagnosis',
            '<div class="wp-kpis" id="wpg_kpi" aria-live="polite"></div>' +
            '<div class="chart-wrap"><canvas id="wp_cv_glv" tabindex="0" aria-label="Gas-lift valve chart: pressure against depth with the casing and tubing lines and a knob per valve; drag a knob up or down to move the valve"></canvas></div>' +
            '<div class="wpg-read rp-skip" id="wpg_read" aria-live="polite"></div>' +
            '<div id="wpg_tbl"></div><div id="wpg_verd"></div>' +
            '<div class="wp-legend-hint rp-skip">Drag a valve knob (or a mandrel on the well schematic) up or down and it moves along the hole — MD and TVD shown; a design valve is re-set on the same design lines, an installed valve keeps its setting. Keyboard: [ and ] pick a valve, arrows move it, Enter commits.</div>',
            { tools: tools, id: 'wpg_card' }) + '</div>';
    }
    function _fgx(p, id, label, o) { return p.fg(id, label, o || {}); }
    function stepHtml(n) {
        var p = P(); if (!p || n !== 4) return null;
        var portOpts = [['', 'from the design (1/4 in)']].concat(PORTS.map(function (x) { return [String(x), PORT_TXT[x] + ' in (' + x + '/64)']; }));
        var des = p.card('Gas-lift design — unloading valves',
            '<div class="wpg-ctl">' +
            _fgx(p, 'wp_gld_pko', 'Kickoff pressure (surface)', { unit: 'psig', ph: 'injection + 100' }) +
            _fgx(p, 'wp_gld_gs', 'Kill-fluid gradient', { unit: 'psi/ft', ph: '0.465' }) +
            _fgx(p, 'wp_gld_ftub', 'Design tubing effect', { unit: '%', ph: '20' }) +
            _fgx(p, 'wp_gld_dpdrop', 'Pressure drop per valve', { unit: 'psi', ph: '25' }) +
            _fgx(p, 'wp_gld_minsp', 'Minimum spacing (MD)', { unit: 'ft', ph: '250' }) +
            _fgx(p, 'wp_gld_port', 'Port size', { options: portOpts }) +
            _fgx(p, 'wp_gld_R', 'Port / bellows R', { ph: 'from the port' }) +
            _fgx(p, 'wp_gld_qL', 'Design liquid rate', { unit: 'STB/d', ph: 'operating point' }) +
            _fgx(p, 'wp_gld_dmax', 'Deepest mandrel MD', { unit: 'ft', ph: 'packer − 30 ft' }) + '</div>' +
            '<div class="wpg-go rp-skip"><button type="button" class="btn btn-primary" data-act="wpg_design">Design the valves</button>' +
            '<button type="button" class="btn btn-secondary" data-act="wpg_use">Use this design</button>' +
            '<button type="button" class="btn btn-secondary" data-act="wpg_port" style="display:none">Use the recommended port</button></div>' +
            '<div id="wpg_msg" class="rp-skip" role="status"></div>' +
            '<div class="wp-hint" style="margin:6px 0 4px">Spacing on the deviated path with the model\'s inflow, correlation and flowing temperatures (the injection pressure and rate above) — provisional, not verified against a published example. Installed valves (written to the well):</div>' +
            '<div id="wpg_edit" class="rp-skip"></div>' +
            '<div class="wpg-go rp-skip"><button type="button" class="btn btn-secondary" data-act="wpg_add">Add a valve</button><button type="button" class="btn btn-secondary" data-act="wpg_clear">Remove all valves</button></div>',
            { id: 'wpg_dcard' });
        var dx = p.card('Gas-lift diagnosis and gradient survey',
            '<div class="wpg-ctl">' + '<div class="fg-item"><label for="wpv_gld_test">Test (CHP, THP, lift gas, rates)</label><select id="wpv_gld_test" aria-label="Test for the diagnosis"></select></div></div>' +
            '<div class="wp-hint" id="wpg_testhint" style="margin:4px 0 10px"></div>' +
            '<div class="wpg-sv rp-skip"><div class="wpg-ctl" style="grid-template-columns:1fr 1fr">' +
            '<div class="fg-item"><label for="wpv_gls_axis">Survey depth</label><select id="wpv_gls_axis"><option value="md">MD</option><option value="tvd">TVD</option></select></div>' +
            '<div class="fg-item"><label for="wpv_gls_unit">Survey pressure</label><select id="wpv_gls_unit"><option value="psig">psig</option><option value="psia">psia</option></select></div></div>' +
            '<div class="fg-item" style="margin-top:8px"><label for="wpv_gls_text">Flowing gradient survey (depth, pressure, temperature — one stop per line; a header with m, bar or kPa is converted)</label>' +
            '<textarea id="wpv_gls_text" rows="5" placeholder="MD (ft), P (psig), T (°F)&#10;0, 160, 118&#10;2000, 520, 132&#10;…" spellcheck="false"></textarea></div>' +
            '<div class="wpg-go"><button type="button" class="btn btn-primary" data-act="wpg_survey">Match the survey</button><button type="button" class="btn btn-secondary" data-act="wpg_svclear">Clear</button></div></div>' +
            '<div id="wpg_svres"></div>',
            { id: 'wpg_xcard' });
        return '<div data-lift="gaslift" class="wp-2c">' + des + dx + '</div>';
    }

    // ── computations on a solve (cheap; the design itself is a Job on the button) ─────────────────────────
    function _update(p, live) {
        var M = p.ST.M, R = p.ST.R, L = _L(); if (!L || !M) return;
        if (S.des && S.desKey !== _mkey(M)) S.des.stale = true;
        if (live) return;
        // Asheim numbers at the operating point (the port of the valve nearest the injection point)
        if (R && R.ok && R.lift && R.lift.type === 'gaslift') {
            if (S.ashR !== R) {
                var vs = _vset(p).rows, port = null, best = Infinity;
                vs.forEach(function (v) { var d = Math.abs(v.md - R.lift.injMd); if (d < best) { best = d; port = v.port; } });
                var d0 = (M.lift.gl.design || {}).port64;
                S.ash = L.asheim(M, R, { port64: port || d0 || 16 }); S.ashR = R;
            }
        } else { S.ash = null; S.ashR = R; }
        // diagnosis of the chosen test against the valves shown
        var vset = _vset(p), t = _testSel(p, M), key = JSON.stringify([vset.rows.map(function (v) { return [v.md, v.port, v.ptro, v.R, v.kind]; }), t && t.t, _mkey(M), R && R.ok ? R.op.q : null]);
        if (!t || !vset.rows.length) { S.diag = null; S.diagKey = null; }
        else if (key !== S.diagKey) {
            var ref = _ref(p), rows = vset.src === 'design' ? vset.rows.map(function (v) { return { md: v.md, port: v.port, ptro: v.ptro, R: v.R, kind: 'ipo' }; }) : vset.rows;
            S.diag = L.diagnose(M, R, rows, t.t, ref ? { ref: ref.q, refSrc: ref.src } : {}); S.diagKey = key;
        }
        // the survey against the solved traverse
        if (S.surRows && S.surR !== R) { S.sur = L.matchSurvey(M, R, S.surRows, { W: p.ST.W, valves: vset.rows }); S.surR = R; }
    }

    // ── render ───────────────────────────────────────────────────────────────
    function render(live) {
        var p = P(); if (!p || !_byId('wpg_card')) return;
        var M = p.ST.M;
        if (!_on(M)) { ['wpg_kpi', 'wpg_tbl', 'wpg_verd', 'wpg_svres'].forEach(function (id) { var e = _byId(id); if (e) e.innerHTML = ''; }); return; }
        _update(p, live);
        _drawChart(p);
        _renderKpi(p); _renderTable(p);
        if (!live) { _renderVerd(p); _renderEditor(p); _renderTests(p); _renderSurvey(p); _syncButtons(p); }
    }
    function _syncButtons(p) {
        var u = document.querySelector('#wpg_dcard [data-act="wpg_use"]'); if (u) u.disabled = !(S.desRows && S.desRows.length);
        var pb = document.querySelector('#wpg_dcard [data-act="wpg_port"]'); if (pb) pb.style.display = (S.des && S.des.ok && S.des.portRec && S.des.portRec !== S.des.port) ? '' : 'none';
        var view = _view(p), dax = _depthAx(p);
        Array.prototype.forEach.call(document.querySelectorAll('#wpg_card [data-act="wpg_view"]'), function (b) { var on = b.getAttribute('data-v') === view; if (b.classList) b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        Array.prototype.forEach.call(document.querySelectorAll('#wpg_card [data-act="wpg_depth"]'), function (b) { var on = b.getAttribute('data-v') === dax; if (b.classList) b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }
    function _kfmt(p, md, tvd) { var t2 = p.tvdAt(md); return p.fmt(p.dv(md, 'length'), 0) + ' MD · ' + p.fmt(p.dv(_fin(t2) ? t2 : tvd, 'length'), 0) + ' TVD ' + p.lab('length', 'ft'); }
    function _renderKpi(p) {
        var h = _byId('wpg_kpi'); if (!h) return;
        var vs = _vset(p), R = p.ST.R, out = [], k = function (l, v, s, st, t) { out.push(p.kpiHtml(l, v, s, st, t)); };
        var spI = _spacingIssue(p, vs.rows);
        k('Valves', vs.rows.length ? String(vs.rows.length) : '—', vs.src === 'installed' ? 'installed' + (spI ? ' · spacing' : '') : (vs.src === 'design' ? 'design' + (S.desEdited ? ' (moved)' : '') + ' — not installed' + (spI ? ' · spacing' : '') : 'design the valves'), vs.rows.length ? (spI ? 'warn' : (vs.src === 'installed' ? 'ok' : 'info')) : 'none');
        var op = S.diag && S.diag.ok && S.diag.operating ? S.diag.operating : (S.des && S.des.ok && S.des.operating && vs.src === 'design' ? S.des.operating : null);
        var deepest = vs.rows.length ? vs.rows[vs.rows.length - 1] : null;
        if (op) k('Operating valve', 'V' + op.n, _kfmt(p, op.md, op.tvd), deepest && Math.abs(deepest.md - op.md) > 1 && S.diag && S.diag.ok ? 'warn' : 'ok', 'The valve that passes the lift gas');
        else if (R && R.ok && R.lift) {
            // the system solve injects at the point of balance (plan §18.3.9); with valves shown say so, and warn when that depth is below
            // the deepest valve (it cannot inject there)
            var below = deepest && R.lift.injMd > deepest.md + 1;
            k('Injection point', _kfmt(p, R.lift.injMd, R.lift.injTvd).replace(/ ft$|\s\S+$/, ''), !vs.rows.length ? 'point of balance (no valves)' : ('system solve: point of balance — not yet at the ' + (vs.src === 'installed' ? 'installed' : 'design') + ' valves' + (below ? ' (below the deepest valve)' : '')), below ? 'warn' : 'info',
                vs.rows.length ? 'The operating solve injects at the point of balance; the valve set is not yet used by the system solve' : 'The point of balance of the operating solve');
        }
        if (S.des && S.des.ok && S.des.valves) {
            var ov = S.des.valves.filter(function (v) { return v.role === 'Operating'; })[0];
            if (ov && ov.tc) k('Port throughput', p.u(ov.tc.q, 'gasRateSmall', 0, 'Mscf/d'), 'need ' + p.u(S.des.qinj, 'gasRateSmall', 0, 'Mscf/d') + ' · ' + (PORT_TXT[ov.port] || ov.port + '/64') + ' in' + (ov.tc.critical ? ' · critical' : ''), ov.tc.q >= S.des.qinj ? 'ok' : 'fail', 'Thornhill-Craver (provisional) at the operating valve');
        }
        var a = S.ash;
        if (a && a.ok) {
            k('Static stability F1', _fin(a.F1) ? p.fmt(a.F1, 2) : '∞', 'inflow / outflow slopes · stable > 1', a.stable1 ? 'ok' : 'fail', 'Static inflow-to-outflow slope ratio at the operating point (screening, after Asheim 1988) — provisional');
            if (_fin(a.F2)) k('Injection loop gain F2', p.fmt(a.F2, 2), 'valve–column' + (a.parts.critical ? ' · critical port' : '') + ' · stable < 1', a.stable2 ? 'ok' : 'warn', 'Valve-to-column loop gain (screening, after Asheim 1988; casing heading not assessed) — provisional');
        }
        if (S.diag) k('Diagnosis', S.diag.ok ? ({ ok: 'normal', warn: 'check', fail: 'problem' }[S.diag.verdict]) : 'not run', S.diag.ok ? (S.diag.test.id ? 'test ' + S.diag.test.id : 'selected test') : ((S.diag.errors || [])[0] || ''), S.diag.ok ? S.diag.verdict : 'info');
        if (S.sur && S.sur.ok) k('Survey match', 'RMS ' + p.fmt(p.dv(S.sur.rms, 'pressure'), 0) + ' ' + p.lab('pressure', 'psi'), S.sur.n + ' stops · bias ' + p.fmt(p.dv(S.sur.bias, 'pressure'), 0), S.sur.verdict);
        h.innerHTML = out.join('');
    }
    function _renderTable(p) {
        var h = _byId('wpg_tbl'); if (!h) return;
        var vs = _vset(p); if (!vs.rows.length) { h.innerHTML = '<div class="wp-v info">No valves yet: set the injection pressure and rate above, then <b>Design the valves</b> in step ④ (or enter the installed mandrels).</div>'; return; }
        var dl = p.lab('length', 'ft'), pl = p.lab('pressureG', 'psig'), tl = p.lab('temperature', '°F'), ql = p.lab('gasRateSmall', 'Mscf/d');
        var diag = S.diag && S.diag.ok ? S.diag : null;
        var head = ['#', 'MD (' + dl + ')', 'TVD (' + dl + ')', 'T (' + tl + ')', 'Port', 'p<sub>tro</sub> (' + pl + ')'].concat(diag ? ['p<sub>c</sub> (' + pl + ')', 'p<sub>t</sub> (' + pl + ')', 'p<sub>vo</sub> (' + pl + ')', 'Gas (' + ql + ')', 'Status'] : ['p<sub>vo</sub> (' + pl + ')', 'p<sub>t</sub> (' + pl + ')', 'Capacity (' + ql + ')', 'Role']);
        var rows = vs.rows.map(function (v, i) {
            var st = _state(v), cls = (st === 'operating' ? ' class="op"' : '');
            var c = [String(i + 1), p.fmt(p.dv(v.md, 'length'), 0), p.fmt(p.dv(p.tvdAt(v.md), 'length'), 0)];
            if (diag) {
                var d = diag.valves.filter(function (x) { return Math.abs(x.md - v.md) < 0.5; })[0] || {};
                c.push(_fin(d.t) ? p.fmt(p.dv(d.t, 'temperature'), 0) : '—', (PORT_TXT[v.port] || v.port + '/64'), _fin(v.ptro) ? p.fmt(p.dv(v.ptro, 'pressureG'), 0) : '—',
                    _fin(d.pc) ? p.fmt(p.dv(d.pc - PATM, 'pressureG'), 0) : '—', _fin(d.pt) ? p.fmt(p.dv(d.pt - PATM, 'pressureG'), 0) : '—', _fin(d.pvo) ? p.fmt(p.dv(d.pvo - PATM, 'pressureG'), 0) : '—',
                    _fin(d.q) ? p.fmt(p.dv(d.q, 'gasRateSmall'), 0) + (d.critical ? ' ●' : '') : '—', d.status || '—');
            } else {
                c.push(_fin(v.t) ? p.fmt(p.dv(v.t, 'temperature'), 0) : '—', (PORT_TXT[v.port] || v.port + '/64'), _fin(v.ptro) ? p.fmt(p.dv(v.ptro, 'pressureG'), 0) : '—',
                    _fin(v.pvo) ? p.fmt(p.dv(v.pvo, 'pressureG'), 0) : '—', _fin(v.pt) ? p.fmt(p.dv(v.pt, 'pressureG'), 0) : '—', v.tc ? p.fmt(p.dv(v.tc.q, 'gasRateSmall'), 0) + (v.tc.critical ? ' ●' : '') : '—', v.role ? v.role.toLowerCase() + (v.moved ? ' · moved' : '') : (vs.src === 'installed' ? 'installed' : '—'));
            }
            return '<tr' + (v.dragging ? ' class="drag"' : '') + '>' + c.map(function (x, j) { return '<td' + (j === c.length - 1 ? ' class="st"' : (j === 0 ? cls : '')) + (j > 0 && j < c.length - 1 ? ' style="text-align:right"' : '') + '>' + (j === c.length - 1 || j === 4 ? _esc(x) : x) + '</td>'; }).join('') + '</tr>';
        });
        h.innerHTML = '<div class="wp-tw"><table class="dtable wpg-tbl"><thead><tr>' + head.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
            '<div class="wp-hint" style="margin:4px 0 0">● critical port flow (Thornhill-Craver, provisional). ' + (vs.src === 'design' ? 'Design valves — not installed until you use the design.' : 'Installed valves of this well.') + '</div>';
    }
    function _renderVerd(p) {
        var h = _byId('wpg_verd'); if (!h) return;
        var out = [], add = function (st, t) { out.push(p.vHtml({ st: st, t: (st === 'ok' ? '✓ ' : st === 'fail' ? '✗ ' : st === 'info' ? 'ℹ ' : '⚠ ') + t })); };
        if (S.msg) add(S.msg.st, S.msg.t);
        var D = S.des;
        if (D && D.ok) {
            if (D.stale) add('info', 'The design is from the previous inputs — design again.');
            var g = D.gl;
            add(g.reachesPoi ? 'ok' : 'warn', D.valves.length + ' valves; operating valve at ' + _kfmt(p, D.operating ? D.operating.md : g.poiValve, D.operating ? D.operating.tvd : g.poiValveTvd) + ', operating surface injection ' + p.u(D.valves[D.valves.length - 1].pso, 'pressureG', 0, 'psig') + ' (' + p.u(D.inputs.dpdrop, 'pressure', 0, 'psi') + ' per valve).');
            // the design's own sub-critical note is left out when a diagnosis of a test says the same about the installed valve
            (D.warnings || []).forEach(function (w) { if (w.code !== 'TC_PROVISIONAL' && w.code !== 'GLD_PROVISIONAL' && !(w.code === 'GL_SUBCRITICAL' && S.diag && S.diag.ok)) add(w.sev === 'info' ? 'info' : 'warn', w.msg); });
            // a valve moved off the design (drag) — order and spacing against the minimum (review fix v4.5)
            var spc = _spacingIssue(p, _vset(p).rows);
            if (spc) add('warn', spc);
        } else if (D && !D.ok) add('warn', 'Design: ' + ((D.errors || [])[0] || 'failed'));
        if (!(D && D.ok)) { var spc2 = _spacingIssue(p, _vset(p).rows); if (spc2) add('warn', spc2); }
        if (S.diag && S.diag.ok) {
            if (!S.diag.flags.length) add('ok', 'Diagnosis: valve ' + S.diag.operating.n + ' operates alone at ' + _kfmt(p, S.diag.operating.md, S.diag.operating.tvd) + '; ' + p.u(S.diag.qinj, 'gasRateSmall', 0, 'Mscf/d') + ' within the valve throughput.');
            S.diag.flags.forEach(function (f) { add(f.sev === 'fail' ? 'fail' : (f.sev === 'info' ? 'info' : 'warn'), f.msg); });
        } else if (S.diag && !S.diag.ok) add('info', (S.diag.errors || [])[0] || 'Diagnosis not available.');
        var a = S.ash;
        if (a && a.ok) add(a.verdict === 'ok' ? 'ok' : a.verdict === 'fail' ? 'fail' : 'warn', 'Static stability and injection loop gain (screening, after Asheim 1988; annulus-volume casing heading not modelled): F1 ' + (_fin(a.F1) ? p.fmt(a.F1, 2) : '∞') + (a.stable1 ? ' > 1' : ' ≤ 1') + (_fin(a.F2) ? ', F2 ' + p.fmt(a.F2, 2) + (a.stable2 ? ' < 1' : ' ≥ 1 (heading risk: a larger valve ΔP or a smaller port makes the port flow critical)') : '') + ' — provisional.');
        if (S.sur && S.sur.ok && S.sur.brk) add('info', 'Survey gradient break at ' + _kfmt(p, S.sur.brk.md, S.sur.brk.tvd) + (S.sur.nearValve ? ' — valve ' + S.sur.nearValve.n + ' (' + p.u(S.sur.nearValve.dMd, 'length', 0, 'ft') + ' away)' : '') + '.');
        if ((D && D.ok) || (a && a.ok)) add('info', 'The valve design on the model path, the Thornhill-Craver throughput and the stability screening numbers are provisional — not verified against a published example.');
        h.innerHTML = out.join('');
    }
    function _renderEditor(p) {
        var h = _byId('wpg_edit'); if (!h) return;
        var ae = document.activeElement; if (ae && h.contains && h.contains(ae)) return;            // keep the cell being edited
        var M = p.ST.M, inst = (M && M.lift && M.lift.gl && M.lift.gl.valves) || [], dl = p.lab('length', 'ft'), pl = p.lab('pressureG', 'psig');
        if (!inst.length) { h.innerHTML = '<div class="wp-v info">No installed valves. <b>Use this design</b> after a design, or <b>Add a valve</b>.</div>'; return; }
        h.innerHTML = '<div class="wp-tw"><table class="dtable wpg-ed"><thead><tr><th>#</th><th>MD (' + _esc(dl) + ')</th><th>TVD</th><th>Port</th><th>p<sub>tro</sub> (' + _esc(pl) + ')</th><th>Kind</th><th></th></tr></thead><tbody>' +
            inst.map(function (v, i) {
                return '<tr data-i="' + i + '"><td>' + (i + 1) + '</td><td><input type="number" step="any" inputmode="decimal" data-glv="md" data-i="' + i + '" aria-label="Valve ' + (i + 1) + ' MD" value="' + _esc(_fin(+v.md) ? Math.round(p.dv(+v.md, 'length')) : '') + '"></td>' +
                    '<td class="ro">' + p.fmt(p.dv(p.tvdAt(+v.md), 'length'), 0) + '</td>' +
                    '<td><select data-glv="port" data-i="' + i + '" aria-label="Valve ' + (i + 1) + ' port">' + PORTS.map(function (x) { return '<option value="' + x + '"' + (+v.port === x ? ' selected' : '') + '>' + PORT_TXT[x] + '</option>'; }).join('') + '</select></td>' +
                    '<td><input type="number" step="any" inputmode="decimal" data-glv="ptro" data-i="' + i + '" aria-label="Valve ' + (i + 1) + ' test-rack opening pressure" value="' + _esc(_fin(+v.ptro) ? Math.round(p.dv(+v.ptro, 'pressureG')) : '') + '"></td>' +
                    '<td><select data-glv="kind" data-i="' + i + '" aria-label="Valve ' + (i + 1) + ' kind">' + [['ipo', 'IPO valve'], ['orifice', 'Orifice'], ['dummy', 'Dummy']].map(function (o) { return '<option value="' + o[0] + '"' + ((v.kind || 'ipo') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' +
                    '<td><button type="button" class="btn btn-secondary wp-del" data-act="wpg_del" data-i="' + i + '" aria-label="Remove valve ' + (i + 1) + '" title="Remove valve">&#10005;</button></td></tr>';
            }).join('') + '</tbody></table></div>';
        if (!h._wpg) {
            h._wpg = true;
            h.addEventListener('change', function (e) {
                var t = e.target; if (!t || !t.getAttribute || !t.getAttribute('data-glv')) return;
                var p2 = P(); if (!p2) return;
                var M2 = p2.ST.M, rows = ((M2 && M2.lift.gl.valves) || []).map(function (v) { return { md: v.md, port: v.port || 16, ptro: v.ptro, R: v.R, kind: v.kind || 'ipo' }; });
                var i = +t.getAttribute('data-i'), k = t.getAttribute('data-glv'); if (!rows[i]) return;
                var x = t.value;
                if (k === 'md') { var d = _num(x); if (_fin(d) && d > 0) rows[i].md = p2.fromDisp(d, 'length'); }
                else if (k === 'ptro') { var q = _num(x); rows[i].ptro = _fin(q) ? p2.fromDisp(q, 'pressureG') : null; }
                else if (k === 'port') { rows[i].port = +x; rows[i].R = G.WTS_wp_gl.portR(+x); }
                else if (k === 'kind') rows[i].kind = x;
                _commitValves(rows);
            });
        }
    }
    function _renderTests(p) {
        var sel = _byId('wpv_gld_test'), hint = _byId('wpg_testhint'); if (!sel) return;
        var M = p.ST.M, ts = _tests(M), cur = _testSel(p, M);
        sel.innerHTML = ts.length ? ts.map(function (x) { return '<option value="' + x.i + '"' + (cur && cur.i === x.i ? ' selected' : '') + '>' + _esc((x.t.id || ('T' + (x.i + 1))) + (x.t.date ? ' · ' + x.t.date : '') + ' — CHP ' + p.u(+x.t.chp_psig, 'pressureG', 0, 'psig')) + '</option>'; }).join('') : '<option value="">— no test with a CHP —</option>';
        sel.disabled = !ts.length;
        if (hint) hint.innerHTML = ts.length ? 'The casing pressure at every valve comes from the CHP (gas column over TVD), the tubing pressure from the THP marched down the hole with the metered lift gas.' :
            'Add a test with its <b>CHP</b> and <b>lift gas</b> in step ⑥ (test table) to diagnose the operating valve.';
    }
    function _renderSurvey(p) {
        var h = _byId('wpg_svres'); if (!h) return;
        var s = S.sur, out = '';
        if (S.surParse && S.surParse.warnings) S.surParse.warnings.forEach(function (w) { out += p.vHtml({ st: 'info', t: 'ℹ ' + w.msg }); });
        if (s && !s.ok) out += p.vHtml({ st: 'warn', t: '⚠ ' + ((s.errors || [])[0] || 'The survey could not be matched.') });
        else if (s && s.ok) {
            var dl = p.lab('length', 'ft'), pl = p.lab('pressure', 'psia');
            out += '<div class="rbox"><div class="rbox-title">Flowing gradient survey against the model</div>' +
                '<div class="rrow"><span class="rl">Stops on the path</span><span class="rv">' + s.n + '</span></div>' +
                '<div class="rrow"><span class="rl">RMS / bias / worst</span><span class="rv">' + _esc(p.fmt(p.dv(s.rms, 'pressure'), 1) + ' / ' + p.fmt(p.dv(s.bias, 'pressure'), 1) + ' / ' + p.fmt(p.dv(s.maxAbs, 'pressure'), 1) + ' ' + p.lab('pressure', 'psi')) + '</span></div>' +
                (_fin(s.rmsT) ? '<div class="rrow"><span class="rl">Temperature RMS</span><span class="rv">' + _esc(p.tempDiff(s.rmsT)) + '</span></div>' : '') +
                (s.brk ? '<div class="rrow"><span class="rl">Gradient break (injection)</span><span class="rv">' + _esc(_kfmt(p, s.brk.md, s.brk.tvd)) + '</span></div>' +
                    '<div class="rrow"><span class="rl">Gradient above / below</span><span class="rv">' + _esc(p.fmt(p.dv(s.brk.gUp, 'pressureGradient'), 3) + ' / ' + p.fmt(p.dv(s.brk.gDown, 'pressureGradient'), 3) + ' ' + p.lab('pressureGradient', 'psi/ft')) + '</span></div>' : '') +
                (s.nearValve ? '<div class="rrow"><span class="rl">Nearest valve</span><span class="rv">' + _esc('V' + s.nearValve.n + ' at ' + _kfmt(p, s.nearValve.md, s.nearValve.tvd)) + '</span></div>' : '') +
                (p.ST.R && p.ST.R.lift && _fin(p.ST.R.lift.injMd) ? '<div class="rrow"><span class="rl">Model injection point</span><span class="rv">' + _esc(_kfmt(p, p.ST.R.lift.injMd, p.ST.R.lift.injTvd)) + '</span></div>' : '') +
                p.vHtml({ st: s.verdict, t: (s.verdict === 'ok' ? '✓ The model follows the survey (RMS ≤ 25 psi).' : s.verdict === 'warn' ? '⚠ The model is off the survey by ' + p.fmt(s.rms, 0) + ' psi RMS: check the rates, the lift gas or tune the correlation (step ⑥).' : '✗ The model is far from the survey: check the depth axis, the pressure basis and the test.') }) + '</div>';
            void dl; void pl;
        }
        h.innerHTML = out;
    }

    // ── the valve chart ──────────────────────────────────────────────────────
    function _drawChart(p) {
        var cv = _byId('wp_cv_glv'), V = G.WTS_wp_view; if (!cv || !V) return;
        var T = V.theme(), dax = _depthAx(p), view = _view(p), vs = _vset(p), ser = [], mk = [], hl = [], handles = [];
        var D = S.des && S.des.ok ? S.des : null, dg = S.diag && S.diag.ok ? S.diag : null, R = p.ST.R;
        var Y = function (md, tvd) { return p.dv(dax === 'md' ? md : (_fin(tvd) ? tvd : p.tvdAt(md)), 'length'); };
        var Xg = function (psig) { return p.dv(psig, 'pressureG'); }, Xa = function (psia) { return p.dv(psia - PATM, 'pressureG'); };
        var line = function (key, label, arr, col, w, dash, toX) { var pts = (arr || []).filter(function (c) { return c && _fin(c.p) && _fin(c.d); }).map(function (c) { return [toX(c.p), Y(c.d, c.tvd)]; }); if (pts.length > 1) ser.push({ key: key, label: label, color: col, width: w, dash: dash, pts: pts }); };
        if (view === 'design' && D) {
            var c = D.gl.curves;
            line('pko', 'Casing at kickoff', c.pko, T.purple, 1.6, [6, 4], Xg);
            line('pso', 'Casing at injection', c.pso, T.purple, 2.2, null, Xg);
            line('ptd', 'Design tubing line', c.ptd, T.yellow, 1.8, [4, 4], Xg);
            // the unloading kill-fluid lines (null-separated legs)
            var legs = [], cur = [];
            (c.load || []).forEach(function (q) { if (!q) { if (cur.length) legs.push(cur); cur = []; } else cur.push(q); }); if (cur.length) legs.push(cur);
            legs.forEach(function (lg, i) { var pts = lg.map(function (q) { return [Xg(q.p), Y(q.d, q.tvd)]; }); ser.push({ key: 'ld' + i, label: i ? '' : 'Unloading (kill fluid)', legend: i === 0, color: T.blue, width: 1.3, pts: pts }); });
            line('ab', 'Tubing, with lift gas', c.above, T.accent, 2.4, null, Xg);
            line('bl', 'Tubing, formation gas', c.below, T.red, 1.8, [3, 3], Xg);
            if (_fin(D.gl.poiValve)) hl.push({ y: Y(D.gl.poiValve), label: 'point of injection', color: T.accent, dash: [2, 3] });
        } else if (view === 'diag' && dg) {
            ser.push({ key: 'cas', label: 'Casing from the CHP', color: T.purple, width: 2.2, pts: dg.casing.map(function (r) { return [Xa(r.p), Y(r.md, r.tvd)]; }) });
            ser.push({ key: 'tub', label: 'Tubing from the THP', color: T.accent, width: 2.4, pts: dg.tubing.map(function (r) { return [Xa(r.p), Y(r.md, r.tvd)]; }) });
            dg.valves.forEach(function (v) { if (_fin(v.pvo)) mk.push({ x: Xa(v.pvo), y: Y(v.md, v.tvd), kind: 'hollow', color: v.passing ? T.green : T.text2, r: 4.5 }); });
        } else if (R && R.ok && R.lift) {
            // no design and no diagnosis yet: the operating traverse and the casing column of the solve
            var prof = (R.traverse && R.traverse.profile) || [];
            ser.push({ key: 'tr', label: 'Tubing (operating point)', color: T.accent, width: 2.2, pts: prof.filter(function (r) { return _fin(r.p) && !r.restr; }).map(function (r) { return [Xa(r.p), Y(r.md, r.tvd)]; }) });
            ser.push({ key: 'cs', label: 'Casing (lift gas)', color: T.purple, width: 2, dash: [8, 4], pts: (R.lift.casing || []).map(function (r) { return [Xa(r.p), Y(r.md, r.tvd)]; }) });
        }
        // the survey stops and their break
        if (S.sur && S.sur.ok) {
            ser.push({ key: 'sv', label: 'Gradient survey', kind: 'points', color: T.green, r: 4.5, pts: S.sur.rows.map(function (r) { return [Xa(r.p), Y(r.md, r.tvd)]; }) });
            if (S.sur.brk) hl.push({ y: Y(S.sur.brk.md, S.sur.brk.tvd), label: 'survey break', color: T.green, dash: [5, 3] });
        }
        var pk = R && R.ok && R.lift && _fin(R.lift.packerMd) ? R.lift.packerMd : null;
        if (_fin(pk)) hl.push({ y: Y(pk), label: 'packer', color: T.text2, dash: [4, 4] });
        // a knob per valve at its opening (or tubing) pressure: vertical drag = a new depth
        var xs = []; ser.forEach(function (s) { (s.pts || []).forEach(function (q) { if (_fin(q[0])) xs.push(q[0]); }); });
        var xMax = xs.length ? Math.max.apply(null, xs) : 1500, yMaxMd = (p.ST.W && p.ST.W.nodes && _fin(p.ST.W.nodes.midPerfMd)) ? p.ST.W.nodes.midPerfMd : 10000;
        vs.rows.forEach(function (v, i) {
            var st = _state(v), col = T[STATE_COL[st]] || T.blue, dgv = dg ? dg.valves.filter(function (x) { return Math.abs(x.md - v.md) < 0.5; })[0] : null;
            var xv = dgv && _fin(dgv.pc) ? Xa(dgv.pc) : (_fin(v.pvo) ? Xg(v.pvo) : (_fin(v.ptro) ? Xg(v.ptro) : xMax * 0.9));
            handles.push({ key: 'glv' + i, kind: 'point', x: xv, value: Y(v.md, v.tvd), min: 0, max: Y(Math.max(0, (pk || yMaxMd) - 10)), step: p.metric() ? 3 : 10, label: 'V' + (i + 1), color: col,
                fmt: function (vv) { var dr = S.drag && S.drag.i === i, md = dr ? _mdOf(p, vv, dax) : v.md; return p.phone() ? p.fmt(p.dv(md, 'length'), 0) : p.fmt(p.dv(md, 'length'), 0) + ' MD'; } });
        });
        var empty = !_on(p.ST.M) ? 'Choose gas lift to design the valves.' : (view === 'diag' ? 'Choose a test with a CHP (step ⑥) and valves to see the diagnosis.' : 'Design the valves in step ④ to see the design chart.');
        V.chart(cv, { key: 'glv:' + view + ':' + dax + (p.metric() ? 'm' : 'i'), aspect: p.phone() ? 1.3 : 0.7, minH: 300, maxH: 560, w: 640, readout: 'y',
            x: { label: 'Pressure (' + p.lab('pressureG', 'psig') + ')', min: 0, short: 'p', fmtR: function (v) { return p.fmt(v, 0) + ' ' + p.lab('pressureG', 'psig'); } },
            y: { label: (dax === 'md' ? 'MD' : 'TVD') + ' (' + p.lab('length', 'ft') + ')', invert: true, min: 0, short: 'Depth', fmtR: function (v) { var md = _mdOf(p, v, dax), tvd = dax === 'md' ? p.tvdAt(md) : p.fromDisp(v, 'length'); return p.fmt(p.dv(md, 'length'), 0) + ' MD · ' + p.fmt(p.dv(tvd, 'length'), 0) + ' TVD'; } },
            series: ser, markers: mk, hlines: hl, handles: handles, onHandle: _onHandle, empty: (ser.length || handles.length) ? null : empty,
            hidden: p.plots().glvHidden || null, onLegend: function (hid) { p.plotsSet({ glvHidden: hid }); } });
    }
    function _minSp(p) {
        var d = (p.ST.M && p.ST.M.lift && p.ST.M.lift.gl && p.ST.M.lift.gl.design) || {}, v = _num(d.minsp);
        if (!_fin(v) && S.des && S.des.inputs && _fin(S.des.inputs.minsp)) v = S.des.inputs.minsp;
        return _fin(v) && v >= 0 ? v : 250;
    }
    // valves out of order or closer than the minimum spacing (MD) → a warning text, else null
    function _spacingIssue(p, rows) {
        if (!rows || rows.length < 2) return null;
        var msp = _minSp(p), bad = null;
        for (var i = 1; i < rows.length && !bad; i++) {
            var d = rows[i].md - rows[i - 1].md;
            if (d < msp - 0.5) bad = 'Valves ' + i + ' and ' + (i + 1) + ' are ' + p.u(Math.max(0, d), 'length', 0, 'ft') + ' apart (MD), below the minimum spacing ' + p.u(msp, 'length', 0, 'ft') + (d < 0 ? ' — out of order' : '') + ': move one or design again.';
        }
        return bad;
    }
    function _mdOf(p, vDisp, dax) {
        var v = p.fromDisp(vDisp, 'length');
        if (dax === 'md') return v;
        var W = p.ST.W, md = W && W.ok && typeof W.mdAt === 'function' ? W.mdAt(v) : null;
        return _fin(md) ? md : v;
    }
    // a valve moved to MD md (chart knob, schematic drag, arrow keys): live preview; phase 'end' commits
    function _move(i, md, phase) {
        var p = P(), L = _L(); if (!p || !L) return;
        var vs = _vset(p); if (!vs.rows[i]) return;
        var W = p.ST.W, lim = W && W.nodes ? Math.min(_fin(p.ST.R && p.ST.R.lift && p.ST.R.lift.packerMd) ? p.ST.R.lift.packerMd : Infinity, _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : Infinity, W.nodes.midPerfMd || Infinity) : Infinity;
        md = Math.max(50, Math.min(_fin(lim) ? lim - 10 : md, Math.round(md / 5) * 5));
        // keep the order and the minimum spacing: between the neighbouring valves ± the minimum spacing (review fix v4.5)
        var msp = _minSp(p), prevV = vs.rows[i - 1], nextV = vs.rows[i + 1];
        var lo = prevV ? prevV.md + msp : 50, hi = nextV ? nextV.md - msp : Infinity, cur0 = vs.rows[i].md;
        // a set that already breaks the spacing (typed in the editor): only the order is kept, so the move is not pushed away
        if (!(lo <= hi && cur0 >= lo - 1 && cur0 <= hi + 1)) { lo = prevV ? prevV.md + 5 : 50; hi = nextV ? nextV.md - 5 : Infinity; }
        if (lo <= hi) md = Math.max(lo, Math.min(hi, md));
        if (vs.src === 'design') {
            var base = S.desRows[i], row = L.setValve({ ok: true, valves: S.desRows, gl: S.des.gl, inputs: S.des.inputs, _tAt: S.des._tAt, _tvdAt: S.des._tvdAt }, i, md);
            if (!row) return;
            if (phase === 'end') { S.desRows[i] = row; S.desRows.sort(function (a, b) { return a.md - b.md; }); S.desRows.forEach(function (r, k) { r.n = k + 1; }); S.desEdited = true; S.drag = null; S.diagKey = null; S.ashR = null; S.surR = null; void base; _rerender(p); return; }
            S.drag = { src: 'design', i: i, md: md, row: row };
        } else {
            if (phase === 'end') {
                var M = p.ST.M, rows = M.lift.gl.valves.map(function (v) { return { md: v.md, port: v.port || 16, ptro: v.ptro, R: v.R, kind: v.kind || 'ipo' }; });
                rows[i].md = md; S.drag = null; _commitValves(rows); return;           // the model write re-solves and re-renders
            }
            S.drag = { src: 'installed', i: i, md: md };
        }
        var rd = _byId('wpg_read'); if (rd) rd.textContent = 'Valve ' + (i + 1) + ' → ' + _kfmt(p, md) + (S.drag && S.drag.row && S.drag.row.tc ? ' · p_vo ' + p.u(S.drag.row.pvo, 'pressureG', 0, 'psig') + ' · capacity ' + p.u(S.drag.row.tc.q, 'gasRateSmall', 0, 'Mscf/d') : '');
        _drawChart(p); _renderTable(p);
        if (typeof p.renderSchematic === 'function') p.renderSchematic();
    }
    function _rerender(p) { render(false); if (typeof p.renderSchematic === 'function') p.renderSchematic(); _trRefresh(p); }
    function _onHandle(key, v, phase) {
        var m = /^glv(\d+)$/.exec(key || ''); if (!m) return false;
        var p = P(); if (!p) return true;
        _move(+m[1], _mdOf(p, v, _depthAx(p)), phase);
        return true;
    }

    // ── the schematic: mandrels, drag along the hole, arrow keys ────────────────────────────
    function marks() {
        var p = P(); if (!p || !_on(p.ST.M)) return null;
        var vs = _vset(p);
        return vs.rows.map(function (v, i) {
            var st = _state(v);
            return { md: v.md, kind: 'mandrel', state: st, comp: 'mandrel:' + i, label: 'V' + (i + 1) + (st === 'operating' ? ' operating' : '') + (p.phone() ? '' : ' · ' + p.fmt(p.dv(v.md, 'length'), 0) + ' ' + p.lab('length', 'ft')) };
        });
    }
    function _bindSchematic() {
        var sw = _byId('wp_schw'); if (!sw || sw._wpg25 || !sw.addEventListener) return;
        sw._wpg25 = true;
        var mdAtPtr = function (e) {
            var p = P(), host = _byId('wp_sch'), svg = host && host.querySelector('svg'); if (!p || !svg || !svg.getBoundingClientRect || !p.ST.schPts) return null;
            var r = svg.getBoundingClientRect(); if (!(r.width > 0)) return null;
            var vx = (e.clientX - r.left) * p.ST.schW / r.width, vy = (e.clientY - r.top) * p.ST.schH / r.height, best = null, bd = 1e9;
            p.ST.schPts.forEach(function (q) { var d = Math.hypot(q.x - vx, q.y - vy); if (d < bd) { bd = d; best = q; } });
            return best ? best.md : null;
        };
        sw.addEventListener('pointerdown', function (e) {
            var t = e.target, g = t && t.closest ? t.closest('[data-comp^="mandrel:"]') : null; if (!g) return;
            S.sdrag = { i: +g.getAttribute('data-comp').split(':')[1], moved: false, id: e.pointerId };
            if (sw.setPointerCapture) { try { sw.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } }
            if (e.preventDefault) e.preventDefault();
        });
        sw.addEventListener('pointermove', function (e) {
            if (!S.sdrag) return;
            var md = mdAtPtr(e); if (!_fin(md)) return;
            S.sdrag.moved = true; S.sdrag.md = md; _move(S.sdrag.i, md, 'move');
        });
        var end = function () { if (!S.sdrag) return; var d = S.sdrag; S.sdrag = null; if (d.moved && _fin(d.md)) { S.noClick = true; _move(d.i, d.md, 'end'); } };
        sw.addEventListener('pointerup', end); sw.addEventListener('pointercancel', end);
        sw.addEventListener('click', function (e) { if (S.noClick) { S.noClick = false; if (e.stopPropagation) e.stopPropagation(); if (e.preventDefault) e.preventDefault(); } }, true);
        sw.addEventListener('keydown', function (e) {
            var t = e.target, c = t && t.getAttribute ? t.getAttribute('data-comp') : null, m = /^mandrel:(\d+)$/.exec(c || '');
            if (!m || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            var p = P(); if (!p) return;
            var v = _vset(p).rows[+m[1]]; if (!v) return;
            if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation();
            _move(+m[1], v.md + (e.key === 'ArrowDown' ? 1 : -1) * (e.shiftKey ? 10 : 50), 'end');
            var host = _byId('wp_sch'), el = host && host.querySelector('[data-comp="mandrel:' + m[1] + '"]'); if (el && el.focus) el.focus();
        }, true);
    }

    // ── the traverse plot: valve lines and the survey ──────────────────────────────────────
    function trPlot(o) {
        var p = P(); if (!p || !o || !_on(p.ST.M)) return null;
        var T = o.T, dax = o.dax, Y = function (md, tvd) { return p.dv(dax === 'md' ? md : (_fin(tvd) ? tvd : p.tvdAt(md)), 'length'); };
        _vset(p).rows.forEach(function (v, i) {
            var st = _state(v);
            o.hlines.push({ _wpg: true, y: Y(v.md, v.tvd), label: st === 'operating' ? 'V' + (i + 1) + ' operating' : '', color: T[STATE_COL[st]] || T.blue, dash: st === 'operating' ? [6, 3] : [2, 5] });
        });
        if (S.surRows && S.surR !== p.ST.R) { var L = _L(); if (L) { S.sur = L.matchSurvey(p.ST.M, p.ST.R, S.surRows, { W: p.ST.W, valves: _vset(p).rows }); S.surR = p.ST.R; } }
        if (S.sur && S.sur.ok) o.series.push({ key: 'gls', label: 'Gradient survey', kind: 'points', color: T.green, r: 4.5, pts: S.sur.rows.map(function (r) { return [p.dv(r.p, 'pressure'), Y(r.md, r.tvd)]; }) });
        return true;
    }

    // the traverse card keeps its spec: after a design, a drag or a survey the valve lines and survey points are put in again and redrawn
    function _trRefresh(p) {
        var cv = _byId('wp_cv_tr'), V = G.WTS_wp_view, sp = cv && cv._wp && cv._wp.spec; if (!sp || !V || !/^trav:/.test(sp.key || '')) return;
        sp.series = (sp.series || []).filter(function (s) { return s.key !== 'gls'; }); sp.hlines = (sp.hlines || []).filter(function (h) { return !h._wpg; });
        trPlot({ series: sp.series, hlines: sp.hlines, dax: /^trav:md/.test(sp.key) ? 'md' : 'tvd', T: V.theme() });
        V.redraw(cv);
    }

    // ── actions ──────────────────────────────────────────────────────────────
    function act(a, btn) {
        if (!/^wpg_/.test(a || '')) return false;
        var p = P(), L = _L(); if (!p) return true;
        var M = p.ST.M, R = p.ST.R;
        if (a === 'wpg_view') { p.plotsSet({ glvView: btn.getAttribute('data-v') }); _drawChart(p); _syncButtons(p); return true; }
        if (a === 'wpg_depth') { p.plotsSet({ glvDepth: btn.getAttribute('data-v') }); _drawChart(p); _syncButtons(p); return true; }
        if (!L) { var m0 = _byId('wpg_msg'); if (m0) m0.innerHTML = p.vHtml({ st: 'warn', t: '⚠ The gas-lift design engine is not available.' }); return true; }
        if (a === 'wpg_design') {
            S.msg = null;
            p.drive(L.design(M, R), function (r) {
                S.des = r; S.desKey = _mkey(M); S.desEdited = false; S.desRows = r && r.ok ? r.valves.map(function (v) { var c = {}; Object.keys(v).forEach(function (k) { c[k] = v[k]; }); return c; }) : null;
                if (r && !r.ok) S.msg = { st: 'warn', t: (r.errors || [])[0] || 'The design failed.' };
                S.diagKey = null; S.ashR = null; S.surR = null;
                if (r && r.ok) p.plotsSet({ glvView: 'design' });
                _rerender(p);
            }, 'Gas-lift design', 'wpg_msg');
            return true;
        }
        if (a === 'wpg_use') {
            if (!(S.desRows && S.desRows.length)) return true;
            S.msg = { st: 'ok', t: S.desRows.length + ' valves written to this well (installed).' };
            _commitValves(S.desRows.map(function (v) { return { md: v.md, port: v.port, ptro: v.ptro, R: v.R, kind: 'ipo' }; }));
            return true;
        }
        if (a === 'wpg_port') {
            if (S.des && S.des.portRec) { p.setCtrl('wp_gld_port', String(S.des.portRec)); p.commit('wp_gld_port'); S.msg = { st: 'info', t: 'Port ' + PORT_TXT[S.des.portRec] + ' in set — design again.' }; }
            return true;
        }
        var inst = (M && M.lift.gl.valves) ? M.lift.gl.valves.map(function (v) { return { md: v.md, port: v.port || 16, ptro: v.ptro, R: v.R, kind: v.kind || 'ipo' }; }) : [];
        if (a === 'wpg_add') {
            var last = inst.length ? inst[inst.length - 1].md : 1500, W = p.ST.W, lim = W && W.nodes && _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd - 30 : last + 1000;
            inst.push({ md: Math.min(lim, last + (inst.length ? 600 : 0)), port: 16, ptro: null, R: L.portR(16), kind: 'ipo' });
            _commitValves(inst); return true;
        }
        if (a === 'wpg_del') { var i = +btn.getAttribute('data-i'); inst.splice(i, 1); _commitValves(inst); return true; }
        if (a === 'wpg_clear') { _commitValves([]); S.msg = { st: 'info', t: 'The installed valves were removed (the design stays on the page).' }; return true; }
        if (a === 'wpg_survey') { _survey(p); return true; }
        if (a === 'wpg_svclear') { var ta = _byId('wpv_gls_text'); if (ta) ta.value = ''; S.surRows = null; S.sur = null; S.surParse = null; S.surR = null; _rerender(p); return true; }
        return true;
    }
    function _survey(p) {
        var L = _L(), ta = _byId('wpv_gls_text'); if (!L || !ta) return;
        var pr = L.parseSurvey(ta.value, { axis: (_byId('wpv_gls_axis') || {}).value, unit: (_byId('wpv_gls_unit') || {}).value });
        S.surParse = pr;
        if (!pr.ok) { S.surRows = null; S.sur = { ok: false, errors: pr.errors }; _renderSurvey(p); return; }
        // the survey is entered in field units unless its header says m / bar / kPa; Metric display: the page converts
        S.surRows = pr.rows; S.surR = null; S.sur = null;
        _update(p, false); _rerender(p);
    }
    function change(el) {
        if (!el || !/^wpv_gl[ds]_/.test(el.id || '')) return false;
        var p = P(); if (!p) return true;
        if (el.id === 'wpv_gld_test') { p.plotsSet({ glTest: el.value === '' ? null : +el.value }); S.diagKey = null; _rerender(p); return true; }
        if ((el.id === 'wpv_gls_axis' || el.id === 'wpv_gls_unit') && S.surRows) { _survey(p); return true; }
        return true;
    }
    function comp(c) {
        var m = /^mandrel:(\d+)$/.exec(c || ''); if (!m) return null;
        var tr = document.querySelector('#wpg_edit tr[data-i="' + m[1] + '"]'), card = _byId('wpg_dcard');
        if (tr) { if (tr.classList) { tr.classList.remove('wp-flash'); tr.classList.add('wp-flash'); } var inp = tr.querySelector('input'); if (inp && inp.focus) inp.focus(); }
        else if (card && card.scrollIntoView) { try { card.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } }
        return true;
    }

    // ── report / CSV / notes ─────────────────────────────────────────────────
    function csv() {
        var p = P(); if (!p || !_on(p.ST.M)) return null;
        var vs = _vset(p); if (!vs.rows.length && !S.sur) return null;
        var L = ['Gas-lift valves (' + vs.src + '),MD ft,TVD ft,port /64 in,ptro psig,state'];
        vs.rows.forEach(function (v, i) { L.push('V' + (i + 1) + ',' + Math.round(v.md) + ',' + Math.round(_fin(v.tvd) ? v.tvd : p.tvdAt(v.md)) + ',' + v.port + ',' + (_fin(v.ptro) ? Math.round(v.ptro) : '') + ',' + _state(v)); });
        if (S.diag && S.diag.ok) { L.push(''); L.push('Diagnosis,MD ft,pc psia,pt psia,pvo psia,gas Mscf/d,status'); S.diag.valves.forEach(function (v) { L.push('V' + v.n + ',' + Math.round(v.md) + ',' + (_fin(v.pc) ? v.pc.toFixed(1) : '') + ',' + (_fin(v.pt) ? v.pt.toFixed(1) : '') + ',' + (_fin(v.pvo) ? v.pvo.toFixed(1) : '') + ',' + (_fin(v.q) ? v.q.toFixed(0) : '') + ',"' + v.status + '"'); }); }
        if (S.sur && S.sur.ok) { L.push(''); L.push('Gradient survey,MD ft,TVD ft,p psia,model psia,difference psi'); S.sur.rows.forEach(function (r) { L.push(',' + Math.round(r.md) + ',' + Math.round(r.tvd) + ',' + r.p.toFixed(1) + ',' + r.pModel.toFixed(1) + ',' + r.dp.toFixed(1)); }); }
        return L;
    }
    function notes() {
        var p = P(); if (!p || !_on(p.ST.M)) return null;
        return ['Gas-lift design: unloading valves spaced after API RP 11V6 on the deviated path (gas column and kill-fluid gradient on TVD, spacing on MD) with the model\'s inflow, well correlation and flowing temperatures — the design on the model path, the Thornhill-Craver valve throughput with the critical-ratio cap and the static stability / injection loop-gain screening numbers (after Asheim 1988; casing heading from the annulus volume not modelled) are provisional — not verified against a published example. The system solve injects at the point of balance, not yet at the installed valves.'];
    }
    function reset() { S.des = null; S.desKey = null; S.desRows = null; S.desEdited = false; S.diag = null; S.diagKey = null; S.ash = null; S.ashR = null; S.sur = null; S.surR = null; S.surRows = null; S.surParse = null; S.drag = null; S.sdrag = null; S.msg = null; }
    function resize() { var cv = _byId('wp_cv_glv'); if (cv && G.WTS_wp_view) G.WTS_wp_view.redraw(cv); }
    function renderHook(live) { _bindSchematic(); render(live); }

    G.WTS_wellperf_ext = G.WTS_wellperf_ext || {};
    G.WTS_wellperf_ext.gldesign = { resHtml: resHtml, stepHtml: stepHtml, render: renderHook, act: act, change: change, marks: marks, trPlot: trPlot, handle: function (k, v, ph) { return _onHandle(k, v, ph) === true; },
        comp: comp, csv: csv, notes: notes, reset: reset, resize: resize, state: function () { return S; }, move: function (i, md, phase) { _move(i, md, phase || 'end'); } };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, E = G.WTS_wellperf_ext && G.WTS_wellperf_ext.gldesign;
    if (!(E && typeof E.resHtml === 'function' && typeof E.act === 'function' && E.act('other') === false) && typeof console !== 'undefined') console.error('[49-calc-wp-glui.js self-test] extension malformed');
})();
