// =============================================================================
// PRiSM ─ Layer 11 — Cross-cutting polish
//   1. SVG schematics                 — PRiSM_getModelSchematic(modelKey)
//   2. Specialised analysis keys      — PRiSM_analysisKeys / PRiSM_armAnalysisKey /
//                                       PRiSM_renderAnalysisKeyToolbar
//   3. PNG export pipeline            — PRiSM_exportReportPDF / PRiSM_exportPlotPNG
//   4. Per-tab GA4 events             — wraps window.PRiSM.setTab,
//                                       window.PRiSM_runRegression and
//                                       state.model setter
// -----------------------------------------------------------------------------
// This layer adds NO new physics. It improves the existing 20+ models with
// proper diagrams, click-on-plot specialised-analysis helpers (ported from
// the legacy reservoir-engineering toolset), a robust PDF export that bakes
// canvas-rendered plots in as PNG data URLs, and per-tab GA4 instrumentation.
//
// Public API (all on window.*):
//   PRiSM_getModelSchematic(modelKey)             -> SVG string
//   PRiSM_analysisKeys                            -> { KEY: { label, plot, clicks, action } }
//   PRiSM_armAnalysisKey(key)                     -> arm canvas to capture clicks
//   PRiSM_renderAnalysisKeyToolbar(host, plotKey) -> render toolbar of buttons
//   PRiSM_exportReportPDF()                       -> open print window with PNG-baked report
//   PRiSM_exportPlotPNG(plotKey)                  -> trigger PNG download
//   PRiSM_listPlots()                             -> array of {key, fn, label, mode}
//   PRiSM_setModel(key)                           -> setter that fires GA4 prism_model_select
//
// Conventions:
//   - Single outer IIFE (this whole file).
//   - All public symbols start with PRiSM_ and live on window.*.
//   - No external dependencies — pure vanilla JS, SVG strings only.
//   - Defensive against missing host integrations: if gtag is absent it
//     no-ops silently; if window.exportReport is absent the PDF export
//     falls back to a print-window approach.
// =============================================================================

