// =============================================================================
// PRiSM ─ Layer 11 — Cross-cutting polish
//   1. SVG schematics          — PRiSM_getModelSchematic(modelKey)
//   2. Plot line tools         — click-on-plot straight-line / slope analyses
//                                (PRiSM_analysisKeys, PRiSM_armAnalysisKey,
//                                 PRiSM_runAnalysisKey, PRiSM_renderAnalysisKeyToolbar)
//   3. PNG / PDF export        — PRiSM_exportPlotPNG / PRiSM_exportReportPDF /
//                                PRiSM_renderPlotToCanvas / PRiSM_listPlots
//   4. Usage analytics (GA4)   — PRiSM_tabHooks.any + prism:model-changed /
//                                prism:fit-updated listeners (no wrappers)
// -----------------------------------------------------------------------------
// This layer adds NO new reservoir model. It provides model diagrams, the
// classic straight-line and slope analyses a well-test engineer performs by
// clicking on a diagnostic plot, a PDF/PNG export that bakes the canvas plots
// in as PNG data URLs, and analytics events.
//
// Units: field units throughout. Δt in hours, p in psia, q in STB/d (oil) or
// Mscf/d (gas), k in md, h / rw / distances in ft, ct in 1/psi, μ in cp,
// C in bbl/psi.
//
// Inputs come from the shared Well & Test store (window.PRiSM_getWell, C1)
// and the shared analysis data (window.PRiSM_getAnalysisData, C2). When an
// input is a default (or the store is absent) the result carries an amber
// "default inputs" warning — values are never silently invented.
//
// Results go to PRiSM_state.analysisKeyResults[key] (never PRiSM_state.params).
//
// Conventions:
//   - Single outer IIFE (this whole file). Public symbols on window.PRiSM_*.
//   - No external dependencies — pure vanilla JS, SVG strings only.
//   - No polling installers and no function wrapping: mounting goes through
//     the C7 registries (PRiSM_registerTabPanel / PRiSM_tabPanels,
//     PRiSM_tabHooks) and window CustomEvents.
//   - Every cross-module call is guarded with typeof checks.
// =============================================================================

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window : globalThis;
var _hasDoc = (typeof document !== 'undefined') && !!document &&
              typeof document.createElement === 'function';

function _on(target, type, fn) {
    try {
        if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
    } catch (e) { /* stub environments */ }
}

function _emit(type, detail) {
    try {
        if (typeof G.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
        G.dispatchEvent(new CustomEvent(type, { detail: detail }));
    } catch (e) { /* non-fatal */ }
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Toast helper — re-uses a host toast() if present, otherwise a one-shot
// floating div (bottom of the viewport, phone-safe width).
function _polishToast(msg, kind) {
    kind = kind || 'info';
    if (typeof G.toast === 'function') {
        try { G.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    try { console.log('[PRiSM] ' + msg); } catch (e) { /* silent */ }
    if (!_hasDoc || !document.body) return;
    try {
        var existing = document.getElementById('prism_polish_toast');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var div = document.createElement('div');
        div.id = 'prism_polish_toast';
        div.setAttribute('role', 'status');
        div.style.cssText =
            'position:fixed; bottom:16px; right:16px; z-index:99999;' +
            'background:var(--bg2, #161b22); color:var(--text, #e6edf3);' +
            'border:1px solid ' + (kind === 'error' ? 'var(--red, #f85149)' :
                                   kind === 'success' ? 'var(--green, #3fb950)' :
                                   kind === 'warn' ? 'var(--yellow, #d29922)' : 'var(--border, #30363d)') + ';' +
            'padding:10px 14px; border-radius:6px; font:13px sans-serif;' +
            'box-shadow:0 4px 12px rgba(0,0,0,.4); max-width:min(340px, calc(100vw - 32px));' +
            'line-height:1.4; box-sizing:border-box; overflow-wrap:anywhere;';
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(function () {
            if (div.parentNode) div.parentNode.removeChild(div);
        }, 4500);
    } catch (e) { /* silent */ }
}

// C7 panel registration: prefer the shell helper, else merge into the registry.
function _registerTabPanel(n, spec) {
    if (typeof G.PRiSM_registerTabPanel === 'function') {
        try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
    }
    G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
    var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
    }
    arr.push(spec);
}

// =========================================================================
// SECTION 1 — SVG SCHEMATICS
// =========================================================================
// 400×300 viewbox, dark theme. Colour palette:
//   stroke #8b949e — line-work / annotations
//   fill   #161b22 — backgrounds
//   accent #f0883e — wells / fractures (orange)
//   accent #3fb950 — matrix blocks (green, double-porosity)
//   accent #58a6ff — pressure isobars (blue)
//   tint   #21262d — caprock / base-rock layers
// =========================================================================

// ---- Re-usable sub-fragments --------------------------------------------

// Backdrop rectangle (the canvas bg).
function _svg_backdrop() {
    return '<rect x="0" y="0" width="400" height="300" fill="#161b22"/>';
}

// Caprock band at top of reservoir (y..y+h grey).
function _svg_caprock(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="#21262d" stroke="#8b949e" stroke-width="0.5"/>' +
           '<text x="26" y="' + (y + h / 2 + 4) + '" font-size="9" fill="#8b949e">caprock</text>';
}

// Base-rock band at bottom of reservoir.
function _svg_baserock(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="#21262d" stroke="#8b949e" stroke-width="0.5"/>' +
           '<text x="26" y="' + (y + h / 2 + 4) + '" font-size="9" fill="#8b949e">base-rock</text>';
}

// Reservoir sand body (stippled).
function _svg_sand(y, h) {
    return '<rect x="20" y="' + y + '" width="360" height="' + h + '" ' +
           'fill="url(#sandPattern)" stroke="#8b949e" stroke-width="0.5"/>';
}

// Sand pattern <defs>. Stippled dots over a slightly tinted background.
function _svg_defs() {
    return '<defs>' +
           '<pattern id="sandPattern" patternUnits="userSpaceOnUse" width="6" height="6">' +
               '<rect width="6" height="6" fill="#1c2128"/>' +
               '<circle cx="2" cy="2" r="0.6" fill="#3a4350"/>' +
               '<circle cx="5" cy="4" r="0.5" fill="#3a4350"/>' +
           '</pattern>' +
           '<pattern id="fracPattern" patternUnits="userSpaceOnUse" width="3" height="3">' +
               '<rect width="3" height="3" fill="#161b22"/>' +
               '<circle cx="1.5" cy="1.5" r="0.6" fill="#f0883e"/>' +
           '</pattern>' +
           '<linearGradient id="fcGrad" x1="0" y1="0" x2="1" y2="0">' +
               '<stop offset="0" stop-color="#f0883e" stop-opacity="0.95"/>' +
               '<stop offset="1" stop-color="#f0883e" stop-opacity="0.35"/>' +
           '</linearGradient>' +
           '<radialGradient id="presGrad" cx="0.5" cy="0.5" r="0.5">' +
               '<stop offset="0"   stop-color="#58a6ff" stop-opacity="0.55"/>' +
               '<stop offset="0.6" stop-color="#58a6ff" stop-opacity="0.18"/>' +
               '<stop offset="1"   stop-color="#58a6ff" stop-opacity="0"/>' +
           '</radialGradient>' +
           '</defs>';
}

// Vertical wellbore (filled column from y0 to y1 at x).
function _svg_vwell(x, y0, y1, color) {
    color = color || '#f0883e';
    return '<rect x="' + (x - 4) + '" y="' + y0 + '" width="8" height="' + (y1 - y0) + '" ' +
           'fill="#0d1117" stroke="' + color + '" stroke-width="1.5"/>' +
           '<line x1="' + x + '" y1="' + y0 + '" x2="' + x + '" y2="' + y1 + '" ' +
           'stroke="' + color + '" stroke-width="1" stroke-dasharray="2,2"/>';
}

// Horizontal lateral (filled rod at depth y from x0 to x1).
function _svg_hwell(x0, x1, y, color) {
    color = color || '#f0883e';
    return '<rect x="' + x0 + '" y="' + (y - 4) + '" width="' + (x1 - x0) + '" height="8" ' +
           'fill="#0d1117" stroke="' + color + '" stroke-width="1.5"/>';
}

// Surface arrow + "well" label at top of vertical well at x.
function _svg_well_label(x, label) {
    return '<polygon points="' + (x - 5) + ',12 ' + (x + 5) + ',12 ' + x + ',24" ' +
           'fill="#f0883e" stroke="#f0883e"/>' +
           '<text x="' + (x + 10) + '" y="20" font-size="10" fill="#c9d1d9">' + label + '</text>';
}

// Pressure isobar circles centred at (cx, cy) with N rings.
function _svg_isobars(cx, cy, rMax, n) {
    var s = '';
    for (var i = 1; i <= n; i++) {
        var r = rMax * (i / n);
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' +
             'fill="none" stroke="#58a6ff" stroke-width="0.6" stroke-opacity="' +
             (0.7 - i * 0.12).toFixed(2) + '" stroke-dasharray="3,3"/>';
    }
    return s;
}

// Caption below the diagram.
function _svg_caption(text) {
    return '<text x="200" y="290" font-size="10" fill="#8b949e" text-anchor="middle" font-style="italic">' +
           text + '</text>';
}

// SVG open + defs + backdrop. Caller appends body fragments + close.
function _svg_open() {
    return '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" ' +
           'style="width:100%; height:auto; max-height:280px; display:block;">' +
           _svg_defs() + _svg_backdrop();
}
function _svg_close() { return '</svg>'; }


// ---- Per-model schematics -----------------------------------------------

// 1. Homogeneous — vertical well perforated through full thickness, isobars.
function _schematic_homogeneous() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Isobars centred on the well at mid-reservoir.
    s += '<ellipse cx="200" cy="150" rx="170" ry="78" ' +
         'fill="url(#presGrad)"/>';
    s += _svg_isobars(200, 150, 150, 4);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Perforation tics across full sand interval.
    for (var y = 80; y < 225; y += 12) {
        s += '<line x1="196" y1="' + y + '" x2="186" y2="' + y + '" ' +
             'stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="204" y1="' + y + '" x2="214" y2="' + y + '" ' +
             'stroke="#f0883e" stroke-width="1"/>';
    }
    s += _svg_well_label(200, 'producer');
    s += '<text x="350" y="160" font-size="10" fill="#58a6ff" text-anchor="end">isobars</text>';
    s += _svg_caption('Vertical well, infinite homogeneous reservoir, full-interval perforations');
    s += _svg_close();
    return s;
}

// 2. Infinite-conductivity vertical fracture — bi-wing planar fracture.
function _schematic_infiniteFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Planar bi-wing fracture (orange line through full thickness).
    s += '<rect x="80" y="78" width="240" height="144" ' +
         'fill="#f0883e" fill-opacity="0.18" stroke="none"/>';
    s += '<line x1="80" y1="150" x2="320" y2="150" ' +
         'stroke="#f0883e" stroke-width="3"/>';
    // Fracture tip lines top & bottom.
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="1" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="1" stroke-dasharray="3,3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // xf annotation arrows.
    s += '<line x1="200" y1="245" x2="320" y2="245" stroke="#8b949e" stroke-width="1" marker-end="url(#arrEnd)"/>';
    s += '<text x="260" y="260" font-size="11" fill="#c9d1d9" text-anchor="middle" font-style="italic">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Vertical well intersected by an infinite-conductivity bi-wing fracture');
    s += _svg_close();
    return s;
}

// 3. Finite-conductivity fracture — width gradient indicates finite k_f w_f.
function _schematic_finiteFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Bi-wing fracture as a filled ellipse-ish band that thins toward tips.
    s += '<polygon points="200,143 320,148 320,152 200,157" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7"/>';
    s += '<polygon points="200,143 80,148 80,152 200,157" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7" transform="scale(-1,1) translate(-400,0)"/>';
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Annotation: F_CD = (kf · wf) / (k · xf)
    s += '<text x="200" y="248" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">' +
         'F_CD = (k_f &#183; w_f) / (k &#183; x_f)</text>';
    s += '<line x1="200" y1="262" x2="320" y2="262" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="260" y="275" font-size="10" fill="#c9d1d9" text-anchor="middle">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Finite-conductivity fracture (width gradient ~ flux distribution)');
    s += _svg_close();
    return s;
}

// 4. Finite-conductivity fracture with face skin — damage band along faces.
function _schematic_finiteFracSkin() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Damage band (faded red) around the fracture.
    s += '<rect x="80" y="142" width="240" height="16" fill="#da3633" fill-opacity="0.22" stroke="none"/>';
    // Fracture body.
    s += '<polygon points="200,144 320,148 320,152 200,156" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7"/>';
    s += '<polygon points="200,144 80,148 80,152 200,156" fill="url(#fcGrad)" stroke="#f0883e" stroke-width="0.7" transform="scale(-1,1) translate(-400,0)"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    s += '<line x1="80"  y1="78" x2="80"  y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<line x1="320" y1="78" x2="320" y2="222" stroke="#f0883e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    s += '<text x="120" y="138" font-size="9" fill="#da3633" font-style="italic">damage band (S_f)</text>';
    s += '<line x1="200" y1="248" x2="320" y2="248" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="260" y="262" font-size="10" fill="#c9d1d9" text-anchor="middle">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Finite-conductivity fracture with face skin (damaged faces)');
    s += _svg_close();
    return s;
}

// 5. Inclined wellbore — angled column through reservoir, θ_w labelled.
function _schematic_inclined() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Angle ~ 30° from vertical. Wellbore from (200, 24) to (260, 230).
    var x0 = 200, y0 = 24, x1 = 260, y1 = 230;
    s += '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y1 + '" ' +
         'stroke="#f0883e" stroke-width="6" stroke-linecap="round"/>';
    s += '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y1 + '" ' +
         'stroke="#0d1117" stroke-width="3" stroke-dasharray="2,2"/>';
    // Vertical reference dashed line.
    s += '<line x1="200" y1="30" x2="200" y2="100" stroke="#8b949e" stroke-width="0.7" stroke-dasharray="3,3"/>';
    // Angle arc.
    s += '<path d="M 200 70 A 40 40 0 0 1 217 84" fill="none" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="222" y="78" font-size="11" fill="#58a6ff" font-style="italic">&#952;_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Inclined wellbore, full reservoir thickness, deviation angle &#952;_w');
    s += _svg_close();
    return s;
}

// 6. Horizontal well — lateral in mid-reservoir, length L, standoff z_w.
function _schematic_horizontal() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Vertical descent
    s += _svg_vwell(80, 24, 150, '#f0883e');
    // Horizontal lateral
    s += _svg_hwell(80, 360, 150, '#f0883e');
    // L annotation
    s += '<line x1="80" y1="178" x2="360" y2="178" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="80" y1="173" x2="80" y2="183" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="360" y1="173" x2="360" y2="183" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="220" y="194" font-size="11" fill="#c9d1d9" text-anchor="middle" font-style="italic">L</text>';
    // z_w annotation (standoff from bottom)
    s += '<line x1="370" y1="150" x2="370" y2="230" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="365" y1="150" x2="375" y2="150" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="365" y1="230" x2="375" y2="230" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="380" y="194" font-size="10" fill="#c9d1d9" font-style="italic">z_w</text>';
    s += _svg_well_label(80, 'producer');
    s += _svg_caption('Horizontal lateral well in centre of reservoir, length L');
    s += _svg_close();
    return s;
}

// 7. Partial-penetration fracture — vertical fracture with hf < h, centred at z_w.
function _schematic_partialPenFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Fracture covers 60% of reservoir, centred.
    s += '<rect x="80" y="115" width="240" height="70" fill="#f0883e" fill-opacity="0.22" stroke="#f0883e" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="80" y1="150" x2="320" y2="150" stroke="#f0883e" stroke-width="3"/>';
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // hf annotation
    s += '<line x1="335" y1="115" x2="335" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="330" y1="115" x2="340" y2="115" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="330" y1="185" x2="340" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="345" y="155" font-size="11" fill="#c9d1d9" font-style="italic">h_f</text>';
    // h annotation (full reservoir)
    s += '<line x1="370" y1="70" x2="370" y2="230" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="2,2"/>';
    s += '<text x="380" y="155" font-size="10" fill="#8b949e" font-style="italic">h</text>';
    // z_w label
    s += '<text x="200" y="248" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">centred at z_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Partial-penetration fracture, height h_f &lt; h, centred at z_w');
    s += _svg_close();
    return s;
}

