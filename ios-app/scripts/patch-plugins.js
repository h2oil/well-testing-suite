#!/usr/bin/env node
// patch-plugins.js — small, idempotent source fixes to Capacitor plugins in node_modules
// that Xcode compiles through Swift Package Manager (CapApp-SPM points at the plugin folders).
//
// Run after `npm ci` and before `npx cap sync ios` (ci_post_clone.sh does it). Each patch
// replaces one exact line; if the plugin has changed and the line is not found, the patch is
// skipped with a notice (never fails the build). Delete an entry once the plugin itself is fixed.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');                 // ios-app/

const PATCHES = [
  {
    // Xcode warning "Initialization of immutable value 'responseType' was never used"
    // (LegacyFilesystemImplementation.swift:77). The value is never read, so the line is removed.
    // Still present in @capacitor/filesystem 8.1.5; 8.1.5 also needs ion-ios-filesystem 2.0.1, which
    // would require re-resolving Package.resolved in Xcode — so the pinned 8.1.2 is patched instead.
    package: '@capacitor/filesystem',
    file: 'ios/Sources/FilesystemPlugin/LegacyFilesystemImplementation.swift',
    from: '        let responseType = call.getString("responseType", "text")\n',
    to: '',
  },
];

function findFile(pkgDir, rel) {
  const direct = path.join(pkgDir, rel);
  if (fs.existsSync(direct)) return direct;
  // plugin layout changed? look for the file name anywhere under ios/
  const name = path.basename(rel);
  const stack = [path.join(pkgDir, 'ios')];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.name === name) return p;
    }
  }
  return null;
}

function run(root) {
  const results = [];
  for (const p of PATCHES) {
    const pkgDir = path.join(root, 'node_modules', p.package);
    let version = '?';
    try { version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version; } catch (e) { /* not installed */ }
    const file = findFile(pkgDir, p.file);
    if (!file) { results.push(p.package + '@' + version + ': ' + p.file + ' not found — skipped'); continue; }
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(p.from)) {
      fs.writeFileSync(file, src.split(p.from).join(p.to));
      results.push(p.package + '@' + version + ': patched ' + path.relative(root, file));
    } else {
      results.push(p.package + '@' + version + ': already patched or line changed — ' + path.relative(root, file) + ' left as is');
    }
  }
  return results;
}

if (require.main === module) {
  for (const line of run(ROOT)) console.log('[patch-plugins] ' + line);
}

module.exports = { PATCHES, run };
