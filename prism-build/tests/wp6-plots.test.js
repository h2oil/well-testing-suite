// WP6 — Plots (02-plots.js): C6 data contract, invertible axes, MDH,
// formatting, decline units, periods, Pointer-Events interaction layer,
// ResizeObserver redraw and the 375 px layout.
'use strict';

const PI = 4200;

// ── helpers ──────────────────────────────────────────────────────────
function mkCanvas(app, w, h, style) {
  const c = app.document.createElement('canvas');
  if (w) c.setAttribute('width', String(w));
  if (h) c.setAttribute('height', String(h));
  if (style) c.style.cssText = style;
  app.document.body.appendChild(c);
  return c;
}

// Ops since the last canvas resize (each plot call resizes the canvas).
function frameOps(c) {
  const log = c._log || [];
  let k = -1;
  for (let i = log.length - 1; i >= 0; i--) if (log[i].op === 'resize') { k = i; break; }
  return log.slice(k + 1);
}

// Walk recorded 2D calls → painted paths with the colour in effect.
function paths(ops) {
  const stack = [];
  let st = { fill: null, stroke: null, dash: [] };
  const out = [];
  let cur = null;
  for (const e of ops) {
    if (e.op === 'save') stack.push(Object.assign({}, st, { dash: st.dash.slice() }));
    else if (e.op === 'restore') st = stack.pop() || st;
    else if (e.op === 'set' && e.prop === 'fillStyle') st.fill = e.value;
    else if (e.op === 'set' && e.prop === 'strokeStyle') st.stroke = e.value;
    else if (e.op === 'setLineDash') st.dash = (e.args[0] || []).slice();
    else if (e.op === 'beginPath') cur = { moves: [], lines: [], arcs: [] };
    else if (cur && e.op === 'moveTo') cur.moves.push(e.args);
    else if (cur && e.op === 'lineTo') cur.lines.push(e.args);
    else if (cur && e.op === 'arc') cur.arcs.push(e.args);
    else if (cur && (e.op === 'stroke' || e.op === 'fill')) {
      out.push({ kind: e.op, color: e.op === 'stroke' ? st.stroke : st.fill, dash: st.dash.slice(),
                 moves: cur.moves.slice(), lines: cur.lines.slice(), arcs: cur.arcs.slice() });
    }
  }
  return out;
}

function texts(ops) {
  return ops.filter((e) => e.op === 'fillText').map((e) => String(e.args[0]));
}

function sampleAData(app) {
  const ds = app.seedSample();
  const t = Array.from(ds.t);
  const p = Array.from(ds.p);
  const dp = p.map((v) => PI - v);                     // drawdown: Δp = pi − p (sign-aware)
  // L = 0.2 log-cycles: the sample is rounded to 0.1 psi, so a window smaller than the
  // point spacing (0.17) leaves ±4 % scatter; 0.2 gives the ±1.5 % a real analysis uses.
  const deriv = Array.from(app.win.PRiSM_compute_bourdet(app.toWin(t), app.toWin(dp), 0.2));
  return { t, p, dp, deriv };
}

function spyBourdet(app) {
  app.evalInApp(
    'window.__bourdetCalls = 0;' +
    'window.__bourdetOrig = window.PRiSM_compute_bourdet;' +
    'window.PRiSM_compute_bourdet = function (a, b, c) { window.__bourdetCalls++; return window.__bourdetOrig(a, b, c); };');
  return () => app.win.__bourdetCalls;
}

function ptr(app, c, type, x, y, o) {
  const ev = new app.win.PointerEvent(type, Object.assign({ clientX: x, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', button: 0 }, o || {}));
  c.dispatchEvent(ev);
}

function noErrors(app, assert) {
  assert.equal(app.errors.length, 0, 'no listener/timer errors: ' + app.errors.map((e) => e.message).join('; '));
}

function plotTimers(app) {
  return app.timers().filter((t) => /02-plots/.test(t.where || ''));
}

function lg(v) { return Math.log10(v); }

function bourdetCanvas(app, opts) {
  const s = sampleAData(app);
  const c = mkCanvas(app, 800, 450);
  app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }),
    app.toWin(Object.assign({ hover: true, dragZoom: true }, opts || {})));
  return { c, s };
}

