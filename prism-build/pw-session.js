// prism-build/pw-session.js — browser-session helpers for the Playwright tools (help-shots.js).
//
// Copied from the GUI sweep (prism-build/gui-sweep.js: static server, library routes and request stubs,
// freshSession, navTo) so the screenshot tool does not edit the sweep (docs/HELP-GUIDE-PLAN.md §3.5).
// The sweep is not changed; after the simulator-equipment merge a clean-up may make it require this
// file too.
//
//   const S = require('./pw-session');
//   const pw = S.loadPlaywright();              // null when Playwright is not installed
//   const srv = await S.startServer({ root, pageHtml });   // { base, close() }
//   const browser = await S.launch(pw);
//   const s = await S.freshSession(browser, { base, viewport, phone, seed, initScripts, clock });
//   await S.navTo(s, 'orifice');
//
// No external requests ever leave the machine: analytics get an empty stub, the CDN libraries are served
// from ios-app/ios-additions/libs (byte-identical copies bundled for iOS), everything else is blocked.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIBS = path.join(ROOT, 'ios-app', 'ios-additions', 'libs');
const PAGE = 'well-testing-app.html';

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try the global install */ }
  try {
    const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return require(path.join(g, 'playwright'));
  } catch (e) { return null; }
}

// Chromium from /opt/pw-browsers when that exists (never `playwright install`).
function browsersPath() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  return process.env.PLAYWRIGHT_BROWSERS_PATH || '';
}

async function launch(pw) {
  browsersPath();
  const args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'];
  return pw.chromium.launch({ args });
}

// ── Static server ─────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.txt': 'text/plain' };

// opts.root (default the repository), opts.pageHtml: a string served at /well-testing-app.html instead of the
// file on disk (help-shots serves the in-memory build from the prism-build sources).
function serve(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || ROOT);
  return http.createServer((q, s) => {
    const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || PAGE;
    if (rel === PAGE && typeof opts.pageHtml === 'string') {
      s.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return s.end(opts.pageHtml);
    }
    const f = path.join(root, rel);
    if (!(f === root || f.startsWith(root + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    s.end(fs.readFileSync(f));
  });
}
async function startServer(opts) {
  const srv = serve(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  return { srv, base, close: () => new Promise((r) => srv.close(() => r())) };
}

// CDN files the app loads lazily → the byte-identical copies bundled for iOS.
const CDN_STUBS = [
  [/three(@[\d.]+)?\/build\/three\.module\.min\.js/, 'three.module.min.js', 'text/javascript'],
  [/sql\.js@[\d.]+\/dist\/sql-wasm\.js/, 'sql-wasm.js', 'text/javascript'],
  [/sql\.js@[\d.]+\/dist\/sql-wasm\.wasm/, 'sql-wasm.wasm', 'application/wasm'],
  [/sqlite-wasm@[^/]+\/dist\/index\.mjs/, 'sqlite3.mjs', 'text/javascript'],
  [/sqlite-wasm@[^/]+\/dist\/sqlite3\.wasm/, 'sqlite3.wasm', 'application/wasm'],
  [/html2canvas[^/]*\/.*html2canvas(\.min)?\.js/, 'html2canvas.min.js', 'text/javascript'],
  [/jspdf[^/]*\/.*jspdf\.umd(\.min)?\.js/, 'jspdf.umd.min.js', 'text/javascript'],
];

// Route every non-local request: analytics → empty stub, pinned CDN libraries → local copies, rest blocked.
// onExternal(url, action) is told about each one (optional).
async function routeExternal(ctx, onExternal) {
  const note = onExternal || (() => {});
  await ctx.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    const u = r.request().url();
    if (/googletagmanager|google-analytics/.test(u)) { note(u, 'stubbed'); return r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* analytics stub */' }); }
    for (const [rx, file, ct] of CDN_STUBS) if (rx.test(u) && fs.existsSync(path.join(LIBS, file))) {
      note(u, 'local:' + file);
      return r.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(path.join(LIBS, file)), headers: { 'access-control-allow-origin': '*' } });
    }
    note(u, 'blocked'); return r.abort('blockedbyclient');
  });
}

