// Analytics consent banner (web only) + the public legal pages (privacy.html, terms.html).
//
//   CB0  the banner block sits right before the main script (the skip link stays first in <body>); the main script still ends it (sync-from-main injects the iOS bridge there)
//   CB1  no stored choice: the head loader appends no analytics tag and writes no cookie; the banner is shown
//   CB2  Accept: the tag is appended once, the choice is stored (v = Privacy notice version), the banner hides
//   CB3  Reject: no tag, ga-disable set, the _ga cookies the page can reach are expired, the choice is stored
//   CB4  a stored choice persists across a reload (granted → tag at start, denied → none; no banner either way)
//   CB5  re-asked after 12 months or for an older notice version; storage blocked → asked, Accept works for the visit
//   CB6  signed in (H17 hint): no banner, and no tag even after Accept; open() reopens, Escape hides, focus moves to Accept
//   CB7  iOS strip removes the banner and the consent API; the in-app Privacy page shows Cookie settings only on the web
//        build with the API, and its legal links use the web URLs on iOS
//   CB8  privacy.html / terms.html: static (no script, no external request), dated and versioned, link each other and the
//        app, cookies table names the consent key, placeholders for the company facts; publish allow-list; not in www
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WP = 'LEGAL';
const ROOT = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..');
const HTML = () => fs.readFileSync(path.join(ROOT, 'well-testing-app.html'), 'utf8');
const KEY = 'wtspref_analytics_consent';

function gaBlocks(html) { return html.match(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g) || []; }
function scriptsOf(block) { const out = []; block.replace(/<script>([\s\S]*?)<\/script>/g, (m, s) => { out.push(s); return m; }); return out; }

// A tiny DOM for the head loader + the banner block.
function makePage(store, opts) {
  opts = opts || {};
  const now = opts.now || Date.UTC(2026, 10, 9, 12, 0, 0);
  const appended = [];
  const cookieWrites = [];
  const ids = {};
  function elem(id, extra) {
    const e = Object.assign({ id, hidden: false, listeners: {}, focused: 0,
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      focus() { this.focused++; doc.activeElement = this; },
      contains(x) { return x === this || (this.kids || []).indexOf(x) !== -1; },
      fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, ev || {}))); } }, extra || {});
    ids[id] = e; return e;
  }
  const doc = {
    activeElement: null, _cookie: opts.cookie || '',
    get cookie() { return this._cookie; },
    set cookie(v) { cookieWrites.push(v); },
    head: { appendChild: (s) => appended.push(s) }, documentElement: null,
    createElement: (t) => ({ tag: t }),
    getElementById: (id) => ids[id] || null,
    contains: () => true,
  };
  const sb = {
    Date: { now: () => now }, JSON, Object, String, Array,
    document: doc, location: { hostname: 'welltest.h2oil.co.uk' },
    localStorage: store,
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    events: [], dispatchEvent(e) { sb.events.push(e); },
  };
  sb.window = sb;
  vm.createContext(sb);
  const html = HTML();
  const blocks = gaBlocks(html);
  vm.runInContext(scriptsOf(blocks[0])[1], sb);                  // head: consent API + loader
  // body end: the banner markup (ids) + its script
  const banner = blocks[2];
  const acc = elem('wtsConsentAccept'), rej = elem('wtsConsentReject');
  const box = elem('wtsConsent', { hidden: /id="wtsConsent"[^>]*\bhidden\b/.test(banner), kids: [acc, rej] });
  vm.runInContext(scriptsOf(banner)[0], sb);
  return { sb, appended, cookieWrites, box, acc, rej, now };
}
function memStore(init) {
  const m = Object.assign({}, init || {});
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}

