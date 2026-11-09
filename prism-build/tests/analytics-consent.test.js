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
//   CB9  no analytics event is queued before Accept, and Accept drops any queued 'event' entry (keeps 'js' / 'config'),
//        so nothing from before the choice is sent; events after Accept are queued
//   CB10 Reject → Accept and Accept → Reject → Accept in one visit: the tag is on again (ga-disable false), appended once;
//        Escape on a first visit stores no choice
//   CB11 the in-app Privacy page follows a choice made in the banner (wts:consent-changed) and says "paused" while signed in
//   CB12 static Privacy notice / Terms of Use links in the sidebar footer (outside GA / ACCT, so on the home page for brand
//        verification); the Terms of Use notice shows until OK (wtspref_terms_seen, per terms version) and stays hidden
//        after a reload; the iOS bundle points the static links at the web addresses; reports carry the disclaimer;
//        the legal pages' tables scroll instead of breaking words
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
  if (opts.gtag) {                                               // head: the gtag wrapper + filter (needs a real Date once)
    sb.Date = Date;
    vm.runInContext(scriptsOf(blocks[0])[0], sb);
    sb.Date = { now: () => now };
  }
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
    name: 'CB8 privacy.html / terms.html: static, dated, versioned, cross-linked, cookies table, no placeholders, company line; publish allow-list; not copied to www', wp: WP, opts: false,
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
        // publishable edition: no placeholder, owner box or bracketed value in the visible text; the company line
        const vis = body.replace(/<style>[\s\S]*?<\/style>/, '');
        assert.deepStrictEqual(vis.match(/class="(ph|draft)"|\[[^\]]*\]/g) || [], [], f + ': no placeholder in the visible text');
        assert.ok(!/Owner decision|representative:/i.test(vis), f + ': no owner box, no representative line');
        assert.includes(s, 'H2Oil Engineering, a company licensed in Dubai, United Arab Emirates', f);
        // the public source comment is only the version line (open items live in docs/LEGAL-OWNER-NOTES.md, not published)
        const cm = (s.match(/<!--([\s\S]*?)-->/) || [])[1] || '';
        assert.ok(/version 1 \(9 November 2026\)/.test(cm) && /Change together/.test(cm), f + ': version comment');
        assert.ok(!/DRAFT|LEGAL ADVICE|dev-87qwkg|LICENSE|DMCC|JAFZA|DSO|ADGM/.test(cm), f + ': no review notes in the public comment');
        // every in-page anchor exists
        const ids = new Set(Array.from(s.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
        for (const m of s.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), f + ': anchor #' + m[1]);
        assert.ok(!/\bPIE\b/.test(s), f + ': no competitor names');
        assert.ok(/<h1\b/.test(s) && /<nav class="toc"/.test(s), f + ': heading + contents');
      }
      const p = pages['privacy.html'];
      // nothing the owner has not done yet is stated as done (DPAs, breach plan); link labels are disclosed
      assert.ok(!/We have a plan for handling security incidents|Our contracts with processors include|It acts as our processor/.test(p), 'no unconfirmed present-tense claims');
      assert.ok(/Before we invite anyone outside H2Oil to the account trial, our contracts with the hosting and e-mail processors will include/.test(p) && /visible label of the menu item or link clicked/.test(p), 'future-tense safeguards; link labels disclosed');
      for (const s of ['id="cookies"', '<code>_ga</code>', '<code>' + KEY + '</code>', '<code>__Host-wts_sid</code>', 'Limited Use requirements',
        'id="retention"', 'id="rights"', 'id="complaints"', 'Information Commission', 'Cookie settings', 'only if you accept',
        'the data-protection law of the United Arab Emirates that applies to us', 'the UAE data-protection authority that supervises us',
        'Up to 14 months', 'then up to 2 years', 'Our account database is in the United States', 'file storage in the European Union (Frankfurt, Germany)',
        'storing your account data in the United States is a transfer outside the UK and the EU', 'invitation-only trial']) assert.includes(p, s);
      // the account trial is running: no "when accounts launch" future tense left, and no UK / EU-only storage claim
      assert.ok(!/when (accounts|they) launch|accounts are not open yet|stored in the UK or the EU/i.test(p), 'storage and status match the live set-up');
      assert.includes(p, 'the account server that handles your account requests (your e-mail address, sign-in codes and IP address) also runs in the United States');
      // terms.html states the same status: the trial is running
      assert.ok(!/not open yet|will be offered only to invited users/i.test(pages['terms.html']), 'terms.html: no "not open yet"');
      assert.includes(pages['terms.html'], 'invitation-only trial');
      assert.ok(!/we have appointed|switched off Google signals|Arabic version/i.test(p.replace(/<!--[\s\S]*?-->/g, '')), 'no unconfirmed claim in the visible text');
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
  {
    name: 'CB9 no event queued before Accept; Accept drops queued events (js / config kept); events after Accept are queued', wp: WP, opts: false,
    run(app, assert) {
      const evs = (dl) => Array.from(dl).filter((e) => e && e[0] === 'event');
      const p = makePage(memStore(), { gtag: true });
      assert.fn(p.sb.gtag, 'gtag wrapper loaded');
      p.sb.gtag('event', 'page_view', { page_path: '/x' });
      p.sb.gtag('event', 'module_view', { module_id: 'wts' });
      assert.strictEqual(evs(p.sb.dataLayer).length, 0, 'nothing queued before consent');
      assert.ok(Array.from(p.sb.dataLayer).some((e) => e[0] === 'js') && Array.from(p.sb.dataLayer).some((e) => e[0] === 'config'), 'js + config queued');
      p.sb.dataLayer.push(['event', 'stray', {}]);            // pushed around the wrapper
      p.acc.fire('click');
      assert.strictEqual(p.appended.length, 1, 'tag loaded on Accept');
      assert.strictEqual(evs(p.sb.dataLayer).length, 0, 'queued events dropped before the tag runs');
      assert.ok(Array.from(p.sb.dataLayer).some((e) => e[0] === 'config'), 'config kept');
      p.sb.gtag('event', 'calc_click', { calc_id: 'aga3' });
      assert.strictEqual(evs(p.sb.dataLayer).length, 1, 'events after Accept are queued');
      // rejected visitor: dataLayer does not grow
      const r = makePage(memStore(), { gtag: true });
      r.rej.fire('click');
      const n = r.sb.dataLayer.length;
      for (let i = 0; i < 20; i++) r.sb.gtag('event', 'nav_click', { nav_target: 'home' });
      assert.strictEqual(r.sb.dataLayer.length, n, 'no growth after Reject');
    },
  },
  {
    name: 'CB10 Reject → Accept / Accept → Reject → Accept in one visit turn the tag back on; Escape on a first visit stores nothing', wp: WP, opts: false,
    run(app, assert) {
      const ID = 'ga-disable-G-6QKCBNWHYB';
      let p = makePage(memStore());
      p.rej.fire('click');
      assert.strictEqual(p.sb[ID], true);
      p.sb.WTS_consent.set('granted');
      assert.strictEqual(p.sb[ID], false, 'Reject → Accept: enabled');
      assert.strictEqual(p.appended.length, 1);
      p = makePage(memStore());
      p.acc.fire('click'); p.sb.WTS_consent.set('denied'); p.sb.WTS_consent.set('granted');
      assert.strictEqual(p.sb[ID], false, 'Accept → Reject → Accept: enabled again without a reload');
      assert.strictEqual(p.appended.length, 1, 'the tag is still appended once');
      const st = memStore();
      p = makePage(st);
      assert.strictEqual(p.box.hidden, false);
      p.box.fire('keydown', { key: 'Escape' });
      assert.strictEqual(p.box.hidden, true, 'Escape hides the banner');
      assert.ok(!(KEY in st.m), 'Escape stores no choice (asked again next time)');
      assert.strictEqual(p.appended.length, 0);
    },
  },
  {
    name: 'CB11 in-app Privacy page follows a banner choice (wts:consent-changed) and says "paused" while signed in', wp: WP,
    run(app, assert) {
      let choice = null;
      app.win.WTS_consent = { choice: () => choice, skipped: () => false, open() {} };
      app.win.__wtsGaLoaded = false;
      app.hook.nav('privacy');
      assert.includes(app.el('pgBody').textContent, 'currently: not chosen');
      choice = 'granted'; app.win.__wtsGaLoaded = true;
      app.win.dispatchEvent(new app.win.CustomEvent('wts:consent-changed', { detail: { choice: 'granted' } }));
      const t = app.el('pgBody').textContent;
      assert.includes(t, 'currently: accepted');
      assert.includes(t, 'usage analytics are active');
      app.hook.nav('home');
      choice = 'denied';
      app.win.dispatchEvent(new app.win.CustomEvent('wts:consent-changed', { detail: { choice: 'denied' } }));
      assert.ok(app.el('pgBody').textContent.indexOf('currently:') === -1, 'another page is not re-rendered');
      // signed in (H17): the tag is skipped whatever the choice
      choice = 'granted'; app.win.__wtsGaLoaded = false;
      app.win.WTS_consent = { choice: () => choice, skipped: () => true, open() {} };
      app.hook.nav('privacy');
      assert.includes(app.el('pgBody').textContent, 'analytics are paused while you are signed in');
      delete app.win.WTS_consent;
      app.win.__wtsGaLoaded = undefined;
    },
  },
  {
    name: 'CB12 static legal links in the sidebar footer; Terms of Use notice until OK (per version, survives a reload); iOS links absolute; report disclaimer; tables scroll', wp: WP,
    run(app, assert, ctx) {
      const html = HTML();
      const stripped = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '').replace(/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g, '');
      const foot = (stripped.match(/<div class="sidebar-footer">[\s\S]*?<\/div>/) || [''])[0];
      assert.ok(/<a href="https:\/\/welltest\.h2oil\.co\.uk\/privacy\.html" id="sbPrivacyPolicy"[^>]*>Privacy notice<\/a>/.test(foot), 'crawlable Privacy notice link in the footer');
      assert.ok(/<a href="https:\/\/welltest\.h2oil\.co\.uk\/terms\.html" id="sbTerms"[^>]*>Terms of Use<\/a>/.test(foot), 'crawlable Terms link in the footer');
      assert.strictEqual((foot.match(/privacy\.html/g) || []).length, 1, 'exactly one Privacy link in the footer');
      assert.strictEqual((foot.match(/terms\.html/g) || []).length, 1, 'exactly one Terms link in the footer');
      assert.ok(/id="sbPrivacyLink"[^>]*>Privacy — how your data is stored<\/a>/.test(foot), 'in-app Privacy page link kept');
      // Terms of Use notice
      const tn = app.el('wtsTermsNote');
      assert.ok(tn, 'notice element');
      assert.strictEqual(tn.hidden, false, 'shown on a first visit');
      assert.ok(/href="terms\.html"/.test((html.match(/<div id="wtsTermsNote"[\s\S]*?<\/div>/) || [''])[0]), 'links the terms');
      app.click('wtsTermsNoteOk');
      assert.strictEqual(tn.hidden, true, 'OK hides it');
      const seen = JSON.parse(app.storage.getItem('wtspref_terms_seen'));
      assert.strictEqual(seen.v, 1, 'terms version stored on the device');
      const r = app.reload();
      try { assert.strictEqual(r.el('wtsTermsNote').hidden, true, 'stays hidden after a reload'); } finally { r.dispose(); }
      const old = ctx.loadApp({});
      try {
        old.storage.setItem('wtspref_terms_seen', JSON.stringify({ v: 0, at: 1 }));
        const o2 = old.reload();
        try { assert.strictEqual(o2.el('wtsTermsNote').hidden, false, 'an older terms version → shown again'); } finally { o2.dispose(); }
      } finally { old.dispose(); }
      // iOS bundle: the static links point at the web addresses
      const www = path.join(ROOT, 'ios-app', 'www', 'index.html');
      if (fs.existsSync(www)) {
        const w = fs.readFileSync(www, 'utf8');
        assert.ok(!/href="(privacy|terms)\.html/.test(w), 'no relative legal link in www');
        assert.includes(w, 'href="https://welltest.h2oil.co.uk/terms.html" id="wtsTermsNoteLink"');
        assert.includes(w, 'href="https://welltest.h2oil.co.uk/privacy.html" id="sbPrivacyPolicy"');
      }
      // reports: the engineering disclaimer (PDF body and PNG footer share the constant)
      assert.ok(/const REPORT_DISCLAIMER = '[^']*competent person[^']*terms\.html'/.test(html), 'disclaimer names a competent person and the terms');
      assert.ok(html.indexOf('<div class="rp-disc">${_rEsc(REPORT_DISCLAIMER)}</div>') !== -1, 'PDF / job report footer');
      assert.ok(/wrap\(REPORT_DISCLAIMER, font\(10\), IW, 3\)/.test(html), 'PNG footer');
      const rep = app.win.buildReportHTML('T', '<p>x</p>', 's');
      assert.includes(rep, 'competent person');
      // legal pages: tables scroll at phone width instead of breaking words
      const p = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
      assert.ok(/\.tbl table \{ min-width: 560px; \}/.test(p) && /<table class="wide">/.test(p), 'tables keep a minimum width inside the scroller');
      assert.ok(!/th, td \{[^}]*overflow-wrap: anywhere/.test(p), 'cells do not break mid-word');
      for (const f of ['privacy.html', 'terms.html']) {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const toc = {};
        for (const m of s.matchAll(/<li><a href="#([a-z-]+)">([^<]+)<\/a><\/li>/g)) toc[m[1]] = m[2];
        for (const m of s.matchAll(/<h2 id="([a-z-]+)">\d+\. ([^<]+)<\/h2>/g)) assert.equal(toc[m[1]], m[2], f + ': contents entry matches heading #' + m[1]);
      }
    },
  },
];
