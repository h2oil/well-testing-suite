// =============================================================================
// PRiSM — Layer 04 — UI Wiring (Tabs 2-7)
// -----------------------------------------------------------------------------
// Populates the placeholder bodies for tabs 2 (Plots), 3 (Model),
// 4 (Params), 5 (Match), 6 (Regress), and 7 (Report). Tab 1 (Data)
// is wired by the foundation file (01).
//
// Hooked into the shell by wrapping window.PRiSM.setTab so each tab
// switch triggers the appropriate render function.
//
// Globals introduced here:
//   - window.PRiSM_state   shared state used by tabs 2-7
//   - wraps window.PRiSM.setTab
//
// Dependencies (assumed in scope):
//   $, el, fmt, loadInputs, saveInputs, exportReport     (host app)
//   PRiSM_stehfest, PRiSM_logspace, PRiSM_model_homogeneous,
//   PRiSM_model_homogeneous_pd_prime                     (foundation)
//   PRiSM_MODELS, all PRiSM_plot_* functions, PRiSM_compute_bourdet
// =============================================================================

(function () {
'use strict';

// ── Backfill the homogeneous entry into PRiSM_MODELS if it's missing.
// Phase 2 expects it to be seeded by the foundation; if not, this layer
// installs a minimal entry so the model picker works out of the box.
if (typeof window.PRiSM_MODELS !== 'object' || !window.PRiSM_MODELS) {
    window.PRiSM_MODELS = {};
}
if (!window.PRiSM_MODELS.homogeneous && typeof PRiSM_model_homogeneous === 'function') {
    window.PRiSM_MODELS.homogeneous = {
        pd: PRiSM_model_homogeneous,
        pdPrime: (typeof PRiSM_model_homogeneous_pd_prime === 'function')
                    ? PRiSM_model_homogeneous_pd_prime : null,
        defaults: { Cd: 100, S: 0 },
        paramSpec: [
            { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0,  max: 1e10, default: 100 },
            { key: 'S',  label: 'Skin S',              unit: '-', min: -7, max: 50,   default: 0 }
        ],
        reference: 'Bourdet 2002 §3.2 (Mavor & Cinco-Ley, SPE 7977)',
        category: 'homogeneous',
        description: 'Vertical well in an infinite-acting homogeneous reservoir, with wellbore storage and constant skin.'
    };
}

// ── Bridge Phase 1+2 plot functions onto window so the dispatch in
//    PRiSM_drawActivePlot (which looks up window[entry.fn]) can find them.
//    The plot functions are declared as top-level `function PRiSM_plot_*`
//    in 02-plots.js (no IIFE); they hoist to the host main IIFE scope.
//    From inside this inner IIFE, direct identifier references resolve
//    via the lexical-scope chain — assigning each to window publishes it
//    so the string-keyed dispatch can resolve it.
(function _bridgePlotFnsToWindow() {
    var names = [
        'PRiSM_plot_cartesian',
        'PRiSM_plot_horner',
        'PRiSM_plot_bourdet',
        'PRiSM_plot_sqrt_time',
        'PRiSM_plot_quarter_root_time',
        'PRiSM_plot_spherical',
        'PRiSM_plot_sandface_convolution',
        'PRiSM_plot_buildup_superposition',
        'PRiSM_plot_rate_time_cartesian',
        'PRiSM_plot_rate_time_semilog',
        'PRiSM_plot_rate_time_loglog',
        'PRiSM_plot_rate_cumulative',
        'PRiSM_plot_loss_ratio',
        'PRiSM_plot_typecurve_overlay'
    ];
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (typeof window[n] === 'function') continue; // already exposed
        // Direct identifier lookup via host-IIFE lexical scope.
        // eval here is intentional — it's the only way to convert a string
        // back into a lexically-scoped binding of the same name.
        try {
            // eslint-disable-next-line no-eval
            var fn = eval(n);
            if (typeof fn === 'function') window[n] = fn;
        } catch (e) { /* function not in scope yet — non-fatal */ }
    }
})();


// ── Shared state container for tabs 2-7 ──────────────────────────────────
window.PRiSM_state = window.PRiSM_state || {
    model: 'homogeneous',
    params: {},
    paramFreeze: {},
    modelCurve: null,           // { td, pd, pdPrime }
    match:    { timeShift: 0, pressShift: 0 },
    activePlot: 'bourdet',
    presets: []
};

// Seed default params from the active model's defaults if empty.
(function _seedDefaultParams() {
    var st = window.PRiSM_state;
    var m = window.PRiSM_MODELS[st.model];
    if (m && m.defaults && Object.keys(st.params).length === 0) {
        for (var k in m.defaults) {
            if (Object.prototype.hasOwnProperty.call(m.defaults, k)) {
                st.params[k] = m.defaults[k];
            }
        }
    }
    // Restore presets from localStorage on first load.
    try {
        var raw = localStorage.getItem('wts_prism_presets');
        if (raw) st.presets = JSON.parse(raw) || [];
    } catch (e) { /* ignore */ }
})();


// =========================================================================
// PLOT REGISTRY — maps tab-2 picker keys → renderer + label/mode flags
// =========================================================================

var PRISM_PLOT_REGISTRY = {
    // Transient (PTA) plots
    cartesian:     { fn: 'PRiSM_plot_cartesian',              label: 'Cartesian P vs t',     mode: 'transient' },
    horner:        { fn: 'PRiSM_plot_horner',                 label: 'Horner',               mode: 'transient' },
    bourdet:       { fn: 'PRiSM_plot_bourdet',                label: 'Log-Log Bourdet',      mode: 'transient' },
    sqrt:          { fn: 'PRiSM_plot_sqrt_time',              label: 'Square-root time',     mode: 'transient' },
    quarter:       { fn: 'PRiSM_plot_quarter_root_time',      label: 'Quarter-root time',    mode: 'transient' },
    spherical:     { fn: 'PRiSM_plot_spherical',              label: 'Spherical',            mode: 'transient' },
    sandface:      { fn: 'PRiSM_plot_sandface_convolution',   label: 'Sandface convolution', mode: 'transient' },
    superposition: { fn: 'PRiSM_plot_buildup_superposition',  label: 'Buildup superposition',mode: 'transient' },
    // Decline (DCA) plots
    rateCart:      { fn: 'PRiSM_plot_rate_time_cartesian',    label: 'Rate vs time (cart)',  mode: 'decline' },
    rateSemi:      { fn: 'PRiSM_plot_rate_time_semilog',      label: 'Rate vs time (semi)',  mode: 'decline' },
    rateLog:       { fn: 'PRiSM_plot_rate_time_loglog',       label: 'Rate vs time (log)',   mode: 'decline' },
    rateCum:       { fn: 'PRiSM_plot_rate_cumulative',        label: 'Rate vs cumulative',   mode: 'decline' },
    lossRatio:     { fn: 'PRiSM_plot_loss_ratio',             label: 'Loss-ratio',           mode: 'decline' },
    typeCurve:     { fn: 'PRiSM_plot_typecurve_overlay',      label: 'Type-curve overlay',   mode: 'decline' }
};


// =========================================================================
// SHARED HELPERS
// =========================================================================

// Auto-detect periods from rate changes. Returns array of [tStart, tEnd, qConst].
function PRiSM_detectPeriods(t, q) {
    if (!Array.isArray(t) || !Array.isArray(q) || t.length !== q.length || t.length < 2) return [];
    var periods = [];
    var startIdx = 0;
    for (var i = 1; i < t.length; i++) {
        if (Math.abs(q[i] - q[startIdx]) > 1e-9) {
            periods.push({ t0: t[startIdx], t1: t[i - 1], q: q[startIdx] });
            startIdx = i;
        }
    }
    periods.push({ t0: t[startIdx], t1: t[t.length - 1], q: q[startIdx] });
    return periods;
}

// Derive a model curve object from the active model + params at td points.
function PRiSM_evalModelCurve(modelKey, params, tdArr) {
    var m = window.PRiSM_MODELS[modelKey];
    if (!m || typeof m.pd !== 'function') return null;
    var pd, pdPrime;
    try {
        pd = m.pd(tdArr, params);
    } catch (e) {
        console.warn('PRiSM model pd failed:', e.message);
        return null;
    }
    if (m.pdPrime) {
        try { pdPrime = m.pdPrime(tdArr, params); } catch (e) { pdPrime = null; }
    }
    return { td: tdArr.slice(), pd: pd, pdPrime: pdPrime };
}

// Apply timeShift + pressShift to a (t, p) pair.
function PRiSM_applyMatch(t, p, dt, dp) {
    var rt = new Array(t.length), rp = new Array(p.length);
    for (var i = 0; i < t.length; i++) {
        rt[i] = t[i] * Math.pow(10, dt);   // log-time shift
        rp[i] = p[i] + dp;                 // pressure shift (linear)
    }
    return { t: rt, p: rp };
}

// RMSE between data and model evaluated at the data times (linear interp).
function PRiSM_computeRMSE(tData, pData, tModel, pModel) {
    if (!tData || !pData || !tModel || !pModel) return NaN;
    if (!tData.length || !tModel.length) return NaN;
    function interp(t) {
        if (t <= tModel[0]) return pModel[0];
        if (t >= tModel[tModel.length - 1]) return pModel[pModel.length - 1];
        for (var i = 1; i < tModel.length; i++) {
            if (tModel[i] >= t) {
                var f = (t - tModel[i - 1]) / (tModel[i] - tModel[i - 1]);
                return pModel[i - 1] + f * (pModel[i] - pModel[i - 1]);
            }
        }
        return NaN;
    }
    var sse = 0, n = 0;
    for (var i = 0; i < tData.length; i++) {
        var pm = interp(tData[i]);
        if (isFinite(pm) && isFinite(pData[i])) {
            var d = pData[i] - pm;
            sse += d * d;
            n++;
        }
    }
    return n ? Math.sqrt(sse / n) : NaN;
}

// Persist the param presets list.
function PRiSM_persistPresets() {
    try { localStorage.setItem('wts_prism_presets', JSON.stringify(window.PRiSM_state.presets || [])); }
    catch (e) { /* quota — ignore */ }
}


// =========================================================================
// TAB 2 — PLOTS
// =========================================================================

function PRiSM_renderPlotsTab() {
    var host = $('prism_tab_2');
    if (!host) return;
    var st = window.PRiSM_state;
    var mode = (window.PRiSM && window.PRiSM.mode) || 'transient';
    // If the active plot doesn't belong to the current mode, snap to a
    // sensible default for that mode.
    if (PRISM_PLOT_REGISTRY[st.activePlot] && PRISM_PLOT_REGISTRY[st.activePlot].mode !== mode) {
        st.activePlot = (mode === 'decline') ? 'rateLog' : 'bourdet';
    }
    if (!PRISM_PLOT_REGISTRY[st.activePlot]) {
        st.activePlot = (mode === 'decline') ? 'rateLog' : 'bourdet';
    }

    var ds = window.PRiSM_dataset;
    var hasData = !!(ds && Array.isArray(ds.t) && ds.t.length > 0);

    // Build the picker options for the current mode.
    var pickerOpts = '';
    for (var key in PRISM_PLOT_REGISTRY) {
        if (PRISM_PLOT_REGISTRY[key].mode === mode || (mode === 'combined')) {
            pickerOpts += '<option value="' + key + '"' +
                (key === st.activePlot ? ' selected' : '') + '>' +
                PRISM_PLOT_REGISTRY[key].label + '</option>';
        }
    }

    host.innerHTML =
        '<div class="card">' +
            '<div class="card-title">Diagnostic Plot</div>' +
            (!hasData
                ? '<div class="info-bar" style="background:var(--bg2); border:1px dashed var(--border); padding:14px; border-radius:6px; color:var(--text2); font-size:13px; margin-bottom:12px;">' +
                  '<strong style="color:var(--text);">No dataset loaded.</strong> ' +
                  'Switch to <em>Tab 1 — Data</em>, paste or upload your time/pressure/rate data, then click <strong>Use this data</strong>.' +
                  '</div>'
                : '') +
            '<div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">' +
                '<label style="font-size:12px; color:var(--text2); display:flex; align-items:center; gap:8px;">' +
                    '<span>Plot type</span>' +
                    '<select id="prism_plot_picker" style="padding:6px 10px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px; min-width:220px;">' +
                        pickerOpts +
                    '</select>' +
                '</label>' +
                '<button class="btn btn-secondary" id="prism_plot_bourdet_btn">Compute Bourdet derivative</button>' +
                '<button class="btn btn-secondary" id="prism_plot_reset" title="Reset zoom to fit all data">⟳ Reset view</button>' +
                '<label style="font-size:12px; color:var(--text2); display:flex; align-items:center; gap:6px;">' +
                    '<input type="checkbox" id="prism_plot_overlay" ' +
                        (st.modelCurve ? 'checked' : 'disabled') + '>' +
                    '<span>Show model overlay</span>' +
                '</label>' +
                '<span style="font-size:11px; color:var(--text3); margin-left:auto;">Drag a rectangle to zoom · click ⟳ Reset view to fit all data</span>' +
                '<label id="prism_plot_period_lbl" style="font-size:12px; color:var(--text2); display:none; align-items:center; gap:6px;">' +
                    '<span>Period</span>' +
                    '<select id="prism_plot_period" style="padding:6px 10px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;"></select>' +
                '</label>' +
            '</div>' +
            '<div style="background:var(--bg1); border:1px solid var(--border); border-radius:6px; padding:6px;">' +
                // Canvas height fills available viewport space; min-height ensures
                // it never collapses on small screens. calc() subtracts header /
                // tab strip / picker bar so the canvas isn't cropped by overflow.
                '<canvas id="prism_plot_canvas" style="width:100%; height:calc(100vh - 320px); min-height:500px; display:block;"></canvas>' +
            '</div>' +
            '<div id="prism_plot_msg" style="margin-top:8px; font-size:12px; color:var(--text2); min-height:16px;"></div>' +
        '</div>';

    if (!hasData) return;

    // Auto-detect periods if rate present and not yet set on the dataset.
    if (ds.q && !ds.periods) {
        ds.periods = PRiSM_detectPeriods(ds.t, ds.q);
    }
    if (ds.periods && ds.periods.length > 1) {
        var pSel = $('prism_plot_period');
        var pLbl = $('prism_plot_period_lbl');
        pLbl.style.display = 'flex';
        var optHTML = '<option value="-1">All</option>';
        for (var i = 0; i < ds.periods.length; i++) {
            var p = ds.periods[i];
            optHTML += '<option value="' + i + '">' + (i + 1) + ': q=' +
                fmt(p.q, 2) + ' (' + fmt(p.t0, 3) + '..' + fmt(p.t1, 3) + ')</option>';
        }
        pSel.innerHTML = optHTML;
        if (st.activePeriod != null) pSel.value = String(st.activePeriod);
        pSel.onchange = function () {
            st.activePeriod = parseInt(pSel.value, 10);
            PRiSM_drawActivePlot();
        };
    }

    $('prism_plot_picker').onchange = function () {
        st.activePlot = this.value;
        PRiSM_drawActivePlot();
    };

    // Reset zoom — clears stashed axes + handlers so the next render
    // re-autoscales from the data range. Works for any of the 14 plot
    // types since they all build their scaleX/scaleY in PRiSM_plot_axes
    // from the data extent.
    var resetBtn = $('prism_plot_reset');
    if (resetBtn) resetBtn.onclick = function () {
        var c = $('prism_plot_canvas');
        if (c) {
            try { delete c._prismOriginalScale; } catch (_) { c._prismOriginalScale = null; }
            try { delete c._prismHandlers; }      catch (_) { c._prismHandlers = null; }
            try { delete c._prismAxes; }          catch (_) { c._prismAxes = null; }
        }
        PRiSM_drawActivePlot();
    };

    $('prism_plot_bourdet_btn').onclick = function () {
        if (!ds.t || !ds.p) {
            $('prism_plot_msg').innerHTML = '<span style="color:var(--red);">Need t and p data.</span>';
            return;
        }
        var dp = ds.p.map(function (v) { return v - ds.p[0]; });
        var L = 0.2;
        var dpDeriv;
        if (typeof PRiSM_compute_bourdet === 'function') {
            dpDeriv = PRiSM_compute_bourdet(ds.t, dp, L);
        } else {
            // Inline fallback derivative if the helper isn't exposed.
            dpDeriv = new Array(ds.t.length).fill(NaN);
            for (var i = 1; i < ds.t.length - 1; i++) {
                if (!(ds.t[i] > 0)) continue;
                var t1 = ds.t[i - 1], t2 = ds.t[i + 1], ti = ds.t[i];
                if (!(t1 > 0) || !(t2 > 0)) continue;
                var dl1 = Math.log(ti) - Math.log(t1);
                var dl2 = Math.log(t2) - Math.log(ti);
                var dlT = Math.log(t2) - Math.log(t1);
                if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
                dpDeriv[i] = (dp[i] - dp[i - 1]) / dl1 * (dl2 / dlT) +
                             (dp[i + 1] - dp[i]) / dl2 * (dl1 / dlT);
            }
        }
        ds.dp = dpDeriv;
        $('prism_plot_msg').innerHTML = '<span style="color:var(--green);">Bourdet derivative computed (window L = ' + L + ').</span>';
        PRiSM_drawActivePlot();
    };

    $('prism_plot_overlay').onchange = PRiSM_drawActivePlot;

    PRiSM_drawActivePlot();
}

// Clear the canvas + draw a single-line status message at its visible
// centre. Used by every error/empty-state branch in PRiSM_drawActivePlot
// so successive calls don't pile overlapping text.
function PRiSM_drawCanvasMessage(canvas, msg, color) {
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    // Reset transform so clearRect uses backing-buffer pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Switch to CSS-pixel coords so fillText centres correctly on retina.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cssW = canvas.width / dpr;
    var cssH = canvas.height / dpr;
    ctx.fillStyle = color || '#888';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, cssW / 2, cssH / 2);
}

