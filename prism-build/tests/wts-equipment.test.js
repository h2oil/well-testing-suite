// Well Test Simulator equipment — DS-101 cyclonic desander and T-202 second surge tank (docs/SIM-EQUIPMENT-PLAN.md).
// WP0 part: the test harness rebuilds Round 7 (31-wts-sim, 32-wts-3d, 38-wts-live) in memory, the frozen v3.3 engine
// (tests/_wts-sim-v33.js) and the contract fixture (tests/_wts-equip-shapes.js) are sound, and the frozen engine and the
// working engine agree exactly on the unchanged tree. WP-E0 / the lead extend this file (§9.2: rig-up defaults, full identity
// scenarios a–e, contract vs the real snapshot, 38 persistence round trips).
// Expected values are plan constants (§3, §6), the v3.3 engine itself (identity) or exact string equality of build outputs.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const X = require('./_wts-equip-shapes');
// the SIM-FOLLOWUP contract (v1.5.0, CK-102 appended): the working engine's rig-up keys, defaults and node order (§3.6)
const FU = require('./_wts-fu-shapes');
// v1.6.0 changed the T-201 default line-up; identity runs pin the v3.3.1 one on the working engine (_wts-lineup-pin.js)
const { legacyOpts } = require('./_wts-lineup-pin.js');

const WP = 'WTSEQ';
const BUILD_DIR = path.resolve(__dirname, '..');
const R7_FILES = ['31-wts-sim.js', '32-wts-3d.js', '38-wts-live.js'];

// a rig-up signature derived from the module's RIG_KEYS / RIG_DEFAULTS (§3.6: no hard-coded length)
const sigOf = (S, on) => S.RIG_KEYS.map((k) => ((on && k in on) ? on[k] : S.RIG_DEFAULTS[k]) ? '1' : '0').join('');
const quietLog = { log() {}, warn() {} };
function strip31(src) { return require(path.join(BUILD_DIR, 'concat-round7.js')).stripSelfTest(src, '31-wts-sim.js', quietLog); }

// Probe: the working 31 with only its VERSION string replaced (meaningful before WP-E0 bumps VERSION to 1.4.0).
function probeSource() {
  const src = fs.readFileSync(path.join(BUILD_DIR, '31-wts-sim.js'), 'utf8');
  const re = /(\n\s*VERSION:\s*)'[^']*'/;
  if (!re.test(src)) throw new Error('31-wts-sim.js: no VERSION: \'…\' line to probe');
  return src.replace(re, "$1'" + X.PROBE_VERSION + "'");
}
const PROBE_SRC = probeSource();

// The Round-7 file bodies as embedded in a built HTML (between the concat-round7 banner and footer of each file).
function round7Bodies(html) {
  const i7 = require(path.join(BUILD_DIR, 'inject-round7.js'));
  const s = html.indexOf(i7.START), e = html.indexOf(i7.END, s);
  if (s < 0 || e < 0) throw new Error('no Round-7 block in the HTML');
  const blk = html.slice(s, e).replace(/\r\n/g, '\n');
  const out = {};
  R7_FILES.forEach((f) => {
    const label = f.replace(/\.js$/, '');
    const b0 = blk.indexOf('// ─── BEGIN ' + label + ' ');
    if (b0 < 0) throw new Error('Round-7 block has no BEGIN ' + label);
    const bodyStart = blk.indexOf('\n', blk.indexOf('\n', b0) + 1) + 1;       // after the BEGIN line and the ═ rule
    const f0 = blk.indexOf('\n// ─── END ' + label + ' ', bodyStart);
    if (f0 < 0) throw new Error('Round-7 block has no END ' + label);
    out[f] = blk.slice(bodyStart, f0);
  });
  return out;
}

function runStates(S, secs, dt, every, setup, flow, opts) {
  // the working engine (it exports SURGE_LINEUP) runs with the v3.3.1 T-201 line-up pinned; the frozen engines ignore the pin
  const sim = S.create(flow || S.SAMPLE_FLOW, Object.assign({ seed: 7 }, S.SURGE_LINEUP ? legacyOpts(opts) : (opts || {})));
  if (setup) setup(sim);
  const states = [JSON.parse(JSON.stringify(sim.getState()))];
  const n = Math.round(secs / dt), k = Math.round(every / dt);
  for (let i = 1; i <= n; i++) { sim.advance(dt); if (i % k === 0) states.push(JSON.parse(JSON.stringify(sim.getState()))); }
  return { sim, states };
}

// every number finite; null only on a NULLABLE path ('[n]' → '[*]'); never undefined
function finiteBad(o, nullable, p, bad) {
  p = p || ''; bad = bad || [];
  if (o === null) { if (nullable.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p + '=null'); return bad; }
  if (o === undefined) { bad.push(p + '=undefined'); return bad; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p + '=' + o); return bad; }
  if (Array.isArray(o)) { o.forEach((v, i) => finiteBad(v, nullable, p + '[' + i + ']', bad)); return bad; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => finiteBad(o[k], nullable, p ? p + '.' + k : k, bad));
  return bad;
}
const J = (x) => JSON.parse(JSON.stringify(x));
// identity of two state lists (v3.3 paths exact, §7 sig rule)
function sameStates(assert, a, b, tag) {
  assert.strictEqual(a.states.length, b.states.length, tag + ' state count');
  a.states.forEach((st, i) => {
    const d = X.identityDiff(st, b.states[i], 5);
    assert.ok(d.length === 0, tag + ' state ' + i + ': ' + d.join('; '));
    if (b.states[i].rigup) assert.ok(/^0+$/.test(b.states[i].rigup.sig.slice(8)), tag + ' every optional item out: ' + b.states[i].rigup.sig);
  });
  const ha = J(a.sim.getHistory ? X.HIST_KEYS_V33.map((k) => a.sim.getHistory(k)) : []), hb = J(X.HIST_KEYS_V33.map((k) => b.sim.getHistory(k)));
  const dh = X.identityDiff(ha, hb, 5);
  assert.ok(dh.length === 0, tag + ' history: ' + dh.join('; '));
}

