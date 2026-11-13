#!/usr/bin/env node
// prism-build/help-shots.js — Help centre screenshot tool (docs/HELP-GUIDE-PLAN.md §3, work package WP-S).
//
// Reads the shot recipes declared beside each guide (WTS_helpContent: guides[route].shots, guide parts, course,
// field scenarios, Getting started), captures them in a fixed browser environment and writes
//   help/img/<folder>/<shot>-d.webp | -p.webp     (desktop 1280×800 / phone 390×844 @2x)
//   help/img/manifest.json                         (one entry per file, sorted, no capture time)
//   prism-build/48-calc-help-manifest.js           (GENERATED data module: the manifest as data, no fetch needed)
//
//   node prism-build/help-shots.js --all                    # every guide, course, scenarios, start
//   node prism-build/help-shots.js --route orifice,wts      # some folders (a guide route, or course / scenarios / start)
//   node prism-build/help-shots.js --changed                # only shots whose recipeHash or fingerprint differs
//   node prism-build/help-shots.js --check                  # no browser: content ↔ manifest ↔ files ↔ module, caps, fingerprints
//     options: --phone-only, --desktop-only, --workers 4, --verbose, --keep-png <dir>, --prune (delete orphan files),
//              --strict (a [warn], e.g. a crop target taller than the viewport, fails the shot)
//              --out <dir> (image folder, default help/img), --module <file> (default prism-build/48-calc-help-manifest.js,
//              or <out>/48-calc-help-manifest.js when --out is given), --content <file.js> (an extra help content file,
//              loaded like a 48-calc-help-*.js source; tooling tests), --html (shoot the built well-testing-app.html
//              instead of the in-memory build from the prism-build sources)
//
// Exit codes: 0 ok · 1 a failed shot, cap or check · 2 a tool error. Capture without Playwright prints "[skip]" and exits 0;
// --check never needs a browser.
//
// Runs only in the Linux container with /opt/pw-browsers: the Chromium build and the fonts decide the bytes, so any
// other machine gives other images. The manifest header records the Chromium version and the font families.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BUILD = __dirname;
const ROOT = path.resolve(BUILD, '..');
const IMG_DIR = path.join(ROOT, 'help', 'img');
const MODULE_FILE = path.join(BUILD, '48-calc-help-manifest.js');
const MODULE_NAME = '48-calc-help-manifest.js';
const SCHEMA = 1;
const RECIPE_SCHEMA = 1;   // bump when the interpreter changes what a recipe means (re-shoots every shot)
const TIME = '2026-11-02T09:00:00Z';

// ── Fixed environment (§3.4) ─────────────────────────────────────────────
const VIEWS = {
  desktop: { suffix: 'd', viewport: { width: 1280, height: 800 }, scale: 1, phone: false, q: 0.80 },
  phone: { suffix: 'p', viewport: { width: 390, height: 844 }, scale: 2, phone: true, q: 0.75 },
};
const CONTEXT = { locale: 'en-GB', timezoneId: 'UTC', reducedMotion: 'reduce', colorScheme: 'dark' };
const SEED = {
  h2oil_client_info: { client: 'Operator Energy Ltd', operator: 'Operator Energy Ltd', well: 'Example-1', field: 'Example Field' },
  wts_unit_system: 'imperial',
  h2viz3d_prefs: { mode: '2d', quality: 'medium' },
};
// Masked chrome (§3.3): the version label and the simulator's DOM clock. Dates are NOT masked by selector: every shot
// runs with Date fixed at TIME (setFixedTime, or the installed fake clock that starts at TIME), so report dates, Quick
// Report / PDF dates and default-today date inputs always read 2 November 2026 and are part of the picture writers
// describe. The 'SIM T+…' text drawn into the 2D canvas cannot be hidden by CSS; it is deterministic because the
// simulator recipes run on the paused fake clock. [data-help-mask] is for pages that want a field hidden in every shot.
const DEFAULT_MASK = ['#appVersionLabel', '.wtsl-clock', '[data-h="clock"]', '[data-h="t_clock"]', '[data-help-mask]'];

// ── Size caps (§3.6) ─────────────────────────────────────────────────────
const CAPS = {
  'desktop:viewport': 150 * 1000, 'desktop:crop': 90 * 1000, 'phone:viewport': 110 * 1000, 'phone:crop': 70 * 1000,
  totalBytes: 8.15 * 1000 * 1000, files: 300, moduleBytes: 9 * 1000,   // 8.7 kB: owner decision Q13 option 1 (plan §3.6); +0.2 for the SIM-FOLLOWUP shots (lead, WP-HC); +0.05 DFIT (WP7); +0.05 wellperf (WP10, from the help pool); Q21 (owner, 2026-11-13): images 8 → 8.15 MB (measured 8,110,924 with the six Well Performance B shots), module 8.8 → 9 kB (measured 8,914)
};
const capFor = (view, target) => CAPS[view + ':' + (isViewport(target) ? 'viewport' : 'crop')];
const isViewport = (target) => target == null || target === 'viewport';

// ── Recipe ops and named actions (§3.3) ──────────────────────────────────
const OPS = ['set', 'select', 'click', 'press', 'hover', 'scroll', 'waitFor', 'waitEvent', 'action'];
// Routes whose pages run timers of their own (simulator, PRiSM fits, live data): always the paused fake clock.
const INSTALL_ROUTES = ['wts', 'prism', 'dca', 'pta', 'buildup', 'modbus', 'wellos', 'historian'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run until cond() is true: fake-clock steps of 250 ms (install) or real 250 ms waits, 120 s cap. In install mode
// the real sleep(5) between steps lets non-timer work (a library fetch, image decode) finish; the step at which cond()
// first holds is then fixed by the page, not the load, as long as that work completes within the step.
async function until(s, cond, what, capMs) {
  const cap = capMs || 120000;
  for (let t = 0; t <= cap; t += 250) {
    if (await cond()) return true;
    await s.advance(250);
    if (s.installed) await sleep(5);
  }
  throw new Error((what || 'condition') + ' not reached within ' + Math.round(cap / 1000) + ' s');
}
// Settle: the page text and structure unchanged for four steps in a row (at least 1 s), 120 s cap.
async function settle(s, capMs) {
  let last = '', same = 0;
  const sig = () => s.page.evaluate(() => {
    const b = document.getElementById('pgBody') || document.body;
    return (b ? b.innerText.length + ':' + b.getElementsByTagName('*').length + ':' + b.innerText.slice(0, 4000) : '');
  }).catch(() => '');
  await until(s, async () => { const g = await sig(); same = g === last ? same + 1 : 0; last = g; return same >= 4; }, 'a settled page', capMs);
}
// Advance ms in 250 ms steps (lets promises resolve between timer batches).
async function steps(s, ms) { for (let t = 0; t < ms; t += 250) { await s.advance(250); if (s.installed) await sleep(5); } }
// After a simulator action: run a fixed 1 s of fake time in 250 ms steps (above the live view's 250 ms HUD and
// 1000 ms slow-update periods, 38-wts-live.js loop()), then two animation frames, so the toolbar, HUD and chips have
// all redrawn from the final state whatever phase their timers were in when the action started.
async function simQuiet(s) { await steps(s, 1000); await s.advance(32); }
// Click the first visible element matching sel (in the page).
// Then the render barrier (s.render, pw-session.js), so observers the click set up fire at a fixed fake time.
async function clickVisible(s, sel) {
  const ok = await s.page.evaluate((q) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const el = Array.from(document.querySelectorAll(q)).find(vis);
    if (el) el.click();
    return !!el;
  }, sel);
  if (ok && s.render) await s.render();
  return ok;
}
async function mustClick(s, sel, what) { if (!(await clickVisible(s, sel))) throw new Error((what || 'control') + ' not found: ' + sel); }
function liveSim(s, fn, arg) {
  return s.page.evaluate(([f, a]) => {
    const sim = window.WTS_live && window.WTS_live.getSim && window.WTS_live.getSim();
    if (!sim) throw new Error('the simulator is not running on this page');
    return new Function('sim', 'a', f)(sim, a);   // eslint-disable-line no-new-func
  }, [fn, arg]);
}

