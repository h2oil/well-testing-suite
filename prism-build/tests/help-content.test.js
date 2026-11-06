// Help content validator (docs/HELP-GUIDE-PLAN.md §7.1, WP-H milestone H0).
//
// Validates every guide and the other Help content against the live app: coverage of the live route
// set (per content file present, then all), sections, DOM drift (ids, labels, unit categories, shot
// selectors), reverse coverage (page → guide), verdict coverage, bold phrases, worked examples,
// reviewedSrc (page changed since review), markup subset, links, glossary first use, names and
// addresses, text limits and the byte caps of §3.6. The model guide (tests/_help-model.js) passes the
// same checks, and negative cases prove each check bites.
//
//   node prism-build/tests/help-content.test.js --hash <route>[,<route>…]   print reviewedSrc values
//
// Optional: WTS_HELP_DENYLIST=<file outside the repository> — one name per line, matched as words.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const MODEL = require('./_help-model');

const WP = 'HELP';
const BUILD = path.resolve(__dirname, '..');
const REPO = path.resolve(BUILD, '..');
const GROUP_LABEL = {
  overview: 'Overview', metering: 'Metering & Chokes', welltest: 'Well Test & Flowlines', production: 'Production & Reservoir',
  livedata: 'Live Data', safety: 'Test System Safety', process: 'Separation & Process', flare: 'Flare & Relief', utilities: 'Fluids & Utilities',
};
const CONTENT_FILES = ['start', 'overview', 'metering', 'welltest', 'simcourse', 'production', 'livedata', 'safety', 'process', 'flare', 'utilities']
  .map((g) => '48-calc-help-' + g + '.js');
const KB = 1000;
const CAPS = {
  '49-calc-help.js': 45, '49-calc-help-print.js': 15, '48-calc-help-start.js': 26, '48-calc-help-overview.js': 10,
  '48-calc-help-metering.js': 28, '48-calc-help-welltest.js': 32, '48-calc-help-production.js': 32, '48-calc-help-livedata.js': 16,
  '48-calc-help-safety.js': 28, '48-calc-help-process.js': 20, '48-calc-help-flare.js': 12, '48-calc-help-utilities.js': 20,
  '48-calc-help-simcourse.js': 38, '48-calc-help-manifest.js': 8,
};
const SUM_CAP = 330 * KB, GZIP_CAP = 90 * KB;
const NOT_ROUTES = ['gaevents', 'dca', 'pta'];
const OVERVIEW = ['home', 'help', 'clientinfo', 'wells', 'privacy', 'releasenotes'];
// §4.1: manual examples only for the simulator, PRiSM fits, Live Data and Overview (buildup and cheminj have pure engines)
const MANUAL_OK = ['wts', 'prism', 'wellos', 'modbus', 'historian'].concat(OVERVIEW);
const PARTS = ['prism', 'wts', 'buildup', 'cheminj', 'modbus'];
const SRC_OVERRIDE = { wts: ['31-wts-sim.js', '32-wts-3d.js', '38-wts-live.js'] };
const SEC_KEYS = ['top', 'what', 'when', 'steps', 'inputs', 'results', 'example', 'tips', 'refs', 'related'];

// ── names and addresses (§7.1): patterns built from character codes, so no literal is in the repository ──
const cc = (a) => String.fromCharCode.apply(null, a);
const FORBIDDEN = new RegExp('\\b' + cc([80, 73, 69]) + '\\b');
const BROWSERS = [[67, 104, 114, 111, 109, 101], [67, 104, 114, 111, 109, 105, 117, 109], [83, 97, 102, 97, 114, 105], [70, 105, 114, 101, 102, 111, 120],
  [79, 112, 101, 114, 97], [73, 110, 116, 101, 114, 110, 101, 116, 32, 69, 120, 112, 108, 111, 114, 101, 114], [77, 105, 99, 114, 111, 115, 111, 102, 116, 32, 69, 100, 103, 101],
  [65, 110, 100, 114, 111, 105, 100]].map((a) => new RegExp('\\b' + cc(a) + '\\b'));
