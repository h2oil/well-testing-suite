// server/site/edge/wts-api-proxy.js — the FALLBACK proxy of the MAIN site for /api/v1/* as a Netlify edge function (v4.0;
// server/RUNBOOK.md §3N step 10.5). The normal path is the proxy rule of server/site/proxy-rule.js (a [[redirects]] rule whose
// X-WTS-Proxy-Sig header the build fills in). Use this file only when the deploy summary of the main site shows that rule
// WITHOUT its header (step 10.4), i.e. the platform ignored the filled-in netlify.toml:
//   node server/site/proxy-rule.js --snippet <functions-site host> --edge > netlify.toml
// The edge function reads, at run time, from the MAIN site's environment variables (Scopes: Functions, Deploy contexts:
// Production only — a preview then has no signature and answers 404):
//   WTS_PROXY_SIG   the shared signature (the first value of a "new,old" list is sent)
//   WTS_API_HOST    the functions site's address, e.g. h2oil-accounts-api.netlify.app (not secret)
// and forwards the request with X-WTS-Proxy-Sig, X-WTS-Host (the production host) and X-WTS-Client-Ip (the platform's own
// client address of this request, context.ip). Copies of those three headers sent by the client are dropped first. With the
// fallback the functions site must read the client address from X-WTS-Client-Ip: set WTS_CLIENT_IP_HEADER=x-wts-client-ip on
// the FUNCTIONS site (only then — with the proxy rule a client could send that header itself).
//
//   proxied(request, {sig, host, ip}) → {url, init} | null      (pure; test/netlify.test.js)
//   default (request, context) → Response                         (the edge function)

const PROD_HOST = 'welltest.h2oil.co.uk';
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/;
const SIG_RE = /^[A-Za-z0-9_-]{32,128}$/;
const DROP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization',
  'proxy-connection', 'content-length', 'x-wts-proxy-sig', 'x-wts-host', 'x-wts-client-ip']);

export function proxied(request, o) {
  const sig = String((o && o.sig) || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || '';
  const host = String((o && o.host) || '').trim().toLowerCase();
  if (!SIG_RE.test(sig) || !HOST_RE.test(host)) return null;
  const u = new URL(request.url);
  if (!/^\/api\/v1\//.test(u.pathname)) return null;
  const headers = new Headers();
  request.headers.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) headers.set(k, v); });
  headers.set('X-WTS-Proxy-Sig', sig);
  headers.set('X-WTS-Host', PROD_HOST);
  if (o.ip) headers.set('X-WTS-Client-Ip', String(o.ip));
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') { init.body = request.body; init.duplex = 'half'; }
  return { url: 'https://' + host + u.pathname + u.search, init };
}

const notFound = () => new Response('{"error":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async function wtsApiProxy(request, context) {
  const env = (globalThis.Netlify && globalThis.Netlify.env) || { get: () => '' };
  const p = proxied(request, { sig: env.get('WTS_PROXY_SIG'), host: env.get('WTS_API_HOST'), ip: context && context.ip });
  if (!p) return notFound();
  return fetch(p.url, p.init);
}