// Each named action: clock mode ('install' = paused fake clock advanced by the action; 'fixed' = Date fixed,
// timers real) and run(s, args). Content never holds code; writers ask WP-S for new actions.
const ACTIONS = {
  // ▶ Analyse, then wait for prism:fit-updated.
  prismAnalyse: { clock: 'install', run: async (s) => {
    await s.page.evaluate(() => {
      window.__hsFit = false;
      document.addEventListener('prism:fit-updated', () => { window.__hsFit = true; }, { once: true });
      window.addEventListener('prism:fit-updated', () => { window.__hsFit = true; }, { once: true });
      const b = document.getElementById('prism_analyse_btn');
      if (b) b.click(); else if (typeof window.PRiSM_analyse === 'function') window.PRiSM_analyse();
      else throw new Error('PRiSM ▶ Analyse is not available');
    });
    await until(s, () => s.page.evaluate(() => window.__hsFit === true), 'prism:fit-updated');
    await s.advance(300);
  } },
  prismStep: { clock: 'install', run: async (s, n) => {
    await s.page.evaluate((k) => { if (typeof window.PRiSM_gotoStep !== 'function') throw new Error('PRiSM_gotoStep missing'); window.PRiSM_gotoStep(k); }, +n);
    await s.advance(500);
  } },
  // PRiSM DFIT mode: Test = DFIT, the demo DFIT (default 'reference'), Load demo DFIT, then ▶ Analyse DFIT until the status
  // line reads "complete" (the pipeline runs on timers through PRiSM_autoInterp.drive, so the fake clock is advanced).
  prismDfit: { clock: 'install', run: async (s, demo) => {
    const pick = (id, v) => s.page.evaluate(([q, x]) => {
      const e = document.getElementById(q);
      if (!e) throw new Error('#' + q + ' missing');
      e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    }, [id, v]);
    await pick('prism_testtype', 'dfit');
    await s.advance(500);
    await pick('prism_dfit_demo', demo || 'reference');
    await mustClick(s, '#prism_dfit_demo_btn', 'Load demo DFIT');
    await s.advance(1000);
    await mustClick(s, '#prism_dfit_analyse', '▶ Analyse DFIT');
    await until(s, () => s.page.evaluate(() => { const e = document.getElementById('prism_dfit_status'); return !!e && /complete/i.test(e.textContent); }), 'the DFIT analysis');
    await s.advance(500);
  } },
  // Source = Demo, then the demo kind ('oil' | 'gas'), Load demo, and run until the page settles.
  buildupDemo: { clock: 'install', run: async (s, kind) => {
    await s.page.evaluate((k) => {
      const pick = (id, v) => {
        const sel = document.getElementById(id);
        if (!sel) throw new Error('#' + id + ' missing');
        sel.value = v; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      pick('bu_src', 'demo');
      pick('bu_demo_kind', k || 'oil');
    }, kind);
    await s.advance(200);
    await mustClick(s, '#bu_demo_load', 'Load demo');
    await settle(s);
  } },
  // Live data never settles (values keep updating): these run a fixed 5 s of fake time instead.
  modbusSimDemo: { clock: 'install', run: async (s) => { await mustClick(s, '#pgBody [data-act=demo]', 'Load simulator demo'); await steps(s, 5000); } },
  // Data source = Modbus, then "Use the Modbus simulator demo" in the banner.
  wellosDemo: { clock: 'install', run: async (s) => {
    await clickVisible(s, '#pgBody [data-act=src][data-src=modbus]');
    await s.advance(300);
    await mustClick(s, '#pgBody [data-act=demo]', 'Use the Modbus simulator demo');
    await steps(s, 5000);
  } },
  // 'steady' | 'empty' — the toolbar Reset menu (confirm answered), or the engine's reset when the menu is hidden.
  simReset: { clock: 'install', run: async (s, kind) => {
    const k = kind === 'empty' ? 'empty' : 'steady';
    if (await clickVisible(s, '[data-act=resetmenu]')) {
      await s.advance(50);
      if (await clickVisible(s, '[data-act=reset][data-v=' + k + ']')) { await s.advance(50); await clickVisible(s, '[data-act=confirm-yes]'); }
    } else await liveSim(s, 'sim.reset(a);', k);
    await s.advance(500);
    await simQuiet(s);
    // the "Test reset (steady)" toast is a reaction to this set-up step, not part of the page as the user opens it
    await s.page.evaluate(() => document.querySelectorAll('.wtsl-toast').forEach((t) => t.remove()));
    if (s.render) await s.render();
  } },
  // {speed, simSeconds}: play, run simSeconds of simulated time, pause — public WTS_live / WTS_sim API only.
  simRun: { clock: 'install', run: async (s, a) => {
    const speed = (a && +a.speed) || 10, secs = (a && +a.simSeconds) || 60;
    await liveSim(s, 'if (sim.setSpeed) sim.setSpeed(a); sim.play();', speed);
    await s.advance(Math.round(secs / speed * 1000));
    await liveSim(s, 'sim.pause();', null);
    await simQuiet(s);
  } },
  simFault: { clock: 'install', run: async (s, name) => { await liveSim(s, 'sim.setFault(a, true);', String(name)); await s.advance(500); await simQuiet(s); } },
  // {key: 'on'|'off'|true|false} for the rig-up switches.
  simRigup: { clock: 'install', run: async (s, a) => {
    for (const k of Object.keys(a || {}).sort()) {
      const on = a[k] === true || a[k] === 'on' || a[k] === 'in';
      const ok = await s.page.evaluate(([key, want]) => {
        const b = document.querySelector('[data-rig="' + key + '"]');
        if (!b) return false;
        if ((b.getAttribute('aria-checked') === 'true') !== want) b.click();
        return true;
      }, [k, on]);
      if (!ok) throw new Error('rig-up switch not found: ' + k);
      if (s.render) await s.render();
      await s.advance(300);
    }
    await simQuiet(s);
  } },
  simCard: { clock: 'install', run: async (s, tag) => {
    await s.page.evaluate((t) => {
      const c = window.WTS_live && window.WTS_live._internals && window.WTS_live._internals.ctl && window.WTS_live._internals.ctl();
      if (!c || !c._debug || typeof c._debug.openCard !== 'function') throw new Error('the simulator view is not mounted');
      c._debug.openCard(t);
    }, String(tag));
    await s.advance(200);
  } },
  // a toolbar menu by its data-act: scen, resetmenu, viewmenu, colour, labels, quality, more, alarms
  simMenu: { clock: 'install', run: async (s, name) => { await mustClick(s, '[data-act="' + String(name) + '"]', 'simulator menu'); await s.advance(100); } },
  // '2d' | '3d'. 3D waits for the scene, pauses the sim and draws two frames; no WebGL → stays 2D (manifest view3d:false).
  simView: { clock: 'install', run: async (s, m) => {
    const mode = m === '3d' ? '3d' : '2d';
    await clickVisible(s, '[data-act=mode' + mode + ']');
    if (mode === '3d') {
      await until(s, () => s.page.evaluate(() => { const l = document.getElementById('wtsl_loading'); return !l || getComputedStyle(l).display === 'none' || !l.offsetParent; }), 'the 3D scene');
      const on3d = await s.page.evaluate(() => { const b = document.querySelector('[data-act=mode3d]'); return !!b && b.getAttribute('aria-pressed') === 'true'; });
      if (!on3d) { s.view3d = false; await clickVisible(s, '[data-act=mode2d]'); }
      else s.view3d = true;
      await liveSim(s, 'sim.pause();', null);
      await simQuiet(s);
    }
    await s.advance(32);
  } },
  quickReport: { clock: 'fixed', run: async (s, template) => {
    const opened = await s.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#wts_quick_report_host button')).find((x) => x.innerText.trim() === '▾');
      if (b) b.click();
      return !!b;
    });
    if (!opened) throw new Error('Quick Report menu not found');
    await s.advance(300);
    if (template) {
      const ok = await s.page.evaluate((t) => {
        const it = Array.from(document.querySelectorAll('button, [role=menuitem], li, a')).find((x) => x.offsetParent && x.innerText.trim().toLowerCase().indexOf(String(t).toLowerCase()) === 0);
        if (it) it.click();
        return !!it;
      }, template);
      if (!ok) throw new Error('Quick Report template not found: ' + template);
      await s.advance(300);
    }
  } },
  // Well Performance Jobs (Studies, lift-curve tables, Run all wells, the gas-lift example's design): {click?, done} — click the
  // control (optional), then wait (real time, 120 s cap) until the `done` selector exists. The jsdom fingerprint does not run
  // these Jobs, so a shot using this action is browser-only (checked by its recipe hash).
  wpJob: { clock: 'fixed', run: async (s, a) => {
    const o = a || {};
    if (!o.done) throw new Error('wpJob needs args.done');
    if (o.click) await mustClick(s, o.click, 'Well Performance control');
    await until(s, () => s.page.evaluate((q) => !!document.querySelector(q), o.done), 'the Well Performance job (' + o.done + ')');
    await s.advance(500);
  } },
  metric: { clock: 'fixed', run: async (s, on) => {
    await s.page.evaluate((m) => { if (!window.WTS_units || typeof window.WTS_units.setSystem !== 'function') throw new Error('units layer missing'); window.WTS_units.setSystem(m ? 'metric' : 'imperial'); }, on !== false);
    await s.advance(300);
  } },
};

