# Well Dynamics — transient well simulator (v4.6) — implementation plan

> **Status: draft for owner review, revision 2** (2026-11-13, on top of dev-87qwkg f68eb65 = v4.5). Revision 2 applies the plan review
> (required changes R1–R25, recommended C1–C11; §12 maps each to the section that changed). Nothing is built yet. Test counts
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
| Shared-engine edits (WD0, additive) | `49-calc-wp-model.js`: the `dyn` table key; `49-calc-flowline.js`: one export `WTS_flowline_gradAt` = the private `_gAt` (correlation call + VLP-tuning multipliers) with an identity test (§2.5, R5) |
| Shared engines reused (never duplicated) | `WTS_wp_model`, `WTS_wp_system.context` (the solve's own F / I / W / correlation keys / sections / choke / lift context, R18), `WTS_wp_fluid` (PVT, Z, wet gas), `WTS_flowline_props`, `WTS_flowline_gradAt` (gradient correlations exactly as the nodal march calls them), `WTS_flowline_march` (flowline back pressure), `WTS_wp_ipr` (steady inflow), `WTS_wp_well` (path, segments, stations, temperature), `WTS_wp_vlp.sectionsFor`, `WTS_wp_system` (steady reference, `GILBERT_YC`, choke rule, shut-in columns), `WTS_wp_loading`, `WTS_chokeperf_multiphaseRate` / `_gasRate` / `_sachdeva`, `WTS_wp_gl` (`tc`, `pdAt`, `portR`, `asheim`, installed valves), `WTS_gaslift_casingP`, `WTS_wp_esp` (`prepare`, `curve`, `pump`), `WTS_wp_view` (chart, colours, schematic helpers), `PRiSM_E1`, `PRiSM_autoInterp.drive` / `hash16`, `PRiSM_getWell` |

---

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| WD-D1 | One page `welldyn`, its own sidebar row in Production & Reservoir after the `perf` hub (owner 2026-11-13). Not a hub member, not a PRiSM mode, not part of the 3-D simulator (31/32/38 are not touched). | §2.1 |
| WD-D2 | **One model.** The page reads the Well Performance model with `WTS_wp_model.read()`; it never keeps a copy of fluid, inflow, well or lift inputs. Its own inputs are scenario settings (scalars `wd_*` in `wts_page_welldyn`) and cases (`dyn` table key in `wts_wellperf_model`, additive, §7). | §7 |
| WD-D3 | **Physics:** 1-D transient drift-flux model along MD on the shared path; four conserved components (formation gas G, oil-or-condensate O, water W, **lift gas I** — free only, never dissolves) + a passive foamer tracer F; black-oil flash per cell through the solve's own fluid context; **quasi-steady mixture momentum** per cell; a **volume-balance** pressure equation (Σ_c ∂V/∂m_c · ṁ_c + ∂V/∂p · ṗ = 0 per cell) solved once per step by a scalar root on the wellhead pressure with inner Picard sweeps (a "no-pressure-wave" scheme — no acoustic time-step limit). | §4.1–§4.6 |
| WD-D4 | **Closure:** default `corr` = at every co-current face the drift parameters are set so the steady holdup equals the holdup of the well's gradient correlation, called exactly as the nodal march calls it (`WTS_flowline_gradAt`: the same segment angle, roughness, Payne / acceleration flags, per-section key and VLP-tuning multipliers), and the friction is that correlation's friction gradient; only counter-current or near-stagnant faces (|j| < 0.10 ft/s) blend into the published drift-flux closure (Zuber-Findlay with the Shi et al. profile and inclination forms), the only closure that exists for counter-current flow and shut-in; counter-current faces use a bounded Godunov flux. Option `driftflux` uses the drift-flux closure everywhere. | §4.4 |
| WD-D5 | **Consistency gate:** a steady flowing run must settle on `WTS_wp_system.solve` for the same model — **time-means** over the last 600 s: rate within 2 %, BHP within 1 %, THP within 1 % or 3 psi, choke regime equal to `R.surface.choke.regime` — on seven fixtures (gas vertical, gas horizontal, oil vertical, oil vertical tuned, oil deviated, gas lift, ESP). A bounded oscillation is allowed and reported (amplitude ≤ 0.5 % of q). This is the release gate of the module. | §5.1 |
| WD-D6 | **Reservoir:** mode `ipr` (instantaneous steady inflow from the solve's `I`, exact consistency with nodal; reverse flow into the formation by the IPR slope at p̄r when p_0 > p̄r) and mode `transient` (line-source E1 superposition of the IPR's drawdown with r_w,eff for negative skin and a stated prior history, bounded by the stabilised IPR, so a long constant-rate run converges to the IPR). Wellbore storage and afterflow are not inputs: they emerge from the cells. | §4.7 |
| WD-D7 | **Time integration:** explicit, conservative, first-order upwind transport (Godunov at counter-current faces; option second-order MUSCL / minmod); step limited by a CFL on the larger of the phase velocities and the kinematic-wave speed (default 0.5), a pressure-change limit, event times and `dtMax`; rejected steps are halved. Mass balance checked every step. | §4.6 |
| WD-D8 | **Determinism:** the step sequence depends only on the model, the settings and the event list — never on the frame rate or wall time. `run(seconds)` never splits a step to land on a frame; events cut a step exactly at their time. Within one JavaScript engine a replay re-run is bit-identical and `snapshot()` / `restore()` continue bit-identically; across engines (web / iOS) `Math.exp / log / pow` may differ in the last bit, so a re-run is equal within a stated tolerance and never reported as corrupt (R25). | §3.2, §3.7, §5.4 |
| WD-D9 | **Run loop:** the page drives the engine from `requestAnimationFrame` only while playing; paused, hidden tab, page left or run ended → no frame is requested. No `setInterval`, no watchdog, no polling, no function wrapping. The page opens paused. The loop accumulates a simulated-time target (target += speed · Δwall) so the achieved speed does not drift. | §6.6 |
| WD-D10 | **Recorder:** scalar channels at a fixed simulated interval + full engine snapshots at a coarser interval, in memory, capped (32 MB); scrub shows any recorded moment; "Continue from here" restores the engine from the snapshot. A replay file (`.wdrun`, JSON) holds model, settings, events, series and snapshots. | §3.4, §7 |
| WD-D11 | **D17 applies unchanged.** Every method is in the method table (§4.14) with `verified` and what would verify it. A method without a verified published example is labelled "provisional — not verified against a published example" and is never a default where a verified or identity-checked alternative exists (so the Belfroid correction is an option, default off — Q16). Where no alternative exists (shut-in segregation needs a drift closure) the provisional method runs and the run is labelled. The page shows the list of provisional methods active in a run. | §4.14 |
| WD-D12 | Engines are field units only (psia inside, psig at surface named `*_psig`, ft, in, °F, STB/d, Mscf/d, lbm, s for time). Gauge-pressure inputs of shared engines (multiphase choke p1, gas-lift dome pressures) are converted explicitly (p_psig = p_psia − 14.696, the PATM of the solve). The page displays through the units layer (Metric works); categories are those the Well Performance page uses (guarded local registration, D12 of that plan). | §3.0, §6.8 |
| WD-D13 | Lift transients (foamer, gas lift, ESP, intermittent controller, heading detector) are **engine extensions** registered in `WTS_wd_engine.ext`, so lane WD4 adds them without editing the engine. Sources are evaluated once per step **before** the pressure solve from the lagged pressures. | §3.3 |
| WD-D14 | Naming: methods by their published authors only; no product, vendor, company or web address anywhere; `welldyn-names` greps every Well Dynamics file. | §2.5 |
| WD-D15 | Reports: an always-visible compact block `#wd_res` (inputs, run summary, KPI chips, the wellbore at the current time, the run trend, state timeline, provisional list, Notes); editors, controls and step-only plots are `.rp-skip`; canvases drawn at fixed sizes (wellbore 360×480, trend 640×220 CSS px); Quick Report snapshot ≤ 60 kB, measured at WD3. | §6.7 |
| WD-D16 | **One context with the solve.** The engine takes F, I, W, the correlation keys, sections, choke settings and the gas-lift / ESP context from `WTS_wp_system.context(M)` — the same constructor the solve uses (`WTS_wp_fluid.build(M.fluid, {T_F: M.res.T_F, table: true})`, wp-system `_ctx`), pinned by a property-identity test (EN24); the steady reference R0 is cached by the model hash (create ≤ 800 ms cold, ≈ 0 when cached). | §2.4, §4.1 |

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
- **WD0 host edit and checks (R24):** `__NAV_ORDER` only. `tests/sidebar-nav.test.js` gets both assertions changed: the full button list
  with the hub members (line 57) becomes `['prism', 'oilgas', 'solgor', 'hub:perf', 'wellperf', 'oilipr', 'gasdeliv', 'gaslift', 'welldyn',
  'buildup']`, and the row list (line 58) becomes `['prism', 'oilgas', 'solgor', 'hub:perf', 'welldyn', 'buildup']` with the message
  '6 rows' (and the comment above it "six rows"); `ux-layout-check.js` must report the 1280×800 fit without scrolling. Help: the help
  page's group route list (the Production & Reservoir routes the Help page and `help-content.test.js` check against the live registry)
  gains `welldyn` with the WD0 stub guide; at WD6 `help-content.test.js` `PARTS` gains `'welldyn'` (the 14 kB PART cap, §8).

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
| `flowline-gradat.test.js` | WD0 | `WTS_flowline_gradAt` identity: on the oil / gas / tuned (m_h, m_f ≠ 1) / per-section fixtures, every station of a `WTS_flowline_march` traverse equals `gradAt` at the station's (p, T, segment, opt) bit for bit; the export is additive (the `wellperf-*` suite and `wellperf-validate --check` unchanged) |
| `welldyn-engine.test.js` | WD1 | EN1–EN28 (§5.2) |
| `welldyn-res.test.js` | WD1 | RS1–RS12 |
| `welldyn-gate.test.js` | WD1 (G1–G4, G7), WD4 (G5–G6) | the consistency gate per fixture (time-means, §5.1) |
| `welldyn-view.test.js` | WD2 | VW1–VW14 on the mock and the recording canvas |
| `welldyn-rec.test.js` | WD3 | RC1–RC16 |
| `welldyn-page.test.js` | WD3 | PG1–PG24 on the mock; PG25–PG28 with the real engine (`integration: true`, after WD1 merges) |
| `welldyn-lift.test.js` | WD4 | LF1–LF23 |
| `welldyn-validate.test.js` | WD5 | the `--check` quick subset and the `--time` evaluation counts |
| `help-content.test.js` (edit) | WD6 | `PARTS` gains `'welldyn'` (PART cap), the help file cap |

Estimated +155 acceptance tests; smoke +4 checks (§9, WD0).

### 2.4 Data flow

```
 wts_page_wellperf ─┐                         wts_page_welldyn (wd_* scenario scalars)
 wts_wellperf_model ┴─► WTS_wp_model.read() ─► M (frozen) ──┐   M.dyn (cases, reservoir transient inputs)
                                                             ▼
   WTS_wd_engine.create(M, opts)          (opts.ref with the same model hash → R0, C and the line table are reused, C7)
     ├─ C  = WTS_wp_system.context(M).C   the solve's own context (R18): F (WTS_wp_fluid.build(M.fluid, {T_F: M.res.T_F, table:true})),
     │                                     I (WTS_wp_ipr.curve), W (WTS_wp_well.build), corrWell / corrLine / sections, choke, mult, gl (Finj), esp
     ├─ R0 = WTS_wp_system.solve(M)       steady reference: op, traverse, temperature profile, loading, choke regime, lift.injMd
     ├─ grid from W.segmentsFor + WTS_wp_vlp.sectionsFor (the marcher segments, §4.2)
     ├─ WTS_wd_res.create(C.I, M, opts.reservoir)
     ├─ line table p_dn(q) from WTS_flowline_march (the solve's flowline options)
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
- Nothing edits 31/32/38, 22-units.js, the PRiSM files, or any `49-calc-wp-*.js` engine other than the WD0 `dyn` key. One additive edit
  to `49-calc-flowline.js` (WD0, lead, R5): `G.WTS_flowline_gradAt = function (fluid, p, T, seg, opt) { return _gAt(fluid, p, T, seg, opt || {}); }`
  next to the other exports — no change to `_gAt`, `_applyMult` or the march; pinned by `flowline-gradat.test.js` and the unchanged
  `wellperf-*` suite / `wellperf-validate --check`. Shared files therefore also include `49-calc-flowline.js` (WD0 only).

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
  static: { kind: 'gas' | 'liquid' | 'level', liquidTopMd: null /*ft, kind 'level'*/, liquid: 'water' | 'oil' },
                                     // R22: no kill-fluid density — a "kill" column is the model's water (γ_w); a heavier brine is not modelled
  snapshot: null,                    // a Snap (start 'snapshot')
  ref: null,                         // a previous sim.ref {mHashModel, R0, C} — reused when mHashModel matches (no solve; C7)
  reservoir: { mode: 'ipr' | 'transient', k, h, phi, ct, mu, B, rw, re, S, potential: 'auto' | 'p' | 'p2' | 'mp',
               prior: { kind: 'steady' | 'none' | 'shutin', t_h: 720, shut_h: 0 },   // R15; default 'steady' for start 'steady', 'none' for 'static'
               backflow: true },     // R14: reverse flow into the formation when p_0 > p̄r (provisional, key res_back)
  closure: 'corr' | 'driftflux',     // WD-D4; default 'corr'
  closureOpt: { jLo: 0.05, jHi: 0.10 /*ft/s, C1*/, omega: 0.5 /*under-relaxation of the lagged corr v_d, R20*/ },
  fallback: false,                   // liquid fallback below the critical velocity (§4.10; provisional; Q1)
  loading: { belfroid: false },      // Belfroid inclination correction of v_c (provisional; Q16; both q_c are always reported)
  compliance: { pipe_psi: 3e-6, cwMin_psi: 3e-6 },   // C6: tubing elastic compliance and water compressibility floor, 1/psi (ASSUMED)
  order: 1 | 2,                      // transport order (2 = MUSCL / minmod)
  cfl: 0.5, dtMax: 60, dtMin: 1e-3, dpMaxFrac: 0.02,
  picard: { maxSweeps: 3, tolQ: 1e-6 /*ft³/s*/, tolQrel: 1e-4 },   // inner sweeps of the wellhead root (R3)
  temperature: 'frozen' | 'relax', tauT_h: 2,
  choke: { subcritical: 'model' | 'shape', strokeTime_s: 10 },   // 'model' = the model's surface.choke.subcritical rule (§4.8); 'shape' = the provisional closing shape
  ext: { foamer: {...}, gaslift: {...}, esp: {...}, cycle: {...}, heading: {...} },   // §3.3 (absent → each ext's defaults / off)
  events: []                         // Event[] scheduled from t = 0 (§3.5)
}
sim = {
  ok: true, version: '1.0.0', M, R0 /*the steady reference solve*/, C /*WTS_wp_system.context(M).C — F, I, W, keys, sections, choke, gl, esp*/,
  ref /*{mHashModel, R0, C} for reuse*/, mHash /*hash16 of canonical(M without M.dyn) + resolved opts (incl. resolved reservoir); R17*/,
  grid,                              // §3.2
  state: S,                          // §3.2
  step(dt?)            → StepInfo {ok, t, dt, iters, sweeps, rejects, massErr:{G, O, W, I}, applied:[Event], code?},
  run(seconds, o?)     → {ok, t, steps, wallMs, stopped: 'target'|'wall'|'steps'|'end'|'error', code?}   // o {maxWallMs, maxSteps}
  snapshot()           → Snap (§3.6),
  restore(snap)        → {ok, code?}  ('MODEL_MISMATCH' when snap.mHash ≠ sim.mHash; 'VERSION' when snap.engine major differs),
  schedule(events)     → {ok, n},      // add Event[]; times ≥ state.t
  setChoke(bean64),    shutIn(),  open(),  setSeparator(psig),
  setFoamer({on, ppm, injMd}),  setLift(spec /*{type:'gaslift', qinj_Mscfd, mode:'valves'|'nodal'} | {type:'esp', on, freq, ramp_Hz_s}*/),
  steadyCheck(win_s?)  → {steady, qMean, pwfMean, thpMean, ampQ, ampP, dq, dp},   // the §5.1 time-mean criterion on the engine's own ring buffer
  on(type, fn), off(type, fn),       // synchronous engine events (§3.5); no DOM events
  dispose()
}
```

All `set*` / `shutIn` / `open` calls are converted into Events at the current `state.t` and go into the event log, so an interactive
session is a scenario (WD-D8). `create` performs one `WTS_wp_system.context(M)` and one `WTS_wp_system.solve(M)` (≈ 16–20 E, ≈ 400–450 ms
measured for the A1 fixtures) unless `opts.ref` carries the same model hash; a model with no stable root cannot use `start: 'steady'`
(`code: 'NO_STEADY'`) and offers the static start. Refusals: `RV_NOT_IN_TRANSIENT` (the fluid has a vaporised-condensate Rv table,
`pvt.rv.mode` ≠ 'none' — the transient flash has no Rv; R13), `INJECTOR` (an injection well), `GL_NOT_APPLICABLE` / `ESP_NOT_APPLICABLE`
as the solve, `MISSING_ENGINE`.

### 3.2 Grid and state

```js
grid = { n, cells: [{ i, md0, md1, mdc, tvd0, tvd1, tvdc, len /*ft MD*/, dz /*ft TVD, + up*/, inc /*deg from vertical, display*/, id /*in*/,
                      area /*ft²*/, vol /*ft³*/, kind: 'tubing'|'casing'|'liner'|'annulus', seg /*index into segs*/,
                      corr /*registry key of this cell's segment (section key or C.corrWell)*/ }],
         segs: [ /*the marcher segment objects of the nodal traverse, as WTS_wp_vlp.sectionsFor builds them: {id, len, dz, theta
                   (deg from HORIZONTAL, asin(dz/len), + = flow up), area, corr, restr} — passed unchanged to WTS_flowline_gradAt (R5)*/ ],
         rough /*in: the one length-weighted W.rough the march uses (R5b)*/,
         faces: [{ md, tvd, restr: {d, k} | null }],
         eotCell, pumpFace /*or -1*/, injCell /*R0.lift.injMd cell, nodal gas lift, or -1*/, valveCells: [{ n, md, cell }], gaugeCells: [{ md, cell }],
         traj: [{ md, tvd, dep, n, e }] /*W.stations, for the view*/ }
S = {
  t, dt, n /*steps*/, open, bean64, beanEff /*during a stroke*/, psep_psig, tOpen /*time of the last open*/, qRef /*highest surface rate since tOpen*/,
  cells: { p, T, ag, ao, aw, mG, mO, mW, mI, mF, vg, vl, vm, rhoM, vc, sigF, regime },   // psia, °F, fractions (ag = all free gas incl. lift gas), lbm, ft/s, lbm/ft³, ft/s, –, codes
  faces: { Q /*ft³/s mixture*/, jg, jo, jw /*ft/s superficial*/, xI /*lift-gas fraction of the free-gas flux*/, vd, c0 /*closure in use, lagged*/, w /*blend weight*/ },
  surface: { thp, thp_psig, tht, pDn_psig, qo, qw, qL, qg /*total gas = formation + lift + vented*/, qgForm, qinj, qvent,
             glr, gor /*total*/, gorForm, wc, regime: 'critical'|'subcritical'|'subcritical-bound'|'closed'|'none', y, yc },
  bottom:  { pwf, pr, qo, qw, qg /*sandface, stock-tank; negative = back-flow*/, drawdown },
  well:    { state /*STATES key*/, since, reason, prev },
  loading: { method: 'turner'|'coleman', both /*500 ≤ WHP ≤ 1,000*/, liquid: 'water'|'condensate', qc_MMscfd /*the one in use*/,
             qcVert_MMscfd, qcBelfroid_MMscfd, belfroid /*on?*/, limitingMd, limitingTvd, ratio, vRatioMin, belowEot },
  inventory: { liq_bbl, liqTubing_bbl, gas_Mscf, liftGas_Mscf, liquidTopMd, gasCapBottomMd },
  balance: { m: {G, O, W, I}, cumIn: {G, O, W, I}, cumOut: {G, O, W, I}, errStep, errCum, volDrift },
  lift: { gl: null | {...}, esp: null | {...} },    // filled by the extensions (§3.3)
  foamer: { on, ppm, eff },
  res: { mode, terms, f0, backflow },
  flags: [{ code, sev, msg }],
  provisional: [ /*method keys active so far in this run (§4.14)*/ ]
}
```

`WTS_wd_engine.COMP = ['G', 'O', 'W', 'I', 'F']` (frozen). `WTS_wd_engine.REGIMES = ['liquid', 'bubble', 'slug', 'churn', 'annular',
'mist', 'stratified', 'segregated', 'gas', 'unknown']` (the keys of `WTS_wp_view.PATTERN_COLORS`). `WTS_wd_engine.STATES` (§4.13) is a
frozen table `{key: {label, sev, kinds:['gas'|'oil'|'gl'|'esp']}}`; `WTS_wd_engine.STATE_ORDER` is the frozen key order (the recorder's
`state` channel is an index into it; pinned in the fixtures, C9): `stable, startup, unloading, marginal, loading, heading, dying, dead,
shutin, gl_unloading, gl_lifting, gl_multipoint, esp_off, esp_ramp, esp_running, esp_pumpoff, esp_gaslock, esp_tripped`. New states are
appended, never inserted.

### 3.3 Extensions (WD-D13)

```js
WTS_wd_engine.ext[key] = {
  key, label, verified: false, provisional: 'text',
  applies(M, opts)          → boolean,
  init(sim, opts)           → ctx /*JSON-safe state of the extension*/,
  control(sim, ctx, t)      → Event[] | null,          // once per step, first (cycle controller, ESP trips)
  sources(sim, ctx, dt)     → { G?: Float64Array(n), O?, W?, I?, F? } | null,   // lbm/s per cell, from the LAGGED state (p^n, T^n);
                                                       // gas-lift valve gas is I (lift gas), annulus liquid through a valve is W, ESP vent is a
                                                       // negative G / I at the cell below the pump; enters Q_src of the volume balance (§4.6)
  faceDp(sim, ctx, k, Q)    → { dp /*psi, + = pressure rise in the flow direction*/, ddpdQ /*psi per ft³/s*/ } | null,   // ESP; linearised once
                                                       // per step at the lagged Q (§4.12), evaluated inside the root as dp + ddpdQ·(Q − Q_lag)
  sigma(sim, ctx)           → Float64Array(n) | null,  // surface-tension factor per cell (foamer)
  after(sim, ctx, info)     → void,                     // after the transport (annulus mass, valve states, ESP motor)
  label(sim, ctx)           → { state, reason } | null,  // lift states override the base label
  snapshot(ctx) → any (JSON),  restore(json) → ctx
}
```

The engine calls the hooks in this order every step (R23): `control` → **`sources`** (lagged pressures; the source arrays are fixed for
the step) → `faceDp` linearisation → pressure solve (sources in Q_src, §4.6) → transport (sources in S_c, §4.3) → `after` → `sigma`
(for the next step) → labels. A rejected step is retried with Δt/2 from the pressure solve on (`control` is not called again and the source rates of the step
are re-used unchanged). An extension may only write its own `ctx` and `S.lift.*` / `S.foamer`. WD1 tests the hook order and contract with a
dummy extension (EN20); WD4 implements the five real ones.

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
`load` (fraction), `foam` (ppm at the bottom cell), `dt` (s), `massErr` (relative, cumulative), and (revision 2, appended — the order is
frozen, new keys go at the end, C9) `qgForm` (Mscf/d, formation gas at the surface), `gorForm` (scf/STB), `qvent` (Mscf/d, ESP vent gas),
`liftgas` (Mscf in the tubing), `qcVert`, `qcBelfroid` (MMscf/d). `qg` is the total surface gas (formation + lift + vent, C8); `state` is
the index in `WTS_wd_engine.STATE_ORDER`.

Cap rule: when `bytes()` exceeds `capMB`, every second snapshot older than the last hour of simulated time is dropped (repeatable);
series are never dropped (24 h at 10 s ≈ 8,640 samples × 36 channels × 8 B ≈ 2.5 MB).

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
Snap = { kind: 'wd-snap', v: 1, engine: '1.0.0', engineId /*§3.7*/, mHash, n, t, steps, dtPrev,
  cells: { mG, mO, mW, mI, mF, T, p },
  faces: { Q, jg, jo, jw, xI, vd, c0, w },                            // R16: the lagged closure state (the corr closure reads last-step values)
  ctl: { open, bean64, beanEff, strokeLeft_s, psep_psig, tOpen, qRef },
  line: { refGor, refWc, q: [], pdn: [] },                            // R16: the flowline p_dn(q) table in use and its reference GOR / WC (§4.8)
  res: { mode, terms: [[t_s, dPhi]], base, qPrev: {o, w, g}, prior },
  labels: { state, since, prev, reason, pending: {key, since} | null,  // the 120 s persistence candidate
            ringT: [], ringLiq: [], ringQ: [], ringP: [], dying: {...}, heading: {...} },   // R16: dying / heading histories
  steady: { ringT: [], ringQ: [], ringPwf: [], ringThp: [] },         // the steadyCheck buffer
  pend: [Event], log: [Event], ext: { key: json },
  bal: { m0: {G, O, W, I}, cumIn: {G, O, W, I}, cumOut: {G, O, W, I} }, prov: [], flags: [] }
```

Numbers are plain arrays (doubles round-trip exactly through JSON; `NaN` / ±∞ are written as `null` and only ever appear in display
channels, never in state). `restore(snapshot())` followed by `run(T)` is bit-identical to an uninterrupted `run` in the same JavaScript
engine (EN15) — WD1 lists in its §11 record every field the step reads and EN15b asserts each is in the Snap (a field-coverage check on a
dummy step). A Snap of 60 cells ≈ 10–14 kB as JSON.

### 3.7 Replay file (`.wdrun`, JSON, MIME application/json)

```js
RunFile = { format: 'wts-welldyn-run', v: 1, app /*RELEASE_NOTES[0].ver*/, created /*ISO*/, engine: '1.0.0', engineId,
  well: { name },                                       // display only (the WTS_wells name), escaped on display
  model: { scalars: {wp_*: v}, tables: {survey, strings, restrictions, geo, flowline, rating, beans, lab, pump, corrSections, layers, glValves} },
  settings: { …opts of §3.1 except snapshot and ref },  events: [Event], duration_s,
  rec: { every_s, t: [], ch: { key: [] }, marks: [] },
  snaps: { every_s, list: [Snap] } | null,              // dropped (null) when the file would exceed 5 MB
  summary: Summary (§3.8), hash /*hash16 of model + settings + events*/ }
```

The `model` part uses the same scalar / table form as a Well Performance case (`WTS_wp_cases`), so M is rebuilt the way
`WTS_wp_cases.model(c)` does it (`WTS_wp_model.read` on an in-memory record and scalars), without touching storage. Opening a run never
changes the stored well model; "Adopt this model for the well" is a separate, confirmed action (WTS_wp_model.write + host autosave of the
scalars), off by default (Q14).

**Engines (R25).** `engineId` = hash16 of `Math.exp / log / pow / sqrt / sin` results on a fixed argument list, computed once at load.
The file's series are always shown as stored (never recomputed for display). A replay re-run or "Continue from here" from a file snapshot
is bit-identical when `engineId` matches; when it differs, the re-run is compared with the stored series at the stored samples and is
accepted within 0.5 % in rates and 1 psi in pressures until the first state change of a chaotic regime (heading); outside that it shows the
info note "made with a different JavaScript engine: the re-run differs from the recording after h:mm" — never "corrupt". `fromFile`
refuses only format / version / size / malformed JSON (`FORMAT`, `VERSION`, `TOO_BIG`).

### 3.8 Cases and summary

```js
Case = { id, name /*≤ 60 chars*/, created, settings, events, duration_s, summary: Summary | null, note /*≤ 200 chars*/ }
Summary = { duration_s, endState, states: [{key, from, to}] /*≤ 50*/, qo, qw, qg, qgForm, gorForm /*at the end*/, prior /*the reservoir prior used*/, thp_psig, pwf, qMax, qMin, thpMax_psig,
            pwfMax, liqMax_bbl, tLoading_h, tDead_h, cumO_STB, cumW_STB, cumG_MMscf, buildup: { pws_end, dpdlnDt, k_est } | null,
            gate: { dq, dp, ampQ, ampP } | null, provisional: [], massErr, engineId }
WTS_wd_cases.list(M) → Case[] (from M.dyn.cases)
WTS_wd_cases.save(case) → WTS_wp_model.write({dyn: {...}}) result (≤ 20 cases, ≤ 24 kB of dyn in total; oldest unnamed dropped first)
WTS_wd_cases.remove(id), WTS_wd_cases.toScenario(case) → {settings, events, duration_s}
```

### 3.9 Frozen fixtures `tests/_welldyn-shapes.js` (WD0, hash-pinned like `_wellperf-shapes.js`)

Built from the Well Performance fixtures (`require('./_wellperf-shapes').FIX`) with the changes listed; WD0 runs `WTS_wp_system.solve` on
each one, adjusts only the numbers marked *(tune)* within the stated range so the stated condition holds, and pins the steady reference
(`expect.op`: q, pwf, thp, choke regime, `R.lift.injMd` / pump intake where present) and the fixture hash. All are complete models M
(SHAPE.M of the Well Performance shapes), with `pvt.rv.mode 'none'` (no Rv, R13) and the default `surface.choke.subcritical` ('bound').

**Static and dynamic screens (WD0, R20).** For each gate fixture WD0 also confirms and pins: (a) the stable root and a critical choke
(y = p_dn / p_n ≤ the y_c of the model's rule, with a margin of ≥ 0.05); (b) no correlation pattern change in any segment of the R0 traverse
between 0.95 q_op and 1.05 q_op (a fixture sitting on a Beggs & Brill / Hagedorn & Brown pattern boundary is moved by its *(tune)* number);
(c) gas lift: `WTS_wp_gl.asheim(M, R)` verdict stable on both criteria; (d) loading margin as stated. WD0's lead spike (§9.0) runs a
prototype step loop on `gasVert` and `oilVert` for 1 h and records in §11.0 whether they settle; WD1 owns the final check (G1–G7).

| FIX | Built from | Changes | Condition WD0 confirms |
|---|---|---|---|
| `gasVert` | wellperf `gasWell` | vertical survey `[[0,0],[10000,10000]]`, 2-7/8" tubing to 9,850 ft, p̄r 3,500 psia, WGR 10 STB/MMscf, separator 500 psig, bean 24 *(tune 16–32)* | screens (a)(b), loading margin ≥ +0.3 |
| `gasLoad` | `gasVert` | p̄r 1,200 psia, WGR 30 STB/MMscf, separator 300 psig, bean 32 *(tune)* | loading margin in [−0.05, +0.10] at bean 32; < −0.15 at bean 16 |
| `gasHz` | `gasWell` | survey vertical to 7,000 ft, build 8°/100 ft to 90°, 2,000 ft lateral (azimuth 120°); tubing to the heel, 4-1/2" liner along the lateral; mid-perf at the lateral midpoint; bean 24 *(tune)* | screens (a)(b) |
| `oilVert` | wellperf `oilWell` | none (bean 32) — if the nodal choke regime is not critical, bean *(tune 24–32)* | screens (a)(b) |
| `oilVertTuned` | `oilVert` | `system.mult {hl: 1.10, f: 0.90}` (VLP tuning multipliers, R5d) | screens (a)(b) |
| `oilDev` | `oilWell` | the S-shaped `GAS_SURVEY` (MD 10,000 ft), mid-perf 9,950 ft MD, strings extended (tubing to 9,850 ft) | screens (a)(b) |
| `gasLift` | `oilWell` | WC 0.6, GOR 200, p̄r 2,400 psia *(tune)*; lift `gaslift`, packer 7,900 ft, q_inj 600 Mscf/d, p_inj 1,100 psig, sginj 0.65; `glValves` = `WTS_wp_gl.valvesFromDesign` of the WTS_wp_gl.design result on this model (pinned rows) | no natural stable root; stable root with gas lift (nodal injection); screens (a)(b)(c); `R.lift.injMd` pinned |
| `esp` | `oilWell` | WC 0.8, GOR 100, p̄r 2,500 psia; lift `esp`, pump MD 7,500 ft, 60 Hz, pump = `WTS_wp_esp.example()`, stages from `sizeStages` at 1,500 STB/d *(pinned)*, natural separation off | stable pumped root in the recommended range; screens (a)(b) |
| `staticOil` | `oilVert` | none; settings `start:'static', static:{kind:'liquid', liquid:'oil'}`, reservoir prior `none` | the well flows after opening |
| `buildup` | `oilVert` | IPR `darcyOil` with k 50 md, h 50 ft, rw 0.354 ft, re 1,500 ft, S 2, φ 0.2, ct 1.5e-5 1/psi (μ, B from the fluid) | J of `darcyOil` within 1 % of the `pi` it replaces; t_wbs and t_pss computed and pinned (C10: f = 1 is reached near 50 h and 0.1 t_pss ≈ 16 h at the review's estimate, so the 8 h shut-in of `shutInBuildup` lies in the infinite-acting window — WD0 records the exact values) |

Also `FIX.scenarios` (Event lists + durations + the opts they need): `beanUp` (oilVert: beans 16 → 24 → 32 at 0 / 1 / 2 h, 4 h),
`shutInBuildup` (buildup: **reservoir `transient`, prior `steady` 720 h**, steady 2 h, shut in 8 h; C10), `gasLoadDown` (gasLoad,
fallback on: bean 32 → 16 at 1 h, 8 h), `cycleTimer` (gasLoad: 2 h open / 2 h shut × 3), `foamerOn` (gasLoad at bean 16, fallback on,
foamer 1,000 ppm at 4 h, 10 h), `glUnload` (gasLift, `start:'static', static:{kind:'liquid', liquid:'water'}` — tubing and annulus full of
the model's water as the kill fluid (R22), reservoir prior `none`, injection 600 Mscf/d from 0, 12 h), `espStart` (esp, static liquid,
start 0 → 60 Hz at 1 Hz/s, 2 h), `levelSettle` (staticOil with `static:{kind:'level', liquidTopMd: 4000}` shut in 8 h: the sharp gas cap /
liquid level case of EN25, R11), `killColumn` (gasVert with `static:{kind:'liquid', liquid:'water'}` shut in 2 h: the column exceeds p̄r
and back-flows, EN5 / EN26, R14).

Frozen orders: `ORDER.COMP` (= `WTS_wd_engine.COMP`), `ORDER.STATES` (= `STATE_ORDER`, C9), `ORDER.CHANNELS` (= the CHANNELS keys),
`ORDER.REGIMES`. Shapes: `SHAPE.Sim`, `SHAPE.State`, `SHAPE.StepInfo`, `SHAPE.Snap`, `SHAPE.Event`, `SHAPE.Rec`, `SHAPE.RunFile`,
`SHAPE.Case`, `SHAPE.Summary`, `SHAPE.Ext`, `checkShape(name, obj)`. Helpers: `sharedApp(ctx, opts)`, `resetWellDyn(app)` (clears
`wts_page_welldyn`, the `dyn` key, `WTS_state.welldyn`, device prefs `wtspref_wd_*`), `loadFix(app, key)` (writes the fixture through
`WTS_wp_model.write` and the scalar store), `files()`, `STUBS`, `BASELINE` (the WD0 spike's step cost per fixture; WD1 replaces it with
its measured values, §5.6).

### 3.10 Mock engine `tests/_welldyn-mock.js` (WD0; not shipped)

`installWellDynMock(G, opts)` replaces the stubs with a deterministic closed-form stand-in with the **contract shapes** of revision 2:
`create` builds the grid from the model (minimum curvature on the survey, cells snapped like §4.2 incl. the injection-MD and pump breaks,
`segs` / `rough` filled), returns `C` / `ref` / `mHash` (hash16 of M without `dyn` + opts), the rate relaxes to `R0.op` (or to 0 shut in)
with a 10 min time constant, a liquid level rises / falls with the state, holdups and regimes follow the level, BHP follows a storage-like
exponential, all five components (`mI` zero unless gas lift) and every `faces` / `surface` / `loading` field of §3.2 are filled (lift gas,
vent and formation GOR for gas-lift / ESP fixtures), `STATE_ORDER` / `COMP` / `CHANNELS` are the frozen orders, snapshots carry every
§3.6 field, restore / events / `run` / `on` / `steadyCheck` behave as §3 (and are bit-identical on repeat). `opts.slow` makes `run` cost
wall time (page "running slower" path); `opts.fail` returns errors; `opts.engineId` overrides the engine fingerprint (cross-engine replay
path of RC). Also usable as plain browser code for screenshots (no `require`).

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

### 4.1 Components and the flash (black oil, one path through the solve's fluid context)

Conserved per cell: formation gas m_G, stock-tank oil (or condensate) m_O, water m_W, lift gas m_I, foamer m_F (lbm). With γ_o, γ_g, γ_w the
stock-tank gravities, γ_I = `C.gl.sg` (sginj) and the app's base conditions (`WTS_baseConditions`, the same as `WTS_flowline_props` uses
for B_g):

- N_o (STB) = m_O / (350.17 γ_o), N_w (STB) = m_W / (350.17 γ_w), G (scf) = m_G / (0.076362 γ_g), G_I (scf) = m_I / (0.076362 γ_I).
- **One fluid object.** F = `C.F` of `WTS_wp_system.context(M)` — built by the solve's own `_ctx` as
  `WTS_wp_fluid.build(M.fluid, {T_F: M.res.T_F, table: true})` (wp-system ≈ line 256) — so every property is the same binned table, bit for
  bit, as the steady reference (R18; pinned by EN24). Never a second `WTS_wp_fluid.build`.
- **Per-cell properties (R13).** `WTS_flowline_props` caps the solution ratio at the fluid's GOR (rs = min(GOR, R_s(p))) and weights σ_L
  and the emulsion viscosity by the rate fractions f_o / f_w. The engine therefore evaluates each cell with a per-cell fluid view
  `WTS_wp_fluid.flowlineFluid(F, q_cell)` whose GOR is the cell's own ratio R_cell = G / N_o (formation gas only) and whose oil / water
  fractions are the cell's N_o : N_w; with lift gas present the view carries `pvt.injGas = {qg_MMscfd ∝ G_I, sg: γ_I}` in the cell's
  G_I : G_f ratio, exactly the mechanism of the nodal `C.gl.Finj` (R8). In a steady flowing column R_cell = the produced GOR, f_o / f_w =
  the produced split and G_I / G_f = q_inj / q_g,free, so the properties equal the nodal ones at the same (p, T). WD1 checks whether the
  (p, T)-binned table is keyed on GOR / injGas; where it is not (one table per fluid), cells whose view differs from the table's reference
  use the exact props path (`table: false` semantics for that call) — measured in §11.1 and budgeted in §5.6. One props call per cell per
  step at (p_i^n, T_i) plus one at (p_i^n + 1 psi, T_i) for ∂V/∂p; the rate argument passed is the cell's in-situ composition, never the
  well's reference rate.
- Dissolved gas G_d = min(G, N_o R_s(p)); free formation gas G_f = G − G_d; lift gas is always free (never dissolves, never counted in
  R_cell). Wet gas (`pvt.liquidNoTransfer`, D14 of the Well Performance plan): R_s = 0, B_o = B_c (constant). Rv (vaporised condensate,
  `pvt.rv`) is refused (`RV_NOT_IN_TRANSIENT`, §3.1) and kept out of the fixtures.
- Phase volumes (ft³): V_o = 5.6146 N_o B_o, V_w = 5.6146 N_w B_w, V_g = (G_f + G_I) B_g,mix (B_g at the mixed gravity of the view);
  V^content = V_o + V_w + V_g; holdups α_k = V_k / V^content (α_g = all free gas; the lift-gas share of it is x_I = G_I / (G_f + G_I)).
- **Volume derivatives** of the same function V^content(m_G, m_O, m_W, m_I, p) (R2, R13c), in ft³/lbm and ft³/psi:
  - ∂V/∂m_W = 5.6146 B_w / (350.17 γ_w);  ∂V/∂m_I = B_g,mix / (0.076362 γ_I);
  - saturated cell (G_f > 0): ∂V/∂m_G = B_g,mix / (0.076362 γ_g); ∂V/∂m_O = (5.6146 B_o − B_g,mix R_s) / (350.17 γ_o);
  - undersaturated cell (G_f = 0): ∂V/∂m_G = 5.6146 (∂B_o/∂R)_p / (0.076362 γ_g), ∂V/∂m_O = 5.6146 (B_o − R (∂B_o/∂R)_p) / (350.17 γ_o),
    with (∂B_o/∂R)_p by a one-sided difference of the same props view (R → R + 1 scf/STB; only in undersaturated cells holding oil);
  - ∂V/∂p by a one-sided difference of V^content at fixed masses (Δp = +1 psi) through the same props view — the liberation term
    −B_g N_o ∂R_s/∂p then appears only where G_f > 0 (R13d) and no separate c_o is mixed in (R13c) — plus the compliance term
    −V_i (c_pipe + max(0, c_w,min − c_w,cell) α_w) with c_pipe = 3e-6 1/psi and c_w,min = 3e-6 1/psi (ASSUMED, C6, key `compliance`). The
    compliance only acts through dp/dt: it does not change a steady state (the gate) and keeps a liquid-full shut-in well well-conditioned.

### 4.2 Discretisation

- The flow path is the nodal traverse's segment list: `WTS_wp_well.segmentsFor(W)` from the mid-perforations to the wellhead, split by
  `WTS_wp_vlp.sectionsFor(W, C.sections, C.corrWell)` into per-section correlation keys exactly as the solve (R5e) — tubing, then casing /
  liner below the end of tubing; the annulus path when `M.well.path = 'annulus'`. n cells (default 60, 20–200) are allotted to segments in
  proportion to MD (at least one per segment, largest remainder), so **no cell straddles a bore change, a restriction, a section boundary,
  the end of tubing, a gas-lift valve, the nodal injection depth `R0.lift.injMd` (nodal gas-lift mode, R9) or the pump depth** (those MDs
  are added as forced breaks before the allotment). A cell keeps a reference to its segment object (`grid.segs`): its `theta` (degrees
  from horizontal, asin(dz/len) of the marcher segment, R5a), ID, area, `corr` key and restriction are passed unchanged to the correlation.
  Roughness is the one length-weighted `W.rough` the march uses (R5b). ΔZ is exact from minimum curvature (gravity on TVD, friction on
  MD — as the nodal march). `inc` (from vertical, the station average) is kept for display and the drift closure only.
- A restriction (SSSV, nipple, downhole choke) at a face is the marcher's rule (49-calc-flowline `_restr`, R7):
  Δp = K ρ_n v² / (2 g_c · 144) (psi), v = v_m A / A_d = j / β² the **bore-throat** velocity (ft/s), ρ_n = (ρ_L j_L + ρ_g j_g) / j the no-slip
  density of the face (lbm/ft³), β = d / ID, K = `restr.k` when given else 0.5 (1 − β²) + (1 − β²)².
- Horizontal sections are ordinary cells with theta = 0° (ΔZ ≈ 0): gravity vanishes; the correlation sees the same angle as in the
  nodal march; the drift closure uses the inclination form (§4.4).

### 4.3 Conservation

For each component c ∈ {G, O, W, I, F}:

  m_c,i^{n+1} = m_c,i^n + Δt (F_c,k=i − F_c,k=i+1 + S_c,i)        (lbm; F lbm/s at faces, + upward; S lbm/s from extensions, fixed for the step)

Face mass fluxes from the superficial velocities (ft/s) and the **donor** cell of each phase flux (the cell below for an upward phase flux,
the cell above for a downward one; at counter-current faces the bounded flux of §4.4 decides the phase fluxes and the donors):

  F_O = A j_o (350.17 γ_o) / (5.6146 B_o)                                   (j_o ft/s in situ; 350.17 γ_o lbm per STB; 5.6146 B_o ft³ per STB)
  F_W = A j_w (350.17 γ_w) / (5.6146 B_w)
  F_G = A j_g (1 − x_I) / B_g,mix · 0.076362 γ_g + (G_d / N_o)_donor (0.076362 γ_g) · A j_o / (5.6146 B_o)     (free + dissolved gas)
  F_I = A j_g x_I / B_g,mix · 0.076362 γ_I                                  (lift gas, free only)
  F_F = F_W · c_F                                                           (foamer travels with the water, c_F = m_F / m_W of the donor)

with B_o, B_g,mix, x_I of the phase's donor cell and the dissolved ratio taken as the donor cell's **actual** G_d / N_o (R13a), not R_s(p) —
an undersaturated cell then loses dissolved gas at its own ratio. Face 0 carries the reservoir inflow (stock-tank rates of §4.7 converted
to lbm/s; the formation stream, I = 0) or, on back-flow, cell 0's contents (§4.7); face n carries what leaves through the choke at the top
cell's composition. The scheme is conservative: Σ_i m_c changes exactly by Δt (F_c,0 − F_c,n + Σ S_c) up to round-off (§5.2, EN2).

### 4.4 Drift-flux closure (WD-D4)

At face k with mixture flux j = Q_k / A (ft/s), the gas flux follows the drift-flux form

  j_g = α_g (C_0 j + v_d),   j_L = j − j_g,   j_w = f_w j_L − φ_ow,   j_o = j_L − j_w

with α_g from the donor (below) cell for co-current faces and from the bounded counter-current flux otherwise (below), f_w the water
fraction of the liquid donor and φ_ow the oil–water settling flux of §4.10.

**`driftflux` closure** (provisional, D17 — no verified worked example; the coefficients to verify against the papers, Q9):

- Zuber & Findlay (1965) form; profile parameter of Shi et al. (2005): C_0 = A / (1 + (A − 1) γ²), γ = clamp((β − B)/(1 − B), 0, 1),
  β = max(α_g, F_v α_g |j| / v_sgf), A = 1.2, B = 0.3, F_v = 1; v_sgf = the flooding (Kutateladze) velocity
  K_u (σ g Δρ / ρ_g²)^¼ with K_u from the Wallis-Makkenchery fit of the critical Kutateladze number on the dimensionless diameter.
- Drift velocity: v_d = (1 − α_g C_0) C_0 K(α_g) v_c m(θ) / (α_g C_0 √(ρ_g/ρ_L) + 1 − α_g C_0) (ft/s),
  v_c = (σ g Δρ / ρ_L²)^¼ (σ dyn/cm → lbf/ft by × 6.852e-5, g = 32.174 ft/s² with g_c; ρ lbm/ft³), K = 1.53 / C_0 for α_g ≤ a_1 = 0.06
  (the Shi et al. form, C3), K = K_u for α_g ≥ a_2 = 0.21, linear between; inclination factor m(θ) = m_0 (cos θ)^{n_1} (1 + sin θ)^{n_2}
  with θ from vertical, m_0 = 1.27, n_1 = 0.24, n_2 = 1.08 — constants **to verify** against Shi et al. (2005) (C3, Q9; labelled).
  Because of the (1 − α_g C_0) factor and C_0 → 1 as α_g → 1, the flux function f(α) = α (C_0 j + v_d) has f(0) = 0 and f(1) = j.
- Liquid properties: the donor liquid mixture (oil + water by volume); σ = σ_L · sigF_i (foamer factor, §4.11).

**`corr` closure** (default):

- Once per step and cell, the cell's correlation is evaluated **exactly as the nodal march evaluates it**, through the WD0 export
  `WTS_flowline_gradAt(fluidView, p_i, T_i, seg_i, opt)` (= the private `_gAt` of 49-calc-flowline.js, which builds `inp`, calls
  `WTS_flowline_corr[seg.corr ?? opt.corr].grad(inp)` and applies the VLP-tuning multipliers `_applyMult`, R5d): `seg_i` the cell's marcher
  segment (`theta` from horizontal, ID, area, section key — R5a / R5e), `opt = {corr: C.corrWell, rough: grid.rough, payne: C's flag,
  accel: C's flag, mult: C.mult}` — the same object the solve builds for its traverse (wp-system ≈ lines 282–288, R5c). It is evaluated at
  the **cell centre** (C2): p_i^n, T_i, and a fluid view whose stock-tank stream is the mean of the cell's two face stock-tank fluxes of the
  last step, so v_sL, v_sg are the march's for the same stream at the same (p, T). From its holdup H_L (after the multipliers):
  C_0 = 1, v_d,corr = v_sg / (1 − H_L) − (v_sL + v_sg), bounded only by the co-current limits −j ≤ v_d ≤ j α_L / α_g (so that j_g ≥ 0
  and j_L ≥ 0 at the face's own α_g; R4 — no upper clamp tied to v_d,ZF, which vanishes in horizontal cells and at high gas fraction).
  The lagged value is under-relaxed, v_d^n = v_d^{n−1} + ω (v_d,corr − v_d^{n−1}), ω = 0.5 (R20). At a fixed point (steady flow) the cell
  gas fraction is exactly 1 − H_L of the correlation and the gate cells see the nodal holdup.
- **Blend only where needed (C1).** A face is co-current when its last-step j > 0, j_g > 0 and j_L ≥ 0. Weight w = 1 for a co-current
  face with |j| ≥ j_hi (0.10 ft/s); w = smoothstep((|j| − j_lo)/(j_hi − j_lo)) for a co-current face with j_lo ≤ |j| < j_hi (j_lo = 0.05
  ft/s); w = 0 for a counter-current face or |j| < j_lo. Then C_0 = w + (1 − w) C_0,DF, v_d = w v_d,corr + (1 − w) v_d,DF. Low-velocity
  co-current cells (a casing rathole below the end of tubing, an ESP intake section) keep the correlation holdup.

**Bounded face flux (R11).** The gas flux at every face is the Godunov flux of the scalar flux function f_k(α) = α (C_0(α) j + v_d(α))
at the root's j, with the face properties frozen for the step (α_dn = the cell below, α_up = the cell above):

  j_g,k = min_{α ∈ [α_dn, α_up]} f_k(α)  if α_dn ≤ α_up,     j_g,k = max_{α ∈ [α_up, α_dn]} f_k(α)  otherwise.

On a co-current `corr` face f is linear and increasing in α, so this is the upwind value α_dn (j + v_d). Elsewhere the extremum is found
from the end points and a golden-section search on the interior (≤ 12 evaluations, arithmetic only). Because f(0) = 0 and f(1) = j, no gas
is taken from a liquid-full cell below and no liquid is drawn from a gas-full cell above (a sharp gas cap or liquid level, EN25). Donors:
gas from the cell below when j_g > 0 (above when < 0); liquid from the cell above when j_L < 0 (below when > 0). The CFL of §4.6 keeps every
phase outflow below the donor's content; a step that would still make a mass negative is rejected (§4.6).

### 4.5 Quasi-steady momentum (pressure profile)

Given the wellhead pressure p_n (face n) of a root trial and the face fluxes Q of the current Picard sweep (§4.6), faces are filled
downward:

  p_k = p_{k+1} + [ ρ_m,i ΔZ_i / 144 + g_f,i(j_i) ΔL_i ] / (1 − E_i) + Δp_restr,k(j_k) − Δp_pump,k(Q_k)          (psi)

- ρ_m,i = Σ α ρ of the cell (lbm/ft³) at the holdups at the start of the step (the storage term — a column that loses gas gets heavier);
  ΔZ_i ft TVD, ΔL_i ft MD; i = the cell between faces k and k+1; j_i = ½ (Q_k + Q_{k+1}) / A_i.
- Friction gradient (psi/ft), magnitude × sign (R3): g_f,i(j) = |g_f,i,last| · sign(j) · (j / j_i,last)², with g_f,i,last the correlation's
  `gradF` from the once-per-step `WTS_flowline_gradAt` call of §4.4 (multipliers included) and j_i,last the cell's mean flux of the last
  step. When |j_i,last| < j_lo or |j| < j_lo (near-zero flow, shut-in, flow reversal), the single-phase mixture form is used instead:
  g_f = f_M ρ_m j |j| / (2 g_c d_ft · 144), f_M the Moody friction factor at Re = 1488 ρ_m |j| d_ft / μ_m and ε / d of `grid.rough` —
  arithmetic only (μ_m from the cell's props of the step). No division by j_last ever occurs below j_lo.
- E_i = the correlation's acceleration factor `Ek` of the step's call (clamped to ≤ 0.9) when the solve's `accel` flag is on, else 0.
- Δp_restr from §4.2 at the face's no-slip density and throat velocity; Δp_pump from the ESP extension's linearised `faceDp` (§4.12).
- Cell pressure p_i = ½ (p_k + p_{k+1}); BHP = p_0 (mid-perforations, the nodal bottom node).

### 4.6 Pressure coupling, time step and integrator

**Volume balance (R1, R2).** Each cell's contents must fill its fixed volume V_i (ft³, plus the compliance of §4.1). Differentiating
V^content(m_G, m_O, m_W, m_I, p) = V_i in time and keeping the linearisation residual:

  Σ_c (∂V/∂m_c)_i (F_c,i − F_c,i+1 + S_c,i) + (∂V/∂p)_i (p_i^{n+1} − p_i^n)/Δt = (V_i − V_i^content(m^n, p^n)) / Δt          (ft³/s)

with the derivatives of §4.1 (ft³/lbm, ft³/psi; (∂V/∂p)_i < 0), F_c lbm/s, S_c lbm/s. Solved for the outflow at the top face of the cell:

  Σ_c (∂V/∂m_c)_i F_c,i+1(Q_{i+1}) = Σ_c (∂V/∂m_c)_i (F_c,i + S_c,i) + (∂V/∂p)_i (p_i^{n+1} − p_i^n)/Δt + (V_i^content − V_i)/Δt

The left side is the in-situ volume rate of the stream leaving the cell, measured at the cell's state ("Q_out"); the first right-hand term
is the volume rate arriving plus the sources ("Q_in + Q_src"). So a pressure rise (∂V/∂p · Δp < 0) gives Q_out < Q_in (the contents
compress and accept more), and an over-full cell (V^content > V_i) expels more — the drift is corrected, not amplified (EN23 tests the
first with a closed column). The mismatch term only carries the linearisation residual of the previous step (second order in Δt, ≈
round-off in steady flow, where the expansion of gas along the well is carried by the Σ (∂V/∂m_c) F terms themselves); `S.balance.volDrift`
= max_i |V^content − V_i| / V_i and the flag VOL_DRIFT appear when it exceeds 0.5 %. F_c,i+1(Q) is the face flux of §4.3 / §4.4 at
j = Q / A: linear in Q on a co-current `corr` face (a closed-form solve), monotone otherwise (≤ 8 safeguarded secant steps, arithmetic only).
Q_0 is the in-situ volume rate of the reservoir inflow at (p_0, T_0) (§4.7; negative on back-flow).

**Wellhead root with inner Picard sweeps (R3).** Unknown: p_n^{n+1}. Per root iterate r with trial p_n:

1. Q^(0) = the face fluxes of the previous root iterate (for r = 0: the converged Q of the last step).
2. Sweep s = 1 … `picard.maxSweeps` (3): march §4.5 **down** with friction / throat / pump terms at Q^(s−1) → p_k, p_0 → inflow q(p_0)
   (§4.7) → Q_0 → march the volume balance **up** with p_i = ½ (p_k + p_{k+1}) → Q^(s). Stop when
   max_k |Q_k^(s) − Q_k^(s−1)| ≤ tolQ + tolQrel |Q_k^(s)| (1e-6 ft³/s + 1e-4 relative).
3. Residual r(p_n) = Q_n^(s) − Q_choke(p_n) (§4.8).

Bracket [p_dn + 0.01, p_max] (p_max = max(p̄r, p_0^n) + the static column + 500 psi), safeguarded secant / Illinois, ≤ 12 iterations,
tolerance |Δp_n| ≤ 0.01 psi or |r| ≤ 1e-7 ft³/s. After convergence one more sweep at the root must move p_0 by ≤ 0.01 psi, else the step
is rejected (`PICARD`). Shut in: Q_choke = 0. No choke (`M.surface.choke.present = false`): r = p_n − p_dn(Q_n) (the flowline back
pressure, or the fixed `M.system.thp_psig` when given — the nodal boundary). A trial whose march produces a negative pressure is "lost" (as
in the nodal scan) and the bracket shrinks.
**Cost per step:** outside the root, per cell 2 props calls (+1 in undersaturated oil cells, §4.1), 1 `WTS_flowline_gradAt` call, the
face Godunov extrema where w < 1, and 2 `faceDp` calls for an ESP; inside the root, ≤ 12 iterates × ≤ 3 sweeps × (one O(n) down pass + one
O(n) up pass) of arithmetic and one choke evaluation per iterate (closed-form multiphase / gas choke, §4.8) — typically 4–6 iterates × 1–2
sweeps in smooth flow. Budgets in §5.6.

**Phase fluxes and transport** with the converged Q_k (§4.4, §4.3). Order 1: donor values; order 2: MUSCL slopes of α with the minmod
limiter (option; the gate uses order 1).

**Time step (R12).**
  Δt = min( dtMax, 1.5 Δt_prev, CFL · min_i ΔL_i / max(|v_g,i|, |v_L,i|, |λ_k|, |λ_{k+1}|, 1e-6), Δt_event, Δt_stroke )
  with v_g = j_g / α_g, v_L = j_L / α_L the phase velocities of the cell's faces (explicit donor transport of each phase) and λ_k = ∂f_k/∂α
  the kinematic-wave (characteristic) speed of the drift-flux flux function at the face, C_0 j + v_d + α (∂(C_0 j + v_d)/∂α), by a central
  difference (±1e-3 in α) — larger than the phase velocities in counter-current flow. CFL default 0.5. After the step: if any
  |p_k^{n+1} − p_k^n| > dpMaxFrac · p_k^n, or a component mass would turn negative, or the root / Picard sweeps failed, the step is
  **rejected** and retried with Δt/2 (≤ 8 halvings, then `code: 'STEP_FAIL'` and the run stops with a message). Δt_event lands a step
  exactly on the next scheduled event; Δt_stroke resolves a choke stroke in ≥ 5 steps.
**Mass balance** per step, c ∈ {G, O, W, I} (the foamer tracer separately): e_c = |Σ m_c^{n+1} − Σ m_c^n − Δt (F_c,0 − F_c,n + Σ S_c)| /
max(Σ m_c^n, 1); max_c e_c ≤ 1e-10 (round-off); the cumulative error vs the initial mass + cumulative in − out ≤ 1e-8 over 24 h (EN2, C2).
Reported in `S.balance` and the run summary.

### 4.7 Reservoir (`WTS_wd_res`)

- **Mode `ipr`** (default; exact consistency): sandface stock-tank rates q = I.qAt(p_0) from the solve's `C.I` (oil: q_o with q_w by WC
  and q_g by GOR; gas: q_g with CGR / WGR liquids), instantaneous. Afterflow and storage then come from the cells only.
- **Back-flow (R14; option `backflow`, default on, provisional key `res_back`).** When p_0 > p̄r the formation takes fluid:
  q = −J_r (p_0 − p̄r) in reservoir volume, J_r = the IPR's slope at p̄r (|dq/dp_wf| as q → 0⁺, by a difference of `I.qAt` at p̄r − 1 psi;
  for p² / m(p) models the same slope applied to the potential difference). The stream is cell 0's contents (face 0 is donor-upwinded by
  the sign of Q_0: liquid first where cell 0 is liquid — the drift flux still separates the phases inside the well), converted to stock-tank
  masses with cell 0's properties and booked as `cumOut` at face 0. With `backflow: false` the inflow is clamped to q ≥ 0 and the flag
  RES_NO_BACKFLOW is raised when p_0 > p̄r. EN5 (a liquid column above p̄r forms a level / gas cap) and EN26 run with back-flow on.
- **Mode `transient`** (line source with superposition of the IPR's drawdown). Let Φ be the IPR's potential (`p` for oil and linear
  models, `p²` for back-pressure / LIT p², `m(p)` for LIT m(p) and Darcy gas, chosen by `potential: 'auto'`) and
  u(q) = Φ(p̄r) − Φ(I.pwfAt(q)) the steady drawdown in that potential; split u = u_D (Darcy, time-dependent) + u_ND (non-Darcy b·q² or
  D·q terms, instantaneous) where the model gives the split. Then
    Φ(p̄r) − Φ(p_wf(t)) = Σ_j [u_D(q_j) − u_D(q_{j−1})] · f(t − t_j) + u_ND(q(t))
    f(τ) = clamp( [½ E1(r_w,e² / (4 η τ)) + S_e] / [ln(r_e / r_w,e) − 0.75 + S_e], 0, 1 ),   η = 0.0002637 k / (φ μ c_t)   (ft²/h, τ in h)
  with r_w,e = r_w, S_e = S for S ≥ 0 and the effective radius r_w,e = r_w e^{−S}, S_e = 0 for S < 0 (R15 — a stimulated or fractured well
  never gets f ≤ 0 at small τ). E1 = `PRiSM_E1` (01-foundation). As τ → ∞ with a constant rate, f → 1 and the inflow equals the IPR (so
  the gate also holds in transient mode after stabilisation, RS5). Negative rates (back-flow) use the linear (Darcy) part only.
- **Prior history (R15).** `reservoir.prior`: `steady` — before t = 0 the well produced at q_op for `t_h` (default 720 h; one term),
  the default for `start: 'steady'`; `none` — the reservoir is at p̄r and in equilibrium at t = 0 (no terms), the default for
  `start: 'static'`; `shutin` — produced at q_op for `t_h`, then shut in for `shut_h` before t = 0 (two terms). The run summary states
  the prior used.
- Each step solves q at the trial p_0 with the past sum precomputed (it does not depend on the current rate): u_D(q_n) =
  u_D(q_{n−1}) + [Φ(p̄r) − Φ(p_0) − u_ND(q_n) − Σ_{j<n} Δu_j f(t − t_j)] / max(f(Δt), 1e-3), by a safeguarded Newton on the monotone u.
  Term compaction: consecutive terms with f(t − t_j) = 1 merge into the base; at most 400 terms (two adjacent terms merge at their
  Δu-weighted log-mean time when the count is exceeded; RS8 bounds the error).
  Parameters: from `M.dyn.res` (page inputs), else from a `darcyOil` / `darcyGas` IPR's params, else `PRiSM_getWell()` on a button; a
  missing parameter keeps the mode `ipr` and says so. Consistency check: the stabilised resistance of the `darcy*` IPR equals the
  denominator (RS2).
- Gas uses Φ = m(p) by `PRiSM_mpTable` (as `WTS_wp_ipr` does) with η at p̄r (pseudo-time not used — provisional for large drawdowns).
- **Verification status (D17):** the infinite-acting line source E1 term is an exact analytical solution — `verified` by identity with
  PRiSM model #1 (homogeneous, Stehfest) on a constant-rate drawdown within 0.5 % for t_D > 100 (RS1, X-check C8). The superposition
  of a non-linear IPR's drawdown, the bounded-reservoir cap at f = 1 (no pseudo-steady depletion in a run), the negative-skin effective
  radius, back-flow and the gas η are **provisional** (never defaults where `ipr` serves; `transient` is used by the build-up preset only).

### 4.8 Choke and flowline (surface boundary)

- Downstream pressure p_dn(q): the flowline marched back from the separator by `WTS_flowline_march` with the solve's own options (wp-system
  ≈ line 396: `C.corrLine`, `C.stepFtLine`, roughness 0.0018 in, accel / Payne on) on 12 rates (0 … 1.5 × max(q_op, 10 % AOF)), tabulated at
  `create` (reused through `opts.ref`) and re-tabulated when the produced GOR or WC drifts by more than 10 % from the table's reference
  (the table and its reference GOR / WC are in the Snap, R16). Monotone cubic (PCHIP, `WTS_wp_system._pchip`) in between.
- Pressures: the engine holds p_n in **psia**; every shared choke function that takes gauge pressure gets p1_psig = p_n − 14.696 and
  p2_psig = p_dn,psig (the PATM of the solve; R6). y = p_2 / p_1 is formed in absolute pressures.
- **Critical-ratio rule = the model's nodal rule (R6).** With `surface.choke.subcritical` 'bound' (the default, also when the key is
  missing): y_c = `WTS_wp_system.GILBERT_YC` = 0.588; critical when y ≤ y_c. With 'sachdeva': y_c from `WTS_chokeperf_sachdeva` at the top
  cell's state, as the solve. `S.surface.yc` records it.
