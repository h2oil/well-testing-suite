// Shared splice logic for the Round-N inject scripts (round2 … round8).
//
// makeRoundInjector(cfg) → { inject(html, blob), main() }
//   cfg.START / cfg.END   sentinel comment lines
//   cfg.ANCHOR            string, or array of strings tried in order; the
//                         block is inserted right after the first one found
//                         (first run only — later runs replace START..END)
//   cfg.BLOB / cfg.HTML   file paths used by main()
//   cfg.msg               CLI messages (kept byte-identical to the historical
//                         per-round scripts):
//       noEnd, noAnchor:[lines] | fn(anchors) → [lines], replaced,
//       inserted(line, anchor)
//   cfg.summary           print the before/after line counts (rounds 2-5)
//   cfg.eolAware          convert the blob to the host's line ending (new
//                         scripts only; the historical rounds splice LF blobs)
//
// inject(html, blob) is pure: returns { out, mode:'replace'|'insert',
// messages:[...], anchor } or throws an Error whose .lines are the CLI
// error lines.

const fs = require('fs');

function makeRoundInjector(cfg) {
  const anchors = Array.isArray(cfg.ANCHOR) ? cfg.ANCHOR : [cfg.ANCHOR];

  function fail(lines) { const e = new Error(lines[0]); e.lines = lines; throw e; }

  function inject(html, blob) {
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    if (cfg.eolAware) blob = blob.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    const J = cfg.eolAware ? eol : '\n';
    const startIdx = html.indexOf(cfg.START);
    if (startIdx !== -1) {
      const endIdx = html.indexOf(cfg.END, startIdx);
      if (endIdx === -1) fail([cfg.msg.noEnd]);
      const blockEnd = endIdx + cfg.END.length;
      const out = html.slice(0, startIdx) + cfg.START + J + blob + J + cfg.END + html.slice(blockEnd);
      return { out, mode: 'replace', messages: [cfg.msg.replaced] };
    }
    let anchorIdx = -1, anchor = null;
    for (const a of anchors) {
      anchorIdx = html.indexOf(a);
      if (anchorIdx !== -1) { anchor = a; break; }
    }
    if (anchorIdx === -1) {
      fail(typeof cfg.msg.noAnchor === 'function' ? cfg.msg.noAnchor(anchors) : cfg.msg.noAnchor);
    }
    const insertAt = anchorIdx + anchor.length;
    const wrapped = eol + eol + cfg.START + eol + blob + eol + cfg.END + eol;
    const out = html.slice(0, insertAt) + wrapped + html.slice(insertAt);
    const line = html.slice(0, insertAt).split('\n').length;
    return { out, mode: 'insert', anchor, messages: [cfg.msg.inserted(line, anchor)] };
  }

  function main() {
    const st0 = cfg.guardMtime ? fs.statSync(cfg.HTML) : null;
    const html = fs.readFileSync(cfg.HTML, 'utf8');
    const blob = fs.readFileSync(cfg.BLOB, 'utf8');
    let res;
    try { res = inject(html, blob); }
    catch (e) { (e.lines || [e.message]).forEach((l) => console.error(l)); process.exit(1); }
    res.messages.forEach((m) => console.log(m));
    if (st0) {
      const st1 = fs.statSync(cfg.HTML);
      if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
        console.error('well-testing-app.html changed on disk while injecting — aborting (re-run)');
        process.exit(1);
      }
    }
    const out = res.out;
    fs.writeFileSync(cfg.HTML, out, 'utf8');
    console.log('[ok] wrote ' + cfg.HTML);
    if (cfg.summary) {
      const total = out.split('\n').length;
      const added = total - html.split('\n').length;
      console.log('     before: ' + html.split('\n').length + ' lines');
      console.log('     after:  ' + total + ' lines (+' + added + ')');
    }
  }

  return { inject, main };
}

module.exports = { makeRoundInjector };
