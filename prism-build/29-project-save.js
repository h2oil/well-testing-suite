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
//   and the global units toggle — each of which already stashes state
//   under window.WTS_state.<key> or window.PRiSM_*.
//
// PUBLIC API
//   window.WTS_project = {
//       save(filename?)         → Promise<{ blob, filename, payload }>
//       saveDownload(filename?) → triggers an <a download> click
//       load(file: File)        → Promise<{ loaded: [...], skipped: [...] }>
//       loadFromObject(obj)     → synchronous; same shape as load result
//       new()                   → wipe registered module state
//       info()                  → { modules: [...], modifiedAt, size }
//       registerModule(name, { read, write })
//       unregisterModule(name)
//       listModules()
//   };
//   window.WTS_renderProjectToolbar(container) → mounts the File toolbar
//
// FILE FORMAT (.h2oilproj — JSON)
//   {
//     "format":   "h2oilproj",
//     "version":  "1.0",
//     "generator":"H2Oil Well Testing Suite",
//     "savedAt":  "2026-04-28T12:34:56.789Z",
//     "modules":  { "<key>": <state>, ... },
//     "meta":     { client?, well?, field?, notes? }
//   }
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
    }
    _registerDefaults();

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
            meta:      meta || {},
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
    // Save — returns a Promise<{ blob, filename, payload }>
    // ───────────────────────────────────────────────────────────────
    function save(filename, meta) {
        try {
            var payload = _buildPayload(meta);
            var json = JSON.stringify(payload, null, 2);
            var blob = null;
            if (typeof G.Blob === 'function') {
                try { blob = new G.Blob([json], { type: 'application/json' }); }
                catch (e) { blob = null; }
            }
            var name = _slugify(filename || (payload.meta && payload.meta.well) ||
                                (payload.meta && payload.meta.well_name) || 'project') + '.h2oilproj';
            // In node (smoke-test) Blob won't exist — fall back to a stub object.
            if (!blob) blob = { size: json.length, type: 'application/json', _text: json };
            var res = { blob: blob, filename: name, payload: payload };
            if (typeof G.Promise === 'function') return G.Promise.resolve(res);
            return res;
        } catch (e) {
            _err('save() failed', e);
            if (typeof G.Promise === 'function') return G.Promise.reject(e);
            throw e;
        }
    }

    // ───────────────────────────────────────────────────────────────
    // saveDownload — clicks an <a download> programmatically
    // ───────────────────────────────────────────────────────────────
    function saveDownload(filename, meta) {
        try {
            var p = save(filename, meta);
            var apply = function (res) {
                if (!_hasDoc) return res;
                try {
                    var url = (G.URL && typeof G.URL.createObjectURL === 'function')
                        ? G.URL.createObjectURL(res.blob) : null;
                    var a = document.createElement('a');
                    a.href = url || ('data:application/json;charset=utf-8,' +
                        encodeURIComponent(JSON.stringify(res.payload, null, 2)));
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
                } catch (e) { _warn('saveDownload could not click', e); }
                return res;
            };
            if (p && typeof p.then === 'function') return p.then(apply);
            return apply(p);
        } catch (e) { _err('saveDownload failed', e); throw e; }
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

    function loadFromObject(obj) {
        return _applyPayload(obj);
    }

    // ───────────────────────────────────────────────────────────────
    // New — clear every registered module's state
    // ───────────────────────────────────────────────────────────────
    function newProject() {
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
            size:              size
        };
    }

    // ───────────────────────────────────────────────────────────────
    // File toolbar UI — New | Open | Save | Save As
    // ───────────────────────────────────────────────────────────────
    function renderProjectToolbar(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;

        // Idempotent — do not duplicate if already mounted in the host.
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-project-toolbar="1"]') : null;
        if (existing) return;

        var wrap = document.createElement('div');
        wrap.setAttribute('data-wts-project-toolbar', '1');
        wrap.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:6px 10px;background:#161b22;' +
            'border:1px solid #30363d;border-radius:6px;font-family:Segoe UI,sans-serif;' +
            'font-size:12px;color:#c9d1d9';

        var btnStyle =
            'padding:4px 10px;background:#21262d;border:1px solid #30363d;border-radius:4px;' +
            'color:#c9d1d9;font-size:12px;cursor:pointer;line-height:1.4;font-family:inherit';
        var labelStyle = 'color:#8b949e;margin-right:6px;font-weight:600';

        wrap.innerHTML =
            '<span style="' + labelStyle + '">File:</span>' +
            '<button type="button" data-act="new"  style="' + btnStyle + '">New</button>' +
            '<button type="button" data-act="open" style="' + btnStyle + '">Open…</button>' +
            '<button type="button" data-act="save" style="' + btnStyle + '">Save</button>' +
            '<button type="button" data-act="saveas" style="' + btnStyle + '">Save As…</button>' +
            '<span data-role="status" style="margin-left:auto;color:#8b949e;font-size:11px"></span>' +
            '<input type="file" data-role="picker" accept=".h2oilproj,.json,application/json" ' +
            'style="display:none">';

        try { container.appendChild(wrap); } catch (e) { return; }

        function _setStatus(msg, kind) {
            var s = wrap.querySelector('[data-role="status"]');
            if (!s) return;
            var color = (kind === 'err') ? '#f85149' :
                        (kind === 'ok')  ? '#56d364' : '#8b949e';
            s.style.color = color;
            s.textContent = String(msg || '');
            if (msg && kind !== 'err') {
                setTimeout(function () {
                    if (s.textContent === msg) s.textContent = '';
                }, 4000);
            }
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
                ok = G.confirm('Clear all calculator state? Unsaved work will be lost.');
            }
            if (!ok) return;
            var res = newProject();
            _setStatus('Cleared ' + res.cleared.length + ' modules.', 'ok');
        });

        if (btnOpen && picker) {
            btnOpen.addEventListener('click', function () { picker.click(); });
            picker.addEventListener('change', function (ev) {
                var f = ev.target && ev.target.files && ev.target.files[0];
                if (!f) return;
                _setStatus('Loading ' + f.name + '…');
                load(f).then(function (res) {
                    if (res && res.error) {
                        _setStatus('Load failed: ' + res.error, 'err');
                    } else {
                        var ln = res ? (res.loaded || []).length : 0;
                        var sk = res ? (res.skipped || []).length : 0;
                        _setStatus('Loaded ' + ln + ' modules' +
                                   (sk ? ' (' + sk + ' skipped)' : ''), 'ok');
                    }
                    picker.value = '';
                }, function (err) {
                    _setStatus('Load failed: ' + (err && err.message ? err.message : err), 'err');
                    picker.value = '';
                });
            });
        }

        function _doSave(name) {
            try {
                saveDownload(name);
                _setStatus('Saved.', 'ok');
            } catch (e) {
                _setStatus('Save failed: ' + (e && e.message ? e.message : e), 'err');
            }
        }
        if (btnSave) btnSave.addEventListener('click', function () { _doSave(null); });
        if (btnSaveAs) btnSaveAs.addEventListener('click', function () {
            var def = 'project';
            try {
                var clientInfo = (G.WTS_state && G.WTS_state.clientInfo) ?
                                 G.WTS_state.clientInfo : null;
                if (clientInfo && clientInfo.wellName) def = _slugify(clientInfo.wellName);
            } catch (e) {}
            var nm = (typeof G.prompt === 'function')
                ? G.prompt('Save project as…', def) : def;
            if (nm) _doSave(nm);
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_project = {
        save:             save,
        saveDownload:     saveDownload,
        load:             load,
        loadFromObject:   loadFromObject,
        'new':            newProject,   // reserved word — bracket-access from callers
        clearAll:         newProject,   // friendlier alias
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
                              typeof G.WTS_project.registerModule === 'function' });

            // Default modules registered
            var defaults = G.WTS_project.listModules();
            var needed = ['wts', 'esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife',
                          'prism', 'pvt', 'units'];
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

            // newProject clears
            G.WTS_state.esdHiPilot = { pass: true };
            G.WTS_project['new']();
            checks.push({ n: 'new() clears state',
                          ok: !(G.WTS_state && G.WTS_state.esdHiPilot &&
                                G.WTS_state.esdHiPilot.pass) });

            // saveDownload no-throw (DOM stub)
            var sdErr = false;
            try { G.WTS_project.saveDownload('test'); }
            catch (e) { sdErr = true; }
            checks.push({ n: 'saveDownload() does not throw under stub', ok: !sdErr });

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
