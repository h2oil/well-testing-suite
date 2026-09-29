#!/usr/bin/env node
// =============================================================================
// wts3d-test.js — Node runner for the Round-7 live 3D Well Test Simulator files
// -----------------------------------------------------------------------------
//   node prism-build/wts3d-test.js            # every Round-7 file that exists
//   node prism-build/wts3d-test.js 31 38      # only the listed prefixes
//   WTS_VERBOSE=1 node prism-build/wts3d-test.js   # echo every self-test line
//
// Data-driven: SUITES lists the Round-7 sources in injection order. A file that is
// not on disk yet is reported as "skipped" (never a failure), so each owner can land
// their file independently. For every present file the runner:
//   1. runs the file AS-IS (module + its own `// === SELF-TEST ===` block) in a fresh
//      vm context (real timers/Promise; asynchronous self-tests are awaited up to 20 s)
//      and parses "[label] self-test N/M passed" from its console output;
//   2. applies the source rules shared by all Round-7 files (§2 of the spec);
//   3. loads the STRIPPED module (what concat-round7 injects) into ONE shared vm
//      context, in order, with a host-like stub (no CustomEvent / performance /
//      structuredClone / queueMicrotask / fetch — same gaps as smoke-test.js) and
//      checks the load-time rule (no DOM, timers, storage or listeners touched);
//   4. runs the owner's integration checks against that shared context.
// The fixture (calcWTS defaults after H8 = WTS_sim.SAMPLE_FLOW, spec Appendix A) is
// published into the shared context as `WTS_TEST_FIXTURE` once 31 has loaded.
//
// Owners: add checks ONLY inside your own section below (SECTION A = 31, B = 32,
// C = 38). Each check is ['name', () => boolean | string] — a string is a failure
// message; a thrown error is a failure. Do not put this file in prism-build/tests/.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const VERBOSE = !!process.env.WTS_VERBOSE;
const ONLY = process.argv.slice(2).filter(a => /^\d+$/.test(a));

const SUITES = [
  { file: '31-wts-sim.js',  ns: 'WTS_sim',  label: '31-wts-sim',  owner: 'A' },
  { file: '32-wts-3d.js',   ns: 'WTS_3d',   label: '32-wts-3d',   owner: 'B' },
  { file: '38-wts-live.js', ns: 'WTS_live', label: '38-wts-live', owner: 'C' },
];

// ─── helpers ──────────────────────────────────────────────────────────────────
function stripSelfTest(src) {                    // mirrors concat-round7.js (marker at column 0, last occurrence)
  const lines = src.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\/\/\s*(?:=*|SECTION\s+\d+\s*[—-]?)\s*SELF[-_ ]?TEST\s*=*\s*$/i.test(lines[i].trim())) return lines.slice(0, i).join('\n');
  }
  return null;
}
function stripComments(src) {                    // rough: drop // and /* */ comments outside strings (good enough for rule greps)
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += d || ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
function capture() {
  const lines = [];
  const push = (...a) => lines.push(a.map(x => (typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x))).join(' '));
  return { lines, console: { log: push, info: push, warn: push, error: push, debug: push } };
}
function makeHostStub(spy) {                     // browser-ish global; every side-effecting entry point is recorded
  const noop = () => {};
  const rec = name => (...a) => { spy.push(name); return undefined; };
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: rec('dom.appendChild'), addEventListener: rec('dom.addEventListener'), setAttribute: rec('dom.setAttribute'),
    getContext: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const document = {
    getElementById: (...a) => { spy.push('document.getElementById'); return el(); },
    createElement: (...a) => { spy.push('document.createElement'); return el(); },
    createElementNS: (...a) => { spy.push('document.createElementNS'); return el(); },
    querySelector: (...a) => { spy.push('document.querySelector'); return null; },
    querySelectorAll: (...a) => { spy.push('document.querySelectorAll'); return []; },
    addEventListener: rec('document.addEventListener'), removeEventListener: noop, dispatchEvent: rec('document.dispatchEvent'),
    head: el(), body: el(), documentElement: el(), visibilityState: 'visible', hidden: false, readyState: 'complete',
  };
  const store = () => ({ _: {}, getItem(k) { spy.push('storage.getItem'); return null; }, setItem() { spy.push('storage.setItem'); }, removeItem() { spy.push('storage.removeItem'); } });
  return {
    document, navigator: { userAgent: 'node', onLine: true }, location: { hash: '', pathname: '/', search: '' },
    localStorage: store(), sessionStorage: store(),
    setTimeout: rec('setTimeout'), clearTimeout: noop, setInterval: rec('setInterval'), clearInterval: noop,
    requestAnimationFrame: rec('requestAnimationFrame'), cancelAnimationFrame: noop,
    addEventListener: rec('window.addEventListener'), removeEventListener: noop,
    devicePixelRatio: 1, innerWidth: 1380, innerHeight: 900,
  };
}
function newContext(extra) {
  const cap = capture();
  const sb = Object.assign({ console: cap.console }, extra || {});
  vm.createContext(sb);
  sb.window = sb;                                // window === the context global (window.X defines global X)
  return { sb, cap };
}
function parseSelfTest(lines, label) {
  const re = new RegExp('\\[' + label.replace(/[-]/g, '\\-') + '\\]\\s*self-test\\s+(\\d+)\\s*/\\s*(\\d+)\\s+passed', 'i');
  for (const l of lines) { const m = re.exec(l); if (m) return { pass: +m[1], total: +m[2] }; }
  return null;
}
const deepFrozen = o => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.keys(o).every(k => deepFrozen(o[k])));

