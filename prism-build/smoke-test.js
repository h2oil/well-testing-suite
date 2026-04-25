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
];

let modelCount = win.PRiSM_MODELS ? Object.keys(win.PRiSM_MODELS).length : 0;
checks.push(['PRiSM_MODELS count >= 45', modelCount >= 45]);

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
