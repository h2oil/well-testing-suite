// Well Dynamics WD2 — views (docs/WELL-DYNAMICS-PLAN.md §3.11, §6.4, §6.5; lane WD2: welldyn-view VW1–VW14).
//
// The engine (WD1) and the WD0 mock are not needed: the grid and the frames are built here from the shared survey engine
// (WTS_wellbore.surveyMC, minimum curvature) in the §3.2 shapes, so the drawing contract is tested on its own.
//
// VW1  namespace and frozen orders (REGIMES, STATE_ORDER, STATE_COLORS keys), no registry page, no WD0 stub name left
// VW2  trajectory geometry: vertical, J, S and horizontal from the shared survey; equal scale in 'true'; the schematic mode
// VW3  layers and colours: phase, regime (WTS_wp_view.PATTERN_COLORS), pressure / holdup / velocity on the WTS_wp_view ramp
// VW4  regime pictures: annular films and gas core, stratified liquid on the low side, segregated level at the deep end
// VW5  particles: deterministic (identical logs, no Math.random), move with the sign of the local velocity, frozen when scrubbing
// VW6  reduced motion and particles off: no particles, direction arrows only; the particle budget is kept
// VW7  pick / hover / select: pointer, click and keyboard; the hover readout in field and Metric units
// VW8  zoom: setZoom, wheel (only focused or with Ctrl), drag pan, '0' reset; navigator window, drag and keys
// VW9  cell close-up: picture per regime, falling film arrow, readout lines (Metric), narrow layout
// VW10 depth log, trend, IPR / VLP and WHP-rate chart specs on WTS_wp_view.chart (units, decimation, cursor scrub, marks)
// VW11 state strip: segments from the recorder's state indices (STATE_ORDER), colours, scrub, ARIA text
// VW12 hidden canvases draw at their fixed CSS sizes (wellbore 360×480, report sizes), Metric labels on the axis
// VW13 theme: STATE_COLORS and the panels follow the host CSS variables
// VW14 cost per frame: canvas operations for 60 cells and 300 particles, Node ms per frame, no timers, destroy removes listeners
'use strict';

const WP = 'WD2';
let _shared = null;
function app(ctx) {
  const key = ctx.mode;
  if (_shared && _shared.key === key) return _shared.app;
  if (_shared && _shared.app && typeof _shared.app.dispose === 'function') { try { _shared.app.dispose(); } catch (_) { /* ignore */ } }
  _shared = { key, app: ctx.loadApp({}) };
  return _shared.app;
}
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const near = (assert, a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')');

