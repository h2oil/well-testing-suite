// Accounts — user insight (v4.0 follow-up): the optional profile, the project summary sent with Save to cloud and the richer
// admin page (66 / 67 / 68 / 69). The app runs on the production https location against the in-memory fake API
// (tests/_acct-fake-server.js: PUT /account/profile, GET /me profile, the sign-up profile, the commit's summary); the admin
// routes are answered by a small fetch wrapper, as in acct-admin (the server side is tested in server/test).
//
//   IN1  WTS_cloudSync.projectSummary(payload) — pure, on a realistic multi-well project: well names (registry + Client & Well
//        Info, unique, active first), client / operator / company / field / rig / country / job ref (active well first, other
//        wells, then the meta), modules used; caps (50 wells, 80 / 120 characters, 40 modules), control characters, bad input
//   IN2  Save to cloud of a seeded multi-well project: the commit carries the summary (the fake keeps the latest per project) and
//        it passes the contract (SummaryReq); a later save replaces it; a project without Client & Well Info still saves
//   IN3  sign-up (e-mail code): the new-account step shows the five optional fields (country list with names, nothing chosen),
//        says they are optional; filled → codeVerify carries profile (trimmed, empty → null) and GET /me has it; left empty →
//        no profile key at all; nothing typed is written to localStorage
//   IN4  sign-up with a provider: the consent step shows the optional fields; Create sends {consent, profile}; the countryHint
//        preselects the country
//   IN5  Account page "Your profile": filled from GET /me, Save → PUT /account/profile (exact body), message; Clear → all null;
//        a bad_request answer gets plain words; the card's fields are not autosaved
//   IN6  admin: users table with name, company / job title, wells (count + first names), clients, fields; tops tables; a row
//        opens the detail panel (GET /admin/users/:id) with profile, e-mail, locations, method, dates, storage and every
//        project with its summary; Escape / × close it; every server string escaped (page, panel and CSV); CSV has the new
//        columns with the formula guard; an older server without profile / work / tops still renders
//   IN7  review fix: the summary text follows the server's rule (NFKC first, C1 controls removed, the cap counted after NFKC on
//        a code-point boundary): every value passes SummaryReq and the server's normSummary; a commit whose summary the server
//        refuses (bad_request, field summary…) is sent once more without it, so the save never fails on the summary
//   IN8  review fix: the profile follows the server's rules: a phone with letters is stopped at Create with the allowed
//        characters named (no request), C1 / NFKC text cleaned; the Account page says the phone rule and sends nothing; a
//        profile refusal from the server gets profile words; /me countryHint preselects the Account page country
//   IN9  review fix: an existing account on older Terms / Privacy versions (consent_required existing:true, provider
//        existingAccount) gets an "Updated Terms and Privacy notice" step without the new-account wording or profile fields
//   IN10 review fix: the admin user detail panel closes when the page leaves the admin route and when the account signs out
'use strict';

const T = require('./_acct-app');
const S = require('./_acct-shapes');
const WP = 'ACIN';
const E1 = 'name@company.example';
const EVIL = '<img src=x onerror="alert(1)">';

function json(status, body) {
  const text = JSON.stringify(body);
  return Promise.resolve({ status, headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null), has: () => false, forEach() {} },
    json: () => Promise.resolve(JSON.parse(text)), arrayBuffer: () => Promise.resolve(Buffer.from(text)) });
}
// boot with a recording fetch: every request body to the API is kept (log), admin routes answered by o.admin (as in acct-admin)
function boot(ctx, o) {
  o = o || {};
  const fake = o.fake || T.F.createFakeServer({});
  const br = fake.browser('dev-insight');
  const log = [];
  const admin = o.admin || null;
  const fetch = (u, i) => {
    const url = T.abs(u); const p = new URL(url).pathname; const method = (i && i.method) || 'GET';
    const body = i && typeof i.body === 'string' ? JSON.parse(i.body) : null;
    log.push({ url, path: p, method, body });
    if (admin && p.startsWith('/api/v1/admin/')) {
      const r = admin.answer(p, new URL(url).searchParams, method, body);
      if (r) return r;
      return json(404, { error: 'not_found' });
    }
    return br.fetch(url, i).then((r) => {
      if (!admin || p !== '/api/v1/me' || r.status !== 200) return r;
      return { status: r.status, headers: r.headers, json: () => r.json().then((j) => Object.assign(j, { admin: true })) };
    });
  };
  const t = T.boot(ctx, Object.assign({}, o, { fake, browser: br, globals: Object.assign({ fetch }, o.globals || {}) }));
  t.log = log;
  return t;
}
const reqs = (t, re, m) => t.log.filter((x) => re.test(x.path) && (!m || x.method === m));
const lsDump = (t) => { const out = []; for (let i = 0; i < t.storage.length; i++) { const k = t.storage.key(i); out.push(k + '=' + t.storage.getItem(k)); } return out.join('\n'); };