(function () {
'use strict';

// -------------------------------------------------------------------------
// Toast helper — re-uses the host app's toast() if present, otherwise
// falls back to a console.log + one-shot floating div in the bottom-right.
// -------------------------------------------------------------------------
function _polishToast(msg, kind) {
    kind = kind || 'info';
    if (typeof window.toast === 'function') {
        try { window.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    try {
        var prefix = (kind === 'error') ? '[PRiSM]' :
                     (kind === 'success') ? '[PRiSM]' : '[PRiSM]';
        console.log(prefix + ' ' + msg);
    } catch (e) { /* silent */ }
    // Floating toast (one at a time — replaces previous)
    try {
        var existing = document.getElementById('prism_polish_toast');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var div = document.createElement('div');
        div.id = 'prism_polish_toast';
        div.style.cssText =
            'position:fixed; bottom:20px; right:20px; z-index:99999;' +
            'background:' + (kind === 'error' ? '#5b1f1f' :
                             kind === 'success' ? '#1f5b2a' : '#1f2a5b') + ';' +
            'color:#f0f6fc; padding:10px 14px; border-radius:6px;' +
            'font:13px sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.4);' +
            'max-width:340px; line-height:1.4;';
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(function () {
            if (div.parentNode) div.parentNode.removeChild(div);
        }, 4500);
    } catch (e) { /* silent */ }
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

// Public dispatch.
window.PRiSM_getModelSchematic = function (modelKey) {
    if (!modelKey) return '';
    switch (modelKey) {
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
        default:                 return _schematic_placeholder(modelKey);
    }
};


// =========================================================================
// SECTION 2 — SPECIALISED ANALYSIS KEYS
// =========================================================================
// Each entry is { label, plot, clicks, action(clicks, state) -> {note, ...} }
// `clicks` is the number of canvas clicks needed; the action gets an array
// of {x, y, dataX, dataY} objects + the live PRiSM_state and should return
// an object whose keys (other than `note`) are written into state.params.
//
// All slope-based helpers operate in log10-log10 space when the plot is
// 'bourdet' or another log-log derivative plot. Sqrt-time / spherical-flow
// helpers operate in their respective natural axes (handled by the action).
// =========================================================================

// Helpers — slope between two points in log10 / linear axes.
function _slopeLog(p1, p2) {
    var dx = Math.log10(Math.max(1e-30, p2.dataX)) - Math.log10(Math.max(1e-30, p1.dataX));
    var dy = Math.log10(Math.max(1e-30, p2.dataY)) - Math.log10(Math.max(1e-30, p1.dataY));
    if (dx === 0) return NaN;
    return dy / dx;
}
function _slopeLin(p1, p2) {
    var dx = p2.dataX - p1.dataX;
    if (dx === 0) return NaN;
    return (p2.dataY - p1.dataY) / dx;
}

// Default rate / Bo / mu pulled from state.params or sane fallbacks.
function _stableInputs(state) {
    var p = state.params || {};
    return {
        q:   (p.q  != null) ? p.q  : 100,    // STB/D (or m³/d)
        Bo:  (p.Bo != null) ? p.Bo : 1.2,
        mu:  (p.mu != null) ? p.mu : 1.0,    // cp
        h:   (p.h  != null) ? p.h  : 30,     // ft
        phi: (p.phi != null) ? p.phi : 0.20,
        ct:  (p.ct  != null) ? p.ct  : 1e-5, // 1/psi
        rw:  (p.rw  != null) ? p.rw  : 0.354 // ft (8.5" hole)
    };
}

window.PRiSM_analysisKeys = {
    // ── Radial-flow ────────────────────────────────────────────────────
    STABIL: {
        label: 'Stabilisation → kh',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dpStab = clicks[0].dataY;            // ψ = dp' on the IARF plateau
            // Bourdet IARF: dp' = 70.6·q·μ·B / (k·h)  →  k·h = 70.6·q·μ·B / dp'
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dpStab);
            var k  = kh / Math.max(1e-9, inp.h);
            return { kh: kh, k: k,
                     note: 'IARF plateau dp\'=' + dpStab.toPrecision(4) +
                           ' → kh=' + kh.toPrecision(4) +
                           ' md·ft (k=' + k.toPrecision(4) + ' md)' };
        }
    },
    HALFSL: {
        label: '½-slope → x_f',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var sl = _slopeLog(clicks[0], clicks[1]);
            // Linear flow: dp = 4.064·(qB/h)·sqrt(t/(φ·μ·ct·k))/x_f
            //   → x_f·sqrt(k) is back-calculable from a chord & the slope check.
            var dpRef = clicks[1].dataY, tRef = clicks[1].dataX;
            // Solve: dp = m_lin · sqrt(t)  with  m_lin = dpRef/sqrt(tRef)
            var mLin = dpRef / Math.max(1e-9, Math.sqrt(tRef));
            var xf_sqrtk = (4.064 * inp.q * inp.Bo / inp.h) /
                           Math.max(1e-9, mLin * Math.sqrt(inp.phi * inp.mu * inp.ct));
            return { xf_sqrtk: xf_sqrtk,
                     note: '½-slope (' + sl.toFixed(2) + ') → x_f·√k=' +
                           xf_sqrtk.toPrecision(4) + ' ft·√md' };
        }
    },
    OMEGA: {
        label: 'Valley depth → ω',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            // Click two points: (1) IARF plateau before valley, (2) bottom of valley.
            var dpPlateau = clicks[0].dataY;
            var dpValley  = clicks[1].dataY;
            // ω ≈ 10^(−2·log10(dpPlateau/dpValley)) approximated by depth ratio.
            var ratio = dpPlateau / Math.max(1e-9, dpValley);
            var omega = 1 / Math.pow(ratio, 2);   // engineering proxy
            if (omega < 0.001) omega = 0.001;
            if (omega > 1)     omega = 1;
            return { omega: omega,
                     note: 'Valley depth ratio=' + ratio.toFixed(2) +
                           ' → ω≈' + omega.toPrecision(3) };
        }
    },
    LAMBDA: {
        label: 'Valley time → λ',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // tD at valley minimum ↔ λ via λ = (Cd·e^(2S)) / (tD·something).
            // Engineering proxy: λ ≈ 1 / tValley (in dimensionless units).
            var tValley = clicks[0].dataX;
            var lambda = 1 / Math.max(1e-9, tValley);
            return { lambda: lambda,
                     note: 'Valley at t=' + tValley.toPrecision(3) +
                           ' → λ≈' + lambda.toPrecision(3) };
        }
    },

    // ── Boundaries ────────────────────────────────────────────────────
    FAULT: {
        label: 'Slope-doubling → L',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Click on the time of slope doubling on the derivative curve.
            // For a sealing fault: t_2m ≈ 948 · φ·μ·ct·L² / k
            //   → L = sqrt(k · t_2m / (948 · φ·μ·ct))
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var L = Math.sqrt(k * t / (948 * inp.phi * inp.mu * inp.ct));
            return { L: L,
                     note: 'Slope doubles at t=' + t.toPrecision(3) +
                           ' h → L≈' + L.toFixed(0) + ' ft' };
        }
    },
    'BND-ON': {
        label: 'Boundary onset → distance',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Onset of any boundary: t_b ≈ 380 · φ·μ·ct·L² / k.
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var L = Math.sqrt(k * t / (380 * inp.phi * inp.mu * inp.ct));
            return { Lb: L,
                     note: 'Boundary onset at t=' + t.toPrecision(3) +
                           ' h → L≈' + L.toFixed(0) + ' ft' };
        }
    },
    'BND-DV': {
        label: 'Derivative deviation → boundary type',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Click pre-deviation point and post-deviation point on derivative.
            var slope = _slopeLog(clicks[0], clicks[1]);
            var typ;
            if      (slope >  0.7) typ = 'sealing fault (dp\' ↑)';
            else if (slope < -0.7) typ = 'constant-pressure boundary (dp\' ↓)';
            else                   typ = 'channel / partial-seal (intermediate)';
            return { boundaryType: typ,
                     note: 'Derivative slope after deviation ≈ ' +
                           slope.toFixed(2) + ' → ' + typ };
        }
    },
    CHANEL: {
        label: '½-slope onset → channel width',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            // Channel ½-slope onset: t_lin ≈ 152 · φ·μ·ct·W² / k.
            var inp = _stableInputs(state);
            var t = clicks[0].dataX;
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var W = Math.sqrt(k * t / (152 * inp.phi * inp.mu * inp.ct));
            return { W: W,
                     note: '½-slope onset at t=' + t.toPrecision(3) +
                           ' h → channel W≈' + W.toFixed(0) + ' ft' };
        }
    },
    ANGLE: {
        label: 'Plateau after 2 faults → θ',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Late-time plateau ratio to IARF plateau ↔ 2π/θ.
            var dpIARF  = clicks[0].dataY;
            var dpLate  = clicks[1].dataY;
            var ratio   = dpLate / Math.max(1e-9, dpIARF);
            var theta_rad = 2 * Math.PI / Math.max(1, ratio);
            var theta_deg = theta_rad * 180 / Math.PI;
            return { theta_deg: theta_deg,
                     note: 'Late/IARF ratio=' + ratio.toFixed(2) +
                           ' → intersecting-fault angle ≈ ' +
                           theta_deg.toFixed(1) + '°' };
        }
    },

    // ── Injectivity ────────────────────────────────────────────────────
    INJSTB: {
        label: 'sqrt(t) stabilisation → conformance',
        plot:  'sqrt',
        clicks: 1,
        action: function (clicks) {
            // Stabilisation level on sqrt(t) plot indicates injection-zone
            // conformance vs. multi-zone behaviour.
            var dpStab = clicks[0].dataY;
            var conf   = (dpStab > 0) ? 1 - Math.exp(-dpStab / 100) : 0;
            return { injConformance: conf,
                     note: 'sqrt(t) stabilisation Δp=' + dpStab.toPrecision(3) +
                           ' → conformance ≈ ' + (conf * 100).toFixed(1) + '%' };
        }
    },
    INJSLP: {
        label: 'sqrt(t) slope → injectivity II',
        plot:  'sqrt',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var slope = _slopeLin(clicks[0], clicks[1]);    // psi/√h
            // II = q / (slope·…) — engineering proxy.
            var II = inp.q / Math.max(1e-9, Math.abs(slope) * Math.sqrt(1));
            return { II: II,
                     note: 'sqrt(t) slope=' + slope.toPrecision(3) +
                           ' psi/√h → II≈' + II.toPrecision(3) + ' bbl/d/psi' };
        }
    },

    // ── Partial penetration ───────────────────────────────────────────
    PPNSTB: {
        label: 'Spherical-flow stabil → kh',
        plot:  'spherical',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[0].dataY;
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dp);
            return { kh: kh,
                     note: 'Spherical-flow late-time plateau Δp=' +
                           dp.toPrecision(3) + ' → kh=' + kh.toPrecision(4) + ' md·ft' };
        }
    },
    PPNSLP: {
        label: 'Spherical slope → k·√k',
        plot:  'spherical',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var slope = _slopeLin(clicks[0], clicks[1]);
            // m_sph = 2452.9 · qBμ / (k_sph^1.5)  →  k_sph^1.5 = 2452.9·qBμ/m_sph
            var k_sph_15 = (2452.9 * inp.q * inp.Bo * inp.mu) / Math.max(1e-9, Math.abs(slope));
            var k_sph    = Math.pow(k_sph_15, 2 / 3);
            return { k_sph: k_sph,
                     note: 'Spherical slope=' + slope.toPrecision(3) +
                           ' → k_sph≈' + k_sph.toPrecision(4) + ' md' };
        }
    },
    PPNSKN: {
        label: 'Stabil offset → partial-pen pseudo-skin',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            // Compare actual plateau (clicks[1]) vs. ideal full-penetration
            // plateau (clicks[0]). S_pp = 0.5 · ln(actual/ideal).
            var actual = clicks[1].dataY;
            var ideal  = clicks[0].dataY;
            var ratio  = actual / Math.max(1e-9, ideal);
            var Spp    = 0.5 * Math.log(ratio);
            return { Spp: Spp,
                     note: 'Δp(act)/Δp(ideal)=' + ratio.toFixed(2) +
                           ' → S_pp≈' + Spp.toFixed(2) };
        }
    },

    // ── Horizontal well ──────────────────────────────────────────────
    HORSLP: {
        label: 'Early ½-slope → L·√(kh·kv)',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[1].dataY, t = clicks[1].dataX;
            var mLin = dp / Math.max(1e-9, Math.sqrt(t));
            // dp_lin = 8.128·qB/(L·h) · sqrt(t/(φμct)) / sqrt(kv·kh) — proxy.
            var L_sqrt = (8.128 * inp.q * inp.Bo / inp.h) /
                         Math.max(1e-9, mLin * Math.sqrt(inp.phi * inp.mu * inp.ct));
            return { L_sqrt_khkv: L_sqrt,
                     note: 'Early ½-slope → L·√(kh·kv)≈' +
                           L_sqrt.toPrecision(4) + ' ft·md' };
        }
    },
    HORSTB: {
        label: 'Late stabilisation → kh (horiz)',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            var dp = clicks[0].dataY;
            var kh = (70.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, dp);
            return { kh: kh,
                     note: 'Horizontal late-pseudo-radial plateau dp\'=' +
                           dp.toPrecision(3) + ' → kh=' + kh.toPrecision(4) + ' md·ft' };
        }
    },

    // ── 3-sided / Horner ─────────────────────────────────────────────
    '3-SIDE': {
        label: '3-sided closed → Horner late linear',
        plot:  'horner',
        clicks: 2,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            // Horner Δp vs. Horner-time slope on late linear regime.
            var slope = _slopeLin(clicks[0], clicks[1]);
            var kh = (162.6 * inp.q * inp.mu * inp.Bo) / Math.max(1e-9, Math.abs(slope));
            return { kh_3side: kh,
                     note: 'Horner late-linear slope=' + slope.toPrecision(3) +
                           ' → kh (3-sided)≈' + kh.toPrecision(4) + ' md·ft' };
        }
    },

    // ── General-purpose utilities ────────────────────────────────────
    AUTOSL: {
        label: 'Auto-fit slope (general)',
        plot:  'bourdet',
        clicks: 2,
        action: function (clicks) {
            var sl = _slopeLog(clicks[0], clicks[1]);
            var regime = '';
            if      (Math.abs(sl) < 0.1)       regime = 'IARF (radial-flow plateau)';
            else if (Math.abs(sl - 0.5) < 0.1) regime = 'linear flow (½-slope)';
            else if (Math.abs(sl - 0.25) < 0.1)regime = 'bilinear flow (¼-slope)';
            else if (Math.abs(sl + 0.5) < 0.1) regime = 'spherical flow (-½ slope)';
            else if (Math.abs(sl - 1.0) < 0.15)regime = 'pseudo-steady / closed (unit slope)';
            else                                regime = 'transitional';
            return { lastSlope: sl,
                     note: 'Slope=' + sl.toFixed(3) + ' → ' + regime };
        }
    },
    '1/4SLP': {
        label: '¼-slope → bilinear / finite-cond',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks, state) {
            var inp = _stableInputs(state);
            // Bilinear flow: dp = 44.13·qBμ / (h · (kf·wf)^0.5 · (kφμct)^0.25) · t^0.25
            var dp = clicks[0].dataY, t = clicks[0].dataX;
            var mBi = dp / Math.max(1e-9, Math.pow(t, 0.25));
            var k = (state.params && state.params.k) ? state.params.k : 50;
            var kfwf = Math.pow((44.13 * inp.q * inp.Bo * inp.mu) /
                                (inp.h * mBi * Math.pow(k * inp.phi * inp.mu * inp.ct, 0.25)), 2);
            return { kfwf: kfwf,
                     note: '¼-slope onset → k_f·w_f ≈ ' + kfwf.toPrecision(4) + ' md·ft' };
        }
    },
    SPHERE: {
        label: '-½ slope → spherical-flow entry',
        plot:  'bourdet',
        clicks: 1,
        action: function (clicks) {
            var t = clicks[0].dataX;
            return { tSphericalEntry: t,
                     note: 'Spherical-flow regime entry detected at t=' +
                           t.toPrecision(3) + ' h (-½ slope)' };
        }
    }
};