// ── Sessions ──────────────────────────────────────────────────────────────
// A fresh context (fresh storage) per session.
//   opts.base         server base URL (required)
//   opts.viewport     {width, height}
//   opts.phone        true → isMobile, hasTouch
//   opts.scale        deviceScaleFactor (default 1)
//   opts.seed         { key: value } written to localStorage before the app loads (strings; objects are JSON)
//   opts.initScripts  [fn | {fn, arg}] added with addInitScript after the seed
//   opts.contextOptions  extra newContext options (locale, timezoneId, reducedMotion, colorScheme …)
//   opts.clock        { mode: 'fixed'|'install', time: ISO string or ms }
//   opts.waitReady    (default true) wait for WTS_nav and the sidebar
async function freshSession(browser, opts) {
  const vp = opts.viewport || { width: 1280, height: 800 };
  const ctx = await browser.newContext(Object.assign({
    viewport: vp, deviceScaleFactor: opts.scale || 1, serviceWorkers: 'block', acceptDownloads: false,
  }, opts.phone ? { isMobile: true, hasTouch: true } : {}, opts.contextOptions || {}));
  const s = { ctx, page: null, errors: [], external: [], opts };
  await routeExternal(ctx, (u, a) => s.external.push({ url: u.replace(/\?.*$/, ''), action: a }));
  // The web build's analytics consent banner (GA block in <body>) would cover the bottom of every shot: store a
  // choice first ('denied' — analytics are stubbed anyway), unless the caller seeds wtspref_analytics_consent itself.
  await ctx.addInitScript(() => {
    try {
      if (!localStorage.getItem('wtspref_analytics_consent')) {
        localStorage.setItem('wtspref_analytics_consent', JSON.stringify({ choice: 'denied', v: 1, at: Date.now() }));
      }
    } catch (e) { /* storage unavailable */ }
  });
  const seed = opts.seed || {};
  await ctx.addInitScript((kv) => {
    try {
      if (sessionStorage.getItem('__pw_seeded')) return;      // seed once per tab (a reload keeps the user's state)
      Object.keys(kv).forEach((k) => localStorage.setItem(k, kv[k]));
      sessionStorage.setItem('__pw_seeded', '1');
    } catch (e) { /* storage unavailable */ }
  }, Object.keys(seed).reduce((o, k) => { o[k] = typeof seed[k] === 'string' ? seed[k] : JSON.stringify(seed[k]); return o; }, {}));
  for (const x of opts.initScripts || []) {
    if (typeof x === 'function') await ctx.addInitScript(x);
    else await ctx.addInitScript(x.fn, x.arg);
  }
  const p = s.page = await ctx.newPage();
  p.on('pageerror', (e) => s.errors.push({ type: 'pageerror', message: e.message, stack: e.stack }));
  p.on('dialog', (d) => { d.accept().catch(() => {}); });
  const clock = opts.clock;
  const t0 = clock ? new Date(clock.time).getTime() : 0;
  if (clock && clock.mode === 'install') {
    // Fake timers, paused from the start: nothing in the page runs unless the caller advances the clock
    // (s.advance / page.clock.runFor), so every run sees the same sequence of timers.
    // pauseAt alone (it installs the fake clock itself), NOT install() + pauseAt(): each new document replays the
    // clock log, and between an 'install' and a 'pauseAt' entry the replay advances the fake tick counter by the REAL
    // time that passed between the two calls. requestAnimationFrame is aligned to ticks % 16, so that real gap
    // (a few ms, more under load) changed the frame phase and the simulator's step count from run to run. With
    // pauseAt only, ticks start at 0 in every document; Date reads t0 + 1 s.
    await p.clock.pauseAt(t0 + 1000);
  } else if (clock && clock.mode === 'fixed') {
    await p.clock.setFixedTime(t0);   // only Date is fixed; timers and animation frames run normally
  }
  s.installed = !!(clock && clock.mode === 'install');
  // Advance time: the fake clock in install mode, a real wait otherwise.
  s.advance = (ms) => (s.installed ? p.clock.runFor(ms) : p.waitForTimeout(ms));
  // Render barrier (install mode): wait in REAL time for the next rendering update, with the fake clock still.
  // ResizeObserver / IntersectionObserver callbacks are delivered by the real rendering pipeline, not by timers;
  // observers the page created in the last task (a page mount, a click) are delivered in that same update. Without
  // the barrier they fire part-way through the next runFor, at a fake time that depends on machine load (seen as a
  // different simulator animation phase with 4 workers). No-op with the real clock.
  s.render = async () => {
    if (!s.installed) return;
    await Promise.race([
      p.evaluate(() => new Promise((done) => {
        let n = 0;
        const one = () => { if (++n === 2) done(true); };
        try {
          const ro = new ResizeObserver(() => { ro.disconnect(); one(); }); ro.observe(document.documentElement);
          const io = new IntersectionObserver(() => { io.disconnect(); one(); }); io.observe(document.documentElement);
        } catch (e) { done(false); }
      })).catch(() => false),
      sleep(5000),
    ]);
  };
  await p.goto(opts.base + PAGE, { waitUntil: 'load' });
  if (opts.waitReady !== false) {
    const ready = () => p.evaluate(() => typeof window.WTS_nav === 'function' && !!document.querySelector('.nav-btn')).catch(() => false);
    // Install mode: wait in REAL time with the fake clock still paused, so the fake time at which the caller starts
    // does not depend on how long the page took to load (machine load, worker count). Only when the app needs a timer
    // to start does the clock move, in fixed 100 ms steps that each wait for the real-time work to finish.
    const until = Date.now() + 30000;
    let fakeSteps = 0;
    while (!(await ready())) {
      if (Date.now() > until) throw new Error('the app did not start within 30 s');
      if (s.installed && Date.now() > until - 25000) {
        // 5 s of real time without readiness: the start needs timers. Advance by one fixed step and give the page
        // up to 2 s of real time to react before the next (the step count then depends on the app, not the load).
        await p.clock.runFor(100); fakeSteps++;
        const t = Date.now() + 2000;
        while (!(await ready()) && Date.now() < t) await sleep(50);
        if (fakeSteps > 200) throw new Error('the app did not start within 20 s of fake time');
      } else await sleep(50);
    }
    s.startSteps = fakeSteps;
    await s.render();
    await s.advance(500);   // a fixed amount of fake time after readiness
  }
  s.close = async () => { try { await ctx.close(); } catch (e) { /* ignore */ } };
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settleMs(route) { return route === 'prism' || route === 'dca' || route === 'pta' ? 1400 : route === 'wts' ? 1500 : /historian|wellos|modbus/.test(route) ? 700 : 300; }

// Navigate with the app's own router, then let it settle (fake clock in install mode, else a real wait).
async function navTo(s, route, opts) {
  opts = opts || {};
  await s.page.evaluate((r) => { window.WTS_nav(r); }, route);
  if (s.render) await s.render();
  const ms = opts.settle != null ? opts.settle : settleMs(route);
  if (s.advance) await s.advance(ms); else await s.page.waitForTimeout(ms);
}

module.exports = { ROOT, LIBS, PAGE, MIME, CDN_STUBS, loadPlaywright, browsersPath, launch, serve, startServer, routeExternal,
  freshSession, navTo, settleMs, sleep };
