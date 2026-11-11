// =============================================================================
// WTS — 49-calc-wp-model.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// window.WTS_wp_model — the Well Performance model reader / writer (docs/WELL-PERFORMANCE-PLAN.md §2.8, §3.1, §3.11; WP0).
// The ONLY code that reads or writes the module's storage. Engines are pure and take the frozen model M it returns.
//
// Storage (both keys start with "wts_", so 29-multiwell makes them per well and project files carry them; no project module):
//   wts_page_wellperf   host autosave of the page's id'd scalar controls ({f: {id: value}}; unit-tagged inputs canonical imperial)
//   wts_wellperf_model  tables, JSON v1: {v:1, survey, strings, restrictions, geo, flowline, rating, beans, tests, lab, pump, cases}
//
// API (field units, §3.0; nothing throws for user data)
//   SCALARS                      control id → {path, kind:'num'|'str'|'bool'|'list', scale?} — the page's scalar contract (wp_*)
//                                plus the prefix rule wp_ip_<name> → res.params.<name> (numeric IPR parameters)
//   DEFAULTS                     the default model (Appendix B), a frozen M
//   empty()                      a new v1 table record
//   readRaw(o?)                  {status:'none'|'ok'|'bad'|'future', rec, bytes}   (o.storage for tests)
//   read(o?)                     → M, deep-frozen (§3.1) + M.meta {status, readOnly, notes[]};
//                                o.scalars {id: value} overrides the stored page values (the page passes its live, canonical values)
//   write(patch, o?)             merges table keys into the stored record (validated, survey decimated above 2,000 rows, 256 kB cap),
//                                writes through WTS_lsSet, fires document 'wts:wellperf-model-changed' {keys}
//                                → {ok, bytes, keys, decimated, warnings, errors}; refused (READ_ONLY) for a future-version record
//   migrate(rec)                 → {ok, rec, notes} (v0 / missing v → v1; v > 1 → {ok:false, code:'FUTURE_VERSION'})
//   validate(rec)                → {rec (cleaned copy), warnings}
//   decimate(survey, max?)       max-dogleg rule → {rows, removed}
//   dfitTests()                  read-only list of the DFIT tests of this well: [{id, zone, survey:n, strings:n, datumTvd, datumMd}]
//   fromDfit(test | id)          DFIT test inputs → {ok, patch:{survey, strings}, scalars:{wp_midPerf?}, warnings}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var KEY = 'wts_wellperf_model', PAGE_KEY = 'wts_page_wellperf', VERSION = 1;
    var CAP_BYTES = 256 * 1024, MAX_SURVEY = 2000, MAX_ROWS = 500;
    var TABLE_KEYS = ['survey', 'strings', 'restrictions', 'geo', 'flowline', 'rating', 'beans', 'tests', 'lab', 'pump', 'cases'];
    var RESTR_KINDS = ['sssv', 'nipple', 'sleeve', 'xo', 'downholeChoke'];
    var STRING_KINDS = ['tubing', 'casing', 'liner'];

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v) {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v === 'string') {
            var s = v.trim().replace(/,/g, '');
            if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
            var x = +s; return isFinite(x) ? x : null;
        }
        return null;
    }
    function _isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _freeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) {
            Object.freeze(o);
            Object.keys(o).forEach(function (k) { _freeze(o[k]); });
        }
        return o;
    }
    function _store(o) {
        if (o && o.storage) return o.storage;
        try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
    }
    function _get(o, k) { var s = _store(o); if (!s) return null; try { return s.getItem(k); } catch (e) { return null; } }
    function _setPath(obj, path, v) {
        var ks = path.split('.'), o = obj;
        for (var i = 0; i < ks.length - 1; i++) { if (!_isObj(o[ks[i]])) o[ks[i]] = {}; o = o[ks[i]]; }
        o[ks[ks.length - 1]] = v;
    }
    function _w(code, msg) { return { code: code, msg: String(msg).slice(0, 299), sev: 'warn' }; }

    // ── the default model (Appendix B; ratings have no default — Q20) ─────────
    function _defaults() {
        return {
            v: VERSION,
            fluid: { type: 'oil', api: 35, sgg: 0.65, sggBasis: 'separator', psep_psig: 100, tsep_F: 80, gor: 500, cgr: 0, wgr: 0, wc: 0,
                     sgw: 1.07, salinity_ppm: 0, yN2: 0, yCO2: 0, yH2S: 0, pbUser: null,
                     corr: { pb: 'standing', rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson', muou: 'vasquezBeggs',
                             co: 'vasquezBeggs', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin', sigma: 'bakerSwerdloff' },
                     match: null, bc: 1.0 },
            res: { model: 'pi', pr: null, T_F: 200, pb: null, params: {}, points: [], layers: [], provenance: {} },
            well: { datum: 'RKB', datumOffset_ft: 0, survey: [], perfTopMd: null, perfBotMd: null, midPerfMd: null,
                    strings: [], path: 'tubing', restrictions: [],
                    geo: { surfT_F: 60, points: [] },
                    heat: { mode: 'linear', tht_F: null, thtMeasured: false, U_to: 2, tProd_d: 30, ke: 1.4, alpha: 0.04 } },
            surface: { choke: { present: true, bean64: 32, corr: 'gilbert', cd: 0.75 }, flowline: [], psep_psig: 100, ambient_F: 60,
                       rating: { wellhead_psi: null, tht_max_F: null }, beans: [16, 20, 24, 32, 40, 48] },
            lift: { type: 'none', gl: { packerMd: null, qinjList_Mscfd: [], sginj: 0.65, pinj_psig: null, dpValve: 100 }, esp: null },
            system: { node: 'bottom', mode: 'rate', thp_psig: null, target: { kind: 'bean', q: null }, corr: { well: null, line: 'bb' },
                      mult: { hl: 1, f: 1 }, eroC: 100, stepFt: 100, stepFtLine: 50, refine: true },
            tests: [],
            cases: []
        };
    }
    // system.mode: 'rate' = the rate for the surface boundary (through the choke and flowline to the separator when
    // surface.choke.present, else at the fixed wellhead pressure system.thp_psig); 'pressure' = pwf / THP for the rate system.target.q;
    // 'max' = the maximum rate (lowest admissible THP, no choke); 'design' = the bean (target.kind 'bean') or the THP ('thp') that
    // gives the rate target.q (a Job).
    // system.corr.well null = the default by fluid type (Hagedorn & Brown for oil, Gray for gas / condensate — D5), resolved by
    // the engines; a registry key string otherwise (D3).

    // ── scalar controls (the page contract) ───────────────────────────────────
    var SCALARS = {
        wp_ftype: { path: 'fluid.type', kind: 'str', enumv: ['oil', 'gas', 'condensate', 'water', 'gasinj', 'waterinj'] },
        wp_api: { path: 'fluid.api', kind: 'num' }, wp_sgg: { path: 'fluid.sgg', kind: 'num' },
        wp_sggBasis: { path: 'fluid.sggBasis', kind: 'str', enumv: ['total', 'separator'] },
        wp_fpsep: { path: 'fluid.psep_psig', kind: 'num' }, wp_ftsep: { path: 'fluid.tsep_F', kind: 'num' },
        wp_gor: { path: 'fluid.gor', kind: 'num' }, wp_cgr: { path: 'fluid.cgr', kind: 'num' }, wp_wgr: { path: 'fluid.wgr', kind: 'num' },
        wp_wc: { path: 'fluid.wc', kind: 'num', scale: 0.01 },            // the control is in %, the model 0..1
        wp_sgw: { path: 'fluid.sgw', kind: 'num' }, wp_sal: { path: 'fluid.salinity_ppm', kind: 'num' },
        wp_n2: { path: 'fluid.yN2', kind: 'num' }, wp_co2: { path: 'fluid.yCO2', kind: 'num' }, wp_h2s: { path: 'fluid.yH2S', kind: 'num' },
        wp_pbUser: { path: 'fluid.pbUser', kind: 'num' }, wp_bc: { path: 'fluid.bc', kind: 'num' },
        wp_corr_pb: { path: 'fluid.corr.pb', kind: 'str' }, wp_corr_rs: { path: 'fluid.corr.rs', kind: 'str' },
        wp_corr_bo: { path: 'fluid.corr.bo', kind: 'str' }, wp_corr_muod: { path: 'fluid.corr.muod', kind: 'str' },
        wp_corr_muo: { path: 'fluid.corr.muo', kind: 'str' }, wp_corr_muou: { path: 'fluid.corr.muou', kind: 'str' },
        wp_corr_co: { path: 'fluid.corr.co', kind: 'str' }, wp_corr_z: { path: 'fluid.corr.z', kind: 'str' },
        wp_corr_mug: { path: 'fluid.corr.mug', kind: 'str' }, wp_corr_sigma: { path: 'fluid.corr.sigma', kind: 'str' },
        wp_ipr: { path: 'res.model', kind: 'str' }, wp_pr: { path: 'res.pr', kind: 'num' }, wp_tres: { path: 'res.T_F', kind: 'num' },
        wp_respb: { path: 'res.pb', kind: 'num' },
        wp_datum: { path: 'well.datum', kind: 'str', enumv: ['RKB', 'GL', 'MSL'] }, wp_datumOff: { path: 'well.datumOffset_ft', kind: 'num' },
        wp_perfTop: { path: 'well.perfTopMd', kind: 'num' }, wp_perfBot: { path: 'well.perfBotMd', kind: 'num' },
        wp_midPerf: { path: 'well.midPerfMd', kind: 'num' }, wp_path: { path: 'well.path', kind: 'str', enumv: ['tubing', 'annulus'] },
        wp_surfT: { path: 'well.geo.surfT_F', kind: 'num' },
        wp_heat: { path: 'well.heat.mode', kind: 'str', enumv: ['linear', 'relax'] }, wp_tht: { path: 'well.heat.tht_F', kind: 'num' },
        wp_thtMeas: { path: 'well.heat.thtMeasured', kind: 'bool' },
        wp_Uto: { path: 'well.heat.U_to', kind: 'num' }, wp_tprod: { path: 'well.heat.tProd_d', kind: 'num' },
        wp_ke: { path: 'well.heat.ke', kind: 'num' }, wp_alpha: { path: 'well.heat.alpha', kind: 'num' },
        wp_choke: { path: 'surface.choke.present', kind: 'bool' }, wp_bean: { path: 'surface.choke.bean64', kind: 'num' },
        wp_ckcorr: { path: 'surface.choke.corr', kind: 'str' }, wp_ckcd: { path: 'surface.choke.cd', kind: 'num' },
        wp_psep: { path: 'surface.psep_psig', kind: 'num' }, wp_tamb: { path: 'surface.ambient_F', kind: 'num' },
        wp_lift: { path: 'lift.type', kind: 'str', enumv: ['none', 'gaslift', 'esp'] },
        wp_gl_packer: { path: 'lift.gl.packerMd', kind: 'num' }, wp_gl_sg: { path: 'lift.gl.sginj', kind: 'num' },
        wp_gl_pinj: { path: 'lift.gl.pinj_psig', kind: 'num' }, wp_gl_dpv: { path: 'lift.gl.dpValve', kind: 'num' },
        wp_gl_qlist: { path: 'lift.gl.qinjList_Mscfd', kind: 'list' },
        wp_thp: { path: 'system.thp_psig', kind: 'num' },
        wp_node: { path: 'system.node', kind: 'str', enumv: ['bottom', 'wellhead', 'separator'] },
        wp_mode: { path: 'system.mode', kind: 'str', enumv: ['rate', 'pressure', 'max', 'design'] },
        wp_tkind: { path: 'system.target.kind', kind: 'str', enumv: ['bean', 'thp'] }, wp_tq: { path: 'system.target.q', kind: 'num' },
        wp_corr_well: { path: 'system.corr.well', kind: 'str' }, wp_corr_line: { path: 'system.corr.line', kind: 'str' },
        wp_mult_hl: { path: 'system.mult.hl', kind: 'num' }, wp_mult_f: { path: 'system.mult.f', kind: 'num' },
        wp_eroC: { path: 'system.eroC', kind: 'num' }, wp_stepFt: { path: 'system.stepFt', kind: 'num' },
        wp_refine: { path: 'system.refine', kind: 'bool' }
    };
    var IP_PREFIX = 'wp_ip_';

    function _scalarValue(spec, raw) {
        if (raw === undefined) return undefined;
        if (spec.kind === 'bool') {
            if (typeof raw === 'boolean') return raw;
            var s = String(raw).toLowerCase();
            return s === 'true' || s === '1' || s === 'on' || s === 'yes';
        }
        if (spec.kind === 'str') {
            var t = raw == null ? '' : String(raw).trim();
            if (t === '') return undefined;
            if (spec.enumv && spec.enumv.indexOf(t) === -1) return undefined;
            return t;
        }
        if (spec.kind === 'list') {
            var a = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[;\s,]+/);
            return a.map(_num).filter(_fin);
        }
        var x = _num(raw);
        if (x === null) return null;                 // blank / not a number → null (engines report "needed", never a default)
        return spec.scale ? x * spec.scale : x;
    }
    function _applyScalars(M, f, notes) {
        Object.keys(f || {}).forEach(function (id) {
            var raw = f[id], spec = SCALARS[id];
            if (!spec && id.indexOf(IP_PREFIX) === 0 && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id.slice(IP_PREFIX.length))) {
                var x = _num(raw);
                M.res.params[id.slice(IP_PREFIX.length)] = x;
                return;
            }
            if (!spec) return;
            var v = _scalarValue(spec, raw);
            if (v === undefined) { if (raw != null && String(raw).trim() !== '' && spec.kind === 'str') notes.push('unknown value for ' + id + ' ignored'); return; }
            _setPath(M, spec.path, v);
        });
    }

    // ── table record: empty / migrate / validate / decimate ───────────────────
    function empty() {
        return { v: VERSION, survey: [], strings: [], restrictions: [], geo: { points: [] }, flowline: [],
                 rating: { wellhead_psi: null, tht_max_F: null }, beans: [16, 20, 24, 32, 40, 48], tests: [], lab: null, pump: null, cases: [] };
    }
    function migrate(rec) {
        if (!_isObj(rec)) return { ok: false, code: 'BAD_RECORD', notes: ['the stored model is not an object'] };
        var v = rec.v == null ? 0 : _num(rec.v);
        if (v === null || v < 0) return { ok: false, code: 'BAD_RECORD', notes: ['the stored model has no valid version'] };
        if (v > VERSION) return { ok: false, code: 'FUTURE_VERSION', notes: ['model version ' + v + ' was saved by a newer app; it opens read-only'] };
        var out = _clone(rec), notes = [];
        if (v === 0) notes.push('model without a version read as version 1');
        out.v = VERSION;
        return { ok: true, rec: out, notes: notes };
    }
    function _rowsNum(list, n) {
        var out = [];
        (Array.isArray(list) ? list : []).forEach(function (r) {
            if (!Array.isArray(r) || r.length < n) return;
            var row = r.slice(0, n).map(_num);
            if (row.every(_fin)) out.push(row);
        });
        return out;
    }
    function validate(rec) {
        var r = _isObj(rec) ? rec : {}, out = empty(), warnings = [];
        // survey: [[md, tvd]] or [[md, inc, azi]] (one form per record), MD strictly ascending
        var raw = Array.isArray(r.survey) ? r.survey : [];
        var three = raw.length && Array.isArray(raw[0]) && raw[0].length >= 3;
        var sv = _rowsNum(raw, three ? 3 : 2), keep = [], last = -Infinity;
        sv.forEach(function (row) {
            if (!(row[0] > last) || row[0] < 0) return;
            if (three && (row[1] < 0 || row[1] > 180 || row[2] < 0 || row[2] > 360)) return;
            if (!three && (row[1] > row[0] + 1e-6 || row[1] < -50000)) return;   // TVD cannot exceed MD
            keep.push(row); last = row[0];
        });
        if (keep.length !== raw.length) warnings.push(_w('ROWS_DROPPED', 'survey: ' + (raw.length - keep.length) + ' row(s) dropped (not numbers, MD not ascending or out of range)'));
        out.survey = keep;
        // strings (WTS_wellbore.column schema + kind / rough)
        out.strings = (Array.isArray(r.strings) ? r.strings : []).filter(_isObj).map(function (s) {
            var c = { kind: STRING_KINDS.indexOf(s.kind) !== -1 ? s.kind : 'tubing', tubKey: (typeof s.tubKey === 'string' && s.tubKey) ? s.tubKey : null,
                      id: _num(s.id), od: _num(s.od), wall: _num(s.wall), rough: _num(s.rough), topMd: _num(s.topMd), botMd: _num(s.botMd) };
            if (c.wall === null && _fin(c.id) && _fin(c.od)) c.wall = (c.od - c.id) / 2;
            return c;
        }).filter(function (c) {
            var ok = _fin(c.id) && c.id > 0 && _fin(c.od) && c.od > c.id && _fin(c.topMd) && _fin(c.botMd) && c.botMd > c.topMd;
            if (!ok) warnings.push(_w('ROWS_DROPPED', 'strings: a row without id < od and top MD < bottom MD was dropped'));
            return ok;
        }).slice(0, 10);
        out.restrictions = (Array.isArray(r.restrictions) ? r.restrictions : []).filter(_isObj).map(function (x) {
            return { kind: RESTR_KINDS.indexOf(x.kind) !== -1 ? x.kind : 'nipple', md: _num(x.md), id: _num(x.id), k: _num(x.k) };
        }).filter(function (x) { return _fin(x.md) && x.md >= 0 && _fin(x.id) && x.id > 0; }).slice(0, 20);
        var geo = _isObj(r.geo) ? r.geo : {};
        out.geo = { points: _rowsNum(geo.points, 2).filter(function (p) { return p[0] >= 0; }).sort(function (a, b) { return a[0] - b[0]; }).slice(0, 50) };
        out.flowline = (Array.isArray(r.flowline) ? r.flowline : []).filter(_isObj).map(function (s) {
            return { name: String(s.name == null ? '' : s.name).slice(0, 40), len: _num(s.len), id: _num(s.id), dz: _num(s.dz) || 0 };
        }).filter(function (s) { return _fin(s.len) && s.len > 0 && _fin(s.id) && s.id > 0; }).slice(0, 10);
        var rt = _isObj(r.rating) ? r.rating : {};
        out.rating = { wellhead_psi: _num(rt.wellhead_psi), tht_max_F: _num(rt.tht_max_F) };
        var bn = (Array.isArray(r.beans) ? r.beans : out.beans).map(_num).filter(function (b) { return _fin(b) && b >= 4 && b <= 192; });
        out.beans = bn.filter(function (b, i) { return bn.indexOf(b) === i; }).sort(function (a, b) { return a - b; }).slice(0, 20);
        out.tests = (Array.isArray(r.tests) ? r.tests : []).filter(_isObj).slice(0, 50).map(function (t, i) {
            var o = { id: (typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(t.id)) ? t.id : 'T' + (i + 1),
                      date: typeof t.date === 'string' ? t.date.slice(0, 24) : '', use: t.use !== false,
                      note: typeof t.note === 'string' ? t.note.slice(0, 200) : '' };
            ['q_o', 'q_w', 'q_g', 'thp_psig', 'tht_F', 'bean64', 'gaugeMd', 'gauge_psia', 'chp_psig', 'qinj_Mscfd'].forEach(function (k) { o[k] = _num(t[k]); });
            return o;
        });
        out.lab = _isObj(r.lab) ? _clone(r.lab) : null;
        out.pump = _isObj(r.pump) ? _clone(r.pump) : null;
        out.cases = Array.isArray(r.cases) ? _clone(r.cases).slice(0, 20) : [];
        TABLE_KEYS.forEach(function (k) { if (Array.isArray(out[k]) && out[k].length > MAX_ROWS && k !== 'survey') out[k] = out[k].slice(0, MAX_ROWS); });
        return { rec: out, warnings: warnings };
    }

    // dogleg at each interior station (rad): angle between the unit tangents of the two adjacent intervals
    function _tangents(rows) {
        var three = rows.length && rows[0].length >= 3, t = [];
        for (var i = 1; i < rows.length; i++) {
            if (three) {
                var inc = (rows[i - 1][1] + rows[i][1]) / 2 * Math.PI / 180, az = (rows[i - 1][2] + rows[i][2]) / 2 * Math.PI / 180;
                t.push([Math.sin(inc) * Math.cos(az), Math.sin(inc) * Math.sin(az), Math.cos(inc)]);
            } else {
                var dm = rows[i][0] - rows[i - 1][0], dv = rows[i][1] - rows[i - 1][1], c = dm > 0 ? Math.max(-1, Math.min(1, dv / dm)) : 1;
                t.push([Math.sqrt(Math.max(0, 1 - c * c)), 0, c]);
            }
        }
        return t;
    }
    function decimate(survey, max) {
        var rows = Array.isArray(survey) ? survey.slice() : [], cap = _fin(max) && max >= 3 ? Math.floor(max) : MAX_SURVEY;
        if (rows.length <= cap) return { rows: rows, removed: 0 };
        var t = _tangents(rows), dl = [];
        for (var i = 1; i < rows.length - 1; i++) {
            var a = t[i - 1], b = t[i], d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            dl.push({ i: i, g: Math.acos(Math.max(-1, Math.min(1, d))) });
        }
        // keep the stations with the largest dogleg (ties: the one nearer to an even spacing — lower index first, stable)
        dl.sort(function (x, y) { return y.g - x.g || x.i - y.i; });
        var keep = { 0: 1 }; keep[rows.length - 1] = 1;
        for (var k = 0; k < cap - 2 && k < dl.length; k++) keep[dl[k].i] = 1;
        var out = rows.filter(function (r, j) { return keep[j] === 1; });
        return { rows: out, removed: rows.length - out.length };
    }

    // ── read ───────────────────────────────────────────────────────────────────
    function readRaw(o) {
        var s = _get(o, KEY);
        if (s == null || s === '') return { status: 'none', rec: null, bytes: 0 };
        var p; try { p = JSON.parse(s); } catch (e) { return { status: 'bad', rec: null, bytes: s.length }; }
        var m = migrate(p);
        if (!m.ok) return { status: m.code === 'FUTURE_VERSION' ? 'future' : 'bad', rec: m.code === 'FUTURE_VERSION' ? p : null, bytes: s.length, notes: m.notes };
        return { status: 'ok', rec: m.rec, bytes: s.length, notes: m.notes };
    }
    function _pageScalars(o) {
        var s = _get(o, PAGE_KEY); if (!s) return {};
        try { var p = JSON.parse(s); return (p && _isObj(p.f)) ? p.f : {}; } catch (e) { return {}; }
    }
    function read(o) {
        o = o || {};
        var M = _defaults(), notes = [];
        var raw = readRaw(o), readOnly = raw.status === 'future';
        if (raw.notes) notes = notes.concat(raw.notes);
        if (raw.status === 'bad') notes.push('the stored well performance model could not be read; defaults are used');
        var rec = null;
        if (raw.status === 'ok') rec = validate(raw.rec).rec;
        else if (readOnly) rec = validate(raw.rec).rec;
        if (rec) {
            M.well.survey = rec.survey; M.well.strings = rec.strings; M.well.restrictions = rec.restrictions;
            M.well.geo.points = rec.geo.points; M.surface.flowline = rec.flowline;
            M.surface.rating = rec.rating; M.surface.beans = rec.beans.length ? rec.beans : M.surface.beans; M.tests = rec.tests;
            M.cases = rec.cases; if (rec.lab) M.fluid.match = { lab: rec.lab }; if (rec.pump) M.lift.esp = { pump: rec.pump };
        }
        var f = Object.assign({}, _pageScalars(o), _isObj(o.scalars) ? o.scalars : {});
        _applyScalars(M, f, notes);
        M.meta = { status: raw.status, readOnly: readOnly, notes: notes, bytes: raw.bytes };
        return _freeze(M);
    }

    // ── write ──────────────────────────────────────────────────────────────────
    function _emit(keys) {
        try {
            if (typeof document === 'undefined' || !document.dispatchEvent) return;
            var ev;
            if (typeof CustomEvent === 'function') ev = new CustomEvent('wts:wellperf-model-changed', { detail: { keys: keys } });
            else if (document.createEvent) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('wts:wellperf-model-changed', false, false, { keys: keys }); }
            if (ev) document.dispatchEvent(ev);
        } catch (e) { /* no document in the smoke stub */ }
    }
    function write(patch, o) {
        o = o || {};
        if (!_isObj(patch)) return { ok: false, code: 'BAD_PATCH', errors: ['patch must be an object'], warnings: [] };
        var raw = readRaw(o);
        if (raw.status === 'future') return { ok: false, code: 'READ_ONLY', errors: ['this model was saved by a newer app version and is read-only'], warnings: [] };
        var base = raw.status === 'ok' ? raw.rec : empty(), keys = [];
        Object.keys(patch).forEach(function (k) { if (TABLE_KEYS.indexOf(k) !== -1) { base[k] = _clone(patch[k]); keys.push(k); } });
        if (!keys.length) return { ok: false, code: 'NO_KEYS', errors: ['nothing to write (table keys: ' + TABLE_KEYS.join(', ') + ')'], warnings: [] };
        var dec = decimate(Array.isArray(base.survey) ? base.survey : [], MAX_SURVEY);
        base.survey = dec.rows;
        var v = validate(base), warnings = v.warnings.slice();
        if (dec.removed) warnings.push(_w('SURVEY_DECIMATED', 'survey reduced to ' + MAX_SURVEY + ' stations by the largest-dogleg rule (' + dec.removed + ' removed)'));
        var s = JSON.stringify(v.rec), bytes = s.length;
        if (bytes > CAP_BYTES) return { ok: false, code: 'TOO_BIG', bytes: bytes, errors: ['the model is ' + Math.round(bytes / 1024) + ' kB; the limit is 256 kB'], warnings: warnings };
        var ok = false, st = _store(o);
        try {
            if (!o.storage && typeof G.WTS_lsSet === 'function') ok = G.WTS_lsSet(KEY, s) !== false;
            else if (st) { st.setItem(KEY, s); ok = true; }   /* ls-raw: a storage passed in (tests) or no host (smoke stub) */
        } catch (e) { ok = false; }
        if (!ok) return { ok: false, code: 'STORAGE', bytes: bytes, errors: ['the model could not be saved (storage full or unavailable)'], warnings: warnings };
        _emit(keys);
        return { ok: true, bytes: bytes, keys: keys, decimated: dec.removed, warnings: warnings, errors: [] };
    }

    // ── DFIT geometry import (read-only, §2.10; owner Q17: a shared record later) ──
    function _dfitState() { var st = G.PRiSM_state; return (st && _isObj(st.dfit) && Array.isArray(st.dfit.tests)) ? st.dfit : null; }
    function dfitTests() {
        var d = _dfitState(); if (!d) return [];
        return d.tests.filter(function (t) { return _isObj(t) && typeof t.id === 'string'; }).map(function (t) {
            var I = _isObj(t.inputs) ? t.inputs : {};
            return { id: t.id, zone: typeof t.zone === 'string' ? t.zone : '', survey: Array.isArray(I.survey) ? I.survey.length : 0,
                     strings: Array.isArray(I.strings) ? I.strings.length : 0, datumTvd: _num(I.datumTvd), datumMd: _num(I.datumMd) };
        });
    }
    function fromDfit(test) {
        var t = test;
        if (typeof test === 'string') { var d = _dfitState(); t = d ? d.tests.filter(function (x) { return x && x.id === test; })[0] : null; }
        if (!_isObj(t) || !_isObj(t.inputs)) return { ok: false, code: 'NO_DFIT_TEST', errors: ['no DFIT test with well inputs was found'], warnings: [] };
        var I = t.inputs, warnings = [];
        var survey = _rowsNum(I.survey, 2);
        var strings = (Array.isArray(I.strings) ? I.strings : []).filter(_isObj).map(function (s) {
            var od = _num(s.od);
            return { kind: (_fin(od) && od > 5) ? 'casing' : 'tubing', tubKey: (typeof s.tubKey === 'string' && s.tubKey) ? s.tubKey : null,
                     id: _num(s.id), od: od, wall: _num(s.wall), rough: null, topMd: _num(s.topMd), botMd: _num(s.botMd) };
        });
        var v = validate({ survey: survey, strings: strings });
        warnings = warnings.concat(v.warnings);
        if (!v.rec.survey.length) warnings.push(_w('NO_SURVEY', 'the DFIT test has no survey; the well is treated as vertical until one is entered'));
        if (!v.rec.strings.length) warnings.push(_w('NO_STRINGS', 'the DFIT test has no strings'));
        var scalars = {}, md = _num(I.datumMd);
        if (_fin(md) && md > 0) scalars.wp_midPerf = md;
        return { ok: true, id: t.id, patch: { survey: v.rec.survey, strings: v.rec.strings }, scalars: scalars, warnings: warnings, errors: [] };
    }

    var W = G.WTS_wp_model = G.WTS_wp_model || {};
    W.VERSION = VERSION; W.KEY = KEY; W.PAGE_KEY = PAGE_KEY; W.CAP_BYTES = CAP_BYTES; W.MAX_SURVEY = MAX_SURVEY;
    W.TABLE_KEYS = TABLE_KEYS.slice(); W.SCALARS = SCALARS; W.IP_PREFIX = IP_PREFIX;
    W.DEFAULTS = _freeze(_defaults());
    W.empty = empty; W.readRaw = readRaw; W.read = read; W.write = write; W.migrate = migrate; W.validate = validate;
    W.decimate = decimate; W.dfitTests = dfitTests; W.fromDfit = fromDfit;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var W = G.WTS_wp_model, bad = [];
    function mem() { var d = {}; return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; } }; }
    try {
        var s = mem();
        var M0 = W.read({ storage: s });
        if (!Object.isFrozen(M0) || M0.fluid.type !== 'oil' || M0.meta.status !== 'none') bad.push('defaults');
        var r = W.write({ survey: [[0, 0], [5000, 5000], [9000, 8500]] }, { storage: s });
        if (!r.ok) bad.push('write ' + JSON.stringify(r));
        var M1 = W.read({ storage: s, scalars: { wp_wc: '30', wp_pr: '3000', wp_ip_J: '2' } });
        if (M1.well.survey.length !== 3 || Math.abs(M1.fluid.wc - 0.3) > 1e-12 || M1.res.pr !== 3000 || M1.res.params.J !== 2) bad.push('read');
        var big = []; for (var i = 0; i < 2500; i++) big.push([i * 4, i * 4]);
        if (W.decimate(big, 2000).rows.length !== 2000) bad.push('decimate');
        s.setItem(W.KEY, JSON.stringify({ v: 9 }));
        if (!W.read({ storage: s }).meta.readOnly || W.write({ beans: [32] }, { storage: s }).code !== 'READ_ONLY') bad.push('future');
    } catch (e) { bad.push('threw ' + e.message); }
    if (bad.length) { if (typeof console !== 'undefined') console.error('[wp-model self-test] FAILED: ' + bad.join('; ')); }
    else if (typeof console !== 'undefined') console.log('[wp-model self-test] ok');
})();