function PRiSM_drawActivePlot() {
    var canvas = $('prism_plot_canvas');
    if (!canvas) return;
    var st = window.PRiSM_state;
    var ds = window.PRiSM_dataset;
    var entry = PRISM_PLOT_REGISTRY[st.activePlot];
    if (!entry) return;
    if (!ds || !Array.isArray(ds.t) || !ds.t.length) {
        PRiSM_drawCanvasMessage(canvas, 'No data loaded — paste/upload data on Tab 1.', '#888');
        return;
    }
    var fn = window[entry.fn];
    if (typeof fn !== 'function') {
        PRiSM_drawCanvasMessage(canvas, 'Plot function ' + entry.fn + ' not available.', '#f87');
        return;
    }

    // Build the data block the plot lib expects.
    var data = { t: ds.t, p: ds.p, q: ds.q };
    if (ds.dp) data.dp = ds.dp;
    if (ds.periods) data.periods = ds.periods;

    var overlayChk = $('prism_plot_overlay');
    if (overlayChk && overlayChk.checked && st.modelCurve) {
        var c = st.modelCurve;
        // Apply current match shifts so the overlay tracks the visual match.
        var shifted = PRiSM_applyMatch(c.td, c.pd, st.match.timeShift, st.match.pressShift);
        data.overlay = { t: shifted.t, p: shifted.p };
    }

    var opts = {
        hover: true,
        dragZoom: true,
        showLegend: true,
        activePeriod: (st.activePeriod != null && st.activePeriod >= 0) ? st.activePeriod : undefined
    };

    try {
        fn(canvas, data, opts);
    } catch (e) {
        console.error('PRiSM plot render error:', e);
        PRiSM_drawCanvasMessage(canvas, 'Render error: ' + e.message, '#f87');
    }
}