// 8. Linear sealing fault — producer + image well across single fault.
function _schematic_linearBoundary() {
    var s = _svg_open();
    // Plan-view: dark map background.
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Sealing fault line (vertical, at x=300).
    s += '<line x1="300" y1="50" x2="300" y2="250" stroke="#da3633" stroke-width="3"/>';
    s += '<text x="306" y="62" font-size="10" fill="#da3633">sealing fault</text>';
    // Hatching to denote sealing nature.
    for (var i = 0; i < 12; i++) {
        var yy = 60 + i * 16;
        s += '<line x1="300" y1="' + yy + '" x2="312" y2="' + (yy - 8) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producing well (orange dot) at x=180, y=150.
    s += '<circle cx="180" cy="150" r="6" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="170" y="135" font-size="10" fill="#f0883e">well</text>';
    // Image well (faded) at x=420 (off-canvas) — show at x=355 with dashed circle.
    s += '<circle cx="420" cy="150" r="6" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-dasharray="2,2"/>';
    s += '<text x="412" y="135" font-size="10" fill="#58a6ff" text-anchor="middle">image</text>';
    // Distance L annotations
    s += '<line x1="180" y1="180" x2="300" y2="180" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<text x="240" y="195" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">L</text>';
    s += '<line x1="300" y1="180" x2="370" y2="180" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<text x="335" y="195" font-size="10" fill="#8b949e" text-anchor="middle" font-style="italic">L</text>';
    s += _svg_caption('Producer near a single sealing fault, image well at 2L');
    s += _svg_close();
    return s;
}

// 9. Parallel-channel — producer mid-channel between two parallel boundaries.
function _schematic_parallelChannel() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Two horizontal parallel sealing faults, top y=80, bottom y=220.
    s += '<line x1="20" y1="80" x2="380" y2="80" stroke="#da3633" stroke-width="3"/>';
    s += '<line x1="20" y1="220" x2="380" y2="220" stroke="#da3633" stroke-width="3"/>';
    // Hatching
    for (var i = 0; i < 18; i++) {
        var xx = 30 + i * 20;
        s += '<line x1="' + xx + '" y1="80" x2="' + (xx - 8) + '" y2="72" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="' + xx + '" y1="220" x2="' + (xx - 8) + '" y2="228" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producer in centre.
    s += '<circle cx="200" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="190" y="138" font-size="10" fill="#f0883e">well</text>';
    // W width annotation.
    s += '<line x1="350" y1="80" x2="350" y2="220" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<line x1="345" y1="80" x2="355" y2="80" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<line x1="345" y1="220" x2="355" y2="220" stroke="#8b949e" stroke-width="0.8"/>';
    s += '<text x="362" y="155" font-size="11" fill="#c9d1d9" font-style="italic">W</text>';
    // d_w (distance to nearest boundary)
    s += '<line x1="220" y1="80" x2="220" y2="150" stroke="#8b949e" stroke-width="0.6" stroke-dasharray="2,2"/>';
    s += '<text x="227" y="118" font-size="9" fill="#8b949e" font-style="italic">d_w</text>';
    s += _svg_caption('Producer in mid-channel between two parallel sealing boundaries');
    s += _svg_close();
    return s;
}

// 10. Closed rectangle — producer in centre, four sealing sides.
function _schematic_closedRectangle() {
    var s = _svg_open();
    // Outer (background)
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Inner sealed rectangle
    s += '<rect x="50" y="70" width="300" height="160" fill="#161b22" stroke="#da3633" stroke-width="3"/>';
    // Hatching on all 4 sides (indicates sealed)
    for (var i = 0; i < 14; i++) {
        var xx = 60 + i * 22;
        s += '<line x1="' + xx + '" y1="70" x2="' + (xx - 6) + '" y2="64" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="' + xx + '" y1="230" x2="' + (xx - 6) + '" y2="236" stroke="#da3633" stroke-width="0.7"/>';
    }
    for (var j = 0; j < 7; j++) {
        var yy = 80 + j * 22;
        s += '<line x1="50" y1="' + yy + '" x2="44" y2="' + (yy - 6) + '" stroke="#da3633" stroke-width="0.7"/>';
        s += '<line x1="350" y1="' + yy + '" x2="356" y2="' + (yy - 6) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Producer in centre
    s += '<circle cx="200" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="208" y="146" font-size="10" fill="#f0883e">well</text>';
    // Dimensions
    s += '<text x="200" y="58" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">a</text>';
    s += '<text x="40" y="155" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">b</text>';
    s += _svg_caption('Producer at centre of fully closed rectangular drainage area');
    s += _svg_close();
    return s;
}

// 11. Intersecting faults — two faults at angle θ.
function _schematic_intersecting() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Faults intersect at (260, 150) — fault A horizontal to right, fault B at 45°.
    var ix = 260, iy = 150;
    s += '<line x1="' + ix + '" y1="' + iy + '" x2="380" y2="' + iy + '" stroke="#da3633" stroke-width="3"/>';
    s += '<line x1="' + ix + '" y1="' + iy + '" x2="380" y2="50" stroke="#da3633" stroke-width="3"/>';
    // Hatching along fault A
    for (var i = 0; i < 6; i++) {
        var xx = 270 + i * 18;
        s += '<line x1="' + xx + '" y1="' + iy + '" x2="' + (xx - 6) + '" y2="' + (iy - 8) + '" stroke="#da3633" stroke-width="0.7"/>';
    }
    // Angle arc at intersection.
    s += '<path d="M 295 150 A 35 35 0 0 0 285 121" fill="none" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="306" y="138" font-size="11" fill="#58a6ff" font-style="italic">&#952;</text>';
    // Producer well to the south-west of intersection.
    s += '<circle cx="170" cy="180" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="120" y="175" font-size="10" fill="#f0883e">well</text>';
    s += _svg_caption('Two intersecting sealing faults, included angle &#952;');
    s += _svg_close();
    return s;
}

// 12. Double-porosity — cube of fractured matrix blocks.
function _schematic_doublePorosity() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Grid of matrix blocks (4x3 grid).
    var x0 = 50, y0 = 70, bw = 70, bh = 50;
    for (var col = 0; col < 4; col++) {
        for (var row = 0; row < 3; row++) {
            var xx = x0 + col * bw + col * 6;
            var yy = y0 + row * bh + row * 6;
            s += '<rect x="' + xx + '" y="' + yy + '" width="' + bw + '" height="' + bh + '" ' +
                 'fill="#3fb950" fill-opacity="0.32" stroke="#3fb950" stroke-width="0.7"/>';
            s += '<text x="' + (xx + bw / 2) + '" y="' + (yy + bh / 2 + 3) + '" font-size="8" fill="#3fb950" text-anchor="middle">m</text>';
        }
    }
    // Fracture network (darker) — gaps between blocks already present;
    // overlay tiny lines for clarity.
    for (var col2 = 1; col2 < 4; col2++) {
        var fx = x0 + col2 * bw + (col2 - 0.5) * 6;
        s += '<line x1="' + fx + '" y1="' + y0 + '" x2="' + fx + '" y2="' + (y0 + 3 * bh + 12) + '" ' +
             'stroke="#161b22" stroke-width="3"/>';
    }
    for (var row2 = 1; row2 < 3; row2++) {
        var fy = y0 + row2 * bh + (row2 - 0.5) * 6;
        s += '<line x1="' + x0 + '" y1="' + fy + '" x2="' + (x0 + 4 * bw + 18) + '" y2="' + fy + '" ' +
             'stroke="#161b22" stroke-width="3"/>';
    }
    s += '<text x="50" y="62" font-size="10" fill="#3fb950">matrix (light) + fracture network (dark)</text>';
    s += '<text x="50" y="252" font-size="10" fill="#c9d1d9" font-style="italic">' +
         '&#969; = storativity ratio,  &#955; = inter-porosity flow</text>';
    s += _svg_close();
    return s;
}

// 13. Partial penetration — vertical wellbore, perforated only over hp.
function _schematic_partialPen() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    // Perforations only over central 40% of sand interval (hp < h).
    var pTop = 130, pBot = 180;
    for (var y2 = pTop; y2 <= pBot; y2 += 8) {
        s += '<line x1="196" y1="' + y2 + '" x2="180" y2="' + y2 + '" stroke="#f0883e" stroke-width="1.5"/>';
        s += '<line x1="204" y1="' + y2 + '" x2="220" y2="' + y2 + '" stroke="#f0883e" stroke-width="1.5"/>';
    }
    // hp annotation
    s += '<line x1="245" y1="' + pTop + '" x2="245" y2="' + pBot + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="240" y1="' + pTop + '" x2="250" y2="' + pTop + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="240" y1="' + pBot + '" x2="250" y2="' + pBot + '" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="255" y="160" font-size="11" fill="#c9d1d9" font-style="italic">h_p</text>';
    // h annotation
    s += '<line x1="285" y1="70" x2="285" y2="230" stroke="#8b949e" stroke-width="0.8" stroke-dasharray="2,2"/>';
    s += '<text x="295" y="155" font-size="10" fill="#8b949e" font-style="italic">h</text>';
    // z_w marker
    s += '<line x1="170" y1="155" x2="180" y2="155" stroke="#58a6ff" stroke-width="1"/>';
    s += '<text x="155" y="158" font-size="9" fill="#58a6ff" font-style="italic">z_w</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Vertical well with partial penetration (perfs over h_p &lt; h)');
    s += _svg_close();
    return s;
}

// 14. Vertical pulse / observation pair — producer + observation point at Δz.
function _schematic_verticalPulse() {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    // Producer (left), observation (right).
    s += _svg_vwell(140, 24, 230, '#f0883e');
    s += _svg_vwell(280, 24, 230, '#58a6ff');
    // Active perfs on producer at (z_w_prod = 180).
    for (var y3 = 170; y3 <= 200; y3 += 6) {
        s += '<line x1="136" y1="' + y3 + '" x2="124" y2="' + y3 + '" stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="144" y1="' + y3 + '" x2="156" y2="' + y3 + '" stroke="#f0883e" stroke-width="1"/>';
    }
    // Observation point at (z_obs = 110).
    s += '<circle cx="280" cy="110" r="5" fill="#58a6ff" stroke="#58a6ff" stroke-width="2"/>';
    s += '<text x="290" y="114" font-size="10" fill="#58a6ff">observation</text>';
    // Δz annotation
    s += '<line x1="240" y1="110" x2="240" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="235" y1="110" x2="245" y2="110" stroke="#8b949e" stroke-width="1"/>';
    s += '<line x1="235" y1="185" x2="245" y2="185" stroke="#8b949e" stroke-width="1"/>';
    s += '<text x="248" y="152" font-size="11" fill="#c9d1d9" font-style="italic">&#916;z</text>';
    // Pulse arrows
    s += '<path d="M 156 175 Q 200 130 270 115" fill="none" stroke="#58a6ff" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += _svg_well_label(140, 'pulser');
    s += _svg_caption('Producer/injector + observation well at vertical separation &#916;z');
    s += _svg_close();
    return s;
}

// =========================================================================
// SECTION 1b — Additional schematics (round-2 fix: cover all 45 models)
// =========================================================================
// Compact diagrams for the remaining models in the registry. Use shared
// helpers for layered reservoirs / observation pairs / decline curves to
// keep total LOC manageable.

// ---- Shared helpers for the 1b additions --------------------------------

// Generic N-layer reservoir block (rectangles stacked vertically).
// Each layer gets a coloured fill + label. Returns SVG fragment + bottom Y.
function _svg_layers(x, y, w, layerSpecs) {
    // layerSpecs: [{label, h, color, opacity?}]
    var s = '';
    var yy = y;
    for (var i = 0; i < layerSpecs.length; i++) {
        var L = layerSpecs[i];
        s += '<rect x="' + x + '" y="' + yy + '" width="' + w + '" height="' + L.h + '" ' +
             'fill="' + (L.color || '#3fb950') + '" fill-opacity="' + (L.opacity || 0.22) + '" ' +
             'stroke="' + (L.color || '#3fb950') + '" stroke-width="0.7"/>';
        s += '<text x="' + (x + 6) + '" y="' + (yy + L.h / 2 + 3) + '" font-size="9" fill="#c9d1d9">' + L.label + '</text>';
        yy += L.h;
    }
    return { svg: s, bottom: yy };
}

// Cross-flow arrow between two y-levels (inside the well column).
function _svg_xflowArrow(x, y1, y2, color) {
    color = color || '#58a6ff';
    var dir = (y2 > y1) ? 1 : -1;
    var ay = y2 - dir * 4;
    return '<line x1="' + x + '" y1="' + y1 + '" x2="' + x + '" y2="' + y2 + '" stroke="' + color +
           '" stroke-width="1" stroke-dasharray="2,2"/>' +
           '<polygon points="' + (x - 3) + ',' + ay + ' ' + (x + 3) + ',' + ay + ' ' + x + ',' + y2 +
           '" fill="' + color + '"/>';
}

// Sealing fault tick-line (red line + hatching).
function _svg_seal(x1, y1, x2, y2, hatchSide) {
    hatchSide = hatchSide || 'right';
    var s = '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#da3633" stroke-width="2.5"/>';
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    var nx = -dy / len, ny = dx / len;
    if (hatchSide === 'left') { nx = -nx; ny = -ny; }
    var n = 10;
    for (var i = 1; i < n; i++) {
        var t = i / n;
        var mx = x1 + dx * t, my = y1 + dy * t;
        s += '<line x1="' + mx + '" y1="' + my + '" x2="' + (mx + nx * 6) + '" y2="' + (my + ny * 6) +
             '" stroke="#da3633" stroke-width="0.7"/>';
    }
    return s;
}

// Mini decline-curve plot in a box. expressionType is 'exp', 'hyp', 'harm',
// 'duong', 'sepd', 'fetkovich'.
function _svg_declineCurve(x, y, w, h, type, label) {
    var s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
            '" fill="#0d1117" stroke="#30363d" stroke-width="0.7"/>';
    // Axes
    s += '<line x1="' + (x + 8) + '" y1="' + (y + 8) + '" x2="' + (x + 8) + '" y2="' + (y + h - 12) +
         '" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<line x1="' + (x + 8) + '" y1="' + (y + h - 12) + '" x2="' + (x + w - 8) + '" y2="' + (y + h - 12) +
         '" stroke="#8b949e" stroke-width="0.6"/>';
    // Curve
    var pts = '', N = 40;
    for (var i = 0; i < N; i++) {
        var u = i / (N - 1);                         // 0..1
        var qFrac;
        switch (type) {
            case 'exp':       qFrac = Math.exp(-3.5 * u);                                    break;
            case 'harm':      qFrac = 1 / (1 + 5 * u);                                       break;
            case 'hyp':       qFrac = Math.pow(1 + 4.5 * u, -1.4);                           break;
            case 'duong':     qFrac = Math.pow(1 + 0.05 * u * 80, -1.3) * (1 + 0.1 * u * 80) / (1 + 8); break;
            case 'sepd':      qFrac = Math.exp(-Math.pow(4 * u, 0.6));                       break;
            case 'fetkovich': qFrac = (u < 0.3) ? 1 - 0.6 * u : Math.exp(-3 * (u - 0.3));    break;
            default:          qFrac = Math.exp(-2 * u);
        }
        var px = x + 8 + u * (w - 16);
        var py = y + h - 12 - qFrac * (h - 24);
        pts += (i ? ' L ' : 'M ') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    s += '<path d="' + pts + '" fill="none" stroke="#f0883e" stroke-width="1.6"/>';
    // Label
    s += '<text x="' + (x + w / 2) + '" y="' + (y + 8) + '" font-size="9" fill="#c9d1d9" text-anchor="middle">' + label + '</text>';
    s += '<text x="' + (x + 4) + '" y="' + (y + 12) + '" font-size="7" fill="#8b949e">q</text>';
    s += '<text x="' + (x + w - 14) + '" y="' + (y + h - 3) + '" font-size="7" fill="#8b949e">t</text>';
    return s;
}

// Small inline observation well at (x, y_obs) with target marker.
function _svg_obswell(x, ySurface, yObs, color) {
    color = color || '#58a6ff';
    var s = '<polygon points="' + (x - 4) + ',12 ' + (x + 4) + ',12 ' + x + ',22" fill="' + color + '"/>';
    s += '<rect x="' + (x - 3) + '" y="' + ySurface + '" width="6" height="' + (yObs - ySurface) +
         '" fill="#0d1117" stroke="' + color + '" stroke-width="1"/>';
    s += '<circle cx="' + x + '" cy="' + yObs + '" r="4" fill="' + color + '" stroke="' + color + '" stroke-width="1.5"/>';
    return s;
}

// ---- Schematics for the 32 remaining models -----------------------------

// 15. Closed channel (3-sided: parallelChannel + one closed end).
function _schematic_closedChannel3() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Top + bottom parallel sealing faults
    s += _svg_seal(20, 80, 380, 80, 'right');
    s += _svg_seal(20, 220, 380, 220, 'left');
    // Closed end on the right (vertical sealing line)
    s += _svg_seal(380, 80, 380, 220, 'left');
    // Producer
    s += '<circle cx="160" cy="150" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="148" y="138" font-size="10" fill="#f0883e">well</text>';
    // Width annotation
    s += '<line x1="345" y1="80" x2="345" y2="220" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<text x="355" y="155" font-size="11" fill="#c9d1d9" font-style="italic">W</text>';
    // Distance to closed end
    s += '<line x1="160" y1="240" x2="380" y2="240" stroke="#8b949e" stroke-width="0.6" stroke-dasharray="2,2"/>';
    s += '<text x="265" y="252" font-size="9" fill="#8b949e" font-style="italic">d_end</text>';
    s += _svg_caption('Producer in 3-sided closed channel (two parallel + one closing boundary)');
    s += _svg_close();
    return s;
}

// 16. Fog / partial-transmissibility boundary.
function _schematic_fogBoundary() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Partial fault — orange/amber dashed line (not solid red sealing).
    s += '<line x1="20" y1="150" x2="380" y2="150" stroke="#f0883e" stroke-width="2.5" stroke-dasharray="6,4"/>';
    // Fog symbol — blurry pressure communication across the line.
    for (var i = 0; i < 12; i++) {
        var xx = 50 + i * 25;
        s += '<circle cx="' + xx + '" cy="150" r="3" fill="#f0883e" fill-opacity="0.35"/>';
    }
    s += '<text x="200" y="142" font-size="10" fill="#f0883e" text-anchor="middle">partially sealing — transmissibility &#964; &#8712; (-1, 1)</text>';
    // Producer
    s += '<circle cx="200" cy="200" r="7" fill="#f0883e" stroke="#f0883e" stroke-width="2"/>';
    s += '<text x="208" y="196" font-size="10" fill="#f0883e">well</text>';
    // Pressure isobars on producer side
    s += _svg_isobars(200, 200, 70, 4);
    // Distance annotation
    s += '<line x1="200" y1="158" x2="200" y2="195" stroke="#8b949e" stroke-width="0.7" stroke-dasharray="2,2"/>';
    s += '<text x="208" y="180" font-size="9" fill="#8b949e" font-style="italic">L</text>';
    s += _svg_caption('Producer + leaky/fog boundary: transmissibility &#964; sets sealed (1) ↔ fully open (-1)');
    s += _svg_close();
    return s;
}

// 17-20. Decline-curve schematics (Arps / Duong / SEPD / Fetkovich).
function _schematic_arps() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(40,  60,  150, 100, 'exp',  'b = 0 (exponential)');
    s += _svg_declineCurve(210, 60,  150, 100, 'harm', 'b = 1 (harmonic)');
    s += _svg_declineCurve(40,  175, 150, 75,  'hyp',  'b ∈ (0, 1) hyperbolic');
    s += '<text x="285" y="200" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_i / (1 + b·D_i·t)^(1/b)</text>';
    s += '<text x="285" y="220" font-size="9" fill="#8b949e" text-anchor="middle">Arps (1945)</text>';
    s += _svg_caption('Arps decline — three regimes (exp / hyp / harmonic) by b-factor');
    s += _svg_close();
    return s;
}
function _schematic_duong() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'duong', 'Duong shale rate-time');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_1 · t^(-m) · exp[a/(1-m) (t^(1-m) - 1)]</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Duong (2011) — for transient shale gas/oil</text>';
    s += _svg_close();
    return s;
}
function _schematic_sepd() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'sepd', 'Stretched Exponential');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">q(t) = q_i · exp[-(t/τ)^n]</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Valko (2009) — finite-EUR decline form</text>';
    s += _svg_close();
    return s;
}
function _schematic_fetkovich() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_declineCurve(60, 60, 280, 140, 'fetkovich', 'Fetkovich type curve');
    s += '<text x="200" y="225" font-size="10" fill="#c9d1d9" text-anchor="middle">Transient → BDF blend (closed-circle implied geometry)</text>';
    s += '<text x="200" y="245" font-size="9" fill="#8b949e" text-anchor="middle">Fetkovich (JPT Jun 1980)</text>';
    s += _svg_close();
    return s;
}

// 21. Radial composite — two concentric zones, mobility ratio M.
function _schematic_radialComposite() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    // Outer zone
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#3fb950" fill-opacity="0.10" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="' + (cx + 80) + '" y="' + (cy - 70) + '" font-size="10" fill="#3fb950">k_2, &#956;_2</text>';
    // Inner zone
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="55" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="' + (cx - 6) + '" y="' + (cy + 36) + '" font-size="10" fill="#58a6ff">k_1, &#956;_1</text>';
    // Producer at centre
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 28) + '" y="' + (cy - 8) + '" font-size="10" fill="#f0883e">well</text>';
    // Interface radius R
    s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + 55) + '" y2="' + cy + '" stroke="#c9d1d9" stroke-dasharray="2,2"/>';
    s += '<text x="' + (cx + 25) + '" y="' + (cy - 4) + '" font-size="9" fill="#c9d1d9" font-style="italic">R</text>';
    s += '<text x="200" y="60" font-size="11" fill="#c9d1d9" text-anchor="middle">Mobility ratio M = (k/&#956;)_2 / (k/&#956;)_1</text>';
    s += _svg_caption('Radial composite reservoir — inner zone + outer zone of different mobility');
    s += _svg_close();
    return s;
}

// 22. Linear composite — vertical bands of different mobility.
function _schematic_linearComposite() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var bands = [
        { x: 20,  w: 110, color: '#58a6ff', label: 'k_1' },
        { x: 130, w: 110, color: '#3fb950', label: 'k_2' },
        { x: 240, w: 140, color: '#a371f7', label: 'k_3' }
    ];
    for (var i = 0; i < bands.length; i++) {
        var b = bands[i];
        s += '<rect x="' + b.x + '" y="40" width="' + b.w + '" height="220" fill="' + b.color +
             '" fill-opacity="0.15" stroke="' + b.color + '" stroke-width="0.7"/>';
        s += '<text x="' + (b.x + b.w / 2) + '" y="60" font-size="11" fill="' + b.color +
             '" text-anchor="middle">' + b.label + '</text>';
    }
    // Discontinuities (vertical dashed)
    s += '<line x1="130" y1="40" x2="130" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="240" y1="40" x2="240" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    // Producer in zone 1
    s += '<circle cx="80" cy="150" r="6" fill="#f0883e"/>';
    s += '<text x="68" y="170" font-size="10" fill="#f0883e">well</text>';
    // Distance labels
    s += '<text x="130" y="278" font-size="9" fill="#8b949e" text-anchor="middle">L_1</text>';
    s += '<text x="240" y="278" font-size="9" fill="#8b949e" text-anchor="middle">L_2</text>';
    s += _svg_caption('Linear composite — discontinuities at L_1, L_2 (up to 5 zones)');
    s += _svg_close();
    return s;
}

