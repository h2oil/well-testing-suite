#!/usr/bin/env node
'use strict';
// server/site/proxy-rule.js — the MAIN site's proxy rule for /api/v1/* (v4.0; server/RUNBOOK.md "Switch it on with Netlify",
// step 10). The main site (welltest.h2oil.co.uk) forwards /api/v1/* to the functions site with two request headers:
//   X-WTS-Proxy-Sig  the shared secret WTS_PROXY_SIG (core/http.js proxyOk; without it the functions site answers 404)
//   X-WTS-Host       the original host (WTS_HOST_HEADER = x-wts-host; trusted only together with a valid signature)
// Netlify sets request headers on a proxy rule only in netlify.toml, and netlify.toml cannot read environment variables, so
// the committed rule carries a PLACEHOLDER and the main site's build command fills it in from the main site's own
// environment variable WTS_PROXY_SIG — the value is never in the repository and never in the published files (netlify.toml is
// not in the publish directory).
//
//   node server/site/proxy-rule.js --snippet <functions-site host>   prints the netlify.toml the owner adds to the main site
//   node server/site/proxy-rule.js --snippet <functions-site host> --edge
//        the FALLBACK (RUNBOOK step 10.5): the same build, but /api/v1/* goes through the edge function
//        server/site/edge/wts-api-proxy.js, which adds the headers from the main site's runtime variables — no placeholder
//   node server/site/proxy-rule.js --apply netlify.toml              (main-site build) replaces the placeholder in place;
//        without WTS_PROXY_SIG the placeholder becomes "unset" — the static site still deploys and the API answers 404
//        (the page's cloud UI stays hidden), and a warning is printed
//   require('./proxy-rule') → { snippet(host, {edge}), apply(text, env) → {text, state}, PLACEHOLDER }

const fs = require('fs');

const PLACEHOLDER = '__WTS_PROXY_SIG__';
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/;
const SIG_RE = /^[A-Za-z0-9_-]{32,128}$/;

function snippet(host, o) {
  if (!HOST_RE.test(String(host || ''))) throw new Error('proxy-rule: give the functions site address, e.g. my-api-site.netlify.app');
  if (o && o.edge) {
    return [
      '# netlify.toml of the MAIN site (welltest.h2oil.co.uk) — the edge-function FALLBACK for /api/v1/* (server/RUNBOOK.md step 10.5).',
      '# The edge function reads WTS_PROXY_SIG and WTS_API_HOST (= ' + host + ') from the main site\'s variables at run time.',
      '[build]',
      '  command = "node prism-build/publish-site.js --api"',
      '  publish = "dist-site"',
      '  edge_functions = "server/site/edge"',
      '',
      '[build.environment]',
      '  NODE_VERSION = "22"',
      '',
      '[[edge_functions]]',
      '  path = "/api/v1/*"',
      '  function = "wts-api-proxy"',
      '',
    ].join('\n');
  }
  return [
    '# netlify.toml of the MAIN site (welltest.h2oil.co.uk) — added by the owner when switching accounts on (server/RUNBOOK.md).',
    '# The proxy signature is filled in by the build from the main site\'s environment variable WTS_PROXY_SIG; never type it here.',
    '[build]',
    '  command = "node prism-build/publish-site.js --api && node server/site/proxy-rule.js --apply netlify.toml"',
    '  publish = "dist-site"',
    '',
    '[build.environment]',
    '  NODE_VERSION = "22"',
    '  # netlify.toml is not published; it holds the filled-in signature only inside the build',
    '  SECRETS_SCAN_OMIT_PATHS = "netlify.toml"',
    '',
    '[[redirects]]',
    '  from = "/api/v1/*"',
    '  to = "https://' + host + '/api/v1/:splat"',
    '  status = 200',
    '  force = true',
    '  headers = { X-WTS-Proxy-Sig = "' + PLACEHOLDER + '", X-WTS-Host = "welltest.h2oil.co.uk" }',
    '',
  ].join('\n');
}

function apply(text, env) {
  env = env || process.env;
  const n = String(text).split(PLACEHOLDER).length - 1;
  if (n === 0) return { text: String(text), state: 'no-placeholder' };
  if (n !== 1) throw new Error('proxy-rule: the placeholder must appear exactly once');
  const first = String(env.WTS_PROXY_SIG || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || '';
  if (!first) return { text: String(text).replace(PLACEHOLDER, 'unset'), state: 'unset' };
  if (!SIG_RE.test(first)) throw new Error('proxy-rule: WTS_PROXY_SIG must be 32-128 characters of A-Z a-z 0-9 _ -');
  return { text: String(text).replace(PLACEHOLDER, first), state: 'set' };
}

module.exports = { snippet, apply, PLACEHOLDER };

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === '--snippet') process.stdout.write(snippet(a[1], { edge: a.includes('--edge') }));
    else if (a[0] === '--apply' && a[1]) {
      const r = apply(fs.readFileSync(a[1], 'utf8'));
      if (r.state !== 'no-placeholder') fs.writeFileSync(a[1], r.text);
      if (r.state === 'unset') console.warn('[proxy-rule] WTS_PROXY_SIG is not set on this site — the API will answer 404 (accounts stay hidden)');
      else console.log('[proxy-rule] ' + (r.state === 'set' ? 'proxy signature filled in' : 'no placeholder — nothing to do'));
    } else { console.error('usage: proxy-rule.js --snippet <host> [--edge] | --apply <netlify.toml>'); process.exit(2); }
  } catch (e) { console.error('[proxy-rule] ' + e.message); process.exit(1); }
}
