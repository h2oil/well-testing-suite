// Well Performance A2, WP19 — the Well performance course (docs/WELL-PERFORMANCE-PLAN.md §14, §17.2). Content:
// prism-build/48-calc-help-wpcourse.js (WTS_helpContent.course, exercises with course: 'wellperf').
//
// WC1 shape: three exercises (E1 beans + test, E2 loading gas well, E3 VLP tuning + skin), each with goal, set-up, steps, what to
//     observe, questions with as many answers, trainer notes; bold phrases are visible text on the wellperf page; links resolve
// WC2 E1 numbers reproduce on the page's Oil example: bean schedule 24 / 32 / 40, the test comparison at the gauge, J from T1
// WC3 E2 numbers reproduce on the page's Gas example: loading at p̄r 2,500 psia, the tubing-size design rows, one 2-7/8" string
// WC4 E3 numbers reproduce: m_h from T1, skin with the gauge (tuned = untuned), skin from THP only (untuned / tuned), the bound variant
// WC5 the help page: a course list per course, search module labels, course#wp… links open the right course, worksheets and the
//     book chapter per course (no answers or trainer notes on a worksheet)
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP19';
const A_ = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const txt = (e) => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
function course(G) { const C = G.WTS_help.load(); return A_(C.course).filter((x) => x.course === 'wellperf'); }
function ex(G, id) { return course(G).filter((x) => x.id === id)[0]; }
// the exercise text holds this token / phrase (the numbers in the course are the engine's numbers)
function says(assert, x, s) { assert.ok(JSON.stringify(x).indexOf(s) !== -1, x.id + ' says ' + s); }
function example(A, k) {
  const G = A.win;
  S.resetWellPerf(A); if (G.WTS_wellperf_page.resetJobs) G.WTS_wellperf_page.resetJobs();
  A.hook.nav('wellperf'); A.flush(30);
  A.click(A.find('[data-act="example"][data-ex="' + k + '"]')); A.flush(30);
  return clone(G.WTS_wellperf_page.state().M);
}

