// v3.1 GUI-sweep findings in the calculators area — regression tests.
//
//   flare      a negative / zero / blank input crashed the canvas drawing ("createRadialGradient …
//              non-finite") — invalid inputs now stop the drawing with a message
//   gaevents   reference row "click_outbound" rendered a real <a href="http(s)://..."> link
//   templates  Quick Report template picker: selecting a template / ticking the default box now
//              says what happened (ticking "All captured pages" off changed nothing, silently)
//   metric     Flare, Cement & Fluids, H2S, Proving, Separator QC, Well Kill, Flowline, Pipe Sizing
//              sand rate and scavenger consumption show the SI value first in Metric mode
//   hydrate    segment cards' 2-column input grid no longer forces ~430 px per card (overflowed
//              #pgBody at 1440 px); the summary table scrolls inside its card
'use strict';

function go(app, route, metric) {
  if (metric) app.win.WTS_units.setSystem('metric');
  app.hook.nav(route);
  app.flush(200);
}
function setv(app, id, v) {
  const el = app.el(id);
  if (!el) throw new Error('missing input #' + id);
  if (el.tagName === 'SELECT') app.select(el, String(v)); else app.input(el, String(v));
}
function text(app, id) { const el = app.el(id); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
function rowText(app, root, label) {
  const row = app.findAll(root + ' .rrow').find((r) => { const l = r.querySelector('.rl'); return l && l.textContent.indexOf(label) !== -1; });
  if (!row) throw new Error('row "' + label + '" not found in ' + root + ': ' + text(app, 'pgBody').slice(0, 300));
  return row.querySelector('.rv').textContent.replace(/\s+/g, ' ').trim();
}
function labelOf(app, id) { const el = app.el(id); const f = el && el.closest('.fg-item'); const l = f && f.querySelector('label'); return l ? l.textContent.replace(/\s+/g, ' ').trim() : ''; }
function noErrors(assert, app) { assert.deepStrictEqual(app.consoleErrors().map(String), [], 'no console errors'); }

module.exports = [
  {
    name: 'v3.1 flare: negative, zero and blank inputs never throw from the drawing; a message replaces the flame',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'flare');
      for (const [id, v] of [['fl_flow', '-1'], ['fl_flow', '0'], ['fl_flow', ''], ['fl_D', '-0.5'], ['fl_nhv', '-100']]) {
        setv(app, 'fl_flow', 10); setv(app, 'fl_D', 0.5); setv(app, 'fl_nhv', 1000);
        setv(app, id, v);
        app.click(app.findAll('#pgBody button').find((b) => /calcFlare\(/.test(b.getAttribute('onclick') || '')));
        app.flush(100);
        // switch through every view (each one redraws from the inputs)
        ['fl_t2', 'fl_hp', 'fl_he', 'fl_ns', 'fl_np', 'fl_t1'].forEach((t) => { if (app.el(t)) { app.click(t); app.flush(30); } });
        app.resize(900, 700); app.flush(50);
        assert(app.findAll('#fl_res .val-error').length > 0, id + '=' + JSON.stringify(v) + ': validation message shown');
        const said = app.canvasTexts('fl_canvas').join(' | ');
        assert.includes(said, 'Cannot draw the flare', id + '=' + v + ' canvas message');
        noErrors(assert, app);
      }
      // valid again → results come back
      setv(app, 'fl_flow', 10); setv(app, 'fl_D', 0.5); setv(app, 'fl_nhv', 1000);
      app.click(app.findAll('#pgBody button').find((b) => /calcFlare\(/.test(b.getAttribute('onclick') || '')));
      app.flush(100);
      assert.includes(text(app, 'fl_res'), 'API 521 Radiation Analysis Results');
      noErrors(assert, app);
    },
  },
  {
    name: 'v3.1 gaevents: the click_outbound row has no literal "http(s)://..." link',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'gaevents');
      const bad = app.findAll('#pgBody a').filter((a) => /http\(s\)/.test(a.getAttribute('href') || ''));
      assert.strictEqual(bad.length, 0, 'no link to the literal text http(s)://...');
      assert.includes(text(app, 'pgBody'), 'Click on any external link (an http:// or https:// address)');
    },
  },
  {
    name: 'v3.1 report templates: picking a template and the default checkbox give visible feedback',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'home');
      app.win.WTS_reportTemplates.openPicker(); app.flush(20);
      const msg = () => text(app, 'wts_rt_box').match(/(Selected|Quick Report|“All)[^]*?(default\.|template\.|box\.|”\.)/);
      const box = () => app.el('wts_rt_box');
      const radios = () => app.findAll('#wts_rt_box input[name="wts_rt_pick"]');
      const chk = () => app.find('#wts_rt_box input[data-rt="default"]');
      // "All captured pages" is the default: un-ticking explains it stays the fallback
      assert.strictEqual(radios()[0].value, 'all');
      app.click(radios()[0]); app.flush(10);              // already selected: no change event, still confirmed
      assert.includes(text(app, 'wts_rt_box'), 'is selected and is the Quick Report default.');
      app.click(chk()); app.flush(10);
      assert.includes(text(app, 'wts_rt_box'), 'is the fallback Quick Report template');
      assert.strictEqual(chk().checked, true, 'still the default');
      // choose another template → message says Generate uses it
      const other = radios()[1];
      app.check(other, true); app.flush(10);
      assert.includes(text(app, 'wts_rt_box'), 'Selected “');
      assert.includes(text(app, 'wts_rt_box'), 'tick the box below');
      // tick → it becomes the Quick Report default, and says so
      app.click(chk()); app.flush(10);
      assert.includes(text(app, 'wts_rt_box'), 'Quick Report now uses “');
      const st = JSON.parse(app.storage.getItem(app.win.WTS_reportTemplates.KEY));
      assert.strictEqual(st.defaultId, other.value);
      // un-tick → back to All captured pages
      app.click(chk()); app.flush(10);
      assert.includes(text(app, 'wts_rt_box'), 'Quick Report is back to “');
      assert.strictEqual(JSON.parse(app.storage.getItem(app.win.WTS_reportTemplates.KEY)).defaultId, 'all');
      assert(box() && msg() !== undefined);
      noErrors(assert, app);
    },
  },
  {
    name: 'v3.1 metric: Flare, Pipe Sizing sand rate, H2S and scavenger show SI first',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'flare', true);
      app.click(app.findAll('#pgBody button').find((b) => /calcFlare\(/.test(b.getAttribute('onclick') || '')));
      app.flush(100);
      const flRows = app.findAll('#fl_res .rrow .rl').map((l) => l.textContent.trim());
      assert.strictEqual(flRows[0], 'Heat Release (MW)', 'MW first: ' + flRows.slice(0, 5).join(' | '));
      assert(flRows.indexOf('Flame Length (m)') < flRows.indexOf('Flame Length (ft)'), 'm before ft');
      assert(flRows.indexOf('Heat Release (GJ/h)') > 0);
      // Pipe Sizing sand rate: tagged; 2 lb/MMscf shows as 2 × 16.0185 = 32.04 kg/10⁶ Sm³
      go(app, 'pipesz', true);
      assert.includes(labelOf(app, 'ev_sand'), '(kg/10⁶ Sm³)');
      app.win.WTS_units.runCanonical(() => { app.el('ev_sand').value = '2'; });
      app.click(app.findAll('#pgBody button').find((b) => /calcPipeErosion\(/.test(b.getAttribute('onclick') || '')));
      app.flush(50);
      const sand = rowText(app, '#ev_res', 'Sand erosion screen');
      assert.match(sand, /^[\d.,]+ mm\/y \(/, 'mm/y first: ' + sand);
      assert.match(sand, / 32(\.0\d?)? kg\/10⁶ Sm³/);
      // H2S: metres and kg first; scavenger consumption tagged L/kg (1.5 gal/lb = 12.52 L/kg)
      go(app, 'h2sroe', true);
      assert.match(rowText(app, '#hs_roe_res', '100 ppm radius of exposure'), /^[\d.,]+ m \([\d.,]+ ft\)$/);
      assert.match(rowText(app, '#hs_roe_res', 'H2S release'), /^[\d.,]+ kg\/d \(/);
      assert.match(rowText(app, '#hs_so2_res', 'SO2'), /^[\d.,]+ kg\/hr \(/);
      assert.match(rowText(app, '#hs_scv_res', 'Product'), /^[\d.,]+ L\/d \(/);
      assert.includes(labelOf(app, 'hs_ratio'), '(L/kg)');
      assert.near(parseFloat(app.el('hs_ratio').value), 1.5 * 8.34540445, 0.01);
      // the computed product volume is unchanged by the unit system: 5 MMscfd, 50 → 4 ppm, 1.5 gal/lb
      const lbd = 5e6 * 46e-6 / 379.48 * 34.081, Ld = lbd * 1.5 * 3.785411784;
      assert.near(parseFloat(rowText(app, '#hs_scv_res', 'Product').replace(/,/g, '')), Ld, 0.05);
      noErrors(assert, app);
    },
  },
  {
    name: 'v3.1 metric: Cement & Fluids, Proving, Separator QC, Well Kill and Flowline show SI first',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'complfluids', true); app.win.calcComplFluids(); app.flush(20);
      assert.match(rowText(app, '#pgBody', 'Water requirement'), /^[\d.,]+ L\/sack \([\d.,]+ gal\/sack\)$/);
      assert.match(rowText(app, '#pgBody', 'Slurry yield'), /^[\d.,]+ L\/sack \(/);
      assert.match(rowText(app, '#pgBody', 'Blend density'), /^[\d.,]+ kg\/m³ · SG/);
      go(app, 'proving', true); app.win.calcProving(); app.flush(20);
      assert.includes(rowText(app, '#pgBody', 'Thermal expansion α60'), '/°C (');
      assert.includes(rowText(app, '#pgBody', 'Compressibility F at'), '/kPa (');
      assert(app.findAll('#pgBody .rrow .rl').some((l) => /GSVp \(prover at 15\.56 °C \(60 °F\), 0 kPa\(g\)\)/.test(l.textContent)), 'GSVp basis in SI');
      go(app, 'sepqc', true); app.win.calcSepQC(); app.flush(20);
      assert(app.findAll('#pgBody .rrow .rl').some((l) => l.textContent.indexOf('stock-tank m³ per separator m³') !== -1), 'shrinkage unit in m³');
      assert(text(app, 'pgBody').indexOf('STB per separator bbl') === -1);
      go(app, 'wellkill', true); app.win.calcWellKill(); app.flush(20);
      assert.match(rowText(app, '#wk_res', 'Kill weight'), /^[\d.,]+ kg\/m³ · SG/);
      const heads = app.findAll('#wk_res th').map((t) => t.textContent.trim());
      assert(heads.indexOf('Max kg/m³') !== -1 && heads.indexOf('Max kg/m³') < heads.indexOf('Max ppg'), 'brine table kg/m³ first');
      go(app, 'flowline', true); app.win.calcFlowline(); app.flush(20);
      assert.includes(rowText(app, '#pgBody', 'Oil FVF, Standing'), 'm³/Sm³ (rb/STB)');
      noErrors(assert, app);
      // imperial wording unchanged
      app.win.WTS_units.setSystem('imperial'); app.flush(50);
      go(app, 'wellkill'); app.win.calcWellKill(); app.flush(20);
      assert.match(rowText(app, '#wk_res', 'Kill weight'), /^[\d.,]+ ppg · SG/);
    },
  },
  {
    name: 'v3.1 hydrate: segment input grid can shrink (minmax(0,1fr)) and the summary table scrolls in its card',
    wp: 'V31S',
    run(app, assert) {
      go(app, 'hydrate');
      const fg = app.find('#pgBody .hy-seg-fg');
      assert(fg, 'segment grid tagged');
      assert.match(fg.getAttribute('style').replace(/\s+/g, ''), /repeat\(2,minmax\(0(px)?,1fr\)\)/);
      assert.includes(text(app, 'pgBody') + app.el('pgBody').innerHTML, '.hy-seg-fg .fg-item input{min-width:0');
      const tbl = app.find('#wts_hydrate_summary table');
      assert(tbl && /overflow-x:\s*auto/.test(tbl.parentElement.getAttribute('style') || ''), 'summary table in a scroller');
      noErrors(assert, app);
    },
  },
];