// ---- Click-capture state machine ----------------------------------------

var _activeKey      = null;            // name of armed key
var _activeCanvas   = null;            // canvas element listening
var _activeListener = null;            // bound mousedown handler
var _clickBuf       = [];              // accumulated {x,y,dataX,dataY}

// Read the data-axis transform that the plot library stashed on the canvas.
// 02-plots.js stores this as canvas._prismAxes = {x0, y0, x1, y1, dx0, dx1,
// dy0, dy1, xLog, yLog} after each draw. If absent we fall back to a linear
// 0..1 mapping that still gives a relative slope.
function _toDataCoords(canvas, ev) {
    var rect = canvas.getBoundingClientRect();
    var dpr  = window.devicePixelRatio || 1;
    var px   = (ev.clientX - rect.left);
    var py   = (ev.clientY - rect.top);
    var ax   = canvas._prismAxes;
    var dataX, dataY;
    if (ax) {
        var fx = (px - ax.x0) / Math.max(1, (ax.x1 - ax.x0));
        var fy = (py - ax.y0) / Math.max(1, (ax.y1 - ax.y0));
        // Y axis is inverted (top y < bottom y in pixel space).
        var fyDom = 1 - fy;
        dataX = ax.xLog
            ? Math.pow(10, Math.log10(ax.dx0) + fx * (Math.log10(ax.dx1) - Math.log10(ax.dx0)))
            : ax.dx0 + fx * (ax.dx1 - ax.dx0);
        dataY = ax.yLog
            ? Math.pow(10, Math.log10(ax.dy0) + fyDom * (Math.log10(ax.dy1) - Math.log10(ax.dy0)))
            : ax.dy0 + fyDom * (ax.dy1 - ax.dy0);
    } else {
        // Best-effort fallback. Just return relative pixel coordinates.
        dataX = px / Math.max(1, rect.width);
        dataY = 1 - py / Math.max(1, rect.height);
    }
    return { x: px, y: py, dataX: dataX, dataY: dataY };
}