// =========================================================================
// TAB 3 — MODEL
// =========================================================================

function PRiSM_renderModelTab() {
    var host = $('prism_tab_3');
    if (!host) return;
    var st = window.PRiSM_state;

    // Group models by category.
    var groups = {};
    for (var k in window.PRiSM_MODELS) {
        var m = window.PRiSM_MODELS[k];
        var cat = (m && m.category) ? m.category : 'other';
        (groups[cat] = groups[cat] || []).push({ key: k, model: m });
    }

    var catOrder = ['homogeneous', 'fracture', 'well-type', 'boundary', 'other'];
    var catTitles = {
        'homogeneous': 'Homogeneous Reservoir',
        'fracture':    'Fractured Wells',
        'well-type':   'Well Geometry',
        'boundary':    'Boundary Effects',
        'other':       'Other'
    };

    var html = '<div class="card">' +
        '<div class="card-title">Model Library</div>' +
        '<div style="font-size:12px; color:var(--text2); margin-bottom:14px;">' +
        'Pick the conceptual model for the test. Each card lists its parameters and reference. ' +
        'The selected model drives Tabs 4-7.</div>';

    catOrder.forEach(function (cat) {
        if (!groups[cat] || !groups[cat].length) return;
        html += '<div style="margin-bottom:18px;">';
        html += '<div style="font-size:11px; font-weight:700; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' + catTitles[cat] + '</div>';
        html += '<div class="fg" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));">';
        groups[cat].forEach(function (entry) {
            var sel = (entry.key === st.model);
            var paramKeys = (entry.model.paramSpec || []).map(function (s) { return s.key; }).join(', ');
            html += '<div class="fg-item prism-model-card" data-prism-model="' + entry.key + '" style="' +
                'background:' + (sel ? 'var(--accent-bg, rgba(240,136,62,0.10))' : 'var(--bg2)') + '; ' +
                'border:1px solid ' + (sel ? 'var(--accent)' : 'var(--border)') + '; ' +
                'border-radius:6px; padding:12px; cursor:pointer; transition:border-color .15s;">' +
                '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
                    '<div style="font-weight:700; color:var(--text); font-size:13px;">' + entry.key + '</div>' +
                    (sel ? '<span style="font-size:10px; color:var(--accent); font-weight:700; padding:2px 6px; border:1px solid var(--accent); border-radius:3px;">SELECTED</span>' : '') +
                '</div>' +
                '<div style="font-size:12px; color:var(--text2); margin-top:6px; line-height:1.4;">' +
                    (entry.model.description || '—') +
                '</div>' +
                '<div style="font-size:11px; color:var(--text3); margin-top:8px;"><strong>Params:</strong> ' + paramKeys + '</div>' +
                '<div style="font-size:11px; color:var(--text3); margin-top:4px; font-style:italic;">' +
                    (entry.model.reference || '') +
                '</div>' +
            '</div>';
        });
        html += '</div></div>';
    });

    // Selected model — full param list + schematic placeholder.
    var current = window.PRiSM_MODELS[st.model];
    if (current) {
        var specRows = (current.paramSpec || []).map(function (s) {
            var rng = '';
            if (s.options) rng = 'options: ' + s.options.join(', ');
            else rng = 'min: ' + s.min + ' / max: ' + s.max;
            return '<tr><td>' + s.key + '</td><td>' + s.label + '</td>' +
                   '<td>' + (s.unit || '-') + '</td>' +
                   '<td>' + (s['default'] != null ? s['default'] : '—') + '</td>' +
                   '<td style="color:var(--text3);">' + rng + '</td></tr>';
        }).join('');

        html += '<div class="cols-2" style="margin-top:14px;">' +
            '<div class="card">' +
                '<div class="card-title">Selected — ' + st.model + '</div>' +
                '<table class="dtable">' +
                    '<thead><tr><th>Key</th><th>Label</th><th>Unit</th><th>Default</th><th>Range</th></tr></thead>' +
                    '<tbody>' + specRows + '</tbody>' +
                '</table>' +
                '<div style="margin-top:10px; font-size:11px; color:var(--text3); font-style:italic;">' +
                    (current.reference || '') +
                '</div>' +
            '</div>' +
            '<div class="card">' +
                '<div class="card-title">Schematic</div>' +
                '<div id="prism_schematic_host" style="background:var(--bg1); border:1px solid var(--border); border-radius:6px; padding:8px; min-height:240px; display:flex; align-items:center; justify-content:center;">' +
                    // Placeholder; populated below by PRiSM_getModelSchematic
                '</div>' +
                '<div style="color:var(--text2); font-size:12px; margin-top:8px; line-height:1.4;">' + (current.description || '') + '</div>' +
            '</div>' +
        '</div>';
    }

    html += '</div>';
    host.innerHTML = html;

    // Inject the SVG schematic for the active model (Round-2 polish layer).
    // The 14 schematics live in PRiSM_getModelSchematic from 11-polish.js.
    // Falls back to a placeholder text if the polish layer isn't loaded.
    var schemHost = host.querySelector('#prism_schematic_host');
    if (schemHost) {
        var svg = '';
        if (typeof window.PRiSM_getModelSchematic === 'function') {
            try { svg = window.PRiSM_getModelSchematic(st.model) || ''; }
            catch (_e) { svg = ''; }
        }
        if (svg && svg.length > 50) {
            // Make the SVG fill the host so it scales with the card width.
            // PRiSM_getModelSchematic returns SVG with viewBox — wrap to scale.
            schemHost.innerHTML = '<div style="width:100%; max-width:380px;">' + svg + '</div>';
            // Force responsive sizing on the inner SVG element.
            var inner = schemHost.querySelector('svg');
            if (inner) {
                inner.removeAttribute('width');
                inner.removeAttribute('height');
                inner.style.width = '100%';
                inner.style.height = 'auto';
                inner.style.maxHeight = '320px';
            }
        } else {
            schemHost.innerHTML =
                '<div style="text-align:center; color:var(--text3);">' +
                    '<div style="font-size:32px; margin-bottom:8px;">[ ' + st.model + ' ]</div>' +
                    '<div style="font-size:11px;">Schematic not available for this model.</div>' +
                '</div>';
        }
    }

    // Wire card-click selection.
    host.querySelectorAll('.prism-model-card').forEach(function (card) {
        card.onclick = function () {
            var key = card.dataset.prismModel;
            if (!window.PRiSM_MODELS[key]) return;
            window.PRiSM_state.model = key;
            // Reset params + freezes to that model's defaults.
            var defs = window.PRiSM_MODELS[key].defaults || {};
            window.PRiSM_state.params = {};
            window.PRiSM_state.paramFreeze = {};
            for (var pk in defs) window.PRiSM_state.params[pk] = defs[pk];
            window.PRiSM_state.modelCurve = null;
            // Re-render so the selected highlight + param table refresh.
            PRiSM_renderModelTab();
        };
    });
}


