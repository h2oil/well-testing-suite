// Accounts — WP-OPS static-site checks (docs/ACCOUNTS-PLAN.md §13.2, §8.2, §13.8, D19, T11). No app is loaded (opts:false).
//
//   OP1  the publish allow-list of the real tree: the page, sw.js and help/** only; the CI check passes; a build writes the
//        files, `_headers` (security headers; CSP Report-Only only with --api, reporting to /api/v1/csp-report, its external
//        hosts read from the page) and a manifest whose hashes match the copies
//   OP2  the check refuses server/, docs/, tools/, prism-build/, ios-app/, *.sql, .env*, key files, a path outside the root, a
//        PEM private key, a private JWK and the name of every secret variable (config.js SECRET_ENV + ops-env.js)
//   OP3  cspHosts reads <script src> and pinned library URLs only (not links in text); cspPolicy keeps the §8.2 directives
//   OP4  acct-hash: JS and HTML blocks in document order, CRLF = LF, per-block digests, unbalanced markers refused, no block =
//        null; the strip regex of ios-app/scripts/sync-from-main.js removes exactly the blocks acct-hash hashes
//   OP5  no root-level host configuration or functions folder: the repository root holds only the known entries, and
//        neither the static allow-list nor ios-app/www can carry server/
//   OP6  the server release workflow runs only on server-v* tags, is inert without the owner's secrets (every deploy /
//        migration step checks its secret first and skips with a notice), and the iOS sync workflow does not watch server/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WP = 'OPS';
const ROOT = path.join(__dirname, '..', '..');
const P = require('../publish-site');
const A = require('../acct-hash');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const entry = (rel, text) => ({ rel, read: () => Buffer.from(text == null ? 'ok' : text) });

