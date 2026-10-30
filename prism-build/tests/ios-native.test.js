'use strict';
// Static checks of the native iOS project (no Xcode here): the UIScene life cycle that apps
// built with the iOS 27 SDK must use (TN3187 — without it the app is terminated at launch),
// every Swift file compiled into the App target, and the App Store version stamping.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const IOS = path.join(ROOT, 'ios-app', 'ios', 'App');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PBX = 'ios-app/ios/App/App.xcodeproj/project.pbxproj';
const WP = 'WPIOS';

module.exports = [
  {
    name: 'Info.plist: UIScene manifest (SceneDelegate + Main storyboard), no UIMainStoryboardFile, arm64',
    wp: WP, opts: false,
    run(app, assert) {
      const plist = read('ios-app/ios/App/App/Info.plist');
      assert.match(plist, /<key>UIApplicationSceneManifest<\/key>/);
      assert.match(plist, /<key>UIWindowSceneSessionRoleApplication<\/key>/);
      assert.match(plist, /<key>UISceneConfigurationName<\/key>\s*<string>Default Configuration<\/string>/);
      assert.match(plist, /<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/);
      assert.match(plist, /<key>UISceneStoryboardFile<\/key>\s*<string>Main<\/string>/);
      assert.match(plist, /<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
      assert.ok(!/UIMainStoryboardFile/.test(plist), 'the scene loads Main.storyboard; UIMainStoryboardFile would be ignored');
      assert.ok(!/<string>armv7<\/string>/.test(plist), 'device capability is arm64');
      assert.match(plist, /<key>NSLocalNetworkUsageDescription<\/key>/);
      // balanced plist (a broken Info.plist fails the archive)
      const open = (plist.match(/<dict>/g) || []).length, close = (plist.match(/<\/dict>/g) || []).length;
      assert.strictEqual(open, close, '<dict> balanced');
      assert.strictEqual((plist.match(/<array>/g) || []).length, (plist.match(/<\/array>/g) || []).length, '<array> balanced');
    },
  },
  {
    name: 'Swift: AppDelegate @main + scene configuration "Default Configuration"; SceneDelegate forwards URL opens to Capacitor',
    wp: WP, opts: false,
    run(app, assert) {
      const ad = read('ios-app/ios/App/App/AppDelegate.swift');
      assert.match(ad, /^@main\s*\nclass AppDelegate: UIResponder, UIApplicationDelegate/m);
      assert.ok(!/@UIApplicationMain/.test(ad), '@UIApplicationMain is deprecated');
      assert.match(ad, /configurationForConnecting connectingSceneSession: UISceneSession/);
      assert.match(ad, /UISceneConfiguration\(name: "Default Configuration", sessionRole: connectingSceneSession\.role\)/);
      const sd = read('ios-app/ios/App/App/SceneDelegate.swift');
      assert.match(sd, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
      assert.match(sd, /var window: UIWindow\?/);
      assert.match(sd, /openURLContexts/);
      assert.match(sd, /connectionOptions\.urlContexts/);
      assert.match(sd, /ApplicationDelegateProxy\.shared\.application\(UIApplication\.shared, open: url/);
      assert.match(sd, /ApplicationDelegateProxy\.shared\.application\(UIApplication\.shared, continue:/);
      // the storyboard still hosts the Capacitor bridge
      assert.match(read('ios-app/ios/App/App/Base.lproj/Main.storyboard'), /customClass="MainViewController" customModule="App"/);
    },
  },
  {
    name: 'project.pbxproj: every Swift file in App/ is in the App target sources; every build file / group child resolves',
    wp: WP, opts: false,
    run(app, assert) {
      const pbx = read(PBX);
      const swift = fs.readdirSync(path.join(IOS, 'App')).filter((f) => f.endsWith('.swift')).sort();
      assert.ok(swift.includes('SceneDelegate.swift') && swift.includes('AppDelegate.swift'));
      const fileRefs = {};
      for (const m of pbx.matchAll(/^\s*([0-9A-F]{24}) \/\* ([^*]+?) \*\/ = \{isa = PBXFileReference;[^\n]*?path = ([^;]+);/gm)) fileRefs[m[1]] = m[3].replace(/"/g, '');
      const srcPhase = (pbx.match(/\/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/) || [])[1] || '';
      const inSources = [...srcPhase.matchAll(/([0-9A-F]{24}) \/\* (\S+) in Sources \*\//g)].map((m) => m[2]).sort();
      assert.deepStrictEqual(inSources, swift, 'Sources build phase = the Swift files on disk');
      // every PBXBuildFile points at an existing file reference (or a package product)
      for (const m of pbx.matchAll(/^\s*([0-9A-F]{24}) \/\* (.+?) \*\/ = \{isa = PBXBuildFile; (fileRef|productRef) = ([0-9A-F]{24})/gm)) {
        if (m[3] === 'fileRef') assert.ok(new RegExp('^\\s*' + m[4] + ' /\\*[^\\n]*= \\{\\s*isa = (PBXFileReference|PBXVariantGroup)', 'm').test(pbx), m[2] + ': fileRef ' + m[4] + ' defined');
      }
      // every Swift file reference sits in the App group and exists on disk
      for (const f of swift) {
        const id = Object.keys(fileRefs).find((k) => fileRefs[k] === f);
        assert.ok(id, f + ' has a PBXFileReference');
        assert.ok(new RegExp('504EC3061FED79650016851F /\\* App \\*/ = \\{[\\s\\S]*?' + id + ' /\\* ' + f.replace('.', '\\.') + ' \\*/').test(pbx), f + ' in the App group');
      }
      // object ids are unique
      const ids = [...pbx.matchAll(/^\s*([0-9A-F]{24}) \/\*[^\n]*= \{/gm)].map((m) => m[1]);
      assert.strictEqual(new Set(ids).size, ids.length, 'unique object ids');
    },
  },
  {
    name: 'App Store version = in-app version: ci_post_clone.sh stamps RELEASE_NOTES[0].ver (build = CI_BUILD_NUMBER); committed MARKETING_VERSION and fallback match it',
    wp: WP, opts: false,
    run(app, assert) {
      const a = read('ios-app/ci_scripts/ci_post_clone.sh'), b = read('ios-app/ios/App/ci_scripts/ci_post_clone.sh');
      assert.strictEqual(a, b, 'both ci_post_clone.sh copies identical (Xcode Cloud runs the one under ios/App)');
      const html = read('well-testing-app.html');
      const rn = html.slice(html.indexOf('const RELEASE_NOTES = ['));
      const newest = (rn.match(/ver\s*:\s*'v?([0-9]+(?:\.[0-9]+){1,2})'/) || [])[1];
      assert.ok(newest, 'RELEASE_NOTES[0].ver readable');
      assert.ok(newest.split('.').length <= 3, 'App Store versions have at most three parts');
      // run the script's own extraction exactly as Xcode Cloud does
      const block = (a.match(/^VERSION_BASE="[^\n]*\n[\s\S]*?^fi$/m) || [])[0];
      assert.ok(block, 'version block found');
      const out = require('child_process').execFileSync('bash', ['-c', block + '\necho "VB=$VERSION_BASE"'], { env: Object.assign({}, process.env, { CI_PRIMARY_REPOSITORY_PATH: ROOT }), encoding: 'utf8' });
      assert.match(out, new RegExp('VB=' + newest.replace(/\./g, '\\.') + '\\s*$'), 'stamped version = newest release notes version');
      assert.strictEqual((a.match(/^VERSION_BASE="([0-9.]+)"/m) || [])[1], newest, 'fallback VERSION_BASE = newest release');
      assert.match(a, /FULL_VERSION="\$\{VERSION_BASE\}"/);
      assert.match(a, /CURRENT_PROJECT_VERSION = \$\{CI_BUILD_NUMBER\};/);
      const mv = [...read(PBX).matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
      assert.ok(mv.length >= 2 && mv.every((v) => v === newest), 'committed MARKETING_VERSION ' + mv.join(',') + ' = ' + newest);
    },
  },
  {
    name: 'plugin warnings: @capacitor/app ≥ 8.1.2 pinned; ci_post_clone.sh runs scripts/patch-plugins.js after npm ci and before cap sync; the patch is exact and idempotent',
    wp: WP, opts: false,
    run(app, assert) {
      const lock = JSON.parse(read('ios-app/package-lock.json'));
      const v = lock.packages['node_modules/@capacitor/app'].version.split('.').map(Number);
      assert.ok(v[0] > 8 || (v[0] === 8 && (v[1] > 1 || (v[1] === 1 && v[2] >= 2))), '@capacitor/app ' + v.join('.') + ' ≥ 8.1.2 (fixes the AppPlugin.swift:121 coercion warning)');
      assert.strictEqual(JSON.parse(read('ios-app/package.json')).dependencies['@capacitor/app'], lock.packages[''].dependencies['@capacitor/app'], 'package.json and lock agree');
      const ci = read('ios-app/ci_scripts/ci_post_clone.sh');
      const iCi = ci.indexOf('npm ci '), iPatch = ci.indexOf('node scripts/patch-plugins.js'), iSync = ci.indexOf('npx cap sync ios');
      assert.ok(iCi > 0 && iPatch > iCi && iSync > iPatch, 'npm ci → patch-plugins → cap sync');
      const P = require(path.join(ROOT, 'ios-app', 'scripts', 'patch-plugins.js'));
      assert.ok(P.PATCHES.length >= 1);
      // exercise the patch on a temporary copy of the pinned plugin layout
      const os = require('os');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-patch-'));
      const p = P.PATCHES[0];
      const dir = path.join(tmp, 'node_modules', p.package, path.dirname(p.file));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', p.package, 'package.json'), JSON.stringify({ version: '8.1.2' }));
      const file = path.join(tmp, 'node_modules', p.package, p.file);
      fs.writeFileSync(file, 'func a() {\n' + p.from + '        let x = 1\n}\n');
      assert.match(P.run(tmp)[0], /patched/);
      assert.ok(!fs.readFileSync(file, 'utf8').includes(p.from), 'line removed');
      assert.match(P.run(tmp)[0], /already patched/, 'idempotent');
      assert.match(P.run(path.join(tmp, 'none'))[0], /not found — skipped/, 'missing plugin never fails the build');
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  },
];