const URL_RE = /https?:\/\/|\bwww\./i;
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co\.uk|uk|gov|edu|info|biz|app|dev|ai|example)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
let DENY = null;
function denylist() {
  if (DENY) return DENY;
  DENY = [];
  const f = process.env.WTS_HELP_DENYLIST;
  if (f && fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
      .forEach((s) => DENY.push(new RegExp('\\b' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')));
  }
  return DENY;
}

// a number followed by a unit (inches as `in` only before punctuation or the end, so "step 3 in the course" passes)
const BARE_UNIT = new RegExp('(?:^|[^\\w.,])\\d+(?:[.,]\\d+)?\\s*(?:"|°\\s?[FC]\\b|in(?=\\s*(?:$|[^\\sA-Za-z]))|(?:inch(?:es)?|ft|psi[ga]?|MSCFD|MMSCFD|[Mm]{1,2}scf\\/d|' +
  'bbls?(?:\\/d)?|BPD|BOPD|BWPD|STB(?:\\/d)?|lbm?|gpm|cP|mm|bar[ga]?|kPa)\\b)');
const UNIT_ALLOW = ['0.125" plate', '0.125" bore'];   // the page's own plate-size wording
// ── text checks ─────────────────────────────────────────────────────────
// ctx: { cats: {category: 1}, routes: Set, glossary: {}, tasks: Set, fs: Set, course: Set, start: Set, guides: {} }
function textIssues(s, where, ctx) {
  const out = [];
  const e = (m) => out.push(where + ': ' + m);
  if (typeof s !== 'string') return out;
  if (/[<>]/.test(s)) e('raw < or > (content is plain text; markup subset only)');
  if (/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s)) e('HTML entity (write the character itself)');
  if (/[™®]/.test(s)) e('™ / ® not allowed');
  if (FORBIDDEN.test(s)) e('forbidden product name (CLAUDE.md)');
  BROWSERS.forEach((re) => { if (re.test(s)) e('browser / platform name not allowed (write "your browser")'); });
  if (URL_RE.test(s) || DOMAIN_RE.test(s)) e('URL or domain (use {{site}})');
  if (EMAIL_RE.test(s)) e('e-mail address (use {{email}})');
  denylist().forEach((re) => { if (re.test(s)) e('name from the external denylist'); });
  const open = (s.match(/\{\{/g) || []).length, close = (s.match(/\}\}/g) || []).length;
  if (open !== close) e('unbalanced {{ }}');
  (s.match(/\{\{([^{}]*)\}\}/g) || []).forEach((t) => {
    const b = t.slice(2, -2);
    if (b === 'site' || b === 'email') return;
    const m = /^(-?\d+(?:\.\d+)?)\|([A-Za-z0-9]+)(?:\|(\d))?$/.exec(b);
    if (!m) e('malformed unit token ' + t + ' (write {{value|category[|dp]}})');
    else if (ctx && ctx.cats && !ctx.cats[m[2]]) e('unknown unit category in ' + t);
  });
  if (ctx && ctx.dual) {
    // §4.4 / D13: a measured value in a 'dual' guide is a unit token, so Metric mode converts it. Page wording such as
    // a plate size name, **bold page text** and “quoted page text” are exempt.
    let t = s.replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\*\*[^*]+\*\*/g, ' ').replace(/“[^”]*”/g, ' ');
    UNIT_ALLOW.forEach((a) => { t = t.split(a).join(' '); });
    const m = BARE_UNIT.exec(t);
    if (m) e('bare measurement "' + m[0].trim() + '" in a units:"dual" guide (write a unit token {{value|category}})');
  }
  const lo = (s.match(/\[\[/g) || []).length, lc = (s.match(/\]\]/g) || []).length;
  if (lo !== lc) e('unbalanced [[ ]]');
  (s.match(/\[\[([^\]]*)\]\]/g) || []).forEach((t) => {
    const body = t.slice(2, -2), target = body.split('|')[0], i = target.indexOf('#');
    const r = i === -1 ? target : target.slice(0, i), sec = i === -1 ? '' : target.slice(i + 1);
    if (!ctx) return;
    if (r === 'glossary') { if (!ctx.glossary[sec]) e('link to unknown glossary term ' + t); return; }
    if (r === 'task') { if (!ctx.tasks.has(sec)) e('link to unknown task ' + t); return; }
    if (r === 'fs') { if (!ctx.fs.has(sec)) e('link to unknown field scenario ' + t); return; }
    if (r === 'course') { if (sec && !ctx.course.has(sec)) e('link to unknown exercise ' + t); return; }
    if (r === 'start') { if (sec && !ctx.start.has(sec)) e('link to unknown Getting started chapter ' + t); return; }
    if (['tasks', 'scenarios', 'faq', 'landing'].indexOf(r) !== -1) return;
    const rr = r === 'dca' || r === 'pta' ? 'prism' : r;
    if (!ctx.routes.has(rr)) { e('link to unknown route ' + t); return; }
    const g = ctx.guides[rr];
    if (sec && g && SEC_KEYS.indexOf(sec) === -1 && !(g.parts || []).some((p) => p && p.id === sec)) e('link to unknown section ' + t);
  });
  return out;
}
// Every string of a content object, with its path. Keys holding code (checks, cases, selectors) are skipped.
const SKIP_KEYS = new Set(['check', 'verdictCases', 'shots', 'reviewedSrc', 'boldExempt', 'match']);
function strings(v, p, cb) {
  if (typeof v === 'string') { cb(v, p); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => strings(x, p + '[' + i + ']', cb)); return; }
  if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (!SKIP_KEYS.has(k)) strings(v[k], p + '.' + k, cb); });
}
function sentences(s) { return String(s).replace(/\{\{[^}]*\}\}/g, 'x').split(/(?<=[.!?])\s+/).filter(Boolean); }
function words(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

// ── structure and limits (§4.1, §4.6) ────────────────────────────────────
// Limits shared by a guide and each of its parts: input / output labels and text, example.check, tips and pitfalls.
function bodyIssues(r, g, e, isOverview) {
  const A = (x) => (Array.isArray(x) ? x : []);
  const len = (s) => String(s || '').length;
  A(g.inputs).concat(A(g.outputs)).forEach((x, i) => {
    if (!x || !x.label) e('inputs/outputs[' + i + '] label missing');
    else if (len(x.label) > 60) e('label over 60: ' + x.label);
    if (x && len(x.text) > 300) e('text over 300: ' + x.label);
  });
  if (g.example && g.example.check) {
    const k = g.example.check.kind;
    if (['compute', 'page', 'manual'].indexOf(k) === -1) e('example.check.kind must be compute | page | manual');
    if (k === 'manual' && MANUAL_OK.indexOf(r) === -1) e('example.check manual is allowed only for the simulator, PRiSM, Live Data and Overview pages');
    if (k === 'manual' && !g.example.check.reason) e('example.check manual needs a reason');
  } else if (g.example && !isOverview) e('example.check missing');
  A(g.tips).concat(A(g.pitfalls)).forEach((x, i) => { if (len(x) > 300) e('tips/pitfalls[' + i + '] over 300'); });
}
function limitIssues(r, g, warn) {
  const out = [], e = (m) => out.push(r + ': ' + m);
  const A = (x) => (Array.isArray(x) ? x : []);
  const len = (s) => String(s || '').length;
  if (!g.purpose) e('purpose missing'); else if (len(g.purpose) > 160) e('purpose over 160 characters');
  const parts = A(g.parts);
  const isOverview = OVERVIEW.indexOf(r) !== -1;
  if (!A(g.what).length) e('what missing'); else if (g.what.length > 3) e('what: more than 3 paragraphs');
  if (A(g.when).length < 2 || g.when.length > 5) e('when: 2–5 items'); A(g.when).forEach((x, i) => { if (len(x) > 200) e('when[' + i + '] over 200'); });
  const st = A(g.steps);
  if (st.length < 3 || st.length > 12) e('steps: 3–12 items');
  st.forEach((s, i) => { const t = typeof s === 'string' ? s : s && s.t; if (!t) e('steps[' + i + '] empty'); else if (len(t) > 300) e('steps[' + i + '] over 300'); });
  // A parts guide (§4.1) may hold inputs, outputs and the example in its parts: at least one of the top level or a part
  // must have each, except where `manual` is allowed (simulator, PRiSM, Live Data, Overview).
  const some = (k) => !!(k === 'example' ? g.example : A(g[k]).length) || parts.some((p) => p && (k === 'example' ? p.example : A(p[k]).length));
  const need = !isOverview && !(parts.length && MANUAL_OK.indexOf(r) !== -1);
  if (!some('inputs') && g.units !== 'none' && need) e('inputs missing (set units:"none" for a page without inputs)');
  if (!some('outputs') && need) e('outputs missing');
  if (!some('example') && need) e('example missing');
  bodyIssues(r, g, e, isOverview);
  const tp = A(g.tips).concat(A(g.pitfalls));
  if (tp.length < 1 || tp.length > 10) e('tips + pitfalls: 1–10 items');
  if (!A(g.refs).length && !g.noRefs) e('refs missing (or noRefs: "<reason>")');
  if (!A(g.related).length) e('related: at least one route');
  if (typeof g.reviewed !== 'string' || !/^v\d+\.\d+(\.\d+)?$/.test(g.reviewed)) e('reviewed must be a version string like v3.3.2');
  if (!/^[0-9a-f]{8}$/.test(String(g.reviewedSrc || ''))) e('reviewedSrc must be 8 hex characters');
  if (['dual', 'field', 'none'].indexOf(g.units) === -1) e('units must be dual | field | none');
  A(g.shots).forEach((s, i) => {
    if (!s || !s.id) e('shots[' + i + '] id missing');
    if (!s || !s.alt) e('shots[' + i + '] alt missing'); else if (len(s.alt) > 200) e('shots[' + i + '] alt over 200');
    if (!s || !s.caption) e('shots[' + i + '] caption missing'); else if (len(s.caption) > 160) e('shots[' + i + '] caption over 160');
    if (s && ['desktop', 'phone', 'both', undefined].indexOf(s.view) === -1) e('shots[' + i + '] view must be desktop | phone | both');
  });
  st.forEach((s, i) => { if (s && s.shot && !A(g.shots).some((x) => x.id === s.shot)) e('steps[' + i + '] names unknown shot ' + s.shot); });
  const size = Buffer.byteLength(JSON.stringify(g), 'utf8');
  if (size > (PARTS.indexOf(r) !== -1 ? 14 : 6) * 1024) e('guide is ' + size + ' bytes serialised (cap ' + (PARTS.indexOf(r) !== -1 ? 14 : 6) + ' kB)');
  parts.forEach((p, i) => {
    if (!p || !p.id || !/^[a-z0-9-]+$/.test(p.id)) e('parts[' + i + '] id must be [a-z0-9-]');
    if (!p || typeof p !== 'object') return;
    const pe = (m) => e('parts[' + (p.id || i) + '] ' + m);
    if (A(p.what).length > 3) pe('what: more than 3 paragraphs');
    if (p.when !== undefined && (A(p.when).length < 2 || A(p.when).length > 5)) pe('when: 2–5 items');
    A(p.when).forEach((x, j) => { if (len(x) > 200) pe('when[' + j + '] over 200'); });
    const ps = A(p.steps);
    if (p.steps !== undefined && (ps.length < 3 || ps.length > 12)) pe('steps: 3–12 items');
    ps.forEach((s, j) => { const t = typeof s === 'string' ? s : s && s.t; if (!t) pe('steps[' + j + '] empty'); else if (len(t) > 300) pe('steps[' + j + '] over 300'); });
    ps.forEach((s, j) => { if (s && s.shot && !A(g.shots).some((x) => x.id === s.shot)) pe('steps[' + j + '] names unknown shot ' + s.shot); });
    if (A(p.tips).concat(A(p.pitfalls)).length > 10) pe('tips + pitfalls: at most 10 items');
    bodyIssues(r, p, pe, isOverview);
  });
  if (warn) {
    const lint = (arr, f) => A(arr).forEach((x) => { const t = typeof x === 'string' ? x : x && (x.t || x.text); if (t) sentences(t).forEach((s) => { if (words(s) > 25) warn(r + '.' + f + ': sentence of ' + words(s) + ' words'); }); });
    [g].concat(parts.filter((p) => p && typeof p === 'object')).forEach((x, i) => {
      const w = i ? 'parts[' + x.id + '].' : '';
      lint(x.steps, w + 'steps'); lint(x.tips, w + 'tips'); lint(x.pitfalls, w + 'pitfalls'); lint(x.verdicts, w + 'verdicts');
    });
  }
  return out;
}

// ── glossary first use (§4.5) ─────────────────────────────────────────────
function glossaryIssues(r, g, glossary) {
  const out = [];
  const keys = Object.keys(glossary || {});
  if (!keys.length) return out;
  const texts = [];
  strings({ purpose: g.purpose, what: g.what, when: g.when, steps: g.steps, inputs: g.inputs, outputs: g.outputs, verdicts: g.verdicts, example: g.example,
    tips: g.tips, pitfalls: g.pitfalls, parts: g.parts }, r, (s) => texts.push(s));
  keys.forEach((k) => {
    const e = glossary[k] || {}, forms = [e.term || k].concat(e.variants || []);
    const re = new RegExp('(^|[^A-Za-z0-9])(' + forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])', 'i');
    for (const s of texts) {
      const plainStr = s.replace(/\{\{[^}]*\}\}/g, ' ');
      const m = re.exec(plainStr);
      if (!m) continue;
      const at = m.index + m[1].length;
      const links = [...plainStr.matchAll(/\[\[([^\]]*)\]\]/g)];
      const inLink = links.find((l) => at >= l.index && at < l.index + l[0].length);
      if (!inLink || inLink[1].split('|')[0] !== 'glossary#' + k) out.push(r + ': first use of glossary term "' + (e.term || k) + '" must be [[glossary#' + k + '|…]]');
      break;
    }
  });
  return out;
}