// =========================================================================
// TAB 4 — PARAMS
// =========================================================================

function PRiSM_renderParamsTab() {
    var host = $('prism_tab_4');
    if (!host) return;
    var st = window.PRiSM_state;
    var current = window.PRiSM_MODELS[st.model];
    if (!current) {
        host.innerHTML = '<div class="card"><div class="card-title">Parameters</div>' +
            '<div style="color:var(--text2);">No model selected. Choose one in Tab 3.</div></div>';
        return;
    }

    var spec = current.paramSpec || [];
    var paramRowsHTML = spec.map(function (s) {
        var current = (st.params[s.key] != null) ? st.params[s.key] : s['default'];
        var freeze = !!st.paramFreeze[s.key];
        var inputHTML;
        if (s.options) {
            inputHTML = '<select id="prism_p_' + s.key + '" data-prism-pkey="' + s.key + '" ' +
                'style="padding:5px 8px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px; width:100%;">' +
                s.options.map(function (o) {
                    return '<option value="' + o + '"' + (String(current) === String(o) ? ' selected' : '') + '>' + o + '</option>';
                }).join('') +
                '</select>';
        } else {
            inputHTML = '<input type="number" step="any" id="prism_p_' + s.key + '" ' +
                'data-prism-pkey="' + s.key + '" value="' + current + '" ' +
                'style="padding:5px 8px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px; width:100%;">';
        }
        return '<tr>' +
            '<td><strong>' + s.key + '</strong></td>' +
            '<td>' + s.label + '</td>' +
            '<td style="color:var(--text2);">' + (s.unit || '-') + '</td>' +
            '<td>' + inputHTML + '</td>' +
            '<td style="color:var(--text3); font-size:11px;">' +
                (s.options ? s.options.join(' / ') : ('[' + s.min + ', ' + s.max + ']')) +
            '</td>' +
            '<td style="text-align:center;">' +
                '<input type="checkbox" data-prism-fkey="' + s.key + '"' + (freeze ? ' checked' : '') + '>' +
            '</td>' +
        '</tr>';
    }).join('');

    var presetOpts = '<option value="">-- Select preset --</option>';
    (st.presets || []).forEach(function (p, i) {
        presetOpts += '<option value="' + i + '">' + p.name + ' (' + p.model + ')</option>';
    });

    host.innerHTML =
        '<div class="card">' +
            '<div class="card-title">Parameters — ' + st.model + '</div>' +
            '<div style="font-size:12px; color:var(--text2); margin-bottom:10px;">' +
            'Edit each parameter. Tick <em>Freeze</em> to fix during regression (Phase 3).</div>' +
            '<table class="dtable">' +
                '<thead><tr><th>Key</th><th>Label</th><th>Unit</th><th>Value</th><th>Range</th><th>Freeze</th></tr></thead>' +
                '<tbody>' + paramRowsHTML + '</tbody>' +
            '</table>' +
            '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">' +
                '<button class="btn btn-secondary" id="prism_params_reset">Reset to defaults</button>' +
                '<input type="text" id="prism_preset_name" placeholder="Preset name" ' +
                    'style="padding:5px 8px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;">' +
                '<button class="btn btn-secondary" id="prism_preset_save">Save preset</button>' +
                '<select id="prism_preset_picker" style="padding:5px 8px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;">' +
                    presetOpts +
                '</select>' +
                '<button class="btn btn-secondary" id="prism_preset_load">Load</button>' +
                '<button class="btn btn-secondary" id="prism_preset_del">Delete</button>' +
            '</div>' +
            '<div id="prism_params_msg" style="margin-top:8px; font-size:12px; color:var(--text2); min-height:16px;"></div>' +
        '</div>' +
        '<div class="card">' +
            '<div class="card-title" style="display:flex; align-items:center; justify-content:space-between;">' +
                '<span>Live Forward Simulation</span>' +
                '<button class="btn btn-secondary" id="prism_params_reset_view" title="Reset zoom to fit all data" style="font-size:11px; padding:4px 10px;">⟳ Reset view</button>' +
            '</div>' +
            '<div style="font-size:12px; color:var(--text2); margin-bottom:8px;">' +
            'Curve recomputed on every edit using td = logspace(0.001, 1000, 100). Drag a rectangle to zoom.</div>' +
            '<div style="background:var(--bg1); border:1px solid var(--border); border-radius:6px; padding:6px;">' +
                '<canvas id="prism_params_canvas" style="width:100%; height:calc(100vh - 360px); min-height:480px; display:block;"></canvas>' +
            '</div>' +
            '<div id="prism_params_simmsg" style="margin-top:6px; font-size:11px; color:var(--text3);"></div>' +
        '</div>';

    // Wire reset-view for params canvas.
    var pResetBtn = $('prism_params_reset_view');
    if (pResetBtn) pResetBtn.onclick = function () {
        var c = $('prism_params_canvas');
        if (c) {
            try { delete c._prismOriginalScale; } catch (_) { c._prismOriginalScale = null; }
            try { delete c._prismHandlers; }      catch (_) { c._prismHandlers = null; }
            try { delete c._prismAxes; }          catch (_) { c._prismAxes = null; }
        }
        if (typeof PRiSM_recomputeAndDrawParamCurve === 'function') PRiSM_recomputeAndDrawParamCurve();
    };

    // Wire param inputs (live preview).
    host.querySelectorAll('[data-prism-pkey]').forEach(function (inp) {
        inp.oninput = inp.onchange = function () {
            var k = inp.dataset.prismPkey;
            var v;
            if (inp.tagName === 'SELECT') v = inp.value;
            else { v = parseFloat(inp.value); if (isNaN(v)) return; }
            window.PRiSM_state.params[k] = v;
            PRiSM_recomputeAndDrawParamCurve();
        };
    });
    host.querySelectorAll('[data-prism-fkey]').forEach(function (chk) {
        chk.onchange = function () {
            var k = chk.dataset.prismFkey;
            window.PRiSM_state.paramFreeze[k] = chk.checked;
        };
    });

    $('prism_params_reset').onclick = function () {
        var defs = current.defaults || {};
        window.PRiSM_state.params = {};
        for (var k in defs) window.PRiSM_state.params[k] = defs[k];
        PRiSM_renderParamsTab();
    };

    $('prism_preset_save').onclick = function () {
        var name = ($('prism_preset_name').value || '').trim();
        if (!name) {
            $('prism_params_msg').innerHTML = '<span style="color:var(--red);">Enter a preset name.</span>';
            return;
        }
        st.presets = st.presets || [];
        st.presets.push({
            name: name,
            model: st.model,
            params: JSON.parse(JSON.stringify(st.params)),
            paramFreeze: JSON.parse(JSON.stringify(st.paramFreeze))
        });
        PRiSM_persistPresets();
        $('prism_params_msg').innerHTML = '<span style="color:var(--green);">Saved preset \"' + name + '\".</span>';
        PRiSM_renderParamsTab();
    };

    $('prism_preset_load').onclick = function () {
        var idx = parseInt($('prism_preset_picker').value, 10);
        if (isNaN(idx) || !st.presets[idx]) return;
        var p = st.presets[idx];
        if (p.model && window.PRiSM_MODELS[p.model]) st.model = p.model;
        st.params = JSON.parse(JSON.stringify(p.params || {}));
        st.paramFreeze = JSON.parse(JSON.stringify(p.paramFreeze || {}));
        PRiSM_renderParamsTab();
        $('prism_params_msg').innerHTML = '<span style="color:var(--green);">Loaded preset \"' + p.name + '\".</span>';
    };

    $('prism_preset_del').onclick = function () {
        var idx = parseInt($('prism_preset_picker').value, 10);
        if (isNaN(idx) || !st.presets[idx]) return;
        st.presets.splice(idx, 1);
        PRiSM_persistPresets();
        PRiSM_renderParamsTab();
    };

    PRiSM_recomputeAndDrawParamCurve();
}

