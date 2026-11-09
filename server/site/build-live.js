#!/usr/bin/env node
'use strict';
// server/site/build-live.js — assembles the ONE folder the lead uploads to the live site welltest.h2oil.co.uk: the static app
// and the web accounts API in same-site mode (WTS_SITE_MODE=same; server/RUNBOOK.md "Live site (same-site) setup").
//
//   node server/site/build-live.js --out <dir> [--inline-jobs] [--csp-report]
//                                                     writes the bundle (the folder is replaced; it must not be inside the
//                                                     repository tree, except server/dist-live/, which git ignores).
//                                                     --csp-report adds the Report-Only CSP reporting to /api/v1/csp-report
//                                                     (publish-site --api). OFF by default on the live site: every report is
//                                                     a function call and a database write on the Free plan's quotas, and
//                                                     the analytics tag (loaded after consent) would be reported on every
//                                                     visit; the security headers are in _headers either way.
//                                                     Default layout 'live': six functions — ops-daily and weekly-export
//                                                     start background functions (15 min each; background functions are
//                                                     offered on every credit-based plan, the Free plan included; they need
//                                                     WTS_OPS_HMAC). --inline-jobs: the opt-in fallback 'live-inline', four
//                                                     functions, the daily job and the weekly export inside their scheduled
//                                                     function (30 s platform limit; a 25 s budget stops them with an alert).
//                                                     --background-jobs is accepted and means the default.
//   node server/site/build-live.js --check --dir <dir>  lists the bundle and fails (exit 1) on anything outside the allow-list
//                                                     or any secret-looking file (site/netlify-check.js checkLive, uploaded)
//   require('./build-live') → { build({out, root?, commit?, depsCache?}) → {out, files, info}, checkDir(dir) → {problems, files} }
//                                                     depsCache: a folder that keeps the dependency install per lockfile hash
//                                                     (tests); default = a fresh temporary install, removed after the build
// Needs `npm ci` in server/ (esbuild, pinned devDependency) and the npm registry (the bundle's runtime dependencies).
//
// The bundle (its root is the site's base: netlify.toml there, no base directory in the site settings):
//   public/                       the static allow-list of prism-build/publish-site.js: index.html (a copy of the page),
//                                 well-testing-app.html, sw.js, help/**, privacy.html, terms.html, any icons / manifests
//                                 that exist, _headers (the security headers; with --csp-report also the Report-Only CSP)
//                                 and publish-manifest.json (path, bytes, sha256 of every file)
//   netlify.toml                  site/netlify-check.js LIVE_TOML: publish public, functions netlify/functions, Node 22, the
//                                 build command = the bundle check (no secret needed; a broken bundle fails the deploy)
//   package.json + package-lock.json   the server's pinned runtime dependencies (the lockfile without the development
//                                 packages; @netlify/database → the platform provisions the database on the first production
//                                 deploy and applies the migrations before publishing). Nothing is installed from them on an
//                                 upload deploy: the functions carry their packages.
//   netlify/functions/*.mjs       api on /api/v1/* only; ops-purge, ops-daily, weekly-export scheduled and the two
//                                 background functions (not with --inline-jobs): each the wrapper of site/netlify.js
//                                 functionSource('live' | 'live-inline') PRE-BUNDLED with esbuild (bundleFunctions below:
//                                 banner first, packages inside, the literal config as the last line)
//   netlify/database/migrations/  the platform migrations (copied byte for byte; never edited after a release)
//   core/, functions/, db/migrate.js, site/<runtime files>, ci/secret-scan.js   the code the check loads (and the bundles' source)
//   build-info.json               the commit, the bundle record (esbuild version, options, lockfile hash, per function the
//                                 SHA-256 and size of the file and the SHA-256 of its wrapper) and the SHA-256 of every file
//                                 (not published: outside public/)
// Nothing else: no docs/, prism-build/, tests, ops scripts, .env, keys or node_modules. The build refuses (and deletes its
// output) when publish-site's check or the live bundle check fails.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');

