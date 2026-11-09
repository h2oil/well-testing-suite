'use strict';
// server/test/live-bundle.test.js — the PRE-BUNDLED live functions (site/build-live.js, site/netlify-check.js --live
// --prebundled). An upload deploy installs no node_modules for the functions, so every netlify/functions/*.mjs must run on
// its own: here each one is copied ALONE into an isolated folder (no package reachable), prefixed with the declarations the
// platform injects into an .mjs file (`const require`, `__filename`, `__dirname`), loaded in a child process and called:
// the api answers GET /api/v1/health in same-site mode, a scheduled function runs its no-database path. Also: the build
// record (esbuild version, SHA-256, wrapper), the reproducible output, the check refusing a raw or tampered function, the
// check running without any installed package, and core/root.js paths inside a bundle.
// Needs the repository tree, esbuild (`npm ci` in server/) and the npm registry once (the dependency install is cached per
// lockfile in the system temporary folder).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..');
const NC = require('../site/netlify-check');
const NF = require('../site/netlify');
const PROD = 'welltest.h2oil.co.uk';
const DEPS_CACHE = path.join(os.tmpdir(), 'wts-live-deps-cache');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64 = () => crypto.randomBytes(32).toString('base64');

let esbuildOk = false;
try { esbuildOk = require(require.resolve('esbuild', { paths: [SERVER] })).version === NC.ESBUILD_VERSION; } catch (e) { esbuildOk = false; }
const skip = !fs.existsSync(path.join(SERVER, '..', 'prism-build', 'publish-site.js')) ? 'no repository tree'
  : (!esbuildOk ? 'esbuild ' + NC.ESBUILD_VERSION + ' not installed (npm ci in server/)' : false);

// what the platform prepends to every .mjs function file (its own require and file names)
const PLATFORM_HEADER = "import { createRequire } from 'module'; import { fileURLToPath as __pfu } from 'url'; import { dirname as __pdn } from 'path'; "
  + 'const require = createRequire(import.meta.url); const __filename = __pfu(import.meta.url); const __dirname = __pdn(__filename);\n';

const RUNNER = `
const [dir, files] = [process.argv[2], JSON.parse(process.argv[3])];
const { pathToFileURL } = await import('url');
const path = await import('path');
const out = {};
const ctx = { deploy: { context: 'production', published: true }, site: { url: 'https://${PROD}' } };
for (const f of files) {
  const r = out[f] = {};
  try {
    const m = await import(pathToFileURL(path.join(dir, 'netlify', 'functions', f)).href);
    r.type = typeof m.default; r.config = m.config;
    if (f === 'api.mjs') {
      const res = await m.default(new Request('https://${PROD}/api/v1/health', { headers: { host: '${PROD}' } }), ctx);
      r.status = res.status; r.body = await res.json();
    }
    if (f === 'ops-purge.mjs') {
      const res = await m.default(new Request('https://${PROD}/.netlify/functions/' + f.slice(0, -4)), ctx);
      r.status = res.status; r.body = await res.json();
    }
  } catch (e) { r.error = String(e && e.stack || e); }
}
process.stdout.write('\\n@@' + JSON.stringify(out) + '\\n');
`;

function isolatedRun(bundle, files, env) {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-iso-'));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-iso-run-'));
  try {
    fs.mkdirSync(path.join(iso, 'netlify', 'functions'), { recursive: true });
    files.forEach((f) => fs.writeFileSync(path.join(iso, 'netlify', 'functions', f), PLATFORM_HEADER + fs.readFileSync(path.join(bundle, 'netlify', 'functions', f), 'utf8')));
    fs.writeFileSync(path.join(runDir, 'run.mjs'), RUNNER);
    const r = cp.spawnSync(process.execPath, [path.join(runDir, 'run.mjs'), iso, JSON.stringify(files)],
      { cwd: iso, encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env), timeout: 60000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, 'runner output: ' + r.stdout + r.stderr);
    return { res: JSON.parse(line.slice(2)), stdout: r.stdout, stderr: r.stderr };
  } finally { fs.rmSync(iso, { recursive: true, force: true }); fs.rmSync(runDir, { recursive: true, force: true }); }
}

