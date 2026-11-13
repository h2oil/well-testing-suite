# Well Dynamics — transient well simulator (v4.6) — implementation plan

> **Status: draft for owner review, revision 1** (2026-11-13, on top of dev-87qwkg f68eb65 = v4.5). Nothing is built yet. Test counts
> are relative to the v4.5 gates (smoke 347, acceptance 2,235, server 278).
> The module is our own design and our own code. Published methods are cited by their authors and year only. A coefficient marked
> "to verify" is used as written here and labelled provisional (D17) until it is checked against the paper (owner question Q9 of the
> Well Performance plan: the papers and textbooks were not provided).
> Owner decision 2026-11-13: the page has **its own sidebar row** ("just build it into menu") — not a hub member.

| | |
|---|---|
| Module | Well Dynamics: a time-stepping (transient) simulator of one well — reservoir inflow, wellbore with deviation, choke, flowline back pressure, gas lift, ESP |
| Route | `welldyn`, its own row in **Production & Reservoir**, right after the Well Performance hub row (group 5 → 6 of 8 rows), plus a dashboard tile |
| Shared model | the Well Performance model (`WTS_wp_model.read()` = scalars in `wts_page_wellperf` + tables in `wts_wellperf_model`): fluid, PVT, IPR, survey, strings, restrictions, choke, flowline, lift. A well set up for nodal analysis plays in time with no re-entry. |
| Release | one increment, v4.6 (both platforms; Q5) |
| New files | Round 9 only: `49-calc-wd-engine.js`, `49-calc-wd-res.js`, `49-calc-wd-lift.js`, `49-calc-wd-view.js`, `49-calc-wd-rec.js`, `49-calc-welldyn.js` (page), `48-calc-help-welldyn.js` (help); `prism-build/welldyn-validate.js`; tests (§2.3) |
| Host edits | one: `'welldyn'` in `__NAV_ORDER` after `'gaslift'` (WD0). No route-table, hub or static markup edit (the plug-in registry mounts the row and the tile). |
| Shared engines reused (never duplicated) | `WTS_wp_model`, `WTS_wp_fluid` (PVT, Z, wet gas), `WTS_flowline_props`, `WTS_flowline_corr` (gradient correlations), `WTS_flowline_march` (flowline back pressure), `WTS_wp_ipr` (steady inflow), `WTS_wp_well` (path, segments, stations, temperature), `WTS_wp_system` (steady reference, loading rule, choke rule, shut-in columns), `WTS_chokeperf_multiphaseRate` / `_gasRate` / `_sachdeva`, `WTS_wp_gl` (`tc`, `pdAt`, `portR`, installed valves), `WTS_gaslift_ct`, `WTS_wp_esp` (`prepare`, `curve`, `pump`), `WTS_wp_view` (chart, colours, schematic helpers), `PRiSM_E1`, `PRiSM_autoInterp.drive` / `hash16`, `PRiSM_getWell` |

