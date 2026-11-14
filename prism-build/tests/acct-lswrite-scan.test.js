// Accounts WP-H — static scan of raw localStorage writes (docs/ACCOUNTS-PLAN.md §5.4 H1 / H2, §12.2).
//
//   LS1  prism-build/[0-9][0-9]-*.js (self-test tails stripped like the concat): every raw setItem / removeItem call is either
//        in a file of the allow-listed workstreams (simulator 31 / 32 / 38, DFIT 56–59 and its helpers, the account files
//        66–68 whose keys are not wts_ / h2oil_ keys) or sits on a line marked `ls-raw:` (the H2 fallback for the smoke stub,
//        the storage.write load path, the availability probe, the mid-switch write that notifies) — and the number of marked
//        lines per file equals the table below, so a new raw write needs a reviewed table change.
//   LS2  the host well-testing-app.html outside the injection sentinels: only the H1 helpers write raw (marked, counted), and
//        WTS_lsSet / WTS_lsRemove exist next to __lsSet.
'use strict';

const fs = require('fs');
const path = require('path');
const { stripSelfTest } = require('../concat-round8');

const WP = 'WP-H';
const BUILD = path.join(__dirname, '..');
const HTML = path.join(BUILD, '..', 'well-testing-app.html');
const RAW_RE = /\.\s*(setItem|removeItem)\s*\(/;
const quiet = { log() {}, warn() {}, error() {} };

// Files owned by other workstreams or with no wts_ / h2oil_ key: raw calls allowed (the sync's key-hash check covers them).
const ALLOW_FILES = {
  '31-wts-sim.js': 'simulator workstream (wts_sim_rigup is caught by the key-hash check, D9)',
  '32-wts-3d.js': 'simulator workstream',
  '38-wts-live.js': 'simulator workstream',
  '56-prism-dfit-core.js': 'DFIT (shipped v3.4; not edited by the accounts work)',
  '57-prism-dfit-aca.js': 'DFIT',
  '58-prism-dfit-leakoff.js': 'DFIT',
  '59-prism-dfit-ui.js': 'DFIT (wts_prism_mrate / HF cache; caught by the key-hash check)',
  '48-calc-wellbore.js': 'DFIT helper',
  '49-calc-dfit-cal.js': 'DFIT helper', '49-calc-dfit-info.js': 'DFIT helper',
  '49-calc-dfit-synth.js': 'DFIT helper', '49-calc-dfit-triage.js': 'DFIT helper',
  '66-account.js': 'account client: wtsacct_ / wtspref_ device keys only (never synced)',
  '67-cloud-sync.js': 'account client', '68-account-page.js': 'account client', '69-account-admin.js': 'account client (no storage writes)',
};
// Marked raw lines per file (`ls-raw:` on the line). Fallbacks run only when the host's WTS_lsSet / WTS_lsRemove is absent.
const MARKED = {
  '01-foundation.js': 4, '04-ui-wiring.js': 1, '07-data-enhancements.js': 5, '10-specialised-solvers.js': 1,
  '12-data-crop.js': 2, '16-pvt.js': 1, '19-data-managers.js': 6, '22-units.js': 3, '27-pipelife.js': 1,
  '29-multiwell.js': 4, '29-project-save.js': 6, '33-pta-core.js': 3, '35-rta-dca.js': 1, '36-report.js': 1,
  '37-prism-workflow.js': 2, '39-prism-fieldtools.js': 1, '47-calc-historian.js': 1, '49-calc-buildup-store.js': 1,
  '49-calc-help.js': 1, '50-a11y.js': 1, '51-prism-workspace.js': 2, '54-prism-skin.js': 1, '61-modbus-station.js': 1,
  '63-wellos.js': 1, '49-calc-wp-model.js': 1, '49-calc-welldyn.js': 1,
};
const HOST_MARKED = 6;   // __lsSet, __lsSetRaw, __lsRemove, the two snapshot-eviction writes inside __lsSet, and the analytics
                         // consent choice (wtspref_analytics_consent, head GA block: runs before WTS_lsSet exists; a device pref)

function rawLines(src) {
  const out = [];
  src.split(/\r?\n/).forEach((ln, i) => {
    if (!RAW_RE.test(ln)) return;
    if (/sessionStorage/.test(ln)) return;          // session storage is never synced
    const code = ln.replace(/\/\/.*$/, '').trim();
    if (/^\*|^\/\*/.test(code) || !RAW_RE.test(code.replace(/\/\*.*?\*\//g, ''))) return;   // comment-only line
    out.push({ line: i + 1, text: ln.trim(), marked: /ls-raw:/.test(ln) });
  });
  return out;
}

module.exports = [
  {
    name: 'LS1 prism-build: no raw setItem / removeItem outside the allow-list; marked fallbacks counted per file', wp: WP, opts: false,
    run(app, assert) {
      const files = fs.readdirSync(BUILD).filter((f) => /^[0-9][0-9]-.*\.js$/.test(f)).sort();
      assert(files.length > 100, 'scanned ' + files.length + ' files');
      const bad = [], counts = {};
      for (const f of files) {
        if (ALLOW_FILES[f]) continue;
        const src = stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, quiet);
        for (const r of rawLines(src)) {
          if (!r.marked) bad.push(f + ':' + r.line + '  ' + r.text.slice(0, 140));
          else counts[f] = (counts[f] || 0) + 1;
        }
      }
      assert.deepStrictEqual(bad, [], 'raw writes not moved onto WTS_lsSet / WTS_lsRemove (H2):\n  ' + bad.join('\n  '));
      assert.deepStrictEqual(counts, MARKED, 'marked raw lines per file (update the table only after review)');
      // every marked fallback is a real fallback: the same line or the one above names WTS_lsSet / WTS_lsRemove
      for (const f of Object.keys(MARKED)) {
        const lines = stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, quiet).split(/\r?\n/);
        lines.forEach((ln, i) => {
          if (!/ls-raw: fallback/.test(ln)) return;
          const near = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
          assert(/WTS_ls(Set|Remove)/.test(near), f + ':' + (i + 1) + ' is marked as a fallback but no WTS_lsSet / WTS_lsRemove is next to it');
        });
      }
    },
  },
  {
    name: 'LS2 host outside the injection sentinels: only the H1 helpers write raw; WTS_lsSet / WTS_lsRemove exported', wp: WP, opts: false,
    run(app, assert) {
      const html = fs.readFileSync(HTML, 'utf8');
      const lines = html.split(/\r?\n/);
      let inj = false;
      const host = [];
      lines.forEach((ln, i) => {
        if (/injection START ──/.test(ln)) { inj = true; return; }
        if (/injection END ──/.test(ln)) { inj = false; return; }
        if (!inj) host.push(ln); else host.push('');
      });
      const raw = rawLines(host.join('\n'));
      const bad = raw.filter((r) => !r.marked).map((r) => r.line + '  ' + r.text.slice(0, 140));
      assert.deepStrictEqual(bad, [], 'host raw writes:\n  ' + bad.join('\n  '));
      assert.strictEqual(raw.length, HOST_MARKED, 'marked host lines');
      assert(/window\.WTS_lsSet = \(key, value, opts\) =>/.test(html), 'WTS_lsSet');
      assert(/window\.WTS_lsRemove = \(key\) => __lsRemove\(key\);/.test(html), 'WTS_lsRemove');
      assert(/'wts:ls-write'/.test(html), 'wts:ls-write event');
    },
  },
];
