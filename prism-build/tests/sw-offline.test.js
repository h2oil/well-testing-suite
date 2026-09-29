// P2 offline web app — the service worker (sw.js at the repo root) run in a
// vm with a fake `self`, CacheStorage, fetch and Response. No app is loaded
// (opts: false). Checks the routing table (what is cached, what is never
// touched), install precache, stale-while-revalidate of the app page with the
// update notice, cache-first libraries, activate clean-up and messages.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WP = 'P2SW';
const SW_PATH = path.resolve(__dirname, '..', '..', 'sw.js');
const SCOPE = 'https://wts.example/app/';
const PAGE = SCOPE + 'well-testing-app.html';
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
const THREE_UNPKG = 'https://unpkg.com/three@0.170.0/build/three.module.min.js';
const XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

class FakeHeaders {
  constructor(o) { this.m = {}; Object.keys(o || {}).forEach((k) => { this.m[k.toLowerCase()] = String(o[k]); }); }
  get(k) { const v = this.m[String(k).toLowerCase()]; return v === undefined ? null : v; }
}
class FakeResponse {
  constructor(body, init) {
    init = init || {};
    this.body = body == null ? '' : String(body);
    this.status = init.status == null ? 200 : init.status;
    this.type = init.type || 'basic';
    this._h = init.headers || {};
    this.headers = new FakeHeaders(this._h);
  }
  clone() { return new FakeResponse(this.body, { status: this.status, type: this.type, headers: this._h }); }
  text() { return Promise.resolve(this.body); }
  static error() { return new FakeResponse('', { status: 0, type: 'error' }); }
}
class FakeCache {
  constructor() { this.m = new Map(); }
  match(k) { return Promise.resolve(this.m.get(typeof k === 'string' ? k : k.url)); }
  put(k, r) { this.m.set(typeof k === 'string' ? k : k.url, r); return Promise.resolve(); }
  keys() { return Promise.resolve(Array.from(this.m.keys()).map((u) => ({ url: u }))); }
}

// Load sw.js into a fresh realm. net(url, init) → FakeResponse | throws (offline).
function loadSW(net) {
  const listeners = {};
  const stores = new Map();
  const env = {
    fetches: [], posted: [], skipped: 0, claimed: 0, stores,
    net: net || (() => { throw new TypeError('offline'); }),
  };
  const caches = {
    open: (n) => { if (!stores.has(n)) stores.set(n, new FakeCache()); return Promise.resolve(stores.get(n)); },
    keys: () => Promise.resolve(Array.from(stores.keys())),
    delete: (n) => Promise.resolve(stores.delete(n)),
  };
  const client = { postMessage: (m) => env.posted.push(m) };
  const self = {
    location: { href: SCOPE + 'sw.js' },
    registration: { scope: SCOPE },
    clients: { matchAll: () => Promise.resolve([client]), claim: () => { env.claimed++; return Promise.resolve(); } },
    skipWaiting: () => { env.skipped++; return Promise.resolve(); },
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const fetch = (url, init) => {
    const u = typeof url === 'string' ? url : url.url;
    env.fetches.push({ url: u, init: init || null });
    try { return Promise.resolve(env.net(u, init || {})); } catch (e) { return Promise.reject(e); }
  };
  const ctx = vm.createContext({ self, caches, fetch, Response: FakeResponse, URL, Promise, console });
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), ctx, { filename: 'sw.js' });
  env.self = self;
  env.api = self.WTS_SW;
  env.cache = (n) => stores.get(n);
  // Dispatch an event; resolves with {response, waited}.
  env.dispatch = async (type, props) => {
    let resp = null; const waits = [];
    const ev = Object.assign({ respondWith: (p) => { resp = Promise.resolve(p); }, waitUntil: (p) => { waits.push(p); } }, props || {});
    listeners[type](ev);
    const response = resp ? await resp : null;
    await Promise.all(waits);
    return { response, responded: !!resp };
  };
  env.get = (url, mode, headers) => env.dispatch('fetch', { request: { url, method: 'GET', mode: mode || 'no-cors', headers: new FakeHeaders(headers || {}) } });
  return env;
}
const html = (body, h) => new FakeResponse(body, { headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, h || {}) });