// ── Small helpers ────────────────────────────────────────────────────────
// WTS_appVersion() returns RELEASE_NOTES[0].ver, which already carries the 'v' ('v3.3'); add it only when missing.
const appVerOf = (v) => { const t = String(v == null ? '' : v).trim(); return !t ? '' : /^v/i.test(t) ? 'v' + t.slice(1) : 'v' + t; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) o[k] = stable(v[k]); }); return o; }
  return v;
}
const stableJSON = (v) => JSON.stringify(stable(v));
const viewsOf = (r) => (r.view === 'both' ? ['desktop', 'phone'] : [r.view === 'phone' ? 'phone' : 'desktop']);
const fileOf = (shot, view) => shot.folder + '/' + shot.stem + '-' + VIEWS[view].suffix + '.webp';

// WebP size from the RIFF header (VP8, VP8L, VP8X).
function webpSize(buf) {
  if (!buf || buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  return null;
}

// ── Content: load every help factory and list the shot recipes ───────────
function loadContent(win) {
  const H = win.WTS_help;
  if (H && typeof H.load === 'function') { try { H.load(); } catch (e) { throw new Error('WTS_help.load() failed: ' + e.message); } }
  const C = win.WTS_helpContent || { guides: {}, factories: [] };
  if (!(H && typeof H.load === 'function')) {
    // Before the Help page lands: run the factories here (same merge rule: a duplicate route is an error).
    const out = { guides: Object.assign({}, C.guides || {}) };
    (C.factories || []).forEach((f) => {
      const r = (f && typeof f.build === 'function') ? f.build() : {};
      Object.keys(r.guides || {}).forEach((k) => {
        if (out.guides[k]) throw new Error('guide "' + k + '" is defined twice (factory ' + (f.group || '?') + ')');
        out.guides[k] = r.guides[k];
      });
      ['start', 'tasks', 'course', 'scenarios', 'glossary', 'faq'].forEach((k) => { if (r[k] != null) out[k] = r[k]; });
    });
    return out;
  }
  return C;
}
function itemsOf(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  for (const k of ['exercises', 'scenarios', 'chapters', 'items', 'list']) if (Array.isArray(x[k])) return x[k];
  return Object.keys(x).sort().filter((k) => x[k] && typeof x[k] === 'object').map((k) => Object.assign({ id: k }, x[k]));
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// → [{folder, stem, route, recipe, where}]
function collectShots(content) {
  const out = [];
  const add = (folder, stem, route, recipe, where) => out.push({ folder, stem, route, recipe, where });
  const guides = content.guides || {};
  Object.keys(guides).sort().forEach((route) => {
    const g = guides[route] || {};
    (g.shots || []).forEach((r) => add(route, r && r.id, (r && r.route) || route, r, 'guide ' + route));
    (g.parts || []).forEach((p, i) => (p && p.shots || []).forEach((r) => add(route, r && r.id, (r && r.route) || route, r, 'guide ' + route + ' part ' + ((p && p.id) || i))));
  });
  itemsOf(content.course).forEach((ex, i) => {
    const pre = slug(ex.id || ('ex' + (i + 1)));
    (ex.shots || []).forEach((r) => add('course', pre + '-' + (r && r.id), (r && r.route) || 'wts', r, 'course ' + (ex.id || i)));
  });
  itemsOf(content.scenarios).forEach((sc, i) => {
    const pre = slug(sc.id || ('fs-' + (i + 1)));
    (sc.shots || []).forEach((r) => add('scenarios', pre + '-' + (r && r.id), (r && r.route) || 'wts', r, 'scenario ' + (sc.id || i)));
  });
  itemsOf(content.start).forEach((ch) => (ch.shots || []).forEach((r) => add('start', r && r.id, (r && r.route) || 'home', r, 'start ' + (ch.id || ch.title || ''))));
  return out;
}

// Recipe validation → list of error strings (no browser).
function validateShots(shots) {
  const errs = [];
  const seen = new Set();
  const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const FOLDER = /^[a-z0-9_]+$/;
  for (const s of shots) {
    const r = s.recipe, at = s.where + ' shot ' + (r && r.id);
    if (!r || typeof r !== 'object') { errs.push(s.where + ': shot is not an object'); continue; }
    if (!FOLDER.test(s.folder)) errs.push(at + ': bad folder ' + s.folder);
    if (typeof r.id !== 'string' || !ID.test(r.id) || r.id.length > 32) errs.push(at + ': id must be lower-case letters, digits and single dashes (≤ 32)');
    if (!ID.test(String(s.stem))) errs.push(at + ': bad file stem ' + s.stem);
    const key = s.folder + '/' + s.stem;
    if (seen.has(key)) errs.push(at + ': duplicate shot ' + key); seen.add(key);
    if (r.view != null && ['desktop', 'phone', 'both'].indexOf(r.view) < 0) errs.push(at + ': view must be desktop, phone or both');
    if (typeof r.alt !== 'string' || !r.alt.trim()) errs.push(at + ': alt text is empty');
    else if (r.alt.length > 200) errs.push(at + ': alt longer than 200 characters');
    if (typeof r.caption !== 'string' || !r.caption.trim()) errs.push(at + ': caption is empty');
    else if (r.caption.length > 160) errs.push(at + ': caption longer than 160 characters');
    if (r.target != null && (typeof r.target !== 'string' || !r.target.trim())) errs.push(at + ': target must be "viewport" or a selector');
    if (r.route != null && !/^[a-z][a-z0-9_]*$/.test(r.route)) errs.push(at + ': bad route ' + r.route);
    if (r.mask != null && !(Array.isArray(r.mask) && r.mask.every((m) => typeof m === 'string' && m.trim()))) errs.push(at + ': mask must be a list of selectors');
    (Array.isArray(r.setup) ? r.setup : r.setup == null ? [] : (errs.push(at + ': setup must be a list'), [])).forEach((op, i) => {
      const keys = op && typeof op === 'object' ? Object.keys(op).filter((k) => k !== 'args') : [];
      if (keys.length !== 1 || OPS.indexOf(keys[0]) < 0) { errs.push(at + ': setup[' + i + '] must hold exactly one of ' + OPS.join(', ')); return; }
      const k = keys[0], v = op[k];
      if ((k === 'set' || k === 'select') && !(v && typeof v === 'object' && Object.keys(v).length)) errs.push(at + ': setup[' + i + '].' + k + ' needs {selector: value}');
      if (['click', 'hover', 'scroll', 'waitFor', 'press', 'waitEvent'].indexOf(k) >= 0 && !(typeof v === 'string' && v)) errs.push(at + ': setup[' + i + '].' + k + ' needs a string');
      if (k === 'action' && !ACTIONS[v]) errs.push(at + ': unknown named action "' + v + '" (ask WP-S for new actions)');
      if (op.args !== undefined && k !== 'action') errs.push(at + ': setup[' + i + '] args only go with action');
    });
    if (r.callouts != null) {
      if (!Array.isArray(r.callouts)) errs.push(at + ': callouts must be a list');
      else {
        const ns = new Set();
        r.callouts.forEach((c, i) => {
          if (!c || typeof c.sel !== 'string' || !c.sel.trim()) errs.push(at + ': callouts[' + i + '] needs sel');
          if (!(c && Number.isInteger(c.n) && c.n >= 1 && c.n <= 9)) errs.push(at + ': callouts[' + i + '].n must be 1–9');
          else if (ns.has(c.n)) errs.push(at + ': call-out number ' + c.n + ' used twice'); else ns.add(c.n);
          if (c && c.at != null && c.at !== 'right') errs.push(at + ': callouts[' + i + '].at must be "right" (default: the top-left corner)');
        });
      }
    }
  }
  return errs;
}

function recipeHash(s) {
  const r = s.recipe;
  return sha256(stableJSON({ schema: RECIPE_SCHEMA, route: s.route, target: r.target || 'viewport', setup: r.setup || [], callouts: r.callouts || [],
    mask: r.mask || [], view: r.view || 'desktop' })).slice(0, 16);
}
function clockOf(s) {
  const acts = (s.recipe.setup || []).filter((o) => o && o.action).map((o) => ACTIONS[o.action] && ACTIONS[o.action].clock);
  return INSTALL_ROUTES.indexOf(s.route) >= 0 || acts.indexOf('install') >= 0 ? 'install' : 'fixed';
}
// Shots that need a real browser for their state (named actions, events) are checked by recipeHash only.
const browserOnly = (s) => (s.recipe.setup || []).some((o) => o && (o.action || o.waitEvent));

// ── Structural fingerprint in the jsdom harness (no browser) ─────────────
let _H = null;
function harness() { if (!_H) _H = require('./tests/_harness'); return _H; }
// The same seeded generator the browser shots install (captureOne), as source so both realms run identical code.
const SEEDED_RANDOM = 'let a = 0x9e3779b9; Math.random = function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); ' +
  't = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };';
// Harness globals for the fingerprint: a Math whose random() is the seeded generator (pages that build ids or labels
// from Math.random — 19-data-managers, 51-prism-workspace, 61-modbus-station — then fingerprint the same every run).
function harnessGlobals() {
  const M = Object.create(Math);
  new Function('Math', SEEDED_RANDOM)(M);   // eslint-disable-line no-new-func
  Object.getOwnPropertyNames(Math).forEach((k) => { if (k !== 'random') Object.defineProperty(M, k, Object.getOwnPropertyDescriptor(Math, k)); });
  return { Math: M };
}
function seedStrings() { const o = {}; Object.keys(SEED).forEach((k) => { o[k] = typeof SEED[k] === 'string' ? SEED[k] : JSON.stringify(SEED[k]); }); return o; }

function serialise(app, el) {
  const out = [];
  const walk = (n, depth) => {
    if (!n) return;
    if (n.nodeType === 3) { const t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim(); if (t) out.push(depth + '"' + t); return; }
    if (n.nodeType !== 1) return;
    const tag = String(n.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return;
    if (n.getAttribute('hidden') != null || (n.style && n.style.display === 'none')) return;
    // the web-only account hosts (docs/ACCOUNTS-PLAN.md H8 / H9, ACCT markers) are never part of a shot
    if (n.id === 'wts_account_host' || n.id === 'sbAccountLine') return;
    // nor are the web-only release-notes items (li.rn-web, docs/ACCOUNTS-PLAN.md H12)
    if (/(^|\s)rn-web(\s|$)/.test(String(n.className || ''))) return;
    const cls = String(n.className || '').split(/\s+/).filter(Boolean).sort().join('.');
    let line = depth + '<' + tag + (n.id ? '#' + n.id : '') + (cls ? '.' + cls : '');
    if (tag === 'input' || tag === 'select' || tag === 'textarea') line += ' =' + String(n.value == null ? '' : n.value);
    if (tag === 'canvas') { try { line += ' text:' + app.canvasTexts(n).join('|'); } catch (e) { /* not recorded */ } }
    out.push(line);
    const kids = n.childNodes || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + ' ');
  };
  walk(el, '');
  return out.join('\n');
}

// → { fp, fpBox } or { fp: 'browser' }; throws when the target is missing.
function fingerprint(s, view, opts) {
  if (browserOnly(s)) return { fp: 'browser', fpBox: null };
  const H = harness();
  // Same date as the shots (startTime = TIME) and the seeded Math.random. fpBox is the HARNESS layout box (its
  // defaults, 900×420, or inline px sizes), not the browser's: it only catches a change in declared sizes.
  const app = H.loadApp(Object.assign({ fromSources: true, silentBuild: true, viewport: VIEWS[view].viewport, storage: H.createStorage(seedStrings()),
    startTime: Date.parse(TIME), globals: harnessGlobals() },
    opts && opts.html ? { html: opts.html } : opts && opts.sourceOverrides ? { sourceOverrides: opts.sourceOverrides } : {}));
  try {
    const ae = { allowErrors: true };
    app.hook.nav(s.route); app.flush(500);
    for (const op of s.recipe.setup || []) {
      if (op.set) Object.keys(op.set).forEach((q) => { const e = app.find(q); if (!e) throw new Error('set: no element ' + q); app.input(e, String(op.set[q]), ae); });
      else if (op.select) Object.keys(op.select).forEach((q) => { const e = app.find(q); if (!e) throw new Error('select: no element ' + q); app.select(e, String(op.select[q]), ae); });
      else if (op.click) { const e = app.find(op.click); if (!e) throw new Error('click: no element ' + op.click); app.click(e, ae); }
      else if (op.waitFor) { app.flush(250); if (!app.find(op.waitFor)) throw new Error('waitFor: no element ' + op.waitFor); }
      app.flush(100);
    }
    app.flush(500);
    const el = isViewport(s.recipe.target) ? app.find('#pgBody') : app.find(s.recipe.target);
    if (!el) throw new Error('target not found in the page: ' + s.recipe.target);
    const head = isViewport(s.recipe.target) ? String((app.find('#pgTitle') || {}).textContent || '') + '\n' : '';
    const b = el.getBoundingClientRect();
    return { fp: sha256(head + serialise(app, el)).slice(0, 16), fpBox: [Math.round(b.width), Math.round(b.height)] };
  } finally { try { app.dispose(); } catch (e) { /* ignore */ } }
}

// ── Manifest ↔ module ────────────────────────────────────────────────────
function emptyManifest() { return { schema: SCHEMA, platform: 'linux-container', chromium: null, fonts: [], files: [] }; }
function readManifest(dir) {
  const f = path.join(dir || IMG_DIR, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function manifestText(m) {
  const files = (m.files || []).slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)).map((e) => {
    const o = {}; ['file', 'route', 'shot', 'view', 'w', 'h', 'bytes', 'sha256', 'recipeHash', 'fp', 'fpBox', 'view3d', 'appVer'].forEach((k) => { if (e[k] !== undefined) o[k] = e[k]; });
    return o;
  });
  const head = { schema: m.schema || SCHEMA, platform: m.platform || 'linux-container', chromium: m.chromium || null, fonts: (m.fonts || []).slice().sort() };
  return '{\n' + Object.keys(head).map((k) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(head[k])).join(',\n') + ',\n  "files": [' +
    (files.length ? '\n' + files.map((e) => '    ' + JSON.stringify(e)).join(',\n') + '\n  ' : '') + ']\n}\n';
}
// The GENERATED data module (route → "stem-v w h hash8" list), byte-stable for a given manifest.
function moduleSource(m) {
  const by = {};
  (m.files || []).forEach((e) => {
    const parts = /^([a-z0-9_]+)\/([a-z0-9-]+)\.webp$/.exec(e.file);
    if (!parts) return;
    (by[parts[1]] = by[parts[1]] || []).push(parts[2] + ' ' + e.w + ' ' + e.h + ' ' + String(e.sha256 || '').slice(0, 8));
  });
  const routes = Object.keys(by).sort();
  const data = routes.length ? '{\n' + routes.map((r) => '    ' + JSON.stringify(r) + ': ' + JSON.stringify(by[r].sort().join(','))).join(',\n') + '\n  }' : '{}';
  const n = (m.files || []).length, bytes = (m.files || []).reduce((a, e) => a + (+e.bytes || 0), 0);
  return [
    '// prism-build/48-calc-help-manifest.js — GENERATED by help-shots.js — never edit by hand.',
    '// The Help screenshot manifest (help/img/manifest.json) as data, so the Help page needs no fetch (it works on',
    '// file:// too). Per folder: "<shot>-<d|p> <w> <h> <first 8 hex of sha256>". Data module only: it adds no',
    '// WTS_calcRegistry entry. Regenerate with: node prism-build/help-shots.js (any capture run) — checked by --check.',
    '(function () {',
    "  'use strict';",
    "  var G = (typeof window !== 'undefined') ? window : globalThis;",
    '  var D = ' + data + ';',
    '  var M = G.WTS_helpManifest = G.WTS_helpManifest || {};',
    '  M.count = ' + n + ';',
    '  M.bytes = ' + bytes + ';   // total size of the image files (the offline download label)',
    '  M.data = D;',
    "  M.base = 'help/img/';",
    '  // get(folder, shot, view) → {file, src, w, h, v} or null; view "desktop" | "phone"; base overrides M.base',
    '  M.get = function (folder, shot, view, base) {',
    "    var list = D[folder]; if (!list) return null;",
    "    var stem = shot + (view === 'phone' ? '-p' : '-d'), rows = list.split(',');",
    '    for (var i = 0; i < rows.length; i++) {',
    "      var f = rows[i].split(' ');",
    '      if (f[0] === stem) {',
    "        var file = folder + '/' + stem + '.webp';",
    "        return { file: file, src: (base == null ? M.base : base) + file + '?v=' + f[3], w: +f[1], h: +f[2], v: f[3] };",
    '      }',
    '    }',
    '    return null;',
    '  };',
    '  // list(folder) → the shot ids (without the view suffix) that have at least one file',
    '  M.list = function (folder) {',
    "    var list = D[folder], seen = {}, out = []; if (!list) return out;",
    "    list.split(',').forEach(function (r) { var s = r.split(' ')[0].replace(/-[dp]$/, ''); if (!seen[s]) { seen[s] = 1; out.push(s); } });",
    '    return out;',
    '  };',
    '  G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };',
    '  G.WTS_helpContent.manifest = M;',
    '})();',
    '// === SELF-TEST ===',
    '(function () {',
    "  var G = (typeof window !== 'undefined') ? window : globalThis, M = G.WTS_helpManifest;",
    "  if (!M || typeof M.get !== 'function' || M.get('', '', 'desktop') !== null) console.warn('[WTS] help manifest self-test failed');",
    '})();',
    '',
  ].join('\n');
}

// ── --check (no browser) ─────────────────────────────────────────────────
// opts: { imgDir, moduleFile, sourceOverrides, fingerprints (default true), content (pre-loaded) }
// → { ok, errors[], warnings[], stale[], orphans[], expected[], manifest }
function check(opts) {
  opts = opts || {};
  const imgDir = opts.imgDir || IMG_DIR;
  const moduleFile = opts.moduleFile || MODULE_FILE;
  const errors = [], warnings = [], stale = [], orphans = [];
  let content = opts.content;
  if (opts.sourceOverrides && !opts.html) opts = Object.assign({}, opts, { html: harness().buildFromSources({ silent: true, overrides: opts.sourceOverrides }).html });
  if (!content) {
    const H = harness();
    const app = H.loadApp(Object.assign({ fromSources: true, silentBuild: true, storage: H.createStorage(seedStrings()) }, opts.html ? { html: opts.html } : {}));
    try { content = loadContent(app.win); } finally { try { app.dispose(); } catch (e) { /* ignore */ } }
  }
  const shots = collectShots(content);
  validateShots(shots).forEach((e) => errors.push(e));
  const expected = [];
  shots.forEach((s) => { if (s.recipe && typeof s.recipe === 'object') viewsOf(s.recipe).forEach((v) => expected.push({ shot: s, view: v, file: fileOf(s, v) })); });
  const m = readManifest(imgDir);
  if (!m) errors.push('help/img/manifest.json is missing (run help-shots.js)');
  const man = m || emptyManifest();
  if (m && manifestText(m) !== fs.readFileSync(path.join(imgDir, 'manifest.json'), 'utf8')) errors.push('manifest.json is not in the tool\'s stable form (regenerate it)');
  const byFile = new Map((man.files || []).map((e) => [e.file, e]));
  const want = new Set(expected.map((x) => x.file));
  // module
  const modSrc = fs.existsSync(moduleFile) ? fs.readFileSync(moduleFile, 'utf8') : null;
  if (modSrc == null) errors.push(MODULE_NAME + ' is missing');
  else if (modSrc !== moduleSource(man)) errors.push(MODULE_NAME + ' differs from what manifest.json generates (run help-shots.js)');
  if (modSrc != null && Buffer.byteLength(modSrc) > CAPS.moduleBytes) errors.push(MODULE_NAME + ' is ' + Buffer.byteLength(modSrc) + ' bytes, over its ' + CAPS.moduleBytes + '-byte cap');
  // files on disk
  const onDisk = [];
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; fs.readdirSync(d).sort().forEach((n) => { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.statSync(p).isDirectory()) walk(p, r); else if (r !== 'manifest.json' && r !== MODULE_NAME) onDisk.push(r); }); };
  walk(imgDir, '');
  onDisk.forEach((f) => { if (!want.has(f)) { orphans.push(f); errors.push('orphan file help/img/' + f + ' (in no recipe; delete it with --prune)'); } });
  byFile.forEach((e, f) => { if (!want.has(f)) errors.push('manifest entry ' + f + ' matches no recipe'); });
  let total = 0, count = 0;
  for (const x of expected) {
    const e = byFile.get(x.file), p = path.join(imgDir, x.file);
    if (!e) { errors.push('shot ' + x.file + ' has no manifest entry (run help-shots.js --route ' + x.shot.folder + ')'); continue; }
    if (!fs.existsSync(p)) { errors.push('shot ' + x.file + ' is in the manifest but the file is missing'); continue; }
    const buf = fs.readFileSync(p);
    total += buf.length; count++;
    const dim = webpSize(buf);
    if (!dim) errors.push(x.file + ' is not a WebP image');
    else if (dim.w !== e.w || dim.h !== e.h) errors.push(x.file + ' is ' + dim.w + '×' + dim.h + ', the manifest says ' + e.w + '×' + e.h);
    if (buf.length !== e.bytes) errors.push(x.file + ' is ' + buf.length + ' bytes, the manifest says ' + e.bytes);
    if (sha256(buf) !== e.sha256) errors.push(x.file + ' sha256 differs from the manifest');
    if (e.route !== x.shot.folder || e.shot !== x.shot.stem || e.view !== x.view) errors.push(x.file + ': manifest route/shot/view do not match the file name');
    const cap = capFor(x.view, x.shot.recipe.target);
    if (buf.length > cap) errors.push(x.file + ' is ' + buf.length + ' bytes, over its ' + cap + '-byte cap');
    if (e.recipeHash !== recipeHash(x.shot)) stale.push({ file: x.file, why: 'recipe changed' });
    else if (opts.fingerprints !== false && e.fp !== 'browser') {
      let f = null;
      try { f = fingerprint(x.shot, x.view, opts); } catch (err) { errors.push('shot ' + x.shot.folder + '/' + x.shot.recipe.id + ' (' + x.view + '): ' + err.message); continue; }
      if (f.fp === 'browser') stale.push({ file: x.file, why: 'recipe now needs a browser' });
      else if (f.fp !== e.fp || stableJSON(f.fpBox) !== stableJSON(e.fpBox)) stale.push({ file: x.file, why: 'page changed (structural fingerprint)' });
    }
  }
  if (total > CAPS.totalBytes) errors.push('all images ' + total + ' bytes, over the ' + CAPS.totalBytes + '-byte cap');
  if (count > CAPS.files) errors.push(count + ' image files, over the ' + CAPS.files + '-file cap');
  stale.forEach((x) => errors.push('shot ' + x.file.replace(/-[dp]\.webp$/, '') + ' is stale (' + x.why + '): run help-shots --changed'));
  return { ok: !errors.length, errors, warnings, stale, orphans, expected: expected.map((x) => x.file), manifest: man, totalBytes: total, files: count };
}