module.exports = [
  {
    name: 'WTSEQ harness: Round 7 is in the in-memory pipeline, after round 6 and before round 8',
    wp: WP,
    opts: false,
    run(app, assert, ctx) {
      const P = ctx.harness.PIPELINE.map((p) => p[0]);
      const i6 = P.indexOf('concat-round6'), i7 = P.indexOf('concat-round7'), i8 = P.indexOf('concat-round8');
      assert.ok(i7 > 0, 'concat-round7 in PIPELINE: ' + P.join(', '));
      assert.ok(i6 < i7 && i7 < i8, 'order round 6 < round 7 < round 8');
      assert.strictEqual(ctx.harness.PIPELINE[i7][1], 'inject-round7');
      const hdr = fs.readFileSync(path.join(__dirname, '_harness.js'), 'utf8').slice(0, 4000);
      assert.ok(/round 7 is rebuilt from 31\/32\/38 like the others/.test(hdr), 'harness header says round 7 is rebuilt from 31/32/38');
      const b = ctx.harness.buildFromSources({ silent: true });
      R7_FILES.forEach((f) => assert.ok(b.html.indexOf('// ─── BEGIN ' + f.replace(/\.js$/, '') + ' ') > 0, f + ' in the in-memory build'));
    },
  },
  {
    name: 'WTSEQ harness self-check: a sourceOverrides VERSION probe in 31-wts-sim.js reaches the app (Round 7 overrides work)',
    wp: WP,
    opts: { sourceOverrides: { '31-wts-sim.js': PROBE_SRC } },
    run(app, assert) {
      const S = app.win.WTS_sim;
      assert.ok(S, 'WTS_sim present');
      assert.strictEqual(S.VERSION, X.PROBE_VERSION, 'the overridden 31-wts-sim.js is the one loaded');
      assert.ok(app.build && app.build.mode === 'sources', 'override build is an in-memory sources build');
      assert.ok(!app.build.fallbacks.some((f) => f.file === '31-wts-sim.js'), 'no HEAD fallback for the probe');
      const sim = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1 }));
      sim.advance(10);
      assert.ok(isFinite(sim.getState().t), 'probe engine runs');
    },
  },
  {
    name: 'WTSEQ harness self-check: --sources main script equals --html main script (Round 7 inject is an exact round trip)',
    wp: WP,
    opts: false,
    timeoutMs: 240000,
    run(app, assert, ctx) {
      const H = ctx.harness;
      const html = fs.readFileSync(H.HTML_PATH, 'utf8');
      const mainHtml = H.extractMain(html);
      // (1) idempotent replace: injecting the HTML's own Round-7 blob gives the HTML back byte for byte
      const i7 = require(path.join(BUILD_DIR, 'inject-round7.js'));
      const s = html.indexOf(i7.START), e = html.indexOf(i7.END, s);
      const eol = html.includes('\r\n') ? '\r\n' : '\n';
      const blob = html.slice(s + i7.START.length + eol.length, e - eol.length);
      assert.ok(i7.inject(html, blob).out === html, 'inject-round7 replace of the embedded blob is the identity');
      // (2) the whole in-memory pipeline with 31/32/38 as embedded in the HTML reproduces the HTML main script exactly
      const bodies = round7Bodies(html);
      const rt = H.buildFromSources({ silent: true, overrides: bodies });
      assert.ok(H.extractMain(rt.html) === mainHtml, 'sources build with the embedded Round-7 files = HTML main script');
      // (3) on the unchanged tree (working 31/32/38 = the embedded ones) the plain --sources build equals --html
      const changed = R7_FILES.filter((f) => {
        const src = fs.readFileSync(path.join(BUILD_DIR, f), 'utf8');
        return require(path.join(BUILD_DIR, 'concat-round7.js')).stripSelfTest(src, f, quietLog) !== bodies[f];
      });
      if (!changed.length) {
        const b = H.buildFromSources({ silent: true });
        assert.ok(H.extractMain(b.html) === mainHtml, '--sources main script === --html main script on the unchanged tree');
      }
      // else: the working Round-7 sources changed since the HTML was built (a WP branch) — (2) is the check that applies
    },
  },
  {
    name: 'WTSEQ frozen v3.3 engine: tests/_wts-sim-v33.js is 31-wts-sim.js at 666be77 with the self-test stripped, in its own context',
    wp: WP,
    opts: false,
    run(app, assert) {
      const frozen = fs.readFileSync(path.join(__dirname, '_wts-sim-v33.js'), 'utf8');
      assert.ok(/^\/\/ prism-build\/tests\/_wts-sim-v33\.js — FROZEN copy/.test(frozen), 'header names the frozen copy');
      assert.ok(/666be77/.test(frozen.slice(0, 600)), 'header names the origin commit');
      let orig = null;
      try { orig = execFileSync('git', ['show', '666be77:prism-build/31-wts-sim.js'], { cwd: path.resolve(BUILD_DIR, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) { orig = null; }
      if (orig) {
        const body = frozen.slice(frozen.indexOf('\n(function () {') + 1);
        const want = strip31(orig);
        assert.ok(want.endsWith(body) && want.slice(0, want.length - body.length).indexOf('(function () {') < 0,
          'frozen body = stripSelfTest(666be77:prism-build/31-wts-sim.js)');
        const sha = require('crypto').createHash('sha256').update(orig).digest('hex');
        assert.ok(frozen.slice(0, 600).indexOf(sha) > 0, 'header carries the sha256 of the origin source');
      }
      const A = X.loadEngine('v33'), B = X.loadEngine('v33');
      assert.strictEqual(A.VERSION, X.VERSION_V33);
      assert.ok(A !== B && A.create !== B.create, 'each loadEngine call is a separate context');
      assert.ok(!('WTS_sim' in globalThis), 'nothing leaks into the test realm');
      assert.strictEqual(JSON.stringify(A.RIG_KEYS), JSON.stringify(X.RIG_KEYS_V33));
    },
  },
  {
    name: 'WTSEQ identity baseline: frozen v3.3 and working engine agree exactly (default 2 h, a T-201 divert, a fault, an ESD trip and reset)',
    wp: WP,
    opts: false,
    timeoutMs: 180000,
    run(app, assert) {
      const A = X.loadEngine('v33'), B = X.loadEngine('work');
      const scen = [
        { name: 'default 2 h dt 10', secs: 7200, dt: 10, every: 600 },
        { name: 'divert to T-201B', secs: 1800, dt: 5, every: 300, setup: (s) => { s.setValve('surge', 1, true); s.setValve('surge', 0, false); } },
        { name: 'oilDumpStuckOpen', secs: 1800, dt: 5, every: 300, setup: (s) => s.setFault('oilDumpStuckOpen', true) },
        { name: 'ESD trip', secs: 900, dt: 1, every: 150, setup: (s) => s.tripESD('test') },
      ];
      scen.forEach((sc) => {
        const a = runStates(A, sc.secs, sc.dt, sc.every, sc.setup), b = runStates(B, sc.secs, sc.dt, sc.every, sc.setup);
        assert.strictEqual(a.states.length, b.states.length);
        a.states.forEach((st, i) => {
          const d = X.identityDiff(st, b.states[i], 5);
          assert.ok(d.length === 0, sc.name + ' state ' + i + ': ' + d.join('; '));
        });
        if (sc.name === 'ESD trip') {
          a.sim.resetESD(); b.sim.resetESD(); a.sim.advance(300); b.sim.advance(300);
          const d = X.identityDiff(JSON.parse(JSON.stringify(a.sim.getState())), JSON.parse(JSON.stringify(b.sim.getState())), 5);
          assert.ok(d.length === 0, 'after the ESD reset: ' + d.join('; '));
        }
        const ha = JSON.parse(JSON.stringify(a.sim.getHistory())), hb = JSON.parse(JSON.stringify(b.sim.getHistory()));
        const dh = X.identityDiff(ha, hb, 5);
        assert.ok(dh.length === 0, sc.name + ' history: ' + dh.join('; '));
      });
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_V33 } }, { rigup: { sig: X.SIG_DEFAULT_V331 } }).length === 0, 'sig rule accepts the appended 00');
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_V33 } }, { rigup: { sig: X.SIG_DEFAULT } }).length === 0, 'sig rule accepts the appended 000 (SIM-FOLLOWUP §3.6)');
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_DEFAULT_V331 } }, { rigup: { sig: X.SIG_DEFAULT } }).length === 0, 'sig rule accepts v3.3.1 → 11 characters');
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_DEFAULT_V331 } }, { rigup: { sig: '11111111001' } }).length === 1, 'sig rule rejects CK-102 in');
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_V33 } }, { rigup: { sig: '1111111110' } }).length === 1, 'sig rule rejects an optional item in');
    },
  },
  {
    name: 'WTSEQ contract fixture: v3.3 lists, step numbers, controls and action payloads agree with the plan and the v3.3 code',
    wp: WP,
    run(app, assert) {
      const A = X.loadEngine('v33');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(A.FAULTS.map((f) => f.id))), X.FAULT_IDS_V33, 'v3.3 fault ids');
      assert.strictEqual(X.FAULT_IDS.length, 16);
      assert.strictEqual(new Set(X.FAULT_IDS).size, 16, 'fault ids unique');
      const st = JSON.parse(JSON.stringify(A.create(A.SAMPLE_FLOW, { seed: 3 }).getState()));
      assert.deepStrictEqual(Object.keys(st.lines), X.LINE_NAMES_V33, 'v3.3 line names');
      assert.strictEqual(X.LINE_NAMES.length, 20);
      assert.deepStrictEqual(Object.keys(st.nodes), X.NODE_IDS_V33, 'v3.3 node order');
      assert.strictEqual(X.NODE_IDS.indexOf('desander'), 8); assert.strictEqual(X.NODE_IDS.indexOf('surge2'), 9);
      assert.strictEqual(st.segs.length, X.SEG_COUNT);
      assert.strictEqual(st.rigup.sig, X.SIG_V33);
      const c = JSON.parse(JSON.stringify(A.create(A.SAMPLE_FLOW, { seed: 3 }).getControls()));
      assert.deepStrictEqual({ surge: c.surge, gauge: c.gauge, v: c.v }, { surge: X.CONTROLS_DEFAULT.surge, gauge: X.CONTROLS_DEFAULT.gauge, v: 1 }, 'v3.3 controls unchanged inside the new shape');
      assert.deepStrictEqual(Object.keys(X.CONTROLS_DEFAULT), ['surge', 'gauge', 'surge2', 'desander', 'v'], 'controls key order');
      assert.strictEqual(X.GETRIGUP_DEFAULT_JSON.indexOf('"flare":true,"desander":false,"surge2":false}') > 0, true);
      assert.deepStrictEqual(Object.keys(X.RIG_DEFAULTS), X.RIG_KEYS, 'RIG_DEFAULTS in signature order');
      assert.strictEqual(X.RIG_KEYS.map((k) => (X.RIG_DEFAULTS[k] ? '1' : '0')).join(''), X.SIG_DEFAULT_V331);
      assert.deepStrictEqual(X.RIG_ORDER.slice().sort(), X.RIG_KEYS.slice().sort(), 'display order is a permutation of RIG_KEYS');
      // step numbers: STEP_V33 is today's table in 32 (and 38); the reference rule reproduces the four pinned combinations
      const S3 = app.win.WTS_3d && app.win.WTS_3d._internals && app.win.WTS_3d._internals.STEP;
      if (S3) assert.deepStrictEqual(JSON.parse(JSON.stringify(S3)), X.STEP_V33, '32 STEP = STEP_V33');
      X.STEP_COMBOS.forEach((cmb) => assert.deepStrictEqual(X.stepForRef(cmb.rig), cmb.step, 'stepFor ' + cmb.name));
      assert.deepStrictEqual(X.stepForRef({ desander: 'yes', surge2: 1 }), X.STEP_V33, 'only strict true counts an optional item');
      // action payloads: proxy strings parse to the payloads with 32's proxy rule ('kind:eq[:idx]')
      Object.keys(X.ACTIONS).forEach((k) => {
        const a = X.ACTIONS[k], parts = a.proxy.split(':');
        const p = { type: parts[0], eq: parts[1] }; if (parts.length > 2) p.idx = +parts[2];
        assert.deepStrictEqual(p, a.action, 'proxy ' + a.proxy);
      });
      // alarm and quiet lists
      assert.deepStrictEqual(X.Q_DES.concat(X.Q_SAND, X.Q_SURGE2).slice().sort(), X.ALARM_IDS.slice().sort(), 'every alarm id is in exactly one quiet list');
      assert.deepStrictEqual(X.ALARM_IDS.filter((id) => X.ALARMS[id].esd), X.ESD_TRIP_IDS, 'only PSHH-103 and PSHH-202 trip the ESD');
      X.ALARM_IDS.forEach((id) => assert.ok(['trip', 'alarm', 'warn', 'hyd'].indexOf(X.ALARMS[id].sev) >= 0, id + ' sev'));
      // flow.sim defaults = DEFAULTS_NEW values
      const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
      X.FLOW_SIM.forEach((r) => assert.strictEqual(get(X.DEFAULTS_NEW, r.cfg), r.def, r.key + ' default = DEFAULTS.' + r.cfg));
      assert.strictEqual(Object.keys(X.SAMPLE_FLOW_SIM).length, 7);
      // fixture text carries no competitor abbreviation and no web address
      const txt = fs.readFileSync(path.join(__dirname, '_wts-equip-shapes.js'), 'utf8') + fs.readFileSync(path.join(BUILD_DIR, 'wts-sim-perf.js'), 'utf8');
      const banned = new RegExp('\\b' + String.fromCharCode(80, 73, 69) + '\\b');   // the abbreviation CLAUDE.md forbids
      assert.ok(!banned.test(txt) && !/https?:\/\//.test(txt), 'no forbidden names or URLs');
    },
  },
  {
    name: 'WTSEQ contract fixture: examples pass checkShape; fakeEquipSnapshot over a v3.3 snapshot and 32 fakeSnapshot is complete and leaves v3.3 paths alone',
    wp: WP,
    run(app, assert) {
      ['desander', 'sand', 'surge2', 'desanderOut', 'sandOut', 'surge2Out'].forEach((k) => {
        const r = X.checkShape(k.replace(/Out$/, ''), X.EXAMPLES[k], { strict: true });
        assert.ok(r.ok, k + ': ' + r.errors.join('; '));
      });
      assert.ok(X.checkShape('nodes.desander', X.EXAMPLES.nodesDesander, { strict: true }).ok);
      assert.ok(X.checkShape('controls', X.CONTROLS_DEFAULT, { strict: true }).ok);
      assert.ok(X.checkShape('dumpEvent', X.EVENT_DUMP_EXAMPLE, { strict: true }).ok);
      const bad = X.EXAMPLES.desander; bad.dump.phase = 'drain'; bad.vIn_fts = Infinity; delete bad.sand.acc_lb;
      const rb = X.checkShape('desander', bad);
      assert.strictEqual(rb.errors.length, 3, 'checkShape catches enum / non-finite / missing: ' + rb.errors.join('; '));
      // anchors sit on the example paths
      const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
      X.ANCHORS.filter((a) => a.path).forEach((a) => {
        const root = a.path.split('.')[0], v = get(X.EXAMPLES[root], a.path.slice(root.length + 1));
        const tol = a.abs != null ? a.abs : a.rel * Math.abs(a.value);
        assert.ok(Math.abs(v - a.value) <= tol, a.id + ' example ' + v + ' vs anchor ' + a.value);
      });
      const A = X.loadEngine('v33');
      const sim = A.create(A.SAMPLE_FLOW, { seed: 5 }); sim.advance(600);
      const v33 = JSON.parse(JSON.stringify(sim.getState()));
      const bases = [['v3.3 engine', v33]];
      const fs3 = app.win.WTS_3d && app.win.WTS_3d._internals && app.win.WTS_3d._internals.fakeSnapshot;
      if (typeof fs3 === 'function') bases.push(['32 fakeSnapshot', JSON.parse(JSON.stringify(fs3(12.3)))]);
      assert.ok(bases.length === 2, '32 fakeSnapshot available as a base');
      const combos = [{}, { desander: true }, { surge2: true }, { desander: true, surge2: true }, { desander: true, flushing: true },
        { desander: true, held: true }, { desander: true, surge2: true, flushing: true, held: true }, { sand: true }];
      bases.forEach(([bn, base]) => {
        const before = JSON.stringify(base);
        combos.forEach((o) => {
          const f = X.fakeEquipSnapshot(base, o), tag = bn + ' ' + JSON.stringify(o);
          ['desander', 'sand', 'surge2', 'rigup'].forEach((n) => { const r = X.checkShape(n, f[n]); assert.ok(r.ok, tag + ' ' + n + ': ' + r.errors.join('; ')); });
          ['desander', 'surge2'].forEach((n) => { const r = X.checkShape('nodes.' + n, f.nodes[n]); assert.ok(r.ok, tag + ' nodes.' + n + ': ' + r.errors.join('; ')); });
          X.LINE_NAMES.forEach((k) => { if (f.lines[k] || X.LINES_NEW[k]) { const r = X.checkShape('line', f.lines[k]); assert.ok(r.ok, tag + ' line ' + k + ': ' + r.errors.join('; ')); } });
          X.FAULTS_NEW.forEach((x) => assert.strictEqual(f.faults[x.id], false, tag + ' fault ' + x.id));
          assert.strictEqual(f.health.massErr.sand, 0);
          assert.deepStrictEqual(f.rigup.extras, X.RIG_OPTIONAL.filter((k) => o[k] === true), tag + ' extras');
          assert.strictEqual(f.rigup.sig.length, 10);
          assert.strictEqual(f.desander.inRig, o.desander === true); assert.strictEqual(f.surge2.inRig, o.surge2 === true);
          if (o.desander) {
            assert.ok(Math.abs(f.nodes.esd.P - f.nodes.choke.Pin - f.desander.dP_psi) < 1e-9, tag + ' esd P − choke Pin = desander ΔP');
            assert.strictEqual(f.desander.Pout, f.nodes.choke.Pin);
          } else assert.strictEqual(f.nodes.esd.P, base.nodes.esd.P, tag + ' esd P unchanged');
          if (o.held) { assert.strictEqual(f.desander.dump.phase, 'held'); assert.strictEqual(f.desander.dump.open, false); assert.ok(f.desander.dump.heldFrom !== ''); }
          else if (o.flushing) { assert.strictEqual(f.desander.dump.phase, 'flush'); assert.strictEqual(f.desander.dump.open, true); assert.strictEqual(f.lines.ds_dump.active, true); }
          if (bn === 'v3.3 engine') {
            const skip = (o.desander ? ['nodes.esd.P', 'segs[1].P0'] : []).concat(o.desander || o.surge2 ? ['rigup.sig'] : []);
            const d = X.identityDiff(base, f).filter((e) => !skip.some((p) => e.indexOf(p + ':') === 0));
            assert.ok(d.length === 0, tag + ' v3.3 paths: ' + d.join('; '));
          }
        });
        assert.strictEqual(JSON.stringify(base), before, bn + ' base not modified');
      });
    },
  },
  // ─── WP-E0: rig-up model, contract, frozen-engine identity, 38 foundation ─────────────────────────────────────────────
  {
    name: 'WTSEQ E0 rig-up model: defaults, v3.3 8-key requests, strict-true optional items, the T-202 rule, null → default, sig / full / extras, RIG_TXT for every key',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      assert.strictEqual(S.VERSION, FU.VERSION_NEW, 'working engine (v1.5.0: CK-102 appended)');
      assert.deepStrictEqual(J(S.RIG_KEYS), FU.RIG_KEYS);
      assert.deepStrictEqual(J(S.RIGUP.map((it) => it.key)), FU.RIG_ORDER, 'display order = process order');
      X.RIG_ITEMS_NEW.forEach((n) => assert.deepStrictEqual(J(S.RIGUP.find((it) => it.key === n.key)), n, 'RIG_ITEMS row ' + n.key));
      assert.deepStrictEqual(J(S.RIG_DEFAULTS), FU.RIG_DEFAULTS); assert.deepStrictEqual(J(S.RIG_OPTIONAL), FU.RIG_OPTIONAL);
      assert.ok(Object.isFrozen(S.RIG_DEFAULTS) && Object.isFrozen(S.RIG_OPTIONAL), 'deep-frozen exports');
      const d = S.normRigup(app.toWin({}));
      assert.ok(d.sig === X.sigDefaultOf(S) && d.full === true && d.extras.length === 0 && d.notes.length === 0, 'default ' + d.sig);
      const v33 = {}; X.RIG_KEYS_V33.forEach((k) => { v33[k] = true; });
      assert.strictEqual(S.normRigup(app.toWin(v33)).sig, X.sigDefaultOf(S), 'a v3.3 8-key request → both new items out');
      [null, 'true', 1, 'yes', {}, []].forEach((v) => assert.strictEqual(S.normRigup(app.toWin({ desander: v, surge2: v })).sig, X.sigDefaultOf(S), 'optional ' + JSON.stringify(v) + ' → out'));
      const r = S.normRigup(app.toWin({ surge2: true, surge: false }));
      assert.ok(r.rig.surge2 === false && r.notes.indexOf(X.RIG_NOTES.surge2NeedsSurge) >= 0, 'surge2 without surge → out with the note');
      const both = S.normRigup(app.toWin({ desander: true, surge2: true }));
      assert.ok(both.sig === sigOf(S, { desander: true, surge2: true }) && both.full === true && J(both.extras).join() === 'desander,surge2', 'both in: sig / full / extras');
      const sim = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 2, config: { noise: { on: false } } }));
      assert.strictEqual(JSON.stringify(sim.getRigup()), FU.GETRIGUP_DEFAULT_JSON, 'getRigup default (11 keys)');
      let st = sim.getState();
      assert.ok(X.checkShape('rigup', J(st.rigup), { strict: true, engine: 'work', rigKeys: FU.RIG_KEYS }).ok, 'rigup shape: ' + X.checkShape('rigup', J(st.rigup), { rigKeys: FU.RIG_KEYS }).errors.join('; '));
      // RIG_TXT: every key has an entry (toggle each non-locked key and read the message)
      const msgs = []; sim.on('rigup', (p) => msgs.push(p.msg));
      [['desander', true], ['surge2', true], ['heater', false], ['separator', false], ['gauge', false], ['pump', false], ['flare', false], ['surge', false]].forEach(([k, v]) => {
        const o = {}; o[k] = v; assert.strictEqual(sim.setRigup(app.toWin(o)), true, 'set ' + k);
      });
      assert.ok(msgs.some((m) => m.indexOf('DS-101 ' + X.RIG_TXT_NEW.desander[2]) >= 0), 'DS-101 entering text');
      assert.ok(msgs.some((m) => m.indexOf('T-202 ' + X.RIG_TXT_NEW.surge2[2]) >= 0), 'T-202 entering text');
      // release 4.1 chain: T-202 stands in for T-201 (the dumps routed to it); 'v341' (pinned): T-201 out takes T-202 out (D11)
      if (S.RIG_ROUTING_DEF === 'v341') assert.ok(msgs.some((m) => /T-202 out of the rig-up/.test(m) && /T-201 out of the rig-up/.test(m)), 'T-201 out takes T-202 out (D11): ' + msgs[msgs.length - 1]);
      else assert.ok(msgs.some((m) => /T-201 out of the rig-up/.test(m) && /Separator dumps routed to T-202 \(T-201 out of the rig-up\)/.test(m)), 'T-201 out: T-202 takes the dumps: ' + msgs[msgs.length - 1]);
      assert.strictEqual(sim.setRigup(app.toWin({ desander: null, surge2: null, heater: null, separator: null, gauge: null, pump: null, flare: null, surge: null })), true);
      assert.strictEqual(JSON.stringify(sim.getRigup()), FU.GETRIGUP_DEFAULT_JSON, 'null → each item default');
      assert.ok(/DS-101 out of the rig-up \(well stream straight to the choke\)/.test(msgs[msgs.length - 1]) && /\(full rig-up\)$/.test(msgs[msgs.length - 1]), msgs[msgs.length - 1]);
      st = sim.getState();
      assert.ok(st.rigup.sig === X.sigDefaultOf(S) && st.rigup.full, 'back to the default');
      assert.strictEqual(sim.setRigup(app.toWin({ desander: false })), false, 'no change → false');
    },
  },
  {
    name: 'WTSEQ E0 review fixes: rigup.refused shows a refused T-202 removal only while it still applies; a capacity ≤ 0 keeps the default',
    wp: WP,
    opts: false,
    run(app, assert) {
      // a working engine whose T-202 'check' rule refuses removal while R.on (stands in for the WP-E2 rule of §3.3, which
      // wts-surge2.test.js checks on the real engine): WP-E2's surge2Rig('check') delegates to the pure surge2RigCheck(old, r)
      const hook = 'function surge2RigCheck(old, r) {';
      const src = strip31(fs.readFileSync(path.join(BUILD_DIR, '31-wts-sim.js'), 'utf8'));
      assert.strictEqual(src.split(hook).length, 2, '31 has the WP-E2 surge2RigCheck rule');
      const R = { on: true, note: X.RIG_NOTES.surge2OnlyRouteRefused };
      const S = X.loadEngine(src.replace(hook, "function surge2RigCheck(old, r) { return old.surge2 && !r.surge2 && __eqR.on ? __eqR.note : ''; }\n  function surge2RigCheckReal(old, r) {"), { __eqR: R });
      const sim = S.create(S.SAMPLE_FLOW, { seed: 3, rigup: { surge2: true } });
      let st = sim.getState();
      assert.strictEqual(st.rigup.refused, '', 'nothing refused yet');
      assert.ok(X.checkShape('rigup', J(st.rigup), { strict: true, engine: 'work', rigKeys: FU.RIG_KEYS }).ok, 'rigup shape: ' + X.checkShape('rigup', J(st.rigup), { rigKeys: FU.RIG_KEYS }).errors.join('; '));
      const log = []; sim.on('event', (p) => log.push(p.msg));
      assert.strictEqual(sim.setRigup({ surge2: false }), false, 'refused → false');
      st = sim.getState();
      assert.ok(st.rigup.surge2 === true && st.rigup.refused === R.note, 'refused note in the snapshot: ' + st.rigup.refused);
      assert.ok(log.some((m) => m.indexOf(R.note) >= 0), 'refusal logged / emitted');
      R.on = false; sim.advance(1);                           // the condition stops applying (e.g. a T-201 inlet opened); next refresh
      assert.strictEqual(sim.getState().rigup.refused, '', 'note gone once the change would be accepted');
      R.on = true; sim.setRigup({ surge2: false });
      assert.strictEqual(sim.getState().rigup.refused, R.note);
      R.on = false; assert.strictEqual(sim.setRigup({ surge2: false }), true, 'accepted');
      R.on = true; st = sim.getState();
      assert.ok(st.rigup.surge2 === false && st.rigup.refused === '', 'an accepted change clears the note');
      // fixture helper
      const f = X.fakeEquipSnapshot(null, { surge2: true, refused: true });
      assert.ok(f.rigup.refused === R.note && X.fakeEquipSnapshot(null, { refused: true }).rigup.refused === '', 'fakeEquipSnapshot refused option (T-202 in only)');
      // §6.3 capacities: a typed 0 / negative is missing (default kept), as surgeCap_bbl and the host's wtsClamp(gv(..) || def, …)
      const W = X.loadEngine('work');
      const cfgA = W.create(W.flowFromInputs({}, { desAcc_gal: 0, surge2Cap_bbl: -3 }), { seed: 1 })._internal().cfg;
      assert.deepStrictEqual([cfgA.desander.acc_gal, cfgA.surge2.cap_bbl], [50, 100], 'capacity ≤ 0 → default');
      const cfgB = W.create(W.flowFromInputs({}, { desAcc_gal: 5, surge2Cap_bbl: 1 }), { seed: 1 })._internal().cfg;
      assert.deepStrictEqual([cfgB.desander.acc_gal, cfgB.surge2.cap_bbl], [10, 20], 'small positive → lower bound');
    },
  },
  {
    name: 'WTSEQ E0 contract: the real snapshot matches _wts-equip-shapes (new blocks, nodes, lines, faults, history, NULLABLE, controls, DEFAULTS, SAMPLE_FLOW.sim, stepFor, API stubs)',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      Object.keys(X.TAGS_NEW).forEach((k) => assert.strictEqual(S.TAGS[k], X.TAGS_NEW[k], 'TAGS.' + k));
      Object.keys(X.NAMES_NEW).forEach((k) => assert.strictEqual(S.NAMES[k], X.NAMES_NEW[k], 'NAMES.' + k));
      X.NULLABLE_NEW.forEach((p) => assert.ok(S.NULLABLE.indexOf(p) >= 0, 'NULLABLE ' + p));
      assert.deepStrictEqual(J(S.FAULTS.map((f) => f.id)), X.FAULT_IDS, 'fault ids');
      X.FAULTS_NEW.forEach((f) => assert.strictEqual(S.FAULTS.find((x) => x.id === f.id).label, f.label, 'fault label ' + f.id));
      Object.keys(X.DEFAULTS_NEW).forEach((k) => assert.deepStrictEqual(J(S.DEFAULTS[k]), X.DEFAULTS_NEW[k], 'DEFAULTS.' + k));
      assert.deepStrictEqual(J(S.SAMPLE_FLOW.sim), Object.assign({ sepID_in: 36, sepLss_ft: 10, surgeP_psig: 25, surgeCap_bbl: 100, gaugeCap_bbl: 100 }, X.SAMPLE_FLOW_SIM, FU.SAMPLE_FLOW_SIM_NEW), 'SAMPLE_FLOW.sim (+2 in v1.5.0)');
      X.API_STATIC_NEW.forEach((k) => assert.ok(k in S, 'WTS_sim.' + k));
      X.STEP_COMBOS.forEach((c) => assert.deepStrictEqual(J(S.stepFor(app.toWin(c.rig))), c.step, 'stepFor ' + c.name));
      assert.deepStrictEqual(J(S.stepFor(app.toWin({ desander: 'yes', surge2: 1 }))), X.STEP_V33, 'stepFor strict true');
      const sim = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 4 }));
      sim.advance(600);
      const st = J(sim.getState());
      ['desander', 'sand', 'surge2'].forEach((n) => { const r = X.checkShape(n, st[n], { strict: true, engine: 'work' }); assert.ok(r.ok, n + ': ' + r.errors.join('; ')); });
      ['desander', 'surge2'].forEach((n) => { const r = X.checkShape('nodes.' + n, st.nodes[n], { strict: true, engine: 'work' }); assert.ok(r.ok, 'nodes.' + n + ': ' + r.errors.join('; ')); });
      assert.deepStrictEqual(Object.keys(st.nodes), FU.NODE_IDS, 'node order (desander 8, surge2 9, heaterChoke 10)');
      assert.strictEqual(st.segs.length, X.SEG_COUNT);
      assert.deepStrictEqual(Object.keys(st.lines).slice(0, X.LINE_NAMES.length), X.LINE_NAMES, '20 line names');
      assert.deepStrictEqual(Object.keys(st.lines).slice(X.LINE_NAMES.length), X.LINES_342.slice(0, Object.keys(st.lines).length - X.LINE_NAMES.length), 'release 4.1 lines appended');
      Object.keys(X.LINES_NEW).forEach((k) => {
        const r = X.checkShape('line', st.lines[k], { strict: true, engine: 'work' }); assert.ok(r.ok, 'line ' + k + ': ' + r.errors.join('; '));
        assert.strictEqual(st.lines[k].unit, X.LINES_NEW[k].unit, k + ' unit'); assert.strictEqual(st.lines[k].phase, X.LINES_NEW[k].phase, k + ' phase');
      });
      X.FAULTS_NEW.forEach((f) => assert.strictEqual(st.faults[f.id], false, 'fault key ' + f.id));
      assert.strictEqual(st.health.massErr.sand, 0, 'massErr.sand');
      assert.ok(X.checkShape('rigup', st.rigup, { strict: true, engine: 'work', rigKeys: FU.RIG_KEYS }).ok, 'rigup');
      // static values while out: the desander follows the choke inlet; T-202 follows T-201's set point
      assert.ok(st.desander.inRig === false && st.desander.Pin === st.nodes.choke.Pin && st.desander.dP_psi === 0 && st.nodes.desander.P === st.nodes.choke.Pin, 'DS-101 out');
      assert.strictEqual(st.nodes.esd.P, st.nodes.choke.Pin, 'ESD node = choke inlet with DS-101 out (as v3.3)');
      assert.ok(st.surge2.inRig === false && st.surge2.SP === st.surge.SP && st.surge2.frac === 0 && st.surge2.route === 'surge', 'T-202 out');
      const A = (id) => X.ANCHORS.find((a) => a.id === id);
      assert.ok(Math.abs(st.desander.sand.cap_lb - A('capLb').value) <= A('capLb').rel * A('capLb').value, 'accumulator cap ' + st.desander.sand.cap_lb);
      assert.ok(Math.abs(st.desander.sand.bufCap_lb - A('bufCapLb').value) <= A('bufCapLb').rel * A('bufCapLb').value, 'buffer cap');
      assert.ok(Math.abs(st.sand.choke.warn_mild - A('warnMild').value) <= A('warnMild').abs && Math.abs(st.sand.choke.high_mild - A('highMild').value) <= A('highMild').abs, 'band limits');
      assert.ok(Math.abs(st.desander.sithp_psi - A('sithpEst').value) <= A('sithpEst').rel * A('sithpEst').value && st.desander.sithpEst === true && st.desander.ratingOK, 'SITHP estimate');
      X.HIST_KEYS.forEach((k) => { const h = sim.getHistory(k); assert.ok(h.t.length > 0 && h.y.every((y) => isFinite(y)), 'history ' + k); });
      // controls (§6.9, exact JSON key order) and the API stubs of WP-E1 / WP-E2
      // v1.6.0: the T-201 default line-up changed (XV-201A open, XV-201B shut, suction B, auto-divert on); the rest is the v3.3.1 contract
      const CD = J(X.CONTROLS_DEFAULT); CD.surge.inlet = [true, false]; CD.surge.suction = 'B'; CD.surge.auto = true;
      CD.surge2.comp = J(X.CONTROLS_SURGE2_COMP_DUAL);   // release 4.1: the dual T-202 line-up (A fills, B on LCV-202, auto-divert on)
      assert.strictEqual(JSON.stringify(sim.getControls()), JSON.stringify(CD), 'getControls default');
      assert.ok(X.checkShape('controls', J(sim.getControls()), { strict: true }).ok);
      X.API_INSTANCE_NEW.forEach((k) => assert.strictEqual(typeof sim[k], 'function', 'api ' + k));
      assert.strictEqual(sim.dumpDesander().ok, false); assert.strictEqual(sim.setSurgeRoute('both').ok, false);
      assert.strictEqual(sim.setDesander(app.toWin({ bypass: true })), false); assert.strictEqual(sim.setValve('surge2', 0, true), false);
      assert.strictEqual(sim.setAutoDivert('surge2', true), false); assert.strictEqual(sim.setValveOptions('surge2', app.toWin({ strokeS: 3 })), false);
      // v3.3 prefs (no surge2 / desander keys) keep the defaults; new keys are read and clamped
      const s2 = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 4 }));
      s2.setControls(app.toWin({ surge: X.CONTROLS_DEFAULT.surge, gauge: X.CONTROLS_DEFAULT.gauge, v: 1 }), app.toWin({ initial: true }));
      const CD0 = J(X.CONTROLS_DEFAULT); CD0.surge2.comp = J(X.CONTROLS_SURGE2_COMP_DUAL);   // release 4.1: unpinned engine = dual T-202
      assert.strictEqual(JSON.stringify(s2.getControls()), JSON.stringify(CD0), 'v3.3 prefs');
      s2.setControls(app.toWin({ surge2: { inlet: true, auto: true, sp: 0.75, hyst: 9, strokeS: 99 }, desander: { bypass: true, auto: true, sp: 0.1 } }), app.toWin({ initial: true }));
      const c2 = J(s2.getControls());
      // release 4.1: an old boolean inlet:true opens the T-202 fill line-up (XV-202A) and the comp block is appended
      assert.deepStrictEqual(c2.surge2, { inlet: true, auto: true, sp: 0.75, hyst: 0.5, strokeS: 60,
        comp: Object.assign(J(X.CONTROLS_SURGE2_COMP_DUAL), { inlet: [true, false] }) }, 'surge2 controls read + clamped');
      assert.deepStrictEqual(c2.desander, { bypass: true, auto: true, sp: 0.5 }, 'desander controls read + clamped (sp 0.5–0.95)');
      // flow.sim values are clamped to the §6.3 ranges (1e400 = Infinity never gets through)
      const f = S.flowFromInputs(app.toWin({}), app.toWin({ sand_pptb: 1e400, sand_lbmmscf: -5, sand_d50_um: 5, desRating_psi: 7000, desAcc_gal: 1e9, sithp_psig: 50, surge2Cap_bbl: 1000 }));
      const cfg = S.create(f, app.toWin({ seed: 1 }))._internal().cfg;
      assert.deepStrictEqual([cfg.sand.pptb, cfg.sand.lbPerMMscf, cfg.sand.d50_um, cfg.desander.rating_psi, cfg.desander.acc_gal, cfg.desander.sithp_psig, cfg.surge2.cap_bbl],
        [0, 0, 20, 10000, 200, 100, 500], 'clamped');
      const cfg0 = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1 }))._internal().cfg;
      assert.strictEqual(cfg0.desander.sithp_psig, null, 'blank SITHP stays null (estimated)');
    },
  },
  {
    name: 'WTSEQ E0 frozen-engine identity (U6): scenarios a–e on the v3.3 engine and the working engine, with the v3.3 and the new SAMPLE_FLOW — every v3.3 path ===',
    wp: WP,
    opts: false,
    timeoutMs: 600000,
    run(app, assert) {
      const A = X.loadEngine('v33'), B = X.loadEngine('work');
      const F33 = J(A.SAMPLE_FLOW), Fnew = J(B.SAMPLE_FLOW);
      assert.deepStrictEqual(Object.keys(Fnew.sim).slice(5, 12), Object.keys(X.SAMPLE_FLOW_SIM), 'new SAMPLE_FLOW carries the seven keys (then the two of v1.5.0)');
      const scen = [
        { name: '(a) 4 h default dt 10', secs: 4 * 3600, dt: 10, every: 1200 },
        { name: '(c) T-201 A/B divert with auto-divert', secs: 2 * 3600, dt: 5, every: 600, setup: (s) => { s.setAutoDivert('surge', true, { sp: 0.6 }); s.setValve('surge', 1, false); } },
        { name: '(d) oilDumpStuckOpen', secs: 3600, dt: 5, every: 600, setup: (s) => s.setFault('oilDumpStuckOpen', true) },
        { name: '(d) xferStuckClosed', secs: 3600, dt: 5, every: 600, setup: (s) => s.setFault('xferStuckClosed', true) },
        { name: '(e) ESD trip and reset', secs: 1200, dt: 2, every: 200, setup: (s) => s.tripESD('test'), after: true },
      ];
      ['heater', 'separator', 'surge', 'gauge', 'pump', 'flare'].forEach((k) => {
        const rig = {}; rig[k] = false;
        scen.push({ name: '(b) 1 h without ' + k, secs: 3600, dt: 10, every: 900, opts: { rigup: rig } });
      });
      scen.forEach((sc) => {
        const a = runStates(A, sc.secs, sc.dt, sc.every, sc.setup, F33, sc.opts);
        [['v3.3 flow', F33], ['new flow', Fnew]].forEach(([fn, flow]) => {
          const b = runStates(B, sc.secs, sc.dt, sc.every, sc.setup, flow, sc.opts);
          sameStates(assert, a, b, sc.name + ' / ' + fn);
          if (sc.after) {
            const ra = a.sim.resetESD(), rb = b.sim.resetESD();
            assert.strictEqual(JSON.stringify(ra), JSON.stringify(rb), 'resetESD result');
            for (let i = 0; i < 60; i++) { a.sim.advance(10); b.sim.advance(10); }
            const d = X.identityDiff(J(a.sim.getState()), J(b.sim.getState()), 5);
            assert.ok(d.length === 0, sc.name + ' / ' + fn + ' after the reset: ' + d.join('; '));
            if (fn === 'v3.3 flow') { a.sim = runStates(A, sc.secs, sc.dt, sc.every, sc.setup, F33, sc.opts).sim; }   // fresh v3.3 run for the new-flow pass
          }
        });
      });
    },
  },
  {
    name: 'WTSEQ E0 both items in (+ flow-back fault): finite walk with NULLABLE, determinism (same seed), dt 1 vs dt 10, balances',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const mk = () => S.create(S.SAMPLE_FLOW, app.toWin({ seed: 21, rigup: { desander: true, surge2: true } }));
      const a = mk(), b = mk();
      a.setFault('sandFlowback', true); b.setFault('sandFlowback', true);
      for (let i = 0; i < 360; i++) { a.advance(10); b.advance(10); }
      const sa = J(a.getState()), sb = J(b.getState());
      const bad = finiteBad(sa, J(S.NULLABLE));
      assert.ok(bad.length === 0, 'finite walk: ' + bad.slice(0, 6).join(', '));
      assert.strictEqual(JSON.stringify(sa), JSON.stringify(sb), 'determinism: same seed → same state');
      assert.ok(sa.rigup.desander && sa.rigup.surge2 && sa.desander.inRig && sa.surge2.inRig && sa.faults.sandFlowback, 'both in');
      const m = sa.health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9 && m.sand === 0, 'balances ' + JSON.stringify(m));
      ['desander', 'sand', 'surge2'].forEach((n) => assert.ok(X.checkShape(n, sa[n], { strict: true }).ok, n + ' shape with the item in'));
      // step size: dt 1 vs dt 10 over 2 h (tolerances of 31 self-test 6)
      const cfg = { noise: { on: false } };
      const c = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 3, config: cfg, rigup: { desander: true, surge2: true } }));
      const d = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 3, config: cfg, rigup: { desander: true, surge2: true } }));
      for (let i = 0; i < 7200; i++) c.advance(1);
      for (let i = 0; i < 720; i++) d.advance(10);
      const sc = c.getState(), sd = d.getState();
      assert.near(sc.t, sd.t, 1e-6, 't');
      assert.near(sc.cum.oilIn_stb / sd.cum.oilIn_stb, 1, 1e-6, 'cum oil');
      assert.near(sc.gauge.tanks[0].frac, sd.gauge.tanks[0].frac, 0.005, 'gauge A');
      assert.near(sc.sep.P, sd.sep.P, 1, 'Psep');
      assert.near(sc.sand.cum.in_lb, sd.sand.cum.in_lb, 0.01 * Math.max(1, sd.sand.cum.in_lb), 'sand in within 1 %');
    },
  },
  {
    name: 'WTSEQ E0 38 foundation: constants, rigIn / EQV / stepFor fallback, readRig / writeRig round trips with v3.3 and v3.3.1 objects, summaryOf, test hooks',
    wp: WP,
    run(app, assert) {
      const L = app.win.WTS_live, I = L && L._internals, S = app.win.WTS_sim;
      assert.ok(I, 'WTS_live._internals');
      ['desander', 'surge2'].forEach((k) => {
        assert.ok(I.EQ_IDS.indexOf(k) >= 0, 'EQ_IDS ' + k); assert.strictEqual(I.TAG[k], k === 'desander' ? 'DS-101' : 'T-202');
      });
      assert.strictEqual(I.NAME.desander, 'Desander (cyclonic)'); assert.strictEqual(I.NAME.surge2, 'Surge Tank 2');
      assert.strictEqual(I.EQ_ABBR.desander, 'DSND'); assert.strictEqual(I.EQ_ABBR.surge2, 'T-202');
      assert.deepStrictEqual(J(I.HOST_NM).slice(8, 10), ['Desander', 'Surge Tank 2']); assert.deepStrictEqual(J(I.NODE_KEYS).slice(8, 10), ['desander', 'surge2']);   // CK-102 follows at 10 (v1.5.0)
      assert.strictEqual(I.INPUT_FOR.desander, 'wts_sandPptb'); assert.strictEqual(I.INPUT_FOR.surge2, 'wts_surge2Cap');
      ['mass', 'volumeSmall', 'erosionRate', 'erosionDay'].forEach((k) => assert.ok(typeof I.IMP[k] === 'string' && I.IMP[k], 'IMP.' + k));
      assert.ok(/^#|^rgb/.test(I.palCol('sand')), 'sand colour');
      // release 4.1: T-202 has two compartments (XV-202A / XV-202B, LCV-202 suction); a one-compartment T-202 falls back to XV-202
      assert.strictEqual(I.EQV.surge2.kind, 'comps'); assert.deepStrictEqual(J(I.EQV.surge2.valves), ['XV-202A', 'XV-202B']); assert.strictEqual(I.EQV.surge2.suction, true);
      assert.ok(I.EQV.surge.suction === true && I.EQV.gauge.kind === 'tanks' && I.EQV.desander.bypass === 'HV-104', 'EQV');
      assert.ok(I.rigIn({ rigup: { surge2: true } }, 'surge2') && !I.rigIn({ rigup: { surge2: 'true' } }, 'surge2') && !I.rigIn({}, 'desander'), 'rigIn');
      X.STEP_COMBOS.forEach((c) => assert.deepStrictEqual(J(I.stepFor(app.toWin(c.rig))), c.step, '38 stepFor ' + c.name));
      assert.strictEqual(I.rigItems().length, 11);
      const ls = app.win.localStorage;
      // v3.3 request (8 keys, an item out) → stored as is by v3.3; read back, the new items stay out in the sim
      ls.setItem(I.RIG_KEY, '{"esd":true,"choke":true,"heater":false,"separator":true,"surge":true,"gauge":true,"pump":true,"flare":true}');
      const r33 = I.readRig();
      assert.deepStrictEqual(J(r33), { esd: true, choke: true, heater: false, separator: true, surge: true, gauge: true, pump: true, flare: true }, 'readRig v3.3');
      const s33 = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1, rigup: r33 }));
      assert.strictEqual(s33.getState().rigup.sig, '11011111000', 'v3.3 request → the optional items out');
      I.writeRig(s33.getRigup());
      const w = JSON.parse(ls.getItem(I.RIG_KEY));
      assert.ok(Object.keys(w).length === 11 && w.heater === false && w.desander === false && w.surge2 === false && w.heaterChoke === false, 'writeRig stores all 11 keys: ' + ls.getItem(I.RIG_KEY));
      // v3.3.1 request with an optional item only → stored (the v3.3 "no false = remove" rule would drop it)
      I.writeRig(app.toWin({ desander: true }));
      assert.strictEqual(JSON.parse(ls.getItem(I.RIG_KEY)).desander, true, 'optional-only request stored');
      const r331 = I.readRig(), s331 = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1, rigup: r331 }));
      assert.strictEqual(s331.getState().rigup.sig, sigOf(S, { desander: true }), 'round trip v3.3.1 → DS-101 in');
      I.writeRig(s331.getRigup()); assert.strictEqual(JSON.parse(ls.getItem(I.RIG_KEY)).desander, true);
      I.writeRig(S.RIG_DEFAULTS); assert.strictEqual(ls.getItem(I.RIG_KEY), null, 'request = RIG_DEFAULTS → no key');
      I.writeRig(app.toWin({ heater: true, desander: false })); assert.strictEqual(ls.getItem(I.RIG_KEY), null, 'default request → no key');
      // a v3.3 build reading a v3.3.1 object ignores unknown keys (its readRig keeps booleans for its 8 known keys)
      const known8 = {}; const o331 = JSON.parse('{"esd":true,"desander":true,"choke":true,"heater":true,"separator":true,"surge":true,"surge2":true,"gauge":true,"pump":true,"flare":true}');
      X.RIG_KEYS_V33.forEach((k) => { if (typeof o331[k] === 'boolean') known8[k] = o331[k]; });
      assert.strictEqual(Object.keys(known8).length, 8, 'v3.3 view of a v3.3.1 object: 8 known keys, all in');
      // summaryOf: out = core items out only, extras = optional items in
      const sum = I.summaryOf(J(S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1, rigup: { desander: true, gauge: false } })).getState()));
      // release 4.1 chain: with T-301 out P-201 stays in as the booster of the T-201 transfer to export (pinned 'v341': both out)
      assert.deepStrictEqual(J(sum.rigup.out), J(S.RIG_ROUTING_DEF) === 'v341' ? ['T-301', 'P-201'] : ['T-301'], 'summary out (core only)');
      assert.deepStrictEqual(J(sum.rigup.extras), ['desander'], 'summary extras');
      // test hooks: sim() / useSim(stub)
      const keep = I.sim(), stub = { tag: 'stub' };
      assert.strictEqual(I.useSim(stub), stub); assert.strictEqual(I.sim(), stub);
      I.useSim(keep); assert.strictEqual(I.sim(), keep);
      // liveNodes: 11 calc-shaped nodes with finite P / T (v1.5.0: CK-102 at index 10)
      const n = L.liveNodes(J(s331.getState()));
      assert.ok(n.length === 11 && n.every((x) => isFinite(x.P) && isFinite(x.T)) && n[8].nm === 'Desander' && n[9].nm === 'Surge Tank 2' && n[10].nm === 'Heater Choke', 'liveNodes 11');
    },
  },
  {
    name: 'WTSEQ E0 live Rig-up card: default shows "Full rig-up" with the button disabled, no DS-101 / T-202 rows in the page report; optional switches; applyFlow / fullRig keep optional items as requested; reload restores',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const openWts = (a) => {
        const b = a.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator sidebar button');
        a.click(b); a.flush(500);
        const s = a.win.WTS_live && a.win.WTS_live.getSim && a.win.WTS_live.getSim(); if (!s) throw new Error('live simulator did not start');
        return s;
      };
      const live = openWts(app);
      const card = app.el('wtsl_rigup'), sw = (k) => card.querySelector('[data-rig="' + k + '"]');
      assert.ok(card, 'Rig-up card');
      const cfgRow = () => Array.prototype.find.call(card.querySelectorAll('.rrow'), (r) => /Configuration/.test(r.textContent));
      assert.ok(/Full rig-up/.test(cfgRow().textContent) && !/with/.test(cfgRow().textContent), 'Configuration: Full rig-up');
      assert.ok(card.querySelector('[data-rig-act="all"]').disabled, 'Full rig-up button disabled by default');
      ['desander', 'surge2'].forEach((k) => {
        assert.ok(sw(k) && !sw(k).disabled && sw(k).getAttribute('aria-checked') === 'false', k + ' switch present, off');
        assert.ok(sw(k).closest('.rrow').classList.contains('rp-skip'), k + ' row is rp-skip while out');
      });
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      // the Dynamic Simulation inputs (WP-2D: sand rate, "Desander rating", T-202 capacity …) are page inputs, always reported;
      // the check is on everything else (rig-up rows, results)
      const txt = JSON.stringify(model, (k, v) => (v && v.kind === 'input' ? undefined : v));
      assert.ok(txt.indexOf('Rig-up') >= 0 && !/DS-101|T-202|desander/i.test(txt), 'default report has no DS-101 / T-202 rows: ' + (txt.match(/.{60}(DS-101|T-202|desander).{40}/i) || [''])[0]);
      // DS-101 in from the card: request saved with all keys; 'with DS-101' in the configuration row; button still disabled
      app.click(sw('desander'));
      assert.strictEqual(live.getState().rigup.desander, true, 'sim has DS-101');
      assert.strictEqual(JSON.parse(app.win.localStorage.getItem('wts_sim_rigup') || '{}').desander, true, 'saved');
      assert.ok(/Full rig-up · with DS-101/.test(cfgRow().textContent), cfgRow().textContent);
      assert.ok(card.querySelector('[data-rig-act="all"]').disabled, 'Full rig-up still disabled (core items all in)');
      // T-201 out: under the 4.1 chain rules (default) T-202 may stand in for T-201 (RIGUP chainAlone), so its switch stays enabled
      // (the v3.4.1 'needs T-201' disable applies under the 'v341' routing only)
      app.click(sw('surge'));
      assert.ok(live.getState().rigup.routing === 'chain' && !sw('surge2').disabled && !/needs T-201/.test(sw('surge2').getAttribute('title') || ''), 'T-202 switch enabled while T-201 is out (chain)');
      // Full rig-up restores core items and leaves DS-101 in
      app.click(card.querySelector('[data-rig-act="all"]'));
      let st = live.getState();
      assert.ok(st.rigup.surge === true && st.rigup.desander === true && st.rigup.full, 'fullRig: core in, DS-101 kept');
      // project open: a v3.3 saved rig-up (8 keys) re-applied by applyFlow → both new items out
      app.win.localStorage.setItem('wts_sim_rigup', '{"esd":true,"choke":true,"heater":false,"separator":true,"surge":true,"gauge":true,"pump":true,"flare":true}');
      app.fire('document', 'wts:project-loaded', {});
      app.fire('document', 'wts:calc', app.toWin({ flow: J(app.win.WTS_sim.SAMPLE_FLOW) }));
      app.flush(500);
      st = live.getState();
      assert.ok(st.rigup.heater === false && st.rigup.desander === false && st.rigup.surge2 === false, 'v3.3 project rig-up: ' + st.rigup.sig);
      // reload restores a v3.3.1 request with T-202 in
      app.win.WTS_live.getSim().setRigup(app.toWin({ heater: true, surge2: true }));
      const saved = JSON.parse(app.win.localStorage.getItem('wts_sim_rigup') || '{}');
      assert.ok(saved.surge2 === true && Object.keys(saved).length === 11, 'saved request (11 keys): ' + JSON.stringify(saved));
      const app2 = ctx.loadApp({ storage: app.storage });
      try {
        const live2 = openWts(app2);
        const st2 = live2.getState();
        assert.ok(st2.rigup.surge2 === true && st2.rigup.desander === false && st2.rigup.heater === true, 'restored after reload: ' + st2.rigup.sig);
      } finally { if (app2.dispose) app2.dispose(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
];
