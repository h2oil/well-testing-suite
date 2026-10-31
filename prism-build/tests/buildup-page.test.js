// Build-up Surveillance — the page (49-calc-buildup.js), plan §6, §3.12, §8.3, §9 WP6 PG1–PG20.
//
// ENGINE STUBS. The page codes against §3 (WTS_buildup.run / review / synth / data, PRiSM_autoInterp.drive /
// interpretJob). Engines that are not merged yet are replaced, per module and only when missing, by explicit
// stubs evaluated in the app realm (STUBS below):
//   • PRiSM_autoInterp.drive        — the §4.8 driver (setTimeout(0) chain, CANCELLED on cancel);
//   • PRiSM_autoInterp.interpretJob — a 2-step Job returning FIX.result (so tests can count calls);
//   • WTS_buildup.run               — analyseAsync / analyse / job / inputHash: FIX.analysis with the page's
//                                     input applied (well, settings, zones, overrides, k scaled by 50/h), per-test
//                                     cache keyed on window/model overrides (RU4 semantics);
//   • WTS_buildup.review            — evidence / run / report (S1–S12) / ask / status / canSign / signoff /
//                                     signature / aiExport with the §3.10 semantics (hash-based CHANGED);
//   • WTS_buildup.synth             — demo(kind) = FIX.samples.AnalysisInput (record + allocation + well);
//   • WTS_buildup.data              — sniff / parse / parseJob / parseAllocation / resolveZone for CSV text.
// window.__BU_STUBS lists what was installed. After the integration merge every real module exists and these
// tests run against the real engines (assertions are contract-level, not FIX numbers).
// Budget (plan §9.0): page tests seed wts_buildup_state from one demo analysis computed once per file; only PG2,
// PG3, PG6, PG7 and PG17 run the engine themselves.
'use strict';

const fs = require('fs');
const path = require('path');
const { FIX, checkShape } = require('./_buildup-shapes');