// ── source hashes (reviewedSrc) ──────────────────────────────────────────
let _hostHtml = null;
function hostHtml() { if (_hostHtml == null) _hostHtml = fs.readFileSync(path.join(REPO, 'well-testing-app.html'), 'utf8').replace(/\r\n/g, '\n'); return _hostHtml; }
const SRC_FILES = () => fs.readdirSync(BUILD).filter((f) => /^\d\d-.*\.js$/.test(f) && !/^combined/.test(f)).sort();
function readSrc(f) { return fs.readFileSync(path.join(BUILD, f), 'utf8').replace(/\r\n/g, '\n'); }
function hostFn(name) {
  const h = hostHtml();
  let a = h.indexOf('\nfunction ' + name + '(');
  if (a === -1) a = h.indexOf('\nwindow.' + name + ' = function');
  if (a === -1) return null;
  const b = h.indexOf('\n}', a + 1);
  return h.slice(a + 1, b === -1 ? h.length : b + 2);
}
function srcTexts(route) {
  if (SRC_OVERRIDE[route]) return SRC_OVERRIDE[route].map((f) => ({ name: f, text: readSrc(f) }));
  const reg = SRC_FILES().filter((f) => /^4\d-calc-|^6\d-/.test(f) && new RegExp("key:\\s*['\"]" + route + "['\"]").test(readSrc(f)));
  if (reg.length) return reg.map((f) => ({ name: f, text: readSrc(f) }));
  const line = (hostHtml().match(/const pages = \{[^\n]*\};/) || [''])[0];
  const m = new RegExp('[{,]\\s*' + route + ':\\s*(window\\.)?([A-Za-z0-9_$]+)').exec(line);
  if (!m) return [];
  const name = m[2];
  if (m[1]) {
    const files = SRC_FILES().filter((f) => !/^4\d-|^6\d-/.test(f) && new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\s*=\\s*function|function\\s+' + name + '\\s*\\(').test(readSrc(f)));
    return files.map((f) => ({ name: f, text: readSrc(f) }));
  }
  const out = [];
  const t = hostFn(name);
  if (t) out.push({ name: 'host:' + name, text: t });
  const calc = name.replace(/^render/, 'calc'), tc = calc !== name ? hostFn(calc) : null;
  if (tc) out.push({ name: 'host:' + calc, text: tc });
  if (!out.length) {
    const f = SRC_FILES().filter((x) => new RegExp('function\\s+' + name + '\\s*\\(').test(readSrc(x)));
    f.forEach((x) => out.push({ name: x, text: readSrc(x) }));
  }
  return out;
}
function srcHash(route) {
  const t = srcTexts(route);
  if (!t.length) return null;
  return crypto.createHash('sha256').update(t.map((x) => x.text).join('\n'), 'utf8').digest('hex').slice(0, 8);
}

// ── page checks (DOM drift, reverse coverage, verdicts, bold, examples) ──
const txt = (e) => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
function stripUnit(s) { return String(s).replace(/\s+/g, ' ').trim().replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '').trim(); }
function labelOf(root, el) {
  let l = null;
  try { l = root.querySelector('label[for="' + el.id + '"]'); } catch (e) { l = null; }
  if (!l && el.closest) { const fi = el.closest('.fg-item'); l = fi && fi.querySelector('label'); }
  if (!l && el.closest) l = el.closest('label');
  if (!l && String(el.localName).toLowerCase() === 'button') return txt(el);
  return l ? txt(l) : null;
}
function pageRoot(app) {
  const body = app.el('pgBody');
  const r = body && Array.from(body.querySelectorAll('[id$="_root"]'))[0];
  return r || body;
}
function goFresh(app, r) {
  app.hook.nav('home');
  app.storage.removeItem('wts_page_' + r);
  app.hook.nav(r);
  app.flush(300);
}
function verdictLines(root) {
  const out = [];
  Array.from(root.querySelectorAll('*')).forEach((e) => {
    const tag = String(e.localName).toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'option' || tag === 'select') return;
    const t = txt(e);
    if (!/^[✓⚠✗]/.test(t) || t.length > 600) return;
    if (Array.from(e.children).some((c) => txt(c) === t)) return;
    if (out.indexOf(t) === -1) out.push(t);
  });
  return out;
}
function verdictKey(v) { return v.match || String(v.text || '').split(/\s+/).slice(0, 4).join(' '); }
function setInputs(app, set) {
  Object.keys(set || {}).forEach((id) => {
    const el = app.el(id);
    if (!el) throw new Error('no #' + id);
    if (String(el.localName).toLowerCase() === 'select') app.select(el, String(set[id]));
    else if (el.type === 'checkbox') app.check(el, !!set[id]);
    else { app.input(el, String(set[id])); app.change(el, String(set[id])); }
  });
}
function getPath(o, p) { return String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function near(a, b, tol) { return typeof b === 'number' ? (typeof a === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))) : a === b; }
function firstNum(s) { const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(s)); return m ? parseFloat(m[0].replace(/,/g, '')) : NaN; }

