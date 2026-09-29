#!/usr/bin/env node
// prism-build/perf-budget.js — startup-time and bundle-size budget (ROADMAP P6).
//
//   node prism-build/perf-budget.js              check against prism-build/perf-baseline.json
//   node prism-build/perf-budget.js --profile    also print the load cost of every source module
//   node prism-build/perf-budget.js --record     measure and (re)write the baseline
//   node prism-build/perf-budget.js --browser    also measure a real Chromium load (Playwright,
//                                                optional; report only — never part of the budget)
//   options: --runs N (default 7)  --json (machine-readable result)
//
// What is measured (all in Node, headless harness — no browser needed):
//   • bytes of well-testing-app.html, ios-app/www/index.html and the main <script>
//     (+ gzip size of the HTML, what a web server actually sends);
//   • startup = wall time of the main script evaluation + DOMContentLoaded + load
//     handlers + first render, in the tests/_harness.js realm (median of N runs,
//     after one warm-up run; compile time is reported separately);
//   • a CPU calibration loop, so the startup budget is checked as a RATIO
//     (fastest startup / fastest calibration run — best-of-N is far less sensitive
//     to other processes than a median) and survives a slower or faster machine.
//
// Budget (fails with exit code 1):
//   • any bundle > baseline × 1.10  (10 % growth);
//   • startup ratio > baseline ratio × 1.35 AND best startup > baseline best + 40 ms
//     (both conditions, so timer noise on a busy CI box does not trip it).
// Re-record the baseline (--record) only when a size/startup increase is intended.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const harness = require('./tests/_harness');

const REPO = harness.REPO;
const BASELINE = path.join(__dirname, 'perf-baseline.json');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; };
const RUNS = Math.max(3, +val('--runs', 7) || 7);
const SIZE_GROWTH = 1.10;
const START_RATIO = 1.35;
const START_SLACK_MS = 40;

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fileBytes = (rel) => { try { return fs.statSync(path.join(REPO, rel)).size; } catch (_) { return null; } };

// CPU calibration: a fixed mixed numeric/string/object workload.
function calibrate() {
  const once = () => {
    const t0 = nowMs();
    let acc = 0; const o = {}; const arr = [];
    for (let i = 0; i < 1500000; i++) {
      acc += Math.sqrt(i) * Math.log(i + 1);
      if ((i & 255) === 0) { o['k' + (i % 997)] = acc; arr.push(String(acc).slice(0, 8)); }
    }
    JSON.parse(JSON.stringify({ o, arr }));
    return nowMs() - t0 + (acc > 0 ? 0 : 1);
  };
  once(); once();
  const r = []; for (let i = 0; i < 9; i++) r.push(once());
  return Math.min.apply(null, r);            // best case: least disturbed by other load on the machine
}

// Insert a real-time mark after every '// ─── BEGIN/END <file>' line (statement
// boundaries between the concatenated modules) for the --profile table.
function instrument(html) {
  return html.replace(/^([ \t]*\/\/ ─── (BEGIN|END) ([\w.-]+)[^\n]*)$/gm,
    (m, line, be, f) => line + '\n;(typeof __wtsPerfMark === "function") && __wtsPerfMark(' + JSON.stringify(be + ' ' + f) + ');');
}

function loadOnce(html, marks) {
  const t0 = nowMs();
  const globals = marks ? { __wtsPerfMark: (n) => marks.push([n, nowMs()]) } : undefined;
  const app = harness.loadApp({ html, fromSources: false, timers: 'manual', console: 'capture', globals });
  const t1 = nowMs();
  // first idle: let the deferred init timers run (virtual clock) and time it too
  app.flush(0);
  const t2 = nowMs();
  const errs = app.errors.length;
  app.dispose();
  return { load: t1 - t0, idle0: t2 - t1, errors: errs };
}

function measure() {
  const html = fs.readFileSync(harness.HTML_PATH, 'utf8');
  const main = harness.extractMain(html);
  const tc = nowMs(); new vm.Script(main, { filename: 'wts-main.js' }); const compileMs = nowMs() - tc;
  loadOnce(html);                                  // warm-up (also compiles + caches the script)
  const loads = [], idles = []; let errors = 0;
  for (let i = 0; i < RUNS; i++) { const r = loadOnce(html); loads.push(r.load); idles.push(r.idle0); errors += r.errors; }
  const calib = calibrate();
  const startup = median(loads);
  return {
    date: new Date().toISOString().slice(0, 10),
    bytes: {
      html: fileBytes('well-testing-app.html'),
      www: fileBytes('ios-app/www/index.html'),
      mainScript: Buffer.byteLength(main, 'utf8'),
      htmlGzip: zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).length,
    },
    compileMs: +compileMs.toFixed(1),
    startupMs: +startup.toFixed(1),
    startupMinMs: +Math.min.apply(null, loads).toFixed(1),
    firstIdleMs: +median(idles).toFixed(1),
    calibMs: +calib.toFixed(2),
    startupRatio: +(Math.min.apply(null, loads) / calib).toFixed(2),   // best-of-N / best-of-9: robust on a shared CPU
    runs: RUNS,
    loadErrors: errors,
  };
}