const WP = 'WP6';
const REPO = path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs (app realm; no closure over Node values)
// ─────────────────────────────────────────────────────────────────────────────
function STUBS(W) {
  var B = W.WTS_buildup = W.WTS_buildup || {};
  var AI = W.PRiSM_autoInterp = W.PRiSM_autoInterp || {};
  var FX = W.__BU_FIX;
  var out = [];
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function h16(o, mode) { return AI.hash16(AI.canon(o, mode || 'inputs')); }
  function fin(x) { return typeof x === 'number' && isFinite(x); }
  if (typeof AI.drive !== 'function') {
    out.push('PRiSM_autoInterp.drive');
    AI.drive = function (job, opts) {
      opts = opts || {};
      return new Promise(function (res, rej) {
        function tick() {
          var s;
          try { s = job.step(); } catch (e) { rej(e); return; }
          if (opts.onProgress) try { opts.onProgress(s.progress, s.label); } catch (e) { /* cosmetic */ }
          if (s.done) { res(job.result()); return; }
          setTimeout(function () {
            if (opts.shouldCancel && opts.shouldCancel()) { try { job.cancel(); } catch (e) { /* ignore */ } rej({ code: 'CANCELLED' }); return; }
            tick();
          }, 0);
        }
        tick();
      });
    };
  }
  if (typeof AI.interpretJob !== 'function') {
    out.push('PRiSM_autoInterp.interpretJob');
    AI.interpretJob = function (spec) {
      var n = 0, r = clone(FX.result);
      r.id = spec && spec.id ? spec.id : r.id;
      return { step: function () { n++; return { done: n >= 2, progress: Math.min(1, n / 2), label: 'Interpreting ' + r.id }; },
        result: function () { return n >= 2 ? r : null; }, cancel: function () { n = 2; } };
    };
  }
  if (!B.run || typeof B.run.analyseAsync !== 'function') {
    out.push('WTS_buildup.run');
    var strip = function (input) {
      var c = {}, k;
      for (k in input) if (k !== 'record' && k !== 'stored' && k !== 'meta') c[k] = input[k];
      c.rec = input.record ? input.record.hash : 'stored';
      c.settings = clone(input.settings || {}); delete c.settings.report;
      c.well = clone(input.well || {}); delete c.well.defaulted;
      return c;
    };
    var testHash = function (input, t) {
      var ov = (input.overrides || []).filter(function (o) { return o.target === t.id && (o.kind === 'window' || o.kind === 'model'); })
        .map(function (o) { return { k: o.kind, v: o.value }; });
      return h16({ id: t.id, interp: input.settings && input.settings.interp, ov: ov }, 'inputs');
    };
    var finish = function (input, a) {
      var h = input.well && fin(input.well.h) && input.well.h > 0 ? input.well.h : 50, f = 50 / h;
      a.tests.forEach(function (t) {
        if (t.result && t.result.final && fin(t.result.final.k)) t.result.final.k = t.result.final.k * f;
        var mine = (input.overrides || []).filter(function (o) { return o.target === t.id || o.target === t.eventId; });
        t.overrides = mine.map(function (o) { return o.id; });
        mine.forEach(function (o) {
          if (o.kind === 'exclude') { t.status = 'excluded'; t.statusReason = 'override ' + o.id; }
          if (o.kind === 'include' && t.status === 'excluded') { t.status = 'interpreted'; t.statusReason = null; }
        });
      });
      a.overrides = clone(input.overrides || []);
      a.inputHash = B.run.inputHash(input);
      a.meta = clone(input.meta);
      a.settings = clone(input.settings);
      a.well = clone(input.well);
      a.completion = input.completion ? clone(input.completion) : null;
      a.depth = input.depth ? clone(input.depth) : null;
      var z = function (x) { return (x && x.mode !== 'device') ? clone(x) : { mode: 'utc' }; };
      a.zones = { gauge: z(input.zones && input.zones.gauge), day: { zone: z(input.zones && input.zones.day && input.zones.day.zone), startHour: (input.zones && input.zones.day && input.zones.day.startHour) || 0 } };
      if (input.record) a.record = { name: String(input.record.name || ''), source: input.record.source || 'csv', n: input.record.n || 0, origin_ms: input.record.origin_ms,
        end_ms: input.record.t && input.record.t.length ? input.record.t[input.record.t.length - 1] : input.record.origin_ms, hash: input.record.hash, reduced: false, rawStored: 'none' };
      a.appVersion = (typeof W.WTS_appVersion === 'function' ? W.WTS_appVersion() : '') || 'v3.3';
      a.runAt = new Date().toISOString();
      a.resultHash = h16(a.tests.map(function (t) { return t.result ? { id: t.id, k: t.result.final.k, S: t.result.final.S, s: t.status } : { id: t.id, s: t.status }; }), 'display');
      a.stats = { evals: 0, fits: 0, slices: 0, ms: null };
      return a;
    };
    var job = function (input, opts) {
      var a = clone(FX.analysis), cache = opts && opts.cache, list = [], i = 0, sub = null, res = null, cancelled = false;
      a.tests.forEach(function (t) {
        var th = testHash(input, t), prev = cache && cache.tests ? cache.tests.filter(function (x) { return x.id === t.id; })[0] : null;
        if (prev && prev.result && prev.result.stubHash === th) { t.result = clone(prev.result); t.result.final.k = prev.result.stubK; }
        else list.push(t);
        if (t.result) t.result.stubHash = th;
      });
      return {
        step: function () {
          if (cancelled) return { done: true, progress: 1, label: '' };
          if (i < list.length) {
            if (!sub) sub = AI.interpretJob(list[i].spec ? Object.assign({ id: list[i].id }, list[i].spec) : { id: list[i].id });
            var s = sub.step();
            if (s.done) {
              var r = sub.result(), t = list[i];
              if (t.result && r) { t.result.stubK = t.result.final.k; }
              sub = null; i++;
            }
            return { done: false, progress: i / (list.length + 1), label: 'Build-up ' + Math.min(i + 1, list.length) };
          }
          a.tests.forEach(function (t) { if (t.result && !fin(t.result.stubK)) t.result.stubK = t.result.final.k; });
          res = finish(input, a);
          return { done: true, progress: 1, label: 'Trend' };
        },
        result: function () { return res; },
        cancel: function () { cancelled = true; }
      };
    };
    B.run = {
      inputHash: function (input) { return h16(strip(input), 'inputs'); },
      job: job,
      analyse: function (input, opts) { var j = job(input, opts); while (!j.step().done) { /* sync */ } return j.result(); },
      analyseAsync: function (input, opts) { return AI.drive(job(input, opts), opts || {}); },
      specFor: function () { return null; }
    };
  }
  if (!B.review || typeof B.review.report !== 'function') {
    out.push('WTS_buildup.review');
    var V = function (v, cat, dp, ref) { return { v: v, cat: cat || null, dp: dp == null ? 2 : dp, ref: ref || 'T1:x' }; };
    var R = B.review = {
      evidence: function () { return { items: {}, order: [] }; },
      run: function (a) {
        var f = [{ id: 'F1', rule: 'V10', severity: 'minor', acceptable: true, where: 'S2', template: 'Drift index {r} is above 0.05.',
          values: { r: V(0.06, null, 2, 'Q5:rDrift') }, ev: ['Q5'], check: { ok: true, failures: [] }, decision: null }];
        if (W.__BU_MAJOR) f.push({ id: 'F2', rule: 'V6', severity: 'major', acceptable: true, where: 'S5', template: 'k varies by {cv} %.', values: { cv: V(12, null, 1, 'T9:cv') }, ev: ['T9'], check: { ok: true, failures: [] }, decision: null });
        return { version: 'r1', at: new Date().toISOString(), findings: f, counts: { critical: 0, major: W.__BU_MAJOR ? 1 : 0, minor: 1, suggestion: 0 },
          evidenceCheck: { ok: true, nChecked: 0, nFailed: 0 }, inputHash: a.inputHash, resultHash: a.resultHash };
      },
      check: function () { return { ok: true, nChecked: 0, nFailed: 0, failures: [] }; },
      ask: function (q) { return { q: q, intent: 'help', template: 'I can answer questions about models, confidence, alerts and inputs.', values: {}, ev: [], grounded: 'none', check: { ok: true, failures: [] }, followUps: ['why this model?'] }; },
      sha256: function () { return '0000000000000000000000000000000000000000000000000000000000000000'; },
      signature: function (a, rv, form) {
        var d = ((rv && rv.findings) || []).map(function (x) { return { id: x.id, d: x.decision ? x.decision.d : null, n: x.decision ? x.decision.note : null }; });
        var ih = a.inputHash, rh = a.resultHash, dh = h16(d, 'display');
        return { hash: h16({ ih: ih, rh: rh, dh: dh, n: form && form.name }, 'display') + h16({ x: ih }, 'display') + rh + dh, inputsHash: ih, resultsHash: rh, decisionsHash: dh, appVersion: a.appVersion, runAt: a.runAt };
      },
      status: function (a, rv, so) {
        if (!so) return 'DRAFT';
        var s = R.signature(a, rv, so);
        return (s.inputsHash === so.inputsHash && s.resultsHash === so.resultsHash && s.decisionsHash === so.decisionsHash) ? 'SIGNED' : 'CHANGED';
      },
      canSign: function (rv) {
        var open = ((rv && rv.findings) || []).filter(function (x) { return (x.severity === 'critical' || x.severity === 'major') && (!x.decision || (x.decision.d === 'reject' && !x.decision.note)); }).map(function (x) { return x.id; });
        return { ok: !open.length, open: open };
      },
      signoff: function (form, a, rv) {
        if (!form || !form.name) return { ok: false, code: 'NO_NAME' };
        if (!form.statement) return { ok: false, code: 'NO_STATEMENT' };
        if (!R.canSign(rv).ok) return { ok: false, code: 'OPEN_FINDINGS' };
        var s = R.signature(a, rv, form);
        return { name: form.name, role: form.role || '', statement: true, at: new Date().toISOString(), hash: s.hash, inputsHash: s.inputsHash, resultsHash: s.resultsHash,
          decisionsHash: s.decisionsHash, appVersion: s.appVersion, runAt: s.runAt, decisions: 0, open: 0 };
      },
      aiExport: function (a, rv, o) {
        return { text: 'Build-up surveillance review summary\nWell A\nTests: ' + a.tests.length + (o && o.includeFreeText ? '\nfree text' : ''), filename: 'buildup-review-' + String(a.resultHash).slice(0, 8) + '.txt' };
      },
      report: function (a, rv, audit, so, fmt) {
        var st = R.status(a, rv, so), tests = a.tests || [], tr = a.trend || {}, al = tr.alerts || {};
        var ok = tests.filter(function (t) { return t.status === 'interpreted' && t.result; }), last = ok[ok.length - 1];
        var ex = tr.excludedLow || { n: 0 };
        var S = [];
        S.push({ id: 'S1', title: 'Summary', blocks: [
          { kind: 'kpi', items: [{ label: 'Latest skin', value: V(last.result.final.S, null, 2, last.id + '·A2:S'), ev: [last.id + '·A2'] },
            { label: 'Baseline skin', value: V(tr.baseline ? tr.baseline.S : null, null, 2, 'T1:S'), ev: ['T1'] },
            { label: 'k median', value: V(a.baseline ? a.baseline.k : last.result.final.k, 'permeability', 1, 'T9:k'), ev: ['T9'] }] },
          { kind: 'verdict', level: (al.delta && al.delta.status === 'confirmed') ? 'bad' : 'warn', template: 'Delta skin alert: {s}.', values: { s: V(al.delta ? al.delta.status : 'none', null, 0, 'T2:status') }, ev: ['T2'] },
          { kind: 'verdict', level: st === 'SIGNED' ? 'ok' : 'warn', template: st === 'SIGNED' ? 'Signed off.' : (st === 'CHANGED' ? 'DRAFT: changed after sign-off.' : 'DRAFT: not signed off.'), values: {}, ev: [] },
          { kind: 'notes', head: 'Assessment', template: 'Skin rose from {a} to {b} with stable k.', values: { a: V(tr.baseline ? tr.baseline.S : null, null, 2, 'T1:S'), b: V(last.result.final.S, null, 2, last.id + '·A2:S') }, ev: ['T1', 'T9'] }] });
        S.push({ id: 'S2', title: 'Data and quality', blocks: [{ kind: 'kv', rows: [
          { label: 'Gauge noise', value: V(a.qc ? a.qc.sigma_psi : null, 'pressure', 3, 'Q1:sigma'), ev: ['Q1'] },
          { label: 'Settings used: detection window (min)', value: V(a.settings.detect.winMin, null, 0, 'Q2:win'), ev: [] },
          { label: 'Settings used: IARF band (%)', value: V(a.settings.interp.band * 100, null, 1, 'Q2:band'), ev: [] },
          { label: 'Settings used: baseline tests', value: V(a.settings.trend.baseN, null, 0, 'Q2:base'), ev: [] }] }] });
        S.push({ id: 'S3', title: 'Events and rates', blocks: [{ kind: 'table', id: 'bu_tbl_events', head: [{ text: 'Event', cat: null }, { text: 'Kind', cat: null }, { text: 'Status', cat: null }],
          rows: (a.events || []).slice(0, 30).map(function (e) { return [e.id, e.kind, e.status]; }), ev: ['D1'] },
          { kind: 'notes', head: 'Notes', template: 'Short shut-ins and partial cuts are listed but not interpreted.', values: {}, ev: ['D1'] }] });
        S.push({ id: 'S4', title: 'Build-up tests', blocks: [{ kind: 'table', id: 'bu_tbl_tests', head: [{ text: 'Test', cat: null }, { text: 'Date', cat: null }, { text: 'k', cat: 'permeability' }, { text: 'S', cat: null }, { text: 'Status', cat: null }, { text: 'Override', cat: null }],
          rows: tests.slice(-30).map(function (t) { var fz = t.result && t.result.final; return [t.id, t.date, fz ? V(fz.k, 'permeability', 1, t.id + '·A2:k') : '—', fz ? V(fz.S, null, 2, t.id + '·A2:S') : '—', t.status, (t.overrides || []).join(' ') || '—']; }), ev: [] },
          { kind: 'kv', rows: [{ label: 'Selected test', value: V(String((a.settings.report && a.settings.report.selected) || last.id), null, 0, last.id + '·A2:id'), ev: [] }] }] });
        S.push({ id: 'S5', title: 'Trend and alerts', blocks: [{ kind: 'chart', id: 'bu_ch_skin', series: [{ name: 'Skin', cat: null, x: (tr.series || []).map(function (s) { return s.tDays; }), y: (tr.series || []).map(function (s) { return s.S; }) }] },
          { kind: 'kv', rows: [{ label: 'Delta alert', value: V(al.delta ? al.delta.status : 'none', null, 0, 'T2:status'), ev: ['T2'] },
            { label: 'Tests excluded as low', value: { template: ex.n ? '{n} low tests excluded, S {lo}–{hi}' : 'none', values: { n: V(ex.n, null, 0, 'T16:n'), lo: V(ex.S ? ex.S[0] : null, null, 1, 'T16:lo'), hi: V(ex.S ? ex.S[1] : null, null, 1, 'T16:hi') } }, ev: ['T16'] }] }] });
        S.push({ id: 'S6', title: 'Uncertainty', blocks: [{ kind: 'table', id: 'bu_tbl_serr', head: [{ text: 'Test', cat: null }, { text: 'S_err', cat: null }],
          rows: ok.map(function (t) { return [t.id, V(t.result.sErr ? t.result.sErr.value : null, null, 2, t.id + '·U1:value')]; }), ev: [] }] });
        S.push({ id: 'S7', title: 'Recommendations', blocks: [{ kind: 'notes', head: 'Recommendations', template: 'Review stimulation candidates.', values: {}, ev: ['T2'] }] });
        S.push({ id: 'S8', title: 'Limitations', blocks: [{ kind: 'notes', head: 'Notes', template: 'Partial cuts are not interpreted.', values: {}, ev: [] }] });
        var byRule = {};
        ((rv && rv.findings) || []).forEach(function (x) { (byRule[x.rule] = byRule[x.rule] || []).push(x); });
        S.push({ id: 'S9', title: 'Automated rule-based review', blocks: [{ kind: 'table', id: 'bu_tbl_review', head: [{ text: 'Rule', cat: null }, { text: 'Severity', cat: null }, { text: 'Decision', cat: null }],
          rows: Object.keys(byRule).map(function (r) { var x = byRule[r][0]; return [r, x.severity, x.decision ? x.decision.d : 'open']; }), ev: [] },
          { kind: 'verdict', level: 'ok', template: 'Evidence check passed.', values: {}, ev: [] }] });
        S.push({ id: 'S10', title: 'Audit trail and reproducibility', blocks: [{ kind: 'table', id: 'bu_tbl_audit', head: [{ text: 'Seq', cat: null }, { text: 'Kind', cat: null }],
          rows: (audit || []).slice(-30).map(function (e) { return [String(e.seq), e.kind]; }), ev: [] }, { kind: 'kv', rows: [{ label: 'Inputs hash', value: V(String(a.inputHash), null, 0, 'T1:h'), ev: [] }] }] });
        S.push({ id: 'S11', title: 'Sign-off', blocks: [{ kind: 'verdict', level: st === 'SIGNED' ? 'ok' : 'warn', template: st === 'SIGNED' ? 'Signed off by {n}.' : (st === 'CHANGED' ? 'DRAFT — changed after sign-off.' : 'DRAFT — not signed off.'), values: { n: V(so ? so.name : '', null, 0, 'T1:n') }, ev: [] }] });
        S.push({ id: 'S12', title: 'Confidence calibration', blocks: [{ kind: 'notes', head: 'Notes', template: 'Labels not yet calibrated.', values: {}, ev: ['K1'] }] });
        return { title: 'Build-up Surveillance', subtitle: st, status: st, sections: S, signature: so ? { hash: so.hash } : null, reproducibility: { kind: 'notes', head: 'Notes', template: 'Reproducible.', values: {}, ev: [] } };
      }
    };
  }
  if (!B.synth || typeof B.synth.demo !== 'function') {
    out.push('WTS_buildup.synth');
    B.synth = { demo: function (kind) { var i = clone(FX.input); return { name: 'Demo ' + kind, record: i.record, allocation: i.allocation, well: i.well, completion: null, settings: i.settings, truth: { tests: [] } }; }, IN_APP: [] };
  }
  if (!B.data || typeof B.data.parseJob !== 'function') {
    out.push('WTS_buildup.data');
    var D = B.data = {
      resolveZone: function (z) { return (!z || z.mode === 'device') ? { mode: 'iana', tz: 'Europe/London' } : z; },
      sniff: function (text) {
        var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
        var sep = lines[0].indexOf(',') !== -1 ? ',' : (lines[0].indexOf('\t') !== -1 ? '\t' : ';');
        var headers = lines[0].split(sep).map(function (s) { return s.trim(); }), low = headers.map(function (s) { return s.toLowerCase(); });
        var idx = function (re) { for (var i = 0; i < low.length; i++) if (re.test(low[i])) return i; return -1; };
        var cols = { t: idx(/time|date|hr/), p: idx(/press|psi/), T: idx(/temp/), q: idx(/rate|stb|bpd/) };
        return { sep: sep, headers: headers, sample: lines.slice(1, 21).map(function (l) { return l.split(sep); }), cols: cols,
          timeFormat: cols.t >= 0 && /hr|hour/.test(low[cols.t]) ? 'elapsed_h' : 'iso', pUnitGuess: 'psia', hasRate: cols.q >= 0 };
      },
      parse: function (text, opts) {
        var sn = D.sniff(text), c = (opts && opts.cols) || sn.cols, lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(1);
        var t0 = (opts && opts.t0_ms) || Date.UTC(2026, 0, 1), t = [], p = [], rt = [];
        lines.forEach(function (l) {
          var f = l.split(sn.sep), tv = parseFloat(f[c.t]), pv = parseFloat(f[c.p]);
          if (!fin(tv) || !fin(pv)) return;
          var ms = sn.timeFormat === 'elapsed_h' ? t0 + Math.round(tv * 3600000) : Date.parse(f[c.t]);
          t.push(ms); p.push(pv);
          if (c.q >= 0) rt.push({ t_ms: ms, q: Math.max(0, parseFloat(f[c.q]) || 0) });
        });
        if (!t.length) return { ok: false, errors: ['no rows'] };
        var rec = { ok: true, origin_ms: t[0], t: t, p: p, T: null, n: t.length, source: (opts && opts.source) || 'csv', name: (opts && opts.name) || '', zone: (opts && opts.zone) || { mode: 'utc' },
          pUnitIn: 'psia', patm: 14.696, elapsed: sn.timeFormat === 'elapsed_h', rollup: false, hash: h16({ t: t.length, a: t[0], b: p[0], c: p[p.length - 1] }), warnings: [] };
        return { record: rec, rateTable: rt.length ? rt : null };
      },
      parseJob: function (text, opts) { var n = 0, r = null; return { step: function () { n++; if (n === 1) r = D.parse(text, opts); return { done: n >= 2, progress: n / 2, label: 'Reading' }; }, result: function () { return r; }, cancel: function () { n = 2; } }; },
      parseAllocation: function (text) {
        var rows = String(text).split(/\r?\n/).slice(1).filter(function (l) { return l.trim(); }).map(function (l) { var f = l.split(','); return { date: f[0], oil: +f[1], gas: +f[2], water: +f[3], hours: +f[4] }; });
        return { ok: rows.length > 0, rows: rows, errors: [], gUnit: 'Mscf', resolution: { oil: 0.1, gas: 0.1, water: 0.1 } };
      }
    };
  }
  W.__BU_STUBS = out;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function install(app) {
  app.win.__BU_FIX = app.toWin({ analysis: FIX.analysis, result: FIX.result, input: FIX.samples.AnalysisInput });
  return app.evalInApp('(' + STUBS.toString() + ')(window)');
}
const P = (app) => app.win.WTS_buildup.page;
const txt = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
function open(app) { install(app); app.hook.nav('buildup'); app.flush(20); }
async function idle(app, max) {
  for (let i = 0; i < (max || 6000); i++) {
    await app.flushAsync(1);
    if (!P(app).isRunning()) { for (let k = 0; k < 4; k++) await app.flushAsync(1); return true; }
  }
  return false;
}
async function demoRun(app) {
  open(app);
  app.select('bu_src', 'demo');
  app.click('bu_demo_load');
  app.click('bu_run');
  const ok = await idle(app);
  if (!ok) throw new Error('analysis did not finish');
  if (app.el('bu_res').getAttribute('data-done') !== '1') throw new Error('no results: ' + txt(app.el('bu_progress')) + ' / ' + txt(app.el('bu_val')));
}
let _seed = null;
async function seed(ctx) {
  if (_seed) return _seed;
  const a = ctx.loadApp({});
  try {
    await demoRun(a);
    _seed = {};
    ['wts_buildup_state', 'wts_buildup_audit', 'wts_page_buildup'].forEach((k) => { const v = a.storage.getItem(k); if (v != null) _seed[k] = v; });
  } finally { a.dispose(); }
  return _seed;
}
function applySeed(app, s, mutate) {
  Object.keys(s).forEach((k) => {
    let v = s[k];
    if (k === 'wts_buildup_state' && mutate) { const o = JSON.parse(v); mutate(o); v = JSON.stringify(o); }
    app.storage.setItem(k, v);
  });
}
function auditKinds(app) { return JSON.parse(app.storage.getItem('wts_buildup_audit') || '{"entries":[]}').entries.map((e) => e.kind); }
function accName(doc, el) {
  const al = (el.getAttribute('aria-label') || '').trim();
  if (al) return al;
  if (el.id) { const l = doc.querySelector('label[for="' + el.id + '"]'); if (l && txt(l)) return txt(l); }
  const w = el.closest('label'); if (w && txt(w)) return txt(w);
  if (el.localName === 'button') return txt(el);
  return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
}
function shown(el) { for (let p = el; p; p = p.parentElement) { if (p.style && p.style.display === 'none') return false; if (p.hasAttribute && p.hasAttribute('hidden')) return false; } return true; }
const BAD_TXT = /\b(NaN|Infinity|undefined|null)\b|\[object Object\]/;
const IMP_RX = /(^|[\s(\/\[·,])(psi[ag]?|ft|md|bbl|STB|BPD)(?=$|[\s)\/\]·,.:;])/;
function secText(app, id) { return txt(app.el('bu_s_' + id)); }
function latestS(app) { const s = app.win.WTS_state && app.win.WTS_state.buildup; return s && s.latest ? s.latest.S : null; }

module.exports = [
  {
    name: 'PG1 page open: Notes boxes at first paint, no analysis started, no timers after flush(400), every control labelled, idle-only controls disabled',
    wp: WP,
    run(app, assert) {
      install(app);
      let started = 0;
      const R = app.win.WTS_buildup.run, orig = R.analyseAsync;
      R.analyseAsync = function () { started++; return orig.apply(this, arguments); };
      app.hook.nav('buildup');
      const body = app.el('pgBody');
      const notes = Array.from(body.querySelectorAll('div')).filter((d) => d.firstElementChild && d.firstElementChild.tagName === 'B' && /^Notes$/.test(txt(d.firstElementChild)));
      assert.ok(notes.length >= 3, 'three Notes boxes at first paint: ' + notes.length);
      notes.forEach((n) => assert.ok(txt(n).length <= 600, 'Notes ≤ 600 characters'));
      app.flush(400);
      assert.strictEqual(started, 0, 'no analysis at open');
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after flush(400)');
      assert.strictEqual(app.errors.length, 0, 'no errors: ' + app.errors.map((e) => e.message).join('; '));
      const doc = app.document, bad = [];
      app.findAll('#bu_root input, #bu_root select, #bu_root textarea, #bu_root button').forEach((c) => { if (!(c.type === 'hidden') && !accName(doc, c)) bad.push(c.id || c.outerHTML.slice(0, 60)); });
      assert.deepStrictEqual(bad, [], 'every control has an accessible name');
      ['bu_cancel', 'bu_so_unsign', 'bu_so_sign', 'bu_ai_copy', 'bu_ai_dl', 'bu_open_prism', 'bu_qa_go', 'bu_ev_add', 'bu_val_run'].forEach((id) => assert.ok(app.el(id).disabled, id + ' disabled while idle'));
      assert.strictEqual(app.el('bu_run').disabled, false, 'Analyse enabled');
      assert.strictEqual(P(app).calcs(), 1, 'one calc at open');
      assert.strictEqual(app.el('bu_dlg').hasAttribute('open'), false, 'dialog closed');
      assert.ok(app.el('pgTitle').textContent === 'Build-up Surveillance');
      const btn = app.find('#sidebar .nav-btn[data-p="buildup"]');
      const grp = btn.closest('.nav-group'), rows = Array.from(grp.querySelectorAll('.nav-btn')).filter((b) => !b.classList.contains('nav-hub-member')).map((b) => b.getAttribute('data-p'));
      assert.deepStrictEqual(rows.slice(-2), ['gaslift', 'buildup'], 'row 7 of Production & Reservoir, after Gas Lift: ' + rows.join(','));
    },
  },
  {
    name: 'PG2 page demo + Analyse: AnalysisInput shape, progress text at once, results after the async run, data-done, focus on S1, no timers',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      open(app);
      app.select('bu_src', 'demo');
      app.click('bu_demo_load');
      assert.match(txt(app.el('bu_g_status')), /Loaded/, 'demo loaded: ' + txt(app.el('bu_g_status')));
      const g = P(app).gather();
      assert.strictEqual(g.bad.length, 0, 'demo inputs valid: ' + Array.from(g.errors).join(' '));
      const sh = checkShape('AnalysisInput', g.input);
      assert.ok(sh.ok, 'page builds a valid AnalysisInput: ' + sh.errors.slice(0, 4).join('; '));
      app.click('bu_run');
      assert.match(txt(app.el('bu_progress')), /^Analysing… 0 %/, 'progress written at once');
      assert.strictEqual(app.el('bu_cancel').disabled, false, 'Cancel enabled while running');
      assert.ok(await idle(app), 'analysis finished');
      const res = app.el('bu_res');
      assert.strictEqual(res.getAttribute('data-done'), '1');
      assert.ok(app.findAll('#bu_res .rbox').length >= 10, 'report sections rendered');
      const a = P(app).state().analysis;
      assert.ok(a && a.tests.length >= 1, 'analysis kept');
      assert.ok(checkShape('Analysis', JSON.parse(JSON.stringify(a))).ok || app.win.__BU_STUBS.indexOf('WTS_buildup.run') !== -1, 'Analysis shape (real run)');
      const f = app.document.activeElement;
      assert.ok(f && f.classList.contains('rbox-title') && f.parentElement.id === 'bu_s_S1', 'focus on the S1 title');
      assert.match(txt(app.el('bu_progress')), /Analysis complete/);
      assert.strictEqual(app.el('bu_cancel').disabled, true);
      ['bu_ai_copy', 'bu_qa_go', 'bu_so_sign', 'bu_ev_add'].forEach((id) => assert.strictEqual(app.el(id).disabled, false, id + ' enabled with results'));
      assert.ok(app.win.WTS_state.buildup && app.win.WTS_state.buildup.ok, 'WTS_state.buildup published');
      assert.ok(auditKinds(app).indexOf('run') !== -1, 'audit "run" entry');
      assert.ok(app.storage.getItem('wts_buildup_state'), 'state saved');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after flush(5000)');
      assert.strictEqual(app.errors.length, 0, app.errors.map((e) => e.message).join('; '));
    },
  },
  {
    name: 'PG3 page Cancel: the previous results are kept and no timer remains',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      await demoRun(app);
      const before = txt(app.el('bu_s_S1')), hash = P(app).state().analysis.resultHash;
      app.input('bu_h', '61');
      app.click('bu_run');
      app.click('bu_cancel');
      await idle(app);
      assert.match(txt(app.el('bu_progress')), /Cancelled — previous results kept/);
      assert.strictEqual(P(app).state().analysis.resultHash, hash, 'previous analysis kept');
      assert.strictEqual(txt(app.el('bu_s_S1')), before, 'previous results still shown');
      assert.strictEqual(P(app).isRunning(), false);
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0);
      assert.strictEqual(auditKinds(app).filter((k) => k === 'run').length, 1, 'no audit entry for the cancelled run');
    },
  },
  {
    name: 'PG4 page Metric: no imperial units in labels, rows, tables or chart text at first paint and after a flip; values converted; drift in kPa/d',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert, ctx) {
      const s = await seed(ctx);
      applySeed(app, s);
      app.storage.setItem('wts_unit_system', 'metric');
      const a2 = ctx.loadApp({ storage: app.storage });
      try {
        assert.strictEqual(a2.win.WTS_units.getSystem(), 'metric');
        open(a2);
        for (let i = 0; i < 40; i++) await a2.flushAsync(1);
        const lab = (id) => txt(a2.el(id).closest('.fg-item').querySelector('label'));
        assert.match(lab('bu_drift'), /\(kPa\/d\)$/, 'drift label at first paint: ' + lab('bu_drift'));
        assert.ok(Math.abs(parseFloat(a2.win.WTS_units.displayValue(a2.el('bu_drift'))) - 0.01 * 6.894757) < 5e-4, 'drift value converted: ' + a2.win.WTS_units.displayValue(a2.el('bu_drift')));
        assert.match(lab('bu_h'), /\(m\)$/);
        const check = (where) => {
          const hits = a2.findAll('#bu_root label, #bu_root .rrow, #bu_root .rbox-title, #bu_root table.dtable th, #bu_root table.dtable td, #bu_root .kpi')
            .filter(shown).map(txt).filter((t) => IMP_RX.test(t));
          assert.deepStrictEqual(hits.slice(0, 5), [], where + ': imperial units in Metric');
          const cv = a2.canvases(a2.el('bu_root'));
          assert.ok(cv.length >= 3, 'charts present: ' + cv.length);
          const ct = [];
          cv.forEach((c) => a2.canvasTexts(c).forEach((t) => { if (IMP_RX.test(t)) ct.push(c.id + ': ' + t); }));
          assert.deepStrictEqual(ct.slice(0, 5), [], where + ': imperial units in chart text');
        };
        check('first paint');
        assert.strictEqual(P(a2).stale(), false, 'a Metric first paint of an imperial analysis is not stale');
        assert.ok(/kPa/.test(txt(a2.el('bu_res'))) || /mD/.test(txt(a2.el('bu_res'))), 'converted units shown in the report');
        const U = a2.win.WTS_units;
        U.setSystem('imperial'); a2.flush(20);
        for (let i = 0; i < 40; i++) await a2.flushAsync(1);
        assert.match(lab('bu_drift'), /\(psi\/d\)$/);
        U.setSystem('metric'); a2.flush(20);
        for (let i = 0; i < 40; i++) await a2.flushAsync(1);
        check('after a flip');
        assert.strictEqual(P(a2).stale(), false, 'a unit flip is not an input change');
        assert.strictEqual(a2.errors.length, 0, a2.errors.map((e) => e.message).join('; '));
      } finally { a2.dispose(); }
    },
  },
  {
    name: 'PG5 page autosave + reload: one calcBuildup, results restored from the stored state with no re-run',
    wp: WP,
    async run(app, assert, ctx) {
      const s = await seed(ctx);
      applySeed(app, s);
      open(app);
      app.input('bu_eng', 'Engineer B');
      app.flush(500);
      assert.match(app.storage.getItem('wts_page_buildup') || '', /Engineer B/, 'autosaved');
      const a2 = app.reload();
      try {
        install(a2);
        let runs = 0;
        const R = a2.win.WTS_buildup.run, orig = R.analyseAsync;
        R.analyseAsync = function () { runs++; return orig.apply(this, arguments); };
        a2.hook.nav('buildup');
        a2.flush(400);
        assert.strictEqual(P(a2).calcs(), 1, 'exactly one calcBuildup after the host restore');
        assert.strictEqual(runs, 0, 'no analysis re-run');
        assert.strictEqual(a2.el('bu_res').getAttribute('data-done'), '1', 'results restored');
        assert.strictEqual(a2.el('bu_eng').value, 'Engineer B', 'control restored');
        assert.ok(a2.findAll('#bu_test_sel option').length > 1, 'test selector filled from the stored analysis');
        assert.strictEqual(P(a2).stale(), false, 'not stale after a reload');
        assert.ok(a2.win.WTS_state.buildup && a2.win.WTS_state.buildup.ok, 'published on open');
      } finally { a2.dispose(); }
    },
  },
  {
    name: 'PG6 page override via the dialog: reason required, audit entry, stale banner, focus back on Actions…, one test re-run at the next Analyse',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      await demoRun(app);
      const a = P(app).state().analysis;
      const t = a.tests.find((x) => x.status === 'interpreted' && x.result && x.result.iarf && x.result.iarf.found);
      assert.ok(t, 'a test with an IARF window');
      const btn = app.find('#bu_res [data-act="menu"][data-test="' + t.id + '"]');
      assert.ok(btn, 'Actions… button on the S4 row of ' + t.id);
      app.click(btn);
      assert.ok(app.el('bu_dlg').hasAttribute('open'), 'dialog open');
      app.select('bu_dlg_act', 'window');
      assert.ok(Number(app.el('bu_dlg_t0').value) > 0 && Number(app.el('bu_dlg_t1').value) > Number(app.el('bu_dlg_t0').value), 'window pre-filled');
      app.input('bu_dlg_t1', String(Number(app.el('bu_dlg_t1').value) * 0.9));
      app.input('bu_eng', 'Engineer A');
      app.click('bu_dlg_ok');
      assert.ok(app.el('bu_dlg').hasAttribute('open'), 'still open without a reason');
      assert.match(txt(app.el('bu_dlg_msg')), /at least 5 characters/);
      app.input('bu_dlg_reason', 'Late data affected by a nearby well');
      app.click('bu_dlg_ok');
      assert.strictEqual(app.el('bu_dlg').hasAttribute('open'), false, 'dialog closed');
      const fa = app.document.activeElement;
      assert.ok(fa && fa.getAttribute && fa.getAttribute('data-test') === t.id, 'focus back on the Actions… button');
      const au = JSON.parse(app.storage.getItem('wts_buildup_audit')).entries.filter((e) => e.kind === 'override');
      assert.strictEqual(au.length, 1, 'override audit entry');
      assert.strictEqual(au[0].who, 'Engineer A');
      assert.ok(au[0].reason.length >= 5 && au[0].appVersion, 'who, why and app version recorded');
      assert.notStrictEqual(app.el('bu_stale').style.display, 'none', 'stale banner shown');
      assert.match(app.el('pgSub').textContent, /DRAFT \(stale\)/);
      const AI = app.win.PRiSM_autoInterp, calls = [];
      const orig = AI.interpretJob;
      AI.interpretJob = function (spec) { calls.push(spec && spec.id); return orig.apply(this, arguments); };
      app.click('bu_run');
      assert.ok(await idle(app));
      assert.deepStrictEqual(calls, [t.id], 'only the overridden test is re-interpreted');
      const t2 = P(app).state().analysis.tests.find((x) => x.id === t.id);
      assert.ok(t2.overrides.length === 1, 'override listed on the test');
      assert.strictEqual(app.el('bu_stale').style.display, 'none', 'no longer stale');
      // Esc closes the dialog too
      app.click(app.find('#bu_res [data-act="menu"][data-test="' + t.id + '"]'));
      app.key('bu_dlg_act', 'Escape');
      assert.strictEqual(app.el('bu_dlg').hasAttribute('open'), false, 'Esc closes the dialog');
    },
  },
  {
    name: 'PG7 page sign-off: DRAFT → signed; same-input re-run and a unit round trip stay SIGNED; an input change + Analyse gives CHANGED with one changed_after_signoff and one input entry',
    wp: WP,
    timeoutMs: 180000,
    async run(app, assert) {
      await demoRun(app);
      assert.match(app.el('pgSub').textContent, /· DRAFT$/);
      app.input('bu_so_name', 'Reviewer A');
      app.input('bu_so_role', 'Reservoir engineer');
      app.click('bu_so_sign');
      assert.match(txt(app.el('bu_so_status')), /Tick the statement/, 'statement required');
      app.check('bu_so_ok', true);
      const R = app.win.WTS_buildup.review;
      const cs = R.canSign(P(app).state().review);
      if (!cs.ok) {   // real review: decide the open findings first
        cs.open.forEach((fid) => { const f = P(app).state().review.findings.find((x) => x.id === fid); f.decision = { d: 'note', note: 'Reviewed in the test', who: 'Reviewer A', at: new Date().toISOString() }; });
      }
      app.click('bu_so_sign');
      assert.strictEqual(P(app).status(), 'SIGNED', txt(app.el('bu_so_status')));
      assert.match(app.el('pgSub').textContent, /Signed off \d{4}-\d{2}-\d{2}/);
      assert.match(secText(app, 'S11'), /✓/, 'S11 ✓ verdict');
      assert.ok(auditKinds(app).indexOf('signoff') !== -1);
      assert.strictEqual(app.el('bu_so_unsign').disabled, false);
      // re-run with the same inputs
      app.click('bu_run');
      assert.ok(await idle(app));
      assert.strictEqual(P(app).status(), 'SIGNED', 'same inputs → still SIGNED');
      // unit round trip
      const U = app.win.WTS_units;
      U.setSystem('metric'); app.flush(20); await app.flushAsync(1);
      U.setSystem('imperial'); app.flush(20); await app.flushAsync(1);
      app.input('bu_eng', 'Engineer A');     // a display-only edit triggers the stale check
      assert.strictEqual(P(app).stale(), false, 'unit round trip is not stale');
      assert.strictEqual(P(app).status(), 'SIGNED');
      // input change
      app.input('bu_h', '62');
      assert.strictEqual(P(app).stale(), true, 'stale after an input change');
      app.click('bu_run');
      assert.ok(await idle(app));
      assert.strictEqual(P(app).status(), 'CHANGED');
      assert.match(app.el('pgSub').textContent, /changed after sign-off/);
      const kinds = auditKinds(app);
      assert.strictEqual(kinds.filter((k) => k === 'changed_after_signoff').length, 1, 'one changed_after_signoff entry');
      assert.strictEqual(kinds.filter((k) => k === 'input').length, 1, 'one input entry');
      const inp = JSON.parse(app.storage.getItem('wts_buildup_audit')).entries.filter((e) => e.kind === 'input')[0];
      assert.ok(inp.value.some((d) => d.field === 'well.h'), 'the input diff names well.h');
      // a further Analyse does not add another transition entry
      app.click('bu_run');
      assert.ok(await idle(app));
      assert.strictEqual(auditKinds(app).filter((k) => k === 'changed_after_signoff').length, 1, 'one entry per transition');
    },
  },
  {
    name: 'PG8 page report capture: sections S1–S12 in collectPageReport, verdicts < 300 characters, notes ≤ 600, no Actions buttons or dialog in the report',
    wp: WP,
    async run(app, assert, ctx) {
      applySeed(app, await seed(ctx));
      open(app);
      const ids = app.findAll('#bu_res .rbox[data-sec]').map((e) => e.getAttribute('data-sec'));
      for (let i = 1; i <= 12; i++) assert.ok(ids.indexOf('S' + i) !== -1, 'section S' + i + ' rendered: ' + ids.join(','));
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = m.results.map((s) => s.title);
      app.findAll('#bu_res .rbox[data-sec] > .rbox-title').forEach((t) => assert.ok(titles.indexOf(txt(t)) !== -1, 'report has section "' + txt(t) + '"'));
      m.results.forEach((s) => s.items.forEach((it) => {
        if (it.type === 'note' && it.verdict) assert.ok(it.text.length < 300, 'verdict < 300: ' + it.text.slice(0, 60));
        if (it.type === 'note' && !it.verdict) assert.ok(it.text.length <= 600, 'note ≤ 600');
        if (it.type === 'table') assert.ok(it.rows.length <= 31, 'table ≤ 30 rows (+1)');
        const all = JSON.stringify(it);
        assert.ok(!/Actions…/.test(all), 'no Actions buttons in the report');
        assert.ok(!BAD_TXT.test(all.replace(/"(sem|title|head)":null/g, '')), 'no null/undefined text: ' + all.slice(0, 120));
      }));
      assert.ok(!titles.some((t) => /Actions|Questions, sign-off/.test(t)), 'action card and dialog skipped');
      assert.ok(m.inputs.some((s) => /Well and fluid/.test(s.title)), 'inputs captured');
    },
  },
  {
    name: 'PG9 page Quick Report: the final template has "Build-up surveillance" with the latest S and DRAFT (snapshot hook); the daily template is unchanged',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      assert.strictEqual(typeof app.win.WTS_snapshotNow, 'function', 'host WTS_snapshotNow hook');
      await demoRun(app);
      const S = latestS(app);
      app.hook.nav('home');
      app.flush(20);
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.buildup, 'snapshot captured at completion');
      const n = app.opened.length;
      app.win.WTS_exportJobReport({ template: 'final' });
      const html = app.opened[n] ? app.opened[n].html() : '';
      const i = html.indexOf('Build-up surveillance');
      assert.ok(i !== -1, 'final report has the Build-up surveillance section');
      assert.ok(html.indexOf('Pressure-transient analysis (PRiSM)') < i, 'right after the PRiSM section');
      assert.ok(/DRAFT/.test(html.slice(i)), 'DRAFT status in the section');
      const sTxt = P(app).fmt(S, null, 2);
      assert.ok(html.slice(i).indexOf(sTxt) !== -1, 'latest S ' + sTxt + ' in the section');
      const T = app.win.WTS_reportTemplates;
      const daily = T.get('daily'), fin = T.get('final');
      assert.strictEqual(daily.sections.length, 7, 'daily template unchanged');
      assert.ok(!daily.sections.some((x) => (x.pages || []).indexOf('buildup') !== -1));
      const k = fin.sections.findIndex((x) => x.type === 'prism');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(fin.sections[k + 1])), { type: 'pages', heading: 'Build-up surveillance', pages: ['buildup'], detail: 'results' });
    },
  },
  {
    name: 'PG10 page project round trip: wts_buildup_state, wts_buildup_audit, buildup_raw (and buildup_analysis) travel and restore the same results',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert, ctx) {
      await demoRun(app);
      for (let i = 0; i < 6; i++) await app.flushAsync(1);
      const W = app.win, S1 = txt(app.el('bu_s_S1')), a = P(app).state().analysis;
      const payload = JSON.parse(JSON.stringify(W.WTS_project._buildPayload()));
      const keys = payload.modules.storage.keys;
      assert.ok(keys.wts_buildup_state && keys.wts_buildup_audit, 'state and audit in the storage module');
      const wid = W.WTS_buildup.store.wellId();
      assert.ok(payload.modules.buildup_raw && payload.modules.buildup_raw.wells[wid], 'raw record embedded for the well');
      assert.strictEqual(payload.modules.buildup_raw.wells[wid].meta.hash, a.record.hash);
      if (payload.modules.buildup_analysis) assert.ok(payload.modules.buildup_analysis.wells, 'buildup_analysis module shape');
      const a2 = ctx.loadApp({});
      try {
        install(a2);
        const res = a2.win.WTS_project.loadFromObject(a2.toWin(payload));
        assert.ok(res.loaded.indexOf('buildup_raw') !== -1 && res.loaded.indexOf('storage') !== -1, 'modules loaded: ' + res.loaded.join(','));
        a2.hook.nav('buildup');
        for (let i = 0; i < 20; i++) await a2.flushAsync(1);
        assert.strictEqual(txt(a2.el('bu_s_S1')), S1, 'same S1 after Open');
        assert.ok(P(a2).mem().record && P(a2).mem().record.hash === a.record.hash, 'raw record restored (hash matches)');
        assert.strictEqual(txt(a2.el('bu_raw_note')), '', 'no "not embedded" note');
        assert.strictEqual(a2.win.WTS_buildup.store.audit.list().length, W.WTS_buildup.store.audit.list().length, 'audit trail restored');
        assert.ok(a2.win.WTS_buildup.store.audit.verify().ok, 'audit chain verifies after Open');
        assert.strictEqual(P(a2).stale(), false);
      } finally { a2.dispose(); }
    },
  },
  {
    name: 'PG11 page well switch: the other well\'s state is shown; switching back restores the results',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      await demoRun(app);
      const W = app.win, first = W.WTS_wells.active(), S1 = txt(app.el('bu_s_S1'));
      const r = W.WTS_wells.create('Well B');
      assert.ok(r.ok, 'well B created');
      app.flush(50);
      assert.ok(app.el('bu_root'), 'page re-rendered for well B');
      assert.notStrictEqual(app.el('bu_res').getAttribute('data-done'), '1', 'well B has no analysis');
      assert.ok(!(W.WTS_state.buildup), 'nothing published for well B');
      assert.strictEqual(P(app).mem().record, null, 'well A\'s gauge data is not reused');
      const sw = W.WTS_wells.switchTo(first);
      assert.ok(sw.ok);
      app.flush(50);
      for (let i = 0; i < 10; i++) await app.flushAsync(1);
      assert.strictEqual(app.el('bu_res').getAttribute('data-done'), '1', 'well A results back');
      assert.strictEqual(txt(app.el('bu_s_S1')), S1);
    },
  },
  {
    name: 'PG12 page Open in PRiSM: confirm first, then PRiSM_openExternalBuildup gets ds, paste text, multi-rate, tShut, pwf0 and fitC4',
    wp: WP,
    async run(app, assert, ctx) {
      applySeed(app, await seed(ctx));
      open(app);
      const W = app.win;
      let arg = null;
      W.PRiSM_openExternalBuildup = function (o) { arg = o; return { ok: true, period: 0 }; };
      W.calcBuildup();
      const a = P(app).state().analysis;
      const t = a.tests.filter((x) => x.status === 'interpreted' && x.result).slice(-1)[0];
      assert.strictEqual(app.el('bu_open_prism').disabled, false, 'enabled with results');
      app.click('bu_open_prism');
      assert.ok(app.dialogs.some((d) => d.type === 'confirm' && /replaces the PRiSM dataset/.test(d.message) && d.message.indexOf(t.id) !== -1), 'confirm names the build-up');
      assert.ok(arg, 'PRiSM_openExternalBuildup called');
      assert.ok(arg.ds && arg.ds.t.length === arg.ds.p.length && arg.ds.t.length > 5, 'dataset arrays');
      assert.ok(arg.ds.t.length <= 3000, '≤ 3,000 rows');
      assert.ok(/^t_hr,p_psia\n/.test(arg.pasteText), 'paste text header');
      assert.strictEqual(arg.pasteText.trim().split('\n').length, arg.ds.t.length + 1);
      assert.strictEqual(arg.ds.t[0], 0, 'time zero = first kept sample');
      assert.ok(Array.isArray(arg.multiRate) && arg.multiRate.length >= 2, 'multi-rate steps');
      const lastStep = arg.multiRate[arg.multiRate.length - 1];
      assert.ok(lastStep.q === 0 && Math.abs(lastStep.t - arg.tShut) < 1e-6, 'history ends with q = 0 at tShut');
      assert.ok(arg.tShut >= 0 && arg.multiRate.every((s) => s.t <= arg.tShut + 1e-9), 'rate history on the dataset clock, up to tShut');
      if (!P(app).mem().record && FIX.samples.GaugeRecord.hash === a.record.hash) {
        // with the raw record in memory, the flowing part (one point per 15 min over 10·Δt_end) comes first
        P(app).mem().record = app.toWin(FIX.samples.GaugeRecord);
        P(app).mem().wellId = app.win.WTS_buildup.store.wellId();
        arg = null;
        app.hook.nav('buildup'); app.flush(20);
        W.calcBuildup();
        app.click('bu_open_prism');
        assert.ok(arg && arg.tShut > 0, 'flowing record before the shut-in');
        const dts = arg.ds.t.filter((x) => x < arg.tShut);
        for (let k = 1; k < dts.length; k++) assert.ok(dts[k] - dts[k - 1] >= 0.249, 'one flowing point per 15 min');
        assert.ok(arg.tShut <= 10 * t.dtEnd_h + 0.26, 'flowing part limited to 10·Δt_end');
      }
      assert.strictEqual(arg.pwf0, t.pwf0);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(arg.fitC4)), JSON.parse(JSON.stringify(t.result.fitC4)), 'fitC4 passed');
      assert.strictEqual(arg.modelKey, t.result.chosen.key);
      assert.strictEqual(arg.well.q, t.Dq);
      assert.strictEqual(arg.well.testType, 'buildup');
      assert.strictEqual(app.hook.page(), 'prism', 'navigated to PRiSM');
      // declined confirm → nothing
      const a2 = ctx.loadApp({ storage: app.storage, confirm: false });
      try {
        install(a2);
        let n = 0;
        a2.win.PRiSM_openExternalBuildup = function () { n++; return { ok: true }; };
        a2.hook.nav('buildup'); a2.flush(20);
        a2.win.calcBuildup();
        a2.click('bu_open_prism');
        assert.strictEqual(n, 0, 'declined → not called');
      } finally { a2.dispose(); }
    },
  },
  {
    name: 'PG13 page GUI-sweep edge values: physical inputs give a ✗ verdict and input-err with no analysis; settings are clamped and echoed in S2; no NaN / null text',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      open(app);
      app.select('bu_src', 'demo');
      app.click('bu_demo_load');
      let started = 0;
      const R = app.win.WTS_buildup.run, orig = R.analyseAsync;
      R.analyseAsync = function () { started++; return orig.apply(this, arguments); };
      const ranges = P(app).ranges;
      const phys = Object.keys(ranges).filter((id) => ranges[id][4] === 'phys' || ranges[id][4] === 'opt').filter((id) => shown(app.el(id)));
      assert.ok(phys.length >= 8, 'visible physical inputs: ' + phys.join(','));
      for (const id of phys) {
        const keep = app.el(id).value;
        for (const v of ['', '0', '-1', '1e12']) {
          if (v === '' && ranges[id][4] === 'opt') continue;
          if (v === '0' && ranges[id][2] <= 0) continue;
          app.input(id, v);
          app.click('bu_run');
          assert.strictEqual(P(app).isRunning(), false, id + '=' + v + ': no analysis');
          assert.match(txt(app.el('bu_val')), /^✗/, id + '=' + v + ': ✗ verdict');
          assert.ok(app.el(id).classList.contains('input-err'), id + '=' + v + ': input-err');
          assert.ok(txt(app.el('bu_val')).length < 300);
        }
        app.input(id, keep);
      }
      assert.strictEqual(started, 0, 'no analysis started by invalid inputs');
      // settings: clamped and echoed
      app.check('bu_adv', true);
      app.input('bu_d_win', '1e12'); app.input('bu_i_band', '-1'); app.input('bu_t_base', '0'); app.input('bu_t_delta', '');
      const g = P(app).gather();
      assert.strictEqual(g.bad.length, 0, 'settings never block Analyse: ' + Array.from(g.errors).join(' '));
      assert.strictEqual(g.input.settings.detect.winMin, 60);
      assert.strictEqual(g.input.settings.interp.band, 0.05);
      assert.strictEqual(g.input.settings.trend.baseN, 1);
      assert.strictEqual(g.input.settings.trend.delta, 2, 'blank → default');
      app.click('bu_run');
      assert.ok(await idle(app));
      assert.strictEqual(P(app).state().analysis.settings.detect.winMin, 60, 'clamped value used');
      assert.ok(/(^|[^\d.])60(?![\d.])/.test(secText(app, 'S2')), 'clamped detection window echoed in S2: ' + secText(app, 'S2').slice(0, 200));
      const allTxt = txt(app.el('bu_root'));
      assert.ok(!BAD_TXT.test(allTxt), 'no NaN / Infinity / null / undefined text: ' + (allTxt.match(BAD_TXT) || [])[0]);
      // every select option is valid
      app.findAll('#bu_root select').filter((s) => !/^bu_(dlg_|test_sel|g_c|a_c|h_tag)/.test(s.id)).forEach((s) => {
        const keep = s.value;
        Array.from(s.options).forEach((o) => app.select(s, o.value));
        app.select(s, keep);
      });
      assert.strictEqual(app.errors.length, 0, app.errors.map((e) => e.message).join('; '));
    },
  },
  {
    name: 'PG14 page GUI-sweep elapsed-hours CSV in the file input: parsed, and rate-table mode is proposed because of the rate column',
    wp: WP,
    async run(app, assert) {
      open(app);
      const rows = ['time_hr,pressure_psi,rate_stbd'];
      for (let i = 0; i < 80; i++) { const t = 0.001 * Math.pow(10, i / 16); rows.push(t.toFixed(5) + ',' + (2500 + 180 * Math.log10(1 + t * 1000)).toFixed(2) + ',0'); }
      const W = app.win, f = new W.File([rows.join('\n')], 'sample.csv', { type: 'text/csv' });
      const inp = app.el('bu_g_file');
      Object.defineProperty(inp, 'files', { value: [f], configurable: true });
      app.select('bu_src', 'file');
      app.click('bu_g_load');
      for (let i = 0; i < 20; i++) await app.flushAsync(1);
      const st = txt(app.el('bu_g_status'));
      assert.match(st, /Loaded 80 samples/, 'parsed: ' + st);
      assert.match(st, /rate-table mode is proposed/, 'rate-table mode proposed');
      assert.strictEqual(app.el('bu_rate_mode').value, 'table');
      assert.strictEqual(P(app).mem().record.n, 80);
      assert.ok(app.el('bu_g_map').style.display !== 'none', 'column mapping shown');
      assert.ok(auditKinds(app).indexOf('import') !== -1, 'import recorded in the audit trail');
      assert.strictEqual(app.errors.length, 0);
    },
  },
  {
    name: 'PG15 iOS CSS: #bu_root .bu-dlg overlay safe-area rule and the .bu-dlg-box 100vh / 100dvh rules',
    wp: WP,
    opts: false,
    run(app, assert) {
      const css = fs.readFileSync(path.join(REPO, 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      assert.match(css, /html\.ios-app #bu_root \.bu-dlg\s*\{[^}]*box-sizing:\s*border-box[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)[^}]*\}/, 'overlay padding rule');
      const box = /html\.ios-app #bu_root \.bu-dlg-box\s*\{([^}]*)\}/.exec(css);
      assert.ok(box, '.bu-dlg-box rule');
      const i1 = box[1].indexOf('100vh'), i2 = box[1].indexOf('100dvh');
      assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2, '100vh fallback before 100dvh');
      assert.match(css, /#bu_root \.bu-dlg-x\s*\{[^}]*44px/, '44 px close button');
    },
  },
  {
    name: 'PG16 host: WTS_appVersion() returns RELEASE_NOTES[0].ver; a "calibrated confidence" release note requires a calibrated file 55',
    wp: WP,
    run(app, assert) {
      const html = fs.readFileSync(path.join(REPO, 'well-testing-app.html'), 'utf8');
      const m = /const RELEASE_NOTES = \[\s*\{ ver:'(v[0-9.]+)'[\s\S]*?\]\s*\}/.exec(html);
      assert.ok(m, 'RELEASE_NOTES found');
      assert.strictEqual(app.win.WTS_appVersion(), m[1]);
      if (/calibrated confidence/.test(m[0])) {
        const cal = app.win.PRiSM_autoInterpCal;
        assert.ok(cal && cal.calibrated === true, 'release note says "calibrated confidence" → PRiSM_autoInterpCal.calibrated');
      }
    },
  },
  {
    name: 'PG17 page well switch during a running analysis: the discarded run writes no state and no "run" audit entry for either well; no timers',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      open(app);
      app.select('bu_src', 'demo');
      app.click('bu_demo_load');
      const W = app.win, first = W.WTS_wells.active();
      app.click('bu_run');
      assert.ok(P(app).isRunning(), 'running');
      const r = W.WTS_wells.create('Well B');
      assert.ok(r.ok);
      for (let i = 0; i < 200; i++) await app.flushAsync(1);
      assert.strictEqual(P(app).isRunning(), false);
      assert.strictEqual(app.storage.getItem('wts_buildup_state'), null, 'well B: no state written');
      assert.ok(auditKinds(app).indexOf('run') === -1, 'well B: no run entry');
      const blob = JSON.parse(app.storage.getItem('wts_well_' + first) || '{"keys":{}}');
      assert.ok(!blob.keys.wts_buildup_state, 'well A: no state written by the discarded run');
      const aud = blob.keys.wts_buildup_audit ? JSON.parse(blob.keys.wts_buildup_audit).entries.map((e) => e.kind) : [];
      assert.ok(aud.indexOf('run') === -1, 'well A: no run entry');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
    },
  },
  {
    name: 'PG18 page 375 px layout: #bu_root fits the viewport after results render; charts use the 600×400 size',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    async run(app, assert, ctx) {
      applySeed(app, await seed(ctx));
      open(app);
      for (let i = 0; i < 30; i++) await app.flushAsync(1);
      assert.strictEqual(app.el('bu_res').getAttribute('data-done'), '1');
      assert.ok(app.el('bu_root').scrollWidth <= 375, 'no sideways scroll: ' + app.el('bu_root').scrollWidth);
      const cv = app.canvases(app.el('bu_res'));
      assert.ok(cv.length >= 3);
      cv.forEach((c) => assert.ok(c.width === 600 && c.height === 400, c.id + ' ' + c.width + '×' + c.height));
      const wide = app.findAll('#bu_root [style]').filter((e) => { const m = /(?:^|;)\s*(?:min-)?width:\s*(\d+)px/.exec(e.getAttribute('style') || ''); return m && +m[1] > 375; });
      assert.deepStrictEqual(wide.map((e) => e.id || e.localName), [], 'no fixed widths wider than the phone');
      app.findAll('#bu_res .bu-tw').forEach((w) => { if (w.querySelector('#bu_tbl_tests, #bu_tbl_review')) assert.ok(w.hasAttribute('data-no-stack'), 'S4/S9 tables scroll inside their box'); });
    },
  },
  {
    name: 'PG19 page S5 from a seeded state: "N low tests excluded" and a "possible" alert',
    wp: WP,
    async run(app, assert, ctx) {
      applySeed(app, await seed(ctx), (o) => {
        o.analysis.trend.alerts.delta.status = 'possible';
        o.analysis.trend.alerts.delta.raisedAt = null; o.analysis.trend.alerts.delta.confirmedAt = null;
        o.analysis.trend.excludedLow = { n: 2, ids: [o.analysis.tests[0].id, o.analysis.tests[1].id], S: [3.1, 4.2], ev: ['T16'] };
        o.review = null;
      });
      open(app);
      const s5 = secText(app, 'S5') + ' ' + secText(app, 'S1');
      assert.match(s5, /2 low tests? excluded/i, 'excluded low tests shown: ' + s5.slice(0, 300));
      assert.match(s5, /possible/i, 'possible alert shown');
      assert.strictEqual(app.win.WTS_state.buildup.delta.status, 'possible');
    },
  },
  {
    name: 'PG20 comparison page (29-multiwell): four build-up rows; the latest S after an async run and after a reload',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      await demoRun(app);
      for (let i = 0; i < 4; i++) await app.flushAsync(1);
      const W = app.win, S = latestS(app);
      const cell = (w, key) => { const t = w.WTS_wells.table(); return t.cells[t.rows.findIndex((r) => r.key === key)][t.wells.findIndex((x) => x.active)]; };
      const want = Number(S).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
      const t = W.WTS_wells.table();
      ['buS', 'buDS', 'buAlert', 'buK'].forEach((k) => assert.ok(t.rows.some((r) => r.key === k && r.src === 'Build-up Surveillance'), 'row ' + k));
      assert.strictEqual(cell(W, 'buS'), want, 'latest skin after the run');
      assert.ok(/^(No alert|Possible|Provisional|Confirmed)$/.test(cell(W, 'buAlert')), 'alert label, not a number: ' + cell(W, 'buAlert'));
      assert.match(app.storage.getItem('wts_mw_results') || '', /"buildup"/, 'cached for the comparison page');
      const a2 = app.reload();
      try {
        assert.strictEqual(cell(a2.win, 'buS'), want, 'latest skin after a reload (page not opened)');
      } finally { a2.dispose(); }
    },
  },
];