---

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| WD-D1 | One page `welldyn`, its own sidebar row in Production & Reservoir after the `perf` hub (owner 2026-11-13). Not a hub member, not a PRiSM mode, not part of the 3-D simulator (31/32/38 are not touched). | §2.1 |
| WD-D2 | **One model.** The page reads the Well Performance model with `WTS_wp_model.read()`; it never keeps a copy of fluid, inflow, well or lift inputs. Its own inputs are scenario settings (scalars `wd_*` in `wts_page_welldyn`) and cases (`dyn` table key in `wts_wellperf_model`, additive, §7). | §7 |
| WD-D3 | **Physics:** 1-D transient drift-flux model along MD on the shared path; three components (gas, oil-or-condensate, water) + a passive foamer tracer; black-oil flash per cell through `WTS_wp_fluid`; **quasi-steady mixture momentum** per cell; volume-constrained pressure coupling solved once per step by a scalar root on the wellhead pressure (a "no-pressure-wave" scheme — no acoustic time-step limit). | §4.1–§4.6 |
| WD-D4 | **Closure:** default `corr` = the drift parameters are set at every face so the steady holdup equals the holdup of the well's gradient correlation (the same key the nodal solve uses, Beggs & Brill by default, D5 / D17 of the Well Performance plan) and the friction is that correlation's friction gradient; below a low mixture velocity it blends into the published drift-flux closure (Zuber-Findlay with the Shi et al. inclination form), which is the only closure that exists for counter-current flow and shut-in. Option `driftflux` uses the drift-flux closure everywhere. | §4.4 |
| WD-D5 | **Consistency gate:** a steady flowing run must settle on `WTS_wp_system.solve` for the same model — rate within 2 %, BHP within 1 %, THP within 1 % or 3 psi — on six fixtures (gas vertical, gas horizontal, oil vertical, oil deviated, gas lift, ESP). This is the release gate of the module. | §5.1 |
| WD-D6 | **Reservoir:** mode `ipr` (instantaneous steady inflow from `WTS_wp_ipr`, exact consistency with nodal) and mode `transient` (line-source Ei superposition of the IPR's drawdown, bounded by the stabilised IPR, so a long constant-rate run converges to the IPR). Wellbore storage and afterflow are not inputs: they emerge from the cells. | §4.7 |
| WD-D7 | **Time integration:** explicit, conservative, first-order upwind transport (option second-order MUSCL / minmod); step limited by a material CFL (default 0.5), a pressure-change limit, event times and `dtMax`; rejected steps are halved. Mass balance checked every step. | §4.6 |
| WD-D8 | **Determinism:** the step sequence depends only on the model, the settings and the event list — never on the frame rate or wall time. `run(seconds)` never splits a step to land on a frame; events cut a step exactly at their time. A replay re-run is bit-identical; `snapshot()` / `restore()` continue bit-identically. | §3.2, §5.4 |
| WD-D9 | **Run loop:** the page drives the engine from `requestAnimationFrame` only while playing; paused, hidden tab, page left or run ended → no frame is requested. No `setInterval`, no watchdog, no polling, no function wrapping. The page opens paused. | §6.6 |
| WD-D10 | **Recorder:** scalar channels at a fixed simulated interval + full engine snapshots at a coarser interval, in memory, capped (32 MB); scrub shows any recorded moment; "Continue from here" restores the engine from the snapshot. A replay file (`.wdrun`, JSON) holds model, settings, events, series and snapshots. | §3.4, §7 |
| WD-D11 | **D17 applies unchanged.** Every method is in the method table (§4.14) with `verified` and what would verify it. A method without a verified published example is labelled "provisional — not verified against a published example" and is never a default where a verified or identity-checked alternative exists. Where no alternative exists (shut-in segregation needs a drift closure) the provisional method runs and the run is labelled. The page shows the list of provisional methods active in a run. | §4.14 |
| WD-D12 | Engines are field units only (psia inside, psig at surface named `*_psig`, ft, in, °F, STB/d, Mscf/d, lbm, s for time). The page displays through the units layer (Metric works); categories are those the Well Performance page uses (guarded local registration, D12 of that plan). | §3.0, §6.8 |
| WD-D13 | Lift transients (foamer, gas lift, ESP, intermittent controller, heading detector) are **engine extensions** registered in `WTS_wd_engine.ext`, so lane WD4 adds them without editing the engine. | §3.3 |
| WD-D14 | Naming: methods by their published authors only; no product, vendor, company or web address anywhere; `welldyn-names` greps every Well Dynamics file. | §2.5 |
| WD-D15 | Reports: an always-visible compact block `#wd_res` (inputs, run summary, KPI chips, the wellbore at the current time, the run trend, state timeline, provisional list, Notes); editors, controls and step-only plots are `.rp-skip`; canvases drawn at explicit sizes; Quick Report snapshot ≤ 60 kB. | §6.7 |

---

## 1. Scope and non-goals

### 1.1 What the module does

A well that was set up on the Well Performance page (fluid, inflow, survey, strings, choke, flowline, gas lift or ESP) is played in time.
The user opens the well, shuts it in, changes the choke, adds foamer, starts gas lift or an ESP and watches the wellbore fill, unload,
load up, segregate and build up — with the pressures, holdups, flow regimes and rates along the true trajectory, the live point on the
IPR / VLP plot and a recorder that can be scrubbed, marked, exported and replayed.

User stories (each is an acceptance item in the named test file):

| # | Story | Test file |
|---|---|---|
| US1 | I open Well Dynamics on a well I modelled in Well Performance and the same well is there (fluid, IPR, survey, strings, choke, lift) with no re-entry; "Back to nodal analysis" takes me to the same well. | welldyn-page |
| US2 | I press Play from the steady state and the run stays on the nodal operating point (the live point sits on the IPR / VLP intersection). | welldyn-gate |
| US3 | I start from a static well (gas-filled, full of liquid, or a liquid level) and open it: the well unloads its liquid and settles, or dies. | welldyn-engine |
| US4 | On a gas well I reduce the bean below the critical rate and see liquid accumulate at the bottom, the state go stable → marginal → loading → dead, with the Turner / Coleman critical rate and the limiting depth. | welldyn-engine, welldyn-lift |
| US5 | I shut the well in and see afterflow, the gas cap form, water / condensate settle and the bottom-hole pressure build up with a radial-flow derivative. | welldyn-res, welldyn-engine |
| US6 | I run a bean schedule (bean-up steps at set times) and an intermittent cycle (open / shut by time or by pressure). | welldyn-lift, welldyn-page |
| US7 | I add a continuous foamer and see the critical rate drop and a loaded gas well unload. | welldyn-lift |
| US8 | An oil well starts flowing from static; near the stable limit it heads or dies; after a shut-in it builds up. | welldyn-engine, welldyn-lift |
| US9 | A gas-lift well unloads valve by valve from a liquid-filled annulus on the installed design, with casing and tubing pressures in time, then lifts from the operating valve. | welldyn-lift |
| US10 | An ESP well starts with a frequency ramp, the intake pressure draws down and the well settles on the pumped operating point; pump-off, gas lock and underload are flagged. | welldyn-lift |
| US11 | I play / pause / step / shut in / open / change the speed ×1–×1000 / change the choke at the current time / scrub the timeline back to any recorded moment and continue from there. | welldyn-page, welldyn-rec |
| US12 | I mark windows, export CSV (time series, chosen columns, field or Metric), save a replay file and reopen it, and save named cases with the well (in the project file). | welldyn-rec |
| US13 | I see the wellbore along the true trajectory with cells coloured by phase and regime labels, moving film / droplets / slugs, a navigator, a cell close-up and a hover readout; a depth log; live charts (rate, WHP / BHP, IPR + VLP, WHP vs rate, casing pressure, pump intake). | welldyn-view |
| US14 | I get a page report and a Quick Report entry with the current state and the run summary; Metric display, keyboard and a 390 px phone layout work. | welldyn-page |

### 1.2 Non-goals (with the reason)

| Not in v4.6 | Reason |
|---|---|
| Pressure waves (water hammer, acoustic transients) | the quasi-steady momentum removes them by design (WD-D3); the DFIT `hammerQuick` covers the screening |
| Full thermal transient (heat capacity of the completion and formation) | temperature is frozen or relaxes with one time constant (§4.9); an enthalpy transient is a later increment |
| Equation of state / compositional flash, condensate drop-out in the tubing | the shared fluid is black oil / wet gas (Well Performance D14) |
| Flowline / riser slugging dynamics | the flowline is a quasi-steady back-pressure table (§4.8) |
| Plunger lift, rod pump, PCP, jet pump | not in the shared model (Well Performance increment C) |
| Coning / cresting, multilayer crossflow dynamics, near-well two-phase transients | one inflow node at the mid-perforations (§4.7); a multilayer IPR is used as its steady total |
| Several wells, networks, the field | one well per run |
| Live data coupling (historian / Modbus) | a later increment; the CSV export is the hand-off |
| Hydrate, wax, scale or sand kinetics | flags only (hydrate margin at the wellhead from the existing check) |
| ESP casing-gas / annulus model, PPO gas-lift valves | IPO and orifice valves only; vented ESP gas leaves at the surface (§4.11, §4.12) |

---

## 2. Architecture

### 2.1 Where the module lives

- **Sidebar.** A plug-in row (registry `group: 'Production & Reservoir'`) placed by `__NAV_ORDER`:
  `'prism', 'oilgas', 'solgor', 'wellperf', 'oilipr', 'gasdeliv', 'gaslift', 'welldyn', 'buildup', …` — so the row comes right after the
  Well Performance hub row (the hub members are hidden rows ranked inside the hub), and before Build-up Surveillance. The group goes from
  5 to 6 of 8 rows. Icon `&#8767;` (a wave), title "Well Dynamics", navTitle "Well Dynamics", badge "Production", `bc: 'dc-b-green'`.
- **Dashboard tile** from the registry entry (`renderHome`, sidebar order) — no host edit.
- **Cross-links.** Well Performance gets one `.rp-skip` button `#wp_go_welldyn` "▶ Play in time (Well Dynamics)" in the step ⑤ header
  and on the KPI strip; Well Dynamics has `#wd_go_wellperf` "Back to nodal analysis". Both call the host `nav(route)`; nothing is written
  across pages (both read the same model).
- **WD0 host edit and checks:** `__NAV_ORDER` only; `tests/sidebar-nav.test.js` Production & Reservoir rows become
  `['prism', 'oilgas', 'solgor', 'hub:perf', 'welldyn', 'buildup']` (6 rows); `ux-layout-check.js` must report the 1280×800 fit
  without scrolling; the help group routes list gains `welldyn`.

### 2.2 Files, lanes and public symbols

All new code files are Round-9 plug-ins (`4N-calc-*.js`, auto-discovered; ties by name). Every cross-file reference is resolved at call
time (`typeof G.X === 'function'`, else `{ok:false, code:'MISSING_ENGINE', name}`), so load order never matters.

| File | Kind | Public symbols | Lane |
|---|---|---|---|
| `49-calc-wd-engine.js` | engine | `WTS_wd_engine` (`create`, `ext`, `REGIMES`, `STATES`, `CHANNELS`, `VERSION`, `hash`) | WD1 |
| `49-calc-wd-res.js` | engine | `WTS_wd_res` (`create`, `f`, `derivative`, `horner`) | WD1 |
| `49-calc-wd-lift.js` | engine extensions | registers `WTS_wd_engine.ext.foamer / gaslift / esp / cycle / heading`; `WTS_wd_lift` (helpers, defaults, `PRESETS`) | WD4 |
| `49-calc-wd-view.js` | drawing | `WTS_wd_view` (`wellbore`, `navigator`, `closeUp`, `depthLog`, `trend`, `nodal`, `whpRate`, `stateStrip`, `STATE_COLORS`) | WD2 |
| `49-calc-wd-rec.js` | recorder / files | `WTS_wd_rec` (`create`, `fromFile`, `RUN_FORMAT`), `WTS_wd_cases` (`list`, `save`, `remove`, `toScenario`) | WD3 |
| `49-calc-welldyn.js` | page | `renderWellDyn`, `calcWellDyn`, `WTS_state.welldyn`, `WTS_welldyn_page` (test hook), registry entry `welldyn` | WD3 |
| `48-calc-help-welldyn.js` | help data | guide factory for route `welldyn` (PART route, §8) | WD6 |
| `prism-build/welldyn-validate.js` | tool | `--gate`, `--check`, `--time`, `--html` | WD5 |
| `tests/_welldyn-shapes.js` | frozen fixture | §3.9 | WD0 |
| `tests/_welldyn-mock.js` | test double | `installWellDynMock(G, opts)` (§3.10) | WD0 |

WD0 ships every code file above as a **stub** (single IIFE, the namespace with functions that return
`{ok:false, code:'NOT_BUILT'}` and push their names to `window.__WD_STUBS`; the page stub renders a card "Well Dynamics is being built"),
so the smoke test, the registry and the sidebar are complete from WD0 on; each lane replaces its own files wholesale and removes its
names from `__WD_STUBS`.

### 2.3 Tests (new files)

| File | Owner | Content |
|---|---|---|
| `welldyn-shapes.test.js` | WD0 | fixtures frozen (hash pin), shapes, stubs listed, the `dyn` model key additive (wellperf identity), sidebar row and tile |
| `welldyn-names.test.js` | WD0 | banned-name grep over every Well Dynamics file (the list of `wellperf-names` + the module's own) |
| `welldyn-engine.test.js` | WD1 | EN1–EN22 (§5.2) |
| `welldyn-res.test.js` | WD1 | RS1–RS10 |
| `welldyn-gate.test.js` | WD1 (G1–G4), WD4 (G5–G6) | the consistency gate per fixture |
| `welldyn-view.test.js` | WD2 | VW1–VW14 on the mock and the recording canvas |
| `welldyn-rec.test.js` | WD3 | RC1–RC16 |
| `welldyn-page.test.js` | WD3 | PG1–PG24 on the mock; PG25–PG28 with the real engine (`integration: true`, after WD1 merges) |
| `welldyn-lift.test.js` | WD4 | LF1–LF20 |
| `welldyn-validate.test.js` | WD5 | the `--check` quick subset and the `--time` evaluation counts |
| `help-content.test.js` (edit) | WD6 | the help file cap, PART route |

Estimated +140 acceptance tests; smoke +4 checks (§9, WD0).

### 2.4 Data flow

```
 wts_page_wellperf ─┐                         wts_page_welldyn (wd_* scenario scalars)
 wts_wellperf_model ┴─► WTS_wp_model.read() ─► M (frozen) ──┐   M.dyn (cases, reservoir transient inputs)
                                                             ▼
   WTS_wd_engine.create(M, opts)
     ├─ R0 = WTS_wp_system.solve(M)       steady reference: op, corr keys, temperature profile, traverse, loading, choke regime
     ├─ F  = WTS_wp_fluid.build(M.fluid, {T_F, table:true})   one PVT path (props via WTS_flowline_props)
     ├─ W  = WTS_wp_well.build(M.well, …)  segments / stations → the cell grid (§4.2)
     ├─ I  = WTS_wp_ipr.curve(M.res, F)    → WTS_wd_res.create(I, M, opts.reservoir)
     ├─ line table p_dn(q) from WTS_flowline_march (flowline + separator)
     └─ ext.init for each active extension (foamer / gaslift / esp / cycle / heading)
   sim.step / sim.run ─► S (state) ─► WTS_wd_rec (series + snapshots) ─► WTS_wd_view (canvas) ─► page (#wd_res, reports, CSV, .wdrun)
```

Engines are pure (no DOM, no storage, no timers). Only the page touches storage (through `WTS_wp_model.write` and the host autosave) and
only the page runs the frame loop.

### 2.5 Rules for parallel lanes

- Each lane owns its files (§2.2, §2.3). Shared files: host + `sidebar-nav.test.js` + `smoke-test.js` + `49-calc-wp-model.js` (WD0 only);
  `49-calc-wellperf.js` (WD3: the cross-link button only, with `wellperf-page` unchanged); `help-content.test.js` (WD6); CLAUDE.md,
  PROJECT-NOTES.md, RELEASE_NOTES (WDI only).
- Lanes code against §3 only. A contract change goes through the lead (a §11 record + a fixture hash bump), never silently.
- The mock (§3.10) lets WD2 / WD3 build and test without the engine; WD1 does not depend on WD2 / WD3.
- Naming rule (WD-D14) in code, comments, labels, help, tests and commit messages.
- Nothing edits 31/32/38, 22-units.js, the PRiSM files, or any `49-calc-wp-*.js` engine other than the WD0 `dyn` key.

---

## 3. Contracts (frozen at WD0)

### 3.0 Common rules

- Units: time **s** in the engine API (the page displays h:mm:ss), pressure psia (`*_psig` where named), T °F, MD / TVD ft, diameters
  in, rates STB/d (oil, condensate, water), Mscf/d (gas, lift gas), masses lbm, volumes bbl (inventory) / ft³ (cells), velocities ft/s,
  surface tension dyn/cm, frequency Hz, foamer concentration ppm (mass in water).
- Results `{ok, errors[], warnings[{code, msg, sev:'info'|'warn'}], …}`; nothing throws for user data; programming errors throw.
- Typed arrays: cell fields are `Float64Array(n)`, face fields `Float64Array(n + 1)`, regime codes `Uint8Array(n)` indexing
  `WTS_wd_engine.REGIMES`. Index 0 = the bottom cell (mid-perforations); face 0 = the sandface inlet, face n = the wellhead (choke inlet).
- Callers treat `sim.state` as read-only; it is a live object updated in place by `step()` (no copy per step).

### 3.1 `WTS_wd_engine.create(M, opts) → sim | {ok:false, code, errors}`

```js
opts = {
  cells: 60,                         // 20..200; snapped to segment breaks (§4.2)
  start: 'steady' | 'static' | 'snapshot',
  static: { kind: 'gas' | 'liquid' | 'level', liquidTopMd: null /*ft, kind 'level'*/, liquid: 'water' | 'oil' | 'kill', killSg: 1.05 },
  snapshot: null,                    // a Snap (start 'snapshot')
  reservoir: { mode: 'ipr' | 'transient', k, h, phi, ct, mu, B, rw, re, S, tPrior_h: 720, potential: 'auto' | 'p' | 'p2' | 'mp' },
  closure: 'corr' | 'driftflux',     // WD-D4; default 'corr'
  fallback: false,                   // liquid fallback below the critical velocity (§4.10; provisional; Q1)
  order: 1 | 2,                      // transport order (2 = MUSCL / minmod)
  cfl: 0.5, dtMax: 60, dtMin: 1e-3, dpMaxFrac: 0.02,
  temperature: 'frozen' | 'relax', tauT_h: 2,
  choke: { subcritical: 'nodal' | 'sachdeva', strokeTime_s: 10 },
  ext: { foamer: {...}, gaslift: {...}, esp: {...}, cycle: {...}, heading: {...} },   // §3.3 (absent → each ext's defaults / off)
  events: []                         // Event[] scheduled from t = 0 (§3.5)
}
sim = {
  ok: true, version: '1.0.0', M, R0 /*the steady reference solve*/, mHash /*hash16 of the canonical M + opts*/,
  grid,                              // §3.2
  state: S,                          // §3.2
  step(dt?)            → StepInfo {ok, t, dt, iters, rejects, massErr:{G, O, W}, applied:[Event], code?},
  run(seconds, o?)     → {ok, t, steps, wallMs, stopped: 'target'|'wall'|'steps'|'end'|'error', code?}   // o {maxWallMs, maxSteps}
  snapshot()           → Snap (§3.6),
  restore(snap)        → {ok, code?}  ('MODEL_MISMATCH' when snap.mHash ≠ sim.mHash; 'VERSION' when snap.engine major differs),
  schedule(events)     → {ok, n},      // add Event[]; times ≥ state.t
  setChoke(bean64),    shutIn(),  open(),  setSeparator(psig),
  setFoamer({on, ppm, injMd}),  setLift(spec /*{type:'gaslift', qinj_Mscfd, mode:'valves'|'nodal'} | {type:'esp', on, freq, ramp_Hz_s}*/),
  steadyCheck(win_s?)  → {steady, dq, dp},          // the §5.1 criterion on the engine's own ring buffer
  on(type, fn), off(type, fn),       // synchronous engine events (§3.5); no DOM events
  dispose()
}
```

All `set*` / `shutIn` / `open` calls are converted into Events at the current `state.t` and go into the event log, so an interactive
session is a scenario (WD-D8). `create` performs one `WTS_wp_system.solve(M)` (≈ 16–20 E, §5.6); a model with no stable root cannot use
`start: 'steady'` (`code: 'NO_STEADY'`) and offers the static start.

### 3.2 Grid and state

```js
grid = { n, cells: [{ i, md0, md1, mdc, tvd0, tvd1, tvdc, len /*ft MD*/, dz /*ft TVD, + up*/, inc /*deg from vertical*/, id /*in*/,
                      area /*ft²*/, vol /*ft³*/, rough /*in*/, kind: 'tubing'|'casing'|'liner'|'annulus', seg /*segment index*/,
                      corr /*registry key of this section*/ }],
         faces: [{ md, tvd, restr: {d, k} | null }],
         eotCell, pumpFace /*or -1*/, valveCells: [{ n, md, cell }], gaugeCells: [{ md, cell }],
         traj: [{ md, tvd, dep, n, e }] /*W.stations, for the view*/ }
S = {
  t, dt, n /*steps*/, open, bean64, beanEff /*during a stroke*/, psep_psig,
  cells: { p, T, ag, ao, aw, mG, mO, mW, mF, vg, vl, vm, rhoM, vc, sigF, regime },   // psia, °F, fractions, lbm, ft/s, lbm/ft³, ft/s, –, codes
  faces: { Q /*ft³/s mixture*/, jg, jo, jw /*ft/s superficial*/ },
  surface: { thp, thp_psig, tht, pDn_psig, qo, qw, qg, qL, glr, gor, wc, regime: 'critical'|'subcritical'|'closed'|'none', y },
  bottom:  { pwf, pr, qo, qw, qg /*sandface, stock-tank*/, drawdown },
  well:    { state /*STATES key*/, since, reason, prev },
  loading: { method: 'turner'|'coleman', qc_MMscfd, limitingMd, limitingTvd, ratio, vRatioMin },
  inventory: { liq_bbl, liqTubing_bbl, gas_Mscf, liquidTopMd, gasCapBottomMd },
  balance: { m: {G, O, W}, cumIn: {G, O, W}, cumOut: {G, O, W}, errStep, errCum },
  lift: { gl: null | {...}, esp: null | {...} },    // filled by the extensions (§3.3)
  foamer: { on, ppm, eff },
  res: { mode, terms, f0 },
  flags: [{ code, sev, msg }],
  provisional: [ /*method keys active so far in this run (§4.14)*/ ]
}
```

`WTS_wd_engine.REGIMES = ['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown']` (the
keys of `WTS_wp_view.PATTERN_COLORS`). `WTS_wd_engine.STATES` (§4.13) is a frozen table
`{key: {label, sev, kinds:['gas'|'oil'|'gl'|'esp']}}` with keys `stable, startup, unloading, marginal, loading, heading, dying, dead,
shutin, gl_unloading, gl_lifting, gl_multipoint, esp_off, esp_ramp, esp_running, esp_pumpoff, esp_gaslock, esp_tripped`.

### 3.3 Extensions (WD-D13)

```js
WTS_wd_engine.ext[key] = {
  key, label, verified: false, provisional: 'text',
  applies(M, opts)          → boolean,
  init(sim, opts)           → ctx /*JSON-safe state of the extension*/,
  control(sim, ctx, t)      → Event[] | null,          // once per step before the pressure solve (cycle controller, ESP trips)
  sources(sim, ctx, dt)     → { G?: Float64Array(n), O?, W?, F? } | null,   // lbm/s per cell (gas-lift valves, kill fluid U-tube)
  faceDp(sim, ctx, k, Q)    → { dp /*psi, + = pressure rise in the flow direction*/, ddpdQ /*psi per ft³/s*/ } | null,   // ESP
  sigma(sim, ctx)           → Float64Array(n) | null,  // surface-tension factor per cell (foamer)
  after(sim, ctx, info)     → void,                     // after the transport (annulus mass, valve states, ESP motor)
  label(sim, ctx)           → { state, reason } | null,  // lift states override the base label
  snapshot(ctx) → any (JSON),  restore(json) → ctx
}
```

The engine calls the hooks in this order every step: `control` → pressure solve (with `faceDp`) → `sources` → transport → `after` →
`sigma` (for the next step) → labels. An extension may only write its own `ctx` and `S.lift.*` / `S.foamer`. WD1 tests the hook order and
contract with a dummy extension (EN20); WD4 implements the five real ones.

### 3.4 Recorder `WTS_wd_rec.create(o) → rec`

```js
o = { every_s: 10, snapEvery_s: 60, capMB: 32, channels: null /*all*/ }
rec = {
  attach(sim)                → subscribes to sim 'step' and records when t crosses the next sample time (and on every 'event' / 'state'),
  sample(sim, force?)        → bool,
  channels()                 → [{ key, label, unit /*field unit*/, cat /*units-layer category or null*/, dp }],   // = WTS_wd_engine.CHANNELS
  times()                    → Float64Array view,  series(key) → Float64Array view (same length as times),
  at(t)                      → { t, values: {key: v} }  (linear between samples; step channels hold),
  snapAt(t)                  → Snap | null (the latest snapshot at or before t),
  truncate(t)                → drops everything after t (the "Continue from here" branch),
  mark(t0, t1, label)        → id,  marks() → [{id, t0, t1, label}],  unmark(id),
  events()                   → Event[] (the applied log),
  csv(o)                     → string   // o {cols:[keys], from, to, every_s, system:'field'|'metric', u /*the page's converter*/, decimalComma}
  toFile(meta)               → RunFile (§3.7),
  bytes()                    → number (estimate), clear()
}
WTS_wd_rec.fromFile(obj | text) → { ok, run /*RunFile, validated*/, rec /*a rec filled from the file*/, warnings, code? /*'FORMAT'|'VERSION'|'TOO_BIG'*/ }
```

`WTS_wd_engine.CHANNELS` (frozen order; CSV column keys): `t` (s), `thp` (psig), `tht` (°F), `pwf` (psia), `pr` (psia), `pcs` (psig,
gas lift), `qo`, `qw`, `qL` (STB/d), `qg` (Mscf/d), `qo_res`, `qw_res` (STB/d), `qg_res` (Mscf/d), `gor` (scf/STB), `wc` (fraction),
`bean` (/64 in), `open` (0/1), `state` (index in STATES), `lratio` (q / q_c), `qc` (MMscf/d), `liq` (bbl in the tubing and liner),
`gascap` (ft, MD of the gas–liquid interface when shut in, else NaN), `qinj` (Mscf/d), `opValve` (n or 0), `pint` (psia), `freq` (Hz),
`load` (fraction), `foam` (ppm at the bottom cell), `dt` (s), `massErr` (relative, cumulative).

Cap rule: when `bytes()` exceeds `capMB`, every second snapshot older than the last hour of simulated time is dropped (repeatable);
series are never dropped (24 h at 10 s ≈ 8,640 samples × 30 channels × 8 B ≈ 2.1 MB).

### 3.5 Events

```js
Event = { t /*s*/, type: 'open'|'shutin'|'bean'|'psep'|'foamer'|'gl'|'esp'|'cycle'|'mark'|'end', args: {}, src: 'user'|'scenario'|'controller' }
```

`args`: bean `{bean64}`; psep `{psig}`; foamer `{on, ppm, injMd}`; gl `{qinj_Mscfd, mode}`; esp `{on, freq, ramp_Hz_s}`; cycle
`{mode:'timer'|'pressure', open_h, shut_h, cycles, pOpen_psig, pClose_psig, qClose_Mscfd, minOpen_h, minShut_h}`; mark `{label, t1}`.
Engine events (`sim.on`): `'step'` (StepInfo), `'event'` (an applied Event), `'state'` ({from, to, t, reason}), `'valve'` ({n, open,
passing, t}), `'trip'` ({kind, t}), `'warn'` ({code, msg}), `'end'`.

### 3.6 Snapshot (versioned, JSON-safe)

```js
Snap = { kind: 'wd-snap', v: 1, engine: '1.0.0', mHash, n, t, steps, dtPrev,
  cells: { mG, mO, mW, mF, T, p },  faces: { Q },                    // plain arrays (numbers round-trip exactly through JSON)
  ctl: { open, bean64, beanEff, strokeLeft_s, psep_psig },
  res: { mode, terms: [[t_s, dPhi]], base, qPrev: {o, w, g} },
  labels: { state, since, ringT: [], ringLiq: [], ringQ: [], ringP: [] },
  pend: [Event], log: [Event], ext: { key: json },
  bal: { m0: {G, O, W}, cumIn: {G, O, W}, cumOut: {G, O, W} }, prov: [] }
```

`restore(snapshot())` followed by `run(T)` is bit-identical to an uninterrupted `run` (EN15). A Snap of 60 cells ≈ 6–10 kB as JSON.

### 3.7 Replay file (`.wdrun`, JSON, MIME application/json)

```js
RunFile = { format: 'wts-welldyn-run', v: 1, app /*RELEASE_NOTES[0].ver*/, created /*ISO*/, engine: '1.0.0',
  well: { name },                                       // display only (the WTS_wells name), escaped on display
  model: { scalars: {wp_*: v}, tables: {survey, strings, restrictions, geo, flowline, rating, beans, lab, pump, corrSections, layers, glValves} },
  settings: { …opts of §3.1 except snapshot },  events: [Event], duration_s,
  rec: { every_s, t: [], ch: { key: [] }, marks: [] },
  snaps: { every_s, list: [Snap] } | null,              // dropped (null) when the file would exceed 5 MB
  summary: Summary (§3.8), hash /*hash16 of model + settings + events*/ }
```

The `model` part uses the same scalar / table form as a Well Performance case (`WTS_wp_cases`), so M is rebuilt the way
`WTS_wp_cases.model(c)` does it (`WTS_wp_model.read` on an in-memory record and scalars), without touching storage. Opening a run never changes the stored well model; "Adopt this model for the well" is a separate,
confirmed action (WTS_wp_model.write + host autosave of the scalars), off by default (Q14).

### 3.8 Cases and summary

```js
Case = { id, name /*≤ 60 chars*/, created, settings, events, duration_s, summary: Summary | null, note /*≤ 200 chars*/ }
Summary = { duration_s, endState, states: [{key, from, to}] /*≤ 50*/, qo, qw, qg /*at the end*/, thp_psig, pwf, qMax, qMin, thpMax_psig,
            pwfMax, liqMax_bbl, tLoading_h, tDead_h, cumO_STB, cumW_STB, cumG_MMscf, buildup: { pws_end, dpdlnDt, k_est } | null,
            gate: { dq, dp } | null, provisional: [], massErr }
WTS_wd_cases.list(M) → Case[] (from M.dyn.cases)
WTS_wd_cases.save(case) → WTS_wp_model.write({dyn: {...}}) result (≤ 20 cases, ≤ 24 kB of dyn in total; oldest unnamed dropped first)
WTS_wd_cases.remove(id), WTS_wd_cases.toScenario(case) → {settings, events, duration_s}
```

### 3.9 Frozen fixtures `tests/_welldyn-shapes.js` (WD0, hash-pinned like `_wellperf-shapes.js`)

Built from the Well Performance fixtures (`require('./_wellperf-shapes').FIX`) with the changes listed; WD0 runs `WTS_wp_system.solve` on
each one, adjusts only the numbers marked *(tune)* within the stated range so the stated condition holds, and pins the steady reference
(`expect.op`: q, pwf, thp, regime) and the fixture hash. All are complete models M (SHAPE.M of the Well Performance shapes).

| FIX | Built from | Changes | Condition WD0 confirms |
|---|---|---|---|
| `gasVert` | wellperf `gasWell` | vertical survey `[[0,0],[10000,10000]]`, 2-7/8" tubing to 9,850 ft, p̄r 3,500 psia, WGR 10 STB/MMscf, separator 500 psig, bean 24 *(tune 16–32)* | stable root, **critical** choke, loading margin ≥ +0.3 |
| `gasLoad` | `gasVert` | p̄r 1,200 psia, WGR 30 STB/MMscf, separator 300 psig, bean 32 *(tune)* | loading margin in [−0.05, +0.10] at bean 32; < −0.15 at bean 16 |
| `gasHz` | `gasWell` | survey vertical to 7,000 ft, build 8°/100 ft to 90°, 2,000 ft lateral (azimuth 120°); tubing to the heel, 4-1/2" liner along the lateral; mid-perf at the lateral midpoint; bean 24 *(tune)* | stable root, critical choke |
| `oilVert` | wellperf `oilWell` | none (bean 32) — if the nodal choke regime is not critical, bean *(tune 24–32)* | stable root, critical choke |
| `oilDev` | `oilWell` | the S-shaped `GAS_SURVEY` (MD 10,000 ft), mid-perf 9,950 ft MD, strings extended (tubing to 9,850 ft) | stable root, critical choke |
| `gasLift` | `oilWell` | WC 0.6, GOR 200, p̄r 2,400 psia *(tune)*; lift `gaslift`, packer 7,900 ft, q_inj 600 Mscf/d, p_inj 1,100 psig, sginj 0.65; `glValves` = `WTS_wp_gl.valvesFromDesign` of the WTS_wp_gl.design result on this model (pinned rows) | no natural stable root; stable root with gas lift (nodal injection) |
| `esp` | `oilWell` | WC 0.8, GOR 100, p̄r 2,500 psia; lift `esp`, pump MD 7,500 ft, 60 Hz, pump = `WTS_wp_esp.example()`, stages from `sizeStages` at 1,500 STB/d *(pinned)* | stable pumped root in the recommended range |
| `staticOil` | `oilVert` | none; settings `start:'static', static:{kind:'liquid'}` | the well flows after opening |
| `buildup` | `oilVert` | IPR `darcyOil` with k 50 md, h 50 ft, rw 0.354 ft, re 1,500 ft, S 2, φ 0.2, ct 1.5e-5 1/psi (μ, B from the fluid) | J of `darcyOil` within 1 % of the `pi` it replaces |

Also `FIX.scenarios` (Event lists + durations): `beanUp` (beans 16 → 24 → 32 at 0 / 1 / 2 h, 4 h), `shutInBuildup` (steady 2 h, shut in
8 h), `gasLoadDown` (gasLoad: bean 32 → 16 at 1 h, 8 h), `cycleTimer` (gasLoad: 2 h open / 2 h shut × 3), `foamerOn` (gasLoad at bean
16, foamer 1,000 ppm at 4 h, 10 h), `glUnload` (gasLift static, annulus and tubing full of kill fluid sg 1.05, injection 600 Mscf/d from
0, 12 h), `espStart` (esp static liquid, start 0 → 60 Hz at 1 Hz/s, 2 h).
Shapes: `SHAPE.Sim`, `SHAPE.State`, `SHAPE.StepInfo`, `SHAPE.Snap`, `SHAPE.Event`, `SHAPE.Rec`, `SHAPE.RunFile`, `SHAPE.Case`,
`SHAPE.Summary`, `SHAPE.Ext`, `checkShape(name, obj)`. Helpers: `sharedApp(ctx, opts)`, `resetWellDyn(app)` (clears `wts_page_welldyn`,
the `dyn` key, `WTS_state.welldyn`, device prefs `wtspref_wd_*`), `loadFix(app, key)` (writes the fixture through `WTS_wp_model.write`
and the scalar store), `files()`, `STUBS`, `BASELINE` (WD1 fills the step timing, §5.6).

### 3.10 Mock engine `tests/_welldyn-mock.js` (WD0; not shipped)

`installWellDynMock(G, opts)` replaces the stubs with a deterministic closed-form stand-in with the **contract shapes**: `create` builds
the grid from the model (minimum curvature on the survey, cells snapped like §4.2), the rate relaxes to `R0.op` (or to 0 shut in) with a
10 min time constant, a liquid level rises / falls with the state, holdups and regimes follow the level, BHP follows a storage-like
exponential, valve / pump fields are filled for gas-lift / ESP fixtures, snapshots / restore / events / `run` / `on` behave as §3 (and are
bit-identical on repeat). `opts.slow` makes `run` cost wall time (page "running slower" path); `opts.fail` returns errors. Also usable as
plain browser code for screenshots (no `require`).

### 3.11 View API `WTS_wd_view` (WD2)

```js
wellbore(canvas, spec) → V { draw(frame), setLayer(k), setZoom(md0, md1), pick(x, y) → {i, cell, info} | null, select(i), destroy() }
  spec = { grid, traj, strings /*outline*/, layer: 'phase'|'regime'|'pressure'|'holdup'|'velocity', exaggerate: 25 /*width ×*/,
           aspect: 'true'|'fit', labels: true, particles: { on: true, max: 300 }, reduced /*prefers-reduced-motion*/,
           fmt: { p(v), md(v), v(v), T(v) } /*display units from the page*/, onHover(info|null), onSelect(i), onZoom(md0, md1) }
  frame  = { t, cells /*S.cells or a recorder snapshot's display arrays*/, faces, markers: [{md, kind:'valve'|'pump'|'gauge'|'eot'|'perf'|'restr', state, label}],
             gasCapMd, liquidTopMd, dtWall /*s since the last drawn frame; 0 when scrubbing*/, playing }
navigator(canvas, spec) → { draw(frame), setWindow(md0, md1) }       // whole-well minimap, drag the window → spec.onWindow(md0, md1)
closeUp(canvas, info, spec) → void                                    // one cell: pipe section with film, droplets, bubbles, slugs from α / regime / velocities
depthLog(canvas, frame, spec) → chart state                          // WTS_wp_view.chart: p, α_L, v_g vs v_c vs MD (inverted); regime hbands; markers
trend(canvas, rec, spec) → chart state                               // WTS_wp_view.chart over rec series; spec {keys, window:[t0,t1], cursor t, marks}; lineX handle = scrub → spec.onScrub(t, phase)
nodal(canvas, spec) → chart state                                    // R0.curves.ipr / vlp, the steady op (filled marker), the live point (pwf, q_res) + a trail
whpRate(canvas, rec, spec), stateStrip(canvas, rec, spec)
STATE_COLORS = { stable, startup, unloading, marginal, loading, heading, dying, dead, shutin, gl_*, esp_* }   // theme-aware, WTS_wp_view.theme()
```

Particles are deterministic (a low-discrepancy sequence per cell, no `Math.random`), advected by the local phase velocities on a visual
scale (`v_vis = sign(v)·min(v_cap, 0.3·log10(1 + |v|/0.05))` cell lengths per wall second; reduced motion → no particles, arrows only).
The wellbore canvas sets its size from fixed CSS sizes (as WTS_wp_view), so it draws in a hidden panel and in the report.

---

## 4. Physics (equations with units)

Notation: i = cell (0 bottom … n−1 top), k = face (0 … n), Δt s, ΔL_i ft (MD), ΔZ_i ft (TVD, + up), A_i ft², V_i = A_i ΔL_i ft³,
θ_i inclination from vertical (deg), g/g_c = 1 lbf/lbm in field units, so ρ (lbm/ft³) × ΔZ (ft) / 144 = psi.

### 4.1 Components and the flash (black oil, one path through `WTS_wp_fluid`)

Conserved per cell: gas component m_G, stock-tank oil (or condensate) m_O, water m_W, foamer m_F (lbm). With γ_o, γ_g, γ_w the
stock-tank gravities and the app's base conditions (`WTS_baseConditions`, the same as `WTS_flowline_props` uses for B_g):

- N_o (STB) = m_O / (350.17 γ_o), N_w (STB) = m_W / (350.17 γ_w), G (scf) = m_G / (0.076362 γ_g).
- Properties at (p_i, T_i): R_s, B_o, B_w, B_g (ft³/scf), ρ_o, ρ_w, ρ_g, μ_o, μ_w, μ_g, σ_o, σ_w from **one** call per cell per step of
  `WTS_flowline_props(WTS_wp_fluid.flowlineFluid(F, F.refQ), p, T)` (the (p, T)-binned table of `F.pvt.table`). These phase properties do
  not depend on the rate argument (only the in-situ mixing fractions do, which the engine computes itself).
- Dissolved gas G_d = min(G, N_o R_s); free gas G_f = G − G_d. Wet gas (`pvt.liquidNoTransfer`, D14 of the Well Performance plan):
  R_s = 0, B_o = B_c (constant).
- Phase volumes (ft³): V_o = 5.6146 N_o B_o, V_w = 5.6146 N_w B_w, V_g = G_f B_g; holdups α_k = V_k / (V_o + V_w + V_g).
- Volume compressibility of a cell (ft³/psi), for the pressure coupling:
  ∂V/∂p = 5.6146 N_o ∂B_o/∂p + 5.6146 N_w ∂B_w/∂p + G_f ∂B_g/∂p − B_g N_o ∂R_s/∂p (gas liberation, below p_b),
  by a one-sided difference of the table (Δp = 1 psi). Above p_b, ∂B_o/∂p = −c_o B_o (Vasquez-Beggs c_o of the fluid).

### 4.2 Discretisation

- The flow path is `WTS_wp_well.segmentsFor(W)` from the mid-perforations to the wellhead (tubing, then casing / liner below the end of
  tubing; the annulus path when `M.well.path = 'annulus'`). n cells (default 60, 20–200) are allotted to segments in proportion to MD
  (at least one per segment, largest remainder), so **no cell straddles a bore change, a restriction, the end of tubing, a gas-lift valve
  or the pump depth** (those MDs are added as forced breaks before the allotment). Each cell carries its segment's ID, roughness,
  inclination (cell-average from the stations) and exact ΔZ from minimum curvature (gravity on TVD, friction on MD — as the nodal march).
- A restriction (SSSV, nipple, downhole choke) is a face loss Δp = k ρ_m v_m² / (2 g_c · 144) at its face, the same k as the nodal model.
- Horizontal sections are ordinary cells with θ = 90° (ΔZ ≈ 0): gravity vanishes, the drift closure uses the inclination form (§4.4).

### 4.3 Conservation

For each component c ∈ {G, O, W, F}:

  m_c,i^{n+1} = m_c,i^n + Δt (F_c,k=i − F_c,k=i+1 + S_c,i)        (lbm; F lbm/s at faces, + upward; S lbm/s from extensions)

Face mass fluxes from the superficial velocities (ft/s) and the **upwind** cell's properties (upwind per phase by the sign of the phase
velocity):

  F_O = A j_o (350.17 γ_o) / (5.6146 B_o)        (j_o ft/s in situ; 350.17 γ_o lbm per STB; 5.6146 B_o ft³ per STB)
  F_W = A j_w (350.17 γ_w) / (5.6146 B_w)
  F_G = A j_g ρ_g + R_s (0.076362 γ_g) · A j_o / (5.6146 B_o)        (free gas + gas dissolved in the oil)
  F_F = A j_w ρ_w · c_F                                              (foamer travels with the water, c_F = m_F / m_W)

Face 0 carries the reservoir inflow (stock-tank rates of §4.7 converted to lbm/s); face n carries what leaves through the choke. The
scheme is conservative: Σ_i m_c changes exactly by Δt (F_c,0 − F_c,n + Σ S_c) up to round-off (§5.2, EN2).

### 4.4 Drift-flux closure (WD-D4)

At face k with mixture flux j = Q_k / A (ft/s) and the upwind gas fraction α_g:

  j_g = α_g (C_0 j + v_d),   j_L = j − j_g,   j_w = f_w j_L − φ_ow,   j_o = j_L − j_w

with f_w the upwind water fraction of the liquid and φ_ow the oil–water settling flux of §4.10.

**`driftflux` closure** (provisional, D17 — no verified worked example; the coefficients to verify against the papers):

- Zuber & Findlay (1965) form; profile parameter of Shi et al. (2005): C_0 = A / (1 + (A − 1) γ²), γ = clamp((β − B)/(1 − B), 0, 1),
  β = max(α_g, F_v α_g |j| / v_sgf), A = 1.2, B = 0.3, F_v = 1; v_sgf = the flooding (Kutateladze) velocity
  K_u (σ g Δρ / ρ_g²)^¼ with K_u from the Wallis-Makkenchery fit of the critical Kutateladze number on the dimensionless diameter.
- Drift velocity: v_d = (1 − α_g C_0) C_0 K(α_g) v_c m(θ) / (α_g C_0 √(ρ_g/ρ_L) + 1 − α_g C_0),
  v_c = (σ g Δρ / ρ_L²)^¼ (ft/s with σ dyn/cm → lbf/ft by × 6.852e-5 and g = 32.174 ft/s² with g_c), K = 1.53 for α_g ≤ a_1 = 0.06,
  K = K_u for α_g ≥ a_2 = 0.21, linear between; inclination factor m(θ) = m_0 (cos θ)^{n_1} (1 + sin θ)^{n_2} with m_0 = 1.27,
  n_1 = 0.24, n_2 = 1.08 (Shi et al. 2005; θ from vertical) — values to verify (Q9).
- Liquid properties: the upwind liquid mixture (oil + water by volume); σ = σ_L · sigF_i (foamer factor, §4.11).

**`corr` closure** (default):

- At every face, once per step, the correlation of the cell's section (`grid.cells[i].corr` — the key the steady reference used,
  `R0.corr.well`, or the per-section keys) is evaluated with the face's lagged superficial velocities (v_sL, v_sg of the last step), the
  face properties and the cell inclination, through `WTS_flowline_corr[key].grad(inp)` (the exact `inp` object the marcher builds in
  `_gAt`, 49-calc-flowline.js; WD1 reads it there). From its holdup H_L:
  C_0 = 1, v_d,corr = v_sg / (1 − H_L) − (v_sL + v_sg), clamped to [0, 3 v_d,ZF] (v_d,ZF = the drift-flux value above).
  At a fixed point (steady flow) the cell gas fraction is then exactly 1 − H_L of the correlation.
