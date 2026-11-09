'use strict';
// server/test/_cluster.js — boots a THROWAWAY local database cluster for the server tests (docs/ACCOUNTS-PLAN.md §12.4:
// "a local server of the same database engine"). Nothing here is used outside tests.
//
//   start({port, scratch, osUser, log}) → {conn:{host, port, user, database}, dataDir, stop()}
//   findBin() → the directory holding initdb (WTS_DB_BIN, else the first match of /usr/lib/<engine>/<major>/bin, newest first)
//
// • The cluster lives in a fresh folder (mkdtemp) under `scratch` (WTS_TEST_SCRATCH, else the OS temp folder) and is
//   deleted by stop(). It listens on 127.0.0.1:<port> only (WTS_TEST_DB_PORT; default 54010 = 54000 + WP0), trust auth,
//   superuser 'wts_admin', database 'wts_test'.
// • The engine refuses to run as root: as root the cluster runs as WTS_DB_OSUSER (default 'nobody') through runuser, and
//   the folder is handed to that user. A scratch folder that user cannot reach falls back to the OS temp folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

function findBin() {
  if (process.env.WTS_DB_BIN) return fs.existsSync(path.join(process.env.WTS_DB_BIN, 'initdb')) ? process.env.WTS_DB_BIN : null;
  const roots = ['/usr/lib', '/usr/local/lib', '/opt'];
  const found = [];
  for (const r of roots) {
    let engines = [];
    try { engines = fs.readdirSync(r); } catch (e) { continue; }
    for (const eng of engines) {
      let majors = [];
      try { majors = fs.readdirSync(path.join(r, eng)); } catch (e) { continue; }
      for (const m of majors) {
        const bin = path.join(r, eng, m, 'bin');
        if (/^\d+$/.test(m) && fs.existsSync(path.join(bin, 'initdb')) && fs.existsSync(path.join(bin, 'pg_ctl'))) found.push({ bin, m: Number(m) });
      }
    }
  }
  found.sort((a, b) => b.m - a.m);
  return found.length ? found[0].bin : null;
}

function start(o) {
  o = o || {};
  const log = o.log || (() => {});
  const bin = findBin();
  if (!bin) throw new Error('no database engine binaries found (set WTS_DB_BIN)');
  const port = Number(o.port || process.env.WTS_TEST_DB_PORT || 54010);
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const osUser = asRoot ? (o.osUser || process.env.WTS_DB_OSUSER || 'nobody') : null;
  const run = (cmd, args, opts) => {
    const full = asRoot ? ['runuser', ['-u', osUser, '--', cmd].concat(args)] : [cmd, args];
    const r = cp.spawnSync(full[0], full[1], Object.assign({ encoding: 'utf8', timeout: 120000 }, opts || {}));
    if (r.status !== 0) throw new Error(path.basename(cmd) + ' failed (' + r.status + '): ' + ((r.stderr || '') + (r.stdout || '')).slice(-800));
    return r.stdout;
  };
  let base = o.scratch || process.env.WTS_TEST_SCRATCH || os.tmpdir();
  if (asRoot) {
    const probe = cp.spawnSync('runuser', ['-u', osUser, '--', 'test', '-x', base], { encoding: 'utf8' });
    if (probe.status !== 0) base = os.tmpdir() === base ? '/tmp' : os.tmpdir();
    const probe2 = cp.spawnSync('runuser', ['-u', osUser, '--', 'test', '-x', base], { encoding: 'utf8' });
    if (probe2.status !== 0) base = '/tmp';
  }
  const dir = fs.mkdtempSync(path.join(base, 'wts-db-'));
  const dataDir = path.join(dir, 'data');
  if (asRoot) cp.spawnSync('chown', ['-R', osUser, dir]);
  log('[cluster] initdb in ' + dir + ' (port ' + port + ')');
  run(path.join(bin, 'initdb'), ['-D', dataDir, '-U', 'wts_admin', '-A', 'trust', '-E', 'UTF8', '--no-locale', '--no-instructions']);
  run(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-l', path.join(dir, 'server.log'), '-w', '-t', '60', '-o',
    '-p ' + port + ' -k ' + dir + ' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off', 'start']);
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    try { run(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop']); } catch (e) { log('[cluster] stop: ' + e.message); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('[cluster] cleanup: ' + e.message); }
  };
  return { conn: { host: '127.0.0.1', port, user: 'wts_admin', database: 'template1' }, dataDir, dir, stop };
}

module.exports = { start, findBin };
