'use strict';
// server/site/netlify-blobs.js — the Netlify Blobs binding of the blob-store seam (docs/ACCOUNTS-PLAN.md §2, §3.1, §13.5; v4.0
// hosting, server/README.md "Hosting"). It returns the common host-store shape that site/adapters.js hostObjects() wraps
// (every key validated there), so the API, the jobs and the weekly export all read and write through the same rules.
//
//   createStore(env, {name?, getStore?}) → {get(key) → Buffer|null, set(key, Uint8Array), delete(key), list({prefix}) → {blobs}}
//     name      the store: 'wts-objects' (default; WTS_BLOBS_STORE overrides) or 'wts-exports' (the weekly export)
//     getStore  injected in tests (no network); else require('@netlify/blobs').getStore
//   REGION, CONSISTENCY, STORES
//
// Rules (§13.5):
//   • region: EVERY getStore call passes region 'eu-central-1' — a site-wide store without it is created in the platform's
//     default region (outside the EU), and a store's data never moves afterwards. The nearest region to the UK; there is no
//     London region for Blobs (README, Hosting deviations).
//   • consistency: 'strong' for every store — the API reads chunks right after writing them (upload → commit → open), the
//     jobs delete then list, and eventual consistency may serve a stale or missing object for up to 60 s.
//   • credentials: inside the functions site the platform injects the site id and token; an operations script outside the
//     site passes WTS_BLOBS_SITE_ID and WTS_OBJECTS_CREDENTIAL (a personal access token; never committed).
//   • values: the platform stores string | ArrayBuffer | Blob; a Uint8Array / Buffer is copied into its own ArrayBuffer.

const REGION = 'eu-central-1';
const CONSISTENCY = 'strong';
const STORES = Object.freeze({ objects: 'wts-objects', exports: 'wts-exports' });
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function toArrayBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (typeof v === 'string') return toArrayBuffer(Buffer.from(v, 'utf8'));
  throw new Error('netlify-blobs: unsupported value type');
}

function storeOptions(env, name) {
  const o = { name, region: REGION, consistency: CONSISTENCY };
  const site = env.WTS_BLOBS_SITE_ID ? String(env.WTS_BLOBS_SITE_ID).trim() : '';
  const token = env.WTS_OBJECTS_CREDENTIAL ? String(env.WTS_OBJECTS_CREDENTIAL).trim() : '';
  if (site && token) { o.siteID = site; o.token = token; }
  return o;
}

function createStore(env, o) {
  env = env || process.env; o = o || {};
  const name = String(o.name || env.WTS_BLOBS_STORE || STORES.objects);
  if (!NAME_RE.test(name)) throw new Error('netlify-blobs: bad store name');
  const getStore = o.getStore || require('@netlify/blobs').getStore;
  // one store object per call keeps the region on EVERY request path (and costs nothing: getStore only builds a client)
  const store = () => getStore(storeOptions(env, name));
  return {
    kind: 'netlify-blobs', name, region: REGION,
    async get(key) {
      const v = await store().get(key, { type: 'arrayBuffer', consistency: CONSISTENCY });
      return v == null ? null : Buffer.from(new Uint8Array(v));
    },
    async set(key, data) { await store().set(key, toArrayBuffer(data)); },
    async delete(key) { await store().delete(key); },
    async list(q) {
      const r = await store().list({ prefix: (q && q.prefix) || '' });
      return { blobs: ((r && r.blobs) || []).map((b) => ({ key: b.key })) };
    },
  };
}

module.exports = { createStore, storeOptions, toArrayBuffer, REGION, CONSISTENCY, STORES };