function _disarm() {
    if (_activeCanvas && _activeListener) {
        _activeCanvas.removeEventListener('mousedown', _activeListener);
        _activeCanvas.style.cursor = '';
    }
    _activeKey = null;
    _activeCanvas = null;
    _activeListener = null;
    _clickBuf = [];
    var hint = document.getElementById('prism_polish_armhint');
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
}

function _showArmHint(label, needed) {
    var hint = document.getElementById('prism_polish_armhint');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'prism_polish_armhint';
        hint.style.cssText =
            'position:fixed; top:12px; left:50%; transform:translateX(-50%);' +
            'background:#21262d; border:1px solid #f0883e; color:#f0f6fc;' +
            'padding:8px 14px; border-radius:5px; z-index:99999;' +
            'font:12px sans-serif; box-shadow:0 4px 10px rgba(0,0,0,.4);';
        document.body.appendChild(hint);
    }
    hint.textContent = '[' + label + '] click ' + needed + ' point(s) on the plot — Esc to cancel';
}

window.PRiSM_armAnalysisKey = function (keyName) {
    var key = window.PRiSM_analysisKeys[keyName];
    if (!key) {
        _polishToast('Unknown analysis key: ' + keyName, 'error');
        return;
    }
    var canvas = document.getElementById('prism_plot_canvas');
    if (!canvas) {
        _polishToast('No plot canvas active. Open Tab 2 first.', 'error');
        return;
    }
    if (_activeKey) _disarm();
    _activeKey = keyName;
    _activeCanvas = canvas;
    _clickBuf = [];
    canvas.style.cursor = 'crosshair';
    _showArmHint(key.label, key.clicks);

    _activeListener = function (ev) {
        var pt = _toDataCoords(canvas, ev);
        _clickBuf.push(pt);
        if (_clickBuf.length >= key.clicks) {
            // Snapshot to avoid race with disarm()
            var clicks = _clickBuf.slice();
            var keyEntry = key;
            _disarm();
            try {
                var result = keyEntry.action(clicks, window.PRiSM_state || {});
                if (result && typeof result === 'object') {
                    if (!window.PRiSM_state) window.PRiSM_state = { params: {} };
                    if (!window.PRiSM_state.params) window.PRiSM_state.params = {};
                    for (var rk in result) {
                        if (rk === 'note') continue;
                        if (Object.prototype.hasOwnProperty.call(result, rk)) {
                            window.PRiSM_state.params[rk] = result[rk];
                        }
                    }
                    var msg = '[' + keyName + '] ' + (result.note || 'result computed');
                    console.log('PRiSM analysis-key ' + keyName + ':', result);
                    _polishToast(msg, 'success');
                }
            } catch (e) {
                console.error('PRiSM analysis-key ' + keyName + ' failed:', e);
                _polishToast('Analysis-key error: ' + e.message, 'error');
            }
        } else {
            _polishToast('[' + keyName + '] need ' +
                         (key.clicks - _clickBuf.length) + ' more click(s)', 'info');
        }
    };
    canvas.addEventListener('mousedown', _activeListener);
};

