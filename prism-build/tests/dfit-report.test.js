// DFIT — WP3 evidence column, pick log, quoted-value self-check, data + picks export, frac sheet, hand-off
// (docs/DFIT-PLAN.md §6.10, §2.10, §2.11, §6.8; §9 WP3).
//
//   R1  every headline number has ≥ 1 evidence id and the appendix lists every id used
//   R2  the quoted-value check passes on the reference (no check line) and fails on a tampered model (one ⚠ line naming it)
//   R3  the report model lists the pick-log entries of FIX.state in order with their reasons
//   R4  the export contains the events, the picks and the data, and parses back to the same t/p (± display precision)
//   R5  frac-sheet rows and CSV columns, with both family columns for the range test of FIX.state
//   R6  a hand-off packet with a low-confidence p_i lists it as a blocker; qEq = (V_i − V_fill − V_fb)/tp_veq
//   R7  a custom export template reorders and renames the columns
//   R8  no value cell of the report model contains an inline evidence bracket
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF3';
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
function app0(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a; }
const INLINE_EV = /\[[QXEIHSGCKMFALUPO]\d+([·,\s]+[QXEIHSGCKMFALUPO]\d+)*\]/;
// FIX.run without its fixture evidence/report: the engine builds them
function refRun() { const r = S.FIX.run; r.evidence = null; r.report = null; return r; }
// the range test of FIX.state (t2): closure range 6,495–7,004 psia, family medians F1 6,998 / F2 6,507, chains per family
function rangeRun() {
  const r = refRun(), F = S.FIX.ref, c = r.consensus;
  c.mode = 'range'; c.value = null; c.confidence = 'medium'; c.bimodal = true;
  c.range = { lo: 6495, hi: 7004, medians: { low: 6507, high: 6998 }, lowFamily: 'F2', highFamily: 'F1' };
  c.families.F1 = { p10: 6993, p50: 6998, p90: 7003, sigma: 4, n: 104 }; c.families.F2 = { p10: 6499, p50: 6507, p90: 6515, sigma: 6, n: 104 };
  r.frac = { chosen: null, byFamily: { F1: F.chain(6998, { family: 'F1', method: 'compliance' }), F2: F.chain(6507, { family: 'F2', method: 'tangent' }) } };
  r.unc = null;
  return r;
}
function cellsOf(model) {
  const out = [];
  model.sections.forEach((s) => s.blocks.forEach((b) => {
    if (b.kind === 'kv') b.rows.forEach((r) => out.push({ v: r[1], ev: r[2], s: s.id, kind: 'kv', label: r[0] }));
    else if (b.kind === 'table') b.rows.forEach((r) => r.forEach((c, j) => out.push({ v: c, s: s.id, kind: 'table', head: b.head[j], evCol: b.head[j] === 'Ev.' })));
    else if (b.kind === 'kpi') b.items.forEach((it) => out.push({ v: it.value, ev: it.ev, s: s.id, kind: 'kpi' }));
  }));
  return out;
}