module.exports = [
  {
    name: 'CB1-CB3 no choice → no tag, no cookie, banner shown; Accept → tag once + stored; Reject → no tag, ga-disable, cookies expired', wp: WP, opts: false,
    run(app, assert) {
      const blocks = gaBlocks(HTML());
      assert.equal(blocks.length, 3, 'loader + tracker in <head>, banner in <body>');
      assert.ok(/<!-- GA:END -->\n<script>\s*\/\* ═+\s*WELL TESTING SUITE/.test(HTML()), 'banner block right before the main script (skip link stays first in <body>)');
      assert.ok(/\}\)\(\);\s*<\/script>\s*<\/body>/.test(HTML()), 'the main script still ends the body (iOS bridge anchor of sync-from-main.js)');
      // CB1
      let st = memStore();
      let p = makePage(st);
      assert.strictEqual(p.appended.length, 0, 'no analytics tag before consent');
      assert.strictEqual(p.sb.__wtsGaLoaded, false);
      assert.deepStrictEqual(p.cookieWrites, [], 'no cookie written');
      assert.strictEqual(p.box.hidden, false, 'banner shown');
      assert.strictEqual(p.sb.WTS_consent.choice(), null);
      // CB2 Accept
      p.acc.fire('click');
      assert.strictEqual(p.appended.length, 1, 'tag appended once');
      assert.ok(/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-/.test(p.appended[0].src) && p.appended[0].async === true);
      assert.strictEqual(p.sb.__wtsGaLoaded, true);
      assert.deepStrictEqual(JSON.parse(st.m[KEY]), { choice: 'granted', v: 1, at: p.now }, 'stored with the notice version');
      assert.strictEqual(p.box.hidden, true, 'banner hidden');
      p.sb.WTS_consent.set('granted');
      assert.strictEqual(p.appended.length, 1, 'never twice');
      assert.ok(p.sb.events.some((e) => e.type === 'wts:consent-changed' && e.detail.choice === 'granted'), 'change event');
      // withdraw later: ga-disable + cookies expired
      p.sb.document._cookie = '_ga=GA1.1.123; _ga_6QKCBNWHYB=GS1.1.x; wts_other=1';
      p.sb.WTS_consent.set('denied');
      assert.strictEqual(p.sb['ga-disable-G-6QKCBNWHYB'], true, 'tag disabled after withdrawal');
      assert.ok(p.cookieWrites.some((c) => /^_ga=; expires=Thu, 01 Jan 1970/.test(c) && /domain=\.h2oil\.co\.uk/.test(c)), 'parent-domain _ga expired');
      assert.ok(p.cookieWrites.some((c) => /^_ga_6QKCBNWHYB=; expires=Thu, 01 Jan 1970/.test(c)), '_ga_<id> expired');
      assert.ok(!p.cookieWrites.some((c) => /^wts_other/.test(c)), 'other cookies untouched');
      // CB3 Reject on a fresh page
      st = memStore();
      p = makePage(st);
      p.rej.fire('click');
      assert.strictEqual(p.appended.length, 0, 'no tag after reject');
      assert.strictEqual(p.sb.__wtsGaLoaded, false);
      assert.strictEqual(p.sb['ga-disable-G-6QKCBNWHYB'], true);
      assert.strictEqual(JSON.parse(st.m[KEY]).choice, 'denied');
      assert.strictEqual(p.box.hidden, true);
      // equal prominence: same element type and class, one click each
      const banner = gaBlocks(HTML())[2];
      assert.ok(/<button type="button" id="wtsConsentAccept">Accept<\/button>\s*<button type="button" id="wtsConsentReject">Reject<\/button>/.test(banner), 'two equal buttons');
      assert.ok(/role="region"/.test(banner) && /aria-labelledby="wtsConsentTitle"/.test(banner), 'labelled region, no modal');
      assert.ok(/href="privacy\.html#cookies"/.test(banner), 'link to the cookies section');
    },
  },
  {
    name: 'CB4-CB6 choice persists; re-asked after 12 months / new notice version; storage blocked; signed in → no banner, no tag; open / Escape', wp: WP, opts: false,
    run(app, assert) {
      const now = Date.UTC(2026, 10, 9, 12, 0, 0);
      let p = makePage(memStore({ [KEY]: JSON.stringify({ choice: 'granted', v: 1, at: now - 30 * 864e5 }) }));
      assert.strictEqual(p.appended.length, 1, 'granted earlier → tag at start'); assert.strictEqual(p.box.hidden, true, 'no banner');
      p = makePage(memStore({ [KEY]: JSON.stringify({ choice: 'denied', v: 1, at: now - 30 * 864e5 }) }));
      assert.strictEqual(p.appended.length, 0, 'denied earlier → none'); assert.strictEqual(p.box.hidden, true, 'no banner');
      // CB5 expiry and version
      p = makePage(memStore({ [KEY]: JSON.stringify({ choice: 'granted', v: 1, at: now - 366 * 864e5 }) }));
      assert.strictEqual(p.appended.length, 0, 'expired → no tag'); assert.strictEqual(p.box.hidden, false, 'expired → asked again');
      p = makePage(memStore({ [KEY]: JSON.stringify({ choice: 'granted', v: 0, at: now }) }));
      assert.strictEqual(p.appended.length, 0, 'older notice version → no tag'); assert.strictEqual(p.box.hidden, false, 'asked again');
      p = makePage(memStore({ [KEY]: '{not json' }));
      assert.strictEqual(p.appended.length, 0); assert.strictEqual(p.box.hidden, false, 'unreadable → asked');
      const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
      p = makePage(blocked);
      assert.strictEqual(p.box.hidden, false, 'blocked storage → asked');
      p.acc.fire('click');
      assert.strictEqual(p.appended.length, 1, 'Accept works for this visit');
      assert.strictEqual(p.sb.WTS_consent.choice(), 'granted', 'kept in memory');
      // CB6 signed in
      const st = memStore({ wtsacct_hint: JSON.stringify({ signedIn: true, v: 3 }) });
      p = makePage(st);
      assert.strictEqual(p.box.hidden, true, 'signed in → no banner');
      p.sb.WTS_consent.set('granted');
      assert.strictEqual(p.appended.length, 0, 'signed in → no tag even after accepting');
      assert.strictEqual(JSON.parse(st.m[KEY]).choice, 'granted', 'the choice is still stored for later');
      // open / Escape / focus
      p = makePage(memStore({ [KEY]: JSON.stringify({ choice: 'denied', v: 1, at: now }) }));
      assert.strictEqual(p.box.hidden, true);
      p.sb.WTS_consent.open();
      assert.strictEqual(p.box.hidden, false, 'open() shows it'); assert.ok(p.acc.focused >= 1, 'focus on Accept');
      p.box.fire('keydown', { key: 'Escape' });
      assert.strictEqual(p.box.hidden, true, 'Escape hides it');
      assert.strictEqual(p.appended.length, 0, 'Escape changes nothing');
    },
  },
  {
    name: 'CB7 iOS bundle has no banner or consent API; in-app Privacy: Cookie settings on the web build only, legal links (web URLs on iOS)', wp: WP,
    run(app, assert, ctx) {
      const html = HTML();
      const ios = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '<!-- GA stripped from iOS bundle -->');
      for (const s of ['id="wtsConsent"', 'wtsConsentAccept', 'WTS_consent =', 'wtspref_analytics_consent', 'Analytics cookies</h2>']) {
        assert.ok(ios.indexOf(s) === -1, 'iOS bundle still has ' + s);
      }
      const www = path.join(ROOT, 'ios-app', 'www', 'index.html');
      if (fs.existsSync(www)) {
        const w = fs.readFileSync(www, 'utf8');
        assert.ok(w.indexOf('wtsConsent') === -1 && w.indexOf('wtspref_analytics_consent') === -1, 'www/index.html has no banner');
        assert.ok(w.indexOf('// ── iOS Native Bridge ──') !== -1, 'www/index.html still carries the iOS bridge');
      }
      // harness (no head scripts): no consent API → no Cookie settings link; legal links relative on the web
      app.hook.nav('privacy');
      assert.ok(!app.el('privacy_cookie_settings'), 'no Cookie settings without the consent API');
      assert.equal(app.el('privacy_full_link').getAttribute('href'), 'privacy.html');
      // web build with the consent API
      let opened = 0;
      app.win.WTS_consent = { choice: () => 'denied', skipped: () => false, open: () => { opened++; } };
      app.win.__wtsGaLoaded = false;
      app.hook.nav('home'); app.hook.nav('privacy');
      const t = app.el('pgBody').textContent;
      assert.includes(t, 'you turned analytics off');
      assert.includes(t, 'currently: rejected');
      const cs = app.el('privacy_cookie_settings');
      assert.ok(cs, 'Cookie settings link');
      app.click(cs);
      assert.equal(opened, 1, 'Cookie settings opens the banner');
      app.win.WTS_consent = { choice: () => null, skipped: () => false, open() {} };
      app.hook.nav('home'); app.hook.nav('privacy');
      assert.includes(app.el('pgBody').textContent, 'analytics are not loaded until you accept them');
      delete app.win.WTS_consent;
      app.win.__wtsGaLoaded = undefined;
      // iOS app: absolute web URLs, no Cookie settings even if an API were present
      const a2 = ctx.loadApp({ globals: { isIOSApp: true } });
      try {
        a2.win.WTS_consent = { choice: () => null, skipped: () => false, open() {} };
        a2.hook.nav('privacy');
        assert.equal(a2.el('privacy_full_link').getAttribute('href'), 'https://welltest.h2oil.co.uk/privacy.html');
        assert.equal(a2.el('privacy_terms_link').getAttribute('href'), 'https://welltest.h2oil.co.uk/terms.html');
        assert.ok(!a2.el('privacy_cookie_settings'), 'no Cookie settings on iOS');
        a2.hook.nav('releasenotes');
        assert.equal(a2.el('rnTermsLink').getAttribute('href'), 'https://welltest.h2oil.co.uk/terms.html');
      } finally { a2.dispose(); }
      // the account consent ticks link the texts (66, web only)
      const s66 = fs.readFileSync(path.join(BUILD, '66-account.js'), 'utf8');
      assert.ok(/<a href="terms\.html" target="_blank" rel="noopener" id="acct_terms_link">Terms of Use<\/a>/.test(s66), 'e-mail consent tick links the terms');
      assert.ok(/id: 'acct_oauth_privacy_link'/.test(s66) && /href: 'privacy\.html', target: '_blank', rel: 'noopener'/.test(s66), 'provider consent tick links the notice');
    },
  },
  {
    name: 'CB8 privacy.html / terms.html: static, dated, versioned, cross-linked, cookies table, placeholders; publish allow-list; not copied to www', wp: WP, opts: false,
    run(app, assert) {
      const pages = {};
      for (const f of ['privacy.html', 'terms.html']) {
        const s = pages[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.ok(/^<!doctype html>/i.test(s) && /<meta name="viewport" content="width=device-width, initial-scale=1">/.test(s), f + ' doctype + viewport');
        assert.ok(!/<script\b/i.test(s), f + ': no JavaScript');
        assert.ok(!/<(img|link|iframe|object|embed|video|audio|source)\b/i.test(s), f + ': no external resources');
        assert.ok(!/@import|url\(/i.test(s), f + ': no CSS fetches');
        const body = s.replace(/<!--[\s\S]*?-->/g, '');
        const urls = (body.match(/https?:\/\/[^\s"'<),]+/g) || []);
        assert.deepStrictEqual(urls.filter((u) => !/^https:\/\/welltest\.h2oil\.co\.uk(\/|$)/.test(u)), [], f + ': only the app address');
        assert.includes(s, 'Last updated: 9 November 2026');
        assert.ok(/(Privacy notice|Terms of Use) version 1/.test(s), f + ' version string');
        assert.includes(s, 'prefers-color-scheme: light');
        assert.includes(s, 'href="well-testing-app.html"');
        assert.includes(s, f === 'privacy.html' ? 'href="terms.html"' : 'href="privacy.html"');
        assert.includes(s, 'mailto:software@h2oil.co.uk');
        for (const ph of ['[COMPANY LEGAL NAME]', '[TRADE LICENCE NO.]', '[LICENSING AUTHORITY / FREE ZONE]', '[REGISTERED ADDRESS, DUBAI, UAE]']) assert.includes(s, ph, f);
        assert.ok(/NOT LEGAL ADVICE/.test(s), f + ': draft-for-review comment');
        // every in-page anchor exists
        const ids = new Set(Array.from(s.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
        for (const m of s.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), f + ': anchor #' + m[1]);
        assert.ok(!/\bPIE\b/.test(s), f + ': no competitor names');
        assert.ok(/<h1\b/.test(s) && /<nav class="toc"/.test(s), f + ': heading + contents');
      }
      const p = pages['privacy.html'];
      for (const s of ['id="cookies"', '<code>_ga</code>', '<code>' + KEY + '</code>', '<code>__Host-wts_sid</code>', 'Limited Use requirements',
        'id="retention"', 'id="rights"', 'id="complaints"', 'Information Commission', 'Cookie settings', 'only if you accept']) assert.includes(p, s);
      // cross-page anchors used by terms.html exist in privacy.html
      const pids = new Set(Array.from(p.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
      for (const m of pages['terms.html'].matchAll(/href="privacy\.html#([^"]+)"/g)) assert.ok(pids.has(m[1]), 'privacy.html#' + m[1]);
      // publish allow-list; the iOS sync does not need or copy them
      const pub = require(path.join(BUILD, 'publish-site.js'));
      assert.ok(pub.ALLOW.optional.includes('privacy.html') && pub.ALLOW.optional.includes('terms.html'), 'publish allow-list');
      const sync = fs.readFileSync(path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js'), 'utf8');
      assert.ok(sync.indexOf('privacy.html') === -1 && sync.indexOf('terms.html') === -1, 'sync-from-main does not copy them');
    },
  },
];
