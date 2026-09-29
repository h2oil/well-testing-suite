#!/usr/bin/env node
// PRiSM acceptance-test runner (WP0).
//
//   node prism-build/accept-test.js [--sources | --html] [--wp WP5[,WP1]] [--integration]
//                                   [--file substr] [--grep regex] [--verbose] [--list]
//
// Runs every prism-build/tests/*.test.js. Each test file exports
//   module.exports = [{ name, wp, integration?, opts?, timeoutMs?, run(app, assert, ctx) }, ...]
// For each test a FRESH app is loaded with the harness (tests/_harness.js):
//   app  = loadApp(Object.assign({fromSources: <mode>}, test.opts))   (test.opts may set timers,
//          viewport, storage, seed, ...). Set `opts: false` to get no app (app === null).
//   ctx  = { loadApp, createStorage, harness, mode }  — e.g. for two-session reload tests.
//   run may be async. assert = node:assert + near/rel/within/finite/includes/match helpers.
//
// Flags:
//   --sources      (default) rebuild the main script in memory from prism-build/ sources
//                  (syntax-broken sources fall back to git HEAD with a warning)
//   --html         load well-testing-app.html exactly as it is on disk
//   --wp WPn       only tests whose wp matches (comma list; 'WP4a', 'wp5', '5' all work)
//   --integration  also run tests flagged integration:true (reported in their own section)
//   --file s       only test files whose name contains s
//   --grep re      only tests whose name matches re
//   --verbose      echo the app console for every test (else only for failures)
//   --list         list the selected tests and exit
// Exit code: 0 when every selected test passed, 1 otherwise.

'use strict';

const fs = require('fs');
const path = require('path');
const nodeAssert = require('assert');
const harness = require('./tests/_harness');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith("'use strict'"))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const flag = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
const mode = flag('--html') ? 'html' : 'sources';
const includeIntegration = flag('--integration');
const verbose = flag('--verbose');
const normWp = (w) => String(w || '').toUpperCase().replace(/^(WP)?/, 'WP');
const wpFilter = val('--wp') ? val('--wp').split(',').map(normWp) : null;
const fileFilter = val('--file');
const grep = val('--grep') ? new RegExp(val('--grep'), 'i') : null;