// ── tests ────────────────────────────────────────────────────────────
module.exports = [
  {
    name: 'a. default-sample Bourdet: sign-aware Δp + deriv drawn as given (no recompute), plateau at 52.4 psi',
    wp: 'WP6',
    run(app, assert) {
      const s = sampleAData(app);
      const calls = spyBourdet(app);
      const c = mkCanvas(app, 800, 450);
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      assert.equal(calls(), 0, 'compute_bourdet never called when deriv is supplied');
      const ops = frameOps(c);
      const T = app.win.PRiSM_THEME;
      assert.ok(!texts(ops).some((x) => /No positive/.test(x)), 'no empty-state text');
      const P = paths(ops);
      const dpLine = P.find((p) => p.kind === 'stroke' && p.color === T.accent && p.lines.length > 10);
      assert.ok(dpLine, 'Δp line drawn in the accent colour');
      assert.ok(dpLine.lines.length >= 54, '≥ 54 Δp segments (got ' + dpLine.lines.length + ')');
      const ax = c._prismAxes;
      const markers = P.filter((p) => p.kind === 'fill' && p.color === T.green && p.arcs.length === 1)
        .map((p) => p.arcs[0]);
      assert.ok(markers.length >= 50, '≥ 50 derivative markers (got ' + markers.length + ')');
      // Late (t ≥ 10 h) markers sit within ±2 % of the 52.4 psi plateau.
      const late = markers.filter((m) => {
        const t = ax.fromX(m[0]);
        return t >= 10 && s.t.some((tt) => Math.abs(tt / t - 1) < 1e-6);
      });
      assert.ok(late.length >= 8, 'late markers found (' + late.length + ')');
      const yHi = ax.toY(52.4 * 1.02), yLo = ax.toY(52.4 * 0.98);
      late.forEach((m) => assert.within(m[1], yHi, yLo, 'late marker y within ±2 % of 52.4 psi'));
      // Δp is Δp: the first vertex is at Δp(t0) = 338.6 psi.
      assert.near(ax.fromY(dpLine.moves[0][1]), 338.6, 0.05);
      assert.equal(ax.result.derivGiven, true);
      noErrors(app, assert);
    },
  },
  {
    name: 'a2. overlay dp/deriv drawn as given; Δp fallback from p is sign-aware and warns once',
    wp: 'WP6',
    run(app, assert) {
      const s = sampleAData(app);
      const calls = spyBourdet(app);
      const c = mkCanvas(app, 800, 450);
      const ov = { t: s.t, dp: s.dp.map((v) => v * 1.01), deriv: s.deriv.map((v) => (isFinite(v) ? v * 1.01 : v)) };
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv, overlay: ov }), app.toWin({}));
      assert.equal(calls(), 0, 'no derivative recomputation for data or overlay');
      const T = app.win.PRiSM_THEME;
      const P = paths(frameOps(c));
      const blue = P.find((p) => p.kind === 'stroke' && p.color === T.blue && p.lines.length > 10);
      const cyan = P.find((p) => p.kind === 'stroke' && p.color === T.cyan && p.lines.length > 10);
      assert.ok(blue && cyan, 'model Δp (blue) and Δp′ (cyan) drawn');
      assert.near(c._prismAxes.fromY(blue.moves[0][1]), s.dp[0] * 1.01, 0.05, 'overlay.dp plotted as Δp');

      // Legacy caller: only p (drawdown), no dp → sign-aware Δp from p[0].
      const c2 = mkCanvas(app, 800, 450);
      const nWarn0 = app.logs.filter((l) => l.level === 'warn' && /data\.dp missing/.test(l.text)).length;
      app.win.PRiSM_plot_bourdet(c2, app.toWin({ t: s.t, p: s.p }), app.toWin({}));
      app.win.PRiSM_plot_bourdet(c2, app.toWin({ t: s.t, p: s.p }), app.toWin({}));
      const warns = app.logs.filter((l) => l.level === 'warn' && /data\.dp missing/.test(l.text)).length - nWarn0;
      assert.equal(warns, 1, 'fallback warning logged once per canvas');
      const ops2 = frameOps(c2);
      assert.ok(!texts(ops2).some((x) => /No positive/.test(x)), 'drawdown via p is not blank');
      assert.equal(c2._prismAxes.result.dpSource, 'p-fallback');
      // With pRef = pi the first Δp is 338.6 psi.
      const c3 = mkCanvas(app, 800, 450);
      app.win.PRiSM_plot_bourdet(c3, app.toWin({ t: s.t, p: s.p, pRef: PI }), app.toWin({}));
      const l3 = paths(frameOps(c3)).find((p) => p.kind === 'stroke' && p.color === T.accent && p.lines.length > 10);
      assert.near(c3._prismAxes.fromY(l3.moves[0][1]), 338.6, 0.05);
      noErrors(app, assert);
    },
  },
  {
    name: 'a3. empty state names the cause when no Δp is positive',
    wp: 'WP6',
    run(app, assert) {
      const c = mkCanvas(app, 600, 400);
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: [1, 2, 3, 4], dp: [-5, -4, -3, -2], deriv: [-1, -1, -1, -1] }), app.toWin({}));
      const tx = texts(frameOps(c));
      assert.ok(tx.includes('No positive Δp — check test type / pi on Tab 1'), 'message: ' + tx.join(' | '));
      assert.equal(c._prismAxes, null, 'no stale axes after an empty state');
    },
  },
  {
    name: 'b. format_eng / tick labels keep integer zeros (100, 120, 850)',
    wp: 'WP6',
    run(app, assert) {
      const f = app.win.PRiSM_plot_format_eng;
      assert.equal(f(100), '100');
      assert.equal(f(120), '120');
      assert.equal(f(850), '850');
      assert.equal(f(750), '750');
      assert.equal(f(1e5), '100k');
      assert.equal(f(0.0125), '0.0125');
      assert.equal(f(0.5), '0.5');
      assert.equal(f(1500), '1.5k');
      assert.equal(f(999950), '1M');
      assert.equal(f(2.5e-4), '2.5e-4');
      assert.equal(f(-100), '-100');
      const ft = app.win.PRiSM_plot_format_tick;
      assert.equal(ft(3400, false, 200), '3400');
      assert.equal(ft(1, false, 0.5), '1.0');
      assert.equal(ft(100, true), '100');
      assert.equal(ft(1000, true), '1k');
      // On a real axis: pressures 100..140 psia → labels 100 … 120 … 140.
      const c = mkCanvas(app, 800, 450);
      app.win.PRiSM_plot_cartesian(c, app.toWin({ t: [0, 1, 2, 3, 4], p: [100, 110, 120, 130, 140] }), app.toWin({}));
      const tx = texts(frameOps(c));
      ['100', '120', '140'].forEach((v) => assert.ok(tx.includes(v), 'tick "' + v + '" drawn'));
      assert.ok(!tx.includes('12') && !tx.includes('14'), 'no zero-stripped labels');
    },
  },
  {
    name: 'c. axes inverse: fromX(toX(v)) = v (1e-9) on log and linear axes; legacy flat keys present',
    wp: 'WP6',
    run(app, assert) {
      const { c } = bourdetCanvas(app);
      const ax = c._prismAxes;
      assert.fn(ax.fromX); assert.fn(ax.fromY);
      [0.013, 0.7, 12.5, 118].forEach((v) => {
        assert.rel(ax.fromX(ax.toX(v)), v, 1e-9);
        assert.rel(ax.fromY(ax.toY(v)), v, 1e-9);
      });
      assert.equal(ax.plotKey, 'bourdet');
      assert.equal(ax.xLog, true); assert.equal(ax.yLog, true);
      assert.equal(ax.x0, ax.plot.x); assert.equal(ax.x1, ax.plot.x + ax.plot.w);
      assert.equal(ax.y0, ax.plot.y); assert.equal(ax.y1, ax.plot.y + ax.plot.h);
      assert.equal(ax.dx0, ax.scaleX.min); assert.equal(ax.dy1, ax.scaleY.max);
      // Pixel ↔ data at the plot corners.
      assert.rel(ax.fromX(ax.plot.x), ax.scaleX.min, 1e-12);
      assert.rel(ax.fromY(ax.plot.y), ax.scaleY.max, 1e-12);

      const c2 = mkCanvas(app, 700, 400);
      app.win.PRiSM_plot_cartesian(c2, app.toWin({ t: [0, 10, 20], p: [4200, 3500, 3100] }), app.toWin({ plotKey: 'history' }));
      const a2 = c2._prismAxes;
      [0.5, 7.25, 19].forEach((v) => assert.near(a2.fromX(a2.toX(v)), v, 1e-9 * Math.max(1, v)));
      [3150.5, 3999].forEach((v) => assert.near(a2.fromY(a2.toY(v)), v, 1e-9 * v));
      assert.equal(a2.plotKey, 'history', 'opts.plotKey wins');
      assert.equal(a2.xLog, false);
    },
  },
  {
    name: 'd. Horner requires tp (message), draws p* from the line; decline Np in days = 30,000',
    wp: 'WP6',
    run(app, assert) {
      const c = mkCanvas(app, 700, 420);
      app.win.PRiSM_plot_horner(c, app.toWin({ t: [0.1, 1, 10], p: [3500, 3800, 3950] }), app.toWin({}));
      assert.ok(texts(frameOps(c)).includes('Set tp on Tab 1 → Well & Test'), 'tp-missing message');

      const dts = [0.01, 0.1, 1, 5, 10, 24, 48, 72];
      const tp = 24, m = -120.66, b = PI;
      const pws = dts.map((dt) => b + m * lg((tp + dt) / dt));
      app.win.PRiSM_plot_horner(c, app.toWin({ t: dts, p: pws, tp: tp, line: { m: m, b: b, x0: lg(2), x1: lg(25) } }), app.toWin({}));
      const tx = texts(frameOps(c));
      assert.ok(tx.includes('p* 4200.0 psia'), 'p* label: ' + tx.join(' | '));
      const ax = c._prismAxes;
      assert.ok(ax.scaleX.min <= 1, 'ratio 1 (p*) visible');
      assert.rel(ax.points[0][0], (tp + 0.01) / 0.01, 1e-12, 'Horner ratio from data.tp');

      const t = [], q = [];
      for (let i = 0; i <= 30; i++) { t.push(i); q.push(1000); }
      assert.near(app.win.PRiSM_plot_cumulative(app.toWin(t), app.toWin(q), 'd')[30], 30000, 1);
      assert.near(app.win.PRiSM_plot_cumulative(app.toWin(t.map((v) => v * 24)), app.toWin(q), 'h')[30], 30000, 1);
      const c2 = mkCanvas(app, 700, 420);
      app.win.PRiSM_plot_rate_cumulative(c2, app.toWin({ t: t, q: q }), app.toWin({ timeUnit: 'd' }));
      assert.near(c2._prismAxes.result.npLast, 30000, 1);
      assert.ok(texts(frameOps(c2)).includes('Cumulative, Np (STB)'));
      noErrors(app, assert);
    },
  },
  {
    name: 'e. periods given as {t0,t1} (and {start,end}) are shaded',
    wp: 'WP6',
    run(app, assert) {
      const t = [], p = [], q = [];
      for (let i = 0; i <= 48; i++) { t.push(i); p.push(i <= 24 ? 4200 - 20 * Math.sqrt(i) : 3800 + 5 * Math.sqrt(i - 24)); q.push(i <= 24 ? 850 : 0); }
      const fills = (c) => frameOps(c).filter((e) => e.op === 'fillRect').length;
      const c0 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_cartesian(c0, app.toWin({ t, p }), app.toWin({}));
      const base = fills(c0);
      const c1 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_cartesian(c1, app.toWin({ t, p, periods: [{ t0: 0, t1: 24, q: 850 }, { t0: 24, t1: 48, q: 0 }] }), app.toWin({ activePeriod: 1 }));
      assert.ok(fills(c1) >= base + 2, 'two period bands shaded ({t0,t1}): ' + fills(c1) + ' vs ' + base);
      const c2 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_cartesian(c2, app.toWin({ t, p, periods: [{ start: 0, end: 24 }, { start: 24, end: 48 }] }), app.toWin({}));
      assert.ok(fills(c2) >= base + 2, 'two period bands shaded ({start,end})');
      assert.ok(texts(frameOps(c1)).includes('Analysed period'), 'active period labelled');
      // Rate history on the secondary axis.
      const c3 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_cartesian(c3, app.toWin({ t, p, q }), app.toWin({}));
      assert.ok(c3._prismAxes.toY2 && c3._prismAxes.scaleY2.max >= 850, 'rate axis present');
      assert.ok(texts(frameOps(c3)).includes('Rate, q (STB/d)'));
      // The shut-in drop sits at t = 24 h (last flowing sample), on the period boundary.
      const a3 = c3._prismAxes;
      const rate = paths(frameOps(c3)).find((pp) => pp.kind === 'stroke' && pp.color === 'rgba(57,197,207,0.75)');
      assert.ok(rate, 'rate step line drawn');
      const firstZero = rate.lines.find((l) => Math.abs(l[1] - a3.toY2(0)) < 1e-6);
      assert.near(a3.fromX(firstZero[0]), 24, 1e-9, 'rate drops at the last flowing sample');
    },
  },
  {
    name: 'f. MDH plot exported; line p = b + m·log10(Δt) with p1hr label',
    wp: 'WP6',
    run(app, assert) {
      assert.fn(app.win.PRiSM_plot_mdh);
      const s = sampleAData(app);
      const c = mkCanvas(app, 800, 450);
      const line = { m: -120.66, b: 3340.9, t0: 10, t1: 120 };
      app.win.PRiSM_plot_mdh(c, app.toWin({ t: s.t, p: s.p, line: line }), app.toWin({ hover: true, dragZoom: true }));
      const ops = frameOps(c);
      assert.ok(texts(ops).includes('p1hr 3340.9 psia'), 'p1hr label');
      const ax = c._prismAxes;
      assert.equal(ax.plotKey, 'mdh');
      assert.equal(ax.xLog, true); assert.equal(ax.yLog, false);
      const dashed = paths(ops).find((p) => p.kind === 'stroke' && p.color === 'rgba(88,166,255,0.75)');
      assert.ok(dashed, 'extended semilog line drawn');
      const pmin = line.b + line.m * lg(ax.scaleX.min);
      assert.near(ax.fromY(dashed.moves[0][1]), pmin, 1e-6 * Math.abs(pmin));
      const solid = paths(ops).find((p) => p.kind === 'stroke' && p.color === app.win.PRiSM_THEME.blue && p.lines.length === 1);
      assert.ok(solid, 'fitted window drawn solid');
      assert.rel(ax.fromX(solid.moves[0][0]), 10, 1e-9);
      assert.rel(ax.fromX(solid.lines[0][0]), 120, 1e-9);
    },
  },
  {
    name: 'g. superposition: shut-in normalised by last non-zero rate (= Horner); flowing multi-rate; legacy q with trailing 0',
    wp: 'WP6',
    run(app, assert) {
      const dts = [0.01, 0.1, 1, 10, 72];
      const p = dts.map((d) => 4000 + 50 * lg(d));
      const c = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_buildup_superposition(c, app.toWin({
        t: dts, p: p, tStart: 24, periods: [{ t0: 0, t1: 24, q: 850 }, { t0: 24, t1: 96, q: 0 }],
      }), app.toWin({}));
      const ax = c._prismAxes;
      assert.equal(ax.result.shutIn, true);
      assert.equal(ax.result.qRef, 850);
      ax.points.forEach((pt, i) => assert.near(pt[0], lg((24 + dts[i]) / dts[i]), 1e-12));
      assert.ok(ax.scaleX.min <= 0, 'p* abscissa X = 0 in view');

      // Two-rate flowing period: X = ½·log(10+Δt) + ½·log(Δt)
      const c2 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_buildup_superposition(c2, app.toWin({
        t: dts, p: p, tStart: 10, rateHistory: [{ t: 0, q: 500 }, { t: 10, q: 1000 }],
      }), app.toWin({}));
      const a2 = c2._prismAxes;
      assert.equal(a2.result.shutIn, false);
      a2.points.forEach((pt, i) => assert.near(pt[0], 0.5 * lg(10 + dts[i]) + 0.5 * lg(dts[i]), 1e-12));

      // Legacy {t absolute, p, q} with q = 0 after 24 h: no q=0 blow-up.
      const tAbs = [], pa = [], qa = [];
      for (let i = 0; i <= 24; i++) { tAbs.push(i); pa.push(3900 - i); qa.push(850); }
      [24.5, 25, 30, 48].forEach((tt) => { tAbs.push(tt); pa.push(3900 + 10 * lg(tt - 24)); qa.push(0); });
      const c3 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_buildup_superposition(c3, app.toWin({ t: tAbs, p: pa, q: qa }), app.toWin({}));
      const a3 = c3._prismAxes;
      assert.equal(a3.result.qRef, 850);
      assert.equal(a3.points.length, 4);
      a3.points.forEach((pt, i) => {
        const d = [0.5, 1, 6, 24][i];
        assert.near(pt[0], lg((24 + d) / d), 1e-9);
      });
      // Without rates or tp → message.
      const c4 = mkCanvas(app, 600, 400);
      app.win.PRiSM_plot_buildup_superposition(c4, app.toWin({ t: dts, p: p, tStart: 24 }), app.toWin({}));
      assert.ok(texts(frameOps(c4)).some((x) => /Set tp on Tab 1/.test(x)));
      // helper export agrees
      const sx = app.win.PRiSM_plot_superposition_x(app.toWin([1]), app.toWin([{ t: 0, q: 850 }, { t: 24, q: 0 }]), 24);
      assert.near(sx.x[0], lg(25), 1e-12);
    },
  },
  {
    name: 'h. material-balance time relabelled; shut-in (q = 0) points dropped with a message',
    wp: 'WP6',
    run(app, assert) {
      const t = [1, 2, 3, 4, 5, 6], p = [3900, 3880, 3870, 3950, 3990, 4010], q = [850, 850, 850, 0, 0, 0];
      const c = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_sandface_convolution(c, app.toWin({ t, p, q }), app.toWin({}));
      const tx = texts(frameOps(c));
      assert.ok(tx.includes('Material-balance time Σq·Δt/q_n (hr)'), 'x label');
      assert.ok(tx.some((x) => /3 shut-in points/.test(x)), 'skipped note');
      const ax = c._prismAxes;
      assert.equal(ax.points.length, 3);
      ax.points.forEach((pt, i) => assert.near(pt[0], t[i], 1e-12)); // constant rate → te = t
      const c2 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_sandface_convolution(c2, app.toWin({ t, p, q: [0, 0, 0, 0, 0, 0] }), app.toWin({}));
      assert.ok(texts(frameOps(c2)).some((x) => /undefined while q = 0/.test(x)));
    },
  },
  {
    name: 'i. decline plots: time-unit labels; EUR tangent only on request (LS over last 30 %)',
    wp: 'WP6',
    run(app, assert) {
      const t = [], q = [];
      for (let i = 0; i <= 300; i++) { t.push(i); q.push(1000 * Math.exp(-0.01 * i)); }
      const c = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_rate_time_cartesian(c, app.toWin({ t, q }), app.toWin({}));
      assert.ok(texts(frameOps(c)).includes('Time, t (days)'));
      app.win.PRiSM_plot_rate_time_semilog(c, app.toWin({ t: t.map((v) => v * 24), q }), app.toWin({ timeUnit: 'h' }));
      assert.ok(texts(frameOps(c)).includes('Time, t (hr)'));
      app.win.PRiSM_plot_loss_ratio(c, app.toWin({ t, q }), app.toWin({ timeUnit: 'd' }));
      assert.ok(texts(frameOps(c)).some((x) => /^Loss ratio .*\(days\)$/.test(x)));

      const c2 = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_rate_cumulative(c2, app.toWin({ t, q }), app.toWin({}));
      assert.equal(c2._prismAxes.result.eur, null, 'no EUR by default');
      assert.ok(!texts(frameOps(c2)).some((x) => /EUR/.test(x)));
      app.win.PRiSM_plot_rate_cumulative(c2, app.toWin({ t, q }), app.toWin({ showTangentEUR: true }));
      const eur = c2._prismAxes.result.eur;
      assert.rel(eur, 1000 / 0.01, 0.005, 'exponential EUR = qi/D');
      assert.ok(texts(frameOps(c2)).some((x) => /^EUR ≈ 100k STB$/.test(x)), texts(frameOps(c2)).join('|'));
      assert.ok(c2._prismAxes.scaleX.max >= eur, 'EUR inside the view');
      // Gas units
      app.win.PRiSM_plot_rate_cumulative(c2, app.toWin({ t, q }), app.toWin({ rateUnit: 'Mscf/d' }));
      assert.ok(texts(frameOps(c2)).includes('Cumulative, Gp (Mscf)'));
    },
  },
  {
    name: 'j. listeners installed once per canvas (no per-draw leaks); touch-action follows dragZoom',
    wp: 'WP6',
    run(app, assert) {
      const s = sampleAData(app);
      const c = mkCanvas(app, 800, 450);
      const winMoves0 = ((app.win.__listeners && app.win.__listeners.get('pointermove')) || []).length;
      for (let i = 0; i < 5; i++) {
        app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      }
      app.win.PRiSM_plot_mdh(c, app.toWin({ t: s.t, p: s.p }), app.toWin({ hover: true, dragZoom: true }));
      ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'wheel'].forEach((type) => {
        assert.equal(c.__listeners.get(type).length, 1, 'exactly one ' + type + ' listener');
      });
      const winMoves1 = ((app.win.__listeners && app.win.__listeners.get('pointermove')) || []).length;
      assert.equal(winMoves1, winMoves0, 'no window listeners added');
      assert.equal(c.style.touchAction, 'none');
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ dragZoom: false }));
      assert.notEqual(c.style.touchAction, 'none', 'touch-action restored when pan/zoom is off');
      // A canvas drawn without interaction gets no listeners at all.
      const c2 = mkCanvas(app, 400, 300);
      app.win.PRiSM_plot_bourdet(c2, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({}));
      assert.ok(!c2.__listeners || !c2.__listeners.get('pointerdown') || !c2.__listeners.get('pointerdown').length);
    },
  },
  {
    name: 'k. mouse: box zoom maps pixels through fromX/fromY; view persists on redraw of same data; dblclick resets',
    wp: 'WP6',
    run(app, assert) {
      const { c, s } = bourdetCanvas(app);
      const a0 = c._prismAxes;
      const x0 = a0.plot.x + 100, x1 = a0.plot.x + 300, y0 = a0.plot.y + 50, y1 = a0.plot.y + 200;
      const want = { xmin: a0.fromX(x0), xmax: a0.fromX(x1), ymin: a0.fromY(y1), ymax: a0.fromY(y0) };
      let events = 0;
      c.addEventListener('prism:plot-view-changed', () => { events++; });
      ptr(app, c, 'pointerdown', x0, y0);
      ptr(app, c, 'pointermove', (x0 + x1) / 2, (y0 + y1) / 2);
      ptr(app, c, 'pointermove', x1, y1);
      ptr(app, c, 'pointerup', x1, y1);
      const a1 = c._prismAxes;
      assert.rel(a1.scaleX.min, want.xmin, 1e-9); assert.rel(a1.scaleX.max, want.xmax, 1e-9);
      assert.rel(a1.scaleY.min, want.ymin, 1e-9); assert.rel(a1.scaleY.max, want.ymax, 1e-9);
      assert.ok(a1.userView, 'user view recorded');
      assert.equal(events, 1, 'prism:plot-view-changed fired');
      assert.deepEqual(JSON.parse(JSON.stringify(c._prismOriginalScale.x)).min, a0.scaleX.min, 'original scale kept');
      // Same data redrawn (e.g. overlay toggled) → zoom kept.
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      assert.rel(c._prismAxes.scaleX.min, want.xmin, 1e-9, 'view persisted');
      // New data → autoscale.
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp.map((v) => v * 2), deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      assert.equal(c._prismAxes.userView, null, 'new data resets the view');
      // Zoom again then "Reset view" the Tab-2 way (delete _prismAxes + redraw).
      ptr(app, c, 'pointerdown', x0, y0); ptr(app, c, 'pointermove', x1, y1); ptr(app, c, 'pointerup', x1, y1);
      assert.ok(c._prismAxes.userView);
      delete c._prismAxes;
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp.map((v) => v * 2), deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      assert.equal(c._prismAxes.userView, null, 'deleting _prismAxes resets');
      // dblclick → reset.
      ptr(app, c, 'pointerdown', x0, y0); ptr(app, c, 'pointermove', x1, y1); ptr(app, c, 'pointerup', x1, y1);
      const auto = c._prismAxes.autoScale;
      c.dispatchEvent(new app.win.MouseEvent('dblclick', { clientX: x0, clientY: y0, bubbles: true }));
      assert.equal(c._prismAxes.userView, null);
      assert.equal(c._prismAxes.scaleX.min, auto.x.min);
      // Tiny drag (a click) does not zoom.
      const before = c._prismAxes.scaleX.min;
      ptr(app, c, 'pointerdown', x0, y0); ptr(app, c, 'pointermove', x0 + 2, y0 + 2); ptr(app, c, 'pointerup', x0 + 2, y0 + 2);
      assert.equal(c._prismAxes.scaleX.min, before);
      noErrors(app, assert);
    },
  },
  {
    name: 'l. touch: one-finger pan, two-finger pinch, long-press resets; no plot timers left',
    wp: 'WP6',
    run(app, assert) {
      const { c } = bourdetCanvas(app);
      const a0 = c._prismAxes;
      const cx = a0.plot.x + a0.plot.w / 2, cy = a0.plot.y + a0.plot.h / 2;
      const span = (s) => [lg(s.max) - lg(s.min)];
      const sx0 = span(a0.scaleX)[0], sy0 = span(a0.scaleY)[0];
      const T = { pointerType: 'touch' };
      // Pan 40 px right, 20 px down: content follows the finger.
      ptr(app, c, 'pointerdown', cx, cy, T);
      ptr(app, c, 'pointermove', cx + 40, cy + 20, T);
      app.flush(20);
      ptr(app, c, 'pointerup', cx + 40, cy + 20, T);
      const a1 = c._prismAxes;
      assert.near(lg(a1.scaleX.min), lg(a0.scaleX.min) - 40 / a0.plot.w * sx0, 1e-9);
      assert.near(lg(a1.scaleY.min), lg(a0.scaleY.min) + 20 / a0.plot.h * sy0, 1e-9);
      assert.ok(a1.userView);
      // Pinch: fingers move apart 2× → spans halve.
      const b0 = { x: span(a1.scaleX)[0], y: span(a1.scaleY)[0] };
      ptr(app, c, 'pointerdown', cx - 40, cy - 30, { pointerType: 'touch', pointerId: 11 });
      ptr(app, c, 'pointerdown', cx + 40, cy + 30, { pointerType: 'touch', pointerId: 12 });
      ptr(app, c, 'pointermove', cx + 120, cy + 90, { pointerType: 'touch', pointerId: 12 });
      app.flush(20);
      ptr(app, c, 'pointerup', cx + 120, cy + 90, { pointerType: 'touch', pointerId: 12 });
      ptr(app, c, 'pointerup', cx - 40, cy - 30, { pointerType: 'touch', pointerId: 11 });
      const a2 = c._prismAxes;
      assert.rel(span(a2.scaleX)[0], b0.x * 0.5, 1e-9, 'x span halved');
      assert.rel(span(a2.scaleY)[0], b0.y * 0.5, 1e-9, 'y span halved');
      // Long-press (600 ms, no movement) → reset to the autoscale.
      ptr(app, c, 'pointerdown', cx, cy, { pointerType: 'touch', pointerId: 21 });
      app.flush(700);
      assert.equal(c._prismAxes.userView, null, 'long-press reset the view');
      assert.equal(c._prismAxes.scaleX.min, a0.scaleX.min);
      ptr(app, c, 'pointerup', cx, cy, { pointerType: 'touch', pointerId: 21 });
      // A short tap shows the nearest-point read-out (no zoom change).
      const t10 = a0.toX(10);
      ptr(app, c, 'pointerdown', t10, cy, { pointerType: 'touch', pointerId: 31 });
      app.flush(100);
      ptr(app, c, 'pointerup', t10, cy, { pointerType: 'touch', pointerId: 31 });
      assert.equal(c._prismAxes.userView, null);
      assert.equal(plotTimers(app).length, 0, 'no 02-plots timers pending');
      noErrors(app, assert);
    },
  },
  {
    name: 'm. Ctrl+wheel zoom about the cursor; hover read-out uses the cached frame',
    wp: 'WP6',
    run(app, assert) {
      const { c } = bourdetCanvas(app);
      const a0 = c._prismAxes;
      const cx = a0.plot.x + a0.plot.w / 2, cy = a0.plot.y + a0.plot.h / 2;
      const plain = new app.win.WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: -100, bubbles: true, cancelable: true });
      c.dispatchEvent(plain);
      assert.equal(c._prismAxes.userView, null, 'plain wheel leaves the page to scroll');
      const ev = new app.win.WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true);
      const a1 = c._prismAxes;
      const f = Math.exp(-0.5);
      assert.rel(lg(a1.scaleX.max) - lg(a1.scaleX.min), (lg(a0.scaleX.max) - lg(a0.scaleX.min)) * f, 1e-9);
      assert.rel(a1.fromX(cx), a0.fromX(cx), 1e-9, 'point under the cursor is fixed');
      // Hover
      const n0 = c._log.length;
      const tx = a1.toX(10.08), ty = a1.toY(52.4);
      ptr(app, c, 'pointermove', tx, ty);
      const hoverOps = c._log.slice(n0);
      assert.ok(hoverOps.some((e) => e.op === 'drawImage'), 'restores the cached frame');
      assert.ok(hoverOps.some((e) => e.op === 'fillText' && /^Δt .* · Δp/.test(String(e.args[0]))), 'read-out text');
      assert.ok(!hoverOps.some((e) => e.op === 'resize'), 'hover does not re-run setup');
      noErrors(app, assert);
    },
  },
  {
    name: 'm2. a click does not repaint over marks drawn by other layers; next hover re-caches; touch long-press menu suppressed',
    wp: 'WP6',
    run(app, assert) {
      const { c } = bourdetCanvas(app);
      const ax = c._prismAxes;
      const tx = ax.toX(10.08), ty = ax.toY(52.4);
      ptr(app, c, 'pointermove', tx, ty);                         // hover → frame cached
      const firstSnap = c._log.filter((e) => e.op === 'drawImage').pop().args[0];
      // Another layer (e.g. an armed analysis key) draws on mousedown.
      c.addEventListener('pointerdown', () => { c.getContext('2d').fillRect(1, 2, 3, 4); });
      const n0 = c._log.length;
      ptr(app, c, 'pointerdown', tx, ty);
      ptr(app, c, 'pointerup', tx, ty);
      const clickOps = c._log.slice(n0);
      const mark = clickOps.findIndex((e) => e.op === 'fillRect' && e.args[0] === 1 && e.args[3] === 4);
      assert.ok(mark !== -1, 'external mark drawn');
      assert.ok(!clickOps.slice(mark + 1).some((e) => e.op === 'drawImage' || e.op === 'fillRect'), 'nothing painted over it');
      ptr(app, c, 'pointermove', tx + 1, ty);
      const secondSnap = c._log.filter((e) => e.op === 'drawImage').pop().args[0];
      assert.notEqual(secondSnap, firstSnap, 'fresh cached frame after the click');
      // contextmenu during a touch press on an interactive plot is suppressed
      ptr(app, c, 'pointerdown', tx, ty, { pointerType: 'touch', pointerId: 7 });
      const cm = new app.win.MouseEvent('contextmenu', { clientX: tx, clientY: ty, bubbles: true, cancelable: true });
      c.dispatchEvent(cm);
      assert.equal(cm.defaultPrevented, true);
      ptr(app, c, 'pointerup', tx, ty, { pointerType: 'touch', pointerId: 7 });
      const cm2 = new app.win.MouseEvent('contextmenu', { clientX: tx, clientY: ty, bubbles: true, cancelable: true });
      c.dispatchEvent(cm2);
      assert.equal(cm2.defaultPrevented, false, 'mouse right-click menu untouched');
      noErrors(app, assert);
    },
  },
  {
    name: 'n. post-draw hooks run on internal repaints only (plotKey given), with the reason',
    wp: 'WP6',
    run(app, assert) {
      app.evalInApp("window.__hookReasons = []; (window.PRiSM_postDrawHooks = window.PRiSM_postDrawHooks || [])" +
        ".push(function (info) { if (info && info.canvas && info.canvas.id === 'wp6hook') window.__hookReasons.push(info.reason + ':' + info.plotKey + ':' + !!info.axes); });");
      const s = sampleAData(app);
      const c = mkCanvas(app, 800, 450);
      c.id = 'wp6hook';
      const draw = (o) => {
        const fn = o && o.postDraw;
        const w = app.toWin(Object.assign({ hover: true, dragZoom: true }, o, { postDraw: undefined }));
        if (fn) w.postDraw = fn;              // functions do not survive toWin (JSON)
        app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), w);
      };
      draw({ plotKey: 'bourdet' });
      assert.deepEqual(Array.from(app.win.__hookReasons), [], 'initial draw leaves hooks to drawActivePlot');
      const a = c._prismAxes;
      const wheel = () => c.dispatchEvent(new app.win.WheelEvent('wheel', { clientX: a.plot.x + 50, clientY: a.plot.y + 50, deltaY: 50, ctrlKey: true, cancelable: true }));
      wheel();
      c.dispatchEvent(new app.win.MouseEvent('dblclick', { clientX: a.plot.x + 50, clientY: a.plot.y + 50 }));
      assert.deepEqual(Array.from(app.win.__hookReasons), ['view:bourdet:true', 'reset:bourdet:true']);
      draw({ plotKey: 'bourdet', postDrawHooks: false }); wheel();
      draw({}); wheel();
      assert.equal(app.win.__hookReasons.length, 2, 'suppressed without plotKey / with postDrawHooks:false');
      app.evalInApp('window.__pd = 0;');
      draw({ postDraw: app.evalInApp('(function () { window.__pd++; })') }); wheel();
      assert.equal(app.win.__pd, 1, 'opts.postDraw called on repaint');
      noErrors(app, assert);
    },
  },
  {
    name: 'o. ResizeObserver: responsive canvas redraws at the new width, keeps the view, one observer per canvas',
    wp: 'WP6',
    opts: { viewport: { width: 1280, height: 800 } },
    run(app, assert) {
      app.evalInApp("window.__ro = []; window.ResizeObserver = function (cb) { var o = { cb: cb, targets: [], " +
        "observe: function (t) { this.targets.push(t); }, unobserve: function () {}, disconnect: function () {} }; " +
        "window.__ro.push(o); return o; };");
      const s = sampleAData(app);
      const c = mkCanvas(app, 0, 0, 'width:100%; height:320px');
      const draw = () => app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true }));
      draw(); draw(); draw();
      assert.equal(app.win.__ro.length, 1, 'one observer');
      assert.equal(app.win.__ro[0].targets[0], c);
      assert.equal(c.style.width, '100%', 'relative width left to CSS');
      assert.equal(c.style.height, '320px');
      assert.equal(c.width, 900);
      // zoom, then the container shrinks to 500 px
      const a0 = c._prismAxes;
      c.dispatchEvent(new app.win.WheelEvent('wheel', { clientX: a0.plot.x + 60, clientY: a0.plot.y + 60, deltaY: -60, ctrlKey: true, cancelable: true }));
      const view = c._prismAxes.userView;
      assert.ok(view);
      const n0 = c._log.length;
      app.win.__ro[0].cb(app.toWin([{ contentRect: { width: 900, height: 320 } }]));
      app.flush(20);
      assert.equal(c._log.length, n0, 'same size → no redraw');
      app.resize(420, 800);
      app.win.__ro[0].cb([{ target: c, contentRect: { width: 420, height: 320 } }]);
      app.flush(20);
      assert.equal(c.width, 420);
      assert.equal(c._prismAxes.plot.cssW, 420);
      assert.rel(c._prismAxes.scaleX.min, view.x.min, 1e-12, 'zoom survives the resize');
      assert.equal(c._prismAxes.plot.x, 52, 'compact padding below 480 px');
      // devicePixelRatio change with an unchanged CSS box → backing store rebuilt.
      app.evalInApp('window.devicePixelRatio = 2;');
      app.win.__ro[0].cb([{ target: c, contentRect: { width: 420, height: 320 } }]);
      app.flush(20);
      assert.equal(c.width, 840, 'dpr change re-renders at 2×');
      app.evalInApp('window.devicePixelRatio = 1;');
      const a3 = c._prismAxes;
      ptr(app, c, 'pointerdown', a3.plot.x + 20, a3.plot.y + 20);   // next interaction also catches it
      ptr(app, c, 'pointerup', a3.plot.x + 20, a3.plot.y + 20);
      assert.equal(c.width, 420);
    },
  },
  {
    name: 'o2. pinned / offscreen canvases get no observer; hidden redraw keeps the last size',
    wp: 'WP6',
    run(app, assert) {
      app.evalInApp("window.__ro = []; window.ResizeObserver = function (cb) { var o = { observe: function () {}, disconnect: function () {} }; window.__ro.push(o); return o; };");
      const s = sampleAData(app);
      const c = mkCanvas(app, 640, 360);
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true }));
      assert.equal(c.style.width, '640px');
      const off = app.document.createElement('canvas');
      app.win.PRiSM_plot_bourdet(off, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ width: 1200, height: 800 }));
      assert.equal(off.width, 1200);
      assert.equal(app.win.__ro.length, 0);
      // Hidden responsive canvas: draws at its last known size, not a doubled backing size.
      app.evalInApp('window.devicePixelRatio = 2;');
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      const r = app.document.createElement('canvas');
      r.style.cssText = 'width:100%; height:300px';
      host.appendChild(r);
      app.win.PRiSM_plot_bourdet(r, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({}));
      assert.equal(r.width, 1800);
      host.style.display = 'none';
      app.win.PRiSM_plot_bourdet(r, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({}));
      assert.equal(r.width, 1800, 'no dpr growth while hidden');
      assert.equal(r._prismAxes.plot.cssW, 900);
    },
  },
  {
    name: 'p. 375 px phone: compact padding, usable plot area, titles bounded',
    wp: 'WP6',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const s = sampleAData(app);
      const c = mkCanvas(app, 0, 0, 'width:100%; height:280px');
      app.win.PRiSM_plot_bourdet(c, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({ hover: true, dragZoom: true, title: 'A very long plot title that would not fit on a phone screen at all' }));
      const ax = c._prismAxes;
      assert.equal(ax.plot.cssW, 375);
      assert.ok(ax.plot.x <= 52 && ax.plot.x + ax.plot.w <= 375 - 12, 'compact padding');
      assert.ok(ax.plot.w >= 300, 'plot width ≥ 300 px (got ' + ax.plot.w + ')');
      const title = frameOps(c).find((e) => e.op === 'fillText' && /very long plot title/.test(e.args[0]));
      assert.ok(title && title.args[3] > 0 && title.args[1] + title.args[3] <= 375, 'title maxWidth bounded');
      const labels = frameOps(c).filter((e) => e.op === 'fillText' && e.args.length >= 4);
      labels.forEach((e) => assert.ok(e.args[3] <= 375));
      assert.equal(c.style.touchAction, 'none', 'drag/zoom by touch enabled');
    },
  },
  {
    name: 'q. theme follows the host CSS variables; exports on window',
    wp: 'WP6',
    run(app, assert) {
      const c = mkCanvas(app, 400, 300);
      app.win.PRiSM_plot_cartesian(c, app.toWin({ t: [0, 1], p: [1, 2] }), app.toWin({}));
      const T = app.win.PRiSM_THEME;
      assert.equal(T.bg, '#0d1117');
      assert.equal(T.text, '#e6edf3', '--text applied');
      assert.equal(T.accent, '#f0883e');
      ['PRiSM_compute_bourdet', 'PRiSM_plot_mdh', 'PRiSM_plot_bourdet', 'PRiSM_plot_cartesian', 'PRiSM_plot_horner',
        'PRiSM_plot_buildup_superposition', 'PRiSM_plot_rate_cumulative', 'PRiSM_plot_format_eng', 'PRiSM_plot_setup',
        'PRiSM_plot_message', 'PRiSM_plotResetView', 'PRiSM_plotSetView', 'PRiSM_plotGetView', 'PRiSM_plot_cumulative']
        .forEach((k) => assert.fn(app.win[k], k));
      // Programmatic view API
      const s = sampleAData(app);
      const c2 = mkCanvas(app, 800, 450);
      app.win.PRiSM_plot_bourdet(c2, app.toWin({ t: s.t, dp: s.dp, deriv: s.deriv }), app.toWin({}));
      assert.equal(app.win.PRiSM_plotSetView(c2, app.toWin({ x: { min: 1, max: 100 } })), true);
      assert.equal(c2._prismAxes.scaleX.min, 1);
      assert.equal(app.win.PRiSM_plotGetView(c2).zoomed, true);
      assert.equal(app.win.PRiSM_plotResetView(c2), true);
      assert.equal(app.win.PRiSM_plotGetView(c2).zoomed, false);
      app.win.PRiSM_plot_message(c2, 'Nothing to plot');
      assert.ok(texts(frameOps(c2)).includes('Nothing to plot'));
      assert.equal(app.win.PRiSM_plotGetView(c2), null);
    },
  },
  {
    name: 'r. every plot renders with hover+dragZoom and no errors (sample + DCA)',
    wp: 'WP6',
    run(app, assert) {
      const s = sampleAData(app);
      const pta = { t: s.t, p: s.p, dp: s.dp, deriv: s.deriv, q: s.t.map(() => 850), tp: 24,
                    periods: [{ t0: 0, t1: 120, q: 850 }] };
      const t = [], q = [];
      for (let i = 0; i <= 120; i++) { t.push(i); q.push(900 / Math.pow(1 + 0.5 * 0.02 * i, 2)); }
      const names = ['cartesian', 'horner', 'mdh', 'bourdet', 'sqrt_time', 'quarter_root_time', 'spherical',
                     'sandface_convolution', 'buildup_superposition'];
      names.forEach((n) => {
        const c = mkCanvas(app, 640, 360);
        app.win['PRiSM_plot_' + n](c, app.toWin(pta), app.toWin({ hover: true, dragZoom: true }));
        assert.ok(c._prismAxes, n + ' produced axes');
        assert.ok(c._prismAxes.points.length > 10, n + ' has points');
      });
      ['rate_time_cartesian', 'rate_time_semilog', 'rate_time_loglog', 'rate_cumulative', 'loss_ratio', 'typecurve_overlay'].forEach((n) => {
        const c = mkCanvas(app, 640, 360);
        app.win['PRiSM_plot_' + n](c, app.toWin({ t, q, overlay: { t, q } }), app.toWin({ hover: true, dragZoom: true, qi: 900, Di: 0.02, b: 0.5 }));
        assert.ok(c._prismAxes, n + ' produced axes');
      });
      // save/restore are balanced within a frame (no leaked clip regions).
      const c = mkCanvas(app, 640, 360);
      app.win.PRiSM_plot_cartesian(c, app.toWin(pta), app.toWin({ activePeriod: 0 }));
      const ops = frameOps(c);
      assert.equal(ops.filter((e) => e.op === 'save').length, ops.filter((e) => e.op === 'restore').length);
      noErrors(app, assert);
    },
  },

  // ── integration (needs other WPs' code) ─────────────────────────────
  {
    name: 'INT a. default sample through PRiSM_getAnalysisData (WP1) → Bourdet acceptance',
    wp: 'WP6',
    integration: true,
    run(app, assert) {
      app.seedSample();
      assert.fn(app.win.PRiSM_getAnalysisData, 'WP1 PRiSM_getAnalysisData');
      if (typeof app.win.PRiSM_setWell === 'function' && app.win.PRiSM_DEFAULT_SAMPLE_META) {
        try { app.win.PRiSM_setWell(app.win.PRiSM_DEFAULT_SAMPLE_META, app.toWin({ source: 'sample' })); } catch (_) { /* ignore */ }
      }
      const ad = app.win.PRiSM_getAnalysisData();
      assert.ok(ad && ad.ok, 'AData ok: ' + (ad && ad.reason));
      const calls = spyBourdet(app);
      const c = mkCanvas(app, 800, 450);
      app.win.PRiSM_plot_bourdet(c, ad, app.toWin({ plotKey: 'bourdet' }));
      assert.equal(calls(), 0);
      const T = app.win.PRiSM_THEME;
      const P = paths(frameOps(c));
      const dpLine = P.find((p) => p.kind === 'stroke' && p.color === T.accent && p.lines.length > 10);
      assert.ok(dpLine && dpLine.lines.length >= 54, 'Δp segments');
      const ax = c._prismAxes;
      const late = P.filter((p) => p.kind === 'fill' && p.color === T.green && p.arcs.length === 1)
        .map((p) => p.arcs[0]).filter((m) => ax.fromX(m[0]) >= 10 && ax.fromY(m[1]) < 1000);
      assert.ok(late.length >= 5);
      const vals = late.map((m) => ax.fromY(m[1])).sort((a, b) => a - b);
      const med = vals[vals.length >> 1];
      assert.within(med, 52.4 * 0.98, 52.4 * 1.02, 'median late derivative');
    },
  },
  {
    name: 'INT c. synthetic build-up (tp = 24 h) AData (WP1) → superposition X = Horner, flat 52.4 psi derivative, Horner uses tp',
    wp: 'WP6',
    integration: true,
    run(app, assert) {
      assert.fn(app.win.PRiSM_getAnalysisData, 'WP1 PRiSM_getAnalysisData');
      const m = 120.66, tp = 24;
      const t = [], p = [], q = [];
      for (let k = 0; k <= 40; k++) { const tt = Math.pow(10, -2 + k * (lg(24) + 2) / 40); t.push(tt); p.push(PI - m * lg(tt) - 220); q.push(850); }
      for (let k = 1; k <= 50; k++) { const dt = Math.pow(10, -3 + k * (lg(72) + 3) / 50); t.push(tp + dt); p.push(PI - m * lg((tp + dt) / dt)); q.push(0); }
      const ds = app.toWin({ t, p, q });
      app.win.PRiSM_dataset = ds;
      const ad = app.win.PRiSM_getAnalysisData(ds);
      assert.ok(ad && ad.ok, 'AData ok');
      const c = mkCanvas(app, 800, 420);
      app.win.PRiSM_plot_buildup_superposition(c, ad, app.toWin({}));
      const ax = c._prismAxes;
      assert.equal(ax.result.shutIn, true);
      assert.near(ax.result.qRef, 850, 1e-9);
      ax.points.forEach((pt, i) => assert.near(pt[0], lg((tp + ad.t[i]) / ad.t[i]), 1e-6));
      app.win.PRiSM_plot_bourdet(c, ad, app.toWin({}));
      const late = c._prismAxes.points.filter((pt) => pt[2] === 'Δp′' && pt[0] > 1);
      assert.ok(late.length >= 5);
      late.forEach((pt) => assert.near(pt[1], m / Math.LN10, 0.5));
      app.win.PRiSM_plot_horner(c, ad, app.toWin({}));
      assert.near(c._prismAxes.result.tp, 24, 0.01);
    },
  },
  {
    name: 'INT b. Tab 2 dispatcher draws the default-sample Bourdet without the blank state',
    wp: 'WP6',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.gotoTab(2);
      app.flush(500);
      const cv = app.el('prism_plot_canvas') || app.canvases('prism_tab_2')[0];
      assert.ok(cv, 'plot canvas');
      const tx = texts(frameOps(cv));
      assert.ok(!tx.some((x) => /No positive/.test(x)), 'Bourdet not blank: ' + tx.slice(0, 6).join(' | '));
      assert.ok(cv._prismAxes && typeof cv._prismAxes.fromX === 'function', 'axes with inverse');
    },
  },
];