// Esc cancels any pending arm.
document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _activeKey) {
        _polishToast('Analysis-key cancelled.', 'info');
        _disarm();
    }
});

// Render a grid of analysis-key buttons filtered by plotKey (e.g. 'bourdet',
// 'sqrt', 'spherical', 'horner'). Container can be a DOM element or an id.
window.PRiSM_renderAnalysisKeyToolbar = function (container, plotKey) {
    var host = (typeof container === 'string')
        ? document.getElementById(container) : container;
    if (!host) return;
    plotKey = plotKey || 'bourdet';
    var keys = window.PRiSM_analysisKeys;
    var btns = '';
    for (var k in keys) {
        if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
        if (keys[k].plot !== plotKey) continue;
        btns += '<button class="btn btn-secondary" data-prism-akey="' + k + '" ' +
                'style="font-size:11px; padding:4px 8px; margin:2px;" ' +
                'title="' + keys[k].label + '">' +
                k + '</button>';
    }
    if (!btns) {
        btns = '<span style="font-size:11px; color:#8b949e; font-style:italic;">' +
               'No analysis keys for plot type \'' + plotKey + '\'.</span>';
    }
    host.innerHTML =
        '<div style="border:1px solid #30363d; border-radius:6px; padding:8px; ' +
                    'background:#161b22; margin-top:8px;">' +
            '<div style="font-size:11px; font-weight:700; color:#c9d1d9; ' +
                        'text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">' +
                'Analysis keys (' + plotKey + ')</div>' +
            '<div style="display:flex; flex-wrap:wrap; gap:2px;">' + btns + '</div>' +
        '</div>';
    // Wire each button to arm its key.
    var nodes = host.querySelectorAll('[data-prism-akey]');
    for (var i = 0; i < nodes.length; i++) {
        (function (node) {
            node.onclick = function () { window.PRiSM_armAnalysisKey(node.dataset.prismAkey); };
        })(nodes[i]);
    }
};


// =========================================================================
// SECTION 3 — PNG EXPORT (REPORT PDF + STANDALONE PLOT PNG)
// =========================================================================
// We can't reach the locally-scoped PRISM_PLOT_REGISTRY in 04-ui-wiring.js,
// so we maintain a parallel snapshot. Update _PLOTS_SNAPSHOT here if a new
// plot is added to that registry.