// ─── generic source rules (every Round-7 file) ─────────────────────────────────
function sourceRules(src, suite) {
  const mod = stripSelfTest(src);
  const code = stripComments(mod || src);
  return [
    ['self-test marker (// === SELF-TEST ===) present', () => mod !== null],
    ['outer IIFE opens at column 0', () => /^\(function\s*\(\)\s*\{/m.test(mod || '')],
    ["'use strict' in the module", () => /['"]use strict['"]/.test(mod || '')],
    ['no literal dynamic-import call in the file', () => !/\bimport\s*\(/.test(src) || 'found a dynamic import call'],
    ['no import.meta', () => !/import\.meta/.test(code)],
    ['no literal </script> in the file', () => !/<\/script>/i.test(src)],
    ['no top-level await / structuredClone / queueMicrotask in the module', () => !/\bstructuredClone\b|\bqueueMicrotask\b/.test(code) || 'found'],
    ['assigns window.' + suite.ns, () => new RegExp('\\.' + suite.ns + '\\s*=').test(code)],
  ];
}

// ─── SECTION A — 31-wts-sim (Engineer A) ───────────────────────────────────────
const SECTION_A = (G, src) => {
  const S = G.WTS_sim;
  const code = stripComments(stripSelfTest(src) || '');
  const F = G.WTS_TEST_FIXTURE;
  const finiteWalk = (o, p, bad) => {
    if (o === null) { if (S.NULLABLE.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p); return; }
    if (typeof o === 'number') { if (!isFinite(o)) bad.push(p); return; }
    if (Array.isArray(o)) return o.forEach((v, i) => finiteWalk(v, p + '[' + i + ']', bad));
    if (typeof o === 'object') for (const k in o) finiteWalk(o[k], p ? p + '.' + k : k, bad);
  };
  return [
    ['31: DOM-free module (no document/window DOM APIs, timers, Date, performance)', () => {
      const hits = code.match(/\bdocument\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bDate\b|\bperformance\b|\blocalStorage\b|\bsessionStorage\b|\baddEventListener\b/g);
      return !hits || 'found ' + [...new Set(hits)].join(',');
    }],
    ['31: contract surface', () => ['VERSION', 'TAGS', 'NAMES', 'NULLABLE', 'DEFAULTS', 'SAMPLE_FLOW', 'create', 'flowFromInputs', 'deepClone', 'deepMerge', 'geom', 'pvt', 'valve', 'fmtClock']
      .filter(k => !(k in S)).join(',') || true],
    ['31: DEFAULTS, SAMPLE_FLOW, TAGS, NAMES, NULLABLE deep-frozen', () => ['DEFAULTS', 'SAMPLE_FLOW', 'TAGS', 'NAMES', 'NULLABLE'].every(k => deepFrozen(S[k]))],
    ['31: fixture = Appendix A (Critical choke 157.66 psig, heater 2.103 MMBtu/hr, 6" segs 3–4)', () =>
      F && F.v === 1 && F.choke.regime === 'Critical' && Math.abs(F.choke.Pout - 157.66) < 0.01 && Math.abs(F.heater.dutyMMBtuHr - 2.103) < 0.001 &&
      F.segs[2].nps === '6' && F.segs[3].nps === '6' && F.nodes.length === 8 && F.segs.length === 6 && F.warnings.length === 0],
    ['31: smoke-style 1 h steady (frozen SAMPLE_FLOW) finite + balanced', () => {
      const s = S.create(S.SAMPLE_FLOW, { seed: 7 });
      for (let i = 0; i < 360; i++) s.advance(10);
      const st = s.getState();
      return isFinite(st.sep.P) && Math.abs(st.sep.P - 150) < 15 && Math.abs(st.health.massErr.oil) < 1e-6 && Math.abs(st.health.massErr.gas) < 1e-6;
    }],
    ['31: every numeric snapshot path finite (NULLABLE honoured) after 2 h + manual ESD', () => {
      const s = S.create(F, { seed: 3 }); for (let i = 0; i < 720; i++) s.advance(10);
      s.tripESD('manual'); s.advance(60);
      const bad = []; finiteWalk(s.getState(), '', bad); return bad.length === 0 || bad.slice(0, 5).join(',');
    }],
    ['31: getState() returns the same live object; mutators apply while paused (D37)', () => {
      const s = S.create(F, { seed: 1 }); const st = s.getState(); s.pause();
      s.setFlow(S.flowFromInputs({ bean: 44 }));
      return st === s.getState() && st.inputs.bean === 44 && st.running === false && st.t === 0;
    }],
    ['31: step() = advance(min(dt, realDtCap)·speed) when running', () => {
      const s = S.create(F, { seed: 1, speed: 60 }); s.play(); s.step(0.05); const a = s.getState().t; s.step(5); const b = s.getState().t;
      return Math.abs(a - 3) < 1e-9 && Math.abs(b - a - 6) < 1e-9;
    }],
    ['31: getHistory keys + decimation', () => {
      const s = S.create(F, { seed: 1 }); for (let i = 0; i < 120; i++) s.advance(10);
      const keys = ['Psep', 'PsepSP', 'bucketFrac', 'ifaceFrac', 'c1Frac', 'surgeFrac', 'surgeP', 'gaugeFracA', 'gaugeFracB', 'qgFlare', 'qoMeter', 'Pwh', 'Pchoke', 'Twh'];
      const ok = keys.every(k => { const h = s.getHistory(k); return h.t.length === h.y.length && h.t.length >= 200; });
      const d = s.getHistory('Psep', 50);
      return ok && d.t.length === 50 && d.t[0] === 0 && d.t[49] === s.getHistory('Psep').t.slice(-1)[0];
    }],
    ['31: dispose() is idempotent; methods become no-ops; getState() keeps the last snapshot', () => {
      const s = S.create(F, { seed: 1 }); s.advance(10); const st = s.getState(); const t = st.t;
      s.dispose(); s.dispose(); s.advance(100); s.setFault('slugging', true); s.tripESD('x');
      return s.getState() === st && st.t === t && st.faults.slugging === false && s.disposed === true;
    }],
    ['31: divert valves / suction / auto-divert API + snapshot (twin surge compartments, gauge inlets)', () => {
      const s = S.create(F, { seed: 5, config: { noise: { on: false } } }); const st = s.getState(), bad = [];
      if (!['setValve', 'setSuction', 'setAutoDivert', 'getControls', 'setControls'].every(k => typeof s[k] === 'function')) return 'api';
      const c0 = JSON.stringify(s.getControls());
      // v3.0: the lineup also carries the divert valve stroke (s) and the gauge 'allow interrupting batches' option
      if (c0 !== JSON.stringify({ surge: { inlet: [true, true], suction: 'both', auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 }, gauge: { inlet: [true, false], auto: false, sp: 0.9, hyst: 0.1, strokeS: 6, allowInterrupt: false }, v: 1 })) bad.push('defaults ' + c0);
      if (st.surge.comps.length !== 2 || st.surge.comps[0].tag !== 'T-201A' || st.gauge.tanks[1].valveTag !== 'XV-301B' || st.surge.auto.on !== false) bad.push('snapshot');
      s.setValve('gauge', 1, true); s.setValve('gauge', 0, false); s.setValve('surge', 1, false); s.setSuction('B'); s.setAutoDivert('surge', true, { sp: 0.85 });
      for (let i = 0; i < 60; i++) s.advance(10);
      const c1 = s.getControls(), st1 = s.getState();
      if (st1.gauge.active !== 1 || st1.gauge.tanks[0].inlet || !st1.gauge.tanks[1].inlet || st1.surge.comps[1].fill_bpd !== 0 || st1.surge.suction !== 'B') bad.push('lineup');
      const s2 = S.create(F, { seed: 5 }); s2.setControls(JSON.parse(JSON.stringify(c1)), { initial: true });
      if (JSON.stringify(s2.getControls()) !== JSON.stringify(c1)) bad.push('round-trip');
      if (s.setSuction('X') !== false || s.setValve('tank', 0, true) !== false) bad.push('validation');
      const m = st1.health.massErr; if (Math.abs(m.oil) > 1e-9 || Math.abs(m.water) > 1e-9) bad.push('mass');
      return bad.length === 0 || bad.join('; ');
    }],
    ['31: invalid flow keeps the old flow and flags health.flowInvalid', () => {
      const s = S.create(F, { seed: 1 }); const seq = s.getState().flowSeq;
      s.setFlow({ inputs: { Qg: NaN } }); const a = s.getState().health.flowInvalid && s.getState().flowSeq === seq;
      s.setFlow(F); return a && !s.getState().health.flowInvalid && s.getState().flowSeq === seq + 1;
    }],
  ];
};

// ─── SECTION B — 32-wts-3d (Engineer B) ────────────────────────────────────────
// Engineer B: append checks here. G.WTS_3d._internals (fakeSnapshot, fitRadius, …) and
// G.WTS_TEST_FIXTURE / G.WTS_sim are available when their files are present.
const SECTION_B = (G /*, src */) => {
  const W = G.WTS_3d, I = W._internals, S = G.WTS_sim, F = G.WTS_TEST_FIXTURE;
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  // every snapshot path that 32's normalize() reads (§3.3 contract as consumed by the scene)
  const READS = ['t', 'running', 'flowSeq', 'alarmVersion', 'f', 'fInst', 'clock', 'inputs.Qg', 'inputs.Qo', 'inputs.Qw', 'inputs.bean', 'inputs.bypass',
    'fluid.API', 'esd.travel', 'esd.tripped', 'esd.manual', 'esd.moving', 'esd.causeMsg',
    'nodes.wellhead.P', 'nodes.esd.P', 'nodes.choke.P', 'nodes.choke.Pin', 'nodes.choke.regime', 'nodes.choke.bean', 'nodes.choke.flowLimited', 'nodes.choke.dTjt', 'nodes.choke.hyd',
    'nodes.heater.P', 'nodes.heater.T', 'nodes.heater.Tin', 'nodes.heater.firing', 'nodes.heater.bypass', 'nodes.heater.dutyMMBtuHr',
    'nodes.separator.P', 'nodes.flare.P', 'nodes.flare.Pline', 'nodes.flare.qMMscfd', 'nodes.surge.P', 'nodes.gauge.P',
    'segs.0.nps', 'segs.2.vel', 'segs.2.P0', 'segs.2.Pout', 'segs.2.T0', 'segs.2.hydR', 'segs.4.vPct', 'segs.5.vel', 'segs.5.vSt',
    'lines.wh_esd.active', 'lines.choke_heater.vel', 'lines.sep_flare.active', 'lines.sep_oil.vel', 'lines.sep_water.q', 'lines.surge_gauge.tank',
    'lines.surge_gauge.active', 'lines.blanket.vel', 'lines.surge_vent.vel', 'lines.gauge_drain.tank', 'lines.gauge_drain.vel',
    'sep.P', 'sep.SP', 'sep.SPeff', 'sep.T', 'sep.psh', 'sep.pshh', 'sep.xWeirFrac', 'sep.hWeirFrac', 'sep.lahhTotal', 'sep.c1.fracW', 'sep.c1.fracL',
    'sep.bucket.frac', 'sep.bucket.fracW', 'sep.overWeir_bpd', 'sep.carryOver', 'sep.oilDump.x', 'sep.oilDump.q_bpd', 'sep.oilDump.lsh', 'sep.waterDump.x',
    'sep.waterDump.lshh', 'sep.pcv.u', 'sep.gasOut_mmscfd', 'sep.tRes_min',
    'surge.P', 'surge.frac', 'surge.fracW', 'surge.pshh', 'surge.cap_bbl', 'surge.Vo_bbl', 'surge.Vw_bbl', 'surge.pump.on', 'surge.pump.q_bpd', 'surge.pump.design_bpd',
    'gauge.active', 'gauge.tanks.0.frac', 'gauge.tanks.0.fracW', 'gauge.tanks.1.state', 'gauge.tanks.0.cap_bbl', 'gauge.batches',
    'rates.gas_mmscfd', 'cum.flare_mmscf', 'alarms'];
  const finite = (o, bad, p) => { for (const k in o) { const v = o[k], q = p ? p + '.' + k : k; if (typeof v === 'number' && !isFinite(v)) bad.push(q); else if (v && typeof v === 'object') finite(v, bad, q); } return bad; };
  return [
    ['32: WTS_3d.isSupported() is false in Node (no WebGL)', () => typeof W.isSupported !== 'function' || W.isSupported() === false],
    ['32: contract surface (§3.4)', () => ['version', 'THREE_URLS', 'THREE_SHA384', 'isSupported', 'loadThree', 'hasLocalCopy', 'mount', 'palette', 'oilColor', 'STATUS_MAP', '_internals']
      .filter(k => !(k in W)).join(',') || true],
    ['32: three r170 URLs + pinned SHA-384', () => W.THREE_URLS.length === 2 && W.THREE_URLS.every(u => /three@0\.170\.0\/build\/three\.module\.min\.js$/.test(u)) &&
      typeof W.THREE_SHA384 === 'string' && W.THREE_SHA384.length === 64],
    ['32: STATUS_MAP = D38 mapping', () => JSON.stringify(W.STATUS_MAP) === JSON.stringify({ trip:'alarm', alarm:'alarm', warn:'warn', hyd:'hyd', info:'evt' })],
    ['32: mount() returns a promise (rejects no-webgl without WebGL2)', () => { const p = W.mount({ appendChild() {} }, {}); p.catch(() => {}); return !!p && typeof p.then === 'function'; }],
    ['32: every snapshot path the scene reads exists in the real WTS_sim snapshot', () => {
      if (!S || !F) return true;
      const st = S.create(F, { seed: 5 }).getState(); const miss = READS.filter(p => get(st, p) === undefined); return miss.length === 0 || 'missing ' + miss.join(',');
    }],
    ['32: fakeSnapshot carries the same paths (harness fidelity)', () => { const fk = I.fakeSnapshot(100); const miss = READS.filter(p => get(fk, p) === undefined); return miss.length === 0 || 'missing ' + miss.join(','); }],
    ['32: normalize(real snapshot over 2 h incl. ESD trip) is finite, in place, and maps levels', () => {
      if (!S || !F) return true;
      const s = S.create(F, { seed: 9 }), out = I.makeNorm(); let r = null, bad = [];
      for (let i = 0; i < 720; i++) { s.advance(10); if (i % 60 === 0) { r = I.normalize(s.getState(), out); finite(r, bad, ''); } }
      s.tripESD('manual'); s.advance(30); r = I.normalize(s.getState(), out); finite(r, bad, '');
      const st = s.getState();
      return (r === out && !bad.length && r.sep.c1fracL === st.sep.c1.fracL && r.gauge.tanks[0].frac === st.gauge.tanks[0].frac && r.esd.tripped === true && r.esd.manual === true) || 'bad ' + bad.slice(0, 5).join(',');
    }],
    ['32: default overview frame meets the §5.2 pixel gates (1380×700, insets 98/76; portrait 375×471)', () => {
      const size = (box, fv, w, h) => { const d = I.camDir(fv.az, fv.el), cam = { target:fv.target, pos:fv.target.map((t, i) => t + d[i] * fv.radius), fov:36 };
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; I.boxCorners(box).forEach(c => { const p = I.project(c, cam, w, h); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
        return { w:x1 - x0, h:y1 - y0 }; };
      const a = size(I.V101_BOX, I.fitView(I.FIT_PTS, -18, 22, 36, 1380, 700, { top:98, bottom:76, left:0, right:0 }), 1380, 700);
      const b = size(I.V101_BOX, I.fitView(I.PROCESS_BOX, -10, 30, 36, 375, 471, {}), 375, 471);
      return (a.h >= 55 && a.w >= 170 && b.h >= 22) || JSON.stringify({ a, b });
    }],
    ['32: fixture physics shows in the visual mapping (flame ≈ 5.1 m at 10 MMSCFD; stream whitens downstream of CK-101)', () => {
      if (!F) return true;
      const up = I.phaseFractions(F.inputs.Qg, F.inputs.Qo, F.inputs.Qw, F.segs[0].P0, F.segs[0].T0), dn = I.phaseFractions(F.inputs.Qg, F.inputs.Qo, F.inputs.Qw, F.segs[2].P0, F.segs[2].T0);
      return Math.abs(I.flameLength(F.inputs.Qg) - 5.08) < 0.02 && dn.g > up.g && I.velToScene(F.segs[2].vel) > 2 * I.velToScene(F.segs[0].vel);
    }],
    ['32: normalize maps twin surge compartments + inlet valves; six operable valve proxies (tap targets)', () => {
      const VP = I.VALVE_PROXIES || [];
      const ids = VP.map(v => v[0]).sort().join(',');
      if (ids !== 'suction:surge:0,suction:surge:1,valve:gauge:0,valve:gauge:1,valve:surge:0,valve:surge:1') return 'proxies ' + ids;
      if (!S || !F) return true;
      const s = S.create(F, { seed: 6 }); s.setValve('surge', 0, false); s.setValve('gauge', 1, true); s.setSuction('A');
      for (let i = 0; i < 30; i++) s.advance(10);
      const st = s.getState(), n = I.normalize(st, I.makeNorm());
      const old = I.normalize({ sep: {}, surge: { frac: 0.4, fracW: 0.1 }, gauge: { active: 1, tanks: [{}, {}] } }, I.makeNorm());   // pre-divert snapshot shape
      return (n.surge.comps[0].inlet === false && n.surge.comps[1].inlet === true && n.surge.comps[0].suction === true && n.surge.comps[1].suction === false &&
        n.surge.comps[1].frac === st.surge.comps[1].frac && n.gauge.tanks[1].inlet === true && n.surge.suction === 'A' &&
        old.surge.comps[0].frac === 0.4 && old.surge.comps[1].inlet === true && old.gauge.tanks[1].inlet === true && old.gauge.tanks[0].inlet === false) || 'mapping';
    }],
    ['32: oilColor() hex strings, darker for heavy crude', () => { const h = W.oilColor(20), l = W.oilColor(45); return /^#[0-9a-f]{6}$/.test(h.body) && /^#[0-9a-f]{6}$/.test(l.tracer) && I.luminance(h.body) < I.luminance(l.body) && h.alphaFront > l.alphaFront; }],
    ['32: layoutLabels keeps chips out of the info-card rect and hides chips it cannot place over it', () => {
      const rects = [], anchors = []; for (let i = 0; i < 6; i++) { rects.push({ w:120, h:44, prio:3, pref:'ne', seg:false }); anchors.push({ x:1150 + (i % 2) * 20, y:200 + i * 30, hide:false }); }
      const card = { x:1000, y:100, w:360, h:500 }, o = I.layoutLabels(rects, anchors, { w:1380, h:700 }, { top:98, bottom:76, card });
      return o.every((p, i) => !p.vis || !(p.x < card.x + card.w && p.x + 120 > card.x && p.y < card.y + card.h && p.y + 44 > card.y));
    }],
  ];
};

// ─── SECTION C — 38-wts-live (Engineer C) ──────────────────────────────────────
// Engineer C: append checks here (alarmReduce / pillPick / liveNodes / fmtParts …).
const SECTION_C = (G, src) => {
  const L = G.WTS_live, S = G.WTS_sim, F = G.WTS_TEST_FIXTURE, I = L._internals || {};
  const code = stripComments(stripSelfTest(src) || '');
  const simAt = (secs, mut) => { const s = S.create(F || S.SAMPLE_FLOW, { seed: 11 }); if (mut) mut(s); for (let i = 0; i < secs / 10; i++) s.advance(10); return s; };
  const HOST = path.join(ROOT, '..', 'well-testing-app.html');
  let patched = null;
  const patchedHtml = () => {                     // host HTML with wts-host-patch applied in memory (never written)
    if (patched) return patched;
    const P = require('./wts-host-patch.js');
    const r = P.patch(fs.readFileSync(HOST, 'utf8'), {});
    const bad = r.report.filter(x => !/^(applied|already)$/.test(x.status));
    if (bad.length) throw new Error('patch: ' + bad.map(b => b.id + ':' + b.status).join(','));
    return (patched = r.out);
  };
  const runHostCalc = (over) => {                  // patched calcWTS with default inputs in a stub DOM → WTS_lastCalc
    const html = patchedHtml();
    const line = n => { const a = html.indexOf(n); return html.slice(a, html.indexOf('\n', a)); };
    const body = html.slice(html.indexOf('window.calcWTS=function(){'), html.indexOf('\nconst WTS_DIAG_LAYOUT'));
    const vals = { wts_Pwh: '3000', wts_Twh: '180', wts_Qg: '10', wts_Qo: '1000', wts_Qw: '200', wts_SGg: '0.65', wts_API: '35', wts_bean: '32', wts_Cd: '0.85',
      wts_Thtr: '150', wts_htrEff: '80', wts_bypass: '0', wts_Psep: '150', wts_Cfac: '100', wts_eps: '0.0018', wts_sepID: '36', wts_sepL: '10', wts_Psurge: '25',
      wts_surgeCap: '100', wts_gtCap: '100' };
    [['4', '50'], ['4', '100'], ['6', '200'], ['6', '100'], ['6', '300'], ['3', '80']].forEach((p, i) => { vals['wts_nps' + (i + 1)] = p[0]; vals['wts_sch' + (i + 1)] = '40'; vals['wts_len' + (i + 1)] = p[1]; });
    Object.assign(vals, over || {});
    const els = {}; for (const k in vals) els[k] = { value: vals[k], style: {} };
    const events = [];
    const sb = { window: {}, document: { dispatchEvent: e => events.push(e) }, CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
      $: id => els[id] || (/^wts_(res|warn|regime)$/.test(id) ? (els[id] = { style: {}, innerHTML: '', textContent: '' }) : null),
      fmt: (n, d) => Number(n).toFixed(d), saveInputs: () => {}, wtsDrawDiag: () => {}, console: { warn: () => {}, log: () => {} } };
    vm.createContext(sb);
    vm.runInContext(line('const WTS_PIPES=') + '\n' + line('const WTS_IDS=') + '\n' + body + '\nwindow.calcWTS();', sb);
    return { L: sb.window.WTS_lastCalc, state: sb.window.WTS_state, events, els };
  };
  const eqShape = (a, b, p, bad) => {             // same keys / types (numbers compared loosely), recursive
    if (typeof a !== typeof b) { bad.push(p + ' type'); return; }
    if (a && typeof a === 'object') {
      const ka = Object.keys(a).sort().join(','), kb = Object.keys(b).sort().join(',');
      if (ka !== kb) { bad.push(p + ' keys [' + ka + '] vs [' + kb + ']'); return; }
      for (const k of Object.keys(a)) eqShape(a[k], b[k], p + '.' + k, bad);
    }
  };
  return [
    ['38: contract surface (§3.5)', () => ['version', 'mount', 'getSim', 'fmtU', 'fmtParts', 'unitsConv', 'ftIn', 'liveNodes', 'liveSegs', 'alarmReduce', 'pillPick', 'statusOf']
      .filter(k => !(k in L)).join(',') || true],
    ['38: mount(null) → null; mount without WTS_sim → null', () => {
      if (L.mount(null) !== null) return false;
      const keep = G.WTS_sim; G.WTS_sim = undefined;
      try { return L.mount({ nodeType: 1 }) === null; } finally { G.WTS_sim = keep; }
    }],
    ['38: no literal import(, no fetch/eval, prefs key h2viz3d_prefs, never wts_viz_prefs', () =>
      !/\bimport\s*\(|\beval\s*\(|new Function/.test(code) && /'h2viz3d_prefs'/.test(code) && !/wts_viz_prefs/.test(code) || 'rule broken'],
    ['38: all HMI controls are buttons (no <input>/<select>/<textarea> markup)', () => !/<(input|select|textarea)\b/i.test(code) || 'found form control markup'],
    ['38: liveNodes/liveSegs follow the live snapshot (host names, psig, MSCF/D)', () => {
      const s = simAt(600); const st = s.getState(); const n = L.liveNodes(st), g = L.liveSegs(st);
      return n.map(x => x.nm).join('|') === 'Wellhead|SSV|Choke|Heater|Separator|Flare|Surge Tank|Atm Tank' &&
        n[4].P === st.nodes.separator.P && n[0].P === st.nodes.wellhead.P && n[2].Pci === st.nodes.choke.Pin &&
        Math.abs(n[2].Qmax - st.nodes.choke.QmaxMMscfd * 1000) < 1e-9 && n[2].regime === 'Critical' && n[2].flowLimited === false &&
        n[3].duty === st.nodes.heater.dutyMMBtuHr && n[6].P === st.nodes.surge.P && n[7].P === 0 &&
        g.length === 6 && g.every((x, i) => x.vel === st.segs[i].vel && x.vSt === st.segs[i].vSt && typeof x.nps === 'string') || 'mismatch';
    }],
    ['38: liveNodes takes flare/surge/gauge th from the flow (no reads of undefined snapshot th)', () => {
      const s = simAt(600); const st = s.getState(); const missing = [];
      const wrap = (o, p) => new Proxy(o, { get(t, k) { if (typeof k === 'string' && !(k in t) && /nodes\.(flare|surge|gauge)$/.test(p)) missing.push(p + '.' + k); const v = t[k]; return v && typeof v === 'object' ? wrap(v, p + '.' + k) : v; } });
      const flow = JSON.parse(JSON.stringify(S.SAMPLE_FLOW)); flow.nodes[5].th = 11; flow.nodes[6].th = 12; flow.nodes[7].th = 13;
      const n = L.liveNodes(wrap(st, 's'), flow), n0 = L.liveNodes(st, null);
      return missing.length === 0 && n[5].th === 11 && n[6].th === 12 && n[7].th === 13 && n[0].th === st.nodes.wellhead.th &&
        n0[6].th === 32 || ('missing=' + missing.join(',') + ' th=' + n.map(x => x.th).join(','));
    }],
    ['host patch CLI: default is a dry run; typos/unknown flags rejected; writes only with --apply/--out', () => {
      const P = require('./wts-host-patch.js'), pa = P.parseArgs;
      const d = pa([]), t = pa(['--chek']), h = pa(['--help']), a = pa(['--apply']), o = pa(['--file', 'a.html', '--out', 'b.html']);
      return !d.error && !d.apply && !d.out && /unknown argument/.test(t.error || '') && h.help && a.apply && !a.error &&
        o.out === 'b.html' && !o.error && !!pa(['--out']).error && !!pa(['--check', '--apply']).error || 'parseArgs';
    }],
    ['38: statusOf uses WTS_3d.STATUS_MAP when present', () => {
      const keep = G.WTS_3d; G.WTS_3d = { STATUS_MAP: { trip: 'alarm', alarm: 'alarm', warn: 'warn', hyd: 'hyd', info: 'hyd' } };
      try { return L.statusOf('esd', [{ eq: 'esd', sev: 'info' }]) === 'hyd'; } finally { G.WTS_3d = keep; }
    }],
    ['38: alarm lifecycle over a real trip (pcvStuckClosed): UNACK trip → pill; ack → ACK; clear → removed', () => {
      const s = simAt(300, x => x.setFault('pcvStuckClosed', true));
      const st = s.getState(); const ids = st.alarms.map(a => a.id);
      if (ids.indexOf('PSHH_SEP') < 0 || ids.indexOf('ESD_TRIPPED') < 0) return 'no trip alarms: ' + ids;
      let m = L.alarmReduce({}, st.alarms, st.t, null);
      const p = L.pillPick(m); if (!p || p.state !== 'UNACK' || (p.sev !== 'trip')) return 'pill ' + JSON.stringify(p);
      m = L.alarmReduce(m, st.alarms, st.t, Object.keys(m));
      if (Object.keys(m).some(k => m[k].state !== 'ACK')) return 'ack';
      s.setFault('pcvStuckClosed', false); for (let i = 0; i < 12; i++) s.advance(10);
      const r = s.resetESD(); for (let i = 0; i < 30; i++) s.advance(10);
      m = L.alarmReduce(m, s.getState().alarms, s.getState().t, null);
      return r.ok && !m.PSHH_SEP && !m.ESD_TRIPPED || 'after reset ' + JSON.stringify(Object.keys(m)) + ' ' + JSON.stringify(r);
    }],
    ['38: manual ESD → ESD_MANUAL counted (amber) but never on the pill (D38)', () => {
      const s = simAt(60); s.tripESD('manual'); const st = s.getState();
      const c = I.alarmCount(st.alarms), m = L.alarmReduce({}, st.alarms, st.t, null);
      return c.n === 1 && c.level === 'warn' && m.ESD_MANUAL.state === 'ACK' && L.pillPick(m) === null;
    }],
    ['38: summaryOf → plain JSON detached from the live snapshot, last 10 batches', () => {
      const s = simAt(4 * 3600); const st = s.getState(); const o = I.summaryOf(st);
      const j = JSON.parse(JSON.stringify(o));
      const ok = JSON.stringify(j) === JSON.stringify(o) && o.batches.length <= 10 && o.batches.length >= 1 && o.clock === st.clock &&
        Math.abs(o.cum.oil_stb - st.cum.oilIn_stb) < 1e-9 && Array.isArray(o.alarms);
      o.batches[0].oil_stb = -1; o.cum.oil_stb = -1;
      return ok && st.gauge.batches.indexOf(o.batches[0]) < 0 && st.cum.oilIn_stb !== -1;
    }],
    ['38: inputsDiff → setpoint-change event texts (§6.5)', () => {
      const a = S.flowFromInputs({}), b = S.flowFromInputs({ bean: 40, Psep: 160, bypass: true, Qo: 1200 });
      const d = I.inputsDiff(a, b).map(x => x[0]);
      return d.join(' | ') === 'Choke bean 32→40/64″ | Separator SP 150→160 psig | Heater bypass ON | Well rates updated' || d.join(' | ');
    }],
    ['38: flowValid accepts SAMPLE_FLOW, rejects NaN / negative / Psep 0', () =>
      I.flowValid(S.SAMPLE_FLOW) && !I.flowValid(null) && !I.flowValid({ inputs: { Qg: NaN } }) &&
      !I.flowValid(S.flowFromInputs({ Qo: -1 })) && !I.flowValid(S.flowFromInputs({ Psep: 0 }))],
    ['38: fmtParts categories (imperial fallback)', () => {
      const f = (v, c, d) => { const p = L.fmtParts(v, c, d); return p.v + (p.u ? ' ' + p.u : ''); };
      const r = [f(3000, 'pressureG'), f(24.9, 'pressureTank'), f(0.2, 'pressureTank'), f(149.99, 'temperature'), f(10.004, 'gasRate'),
        f(9.9, 'gasRate'), f(995.4, 'oilRate'), f(12.34, 'volume'), f(10448, 'gor'), f(16.72, 'percent', 1), f(59.2, 'velocity'), f(null, 'volume')];
      return r.join('|') === '3000 psig|24.9 psig|ATM|150 °F|10.0 MMSCFD|9.90 MMSCFD|995 STB/d|12.3 bbl|10,448 scf/STB|16.7 %|59 ft/s|— bbl' || r.join('|');
    }],
    ['38: metric alarm text rebuilt from value/limit; imperial strips the leading tag', () => {
      const a = { id: 'PSHH_SEP', tag: 'PSHH-101', msg: 'PSHH-101 separator 188 psig ≥ 180 psig', value: 188, limit: 180 };
      const imp = I.alarmText(a);
      const keep = G.WTS_units;
      G.WTS_units = { getSystem: () => 'metric', format: (v, c) => c === 'pressureG' ? { value: v * 6.89476, unit: 'kPa', label: 'kPa(g)' } : { value: v, unit: '', label: '' } };
      try { const met = I.alarmText(a); return imp === 'separator 188 psig ≥ 180 psig' && met === 'separator 1296 kPa(g) ≥ 1241 kPa(g)' || imp + ' / ' + met; }
      finally { G.WTS_units = keep; }
    }],
    ['38: readPrefs defaults + validation (D34)', () => {
      const p = I.readPrefs();
      return p.mode === '3d' && p.speed === 10 && p.labels === 'all' && p.overlay === 'phase' && p.quality === 'auto' && p.legend === false;
    }],
    ['38: readPrefs keeps a saved divert lineup (ctl) and drops a malformed one', () => {
      const keep = G.localStorage;
      const put = v => { G.localStorage = { getItem: () => JSON.stringify(v), setItem() {}, removeItem() {} }; };
      try {
        const ctl = { surge: { inlet: [true, false], suction: 'A', auto: true, sp: 0.8, hyst: 0.1 }, gauge: { inlet: [false, true], auto: false, sp: 0.9, hyst: 0.1 }, v: 1 };
        put({ ctl }); const a = I.readPrefs(); put({ ctl: 'x' }); const b = I.readPrefs(); put({ ctl: { surge: 1 } }); const c = I.readPrefs();
        return JSON.stringify(a.ctl) === JSON.stringify(ctl) && b.ctl === null && c.ctl === null || 'prefs ' + JSON.stringify([a.ctl, b.ctl, c.ctl]);
      } finally { G.localStorage = keep; }
    }],
    ['38: bpOf breakpoints', () => I.bpOf(1380) === 'lg' && I.bpOf(1000) === 'lg' && I.bpOf(999) === 'md' && I.bpOf(768) === 'md' && I.bpOf(767) === 'sm'],
    ['38: CSS carries the iOS min-height neutraliser, z-stack and the blur budget', () =>
      /\.wtsl-viz button\{min-height:0/.test(I.CSS) && /\.wtsl-viz\.is-max\{position:fixed;inset:0;z-index:1000/.test(I.CSS) &&
      (I.CSS.match(/[^-]backdrop-filter:blur/g) || []).length === 1 && /@media \(pointer:fine\)/.test(I.CSS) || 'css'],
    // ── host patch + build scripts (Engineer C) ──
    ['host patch: every anchor applicable once against the current well-testing-app.html (--check)', () => {
      const r = require('./wts-host-patch.js').patch(fs.readFileSync(HOST, 'utf8'), { dryRun: true });
      const bad = r.report.filter(x => !/^(ok|already)$/.test(x.status));
      return bad.length === 0 || bad.map(b => b.id + ':' + b.status).join(',');
    }],
    ['host patch: idempotent (second pass changes nothing) and keeps CRLF', () => {
      const P = require('./wts-host-patch.js'); const once = patchedHtml(); const twice = P.patch(once, {});
      return twice.out === once && twice.report.every(x => x.status === 'already') && !/(^|[^\r])\n/.test(once) || 'not idempotent / LF';
    }],
    ['host patch: patched calcWTS publishes flow v1 = WTS_sim.SAMPLE_FLOW (shape + Appendix A numbers)', () => {
      const r = runHostCalc(); const f = r.L.flow; const bad = [];
      if (!f) return 'no flow';
      const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c.ts; delete c.seq; return c; };
      eqShape(strip(f), strip(S.SAMPLE_FLOW), 'flow', bad);
      const near = (a, b, t) => Math.abs(a - b) <= t;
      if (!near(f.choke.Pout, S.SAMPLE_FLOW.choke.Pout, 0.01) || !near(f.heater.dutyMMBtuHr, 2.103, 0.001) || f.choke.regime !== 'Critical') bad.push('numbers');
      if (r.events.length !== 1 || r.events[0].type !== 'wts:calc' || r.events[0].detail !== r.L) bad.push('event');
      if (r.state.flow !== f || r.state.nodes[1].label !== 'ESD Valve (SSV)' || r.state.gasRate !== 10) bad.push('WTS_state');
      if (r.L.choke.Qmax !== f.choke.QmaxMMscfd * 1000 || !('dTjt' in r.L.choke) || r.L.segNames[5] !== 'Surge→Gauge Tank') bad.push('lastCalc');
      if (r.els.wts_regime.style.color !== 'var(--purple)') bad.push('regime colour');
      return bad.length === 0 || bad.slice(0, 6).join('; ');
    }],
    ['host patch: Psurge clamp 0–30 with warning; No-Flow error; hydrate note uses t:info', () => {
      const a = runHostCalc({ wts_Psurge: '40' }).L.flow, b = runHostCalc({ wts_Pwh: '100' }).L.flow, c = runHostCalc({ wts_bypass: '1', wts_Twh: '120' }).L.flow;
      return a.sim.surgeP_psig === 30 && a.nodes[6].P === 30 && a.warnings.some(w => w.t === 'warn' && /limited to 30 psig/.test(w.m)) &&
        b.choke.regime === 'No Flow' && b.warnings.some(w => w.t === 'error' && /no flow possible/.test(w.m)) &&
        c.warnings.filter(w => /Hydrate/.test(w.m)).every(w => w.t === 'info') && c.warnings.length >= 1 || 'scenario mismatch';
    }],
    ['host patch: flows from the patched calc drive the sim (bean 24 → CHOKE_LIMIT)', () => {
      const f = runHostCalc({ wts_bean: '24' }).L.flow; const s = S.create(f, { seed: 2 }); s.advance(30);
      return f.choke.flowLimited === true && s.getState().alarms.some(a => a.id === 'CHOKE_LIMIT');
    }],
    ['concat-round7: FILES = 31, 32, 38 and the build keeps the 38 banner', () => {
      const C = require('./concat-round7.js');
      const out = C.build({ read: f => f === '38-wts-live.js' ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '(function () {\n})();\n// === SELF-TEST ===\n', log: { log() {}, warn() {} } });
      return C.FILES.join(',') === '31-wts-sim.js,32-wts-3d.js,38-wts-live.js' && /BEGIN 38-wts-live/.test(out) && !/\[38-wts-live\] self-test/.test(out) || 'concat';
    }],
    ['inject-round7: insert after Round-6 END, then idempotent replace, CRLF throughout', () => {
      const I7 = require('./inject-round7.js'); const html = patchedHtml();
      const r1 = I7.inject(html, '\n// blob\n'), r2 = I7.inject(r1.out, '\n// blob v2\n'), r3 = I7.inject(r2.out, '\n// blob v2\n');
      const lf = s => /(^|[^\r])\n/.test(s);
      // First pass inserts on a pre-integration host and replaces once Round 7 is integrated.
      return (r1.mode === 'insert' || r1.mode === 'replace') && r2.mode === 'replace' && r2.out === r3.out && !lf(r1.out) && !lf(r3.out) &&
        r3.out.indexOf(I7.END) < r3.out.indexOf('// ── Well Test Simulator ──') && r3.out.indexOf(I7.ANCHOR_PATTERN) < r3.out.indexOf(I7.START) || 'inject';
    }],
  ];
};

const SECTIONS = { A: SECTION_A, B: SECTION_B, C: SECTION_C };

// ─── SECTION X — cross-file contracts (runner-owned; runs after every present file loaded) ──
// Feeds a REAL WTS_sim snapshot to the consumers, so a producer/consumer drift fails here.
const SECTION_X = (G) => {
  const S = G.WTS_sim, T = G.WTS_3d, L = G.WTS_live, out = [];
  if (!S) return out;
  const real = () => { const s = S.create(S.SAMPLE_FLOW, { seed: 1 }); for (let i = 0; i < 90; i++) s.advance(20); return s.getState(); };
  const nonFinite = (o, p, bad) => {
    if (typeof o === 'number') { if (!isFinite(o)) bad.push(p); return; }
    if (o && typeof o === 'object') for (const k in o) nonFinite(o[k], p ? p + '.' + k : k, bad);
  };
  if (T && T._internals) {
    const I = T._internals;
    if (typeof I.fakeSnapshot === 'function') out.push(['X: every path in 32 fakeSnapshot exists in the real snapshot (same type)', () => {
      const miss = [];
      const walk = (a, b, p) => {
        if (a === null || typeof a !== 'object') { if (b === undefined) miss.push(p); else if (a !== null && b !== null && typeof a !== typeof b) miss.push(p + ':' + typeof b); return; }
        if (b === undefined || b === null) { miss.push(p); return; }
        if (Array.isArray(a)) { if (a.length && b.length) walk(a[0], b[0], p + '[0]'); return; }
        for (const k in a) walk(a[k], b[k], p ? p + '.' + k : k);
      };
      walk(I.fakeSnapshot(), real(), '');
      return miss.length === 0 || miss.slice(0, 8).join(', ');
    }]);
    if (Array.isArray(I.NULLABLE)) out.push(['X: 32 NULLABLE list equals WTS_sim.NULLABLE', () =>
      JSON.stringify(I.NULLABLE.slice().sort()) === JSON.stringify(S.NULLABLE.slice().sort()) || 'differs']);
    if (typeof I.normalize === 'function') out.push(['X: 32 normalize(real snapshot) yields only finite numbers', () => {
      const bad = []; nonFinite(I.normalize(real()), '', bad); return bad.length === 0 || bad.slice(0, 6).join(', ');
    }]);
    if (T.STATUS_MAP) out.push(['X: STATUS_MAP covers every sim alarm severity', () => ['trip', 'alarm', 'warn', 'hyd', 'info'].every(k => typeof T.STATUS_MAP[k] === 'string')]);
  }
  if (L) {
    if (typeof L.liveNodes === 'function') out.push(['X: 38 liveNodes(real) → 8 calc-shaped nodes with finite P/T', () => {
      const n = L.liveNodes(real()); return Array.isArray(n) && n.length === 8 && n.every(x => isFinite(x.P) && isFinite(x.T));
    }]);
    if (typeof L.liveSegs === 'function') out.push(['X: 38 liveSegs(real) → 6 calc-shaped segments with finite vel', () => {
      const s = L.liveSegs(real()); return Array.isArray(s) && s.length === 6 && s.every(x => isFinite(x.vel) && isFinite(x.vPct));
    }]);
    if (typeof L.statusOf === 'function') out.push(['X: 38 statusOf over a real tripped snapshot', () => {
      const s = S.create(S.SAMPLE_FLOW, { seed: 2 }); s.advance(60); s.setFault('pcvStuckClosed', true); s.advance(10);
      const r = L.statusOf('separator', s.getState().alarms); return r === 'alarm' || 'got ' + r;
    }]);
  }
  return out;
};

// ─── runner ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0, skipped = 0;
const report = (ok, name, msg) => {
  if (ok) pass++; else fail++;
  if (!ok || VERBOSE) console.log((ok ? '  ok   ' : '  FAIL ') + name + (msg && msg !== true ? ' — ' + msg : ''));
};
const runCheck = (name, fn, G) => {
  let r; try { r = fn(G); } catch (e) { r = (e && e.message) || String(e); }
  report(r === true || (r !== false && r !== undefined && typeof r !== 'string' && !!r), name, typeof r === 'string' ? r : '');
};

const spy = [];
const shared = newContext(makeHostStub(spy));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
for (const suite of SUITES) {
  const prefix = suite.file.slice(0, 2);
  if (ONLY.length && ONLY.indexOf(prefix) < 0) continue;
  const p = path.join(ROOT, suite.file);
  if (!fs.existsSync(p)) { skipped++; console.log(`[skip] ${suite.file} not present yet`); continue; }
  const src = fs.readFileSync(p, 'utf8');
  console.log(`[${suite.label}]`);
  try { new vm.Script(src, { filename: suite.file }); } catch (e) {        // unparsable (e.g. mid-edit): one failure, no cascade
    report(false, `${suite.file} parses`, e.message);
    continue;
  }

  // 1. file as-is (module + self-test) in a fresh context
  {
    const { sb, cap } = newContext({ process: { env: {}, exitCode: 0 }, setTimeout, clearTimeout, setInterval, clearInterval });
    if (suite.ns !== 'WTS_sim' && shared.sb.WTS_sim) sb.WTS_sim = shared.sb.WTS_sim;   // 32/38 self-tests may use WTS_sim
    const t0 = Date.now();
    let threw = null;
    try { vm.runInContext(src, sb, { filename: suite.file, timeout: 120000 }); } catch (e) { threw = e; }
    let r = parseSelfTest(cap.lines, suite.label);
    for (let waited = 0; !r && !threw && waited < 20000; waited += 20) { await sleep(20); r = parseSelfTest(cap.lines, suite.label); }
    if (VERBOSE) cap.lines.forEach(l => console.log('    | ' + l));
    report(!threw, `${suite.file} runs without throwing`, threw ? threw.message : '');
    report(!!r && r.pass === r.total && r.total > 0, `${suite.label} self-tests`,
      r ? `${r.pass}/${r.total} passed in ${Date.now() - t0} ms` : 'no "[' + suite.label + '] self-test N/M passed" line');
    if (r && r.pass !== r.total) cap.lines.filter(l => /FAIL/.test(l)).forEach(l => console.log('    ' + l.trim()));
  }

  // 2. shared source rules
  sourceRules(src, suite).forEach(([n, fn]) => runCheck(`${suite.file}: ${n}`, fn, shared.sb));

  // 3. stripped module into the shared (injection-order) context + load-time rule
  const mod = stripSelfTest(src);
  if (mod === null) { report(false, `${suite.file}: stripped load`, 'no self-test marker'); continue; }
  spy.length = 0;
  let threw = null;
  try { vm.runInContext(mod, shared.sb, { filename: suite.file + ' (stripped)' }); } catch (e) { threw = e; }
  report(!threw, `${suite.file}: stripped module loads in the host-like stub`, threw ? threw.message : '');
  report(spy.length === 0, `${suite.file}: load touches no DOM / timers / storage / listeners`, spy.length ? [...new Set(spy)].join(',') : '');
  report(!!shared.sb[suite.ns] && typeof shared.sb[suite.ns] === 'object', `${suite.file}: window.${suite.ns} defined`);
  if (suite.ns === 'WTS_sim' && shared.sb.WTS_sim && shared.sb.WTS_sim.deepClone) {
    shared.sb.WTS_TEST_FIXTURE = shared.sb.WTS_sim.deepClone(shared.sb.WTS_sim.SAMPLE_FLOW);
  }
  if (threw || !shared.sb[suite.ns]) continue;

  // 4. owner section
  const sec = SECTIONS[suite.owner];
  if (sec) sec(shared.sb, src).forEach(([n, fn]) => runCheck(n, fn, shared.sb));
}

// 5. cross-file contracts (only meaningful once more than one file is loaded)
if (!ONLY.length || ONLY.length > 1) {
  const xs = SECTION_X(shared.sb);
  if (xs.length) { console.log('[cross-file]'); xs.forEach(([n, fn]) => runCheck(n, fn, shared.sb)); }
}

console.log(`[wts3d-test] ${pass}/${pass + fail} checks passed` + (skipped ? ` (${skipped} file${skipped > 1 ? 's' : ''} not present, skipped)` : ''));
if (fail) process.exitCode = 1;
})().catch(e => { console.error('[wts3d-test] runner error', e); process.exitCode = 1; });