// 23. Two-layer with cross-flow.
function _schematic_twoLayerXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += '<rect x="20" y="65" width="360" height="80" fill="#3fb950" fill-opacity="0.18" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="34" y="108" font-size="10" fill="#3fb950">Layer 1 — k_1, &#966;_1, h_1</text>';
    s += '<rect x="20" y="145" width="360" height="80" fill="#58a6ff" fill-opacity="0.18" stroke="#58a6ff" stroke-width="0.7"/>';
    s += '<text x="34" y="188" font-size="10" fill="#58a6ff">Layer 2 — k_2, &#966;_2, h_2</text>';
    s += _svg_baserock(225, 25);
    s += _svg_vwell(200, 24, 225, '#f0883e');
    // Cross-flow arrows
    s += _svg_xflowArrow(170, 100, 170, 175, '#c9d1d9');
    s += _svg_xflowArrow(230, 175, 230, 100, '#c9d1d9');
    s += '<text x="248" y="148" font-size="10" fill="#c9d1d9">&#955; cross-flow</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Two-layer reservoir with PSS cross-flow rate &#955;');
    s += _svg_close();
    return s;
}

// 24. Multi-layer with cross-flow — N stacked layers.
function _schematic_multiLayerXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Cross-flow indicators between adjacent layers
    s += _svg_xflowArrow(176, 95,  176, 145, '#c9d1d9');
    s += _svg_xflowArrow(176, 145, 176, 195, '#c9d1d9');
    s += _svg_xflowArrow(176, 195, 176, 245, '#c9d1d9');
    s += '<text x="100" y="280" font-size="10" fill="#c9d1d9">&#955; controls inter-layer transient flow</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer reservoir (N≤5) with cross-flow between adjacent pairs');
    s += _svg_close();
    return s;
}

// 25. Multi-layer NO cross-flow (commingled).
function _schematic_multiLayerNoXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1 (kh_1, S_1)', h: 60, color: '#3fb950' },
        { label: 'Layer 2 (kh_2, S_2)', h: 60, color: '#58a6ff' },
        { label: 'Layer 3 (kh_3, S_3)', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    // Sealing barriers between layers (red bars)
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    s += '<text x="100" y="280" font-size="10" fill="#c9d1d9">no inter-layer flow → commingled</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer commingled (no cross-flow): rate weighted by kh fraction');
    s += _svg_close();
    return s;
}

// 26. Multi-layer fractured commingled.
function _schematic_mlNoXFFrac() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'frac', h: 60, color: '#3fb950' },
        { label: 'frac', h: 60, color: '#58a6ff' },
        { label: 'frac', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Each layer has a horizontal fracture symbol
    var fracY = [90, 150, 210];
    for (var i = 0; i < fracY.length; i++) {
        s += '<rect x="100" y="' + (fracY[i] - 2) + '" width="200" height="4" fill="#f0883e" fill-opacity="0.7"/>';
    }
    s += '<text x="305" y="90" font-size="9" fill="#f0883e">x_f</text>';
    s += _svg_well_label(200, 'producer');
    s += _svg_caption('Multi-layer fractured commingled (each layer has its own ∞-cond fracture)');
    s += _svg_close();
    return s;
}

// 27. Multi-layer horizontal commingled.
function _schematic_mlNoXFHoriz() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'horiz', h: 60, color: '#3fb950' },
        { label: 'horiz', h: 60, color: '#58a6ff' },
        { label: 'horiz', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(layers.bottom, 20);
    // Vertical riser on left, then horizontal segments per layer
    s += '<rect x="56" y="24" width="8" height="36" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += _svg_hwell(60, 320, 90,  '#f0883e');
    s += _svg_hwell(60, 320, 150, '#f0883e');
    s += _svg_hwell(60, 320, 210, '#f0883e');
    s += _svg_well_label(60, 'multi-lateral horizontal');
    s += _svg_caption('Multi-layer horizontal commingled — one lateral per layer, no XF');
    s += _svg_close();
    return s;
}

// 28. ML horizontal with cross-flow.
function _schematic_mlHorizontalXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2 ← horizontal', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    // Vertical riser
    s += '<rect x="56" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    // Horizontal completion in layer 2
    s += _svg_hwell(60, 340, 135, '#f0883e');
    // Cross-flow arrows
    s += _svg_xflowArrow(280, 110, 280, 160, '#c9d1d9');
    s += _svg_xflowArrow(280, 160, 280, 210, '#c9d1d9');
    s += '<text x="290" y="178" font-size="9" fill="#c9d1d9">&#955; cross-flow</text>';
    s += _svg_well_label(60, 'horizontal');
    s += _svg_caption('Horizontal well in N-layer reservoir with full transient cross-flow');
    s += _svg_close();
    return s;
}

// 29. Inclined well in multi-layer with XF.
function _schematic_inclinedMLXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 60, color: '#3fb950' },
        { label: 'Layer 2', h: 60, color: '#58a6ff' },
        { label: 'Layer 3', h: 60, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    // Inclined well
    s += '<polygon points="105,12 125,12 115,24" fill="#f0883e"/>';
    s += '<line x1="115" y1="24" x2="265" y2="240" stroke="#f0883e" stroke-width="3"/>';
    s += '<text x="150" y="40" font-size="10" fill="#f0883e">inclined &#952;_w</text>';
    // Cross-flow arrows
    s += _svg_xflowArrow(330, 90,  330, 150, '#c9d1d9');
    s += _svg_xflowArrow(330, 150, 330, 210, '#c9d1d9');
    s += _svg_caption('Inclined well penetrating N layers with full transient XF');
    s += _svg_close();
    return s;
}

// 30. Multi-lateral (star pattern) in ML+XF.
function _schematic_multiLatMLXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Vertical riser to mid layer
    s += '<rect x="196" y="24" width="8" height="111" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    // Three lateral legs at junction (mid of layer 2)
    var jx = 200, jy = 135;
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="60"  y2="' + jy + '" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="340" y2="' + jy + '" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="' + jx + '" y1="' + jy + '" x2="' + jx + '" y2="200" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="' + jx + '" cy="' + jy + '" r="5" fill="#f0883e"/>';
    s += _svg_well_label(200, 'multi-lateral');
    s += '<text x="200" y="280" font-size="10" fill="#c9d1d9" text-anchor="middle">N parallel/star segments — superposed line-source coupling</text>';
    s += _svg_close();
    return s;
}

// 31. ML multi-perforation (≤4 perfs at various depths).
function _schematic_mlMultiPerf() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' },
        { label: 'Layer 4', h: 50, color: '#d29922' }
    ]);
    s += layers.svg;
    s += _svg_baserock(layers.bottom, 20);
    s += _svg_vwell(200, 24, layers.bottom, '#f0883e');
    // Perfs at the centre of layers 1, 2, 4 (skipping 3).
    var perfYs = [85, 135, 235];
    for (var i = 0; i < perfYs.length; i++) {
        var y = perfYs[i];
        for (var k = 0; k < 3; k++) {
            s += '<line x1="196" y1="' + (y - 4 + k * 4) + '" x2="170" y2="' + (y - 4 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
            s += '<line x1="204" y1="' + (y - 4 + k * 4) + '" x2="230" y2="' + (y - 4 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
        }
    }
    s += _svg_well_label(200, 'producer (perfs)');
    s += _svg_caption('Multi-perforation in layered reservoir with cross-flow (1-4 perfs)');
    s += _svg_close();
    return s;
}

// 32. General ML no-XF (heterogeneous well types per layer).
function _schematic_generalMLNoXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    // Layer 1: vertical well, Layer 2: fracture, Layer 3: horizontal
    s += '<rect x="20" y="60" width="360" height="60" fill="#3fb950" fill-opacity="0.15" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<text x="34" y="92" font-size="9" fill="#3fb950">Layer 1 — vertical well + WBS</text>';
    s += '<rect x="20" y="120" width="360" height="60" fill="#58a6ff" fill-opacity="0.15" stroke="#58a6ff" stroke-width="0.7"/>';
    s += '<text x="34" y="152" font-size="9" fill="#58a6ff">Layer 2 — hydraulic fracture</text>';
    s += '<rect x="20" y="180" width="360" height="60" fill="#a371f7" fill-opacity="0.15" stroke="#a371f7" stroke-width="0.7"/>';
    s += '<text x="34" y="212" font-size="9" fill="#a371f7">Layer 3 — horizontal completion</text>';
    s += '<rect x="20" y="119" width="360" height="2" fill="#da3633"/>';
    s += '<rect x="20" y="179" width="360" height="2" fill="#da3633"/>';
    s += _svg_baserock(240, 20);
    s += _svg_vwell(200, 24, 121, '#f0883e');                       // vertical perfs in layer 1
    s += '<rect x="100" y="148" width="200" height="4" fill="#f0883e"/>';   // fracture in layer 2
    s += _svg_hwell(60, 340, 210, '#f0883e');                       // horizontal in layer 3
    s += _svg_caption('General multi-layer no-XF — each layer can be a different well/reservoir type');
    s += _svg_close();
    return s;
}

// 33. General heterogeneity radial composite (3 zones).
function _schematic_genHetRadial() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#a371f7" fill-opacity="0.10" stroke="#a371f7" stroke-width="0.7"/>';
    s += '<text x="' + (cx + 80) + '" y="' + (cy - 70) + '" font-size="10" fill="#a371f7">Zone 3</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="65" fill="#3fb950" fill-opacity="0.18" stroke="#3fb950" stroke-width="1"/>';
    s += '<text x="' + (cx + 50) + '" y="' + (cy - 32) + '" font-size="10" fill="#3fb950">Zone 2</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="35" fill="#58a6ff" fill-opacity="0.25" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<text x="' + (cx - 14) + '" y="' + (cy + 28) + '" font-size="10" fill="#58a6ff">Zone 1</text>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 22) + '" y="' + (cy - 8) + '" font-size="9" fill="#f0883e">well</text>';
    s += '<text x="200" y="60" font-size="11" fill="#c9d1d9" text-anchor="middle">Radial composite (3 zones, R₁ &lt; R₂)</text>';
    s += _svg_caption('General heterogeneity — multi-zone radial composite');
    s += _svg_close();
    return s;
}

// 34. General heterogeneity radial+linear composite.
function _schematic_genHetRadialLinear() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 200, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="90" fill="#3fb950" fill-opacity="0.15" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="50" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    // Linear discontinuity (vertical fault on right)
    s += _svg_seal(330, 60, 330, 240, 'left');
    s += '<text x="280" y="55" font-size="9" fill="#da3633">linear fault</text>';
    s += '<text x="200" y="270" font-size="10" fill="#c9d1d9" text-anchor="middle">Radial composite + linear discontinuity</text>';
    s += _svg_close();
    return s;
}

// 35. Two-well interference test.
function _schematic_interference() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += _svg_sand(65, 170);
    s += _svg_baserock(235, 25);
    s += _svg_vwell(110, 24, 235, '#f0883e');
    s += _svg_well_label(110, 'producer');
    s += _svg_obswell(290, 24, 150, '#58a6ff');
    s += '<text x="295" y="170" font-size="10" fill="#58a6ff">observation</text>';
    // Pressure pulse arrows
    s += _svg_isobars(110, 150, 90, 4);
    // Distance annotation
    s += '<line x1="110" y1="252" x2="290" y2="252" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<line x1="110" y1="248" x2="110" y2="256" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<line x1="290" y1="248" x2="290" y2="256" stroke="#8b949e" stroke-width="0.7"/>';
    s += '<text x="200" y="266" font-size="10" fill="#c9d1d9" text-anchor="middle" font-style="italic">r_obs</text>';
    s += _svg_caption('Producer + observation well: pressure response from a flowing well (line-source)');
    s += _svg_close();
    return s;
}

// 36. ML horizontal interference test.
function _schematic_mlHorizInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Producer horizontal in layer 2
    s += '<rect x="36" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += _svg_hwell(40, 200, 135, '#f0883e');
    s += _svg_well_label(40, 'producer');
    // Observation horizontal in same layer
    s += '<rect x="356" y="24" width="8" height="86" fill="#0d1117" stroke="#58a6ff" stroke-width="1.5"/>';
    s += _svg_hwell(220, 360, 135, '#58a6ff');
    s += '<text x="280" y="155" font-size="10" fill="#58a6ff">observation</text>';
    s += _svg_caption('Two horizontal wells in layered reservoir — interference test');
    s += _svg_close();
    return s;
}

// 37. ML multi-perf interference test.
function _schematic_mlMultiPerfInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    // Producer with perfs in layers 1, 3
    s += _svg_vwell(120, 24, 210, '#f0883e');
    for (var k = 0; k < 3; k++) {
        s += '<line x1="116" y1="' + (85 + k * 4) + '" x2="100" y2="' + (85 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
        s += '<line x1="116" y1="' + (185 + k * 4) + '" x2="100" y2="' + (185 + k * 4) + '" stroke="#f0883e" stroke-width="1"/>';
    }
    s += _svg_well_label(120, 'producer');
    // Observation in layer 2
    s += _svg_obswell(280, 24, 135, '#58a6ff');
    s += '<text x="285" y="155" font-size="10" fill="#58a6ff">obs</text>';
    s += _svg_caption('Multi-perforation interference (≤3 producing perfs + 1 observation)');
    s += _svg_close();
    return s;
}

// 38. Inclined-well interference test.
function _schematic_inclinedInterference() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += _svg_sand(65, 170);
    s += _svg_baserock(235, 25);
    // Producer inclined well
    s += '<polygon points="65,12 85,12 75,24" fill="#f0883e"/>';
    s += '<line x1="75" y1="24" x2="180" y2="235" stroke="#f0883e" stroke-width="3"/>';
    s += '<text x="32" y="40" font-size="9" fill="#f0883e">producer &#952;_p</text>';
    // Observation inclined well
    s += '<polygon points="305,12 325,12 315,24" fill="#58a6ff"/>';
    s += '<line x1="315" y1="24" x2="240" y2="235" stroke="#58a6ff" stroke-width="3"/>';
    s += '<text x="305" y="40" font-size="9" fill="#58a6ff">obs &#952;_o</text>';
    s += _svg_caption('Two inclined wells in homogeneous (or double-porosity) reservoir');
    s += _svg_close();
    return s;
}

// 39. Linear-composite interference test.
function _schematic_linearCompInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    s += '<rect x="20" y="40" width="120" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="140" y="40" width="120" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<rect x="260" y="40" width="120" height="220" fill="#a371f7" fill-opacity="0.15"/>';
    s += '<line x1="140" y1="40" x2="140" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<line x1="260" y1="40" x2="260" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<circle cx="60" cy="150" r="6" fill="#f0883e"/>';
    s += '<text x="48" y="170" font-size="10" fill="#f0883e">producer</text>';
    s += _svg_obswell(330, 24, 150, '#58a6ff');
    s += '<text x="306" y="178" font-size="9" fill="#58a6ff">observation</text>';
    s += _svg_caption('Observation well in linear-composite reservoir (≤5 zones)');
    s += _svg_close();
    return s;
}

// 40. Linear-composite multi-lateral.
function _schematic_linearCompMultiLat() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="180" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="200" y="40" width="180" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<line x1="200" y1="40" x2="200" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    // Multi-lateral producer in zone 1 (left)
    s += '<rect x="96" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += '<line x1="100" y1="135" x2="40"  y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="160" y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="100" y2="200" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="100" cy="135" r="5" fill="#f0883e"/>';
    s += _svg_caption('Multi-lateral producer in linear-composite reservoir');
    s += _svg_close();
    return s;
}

// 41. Linear-composite multi-lateral interference.
function _schematic_linearCompMultiLatInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="180" height="220" fill="#58a6ff" fill-opacity="0.15"/>';
    s += '<rect x="200" y="40" width="180" height="220" fill="#3fb950" fill-opacity="0.15"/>';
    s += '<line x1="200" y1="40" x2="200" y2="260" stroke="#c9d1d9" stroke-width="0.8" stroke-dasharray="3,3"/>';
    s += '<rect x="96" y="24" width="8" height="86" fill="#0d1117" stroke="#f0883e" stroke-width="1.5"/>';
    s += '<line x1="100" y1="135" x2="40"  y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<line x1="100" y1="135" x2="160" y2="135" stroke="#f0883e" stroke-width="3"/>';
    s += '<circle cx="100" cy="135" r="5" fill="#f0883e"/>';
    s += _svg_obswell(320, 24, 150, '#58a6ff');
    s += '<text x="296" y="178" font-size="9" fill="#58a6ff">obs</text>';
    s += _svg_caption('Observation well + multi-lateral producer in linear-composite');
    s += _svg_close();
    return s;
}

// 42. ML interference with cross-flow.
function _schematic_mlInterferenceXF() {
    var s = _svg_open();
    s += _svg_caprock(40, 20);
    var layers = _svg_layers(20, 60, 360, [
        { label: 'Layer 1', h: 50, color: '#3fb950' },
        { label: 'Layer 2', h: 50, color: '#58a6ff' },
        { label: 'Layer 3', h: 50, color: '#a371f7' }
    ]);
    s += layers.svg;
    s += _svg_baserock(210, 20);
    s += _svg_vwell(100, 24, 210, '#f0883e');
    s += _svg_well_label(100, 'producer');
    s += _svg_obswell(290, 24, 135, '#58a6ff');
    s += '<text x="296" y="155" font-size="9" fill="#58a6ff">obs (x, y)</text>';
    // XF arrows between layers
    s += _svg_xflowArrow(200, 110, 200, 160, '#c9d1d9');
    s += _svg_xflowArrow(200, 160, 200, 210, '#c9d1d9');
    s += _svg_caption('Interference at arbitrary (x, y) point in any layer with PSS &#955;-controlled XF');
    s += _svg_close();
    return s;
}

// 43. Radial composite interference.
function _schematic_radialCompInterference() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    var cx = 160, cy = 150;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="100" fill="#3fb950" fill-opacity="0.10" stroke="#3fb950" stroke-width="0.7"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="50" fill="#58a6ff" fill-opacity="0.20" stroke="#58a6ff" stroke-width="1.2"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="#f0883e"/>';
    s += '<text x="' + (cx - 30) + '" y="' + (cy - 12) + '" font-size="10" fill="#f0883e">producer</text>';
    // Observation outside outer zone
    s += '<circle cx="320" cy="80" r="5" fill="#58a6ff"/>';
    s += '<text x="290" y="74" font-size="9" fill="#58a6ff">obs (x, y)</text>';
    s += _svg_caption('Observation pressure in 2-zone radial-composite reservoir');
    s += _svg_close();
    return s;
}