function PRiSM_recomputeAndDrawParamCurve() {
    var st = window.PRiSM_state;
    var canvas = $('prism_params_canvas');
    if (!canvas) return;
    var td;
    try {
        td = (typeof PRiSM_logspace === 'function')
            ? PRiSM_logspace(-3, 3, 100)
            : (function () {
                var arr = [];
                for (var i = 0; i < 100; i++) arr.push(Math.pow(10, -3 + 6 * i / 99));
                return arr;
            })();
    } catch (e) { return; }

    var curve = PRiSM_evalModelCurve(st.model, st.params, td);
    if (!curve) {
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Model evaluation failed.', canvas.width / 2, canvas.height / 2);
        $('prism_params_simmsg').textContent = 'Forward simulation could not be computed for current params.';
        return;
    }
    st.modelCurve = curve;

    // Draw using the bourdet plotter — overlay-only mode (no measured data).
    var data = { t: curve.td, p: curve.pd };
    if (curve.pdPrime) data.dp = curve.pdPrime;
    try {
        if (typeof window.PRiSM_plot_bourdet === 'function') {
            window.PRiSM_plot_bourdet(canvas, data, {
                title: 'Forward Simulation — ' + st.model,
                xLabel: 'tD',
                yLabel: 'pD, pD′',
                showLegend: true,
                hover: true,
                dragZoom: true
            });
        }
    } catch (e) {
        console.warn('Param-tab plot failed:', e.message);
    }
    $('prism_params_simmsg').textContent = 'Curve: 100 points, td ∈ [10^-3, 10^3]. Updated.';
}


// =========================================================================
// TAB 5 — MATCH
// =========================================================================

function PRiSM_renderMatchTab() {
    var host = $('prism_tab_5');
    if (!host) return;
    var st = window.PRiSM_state;
    var ds = window.PRiSM_dataset;
    var hasData = !!(ds && Array.isArray(ds.t) && ds.t.length);

    host.innerHTML =
        '<div class="card">' +
            '<div class="card-title">Type-Curve Match</div>' +
            (!hasData
                ? '<div class="info-bar" style="background:var(--bg2); border:1px dashed var(--border); padding:14px; border-radius:6px; color:var(--text2); font-size:13px;">' +
                  'Load data in Tab 1 first.</div>'
                : '') +
            '<div style="font-size:12px; color:var(--text2); margin-bottom:10px;">' +
            'Drag the model curve over the data: ←→ to time-match, ↑↓ to pressure-match. Apply when satisfied.</div>' +
            '<div class="cols-2" style="align-items:flex-start;">' +
                '<div>' +
                    '<div class="rbox">' +
                        '<div class="rbox-title">Match Offsets</div>' +
                        '<div class="rrow"><span class="rl">log(time shift)</span><span class="rv" id="prism_match_dt">' + fmt(st.match.timeShift, 4) + '</span></div>' +
                        '<div class="rrow"><span class="rl">pressure shift</span><span class="rv" id="prism_match_dp">' + fmt(st.match.pressShift, 2) + '</span></div>' +
                        '<div class="rrow"><span class="rl">RMSE</span><span class="rv" id="prism_match_rmse">—</span></div>' +
                    '</div>' +
                    '<div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap;">' +
                        '<button class="btn btn-secondary" data-mshift="-0.1" data-mdir="t">⟵ time</button>' +
                        '<button class="btn btn-secondary" data-mshift="0.1"  data-mdir="t">time ⟶</button>' +
                        '<button class="btn btn-secondary" data-mshift="-50"  data-mdir="p">↓ press</button>' +
                        '<button class="btn btn-secondary" data-mshift="50"   data-mdir="p">↑ press</button>' +
                        '<button class="btn btn-secondary" id="prism_match_reset">Reset</button>' +
                    '</div>' +
                    '<div style="margin-top:14px;">' +
                        '<button class="btn btn-primary" id="prism_match_apply">Apply match</button>' +
                    '</div>' +
                    '<div id="prism_match_msg" style="margin-top:8px; font-size:12px; color:var(--text2); min-height:16px;"></div>' +
                '</div>' +
                '<div>' +
                    '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">' +
                        '<span style="font-size:11px; color:var(--text3);">Bourdet diagnostic with overlay · drag rectangle to zoom</span>' +
                        '<button class="btn btn-secondary" id="prism_match_reset_view" title="Reset zoom" style="font-size:11px; padding:4px 10px;">⟳ Reset view</button>' +
                    '</div>' +
                    '<div style="background:var(--bg1); border:1px solid var(--border); border-radius:6px; padding:6px;">' +
                        '<canvas id="prism_match_canvas" style="width:100%; height:calc(100vh - 340px); min-height:500px; display:block; cursor:grab;"></canvas>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Wire match-canvas reset-view (find redraw fn from Match tab body).
    var mResetBtn = $('prism_match_reset_view');
    if (mResetBtn) mResetBtn.onclick = function () {
        var c = $('prism_match_canvas');
        if (c) {
            try { delete c._prismOriginalScale; } catch (_) { c._prismOriginalScale = null; }
            try { delete c._prismHandlers; }      catch (_) { c._prismHandlers = null; }
            try { delete c._prismAxes; }          catch (_) { c._prismAxes = null; }
        }
        // Re-render the match view by toggling tabs (cheap reload).
        if (typeof PRiSM_renderMatchTab === 'function') PRiSM_renderMatchTab();
    };

    if (!hasData) return;

    if (!st.modelCurve) {
        // Try to seed a curve from current params.
        try {
            var td = PRiSM_logspace(-3, 3, 100);
            st.modelCurve = PRiSM_evalModelCurve(st.model, st.params, td);
        } catch (e) { /* ignore */ }
    }

    function refreshMatch() {
        $('prism_match_dt').textContent = fmt(st.match.timeShift, 4);
        $('prism_match_dp').textContent = fmt(st.match.pressShift, 2);
        var canvas = $('prism_match_canvas');
        if (!canvas) return;
        var data = { t: ds.t, p: ds.p, q: ds.q };
        if (ds.dp) data.dp = ds.dp;
        if (st.modelCurve) {
            var sh = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                      st.match.timeShift, st.match.pressShift);
            data.overlay = { t: sh.t, p: sh.p };
        }
        try {
            window.PRiSM_plot_bourdet(canvas, data, {
                hover: true, dragZoom: true, showLegend: true,
                title: 'Match — ' + st.model
            });
        } catch (e) { /* ignore */ }
        // RMSE between data and shifted model.
        if (st.modelCurve) {
            var sh2 = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                       st.match.timeShift, st.match.pressShift);
            var rmse = PRiSM_computeRMSE(ds.t, ds.p, sh2.t, sh2.p);
            $('prism_match_rmse').textContent = isFinite(rmse) ? fmt(rmse, 3) : '—';
        }
    }

    host.querySelectorAll('[data-mshift]').forEach(function (b) {
        b.onclick = function () {
            var d = parseFloat(b.dataset.mshift);
            if (b.dataset.mdir === 't') st.match.timeShift += d;
            else st.match.pressShift += d;
            refreshMatch();
        };
    });
    $('prism_match_reset').onclick = function () {
        st.match.timeShift = 0;
        st.match.pressShift = 0;
        refreshMatch();
    };

    // Drag interaction on canvas — translates the overlay.
    var canvas = $('prism_match_canvas');
    if (canvas) {
        var dragging = false;
        var startX = 0, startY = 0;
        var startDt = 0, startDp = 0;
        canvas.addEventListener('mousedown', function (ev) {
            dragging = true;
            startX = ev.clientX;
            startY = ev.clientY;
            startDt = st.match.timeShift;
            startDp = st.match.pressShift;
            canvas.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', function (ev) {
            if (!dragging) return;
            var dx = ev.clientX - startX;
            var dy = ev.clientY - startY;
            // log-time: 1 decade per ~300px, pressure: ~1 psi per pixel scaled
            st.match.timeShift = startDt + dx / 300;
            st.match.pressShift = startDp - dy * 2;
            refreshMatch();
        });
        window.addEventListener('mouseup', function () {
            if (dragging) { dragging = false; canvas.style.cursor = 'grab'; }
        });
    }

    $('prism_match_apply').onclick = function () {
        // Standard log-log type-curve match: PM = (kh / 141.2 q μ B) and
        // TM = (0.000264 k / φ μ ct rw²). Here we don't know unit dims yet,
        // so we just push the offsets into "Cd" and "S" via the formulas
        //   S_new ≈ S_old - 0.5 · pressShift / (some scale)  (placeholder)
        //   Cd_new ≈ Cd_old · 10^(timeShift)                  (placeholder)
        // Phase 3 will replace this with proper unit-aware match equations.
        var cur = window.PRiSM_state.params;
        if (cur.Cd != null) cur.Cd = cur.Cd * Math.pow(10, st.match.timeShift);
        if (cur.S  != null) cur.S  = cur.S - 0.5 * (st.match.pressShift / 100);
        // Recompute curve from new params, reset shifts.
        st.match.timeShift = 0;
        st.match.pressShift = 0;
        try {
            var td = PRiSM_logspace(-3, 3, 100);
            st.modelCurve = PRiSM_evalModelCurve(st.model, st.params, td);
        } catch (e) { /* ignore */ }
        $('prism_match_msg').innerHTML = '<span style="color:var(--green);">Match applied. Visit Tab 4 to see the new params.</span>';
        refreshMatch();
    };

    refreshMatch();
}