test.describe('pre-bundled live functions (site/build-live.js)', { skip }, () => {
  let dir = null; let out = null; let BL = null; let r = null;
  test.before(() => {
    BL = require('../site/build-live');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-b-'));
    out = path.join(dir, 'bundle');
    r = BL.build({ out, commit: 'c0ffee'.repeat(6) + 'abcd', depsCache: DEPS_CACHE });
  });
  test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('the bundle record: esbuild pinned, every function file hashed with the wrapper it was built from; no node_modules', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.devDependencies.esbuild, NC.ESBUILD_VERSION, 'server/package.json pins the checked esbuild version');
    const lock = JSON.parse(fs.readFileSync(path.join(SERVER, 'package-lock.json'), 'utf8'));
    assert.strictEqual(lock.packages['node_modules/esbuild'].version, NC.ESBUILD_VERSION);
    const B = r.info.bundle;
    assert.strictEqual(B.bundler, 'esbuild'); assert.strictEqual(B.version, NC.ESBUILD_VERSION); assert.strictEqual(B.layout, 'live');
    assert.deepStrictEqual(B.options, { bundle: true, platform: 'node', target: 'node22', format: 'esm' });
    assert.deepStrictEqual(B.define, { __dirname: '__wtsDirname', __filename: '__wtsFilename' });
    const LF = NF.functionsFor('live');
    assert.deepStrictEqual(Object.keys(B.functions).sort(), Object.keys(LF).sort());
    for (const name of Object.keys(LF)) {
      const buf = fs.readFileSync(path.join(out, 'netlify', 'functions', LF[name].file));
      assert.strictEqual(B.functions[name].sha256, sha(buf), name);
      assert.strictEqual(B.functions[name].wrapper, sha(NF.functionSource(name, 'live')), name);
      const text = buf.toString('utf8');
      assert.ok(text.startsWith(NC.BUNDLE_BANNER + '\n'), name + ': banner first');
      assert.strictEqual(text.trimEnd().split('\n').pop(), NC.configLine(NF.functionSource(name, 'live')), name + ': literal config last');
      assert.ok(!/^(?:const|let|var|function|class)\s+(?:require|__filename|__dirname)\b/m.test(text), name + ': no platform name declared');
      assert.ok(/\/\/ node_modules\/postgres\//.test(text) && /\/\/ node_modules\/@netlify\/blobs\//.test(text), name + ': packages bundled in');
      assert.ok(text.includes('c0ffee'.repeat(6) + 'abcd'), name + ': the commit is inlined (site/netlify.js BUILD_ID)');
      assert.ok(!text.includes(os.tmpdir()) && !text.includes(SERVER), name + ': no build-machine path');
    }
    const files = BL.checkDir(out).files;
    assert.ok(!files.some((f) => /(^|\/)node_modules(\/|$)/.test(f)) && !fs.existsSync(path.join(out, 'node_modules')), 'no node_modules in the bundle');
    const lp = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    assert.ok(lp.dependencies['@netlify/database'] && !lp.devDependencies, 'package.json kept (the database integration keys off @netlify/database)');
    const ll = JSON.parse(fs.readFileSync(path.join(out, 'package-lock.json'), 'utf8'));
    assert.ok(!ll.packages[''].devDependencies && !ll.packages['node_modules/esbuild'], 'the bundle lockfile has no development packages');
    assert.ok(!/external_node_modules|included_files/.test(NC.LIVE_TOML.replace(/^\s*#.*$/mg, '')));
    assert.match(NC.LIVE_TOML, /command = "node site\/netlify-check\.js --live --prebundled"/);
    assert.deepStrictEqual(BL.checkDir(out).problems, []);
    console.log('# live bundle: ' + files.length + ' files, functions ' + Object.keys(B.functions).map((k) => k + ' ' + B.functions[k].bytes).join(', '));
  });

  test('each function loads ALONE with the platform header (no package reachable): health 200, the scheduled no-database path', () => {
    const files = fs.readdirSync(path.join(out, 'netlify', 'functions')).sort();
    const env = { WTS_ENV: 'production', WTS_SITE_MODE: 'same', WTS_MASTER_KEYS: '1:' + b64(), WTS_MASTER_KID: '1', WTS_INDEX_PEPPER: b64(),
      WTS_CODE_PEPPERS: '1:' + b64(), WTS_SESSION_PEPPER: b64(), WTS_OPS_HMAC: b64() };
    const { res, stdout, stderr } = isolatedRun(out, files, env);
    const LF = NF.functionsFor('live');
    for (const f of files) {
      const name = f.slice(0, -4);
      assert.ok(!res[f].error, f + ': ' + res[f].error);
      assert.strictEqual(res[f].type, 'function', f + ': default export');
      assert.deepStrictEqual(res[f].config, LF[name].config, f + ': config');
    }
    assert.strictEqual(res['api.mjs'].status, 200, JSON.stringify(res['api.mjs']) + stdout + stderr);
    assert.strictEqual(res['api.mjs'].body.ok, true);
    assert.strictEqual(res['api.mjs'].body.db, false);
    assert.deepStrictEqual(res['ops-purge.mjs'].body, { ok: false, skipped: 'no database' }, stdout + stderr);
  });

  test('the platform build command passes on a copy without node_modules and loads nothing outside the bundle', () => {
    const copy = path.join(dir, 'copy');
    fs.cpSync(out, copy, { recursive: true });
    const p = cp.spawnSync(process.execPath, ['site/netlify-check.js', '--live', '--prebundled'], { cwd: copy, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.strictEqual(p.status, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /functions pre-bundled \(esbuild 0\.24\.2\)/);
    // loadedOutside names what a process loaded outside a root (here: everything outside site/, e.g. core/config.js)
    assert.ok(NC.loadedOutside(path.join(SERVER, 'site')).some((f) => f === path.join(SERVER, 'core', 'config.js')));
  });

  test('the check refuses a raw wrapper, a tampered bundle, a changed record and a platform-name declaration', () => {
    const api = path.join(out, 'netlify', 'functions', 'api.mjs');
    const keep = fs.readFileSync(api);
    const info = path.join(out, 'build-info.json'); const keepInfo = fs.readFileSync(info);
    const probs = () => NC.checkLive(out, { uploaded: true }).problems;
    try {
      fs.writeFileSync(api, NF.functionSource('api', 'live'));
      assert.ok(probs().some((p) => /api: does not start with the bundle banner/.test(p)));
      assert.ok(probs().some((p) => /api: differs from the bundle recorded/.test(p)));
      assert.ok(probs().some((p) => /api: imports \.\.\/\.\.\/site\/netlify\.js/.test(p)), probs().join('\n'));
      fs.writeFileSync(api, Buffer.concat([keep, Buffer.from('// x\n')]));
      assert.ok(probs().some((p) => /api: differs from the bundle recorded/.test(p)));
      assert.ok(probs().some((p) => /api: the last line must be the literal config/.test(p)));
      fs.writeFileSync(api, keep.toString('utf8').replace(NC.BUNDLE_BANNER + '\n', NC.BUNDLE_BANNER + '\nconst __filename = 1;\n'));
      assert.ok(probs().some((p) => /api: declares __filename at the top level/.test(p)));
      fs.writeFileSync(api, keep);
      const i = JSON.parse(keepInfo); i.bundle.functions.api.wrapper = sha('other');
      fs.writeFileSync(info, JSON.stringify(i));
      assert.ok(probs().some((p) => /api: built from a wrapper that differs/.test(p)));
      i.bundle.version = '0.0.1'; fs.writeFileSync(info, JSON.stringify(i));
      assert.ok(probs().some((p) => /not recorded as pre-bundled with esbuild 0\.24\.2/.test(p)));
      fs.writeFileSync(info, keepInfo);
      assert.deepStrictEqual(probs(), []);
    } finally { fs.writeFileSync(api, keep); fs.writeFileSync(info, keepInfo); }
  });

  test('reproducible: a second build of the same tree gives the same function files', () => {
    const again = BL.build({ out: path.join(dir, 'again'), commit: 'c0ffee'.repeat(6) + 'abcd', depsCache: DEPS_CACHE });
    for (const k of Object.keys(r.info.bundle.functions)) assert.strictEqual(again.info.bundle.functions[k].sha256, r.info.bundle.functions[k].sha256, k);
  });

  test('core/root.js inside a bundle: __dirname = <root>/site gives the bundle root; migrate / backup / objects-loader paths', () => {
    const esbuild = require(require.resolve('esbuild', { paths: [SERVER] }));
    const t = path.join(dir, 'roots');
    fs.mkdirSync(path.join(t, 'netlify', 'functions'), { recursive: true });
    ['core', 'db', 'site'].forEach((d) => fs.mkdirSync(path.join(t, d), { recursive: true }));
    fs.copyFileSync(path.join(SERVER, 'core', 'root.js'), path.join(t, 'core', 'root.js'));
    const entry = "import root from '../../core/root.js'; export default { root: root.SERVER_ROOT, mig: root.serverPath('db', 'migrations') };\n";
    const b = esbuild.buildSync(Object.assign({}, NC.BUNDLE_OPTIONS, { stdin: { contents: entry, resolveDir: path.join(t, 'netlify', 'functions'), loader: 'js' },
      absWorkingDir: t, write: false, banner: { js: NC.BUNDLE_BANNER }, define: Object.assign({}, NC.BUNDLE_DEFINE), logLevel: 'silent' }));
    const f = path.join(t, 'netlify', 'functions', 'roots.mjs');
    fs.writeFileSync(f, PLATFORM_HEADER + Buffer.from(b.outputFiles[0].contents).toString('utf8'));
    const p = cp.spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import(process.argv[1]); console.log(JSON.stringify(m.default));", require('url').pathToFileURL(f).href], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const v = JSON.parse(p.stdout);
    assert.strictEqual(v.root, t); assert.strictEqual(v.mig, path.join(t, 'db', 'migrations'));
    // in the repository the same helpers name server/
    const R = require('../core/root');
    assert.strictEqual(R.SERVER_ROOT, SERVER);
    assert.strictEqual(require('../db/migrate').DIR, path.join(SERVER, 'db', 'migrations'));
    assert.ok(require('../site/backup').rolesSql().startsWith('DO $roles$'));
    for (const f2 of ['db/migrate.js', 'site/backup.js', 'site/objects-loader.js']) {
      assert.ok(!/path\.join\(__dirname/.test(fs.readFileSync(path.join(SERVER, f2), 'utf8').replace(/^\s*\/\/.*$/mg, '')), f2 + ': paths from core/root.js, not __dirname');
    }
    assert.match(fs.readFileSync(path.join(SERVER, 'functions', 'index.js'), 'utf8'), /require\('\.\/' \+ f \+ '\.js'\)/);
  });
});
