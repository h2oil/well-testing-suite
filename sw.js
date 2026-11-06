/* ════════════════════════════════════════════════════════════════════
 * H2Oil Well Testing Suite — offline service worker (web build only)
 *
 * Registered by the app (well-testing-app.html, block "SW:START") on
 * http(s) pages only; never in the iOS app (the block is stripped by
 * ios-app/scripts/sync-from-main.js and the app refuses capacitor:/file:).
 *
 * WHAT IS CACHED (nothing else is touched — the request goes to the network)
 *   shell   the app page itself: the scope root, SHELL_PAGES and their
 *           index.html alias — nothing else. Stale-while-revalidate: served
 *           from the cache at once (works without signal); when online a
 *           fresh copy is fetched in the background and, if it differs,
 *           stored and every open window is told ("WTS_SW_UPDATE") so the
 *           app can offer Reload. Offline, an uncached shell URL is answered
 *           only from the cached SHELL_PAGES, never from another cached page.
 *   static  same-origin fonts, images, stylesheets and scripts under the
 *           scope (cache first, keyed by the full href). The Help folder
 *           help/ is static too, its pages included (help/user-guide.html):
 *           its links carry ?v=<app version> and its screenshots
 *           ?v=<first 8 hex of sha256>, so a new release or a re-shoot is a
 *           new cache entry and the guide never raises the update notice.
 *           help/ entries live in their own cache (HELP_CACHE), so that
 *           superseded screenshots and guide versions do not pile up: the
 *           Help page's offline download sends "WTS_HELP_PRUNE" with the
 *           current URLs and every other help/ entry is deleted.
 *   lib     the pinned CDN libraries the app loads on demand (three.js
 *           r170 for the 3D view, SheetJS 0.18.5 for .xlsx import, SQLite WASM
 *           3.53.4 and sql.js 1.14.2 for the historian), by exact versioned URL
 *           (cache first; fetched in CORS mode). The app checks each file's
 *           SHA-384 before use, so a cached copy is never trusted blindly.
 *
 * NEVER CACHED: non-GET requests, other origins (analytics …), URLs outside
 * the scope, Range requests, responses that are not 200 OK or are marked
 * Cache-Control no-store / private, and the worker script itself. User data
 * (inputs, projects, results) lives in localStorage and never goes over HTTP.
 *
 * HOSTING: serve sw.js from the same folder as the app page, over HTTPS,
 * with "Cache-Control: no-cache" (or max-age=0) on sw.js and on the page so
 * updates are seen; Content-Type text/javascript.
 * ════════════════════════════════════════════════════════════════════ */
'use strict';

var VERSION = '1';
var SHELL_CACHE = 'wts-shell-v1';
var LIB_CACHE = 'wts-libs-v1';
var HELP_CACHE = 'wts-help-v1';                                   // help/ only (prunable to the current manifest)
var CACHES = [SHELL_CACHE, LIB_CACHE, HELP_CACHE];
var SHELL_PAGES = ['well-testing-app.html'];                     // relative to the scope
var SHELL_ALIASES = ['', 'index.html'];                           // the scope root and its index page also serve the app (plan §2.10)
var HELP_DIR = 'help/';                                           // Help centre files (static, never shell)
var HELP_RE = /\.(?:html?|json|webp|png|jpe?g|svg|css|js)$/i;
var CDN_LIBS = [
    'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
    'https://unpkg.com/three@0.170.0/build/three.module.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    // Historian (47-calc-historian.js): official SQLite WASM build and sql.js, pinned + SHA-384 checked by the app
    'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.53.4-build1/dist/index.mjs',
    'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.53.4-build1/dist/sqlite3.wasm',
    'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/sql-wasm.js',
    'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/sql-wasm.wasm',
    'https://unpkg.com/@sqlite.org/sqlite-wasm@3.53.4-build1/dist/index.mjs',
    'https://unpkg.com/@sqlite.org/sqlite-wasm@3.53.4-build1/dist/sqlite3.wasm',
    'https://unpkg.com/sql.js@1.14.2/dist/sql-wasm.js',
    'https://unpkg.com/sql.js@1.14.2/dist/sql-wasm.wasm'
];
var PRECACHE_LIBS = [CDN_LIBS[0], CDN_LIBS[2], CDN_LIBS[3], CDN_LIBS[4], CDN_LIBS[5], CDN_LIBS[6]];
var STATIC_RE = /\.(?:woff2?|ttf|otf|css|js|mjs|png|jpe?g|gif|webp|svg|ico|webmanifest)$/i;