// ── Capture (browser) ────────────────────────────────────────────────────
function fontFamilies() {
  try {
    const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Array.from(new Set(out.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))).sort();
  } catch (e) { return []; }
}

// A canvas page in its own context: PNG → WebP, and pixel differences for --changed.
async function encoder(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<!doctype html><title>encoder</title>');
  const load = 'function load(u){return new Promise(function(ok,no){var i=new Image();i.onload=function(){ok(i)};i.onerror=function(){no(new Error("decode failed"))};i.src=u;});}';
  return {
    async webp(png, q, scale) {
      return page.evaluate(([b64, quality, sc, L]) => {
        const load = new Function(L + ';return load;')();   // eslint-disable-line no-new-func
        return load('data:image/png;base64,' + b64).then((img) => {
          const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h);
          const u = c.toDataURL('image/webp', quality);
          if (u.indexOf('data:image/webp') !== 0) throw new Error('this browser cannot encode WebP');
          return { b64: u.slice(u.indexOf(',') + 1), w, h };
        });
      }, [png.toString('base64'), q, scale || 1, load]);
    },
    // → {mean, block} fractions (0..1), or null when sizes differ
    async diff(webpA, webpB) {
      return page.evaluate(([a, b, L]) => {
        const load = new Function(L + ';return load;')();   // eslint-disable-line no-new-func
        return Promise.all([load('data:image/webp;base64,' + a), load('data:image/webp;base64,' + b)]).then(([ia, ib]) => {
          if (ia.naturalWidth !== ib.naturalWidth || ia.naturalHeight !== ib.naturalHeight) return null;
          const w = ia.naturalWidth, h = ia.naturalHeight;
          const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
          const A = px(ia), B = px(ib);
          let sum = 0, block = 0;
          const bw = Math.ceil(w / 16), bh = Math.ceil(h / 16), bs = new Float64Array(bw * bh), bn = new Float64Array(bw * bh);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 765;
            sum += d; const k = ((y >> 4) * bw) + (x >> 4); bs[k] += d; bn[k]++;
          }
          for (let k = 0; k < bs.length; k++) if (bn[k]) block = Math.max(block, bs[k] / bn[k]);
          return { mean: sum / (w * h), block };
        });
      }, [webpA.toString('base64'), webpB.toString('base64'), load]);
    },
    close: () => ctx.close(),
  };
}

