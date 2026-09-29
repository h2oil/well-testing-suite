// Report table capture for the v1.7 plug-in calculators, now that the harness
// DOM models HTMLTableElement.rows / tBodies / tHead and HTMLTableRowElement.cells
// (prism-build/tests/_dom.js). Covers:
//   • the fake-DOM table API itself (row order, live-ish collections, textarea rows);
//   • host collectPageReport → _tableItem / _blankCtlRow: blank input-table rows
//     (no numeric entry, selects at their default option) are left out of the report;
//   • gasdeliv / oilipr input + result tables in the page report; flareghg / h2sroe
//     have no tables, so their reports must carry none;
//   • oilipr productivity index J in metric (m³/d/kPa, new `productivityIndex` units category).
'use strict';

const WP = 'RPT';

function open(app, key, rootId) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no ' + key + ' sidebar button (round 9 not built?)');
  app.click(b);
  if (!app.el(rootId)) throw new Error(key + ' page did not render');
}
const report = (app) => app.win.collectPageReport(app.el('pgBody'), { charts: false });
function tables(model) {
  const out = [];
  model.inputs.concat(model.results).forEach((s) => s.items.forEach((it) => { if (it.type === 'table') out.push(Object.assign({ section: s.title }, it)); }));
  return out;
}
const tableIn = (model, section) => tables(model).find((t) => t.section === section);
const cellTexts = (row) => row.map((c) => c.t);
// Values built in the app realm: compare by JSON (deepStrictEqual checks prototypes).
const same = (assert, a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

module.exports = [
  {
    name: 'RPT harness DOM: table.rows / tHead / tBodies / tFoot / tr.cells / rowIndex / cellIndex / option.defaultSelected',
    wp: WP,
    run(app, assert) {
      const d = app.win.document;
      const host = d.createElement('div');
      d.body.appendChild(host);
      host.innerHTML = '<table id="t"><tfoot><tr><td>f</td></tr></tfoot><thead><tr><th>h1</th><th>h2</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody><tbody><tr><td>c</td><th>d</th></tr></tbody></table>' +
        '<textarea id="ta" rows="4"></textarea><select id="s"><option>x</option><option selected>y</option></select>';
      const t = app.el('t');
      assert.deepStrictEqual(Array.from(t.rows).map((r) => r.textContent), ['h1h2', 'ab', 'cd', 'f'], 'thead, tbodies, then tfoot');
      assert.strictEqual(t.tHead.localName, 'thead');
      assert.strictEqual(t.tFoot.localName, 'tfoot');
      assert.strictEqual(t.tBodies.length, 2);
      assert.strictEqual(t.tHead.rows.length, 1);
      const r2 = t.rows[2];
      assert.deepStrictEqual(Array.from(r2.cells).map((c) => c.tagName), ['TD', 'TH'], 'td + th cells');
      assert.strictEqual(r2.rowIndex, 2);
      assert.strictEqual(r2.cells[1].cellIndex, 1);
      // live-ish: collections are recomputed on access
      const tr = d.createElement('tr'); tr.innerHTML = '<td>e</td>';
      t.tBodies[1].appendChild(tr);
      assert.strictEqual(t.rows.length, 5, 'new row seen');
      assert.strictEqual(t.rows[3], tr, 'body rows stay before the footer');
      assert.strictEqual(app.el('ta').rows, 4, 'textarea rows still reflects the attribute');
      assert.strictEqual(d.createElement('div').rows, '', 'non-table rows is the plain reflected attribute');
      const o = app.el('s').options;
      assert.ok(!o[0].defaultSelected && o[1].defaultSelected, 'defaultSelected follows the selected attribute');
      app.select('s', 'x');
      assert.ok(o[1].defaultSelected && !o[1].selected, 'defaultSelected is unaffected by a user pick');
    },
  },
  {
    name: 'RPT host report engine: blank input-table rows dropped; labelled, select-changed and checkbox rows kept',
    wp: WP,
    run(app, assert) {
      const body = app.el('pgBody');
      body.innerHTML = '<div class="card"><div class="card-title">Grid</div><table class="dtable"><thead><tr><th>#</th><th>Type</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td>1</td><td><select id="k1"><option value="a">A</option><option value="b">B</option></select></td><td><input type="number" id="v1" value="5"></td></tr>' +
        '<tr><td>2</td><td><select id="k2"><option value="a">A</option><option value="b" selected>B</option></select></td><td><input type="number" id="v2" value=""></td></tr>' +
        '<tr><td>3</td><td><select id="k3"><option value="a">A</option><option value="b">B</option></select></td><td><input type="number" id="v3" value=""></td></tr>' +
        '<tr><td>Oil</td><td><select id="k4"><option value="a">A</option></select></td><td><input type="number" id="v4" value=""></td></tr>' +
        '<tr><td>5</td><td><input type="checkbox" id="c5"></td><td><input type="number" id="v5" value=""></td></tr>' +
        '<tr><td>—</td><td><select id="k6"><option value="a">A</option></select></td><td><input type="text" id="v6" value=""></td></tr>' +
        '</tbody></table>' +
        '<table class="dtable"><tbody><tr><td>Select only</td><td><select id="so"><option>Z</option></select></td></tr></tbody></table></div>';
      let t = tables(report(app));
      assert.strictEqual(t.length, 2, 'two tables captured');
      same(assert, t[0].head, ['#', 'Type', 'Value']);
      same(assert, t[0].rows.map((r) => r[0].t), ['1', 'Oil', '5'], 'rows 2 (default select), 3, 6 blank → dropped; labelled row and checkbox row kept');
      same(assert, cellTexts(t[1].rows[0]), ['Select only', 'Z'], 'a select-only row is never treated as blank');
      // A select moved off its default counts as entered content; a filled value too.
      app.select('k3', 'b');
      app.input('v6', 'x');
      t = tables(report(app));
      same(assert, t[0].rows.map((r) => r[0].t), ['1', '3', 'Oil', '5', '—'], 'changed select / typed value keep the row');
    },
  },
  {
    name: 'RPT gasdeliv report: test-point table has only the filled rows (no blank "Transient" rows 4-6) + deliverability table',
    wp: WP,
    run(app, assert) {
      open(app, 'gasdeliv', 'gd_root');
      app.click('gd_go');
      let model = report(app);
      let tp = tableIn(model, 'Test Points');
      assert.ok(tp, 'test-point table captured: ' + tables(model).map((x) => x.section).join(' | '));
      assert.strictEqual(tp.kind, 'input');
      assert.ok(tp.head && tp.head[1] === 'Point type' && /Rate q/.test(tp.head[2]), 'head: ' + JSON.stringify(tp.head));
      same(assert, tp.rows.map((r) => r[0].t), ['1', '2', '3'], 'only the three filled rows');
      assert.ok(tp.rows.every((r) => r[1].t === 'Stabilised' || /stab/i.test(r[1].t)), 'point types: ' + tp.rows.map((r) => r[1].t).join(','));
      assert.ok(JSON.stringify(tp).indexOf('Transient') === -1, 'no blank transient rows in the report');
      const dt = tableIn(model, 'Deliverability Table');
      assert.ok(dt && dt.kind === 'result', 'deliverability table captured');
      assert.strictEqual(dt.rows.length, 11, '11 deliverability rows');
      assert.strictEqual(dt.rows[0][0].t, '1,952', 'first row pwf = p̄r');
      assert.strictEqual(dt.rows[10][1].t, '9,033.5', 'last row q = AOF');
      // Filling a fourth point (transient type left as is) brings that row in.
      app.input('gd_q4', '4000'); app.input('gd_pwf4', '1500');
      model = report(app);
      tp = tableIn(model, 'Test Points');
      same(assert, tp.rows.map((r) => r[0].t), ['1', '2', '3', '4'], 'row 4 now reported');
      assert.ok(/Transient/i.test(tp.rows[3][1].t), 'its type is shown');
      // The same model feeds the PDF
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('rp-tbl') !== -1 && /Transient/.test(pdf), 'PDF renders the report tables (incl. filled transient row 4)');
      assert.ok((pdf.match(/<tr>/g) || []).length >= 4 + 11, 'PDF carries test-point + deliverability rows');
    },
  },
  {
    name: 'RPT oilipr report: test-point table has the filled row only; IPR table captured; metric J in m³/d/kPa',
    wp: WP,
    run(app, assert) {
      open(app, 'oilipr', 'oi_root');
      app.click('oi_go');
      let model = report(app);
      const tp = tableIn(model, 'Test Points');
      assert.ok(tp && tp.kind === 'input', 'test-point table captured');
      same(assert, tp.rows.map((r) => cellTexts(r)), [['1', '100', '1800']], 'blank points 2-4 dropped');
      const it = tableIn(model, 'IPR Table');
      assert.ok(it && it.kind === 'result', 'IPR table captured');
      assert.strictEqual(it.rows.length, 11, '11 IPR rows');
      assert.ok(/pwf/.test(it.head[0]) && /q/.test(it.head[1]), 'IPR head: ' + JSON.stringify(it.head));
      // Straight-line PI: J = 1000 / (2400 − 1800) = 1.6667 BPD/psi
      app.select('oi_method', 'pi');
      app.input('oi_q1', '1000');
      assert.rel(app.win.WTS_state.oilipr.J, 1000 / 600, 1e-12, 'J stays field units in WTS_state');
      const jRow = () => app.findAll('#oi_res .rrow').map((r) => String(r.textContent)).find((s) => /Productivity index J/.test(s));
      assert.includes(jRow(), '1.6667 BPD/psi', 'imperial J unchanged');
      const U = app.win.WTS_units;
      U.setSystem('metric');
      try {
        app.win.calcOilIPR();
        const s = jRow();
        assert.ok(/m³\/d\/kPa/.test(s) && !/psi/.test(s), 'metric J label: ' + s);
        const v = parseFloat(s.replace(/^[^\d]*/, ''));
        assert.rel(v, (1000 / 600) * 0.158987 / 6.89476, 2e-4, 'metric J value');
        assert.rel(U.convertCategory(1, 'productivityIndex', 'imperial', 'metric'), 0.0230592, 1e-5, 'category factor');
        model = report(app);
        assert.includes(JSON.stringify(model), 'm³/d/kPa', 'metric J in the report');
      } finally { U.setSystem('imperial'); }
      app.win.calcOilIPR();
      assert.includes(jRow(), '1.6667 BPD/psi', 'back to imperial');
    },
  },
  {
    name: 'RPT flareghg + h2sroe reports: no tables on these pages, inputs and results still captured',
    wp: WP,
    run(app, assert) {
      open(app, 'flareghg', 'fe_root');
      app.win.calcFlareGHG();
      let model = report(app);
      assert.strictEqual(tables(model).length, 0, 'flareghg: no table items');
      assert.ok(model.inputs.length > 0 && model.results.length > 0, 'flareghg: inputs + results');
      assert.ok(!/NaN|Infinity/.test(JSON.stringify(model)), 'flareghg: no NaN');
      open(app, 'h2sroe', 'hs_root');
      app.click('hs_calc');
      model = report(app);
      assert.strictEqual(tables(model).length, 0, 'h2sroe: no table items');
      assert.ok(model.inputs.length > 0 && model.results.length > 0, 'h2sroe: inputs + results');
      assert.ok(!/NaN|Infinity/.test(JSON.stringify(model)), 'h2sroe: no NaN');
    },
  },
];