// =========================================================================
// TAB 6 — REGRESS — Levenberg-Marquardt regression + Auto-match
// =========================================================================

function PRiSM_renderRegressTab() {
    var host = $('prism_tab_6');
    if (!host) return;
    var st = window.PRiSM_state || {};
    var current = window.PRiSM_MODELS && window.PRiSM_MODELS[st.model];
    var hasLM = typeof window.PRiSM_runRegression === 'function';
    var hasAuto = typeof window.PRiSM_autoMatch === 'function';
    var hasInterp = typeof window.PRiSM_interpretFit === 'function';

    // Param table for the active model with Fix/Float toggles + initial values.
    var paramRows = '';
    if (current && current.paramSpec) {
        current.paramSpec.forEach(function (s) {
            if (typeof s.default !== 'number') return; // skip categorical params
            var v = (st.params && st.params[s.key] != null) ? st.params[s.key] : s['default'];
            var frozen = !!(st.paramFreeze && st.paramFreeze[s.key]);
            paramRows += '<tr>' +
                '<td>' + s.key + '</td>' +
                '<td style="font-size:11px; color:var(--text2);">' + s.label + '</td>' +
                '<td><input type="number" step="any" id="prism_reg_' + s.key + '" value="' + v + '" style="width:90px;"/></td>' +
                '<td style="font-size:11px; color:var(--text3);">' + (s.unit || '-') + '</td>' +
                '<td><label style="font-size:11px; cursor:pointer;"><input type="checkbox" id="prism_reg_freeze_' + s.key + '"' + (frozen ? ' checked' : '') + '/> freeze</label></td>' +
                '</tr>';
        });
    }

    host.innerHTML =
        '<div style="display:flex; flex-direction:column; gap:14px;">' +
            // ── Action bar ─────────────────────────────────────────────
            '<div class="card">' +
                '<div class="card-title">Non-Linear Regression</div>' +
                '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">' +
                    '<button class="btn btn-primary" id="prism_regress_run"' + (hasLM ? '' : ' disabled') + '>Run regression</button>' +
                    '<button class="btn btn-secondary" id="prism_regress_auto"' + (hasAuto ? '' : ' disabled') + '>Run auto-match</button>' +
                    '<span style="font-size:11px; color:var(--text3);">Active model: <b>' + st.model + '</b> · Levenberg-Marquardt + Jacobian CIs + AIC scoring</span>' +
                '</div>' +
                '<div id="prism_regress_status" style="font-size:12px; color:var(--text2); min-height:18px;"></div>' +
            '</div>' +
            // ── Two-column layout ──────────────────────────────────────
            '<div class="cols-2">' +
                // Initial params + freeze toggles
                '<div class="card">' +
                    '<div class="card-title">Initial Parameters</div>' +
                    (paramRows
                        ? '<table class="dtable"><thead><tr><th>Key</th><th>Label</th><th>Initial</th><th>Unit</th><th>Mode</th></tr></thead><tbody>' + paramRows + '</tbody></table>'
                        : '<div style="color:var(--text3); font-style:italic;">No floating params for this model.</div>') +
                    '<div style="margin-top:8px; font-size:11px; color:var(--text3);">Edit initial guesses; toggle freeze to lock a parameter at its current value during the fit.</div>' +
                '</div>' +
                // Fit results panel — populated by Run
                '<div class="card">' +
                    '<div class="card-title">Fit Results</div>' +
                    '<div id="prism_regress_results" style="min-height:200px;">' +
                        '<div style="color:var(--text3); font-style:italic;">Click <b>Run regression</b> to fit the active model, or <b>Run auto-match</b> to race the candidate set ranked by AIC.</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            // ── Auto-match results panel ──────────────────────────────
            '<div class="card">' +
                '<div class="card-title">Auto-Match Ranking</div>' +
                '<div id="prism_automatch_panel" style="min-height:120px;">' +
                    '<div style="color:var(--text3); font-style:italic;">Auto-match races candidate models against your data and ranks by AIC. Click <b>Run auto-match</b> above to start.</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    // ── Wire: Run regression on the active model ───────────────────────
    $('prism_regress_run').onclick = function () {
        if (!hasLM) { alert('Regression engine not loaded.'); return; }
        // Pull initial values + freeze flags from the form into PRiSM_state.
        if (current && current.paramSpec) {
            current.paramSpec.forEach(function (s) {
                if (typeof s.default !== 'number') return;
                var inp = $('prism_reg_' + s.key);
                var fz  = $('prism_reg_freeze_' + s.key);
                if (inp) {
                    var v = parseFloat(inp.value);
                    if (isFinite(v)) {
                        st.params = st.params || {};
                        st.params[s.key] = v;
                    }
                }
                if (fz) {
                    st.paramFreeze = st.paramFreeze || {};
                    st.paramFreeze[s.key] = !!fz.checked;
                }
            });
        }
        $('prism_regress_status').innerHTML = '<span style="color:var(--accent);">Running Levenberg-Marquardt fit…</span>';
        try {
            var res = window.PRiSM_runRegression();
            // Stash into state so other tabs (Report, interpretation) can see it.
            window.PRiSM_state.lastFit = {
                modelKey: st.model,
                params:   res.params || st.params,
                stderr:   res.stderr,
                ci95:     res.ci95,
                CI95:     res.ci95,
                AIC:      res.aic,
                R2:       res.r2,
                RMSE:     res.rmse,
                iterations: res.iterations,
                converged:  res.converged,
                timestamp: new Date().toISOString()
            };
            PRiSM_renderRegressionResultsInto($('prism_regress_results'), window.PRiSM_state.lastFit);
            $('prism_regress_status').innerHTML = '<span style="color:var(--green);">✓ Fit complete (' + (res.iterations || '?') + ' iterations, ' + (res.converged ? 'converged' : 'NOT converged') + ').</span>';
            if (typeof window.PRiSM_drawActivePlot === 'function') window.PRiSM_drawActivePlot();
        } catch (e) {
            $('prism_regress_status').innerHTML = '<span style="color:var(--red);">Error: ' + e.message + '</span>';
        }
    };

    // ── Wire: Run auto-match (races candidates ranked by AIC) ──────────
    $('prism_regress_auto').onclick = function () {
        if (!hasAuto) { alert('Auto-match not loaded.'); return; }
        $('prism_regress_status').innerHTML = '<span style="color:var(--accent);">Auto-match running… (races candidate models in parallel)</span>';
        Promise.resolve(window.PRiSM_autoMatch())
            .then(function (result) {
                if (typeof window.PRiSM_renderAutoMatchPanel === 'function') {
                    window.PRiSM_renderAutoMatchPanel($('prism_automatch_panel'), result);
                } else {
                    $('prism_automatch_panel').innerHTML = '<pre style="font-size:11px; color:var(--text2);">' + JSON.stringify(result, null, 2).slice(0, 800) + '</pre>';
                }
                var bestStr = result.bestKey ? ('best = <b>' + result.bestKey + '</b>') : '(no best)';
                $('prism_regress_status').innerHTML = '<span style="color:var(--green);">✓ Auto-match done in ' + (result.elapsedMs || '?') + ' ms. ' + bestStr + '. ' + (result.classification && result.classification.summary ? result.classification.summary : '') + '</span>';
            })
            .catch(function (e) {
                $('prism_regress_status').innerHTML = '<span style="color:var(--red);">Auto-match error: ' + (e && e.message || e) + '</span>';
            });
    };
}