var _PLOTS_SNAPSHOT = [
    { key: 'cartesian',     fn: 'PRiSM_plot_cartesian',             label: 'Cartesian P vs t',     mode: 'transient' },
    { key: 'horner',        fn: 'PRiSM_plot_horner',                label: 'Horner',               mode: 'transient' },
    { key: 'bourdet',       fn: 'PRiSM_plot_bourdet',               label: 'Log-Log Bourdet',      mode: 'transient' },
    { key: 'sqrt',          fn: 'PRiSM_plot_sqrt_time',             label: 'Square-root time',     mode: 'transient' },
    { key: 'quarter',       fn: 'PRiSM_plot_quarter_root_time',     label: 'Quarter-root time',    mode: 'transient' },
    { key: 'spherical',     fn: 'PRiSM_plot_spherical',             label: 'Spherical',            mode: 'transient' },
    { key: 'sandface',      fn: 'PRiSM_plot_sandface_convolution',  label: 'Sandface convolution', mode: 'transient' },
    { key: 'superposition', fn: 'PRiSM_plot_buildup_superposition', label: 'Buildup superposition',mode: 'transient' },
    { key: 'rateCart',      fn: 'PRiSM_plot_rate_time_cartesian',   label: 'Rate vs time (cart)',  mode: 'decline' },
    { key: 'rateSemi',      fn: 'PRiSM_plot_rate_time_semilog',     label: 'Rate vs time (semi)',  mode: 'decline' },
    { key: 'rateLog',       fn: 'PRiSM_plot_rate_time_loglog',      label: 'Rate vs time (log)',   mode: 'decline' },
    { key: 'rateCum',       fn: 'PRiSM_plot_rate_cumulative',       label: 'Rate vs cumulative',   mode: 'decline' },
    { key: 'lossRatio',     fn: 'PRiSM_plot_loss_ratio',            label: 'Loss-ratio',           mode: 'decline' },
    { key: 'typeCurve',     fn: 'PRiSM_plot_typecurve_overlay',     label: 'Type-curve overlay',   mode: 'decline' }
];

window.PRiSM_listPlots = function () {
    return _PLOTS_SNAPSHOT.slice();
};

// Render a plot to an offscreen canvas at the given resolution, return data URL.
function _renderPlotToDataURL(plotKey, w, h) {
    var entry = null;
    for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) {
        if (_PLOTS_SNAPSHOT[i].key === plotKey) { entry = _PLOTS_SNAPSHOT[i]; break; }
    }
    if (!entry) return null;
    var fn = window[entry.fn];
    if (typeof fn !== 'function') return null;
    var ds = window.PRiSM_dataset || {};
    var st = window.PRiSM_state   || {};
    var c = document.createElement('canvas');
    c.width  = w || 1200;
    c.height = h || 800;
    var data = {
        t: ds.t || [], p: ds.p || [], q: ds.q || null
    };
    if (ds.dp) data.dp = ds.dp;
    if (ds.periods) data.periods = ds.periods;
    if (st.modelCurve && typeof window.PRiSM_applyMatch === 'function') {
        try {
            var m = st.match || { timeShift: 0, pressShift: 0 };
            var sh = window.PRiSM_applyMatch(st.modelCurve.td, st.modelCurve.pd,
                                             m.timeShift, m.pressShift);
            data.overlay = { t: sh.t, p: sh.p };
        } catch (e) { /* ignore — overlay just won't appear */ }
    }
    try {
        fn(c, data, { hover: false, dragZoom: false, showLegend: true });
    } catch (e) {
        console.warn('PRiSM PNG render of', plotKey, 'failed:', e.message);
        // Still return whatever was drawn so the user gets *something*.
    }
    try { return c.toDataURL('image/png'); }
    catch (e) { console.warn('toDataURL failed:', e.message); return null; }
}

// Standalone PNG download for a single plot.
window.PRiSM_exportPlotPNG = function (plotKey) {
    if (!plotKey) {
        _polishToast('PRiSM_exportPlotPNG: plotKey required', 'error');
        return;
    }
    var dataUrl = _renderPlotToDataURL(plotKey, 1200, 800);
    if (!dataUrl) {
        _polishToast('PNG export failed — plot ' + plotKey + ' not available', 'error');
        return;
    }
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'prism_' + plotKey + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    _polishToast('PNG saved: prism_' + plotKey + '.png', 'success');
};