// Glyph probe: ✓ ⚠ ✗ and a digit must not render as the missing-glyph box (or as nothing).
async function glyphProbe(page) {
  return page.evaluate(() => {
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const draw = (ch) => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 40, 40); x.fillStyle = '#000';
      x.font = '28px ' + fam; x.textBaseline = 'middle'; x.fillText(ch, 4, 20);
      return Array.from(x.getImageData(0, 0, 40, 40).data).join(',');
    };
    const blank = draw(' '), tofu = draw(String.fromCodePoint(0x10FFFD));
    return ['✓', '⚠', '✗', '7'].filter((ch) => { const d = draw(ch); return d === tofu || d === blank; });
  });
}

async function applyOps(s, shot) {
  const page = s.page;
  for (const op of shot.recipe.setup || []) {
    if (op.set || op.select) {
      const kv = op.set || op.select;
      for (const q of Object.keys(kv)) {
        const ok = await page.evaluate(([sel, v]) => {
          const e = document.querySelector(sel); if (!e) return false;
          e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, [q, String(kv[q])]);
        if (!ok) throw new Error((op.set ? 'set' : 'select') + ': no element ' + q);
      }
    } else if (op.click) { if (!(await page.evaluate((q) => { const e = document.querySelector(q); if (e) e.click(); return !!e; }, op.click))) throw new Error('click: no element ' + op.click); }
    else if (op.press) await page.keyboard.press(op.press);
    else if (op.hover) await page.hover(op.hover, { timeout: 5000 });
    else if (op.scroll) await page.evaluate((q) => { const e = document.querySelector(q); if (!e) throw new Error('scroll: no element ' + q); e.scrollIntoView({ block: 'start' }); }, op.scroll);
    else if (op.waitFor) await until(s, () => page.evaluate((q) => !!document.querySelector(q), op.waitFor), 'waitFor ' + op.waitFor, 15000);
    else if (op.waitEvent) {
      await page.evaluate((n) => { window.__hsEv = window.__hsEv || {}; const f = () => { window.__hsEv[n] = true; }; document.addEventListener(n, f, { once: true }); window.addEventListener(n, f, { once: true }); }, op.waitEvent);
      await until(s, () => page.evaluate((n) => !!(window.__hsEv && window.__hsEv[n]), op.waitEvent), 'event ' + op.waitEvent, 120000);
    } else if (op.action) await ACTIONS[op.action].run(s, op.args);
    if (s.render) await s.render();
    await s.advance(100);
  }
}

// Masks and call-outs: a temporary style plus numbered markers (CSS circle, ASCII digit) next to each selector.
async function decorate(s, shot) {
  const masks = DEFAULT_MASK.concat(shot.recipe.mask || []);
  return s.page.evaluate(([mk, cos]) => {
    const st = document.createElement('style'); st.id = '__hs_style';
    // the web-only account controls (docs/ACCOUNTS-PLAN.md §9) never appear in a shot: the shots are copied to the iOS bundle
    st.textContent = mk.join(',') + '{visibility:hidden!important}*{caret-color:transparent!important}' +
      '#wts_account_host,#sbAccountLine,.acct-sync-bar,.acct-ov,.acct-toast,li.rn-web{display:none!important}' +
      '.__hs_co{position:fixed;z-index:2147483647;width:22px;height:22px;box-sizing:border-box;border-radius:50%;background:#ffb300;color:#111;' +
      'border:2px solid #111;font:700 13px/18px sans-serif;text-align:center;pointer-events:none;box-shadow:0 0 0 2px #ffb300}';
    document.head.appendChild(st);
    const bad = [], boxes = [];
    cos.forEach((c) => {
      const el = Array.from(document.querySelectorAll(c.sel)).find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(e).visibility !== 'hidden';
      });
      if (!el) { bad.push(c.sel); return; }
      const r = el.getBoundingClientRect(), m = document.createElement('div');
      m.className = '__hs_co'; m.textContent = String(c.n);
      // at:'right' — inside the right end, centred on the line, so a full-width verdict line keeps its glyph visible
      const R = c.at === 'right', ml = Math.max(0, Math.min(innerWidth - 22, R ? r.right - 30 : r.left - 11)),
        mt = Math.max(0, Math.min(innerHeight - 22, R ? r.top + r.height / 2 - 11 : r.top - 11));
      m.style.left = ml + 'px'; m.style.top = mt + 'px';
      document.body.appendChild(m);
      // the 2 px amber ring (box-shadow) lies outside the 22 px box
      boxes.push({ n: c.n, sel: c.sel, el: { l: r.left, t: r.top, r: r.right, b: r.bottom }, m: { l: ml - 2, t: mt - 2, r: ml + 24, b: mt + 24 } });
    });
    return { bad, boxes, vw: innerWidth, vh: innerHeight };
  }, [masks, shot.recipe.callouts || []]);
}