function profile() {
  const html = instrument(fs.readFileSync(harness.HTML_PATH, 'utf8'));
  const agg = new Map();
  const N = Math.min(RUNS, 5);
  loadOnce(html, []);
  for (let r = 0; r < N; r++) {
    const marks = [];
    loadOnce(html, marks);
    const open = new Map();
    for (const [n, t] of marks) {
      const [be, f] = n.split(' ');
      if (be === 'BEGIN') open.set(f, t);
      else if (open.has(f)) { if (!agg.has(f)) agg.set(f, []); agg.get(f).push(t - open.get(f)); open.delete(f); }
    }
  }
  const rows = Array.from(agg.entries()).map(([f, a]) => [f, median(a)]).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, r) => s + r[1], 0);
  console.log('\nPer-module evaluation cost (median of ' + N + ' loads; module top-level code only):');
  for (const [f, ms] of rows) console.log('  ' + f.padEnd(34) + ms.toFixed(2).padStart(8) + ' ms');
  console.log('  ' + 'sum of modules'.padEnd(34) + total.toFixed(2).padStart(8) + ' ms');
  return rows;
}

function main() {
  const m = measure();
  if (flag('--json')) console.log(JSON.stringify(m, null, 2));
  else {
    console.log('[perf] html ' + (m.bytes.html / 1024).toFixed(0) + ' kB, www ' + (m.bytes.www / 1024).toFixed(0) +
      ' kB, main script ' + (m.bytes.mainScript / 1024).toFixed(0) + ' kB, html gzip ' + (m.bytes.htmlGzip / 1024).toFixed(0) + ' kB');
    console.log('[perf] compile ' + m.compileMs + ' ms; startup median ' + m.startupMs + ' ms (min ' + m.startupMinMs +
      ', ' + m.runs + ' runs); first idle flush ' + m.firstIdleMs + ' ms; calibration ' + m.calibMs + ' ms → ratio ' + m.startupRatio);
  }
  if (flag('--profile')) profile();
  if (flag('--browser')) return browser().then(() => finish(m));
  finish(m);
}

function finish(m) {
  if (m.loadErrors) { console.error('[FAIL] the app reported ' + m.loadErrors + ' error(s) while loading'); process.exit(1); }
  if (flag('--record')) {
    fs.writeFileSync(BASELINE, JSON.stringify(m, null, 2) + '\n');
    console.log('[perf] baseline written to ' + path.relative(REPO, BASELINE));
    return;
  }
  if (!fs.existsSync(BASELINE)) { console.log('[perf] no baseline — run with --record'); return; }
  const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const fails = [];
  for (const k of Object.keys(b.bytes)) {
    if (b.bytes[k] == null || m.bytes[k] == null) continue;
    const lim = Math.round(b.bytes[k] * SIZE_GROWTH);
    if (m.bytes[k] > lim) fails.push(k + ' is ' + m.bytes[k] + ' bytes > budget ' + lim + ' (baseline ' + b.bytes[k] + ' + 10 %)');
  }
  const ratioLim = b.startupRatio * START_RATIO;
  if (m.startupRatio > ratioLim && m.startupMinMs > b.startupMinMs + START_SLACK_MS) {
    fails.push('startup ' + m.startupMs + ' ms (ratio ' + m.startupRatio + ') > budget ratio ' + ratioLim.toFixed(2) +
      ' (baseline best ' + b.startupMinMs + ' ms, ratio ' + b.startupRatio + ')');
  }
  if (fails.length) { fails.forEach((f) => console.error('[FAIL] ' + f)); process.exit(1); }
  console.log('[ok] perf budget: bundles within +10 % of baseline (' + b.date + '), startup ratio ' + m.startupRatio +
    ' ≤ ' + ratioLim.toFixed(2));
}

// Optional real-engine numbers (Chromium via Playwright): DOMContentLoaded, script
// compile/evaluate and layout from a performance trace, per run, medians printed.
async function browser() {
  let pw = null;
  try { pw = require('playwright'); } catch (e) {
    try { pw = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch (e2) { pw = null; }
  }
  if (!pw) { console.log('[perf] --browser: playwright not installed — skipped'); return; }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  let b;
  try { b = await pw.chromium.launch(); } catch (e) { console.log('[perf] --browser: chromium not available — skipped (' + e.message.split('\n')[0] + ')'); return; }
  const os = require('os');
  const rows = [];
  const N = Math.min(RUNS, 5);
  for (let r = 0; r < N; r++) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.route(/^https?:/, (rt) => rt.abort());          // no analytics / network
    const tf = path.join(os.tmpdir(), 'wts-perf-trace-' + process.pid + '.json');
    await b.startTracing(page, { path: tf, categories: ['devtools.timeline', 'v8'] });
    await page.goto('file://' + harness.HTML_PATH, { waitUntil: 'load' });
    await page.waitForTimeout(150);
    const dcl = await page.evaluate(() => performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd);
    await b.stopTracing();
    const ev = JSON.parse(fs.readFileSync(tf, 'utf8')).traceEvents.filter((e) => e.ph === 'X' && e.dur);
    try { fs.unlinkSync(tf); } catch (e) { /* ignore */ }
    const sum = (n) => ev.filter((e) => e.name === n).reduce((s, e) => s + e.dur / 1000, 0);
    const nav = await page.evaluate(() => { const s = performance.now(); document.querySelector('.nav-btn[data-p="prism"]').click(); return performance.now() - s; });
    rows.push({ dcl, compile: sum('v8.compile'), evaluate: sum('EvaluateScript'), layout: sum('Layout'), parseHTML: sum('ParseHTML'), prismNav: nav });
    await ctx.close();
  }
  await b.close();
  const med = (k) => median(rows.map((x) => x[k])).toFixed(1);
  console.log('[perf] chromium (median of ' + N + '): DOMContentLoaded ' + med('dcl') + ' ms; ParseHTML ' + med('parseHTML') +
    ' ms; script compile ' + med('compile') + ' ms; EvaluateScript ' + med('evaluate') + ' ms; layout ' + med('layout') +
    ' ms; first PRiSM open ' + med('prismNav') + ' ms');
}

main();
