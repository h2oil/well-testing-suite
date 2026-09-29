#!/usr/bin/env node
// Smoke-test the merged PRiSM API — load the extracted main script in a stub
// browser environment and inspect the resulting window namespace.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Stub a minimal browser environment.
const noop = () => {};
const win = {};
function stubEl(tag) {
  return {
    tag: tag || 'div', style: {}, dataset: {}, children: [],
    innerHTML: '', textContent: '', value: '', checked: false,
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0,
    scrollTop: 0, scrollLeft: 0,
    appendChild: noop, removeChild: noop, replaceChild: noop, insertBefore: noop,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    getContext: () => ({
      fillRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
      arc: noop, ellipse: noop, rect: noop, save: noop, restore: noop,
      translate: noop, scale: noop, rotate: noop,
      fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }),
      setTransform: noop, transform: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      drawImage: noop, getImageData: () => ({ data: [] }), putImageData: noop,
      set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){}, set font(v){}, set textAlign(v){}, set textBaseline(v){}
    }),
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    getBoundingClientRect: () => ({ left:0, top:0, right:0, bottom:0, width:0, height:0, x:0, y:0 }),
    focus: noop, blur: noop, click: noop, select: noop,
  };
}
const doc = {
  getElementById: () => stubEl('div'),
  createElement: stubEl,
  createElementNS: stubEl,
  createTextNode: (text) => ({ text, nodeType: 3 }),
  body: stubEl('body'),
  head: stubEl('head'),
  documentElement: stubEl('html'),
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  querySelector: () => stubEl('div'), querySelectorAll: () => [],
  visibilityState: 'visible',
  hidden: false,
  readyState: 'complete',
};