module.exports = [
  {
    name: 'routing: app page, fonts and pinned libraries are handled; everything else is left to the network',
    wp: WP, opts: false,
    run(app, assert) {
      const sw = loadSW();
      const r = (url, extra) => sw.api.route(Object.assign({ url, method: 'GET', mode: 'no-cors' }, extra || {}));
      const nav = (url) => r(url, { mode: 'navigate' });
      assert.deepStrictEqual(Object.assign({}, nav(SCOPE)), { kind: 'shell', key: SCOPE }, 'scope root navigation');
      assert.deepStrictEqual(Object.assign({}, nav(PAGE + '?v=17#home')), { kind: 'shell', key: PAGE }, 'cache-buster and hash dropped');
      assert.strictEqual(r(SCOPE + 'index.html').kind, 'shell', 'index.html fetched directly');
      assert.strictEqual(r(SCOPE + 'fonts/inter.woff2').kind, 'static', 'same-origin font');
      assert.strictEqual(r(SCOPE + 'img/logo.png').kind, 'static', 'same-origin image');
      assert.strictEqual(r(THREE).kind, 'lib', 'three.js (jsDelivr)');
      assert.strictEqual(r(THREE_UNPKG).kind, 'lib', 'three.js (unpkg)');
      assert.strictEqual(r(XLSX).kind, 'lib', 'SheetJS');
      const by = (why, rr) => { assert.strictEqual(rr.kind, 'bypass', why); assert.strictEqual(rr.why, why, why); };
      by('method', r(PAGE, { method: 'POST' }));
      by('cross-origin', r('https://www.googletagmanager.com/gtag/js?id=G-X'));
      by('cross-origin', r('https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.min.js'));   // unpinned version
      by('lib-query', r(THREE + '?r=2'));
      by('out-of-scope', r('https://wts.example/other/page.html', { mode: 'navigate' }));
      by('worker', r(SCOPE + 'sw.js'));
      by('not-app-asset', r(SCOPE + 'api/data.json'));
      by('navigate-other', nav(SCOPE + 'files/report.pdf'));
      by('range', r(SCOPE + 'media/clip.mp4', { headers: new FakeHeaders({ Range: 'bytes=0-' }) }));
      by('protocol', r('blob:https://wts.example/1234'));
      by('protocol', r('data:text/plain,hi'));
      // bypassed requests are not answered by the worker at all
      return sw.dispatch('fetch', { request: { url: PAGE, method: 'POST', mode: 'cors', headers: new FakeHeaders() } })
        .then((o) => assert.strictEqual(o.responded, false, 'POST not intercepted'));
    },
  },
  {
    name: 'install precaches the app page and the pinned libraries, and survives a failed download',
    wp: WP, opts: false,
    async run(app, assert) {
      const sw = loadSW((url) => {
        if (url === PAGE) return html('<html>v1</html>');
        if (url === THREE) return new FakeResponse('three', { type: 'cors', headers: { 'content-type': 'text/javascript' } });
        throw new TypeError('network down');                 // SheetJS unreachable
      });
      await sw.dispatch('install');
      assert.strictEqual((await sw.cache('wts-shell-v1').match(PAGE)).body, '<html>v1</html>', 'page cached');
      assert.strictEqual((await sw.cache('wts-libs-v1').match(THREE)).body, 'three', 'three.js cached');
      assert.strictEqual(await sw.cache('wts-libs-v1').match(XLSX), undefined, 'failed library not cached, install still resolved');
      const libFetch = sw.fetches.filter((f) => f.url === THREE)[0];
      assert.strictEqual(libFetch.init.mode, 'cors', 'library fetched in CORS mode');
      assert.strictEqual(libFetch.init.credentials, 'omit', 'library fetched without credentials');
    },
  },
  {
    name: 'app page: served from the cache offline; a changed page online is stored and every window is told',
    wp: WP, opts: false,
    async run(app, assert) {
      let online = false, body = '<html>v1</html>';
      const sw = loadSW((url) => { if (!online) throw new TypeError('offline'); return html(body); });
      const c = new FakeCache(); sw.stores.set('wts-shell-v1', c);
      await c.put(PAGE, html('<html>v1</html>'));
      // offline
      let o = await sw.get(PAGE + '?v=9', 'navigate');
      assert.strictEqual(o.response.body, '<html>v1</html>', 'offline → cached copy');
      assert.strictEqual(sw.posted.length, 0, 'no update notice offline');
      // online, unchanged
      online = true;
      o = await sw.get(PAGE, 'navigate');
      assert.strictEqual(o.response.body, '<html>v1</html>');
      assert.strictEqual(sw.posted.length, 0, 'unchanged page → no notice');
      const rev = sw.fetches[sw.fetches.length - 1];
      assert.strictEqual(rev.url, PAGE, 'revalidated without the query string');
      assert.strictEqual(rev.init.cache, 'no-cache', 'revalidation bypasses the HTTP cache');
      // online, changed: the cached copy is still served now, the new one is stored, windows told
      body = '<html>v2</html>';
      o = await sw.get(PAGE, 'navigate');
      assert.strictEqual(o.response.body, '<html>v1</html>', 'still fast from cache');
      assert.strictEqual((await c.match(PAGE)).body, '<html>v2</html>', 'new page stored');
      assert.strictEqual(sw.posted.length, 1, 'one notice');
      assert.strictEqual(sw.posted[0].type, 'WTS_SW_UPDATE');
      // ETag equality short-cuts the body compare
      await c.put(PAGE, html('<html>v2</html>', { etag: '"a"' }));
      body = '<html>v3</html>';
      const sw2Net = sw.net; sw.net = () => html('<html>v3</html>', { etag: '"a"' });
      await sw.get(PAGE, 'navigate');
      assert.strictEqual(sw.posted.length, 1, 'same ETag → no notice');
      sw.net = sw2Net;
    },
  },
  {
    name: 'nothing that is not a clean 200 OK page is stored (errors, no-store, private, non-HTML)',
    wp: WP, opts: false,
    async run(app, assert) {
      const cases = [
        [new FakeResponse('err', { status: 500, headers: { 'content-type': 'text/html' } }), 'HTTP 500'],
        [html('<p>x</p>', { 'cache-control': 'no-store' }), 'no-store'],
        [html('<p>x</p>', { 'cache-control': 'private, max-age=60' }), 'private'],
        [new FakeResponse('{"a":1}', { headers: { 'content-type': 'application/json' } }), 'JSON under an .html URL'],
        [new FakeResponse('x', { type: 'opaque', status: 0 }), 'opaque'],
      ];
      for (const [resp, what] of cases) {
        const sw = loadSW(() => resp);
        const o = await sw.get(PAGE, 'navigate');
        assert.ok(o.response, what + ': response passed through');
        const c = sw.cache('wts-shell-v1');
        assert.strictEqual(c ? await c.match(PAGE) : undefined, undefined, what + ': not cached');
      }
      const sw = loadSW(() => html('<html>ok</html>'));
      await sw.get(PAGE, 'navigate');
      assert.strictEqual((await sw.cache('wts-shell-v1').match(PAGE)).body, '<html>ok</html>', 'a clean page is cached on first visit');
    },
  },
  {
    name: 'offline navigation to an uncached address falls back to the cached app page; a total miss is a network error',
    wp: WP, opts: false,
    async run(app, assert) {
      const sw = loadSW();
      let o = await sw.get(SCOPE, 'navigate');
      assert.strictEqual(o.response.type, 'error', 'nothing cached → network error response');
      const c = sw.cache('wts-shell-v1') || new FakeCache(); sw.stores.set('wts-shell-v1', c);
      await c.put(PAGE, html('<html>cached</html>'));
      o = await sw.get(SCOPE, 'navigate');
      assert.strictEqual(o.response.body, '<html>cached</html>', 'scope root → cached app page');
    },
  },
  {
    name: 'libraries and fonts are cache-first (no network once stored)',
    wp: WP, opts: false,
    async run(app, assert) {
      let n = 0;
      const sw = loadSW((url) => { n++; return new FakeResponse('lib:' + url, { type: 'cors' }); });
      let o = await sw.get(XLSX, 'no-cors');
      assert.strictEqual(o.response.body, 'lib:' + XLSX);
      assert.strictEqual(sw.fetches[0].init.mode, 'cors', 'a no-cors script request is fetched in CORS mode so it can be stored');
      o = await sw.get(XLSX, 'no-cors');
      assert.strictEqual(n, 1, 'second load from the cache');
      await sw.get(SCOPE + 'fonts/a.woff2', 'cors');
      await sw.get(SCOPE + 'fonts/a.woff2', 'cors');
      assert.strictEqual(n, 2, 'font fetched once');
    },
  },
  {
    name: 'activate removes old wts caches only and claims the pages; messages: skip-waiting and cache-this-page',
    wp: WP, opts: false,
    async run(app, assert) {
      const sw = loadSW((url) => html('<html>' + url + '</html>'));
      ['wts-shell-v0', 'wts-libs-v0', 'wts-shell-v1', 'someone-elses-cache'].forEach((n) => sw.stores.set(n, new FakeCache()));
      await sw.dispatch('activate');
      assert.deepStrictEqual(Array.from(sw.stores.keys()).sort(), ['someone-elses-cache', 'wts-shell-v1'], 'old versions deleted');
      assert.strictEqual(sw.claimed, 1, 'clients claimed');
      await sw.dispatch('message', { data: { type: 'WTS_SKIP_WAITING' } });
      assert.strictEqual(sw.skipped, 1, 'skipWaiting on request');
      await sw.dispatch('message', { data: { type: 'WTS_CACHE_SHELL', url: SCOPE + 'index.html' } });
      assert.ok(await sw.cache('wts-shell-v1').match(SCOPE + 'index.html'), 'the loaded page is kept');
      const before = sw.fetches.length;
      await sw.dispatch('message', { data: { type: 'WTS_CACHE_SHELL', url: 'https://evil.example/x.html' } });
      await sw.dispatch('message', { data: { type: 'WTS_CACHE_SHELL', url: SCOPE + 'api/secret.json' } });
      await sw.dispatch('message', { data: 'junk' });
      assert.strictEqual(sw.fetches.length, before, 'foreign / non-page URLs ignored');
    },
  },
];
