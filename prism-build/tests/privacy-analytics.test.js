// R23 — privacy: analytics never carry well data.
//
//   • The web build's gtag (well-testing-app.html <head>, GA:START block) passes every
//     event through the allow-list window.h2oilGaPolicy / h2oilGaClean: unknown keys,
//     numbers outside the UI counters, number-only strings, objects and arrays are dropped.
//   • Every PRiSM analytics call in the sources sends allow-listed keys only (static scan).
//   • Driving the app (client info, PRiSM tabs, deconvolution, tide, gauges, inverse
//     simulation, clipboard / XML exports) records only allow-listed, non-data payloads
//     (the harness gtag records raw payloads, before the head filter).
//   • The tracker block no longer reads input values / copied text, the iOS bundle strips
//     analytics, and the Privacy page is reachable from the sidebar, footer and Release Notes.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WP = 'R23';
const ROOT = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..');
const HTML = () => fs.readFileSync(path.join(ROOT, 'well-testing-app.html'), 'utf8');

// The two GA:START blocks of the web <head>: [loader + privacy filter, event tracker].
function gaBlocks(html) {
  const out = [];
  const re = /<!--\s*GA:START[\s\S]*?GA:END\s*-->/g;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}
function scriptsOf(block) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}
// Run the loader script (gtag + filter) in a bare sandbox → { gtag, dataLayer, policy, clean }.
function loadFilter() {
  const loader = scriptsOf(gaBlocks(HTML())[0])[0];
  const sb = { dataLayer: [] };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(loader, sb);
  return { gtag: sb.gtag, dataLayer: sb.dataLayer, policy: sb.h2oilGaPolicy, clean: sb.h2oilGaClean };
}
function allowed(policy) {
  return new Set([].concat(policy.str, policy.num, policy.bool));
}

