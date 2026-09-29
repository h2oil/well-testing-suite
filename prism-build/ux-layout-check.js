#!/usr/bin/env node
// prism-build/ux-layout-check.js — real-engine phone layout check for the v3.0 navigation UX.
//
// Serves the web page (well-testing-app.html) and the generated iOS bundle (sync-from-main.js into
// a scratch folder) and drives Playwright at phone and desktop widths:
//   1. phone (375 px; --full adds 320 / 390 / 430): dashboard, the open sidebar drawer (search box,
//      group headings) and every route — no page-level horizontal overflow (document / #pgBody
//      scrollWidth, or a control / card outside the viewport and not inside its own scroller);
//   2. stacked input tables at 375 px: every table.wts-stack is a block of row cards (each body row
//      display:block, cells display:flex with a data-label ::before), its header row is clipped
//      (still in the DOM), and every control sits inside the viewport;
//   3. desktop (1280 px): the same tables keep display:table and a visible header (web layout
//      unchanged above 600 px), and the page report model (collectPageReport) equals the one taken
//      at 375 px — the card layout does not change what the PDF / PNG / CSV / Copy exports capture.
// Engines: Chromium for the web page, WebKit with a native Capacitor stub (html.ios-app) for the iOS
// bundle. Options: --web / --ios (one target), --quick (dashboard + input-table pages only),
// --full (more phone widths), --shots <dir> (PNG screenshots), --json (machine-readable summary).
// Needs Playwright (+ browsers); prints "[skip] …" and exits 0 without it. Exit 1 on any failure.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try the global install */ }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const JSON_OUT = has('--json');
const say = (s) => { if (!JSON_OUT) console.log(s); };
const pw = loadPlaywright();
if (!pw) { if (JSON_OUT) console.log(JSON.stringify({ skipped: 'playwright not installed' })); else console.log('[skip] playwright not installed'); process.exit(0); }
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const ROOT = path.resolve(__dirname, '..');
const QUICK = has('--quick');
const PHONE = has('--full') ? [320, 375, 390, 430] : [375];
const SHOTS = arg('--shots');
const TABLE_ROUTES = ['wts', 'pipelife', 'flowline', 'lineheat', 'proving', 'sepqc', 'gasdeliv', 'oilipr'];
const targets = [];
if (!has('--ios')) targets.push({ name: 'web', engine: 'chromium', ios: false });
if (!has('--web')) targets.push({ name: 'ios', engine: 'webkit', ios: true });

const iosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-uxchk-'));
if (targets.some((t) => t.ios)) {
  execFileSync(process.execPath, [path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js')],
    { env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: iosDir }), stdio: 'ignore' });
}
function serve(dir, index) {
  return http.createServer((q, s) => {
    let rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || index;
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
    s.end(fs.readFileSync(f));
  });
}

async function open(browser, t, width, port) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width, height: 820 }, deviceScaleFactor: 1 },
    width < 700 ? { isMobile: t.engine !== 'firefox', hasTouch: true } : {},
    t.ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } : {}));
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  if (t.ios) await p.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
  await p.goto('http://127.0.0.1:' + port + '/' + (t.ios ? 'index.html' : 'well-testing-app.html'));
  await p.waitForTimeout(600);
  return { ctx, p };
}
const go = (p, r) => p.evaluate((r) => { const b = document.querySelector('.nav-btn[data-p="' + r + '"]'); if (b) b.click(); else window.__nav && window.__nav(r); }, r);