// Helper: paint a fit-result block (used by Tab 6 + the Report tab).
function PRiSM_renderRegressionResultsInto(container, fit) {
    if (!container || !fit) return;
    var paramRows = '';
    if (fit.params) {
        for (var k in fit.params) {
            if (!Object.prototype.hasOwnProperty.call(fit.params, k)) continue;
            var v = fit.params[k];
            var ci = fit.CI95 && fit.CI95[k];
            var ciTxt = (ci && ci.length === 2 && isFinite(ci[0]) && isFinite(ci[1]))
                ? '[' + ci[0].toFixed(3) + ', ' + ci[1].toFixed(3) + ']'
                : '—';
            var stderr = fit.stderr && fit.stderr[k];
            var seTxt = (typeof stderr === 'number' && isFinite(stderr)) ? stderr.toExponential(2) : '—';
            paramRows += '<tr><td><b>' + k + '</b></td><td>' + (typeof v === 'number' ? v.toPrecision(6) : v) + '</td><td>' + seTxt + '</td><td>' + ciTxt + '</td></tr>';
        }
    }
    var fmtN = function (x, dp) { return (typeof x === 'number' && isFinite(x)) ? x.toFixed(dp != null ? dp : 4) : '—'; };
    container.innerHTML =
        '<div style="display:flex; flex-direction:column; gap:10px;">' +
            '<div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">' +
                '<div><span style="color:var(--text3);">R²:</span> <b>' + fmtN(fit.R2, 5) + '</b></div>' +
                '<div><span style="color:var(--text3);">RMSE:</span> <b>' + fmtN(fit.RMSE, 4) + '</b></div>' +
                '<div><span style="color:var(--text3);">AIC:</span> <b>' + fmtN(fit.AIC, 2) + '</b></div>' +
                '<div><span style="color:var(--text3);">Iterations:</span> <b>' + (fit.iterations != null ? fit.iterations : '—') + '</b></div>' +
                '<div><span style="color:var(--text3);">Converged:</span> <b style="color:' + (fit.converged ? 'var(--green)' : 'var(--red)') + ';">' + (fit.converged ? 'yes' : 'no') + '</b></div>' +
            '</div>' +
            '<table class="dtable"><thead><tr><th>Param</th><th>Value</th><th>Stderr</th><th>95% CI</th></tr></thead><tbody>' +
                (paramRows || '<tr><td colspan="4" style="color:var(--text3);">No params.</td></tr>') +
            '</tbody></table>' +
        '</div>';
}


// =========================================================================
// TAB 7 — REPORT
// =========================================================================

function PRiSM_renderReportTab() {
    var host = $('prism_tab_7');
    if (!host) return;
    var st = window.PRiSM_state;
    var ds = window.PRiSM_dataset;
    var current = window.PRiSM_MODELS[st.model] || {};

    var paramRows = '';
    if (current.paramSpec) {
        current.paramSpec.forEach(function (s) {
            var v = (st.params[s.key] != null) ? st.params[s.key] : s['default'];
            paramRows += '<tr><td>' + s.key + '</td><td>' + s.label + '</td>' +
                         '<td>' + fmt(v, 4) + '</td><td>' + (s.unit || '-') + '</td></tr>';
        });
    }

    var rmseTxt = '—';
    if (st.modelCurve && ds && ds.t && ds.p) {
        var sh = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd, st.match.timeShift, st.match.pressShift);
        var r = PRiSM_computeRMSE(ds.t, ds.p, sh.t, sh.p);
        if (isFinite(r)) rmseTxt = fmt(r, 3);
    }

    host.innerHTML =
        '<div class="card">' +
            '<div class="card-title">Results &amp; Report</div>' +
            '<div class="cols-2">' +
                '<div>' +
                    '<div class="rbox">' +
                        '<div class="rbox-title">Summary</div>' +
                        '<div class="rrow"><span class="rl">Model</span><span class="rv">' + st.model + '</span></div>' +
                        '<div class="rrow"><span class="rl">Mode</span><span class="rv">' + ((window.PRiSM && window.PRiSM.mode) || 'transient') + '</span></div>' +
                        '<div class="rrow"><span class="rl">Data points</span><span class="rv">' + (ds && ds.t ? ds.t.length : 0) + '</span></div>' +
                        '<div class="rrow"><span class="rl">Time-match</span><span class="rv">' + fmt(st.match.timeShift, 4) + '</span></div>' +
                        '<div class="rrow"><span class="rl">Pressure-match</span><span class="rv">' + fmt(st.match.pressShift, 2) + '</span></div>' +
                        '<div class="rrow"><span class="rl">RMSE</span><span class="rv">' + rmseTxt + '</span></div>' +
                    '</div>' +
                '</div>' +
                '<div>' +
                    '<table class="dtable">' +
                        '<thead><tr><th>Key</th><th>Label</th><th>Value</th><th>Unit</th></tr></thead>' +
                        '<tbody>' + (paramRows || '<tr><td colspan="4" style="color:var(--text3);">No params.</td></tr>') + '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +
            '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">' +
                '<button class="btn btn-primary" id="prism_report_pdf">Export PDF</button>' +
                '<button class="btn btn-secondary" id="prism_report_csv">Export CSV</button>' +
                '<span style="font-size:11px; color:var(--text3);">PDF uses cover page + client info from the host app.</span>' +
            '</div>' +
            '<div id="prism_report_msg" style="margin-top:8px; font-size:12px; color:var(--text2); min-height:16px;"></div>' +
        '</div>';

    $('prism_report_pdf').onclick = function () {
        try {
            var html = PRiSM_buildReportHTML();
            if (typeof exportReport === 'function') {
                exportReport('PRiSM Analysis — ' + st.model, html);
            } else {
                $('prism_report_msg').innerHTML = '<span style="color:var(--red);">exportReport not available in this build.</span>';
            }
        } catch (e) {
            $('prism_report_msg').innerHTML = '<span style="color:var(--red);">Export failed: ' + e.message + '</span>';
        }
    };

    $('prism_report_csv').onclick = function () {
        try {
            PRiSM_exportCSV();
            $('prism_report_msg').innerHTML = '<span style="color:var(--green);">CSV download started.</span>';
        } catch (e) {
            $('prism_report_msg').innerHTML = '<span style="color:var(--red);">CSV export failed: ' + e.message + '</span>';
        }
    };
}