// 44. User-defined type curve — table icon + curve.
function _schematic_userDefined() {
    var s = _svg_open();
    s += '<rect x="20" y="40" width="360" height="220" fill="#0d1117" stroke="#8b949e" stroke-width="0.5"/>';
    // Mini table (left).
    s += '<rect x="40" y="60" width="130" height="180" fill="#161b22" stroke="#30363d"/>';
    s += '<text x="105" y="78" font-size="11" fill="#c9d1d9" text-anchor="middle">td      pd</text>';
    s += '<line x1="50" y1="84" x2="160" y2="84" stroke="#30363d"/>';
    var rows = ['1e-3   0.02', '1e-2   0.12', '1e-1   0.57', '1      2.30', '10     4.61', '100    6.91'];
    for (var i = 0; i < rows.length; i++) {
        s += '<text x="105" y="' + (102 + i * 22) + '" font-size="10" fill="#8b949e" text-anchor="middle" font-family="monospace">' + rows[i] + '</text>';
    }
    // Right: log-log curve from the table.
    var x0 = 200, y0 = 70, w = 170, h = 170;
    s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + w + '" height="' + h + '" fill="#0d1117" stroke="#30363d"/>';
    s += '<line x1="' + (x0 + 12) + '" y1="' + (y0 + 12) + '" x2="' + (x0 + 12) + '" y2="' + (y0 + h - 16) + '" stroke="#8b949e" stroke-width="0.6"/>';
    s += '<line x1="' + (x0 + 12) + '" y1="' + (y0 + h - 16) + '" x2="' + (x0 + w - 8) + '" y2="' + (y0 + h - 16) + '" stroke="#8b949e" stroke-width="0.6"/>';
    var pts = '';
    for (var k = 0; k < 30; k++) {
        var u = k / 29;
        var px = x0 + 12 + u * (w - 20);
        var py = y0 + h - 16 - Math.log10(1 + 9 * u) * (h - 28) * 0.85;
        pts += (k ? ' L ' : 'M ') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    s += '<path d="' + pts + '" fill="none" stroke="#f0883e" stroke-width="1.6"/>';
    s += '<text x="' + (x0 + w / 2) + '" y="' + (y0 + 8) + '" font-size="10" fill="#c9d1d9" text-anchor="middle">log-log interpolation</text>';
    s += _svg_caption('User-defined type-curve — load (td, pd) table + linear interp in log-log');
    s += _svg_close();
    return s;
}

// 45. Water injection — front + saturation profile.
function _schematic_waterInjection() {
    var s = _svg_open();
    s += _svg_caprock(40, 25);
    s += '<rect x="20" y="65" width="360" height="170" fill="url(#sandPattern)" stroke="#8b949e" stroke-width="0.5"/>';
    s += _svg_baserock(235, 25);
    // Injection well (left). Arrow points DOWN to indicate injection.
    s += '<polygon points="65,12 85,12 75,24" fill="#58a6ff" transform="rotate(180 75 18)"/>';
    s += _svg_vwell(75, 24, 235, '#58a6ff');
    s += '<text x="35" y="20" font-size="10" fill="#58a6ff">injector</text>';
    // Water-swept (blue) inner zone
    s += '<rect x="20" y="65" width="160" height="170" fill="#58a6ff" fill-opacity="0.30"/>';
    s += '<text x="100" y="105" font-size="10" fill="#58a6ff" text-anchor="middle">water swept (S_w &gt; S_wc)</text>';
    // Front (vertical sharp boundary)
    s += '<line x1="180" y1="65" x2="180" y2="235" stroke="#58a6ff" stroke-width="2"/>';
    s += '<text x="186" y="80" font-size="9" fill="#58a6ff" font-style="italic">r_f (front)</text>';
    // Oil zone
    s += '<rect x="180" y="65" width="200" height="170" fill="#f0883e" fill-opacity="0.10"/>';
    s += '<text x="285" y="160" font-size="10" fill="#f0883e" text-anchor="middle">oil (S_w = S_wc)</text>';
    s += _svg_caption('Water injection — Buckley-Leverett-like piston front advances with W_inj');
    s += _svg_close();
    return s;
}

// Generic placeholder for unsupported keys.
function _schematic_placeholder(modelKey) {
    var s = _svg_open();
    s += _svg_caprock(40, 30);
    s += _svg_sand(70, 160);
    s += _svg_baserock(230, 30);
    s += _svg_vwell(200, 24, 230, '#f0883e');
    s += _svg_well_label(200, 'well');
    s += '<text x="200" y="150" font-size="14" fill="#8b949e" text-anchor="middle" font-style="italic">' +
         (modelKey || 'model') + '</text>';
    s += '<text x="200" y="170" font-size="10" fill="#8b949e" text-anchor="middle">(no schematic — see reference)</text>';
    s += _svg_caption('Schematic not yet illustrated for this model');
    s += _svg_close();
    return s;
}

// Public dispatch — covers all 45 PRiSM_MODELS entries.
G.PRiSM_getModelSchematic = function (modelKey) {
    if (!modelKey) return '';
    switch (modelKey) {
        // Core (Phase 1+2)
        case 'homogeneous':      return _schematic_homogeneous();
        case 'infiniteFrac':     return _schematic_infiniteFrac();
        case 'finiteFrac':       return _schematic_finiteFrac();
        case 'finiteFracSkin':   return _schematic_finiteFracSkin();
        case 'inclined':         return _schematic_inclined();
        case 'horizontal':       return _schematic_horizontal();
        case 'partialPenFrac':   return _schematic_partialPenFrac();
        case 'linearBoundary':   return _schematic_linearBoundary();
        case 'parallelChannel':  return _schematic_parallelChannel();
        case 'closedRectangle':  return _schematic_closedRectangle();
        case 'intersecting':     return _schematic_intersecting();
        case 'doublePorosity':   return _schematic_doublePorosity();
        case 'partialPen':       return _schematic_partialPen();
        case 'verticalPulse':    return _schematic_verticalPulse();
        // Boundary (Phase 2 extras)
        case 'closedChannel3':   return _schematic_closedChannel3();
        case 'fogBoundary':      return _schematic_fogBoundary();
        // Decline (Phase 3)
        case 'arps':             return _schematic_arps();
        case 'duong':            return _schematic_duong();
        case 'sepd':             return _schematic_sepd();
        case 'fetkovich':        return _schematic_fetkovich();
        // Composite + multi-layer (Phase 5)
        case 'radialComposite':  return _schematic_radialComposite();
        case 'linearComposite':  return _schematic_linearComposite();
        case 'twoLayerXF':       return _schematic_twoLayerXF();
        case 'multiLayerXF':     return _schematic_multiLayerXF();
        case 'multiLayerNoXF':   return _schematic_multiLayerNoXF();
        case 'genHetRadial':     return _schematic_genHetRadial();
        case 'genHetRadialLinear': return _schematic_genHetRadialLinear();
        // Multi-layer well variants (Phase 6)
        case 'mlNoXFFrac':       return _schematic_mlNoXFFrac();
        case 'mlNoXFHoriz':      return _schematic_mlNoXFHoriz();
        case 'mlHorizontalXF':   return _schematic_mlHorizontalXF();
        case 'inclinedMLXF':     return _schematic_inclinedMLXF();
        case 'multiLatMLXF':     return _schematic_multiLatMLXF();
        case 'mlMultiPerf':      return _schematic_mlMultiPerf();
        case 'generalMLNoXF':    return _schematic_generalMLNoXF();
        // Interference variants (Phase 6)
        case 'interference':     return _schematic_interference();
        case 'mlHorizInterference': return _schematic_mlHorizInterference();
        case 'mlMultiPerfInterference': return _schematic_mlMultiPerfInterference();
        case 'inclinedInterference': return _schematic_inclinedInterference();
        case 'linearCompInterference': return _schematic_linearCompInterference();
        case 'linearCompMultiLat': return _schematic_linearCompMultiLat();
        case 'linearCompMultiLatInterference': return _schematic_linearCompMultiLatInterference();
        case 'mlInterferenceXF': return _schematic_mlInterferenceXF();
        case 'radialCompInterference': return _schematic_radialCompInterference();
        // Specialised solvers (Phase 7)
        case 'userDefined':      return _schematic_userDefined();
        case 'waterInjection':   return _schematic_waterInjection();
        default:                 return _schematic_placeholder(modelKey);
    }
};

// =========================================================================
// SECTION 2 — PLOT LINE TOOLS (click-on-plot straight-line & slope analyses)
// =========================================================================
// Each tool: { label, hint, plot, clicks, prompts[], group, action(pts, cx) }
//   plot     plot key (or array of keys) the tool works on
//   pts      [{x, y, xKind, yKind}] in data units of the clicked plot
//            (log-log derivative plot: x = Δt [hr], y = Δp or Δp′ [psi])
//   cx       context: cx.w(key) reads a Well & Test input (and records that
//            it was used), cx.ad() the analysis data, cx.k() the permeability
//            source, cx.teq(t) the equivalent drawdown time.
//   action → { values:{}, text?, note, warnings[] } or { error }
// Results are stored in PRiSM_state.analysisKeyResults[key].
// =========================================================================

var WELL_KEYS  = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
var WELL_LABEL = { q: 'q', B: 'B', mu: 'μ', ct: 'ct', h: 'h', phi: 'φ', rw: 'rw' };
// Last-resort values. Only ever used together with an amber
// "default inputs" warning on the result.
var FALLBACK_WELL = { q: 1000, B: 1.2, mu: 1.0, ct: 1e-5, h: 50, phi: 0.2, rw: 0.354 };

// Quantity catalogue: display label + unit for every value a tool returns.
var QTY = {
    dpPrime:    { label: 'Δp′',                 unit: 'psi' },
    kh:         { label: 'kh',                  unit: 'md·ft' },
    k:          { label: 'k',                   unit: 'md' },
    S:          { label: 'S',                   unit: '' },
    rinv:       { label: 'r_inv',               unit: 'ft' },
    C:          { label: 'C',                   unit: 'bbl/psi' },
    CD:         { label: 'CD',                  unit: '' },
    mLinear:    { label: 'm (linear)',          unit: 'psi/hr^½' },
    xfSqrtK:    { label: 'xf·√k',               unit: 'ft·md^½' },
    xf:         { label: 'xf',                  unit: 'ft' },
    mBilinear:  { label: 'm (bilinear)',        unit: 'psi/hr^¼' },
    kfwf:       { label: 'kf·wf',               unit: 'md·ft' },
    mSpherical: { label: 'm (spherical)',       unit: 'psi·hr^½' },
    ks:         { label: 'k (spherical)',       unit: 'md' },
    ratio:      { label: 'Dip ratio',           unit: '' },
    omega:      { label: 'ω',                   unit: '' },
    lambda:     { label: 'λ',                   unit: '' },
    tMin:       { label: 't at dip',            unit: 'hr' },
    L:          { label: 'Distance',            unit: 'ft' },
    W:          { label: 'Channel width',       unit: 'ft' },
    theta:      { label: 'Wedge angle',         unit: '°' },
    area:       { label: 'Drainage area',       unit: 'acres' },
    poreVolume: { label: 'Pore volume',         unit: 'bbl' },
    re:         { label: 'Equivalent radius',   unit: 'ft' },
    kyKzLw:     { label: '√(ky·kz)·Lw',         unit: 'md·ft' },
    LwSqrtKy:   { label: 'Lw·√ky',              unit: 'ft·md^½' },
    kxKyH:      { label: '√(kx·ky)·h',          unit: 'md·ft' },
    kH:         { label: '√(kx·ky)',            unit: 'md' },
    slope:      { label: 'Slope',               unit: '' },
    m:          { label: 'm',                   unit: 'psi/cycle' },
    pStar:      { label: 'p*',                  unit: 'psia' },
    p1hr:       { label: 'p1hr',                unit: 'psia' },
    tx:         { label: 'Intersection Δt',     unit: 'hr' }
};

function _num(v) { return typeof v === 'number' && isFinite(v); }
function _pos(v) { return _num(v) && v > 0; }

function _fmt(v, sig) {
    if (!_num(v)) return '—';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
        return v.toExponential(Math.max(0, sig - 2)).replace(/\.?0+e/, 'e').replace('e+', 'e');
    }
    var s = v.toPrecision(sig);
    if (s.indexOf('e') !== -1) s = String(Number(s));
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

function _rankine(T) {
    if (!_num(T)) return null;
    return T > 400 ? T : T + 459.67;          // °F → °R unless already absolute
}

// ---- Inputs (C1) ----------------------------------------------------------
function _wellInputs() {
    var out = { v: {}, defaulted: [], missing: [], source: 'none', fluid: 'oil',
                T_R: null, testType: null, pi: null, tp: null, pwf0: null };
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(); } catch (e) { w = null; }
    }
    var i, k;
    if (w && typeof w === 'object') {
        out.source = 'Well & Test';
        var dflt = Array.isArray(w.defaulted) ? w.defaulted : [];
        for (i = 0; i < WELL_KEYS.length; i++) {
            k = WELL_KEYS[i];
            if (_pos(w[k])) {
                out.v[k] = w[k];
                if (dflt.indexOf(k) !== -1) out.defaulted.push(k);
            } else {
                out.v[k] = FALLBACK_WELL[k];
                out.defaulted.push(k);
                out.missing.push(k);
            }
        }
        out.fluid    = w.fluid || 'oil';
        out.T_R      = _num(w.T_R) ? w.T_R : null;
        out.testType = w.testType || null;
        out.pi       = _pos(w.pi) ? w.pi : null;
        out.tp       = _pos(w.tp) ? w.tp : null;
        out.pwf0     = _pos(w.pwf0) ? w.pwf0 : null;
        return out;
    }
    // No Well & Test store: read the PVT store. Its values have no
    // provenance, so every one of them is reported as a default.
    var pvt = G.PRiSM_pvt || null;
    var c = (pvt && pvt._computed) || null;
    if (pvt && (!c || !_pos(c.ct)) && typeof G.PRiSM_pvt_compute === 'function') {
        try { c = G.PRiSM_pvt_compute() || c; } catch (e) { /* keep */ }
    }
    out.source = pvt ? 'stored PVT values (not confirmed)' : 'built-in defaults';
    var raw = {
        q:   pvt && pvt.q,
        B:   (c && c.B)  || (pvt && pvt.Bo),
        mu:  (c && c.mu) || (pvt && pvt.mu_o),
        ct:  (c && c.ct) || (pvt && pvt.ct),
        h:   pvt && pvt.h,
        phi: pvt && pvt.phi,
        rw:  pvt && pvt.rw
    };
    for (i = 0; i < WELL_KEYS.length; i++) {
        k = WELL_KEYS[i];
        out.v[k] = _pos(raw[k]) ? raw[k] : FALLBACK_WELL[k];
        out.defaulted.push(k);
        if (!_pos(raw[k])) out.missing.push(k);
    }
    out.fluid = (pvt && pvt.fluidType) || 'oil';
    out.T_R   = (pvt && _num(pvt.T_res)) ? pvt.T_res : null;
    return out;
}

// ---- Analysis data (C2) ---------------------------------------------------
function _localBourdet(t, y, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        try {
            var r = G.PRiSM_compute_bourdet(t, y, L);
            if (r && r.length === t.length) return r;
        } catch (e) { /* inline fallback */ }
    }
    var n = t.length, d = new Array(n), i;
    for (i = 0; i < n; i++) d[i] = NaN;
    for (i = 1; i < n - 1; i++) {
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        var dl1 = Math.log(t[i]) - Math.log(t[i1]);
        var dl2 = Math.log(t[i2]) - Math.log(t[i]);
        var dlT = Math.log(t[i2]) - Math.log(t[i1]);
        if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

function _localAnalysisData(ds, L) {
    if (!ds || !ds.t || !ds.p || ds.t.length < 3) {
        return { ok: false, reason: 'No pressure data', t: [], dp: [], deriv: [] };
    }
    var n = ds.t.length, p0 = ds.p[0];
    var sign = (ds.p[n - 1] - p0) >= 0 ? 1 : -1;     // +1 buildup, -1 drawdown
    var t = [], p = [], dp = [];
    for (var i = 0; i < n; i++) {
        if (!(ds.t[i] > 0) || !_num(ds.p[i])) continue;
        t.push(ds.t[i]); p.push(ds.p[i]); dp.push(sign * (ds.p[i] - p0));
    }
    return {
        ok: t.length >= 3, t: t, tAbs: t.slice(), p: p, dp: dp,
        deriv: _localBourdet(t, dp, L), L: L, sign: sign, pRef: p0,
        pRefSource: 'first-sample', testType: sign > 0 ? 'buildup' : 'drawdown', tp: null,
        warnings: ['Δp is measured from the first sample — skin is biased (set pi on Tab 1).']
    };
}

function _analysisData() {
    var st = G.PRiSM_state || {};
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var o = {};
            if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
            if (_num(st.bourdetL)) o.L = st.bourdetL;
            if (st.timeFn) o.timeFn = st.timeFn;
            var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
            if (ad && ad.ok && ad.t && ad.t.length) return ad;
        } catch (e) { /* fall back */ }
    }
    return _localAnalysisData(G.PRiSM_dataset, _num(st.bourdetL) ? st.bourdetL : 0.15);
}

// Positive (log t, log y) pairs of one AData series — cached on the object.
function _pairs(ad, which) {
    if (!ad || !ad.t) return { x: [], y: [] };
    var cacheKey = '_prismPairs_' + which;
    if (ad[cacheKey]) return ad[cacheKey];
    var src = ad[which] || [], xs = [], ys = [];
    for (var i = 0; i < ad.t.length; i++) {
        if (ad.t[i] > 0 && src[i] > 0 && _num(src[i])) {
            xs.push(Math.log10(ad.t[i]));
            ys.push(Math.log10(src[i]));
        }
    }
    var r = { x: xs, y: ys };
    try { ad[cacheKey] = r; } catch (e) { /* frozen */ }
    return r;
}

function _interpLogLog(pr, t) {
    if (!pr.x.length || !(t > 0)) return NaN;
    var lx = Math.log10(t), n = pr.x.length;
    if (lx < pr.x[0] - 0.05 || lx > pr.x[n - 1] + 0.05) return NaN;
    if (lx <= pr.x[0]) return Math.pow(10, pr.y[0]);
    if (lx >= pr.x[n - 1]) return Math.pow(10, pr.y[n - 1]);
    for (var i = 1; i < n; i++) {
        if (pr.x[i] >= lx) {
            var f = (lx - pr.x[i - 1]) / Math.max(1e-12, pr.x[i] - pr.x[i - 1]);
            return Math.pow(10, pr.y[i - 1] + f * (pr.y[i] - pr.y[i - 1]));
        }
    }
    return NaN;
}

// Which log-log curve (Δp or Δp′) is nearest the clicked point.
function _whichCurve(ad, t, y) {
    if (!ad || !ad.ok || !(y > 0)) return null;
    var a = _interpLogLog(_pairs(ad, 'dp'), t);
    var b = _interpLogLog(_pairs(ad, 'deriv'), t);
    var ly = Math.log10(y);
    var da = _pos(a) ? Math.abs(ly - Math.log10(a)) : Infinity;
    var db = _pos(b) ? Math.abs(ly - Math.log10(b)) : Infinity;
    if (da === Infinity && db === Infinity) return null;
    return da < db ? 'dp' : 'deriv';
}

// Local log-log slope of a series around t (least squares over ±¼ then ±½ cycle).
function _localSlope(ad, t, which) {
    if (!ad || !ad.ok || !(t > 0)) return NaN;
    var pr = _pairs(ad, which || 'deriv'), lt = Math.log10(t), widths = [0.25, 0.5];
    for (var w = 0; w < widths.length; w++) {
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        for (var i = 0; i < pr.x.length; i++) {
            if (Math.abs(pr.x[i] - lt) > widths[w]) continue;
            sx += pr.x[i]; sy += pr.y[i]; sxx += pr.x[i] * pr.x[i]; sxy += pr.x[i] * pr.y[i]; m++;
        }
        var den = m * sxx - sx * sx;
        if (m >= 3 && Math.abs(den) > 1e-12) return (m * sxy - sx * sy) / den;
    }
    return NaN;
}

function _isBuildup(tt) { return tt === 'buildup' || tt === 'falloff'; }