// PDF export with embedded PNGs.
window.PRiSM_exportReportPDF = function () {
    var html;
    try {
        if (typeof window.PRiSM_buildReportHTML === 'function') {
            html = window.PRiSM_buildReportHTML();
        } else {
            html = '<h2>PRiSM Report</h2><p>(Report builder not available.)</p>';
        }
    } catch (e) {
        _polishToast('Report build failed: ' + e.message, 'error');
        return;
    }

    // Bake every available plot as a high-res PNG and append to the report.
    var ds = window.PRiSM_dataset;
    var hasData = !!(ds && Array.isArray(ds.t) && ds.t.length > 0);
    var st = window.PRiSM_state || {};
    var mode = (window.PRiSM && window.PRiSM.mode) || 'transient';

    var augHTML = '';
    if (hasData) {
        augHTML += '<h2 style="page-break-before:always;">High-Resolution Plot Gallery</h2>';
        var cnt = 0;
        for (var i = 0; i < _PLOTS_SNAPSHOT.length; i++) {
            var entry = _PLOTS_SNAPSHOT[i];
            // Only embed plots compatible with the active mode (or both).
            if (mode !== 'combined' && entry.mode !== mode) continue;
            var url = _renderPlotToDataURL(entry.key, 1200, 800);
            if (!url) continue;
            cnt++;
            augHTML +=
                '<div style="page-break-inside:avoid; margin-bottom:18px;">' +
                    '<h3 style="margin:6px 0;">' + entry.label + '</h3>' +
                    '<img src="' + url + '" style="width:100%; max-width:1100px; ' +
                        'height:auto; border:1px solid #ccc;"/>' +
                '</div>';
        }
        if (cnt === 0) {
            augHTML += '<p><em>No plots could be rendered.</em></p>';
        }
    } else {
        augHTML += '<p><em>No dataset loaded — gallery skipped.</em></p>';
    }

    // Try the host's exportReport first (gives consistent cover page).
    if (typeof window.exportReport === 'function') {
        try {
            window.exportReport('PRiSM Analysis - ' + (st.model || ''), html + augHTML);
            _polishToast('Report sent to host PDF pipeline.', 'success');
            return;
        } catch (e) {
            console.warn('Host exportReport failed, falling back to print window:', e.message);
        }
    }

    // Fallback: open a new window, dump the augmented report, call print().
    var w;
    try { w = window.open('', 'prism_report', 'width=900,height=1100'); }
    catch (e) { w = null; }
    if (!w) {
        _polishToast('Pop-up blocked — allow pop-ups to export the report.', 'error');
        return;
    }
    var fullHTML =
        '<!DOCTYPE html><html><head><title>PRiSM Report</title>' +
        '<style>' +
            'body { font-family: Arial, sans-serif; margin: 24px; color:#222; }' +
            'h1, h2, h3 { color:#222; }' +
            'table { border-collapse: collapse; margin: 8px 0; }' +
            'th, td { border:1px solid #ddd; padding:4px 8px; font-size:12px; }' +
            'img { max-width:100%; height:auto; }' +
            '@media print { body { margin:12px; } }' +
        '</style></head><body>' +
        '<h1>PRiSM Well-Test Analysis Report</h1>' +
        html + augHTML +
        '<script>window.onload = function(){ setTimeout(function(){' +
        ' try { window.print(); } catch(e){} }, 400); };<\/script>' +
        '</body></html>';
    try {
        w.document.open();
        w.document.write(fullHTML);
        w.document.close();
        _polishToast('Report opened — use browser print to save as PDF.', 'success');
    } catch (e) {
        _polishToast('Print-window write failed: ' + e.message, 'error');
    }
};


// =========================================================================
// SECTION 4 — PER-TAB GA4 EVENTS
// =========================================================================
// Three integration points:
//   - window.PRiSM.setTab          → 'prism_tab_open'
//   - window.PRiSM_state.model     → 'prism_model_select'
//   - window.PRiSM_runRegression   → 'prism_regress_run'
// =========================================================================

function _ga4(eventName, params) {
    if (typeof window.gtag === 'function') {
        try { window.gtag('event', eventName, params); }
        catch (e) { /* swallow — GA failures must not break the app */ }
    }
}

// ---- 4a) Wrap window.PRiSM.setTab ---------------------------------------
(function _wrapSetTabForGA4() {
    if (!window.PRiSM || typeof window.PRiSM.setTab !== 'function') {
        // Try again later — Phase 1+2 setTab is created inside renderPRiSM.
        setTimeout(_wrapSetTabForGA4, 250);
        return;
    }
    if (window.PRiSM.setTab._ga4Wrapped) return;
    var orig = window.PRiSM.setTab;
    window.PRiSM.setTab = function (n) {
        var tabNames = ['', 'Data', 'Plots', 'Model', 'Params', 'Match', 'Regress', 'Report'];
        var name = tabNames[n] || ('Tab ' + n);
        _ga4('prism_tab_open', {
            event_category: 'PRiSM',
            event_label:    name,
            value:          n,
            tab_index:      n
        });
        return orig.apply(this, arguments);
    };
    window.PRiSM.setTab._ga4Wrapped = true;
})();

// ---- 4b) Wrap state.model setter ----------------------------------------
//   Tab 3 currently does `window.PRiSM_state.model = key` directly. We
//   install an Object.defineProperty getter/setter on the model field so
//   any assignment fires GA4. Also expose PRiSM_setModel(key) for callers
//   that prefer an explicit setter.
(function _instrumentModelField() {
    if (!window.PRiSM_state) {
        setTimeout(_instrumentModelField, 250);
        return;
    }
    var st = window.PRiSM_state;
    if (st._modelInstrumented) return;
    var current = st.model;
    try {
        Object.defineProperty(st, 'model', {
            configurable: true,
            enumerable:   true,
            get: function () { return current; },
            set: function (v) {
                if (v !== current) {
                    current = v;
                    _ga4('prism_model_select', {
                        event_category: 'PRiSM',
                        event_label:    String(v),
                        model_key:      String(v)
                    });
                } else {
                    current = v;
                }
            }
        });
        st._modelInstrumented = true;
    } catch (e) {
        console.warn('PRiSM model-setter instrumentation failed:', e.message);
    }
})();

