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

const WP = 'WTSEQ';
const BUILD_DIR = path.resolve(__dirname, '..');
const R7_FILES = ['31-wts-sim.js', '32-wts-3d.js', '38-wts-live.js'];

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

function runStates(S, secs, dt, every, setup) {
  const sim = S.create(S.SAMPLE_FLOW, { seed: 7 });
  if (setup) setup(sim);
  const states = [JSON.parse(JSON.stringify(sim.getState()))];
  const n = Math.round(secs / dt), k = Math.round(every / dt);
  for (let i = 1; i <= n; i++) { sim.advance(dt); if (i % k === 0) states.push(JSON.parse(JSON.stringify(sim.getState()))); }
  return { sim, states };
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
      assert.ok(X.identityDiff({ rigup: { sig: X.SIG_V33 } }, { rigup: { sig: X.SIG_DEFAULT } }).length === 0, 'sig rule accepts the appended 00');
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
      assert.strictEqual(X.RIG_KEYS.map((k) => (X.RIG_DEFAULTS[k] ? '1' : '0')).join(''), X.SIG_DEFAULT);
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
];