// g: the guide or one of its parts; r: the label in messages (route, or route.parts[id]); route: the guide's route.
function checkExample(app, r, g, route0) {
  const out = [], ck = g.example && g.example.check;
  if (!ck || ck.kind === 'manual') return out;
  const tol = ck.tol == null ? 0.005 : ck.tol, W = app.win;
  if (ck.kind === 'compute') {
    if (typeof W[ck.fn] !== 'function') return [r + ': example.check fn ' + ck.fn + ' is not a function'];
    let res;
    try { res = W[ck.fn](app.toWin(ck.input || {})); } catch (e) { return [r + ': example.check ' + ck.fn + ' threw ' + e.message]; }
    Object.keys(ck.expect || {}).forEach((k) => { const v = getPath(res, k); if (!near(v, ck.expect[k], tol)) out.push(r + ': example ' + k + ' = ' + v + ', guide says ' + ck.expect[k]); });
    return out;
  }
  // page
  const route = ck.route || route0 || r;
  goFresh(app, route);
  try { setInputs(app, ck.set); } catch (e) { return [r + ': example.check ' + e.message]; }
  if (ck.calc) { if (typeof W[ck.calc] !== 'function') return [r + ': example.check calc ' + ck.calc + ' missing']; W[ck.calc](); }
  app.flush(300);
  Object.keys(ck.expectIds || {}).forEach((id) => {
    const el = app.el(id), want = ck.expectIds[id];
    const got = el ? (typeof want === 'number' ? firstNum(txt(el)) : txt(el)) : undefined;
    if (!near(got, want, tol)) out.push(r + ': example #' + id + ' = ' + got + ', guide says ' + want);
  });
  Object.keys(ck.expectState || {}).forEach((k) => { const v = getPath(W.WTS_state, k); if (!near(v, ck.expectState[k], tol)) out.push(r + ': example WTS_state.' + k + ' = ' + v + ', guide says ' + ck.expectState[k]); });
  const body = txt(app.el('pgBody'));
  (ck.expectText || []).forEach((t) => { if (body.indexOf(t) === -1) out.push(r + ': example: page does not show "' + t + '"'); });
  (ck.absentText || []).forEach((t) => { if (body.indexOf(t) !== -1) out.push(r + ': example: page still shows "' + t + '"'); });
  return out;
}