// Runs in the page: horizontal overflow of the page / #pgBody and stray controls.
function measure() {
  const vw = document.documentElement.clientWidth, pb = document.getElementById('pgBody');
  const bad = [];
  const scroller = (e) => { for (let a = e.parentElement; a && a !== pb; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
  pb.querySelectorAll('input, select, textarea, table, .card, .fg-item, .dash-card, .dash-mini, button').forEach((e) => {
    if (e.closest('#wts_viz')) return;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || cs.display === 'none' || cs.visibility === 'hidden') return;
    if ((r.right > vw + 1 || r.left < -1) && !scroller(e)) bad.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''));
  });
  const over = document.documentElement.scrollWidth > vw + 1 || pb.scrollWidth > pb.clientWidth + 1;
  return { over, docW: document.documentElement.scrollWidth, vw, pbW: pb.scrollWidth, pbCW: pb.clientWidth, bad: bad.slice(0, 6), nBad: bad.length };
}
// Runs in the page: the stacked-table contract at the current width.
function reportModel() {
  const m = window.collectPageReport(document.getElementById('pgBody'), { charts: false });
  delete m.date;
  return JSON.stringify(m);
}
function tableState() {
  const vw = document.documentElement.clientWidth;
  return Array.from(document.querySelectorAll('#pgBody table.wts-stack')).map((t) => {
    const head = t.tHead || t.querySelector('tr.wts-stack-head');
    const hr = head ? head.getBoundingClientRect() : null;
    const rows = Array.from(t.rows).filter((r) => r !== head && r.parentElement !== t.tHead);
    const cells = rows.flatMap((r) => Array.from(r.cells));
    const labelled = cells.filter((c) => c.hasAttribute('data-label'));
    const before = labelled.filter((c) => !c.classList.contains('wts-stack-title') && getComputedStyle(c, '::before').content.replace(/^"|"$/g, '') === c.getAttribute('data-label'));
    const ctls = Array.from(t.querySelectorAll('input, select, textarea')).filter((c) => c.getBoundingClientRect().width);
    return {
      id: t.id || '', display: getComputedStyle(t).display,
      rowsBlock: rows.every((r) => getComputedStyle(r).display === 'block'),
      cellsFlex: cells.filter((c) => getComputedStyle(c).display !== 'none').every((c) => getComputedStyle(c).display === 'flex'),
      headHidden: !!hr && hr.width <= 1 && hr.height <= 1,
      headVisible: !!hr && hr.width > 20 && hr.height > 5,
      labelled: labelled.length, cells: cells.length, beforeOk: before.length, needBefore: labelled.filter((c) => !c.classList.contains('wts-stack-title')).length,
      ctlOutside: ctls.filter((c) => { const r = c.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).length,
      tableW: Math.round(t.getBoundingClientRect().width), vw,
    };
  });
}

(async () => {
  const srvWeb = serve(ROOT, 'well-testing-app.html'), srvIos = serve(iosDir, 'index.html');
  await new Promise((r) => srvWeb.listen(0, r)); await new Promise((r) => srvIos.listen(0, r));
  const reports = {};
  const fails = [], summary = { checks: 0, targets: {} };
  const fail = (m) => { fails.push(m); say('  FAIL ' + m); };
  try {
    for (const t of targets) {
      let browser;
      try { browser = await pw[t.engine].launch(); }
      catch (e) { say('[skip] ' + t.engine + ' not available: ' + String(e.message).split('\n')[0]); summary.targets[t.name] = 'skipped'; continue; }
      const port = (t.ios ? srvIos : srvWeb).address().port;
      const st = summary.targets[t.name] = { routes: 0, tables: 0, overflow: 0 };
      try {
        for (const w of PHONE) {
          const { ctx, p } = await open(browser, t, w, port);
          // dashboard
          await go(p, 'home'); await p.waitForTimeout(150);
          let m = await p.evaluate(measure); summary.checks++;
          if (m.over || m.nBad) { st.overflow++; fail(t.name + ' ' + w + 'px home overflow ' + JSON.stringify(m)); }
          const dash = await p.evaluate(() => ({ search: !!document.getElementById('dash_search'), groups: document.querySelectorAll('.dash-sec[data-group]').length,
            cards: document.querySelectorAll('.dash-card').length, sr: document.getElementById('dash_search').getBoundingClientRect().right, vw: document.documentElement.clientWidth }));
          summary.checks++;
          if (!dash.search || dash.groups < 6 || dash.cards < 40 || dash.sr > dash.vw) fail(t.name + ' ' + w + 'px dashboard ' + JSON.stringify(dash));
          if (SHOTS) await p.screenshot({ path: path.join(SHOTS, t.name + '-' + w + '-home.png'), fullPage: false });
          // sidebar drawer (phone): search box and group headings inside the drawer and the screen
          const sb = await p.evaluate(() => {
            if (window.toggleMobileSidebar) window.toggleMobileSidebar();
            const s = document.getElementById('sidebar'), i = document.getElementById('sb_search'), vw = document.documentElement.clientWidth;
            const sr = s.getBoundingClientRect(), ir = i.getBoundingClientRect();
            const labels = Array.from(s.querySelectorAll('.nav-group-label')).map((l) => l.getBoundingClientRect());
            return { shown: getComputedStyle(s).display !== 'none', sbRight: sr.right, vw, inLeft: ir.left, inRight: ir.right,
              labelsIn: labels.every((r) => r.right <= sr.right + 1 && r.left >= sr.left - 1), sbOverflowX: s.scrollWidth > s.clientWidth + 1, labelH: Math.min.apply(null, labels.map((r) => r.height)) };
          });
          summary.checks++;
          if (!sb.shown || sb.sbRight > sb.vw + 1 || sb.inRight > sb.sbRight + 1 || sb.inLeft < 0 || !sb.labelsIn || sb.sbOverflowX || (t.ios && sb.labelH < 43.5)) fail(t.name + ' ' + w + 'px sidebar ' + JSON.stringify(sb));
          if (SHOTS) await p.screenshot({ path: path.join(SHOTS, t.name + '-' + w + '-sidebar.png') });
          await p.evaluate(() => { if (window.closeMobileSidebar) window.closeMobileSidebar(); });
          // routes
          const all = await p.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('.nav-btn[data-p]')).map((b) => b.dataset.p))));
          const routes = QUICK ? TABLE_ROUTES.filter((r) => all.includes(r)) : all;
          for (const r of routes) {
            await go(p, r); await p.waitForTimeout(r === 'wts' || r === 'prism' ? 900 : 200);
            m = await p.evaluate(measure); st.routes++; summary.checks++;
            if (m.over || m.nBad) { st.overflow++; fail(t.name + ' ' + w + 'px ' + r + ' overflow ' + JSON.stringify(m)); }
            if (TABLE_ROUTES.includes(r)) {
              const ts = await p.evaluate(tableState); summary.checks++;
              if (w === 375) reports[t.name + ':' + r] = await p.evaluate(reportModel);
              if (!ts.length) fail(t.name + ' ' + w + 'px ' + r + ': no stacked input table');
              ts.forEach((x) => {
                st.tables++;
                if (x.display !== 'block' || !x.rowsBlock || !x.cellsFlex || !x.headHidden || x.labelled < 2 || x.beforeOk !== x.needBefore || x.ctlOutside || x.tableW > x.vw)
                  fail(t.name + ' ' + w + 'px ' + r + ' table ' + JSON.stringify(x));
              });
              if (SHOTS && ts.length) await p.locator('#pgBody table.wts-stack').first().screenshot({ path: path.join(SHOTS, t.name + '-' + w + '-' + r + '.png') });
            }
          }
          await ctx.close();
        }
        // desktop: tables keep the table layout
        const { ctx, p } = await open(browser, t, 1280, port);
        for (const r of TABLE_ROUTES) {
          await go(p, r); await p.waitForTimeout(r === 'wts' ? 900 : 200);
          const ts = await p.evaluate(tableState); summary.checks++;
          const rep = await p.evaluate(reportModel), key = t.name + ':' + r;
          if (reports[key] != null) { summary.checks++; if (reports[key] !== rep) fail(t.name + ' ' + r + ': report model at 375 px differs from 1280 px'); }
          ts.forEach((x) => { if (x.display === 'block' && !t.ios || x.rowsBlock || !x.headVisible) fail(t.name + ' 1280px ' + r + ' table changed on desktop ' + JSON.stringify(x)); });
          if (t.ios) ts.forEach((x) => { if (x.rowsBlock || !x.headVisible) fail(t.name + ' 1280px ' + r + ' rows stacked on a wide screen'); });
        }
        await ctx.close();
      } finally { await browser.close(); }
      say('[' + t.name + '] ' + st.routes + ' route checks, ' + st.tables + ' stacked tables, ' + st.overflow + ' with overflow');
    }
  } finally {
    srvWeb.close(); srvIos.close();
    try { fs.rmSync(iosDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
  summary.fails = fails;
  if (JSON_OUT) console.log(JSON.stringify(summary));
  else console.log(fails.length ? '[FAIL] ' + fails.length + ' layout problem(s)' : '[ok] UX layout check (' + summary.checks + ' checks)');
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