// The crop for an element shot: the target's box + 8 px, grown to hold every call-out marker, clipped to the viewport.
// → { clip, errors[], warnings[] }. A call-out whose element lies outside the padded target, or whose marker does not
// fit in the final clip, is an error (it would not appear in the image). A target larger than the viewport is a warning
// (the image is cut at the viewport edge: target a smaller element, e.g. one .rbox).
function cropFor(target, rect, deco) {
  const P = 8, errors = [], warnings = [];
  const box = { l: rect.l - P, t: rect.t - P, r: rect.r + P, b: rect.b + P };
  const vw = rect.vw, vh = rect.vh;
  if (rect.l < 0 || rect.t < 0 || rect.r > vw || rect.b > vh) {
    warnings.push('target ' + target + ' (' + Math.round(rect.r - rect.l) + '×' + Math.round(rect.b - rect.t) + ') does not fit the ' + vw + '×' + vh +
      ' viewport: the image is cut at the viewport edge — target a smaller element');
  }
  const u = Object.assign({}, box);
  ((deco && deco.boxes) || []).forEach((c) => {
    const inside = c.el.r > box.l && c.el.l < box.r && c.el.b > box.t && c.el.t < box.b;
    if (!inside) { errors.push('call-out ' + c.n + ' (' + c.sel + ') is outside the target ' + target); return; }
    u.l = Math.min(u.l, c.m.l); u.t = Math.min(u.t, c.m.t); u.r = Math.max(u.r, c.m.r); u.b = Math.max(u.b, c.m.b);
  });
  const x0 = Math.max(0, Math.floor(u.l)), y0 = Math.max(0, Math.floor(u.t)), x1 = Math.min(vw, Math.ceil(u.r)), y1 = Math.min(vh, Math.ceil(u.b));
  if (x1 - x0 < 4 || y1 - y0 < 4) { errors.push('target is not visible: ' + target); return { clip: null, errors, warnings }; }
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  ((deco && deco.boxes) || []).forEach((c) => {
    if (errors.some((e) => e.indexOf('call-out ' + c.n + ' ') === 0)) return;
    if (c.m.l < x0 - 2 || c.m.t < y0 - 2 || c.m.r > x1 + 2 || c.m.b > y1 + 2) errors.push('call-out ' + c.n + ' (' + c.sel + ') falls outside the cropped image');
  });
  return { clip, errors, warnings };
}