// opts.skipSelectors: true for the simulator HMI until Round 7 is in the harness (§7.1)
function pageIssues(app, r, g) {
  const out = [], e = (m) => out.push(r + ': ' + m);
  goFresh(app, r);
  const root = pageRoot(app);
  if (!root) return [r + ': page did not render'];
  const A = (x) => (Array.isArray(x) ? x : []);
  const all = A(g.inputs).concat([].concat.apply([], A(g.parts).map((p) => A(p && p.inputs))));
  const ids = new Set(all.filter((i) => i.id).map((i) => i.id));
  all.forEach((i) => {
    if (!i.id) return;
    const el = app.el(i.id);
    if (!el) { e('input #' + i.id + ' is not on the page'); return; }
    const l = labelOf(root, el);
    if (l == null) e('input #' + i.id + ' has no label on the page');
    else if (stripUnit(l) !== String(i.label).replace(/\s+/g, ' ').trim()) e('label of #' + i.id + ' is "' + stripUnit(l) + '" on the page, "' + i.label + '" in the guide');
    const pc = el.getAttribute('data-wts-unit-cat');
    if (i.cat && pc && pc !== i.cat) e('#' + i.id + ' is tagged ' + pc + ' on the page, cat ' + i.cat + ' in the guide');
  });
  const nd = A(g.notDocumented);
  nd.forEach((x) => { if (!x || !x.why) e('notDocumented entry without a reason'); });
  const ndId = new Set(nd.filter((x) => x && x.id).map((x) => x.id)), ndRe = nd.filter((x) => x && x.pattern).map((x) => new RegExp(x.pattern));
  Array.from(root.querySelectorAll('input[id], select[id], textarea[id], button[id]')).forEach((el) => {
    const id = el.id;
    if (ids.has(id) || ndId.has(id) || ndRe.some((re) => re.test(id))) return;
    e('control #' + id + ' is on the page but not in inputs[] or notDocumented (page → guide)');
  });
  // shot selectors (recipes that open menus are checked by the shots tool)
  if (g._skipSelectors) console.log('[help-content] ' + r + ': ' + A(g.shots).length + ' shot selector check(s) skipped — ' + (typeof g._skipSelectors === 'string' ? g._skipSelectors : 'no reason given'));
  else A(g.shots).forEach((s) => {
    if (A(s.setup).some((op) => op && (op.click || op.action || op.press || op.hover))) return;
    const sels = (s.target && s.target !== 'viewport' ? [s.target] : []).concat(A(s.callouts).map((c) => c.sel));
    sels.forEach((sel) => {
      let hit = null;
      try { hit = app.document.querySelector(sel); } catch (x) { e('shot ' + s.id + ': bad selector ' + sel); return; }
      if (!hit) e('shot ' + s.id + ': selector ' + sel + ' matches nothing');
    });
  });
  // bold phrases in steps must be visible text (§7.1)
  const vis = [txt(app.el('pgTitle')), txt(app.el('pgSub')), txt(app.el('pgBody')), txt(app.el('hubTabs')),
    Array.from(app.document.querySelectorAll('#sidebar .nav-group-label, #sidebar .nav-btn')).map(txt).join(' | ')].join(' | ').toLowerCase();
  const exempt = new Set(A(g.boldExempt).map((x) => String(x).toLowerCase()));
  A(g.steps).concat([].concat.apply([], A(g.parts).map((p) => A(p && p.steps)))).forEach((s) => {
    const t = typeof s === 'string' ? s : s && s.t;
    (String(t || '').match(/\*\*([^*]+)\*\*/g) || []).forEach((b) => {
      const p = b.slice(2, -2).replace(/\s+/g, ' ').trim();
      if (p.indexOf('→') !== -1 || exempt.has(p.toLowerCase())) return;
      if (vis.indexOf(p.toLowerCase()) === -1) e('bold phrase "' + p + '" is not visible text on the page');
    });
  });
  // verdict coverage: defaults + verdictCases
  const vs = A(g.verdicts).concat([].concat.apply([], A(g.parts).map((p) => A(p && p.verdicts))));
  const cover = (lines, label) => lines.forEach((l) => {
    const mark = l[0];
    if (!vs.some((v) => v.mark === mark && l.indexOf(verdictKey(v)) !== -1)) e('verdict "' + l.slice(0, 90) + '" (' + label + ') matches no verdicts[] entry');
  });
  cover(verdictLines(root), 'defaults');
  A(g.verdictCases).forEach((c, i) => {
    goFresh(app, r);
    try { setInputs(app, c.set); } catch (x) { e('verdictCases[' + i + ']: ' + x.message); return; }
    if (c.calc && typeof app.win[c.calc] === 'function') app.win[c.calc]();
    app.flush(300);
    const lines = verdictLines(pageRoot(app));
    if (!lines.length) e('verdictCases[' + i + '] shows no verdict');
    cover(lines, 'case ' + i);
  });
  // worked examples of the guide and of every part reproduce; a page example's state is a verdict case too (§7.1)
  [g].concat(A(g.parts).filter((p) => p && typeof p === 'object')).forEach((x, i) => {
    const ck = x.example && x.example.check;
    if (!ck) return;
    checkExample(app, i ? r + '.parts[' + x.id + ']' : r, x, r).forEach((m) => out.push(m));
    if (ck.kind === 'page' && (ck.route || r) === r) cover(verdictLines(pageRoot(app)), 'example' + (i ? ' of part ' + x.id : ''));
  });
  return out;
}