// a realistic three-well project as WTS_project._buildPayload writes it (active well w2: its keys are the live storage keys)
function multiWellPayload() {
  const ci = (o) => JSON.stringify(Object.assign({ engineer: 'Sam Example', position: 'Well Test Engineer', company: 'Service Co Example', eng_email: 'sam@company.example' }, o));
  return {
    format: 'h2oilproj', version: '1.0', generator: 'H2Oil Well Testing Suite', savedAt: '2026-11-09T10:00:00.000Z',
    meta: { client: 'Operator Energy Ltd', well: 'Alpha-2', field: 'Alpha Field', operator: 'Operator Energy Ltd' },
    modules: {
      storage: { keys: {
        h2oil_client_info: ci({ client: 'Operator Energy Ltd', well: 'Alpha-2 ST1', field: 'Alpha Field, Block 12', operator: 'Operator Energy Ltd', country: 'Ghana, West Africa', rig: '', ref: 'PO-2026-0042' }),
        wts_page_choke: JSON.stringify({ v: 1, t: 1, f: { bean: '24' } }),
        wts_page_hydrate: JSON.stringify({ v: 1, t: 1, f: { hy_T: '38' } }),
        wts_prism_state: JSON.stringify({ v: 1 }),
        wts_report_templates: '[]',
      }, skipped: [] },
      wells: { v: 1, active: 'w2', wells: [
        { id: 'w1', name: 'Alpha-1', created: '2026-11-01T00:00:00.000Z', data: { v: 1, keys: {
          h2oil_client_info: ci({ client: 'Operator Energy Ltd', well: 'Alpha-1', field: 'Alpha Field', operator: 'Operator Energy Ltd', rig: 'Rig A' }),
          wts_page_esdhi: JSON.stringify({ v: 1, t: 1, f: { x: '1' } }) }, modules: {} } },
        { id: 'w2', name: 'Alpha-2', created: '2026-11-02T00:00:00.000Z' },
        { id: 'w3', name: 'alpha-1', created: '2026-11-03T00:00:00.000Z', data: { v: 1, keys: { wts_page_cheminj: JSON.stringify({ v: 1, t: 1, f: {} }) }, modules: {} } },
      ] },
      clientinfo: { client: 'Operator Energy Ltd' },
      prism_gauges: { v: 1, series: [] },
      wts: { system: 'imperial' },
    },
  };
}

