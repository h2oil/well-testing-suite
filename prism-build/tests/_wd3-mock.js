// Well Dynamics — the WD3 lane's stand-in engine (docs/WELL-DYNAMICS-PLAN.md §3.1–§3.6, §3.10; not shipped).
//
// WD0 had not merged when WD3 ran (no tests/_welldyn-mock.js), so the page and recorder tests use this deterministic closed-form
// stand-in with the contract shapes of revision 2. It is written as ONE self-contained function so that it can also be injected as
// plain browser code for the Playwright screenshots (installWellDynMock.toString()). It is not physics: the surface rate relaxes to
// the nodal operating point of WTS_wp_system.solve (or to 0 shut in) with a 10 min time constant, the bottom-hole pressure follows the
// IPR line through the operating point, a liquid column rises while shut in and falls while flowing, holdups / regimes follow it.
//
//   installWellDynMock(G, opts) → the WTS_wd_engine namespace it installed
//     opts.slow     wall ms burnt per step (the page's "running slower" path)
//     opts.fail     create() answers {ok:false, code: opts.fail}
//     opts.engineId overrides the engine fingerprint (cross-engine replay path)
//     opts.dt       fixed step (s), default 5
'use strict';

function installWellDynMock(G, opts) {
  opts = opts || {};
  var REGIMES = ['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown'];
  var STATE_ORDER = ['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin', 'gl_unloading',
    'gl_lifting', 'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped'];
  var LABELS = ['Stable', 'Start-up', 'Unloading', 'Marginal', 'Loading', 'Heading', 'Dying', 'Dead', 'Shut in', 'Gas-lift unloading',
    'Gas lift lifting', 'Gas lift multipoint', 'ESP off', 'ESP ramp', 'ESP running', 'ESP pump-off', 'ESP gas lock', 'ESP tripped'];
  var SEV = ['ok', 'info', 'info', 'warn', 'warn', 'warn', 'warn', 'fail', 'info', 'info', 'ok', 'warn', 'info', 'info', 'ok', 'warn', 'warn', 'fail'];
  var STATES = {};
  STATE_ORDER.forEach(function (k, i) { STATES[k] = { label: LABELS[i], sev: SEV[i], kinds: /^gl_/.test(k) ? ['gl'] : /^esp_/.test(k) ? ['esp'] : ['gas', 'oil'] }; });
  var CHANNELS = ['t', 'thp', 'tht', 'pwf', 'pr', 'pcs', 'qo', 'qw', 'qL', 'qg', 'qo_res', 'qw_res', 'qg_res', 'gor', 'wc', 'bean', 'open', 'state',
    'lratio', 'qc', 'liq', 'gascap', 'qinj', 'opValve', 'pint', 'freq', 'load', 'foam', 'dt', 'massErr', 'qgForm', 'gorForm', 'qvent', 'liftgas', 'qcVert', 'qcBelfroid'];
  var COMP = ['G', 'O', 'W', 'I', 'F'];
  var PATM = 14.696;
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function canon(o) { return JSON.stringify(o, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; }); }
  function hash(o) {
    var s = typeof o === 'string' ? o : canon(o), h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }
  var ENGINE_ID = opts.engineId || hash([Math.exp(1.1), Math.log(7.3), Math.pow(2.2, 3.3), Math.sqrt(5.1), Math.sin(0.7)]);

  function modelOnly(M) { var c = clone(M) || {}; delete c.dyn; delete c.meta; return c; }
  function surveyAt(M) {
    var sv = (M.well && M.well.survey) || [], three = sv.length && sv[0].length >= 3;
    var mc = (three && G.WTS_wellbore && typeof G.WTS_wellbore.surveyMC === 'function') ? G.WTS_wellbore.surveyMC(sv) : null;
    return function (md) {
      if (mc) { var s = mc.at(md); return { tvd: s.tvd, dep: s.dep || 0, n: s.n || 0, e: s.e || 0, inc: s.inc || 0 }; }
      if (sv.length >= 2 && !three) {
        for (var i = 1; i < sv.length; i++) if (md <= sv[i][0] || i === sv.length - 1) {
          var a = sv[i - 1], b = sv[i], f = (b[0] - a[0]) > 0 ? (md - a[0]) / (b[0] - a[0]) : 0, tvd = a[1] + f * (b[1] - a[1]);
          var inc = Math.acos(Math.max(-1, Math.min(1, (b[1] - a[1]) / Math.max(1e-9, b[0] - a[0])))) * 180 / Math.PI;
          return { tvd: tvd, dep: Math.sqrt(Math.max(0, md * md - tvd * tvd)), n: 0, e: 0, inc: inc };
        }
      }
      return { tvd: md, dep: 0, n: 0, e: 0, inc: 0 };
    };
  }
  function buildGrid(M, n) {
    var td = (M.well && fin(M.well.midPerfMd)) ? M.well.midPerfMd : 8000, at = surveyAt(M), cells = [], traj = [];
    var strings = (M.well && M.well.strings) || [], tub = strings.filter(function (s) { return s.kind === 'tubing'; });
    var eot = tub.length ? Math.max.apply(null, tub.map(function (s) { return s.botMd; })) : td;
    function idAt(md) {
      var s = strings.filter(function (x) { return x.topMd <= md && md <= x.botMd && (md <= eot ? x.kind === 'tubing' : x.kind !== 'tubing'); })[0];
      return s ? s.id : 2.441;
    }
    for (var i = 0; i < n; i++) {
      var md1 = td * (n - i) / n, md0 = td * (n - i - 1) / n, a = at(md0), b = at(md1), c = at((md0 + md1) / 2), id = idAt((md0 + md1) / 2);
      var area = Math.PI * Math.pow(id / 24, 2);
      cells.push({ i: i, md0: md0, md1: md1, mdc: (md0 + md1) / 2, tvd0: a.tvd, tvd1: b.tvd, tvdc: c.tvd, len: md1 - md0, dz: b.tvd - a.tvd, inc: c.inc, id: id,
        area: area, vol: area * (md1 - md0), kind: (md0 + md1) / 2 > eot ? 'casing' : 'tubing', seg: 0, corr: (M.system && M.system.corr && M.system.corr.well) || 'bb' });
    }
    for (var md = 0; md <= td + 1e-6; md += Math.max(25, td / 200)) { var s = at(md); traj.push({ md: md, tvd: s.tvd, dep: s.dep, n: s.n, e: s.e }); }
    var faces = []; for (var k = 0; k <= n; k++) { var fm = td * (n - k) / n; faces.push({ md: fm, tvd: at(fm).tvd, restr: null }); }
    var eotCell = 0; cells.forEach(function (c) { if (c.md0 <= eot && eot <= c.md1) eotCell = c.i; });
    return { n: n, cells: cells, segs: [{ id: 0, len: td, dz: at(td).tvd, theta: 90, area: cells[0].area, corr: cells[0].corr, restr: null }], rough: 0.0006,
      faces: faces, eotCell: eotCell, pumpFace: -1, injCell: -1, valveCells: [], gaugeCells: [], traj: traj };
  }

  function create(M, o) {
    o = o || {};
    if (opts.fail) return { ok: false, code: opts.fail, errors: ['mock refusal ' + opts.fail] };
    if (!M || !M.fluid) return { ok: false, code: 'NO_MODEL', errors: ['no model'] };
    var hm = hash(modelOnly(M)), R0 = null, C = { F: null, I: null, W: null };
    if (o.ref && o.ref.mHashModel === hm) { R0 = o.ref.R0; C = o.ref.C; }
    else if (G.WTS_wp_system && typeof G.WTS_wp_system.solve === 'function') { try { R0 = G.WTS_wp_system.solve(M); } catch (e) { R0 = null; } }
    var start = o.start || 'steady';
    if (start === 'steady' && !(R0 && R0.ok && R0.op)) return { ok: false, code: 'NO_STEADY', errors: ['no stable operating point; start from a static well'] };
    var gas = /gas|condensate/.test(M.fluid.type), lift = (M.lift && M.lift.type) || 'none';
    var n = Math.max(20, Math.min(200, Math.round(o.cells || 60)));
    var grid = buildGrid(M, n);
    var pr = (M.res && fin(M.res.pr)) ? M.res.pr : 3000;
    var qop = (R0 && R0.op) ? R0.op.q : 0, pop = (R0 && R0.op) ? R0.op.p : pr;
    var thpop = (R0 && R0.surface && fin(R0.surface.thp_psig)) ? R0.surface.thp_psig : 200;
    var wc = fin(M.fluid.wc) ? M.fluid.wc : 0, gor = fin(M.fluid.gor) ? M.fluid.gor : 0;
    var resolved = clone(o); delete resolved.ref; delete resolved.snapshot;
    resolved.reservoir = Object.assign({ mode: 'ipr', prior: { kind: start === 'steady' ? 'steady' : 'none', t_h: 720, shut_h: 0 }, backflow: true }, o.reservoir || {});
    var mHash = hash({ m: modelOnly(M), o: resolved });
    var listeners = {};
    function emit(type, d) { (listeners[type] || []).slice().forEach(function (f) { f(d); }); }
    var F64 = function () { return new Float64Array(n); };
    var S = {
      t: 0, dt: 0, n: 0, open: true, bean64: (M.surface && M.surface.choke && M.surface.choke.bean64) || 32, beanEff: null, psep_psig: (M.surface && M.surface.psep_psig) || 100,
      tOpen: 0, qRef: 0,
      cells: { p: F64(), T: F64(), ag: F64(), ao: F64(), aw: F64(), mG: F64(), mO: F64(), mW: F64(), mI: F64(), mF: F64(), vg: F64(), vl: F64(), vm: F64(), rhoM: F64(), vc: F64(), sigF: F64(), regime: new Uint8Array(n) },
      faces: { Q: new Float64Array(n + 1), jg: new Float64Array(n + 1), jo: new Float64Array(n + 1), jw: new Float64Array(n + 1), xI: new Float64Array(n + 1), vd: new Float64Array(n + 1), c0: new Float64Array(n + 1), w: new Float64Array(n + 1) },
      surface: { thp: 0, thp_psig: 0, tht: 0, pDn_psig: 0, qo: 0, qw: 0, qL: 0, qg: 0, qgForm: 0, qinj: 0, qvent: 0, glr: 0, gor: 0, gorForm: 0, wc: wc, regime: 'critical', y: 0.4, yc: 0.588 },
      bottom: { pwf: pr, pr: pr, qo: 0, qw: 0, qg: 0, drawdown: 0 },
      well: { state: 'startup', since: 0, reason: 'opened', prev: null },
      loading: { method: 'turner', both: false, liquid: wc > 0 ? 'water' : 'condensate', qc_MMscfd: gas ? 1.2 : NaN, qcVert_MMscfd: gas ? 1.2 : NaN, qcBelfroid_MMscfd: gas ? 1.35 : NaN,
        belfroid: false, limitingMd: 0, limitingTvd: 0, ratio: NaN, vRatioMin: NaN, belowEot: false },
      inventory: { liq_bbl: 0, liqTubing_bbl: 0, gas_Mscf: 0, liftGas_Mscf: 0, liquidTopMd: NaN, gasCapBottomMd: NaN },
      balance: { m: { G: 0, O: 0, W: 0, I: 0 }, cumIn: { G: 0, O: 0, W: 0, I: 0 }, cumOut: { G: 0, O: 0, W: 0, I: 0 }, errStep: 0, errCum: 0, volDrift: 0 },
      lift: { gl: lift === 'gaslift' ? { pcs_psig: 0, qinj: 0, opValve: 0, valves: [] } : null, esp: lift === 'esp' ? { on: false, freq: 0, pint: 0, load: 0 } : null },
      foamer: { on: false, ppm: 0, eff: 0 },
      res: { mode: resolved.reservoir.mode, terms: [], f0: 1, backflow: 0 },
      flags: [], provisional: ['mock']
    };
    var X = { q: start === 'steady' ? qop : 0, liq: start === 'steady' ? 2 : 30, pend: [], log: [], m0: null, steady: { ringT: [], ringQ: [], ringPwf: [], ringThp: [] },
      pending: null, freq: 0, qinj: 0, ppm: 0 };
    if (start !== 'steady') { S.open = false; S.well.state = 'shutin'; }
    var DT = opts.dt || (gas ? 5 : 10);
    function beanFactor() { var b = S.bean64 || 32, b0 = (M.surface && M.surface.choke && M.surface.choke.bean64) || 32; return Math.min(1.6, Math.pow(b / b0, 1.2)); }
    function target() {
      if (!S.open) return 0;
      var base = qop > 0 ? qop : 300;
      if (S.lift.esp) base *= Math.min(1.2, X.freq / 60);
      if (S.lift.gl) base *= Math.min(1.2, 0.2 + X.qinj / 800);
      if (gas && S.bean64 < 20 && !(X.ppm > 0)) base *= 0.35;
      return base * beanFactor();
    }
    function derive() {
      var q = X.q, fo = 1 - wc, J = (qop > 0 && pr > pop) ? qop / (pr - pop) : 2;
      S.bottom.pwf = pr - q / J + (S.open ? 0 : 0); S.bottom.pr = pr; S.bottom.drawdown = pr - S.bottom.pwf;
      S.bottom.qo = gas ? q * 0.02 : q * fo; S.bottom.qw = gas ? q * 0.002 : q * wc; S.bottom.qg = gas ? q : q * fo * gor / 1000;
      var qs = q * (S.open ? 1 : 0);
      S.surface.qo = gas ? qs * 0.02 : qs * fo; S.surface.qw = gas ? qs * 0.002 : qs * wc; S.surface.qL = S.surface.qo + S.surface.qw;
      S.surface.qgForm = gas ? qs : qs * fo * gor / 1000; S.surface.qinj = S.lift.gl ? X.qinj : 0; S.surface.qvent = 0;
      S.surface.qg = S.surface.qgForm + S.surface.qinj;
      S.surface.gor = S.surface.qo > 0 ? 1000 * S.surface.qg / S.surface.qo : 0; S.surface.gorForm = S.surface.qo > 0 ? 1000 * S.surface.qgForm / S.surface.qo : 0;
      S.surface.glr = S.surface.qL > 0 ? 1000 * S.surface.qg / S.surface.qL : 0;
      S.surface.thp_psig = S.open ? S.psep_psig + (thpop - S.psep_psig) * (qop > 0 ? q / qop : 0.5) : Math.max(0, S.bottom.pwf - 0.3 * grid.cells[0].tvdc - PATM);
      S.surface.thp = S.surface.thp_psig + PATM; S.surface.tht = S.open ? 120 : 90; S.surface.pDn_psig = S.psep_psig;
      S.surface.regime = S.open ? 'critical' : 'closed'; S.surface.wc = wc;
      var top = grid.cells[0].md1 - Math.min(grid.cells[0].md1, X.liq * 90);
      S.inventory.liq_bbl = X.liq; S.inventory.liqTubing_bbl = X.liq * 0.9; S.inventory.gas_Mscf = 12; S.inventory.liftGas_Mscf = S.lift.gl ? X.qinj / 400 : 0;
      S.inventory.liquidTopMd = top; S.inventory.gasCapBottomMd = S.open ? NaN : top;
      for (var i = 0; i < n; i++) {
        var c = grid.cells[i], wet = c.mdc >= top, p = S.surface.thp + (S.bottom.pwf - S.surface.thp) * c.tvdc / Math.max(1, grid.cells[0].tvdc);
        S.cells.p[i] = p; S.cells.T[i] = 100 + 0.012 * c.tvdc;
        var ag = wet ? (S.open ? 0.3 : 0.02) : (gas ? 0.95 : 0.6);
        S.cells.ag[i] = ag; S.cells.aw[i] = (1 - ag) * Math.max(wc, gas ? 0.5 : 0); S.cells.ao[i] = 1 - ag - S.cells.aw[i];
        S.cells.vg[i] = S.open ? (gas ? 25 : 6) * (0.5 + 0.5 * i / n) * (qop > 0 ? X.q / qop : 0) : 0;
        S.cells.vl[i] = S.open ? 1.2 * (qop > 0 ? X.q / qop : 0) : (wet ? 0 : -0.2);
        S.cells.vm[i] = ag * S.cells.vg[i] + (1 - ag) * S.cells.vl[i]; S.cells.rhoM[i] = ag * 5 + (1 - ag) * 55; S.cells.vc[i] = 10;
        S.cells.mG[i] = ag * c.vol * 5; S.cells.mO[i] = S.cells.ao[i] * c.vol * 50; S.cells.mW[i] = S.cells.aw[i] * c.vol * 62; S.cells.mI[i] = S.lift.gl ? 0.1 * c.vol : 0;
        S.cells.mF[i] = X.ppm * 1e-6 * S.cells.mW[i]; S.cells.sigF[i] = X.ppm > 0 ? 0.6 : 1;
        S.cells.regime[i] = !S.open ? (wet ? 0 : 8) : wet ? 2 : (gas ? 4 : 3);
      }
      for (var k = 0; k <= n; k++) { S.faces.Q[k] = S.open ? X.q * 6.5e-5 : 0; S.faces.jg[k] = S.cells.vg[Math.min(n - 1, k)] * 0.5; S.faces.jo[k] = 0.1; S.faces.jw[k] = 0.05; S.faces.w[k] = 1; S.faces.c0[k] = 1.2; }
      if (gas) { S.loading.ratio = (S.surface.qgForm / 1000) / S.loading.qc_MMscfd; S.loading.vRatioMin = S.loading.ratio; }
      if (S.lift.gl) { S.lift.gl.pcs_psig = 800 + 300 * Math.min(1, S.t / 3600); S.lift.gl.qinj = X.qinj; S.lift.gl.opValve = X.qinj > 0 ? (S.t > 1800 ? 3 : 1) : 0; }
      if (S.lift.esp) { S.lift.esp.freq = X.freq; S.lift.esp.on = X.freq > 0; S.lift.esp.pint = S.bottom.pwf - 400; S.lift.esp.load = X.freq / 60 * 0.8; }
      S.foamer.ppm = X.ppm; S.foamer.on = X.ppm > 0; S.foamer.eff = X.ppm > 0 ? 0.4 : 0;
      var tot = 0; for (var j = 0; j < n; j++) tot += S.cells.mG[j] + S.cells.mO[j] + S.cells.mW[j];
      S.balance.m = { G: tot * 0.1, O: tot * 0.5, W: tot * 0.4, I: 0 }; S.balance.errStep = 1e-12; S.balance.errCum = 1e-10;
    }
    function label() {
      var k;
      if (!S.open) k = 'shutin';
      else if (S.t - S.tOpen < 600) k = 'startup';
      else if (S.lift.esp) k = X.freq > 0 ? (X.freq < 59.5 ? 'esp_ramp' : 'esp_running') : 'esp_off';
      else if (S.lift.gl) k = X.qinj > 0 ? (S.t > 1800 ? 'gl_lifting' : 'gl_unloading') : 'dying';
      else if (gas && S.loading.ratio < 0.9) k = 'loading';
      else if (gas && S.loading.ratio < 1.1) k = 'marginal';
      else k = 'stable';
      if (k !== S.well.state) {
        var from = S.well.state; S.well.prev = from; S.well.state = k; S.well.since = S.t; S.well.reason = 'mock rule';
        emit('state', { from: from, to: k, t: S.t, reason: 'mock rule' });
      }
    }
    function apply(e) {
      var a = e.args || {};
      if (e.type === 'open') { if (!S.open) { S.open = true; S.tOpen = S.t; S.qRef = 0; } }
      else if (e.type === 'shutin') S.open = false;
      else if (e.type === 'bean' && fin(a.bean64)) S.bean64 = a.bean64;
      else if (e.type === 'psep' && fin(a.psig)) S.psep_psig = a.psig;
      else if (e.type === 'foamer') X.ppm = a.on === false ? 0 : (fin(a.ppm) ? a.ppm : 1000);
      else if (e.type === 'gl' && fin(a.qinj_Mscfd)) X.qinj = a.qinj_Mscfd;
      else if (e.type === 'esp') X.freq = a.on === false ? 0 : (fin(a.freq) ? a.freq : 60);
      X.log.push(clone(e));
      emit('event', clone(e));
    }
    function stepOnce(dtReq) {
      var dt = fin(dtReq) && dtReq > 0 ? dtReq : DT;
      X.pend.sort(function (a, b) { return a.t - b.t; });
      if (X.pend.length && X.pend[0].t > S.t && X.pend[0].t < S.t + dt) dt = X.pend[0].t - S.t;      // events cut a step exactly
      var applied = [];
      while (X.pend.length && X.pend[0].t <= S.t + 1e-9) { var e = X.pend.shift(); apply(e); applied.push(e); }
      var tq = target(), f = 1 - Math.exp(-dt / 600);
      X.q += (tq - X.q) * f;
      X.liq += S.open ? (gas && S.loading.ratio < 0.9 ? 0.02 : -0.05) * dt / 60 : 0.03 * dt / 60;
      X.liq = Math.max(0.5, Math.min(60, X.liq));
      if (opts.slow) { var w0 = Date.now(); while (Date.now() - w0 < opts.slow) { /* burn */ } }
      S.t += dt; S.dt = dt; S.n++;
      derive();
      if (S.open && S.surface.qL + S.surface.qg > S.qRef) S.qRef = S.surface.qL + S.surface.qg;
      label();
      var r = X.steady; r.ringT.push(S.t); r.ringQ.push(gas ? S.surface.qg : S.surface.qL); r.ringPwf.push(S.bottom.pwf); r.ringThp.push(S.surface.thp);
      while (r.ringT.length && r.ringT[0] < S.t - 3600) { r.ringT.shift(); r.ringQ.shift(); r.ringPwf.shift(); r.ringThp.shift(); }
      var info = { ok: true, t: S.t, dt: dt, iters: 3, sweeps: 1, rejects: 0, massErr: { G: 1e-13, O: 1e-13, W: 1e-13, I: 0 }, applied: applied };
      emit('step', info);
      return info;
    }
    var sim = {
      ok: true, version: '0.0.0-mock', M: M, R0: R0, C: C, ref: { mHashModel: hm, R0: R0, C: C }, mHash: mHash, grid: grid, state: S, opts: resolved,
      step: function (dt) { return stepOnce(dt); },
      run: function (seconds, ro) {
        ro = ro || {}; var t1 = S.t + Math.max(0, seconds || 0), w0 = Date.now(), steps = 0;
        while (S.t < t1 - 1e-9) {
          stepOnce(); steps++;
          if (ro.maxSteps && steps >= ro.maxSteps) return { ok: true, t: S.t, steps: steps, wallMs: Date.now() - w0, stopped: 'steps' };
          if (ro.maxWallMs && Date.now() - w0 >= ro.maxWallMs) return { ok: true, t: S.t, steps: steps, wallMs: Date.now() - w0, stopped: 'wall' };
        }
        return { ok: true, t: S.t, steps: steps, wallMs: Date.now() - w0, stopped: 'target' };
      },
      snapshot: function () {
        var a = function (x) { return Array.prototype.slice.call(x); };
        return { kind: 'wd-snap', v: 1, engine: sim.version, engineId: ENGINE_ID, mHash: mHash, n: n, t: S.t, steps: S.n, dtPrev: S.dt,
          cells: { mG: a(S.cells.mG), mO: a(S.cells.mO), mW: a(S.cells.mW), mI: a(S.cells.mI), mF: a(S.cells.mF), T: a(S.cells.T), p: a(S.cells.p) },
          faces: { Q: a(S.faces.Q), jg: a(S.faces.jg), jo: a(S.faces.jo), jw: a(S.faces.jw), xI: a(S.faces.xI), vd: a(S.faces.vd), c0: a(S.faces.c0), w: a(S.faces.w) },
          ctl: { open: S.open, bean64: S.bean64, beanEff: S.beanEff, strokeLeft_s: 0, psep_psig: S.psep_psig, tOpen: S.tOpen, qRef: S.qRef },
          line: { refGor: gor, refWc: wc, q: [], pdn: [] },
          res: { mode: S.res.mode, terms: [], base: pr, qPrev: { o: 0, w: 0, g: 0 }, prior: resolved.reservoir.prior },
          labels: { state: S.well.state, since: S.well.since, prev: S.well.prev, reason: S.well.reason, pending: null, ringT: [], ringLiq: [], ringQ: [], ringP: [], dying: {}, heading: {} },
          steady: clone(X.steady), pend: clone(X.pend), log: clone(X.log), ext: { mock: { q: X.q, liq: X.liq, freq: X.freq, qinj: X.qinj, ppm: X.ppm } },
          bal: { m0: { G: 0, O: 0, W: 0, I: 0 }, cumIn: { G: 0, O: 0, W: 0, I: 0 }, cumOut: { G: 0, O: 0, W: 0, I: 0 } }, prov: S.provisional.slice(), flags: [] };
      },
      restore: function (sn) {
        if (!sn || sn.kind !== 'wd-snap') return { ok: false, code: 'FORMAT' };
        if (sn.mHash !== mHash) return { ok: false, code: 'MODEL_MISMATCH' };
        if (String(sn.engine).split('.')[0] !== String(sim.version).split('.')[0]) return { ok: false, code: 'VERSION' };
        var m = sn.ext && sn.ext.mock || {};
        X.q = m.q; X.liq = m.liq; X.freq = m.freq || 0; X.qinj = m.qinj || 0; X.ppm = m.ppm || 0;
        X.pend = clone(sn.pend || []); X.log = clone(sn.log || []); X.steady = clone(sn.steady);
        S.t = sn.t; S.n = sn.steps; S.dt = sn.dtPrev; S.open = sn.ctl.open; S.bean64 = sn.ctl.bean64; S.psep_psig = sn.ctl.psep_psig; S.tOpen = sn.ctl.tOpen; S.qRef = sn.ctl.qRef;
        S.well.state = sn.labels.state; S.well.since = sn.labels.since; S.well.prev = sn.labels.prev; S.well.reason = sn.labels.reason;
        derive();
        return { ok: true };
      },
      schedule: function (evs) {
        var k = 0; (evs || []).forEach(function (e) { if (e && fin(e.t) && e.t >= S.t - 1e-9 && e.type) { X.pend.push({ t: e.t, type: e.type, args: clone(e.args || {}), src: e.src || 'scenario' }); k++; } });
        return { ok: true, n: k };
      },
      setChoke: function (b) { return sim.schedule([{ t: S.t, type: 'bean', args: { bean64: b }, src: 'user' }]); },
      shutIn: function () { return sim.schedule([{ t: S.t, type: 'shutin', args: {}, src: 'user' }]); },
      open: function () { return sim.schedule([{ t: S.t, type: 'open', args: {}, src: 'user' }]); },
      setSeparator: function (p) { return sim.schedule([{ t: S.t, type: 'psep', args: { psig: p }, src: 'user' }]); },
      setFoamer: function (f) { return sim.schedule([{ t: S.t, type: 'foamer', args: clone(f || {}), src: 'user' }]); },
      setLift: function (s) { s = s || {}; return sim.schedule([{ t: S.t, type: s.type === 'esp' ? 'esp' : 'gl', args: clone(s), src: 'user' }]); },
      steadyCheck: function () {
        var r = X.steady, m = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; };
        var qm = m(r.ringQ), pm = m(r.ringPwf), tm = m(r.ringThp);
        var amp = function (a) { return a.length ? (Math.max.apply(null, a) - Math.min.apply(null, a)) / 2 : NaN; };
        var opq = R0 && R0.op ? R0.op.q : NaN, opp = R0 && R0.op ? R0.op.p : NaN;
        return { steady: amp(r.ringQ) < 0.005 * qm, qMean: qm, pwfMean: pm, thpMean: tm, ampQ: amp(r.ringQ), ampP: amp(r.ringPwf),
          dq: fin(opq) ? qm / opq - 1 : NaN, dp: fin(opp) ? pm / opp - 1 : NaN };
      },
      on: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
      off: function (t, f) { listeners[t] = (listeners[t] || []).filter(function (x) { return x !== f; }); },
      dispose: function () { listeners = {}; }
    };
    if (o.events && o.events.length) sim.schedule(o.events);
    if (o.start === 'snapshot' && o.snapshot) sim.restore(o.snapshot);
    derive();
    if (S.open) { S.qRef = S.surface.qL + S.surface.qg; }
    return sim;
  }
  var NS = G.WTS_wd_engine = { VERSION: '0.0.0-mock', create: create, ext: {}, COMP: COMP, REGIMES: REGIMES, STATES: STATES, STATE_ORDER: STATE_ORDER,
    CHANNELS: CHANNELS, hash: hash, engineId: ENGINE_ID, mock: true };
  return NS;
}

module.exports = { installWellDynMock, source: '(' + installWellDynMock.toString() + ')' };
