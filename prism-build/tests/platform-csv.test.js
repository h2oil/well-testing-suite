// P9 CSV import of test-point tables — host WTS_csv (parser, header / unit
// detection, validation) and the paste panels on Gas Deliverability
// (41-calc-gasdeliv.js) and Oil Well IPR (42-calc-oilipr.js).
//
// Expected conversions are hand calculations with the NIST SP 811 (2008)
// Appendix B factors, independent of the code under test:
//   1 psi = 6.894757 kPa; 1 bar = 100 kPa; 1 atm = 101.325 kPa = 14.69595 psi;
//   1 ft³ = 0.02831685 m³; 1 bbl = 0.1589873 m³.
// The gas-deliverability check values (n = 0.8700, AOF = 9033.5 MSCFD) are the
// G1 flow-after-flow textbook case already used by calc-new1 (Rawlins &
// Schellhardt back-pressure fit of 2624.6/1700, 4154.7/1500, 5425.1/1300 at
// p̄r = 1952 psia).
'use strict';

const WP = 'P9CSV';
const PSI_KPA = 6.894757, ATM = 14.69595, FT3 = 0.02831685, BBL = 0.1589873;

const gasSpec = (w) => ({
  maxRows: 6, leadingEnum: 'kind', positional: ['kind', 'q', 'pwf', 'pws'],
  columns: [
    { key: 'kind', label: 'Point type', kind: 'enum', names: ['type'], values: { stab: new w.RegExp('^stab', 'i'), trans: new w.RegExp('^trans', 'i') } },
    { key: 'q', label: 'Rate q', kind: 'gasRate', cat: 'gasRateSmall', required: true, positive: true, names: ['q', 'rate'] },
    { key: 'pwf', label: 'pwf', kind: 'pressure', cat: 'pressure', required: true, positive: true, names: ['pwf'] },
    { key: 'pws', label: 'pws', kind: 'pressure', cat: 'pressure', positive: true, names: ['pws'] },
  ],
});
function openPage(app, key, root) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no ' + key + ' sidebar button');
  app.click(b);
  if (!app.el(root)) throw new Error(key + ' page did not render');
}
// canonical (imperial) value of a tagged input
const canon = (app, id) => parseFloat(app.win.WTS_units.runCanonical(() => app.el(id).value));
function paste(app, hostId, text) {
  const host = app.el(hostId);
  app.click(host.querySelector('[data-csv="toggle"]'));
  const ta = host.querySelector('[data-csv="text"]');
  ta.value = text;
  app.click(host.querySelector('[data-csv="import"]'));
  return String(host.querySelector('[data-csv="msg"]').textContent || '');
}