// One (shot, view) in a fresh context → { png, view3d }.
async function captureOne(browser, base, shot, view, opts) {
  const S = require('./pw-session');
  const V = VIEWS[view];
  const s = await S.freshSession(browser, {
    base, viewport: V.viewport, scale: V.scale, phone: V.phone, seed: SEED, contextOptions: CONTEXT,
    clock: { mode: clockOf(shot), time: TIME },
    initScripts: [{ fn: (src) => { new Function('Math', src)(Math); }, arg: SEEDED_RANDOM }],   // seeded Math.random (eslint-disable-line no-new-func)
  });
  try {
    await S.navTo(s, shot.route);
    await applyOps(s, shot);
    const target = shot.recipe.target;
    let clip = null, rect = null;
    const warnings = [];
    if (!isViewport(target)) {
      // scroll first: the call-out markers are position:fixed, placed after the page stops moving
      rect = await s.page.evaluate((q) => {
        const e = document.querySelector(q); if (!e) return null;
        e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const b = e.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom, vw: innerWidth, vh: innerHeight };
      }, target);
      if (!rect) throw new Error('target not found: ' + target);
    }
    const deco = await decorate(s, shot);
    if (deco.bad.length) throw new Error('call-out selector not visible in the ' + view + ' view: ' + deco.bad.join(', '));
    if (rect) {
      const c = cropFor(target, rect, deco);
      if (c.errors.length) throw new Error(c.errors.join('; '));
      c.warnings.forEach((w) => warnings.push(w));
      if (opts && opts.strict && warnings.length) throw new Error(warnings.join('; ') + ' (--strict)');
      clip = c.clip;
    }
    await s.advance(32);   // two animation frames
    const png = await s.page.screenshot(Object.assign({ fullPage: false, animations: 'disabled', caret: 'hide', type: 'png', timeout: 90000 }, clip ? { clip } : {}));
    const errs = s.errors.slice();
    return { png, view3d: s.view3d, errors: errs, warnings };
  } finally { await s.close(); }
}

async function encodeCapped(enc, png, view, target) {
  const cap = capFor(view, target);
  const tries = [[VIEWS[view].q, 1], [0.65, 1], [0.65, 0.85], [0.65, 0.85 * 0.85]];
  let last = null;
  for (const [q, sc] of tries) {
    const r = await enc.webp(png, q, sc);
    const buf = Buffer.from(r.b64, 'base64');
    last = { buf, w: r.w, h: r.h };
    if (buf.length <= cap) return last;
  }
  throw new Error('over its ' + cap + '-byte cap even at q 0.65 and two downscales (' + last.buf.length + ' bytes)');
}

function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const arg = (f, d) => { const i = argv.lastIndexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const all = (f) => { const out = []; argv.forEach((a, i) => { if (a === f && argv[i + 1]) out.push(argv[i + 1]); }); return out; };
  const out = arg('--out', null);
  return {
    all: has('--all'), changed: has('--changed'), check: has('--check'), prune: has('--prune'), verbose: has('--verbose'), strict: has('--strict'),
    html: has('--html'), phoneOnly: has('--phone-only'), desktopOnly: has('--desktop-only'),
    routes: all('--route').join(',').split(',').map((x) => x.trim()).filter(Boolean),
    workers: Math.max(1, parseInt(arg('--workers', '4'), 10) || 4),
    keepPng: arg('--keep-png', null),
    imgDir: out ? path.resolve(out) : IMG_DIR,
    moduleFile: arg('--module', null) ? path.resolve(arg('--module')) : (out ? path.join(path.resolve(out), MODULE_NAME) : MODULE_FILE),
    content: all('--content').map((f) => path.resolve(f)),
  };
}
function overridesFor(files) {
  if (!files || !files.length) return null;
  const o = {};
  files.forEach((f, i) => { o['48-calc-help-zz-extra' + (i ? i : '') + '.js'] = fs.readFileSync(f, 'utf8'); });
  return o;
}
function writeOutputs(imgDir, moduleFile, man) {
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, 'manifest.json'), manifestText(man));
  fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
  fs.writeFileSync(moduleFile, moduleSource(man));
}