function scopeURL() {
    var s = (self.registration && self.registration.scope) || self.location.href;
    return new URL(s, self.location.href);
}

// → {kind: 'shell'|'static'|'lib'|'bypass', key, why}
function route(req) {
    if (!req || String(req.method || 'GET').toUpperCase() !== 'GET') return { kind: 'bypass', why: 'method' };
    var url;
    try { url = new URL(req.url); } catch (e) { return { kind: 'bypass', why: 'url' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'bypass', why: 'protocol' };
    if (req.headers && typeof req.headers.get === 'function' && req.headers.get('range')) return { kind: 'bypass', why: 'range' };
    var bare = url.origin + url.pathname;
    if (CDN_LIBS.indexOf(bare) !== -1) return url.search ? { kind: 'bypass', why: 'lib-query' } : { kind: 'lib', key: bare };
    var scope = scopeURL();
    if (url.origin !== scope.origin) return { kind: 'bypass', why: 'cross-origin' };
    if (url.pathname.indexOf(scope.pathname) !== 0) return { kind: 'bypass', why: 'out-of-scope' };
    var rel = url.pathname.slice(scope.pathname.length);
    if (rel === 'sw.js') return { kind: 'bypass', why: 'worker' };
    // Help centre: screenshots and the printable guide are static (cache first by full href, ?v= kept).
    if (rel.indexOf(HELP_DIR) === 0) return HELP_RE.test(rel) ? { kind: 'static', key: url.href.split('#')[0], help: true } : { kind: 'bypass', why: 'not-app-asset' };
    if (SHELL_PAGES.indexOf(rel) !== -1 || SHELL_ALIASES.indexOf(rel) !== -1) return { kind: 'shell', key: bare };   // ?v= cache-busters dropped
    if (req.mode === 'navigate') return { kind: 'bypass', why: 'navigate-other' };
    if (STATIC_RE.test(rel)) return { kind: 'static', key: url.href.split('#')[0] };
    return { kind: 'bypass', why: 'not-app-asset' };
}

function cacheable(resp, kind) {
    if (!resp || resp.status !== 200 || !(resp.type === 'basic' || resp.type === 'cors' || resp.type === 'default' || resp.type === undefined)) return false;
    var cc = (resp.headers && resp.headers.get && resp.headers.get('cache-control')) || '';
    if (/no-store|private/i.test(cc)) return false;
    if (kind === 'shell') {
        var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
        if (ct && !/text\/html/i.test(ct)) return false;
    }
    return true;
}

function sameBody(a, b) {
    var ea = a.headers && a.headers.get && a.headers.get('etag'), eb = b.headers && b.headers.get && b.headers.get('etag');
    if (ea && eb) return Promise.resolve(ea === eb);
    return Promise.all([a.clone().text(), b.clone().text()]).then(function (t) { return t[0] === t[1]; });
}

function notify(msg) {
    if (!self.clients || typeof self.clients.matchAll !== 'function') return Promise.resolve(0);
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        list.forEach(function (c) { try { c.postMessage(msg); } catch (e) {} });
        return list.length;
    });
}

function fetchFresh(url, kind) {
    var init = kind === 'lib' ? { mode: 'cors', credentials: 'omit' } : { cache: 'no-cache', credentials: 'same-origin' };
    return fetch(url, init);
}

// Shell: cached copy first; background refresh, update notice on change.
function handleShell(req, r, waitUntil) {
    return caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(r.key).then(function (cached) {
            var refresh = fetchFresh(r.key, 'shell').then(function (fresh) {
                if (!cacheable(fresh, 'shell')) return fresh;
                var put = function () { return cache.put(r.key, fresh.clone()); };
                if (!cached) return put().then(function () { return fresh; });
                return sameBody(cached, fresh).then(function (same) {
                    if (same) return fresh;
                    return put().then(function () { return notify({ type: 'WTS_SW_UPDATE', url: r.key, version: VERSION }); }).then(function () { return fresh; });
                });
            });
            if (cached) {
                waitUntil(refresh.catch(function () { /* offline: keep the cached copy */ }));
                return cached;
            }
            return refresh.catch(function () {
                // Offline and this exact URL was never cached: a cached app page (SHELL_PAGES only, in order) will do.
                return shellFallback(cache);
            });
        });
    });
}

