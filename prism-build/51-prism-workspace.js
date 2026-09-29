// =============================================================================
// PRiSM — 51-prism-workspace.js  (Round 8)
// -----------------------------------------------------------------------------
// Model & fit workspace (ROADMAP §2.1 N1):
//
//   • Fit library — save the current fit (C4 PRiSM_getLastFit) under a name.
//     Saved fits are stamped with the dataset hash, so the library is per
//     dataset; they live in PRiSM_state.fits (C8 wts_prism_state, and the
//     'prism' project-file module, which already carries st.fits) and the
//     report's model-comparison table lists them.
//   • Compare — pick saved fits; their model curves are drawn over the
//     log-log, semilog (MDH / Horner), history and rate–time plots by a
//     post-draw hook (C6/C7), and a table lists k, kh, S, C, xf / Lh,
//     boundary distances, pi, rinv, R², AIC, ΔAIC with 95 % CIs.
//   • Named analysis branches — duplicate the current analysis state (model,
//     parameters, fit, match, flow period, well & test inputs, rate table)
//     under a name and switch between branches. A switch goes through the
//     C7 events, so the workflow undo stack (37) records it: Ctrl+Z returns
//     to the state before the switch.
//   • Model browser — plain-language name, what the model is, what its
//     derivative looks like and search synonyms for every registry model;
//     ranked search (PRiSM_searchModels). The Tab 3 library search uses the
//     same terms (PRiSM_modelSearchTerms).
//
// PUBLIC API (window.*)
//   PRiSM_saveFit(name?, opts?) → record | {ok:false, reason}
//   PRiSM_listFits({all?}) / PRiSM_getFit(id) / PRiSM_removeFit(id) / PRiSM_renameFit(id, name)
//   PRiSM_adoptFit(id)                       make a saved fit the current fit (C4 order)
//   PRiSM_setFitCompare(ids[]) / PRiSM_getFitCompare() / PRiSM_toggleFitCompare(id)
//   PRiSM_setFitOverlay(bool)                show compared fits on the plots
//   PRiSM_fitCompareTable(ids?)              → {ok, rows[], bestAic}
//   PRiSM_fitOverlayCurve(id, plotKey?)      → {t, dp, deriv, p} | {tDays, q}
//   PRiSM_createBranch(name?) / PRiSM_switchBranch(id) / PRiSM_renameBranch(id, name)
//   PRiSM_deleteBranch(id) / PRiSM_listBranches() / PRiSM_activeBranch()
//   PRiSM_modelPlainInfo(key) / PRiSM_searchModels(query, {mode}) / PRiSM_modelSearchTerms(key)
//   PRiSM_renderFitWorkspacePanel(host, {compact}) / PRiSM_renderModelBrowserPanel(host)
//
// STATE (C8): st.fits [records], st.fitWorkspace {compare[], overlay},
//   st.branches {active, list[{id, name, createdAt, updatedAt, datasetHash, state}]}.
// EVENTS fired: prism:fits-changed, prism:branch-changed, and on a branch
//   switch the C7 prism:model-changed / well-changed / period-changed /
//   fit-updated with source 'branch'.
//
// CONVENTIONS — single outer IIFE, window.PRiSM_* names, no timers, no
//   polling, no function wrapping; cross-module calls are typeof-guarded.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;
    var MAX_FITS = 60, MAX_BRANCHES = 20, MAX_COMPARE = 6;
    // Distinct from the plot theme (orange data, green derivative, blue model, purple guides).
    var COLORS = ['#ff7b72', '#e3b341', '#56d4dd', '#ff9bce', '#d2a8ff', '#a5d6ff'];

    // =========================================================================
    // SECTION 1 — HELPERS
    // =========================================================================
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isPos(v) { return isNum(v) && v > 0; }
    function isArr(a) { return !!a && typeof a !== 'string' && typeof a.length === 'number'; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try {
            return JSON.parse(JSON.stringify(v, function (k, x) {
                if (typeof x === 'function') return undefined;
                if (typeof x === 'number' && !isFinite(x)) return null;
                return x;
            }));
        } catch (e) { return null; }
    }
    function str(v, max) {
        if (v == null) return '';
        var s = String(v).replace(/[\u0000-\u001f]+/g, ' ').trim();
        return s.length > (max || 80) ? s.slice(0, max || 80) : s;
    }
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e7 || a < 1e-3) return v.toExponential((sig || 4) - 1);
        return String(+v.toPrecision(sig || 4));
    }
    function $(id) { try { return D && D.getElementById ? D.getElementById(id) : null; } catch (e) { return null; } }
    function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
    function uid(prefix) {
        var t = 0; try { t = Date.now(); } catch (e) { t = 0; }
        return prefix + t.toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    }
    function st() {
        if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
        return G.PRiSM_state;
    }
    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var CE = G.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
            if (CE) G.dispatchEvent(new CE(type, { detail: detail || {} }));
        } catch (e) { /* a listener threw — never break the caller */ }
    }
    function on(type, fn) { try { if (typeof G.addEventListener === 'function') G.addEventListener(type, fn); } catch (e) { /* stub */ } }
    function save() { if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* storage optional */ } } }
    function dsHash() { try { return typeof G.PRiSM_datasetHash === 'function' ? G.PRiSM_datasetHash() : null; } catch (e) { return null; } }
    function models() { return G.PRiSM_MODELS || {}; }
    function modelName(key) {
        if (typeof G.PRiSM_modelDisplayName === 'function') { try { return G.PRiSM_modelDisplayName(key); } catch (e) { /* fall back */ } }
        var P = PLAIN[key];
        return (P && P.name) || String(key || '');
    }
    function redraw() { if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } } }
    function logspace(a, b, n) {
        var out = [], la = Math.log(a), lb = Math.log(b);
        for (var i = 0; i < n; i++) out.push(Math.exp(la + (lb - la) * i / (n - 1)));
        return out;
    }
    function adOpts() {
        var s = st();
        var o = { timeFn: s.timeFn || 'auto', L: isNum(s.bourdetL) ? s.bourdetL : 0.15 };
        if (s.activePeriod != null && s.activePeriod >= 0) o.period = s.activePeriod;
        return o;
    }
    function analysisData() {
        if (typeof G.PRiSM_getAnalysisData !== 'function' || !G.PRiSM_dataset) return null;
        try { return G.PRiSM_getAnalysisData(G.PRiSM_dataset, adOpts()); } catch (e) { return null; }
    }

    // =========================================================================
    // SECTION 2 — MODEL BROWSER: PLAIN-LANGUAGE METADATA + SEARCH
    // =========================================================================
    // [what the model is, what the derivative looks like, search synonyms]
    var PLAIN_RAW = {
        homogeneous: ['Single vertical well in a uniform, infinite reservoir.', 'Unit-slope storage hump, then a flat derivative (radial flow).', 'uniform infinite acting radial vertical standard basic'],
        infiniteFrac: ['Vertical well with a hydraulic fracture of very high conductivity.', 'Half-slope derivative (linear flow) before the radial-flow flat line.', 'hydraulic fracture frac fractured stimulated linear half slope'],
        finiteFrac: ['Hydraulic fracture whose conductivity limits the flow along it.', 'Quarter-slope derivative (bilinear flow), then half-slope, then flat.', 'bilinear quarter slope frac conductivity fcd fracture'],
        finiteFracSkin: ['Finite-conductivity fracture with damage on the fracture face.', 'Like the finite-conductivity fracture, with an early hump from the face skin.', 'fracture face skin choked damaged frac'],
        partialPenFrac: ['Fracture that covers only part of the pay thickness.', 'Linear flow, then a spherical (−½ slope) transition, then flat.', 'partially penetrating fracture limited height frac'],
        inclined: ['Deviated (slanted) well crossing the pay.', 'Derivative dips early (negative geometric skin), then flat.', 'slanted deviated inclined directional'],
        horizontal: ['Horizontal well between an upper and a lower no-flow boundary.', 'Early radial flow, then linear flow (half slope), then late radial flow.', 'lateral horizontal hz long well'],
        linearBoundary: ['Well near one straight fault: sealing, or constant pressure.', 'Flat, then the derivative doubles (sealing) or falls away (constant pressure).', 'fault sealing no flow boundary barrier single fault doubling constant pressure aquifer gas cap'],
        parallelChannel: ['Well between two parallel sealing faults (a channel).', 'Flat, then a half-slope rise (linear flow along the channel).', 'channel parallel faults fluvial elongated'],
        closedChannel3: ['Channel closed at one end (three sealing faults, U shape).', 'Half-slope rise from the channel, steepening once the closed end is felt.', 'u shape three faults closed channel'],
        closedRectangle: ['Closed rectangular reservoir (four sealing faults).', 'Flat, then a unit slope at late time (pseudo-steady state, depletion).', 'closed bounded compartment depletion pseudo steady state box tank'],
        intersecting: ['Well inside a wedge formed by two intersecting faults.', 'Flat, then a higher flat level set by the wedge angle.', 'wedge intersecting faults angle corner'],
        fogBoundary: ['Fault that leaks (partially communicating).', 'Rises like a fault, then returns towards the first flat level.', 'leaky fault partially sealing semi permeable communicating'],
        doublePorosity: ['Naturally fractured reservoir: fractures fed by the matrix blocks.', 'A dip (valley) in the derivative between two flat levels.', 'naturally fractured dual porosity double porosity fissured matrix valley'],
        partialPen: ['Well completed over only part of the pay thickness.', 'Early radial flow, a spherical (−½ slope) section, then full-thickness radial flow.', 'limited entry partial completion partial penetration spherical'],
        verticalPulse: ['Vertical interference between an active and an observation interval.', 'Observation response delayed by the vertical permeability.', 'vertical interference kv vertical permeability pulse'],
        twoLayerXF: ['Two layers with crossflow between them.', 'A dip like dual porosity while the layers equalise.', 'two layer crossflow layered'],
        radialComposite: ['Inner zone round the well with other properties (injection bank, damaged or stimulated zone).', 'Flat, then a second flat level: higher for a poorer outer zone, lower for a better one.', 'composite injection front water bank inner zone mobility change'],
        multiLayerXF: ['Several layers with crossflow.', 'Transitions between layer behaviours, then total-kh radial flow.', 'multilayer crossflow layers'],
        multiLayerNoXF: ['Several commingled layers without crossflow.', 'Layer transitions; layers can deplete at different rates.', 'commingled multilayer no crossflow layers'],
        linearComposite: ['Property change across a straight line (facies change, fluid contact).', 'Flat, then a new level set by the mobility contrast.', 'linear composite facies change contact mobility contrast'],
        genHetRadialLinear: ['Heterogeneous radial zones next to a straight boundary.', 'Composite levels combined with a fault response.', 'heterogeneous composite fault'],
        genHetRadial: ['Three concentric radial zones.', 'Up to three flat derivative levels.', 'heterogeneous three zones radial zones'],
        interference: ['Observation well responding to an active well (interference test).', 'Delayed response following the line-source curve.', 'interference observation well line source pulse'],
        mlHorizontalXF: ['Horizontal well in a layered reservoir with crossflow.', 'Horizontal-well regimes modified by the layering.', 'horizontal multilayer lateral'],
        mlNoXFFrac: ['Fractured well in commingled layers.', 'Fracture linear flow in each layer, then commingled radial flow.', 'fractured multilayer commingled'],
        mlNoXFHoriz: ['Horizontal well in commingled layers.', 'Layer-by-layer horizontal responses added together.', 'horizontal commingled multilayer'],
        inclinedMLXF: ['Inclined well through layers with crossflow.', 'Deviated-well dip with layer transitions.', 'inclined multilayer deviated'],
        multiLatMLXF: ['Multilateral well in a layered reservoir.', 'Several laterals interact; linear-flow features.', 'multilateral fishbone laterals'],
        mlMultiPerf: ['Layers produced through several perforated intervals.', 'Partial-penetration features for each interval.', 'multiple perforations selective completion intervals'],
        mlHorizInterference: ['Interference between horizontal wells in a layered reservoir.', 'Delayed observation response.', 'interference horizontal'],
        mlMultiPerfInterference: ['Interference between perforated intervals.', 'Vertical interference across the layers.', 'interval interference vertical'],
        inclinedInterference: ['Interference from an inclined active well.', 'Delayed observation response.', 'inclined interference'],
        linearCompInterference: ['Interference across a straight property change.', 'Delayed response altered by the mobility contrast.', 'linear composite interference'],
        linearCompMultiLat: ['Multilateral well in a linear composite reservoir.', 'Lateral features plus a mobility level change.', 'multilateral composite'],
        linearCompMultiLatInterference: ['Interference from a multilateral well across a linear composite.', 'Delayed observation response.', 'multilateral interference'],
        generalMLNoXF: ['General commingled multilayer reservoir (any number of layers).', 'Layer transitions without crossflow.', 'general multilayer commingled'],
        mlInterferenceXF: ['Interference through layers with crossflow.', 'Delayed observation response through the layers.', 'layered interference crossflow'],
        radialCompInterference: ['Interference across a radial composite boundary.', 'Delayed response with a mobility level change.', 'composite interference'],
        userDefined: ['Your own type curve from a loaded table.', 'Any shape: matched as entered.', 'custom user table own'],
        waterInjection: ['Water injection with a moving two-phase front.', 'The fall-off derivative changes as the front moves (composite-like).', 'water injection front two phase falloff injector'],
        arps: ['Arps rate decline: exponential, hyperbolic or harmonic.', 'Rate falls with a constant or slowing decline; b sets the curvature.', 'decline arps hyperbolic exponential harmonic eur forecast'],
        duong: ['Duong decline for long linear (fracture-dominated) flow.', 'Rate close to a straight line on log-log at early time.', 'duong shale unconventional fracture dominated decline'],
        sepd: ['Stretched-exponential decline.', 'Decline slows smoothly with a bounded EUR.', 'stretched exponential sepd unconventional decline'],
        fetkovich: ['Fetkovich decline type curve (transient plus boundary-dominated).', 'Transient stems join the Arps depletion stems.', 'fetkovich type curve decline']
    };
    var PLAIN = {};
    Object.keys(PLAIN_RAW).forEach(function (k) {
        var r = PLAIN_RAW[k];
        PLAIN[k] = { plain: r[0], signature: r[1], synonyms: r[2] };
    });

    function modelPlainInfo(key) {
        var e = models()[key];
        if (!e) return null;
        var p = PLAIN[key] || {};
        var cat = String(e.category || 'other');
        return {
            key: key, name: modelName(key), category: cat, kind: e.kind === 'rate' ? 'rate' : 'pressure',
            plain: p.plain || String(e.description || ''), signature: p.signature || '',
            synonyms: p.synonyms ? p.synonyms.split(/\s+/) : [],
            description: String(e.description || ''), reference: String(e.reference || ''),
            params: (e.paramSpec || []).filter(function (s) { return s && s.key && s.key.indexOf('__') !== 0; })
                .map(function (s) { return { key: s.key, label: s.label || s.key, unit: s.unit || '' }; })
        };
    }
    function modelSearchTerms(key) {
        var i = modelPlainInfo(key);
        if (!i) return '';
        return [i.plain, i.signature, i.synonyms.join(' ')].join(' ').toLowerCase();
    }
    // Tie-break: the models most often used first (small bonus).
    var COMMON = { homogeneous: 0.9, linearBoundary: 0.8, infiniteFrac: 0.7, doublePorosity: 0.7, closedRectangle: 0.6,
                   parallelChannel: 0.6, radialComposite: 0.5, finiteFrac: 0.5, horizontal: 0.5, partialPen: 0.4, arps: 0.4 };
    // Every token must match somewhere; score favours the name, then the
    // synonyms, the key and the category, then the descriptions.
    function searchModels(query, opts) {
        opts = opts || {};
        var toks = String(query || '').toLowerCase().replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/).filter(Boolean);
        var out = [];
        Object.keys(models()).forEach(function (k) {
            var i = modelPlainInfo(k);
            if (!i) return;
            if (opts.mode === 'transient' && i.kind === 'rate') return;
            if (opts.mode === 'decline' && i.kind !== 'rate') return;
            var name = i.name.toLowerCase(), syn = i.synonyms.join(' ').toLowerCase(), key = k.toLowerCase(), cat = i.category.toLowerCase();
            var text = (i.plain + ' ' + i.signature + ' ' + i.description + ' ' + i.reference).toLowerCase();
            var score = COMMON[k] || 0, all = true;
            var nameWords = name.split(/[^a-z0-9]+/);
            toks.forEach(function (t) {
                var s = 0;
                if (nameWords.indexOf(t) !== -1) s += 3;          // whole-word match in the name
                if (name.indexOf(t) !== -1) s += 5;
                if (syn.indexOf(t) !== -1) s += 4;
                if (key.indexOf(t) !== -1) s += 3;
                if (cat.indexOf(t) !== -1) s += 2;
                if (text.indexOf(t) !== -1) s += 1;
                if (!s) all = false;
                score += s;
            });
            if (!all) return;
            out.push({ key: k, name: i.name, plain: i.plain, signature: i.signature, category: i.category, kind: i.kind, score: score });
        });
        out.sort(function (a, b) { return (b.score - a.score) || a.name.localeCompare(b.name); });
        return out;
    }

    // =========================================================================
    // SECTION 3 — FIT LIBRARY
    // =========================================================================
    function fitsArr() {
        var s = st();
        if (!Array.isArray(s.fits)) s.fits = [];
        return s.fits;
    }
    function ws() {
        var s = st();
        if (!s.fitWorkspace || typeof s.fitWorkspace !== 'object') s.fitWorkspace = {};
        if (!Array.isArray(s.fitWorkspace.compare)) s.fitWorkspace.compare = [];
        if (s.fitWorkspace.overlay === undefined) s.fitWorkspace.overlay = true;
        return s.fitWorkspace;
    }
    function isRecord(r) { return !!(r && typeof r === 'object' && r.id && r.fit && typeof r.fit === 'object'); }
    function changed(what) {
        _curveCache = {};
        save();
        dispatch('prism:fits-changed', { what: what });
        rerenderAll();
        redraw();
    }

    function saveFit(name, opts) {
        opts = opts || {};
        var f = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { f = G.PRiSM_getLastFit(); } catch (e) { f = null; } }
        if (!f || !f.modelKey) return { ok: false, reason: 'No fit to save: run a regression, a type-curve match or the model race first.' };
        var entry = models()[f.modelKey];
        if (!entry) return { ok: false, reason: 'The fit\'s model "' + f.modelKey + '" is not in the model registry.' };
        var arr = fitsArr();
        var hash = f.datasetHash || dsHash();
        var nSame = arr.filter(function (r) { return isRecord(r) && r.datasetHash === hash; }).length;
        var nm = str(name, 60) || ('Fit ' + (nSame + 1) + ' — ' + modelName(f.modelKey));
        var fit = clone(f);
        delete fit.stale; delete fit.semilog;
        if (fit.bootstrap) fit.bootstrap = { n: fit.bootstrap.n, failures: fit.bootstrap.failures, ci: fit.bootstrap.ci };
        var well = null, ad = null;
        if (fit.kind !== 'rate') {
            try { well = clone(typeof G.PRiSM_getWell === 'function' ? G.PRiSM_getWell() : null); } catch (e) { well = null; }
            ad = analysisData();
        }
        var s = st();
        var rec = {
            id: uid('fit_'), name: nm, savedAt: nowIso(), datasetHash: hash,
            modelKey: f.modelKey, kind: fit.kind || 'pressure', source: fit.source || '',
            period: s.activePeriod == null ? null : s.activePeriod, timeFn: (ad && ad.ok) ? ad.timeFn : (s.timeFn || 'auto'),
            pseudo: !!(ad && ad.pseudo), pseudoTime: !!(ad && ad.pseudoTime),
            well: well, tcMatch: clone(s.tcMatch) || null, fit: fit,
            note: str(opts.note, 200)
        };
        if (fit.datasetHash && hash && dsHash() && fit.datasetHash !== dsHash()) rec.warning = 'The fit was made on another dataset.';
        arr.push(rec);
        while (arr.length > MAX_FITS) arr.shift();
        changed('saved');
        var out = clone(rec);
        out.ok = true;
        return out;
    }
    function listFits(opts) {
        opts = opts || {};
        var h = dsHash();
        return fitsArr().filter(function (r) { return isRecord(r) && (opts.all || !h || !r.datasetHash || r.datasetHash === h); }).map(clone);
    }
    function findFit(id) {
        var arr = fitsArr();
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
        return null;
    }
    function getFit(id) { return clone(findFit(id)); }
    function removeFit(id) {
        var arr = fitsArr(), n = arr.length;
        for (var i = arr.length - 1; i >= 0; i--) if (arr[i] && arr[i].id === id) arr.splice(i, 1);
        var w = ws();
        w.compare = w.compare.filter(function (x) { return x !== id; });
        if (arr.length !== n) { changed('removed'); return true; }
        return false;
    }
    function renameFit(id, name) {
        var r = findFit(id), nm = str(name, 60);
        if (!r || !nm) return false;
        r.name = nm;
        changed('renamed');
        return true;
    }
    // Make a saved fit the current fit. C4: st.params / phys / tcMatch are
    // adopted BEFORE PRiSM_setLastFit so listeners see a consistent state.
    function adoptFit(id) {
        var r = findFit(id);
        if (!r) return { ok: false, reason: 'Unknown fit.' };
        if (!models()[r.modelKey]) return { ok: false, reason: 'Model "' + r.modelKey + '" is not available.' };
        var s = st();
        if (s.model !== r.modelKey) {
            if (typeof G.PRiSM_setModel === 'function') { try { G.PRiSM_setModel(r.modelKey, { source: 'workspace' }); } catch (e) { s.model = r.modelKey; } }
            else s.model = r.modelKey;
        }
        s.params = clone(r.fit.params) || {};
        s.phys = clone(r.fit.phys) || null;
        if (r.tcMatch) s.tcMatch = clone(r.tcMatch);
        s.modelCurveData = null;
        var f = clone(r.fit);
        delete f.modelName;
        f.source = f.source || 'saved';
        if (typeof G.PRiSM_setLastFit === 'function') G.PRiSM_setLastFit(f);
        else { s.lastFit = f; dispatch('prism:fit-updated', { source: 'workspace' }); }
        rerenderAll();
        redraw();
        return { ok: true, id: id };
    }

    function setFitCompare(ids) {
        var w = ws();
        var ok = (ids || []).filter(function (id) { return !!findFit(id); });
        w.compare = ok.filter(function (x, i) { return ok.indexOf(x) === i; }).slice(0, MAX_COMPARE);
        changed('compare');
        return w.compare.slice();
    }
    function getFitCompare() { return ws().compare.slice(); }
    function toggleFitCompare(id) {
        var c = ws().compare.slice(), i = c.indexOf(id);
        if (i >= 0) c.splice(i, 1); else c.push(id);
        return setFitCompare(c);
    }
    function setFitOverlay(onOff) { ws().overlay = !!onOff; changed('overlay'); return ws().overlay; }

    // Compare table: k, kh, S, C, Cd, xf / Lh, boundary distances, pi, rinv,
    // R², RMSE, AIC, ΔAIC (to the best AIC in the table) with 95 % CIs.
    function ci(fit, key) {
        var c = fit && fit.ci95 && fit.ci95[key];
        return (isArr(c) && isNum(c[0]) && isNum(c[1])) ? [c[0], c[1]] : null;
    }
    function fitCompareTable(ids) {
        var recs = (ids && ids.length ? ids : getFitCompare()).map(findFit).filter(isRecord);
        if (!recs.length) recs = fitsArr().filter(function (r) { return isRecord(r) && (!dsHash() || !r.datasetHash || r.datasetHash === dsHash()); });
        var rows = recs.map(function (r, i) {
            var f = r.fit, ph = f.phys || {}, pa = f.params || {};
            var row = {
                id: r.id, name: r.name, model: r.modelKey, modelName: modelName(r.modelKey), kind: r.kind, mode: f.mode || '',
                color: COLORS[i % COLORS.length], savedAt: r.savedAt, datasetHash: r.datasetHash,
                r2: f.r2, rmse: f.rmse, aic: f.aic, converged: f.converged, n: f.nPoints || null
            };
            if (r.kind === 'rate') {
                ['qi', 'Di', 'b', 'q1', 'a', 'm', 'tau', 'n'].forEach(function (k) {
                    if (isNum(pa[k])) { row[k] = pa[k]; row[k + 'CI'] = ci(f, k); }
                });
            } else {
                row.k = ph.k; row.kCI = ci(f, 'k');
                row.kh = isNum(ph.kh) ? ph.kh : (isNum(ph.k) && r.well && isPos(r.well.h) ? ph.k * r.well.h : NaN);
                row.S = isNum(ph.S) ? ph.S : pa.S; row.SCI = ci(f, 'S');
                row.C = ph.C; row.CCI = ci(f, 'C');
                row.Cd = isNum(ph.Cd) ? ph.Cd : pa.Cd;
                if (isNum(ph.xf)) { row.xf = ph.xf; row.xfCI = ci(f, 'xf'); }
                if (isNum(ph.Lh)) { row.Lh = ph.Lh; row.LhCI = ci(f, 'Lh'); }
                row.pi = ph.pi; row.piCI = ci(f, 'pi');
                row.rinv = ph.rinv;
                var dist = ph.distances_ft && typeof ph.distances_ft === 'object' ? ph.distances_ft : {};
                row.boundaries = Object.keys(dist).filter(function (k) { return isNum(dist[k]); }).map(function (k) { return { key: k, ft: dist[k] }; });
            }
            return row;
        });
        var best = Infinity;
        rows.forEach(function (x) { if (isNum(x.aic) && x.aic < best) best = x.aic; });
        rows.forEach(function (x) { x.dAIC = (isNum(x.aic) && isNum(best)) ? x.aic - best : NaN; });
        return { ok: rows.length > 0, rows: rows, bestAic: isNum(best) ? best : NaN };
    }

    // ── Overlay curves ─────────────────────────────────────────────────────
    var _curveCache = {};
    function pressureCurve(r, ad) {
        if (typeof G.PRiSM_physicalModel !== 'function' || !ad || !ad.ok) return null;
        var f = r.fit, ph = f.phys || {};
        var phys = {}, k;
        var pa = f.params || {};
        for (k in pa) if (Object.prototype.hasOwnProperty.call(pa, k)) phys[k] = pa[k];
        for (k in ph) if (Object.prototype.hasOwnProperty.call(ph, k)) phys[k] = ph[k];
        var well = r.well || (typeof G.PRiSM_getWell === 'function' ? G.PRiSM_getWell() : null);
        var mode = f.mode === 'scale' ? 'scale' : (f.mode === 'physical' ? 'physical' : undefined);
        var pm;
        try { pm = G.PRiSM_physicalModel(r.modelKey, well, ad, { floatPi: !!(f.floatPi && isNum(ph.pi)), mode: mode }); } catch (e) { pm = null; }
        if (!pm || !pm.ok || typeof pm.dp !== 'function') return null;
        if (mode && pm.mode !== mode) return null;
        var tpos = ad.t.filter(isPos);
        if (!tpos.length) return null;
        var t = logspace(Math.min.apply(null, tpos) / 3, Math.max.apply(null, tpos) * 3, 90);
        var out = { t: t, dp: null, deriv: null, p: null, tStart: isNum(ad.tStart) ? ad.tStart : 0, tp: ad.tp };
        try { out.dp = Array.prototype.slice.call(pm.dp(t, phys)); } catch (e) { return null; }
        try { out.deriv = Array.prototype.slice.call(pm.deriv(t, phys)); } catch (e) { out.deriv = null; }
        try { out.p = typeof pm.p === 'function' ? Array.prototype.slice.call(pm.p(t, phys)) : null; } catch (e) { out.p = null; }
        return out;
    }
    function rateCurve(r) {
        var ds = G.PRiSM_dataset;
        if (!ds || !isArr(ds.t) || !ds.t.length) return null;
        var f = ((ds.timeUnit === 'd' || ds.timeUnit === 'days') ? 1 : 1 / 24);
        var tmax = 0;
        for (var i = 0; i < ds.t.length; i++) if (+ds.t[i] * f > tmax) tmax = +ds.t[i] * f;
        if (!(tmax > 0)) return null;
        var t = logspace(Math.max(tmax / 1e4, 1e-3), tmax * 1.2, 90);
        var q = null;
        if (typeof G.PRiSM_declineRate === 'function') { try { q = G.PRiSM_declineRate(r.modelKey, r.fit.params, t); } catch (e) { q = null; } }
        if (!q) {
            var e2 = models()[r.modelKey];
            try { q = e2 && typeof e2.pd === 'function' ? Array.prototype.slice.call(e2.pd(t, r.fit.params)) : null; } catch (e) { q = null; }
        }
        return q ? { tDays: t, q: q } : null;
    }
    function fitOverlayCurve(id, adIn) {
        var r = findFit(id);
        if (!isRecord(r)) return null;
        if (r.kind === 'rate') return rateCurve(r);
        var ad = adIn || analysisData();
        if (!ad || !ad.ok) return null;
        var key = [id, ad.hash, ad.periodIndex, ad.timeFn, ad.pseudoTime, ad.n, ad.tStart].join('|');
        if (_curveCache[key]) return _curveCache[key];
        var c = pressureCurve(r, ad);
        if (c) _curveCache[key] = c;
        return c;
    }

    // Post-draw hook: compared fits drawn over the active plot.
    var PRESSURE_KINDS = { loglog: 1, mdh: 1, horner: 1, history: 1 };
    var RATE_KEYS = { rateCart: 1, rateSemi: 1, rateLog: 1 };
    function polyline(ctx, ax, xs, ys, plot, xLog, yLog) {
        var started = false, n = 0;
        ctx.beginPath();
        for (var i = 0; i < xs.length; i++) {
            var x = xs[i], y = ys[i];
            if (!isNum(x) || !isNum(y) || (xLog && !(x > 0)) || (yLog && !(y > 0))) { started = false; continue; }
            var px = ax.toX(x), py = ax.toY(y);
            if (!isNum(px) || !isNum(py)) { started = false; continue; }
            if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); n++; }
        }
        if (n) ctx.stroke();
        return n;
    }
    function workspacePostDraw(info) {
        if (!info || !info.canvas || typeof info.canvas.getContext !== 'function') return;
        var w = ws();
        if (!w.overlay || !w.compare.length) return;
        var ax = info.axes || info.canvas._prismAxes;
        if (!ax || typeof ax.toX !== 'function' || typeof ax.toY !== 'function' || !ax.plot) return;
        var plotKey = info.plotKey || st().activePlot;
        var reg = (G.PRiSM_PLOT_REGISTRY || {})[plotKey] || {};
        var kind = reg.kind || (plotKey === 'bourdet' ? 'loglog' : plotKey === 'cartesian' ? 'history' : plotKey);
        var isRate = !!RATE_KEYS[plotKey];
        if (!PRESSURE_KINDS[kind] && !isRate) return;
        var ctx; try { ctx = info.canvas.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) return;
        var sx = ax.scaleX || {}, sy = ax.scaleY || {};
        var xLog = sx.kind === 'log' || !!ax.xLog, yLog = sy.kind === 'log' || !!ax.yLog;
        var plot = ax.plot;
        var ad = isRate ? null : analysisData();
        var legend = [];
        ctx.save();
        try {
            ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
            w.compare.forEach(function (id, i) {
                var r = findFit(id);
                if (!isRecord(r)) return;
                if ((r.kind === 'rate') !== isRate) return;
                var c = fitOverlayCurve(id, ad);
                if (!c) return;
                var col = COLORS[i % COLORS.length];
                ctx.strokeStyle = col; ctx.lineWidth = 1.6;
                var drawn = 0;
                if (isRate) drawn = polyline(ctx, ax, c.tDays, c.q, plot, xLog, yLog);
                else if (kind === 'loglog') {
                    drawn = polyline(ctx, ax, c.t, c.dp, plot, xLog, yLog);
                    if (c.deriv) {
                        if (ctx.setLineDash) ctx.setLineDash([5, 3]);
                        drawn += polyline(ctx, ax, c.t, c.deriv, plot, xLog, yLog);
                        if (ctx.setLineDash) ctx.setLineDash([]);
                    }
                } else if (c.p) {
                    var xs;
                    if (kind === 'horner') {
                        var tp = isPos(info.data && info.data.tp) ? info.data.tp : c.tp;
                        if (!isPos(tp)) return;
                        xs = c.t.map(function (x) { return (tp + x) / x; });
                    } else if (kind === 'history') xs = c.t.map(function (x) { return x + c.tStart; });
                    else xs = c.t;
                    drawn = polyline(ctx, ax, xs, c.p, plot, xLog, yLog);
                }
                if (drawn) legend.push({ name: r.name, color: col });
            });
        } catch (e) { /* drawing is best-effort */ }
        ctx.restore();
        if (legend.length) {
            ctx.save();
            ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            var y0 = plot.y + plot.h - 10 - (legend.length - 1) * 14;
            legend.forEach(function (l, k) {
                var y = y0 + k * 14;
                ctx.fillStyle = 'rgba(13,17,23,0.8)'; ctx.fillRect(plot.x + 4, y - 7, Math.min(plot.w - 8, 16 + 7 * l.name.length), 14);
                ctx.strokeStyle = l.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(plot.x + 8, y); ctx.lineTo(plot.x + 20, y); ctx.stroke();
                ctx.fillStyle = l.color; ctx.fillText(l.name, plot.x + 24, y);
            });
            ctx.restore();
        }
    }
    workspacePostDraw._prismId = 'workspace-fit-overlays';
    (function registerHook() {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === workspacePostDraw._prismId) { hooks[i] = workspacePostDraw; return; }
        hooks.push(workspacePostDraw);
    })();

    // =========================================================================
    // SECTION 4 — NAMED ANALYSIS BRANCHES
    // =========================================================================
    function branchesObj() {
        var s = st();
        if (!s.branches || typeof s.branches !== 'object' || !Array.isArray(s.branches.list)) s.branches = { active: null, list: [] };
        return s.branches;
    }
    function findBranch(id) {
        var b = branchesObj().list;
        for (var i = 0; i < b.length; i++) if (b[i] && b[i].id === id) return b[i];
        return null;
    }
    function captureState() {
        var s = st(), pvt = G.PRiSM_pvt, well = null;
        if (pvt && typeof pvt === 'object') {
            well = {};
            for (var k in pvt) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(pvt, k)) well[k] = pvt[k];
        }
        return clone({
            model: s.model == null ? null : s.model, params: s.params || {}, paramFreeze: s.paramFreeze || {},
            phys: s.phys || null, tcMatch: s.tcMatch || null, lastFit: s.lastFit || null,
            activePeriod: s.activePeriod == null ? null : s.activePeriod, timeFn: s.timeFn || null,
            bourdetL: isNum(s.bourdetL) ? s.bourdetL : null, gasOpts: s.gasOpts || null,
            well: well, multiRate: (G.PRiSM && Array.isArray(G.PRiSM.multiRate)) ? G.PRiSM.multiRate : []
        });
    }
    function stateSig(o) {
        try { return JSON.stringify([o.model, o.params, o.phys, o.tcMatch, o.lastFit && o.lastFit.timestamp, o.activePeriod, o.well, o.multiRate]); } catch (e) { return ''; }
    }
    function persistPvt() {
        try {
            var s = G.PRiSM_pvt;
            var ls = G.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (!s || !ls) return;
            var o = {};
            for (var k in s) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
            ls.setItem('wts_prism_pvt', JSON.stringify(o));
        } catch (e) { /* storage optional */ }
    }
    var _applying = false;
    function applyState(o) {
        var s = st();
        _applying = true;
        try {
            if (o.model != null) s.model = o.model;
            s.params = clone(o.params) || {};
            s.paramFreeze = clone(o.paramFreeze) || {};
            s.phys = clone(o.phys) || null;
            s.tcMatch = clone(o.tcMatch) || null;
            s.lastFit = clone(o.lastFit) || null;
            s.activePeriod = o.activePeriod == null ? null : o.activePeriod;
            if (o.timeFn) s.timeFn = o.timeFn;
            if (isNum(o.bourdetL)) s.bourdetL = o.bourdetL;
            s.gasOpts = clone(o.gasOpts) || s.gasOpts || null;
            s.modelCurve = null; s.modelCurveData = null;
            if (isArr(o.multiRate)) {
                if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
                G.PRiSM.multiRate = clone(o.multiRate) || [];
                try { if (G.localStorage) G.localStorage.setItem('wts_prism_mrate', JSON.stringify(G.PRiSM.multiRate)); } catch (e) { /* ignore */ }
                try { if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows(); } catch (e) { /* host-scope helper (07) */ }   // eslint-disable-line no-undef
            }
            if (o.well && typeof o.well === 'object') {
                var pvt = G.PRiSM_pvt || (G.PRiSM_pvt = {});
                Object.keys(pvt).forEach(function (k) { if (k !== '_computed' && !(k in o.well)) delete pvt[k]; });
                Object.keys(o.well).forEach(function (k) { pvt[k] = clone(o.well[k]); });
                if (typeof G.PRiSM_pvt_compute === 'function') { try { G.PRiSM_pvt_compute(); } catch (e) { /* ignore */ } }
                persistPvt();
            }
            if (s.lastFit && typeof G.PRiSM_interpretCurrentFit === 'function') {
                try { s.interp = G.PRiSM_interpretCurrentFit() || null; } catch (e) { /* ignore */ }
            } else if (!s.lastFit) s.interp = null;
            if (typeof G.PRiSM_evalModelCurve === 'function') { try { G.PRiSM_evalModelCurve(s.model, s.params); } catch (e) { /* ignore */ } }
        } finally { _applying = false; }
        save();
        // C7 events (source 'branch'): panels refresh and the workflow undo
        // stack records the new state, so undo returns to the previous one.
        dispatch('prism:model-changed', { source: 'branch', modelKey: s.model });
        dispatch('prism:well-changed', { source: 'branch' });
        dispatch('prism:period-changed', { source: 'branch', period: s.activePeriod });
        dispatch('prism:fit-updated', { source: 'branch' });
        redraw();
        try {
            var tab = G.PRiSM && G.PRiSM.tab;
            var rt = (typeof PRiSM_renderTab === 'function') ? PRiSM_renderTab : G.PRiSM_renderTab;   // eslint-disable-line no-undef
            if (tab && typeof rt === 'function' && $('prism_tab_' + tab)) rt(tab);
        } catch (e) { /* ignore */ }
        if (typeof G.PRiSM_renderRail === 'function' && $('prism_rail')) { try { G.PRiSM_renderRail($('prism_rail')); } catch (e) { /* ignore */ } }
    }
    function recordUndo(reason) { if (typeof G.PRiSM_recordSnapshot === 'function') { try { G.PRiSM_recordSnapshot(reason); } catch (e) { /* ignore */ } } }

    function createBranch(name, opts) {
        opts = opts || {};
        var b = branchesObj();
        if (b.list.length >= MAX_BRANCHES) return { ok: false, reason: 'At most ' + MAX_BRANCHES + ' branches: delete one first.' };
        var cur = captureState(), t = nowIso(), h = dsHash();
        if (!b.list.length) {
            // The analysis so far becomes the "Main" branch, so it can be switched back to.
            b.list.push({ id: uid('br_'), name: 'Main', createdAt: t, updatedAt: t, datasetHash: h, state: cur });
            b.active = b.list[0].id;
        } else {
            var act = findBranch(b.active);
            if (act) { act.state = cur; act.updatedAt = t; act.datasetHash = h; }
        }
        var nm = str(name, 60) || ('Branch ' + (b.list.length + 1));
        var nb = { id: uid('br_'), name: nm, createdAt: t, updatedAt: t, datasetHash: h, state: clone(cur), from: b.active };
        b.list.push(nb);
        b.active = nb.id;
        save();
        dispatch('prism:branch-changed', { action: 'created', id: nb.id });
        rerenderAll();
        return { ok: true, id: nb.id, name: nm };
    }
    function switchBranch(id) {
        var b = branchesObj();
        var target = findBranch(id);
        if (!target) return { ok: false, reason: 'Unknown branch.' };
        if (b.active === id) return { ok: true, id: id, unchanged: true };
        var act = findBranch(b.active);
        recordUndo('branch');                   // the current state is the undo point
        if (act) { act.state = captureState(); act.updatedAt = nowIso(); act.datasetHash = dsHash(); }
        b.active = id;
        var warn = (target.datasetHash && dsHash() && target.datasetHash !== dsHash()) ? 'This branch was saved on another dataset: its fit is marked stale.' : null;
        applyState(target.state || {});
        dispatch('prism:branch-changed', { action: 'switched', id: id });
        rerenderAll();
        return { ok: true, id: id, warning: warn };
    }
    function renameBranch(id, name) {
        var br = findBranch(id), nm = str(name, 60);
        if (!br || !nm) return false;
        br.name = nm;
        save(); rerenderAll();
        return true;
    }
    function deleteBranch(id) {
        var b = branchesObj();
        if (b.active === id) return { ok: false, reason: 'Switch to another branch before deleting this one.' };
        var n = b.list.length;
        b.list = b.list.filter(function (x) { return x && x.id !== id; });
        if (b.list.length === n) return { ok: false, reason: 'Unknown branch.' };
        save(); dispatch('prism:branch-changed', { action: 'deleted', id: id }); rerenderAll();
        return { ok: true };
    }
    function listBranches() {
        var b = branchesObj();
        return b.list.map(function (x) {
            var sState = x.state || {};
            return { id: x.id, name: x.name, active: x.id === b.active, createdAt: x.createdAt, updatedAt: x.updatedAt,
                     datasetHash: x.datasetHash, model: sState.model || null, modelName: sState.model ? modelName(sState.model) : '',
                     hasFit: !!sState.lastFit, r2: sState.lastFit ? sState.lastFit.r2 : NaN };
        });
    }
    function activeBranch() { var b = branchesObj(); var a = findBranch(b.active); return a ? { id: a.id, name: a.name } : null; }
    // After an undo the analysis may be back to another branch's saved state:
    // point the active marker at it, so the next switch does not overwrite
    // the wrong branch.
    function syncActiveAfterUndo() {
        var b = branchesObj();
        if (!b.list.length) return;
        var sig = stateSig(captureState());
        for (var i = 0; i < b.list.length; i++) {
            var x = b.list[i];
            if (x && x.id !== b.active && x.state && stateSig(x.state) === sig) { b.active = x.id; save(); rerenderAll(); return; }
        }
    }

    // =========================================================================
    // SECTION 5 — PANELS (C7)
    // =========================================================================
    var STYLE_ID = 'prism_ws_style';
    var CSS = [
        '.prism-ws { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-ws h4 { margin:4px 0 2px; font-size:12.5px; color:var(--text); }',
        '.prism-ws-row { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; }',
        '.prism-ws input[type=text], .prism-ws input[type=search] { flex:1 1 200px; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 8px; font:inherit; font-size:12.5px; }',
        '.prism-ws-tw { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-ws table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-ws th, .prism-ws td { padding:5px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-ws th { color:var(--text2); font-weight:600; }',
        '.prism-ws-btn { padding:5px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg2); color:var(--text); font-size:12px; cursor:pointer; min-height:30px; }',
        '.prism-ws-btn--primary { background:var(--accent); border-color:var(--accent); color:#fff; }',
        '.prism-ws-note { font-size:11.5px; color:var(--text2); line-height:1.45; }',
        '.prism-ws-sw { display:inline-block; width:12px; height:3px; vertical-align:middle; margin-right:5px; border-radius:2px; }',
        '.prism-ws-active { color:var(--accent); font-weight:600; }',
        '.prism-ws-model { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:8px; }',
        '.prism-ws-model b { font-size:12.5px; } .prism-ws-model .sig { color:var(--text2); font-size:11.5px; margin-top:3px; }'
    ].join('\n');
    function ensureCss() {
        if (!D || !D.head || typeof D.createElement !== 'function' || $(STYLE_ID)) return;
        try { var s = D.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; D.head.appendChild(s); } catch (e) { /* ignore */ }
    }
    function pmCI(v, c, sig) {
        if (!isNum(v)) return '—';
        var s = fmt(v, sig || 4);
        if (c) s += ' (' + fmt(c[0], 3) + '–' + fmt(c[1], 3) + ')';
        return s;
    }
    function compareTableHTML(tbl, pfx) {
        if (!tbl.ok) return '<div class="prism-ws-note">Save fits and tick them to compare.</div>';
        var rate = tbl.rows.some(function (r) { return r.kind === 'rate'; }) && tbl.rows.every(function (r) { return r.kind === 'rate'; });
        var head, body;
        if (rate) {
            head = ['Fit', 'Model', 'qi', 'Di (1/d)', 'b', 'R²', 'AIC', 'ΔAIC'];
            body = tbl.rows.map(function (r) {
                return [nameCell(r), esc(r.modelName), esc(pmCI(r.qi, r.qiCI)), esc(pmCI(r.Di, r.DiCI)), esc(pmCI(r.b, r.bCI, 3)),
                        esc(isNum(r.r2) ? r.r2.toFixed(4) : '—'), esc(fmt(r.aic, 5)), esc(isNum(r.dAIC) ? r.dAIC.toFixed(1) : '—')];
            });
        } else {
            head = ['Fit', 'Model', 'k (md) [95 % CI]', 'kh (md·ft)', 'S [95 % CI]', 'C (bbl/psi) [95 % CI]', 'xf / Lh (ft)', 'Boundaries (ft)', 'pi (psia)', 'rinv (ft)', 'R²', 'AIC', 'ΔAIC'];
            body = tbl.rows.map(function (r) {
                var len = isNum(r.xf) ? 'xf ' + pmCI(r.xf, r.xfCI) : (isNum(r.Lh) ? 'Lh ' + pmCI(r.Lh, r.LhCI) : '—');
                var bnd = (r.boundaries || []).map(function (b) { return b.key + ' ' + fmt(b.ft, 4); }).join(', ') || '—';
                return [nameCell(r), esc(r.modelName + (r.mode === 'scale' ? ' (scale)' : '')), esc(pmCI(r.k, r.kCI)), esc(fmt(r.kh, 4)),
                        esc(pmCI(r.S, r.SCI, 3)), esc(pmCI(r.C, r.CCI, 3)), esc(len), esc(bnd), esc(pmCI(r.pi, r.piCI, 5)), esc(fmt(r.rinv, 4)),
                        esc(isNum(r.r2) ? r.r2.toFixed(4) : '—'), esc(fmt(r.aic, 5)), esc(isNum(r.dAIC) ? r.dAIC.toFixed(1) : '—')];
            });
        }
        return '<div class="prism-ws-tw"><table id="' + pfx + 'cmp_table"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + body.map(function (row) { return '<tr>' + row.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div><div class="prism-ws-note">ΔAIC below 2: the data cannot separate the fits; above 10: strong preference. Intervals are the regression\'s 95 % confidence intervals.</div>';
        function nameCell(r) { return '<span class="prism-ws-sw" style="background:' + r.color + '"></span>' + esc(r.name); }
    }
    function fitsTableHTML(list, pfx, compact) {
        if (!list.length) return '<div class="prism-ws-note">No saved fits for this dataset yet.</div>';
        var cmp = getFitCompare();
        return '<div class="prism-ws-tw"><table id="' + pfx + 'fits"><thead><tr><th>Compare</th><th>Name</th><th>Model</th><th>k (md)</th><th>S</th><th>R²</th><th>Saved</th>' +
            (compact ? '' : '<th></th>') + '</tr></thead><tbody>' +
            list.map(function (r) {
                var ph = r.fit.phys || {}, on2 = cmp.indexOf(r.id) >= 0;
                var col = on2 ? COLORS[cmp.indexOf(r.id) % COLORS.length] : 'transparent';
                return '<tr><td><input type="checkbox" data-ws-act="compare" data-ws-id="' + esc(r.id) + '"' + (on2 ? ' checked' : '') + ' aria-label="Compare ' + esc(r.name) + '"></td>' +
                    '<td><span class="prism-ws-sw" style="background:' + col + '"></span>' + esc(r.name) + '</td><td>' + esc(modelName(r.modelKey)) + '</td>' +
                    '<td>' + esc(fmt(ph.k, 4)) + '</td><td>' + esc(fmt(isNum(ph.S) ? ph.S : (r.fit.params || {}).S, 3)) + '</td>' +
                    '<td>' + esc(isNum(r.fit.r2) ? r.fit.r2.toFixed(4) : '—') + '</td><td>' + esc(String(r.savedAt || '').replace('T', ' ').slice(0, 16)) + '</td>' +
                    (compact ? '' : '<td><button type="button" class="prism-ws-btn" data-ws-act="adopt" data-ws-id="' + esc(r.id) + '">Use</button> ' +
                        '<button type="button" class="prism-ws-btn" data-ws-act="rename" data-ws-id="' + esc(r.id) + '">Rename</button> ' +
                        '<button type="button" class="prism-ws-btn" data-ws-act="delete" data-ws-id="' + esc(r.id) + '">Delete</button></td>') + '</tr>';
            }).join('') + '</tbody></table></div>';
    }
    function branchesHTML(pfx) {
        var list = listBranches();
        var h = '<div class="prism-ws-row"><input type="text" id="' + pfx + 'br_name" placeholder="Branch name (e.g. With fault)" maxlength="60">' +
            '<button type="button" class="prism-ws-btn prism-ws-btn--primary" data-ws-act="branch-new">Duplicate analysis as a branch</button></div>';
        if (!list.length) return h + '<div class="prism-ws-note">A branch is a named copy of the whole analysis (model, parameters, fit, flow period, well inputs, rate table). Switch between branches to test alternative interpretations; Undo returns to the state before a switch.</div>';
        h += '<div class="prism-ws-tw"><table id="' + pfx + 'branches"><thead><tr><th>Branch</th><th>Model</th><th>Fit R²</th><th>Updated</th><th></th></tr></thead><tbody>' +
            list.map(function (b) {
                return '<tr><td' + (b.active ? ' class="prism-ws-active"' : '') + '>' + (b.active ? '● ' : '') + esc(b.name) + '</td><td>' + esc(b.modelName || '—') + '</td>' +
                    '<td>' + esc(isNum(b.r2) ? b.r2.toFixed(4) : '—') + '</td><td>' + esc(String(b.updatedAt || '').replace('T', ' ').slice(0, 16)) + '</td><td>' +
                    (b.active ? '<span class="prism-ws-note">active</span>' : '<button type="button" class="prism-ws-btn" data-ws-act="branch-switch" data-ws-id="' + esc(b.id) + '">Switch</button> ') +
                    '<button type="button" class="prism-ws-btn" data-ws-act="branch-rename" data-ws-id="' + esc(b.id) + '">Rename</button>' +
                    (b.active ? '' : ' <button type="button" class="prism-ws-btn" data-ws-act="branch-delete" data-ws-id="' + esc(b.id) + '">Delete</button>') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        return h;
    }

    var _mounted = [];     // [{rootId, host, compact}]
    function renderFitWorkspacePanel(host, opts) {
        if (!host) return;
        opts = opts || {};
        ensureCss();
        var compact = !!opts.compact;
        var pfx = compact ? 'prism_ws2_' : 'prism_ws_';
        var rootId = pfx + 'root';
        var list = listFits();
        var lf = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; } }
        var w = ws();
        var h = '<div class="prism-ws" id="' + rootId + '">';
        if (!compact) {
            h += '<h4>Save the current fit</h4><div class="prism-ws-row"><input type="text" id="' + pfx + 'name" maxlength="60" placeholder="' +
                esc(lf ? 'Name (e.g. ' + modelName(lf.modelKey) + ', R² ' + (isNum(lf.r2) ? lf.r2.toFixed(3) : '—') + ')' : 'Run a fit first') + '">' +
                '<button type="button" class="prism-ws-btn prism-ws-btn--primary" data-ws-act="save"' + (lf ? '' : ' disabled') + '>Save fit</button></div>';
        }
        h += '<h4>Saved fits (this dataset)</h4>' + fitsTableHTML(list, pfx, compact);
        h += '<label class="prism-ws-note" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" data-ws-act="overlay"' + (w.overlay ? ' checked' : '') + '> Show the ticked fits on the plots (solid Δp, dashed derivative)</label>';
        h += '<h4>Comparison</h4><div id="' + pfx + 'cmp">' + compareTableHTML(fitCompareTable(), pfx) + '</div>';
        if (!compact) h += '<h4>Analysis branches</h4>' + branchesHTML(pfx);
        h += '<div class="prism-ws-note" id="' + pfx + 'msg"></div></div>';
        host.innerHTML = h;
        _mounted = _mounted.filter(function (m) { return m.rootId !== rootId; });
        _mounted.push({ rootId: rootId, host: host, compact: compact });
        var root = $(rootId);
        if (!root || typeof root.addEventListener !== 'function') return;
        function msg(t) { var m = $(pfx + 'msg'); if (m) m.textContent = t; }
        function handle(ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute) return;
            var act = t.getAttribute('data-ws-act');
            if (!act) return;
            var id = t.getAttribute('data-ws-id');
            if (ev.type === 'change' && act !== 'compare' && act !== 'overlay') return;
            if (ev.type === 'click' && (act === 'compare' || act === 'overlay')) return;
            if (act === 'save') {
                var nm = $(pfx + 'name');
                var r = saveFit(nm ? nm.value : '');
                if (r && r.ok === false) msg(r.reason); else msg('Saved “' + r.name + '”.');
            } else if (act === 'compare') toggleFitCompare(id);
            else if (act === 'overlay') setFitOverlay(!!t.checked);
            else if (act === 'adopt') { var a = adoptFit(id); msg(a.ok ? 'Fit restored as the current fit.' : a.reason); }
            else if (act === 'rename') {
                var cur = findFit(id);
                var nn = (typeof G.prompt === 'function') ? G.prompt('New name for the fit', cur ? cur.name : '') : null;
                if (nn) renameFit(id, nn);
            } else if (act === 'delete') {
                var ok = (typeof G.confirm === 'function') ? G.confirm('Delete this saved fit?') : true;
                if (ok) removeFit(id);
            } else if (act === 'branch-new') {
                var bn = $(pfx + 'br_name');
                var cb = createBranch(bn ? bn.value : '');
                if (!cb.ok) msg(cb.reason);
            } else if (act === 'branch-switch') {
                var sb = switchBranch(id);
                if (!sb.ok) msg(sb.reason); else if (sb.warning) msg(sb.warning);
            } else if (act === 'branch-rename') {
                var br = findBranch(id);
                var bnn = (typeof G.prompt === 'function') ? G.prompt('New name for the branch', br ? br.name : '') : null;
                if (bnn) renameBranch(id, bnn);
            } else if (act === 'branch-delete') {
                var ok2 = (typeof G.confirm === 'function') ? G.confirm('Delete this branch?') : true;
                if (ok2) { var db = deleteBranch(id); if (!db.ok) msg(db.reason); }
            }
        }
        root.addEventListener('click', handle);
        root.addEventListener('change', handle);
    }
    function rerenderAll() {
        _mounted = _mounted.filter(function (m) { var r = $(m.rootId); return !!(r && r.parentNode); });
        _mounted.slice().forEach(function (m) {
            var r = $(m.rootId);
            if (r && r.parentNode) { try { renderFitWorkspacePanel(r.parentNode, { compact: m.compact }); } catch (e) { /* ignore */ } }
        });
        var mb = $('prism_mb_root');
        if (mb && mb.parentNode) { /* model browser does not depend on fits */ }
    }

    // Model browser panel (Tab 3): plain-language ranked search.
    function modelBrowserResultsHTML(q) {
        var mode = (G.PRiSM && G.PRiSM.mode) || 'transient';
        var res = searchModels(q, { mode: mode === 'combined' ? null : mode });
        if (!String(q || '').trim()) res = res.slice(0, 0);
        if (!String(q || '').trim()) return '<div class="prism-ws-note">Type what you see or expect, e.g. “fault”, “valley”, “half slope”, “fractured”, “closed”, “injection front”.</div>';
        if (!res.length) return '<div class="prism-ws-note">No model matches “' + esc(q) + '”.</div>';
        var cur = st().model;
        return res.slice(0, 12).map(function (m) {
            return '<div class="prism-ws-model" data-ws-model="' + esc(m.key) + '"><b>' + esc(m.name) + '</b>' + (m.key === cur ? ' <span class="prism-ws-active">(selected)</span>' : '') +
                '<div>' + esc(m.plain) + '</div><div class="sig">Looks like: ' + esc(m.signature) + '</div>' +
                (m.key === cur ? '' : '<div style="margin-top:6px"><button type="button" class="prism-ws-btn" data-ws-act="use-model" data-ws-id="' + esc(m.key) + '">Use this model</button></div>') + '</div>';
        }).join('');
    }
    var _mbQuery = '';
    function renderModelBrowserPanel(host) {
        if (!host) return;
        ensureCss();
        host.innerHTML = '<div class="prism-ws" id="prism_mb_root">' +
            '<div class="prism-ws-row"><input type="search" id="prism_mb_q" placeholder="Describe the behaviour or geometry" value="' + esc(_mbQuery) + '"></div>' +
            '<div id="prism_mb_res" style="display:flex;flex-direction:column;gap:6px;">' + modelBrowserResultsHTML(_mbQuery) + '</div></div>';
        var q = $('prism_mb_q'), root = $('prism_mb_root');
        if (q) q.oninput = q.onchange = function () { _mbQuery = q.value || ''; var r = $('prism_mb_res'); if (r) r.innerHTML = modelBrowserResultsHTML(_mbQuery); };
        if (root && typeof root.addEventListener === 'function') root.addEventListener('click', function (ev) {
            var t = ev && ev.target;
            if (!t || !t.getAttribute || t.getAttribute('data-ws-act') !== 'use-model') return;
            var key = t.getAttribute('data-ws-id');
            if (!models()[key]) return;
            if (typeof G.PRiSM_setModel === 'function') { try { G.PRiSM_setModel(key, { source: 'model-browser' }); } catch (e) { st().model = key; } }
            else st().model = key;
            try { if (typeof G.PRiSM_evalModelCurve === 'function') G.PRiSM_evalModelCurve(key, st().params, {}); } catch (e) { /* ignore */ }
            try { var rt = (typeof PRiSM_renderTab === 'function') ? PRiSM_renderTab : G.PRiSM_renderTab; if (typeof rt === 'function' && $('prism_tab_3')) rt(3); } catch (e) { /* ignore */ }   // eslint-disable-line no-undef
            var r2 = $('prism_mb_res'); if (r2) r2.innerHTML = modelBrowserResultsHTML(_mbQuery);
        });
    }

    function hasFitsForData() { return listFits().length > 0; }
    function registerPanels() {
        var specs = [
            [6, { id: 'prism_fit_workspace', title: 'Fit workspace: saved fits, comparison, branches', order: 20, render: function (el) { renderFitWorkspacePanel(el, {}); } }],
            [2, { id: 'prism_fit_compare', title: 'Compare saved fits on the plots', order: 9, collapsed: true, when: hasFitsForData, render: function (el) { renderFitWorkspacePanel(el, { compact: true }); } }],
            [3, { id: 'prism_model_browser', title: 'Model browser: search by behaviour', order: 5, collapsed: true, render: renderModelBrowserPanel }]
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

    // =========================================================================
    // SECTION 6 — REPORT SECTION (36-report.js PRiSM_reportSections)
    // =========================================================================
    function reportCompare() {
        var ids = getFitCompare();
        if (!ids.length) return null;
        var tbl = fitCompareTable(ids);
        if (!tbl.ok) return null;
        var h = dsHash();
        var rows = tbl.rows.filter(function (r) { return !h || !r.datasetHash || r.datasetHash === h; });
        if (!rows.length) return null;
        var rate = rows.every(function (r) { return r.kind === 'rate'; });
        var head = rate ? ['Fit', 'Model', 'qi', 'Di (1/d)', 'b', 'R²', 'ΔAIC']
            : ['Fit', 'Model', 'k (md) [95 % CI]', 'S [95 % CI]', 'C (bbl/psi)', 'xf / Lh (ft)', 'Boundaries (ft)', 'R²', 'ΔAIC'];
        var body = rows.map(function (r) {
            if (rate) return [r.name, r.modelName, pmCI(r.qi, r.qiCI), pmCI(r.Di, r.DiCI), pmCI(r.b, r.bCI, 3), isNum(r.r2) ? r.r2.toFixed(4) : '—', isNum(r.dAIC) ? r.dAIC.toFixed(1) : '—'];
            var len = isNum(r.xf) ? 'xf ' + fmt(r.xf, 4) : (isNum(r.Lh) ? 'Lh ' + fmt(r.Lh, 4) : '—');
            var bnd = (r.boundaries || []).map(function (b) { return b.key + ' ' + fmt(b.ft, 4); }).join(', ') || '—';
            return [r.name, r.modelName, pmCI(r.k, r.kCI), pmCI(r.S, r.SCI, 3), fmt(r.C, 3), len, bnd, isNum(r.r2) ? r.r2.toFixed(4) : '—', isNum(r.dAIC) ? r.dAIC.toFixed(1) : '—'];
        });
        var br = activeBranch();
        return { id: 'fitCompare', title: 'Saved fits compared', order: 10, table: { head: head, rows: body },
                 notes: ['ΔAIC is relative to the best fit in this table.' + (br ? ' Analysis branch: ' + br.name + '.' : '')] };
    }
    (function registerReport() {
        var reg = G.PRiSM_reportSections = Array.isArray(G.PRiSM_reportSections) ? G.PRiSM_reportSections : [];
        reportCompare._prismId = 'workspace-compare';
        for (var i = 0; i < reg.length; i++) if (reg[i] && reg[i]._prismId === reportCompare._prismId) { reg[i] = reportCompare; return; }
        reg.push(reportCompare);
    })();

    // Events (no polling): new data → overlays recomputed; undo → re-point the branch marker.
    if (!G.__PRiSM_workspaceListeners) {
        G.__PRiSM_workspaceListeners = true;
        ['prism:dataset-loaded', 'prism:well-changed', 'prism:period-changed'].forEach(function (type) {
            on(type, function (ev) {
                _curveCache = {};
                var src = ev && ev.detail && ev.detail.source;
                if (type === 'prism:dataset-loaded') rerenderAll();
                if (src === 'undo' && !_applying) syncActiveAfterUndo();
            });
        });
        on('prism:fit-updated', function (ev) {
            var src = ev && ev.detail && ev.detail.source;
            if (src === 'branch') return;
            // The Save button's placeholder / enabled state follow the last fit.
            var r = $('prism_ws_root');
            if (r && r.parentNode) { try { renderFitWorkspacePanel(r.parentNode, {}); } catch (e) { /* ignore */ } }
        });
    }

    // =========================================================================
    // SECTION 7 — EXPORTS
    // =========================================================================
    G.PRiSM_saveFit = saveFit;
    G.PRiSM_listFits = listFits;
    G.PRiSM_getFit = getFit;
    G.PRiSM_removeFit = removeFit;
    G.PRiSM_renameFit = renameFit;
    G.PRiSM_adoptFit = adoptFit;
    G.PRiSM_setFitCompare = setFitCompare;
    G.PRiSM_getFitCompare = getFitCompare;
    G.PRiSM_toggleFitCompare = toggleFitCompare;
    G.PRiSM_setFitOverlay = setFitOverlay;
    G.PRiSM_fitCompareTable = fitCompareTable;
    G.PRiSM_fitOverlayCurve = function (id) { return clone(fitOverlayCurve(id)); };
    G.PRiSM_createBranch = createBranch;
    G.PRiSM_switchBranch = switchBranch;
    G.PRiSM_renameBranch = renameBranch;
    G.PRiSM_deleteBranch = deleteBranch;
    G.PRiSM_listBranches = listBranches;
    G.PRiSM_activeBranch = activeBranch;
    G.PRiSM_modelPlainInfo = modelPlainInfo;
    G.PRiSM_searchModels = searchModels;
    G.PRiSM_modelSearchTerms = modelSearchTerms;
    G.PRiSM_renderFitWorkspacePanel = renderFitWorkspacePanel;
    G.PRiSM_renderModelBrowserPanel = renderModelBrowserPanel;
    G.PRiSM_FIT_COLORS = COLORS.slice();

})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if (typeof G.PRiSM_searchModels !== 'function' || !G.PRiSM_MODELS) return;
    var checks = [];
    var r = G.PRiSM_searchModels('fault');
    checks.push(['search fault → a fault model first', r.length > 0 && /fault|linearBoundary|fogBoundary|intersecting/i.test(r[0].key + r[0].name)]);
    var v = G.PRiSM_searchModels('valley');
    checks.push(['search valley → dual porosity', v.some(function (x) { return x.key === 'doublePorosity'; })]);
    var bad = checks.filter(function (c) { return !c[1]; });
    if (bad.length && typeof console !== 'undefined') console.error('[51-prism-workspace self-test] failed:', bad.map(function (c) { return c[0]; }).join(', '));
    G.PRiSM_workspace_selfTest = checks;
})();
