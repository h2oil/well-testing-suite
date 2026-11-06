#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// help-host-patch.js — host edits H1–H5 for the Help centre (docs/HELP-GUIDE-PLAN.md §2.2, D21).
//
// Help branches never edit well-testing-app.html by hand: this script holds the edits, the
// help-page test applies patch() in memory to a sources build, and WP-I runs the CLI once on the
// merged Dev and rebuilds. Every edit is anchored on stable text (never a line number), guarded by
// a done marker (/* help-host-patch:Hn */ or <!--help-host-patch:Hn-->) so a second run changes
// nothing, and keeps the file's line endings (CRLF or LF).
//
//   H1  __NAV_ORDER: 'help' after 'home' (Overview row 2)
//   H2  sidebar brand: "? Help" link (#sbHelp) inline after "What's new", wired like it, active state
//   H3  page header: #pgHelpBtn after the #pgTitle / #pgSub block (+ CSS); render() calls
//       WTS_help.syncHeader(page) before h2oil:pagechange
//   H4  #exportBtns hidden on `help` (as on home / clientinfo)
//   H5  Quick Report: route `help` in _REPORT_SKIP (never snapshotted)
//
// Usage (from the repo root):
//   node prism-build/help-host-patch.js            dry run: report only (the default — never writes)
//   node prism-build/help-host-patch.js --apply    patch well-testing-app.html in place
//   node prism-build/help-host-patch.js --file a.html --out b.html
// Exit code 0 when every edit is applied / applicable; 1 on an anchor problem; 2 on bad usage.
// require()-able: { EDITS, patch(html) → html, patchReport(html) → {out, report}, main }.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_HTML = path.join(path.resolve(__dirname, '..'), 'well-testing-app.html');
const M = (id) => '/* help-host-patch:' + id + ' */';
const MH = (id) => '<!--help-host-patch:' + id + '-->';

// Each edit: { id, marker, steps: [{ find, replace }] } — `find` must occur exactly once (LF form;
// matched in CRLF form too); the replacement text is written with the file's line ending.
const EDITS = [
  { id: 'H1', marker: M('H1'), steps: [{
    find: "const __NAV_ORDER = [\n    'home', 'clientinfo',",
    replace: "const __NAV_ORDER = [\n    'home', 'help', " + M('H1') + " 'clientinfo',",
  }] },
  { id: 'H2', marker: MH('H2'), steps: [
    {
      find: '&#128221; What&#8217;s new</button>',
      replace: '&#128221; What&#8217;s new</button>' + MH('H2') + '<span class="sb-sep" aria-hidden="true"> &#183; </span>' +
        '<button type="button" class="sb-relnotes" id="sbHelp" data-nav="help" title="Help and user guide">? Help</button>',
    },
    {
      find: "{ const rn = $('sbReleaseNotes'); if(rn && typeof rn.addEventListener === 'function') rn.addEventListener('click', ev => { ev.preventDefault(); nav('releasenotes'); }); }",
      replace: "{ const rn = $('sbReleaseNotes'); if(rn && typeof rn.addEventListener === 'function') rn.addEventListener('click', ev => { ev.preventDefault(); nav('releasenotes'); }); }\n" +
        "{ const hb = $('sbHelp'); if(hb && typeof hb.addEventListener === 'function') hb.addEventListener('click', ev => { ev.preventDefault(); nav('help'); }); }   " + M('H2'),
    },
    {
      find: "        if(page === 'releasenotes') rn.setAttribute('aria-current', 'page'); else rn.removeAttribute('aria-current');\n    }\n",
      replace: "        if(page === 'releasenotes') rn.setAttribute('aria-current', 'page'); else rn.removeAttribute('aria-current');\n    }\n" +
        "    const hb = $('sbHelp');   " + M('H2') + "\n" +
        "    if(hb && hb.classList) {\n" +
        "        hb.classList.toggle('active', page === 'help');\n" +
        "        if(page === 'help') hb.setAttribute('aria-current', 'page'); else hb.removeAttribute('aria-current');\n" +
        "    }\n",
    },
  ] },
  { id: 'H3', marker: MH('H3'), steps: [
    {
      find: '<div><h2 id="pgTitle">Dashboard</h2><p id="pgSub">Select a module to get started</p></div>',
      replace: '<div class="pg-head">' + MH('H3') + '<div><h2 id="pgTitle">Dashboard</h2><p id="pgSub">Select a module to get started</p></div>' +
        '<button type="button" id="pgHelpBtn" class="pg-help" aria-label="Help for this page" title="Help for this page (F1)" hidden>?</button></div>',
    },
    {
      find: "        .sb-relnotes.active { color: var(--accent); font-weight: 600; text-decoration: none; }\n",
      replace: "        .sb-relnotes.active { color: var(--accent); font-weight: 600; text-decoration: none; }\n" +
        "        .sb-sep { color: var(--text3); font-size: 11px; }   " + M('H3') + "\n" +
        "        .pg-head { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }\n" +
        "        .pg-head > div { min-width: 0; }\n" +
        "        .pg-help { flex: none; width: 28px; height: 28px; margin-top: 1px; border-radius: 50%; border: 1px solid var(--border); background: var(--bg2);\n" +
        "            color: var(--text2); font: inherit; font-size: 15px; font-weight: 700; line-height: 1; cursor: pointer; padding: 0; }\n" +
        "        .pg-help:hover, .pg-help:focus-visible { color: var(--accent); border-color: var(--accent); }\n" +
        "        .pg-help[hidden] { display: none; }\n",
    },
    {
      find: "    // Notify analytics + any other listeners that the SPA has navigated.\n",
      replace: "    try { if(window.WTS_help && typeof window.WTS_help.syncHeader === 'function') window.WTS_help.syncHeader(page); } catch(e) {}   " + M('H3') + "\n" +
        "    // Notify analytics + any other listeners that the SPA has navigated.\n",
    },
  ] },
  { id: 'H4', marker: M('H4'), steps: [{
    find: "if(eb) eb.style.display = (page==='home'||page==='clientinfo') ? 'none' : 'flex';",
    replace: "if(eb) eb.style.display = (page==='home'||page==='clientinfo'||page==='help') ? 'none' : 'flex';   " + M('H4'),
  }] },
  { id: 'H5', marker: M('H5'), steps: [{
    find: 'const _REPORT_SKIP = { home:1, clientinfo:1,',
    replace: 'const _REPORT_SKIP = { home:1, help:1, ' + M('H5') + ' clientinfo:1,',
  }] },
];