module.exports = [
  {
    name: 'R1 every headline number has ≥ 1 evidence id and the appendix lists every id used',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = refRun(), m = win.PRiSM_dfit_reportModel(run, { zone: 'Zone A' });
      const sh = S.checkShape('ReportModel', m); assert(sh.ok, 'ReportModel shape: ' + JSON.stringify(sh.errors.slice(0, 5)));
      assert(S.checkShape('EvidenceIndex', m.appendix).ok, 'EvidenceIndex shape');
      const head = m.sections.find((s) => s.id === 'dfit-headline');
      assert(head, 'headline section');
      head.blocks.filter((b) => b.kind === 'kv').forEach((b) => b.rows.forEach((r) => {
        if (/\d/.test(r[1]) && r[0] !== 'Grade') assert(Array.isArray(r[2]) && r[2].length >= 1, 'headline row "' + r[0] + '" carries an evidence id');
      }));
      head.blocks.filter((b) => b.kind === 'table' && b.ev).forEach((b) => { const j = b.head.indexOf('Ev.'); b.rows.forEach((r) => assert(typeof r[j] === 'string' && r[j].length > 0, 'headline table row "' + r[0] + '" Ev.')); });
      const used = new Set();
      cellsOf(m).forEach((c) => { if (c.ev) c.ev.forEach((id) => used.add(id)); if (c.evCol && typeof c.v === 'string') c.v.split(/\s+/).filter(Boolean).forEach((id) => used.add(id)); });
      assert(used.size >= 5, 'several ids used: ' + Array.from(used).join(' '));
      used.forEach((id) => assert(m.appendix.items[id], 'appendix lists ' + id));
      const ev = win.PRiSM_dfit_evidence(run);
      assert(S.checkShape('EvidenceIndex', ev).ok && ev.order.indexOf('C1') >= 0 && ev.order.indexOf('A1') >= 0 && ev.order.indexOf('K1') >= 0, 'evidence index of the run (C1, A1, K1)');
      assert(ev.order.indexOf('Q1') < ev.order.indexOf('C1') && ev.order.indexOf('C1') < ev.order.indexOf('A1'), 'fixed group order Q … C … A');
      assert(m.sections.some((s) => s.id === 'dfit-log' && s.blocks.some((b) => b.kind === 'table' && b.head[0] === 'Id')), 'evidence appendix table in the log section');
    },
  },
  {
    name: 'R2 the quoted-value check passes on the reference (no line) and fails on a tampered model with one ⚠ line naming the value',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = refRun(), m = win.PRiSM_dfit_reportModel(run, {});
      const isCheck = (b) => b.kind === 'verdict' && /Quoted-value self-check/.test(b.text);
      assert(m.quoted.ok === true && m.quoted.nFailed === 0, 'the reference passes');
      assert(!m.sections.some((s) => s.blocks.some(isCheck)), 'no check line when it passes');
      const c0 = win.PRiSM_dfit_checkQuoted(m, run);
      assert(c0.ok && c0.nChecked >= 8 && c0.nFailed === 0, 'checked ' + c0.nChecked + ' quoted values');
      const t = JSON.parse(JSON.stringify(m)), kv = t.sections[0].blocks[0], row = kv.rows.find((r) => r[0] === 'Closure');
      row[1] = '7,010 psia';
      const c1 = win.PRiSM_dfit_checkQuoted(t, run, { annotate: true });
      assert(c1.ok === false && c1.nFailed === 1 && c1.failures[0].ref === 'Closure' && c1.failures[0].quoted === 7010, 'the tampered closure fails: ' + JSON.stringify(c1.failures));
      const lines = []; t.sections.forEach((s) => s.blocks.forEach((b) => { if (isCheck(b)) lines.push(b); }));
      assert(lines.length === 1 && /^⚠/.test(lines[0].text) && /Closure/.test(lines[0].text) && lines[0].level === 'warn', 'one ⚠ line naming the value: ' + JSON.stringify(lines));
      assert(t.quoted.ok === false && t.quoted.nFailed === 1, 'model.quoted');
      row[1] = '7,000 psia'; win.PRiSM_dfit_checkQuoted(t, run, { annotate: true });
      assert(!t.sections.some((s) => s.blocks.some(isCheck)), 'the line goes when the value is right again');
      // half a unit in the last displayed digit
      row[1] = '7,000.4 psia'; assert(win.PRiSM_dfit_checkQuoted(t, run).nFailed === 0, '0.4 psi inside half a unit');
    },
  },
  {
    name: 'R3 the report model lists the pick-log entries of FIX.state in order with their reasons',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, log = S.FIX.state.tests[1].log, m = win.PRiSM_dfit_reportModel(rangeRun(), { log, zone: 'Zone B' });
      assert(S.checkShape('ReportModel', m).ok, 'ReportModel shape: ' + JSON.stringify(S.checkShape('ReportModel', m).errors.slice(0, 4)));
      const sec = m.sections.find((s) => s.id === 'dfit-log'), tb = sec.blocks.find((b) => b.kind === 'table' && b.head[0] === 'Seq');
      assert(tb && tb.rows.length === log.length, 'one row per entry');
      log.forEach((e, i) => {
        assert(tb.rows[i][0] === e.seq && tb.rows[i][3] === e.item && tb.rows[i][5] === e.reason, 'entry ' + e.seq + ' in order with its reason');
        assert(tb.rows[i][2] === e.who && tb.rows[i][1] === e.at, 'who and when');
      });
      assert(/0\.5 → 0\.6/.test(tb.rows[0][4]), 'old → new');
      assert(/closure range 6,495–7,004 psia \(medians 6,507 \/ 6,998; medium\)/.test(m.keyLine), 'range key line: ' + m.keyLine);
      assert(m.title === 'DFIT analysis — Zone B', 'title');
    },
  },
  {
    name: 'R4 the export contains the events, picks and data and parses back to the same t/p (± display precision)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = refRun(), x = win.PRiSM_dfit_exportText(run, 'default');
      assert(x.ok === true && /^dfit-test-[0-9a-f]{8}\.txt$/.test(x.filename) && x.filename.indexOf(run.dsHash.slice(0, 8)) > 0, 'filename ' + x.filename);
      ['# EVENTS', '# PICKS', '# CLOSURE', '# RESULTS', '# GRADE', '# DATA'].forEach((h) => assert(x.text.indexOf(h) >= 0, h));
      run.picks.forEach((p) => assert(x.text.indexOf('# ' + p.method + ' (' + p.family) >= 0, 'pick ' + p.method));
      assert(/shut-in h: 0\.116666667/.test(x.text), 'events line with the shut-in');
      const L = x.text.split('\n'), i0 = L.indexOf('# DATA');
      assert(L[i0 + 1] === 't_h\tp_psia\tq_bbl_min\tafter_closure', 'default columns: ' + L[i0 + 1]);
      const rows = L.slice(i0 + 2).filter((l) => l.length).map((l) => l.split('\t').map(Number));
      assert(rows.length === run.prep.t.length, 'every prepared sample');
      rows.forEach((r, i) => { near(assert, r[0], run.prep.t[i], 5e-7, 't[' + i + ']'); near(assert, r[1], run.prep.pw[i], 5e-4, 'p[' + i + ']'); });
      assert(rows[0][3] === 0 && rows[rows.length - 1][3] === 1, 'before/after-closure flag');
      assert(!/\b(null|undefined|NaN|Infinity)\b/.test(x.text), 'no banned words');
      const named = win.PRiSM_dfit_exportText(run, { name: 'Zone A / DFIT 1', inputs: S.FIX.state.tests[0].inputs, log: S.FIX.state.tests[1].log });
      assert(/^dfit-zone-a-dfit-1-/.test(named.filename) && /# datum TVD ft: 10000/.test(named.text) && /# log 1 /.test(named.text), 'name, inputs and log in the header');
    },
  },
  {
    name: 'R5 frac-sheet rows and CSV columns, with both family columns for the range test',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, one = win.PRiSM_dfit_fracSheet(refRun());
      assert(one.ok === true && one.rows.length >= 12, 'single-mode rows ' + one.rows.length);
      assert(one.head.join(',') === 'name,family,p10,p50,p90,unit,lens,ev', 'columns');
      const cl = one.rows.find((r) => r[0] === 'Closure stress');
      assert(cl && cl[1] === null && cl[3] === S.FIX.run.frac.chosen.pClosure && cl[2] != null && cl[4] != null, 'closure row with P10/P50/P90 from the uncertainty: ' + JSON.stringify(cl));
      const rg = win.PRiSM_dfit_fracSheet(rangeRun());
      ['Closure stress', 'Net pressure', 'xf (PKN)', 'CL (conditional on the geometry)'].forEach((nm) => {
        const f1 = rg.rows.find((r) => r[0] === nm && r[1] === 'F1'), f2 = rg.rows.find((r) => r[0] === nm && r[1] === 'F2');
        assert(f1 && f2 && f1[3] !== f2[3], nm + ': both family rows');
      });
      near(assert, rg.rows.find((r) => r[0] === 'Closure stress' && r[1] === 'F2')[3], 6507, 0.5, 'F2 closure');
      const lines = rg.csv.trim().split('\n');
      assert(lines[0] === 'name,family,p10,p50,p90,unit,lens,ev' && lines.length === rg.rows.length + 1, 'CSV header and one line per row');
      lines.slice(1).forEach((l, i) => { const n = l.replace(/"[^"]*"/g, 'x').split(',').length; assert(n === 8, 'CSV line ' + i + ' has 8 fields: ' + l); });
      assert(lines.some((l) => /,F1,/.test(l)) && lines.some((l) => /,F2,/.test(l)), 'family column in the CSV');
    },
  },
  {
    name: 'R6 a hand-off packet with a low-confidence p_i lists it as a blocker; qEq = (V_i − V_fill − V_fb)/tp_veq',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = refRun();
      run.aca.pi.label = 'low';
      const h = win.PRiSM_dfit_handoff(run, 'pta', {});
      const sh = S.checkShape('HandoffPacket', h); assert(sh.ok, 'HandoffPacket shape: ' + JSON.stringify(sh.errors.slice(0, 4)));
      assert(h.blockers.some((b) => /p_i label is low/.test(b)) && !('pi' in h.setWell), 'low p_i is a blocker and is not handed over');
      const ev = run.events, q = (ev.Vi - ev.Vfill - ev.Vfb) / (ev.tp.veq * 60);
      near(assert, h.qEq, q, 1e-12, 'qEq (bbl/min)');
      assert(h.multiRate.length === 2 && Math.abs(h.multiRate[0].q - q * 1440) < 1e-9 && h.multiRate[1].q === 0 && Math.abs(h.multiRate[1].t - ev.ts) < 1e-12, 'idealised schedule in bbl/d');
      assert(h.setWell.testType === 'falloff' && h.setWell.tShut === ev.ts && h.setWell.tp === ev.tp.veq && h.setWell.pwf0 === run.isip.value, 'C1 fields');
      assert(h.model === 'infiniteFrac' && h.seeds.xf === run.frac.chosen.geometry.byModel.PKN.xf, 'linear flow → infiniteFrac seeded with the PKN xf');
      run.aca.pi.label = 'medium';
      const h2 = win.PRiSM_dfit_handoff(run, 'pta', {});
      assert(h2.blockers.length === 0 && h2.setWell.pi === run.aca.pi.value, 'medium p_i is handed over');
      const rg = rangeRun(), h3 = win.PRiSM_dfit_handoff(rg, 'pta', {}), h4 = win.PRiSM_dfit_handoff(rg, 'pta', { family: 'F2' });
      assert(h3.blockers.some((b) => /choose the closure family/.test(b)) && h4.family === 'F2' && !h4.blockers.some((b) => /choose/.test(b)), 'range mode needs a family');
      const rt = win.PRiSM_dfit_handoff(run, 'rta', {}), fr = win.PRiSM_dfit_handoff(run, 'frac', {});
      assert(S.checkShape('HandoffPacket', rt).ok && rt.rta && rt.rta.k > 0 && S.checkShape('HandoffPacket', fr).ok && fr.sheet.length > 10, 'RTA and frac packets');
    },
  },
  {
    name: 'R7 a custom export template reorders and renames the columns',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = refRun();
      const x = win.PRiSM_dfit_exportText(run, { columns: [{ key: 'p', label: 'Pressure (psia)' }, { key: 'dt', label: 'Shut-in time (h)' }, { key: 'flag', label: 'AC' }], sep: ',', decimals: { p: 2, dt: 5 }, header: ['Operator Energy Ltd submission'] });
      const L = x.text.split('\n'), i0 = L.indexOf('# DATA');
      assert(L[i0 + 1] === 'Pressure (psia),Shut-in time (h),AC', 'renamed and reordered: ' + L[i0 + 1]);
      const r = L[i0 + 2].split(',');
      assert(r.length === 3 && r[0] === run.prep.pw[0].toFixed(2) && r[1] === (run.prep.t[0] - run.events.ts).toFixed(5), 'values in the template order and decimals: ' + L[i0 + 2]);
      assert(L.indexOf('# Operator Energy Ltd submission') >= 0, 'template header line');
    },
  },
  {
    name: 'R8 no value cell of the report model contains an inline evidence bracket',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      [refRun(), rangeRun()].forEach((run, k) => {
        const m = win.PRiSM_dfit_reportModel(run, { log: S.FIX.state.tests[1].log });
        cellsOf(m).forEach((c) => { if (typeof c.v === 'string') assert(!INLINE_EV.test(c.v), 'model ' + k + ' ' + c.s + ': no inline bracket in "' + c.v + '"'); });
        m.keyRows.forEach((r) => assert(!INLINE_EV.test(r[1]), 'key row ' + r[0]));
        assert(!INLINE_EV.test(m.keyLine), 'key line');
        assert(S.checkShape('ReportModel', m).ok, 'shape ' + k);
      });
      const bad = win.PRiSM_dfit_reportModel(refRun(), {}); bad.sections[0].blocks[0].rows[0][1] = '7,000 psia [C1·C2]';
      assert(!S.checkShape('ReportModel', bad).ok, 'the contract rejects an inline bracket');
    },
  },
];
