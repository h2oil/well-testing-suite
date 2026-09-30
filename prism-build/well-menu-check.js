// Real-browser check (Playwright; prints [skip] when it is not installed): the header well-switcher
// menu (29-multiwell.js) opens fully on screen and on top at desktop, tablet and phone widths in
// Chromium and WebKit. Before v3.0.1 it was right-aligned to the ⋯ button, so it ran under the
// sidebar / off the left edge (and off the top on phones).  Usage: node prism-build/well-menu-check.js
const path = require('path'), http = require('http'), fs = require('fs');
const { execFileSync } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch (e) { try { pw = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch (e2) { pw = null; } }
if (!pw) { console.log('[skip] playwright not installed'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const srv = http.createServer((q, r) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(b); }); });
(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + srv.address().port + '/well-testing-app.html';
  let bad = 0;
  for (const bt of ['chromium', 'webkit']) {
    const br = await pw[bt].launch();
    for (const [w, h] of [[1440, 900], [1024, 768], [825, 700], [768, 1024], [390, 844], [320, 640]]) {
      const pg = await br.newPage({ viewport: { width: w, height: h } });
      await pg.goto(url); await pg.waitForTimeout(400);
      await pg.evaluate(() => { if (typeof window.nav === 'function') window.nav('modbus'); else if (window.WTS_nav) window.WTS_nav('modbus'); });
      await pg.waitForTimeout(300);
      const btn = await pg.$('#wts_well_menu_btn');
      if (!btn) { console.log(bt, w, 'no well button'); bad++; await pg.close(); continue; }
      await btn.click(); await pg.waitForTimeout(150);
      const r = await pg.evaluate(() => {
        const m = document.getElementById('wts_well_menu'), s = document.getElementById('sidebar') || document.querySelector('.sidebar');
        const mr = m.getBoundingClientRect(), sr = s ? s.getBoundingClientRect() : null;
        const sideVisible = s && sr.width > 0 && sr.right > 0 && getComputedStyle(s).visibility !== 'hidden';
        // topmost element at the menu's left-middle and centre must be the menu itself (not clipped / covered)
        const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && m.contains(e)); };
        return { hidden: m.hasAttribute('hidden'), l: mr.left, r: mr.right, t: mr.top, b: mr.bottom, vw: innerWidth, vh: innerHeight,
          sideR: sideVisible ? sr.right : null,
          hitL: hit(mr.left + 6, mr.top + 20), hitC: hit((mr.left + mr.right) / 2, (mr.top + mr.bottom) / 2), hitR: hit(mr.right - 6, mr.top + 20),
          scroll: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      const ok = !r.hidden && r.l >= 0 && r.r <= r.vw && r.t >= 0 && r.b <= r.vh + 1 && r.hitL && r.hitC && r.hitR && !r.scroll;
      if (!ok) bad++;
      console.log((ok ? 'OK  ' : 'BAD ') + bt.padEnd(8) + String(w).padStart(5) + 'x' + h, JSON.stringify(r));
      // Escape closes; clicking outside closes
      await pg.keyboard.press('Escape'); await pg.close();
    }
    await br.close();
  }
  srv.close();
  console.log(bad ? `[FAIL] ${bad} layouts` : '[ok] well menu fully visible at all widths');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
