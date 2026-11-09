#!/usr/bin/env node
'use strict';
// server/site/netlify-check.js — the build command of the functions site (server/netlify.toml). It builds nothing; it refuses
// a deploy that breaks the site's rules, so a mistake fails the deploy instead of going live (v4.0; README "Hosting"):
//   • the publish directory holds robots.txt and nothing else (the site publishes no content);
//   • netlify/functions holds exactly the six functions of site/netlify.js FUNCTIONS, each with its literal config;
//   • no file of the bundle (core/, functions/, site/, netlify/, public/, netlify.toml) contains key material or a secret
//     value pattern (ci/secret-scan.js rules);
//   • Node is at least 22.12 (the blob store package needs it).
//
//   node site/netlify-check.js   → "[netlify-check] ok …" or the problems and exit 1
//   require('./netlify-check').check(root?) → [problems]

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'functions', 'site', 'netlify', 'public'];

function walk(dir, rel, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) walk(path.join(dir, d.name), r, out);
    else if (d.isFile()) out.push(r);
  });
  return out;
}
// the literal `export const config = {...}` of an entry file ({} when absent)
function literalConfig(text) {
  const m = /export const config = (\{[^;]*\});/.exec(text);
  if (!m) return null;
  return Function('"use strict"; return (' + m[1] + ');')();
}

function check(root) {
  root = root || SERVER;
  const problems = [];
  const { FUNCTIONS } = require('./netlify');
  const pub = fs.existsSync(path.join(root, 'public')) ? fs.readdirSync(path.join(root, 'public')) : [];
  if (pub.length !== 1 || pub[0] !== 'robots.txt') problems.push('public/ must hold robots.txt only');
  const fnDir = path.join(root, 'netlify', 'functions');
  const files = fs.existsSync(fnDir) ? fs.readdirSync(fnDir).sort() : [];
  const want = Object.keys(FUNCTIONS).map((k) => FUNCTIONS[k].file).sort();
  if (JSON.stringify(files) !== JSON.stringify(want)) problems.push('netlify/functions must hold exactly ' + want.join(', '));
  Object.keys(FUNCTIONS).forEach((name) => {
    const f = path.join(fnDir, FUNCTIONS[name].file);
    if (!fs.existsSync(f)) return;
    const text = fs.readFileSync(f, 'utf8');
    let cfg;
    try { cfg = literalConfig(text); } catch (e) { problems.push(name + ': config is not a literal'); return; }
    if (JSON.stringify(cfg) !== JSON.stringify(FUNCTIONS[name].config)) problems.push(name + ': config differs from site/netlify.js FUNCTIONS');
    if (!/^import nf from '\.\.\/\.\.\/site\/netlify\.js';$/m.test(text)) problems.push(name + ': must import site/netlify.js');
  });
  const scan = require('../ci/secret-scan');
  const list = SCAN_DIRS.reduce((acc, d) => walk(path.join(root, d), d, acc), []).concat(['netlify.toml']);
  list.forEach((r) => {
    const f = path.join(root, r);
    if (!fs.existsSync(f)) return;
    if (scan.KEY_FILE.test(r)) problems.push(r + ': key file');
    if (/\.(m?js|json|toml|txt|sql)$/.test(r)) scan.scanText(fs.readFileSync(f, 'utf8')).forEach((x) => problems.push(r + ':' + x.line + ' ' + x.rule));
  });
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 12)) problems.push('Node ' + process.versions.node + ' is older than 22.12');
  return problems;
}

module.exports = { check, literalConfig };

if (require.main === module) {
  const p = check();
  if (p.length) { console.error('[netlify-check] refused:\n  ' + p.join('\n  ')); process.exit(1); }
  console.log('[netlify-check] ok — publish directory, six functions, no key material, Node ' + process.versions.node);
}