- Below a low mixture velocity the correlation holdup has no meaning (counter-current flow, shut-in). Blend weight
  w = smoothstep((|j| − j_lo)/(j_hi − j_lo)), j_lo = 0.2 ft/s, j_hi = 1.0 ft/s: C_0 = w + (1 − w) C_0,DF, v_d = w v_d,corr + (1 − w) v_d,DF.
  The gate fixtures flow with |j| > j_hi in every cell (checked by the gate; EN11).

### 4.5 Quasi-steady momentum (pressure profile)

Given the wellhead pressure p_n (face n) of the trial, faces are filled downward:

  p_k = p_{k+1} + [ ρ_m,i ΔZ_i + (dp/dL)_f,i ΔL_i · 144 ] / 144 / (1 − E_k,i) + Δp_restr,k − Δp_pump,k          (psi)

- ρ_m,i = Σ α_k ρ_k of the cell (lbm/ft³) at the **current** holdups (the storage term — a column that loses gas gets heavier);
- (dp/dL)_f,i (psi/ft) = the correlation's friction gradient `gradF` evaluated once per step at the cell's (v_sL, v_sg) and scaled to the
  trial mixture flux by (j_trial / j_last)·|j_trial / j_last| (so the root iterations cost O(n) arithmetic, no correlation call); for
  |j| < j_lo the single-phase Fanning gradient of the mixture (`WTS_flowline_friction`); `driftflux` closure: the same correlation
  friction gradient (only the holdup closure changes);