// Permeability from earlier work (newest-first priority list).
function _kFromContext(st) {
    var r = (st && st.analysisKeyResults) || {};
    var order = ['radialPlateau', 'mdhLine', 'hornerLine', 'dualPorosityDip', 'boundaryDoubling'];
    var names = { radialPlateau: 'radial-plateau pick', mdhLine: 'semilog line', hornerLine: 'Horner line',
                  dualPorosityDip: 'plateau pick', boundaryDoubling: 'plateau pick' };
    for (var i = 0; i < order.length; i++) {
        var e = r[order[i]];
        if (e && e.values && _pos(e.values.k)) return { k: e.values.k, source: names[order[i]] };
    }
    var lf = null;
    if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e2) { lf = null; } }
    if (!lf && st) lf = st.lastFit;
    if (lf && lf.phys && _pos(lf.phys.k) && !lf.stale) return { k: lf.phys.k, source: 'model fit' };
    if (st && st.semilog && _pos(st.semilog.k)) return { k: st.semilog.k, source: 'semilog analysis' };
    if (st && st.phys && _pos(st.phys.k)) return { k: st.phys.k, source: 'model parameters' };
    return null;
}

function _omegaFromContext(st) {
    var r = (st && st.analysisKeyResults) || {};
    var order = ['dualPorosityDip', 'storativityRatio'];
    for (var i = 0; i < order.length; i++) {
        var e = r[order[i]];
        if (e && e.values && _pos(e.values.omega)) return { omega: e.values.omega, source: e.label };
    }
    var lf = st && st.lastFit;
    if (lf && lf.params && _pos(lf.params.omega)) return { omega: lf.params.omega, source: 'model fit' };
    if (st && st.params && _pos(st.params.omega)) return { omega: st.params.omega, source: 'model parameters' };
    return null;
}

// ω from the dip-to-plateau derivative ratio (pseudo-steady interporosity flow):
//   Δp′_min/Δp′_r = 1 + ω^(1/(1−ω)) − ω^(ω/(1−ω))
function _dipRatio(w) { return 1 + Math.pow(w, 1 / (1 - w)) - Math.pow(w, w / (1 - w)); }
function _omegaFromDipRatio(ratio) {
    if (!(ratio > 0) || !(ratio < 1)) return NaN;
    var lo = Math.log(1e-8), hi = Math.log(0.999);
    if (ratio <= _dipRatio(1e-8)) return 1e-8;
    for (var i = 0; i < 200; i++) {
        var mid = 0.5 * (lo + hi);
        if (_dipRatio(Math.exp(mid)) < ratio) lo = mid; else hi = mid;
        if (hi - lo < 1e-12) break;
    }
    return Math.exp(0.5 * (lo + hi));
}

function _regimeForSlope(s) {
    if (!_num(s)) return 'unknown';
    if (Math.abs(s) < 0.1)        return 'radial flow (flat derivative)';
    if (Math.abs(s - 0.25) < 0.08) return 'bilinear flow (¼ slope)';
    if (Math.abs(s - 0.5) < 0.1)  return 'linear flow (½ slope)';
    if (Math.abs(s - 1) < 0.15)   return 'unit slope (storage, or a closed system at late time)';
    if (Math.abs(s + 0.5) < 0.1)  return 'spherical flow (−½ slope)';
    if (s <= -0.6)                return 'pressure support (falling derivative)';
    return 'transition';
}

function _semilogX(pt) {                     // semilog abscissa (log10 of the axis value)
    return (pt.xKind === 'log') ? Math.log10(pt.x) : pt.x;
}

// Optional hand-off to the semilog engine. Its stored result is left as it was.
function _semilogEngine(method, t0, t1, cx) {
    if (typeof G.PRiSM_semilogAnalysis !== 'function') return null;
    var st = cx.st, before = st ? st.semilog : undefined, res = null;
    try {
        var well = null;
        if (typeof G.PRiSM_getWell === 'function') { try { well = G.PRiSM_getWell(); } catch (e0) { well = null; } }
        res = G.PRiSM_semilogAnalysis(cx.ad(), well,
            { method: method, window: { t0: Math.min(t0, t1), t1: Math.max(t0, t1) }, store: false });
    } catch (e) { res = null; }
    if (st) { if (before === undefined) { try { delete st.semilog; } catch (e1) { st.semilog = undefined; } } else st.semilog = before; }
    if (!res || typeof res !== 'object' || res.ok === false) return null;
    if (res.window && res.window.auto === true) return null;      // the clicked window was not used
    var pStar = _num(res.pStar) ? res.pStar : (_num(res.pstar) ? res.pstar : null);
    return { m: res.m, kh: res.kh, k: res.k, p1hr: res.p1hr, S: res.S, pStar: pStar,
             method: res.method, n: res.window && res.window.n };
}

function _sqrtRatio(mu, phi, ct) { return Math.sqrt(mu / (phi * ct)); }

G.PRiSM_analysisKeys = {

    // ── Radial flow & storage ─────────────────────────────────────────────
    radialPlateau: {
        label: 'Pick radial plateau → kh',
        hint: 'Click the flat part of the derivative (radial flow).',
        plot: 'bourdet', clicks: 1, group: 'Radial flow & storage',
        prompts: ['Click the flat part of the derivative (radial flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(y)) return { error: 'Click on the derivative plateau (Δp′ must be positive).' };
            var q = cx.w('q'), B = cx.w('B'), mu = cx.w('mu'), h = cx.w('h'), kh;
            if (cx.pseudo()) {
                var T = cx.rankine();
                if (!T) return { error: 'Gas pseudo-pressure data: set the reservoir temperature on Tab 1.' };
                kh = 711 * q * T / y;                      // Δm′ plateau, psi²/cp
            } else {
                kh = 70.6 * q * B * mu / y;                // Bourdet: Δp′ = 70.6 qBμ/kh
            }
            var k = kh / h, v = { dpPrime: y, kh: kh, k: k };
            var ad = cx.ad(), s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s) > 0.1) {
                warnings.push('The derivative is not flat here (local slope ' + s.toFixed(2) + ') — pick the radial-flow plateau.');
            }
            if (ad && ad.ok && !cx.pseudo()) {
                var dpr = _interpLogLog(_pairs(ad, 'dp'), t);
                var phi = cx.w('phi'), ct = cx.w('ct'), rw = cx.w('rw');
                if (_pos(dpr)) {
                    var te = cx.teq(t);
                    v.S = 0.5 * (dpr / y - Math.log(0.0002637 * k * te / (phi * mu * ct * rw * rw)) - 0.80907);
                    if (ad.pRefSource && ad.pRefSource !== 'pi' && ad.pRefSource !== 'pwf0') {
                        warnings.push('Δp is measured from the ' + String(ad.pRefSource).replace('-', ' ') +
                                      ', not pi — skin is biased. Set pi on Tab 1.');
                    }
                }
                var tEnd = 0;
                for (var i = 0; i < ad.t.length; i++) if (ad.t[i] > tEnd) tEnd = ad.t[i];
                if (tEnd > 0) v.rinv = Math.sqrt(k * tEnd / (948 * phi * mu * ct));
            }
            return {
                values: v, warnings: warnings,
                note: 'Radial plateau Δp′ = ' + _fmt(y) + ' psi → kh = ' + _fmt(kh) + ' md·ft, k = ' + _fmt(k) + ' md' +
                      (_num(v.S) ? ', S = ' + _fmt(v.S, 3) : '')
            };
        }
    },

    unitSlope: {
        label: 'Unit slope → C',
        hint: 'Click a point on the early unit-slope line (wellbore storage).',
        plot: 'bourdet', clicks: 1, group: 'Radial flow & storage',
        prompts: ['Click a point on the early unit-slope (storage) line'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the unit-slope line.' };
            var q = cx.w('q'), B = cx.w('B');
            var C = q * B * t / (24 * y);                   // Δp = qBΔt/(24C)
            var CD = 0.8936 * C / (cx.w('phi') * cx.w('ct') * cx.w('h') * cx.w('rw') * cx.w('rw'));
            var s = _localSlope(cx.ad(), t, 'dp');
            if (_num(s) && Math.abs(s - 1) > 0.15) {
                warnings.push('The data is not on a unit slope here (local slope ' + s.toFixed(2) + ') — storage may be over before the first point.');
            }
            return { values: { C: C, CD: CD }, warnings: warnings,
                     note: 'Unit slope at Δt = ' + _fmt(t, 3) + ' hr, Δp = ' + _fmt(y) + ' psi → C = ' + _fmt(C, 3) + ' bbl/psi (CD = ' + _fmt(CD, 3) + ')' };
        }
    },

    // ── Fractures & linear flow ──────────────────────────────────────────
    halfSlope: {
        label: '½-slope → xf·√k',
        hint: 'Click the ½-slope part of the curves (fracture linear flow).',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow',
        prompts: ['Click the ½-slope part of the derivative (linear flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ½-slope segment.' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(t);       // Δp = m√t, Δp′ = ½ m√t
            var xfk = 4.064 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            var v = { mLinear: m, xfSqrtK: xfk };
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s - 0.5) > 0.1) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not ½ — check the flow regime.');
            var kk = cx.k();
            if (kk) v.xf = xfk / Math.sqrt(kk.k);
            return { values: v, warnings: warnings,
                     note: '½-slope on ' + (curve === 'dp' ? 'Δp' : 'Δp′') + ' → m = ' + _fmt(m) + ' psi/hr^½, xf·√k = ' + _fmt(xfk) + ' ft·md^½' +
                           (v.xf ? ', xf = ' + _fmt(v.xf) + ' ft' : '') };
        }
    },

    quarterSlope: {
        label: '¼-slope → kf·wf',
        hint: 'Click the ¼-slope part of the curves (bilinear flow). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow', needsK: true,
        prompts: ['Click the ¼-slope part of the derivative (bilinear flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ¼-slope segment.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 4 * y) / Math.pow(t, 0.25);  // Δp = m t^¼, Δp′ = ¼ m t^¼
            var mu = cx.w('mu');
            var kfwf = Math.pow(44.1 * cx.w('q') * cx.w('B') * mu /
                                (cx.w('h') * m * Math.pow(cx.w('phi') * mu * cx.w('ct') * kk.k, 0.25)), 2);
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s - 0.25) > 0.08) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not ¼ — check the flow regime.');
            return { values: { mBilinear: m, kfwf: kfwf }, warnings: warnings,
                     note: '¼-slope → m = ' + _fmt(m) + ' psi/hr^¼, kf·wf = ' + _fmt(kfwf) + ' md·ft (k = ' + _fmt(kk.k, 3) + ' md from ' + kk.source + ')' };
        }
    },

    sphericalSlope: {
        label: '−½ slope → spherical k',
        hint: 'Click the −½-slope part of the derivative (spherical flow).',
        plot: 'bourdet', clicks: 1, group: 'Fractures & linear flow',
        prompts: ['Click the −½-slope part of the derivative (spherical flow)'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the −½-slope derivative.' };
            var ad = cx.ad();
            if (_whichCurve(ad, t, y) === 'dp') return { error: 'Click on the derivative (Δp′), not on Δp.' };
            var m = 2 * y * Math.sqrt(t);                  // Δp′ = ½·|m|/√t
            var mu = cx.w('mu');
            var ks = Math.pow(2452.9 * cx.w('q') * cx.w('B') * mu * Math.sqrt(cx.w('phi') * mu * cx.w('ct')) / m, 2 / 3);
            var s = _localSlope(ad, t, 'deriv');
            if (_num(s) && Math.abs(s + 0.5) > 0.12) warnings.push('Local derivative slope is ' + s.toFixed(2) + ', not −½ — check the flow regime.');
            return { values: { mSpherical: m, ks: ks }, warnings: warnings,
                     note: '−½ slope → |m| = ' + _fmt(m) + ' psi·hr^½, spherical k = ' + _fmt(ks) + ' md' };
        }
    },

    // ── Dual porosity ────────────────────────────────────────────────────
    dualPorosityDip: {
        label: 'Click the dip → ω, λ',
        hint: 'Click the radial plateau, then the bottom of the derivative dip.',
        plot: 'bourdet', clicks: 2, group: 'Dual porosity',
        prompts: ['Click the radial plateau', 'Click the bottom of the derivative dip'],
        action: function (pts, cx) {
            var yr = pts[0].y, tm = pts[1].x, ym = pts[1].y;
            if (!_pos(yr) || !_pos(ym)) return { error: 'Both points must be on the derivative.' };
            var ratio = ym / yr;
            if (!(ratio < 1)) return { error: 'The dip must lie below the plateau (ratio ' + _fmt(ratio, 3) + ').' };
            var omega = _omegaFromDipRatio(ratio);
            var mu = cx.w('mu'), kh = 70.6 * cx.w('q') * cx.w('B') * mu / yr, k = kh / cx.w('h');
            var rw = cx.w('rw'), te = cx.teq(tm);
            var lambda = omega * Math.log(1 / omega) * cx.w('phi') * mu * cx.w('ct') * rw * rw / (0.0002637 * k * te);
            return { values: { kh: kh, k: k, ratio: ratio, omega: omega, tMin: tm, lambda: lambda }, warnings: [],
                     note: 'Dip ratio ' + _fmt(ratio, 3) + ' → ω = ' + _fmt(omega, 3) + '; dip at ' + _fmt(tm, 3) + ' hr → λ = ' + _fmt(lambda, 3) + ' (k = ' + _fmt(k, 3) + ' md)' };
        }
    },

    storativityRatio: {
        label: 'Dip depth → ω',
        hint: 'Click the radial plateau, then the bottom of the dip.',
        plot: 'bourdet', clicks: 2, group: 'Dual porosity',
        prompts: ['Click the radial plateau', 'Click the bottom of the derivative dip'],
        action: function (pts) {
            var ratio = pts[1].y / pts[0].y;
            if (!(ratio > 0 && ratio < 1)) return { error: 'The dip must lie below the plateau.' };
            var omega = _omegaFromDipRatio(ratio);
            return { values: { ratio: ratio, omega: omega }, warnings: [],
                     note: 'Dip ratio ' + _fmt(ratio, 3) + ' → ω = ' + _fmt(omega, 3) };
        }
    },

    interporosityFlow: {
        label: 'Dip time → λ',
        hint: 'Click the bottom of the dip. Needs ω and k.',
        plot: 'bourdet', clicks: 1, group: 'Dual porosity', needsK: true,
        prompts: ['Click the bottom of the derivative dip'],
        action: function (pts, cx) {
            var tm = pts[0].x;
            var om = _omegaFromContext(cx.st);
            if (!om) return { error: 'Needs ω: use "Dip depth → ω" first.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var rw = cx.w('rw'), te = cx.teq(tm);
            var lambda = om.omega * Math.log(1 / om.omega) * cx.w('phi') * cx.w('mu') * cx.w('ct') * rw * rw / (0.0002637 * kk.k * te);
            return { values: { tMin: tm, omega: om.omega, lambda: lambda }, warnings: [],
                     note: 'Dip at ' + _fmt(tm, 3) + ' hr, ω = ' + _fmt(om.omega, 3) + ', k = ' + _fmt(kk.k, 3) + ' md → λ = ' + _fmt(lambda, 3) };
        }
    },

    // ── Boundaries ────────────────────────────────────────────────────────
    boundaryDoubling: {
        label: 'Boundary doubling → distance',
        hint: 'Click the radial plateau, then a point where the derivative is rising towards double.',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the radial plateau', 'Click the rising derivative (between 1× and 2× the plateau)'],
        action: function (pts, cx) {
            var yr = pts[0].y, t = pts[1].x, y = pts[1].y;
            var R = y / yr;
            if (!(R > 1.005 && R < 1.995)) {
                return { error: 'Pick a point where the derivative is between 1× and 2× the plateau (this one is ' + _fmt(R, 3) + '×).' };
            }
            var mu = cx.w('mu'), kh = 70.6 * cx.w('q') * cx.w('B') * mu / yr, k = kh / cx.w('h');
            var te = cx.teq(t);
            // Single sealing fault (image at 2L): R − 1 = exp(−L²φμct/(0.0002637 k t))
            var L = Math.sqrt(0.0002637 * k * te * Math.log(1 / (R - 1)) / (cx.w('phi') * mu * cx.w('ct')));
            return { values: { kh: kh, k: k, ratio: R, L: L }, warnings: [],
                     note: 'Derivative at ' + _fmt(R, 3) + '× the plateau at ' + _fmt(t, 3) + ' hr → distance to a sealing fault ≈ ' + _fmt(L, 3) + ' ft (k = ' + _fmt(k, 3) + ' md)' };
        }
    },

    boundaryOnset: {
        label: 'Boundary onset → distance',
        hint: 'Click where the derivative first leaves the plateau (≈10% above). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Boundaries', needsK: true,
        prompts: ['Click where the derivative first rises above the plateau'],
        action: function (pts, cx) {
            var t = pts[0].x;
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var te = cx.teq(t);
            var L = Math.sqrt(0.0002637 * kk.k * te * Math.log(10) / (cx.w('phi') * cx.w('mu') * cx.w('ct')));
            return { values: { L: L }, warnings: [],
                     note: 'Boundary felt at ' + _fmt(t, 3) + ' hr → distance ≈ ' + _fmt(L, 3) + ' ft (k = ' + _fmt(kk.k, 3) + ' md from ' + kk.source + ')' };
        }
    },

    boundaryType: {
        label: 'Late slope → boundary type',
        hint: 'Click two points on the late-time derivative.',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the first late-time derivative point', 'Click a later derivative point'],
        action: function (pts, cx) {
            var dx = Math.log10(pts[1].x) - Math.log10(pts[0].x);
            if (!(Math.abs(dx) > 1e-6)) return { error: 'The two points need different times.' };
            var s = (Math.log10(pts[1].y) - Math.log10(pts[0].y)) / dx;
            var typ;
            if (s >= 0.8) typ = 'closed system (pseudo-steady state)';
            else if (s >= 0.35) typ = 'parallel boundaries / channel (½ slope)';
            else if (s >= 0.1) typ = 'sealing fault or partial barrier';
            else if (s > -0.1) typ = 'no boundary effect (radial flow)';
            else typ = 'pressure support (constant-pressure boundary or aquifer)';
            var warnings = [];
            var ad = cx.ad();
            if (ad && _isBuildup(ad.testType) && s < -0.1) warnings.push('On a buildup a falling derivative can also mean a closed system.');
            return { values: { slope: s }, text: typ, warnings: warnings,
                     note: 'Late slope ' + s.toFixed(2) + ' → ' + typ };
        }
    },

    channelWidth: {
        label: 'Late ½-slope → channel width',
        hint: 'Click the late ½-slope part of the curves (flow between parallel boundaries). Needs k.',
        plot: 'bourdet', clicks: 1, group: 'Boundaries', needsK: true,
        prompts: ['Click the late ½-slope part of the derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y;
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var ad = cx.ad(), curve = _whichCurve(ad, t, y) || 'deriv';
            var te = cx.teq(t);
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(te);
            var W = 8.128 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * Math.sqrt(cx.w('mu') / (kk.k * cx.w('phi') * cx.w('ct')));
            return { values: { mLinear: m, W: W }, warnings: [],
                     note: 'Late ½-slope → m = ' + _fmt(m) + ' psi/hr^½, channel width ≈ ' + _fmt(W, 3) + ' ft (k = ' + _fmt(kk.k, 3) + ' md)' };
        }
    },

    wedgeAngle: {
        label: 'Second plateau → fault angle',
        hint: 'Click the radial plateau, then the higher late plateau (two intersecting faults).',
        plot: 'bourdet', clicks: 2, group: 'Boundaries',
        prompts: ['Click the radial plateau', 'Click the late (higher) plateau'],
        action: function (pts) {
            var ratio = pts[1].y / pts[0].y;
            if (!(ratio > 1.05)) return { error: 'The late plateau must be above the radial plateau.' };
            var theta = 360 / ratio;
            return { values: { ratio: ratio, theta: theta }, warnings: [],
                     note: 'Late / radial plateau = ' + _fmt(ratio, 3) + ' → angle between the faults ≈ ' + _fmt(theta, 3) + '°' };
        }
    },

    closedDrainageArea: {
        label: 'Late unit slope → drainage area',
        hint: 'Click the late unit-slope derivative of a drawdown (closed system).',
        plot: 'bourdet', clicks: 1, group: 'Boundaries',
        prompts: ['Click the late unit-slope derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y, warnings = [];
            var ad = cx.ad();
            if (_whichCurve(ad, t, y) === 'dp') return { error: 'Click on the derivative (Δp′), not on Δp.' };
            if (ad && _isBuildup(ad.testType)) warnings.push('Pseudo-steady state is a drawdown regime; on a buildup this area is not valid.');
            var phi = cx.w('phi'), h = cx.w('h');
            var Aft2 = 0.23395 * cx.w('q') * cx.w('B') * t / (phi * cx.w('ct') * h * y);  // Δp′ = 0.23395 qB t/(φ ct h A)
            return { values: { area: Aft2 / 43560, poreVolume: phi * h * Aft2 / 5.615, re: Math.sqrt(Aft2 / Math.PI) }, warnings: warnings,
                     note: 'Late unit slope → drainage area ≈ ' + _fmt(Aft2 / 43560, 3) + ' acres (re ≈ ' + _fmt(Math.sqrt(Aft2 / Math.PI), 3) + ' ft)' };
        }
    },

    // ── Horizontal wells ─────────────────────────────────────────────────
    horizontalEarlyRadial: {
        label: 'Early plateau (horizontal) → √(ky·kz)·Lw',
        hint: 'Click the early plateau (vertical-plane radial flow around the lateral).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the early derivative plateau'],
        action: function (pts, cx) {
            var y = pts[0].y;
            if (!_pos(y)) return { error: 'Click on the derivative plateau.' };
            var v = 70.6 * cx.w('q') * cx.w('B') * cx.w('mu') / y;
            return { values: { kyKzLw: v }, warnings: [],
                     note: 'Early plateau Δp′ = ' + _fmt(y) + ' psi → √(ky·kz)·Lw = ' + _fmt(v) + ' md·ft' };
        }
    },

    horizontalLinear: {
        label: 'Early ½-slope (horizontal) → Lw·√ky',
        hint: 'Click the intermediate ½-slope part of the curves (linear flow to the lateral).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the intermediate ½-slope part of the derivative'],
        action: function (pts, cx) {
            var t = pts[0].x, y = pts[0].y;
            if (!_pos(t) || !_pos(y)) return { error: 'Click on the ½-slope segment.' };
            var curve = _whichCurve(cx.ad(), t, y) || 'deriv';
            var m = (curve === 'dp' ? y : 2 * y) / Math.sqrt(t);
            var v = 8.128 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            return { values: { mLinear: m, LwSqrtKy: v }, warnings: [],
                     note: 'Intermediate ½-slope → m = ' + _fmt(m) + ' psi/hr^½, Lw·√ky = ' + _fmt(v) + ' ft·md^½' };
        }
    },

    horizontalLateRadial: {
        label: 'Late plateau (horizontal) → √(kx·ky)·h',
        hint: 'Click the late plateau (pseudo-radial flow in the horizontal plane).',
        plot: 'bourdet', clicks: 1, group: 'Horizontal wells',
        prompts: ['Click the late derivative plateau'],
        action: function (pts, cx) {
            var y = pts[0].y;
            if (!_pos(y)) return { error: 'Click on the derivative plateau.' };
            var h = cx.w('h'), v = 70.6 * cx.w('q') * cx.w('B') * cx.w('mu') / y;
            return { values: { kxKyH: v, kH: v / h }, warnings: [],
                     note: 'Late plateau Δp′ = ' + _fmt(y) + ' psi → √(kx·ky)·h = ' + _fmt(v) + ' md·ft (' + _fmt(v / h, 3) + ' md)' };
        }
    },

    // ── General ───────────────────────────────────────────────────────────
    slopeCheck: {
        label: 'Measure slope → flow regime',
        hint: 'Click two points on a curve to measure its log-log slope.',
        plot: 'bourdet', clicks: 2, group: 'General',
        prompts: ['Click the first point', 'Click the second point'],
        action: function (pts) {
            var dx = Math.log10(pts[1].x) - Math.log10(pts[0].x);
            if (!(Math.abs(dx) > 1e-6)) return { error: 'The two points need different times.' };
            var s = (Math.log10(pts[1].y) - Math.log10(pts[0].y)) / dx;
            var reg = _regimeForSlope(s);
            return { values: { slope: s }, text: reg, warnings: [], note: 'Slope ' + s.toFixed(3) + ' → ' + reg };
        }
    },

    // ── Straight lines on specialised plots ──────────────────────────────
    mdhLine: {
        label: 'Semilog line → kh, S',
        hint: 'Click two points on the semilog straight line (radial flow).',
        plot: 'mdh', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) { return _semilogLine('mdh', pts, cx); }
    },

    hornerLine: {
        label: 'Horner line → kh, p*, S',
        hint: 'Click two points on the Horner straight line (radial flow).',
        plot: 'horner', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) { return _semilogLine('horner', pts, cx); }
    },

    lineIntersection: {
        label: 'Line intersection → fault distance',
        hint: 'Click where the radial line and the steeper late line cross. Needs k.',
        plot: ['mdh', 'horner'], clicks: 1, group: 'Straight lines', needsK: true,
        prompts: ['Click where the two straight lines intersect'],
        action: function (pts, cx) {
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: fit the semilog line first (or pick the radial plateau).' };
            var tx;
            if (cx.plotKey === 'horner') {
                var tp = cx.tp();
                if (!tp) return { error: 'Needs the producing time tp (set it on Tab 1).' };
                var ratio = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
                if (!(ratio > 1)) return { error: 'Click to the right of Horner ratio 1.' };
                tx = tp / (ratio - 1);
            } else {
                tx = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
            }
            var L = 0.01217 * Math.sqrt(kk.k * tx / (cx.w('phi') * cx.w('mu') * cx.w('ct')));
            return { values: { tx: tx, L: L }, warnings: [],
                     note: 'Lines intersect at Δt = ' + _fmt(tx, 3) + ' hr → distance to a sealing fault ≈ ' + _fmt(L, 3) + ' ft' };
        }
    },

    sqrtLine: {
        label: '√t line → xf·√k',
        hint: 'Click two points on the straight line of the √t plot (linear flow).',
        plot: 'sqrt', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var xfk = 4.064 * cx.w('q') * cx.w('B') / (cx.w('h') * m) * _sqrtRatio(cx.w('mu'), cx.w('phi'), cx.w('ct'));
            var v = { mLinear: m, xfSqrtK: xfk }, kk = cx.k();
            if (kk) v.xf = xfk / Math.sqrt(kk.k);
            return { values: v, warnings: [],
                     note: '√t slope m = ' + _fmt(m) + ' psi/hr^½ → xf·√k = ' + _fmt(xfk) + ' ft·md^½' + (v.xf ? ', xf = ' + _fmt(v.xf) + ' ft' : '') };
        }
    },

    quarterLine: {
        label: '⁴√t line → kf·wf',
        hint: 'Click two points on the straight line of the ⁴√t plot (bilinear flow). Needs k.',
        plot: 'quarter', clicks: 2, group: 'Straight lines', needsK: true,
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var kk = cx.k();
            if (!kk) return { error: 'Needs k: pick the radial plateau first (or run a fit).' };
            var mu = cx.w('mu');
            var kfwf = Math.pow(44.1 * cx.w('q') * cx.w('B') * mu / (cx.w('h') * m * Math.pow(cx.w('phi') * mu * cx.w('ct') * kk.k, 0.25)), 2);
            return { values: { mBilinear: m, kfwf: kfwf }, warnings: [],
                     note: '⁴√t slope m = ' + _fmt(m) + ' psi/hr^¼ → kf·wf = ' + _fmt(kfwf) + ' md·ft' };
        }
    },

    sphericalLine: {
        label: 'Spherical line → spherical k',
        hint: 'Click two points on the straight line of the spherical (1/√t) plot.',
        plot: 'spherical', clicks: 2, group: 'Straight lines',
        prompts: ['Click a first point on the straight line', 'Click a second point on the straight line'],
        action: function (pts, cx) {
            var m = Math.abs((pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
            if (!_pos(m)) return { error: 'The two points need different x and y.' };
            var mu = cx.w('mu');
            var ks = Math.pow(2452.9 * cx.w('q') * cx.w('B') * mu * Math.sqrt(cx.w('phi') * mu * cx.w('ct')) / m, 2 / 3);
            return { values: { mSpherical: m, ks: ks }, warnings: [],
                     note: 'Spherical slope |m| = ' + _fmt(m) + ' psi·hr^½ → spherical k = ' + _fmt(ks) + ' md' };
        }
    }
};

// Semilog straight line (MDH: p vs log Δt; Horner: p vs log((tp+Δt)/Δt)).
function _semilogLine(kind, pts, cx) {
    var x0 = _semilogX(pts[0]), x1 = _semilogX(pts[1]);
    if (!(Math.abs(x1 - x0) > 1e-9)) return { error: 'The two points need different times.' };
    var m = (pts[1].y - pts[0].y) / (x1 - x0);         // psi per log cycle (signed)
    if (!(Math.abs(m) > 0)) return { error: 'The line is flat — pick two points on the sloping straight line.' };
    var warnings = [], v = {};
    var q = cx.w('q'), B = cx.w('B'), mu = cx.w('mu'), h = cx.w('h'), kh;
    if (cx.pseudo()) {
        var T = cx.rankine();
        if (!T) return { error: 'Gas pseudo-pressure data: set the reservoir temperature on Tab 1.' };
        kh = 1637 * q * T / Math.abs(m);
    } else {
        kh = 162.6 * q * B * mu / Math.abs(m);
    }
    var k = kh / h;
    v.m = m; v.kh = kh; v.k = k;
    var logTerm = function () {
        var phi = cx.w('phi'), ct = cx.w('ct'), rw = cx.w('rw');
        return Math.log10(k / (phi * mu * ct * rw * rw)) - 3.2275;
    };
    var ad = cx.ad(), tp = cx.tp(), yIsDp = cx.yIsDp();
    var tt = ad && ad.testType ? ad.testType : cx.well.testType;
    var t0, t1;
    if (kind === 'horner') {
        v.pStar = pts[0].y - m * x0;                    // line at log ratio = 0
        if (tp) {
            v.p1hr = v.pStar + m * Math.log10(tp + 1);
            var pwf0 = cx.pwf0();
            if (_num(pwf0)) {
                v.S = 1.1513 * (Math.abs(v.p1hr - pwf0) / Math.abs(m) - logTerm() + Math.log10((tp + 1) / tp));
            } else {
                warnings.push('Set pwf at shut-in (Tab 1) to compute skin.');
            }
            var r0 = pts[0].xKind === 'log' ? pts[0].x : Math.pow(10, pts[0].x);
            var r1 = pts[1].xKind === 'log' ? pts[1].x : Math.pow(10, pts[1].x);
            if (r0 > 1 && r1 > 1) { t0 = tp / (r0 - 1); t1 = tp / (r1 - 1); }
        } else {
            warnings.push('Set the producing time tp (Tab 1) to compute p1hr and skin.');
        }
    } else {
        v.p1hr = pts[0].y - m * x0;                     // line at Δt = 1 hr
        t0 = Math.pow(10, x0); t1 = Math.pow(10, x1);
        if (yIsDp) {
            v.S = 1.1513 * (Math.abs(v.p1hr) / Math.abs(m) - logTerm());
        } else if (_isBuildup(tt)) {
            var pw = cx.pwf0();
            if (_num(pw)) v.S = 1.1513 * (Math.abs(v.p1hr - pw) / Math.abs(m) - logTerm());
            else warnings.push('Set pwf at shut-in (Tab 1) to compute skin.');
        } else {
            var pi = cx.pi();
            if (_num(pi)) v.S = 1.1513 * (Math.abs(pi - v.p1hr) / Math.abs(m) - logTerm());
            else warnings.push('Set the initial pressure pi (Tab 1) to compute skin.');
        }
    }
    // Hand the clicked window to the semilog engine when it is available.
    if (_pos(t0) && _pos(t1)) {
        var eng = _semilogEngine(kind, t0, t1, cx);
        if (eng && _num(eng.S) && (!eng.method || eng.method === kind)) {
            if (_num(eng.m)) v.m = eng.m;
            if (_pos(eng.kh)) v.kh = eng.kh;
            if (_pos(eng.k)) v.k = eng.k;
            if (_num(eng.p1hr)) v.p1hr = eng.p1hr;
            if (kind === 'horner' && _num(eng.pStar)) v.pStar = eng.pStar;
            v.S = eng.S;
            warnings.push('Line fitted through the ' + (eng.n || 'measured') + ' data points between your two clicks.');
        }
    }
    v.m = Math.abs(v.m);
    var note = (kind === 'horner' ? 'Horner' : 'Semilog') + ' line m = ' + _fmt(v.m) + ' psi/cycle → kh = ' + _fmt(v.kh) +
               ' md·ft, k = ' + _fmt(v.k) + ' md' + (_num(v.pStar) ? ', p* = ' + _fmt(v.pStar, 5) + ' psia' : '') +
               (_num(v.S) ? ', S = ' + _fmt(v.S, 3) : '');
    return { values: v, warnings: warnings, note: note };
}

function _keyPlots(key) { return Array.isArray(key.plot) ? key.plot : [key.plot]; }
function _keyOnPlot(key, plotKey) { return _keyPlots(key).indexOf(plotKey) !== -1; }

function _plotLabel(plotKey) {
    var reg = G.PRiSM_PLOT_REGISTRY;
    if (reg && reg[plotKey] && reg[plotKey].label) return reg[plotKey].label;
    for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) if (_PLOTS_SNAPSHOT[i].key === plotKey) return _PLOTS_SNAPSHOT[i].label;
    return plotKey;
}