// Build the report HTML block (used by Export PDF).
function PRiSM_buildReportHTML() {
    var st = window.PRiSM_state;
    var ds = window.PRiSM_dataset;
    var current = window.PRiSM_MODELS[st.model] || {};

    // Render Bourdet + Cartesian to offscreen canvases at 900x500.
    function offscreen(plotFn) {
        var c = document.createElement('canvas');
        c.width = 900; c.height = 500;
        var data = { t: (ds && ds.t) || [], p: (ds && ds.p) || [], q: (ds && ds.q) || null };
        if (ds && ds.dp) data.dp = ds.dp;
        if (st.modelCurve) {
            var sh = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                      st.match.timeShift, st.match.pressShift);
            data.overlay = { t: sh.t, p: sh.p };
        }
        try { plotFn(c, data, { hover: false, dragZoom: false, showLegend: true }); }
        catch (e) { /* ignore */ }
        return c.toDataURL('image/png');
    }

    var bourdetImg = (typeof window.PRiSM_plot_bourdet === 'function')
        ? offscreen(window.PRiSM_plot_bourdet) : null;
    var cartImg    = (typeof window.PRiSM_plot_cartesian === 'function')
        ? offscreen(window.PRiSM_plot_cartesian) : null;

    var paramRows = '';
    if (current.paramSpec) {
        current.paramSpec.forEach(function (s) {
            var v = (st.params[s.key] != null) ? st.params[s.key] : s['default'];
            paramRows += '<tr><td><b>' + s.key + '</b></td><td>' + s.label + '</td>' +
                         '<td>' + fmt(v, 4) + ' ' + (s.unit || '-') + '</td></tr>';
        });
    }

    var rmseTxt = '—';
    if (st.modelCurve && ds && ds.t && ds.p) {
        var sh2 = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                   st.match.timeShift, st.match.pressShift);
        var r = PRiSM_computeRMSE(ds.t, ds.p, sh2.t, sh2.p);
        if (isFinite(r)) rmseTxt = fmt(r, 3);
    }

    var html = '';
    html += '<h2>PRiSM Well Test Analysis</h2>';
    html += '<h3>Model: ' + st.model + '</h3>';
    html += '<p><em>' + (current.description || '') + '</em></p>';
    html += '<table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:14px;">' +
            '<thead><tr><th align="left">Key</th><th align="left">Label</th><th align="left">Value (unit)</th></tr></thead>' +
            '<tbody>' + paramRows + '</tbody></table>';
    html += '<table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:18px;">' +
            '<tr><td><b>Mode</b></td><td>' + ((window.PRiSM && window.PRiSM.mode) || 'transient') + '</td></tr>' +
            '<tr><td><b>Data points</b></td><td>' + (ds && ds.t ? ds.t.length : 0) + '</td></tr>' +
            '<tr><td><b>Time-match</b></td><td>' + fmt(st.match.timeShift, 4) + '</td></tr>' +
            '<tr><td><b>Pressure-match</b></td><td>' + fmt(st.match.pressShift, 2) + '</td></tr>' +
            '<tr><td><b>RMSE</b></td><td>' + rmseTxt + '</td></tr>' +
            '</table>';
    if (bourdetImg) {
        html += '<h3>Log-Log Bourdet Diagnostic</h3>';
        html += '<img src="' + bourdetImg + '" style="width:100%; max-width:900px; height:auto; border:1px solid #ddd;"/>';
    }
    if (cartImg) {
        html += '<h3>Cartesian Pressure vs Time</h3>';
        html += '<img src="' + cartImg + '" style="width:100%; max-width:900px; height:auto; border:1px solid #ddd; margin-top:8px;"/>';
    }
    if (current.reference) {
        html += '<h3>Reference</h3><p style="font-size:12px;">' + current.reference + '</p>';
    }
    return html;
}

// CSV exporter — t, p, dp, model_p, model_dp.
function PRiSM_exportCSV() {
    var st = window.PRiSM_state;
    var ds = window.PRiSM_dataset;
    if (!ds || !ds.t || !ds.t.length) throw new Error('No dataset loaded');

    var hasDp = !!(ds.dp && ds.dp.length === ds.t.length);
    var modelP = null, modelDp = null;
    if (st.modelCurve) {
        // Interpolate model onto the data times.
        var sh = PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                   st.match.timeShift, st.match.pressShift);
        function interp(t, ts, ys) {
            if (t <= ts[0]) return ys[0];
            if (t >= ts[ts.length - 1]) return ys[ys.length - 1];
            for (var i = 1; i < ts.length; i++) {
                if (ts[i] >= t) {
                    var f = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
                    return ys[i - 1] + f * (ys[i] - ys[i - 1]);
                }
            }
            return NaN;
        }
        modelP = ds.t.map(function (t) { return interp(t, sh.t, sh.p); });
        if (st.modelCurve.pdPrime) {
            modelDp = ds.t.map(function (t) {
                return interp(t, st.modelCurve.td, st.modelCurve.pdPrime);
            });
        }
    }

    var headers = ['t', 'p'];
    if (hasDp) headers.push('dp');
    if (modelP) headers.push('model_p');
    if (modelDp) headers.push('model_dp');

    var lines = [headers.join(',')];
    for (var i = 0; i < ds.t.length; i++) {
        var row = [ds.t[i], ds.p[i]];
        if (hasDp) row.push(ds.dp[i]);
        if (modelP) row.push(modelP[i]);
        if (modelDp) row.push(modelDp[i]);
        lines.push(row.map(function (v) {
            return (v == null || isNaN(v)) ? '' : String(v);
        }).join(','));
    }

    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'prism_' + st.model + '_' + Date.now() + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}


// =========================================================================
// TAB-SWITCH HOOK — wrap window.PRiSM.setTab so each switch renders
// =========================================================================

// The shell's setTab is created inside renderPRiSM(). It may not exist yet
// at the moment this layer loads. Install a polling installer that wraps
// setTab as soon as it is defined (and re-wraps on each subsequent call to
// renderPRiSM, since that resets window.PRiSM.setTab).
function PRiSM_installSetTabHook() {
    if (!window.PRiSM || typeof window.PRiSM.setTab !== 'function') return false;
    if (window.PRiSM.setTab._prismWired) return true;
    var orig = window.PRiSM.setTab;
    var wrapped = function (n) {
        orig(n);
        n = parseInt(n, 10);
        if (n === 2) PRiSM_renderPlotsTab();
        else if (n === 3) PRiSM_renderModelTab();
        else if (n === 4) PRiSM_renderParamsTab();
        else if (n === 5) PRiSM_renderMatchTab();
        else if (n === 6) PRiSM_renderRegressTab();
        else if (n === 7) PRiSM_renderReportTab();
    };
    wrapped._prismWired = true;
    window.PRiSM.setTab = wrapped;
    return true;
}

// Try once now (in case shell is already up).
if (!PRiSM_installSetTabHook()) {
    // Otherwise watch for the shell to come online. Cheap interval (250ms)
    // capped at 30s — once wired, the watcher self-cancels.
    var hookTries = 0;
    var hookInterval = setInterval(function () {
        hookTries++;
        if (PRiSM_installSetTabHook() || hookTries > 120) clearInterval(hookInterval);
    }, 250);
}

// Also wrap the originating renderPRiSM so that re-renders re-install the hook.
if (typeof window.renderPRiSM === 'function' && !window.renderPRiSM._prismWired) {
    var origRender = window.renderPRiSM;
    var wrappedRender = function (body) {
        origRender(body);
        // Defer slightly so the shell has set up window.PRiSM.setTab.
        setTimeout(PRiSM_installSetTabHook, 0);
    };
    wrappedRender._prismWired = true;
    try { window.renderPRiSM = wrappedRender; } catch (e) { /* may be const in IIFE — fall back to interval */ }
}


// =========================================================================
// SELF-TEST
// =========================================================================
(function PRiSM_uiWiringSelfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var checks = [
        { name: 'PRiSM_state seeded',          ok: !!window.PRiSM_state },
        { name: 'PRiSM_state.activePlot set',  ok: !!window.PRiSM_state.activePlot },
        { name: 'PRiSM_MODELS not empty',      ok: !!window.PRiSM_MODELS && Object.keys(window.PRiSM_MODELS).length > 0 },
        { name: 'plot registry populated',     ok: Object.keys(PRISM_PLOT_REGISTRY).length === 14 },
        { name: 'render fns defined',          ok: typeof PRiSM_renderPlotsTab === 'function' &&
                                                   typeof PRiSM_renderModelTab === 'function' &&
                                                   typeof PRiSM_renderParamsTab === 'function' &&
                                                   typeof PRiSM_renderMatchTab === 'function' &&
                                                   typeof PRiSM_renderRegressTab === 'function' &&
                                                   typeof PRiSM_renderReportTab === 'function' }
    ];
    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) console.error('PRiSM UI-wiring self-test FAILED:', fails);
    else log('PRiSM UI-wiring self-test passed (' + checks.length + ' checks).');
})();

})();