- Choke rate at p_1 = p_n, p_2 = p_dn:
  - gas / condensate: `WTS_chokeperf_gasRate` (isentropic nozzle, critical and sub-critical, continuous; the nodal gas choke);
  - multiphase, critical (y ≤ y_c): q = q_c(p1_psig) by inverting the nodal critical correlation (`C.choke.corr`, Gilbert family by
    default) at the top cell's GLR — closed form, identical to the nodal choke in critical flow;
  - multiphase, sub-critical (y > y_c): the nodal 'bound' rule is a static conservative construction (p1 = max(p1_crit, p2 / y_c)) with no
    transient meaning; the engine uses, by `opts.choke.subcritical`: `model` (default) — under 'bound' the provisional closing shape
    q = q_c(p_1) · √(1 − ((y − y_c)/(1 − y_c))²) (continuous at y_c, zero flow at y = 1), under 'sachdeva' the continuous Sachdeva model
    scaled by the nodal rate factor (as the solve, provisional); `shape` — the closing shape in both cases. Both are provisional (key
    `choke_sub`) and **never used by a gate fixture** (§3.9 screen (a): critical with a 0.05 margin); `S.surface.regime` is 'critical' |
    'subcritical' (never 'subcritical-bound' in time).
  - liquid only (GLR < 10 scf/STB): the incompressible orifice of the nodal solver (1022.7 C_d d² √(Δp/SG)).