// The first cached SHELL_PAGES entry, else a network error. Never another cached page (e.g. the Help guide).
function shellFallback(cache) {
    var scope = scopeURL();
    var urls = SHELL_PAGES.map(function (p) { return new URL(p, scope).href; });
    var i = 0;
    var next = function () {
        if (i >= urls.length) return Response.error();
        return cache.match(urls[i++]).then(function (hit) { return hit || next(); });
    };
    return next();
}

// Static / lib: cache first, fill on a miss.
function handleCacheFirst(req, r, cacheName) {
    return caches.open(cacheName).then(function (cache) {
        return cache.match(r.key).then(function (hit) {
            if (hit) return hit;
            return fetchFresh(r.kind === 'lib' ? r.key : req, r.kind).then(function (resp) {
                if (cacheable(resp, r.kind)) return cache.put(r.key, resp.clone()).then(function () { return resp; });
                return resp;
            });
        });
    });
}

function handleFetch(event) {
    var r = route(event.request);
    if (r.kind === 'bypass') return null;
    var waitUntil = function (p) { try { event.waitUntil(p); } catch (e) {} };
    if (r.kind === 'shell') return handleShell(event.request, r, waitUntil);
    return handleCacheFirst(event.request, r, r.kind === 'lib' ? LIB_CACHE : r.help ? HELP_CACHE : SHELL_CACHE);
}

// Best-effort fetch + store; a failure never breaks install.
function precache(cacheName, url, kind) {
    return caches.open(cacheName).then(function (cache) {
        return fetchFresh(url, kind).then(function (resp) {
            return cacheable(resp, kind) ? cache.put(url, resp).then(function () { return true; }) : false;
        });
    }).catch(function () { return false; });
}

function install() {
    var scope = scopeURL();
    var jobs = SHELL_PAGES.map(function (p) { return precache(SHELL_CACHE, new URL(p, scope).href, 'shell'); })
        .concat(PRECACHE_LIBS.map(function (u) { return precache(LIB_CACHE, u, 'lib'); }));
    return Promise.all(jobs);
}

function activate() {
    return caches.keys().then(function (names) {
        return Promise.all(names.filter(function (n) { return /^wts-/.test(n) && CACHES.indexOf(n) === -1; })
            .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients && self.clients.claim ? self.clients.claim() : null; });
}

function onMessage(event) {
    var d = event && event.data;
    if (!d || typeof d !== 'object') return null;
    if (d.type === 'WTS_SKIP_WAITING') return self.skipWaiting();
    // {type, keep: [help/ URLs]}: delete every HELP_CACHE entry not in keep (fragments ignored). → number deleted.
    if (d.type === 'WTS_HELP_PRUNE' && Array.isArray(d.keep)) {
        var keep = {};
        d.keep.forEach(function (u) {
            if (typeof u !== 'string') return;
            var k = route({ method: 'GET', url: u, mode: 'no-cors' });
            if (k.help) keep[k.key] = 1;
        });
        return caches.open(HELP_CACHE).then(function (c) {
            return c.keys().then(function (reqs) {
                var gone = reqs.filter(function (q) { return !keep[q.url]; });
                return Promise.all(gone.map(function (q) { return c.delete(q); })).then(function () { return gone.length; });
            });
        });
    }
    if (d.type === 'WTS_CACHE_SHELL' && typeof d.url === 'string') {
        var r = route({ method: 'GET', url: d.url, mode: 'navigate' });
        if (r.kind !== 'shell') return Promise.resolve(false);
        return caches.open(SHELL_CACHE).then(function (c) { return c.match(r.key); })
            .then(function (hit) { return hit ? true : precache(SHELL_CACHE, r.key, 'shell'); });
    }
    return null;
}

self.addEventListener('install', function (event) { event.waitUntil(install()); });
self.addEventListener('activate', function (event) { event.waitUntil(activate()); });
self.addEventListener('message', function (event) {
    var p = onMessage(event);
    if (p && event.waitUntil) event.waitUntil(p);
});
self.addEventListener('fetch', function (event) {
    var p = handleFetch(event);
    if (p) event.respondWith(p);
});

// Test hook (read-only; used by prism-build/tests/sw-offline.test.js).
self.WTS_SW = { VERSION: VERSION, SHELL_CACHE: SHELL_CACHE, LIB_CACHE: LIB_CACHE, HELP_CACHE: HELP_CACHE, CDN_LIBS: CDN_LIBS.slice(),
    SHELL_PAGES: SHELL_PAGES.slice(), SHELL_ALIASES: SHELL_ALIASES.slice(), route: route, cacheable: cacheable };