async function capture(o) {
  const H = harness();
  const sourceOverrides = overridesFor(o.content);
  const build = H.buildFromSources({ silent: true, overrides: sourceOverrides || undefined });
  const app = H.loadApp({ html: build.html, storage: H.createStorage(seedStrings()) });
  let content, appVer = '';
  try { content = loadContent(app.win); appVer = typeof app.win.WTS_appVersion === 'function' ? appVerOf(app.win.WTS_appVersion()) : ''; }
  finally { try { app.dispose(); } catch (e) { /* ignore */ } }
  const shots = collectShots(content);
  const verr = validateShots(shots);
  if (verr.length) { verr.forEach((e) => console.error('[help-shots] ' + e)); return 1; }
  const man = readManifest(o.imgDir) || emptyManifest();
  const byFile = new Map((man.files || []).map((e) => [e.file, e]));
  // which (shot, view) jobs
  let jobs = [];
  shots.forEach((s) => viewsOf(s.recipe).forEach((v) => {
    if ((o.phoneOnly && v !== 'phone') || (o.desktopOnly && v !== 'desktop')) return;
    if (o.routes.length && o.routes.indexOf(s.folder) < 0) return;
    jobs.push({ shot: s, view: v, file: fileOf(s, v) });
  }));
  if (o.routes.length) o.routes.forEach((r) => { if (!shots.some((s) => s.folder === r)) console.warn('[help-shots] no recipes for ' + r); });
  if (o.changed) {
    const flagged = new Set(check({ imgDir: o.imgDir, moduleFile: o.moduleFile, content, html: build.html }).stale.map((x) => x.file));
    jobs = jobs.filter((j) => flagged.has(j.file) || !byFile.has(j.file) || !fs.existsSync(path.join(o.imgDir, j.file)));
  }
  const want = new Set();
  shots.forEach((s) => viewsOf(s.recipe).forEach((v) => want.add(fileOf(s, v))));
  const orphanEntries = (man.files || []).filter((e) => !want.has(e.file)).map((e) => e.file);
  const pw = require('./pw-session').loadPlaywright();
  if (!pw && jobs.length) { console.log('[skip] Playwright is not installed — no shots taken (help-shots --check needs no browser)'); return 0; }
  let failed = 0;
  if (jobs.length) {
    const S = require('./pw-session');
    const srv = await S.startServer({ pageHtml: o.html ? undefined : build.html });
    const browser = await S.launch(pw);
    try {
      man.chromium = browser.version();
      man.fonts = fontFamilies();
      man.platform = 'linux-container';
      // glyph probe once, in the fixed desktop environment
      const p0 = await S.freshSession(browser, { base: srv.base, viewport: VIEWS.desktop.viewport, seed: SEED, contextOptions: CONTEXT, clock: { mode: 'fixed', time: TIME } });
      const missing = await glyphProbe(p0.page); await p0.close();
      if (missing.length) { console.error('[help-shots] glyph probe: ' + missing.join(' ') + ' render as the missing-glyph box — install fonts first'); return 1; }
      const enc = await encoder(browser);
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const j = jobs[next++];
          const tag = j.file;
          try {
            const r = await captureOne(browser, srv.base, j.shot, j.view, { strict: o.strict });
            r.warnings.forEach((w) => console.warn('[warn] ' + tag + ': ' + w));
            if (o.keepPng) { const kp = path.join(path.resolve(o.keepPng), j.file.replace(/\.webp$/, '.png')); fs.mkdirSync(path.dirname(kp), { recursive: true }); fs.writeFileSync(kp, r.png); }
            const img = await encodeCapped(enc, r.png, j.view, j.shot.recipe.target);
            const f = fingerprint(j.shot, j.view, { html: build.html });
            const dest = path.join(o.imgDir, j.file);
            const prev = byFile.get(j.file);
            let buf = img.buf, w = img.w, h = img.h, kept = false;
            if (o.changed && prev && fs.existsSync(dest)) {
              const old = fs.readFileSync(dest);
              const d = await enc.diff(old, img.buf);
              if (d && d.mean <= 0.005 && d.block <= 0.08) { buf = old; const sz = webpSize(old); w = sz.w; h = sz.h; kept = true; }
            }
            if (!kept) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
            const e = { file: j.file, route: j.shot.folder, shot: j.shot.stem, view: j.view, w, h, bytes: buf.length, sha256: sha256(buf),
              recipeHash: recipeHash(j.shot), fp: f.fp, fpBox: f.fpBox, appVer };
            if (r.view3d === false) e.view3d = false;
            byFile.set(j.file, e);
            console.log((kept ? '[same] ' : '[shot] ') + tag + ' ' + w + '×' + h + ' ' + buf.length + ' B' + (r.errors.length && o.verbose ? ' (page errors: ' + r.errors.length + ')' : ''));
          } catch (err) { failed++; console.error('[fail] ' + tag + ': ' + (err && err.message)); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(o.workers, jobs.length) }, worker));
      await enc.close();
    } finally { await browser.close(); await srv.close(); }
  }
  {
    // orphans: report, and delete with --prune
    const onDisk = [];
    const walk = (d, rel) => { if (!fs.existsSync(d)) return; fs.readdirSync(d).sort().forEach((n) => { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.statSync(p).isDirectory()) walk(p, r); else if (r !== 'manifest.json' && r !== MODULE_NAME) onDisk.push(r); }); };
    walk(o.imgDir, '');
    const orph = Array.from(new Set(onDisk.filter((f) => !want.has(f)).concat(orphanEntries))).sort();
    orph.forEach((f) => {
      if (o.prune) { const p = path.join(o.imgDir, f); if (fs.existsSync(p)) fs.unlinkSync(p); byFile.delete(f); console.log('[prune] ' + f); }
      else console.warn('[orphan] ' + f + ' (in no recipe; --prune deletes it)');
    });
  }
  man.files = Array.from(byFile.values());
  writeOutputs(o.imgDir, o.moduleFile, man);
  const tot = man.files.reduce((a, e) => a + (e.bytes || 0), 0);
  console.log('[help-shots] ' + jobs.length + ' job(s), ' + failed + ' failed; manifest ' + man.files.length + ' file(s), ' + tot + ' bytes');
  if (tot > CAPS.totalBytes || man.files.length > CAPS.files) { console.error('[help-shots] over the total cap (' + CAPS.totalBytes + ' bytes, ' + CAPS.files + ' files)'); return 1; }
  return failed ? 1 : 0;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.check) {
    const r = check({ imgDir: o.imgDir, moduleFile: o.moduleFile, sourceOverrides: overridesFor(o.content) || undefined });
    r.errors.forEach((e) => console.error('[check] ' + e));
    console.log('[help-shots --check] ' + r.expected.length + ' expected file(s), ' + r.files + ' present, ' + r.totalBytes + ' bytes; ' +
      (r.ok ? 'ok' : r.errors.length + ' problem(s)'));
    return r.ok ? 0 : 1;
  }
  if (!o.all && !o.routes.length && !o.changed) {
    console.log('usage: node prism-build/help-shots.js --all | --route a,b | --changed | --check  [--phone-only|--desktop-only] [--workers n] [--prune] [--keep-png dir] [--strict] [--out dir] [--module file] [--content file.js] [--html] [--verbose]');
    return 2;
  }
  return capture(o);
}

module.exports = { VIEWS, CAPS, SEED, TIME, OPS, ACTIONS, INSTALL_ROUTES, RECIPE_SCHEMA, IMG_DIR, MODULE_FILE,
  loadContent, collectShots, validateShots, recipeHash, clockOf, browserOnly, fingerprint, serialise, webpSize,
  emptyManifest, readManifest, manifestText, moduleSource, check, capFor, fileOf, viewsOf, parseArgs, main,
  appVerOf, cropFor, harnessGlobals, DEFAULT_MASK };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error('[help-shots] tool error: ' + (e && e.stack || e)); process.exit(2); });
}