- E_k = the correlation's acceleration factor (`Ek`, clamped to ≤ 0.9) when the correlation applies it (the same rule as the marcher), else 0;
- Δp_restr from §4.2; Δp_pump from the ESP extension's `faceDp` with its derivative (§4.12).
- Cell pressure p_i = ½ (p_k + p_{k+1}); BHP = p_0 (mid-perforations, the nodal bottom node).

### 4.6 Pressure coupling, time step and integrator

**Volume constraint.** The mixture volume flux leaving the top of cell i (ft³/s) follows from the volume the cell's contents need at the
new pressure:

  Q_{i+1} = Q_i − (∂V/∂p)_i (p_i^{n+1} − p_i^n)/Δt − (V_i^{content}(p_i^n) − V_i)/τ_V + Q_src,i

with V_i^{content} the phase volume sum of §4.1 at the start of the step (its mismatch with the cell volume is relaxed over
τ_V = max(Δt, 5 s), which keeps the volume error bounded — reported as `S.flags` VOL_DRIFT when > 0.5 %), and Q_src,i the in-situ volume
of extension sources. Q_0 = the in-situ volume rate of the reservoir inflow at (p_0, T_0) (§4.7).

**Wellhead root.** Unknown: p_n^{n+1}. For a trial p_n: march §4.5 down → p_0 → inflow (§4.7) → Q_0 → march the volume constraint up →
Q_n. Residual r(p_n) = Q_n − Q_choke(p_n) (§4.8). Bracket [p_dn + 0.01, p_max] (p_max = p̄r + the column), safeguarded secant / Illinois,
≤ 12 iterations, tolerance |Δp_n| ≤ 0.01 psi or |r| ≤ 1e-7 ft³/s. Shut in: Q_choke = 0. No choke (`M.surface.choke.present = false`):
r = p_n − p_dn(Q_n) (the flowline back pressure, or the fixed `M.system.thp_psig` when given — the nodal boundary).
A trial whose march produces a negative pressure is "lost" (as in the nodal scan) and the bracket shrinks.

