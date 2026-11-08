// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/68-account-page.js — the `account` page (docs/ACCOUNTS-PLAN.md §11.3): profile and security, projects,
// devices, sign-in methods, sync options, storage, data, activity and the account help. Round-10.
//
// WP0 FOUNDATION SKELETON. Same guard as 66; outside it nothing is defined. Inside it WTS_accountPage holds the planned
// registry entry, but register() does NOT add it to WTS_calcRegistry yet: the host's `navHidden` support (§5.4 H7, WP-H)
// must land first, or the page would appear as a sidebar row and a home tile. render(body) paints nothing. WP-C1 builds both.
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) return;

  var VERSION = '0.1.0-wp0';
  function render(body) { return false; }
  var entry = {
    key: 'account', title: 'Account', sub: 'Sign-in, cloud projects and your data', group: 'Overview', icon: '&#9729;',
    navHidden: true, render: render,
  };
  G.WTS_accountPage = {
    VERSION: VERSION, entry: entry, render: render,
    // true once the entry is in WTS_calcRegistry; WP0 never registers (host H7 first)
    register: function () { return false; },
  };
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis;
  if (G.WTS_calcRegistry && G.WTS_calcRegistry.account) throw new Error('68 self-test: the account page must not register in WP0');
})();