function count(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; }

function patchReport(html) {
  const crlf = html.includes('\r\n');
  const eol = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  let out = html;
  const report = [];
  for (const e of EDITS) {
    if (out.includes(e.marker)) { report.push({ id: e.id, status: 'already' }); continue; }
    const probs = [];
    for (const s of e.steps) { const n = count(out, eol(s.find)); if (n !== 1) probs.push('anchor found ' + n + '× : ' + s.find.split('\n')[0].slice(0, 70)); }
    if (probs.length) { report.push({ id: e.id, status: 'anchor', detail: probs.join(' | ') }); continue; }
    for (const s of e.steps) out = out.replace(eol(s.find), () => eol(s.replace));
    report.push({ id: e.id, status: 'applied' });
  }
  return { out, report };
}
function patch(html) {
  const r = patchReport(html);
  const bad = r.report.filter((x) => x.status === 'anchor');
  if (bad.length) throw new Error('[help-host-patch] ' + bad.map((x) => x.id + ': ' + x.detail).join('; '));
  return r.out;
}

const USAGE = 'usage: node prism-build/help-host-patch.js [--apply] [--file in.html] [--out out.html] [--json]';
function main(argv) {
  argv = argv || process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
  const known = new Set(['--apply', '--file', '--out', '--json', '--help', '-h']);
  const bad = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !(i > 0 && (argv[i - 1] === '--file' || argv[i - 1] === '--out')));
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  if (bad.length) { console.error('[help-host-patch] unknown option ' + bad[0] + '\n' + USAGE); process.exitCode = 2; return 2; }
  const file = val('--file') ? path.resolve(val('--file')) : DEFAULT_HTML;
  const outFile = val('--out') ? path.resolve(val('--out')) : (argv.includes('--apply') ? file : null);
  const html = fs.readFileSync(file, 'utf8');
  const { out, report } = patchReport(html);
  const probs = report.filter((r) => r.status === 'anchor');
  if (argv.includes('--json')) console.log(JSON.stringify({ file, report }, null, 1));
  else {
    console.log('[help-host-patch] ' + (outFile ? '' : 'CHECK (dry run) ') + file);
    report.forEach((r) => console.log('  ' + r.status.padEnd(9) + r.id + (r.detail ? '  ' + r.detail : '')));
  }
  if (probs.length) { process.exitCode = 1; return 1; }
  if (outFile) {
    if (out !== html || outFile !== file) { fs.writeFileSync(outFile, out, 'utf8'); console.log('[ok] wrote ' + outFile); }
    else console.log('[ok] nothing to change');
  }
  return 0;
}

module.exports = { EDITS, patch, patchReport, main, USAGE };
if (require.main === module) main();