**Phase fluxes and transport** with the converged Q_k (§4.4, §4.3). Order 1: upwind values; order 2: MUSCL slopes of α with the minmod
limiter (option; the gate uses order 1).

**Time step.**
  Δt = min( dtMax, 1.5 Δt_prev, CFL · min_i ΔL_i / max(|v_g,i|, |v_L,i|, 1e-6), Δt_event, Δt_stroke )
  CFL default 0.5. After the step: if any |p_k^{n+1} − p_k^n| > dpMaxFrac · p_k^n, or a component mass would turn negative, or the
  root failed, the step is **rejected** and retried with Δt/2 (≤ 8 halvings, then `code: 'STEP_FAIL'` and the run stops with a message).
  Δt_event lands a step exactly on the next scheduled event; Δt_stroke resolves a choke stroke in ≥ 5 steps.
**Mass balance** per step: e_c = |Σ m_c^{n+1} − Σ m_c^n − Δt (F_c,0 − F_c,n + Σ S_c)| / max(Σ m_c^n, 1); max_c e_c ≤ 1e-10 (round-off);
the cumulative error vs the initial mass + cumulative in − out ≤ 1e-8 over 24 h (EN2, C2). Reported in `S.balance` and the run summary.

### 4.7 Reservoir (`WTS_wd_res`)

- **Mode `ipr`** (default; exact consistency): sandface stock-tank rates q = I.qAt(p_0) from `WTS_wp_ipr.curve(M.res, F)` (oil: q_o with
  q_w by WC and q_g by GOR; gas: q_g with CGR / WGR liquids), instantaneous. Afterflow and storage then come from the cells only.
- **Mode `transient`** (line source with superposition of the IPR's drawdown). Let Φ be the IPR's potential (`p` for oil and linear
  models, `p²` for back-pressure / LIT p², `m(p)` for LIT m(p) and Darcy gas, chosen by `potential: 'auto'`) and
  u(q) = Φ(p̄r) − Φ(I.pwfAt(q)) the steady drawdown in that potential; split u = u_D (Darcy, time-dependent) + u_ND (non-Darcy b·q² or
  D·q terms, instantaneous) where the model gives the split. Then
    Φ(p̄r) − Φ(p_wf(t)) = Σ_j [u_D(q_j) − u_D(q_{j−1})] · f(t − t_j) + u_ND(q(t))
    f(τ) = clamp( [½ E1(r_w² / (4 η τ)) + S] / [ln(r_e/r_w) − 0.75 + S], 0, 1 ),   η = 0.0002637 k / (φ μ c_t)   (ft²/h, τ in h)
  E1 = `PRiSM_E1` (01-foundation). As τ → ∞ with a constant rate, f → 1 and the inflow equals the IPR (so the gate also holds in
  transient mode after stabilisation, RS5). Before t = 0 the well produced at q_op for `tPrior_h` (default 720 h, one term).
  Each step solves q at the trial p_0 with the past sum precomputed (it does not depend on the current rate): u_D(q_n) =
  u_D(q_{n−1}) + [Φ(p̄r) − Φ(p_0) − u_ND(q_n) − Σ_{j<n} Δu_j f(t − t_j)] / max(f(Δt), 1e-3), by a safeguarded Newton on the monotone u.
  Term compaction: consecutive terms with f(t − t_j) = 1 merge into the base; at most 400 terms (two adjacent terms merge at their
  Δu-weighted log-mean time when the count is exceeded; RS8 bounds the error).
  Parameters: from `M.dyn.res` (page inputs), else from a `darcyOil` / `darcyGas` IPR's params, else `PRiSM_getWell()` on a button; a
  missing parameter keeps the mode `ipr` and says so. Consistency check: the stabilised resistance of the `darcy*` IPR equals the
  denominator (RS2).
- Gas uses Φ = m(p) by `PRiSM_mpTable` (as `WTS_wp_ipr` does) with η at p̄r (pseudo-time not used — provisional for large drawdowns).
- **Verification status (D17):** the infinite-acting line source E1 term is an exact analytical solution — `verified` by identity with
  PRiSM model #1 (homogeneous, Stehfest) on a constant-rate drawdown within 0.5 % for t_D > 100 (RS1, X-check C8). The superposition
  of a non-linear IPR's drawdown, the bounded-reservoir cap at f = 1 (no pseudo-steady depletion in a run) and the gas η are
  **provisional**.

### 4.8 Choke and flowline (surface boundary)

- Downstream pressure p_dn(q): the flowline marched back from the separator by `WTS_flowline_march` (the nodal surface model, its
  correlation and temperature) on 12 rates (0 … 1.5 × max(q_op, 10 % AOF)), tabulated at `create` and re-tabulated when the produced GOR or
  WC drifts by more than 10 % from the table's (cost: 12 line marches, §5.6). Monotone cubic in between.
- Choke rate at p_1 = p_n, p_2 = p_dn, y = p_2 / p_1 (absolute):
  - gas / condensate: `WTS_chokeperf_gasRate` (isentropic nozzle, critical and sub-critical, continuous; the nodal gas choke);
  - multiphase: critical rate q_c(p_1) by inverting the nodal critical correlation at the top cell's GLR (`WTS_chokeperf_multiphaseRate`);
    for y ≤ y_c (Sachdeva critical ratio, `WTS_chokeperf_sachdeva`) q = q_c(p_1) — identical to the nodal choke in critical flow;
    for y > y_c: `subcritical: 'nodal'` (default) q = q_c(p_1) · √(1 − ((y − y_c)/(1 − y_c))²) (a continuous closing shape to zero flow at
    y = 1, provisional) or `'sachdeva'` (the continuous model scaled by the nodal rate factor, provisional per the Well Performance A2
    review). The nodal 'subcritical-bound' is a static conservative construction with no transient meaning; the gate fixtures are chosen
    with critical flow (§3.9).
  - liquid only (GLR < 10 scf/STB): the incompressible orifice of the nodal solver (1022.7 C_d d² √(Δp/SG)).
- Bean changes and shut-in move the effective bean area linearly over `strokeTime_s` (default 10 s); a closed choke is Q_choke = 0.
- Stock-tank rates at the wellhead from the top cell's composition (oil, water, free + dissolved gas), converted to in-situ volume at
  (p_n, T_n) for the residual.

### 4.9 Temperature

`frozen` (default; the gate): T_i = the steady reference's flowing temperature at the cell centre (`R0.traverse` t by MD; the linear,
relaxation or enthalpy profile of the model), kept for the whole run. `relax` (provisional): open → T_i relaxes to the frozen flowing
profile scaled to the current rate, T_target = T_geo + (T_flow − T_geo)·min(1, q/q_op)^½; shut in → T_target = T_geo (geotherm at the
cell TVD); dT_i/dt = (T_target − T_i)/τ_T, τ_T = 2 h (ASSUMED). THT = T of the top cell; the wellhead hydrate margin uses the existing
`WTS_hydrate_temp` check at (THP, THT) once per recorded sample (flag only).

### 4.10 Segregation, settling and liquid fallback

- **Gas–liquid segregation** in a shut-in or slow well comes from the drift closure with j ≈ 0: gas rises at α_g v_d and the liquid
  falls by the same volume (counter-current through each face, upwinded per phase). A gas cap forms at the top and the liquid collects at
  the bottom; `inventory.liquidTopMd` / `gasCapBottomMd` are the MDs where α_L crosses 0.5 from below / above (interpolated).
- **Oil–water (or condensate–water) settling** within the liquid (provisional): φ_ow = α_o α_w / α_L · v_s (1 − α_w)^{2.39} (hindered
  settling, Richardson-Zaki exponent), v_s = v_s0 · (ρ_w − ρ_o)/(ρ_w − ρ_o)_ref, v_s0 = 0.05 ft/s at Δρ_ref = 15 lbm/ft³ (ASSUMED);
  water moves down relative to oil; applied only where |j_L| < j_hi.
- **Liquid fallback** (`fallback: true`, provisional, Q1): where the local gas velocity v_g = j_g/α_g is below the critical velocity
  v_c,i of §4.11, part of the liquid flux reverses: j_L ← j_L − α_L v_fb (1 − v_g/v_c,i), v_fb = 0.5 ft/s (ASSUMED film fall-back
  velocity), limited by the CFL. Off by default (D17); on in the "gas-well loading" scenario preset; zero above the critical velocity, so
  the gate is unaffected.

### 4.11 Critical velocity, foamer and loading

