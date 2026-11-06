#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// build-user-guide.js — generates help/user-guide.html, the printable User Guide (docs/HELP-GUIDE-PLAN.md §5.1, WP-G).
//
// It builds the app from the prism-build sources (tests/_harness.js), applies the Help host edits in memory
// (help-host-patch.js, so the sidebar order is the released one before and after WP-I applies them to the host), runs
// WTS_help.load() and writes WTS_help.renderBook('all', {standalone: true, imgBase: 'img/'}): a self-contained page with
// inline A4 print CSS, a linked contents list, a page break per chapter and images relative to help/.
//
// The file is GENERATED — never edit it by hand. It is byte-stable: the date is RELEASE_NOTES[0].date (never the clock),
// the content order is the sidebar / factory order, there are no timestamps and the line endings are LF
// (.gitattributes: help/*.html text eol=lf). Regenerate it after every content change and after every screenshot run.
//
// Usage (from the repo root):
//   node prism-build/build-user-guide.js                 write help/user-guide.html
//   node prism-build/build-user-guide.js --check         exit 1 when the committed file differs (tests/help-guide-sync.test.js)
//   node prism-build/build-user-guide.js --out <file>    write somewhere else
//   node prism-build/build-user-guide.js --pdf <file>    also print a PDF (A4) with the Playwright engine, to a path OUTSIDE
//                                                        the repository (the owner's handout; no PDF is committed). Prints
//                                                        [skip] and exits 0 without Playwright.
// Exit codes: 0 ok, 1 out of date / content load error, 2 bad usage or tool error.
// require()-able: { OUT, build(opts) → {html, app}, check() → {ok, committed, built}, main }.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const harness = require('./tests/_harness');
const { patch } = require('./help-host-patch');

const OUT = path.join(harness.REPO, 'help', 'user-guide.html');

// opts.overrides: in-memory source overrides (tests); opts.html: a prebuilt app HTML (tests)
function build(opts) {
  opts = opts || {};
  const src = opts.html || harness.buildFromSources({ silent: true, overrides: opts.overrides }).html;
  const app = harness.loadApp({ html: patch(src), console: 'capture' });
  const H = app.win.WTS_help;
  if (!H || typeof H.renderBook !== 'function') throw new Error('WTS_help.renderBook is missing: is 49-calc-help-print.js in the build?');
  H.load();
  if (H.loadErrors && H.loadErrors.length) throw new Error('Help content did not load:\n  ' + H.loadErrors.join('\n  '));
  const html = String(H.renderBook('all', { standalone: true, imgBase: 'img/' })).replace(/\r\n?/g, '\n');
  return { html, app };
}

function check(opts) {
  const built = build(opts).html;
  const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  return { ok: committed === built, committed, built };
}

function firstDiff(a, b) {
  const x = String(a || '').split('\n'), y = String(b || '').split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return 'line ' + (i + 1) + ':\n  committed: ' + String(x[i]).slice(0, 160) + '\n  generated: ' + String(y[i]).slice(0, 160);
  return '';
}

async function pdf(html, out) {
  const rel = path.relative(harness.REPO, out);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) { console.error('[build-user-guide] --pdf must point outside the repository (no PDF is committed): ' + out); return 2; }
  const S = require('./pw-session');
  const pw = S.loadPlaywright();
  if (!pw) { console.log('[skip] Playwright is not installed: no PDF'); return 0; }
  const srv = await S.startServer({ root: harness.REPO });
  const browser = await S.launch(pw);
  try {
    const page = await browser.newPage();
    await page.route('**/help/user-guide.html*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(srv.base + 'help/user-guide.html', { waitUntil: 'load' });
    await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
    console.log('[ok] PDF written: ' + out);
    return 0;
  } finally { await browser.close(); await srv.close(); }
}

async function main(argv) {
  const a = argv.slice(2), val = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
  const known = ['--check', '--out', '--pdf'];
  const bad = a.filter((x, i) => x.startsWith('--') && known.indexOf(x) === -1 || (['--out', '--pdf'].indexOf(a[i - 1]) === -1 && !x.startsWith('--')));
  if (bad.length || (a.indexOf('--out') !== -1 && !val('--out')) || (a.indexOf('--pdf') !== -1 && !val('--pdf'))) {
    console.error('usage: node prism-build/build-user-guide.js [--check] [--out <file>] [--pdf <file outside the repository>]');
    return 2;
  }
  if (a.indexOf('--check') !== -1) {
    const r = check();
    if (r.ok) { console.log('[ok] help/user-guide.html is up to date (' + Buffer.byteLength(r.built) + ' bytes)'); return 0; }
    console.error('[fail] help/user-guide.html is ' + (r.committed == null ? 'missing' : 'out of date') + ': run node prism-build/build-user-guide.js' +
      (r.committed == null ? '' : '\n' + firstDiff(r.committed, r.built)));
    return 1;
  }
  const pdfOut = val('--pdf') ? path.resolve(val('--pdf')) : null, pr = pdfOut && path.relative(harness.REPO, pdfOut);
  if (pdfOut && !pr.startsWith('..') && !path.isAbsolute(pr)) { console.error('[build-user-guide] --pdf must point outside the repository (no PDF is committed): ' + pdfOut); return 2; }
  const { html } = build();
  const out = val('--out') ? path.resolve(val('--out')) : OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  console.log('[ok] wrote ' + path.relative(process.cwd(), out) + ' (' + Buffer.byteLength(html) + ' bytes)');
  return pdfOut ? pdf(html, pdfOut) : 0;
}

module.exports = { OUT, build, check, main };

if (require.main === module) {
  main(process.argv).then((c) => process.exit(c), (e) => { console.error('[build-user-guide] ' + (e && e.stack || e)); process.exit(e && /did not load|missing/.test(e.message) ? 1 : 2); });
}