module.exports = [
  {
    name: 'IN1 projectSummary: a realistic multi-well project → wells, client, operator, company, field, rig, country, job ref, modules; caps', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        const sum = T.J(t.sync().projectSummary(multiWellPayload(), 'Alpha DST campaign'));
        assert.deepStrictEqual(sum, {
          name: 'Alpha DST campaign',
          wells: ['Alpha-2 ST1', 'Alpha-2', 'Alpha-1'],                        // active first; 'alpha-1' (w3) is the same name
          client: 'Operator Energy Ltd', operator: 'Operator Energy Ltd', company: 'Service Co Example',
          field: 'Alpha Field, Block 12',                                       // the active well's field wins
          rig: 'Rig A',                                                         // empty on the active well → the next well's
          country: 'Ghana, West Africa', jobRef: 'PO-2026-0042',
          modules: ['cheminj', 'choke', 'clientinfo', 'esdhi', 'hydrate', 'prism'],     // pages with data in any well; prism_gauges → prism
        }, JSON.stringify(sum));
        assert(S.checkShape('SummaryReq', sum).ok, JSON.stringify(S.checkShape('SummaryReq', sum).errors));
        // a snapshot object is read through its payload; no name → the meta / well name
        assert.strictEqual(t.sync().projectSummary({ payload: multiWellPayload(), core: {} }).name, 'Alpha-2 ST1');
        // a single-well project without a well list: the Client & Well Info well, else the meta well
        const one = T.J(t.sync().projectSummary({ meta: { client: 'X Ltd', well: 'Solo-1' }, modules: { storage: { keys: {} } } }));
        assert.deepStrictEqual(one, { name: 'Solo-1', wells: ['Solo-1'], client: 'X Ltd' });
        // caps and plain text
        const many = { meta: {}, modules: { storage: { keys: { h2oil_client_info: JSON.stringify({ client: 'C\u0000lient\n\tLtd  ' + 'x'.repeat(200), well: 'W' }) } },
          wells: { v: 1, active: 'w0', wells: Array.from({ length: 60 }, (_, i) => ({ id: 'w' + i, name: 'Well-' + i + '-' + 'y'.repeat(100), data: { keys: {} } })) } } };
        for (let i = 0; i < 50; i++) many.modules.storage.keys['wts_page_m' + String(i).padStart(2, '0')] = '{}';
        const s2 = T.J(t.sync().projectSummary(many));
        assert.strictEqual(s2.wells.length, 50, 'at most 50 wells');
        assert(s2.wells.every((w) => w.length <= 80), 'each ≤ 80');
        assert.strictEqual(s2.client.length, 120); assert(/^C lient Ltd x/.test(s2.client), s2.client.slice(0, 20));
        assert.strictEqual(s2.modules.length, 40, 'at most 40 modules');
        assert(S.checkShape('SummaryReq', s2).ok, JSON.stringify(S.checkShape('SummaryReq', s2).errors));
        // bad input never throws
        assert.deepStrictEqual(T.J(t.sync().projectSummary(null)), {});
        assert.deepStrictEqual(T.J(t.sync().projectSummary({ modules: { storage: { keys: { h2oil_client_info: '{broken' } } } })), {});
        assert.deepStrictEqual(T.J(t.sync().projectSummary({ meta: { client: { x: 1 }, well: 7 } })), { name: '7', wells: ['7'] });
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN2 Save to cloud: the commit carries the project summary (contract shape); the fake keeps the latest; no Client & Well Info is fine', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const storage = T.createStorage({ wtspref_cloud_beta: '1',
        h2oil_client_info: JSON.stringify({ client: 'Operator Energy Ltd', well: 'Example-1', field: 'Alpha Field', operator: 'Operator Energy Ltd', rig: 'Rig A', country: 'Oman', ref: 'JOB-7' }),
        wts_page_hydrate: JSON.stringify({ v: 1, t: 1, f: { hy_T: '38' } }),
        wts_wells: JSON.stringify({ v: 1, active: 'w1', wells: [{ id: 'w1', name: 'Example-1', created: '2026-11-01T00:00:00.000Z', modified: null },
          { id: 'w2', name: 'Example-2', created: '2026-11-02T00:00:00.000Z', modified: null }] }),
        wts_well_w2: JSON.stringify({ v: 1, savedAt: '2026-11-02T00:00:00.000Z', keys: { wts_page_choke: JSON.stringify({ v: 1, t: 5, f: { bean: '32' } }),
          h2oil_client_info: JSON.stringify({ client: 'Operator Energy Ltd', well: 'Example-2 ST1' }) }, modules: {} }),
      });
      const t = boot(ctx, { storage });
      try {
        await t.signIn(E1, { handover: 'later' });
        await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
        const r = await t.sync().saveToCloud({});
        assert.strictEqual(r.rev, 1);
        const c = reqs(t, /\/commit$/, 'POST').pop();
        assert(c && c.body.summary, 'the commit carries a summary');
        assert(S.checkShape('CommitReq', c.body).ok, JSON.stringify(S.checkShape('CommitReq', c.body).errors));
        const sm = c.body.summary;
        assert.deepStrictEqual(sm.wells, ['Example-1', 'Example-2 ST1', 'Example-2'], JSON.stringify(sm.wells));
        assert.deepStrictEqual([sm.client, sm.operator, sm.field, sm.rig, sm.country, sm.jobRef], ['Operator Energy Ltd', 'Operator Energy Ltd', 'Alpha Field', 'Rig A', 'Oman', 'JOB-7']);
        assert.strictEqual(sm.name, c.body.meta.name, 'the project name');
        assert(sm.modules.includes('hydrate') && sm.modules.includes('choke') && sm.modules.includes('clientinfo'), JSON.stringify(sm.modules));
        const p = Array.from(t.fake.state.projects.values())[0];
        assert.deepStrictEqual(p.summary, sm, 'the fake keeps it');
        // the summary does not change the snapshot hash: an unchanged project still sends nothing
        const r2 = await t.sync().saveToCloud({});
        assert(r2.unchanged, 'unchanged');
        // a changed well (the inactive well's blob) → the next commit's summary replaces the stored one
        t.storage.setItem('wts_well_w2', JSON.stringify({ v: 1, savedAt: '2026-11-03T00:00:00.000Z', keys: { wts_page_choke: JSON.stringify({ v: 1, t: 6, f: { bean: '40' } }),
          h2oil_client_info: JSON.stringify({ client: 'Operator Energy Ltd', well: 'Example-2 ST2', rig: 'Rig B' }) }, modules: {} }));
        t.a.fire('document', 'wts:autosaved', {});
        const r3 = await t.sync().saveToCloud({});
        assert.strictEqual(r3.rev, 2, JSON.stringify(r3));
        assert.deepStrictEqual(p.summary.wells, ['Example-1', 'Example-2 ST2', 'Example-2']);
        assert.strictEqual(p.summary.rig, 'Rig A', 'the active well first');
        // the app's prefilled "Report prepared by" company is not reported as the user's company
        assert.strictEqual(p.summary.company, undefined, JSON.stringify(p.summary));
      } finally { t.dispose(); }
      // no Client & Well Info at all: the save works, the summary has what there is
      const t2 = boot(ctx, { storage: T.createStorage({ wtspref_cloud_beta: '1', wts_page_pipelife: JSON.stringify({ v: 1, t: 1, f: { pl_x: '3' } }) }) });
      try {
        await t2.signIn('two@company.example', { handover: 'later' });
        await t2.until(() => t2.acct().state().status === 'signedIn' && !t2.el('acct_dlg_ov'), 'signed in');
        const r = await t2.sync().saveToCloud({});
        assert.strictEqual(r.rev, 1);
        const c = reqs(t2, /\/commit$/, 'POST').pop();
        assert(S.checkShape('CommitReq', c.body).ok, JSON.stringify(S.checkShape('CommitReq', c.body).errors));
        assert(!c.body.summary || !c.body.summary.client, 'no client invented');
        assert(c.body.summary && c.body.summary.modules.includes('pipelife'), JSON.stringify(c.body.summary));
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'IN3 sign-up (e-mail code): five optional profile fields; filled → codeVerify carries profile, /me has it; empty → no profile key', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        const r = await t.signIn('new.person@company.example', { consent: false });
        assert(r.consentShown, 'the new-account step');
        const body = t.text('acct_dlg_body');
        assert(/About you \(optional\)/.test(body), 'the fieldset says optional');
        assert(/All optional/.test(t.text('acct_pf_note')));
        ['fullName', 'company', 'jobTitle', 'country', 'phone'].forEach((k) => assert(t.el('acct_su_pf_' + k), 'field ' + k));
        assert.strictEqual(t.a.findAll('#acct_su_pf label .acct-opt').length, 5, 'each label says (optional)');
        const sel = t.el('acct_su_pf_country');
        const opts = t.a.findAll('#acct_su_pf_country option');
        assert(opts.length > 240, 'the country list: ' + opts.length);
        assert.strictEqual(sel.value, '', 'nothing chosen without a hint');
        assert(opts.some((o) => o.getAttribute('value') === 'AE' && /United Arab Emirates|AE/.test(o.textContent)));
        assert.strictEqual(t.el('acct_su_pf_fullName').getAttribute('maxlength'), '80');
        assert.strictEqual(t.el('acct_su_pf_company').getAttribute('maxlength'), '120');
        assert.strictEqual(t.el('acct_su_pf_phone').getAttribute('maxlength'), '40');
        t.a.input('acct_su_pf_fullName', '  Sam   Example ');
        t.a.input('acct_su_pf_company', 'Operator Energy Ltd');
        t.a.input('acct_su_pf_jobTitle', '');
        sel.value = 'AE'; t.a.fire(sel, 'change');
        t.a.check('acct_consent_ok', true);
        t.click('acct_create');
        await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
        await t.settle();
        const v = reqs(t, /\/auth\/code\/verify$/, 'POST').pop();
        assert.deepStrictEqual(v.body.profile, { fullName: 'Sam Example', company: 'Operator Energy Ltd', jobTitle: null, country: 'AE', phone: null });
        assert(v.body.consent, 'with the consent');
        assert(S.checkShape('CodeVerifyReq', v.body).ok);
        assert.deepStrictEqual(T.J(t.acct().profile()), { fullName: 'Sam Example', company: 'Operator Energy Ltd', jobTitle: null, country: 'AE', phone: null });
        assert(!/Sam Example|Operator Energy Ltd/.test(lsDump(t)), 'nothing typed is in localStorage');
      } finally { t.dispose(); }
      const t2 = boot(ctx, {});
      try {
        const r = await t2.signIn('other.person@company.example', {});
        assert(r.code);
        await t2.until(() => t2.acct().state().status === 'signedIn', 'signed in');
        const v = reqs(t2, /\/auth\/code\/verify$/, 'POST').filter((x) => x.body && x.body.consent).pop();
        assert(v, 'the consent request');
        assert(!('profile' in v.body), 'no profile key when every field is empty');
        assert.strictEqual(t2.acct().profile(), null);
        // the sign-in of an existing account never shows the fields
        assert(!t2.el('acct_su_pf'));
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'IN4 sign-up with a provider: the consent step has the optional fields; Create sends {consent, profile}; countryHint preselects', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        const I = t.acct();
        // drive the finish dialog's consent step directly with a server answer (the provider round trip is in acct-oauth)
        const sent = [];
        I.finishProviderSignIn = (b) => { sent.push(JSON.parse(JSON.stringify(b))); return Promise.resolve({ next: 'consent', newAccountEmailMasked: 'n•••@company.example', terms: '1', privacy: '2', countryHint: 'GB' }); };
        assert(I.oauthUI && typeof I.oauthUI.openFinish === 'function', 'oauthUI');
        t.storage.setItem('wtsacct_hint', JSON.stringify({ oauth: { provider: 'google', route: 'home', at: Date.now(), purpose: 'signin' } }));
        I.oauthUI.openFinish();
        await t.until(() => t.el('acct_oauth_su_pf_fullName'), 'profile fields on the consent step');
        assert(/About you \(optional\)/.test(t.text('acct_oauth_body')));
        assert.strictEqual(t.el('acct_oauth_su_pf_country').value, 'GB', 'the countryHint is the default');
        t.a.input('acct_oauth_su_pf_jobTitle', 'Production Engineer');
        t.a.find('#acct_oauth_consent_ok').checked = true;
        t.click('acct_oauth_create');
        await t.settle();
        const last = sent[sent.length - 1];
        assert.deepStrictEqual(last, { consent: { terms: '1', privacy: '2' }, profile: { fullName: null, company: null, jobTitle: 'Production Engineer', country: 'GB', phone: null } }, JSON.stringify(last));
        assert(S.checkShape('OAuthFinishReq', last).ok, JSON.stringify(S.checkShape('OAuthFinishReq', last).errors));
        // the contract refuses a profile without the consent
        assert(!S.checkShape('OAuthFinishReq', { profile: { jobTitle: 'x' } }).ok);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN5 Account page "Your profile": filled from /me, Save → PUT /account/profile, Clear, plain errors, never autosaved', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        await t.signIn(E1);
        await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
        t.fake.user(E1).profile = { fullName: 'Sam <b>Example</b>', company: 'Operator Energy Ltd', jobTitle: null, country: 'OM', phone: null };
        await t.acct().refresh();
        t.w.WTS_nav('account');
        await t.until(() => t.el('acct_card_myprofile'), 'the card');
        assert(/Your profile/.test(t.text('acct_card_myprofile')));
        assert.strictEqual(t.el('acct_my_pf_fullName').value, 'Sam <b>Example</b>', 'the value is text');
        assert.strictEqual(t.a.findAll('#acct_card_myprofile b').length, 0, 'never markup');
        assert.strictEqual(t.el('acct_my_pf_country').value, 'OM');
        t.a.input('acct_my_pf_fullName', 'Sam Example');
        t.a.input('acct_my_pf_phone', '+968 0000 0000');
        t.click('acct_myprofile_save');
        await t.until(() => /Profile saved/.test(t.text('acct_myprofile_msg')), 'saved');
        const put = reqs(t, /\/account\/profile$/, 'PUT').pop();
        assert.deepStrictEqual(put.body, { fullName: 'Sam Example', company: 'Operator Energy Ltd', jobTitle: null, country: 'OM', phone: '+968 0000 0000' });
        assert.strictEqual(t.fake.user(E1).profile.phone, '+968 0000 0000');
        assert.strictEqual(t.acct().profile().fullName, 'Sam Example', 'the state follows the answer');
        t.click('acct_myprofile_clear');
        await t.until(() => /Profile cleared/.test(t.text('acct_myprofile_msg')), 'cleared');
        assert.deepStrictEqual(reqs(t, /\/account\/profile$/, 'PUT').pop().body, { fullName: null, company: null, jobTitle: null, country: null, phone: null });
        assert.strictEqual(t.el('acct_my_pf_fullName').value, '');
        assert.deepStrictEqual(T.J(t.fake.user(E1).profile), { fullName: null, company: null, jobTitle: null, country: null, phone: null });
        // a refusal from the server gets plain words
        t.fake.fault({ path: '/api/v1/account/profile', method: 'PUT', mode: 'bad_request' });
        t.click('acct_myprofile_save');
        await t.until(() => /Please check the profile fields/.test(t.text('acct_myprofile_msg')), 'plain error');
        assert.strictEqual(t.storage.getItem('wts_page_account'), null, 'the account route is never autosaved');
        assert(!/\+968/.test(lsDump(t)), 'the phone is not in localStorage');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN6 admin: richer users table, tops, user detail panel (GET /admin/users/:id), escaping, CSV columns, older server', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const U1 = '00000000-0000-4000-8000-000000000001'; const U2 = '00000000-0000-4000-8000-000000000002';
      const users = [
        { id: U1, email: 'sam@company.example', method: 'code', status: 'active', createdAt: '2026-11-01T08:00:00.000Z', lastSignInAt: '2026-11-09T09:00:00.000Z',
          signupCountry: 'AE', lastCountry: 'OM', lastCity: 'Muscat', projects: 3, usedBytes: 2400000,
          profile: { fullName: 'Sam Example', company: 'Operator Energy Ltd', jobTitle: 'Well Test Engineer', country: 'AE', phone: '=1+1' },
          work: { wells: ['Alpha-1', 'Alpha-2', 'Alpha-3', 'Beta-1'], clients: ['Operator Energy Ltd', 'Client Energy Ltd', 'Third Co'], operators: ['Operator Energy Ltd'],
            fields: ['Alpha Field'], countries: ['Oman'], lastProjectAt: '2026-11-08T10:00:00.000Z' } },
        { id: U2, email: 'b@company.example', method: 'google', status: 'deleting', createdAt: '2026-11-02T08:00:00.000Z', lastSignInAt: null,
          signupCountry: null, lastCountry: null, lastCity: null, projects: 0, usedBytes: 0,
          profile: { fullName: EVIL, company: '<b>Evil</b>', jobTitle: null, country: null, phone: null },
          work: { wells: [EVIL], clients: ['<script>x</script>'], operators: [], fields: [], countries: [], lastProjectAt: null } },
      ];
      const projects = [
        { id: '11111111-2222-4333-8444-555555555555', name: 'Alpha DST', updatedAt: '2026-11-08T10:00:00.000Z', bytes: 109443, summaryAt: '2026-11-08T10:00:00.000Z',
          summary: { name: 'Alpha DST', wells: ['Alpha-1', 'Alpha-2'], client: 'Operator Energy Ltd', operator: 'Operator Energy Ltd', company: 'Service Co Example',
            field: 'Alpha Field', rig: 'Rig A', country: 'Oman', jobRef: 'PO-2026-0042', modules: ['prism', 'wts'] } },
        { id: '11111111-2222-4333-8444-555555555556', name: 'Old project', updatedAt: '2026-10-01T10:00:00.000Z', bytes: 0, summary: null, summaryAt: null },
      ];
      const SUM = { generatedAt: '2026-11-09T10:00:00.000Z', totals: { users: 2, active7d: 1, active30d: 2, projects: 3, storageBytes: 2400000, invitesPending: 0 },
        byCountry: [{ country: 'OM', users: 1, active30d: 1 }], byMethod: [{ method: 'code', users: 1 }], signupsByDay: [{ day: '2026-11-01', n: 1 }],
        byCompany: [{ company: 'Operator Energy Ltd', users: 1 }, { company: '<b>Evil</b>', users: 1 }], topClients: [{ client: 'Operator Energy Ltd', projects: 2 }],
        topFields: [{ field: 'Alpha Field', projects: 2 }] };
      const admin = { older: false, detailCalls: [],
        answer(p, q, method) {
          const strip = (u) => { const c = Object.assign({}, u); delete c.profile; delete c.work; return c; };
          if (p === '/api/v1/admin/summary') return json(200, admin.older ? Object.assign({}, SUM, { byCompany: undefined, topClients: undefined, topFields: undefined }) : SUM);
          if (p === '/api/v1/admin/users') return json(200, { users: admin.older ? users.map(strip) : users, next: null });
          if (p === '/api/v1/admin/invites') return json(200, { invites: [] });
          const m = /^\/api\/v1\/admin\/users\/([^/]+)$/.exec(p);
          if (m && method === 'GET') {
            admin.detailCalls.push(m[1]);
            const u = users.find((x) => x.id === m[1]);
            return u ? json(200, { user: u, projects: u.id === U1 ? projects : [] }) : json(404, { error: 'not_found' });
          }
          return null;
        } };
      // the examples pass the contract (what the server sends)
      users.forEach((u) => assert(S.checkShape('AdminUser', u).ok, JSON.stringify(S.checkShape('AdminUser', u).errors)));
      assert(S.checkShape('AdminSummary', SUM).ok, JSON.stringify(S.checkShape('AdminSummary', SUM).errors));
      assert(S.checkShape('AdminUserDetail', { user: users[0], projects }).ok, JSON.stringify(S.checkShape('AdminUserDetail', { user: users[0], projects }).errors));
      const t = boot(ctx, { admin });
      try {
        await t.signIn(E1);
        await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
        t.w.WTS_nav('admin');
        await t.until(() => t.el('adm_users_table') && t.el('adm_top_companies_table'), 'admin page');
        const ut = t.text('adm_users_table');
        ['Name / e-mail', 'Company / job title', 'Wells', 'Client(s)', 'Field(s)'].forEach((h) => assert(ut.indexOf(h) !== -1, 'column ' + h));
        assert(/Sam Example/.test(ut) && /sam@company\.example/.test(ut) && /Well Test Engineer/.test(ut), ut);
        assert(/4\s*Alpha-1, Alpha-2, Alpha-3, …/.test(ut), 'wells: count + first names');
        assert(/Operator Energy Ltd, Client Energy Ltd\s*\+1 more/.test(ut), 'clients: first two and +1 more');
        assert(/Muscat/.test(ut) && /deleting/.test(ut));
        assert.strictEqual(t.a.findAll('#adm_root img').length + t.a.findAll('#adm_root script').length + t.a.findAll('#adm_users_table b').length, 0, 'no markup from server strings');
        assert(ut.indexOf(EVIL) !== -1 && ut.indexOf('<b>Evil</b>') !== -1 && ut.indexOf('<script>x</script>') !== -1, 'shown as text');
        // tops
        assert(/Operator Energy Ltd\s*1/.test(t.text('adm_top_companies_table')) && t.text('adm_top_companies_table').indexOf('<b>Evil</b>') !== -1);
        assert(/Operator Energy Ltd\s*2/.test(t.text('adm_top_clients_table')) && /Alpha Field\s*2/.test(t.text('adm_top_fields_table')));
        // a row click opens the detail panel
        const row = t.a.find('#adm_users_table tbody tr[data-id="' + U1 + '"] td');
        t.click(row);
        await t.until(() => t.el('adm_d_projects'), 'detail panel with projects');
        assert.deepStrictEqual(admin.detailCalls, [U1]);
        assert.strictEqual(t.text('adm_detail_t'), 'Sam Example');
        const prof = t.text('adm_d_profile');
        assert(/sam@company\.example/.test(prof) && /Operator Energy Ltd/.test(prof) && /Well Test Engineer/.test(prof) && /=1\+1/.test(prof), prof);
        const acc = t.text('adm_d_account');
        assert(/E-mail code/.test(acc) && /Muscat/.test(acc) && /2026-11-01 08:00/.test(acc) && /2026-11-09 09:00/.test(acc) && /2\.4 MB/.test(acc), acc);
        assert(/Signed up from/.test(acc) && /Last seen from/.test(acc));
        const pt = t.text('adm_d_projects');
        ['Alpha DST', 'Alpha-1, Alpha-2', 'Service Co Example', 'Rig A', 'Oman', 'PO-2026-0042', 'prism, wts', '2026-11-08 10:00', 'Old project', '(no summary yet)'].forEach((x) => assert(pt.indexOf(x) !== -1, 'project table has ' + x + ': ' + pt));
        assert(t.el('adm_detail').getAttribute('role') === 'dialog' && t.el('adm_detail').getAttribute('aria-modal') === 'true');
        assert(/rp-skip/.test(t.el('adm_detail_ov').className), 'never in a report');
        t.a.key('adm_detail_x', 'Escape');
        assert(!t.el('adm_detail_ov'), 'Escape closes');
        // the second user (escaped in the panel) through its Details button; × closes
        t.click(t.a.find('#adm_users_table button.adm-open[data-id="' + U2 + '"]'));
        await t.until(() => t.el('adm_d_noprojects'), 'second user');
        assert.strictEqual(t.text('adm_detail_t'), EVIL, 'the title is text');
        assert.strictEqual(t.a.findAll('#adm_detail_ov img').length + t.a.findAll('#adm_detail_ov b').length + t.a.findAll('#adm_detail_ov script').length, 0);
        t.click('adm_detail_x');
        assert(!t.el('adm_detail_ov'), '× closes');
        // CSV: the new columns, lists joined with "; ", formula guard on profile values
        const csv = t.w.WTS_accountAdmin._csv();
        const lines = csv.split('\r\n');
        assert(/,fullName,company,jobTitle,profileCountry,phone,wells,clients,operators,fields,workCountries,lastProjectAt$/.test(lines[0]), lines[0]);
        assert(lines[1].indexOf('Sam Example,Operator Energy Ltd,Well Test Engineer,AE,\'=1+1,Alpha-1; Alpha-2; Alpha-3; Beta-1,Operator Energy Ltd; Client Energy Ltd; Third Co,Operator Energy Ltd,Alpha Field,Oman,2026-11-08T10:00:00.000Z') !== -1, lines[1]);
        assert(lines[2].indexOf('"<img src=x onerror=""alert(1)"">"') !== -1, lines[2]);
        // an older server (no profile / work / tops): everything still renders with dashes
        admin.older = true;
        t.click('adm_refresh');
        await t.settle(40);
        await t.until(() => /No profiles with a company yet/.test(t.text('adm_top_companies')), 'tops empty');
        assert(/No project summaries yet/.test(t.text('adm_top_clients')));
        assert(/sam@company\.example/.test(t.text('adm_users_table')) && /—/.test(t.text('adm_users_table')));
        assert(/,,,,,,,,,,,$/.test(t.w.WTS_accountAdmin._csv().split('\r\n')[1]), 'empty new columns');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN7 summary text by the server rule (C1, NFKC, code points); a refused summary never blocks the save (retry without it)', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const path = require('path');
      const I = require(path.join(S.SERVER_DIR, 'core', 'insight'));
      const t = boot(ctx, {});
      try {
        const nasty = { client: 'Op\u0085Co', operator: 'Operator\u0096Energy', field: 'K\u0085X', rig: 'Rig ½ ' + 'y'.repeat(118), company: 'ﷺ'.repeat(10),
          country: '㎏'.repeat(60), ref: 'Well № 4 ' + 'x'.repeat(130), well: '㏏'.repeat(80) };
        const pl = { meta: {}, modules: { storage: { keys: { h2oil_client_info: JSON.stringify(nasty) } },
          wells: { v: 1, active: 'w1', wells: [{ id: 'w1', name: '㌀'.repeat(30) }, { id: 'w2', name: 'A' + '😀'.repeat(60), data: { keys: {} } }] } } };
        const sum = T.J(t.sync().projectSummary(pl, 'Name ' + 'ﷺ'.repeat(20)));
        const chk = S.checkShape('SummaryReq', sum);
        assert(chk.ok, JSON.stringify(chk.errors));
        assert.doesNotThrow(() => I.normSummary(sum), 'the server accepts it');
        assert.strictEqual(sum.client, 'Op Co'); assert.strictEqual(sum.operator, 'Operator Energy'); assert.strictEqual(sum.field, 'K X');
        Object.keys(sum).forEach((k) => { if (typeof sum[k] === 'string') assert(sum[k].length <= 120 && sum[k] === sum[k].normalize('NFKC'), k); });
        sum.wells.forEach((w) => { assert(w.length <= 80, w.length); assert(!/[\ud800-\udbff]$/.test(w), 'no half surrogate'); });
        // the commit path: a server that refuses the summary → the same commit once more without it; the save works
        await t.signIn(E1);
        await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
        t.storage.setItem('h2oil_client_info', JSON.stringify({ client: 'Operator Energy Ltd', well: 'Example-1' }));
        t.fake.fault({ path: /\/commit$/, method: 'POST', mode: 'bad_request', extra: { field: 'summary' } });
        const r = await t.sync().saveToCloud({});
        assert.strictEqual(r.rev, 1, JSON.stringify(r));
        const cs = reqs(t, /\/commit$/, 'POST');
        assert.strictEqual(cs.length, 2, 'one retry');
        assert(cs[0].body.summary && !('summary' in cs[1].body), 'the retry has no summary');
        assert.strictEqual(cs[0].body.pushId, cs[1].body.pushId, 'the same commit');
        // another bad_request (not about the summary) is not retried
        t.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 9, f: { hy_T: '41' } }));
        t.a.fire('document', 'wts:autosaved', {});
        t.fake.fault({ path: /\/commit$/, method: 'POST', mode: 'bad_request', extra: { field: 'core' } });
        const n0 = reqs(t, /\/commit$/, 'POST').length;
        await t.sync().saveToCloud({}).then(() => null, (e) => e);
        assert.strictEqual(reqs(t, /\/commit$/, 'POST').length - n0, 1, 'no retry');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN8 profile by the server rules: phone checked at Create and on the Account page, C1 / NFKC cleaned, profile words, /me countryHint', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        const i = t.acct()._i;
        const c = T.J(t.acct().cleanProfile({ fullName: 'Ana\u0085Example', company: 'ﷺ'.repeat(10), jobTitle: 'Ⅳ lead', phone: '+44 20 7946 0000' }));
        assert.strictEqual(c.fullName, 'Ana Example'); assert.strictEqual(c.jobTitle, 'IV lead');
        assert(c.company.length <= 120 && S.checkShape('ProfileReq', c).ok, JSON.stringify(S.checkShape('ProfileReq', c).errors));
        assert.strictEqual(i.profileProblem(c), null);
        ['+44 20 7946 0000 ext 12', '+1 555 CALL', '12'].forEach((ph) => assert.strictEqual(i.profileProblem({ phone: ph }).field, 'phone', ph));
        assert.strictEqual(i.profileProblem({ phone: '' }), null);
        // sign-up: a bad phone is stopped at Create with the rule named; nothing is sent; cleared → the account is made
        const r = await t.signIn('new.phone@company.example', { consent: false });
        assert(r.consentShown);
        t.a.input('acct_su_pf_phone', '+1 555 CALL');
        t.a.check('acct_consent_ok', true);
        const n0 = reqs(t, /\/auth\/code\/verify$/, 'POST').length;
        t.click('acct_create');
        await t.settle();
        assert(/digits, spaces and \+ \( \) \. \/ -/.test(t.text('acct_msg')), t.text('acct_msg'));
        assert.strictEqual(reqs(t, /\/auth\/code\/verify$/, 'POST').length, n0, 'no request');
        assert.strictEqual(t.acct().state().status, 'signedOut');
        t.a.input('acct_su_pf_phone', '');
        t.click('acct_create');
        await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
        // a profile refusal from the server (an older page's rule) gets profile words, not the address message
        assert(/Phone: use digits/.test(i.profileErrText({ code: 'bad_request', body: { field: 'profile.phone' } })));
        assert(i.isProfileErr({ code: 'bad_request', body: { field: 'profile' } }) && !i.isProfileErr({ code: 'bad_request', body: { field: 'email' } }));
        // the Account page: /me countryHint preselects the country of an empty profile; a bad phone is stopped with the rule
        await t.settle(20);
        t.fake.user('new.phone@company.example').countryHint = 'OM';
        await t.acct().refresh();
        t.w.WTS_nav('account');
        await t.until(() => t.el('acct_my_pf_country'), 'the card');
        assert.strictEqual(t.el('acct_my_pf_country').value, 'OM', 'countryHint from /me');
        t.a.input('acct_my_pf_phone', 'call me');
        const p0 = reqs(t, /\/account\/profile$/, 'PUT').length;
        t.click('acct_myprofile_save');
        await t.until(() => /digits, spaces and \+ \( \) \. \/ -/.test(t.text('acct_myprofile_msg')), 'the phone rule');
        assert.strictEqual(reqs(t, /\/account\/profile$/, 'PUT').length, p0, 'nothing sent');
        // an account on an older Privacy notice: the save is refused with a plain explanation
        t.fake.user('new.phone@company.example').staleConsent = true;
        t.a.input('acct_my_pf_phone', '+968 0000 0000');
        t.click('acct_myprofile_save');
        await t.until(() => /Privacy notice changed/.test(t.text('acct_myprofile_msg')), 'consent words');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'IN9 an existing account on older Terms / Privacy versions: "Updated Terms and Privacy notice" step, no profile fields (code and provider)', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const fake = T.F.createFakeServer({});
      const t0 = boot(ctx, { fake });
      try {
        await t0.signIn(E1);
        await t0.until(() => t0.acct().state().status === 'signedIn' && !t0.el('acct_dlg_ov'), 'the account exists');
      } finally { t0.dispose(); }
      const t = boot(ctx, { fake });
      try {
        t.fake.user(E1).staleConsent = true;
        const r = await t.signIn(E1, { consent: false });
        assert(r.consentShown, 'the consent step');
        const body = t.text('acct_dlg_body');
        assert(/changed since you last accepted/.test(t.text('acct_reconsent_note')), body);
        assert(!/creating a new account/.test(body) && !t.el('acct_su_pf'), 'no new-account wording or profile');
        assert(/Updated Terms and Privacy notice/.test(t.dialogText()));
        t.a.check('acct_consent_ok', true);
        t.click('acct_create');
        await t.until(() => t.acct().state().status === 'signedIn', 'signed in after accepting');
        const v = reqs(t, /\/auth\/code\/verify$/, 'POST').pop();
        assert(v.body.consent && !('profile' in v.body), JSON.stringify(v.body));
        assert.strictEqual(t.fake.user(E1).staleConsent, false);
      } finally { t.dispose(); }
      const t2 = boot(ctx, {});
      try {
        const I = t2.acct();
        const sent = [];
        I.finishProviderSignIn = (b) => { sent.push(JSON.parse(JSON.stringify(b))); return Promise.resolve(b.consent ? { next: 'oauth_state' } : { next: 'consent', existingAccount: true, terms: '1', privacy: '2' }); };
        assert(S.checkShape('FinishRes', { next: 'consent', existingAccount: true, terms: '1', privacy: '2' }).ok);
        t2.storage.setItem('wtsacct_hint', JSON.stringify({ oauth: { provider: 'google', route: 'home', at: Date.now(), purpose: 'signin' } }));
        I.oauthUI.openFinish();
        await t2.until(() => t2.el('acct_oauth_consent_ok'), 'the consent step');
        assert(/changed since you last accepted/.test(t2.text('acct_oauth_body')));
        assert(!t2.el('acct_oauth_su_pf_fullName') && !/creating a new account/.test(t2.text('acct_oauth_body')));
        t2.click('acct_oauth_create');
        assert(/Please tick/.test(t2.text('acct_oauth_body')), 'the tick is needed');
        t2.a.find('#acct_oauth_consent_ok').checked = true;
        t2.click('acct_oauth_create');
        await t2.settle();
        assert.deepStrictEqual(sent[sent.length - 1], { consent: { terms: '1', privacy: '2' } });
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'IN10 the admin user detail panel closes on navigation away from the admin route and when the account signs out', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const U1 = '00000000-0000-4000-8000-000000000001';
      const user = { id: U1, email: 'sam@company.example', method: 'code', status: 'active', createdAt: '2026-11-01T08:00:00.000Z', lastSignInAt: null,
        signupCountry: null, lastCountry: null, lastCity: null, projects: 0, usedBytes: 0, profile: { fullName: 'Sam', company: null, jobTitle: null, country: null, phone: null },
        work: { wells: [], clients: [], operators: [], fields: [], countries: [], lastProjectAt: null } };
      const SUM = { generatedAt: '2026-11-09T10:00:00.000Z', totals: { users: 1, active7d: 1, active30d: 1, projects: 0, storageBytes: 0, invitesPending: 0 },
        byCountry: [], byMethod: [], signupsByDay: [], byCompany: [], topClients: [], topFields: [] };
      const admin = { answer(p, q, method) {
        if (p === '/api/v1/admin/summary') return json(200, SUM);
        if (p === '/api/v1/admin/users') return json(200, { users: [user], next: null });
        if (p === '/api/v1/admin/invites') return json(200, { invites: [] });
        if (p === '/api/v1/admin/users/' + U1) return json(200, { user, projects: [] });
        return null;
      } };
      const t = boot(ctx, { admin });
      try {
        await t.signIn(E1);
        await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
        const openIt = async () => {
          t.w.WTS_nav('admin');
          await t.until(() => t.a.find('#adm_users_table button.adm-open[data-id="' + U1 + '"]'), 'admin page');
          t.click(t.a.find('#adm_users_table button.adm-open[data-id="' + U1 + '"]'));
          await t.until(() => t.el('adm_d_noprojects'), 'the panel');
          assert.strictEqual(t.text('adm_detail_t'), 'Sam');
        };
        await openIt();
        t.w.WTS_nav('home');
        assert(!t.el('adm_detail_ov'), 'closed on navigation');
        await openIt();
        t.fake.fault({ path: '/api/v1/me', mode: 'signed_out', times: 2 });
        await t.acct().refresh().catch(() => null);
        await t.settle(20);
        await t.until(() => t.acct().state().status !== 'signedIn', 'signed out');
        assert(!t.el('adm_detail_ov'), 'closed when signed out');
      } finally { t.dispose(); }
    },
  },
];