// Balanced-brace object literal starting at s[i] === '{'.
function objectAt(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(i, j + 1);
  }
  return null;
}
// Top-level keys of an object literal source.
function topKeys(obj) {
  const keys = [];
  let d = 0, par = 0, tok = '';
  const body = obj.slice(1, -1);
  const parts = [];
  for (const ch of body) {
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
    else if (ch === '(') par++;
    else if (ch === ')') par--;
    if (ch === ',' && d === 0 && par === 0) { parts.push(tok); tok = ''; } else tok += ch;
  }
  if (tok.trim()) parts.push(tok);
  for (const p of parts) {
    const m = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/.exec(p);
    if (m) keys.push(m[1].replace(/['"]/g, ''));
  }
  return keys;
}
// Every analytics call site in the numbered sources: _ga4('name', {...}), gtag('event', 'name', {...})
// and the live simulator's track('name', {...}) (38-wts-live.js → h2oilTrack).
function callSites() {
  const files = fs.readdirSync(BUILD).filter((f) => /^\d\d-.*\.js$/.test(f));
  const out = [];
  for (const f of files) {
    let src = fs.readFileSync(path.join(BUILD, f), 'utf8');
    const cut = src.search(/\/\/ (=== SELF-TEST ===|SECTION \d+ — SELF-TEST)/);
    if (cut > 0) src = src.slice(0, cut);
    const re = /(?:_ga4\(\s*(?:'([\w]+)'|(\w+))\s*,\s*|gtag\(\s*'event'\s*,\s*(?:'([\w]+)'|(\w+))\s*,\s*|\btrack\(\s*'([\w]+)'\s*,\s*)\{/g;
    let m;
    while ((m = re.exec(src))) {
      const obj = objectAt(src, re.lastIndex - 1);
      out.push({ file: f, name: m[1] || m[2] || m[3] || m[4] || m[5], keys: topKeys(obj || '{}'), src: obj });
    }
  }
  return out;
}

// Distinctive "well data" planted in the app; none of it may show up in any payload.
const SECRETS = ['Zebracorp Petroleum', 'ZZ-Secret-7', 'Nowhere Field', '4213.77', '37.31', '851.9', '0.1931'];

function eventsOf(app, from) {
  return Array.from(app.win.dataLayer).slice(from || 0)
    .filter((e) => e && e[0] === 'event')
    .map((e) => ({ name: e[1], params: JSON.parse(JSON.stringify(e[2] || {})) }));
}
function mountHost(app) {
  const host = app.document.createElement('div');
  app.document.body.appendChild(host);
  return host;
}
function panelSpec(app, tab, id) {
  const reg = app.win.PRiSM_tabPanels || {};
  return (reg[tab] || []).find((s) => s && s.id === id) || null;
}

module.exports = [
  {
    name: 'head gtag filter: only allow-listed keys pass; well numbers, names, objects and number-only strings are dropped',
    wp: WP,
    opts: false,
    run(app, assert) {
      const F = loadFilter();
      assert.fn(F.gtag, 'gtag defined by the loader');
      assert.fn(F.clean, 'h2oilGaClean exposed');
      assert.ok(Array.isArray(F.policy.str) && F.policy.str.includes('module_id'), 'policy exposed');
      for (const bad of ['pi', 'rmse', 'L', 'sample_count', 'size_bytes', 'm2_amp_psi', 'ct_estimate', 'search_term',
        'filter_value', 'char_count', 'count', 'n', 'value_psi', 'client', 'well', 'dwell_ms']) {
        assert.ok(!allowed(F.policy).has(bad), 'not allow-listed: ' + bad);
      }
      const n0 = F.dataLayer.length;
      F.gtag('event', 'prism_test', {
        pi: 4213.77, rmse: 0.12, search_term: 'ZZ-Secret-7', client: 'Zebracorp Petroleum',
        model_key: 'homogeneous', page: '2500', event_label: '4213.77', tab_index: 3, percent: 50,
        enabled: true, on: 'yes', nested: { a: 1 }, source: ['x'], value: '12',
        link_url: 'https://example.com/a/b?well=ZZ-Secret-7#frag', nav_label: 'x'.repeat(300),
      });
      const e = F.dataLayer[n0];
      assert.equal(Object.prototype.toString.call(e), '[object Arguments]', 'pushes an arguments object (gtag.js contract)');
      assert.equal(e[0], 'event');
      assert.equal(e[1], 'prism_test');
      assert.deepEqual(JSON.parse(JSON.stringify(e[2])), {
        model_key: 'homogeneous', tab_index: 3, percent: 50, enabled: true,
        link_url: 'https://example.com/a/b', nav_label: 'x'.repeat(100),
      });
      // Bad event names never go out; config / js commands pass unchanged.
      F.gtag('event', 'Well ZZ-Secret-7', {});
      F.gtag('event', '4213.77', {});
      assert.equal(F.dataLayer.length, n0 + 1, 'invalid event names dropped');
      F.gtag('config', 'G-TEST', { send_page_view: false });
      assert.equal(F.dataLayer[n0 + 1][0], 'config');
      assert.deepEqual(JSON.parse(JSON.stringify(F.dataLayer[n0 + 1][2])), { send_page_view: false });
      assert.deepEqual(JSON.parse(JSON.stringify(F.clean(null))), {});
    },
  },
  {
    name: 'event tracker never reads input values or copied text (search / filter / copy / engagement)',
    wp: WP,
    opts: false,
    run(app, assert) {
      const tracker = scriptsOf(gaBlocks(HTML())[1])[0];
      assert.ok(tracker && /function track\(/.test(tracker), 'tracker block found');
      for (const bad of ['search_term', 'filter_value', 'char_count', 'dwell_ms', 'el.value']) {
        assert.ok(tracker.indexOf(bad) === -1, 'tracker must not send ' + bad);
      }
      // Every track('...', {...}) payload key is allow-listed.
      const P = allowed(loadFilter().policy);
      const re = /track\(\s*'(\w+)'\s*,\s*\{/g;
      let m, n = 0;
      while ((m = re.exec(tracker))) {
        n++;
        for (const k of topKeys(objectAt(tracker, re.lastIndex - 1))) assert.ok(P.has(k), m[1] + ': key ' + k + ' not allow-listed');
      }
      assert.ok(n >= 10, 'found ' + n + ' track() calls');
    },
  },
  {
    name: 'every PRiSM analytics call site (_ga4 / gtag event) sends allow-listed keys only',
    wp: WP,
    opts: false,
    run(app, assert) {
      const P = allowed(loadFilter().policy);
      const sites = callSites();
      assert.ok(sites.length >= 30, 'found ' + sites.length + ' call sites');
      const live = sites.filter((s) => s.file === '38-wts-live.js');
      assert.ok(live.length >= 8, 'live simulator track() sites scanned: ' + live.length);
      const ackSite = live.find((s) => s.name === 'wts_alarm_ack');
      assert.ok(ackSite && ackSite.keys.length === 0, 'wts_alarm_ack carries no payload: ' + (ackSite && ackSite.src));
      const bad = [];
      for (const s of sites) for (const k of s.keys) if (!P.has(k)) bad.push(s.file + ' ' + s.name + ': ' + k);
      assert.deepEqual(bad, [], 'non-allow-listed analytics keys');
      // Numeric payload values only for UI counters (tab index): no .length, rmse, pi, sizes.
      for (const s of sites) {
        assert.ok(!/\.length|rmse|\.size\b|amplitude|\bpi\b|nNodes|elapsed/i.test(s.src), s.file + ' ' + s.name + ' sends a data-derived value: ' + s.src);
      }
    },
  },
  {
    name: 'driving the app records only allow-listed, data-free analytics payloads',
    wp: WP,
    integration: true,
    async run(app, assert) {
      const W = app.win;
      const P = loadFilter();
      const OK = allowed(P.policy);
      const n0 = W.dataLayer.length;
      // Client & well info with distinctive names.
      app.hook.nav('clientinfo');
      for (const [id, v] of [['ci_client', SECRETS[0]], ['ci_well', SECRETS[1]], ['ci_field', SECRETS[2]]]) {
        if (app.el(id)) app.input(id, v);
      }
      app.hook.nav('choke');
      app.hook.nav('privacy');
      // PRiSM: sample data + distinctive well inputs, every tab, a model change and a fit event.
      app.openPRiSM();
      app.seedSample();
      if (typeof W.PRiSM_setWell === 'function') {
        W.PRiSM_setWell(app.toWin({ p_res: 4213.77, pi: 4213.77, h: 37.31, q: 851.9, phi: 0.1931 }), app.toWin({ source: 'user' }));
      }
      for (let n = 1; n <= 7; n++) { try { app.renderTab(n); } catch (e) { /* tab render is not under test */ } }
      app.fire('window', 'prism:model-changed', { modelKey: 'homogeneous' });
      if (typeof W.PRiSM_setLastFit === 'function') {
        W.PRiSM_setLastFit(app.toWin({ modelKey: 'homogeneous', source: 'regression', params: { Cd: 80, S: 2.5 }, phys: { k: 45.67, kh: 1598.45 } }));
      }
      // Deconvolution, tide, gauges, inverse simulation, overlays, clipboard, XML.
      const dec = panelSpec(app, 2, 'prism_deconvolution');
      if (dec) { const h = mountHost(app); dec.render(h); const b = h.querySelector('#prism_dec_run'); if (b) { app.click(b); app.flush(100); } }
      const t = [], p = [];
      for (let i = 0; i < 720; i++) { const ti = i * 168 / 719; t.push(ti); p.push(4213.77 - 0.02 * ti + 0.5 * Math.cos(2 * Math.PI * ti / 12.4206)); }
      const keep = W.PRiSM_dataset;
      W.PRiSM_dataset = app.toWin({ t, p });
      const tide = panelSpec(app, 1, 'prism_tide');
      if (tide) {
        const h = mountHost(app); tide.render(h);
        const r = h.querySelector('#prism_tide_run'); if (r) app.click(r);
        const a = h.querySelector('#prism_tide_apply'); if (a) app.click(a);
      }
      W.PRiSM_dataset = keep;
      if (W.PRiSM_gaugeData && typeof W.PRiSM_gaugeData.addFromDataset === 'function') {
        await W.PRiSM_gaugeData.addFromDataset(null, app.toWin({ name: SECRETS[1] }));
      }
      const inv = panelSpec(app, 6, 'prism_plt_inverse');
      if (inv) {
        const h = mountHost(app); inv.render(h);
        for (const id of ['#prism_inv_run', '#prism_plt_compute']) { const b = h.querySelector(id); if (b) { try { app.click(b); } catch (e) { /* result not under test */ } } }
      }
      if (W.PRiSM_overlays && typeof W.PRiSM_overlays.add === 'function') W.PRiSM_overlays.add('model:homogeneous', SECRETS[1]);
      if (typeof W.PRiSM_copyDataToClipboard === 'function') { try { W.PRiSM_copyDataToClipboard('tsv'); } catch (e) { /* clipboard */ } }
      if (typeof W.PRiSM_exportXML === 'function') { try { W.PRiSM_exportXML(); } catch (e) { /* export */ } }
      await app.flushAsync(200);

      const evs = eventsOf(app, n0);
      const names = new Set(evs.map((e) => e.name));
      for (const want of ['prism_tab_open', 'prism_model_select', 'prism_regress_run', 'prism_deconvolution_run',
        'prism_tide_analysis', 'prism_tide_correction_applied']) {
        assert.ok(names.has(want), 'event ' + want + ' fired (got ' + Array.from(names).join(', ') + ')');
      }
      for (const e of evs) {
        assert.match(e.name, /^[a-z][a-z0-9_]{0,39}$/, 'event name');
        for (const [k, v] of Object.entries(e.params)) {
          assert.ok(OK.has(k), e.name + ': key "' + k + '" is not allow-listed');
          if (typeof v === 'number') assert.ok(P.policy.num.includes(k), e.name + ': numeric value on ' + k);
          assert.ok(typeof v !== 'object' || v === null, e.name + ': object value on ' + k);
        }
        // Raw payloads are already clean — the head filter is defence in depth, not the fix.
        assert.deepEqual(JSON.parse(JSON.stringify(P.clean(e.params))), e.params, e.name + ' changed by the filter');
        const txt = JSON.stringify(e);
        for (const s of SECRETS) assert.ok(txt.indexOf(s) === -1, e.name + ' leaks "' + s + '": ' + txt);
      }
    },
  },
  {
    name: 'iOS bundle strips every analytics block; the Privacy page states it',
    wp: WP,
    opts: false,
    run(app, assert) {
      const html = HTML();
      assert.equal(gaBlocks(html).length, 2, 'two GA blocks in the web head');
      // Same strip the sync script applies.
      const src = fs.readFileSync(path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js'), 'utf8');
      assert.includes(src, "html.replace(/<!--\\s*GA:START[\\s\\S]*?GA:END\\s*-->/g");
      const ios = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '<!-- GA stripped from iOS bundle -->');
      for (const s of ['googletagmanager', 'function gtag', 'window.h2oilTrack = track', 'G-6QKCBNWHYB\', {']) {
        assert.ok(ios.indexOf(s) === -1, 'iOS bundle still has ' + s);
      }
    },
  },
  {
    name: 'Privacy page: reachable from sidebar, footer and Release Notes; states on-device, storage, analytics, iOS, files, no accounts',
    wp: WP,
    run(app, assert) {
      const btn = app.find('.nav-btn[data-p="privacy"]');
      assert.ok(btn, 'sidebar button');
      app.click(btn);
      assert.equal(app.el('pgTitle').textContent, 'Privacy');
      const txt = app.el('pgBody').textContent;
      for (const s of ['computed in your browser or in the app on your device', 'no user accounts', 'local storage',
        'Google Analytics 4', 'no input values', 'no client or well names', 'removed from the iOS bundle',
        'sync-from-main.js', 'Project files', 'only when you choose']) {
        assert.includes(txt, s);
      }
      assert.ok(!app.find('#pgBody input, #pgBody select, #pgBody textarea'), 'no inputs (nothing to autosave)');
      // Footer link.
      app.hook.nav('home');
      app.click('sbPrivacyLink');
      assert.equal(app.el('pgTitle').textContent, 'Privacy', 'footer link');
      // Release Notes link.
      app.hook.nav('releasenotes');
      app.click('rnPrivacyLink');
      assert.equal(app.el('pgTitle').textContent, 'Privacy', 'release-notes link');
      // Not captured into the Quick Report / autosave.
      app.hook.nav('home');
      assert.equal(app.storage.getItem('wts_page_privacy'), null, 'no autosave record');
      const snaps = app.storage.getItem('wts_report_snapshots') || '';
      assert.ok(snaps.indexOf('"privacy"') === -1, 'no Quick Report snapshot');
    },
  },
];
