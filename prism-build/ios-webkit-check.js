#!/usr/bin/env node
// prism-build/ios-webkit-check.js — optional real-engine QA of the generated iOS bundle.
//
// Regenerates ios-app/www into a scratch folder (sync-from-main.js with WTS_SYNC_OUT_DIR), serves it,
// and drives Playwright's WebKit with iPhone emulation and a native Capacitor stub
// (window.Capacitor.isNativePlatform() → true, so html.ios-app and the native loader apply):
//   1. layout sweep — every sidebar route at 320/375/390/430/744/820/1024 px: page-level horizontal
//      overflow (#pgBody / document scrollWidth > clientWidth, or controls outside the viewport and
//      not inside their own scroller) and text controls whose computed font-size is < 16 px;
//   2. 3D — the Well Test Simulator page mounts the WebGL view through the native loader;
//   3. lifecycle — three WebGL context losses across app-backgrounded / app-foregrounded cycles
//      leave the view in 3D.
// `--web` runs the same sweep without the Capacitor stub (expects the web layout, reports only).
// Needs Playwright + WebKit (`npx playwright install webkit`); prints "[skip]" and exits 0 without it.
// Not part of accept-test (CPU/browser heavy); run it before shipping iOS layout or 3D changes.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try the global install */ }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}
const pw = loadPlaywright();
if (!pw) { console.log('[skip] playwright not installed'); process.exit(0); }
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const ROOT = path.resolve(__dirname, '..');
const WEB = process.argv.includes('--web');
const WIDTHS = [320, 375, 390, 430, 744, 820, 1024];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-ioswk-'));
execFileSync(process.execPath, [path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js')], { env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: out }), stdio: 'ignore' });

const srv = http.createServer((q, s) => {
  const f = path.join(out, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(out) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); s.end(fs.readFileSync(f));
});

async function page(browser, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
  const p = await ctx.newPage();
  if (!WEB) await p.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
  await p.goto('http://127.0.0.1:' + srv.address().port + '/index.html');
  await p.waitForTimeout(800);
  return { ctx, p };
}
const go = (p, r) => p.evaluate((r) => { const b = document.querySelector('.nav-btn[data-p="' + r + '"]'); if (b) b.click(); }, r);

function measure() {
  const vw = document.documentElement.clientWidth, pb = document.getElementById('pgBody');
  const bad = [], small = [];
  const scroller = (e) => { for (let a = e.parentElement; a && a !== pb; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
  pb.querySelectorAll('input, select, textarea, table, .card, .fg-item, pre, button').forEach((e) => {
    if (e.closest('#wts_viz')) return;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || cs.display === 'none' || cs.visibility === 'hidden') return;
    if ((r.right > vw + 1 || r.left < -1) && !scroller(e)) bad.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''));
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !/^(checkbox|radio|range|file|button|submit|reset|color|hidden|image)$/.test(e.type) && parseFloat(cs.fontSize) < 16)
      small.push((e.id || e.tagName.toLowerCase()) + ' ' + cs.fontSize);
  });
  const over = document.documentElement.scrollWidth > vw + 1 || pb.scrollWidth > pb.clientWidth + 1;
  return { over, pbW: pb.scrollWidth, pbCW: pb.clientWidth, bad: bad.slice(0, 5), nBad: bad.length, small: small.slice(0, 3), nSmall: small.length };
}

srv.listen(0, async () => {
  let browser, fails = 0;
  try { browser = await pw.webkit.launch(); }
  catch (e) { console.log('[skip] WebKit not available: ' + String(e.message).split('\n')[0]); srv.close(); return; }
  try {
    // 1. layout sweep
    let n = 0, over = 0, small = 0;
    for (const w of WIDTHS) {
      const { ctx, p } = await page(browser, w);
      const routes = Array.from(new Set(await p.evaluate(() => Array.from(document.querySelectorAll('.nav-btn[data-p]')).map((b) => b.dataset.p))));
      for (const r of routes) {
        await go(p, r); await p.waitForTimeout(r === 'wts' || r === 'prism' ? 1200 : 250);
        const m = await p.evaluate(measure); n++;
        if (m.over || m.nBad) { over++; console.log('  overflow ' + w + 'px ' + r + ' ' + JSON.stringify(m)); }
        if (m.nSmall) { small++; if (!WEB) console.log('  small font ' + w + 'px ' + r + ' ' + m.small.join(', ')); }
      }
      await ctx.close();
    }
    console.log('[sweep] ' + n + ' route×width checks: ' + over + ' with page overflow, ' + small + ' with controls < 16px' + (WEB ? ' (web layout, report only)' : ''));
    if (!WEB && (over || small)) fails++;
    if (!WEB) {
      // 2 + 3. 3D mount and lifecycle
      const { ctx, p } = await page(browser, 390);
      await go(p, 'wts');
      const r3 = await p.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const cv = () => document.querySelector('#wts_viz canvas.wts3d-canvas');
        const mode = () => document.getElementById('wts_viz').getAttribute('data-mode');
        for (let i = 0; i < 80 && !(cv() && !document.getElementById('wts_viz').classList.contains('loading3d')); i++) await wait(250);
        const res = { mounted: !!cv() && mode() === '3d', info: window.WTS_3d.loadInfo && window.WTS_3d.loadInfo(), after: [] };
        for (let k = 0; k < 3 && res.mounted; k++) {
          const c = cv(); document.dispatchEvent(new Event('app-backgrounded'));
          const ext = c.getContext('webgl2').getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
          await wait(300); document.dispatchEvent(new Event('app-foregrounded'));
          for (let i = 0; i < 40 && !(cv() && cv() !== c); i++) await wait(250);
          await wait(500); res.after.push(mode() + (cv() && !cv().getContext('webgl2').isContextLost() ? '+live' : ''));
        }
        return res;
      });
      console.log('[3d] mounted=' + r3.mounted + ' loader=' + JSON.stringify(r3.info) + ' after losses=' + r3.after.join(','));
      if (!r3.mounted || !r3.info || r3.info.route !== 'native-direct' || r3.after.some((x) => x !== '3d+live')) fails++;
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  console.log(fails ? '[FAIL] iOS WebKit check' : '[ok] iOS WebKit check');
  process.exitCode = fails ? 1 : 0;
});