- Critical velocity per cell from the wellhead to the end of tubing (the nodal rule; the rathole below the EOT is reported apart):
  v_c = C σ_e^¼ (ρ_L − ρ_g)^¼ / ρ_g^½ (ft/s; σ_e dyn/cm, ρ lbm/ft³), C = 1.912 Turner et al. (1969, with the 20 % uplift) or 1.593
  Coleman et al. (1991); method by the flowing wellhead pressure as `WTS_wp_loading` (Coleman below 500 psia, Turner above 1,000 psia;
  between, the larger q_c — conservative). **Belfroid et al. (2008) inclination correction:**
  v_c,θ = v_c · [sin(1.7 β)]^{0.38} / 0.74, β = 90° − θ (angle from horizontal), applied for 0° < θ < 90° (deviated cells;
  provisional, as Turner and Coleman are in the nodal module).
- q_c,i (MMscf/d) = 3.067 p_i v_c,i A_i / ((T_i + 460) z_i); `loading.qc_MMscfd` = max_i q_c,i, limiting MD / TVD there;
  `loading.ratio` = q_g,surface / q_c,max; `vRatioMin` = min_i v_g,i / v_c,i. A steady run's q_c equals `WTS_wp_loading` on the same
  model within 2 % (EN12).
- **Foamer** (extension `foamer`, provisional): concentration c (ppm by mass in the water) is transported with the water (§4.3) from the
  injection MD (capillary string) or the surface (batch / down the annulus — injected into the top cell); the effective surface tension
  factor sigF = 1 − r(c), r(c) = r_max c / (c + c_50), r_max = 0.6, c_50 = 500 ppm (ASSUMED; Q10). σ_e = σ_L · sigF lowers v_c by
  sigF^¼ (C11) and the drift velocity (§4.4). Foam density reduction is not modelled (stated in Notes).

### 4.12 Gas lift and ESP (extensions)

**Gas lift** (`gaslift`; provisional except the static gas column and the dome correction, which reuse existing engines):

- Mode `nodal`: the lift gas q_inj enters the tubing cell of `R0.lift.injMd` (the nodal balance-point injection) — used by the gate (G5).
- Mode `valves` (default when `M.lift.gl.valves` has rows): annulus = one control volume from the surface to the packer, volume
  V_a = Σ π/4 (ID_csg² − OD_tbg²)/144 · L; contents: gas mass m_a and a liquid column (kill fluid or produced liquid) of volume V_al with
  its top at MD z_L. Casing surface pressure from the real-gas law on the gas volume above z_L (Z from `WTS_gaspvt_z`, mean annulus T);
  casing pressure at depth: gas column p_c(z) = p_cs exp(0.01875 γ_g ΔTVD / (z̄ T̄_R)) (one Z iteration; cross-checked against
  `WTS_gaslift_casingP` within 0.5 %, LF2), below z_L + ρ_L ΔTVD / 144.
- Valves (IPO, nitrogen dome; `WTS_wp_gl.pdAt` for the dome at the valve temperature, `WTS_wp_gl.portR`): open when
  p_c ≥ p_vo = (p_d − R p_t)/(1 − R), close when p_c < p_vc = p_d (hysteresis); orifice valves always open; dummy valves shut.
  Gas through an open valve above z_L: `WTS_wp_gl.tc({port64, p1: p_c, p2: p_t, T, sg})` (Thornhill-Craver, provisional) → a gas source in
  the valve's tubing cell; liquid through an open valve below z_L: orifice q = C_d A √(2 g_c 144 Δp / ρ_L) (ft³/s, C_d 0.6) → a water
  source; no reverse flow (check valves). Annulus balance: dm_a/dt = ṁ_inj − Σ ṁ_valves,gas; dV_al/dt = −Σ q_valves,liquid.
- Surface injection: constant rate q_inj, or pressure-limited (q = 0 while p_cs ≥ p_inj,max). States: `gl_unloading` (valve n, the
  deepest passing valve is not the operating valve), `gl_lifting`, `gl_multipoint` (> 1 valve passing for > 10 min).
**ESP** (`esp`; provisional except the affinity laws, which are exact similarity relations as in the nodal module):

- The pump is the face `grid.pumpFace`; `faceDp(Q)` = stages · H_f(Q_in) · ρ_in / 144 (psi) with H_f from
  `WTS_wp_esp.curve(pump, f(t), ν).head(Q_in)` (affinity H ∝ f², q ∝ f), Q_in the in-situ intake rate (bbl/d) of the cell below, ρ_in the
  homogeneous intake density; its derivative by a ±1 % difference. A check valve at the discharge: Q ≥ 0 at the pump face.
- Drive: f follows f_cmd at the ramp limit (default 1 Hz/s), then a first-order motor lag τ_m = 0.5 s (ASSUMED; the shaft inertia is not
  modelled otherwise). Natural separation (opt-in, the nodal `natSep`) vents gas from the cell below the pump to the surface.
- Load = `WTS_wp_esp.pump(...)`.bhp / motor hp. States: `esp_off`, `esp_ramp`, `esp_running`, `esp_pumpoff` (p_intake < 50 psia or
  Q_in < 5 % of the BEP rate with f > 30 Hz for 60 s), `esp_gaslock` (intake GVF > 0.3 for 60 s), `esp_tripped` (load < 0.4 for 30 s →
  f_cmd = 0) — thresholds ASSUMED (provisional).

**Intermittent production** (`cycle`, a controller with no physics): `timer` (open_h / shut_h / cycles) or `pressure` (open when the
THP — or CHP for a gas-lift well — reaches p_open; shut when q_g < q_close or THP < p_close; minimum open / shut times). It emits
`open` / `shutin` Events with `src: 'controller'`.

### 4.13 Flow-regime labels and well states

- **Cell regime** (display; provisional where noted): |j| ≥ j_hi → the correlation's own pattern string of the face below
  (`G.pattern`, normalised by `WTS_wp_view.patternKey`; consistent with the nodal traverse); |j| < j_hi → α_g < 0.02 `liquid`,
  < 0.25 `bubble`, < 0.75 `slug`, ≥ 0.98 `gas`, else `annular` when v_sg ≥ 3.1 (σ g Δρ / ρ_g²)^¼ (Taitel, Barnea & Dukler 1980 annular
  transition, provisional) or `churn`; θ > 80° and 0.02 ≤ α_g < 0.98 → `stratified` (Taitel & Dukler 1976 regime, simplified to the
  inclination test, provisional); the cell holding the shut-in gas–liquid interface → `segregated`. Barnea's (1987) unified map is a
  later option (non-goal for v4.6).
- **Well states** (evaluated after every step; a change needs the new condition to persist for 120 s of simulated time; the engine keeps
  its own ring buffer of (t, liq, q_g, p_0) at 30 s spacing for the trends; thresholds ASSUMED and provisional):