- The gate compares `S.surface.regime` with `R.surface.choke.regime` of the steady reference (both 'critical' on the fixtures).
- Bean changes and shut-in move the effective bean area linearly over `strokeTime_s` (default 10 s); a closed choke is Q_choke = 0.
- Stock-tank rates at the wellhead from the top cell's composition (oil, water, free + dissolved formation gas, lift gas), converted to
  in-situ volume at (p_n, T_n) for the residual. Surface accounting (C8): `qg` = formation gas + lift gas leaving the choke + ESP vent gas
  (§4.12); `qgForm` = formation gas only; `gorForm` = qgForm / qo (the formation GOR, reported apart); `gor` = qg / qo.

### 4.9 Temperature

`frozen` (default; the gate): T_i = the steady reference's flowing temperature at the cell centre (`R0.traverse` t by MD; the linear,
relaxation or enthalpy profile of the model), kept for the whole run. `relax` (provisional): open → T_i relaxes to the frozen flowing
profile scaled to the current rate, T_target = T_geo + (T_flow − T_geo)·min(1, q/q_op)^½; shut in → T_target = T_geo (geotherm at the
cell TVD); dT_i/dt = (T_target − T_i)/τ_T, τ_T = 2 h (ASSUMED). THT = T of the top cell; the wellhead hydrate margin uses the existing
`WTS_hydrate_temp` check at (THP, THT) once per recorded sample (flag only).

