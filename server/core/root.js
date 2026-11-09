'use strict';
// server/core/root.js — the ONE answer to "where is the server folder" for code that reads a file at run time (v4.0).
// In the repository that is server/; in a built bundle (site/build.js, site/build-live.js) it is the bundle root. A live
// function is pre-bundled into one netlify/functions/<name>.mjs by site/build-live.js, where every module shares one
// __dirname, defined as <bundle root>/site (site/netlify-check.js BUNDLE_DEFINE): a path is only right in both places when it
// is built from a file of a FIRST-LEVEL folder (core/, site/, db/, functions/) as '..' — which is what SERVER_ROOT is. Never
// join __dirname with a sibling name directly (db/migrate.js once used path.join(__dirname, 'migrations'), which is
// <root>/site/migrations in a bundle).
//
//   SERVER_ROOT                 absolute path of the server folder / bundle root
//   serverPath(...parts)        path.join(SERVER_ROOT, ...parts)

const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
function serverPath(...parts) { return path.join(SERVER_ROOT, ...parts); }

module.exports = { SERVER_ROOT, serverPath };