function _makeCtx(plotKey, axes) {
    var st = G.PRiSM_state || {};
    var well = _wellInputs();
    var used = {};
    var adCache, kCache;
    var cx = {
        st: st, well: well, plotKey: plotKey, axes: axes || null, used: used, kInfo: null,
        w: function (key) { used[key] = true; return well.v[key]; },
        ad: function () { if (adCache === undefined) adCache = _analysisData(); return adCache; },
        k: function () {
            if (kCache === undefined) { kCache = _kFromContext(st); cx.kInfo = kCache; }
            return kCache;
        },
        pseudo: function () {
            var ad = cx.ad();
            return !!(ad && (ad.pseudo === true || ad.dpUnit === 'psi2/cp'));
        },
        rankine: function () { return _rankine(well.T_R); },
        tp: function () {
            var ad = cx.ad();
            if (ad && _pos(ad.tp)) return ad.tp;
            return well.tp;
        },
        pwf0: function () {
            var ad = cx.ad();
            if (ad && ad.pRefSource === 'pwf0' && _num(ad.pRef)) return ad.pRef;
            if (_num(well.pwf0)) return well.pwf0;
            if (ad && _isBuildup(ad.testType) && _num(ad.pRef)) return ad.pRef;
            return null;
        },
        pi: function () {
            var ad = cx.ad();
            if (ad && ad.pRefSource === 'pi' && _num(ad.pRef)) return ad.pRef;
            return well.pi;
        },
        yIsDp: function () {
            var lab = axes && axes.scaleY && axes.scaleY.label;
            return !!(lab && /Δp|dp|delta/i.test(String(lab)) && !/pws|pwf|pressure,?\s*p\b/i.test(String(lab)));
        },
        // Equivalent drawdown time (Agarwal) on a single-rate buildup.
        teq: function (t) {
            var ad = cx.ad(), tp = cx.tp();
            if (ad && _isBuildup(ad.testType) && _pos(tp)) return tp * t / (tp + t);
            return t;
        }
    };
    return cx;
}

function _defaultKinds(plotKey) {
    if (plotKey === 'bourdet' || plotKey === 'sandface') return { x: 'log', y: 'log' };
    if (plotKey === 'mdh' || plotKey === 'horner') return { x: 'log', y: 'lin' };
    return { x: 'lin', y: 'lin' };
}

function _normPoint(p, kinds) {
    p = p || {};
    return {
        x: _num(p.x) ? p.x : (_num(p.t) ? p.t : p.dataX),
        y: _num(p.y) ? p.y : p.dataY,
        xKind: p.xKind || kinds.x, yKind: p.yKind || kinds.y
    };
}

// Run a tool on data-space points: points = [{x, y}] (or {t, y}).
G.PRiSM_runAnalysisKey = function (keyName, points, opts) {
    opts = opts || {};
    var key = G.PRiSM_analysisKeys[keyName];
    if (!key) return { ok: false, error: 'Unknown tool: ' + keyName };
    if (!Array.isArray(points) || points.length < key.clicks) {
        return { ok: false, error: key.label + ' needs ' + key.clicks + ' point(s).' };
    }
    var plotKey = opts.plotKey || _keyPlots(key)[0];
    var kinds = _defaultKinds(plotKey), pts = [];
    for (var i = 0; i < key.clicks; i++) {
        var np = _normPoint(points[i], kinds);
        if (!_num(np.x) || !_num(np.y)) return { ok: false, error: 'Point ' + (i + 1) + ' is not a number.' };
        pts.push(np);
    }
    var cx = _makeCtx(plotKey, opts.axes);
    var res;
    try { res = key.action(pts, cx); } catch (e) { res = { error: 'Calculation failed: ' + (e && e.message) }; }
    if (!res || res.error) return { ok: false, error: (res && res.error) || 'No result.' };
    var usedKeys = Object.keys(cx.used);
    var defaulted = usedKeys.filter(function (k) { return cx.well.defaulted.indexOf(k) !== -1; });
    var warnings = (res.warnings || []).slice();
    if (defaulted.length) {
        warnings.unshift('Default inputs used (' + defaulted.map(function (k) { return WELL_LABEL[k]; }).join(', ') +
                         ') — confirm them in Well & Test on Tab 1.');
    }
    var inputs = {};
    usedKeys.forEach(function (k) { inputs[k] = cx.well.v[k]; });
    var entry = {
        key: keyName, label: key.label, plotKey: plotKey,
        values: res.values || {}, text: res.text || null, note: res.note || '',
        warnings: warnings, defaultInputs: defaulted, inputs: inputs, inputSource: cx.well.source,
        kSource: cx.kInfo ? cx.kInfo.source : null,
        points: pts.map(function (p) { return { x: p.x, y: p.y }; }),
        timestamp: Date.now()
    };
    // Display map (quantity label with unit → value) for generic report readers.
    var results = {};
    Object.keys(entry.values).forEach(function (vk) {
        var qd = QTY[vk] || { label: vk, unit: '' };
        if (_num(entry.values[vk])) results[qd.label + (qd.unit ? ' (' + qd.unit + ')' : '')] = entry.values[vk];
    });
    entry.results = results;
    var st = G.PRiSM_state;
    if (!st) st = G.PRiSM_state = {};
    if (!st.analysisKeyResults || typeof st.analysisKeyResults !== 'object') st.analysisKeyResults = {};
    st.analysisKeyResults[keyName] = entry;
    _emit('prism:analysis-key', { key: keyName, result: entry });
    if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e2) { /* non-fatal */ } }
    _refreshToolbars();
    return { ok: true, key: keyName, result: entry };
};