### 4.10 Segregation, settling and liquid fallback

- **Gas–liquid segregation** in a shut-in or slow well comes from the drift closure with j ≈ 0: gas rises and the liquid falls by the
  same volume through each face, with the **bounded Godunov flux** of §4.4 (R11) — no gas is drawn from a liquid-full cell and no liquid
  from a gas-full cell, so a sharp gas cap or liquid level forms without step rejections (EN25). A gas cap forms at the top and the liquid
  collects at the bottom; `inventory.liquidTopMd` / `gasCapBottomMd` are the MDs where α_L crosses 0.5 from below / above (interpolated).
- **Oil–water (or condensate–water) settling** within the liquid (provisional): φ_ow = α_o α_w / α_L · v_s (1 − α_w)^{2.39} (hindered
  settling, Richardson-Zaki exponent), v_s = v_s0 · (ρ_w − ρ_o)/(ρ_w − ρ_o)_ref, v_s0 = 0.05 ft/s at Δρ_ref = 15 lbm/ft³ (ASSUMED);
  water moves down relative to oil; applied only where |j_L| < j_hi.
- **Liquid fallback** (`fallback: true`, provisional, Q1): where the local gas velocity v_g = j_g/α_g is below the critical velocity
  v_c,i of §4.11, part of the liquid flux reverses: j_L ← j_L − α_L,above α_g,below v_fb (1 − v_g/v_c,i), v_fb = 0.5 ft/s (ASSUMED film fall-back
  velocity), limited by the CFL; the exchange is scaled by α_L of the cell above and α_g of the cell below (the liquid falls from above
  and swaps with gas from below), so it vanishes when either donor is empty (positivity; integration fix, §11.7). Off by default (D17); on in the "gas-well loading" scenario preset; zero above the critical velocity, so
  the gate is unaffected.

### 4.11 Critical velocity, foamer and loading

- Critical velocity per cell from the wellhead to the end of tubing, **the nodal rule of `WTS_wp_loading`** (R21): the rathole below the
  EOT is reported apart (`loading.belowEot`); the liquid is **water** when the well makes water (WGR > 0 or WC > 0), else condensate
  (its ρ_o, σ_o); v_c = C σ^¼ (ρ_L − ρ_g)^¼ / ρ_g^½ (ft/s; σ dyn/cm, ρ lbm/ft³), C = the coefficient of `WTS_wp_system.LOAD.turner` (Turner
  et al. 1969, with the 20 % uplift) or `LOAD.coleman` (Coleman et al. 1991) — the same constants object, never re-typed. **Method rule =
  the nodal rule:** Coleman when the flowing wellhead pressure (the same quantity the nodal rule reads, `S.surface.thp`) is below 500,
  else Turner; between 500 and 1,000 both are reported (`loading.both`) and the verdict uses Turner, as `WTS_wp_loading`.
- q_c,i (MMscf/d) = 3.067 p_i v_c,i A_i / ((T_i + 460) z_i) with the area of the conduit above the cell's lower face (the nodal `areaAt`
  rule); `loading.qcVert_MMscfd` = max_i q_c,i over the tubing; `ratio` = q_g,formation,surface / q_c in use; `vRatioMin` = min_i v_g,i /
  v_c,i; limiting MD / TVD at the maximum.
- **Belfroid et al. (2008) inclination correction** (option `loading.belfroid`, **default off** — Q16; provisional): v_c,θ = v_c ·
  [sin(1.7 β)]^{0.38} / 0.74 with β the angle from horizontal **in radians** (β = π/2 − θ, θ from vertical), applied for 0 < β < π/2.
  `loading.qcBelfroid_MMscfd` is always computed and shown beside the vertical value; the one in use (`qc_MMscfd`, the states and the
  fallback of §4.10) follows the option. With the option off (the default) the engine is identical to the nodal rule.
- **Consistency (EN12):** on a steady run with Belfroid off, q_c (both methods), the method choice and the limiting depth equal
  `WTS_wp_loading(R0, …)` on the same model within 2 %; with Belfroid on, EN13 checks the factor on a 60° cell in closed form and EN12b
  checks that a vertical fixture is unchanged.
- **Foamer** (extension `foamer`, provisional): concentration c (ppm by mass in the water) is transported with the water (§4.3) from the
  injection MD (capillary string) or the surface (batch / down the annulus — injected into the top cell); the effective surface tension
  factor sigF = 1 − r(c), r(c) = r_max c / (c + c_50), r_max = 0.6, c_50 = 500 ppm (ASSUMED; Q10). σ_e = σ_L · sigF lowers v_c by
  sigF^¼ (C11) and the drift velocity (§4.4). Foam density reduction is not modelled (stated in Notes).

### 4.12 Gas lift and ESP (extensions)

**Gas lift** (`gaslift`; provisional except the static gas column, the dome correction and the mixed-gravity lift gas, which reuse
existing engines). Lift gas is the separate component I (§4.1): free only, never dissolved, properties at the mixed gravity through the
same `pvt.injGas` mechanism as the nodal `C.gl.Finj` (key `liftgas_mix`, identity with nodal), counted in the surface gas rate, the mass
balance, the Snap, CHANNELS (`qinj`, `liftgas`) and the CSV (R8).

- Mode `nodal`: the lift gas q_inj (`C.gl.qinj`, gravity `C.gl.sg`) enters the tubing cell just above the forced break at `R0.lift.injMd`
  (§4.2, R9) as an I source — used by the gate (G5).
- Mode `valves` (default when `M.lift.gl.valves` has rows): annulus = one control volume from the surface to the packer, volume
  V_a = Σ π/4 (ID_csg² − OD_tbg²)/144 · L; contents: lift-gas mass m_a and a liquid column (the model's water as the kill fluid, R22, or
  produced liquid) of volume V_al with its top at MD z_L. Casing surface pressure from the real-gas law on the gas volume above z_L (Z from
  `WTS_gaspvt_z`, mean annulus T); casing pressure at depth: gas column p_c(z) = p_cs exp(0.01875 γ_I ΔTVD / (z̄ T̄_R)) (psia; one Z
  iteration; cross-checked against `WTS_gaslift_casingP` within 0.5 %, LF2), below z_L + ρ_L ΔTVD / 144.
- **Valve mechanics in gauge (R23).** `WTS_wp_gl.pdAt(ptro, R, T)` returns the dome pressure in psig; the engine forms
  p_c,g = p_c − 14.696 and p_t,g = p_t − 14.696 from its psia values and evaluates the IPO balance in gauge: open when
  p_c,g ≥ p_vo = (p_d − R p_t,g)/(1 − R), close when p_c,g < p_vc = p_d (hysteresis); orifice valves always open; dummy valves shut.
  Gas through an open valve above z_L: `WTS_wp_gl.tc({port64, p1: p_c, p2: p_t, T, sg: γ_I})` (Thornhill-Craver, provisional; the pressure
  basis as that function documents) → an I source in the valve's tubing cell; liquid through an open valve below z_L: orifice
  q = C_d A √(2 g_c 144 Δp / ρ_L) (ft³/s, C_d 0.6) → a W source; no reverse flow (check valves).
- **Sources are evaluated once per step before the pressure solve** from the lagged p_c, p_t (R23, §3.3); they enter Q_src of the volume
  balance and S_c of the transport. Annulus balance (in `after`): dm_a/dt = ṁ_inj − Σ ṁ_valves,gas; dV_al/dt = −Σ q_valves,liquid.
- Surface injection: constant rate q_inj, or pressure-limited (q = 0 while p_cs ≥ p_inj,max). States: `gl_unloading` (the deepest
  passing valve is not the operating valve), `gl_lifting`, `gl_multipoint` (> 1 valve passing for > 10 min).

**ESP** (`esp`; the pump node is the nodal one — identity; ramp, motor lag and trips provisional; R10):

