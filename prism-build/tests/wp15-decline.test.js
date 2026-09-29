// WP15 — decline diagnostics D(t) and b(t) (35-rta-dca.js, ROADMAP N8).
//
// Independent expectations (Arps 1945, loss-ratio form):
//   q = qi/(1 + b·Di·t)^(1/b)  →  D(t) = −d ln q/dt = Di/(1 + b·Di·t),
//   1/D = (1 + b·Di·t)/Di      →  b(t) = d(1/D)/dt = b (constant);
//   exponential q = qi·e^(−Di·t) → D = Di, b = 0.
//   qi = 1000 STB/d, Di = 0.01 1/day: D(100 d) = 0.01/(1 + 0.5) = 6.6667e-3 for b = 0.5,
//   0.01/(1 + 1) = 5e-3 for b = 1.
'use strict';

function arpsData(b, Di, n) {
  const t = [], q = [];
  for (let i = 0; i < (n || 60); i++) {
    const d = Math.pow(10, i / ((n || 60) - 1) * 3);      // 1 … 1000 days
    t.push(d * 24);                                          // dataset time in hours
    q.push(b === 0 ? 1000 * Math.exp(-Di * d) : 1000 / Math.pow(1 + b * Di * d, 1 / b));
  }
  return { t, q };
}

module.exports = [
  {
    name: 'D(t) and b(t) of Arps hyperbolic (b = 0.5), harmonic (b = 1) and exponential data match the closed forms',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      [0.5, 1, 0].forEach((b) => {
        const d = W.PRiSM_declineDiagnostics(app.toWin(arpsData(b, 0.01)), app.toWin({ L: 0.1 }));
        assert.ok(d.ok, d.reason);
        assert.equal(d.units.D, '1/day');
        let nChk = 0;
        d.t.forEach((td, i) => {
          if (i < 3 || i > d.n - 4) return;                   // end effects of the derivative window
          assert.rel(d.D[i], 0.01 / (1 + b * 0.01 * td), 0.01, 'b = ' + b + ': D at ' + td.toFixed(1) + ' d');
          assert.near(d.b[i], b, 0.03, 'b = ' + b + ': b(t) at ' + td.toFixed(1) + ' d');
          nChk++;
        });
        assert.ok(nChk > 40);
        assert.near(d.bLate, b, 0.02, 'late-time median b');
      });
      // A point value: D(100 d) for b = 0.5.
      const dd = W.PRiSM_declineDiagnostics(app.toWin({ t: [24, 480, 1200, 2400, 4800, 9600], q: [1000, 1000 / Math.pow(1.1, 2), 1000 / Math.pow(1.25, 2), 1000 / Math.pow(1.5, 2), 1000 / Math.pow(2, 2), 1000 / Math.pow(3, 2)] }), app.toWin({ L: 0.01 }));
      assert.ok(dd.ok);
      assert.rel(dd.D[3], 6.6667e-3, 0.03, 'D(100 d), sparse data');
      const bad = W.PRiSM_declineDiagnostics(app.toWin({ t: [1, 2], q: [5, 4] }));
      assert.ok(!bad.ok && /at least 5/.test(bad.reason));
    },
  },
  {
    name: 'D(t) / b(t) plots are registered for decline mode, draw the data and the current rate fit as a model line',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      const reg = W.PRiSM_PLOT_REGISTRY;
      assert.ok(reg.declineD && reg.declineB, 'registered');
      assert.equal(reg.declineD.mode, 'decline');
      W.PRiSM_dataset = app.toWin(arpsData(0.5, 0.01));
      if (!W.PRiSM) W.PRiSM = {};
      W.PRiSM.mode = 'decline';
      const built = W.PRiSM_buildPlotData('declineD');
      assert.ok(built.data && built.data.diag && built.data.diag.ok, built.error);
      // A rate fit → model D(t), b(t) lines.
      W.PRiSM_state.model = 'arps';
      W.PRiSM_setLastFit(app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi: 1000, Di: 0.01, b: 0.5 }, r2: 1, aic: -500 }));
      const c = app.document.createElement('canvas');
      c.width = 600; c.height = 360;
      app.document.body.appendChild(c);
      W.PRiSM_plot_decline_b(c, built.data, app.toWin({ width: 600, height: 360 }));
      const texts = app.canvasTexts(c).join(' | ');
      assert.includes(texts, 'b(t) from data');
      assert.includes(texts, 'Model b(t)');
      assert.includes(texts, 'Late-time median b');
      W.PRiSM_plot_decline_D(c, W.PRiSM_buildPlotData('declineD').data, app.toWin({ width: 600, height: 360 }));
      assert.includes(app.canvasTexts(c).join(' | '), 'Model D(t)');
      assert.ok(c._prismAxes && typeof c._prismAxes.toX === 'function', 'C6 axes');
      assert.equal(app.consoleErrors().length, 0, app.consoleErrors().join(' | '));
    },
  },
];