// Rows for reports: one row per value of every stored result.
G.PRiSM_analysisKeyReportRows = function () {
    var st = G.PRiSM_state || {}, r = st.analysisKeyResults || {}, rows = [];
    Object.keys(r).sort(function (a, b) { return (r[a].timestamp || 0) - (r[b].timestamp || 0); }).forEach(function (k) {
        var e = r[k];
        if (!e || !e.values) return;
        Object.keys(e.values).forEach(function (vk) {
            var qd = QTY[vk] || { label: vk, unit: '' };
            rows.push({ key: k, tool: e.label, quantity: qd.label, value: e.values[vk], unit: qd.unit,
                        defaulted: !!(e.defaultInputs && e.defaultInputs.length) });
        });
        if (e.text) rows.push({ key: k, tool: e.label, quantity: 'Interpretation', value: e.text, unit: '', defaulted: false });
    });
    return rows;
};

// ---- Axis inversion (C6 _prismAxes) --------------------------------------
function _invAxis(sc, off, len, flip) {
    if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
    var lo = sc.min, hi = sc.max;
    if (sc.kind === 'log') {
        if (!(lo > 0 && hi > 0)) return null;
        var a = Math.log10(lo), b = Math.log10(hi);
        return function (px) { var f = (px - off) / len; if (flip) f = 1 - f; return Math.pow(10, a + f * (b - a)); };
    }
    return function (px) { var f = (px - off) / len; if (flip) f = 1 - f; return lo + f * (hi - lo); };
}

function _axesInverse(ax) {
    if (!ax) return null;
    var plot = ax.plot || null;
    var kx = (ax.scaleX && ax.scaleX.kind) || (ax.xLog ? 'log' : 'lin');
    var ky = (ax.scaleY && ax.scaleY.kind) || (ax.yLog ? 'log' : 'lin');
    if (typeof ax.fromX === 'function' && typeof ax.fromY === 'function') {
        return { fromX: ax.fromX, fromY: ax.fromY, plot: plot, xKind: kx, yKind: ky };
    }
    if (ax.scaleX && ax.scaleY && plot) {
        var fx = _invAxis(ax.scaleX, plot.x, plot.w, false);
        var fy = _invAxis(ax.scaleY, plot.y, plot.h, true);
        if (fx && fy) return { fromX: fx, fromY: fy, plot: plot, xKind: kx, yKind: ky };
    }
    if (_num(ax.x0) && _num(ax.x1) && _num(ax.dx0) && _num(ax.dx1)) {       // older shape
        var p2 = { x: ax.x0, y: ax.y0, w: ax.x1 - ax.x0, h: ax.y1 - ax.y0 };
        var gx = _invAxis({ kind: kx, min: ax.dx0, max: ax.dx1 }, p2.x, p2.w, false);
        var gy = _invAxis({ kind: ky, min: ax.dy0, max: ax.dy1 }, p2.y, p2.h, true);
        if (gx && gy) return { fromX: gx, fromY: gy, plot: p2, xKind: kx, yKind: ky };
    }
    return null;
}

function _fwdAxis(sc, off, len, flip) {
    if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
    if (sc.kind === 'log') {
        if (!(sc.min > 0 && sc.max > 0)) return null;
        var a = Math.log10(sc.min), b = Math.log10(sc.max);
        return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
    }
    return function (v) { var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
}

function _axesForward(ax) {
    if (!ax) return null;
    if (typeof ax.toX === 'function' && typeof ax.toY === 'function') return { toX: ax.toX, toY: ax.toY, plot: ax.plot };
    if (ax.scaleX && ax.scaleY && ax.plot) {
        var fx = _fwdAxis(ax.scaleX, ax.plot.x, ax.plot.w, false), fy = _fwdAxis(ax.scaleY, ax.plot.y, ax.plot.h, true);
        if (fx && fy) return { toX: fx, toY: fy, plot: ax.plot };
    }
    return null;
}

function _toDataCoords(canvas, ev) {
    var inv = _axesInverse(canvas && canvas._prismAxes);
    if (!inv) return null;
    var rect = { left: 0, top: 0, width: 0, height: 0 };
    try { if (canvas.getBoundingClientRect) rect = canvas.getBoundingClientRect(); } catch (e) { /* keep */ }
    var px = (ev.clientX || 0) - (rect.left || 0);
    var py = (ev.clientY || 0) - (rect.top || 0);
    var plot = inv.plot || {};
    // Canvas shown at a different CSS size than it was drawn at → rescale.
    if (plot.cssW && rect.width > 0 && Math.abs(rect.width - plot.cssW) > 0.5) px *= plot.cssW / rect.width;
    if (plot.cssH && rect.height > 0 && Math.abs(rect.height - plot.cssH) > 0.5) py *= plot.cssH / rect.height;
    var inside = !(plot.w > 0) ||
        (px >= plot.x - 1 && px <= plot.x + plot.w + 1 && py >= plot.y - 1 && py <= plot.y + plot.h + 1);
    return { px: px, py: py, x: inv.fromX(px), y: inv.fromY(py), xKind: inv.xKind, yKind: inv.yKind, inside: inside };
}

// ---- Arming (Pointer Events) ----------------------------------------------
var _arm = null;   // { key, canvas, listener, pts[], prevCursor, prevTouch }

function _statusEls() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return [];
    try { return Array.prototype.slice.call(document.querySelectorAll('[data-prism-akey-status]')); } catch (e) { return []; }
}

function _status(msg, kind) {
    var color = kind === 'error' ? 'var(--red, #f85149)' : kind === 'warn' ? 'var(--yellow, #d29922)' :
                kind === 'success' ? 'var(--green, #3fb950)' : 'var(--text2, #8b949e)';
    var els = _statusEls();
    for (var i = 0; i < els.length; i++) { els[i].textContent = msg || ''; els[i].style.color = color; }
    if (!els.length && msg && kind && kind !== 'info') _polishToast(msg, kind);
}

function _showHint(text) {
    if (!_hasDoc || !document.body) return;
    var h = document.getElementById('prism_akey_hint');
    if (!h) {
        h = document.createElement('div');
        h.id = 'prism_akey_hint';
        h.setAttribute('role', 'status');
        h.style.cssText =
            'position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:99999;' +
            'background:var(--bg2, #161b22); border:1px solid var(--accent, #f0883e); color:var(--text, #e6edf3);' +
            'padding:8px 12px; border-radius:6px; font:12px sans-serif; text-align:center;' +
            'max-width:calc(100vw - 32px); box-sizing:border-box; box-shadow:0 4px 10px rgba(0,0,0,.4);';
        document.body.appendChild(h);
    }
    h.textContent = text;
}

function _hideHint() {
    if (!_hasDoc) return;
    var h = document.getElementById('prism_akey_hint');
    if (h && h.parentNode) h.parentNode.removeChild(h);
}

function _markArmedButtons() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
    var nodes = document.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        var on = !!(_arm && nodes[i].getAttribute('data-prism-akey') === _arm.key);
        nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        nodes[i].style.outline = on ? '2px solid var(--accent, #f0883e)' : '';
    }
}

function _disarm() {
    if (_arm && _arm.canvas) {
        try { _arm.canvas.removeEventListener('pointerdown', _arm.listener); } catch (e) { /* ignore */ }
        try {
            _arm.canvas.style.cursor = _arm.prevCursor || '';
            _arm.canvas.style.touchAction = _arm.prevTouch || '';
        } catch (e2) { /* ignore */ }
    }
    _arm = null;
    _hideHint();
    _markArmedButtons();
}

function _prompt() {
    if (!_arm) return;
    var key = G.PRiSM_analysisKeys[_arm.key];
    var n = _arm.pts.length;
    var text = (key.prompts && key.prompts[n]) || ('Click point ' + (n + 1) + ' of ' + key.clicks);
    var msg = key.label + ': ' + text + (key.clicks > 1 ? ' (' + (n + 1) + '/' + key.clicks + ')' : '') + ' — Esc to cancel';
    _showHint(msg);
    _status(msg, 'info');
}

function _markClick(canvas, px, py) {
    try {
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.save();
        ctx.strokeStyle = '#f0883e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
        ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
        ctx.stroke();
        ctx.restore();
    } catch (e) { /* cosmetic */ }
}

function _onPointer(ev) {
    if (!_arm) return;
    if (ev && ev.button != null && ev.button > 0) return;          // secondary buttons
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
    var canvas = _arm.canvas, key = G.PRiSM_analysisKeys[_arm.key];
    var pt = _toDataCoords(canvas, ev);
    if (!pt) { _status('The plot axes are not available — redraw the plot and pick the tool again.', 'error'); _disarm(); return; }
    if (!pt.inside) { _status('Click inside the plot area.', 'warn'); return; }
    _arm.pts.push(pt);
    _markClick(canvas, pt.px, pt.py);
    if (_arm.pts.length < key.clicks) { _prompt(); return; }
    var name = _arm.key, pts = _arm.pts.slice(), axes = canvas._prismAxes;
    var plotKey = (G.PRiSM_state && G.PRiSM_state.activePlot) || (axes && axes.plotKey) || _keyPlots(key)[0];
    _disarm();
    var r = G.PRiSM_runAnalysisKey(name, pts, { plotKey: plotKey, axes: axes });
    if (r.ok) {
        var warn = r.result.warnings && r.result.warnings.length;
        _status(r.result.note + (warn ? ' — ' + r.result.warnings[0] : ''), warn ? 'warn' : 'success');
    } else {
        _status(r.error, 'error');
    }
}

G.PRiSM_armAnalysisKey = function (keyName, opts) {
    opts = opts || {};
    var key = G.PRiSM_analysisKeys[keyName];
    if (!key) { _status('Unknown tool: ' + keyName, 'error'); return false; }
    var st = G.PRiSM_state || {};
    var plotKey = st.activePlot || 'bourdet';
    if (!_keyOnPlot(key, plotKey)) {
        _status('"' + key.label + '" works on the ' + _keyPlots(key).map(_plotLabel).join(' / ') +
                ' plot — switch the plot type first.', 'warn');
        return false;
    }
    var canvas = opts.canvas || (_hasDoc ? document.getElementById('prism_plot_canvas') : null);
    if (!canvas) { _status('Open the diagnostic plot first.', 'error'); return false; }
    if (!_axesInverse(canvas._prismAxes)) {
        _status('The plot has not been drawn yet — draw it, then pick the tool again.', 'error');
        return false;
    }
    _disarm();
    _arm = { key: keyName, canvas: canvas, pts: [], listener: _onPointer,
             prevCursor: canvas.style ? canvas.style.cursor : '', prevTouch: canvas.style ? canvas.style.touchAction : '' };
    try { canvas.style.cursor = 'crosshair'; canvas.style.touchAction = 'none'; } catch (e) { /* ignore */ }
    canvas.addEventListener('pointerdown', _onPointer);
    _markArmedButtons();
    _prompt();
    return true;
};

G.PRiSM_disarmAnalysisKey = function () { var was = !!_arm; _disarm(); if (was) _status('Tool cancelled.', 'info'); };

if (_hasDoc) {
    _on(document, 'keydown', function (ev) {
        if (ev && ev.key === 'Escape' && _arm) { _disarm(); _status('Tool cancelled.', 'info'); }
    });
}

// ---- Toolbar + results -----------------------------------------------------
var _BTN_CSS = 'font-size:12px; padding:6px 10px; margin:0; white-space:normal; text-align:left; ' +
               'max-width:100%; box-sizing:border-box; line-height:1.3;';

function _resultRowHTML(e) {
    var parts = [];
    Object.keys(e.values || {}).forEach(function (vk) {
        var qd = QTY[vk] || { label: vk, unit: '' };
        var val = e.values[vk];
        var sig = (vk === 'pStar' || vk === 'p1hr') ? 5 : 4;
        parts.push('<span style="white-space:nowrap;">' + _esc(qd.label) + ' <b style="color:var(--text, #e6edf3);">' +
                   _esc(_fmt(val, sig)) + '</b>' + (qd.unit ? ' ' + _esc(qd.unit) : '') + '</span>');
    });
    var chip = (e.defaultInputs && e.defaultInputs.length)
        ? ' <span title="' + _esc(e.warnings[0] || '') + '" style="display:inline-block; font-size:10px; padding:1px 6px; border-radius:8px; ' +
          'background:rgba(210,153,34,.18); color:var(--yellow, #d29922); border:1px solid var(--yellow, #d29922);">default inputs</span>'
        : '';
    var warn = '';
    (e.warnings || []).forEach(function (w, i) {
        if (i === 0 && chip) return;     // already shown as the chip tooltip
        warn += '<div style="font-size:11px; color:var(--yellow, #d29922); margin-top:2px;">' + _esc(w) + '</div>';
    });
    return '<div data-prism-akey-row="' + _esc(e.key) + '" style="padding:6px 0; border-top:1px solid var(--border, #30363d); ' +
               'font-size:12px; color:var(--text2, #8b949e); overflow-wrap:anywhere;">' +
             '<div style="display:flex; gap:6px; align-items:flex-start; justify-content:space-between;">' +
               '<div style="min-width:0;"><span style="color:var(--text, #e6edf3); font-weight:600;">' + _esc(e.label) + '</span>' + chip + '</div>' +
               '<button type="button" data-prism-akey-clear="' + _esc(e.key) + '" aria-label="Remove result" ' +
                 'style="background:none; border:none; color:var(--text3, #6e7681); cursor:pointer; font-size:14px; padding:0 4px;">×</button>' +
             '</div>' +
             '<div style="display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:2px;">' + parts.join('') + '</div>' +
             (e.text ? '<div style="margin-top:2px;">' + _esc(e.text) + '</div>' : '') +
             warn +
           '</div>';
}

G.PRiSM_renderAnalysisKeyToolbar = function (container, plotKey) {
    if (!_hasDoc) return;
    var host = (typeof container === 'string') ? document.getElementById(container) : container;
    if (!host) return;
    var st = G.PRiSM_state || {};
    plotKey = plotKey || st.activePlot || 'bourdet';
    host.setAttribute('data-prism-linetools', '1');     // refreshed with the active plot
    var keys = G.PRiSM_analysisKeys, groups = {}, order = [];
    Object.keys(keys).forEach(function (k) {
        if (!_keyOnPlot(keys[k], plotKey)) return;
        var g = keys[k].group || 'Tools';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(k);
    });
    var well = _wellInputs();
    var chip = '';
    if (well.defaulted.length) {
        chip = '<div data-prism-akey-defaults style="margin:6px 0; padding:6px 8px; border-radius:6px; font-size:12px; ' +
               'background:rgba(210,153,34,.12); border:1px solid var(--yellow, #d29922); color:var(--yellow, #d29922);">' +
               '⚠ Default inputs: ' + _esc(well.defaulted.map(function (k) { return WELL_LABEL[k]; }).join(', ')) +
               ' — results that use them are marked. Set them in Well & Test on Tab 1.</div>';
    }
    var btns = '';
    order.forEach(function (g) {
        btns += '<div style="margin-top:6px;"><div style="font-size:11px; color:var(--text3, #6e7681); margin-bottom:4px;">' + _esc(g) + '</div>' +
                '<div style="display:flex; flex-wrap:wrap; gap:6px;">';
        groups[g].forEach(function (k) {
            btns += '<button type="button" class="btn btn-secondary" data-prism-akey="' + _esc(k) + '" title="' + _esc(keys[k].hint || '') + '" ' +
                    'style="' + _BTN_CSS + '">' + _esc(keys[k].label) + '</button>';
        });
        btns += '</div></div>';
    });
    if (!btns) {
        btns = '<div style="font-size:12px; color:var(--text3, #6e7681); margin-top:6px;">No line tools for the ' +
               _esc(_plotLabel(plotKey)) + ' plot. Switch to the log-log derivative, semilog, Horner, √t, ⁴√t or spherical plot.</div>';
    }
    var res = st.analysisKeyResults || {};
    var resKeys = Object.keys(res).filter(function (k) { return res[k] && res[k].values; })
        .sort(function (a, b) { return (res[b].timestamp || 0) - (res[a].timestamp || 0); });
    var rows = resKeys.map(function (k) { return _resultRowHTML(res[k]); }).join('');
    host.innerHTML =
        '<div class="prism-linetools" style="max-width:100%; box-sizing:border-box; color:var(--text, #e6edf3);">' +
          '<div style="font-size:12px; color:var(--text2, #8b949e);">Tools for the <b style="color:var(--text, #e6edf3);">' +
            _esc(_plotLabel(plotKey)) + '</b> plot — pick a tool, then click the plot.</div>' +
          chip + btns +
          '<div data-prism-akey-status role="status" aria-live="polite" style="margin-top:8px; font-size:12px; min-height:16px; ' +
            'color:var(--text2, #8b949e); overflow-wrap:anywhere;"></div>' +
          (rows
            ? '<div style="margin-top:6px;"><div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">' +
                '<span style="font-size:11px; color:var(--text3, #6e7681);">Results</span>' +
                '<button type="button" data-prism-akey-clearall style="background:none; border:1px solid var(--border, #30363d); ' +
                  'color:var(--text2, #8b949e); border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer;">Clear all</button></div>' +
                rows + '</div>'
            : '') +
        '</div>';
    var nodes = host.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        (function (node) {
            node.onclick = function () { G.PRiSM_armAnalysisKey(node.getAttribute('data-prism-akey')); };
        })(nodes[i]);
    }
    var clears = host.querySelectorAll('[data-prism-akey-clear]');
    for (var j = 0; j < clears.length; j++) {
        (function (node) {
            node.onclick = function () {
                var s = G.PRiSM_state || {};
                if (s.analysisKeyResults) delete s.analysisKeyResults[node.getAttribute('data-prism-akey-clear')];
                if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
                _refreshToolbars();
                _redraw();
            };
        })(clears[j]);
    }
    var ca = host.querySelector('[data-prism-akey-clearall]');
    if (ca) ca.onclick = function () {
        var s = G.PRiSM_state || {};
        s.analysisKeyResults = {};
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
        _refreshToolbars();
        _redraw();
    };
    _markArmedButtons();
};

function _refreshToolbars() {
    if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
    var hosts;
    try { hosts = document.querySelectorAll('[data-prism-linetools]'); } catch (e) { return; }
    for (var i = 0; i < hosts.length; i++) {
        try { G.PRiSM_renderAnalysisKeyToolbar(hosts[i]); } catch (e2) { /* ignore */ }
    }
}

function _redraw() {
    if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
}

// Tab 2 panel (C7).
_registerTabPanel(2, {
    id: 'linetools',
    title: 'Plot line tools',
    order: 10,
    collapsed: false,
    render: function (host) {
        if (!host) return;
        host.innerHTML = '<div id="prism_linetools"></div>';
        G.PRiSM_renderAnalysisKeyToolbar(host.querySelector('#prism_linetools') || host);
    }
});

_on(G, 'prism:plot-changed', function () {
    var st = G.PRiSM_state || {};
    if (_arm && !_keyOnPlot(G.PRiSM_analysisKeys[_arm.key], st.activePlot || 'bourdet')) _disarm();
    _refreshToolbars();
});
_on(G, 'prism:well-changed', _refreshToolbars);
_on(G, 'prism:dataset-loaded', _refreshToolbars);