const ctx = vm.createContext({
  window: win, document: doc, navigator: { userAgent: 'node' },
  location: { hash: '', pathname: '/', search: '' },
  localStorage: {
    _: {},
    getItem(k) { return this._[k] || null; },
    setItem(k, v) { this._[k] = String(v); },
    removeItem(k) { delete this._[k]; }
  },
  sessionStorage: { _: {}, getItem(k){return this._[k]||null;}, setItem(k,v){this._[k]=String(v);}, removeItem(k){delete this._[k];} },
  console, Math, Date, JSON, Array, Object, String, Number, Boolean, Error,
  Map, Set, WeakMap, WeakSet, Promise, RegExp, Symbol, Function,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  fetch: () => Promise.reject(new Error('no fetch')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  FileReader: function () { return { addEventListener: noop, readAsText: noop, readAsArrayBuffer: noop }; },
  Blob: function () {},
  globalThis: win,
});
ctx.window.location = ctx.location;
ctx.window.document = ctx.document;
ctx.window.navigator = ctx.navigator;
ctx.window.localStorage = ctx.localStorage;

const src = fs.readFileSync(path.join(__dirname, '.tmp', 'wts-main.js'), 'utf8');
try {
  vm.runInContext(src, ctx, { filename: 'wts-main.js' });
  console.log('[ok] main script loaded without throwing');
} catch (e) {
  console.error('[FAIL] script threw at load:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// Note: window.PRiSM (the per-session UI state container) is created lazily
// the first time renderPRiSM(body) runs in a real browser session.
// renderPRiSM is scoped to the host IIFE and not callable from outside, so
// we don't check for it here — the API surface checks below are sufficient.

const checks = [
  ['window.PRiSM_state',     typeof win.PRiSM_state === 'object'],
  ['window.PRiSM_MODELS',    typeof win.PRiSM_MODELS === 'object'],
  ['window.PRiSM_lm',        typeof win.PRiSM_lm === 'function'],
  ['window.PRiSM_bootstrap', typeof win.PRiSM_bootstrap === 'function'],
  ['window.PRiSM_superposition',          typeof win.PRiSM_superposition === 'function'],
  ['window.PRiSM_sandface_convolution',   typeof win.PRiSM_sandface_convolution === 'function'],
  ['window.PRiSM_runRegression',          typeof win.PRiSM_runRegression === 'function'],
  ['window.PRiSM_loadFile',               typeof win.PRiSM_loadFile === 'function'],
  ['window.PRiSM_renderDataTabEnhanced',  typeof win.PRiSM_renderDataTabEnhanced === 'function'],
  ['PRiSM_MODELS has Arps',               !!(win.PRiSM_MODELS && win.PRiSM_MODELS.arps)],
  ['PRiSM_MODELS has doublePorosity',     !!(win.PRiSM_MODELS && win.PRiSM_MODELS.doublePorosity)],
  ['PRiSM_MODELS has homogeneous',        !!(win.PRiSM_MODELS && win.PRiSM_MODELS.homogeneous)],
  ['PRiSM_MODELS has fetkovich',          !!(win.PRiSM_MODELS && win.PRiSM_MODELS.fetkovich)],
  ['PRiSM_MODELS has verticalPulse',      !!(win.PRiSM_MODELS && win.PRiSM_MODELS.verticalPulse)],
  // Plot-fn bridge — Agent A wiring exposes Phase 1+2 plot fns on window
  ['window.PRiSM_plot_bourdet',           typeof win.PRiSM_plot_bourdet === 'function'],
  ['window.PRiSM_plot_cartesian',         typeof win.PRiSM_plot_cartesian === 'function'],
  ['window.PRiSM_plot_horner',            typeof win.PRiSM_plot_horner === 'function'],
  ['window.PRiSM_plot_buildup_superposition', typeof win.PRiSM_plot_buildup_superposition === 'function'],
  // Round-2 — Phase 5 composite + multi-layer
  ['PRiSM_MODELS has twoLayerXF',         !!(win.PRiSM_MODELS && win.PRiSM_MODELS.twoLayerXF)],
  ['PRiSM_MODELS has radialComposite',    !!(win.PRiSM_MODELS && win.PRiSM_MODELS.radialComposite)],
  ['PRiSM_MODELS has multiLayerXF',       !!(win.PRiSM_MODELS && win.PRiSM_MODELS.multiLayerXF)],
  ['PRiSM_MODELS has multiLayerNoXF',     !!(win.PRiSM_MODELS && win.PRiSM_MODELS.multiLayerNoXF)],
  ['PRiSM_MODELS has linearComposite',    !!(win.PRiSM_MODELS && win.PRiSM_MODELS.linearComposite)],
  // Round-2 — Phase 6 interference / multi-lateral (sample 3 of 16)
  ['PRiSM_MODELS has interference',       !!(win.PRiSM_MODELS && win.PRiSM_MODELS.interference)],
  ['PRiSM_MODELS has mlHorizontalXF',     !!(win.PRiSM_MODELS && win.PRiSM_MODELS.mlHorizontalXF)],
  ['PRiSM_MODELS has multiLatMLXF',       !!(win.PRiSM_MODELS && win.PRiSM_MODELS.multiLatMLXF)],
  // Round-2 — Phase 7 specialised solvers
  ['PRiSM_MODELS has userDefined',        !!(win.PRiSM_MODELS && win.PRiSM_MODELS.userDefined)],
  ['PRiSM_MODELS has waterInjection',     !!(win.PRiSM_MODELS && win.PRiSM_MODELS.waterInjection)],
  // Round-2 — polish (SVG + analysis keys + PNG + GA4)
  ['window.PRiSM_getModelSchematic',      typeof win.PRiSM_getModelSchematic === 'function'],
  ['window.PRiSM_analysisKeys (≥20)',     !!(win.PRiSM_analysisKeys && Object.keys(win.PRiSM_analysisKeys).length >= 20)],
  ['window.PRiSM_armAnalysisKey',         typeof win.PRiSM_armAnalysisKey === 'function'],
  ['window.PRiSM_exportReportPDF',        typeof win.PRiSM_exportReportPDF === 'function'],
  ['window.PRiSM_exportPlotPNG',          typeof win.PRiSM_exportPlotPNG === 'function'],
  // Round-2 — Data crop
  ['window.PRiSM_renderCropTool',         typeof win.PRiSM_renderCropTool === 'function'],
  ['window.PRiSM_applyCrop',              typeof win.PRiSM_applyCrop === 'function'],
  ['window.PRiSM_resetCrop',              typeof win.PRiSM_resetCrop === 'function'],
  // Round-2 — Auto-match
  ['window.PRiSM_classifyRegimes',        typeof win.PRiSM_classifyRegimes === 'function'],
  ['window.PRiSM_autoMatch',              typeof win.PRiSM_autoMatch === 'function'],
  ['window.PRiSM_suggestInitialParams',   typeof win.PRiSM_suggestInitialParams === 'function'],
  // Round-2 — Interpretation
  ['window.PRiSM_interpretFit',           typeof win.PRiSM_interpretFit === 'function'],
  ['window.PRiSM_buildNarrative',         typeof win.PRiSM_buildNarrative === 'function'],
  ['window.PRiSM_renderInterpretationPanel', typeof win.PRiSM_renderInterpretationPanel === 'function'],
  // Round-2 — Annotations + auto-Bourdet-L
  ['window.PRiSM_autoBourdet_L',          typeof win.PRiSM_autoBourdet_L === 'function'],
  ['window.PRiSM_detectAnnotations',      typeof win.PRiSM_detectAnnotations === 'function'],
  ['window.PRiSM_drawPlotAnnotations',    typeof win.PRiSM_drawPlotAnnotations === 'function'],
  ['window.PRiSM_enableAutoAnnotations',  typeof win.PRiSM_enableAutoAnnotations === 'function'],
  // Round-3 — PVT
  ['window.PRiSM_pvt',                    typeof win.PRiSM_pvt === 'object'],
  ['window.PRiSM_pvt_correlations',       typeof win.PRiSM_pvt_correlations === 'object'],
  ['window.PRiSM_pvt_compute',            typeof win.PRiSM_pvt_compute === 'function'],
  ['window.PRiSM_dimensionalize',         typeof win.PRiSM_dimensionalize === 'function'],
  ['window.PRiSM_nondimensionalize',      typeof win.PRiSM_nondimensionalize === 'function'],
  ['window.PRiSM_renderPVTPanel',         typeof win.PRiSM_renderPVTPanel === 'function'],
  ['window.PRiSM_interpretFitWithPVT',    typeof win.PRiSM_interpretFitWithPVT === 'function'],
  // Round-3 — Deconvolution
  ['window.PRiSM_deconvolve',             typeof win.PRiSM_deconvolve === 'function'],
  ['window.PRiSM_deconvolve_lcurve',      typeof win.PRiSM_deconvolve_lcurve === 'function'],
  ['window.PRiSM_convolve_rate_response', typeof win.PRiSM_convolve_rate_response === 'function'],
  ['window.PRiSM_invert_to_unit_rate',    typeof win.PRiSM_invert_to_unit_rate === 'function'],
  ['window.PRiSM_renderDeconvolutionPanel', typeof win.PRiSM_renderDeconvolutionPanel === 'function'],
  // Round-3 — Tide analysis
  ['window.PRiSM_tideAnalysis',           typeof win.PRiSM_tideAnalysis === 'function'],
  ['window.PRiSM_applyTideCorrection',    typeof win.PRiSM_applyTideCorrection === 'function'],
  ['window.PRiSM_resetTideCorrection',    typeof win.PRiSM_resetTideCorrection === 'function'],
  ['window.PRiSM_renderTidePanel',        typeof win.PRiSM_renderTidePanel === 'function'],
  ['window.PRiSM_TIDE_CONSTITUENTS',      typeof win.PRiSM_TIDE_CONSTITUENTS === 'object'],
  // Round-3 — Data managers
  ['window.PRiSM_storage',                typeof win.PRiSM_storage === 'object'],
  ['window.PRiSM_gaugeData',              typeof win.PRiSM_gaugeData === 'object'],
  ['window.PRiSM_analysisData',           typeof win.PRiSM_analysisData === 'object'],
  ['window.PRiSM_project',                typeof win.PRiSM_project === 'object'],
  ['window.PRiSM_renderGaugeManager',     typeof win.PRiSM_renderGaugeManager === 'function'],
  ['window.PRiSM_renderAnalysisManager',  typeof win.PRiSM_renderAnalysisManager === 'function'],
  ['window.PRiSM_renderProjectToolbar',   typeof win.PRiSM_renderProjectToolbar === 'function'],
  // Round-3 — Synthetic PLT + inverse simulation
  ['window.PRiSM_syntheticPLT',           typeof win.PRiSM_syntheticPLT === 'function'],
  ['window.PRiSM_inverseSim',             typeof win.PRiSM_inverseSim === 'function'],
  ['window.PRiSM_unitRateResponse',       typeof win.PRiSM_unitRateResponse === 'function'],
  ['window.PRiSM_renderPLTPanel',         typeof win.PRiSM_renderPLTPanel === 'function'],
  ['window.PRiSM_renderInverseSimPanel',  typeof win.PRiSM_renderInverseSimPanel === 'function'],
  // Round-3 — Plot utilities
  ['window.PRiSM_overlays',               typeof win.PRiSM_overlays === 'object'],
  ['window.PRiSM_drawOverlays',           typeof win.PRiSM_drawOverlays === 'function'],
  ['window.PRiSM_renderOverlayManager',   typeof win.PRiSM_renderOverlayManager === 'function'],
  ['window.PRiSM_datasetDiff',            typeof win.PRiSM_datasetDiff === 'function'],
  ['window.PRiSM_exportXML',              typeof win.PRiSM_exportXML === 'function'],
  ['window.PRiSM_exportXMLDownload',      typeof win.PRiSM_exportXMLDownload === 'function'],
  ['window.PRiSM_copyPlotToClipboard',    typeof win.PRiSM_copyPlotToClipboard === 'function'],
  ['window.PRiSM_copyDataToClipboard',    typeof win.PRiSM_copyDataToClipboard === 'function'],
];

let modelCount = win.PRiSM_MODELS ? Object.keys(win.PRiSM_MODELS).length : 0;
checks.push(['PRiSM_MODELS count >= 45', modelCount >= 45]);

// Round-7 — live 3D Well Test Simulator (31 sim, 32 scene, 38 controller)
[
  ['window.WTS_sim',                 typeof win.WTS_sim === 'object'],
  ['WTS_sim.create',                 typeof (win.WTS_sim||{}).create === 'function'],
  ['WTS_sim.SAMPLE_FLOW.inputs',     !!(win.WTS_sim && win.WTS_sim.SAMPLE_FLOW && win.WTS_sim.SAMPLE_FLOW.inputs)],
  ['WTS_sim 1h steady finite+balanced', (() => { try { const S = win.WTS_sim, s = S.create(S.SAMPLE_FLOW, {seed:7});
      for (let i = 0; i < 360; i++) s.advance(10); const st = s.getState();
      return isFinite(st.sep.P) && Math.abs(st.sep.P - 150) < 15 && Math.abs(st.health.massErr.oil) < 1e-6; } catch (e) { return false; } })()],
  ['window.WTS_3d',                  typeof win.WTS_3d === 'object'],
  ['WTS_3d.mount',                   typeof (win.WTS_3d||{}).mount === 'function'],
  ['WTS_3d.isSupported() false in node', !!win.WTS_3d && win.WTS_3d.isSupported() === false],
  ['window.WTS_live',                typeof win.WTS_live === 'object'],
  ['WTS_live.mount',                 typeof (win.WTS_live||{}).mount === 'function'],
  ['window.wtsDrawDiag bridge',      typeof win.wtsDrawDiag === 'function'],
  ['window.WTS_DIAG_LAYOUT',         !!(win.WTS_DIAG_LAYOUT && win.WTS_DIAG_LAYOUT.tx && win.WTS_DIAG_LAYOUT.tx.length === 6 && win.WTS_DIAG_LAYOUT.W === 1200)],
].forEach((c) => checks.push(c));

// Round-6 — project file (.h2oilproj) + host universal autosave hooks
checks.push(['window.WTS_project',                   typeof win.WTS_project === 'object']);
checks.push(['window.WTS_pageAutosave.flush',        !!(win.WTS_pageAutosave && typeof win.WTS_pageAutosave.flush === 'function')]);
checks.push(['window.WTS_rerender',                  typeof win.WTS_rerender === 'function']);
// Round-6 — multi-well projects + read-only snapshots (29-multiwell.js)
checks.push(['window.WTS_wells + wells module',       !!(win.WTS_wells && typeof win.WTS_wells.switchTo === 'function' && win.WTS_project && win.WTS_project.listModules().indexOf('wells') !== -1)]);
checks.push(['window.WTS_snapshot.sanitize strips scripts', !!(win.WTS_snapshot && !/<script|onerror/i.test(win.WTS_snapshot.sanitize('<img src=x onerror=a()><script>b()</script>')))]);
// v3.0 P10 accessibility layer (50-a11y.js) + P6 cached number formatter (host)
checks.push(['window.WTS_a11y.apply / name',         !!(win.WTS_a11y && typeof win.WTS_a11y.apply === 'function' && typeof win.WTS_a11y.name === 'function')]);
checks.push(['WTS_parseNumber default is plain parseFloat', typeof win.WTS_parseNumber === 'function' && win.WTS_parseNumber('12,5') === 12 && win.WTS_parseNumber('2.5') === 2.5]);
checks.push(['WTS_fmtNum ≡ toLocaleString',          typeof win.WTS_fmtNum === 'function' &&
  win.WTS_fmtNum(1234.5678, 0, 2) === (1234.5678).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })]);
// Round-9 — plug-in calculator registry (host); prism-build/4N-calc-*.js register into it
checks.push(['window.WTS_calcRegistry (object)',     !!win.WTS_calcRegistry && typeof win.WTS_calcRegistry === 'object']);
checks.push(['WTS_calcRegistry entries well-formed', Object.keys(win.WTS_calcRegistry || {}).every((k) => {
  const e = win.WTS_calcRegistry[k];
  const ok = !!e && /^[a-z][a-z0-9_]{1,31}$/.test(k) && (e.key == null || e.key === k) && typeof e.render === 'function' &&
             typeof e.title === 'string' && !!e.title && typeof e.group === 'string' && !!e.group;
  if (!ok) console.error('malformed WTS_calcRegistry entry:', k);
  return ok;
})]);
// Round-9 v1.7 calculators (41-44-calc-*.js): registered + pure compute functions
[['gasdeliv', 'WTS_gasdeliv_compute'], ['oilipr', 'WTS_oilipr_compute'],
 ['flareghg', 'WTS_flareghg_compute'], ['h2sroe', 'WTS_h2sroe_compute']].forEach(([k, fn]) => {
  checks.push(['WTS_calcRegistry.' + k + ' registered',  !!(win.WTS_calcRegistry && win.WTS_calcRegistry[k])]);
  checks.push(['window.' + fn + ' (function)',          typeof win[fn] === 'function']);
});
// Round-10 — live data (6N-*.js): Modbus core + station, Modbus page, Mini WellOS
checks.push(['window.WTS_modbus (object)',            !!win.WTS_modbus && typeof win.WTS_modbus === 'object']);
checks.push(['WTS_modbus.createClient / createStation', !!win.WTS_modbus && typeof win.WTS_modbus.createClient === 'function' && typeof win.WTS_modbus.createStation === 'function']);
checks.push(['WTS_modbus.crc16("123456789") = 0x4B37', (() => { try { return win.WTS_modbus.crc16([49, 50, 51, 52, 53, 54, 55, 56, 57]) === 0x4B37; } catch (e) { return false; } })()]);
checks.push(['WTS_modbus.getTags (function)',        !!win.WTS_modbus && typeof win.WTS_modbus.getTags === 'function']);
checks.push(['WTS_calcRegistry.modbus + wellos registered', !!(win.WTS_calcRegistry && win.WTS_calcRegistry.modbus && win.WTS_calcRegistry.wellos)]);
checks.push(['WTS_modbus idle: no station at load',  !!win.WTS_modbus && win.WTS_modbus.station() === null]);
checks.push(['WTS_project has storage module',       !!(win.WTS_project && win.WTS_project.listModules().indexOf('storage') !== -1)]);
(function storageRoundTrip() {
  let ok = false;
  try {
    const ls = ctx.localStorage;
    ls.setItem('wts_page_smoke', '{"v":1,"f":{"x":"7"}}');
    ls.setItem('wts_unit_system', 'metric');
    const payload = win.WTS_project._buildPayload();
    const keys = payload.modules.storage && payload.modules.storage.keys;
    const captured = !!keys && keys.wts_page_smoke === '{"v":1,"f":{"x":"7"}}' && !('wts_unit_system' in keys);
    ls.removeItem('wts_page_smoke');
    const res = win.WTS_project.loadFromObject(JSON.parse(JSON.stringify(payload)));
    ok = captured && !res.error && ls.getItem('wts_page_smoke') === '{"v":1,"f":{"x":"7"}}' &&
         ls.getItem('wts_unit_system') === 'metric';
    ls.removeItem('wts_page_smoke'); ls.removeItem('wts_unit_system');
  } catch (e) { console.error('storage round-trip threw:', e.message); }
  checks.push(['WTS_project storage module round-trip', ok]);
})();

// ── Gap-closure contracts C1–C9 + work-package exports (WP0 task 0.5) ──
const CONTRACT_FNS = {
  C1: ['PRiSM_getWell', 'PRiSM_setWell', 'PRiSM_acceptWellDefaults', 'PRiSM_pvt_effective', 'PRiSM_mpTable', 'PRiSM_renderWellCard'],
  C2: ['PRiSM_getAnalysisData', 'PRiSM_rateHistory', 'PRiSM_timeFunction', 'PRiSM_datasetHash', 'PRiSM_compute_bourdet'],
  C3: ['PRiSM_physicalModel', 'PRiSM_evalWbsSkin', 'PRiSM_lap_horizontal', 'PRiSM_pd_lap_homogeneous'],
  C4: ['PRiSM_setLastFit', 'PRiSM_getLastFit', 'PRiSM_fitPhysical', 'PRiSM_fitRate', 'PRiSM_agarwalTime'],
  C5: ['PRiSM_applyTypeCurveMatch', 'PRiSM_matchToPhysical'],
  C6: ['PRiSM_plot_mdh', 'PRiSM_plot_message', 'PRiSM_plotResetView', 'PRiSM_plotSetView', 'PRiSM_buildPlotData',
       'PRiSM_drawActivePlot', 'PRiSM_evalModelCurve', 'PRiSM_detectPeriods'],
  C7: ['PRiSM_registerTabPanel', 'PRiSM_mountTabPanels', 'PRiSM_registerPostDrawHook', 'PRiSM_commitDataset', 'PRiSM_setModel'],
  C8: ['PRiSM_saveState', 'PRiSM_restoreState'],
  C9: ['PRiSM_gotoStep', 'PRiSM_currentStep', 'PRiSM_stepStatus', 'PRiSM_renderRail', 'PRiSM_analyse', 'PRiSM_openTools',
       'PRiSM_closeTools', 'PRiSM_listTools', 'PRiSM_undo', 'PRiSM_redo', 'PRiSM_canUndo', 'PRiSM_canRedo',
       'PRiSM_loadDemoData', 'PRiSM_seedDefaultSample', 'PRiSM_renderFlowPeriods'],
  WP3: ['PRiSM_autoMatchSync', 'PRiSM_applyAutoMatchRow', 'PRiSM_refreshInterpretation', 'PRiSM_renderAutoMatchPanel', 'PRiSM_interpretCurrentFit'],
  WP5: ['PRiSM_semilogAnalysis', 'PRiSM_skinSummary', 'PRiSM_skinDecomposition', 'PRiSM_rateDependentSkin', 'PRiSM_renderSemilogPanel', 'PRiSM_semilogPlotLine'],
  WP7: ['PRiSM_renderPlotsTab', 'PRiSM_renderModelTab', 'PRiSM_renderParamsTab', 'PRiSM_renderMatchTab', 'PRiSM_renderRegressTab', 'PRiSM_autoAlignOverlay', 'PRiSM_renderFitResults'],
  WP9: ['PRiSM_renderReportTab', 'PRiSM_buildReportHTML', 'PRiSM_buildReportCSV', 'PRiSM_exportCSV', 'PRiSM_reportData', 'PRiSM_reportResults', 'PRiSM_exportReport'],
  WP10: ['PRiSM_runAnalysisKey', 'PRiSM_disarmAnalysisKey', 'PRiSM_renderAnalysisKeyToolbar', 'PRiSM_renderPlotToolsPanel', 'PRiSM_detectAnnotationsForData'],
  WP11: ['PRiSM_deconvolveDataset', 'PRiSM_applyDeconvolvedPi', 'PRiSM_inverseSimDataset', 'PRiSM_renderDatasetsPanel', 'PRiSM_renderPLTInversePanel'],
  WP12: ['PRiSM_declineResults', 'PRiSM_fitDecline', 'PRiSM_rtaData', 'PRiSM_rtaFMB', 'PRiSM_rtaLinearFlow', 'PRiSM_rtaSummary',
         'PRiSM_renderDeclineResultsPanel', 'PRiSM_renderRTAPanel', 'PRiSM_fetkovich_typecurve'],
  WP14: ['PRiSM_listGauges', 'PRiSM_setGauge', 'PRiSM_removeGauge', 'PRiSM_setPrimaryGauge', 'PRiSM_primaryGauge',
         'PRiSM_gaugeResolutionCheck', 'PRiSM_gaugeSamplingLimit', 'PRiSM_addEvent', 'PRiSM_listEvents', 'PRiSM_removeEvent',
         'PRiSM_clearEvents', 'PRiSM_setEventClock', 'PRiSM_eventsToRateSchedule', 'PRiSM_seedPeriodsFromEvents',
         'PRiSM_rockCompressibility', 'PRiSM_ctBuild', 'PRiSM_ctApply', 'PRiSM_renderGaugeRegister', 'PRiSM_renderEventsLog',
         'PRiSM_renderCtBuilder', 'PRiSM_renderGaugeCheckPanel'],
  WP15: ['PRiSM_saveFit', 'PRiSM_listFits', 'PRiSM_getFit', 'PRiSM_removeFit', 'PRiSM_renameFit', 'PRiSM_adoptFit',
         'PRiSM_setFitCompare', 'PRiSM_getFitCompare', 'PRiSM_toggleFitCompare', 'PRiSM_setFitOverlay', 'PRiSM_fitCompareTable',
         'PRiSM_fitOverlayCurve', 'PRiSM_createBranch', 'PRiSM_switchBranch', 'PRiSM_renameBranch', 'PRiSM_deleteBranch',
         'PRiSM_listBranches', 'PRiSM_activeBranch', 'PRiSM_modelPlainInfo', 'PRiSM_searchModels', 'PRiSM_modelSearchTerms',
         'PRiSM_renderFitWorkspacePanel', 'PRiSM_renderModelBrowserPanel',
         'PRiSM_gasPseudoTime', 'PRiSM_gasSkinSummary', 'PRiSM_gasBasis', 'PRiSM_setGasOption', 'PRiSM_skinVsRate',
         'PRiSM_deliverabilityPoints', 'PRiSM_gasDeliverability', 'PRiSM_oilDeliverability', 'PRiSM_deliverability',
         'PRiSM_renderGasPanel', 'PRiSM_renderRateSkinPanel', 'PRiSM_renderDeliverabilityPanel',
         'PRiSM_declineDiagnostics', 'PRiSM_plot_decline_D', 'PRiSM_plot_decline_b'],
};
Object.keys(CONTRACT_FNS).forEach((c) => CONTRACT_FNS[c].forEach((fn) => checks.push([c + ' window.' + fn, typeof win[fn] === 'function'])));
checks.push(['C3 window.PRiSM_convert (object)', !!win.PRiSM_convert && typeof win.PRiSM_convert.kh === 'function']);
checks.push(['C3 window.PRiSM_pseudoSkin.bronsMarting', !!win.PRiSM_pseudoSkin && typeof win.PRiSM_pseudoSkin.bronsMarting === 'function']);
checks.push(['C1 window.PRiSM_DEFAULT_SAMPLE_META', !!win.PRiSM_DEFAULT_SAMPLE_META && win.PRiSM_DEFAULT_SAMPLE_META.pi === 4200]);
checks.push(['C6 window.PRiSM_PLOT_REGISTRY has mdh', !!(win.PRiSM_PLOT_REGISTRY && win.PRiSM_PLOT_REGISTRY.mdh)]);
checks.push(['C7 registries (tabPanels, tabHooks, postDrawHooks, stepViews)',
  !!win.PRiSM_tabPanels && !!win.PRiSM_tabHooks && !!win.PRiSM_postDrawHooks && !!win.PRiSM_stepViews && typeof win.PRiSM_stepViews[2] === 'function']);
(function panelIds() {
  const ids = (n) => { const p = win.PRiSM_tabPanels && win.PRiSM_tabPanels[n]; return (Array.isArray(p) ? p : []).map((x) => x && x.id); };
  const want = { 1: ['prism_well_test', 'crop', 'prism_ct_builder', 'prism_gauge_register', 'prism_events_log'],
                 2: ['semilog', 'linetools', 'regimes', 'prism_gauge_resolution', 'prism_gas_basis', 'prism_rate_skin', 'prism_deliverability', 'prism_fit_compare'],
                 3: ['prism_model_browser'], 6: ['prism_interp_panel', 'dcaResults', 'prism_fit_workspace'] };
  Object.keys(want).forEach((n) => want[n].forEach((id) => checks.push(['C7 Tab ' + n + ' panel "' + id + '"', ids(n).indexOf(id) !== -1])));
})();
checks.push(['WP14 field-tools post-draw hook registered once',
  Array.isArray(win.PRiSM_postDrawHooks) && win.PRiSM_postDrawHooks.filter((f) => f && f._prismId === 'fieldtools-markers').length === 1]);
['workspace-fit-overlays', 'gas-pseudotime-label'].forEach((id) => checks.push(['WP15 post-draw hook "' + id + '" registered once',
  Array.isArray(win.PRiSM_postDrawHooks) && win.PRiSM_postDrawHooks.filter((f) => f && f._prismId === id).length === 1]));
checks.push(['WP15 report sections registry (workspace + gas)', Array.isArray(win.PRiSM_reportSections) && win.PRiSM_reportSections.length >= 4]);
checks.push(['WP15 plot registry declineD / declineB', !!(win.PRiSM_PLOT_REGISTRY && win.PRiSM_PLOT_REGISTRY.declineD && win.PRiSM_PLOT_REGISTRY.declineB)]);
(function wp15Numbers() {
  // Hand values: linear m(p) = 2p → ΔpS = 0.8686·100·2/2 = 86.86 psi at pwf 1000; Arps b = 0.5, Di = 0.01: D(100 d) = 0.01/1.5.
  let ok = false;
  try {
    const g = win.PRiSM_gasSkinSummary({ S: 2, m: 100, pbar: 2000, pwf: 1000, table: { mOf: (p) => 2 * p, pOf: (m) => m / 2 } });
    ok = Math.abs(g.dpS - 86.86) < 1e-9 && win.PRiSM_searchModels('valley')[0].key === 'doublePorosity';
  } catch (e) { ok = false; }
  checks.push(['WP15 gas skin summary + model search', ok]);
})();
(function fieldToolsNumbers() {
  // Hand value: Hall (1953) φ = 0.2 → 1.782e-6 / 0.2^0.438 = 3.6063e-6 1/psi.
  let ok = false;
  try { ok = Math.abs(win.PRiSM_rockCompressibility(0.2, 'hall') - 3.6063e-6) < 1e-9; } catch (e) { ok = false; }
  checks.push(['WP14 Hall rock compressibility', ok]);
})();
(function registryMeta() {
  const M = win.PRiSM_MODELS || {};
  const bad = Object.keys(M).filter((k) => k !== 'userDefined' && !(M[k] && (M[k].kind === 'pressure' || M[k].kind === 'rate')));
  if (bad.length) console.error('models without kind:', bad.join(', '));
  checks.push(['C3 every registry model has kind pressure|rate', bad.length === 0]);
})();

// No perpetual timers (WP0 0.5): load the real page in the acceptance harness,
// open PRiSM on the demo data, let it idle 5 s of virtual time → nothing pending.
(function noPerpetualTimers() {
  let ok = false, detail = '';
  try {
    const harness = require('./tests/_harness');
    const app = harness.loadApp({ fromSources: false, timers: 'manual', console: 'capture' });
    app.openPRiSM();
    app.flush(5000);
    const n = app.pendingTimers();
    ok = n === 0;
    if (!ok && typeof app.timers === 'function') detail = JSON.stringify(app.timers()).slice(0, 600);
  } catch (e) { detail = e.message; }
  if (detail) console.error('pending timers after 5 s idle:', detail);
  checks.push(['no perpetual timers after 5 s idle (PRiSM open)', ok]);
})();
// Round-10: Mini WellOS polling Modbus (built-in simulator) stops when the page closes.
(function noModbusTimersAfterLeaving() {
  let ok = false, detail = '';
  try {
    const harness = require('./tests/_harness');
    const app = harness.loadApp({ fromSources: false, timers: 'manual', console: 'capture' });
    const M = app.win.WTS_modbus;
    M.saveConfig(M.demoConfig());
    app.storage.setItem('wts_wellos_ui', JSON.stringify({ source: 'modbus', view: '2d' }));
    app.hook.nav('wellos');
    app.flush(2500);
    const polling = !!(M.station() && M.station().isRunning());
    app.hook.nav('home');
    app.flush(5000);
    ok = polling && app.pendingTimers() === 0 && M.station() === null;
    if (!ok) detail = 'polling=' + polling + ' pending=' + app.pendingTimers() + ' ' + (typeof app.timers === 'function' ? JSON.stringify(app.timers()).slice(0, 400) : '');
  } catch (e) { detail = e.message; }
  if (detail) console.error('Mini WellOS timers:', detail);
  checks.push(['no timers after leaving Mini WellOS (Modbus polling stopped)', ok]);
})();

console.log('\nNamespace checks:');
let fails = 0;
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  if (!ok) fails++;
}
console.log('\nPRiSM_MODELS total: ' + modelCount + ' entries');
if (modelCount > 0) {
  console.log('  ' + Object.keys(win.PRiSM_MODELS).sort().join(', '));
}

if (fails) {
  console.error('\n[FAIL] ' + fails + ' check(s) failed');
  process.exit(1);
}
console.log('\n[ok] all ' + checks.length + ' smoke-test checks passed');
