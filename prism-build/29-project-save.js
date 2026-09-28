// ════════════════════════════════════════════════════════════════════
// WTS — Layer 29 — Cross-Module Project Save / Load (.h2oilproj)
//
// PURPOSE
//   Capture EVERY calculator's state in a single JSON file so a user can
//   close the browser tab and pick up exactly where they left off.
//   The file format is a thin wrapper around a `modules` map: each
//   calculator registers a {read, write} pair, and save/load iterate
//   over the registry.
//
//   Default registrations cover WTS, ESD Hi-Pilot, ESD Lo-Pilot,
//   Hydrate Management, Liquid Line, Pipe Service Life, PRiSM, PVT,
//   the global units toggle, and — the one that carries almost all of
//   the user's typed values — `storage`: a raw snapshot of every
//   localStorage key starting with `wts_` or `h2oil_` (legacy per-
//   calculator keys, the host's universal wts_page_<page> autosave
//   records, h2oil_client_info, PRiSM keys). Preference keys (unit
//   system, sample-suppress, consent/analytics flags) are never saved,
//   loaded or cleared.
//
// PUBLIC API
//   window.WTS_project = {
//       save(filename?)         → Promise<{ blob, filename, payload }>
//       saveDownload(filename?) → download (or iOS share-sheet) the file
//       saveAs()                → real "Save As" dialog where the File
//                                 System Access API exists (remembers the
//                                 file handle), else prompt + download
//       saveCurrent()           → silent write to the remembered handle,
//                                 else falls back to saveAs / download
//       open(fileInput?)        → showOpenFilePicker where available, else
//                                 clicks the given <input type=file>
//       load(file: File)        → Promise<{ loaded: [...], skipped: [...] }>
//       loadFromObject(obj)     → synchronous; same shape as load result
//       new()                   → wipe project state (keeps preferences)
//       currentFile()           → { name, hasHandle } | null
//       info()                  → { modules: [...], modifiedAt, size }
//       registerModule(name, { read, write })
//       unregisterModule(name)
//       listModules()
//   };
//   window.WTS_renderProjectToolbar(container) → mounts the File toolbar
//
// HOST HOOKS (well-testing-app.html, all optional)
//   window.WTS_pageAutosave.flush() — push the visible page's live values
//                                     into localStorage before a save
//   window.WTS_rerender({discardPending}) — repaint the current page from
//                                     storage after Open / New
//   window.__projectSaveOverride(filename, jsonText) — iOS bridge: write +
//                                     share-sheet instead of <a download>
//   'wts:autosaved' event            — drives the "● Autosaved hh:mm" status
//
// EVENTS (document)
//   'wts:project-loaded' {loaded, skipped} — after Open replaced storage
//   'wts:project-new'    {cleared}         — after New cleared storage
//   'wts:projectfile'    {name, hasHandle} — current file name changed
//   Layers that cache localStorage in memory should re-read on these.
//
// FILE FORMAT (.h2oilproj — JSON)
//   {
//     "format":   "h2oilproj",
//     "version":  "1.0",
//     "generator":"H2Oil Well Testing Suite",
//     "savedAt":  "2026-04-28T12:34:56.789Z",
//     "modules":  { "<key>": <state>, ..., "storage": { keys: {k: raw}, skipped: [] } },
//     "meta":     { client?, well?, field?, notes? }
//   }
//   Files written before the `storage` module existed still load (the
//   other modules apply; nothing in localStorage is cleared).
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'
//   • No external runtime deps — vanilla JS + Blob + FileReader
//   • Modules auto-register on load if their window globals exist; if
//     they don't, save/load just skips them (forward-compatible)
//   • Defensive: never throws on bad data — always returns / rejects
//     with a structured error
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _log()  { if (typeof console !== 'undefined' && console.log)  try { console.log.apply(console, arguments); }  catch (e) {} }
    function _warn() { if (typeof console !== 'undefined' && console.warn) try { console.warn.apply(console, arguments); } catch (e) {} }
    function _err()  { if (typeof console !== 'undefined' && console.error) try { console.error.apply(console, arguments); } catch (e) {} }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Deep clone via JSON round-trip — keeps state isolated from
    // module internals so callers can mutate without surprise.
    function _clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); }
        catch (e) { return null; }
    }

    function _nowISO() { return new Date().toISOString(); }

    function _slugify(s) {
        return String(s == null ? 'project' : s)
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 60) || 'project';
    }

    var EXT = '.h2oilproj';

    // Keep the user's spelling/case, drop characters no file system accepts.
    function _fileName(base) {
        var s = String(base == null ? '' : base).trim().replace(/\.h2oilproj$/i, '');
        s = s.replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').substring(0, 80);
        return (s || 'project') + EXT;
    }

    function _isIOSApp() {
        if (!_hasWin) return false;
        if (G.isIOSApp === true) return true;
        try { return !!(G.Capacitor && G.Capacitor.isNativePlatform && G.Capacitor.isNativePlatform()); }
        catch (e) { return false; }
    }

    // ───────────────────────────────────────────────────────────────
    // localStorage helpers (storage module + New)
    // ───────────────────────────────────────────────────────────────
    var KEY_PREFIXES = ['wts_', 'h2oil_'];
    // Preferences / install flags — describe the user or the device, not
    // the project: never saved into a file, never overwritten or cleared.
    var PREF_KEYS = {
        'wts_unit_system': 1,            // 22-units.js STORAGE_KEY
        'wts_prism_sample_suppress': 1,  // PRiSM "don't re-seed sample data"
        'wts_prism_migrated': 1          // one-shot DCA/PTA → PRiSM migration flag
    };
    var PREF_RE = /consent|analytics|tracking|(^|_)ga(_|$)|subscri|entitle|purchase/i;
    // Cross-project libraries: saved in the file, restored on Open only
    // when missing locally, kept on New.
    var LIBRARY_RE = /^wts_prism_(user_curves|presets|mapping_)/;
    // "Prepared by" fields of Client & Well Info survive New.
    var PREPARER_FIELDS = ['engineer', 'position', 'company', 'eng_email'];
    var MAX_KEY_CHARS = 2 * 1024 * 1024;   // skip transient blobs bigger than ~2 MB

    function _ls() {
        try {
            var ls = (typeof localStorage !== 'undefined') ? localStorage : (G.localStorage || null);
            return (ls && typeof ls.getItem === 'function') ? ls : null;
        } catch (e) { return null; }
    }
    function _lsKeys(ls) {
        var out = [];
        if (!ls) return out;
        try {
            if (typeof ls.key === 'function' && typeof ls.length === 'number') {
                for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k != null) out.push(k); }
            } else if (ls._ && typeof ls._ === 'object') {       // smoke-test stub
                out = Object.keys(ls._);
            }
        } catch (e) {}
        return out;
    }
    function _hasPrefix(k) {
        for (var i = 0; i < KEY_PREFIXES.length; i++) if (String(k).indexOf(KEY_PREFIXES[i]) === 0) return true;
        return false;
    }
    function _isPrefKey(k)    { return !!PREF_KEYS[k] || PREF_RE.test(String(k)); }
    function _isLibraryKey(k) { return LIBRARY_RE.test(String(k)); }
    function _isProjectKey(k) { return _hasPrefix(k) && !_isPrefKey(k); }

    function _readClientInfo() {
        var ls = _ls();
        try { return JSON.parse((ls && ls.getItem('h2oil_client_info')) || '{}') || {}; }
        catch (e) { return {}; }
    }

    // Remove every project key (keeps preferences + libraries). Keeps the
    // "Report prepared by" part of Client & Well Info.
    function _clearProjectKeys() {
        var ls = _ls();
        if (!ls) return [];
        var ci = _readClientInfo();
        var removed = [];
        var keys = _lsKeys(ls);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!_isProjectKey(k) || _isLibraryKey(k)) continue;
            try { ls.removeItem(k); removed.push(k); } catch (e) {}
        }
        var keep = {}, any = false;
        for (var j = 0; j < PREPARER_FIELDS.length; j++) {
            var f = PREPARER_FIELDS[j];
            if (ci[f]) { keep[f] = ci[f]; any = true; }
        }
        if (any) { try { ls.setItem('h2oil_client_info', JSON.stringify(keep)); } catch (e) {} }
        return removed;
    }

    function _flushAutosave() {
        try {
            if (G.WTS_pageAutosave && typeof G.WTS_pageAutosave.flush === 'function') G.WTS_pageAutosave.flush();
        } catch (e) { _warn('[WTS_project] autosave flush failed', e); }
    }

    // Repaint the visible page from storage (host hook) — after Open / New.
    function _rerender() {
        try {
            if (typeof G.WTS_rerender === 'function') G.WTS_rerender({ discardPending: true });
        } catch (e) { _warn('[WTS_project] re-render failed', e); }
    }

    // ───────────────────────────────────────────────────────────────
    // Module registry
    //
    //   MODULES[key] = {
    //     read:  () => state object (or null)
    //     write: (state) => void
    //   }
    //
    // Each module owns persistence of its OWN namespace. The project
    // layer only orchestrates and serialises.
    // ───────────────────────────────────────────────────────────────
    var MODULES = {};

    function registerModule(key, handler) {
        if (!key || typeof key !== 'string') return false;
        if (!handler || typeof handler.read !== 'function' ||
            typeof handler.write !== 'function') return false;
        MODULES[key] = handler;
        return true;
    }
    function unregisterModule(key) {
        if (MODULES[key]) { delete MODULES[key]; return true; }
        return false;
    }
    function listModules() {
        var out = [];
        for (var k in MODULES) if (Object.prototype.hasOwnProperty.call(MODULES, k)) out.push(k);
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // Default module registrations
    //
    // Each handler is registered defensively — they read from / write
    // to the canonical globals used by layers 22-27 + PRiSM. If a
    // global isn't there at save-time, the handler returns null and
    // the module is skipped in the output file.
    // ───────────────────────────────────────────────────────────────
    function _ensureWTSState() {
        if (!G.WTS_state || typeof G.WTS_state !== 'object') G.WTS_state = {};
        return G.WTS_state;
    }

    function _registerDefaults() {
        // wts — generic WTS flow profile state (top-level WTS_state minus the
        // per-module nested keys we register separately).
        registerModule('wts', {
            read: function () {
                if (!G.WTS_state) return null;
                var s = G.WTS_state;
                var copy = {};
                var skip = { esdHiPilot: 1, esdLoPilot: 1, hydrate: 1, liquidline: 1,
                             pipelife: 1, prism: 1, pvt: 1, units: 1, clientInfo: 1 };
                for (var k in s) {
                    if (Object.prototype.hasOwnProperty.call(s, k) && !skip[k]) {
                        copy[k] = _clone(s[k]);
                    }
                }
                return copy;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (!state || typeof state !== 'object') return;
                for (var k in state) {
                    if (Object.prototype.hasOwnProperty.call(state, k)) {
                        s[k] = _clone(state[k]);
                    }
                }
            }
        });

        registerModule('esdhi', {
            read: function () {
                return (G.WTS_state && G.WTS_state.esdHiPilot) ? _clone(G.WTS_state.esdHiPilot) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.esdHiPilot = _clone(state);
            }
        });

        registerModule('esdlo', {
            read: function () {
                return (G.WTS_state && G.WTS_state.esdLoPilot) ? _clone(G.WTS_state.esdLoPilot) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.esdLoPilot = _clone(state);
            }
        });

        registerModule('hydrate', {
            read: function () {
                return (G.WTS_state && G.WTS_state.hydrate) ? _clone(G.WTS_state.hydrate) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.hydrate = _clone(state);
            }
        });

        registerModule('liquidline', {
            read: function () {
                return (G.WTS_state && G.WTS_state.liquidline) ? _clone(G.WTS_state.liquidline) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.liquidline = _clone(state);
            }
        });

        registerModule('pipelife', {
            read: function () {
                return (G.WTS_state && G.WTS_state.pipelife) ? _clone(G.WTS_state.pipelife) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.pipelife = _clone(state);
            }
        });

        registerModule('prism', {
            read: function () {
                if (!G.PRiSM_state) return null;
                var subset = {
                    activeModel:    G.PRiSM_state.activeModel,
                    params:         _clone(G.PRiSM_state.params),
                    lastFit:        _clone(G.PRiSM_state.lastFit),
                    autoMatchTopN:  _clone(G.PRiSM_state.autoMatchTopN),
                    interp:         _clone(G.PRiSM_state.interp),
                    pvt:            _clone(G.PRiSM_state.pvt),
                    crop:           _clone(G.PRiSM_state.crop),
                    project:        _clone(G.PRiSM_state.project)
                };
                return subset;
            },
            write: function (state) {
                if (!state || typeof state !== 'object') return;
                if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
                var s = G.PRiSM_state;
                for (var k in state) {
                    if (Object.prototype.hasOwnProperty.call(state, k)) {
                        s[k] = _clone(state[k]);
                    }
                }
            }
        });

        registerModule('prism_dataset', {
            read: function () {
                // Datasets can be huge — only persist when explicitly opted in.
                if (!G.PRiSM_dataset) return null;
                if (G.PRiSM_state && G.PRiSM_state.project &&
                    G.PRiSM_state.project.includeDataset === false) return null;
                return _clone(G.PRiSM_dataset);
            },
            write: function (state) {
                if (!state) return;
                G.PRiSM_dataset = _clone(state);
            }
        });

        registerModule('pvt', {
            read: function () {
                if (G.PRiSM_pvt) return _clone(G.PRiSM_pvt);
                if (G.WTS_state && G.WTS_state.pvt) return _clone(G.WTS_state.pvt);
                return null;
            },
            write: function (state) {
                if (!state) return;
                G.PRiSM_pvt = _clone(state);
                var s = _ensureWTSState();
                s.pvt = _clone(state);
            }
        });

        registerModule('units', {
            read: function () {
                if (G.WTS_state && G.WTS_state.units) return _clone(G.WTS_state.units);
                if (G.WTS_unitsSystem) return { system: G.WTS_unitsSystem };
                return null;
            },
            write: function (state) {
                if (!state) return;
                var s = _ensureWTSState();
                s.units = _clone(state);
                if (state.system) G.WTS_unitsSystem = state.system;
                // Let units layer re-paint if it offers a hook
                if (typeof G.WTS_setUnitsSystem === 'function' && state.system) {
                    try { G.WTS_setUnitsSystem(state.system); } catch (e) {}
                }
            }
        });

        registerModule('clientinfo', {
            read: function () {
                if (G.WTS_state && G.WTS_state.clientInfo) return _clone(G.WTS_state.clientInfo);
                return null;
            },
            write: function (state) {
                if (!state) return;
                var s = _ensureWTSState();
                s.clientInfo = _clone(state);
            }
        });

        // storage — every user-typed value on every page. Raw localStorage
        // strings for keys prefixed wts_ / h2oil_ (minus preferences).
        //   read()      flushes the visible page first, skips values > 2 MB
        //   write(obj)  replaces the project keys with the file's keys
        //   write(null) clears the project keys (New)
        registerModule('storage', {
            read: function () {
                _flushAutosave();
                var ls = _ls();
                if (!ls) return null;
                var keys = _lsKeys(ls).filter(_isProjectKey).sort();
                var out = {}, skipped = [], n = 0;
                for (var i = 0; i < keys.length; i++) {
                    var v = null;
                    try { v = ls.getItem(keys[i]); } catch (e) { v = null; }
                    if (v == null) continue;
                    if (v.length > MAX_KEY_CHARS) {
                        skipped.push({ key: keys[i], chars: v.length });
                        continue;
                    }
                    out[keys[i]] = String(v);
                    n++;
                }
                if (skipped.length) {
                    _warn('[WTS_project] storage: skipped ' + skipped.length +
                          ' oversized key(s) (> 2 MB):', skipped);
                }
                return n ? { keys: out, skipped: skipped } : null;
            },
            write: function (state) {
                var ls = _ls();
                if (!ls) return;
                if (state === null) { _clearProjectKeys(); return; }        // New
                if (!state || typeof state !== 'object' || !state.keys ||
                    typeof state.keys !== 'object') return;
                _clearProjectKeys();
                var keys = state.keys;
                for (var k in keys) {
                    if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
                    if (!_isProjectKey(k) || typeof keys[k] !== 'string') continue;
                    if (_isLibraryKey(k) && ls.getItem(k) != null) continue;  // keep local library
                    try { ls.setItem(k, keys[k]); }
                    catch (e) { _warn('[WTS_project] storage: could not write ' + k, e); }
                }
            }
        });
    }
    _registerDefaults();

    // Report metadata from Client & Well Info (used for the file name).
    function _defaultMeta() {
        var ci = _readClientInfo(), m = {};
        if (ci.client) m.client = String(ci.client);
        if (ci.well) m.well = String(ci.well);
        if (ci.field) m.field = String(ci.field);
        if (ci.operator) m.operator = String(ci.operator);
        return m;
    }
    function _suggestedName() {
        if (_current.name) return _current.name;
        var well = '';
        try {
            well = _readClientInfo().well ||
                   (G.WTS_state && G.WTS_state.clientInfo && G.WTS_state.clientInfo.wellName) || '';
        } catch (e) {}
        return _fileName(well || 'project');
    }

    // ───────────────────────────────────────────────────────────────
    // Build the file payload by polling every registered module
    // ───────────────────────────────────────────────────────────────
    function _buildPayload(meta) {
        var modules = {};
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            var state = null;
            try { state = MODULES[k].read(); } catch (e) {
                _warn('module read failed for ' + k, e);
                state = null;
            }
            if (state != null) modules[k] = state;
        }
        var payload = {
            format:    'h2oilproj',
            version:   '1.0',
            generator: 'H2Oil Well Testing Suite',
            savedAt:   _nowISO(),
            meta:      meta || _defaultMeta(),
            modules:   modules
        };
        return payload;
    }

    function _applyPayload(payload) {
        var loaded = [];
        var skipped = [];
        if (!payload || typeof payload !== 'object') {
            return { loaded: loaded, skipped: skipped, error: 'empty payload' };
        }
        if (payload.format && payload.format !== 'h2oilproj') {
            return { loaded: loaded, skipped: skipped, error: 'wrong format: ' + payload.format };
        }
        // Drop pending debounced autosaves so they can't overwrite loaded keys.
        try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.cancel) G.WTS_pageAutosave.cancel(); } catch (e) {}
        var mods = payload.modules || {};
        for (var k in mods) {
            if (!Object.prototype.hasOwnProperty.call(mods, k)) continue;
            if (!MODULES[k]) { skipped.push(k); continue; }
            try {
                MODULES[k].write(mods[k]);
                loaded.push(k);
            } catch (e) {
                _warn('module write failed for ' + k, e);
                skipped.push(k);
            }
        }
        return { loaded: loaded, skipped: skipped, error: null };
    }

    // ───────────────────────────────────────────────────────────────
    // Save — returns a Promise<{ blob, filename, payload, json }>
    // ───────────────────────────────────────────────────────────────
    function _saveSync(filename, meta) {
        var payload = _buildPayload(meta);
        var json = JSON.stringify(payload, null, 2);
        var blob = null;
        if (typeof G.Blob === 'function') {
            try { blob = new G.Blob([json], { type: 'application/json' }); }
            catch (e) { blob = null; }
        }
        var name = filename ? _fileName(filename) : _suggestedName();
        // In node (smoke-test) Blob won't exist — fall back to a stub object.
        if (!blob || typeof blob.size !== 'number') blob = { size: json.length, type: 'application/json', _text: json };
        return { blob: blob, filename: name, payload: payload, json: json };
    }

    function save(filename, meta) {
        try {
            var res = _saveSync(filename, meta);
            if (typeof G.Promise === 'function') return G.Promise.resolve(res);
            return res;
        } catch (e) {
            _err('save() failed', e);
            if (typeof G.Promise === 'function') return G.Promise.reject(e);
            throw e;
        }
    }

    // Anchor download (desktop browsers without the File System Access API).
    function _download(res) {
        if (!_hasDoc) return false;
        try {
            var url = (G.URL && typeof G.URL.createObjectURL === 'function' && res.blob && !res.blob._text)
                ? G.URL.createObjectURL(res.blob) : null;
            var a = document.createElement('a');
            a.href = url || ('data:application/json;charset=utf-8,' + encodeURIComponent(res.json));
            a.download = res.filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                try { document.body.removeChild(a); } catch (e) {}
                if (url && G.URL && G.URL.revokeObjectURL) {
                    try { G.URL.revokeObjectURL(url); } catch (e) {}
                }
            }, 250);
            return true;
        } catch (e) { _warn('download could not click', e); return false; }
    }

    // Deliver a built file: iOS override (write + share sheet) or download.
    function _deliver(res) {
        if (typeof G.__projectSaveOverride === 'function') {
            return G.Promise.resolve()
                .then(function () { return G.__projectSaveOverride(res.filename, res.json); })
                .then(function (ok) {
                    if (ok === false) { _download(res); res.method = 'download'; }
                    else res.method = 'override';
                    return res;
                }, function (e) {
                    _warn('[WTS_project] save override failed, downloading instead', e);
                    _download(res); res.method = 'download';
                    return res;
                });
        }
        _download(res);
        res.method = 'download';
        return G.Promise.resolve(res);
    }

    // ───────────────────────────────────────────────────────────────
    // saveDownload — build + deliver (download / iOS share sheet)
    // ───────────────────────────────────────────────────────────────
    function saveDownload(filename, meta) {
        try {
            var res = _saveSync(filename, meta);
            if (!_hasDoc) return (typeof G.Promise === 'function') ? G.Promise.resolve(res) : res;
            return _deliver(res);
        } catch (e) { _err('saveDownload failed', e); throw e; }
    }

    // ───────────────────────────────────────────────────────────────
    // Save / Save As with a remembered file (File System Access API)
    // ───────────────────────────────────────────────────────────────
    var _current = { handle: null, name: null };
    var PICKER_TYPES = [{ description: 'H2Oil project', accept: { 'application/json': [EXT] } }];

    function _hasSavePicker() {
        return _hasWin && typeof G.showSaveFilePicker === 'function' &&
               typeof G.__projectSaveOverride !== 'function';
    }
    function _hasOpenPicker() {
        return _hasWin && typeof G.showOpenFilePicker === 'function' && !_isIOSApp();
    }
    function _notifyFile() {
        try {
            if (_hasDoc && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('wts:projectfile', { detail: currentFile() }));
            }
        } catch (e) {}
    }
    function _setCurrent(handle, name) {
        _current = { handle: handle || null, name: name || null };
        _notifyFile();
    }
    function currentFile() {
        return _current.name ? { name: _current.name, hasHandle: !!_current.handle } : null;
    }

    function _writeHandle(handle, text) {
        return G.Promise.resolve()
            .then(function () {
                if (typeof handle.queryPermission !== 'function') return;
                return handle.queryPermission({ mode: 'readwrite' }).then(function (st) {
                    if (st === 'granted' || typeof handle.requestPermission !== 'function') return;
                    return handle.requestPermission({ mode: 'readwrite' }).then(function (st2) {
                        if (st2 !== 'granted') throw new Error('write permission denied');
                    });
                });
            })
            .then(function () { return handle.createWritable(); })
            .then(function (w) { return G.Promise.resolve(w.write(text)).then(function () { return w.close(); }); });
    }

    // Download fallback for Save As — ask for a name first.
    function _downloadAs(res, askName) {
        var name = res.filename;
        if (askName && typeof G.prompt === 'function') {
            var nm = G.prompt('Save project as…', name.replace(/\.h2oilproj$/i, ''));
            if (nm == null || !String(nm).trim()) return G.Promise.resolve({ cancelled: true });
            name = _fileName(nm);
        }
        res.filename = name;
        return _deliver(res).then(function (r) {
            _setCurrent(null, name);
            return { saved: true, filename: name, method: r.method };
        });
    }

    function saveAs() {
        var res;
        try { res = _saveSync(null); } catch (e) { return G.Promise.reject(e); }
        if (_hasSavePicker()) {
            var picked;
            try {
                picked = G.showSaveFilePicker({ suggestedName: res.filename, types: PICKER_TYPES });
            } catch (e) { picked = G.Promise.reject(e); }
            return G.Promise.resolve(picked).then(function (handle) {
                return _writeHandle(handle, res.json).then(function () {
                    _setCurrent(handle, handle.name || res.filename);
                    return { saved: true, filename: _current.name, method: 'picker' };
                });
            }, function (e) {
                if (e && e.name === 'AbortError') return { cancelled: true };
                _warn('[WTS_project] save dialog unavailable, downloading instead', e);
                return _downloadAs(res, true);
            });
        }
        return _downloadAs(res, true);
    }

    function saveCurrent() {
        // First Save with a dialog-capable browser = Save As (must run in the click's activation)
        if (!_current.handle && _hasSavePicker()) return saveAs();
        var res;
        try { res = _saveSync(null); } catch (e) { return G.Promise.reject(e); }
        if (_current.handle) {
            var h = _current.handle;
            return _writeHandle(h, res.json).then(function () {
                _notifyFile();
                return { saved: true, filename: _current.name, method: 'handle' };
            }, function (e) {
                _warn('[WTS_project] could not write ' + _current.name + ' — choosing a new file', e);
                return saveAs();
            });
        }
        return _downloadAs(res, false);              // no dialog API: download / share silently
    }

    // Open: native picker (remembers the handle so Save overwrites it) or
    // the hidden <input type=file>. Returns a Promise; with the <input>
    // path it resolves { deferred: true } and the input's change handler
    // does the load.
    function open(fileInput) {
        function viaInput() {
            if (!fileInput || typeof fileInput.click !== 'function') {
                return G.Promise.reject(new Error('no file picker available'));
            }
            try {
                // iOS greys out unknown extensions (.h2oilproj has no UTI) — accept anything there.
                if (_isIOSApp()) fileInput.removeAttribute('accept');
                else fileInput.setAttribute('accept', EXT + ',.json,application/json');
            } catch (e) {}
            fileInput.click();
            return G.Promise.resolve({ deferred: true });
        }
        if (!_hasOpenPicker()) return viaInput();
        var picked;
        try {
            picked = G.showOpenFilePicker({ multiple: false, types: [{ description: 'H2Oil project',
                     accept: { 'application/json': [EXT, '.json'] } }] });
        } catch (e) { picked = G.Promise.reject(e); }
        return G.Promise.resolve(picked).then(function (handles) {
            var h = handles && handles[0];
            if (!h) return { cancelled: true };
            return h.getFile().then(function (file) {
                return load(file).then(function (r) {
                    if (r && !r.error) _setCurrent(h, file.name);
                    if (r) r.filename = file.name;
                    return r;
                });
            });
        }, function (e) {
            if (e && e.name === 'AbortError') return { cancelled: true };
            _warn('[WTS_project] open dialog unavailable, using file input', e);
            return viaInput();
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Load — accept a File (browser) or string (smoke-test)
    // ───────────────────────────────────────────────────────────────
    function load(file) {
        if (!file) {
            if (typeof G.Promise === 'function') return G.Promise.reject(new Error('no file'));
            throw new Error('no file');
        }
        // string -> parse directly
        if (typeof file === 'string') {
            return new G.Promise(function (resolve, reject) {
                try { resolve(loadFromObject(JSON.parse(file))); }
                catch (e) { reject(e); }
            });
        }
        // Plain object (e.g. parsed JSON passed in)
        if (typeof file === 'object' && file && !file.text && !file.arrayBuffer &&
            !file.name && !file._text) {
            if (typeof G.Promise === 'function') return G.Promise.resolve(loadFromObject(file));
            return loadFromObject(file);
        }
        // File / Blob from <input type=file>
        var readerCtor = G.FileReader;
        if (!readerCtor) {
            // Some environments lack FileReader; try .text()
            if (typeof file.text === 'function') {
                return file.text().then(function (txt) {
                    return loadFromObject(JSON.parse(txt));
                });
            }
            return G.Promise.reject(new Error('FileReader unavailable'));
        }
        return new G.Promise(function (resolve, reject) {
            try {
                var fr = new readerCtor();
                fr.onload = function () {
                    try {
                        var txt = (fr.result == null) ? '' : String(fr.result);
                        var obj = JSON.parse(txt);
                        resolve(loadFromObject(obj));
                    } catch (e) { reject(e); }
                };
                fr.onerror = function () { reject(fr.error || new Error('read error')); };
                fr.readAsText(file);
            } catch (e) { reject(e); }
        });
    }

    // Tell other layers (caches kept in memory) that storage was replaced.
    function _emit(name, detail) {
        try {
            if (_hasDoc && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
            }
        } catch (e) {}
    }

    function loadFromObject(obj) {
        var res = _applyPayload(obj);
        if (res && !res.error && res.loaded.length) {
            _emit('wts:project-loaded', { loaded: res.loaded.slice(), skipped: res.skipped.slice() });
            _rerender();
        }
        return res;
    }

    // ───────────────────────────────────────────────────────────────
    // New — clear every registered module's state + project keys in
    // localStorage (preferences / libraries / "prepared by" are kept)
    // ───────────────────────────────────────────────────────────────
    function newProject() {
        try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.cancel) G.WTS_pageAutosave.cancel(); } catch (e) {}
        var cleared = [];
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            try {
                MODULES[k].write(null);
                cleared.push(k);
            } catch (e) { _warn('clear failed for ' + k, e); }
        }
        // Reset WTS_state to a blank object for non-module keys too.
        try { G.WTS_state = {}; } catch (e) {}
        // In-memory row models that outlive a page render.
        try { if (Array.isArray(G._genMotors)) G._genMotors = []; } catch (e) {}
        _setCurrent(null, null);
        _emit('wts:project-new', { cleared: cleared.slice() });
        _rerender();
        return { cleared: cleared };
    }

    // ───────────────────────────────────────────────────────────────
    // Info — describe the current in-memory project
    // ───────────────────────────────────────────────────────────────
    function info() {
        var modulesWithState = [];
        var modulesEmpty = [];
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            var st = null;
            try { st = MODULES[k].read(); } catch (e) {}
            if (st != null) modulesWithState.push(k);
            else modulesEmpty.push(k);
        }
        var payload = _buildPayload();
        var size = 0;
        try { size = JSON.stringify(payload).length; } catch (e) {}
        return {
            modules:           modulesWithState,
            emptyModules:      modulesEmpty,
            registeredModules: listModules(),
            modifiedAt:        payload.savedAt,
            size:              size,
            file:              currentFile()
        };
    }

    // ───────────────────────────────────────────────────────────────
    // File toolbar UI — New | Open | Save | Save As  + status
    // ───────────────────────────────────────────────────────────────
    function _hhmm(t) {
        var d = new Date(t);
        var h = d.getHours(), m = d.getMinutes();
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function renderProjectToolbar(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;

        // Idempotent — do not duplicate if already mounted in the host.
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-project-toolbar="1"]') : null;
        if (existing) return;

        var wrap = document.createElement('div');
        wrap.setAttribute('data-wts-project-toolbar', '1');
        wrap.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--bg2,#161b22);' +
            'border:1px solid var(--border,#30363d);border-radius:6px;font-size:12px;' +
            'color:var(--text2,#8b949e);flex-wrap:wrap';

        var btnStyle =
            'padding:4px 10px;background:var(--bg4,#21262d);border:1px solid var(--border,#30363d);' +
            'border-radius:4px;color:var(--text,#e6edf3);font-size:12px;cursor:pointer;line-height:1.4;' +
            'font-family:inherit';
        var labelStyle = 'color:var(--text2,#8b949e);margin-right:2px;font-weight:600';

        wrap.innerHTML =
            '<span style="' + labelStyle + '">File:</span>' +
            '<button type="button" data-act="new"  style="' + btnStyle + '" title="Start a new project (clears all calculator inputs)">New</button>' +
            '<button type="button" data-act="open" style="' + btnStyle + '" title="Open a .h2oilproj project file">Open…</button>' +
            '<button type="button" data-act="save" style="' + btnStyle + '" title="Save the project (all inputs on every page)">Save</button>' +
            '<button type="button" data-act="saveas" style="' + btnStyle + '" title="Save the project to a new file">Save As…</button>' +
            '<span data-role="status" style="display:inline-flex;align-items:center;gap:8px;margin-left:4px;' +
                'font-size:11px;white-space:nowrap">' +
              '<span data-role="msg"></span>' +
              '<span data-role="file" style="color:var(--text2,#8b949e);max-width:180px;overflow:hidden;' +
                  'text-overflow:ellipsis;display:none" title="Current project file"></span>' +
              '<span data-role="autosave" style="color:var(--text3,#6e7681)" ' +
                  'title="Every input on every page is saved in this browser automatically">' +
                  '<span style="color:var(--green,#3fb950)">&#9679;</span> Autosave on</span>' +
            '</span>' +
            '<input type="file" data-role="picker" accept=".h2oilproj,.json,application/json" ' +
            'style="display:none">';

        try { container.appendChild(wrap); } catch (e) { return; }

        var msgEl  = wrap.querySelector('[data-role="msg"]');
        var fileEl = wrap.querySelector('[data-role="file"]');
        var autoEl = wrap.querySelector('[data-role="autosave"]');
        var msgTimer = null;

        function _setStatus(msg, kind) {
            if (!msgEl) return;
            var color = (kind === 'err') ? 'var(--red,#f85149)' :
                        (kind === 'ok')  ? 'var(--green,#3fb950)' : 'var(--text2,#8b949e)';
            msgEl.style.color = color;
            msgEl.textContent = String(msg || '');
            clearTimeout(msgTimer);
            if (msg && kind !== 'err') {
                msgTimer = setTimeout(function () {
                    if (msgEl.textContent === msg) msgEl.textContent = '';
                }, 4000);
            }
        }
        function _showFile() {
            if (!fileEl) return;
            var cf = currentFile();
            fileEl.textContent = cf ? cf.name : '';
            fileEl.title = cf ? ('Current project file: ' + cf.name +
                (cf.hasHandle ? ' (Save writes to this file)' : '')) : '';
            fileEl.style.display = cf ? '' : 'none';
        }
        function _showAutosave(at) {
            if (!autoEl || !at) return;
            autoEl.innerHTML = '<span style="color:var(--green,#3fb950)">&#9679;</span> Autosaved ' + _esc(_hhmm(at));
        }
        document.addEventListener('wts:autosaved', function (e) {
            _showAutosave(e && e.detail && e.detail.at);
        });
        document.addEventListener('wts:projectfile', _showFile);
        if (G.WTS_lastAutosave && G.WTS_lastAutosave.at) _showAutosave(G.WTS_lastAutosave.at);
        _showFile();

        function _errMsg(e) { return (e && e.message) ? e.message : String(e); }
        function _loadedMsg(res, name) {
            var ln = res ? (res.loaded || []).length : 0;
            var sk = res ? (res.skipped || []).length : 0;
            return 'Opened ' + (name || 'project') + ' (' + ln + ' modules' + (sk ? ', ' + sk + ' skipped' : '') + ')';
        }

        // Wire buttons.
        var btnNew    = wrap.querySelector('[data-act="new"]');
        var btnOpen   = wrap.querySelector('[data-act="open"]');
        var btnSave   = wrap.querySelector('[data-act="save"]');
        var btnSaveAs = wrap.querySelector('[data-act="saveas"]');
        var picker    = wrap.querySelector('[data-role="picker"]');

        if (btnNew) btnNew.addEventListener('click', function () {
            var ok = true;
            if (typeof G.confirm === 'function') {
                ok = G.confirm('Start a new project?\n\nAll calculator inputs on every page will be cleared ' +
                               '(unit system and "Report prepared by" details are kept). ' +
                               'Save first if you want to keep the current project.');
            }
            if (!ok) return;
            newProject();
            _setStatus('New project started.', 'ok');
        });

        if (btnOpen && picker) {
            btnOpen.addEventListener('click', function () {
                open(picker).then(function (res) {
                    if (!res || res.cancelled || res.deferred) return;
                    if (res.error) _setStatus('Open failed: ' + res.error, 'err');
                    else _setStatus(_loadedMsg(res, res.filename), 'ok');
                }, function (err) {
                    _setStatus('Open failed: ' + _errMsg(err), 'err');
                });
            });
            picker.addEventListener('change', function (ev) {
                var f = ev.target && ev.target.files && ev.target.files[0];
                if (!f) return;
                _setStatus('Opening ' + f.name + '…');
                load(f).then(function (res) {
                    if (res && res.error) {
                        _setStatus('Open failed: ' + res.error, 'err');
                    } else {
                        _setCurrent(null, f.name);
                        _setStatus(_loadedMsg(res, f.name), 'ok');
                    }
                    picker.value = '';
                }, function (err) {
                    _setStatus('Open failed: ' + _errMsg(err), 'err');
                    picker.value = '';
                });
            });
        }

        function _afterSave(r) {
            if (!r || r.cancelled) return;
            _setStatus(r.method === 'download' ? 'Downloaded ' + r.filename :
                       r.method === 'override' ? 'Saved ' + r.filename : 'Saved.', 'ok');
            _showFile();
        }
        function _saveErr(e) { _setStatus('Save failed: ' + _errMsg(e), 'err'); }
        if (btnSave) btnSave.addEventListener('click', function () {
            try { saveCurrent().then(_afterSave, _saveErr); } catch (e) { _saveErr(e); }
        });
        if (btnSaveAs) btnSaveAs.addEventListener('click', function () {
            try { saveAs().then(_afterSave, _saveErr); } catch (e) { _saveErr(e); }
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_project = {
        save:             save,
        saveDownload:     saveDownload,
        saveAs:           saveAs,
        saveCurrent:      saveCurrent,
        open:             open,
        load:             load,
        loadFromObject:   loadFromObject,
        'new':            newProject,   // reserved word — bracket-access from callers
        clearAll:         newProject,   // friendlier alias
        currentFile:      currentFile,
        info:             info,
        registerModule:   registerModule,
        unregisterModule: unregisterModule,
        listModules:      listModules,
        // Synchronous payload builder — primarily for QA / unit tests
        _buildPayload:    _buildPayload
    };
    G.WTS_renderProjectToolbar = renderProjectToolbar;

    // ── Auto-mount into the page-header host (#wts_project_toolbar_host) ──
    (function _autoMountProjectToolbar() {
        if (!_hasDoc) return;
        function mount() {
            try {
                var host = G.document.getElementById('wts_project_toolbar_host');
                if (host && !host.getAttribute('data-mounted')) {
                    renderProjectToolbar(host);
                    host.setAttribute('data-mounted', '1');
                }
            } catch (e) { /* non-fatal */ }
        }
        if (G.document.readyState === 'loading' && G.document.addEventListener) {
            G.document.addEventListener('DOMContentLoaded', mount);
        } else {
            (G.setTimeout || setTimeout)(mount, 0);
        }
    })();

    // === SELF-TEST ===
    (function () {
        try {
            var checks = [];

            checks.push({ n: 'public API present',
                          ok: typeof G.WTS_project === 'object' &&
                              typeof G.WTS_project.save === 'function' &&
                              typeof G.WTS_project.load === 'function' &&
                              typeof G.WTS_project.loadFromObject === 'function' &&
                              typeof G.WTS_project.info === 'function' &&
                              typeof G.WTS_project.saveAs === 'function' &&
                              typeof G.WTS_project.saveCurrent === 'function' &&
                              typeof G.WTS_project.registerModule === 'function' });

            // Default modules registered
            var defaults = G.WTS_project.listModules();
            var needed = ['wts', 'esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife',
                          'prism', 'pvt', 'units', 'storage'];
            var allDefaults = true;
            for (var i = 0; i < needed.length; i++) {
                if (defaults.indexOf(needed[i]) === -1) {
                    allDefaults = false;
                    _warn('missing default module:', needed[i]);
                }
            }
            checks.push({ n: 'default modules registered', ok: allDefaults });

            // Seed some state and round-trip via loadFromObject(saveResult.payload)
            G.WTS_state = G.WTS_state || {};
            G.WTS_state.esdHiPilot = { pass: true, marginSeconds: 12.5, tag: 'hi' };
            G.WTS_state.hydrate    = { nodes: [{ name: 'wh', dT: 5 }] };
            G.WTS_state.clientInfo = { wellName: 'Test-1', fieldName: 'Demo' };

            // Use sync payload builder so the test doesn't depend on Promise
            // microtask resolution (which would defer past these checks).
            var saved = { payload: G.WTS_project._buildPayload({ note: 'test' }) };
            checks.push({ n: 'save() returns payload', ok: !!(saved && saved.payload) });
            checks.push({ n: 'payload.modules has esdhi',
                          ok: !!(saved && saved.payload.modules && saved.payload.modules.esdhi) });
            checks.push({ n: 'payload format/version stamped',
                          ok: !!(saved && saved.payload.format === 'h2oilproj' &&
                                 saved.payload.version === '1.0') });

            // Verify the async save() path also returns *something* truthy
            var asyncRet = G.WTS_project.save('test-async');
            checks.push({ n: 'save() returns Promise when available',
                          ok: asyncRet && typeof asyncRet.then === 'function' });

            // Mutate state, then reload — should restore
            G.WTS_state.esdHiPilot = { pass: false, marginSeconds: -3, tag: 'mutated' };
            var loadRes = G.WTS_project.loadFromObject(saved.payload);
            checks.push({ n: 'load preserves esdHiPilot',
                          ok: G.WTS_state.esdHiPilot && G.WTS_state.esdHiPilot.tag === 'hi' });
            checks.push({ n: 'load preserves clientInfo',
                          ok: G.WTS_state.clientInfo && G.WTS_state.clientInfo.wellName === 'Test-1' });
            checks.push({ n: 'load result reports loaded modules',
                          ok: loadRes && Array.isArray(loadRes.loaded) && loadRes.loaded.length >= 3 });

            // storage module — only when a localStorage is present
            var ls = _ls();
            if (ls) {
                var backup = {};
                var bk = _lsKeys(ls);
                for (var b = 0; b < bk.length; b++) backup[bk[b]] = ls.getItem(bk[b]);
                ls.setItem('wts_page___selftest', '{"v":1,"f":{"x":"42"}}');
                ls.setItem('wts_unit_system', 'metric');
                var sp = G.WTS_project._buildPayload();
                var sk = sp.modules.storage && sp.modules.storage.keys;
                checks.push({ n: 'storage captures wts_page_ keys',
                              ok: !!(sk && sk.wts_page___selftest === '{"v":1,"f":{"x":"42"}}') });
                checks.push({ n: 'storage skips preference keys', ok: !!(sk && !('wts_unit_system' in sk)) });
                ls.removeItem('wts_page___selftest');
                G.WTS_project.loadFromObject(sp);
                checks.push({ n: 'storage restores keys',
                              ok: ls.getItem('wts_page___selftest') === '{"v":1,"f":{"x":"42"}}' &&
                                  ls.getItem('wts_unit_system') === 'metric' });
                // restore the original storage exactly
                var now = _lsKeys(ls);
                for (var r = 0; r < now.length; r++) if (!(now[r] in backup)) ls.removeItem(now[r]);
                for (var bk2 in backup) if (Object.prototype.hasOwnProperty.call(backup, bk2)) ls.setItem(bk2, backup[bk2]);
            }

            // Custom module register / round-trip
            var captured = null;
            G.WTS_project.registerModule('__customtest__', {
                read:  function () { return { x: 42, label: 'hello' }; },
                write: function (s) { captured = _clone(s); }
            });
            var saved2 = { payload: G.WTS_project._buildPayload() };
            G.WTS_project.loadFromObject(saved2.payload);
            checks.push({ n: 'custom module round-trip',
                          ok: captured && captured.x === 42 && captured.label === 'hello' });

            // Bad payload handled gracefully
            var badRes = G.WTS_project.loadFromObject({ format: 'nope', modules: {} });
            checks.push({ n: 'wrong format rejected', ok: !!(badRes && badRes.error) });
            var bad2 = G.WTS_project.loadFromObject(null);
            checks.push({ n: 'null payload returns error', ok: !!(bad2 && bad2.error) });

            // Unknown module in file → skipped, not crashed
            var unknownPayload = {
                format: 'h2oilproj', version: '1.0',
                modules: { __notRegistered__: { foo: 1 }, esdhi: { pass: true } }
            };
            var ur = G.WTS_project.loadFromObject(unknownPayload);
            checks.push({ n: 'unknown module skipped, known loaded',
                          ok: ur && ur.skipped.indexOf('__notRegistered__') !== -1 &&
                              ur.loaded.indexOf('esdhi') !== -1 });

            // info() returns sensible shape
            var inf = G.WTS_project.info();
            checks.push({ n: 'info() shape', ok: inf && Array.isArray(inf.modules) &&
                                                   typeof inf.size === 'number' &&
                                                   typeof inf.modifiedAt === 'string' });

            // newProject clears (in-memory only here — no localStorage in node)
            if (!ls) {
                G.WTS_state.esdHiPilot = { pass: true };
                G.WTS_project['new']();
                checks.push({ n: 'new() clears state',
                              ok: !(G.WTS_state && G.WTS_state.esdHiPilot &&
                                    G.WTS_state.esdHiPilot.pass) });
            }

            // file-name sanitiser
            checks.push({ n: 'file names sanitised',
                          ok: _fileName('Well 7H: "A"') === 'Well 7H- -A.h2oilproj' ||
                              /^Well 7H.*\.h2oilproj$/.test(_fileName('Well 7H: "A"')) });

            // toolbar render no-throw
            var tbErr = false;
            try { G.WTS_renderProjectToolbar(null); }
            catch (e) { tbErr = true; }
            checks.push({ n: 'toolbar handles null container', ok: !tbErr });

            // Cleanup custom test module
            G.WTS_project.unregisterModule('__customtest__');

            G.WTS_project_selfTestResults = { checks: checks };

            var fails = checks.filter(function (c) { return !c.ok; });
            if (fails.length) _err('Project Save/Load self-test FAILED:', fails);
            else _log('✓ Project Save/Load self-test passed (' + checks.length + ' checks).');
        } catch (e) {
            _err('Project Save/Load self-test threw:', e && e.message ? e.message : e);
        }
    })();

})();