module.exports = [
  {
    name: 'parser: comma / semicolon / tab, RFC 4180 quotes, BOM, CRLF, decimal commas and thousands separators',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_csv;
      let p = C.parse('﻿a,"b, ""quoted""",c\r\n1,2,3\r\n\r\n');
      assert.strictEqual(p.delim, ',');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(p.rows)), [['a', 'b, "quoted"', 'c'], ['1', '2', '3']]);
      p = C.parse('q;pwf\n1,5;1700,25');
      assert.strictEqual(p.delim, ';');
      assert.strictEqual(C.num(p.rows[1][0], ';'), 1.5, 'decimal comma with ; delimiter');
      assert.strictEqual(C.parse('q\tpwf\n1\t2').delim, '\t');
      assert.strictEqual(C.num('"1,234.5"'.replace(/"/g, ''), ','), 1234.5, 'thousands separator');
      assert.strictEqual(C.num('2.5e3', ','), 2500);
      assert.ok(isNaN(C.num('12abc', ',')) && isNaN(C.num('', ',')), 'non-numbers → NaN');
      const h = C.splitHeader('pwf [psig]');
      assert.strictEqual(h.name, 'pwf'); assert.strictEqual(h.unit, 'psig');
      assert.strictEqual(C.splitHeader('Rate q (MMSCFD)').unit, 'MMSCFD');
      assert.strictEqual(C.splitHeader('pwf, kPa').unit, 'kPa');
    },
  },
  {
    name: 'units in the header or a unit row are converted to psia / MSCFD / BPD (NIST factors); gauge → absolute with 1 atm',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_csv, w = app.win;
      // 1700 psia written five ways; 2624.6 MSCFD written four ways.
      const kpa = 1700 * PSI_KPA, bar = kpa / 100, barg = (1700 - ATM) * PSI_KPA / 100, psig = 1700 - ATM;
      const e3 = 2624.6 * 1000 * FT3 / 1000, m3d = 2624.6 * 1000 * FT3;
      const txt = 'q (MMSCFD),pwf (kPa),pws [bar]\n2.6246,' + kpa + ',' + bar + '\n';
      let r = C.table(txt, gasSpec(w));
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.rel(r.rows[0].q, 2624.6, 1e-9, 'MMSCFD');
      assert.rel(r.rows[0].pwf, 1700, 1e-9, 'kPa');
      assert.rel(r.rows[0].pws, 1700, 1e-9, 'bar');
      r = C.table('rate,pwf,pws\ne3m3/d,barg,psig\n' + e3 + ',' + barg + ',' + psig + '\n', gasSpec(w));
      assert.ok(r.ok && r.header, 'unit row accepted: ' + JSON.stringify(r.errors));
      assert.rel(r.rows[0].q, 2624.6, 1e-9, 'e3m3/d');
      assert.rel(r.rows[0].pwf, 1700, 1e-9, 'barg');
      assert.rel(r.rows[0].pws, 1700, 1e-9, 'psig');
      assert.ok(r.warnings.some((x) => /gauge pressures converted to absolute/.test(x)), 'gauge warning');
      assert.ok(r.warnings.some((x) => /no base-condition correction/.test(x)), 'm³ basis warning');
      r = C.table('q (sm3/d);pwf (psia)\n' + String(m3d).replace('.', ',') + ';1700\n', gasSpec(w));
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.rel(r.rows[0].q, 2624.6, 1e-9, 'sm3/d with decimal comma');
      // liquid rates
      const oil = { maxRows: 4, positional: ['q', 'pwf'], columns: [
        { key: 'q', label: 'Rate q', kind: 'liquidRate', cat: 'liquidRate', required: true, positive: true, names: ['q'] },
        { key: 'pwf', label: 'pwf', kind: 'pressure', cat: 'pressure', required: true, positive: true, names: ['pwf'] }] };
      r = C.table('q (m3/d),pwf (MPa)\n' + (100 * BBL) + ',' + (1800 * PSI_KPA / 1000) + '\nq,pwf\n', oil);
      assert.ok(!r.ok && /Row 3: Rate q "q" is not a number/.test(r.errors.join('|')), 'text in a number column: ' + r.errors.join('|'));
      r = C.table('q (m3/d),pwf (MPa)\n' + (100 * BBL) + ',' + (1800 * PSI_KPA / 1000) + '\n4.2 ,1500\n', Object.assign({}, oil, { columns: oil.columns.map((c) => Object.assign({}, c)) }));
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.rel(r.rows[0].q, 100, 1e-9, 'm3/d → BPD');
      assert.rel(r.rows[0].pwf, 1800, 1e-9, 'MPa → psia');
      assert.rel(r.rows[1].q, 4.2 / BBL, 1e-9, 'second row');
    },
  },
  {
    name: 'header detection, positional columns and validation messages',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_csv, S = gasSpec(app.win);
      // no header: leading type column, then q, pwf, pws
      let r = C.table('stab,2624.6,1700\ntrans,4154.7,1500,1800\n', S);
      assert.ok(r.ok && !r.header, JSON.stringify(r.errors));
      assert.strictEqual(r.rows[0].kind, 'stab'); assert.strictEqual(r.rows[1].kind, 'trans');
      assert.strictEqual(r.rows[1].pws, 1800); assert.ok(isNaN(r.rows[0].pws), 'blank optional cell stays blank');
      // no header, no type column
      r = C.table('2624.6,1700\n', S);
      assert.ok(r.ok && r.rows[0].q === 2624.6 && r.rows[0].pwf === 1700 && r.rows[0].kind === null, JSON.stringify(r));
      // columns in any order + an unknown column
      r = C.table('pwf,comment,q\n1700,first,2624.6\n', S);
      assert.ok(r.ok && r.rows[0].q === 2624.6 && r.rows[0].pwf === 1700);
      assert.ok(r.warnings.some((x) => /"comment" was not recognised/.test(x)));
      const errs = (t) => { const x = C.table(t, S); assert.ok(!x.ok, 'should fail: ' + t); return x.errors.join(' | '); };
      assert.ok(/Missing column: pwf/.test(errs('q,pws\n1,2\n')));
      assert.ok(/Row 2: Rate q must be greater than zero/.test(errs('q,pwf\n-5,1700\n')));
      assert.ok(/Row 3: pwf is empty/.test(errs('q,pwf\n1,1700\n2,\n')));
      assert.ok(/Point type "flowing" is not one of stab \/ trans/.test(errs('type,q,pwf\nflowing,1,2\n')));
      assert.ok(/unit "furlongs" is not recognised/.test(errs('q (furlongs),pwf\n1,2\n')));
      assert.ok(/ambiguous/.test(errs('q (Mm3/d),pwf\n1,2\n')), 'Mm³/d refused as ambiguous');
      assert.ok(/Two columns map to pwf/.test(errs('pwf,pwf,q\n1,2,3\n')));
      assert.ok(/Nothing to import/.test(errs('  \n\n')));
      assert.ok(/No data rows/.test(errs('q,pwf\n')));
      r = C.table('q,pwf\n' + Array.from({ length: 8 }, (_, i) => (i + 1) + ',100').join('\n'), S);
      assert.ok(r.ok && r.rows.length === 6 && r.warnings.some((x) => /only the first 6/.test(x)), 'truncated to the table size');
    },
  },
  {
    name: 'Gas Deliverability: pasted CSV (MMSCFD, psig) fills the test points, clears the rest, recalculates and autosaves',
    wp: WP,
    run(app, assert) {
      openPage(app, 'gasdeliv', 'gd_root');
      assert.ok(app.el('gd_csv_host').querySelector('.rp-skip'), 'panel is excluded from reports');
      app.input('gd_q4', '999'); app.input('gd_pwf4', '999');          // stale row that must be cleared
      const csv = 'Point type,q (MMSCFD),pwf [psig]\n' +
        'Stabilised,2.6246,' + (1700 - ATM) + '\nstab,4.1547,' + (1500 - ATM) + '\nstab,5.4251,' + (1300 - ATM) + '\n';
      const msg = paste(app, 'gd_csv_host', csv);
      assert.ok(/Imported 3 test points; rows 4–6 cleared/.test(msg), msg);
      assert.ok(/gauge pressures converted/.test(msg), 'gauge warning shown');
      assert.rel(canon(app, 'gd_q1'), 2624.6, 1e-9); assert.rel(canon(app, 'gd_pwf1'), 1700, 1e-9);
      assert.rel(canon(app, 'gd_q3'), 5425.1, 1e-9); assert.rel(canon(app, 'gd_pwf3'), 1300, 1e-9);
      assert.strictEqual(app.el('gd_q4').value, '', 'row 4 cleared');
      assert.strictEqual(app.el('gd_k1').value, 'stab');
      const s = app.win.WTS_state.gasdeliv;
      assert.ok(s.ok, 'recalculated');
      assert.rel(s.n, 0.8700, 1e-3, 'G1 exponent n');
      assert.rel(s.aofCn, 9033.5, 1e-3, 'G1 AOF');
      const rec = JSON.parse(app.storage.getItem('wts_page_gasdeliv') || 'null');
      assert.ok(rec && rec.f && Number(rec.f.gd_q2) === 4154.7, 'autosaved: ' + JSON.stringify(rec && rec.f));
      // a bad paste leaves the table untouched
      const bad = paste(app, 'gd_csv_host', 'q,pwf\nabc,1700\n');
      assert.ok(/Not imported/.test(bad) && /Row 2: Rate q "abc" is not a number/.test(bad), bad);
      assert.rel(canon(app, 'gd_q1'), 2624.6, 1e-9, 'unchanged after a failed import');
      // the report / snapshot never includes the paste panel
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      assert.ok(JSON.stringify(model).indexOf('Paste / import CSV') === -1, 'panel not in the report model');
    },
  },
  {
    name: 'Gas Deliverability in metric: values without units are read in kPa and m³/d (the units on screen)',
    wp: WP,
    run(app, assert) {
      const U = app.win.WTS_units;
      openPage(app, 'gasdeliv', 'gd_root');
      U.setSystem('metric');
      try {
        // WTS_units gasRateSmall: 1 MSCFD = 28.3168 m³/d; pressure: 1 psi = 6.89476 kPa
        const m3 = (q) => (q * 28.3168).toFixed(3), kp = (p) => (p * 6.89476).toFixed(3);
        const msg = paste(app, 'gd_csv_host', [[2624.6, 1700], [4154.7, 1500], [5425.1, 1300]].map((r) => 'stab,' + m3(r[0]) + ',' + kp(r[1])).join('\n'));
        assert.ok(/Imported 3/.test(msg), msg);
        assert.rel(canon(app, 'gd_q1'), 2624.6, 1e-5, 'q1 canonical');
        assert.rel(canon(app, 'gd_pwf2'), 1500, 1e-5, 'pwf2 canonical');
        assert.rel(app.win.WTS_state.gasdeliv.n, 0.8700, 1e-3, 'same fit as imperial');
      } finally { U.setSystem('imperial'); }
    },
  },
  {
    name: 'Oil Well IPR: CSV with m³/d and bar imports into the 4-point table and recalculates',
    wp: WP,
    run(app, assert) {
      openPage(app, 'oilipr', 'oi_root');
      const msg = paste(app, 'oi_csv_host', 'pwf (bar),q (m3/d)\n' + (1800 * PSI_KPA / 100) + ',' + (100 * BBL) + '\n' + (1400 * PSI_KPA / 100) + ',' + (160 * BBL) + '\n');
      assert.ok(/Imported 2 test points; rows 3–4 cleared/.test(msg), msg);
      assert.rel(canon(app, 'oi_q1'), 100, 1e-9); assert.rel(canon(app, 'oi_pwf1'), 1800, 1e-9);
      assert.rel(canon(app, 'oi_q2'), 160, 1e-9); assert.rel(canon(app, 'oi_pwf2'), 1400, 1e-9);
      assert.strictEqual(app.el('oi_q3').value, '');
      assert.ok(app.win.WTS_state.oilipr && app.win.WTS_state.oilipr.ok, 'recalculated');
      const ex = app.el('oi_csv_host').querySelector('[data-csv="example"]');
      app.click(ex);
      assert.ok(/q \(BPD\),pwf \(psia\)/.test(app.el('oi_csv_host').querySelector('[data-csv="text"]').value), 'example inserted');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
    },
  },
];
