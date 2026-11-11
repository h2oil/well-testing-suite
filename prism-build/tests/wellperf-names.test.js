// Well Performance naming rule — docs/WELL-PERFORMANCE-PLAN.md §2.11 and D15 (WP0).
//
// Method keys, labels, help text, code comments, tests, the validate tool and the plan name methods by their authors or by a
// descriptive name only — never a commercial product, a software vendor or a company. This test greps every Well Performance file
// (tests/_wellperf-shapes.js files()) for a banned-name list. The list is built from character codes so that no name is written in
// the repository; CI = matched as a word in any letter case, CS = matched as a word in this exact case (short acronyms).
// Optional: WTS_WELLPERF_DENYLIST=<file outside the repository> — one more name per line (any case, as words).
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_wellperf-shapes');

const WP = 'WP0';
const cc = (a) => String.fromCharCode.apply(null, a);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const CI = [
  [80,82,79,83,80,69,82], [80,73,80,69,83,73,77], [87,101,108,108,70,108,111], [77,66,65,76], [79,76,71,65], 
  [76,101,100,97,70,108,111,119], [83,97,112,104,105,114], [84,111,112,97,122,101], [69,109,101,114,97,117,100,101], 
  [69,99,114,105,110], [75,65,80,80,65,32,69,110,103,105,110,101,101,114,105,110,103], [70,101,107,101,116,101], 
  [80,101,116,114,101,108], [84,101,99,104,108,111,103], [72,89,83,89,83], [85,110,105,83,105,109], [80,86,84,115,105,109], 
  [80,86,84,105], [77,117,108,116,105,102,108,97,115,104], [80,101,116,101,120], 
  [80,101,116,114,111,108,101,117,109,32,69,120,112,101,114,116,115], [83,99,104,108,117,109,98,101,114,103,101,114], 
  [72,97,108,108,105,98,117,114,116,111,110], [66,97,107,101,114,32,72,117,103,104,101,115], 
  [87,101,97,116,104,101,114,102,111,114,100], [69,109,101,114,115,111,110], [65,115,112,101,110,84,101,99,104], 
  [65,115,112,101,110,32,80,108,117,115], [72,111,110,101,121,119,101,108,108], [75,111,110,103,115,98,101,114,103], 
  [69,120,112,114,111], [84,101,110,97,114,105,115], [86,97,108,108,111,117,114,101,99], [78,101,116,108,105,102,121], 
  [80,111,115,116,109,97,114,107], [71,111,111,103,108,101], [76,105,110,107,101,100,73,110], [77,105,99,114,111,115,111,102,116], 
  [67,104,101,118,114,111,110], [69,120,120,111,110,77,111,98,105,108], [83,104,101,108,108,32,112,108,99], [65,114,97,109,99,111], 
  [65,68,78,79,67], [69,113,117,105,110,111,114]
];
const CS = [
  [80,73,69], [71,65,80], [83,76,66], [73,72,83], [78,79,86], [69,67,76,73,80,83,69], [69,120,99,101,108], [75,65,80,80,65]
];
function patterns() {
  const extra = [];
  const f = process.env.WTS_WELLPERF_DENYLIST;
  if (f && fs.existsSync(f)) fs.readFileSync(f, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).forEach((x) => extra.push(x));
  return [new RegExp('\\b(' + CI.map(cc).concat(extra).map(esc).join('|') + ')\\b', 'gi'), new RegExp('\\b(' + CS.map(cc).map(esc).join('|') + ')\\b', 'g')];
}
function scan(text, res) {
  const hits = [];
  res.forEach((re) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) hits.push(m[1]); });
  return hits;
}

module.exports = [
  {
    name: 'WN1 names: no commercial product, vendor or company name in any Well Performance file (engines, page, help, tests, tool, plan); the check bites',
    wp: WP,
    opts: false,
    run(app, assert) {
      const res = patterns(), files = S.files(), bad = [];
      assert.ok(files.some((f) => /49-calc-wp-model\.js$/.test(f)) && files.some((f) => /WELL-PERFORMANCE-PLAN\.md$/.test(f)), 'file list: ' + files.join(', '));
      files.forEach((f) => {
        const lines = fs.readFileSync(path.join(S.REPO, f), 'utf8').split('\n');
        lines.forEach((ln, i) => { const h = scan(ln, res); if (h.length) bad.push(f + ':' + (i + 1) + ' ' + h.join(', ')); });
      });
      assert.deepStrictEqual(bad, [], 'banned names:\n  ' + bad.slice(0, 30).join('\n  '));
      // the check bites (names built from the same codes, so none is written here)
      assert.ok(scan('see ' + cc(CI[0]) + ' for the method', res).length === 1, 'any-case name found');
      assert.ok(scan('the ' + cc(CI[0]).toLowerCase() + ' page', res).length === 1, 'any case');
      assert.ok(scan('a ' + cc(CS[0]) + ' chart', res).length === 1, 'exact-case acronym found');
      assert.ok(scan('a ' + cc(CS[0]).toLowerCase() + ' chart', res).length === 0, 'acronyms only in their own case (no false hit on ordinary words)');
      assert.ok(scan('Hagedorn & Brown, Beggs & Brill, Gray, Duns & Ros, Turner, Vogel', res).length === 0, 'author-named methods pass');
    },
  },
];