module.exports = [
  {
    name: 'WC1 shape: three exercises with trainer notes; bold phrases are wellperf page text; links resolve',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, H = G.WTS_help, x3 = course(G);
      assert.strictEqual(x3.map((x) => x.id).join(), 'wp1,wp2,wp3');
      assert.ok(x3.every((x) => x._group === 'wpcourse'), 'from 48-calc-help-wpcourse.js');
      x3.forEach((x) => {
        ['title', 'goal'].forEach((k) => assert.ok(x[k], x.id + '.' + k));
        ['setup', 'steps', 'observe', 'questions', 'answers', 'keywords'].forEach((k) => assert.ok(A_(x[k]).length, x.id + '.' + k));
        assert.strictEqual(x.answers.length, x.questions.length, x.id + ': one answer per question');
        const t = x.trainer || {};
        ['duration', 'fault', 'good'].forEach((k) => assert.ok(t[k], x.id + '.trainer.' + k));
        assert.ok(A_(t.mistakes).length >= 2 && A_(t.debrief).length >= 2, x.id + ': mistakes and debrief');
        assert.ok(/\[\[wellperf\]\]/.test(A_(x.setup).join(' ')), x.id + ': the set-up opens the page');
        assert.ok(Buffer.byteLength(JSON.stringify(x)) <= 4096, x.id + ' ≤ 4 kB');
      });
      // bold phrases: visible text of the wellperf page (all seven steps are in the DOM)
      example(A, 'oil');
      // the tuning result's buttons appear after Tune to the tests: they must be button labels in the page source
      const AFTER_TUNE = ['apply to the model', 'reset to 1 (untuned)'], SRC = require('fs').readFileSync(require('path').join(S.BUILD, '49-calc-wellperf.js'), 'utf8');
      const vis = [txt(A.el('pgBody')), txt(A.el('hubTabs'))].join(' | ').toLowerCase(), miss = [];
      x3.forEach((x) => A_(x.steps).concat(A_(x.setup), A_(x.trainer && x.trainer.fault)).forEach((s) => (String(s).match(/\*\*([^*]+)\*\*/g) || []).forEach((b) => {
        const p = b.slice(2, -2).replace(/\s+/g, ' ').trim().toLowerCase();
        if (vis.indexOf(p) === -1 && !(AFTER_TUNE.includes(p) && SRC.indexOf('>' + b.slice(2, -2) + '</button>') !== -1)) miss.push(x.id + ': ' + p);
      })));
      assert.strictEqual(miss.join('; '), '', 'bold phrases not on the page');
      // links resolve to the course, the guide or an exercise
      const html = H.renderList('wpcourse');
      assert.ok(/data-help-go="wellperf"/.test(html) && /data-help-go="course" data-help-sec="wp3"/.test(html), 'links to the guide and to exercise 3');
      assert.ok(!/NaN|undefined|\[object Object\]/.test(html), 'clean');
    },
  },
  {
    name: 'WC2 E1 numbers: bean schedule 24 / 32 / 40 on the Oil example, critical; T1 at the gauge; J from T1',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, SY = G.WTS_wp_system, MA = G.WTS_wp_match, x = ex(G, 'wp1'), M = example(A, 'oil');
      let bs = SY.beanSchedule(M, [24, 32, 40]); if (bs && typeof bs.step === 'function') bs = run(bs);
      const rows = A_(bs.rows || bs);
      assert.strictEqual(rows.length, 3);
      [[645, 389], [914, 320], [1139, 262]].forEach((e, i) => {
        const r = rows[i];
        assert.ok(r.ok && r.regime === 'critical' && r.stable, 'bean ' + r.bean + ' critical and stable');
        assert.ok(Math.abs(r.q - e[0]) < 1.5 && Math.abs(r.thp - e[1]) < 1.5, 'bean ' + r.bean + ': ' + r.q.toFixed(1) + ' at ' + r.thp.toFixed(1));
        says(assert, x, '{{' + e[0] + '|liquidRate}}'); says(assert, x, '{{' + e[1] + '|pressureG}}');
      });
      assert.strictEqual((rows[2].q / rows[0].q).toFixed(2), '1.77'); says(assert, x, '1.77 times'); says(assert, x, '2.78 times');
      assert.ok(Math.round(rows[0].pwf) === 2678 && Math.round(rows[2].pwf) === 2430, 'pwf 2678 → 2430');
      const R = SY.solve(M);
      assert.ok(Math.round(R.op.q) === 914 && Math.round(R.surface.thp_psig) === 320, 'bean 32 solve: ' + R.op.q);
      const t = M.tests[0];
      assert.ok(t.q_o === 700 && t.q_w === 300 && t.thp_psig === 250 && t.bean64 === 32 && t.gauge_psia === 2500 && t.gaugeMd === 7900, 'T1 as the course says');
      const cmp = MA.compare(M, M.tests, ['bb', 'dr', 'hb', 'gray', 'nsl']);
      const bb = cmp.rows.find((r) => r.corr === 'bb'), first = cmp.rows.find((r) => r.rank === 1);
      assert.ok(Math.round(bb.perTest[0].err) === -147 && bb.errPct.toFixed(1) === '5.9', 'Beggs & Brill at the gauge: ' + bb.perTest[0].err);
      assert.ok(first.corr === 'dr' && first.provisional && Math.round(first.perTest[0].err) === -78, 'Duns & Ros first, provisional');
      says(assert, x, '{{147|pressure}} low (5.9 %)'); says(assert, x, '{{78|pressure}} low');
      const J = MA.iprFromTest(M, t, 'J');
      assert.ok(J.ok && J.value.toFixed(2) === '2.15' && J.method === 'gauge', 'J from T1: ' + J.value);
      says(assert, x, '{{2.15|productivityIndex}}');
    },
  },
  {
    name: 'WC3 E2 numbers: the Gas example loads at p̄r 2,500 psia in the 3-1/2" section; tubing design rows; one 2-7/8" string unloads',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, SY = G.WTS_wp_system, x = ex(G, 'wp2'), M = example(A, 'gas');
      const R0 = SY.solve(M);
      assert.ok(R0.ok && Math.round(100 * R0.loading.margin) === 100, 'p̄r 5000: margin about +100 % (' + R0.loading.margin + ')');
      const m = clone(M); m.res.pr = 2500;
      const R = SY.solve(m), L = R.loading;
      assert.ok(R.ok && Math.round(R.op.q) === 2542 && Math.round(R.surface.thp_psig) === 1081, 'p̄r 2500: ' + R.op.q + ' at ' + R.surface.thp_psig);
      assert.ok(L.verdict === 'fail' && L.method === 'turner' && L.qc_MMscfd.toFixed(2) === '2.66' && Math.round(100 * L.margin) === -5, 'loading ✗, Turner 2.66, −5 %');
      assert.ok(Math.round(L.limitingMd) === 5000 && Math.round(L.limitingTvd) === 4731, 'worst depth MD 5000 / TVD 4731');
      ['{{2542|gasRateSmall}}', '{{1081|pressureG}}', '{{2.66|gasRate}}', 'margin −5 %', '{{5000|length}} MD ({{4731|length}} TVD)'].forEach((s) => says(assert, x, s));
      const bd = A_(R.breakdown), dp = (k) => (bd.find((b) => b.key === k) || {}).dp;
      assert.ok(Math.round(dp('friction')) === 31 && Math.round(dp('gravity')) === 1031, 'friction 31, gravity 1031');
      says(assert, x, '{{31|pressure}}'); says(assert, x, '{{1031|pressure}}');
      const d = run(SY.designFor(m, { tubingId: 2500 }));
      assert.ok(d.ok && d.tubKey === 'tubing-1.9-2.9', 'the design names the 1.900"');
      const row = (id) => d.rows.find((r) => Math.abs(r.id - id) < 1e-3);
      assert.ok(Math.round(100 * row(1.61).loadingMargin) === 215 && Math.round(100 * row(2.992).loadingMargin) === -13, 'margins +215 % … −13 %');
      assert.strictEqual(row(1.61).ero.toFixed(2), '0.58', 'erosion ratio of the 1.900"');
      says(assert, x, '+215 %'); says(assert, x, '−13 %'); says(assert, x, '(0.58)');
      const m2 = clone(m); m2.well.strings.forEach((s) => { if (s.kind === 'tubing') { s.id = 2.441; s.od = 2.875; } });
      const R2 = SY.solve(m2);
      assert.ok(Math.round(R2.op.q) === 2598 && Math.round(100 * R2.loading.margin) === 38 && R2.loading.qc_MMscfd.toFixed(2) === '1.88' && R2.loading.verdict === 'ok', '2-7/8": ' + R2.op.q);
      assert.strictEqual(Math.round(R2.loading.limitingMd), 9850, 'worst at the tubing shoe');
      says(assert, x, '{{2598|gasRateSmall}}'); says(assert, x, 'margin +38 %'); says(assert, x, '{{1.88|gasRate}}');
      // trainer variant: p̄r 3000, WGR 2 → 20
      const m3 = clone(M); m3.res.pr = 3000;
      const a = SY.solve(m3).loading.margin; m3.fluid.wgr = 20; const b = SY.solve(m3).loading.margin;
      assert.ok(Math.round(100 * a) === 21 && Math.round(100 * b) === 13, 'variant: +21 % → +13 %');
    },
  },
  {
    name: 'WC4 E3 numbers: m_h 1.064 from T1 (m_h only); skin +2.8 with the gauge tuned or not; THP only +6.0 untuned, +2.8 tuned; the 2,800 psia bound variant',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, MA = G.WTS_wp_match, x = ex(G, 'wp3'), M = example(A, 'oil');
      const T = MA.tune(M, M.tests);
      assert.ok(T.ok && T.mult.hl.toFixed(3) === '1.064' && T.mult.f === 1 && T.free.join() === 'hl', 'm_h only: ' + T.mult.hl);
      assert.ok(T.flags.some((f) => f.code === 'TUNE_MH_ONLY') && Math.abs(T.rho) > 0.999, 'one test: m_h only, |ρ| = 1');
      assert.ok(Math.round(T.residuals[0].errUntuned) === -147 && Math.abs(T.residuals[0].errTuned) < 0.5, 'gauge error −147 → 0');
      says(assert, x, '1.064'); says(assert, x, '{{147|pressure}} low at the gauge (5.9 %)'); says(assert, x, '(correlation 1.0)');
      const darcy = (mult) => { const m = clone(M); m.system.mult = mult; m.res.model = 'darcyOil'; m.res.params = { k: 80, h: 30, rw: 0.354, re: 1490, S: 0 }; return m; };
      const tuned = darcy({ hl: T.mult.hl, f: 1 }), raw = darcy({ hl: 1, f: 1 });
      const sg = MA.iprFromTest(tuned, tuned.tests[0], 'S'), su = MA.iprFromTest(raw, raw.tests[0], 'S');
      assert.ok(sg.ok && sg.method === 'gauge' && sg.value.toFixed(1) === '2.8' && su.value.toFixed(1) === '2.8' && Math.round(sg.pwf) === 2535, 'gauge: S +2.8 tuned or not');
      const thpOnly = (m) => Object.assign({}, m.tests[0], { gauge_psia: null, gaugeMd: null });
      const ut = MA.iprFromTest(raw, thpOnly(raw), 'S'), tt = MA.iprFromTest(tuned, thpOnly(tuned), 'S');
      assert.ok(ut.ok && ut.value.toFixed(1) === '6.0' && Math.round(ut.pwf) === 2388, 'THP only, untuned: ' + ut.value);
      assert.ok(tt.ok && tt.value.toFixed(1) === '2.8', 'THP only, tuned: ' + tt.value);
      ['{{2535|pressure}}', 'S +2.8', '{{2388|pressure}} and S +6.0', '{{80|permeability}}', '{{30|length}}', '{{0.354|length}}', '{{1490|length}}'].forEach((s) => says(assert, x, s));
      assert.strictEqual(M.well.midPerfMd - M.tests[0].gaugeMd, 100, 'gauge 100 ft above the mid-perforations'); says(assert, x, '{{100|length}} above');
      const mb = clone(M); mb.tests[0].gauge_psia = 2800;
      const Tb = MA.tune(mb, mb.tests);
      assert.ok(Tb.mult.hl === 1.25 && Tb.flags.some((f) => f.code === 'TUNE_AT_BOUND'), 'variant: m_h at its 1.25 bound');
      says(assert, x, '{{2800|pressure}}'); says(assert, x, 'TUNE_AT_BOUND');
    },
  },
  {
    name: 'WC5 help page: a course list per course, search labels, course links open the right course, worksheets and book chapter per course',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, H = G.WTS_help, C = H.load();
      assert.ok(A_(H.COURSES).map((c) => c[0]).join() === 'sim,wellperf', 'two courses');
      const sim = H.exercises('course'), wp = H.exercises('wpcourse');
      assert.ok(sim.length >= 8 && sim.every((x) => !x.course) && wp.length === 3, 'simulator ' + sim.length + ', well performance ' + wp.length);
      assert.strictEqual(sim.length + wp.length, C.course.length, 'every exercise in one course');
      const hs = H.renderList('course'), hw = H.renderList('wpcourse');
      assert.ok(/Well Test Simulator course/.test(hs) && !/help-course-wp1/.test(hs), 'simulator list without the wellperf exercises');
      assert.ok(/Well performance course/.test(hw) && /id="help-course-wp1"/.test(hw) && !/help-course-ex1"/.test(hw) && />1 Predict the rate/.test(hw), 'well performance list numbered from 1');
      // the page: links in the bar and the contents; course#wp2 opens the well performance course at exercise 2
      A.hook.nav('help'); A.flush(10);
      const bar = txt(A.find('#help_root .help-links'));
      assert.ok(/Simulator course/.test(bar) && /Well performance course/.test(bar), 'a link per course: ' + bar);
      H.goTo('course', 'wp2'); A.flush(2);
      assert.ok(H.view && H.view().kind === 'wpcourse' && /help-course-wp2/.test(A.el('help_main').innerHTML), 'course#wp2 → the well performance course');
      assert.ok(/Well performance course/.test(txt(A.el('help_toc_nav'))), 'contents lists the course');
      const it = H.printItems({ kind: 'wpcourse' }).map((i) => i[1]);
      assert.strictEqual(it.filter((s) => /^worksheet:/.test(s)).join(), 'worksheet:wp1,worksheet:wp2,worksheet:wp3', 'worksheets of this course');
      assert.ok(H.printItems({ kind: 'course' }).every((i) => !/worksheet:wp/.test(i[1])), 'no wellperf worksheet on the simulator course');
      const w = H.renderBook('worksheet:wp3');
      assert.ok(/Trainee worksheet/.test(w) && /3 Tune the VLP/.test(w) && !/Answers<\/summary>|For the trainer/.test(w) && !/S \+6\.0 instead/.test(w), 'worksheet without answers or trainer notes');
      const P = H.bookPlan(), ch = P.ch.find((c) => c.kind === 'wpcourse'), fs = P.ch.find((c) => c.kind === 'fs');
      assert.ok(ch && ch.n === fs.n + 1, 'the course chapter follows the field scenarios');
      const book = H.renderBook('all');
      assert.ok(/id="bk-wpcourse"/.test(book) && /id="bk-course"/.test(book), 'both course sections in the book');
      assert.ok(new RegExp('exercise 3 \\(see Chapter ' + ch.n + '\\)').test(book), 'course#wp3 prints as the well performance chapter');
      // search: the module label names the course
      const hits = H.search('back-calculate skin gauge');
      assert.ok(hits.some((h) => h.kind === 'course' && h.id === 'wp3' && h.module === 'Well performance course'), 'search finds exercise 3: ' + JSON.stringify(hits.slice(0, 3).map((h) => h.id + ' ' + h.module)));
      assert.ok(H.search('dump valve failure').some((h) => h.kind === 'course' && h.module === 'Simulator course'), 'simulator exercises keep their label');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
];