| State | Rule (q_ref = the highest surface rate since the last open) |
|---|---|
| `shutin` | choke closed (or a downhole shut-in) |
| `dead` | open and (q_surface < 2 % q_ref, or q_res < 1 % q_ref with p̄r − p_wf < 1 psi) for 10 min |
| `startup` | open, within 10 min of the open, before another rule holds |
| `unloading` | open, d(liq)/dt < −0.05 bbl/min, and (gas wells) ratio ≥ 0.9 |
| `loading` (gas) | ratio < 0.9 and (d(liq)/dt > +0.01 bbl/min or the bottom 3 cells' α_L rising) |
| `marginal` (gas) | 0.9 ≤ ratio < 1.1 |
| `heading` (oil) | from the `heading` extension: ≥ 3 WHP peak pairs in the last 3 h with peak-to-peak > 5 % of the mean and a period 2 min – 3 h |
| `dying` (oil) | q falling > 10 % per hour for 30 min with liq rising |
| `stable` | otherwise, with |d(liq)/dt| ≤ 0.01 bbl/min (gas: ratio ≥ 1.1) |
| lift states | from the extensions (§4.12) override `stable` / `unloading` |

- **Oil heading** is not imposed: it emerges (or the well dies) when the transient is run near or below the static stability limit q_s of
  the nodal solve (D6 of the Well Performance plan). The detector only labels it. LF15 checks that a run right of q_s settles and a run
  forced left of q_s (by the choke) does not settle on that root.

### 4.14 Method table (D17)

| Key | Method | verified | What would verify it |
|---|---|---|---|
| `cons` | conservative upwind transport, black-oil flash, volume coupling | identity | mass balance to round-off (EN2, C2) — a numerical property, not a published example |
| `corr` | correlation-consistent closure on the model's correlation | as the correlation (B&B default: verified) | the gate (steady run = nodal) |
| `driftflux` | Zuber-Findlay / Shi et al. drift flux | false | a published drift-flux holdup example (Shi et al. data tables) — Q9 |
| `res_ipr` | instantaneous IPR inflow | identity | = `WTS_wp_ipr` |
| `res_ls` | line-source E1 | true (analytical) | identity with PRiSM #1 (RS1) |
| `res_sup` | superposition of a non-linear IPR drawdown, bounded cap, gas η | false | a published multi-rate example |
| `choke_crit` | nodal critical choke | as the nodal choke | = the nodal solve |
| `choke_sub` | sub-critical closing shape / Sachdeva scaled | false | a published sub-critical choke example |
| `temp_relax` | temperature relaxation τ_T | false | field data |
| `settle` | oil–water hindered settling | false | a published settling example |
| `fallback` | liquid fallback below v_c | false | a published loading transient |
| `turner`, `coleman`, `belfroid` | critical velocity | false | Q9 (the papers' examples) |
| `foamer` | surface-tension factor r(c) | false | published lab data — Q10 |
| `regime_lowv` | low-velocity regime labels | false | Q9 |
| `gl_valves` | annulus, IPO valves, Thornhill-Craver | false | a published unloading example |
| `esp_start` | ramp, motor lag, trips | false | field data |
| `states` | well-state thresholds | false | owner review |

The page's run summary lists the keys with `verified: false` that were active, with the provisional label.

---

## 5. Validation, gate and budgets

### 5.1 Consistency gate (WD-D5) — `welldyn-gate` and `welldyn-validate.js --check`

For each of `gasVert`, `gasHz`, `oilVert`, `oilDev` (G1–G4, WD1), `gasLift` (mode `nodal`), `esp` (G5–G6, WD4):
`R = WTS_wp_system.solve(M)`; `sim = create(M, {start:'steady', reservoir:{mode:'ipr'}, closure:'corr', temperature:'frozen', cells: 60})`;
run until **steady** — over the last 600 s of simulated time |Δq|/q < 1e-4 per 60 s and |Δp_wf| < 0.01 psi per 60 s — capped at 6 h. Then:

| Quantity | Tolerance |
|---|---|
| surface rate (q_o or q_g) | ≤ 2 % of R.op.q |
| BHP (p_wf at the mid-perforations) | ≤ 1 % of R.pwf |
| THP | ≤ max(1 %, 3 psi) |
| choke regime | equal (critical) |
| gas lift / ESP | injection cell = the cell of R.lift.injMd; pump intake within 1 % |

Also: the same six from `start: 'static'` reach the same point within the same tolerances (oil and gas wells that flow naturally; gas
lift and ESP from their start scenario), and transient mode converges to the IPR mode within 0.5 % after stabilisation (RS5). Grid
convergence: 30 / 60 / 120 cells — BHP(60) vs BHP(120) ≤ 0.5 % (C12). If a fixture misses, cells, closure numerics and the step limits are
tuned — never the tolerances.

### 5.2 Engine tests (WD1, `welldyn-engine`, `welldyn-res`)

EN1 grid snapping (no cell across a break; Σ len = path MD; Σ dz = TVD) · EN2 mass balance ≤ 1e-10 per step, ≤ 1e-8 cumulative over the
`shutInBuildup` scenario · EN3 static gas column p_wh vs `WTS_wp_system.shutIn` gas-filled SITHP within 1 % · EN4 partly liquid-filled
static columns vs `shutIn.partLiquid` within 1 % · EN5 static liquid well whose column exceeds p̄r forms a gas cap / liquid level ·
EN6 steady start equals the nodal traverse at t = 0 within 1 % at every cell · EN7 open from static: oil well flows and settles (US8)
· EN8 shut-in: afterflow decays, the gas cap forms, the liquid top settles, segregation conserves mass · EN9 oil–water settling moves water
down (with settling on) · EN10 CFL respected; rejected steps halve; STEP_FAIL path · EN11 every gate cell has |j| > j_hi · EN12 q_c vs
`WTS_wp_loading` within 2 % · EN13 Belfroid factor on a 60° cell (closed form) · EN14 choke stroke and bean step: the rate moves
monotonically to the new nodal point (oilVert beans 24 → 32) · EN15 snapshot / restore bit-identical continuation · EN16 determinism:
the same scenario with different `run` chunkings (1 s, 7 s, 600 s) gives bit-identical results · EN17 events land exactly on their times ·
EN18 gas-well loading: `gasLoadDown` with fallback goes stable → marginal → loading (→ dead) and the switch happens within one
recording interval of q_g crossing q_c,max (Turner switch-over, C4) · EN19 states persistence (no chatter) · EN20 extension hook order and
contract with a dummy extension · EN21 `driftflux` closure: bubble rise in a closed liquid column at the drift velocity (closed form) ·
EN22 no timers, no DOM, no storage in the engine files (static check).
RS1 E1 line source vs PRiSM #1 within 0.5 % (t_D > 100) · RS2 f(∞) = 1 reproduces the darcy IPR · RS3 superposition of two rate steps (oil,
linear) = analytical · RS4 build-up: the Bourdet derivative of p_ws(Δt) in the infinite-acting window (10 t_wbs < Δt < 0.1 t_pss) on the
`buildup` fixture equals 70.6 q B μ / (k h) within 3 % (C3) · RS5 transient → IPR after stabilisation · RS6 gas p² / m(p) potentials ·
RS7 non-Darcy part instantaneous · RS8 term compaction error ≤ 0.05 psi · RS9 missing parameters keep `ipr` with a message · RS10 the
`horner` / `derivative` helpers.

### 5.3 Lift tests (WD4, `welldyn-lift`)

LF1 annulus volume · LF2 casing gas column vs `WTS_gaslift_casingP` ≤ 0.5 % · LF3 valve open / close hysteresis on p_vo / p_vc · LF4
Thornhill-Craver through `WTS_wp_gl.tc` unchanged · LF5 `glUnload`: valves uncover top-down, the operating valve ends at the design's
operating valve (or the deepest reachable, reported), multi-pointing flagged, casing pressure falls at each transfer · LF6 gas-lift gate
(nodal mode, G5) · LF7 casing heading vs `WTS_wp_gl.asheim` verdict on two fixtures (stable / unstable) — a cross-check, provisional ·
LF8 ESP ramp: intake draws down, settles on the pumped root (G6) · LF9 pump-off · LF10 gas lock · LF11 underload trip · LF12 check valve:
no back-flow when stopped · LF13 foamer transport delay from the injection MD · LF14 foamer: q_c falls by sigF^¼ (C11) and `foamerOn`
unloads gasLoad (state loading → unloading → stable or marginal) · LF15 oil heading / stability (§4.13) · LF16 cycle timer events ·
LF17 cycle pressure trigger with minimum times · LF18 intermittent gas well: liquid removed per cycle reported · LF19 extension
snapshot / restore · LF20 lift states and labels.

### 5.4 Recorder, page and view tests

RC1–RC16 (WD3): sampling cadence, event samples, `at` interpolation, snapshots and the cap rule, truncate / continue (bit-identical with
an uninterrupted run on the real engine — integration), marks, CSV columns / units (field and Metric) / decimal comma / escaping, RunFile
round trip (series identical; hash), `fromFile` errors (format, version, too big, malformed), snapshots dropped above 5 MB, replay re-run
reproduces the series bit for bit, cases save / list / remove / caps (20, 24 kB), `dyn` key carried in a project file and per well.
PG1–PG28 (WD3) and VW1–VW14 (WD2): §6.

### 5.5 `welldyn-validate.js` (WD5)

- `--gate`: the §4.14 method table (verified flags as shipped, label present in the page / report for each provisional method).
- `--check`: X1–X16: the gate G1–G6, static columns (EN3 / EN4), mass balance on all scenarios, build-up derivative (RS4), Turner switch
  (EN18), E1 vs PRiSM (RS1), foamer factor (C11), grid convergence (C12), determinism and restore (EN15 / EN16), casing column (LF2),
  unloading sequence (LF5), ESP gate (LF8), transient → IPR (RS5).
- `--time`: per §5.6, measured on the container (Node), with step counts; `--html` loads the built page; with Playwright and Chromium at
  `/opt/pw-browsers` it also reports the achieved speed of the page at ×1000 with drawing (report only; never `playwright install`).
- Exit 1 on a failed gate / check row; the timing rows fail only above 2 × the WD1 baseline (as the Well Performance gate).

### 5.6 Budgets (container Node; phone factor ×3 for planning)

| Operation | Budget |
|---|---|
| `create` (one nodal solve + grid + line table) | ≤ 400 ms (≈ 16–20 E of the nodal solve + 12 line marches) |
| one step, 60 cells, flowing, `corr` (one correlation call per cell, ≤ 12 root iterations of O(n)) | ≤ 1.5 ms mean |
| simulated / wall time, flowing fixtures, 60 cells, headless | ≥ 1,000× (the browser target is ≥ 500× with drawing on a laptop) |
| simulated / wall time, shut-in (Δt at dtMax) | ≥ 10,000× |
| 24 h `gasLoadDown` + 6 h shut-in + reopen scenario | ≤ 30 s wall |
| 24 h `shutInBuildup` (oil) | ≤ 15 s wall |
| `glUnload` 12 h | ≤ 60 s wall |
| `espStart` 2 h | ≤ 10 s wall |
| snapshot / restore, 60 cells | ≤ 2 ms |
| page frame: wellbore + particles at 60 cells | ≤ 4 ms (op count reported in Node; ms in the browser report) |
| charts | redrawn at most every 6th frame while playing (~10 Hz), always on pause / scrub |
| recorder memory, 24 h at defaults | ≈ 2 MB series + ≈ 1,440 snapshots ≈ 10 MB ≤ 32 MB cap |
| replay file | ≤ 5 MB (snapshots dropped above) |
| Round-9 parse of the new files | ≤ +15 ms on the app load |
| Well Dynamics acceptance files | ≤ 90 s in total (gate and lift scenarios are `integration: true`) |

If a budget is missed: the property table bins, the correlation call per cell per step, dtMax and the cell count default are tuned —
never the accuracy tolerances of §5.1.

---

## 6. UI (the suite's own look: cards, `.rbox`, KPI strip, `WTS_wp_view` charts — as the Well Performance page)

### 6.1 Layout (desktop ≥ 1024 px)

```
#wd_root
 ├─ header row: well name + "Back to nodal analysis" (#wd_go_wellperf) + the model status (fluid · IPR · well · lift summary, ✓ / ✗ "set up in Well Performance")
 ├─ #wd_toolbar (role=toolbar, .rp-skip): ▶/❚❚ Play (#wd_play) · Step (#wd_step) · Shut in / Open (#wd_shut) · Speed (#wd_speed ×1 ×10 ×60 ×300 ×1000)
 │     · Bean (#wd_bean select + stroke) · Separator (#wd_psep) · Foamer (#wd_foam) · Lift (#wd_lift: q_inj or Hz) · Mark (#wd_mark) · Export ▾ (#wd_export: CSV, replay file, open replay)
 ├─ #wd_timeline (.rp-skip): time readout, range slider (role=slider), marks as bands, state strip under it, "Continue from here" when scrubbed back
 ├─ #wd_kpi: KPI strip — state chip, q_o / q_g, THP, BHP, loading ratio (gas) or casing pressure (gas lift) or intake (ESP), liquid inventory, time, achieved speed
 ├─ main grid (2 columns): left #wd_wellbore canvas (tall) + #wd_nav navigator + layer select (phase / regime / pressure / holdup / velocity) + hover readout;
 │                         right #wd_charts tabs: Rates · Pressures · IPR / VLP · WHP vs rate · Depth log · Lift (casing / pump) · Close-up
 ├─ cards: Scenario (start state, duration, reservoir mode and parameters with "Import from PRiSM", closure, cells, events table editor .rp-skip,
 │         presets: steady / bean-up / shut-in build-up / gas-well loading / foamer / intermittent / gas-lift unloading / ESP start) · Cases (save, list, load, delete)
 ├─ #wd_res (compact report block, always visible): inputs summary, run summary rbox (§3.8), KPI chips, wellbore canvas at the current time (explicit size),
 │         run trend canvas, state timeline, provisional methods, ✓ / ⚠ / ✗ verdicts (gate distance from the nodal point when steady, mass balance), Notes
```

Phone (≤ 600 px, tested at 390 px): one column; toolbar in two wrapped rows with the less used items in a "More ▾" menu; wellbore 360 px
high with the navigator beside it; chart tabs become a `<select>`; tables scroll inside their cards (no page scroll sideways).

### 6.2 Controls in time

Every control acts at the current simulated time and becomes an Event (WD-D8): bean (with the stroke), shut in / open, separator
pressure, foamer on / ppm, gas-lift rate / mode, ESP on / frequency / ramp. The events table lists the log and lets the user add future
events before Play (scenario editing); events in the past are read-only (edit = truncate and continue).

### 6.3 Timeline and recorder

Scrubbing shows the recorded moment: charts with a cursor, the wellbore from the nearest snapshot (labelled with its time) — the engine is
not touched. "Continue from here" (confirm when later data exist) truncates the recorder and restores the engine from that snapshot.
Marks: `M` starts and ends a window; marked windows are bands on the charts and can be exported alone.

### 6.4 Wellbore view

True trajectory (departure vs TVD, aspect `true` or `fit`), width exaggerated, cells coloured by the chosen layer, regime labels at
regime changes, film / droplets / bubbles / slugs moving at the local phase velocities, valve / pump / gauge / EOT / perforation markers,
the liquid top and gas-cap interface lines when shut in. Navigator = the whole well with the zoom window. Hover → readout (MD, TVD, p,
T, α_g / α_o / α_w, v_g, v_L, v_c, regime). Click / Enter → close-up of the cell. Colours from `WTS_wp_view.PATTERN_COLORS` / theme.

### 6.5 Charts

`WTS_wp_view.chart` (crosshair, zoom, pan, legend toggles): rates (surface and sandface) vs time; THP / BHP / p̄r (and casing pressure,
pump intake) vs time; IPR + VLP of the steady reference with its operating point and the live (q_res, p_wf) point with a fading trail;
WHP vs rate (the run's path); depth log (p, α_L, v_g with v_c) vs MD; lift (casing pressure, valve states / pump intake, frequency, load).

### 6.6 Run loop (WD-D9)

```
play(): if (raf) return; raf = requestAnimationFrame(frame)
frame(ts): raf = 0
   if (!document.getElementById('wd_root') || document.hidden || !ST.playing) return            // left the page / hidden / paused → stop
   simSeconds = speed × clamp(ts − lastTs, 0, 100 ms)/1000;  sim.run(simSeconds, {maxWallMs: 10})  // deterministic chunks (WD-D8)
   achieved speed = simulated / wall over the last second (shown; "running slower than ×N" when lower)
   draw wellbore (every frame), KPIs, charts (every 6th frame); recorder samples via rec.attach
   if (sim ended or a fatal step error) { pause(); return }
   raf = requestAnimationFrame(frame)
```

No rAF (an old WebView) → `setTimeout(frame, 16)` only while playing. `visibilitychange` → hidden pauses the loop (state kept),
visible does not auto-resume. The page opens **paused**; the smoke test opens it and checks no pending timers after 5 s.

### 6.7 Reports

`collectPageReport(#pgBody)` captures `#wd_res` (inputs, run summary, KPI chips, wellbore and trend canvases, state timeline, verdicts,
provisional list, Notes); toolbar, timeline, editors, chart tabs and the navigator are `.rp-skip`. Quick Report: the same block; snapshot
≤ 60 kB on the fixtures (PG). `REPORT_DISCLAIMER` prints as on every page.

### 6.8 Units, keyboard, ARIA

- Units: inputs tagged with `WTS_units.tagInput` (pressure, temperature, rates, lengths) and read inside `window.calcWellDyn` (canonical
  imperial); results through the page converter (the same categories and helpers as the Well Performance page; guarded local
  registration of a missing category). Metric mode converts every readout, axis and CSV column (`system:'metric'`).
- Keyboard (active when focus is inside `#wd_root`, not in an input): Space play / pause · `.` one step · ← / → scrub 1 % (Shift 10 %) ·
  Home / End · + / − speed · `S` shut in / open · `M` mark · `[` / `]` chart tab · in the wellbore: ↑ / ↓ select a cell, Enter close-up,
  Esc close · 0 resets the zoom. `aria-keyshortcuts` on the buttons.
- ARIA: toolbar `role="toolbar"`, Play `aria-pressed`, timeline `role="slider"` with `aria-valuetext` ("2 h 14 min — loading"), a polite
  live region announcing **state changes only** (already rate-limited by the 120 s persistence rule), canvases with `role="img"` and a
  text summary, the close-up a modal `<dialog>` (`.rp-skip`, `data-rp-nosnap`).
- Reduced motion → particles off, arrows only.

### 6.9 Page contract

Registry entry `welldyn` {key, title 'Well Dynamics', navTitle 'Well Dynamics', sub 'Transient well simulation: loading, unloading,
shut-in, start-up and lift in time', group 'Production & Reservoir', icon '&#8767;', badge 'Production', bc 'dc-b-green', desc,
`hooks: {silent: true, after}`, render}. `window.calcWellDyn()` re-reads the model (`WTS_wp_model.read()`), rebuilds the steady reference
and the static preview — it never starts a run. `WTS_state.welldyn = {v:1, ok, playing, t, state, summary, model:{ok, notes}}`.
Events listened to: `wts:well-changed`, `wts:project-loaded` (stop, discard the run after a confirm if it has data, re-read),
`wts:wellperf-model-changed` (the model changed: banner "the well model changed — Rebuild" — a running sim keeps its frozen M),
`wts:unit-system-changed` (re-render readouts). Test hook `WTS_welldyn_page` {state, sim, rec, play, pause, frame(ts) (drives one frame in
tests), csv, runFile, load, scenario}.

---

## 7. Persistence

| Key | Scope | Content | Owner |
|---|---|---|---|
| `wts_page_welldyn` | per well (host autosave, project files) | scenario scalars `wd_*` (start, duration, cells, reservoir mode and parameters, closure, fallback, temperature, preset, CSV options) | WD3 |
| `wts_wellperf_model` → `dyn` (additive) | per well (project files) | `{v:1, cases:[Case] ≤ 20, res:{k, h, phi, ct, mu, B, rw, re, S, source}, preset}` ≤ 24 kB → `M.dyn` (present only when the record has `dyn`) | WD0 edits `49-calc-wp-model.js` (TABLE_KEYS + validate + read); WD3 writes it |
| `wtspref_wd_speed`, `wtspref_wd_layer`, `wtspref_wd_tab`, `wtspref_wd_cols`, `wtspref_wd_follow` | device | speed, wellbore layer, chart tab, CSV columns, follow-the-front | WD3 |
| replay files `.wdrun` | user files | §3.7 | WD3 |

Identity rules for the `dyn` edit (WD0): `wellperf-shapes` WS1 fixture hash unchanged; `WTS_wp_model.read()` of a record without `dyn`
deep-equals today's M; `WTS_wp_cases` TABLES unchanged (cases of Well Performance never carry `dyn`); the full `wellperf-*` suite and
`wellperf-validate --check` unchanged. Recorded runs are not stored in the browser (memory and files only); a reload loses an unsaved
run (the page warns on leave when a run has data — via the host's existing leave confirmation if present, else a banner).

---

## 8. Help guide (WD6)

- Route `welldyn` as a **PART** route (14 kB serialised cap): what the simulator does and does not do; the shared model; Play / speed /
  events; reading the wellbore (layers, regimes, film and droplets); gas-well loading and unloading (Turner / Coleman, Belfroid, states,
  foamer); shut-in, afterflow and build-up (transient reservoir); start-up and heading; gas-lift unloading; ESP start-up; recorder,
  marks, CSV, replay files, cases; the provisional methods. A compute check `fn: 'WTS_wd_engine'`.
- Two "How do I…" tasks: "See when my gas well loads up" and "Unload a gas-lift well step by step"; glossary: afterflow, drift flux,
  heading, liquid fallback, intermittent production.
- **Size estimate:** guide ≈ 10–12 kB raw / ≈ 4 kB gzip; tasks + glossary ≈ 2 kB raw / ≈ 0.8 kB gzip; total ≈ 13 kB raw / ≈ 5 kB gzip;
  three screenshots (desktop wellbore + charts, the loading run, phone) ≈ 90–120 kB.
- **Caps (owner decision, Q4):** at v4.5 the help files use 367,950 of 369 kB raw and 127,774 of 128 kB gzip (help-content.test.js
  SUM_CAP / GZIP_CAP), and the images 7,983,698 of the 8 MB cap. A raise of **+14 kB raw / +5 kB gzip** and **+120 kB images** is needed;
  if the owner declines, the guide ships as a 6 kB non-PART route with no screenshots (the rest in the page's Notes). The Q21 help change
  running in parallel (4.5.1) may move the caps: WD6 re-measures on the merged tree before asking.
- Steps: draft → size → owner decision → shots with `help-shots.js` (Linux container only) on the mock or the real engine at fixed
  simulated times (deterministic) → Round 9 rebuild → `build-user-guide.js` → sync.

---

## 9. Work packages, lanes and merge order

### 9.0 WD0 — contracts and skeleton (lead, before Wave 1; branch `wd/wd0` from `wd/plan`)

Host `__NAV_ORDER` edit; `sidebar-nav.test.js` (6 rows, the row after the hub); `ux-layout-check.js` fit; the `dyn` key in
`49-calc-wp-model.js` with its identity checks; the six stub files + the help stub entry (non-PART, minimal) with `__WD_STUBS`;
`tests/_welldyn-shapes.js` (fixtures tuned and pinned with the real Well Performance engines, §3.9), `tests/_welldyn-mock.js`,
`welldyn-shapes.test.js`, `welldyn-names.test.js`; smoke +4 checks (namespaces present, `welldyn` registry entry, `__WD_STUBS` empty at
release — skipped while stubs exist, no pending timers 5 s after opening `welldyn`); the §11 WD0 record. Merged into `wd/int` before any
lane starts. Gates: smoke, `--file` runs of the new tests and the full `wellperf-*` + `sidebar-nav` set.

### 9.1 Wave 1 (parallel, each branch from `wd/int` after WD0)

| Lane | Branch | Files | Depends on | Done when |
|---|---|---|---|---|
| **WD1 engine + reservoir** | `wd/wd1` | `49-calc-wd-engine.js`, `49-calc-wd-res.js`, `welldyn-engine`, `welldyn-res`, `welldyn-gate` (G1–G4) | WD0 | EN1–EN22, RS1–RS10, G1–G4 pass; §5.6 engine budgets measured (BASELINE filled through the lead) |
| **WD2 view + charts** | `wd/wd2` | `49-calc-wd-view.js`, `welldyn-view` | WD0 (mock) | VW1–VW14 pass on the mock: trajectory geometry (vertical, S, horizontal), layers and colours, particle determinism, pick / hover / select, navigator window, close-up, depth log / trend / nodal / whpRate / stateStrip specs, hidden-canvas size, reduced motion, theme, op counts per frame |
| **WD3 page + recorder / replay / cases** | `wd/wd3` | `49-calc-wd-rec.js`, `49-calc-welldyn.js`, the `#wp_go_welldyn` button in `49-calc-wellperf.js`, `welldyn-rec`, `welldyn-page` | WD0 (mock; view at call time — the WD0 stub until WD2 merges) | RC1–RC16, PG1–PG24 pass on the mock; `wellperf-page` unchanged plus one cross-link test |

PG1–PG24: render and restore (silent hook, one calc), the shared model read (no copy) and well switch / project open, model-changed
banner, no auto-play and no timers when idle, play / pause / step via `frame(ts)`, stop on leaving the page and on hidden, speed and the
achieved-speed note, events from controls, scenario presets, events editor (future only), scrub / continue, marks, CSV dialog, replay
save / open, cases, cross-links both ways, KPI strip per well type, report block content and Quick Report size ≤ 60 kB, Metric mode, decimal
comma, keyboard map, ARIA roles and the live region, 390 px layout (no horizontal overflow), escaping of names. PG25–PG28 (integration, run
after WD1 merges): a real 10-minute run of each fixture through the page.

### 9.2 Wave 2 (parallel, from `wd/int` after Wave 1 merged)

| Lane | Branch | Files | Done when |
|---|---|---|---|
| **WD4 lift transients + oil heading** | `wd/wd4` | `49-calc-wd-lift.js`, `welldyn-lift`, `welldyn-gate` G5–G6 (append) | LF1–LF20, G5–G6 pass |
| **WD5 validation script + gate + perf** | `wd/wd5` | `prism-build/welldyn-validate.js`, `welldyn-validate` | `--gate --check --time` pass on `wd/int` (lift rows marked pending until WD4 merges; the integrator re-runs) |

Lanes do not edit each other's files. A defect a lane finds in another lane's file is written in its §11 record as a finding (file, case,
expected / actual); the integrator fixes it with a regression test.

### 9.3 Wave 3

- **WD6 help** (`wd/wd6`): §8, after the owner's cap decision.
- **WDI integration and release (lead, `wd/int` → `wd/rel`)**: merge order **WD0 → WD1 → WD2 → WD3 → WD4 → WD5 → WD6**, each merge gated by
  smoke + the welldyn / wellperf / sidebar files; then the full rebuild (Round 9 + host; CRLF check; sync), smoke 351/351, the full
  acceptance suite (count by `--list`), `wts3d-test.js`, `wellperf-validate.js --html --gate --check --time` (unchanged),
  `welldyn-validate.js --html --gate --check --time`, `ux-layout-check.js`, a GUI sweep of `welldyn` (`gui-sweep.js --route welldyn,wellperf`
  + `--mobile`), browser check of play / scrub / Metric / phone, RELEASE_NOTES v4.6 item (engineering text, no names), CLAUDE.md (file map,
  stats, known limitations), PROJECT-NOTES, App Store 4.6 (MARKETING_VERSION and `VERSION_BASE`).

---

## 10. Open owner questions (each has a default the lanes build with)

| # | Question | Default |
|---|---|---|
| Q1 | Liquid fallback below the critical velocity is provisional (D17). Make it the default for gas wells? | Off by default; on in the "gas-well loading" preset and the loading fixtures |
| Q2 | Temperature in time: `frozen` (gate) or `relax` (provisional) by default? | `frozen`; `relax` as an option |
| Q3 | Reservoir default: `ipr` (exact with nodal) or `transient` when k, h, φ, μ, c_t are complete? | `ipr`; the shut-in build-up preset switches to `transient` when the parameters are complete, else says what is missing |
| Q4 | Help caps: raise by +14 kB raw / +5 kB gzip and the image cap by +120 kB for a PART guide with three screenshots? | Ask with the measured draft; if declined, a 6 kB guide and no screenshots |
| Q5 | Release on both platforms (iOS included; phone speed ≈ ⅓)? | Both, as v4.6 |
| Q6 | Replay file extension `.wdrun` (JSON inside)? | `.wdrun` |
| Q7 | Cell count: default 60, range 20–200? | Yes |
| Q8 | One release (no A / B split), lifts included? | One release v4.6 |
| Q9 | Papers for verification (Shi et al. 2005 drift-flux parameters, Turner, Coleman, Belfroid, Taitel-Dukler, Thornhill-Craver) — carried over from Well Performance Q9 | Not provided: provisional labels |
| Q10 | Foamer effectiveness curve (r_max 0.6, c_50 500 ppm) | As assumed, labelled provisional, editable |
| Q11 | "Run all wells" for Well Dynamics? | Not in v4.6 |
| Q12 | Record a run into the Mini WellOS historian? | Not in v4.6 (CSV is the hand-off) |
| Q13 | Gas-lift valves: IPO and orifice only (no PPO)? | Yes |
| Q14 | May Well Dynamics write the model back (adopt the model of a replay file)? | Only by an explicit, confirmed "Adopt this model" action |
| Q15 | Well-state thresholds (§4.13) | As stated, provisional, shown in the help |

---

## 11. Records (filled by the lanes; format as the Well Performance plan §18: date, branch, decisions taken at their defaults, what was
built (engines, contracts — additive only), tests / gates with counts, measured budgets, known gaps)

### 11.0 WD0 record

### 11.1 WD1 record

### 11.2 WD2 record

### 11.3 WD3 record

### 11.4 WD4 record

### 11.5 WD5 record

### 11.6 WD6 record

### 11.7 Integration and release record