module.exports = [
  {
    name: 'OP1 publish allow-list of the real tree, build output and headers', wp: WP, opts: false,
    run(app, assert) {
      const set = P.collect(ROOT);
      const rels = set.map((e) => e.rel);
      assert(rels.includes('well-testing-app.html') && rels.includes('sw.js'), 'page and worker published');
      assert(rels.some((r) => r.startsWith('help/')), 'help published');
      rels.forEach((r) => assert(/^(well-testing-app\.html|sw\.js|index\.html|favicon\.(ico|svg)|robots\.txt|(manifest|site)\.webmanifest|apple-touch-icon\.png|privacy\.html|terms\.html|help\/|icons\/|legal\/)/.test(r), 'outside the allow-list: ' + r));
      const chk = P.checkSet(set);
      assert(chk.ok, 'CI check passes on the real tree: ' + JSON.stringify(chk.errors.slice(0, 3)));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-pub-'));
      try {
        const out = path.join(tmp, 'site');
        const r = P.build({ out });
        assert(r.ok, 'build ok');
        const man = JSON.parse(fs.readFileSync(path.join(out, 'publish-manifest.json'), 'utf8'));
        assert.strictEqual(man.files.length, set.length, 'manifest lists every file');
        man.files.slice(0, 40).forEach((f) => assert.strictEqual(sha(fs.readFileSync(path.join(out, f.path))), f.sha256, 'hash of ' + f.path));
        const h = fs.readFileSync(path.join(out, '_headers'), 'utf8');
        ['X-Content-Type-Options: nosniff', 'Referrer-Policy: same-origin', 'Strict-Transport-Security: max-age=31536000',
          'Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self)'].forEach((x) => assert(h.includes(x), 'header ' + x));
        assert(/\/sw\.js\n  Cache-Control: no-cache/.test(h) && /\/well-testing-app\.html\n  Cache-Control: no-cache/.test(h), 'no-cache on page and worker');
        assert(!/Content-Security-Policy/.test(h), 'no CSP without --api (the live site behaves as v3.4)');
        assert(!fs.existsSync(path.join(out, 'server')) && !fs.existsSync(path.join(out, 'prism-build')), 'no server / build folders');
        const r2 = P.build({ out, api: true, extraConnect: 'collect.analytics.example', extraImg: 'img.analytics.example' });
        const h2 = fs.readFileSync(path.join(out, '_headers'), 'utf8');
        const line = h2.split('\n').find((l) => l.includes('Content-Security-Policy-Report-Only:'));
        assert(line, 'CSP Report-Only with --api');
        assert(!/^\s*Content-Security-Policy:/m.test(h2), 'never enforced here (enforced at the end of Phase 1)');
        assert(line.includes('report-uri /api/v1/csp-report') && line.includes('report-to csp') && h2.includes('Reporting-Endpoints: csp="/api/v1/csp-report"'), 'reports to the API');
        r2.hosts.forEach((x) => assert(line.includes('https://' + x), 'page host in CSP: ' + x));
        assert(line.includes('https://collect.analytics.example') && line.includes('img-src \'self\' data: blob: https://img.analytics.example'), 'owner extras');
        assert(line.includes("frame-ancestors 'none'") && line.includes("object-src 'none'") && line.includes('ws://127.0.0.1:*'), '§8.2 directives');
        let threw = false; try { P.build({ out: ROOT }); } catch (e) { threw = /must not be the source tree/.test(e.message); }
        assert(threw, 'refuses to write over the source tree');
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
  },
  {
    name: 'OP2 the publish check refuses forbidden paths, key material and secret names', wp: WP, opts: false,
    run(app, assert) {
      const base = [entry('well-testing-app.html', '<html></html>'), entry('sw.js', '')];
      assert(P.checkSet(base).ok, 'clean set passes');
      const bad = (e, why) => { const r = P.checkSet(base.concat([e])); assert(!r.ok, 'refused: ' + e.rel + ' (' + why + ')'); return r; };
      ['server/core/app.js', 'docs/ACCOUNTS-PLAN.md', 'tools/modbus-bridge/bridge.js', 'prism-build/66-account.js', 'ios-app/www/index.html',
        'server', 'help/x.sql', '.env', 'help/.env.local', 'help/k.pem', 'help/a.key', 'help/x.jwk', 'help/c.p12', '../x.html',
        '/etc/passwd', 'help/package.json'].forEach((p) => bad(entry(p), 'path'));
      bad(entry('help/a.html', '-----BEGIN ' + 'PRIVATE KEY-----\nMII'), 'pem');
      bad(entry('help/b.json', '{"kty":"RSA","n":"abc","e":"AQAB","d":"' + 'A'.repeat(40) + '"}'), 'jwk');
      assert(P.checkSet(base.concat([entry('help/pub.json', '{"kty":"RSA","n":"abc","e":"AQAB"}')])).ok, 'a public JWK passes');
      const names = P.secretNames();
      ['WTS_MASTER_KEYS', 'WTS_INDEX_PEPPER', 'WTS_CODE_PEPPERS', 'WTS_SESSION_PEPPER', 'WTS_PROXY_SIG', 'WTS_OPS_HMAC',
        'WTS_MAIL_CREDENTIAL', 'WTS_OUTBOX_KEY', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_LINKEDIN_CLIENT_SECRET', 'WTS_BACKUP_KEY'].forEach((n) => {
        assert(names.includes(n), 'known secret name ' + n);
        const r = bad(entry('well-testing-app.html', '<script>var x = "' + n + '";</script>'), n);
        assert(r.errors.some((e) => e.why.includes(n)), 'names ' + n);
      });
      require('../../server/core/config').SECRET_ENV.forEach((n) => assert(names.includes(n), 'config SECRET_ENV ' + n));
      require('../../server/site/ops-env').OPS_SECRET_ENV.forEach((n) => assert(names.includes(n), 'ops secret ' + n));
      assert(P.checkSet(base.concat([entry('help/a.html', 'OAUTH_GOOGLE_CLIENT_ID is public configuration')])).ok, 'a client id name is not a secret');
      // a publish dir on disk is checked the same way
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-pub2-'));
      try {
        fs.writeFileSync(path.join(tmp, 'well-testing-app.html'), 'x');
        fs.mkdirSync(path.join(tmp, 'server')); fs.writeFileSync(path.join(tmp, 'server', 'app.js'), 'x');
        assert(!P.checkSet(P.readDir(tmp)).ok, 'a publish dir that contains server/ fails');
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
  },
  {
    name: 'OP3 CSP hosts come only from code loads of the page', wp: WP, opts: false,
    run(app, assert) {
      const html = '<script async src="https://tag.analytics.example/js?id=1"></script><a href="https://docs.example/x">doc</a>' +
        "<script>load('https://cdn.example/npm/lib@1.0.0/dist/lib.min.js'); var b='https://mirror.example/'; var w='https://wasm.example/x/y.wasm';" +
        "var svg='http://www.w3.org/2000/svg'; var p='https://page.example/about.html';</script>";
      const hosts = P.cspHosts(html, "var L=['https://sw-cdn.example/npm/three@1/three.module.min.js'];");
      assert.deepStrictEqual(hosts, ['cdn.example', 'mirror.example', 'sw-cdn.example', 'tag.analytics.example', 'wasm.example'], JSON.stringify(hosts));
      const pol = P.cspPolicy({ hosts: ['cdn.example'], extraConnect: 'bad host!, ok.example', reportUri: '/api/v1/csp-report' });
      assert(pol.startsWith("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.example"), pol);
      assert(pol.includes('connect-src \'self\' https://cdn.example https://ok.example ws://127.0.0.1:*') && !pol.includes('bad'), 'invalid extras dropped');
      assert(pol.endsWith("frame-ancestors 'none'; report-uri /api/v1/csp-report; report-to csp"), pol);
      const real = P.cspHosts(fs.readFileSync(path.join(ROOT, 'well-testing-app.html'), 'utf8'), fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
      assert(real.length >= 1 && real.every((h) => /^[a-z0-9.-]+$/.test(h)), 'real page hosts: ' + real.join(' '));
    },
  },
  {
    name: 'OP4 acct-hash digests the account block like the iOS strip sees it', wp: WP, opts: false,
    run(app, assert) {
      const js = '// ── ACCT:START — web only ──\n(function(){ var a = 1; })();\n// ── ACCT:END ──';
      const html = '<!-- ACCT:START --><span id="wts_account_host"></span><!-- ACCT:END -->';
      const page = 'host();\n' + js + '\nmore();\n<div>' + html + '</div>\n';
      const d = A.digest(page);
      assert.strictEqual(d.blocks, 2); assert.deepStrictEqual(d.errors, []);
      assert.deepStrictEqual(d.perBlock.map((b) => b.kind), ['js', 'html']);
      const expect = 'sha384-' + crypto.createHash('sha384').update(js + '\n' + html).digest('base64');
      assert.strictEqual(d.sha384, expect, 'digest of the blocks joined by LF');
      assert.strictEqual(A.digest(page.replace(/\n/g, '\r\n')).sha384, expect, 'CRLF = LF');
      assert.notStrictEqual(A.digest(page.replace('a = 1', 'a = 2')).sha384, expect, 'a one-character change changes the digest');
      assert.strictEqual(A.digest('host();').sha384, null, 'no block → null');
      assert(A.digest(page + '\n// ── ACCT:START x\n').errors.length, 'unclosed JS block refused');
      assert(A.digest(page + '<!-- ACCT:START -->').errors.length, 'unclosed HTML block refused');
      ['66-account.js', '67-cloud-sync.js', '68-account-page.js'].forEach((f) => {
        const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const r = A.digest(t);
        assert.strictEqual(r.blocks, 1, f + ' has one block'); assert(/^sha384-[A-Za-z0-9+/]{64}$/.test(r.sha384), f);
      });
      // the same regexes as ios-app/scripts/sync-from-main.js steps 0c / 0d
      const sync = fs.readFileSync(path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js'), 'utf8');
      assert(sync.includes('ACCT:START') && sync.includes('ACCT:END'), 'sync strips ACCT blocks');
      const stripped = page.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '').replace(/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g, '');
      assert.strictEqual(A.digest(stripped).blocks, 0, 'after the strip nothing is left to hash');
      const real = A.digest(fs.readFileSync(path.join(ROOT, 'well-testing-app.html'), 'utf8'));
      assert.deepStrictEqual(real.errors, [], 'the built page has balanced markers');
    },
  },
  {
    name: 'OP5 no root-level host configuration; server/ never reaches a published set', wp: WP, opts: false,
    run(app, assert) {
      const KNOWN = ['.git', '.gitattributes', '.github', '.gitignore', '.claude', 'CLAUDE.md', 'LICENSE', 'PRISM-PLAN.md', 'PROJECT-NOTES.md',
        'README.md', 'docs', 'help', 'ios-app', 'prism-build', 'server', 'sw.js', 'tools', 'well-testing-app.html', 'privacy.html', 'terms.html', 'wiki', 'dist-site', 'node_modules'];
      fs.readdirSync(ROOT).forEach((n) => assert(KNOWN.includes(n), 'unexpected repository root entry (host configuration or functions folder?): ' + n));
      assert(!fs.existsSync(path.join(ROOT, 'functions')) && !fs.existsSync(path.join(ROOT, '_headers')) && !fs.existsSync(path.join(ROOT, '_redirects')), 'no root functions / headers / redirects');
      const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
      ['.env', '.env.*', '/dist-site/', 'server/dist/', 'server/node_modules/'].forEach((x) => assert(gi.split(/\r?\n/).includes(x), '.gitignore has ' + x));
      const sync = fs.readFileSync(path.join(ROOT, 'ios-app', 'scripts', 'sync-from-main.js'), 'utf8');
      assert(!/['"`]server\//.test(sync), 'sync-from-main never copies server/');
      assert(!fs.existsSync(path.join(ROOT, 'ios-app', 'www', 'server')), 'no server/ in ios-app/www');
      const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'site', 'site.json'), 'utf8'));
      assert.strictEqual(site.static, null, 'the functions-only site publishes no static content');
    },
  },
  {
    name: 'OP6 release workflow: server-v* tags only, inert without secrets; iOS sync ignores server/', wp: WP, opts: false,
    run(app, assert) {
      const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'server-release.yml'), 'utf8');
      const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\njobs:'));
      assert(/tags:\s*\n\s*-\s*'server-v\*'/.test(on), 'triggers on server-v* tags');
      assert(!/branches|pull_request|schedule|workflow_dispatch|workflow_run|repository_dispatch/.test(on), 'no other trigger: ' + on);
      assert(/permissions:\s*\n\s*contents:\s*read/.test(wf), 'read-only token');
      // every use of a deploy / migration secret sits in a step that checks it first
      const steps = wf.split(/\n\s*- name: /);
      steps.filter((s) => /secrets\.(WTS_DEPLOY_TOKEN|WTS_MIGRATE_DB_URL)/.test(s)).forEach((s) => {
        assert(/not configured/.test(s) && /exit 0/.test(s), 'step skips without its secret: ' + s.split('\n')[0]);
      });
      assert(/environment:\s*server-migrations/.test(wf) && /environment:\s*server-production/.test(wf), 'protected environments');
      // a skipped migration never lets new code go live when the migrations changed since the previous server tag
      const deploy = steps.find((s) => /secrets\.WTS_DEPLOY_TOKEN/.test(s)) || '';
      assert(/MIGRATE_RESULT/.test(deploy) && /MIGRATIONS_CHANGED/.test(deploy) && /exit 1/.test(deploy), 'deploy refuses an unmigrated schema');
      assert(/result=skipped/.test(wf) && /result=applied/.test(wf) && /migrations_changed=/.test(wf), 'migrate and verify publish their outputs');
      assert(!/WTS_MASTER_KEYS|WTS_INDEX_PEPPER|WTS_SESSION_PEPPER|CLIENT_SECRET/.test(wf), 'runtime secrets never pass through the workflow');
      const ios = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ios-sync.yml'), 'utf8');
      assert(!/server\//.test(ios), 'ios-sync does not watch server/');
    },
  },
];
