// ════════════════════════════════════════════════════════════════════
// WTS — Layer 29b — Multi-well projects (ROADMAP §3 P3) and read-only
// snapshots (ROADMAP §3 P5a)
//
// STORAGE DESIGN
//   Every page keeps reading and writing exactly the keys it uses today —
//   those keys always belong to the ACTIVE well. The other wells are parked:
//
//     localStorage 'wts_wells'        { v:1, active:'w2', wells:[{id,name,created,modified}] }
//     localStorage 'wts_well_<id>'    one JSON blob per INACTIVE well:
//         { v:1, savedAt, keys:{ <well-scoped key>: <raw string> },
//           modules:{ wts, esdhi, esdlo, hydrate, liquidline, pipelife,
//                     clientinfo, pvt, prism_dataset, prism } }
//
//   Well-scoped keys = the project keys of 29-project-save.js (wts_ / h2oil_
//   minus preferences) that are not libraries (PRiSM curves / presets /
//   column mappings), not the multi-well store itself and not job-level
//   settings (report templates, standard conditions). That covers the
//   wts_page_<route> autosaves, the legacy wts_<key> lists, Client & Well
//   Info (h2oil_client_info), the report snapshots, the simulator page
//   inputs and the PRiSM keys (wts_prism_state, wts_prism_pvt, wts_prism,
//   wts_prism_mrate …). `modules` holds the in-memory state (WTS_state,
//   PRiSM state / well / dataset) through the project file's own module
//   readers, so a switch restores exactly what Open would.
//
//   Switch A → B: flush the page autosave and PRiSM, write A's blob
//   (quota-safe WTS_lsSet — nothing is removed if that fails), take B's
//   blob out, remove A's keys, write B's keys, reset + re-apply the modules,
//   then 'wts:project-loaded' {source:'well'} (layers re-read their caches)
//   and a re-render. The one-well case never writes anything: without
//   'wts_wells' the project is a single well named after Client & Well Info.
//
//   Project files: the `wells` module carries the list and the inactive
//   blobs; `storage` and the other modules carry the active well as before.
//   A file without `wells` (older files, single-well projects) opens as one
//   well (29-project-save.js resets the list).
//
//   Key results per well for the comparison page are pulled from WTS_state
//   (live for the active well, the parked `wts` module for the others) and
//   from a small per-well cache 'wts_mw_results' refreshed on every
//   autosave, so values survive a reload without revisiting every page.
//
// PUBLIC API
//   window.WTS_wells = {
//     list() → [{id, name, active, created, modified}]     active() → id
//     switchTo(id) · create(name?, {duplicate}) · rename(id, name) · remove(id)
//     copyPage(fromId, route?)   copy one page's inputs into the active well
//     results(id?) → {gasdeliv, oilipr, rates, flareghg, h2sroe, wellkill, fit}
//     table() → {rows:[{key,label,unit}], wells:[…], cells:[[text]]}
//     renderPage(body)  (route 'wells')   renderSwitcher(host)
//   }
//   window.WTS_snapshot = { build(kind) → {filename, html} | null,
//                           share(kind) → Promise, sanitize(html) }
//     kind: 'page' (visible page report) | 'job' (Quick Report) | 'wells'
//
// No timers, polling or function wrapping (one-shot mount only).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _warn() { if (typeof console !== 'undefined' && console.warn) try { console.warn.apply(console, arguments); } catch (e) {} }

    var REG_KEY = 'wts_wells';
    var BLOB_PREFIX = 'wts_well_';
    var RESULTS_KEY = 'wts_mw_results';
    // Job-level settings shared by every well of the project.
    var JOB_KEYS = { wts_report_templates: 1, wts_base_conditions: 1 };
    // Project-file modules that hold a well's in-memory state (registry order
    // is kept by applyPayload: inputs → dataset → analysis).
    var WELL_MODULES = ['wts', 'esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife', 'clientinfo',
                        'pvt', 'prism_dataset', 'prism'];
    // Client & Well Info fields a NEW well does not inherit.
    var CI_OWN = { well: 1, notes: 1 };
    var ID_RE = /^w[0-9]{1,6}$/;
    var NAME_MAX = 60;

    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function _own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function _num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
    function _parse(raw) { if (raw == null) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
    function _nowISO() { return new Date().toISOString(); }
    function _I() { return (G.WTS_project && G.WTS_project._internals) || null; }
    function _ls() {
        var I = _I();
        if (I) return I.ls();
        try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
    }
    function _keys(ls) {
        var I = _I();
        if (I) return I.lsKeys(ls);
        var out = [];
        try { for (var i = 0; i < ls.length; i++) out.push(ls.key(i)); } catch (e) {}
        return out;
    }
    // Quota-safe write (host __lsSet: evicts old report snapshots, warns once).
    function _set(k, v) {
        if (typeof G.WTS_lsSet === 'function') return G.WTS_lsSet(k, v) !== false;
        var ls = _ls();
        try { ls.setItem(k, v); return true; } catch (e) { return false; }
    }
    // Plain write used mid-switch (no snapshot eviction into the half-swapped store).
    function _rawSet(ls, k, v) { try { ls.setItem(k, v); return true; } catch (e) { return false; } }
    function _isWellKey(k) {
        var I = _I();
        if (!I) return false;
        return I.isProjectKey(k) && !I.isLibraryKey(k) && !I.isWellsKey(k) && !JOB_KEYS[k];
    }
    function _emit(name, detail) {
        try {
            if (_hasDoc && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        } catch (e) {}
    }
    function _cleanName(s) {
        return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().substring(0, NAME_MAX);
    }
    function _ciOf(raw) { var o = _parse(raw); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
    function _ciActive() { var ls = _ls(); return ls ? _ciOf(ls.getItem('h2oil_client_info')) : {}; }

    // ───────────────────────────────────────────────────────────────
    // Well list
    // ───────────────────────────────────────────────────────────────
    function _virtualReg() {
        var nm = _cleanName(_ciActive().well) || 'Well 1';
        return { v: 1, active: 'w1', wells: [{ id: 'w1', name: nm, created: null, modified: null }], virtual: true };
    }
    function _readReg() {
        var ls = _ls();
        var o = ls ? _parse(ls.getItem(REG_KEY)) : null;
        if (!o || typeof o !== 'object' || !Array.isArray(o.wells)) return _virtualReg();
        var seen = {}, wells = [];
        o.wells.forEach(function (w) {
            if (!w || typeof w !== 'object' || !ID_RE.test(String(w.id)) || seen[w.id]) return;
            seen[w.id] = 1;
            wells.push({ id: String(w.id), name: _cleanName(w.name) || String(w.id),
                         created: typeof w.created === 'string' ? w.created : null,
                         modified: typeof w.modified === 'string' ? w.modified : null });
        });
        if (!wells.length) return _virtualReg();
        var active = seen[o.active] ? String(o.active) : wells[0].id;
        return { v: 1, active: active, wells: wells };
    }
    function _writeReg(reg) {
        return _set(REG_KEY, JSON.stringify({ v: 1, active: reg.active, wells: reg.wells.map(function (w) {
            return { id: w.id, name: w.name, created: w.created, modified: w.modified };
        }) }));
    }
    function _find(reg, id) { for (var i = 0; i < reg.wells.length; i++) if (reg.wells[i].id === id) return reg.wells[i]; return null; }
    function _newId(reg) {
        var n = 0;
        reg.wells.forEach(function (w) { var m = /^w(\d+)$/.exec(w.id); if (m) n = Math.max(n, +m[1]); });
        return 'w' + (n + 1);
    }
    function _uniqueName(reg, name, skipId) {
        var base = _cleanName(name) || ('Well ' + (reg.wells.length + 1));
        var taken = {};
        reg.wells.forEach(function (w) { if (w.id !== skipId) taken[w.name.toLowerCase()] = 1; });
        if (!taken[base.toLowerCase()]) return base;
        for (var i = 2; i < 1000; i++) { var c = (base.substring(0, NAME_MAX - 6) + ' (' + i + ')'); if (!taken[c.toLowerCase()]) return c; }
        return base;
    }
    function _blob(id) {
        var ls = _ls();
        var b = ls ? _parse(ls.getItem(BLOB_PREFIX + id)) : null;
        if (!b || typeof b !== 'object') return null;
        if (!b.keys || typeof b.keys !== 'object') b.keys = {};
        if (!b.modules || typeof b.modules !== 'object') b.modules = {};
        return b;
    }

    // ───────────────────────────────────────────────────────────────
    // Key results (comparison page)
    // ───────────────────────────────────────────────────────────────
    function _ok(o) { return !!(o && typeof o === 'object' && o.ok !== false); }
    // One group per source page; a group that is present but failed is null
    // (so a newer failed calculation hides an older cached value).
    function _extract(st) {
        var r = {};
        if (!st || typeof st !== 'object') return r;
        if (st.gasdeliv) r.gasdeliv = _ok(st.gasdeliv) ? { aof: _num(st.gasdeliv.aofCn), aofLit: _num(st.gasdeliv.aofLit), n: _num(st.gasdeliv.n) } : null;
        if (st.oilipr) r.oilipr = _ok(st.oilipr) ? { J: _num(st.oilipr.J), qmax: _num(st.oilipr.qmax) } : null;
        if (st.oilgas) r.oilgas = _ok(st.oilgas) ? { oil: _num(st.oilgas.oil_stbd), gas: _num(st.oilgas.gas_mscfd), gor: _num(st.oilgas.gor) } : null;
        if (st.sepqc) r.sepqc = _ok(st.sepqc) ? { oil: _num(st.sepqc.qOilST), gas: _num(st.sepqc.qGasCorr), gor: _num(st.sepqc.gorSTCorr) } : null;
        if (st.aga3) r.aga3 = _ok(st.aga3) ? { gas: _num(st.aga3.gas_mscfd) } : null;
        if (st.flareghg) r.flareghg = { co2e_t: _num(st.flareghg.co2e_t), co2_t: _num(st.flareghg.co2_t), so2_t: _num(st.flareghg.so2_t) };
        if (st.h2sroe) r.h2sroe = { x100: _num(st.h2sroe.x100_ft), x500: _num(st.h2sroe.x500_ft) };
        if (st.wellkill) r.wellkill = { kwf: _num(st.wellkill.kwf) };
        return r;
    }
    function _fitOf(fit) {
        if (!fit || typeof fit !== 'object' || !fit.phys || typeof fit.phys !== 'object') return null;
        var k = _num(fit.phys.k), S = _num(fit.phys.S);
        if (k == null && S == null) return null;
        return { k: k, S: S, model: fit.modelKey || fit.model || null, r2: _num(fit.r2 != null ? fit.r2 : fit.R2) };
    }
    function _merge(cached, live) {
        var out = {}, k;
        if (cached && typeof cached === 'object') for (k in cached) if (_own(cached, k)) out[k] = cached[k];
        for (k in live) if (_own(live, k)) out[k] = live[k];
        return out;
    }
    function _cacheOf(raw) { var c = _parse(raw); return (c && c.r && typeof c.r === 'object') ? c.r : {}; }
    var _lastCache = null;
    function _writeResultsCache() {
        var ls = _ls();
        if (!ls || !G.WTS_state) return;
        var merged = _merge(_cacheOf(ls.getItem(RESULTS_KEY)), _extract(G.WTS_state));
        var txt = JSON.stringify({ v: 1, r: merged });
        if (txt === _lastCache && ls.getItem(RESULTS_KEY) === txt) return;
        if (_set(RESULTS_KEY, txt)) _lastCache = txt;
    }
    function _pickRates(r) {
        var src = (r.oilgas && (r.oilgas.oil != null || r.oilgas.gas != null)) ? ['oilgas', 'Oil & Gas Rate'] :
                  (r.sepqc && (r.sepqc.oil != null || r.sepqc.gas != null)) ? ['sepqc', 'Separator QC'] :
                  (r.aga3 && r.aga3.gas != null) ? ['aga3', 'AGA-3'] : null;
        if (!src) return null;
        var g = r[src[0]];
        return { oil: _num(g.oil), gas: _num(g.gas), gor: _num(g.gor), source: src[1] };
    }
    function results(id) {
        var reg = _readReg();
        id = id || reg.active;
        if (!_find(reg, id)) return null;
        var ls = _ls(), r, fit = null;
        if (id === reg.active) {
            r = _merge(_cacheOf(ls && ls.getItem(RESULTS_KEY)), _extract(G.WTS_state));
            var st = G.PRiSM_state;
            fit = _fitOf(st && st.lastFit) || _fitOf((_parse(ls && ls.getItem('wts_prism_state')) || {}).lastFit);
        } else {
            var b = _blob(id) || { keys: {}, modules: {} }, m = b.modules;
            r = _merge(_cacheOf(b.keys[RESULTS_KEY]), _extract(m.wts || {}));
            fit = _fitOf(m.prism && m.prism.lastFit) || _fitOf((_parse(b.keys.wts_prism_state) || {}).lastFit);
        }
        return { gasdeliv: r.gasdeliv || null, oilipr: r.oilipr || null, rates: _pickRates(r),
                 flareghg: r.flareghg || null, h2sroe: r.h2sroe || null, wellkill: r.wellkill || null, fit: fit };
    }

    // Display: canonical field units → active unit system (22-units.js).
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
    }
    function _uv(v, cat, dp, impLabel) {
        if (v == null || !isFinite(v)) return '—';
        var U = G.WTS_units;
        if (cat && U && typeof U.getSystem === 'function' && U.getSystem() === 'metric' && typeof U.format === 'function') {
            var f = U.format(v, cat);
            return _fmt(f.value, dp) + (f.label ? ' ' + f.label : '');
        }
        return _fmt(v, dp) + (impLabel ? ' ' + impLabel : '');
    }
    var ROWS = [
        { key: 'aof',  label: 'Gas AOF (C & n)',         src: 'Gas Deliverability', get: function (r) { return r.gasdeliv && r.gasdeliv.aof; }, cat: 'gasRateSmall', dp: 0, imp: 'MSCFD' },
        { key: 'J',    label: 'Oil productivity index J', src: 'Oil IPR',          get: function (r) { return r.oilipr && r.oilipr.J; }, cat: 'productivityIndex', dp: 3, imp: 'STB/d/psi' },
        { key: 'qmax', label: 'Oil qmax (AOF)',          src: 'Oil IPR',            get: function (r) { return r.oilipr && r.oilipr.qmax; }, cat: 'liquidRate', dp: 0, imp: 'STB/d' },
        { key: 'k',    label: 'Permeability k (PRiSM fit)', src: 'PRiSM',           get: function (r) { return r.fit && r.fit.k; }, cat: 'permeability', dp: 2, imp: 'md' },
        { key: 'S',    label: 'Skin S (PRiSM fit)',      src: 'PRiSM',              get: function (r) { return r.fit && r.fit.S; }, cat: null, dp: 2, imp: '' },
        { key: 'oil',  label: 'Oil rate',                src: 'rates',              get: function (r) { return r.rates && r.rates.oil; }, cat: 'liquidRate', dp: 0, imp: 'STB/d' },
        { key: 'gas',  label: 'Gas rate',                src: 'rates',              get: function (r) { return r.rates && r.rates.gas; }, cat: 'gasRateSmall', dp: 0, imp: 'MSCFD' },
        { key: 'gor',  label: 'GOR',                     src: 'rates',              get: function (r) { return r.rates && r.rates.gor; }, cat: 'gor', dp: 0, imp: 'SCF/STB' },
        { key: 'co2e', label: 'Flare emissions CO₂e',    src: 'Flare Emissions',    get: function (r) { return r.flareghg && r.flareghg.co2e_t; }, cat: null, dp: 2, imp: 't' },
        { key: 'roe100', label: 'H₂S ROE 100 ppm',        src: 'H₂S ROE',           get: function (r) { return r.h2sroe && r.h2sroe.x100; }, cat: 'length', dp: 0, imp: 'ft' },
        { key: 'roe500', label: 'H₂S ROE 500 ppm',        src: 'H₂S ROE',           get: function (r) { return r.h2sroe && r.h2sroe.x500; }, cat: 'length', dp: 0, imp: 'ft' },
        { key: 'kwf',  label: 'Kill fluid weight',       src: 'Well Kill',          get: function (r) { return r.wellkill && r.wellkill.kwf; }, cat: 'densityLiquid', dp: 2, imp: 'ppg' }
    ];
    // Comparison table: one row per result, one column per well.
    function table() {
        var reg = _readReg();
        var wells = reg.wells.map(function (w) { return { id: w.id, name: w.name, active: w.id === reg.active, r: results(w.id) || {} }; });
        var cells = ROWS.map(function (row) {
            return wells.map(function (w) { var v = row.get(w.r); return _uv(v == null ? null : v, row.cat, row.dp, row.imp); });
        });
        var srcRow = wells.map(function (w) { return (w.r.rates && w.r.rates.source) || '—'; });
        return { rows: ROWS.map(function (r) { return { key: r.key, label: r.label, src: r.src }; }), wells: wells, cells: cells, rateSource: srcRow };
    }

    // ───────────────────────────────────────────────────────────────
    // Capture / restore the active well
    // ───────────────────────────────────────────────────────────────
    function _persistPrism() {
        try { if (typeof G.PRiSM_saveState === 'function' && G.PRiSM_state) G.PRiSM_saveState(); } catch (e) {}
        var pvt = G.PRiSM_pvt, ls = _ls();
        if (ls && pvt && typeof pvt === 'object') {
            var copy = {};
            for (var k in pvt) if (_own(pvt, k) && k !== '_computed') copy[k] = pvt[k];
            try { ls.setItem('wts_prism_pvt', JSON.stringify(copy)); } catch (e) {}
        }
    }
    function _capture() {
        var I = _I(), ls = _ls();
        I.flushAutosave();
        _persistPrism();
        _writeResultsCache();
        var keys = {}, all = _keys(ls);
        for (var i = 0; i < all.length; i++) {
            if (!_isWellKey(all[i])) continue;
            var v = null;
            try { v = ls.getItem(all[i]); } catch (e) {}
            if (v != null) keys[all[i]] = String(v);
        }
        var M = I.modules(), mods = {};
        WELL_MODULES.forEach(function (name) {
            if (!M[name]) return;
            try { var st = M[name].read(); if (st != null) mods[name] = st; }
            catch (e) { _warn('[WTS_wells] could not read ' + name, e); }
        });
        return { v: 1, savedAt: _nowISO(), keys: keys, modules: mods };
    }
    function _clearActive(ls) {
        _keys(ls).filter(_isWellKey).forEach(function (k) { try { ls.removeItem(k); } catch (e) {} });
    }
    // In-memory state back to "no well loaded" (keeps the unit system).
    function _resetMemory() {
        var M = _I().modules();
        var s = G.WTS_state;
        if (s && typeof s === 'object') { for (var k in s) if (_own(s, k) && k !== 'units') delete s[k]; }
        else G.WTS_state = {};
        try { if (Array.isArray(G._genMotors)) G._genMotors = []; } catch (e) {}
        ['pvt', 'prism_dataset', 'prism'].forEach(function (name) {
            if (M[name]) try { M[name].write(null); } catch (e) { _warn('[WTS_wells] reset ' + name, e); }
        });
    }
    function _writeKeys(ls, keys) {
        var failed = [];
        for (var k in keys) {
            if (!_own(keys, k) || typeof keys[k] !== 'string' || !_isWellKey(k)) continue;
            if (!_rawSet(ls, k, keys[k])) failed.push(k);
        }
        return failed;
    }
    function _applyModules(mods) {
        var I = _I();
        I.applyPayload({ format: 'h2oilproj', modules: mods || {} });
    }
    function _after(source, id) {
        var I = _I();
        _lastCache = null;
        try { I.prismSync(source); } catch (e) {}
        I.emit('wts:project-loaded', { loaded: WELL_MODULES.slice(), skipped: [], source: 'well', well: id });
        _emit('wts:well-changed', { id: id, list: list() });
        I.rerender();
    }
    function _cancelAutosave() {
        try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.cancel) G.WTS_pageAutosave.cancel(); } catch (e) {}
    }
    function _quotaMsg() {
        return 'Device storage is full, so the current well could not be parked. Nothing was changed. ' +
               'Use File → Save to keep a copy, then delete a well or unused data.';
    }
    // Park the active well in its blob (quota-safe). Returns the capture or null.
    function _park(reg) {
        var cur = _capture();
        var w = _find(reg, reg.active);
        if (w) w.modified = cur.savedAt;
        if (!_set(BLOB_PREFIX + reg.active, JSON.stringify(cur))) return null;
        return cur;
    }

    function list() {
        var reg = _readReg();
        return reg.wells.map(function (w) {
            return { id: w.id, name: w.name, active: w.id === reg.active, created: w.created, modified: w.modified };
        });
    }
    function active() { return _readReg().active; }

    function switchTo(id) {
        if (!_I()) return { ok: false, error: 'unavailable' };
        var reg = _readReg(), ls = _ls();
        id = String(id);
        if (!_find(reg, id)) return { ok: false, error: 'no such well' };
        if (id === reg.active) return { ok: true, unchanged: true };
        var targetRaw = ls.getItem(BLOB_PREFIX + id);
        var target = _parse(targetRaw) || {};
        if (!target.keys || typeof target.keys !== 'object') target.keys = {};
        if (!target.modules || typeof target.modules !== 'object') target.modules = {};
        var from = reg.active;
        var cur = _park(reg);
        if (!cur) return { ok: false, error: 'quota', message: _quotaMsg() };
        _cancelAutosave();
        try { ls.removeItem(BLOB_PREFIX + id); } catch (e) {}
        _clearActive(ls);
        _resetMemory();
        var failed = _writeKeys(ls, target.keys);
        if (failed.length) {
            // Roll back: the target stays parked, the previous well comes back.
            _clearActive(ls);
            if (targetRaw != null) _rawSet(ls, BLOB_PREFIX + id, targetRaw);
            _writeKeys(ls, cur.keys);
            try { ls.removeItem(BLOB_PREFIX + from); } catch (e) {}
            _resetMemory();
            _applyModules(cur.modules);
            _after('well-switch', from);
            return { ok: false, error: 'quota', message: 'Device storage is full — could not open that well. Nothing was lost.' };
        }
        reg.active = id;
        delete reg.virtual;
        _writeReg(reg);
        _applyModules(target.modules);
        _after('well-switch', id);
        return { ok: true, id: id };
    }

    function create(name, opts) {
        if (!_I()) return { ok: false, error: 'unavailable' };
        opts = opts || {};
        var reg = _readReg(), ls = _ls();
        var nm = _uniqueName(reg, name || ((opts.duplicate ? _find(reg, reg.active).name + ' copy' : 'Well ' + (reg.wells.length + 1))));
        var cur = _park(reg);
        if (!cur) return { ok: false, error: 'quota', message: _quotaMsg() };
        var id = _newId(reg), now = _nowISO();
        reg.wells.forEach(function (w) { if (!w.created) w.created = now; });
        _cancelAutosave();
        if (opts.duplicate) {
            var ci = _ciActive();
            ci.well = nm;
            _rawSet(ls, 'h2oil_client_info', JSON.stringify(ci));
            if (G.WTS_state && G.WTS_state.clientInfo && typeof G.WTS_state.clientInfo === 'object') G.WTS_state.clientInfo.wellName = nm;
        } else {
            _clearActive(ls);
            _resetMemory();
            var ciPrev = _ciOf(cur.keys.h2oil_client_info), keep = {};
            for (var k in ciPrev) if (_own(ciPrev, k) && !CI_OWN[k]) keep[k] = ciPrev[k];
            keep.well = nm;
            _rawSet(ls, 'h2oil_client_info', JSON.stringify(keep));
        }
        reg.wells.push({ id: id, name: nm, created: now, modified: now });
        reg.active = id;
        delete reg.virtual;
        if (!_writeReg(reg)) _warn('[WTS_wells] could not write the well list');
        _after(opts.duplicate ? 'well-duplicate' : 'well-new', id);
        return { ok: true, id: id, name: nm };
    }

    function rename(id, name) {
        var reg = _readReg();
        id = String(id || reg.active);
        var w = _find(reg, id);
        if (!w) return { ok: false, error: 'no such well' };
        var nm = _uniqueName(reg, name, id);
        if (!_cleanName(name)) return { ok: false, error: 'empty name' };
        var old = w.name, ls = _ls();
        w.name = nm;
        w.modified = _nowISO();
        delete reg.virtual;
        // Client & Well Info follows when it still shows the old name.
        if (id === reg.active) {
            try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.flush) G.WTS_pageAutosave.flush(); } catch (e) {}
            var ci = _ciActive();
            if (!ci.well || ci.well === old) {
                ci.well = nm;
                _set('h2oil_client_info', JSON.stringify(ci));
                var pg = G.WTS_pageAutosave && G.WTS_pageAutosave.page ? G.WTS_pageAutosave.page() : null;
                if (pg === 'clientinfo' || pg === 'wells') _I() && _I().rerender();
            }
        } else {
            var b = _blob(id);
            if (b) {
                var bci = _ciOf(b.keys.h2oil_client_info);
                if (!bci.well || bci.well === old) { bci.well = nm; b.keys.h2oil_client_info = JSON.stringify(bci); _set(BLOB_PREFIX + id, JSON.stringify(b)); }
            }
        }
        _writeReg(reg);
        _emit('wts:well-changed', { id: reg.active, list: list() });
        return { ok: true, id: id, name: nm };
    }

    function remove(id) {
        if (!_I()) return { ok: false, error: 'unavailable' };
        var reg = _readReg();
        id = String(id || reg.active);
        if (!_find(reg, id)) return { ok: false, error: 'no such well' };
        if (reg.wells.length < 2) return { ok: false, error: 'last well', message: 'A project always has at least one well. Use File → New to clear it.' };
        if (id === reg.active) {
            var idx = 0;
            for (var i = 0; i < reg.wells.length; i++) if (reg.wells[i].id === id) idx = i;
            var next = reg.wells[idx === 0 ? 1 : idx - 1].id;
            var sw = switchTo(next);
            if (!sw.ok) return sw;
            reg = _readReg();
        }
        try { _ls().removeItem(BLOB_PREFIX + id); } catch (e) {}
        reg.wells = reg.wells.filter(function (w) { return w.id !== id; });
        _writeReg(reg);
        _emit('wts:well-changed', { id: reg.active, list: list() });
        if (G.WTS_pageAutosave && G.WTS_pageAutosave.page && G.WTS_pageAutosave.page() === 'wells') _I().rerender();
        return { ok: true, id: id, active: reg.active };
    }

    // Keys holding one page's inputs: the universal autosave record plus the
    // legacy per-calculator lists of that page.
    var LEGACY_PREFIX = { fluid: ['wts_fluid_'], prv: ['wts_prv_'], liquidline: ['wts_ll_'], pipelife: ['wts_pl_', 'wts_pipelife'] };
    var NO_COPY = { home: 1, wells: 1, releasenotes: 1, gaevents: 1, privacy: 1 };
    function _isPrismRoute(r) { return r === 'prism' || r === 'dca' || r === 'pta'; }
    function _pageKeyMatch(route, k) {
        if (k === 'wts_page_' + route || k === 'wts_' + route || k.indexOf('wts_' + route + '_') === 0) return true;
        var extra = LEGACY_PREFIX[route] || [];
        for (var i = 0; i < extra.length; i++) if (k === extra[i] || k.indexOf(extra[i]) === 0) return true;
        return false;
    }
    function copyPage(fromId, route) {
        if (!_I()) return { ok: false, error: 'unavailable' };
        var reg = _readReg(), ls = _ls();
        route = String(route || (G.WTS_pageAutosave && G.WTS_pageAutosave.page ? G.WTS_pageAutosave.page() : '') || '');
        if (!route || NO_COPY[route]) return { ok: false, error: 'no inputs on this page' };
        if (!_find(reg, fromId) || fromId === reg.active) return { ok: false, error: 'choose another well' };
        var b = _blob(fromId);
        if (!b) return { ok: false, error: 'that well has no saved inputs' };
        _cancelAutosave();
        var copied = [];
        if (route === 'clientinfo') {
            var src = _ciOf(b.keys.h2oil_client_info), dst = _ciActive();
            for (var k in src) if (_own(src, k) && k !== 'well') dst[k] = src[k];
            if (_set('h2oil_client_info', JSON.stringify(dst))) copied.push('h2oil_client_info');
        } else if (_isPrismRoute(route)) {
            var pv = _parse(b.keys.wts_prism_pvt) || b.modules.pvt;
            var M = _I().modules();
            if (pv && typeof pv === 'object' && M.pvt) {
                M.pvt.write(pv);
                _persistPrism();
                copied.push('wts_prism_pvt');
                try { _I().prismSync('well-copy'); } catch (e) {}
            }
        } else {
            for (var key in b.keys) {
                if (!_own(b.keys, key) || !_pageKeyMatch(route, key) || !_isWellKey(key)) continue;
                if (_set(key, b.keys[key])) copied.push(key);
            }
        }
        if (copied.length) _I().rerender();
        return { ok: copied.length > 0, copied: copied, error: copied.length ? null : 'that well has no inputs for this page' };
    }

    // ───────────────────────────────────────────────────────────────
    // Project-file module `wells`
    // ───────────────────────────────────────────────────────────────
    var _loadWarnings = [];
    function _removeWellsKeys(ls) {
        _keys(ls).forEach(function (k) { if (k === REG_KEY || k.indexOf(BLOB_PREFIX) === 0) try { ls.removeItem(k); } catch (e) {} });
    }
    function _registerModule() {
        if (!G.WTS_project || typeof G.WTS_project.registerModule !== 'function') return;
        G.WTS_project.registerModule('wells', {
            read: function () {
                var ls = _ls();
                if (!ls || ls.getItem(REG_KEY) == null) return null;       // single well: nothing extra
                var reg = _readReg();
                if (reg.virtual) return null;
                return { v: 1, active: reg.active, wells: reg.wells.map(function (w) {
                    return { id: w.id, name: w.name, created: w.created, modified: w.modified,
                             data: w.id === reg.active ? null : _blob(w.id) };
                }) };
            },
            write: function (state) {
                var ls = _ls();
                if (!ls) return;
                _removeWellsKeys(ls);
                _lastCache = null;
                _loadWarnings = [];
                if (state === null || !state || typeof state !== 'object' || !Array.isArray(state.wells)) return;
                var wells = [], seen = {};
                state.wells.forEach(function (w) {
                    if (!w || !ID_RE.test(String(w.id)) || seen[w.id]) return;
                    seen[w.id] = 1;
                    wells.push({ id: String(w.id), name: _cleanName(w.name) || String(w.id),
                                 created: typeof w.created === 'string' ? w.created : null,
                                 modified: typeof w.modified === 'string' ? w.modified : null, data: w.data });
                });
                if (!wells.length) return;
                var act = seen[state.active] ? String(state.active) : wells[0].id;
                var keepWells = [];
                wells.forEach(function (w) {
                    if (w.id !== act) {
                        var d = (w.data && typeof w.data === 'object') ? w.data : { v: 1, keys: {}, modules: {} };
                        // Plain write: a quota eviction here would mix report snapshots of two sessions.
                        if (!_rawSet(ls, BLOB_PREFIX + w.id, JSON.stringify(d))) { _loadWarnings.push(w.name); return; }
                    }
                    keepWells.push({ id: w.id, name: w.name, created: w.created, modified: w.modified });
                });
                if (_loadWarnings.length) _warn('[WTS_wells] storage full — not loaded: ' + _loadWarnings.join(', '));
                _writeReg({ active: act, wells: keepWells });
            }
        });
    }
    _registerModule();

    // ───────────────────────────────────────────────────────────────
    // Read-only snapshot (P5a)
    // ───────────────────────────────────────────────────────────────
    var CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
    // Static HTML only: no scripts, event handlers, forms, frames or
    // script URLs; a Content-Security-Policy that forbids scripts anyway.
    function sanitize(html) {
        var s = String(html == null ? '' : html);
        s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<\/?script\b[^>]*>/gi, '');
        s = s.replace(/<(iframe|object|embed|form|textarea|select|button|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
        s = s.replace(/<\/?(iframe|object|embed|form|input|button|textarea|select|option|base|link|meta|noscript|template|frame|frameset|applet)\b[^>]*>/gi, '');
        s = s.replace(/<[a-zA-Z][^>]*>/g, function (tag) {
            return tag
                .replace(/\s(on[a-z]+|srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
                .replace(/\s(href|src|xlink:href|action|background|poster)\s*=\s*("|')\s*(?:javascript|vbscript|data:(?!image\/(?:png|jpe?g|gif|webp)))[^"']*\2/gi, '')
                .replace(/\s(href|src|xlink:href)\s*=\s*(?:javascript|vbscript):[^\s>]*/gi, '');
        });
        return s;
    }
    function _stamp() {
        var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    }
    function _wrapDoc(title, bodyHtml, sub) {
        if (typeof G.buildReportHTML === 'function') {
            try { return G.buildReportHTML(title, bodyHtml, sub); } catch (e) { _warn('[WTS_snapshot] report builder failed', e); }
        }
        return '<!DOCTYPE html><html><head><title>' + _esc(title) + '</title><style>body{font-family:Arial,sans-serif;color:#1f2328;max-width:860px;margin:0 auto;padding:24px}' +
               'table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:5px 8px;text-align:left}</style></head><body><h1>' +
               _esc(title) + '</h1><p>' + _esc(sub || '') + '</p>' + bodyHtml + '</body></html>';
    }
    function _wellsBody() {
        var t = table();
        var h = '<section class="rp-sec rp-out"><h2>Key results per well</h2><div class="rp-tblwrap"><table class="rp-tbl"><thead><tr><th>Result</th>' +
            t.wells.map(function (w) { return '<th>' + _esc(w.name) + (w.active ? ' (active)' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
        t.rows.forEach(function (r, i) {
            h += '<tr><td class="b">' + _esc(r.label) + '</td>' + t.cells[i].map(function (c) { return '<td>' + _esc(c) + '</td>'; }).join('') + '</tr>';
        });
        h += '<tr><td class="b">Rate source</td>' + t.rateSource.map(function (c) { return '<td>' + _esc(c) + '</td>'; }).join('') + '</tr>';
        h += '</tbody></table></div></section>';
        h += '<div class="rp-note n-blue"><b>Notes</b>Each value is the last calculation saved for that well (Gas Deliverability, Oil IPR, PRiSM last fit, ' +
             'Oil &amp; Gas Rate / Separator QC / AGA-3, Flare Emissions, H₂S ROE, Well Kill). “—” = not calculated for that well.</div>';
        return { html: h, n: t.wells.length };
    }
    function build(kind) {
        kind = kind || 'job';
        var parts = null, name;
        var ci = _ciActive();
        var R = G.WTS_reportParts || {};
        if (kind === 'wells') {
            var wb = _wellsBody();
            var who = [ci.client, ci.field].filter(Boolean).join(' · ');
            parts = { title: 'Well Comparison', html: wb.html, subtitle: (who ? who + ' · ' : '') + wb.n + ' well' + (wb.n === 1 ? '' : 's') };
            name = (ci.field || ci.client || 'project') + '-wells';
        } else if (kind === 'page') {
            parts = (typeof R.page === 'function') ? R.page() : null;
            name = (ci.well || 'well') + '-' + (parts ? parts.title : 'page');
        } else {
            parts = (typeof R.job === 'function') ? R.job() : null;
            name = (ci.well || 'well') + '-report';
        }
        if (!parts || !parts.html) return null;
        var doc = sanitize(_wrapDoc(parts.title, parts.html, parts.subtitle));
        var head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
                   '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">' +
                   '<meta name="generator" content="H2Oil Well Testing Suite — read-only snapshot">';
        doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, function (m) { return m + head; }) : '<head>' + head + '</head>' + doc;
        var banner = '<div style="margin:0 0 14px;padding:8px 12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;color:#57606a;font-size:12px">' +
                     'Read-only snapshot · ' + _esc(new Date().toLocaleString()) + ' · values are fixed and cannot be edited.</div>';
        doc = /<body[^>]*>/i.test(doc) ? doc.replace(/<body[^>]*>/i, function (m) { return m + banner; }) : doc + banner;
        var fname = String(name).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().substring(0, 80) || 'snapshot';
        return { filename: fname + '-snapshot-' + _stamp() + '.html', html: doc, kind: kind, title: parts.title };
    }
    function _download(filename, text) {
        if (!_hasDoc) return false;
        try {
            var blob = (typeof G.Blob === 'function') ? new G.Blob([text], { type: 'text/html' }) : null;
            var url = (blob && G.URL && typeof G.URL.createObjectURL === 'function') ? G.URL.createObjectURL(blob) : null;
            var a = document.createElement('a');
            a.href = url || ('data:text/html;charset=utf-8,' + encodeURIComponent(text));
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            try { document.body.removeChild(a); } catch (e) {}
            return true;
        } catch (e) { _warn('[WTS_snapshot] download failed', e); return false; }
    }
    // Delivery: iOS share sheet (ios-bridge.js window.iosSaveFile) or a download.
    function share(kind) {
        var P = G.Promise;
        var snap = build(kind);
        if (!snap) return P.resolve({ ok: false, error: 'nothing to export' });
        if (typeof G.iosSaveFile === 'function') {
            return P.resolve().then(function () { return G.iosSaveFile(snap.filename, snap.html, false); })
                .then(function (ok) {
                    if (ok === false) return { ok: _download(snap.filename, snap.html), method: 'download', filename: snap.filename };
                    return { ok: true, method: 'share', filename: snap.filename };
                }, function () { return { ok: _download(snap.filename, snap.html), method: 'download', filename: snap.filename }; });
        }
        return P.resolve({ ok: _download(snap.filename, snap.html), method: 'download', filename: snap.filename });
    }

    // ───────────────────────────────────────────────────────────────
    // Comparison page (route 'wells')
    // ───────────────────────────────────────────────────────────────
    function renderPage(body) {
        if (!body) return;
        var byId = function (id) { return _hasDoc ? document.getElementById(id) : null; };
        if (byId('pgTitle')) byId('pgTitle').textContent = 'Well Comparison';
        if (byId('pgSub')) byId('pgSub').textContent = 'Key results of every well in this project';
        var t = table();
        var h = '<div id="mw_root" data-no-persist="1">';
        h += '<div class="card"><div class="card-title">Key results per well</div>' +
             '<div style="overflow-x:auto"><table class="dtable" id="mw_table"><thead><tr><th>Result</th>' +
             t.wells.map(function (w) { return '<th>' + _esc(w.name) + (w.active ? ' ✓' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
        t.rows.forEach(function (r, i) {
            h += '<tr data-row="' + r.key + '"><td>' + _esc(r.label) + '</td>' + t.cells[i].map(function (c) { return '<td>' + _esc(c) + '</td>'; }).join('') + '</tr>';
        });
        h += '<tr data-row="src"><td>Rate source</td>' + t.rateSource.map(function (c) { return '<td>' + _esc(c) + '</td>'; }).join('') + '</tr>';
        h += '</tbody></table></div>';
        h += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">' +
             t.wells.filter(function (w) { return !w.active; }).map(function (w) {
                 return '<button type="button" class="btn btn-secondary" data-mw-open="' + _esc(w.id) + '">Open ' + _esc(w.name) + '</button>';
             }).join('') +
             '<button type="button" class="btn btn-secondary" data-mw-act="new">New well</button>' +
             '<button type="button" class="btn btn-primary" data-mw-act="snap">Share snapshot</button></div>' +
             '<div id="mw_msg" role="status" style="min-height:16px;margin-top:6px;font-size:12px;color:var(--text2)"></div></div>';
        h += '<div class="card"><div><b>Notes</b> ✓ marks the active well. Values are each well\'s last saved calculation — ' +
             'open a well and its calculator page to refresh them. The active well\'s values update as you calculate. ' +
             'k and skin come from the PRiSM last fit; rates from Oil &amp; Gas Rate, else Separator QC, else AGA-3. ' +
             '“Share snapshot” saves this table as a read-only HTML file (no scripts).</div></div>';
        h += '</div>';
        body.innerHTML = h;
        var root = byId('mw_root');
        if (!root || !root.addEventListener) return;
        root.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!b) return;
            var msg = byId('mw_msg');
            var open = b.getAttribute('data-mw-open'), act = b.getAttribute('data-mw-act');
            if (open) { var r = switchTo(open); if (!r.ok && msg) msg.textContent = r.message || r.error; }
            else if (act === 'new') _uiNew();
            else if (act === 'snap') share('wells').then(function (r) { var m = byId('mw_msg'); if (m) m.textContent = r.ok ? 'Snapshot saved: ' + r.filename : 'Snapshot failed.'; });
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Header well switcher
    // ───────────────────────────────────────────────────────────────
    var CSS = '.wts-mw{display:inline-flex;align-items:center;gap:4px;position:relative;padding:4px 6px;background:var(--bg2,#161b22);' +
        'border:1px solid var(--border,#30363d);border-radius:6px;font-size:12px;color:var(--text2,#8b949e);max-width:100%}' +
        '.wts-mw>label{font-weight:600}' +
        '.wts-mw select,.wts-mw-menu select{max-width:min(160px,40vw);min-width:0;padding:3px 4px;background:var(--bg4,#21262d);color:var(--text,#e6edf3);' +
        'border:1px solid var(--border,#30363d);border-radius:4px;font-size:12px;font-family:inherit}' +
        '.wts-mw button{padding:3px 8px;background:var(--bg4,#21262d);border:1px solid var(--border,#30363d);border-radius:4px;' +
        'color:var(--text,#e6edf3);font-size:12px;cursor:pointer;font-family:inherit;line-height:1.4}' +
        '.wts-mw-menu{position:fixed;left:8px;top:8px;z-index:10040;width:min(280px,calc(100vw - 32px));max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;' +
        'background:var(--bg2,#161b22);border:1px solid var(--border,#30363d);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px;' +
        'box-shadow:0 8px 24px rgba(1,4,9,.5)}' +
        '.wts-mw-menu[hidden]{display:none}.wts-mw-menu button{text-align:left;width:100%}' +
        '.wts-mw-menu .wts-mw-sep{height:1px;background:var(--border,#30363d);margin:2px 0}' +
        '.wts-mw-menu .wts-mw-row{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.wts-mw-menu .wts-mw-row button{width:auto}' +
        '.wts-mw-menu .wts-mw-h{font-size:11px;color:var(--text3,#6e7681);padding:2px 2px 0}' +
        '.wts-mw-msg{font-size:11px;color:var(--text2,#8b949e);min-height:0}' +
        '@media (max-width:600px){.wts-mw-menu{width:auto}}';
    function _ensureCss() {
        if (!_hasDoc || document.getElementById('wts-mw-css')) return;
        try {
            var st = document.createElement('style');
            st.id = 'wts-mw-css';
            st.textContent = CSS;
            (document.head || document.body).appendChild(st);
        } catch (e) {}
    }
    var _host = null;
    function _optHtml(wells, sel) {
        return wells.map(function (w) {
            return '<option value="' + _esc(w.id) + '"' + (w.id === sel ? ' selected' : '') + '>' + _esc(w.name) + '</option>';
        }).join('');
    }
    function _paintSwitcher() {
        if (!_host || !_hasDoc) return;
        var reg = _readReg(), sel = _host.querySelector('#wts_well_select'), cp = _host.querySelector('#wts_well_copy_from');
        if (sel) { sel.innerHTML = _optHtml(reg.wells, reg.active); sel.value = reg.active; }
        if (cp) {
            var others = reg.wells.filter(function (w) { return w.id !== reg.active; });
            cp.innerHTML = others.length ? _optHtml(others, null) : '<option value="">(no other well)</option>';
            cp.disabled = !others.length;
        }
        var del = _host.querySelector('[data-mw="delete"]');
        if (del) del.disabled = reg.wells.length < 2;
    }
    function _say(t) { var m = _host && _host.querySelector('[data-role="mw-msg"]'); if (m) m.textContent = String(t || ''); }
    // Place the open menu in viewport coordinates under the switcher, clamped so it never runs
    // off screen or under the sidebar (it used to be right-aligned to the ⋯ button, so from a
    // header at the left edge it extended leftwards and was clipped by the page area).
    function _placeMenu() {
        var m = _host && _host.querySelector('#wts_well_menu');
        if (!m || m.hasAttribute('hidden') || typeof m.getBoundingClientRect !== 'function') return;
        var anchor = _host.querySelector('.wts-mw') || _host, r = anchor.getBoundingClientRect();
        var vw = G.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
        var vh = G.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
        if (!(vw > 0) || !(vh > 0)) return;
        var pad = vw <= 600 ? 16 : 8;
        var w = vw <= 600 ? vw - 2 * pad : Math.min(280, vw - 32);
        var left = Math.max(pad, Math.min(r.left, vw - w - pad));
        var top = r.bottom + 4, room = vh - top - 8;
        var mh = m.scrollHeight || 0;
        if (mh && room < Math.min(mh, 240) && r.top - 12 > room) {   // not enough room below → open above
            room = r.top - 12;
            top = Math.max(8, r.top - 4 - Math.min(mh, room));
        }
        m.style.left = Math.round(left) + 'px';
        m.style.top = Math.round(top) + 'px';
        m.style.width = Math.round(w) + 'px';
        m.style.maxHeight = Math.max(120, Math.round(room)) + 'px';
    }
    function _menu(open) {
        var m = _host && _host.querySelector('#wts_well_menu'), b = _host && _host.querySelector('#wts_well_menu_btn');
        if (!m) return;
        var show = (open === undefined) ? m.hasAttribute('hidden') : !!open;
        if (show) { m.removeAttribute('hidden'); _say(''); _paintSwitcher(); _placeMenu(); } else m.setAttribute('hidden', '');
        if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false');
    }
    function _ask(q, def) { return (typeof G.prompt === 'function') ? G.prompt(q, def == null ? '' : def) : null; }
    function _uiNew() {
        var nm = _ask('Name of the new well:', 'Well ' + (_readReg().wells.length + 1));
        if (nm == null) return;
        var r = create(nm);
        _say(r.ok ? 'Created ' + r.name : (r.message || r.error));
        if (!r.ok && typeof G.alert === 'function' && r.message) G.alert(r.message);
    }
    function _onMenu(act) {
        var reg = _readReg(), cur = _find(reg, reg.active), r;
        if (act === 'new') { _menu(false); _uiNew(); return; }
        if (act === 'dup') {
            var dn = _ask('Name of the copy:', cur.name + ' copy');
            if (dn == null) return;
            r = create(dn, { duplicate: true });
            _say(r.ok ? 'Duplicated as ' + r.name : (r.error === 'quota' ? r.message : ''));
            if (r.ok) _menu(false);
            return;
        }
        if (act === 'rename') {
            var nm = _ask('Rename well:', cur.name);
            if (nm == null) return;
            r = rename(reg.active, nm);
            _say(r.ok ? 'Renamed to ' + r.name : r.error);
            return;
        }
        if (act === 'delete') {
            if (reg.wells.length < 2) { _say('A project always has at least one well.'); return; }
            if (typeof G.confirm === 'function' && !G.confirm('Delete well "' + cur.name + '" and all its inputs and results?\n\nThis cannot be undone (unless you saved a project file).')) return;
            r = remove(reg.active);
            _say(r.ok ? 'Deleted.' : (r.message || r.error));
            return;
        }
        if (act === 'copy') {
            var from = _host.querySelector('#wts_well_copy_from');
            var pg = G.WTS_pageAutosave && G.WTS_pageAutosave.page ? G.WTS_pageAutosave.page() : '';
            r = copyPage(from ? from.value : '', pg);
            _say(r.ok ? 'Copied this page\'s inputs.' : r.error);
            return;
        }
        if (act === 'compare') { _menu(false); if (typeof G.WTS_nav === 'function') G.WTS_nav('wells'); return; }
        if (act === 'snap-page' || act === 'snap-job' || act === 'snap-wells') {
            share(act.slice(5)).then(function (res) {
                _say(res.ok ? 'Snapshot saved: ' + res.filename : (res.error === 'nothing to export' ? 'Nothing to export yet — run a calculation first.' : 'Snapshot failed.'));
            });
        }
    }
    function renderSwitcher(host) {
        if (!_hasDoc || !host || !('innerHTML' in host)) return;
        _ensureCss();
        _host = host;
        host.innerHTML =
            '<div class="wts-mw" data-wts-well-switcher="1">' +
              '<label for="wts_well_select">Well</label>' +
              '<select id="wts_well_select" title="Active well — each well keeps its own inputs and results"></select>' +
              '<button type="button" id="wts_well_menu_btn" aria-haspopup="true" aria-expanded="false" aria-controls="wts_well_menu" ' +
                  'title="Well actions" aria-label="Well actions">&#8943;</button>' +
              '<div class="wts-mw-menu" id="wts_well_menu" role="menu" hidden>' +
                '<button type="button" role="menuitem" data-mw="new">New well…</button>' +
                '<button type="button" role="menuitem" data-mw="dup">Duplicate this well…</button>' +
                '<button type="button" role="menuitem" data-mw="rename">Rename…</button>' +
                '<button type="button" role="menuitem" data-mw="delete">Delete this well…</button>' +
                '<div class="wts-mw-sep"></div>' +
                '<div class="wts-mw-h">Copy this page\'s inputs from</div>' +
                '<div class="wts-mw-row"><select id="wts_well_copy_from" aria-label="Copy inputs from well"></select>' +
                  '<button type="button" role="menuitem" data-mw="copy">Copy</button></div>' +
                '<button type="button" role="menuitem" data-mw="compare">Compare wells</button>' +
                '<div class="wts-mw-sep"></div>' +
                '<div class="wts-mw-h">Share read-only snapshot (HTML)</div>' +
                '<button type="button" role="menuitem" data-mw="snap-page">This page</button>' +
                '<button type="button" role="menuitem" data-mw="snap-job">Job report (this well)</button>' +
                '<button type="button" role="menuitem" data-mw="snap-wells">All wells comparison</button>' +
                '<div class="wts-mw-msg" data-role="mw-msg" role="status"></div>' +
              '</div>' +
            '</div>';
        _paintSwitcher();
        var sel = host.querySelector('#wts_well_select');
        if (sel) sel.addEventListener('change', function () {
            var r = switchTo(sel.value);
            if (!r.ok) {
                _paintSwitcher();
                if (typeof G.alert === 'function') G.alert(r.message || ('Could not switch well: ' + r.error));
            }
        });
        var btn = host.querySelector('#wts_well_menu_btn');
        if (btn) btn.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); _menu(); });
        var menu = host.querySelector('#wts_well_menu');
        if (menu) {
            menu.addEventListener('click', function (e) {
                if (e && e.stopPropagation) e.stopPropagation();
                var b = e.target && e.target.closest ? e.target.closest('[data-mw]') : null;
                if (b) _onMenu(b.getAttribute('data-mw'));
            });
            menu.addEventListener('keydown', function (e) { if (e.key === 'Escape') { _menu(false); if (btn && btn.focus) btn.focus(); } });
        }
    }

    // ───────────────────────────────────────────────────────────────
    // Events (no timers): results cache, auto-name, switcher refresh
    // ───────────────────────────────────────────────────────────────
    if (_hasDoc && typeof document.addEventListener === 'function') {
        document.addEventListener('wts:autosaved', function (e) {
            _writeResultsCache();
            // A well still named "Well N" takes the name typed in Client & Well Info.
            if (e && e.detail && e.detail.page === 'clientinfo') {
                var reg = _readReg(), w = _find(reg, reg.active), ciw = _cleanName(_ciActive().well);
                if (!reg.virtual && w && ciw && /^Well \d+$/.test(w.name) && ciw !== w.name) {
                    w.name = _uniqueName(reg, ciw, w.id);
                    _writeReg(reg);
                }
                _paintSwitcher();
            }
        });
        ['wts:well-changed', 'wts:project-loaded', 'wts:project-new'].forEach(function (t) {
            document.addEventListener(t, function () { _lastCache = null; _paintSwitcher(); });
        });
        document.addEventListener('click', function (e) {
            var m = _host && _host.querySelector('#wts_well_menu');
            if (m && !m.hasAttribute('hidden') && !(_host.contains && _host.contains(e.target))) _menu(false);
        });
    }
    if (typeof G.addEventListener === 'function') {
        try { G.addEventListener('pagehide', _writeResultsCache); } catch (e) {}
        try { G.addEventListener('resize', _placeMenu); G.addEventListener('scroll', _placeMenu, true); } catch (e) {}
    }

    G.WTS_wells = {
        list: list, active: active, switchTo: switchTo, create: create, rename: rename, remove: remove,
        copyPage: copyPage, results: results, table: table, renderPage: renderPage, renderSwitcher: renderSwitcher,
        loadWarnings: function () { return _loadWarnings.slice(); },
        _isWellKey: _isWellKey
    };
    G.WTS_snapshot = { build: build, share: share, sanitize: sanitize };

    // ── Auto-mount into the page-header host (#wts_well_host) ──
    (function () {
        if (!_hasDoc) return;
        function mount() {
            try {
                var host = document.getElementById('wts_well_host');
                if (host && !host.getAttribute('data-mounted')) { renderSwitcher(host); host.setAttribute('data-mounted', '1'); }
            } catch (e) {}
        }
        if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', mount);
        else (G.setTimeout || setTimeout)(mount, 0);
    })();

    // === SELF-TEST ===
    (function () {
        try {
            var s = sanitize('<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:x">b</a><img src="data:image/png;base64,AA">');
            var ok = s.indexOf('<script') < 0 && s.indexOf('onclick') < 0 && s.indexOf('javascript:') < 0 && s.indexOf('data:image/png') > 0;
            if (!ok && typeof console !== 'undefined') console.error('[WTS_wells] self-test failed: sanitize');
        } catch (e) { if (typeof console !== 'undefined') console.error('[WTS_wells] self-test threw', e); }
    })();

})();
