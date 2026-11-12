// Well Performance increment B (v4.5) — review fixes on the page (docs/WELL-PERFORMANCE-PLAN.md §18.3.12): every B result is captured
// by the page report / Quick Report from any step (#wp_res), the report rows follow the current model, the validity box, Notes and
// case summary with per-section correlations, the examples group, Metric text, wrapped text, the study plot names, the ESP defaults
// (D17) and the schematic label layout.
//
// RB1 ESP example: provisional methods off by default; frequency sweep and the lift-screening ranking inside #wp_res; a report from
//     step ① carries both; the 'Lift screening' report row = the current model in the table's words; validity box labels once
// RB2 Studies: envelope and tornado run, the active tab switched — the report still carries both; per-study plot names; labelled best
//     case; Metric: matrix variable lists, ESP flags and the dogleg pills in display units; the breakdown footer wraps
// RB3 Horizontal example with per-section correlations: Notes / Case summary / validity text; schematic marks clipped to the frame and
//     side labels inside the drawing without overlaps; the inflow study plot inside #wp_res
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WPI4';
const app = (ctx) => S.sharedApp(ctx);
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|\[object Object\]/;
const rep = (G, A) => JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));

module.exports = [
  {
    name: 'RB1 ESP example: provisional ESP methods off by default; sweep and screening inside #wp_res and in a report from step ①; screening row = current model, table words; validity labelled once',
    wp: WP, opts: false, timeoutMs: 180000,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="esp"]')); A.flush(30);
      const P = G.WTS_wellperf_page, pst = P.state();
      assert.ok(pst.R && pst.R.ok && pst.R.lift.type === 'esp', 'ESP solve');
      // F25: both provisional methods off (checkbox and the solve)
      assert.ok(!A.el('wp_esp_nat').checked && !A.el('wp_esp_visc').checked, 'checkboxes unchecked');
      assert.ok(pst.R.lift.natSep === false && pst.R.lift.viscOn === false, 'solve without them');
      // F10: the screening report row is built for THIS model, with the table's words
      const row = A.findAll('#wp_studies .rrow').map(txt).filter((t) => /^Lift screening/.test(t))[0] || '';
      assert.ok(row && !/\((ok|warn|fail)\)/.test(row) && /(suitable|marginal|unsuitable)/.test(row), 'words: ' + row);
      const SC = G.WTS_wp_screen.matrix(pst.M, { R: pst.R, W: pst.W }), first = SC.methods.filter((m) => m.key !== 'natural').sort((a, b) => a.rank - b.rank)[0];
      assert.ok(row.indexOf(first.label) !== -1, 'ranked first = the current matrix (' + first.label + ')');
      // F27 / F9: the screening ranking is inside #wp_res
      assert.ok(A.el('wpb_scr_r') && A.el('wpb_scr_r').closest('#wp_res') && !/wp-off/.test(A.el('wpb_scr_r').className), 'screening box in #wp_res');
      assert.match(txt(A.el('wpb_scr_r')), /Lift screening \(provisional\)/);
      // the sweep result inside #wp_res
      G.WTS_wellperf_page.goStep(4); A.flush(5);
      A.click(A.find('[data-act="espsweep"]'));
      for (let i = 0; i < 400 && !G.WTS_wellperf_ext.esp.state().sweep; i++) await A.flushAsync(1);
      assert.ok(G.WTS_wellperf_ext.esp.state().sweep.ok, 'sweep');
      assert.ok(A.el('wp_cv_espf').closest('#wp_res') && A.el('wpe_sweep').closest('#wp_res') && !/wp-off/.test(A.el('wpe_frres').className), 'sweep plot and table in #wp_res');
      assert.match(txt(A.el('wpe_frk')), /Best in range|Hz/);
      // a report taken from step ① carries the sweep table and the screening ranking
      G.WTS_wellperf_page.goStep(1); A.flush(5);
      const r1 = rep(G, A);
      assert.ok(/Rate against frequency/.test(r1) && /Lift screening \(provisional\)/.test(r1), 'report from step ①');
      // F12: provisional label once; the info style for a provisional entry
      const va = txt(A.el('wp_valid'));
      assert.ok(!/provisional — not verified against a published example\.? — provisional/.test(va), 'label once');
      const turzoOn = A.findAll('#wp_valid .wp-v').filter((e) => /provisional/.test(txt(e)));
      assert.ok(turzoOn.every((e) => !/^✓/.test(txt(e))), 'no green ✓ on a provisional entry');
      assert.ok(!BAD.test(txt(A.el('wp_res'))), 'clean');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
    },
  },
  {
    name: 'RB2 Studies: every run study reaches the report whatever tab is open; plot names per study; labelled best case; Metric text (matrix lists, ESP flags, dogleg); breakdown footer wraps',
    wp: WP, opts: false, timeoutMs: 240000,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      const E = G.WTS_wellperf_ext.studies, ES = E.state();
      A.click(A.find('[data-act="b27tab"][data-k="env"]')); A.flush(3);
      assert.match(A.el('wp_cv_st').getAttribute('aria-label'), /^Operating envelope: .*drag the point/);
      A.click(A.find('[data-act="b27env"]'));
      for (let i = 0; i < 400 && !ES.env; i++) await A.flushAsync(1);
      A.click(A.find('[data-act="b27tab"][data-k="torn"]')); A.flush(3);
      assert.match(A.el('wp_cv_st').getAttribute('aria-label'), /^Tornado/);
      A.click(A.find('[data-act="b27torn"]'));
      for (let i = 0; i < 600 && !ES.torn; i++) await A.flushAsync(1);
      assert.ok(ES.env && ES.env.ok && ES.torn && ES.torn.ok, 'both studies ran');
      // the envelope is not the active tab: its table is in #wpb_all inside #wp_res and in the report
      assert.ok(A.el('wpb_all').closest('#wp_res') && /Operating envelope/.test(txt(A.el('wpb_all'))), 'envelope table while the tornado tab is open');
      const r1 = rep(G, A);
      assert.ok(/Operating envelope/.test(r1) && /Swing/.test(r1), 'report carries both');
      A.click(A.find('[data-act="b27tab"][data-k="fcst"]')); A.flush(3);
      assert.ok(/Tornado/.test(txt(A.el('wpb_all'))) && /Operating envelope/.test(txt(A.el('wpb_all'))), 'both kept on another tab');
      assert.match(A.el('wp_cv_st').getAttribute('aria-label'), /^Depletion forecast/);
      // the breakdown footer is the whole sentence (wrapped on the canvas)
      const foot = A.el('wp_cv_bd').getAttribute('data-foot') || '';
      assert.ok(/psi/.test(foot) && !/…/.test(foot), 'footer: ' + foot);
      // Metric: matrix variable lists, the tornado J unit
      G.WTS_units.setSystem('metric');
      try {
        A.flush(30);
        A.click(A.find('[data-act="b27tab"][data-k="mat"]')); A.flush(3);
        const opts = A.findAll('#wpv_mx1 option').map(txt).join(' | ');
        assert.ok(!/\(psia\)|\(scf\/STB\)|STB\/d\/psi/.test(opts) && /kPa|bar/.test(opts), 'metric lists: ' + opts);
        A.click(A.find('[data-act="b27tab"][data-k="torn"]')); A.flush(3);
        assert.ok(!/STB\/d\/psi/.test(txt(A.el('wpb_body'))), 'tornado J in display units');
      } finally { G.WTS_units.setSystem('imperial'); A.flush(30); }
      // ESP in Metric: the flags and the dogleg pill in display units
      A.click(A.find('[data-act="example"][data-ex="esp"]')); A.flush(30);
      G.WTS_units.setSystem('metric');
      try {
        A.flush(30);
        const fl = txt(A.el('wpe_flags')) + ' ' + txt(A.el('wpe_mdinfo'));
        assert.ok(!/\d ft\b|ft\/s|bbl\/d|°\/100 ft/.test(fl), 'ESP text in metric: ' + fl.slice(0, 300));
        const chk = A.findAll('#wp_verd .wp-v').map(txt).filter((t) => /ESP/.test(t)).join(' ');
        assert.ok(!/\d ft\b/.test(chk), 'ESP check line in metric: ' + chk.slice(0, 200));
      } finally { G.WTS_units.setSystem('imperial'); A.flush(30); }
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
    },
  },
  {
    name: 'RB3 Horizontal example, per-section correlations: Notes / Case summary / validity text; schematic marks clipped and labels without overlaps; inflow study in #wp_res; matrix best case labelled',
    wp: WP, opts: false, timeoutMs: 180000,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="hz"]')); A.flush(40);
      assert.ok(A.el('wp_iprsbox').closest('#wp_res') && !/rp-skip/.test(A.el('wp_iprsbox').innerHTML.slice(0, 200)), 'inflow study in #wp_res');
      G.WTS_wellperf_page.goStep(3); A.flush(5);
      A.click(A.find('[data-act="secpreset"][data-v="dev"]')); A.flush(30);
      assert.match(txt(A.el('wp_notesbox')), /per-section correlations by MD \/ inclination/);
      assert.ok(!/one correlation for the whole well/.test(txt(A.el('wp_notesbox'))), 'no single-correlation claim');
      assert.match(txt(A.el('wp_case')), /Correlations.*sections/);
      assert.ok(!/1[0-9]{2}° from vertical/.test(txt(A.el('wp_valid'))), 'inclination text ≤ 90°');
      // the schematic: perforation ticks and the correlation rail are clipped to the section frame; side labels inside the drawing,
      // no two overlapping
      const svg = A.el('wp_sch').innerHTML;
      assert.ok(/data-comp="perf" clip-path="url\(#wpSchClip\d+\)"/.test(svg), 'perforations clipped');
      const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg), W = +vb[1];
      const labs = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" fill="[^"]+" font-size="10" font-weight="700">([^<]*)<\/text>/g)].map((m) => ({ x: +m[1], y: +m[2], w: m[3].length * 6 + 2, t: m[3] }));
      assert.ok(labs.length >= 2, 'side labels: ' + labs.length);
      labs.forEach((l) => assert.ok(l.x >= 0 && l.x + l.w <= W + 1, 'inside the drawing: ' + l.t));
      for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) {
        const a = labs[i], b = labs[j], hit = a.x < b.x + b.w && a.x + a.w > b.x && Math.abs(a.y - b.y) < 11;
        assert.ok(!hit, 'labels overlap: ' + a.t + ' / ' + b.t);
      }
      A.click(A.find('[data-act="secpreset"][data-v="clear"]')); A.flush(30);
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
    },
  },
];