// ── local grid and frames in the §3.2 shapes ─────────────────────────────────────────────────────────────────
const SURVEYS = {
  vertical: [[0, 0, 0], [10000, 0, 0]],
  J: [[0, 0, 0], [3000, 0, 45], [5000, 60, 45], [10000, 60, 45]],
  S: [[0, 0, 0], [2000, 0, 90], [3500, 30, 90], [6000, 30, 90], [7500, 0, 90], [10000, 0, 90]],
  horizontal: [[0, 0, 0], [7000, 0, 120], [8125, 90, 120], [10125, 90, 120]],
};
function buildGrid(win, kind, n) {
  const mc = win.WTS_wellbore.surveyMC(SURVEYS[kind]);
  const td = SURVEYS[kind][SURVEYS[kind].length - 1][0];
  const traj = [];
  for (let md = 0; md <= td + 1e-6; md += 50) { const s = mc.at(md); traj.push({ md, tvd: s.tvd, dep: s.dep, n: s.n, e: s.e }); }
  n = n || 60;
  const cells = [];
  for (let i = 0; i < n; i++) {                       // index 0 = the bottom cell
    const md1 = td * (n - i) / n, md0 = td * (n - i - 1) / n, a = mc.at(md0), b = mc.at(md1), c = mc.at((md0 + md1) / 2);
    const id = (kind === 'horizontal' && md0 >= 8125) ? 3.958 : 2.441;
    cells.push({ i, md0, md1, mdc: (md0 + md1) / 2, tvd0: a.tvd, tvd1: b.tvd, tvdc: c.tvd, len: md1 - md0, dz: a.tvd - b.tvd, inc: c.inc, id,
      area: Math.PI * Math.pow(id / 24, 2), vol: Math.PI * Math.pow(id / 24, 2) * (md1 - md0), kind: id > 3 ? 'liner' : 'tubing', seg: 0, corr: 'bb' });
  }
  return { n, cells, traj, eotCell: 0, pumpFace: -1, injCell: -1, valveCells: [], gaugeCells: [] };
}
const R = (name) => ['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown'].indexOf(name);
// a gas well loading up: liquid column below levelMd (slug / bubble), annular above; pressures hydrostatic-ish
function frame(grid, o) {
  o = o || {};
  const n = grid.n, f = { p: [], T: [], ag: [], ao: [], aw: [], vg: [], vl: [], vm: [], vc: [], rhoM: [], regime: [] };
  const level = o.level == null ? 8000 : o.level;
  for (let i = 0; i < n; i++) {
    const c = grid.cells[i], wet = c.mdc > level;
    const reg = o.regime ? o.regime(c, i) : (wet ? (i % 3 ? 'slug' : 'bubble') : 'annular');
    const ag = o.ag ? o.ag(c, i) : (wet ? 0.35 : 0.96);
    const aw = (1 - ag) * 0.7, ao = (1 - ag) - aw;
    f.p.push(500 + c.tvdc * (wet ? 0.35 : 0.08)); f.T.push(100 + c.tvdc * 0.012);
    f.ag.push(ag); f.ao.push(ao); f.aw.push(aw);
    f.vg.push(o.vg != null ? o.vg : (wet ? 2 : 25)); f.vl.push(o.vl != null ? o.vl : (wet ? 0.4 : -0.3)); f.vm.push(wet ? 1.5 : 22);
    f.vc.push(12); f.rhoM.push(wet ? 40 : 4); f.regime.push(R(reg));
  }
  return { t: o.t == null ? 3600 : o.t, cells: f, faces: {}, markers: o.markers || [], liquidTopMd: o.liquidTopMd, gasCapMd: o.gasCapMd,
           dtWall: o.dtWall == null ? 1 / 60 : o.dtWall, playing: o.playing !== false };
}
function canvas(a, w, h, hidden) {
  const cv = a.document.createElement('canvas');
  cv.style.width = (w || 360) + 'px'; cv.style.height = (h || 480) + 'px';
  if (hidden) cv.style.display = 'none';
  a.document.body.appendChild(cv);
  return cv;
}
function log(cv) { return (cv._log || []).slice(); }
function clearLog(cv) { if (cv._log) cv._log.length = 0; }
// fills = [{color, pts}] from the recorded ops (beginPath … fill)
function fills(cv) {
  const out = []; let color = null, pts = [], open = false;
  log(cv).forEach((e) => {
    if (e.op === 'set' && e.prop === 'fillStyle') color = e.value;
    else if (e.op === 'beginPath') { pts = []; open = true; }
    else if ((e.op === 'moveTo' || e.op === 'lineTo') && open) pts.push([e.args[0], e.args[1]]);
    else if (e.op === 'fill') { out.push({ color, pts }); open = false; }
  });
  return out;
}
function arcs(cv) { return log(cv).filter((e) => e.op === 'arc').map((e) => e.args); }
function ev(a, el, type, init) {
  const C = /^key/.test(type) ? a.win.KeyboardEvent : /^wheel/.test(type) ? a.win.WheelEvent : a.win.PointerEvent;
  el.dispatchEvent(new C(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
}
function rec(series) {        // a minimal recorder in the §3.4 shape (times / series / channels)
  const t = Float64Array.from(series.t);
  return {
    times: () => t,
    series: (k) => (series[k] ? Float64Array.from(series[k]) : new Float64Array(t.length).fill(NaN)),
    channels: () => [{ key: 'thp', label: 'THP', unit: 'psig', cat: 'pressureG', dp: 0 }, { key: 'qg', label: 'q gas', unit: 'Mscf/d', cat: 'gasRateSmall', dp: 0 },
      { key: 'pwf', label: 'BHP', unit: 'psia', cat: 'pressure', dp: 0 }, { key: 'state', label: 'state', unit: '–', cat: null, dp: 0 }],
  };
}

module.exports = [
  {
    name: 'VW1 namespace and frozen orders: WTS_wd_view API, REGIMES = the keys of WTS_wp_view.PATTERN_COLORS, STATE_ORDER (18), STATE_COLORS per state, no registry page',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view;
      assert.ok(V && V.VERSION, 'WTS_wd_view');
      ['wellbore', 'navigator', 'closeUp', 'depthLog', 'trend', 'nodal', 'whpRate', 'stateStrip', 'units', 'describe', 'stateColors'].forEach((k) => assert.strictEqual(typeof V[k], 'function', k));
      assert.deepStrictEqual(Array.from(V.REGIMES), ['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown']);
      V.REGIMES.forEach((k) => assert.ok(a.win.WTS_wp_view.PATTERN_COLORS[k], 'pattern colour for ' + k));
      assert.strictEqual(V.STATE_ORDER.length, 18);
      assert.deepStrictEqual(Array.from(V.STATE_ORDER).slice(0, 9), ['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin']);
      V.STATE_ORDER.forEach((k) => assert.ok(/^(#|rgb)/.test(String(V.STATE_COLORS[k]).trim()), 'state colour ' + k));
      const E = a.win.WTS_wd_engine;
      if (E && E.REGIMES) assert.deepStrictEqual(Array.from(E.REGIMES), Array.from(V.REGIMES), 'engine REGIMES = view fallback');
      if (E && E.STATE_ORDER) assert.deepStrictEqual(Array.from(E.STATE_ORDER), Array.from(V.STATE_ORDER), 'engine STATE_ORDER = view fallback');
      assert.ok(!(a.win.WTS_calcRegistry || {}).wd_view, 'no registry page');
      assert.ok(!(a.win.__WD_STUBS || []).some((s) => /^WTS_wd_view/.test(s)), 'no WD0 stub name of WTS_wd_view left');
    },
  },
  {
    name: 'VW2 trajectory geometry from the shared survey: vertical one column, J / S departure shape, horizontal lateral at constant TVD, equal scale, schematic straightened MD',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view;
      const centres = (kind, spec) => {
        const g = buildGrid(a.win, kind), cv = canvas(a), W = V.wellbore(cv, Object.assign({ grid: g, traj: g.traj, labels: false, particles: { on: false } }, spec || {}));
        W.draw(frame(g)); const pts = g.cells.map((c, i) => W.cellAt(i)); W.destroy();
        return { g, pts, L: W.layout() };
      };
      // vertical: one column, deeper cells lower on screen
      let r = centres('vertical');
      const x0 = r.pts[0][0];
      r.pts.forEach((p, i) => near(assert, p[0], x0, 0.5, 'vertical x of cell ' + i));
      for (let i = 1; i < r.pts.length; i++) assert.ok(r.pts[i][1] < r.pts[i - 1][1], 'cell ' + i + ' above cell ' + (i - 1));
      // J: departure grows below the kick-off, then a straight hold at 60°
      r = centres('J');
      const top = r.pts[r.pts.length - 1], bot = r.pts[0];
      assert.ok(bot[0] - top[0] > 60, 'J departs to one side');
      const kop = r.g.cells.filter((c) => c.md1 <= 3000).map((c) => r.pts[c.i][0]);
      kop.forEach((x) => near(assert, x, top[0], 0.6, 'vertical above the kick-off'));
      // equal scale ('true'): Δx / Δy on screen equals Δ(vertical section) / ΔTVD of the hold
      const cA = r.g.cells.find((c) => Math.abs(c.mdc - 6000) < 100), cB = r.g.cells.find((c) => Math.abs(c.mdc - 9000) < 100);
      const pA = r.pts[cA.i], pB = r.pts[cB.i];
      near(assert, (pA[0] - pB[0]) / (pA[1] - pB[1]), Math.tan(60 * Math.PI / 180), 0.03, 'screen slope = tan(60°)');
      // S: out and back to vertical — x grows then stays constant (vertical again below 7,500 ft)
      r = centres('S');
      const lowCells = r.g.cells.filter((c) => c.md0 >= 7500).map((c) => r.pts[c.i][0]);
      lowCells.forEach((x) => near(assert, x, lowCells[0], 0.6, 'vertical below the drop'));
      assert.ok(lowCells[0] - r.pts[r.pts.length - 1][0] > 30, 'S holds a departure');
      // horizontal: the lateral is level on screen and runs sideways
      r = centres('horizontal');
      const lat = r.g.cells.filter((c) => c.md0 >= 8200).map((c) => r.pts[c.i]);
      lat.forEach((p) => near(assert, p[1], lat[0][1], 0.6, 'lateral at constant TVD'));
      assert.ok(Math.abs(lat[0][0] - lat[lat.length - 1][0]) > 80, 'lateral runs sideways on screen');
      const wLat = r.L.cells[r.g.cells.find((c) => c.md0 >= 8200).i].w, wTub = r.L.cells[r.g.cells.length - 1].w;
      assert.ok(wLat > wTub, 'the 4-1/2" liner is drawn wider than the tubing');
      // 'fit' aspect stretches a vertical well across the panel width; schematic straightens the MD
      r = centres('horizontal', { view: 'schematic' });
      const xs = r.pts[0][0];
      r.pts.forEach((p) => near(assert, p[0], xs, 1e-6, 'schematic column'));
      const dy = r.pts[0][1] - r.pts[r.pts.length - 1][1], dmd = r.g.cells[0].mdc - r.g.cells[r.g.cells.length - 1].mdc;
      r.g.cells.forEach((c, i) => near(assert, r.pts[i][1] - r.pts[r.pts.length - 1][1], (c.mdc - r.g.cells[r.g.cells.length - 1].mdc) * dy / dmd, 0.01, 'schematic Y linear in MD'));
      // no traj: the path is rebuilt from the cells (TVD exact)
      const g = buildGrid(a.win, 'J'), cv = canvas(a), W = V.wellbore(cv, { grid: { n: g.n, cells: g.cells }, labels: false });
      W.draw(frame(g)); assert.ok(W.cellAt(0) && W.cellAt(59), 'draws without traj'); W.destroy();
    },
  },
  {
    name: 'VW3 layers and colours: phase colours, regime = PATTERN_COLORS of each cell, pressure / holdup / velocity on the WTS_wp_view ramp between the window extremes',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, WV = a.win.WTS_wp_view, g = buildGrid(a.win, 'vertical', 20), cv = canvas(a);
      const fr = frame(g, { level: 5000 });
      const W = V.wellbore(cv, { grid: g, traj: g.traj, labels: false, particles: { on: false } });
      clearLog(cv); W.draw(fr);
      let cols = fills(cv).map((f) => f.color);
      assert.ok(cols.includes(V.PHASE_COLORS.gas), 'gas colour');
      assert.ok(cols.some((c) => /^rgb\(/.test(c)), 'liquid mix colour');
      ['regime', 'pressure', 'holdup', 'velocity'].forEach((layer) => {
        assert.strictEqual(W.setLayer(layer), layer);
        clearLog(cv); W.draw(fr); cols = fills(cv).map((f) => f.color);
        if (layer === 'regime') {
          ['slug', 'bubble', 'annular'].forEach((r) => assert.ok(cols.includes(WV.PATTERN_COLORS[r]), 'regime colour ' + r));
        } else if (layer === 'pressure') {
          assert.ok(cols.includes(WV.ramp(1)) && cols.includes(WV.ramp(0)), 'pressure ramp spans the window');
        } else if (layer === 'holdup') {
          assert.ok(cols.includes(WV.ramp(1 - 0.96)) && cols.includes(WV.ramp(1 - 0.35)), 'holdup = 1 − α_g on the ramp');
        } else assert.ok(cols.includes(WV.ramp(1)), 'velocity ramp top');
      });
      assert.strictEqual(W.setLayer('bogus'), 'velocity', 'unknown layer refused');
      // a cell without state (NaN) is grey, not NaN text
      const bad = frame(g); bad.cells.p[3] = NaN; bad.cells.ag[3] = NaN;
      W.setLayer('phase'); clearLog(cv); W.draw(bad);
      assert.ok(fills(cv).some((f) => f.color === '#6e7681'), 'missing state drawn grey');
      assert.ok(!a.canvasTexts(cv).some((t) => /NaN|undefined|Infinity/.test(t)), 'no NaN text');
      W.destroy();
    },
  },
  {
    name: 'VW4 regime pictures: annular = liquid films on both walls around a gas core; stratified = liquid on the low side of the lateral; segregated = water at the deep end of the cell',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, PH = V.PHASE_COLORS;
      // annular in a vertical well: two liquid bands either side of the centreline
      let g = buildGrid(a.win, 'vertical', 4), cv = canvas(a);
      let W = V.wellbore(cv, { grid: g, traj: g.traj, labels: false, particles: { on: false } });
      clearLog(cv); W.draw(frame(g, { level: 99999, regime: () => 'annular', ag: () => 0.9 }));
      const cx = W.cellAt(2)[0];
      const liq = fills(cv).filter((f) => /^rgb\(/.test(f.color) && f.pts.length);
      const meanX = (f) => f.pts.reduce((s, p) => s + p[0], 0) / f.pts.length;
      assert.ok(liq.some((f) => meanX(f) < cx - 1) && liq.some((f) => meanX(f) > cx + 1), 'films on both walls');
      W.destroy();
      // stratified on the horizontal lateral: the liquid band lies below the centreline (larger screen y)
      g = buildGrid(a.win, 'horizontal', 30); cv = canvas(a);
      W = V.wellbore(cv, { grid: g, traj: g.traj, labels: false, particles: { on: false }, aspect: 'fit' });
      clearLog(cv); W.draw(frame(g, { level: 99999, regime: (c) => (c.md0 >= 8200 ? 'stratified' : 'annular'), ag: () => 0.8 }));
      const latI = g.cells.find((c) => c.md0 >= 8500).i, cy = W.cellAt(latI)[1], cxl = W.cellAt(latI);
      const water = fills(cv).filter((f) => f.color === PH.water && f.pts.some((p) => Math.abs(p[0] - cxl[0]) < 20));
      assert.ok(water.length, 'water band on the lateral');
      water.forEach((f) => assert.ok(f.pts.reduce((s, p) => s + p[1], 0) / f.pts.length > cy, 'water below the centreline'));
      W.destroy();
      // segregated vertical cell: water at the deep end of the cell (larger screen y)
      g = buildGrid(a.win, 'vertical', 4); cv = canvas(a);
      W = V.wellbore(cv, { grid: g, traj: g.traj, labels: false, particles: { on: false } });
      clearLog(cv); W.draw(frame(g, { level: 99999, regime: () => 'segregated', ag: () => 0.5 }));
      const c1 = W.cellAt(1)[1], wb = fills(cv).filter((f) => f.color === PH.water);
      const inCell = wb.filter((f) => Math.abs(f.pts.reduce((s, p) => s + p[1], 0) / f.pts.length - c1) < 50);
      assert.ok(inCell.length, 'water band in cell 1');
      inCell.forEach((f) => assert.ok(f.pts.reduce((s, p) => s + p[1], 0) / f.pts.length > c1, 'water in the deep half'));
      W.destroy();
    },
  },
  {
    name: 'VW5 particles: deterministic (two views give identical logs, Math.random never called), bubbles rise with v_g > 0, a falling film moves down, scrubbing (dtWall 0) freezes them',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'S');
      const mk = () => { const cv = canvas(a); return { cv, W: V.wellbore(cv, { grid: g, traj: g.traj, particles: { on: true, max: 300 } }) }; };
      const A = mk(), B = mk();
      const rnd = a.win.Math.random; a.win.Math.random = () => { throw new Error('Math.random called'); };
      try {
        for (let k = 0; k < 5; k++) { clearLog(A.cv); clearLog(B.cv); const f = frame(g, { t: 3600 + k * 10, dtWall: 0.05 }); A.W.draw(f); B.W.draw(f); }
      } finally { a.win.Math.random = rnd; }
      assert.deepStrictEqual(log(A.cv), log(B.cv), 'identical drawing for identical frames');
      const n0 = arcs(A.cv).length;
      assert.ok(n0 > 20 && n0 <= 300, 'particles drawn within the budget (' + n0 + ')');
      // bubbles in a vertical liquid column rise (screen y decreases) between frames with v_g > 0
      const gv = buildGrid(a.win, 'vertical', 10), cv = canvas(a), W = V.wellbore(cv, { grid: gv, traj: gv.traj, labels: false, particles: { on: true, max: 300 } });
      const fr = (dt, vg, vl) => frame(gv, { level: 0, regime: () => 'bubble', ag: () => 0.3, vg, vl, dtWall: dt });
      clearLog(cv); W.draw(fr(0, 1, 0)); const y0 = arcs(cv).map((p) => p[1]);
      clearLog(cv); W.draw(fr(0.1, 1, 0)); const y1 = arcs(cv).map((p) => p[1]);
      assert.strictEqual(y0.length, y1.length);
      const moved = y0.map((y, i) => y1[i] - y).filter((d) => Math.abs(d) > 1e-6 && Math.abs(d) < 50);
      assert.ok(moved.length > y0.length / 2 && moved.every((d) => d < 0), 'bubbles move up');
      clearLog(cv); W.draw(fr(0, 1, 0)); assert.deepStrictEqual(arcs(cv).map((p) => p[1]), y1, 'dtWall 0 (scrub) keeps the particles still');
      // annular with a falling film (v_L < 0): the film ripples move down
      const fa = (dt) => frame(gv, { level: 99999, regime: () => 'annular', ag: () => 0.95, vg: 30, vl: -0.5, dtWall: dt });
      const ripY = () => log(cv).filter((e) => e.op === 'moveTo').map((e) => e.args[1]);
      clearLog(cv); W.draw(fa(0)); const r0 = ripY();
      clearLog(cv); W.draw(fa(0.1)); const r1 = ripY();
      const dr = r0.map((y, i) => r1[i] - y).filter((d) => Math.abs(d) > 1e-6 && Math.abs(d) < 40);
      assert.ok(dr.length && dr.filter((d) => d > 0).length > dr.length / 2, 'falling film moves down');
      [A.W, B.W, W].forEach((x) => x.destroy());
    },
  },
  {
    name: 'VW6 reduced motion and particles off: no particles, gas-velocity arrows instead (≥ 18 px apart); the particle budget max is kept',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'vertical', 60);
      [{ reduced: true }, { particles: { on: false } }].forEach((o) => {
        const cv = canvas(a), W = V.wellbore(cv, Object.assign({ grid: g, traj: g.traj, labels: false }, o));
        clearLog(cv); W.draw(frame(g));
        assert.strictEqual(arcs(cv).length, 0, 'no particles ' + JSON.stringify(o));
        const strokes = log(cv).filter((e) => e.op === 'stroke').length;
        assert.ok(strokes >= 5, 'arrows drawn (' + strokes + ')');
        W.destroy();
      });
      [50, 120].forEach((max) => {
        const cv = canvas(a), W = V.wellbore(cv, { grid: g, traj: g.traj, labels: false, particles: { on: true, max } });
        clearLog(cv); W.draw(frame(g));
        assert.ok(arcs(cv).length <= max, 'max ' + max + ': ' + arcs(cv).length);
        W.destroy();
      });
    },
  },
  {
    name: 'VW7 pick / hover / select: pick at a cell centre returns that cell, pointer hover → onHover(info), click → onSelect(i), arrow keys / Enter / Esc; readout lines in field and Metric',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'J'), cv = canvas(a);
      const seen = { hover: [], sel: [] };
      const W = V.wellbore(cv, { grid: g, traj: g.traj, particles: { on: false }, onHover: (x) => seen.hover.push(x), onSelect: (i, how) => seen.sel.push([i, how]) });
      W.draw(frame(g));
      [0, 10, 31, 59].forEach((i) => { const p = W.cellAt(i); assert.strictEqual(W.pick(p[0], p[1]).i, i, 'pick cell ' + i); });
      assert.strictEqual(W.pick(2, 470), null, 'far from the well → null');
      const p = W.cellAt(20);
      ev(a, cv, 'pointermove', { clientX: p[0], clientY: p[1] });
      const h = seen.hover[seen.hover.length - 1];
      assert.ok(h && h.i === 20, 'hover info for cell 20');
      ['md', 'tvd', 'p', 'T', 'ag', 'ao', 'aw', 'vg', 'vl', 'vc', 'ratio'].forEach((k) => assert.ok(Number.isFinite(h[k]), 'info.' + k));
      assert.strictEqual(h.regime, 'annular');
      ev(a, cv, 'pointerdown', { clientX: p[0], clientY: p[1] }); ev(a, cv, 'pointerup', { clientX: p[0], clientY: p[1] });
      assert.deepStrictEqual(plain(seen.sel[seen.sel.length - 1]), [20, 'click']);
      ev(a, cv, 'keydown', { key: 'ArrowUp' }); assert.strictEqual(seen.hover[seen.hover.length - 1].i, 21, 'ArrowUp = the next cell up');
      ev(a, cv, 'keydown', { key: 'ArrowDown' }); ev(a, cv, 'keydown', { key: 'ArrowDown' });
      assert.strictEqual(seen.hover[seen.hover.length - 1].i, 19);
      ev(a, cv, 'keydown', { key: 'Enter' }); assert.deepStrictEqual(plain(seen.sel[seen.sel.length - 1]), [19, 'key']);
      ev(a, cv, 'keydown', { key: 'Escape' }); assert.strictEqual(W.select(-1), -1);
      ev(a, cv, 'pointerleave', {}); assert.strictEqual(seen.hover[seen.hover.length - 1], null, 'leave clears the readout');
      const lf = W.infoLines(W.info(20)).join(' | ');
      assert.ok(/ft/.test(lf) && /psia/.test(lf) && /ft\/s/.test(lf) && /annular/.test(lf), 'field readout: ' + lf);
      W.destroy();
      const cv2 = canvas(a), W2 = V.wellbore(cv2, { grid: g, traj: g.traj, units: V.units('metric') }); W2.draw(frame(g));
      const lm = W2.infoLines(W2.info(20)).join(' | ');
      assert.ok(/ m\b/.test(lm) && /kPa/.test(lm) && /m\/s/.test(lm) && /°C/.test(lm) && !/psia|ft/.test(lm), 'Metric readout: ' + lm);
      const md = g.cells[20].mdc * 0.3048;
      assert.ok(lm.indexOf(Number(md).toLocaleString(undefined, { maximumFractionDigits: 0 })) !== -1, 'MD converted to m');
      W2.destroy();
    },
  },
  {
    name: 'VW8 zoom and navigator: setZoom shows only the window, wheel zooms only when focused or with Ctrl, drag pans, 0 resets; navigator window clamps, drags and emits onWindow',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'horizontal'), cv = canvas(a);
      const zooms = [];
      const W = V.wellbore(cv, { grid: g, traj: g.traj, particles: { on: false }, onZoom: (x, y) => zooms.push([x, y]) });
      W.draw(frame(g));
      assert.deepStrictEqual(plain(W.zoom()), [0, 10125]);
      W.setZoom(7000, 8500);
      assert.deepStrictEqual(plain(W.zoom()), [7000, 8500]); assert.deepStrictEqual(plain(zooms[zooms.length - 1]), [7000, 8500]);
      const L = W.layout();
      g.cells.forEach((c) => assert.strictEqual(L.cells[c.i].vis, c.md1 > 7000 && c.md0 < 8500, 'visibility of cell ' + c.i));
      // zoomed cells are drawn larger: the build section fills the panel
      const pA = W.cellAt(g.cells.find((c) => c.mdc > 7100 && c.mdc < 7300).i), pB = W.cellAt(g.cells.find((c) => c.mdc > 8200 && c.mdc < 8400).i);
      assert.ok(Math.hypot(pA[0] - pB[0], pA[1] - pB[1]) > 150, 'window spans the panel');
      // wheel without focus or Ctrl: ignored (the page scrolls)
      const n0 = zooms.length, p = W.cellAt(g.cells.find((c) => c.mdc > 7700 && c.mdc < 7900).i);
      ev(a, cv, 'wheel', { clientX: p[0], clientY: p[1], deltaY: -100 }); assert.strictEqual(zooms.length, n0, 'unfocused wheel ignored');
      ev(a, cv, 'wheel', { clientX: p[0], clientY: p[1], deltaY: -100, ctrlKey: true });
      const z = W.zoom(); assert.ok(z[1] - z[0] < 1500 && z[0] <= 7800 && z[1] >= 7800, 'Ctrl + wheel zooms in about the pointer: ' + z);
      // drag pans along MD
      const before = W.zoom(), nearest = (md) => g.cells.reduce((b, c) => (Math.abs(c.mdc - md) < Math.abs(b.mdc - md) ? c : b)).i;
      const q0 = W.cellAt(nearest(before[0] + 250)), q1 = W.cellAt(nearest(before[0] + 650));
      ev(a, cv, 'pointerdown', { clientX: q1[0], clientY: q1[1] }); ev(a, cv, 'pointermove', { clientX: q0[0], clientY: q0[1] }); ev(a, cv, 'pointerup', { clientX: q0[0], clientY: q0[1] });
      const after = W.zoom(); assert.ok(Math.abs(after[0] - before[0]) > 50, 'drag moved the window: ' + before + ' → ' + after);
      near(assert, after[1] - after[0], before[1] - before[0], 1, 'pan keeps the span');
      ev(a, cv, 'keydown', { key: '0' }); assert.deepStrictEqual(plain(W.zoom()), [0, 10125], '0 resets');
      W.destroy();
      // navigator
      const nv = canvas(a, 120, 480), wins = [];
      const N = V.navigator(nv, { grid: g, traj: g.traj, onWindow: (x, y) => wins.push([x, y]) });
      N.draw(frame(g));
      assert.deepStrictEqual(plain(N.setWindow(9500, 11000)), [8625, 10125], 'clamped to the well, span kept');
      assert.deepStrictEqual(plain(N.setWindow(-5, 99999)), [0, 10125], 'a window over the whole well = full');
      ev(a, nv, 'pointerdown', { clientX: 15, clientY: 240 }); ev(a, nv, 'pointerup', { clientX: 15, clientY: 240 });
      const w1 = wins[wins.length - 1]; assert.ok(w1 && w1[0] < 5062 && w1[1] > 5062 && w1[1] - w1[0] < 10125, 'click centres a window: ' + w1);
      ev(a, nv, 'pointerdown', { clientX: 15, clientY: 240 }); ev(a, nv, 'pointermove', { clientX: 15, clientY: 300 }); ev(a, nv, 'pointerup', { clientX: 15, clientY: 300 });
      const w2 = wins[wins.length - 1]; assert.ok(w2[0] > w1[0], 'drag moves the window down');
      ev(a, nv, 'keydown', { key: 'ArrowUp' }); assert.ok(wins[wins.length - 1][0] < w2[0], 'ArrowUp moves it up');
      ev(a, nv, 'keydown', { key: '0' }); assert.deepStrictEqual(plain(wins[wins.length - 1]), [0, 10125]);
      N.destroy();
    },
  },
  {
    name: 'VW9 cell close-up: annular film / droplets, slug Taylor bubble, falling-film arrow, readout lines (field and Metric), narrow layout puts the text below',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'vertical', 10), cv = canvas(a), W = V.wellbore(cv, { grid: g, traj: g.traj });
      W.draw(frame(g, { level: 99999, regime: () => 'annular', ag: () => 0.93, vl: -0.4 }));
      const info = W.info(5), cu = canvas(a, 420, 300);
      let out = V.closeUp(cu, info, {});
      assert.ok(out.lines.length >= 7 && /regime: annular/.test(out.lines[out.lines.length - 1]), 'readout');
      assert.ok(a.canvasTexts(cu).some((t) => t === 'v_L') && a.canvasTexts(cu).some((t) => t === 'v_g'), 'gas and liquid arrows');
      assert.ok(arcs(cu).length > 0, 'droplets');
      assert.ok(/aria-label/.test('aria-label') && /Cell close-up/.test(cu.getAttribute('aria-label')), 'aria text');
      // slug: a Taylor bubble (gas fill) in a liquid fill
      W.draw(frame(g, { level: 0, regime: () => 'slug', ag: () => 0.4 }));
      clearLog(cu); V.closeUp(cu, W.info(5), {});
      const fl = fills(cu).map((f) => f.color);
      assert.ok(fl.some((c) => /^rgba\(215,221,229,0\.92\)$/.test(c)), 'Taylor bubble');
      // Metric and narrow
      clearLog(cu); out = V.closeUp(cu, W.info(5), { units: V.units('metric'), w: 340, h: 360, fixed: true });
      assert.ok(/kPa/.test(out.lines.join(' ')) && /°C/.test(out.lines.join(' ')), 'Metric');
      const texts = log(cu).filter((e) => e.op === 'fillText' && /^MD /.test(e.args[0]));
      assert.ok(texts.length && texts[0].args[2] > 360 * 0.5, 'narrow: text below the picture');
      W.destroy();
    },
  },
  {
    name: 'VW10 chart specs on WTS_wp_view.chart: depth log (MD down, regime bands, interfaces, holdup on the top axis), trend (units, decimation, cursor scrub, marks), IPR / VLP with the live point, WHP vs rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'vertical', 40);
      // depth log
      const dl = canvas(a, 480, 420), fr = frame(g, { level: 7000, liquidTopMd: 7000, markers: [{ md: 9800, kind: 'eot', label: 'EOT' }] });
      V.depthLog(dl, fr, { grid: g });
      let sp = dl._wp.spec;
      assert.strictEqual(sp.y.invert, true); assert.ok(/MD \(ft\)/.test(sp.y.label));
      assert.deepStrictEqual(plain(sp.series.map((s) => s.key)), ['p', 'hl']); assert.strictEqual(sp.series[1].axis, 'x2');
      assert.ok(sp.hbands.length >= 3 && sp.hbands.some((b) => b.label === 'annular') && sp.hbands.some((b) => b.label === 'slug'), 'regime bands');
      assert.ok(sp.hlines.some((l) => l.label === 'liquid top' && Math.abs(l.y - 7000) < 1e-9) && sp.hlines.some((l) => l.label === 'EOT'), 'interfaces and markers');
      V.depthLog(dl, fr, { grid: g, track: 'velocity', units: V.units('metric') });
      sp = dl._wp.spec;
      assert.deepStrictEqual(plain(sp.series.map((s) => s.key)), ['vg', 'vc', 'vl', 'hl']);
      near(assert, sp.series[0].pts[sp.series[0].pts.length - 1][0], 25 * 0.3048, 1e-9, 'v_g in m/s (top cell)'); assert.ok(/m\/s/.test(sp.x.label) && /\(m\)/.test(sp.y.label));
      // trend: 3,000 samples decimated, Metric, cursor handle, marks
      const t = [], thp = [], qg = [], st = [];
      for (let i = 0; i < 3000; i++) { t.push(i * 10); thp.push(800 + 100 * Math.sin(i / 50)); qg.push(4000 + i); st.push(i < 1500 ? 0 : 4); }
      const R = rec({ t, thp, qg, state: st }), tc = canvas(a, 640, 220), scrub = [];
      V.trend(tc, R, { keys: ['thp'], cursor: 15000, marks: [{ t0: 3600, t1: 7200, label: 'test' }], onScrub: (x, ph) => scrub.push([x, ph]), maxPoints: 600 });
      sp = tc._wp.spec;
      assert.ok(sp.series[0].pts.length <= 600 && sp.series[0].pts.length > 100, 'decimated to ≤ 600: ' + sp.series[0].pts.length);
      near(assert, Math.max.apply(null, sp.series[0].pts.map((p) => p[1])), Math.max.apply(null, thp), 1e-9, 'peaks kept');
      assert.ok(/psig/.test(sp.series[0].label) && /time \(h\)/.test(sp.x.label));
      assert.strictEqual(sp.handles[0].kind, 'lineX'); near(assert, sp.handles[0].value, 15000 / 3600, 1e-12, 'cursor at t');
      assert.strictEqual(sp.bands.length, 1); near(assert, sp.bands[0].x0, 1, 1e-12, 'mark band in h');
      sp.onHandle('cursor', 2, 'end'); assert.deepStrictEqual(plain(scrub[0]), [7200, 'end'], 'scrub reports seconds');
      V.trend(tc, R, { keys: ['thp', 'pwf'], units: V.units('metric'), window: [0, 7200] });
      sp = tc._wp.spec;
      assert.ok(/kPa\(g\)/.test(sp.series[0].label), 'Metric psig → kPa(g)');
      near(assert, sp.series[0].pts[0][1], 800 * 6.89476, 1e-6, 'value converted');
      assert.ok(sp.series[0].pts.every((p) => p[0] <= 2 + 1e-12), 'window applied');
      assert.ok(sp.series[1].pts.length === 0 || sp.series[1].pts.every((p) => !Number.isFinite(p[1])), 'missing channel = no points');
      // nodal
      const nc = canvas(a, 520, 320);
      V.nodal(nc, { curves: { ipr: [{ q: 0, p: 3000 }, { q: 5000, p: 500 }], vlp: [{ q: 500, p: 2500 }, { q: 5000, p: 1500 }] }, op: { q: 3000, p: 1500 }, live: { q: 2500, p: 1700 },
        trail: [[1000, 2400], [2000, 1900], [2500, 1700]], gas: true });
      sp = nc._wp.spec;
      assert.deepStrictEqual(plain(sp.series.map((s) => s.key)), ['ipr', 'vlp', 'trail']);
      assert.ok(sp.markers.some((m) => m.label === 'steady' && m.kind === 'filled') && sp.markers.some((m) => m.label === 'now'), 'op and live point');
      assert.ok(/Mscf\/d/.test(sp.x.label) && /psia/.test(sp.y.label));
      // WHP vs rate
      const wc = canvas(a, 520, 320);
      V.whpRate(wc, R, { gas: true, cursor: 20000, op: { q: 5000, thp_psig: 820 } });
      sp = wc._wp.spec;
      assert.ok(sp.series[0].pts.length > 100 && sp.markers.length === 2, 'path, now and steady');
      near(assert, sp.markers[0].x, 4000 + 2000, 1e-9, 'now at the cursor sample');
    },
  },
  {
    name: 'VW11 state strip: segments from the state channel (indices into STATE_ORDER), state colours, labels where they fit, scrub by pointer, ARIA text',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view;
      const t = [], st = [];
      for (let i = 0; i <= 360; i++) { t.push(i * 60); st.push(i < 60 ? 1 : i < 200 ? 0 : i < 300 ? 3 : 4); }
      const cv = canvas(a, 640, 26), seen = [];
      const out = V.stateStrip(cv, rec({ t, state: st }), { cursor: 7200, marks: [{ t0: 600, t1: 1200 }], onScrub: (x, p) => seen.push([x, p]) });
      assert.deepStrictEqual(plain(out.segments.map((s) => s.key)), ['startup', 'stable', 'marginal', 'loading']);
      assert.strictEqual(out.segments[1].t0, 3600); assert.strictEqual(out.segments[1].t1, 12000);
      const cols = log(cv).filter((e) => e.op === 'set' && e.prop === 'fillStyle').map((e) => e.value);
      ['startup', 'stable', 'marginal', 'loading'].forEach((k) => assert.ok(cols.includes(V.STATE_COLORS[k]), 'colour ' + k));
      assert.ok(a.canvasTexts(cv).includes('Stable'), 'label drawn');
      ev(a, cv, 'pointerdown', { clientX: 320 }); ev(a, cv, 'pointerup', { clientX: 320 });
      near(assert, seen[seen.length - 1][0], 21600 * (318 / 636), 1, 'scrub time'); assert.strictEqual(seen[seen.length - 1][1], 'end');
      assert.ok(/Well states: .*Loading from 5:00:00/.test(cv.getAttribute('aria-label')), cv.getAttribute('aria-label'));
      const e = V.stateStrip(canvas(a, 640, 26), rec({ t: [] }), {}); assert.strictEqual(e.segments.length, 0, 'empty recorder');
    },
  },
  {
    name: 'VW12 hidden canvases draw at their fixed sizes (wellbore 360×480 CSS px, the report sizes), Metric labels on the depth axis follow the units layer',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'J');
      const cv = canvas(a, 360, 480, true), W = V.wellbore(cv, { grid: g, traj: g.traj });
      assert.strictEqual(cv.clientWidth, 0, 'hidden');
      clearLog(cv); W.draw(frame(g));
      const dpr = Math.min(2, Math.max(1, a.win.devicePixelRatio || 1));
      assert.strictEqual(cv.width, Math.round(360 * dpr)); assert.strictEqual(cv.height, Math.round(480 * dpr)); assert.strictEqual(cv.style.height, '480px');
      assert.ok(log(cv).length > 200, 'drawn while hidden');
      assert.ok(a.canvasTexts(cv).includes('TVD (ft)'), 'field axis label');
      W.destroy();
      const tc = canvas(a, 640, 220, true);
      V.trend(tc, rec({ t: [0, 10, 20], thp: [1, 2, 3] }), { keys: ['thp'], w: 640 });
      assert.strictEqual(tc.width, Math.round(640 * dpr), 'trend at its report width');
      // the units layer drives the default units
      const U = a.win.WTS_units, sys = U.getSystem();
      try {
        U.setSystem('metric');
        const cm = canvas(a, 360, 480), Wm = V.wellbore(cm, { grid: g, traj: g.traj, view: 'schematic' });
        Wm.draw(frame(g));
        assert.ok(a.canvasTexts(cm).includes('MD (m)'), 'Metric axis label');
        assert.ok(/m MD/.test(cm.getAttribute('aria-label') || '') || /m\b/.test(cm.getAttribute('aria-label') || ''), 'Metric ARIA text');
        assert.strictEqual(V.units().metric, true);
        Wm.destroy();
      } finally { U.setSystem(sys); }
      assert.strictEqual(V.units().metric, false);
      assert.ok(/^Wellbore at 1:00:00; /.test(V.describe(frame(g), g)), 'describe');
    },
  },
  {
    name: 'VW13 theme: STATE_COLORS and the wellbore panel follow the host CSS variables (--green, --bg2)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, root = a.document.documentElement;
      const old = { g: root.style.getPropertyValue('--green'), b: root.style.getPropertyValue('--bg2') };
      try {
        root.style.setProperty('--green', '#123456'); root.style.setProperty('--bg2', '#202122');
        V.stateColors();
        assert.strictEqual(V.STATE_COLORS.stable, '#123456'); assert.strictEqual(V.STATE_COLORS.esp_running, '#123456');
        const g = buildGrid(a.win, 'vertical', 10), cv = canvas(a), W = V.wellbore(cv, { grid: g, traj: g.traj });
        clearLog(cv); W.draw(frame(g));
        assert.ok(log(cv).some((e) => e.op === 'set' && e.prop === 'fillStyle' && e.value === '#202122'), 'panel colour from --bg2');
        W.destroy();
      } finally {
        if (old.g) root.style.setProperty('--green', old.g); else root.style.removeProperty('--green');
        if (old.b) root.style.setProperty('--bg2', old.b); else root.style.removeProperty('--bg2');
        V.stateColors();
      }
    },
  },
  {
    name: 'VW14 cost per frame: 60 cells and 300 particles on the S well ≤ 4,500 canvas operations per frame, Node time per frame reported, no timers, destroy removes the listeners',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const a = app(ctx), V = a.win.WTS_wd_view, g = buildGrid(a.win, 'S', 60), cv = canvas(a);
      const timers0 = a.pendingTimers();
      const W = V.wellbore(cv, { grid: g, traj: g.traj, particles: { on: true, max: 300 } });
      const fr = frame(g, { dtWall: 1 / 60 });
      W.draw(fr);
      const counts = [];
      const t0 = process.hrtime.bigint();
      for (let k = 0; k < 60; k++) { clearLog(cv); W.draw(fr); counts.push(log(cv).length); }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 60;
      const maxOps = Math.max.apply(null, counts);
      ctx.note && ctx.note('wellbore frame: ' + maxOps + ' recorded canvas operations, ' + ms.toFixed(2) + ' ms (Node, recording context)');
      if (process.env.WD_VIEW_REPORT) console.log('[VW14] ops/frame ' + maxOps + ', ms/frame ' + ms.toFixed(2) + ', V.ops ' + W.ops);
      assert.ok(maxOps <= 4500, 'operations per frame ' + maxOps);
      assert.ok(ms < 25, 'ms per frame in the recording harness: ' + ms.toFixed(2));
      assert.strictEqual(a.pendingTimers(), timers0, 'no timers');
      const nL = W.ls.length; assert.ok(nL >= 5, 'listeners bound');
      W.destroy(); assert.strictEqual(W.ls.length, 0, 'listeners removed');
      clearLog(cv); W.draw(fr); assert.strictEqual(log(cv).length, 0, 'a destroyed view does not draw');
    },
  },
];
