// Chemical Injection — ⓘ background pop-ups (prism-build/49-calc-cheminj-info.js, WTS_cheminjInfo) on the
// page of prism-build/49-calc-cheminj.js (route `cheminj`):
//   every ⓘ button and every "Background and standards" chip opens a modal dialog (role="dialog",
//   aria-modal, labelled title, sections, a references list and the planning disclaimer); focus moves
//   in and returns to the button; Esc, ×, Close and a backdrop click close it, a click inside does not,
//   Tab stays inside; opening never recalculates and starts no timer; per-line buttons follow the line's
//   chemical family, point and pump; dose numbers and design-basis values match WTS_chemlib in imperial
//   and Metric (basis twins, converted temperatures and pressures, no imperial unit left); the pop-up is
//   not in the report model, the Quick Report snapshot or the autosave record; navigation removes it;
//   the page still works without the module; no company or brand name (hashed deny-list, so this file
//   names none), no web address and no forbidden word anywhere in the pop-ups or the module source.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WP = 'CHEM';
const BAD = /NaN|undefined|Infinity|\bnull\b|\[object Object\]/;
const TOKEN = /\{\w+\}/;
const IMP = /(^|[\s(/[·,])(psi[ag]?|°F|ft|bbl\/d|bbl|BPD|lbm?|gal|gpm|MMSCF\/d|MMscf|scf|US pt)(?=$|[\s)/\]·,.:;])/;
const DISC = 'Planning guidance only — follow the product data sheet and site procedures.';
const MODULE = path.join(__dirname, '..', '49-calc-cheminj-info.js');
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();

function open(app) { app.hook.nav('cheminj'); app.flush(20); return app.el('cj_root'); }
const I = (app) => app.win.WTS_cheminjInfo;
const LIB = (app) => app.win.WTS_chemlib;
const calcs = (app) => app.win.WTS_cheminj.pageCalcs();
const dlg = (app) => app.find('#cj_root .cj-dlg');
const overlays = (app) => app.findAll('.cj-dlg-ov');
const btn = (app, key, n) => app.findAll('#cj_root [data-cj-info="' + key + '"]').find((b) => (n ? b.getAttribute('data-n') === String(n) : !b.getAttribute('data-n')));
const shown = (el) => { for (let e = el; e; e = e.parentElement) if (e.style && e.style.display === 'none') return false; return true; };

// Opens through a real click on a focused button; returns the dialog after the structural checks.
function clickOpen(app, assert, b, where) {
  b.focus();
  app.click(b);
  return checkDialog(app, assert, where);
}
function checkDialog(app, assert, where) {
  const d = dlg(app);
  assert.ok(d, where + ': dialog open');
  assert.strictEqual(overlays(app).length, 1, where + ': one overlay');
  assert.strictEqual(d.getAttribute('role'), 'dialog', where + ': role');
  assert.strictEqual(d.getAttribute('aria-modal'), 'true', where + ': aria-modal');
  assert.strictEqual(d.getAttribute('aria-labelledby'), 'cj_info_title', where + ': labelled');
  const t = app.el('cj_info_title');
  assert.ok(t && d.contains(t) && txt(t).length > 3, where + ': title');
  assert.ok(d.contains(app.document.activeElement), where + ': focus moved into the dialog');
  const secs = Array.from(d.querySelectorAll('h4[data-sec]')).filter((h) => h.getAttribute('data-sec') !== 'refs');
  assert.ok(secs.length >= 3, where + ': content sections (' + secs.length + ')');
  secs.forEach((h) => assert.ok(txt(h).length > 3 && secText(h).length > 20, where + ': section "' + txt(h) + '" has content'));
  const refs = d.querySelectorAll('.cj-dlg-refs li');
  assert.ok(refs.length >= 2, where + ': references list (' + refs.length + ')');
  assert.strictEqual(txt(d.querySelector('[data-sec="refs"]')), 'Standards and references', where + ': references heading');
  assert.strictEqual(txt(d.querySelector('.cj-dlg-disc')), DISC, where + ': disclaimer');
  const all = txt(d);
  assert.ok(!BAD.test(all), where + ': no NaN / undefined / null: ' + (all.match(BAD) || [''])[0]);
  assert.ok(!TOKEN.test(all), where + ': no unfilled {token}');
  const ov = d.closest('.cj-dlg-ov');
  assert.ok(ov && ov.classList.contains('rp-skip') && ov.hasAttribute('data-rp-nosnap'), where + ': rp-skip, no snapshot');
  assert.strictEqual(d.querySelectorAll('input, select, textarea').length, 0, where + ': no form control in the pop-up');
  return d;
}
// text of a section: everything after its heading up to the next heading
function secText(h) {
  let s = '';
  for (let e = h.nextElementSibling; e && !e.matches('h4'); e = e.nextElementSibling) s += ' ' + txt(e);
  return s.trim();
}
function esc(app) { app.key(app.document.activeElement, 'Escape'); }