// Post-draw hook (C7): redraw the stored picks of the tools used on this plot.
function _linetoolsPostDraw(info) {
    if (!info || !info.canvas || !info.canvas.getContext) return;
    var st = G.PRiSM_state || {}, res = st.analysisKeyResults || {};
    var tr = _axesForward(info.axes || info.canvas._prismAxes);
    if (!tr) return;
    var plotKey = info.plotKey || st.activePlot;
    var list = Object.keys(res).map(function (k) { return res[k]; })
        .filter(function (e) { return e && e.plotKey === plotKey && Array.isArray(e.points); })
        .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); }).slice(0, 4);
    if (!list.length) return;
    var ctx = info.canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    try {
        var pl = tr.plot;
        if (pl && _num(pl.w)) { ctx.beginPath(); ctx.rect(pl.x, pl.y, pl.w, pl.h); ctx.clip(); }
        list.forEach(function (e) {
            var xy = e.points.map(function (p) { return [tr.toX(p.x), tr.toY(p.y)]; })
                .filter(function (p) { return _num(p[0]) && _num(p[1]); });
            if (!xy.length) return;
            ctx.strokeStyle = 'rgba(240,136,62,0.9)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            if (xy.length >= 2) {
                ctx.beginPath(); ctx.moveTo(xy[0][0], xy[0][1]);
                for (var i = 1; i < xy.length; i++) ctx.lineTo(xy[i][0], xy[i][1]);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            xy.forEach(function (p) {
                ctx.beginPath(); ctx.moveTo(p[0] - 5, p[1]); ctx.lineTo(p[0] + 5, p[1]);
                ctx.moveTo(p[0], p[1] - 5); ctx.lineTo(p[0], p[1] + 5); ctx.stroke();
            });
        });
    } catch (e) { /* cosmetic */ }
    ctx.restore();
}
_linetoolsPostDraw._prismId = 'linetools-picks';

function _registerPostDraw(fn) {
    var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
    for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
    hooks.push(fn);
}
_registerPostDraw(_linetoolsPostDraw);


// =========================================================================
// SECTION 3 — PNG / PDF EXPORT
// =========================================================================
// Plots are rendered off-screen from window.PRiSM_buildPlotData(plotKey)
// (C7) — the same data the screen uses — and the post-draw hooks are run
// on the off-screen canvas so exports match the screen.
// =========================================================================

var _PLOTS_SNAPSHOT = [
    { key: 'cartesian',     fn: 'PRiSM_plot_cartesian',             label: 'Cartesian P vs t',      mode: 'transient' },
    { key: 'horner',        fn: 'PRiSM_plot_horner',                label: 'Horner',                mode: 'transient' },
    { key: 'mdh',           fn: 'PRiSM_plot_mdh',                   label: 'Semilog (MDH)',         mode: 'transient' },
    { key: 'bourdet',       fn: 'PRiSM_plot_bourdet',               label: 'Log-Log Bourdet',       mode: 'transient' },
    { key: 'sqrt',          fn: 'PRiSM_plot_sqrt_time',             label: 'Square-root time',      mode: 'transient' },
    { key: 'quarter',       fn: 'PRiSM_plot_quarter_root_time',     label: 'Quarter-root time',     mode: 'transient' },
    { key: 'spherical',     fn: 'PRiSM_plot_spherical',             label: 'Spherical',             mode: 'transient' },
    { key: 'sandface',      fn: 'PRiSM_plot_sandface_convolution',  label: 'Material-balance time', mode: 'transient' },
    { key: 'superposition', fn: 'PRiSM_plot_buildup_superposition', label: 'Buildup superposition', mode: 'transient' },
    { key: 'rateCart',      fn: 'PRiSM_plot_rate_time_cartesian',   label: 'Rate vs time (cart)',   mode: 'decline' },
    { key: 'rateSemi',      fn: 'PRiSM_plot_rate_time_semilog',     label: 'Rate vs time (semi)',   mode: 'decline' },
    { key: 'rateLog',       fn: 'PRiSM_plot_rate_time_loglog',      label: 'Rate vs time (log)',    mode: 'decline' },
    { key: 'rateCum',       fn: 'PRiSM_plot_rate_cumulative',       label: 'Rate vs cumulative',    mode: 'decline' },
    { key: 'lossRatio',     fn: 'PRiSM_plot_loss_ratio',            label: 'Loss-ratio',            mode: 'decline' },
    { key: 'typeCurve',     fn: 'PRiSM_plot_typecurve_overlay',     label: 'Type-curve overlay',    mode: 'decline' }
];

function _plotEntries() {
    var reg = G.PRiSM_PLOT_REGISTRY, out = [];
    if (reg && typeof reg === 'object') {
        for (var k in reg) {
            if (!Object.prototype.hasOwnProperty.call(reg, k) || !reg[k]) continue;
            out.push({ key: k, fn: reg[k].fn, label: reg[k].label || k, mode: reg[k].mode || 'transient' });
        }
    }
    if (!out.length) out = _PLOTS_SNAPSHOT.slice();
    return out;
}

function _plotFn(entry) {
    if (!entry) return null;
    if (typeof entry.fn === 'function') return entry.fn;
    if (typeof entry.fn === 'string' && typeof G[entry.fn] === 'function') return G[entry.fn];
    return null;
}

G.PRiSM_listPlots = function () {
    return _plotEntries().map(function (e) {
        return { key: e.key, fn: typeof e.fn === 'string' ? e.fn : ((e.fn && e.fn.name) || ''), label: e.label, mode: e.mode };
    });
};

var _DECLINE_PLOTS = { rateCart: 1, rateSemi: 1, rateLog: 1, rateCum: 1, lossRatio: 1, typeCurve: 1 };

// Only used when the dispatcher's PRiSM_buildPlotData is not available.
function _fallbackPlotData(plotKey) {
    var ds = G.PRiSM_dataset;
    if (!ds || !ds.t || !ds.t.length) return null;
    if (_DECLINE_PLOTS[plotKey]) {
        var td = [];
        for (var i = 0; i < ds.t.length; i++) td.push(ds.t[i] / 24);
        return { data: { t: td, q: ds.q || null }, opts: { timeUnit: 'd', xLabel: 'Time (days)' } };
    }
    if (plotKey === 'cartesian') return { data: { t: ds.t, p: ds.p, q: ds.q, periods: ds.periods }, opts: {} };
    var ad = _analysisData();
    if (ad && ad.ok) {
        if (plotKey === 'bourdet' || plotKey === 'sandface') return { data: { t: ad.t, dp: ad.dp, deriv: ad.deriv }, opts: {} };
        var o = {};
        if (_pos(ad.tp)) o.tp = ad.tp;
        return { data: { t: ad.t, p: ad.p, dp: ad.dp, tp: ad.tp }, opts: o };
    }
    return { data: { t: ds.t, p: ds.p, q: ds.q }, opts: {} };
}

// Render a plot off-screen → canvas (or null).
G.PRiSM_renderPlotToCanvas = function (plotKey, w, h) {
    if (!_hasDoc) return null;
    var entries = _plotEntries(), entry = null;
    for (var i = 0; i < entries.length; i++) if (entries[i].key === plotKey) { entry = entries[i]; break; }
    var fn = _plotFn(entry);
    if (!fn) return null;
    var built = null;
    if (typeof G.PRiSM_buildPlotData === 'function') {
        try { built = G.PRiSM_buildPlotData(plotKey); } catch (e) { built = null; }
    }
    if (!built || !built.data) built = _fallbackPlotData(plotKey);
    if (!built || !built.data) return null;
    w = w || 1200; h = h || 800;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    try { c.style.width = w + 'px'; c.style.height = h + 'px'; } catch (e0) { /* ignore */ }
    var o = {}, src = built.opts || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k];
    o.width = w; o.height = h; o.hover = false; o.dragZoom = false;
    if (o.showLegend == null) o.showLegend = true;
    var st = G.PRiSM_state || {};
    if (o.smoothL == null && _num(st.bourdetL)) o.smoothL = st.bourdetL;
    try { fn(c, built.data, o); } catch (e1) {
        try { console.warn('PRiSM export: plot ' + plotKey + ' failed: ' + (e1 && e1.message)); } catch (e2) { /* ignore */ }
    }
    var hooks = G.PRiSM_postDrawHooks;
    if (Array.isArray(hooks)) {
        for (var j = 0; j < hooks.length; j++) {
            try { hooks[j]({ canvas: c, plotKey: plotKey, data: built.data, opts: o, axes: c._prismAxes || null, exporting: true }); }
            catch (e3) { /* a hook must never break an export */ }
        }
    }
    return c;
};

function _plotDataURL(plotKey, w, h) {
    var c = G.PRiSM_renderPlotToCanvas(plotKey, w, h);
    if (!c) return null;
    try { return c.toDataURL('image/png'); } catch (e) { return null; }
}

G.PRiSM_exportPlotPNG = function (plotKey) {
    var st = G.PRiSM_state || {};
    plotKey = plotKey || st.activePlot || 'bourdet';
    var url = _plotDataURL(plotKey, 1200, 800);
    if (!url || !_hasDoc) {
        _polishToast('PNG export failed — the ' + _plotLabel(plotKey) + ' plot is not available.', 'error');
        return false;
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = 'prism_' + plotKey + '.png';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    _polishToast('PNG saved: prism_' + plotKey + '.png', 'success');
    return true;
};

function _galleryHTML() {
    var ds = G.PRiSM_dataset;
    if (!ds || !ds.t || !ds.t.length) return '<p><em>No dataset loaded — plot gallery skipped.</em></p>';
    var mode = (G.PRiSM && G.PRiSM.mode) || 'transient';
    var html = '<h2 style="page-break-before:always;">Plots</h2>', cnt = 0;
    _plotEntries().forEach(function (e) {
        if (mode !== 'combined' && e.mode !== mode && e.mode !== 'both') return;
        var url = _plotDataURL(e.key, 1200, 800);
        if (!url) return;
        cnt++;
        html += '<div style="page-break-inside:avoid; margin-bottom:18px;"><h3 style="margin:6px 0;">' + _esc(e.label) + '</h3>' +
                '<img src="' + url + '" alt="' + _esc(e.label) + '" style="width:100%; max-width:1100px; height:auto; border:1px solid #ccc;"/></div>';
    });
    if (!cnt) html += '<p><em>No plots could be rendered.</em></p>';
    return html;
}

// PDF export: report body (36) + PNG gallery → host PDF pipeline.
// Returns 'host' | 'window' | false.
G.PRiSM_exportReportPDF = function () {
    var body;
    try {
        body = (typeof G.PRiSM_buildReportHTML === 'function')
            ? G.PRiSM_buildReportHTML({ plots: false })   // the gallery below carries the plots
            : '<p>(The report builder is not available — plots only.)</p>';
    } catch (e) {
        _polishToast('Report build failed: ' + (e && e.message), 'error');
        return false;
    }
    var html = String(body || '') + _galleryHTML();
    var st = G.PRiSM_state || {};
    var title = 'PRiSM Well-Test Analysis';
    var sub = st.model ? ('Model: ' + st.model) : '';
    // Lexical host pipeline (this file is concatenated inside the host IIFE).
    if (typeof exportReport === 'function') {
        try { exportReport(title, html, sub); return 'host'; }
        catch (e1) { try { console.warn('Host report export failed, using a print window: ' + e1.message); } catch (e2) { /* ignore */ } }
    }
    if (typeof G.exportReport === 'function') {
        try { G.exportReport(title, html, sub); return 'host'; } catch (e3) { /* fall through */ }
    }
    var w = null;
    try { w = G.open('', 'prism_report', 'width=900,height=1100'); } catch (e4) { w = null; }
    if (!w || !w.document) {
        _polishToast('Pop-up blocked — allow pop-ups to export the report.', 'error');
        return false;
    }
    var full = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<style>body{font-family:Arial,sans-serif;margin:24px;color:#222;}h1,h2,h3{color:#222;}' +
        'table{border-collapse:collapse;margin:8px 0;}th,td{border:1px solid #ddd;padding:4px 8px;font-size:12px;}' +
        'img{max-width:100%;height:auto;}@media print{body{margin:12px;}}</style></head><body>' +
        '<h1>' + title + '</h1>' + html +
        '<script>window.onload=function(){setTimeout(function(){try{window.print();}catch(e){}},400);};<\/script>' +
        '</body></html>';
    try {
        w.document.open(); w.document.write(full); w.document.close();
        _polishToast('Report opened — use the print dialog to save it as PDF.', 'success');
        return 'window';
    } catch (e5) {
        _polishToast('Print-window write failed: ' + (e5 && e5.message), 'error');
        return false;
    }
};


// =========================================================================
// SECTION 4 — USAGE ANALYTICS (GA4)
// =========================================================================
// Tab opens come from the shell's PRiSM_tabHooks.any; model and fit events
// from window CustomEvents. Nothing is wrapped and nothing polls.
// =========================================================================

function _ga4(eventName, params) {
    if (typeof G.gtag === 'function') {
        try { G.gtag('event', eventName, params); } catch (e) { /* GA must never break the app */ }
    }
}

var _TAB_NAMES = ['', 'Data', 'Plots', 'Model', 'Params', 'Match', 'Regress', 'Report'];

function _gaTabHook(n) {
    _ga4('prism_tab_open', { event_category: 'PRiSM', event_label: _TAB_NAMES[n] || ('Tab ' + n), value: n, tab_index: n });
}
_gaTabHook._prismId = 'ga4-tab-open';

(function _registerGA() {
    var hooks = G.PRiSM_tabHooks = (G.PRiSM_tabHooks && typeof G.PRiSM_tabHooks === 'object') ? G.PRiSM_tabHooks : {};
    var any = hooks.any = Array.isArray(hooks.any) ? hooks.any : [];
    for (var i = 0; i < any.length; i++) if (any[i] && any[i]._prismId === _gaTabHook._prismId) return;
    any.push(_gaTabHook);
})();

_on(G, 'prism:model-changed', function (ev) {
    var d = (ev && ev.detail) || {};
    var key = d.modelKey || d.model || (G.PRiSM_state && G.PRiSM_state.model) || 'unknown';
    _ga4('prism_model_select', { event_category: 'PRiSM', event_label: String(key), model_key: String(key) });
});
_on(G, 'prism:fit-updated', function (ev) {
    var d = (ev && ev.detail) || {};
    var src = d.source || (d.fit && d.fit.source) || '';
    var key = d.modelKey || (d.fit && (d.fit.modelKey || d.fit.model)) || (G.PRiSM_state && G.PRiSM_state.model) || 'unknown';
    var name = src === 'regression' ? 'prism_regress_run' : src === 'automatch' ? 'prism_automatch_apply' :
               src === 'match' ? 'prism_typecurve_apply' : src === 'semilog' ? 'prism_semilog_run' : 'prism_fit_update';
    _ga4(name, { event_category: 'PRiSM', event_label: String(key), model_key: String(key), source: String(src) });
});
_on(G, 'prism:analysis-key', function (ev) {
    var d = (ev && ev.detail) || {};
    _ga4('prism_line_tool', { event_category: 'PRiSM', event_label: String(d.key || ''), tool: String(d.key || '') });
});

// Fallback model setter — only when the dispatcher (04) has not provided one.
if (typeof G.PRiSM_setModel !== 'function') {
    G.PRiSM_setModel = function (key) {
        var st = G.PRiSM_state || (G.PRiSM_state = { params: {} });
        st.model = key;
        var entry = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        if (entry) {
            var defs = entry.defaults || {};
            st.params = {};
            for (var k in defs) if (Object.prototype.hasOwnProperty.call(defs, k)) st.params[k] = defs[k];
            st.modelCurve = null;
        }
        _emit('prism:model-changed', { modelKey: key });
    };
}


// =========================================================================
// SELF-TEST
// =========================================================================
(function _selfTest() {
    var checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }
    var savedWell = G.PRiSM_getWell, savedAD = G.PRiSM_getAnalysisData, savedState = G.PRiSM_state;
    try {
        var svg = G.PRiSM_getModelSchematic('homogeneous');
        check('schematic SVG for homogeneous', typeof svg === 'string' && svg.indexOf('<svg') === 0 && svg.length > 200);

        var names = Object.keys(G.PRiSM_analysisKeys);
        check('≥ 20 line tools with plain labels', names.length >= 20 && names.every(function (n) {
            var k = G.PRiSM_analysisKeys[n];
            return k.label && k.label.length > 6 && typeof k.action === 'function' && k.clicks >= 1;
        }), names.length + ' tools');

        // Sample well (C1 contract) — k 45 md, kh 1575 md·ft.
        G.PRiSM_getWell = function () {
            return { fluid: 'oil', q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354,
                     pi: 4200, testType: 'drawdown', complete: true, missing: [], defaulted: [] };
        };
        G.PRiSM_getAnalysisData = function () { return { ok: false }; };
        G.PRiSM_state = { params: { k: 1 }, activePlot: 'bourdet' };

        var r1 = G.PRiSM_runAnalysisKey('radialPlateau', [{ x: 50, y: 52.39 }]);
        check('radial plateau 52.39 psi → kh 1575, k 45', r1.ok &&
              Math.abs(r1.result.values.kh - 1575) < 15 && Math.abs(r1.result.values.k - 45) < 0.5 &&
              G.PRiSM_state.params.k === 1, r1.ok ? _fmt(r1.result.values.kh) : r1.error);

        var mlf = 4.064 * 850 * 1.25 / (35 * 1000) * Math.sqrt(1.1 / (0.18 * 1.2e-5));
        var r2 = G.PRiSM_runAnalysisKey('halfSlope', [{ x: 10, y: 0.5 * mlf * Math.sqrt(10) }]);
        check('½-slope xf·√k = 1000', r2.ok && Math.abs(r2.result.values.xfSqrtK / 1000 - 1) < 0.02,
              r2.ok ? _fmt(r2.result.values.xfSqrtK) : r2.error);

        var tR = 300 * 300 * 0.18 * 1.1 * 1.2e-5 / (0.0002637 * 45 * Math.log(2));
        var r3 = G.PRiSM_runAnalysisKey('boundaryDoubling', [{ x: 1, y: 52.39 }, { x: tR, y: 1.5 * 52.39 }]);
        check('boundary doubling R = 1.5 → L = 300 ft', r3.ok && Math.abs(r3.result.values.L - 300) < 10,
              r3.ok ? _fmt(r3.result.values.L) : r3.error);

        check('ω from dip ratio 0.0549', Math.abs(_omegaFromDipRatio(_dipRatio(0.01)) - 0.01) < 1e-6 &&
              Math.abs(_omegaFromDipRatio(0.0549) - 0.01) < 5e-4);

        var noWell = G.PRiSM_getWell;
        G.PRiSM_getWell = undefined;
        var r4 = G.PRiSM_runAnalysisKey('radialPlateau', [{ x: 50, y: 52.39 }]);
        G.PRiSM_getWell = noWell;
        check('missing Well & Test store → default-inputs warning', r4.ok && r4.result.defaultInputs.length > 0 &&
              /Default inputs/.test(r4.result.warnings[0] || ''));

        check('export functions exposed', typeof G.PRiSM_exportPlotPNG === 'function' &&
              typeof G.PRiSM_exportReportPDF === 'function' && typeof G.PRiSM_listPlots === 'function' &&
              G.PRiSM_listPlots().length >= 14);

        var hooked = G.PRiSM_tabHooks && Array.isArray(G.PRiSM_tabHooks.any) &&
                     G.PRiSM_tabHooks.any.some(function (f) { return f && f._prismId === 'ga4-tab-open'; });
        check('GA4 registered through PRiSM_tabHooks.any (no wrappers)', hooked);

        var panels = (G.PRiSM_tabPanels && G.PRiSM_tabPanels[2]) || [];
        var panelOk = panels.some(function (p) { return p && p.id === 'linetools'; });
        check('line tools registered as a Tab 2 panel', panelOk || typeof G.PRiSM_registerTabPanel === 'function');
    } catch (e) {
        check('self-test ran without throwing', false, e && e.message);
    } finally {
        G.PRiSM_getWell = savedWell;
        G.PRiSM_getAnalysisData = savedAD;
        G.PRiSM_state = savedState;
    }
    var fails = checks.filter(function (c) { return !c.ok; });
    try {
        checks.forEach(function (c) { console.log('PRiSM-polish self-test ' + (c.ok ? '[PASS] ' : '[FAIL] ') + c.name + (c.detail ? '  (' + c.detail + ')' : '')); });
        console.log('PRiSM-polish self-test summary: ' + (checks.length - fails.length) + '/' + checks.length + ' checks passed');
    } catch (e) { /* silent */ }
})();

})();