- The pump is the face `grid.pumpFace`. `faceDp` uses the **nodal pump model** `WTS_wp_esp.pump(P, F, q, pInt, T)` (gas-fraction
  degradation φ / E_n, Turzo viscosity correction, natural-separation venting — the same call the nodal pump node makes) with P the prepared
  pump (`C.esp` from the context) at the current frequency f(t), q = the stock-tank rates of the intake cell's stream at the face flux Q_k
  (Q_k times the intake cell's stock-tank-per-in-situ ratios), pInt = the intake cell pressure and T its temperature: dp = pump().dp (psi);
  ddpdQ by a ±1 % difference in Q. Linearised once per step at the lagged Q (2 pump calls) and used in the root as dp + ddpdQ (Q − Q_lag);
  if the converged Q differs from Q_lag by > 5 % the step is redone once with the new linearisation point.
- Vented gas (`ventMscfd` of the pump result, natural separation opt-in as the nodal `natSep`) is removed from the cell below the pump as
  a negative G (and I) source and **added to the surface gas rate and `cumOut`** (C8): it leaves through the casing to the surface.
- A check valve at the discharge: Q ≥ 0 at the pump face when stopped.
- Drive: f follows f_cmd at the ramp limit (default 1 Hz/s), then a first-order motor lag τ_m = 0.5 s (ASSUMED; the shaft inertia is not
  modelled otherwise). Load = `pump(...)`.bhp / motor hp. States: `esp_off`, `esp_ramp`, `esp_running`, `esp_pumpoff` (p_intake < 50 psia
  or Q_in < 5 % of the BEP rate with f > 30 Hz for 60 s), `esp_gaslock` (intake GVF > 0.3 for 60 s), `esp_tripped` (load < 0.4 for 30 s →
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
  its own ring buffer of (t, liq, q_g, p_0) at 30 s spacing for the trends — the buffers, the pending candidate and the dying / heading
  histories are in the Snap; thresholds ASSUMED and provisional; `ratio` uses the q_c in use, §4.11):

| State | Rule (q_ref = `S.qRef`, the highest surface rate since the last open `S.tOpen` — both in the Snap, R16) |
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

| Key | Method | verified | Default? | What would verify it |
|---|---|---|---|---|
| `cons` | conservative donor transport, black-oil flash, volume-balance coupling | identity | yes | mass balance to round-off (EN2, C2), EN23 — a numerical property, not a published example |
| `corr` | correlation-consistent closure on the model's correlation through `WTS_flowline_gradAt` (incl. tuning multipliers) | as the correlation (B&B default: verified) | yes | the gate (steady run = nodal), G1–G7 |
| `driftflux` | Zuber-Findlay / Shi et al. drift flux (counter-current, near-stagnant, shut-in) | false | only where `corr` has no meaning (w < 1) | a published drift-flux holdup example (Shi et al. data tables) — Q9 |
| `godunov` | bounded counter-current face flux | identity | yes | a numerical property (positivity, EN25) |
| `compliance` | tubing compliance and water compressibility floor | false | yes (no effect on any steady state) | a published shut-in storage example |
| `res_ipr` | instantaneous IPR inflow | identity | yes | = `WTS_wp_ipr` |
| `res_back` | reverse flow into the formation by the IPR slope at p̄r | false | yes (no alternative; inactive while p_0 < p̄r) | a published kill / cross-flow example |
| `res_ls` | line-source E1 | true (analytical) | build-up preset | identity with PRiSM #1 (RS1) |
| `res_sup` | superposition of a non-linear IPR drawdown, bounded cap, negative-skin r_w,eff, gas η | false | **never a default** | a published multi-rate example |
| `choke_crit` | nodal critical choke (model's y_c rule) | as the nodal choke | yes | = the nodal solve |
| `choke_sub` | sub-critical closing shape / Sachdeva scaled | false | **never a default for the nodal regime test**; active only when the choke goes sub-critical in time (no alternative exists) | a published sub-critical choke example |
| `liftgas_mix` | lift gas as a separate free component at the mixed gravity (`pvt.injGas`) | identity | yes | = the nodal `C.gl.Finj` (G5) |
| `esp_node` | the nodal pump model `WTS_wp_esp.pump` as a face Δp | identity | yes | = the nodal pump node (G6) |
| `temp_relax` | temperature relaxation τ_T | false | no (`frozen` is the default) | field data |
| `settle` | oil–water hindered settling | false | yes where no alternative (shut-in liquid) | a published settling example |
| `fallback` | liquid fallback below v_c | false | no (Q1) | a published loading transient |
| `turner`, `coleman` | critical velocity | false | as the nodal module | Q9 (the papers' examples) |
| `belfroid` | Belfroid inclination correction of v_c | false | **no** (Q16; both q_c always shown) | Q9 (the paper's examples) |
| `foamer` | surface-tension factor r(c) | false | only when the user adds foamer | published lab data — Q10 |
| `regime_lowv` | low-velocity regime labels | false | display | Q9 |
| `gl_valves` | annulus, IPO valves, Thornhill-Craver | false | mode `valves` when valves exist | a published unloading example |
| `esp_start` | ramp, motor lag, trips | false | ESP runs | field data |
| `states` | well-state thresholds | false | display | owner review (Q15) |

The page's run summary lists the keys with `verified: false` that were active, with the provisional label. `welldyn-validate --gate`
checks that no key marked "never a default" is active in a run made with default settings on any gate fixture.

---

## 5. Validation, gate and budgets

### 5.1 Consistency gate (WD-D5) — `welldyn-gate` and `welldyn-validate.js --check`

For each of `gasVert`, `gasHz`, `oilVert`, `oilVertTuned`, `oilDev` (G1–G4 + G7, WD1), `gasLift` (mode `nodal`), `esp` (G5–G6, WD4):
`R = WTS_wp_system.solve(M)`; `sim = create(M, {start:'steady', reservoir:{mode:'ipr'}, closure:'corr', temperature:'frozen', cells: 60})`
(all other options at their defaults — Belfroid off, fallback off); run until **steady** (R20): the means of q, p_wf and THP over two
consecutive 600 s windows of simulated time differ by |Δq̄|/q̄ < 1e-3, |Δp̄_wf| < 0.05 psi and |ΔTHP̄| < 0.05 psi, capped at 6 h. A
bounded oscillation is allowed: its amplitude (max − min in the last window) is reported and must stay ≤ 0.5 % of q̄ and ≤ 2 psi in p_wf
(else NOT_STEADY and the row fails). Then, on the **time-means of the last window**:

| Quantity | Tolerance |
|---|---|
| surface rate (q_o or q_g formation) | ≤ 2 % of R.op.q |
| BHP (p_wf at the mid-perforations) | ≤ 1 % of R.pwf |
| THP | ≤ max(1 %, 3 psi) |
| choke regime | `S.surface.regime` = `R.surface.choke.regime` (critical on every fixture) |
| gas lift / ESP | injection cell = the cell above the `R.lift.injMd` break; q_inj equal; pump intake within 1 % |

Also: the same seven from `start: 'static'` (reservoir prior `none`) reach the same point within the same tolerances (oil and gas wells
that flow naturally; gas lift and ESP from their start scenario), and transient mode converges to the IPR mode within 0.5 % after
stabilisation (RS5). Grid convergence: 30 / 60 / 120 cells — BHP(60) vs BHP(120) ≤ 0.5 % (C12). **Diagnostic (C2, report only):**
`welldyn-validate --check` also re-runs the nodal march with `stepFt` = the cell length and prints the gate distance against both, which
separates the discretisation error from the model error. If a fixture misses, cells, closure numerics (ω, j_lo / j_hi) and the step limits
are tuned — never the tolerances.

### 5.2 Engine tests (WD1, `welldyn-engine`, `welldyn-res`)

EN1 grid snapping (no cell across a break; Σ len = path MD; Σ dz = TVD) · EN2 mass balance ≤ 1e-10 per step, ≤ 1e-8 cumulative over the
`shutInBuildup` scenario · EN3 static gas column p_wh vs `WTS_wp_system.shutIn` gas-filled SITHP within 1 % · EN4 partly liquid-filled
static columns vs `shutIn.partLiquid` within 1 % · EN5 static liquid well whose column exceeds p̄r (`killColumn`, back-flow on) forms a gas cap / liquid level ·
EN6 steady start equals the nodal traverse at t = 0 within 1 % at every cell · EN7 open from static: oil well flows and settles (US8)
· EN8 shut-in: afterflow decays, the gas cap forms, the liquid top settles, segregation conserves mass · EN9 oil–water settling moves water
down (with settling on) · EN10 CFL (phase and kinematic-wave speeds) respected; rejected steps halve; STEP_FAIL / PICARD paths · EN11 every gate face has blend
weight w = 1 (co-current, |j| ≥ j_hi) — incl. the rathole and ESP intake cells (C1) · EN12 q_c (Turner and Coleman), method choice and
limiting depth vs `WTS_wp_loading` within 2 % with Belfroid off; EN12b Belfroid on leaves a vertical fixture unchanged · EN13 Belfroid
factor on a 60° cell (closed form, β in radians) · EN14 choke stroke and bean step: the rate moves
monotonically to the new nodal point (oilVert beans 24 → 32) · EN15 snapshot / restore bit-identical continuation; EN15b Snap field coverage (every field the step reads is in the Snap, R16) · EN16 determinism:
the same scenario with different `run` chunkings (1 s, 7 s, 600 s) gives bit-identical results · EN17 events land exactly on their times ·
EN18 gas-well loading: `gasLoadDown` with fallback goes stable → marginal → loading (→ dead) and the switch happens within one
recording interval of q_g crossing q_c,max (Turner switch-over, C4) · EN19 states persistence (no chatter) · EN20 extension hook order and
contract with a dummy extension · EN21 `driftflux` closure: bubble rise in a closed liquid column at the drift velocity (closed form) ·
EN22 no timers, no DOM, no storage in the engine files (static check) · EN23 volume-balance sign (R1): a closed column (choke shut, no
inflow) under an imposed pressure rise gives Q_out < Q_in in every cell, and an over-full cell expels more · EN24 one fluid context (R18):
the engine's props at 10 (p, T) points equal those of `WTS_wp_system.context(M).C.F` and of the solve's traverse rows bit for bit ·
EN25 `levelSettle`: a sharp gas cap over a liquid level settles with zero rejected steps, no negative mass and the liquid top within one
cell of the volume-balance value (R11) · EN26 back-flow (R14): `killColumn` with back-flow on loses liquid to the formation until
p_0 ≈ p̄r; with it off the flag RES_NO_BACKFLOW appears · EN27 Picard sweeps (R3): converged sweeps change p_0 by ≤ 0.01 psi; sweep and
iterate counts per step reported · EN28 Rv refusal (`RV_NOT_IN_TRANSIENT`) and the per-cell GOR cap (R13b: a shut-in oil column under a gas
cap gets its own-ratio B_o, not the production-GOR B_o) · EN29 dissolved-gas flux at the donor's actual G_d/N_o in an undersaturated cell
(R13a) · EN30 `corr` holdup in a horizontal cell and at α_g ≈ 0.97 equals the correlation's (no clamp to no-slip, R4).
RS1 E1 line source vs PRiSM #1 within 0.5 % (t_D > 100) · RS2 f(∞) = 1 reproduces the darcy IPR · RS3 superposition of two rate steps (oil,
linear) = analytical · RS4 build-up (`shutInBuildup`, reservoir `transient` explicitly, C10): the Bourdet derivative of p_ws(Δt) in the infinite-acting window
(10 t_wbs < Δt < 0.1 t_pss, both pinned in the fixture) on the `buildup` fixture equals 70.6 q B μ / (k h) within 3 % (C3) · RS5 transient → IPR after stabilisation · RS6 gas p² / m(p) potentials ·
RS7 non-Darcy part instantaneous · RS8 term compaction error ≤ 0.05 psi · RS9 missing parameters keep `ipr` with a message · RS10 the
`horner` / `derivative` helpers · RS11 negative skin (S = −4): f > 0 and monotone for all τ > 0 with r_w,eff (R15) · RS12 prior history:
`none` keeps p_wf = p̄r on a shut, static start; `steady` / `shutin` reproduce the analytical superposition.

### 5.3 Lift tests (WD4, `welldyn-lift`)

LF1 annulus volume · LF2 casing gas column vs `WTS_gaslift_casingP` ≤ 0.5 % · LF3 valve open / close hysteresis on p_vo / p_vc · LF4
Thornhill-Craver through `WTS_wp_gl.tc` unchanged · LF5 `glUnload`: valves uncover top-down, the operating valve ends at the design's
operating valve (or the deepest reachable, reported), multi-pointing flagged, casing pressure falls at each transfer · LF6 gas-lift gate
(nodal mode, G5; injection cell above the `R.lift.injMd` break) · LF7 casing heading vs `WTS_wp_gl.asheim` verdict on two fixtures (stable / unstable) — a cross-check, provisional ·
LF8 ESP ramp: intake draws down, settles on the pumped root (G6) · LF9 pump-off · LF10 gas lock · LF11 underload trip · LF12 check valve:
no back-flow when stopped · LF13 foamer transport delay from the injection MD · LF14 foamer: q_c falls by sigF^¼ (C11) and `foamerOn`
unloads gasLoad (state loading → unloading → stable or marginal) · LF15 oil heading / stability (§4.13) · LF16 cycle timer events ·
LF17 cycle pressure trigger with minimum times · LF18 intermittent gas well: liquid removed per cycle reported · LF19 extension
snapshot / restore · LF20 lift states and labels · LF21 ESP `faceDp` equals `WTS_wp_esp.pump(...).dp` of the nodal pump node at the
same intake state (R10) · LF22 ESP vent gas (natural separation on) leaves the cell below the pump and appears in `qg`, `qvent` and
`cumOut` (C8) · LF23 lift gas: m_I never dissolves (undersaturated oil below p_b keeps its R_s), mixed-gravity properties equal the nodal
`Finj` at the same (p, T), the surface `qg` = qgForm + qinj at steady state, valve balance in gauge (R8, R23).

### 5.4 Recorder, page and view tests

RC1–RC16 (WD3): sampling cadence, event samples, `at` interpolation, snapshots and the cap rule, truncate / continue (bit-identical with
an uninterrupted run on the real engine — integration), marks, CSV columns / units (field and Metric) / decimal comma / escaping, RunFile
round trip (series identical; hash), `fromFile` errors (format, version, too big, malformed), snapshots dropped above 5 MB, replay re-run
reproduces the series bit for bit (same `engineId`) and, with a different `engineId` from the mock, shows the info note within tolerance,
never "corrupt" (R25), the `state` column indexes `STATE_ORDER`, cases save / list / remove / caps (20, 24 kB), `dyn` key carried in a project file and per well.
PG1–PG28 (WD3) and VW1–VW14 (WD2): §6.

### 5.5 `welldyn-validate.js` (WD5)

- `--gate`: the §4.14 method table (verified flags as shipped, label present in the page / report for each provisional method).
- `--check`: X1–X18: the gate G1–G7 (time-means, amplitude reported) with the C2 diagnostic (nodal march at stepFt = cell length), static columns (EN3 / EN4), mass balance on all scenarios, build-up derivative (RS4), Turner switch
  (EN18), E1 vs PRiSM (RS1), foamer factor (C11), grid convergence (C12), determinism and restore (EN15 / EN16), casing column (LF2),
  unloading sequence (LF5), ESP gate (LF8), transient → IPR (RS5), sharp level (EN25), back-flow (EN26).
- `--time`: per §5.6, measured on the container (Node), with step counts; `--html` loads the built page; with Playwright and Chromium at
  `/opt/pw-browsers` it also reports the achieved speed of the page at ×1000 with drawing (report only; never `playwright install`).
- Exit 1 on a failed gate / check row; the timing rows fail only above 2 × the WD1 baseline (as the Well Performance gate); the timing table
  prints Δt, steps and the cost per step for every scenario of §5.6 so the derived budgets can be re-checked.

### 5.6 Budgets (container Node; phone factor ×3 for planning)

Budgets are derived from the expected time step and step count of each fixture (R19), not set independently. Expected Δt: flowing gas
cells of ≈ 167 ft at gas velocities of 20–60 ft/s → Δt ≈ 1.4–4 s (CFL 0.5); flowing oil (v_g 5–20 ft/s near the top) → 4–15 s; shut-in
after the afterflow → dtMax 60 s. Step cost (60 cells, flowing, `corr`): 2–3 props calls + 1 correlation call per cell + 4–6 root iterates
× 1–2 Picard sweeps of O(n) arithmetic (§4.6). **WD0 lead spike (§9.0):** a prototype loop of exactly that work (props / gradAt calls on
the `gasVert` and `oilVert` grids + the arithmetic passes, no transport logic) is timed and recorded in §11.0 and in `BASELINE`; if the
measured step cost exceeds the 2.5 ms target, WD0 resets the per-step and wall budgets below by the measured factor before Wave 1 (the
derivation stays), and the cell-count default is reviewed (Q7).

| Operation / scenario | Expected Δt · steps | Budget |
|---|---|---|
| `create`, cold (context + one nodal solve ≈ 400–450 ms measured in A1 + grid + 12 line marches) | — | ≤ 800 ms |
| `create` with `opts.ref` of the same model hash (C7) | — | ≤ 30 ms |
| one step, 60 cells, flowing, `corr` | — | ≤ 2.5 ms mean (target; the spike confirms) |
| one step, shut-in / static (no correlation call, w = 0) | — | ≤ 1.0 ms mean |
| simulated / wall, flowing gas, headless | Δt 1.4–4 s | ≥ 500× (×1000 shows "running slower than ×1000" on fast gas wells — expected) |
| simulated / wall, flowing oil, headless | Δt 4–15 s | ≥ 1,500× |
| simulated / wall, shut-in at dtMax | Δt 60 s | ≥ 20,000× |
| gate G1–G7 (from steady; typically settled within 1 h simulated, cap 6 h) | gas ≈ 2,400 steps / h, oil ≈ 600 / h | ≤ 8 s each (gas), ≤ 3 s (oil) per simulated hour |
| `gasLoadDown` 8 h (gasLoad, lower rates) | Δt 2–6 s, ≈ 7,000 steps | ≤ 18 s |
| `shutInBuildup` 2 h + 8 h shut-in (oil, transient) | ≈ 1,000 + ≈ 600 steps | ≤ 5 s |
| `cycleTimer` 12 h | ≈ 7,000 open + ≈ 500 shut | ≤ 20 s |
| `foamerOn` 10 h | ≈ 9,000 steps | ≤ 23 s |
| `glUnload` 12 h | Δt 3–6 s, ≈ 10,000 steps | ≤ 25 s |
| `espStart` 2 h | ramp at Δt ≤ 5 s, ≈ 1,500 steps | ≤ 4 s |
| `levelSettle` 8 h / `killColumn` 2 h (shut-in, counter-current) | ≈ 800 / ≈ 400 steps | ≤ 2 s each |
| snapshot / restore, 60 cells | — | ≤ 2 ms |
| page frame: wellbore + particles at 60 cells | — | ≤ 4 ms (op count reported in Node; ms in the browser report) |
| charts | — | redrawn at most every 6th frame while playing (~10 Hz), always on pause / scrub |
| recorder memory, 24 h at defaults | — | ≈ 2.2 MB series + ≈ 1,440 snapshots × ≈ 12 kB ≈ 17 MB ≤ 32 MB cap |
| replay file | — | ≤ 5 MB (snapshots dropped above) |
| Round-9 parse of the new files | — | ≤ +15 ms on the app load |
| Well Dynamics acceptance files | — | ≤ 150 s in total; long scenarios run shortened (first 1–2 h) in the acceptance tests and in full only in `welldyn-validate --check` / `integration: true` |

If a budget is missed: the property calls per cell per step (re-use of the step's props for the closure stream where the views coincide),
dtMax, the Picard tolerance and the cell-count default are tuned — never the accuracy tolerances of §5.1.

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
   target += speed × clamp(ts − lastTs, 0, 100 ms)/1000          // C4: a simulated-time target, not "seconds from now"
   if (target > sim.state.t) sim.run(target − sim.state.t, {maxWallMs: 10})   // run never splits a step: the overshoot is carried, not lost
   if (target < sim.state.t − speed × 0.1) target = sim.state.t     // after a wall-limited frame the target is not allowed to run away
   achieved speed = simulated / wall over the last second (shown; "running slower than ×N" when lower)
   draw wellbore (every frame), KPIs, charts (every 6th frame); recorder samples via rec.attach
   if (sim ended or a fatal step error) { pause(); return }
   raf = requestAnimationFrame(frame)
```

No rAF (an old WebView) → `setTimeout(frame, 16)` only while playing. `visibilitychange` → hidden pauses the loop (state kept),
visible does not auto-resume. The page opens **paused**; the smoke test opens it and checks no pending timers after 5 s.

### 6.7 Reports

`collectPageReport(#pgBody)` captures `#wd_res` (inputs, run summary, KPI chips, wellbore and trend canvases, state timeline, verdicts,
provisional list, Notes); toolbar, timeline, editors, chart tabs and the navigator are `.rp-skip`. The two report canvases have fixed CSS
sizes — wellbore 360×480, trend 640×220 (C5) — and WD3 measures the Quick Report snapshot on every fixture (≤ 60 kB, PG; if exceeded, the
trend is drawn at 1× device pixel ratio first, then the wellbore at 300×400). `REPORT_DISCLAIMER` prints as on every page.

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
`hooks: {silent: true, after}`, render}. `window.calcWellDyn()` re-reads the model (`WTS_wp_model.read()`), and rebuilds the steady reference
only when the model hash (M without `dyn`) changed — the page keeps one cached `sim.ref` per hash (C7), so a scenario-input change costs
no nodal solve — then the static preview; it never starts a run. `WTS_state.welldyn = {v:1, ok, playing, t, state, summary, model:{ok, notes}}`.
Events listened to: `wts:well-changed`, `wts:project-loaded` (stop, discard the run after a confirm if it has data, re-read),
`wts:wellperf-model-changed` (the model changed: banner "the well model changed — Rebuild" — a running sim keeps its frozen M; an
event whose `detail.keys` is exactly `['dyn']` — the page's own case save — is ignored, R17),
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

The engine's `mHash` hashes M **without** `M.dyn` plus the resolved options (incl. the resolved reservoir parameters), so saving a case
never invalidates the recorder's snapshots (R17). Identity rules for the `dyn` edit (WD0): `wellperf-shapes` WS1 fixture hash unchanged; `WTS_wp_model.read()` of a record without `dyn`
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

### 9.0 WD0 — contracts and skeleton (lead, before Wave 1; branch `wd/wd0` from `wd/int`)

1. Host `__NAV_ORDER` edit; `sidebar-nav.test.js` both assertions (the full button list with the hub members and the 6-row list, §2.1,
   R24); `ux-layout-check.js` fit at 1280×800.
2. The `dyn` key in `49-calc-wp-model.js` with its identity checks (§7).
3. The additive export `WTS_flowline_gradAt` in `49-calc-flowline.js` + `flowline-gradat.test.js` (R5).
4. The six stub files + the help stub entry (non-PART, minimal; the help group route list gains `welldyn`) with `__WD_STUBS`; the stub
   engine exports the frozen orders `COMP`, `REGIMES`, `STATES`, `STATE_ORDER`, `CHANNELS` (they are contract, not physics).
5. `tests/_welldyn-shapes.js` (fixtures tuned and pinned with the real Well Performance engines, the static and dynamic screens of §3.9,
   the frozen orders, `t_wbs` / `t_pss` of `buildup`), `tests/_welldyn-mock.js` (revision-2 shapes, §3.10), `welldyn-shapes.test.js`,
   `welldyn-names.test.js`.
6. **Lead spike (R19, R20):** a throw-away prototype (in the scratchpad, not committed) of the step work on `gasVert` and `oilVert`
   (props + `gradAt` per cell, the down / up passes, 1 h of simulated time with a crude transport) — records the step cost, Δt and whether
   both settle (§11.0); resets the §5.6 budgets by the measured factor if the 2.5 ms target is missed, before Wave 1 starts.
7. Smoke +4 checks (namespaces present, `welldyn` registry entry, `__WD_STUBS` empty at release — skipped while stubs exist, no pending
   timers 5 s after opening `welldyn`); the §11 WD0 record.

Merged into `wd/int` before any lane starts. Gates: smoke, `--file` runs of the new tests and the full `wellperf-*` + `sidebar-nav` +
`help-content` set, `wellperf-validate.js --check` unchanged.

### 9.1 Wave 1 (parallel, each branch from `wd/int` after WD0)

| Lane | Branch | Files | Depends on | Done when |
|---|---|---|---|---|
| **WD1 engine + reservoir** | `wd/wd1` | `49-calc-wd-engine.js`, `49-calc-wd-res.js`, `welldyn-engine`, `welldyn-res`, `welldyn-gate` (G1–G4, G7) | WD0 | EN1–EN30, RS1–RS12, G1–G4 and G7 pass; §5.6 engine budgets measured (BASELINE filled through the lead); the Snap field list in §11.1 |
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
| **WD4 lift transients + oil heading** | `wd/wd4` | `49-calc-wd-lift.js`, `welldyn-lift`, `welldyn-gate` G5–G6 (append) | LF1–LF23, G5–G6 pass |
| **WD5 validation script + gate + perf** | `wd/wd5` | `prism-build/welldyn-validate.js`, `welldyn-validate` | `--gate --check --time` pass on `wd/int` (lift rows marked pending until WD4 merges; the integrator re-runs) |

Lanes do not edit each other's files. A defect a lane finds in another lane's file is written in its §11 record as a finding (file, case,
expected / actual); the integrator fixes it with a regression test.

### 9.3 Wave 3

- **WD6 help** (`wd/wd6`): §8, after the owner's cap decision.
- **WDI integration and release (lead, `wd/int` → `wd/rel`)**: merge order **WD0 → WD1 → WD2 → WD3 → WD4 → WD5 → WD6**, each merge gated by
  smoke + the welldyn / wellperf / sidebar / `flowline-gradat` files; then the full rebuild (Round 9 + host; CRLF check; sync), smoke 351/351, the full
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
| Q16 | The Belfroid inclination correction of the critical velocity was asked for, but it is provisional (D17) and the nodal loading check has no inclination correction. Make it the default for deviated gas wells? | **Off by default** (identical to the nodal check); one switch turns it on; both critical rates (vertical and Belfroid) are always shown side by side in the KPI strip, the depth log and the report |
| Q17 | Reverse flow into the formation when the well pressure exceeds the reservoir pressure (a kill column, a shut-in hump) — provisional, needed for a kill-fluid column to fall | On by default (inactive while p_wf < p̄r); a switch turns it off |

---

## 11. Records (filled by the lanes; format as the Well Performance plan §18: date, branch, decisions taken at their defaults, what was
built (engines, contracts — additive only), tests / gates with counts, measured budgets, known gaps)

### 11.0 WD0 record

### 11.1 WD1 record

**2026-11-13, branch `wd/wd1` (from `wd/int` b4a375b).** Engine and reservoir only; no UI (no page code, no Playwright shots). No shared
file was edited: WD0's export `WTS_flowline_gradAt` and fixtures were not on the base, so the lane test helper
`tests/_welldyn-wd1.js` stands in for them (it adds `WTS_flowline_gradAt = (fluid, p, T, seg, opt) → _gAt(…)` in memory through
`sourceOverrides`, a no-op once WD0's export is merged, and carries FIX / SCEN / TOL / GATE for the three WD1 files). The integrator
replaces it with WD0's `_welldyn-shapes.js` / `_welldyn-mock.js` and deletes it.

**Built.** `49-calc-wd-res.js` — `WTS_wd_res {create, f, derivative, horner, lsConst, E1, VERSION}`: `ipr` mode (the model's IPR, back-flow
at the slope J_r at p̄r) and `transient` mode (E1 line source, superposed u_D, instantaneous u_ND, potentials p / p² / m(p), r_w,eff for
S < 0, prior history steady / none / shutin, term compaction to 400). Missing transient inputs → `ipr` with `RES_PARAMS_MISSING`.
`49-calc-wd-engine.js` — `WTS_wd_engine {create, ext, COMP, REGIMES, STATES, STATE_ORDER (18), CHANNELS (36, frozen), METHODS, VERSION
'1.0.0', engineId, hash, canon, GILBERT_YC, DF, buildGrid}`: five-component (G/O/W/I/F) mass transport on the §4 grid, black-oil flash per
cell through `WTS_flowline_props` on a per-cell view, drift-flux closure (Zuber-Findlay with the Shi et al. profile / drift and the
Kutateladze / Wallis-Makkenchery limits) blended with the correlation closure through `WTS_flowline_gradAt`, choke (Gilbert y_c),
surface line table, loading (Turner / Coleman, Belfroid factor), well states with 120 s persistence, regimes, inventory, steady
detector, events, `run` / `step` / `schedule` / set*, snapshot / restore, steady and static starts.

**Decisions taken here (deviations from the plan text, recorded for review):**
- *Newton with a Riccati sweep replaces the Picard pressure iteration (§4.6).* Picard diverged at small Δt (column compressibility × friction
  feedback). The step solves (p_0…p_n, Q_1…Q_n) by a bottom-up sweep δQ_k = α_k δp_k + β_k and back substitution from the wellhead
  boundary (choke residual in measure units, Q_n when closed); damped, accepted "loose" at max |δp| ≤ 0.01 psi after 4 iterations. Interior
  face fluxes are then polished by a monotone 1-D volume-balance solve per face.
- *Correlation closure on the reference stream.* The correlation is evaluated on the formation (reference) stream scaled to the face's
  mixture flux j, so v_d = v_d(j, p, T) (feeding it the face stream cascaded liquid in gas wells; inverting the cell state is not unique
  for Beggs & Brill). Under-relaxation ω = 0.5; drift cap 20 + 2|j| ft/s with a lagged density correction Δρ = ρ_corr − ρ_m when the
  holdup clamps at 1 or the drift is capped (tuned m_h 1.10); eligibility from the lagged co-current test (j_g ≥ 0 accepted, single-phase
  faces included); w(j) a smoothstep at the current j; the correlation part clamped to [0, j] with upwind holdups; correlation off while
  the well is shut in.
- *Friction blend:* correlation gradient scaled by (j/j_L)² blended with Moody (Swamee-Jain) over j = 0.05…0.10 ft/s (no slosh at shut-in).
- *Time step:* CFL on phase and kinematic speeds with λ weighted by the minority-phase content of the face pair (a static column is not
  held to the droplet speed); a DP_LIMIT rejection is accepted once halving Δt no longer reduces the change by 25 % (gravity jumps are
  not Δt-dependent). Round-off negative masses are clamped and booked in `S.balance.clamp`.
- *Compaction (RS8):* merge the closest same-sign pair in log-age (the opposite-sign merge gave 9.86 psi error).
- *Steady start* equilibrates 4 passes on the engine's own discretised column (the traverse state alone blew the volume balance up).
- *Static liquid start* leaves a gas pocket in the top cell; a static start with temperature `relax` begins on the geotherm.
- *Fixture deviations:* `gasLoad` p̄r 1,400 psia (plan 1,200) and `oilDev` p̄r 3,500 psia (plan 3,000), chosen so the
  fixtures keep a stable flowing nodal point with margin for the scenarios run on them (the integrator re-checks against WD0's FIX).
- Line table and the label ring: a `ref` of the same model hash (and separator pressure) and `restore` copy the line rows (no march);
  the label ring keeps 120 entries.

**Contracts — additive only.** State: `S.faces.p`, `S.faces.FG/FO/FW/FI/FF` (face mass fluxes), `S.ctl`, `S.balance.clamp`,
`S.loading.methods {turner, coleman}`, `S.loading.coef`. Sim: `stats {steps, rejects, iters, rej{code}, loose, props, grads, createMs}`,
`unit`, `k`, `gopt`, `res`, `exts`, `log`, `pend`, `ref.line`. Events `foamer` / `gl` / `esp` / `cycle` set `S.foamer`,
`S.lift.glCmd / espCmd` and `S.cycle` for WD4 (no lift physics in WD1). Debug hooks `_dbg`, `_dbgNeg`, `_dbgDp` act only when set.

**Snap field list (EN15b, R16).** `kind, v, engine, engineId, mHash, n, t, steps, dtPrev`; `cells {mG, mO, mW, mI, mF, T, p, sigF, vc}`;
`faces {Q, jg, jo, jw, xI, vd, c0, w, p, FG, FO, FW, FI, FF}`; `ctl {open, bean64, beanEff, strokeLeft_s, beanFrom, beanTo, strokeTime_s,
chokeMode, ended, psep_psig, tOpen, qRef}`; `line {refGor, refWc, q, pdn, unit, psep, flowline}`; `res {mode, qPrev, + terms / history of
the transient mode}`; `labels {state, since, prev, reason, pending, ringT, ringLiq, ringQ, ringP, ringThp, lastRing, deadSince, lastBot,
dying, heading}`; `steady {ringT, ringQ, ringPwf, ringThp, next}`; `surface {thp, thp_psig, tht, pDn_psig, qo, qw, qL, qg, qgForm, qinj,
qvent, glr, gor, gorForm, wc, regime, y, yc}`; `foamer {on, ppm, eff, injMd}`; `lift {glCmd, espCmd, gl, esp}`; `cycle`, `pend`, `seq`,
`log`, `ext` (per extension), `bal {m0, cumIn, cumOut, clamp}`, `prov`, `flags`. Size ≈ 45 kB at 60 cells (plan estimate 10–14 kB: the
face arrays, line rows and rings) — the §5.6 recorder memory line needs ≈ 3.5× (≈ 65 MB for 1,440 snapshots) unless WD3 stores deltas
or drops the rings / line rows from recorder snapshots.

**Gate (G1–G4, G7 + the WD1 companions), time-means of the last window vs `WTS_wp_system.solve`:** gasVert rate +0.064 %, BHP −0.017 %,
THP +1.18 psi; gasHz +0.004 % / −0.001 % / +0.13 psi; oilVert +0.244 % / −0.043 % / +0.76 psi; oilVertTuned +0.419 % / −0.063 % /
+1.17 psi; oilDev +0.264 % / −0.037 % / +0.79 psi; all critical choke as the solve, cumulative mass error ≈ 1e-15. G8 static companion
(staticOil from a static column) settles on the same point; G9 grid convergence (integration) 60 vs 120 cells ≤ 0.5 %, 30 vs 120 ≤ 1 %.

**Tests.** `welldyn-engine` EN1–EN30: 30/30 (≈ 69 s); `welldyn-res` RS1–RS12: 12/12 (≈ 20 s); `welldyn-gate` G1–G4, G7, G8, G9: 7/7
(≈ 52 s, G9 `integration`). Smoke 347/347 (no checks added). After the Round-9 rebuild (`--html`): `wellperf-*` 334/334, `sidebar-nav`
9/9, `calc-registry` 6/6, `v3-ux` 17/17, `help-content` 8/8. RS4: build-up derivative ≈ 21.07 psi/cycle within 3 %.

**Measured budgets (Node, this container; §5.6 budget in brackets).**

| Item | gasVert | oilVert | gasHz (63 cells) |
|---|---|---|---|
| `create` cold | 513 ms | 485 ms | 679 ms [≤ 800] |
| `create` with `ref` | 27.6 ms | 33.3 ms | 27.9 ms [≤ 30] |
| flowing step, 60 cells | 3.46 ms | 3.64 ms | 3.41 ms [≤ 2.5 — missed ×1.4] |
| cells × steps / s | 17,400 | 16,500 | 18,500 |
| mean Δt flowing | 5.5 s | 7.0 s | 1.6 s |
| simulated / wall flowing | 1,600× [≥ 500] | 1,900× [≥ 1,500] | 464× [≥ 500 — missed] |
| wall per simulated hour | 2.3 s [≤ 8] | 1.9 s [≤ 3] | 7.8 s [≤ 8] |
| shut-in step / mean Δt | 4.7 ms / 26 s | 4.2 ms / 25 s | 3.8 ms / 18 s [≤ 1.0 ms, Δt 60 s — missed] |
| simulated / wall shut-in | 5,700× | 5,800× | 4,700× [≥ 20,000 — missed] |
| snapshot / restore | 0.33 / 2.7 ms | 0.22 / 3.3 ms | 0.24 / 2.5 ms [≤ 2 ms — restore missed] |

Scenarios: `gasLoadDown` 8 h 3,077 steps 12.7 s [≤ 18 ✓]; `levelSettle` 8 h 516 steps 1.3 s [≤ 2 ✓]; `shutInBuildup` 10 h 1,887 steps
10.3 s [≤ 5 — missed ×2]; `killColumn` 2 h 722 steps (290 rejects) 4.0 s [≤ 2 — missed ×2]; `staticOil` 2 h 1,314 steps 5.4 s.
The shut-in budgets assumed a 1 ms step without the correlation; the WD1 step still flashes every cell and runs the Newton sweep while
shut in, and the counter-current CFL keeps Δt at ≈ 20–30 s, not 60 s. Per §5.6 the lead resets these budgets by the measured factor or a
follow-up reuses the step's props while shut in and relaxes the CFL weighting at a settled column.

**Known gaps.** Top-column pressure jitter in the first minutes after a shut-in (reduced by the friction blend and corr-off, not gone);
the shut-in / kill budgets above; gas lift and ESP physics (G5 / G6) are WD4's — lift-gas props use exact (untabled) props; the Sachdeva
y_c is not implemented (Gilbert y_c); the line table has no isenthalpic second march and is rebuilt only on a separator-pressure change
(no re-tabulation on GOR / WC drift); the static liquid start puts a gas pocket in the top cell; Snap size above the plan estimate.

### 11.2 WD2 record

- **Date / branch:** 2026-11-13, `wd/wd2` from `wd/int` at b4a375b (the plan commit). WD0 had not merged when WD2 ran: no stubs, no
  `tests/_welldyn-shapes.js` / `_welldyn-mock.js`. The view therefore resolves the engine at call time (`WTS_wd_engine.REGIMES` /
  `STATE_ORDER` / `STATES` when loaded, else its own copies of the frozen orders of §3.2) and `welldyn-view.test.js` builds its grids and
  frames in the §3.2 shapes from the shared survey engine (`WTS_wellbore.surveyMC`) instead of the mock. The file removes any
  `WTS_wd_view*` name from `__WD_STUBS` when it loads (WD0 stub contract).
- **Built:** `prism-build/49-calc-wd-view.js` (Round 9 helper, no registry page, no timers / storage / engines): `WTS_wd_view.wellbore`,
  `navigator`, `closeUp`, `depthLog`, `trend`, `nodal`, `whpRate`, `stateStrip`, `STATE_COLORS` as §3.11. Wellbore along the true
  trajectory (vertical section along the bottom-hole azimuth, equal scale in `aspect:'true'`, `fit` stretches), width exaggerated with a
  visible minimum (wider strings drawn wider), five layers, phase pictures per regime (films and gas core for annular / mist, liquid on the
  low side for stratified, a sharp level for segregated, liquid fill with a gas core / bubbles / Taylor bubbles for bubble / slug / churn),
  deterministic particles (golden-ratio sequences per cell, offsets advanced only by `frame.dtWall`, so a scrub frame with dtWall 0 is still),
  reduced motion → velocity arrows, interface lines (liquid top, gas cap), markers (perf, eot, valve, pump, gauge, restr), one regime label
  per run, hover / select outlines, depth ticks, time and legend, an ARIA text summary on the canvas. Charts reuse `WTS_wp_view.chart`
  (decimated min / max series, lineX cursor = scrub, marks as bands, regime hbands on the depth log, holdup on the top axis).
- **Additive to §3.11 (no change to the frozen contracts):** `spec.view: 'trajectory'|'schematic'` and `V.setView` (the schematic mode:
  MD straightened into one column); `V.info(i)`, `V.infoLines(info)` (the hover readout lines), `V.zoom()`, `V.layout()`, `V.cellAt(i, s, u)`
  (tests / page); `onSelect(i, how)` gets a second argument `'click'|'key'`; `spec.units` (default `WTS_wd_view.units()`, which follows the
  units layer — the arrays stay in field units, the views convert); `spec.w / h / fixed`; `depthLog` `spec.track: 'pressure'|'velocity'`;
  `nodal` spec `{curves, op, live, trail, gas}`; `whpRate` spec `{gas, qKey, cursor, op:{q, thp_psig}}`; `stateStrip` returns `{segments}`;
  helpers `units(system?)`, `describe(frame, grid, U)`, `stateColors()`, `fmtTime`, `CH_META` (display metadata of the 36 channels; the
  recorder's `channels()` wins), `PHASE_COLORS`, `REGIMES`, `STATE_ORDER`, `STATE_LABELS`. Interaction: wheel zooms only when the canvas
  has focus or with Ctrl (the page keeps scrolling), drag pans a zoomed window, ↑ / ↓ / Enter / Esc / 0 / + / − on the wellbore,
  ↑ / ↓ / 0 on the navigator, pointer scrub on the state strip.
- **Tests:** `welldyn-view.test.js` VW1–VW14 (14 tests) pass with `--sources` and `--html`. Gates on the branch: Round 9 rebuilt (LF, 0 CR),
  sync, `node --check` of the extracted main script, smoke 347/347 (unchanged — no checks added), `wellperf-identity` 10, `wellperf-page` 14,
  `wellperf-shapes` 4, `wellperf-names` 1, `sidebar-nav` 9, `calc-registry` 6, `v3-ux` 17, `help-content` 8 — all pass (no help text added).
- **Measured:** wellbore frame with 60 cells and 300 particles on the S well: ≈ 3,450 recorded canvas operations (budget asserted ≤ 4,500),
  ≈ 3 ms per frame in Node with the recording context (the §5.6 page-frame budget is 4 ms in the browser); Playwright / Chromium at 1280×800
  and 390 px (field and Metric): no horizontal overflow, no page errors, ≈ 3,700–3,950 operations per frame. File 76 kB, parse ≈ 0.3 ms.
  Screenshots (not committed): scratchpad `shots-wd-WD2/wd2-{desktop,phone}[-metric].png`.
- **Known gaps / findings for other lanes:** (1) WD3: a recorder snapshot (§3.6) carries masses and p, T only — no α / v / regime arrays — so
  a scrubbed wellbore needs display arrays from somewhere (keep `S.cells` display copies with the snapshots, or let WD1 export a pure
  `displayFrom(snap)`); until then a frame without `ag` draws grey cells (the pressure layer still works). (2) At the whole-well view of a
  10,000 ft well on a 360×480 canvas the pipe is 9–20 px wide in `aspect:'true'`; detail comes from the navigator zoom or the schematic mode.
  (3) The close-up is a static picture per call (the page passes `spec.phase` to animate it). (4) Op counts are measured with the harness's
  recording context; the browser ms per frame is for WD5's `--time --html` report.

### 11.3 WD3 record

- **Date / branch:** 2026-11-13, `wd/wd3` from `wd/int` at b4a375b. WD0 and WD1 had not merged when WD3 ran (no stubs, no
  `tests/_welldyn-shapes.js` / `_welldyn-mock.js`, no engine). Decisions at their defaults: Q6 `.wdrun`, Q7 60 cells, Q14 (no write-back
  of a replay file's model; "Adopt this model" is not built), Q16 Belfroid off (both q_c shown), Q17 back-flow on.
- **WD0 items done here because the page needs them (identical to §2.1 / §7; the integrator keeps one copy when WD0 lands):** host
  `__NAV_ORDER` gains `'welldyn'` after `'gaslift'`; `sidebar-nav.test.js` both assertions (the full list with the hub members and the
  six-row list, "six rows"); the additive `dyn` table key in `49-calc-wp-model.js` (TABLE_KEYS, `validate` → `_dynClean` {v, cases ≤ 20,
  res, preset} ≤ 24 kB, `read` → `M.dyn` only when the record has `dyn`; `empty()` unchanged). Not done (WD0's): the stubs, the
  fixtures and mock, `flowline-gradat`, the smoke +4 checks and the **help stub guide** — so `help-content` reports "no guide for
  welldyn" on this branch (the production help file has no headroom for a stub under its 47.67 kB cap: a cap decision, Q4).
- **Built:** `prism-build/49-calc-wd-rec.js` — `WTS_wd_rec` (`create`: cadence sampling + forced samples on every engine `event` /
  `state`, snapshots every `snapEvery_s`, the §3.4 cap rule, `at` with held step channels, `snapAt`, `truncate`, marks, `csv` (columns,
  range, every, field / Metric through the units layer, decimal comma with `;`, h:mm:ss, state names, labels quoted and defused against
  formula prefixes), `toFile` / `fromFile` (§3.7; snapshots dropped above 5 MB; refuses only FORMAT / VERSION / TOO_BIG (64 MB) /
  malformed JSON; a changed file is flagged HASH, another engine ENGINE as information), `compare` (R25: 0.5 % rates, 1 psi),
  `summarize` (§3.8 incl. the build-up read at the end of a shut-in, the cumulatives, the steadyCheck gate), `engineId`) and
  `WTS_wd_cases` (`list`, `save` (≤ 20 cases, ≤ 24 kB: oldest unnamed first, then oldest; a same-name save replaces), `remove`,
  `toScenario`, `make`, `setRes`) writing only through `WTS_wp_model.write({dyn})`; `prism-build/49-calc-welldyn.js` — the page
  (registry entry, own row, tile, toolbar, timeline with marks and the state strip, KPI strip per well type, wellbore + navigator +
  chart tabs on `WTS_wd_view` resolved at call time, Scenario card with the eight presets, reservoir inputs + Import from PRiSM, events
  editor (future only), Cases card, CSV dialog, replay save / open / Continue / Re-run and compare, `#wd_res` report block, keyboard map,
  ARIA, phone rules); `49-calc-wellperf.js` — `#wp_go_welldyn` in the step ⑤ header and `#wp_go_welldyn_k` beside the KPI strip
  (outside `#wp_kpis`, so the KPI counts are unchanged), both `.rp-skip`, `data-act="welldyn"` → `WTS_nav('welldyn')`; the wellperf
  guide's `reviewedSrc` re-pinned (fc010354 → d2d99de3; the page change is the link only) and its notDocumented pattern gains
  `go_welldyn(_k)?` (+17 bytes, inside the caps).
- **Additive to §3 (no frozen contract changed):** `rec.frameAt(t)` / `rec.frames()` — the display arrays (p, T, α, v, regime; 4
  significant digits, ≈ 2.7 kB at 60 cells) kept with each snapshot and carried in the RunFile as `snaps.frames`, so a scrubbed or
  replayed wellbore draws (answers WD2 finding 1); `rec.keys / count / span / snaps / detach / logEvent`; `WTS_wd_rec.compare /
  summarize / engineId / hash / channelMeta / hms / CHANNELS_FALLBACK / STATE_ORDER_FALLBACK / EXT / MAX_FILE / MAX_OPEN`;
  `WTS_wd_cases.make / readDyn / setRes / MAX / CAP_BYTES`. RunFile `settings` = the create-time options **with their scenario events**
  (`events` stays the applied log) and `model.tables` also carries `tests` and `cases`, so a file-built M hashes like the live one and a
  file snapshot can be continued. Test hook `WTS_welldyn_page` as §6.9 plus `build`, `rerun`, `shut`, `speed`, `caseSave / caseLoad /
  caseRemove / cases`, `evAdd`, `importPrism`, `kpis`, `summary`, `settings`, `tab`.
- **Run loop (§6.6) as built:** rAF only while playing (setTimeout(16) only without rAF), stops off the page / hidden / paused / ended;
  target += speed · min(Δwall, 100 ms); `run(target − t, {maxWallMs: 10})`; the plan's runaway line is read as "the target may lead the
  engine by at most speed × 0.1 s" (the deficit is dropped and the KPI says "running slower than ×N"); KPIs, timeline and the active
  chart every 6th frame, everything on pause / scrub / end; the Quick Report snapshot is taken on every pause (`WTS_snapshotNow`).
- **Deviations:** a well switch / project open discards the run without a confirm (the switch has already happened) and says so; a
  run stays in memory when the user leaves and re-opens the page (a model change then shows the Rebuild banner); a replay opens in view
  mode (Play disabled; Continue from here or Re-run and compare build a simulator from the file's model, never touching storage); the
  re-run is synchronous with a 15 s wall cap and reports how far it compared.
- **Tests:** `welldyn-rec` RC1–RC16 (16) and `welldyn-page` PG1–PG24 (24) on the lane's stand-in engine `tests/_wd3-mock.js`
  (deterministic closed form with the §3.1 / §3.2 / §3.6 shapes, installable in a browser for screenshots; named apart from WD0's
  `_welldyn-mock.js` to avoid an add / add conflict). PG25–PG28 (real-engine runs through the page) wait for WD1. Gates on the branch:
  Round 9 rebuilt (LF, 0 CR), sync, `node --check` of the main script, smoke 347/347 (no checks added), `--html`: welldyn-rec 16,
  welldyn-page 24, all 37 `wellperf-*` files pass (identity 10, page 14, shapes 4, names 1, …), sidebar-nav 9, calc-registry 6, v3-ux 16,
  help-content 7 of 8 (the missing welldyn guide above), `build-user-guide --check` ok, `ux-layout-check --web --quick` 58 checks ok
  (1280×800 sidebar fits). `help-shots --check` reports home/view and start/screen stale — the same on the base tree (not from WD3).
- **Measured (container Node, stand-in engine):** page open incl. one cold nodal solve 588 ms; rebuild with the cached reference
  10 ms; page frame without the view 0.13 ms (WD2: ≈ 3 ms with 60 cells and 300 particles); 24 h at the defaults: 8,641 samples, CSV of
  all 36 channels 84 ms / 566 kB, replay file 231 ms / 2.39 MB (the stand-in's 9–27 kB snapshots exceed 5 MB in total, so they were
  dropped; the cap rule thinned them to 542 at 19.5 MB of 32 MB), opening it 65 ms; Quick Report snapshot ≈ 5 kB (text only, ≤ 60 kB
  asserted in PG20). Playwright / Chromium at 1280×800 and 390 px (oil, gas, gas lift; field and Metric) with the WD2 view and the
  stand-in: no horizontal overflow, no NaN / undefined, no page errors. Screenshots (not committed): scratchpad `shots-wd-WD3/`.
- **Known gaps / findings:** (1) WD1: the model hash should not depend on `M.tests` / `M.cases` / `M.meta` (no physics) — WD3 carries
  them in the file meanwhile. (2) The help stub guide and the help cap (WD0 / WD6, Q4). (3) PG25–PG28 after WD1. (4) Events are added
  and deleted, not edited in place; an intermittent cycle by pressure is an event (no form fields yet); the casing / pump charts and lift
  states come from WD2 / WD4. (5) The `Adopt this model` action (Q14) is not built.

### 11.4 WD4 record

**2026-11-13, branch `wd/wd4` (from `wd/int` 88e2770, after merge 1).** Lift transients and the oil-heading detector. WD0 had not run
(no `_welldyn-shapes.js` / mock), so the lift fixtures of §3.9 are built in the lane helper `tests/_welldyn-wd4.js` on top of WD1's
`tests/_welldyn-wd1.js` (FIX, gate options, runners); the integrator folds them into WD0's frozen file. Decisions at their defaults: Q1
(fallback only in the loading presets), Q10 (r_max 0.6, c_50 500 ppm), Q13 (IPO / orifice / dummy valves), Q15 (thresholds provisional).

**Built.** `prism-build/49-calc-wd-lift.js` — the five extensions in `WTS_wd_engine.ext` (`foamer`, `cycle`, `heading`, `gaslift`, `esp`; the
keys are assigned at registration, not as object-literal keys, so the help-guide source hash of the `gaslift` page does not take this file in)
and `WTS_wd_lift {VERSION, DEFAULTS, PRESETS, PROVISIONAL, sigmaFactor, annulus, casingP, gasMass, pcsFromMass, column, valveBalance,
headingOf, pumpDp, pumpStream, describe, balanceLevel, EXT}`:
- *foamer* — tracer m_F dosed at ppm of the formation water entering the well at the injection MD (blank = the end of the tubing: the engine
  stores a blank `injMd` as 0, read as blank), sigF = 1 − 0.6·c/(c + 500) per cell from 10⁶·m_F/m_W, returned through `sigma`; q_c falls by
  sigF^¼ exactly (LF14). `S.foamer.eff / cBottom_ppm / dosed_lbm`.
- *cycle* — timer programmes are scheduled ahead with `sim.schedule` (src `controller`), so every open / shut-in lands exactly on its time
  (LF16); the last re-open leaves the well flowing; mode `pressure` emits the events from `control` (THP, or CHP on a gas-lift well; q_close;
  minimum open / shut times; ≤ cycles opens); mode `off` cancels the scheduled controller events. Each open period is booked (liquid and gas
  produced, tubing liquid at open / shut-in, removed) in `S.lift.cycle.hist`.
- *heading* — THP ring at 30 s over 3 h; turning points with a 5 %-of-mean hysteresis; heading when ≥ 3 peak pairs with a mean period of
  2 min – 3 h (`S.lift.heading`). Not imposed: on oilVert a bean right of q_s (16/64) settles on the nodal root (350.8 vs 351 STB/d) and a bean
  with no stable nodal root (14/64) dies away through `dying` to ≈ 88 STB/d in 4 h; neither heads (LF15).
- *gaslift* — `nodal`: q_inj as an I source in the cell above the R0.lift.injMd break (the gate, G5). `valves` (default with installed
  valves): annulus geometry from the strings (casing ID / tubing OD, 60 nodes to the packer), gas column p_cs·exp(0.01875γ/z̄·∫dTVD/T_R) with
  z̄ by Dranchuk-Abou-Kassem on Sutton pseudo-criticals at the column mean (within 0.5 % of `WTS_gaslift_casingP`, LF2), the gas mass ↔ p_cs
  inverse, IPO balance in gauge with the dome from `WTS_wp_gl.pdAt`, gas by `WTS_wp_gl.tc`, annulus liquid by the orifice law (C_d 0.6),
  check valves, surface injection while p_cs < p_ko (design p_ko, else p_inj + 100 psi). Two decisions beyond §4.12: (1) *throttling* — the
  effective port grows linearly from p_vc to p_vo (full above p_vo; provisional, option `ext.gaslift.throttle`, default on): with on / off
  valves the operating valve of the fixture cycled open and shut every few minutes (its port passes more than the 600 Mscf/d injected) and the
  label chattered `gl_lifting` ↔ `dying`; throttling settles where the valve passes the injected gas (LF4: 603 vs 600 Mscf/d); (2) a *stable
  explicit coupling* — one step never moves more annulus liquid (or lift gas) than lowers the casing-to-tubing Δp at that valve by half.
- *esp* — `faceDp` = `WTS_wp_esp.pump` of `C.esp` at the drive frequency (a shallow copy of P with f), the stock-tank stream of the pump face
  at Q (the lagged face stream scaled, else the intake cell's composition), the face pressure as the intake; ±1 % slope. A stopped pump
  (f < 1 Hz) and the discharge check valve are resistances anchored at Q = 0 (dp = −k·Q, k 1e7 psi per ft³/s — anchoring at the lagged flux let
  a stopped pump pass the lagged flow); `dtLimit` holds Δt ≤ 1 s while the drive ramps or a lock fades; drive ramp then motor lag τ_m 0.5 s;
  vent gas (natural separation opt-in) a negative G source below the pump, in `qvent` / `qg` / cumOut (LF22); motor power = the nameplate,
  else 1.25 × the stages' BHP at the BEP (assumed, shown). Trips / states: underload (load < 0.4 for 30 s → a controller `esp` {on:false,
  trip} event, LF11), gas lock (intake gas fraction > 0.5 → the pump head fades over τ_lock 10 s; restart when the intake contents are below
  0.3 after 30 s; label `esp_gaslock` also at > 0.3 for 60 s, LF10), pump-off (intake < 30 psia → head fades; restart above 150 psia after
  15 min idle; label `esp_pumpoff`, LF9) — all provisional.

**Engine edits (WD1's file; findings fixed here because the lift lanes depend on them — the integrator reviews; each is identical at a steady
state, the WD1 suites pass unchanged: engine 30/30, res 12/12, gate 7/7 + G5/G6, int 6/6):**
1. *Implicit flowline back pressure at the choke* (`_attempt`, the wellhead boundary): p_dn is evaluated at the trial rate of the face-n stream
   (∂p_dn/∂Q in the boundary slope), not at the lagged surface rate. Case: gasLift `glUnload`, first liquid at the wellhead at ≈ 1.9 h: p_dn
   (lagged 12,000 STB/d, extrapolated) ≈ 1,700 psia > THP closed the choke, the next step opened it to 30× the rate, alternating
   gas-nozzle / multiphase at Δt ≈ 0.01 s (12,387 steps and 7,210 rejections in that half hour, 82 s). Regression: LFX.
2. *Lift labels replace `dead` / `dying`* (`_labels`): the gas-lift and ESP states override a dead or dying base label (a well being unloaded
   by gas lift, or held by a stopped / tripped pump, is described by the lift). Plan §4.13 said "override stable / unloading".
3. *Additive hook `dtLimit(sim, ctx, t)`* (step size): the ESP ramp at Δt 57 s jumped 60 → 90 Hz in one step (pump Δp 2,860 → 6,600 psi) and
   the pressure-change limit could not halve it away (STEP_FAIL).
4. *Pump re-linearisation* (`step`): the plan's §4.12 rule — when the converged pump-face flux moved > 5 % from the linearisation point the
   step is redone with the Δp re-linearised there (at most twice, on a flowing face, then the last converged attempt stands).
5. *ESP steady start* (`_initSteady`): the equilibration subtracts the nodal pump rise at the pump face (a low-J pumped well started with a
   bottom pressure above p̄r).
6. *`S.surface.qinj`*: the engine's surface pass resets it every step; the gas-lift `label` hook writes it back (a stop-gap; the engine should
   read `S.lift.gl.qinj`). `S.surface.qvent` written by the ESP `after` hook is kept by the engine (as designed).

**Page edits (WD3's file `49-calc-welldyn.js`, additive):** a *Lift and intermittent production* card (full width under Scenario / Cases):
`#wd_liftstat` lift status (gas lift: mode, casing pressure, lift gas, annulus liquid, operating valve and a valve table — state, passing,
rate, casing / tubing pressure, opening pressure; ESP: frequency and command, intake / discharge / rise, load, intake gas, vent; foamer;
intermittent phase, next event and the last cycle's liquid; heading check), refreshed with the KPIs (every 6th frame) and in display units;
intermittent form (timer / pressure, open / shut h, cycles, p_open / p_close psig, q_close, minimum open / shut; Start now / Stop → a `cycle`
event); ESP drive ramp (Hz/s) used by the toolbar Set. Presets: *gas-lift unloading* starts from the static water level of p̄r
(`WTS_wd_lift.balanceLevel`: 2,486 ft MD on the fixture, written in display units) and opens the well with the lift gas on; *ESP start* opens
the well (a static start is shut in). Lift chart keys: gas lift `pcs, thp, qinj`, ESP `freq` (one y axis per chart). The run summary carries
the lift rows. `welldyn-page` PG11 updated for the two presets (`open` first).

**Fixture deviations (`_welldyn-wd4.js`):** gasLift p̄r 2,600 psia (the (tune) number; at 2,400 the design spacing stops short of the injection
point), valve ΔP 250 psi and design port 12/64 in (at 100 psi / 16/64 the Asheim loop gain F2 ≈ 2.0: screen (c) fails; F2 = 0.39 here), a full
7" casing to the packer (the annulus); 4 valves from `WTS_wp_gl.design` (1,970 / 2,956 / 3,709 / 4,334 ft MD, the last the design operating
valve), nodal q_op 460 STB/d, injection at 4,562 ft MD, critical choke. esp: bean 20/64 in (at 32 the nodal choke is sub-critical, screen
(a)), 224 stages (`sizeStages` at 1,500 STB/d), a full 7" casing. `glUnload` starts at the balance level (the full kill column of §3.9 is
above p̄r: it drains into the formation and, with no reverse flow through the choke, the tubing top drops below the separator pressure — a
STEP_FAIL at 600 s; with back-flow off the gas pocket / liquid choke switch failed Newton at 113 s), run 4.5 h in the test.

**Tests.** `welldyn-lift` LF1–LF23, LFX, LF24–LF26 (27, LF7 `integration`): 27/27 (≈ 100 s); `welldyn-gate` + G5, G6: 9/9 (≈ 58 s). On
`--html` after the Round-9 rebuild (LF, 0 CR) and sync: smoke 347/347 (no checks added), `node --check` ok, welldyn-engine 30, -res 12,
-view 14, -rec 16, -page 24, -int 6; wellperf-identity 10, -page 14, -names 1, -gl2 9, -esp 13, -shapes 4; sidebar-nav 9, calc-registry 6,
v3-ux 17; help-content 7/8 (only "no guide for welldyn", the known WD6 item); `help-shots --check` and `build-user-guide --check` ok.

**Gate G5 / G6 (time-means of the last 600 s vs `WTS_wp_system.solve`):** gasLift (nodal) rate +0.78 %, BHP −0.08 %, THP +1.29 psi, settled at
1.0 h; esp rate −0.03 %, BHP +0.01 %, THP −0.08 psi, pump intake +0.01 %, settled at 0.34 h; both critical as the solve, mass ≤ 1e-15.

**Measured (container Node; §5.6 budget in brackets).** create cold gasLift 640 ms / esp 376 ms [≤ 800]; flowing step gasLift 5.6 ms (Δt 5.3 s,
×950) and esp 5.7 ms (Δt 20 s, ×3,560) [2.5 ms — the gas-lift cells take the exact (untabled) props of the lift-gas view, WD1 gap]; the
extensions cost ≈ 2.5 % of a step (107 ms of 4,334 ms in an hour of unloading); `glUnload` 4.5 h 15.8 s / 2,489 steps, 12 h ≈ 42 s [≤ 25 —
missed ×1.7, the step cost]; `espStart` 2 h ≈ 10 s / 1,488 steps (631 DP_LIMIT rejections while the static column drains) [≤ 4 — missed];
foamer (bean 26, 5 h) 12.6 s; timer cycle 2.25 h ≈ 7 s. Chromium (built page, 1280×800 and 390 px, field and Metric; gas-lift unloading,
ESP start, foamer): no horizontal overflow, no NaN / undefined, no page errors; screenshots (not committed) in the scratchpad `shots-wd-WD4/`.

**Known gaps / findings.** (1) The Asheim cross-check (LF7) is one-sided: the F2 ≈ 2 fixture did not head in time (the throttling valve damps
it) — reported, not asserted. (2) `foamerOn` (bean 16 in §3.9) does not unload: the foamer lowers q_c by sigF^¼ = 0.88 only (no foam density
model), so the test uses bean 26 (ratio 0.82 → 0.93: loading → marginal). (3) Gas lock and pump-off are modelled as a head fade with a
restart rule (cycling), not as gas-liquid pump physics; a pump-off restart at 90 Hz on the weak water well is stiff (not run in the tests).
(4) ESP `natSep` vent differs from the nodal (17.9 vs 25.6 Mscf/d at GOR 500) — opt-in, provisional, not a gate. (5) The correlation closure
uses the reference stream with the lift gas above the nodal injection cell also in `valves` mode (WD1 design) — the drift there is the
lifted stream's while the cells unload. (6) No form fields for an event at a future time of the cycle (the Start button acts now; future
cycles go through the events table). (7) Budgets above; the heading detector also reports the decaying THP oscillation after an unloading.

### 11.5 WD5 record

**2026-11-13, branch `wd/wd5` from `wd/int` 88e2770 (after merge 1).** Validation tool and its acceptance file only; no engine, page or
shared file was edited (nothing in Round 9 changed: the Round-9 concat / inject and the sync gave no diff). WD0 had not run, so the tool
reads the fixtures from `tests/_welldyn-shapes.js` when that file exists and otherwise from the wave-1 stand-in `tests/_welldyn-wd1.js`
(the same FIX / SCEN / TOL / GATE keys). WD4 had not merged: every row that needs the lift extensions or the `gasLift` / `esp`
fixtures is SKIP (never a silent pass) and becomes live once `WTS_wd_engine.ext.gaslift / esp / foamer / cycle` load.

**Built.** `prism-build/welldyn-validate.js` — `--gate` (the §4.14 table: keys and shipped verified flags = `WTS_wd_engine.METHODS` both ways;
`PROVISIONAL` text; the page carries the label and the "Provisional methods in this run" box; each user-selectable provisional method's
control (`wd_backflow`, `wd_temp`, `wd_fallback`, `wd_belfroid`) says "provisional"; on default runs of every gate fixture no "never a
default" key (`res_sup`, `choke_sub`, `temp_relax`, `fallback`, `belfroid`, `foamer`) is active, every listed key is verified:false and
`WTS_wd_rec.summarize` lists the engine's keys; an option switched on is listed), `--check` X1–X18, `--time` (§5.6 rows with steps,
mean Δt, ms per step, simulated / wall; fail line 2 × the §11.1 WD1 baseline, the §5.6 budget reported as "over budget" and failing only
with `--strict`), `--browser` (the built page in Chromium at ×1000, 1280 × 800 and 390 × 844, report only), `--html`, `--quick`,
`--only`, `--json`. Exports `gate / checks / timing / browser / METHOD_TABLE / NEVER_DEFAULT / BUDGET / BASELINE` for the tests.
`tests/welldyn-validate.test.js` VA1–VA7 (method table = METHODS; quick gate; X1 on oilVert with the C2 diagnostic; X3 / X7 / X8 / X18;
X10 / X17; the quick timing step counts; the banned-name scan over the tool and the test) — 7/7, ≈ 33 s.

**Checks (X1–X18).** X1 the gate G1–G7 with the C2 diagnostic · X2 static-start companions (staticOil and a gasVert gas column, opened at
60 s, prior none) · X3 static columns (EN3 / EN4) · X4 mass balance on every scenario · X5 build-up derivative (RS4) · X6 Turner switch-over
(EN18) · X7 E1 vs PRiSM #1 (RS1) · X8 foamer factor C11 (through the `sigma` hook: the WD4 foamer when loaded, else a validation
extension with sigF = 0.4) · X9 grid convergence (C12) · X10 determinism + snapshot / JSON / restore (EN15 / EN16) · X11 casing column
(LF2) · X12 unloading sequence (LF5) · X13 ESP start (LF8) · X14 transient → IPR (RS5) · X15 sharp level (EN25) · X16 back-flow (EN26) · X17
replay round trip (recorder → RunFile → JSON → `fromFile` series identical; a re-run from the file's events identical by
`WTS_wd_rec.compare`; a continuation from a file snapshot bit-identical) · X18 the loading rule = the nodal rule (EN12).

**Results (`--html`, this container).** Gate PASS. Checks 19 / 19 pass, 5 SKIP (G5, G6, X11, X12, X13 — WD4). Measured:

| Check | Value |
|---|---|
| G1 gasVert | Δq +0.064 %, ΔBHP −0.017 %, ΔTHP +1.18 psi, steady at 0.93 h; C2 (march at 166 ft): +0.064 % / −0.017 % |
| G2 gasHz | +0.004 % / −0.001 % / +0.13 psi, 0.58 h; C2 (145 ft) unchanged |
| G3 oilVert | +0.244 % / −0.043 % / +0.76 psi, 0.92 h; C2 (133 ft): +0.292 % / −0.051 % |
| G4 oilVertTuned | +0.419 % / −0.063 % / +1.17 psi, 1.01 h; C2 +0.421 % / −0.063 % |
| G7 oilDev | +0.264 % / −0.037 % / +0.79 psi, 1.01 h; C2 +0.266 % / −0.038 % |
| X2 static starts | staticOil Δq 0.235 % / ΔBHP 0.044 % at 1.94 h; gasVert 0.027 % / 0.008 % at 2.19 h |
| X3 | gas-filled 0.18 %, part liquid 0.29 % |
| X4 | worst step 1.5e-15, cumulative 2.8e-15 (6 scenarios) |
| X5 | slope 21.64 vs 21.07 psi per ln cycle (2.7 % of the 3 % tolerance) |
| X6 | margin at bean 32 +0.015; loading 120.8 s after q_g < q_c (tolerance 130 s) |
| X7 | 0.36 % (tolerance 0.5 %) · X8 exact to 4e-16 (q_c 2.133 → 1.697 MMscf/d = 0.4^¼) |
| X9 | BHP 2,541.19 / 2,541.98 / 2,542.59 psia at 30 / 60 / 120 cells (0.024 %) |
| X10, X17 | identical; Snap 26.7 kB through JSON (≈ 40 kB as the in-memory object counted by the timing row) |
| X14 | 0.011 % · X15 level 4,178 vs 4,180 ft, 0 rejects · X16 p_wf − p̄r 0.00 psi · X18 Turner / Coleman 0.01 %, limiting MD Δ 65 ft |

The C2 diagnostic separates the discretisation: on the gas fixtures the gate distance is the same against the 100 ft and the cell-length
march; on the oil fixtures the distance to the cell-length march is slightly larger (+0.29 vs +0.24 % on oilVert), so the residual rate
offset is model, not grid. No engine discrepancy was found by the checks; no engine file was changed.

**Measured budgets (`--time --html`; §5.6 budget / WD1 in brackets).** create cold 377 / 454 / 618 ms (gasVert / oilVert / gasHz)
[≤ 800 ✓]; with ref 24.8 / 34.9 / 27.8 ms [≤ 30 — oilVert over]; flowing step 3.47 / 3.65 / 3.42 ms [≤ 2.5 — missed ×1.4, = WD1];
simulated / wall flowing 1,589× / 1,867× / 463× [gas ≥ 500 — gasHz missed, oil ≥ 1,500 ✓]; shut-in, first hour after the afterflow
2,478× / 3,084× / 3,822× (Δt 12.5 / 16.4 / 15.7 s, 5.1 / 5.3 / 4.1 ms per step); **settled shut-in 3.2–5.2 h after the shut: Δt reaches
dtMax 60 s on gasVert and oilVert (29 s on gasHz), 2.11 / 3.67 / 2.63 ms per step [≤ 1.0 — missed], 28,435× / 16,333× / 11,161× [≥ 20,000
— gasVert ✓]** (the WD1 "shut-in" numbers were the early, CFL-limited phase); snapshot 0.19–0.22 ms, restore 1.0–1.7 ms [≤ 2 ✓ — the WD1
restore miss is gone]; gate runs to steady 2.3 (gasVert) / 2.1 (oilVert) / 8.7 (gasHz) / 5.4 (oilVertTuned) / 4.4 (oilDev) s per simulated
hour [gas ≤ 8 — gasHz over; oil ≤ 3 — the tuned and deviated oil fixtures over: Δt 2.6 / 3.2 s against 6.8 s on oilVert]; scenarios
beanUp 4 h 6.8 s, shutInBuildup 10.6 s [≤ 5 — missed], gasLoadDown 12.6 s [≤ 18 ✓], levelSettle 1.4 s [≤ 2 ✓], killColumn 3.8 s (290
rejects) [≤ 2 — missed], staticOil 5.2 s; the 2 × WD1 fail line holds on every row. Recorder at the defaults 2.37 MB per simulated hour
(snapshots ≈ 40 kB each) → 55.6 MB projected for 24 h [≤ 32 MB — the cap rule thins snapshots after ≈ 13 h]; replay file 2.35 MB after 1 h,
so a run longer than ≈ 2 h writes its file without snapshots (X17's 2 h file was 5.07 MB). Wellbore frame at 60 cells with particles: 1,064
draw operations (Node). **Browser (Chromium, built page, ×1000, 5 s wall, 1280 × 800 and 390 × 844):** the achieved speed is ×998–×1,000
on oilVert, gasVert and gasHz (gasHz too: the browser runs the engine faster than the Node harness), 298–302 frames, wellbore draw median
0.9–1.2 ms, p95 1.8–2.4 ms [≤ 4 ms ✓], no NaN / undefined, no horizontal overflow, no page errors (screenshots not committed).

**Tests run.** welldyn-validate 7/7; welldyn-engine 30/30, -res 12/12, -gate 7/7, -view 14/14, -rec 16/16, -page 24/24, -int 6/6;
wellperf-identity 10/10, wellperf-page 14/14; sidebar-nav 9/9; calc-registry 6/6; v3-ux 17/17; help-content 7/8 (only "no guide for
welldyn" — WD6, Q4); smoke 347/347 (no checks added); `node --check` of the extracted main script OK.

**Known gaps / follow-ups (WD1 engine, recorded, not changed here).** (1) Step cost: the flowing step (≈ 3.5 ms) and the settled shut-in step
(2.1–3.7 ms at 60 s) still flash every cell (≈ 2.3 property calls per cell per step, 2–3 Newton iterations); reusing the step's props in a
settled shut-in column and in cells whose (p, T) moved less than a tolerance is the §5.6 remedy. (2) Δt on the tuned / deviated oil fixtures
(2.6–3.2 s) is half of oilVert's; gasHz at Δt 1.6 s stays at ≈ 463× in Node. (3) killColumn 290 rejects (MASS_NEG halving) and
shutInBuildup 36 rejects. (4) Snapshot ≈ 40 kB (plan 10–14 kB) → recorder memory and replay-file size above §5.6 (delta snapshots or no
rings / line rows in recorder snapshots, WD3 / WD1). (5) X5 at 2.7 % and X6 at 121 of 130 s are close to their tolerances. (6) G5 / G6 / X11–X13
wait for WD4; the foamer row X8 checks the engine's σ path with a validation extension until the WD4 foamer loads.

### 11.6 WD6 record

**Help guide (2026-11-14, `wd/int`, done by the integrator).** Route `welldyn` in `48-calc-help-production.js` (a PART route, 9.8 kB
serialised; `reviewed: 'v4.6'`, `reviewedSrc` of `49-calc-welldyn.js` — the page registers with `key: KEY`, so help-content names the file
in `SRC_OVERRIDE.welldyn`): purpose, what, when, seven steps, 17 inputs (the rest by two `notDocumented` patterns), four outputs, 14 verdict
entries, the worked example (the Oil example of Well Performance: start-up about 0.2 h, then Stable at 916 STB/d and BHP 2,542 psia against
the nodal 914 / 2,543; compute check of `WTS_wd_engine.create` — `R0.op.q` 914.0, `R0.pwf` 2,543, `state.surface.qL` 914.0, regime
critical, 60 cells), six parts (gas-well loading and unloading, shut-in and build-up, start-up and heading, gas lift and ESP, foamer and
cycles, recorder / files / cases) and the provisional label on every provisional method (D17). Two tasks in `48-calc-help-start.js`:
`wdload` "See when my gas well loads up" and `wdgl` "Unload a gas-lift well step by step" (task limit 10–15 → 10–16); five glossary terms
(afterflow, drift flux, flow heading, liquid fallback, intermittent production — "heading" alone is a column heading elsewhere).
Shots (new help-shots action `welldynRun` {ex, preset, h, tab}: loads the Well Performance example, waits for it (for `gl` the valve
design, then **Use this design**), opens Well Dynamics, applies the preset and runs it through the page hook to h hours; clock `fixed`):
`run-d` (Gas example, Gas-well loading, 3 h, 55.5 kB), `wb-p` (the same run's wellbore on a phone, crop, 12.3 kB), `gl-d` (Gas lift
example, Gas-lift unloading, 4 h, Lift chart, 54.9 kB); `help/view` re-shot (the landing page lists the new tasks). Caps (Q21, owner
approval 2026-11-13 for the help growth of the Well Performance hub, which Well Dynamics extends; measured need + a small margin):

| Cap | Old | New | Measured |
|---|---|---|---|
| `48-calc-help-production.js` | 47.67 kB | 57.95 kB | 57,859 B |
| `48-calc-help-start.js` | 19.8 kB | 21.75 kB | 21,705 B |
| help files raw (SUM_CAP) | 369 kB | 381.3 kB | 380,169 B |
| help files gzip (GZIP_CAP) | 128 kB | 132 kB | 131,736 B |
| images (help-shots totalBytes) | 8.0 MB | 8.12 MB | 8,105,852 B (221 files) |
| manifest module (help-shots moduleBytes) | 8.8 kB | 8.9 kB | 8,860 B |

### 11.7 Integration and release record

**Wave 1 (2026-11-13, `wd/int`).** Merged `wd/wd1` → `wd/wd2` → `wd/wd3` (`--no-ff`). WD0 had not run, so the merge also carries the WD0
items the lanes needed: the host `__NAV_ORDER` entry (`welldyn` after `gaslift`: its own row in Production & Reservoir, 6 of 8 rows), the
`dyn` model key (WD3's copy) and the R5 export `G.WTS_flowline_gradAt` in `49-calc-flowline.js` (shipped now; before, only the WD1 test
helper added it in memory, so the built page had no working engine). Generated files (`combined-round9.js`, the HTML, www) were taken
from the integration side and rebuilt (Round 9, sync; LF).

Seams fixed on the real engine (the WD3 page and recorder had run on the stand-in only):
- `WTS_wd_engine.CHANNELS` are `{key, label, unit, cat, dp}` objects (§3.4); the recorder and the CSV dialog took them as keys ("[object
  Object]" columns). `WTS_wd_rec` now maps them (`channelKeys()`), the page reads its column list from there.
- The resolved options are `sim.opts` (§3.1; the engine kept them as `sim.o`): `this.opts = o` added (the recorder's prior / summary read it).
- The page's transient-reservoir check asked for μ and B and ignored `dyn.res` and the IPR parameters; it now resolves k, h, φ, c_t, r_w,
  r_e as `WTS_wd_res` does (μ from the fluid, B unused), so the `buildup` fixture switches to the transient reservoir without a note.
- The view's fallback state labels now equal the engine's `STATES` labels ("Loading up", "Gas lift: …", "ESP ramping").
- One engine variable renamed `pvtLift` (its old name matched the banned-name list).
- The flowline guide's `reviewedSrc` re-pinned (5bc3c131: the export only); the help shots `home/view` and `start/screen` re-shot for
  the new sidebar row and tile (manifest 7,980,382 bytes).

New `tests/welldyn-int.test.js`: PG25–PG28 on the real engine through the page (gas loading-prone choke-back to LOADING and recovery by
the toolbar bean, shut-in build-up on the transient reservoir, horizontal gas steady on the nodal point, oil start-up from a static oil
column), INT1 (seams) and INT2 (banned names over every Well Dynamics file). Chromium at 1280×800 and 390 px on the built page: the four
fixtures play as in the tests (gasLoad: loading at 3 h, marginal after bean 32; buildup: transient, 2,957 psia at 6 h; gasHz: stable
8,249 Mscf/d; oil start-up: stable 916 STB/d), scrub and the replay file work, no NaN / undefined, no horizontal overflow, no page errors.

**Wave 2 (2026-11-13, `wd/int`).** Merged `wd/wd4` → `wd/wd5` (`--no-ff`, no conflicts; Round 9 and the sync gave no diff). The WD4 engine
edits of §11.4 (flowline back pressure at the trial rate, lift states over dead / dying, the `dtLimit` hook, pump re-linearisation, the
ESP steady start, the `qinj` write-back) were reviewed and kept: each gives the WD1 answer at steady state (welldyn-engine 30/30 and the
gate unchanged). Integration fixes:
- **Validation tool fixtures.** `welldyn-validate.js` `fixtures(G)` adds the WD4 lane fixtures (`tests/_welldyn-wd4.js`: `gasLift`,
  `esp`; scenarios `glUnload` from the balance level for 4.5 h, `espStart`, `cycleTimer`; gate options `GATE4` — nodal injection for
  G5) when the lift extensions are loaded, so G5, G6, X12 and X13 run instead of SKIP. X11 stays a pointer to welldyn-lift LF2.
- **X17** records snapshots every 300 s: with the WD4 snapshot fields (about 40 kB each) a 2 h oilVert run at 60 s passed the 5 MB file
  limit and the file dropped them (continuation "DIFFERS" was "no snapshot"). The check now also fails explicitly on a file without
  snapshots. The page still records every 60 s (a run longer than about 2 h saves without snapshots — §11.5 gap 4).
- **Liquid fallback positivity (engine).** The `cycleTimer` scenario (fallback on, gasLoad) failed MASS_NEG about 950 s after each
  shut-in: the fallback exchange moved gas out of a liquid-full lower cell. The exchange is now j_L ← j_L − α_L,above · α_g,below · v_fb
  (1 − v_g / v_c) (§4.10 updated), which vanishes when either donor is empty, as the bounded Godunov flux; new test EN31. X6 (loading
  121.0 s after q_g < q_c, tolerance 130 s) and every welldyn test are unchanged in result.

- **Gas-lift example robustness (engine + lift).** The Well Performance "Gas lift" example (no choke, fixed THP 150 psig) failed its
  unloading preset: (1) the static column balanced against the separator (100 psig) while the wellhead is held at the fixed THP, so the
  open stepped the wellhead up and the run failed DP_LIMIT at 0.5 s — `_initStatic` and `WTS_wd_lift.balanceLevel` now use the fixed THP
  as the wellhead floor of a well with no choke; (2) with the designed valves, 6 of 9 perturbed runs (level, cells, q_inj) ended STEP_FAIL
  (CFL) within 3 h — the CFL divided a downward gas flux by the near-zero gas fraction of the liquid-full cell below; it now takes each
  phase velocity from its donor cell; (3) a valve's throughput now lags its target by τ = 20 s (`TAU_VALVE`, ASSUMED, provisional with
  `gl_valves`; a closed valve's rate decays and stops below 0.1 % of the injection / 0.1 bbl/d): without it one of the seven runs still
  failed (NEWTON). All seven now run 4 h to valve 5 at 1,046–1,148 STB/d (nodal 1,181). LF4 compares the valve rate with throttle ×
  Thornhill-Craver within 1e-3 (the lag), new LF27 runs the example 2.5 h. The browser shot runs it 4 h: 1,063 STB/d, casing 1,109 psig.

Gates on the built page (`welldyn-validate.js --html --gate --check --time`): D17 table PASS; 23 / 23 checks pass, X11 skipped. G1 gasVert
+0.064 % / −0.017 % BHP, G2 gasHz +0.004 % / −0.001 %, G3 oilVert +0.244 % / −0.043 %, G4 oilVertTuned +0.419 % / −0.063 %, G5 gasLift
(nodal) +0.782 % / −0.077 %, G6 esp −0.028 % / +0.012 %, G7 oilDev +0.264 % / −0.037 %; X4 cumulative 5.7e-15 over nine scenarios; X12
gl_unloading → gl_lifting; X13 esp_ramp → esp_running; X17 identical. Every timing row inside its fail line; the §5.6 budget misses of
§11.4 / §11.5 stand (cycleTimer 12 h: 28 s, 248 rejected steps, no budget row in §5.6). Tests: welldyn-engine 31, -gate 9, -int 6,
-lift 28, -page 24, -rec 16, -res 12, -validate 7, -view 14 — all pass (after every fix above).

**Release 4.6 (2026-11-14, `wd/int`).** Merged `origin/dev-87qwkg` (release 4.5.1, the Q21 Well Performance help) into `wd/int`. Conflicts
only in the help files and the generated files: the task lists of both sides kept (artlift, wdload, wdgl: 17 tasks, check 10–17); the
wellperf guide takes the 4.5.1 text and keywords with this line's `reviewedSrc` (the cross-link button); the help-shots named actions of
both sides (`wpJob`, `wellAdd`, `welldynRun`); the caps are both sides' measured need together plus a small margin (production 69.25 kB,
start 22.45 kB, sum 392.5 kB raw / 136.5 kB gzip, images 8.27 MB, manifest module 9.1 kB — the Q21 rule; above either side alone, so the
owner may want to confirm them). Generated files (combined-round9.js, the HTML, www, manifest, user guide) regenerated with the tooling.
The 4.5.1 wellperf text named "drift flux" before the glossary term (added here) — now linked. Fixes found by the full gates:
- `buildup-page` PG1 expected Build-up Surveillance right after the Well Performance hub; now hub → welldyn → buildup.
- `acct-lswrite-scan` LS1: the page's device-pref write was a raw `localStorage.setItem`; it now goes through `WTS_lsSet` with a marked
  fallback (count table +1 for 49-calc-welldyn.js).
- `ux-layout-check` at 375 px: the closed Export menu (`.wd-menu`, right-anchored) measured off the left edge, and opened it ran off the
  screen on a phone. Closed menus are now `display:none`, and below 600 px the menu anchors left (opened: 82–292 px of 375).
RELEASE_NOTES v4.6 dated 2026-11-14 on top (both platforms); versions 4.6 (label fallback, both MARKETING_VERSION, both VERSION_BASE);
release-notes shots re-taken. Gates on the built page: node --check, smoke 347/347, accept-test --html --integration 2382/2382 (204 files,
file by file), welldyn-validate (D17 PASS, 23 / 23, X11 skipped, G1–G7 as wave 2), wellperf-validate (D17 PASS, 62 / 62, budgets ok),
help-shots / build-user-guide / publish-site --check ok, ux-layout-check --web ok, wts3d-test 147/149 (the two CRLF checks on LF), GUI
sweep of welldyn + wellperf (desktop and --mobile): 0 errors, 0 warnings, 0 cosmetic (one info: a hidden control clicked by script).

---

## 12. Revision 2 — review changes and where they landed

| Review item | Change | Section |
|---|---|---|
| R1 | volume-balance signs fixed (Q_out = Q_in + Q_src + (∂V/∂p)Δp/Δt + (V^content − V)/Δt); EN23 | §4.6, §5.2 |
| R2 | Σ_c (∂V/∂m_c) ṁ_c + (∂V/∂p) ṗ = 0 closure with ∂V/∂m_c from the same flash; mismatch term = linearisation residual only | §4.1, §4.6 |
| R3 | wellhead root with ≤ 3 inner Picard sweeps per trial, tolerances, final-sweep check, cost; friction = magnitude × sign(j), mixture form below j_lo | §4.5, §4.6, EN27 |
| R4 | `corr` v_d clamp to [0, 3 v_d,ZF] removed; only the co-current limits −j ≤ v_d ≤ j α_L/α_g (j_g ≥ 0, j_L ≥ 0) | §4.4, EN30 |
| R5 | closure through the new additive export `WTS_flowline_gradAt` (segment theta from horizontal, W.rough, payne / accel from the context, VLP multipliers, per-section keys); tuned fixture `oilVertTuned` in the gate | header, §2.5, §4.2, §4.4, §3.9, §9.0 |
| R6 | choke y_c = the model's rule (0.588 under 'bound', Sachdeva only under 'sachdeva'); psia → psig for p1; regime compared with `R.surface.choke.regime` | §4.8, §5.1 |
| R7 | restriction loss = the marcher's K ρ_n v²/(2 g_c 144) at the throat velocity, K default 0.5(1 − β²) + (1 − β²)² | §4.2 |
| R8 | fifth conserved component m_I (lift gas, free only, mixed gravity via `pvt.injGas`) in fluxes, balance, Snap, CHANNELS, CSV | §3.2, §3.4, §3.6, §4.1, §4.3, §4.12, LF23 |
| R9 | `R0.lift.injMd` a forced cell break in nodal gas-lift mode | §4.2, §4.12 |
| R10 | ESP faceDp = `WTS_wp_esp.pump().dp` at the intake cell's state, linearised per step; vent gas a sink counted at the surface | §4.12, LF21, LF22 |
| R11 | bounded Godunov face flux of the drift-flux function; `levelSettle` scenario and EN25 | §4.4, §4.10, §3.9 |
| R12 | CFL with the kinematic-wave speed ∂f/∂α as well as the phase velocities | §4.6 |
| R13 | flash: donor's actual G_d/N_o for dissolved gas, per-cell GOR cap and rate fractions, ∂V/∂p by differencing the same props, liberation only with G_f > 0, Rv refused (`RV_NOT_IN_TRANSIENT`) | §3.1, §4.1, §4.3, EN28, EN29 |
| R14 | reservoir back-flow by the IPR slope at p̄r (option, default on, provisional `res_back`); `killColumn` scenario, EN26 | §3.1, §4.7, Q17 |
| R15 | r_w,eff = r_w e^(−S) for S < 0; `prior` history setting (steady / none / shutin) | §3.1, §4.7, RS11, RS12 |
| R16 | Snap gains faces (jg / jo / jw / xI / vd / c0 / w), the line table and its reference, q_ref / tOpen, label histories, steady buffer, lift gas; EN15b coverage | §3.6 |
| R17 | mHash excludes M.dyn and hashes the resolved reservoir; the page ignores model-changed with keys ['dyn'] | §3.1, §6.9, §7 |
| R18 | F / I / W / keys from `WTS_wp_system.context(M)`; EN24 identity | §2.4, §4.1, WD-D16 |
| R19 | budgets derived from Δt and step counts per scenario; create ≤ 800 ms (≈ 30 ms with a cached ref); WD0 lead spike | §5.6, §9.0 |
| R20 | dynamic screens of the fixtures, lagged v_d under-relaxed (ω 0.5), time-mean steady criterion with a bounded amplitude | §3.9, §4.4, §5.1 |
| R21 | Belfroid default off (Q16), both q_c reported, EN12 against `WTS_wp_loading` with Belfroid off, the nodal method rule, water / condensate rule, β in radians | §4.11, §4.14, Q16 |
| R22 | `killSg` removed: the kill fluid is the model's water; `glUnload` text fixed | §3.1, §3.9, §4.12 |
| R23 | valve balance in gauge; sources once per step before the pressure solve from lagged pressures | §3.3, §4.12 |
| R24 | WD0 test edits: sidebar-nav full list + 6 rows, help-content PARTS (WD6), help group route list | §2.1, §2.3, §9.0 |
| R25 | bit-identical within one JavaScript engine; `engineId`; cross-engine replay within a tolerance, never "corrupt" | WD-D8, §3.7 |
| C1 | correlation holdup on every co-current face; drift flux only below 0.05–0.10 ft/s or counter-current; EN11 on w = 1 | §4.4, §5.2 |
| C2 | correlation at the cell centre; `--check` diagnostic with the nodal march at stepFt = cell length | §4.4, §5.1 |
| C3 | K = 1.53 / C_0 in the bubbly range; m(θ) constants "to verify" | §4.4 |
| C4 | run loop accumulates a simulated-time target | §6.6 |
| C5 | report canvases 360×480 and 640×220, Quick Report measured at WD3 | WD-D15, §6.7 |
| C6 | tubing compliance and water compressibility floor (key `compliance`) | §3.1, §4.1 |
| C7 | R0 / context / line table cached by model hash (`opts.ref`) | §3.1, §6.9 |
| C8 | surface gas = formation + lift + vent; formation GOR reported apart | §3.2, §3.4, §4.8 |
| C9 | `STATE_ORDER` and the channel order frozen in the fixtures; new keys appended | §3.2, §3.4, §3.9 |
| C10 | RS4 uses the transient preset explicitly; t_wbs / t_pss pinned in the `buildup` fixture | §3.9, §5.2 |
| C11 | D17 table: `belfroid` own row (default off), `res_sup` / `choke_sub` never defaults, `liftgas_mix` and `esp_node` identity | §4.14 |