// ── context from the live app ─────────────────────────────────────────────
function liveRoutes(app) {
  const s = new Set();
  const line = (app.html.match(/const pages = \{[^\n]*\};/) || [''])[0];
  (line.match(/[{,]\s*([a-z][a-z0-9_]*)\s*:/g) || []).forEach((m) => s.add(m.replace(/[{,:\s]/g, '')));
  Object.keys(app.win.WTS_calcRegistry || {}).forEach((k) => s.add(k));
  app.findAll('#sidebar .nav-btn[data-p]').forEach((b) => s.add(b.getAttribute('data-p')));
  NOT_ROUTES.forEach((k) => s.delete(k));
  return s;
}
function sidebarGroupOf(app) {
  const m = {};
  app.findAll('#sidebar .nav-group').forEach((g) => {
    const l = txt(g.querySelector('.nav-group-label'));
    Array.from(g.querySelectorAll('.nav-btn[data-p]')).forEach((b) => { m[b.getAttribute('data-p')] = l; });
  });
  return m;
}
function makeCtx(app, C) {
  return {
    cats: app.win.WTS_units ? app.win.WTS_units.CATEGORIES : {},
    routes: liveRoutes(app), guides: C.guides || {}, glossary: C.glossary || {},
    tasks: new Set((C.tasks || []).map((t) => t.id)), fs: new Set((C.scenarios || []).map((t) => t.id)),
    course: new Set((C.course || []).map((t) => t.id)), start: new Set((C.start || []).map((t) => t.id)),
  };
}
function guideIssues(app, r, g, ctx, warn) {
  let out = limitIssues(r, g, warn);
  const tctx = Object.assign({}, ctx, { dual: g.units === 'dual' });
  strings(g, r, (s, p) => { out = out.concat(textIssues(s, p, tctx)); });
  (g.shots || []).forEach((s, i) => ['alt', 'caption'].forEach((k) => { out = out.concat(textIssues(s && s[k], r + '.shots[' + i + '].' + k, tctx)); }));
  (g.related || []).forEach((x) => { if (!ctx.routes.has(x)) out.push(r + ': related route ' + x + ' is not live'); });
  out = out.concat(glossaryIssues(r, g, ctx.glossary));
  const h = srcHash(r);
  if (!h) out.push(r + ': no source file found for reviewedSrc');
  else if (g.reviewedSrc !== h) out.push('guide ' + r + ' not re-reviewed since its page changed (reviewedSrc ' + g.reviewedSrc + ', page source now ' + h + ')');
  return out.concat(pageIssues(app, r, g));
}
function otherIssues(C, ctx) {
  let out = [];
  const size = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  (C.tasks || []).forEach((t, i) => {
    const w = 'tasks[' + i + ']';
    if (!t.id || !t.title) out.push(w + ': id and title required');
    if (size(t) > 1024) out.push(w + ': over 1 kB');
    (t.steps || []).forEach((s, j) => { if (s.route && !ctx.routes.has(s.route)) out.push(w + '.steps[' + j + ']: route ' + s.route + ' is not live'); });
  });
  if ((C.factories || []).some((f) => f && f.group === 'start') && ((C.tasks || []).length < 10 || C.tasks.length > 15)) out.push('tasks: 10–15 "How do I…" tasks expected');
  (C.course || []).forEach((x, i) => { if (size(x) > 4096) out.push('course[' + i + ']: over 4 kB'); });
  (C.scenarios || []).forEach((x, i) => { if (size(x) > 5120) out.push('scenarios[' + i + ']: over 5 kB'); if (!/^FS-\d+$/.test(String(x.id))) out.push('scenarios[' + i + ']: id FS-n'); });
  ['start', 'tasks', 'course', 'scenarios', 'faq'].forEach((k) => (C[k] || []).forEach((x, i) => {
    const seen = (C[k] || []).filter((y) => y.id === x.id).length;
    if (seen > 1) out.push(k + '[' + i + ']: duplicate id ' + x.id);
    strings(x, k + '[' + i + ']', (s, p) => { out = out.concat(textIssues(s, p, ctx)); });
  }));
  strings(C.glossary || {}, 'glossary', (s, p) => { out = out.concat(textIssues(s, p, ctx)); });
  return out;
}
function helpFiles() { return fs.readdirSync(BUILD).filter((f) => /^4[89]-calc-help.*\.js$/.test(f)).sort(); }
function sizeIssues() {
  const { stripSelfTest } = require(path.join(BUILD, 'concat-round9.js'));
  const quiet = { log() {}, warn() {} };
  const out = [], rows = [];
  let all = '';
  helpFiles().forEach((f) => {
    const s = stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, quiet);
    const n = Buffer.byteLength(s, 'utf8');
    all += s;
    rows.push([f, n]);
    if (!CAPS[f]) out.push(f + ': help file without a byte cap in §3.6');
    else if (n > CAPS[f] * KB) out.push(f + ': ' + n + ' bytes, cap ' + CAPS[f] + ' kB');
  });
  const raw = Buffer.byteLength(all, 'utf8'), gz = zlib.gzipSync(Buffer.from(all, 'utf8'), { level: 9 }).length;
  if (raw > SUM_CAP) out.push('help files: ' + raw + ' bytes raw, cap ' + SUM_CAP);
  if (gz > GZIP_CAP) out.push('help files: ' + gz + ' bytes gzip, cap ' + GZIP_CAP);
  return { out, rows, raw, gz };
}
const fail = (assert, list, what) => assert.ok(!list.length, what + ':\n  ' + list.slice(0, 40).join('\n  ') + (list.length > 40 ? '\n  … ' + (list.length - 40) + ' more' : ''));
const clone = (o) => JSON.parse(JSON.stringify(o));

const LIB = { textIssues, limitIssues, guideIssues, pageIssues, otherIssues, glossaryIssues, makeCtx, liveRoutes, srcHash, srcTexts, stripUnit, sizeIssues, verdictLines };

const TESTS = [
  {
    name: 'HELP content H0: the model guide (orifice) passes every content check against the live page',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_help.load();
      const ctx = makeCtx(app, { guides: { orifice: MODEL.ORIFICE }, glossary: C.glossary, tasks: C.tasks, scenarios: C.scenarios, course: C.course, start: C.start });
      const warns = [];
      const issues = guideIssues(app, 'orifice', MODEL.ORIFICE, ctx, (w) => warns.push(w));
      fail(assert, issues, 'model guide');
      assert.deepStrictEqual(warns, [], 'model guide has no sentence over 25 words');
      assert.strictEqual(srcHash('orifice'), MODEL.ORIFICE.reviewedSrc);
    },
  },
  {
    name: 'HELP content: a content file in the documented format loads through Round 9; load() merges it once and reports duplicates',
    wp: WP,
    opts: { sourceOverrides: {
      '48-calc-help-zza.js': MODEL.FILE_TEMPLATE.replace("group: '<group>'", "group: 'zzmodel'").replace('routes: [/* every route below */]', "routes: ['orifice']")
        .replace('{ /* route: { …schema… } */ }', '{ orifice: ' + JSON.stringify(MODEL.ORIFICE) + ' }'),
      '48-calc-help-zzb.js': MODEL.FILE_TEMPLATE.replace("group: '<group>'", "group: 'zzdup'").replace('routes: [/* every route below */]', "routes: ['orifice']")
        .replace('{ /* route: { …schema… } */ }', "{ orifice: { route: 'orifice' } }"),
    } },
    run(app, assert) {
      const W = app.win, C = W.WTS_helpContent;
      assert.ok(C.factories.length >= 2, 'factories registered at load');
      assert.ok(C.factories.every((f) => !f._done), 'no factory runs at load (D3)');
      assert.ok(W.WTS_help.hasGuide('orifice'), 'hasGuide from the routes list, before load');
      assert.ok(!C._loaded, 'hasGuide did not run the factories');
      W.WTS_help.load();
      assert.strictEqual(C.guides.orifice.purpose, MODEL.ORIFICE.purpose);
      assert.ok(W.WTS_help.loadErrors.some((m) => /duplicate guide "orifice"/.test(m)), 'duplicate reported: ' + W.WTS_help.loadErrors.join('; '));
      const html = W.WTS_help.renderGuide('orifice');
      ['what', 'when', 'steps', 'inputs', 'results', 'example', 'tips', 'refs', 'related'].forEach((s) => assert.ok(html.indexOf('id="help-orifice-' + s + '"') !== -1, 'section ' + s));
      assert.ok(/Reviewed for v3\.3\.2/.test(html));
    },
  },
  {
    name: 'HELP content: every shipped guide and the other content pass the checks; coverage per content file present (all routes once every file is in)',
    wp: WP,
    timeoutMs: 600000,
    run(app, assert) {
      const H = app.win.WTS_help, C = H.load();
      fail(assert, H.loadErrors.slice(), 'load errors');
      const ctx = makeCtx(app, C), groupOf = sidebarGroupOf(app), issues = [], warns = [];
      // factories: known group, routes list = guides built
      const present = new Set();
      C.factories.forEach((f, i) => {
        if (!f || !f.group) { issues.push('factory ' + i + ': group missing'); return; }
        present.add(f.group);
        if (!GROUP_LABEL[f.group] && f.group !== 'start' && f.group !== 'simcourse') issues.push('factory ' + i + ': unknown group ' + f.group);
        const built = Object.keys(C.guides).filter((r) => C.guides[r]._group === f.group).sort();
        if (JSON.stringify((f.routes || []).slice().sort()) !== JSON.stringify(built)) issues.push('factory ' + f.group + ': routes [' + (f.routes || []) + '] differ from the guides it builds [' + built + ']');
      });
      Object.keys(C.guides).forEach((r) => {
        const g = C.guides[r];
        if (!ctx.routes.has(r)) { issues.push('guide for unknown route ' + r); return; }
        if (g.route !== r) issues.push(r + ': route field is ' + g.route);
        const want = GROUP_LABEL[g._group];
        if (want && groupOf[r] && groupOf[r] !== want) issues.push(r + ': in ' + g._group + ' but the sidebar puts it in ' + groupOf[r]);
      });
      Object.keys(GROUP_LABEL).forEach((k) => {
        if (!present.has(k)) return;
        Object.keys(groupOf).filter((r) => groupOf[r] === GROUP_LABEL[k] && !NOT_ROUTES.includes(r)).forEach((r) => { if (!C.guides[r]) issues.push(GROUP_LABEL[k] + ': no guide for ' + r); });
      });
      if (CONTENT_FILES.every((f) => fs.existsSync(path.join(BUILD, f)))) ctx.routes.forEach((r) => { if (!C.guides[r]) issues.push('no guide for live route ' + r); });
      Object.keys(C.guides).forEach((r) => {
        if (!ctx.routes.has(r)) return;
        const g = Object.assign({}, C.guides[r]);
        if (r === 'wts') g._skipSelectors = 'Round 7 not in the harness';   // simulator HMI ids (§7.1)
        guideIssues(app, r, g, ctx, (w) => warns.push(w)).forEach((x) => issues.push(x));
      });
      otherIssues(C, ctx).forEach((x) => issues.push(x));
      if (warns.length) console.log('[help-content] ' + warns.length + ' readability warning(s):\n  ' + warns.slice(0, 20).join('\n  '));
      fail(assert, issues, 'content');
    },
  },
  {
    name: 'HELP content: help files within their byte caps (§3.6); sum ≤ 330 kB raw and ≤ 90 kB gzip',
    wp: WP,
    opts: false,
    run(app, assert) {
      const r = sizeIssues();
      assert.ok(r.rows.some((x) => x[0] === '49-calc-help.js'), '49-calc-help.js present');
      fail(assert, r.out, 'sizes');
    },
  },
  {
    name: 'HELP content: the validator rejects markup, entities, addresses, forbidden names, bad tokens and dangling links',
    wp: WP,
    run(app, assert) {
      const ctx = makeCtx(app, { guides: { orifice: MODEL.ORIFICE }, glossary: { bean: { term: 'bean' } } });
      const bad = (s) => assert.ok(textIssues(s, 'x', ctx).length > 0, 'rejected: ' + s);
      const good = (s) => assert.deepStrictEqual(textIssues(s, 'x', ctx), [], 'accepted: ' + s);
      bad('<img src=x onerror=alert(1)>');
      bad('a &amp; b'); bad('x &#60; y');
      bad('see https://example.org'); bad('see www.example.com'); bad('mail name@company.example'); bad('operator-energy.co.uk');
      bad('Brand™'); bad('Brand®');
      bad('Uses the ' + cc([80, 73, 69]) + ' method');
      bad('open it in ' + cc([67, 104, 114, 111, 109, 101]));
      bad('{{150|psiG}}'); bad('{{150|pressureG'); bad('{{abc|pressureG}}');
      bad('[[nosuchroute]]'); bad('[[glossary#nope|x]]'); bad('[[fs#FS-9|x]]'); bad('[[orifice#nosection|x]]');
      good('Metering & Chokes: set {{150|pressureG}} and {{10|gasRate|1}} — see [[orifice]], [[aga3#inputs|AGA-3 inputs]], [[glossary#bean|bean]], {{site}}, {{email}} ① ✓ ⚠ ✗');
      good('A pie chart is not a name.');
      // bare measurements in a units:'dual' guide (D13, §4.4)
      const dual = Object.assign({}, ctx, { dual: true });
      const badD = (s) => assert.ok(textIssues(s, 'x', dual).some((m) => /bare measurement/.test(m)), 'bare unit rejected: ' + s);
      const goodD = (s) => assert.deepStrictEqual(textIssues(s, 'x', dual), [], 'accepted (dual): ' + s);
      ['Tube bore 4.026 in.', 'at least 2 in', 'a 1.875" plate', 'set 500 psig', 'at 80 °F', '5000 MSCFD', '120 bbl/d', 'below 2 in: estimate'].forEach(badD);
      ['Tube bore {{4.026|lengthSmall}}.', 'No 0.125" plate fits.', 'Step 3 in the course', 'Select **Line 2 in**.', '48.6 % of range, β 0.466', 'H2S and CO2'].forEach(goodD);
      assert.deepStrictEqual(textIssues('set 500 psig', 'x', ctx), [], 'only dual guides are checked');
      const g = clone(MODEL.ORIFICE); g.purpose = 'x'.repeat(161); g.when = ['one'];
      const li = limitIssues('orifice', g);
      assert.ok(li.some((m) => /purpose over 160/.test(m)) && li.some((m) => /when: 2–5/.test(m)), li.join('; '));
      // parts (§4.1): each part has the text limits; inputs / outputs / example may sit in a part, not nowhere
      const pg = clone(MODEL.ORIFICE), keep = { inputs: pg.inputs, outputs: pg.outputs, example: pg.example };
      delete pg.inputs; delete pg.outputs; delete pg.example;
      pg.parts = [{ id: 'a', title: 'A', what: ['x'] }];
      let pl = limitIssues('cheminj', pg);
      ['inputs missing', 'outputs missing', 'example missing'].forEach((m) => assert.ok(pl.some((x) => x.indexOf(m) !== -1), m + ': ' + pl.join('; ')));
      assert.ok(!limitIssues('prism', pg).some((x) => /missing/.test(x) && !/reviewedSrc|refs/.test(x)), 'PRiSM parts may go without (manual allowed)');
      Object.assign(pg.parts[0], clone(keep));
      pl = limitIssues('cheminj', pg);
      assert.ok(!pl.some((x) => /(inputs|outputs|example) missing/.test(x)), 'satisfied by a part: ' + pl.join('; '));
      pg.parts[0].steps = ['one', 'x'.repeat(301)];
      pg.parts[0].inputs[0].label = 'y'.repeat(61);
      pg.parts[0].example.check = { kind: 'manual', reason: 'r' };
      pl = limitIssues('cheminj', pg);
      [/parts\[a\] steps: 3–12/, /parts\[a\] steps\[1\] over 300/, /parts\[a\] label over 60/, /parts\[a\] example\.check manual is allowed only/].forEach((re) => assert.ok(pl.some((x) => re.test(x)), re + ': ' + pl.join('; ')));
      assert.ok(limitIssues('buildup', pg).some((x) => /example\.check manual is allowed only/.test(x)), 'buildup has a pure engine: no manual example');
    },
  },
  {
    name: 'HELP content: drift checks bite — renamed label, undocumented control, uncovered verdict, stale review, bold text not on the page, wrong example',
    wp: WP,
    run(app, assert) {
      const ctx = makeCtx(app, { guides: {}, glossary: {} });
      const run = (mut) => { const g = clone(MODEL.ORIFICE); mut(g); return guideIssues(app, 'orifice', g, ctx); };
      const has = (list, re, what) => assert.ok(list.some((m) => re.test(m)), what + ': ' + list.join(' | '));
      has(run((g) => { g.inputs[0].label = 'Gas rate target'; }), /label of #op_q/, 'renamed label');
      has(run((g) => { g.inputs = g.inputs.filter((i) => i.id !== 'op_N2'); }), /control #op_N2 .*page → guide/, 'reverse coverage');
      has(run((g) => { g.verdicts = g.verdicts.filter((v) => v.match !== 'below the AGA-3 minimum'); }), /verdict "⚠ Meter run ID/, 'verdict coverage');
      has(run((g) => { g.reviewedSrc = '00000000'; }), /not re-reviewed since its page changed/, 'stale review');
      has(run((g) => { g.steps[1].t = 'Enter the **Rate of gas** ①.'; }), /bold phrase "Rate of gas"/, 'bold phrase');
      has(run((g) => { g.example.check.expect['chosen.d'] = 2; }), /example chosen\.d/, 'worked example');
      has(run((g) => { const ex = g.example; ex.check.expect['chosen.d'] = 2; delete g.example; g.parts = [{ id: 'p1', title: 'Part', what: ['x'], example: ex }]; }),
        /orifice\.parts\[p1\]: example chosen\.d = 1\.875, guide says 2/, 'worked example inside a part');
      const okPart = run((g) => { const ex = g.example; delete g.example; g.parts = [{ id: 'p1', title: 'Part', what: ['x'], example: ex }]; });
      assert.ok(!okPart.some((m) => /example/.test(m)), 'a correct part example passes: ' + okPart.join(' | '));
      has(run((g) => { g.example = { title: 'Page', setup: ['x'], result: ['y'], check: { kind: 'page', set: { op_q: '50000' }, expectText: ['✗'] } }; g.verdicts = g.verdicts.filter((v) => v.match !== 'keeps the differential below'); }),
        /verdict "✗ .*" \(example\) matches no verdicts/, 'example page state is verdict-covered');
      has(run((g) => { g.inputs[1].text = 'Tube bore, 4.026 in.'; }), /bare measurement "4\.026 in"/, 'bare unit in the model guide');
      has(run((g) => { g.inputs[0].cat = 'gasRate'; }), /tagged gasRateSmall/, 'unit category');
      has(run((g) => { g.shots[1].callouts[0].sel = '#op_nothing'; }), /selector #op_nothing matches nothing/, 'shot selector');
    },
  },
];

module.exports = TESTS;
module.exports.lib = LIB;

if (require.main === module) {
  const i = process.argv.indexOf('--hash');
  if (i === -1) { console.log('usage: node prism-build/tests/help-content.test.js --hash <route>[,<route>…]'); process.exit(0); }
  String(process.argv[i + 1] || '').split(',').filter(Boolean).forEach((r) => {
    const t = srcTexts(r);
    console.log(r + '  reviewedSrc: ' + (srcHash(r) || '(no source found)') + (t.length ? '   from ' + t.map((x) => x.name).join(', ') : ''));
  });
}
