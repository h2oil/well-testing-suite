// 49-calc-help.js — Help & User Guide page (route help), WTS_help API, search and the guide renderer for screen and print
// (docs/HELP-GUIDE-PLAN.md §2, WP-H). Content: 48-calc-help-<group>.js factories in WTS_helpContent.factories, run once by
// load() (shapes: tests/_help-model.js). Images: WTS_helpManifest.files. Hooks H.printMenu(slot), H.onShow(view). No timers.
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var H = G.WTS_help = G.WTS_help || {};
  var C = G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
  if (!C.guides) C.guides = {};
  if (!C.factories) C.factories = [];
  var SITE = 'welltest.h2oil.co.uk', EMAIL = 'software@h2oil.co.uk';
  var ROUTE_RE = /^[a-z][a-z0-9_]{1,31}$/;
  var ALIAS = { dca: 'prism', pta: 'prism' }, NOROW = { releasenotes: 'Overview' };
  var LISTS = ['start', 'tasks', 'course', 'scenarios', 'faq'];
  var SECTIONS = [['what', 'What it does'], ['when', 'When to use it'], ['steps', 'Step by step'], ['inputs', 'Inputs'],
    ['results', 'Results and verdicts'], ['example', 'Worked example'], ['tips', 'Tips and pitfalls'],
    ['refs', 'Standards and references'], ['related', 'Related modules']];
  var FIELD_NOTE = 'PRiSM works in oilfield units (psia, hours, STB/d or Mscf/d, md, ft, cp, 1/psi). ' +
    'The Metric setting does not convert PRiSM inputs or results — enter and read values in these units.';
  var METRIC_LINE = 'In Metric mode the page shows the same values converted; the calculation is the same.';
  var VCLS = { '✓': 'ok', '⚠': 'warn', '✗': 'bad' };
  H.SECTIONS = SECTIONS;
  H.loadErrors = H.loadErrors || [];

  function _doc() { return typeof document !== 'undefined' ? document : null; }
  function byId(id) { var d = _doc(); return d && d.getElementById ? d.getElementById(id) : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function txt(e) { return String((e && e.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
  function pref(k, v) {
    try {
      if (v === undefined) return G.localStorage ? G.localStorage.getItem(k) : null;
      if (G.localStorage) G.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked */ }
    return null;
  }

  // — Content loading
  function load(force) {
    if (C._loaded && !force) return C;
    if (force) {
      C.guides = {}; LISTS.forEach(k => { C[k] = []; }); C.glossary = {};
      C.factories.forEach(f => { if (f) f._done = false; });
      H.loadErrors.length = 0;
    }
    LISTS.forEach(k => { if (!Array.isArray(C[k])) C[k] = []; });
    if (!C.glossary || typeof C.glossary !== 'object') C.glossary = {};
    C.factories.forEach((f, i) => {
      if (!f || typeof f.build !== 'function') { H.loadErrors.push('factory ' + i + ' has no build()'); return; }
      if (f._done) return;
      f._done = true;
      var out;
      try { out = f.build() || {}; } catch (e) { H.loadErrors.push((f.group || 'factory ' + i) + ': build() threw: ' + e.message); return; }
      var g = out.guides || {};
      Object.keys(g).forEach(r => {
        if (C.guides[r]) { H.loadErrors.push('duplicate guide "' + r + '" (' + C.guides[r]._group + ', ' + f.group + ')'); return; }
        if (!g[r] || typeof g[r] !== 'object') { H.loadErrors.push(f.group + ': guide "' + r + '" is not an object'); return; }
        try { Object.defineProperty(g[r], '_group', { value: f.group, enumerable: false, configurable: true }); } catch (e) { /* frozen */ }
        C.guides[r] = g[r];
      });
      LISTS.forEach(k => { arr(out[k]).forEach(x => { x._group = f.group; C[k].push(x); }); });
      var gl = out.glossary || {};
      Object.keys(gl).forEach(k => {
        if (C.glossary[k]) H.loadErrors.push('duplicate glossary term "' + k + '"'); else C.glossary[k] = gl[k];
      });
    });
    C._loaded = true;
    _index = null;
    return C;
  }
  function norm(r) { r = String(r || ''); return ALIAS[r] || r; }
  function hasGuide(r) {
    r = norm(r);
    if (C.guides[r]) return true;
    if (C._loaded) return false;
    var open = false, hit = C.factories.some(f => {
      if (!f) return false;
      if (!Array.isArray(f.routes)) { open = true; return false; }
      return f.routes.indexOf(r) !== -1;
    });
    if (!hit && open) { load(); return !!C.guides[r]; }
    return hit;
  }
  function hasStart() { return !!(C.start && C.start.length) || C.factories.some(f => f && f.group === 'start'); }
  function registry(r) { var R = G.WTS_calcRegistry; return R && R[r] ? R[r] : null; }
  function titleOf(r) {
    var g = C.guides[r], e = registry(r);
    if (g && g.title) return g.title;
    if (e && e.title) return e.title;
    var d = _doc(), b = d && d.querySelector ? d.querySelector('#sidebar .nav-btn[data-p="' + r + '"] span:last-child') : null;
    return b ? txt(b) : r;
  }
  function sidebarGroups() {
    var d = _doc(), out = [], seen = {};
    var groups = d && d.querySelectorAll ? Array.from(d.querySelectorAll('#sidebar .nav-group')) : [];
    groups.forEach(g => {
      var l = g.querySelector('.nav-group-label'), routes = [];
      Array.from(g.querySelectorAll('.nav-btn[data-p]')).forEach(b => {
        var r = norm(b.getAttribute('data-p'));
        if (!seen[r]) { seen[r] = 1; routes.push(r); }
      });
      out.push({ label: txt(l), routes: routes });
    });
    Object.keys(NOROW).forEach(r => { var g = out.filter(x => x.label === NOROW[r])[0]; if (g && !seen[r]) { seen[r] = 1; g.routes.push(r); } });
    var rest = Object.keys(C.guides).filter(r => !seen[r]);
    if (rest.length) out.push({ label: 'Other', routes: rest });
    return out;
  }

  // — Markup subset → HTML (content is escaped first; §2.8)
  function sysNow() { var U = G.WTS_units; return U && U.getSystem ? U.getSystem() : 'imperial'; }
  function dec(s) { var A = G.WTS_a11y; return (A && A.decimalComma && A.decimalComma()) ? String(s).replace(/\./g, ',') : String(s); }
  function numTxt(v, dp, metric) {
    if (!isFinite(v)) return '—';
    if (dp != null) return dec(v.toFixed(dp));
    if (!metric) return dec(String(v));
    var a = Math.abs(v);
    return dec(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  }
  function fmtU(v, cat, dp, mode) {
    var U = G.WTS_units, K = U && U.CATEGORIES && U.CATEGORIES[cat];
    var imp = numTxt(v, dp, false) + (K && K.imperial.label ? ' ' + K.imperial.label : '');
    if (!K || mode === 'imperial' || (mode !== 'both' && sysNow() !== 'metric')) return imp;
    var m = typeof U.convertCategory === 'function' ? U.convertCategory(v, cat, 'imperial', 'metric') : v;
    var met = numTxt(m, dp, true) + (K.metric.label ? ' ' + K.metric.label : '');
    if (mode === 'both') return imp === met ? imp : imp + ' (' + met + ')';
    return met;
  }
  H.fmtU = fmtU;
  function token(b, o) {
    var p = b.split('|');
    if (p[0] === 'site') return SITE;
    if (p[0] === 'email') return EMAIL;
    var v = parseFloat(p[0]);
    return esc(fmtU(v, p[1], p[2] != null && p[2] !== '' ? +p[2] : null, o.field ? 'imperial' : o.units));
  }
  function lk(go, lab, cur, sec) { return '<button type="button" class="help-a" data-help-go="' + esc(go) + '"' + (sec ? ' data-help-sec="' + esc(sec) + '"' : '') + (cur ? ' aria-current="true"' : '') + '>' + lab + '</button>'; }
  function linkHTML(target, label, o) {
    var t = String(target), i = t.indexOf('#'), r = i === -1 ? t : t.slice(0, i), sec = i === -1 ? '' : t.slice(i + 1);
    var lab = label;
    if (!lab) {
      lab = esc(/^(glossary|fs|task|course|start)$/.test(r) ? sec || r : titleOf(norm(r)));
    }
    return lk(r, lab, 0, sec);
  }
  function md(s, o, para) {
    o = o || {};
    var t = esc(s);
    t = t.replace(/\{\{([^{}]+)\}\}/g, (_, b) => token(b, o));
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => linkHTML(a, b, o));
    t = t.replace(/[①-⑨]/g, c => { var n = c.charCodeAt(0) - 0x245F; return '<span class="help-co" aria-label="call-out ' + n + '">' + n + '</span>'; });
    return t.split(/\n\s*\n/).join(para ? '</p><p>' : '<br><br>');
  }
  function paras(list, o) { return arr(list).map(p => '<p>' + md(p, o, 1) + '</p>').join(''); }
  function ul(list, o, cls) {
    list = arr(list);
    return list.length ? '<ul' + (cls ? ' class="' + cls + '"' : '') + '>' + list.map(x => li(md(x, o))).join('') + '</ul>' : '';
  }
  function table(head, rows, o) {
    return '<div class="help-tbl"><table><thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + md(c, o) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }
  // Blocks: string | {h} | {list, ordered} | {table:{head, rows}} | {details:{summary, body}} | {shot: id}
  function renderBlocks(blocks, o, shots, folder) {
    return arr(blocks).map(b => {
      if (typeof b === 'string') return '<p>' + md(b, o, 1) + '</p>';
      if (!b || typeof b !== 'object') return '';
      if (b.h) return '<h4>' + md(b.h, o) + '</h4>';
      if (b.list) return b.ordered ? '<ol>' + arr(b.list).map(x => li(md(x, o))).join('') + '</ol>' : ul(b.list, o);
      if (b.table) return table(arr(b.table.head), arr(b.table.rows), o);
      if (b.details) return '<details class="help-det"><summary>' + md(b.details.summary, o) + '</summary>' + renderBlocks(b.details.body, o, shots, folder) + '</details>';
      if (b.shot) { var s = arr(shots).filter(x => x.id === b.shot)[0]; return s ? shotHTML(folder, s, o) : ''; }
      return '';
    }).join('');
  }

  // — Screenshots
  function manifest() { var M = G.WTS_helpManifest; return (M && M.files) || {}; }
  function shotHTML(folder, s, o) {
    var M = manifest(), fd = folder + '/' + s.id + '-d.webp', fp = folder + '/' + s.id + '-p.webp';
    var d = M[fd], p = M[fp], cap = md(s.caption, o), alt = esc(s.alt);
    if (o.images === false) return '';
    var fig = '<figure class="help-fig" data-help-shot="' + esc(folder + '/' + s.id) + '">';
    if (!d && !p) return fig + missingBox(cap, alt) + '<figcaption>' + cap + '</figcaption></figure>';
    var base = o.imgBase == null ? 'help/img/' : o.imgBase;
    var src = (f, e) => (o.dataUris && o.dataUris[f]) || (base + f + '?v=' + esc(e.h8 || ''));
    var main = d || p, mf = d ? fd : fp;
    return fig + '<picture>' + (d && p ? '<source media="(max-width: 600px)" srcset="' + src(fp, p) + '" width="' + (+p.w || 0) + '" height="' + (+p.h || 0) + '">' : '') +
      '<img class="help-img" tabindex="0" role="button" src="' + src(mf, main) + '" width="' + (+main.w || 0) + '" height="' + (+main.h || 0) + '" alt="' + alt +
      '" loading="lazy" decoding="async"></picture>' +
      (!p && arr(s.callouts).length ? '<span class="help-enlarge">Select to enlarge</span>' : '') + '<figcaption>' + cap + '</figcaption></figure>';
  }
  function missingBox(cap, alt) { return '<div class="help-shot-missing" role="img" aria-label="' + alt + '"><b>Screenshot:</b> ' + cap + '<br><span>' + alt + '</span></div>'; }

  // — Guide renderer (D4)
  function vmark(m) { return '<span class="help-v help-v-' + (VCLS[m] || 'ok') + '">' + esc(m) + '</span>'; }
  function guideBody(r, g, o, hl, idp) {
    var h = '', used = {}, folder = r, shots = arr(g.shots);
    var sec = (id, n, body) => {
      if (!body) return '';
      var t = SECTIONS[n][1];
      return '<section class="help-sec" id="' + idp + '-' + id + '"><h' + hl + '>' + (o.print ? '' : (n + 1) + ' ') + esc(t) + '</h' + hl + '>' + body + '</section>';
    };
    if (g.purpose) h += '<p class="help-purpose">' + md(g.purpose, o) + '</p>';
    h += sec('what', 0, paras(g.what, o));
    h += sec('when', 1, ul(g.when, o));
    var st = arr(g.steps);
    if (st.length) {
      var b = '<ol class="help-steps">' + st.map(s => {
        var x = '<li>' + md(typeof s === 'string' ? s : s.t, o);
        if (s && s.shot && !used[s.shot]) {
          var sh = shots.filter(z => z.id === s.shot)[0];
          if (sh) { used[s.shot] = 1; x += shotHTML(folder, sh, o); }
        }
        return x + '</li>';
      }).join('') + '</ol>';
      b += shots.filter(z => !used[z.id] && !z.hidden).map(z => shotHTML(folder, z, o)).join('');
      h += sec('steps', 2, b);
    }
    var ins = arr(g.inputs);
    if (ins.length) h += sec('inputs', 3, table(['Input', 'Default', 'What to enter'], ins.map(i => [i.label, i.def || '', i.text || '']), o));
    var res = '';
    if (arr(g.outputs).length) res += table(['Result', 'Meaning'], arr(g.outputs).map(x => [x.label, x.text || '']), o);
    if (arr(g.verdicts).length) res += '<ul class="help-verdicts">' + arr(g.verdicts).map(v => '<li>' + vmark(v.mark) + ' ' + md(v.text, o) + '</li>').join('') + '</ul>';
    h += sec('results', 4, res);
    var ex = g.example;
    if (ex && (ex.title || arr(ex.setup).length)) {
      var eb = (ex.title ? '<p><b>' + md(ex.title, o) + '</b></p>' : '') + ul(ex.setup, o) + (arr(ex.result).length ? '<p>Result:</p>' + ul(ex.result, o) : '');
      if (g.units === 'dual' || !g.units) eb += '<p class="help-note">' + esc(METRIC_LINE) + '</p>';
      h += sec('example', 5, eb);
    }
    var tp = (arr(g.tips).length ? '<p><b>Tips</b></p>' + ul(g.tips, o) : '') + (arr(g.pitfalls).length ? '<p><b>Pitfalls</b></p>' + ul(g.pitfalls, o) : '');
    h += sec('tips', 6, tp);
    var refs = arr(g.refs).map(x => md(x.std, o) + (x.note ? ' — ' + md(x.note, o) : ''));
    h += sec('refs', 7, refs.length ? '<ul>' + refs.map(x => '<li>' + x + '</li>').join('') + '</ul>' : (g.noRefs ? '<p>' + md(g.noRefs, o) + '</p>' : ''));
    var rel = arr(g.related).map(x => linkHTML(x, '', o));
    h += sec('related', 8, rel.length ? '<p class="help-rel">' + rel.join(' · ') + '</p>' : '');
    return h;
  }
  function renderGuide(route, opts) {
    load();
    var r = norm(route), g = C.guides[r];
    var o = Object.assign({ units: 'current' }, opts || {});
    if (!g) return '';
    o.field = g.units === 'field';
    var idp = 'help-' + r, hl = o.headings || 3, title = titleOf(r);
    var h = '<article class="help-guide" data-help-route="' + esc(r) + '"><h' + (hl - 1) + ' class="help-h" id="' + idp + '-top" tabindex="-1">' + esc(title) + '</h' + (hl - 1) + '>';
    if (!o.print) {
      var grp = (sidebarGroups().filter(x => x.routes.indexOf(r) !== -1)[0] || {}).label || '';
      h += '<p class="help-meta">' + (grp ? esc(grp) + ' · ' : '') + (r === 'help' ? '' : '<button type="button" class="help-a" data-help-open="' + esc(r) + '">Open this page →</button>') + '</p>';
    }
    if (o.field) h += '<p class="help-note" role="note">' + md(g.notice || FIELD_NOTE, o) + '</p>';
    h += guideBody(r, g, o, hl, idp);
    arr(g.parts).forEach(p => {
      if (!p || !p.id) return;
      h += '<section class="help-part" id="' + idp + '-' + esc(p.id) + '"><h' + hl + '>' + md(p.title || p.id, o) + '</h' + hl + '>' +
        guideBody(r, Object.assign({ units: g.units, shots: g.shots }, p), o, hl + 1, idp + '-' + esc(p.id)) + '</section>';
    });
    if (g.reviewed) h += '<p class="help-rev">Reviewed for ' + esc(g.reviewed) + '</p>';
    return h + '</article>';
  }

  // — Search (§2.4)
  var SYN = [['burner', 'flare'], ['bean', 'choke'], ['gauge tank', 'tank'], ['cushion', 'clean-up', 'cleanup', 'unload'],
    ['sithp', 'shut-in pressure'], ['bs&w', 'water cut'], ['psv', 'relief', 'safety valve'], ['gor', 'gas-oil ratio', 'gas oil ratio'],
    ['aof', 'absolute open flow'], ['ipr', 'inflow performance'], ['dp', 'differential'], ['h2s', 'sour'], ['mmscfd', 'gas rate'],
    ['esd', 'emergency shutdown', 'shutdown'], ['bottoms up', 'bottoms-up', 'lag time']];
  var PRESS = ['production pressure', 'fwhp', 'fthp', 'flowing pressure', 'tubing pressure', 'line pressure', 'export pressure', 'back pressure'];
  var _index = null;
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function plain(s) { return String(s == null ? '' : s).replace(/\{\{([^|}]+)\|[^}]*\}\}/g, '$1').replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*`]/g, ''); }
  function blocksText(b) {
    return arr(b).map(x => {
      if (typeof x === 'string') return x;
      if (!x) return '';
      if (x.h) return x.h;
      if (x.list) return arr(x.list).join(' ');
      if (x.table) return arr(x.table.head).concat([].concat.apply([], arr(x.table.rows))).join(' ');
      if (x.details) return x.details.summary + ' ' + blocksText(x.details.body);
      return '';
    }).join(' ');
  }
  function J(a, k) { return arr(a).map(x => typeof x === 'string' ? x : (x && x[k]) || '').join(' ; '); }
  // Entries: { kind, id, route, sec, title, module, f: [{ w, t, l, sec }] }
  function buildIndex() {
    load();
    var out = [], seen = {};
    var add = (kind, id, title, mod, f, route, sec) => {
      out.push({ kind: kind, id: id, route: route, sec: sec || '', title: title, module: mod, order: out.length,
        f: f.map(a => { var t = plain(a[1]); return { w: a[0], t: t, l: low(t), sec: a[2] }; }).filter(x => x.t) });
    };
    arr(C.tasks).forEach(t => { add('task', t.id, t.title, 'How do I…', [['task', t.title], ['body', t.purpose + ' ' + J(t.steps, 't') + ' ' + J(t.steps, 'carry')]]); });
    guideGroups().forEach(gr => {
      gr.routes.forEach(r => {
        var g = C.guides[r], t = titleOf(r);
        if (seen[r]) return;
        seen[r] = 1;
        [g].concat(arr(g.parts)).forEach((x, i) => {
          if (!x || (i && !x.id)) return;
          add('guide', r, i ? t + ' — ' + plain(x.title || x.id) : t, gr.label, [['title', i ? x.title || x.id : t], ['kw', J(x.keywords)],
            ['body', (x.purpose || '') + ' ' + J(x.what), 'what'], ['body', J(x.when), 'when'], ['body', J(x.steps, 't'), 'steps'], ['label', J(x.inputs, 'label'), 'inputs'],
            ['body', J(x.inputs, 'text'), 'inputs'], ['label', J(x.outputs, 'label'), 'results'], ['body', J(x.verdicts, 'text'), 'results'], ['std', J(x.refs, 'std'), 'refs'],
            ['body', J(arr(x.tips).concat(arr(x.pitfalls))), 'tips']], r, i ? x.id : '');
        });
      });
    });
    arr(C.start).forEach(s => { add('start', s.id, s.title, 'Getting started', [['title', s.title], ['body', blocksText(s.body)]]); });
    arr(C.scenarios).forEach(s => { add('scenario', s.id, s.id + ' ' + s.title, 'Field scenarios', [['title', s.title], ['kw', J(s.keywords)], ['body', blocksText([].concat(arr(s.intro), arr(s.blocks), arr(s.today)))]]); });
    arr(C.course).forEach(x => { add('course', x.id, x.title, 'Simulator course', [['title', x.title], ['kw', J(x.keywords)], ['body', [x.goal].concat(arr(x.setup), arr(x.steps), arr(x.observe), arr(x.questions)).join(' ')]]); });
    arr(C.faq).forEach(x => { add('faq', x.id, x.q, 'FAQ', [['title', x.q], ['body', blocksText(x.a)]]); });
    Object.keys(C.glossary || {}).forEach(k => { var e = C.glossary[k] || {}; add('glossary', k, e.term || k, 'Glossary', [['title', e.term || k], ['kw', J(e.variants)], ['body', e.def]]); });
    return out;
  }
  // §2.4 weights per field class: phrase / synonym in full, else words (title pro rata; others 60 % all, 30 % pro rata),
  // +2 when the entry has every word. Terms under 5 characters match whole words.
  var W = { task: 8, title: 6, kw: 5, label: 3, std: 3, body: 1 }, STOP = ' the and for how what with from to of in on an is do my ', _re = {};
  function has(l, t) {
    if (t.length >= 5) return l.indexOf(t) !== -1;
    var re = _re[t] || (_re[t] = new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)'));
    return re.test(l);
  }
  function terms(ql) {
    var t = [ql];
    SYN.forEach(grp => { if (grp.some(s => has(ql, s))) grp.forEach(s => { if (t.indexOf(s) === -1) t.push(s); }); });
    return t;
  }
  function search(q) {
    var ql = low(q).replace(/\s+/g, ' ').trim();
    if (!ql) return [];
    if (!_index) _index = buildIndex();
    var tm = terms(ql), words = ql.split(' ').filter(w => w.length > 1 && STOP.indexOf(' ' + w + ' ') === -1), nw = words.length > 1 ? words.length : 0;
    var press = PRESS.some(s => has(ql, s));
    var hits = [];
    _index.forEach(e => {
      var sc = 0, at = null, best = 0, cls = {}, seen = {};
      if (low(plain(e.title)) === ql) sc += 10;
      e.f.forEach(f => {
        var w = W[f.w] || 0, n = 0, v;
        if (tm.some(t => has(f.l, t))) v = w + 0.01;
        else {
          if (nw) words.forEach(x => { if (has(f.l, x)) { n++; seen[x] = 1; } });
          v = !n ? 0 : f.w === 'title' || f.w === 'task' ? w * n / nw : w * (n === nw ? 0.6 : 0.3 * n / nw);
        }
        if (v > (cls[f.w] || 0)) cls[f.w] = v;
        if (v > best) { best = v; at = f; }
      });
      Object.keys(cls).forEach(k => { sc += cls[k]; });
      if (nw && Object.keys(seen).length === nw) sc += 2;
      if (press && ((e.kind === 'scenario' && /^FS-[12]$/.test(e.id)) || (e.kind === 'guide' && e.route === 'wts' && e.sec === 'inputs'))) { sc += e.kind === 'scenario' ? 8 : 5; }
      if (sc > 0) hits.push({ e: e, sc: Math.round(sc * 100) / 100, at: at });
    });
    hits.sort((a, b) => b.sc - a.sc || a.e.order - b.e.order);
    return hits.slice(0, 20).map(h => {
      var e = h.e, f = h.at || e.f[0] || { t: '' }, s = f.sec || '';
      return { kind: e.kind, id: e.id, route: e.route || null, sec: e.sec && s ? e.sec + '-' + s : s || e.sec || '', title: e.title, module: e.module,
        secName: s ? (SECTIONS.filter(x => x[0] === s)[0] || [0, ''])[1] : '', snippet: snippet(f.t, tm.concat(words)), score: h.sc };
    });
  }
  // Marks found on the raw text, pieces escaped one by one (no mark inside an entity).
  function snippet(t, tm) {
    var l = low(t), at = -1, mk = [], out = '', pos = 0;
    tm.forEach(x => { var i = l.indexOf(x); if (i !== -1 && (at === -1 || i < at)) at = i; });
    var a = Math.max(0, at - 40), s = t.slice(a, a + 120), sl = low(s);
    tm.forEach(x => { for (var i = sl.indexOf(x); x && i !== -1; i = sl.indexOf(x, i + 1)) mk.push([i, i + x.length]); });
    mk.sort((p, q) => p[0] - q[0]).forEach(m => {
      if (m[1] <= pos) return;
      var b = Math.max(m[0], pos);
      out += esc(s.slice(pos, b)) + '<mark>' + esc(s.slice(b, m[1])) + '</mark>';
      pos = m[1];
    });
    return (a > 0 ? '…' : '') + out + esc(s.slice(pos)) + (a + 120 < t.length ? '…' : '');
  }

  // — Page
  var _cur = 'clientinfo', _pending = null, _from = null, _view = null, _opener = null, _sel = -1, _results = [];
  var CSS = '<style>.help{--hb:1px solid var(--border)}' +
    '.help-bar{position:sticky;top:0;z-index:5;background:var(--bg0);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:6px 0 10px}' +
    '#help_q{flex:1 1 240px;min-width:0;max-width:420px}.help-links{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:13px}' +
    '.help-a{background:none;border:0;padding:2px 0;color:var(--accent);font:inherit;cursor:pointer;text-decoration:underline;text-align:left}' +
    '.help-cols{display:grid;grid-template-columns:230px minmax(0,1fr);gap:24px;align-items:start}.help-toc>summary{display:none}' +
    '.help-toc ul{list-style:none;margin:0 0 10px;padding:0}.help-tg{font-weight:600;color:var(--text2);font-size:12px;margin:10px 0 4px}' +
    '.help-toc .help-a{text-decoration:none;color:var(--text);font-size:13px}.help-toc [aria-current]{color:var(--accent);font-weight:600}' +
    '.help-main{min-width:0;max-width:880px;line-height:1.55}.help-sec,.help-part{margin:18px 0}.help-meta,.help-rev,.help-note,.help figcaption{color:var(--text2);font-size:13px}' +
    '.help-tbl{overflow-x:auto;margin:8px 0}.help-tbl table{border-collapse:collapse;width:100%;font-size:13px}.help-tbl th,.help-tbl td{border:var(--hb);padding:5px 8px;text-align:left;vertical-align:top}' +
    '.help-fig img{max-width:100%;height:auto;border:var(--hb);border-radius:6px;cursor:zoom-in}.help-enlarge{display:none;font-size:12px}' +
    '.help-co{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#f0b429;color:#111;font-weight:700;font-size:11px;line-height:1}' +
    '.help-shot-missing{border:1px dashed var(--border);padding:10px;border-radius:6px;color:var(--text2);font-size:13px}' +
    '.help-v{font-weight:700}.help-v-ok{color:var(--green)}.help-v-warn{color:var(--yellow)}.help-v-bad{color:var(--red)}' +
    '#help_res{margin:0 0 12px;border:var(--hb);border-radius:6px;max-width:880px}#help_res [role=option]{padding:6px 10px;cursor:pointer;border-bottom:var(--hb)}' +
    '#help_res [aria-selected=true]{background:var(--bg3);outline:2px solid var(--accent)}.help mark{background:#f0b42966;color:inherit}' +
    '.help-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.help-tile{border:var(--hb);border-radius:8px;padding:10px;background:var(--bg1)}' +
    '#help_lb{max-width:96vw;max-height:96vh;padding:12px;border:var(--hb);background:var(--bg1);color:var(--text);overflow:auto}#help_lb img{max-width:100%;height:auto}' +
    '#help_lb::backdrop{background:rgba(0,0,0,.7)}#help_lb_x{float:right;min-width:32px;min-height:32px}' +
    '@media (max-width:700px){.help-cols{grid-template-columns:minmax(0,1fr)}.help-toc>summary{display:list-item;font-weight:600}}' +
    '@media (max-width:600px){.help-enlarge{display:block}}</style>';
  function shellHTML() {
    var phone = false;
    try { phone = !!(G.matchMedia && G.matchMedia('(max-width: 700px)').matches); } catch (e) { phone = false; }
    load();
    var links = [lk('landing', 'Help home')];
    if (hasStart()) links.push(lk('start', 'Getting started'));
    if (C.course.length) links.push(lk('course', 'Simulator course'));
    if (C.scenarios.length) links.push(lk('scenarios', 'Field scenarios'));
    return '<div id="help_root" class="help rp-skip" data-rp-nosnap data-no-persist>' + CSS +
      '<div class="help-bar" role="search"><input type="search" role="combobox" id="help_q" placeholder="Search help (/)" aria-label="Search help" autocomplete="off" spellcheck="false"' +
      ' data-no-persist aria-controls="help_res" aria-autocomplete="list" aria-expanded="false">' +
      '<span class="help-links">' + links.join(' · ') + '<span id="help_print_slot"></span>' +
      '<button type="button" class="help-a" id="help_back" hidden>← Back to <span id="help_back_t"></span></button></span></div>' +
      '<div id="help_res" role="listbox" aria-label="Search results" hidden></div>' +
      '<div class="help-cols"><details class="help-toc" id="help_toc"' + (phone ? '' : ' open') + '><summary>Contents</summary><nav aria-label="Help contents" id="help_toc_nav"></nav></details>' +
      '<div id="help_main" class="help-main"></div></div>' +
      '<dialog id="help_lb" class="help-lb" aria-label="Screenshot"><button type="button" id="help_lb_x" aria-label="Close">✕</button>' +
      '<img id="help_lb_img" alt=""><p id="help_lb_cap"></p></dialog></div>';
  }
  var TR = [['course', 'Well Test Simulator course'], ['scenarios', 'Field scenarios'], ['glossary', 'Glossary'], ['faq', 'Troubleshooting and FAQ']];
  function trAvail(k) { return k === 'glossary' ? Object.keys(C.glossary).length : C[k].length; }
  function guideGroups() { return sidebarGroups().map(g => { return { label: g.label, routes: g.routes.filter(r => !!C.guides[r]) }; }).filter(g => g.routes.length); }
  function li(x) { return '<li>' + x + '</li>'; }
  function tocHTML(active) {
    var h = hasStart() ? '<ul>' + li(lk('start', 'Getting started', active === 'start')) + (C.tasks.length ? li(lk('tasks', 'How do I…', active === 'tasks')) : '') + '</ul>' : '';
    guideGroups().forEach(g => {
      h += '<div class="help-tg">' + esc(g.label) + '</div><ul>' + g.routes.map(r => li(lk(r, esc(titleOf(r)), active === r))).join('') + '</ul>';
    });
    var tr = TR.filter(t => trAvail(t[0])).map(t => li(lk(t[0], t[1], active === t[0])));
    return h + (tr.length ? '<div class="help-tg">Training and reference</div><ul>' + tr.join('') + '</ul>' : '');
  }
  function landingHTML() {
    var h = '<h2 class="help-h" id="help-landing" tabindex="-1">Help &amp; User Guide</h2><p>How to use each module: what it does, the steps, every input and verdict, ' +
      'a worked example and the standards behind it. Search above, or pick a module.</p>', last = pref('wtspref_help_last');
    if (last && ROUTE_RE.test(last) && C.guides[last]) h += '<p>Continue: ' + lk(last, esc(titleOf(last))) + '</p>';
    if (C.tasks.length) h += '<h3>How do I…</h3><ul>' + C.tasks.map(t => li(lk('task', md(t.title), 0, t.id))).join('') + '</ul>';
    h += '<h3>Modules</h3><div class="help-tiles">' + guideGroups().map(g => {
      return '<div class="help-tile"><b>' + esc(g.label) + '</b><br>' + g.routes.map(r => lk(r, esc(titleOf(r)))).join('<br>') + '</div>';
    }).join('') + '</div>';
    if (!Object.keys(C.guides).length) h += '<p class="help-note">No guides are installed in this build yet.</p>';
    var tr = TR.slice(0, 2).filter(t => trAvail(t[0])).map(t => lk(t[0], t[1]));
    if (tr.length) h += '<h3>Training</h3><p>' + tr.join(' · ') + '</p>';
    var M = manifest(), keys = Object.keys(M);
    if (keys.length) {
      var mb = keys.reduce((a, k) => a + (+M[k].bytes || 0), 0) / 1048576;
      h += '<p><button type="button" class="btn btn-secondary" id="help_offline">Download screenshots for offline use (≈ ' + (Math.round(mb * 10) / 10) +
        ' MB)</button> <span id="help_off_msg" class="help-note">' + (pref('wtspref_help_offline') === '1' ? 'Downloaded earlier on this device.' : '') + '</span></p>';
    }
    return h;
  }
  function secHTML(id, title, body) { return '<section class="help-sec" id="' + id + '"><h3>' + title + '</h3>' + body + '</section>'; }
  function det(sum, body) { return body ? '<details class="help-det"><summary>' + sum + '</summary>' + body + '</details>' : ''; }
  function sub(t, list, o) { return arr(list).length ? '<h4>' + t + '</h4>' + ul(list, o) : ''; }
  function pb(t, v, o) { return v ? '<p><b>' + t + ':</b> ' + md(v, o) + '</p>' : ''; }
  // o.worksheet: no answers or trainer notes (print).
  function exerciseHTML(x, i, o) {
    var tn = x.trainer || {};
    return secHTML('help-course-' + esc(x.id), (i + 1) + ' ' + md(x.title, o), pb('Goal', x.goal, o) + sub('Set-up', x.setup, o) +
      (arr(x.steps).length ? '<h4>Steps</h4><ol>' + arr(x.steps).map(s => li(md(s, o))).join('') + '</ol>' : '') +
      sub('What to observe', x.observe, o) + sub('Questions', x.questions, o) + renderBlocks(x.blocks, o, x.shots, 'course') +
      (o.worksheet ? '' : det('Answers', ul(x.answers, o)) + det('For the trainer', x.trainer ? pb('Duration', tn.duration, o) + pb('Fault to inject', tn.fault, o) +
        pb('A good response', tn.good, o) + sub('Common mistakes', tn.mistakes, o) + sub('Debrief questions', tn.debrief, o) : '')));
  }
  var LT = { start: 'Getting started', tasks: 'How do I…', course: 'Well Test Simulator course', scenarios: 'Field scenarios', glossary: 'Glossary', faq: 'Troubleshooting and FAQ' };
  function listView(kind, o) {
    o = o || {};
    var h = '<h2 class="help-h" id="help-' + kind + '" tabindex="-1">' + esc(LT[kind]) + '</h2>', F = (G.WTS_sim && G.WTS_sim.features) || {};
    if (kind === 'start') C.start.forEach(s => { h += secHTML('help-start-' + esc(s.id), md(s.title, o), renderBlocks(s.body, o, s.shots, 'start')); });
    if (kind === 'tasks') C.tasks.forEach(t => {
      h += secHTML('help-task-' + esc(t.id), md(t.title, o), '<p>' + md(t.purpose, o) + '</p><ol>' + arr(t.steps).map(s => {
        return li((s.route ? linkHTML(s.route, '', o) + ': ' : '') + md(s.t || '', o) + (s.carry ? ' <span class="help-note">Carry: ' + md(s.carry, o) + '</span>' : ''));
      }).join('') + '</ol>');
    });
    if (kind === 'scenarios') C.scenarios.forEach(s => {
      var after = s.feature && F[s.feature] && s.afterSim;
      h += secHTML('help-fs-' + esc(s.id), esc(s.id) + ' ' + md(s.title, o), [s.intro, s.blocks, after ? s.afterSim : s.today].map(b => renderBlocks(b, o, s.shots, 'scenarios')).join(''));
    });
    if (kind === 'course') C.course.forEach((x, i) => { h += exerciseHTML(x, i, o); });
    if (kind === 'glossary') h += '<dl>' + Object.keys(C.glossary).sort().map(k => {
      var e = C.glossary[k] || {};
      return '<dt id="help-glossary-' + esc(k) + '"><b>' + esc(e.term || k) + '</b></dt><dd>' + md(e.def || '', o) + '</dd>';
    }).join('') + '</dl>';
    if (kind === 'faq') C.faq.forEach(x => { h += secHTML('help-faq-' + esc(x.id), md(x.q, o), renderBlocks(x.a, o)); });
    return h;
  }
  H.renderList = listView; H.renderExercise = exerciseHTML;
  var KINDS = { start: 'start', tasks: 'tasks', task: 'tasks', course: 'course', scenarios: 'scenarios', fs: 'scenarios', glossary: 'glossary', faq: 'faq' };
  var SECP = { tasks: 'task', scenarios: 'fs' };
  function show(v, noFocus) {
    var main = byId('help_main');
    if (!main) return;
    v = v || { kind: 'landing' };
    if (v.kind === 'guide' && !C.guides[v.route]) v = { kind: 'landing' };
    _view = v;
    var h;
    if (v.kind === 'guide') { h = renderGuide(v.route); pref('wtspref_help_last', v.route); }
    else if (KINDS[v.kind]) h = listView(KINDS[v.kind]);
    else h = landingHTML();
    main.innerHTML = h;
    var nav = byId('help_toc_nav');
    if (nav) nav.innerHTML = tocHTML(v.kind === 'guide' ? v.route : v.kind);
    var k = KINDS[v.kind];
    var target = v.sec ? byId(v.kind === 'guide' ? 'help-' + v.route + '-' + v.sec : 'help-' + (SECP[k] || k) + '-' + v.sec) : null;
    var hd = target ? (target.querySelector('h2,h3,h4,b') || target) : main.querySelector('.help-h');
    if (target && target.scrollIntoView) { try { target.scrollIntoView({ block: 'start' }); } catch (e) { /* layout-free */ } }
    if (hd && !noFocus) { if (!hd.hasAttribute('tabindex')) hd.setAttribute('tabindex', '-1'); if (hd.focus) hd.focus(); }
    if (typeof H.onShow === 'function') { try { H.onShow(v); } catch (e) { /* print module */ } }
  }
  function goTo(r, sec) {
    if (r === 'landing') return show({ kind: 'landing' });
    if (KINDS[r]) return show({ kind: r, sec: sec || '' });
    return show({ kind: 'guide', route: norm(r), sec: sec || '' });
  }
  H.show = show; H.goTo = goTo;
  function renderResults() {
    var box = byId('help_res'), q = byId('help_q');
    if (!box) return;
    if (!_results.length) {
      box.innerHTML = q && q.value.trim() ? '<div class="help-note" style="padding:6px 10px">No help topic matches.</div>' : '';
      box.hidden = !(q && q.value.trim());
    } else {
      box.innerHTML = _results.map((r, i) => {
        return '<div role="option" id="help_opt_' + i + '" data-i="' + i + '" aria-selected="' + (i === _sel ? 'true' : 'false') + '"><b>' + esc(plain(r.title)) + '</b> <small>' + esc(r.module + (r.secName ? ' · ' + r.secName : '')) + '</small><br><small>' + r.snippet + '</small></div>';
      }).join('');
      box.hidden = false;
    }
    if (q) {
      q.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
      if (_sel >= 0 && _results[_sel]) q.setAttribute('aria-activedescendant', 'help_opt_' + _sel); else q.removeAttribute('aria-activedescendant');
    }
  }
  function openResult(i) {
    var r = _results[i];
    if (!r) return;
    var box = byId('help_res'); if (box) box.hidden = true;
    if (r.kind === 'guide') goTo(r.route, r.sec);
    else goTo({ task: 'tasks', scenario: 'scenarios', course: 'course', faq: 'faq', glossary: 'glossary', start: 'start' }[r.kind], r.id);
  }
  function openLightbox(img) {
    var d = byId('help_lb'), im = byId('help_lb_img'), cap = byId('help_lb_cap');
    if (!d || !im) return;
    _opener = img;
    im.setAttribute('src', img.currentSrc || img.getAttribute('src'));
    im.setAttribute('alt', img.getAttribute('alt') || '');
    var fc = img.closest('figure') && img.closest('figure').querySelector('figcaption');
    if (cap) cap.textContent = fc ? txt(fc) : '';
    if (typeof d.showModal === 'function') { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } } else d.setAttribute('open', '');
    var x = byId('help_lb_x'); if (x && x.focus) x.focus();
  }
  function closeLightbox() {
    var d = byId('help_lb');
    if (!d) return;
    if (typeof d.close === 'function' && d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } } else d.removeAttribute('open');
    if (_opener && _opener.focus) _opener.focus();
    _opener = null;
  }
  function offlineDownload(btn) {
    var M = manifest(), keys = Object.keys(M).sort(), msg = byId('help_off_msg'), i = 0, bad = 0;
    if (typeof G.fetch !== 'function') { if (msg) msg.textContent = 'Downloading is not available here.'; return; }
    btn.disabled = true;
    var next = () => {
      if (i >= keys.length) {
        btn.disabled = false;
        if (msg) msg.textContent = bad ? (keys.length - bad) + ' of ' + keys.length + ' screenshots saved; ' + bad + ' could not be loaded.' : 'All ' + keys.length + ' screenshots are saved for offline use.';
        if (!bad) pref('wtspref_help_offline', '1');
        return;
      }
      var k = keys[i++];
      if (msg) msg.textContent = 'Downloading ' + i + ' of ' + keys.length + '…';
      G.fetch('help/img/' + k + '?v=' + (M[k].h8 || '')).then(r => { if (!r.ok) bad++; }, () => { bad++; }).then(next);
    };
    next();
  }
  function wire(root) {
    root.addEventListener('click', e => {
      var t = e.target;
      if (!t || !t.closest) return;
      var go = t.closest('[data-help-go]');
      if (go) { e.preventDefault(); goTo(go.getAttribute('data-help-go'), go.getAttribute('data-help-sec')); return; }
      var op = t.closest('[data-help-open]');
      if (op) { e.preventDefault(); if (G.WTS_nav) G.WTS_nav(op.getAttribute('data-help-open')); return; }
      var opt = t.closest('#help_res [role=option]');
      if (opt) { openResult(+opt.getAttribute('data-i')); return; }
      if (t.closest('#help_back')) { back(); return; }
      if (t.closest('#help_lb_x')) { closeLightbox(); return; }
      if (t.closest('#help_offline')) { offlineDownload(t.closest('#help_offline')); return; }
      var img = t.closest('img.help-img');
      if (img) openLightbox(img);
    });
    root.addEventListener('keydown', e => {
      var t = e.target;
      if (t && t.id === 'help_q') {
        var n = _results.length;
        if (e.key === 'ArrowDown' && n) { e.preventDefault(); _sel = (_sel + 1) % n; renderResults(); }
        else if (e.key === 'ArrowUp' && n) { e.preventDefault(); _sel = (_sel - 1 + n) % n; renderResults(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (n) openResult(_sel >= 0 ? _sel : 0); }
        else if (e.key === 'Escape') { e.preventDefault(); t.value = ''; _results = []; _sel = -1; renderResults(); }
        return;
      }
      if (t && t.classList && t.classList.contains('help-img') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLightbox(t); return; }
      if (e.key === 'Escape' && byId('help_lb') && byId('help_lb').hasAttribute('open')) { e.preventDefault(); closeLightbox(); }
    });
    root.addEventListener('input', e => {
      if (!e.target || e.target.id !== 'help_q') return;
      _results = search(e.target.value); _sel = -1; renderResults();
    });
    var lb = byId('help_lb');
    if (lb) lb.addEventListener('close', () => { if (_opener && _opener.focus) _opener.focus(); _opener = null; });
    // A failed screenshot becomes a caption box (§3.2).
    root.addEventListener('error', e => {
      var img = e.target;
      if (!img || !img.classList || !img.classList.contains('help-img')) return;
      var fig = img.closest('figure'), pic = img.closest('picture') || img;
      var fc = fig && fig.querySelector('figcaption');
      var box = _doc().createElement('div');
      box.innerHTML = missingBox(fc ? esc(txt(fc)) : '', esc(img.getAttribute('alt') || ''));
      if (pic.parentNode) pic.parentNode.replaceChild(box.firstChild, pic);
      var main = byId('help_main');
      if (main && !byId('help_noimg')) {
        var n = _doc().createElement('p');
        n.id = 'help_noimg'; n.className = 'help-note'; n.setAttribute('role', 'note');
        n.textContent = 'Screenshots are not available in this copy. They load from ' + SITE + ' or the iOS app.';
        main.insertBefore(n, main.firstChild);
      }
    }, true);
  }
  function back() {
    var to = _from;
    _from = null;
    if (!to || !G.WTS_nav) return;
    G.WTS_nav(to);
    var b = byId('pgHelpBtn');
    if (b && b.focus && !b.hasAttribute('hidden')) b.focus();
  }
  function mount(body) {
    if (!body) return;
    load();
    body.innerHTML = shellHTML();
    var root = byId('help_root');
    if (root && root.addEventListener) wire(root);
    var t = _pending;
    _pending = null;
    _from = t && t.from && t.from !== 'help' ? t.from : null;
    var bk = byId('help_back'), bt = byId('help_back_t');
    if (bk) bk.hidden = !_from;
    if (bt && _from) bt.textContent = _from === 'home' ? 'Dashboard' : titleOf(_from);
    if (typeof H.printMenu === 'function') { try { H.printMenu(byId('help_print_slot')); } catch (e) { /* print module */ } }
    if (!t) return show({ kind: 'landing' }, true);
    show(viewFor(t));
  }
  function viewFor(t) { var c = t.ctx || {}; return t.route === 'home' ? { kind: hasStart() ? 'start' : 'landing' } : { kind: 'guide', route: t.route, sec: c.section || c.part || '' }; }
  function open(route, ctx) {
    route = norm(route || _cur);
    _pending = { route: route, ctx: ctx || {}, from: _cur !== 'help' ? _cur : _from };
    if (_cur === 'help' && byId('help_root')) { var t = _pending; _pending = null; return show(viewFor(t)); }
    if (typeof G.WTS_nav === 'function') G.WTS_nav('help');
    else { var b = byId('pgBody'); if (b) mount(b); }
  }
  function ctxFor(page) {
    if (norm(page) === 'prism') {
      var s = 0;
      try { s = typeof G.PRiSM_currentStep === 'function' ? G.PRiSM_currentStep() : 0; } catch (e) { s = 0; }
      return byId('prism_tools_drawer') ? { section: 'tools' } : s ? { section: 'step-' + s } : {};
    }
    if (page === 'wts') return { part: 'reference' };
    return {};
  }
  function openCurrent() {
    if (_cur === 'help') return;
    if (_cur === 'home' ? !hasStart() : !hasGuide(_cur)) return;
    open(_cur, ctxFor(_cur));
  }
  function syncHeader(page) {
    if (page) _cur = String(page);
    var b = byId('pgHelpBtn');
    if (!b) return false;
    var on = _cur !== 'help' && (_cur === 'home' ? hasStart() : hasGuide(_cur));
    if (on) b.removeAttribute('hidden'); else b.setAttribute('hidden', '');
    var t = byId('pgTitle');
    b.setAttribute('aria-label', 'Help: ' + (_cur === 'home' ? 'Getting started' : (t ? txt(t) : titleOf(_cur))));
    return on;
  }
  Object.assign(H, { load: load, open: open, mount: mount, renderGuide: renderGuide, renderBlocks: renderBlocks, md: md, esc: esc,
    titleOf: titleOf, search: search, terms: terms, syncHeader: syncHeader, hasGuide: hasGuide, sidebarGroups: sidebarGroups,
    current: () => _cur, view: () => _view });

  var d0 = _doc();
  if (d0 && typeof d0.addEventListener === 'function') {
    d0.addEventListener('h2oil:pagechange', e => { syncHeader((e && e.detail && e.detail.page) || _cur); });
    d0.addEventListener('click', e => {
      var t = e.target;
      if (t && t.closest && t.closest('#pgHelpBtn')) { e.preventDefault(); openCurrent(); }
    });
    d0.addEventListener('keydown', e => {
      if (e.key === 'F1') { e.preventDefault(); openCurrent(); return; }
      if (e.key === '/' && _cur === 'help' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var a = d0.activeElement, tag = a && a.tagName ? a.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (a && a.isContentEditable)) return;
        var q = byId('help_q');
        if (q && q.focus) { e.preventDefault(); q.focus(); }
      }
    });
  }

  G.WTS_calcRegistry = G.WTS_calcRegistry || {};
  G.WTS_calcRegistry.help = {
    key: 'help', title: 'Help & User Guide', navTitle: 'Help & Guide',
    sub: 'How to use each module, the simulator course and field scenarios',
    group: 'Overview', icon: '?', desc: 'Guides, screenshots, training course and printable user guide',
    badge: 'Help', bc: 'dc-b-green',
    hooks: { store: () => true },   // no wts_page_help
    render: body => { G.WTS_help.mount(body); }
  };
})();

// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis, H = G.WTS_help;
  var fails = [];
  var m = H.md('a <b> & **x** `c` {{site}} ①');
  if (m.indexOf('&lt;b&gt;') === -1 || m.indexOf('<b>x</b>') === -1 || m.indexOf('<code>c</code>') === -1 || m.indexOf('welltest.h2oil.co.uk') === -1 || m.indexOf('help-co') === -1) fails.push('md');
  if (H.fmtU(150, 'nope', null, 'both') !== '150') fails.push('fmtU unknown category');
  if (fails.length) throw new Error('[49-calc-help] self-test: ' + fails.join(', '));
})();