window.PRiSM_setModel = function (key) {
    if (!window.PRiSM_state) window.PRiSM_state = { params: {}, model: key };
    window.PRiSM_state.model = key;        // triggers the GA4 event via the setter
    if (window.PRiSM_MODELS && window.PRiSM_MODELS[key]) {
        var defs = window.PRiSM_MODELS[key].defaults || {};
        window.PRiSM_state.params = {};
        for (var k in defs) {
            if (Object.prototype.hasOwnProperty.call(defs, k)) {
                window.PRiSM_state.params[k] = defs[k];
            }
        }
        window.PRiSM_state.modelCurve = null;
    }
};

// ---- 4c) Wrap window.PRiSM_runRegression --------------------------------
(function _wrapRunRegression() {
    if (typeof window.PRiSM_runRegression !== 'function') {
        setTimeout(_wrapRunRegression, 250);
        return;
    }
    if (window.PRiSM_runRegression._ga4Wrapped) return;
    var orig = window.PRiSM_runRegression;
    window.PRiSM_runRegression = function (opts) {
        var st = window.PRiSM_state || {};
        _ga4('prism_regress_run', {
            event_category: 'PRiSM',
            event_label:    String(st.model || 'unknown'),
            model_key:      String(st.model || 'unknown')
        });
        return orig.apply(this, arguments);
    };
    window.PRiSM_runRegression._ga4Wrapped = true;
})();


// =========================================================================
// SELF-TEST
// =========================================================================
// Verifies the four contract checks and logs a pass/fail line. The setTab
// wrap check uses a stub if window.PRiSM.setTab isn't yet defined (early
// load order); we install a no-op stub in that case so the wrap can run
// against it and the assertion still meaningfully validates the wrap.
// =========================================================================

(function _selfTest() {
    function reportResult(label, ok, detail) {
        var sym = ok ? '[PASS]' : '[FAIL]';
        try {
            console.log('PRiSM-polish self-test ' + sym + ' ' + label +
                        (detail ? '  ' + detail : ''));
        } catch (e) { /* silent */ }
        return ok;
    }
    var passes = 0, total = 0;

    // 1. Schematic returns a non-empty SVG string.
    total++;
    var svg = '';
    try { svg = window.PRiSM_getModelSchematic('homogeneous'); } catch (e) {}
    var ok1 = (typeof svg === 'string') && svg.indexOf('<svg') === 0 && svg.length > 200;
    if (reportResult('SVG schematic for homogeneous',
                     ok1, '(' + (svg ? svg.length : 0) + ' chars)')) passes++;

    // 2. PRiSM_analysisKeys has all 20 entries.
    total++;
    var expected = ['STABIL','HALFSL','OMEGA','LAMBDA','FAULT','CHANEL','ANGLE',
                    'INJSTB','INJSLP','PPNSTB','PPNSLP','PPNSKN','HORSLP','HORSTB',
                    'BND-ON','BND-DV','3-SIDE','AUTOSL','1/4SLP','SPHERE'];
    var missing = [];
    for (var i = 0; i < expected.length; i++) {
        if (!window.PRiSM_analysisKeys || !window.PRiSM_analysisKeys[expected[i]]) {
            missing.push(expected[i]);
        }
    }
    var ok2 = (missing.length === 0) &&
              window.PRiSM_analysisKeys &&
              Object.keys(window.PRiSM_analysisKeys).length >= 20;
    if (reportResult('20 analysis keys registered',
                     ok2, '(' + Object.keys(window.PRiSM_analysisKeys || {}).length +
                          ' present, missing: ' + missing.join(',') + ')')) passes++;

    // 3. PNG export functions exist and are callable.
    total++;
    var ok3 = (typeof window.PRiSM_exportPlotPNG === 'function') &&
              (typeof window.PRiSM_exportReportPDF === 'function') &&
              (typeof window.PRiSM_listPlots === 'function');
    if (reportResult('PNG export functions exposed', ok3)) passes++;

    // 4. After a stub setTab is in place + the wrapper has run, _ga4Wrapped
    //    should be true. If renderPRiSM hasn't created setTab yet, do it now
    //    with a no-op stub and re-trigger the wrapper.
    total++;
    if (!window.PRiSM) window.PRiSM = {};
    if (typeof window.PRiSM.setTab !== 'function') {
        window.PRiSM.setTab = function () {};
        // Re-run the wrap idempotently (the IIFE above retries every 250 ms;
        // we trigger it synchronously here to keep self-test deterministic).
        if (!window.PRiSM.setTab._ga4Wrapped) {
            var orig = window.PRiSM.setTab;
            window.PRiSM.setTab = function (n) {
                var tabNames = ['', 'Data', 'Plots', 'Model', 'Params', 'Match', 'Regress', 'Report'];
                var name = tabNames[n] || ('Tab ' + n);
                _ga4('prism_tab_open', {
                    event_category: 'PRiSM',
                    event_label:    name,
                    value:          n,
                    tab_index:      n
                });
                return orig.apply(this, arguments);
            };
            window.PRiSM.setTab._ga4Wrapped = true;
        }
    }
    var ok4 = !!(window.PRiSM && window.PRiSM.setTab && window.PRiSM.setTab._ga4Wrapped);
    if (reportResult('window.PRiSM.setTab wrapped with GA4', ok4)) passes++;

    // Summary
    try {
        console.log('PRiSM-polish self-test summary: ' + passes + '/' + total +
                    ' checks passed');
    } catch (e) { /* silent */ }
})();

})();