const SERVER = path.join(__dirname, '..');
const REPO = path.join(SERVER, '..');
const NC = require('./netlify-check');
const NF = require('./netlify');

function copyFile(src, dst, list, rel) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  list.push(rel);
}
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /^[a-z0-9-]+\.js$/.test(d.name)).map((d) => d.name).sort();
}
function livePackage() {
  const src = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  return {
    name: src.name, version: src.version, private: true,
    description: 'Well Testing Suite live site: the static app and the web accounts API (same-site mode). GENERATED by server/site/build-live.js.',
    license: src.license, engines: src.engines, dependencies: src.dependencies,
  };
}
function gitCommit() {
  try { return cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; }
}
function safeOut(out, root) {
  const o = path.resolve(out);
  const r = path.resolve(root || REPO);
  if (o === r || r.startsWith(o + path.sep)) throw new Error('build-live: --out must not be the repository or a parent of it');
  const inside = o.startsWith(r + path.sep);
  if (inside && !o.startsWith(path.join(r, 'server', 'dist-live'))) throw new Error('build-live: --out inside the repository must be server/dist-live (git-ignored)');
  return o;
}

// ── pre-bundling the functions ───────────────────────────────────────────────────────────────────────────────────
// An upload deploy installs no node_modules for the functions (and drops any uploaded with the bundle), so each
// netlify/functions/<name>.mjs is made self-contained here: the bundle's exact dependencies are installed into a temporary
// folder (npm ci --omit=dev --ignore-scripts from the bundle's own package.json + lockfile), each generated wrapper is bundled
// by esbuild (pinned devDependency, JS API; options site/netlify-check.js BUNDLE_OPTIONS / BANNER / DEFINE) and the
// temporary folder is removed. The bundle never holds node_modules.
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function loadEsbuild() {
  let esbuild;
  try { esbuild = require(require.resolve('esbuild', { paths: [SERVER] })); } catch (e) {
    throw new Error('build-live: esbuild is not installed — run `npm ci` in server/ (devDependency esbuild ' + NC.ESBUILD_VERSION + ')');
  }
  if (esbuild.version !== NC.ESBUILD_VERSION) throw new Error('build-live: esbuild ' + esbuild.version + ' installed, ' + NC.ESBUILD_VERSION + ' required (run `npm ci` in server/)');
  return esbuild;
}
// the lockfile of the bundle: server/package-lock.json without the development packages (in step with livePackage())
function liveLock() {
  const lock = JSON.parse(fs.readFileSync(path.join(SERVER, 'package-lock.json'), 'utf8'));
  const pkgs = {};
  Object.keys(lock.packages || {}).forEach((k) => {
    const p = lock.packages[k];
    if (k === '') { const r = Object.assign({}, p); delete r.devDependencies; pkgs[k] = r; } else if (!p.dev) pkgs[k] = p;
  });
  return Object.assign({}, lock, { packages: pkgs });
}
function npmCi(dir) {
  const win = process.platform === 'win32';
  const r = cp.spawnSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: dir, encoding: 'utf8', shell: win, env: Object.assign({}, process.env, { NODE_ENV: 'production' }) });
  if (r.status !== 0) throw new Error('build-live: npm ci of the bundle dependencies failed: ' + String(r.stderr || r.error || '').trim().split('\n').slice(-3).join(' '));
}
// → {modules: <node_modules folder>, lock: sha256, cleanup()} — installed fresh, or reused from depsCache (a folder per lockfile
// hash; tests and repeated builds) when that install completed
function installDeps(out, depsCache) {
  const lockBuf = fs.readFileSync(path.join(out, 'package-lock.json'));
  const lock = sha256(lockBuf);
  const stage = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(out, 'package.json'), path.join(dir, 'package.json'));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lockBuf);
    npmCi(dir);
  };
  if (depsCache) {
    const dir = path.join(path.resolve(depsCache), lock.slice(0, 16));
    if (!fs.existsSync(path.join(dir, '.wts-complete'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      stage(dir);
      fs.writeFileSync(path.join(dir, '.wts-complete'), lock + '\n');
    }
    return { modules: path.join(dir, 'node_modules'), lock, cleanup() {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-deps-'));
  try { stage(dir); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  return { modules: path.join(dir, 'node_modules'), lock, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
// bundles every function of the layout in place → the bundle record of build-info.json
function bundleFunctions(out, layout, o) {
  const esbuild = loadEsbuild();
  const LF = NF.functionsFor(layout);
  const deps = installDeps(out, o.depsCache);
  // the packages are linked in as <bundle>/node_modules while esbuild runs (preserveSymlinks: the paths esbuild writes into
  // its module comments stay "node_modules/…", the same on every build), then unlinked
  const link = path.join(out, 'node_modules');
  const functions = {};
  try {
    fs.symlinkSync(deps.modules, link, process.platform === 'win32' ? 'junction' : 'dir');
    Object.keys(LF).forEach((name) => {
      const rel = 'netlify/functions/' + LF[name].file;
      const src = NF.functionSource(name, layout);
      const r = esbuild.buildSync(Object.assign({}, NC.BUNDLE_OPTIONS, {
        stdin: { contents: NC.bundleEntry(src), resolveDir: path.join(out, 'netlify', 'functions'), sourcefile: rel, loader: 'js' },
        absWorkingDir: out, preserveSymlinks: true, write: false, logLevel: 'silent', charset: 'utf8',
        banner: { js: NC.BUNDLE_BANNER }, footer: { js: NC.configLine(src) }, define: Object.assign({}, NC.BUNDLE_DEFINE),
      }));
      const buf = Buffer.from(r.outputFiles[0].contents);
      fs.writeFileSync(path.join(out, rel), buf);
      functions[name] = { file: rel, bytes: buf.length, sha256: sha256(buf), wrapper: sha256(Buffer.from(src, 'utf8')),
        warnings: r.warnings.map((w) => (w.location ? w.location.file + ': ' : '') + w.text).sort() };
    });
  } finally {
    try { fs.unlinkSync(link); } catch (e) { fs.rmSync(link, { recursive: true, force: true }); }
    deps.cleanup();
  }
  return { bundler: 'esbuild', version: esbuild.version, options: NC.BUNDLE_OPTIONS, define: NC.BUNDLE_DEFINE, banner: sha256(Buffer.from(NC.BUNDLE_BANNER, 'utf8')),
    layout, lockfile: deps.lock, functions };
}

function build(o) {
  o = o || {};
  if (!o.out) throw new Error('build-live: give --out <dir>');
  const root = o.root || REPO;
  const out = safeOut(o.out, root);
  const pub = require(path.join(root, 'prism-build', 'publish-site.js'));
  fs.rmSync(out, { recursive: true, force: true });
  const list = [];
  try {
    // 1. the static allow-list (publish-site runs its own check: forbidden folders, key material, secret names)
    const r = pub.build({ root, out: path.join(out, 'public'), api: !!o.cspReport });
    if (!r.ok) throw new Error('publish-site refused: ' + r.errors.map((e) => e.path + ': ' + e.why).join('; '));
    // 2. the site configuration and the dependencies
    fs.writeFileSync(path.join(out, 'netlify.toml'), NC.LIVE_TOML); list.push('netlify.toml');
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(livePackage(), null, 2) + '\n'); list.push('package.json');
    fs.writeFileSync(path.join(out, 'package-lock.json'), JSON.stringify(liveLock(), null, 2) + '\n'); list.push('package-lock.json');
    // 3. the function files (pre-bundled in step 5) and the platform migrations
    const layout = o.inlineJobs ? 'live-inline' : 'live';
    const LF = NF.functionsFor(layout);
    Object.keys(LF).forEach((name) => {
      const rel = 'netlify/functions/' + LF[name].file;
      fs.mkdirSync(path.join(out, 'netlify', 'functions'), { recursive: true });
      list.push(rel);
    });
    const migDir = path.join(SERVER, 'netlify', 'database', 'migrations');
    fs.readdirSync(migDir).filter((f) => /\.sql$/.test(f)).sort().forEach((f) => copyFile(path.join(migDir, f), path.join(out, 'netlify', 'database', 'migrations', f), list, 'netlify/database/migrations/' + f));
    // 4. the code
    ['core', 'functions'].forEach((d) => jsFiles(path.join(SERVER, d)).forEach((f) => copyFile(path.join(SERVER, d, f), path.join(out, d, f), list, d + '/' + f)));
    NC.LIVE_SITE_FILES.forEach((f) => copyFile(path.join(SERVER, 'site', f), path.join(out, 'site', f), list, 'site/' + f));
    copyFile(path.join(SERVER, 'db', 'migrate.js'), path.join(out, 'db', 'migrate.js'), list, 'db/migrate.js');
    copyFile(path.join(SERVER, 'ci', 'secret-scan.js'), path.join(out, 'ci', 'secret-scan.js'), list, 'ci/secret-scan.js');
    // 5. the functions, pre-bundled with their packages. The bundle inlines build-info.json (site/netlify.js reads the commit
    // from it): a preliminary one with the header fields is in place while esbuild runs, the full one is written below.
    const commit = o.commit || gitCommit();
    const head = { generated: 'server/site/build-live.js', mode: 'same-site', layout, cspReport: !!o.cspReport, commit, server: livePackage().version };
    fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(head, null, 1) + '\n');
    const bundle = bundleFunctions(out, layout, { depsCache: o.depsCache });
    // 6. build-info.json (outside public/: never published)
    const files = list.concat(r.files.map((f) => 'public/' + f), ['public/_headers', 'public/publish-manifest.json']).sort()
      .map((rel) => ({ path: rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(out, rel))).digest('hex') }));
    const info = Object.assign({}, head, { bundle, files });
    fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 1) + '\n');
    // 7. the bundle check, as uploaded
    const chk = checkDir(out);
    if (chk.problems.length) throw new Error('bundle check refused:\n  ' + chk.problems.join('\n  '));
    return { out, files: chk.files.length, info };
  } catch (e) {
    fs.rmSync(out, { recursive: true, force: true });
    throw e;
  }
}

// the uploaded bundle: the live allow-list and, for public/, publish-site's own check as well
function checkDir(dir) {
  const r = NC.checkLive(path.resolve(dir), { uploaded: true });
  const problems = r.problems.slice();
  try {
    const pub = require(path.join(REPO, 'prism-build', 'publish-site.js'));
    const c = pub.checkSet(pub.readDir(path.join(path.resolve(dir), 'public')));
    c.errors.forEach((e) => problems.push('public/' + e.path + ': ' + e.why));
  } catch (e) { if (fs.existsSync(path.join(REPO, 'prism-build', 'publish-site.js'))) problems.push('publish-site check failed: ' + e.message); }
  return { problems, files: r.files };
}

module.exports = { build, checkDir, livePackage, liveLock, bundleFunctions, installDeps };

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i !== -1 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  try {
    if (a.includes('--check')) {
      const dir = val('--dir');
      if (!dir) throw new Error('give --dir <bundle folder>');
      const r = checkDir(dir);
      r.files.forEach((f) => console.log('  ' + f));
      if (r.problems.length) { console.error('[build-live] check FAILED (' + r.problems.length + '):\n  ' + r.problems.join('\n  ')); process.exit(1); }
      console.log('[build-live] check ok — ' + r.files.length + ' files, all in the live allow-list, no secret-looking file');
    } else {
      const r = build({ out: val('--out'), cspReport: a.includes('--csp-report'), inlineJobs: a.includes('--inline-jobs') });
      if (a.includes('--inline-jobs') && a.includes('--background-jobs')) throw new Error('give --inline-jobs or --background-jobs, not both');
      console.log('[build-live] ' + r.files + ' files, layout ' + r.info.layout + ' → ' + r.out + ' (commit ' + (r.info.commit || 'unknown').slice(0, 12) + ')');
    }
  } catch (e) { console.error('[build-live] ' + e.message); process.exit(1); }
}