// ── assert with numeric helpers ──
function makeAssert() {
  const a = (v, msg) => nodeAssert.ok(v, msg);
  Object.assign(a, nodeAssert);
  a.near = (actual, expected, tol, msg) => {
    const t = tol == null ? 1e-9 : tol;
    if (!(Math.abs(actual - expected) <= t)) {
      throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected ' + expected + ' ± ' + t + ', got ' + actual, actual, expected, operator: 'near' });
    }
  };
  a.rel = (actual, expected, relTol, msg) => {
    const r = relTol == null ? 1e-6 : relTol;
    const ok = expected === 0 ? Math.abs(actual) <= r : Math.abs(actual - expected) / Math.abs(expected) <= r;
    if (!ok) throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected ' + expected + ' (rel ±' + r + '), got ' + actual, actual, expected, operator: 'rel' });
  };
  a.within = (actual, lo, hi, msg) => {
    if (!(actual >= lo && actual <= hi)) throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected within [' + lo + ', ' + hi + '], got ' + actual, actual, expected: [lo, hi], operator: 'within' });
  };
  a.finite = (v, msg) => { if (typeof v !== 'number' || !isFinite(v)) throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected a finite number, got ' + v, actual: v, operator: 'finite' }); };
  a.includes = (hay, needle, msg) => { if (!hay || hay.indexOf(needle) === -1) throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected to include ' + JSON.stringify(needle), actual: typeof hay === 'string' ? hay.slice(0, 300) : hay, operator: 'includes' }); };
  a.fn = (v, msg) => { if (typeof v !== 'function') throw new nodeAssert.AssertionError({ message: (msg ? msg + ': ' : '') + 'expected a function, got ' + typeof v, actual: typeof v, operator: 'fn' }); };
  return a;
}

// ── collect tests ──
const TEST_DIR = path.join(__dirname, 'tests');
const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js') && !f.startsWith('_'))
  .filter((f) => !fileFilter || f.indexOf(fileFilter) !== -1).sort();
const tests = [];
const loadFailures = [];
for (const f of files) {
  let mod;
  try { mod = require(path.join(TEST_DIR, f)); }
  catch (e) {
    const m = /^(wp\d+[a-z]?)/i.exec(f);
    loadFailures.push({ file: f, wp: m ? normWp(m[1]) : 'WP?', error: e });
    continue;
  }
  const list = Array.isArray(mod) ? mod : (mod && Array.isArray(mod.tests) ? mod.tests : []);
  list.forEach((t, i) => tests.push(Object.assign({ file: f, idx: i }, t, { wp: normWp(t.wp || (/^(wp\d+[a-z]?)/i.exec(f) || [])[1] || '?') })));
}
const selected = tests.filter((t) => (!wpFilter || wpFilter.includes(t.wp)) && (!grep || grep.test(t.name || '')));
const regular = selected.filter((t) => !t.integration);
const integ = selected.filter((t) => t.integration);
const run = regular.concat(includeIntegration ? integ : []);
const loadFail = loadFailures.filter((f) => !wpFilter || wpFilter.includes(f.wp));

if (flag('--list')) {
  for (const t of run) console.log(t.wp.padEnd(6) + (t.integration ? '[integ] ' : '') + t.file + ' :: ' + t.name);
  if (!includeIntegration && integ.length) console.log('(' + integ.length + ' integration test(s) hidden — add --integration)');
  process.exit(0);
}

// ── run ──
function withTimeout(p, ms, name) {
  let h;
  const to = new Promise((_, rej) => { h = setTimeout(() => rej(new Error('timeout after ' + ms + ' ms: ' + name)), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(h));
}

(async function main() {
  const t0 = Date.now();
  console.log('[accept] mode: ' + mode + (wpFilter ? '  wp: ' + wpFilter.join(',') : '') +
              (includeIntegration ? '  (+integration)' : '') + '  files: ' + files.length);
  if (mode === 'sources') {
    const b = harness.buildFromSources({});
    const incl = (b.html.match(/\/\/ ─── BEGIN 3[3-7]-[\w-]+/g) || []).map((s) => s.replace('// ─── BEGIN ', ''));
    console.log('[accept] built from sources — round 8 files present: ' + (incl.length ? incl.join(', ') : 'none') +
                (b.fallbacks.length ? '  HEAD fallbacks: ' + b.fallbacks.map((f) => f.file).join(', ') : '') +
                (b.skipped.filter((s) => s.error !== 'missing').length ? '  SKIPPED: ' + b.skipped.filter((s) => s.error !== 'missing').map((s) => s.file).join(', ') : ''));
  }
  const results = [];
  for (const lf of loadFail) {
    results.push({ t: { name: '(load ' + lf.file + ')', wp: lf.wp, file: lf.file }, ok: false, err: lf.error, ms: 0 });
    console.log('FAIL  ' + lf.wp.padEnd(5) + ' ' + lf.file + ' — test file failed to load: ' + lf.error.message);
  }
  for (const t of run) {
    const s = Date.now();
    let app = null, ok = true, err = null;
    try {
      if (t.opts !== false) app = harness.loadApp(Object.assign({ fromSources: mode === 'sources', console: verbose ? 'inherit' : 'capture' }, t.opts || {}));
      const ctx = {
        mode, harness,
        loadApp: (o) => harness.loadApp(Object.assign({ fromSources: mode === 'sources', console: verbose ? 'inherit' : 'capture' }, o || {})),
        createStorage: harness.createStorage,
      };
      await withTimeout(Promise.resolve().then(() => t.run(app, makeAssert(), ctx)), t.timeoutMs || 120000, t.name);
    } catch (e) { ok = false; err = e; }
    finally { if (app && app.dispose) try { app.dispose(); } catch (_) { /* ignore */ } }
    const ms = Date.now() - s;
    results.push({ t, ok, err, ms });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + t.wp.padEnd(5) + ' ' + (t.integration ? '[integ] ' : '') + t.name + '  (' + ms + ' ms)');
    if (!ok) {
      console.log('      ' + String((err && err.stack) || err).split('\n').slice(0, 8).join('\n      '));
      const cons = (err && err.app ? err.app : app);
      if (cons && cons.logs && !verbose) {
        const errs = cons.logs.filter((l) => l.level === 'error').slice(-5);
        if (errs.length) console.log('      app console.error (last ' + errs.length + '):\n        ' + errs.map((l) => l.text.split('\n')[0].slice(0, 240)).join('\n        '));
      }
    }
  }

  // ── summary ──
  const summarise = (label, rs) => {
    if (!rs.length) return;
    const by = new Map();
    for (const r of rs) { const k = r.t.wp; if (!by.has(k)) by.set(k, { pass: 0, fail: 0 }); by.get(k)[r.ok ? 'pass' : 'fail']++; }
    console.log('\n' + label);
    for (const [wp, c] of Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
      console.log('  ' + wp.padEnd(6) + String(c.pass).padStart(4) + ' pass ' + String(c.fail).padStart(4) + ' fail' + (c.fail ? '   ✗' : '   ✓'));
    }
  };
  summarise('Per-WP summary (unit):', results.filter((r) => !r.t.integration));
  summarise('Per-WP summary (integration):', results.filter((r) => r.t.integration));
  const fails = results.filter((r) => !r.ok).length;
  if (!includeIntegration && integ.length) console.log('\n(' + integ.length + ' integration test(s) not run — add --integration)');
  console.log('\n' + (fails ? '[FAIL] ' + fails + ' of ' + results.length + ' failed' : '[ok] all ' + results.length + ' acceptance tests passed') +
              '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('[accept] runner crashed:', e && e.stack || e); process.exit(2); });