const nums = (s) => (String(s).match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')));
const hasNum = (list, v) => list.some((x) => Math.abs(x - v) <= Math.max(0.0051, Math.abs(v) * 0.006));
const TWIN = ['pt_mmscf', 'gal_mmscf', 'gal_lb_h2s'];
// The library values a chemical's dose line must show (Metric: the basis twin, as the page preset uses).
function expected(L, c, metric) {
  if (c.kind === 'custom') return null;
  if (c.kind === 'thi') return { vals: [c.leanDef, c.leanMin, c.leanMax, c.thi.warnPct, c.thi.maxPct], unit: 'wt %' };
  const b = L.bases[c.basis];
  let f = 1, unit = b.unit;
  if (metric && b.twin && TWIN.indexOf(c.basis) !== -1) { f = b.factor; unit = L.bases[b.twin].unit; }
  return { vals: [c.dose, c.doseMin, c.doseMax].filter((v) => typeof v === 'number' && isFinite(v)).map((v) => v * f), unit };
}

// Hashed deny-list: truncated SHA-256 of normalised company, brand and publisher names (operators, service
// companies, chemical suppliers, pump / valve / instrument makers, software vendors). Hashes only, so this
// file never names a company (CLAUDE.md rule); any 1-3 word run of the scanned text that hashes into the
// set fails the test.
const DENY = new Set([
  '020d5bb790f5', '0298881223eb', '03116afc9edd', '05f84363a37b', '061ac1ab2816', '067d5e72ef51', '0a54971ee140',
  '0d50cf7a3220', '0df2b318462f', '125292bb6e14', '133a33fb5f2d', '138659419e11', '154c573ada9c', '1938a97b778e',
  '19791e4d7f13', '1ae2af0e4048', '1b0a60bdac70', '1b631144072d', '1b8767864eef', '1bfbf70d9296', '1cc93205b3b3',
  '1dad425c2678', '1dbedde0278a', '2034c1fd4382', '21a69b76ce6f', '21cba5305aa6', '24423607a13f', '25c5349d8619',
  '26bd96edfd9b', '27653e0c8f8f', '2ae3ba4eabdb', '2bdc61378146', '2e242ae7e7e1', '2ffef0394e8b', '30e363d3e8c5',
  '35f33346c41b', '3811e2e30d0d', '3832e177c194', '391872a1aac1', '3bb0be850a8c', '3c5221d8e741', '3c62c412ceb9',
  '3ca42d3a2563', '3e13e313a653', '3e9baf33b150', '3f008e0c9c3b', '3f183cdf3afb', '3f406da0b573', '3f543985e45d',
  '40c3a063f892', '4280f5ba83a1', '44497a0b3b7a', '44905d0f8669', '45a3af60d887', '46964655266c', '47091fc56f14',
  '471abbde0c5a', '48223e141af2', '482ddd5b3264', '483c8296305e', '48ca0aa1d2c2', '48e79b5399a1', '4a1b4929c611',
  '4a66a01eb516', '4b6fe38b391a', '4c77cac1139b', '4dfc94c3f749', '4e1419e62812', '4e5a53caff6c', '4fcce13290f6',
  '51885b145ced', '51ddf20c7bc6', '522bed94d793', '52f24a040616', '54fd3a2b66f0', '590c8208b6ef', '59c1de0763e8',
  '5b08c98718aa', '5bbb5b3d7fe0', '5be823548fb9', '5cede4ff37f7', '5d9d7163ef56', '60654a98c9d1', '61771099d6ed',
  '621391a126b6', '642bfd277e31', '64d40d00b622', '685aa21ba45e', '6919ef3b7ee7', '6a780680a34f', '6b075863de5a',
  '6d3d4dabaf8e', '7093309908a1', '715edf8ba872', '73320060a1c2', '77a5b469f790', '7a5ce815c507', '7b4cc726629c',
  '7d91a9024241', '7dd764323321', '7e3f1d52a162', '7e4029e6a98f', '7f6a208e41cd', '7f6b5820d676', '7f79d706b2b1',
  '8071dae37428', '80a0c167b1d0', '818577a80939', '81f472906244', '827b29f208a2', '83e2787f32d5', '8569380a4779',
  '85bd4c2d7ca1', '85e3a0c32a11', '868645a03af5', '86c901d270ed', '88a3f056ee3e', '88b4fa60f2f8', '89abffe26963',
  '8b05b4f98ddb', '8b3c1e5aee7b', '8e60faf25c56', '8e8f4e1c085c', '8f32e4a36a84', '9117b910559f', '9168756f1802',
  '91c379360198', '91db3a7dd8bd', '932eca8e3630', '9410bca8a23e', '955d5077f546', '961719ac9655', '97a6eb426111',
  '9860a61b898f', '9aea7b46fead', '9c5e2e0fbe95', '9ed6cd4da781', 'a0548562cf88', 'a179bc6af8e8', 'a23eaf5ff1d9',
  'a40a9025d330', 'a51c0bdb8935', 'aaadc31b1826', 'ac95a9427ed2', 'ad8f0cb3250f', 'ae5403d9f8d0', 'af29329bacb3',
  'af752d3b7e44', 'afecfa86e944', 'b043864b7ffb', 'b0c550001669', 'b153c91731d6', 'b1ef84bd787a', 'b55ac8822fb0',
  'b83578fa30b0', 'ba5bf3e78a44', 'be0a8a59a2a5', 'c023b7b07742', 'c14457402fce', 'c1f35ffd9e52', 'c21d8fdf3777',
  'c3f197924099', 'c4a3ec689da9', 'c4c84694310b', 'c6147f09659b', 'c9023b3e34dd', 'c9bec2ebf649', 'ca83b625c270',
  'cda14bc4fd75', 'ceafe2c817f3', 'd04fbc47460e', 'd54b2245a215', 'd7922c08b6d5', 'd8513b6cdf54', 'd8db87992980',
  'da5cc2f6b8eb', 'db4615b8c9a9', 'decc3d03744a', 'e06ce2f797a4', 'e1a9b4df69d9', 'e22182057439', 'e224e66fb84c',
  'e25b892ee924', 'e30e4ee487f1', 'e4657854227c', 'e5c416b13065', 'e8966d4dfa2a', 'e922ba855f02', 'ea2f7617bd81',
  'eb1111e4edf0', 'ec960cf3ae00', 'f07104d71508', 'f0b6ded8156b', 'f511a617e2a8', 'f694df1d1326', 'fb73478a8028',
  'fbe6777084b7', 'fc220981a751', 'ff6b1c44fb94', 'ffe375356c1e'
]);
function denyHits(text) {
  const t = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean), hits = [];
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n).join(' ');
      if (DENY.has(crypto.createHash('sha256').update(g).digest('hex').slice(0, 12))) hits.push(g);
    }
  }
  return hits;
}
// Every pop-up the page can show, as text (content() for each topic, family, point and pump).
function allContentText(app) {
  const info = I(app), L = LIB(app), out = [];
  const add = (c) => { out.push(c.title, c.lead.replace(/<[^>]+>/g, ' '), c.refs.join(' '), c.disclaimer); c.sections.forEach((s) => out.push(s.h, s.html.replace(/<[^>]+>/g, ' '))); };
  info.keys().forEach((k) => add(info.content(k)));
  L.chemicals.forEach((c) => add(info.content('chem', { chem: c.key })));
  L.points.forEach((p) => add(info.content('points', { point: p.key, chem: 'meoh' })));
  L.pumps.forEach((p) => add(info.content('pumps', { pump: p.key })));
  return out.join('\n').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

module.exports = [
  {
    name: 'CHEM info: every ⓘ button and topic chip opens a labelled modal (title, sections, references, disclaimer); focus moves in and returns on Esc; Esc stays in the dialog; no recalculation, no NaN',
    wp: WP,
    run(app, assert) {
      open(app);
      app.select('cj_nlines', '6');
      const info = I(app);
      assert.ok(info && typeof info.open === 'function', 'WTS_cheminjInfo loaded');
      assert.ok(!(app.win.WTS_calcRegistry && app.win.WTS_calcRegistry['cheminj-info']), 'helper module, no registry page');
      // the topic row: the nine topics in order, rp-skip
      const row = app.find('#cj_card_lines .cj-info-row');
      assert.ok(row && row.classList.contains('rp-skip') && row.hasAttribute('data-rp-nosnap'), 'topic row, rp-skip');
      const chips = Array.from(row.querySelectorAll('button[data-cj-info]'));
      assert.deepStrictEqual(chips.map((b) => b.getAttribute('data-cj-info')), ['hydrate', 'ldhi', 'h2s', 'corrosion', 'scale', 'process', 'flow', 'points', 'pumps']);
      assert.deepStrictEqual(chips.map(txt), ['Hydrate inhibition', 'Low-dose hydrate inhibitors', 'H2S scavenging', 'Corrosion inhibition', 'Scale inhibition', 'Foam and emulsion', 'Wax and asphaltene', 'Injection points', 'Pumps and calibration']);
      // every button: no id, type button, has a name, says it opens a dialog, kept out of reports
      const all = app.findAll('#cj_root [data-cj-info]');
      assert.strictEqual(all.length, 31, '9 chips + H2S, choke cooling, hazardous area, calibration + 3 per line × 6');
      all.forEach((b) => {
        assert.ok(!b.hasAttribute('id'), 'no id (autosave never stores it)');
        assert.strictEqual(b.getAttribute('type'), 'button');
        assert.strictEqual(b.getAttribute('aria-haspopup'), 'dialog');
        assert.ok(b.closest('.rp-skip') && b.closest('[data-rp-nosnap]'), 'rp-skip + data-rp-nosnap');
        assert.ok((b.getAttribute('aria-label') || txt(b)).length > 5, 'accessible name');
        assert.ok(!b.closest('label'), 'never inside a <label>');
      });
      // the label text of the controls with a button is unchanged (reports, validation messages)
      assert.strictEqual(txt(app.el('cj_pt_1').closest('.fg-item').querySelector('label')), 'Injection point');
      assert.strictEqual(txt(app.el('cj_chem_1').closest('.fg-item').querySelector('label')), 'Chemical (grouped by purpose)');
      assert.strictEqual(txt(app.el('cj_h2s').closest('.fg-item').querySelector('label')), 'H2S in gas (ppm mol)');
      assert.strictEqual(txt(app.find('#cj_card_cal .card-title')), 'Field calibration check');
      const n0 = calcs(app);
      let docEsc = 0;
      const onDoc = (e) => { if (e.key === 'Escape') docEsc++; };
      app.document.addEventListener('keydown', onDoc);
      all.forEach((b) => {
        const where = b.getAttribute('data-cj-info') + (b.getAttribute('data-n') ? ':' + b.getAttribute('data-n') : '');
        assert.ok(shown(b), where + ' visible');
        clickOpen(app, assert, b, where);
        esc(app);
        assert.strictEqual(overlays(app).length, 0, where + ': Esc closes');
        assert.strictEqual(app.document.activeElement, b, where + ': focus back on the button');
      });
      app.document.removeEventListener('keydown', onDoc);
      assert.strictEqual(docEsc, 0, 'Esc is handled by the dialog and does not reach other key handlers');
      assert.strictEqual(calcs(app), n0, 'opening and closing pop-ups never recalculates');
      assert.ok(!BAD.test(txt(app.el('pgBody'))), 'no NaN on the page');
    },
  },
  {
    name: 'CHEM info: ×, Close and a backdrop click close and return focus; a click inside stays open; Tab and Shift+Tab stay inside; a new pop-up replaces the old one; navigation removes it; no timers',
    wp: WP,
    run(app, assert) {
      const root = open(app);
      const info = I(app), b = btn(app, 'h2s');
      clickOpen(app, assert, b, 'h2s');
      app.click(app.find('.cj-dlg-x'));
      assert.strictEqual(overlays(app).length, 0, '× closes');
      assert.strictEqual(app.document.activeElement, b);
      clickOpen(app, assert, b, 'h2s');
      app.click(app.find('.cj-dlg-ft [data-cj-close]'));
      assert.strictEqual(overlays(app).length, 0, 'Close closes');
      assert.strictEqual(app.document.activeElement, b);
      clickOpen(app, assert, b, 'h2s');
      app.click(app.find('.cj-dlg-bd p'));
      app.click(app.find('.cj-dlg-hd h3'));
      assert.strictEqual(overlays(app).length, 1, 'a click inside the dialog keeps it open');
      app.click(app.find('.cj-dlg-ov'));
      assert.strictEqual(overlays(app).length, 0, 'backdrop click closes');
      assert.strictEqual(app.document.activeElement, b);
      // focus trap
      const d = clickOpen(app, assert, btn(app, 'pumps', 1), 'pumps:1');
      const f = Array.from(d.querySelectorAll('button, [tabindex]')).filter((e) => e.getAttribute('tabindex') !== '-1');
      assert.strictEqual(f.length, 3, '×, scrollable body and Close');
      assert.ok(f[0].classList.contains('cj-dlg-x') && f[1].classList.contains('cj-dlg-bd'), 'order');
      assert.strictEqual(app.document.activeElement, f[1], 'focus starts on the scrollable body (top of the text)');
      f[2].focus();
      app.key(f[2], 'Tab');
      assert.strictEqual(app.document.activeElement, f[0], 'Tab from the last control wraps to the first');
      const KE = app.win.KeyboardEvent;
      f[0].dispatchEvent(new KE('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      assert.strictEqual(app.document.activeElement, f[2], 'Shift+Tab from the first wraps to the last');
      // a second pop-up replaces the first
      info.open('scale', {}, null, root);
      assert.strictEqual(overlays(app).length, 1);
      assert.strictEqual(txt(app.el('cj_info_title')), 'Scale inhibition');
      assert.strictEqual(info.close(), true);
      assert.strictEqual(info.close(), false, 'nothing left to close');
      // navigation removes it with the page
      clickOpen(app, assert, btn(app, 'hydrate'), 'hydrate');
      app.hook.nav('hydrate'); app.flush(20);
      assert.strictEqual(overlays(app).length, 0, 'gone after navigation');
      assert.strictEqual(info.isOpen(), false);
      // the module starts no timer
      open(app);
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'idle');
      info.open('h2s', {}, null, app.el('cj_root'));
      info.open('points', { point: 'wh', chem: 'meoh' }, null, app.el('cj_root'));
      info.close();
      assert.strictEqual(app.pendingTimers(), 0, 'open / close start no timer');
      // the scrollable layout for phones is in the stylesheet
      const css = info.css();
      assert.match(css, /\.cj-dlg-bd\{[^}]*overflow-y:auto/);
      assert.match(css, /\.cj-dlg\{[^}]*max-height:calc\(100dvh - 32px\)/);
      assert.match(css, /@media \(max-width:600px\)/);
    },
  },
  {
    name: 'CHEM info: per-line buttons follow the line — every library chemical opens its family pop-up; the point and pump buttons show the line\'s selection; the calibration button opens the calibration section',
    wp: WP,
    run(app, assert) {
      open(app);
      const L = LIB(app), info = I(app);
      L.chemicals.forEach((c) => {
        app.select('cj_chem_1', c.key);
        const d = clickOpen(app, assert, btn(app, 'chem', 1), 'chem ' + c.key);
        const fam = L.family(c.family);
        assert.strictEqual(txt(app.el('cj_info_title')), fam.label, c.key + ': family title');
        assert.strictEqual(d.getAttribute('data-family'), c.family);
        assert.strictEqual(d.getAttribute('data-topic'), info.topicFor(c.key));
        const sel = d.querySelector('h4[data-sec="sel"]');
        assert.ok(sel && txt(sel) === 'Selected chemical' && txt(sel.nextElementSibling).indexOf(c.name) !== -1, c.key + ': selected chemical named');
        assert.ok(d.querySelector('h4[data-sec="sel"] + ul li[data-chem="' + c.key + '"]'), c.key + ': its dose line');
        assert.ok(d.querySelector('h4[data-sec="rank"]'), c.key + ': its point ranking');
        esc(app);
      });
      // point button: the line's point and the chemical's suitability there
      app.select('cj_chem_1', 'meoh');
      app.select('cj_pt_1', 'dsch');
      let d = clickOpen(app, assert, btn(app, 'points', 1), 'points:1');
      const selTxt = txt(d.querySelector('h4[data-sec="sel"]').nextElementSibling);
      assert.includes(selTxt, 'Downstream of choke / heater inlet');
      assert.includes(selTxt, '✓ Allowed for Methanol: The choke body and bean are not protected.');
      assert.includes(txt(d), 'Joule–Thomson cooling makes the choke outlet the coldest point');
      esc(app);
      app.select('cj_pt_1', 'sepin');
      d = clickOpen(app, assert, btn(app, 'points', 1), 'points:1 sepin');
      assert.includes(txt(d.querySelector('h4[data-sec="sel"]').nextElementSibling), '⚠ Not recommended for Methanol: Too late: the choke outlet is already the coldest point.');
      esc(app);
      // pump button: the line's pump
      app.select('cj_pump_1', 'elec_hyd_diaph');
      d = clickOpen(app, assert, btn(app, 'pumps', 1), 'pumps:1');
      assert.includes(txt(d.querySelector('h4[data-sec="sel"]').nextElementSibling), 'Hydraulically-actuated diaphragm metering pump');
      esc(app);
      // calibration card title button → the calibration section
      d = clickOpen(app, assert, app.find('#cj_card_cal .card-title [data-cj-info]'), 'calibration');
      assert.strictEqual(txt(app.el('cj_info_title')), 'Pump selection and calibration');
      assert.ok(d.querySelector('h4[data-sec="cal"]'), 'calibration section');
      assert.includes(txt(d), 'graduated drawdown cylinder');
      esc(app);
      // general pop-ups carry the expected standards
      const refs = (k) => info.content(k).refs.join(' | ');
      ['API RP 55', 'API RP 49', 'ISO 15156', 'NACE MR0175', 'EH40/2005'].forEach((r) => assert.includes(refs('h2s'), r, 'H2S cites ' + r));
      ['API Std 675', 'API Std 674', 'API Std 520', 'API Std 521', 'API RP 14C', 'API RP 500'].forEach((r) => assert.includes(refs('pumps'), r, 'pumps cite ' + r));
      ['API RP 14C', 'ISO 10418', 'API Spec 6A'].forEach((r) => assert.includes(refs('points'), r, 'points cite ' + r));
      ['GPSA Engineering Data Book', 'Sloan, E.D. and Koh, C.A.', 'Hammerschmidt', 'Nielsen, R.B. and Bucklin, R.W.'].forEach((r) => assert.includes(refs('hydrate'), r, 'hydrate cites ' + r));
      assert.includes(refs('corrosion'), 'API RP 14E');
    },
  },
  {
    name: 'CHEM info: dose numbers, design-basis defaults and screening values in the pop-ups match WTS_chemlib in imperial and in Metric (basis twins L/kg and L/10⁶ Sm³)',
    wp: WP,
    run(app, assert) {
      const root = open(app);
      const L = LIB(app), info = I(app), U = app.win.WTS_units, D = L.defaults;
      const topics = info.keys().filter((k) => k !== 'points' && k !== 'pumps');
      const check = (metric) => {
        topics.forEach((k) => {
          info.open(k, {}, null, root);
          const d = checkDialog(app, assert, k + (metric ? ' (Metric)' : ''));
          L.chemicals.filter((c) => info.topicFor(c.key) === k && c.kind !== 'custom').forEach((c) => {
            const li = d.querySelector('h4[data-sec="dose"] ~ ul li[data-chem="' + c.key + '"], li[data-chem="' + c.key + '"]');
            assert.ok(li, k + ': dose line for ' + c.key);
            const e = expected(L, c, metric);
            if (!e) return;
            const t = txt(li), list = nums(t);
            e.vals.forEach((v) => assert.ok(hasNum(list, v), c.key + (metric ? ' (Metric)' : '') + ': ' + v + ' in "' + t + '"'));
            assert.includes(t, e.unit, c.key + ': unit ' + e.unit);
          });
          info.close();
        });
      };
      check(false);
      // design basis and screening values (imperial)
      const ht = txt((info.open('hydrate', {}, null, root), dlg(app)));
      assert.includes(ht, 'Design margin ' + D.marginF + ' °F with the gas-gravity hydrate correlation; ' + D.marginMinF + ' °F allowed');
      assert.includes(ht, 'Joule–Thomson cooling × ' + D.fJT.toFixed(2) + ' for design (editable from ' + D.fJTMin.toFixed(2) + ' to ' + D.fJTMax.toFixed(2) + ')');
      assert.includes(ht, 'flash point ' + L.find('meoh').flashF + ' °F');
      info.close();
      const kl = L.find('khi').ldhi, lt = txt((info.open('ldhi', {}, null, root), dlg(app)));
      assert.includes(lt, 'up to about ' + kl.subMaxF + ' °F subcooling');
      assert.includes(lt, 'up to about ' + kl.subAdvF + ' °F for an advanced KHI');
      assert.includes(lt, 'water cut of ' + L.find('aa').ldhi.maxWaterCutPct + ' % or less');
      info.close();
      const pt = txt((info.open('pumps', {}, null, root), dlg(app)));
      assert.includes(pt, 'allowance (' + D.dpQuillPsi + ' psi)');
      assert.includes(pt, '+' + D.pumpMarginPct + ' % and +' + D.pumpMarginPsi + ' psi');
      assert.includes(pt, 'Settings up to ' + D.bandGreenPct + ' % of the pump maximum');
      info.close();
      const st = txt((info.open('h2s', {}, null, root), dlg(app)));
      L.points.filter((p) => typeof p.etaScav === 'number').forEach((p) => assert.includes(st, p.short + ' ' + Math.round(p.etaScav * 100) + ' %', 'utilisation at ' + p.key));
      info.close();
      // Metric
      U.setSystem('metric');
      try {
        app.flush(20);
        check(true);
        const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
        const hm = txt((info.open('hydrate', {}, null, root), dlg(app)));
        assert.includes(hm, 'Design margin ' + r1(D.marginF * 5 / 9) + ' °C');
        assert.includes(hm, r1(D.marginMinF * 5 / 9) + ' °C allowed');
        assert.includes(hm, 'flash point ' + Math.round((L.find('meoh').flashF - 32) * 5 / 9) + ' °C');
        info.close();
        const lm = txt((info.open('ldhi', {}, null, root), dlg(app)));
        assert.includes(lm, 'up to about ' + r1(kl.subMaxF * 5 / 9) + ' °C subcooling');
        info.close();
        const pm = txt((info.open('pumps', {}, null, root), dlg(app)));
        assert.includes(pm, 'allowance (' + Math.round(D.dpQuillPsi * 6.89476) + ' kPa)');
        assert.includes(pm, '+' + Math.round(D.pumpMarginPsi * 6.89476) + ' kPa');
        info.close();
        const sm = txt((info.open('h2s', {}, null, root), dlg(app)));
        assert.includes(sm, 'at or above 0.3 kPa');
        info.close();
      } finally { U.setSystem('imperial'); }
      app.flush(20);
      assert.includes(txt((info.open('hydrate', {}, null, root), dlg(app))), 'Design margin ' + D.marginF + ' °F', 'flip back to imperial');
      info.close();
    },
  },
  {
    name: 'CHEM info: Metric mode — no imperial unit and no NaN in any pop-up (topics, every chemical family, every point and pump selection, opened by the page buttons); results unchanged by opening',
    wp: WP,
    run(app, assert) {
      open(app);
      const L = LIB(app), info = I(app), U = app.win.WTS_units;
      const before = JSON.stringify(app.win.WTS_state.cheminj.lines);
      U.setSystem('metric');
      try {
        app.flush(20);
        const n0 = calcs(app);
        const scan = (where) => {
          const t = txt(dlg(app));
          const m = t.match(IMP);
          assert.ok(!m, where + ': imperial unit "' + (m ? m[2] : '') + '" in Metric: …' + (m ? t.slice(Math.max(0, m.index - 60), m.index + 40) : '') + '…');
          assert.ok(!BAD.test(t), where + ': no NaN');
        };
        app.findAll('#cj_root [data-cj-info]').filter(shown).forEach((b) => {
          const where = b.getAttribute('data-cj-info') + (b.getAttribute('data-n') ? ':' + b.getAttribute('data-n') : '');
          clickOpen(app, assert, b, where + ' (Metric)');
          scan(where);
          esc(app);
        });
        assert.strictEqual(calcs(app), n0, 'no recalculation in Metric either');
        const root = app.el('cj_root');
        info.keys().forEach((k) => { info.open(k, {}, null, root); scan(k); info.close(); });
        L.chemicals.forEach((c) => { info.open('chem', { chem: c.key }, null, root); scan('chem ' + c.key); info.close(); });
        L.points.forEach((p) => { info.open('points', { point: p.key, chem: 'h2s_mea_triazine' }, null, root); scan('point ' + p.key); info.close(); });
        L.pumps.forEach((p) => { info.open('pumps', { pump: p.key }, null, root); scan('pump ' + p.key); info.close(); });
      } finally { U.setSystem('imperial'); }
      app.flush(20);
      assert.strictEqual(JSON.stringify(app.win.WTS_state.cheminj.lines), before, 'results unchanged');
    },
  },
  {
    name: 'CHEM info: an open pop-up is not in the report model, the Quick Report snapshot, the CSV/JSON results or the autosave record, and the record keys do not change',
    wp: WP,
    run(app, assert) {
      open(app);
      app.input('cj_qw', '3');
      app.flush(1200);
      const rec0 = JSON.parse(app.storage.getItem('wts_page_cheminj') || 'null');
      assert.ok(rec0 && rec0.f, 'autosave record');
      const keys0 = Object.keys(rec0.f).sort();
      const m0 = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const b = btn(app, 'h2s');
      clickOpen(app, assert, b, 'h2s');
      const STR = ['Standards and references', DISC, 'API RP 55', 'H2S scavengers react irreversibly', 'Background and standards', 'H2S scavenging', 'About H2S'];
      const m1 = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const j1 = JSON.stringify(m1);
      STR.forEach((s) => assert.ok(j1.indexOf(s) === -1, 'report model holds "' + s + '"'));
      assert.strictEqual(JSON.stringify(m1.inputs), JSON.stringify(m0.inputs), 'inputs unchanged with the pop-up open');
      assert.strictEqual(JSON.stringify(m1.results), JSON.stringify(m0.results), 'results unchanged with the pop-up open');
      // a snapshot taken while the pop-up is open (an edit behind it)
      app.input('cj_days', '6');
      app.flush(1500);
      assert.strictEqual(overlays(app).length, 1, 'still open');
      const snaps = app.storage.getItem('wts_report_snapshots') || '';
      assert.ok(/Chemical Injection/.test(snaps), 'snapshot taken');
      STR.forEach((s) => assert.ok(snaps.indexOf(s) === -1, 'snapshot holds "' + s + '"'));
      const rec1 = JSON.parse(app.storage.getItem('wts_page_cheminj'));
      assert.deepStrictEqual(Object.keys(rec1.f).sort(), keys0, 'autosave keys unchanged');
      const rj = JSON.stringify(rec1);
      STR.forEach((s) => assert.ok(rj.indexOf(s) === -1, 'autosave holds "' + s + '"'));
      assert.ok(Object.keys(rec1.f).every((k) => /^cj_/.test(k)), 'only cj_* controls are stored');
      // CSV / JSON results export (same data the header buttons save)
      const data = app.win.WTS_pageResults(app.el('pgBody'));
      const out = JSON.stringify(data) + '\n' + app.win.WTS_resultsToCSV(data);
      assert.ok(data.results.length > 0, 'results exported');
      STR.forEach((s) => assert.ok(out.indexOf(s) === -1, 'CSV / JSON holds "' + s + '"'));
      esc(app);
      assert.strictEqual(app.document.activeElement, b);
    },
  },
  {
    name: 'CHEM info: no company or brand name (hashed deny-list), no web address and no forbidden word in any pop-up, button, row or the module source; references are standards, books and papers only',
    wp: WP,
    run(app, assert) {
      open(app);
      const info = I(app);
      const text = allContentText(app) + '\n' + app.findAll('#cj_root [data-cj-info]').map((b) => (b.getAttribute('aria-label') || '') + ' ' + txt(b)).join('\n');
      const src = fs.readFileSync(MODULE, 'utf8');
      [['pop-ups', text], ['module source', src]].forEach(([where, t]) => {
        const hits = denyHits(t);
        assert.deepStrictEqual(hits, [], where + ': names on the deny-list (' + hits.length + ')');
        assert.ok(!/https?:\/\/|www\.|\.(?:com|net|org|io|co\.uk)\b/i.test(t), where + ': no web address');
        assert.ok(!new RegExp('\\b' + String.fromCharCode(80, 73, 69) + '\\b').test(t), where + ': forbidden word');
      });
      assert.ok(text.length > 20000, 'all pop-ups scanned (' + text.length + ' characters)');
      // references: numbered standards, the data book, books and papers; years only where vetted
      const refs = Object.keys(info.refs).map((k) => info.refs[k]);
      refs.forEach((r) => assert.match(r, /^(API (RP|Std|Spec|MPMS) |ISO \d|ASTM D\d|GPSA Engineering Data Book|NIOSH Pocket Guide|UK Health and Safety Executive|[A-Z][a-z]+, [A-Z]\.|The safety data sheet)/, 'reference form: ' + r));
      const years = new Set(refs.join(' ').match(/\b(19|20)\d\d\b/g) || []);
      years.forEach((y) => assert.ok(['1934', '1983', '2005', '2006'].indexOf(y) !== -1, 'unvetted year ' + y));
      // every topic, family, point and pump pop-up ends with the disclaimer
      assert.strictEqual(info.content('h2s').disclaimer, DISC);
    },
  },
  {
    name: 'CHEM info: without the pop-up module the page renders exactly as before (no buttons, no row, plain labels, one calc, no errors)',
    wp: WP,
    opts: { sourceOverrides: { '49-calc-cheminj-info.js': null } },
    run(app, assert) {
      assert.strictEqual(app.win.WTS_cheminjInfo, undefined, 'module not loaded');
      const n0 = app.win.WTS_cheminj.pageCalcs();
      open(app);
      assert.strictEqual(app.win.WTS_cheminj.pageCalcs() - n0, 1, 'one calc on open');
      assert.strictEqual(app.findAll('#cj_root [data-cj-info]').length, 0, 'no ⓘ buttons');
      assert.ok(!app.find('#cj_root .cj-info-row') && !app.find('#cj_root .cj-lab'), 'no row, no label wrapper');
      assert.strictEqual(txt(app.el('cj_pt_1').closest('.fg-item').querySelector('label')), 'Injection point');
      assert.ok(app.win.WTS_state.cheminj.ok, 'results');
      app.click(app.find('#cj_card_lines .card-title'));
      assert.deepStrictEqual(app.consoleErrors(), [], 'no console errors');
    },
  },
];
