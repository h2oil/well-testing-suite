# Well Performance and Nodal Analysis module (v4.3 / v4.4 / v4.5) — implementation plan

> **Status: draft for owner review, revision 2** (2026-11-10, on top of master a3e87c3 = v4.2). Nothing is built yet. Test counts
> in this plan are relative to the v4.2 gates (smoke 344, acceptance 1,900, server 278).
> The module is our own design. Published methods are cited by their authors and year only (they are public literature). A worked
> example number marked "to verify" is not used in a test until it has been checked against the book. Revision 2 applies the plan
> review (§0.1 lists what changed and the one partial adoption).

| | |
|---|---|
| Module | Well Performance (nodal analysis): fluid, inflow, well, lift, system, match, report |
| Route | `wellperf` (one page, seven internal steps), inside a new **Well Performance** hub (hub key `perf`) in Production & Reservoir |
| Increment A1 (v4.3) | lean and shippable alone: rate at a choke, bean sizing, deliverability through the system with stability, shut-in / maximum THT / bean schedule for the surface package, liquid loading, erosion and hydrate flags, 1-variable sensitivity, correlation comparison and test QC, report |
| Increment A2 (v4.4) | Duns & Ros, Cullender-Smith, the extra black-oil correlation families (16-pvt), flowing-temperature relaxation with a U fit, continuous critical / sub-critical choke model, 2-variable sensitivity Jobs, VLP tuning with LM, gas-lift quick look, the training course |
| Increment B (v4.5) | lift-curve table export, mechanistic and more empirical correlations, enthalpy-balance temperature, PVT lab match, special inflow (horizontal, fractured, multilayer, injector, transient, water-cut composite), full gas-lift design and diagnostics, ESP, cases, depletion forecast, Build-up Surveillance hand-off |
| Increment C (later) | equation of state, rod pump, PCP, jet pump, plunger, coning, material-balance coupling, live virtual metering, economics |
| New files | Round 9 only: `49-calc-wellperf.js` (page), `49-calc-wp-model.js` (model reader / writer) + `49-calc-wp-*.js` engines (§2.2); no new round, no host route-table edit |
| Host edits | three, all in WP0: static hub row markup, `__NAV_HUBS.perf`, `__NAV_ORDER` (§2.1) |
| Shared engines reused | 16-pvt, `WTS_gaspvt_*`, `WTS_oilipr_*`, `WTS_gasdeliv_*`, `WTS_flowline_march` / `_compute` / `_props`, `WTS_wellbore`, `WTS_tubulars`, `WTS_gradient_compute`, `WTS_chokeperf_*`, `WTS_gaslift_*`, `WTS_hydrate_temp`, `WTS_sepqc_compute`, `PRiSM_getWell`, `PRiSM_getLastFit`, `PRiSM_gasDeliverability`, `PRiSM_skinDecomposition`, `PRiSM_skinCheck`, `PRiSM_mpTable`, `PRiSM_lm`, `PRiSM_autoInterp.drive` |

---

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| D1 | One page `wellperf` with seven internal steps (① Fluid ② Reservoir ③ Well ④ Lift ⑤ System ⑥ Match ⑦ Report), not a PRiSM workspace mode and not seven sidebar rows. | §2.1 |
| D2 | A new hub **Well Performance**, hub key `perf` (deliberately different from the route key `wellperf`), members `wellperf`, `oilipr`, `gasdeliv`, `gaslift`. Production & Reservoir goes from 7 rows to 5 (prism, oilgas, solgor, Well Performance, buildup). Three host edits in WP0: the static `.nav-hub` row, `__NAV_HUBS.perf`, `__NAV_ORDER`. Members keep route, autosave record, report snapshot and help guide. | §2.1 |
| D3 | **One marcher.** New correlations plug into the existing `march` of 49-calc-flowline.js through a registry `WTS_flowline_corr`; `opt.corr` is a registry **key string** everywhere. Every flowline edit is owned by one package (WP0b), is an additive option whose default reproduces today's output bit for bit, and is merged first with its identity tests. | §2.3, §4.4 |
| D4 | **Delegate, never re-implement.** The oil and gas inflow calculators gain additive parameter-driven evaluators (`WTS_oilipr_model`, `WTS_gasdeliv_model`, `WTS_gasdeliv_fitAB`) built on the private functions their `compute()` already uses; `WTS_wp_ipr` calls them. Chokes call `WTS_chokeperf_multiphaseRate` / `WTS_chokeperf_gasRate` directly. Missing correlations go into the file that owns the family. | §2.3, §3.3 |
| D5 | Default correlations: Hagedorn & Brown (Griffith bubble-flow and holdup ≥ no-slip rules) for oil wells, Gray for gas / condensate wells, Beggs & Brill for flowlines; dry gas by the average temperature and Z method (Cullender-Smith cross-check in A2). | §4.4 |
| D6 | Operating point = every root of Δ(q) = p_out(q) − p_in(q) at the solution node. A root is statically stable when dΔ/dq > 0. The **static stability limit** q_s is where dΔ/dq = 0 for the current IPR and boundary condition; only q < q_s is shaded. The minimum of the tubing curve (dp_out/dq = 0) is reported separately as the conventional, more conservative rule. The heading flag is based on q_s. | §4.9, §4.10 |
| D7 | Temperature, A1: the existing linear THT → BHT profile, with a Joule-Thomson correction of the THT used in the hydrate check for gas / condensate wells. A2: a new public `WTS_wellbore.flowingTemp(column, opts)` (Ramey / Hasan-Kabir steady relaxation, produce or inject). `WTS_wellbore._ramey` stays reserved for DFIT 3.4b (owner question Q16). | §4.6 |
| D8 | Model data live in one well-scoped JSON key `wts_wellperf_model` (v1), read and written only by `WTS_wp_model` (49-calc-wp-model.js, WP0); scalar controls autosave in `wts_page_wellperf`. Results are recomputed, never stored. The page holds no model cache across renders and re-reads on `wts:well-changed` / `wts:project-loaded`. | §2.8 |
| D9 | Long jobs (sensitivity, GLPC, design scans, lift tables) run only on a button press, as Jobs through `PRiSM_autoInterp.drive`, with Cancel and progress. No new timer user, no polling. | §6.4 |
| D10 | Matching (A2) reuses `PRiSM_lm`. Holdup multiplier H_L' = clamp(m_h·H_L, λ_L, 1), friction multiplier m_f; ρ_s, slip viscosity, gradients and the acceleration factor are rebuilt inside the march. Only m_h is fitted unless the tests span ≥ 2:1 in rate. | §5.2 |
| D11 | Karakas-Tariq perforation skin stays disabled while `PRiSM_skinCheck` marks its table UNVERIFIED; the module takes a user-entered perforation skin and says so. | §4.3 |
| D12 | The page supports Metric display through the units layer; engines are imperial. Unit categories are registered locally by the page (guarded, like gaslift / lineheat); 22-units.js is not edited. | §13 |
| D13 | Increment A1 is deliberately lean (§1.4, §18.1); everything else is A2, B or C. | §1.4, §18 |
| D14 | Gas-condensate in A1 / A2 is a **wet gas**: separator gas as the free gas plus the condensate as a liquid of constant volume per standard volume, no mass transfer (Rs = 0 for the condensate). The recombined well-stream gravity is used only in the reservoir inflow and the shut-in gas column, never together with a separate liquid in the march. Modified black oil (Rv) is B. | §4.1 |
| D15 | Naming: method keys, labels, help text, code comments and tests use author names or descriptive names only; an acceptance test greps the module's files for banned names. | §2.11 |
| D16 | Performance budgets are stated as **evaluation counts** per operation (stable on any machine) plus milliseconds measured on the existing marcher in WP0, with a phone factor ×3; when a measured solve exceeds the interactive budget the page switches to a Solve button. Accuracy tolerances are never loosened to meet a budget. | §16 |
| D17 | A correlation with no verified published example ships labelled "provisional — not verified against a published example" (as DFIT and Karakas-Tariq do), and is not a default. | §15.1 |
| D18 | Events use the existing namespace: `wts:wellperf-model-changed`, `wts:wellperf-solved`. | §3.10 |
| D19 | Reports: a compact report block (summary cards, system plot, flags, validity verdicts) is always rendered; editors, long tables and step-only plots are `.rp-skip`; canvases are drawn at explicit sizes even while hidden; the Quick Report snapshot size is tested. The host REPORT_DISCLAIMER prints on every report and snapshot. | §2.9 |

### 0.1 Revision 2 — review findings applied

All review findings were applied. Duplicate findings (the hub markup, the performance budgets, the Quick Report mechanism) were merged.
Partial adoption, with the reason:

- **Choke continuity in A1.** The review proposed one continuous critical / sub-critical model (Sachdeva) or a max-of-two-curves rule.
  Sachdeva moves to A2 with the scope split, so A1 uses the max rule with the existing critical correlations:
  p1(q) = max(p1_crit(q), p2 / y_c). This is continuous, and it is a conservative bound (it over-states the p1 needed in sub-critical
  flow, so it under-states the rate). It is flagged "sub-critical — conservative bound". A2 adds the continuous Sachdeva model (§4.7) as
  an option; while it is provisional (D17) the bound stays the default (A2 review, §18.2.9).
- **Sensitivity and GLPC as Jobs.** The review proposed Jobs from about 10 cases. The plan goes further: they always run as Jobs, on a
  button press. This gives one code path, and progress is shown even for small runs.

No finding was rejected.

---

## 1. Scope, users and user stories

### 1.1 What the module does

Well performance (nodal) analysis couples the reservoir inflow with the outflow through the completion, tubing, restrictions,
choke and flowline to the separator. For a well-testing company the first questions are practical:

- **Before a test:** what rate will the well make at a given choke and separator pressure; which bean gives the target rate;
  will the well flow at all after a cushion is unloaded; is the gas well above its liquid-loading rate; what shut-in and flowing
  wellhead pressure and temperature the surface package must be rated for; what the bean-up steps look like (rate, THP, THT and choke
  regime per bean); would gas lift help (A2).
- **During and after a test:** are the measured rates, THP, THT and gauge pressure consistent with each other and with a physical
  model; which VLP correlation matches the gauge; what are p̄r, PI and skin back-calculated from the gauge or the wellhead; what would
  the well make after a stimulation, a tubing change or a lower separator pressure.

The module answers these on one page, reusing the inflow, PVT, choke, flowline, gas-lift and wellbore engines already in the app,
and adds the missing pieces: a multi-correlation vertical-lift engine on the existing marcher, the system solver with stability,
shut-in and surface-rating outputs, liquid loading, sensitivity, comparison and QC, then (A2 / B) a flowing-temperature model,
tuning, lift-curve tables and artificial lift.

### 1.2 Users

| User | Needs |
|---|---|
| Well-test engineer (planning) | rate and THP / THT forecast per choke, choke sizing, SITHP and maximum THT against the equipment rating, bean schedule, liquid-loading and hydrate flags, a one-page report for the test programme |
| Well-test supervisor (field) | quick QC of a flow period against the model; "is this rate plausible at this choke"; bean-up steps |
| Production engineer | VLP correlation choice and tuning (A2), IPR from PTA results, sensitivity, gas-lift quick look (A2), lift-curve tables (B) |
| Reviewer / client | a report with inputs, the model, the operating point, warnings, validity ranges and the disclaimer |

### 1.3 User stories (each is an acceptance item in the named test file)

| # | Story | Inc. | Test file |
|---|---|---|---|
| US1 | I enter API, gas gravity, GOR (or CGR for a wet gas), water cut and temperature and see Pb, Rs, Bo, μo, Z, μg, ρ along the wellbore, with each correlation's validity range checked. | A1 (more correlation families A2) | wellperf-pvt |
| US2 | I pick an inflow model (PI, Vogel, composite, Fetkovich, Jones-Blount-Glaze, Darcy from k·h and skin; gas C&n, LIT in p² or m(p), Darcy with D) and see the IPR, AOF and PI; with test points it fits them. | A1 | wellperf-ipr |
| US3 | I press "Import from PRiSM" and k, h, S, D, p̄r, μ, B, ct, T (and the PRiSM gas deliverability C, n, a, b, AOF when present) come in with their provenance shown; a missing p̄r is reported, never defaulted. | A1 | wellperf-ipr |
| US4 | I enter a survey (MD / TVD or MD / inclination / azimuth), tapered strings, restrictions and a geothermal gradient — or import them from a DFIT test of the same well — and see the TVD at every node. | A1 | wellperf-well |
| US5 | For a rate I see the pressure and temperature traverse with holdup, flow pattern and the gravity / friction / acceleration split. | A1 | wellperf-vlp |
| US6 | I see the IPR / VLP plot with every operating point, the statically unstable range shaded, the static stability limit and the tubing-curve minimum, and the Δp breakdown (reservoir, completion, tubing, restriction, choke, flowline). | A1 | wellperf-system |
| US7 | Given a separator pressure and a bean I get the rate; given a target rate I get the bean (or the THP); given everything I get the maximum rate through the system; I get the SITHP (gas-filled, actual fluid, partly liquid-filled), the maximum flowing THT and a bean schedule, each with ✓ / ⚠ against my equipment rating. | A1 | wellperf-system |
| US8 | For a gas well I see the Turner / Coleman / Li critical rate along the well, the controlling depth and the margin of the operating point. | A1 | wellperf-loading |
| US9 | I vary one parameter (A1) or two (A2) (p̄r, WC, GOR, THP, tubing ID, skin, bean, lift gas) and see curve families and a rate-vs-parameter table. | A1 / A2 | wellperf-sens |
| US10 | I enter a test (q, WC, GOR, THP, THT, gauge depth and pressure, bean) and see every correlation ranked against the gauge, PI / skin / p̄r back-calculated and a list of consistency flags; (A2) tuned multipliers. | A1 / A2 | wellperf-match, wellperf-qc, wellperf-tune |
| US11 | I set the gas-lift injection pressure and gas rates and see the gas-lift performance curve, the injection depth per point and the rate gain. | A2 | wellperf-gaslift |
| US12 | I export the curves (IPR, VLP family, traverse, sensitivity) to CSV and get the report and Quick Report with no extra step. | A1 | wellperf-page |
| US13 | I export lift-curve tables (BHP vs rate × THP × WC × GOR × lift quantity) in the lift-curve table text format (producer / injector) and as CSV. | B | wellperf-export |
| US14 | I match the black-oil correlations to a lab table and the rest of the module uses the matched set. | B | wellperf-pvtmatch |
| US15 | I model a horizontal or fractured well, a multilayer well with crossflow, or an injector. | B | wellperf-ipr2 |
| US16 | I design gas-lift unloading valves on a deviated well with the real IPR, check valve throughput and diagnose the operating valve from CHP / THP. | B | wellperf-gl2 |
| US17 | I size an ESP from a pump curve table, see the operating point on the curve and the frequency fan, and check free gas at the intake. | B | wellperf-esp |
| US18 | I keep named cases (base / matched / proposed), compare them and run a depletion forecast over future p̄r. | B | wellperf-cases |

### 1.4 Coverage of the well performance (nodal analysis) feature checklist

MUST = core; SHOULD = expected professionally; COULD = advanced. "A1", "A2", "B", "C" = the increment that delivers it; "—" = out of
scope.

| Area | Item | Imp. | Inc. | How (reuse first) |
|---|---|---|---|---|
| Set-up | A1 well / fluid / lift / mode options | MUST | A1 | step ① header; fluid types oil, dry gas, wet gas / condensate (D14), water injector; gas injector B |
| | A2 units, datum | MUST | A1 | units layer; datum RKB / GL / MSL offset field |
| | A3 cases | SHOULD | B | `wts_wellperf_model.cases[]` |
| | A4 validity / consistency checks | MUST | A1 | `WTS_wp_check` (§4.13, Appendix A ranges) |
| PVT | B1 black oil | MUST | A1 (existing 16-pvt Standing / Beggs-Robinson / Vasquez-Beggs keys) / A2 (Vasquez-Beggs Pb / Rs / Bo, Glasø, Petrosky-Farshad, Egbogah, Bergman-Sutton, Abdul-Majeed σ) | 16-pvt |
| | B2 gas | MUST | A1 | `WTS_gaspvt_z` / `_viscosity` / `_pseudoCriticals` (impurities, Wichert-Aziz) |
| | B3 water | MUST | A1 (Meehan, existing) / A2 (McCain density / salinity) | 16-pvt |
| | B4 lab match | MUST/SHOULD | B (A1: one-point Pb shift) | PRiSM_lm multiplier + shift |
| | B5 condensate / wet gas | SHOULD | A1 (wet gas, D14) / B (Rv) | §4.1 |
| | B7 emulsion | SHOULD | B | Woelflin / Brinkman / user table |
| | B6, B8, B10 | COULD | C (B10 hydrate flag in A1) | `WTS_hydrate_temp` |
| | B9 PVT table export | SHOULD | B | CSV |
| Inflow | C1 oil IPR | MUST | A1 | `WTS_oilipr_model` + new Darcy / JBG; water-cut-weighted composite three-phase IPR (oil Vogel + water PI, key `wcComposite`) in B |
| | C2 gas IPR | MUST | A1 | `WTS_gasdeliv_model` / `_fitAB` + m(p) LIT and Darcy + D via `PRiSM_mpTable` |
| | C3 multi-rate fits | MUST | A1 | the two calculators' fitters, reused for JBG and m(p) LIT |
| | C9 skin | MUST | A1 | `PRiSM_skinDecomposition` + Hawkins + McLeod + gravel-pack tunnel, h / h_p scaling |
| | C4, C5, C7, C8, C10, C13 | SHOULD | B | §4.2 B list |
| | C6, C11, C12, C14 | COULD | C (C14 future IPR via oilipr's existing rule in A1) | |
| Well | D1–D5 survey, temperature data, tubulars, restrictions, surface | MUST | A1 | `WTS_wellbore` (+ minimum curvature), `WTS_tubulars` (+ roughness defaults), `WTS_flowline_*`, `WTS_chokeperf_*`; DFIT geometry import |
| VLP | E1 traverse | MUST | A1 | `WTS_flowline_march` (+ WP0b options) |
| | E2 empirical correlations | MUST | A1 (HB, Gray, Beggs & Brill, no-slip, average T-Z, single-phase) / A2 (Duns & Ros, Cullender-Smith) / B (Orkiszewski, Aziz-Govier-Fogarasi, Mukherjee-Brill) | `WTS_flowline_corr` |
| | E3 mechanistic | SHOULD | B (Ansari, Hasan-Kabir) | registry |
| | E4 comparison | MUST | A1 | `WTS_wp_match.compare` |
| | E5 tuning | MUST | A2 | PRiSM_lm, 1–2 multipliers (D10) |
| | E6 VLP curves / tables | MUST | A1 curves, B table export | §9 |
| | E7 temperature | MUST rough / SHOULD improved | A1 linear + J-T hydrate correction, A2 relaxation, B enthalpy | §4.6 |
| | E8, E10 | COULD | E10 holdup / pattern columns in A1; E8 C | |
| | E9 injector VLP | SHOULD | B | single-phase path of the marcher |
| Surface | F1 chokes | MUST | A1 (existing critical correlations, continuous sub-critical bound) / A2 (Sachdeva continuous) | §4.7 |
| | F2 flowline | MUST | A1 | `WTS_flowline_march` reverse from the separator |
| | F3 erosion | MUST | A1 | RP 14E in the march (`eroC`), Salama screen B via 27-pipelife |
| | F4 separator node | MUST | A1 | fixed pressure; QC'd GOR from `WTS_sepqc_compute` |
| | F5 shut-in / surface rating | MUST | A1 | `WTS_wp_system.shutIn`, max THT, bean schedule (§4.14) |
| System | G1 node selection | MUST | A1 (bottom hole, wellhead, separator) | `WTS_wp_system` |
| | G2 modes | MUST | A1 rate, THP / BHP for a rate, max rate, solve bean / THP; A2 tubing / lift gas | |
| | G3 sensitivity | MUST | A1 (1 variable) / A2 (2) / B (≤ 4, tornado) | `WTS_wp_sens` |
| | G4 stability | MUST | A1 | static limit dΔ/dq = 0, tubing-curve minimum; Asheim gas-lift criteria in B |
| | G5 liquid loading | MUST | A1 | Turner, Coleman, Li; Nosseir, Guo in B |
| | G6, G7 | SHOULD | B (flags in A1) | |
| Lift | H1, H2, H3 gas lift | SHOULD/MUST | A2 quick look, B design + diagnostics | `WTS_gaslift_*` extended |
| | H5 ESP, H11 screening | SHOULD | B | new `WTS_wp_esp` |
| | H4, H6–H10 | COULD | C | |
| Forecast | I1, I2 | SHOULD | B | |
| | I3 | COULD | — (owner Q8) | |
| QC / match | J1, J2 | MUST | A1 (QC, compare, IPR from test) / A2 (tuning) | `WTS_wp_qc`, `WTS_wp_match` |
| | J3 survey import | SHOULD | B (DFIT geometry import in A1) | |
| | J4 virtual metering | COULD | C | historian link |
| Batch / data | K1, K2 | SHOULD | B (CSV export of curves in A1) | |
| | K3 open engine API | COULD | A1 (the engines are public `WTS_wp_*` functions) | |
| Reports | L1, L2 | MUST | A1 | markup conventions, D19 |
| | L3 schematic | SHOULD | B | SVG from survey + strings |

### 1.5 Out of scope (with the reason)

- Surface gathering networks and multi-well allocation (needs a network solver; the app is single well per page). Gas-lift gas
  allocation between wells is listed for increment C.
- Compositional wellbore flow with an equation of state (heavy and slow; the wet-gas model covers the test-design use) — C.
- Transient wellbore flow (slugging dynamics, unloading time history) — the simulator is the place for dynamics.
- Economics (I3) — owner Q8.
- Any in-app purchase, account-only feature or server dependency: the module runs fully offline on web and iOS.

---

## 2. Architecture

### 2.1 Where the module lives (decision)

Three options were weighed against the 8-row cap (Production & Reservoir has 7 of 8 rows: prism, oilgas, solgor, gasdeliv,
oilipr, gaslift, buildup).

| Option | For | Against |
|---|---|---|
| (a) New sidebar row `wellperf` | simplest | takes the last free row; the next module in the group then needs a hub anyway; three overlapping pages stay scattered next to it |
| (b) PRiSM workspace mode | reuses the five-step shell, rail and report | PRiSM is a transient pressure-dataset workspace (field units only, C1–C9 built around a dataset and a fit); a steady-state system model has no dataset, needs Metric display and a different step list; it would load the whole PRiSM shell for a quick choke question |
| **(c) Hub "Well Performance"** with members `wellperf`, `oilipr`, `gasdeliv`, `gaslift` | groups the related calculators; frees two rows (7 → 5); members keep routes, autosave, snapshots, help; `#hubTabs` already links members | three host edits and a sidebar test update |

**Chosen: (c).** Hub rows are static sidebar markup: nothing creates a hub button from `__NAV_HUBS` (`__hubMembers` and
`__sidebarSyncActive` query existing `.nav-btn[data-hub]` elements; `__mountCalcNav` only adds `nav-hub-member` to plug-in buttons,
and `.nav-hub-member` is `display:none`). Without the markup, all four members would vanish from the sidebar. The host edits (WP0,
the only host edits of the module) are therefore:

1. Static markup in the Production & Reservoir group, after the solgor button:
   `<div class="nav-btn nav-hub" data-hub="perf"><span class="nav-icon">&#8645;</span><span>Well Performance</span></div>`
2. `__NAV_HUBS`: `perf: { title: 'Well Performance', members: ['wellperf', 'oilipr', 'gasdeliv', 'gaslift'] }`
3. `__NAV_ORDER`: `'prism', 'oilgas', 'solgor', 'wellperf', 'oilipr', 'gasdeliv', 'gaslift', 'buildup', …`

The hub key `perf` differs from the route key `wellperf`, so `data-hub` and `data-p` cannot be confused in tests or searches
(`wts_ui_hub_last` is keyed by hub). The page `wellperf` is the first member, so a first click on the hub opens the nodal page; after
that the hub opens the member used last (existing behaviour).

WP0 also: updates the HUBS map and the row assertions in `tests/sidebar-nav.test.js` (5 rows in Production & Reservoir, hub `perf`
with four members); checks how `renderHome()` shows tiles of hub members (the existing hubs are the reference — the new members must
behave the same, with a test); re-runs `ux-layout-check.js` for the 1280×800 fit; adds `wellperf` to the help group routes list.

### 2.2 Files, rounds and owners

All new files are Round-9 plug-ins (`4N-calc-*.js`, auto-discovered in numeric order, ties by name). Every cross-file reference is
resolved at call time, never at load, so the order does not matter.

| File | Kind | Public symbols | WP | Inc. |
|---|---|---|---|---|
| `49-calc-wp-model.js` | model I/O | `WTS_wp_model` (read → frozen M, write via `WTS_lsSet`, migrate, decimate, 256 kB cap, v1 reader, DFIT geometry import mapper) | WP0 | A1 |
| `49-calc-wp-fluid.js` | engine | `WTS_wp_fluid` (build, table, check, recombine, flowlineFluid) | WP1 | A1 |
| `49-calc-wp-ipr.js` | engine | `WTS_wp_ipr` (models, curve, fit, fromWell, skin) | WP2 | A1 |
| `49-calc-wp-vlp.js` | engine | registers correlations into `WTS_flowline_corr`; `WTS_wp_vlp` (traverse, curve, family, gasDry, singlePhase) | WP3 | A1 |
| `49-calc-wp-well.js` | engine | `WTS_wp_well` (segmentsFor, restrictions, temperature driver, schematic data) | WP4 | A1 |
| `49-calc-wp-system.js` | engine | `WTS_wp_system` (solve, roots, stability, breakdown, designFor, maxRate, shutIn, beanSchedule), `WTS_wp_loading`, `WTS_wp_check` | WP5 | A1 |
| `49-calc-wp-sens.js` | engine | `WTS_wp_sens` (matrix, job, table, csv) | WP6 | A1 |
| `49-calc-wp-match.js` | engine | `WTS_wp_match` (compare, iprFromTest; A2 tune), `WTS_wp_qc` | WP7 | A1 |
| `49-calc-wellperf.js` | page | `renderWellPerf`, `calcWellPerf`, `WTS_state.wellperf`, registry entry `wellperf` | WP9 | A1 |
| `48-calc-help-wellperf.js` (or a section in 48-calc-help-production.js) | help data | guide factory (§14, owner Q15) | WP10 | A1 |
| `49-calc-wp-lift.js` | engine | `WTS_wp_gl` (glpc, quickLook; B: design wrapper, throughput, diagnose) | WP18 | A2 |
| `49-calc-wp-export.js` | engine | `WTS_wp_export` (lift tables, PVT tables) | WP20 | B |
| `49-calc-wp-tables.js` | page panel | `WTS_wp_tables` (step ⑦ lift / PVT table cards, `#wp_ltsum`) | WP20 | B |
| `49-calc-wp-esp.js` | engine | `WTS_wp_esp` | WP26 | B |
| `49-calc-wp-cases.js` | engine | `WTS_wp_cases`, `WTS_wp_forecast` | WP27 | B |
| `prism-build/wellperf-validate.js` | tool | benchmark + timing gate (`--check`, `--time` reports evaluations and ms) | WP11 | A1 |
| `tests/_wellperf-shapes.js` | frozen fixture | §3.12 | WP0 | A1 |

### 2.3 Additive edits to existing files (exact; each default reproduces today's output)

| File (round) | Edit | Owner WP | Identity guard |
|---|---|---|---|
| 49-calc-flowline.js (R9) | (1) Registry `WTS_flowline_corr = WTS_flowline_corr \|\| {}`, `bb` registered by this file. (2) `opt.corr` = a registry **key string**; `_gAt` resolves `WTS_flowline_corr[key].grad(inp)` (unknown key → `{ok:false, code:'UNKNOWN_CORR'}`); absent → today's `bb` call. (3) `opt.mult {hl, f}`: H_L' = clamp(m_h·H_L, λ_L, 1), then ρ_s, slip viscosity, gradEl, gradF and grad = (gradEl + gradF) / (1 − Ek) rebuilt inside the step. (4) `opt.stepFt` overrides `_steps(len)` (still clamped 10–400 per segment). (5) `opt.grid` freezes the step / sub-step layout for one solve (§4.5). (6) `opt.eroC` (default 100, today's hard-coded C). (7) `opt.detail` adds `vm, vsl, vsg, rhoS, gradEl, gradF, gradAcc, ero` to each profile entry (absent → today's `{x, p, t, hl, pattern}`). (8) `props` reads an optional `fluid.pvt` object: correlation keys, one-point Pb shift, matched multipliers (B), undersaturated Bo, impurity Z via `WTS_gaspvt_z`, `liquidNoTransfer` (wet-gas condensate, Rs = 0, constant volume), `injGas {qg_MMscfd, sg}` (A2 gas lift: free gas only), `table` (a (p, T)-binned property lookup for speed); absent → today's Standing / Beggs-Robinson / DAK-Sutton path. (9) The public `WTS_flowline_march` wrapper passes `corr`, `mult`, `tAt`, `pMax`, `stepFt`, `grid`, `eroC`, `detail` through (today it drops all but rough / payne / accel / reverse / refine). | **WP0b** (all of them, one package, merged before any other engine WP) | `wellperf-identity` FI1–FI6: every existing flowline, flare and gas-lift test vector re-run with **no new option** and deep-compared on the **full march output**; calc-flowline / flowline-flare / calc-gaslift suites unchanged |
| 42-calc-oilipr.js (R9) | Export `WTS_oilipr_model({mode, pr, pb, J \| qmax, FE, C, n}) → {qAt, pwfAt, aof}`, built on the same private functions (`qAt` and friends) that `compute()` uses. | WP2 | FI7: `WTS_oilipr_compute` outputs of the calc-new suites unchanged; `model` equals the compute tables point for point |
| 41-calc-gasdeliv.js (R9) | Export `WTS_gasdeliv_model({cn \| lit, pr}) → {qAt, pwfAt, aof}` (on the private `lit._q`) and `WTS_gasdeliv_fitAB(points, deltaFn)` — its a·q + b·q² least-squares fitter on a generic Δ, reused for Jones-Blount-Glaze and m(p) LIT. | WP2 | FI8: `WTS_gasdeliv_compute` outputs unchanged |
| 48-calc-wellbore.js (R9) | (1) `surveyMC(rows)` minimum curvature from MD / inclination / azimuth → MD, TVD, N, E, dogleg; `column()` accepts 3-column survey rows (today's `[md, tvd]` unchanged). (2) A2: new public `flowingTemp(column, opts)` (§4.6). **`_ramey` is not defined by this module** — it stays reserved for DFIT 3.4b (its NOT_AVAILABLE error and `dfit-wellbore.test.js:265` stay as they are). | WP4 (A1), WP14 (A2) | `dfit-wellbore` unchanged (30 tests, including the Ramey NOT_AVAILABLE assertion); WB-ID: `tempProfile` with `static` / `displaced` / `ramey` unchanged |
| 40-calc-tubulars.js (R9) | `WTS_tubulars.roughness` default lookup (new steel 0.0006 in, used tubing 0.0018 in, plastic-coated 0.0002 in, corrosion-resistant alloy 0.0002 in — owner Q10); `find(key).rough` left undefined. The column's per-string `rough` stays the source of truth; the map only supplies a default. | WP4 | calc-g2, calc-wellkill unchanged |
| 49-calc-chokeperf.js (R9) | A2: `WTS_chokeperf_sachdeva(o)` (critical / sub-critical, continuous, §4.7) and `WTS_chokeperf_liquidCv(o)`. The gas nozzle is the existing `WTS_chokeperf_gasRate` (isentropic, Cd, critical and sub-critical), called directly — no alias. `WTS_chokeperf_CORR` stays the four critical correlations. | WP15 | calc-chokeperf (7) unchanged |
| 49-calc-gaslift.js (R9) | B: optional input `ipr` (a `WTS_wp_ipr` curve object) replacing the straight-line PI, and `segments` (deviated well) replacing `[{len:L, dz:L}]`. Absent → today. | WP25 | calc-gaslift (4) unchanged |
| 16-pvt.js (R3) | A2: add to `PRiSM_pvt_correlations` (merge): `Pb_vasquezBeggs`, `Rs_vasquezBeggs`, `Bo_vasquezBeggs`, `Pb_glaso`, `Rs_glaso`, `Bo_glaso`, `Pb_petrosky`, `Rs_petrosky`, `Bo_petrosky`, `mu_oD_egbogah`, `mu_oD_bergmanSutton`, `mu_o_chewConnally`, `co_petrosky`, `sg_gas100_vasquezBeggs`, `rho_w_mcCain`, `Bw_mcCain`, `sigma_og_abdulMajeed`, `Rsw_mcCain`. All 20 existing keys untouched (Pb / Rs / Bo Standing, Beggs-Robinson μ, co / μ Vasquez-Beggs, Bo undersaturated, Sutton Tpc / Ppc, DAK and Hall-Yarborough Z, Lee-Gonzalez-Eakin μg, Bg, cg_realGas, Meehan Bw / μw, Dodson cw, m_p, ct). The host's private Vasquez-Beggs code (`calcSolGOR`, `_vbGasGravity100`) is not moved; a test pins the new keys to the host page's numbers. | WP13 | P-ID: all 20 existing keys identical on the 16-pvt self-test grid; after the Round-3 rebuild, dfit-*, prism-gas / wp15-gas, buildup-engine-* and calc-review-pvt-wellkill unchanged |
| well-testing-app.html (host) | The three hub edits of §2.1. RELEASE_NOTES item at ship time. | WP0 | sidebar-nav |

Not edited: 22-units.js (categories registered locally, §13), PRiSM files 01–59 other than 16-pvt.js (A2), the simulator (31/32/38).

### 2.4 Load order and feasibility

- Round 9 loads after Rounds 1–8, so `PRiSM_pvt_correlations`, `PRiSM_lm`, `PRiSM_getWell`, `PRiSM_mpTable`,
  `PRiSM_skinDecomposition` and `PRiSM_autoInterp` exist when any `WTS_wp_*` function runs. Each engine still checks
  `typeof G.X === 'function'` at call time and returns `{ok:false, code:'MISSING_ENGINE', name}` instead of throwing.
- Every file: single outer IIFE, public symbols on `window`, no load-time DOM access, no timers, self-test after
  `// === SELF-TEST ===` (stripped by concat).

### 2.5 Data flow

```
 wts_page_wellperf (scalars)  ─┐
 wts_wellperf_model (tables) ──┼─► WTS_wp_model.read() ──► Model M (frozen copy, §3.1)
 PRiSM / DFIT imports (on a  ──┘          │
 button, written into the model)          ▼
   ① WTS_wp_fluid.build(M.fluid)  ─► Fluid F  (pvt object for WTS_flowline_props)
   ② WTS_wp_ipr.curve(M.res, F)   ─► IPR I    (p_in(q); delegates to WTS_oilipr_model / WTS_gasdeliv_model)
   ③ WTS_wp_well.build(M.well)    ─► Path W   (segments from WTS_wellbore.column, restrictions, node depths, temperature driver)
   ④ WTS_wp_gl (A2) / esp (B)     ─► Lift L
   ⑤ WTS_wp_system.solve(F,I,W,L,M.surface,M.system) ─► Result R (roots, stability, traverse, breakdown, shut-in, flags)
      WTS_wp_sens.job(...) ─► families      WTS_wp_loading(R) ─► critical rates
   ⑥ WTS_wp_match.compare / iprFromTest, WTS_wp_qc (A2: tune) ─► rankings, back-calculated pr / PI / S, flags
   ⑦ page markup ─► compact report block / reports / Quick Report / CSV
```

Every engine is pure (inputs in, plain object out, no storage, no DOM). Only `WTS_wp_model` reads / writes storage, and only the page
calls it and writes `WTS_state.wellperf`.

### 2.6 How the page works

One route, one `#wp_root`, a step strip `#wp_steps` (`.rp-skip`; buttons ①–⑦ with a status dot: grey = incomplete, amber =
warnings, green = ready). Each step is a `<section id="wp_step_N">`; only the active one is shown. The active step is a device pref
`wtspref_wp_step`.

Registry entry: `hooks: { silent: true, after: function () { _syncUi(); window.calcWellPerf(); } }`, as in 49-calc-cheminj.js, so a
restore (page open, well switch, project open) applies the ~100 saved controls without events and runs exactly one calc.

Recalculation: committed input changes call `calcWellPerf()`, which runs the **interactive set** only: fluid, IPR, one system solve
(§16 evaluation budget), loading, flags, shut-in and the compact report block. Design modes (bean / THP for a target), the bean
schedule, sensitivity and GLPC run only on their buttons, as Jobs. If the measured solve time exceeds the interactive budget (container
ms × the phone factor), the page shows a **Solve** button instead of solving on every change, and says so.

### 2.7 Plots

Canvas plots in `.chart-wrap` with the host `drawLineChart` where it fits and a small module-local plotter for the rest (log axes,
shaded regions, inverted depth axis). The plotter sets `canvas.width` / `height` from fixed sizes (not from `clientWidth`), so a canvas
in a hidden step is still drawn at a usable size. All plots expose their series to the CSV export.

| Plot | Step | Report | Content |
|---|---|---|---|
| IPR | ② | step | q vs pwf; test points; AOF; Pb marker; future IPR |
| Fluid properties | ① | step | Rs, Bo, μo, Z, μg vs p |
| Survey | ③ | step | TVD vs horizontal departure; string and restriction markers; SVG schematic in B |
| Traverse | ⑤ | step | p and T vs TVD (inverted axis); holdup and pattern strip; measured gauge points |
| System (IPR / VLP) | ⑤ | **compact block** | IPR, VLP; operating points (filled = stable, hollow = unstable); shaded range q < q_s; q_s, tubing-curve minimum, loading rate, erosional rate as vertical lines |
| Δp breakdown | ⑤ | compact block | bar: reservoir, completion (skin), tubing gravity / friction / acceleration, restrictions, choke, flowline |
| Sensitivity | ⑤ | step | rate vs parameter; table |
| Loading | ⑤ | step | gas velocity and critical velocity vs depth |
| Correlation comparison | ⑥ | step | traverses with the measured points; error bars |
| Choke / bean schedule | ⑤ | step | rate, THP, THT vs bean |
| GLPC (A2) | ④ | step | q_L vs q_inj, optimum and economic points |
| ESP pump curve, gas-lift design chart (B) | ④ | step | |

"step" plots are `.rp-skip` and do not enter reports or the Quick Report; their data are in the CSV.

### 2.8 Data model and persistence

- **Scalars**: id'd controls `wp_*` in `#pgBody` → `wts_page_wellperf` (host autosave, well-scoped by WTS_wells, carried in project
  files, restored silently through `hooks`).
- **Tables**: `wts_wellperf_model` JSON (v1, §3.11), owned by `WTS_wp_model` (49-calc-wp-model.js): survey rows, strings, restrictions,
  geothermal points, flowline segments, test records, equipment ratings and bean list, lab table (B), pump curve (B), cases (B). Edited
  in in-page `table.dtable` editors (`.rp-skip`) with Add / Delete / Paste CSV; written on change through `WTS_lsSet` (quota-safe).
  Size cap 256 kB (survey decimated above 2,000 rows by the max-dogleg rule, with a note). The key starts with `wts_` and is not a
  library / wells / job key, so `29-multiwell._isWellKey` makes it per well and project save carries it — no project module needed.
- **No cache**: the page re-reads the model at every render and on `wts:well-changed` / `wts:project-loaded`
  (29-multiwell.js emits both on a switch and a project open), so a switch never shows the previous well's survey.
- **Results**: `WTS_state.wellperf = {v, ok, op, roots, qs, vlpMin, traverse, breakdown, shutIn, flags, loading, sens, match}` —
  recomputed, never persisted.
- **Library**: none in A1 / A2. B: pump-curve and valve library as a library key (owner Q11).
- **Migration**: `v` field; a reader for v1 only; unknown future versions open read-only with a banner.

### 2.9 Report and Quick Report

The host has no per-calculator snapshot hook: the Quick Report snapshot is the whole `collectPageReport(#pgBody)` model, cached in
`wts_report_snapshots` with eviction, and `collectPageReport` skips `.rp-skip` **and every element that is not displayed** (`_isShown`:
no client rects — a hidden step section, its cards and its canvases are left out; WP0 finding, `wellperf-shapes` WS4). The module
therefore controls what is captured with markup, and anything that must reach a report lives in the always-visible `#wp_res`:

- **Compact report block** `#wp_res`, always rendered whatever the active step: an inputs summary card, the operating-point card
  (q_o, q_w, q_g, pwf, THP, THT, stability, q_s, choke regime), the system plot, the Δp breakdown, the shut-in / maximum THT / rating
  verdicts, the loading / erosion / hydrate verdicts, the validity-range verdicts (Appendix A, each correlation actually used) and a
  `<div><b>Notes</b> …</div>` box with the known limitations that apply.
- **`.rp-skip`**: the step strip, the table editors, the full traverse and survey tables, the step-only plots, the CSV and Job buttons.
- **Step result cards** that should be reported (PVT table at six pressures, IPR summary and skin table, correlation ranking, QC flags,
  sensitivity table summary, bean schedule) are summarised cards inside the step sections without `.rp-skip`; long tables are
  summarised for the report (every 500 ft and every node change), full tables in the CSV.
- **Disclaimer**: the host prints `REPORT_DISCLAIMER` on every PDF / PNG report and on the Quick Report; `wellperf-page` tests that
  the disclaimer and the validity verdicts are present in both.
- **Size**: `wellperf-page` checks the serialised size of the `wellperf` entry in `wts_report_snapshots` (cap 60 kB on the fixtures,
  so other pages' snapshots are not evicted).

A real per-page snapshot selector in the host would be a separate host edit with its own test; it is not needed with the markup above.

### 2.10 Hand-offs

| From / to | What | How |
|---|---|---|
| PRiSM → ② | k, h, S, D, p̄r, μ, B, ct, T, rw, φ; gas C, n, a, b, AOF | "Import from PRiSM": `PRiSM_getWell()` + `PRiSM_getLastFit()`, plus the `summary` of `PRiSM_gasDeliverability()` when it is `ok`; each value carries a provenance chip; nothing is written back. `PRiSM_getWell` returns `pi = null` when its provenance is default: p̄r is then left empty and `WTS_wp_check` shows ✗ "p̄r needed" — never a default |
| DFIT → ③ | survey, strings, datum | "Import well geometry from a DFIT test": read-only from the chosen test's inputs in `WTS_state.dfit` (same `WTS_wellbore` / `WTS_tubulars` schema: `tubKey`, ID / OD, top / bottom MD), mapped by `WTS_wp_model` into `wts_wellperf_model` (owner Q17 on a shared per-well geometry record later) |
| Separator QC → ① | QC'd producing GOR, separator / stock-tank basis | "Use Separator QC GOR" when `WTS_state.sepqc` exists |
| ⑤ → Chokes hub | bean and THP | text only ("open Choke Performance") — no cross-page writes |
| ⑤ → simulator | THP, THT, rates at the operating point | "simulator inputs" rows to copy; the simulator workstream is separate and not edited |
| Build-up Surveillance → ② (B) | latest k·h, S, p* | `WTS_buildup.store.getTests(wellId)` (Promise, after the store's `init`); the import button awaits it and shows "no build-up result" when it resolves null |
| ⑤ → Gas Lift page (B) | IPR + deviated segments | the gas-lift page offers "Use Well Performance model" (its additive `ipr` / `segments` inputs) |
| Historian (C) | live THP / THT / bean → virtual rate | J4 |

### 2.11 Rules for parallel worktrees

- Each WP owns its files; only WP0 and the integrator edit the host and the sidebar test.
- Shared-engine edits are made only by the owner WP named in §2.3, each with its identity test in the same commit. All
  49-calc-flowline.js edits belong to WP0b, which merges before WP1 / WP3 / WP4; those WPs only supply objects (`pvt`, registry
  entries, `tAt`) to the options WP0b defines.
- Fixtures in `tests/_wellperf-shapes.js` are frozen after WP0 (changes go through the lead).
- **Naming rule**: method keys, labels, help text, code comments, test names and commit messages use author names or descriptive
  names only — never a commercial product, software vendor or company. `wellperf-names` (WP0) greps every wellperf file (engines,
  page, help, tests, validate tool) for a banned-name list kept in the test, and fails on a hit.

---

## 3. Interfaces (exact)

### 3.0 Rules common to every interface

- Field units in and out: psia for absolute pressures inside engines, psig at surface inputs (named `*_psig`), °F, ft, in for
  diameters and roughness, STB/d, BWPD, Mscf/d (gas rate inside VLP fluids follows the flowline convention MMscf/d — conversion in
  one helper `WTS_wp_fluid.flowlineFluid`), scf/STB, cp, md, 1/psi, lbm/ft³, dyn/cm.
- Each correlation function converts to the units its published equation needs **inside the function**, and the unit of every
  variable is written next to each equation in §4 (for example d in ft in the Griffith limit, d in inches in the gas equations).
- Every engine returns `{ok, errors[], warnings[], …}`; `warnings` carry `{code, msg, sev:'info'|'warn'}`. Messages are plain text,
  numbers through the same `fmt` hook as `WTS_oilipr_compute` so Metric pages show converted values.
- No engine throws for user data; programming errors throw.

### 3.1 Model `M` (read by `WTS_wp_model.read()`, a plain frozen object)

```js
M = {
  v: 1,
  fluid: { type: 'oil'|'gas'|'condensate'|'water'|'gasinj'|'waterinj', api, sgg, sggBasis: 'total'|'separator', psep_psig, tsep_F,
           gor /*scf/STB*/, cgr /*STB/MMscf*/, wgr /*STB/MMscf, gas wells*/, wc /*0..1*/, sgw, salinity_ppm, yN2, yCO2, yH2S /*mol %*/,
           pbUser /*optional*/, corr: { pb, rs, bo, muod, muo, muou, co, z, mug, sigma }, match: null /*B*/ },
  res:   { model, pr, T_F, pb, params: {...}, points: [{q, pwf}], layers: [] /*B*/, provenance: {...} },
  well:  { datum: 'RKB'|'GL'|'MSL', datumOffset_ft, survey: [[md, tvd]] | [[md, inc, azi]], perfTopMd, perfBotMd, midPerfMd,
           strings: [{kind: 'tubing'|'casing'|'liner', tubKey, id, od, wall, rough, topMd, botMd}],   // WTS_wellbore.column schema
           path: 'tubing'|'annulus',
           restrictions: [{kind: 'sssv'|'nipple'|'sleeve'|'xo'|'downholeChoke', md, id, k /*optional loss coefficient*/}],
           geo: { surfT_F, points: [[tvd, T_F]] },
           heat: { mode: 'linear'|'relax' /*A2*/, tht_F, U_to /*Btu/hr·ft²·°F, outside-tubing basis*/, tProd_d, ke, alpha } },
  surface: { choke: { present, bean64, corr: 'gilbert'|'ros'|'baxendell'|'achong'|'sachdeva' /*A2*/, cd },
             flowline: [{name, len, id, dz}], psep_psig, ambient_F,
             rating: { wellhead_psi, tht_max_F }, beans: [16, 20, 24, 32, 40, 48] },
  lift:  { type: 'none'|'gaslift' /*A2*/|'esp' /*B*/, gl: { packerMd, qinjList_Mscfd, sginj, pinj_psig, dpValve }, esp: null },
  system:{ node: 'bottom'|'wellhead'|'separator', mode: 'rate'|'pressure'|'max'|'design', target: {...},
           corr: { well, line } /*registry keys*/, mult: { hl: 1, f: 1 }, eroC: 100, stepFt: 100, refine: true },
  tests: [{ id, date, q_o, q_w, q_g, thp_psig, tht_F, bean64, gaugeMd, gauge_psia, chp_psig, qinj_Mscfd, use: true, note }],
  cases: [] /*B*/
}
```

### 3.2 `WTS_wp_fluid`

- `build(fluidSpec) → F = {ok, type, pvt /*object for WTS_flowline_props*/, at(p, T) → props, pb(T), table(pList, T), validity[]}`.
  `F.at` delegates to `WTS_flowline_props(flowlineFluid, p, T)` with `fluid.pvt` set — one fluid-property path for VLP and tables.
- Wet gas (`condensate`): `pvt.liquidNoTransfer = true`; free gas at the separator gas gravity; condensate volume = CGR × q_g × B_c
  with B_c constant (default 1.0); water = WGR × q_g. `recombine({sgSep, gorSep, apiST, cgr}) → {sgWell, gorTotal}` (Standing
  well-stream gravity) is used only for the reservoir m(p) table and the shut-in gas column (D14).
- `flowlineFluid(F, q) → {qo, qw, qg_MMscfd, api, sgg, sgw, pvt}`.

### 3.3 `WTS_wp_ipr`

- `models` — registry: `{key, label, kind:'oil'|'gas', needs:[...], curve(spec) → I}`; keys `pi`, `vogel`, `composite`, `fetkovich`,
  `jbgOil`, `darcyOil`, `backPressure`, `litP2`, `litMp`, `darcyGas` (A1); `wcComposite`, `joshi`, `babuOdeh`, `frac`, `multilayer`,
  `transient`, `injector` (B).
- `I = {ok, kind, pr, pb, aof, J, qAt(pwf), pwfAt(q), curve:[{q, pwf}], skin: SkinTable|null, warnings}`. `qAt` / `pwfAt` come from
  `WTS_oilipr_model` / `WTS_gasdeliv_model` for the delegated models (exact inverses within 1e-9 relative: closed form where it
  exists, else safeguarded Newton on the closed-form q(pwf)); `darcyOil` builds a J and calls `WTS_oilipr_model({mode:'composite',
  J, pb, pr})` below Pb; `darcyGas` / `litMp` build the m(p) relation locally (one closed form each, no duplicated model).
- `fit(kind, points, opts)` delegates: Vogel / composite / Fetkovich → `WTS_oilipr_compute`; C&n / LIT p² → `WTS_gasdeliv_compute`;
  LIT m(p) and JBG oil → `WTS_gasdeliv_fitAB` with Δ = m(p̄r) − m(pwf) or p̄r − pwf.
- `fromWell()` → spec from `PRiSM_getWell` / `PRiSM_getLastFit` / `PRiSM_gasDeliverability` with provenance (null pi kept null).
- `skin(spec) → SkinTable {parts:[{key, label, S, basis:'h'|'hp', source}], total, dpSkin(q), FE}` (§4.3).

### 3.4 `WTS_wp_vlp` and the correlation registry

- `WTS_flowline_corr[key] = {key, label, kind:'well'|'line'|'any'|'gas'|'single', range:{...}, verified: true|false,
  grad(inp) → G}`; `inp` is exactly the object `bb` takes (`vsl, vsg, d, rhoL, rhoG, muL, muG, sigma, theta, rough, p, payne, accel`)
  plus `props` and `mult`; `G` is the shape `bb` returns (`hl, lambdaL, pattern, rhoS, rhoN, grad, gradEl, gradF, gradAcc, Ek, vm, …`).
  `opt.corr` is always the key string (D3).
- `traverse(F, W, q, {from:'bottom'|'top', p0, corr, mult, tProfile, grid}) → {ok, profile:[{md, tvd, p, t, hl, pattern, vm, vsl, vsg,
  rhoS, gradEl, gradF, gradAcc, ero}], pEnd, lost, grid, segments, restrictionsDp, warnings}` — calls `WTS_flowline_march` with
  `W.segments`, `reverse` for a top-down march, `tAt`, `pMax` and `detail: true`.
- `curve(F, W, {qList, p0, corr, mult, coarse}) → [{q, pwf|null, lost}]`; `family(…, vary)` returns several curves.
- `gasDry(…)`: average T-Z (A1) and Cullender-Smith (A2), §4.4.

### 3.5 `WTS_wp_system`

- `solve(M, ctx?) → R = {ok, node, roots:[{q, p, stable, dDdq}], op /*the chosen stable root or null*/, qs:{q, p}|null /*static
  stability limit*/, vlpMin:{q, p}|null /*tubing-curve minimum*/, traverse, breakdown:[{key, dp}], surface:{thp, tht, thtHyd,
  pChokeDn, choke:{regime:'critical'|'subcritical-bound'|'subcritical', ratio}}, rates:{qo, qw, qg, qL}, velocities, flags[],
  discontinuities[], loading, warnings, evals}`.
- `designFor(M, target)` — `{bean: q}` or `{thp: q}` (A1), `{tubingId: q}`, `{qinj: q}` (A2); 1-D Brent on the design variable, warm
  started; a Job.
- `maxRate(M)` — rate at the lowest admissible THP (separator + flowline Δp, no choke).
- `shutIn(M) → {gasFilled, actualFluid, partLiquid:[{liquidTopMd, sithp}], rating:{verdict, margin}}` (§4.14).
- `beanSchedule(M, beans) → [{bean, q, thp, tht, dpChoke, regime, stable, loadingMargin}]` (§4.14); a Job.
- `WTS_wp_loading(R, F, W) → {method, suggested, qc_MMscfd, limitingMd, margin, perDepth:[{md, vg, vc, qc}]}`.
- `WTS_wp_check(M) → {errors, warnings}` — the A4 consistency checks and correlation ranges (Appendix A).

### 3.6 `WTS_wp_sens`

- `matrix(vars) → cases[]` (full factorial; `vars = [{key, values[]}]`, 1 variable in A1, ≤ 2 in A2, ≤ 4 in B, ≤ 1,000 cases).
- `job(M, vars) → Job` for `PRiSM_autoInterp.drive` (`step()` solves one case; `result()` → `{cases:[{values, R-summary}], table}`).
- `csv(result)`.

### 3.7 `WTS_wp_match`, `WTS_wp_qc`

- `compare(M, test, corrKeys) → [{corr, pCalc, err, errPct, rank, verified}]` (gauge pressure at gauge MD; full survey RMS in B).
- A2: `tune(M, tests, corr, {free:['hl'] | ['hl','f'], bounds}) → {mult, residuals, flags, corrMatrix, lm}` via `PRiSM_lm`.
- `iprFromTest(M, test, solveFor:'pr'|'J'|'S') → {value, pwf, method}` — pwf marched down from the gauge (or from the THP when no gauge).
- `WTS_wp_qc(M, tests) → [{id, flags:[{code, sev, msg}], score}]` (§5.4).

### 3.8 `WTS_wp_gl` (A2: quick look)

- `glpc(M, {qinjList}) → {points:[{qinj, qL, pwf, thp, injMd}], optimum:{qinj, qL}, economic:{qinj, qL, slope}, stable[]}` — injection
  depth solved inside each point (§7.1).
- `quickLook(M)` → GLPC, the rate gain vs natural flow and the gas needed for 90 % of the maximum.

### 3.9 Lift tables (B) — `WTS_wp_export`, §9

### 3.10 Events and state

- `document` events: `wts:wellperf-model-changed` (detail `{keys}`) after a model write; `wts:wellperf-solved` (detail `{ok}`) after a
  solve. The page listens to `wts:well-changed` and `wts:project-loaded` and re-reads the model. Listeners only; no polling.
- Restore: registry `hooks: {silent: true, after}` (§2.6).
- `WTS_state.wellperf` as §2.8. Unit-system change: `wts:unit-system-changed` → re-render results (calc stays canonical).

### 3.11 Storage keys and project files

| Key | Scope | Content |
|---|---|---|
| `wts_page_wellperf` | per well (host autosave) | scalar controls |
| `wts_wellperf_model` | per well | `{v:1, survey, strings, restrictions, geo, flowline, rating, beans, tests, lab /*B*/, pump /*B*/, cases /*B*/}` |
| `wtspref_wp_step` | device | active step |
| `wtspref_wp_plots` | device | plot toggles |

Project files carry the two `wts_*` keys through the existing `storage` module; no new `WTS_project` module.

### 3.12 Contract fixtures (`tests/_wellperf-shapes.js`, WP0, frozen)

- `FIX.oilWell` — vertical 8,000 ft oil well, 2-7/8" tubing, 35 °API, GOR 500, WC 30 %, p̄r 3,000 psia, PI 2 STB/d/psi, separator
  100 psig, flowline 2,000 ft × 3", bean 32/64.
- `FIX.gasWell` — 10,000 ft deviated wet-gas well (S-shaped survey), 3-1/2" × 2-7/8" tapered, separator sg 0.65, CGR 20 STB/MMscf,
  WGR 2 STB/MMscf, LIT a / b.
- `FIX.devSurvey` — MD / inclination / azimuth set with a known minimum-curvature answer.
- `FIX.fallingBranch` — an oil well whose operating point sits left of the tubing-curve minimum but right of q_s (stable root on the
  falling VLP branch).
- `FIX.test1` — one test on `FIX.oilWell` (q, THP, THT, gauge).
- `FIX.dfitGeometry` — a minimal `WTS_state.dfit` test record with survey and strings.
- Shapes: `SHAPE.R`, `SHAPE.I`, `SHAPE.G` (correlation result), `SHAPE.SkinTable`, `SHAPE.Job`, `SHAPE.M`.
- `sharedApp()`, `resetWellPerf(app)` helpers as in `_dfit-shapes.js`.

---

## 4. Engines and algorithms

### 4.1 PVT (WP1; more families WP13 in A2)

- **Oil, A1:** Pb, Rs(p), Bo(p) by Standing (existing); above Pb Bo = Bob·exp(co·(pb − p)) with co by Vasquez-Beggs (existing), Rs =
  Rsb; dead-oil viscosity Beggs-Robinson, live Beggs-Robinson, undersaturated Vasquez-Beggs (all existing); σ_og Baker-Swerdloff
  (in flowline). **A2** adds Vasquez-Beggs Pb / Rs / Bo (with the separator-gravity normalisation to 100 psig), Glasø,
  Petrosky-Farshad, Egbogah, Bergman-Sutton, Chew-Connally, Abdul-Majeed σ.
- **Pb vs GOR:** the producing GOR caps Rs (today's `min(gor, Rs)`); when `pbUser` is given the correlation's Pb is shifted to match
  (one-point match).
- **Gas:** `WTS_gaspvt_z` (DAK with impurities, mol %), `WTS_gaspvt_pseudoCriticals` (Sutton + Wichert-Aziz), `WTS_gaspvt_viscosity`
  (Lee-Gonzalez-Eakin + impurity correction). Hall-Yarborough selectable.
- **Water:** Meehan Bw / μw (existing); McCain density from salinity and gas solubility in A2.
- **Gas-condensate (A1 / A2) = wet gas (D14):** free gas at the **separator** gas gravity; condensate carried as a liquid with constant
  volume per standard volume (B_c, default 1) and **no mass transfer** (Rs = 0 for the condensate phase, so no reverse-retrograde
  shrinkage); condensate density from its API; water from WGR. Standing's oil correlations are not used for the condensate (a 50+ °API
  liquid at GOR 20,000–100,000 scf/STB is far outside their range). The recombined well-stream gravity is used only in the inflow
  (reservoir gas m(p) table above the dew point) and the shut-in gas column — never together with a separate liquid in the march, so
  the condensate mass is counted once. Gray and the loading check use the separator gas plus the condensate and water ratios. Modified
  black oil (Rv) is B.
- **Validity:** each correlation carries its published data range (Appendix A); `WTS_wp_check` warns when inputs fall outside.
- **Mass balance:** total mass flow is equal at the top and bottom of every traverse within 1e-9 relative (test).

### 4.2 Inflow (WP2)

Units: q STB/d (oil) or Mscf/d (gas), p psia, k md, h ft, μ cp, T °R in gas equations, rw / re ft.

- PI: q = J (p̄r − pwf).
- Vogel: q / qmax = 1 − 0.2 x − 0.8 x², x = pwf / p̄r; Standing FE extension — `WTS_oilipr_model`.
- Composite: q = J (p̄r − pwf) for pwf ≥ pb; q = qb + (J pb / 1.8) [1 − 0.2 (pwf/pb) − 0.8 (pwf/pb)²] below — `WTS_oilipr_model`.
- Fetkovich: q = C (p̄r² − pwf²)ⁿ — `WTS_oilipr_model`.
- Jones-Blount-Glaze (oil): p̄r − pwf = A q + B q²; fitted by `WTS_gasdeliv_fitAB`; q(pwf) by the positive root.
- Darcy oil, reference pressure stated per form:
  pseudo-steady with **p̄r**: J = k h / (141.2 Bo μo [ln(re/rw) − 0.75 + S]) (general area: ½ ln(10.06 A / (C_A rw²)) − 0.75, circular
  C_A = 31.62); steady state with **p̄r**: ln(re/rw) − 0.5 + S; steady state with **p_e** (pressure at re): ln(re/rw) + S. Below Pb the
  composite form with this J (`WTS_oilipr_model`).
- Gas back-pressure and LIT p² — `WTS_gasdeliv_model`.
- LIT m(p): m(p̄r) − m(pwf) = a q + b q² with `PRiSM_mpTable` for m(p) (psi²/cp).
- Darcy gas with non-Darcy (pseudo-steady, p̄r): m(p̄r) − m(pwf) = 1422 T q / (k h) [ln(re/rw) − 0.75 + S + D q] (q Mscf/d, T °R);
  p² form with μ̄ z̄ at the mean pressure as a selectable approximation.
  D estimate: D = 2.222e-15 β k γg / (μg(pwf) h_p rw) in d/Mscf, with **β = 4.85e4 / (φ^5.5 √k) in 1/ft** (Geertsma 1974 field form,
  k md, φ fraction), μg cp, h_p and rw ft — both coefficients "to verify" in WP2 against two textbook examples; shown as an estimate.
- Future IPR: the existing oilipr rule (Vogel cube rule / Fetkovich ratio); for PI and Darcy, p̄r change only (J held) with a note.

Increment B: water-cut-weighted composite three-phase IPR (oil Vogel + water PI, `wcComposite`); Joshi, Babu-Odeh (with
partial-penetration terms), Furui; Prats r_w′ = x_f / 2 and the Cinco-Ley-Samaniego-Dominguez F_cD → s_f curve (closed-form fit,
0.1 ≤ F_cD ≤ 1,000); transient IPR from the line-source log approximation at a flowing time (reusing PRiSM C3 parameters); multilayer
commingled IPR with crossflow reported; injector index with a fracture-pressure limit (DFIT closure / ISIP from `WTS_state.dfit`).

### 4.3 Skin (WP2)

Near-well terms defined on the open (perforated) interval h_p are computed with h_p wherever their formula takes a thickness and are
then referred to the full h by the factor h / h_p:

S_t = S_pp + S_θ + S_f + (h / h_p)·(S_d + S_perf + S_dp + S_gp) (+ D q, rate-dependent)

| Part | Method | Basis | Source |
|---|---|---|---|
| Partial penetration | Brons-Marting | h (full) | `PRiSM_skinDecomposition` |
| Deviation | Cinco-Ley-Miller-Ramey | h | `PRiSM_skinDecomposition` |
| Fracture | from x_f (B: F_cD curve) | h | `PRiSM_skinDecomposition` |
| Damage | Hawkins S_d = (k / k_s − 1) ln(r_s / r_w) | h_p | new (one line) |
| Perforation | Karakas-Tariq — **disabled while UNVERIFIED**; user-entered S_perf | h_p | `PRiSM_skinCheck.perforationSkin` returns UNVERIFIED |
| Crushed zone | McLeod S_dp = (h_p / (L_p n)) (k / k_dp − k / k_d) ln(r_dp / r_p) | h_p | new |
| Gravel pack (cased, tunnels) | S_gp = 8 k h_p L_g / (k_g n d_p²) in consistent units; field form **S_gp = 96 k h_p L_g / (k_g n d_p²)** with h_p in ft and L_g, d_p in inches; n = total number of open perforations | h_p | new; one textbook example pinned in wellperf-skin |
| Non-Darcy | D q | h | `PRiSM_rateDependentSkin` |

Δp_skin = 141.2 q B μ S_t / (k h); FE = (p̄r − pwf − Δp_skin) / (p̄r − pwf) — both from `PRiSM_skinCheck.products`. The skin table is
a `.dtable` plus a bar chart. Known limitation: damage and perforations combine non-additively when the perforations end inside the
damaged zone (and Hawkins with a crushed zone); the module sums them and says so (§21).

### 4.4 Vertical lift correlations (WP3 A1; WP12 A2; WP21 B)

All correlations return the `bb` result shape so the marcher, the profile, the erosion check and the breakdown work unchanged.

| Key | Correlation | Inc. | Notes (units next to each equation) |
|---|---|---|---|
| `bb` | Beggs & Brill (1973) with Payne corrections | existing | revised form already in the code |
| `hb` | Hagedorn & Brown, modified | A1 | Griffith bubble flow when λ_g < L_B = 1.071 − 0.2218 v_m² / d, **v_m in ft/s, d in ft** (L_B ≥ 0.13); holdup ≥ λ_L; holdup charts as published curve fits (CN_L, H_L/ψ, ψ); friction on the no-slip Reynolds number |
| `gray` | Gray (gas / condensate wells) | A1 | holdup from N_v, N_D, R; effective roughness from σ / (ρ_n v_m²); range condensate ≤ 50 bbl/MMscf, water ≤ 5 bbl/MMscf, v_m < 50 ft/s, d ≤ 3.5 in (warn outside, both liquid ratios checked) |
| `nsl` | homogeneous no-slip | A1 | lower bound, holdup = λ_L |
| `gasTZ` | dry gas, average T and Z | A1 | p_wf² = e^s p_wh² + 25 γ T̄ Z̄ f MD q² (e^s − 1) / (s d⁵), s = 0.0375 γ TVD / (T̄ Z̄), iterated on Z̄; **p psia, q MMscf/d, T̄ °R, d in, f Moody, MD / TVD ft** (coefficients to verify); gas-only fast path |
| `single` | single phase Darcy-Weisbach, Colebrook (existing `WTS_flowline_friction`) | A1 | water injectors, dead oil |
| `dr` | Duns & Ros | A2 | regions I–III + transition by N_gv vs N_Lv; slip velocity per region; mist friction with the film-roughness rule |
| `gasCS` | Cullender-Smith | A2 | ∫ (p/TZ) / [F² + (p/TZ)² (TVD/MD) / 1000] dp = 18.75 γ MD, F² = 0.667 f q² / d⁵; **q MMscf/d, d in, T °R, f Moody**; two-step Simpson; cross-check of `gasTZ` and of the marcher with gas only |
| `ork`, `agf`, `mb`, `ansari`, `hk` | Orkiszewski, Aziz-Govier-Fogarasi, Mukherjee-Brill, Ansari et al., Hasan-Kabir | B | |

Each entry carries its range (rates, GLR / liquid ratios, d, inclination), a "vertical only" flag and `verified` (§15.1, D17). The page
warns when a vertical-only correlation runs in a section above 30° from vertical and offers Beggs & Brill there (per-section choice is
B). Published holdup chart fits are taken from textbook curve fits; the WP records the source table in a code comment and pins three
chart readings per curve as tests. Every regime boundary has a test with known numbers (HB bubble limit in A1, DR regions in A2).

### 4.5 Marching numerics (WP0b options, inside the existing marcher)

- Integrate dp/dL = −(gradEl + gradF + gradAcc) along the segment list (existing step: predictor at (P, T), three fixed-point passes
  at the mid pressure and temperature, convergence early-out when `refine`).
- Step length: `stepFt` (default 100 ft for wells, 50 ft for lines), clamped to 10–400 steps per segment; `refine` splits a step whose
  Δp exceeds 3 % of p (≤ 200 sub-steps).
- **Frozen grid (smoothness).** With `refine` on, the number of sub-steps depends on q, which makes p_out(q) piecewise discontinuous
  at the 1e-3–1e-1 psi level. Within one solve or curve the sub-step layout is chosen once at a reference rate (the scan's mid rate)
  and passed as `opt.grid` to every later march; derivative, minimum and Brent evaluations always use the frozen grid. With the frozen
  grid a warm start and a cold start give equal results (§6.3). Test: second differences of p_out(q) on the fixtures below 0.01 psi.
- Coarse and fine: the scan uses `stepFt` × 2 (coarse), Brent and the reported traverse use the fine steps.
- Convergence test (WC1) halves the step until BHP changes < 0.1 psi and fixes the default where 0.5 psi is met for every fixture.
- Direction: top-down (`reverse`) from THP; bottom-up from pwf for "THP available". Both agree within 0.5 psi on the fixtures (WM3).
- Failure: `lost.reason` `pressure` (p < atmospheric), `critical` (Ek ≥ 0.95), `high` (above `pMax`). A lost march returns `null`.
- Restrictions: Δp_r = K ρ_n v_m² / (2 g_c 144) (ρ_n lbm/ft³, v_m ft/s → psi) with K from sudden contraction / expansion (β = d_r / d);
  B adds Perkins / Sachdeva for downhole chokes.
- Annulus flow: hydraulic diameter d_h = D_c,i − d_t,o for friction, flow area for velocities (an `area` override on the segment).
- Speed: the `fluid.pvt.table` option bins properties on a (p, T) grid (5 psi × 2 °F, linear interpolation, built once per solve),
  so DAK Z and the oil correlations are not re-evaluated three times per step. It is used only when its interpolation error on the
  fixtures is below 0.05 % in BHP (test).

### 4.6 Temperature (A1 WP4; A2 WP14)

- **Linear (A1, existing):** THT → BHT along MD. THT is user-entered (measured or estimated).
- **Hydrate THT (A1):** for gas / condensate wells, when THT is not a measured value, the THT used in the hydrate check is
  THT_hyd = THT − μ_JT · Δp_tubing (μ_JT from `WTS_gaspvt_isenthalpic` at the mean tubing conditions); otherwise the verdict reads
  "upper-bound THT, not conservative". The choke-downstream temperature stays on the existing isenthalpic path.
- **Flowing relaxation (A2): `WTS_wellbore.flowingTemp(column, {w, cp, U_to, r_to, ke, alpha, rwb, t_hr, direction:
  'produce'|'inject', Tin})`.** Sign convention: z = length along the hole measured **upward from the mid-perforations** (production;
  downward from the wellhead for injection), θ = inclination from horizontal (sinθ = 1 vertical), g_G > 0 the geothermal gradient in
  °F/ft of vertical depth, T_ei(z) = T_ebh − g_G z sinθ. Producing steady solution (Ramey 1962; Hasan-Kabir 1994):
  **T_f(z) = T_ei(z) + (T_bh − T_ebh) e^(−z/A) + g_G A sinθ (1 − e^(−z/A))**,
  so the produced fluid is warmer than the earth by g_G A sinθ at large z.
  A = (w c_p / (2π)) · (k_e + r_to U_to f(t_D)) / (r_to U_to k_e) with **U on the outside-tubing-radius basis** (r_to·U_to as published;
  a U given on the inside radius is converted by U_to = U_ti r_ti / r_to), w lbm/hr, c_p Btu/lbm·°F, k_e Btu/hr·ft·°F, r_to ft → A in ft.
  f(t_D) = 1.1281 √t_D (1 − 0.3 √t_D) for t_D ≤ 1.5, (0.4063 + 0.5 ln t_D)(1 + 0.6 / t_D) otherwise, t_D = α t / r_wb².
  Mixture c_p from oil / water / gas mass fractions (gas c_p from `WTS_gaspvt_state`); piecewise geotherm section by section.
  Defaults: U_to 2 Btu/hr·ft²·°F, producing time 30 d, k_e 1.4 Btu/hr·ft·°F, α 0.04 ft²/hr — all editable. Decoupled from pressure
  (per rate, before the march, passed as `tAt`). The J-T hydrate correction above applies to it too. U fitted to a measured THT by
  1-D Brent (A2, §5.2). `direction:'inject'` is provided for DFIT 3.4b to call if it chooses (owner Q16); `_ramey` is not touched.
  Tests: THT above the surface geotherm for production; T_f − T_ei → g_G A sinθ at large z; reference profile.
- **B:** enthalpy balance with Joule-Thomson and kinetic terms (Alves et al. unified form) per step; layered U.

### 4.7 Restrictions and chokes (A1 WP5; A2 WP15)

- Critical multiphase (A1): Gilbert, Ros, Baxendell, Achong — existing `WTS_chokeperf_multiphaseRate`, q = p1 S^b / (a GLR^c).
- Gas: `WTS_chokeperf_gasRate` (isentropic nozzle, Cd, critical and sub-critical) directly. Liquid (A2): Cv law.
- **Choke node, A1 (continuous bound):** for a rate q, p2 = choke outlet pressure from the flowline march back from the separator;
  p1(q) = max(p1_crit(q), p2 / y_c) with y_c the critical ratio of the chosen correlation (`GILBERT_CRIT` for the Gilbert family).
  The max of two continuous functions is continuous, so p_out(q) has no jump. When the second term governs, the regime is
  `subcritical-bound` and the flag reads "sub-critical — the critical correlation does not apply; the rate shown is a conservative bound".
- **Choke node, A2 (Sachdeva et al. 1986):** one continuous model on both sides — critical ratio y_c from the published implicit
  equation (fixed point, ≤ 30 iterations), the sub-critical mass rate for y > y_c and the critical rate at y_c, same Cd (default 0.75,
  to verify); optional rate factor tuned so that Sachdeva equals the user's empirical correlation at the critical point.
- **Discontinuity detection (solver, A1):** after Brent, a sign change whose |Δ| stays above the tolerance at both bracket ends is
  reported as a `discontinuity` (with q and the jump), never as a root.
- Test: p_out(q) is continuous across the regime change (|jump| < 0.1 psi at y_c in both A1 and A2).

### 4.8 Surface (WP5)

Flowline: `WTS_flowline_march(reverse: true)` from the separator to the choke outlet with the line correlation (Beggs & Brill default);
line temperature from the choke-outlet temperature with the line-heat coupled mode where available (existing). Separator: fixed pressure.

### 4.9 Operating point (WP5)

Bottom-hole node (default): p_in(q) = IPR pwfAt(q); p_out(q) = VLP pwf for q with the top boundary condition (THP fixed, or choke +
flowline + separator). Δ(q) = p_out − p_in.

1. **Scan on a cached coarse curve:** the VLP (and the surface Δp) is computed once on a 12-point coarse grid between 0.5 % and 99.5 %
   of AOF (log-spaced below 10 % AOF, linear above), with the coarse step and the frozen grid; Δ is interpolated (monotone cubic)
   between the points. Lost marches mark "cannot lift".
2. Every sign change → Brent with fine marches (bracketed, |Δ| < 0.1 psi or Δq < 1e-4 q, typically ≤ 8 evaluations, cap 20).
3. dΔ/dq at each root by central difference at ±1 % q on the frozen grid (2 fine evaluations).
4. Tangency (Δ minimum near 0 without a sign change): reported as "marginal".
5. The chosen operating point = the stable root with the highest rate; all roots listed.

Wellhead node: p_in = THP available from a bottom-up march at pwf(q); p_out = THP required by choke + flowline. Separator node likewise.
The node choice changes only the plot and the breakdown, not the answer (WS4: within 0.5 % in q).

Design modes (Jobs): `designFor` wraps `solve` in a 1-D Brent on the design variable (bean 8–128/64, THP; A2: tubing ID from the
catalogue as a discrete scan, lift gas). Maximum rate: THP at the lowest admissible value (separator + flowline Δp, no choke).

### 4.10 Stability (WP5)

- **Static criterion:** a root is stable when dΔ/dq = dp_VLP/dq − dp_IPR/dq > 0. The IPR slope is negative (−1/J for a straight line),
  so a root on the falling branch of the VLP is still stable while the VLP slope is above the IPR slope.
- **Static stability limit q_s:** the rate where dΔ/dq = 0 for the current IPR and boundary condition, found by a 1-D search on dΔ/dq
  (bracketed on the coarse curve, polished by Brent on fine central differences). Only q < q_s is shaded "statically unstable".
- **Tubing-curve minimum:** the VLP minimum (dp_out/dq = 0), from a parabolic fit on the coarse curve (a golden-section refinement on
  fine marches only when asked), reported separately as "minimum of the tubing curve — conventional, more conservative rule". It lies
  right of q_s.
- **Heading flag:** ⚠ when the operating point is within 10 % above q_s (static limit). An info note says when the operating point is
  left of the tubing-curve minimum (conventional rule) while statically stable.
- Test: `FIX.fallingBranch` — the root on the falling VLP branch is reported stable, inside the conventional-rule note, outside the
  shading; the stable / unstable label of each root always agrees with the shading.
- Gas-lifted wells (B): Asheim criteria. The static criterion does not predict heading dynamics (§21).

### 4.11 Liquid loading (WP5)

- Turner et al. (with the 20 % uplift): v_c = 1.912 σ^¼ (ρ_L − ρ_g)^¼ / ρ_g^½ (v_c ft/s, σ dyn/cm, ρ lbm/ft³); Coleman et al.:
  coefficient 1.593 (no uplift); Li et al. (flat droplet): 0.7241. Nosseir and Guo in B.
- Liquid density: water when the well makes water, else condensate; σ from 16-pvt / flowline functions.
- q_c (MMscf/d) = 3.067 p v_c A / ((T + 460) z) (p psia, v_c ft/s, A ft², T °F) at **every** traverse node; for a constant ID q_c varies
  as √p / (T z) and often rises with depth, so the bottom or the top of a larger liner can control. The reported limiting point is
  wherever the maximum of q_c falls; margin = q_op / q_c,max − 1.
- **Decision (review 2026-11-12):** the verdict is the maximum over the nodes from the wellhead to the **tubing shoe** (a node takes the
  conduit above it, so the shoe node carries the tubing ID). The casing / liner section between the tubing shoe and the mid-perforations
  is reported apart as an information line ("liquid may accumulate below the end of tubing; q_c in the liner …", `loading.belowEot`):
  conventional practice does not treat that short rathole as killing the well. The strict reading above (every node, the rathole
  included) is the option `M.system.loadingRathole: true`.
- Method suggestion (ranges to verify): Coleman for flowing wellhead pressure below about 500 psia (its data), Turner for higher
  wellhead pressures (its data mostly above about 1,000 psia); in between both are shown.
- Shown on the system plot and as a ✓ / ⚠ / ✗ verdict with recommendations (smaller string ID that would unload — A2 `designFor`
  tubing; foamer; lift).

### 4.12 Erosion and flow-assurance flags (WP5)

- API RP 14E V_e = C / √ρ_m (V_e ft/s, ρ_m lbm/ft³) with C user-set (default 100, owner Q12) through `eroC`.
- Hydrate: wellhead (THT_hyd, §4.6) and choke-downstream temperature vs `WTS_hydrate_temp(p, sg)`; margin shown.
- Wax / asphaltene: B. Sand erosion screen: B via 27-pipelife.

### 4.13 Validation checks `WTS_wp_check` (WP5)

Survey MD strictly increasing, TVD ≤ MD, inclination 0–180°; string IDs ≤ casing ID; restrictions inside the string; mid-perf within
the survey; WC 0–1; p̄r present (✗ when missing — never defaulted); **p̄r < Pb → saturated reservoir: Vogel / composite inflow below
Pb; warn if a straight-line PI is chosen**; THP < p̄r; test pwf < p̄r; rate < AOF; GOR ≥ Rsb at p̄r for saturated oil **only when the
bubble point is independent of the producing GOR (pbUser or a lab table), else "not applicable"**; correlation ranges (Appendix A,
Gray condensate and water ratios both). Each check has a code, a field id (focus link) and plain text.

### 4.14 Shut-in and surface-rating outputs (WP5, A1)

- `shutIn(M)`: SITHP for (a) a gas-filled column from p̄r (worst case; well-stream gas gravity, Z via `WTS_gaspvt_z`, integrated
  with the gas column of `WTS_gradient_compute`), (b) the actual fluid column (static liquid / gas segregation at the producing GOR
  and WC), (c) a partly liquid-filled column for a list of liquid levels; ✓ / ⚠ / ✗ against `rating.wellhead_psi` (⚠ within 10 %).
- Maximum flowing THT: the THT at the maximum rate (maxRate) with the temperature model, against `rating.tht_max_F`.
- `beanSchedule(M, beans)`: one solve per bean in the user list (warm-started Job): rate, THP, THT, ΔP across the choke, regime,
  stability, loading margin; plotted and tabled.
- Tests: SITHP gas column vs `WTS_gradient_compute` (0.2 %); liquid column vs 0.433·SG·TVD (0.01 %); schedule monotone in bean on
  `FIX.oilWell`.

---

## 5. Matching and QC (WP7 A1; WP17 A2)

### 5.1 PVT match (B)

Two parameters per property (multiplier a and shift b: y_matched = a y_corr + b) fitted by `PRiSM_lm` to the lab points; ranking of
the correlations by mean absolute relative error; differential-liberation to flash correction when the lab basis is differential.
A1 has only the one-point Pb shift (§4.1).

### 5.2 VLP correlation comparison (A1) and tuning (A2)

- `compare` (A1): for each test, run each registered well correlation top-down from THP (or bottom-up from the gauge) and compute the
  pressure error at the gauge depth; rank by absolute error, RMS over tests; unverified correlations carry their "provisional" label.
- `tune` (A2): holdup multiplier m_h with H_L' = clamp(m_h·H_L, λ_L, 1) (bounded 0.8–1.25) and friction multiplier m_f (0.7–1.5),
  applied inside the march with ρ_s, slip viscosity, gradEl, gradF and grad = (gradEl + gradF) / (1 − Ek) rebuilt (WP0b option).
  With gauge pressures at one depth m_h and m_f are close to collinear, so only m_h is fitted unless the tests span at least 2:1 in
  rate; the LM parameter correlation matrix is reported, and |ρ| > 0.9 shows "the two multipliers cannot be separated with these tests".
  Flags when a multiplier leaves 0.9–1.1. U fitted to a measured THT (1-D Brent) in the relaxation mode.

### 5.3 IPR from a test (A1)

With the chosen (A2: tuned) VLP: pwf at mid-perf from the gauge (marched down from the gauge depth) or from the THP; then one of p̄r
(J held), J (p̄r held) or S (k·h held, Darcy) solved in closed form; adoptable into step ② with provenance "matched to test <id>".

### 5.4 Production-test QC (A1), `WTS_wp_qc`

| Code | Check |
|---|---|
| QC_BHP_GT_PR | gauge / back-calculated pwf ≥ p̄r |
| QC_Q_GT_AOF | rate above the model AOF |
| QC_GOR_LT_RSB | producing GOR below Rsb for a saturated oil — **only when pbUser or a lab table is given** (a correlation Pb from the producing GOR makes Rsb = GOR by construction); else "not applicable" |
| QC_CHOKE | measured rate vs choke-model rate at the measured THP / bean differs by > 20 % (critical), or the choke is sub-critical and a critical correlation was used |
| QC_THT | THT above BHT, or (A2) more than 20 °F from the relaxation estimate with the matched U range |
| QC_VLP | gauge error of the best correlation > 5 % (A2: after tuning) |
| QC_WC | water cut outside 0–1 or jumping > 20 points between consecutive tests |
| QC_SEP | GOR basis inconsistent with Separator QC (when present) |

Score = 100 − Σ penalties; tests ranked; the match uses only tests with `use: true`.

---

## 6. Sensitivity engine (WP6 A1; WP16 A2)

### 6.1 Variables

p̄r, WC, GOR / GLR, THP or separator pressure, tubing ID (catalogue keys), skin, k·h, bean, lift-gas rate (A2), injection depth (B),
ESP frequency (B), U (A2), layer pressure (B). Each variable maps to a path in `M` and a validity range.

### 6.2 Outputs

- Families: one VLP per value (outflow variables) or one IPR per value (inflow variables), with the operating point of each.
- Rate-vs-variable plot and table (q_o, q_w, q_g, pwf, THP, THT, stable, loading margin).
- A2: two variables (one line per value of the second); B: up to four (≤ 1,000 cases), tornado.

### 6.3 Numerics

Each case is a `solve` warm-started from the neighbouring case's root (scan skipped when the previous root brackets within ±30 %),
on the frozen grid of the base case, so a warm start equals a cold start (test).

### 6.4 Jobs

Sensitivity, GLPC, design modes and the bean schedule always run as Jobs through `PRiSM_autoInterp.drive`, on a button press, with a
progress bar and Cancel (cancel within one case; results discarded). No new timer user.

---

## 7. Artificial lift

### 7.1 Gas-lift quick look (A2, WP18)

- **Depth solved per point.** For each q_inj the rate and the injection depth are solved together: depth = the shallower of the packer
  depth and the depth where p_casing(z) − ΔP_valve = p_tubing(z), with p_casing from `WTS_gaslift_casingP` (static gas column, DAK) and
  p_tubing from the bottom-up march at pwf(q); the outer loop is the system solve on q, the inner a 1-D search on the depth.
- **Injected gas as free gas only:** above the injection point the free-gas rate is the formation free gas plus q_inj (WP0b option
  `fluid.pvt.injGas`); Rs and Bo stay those of the formation gas; the mixture gas gravity is used only for the free-gas density and Z.
  Below the point, formation gas only.
- GLPC: q_L vs q_inj on a 12-point grid 0–5 MMscf/d (user range), a Job; optimum = maximum q_L; economic point where dq_L / dq_inj = the
  user's incremental gas-oil ratio limit (default 0 = maximum).
- Stability: a point is flagged when its root is unstable; the Asheim check is B. Test: q_inj = 0 equals natural flow exactly.

### 7.2 Gas-lift design and diagnostics (B, WP25)

`WTS_gaslift_compute` gains the shared IPR and deviated segments (additive, §2.3) and is driven from step ④; valve throughput by
Thornhill-Craver with the critical ratio cap; diagnostics from CHP, THP, gas and liquid rates: valve status by depth, operating valve,
multi-pointing and under- / over-injection flags; flowing gradient survey overlay (J3).

### 7.3 ESP (B, WP26)

Pump curve table (rate, head per stage, efficiency, BHP per stage at 60 Hz); affinity laws (q ∝ f, H ∝ f², P ∝ f³); stages = TDH /
head per stage; viscosity correction (Turzo et al. 2000 fit of the standard centrifugal-pump charts); free gas at intake and natural
separation (Alhanati) with a gas-handling flag (Turpin criterion); motor load, cable voltage drop (through the electrical engines where
exported, else a note); operating range and thrust flags. In the system the pump is a node Δp(q) between intake and discharge segments.

### 7.4 Lift screening (B) and later lifts (C)

Screening matrix plus the rate under natural flow, gas lift and ESP at the same conditions. Rod pump (API RP 11L), PCP, jet pump,
plunger and intermittent lift are increment C.

---

## 8. Prediction (B, WP27)

Depletion steps: a list of future p̄r (optionally with WC and GOR per step) → operating point per step, onset of loading and the step
where lift is needed. With a tank model (gas p/Z linear; oil simple depletion with the Havlena-Odeh straight line from user N and drive)
rate vs time and cumulative by explicit stepping. Decline and EUR cross-check against 35-rta-dca where a dataset exists.

---

## 9. Lift-curve table export (B, WP20)

- Table axes: rate (oil, liquid or gas basis), THP, water fraction (WC or WGR), gas fraction (GOR, GLR or OGR), artificial-lift
  quantity (lift-gas rate, ESP frequency or none); value = BHP at the table datum depth. Each point is one top-down traverse.
- Formats:
  1. the **lift-curve table text format (producer / injector)**: table number, datum depth, the axis records, then one BHP record per
     axis combination, field-units header; the record layout is fixed in `WTS_wp_export` and checked by a round-trip parser test.
     Keyword tokens appear only as literal format strings in code and tests, never next to a simulator or vendor name; help, comments
     and test names say "lift-curve table text format". Owner Q4 confirms the formats;
  2. CSV long format (one row per point: rate, THP, WFR, GFR, ALQ, BHP, flags).
- Points that cannot flow are filled by **monotone extrapolation along the rate axis** (or the rate axis is truncated per THP when the
  format allows it); every filled point is listed in the export notes. BHP is monotone along the rate and THP axes; the export test
  checks monotonicity on every row and column.
- Run as a Job (§6.4); 10 × 5 × 4 × 4 × 4 = 3,200 traverses within the §16 budget.
- PVT table export (B9): Rs, Bo, μo, Bg, μg, Z vs p at the reservoir temperature in CSV.

---

## 10. UI (per step)

General: step strip at the top (`.rp-skip`); each step = an inputs card and a results card; the compact report block (summary ribbon,
system plot, verdicts) stays visible at the top of every step once a solve exists.

| Step | Inputs card | Results card |
|---|---|---|
| ① Fluid | fluid type; API, sg gas (+ basis, separator p / T), GOR or CGR + WGR, WC, sg water / salinity, N₂ / CO₂ / H₂S; correlation selectors; optional Pb; "Use Separator QC GOR" | PVT table at 6 pressures; fluid-property plot; validity verdicts |
| ② Reservoir | inflow model; p̄r, T, Pb; model parameters (J / test points / k, h, re or area + C_A, rw, S parts / C, n / a, b / D); "Import from PRiSM"; future p̄r | IPR plot, AOF, PI, fit quality, skin table and bar chart, provenance chips |
| ③ Well | datum; survey table (paste CSV); strings table (catalogue picker from `WTS_tubulars`, roughness); restrictions; mid-perf; geotherm points; temperature model, THT (measured / estimated); flow path; "Import well geometry from a DFIT test" | survey plot; segment table; temperature profile; checks |
| ④ Lift | lift type; (A2) gas-lift quick look: injection pressure, gas gravity, ΔP valve, packer depth, gas range; (B) design, ESP | (A2) GLPC, optimum, rate gain, injection depth per point; (B) valve table, pump curve |
| ⑤ System | node; mode; THP or choke + flowline + separator; correlations (well, line); multipliers (read-only unless adopted); erosional C; equipment ratings and bean list; sensitivity variable and values; buttons Solve design, Bean schedule, Run sensitivity, Export CSV | operating point table, roots and stability (q_s, tubing-curve minimum), Δp bar, traverse plot + summary, shut-in / max THT verdicts, bean schedule, loading verdict and plot, choke regime, hydrate / erosion flags, sensitivity plot and table |
| ⑥ Match | tests table; correlation set to compare; solve-for (p̄r / J / S); (A2) free multipliers | QC flags per test, correlation ranking and comparison plot, back-calculated IPR value, "Adopt" buttons (through normal input events); (A2) tuned multipliers with flags and correlation |
| ⑦ Report | report options (sections), notes | report preview list, Export PDF / PNG (host), CSV bundle, (B) lift-table export |

Phone (390 px): step strip scrolls horizontally inside its own container; tables scroll inside `.dtable` wrappers; plots full width.
iOS: no new fixed overlays in A1 / A2 (editors are inline); B dialogs follow the `html.ios-app` safe-area rule.

---

## 11. Plots — see §2.7.

## 12. Reports and Quick Report — see §2.9 (compact report block, `.rp-skip`, explicit canvas sizes, snapshot size cap, disclaimer).

---

## 13. Units and Metric display

Tagged inputs through `WTS_units.tagInput(id, category)`: pressure / pressureG, temperature, length, lengthSmall (ID, roughness),
liquidRate, gasRate, gor (GOR and GLR), cgr, productivityIndex, permeability, permThickness, viscosity, density, compressibility,
velocity, **heatTransferCoef** (U, Btu/hr·ft²·°F), **thermalConductivity** (k_e), **specificHeat** (c_p) — the three registered by
49-calc-lineheat.js; `heatTransfer` (a conductance in Btu/hr/°F) is not used. `pressureGradient` (psi/ft ↔ kPa/m, same factor and
`if (!C.pressureGradient)` guard as 49-calc-gaslift.js:83) and `nonDarcyD` (d/Mscf ↔ d/sm³) are registered locally by the page file,
and the page also registers the three lineheat categories with the same guard in case it runs first. No 22-units.js edit and no Round-4
rebuild. Untagged with a field-unit note: Fetkovich C, LIT a / b. Engines are imperial (`window.calcWellPerf` runs in the canonical
context). CSV export writes the display unit system with unit headers; the lift-table export is always field units.

---

## 14. Help guide and course

The help allocation is nearly used: the stripped help files total about 336.6 kB raw and 116.7 kB gzip against the owner-set caps
(`help-content.test.js` SUM_CAP 345 kB, GZIP_CAP 120 kB, owner decision Q13 of the help plan) — about 8 kB raw and 3 kB gzip left —
and a non-PART guide is capped at 6 kB serialised (14 kB for a PART route). Raising a cap or adding a PART route is an owner decision
(Q15), not an integrator one.

- **A1 (WP10):** a compact guide for route `wellperf` within the current allocation: what nodal analysis is, the seven steps, the
  stability rule (q_s vs tubing-curve minimum), liquid loading, comparison / QC, a compute check `fn: 'WTS_wp_system'`. Correlation
  ranges and known limitations are not repeated in the guide: they are in the page's validity verdicts and report Notes (§2.9).
  Two "How do I…" tasks (12 → 14, inside the range check): size a bean for a target rate; check a gas well for liquid loading. Hub
  notes on the oilipr / gasdeliv / gaslift guides only if the owner approves their wording (Q19). WP10 first writes a draft guide and
  sizes it; if it does not fit, Q15 is put to the owner with the measured size (proposed: `wellperf` as a PART route and SUM_CAP
  +12 kB / GZIP_CAP +4 kB).
- **Screenshots:** recipes for each step on `FIX.oilWell` / `FIX.gasWell` (help-shots.js, Linux container only), then Round 9 rebuild,
  `build-user-guide.js`, sync.
- **A2 (WP19) course:** three exercises in a "Well performance" course (E1 predict the rate at three beans and compare with a test; E2
  the gas well that loads up — find the string that unloads it; E3 tune the VLP to a gauge and back-calculate skin), each with trainer
  notes and a worksheet. The help course today is one simulator course, so WP19 also changes: 49-calc-help.js (a course list per course
  with its own label; today one `course` list labelled 'Simulator course' / 'Well Test Simulator course', lines ~333, 430, 443),
  49-calc-help-print.js (worksheets and the course book per course), the help validator in help-content.test.js (course ids per course),
  and help-course.test.js (keeps the simulator assertions; a new wellperf-course test for the second course). Needs the Q15 cap.

---

## 15. Validation and benchmarks (WP11, `wellperf-validate.js`; benchmark tests live in the engine WPs)

### 15.1 Published example problems

Example numbers are verified against the owner's copies (Q9, **blocking: page references needed by 2026-11-24, before WP3 merges**).
**Gate (D17):** a correlation with no verified published traverse or example ships with `verified:false`, labelled "provisional — not
verified against a published example" in the page, the comparison table and the report, and cannot be a default; hydrostatic limits
and cross-checks alone do not count as verification. Benchmark tests are written in the engine WP that adds the method (WP2, WP3,
WP5; A2: WP12–WP15) and merged with it; WP11 merges straight after WP5, before WP9.

| Item | Source (author, title) | Tolerance | WP |
|---|---|---|---|
| Vogel, composite, Fetkovich, Standing FE | Ahmed, *Reservoir Engineering Handbook*; Brown, *The Technology of Artificial Lift Methods* vol. 1 | ±0.5 % (delegated engines already pinned) | WP2 |
| Jones-Blount-Glaze, Darcy PI, LIT, gravel-pack skin | Economides, Hill, Ehlig-Economides & Zhu, *Petroleum Production Systems*; Golan & Whitson, *Well Performance* | ±1 % | WP2 |
| Hagedorn & Brown traverse | Brown vol. 1; Brill & Mukherjee, *Multiphase Flow in Wells* | ±3 % on Δp | WP3 |
| Gray, average T-Z | Economides et al.; Guo, Lyons & Ghalambor, *Petroleum Production Engineering* | ±1 % (gas) / ±3 % (Gray) | WP3 |
| Beggs & Brill | Brill & Mukherjee Ex. 4.7 (already in calc-flowline) | existing | — |
| Turner / Coleman critical rate | Lea, Nickens & Wells, *Gas Well Deliquification*; Guo et al. | ±1 % | WP5 |
| Nodal operating point | Beggs, *Production Optimization Using Nodal Analysis* | ±2 % q | WP5 |
| Minimum curvature | a directional-drilling text example (FIX.devSurvey) | ±0.01 ft | WP4 |
| Duns & Ros, Cullender-Smith (A2) | Brill & Mukherjee; Economides et al. | ±3 % / ±1 % | WP12 |
| Sachdeva choke (A2) | Brill & Mukherjee choke chapter | ±3 % | WP15 |
| Ramey / Hasan-Kabir temperature (A2) | Hasan & Kabir, *Fluid Flow and Heat Transfer in Wellbores* | ±2 °F | WP14 |
| Gas-lift GLPC / ESP (B) | Takacs, *Gas Lift Manual*; Takacs, *Electrical Submersible Pumps Manual* | ±3 % | WP25 / WP26 |

### 15.2 Hand-calculation and internal cross-checks

- Water column, no flow: p = p_top + 0.433·SG·TVD within 0.01 % for every correlation.
- Single-phase liquid at rate: Darcy-Weisbach + Colebrook within 0.1 %.
- Dry gas: marcher (each correlation, gas only) vs `gasTZ` within 1 % (A2 also `gasCS`); zero rate vs `WTS_gradient_compute` gas
  column within 0.2 %.
- Mass flow equal at top and bottom of each traverse (wet gas and oil) within 1e-9.
- Beggs & Brill through the VLP engine vs `WTS_flowline_march` direct: bit-identical.
- IPR: delegated models equal `WTS_oilipr_compute` / `WTS_gasdeliv_compute` outputs exactly.
- Node independence within 0.5 % in q; top-down vs bottom-up within 0.5 psi.
- p_out(q) smooth on the frozen grid (second differences < 0.01 psi) and continuous across the choke regime change.
- Sensitivity at the base values equals the single solve exactly; (A2) gas lift at q_inj = 0 equals natural flow exactly.

### 15.3 Convergence tests

Step halving to < 0.1 psi BHP change; Brent root tolerance; scan density doubling finds no new roots on the fixtures; (A2) Sachdeva
critical-ratio fixed point converges in ≤ 30 iterations over the input grid.

---

## 16. Performance budgets

**Baseline (to be re-measured in WP0 on the existing marcher; the review measured it on master in the test harness):** one 8,000 ft
vertical traverse in 2.441 in tubing with Beggs & Brill and today's Standing / DAK props takes about 17–19 ms (160 steps, about
0.11 ms per step). Hagedorn & Brown and Duns & Ros are no cheaper per step. The first-draft budgets (4 ms per traverse, 150 ms per
solve) were inconsistent with this and are withdrawn.

**Unit of account:** one *fine evaluation* E = one well traverse at the fine step + the flowline march + the choke, ≈ 11–14 ms on the
container for 10,000 ft at 100 ft steps before speed-ups. A coarse evaluation (double step) counts as ½ E.

| Operation | Evaluation budget | Container ms (target after speed-ups; gate = 2 × the WP0 measurement × E-count) | Runs |
|---|---|---|---|
| One traverse, 10,000 ft, 100 ft steps | 1 E | ≈ 11 ms baseline, ≤ 7 ms with the PVT table | — |
| System solve, one root (12 coarse scan + ≤ 8 Brent + 2 derivative) | ≤ 16 E (≤ 20 E with two roots, + 4 E for q_s) | ≤ 250 ms | on input (interactive set) |
| Page recompute on an input change | solve + ≤ 2 E | ≤ 300 ms; × phone factor 3 ≤ 1 s, else Solve button | on input |
| Design mode (bean or THP) | ≤ 8 warm solves ≈ ≤ 60 E | ≤ 1 s | button, Job |
| Bean schedule, 6 beans | ≤ 6 warm solves ≈ ≤ 50 E | ≤ 0.8 s | button, Job |
| Sensitivity, 10 cases (A1) | ≤ 80 E | ≤ 1.2 s | button, Job |
| Sensitivity 2 × 10 (A2) | ≤ 160 E | ≤ 2.5 s | button, Job |
| GLPC 12 points (A2; inner depth search) | ≤ 200 E | ≤ 3.5 s | button, Job |
| Lift table 3,200 points (B) | 3,200 single traverses | ≤ 60 s, cancel within one point | button, Job |
| Module files' load (Round-9 parse) | — | ≤ +15 ms on the app load | — |
| Accept-test files of the module | — | ≤ 30 s in total (A1) | — |

**Speed-ups planned (WP0b / WP3 / WP5):** the VLP curve is computed once on the coarse scan grid and interpolated before the Brent
polish; coarse steps for the scan, fine steps only for the polish and the reported traverse; no golden-section search unless asked;
the (p, T)-binned PVT table (§4.5); warm starts across cases on the frozen grid; Jobs for every multi-solve operation.

**Gate:** `wellperf-validate.js --time` reports, per operation, the evaluation count (the stable gate: it must stay within the budget
column) and the milliseconds (reported, with a loose cap of 2 × the WP0 baseline × count). The phone factor ×3 is a planning number;
`ios-webkit-check.js` gives a WebKit timing when Playwright WebKit is available. If a budget is missed, step length, scan density and
caching are tuned first — never the accuracy tolerances of §15.

---

## 17. Test plan

Each `tests/wellperf-*.test.js` exports `[{name, wp, run}]`; tolerances as in §15.

### 17.1 Increment A1

| File | Content | Count |
|---|---|---|
| `wellperf-shapes` | fixtures frozen, shapes | 4 |
| `wellperf-identity` | FI1–FI6 flowline / flare / gas-lift / chokeperf / wellbore (incl. `_ramey` NOT_AVAILABLE kept) / tubulars full-output deep compare with no new option; FI7 oilipr, FI8 gasdeliv | 8 |
| `wellperf-names` | banned-name grep over every wellperf file | 1 |
| `wellperf-pvt` | Standing path through `fluid.pvt`, one-point Pb shift, wet-gas mode (Rs = 0, separator gas, no double count), mass balance top = bottom, validity warnings, table vs traverse same path, flowlineFluid units, PVT table lookup error | 8 |
| `wellperf-ipr` | delegation identity (3), JBG, Darcy oil (three reference forms), Darcy gas, m(p) LIT via fitAB, D estimate with β units, inverses, PRiSM import with provenance, gas deliverability import, null p̄r | 12 |
| `wellperf-skin` | Hawkins, McLeod, gravel pack textbook example (96 field form), h / h_p scaling with b < 1, total, Karakas-Tariq disabled message, Δp_skin / FE | 7 |
| `wellperf-well` | minimum curvature, column schema → segmentsFor (tapered, annulus), restrictions, checks, DFIT geometry import, roughness default | 8 |
| `wellperf-temp` | linear mode, J-T hydrate THT correction, "upper-bound THT" verdict | 3 |
| `wellperf-vlp` | per correlation (hb, gray, nsl, gasTZ, single): hydrostatic limit, published traverse; HB holdup ≥ no-slip and Griffith boundary with known numbers (d in ft); Gray both liquid-ratio ranges; gas cross-check; direction agreement; step convergence; unknown corr key | 16 |
| `wellperf-system` | roots; stability label vs shading; falling-branch stable root (`FIX.fallingBranch`); q_s left of the tubing-curve minimum; heading flag on q_s; nodes agree; choke continuity across y_c; discontinuity detection; p_out smoothness on the frozen grid; warm = cold; design bean; design THP; max rate; breakdown sums to p̄r − p_sep; shutIn (gas, liquid, partial); bean schedule; max THT vs rating | 18 |
| `wellperf-loading` | Turner / Coleman / Li values, limiting depth with a tapered string (bottom controls), method suggestion by WHP, verdicts | 6 |
| `wellperf-sens` | matrix, Job via drive, cancel, base case = single solve, CSV | 5 |
| `wellperf-match` | compare ranking, provisional label, IPR from test (p̄r, J, S) | 5 |
| `wellperf-qc` | each QC code (QC_GOR_LT_RSB "not applicable" without pbUser) | 8 |
| `wellperf-page` | render; silent restore = one calc; multi-well switch re-reads the model; project round trip; units switch; compact block captured, `.rp-skip` parts not; hidden canvases drawn at size; Quick Report snapshot ≤ 60 kB; disclaimer and validity verdicts in report and snapshot; events `wts:wellperf-*`; hub navigation and home tiles; Solve-button fallback | 14 |
| **Total A1** | | **123** |

Plus: `sidebar-nav.test.js` updated (HUBS map, row assertions), help-content caps and compute check via the existing help tests, and
3 smoke checks (registry entry well formed, `WTS_wp_*` namespaces present, `WTS_flowline_corr.bb` registered). The smoke "no pending
timers after 5 s idle" check must still pass.

### 17.2 Increment A2

`wellperf-vlp2` (Duns & Ros regions with known numbers, Cullender-Smith, gas cross-checks: 8) · `wellperf-pvt2` (P-ID on all 20
existing keys, new correlations vs published values, Vasquez-Beggs equal to the host Solution GOR page, McCain water: 10) ·
`wellperf-temp2` (`flowingTemp` reference, f(t) both branches, THT above the surface geotherm, large-z limit g_G A, radius basis
conversion, inject direction, U fit: 8) · `wellperf-choke2` (Sachdeva y_c, sub-critical, continuity, rate factor: 6) ·
`wellperf-sens2` (2-variable: 4) · `wellperf-tune` (H_L clamp, grad rebuild, bounds and flags, m_h-only rule, correlation matrix: 6) ·
`wellperf-gaslift` (depth per point, free-gas-only injection, q_inj = 0 identity, GLPC shape, optimum: 6) · `wellperf-course` + help
changes (5). **Total A2 ≈ 53.**

### 17.3 Increment B

`wellperf-export` (round-trip parser, monotone fill and monotonicity check), `wellperf-pvtmatch`, `wellperf-ipr2` (WP24: 15), `wellperf-gl2`,
`wellperf-esp`, `wellperf-cases`, `wellperf-mech`. WP27 shipped `wellperf-cases` (6), `wellperf-envelope` (5), `wellperf-tornado` (3) and
`wellperf-studies` (5) — §18.3.6; WP25 shipped `wellperf-gl2` (8) — §18.3.9; WP26 shipped `wellperf-esp` (13) — §18.3.10; the review fixes `wellperf-bfix` (3) — §18.3.12.

---

## 18. Work packages, dependencies and merge order

### 18.1 Increment A1 (v4.3)

| WP | Content | Depends on | Lane |
|---|---|---|---|
| WP0 | contracts: `_wellperf-shapes.js`; stub files with exported signatures returning `{ok:false, code:'STUB'}`; `49-calc-wp-model.js` (read / write / migrate / decimate / DFIT import mapper); the three host hub edits + sidebar test + home-tile check + ux-layout run; help route stub; report-capture check (compact block, `.rp-skip`, hidden canvases); `wellperf-names`; timing baseline of the existing marcher; one-line cross-reference in docs/DFIT-PLAN.md that `_ramey` stays DFIT's and `flowingTemp` is the production path | — | lead |
| WP0b | every 49-calc-flowline.js edit of §2.3 (registry, `corr` key, `mult`, `stepFt`, `grid`, `eroC`, `detail`, `props` `fluid.pvt` incl. `liquidNoTransfer`, `injGas`, `table`, wrapper pass-through) + `wellperf-identity` FI1–FI6 | WP0 | lead / V |
| WP1 | `WTS_wp_fluid` (existing correlations, wet gas, recombine, flowlineFluid), supplies the `pvt` object only | WP0b | P |
| WP2 | `WTS_oilipr_model`, `WTS_gasdeliv_model`, `WTS_gasdeliv_fitAB` + FI7 / FI8; `WTS_wp_ipr`; skin table; their benchmark tests | WP0 | I |
| WP4 | wellbore `surveyMC`, column schema → `segmentsFor`; tubulars roughness defaults; `WTS_wp_well`; linear temperature + J-T hydrate THT (uses the WP1 `WTS_wp_fluid` interface, or the fixture stub until WP1 merges) | WP0b, WP1 interface | W |
| WP3 | HB, Gray, no-slip, gasTZ, single registered in `WTS_flowline_corr`; `WTS_wp_vlp`; their benchmark tests and `verified` flags | WP0b (WP1 / WP4 fixtures) | V |
| WP5 | `WTS_wp_system` (scan on the coarse curve, Brent, discontinuity detection, stability with q_s and tubing-curve minimum, choke continuous bound, design bean / THP, maxRate, shutIn, beanSchedule, max THT), loading, erosion, hydrate, checks; benchmark tests | WP1–WP4 merged | S |
| WP11 | `wellperf-validate.js` (`--check`, `--time` with evaluation counts), the provisional-label gate | WP5 (merges right after it) | lead / V |
| WP6 | `WTS_wp_sens` 1-variable as a Job + CSV | WP5 | S |
| WP7 | `WTS_wp_match.compare`, `iprFromTest`, `WTS_wp_qc` | WP5 | M |
| WP9 | page, plots, compact report block, UI, silent restore, events | WP0 (against stubs), then each engine as merged | U |
| WP10 | compact help guide (draft sized first; Q15 if needed), 2 tasks, screenshots | WP9 | H |
| WPI | integration: Round 9 rebuild (no Round 3 / 4 in A1), CRLF normalise, sync, full gates, GUI sweep `--route wellperf`, release note, CLAUDE.md update | all | lead |

Merge order: WP0 → WP0b → (WP1, WP2 in any order) → WP4 → WP3 → WP5 → WP11 → (WP6, WP7) → WP9 → WP10 → WPI. WP9 develops in
parallel from WP0 against the stubs and rebases on each merge.

#### 18.1.1 WP0 / WP0b record (lead, 2026-11-11, branch wp/a1)

Owner decision: "go and continue all" — every open question takes its proposed default (§20); Q9: no textbooks, so the affected
correlations ship provisional through the §15.1 gate. Built to the contracts below; lane WPs code against them.

- **Files.** `49-calc-wp-model.js` (complete: `WTS_wp_model` `read` / `write` / `readRaw` / `migrate` / `validate` / `decimate` /
  `dfitTests` / `fromDfit`, `SCALARS` (the page's `wp_*` control contract; `wp_ip_<name>` → `res.params.<name>`), `DEFAULTS`, `empty`);
  stubs `49-calc-wp-fluid.js` (WP1), `-ipr` (WP2), `-vlp` (WP3), `-well` (WP4), `-system` (WP5), `-sens` (WP6), `-match` (WP7) — every
  function returns `{ok:false, code:'STUB', name, wp}` and is listed in `window.__WP_STUBS` until its WP replaces the file; the page shell
  `49-calc-wellperf.js` (registry entry, `renderWellPerf`, `calcWellPerf`, events, `WTS_wellperf_page.calcs()` test hook); fixtures
  `tests/_wellperf-shapes.js` (hash-pinned); frozen v4.2 engine copies `tests/_wp-v42/` (flowline, chokeperf, wellbore, tubulars, oilipr,
  gasdeliv, gaslift) for the identity tests; tests `wellperf-shapes` (4), `wellperf-names` (1), `wellperf-identity` (FI1–FI9 + FIT timing).
- **Contract additions.** `M.system.thp_psig` (fixed THP when `surface.choke.present` is false) and the `system.mode` meanings
  (`rate` | `pressure` | `max` | `design`, comment in 49-calc-wp-model.js); `M.fluid.bc`, `M.well.heat.thtMeasured`,
  `M.system.stepFtLine`, `M.meta {status, readOnly, notes}`; a correlation entry may carry `friction(hl, inp, G)` (used by `opt.mult`) and
  `vertical`; segment `area` (in²) and `restr {d, k?}` apply at the segment's **flow inlet**; the traverse profile and `SHAPE.R` carry `inc`;
  `WTS_wp_well.build` / `schematic` (trajectory stations MD / TVD / N / E / departure / inclination) for the deviation-first schematic.
- **Hub.** Static row `data-hub="perf"`, `__NAV_HUBS.perf`, `__NAV_ORDER`; Production & Reservoir 7 → 5 rows; `sidebar-nav` (HUBS, rows,
  hub navigation and dashboard tiles — members are tiles of their group in sidebar order, badges unchanged), `buildup-page` row assertion;
  `ux-layout-check` 1280×800 / 1440×900 fit ok; help screenshots home / help / start re-shot.
- **Help (Q15 default).** `wellperf` route stub in 48-calc-help-production.js; `wellperf` a PART route; SUM_CAP 357 kB, GZIP_CAP 124 kB;
  production cap +0.8 kB, 11.2 kB unallocated for WP10 / WP19; `wellperf` in MANUAL_OK while the page is the stub (WP10 removes it).
- **Timing baseline (§16).** 8,000 ft vertical, 2.441 in, Beggs & Brill, 50 ft steps: 17.0 ms (160 steps, 0.106 ms / step); 10,000 ft:
  22.3 ms; one fine evaluation E (10,000 ft at 100 ft steps): 10.1–12.0 ms (`BASELINE` in the fixtures; FIT reports it per run).
- **WP0b (49-calc-flowline.js).** All §2.3 options (registry `WTS_flowline_corr` + `bb`, `corr` key, `mult`, `stepFt`, `grid`, `eroC`,
  `detail`, `fluid.pvt` with `corr` / `pbFactor` / `undersat` / `mult` / `imp` / `liquidNoTransfer` / `bc` / `injGas` / `table`, segment
  `area` / `restr`, wrapper pass-through); FI1–FI8 deep-compare the full outputs with the frozen v4.2 engines (bit for bit); FI9 checks
  the neutral values, the unknown key, grid replay, detail, the restriction loss, the multipliers, wet gas, lift gas, the PVT table
  (< 0.05 % in BHP) and the undersaturated branch. The flowline guide's `reviewedSrc` was re-hashed (page unchanged).

#### 18.1.2 WP5 / WP11 record (2026-11-11, branch wp/a1-wp5)

- **`WTS_wp_system`** (49-calc-wp-system.js) as §4.7–§4.14: 12-point coarse scan on a frozen layout, monotone cubic between the
  points, a Newton step on the coarse slope then Brent per sign change, central differences at ±1 % q, q_s by a secant step on fine
  central differences, the tubing-curve minimum from a parabola, tangency = "marginal", discontinuity rule (a collapsed bracket whose
  |Δ| stays above 0.1 psi at both ends and whose jump exceeds 10 × the expected slope × width: a discontinuity with q, jump and side,
  never a root). Wellhead node (THP available vs required; within 1e-6 of the bottom node on the fixtures); the separator node is solved
  at the wellhead node in A1 and says so. Choke: the max rule with y_c = 0.588 (multiphase), the gas nozzle inverted for p1 (critical:
  fixed point on z; sub-critical: Illinois), the incompressible orifice below GLR 10 scf/STB. The solver builds the fluid with the
  (p, T)-binned property table (WP0b FI9, < 0.05 % in BHP; ≈ 30 % faster). Extra result fields used by the page: `surface.thp_psig`,
  `surface.tHyd` (hydrate temperature at the THP; `surface.thtHyd` is the THT of the hydrate check, §4.6), `tChokeDn` / `tHydDn`,
  `curves {ipr, vlp}`, `velocities {vmMax, eroMax, qEro}`, `scan`, `atTarget` ('pressure' mode), `grid` (warm starts).
- **Tracking solve** (`solve(M, {warm, track: {q, slope}})`, ≈ 5 E): the stable root continued from a neighbouring setting, no scan, no
  q_s; used by the design Job, the bean schedule (6 beans ≈ 42 E against 50) and the page's live drag (the drag keeps the last full
  solve's outflow curve and q_s until the release; `R.carried`). Design: one full solve at the current setting, a first guess from the
  choke law (∝ S^1.89) or the root slope, then secant / Illinois on tracking solves (oil bean 4 solves, 32 E against 60).
- **Loading** at every traverse node (Turner 1.912 / Coleman 1.593 / Li 0.7241); the liquid is water when the well makes water; FIX.gasWell
  is limited in the 7 in casing below the tubing shoe (bottom controls, −53 %) under the strict rule — after the review decision of
  2026-11-12 (§4.11) the verdict is the tubing (+ ≈ 100 %, the 3-1/2 in upper string controls) and the liner below the shoe is an
  information line; the methods are provisional (Q9). **`WTS_wp_check`** as
  §4.13 with codes and field ids. **`shutIn`**: gas-filled (well-stream gravity for a wet gas, Z iterated, WTS_gradient_compute), the
  actual fluid (live liquid marched up from p̄r; the gas column for gas wells; the liquid level when p̄r cannot hold the column) and
  partly liquid-filled columns; the worst case against the rating (⚠ within 10 %, none without a rating). Maximum THT = the entered THT
  in A1 (linear model), checked against `rating.tht_max_F`.
- **Findings for the lead.** (1) The frozen `FIX.fallingBranch` (J 0.3, p̄r 3,200 psia) does not flow with any A1 correlation; with
  J = 1 and Hagedorn & Brown it is exactly the intended case (op 598 STB/d, q_s 277, tubing-curve minimum 875) — the tests use that
  variant; the fixture's J should become 1. (2) Smoothness: the tubing outflow is smooth on the frozen grid for the gas well (Beggs &
  Brill, Gray: second differences ≈ 1e-3 psi) and for no-slip oil (2e-3), but Beggs & Brill and Hagedorn & Brown in the oil wells and the
  Beggs & Brill flowline step by 0.2–1 psi at pattern switches — the discontinuity rule reports the large ones; a continuous pattern
  transition is an A2 item. (3) The plan's ≤ 250 ms per solve is not met on this container (oil 2 roots 22 E ≈ 400–470 ms, gas 15 E ≈
  370–410 ms); the page budget is therefore the §16 device budget (1 s) and drags use the tracking solve. (4) A literal `key: '<route>'`
  in a Round-9 file ties it to that route's help review hash (help-content `srcTexts`): the breakdown keys go through a constant map.
- **WP11** `prism-build/wellperf-validate.js`: `--gate` (D17: BENCH table of §15.1 statuses — verified / pinned / pending; every pending
  method verified:false, labelled in list / traverse / check validity / loading, never a default), `--check` (14 cross-checks of §15.2 /
  §15.3: water column on the deviated path, dry-gas closed form, direction, node independence, smoothness, choke continuity, breakdown,
  root tolerance, scan doubling, step convergence, warm = cold, shut-in gas / liquid columns, critical velocity), `--time` (evaluation
  counts against §16 and ms against 2 × the E measured in the run). Tests: `wellperf-system` (21), `wellperf-loading` (6).

#### 18.1.3 WP6 record (2026-11-11, branch wp/a1-wp6)

- **`WTS_wp_sens`** (49-calc-wp-sens.js) as §3.6 / §6: `VARS` (p̄r psia, WC %, GOR / GLR scf/STB, WGR / CGR STB/MMscf, THP psig with
  the choke out of line, separator psig, tubing ID in or a `WTS_tubulars` key, skin and k·h for the Darcy models, bean /64 in, J for
  pi / composite; each with a path in M, a validity range and the fluid types it applies to), `vars(M)` (applicability), `suggest(M,
  key)`, `matrix` (full factorial, ≤ 10 values per variable, ≤ 4 variables, ≤ 1,000 cases), `job(M, vars)` (one variable in A1; two
  → `A2_ONLY`), `table`, `csv` (field units; the family curves in long form).
- **Numerics (§6.3).** Cases sorted by value; the START case is the model's own value when listed (else the nearest value): a plain
  cold `solve(M)`, so the base case equals the single solve exactly (validate X15, WSE4). The other cases walk outwards, each a
  tracking solve warm-started from the neighbour (linear extrapolation of the rate) on the start case's frozen layout; a failed
  bracket falls back to the full solve inside `WTS_wp_system.solve`.
- **Families (§6.2).** Inflow variables: one IPR per value from `WTS_wp_ipr.curve` (no march). Outflow variables: a 4-point coarse
  scan (`coarseOnly`, ½ E each) plus the fine operating point as a knot. Budget: 10 WC cases on FIX.oilWell = 77 E against 80
  (≈ 1.7 s on the container; the plan's 1.2 s is missed for the same reason as WP5 finding 3).
- **Page.** Variable list from `WTS_wp_sens.VARS` with display units; values typed in display units (Metric converted to field units
  per variable); suggestions on a variable change with the applicability note; full results table (rates, pwf, THP, THT, stable,
  loading margin, choke regime or the reason a case does not flow; the model row in bold); rate-vs-parameter plot with hollow markers
  for non-flowing / unstable cases; dashed families on the system plot; the CSV bundle carries the full table and the families.
  Tests `wellperf-sens` (5). Help: the wellperf stub's `reviewedSrc` re-hashed (page text unchanged).
- **Finding.** On FIX.gasWell with Beggs & Brill, the tubing outflow at a fixed gas rate falls from WGR 0 to 20 STB/MMscf and rises
  again at 100 (a pattern switch, WP5 finding 2), so the WGR sensitivity shows the rate rising slightly with WGR; Gray and the
  no-slip method are monotone.

#### 18.1.4 WP7 record (2026-11-11, branch wp/a1-wp7)

- **`WTS_wp_match.compare`** (49-calc-wp-match.js) as §5.2: each registered well correlation (oil: every `any` / `well` key; gas wells
  also the `gas` keys) is marched top-down from the measured THP to the gauge MD on the deviated path
  (`WTS_wp_well.segmentsFor(W, {from: gaugeMd, toMd: 0})`, hydrostatic on TVD, friction on MD), so p_calc is the march end exactly; err,
  errPct, errPctDp (share of the measured tubing Δp), rank by |err|, several tests by the RMS over the tests with a gauge (`use: false`
  left out), a lost march ranks last; every unverified row carries the D17 label; the decimated profile per correlation feeds the page
  plot. The test is marched at its OWN measured rates and THT (missing water / gas filled from WC / GOR or CGR / WGR, listed in
  `derived`); exact fluid properties (no binned table).
- **`iprFromTest`** as §5.3: pwf at the mid-perforations marched down (or up) from the gauge, the gauge itself within 1 ft of the
  mid-perforations, or marched down from the THP (an info note names the correlation and its label); 'pr' closed form for pi / jbgOil /
  litP2, else an Illinois root on q(pwf; p̄r) with the resolved coefficients held; 'J' closed form for the coefficients q is linear in (J,
  q_max, C, k), a factor root for A/B, a/b and darcyGas k, value = the PI equivalent; 'S' closed forms for darcyOil and darcyGas (D held),
  NEEDS_DARCY otherwise. `adopt` = {control id: value}; the page writes them through the normal input path with the provenance "matched
  to test <id>".
- **`WTS_wp_qc`** as §5.4: every test (used or not) gets a check per code (ok / warn / fail / na) and flags; QC_GOR_LT_RSB is "not
  applicable" without `pbUser` (Rsb = Standing Rs at pbUser, no one-point shift); QC_CHOKE inverts `WTS_wp_system.boundary` for the rate
  at the measured THP / bean (secant on log q, ≤ 8 boundary calls) and warns beyond 20 % or when the choke is sub-critical at the test;
  QC_WC orders the tests by date for the 20-point jump; QC_SEP reads `WTS_state.sepqc` (total GOR ± 15 %, or equal to its separator-basis
  GOR). Score = 100 − 30 per fail − 10 per warn; ranked by score, ties in input order. `tune` stays the stub (A2, WP17).
- **Page** (step ⑥): test picker (one test or all used tests = RMS), QC matrix with a chip per code (hover = the check), score and rank,
  ranking table with provisional chips and error bars, the interactive comparison plot (a traverse per correlation, unverified dashed,
  gauge / THP / pwf markers, TVD ↔ MD toggle, toggleable legend, crosshair / zoom / pan through `WTS_wp_view.chart`), one Adopt button
  for every adopted coefficient. Tests: `wellperf-match` (6), `wellperf-qc` (8).

#### 18.1.5 WP10 record (2026-11-12, branch wp/a1-wp10)

- **Guide** `wellperf` in 48-calc-help-production.js (PART route, 9.2 kB serialised of 14 kB): purpose, what, when, nine steps over the
  seven steps (examples Oil / Gas, survey modes, paste, DFIT import, drag handles, Solve now, Checks / Traverse, Match, Report), 21
  inputs + two notDocumented patterns, five outputs, 27 verdicts, parts `stability`, `loading`, `match`, `design`; the example is a
  compute check of `WTS_wp_system.solve` on a compact Oil-example model (914 STB/d at 2,543 psia, THP 320 psig, q_s 319, tubing-curve
  minimum 561). help-content's compute check now accepts a dotted `fn` (called on its namespace); `wellperf` left MANUAL_OK.
- **Tasks** (start, 12 → 14): `beansize` (size a bean for a target rate) and `loading` (check a gas well for liquid loading).
- **Hub note (Q19 default)**: the oilipr / gasdeliv / gaslift guides open through the Well Performance hub (`hub()` step); tiles unchanged.
- **Caps (Q15 default, from the draft)**: production 37.36 → 45.41 kB, start 18.85 → 19.74 kB; 2.11 kB raw of the 357 kB stay unallocated
  (WP19); gzip ≈ 122.9 of 124 kB. help-shots `moduleBytes` 8.75 → 8.8 kB (two manifest rows).
- **Screenshots**: two desktop crops, `sys` (Oil system plot, 14.6 kB) and `load` (Gas liquid-loading tab on MD, 8.3 kB); `help/view-d`
  re-shot (task count). Images total 7,997,236 of 8,000,000 bytes: the schematic (10.2 kB) and KPI-strip (11.9 kB) shots were measured
  but do not fit the help plan's 8 MB image cap (D15) — an owner decision.
- **Page fix**: the ① PVT card printed the fluid validity lines with a doubled mark ("✓ ✓ …"); the leading mark of the engine message is
  now stripped (reviewedSrc fe50c090).

### 18.2 Increment A2 (v4.4)

| WP | Content | Depends on | Lane |
|---|---|---|---|
| WP12 | Duns & Ros, Cullender-Smith + benchmarks | A1 | V |
| WP13 | 16-pvt additions (18 keys), P-ID on all 20 existing keys, Round-3 rebuild with the downstream suites | A1 | P |
| WP14 | `WTS_wellbore.flowingTemp` (produce / inject), U fit, relaxation mode on the page | A1, Q16 answered | W |
| WP15 | Sachdeva continuous choke, `liquidCv`, rate factor | A1 | S |
| WP16 | 2-variable sensitivity Jobs, tubing-ID design mode | A1 | S |
| WP17 | VLP tuning with `PRiSM_lm` (D10) | A1 | M |
| WP18 | `WTS_wp_gl` quick look (depth per point, free-gas injection) | A1 | S |
| WP19 | training course (help page, print, validator, course tests — §14) | A1, Q15 | H |
| WPI2 | integration (Rounds 3 and 9, sync, gates, release note) | all | lead |

#### 18.2.1 WP13 record (2026-11-12, branch wp/a2-wp13)

- **16-pvt (Round 3)**: the 18 keys merged into `PRiSM_pvt_correlations` (38 keys; the 20 A1 functions are the same objects).
  Signatures follow the marcher slots (`Pb_/Rs_/Bo_<k>(API, SG_g, Rs|P, T_F[, sep])`, `mu_oD_<k>(API, T_F)`, `mu_o_<k>(mu_oD, Rs)`,
  `co_<k>(API, SG_g, Rsb, P, T_F)`, `sigma_og_abdulMajeed(API, T_F, Rs)`, `rho_w_mcCain(salinity_ppm, Bw?, Rsw?, SG_g?)`,
  `Bw_mcCain(P, T_F)`, `Rsw_mcCain(P, T_F, salinity_ppm)`, `sg_gas100_vasquezBeggs(SG_g, API, Tsep_F, Psep_psig)` = the host
  `_vbGasGravity100`). New `window.PRiSM_pvt_corrInfo` {label, slot, family, ref, verified:false, note, range} for the 18 keys and
  Hall-Yarborough Z. Q9 (no textbooks): every new correlation is provisional (D17) and none is a default. Finding: the A1
  `Bw_meehan` already uses McCain's (1990) ΔV coefficients, so `Bw_mcCain` gives the same values (P-ID forbids renaming).
  Glasø and Petrosky-Farshad Rs invert Pb only to their printed constants (≤ 5e-4).
- **Contract additions (additive; absent → A1 bit for bit)**: `WTS_flowline_props` `fluid.pvt.sep {psep_psig, tsep_F}` (5th argument of
  Rs / Bo / Pb), `pvt.corr.co` (undersaturated Bo = Bob·exp(−∫co dp), 6-point Gauss-Legendre), `pvt.corr.sigma`; `WTS_wp_fluid.families(slot?)`,
  `.compare(spec, {T_F, pList, pr, slot})`, `.PROV_NOTE`; F gains `corr, provisional[], sg100, salinity_ppm`; table rows gain `rsw` and co
  from the selected key; a blank γw with a salinity takes the McCain density; validity entries carry `provisional` and the D17 note in
  `msg`; `WTS_wp_view` handle kind `pointX`. The page now builds its fluid with `{T_F}` (A1 built it without, so the PVT table ignored
  the one-point pb shift).
- **Page**: step ① family selectors (provisional labelled), co and σ selectors; the Fluid properties card (Rs / Bo / μo / Z / μg / Bg /
  Bw / density against pressure at T_res, every family overlaid, provisional dashed, pb drag handle previewed live and committed on
  release, family chips that select, spread verdict, comparison table in the report); case-summary row "PVT correlations".
- **Tests**: `wellperf-pvt2` PV2-1…PV2-10 (frozen A1 copy `tests/_pvt16-v43.js`); downstream suites (dfit-*, wp15-gas, buildup-engine-*,
  calc-review-pvt-wellkill, calc-g2, flowline / flare / gas lift) unchanged. Help: wellperf / prism / flowline reviewedSrc refreshed; the
  production help file is at 45,400 of 45,410 bytes (WP19 needs the Q15 cap).
#### 18.2.2 WP12 record (2026-11-12, branch wp/a2-wp12)

- **Registry (49-calc-wp-vlp.js, additive).** `WTS_flowline_corr.dr` (Duns & Ros, kind `well`, vertical) and `.gasCS` (Cullender-Smith,
  kind `gas`, range note `gas only` — refused for oil / water wells by the existing solver and check rule); both `verified:false` with
  the D17 label (Q9: no books) and their §15.1 BENCH rows (`pending`); `defaultCorr` unchanged (Beggs & Brill). Duns & Ros: Ros map
  regions I / II / transition / III (boundaries L1 + L2·N_Lv, 50 + 36·N_Lv, 75 + 84·N_Lv^0.75), slip number per region, f_m = f1·f2/f3 on
  the liquid in I / II (no acceleration term), mist friction on the Weber film roughness with the large-roughness law and Ek, transition
  interpolated (continuous at L_S and L_M; the I / II boundary is the method's own jump). The ten chart functions (F1–F7, L1, L2, f2) are
  tabulated readings pinned to their own values (three per curve) until checked against the figures. Cullender-Smith point form = the
  differentiated integrand (γ, T, Z from the marcher's props; no kinetic term).
- **Contract additions (all additive).** `WTS_wp_vlp.gasDry(F, W, q, o)` takes `o.method: 'tz'` (default, unchanged) | `'cs'`;
  new `WTS_wp_vlp.gasCS(F, W, q, o)` (closed form per segment: two half-lengths then Simpson; result with `segments[]` incl. pMid / I values
  and `stations[]`), `drMap(F, q, traverse)` (any traverse on the Ros map), `drRegion(NLv, Ngv, Nd)`, `drBoundaries(Nd, n)`, `_drCharts`;
  `KEYS` gains `dr`, `gasCS`. The traverse's `GAS_ONLY` warning covers every gas-only entry. `WTS_wp_view.chart` gains `readout: 'near'`
  (the nearest point of a series with `info[]`). No change to 49-calc-flowline.js, 49-calc-wp-system.js or 49-calc-wp-match.js (the new
  keys reach the solver, `compare` and the page selectors through the registry).
- **Page.** Traverse card tabs **Correlations** (every applicable correlation marched down from the solved THP at the operating rate with
  `WTS_wp_system.evalAt` — the selected row is the solve's own traverse; depth plot on TVD / MD with crosshair read-out of every
  correlation, provisional dashed; KPI chips BHP spread / selected / operating rate / closed-form agreement; table with BHP, Δ vs selected,
  gravity / friction, main patterns, the operating point of each correlation (button → Job of warm tracking solves → diamonds on the system
  plot) and a **Use** button through the normal input path; for gas wells the average T-Z and Cullender-Smith closed forms as rows and
  points) and **Flow-regime map** (log-log Ros map with the boundaries at the median N_d, the operating traverse coloured by region with a
  per-station read-out of MD / TVD / inclination / groups / region, wellhead and bottom markers, station counts per region). gasCS disabled
  for oil wells like gasTZ; a hint under the correlation selector. Help: the `wellperf` guide re-hashed (text unchanged; the two tabs are
  not described yet — WP19 / the integrator, within the cap).
- **Tests / gates.** `wellperf-vlp2` (10: VD1–VD8 engine as §17.2, VD9–VD10 page); `wellperf-validate` X1 / X2 extended to dr / gasCS,
  X16 (Cullender-Smith vs average T-Z + inverse), `--time` rows "one traverse (Duns & Ros)" and "correlation comparison" (1 E per
  correlation). Measured on the fixtures: Duns & Ros BHP vs Beggs & Brill +4.9 % of the tubing Δp (oil), Cullender-Smith vs average T-Z
  closed forms 0.003 % (dry gas, deviated).
#### 18.2.3 WP14 record (2026-11-12, branch wp/a2-wp14)

- **`WTS_wellbore.flowingTemp(column, opts)`** (48-calc-wellbore.js, new, additive) as §4.6: Ramey / Hasan-Kabir steady relaxation,
  `direction 'produce' | 'inject'`, z along the hole in the flow direction, geotherm on TVD (points or surface + gradient), applied
  exactly piece by piece (pieces end at survey stations, geotherm points and every `stepFt`, default 50 ft), so a deviated hole marches
  on its true inclination; U on the outside-radius basis (`U_ti` + `r_ti` converted); r_wb defaults to the largest string OD. Returns
  `{A, fTD, tD, U_to, Ubasis, rwb, tAt(md), teAt(md), tOut, teOut, offsetOut (= g_G·A·sinθ of the last piece), profile, …}`. Also
  `flowingTempFitU(column, opts, {T, md?, Umin, Umax})` (Brent on ln U, `OUT_OF_RANGE` with the reachable range) and `flowingTempF(tD)`.
  `_ramey` is untouched (still NOT_AVAILABLE; Q16 default: DFIT 3.4b may call `flowingTemp` with `direction:'inject'`, pinned by TT6).
- **`WTS_wp_well`**: `relax(W, F, q, {heat})` (mass rate and mixture c_p from `heatFlow`: oil Gambill, water 1.0, gas the real-gas c_p of
  `WTS_gaspvt_state`; r_to the length-weighted conduit OD), `fitU(W, F, q, thtF)`, `heatFlow(F, q)`, `RELAX_DEFAULTS`;
  `temperature(W, {mode:'relax', q, F})` returns the relaxation profile (THT an estimate; the J-T hydrate correction applies);
  without a rate it is the linear profile with `TEMP_RELAX_NO_RATE` (was `TEMP_RELAX_A2`). Schematic profile rows add `te`, `dte`.
- **`WTS_wp_system`**: with `M.well.heat.mode 'relax'` one profile per rate (cached by q) handed to the march as `tProfile` and used for
  the THT at that rate (choke gas temperature, flowline); `R.heat` (mode, tht, A, f(t_D), t_D, U, U_to, Ubasis, r_to, rwb, k_e, α,
  tProd_d, w, c_p, frac, teTop, offsetTop, verified:false, provisional); traverse rows carry `te`; flag `PROVISIONAL_TEMP`; a missing
  geotherm falls back to linear with `RELAX_FALLBACK`. Evaluation counts unchanged (validate `--time`: oil 21 E, gas 15 E).
- **`WTS_wp_match`**: `thtFit(M, tests)` (U per test, matched range, geometric mean); the compare / pwf march in the relaxation mode uses
  the profile with U fitted to the test THT; QC_THT also warns beyond ±20 °F of the relaxation THT for the matched U range.
- **Model** (additive): `well.heat.Ubasis` ('to' | 'ti'), `well.heat.dwb_in`; controls `wp_Ubasis`, `wp_dwb` (plus the existing
  `wp_Uto`, `wp_tprod`, `wp_ke`, `wp_alpha`, now on the page). The linear mode stays the default (D17 gate: the Hasan & Kabir example is
  not verifiable, Q9 → `temp relax` pending, provisional label in R.heat, the checks, the traverse legend and the Notes).
- **Page**: the temperature model option is enabled; relaxation inputs; the "Relaxation at the operating point" box (THT, earth at
  surface, A along MD, f(t_D), w, c_p, U_to, r_to · r_wb, mass-fraction bar, fluid-vs-earth mini profile on MD with TVD ticks); **Fit U to
  the test THT** (step ③ and ⑥) with **Use U**; the traverse shows the relaxation curve, the earth geotherm, the linear profile and the
  test THT, with **U** and **TIME** rails (log scales) that re-solve live (one rail at phone width); the schematic paints the formation
  halo by the earth temperature and offers "Fluid − earth ΔT" colouring; KPI THT chip reads "relaxation · U"; case summary, checks and
  Notes carry the model. Help: `wellperf` inputs + reviewedSrc.
- **Validation**: BENCH row `temp relax` (pending), gate 5 (label, never default), X21 (X16 on its branch; march vs RK4 on the deviated FIX.gasWell path
  < 0.02 °F, large-z limit), `--time` rows. Tests `wellperf-temp2` (9: TT1–TT9).
#### 18.2.4 WP15 / WP16 / WP18 record (lane S, 2026-11-12, branch wp/a2-sys)

Owner default: every open question at its proposed default; Q9 (textbooks) not provided, so the Sachdeva choke and the gas-lift quick
look ship provisional through the D17 gate (`wellperf-validate.js` BENCH `choke sachdeva`, `lift glpc` pending).

- **WP15 choke (§4.7).** `WTS_chokeperf_sachdeva(o)` (49-calc-chokeperf.js): critical ratio from the published implicit equation as a
  bracketed fixed point (regula falsi on ln y, ≤ 30 evaluations over the whole input grid, X20 (X16 on its branch) / WCK1), mass flux on both sides; limits
  exact (gas only → isentropic ratio and nozzle; liquid only → incompressible orifice). `WTS_chokeperf_liquidCv(o)` (q = 34.2857·Cv·√(Δp/SG),
  the bean's Cv from the solver's 1022.7 orifice). `WTS_chokeperf_SACHDEVA` {cd 0.75, verified:false, range bean 8–40/64}. In the solver
  the regime of a critical correlation now comes from the Sachdeva y_c at the correlation's p1: critical → the correlation's p1 exactly;
  sub-critical → the Sachdeva branch scaled (rate factor) to the correlation at its critical point (regime `subcritical`, model
  `sachdeva-scaled`; continuous, X6 / WCK3). *Superseded by the A2 review (§18.2.9): this branch was the default here, which broke D17;
  the default is again the A1 bound and the branch is the option `surface.choke.subcritical: 'sachdeva'`* (the critical rates still come
  from the verified correlations; only the sub-critical continuation is the provisional branch, labelled in the flag, the validity
  verdict and the Notes). `surface.choke.corr: 'sachdeva'` = the model alone
  (Cd `surface.choke.cd`, × `surface.choke.rateFactor`); for gas wells it carries the condensate and water through the bean (the nozzle
  does not). `chokeCurve(M, {R})` and `chokeFactor(M, corrKey, {R})`. Effect on FIX.oilWell: the same operating point (critical there),
  the A1 bound's unstable low root disappears (WSY1 / WSY7 / WRV8 now pin `'bound'`), the bean design is no longer capped. QC_CHOKE still
  warns on a sub-critical test (provisional branch). With the option the help example's q_s / tubing-curve minimum move (319 → 305,
  561 → 431 STB/d); the help shows the default (319 / 561, as A1).
- **WP16 sensitivity (§6).** `WTS_wp_sens.job(M, vars)` takes two variables: the 2-D grid walked from the start cell (= the single solve
  when both model values are listed, X17), each cell a tracking solve from a solved neighbour; pairs that set the same input are refused
  (`BAD_PAIR`), three variables `B_ONLY` (was `A2_ONLY` for two). 2 × 10 = 117 E of 160. `designFor(M, {tubingId: q})`: the smallest
  `WTS_tubulars` tubing (fitting the casing) whose stable rate reaches the target; every size listed (rate, stability, loading margin,
  erosion).
- **WP18 gas lift (§7.1).** In `WTS_wp_system.solve`: `M.lift.type 'gaslift'` with `lift.gl.qinj_Mscfd > 0` (0 / blank = the natural-flow
  path exactly, X18); the injection depth inside every evaluation = the shallower of the packer (blank → the end of tubing) and the point
  of balance p_cas − ΔP_valve = p_tub (X19), p_cas = `WTS_gaslift_casingP` over the TVD; top-down for the bottom node, bottom-up at pwf(q)
  for the wellhead node (same answer within 0.5 %); the lift gas is free gas only above the point (`fluid.pvt.injGas`), and the choke
  (GLR incl. lift gas, Sachdeva mixture) and flowline carry it. The lifted marches do not use the frozen step layout (the depth moves with
  q). `designFor(M, {qinj: q})`. New file 49-calc-wp-lift.js: `WTS_wp_gl.glpc / quickLook / summary / DEFAULT_LIST` (12 points 0–5 MMscf/d,
  a Job with tracking solves, 111 E of 200; economic point by `lift.gl.incGor`, scf/STB; gas for 90 % of the maximum GAIN).
- **Contract additions (additive).** M: `surface.choke.subcritical` ('sachdeva' default | 'bound'), `surface.choke.rateFactor`,
  `system.target.kind` + 'tubingId' | 'qinj', `lift.gl.qinj_Mscfd`, `lift.gl.incGor`; scalars `wp_cksub`, `wp_ckrf`, `wp_gl_qinj`,
  `wp_gl_incgor`. R: `surface.choke.{model, rateFactor, x1, ycIt, cv, subcritical, cd, fallback}`, `lift {…}`, `rates.qinj / qgTotal`,
  traverse rows `lift`. Flags `CHOKE_SUBCRITICAL`, `CHOKE_PROVISIONAL`, `CHOKE_RANGE`, `GL_POINT`; check items `GL_NOT_APPLICABLE`,
  `GL_PINJ`, `GL_PACKER`; validity row `sachdeva`. Solver codes `GL_NOT_APPLICABLE`, `NEEDS_PINJ`. `WTS_wp_view.chart` handle kind
  `lineX`; `schematic` option `marks`.
- **Page.** Choke model / sub-critical rule / Cd / rate factor + Fit; the Choke tab (rate vs p2/p1, y_c, operating point, bean handle);
  second sensitivity variable, heat-map table (select → marker, Use these values), a rate line per second value; tubing-size design table
  and chart with Use; step ④ gas lift: the performance curve with the draggable q_inj line, the injection depth (MD / TVD) per rate, the
  quick-look summary, Use the optimum / economic point; Lift gas KPI (replaces the n/a loading KPI of a lifted oil well); schematic
  injection point with the annulus gas path and the packer; traverse casing curve, injection line and a packer drag handle.
- **Tests.** wellperf-choke2 (6), wellperf-sens2 (5), wellperf-gaslift (6); validate X6b, X17–X20 (X20 = X16 on its branch), the 2 × 10 and GLPC timing rows.
- **Known gaps.** Sachdeva Cd 0.75 and the liquid heat capacities (oil 0.5, water 1.0 Btu/lbm·°F) are unverified (the help screenshot
  `sys` was re-shot: 14.4 kB, the image total 7,994,340 bytes); GLPC stability is the static check only (Asheim in B); the depth plot of a
  dead well starts at the first lifted point.

#### 18.2.5 WP17 record (2026-11-12, branch wp/a2-wp17)

- **Engine (49-calc-wp-match.js)**: `WTS_wp_match.tune(M, tests|test, corr?, o?)` fits m_h (0.8–1.25) with `PRiSM_lm`, and m_f
  (0.7–1.5) only when the used tests span ≥ 2:1 in rate (else m_h only + TUNE_MH_ONLY) — D10. Residual = the march from the measured THP
  down the surveyed path to the gauge at the test's own rates and THT (frozen step layout); multipliers through the marcher's `opt.mult`
  (H_L' = clamp(m_h·H_L, λ_L, 1), density / friction / acceleration rebuilt; the flowline is never tuned). 2×2 correlation from the LM
  covariance (both free) or the Jacobian (m_h only); |ρ| > 0.9 → "cannot be separated". Flags: outside 0.9–1.1, at a bound, not converged,
  a test still > 5 % off, provisional correlation. `tuneJob()` (5 stages, progress / Cancel via `PRiSM_autoInterp.drive`), `TUNE` constants;
  `pwfFromTest` / `iprFromTest` gain `mult`; QC_VLP is judged after tuning when the model carries multipliers (§5.4).
- **Page**: step ⑥ **VLP tuning** card (`wpv_tcorr`, `wpv_tfree`; Tune / Apply to the model / Reset to 1), KPI chips, flags, per-test
  residual table (gauge MD and TVD, before / after), coloured ρ cells; tuned vs untuned traverse with gauge diamonds and draggable m_h / m_f
  rails (live re-march, release commits); RMS along m_h with the LM optimum and the 0.9–1.1 band. With multipliers in the model: the KPI
  chip, the untuned outflow and operating point dashed on the system plot, the untuned pressure on the traverse, a check line, case summary
  and schematic caption.
- **Tests**: `wellperf-tune` WT1–WT6; wellperf-match WM1 now expects `tune` built (the frozen STUBS fixture unchanged). `--time` reports
  tuning as "reported only" (§16 has no tuning budget): 1 test 25 E ≈ 0.35 s, 3 tests with both multipliers 159 E ≈ 2.3 s.

#### 18.2.6 A2 integration record (2026-11-12, branch wp/a2)

- **Merge order** wp/a2-wp13 → wp/a2-wp12 → wp/a2-wp14 → wp/a2-sys → wp/a2-wp17 (all `--no-ff`). Generated files (combined-round3 / 9,
  the HTML, ios-app/www, help/user-guide.html and its www copy) were never merged by hand: Rounds 3 and 9 were rebuilt, LF, synced and
  the guide regenerated after every merge; the wellperf `reviewedSrc` re-hashed after each.
- **Reconciled**: one visibility rule in `_syncUi` (WP15–18's `data-ck` / `data-lift` / `data-sv2` rule plus WP14's `data-heat`; the
  separate WP14 loops re-enabled elements hidden by the combined rule); traverse tabs traverse / corr / map / loading / choke / sens / beans;
  `_onHandle` keys hU / hT (heat rails) + qinj / packer (gas lift); view handle kinds `pointX` (WP13) and `lineX` (WP18); model defaults
  heat {Ubasis, dwb_in} + choke {subcritical:'sachdeva', rateFactor}; validate gate 5 = temp relax, gate 6 = choke sachdeva; the three X16
  checks renumbered (Cullender-Smith X16, Sachdeva critical ratio X20, relaxation vs RK4 X21).
- **Integration fix**: `_glTraverse` (gas lift) now passes the relaxation profile to both marches, like the natural-flow path.
- **Help cap**: the merged production help file was 292 bytes over its 45.41 kB cap (each lane fitted alone); trimmed (comments, step ④ /
  ⑥ wording, the U hint, one notDocumented pattern) to fit without a cap change; the Traverse output now names Correlations and Flow-regime map.
- **Gates**: node --check ok; smoke 347/347; accept-test --html --integration file by file, 181 files (the "2226/2226" first written
  here was a miscount — `accept-test.js --list --integration` gave 2112 at §18.2.8); wellperf-validate
  --html --gate --check --time: gate PASS, 22/22 cross-checks, every E budget ok; help-shots --check, build-user-guide --check ok.

#### 18.2.7 WP19 record (2026-11-12, branch wp/a2-wp19)

- **Course** (new `48-calc-help-wpcourse.js`, factory group `wpcourse`, no guides): three exercises with `course: 'wellperf'`, each with
  goal, set-up, steps, what to observe, questions and answers, trainer notes (duration, variant, a good response, mistakes, debrief) and a
  worksheet. E1 `wp1` beans 24 / 32 / 40 on the Oil example (645 / 914 / 1139 STB/d, all critical) against test T1 (Compare and QC: Beggs &
  Brill 147 psi low at the gauge, Duns & Ros first but provisional; J from T1 2.15). E2 `wp2` the Gas example at p̄r 2,500 psia loads
  (Turner 2.66 MMscf/d, −5 %) at 5,000 ft MD / 4,731 ft TVD, the bottom of the 3-1/2" top section; the tubing-size design lists margins
  from +215 % (1.900") to −13 % (current 3-1/2"), one 2-7/8" string unloads with +38 % at 2,598 Mscf/d. E3 `wp3` VLP tuning to T1 (m_h
  1.064 only, ρ = 1), Darcy k·h 80 × 30: skin +2.8 from the gauge tuned or not, from THP alone +6.0 untuned and +2.8 tuned; variant gauge
  2,800 psia → m_h at its bound. Every number is the engine's on the page examples (`wellperf-course` WC2–WC4). Text only, no images.
- **Help page / print** (`49-calc-help.js`, `49-calc-help-print.js`): `H.COURSES` [key, view kind, title, short label] — `sim` →
  `course` 'Well Test Simulator course', `wellperf` → `wpcourse` 'Well performance course'; `H.exercises(kind)`, `H.exerciseKind(id)`;
  a link and a contents entry per course, search module label per course, numbering per course, `[[course#wp2]]` opens the well
  performance course, `[[wpcourse|…]]` links the list. Print: the course chapter (13) after the field scenarios (earlier chapter numbers
  unchanged), worksheets per course in Print ▾, links to its exercises print "(see Chapter 13)". The help page subtitle says "the training
  courses".
- **Guide** (wellperf, A2 features, prose parts): PVT correlations, Correlations and flow regimes, Flowing temperature, Choke, Gas lift
  (quick look), Two variables and tubing size, VLP tuning (9.3 → 11.5 kB serialised of the 14 kB PART cap). Overview `help` purpose
  "two training courses" (reviewedSrc re-hashed); start FAQ "training" links the course.
- **Validator** (`help-content.test.js`): course ids per course (an exercise names a known course; the simulator file holds only
  simulator exercises), `wpcourse` group and link kind, the new file in CONTENT_FILES (also help-page, help-guide-sync, smoke lists).
  help-course.test.js unchanged (it filters the simulator group); help-guide-sync expects chapter 13.
- **Caps (a second raise — owner question Q21, not the Q15 default, which A1 used; see §18.2.9)**: SUM_CAP 357 → 369 kB, GZIP_CAP 124 → 128 kB (measured 367,974 raw, 127,744 gzip);
  per file: wpcourse 9.83 kB (new), production 45.41 → 47.67, 49-calc-help 47.6 → 48.52, print 15.33 → 15.68, start 19.74 → 19.8.
  Images: help/view re-taken (the course link in the bar), 218 files, 7,994,360 of 8,000,000 bytes; no wellperf shot was stale, none added.
- **Tests**: `wellperf-course` WC1–WC5 (shape and page text, E1 / E2 / E3 numbers, page / search / print per course).

#### 18.2.8 WPI2 record (2026-11-12, branch wp/a2, release 4.4)

- **Release**: RELEASE_NOTES v4.4 dated 2026-11-12 on top of v4.3 (both platforms; provisional methods marked), MARKETING_VERSION and both
  ci_post_clone.sh VERSION_BASE 4.4, static #appVersionLabel fallback v4.4; release-notes help shots re-taken (entry shortened so the
  image total stays under the 8 MB cap: 7,986,940 bytes); Rounds 3 and 9 rebuilt, LF, synced, guide regenerated.
- **GUI fixes** (49-calc-wellperf.js, from the sweep and a per-step / per-tab overflow pass at 390 and 1280 px): case-summary values wrap
  (`.rrow .rv` flexible, label ≤ 45 %); `.wp-drawer-b` items `min-width:0`; `.wp-mres`, `.wp-tplots`, `.wp-bench`, `.wp-2c`,
  `.wp-row3` and the phone drawer use `minmax(0, …)` tracks; `_fvfLab()` gives rm³/sm³ for Bo / Bw in Metric mode. reviewedSrc 3604f58b.
- **Gates**: smoke 347/347; accept-test --html --integration 2112/2112 (182 files); wellperf-validate --html --gate --check --time PASS
  (22/22, every E budget ok); wts3d 147/149 (CRLF checks); help-shots / build-user-guide / publish-site --check ok; GUI sweep (4 routes,
  full and --mobile) 0 findings.

#### 18.2.9 A2 review fixes (2026-11-12, branch wp/a2)

- **D17 choke default.** `surface.choke.subcritical` defaults to `'bound'` again (model DEFAULTS and the solver when the key is missing,
  so A1-saved models keep the A1 answers); the Sachdeva sub-critical branch is the option `'sachdeva'` (select order bound, Sachdeva
  provisional; case summary "sub-critical: conservative bound" / "Sachdeva branch (provisional)"; the Choke tab draws the bound's 0.588 and
  the Sachdeva curve "comparison only"). wellperf-validate gate 6 also fails when the sub-critical default is not the bound or a model
  without the key runs the branch. Help example back to q_s 319, tubing-curve minimum 561 STB/d; release note "Optional continuous
  sub-critical flow … (provisional; the conservative bound stays the default)". Tests WCK3–WCK6 opt in with `subcritical:'sachdeva'`.
- **Choke inlet temperature** in relaxation mode: the Sachdeva calls take the stream THT `_thtQ(C, q)` like the nozzle and the flowline
  (WCK7).
- **Vasquez-Beggs co on γgs**: with `pv.sep` the undersaturated Bo (Bo_undersaturated) and the F.table co use the 100 psig gas gravity
  (PV2-11); no `pv.sep` → unchanged. (μo above pb has no gravity term — that part of the review is not a defect.)
- **Petrosky-Farshad** Pb exponent 0.577421 (self-test 10 and PV2-4 at 1e-5). **Bw_mcCain** is an alias of Bw_meehan (one body).
- **GLPC**: the economic point on the incremental OIL slope dq_o/dq_inj (q_L when a point has no q_o); gas for 90 % interpolated from
  (0, 0) on a dead well; the optimum refined by 7 golden-section solves in the bracket around the best grid point (refined points flagged,
  rounded to 1 Mscf/d; GL_OPT_AT_START info when the grid optimum was the first non-zero rate) (WGL4, WGL7).
- **Report capture**: `#wp_studies` "Studies and tuning" inside `#wp_res` (PVT family and pb spread, temperature model and fitted U,
  gas-lift injection point MD · TVD / optimum / economic point / gain and gas for 90 %, VLP tuning m_h / m_f / RMS tuned vs untuned and
  applied, the sensitivity list or the 2-D grid with the model cell ●); step ⑦ text lists it (WGL8).
- **Rate list**: one parser for the gas-lift list and the sensitivity values (whitespace / ';'; ',' only without whitespace and without
  decimal comma; 'd,ddd' thousands, decimal-comma 'd.ddd,d' / 'd,d'); the page hands the model an array in field units (gasRateSmall);
  the label follows the unit system and the box is converted on a unit change; the model's string path reads thousands groups (WGL9).
  Tuning table rate through `_u` (WT7).
- **Plots**: `WTS_wp_view` lays marker labels out without overlaps (candidate positions, leader when moved), the lineX handle label and
  the vertical-line labels avoid them (falling back to the legend-only rule when there is no room); `legendNote` (one line) replaces the
  "(previous inputs)" suffix on every entry; legend entries are shortened with an ellipsis; top rails measure their label and value and
  drop the label on a short segment (WGL10, WT8, WRV19).
- **Page**: sensitivity values suggested again after an example and refreshed on restore when every p̄r value is below 0.3 × the model
  p̄r (WSN6); MD · TVD with the unit on the schematic gas-lift mark and the flow-regime map end label; the design message next to the
  design button (`#wp_designmsg`); no Use on the current tubing size; erosion ratio with 2 decimals; heat-map row headers sized to content;
  family chips separate name, pb and range (WSN5, PV2-12).
- **Not changed**: the second zeroin in `flowingTempFitU` (48-calc-wellbore loads before wp-system; the solver's tolerances are its own) —
  noted in the code. Q21 (second help-cap raise) recorded as an open owner question.
- **Gates**: node --check ok; smoke 347/347; accept-test --html --integration file by file 2122/2122 (182 files; +10 regression tests);
  wellperf-validate --html --gate --check --time: gate PASS (gate 6 checks the sub-critical default), 22/22 cross-checks, every E budget
  ok (GLPC with the refinement 144 E of 200); wts3d 147/149 (the two CRLF checks on an LF checkout); help-shots --check (release-notes
  and wellperf/sys desktop shots re-taken, 7,989,310 bytes), build-user-guide --check, publish-site --check ok; GUI sweep wellperf
  (desktop and --mobile) 0 findings; Chromium screenshots of the performance curve, the tuning rails and the studies block at 1280 / 390 px.

### 18.3 Increment B (v4.5)

WP20 lift-table and PVT-table export · WP21 Orkiszewski, Aziz-Govier-Fogarasi, Mukherjee-Brill, Ansari, Hasan-Kabir, per-section
correlation · WP22 enthalpy-balance temperature, layered U, J-T in the tubing · WP23 PVT lab match, Rv, emulsion · WP24 water-cut
composite, horizontal, fractured, multilayer, transient, injector IPR and VLP; Build-up Surveillance hand-off · WP25 gas-lift design on
the shared model, Thornhill-Craver, diagnostics, gradient survey import, Asheim · WP26 ESP · WP27 cases, compare, depletion forecast,
lift screening, operating envelope, tornado, 4-variable matrix · WP28 SVG well schematic, batch over wells (`WTS_wells` iteration as a
Job, read-only per well). WP25 and WP26 after WP22 is preferred (temperature at the valve / pump).

#### 18.3.1 WP23 record (2026-11-12, branch wp/b-wp23)

Owner default: every open question at its proposed default; Q9 (textbooks) not provided, so the differential → flash adjustment, the
modified black oil (Rv) and the two emulsion models ship provisional through the D17 gate (`wellperf-validate.js` BENCH kind `pvt`); the
lab match itself is least squares on the user's points (no published example needed, `pinned` to its closed-form check X22). Q21 open.

- **Engine (new `49-calc-wp-pvtmatch.js`, `WTS_wp_pvtmatch`)** as §5.1: `normLab`, `diffToFlash` (Bo_f = Bo_d·Bob_f/Bob_d, Rs_f = Rsb_f −
  (Rsb_d − Rs_d)·Bob_f/Bob_d below pb, Rsb_f above; without the separator Bob / Rsb the table is used as entered, warned), `labOil` (the lab
  oil at its own Rsb and the lab temperature), `predict`, `fit` (Pb one-point factor f, then Rs below pb, Bo, μo each y = a·y_corr + b by
  `PRiSM_lm` on relative residuals, each on the model matched so far; Rs and f solved together by a secant on f so the matched Rs reaches
  Rsb at the lab pb — a·Rs_c(p·f) is nearly a power law, so a and f trade off and only their product is identified; one point → a only;
  bounds a Rs 0.5–2, Bo 0.8–1.25, μo 0.2–5; flags outside 0.9–1.1 warn / 0.8–1.25 fail, at a bound, not converged; the LM answer is checked
  against the closed-form weighted least squares `wls`), `rank` (every Pb / Rs / Bo family by the mean of |pb error|, Rs and Bo MARE before
  the match; every dead × live viscosity pair by μo MARE on the matched Rs), `job` (a Job for `PRiSM_autoInterp.drive`: the fit, then one
  step per family and per viscosity pair), `preview` (hand edits of a / b), `example` (synthetic lab table = a known distortion of the
  Standing family, flagged `example:true`), `exampleRv`, `exampleEmul`, `emulCurve`, `rvCurve`, `METHODS`.
- **Marcher (49-calc-flowline.js `props` with `fluid.pvt`, additive; absent → A2 bit for bit, PM5 / X24 / FI1–FI6):** `pvt.shift {rs, bo,
  muo}` (the b of the match; a stays `pvt.mult`); with a matched Rs the undersaturated branch's pb is Pb_corr((GOR − b)/a)/f; `pvt.rv {rows,
  pd}` modified black oil for a wet gas — Rv(p) ≤ CGR (CGR at and above pd, linear between the last row and pd, constant below the first
  row) vaporised into the gas with the Standing well-stream constants (gas gravity and standard volume rise, free liquid falls; mass exact,
  X23), and the (p, T) table is binned in the gas gravity too (trilinear) for it; `pvt.emul {model, tight, inv, rows}` liquid viscosity by
  the new `WTS_flowline_emulsion(fw, μo, μw, e)` — Brinkman (1952) (1 − φ)^−2.5 with the dispersed fraction, Woelflin (1942) loose /
  medium / tight as chart readings (log-linear; readings to verify against the figure), water-continuous Brinkman above the inversion
  (default 60 %), or a user table (log-linear, constant beyond, no inversion rule). Exports `WTS_flowline_emulsion` (+ `.WOELFLIN`) and
  `WTS_flowline_rvAt`. Props rows gain `qoVap`, `qoFree` (Rv) and `emulRatio`, `emulCont` (emulsion).
- **Contract additions (additive).** M.fluid: `rv {mode 'none'|'table', pd, rows}`, `emul {model 'none'|'woelflin'|'brinkman'|'table',
  tight, inv, rows}`, `lab` (the record), `match {lab, on, pbFactor, mult, shift, corr, T_F, edited}` when adopted (else `{lab}` as A1).
  `wts_wellperf_model.lab` = `{v, T_F, basis, pb, rsbF, bobF, rows:[{p, rs, bo, muo}], rv:[[p, Rv]], emul:[[fw, ratio]], example, adopt:{on,
  pbFactor, mult, shift, corr, T_F, mare, ts, edited, labKey}}` cleaned by `WTS_wp_model.validate`. Scalars `wp_rvmode`, `wp_pdew`,
  `wp_emul`, `wp_emulT`, `wp_emulInv` (%, scale 0.01). `WTS_wp_fluid.build`: spec `match` (applied only while the fluid's rs / bo / muod /
  muo keys equal `match.corr`, else `MATCH_STALE`; a user pb wins, evaluated at the matched GOR), `rv`, `emul`; F gains `match {applied,
  stale, pbFactor, pbUserWins, mult, shift, corr}`, `rv {pd, rows}`, `emul {model, tight, inv}`; validity rows `pvtmatch`, `rv`, `emulsion`
  (provisional ones carry the D17 note) reach `WTS_wp_check` and the page's Correlation validity; warnings `RV_NOT_WET`, `RV_NO_TABLE`,
  `EMUL_NOT_OIL`, `EMUL_NO_WATER`, `EMUL_NO_TABLE`, `MATCH_STALE`. Defaults unchanged (rv none, emulsion none, no match).
- **Page (step ①).** Oil: **PVT lab data** (lab temperature, basis, lab pb, separator Rsb / Bob, the lab table editor with paste and
  **Example lab data**, **Match to the lab data** as a Job with progress / Cancel) beside **PVT lab match** (status of the adopted set, KPI
  chips with ✓ / ! / ✕ — bubble point error, Rs / Bo / viscosity error after (before) with a, best family —, flags, **Apply the match to the
  model** / **Remove the match**, a plot per property with the lab points, the unmatched and the matched curves, the lab and correlation pb
  lines and **a** / **b** rails that re-evaluate live and keep an adjusted match on release), then full width the matched-parameter table and
  the family and viscosity-pair rankings with **Use**. The Fluid properties plot overlays the lab points and draws the selected family
  matched and published. Gas-condensate: **Condensate drop-out** (wet gas default or modified black oil, dew point, Rv table, example) and
  **Condensate along the well** (dew point / drop-out start MD · TVD / free condensate at the wellhead chips; Rv and free condensate against
  pressure with a draggable dew point; free condensate along the operating traverse on TVD or MD with an MD · TVD read-out). Oil with water:
  **Emulsion** (mixture default, Woelflin, Brinkman, table; tightness, inversion) and **Liquid viscosity** (wellhead / bottom-hole liquid
  viscosity chips, μ_em / μo against the water fraction for every model on a log axis, the WC and in-situ lines and a draggable inversion
  point). Report: Studies rows "PVT lab match", "Best black-oil family against the lab", "Condensate: modified black oil", "Liquid
  viscosity: emulsion"; case summary; CSV section (lab, correlation and matched values, parameters). Help: notDocumented pattern for the new
  controls, wellperf / flowline reviewedSrc re-hashed, 36 bytes of loading / correlation wording trimmed to stay inside the 47.67 kB cap (no
  new help text — the lab match, Rv and emulsion are not described in the guide: a gap until Q21); no screenshot changed (the `sys` shot is
  step ⑤).
- **Tests / gates.** `wellperf-pvtmatch` PM1–PM12 (12). `wellperf-validate`: BENCH kind `pvt` (pvtmatch / table pinned; diffFlash, rv,
  woelflin, brinkman pending), gate 7 (registry vs BENCH, never a default, the label in the check validity), X22 (LM = closed form, matched
  pb = lab pb), X23 (Rv mass along the deviated traverse), X24 (unit match + none = the A2 solve), `--time` rows: solve with Rv (gas 15 E),
  with an emulsion (oil 22 E), the lab-match Job (≈ 80 ms, 900 property evaluations, no march). 25 / 25 cross-checks, gate PASS, E budgets ok.
  Gates: Round 9 rebuilt, LF, synced, guide regenerated; node --check ok; smoke 347/347; accept-test --html --integration file by file
  2134/2134 (183 files); wellperf-validate --html --gate --check --time PASS (25/25, every E budget ok); help-shots / build-user-guide /
  publish-site --check ok; Chromium screenshots of the three cards at 1280 × 800 and 390 px.
- **Known gaps.** No verifiable published example for any of the provisional methods (Q9); the Woelflin chart values are readings to verify;
  the match multipliers are applied at every temperature (fitted at the lab temperature only), Pb and Rs are matched only through their
  product (a and f trade off); no Z / Bg / μg lab match (gas lab data) and no separator-test optimisation; Rv needs a user (lab CVD) table
  (no Rv correlation), the condensate liquid keeps the constant B_c, and the shut-in gas column and the loading check ignore Rv; the
  emulsion applies to the tubing and flowline liquid viscosity only (not to the inflow) and drops at the inversion point (a step in the
  gradient); the lab table editor stacks a card per row at phone width (the shared editor style); help text for the three features not added
  (cap full, Q21).
#### 18.3.2 WP21 record (2026-11-12, branch wp/b-wp21)

- **Correlations (49-calc-wp-vlp.js, registry merge).** `ork` Orkiszewski (Griffith bubble = the H&B bubble branch; Griffith-Wallis slug
  with the v_b iteration and the liquid distribution coefficient Γ, four formulas, water-continuous above 75 % water, lower limits;
  the Duns & Ros transition / mist above L_S), `agf` Aziz-Govier-Fogarasi (N_x / N_y map, N1–N3 and N_x = 26.5; bubble / slug bubble-rise
  holdups; Duns & Ros mist; linear transition, continuous at N2 and N3), `mb` Mukherjee-Brill (uphill / downhill boundaries, the three
  holdup coefficient sets, annular f_R table, stratified separated-flow geometry; kind `any` so it is also a flowline choice), `ansari`
  Ansari et al. (bubble / dispersed bubble (Barnea) / slug unit with the film balance and β / annular film model of Alves et al. with
  the film friction factor taken equal to f_SL), `hk` Hasan-Kabir (drift flux with the inclined Taylor-bubble rise, bubble / dispersed /
  slug / churn, annular with the Lockhart-Martinelli void fraction and a Wallis-type interfacial factor on the Blasius base). Explicit
  equations only (no chart readings), units at the code. All five `verified:false` with the D17 label and §15.1 BENCH rows `pending`
  (Q9: no books); `defaultCorr` unchanged (Beggs & Brill). Vertical flags: ork, agf, ansari vertical-only (warn above 30°); mb, hk not.
- **Per-section correlation (contract additions, all additive).** `WTS_flowline_march` segment `corr` (a per-segment registry key;
  unknown → `UNKNOWN_CORR`; absent → as before, FI identities unchanged). `WTS_wp_vlp.traverse` `o.sections = [{by:'md'|'inc', from,
  to, corr}]` (MD ends split the segments; inclination band in degrees from vertical on each segment's average inclination; first
  matching row wins; elsewhere the base correlation) → result `.sections` (runs: corr, label, verified, vertical, row, MD / TVD / incl.
  range) and `.corrs`, `corr` on profile rows and segments, warnings per correlation in use (VERTICAL_ONLY per section, ranges,
  PROVISIONAL), SECTION_SKIPPED / SECTION_EMPTY; absent or `[]` → the A2 result exactly. New `normSections`, `sectionsFor`,
  `patternMap(F, q, traverse, {kind:'agf'|'mb'|'mech', corr})`, `agfMap`, `mbPattern`, `mbHoldup`, `mbFr`, `orkGamma`,
  `ansariPattern`, `hkPattern`, `MB_C`, `SEC_MAX` (12). Model: table key `corrSections` (validated rows) → `M.system.corr.sections`
  (DEFAULTS `[]`). System: `C.sections` passed to every well traverse (solve, tracking, gas lift parts, evalAt); `R.corr.sections` only
  when sections exist; PROVISIONAL flag per section correlation; a dry-gas key in a section of an oil / water well → CORR_NOT_APPLICABLE.
  `WTS_wp_check`: a validity row per section (`section: n`, vertical-only rule on the band / the survey inside the MD interval).
  Match: `compare` rows are pure (one correlation each); `pwfFromTest` / `iprFromTest` / `tune` march the model's sections when the
  correlation is the model's own (`o.sections` overrides). `WTS_wp_view.schematic` `o.bands` (correlation-by-section band).
- **Page.** Step ⑤ Correlations card: section bar (colour per correlation along MD) and a **Per-section correlations** table editor
  (By MD / Incl., From / To in the row's unit, correlation; read-only Covers column on MD · TVD and inclination, refreshed in place),
  presets "Deviated → Mukherjee-Brill", "Mechanistic by inclination", Clear. Traverse tab: a dashed line at each change of correlation
  with MD · TVD and the knob per MD-interval end on the right rail (drag → live tracking solves through a model override, release writes
  the table). Correlations tab: a **Per-section (in use)** row (= the solve) with every correlation row marched pure, a pattern strip per
  row (patterns along MD; the per-section row adds the correlation runs above), the five new rows; phone legend only for the selection.
  Flow-regime map tab: map switch Duns & Ros (A2) / Aziz-Govier-Fogarasi / Mukherjee-Brill / mechanistic (v_sg · v_sl; Ansari or
  Hasan-Kabir boundaries), default from the correlation in use, stations coloured by the map correlation's own patterns with MD · TVD
  read-outs and pattern counts. Schematic band and caption; case summary row (inside #wp_res). Help: one sentence (production file at its
  cap), wellperf and flowline guides re-hashed.
- **Tests / gates.** `wellperf-mech` VM1–VM10 (hand calculations of every explicit equation, the section contract, patternMap, the
  page). wellperf-validate: five BENCH rows, gate check that no default model carries sections, X1 / X2 extended to the five, X25
  (one section over the path = that correlation, identical; an MD split with the same key < 0.5 psi), X26 (single-phase water = Darcy-
  Weisbach), X27 (direction agreement of the five, oil and wet gas); `--time` rows per new correlation and a per-section traverse (1 E).
- **Known gaps.** No verified published example (Q9) — all five provisional. Ansari annular: film friction factor = f_SL; Hasan-Kabir
  annular friction is a Wallis-type factor on the Blasius base (the 2002 text form not checked); Mukherjee-Brill stratified ignores the
  interfacial shear in the combined balance; Orkiszewski and AGF transition / mist reuse the Duns & Ros chart readings (provisional).
  Sections apply to the producing well only (flowline keeps one correlation). The help screenshots of step ⑤ were not re-taken (image cap
  full); the guide carries one sentence (text cap).
#### 18.3.3 WP22 record (2026-11-12, branch wp/b-wp22)

- **Engine (`48-calc-wellbore.js`, additive):** `flowingTemp(column, opts)` takes `opts.layers [{topMd, botMd, U_to, ke?}]` (U by depth on the
  outside-radius basis; outside every layer the scalar U) and `opts.src(mdA, mdB)` → ψ °F/ft along the flow with `opts.srcCuts`. Per piece
  dT/dz = (T_ei − T)/A_k + ψ, solved exactly: T = T_ei + (T_0 − T_ei,0)e^(−L/A_k) + (ψ − s)A_k(1 − e^(−L/A_k)). Without both options the
  result is the v4.4 one bit for bit (no new keys; TT1–TT9 unchanged, TH1); with them the result adds `layers`, `Amin`, `Amax`, `src:true`
  and profile rows `psi`, `A`; `offsetOut` = (ψ − s)·A of the last piece. `flowingTempFitU` passes both through.
- **`WTS_wp_well` (additive):** `enthalpy(W, F, q, {rows, heat, budget})` — the steady enthalpy balance (Alves et al. 1992 unified form,
  Hasan & Kabir): ψ = η dp/dz − g sinθ/(g_c J c_p) − v_m dv_m/dz/(g_c J c_p) per interval of a traverse's rows (MD, TVD, p psia, v_m; a
  restriction belongs to the interval above), η the mixture J-T coefficient Σ x_i c_p,i η_i / c_p with in-situ mass fractions
  (WTS_flowline_props), gas η = R T² (∂Z/∂T)_p / (p M c_p) from WTS_gaspvt_z (equal to WTS_gaspvt_state.muJT within 0.5 %; the isenthalp
  as a fallback), liquids −(1 − βT_R)·144/(ρ J c_p) with assumed β oil 5.0e-4, water 2.5e-4 1/°F; η evaluated on the relaxation
  temperatures. Returns the relax() fields plus `mode:'enthalpy'`, `tht`, `thtRelax`, `tAtRelax`, `dT`, `intervals[{md0, md1, eta, x,
  dpdz, psiJT, psiG, psiK}]`, `eta{top, bottom, min, max, gasSource}`, `budget{tIn, loss, jt, grav, kin, tOut}` (linear superposition on
  the same piece cuts — closes exactly), `beta`, `provisional`, `verified:false`; `NO_PROFILE` without rows. `jtMix(F, q, p, T, hf?)`,
  `ENTH {beta, J, gc, label}`. Layered U (`heat.layers [{topMd, botMd, U (model basis), ke}]`) applies to `relax()` too (adds `layers`,
  `Amin`, `Amax`; null without layers). `fitU(W, F, q, tht, {rows})` fits U with the enthalpy source held (one fixed-point pass on the
  property temperatures; `model:'enthalpy'|'relax'`). `temperature(W, {mode:'enthalpy', profile})` → verdict `'enthalpy'`, thtHyd = the
  profile THT (the J-T change is in the profile; no double correction). Schematic: profile keys `tRelax`, `djt`; `heatLayers [{topMd,
  botMd, topTvd, botTvd, U, ke}]`. Version '4.5-wp22'.
- **`WTS_wp_system`:** `M.well.heat.mode 'enthalpy'` — per rate a predictor traverse bottom-up from the IPR's pwf(q) on a coarse path
  (pieces of one bore merged to ≤ 1,500 ft, true TVD change kept), step 4 × stepFt (≤ 400 ft), no refine, its own frozen grid (`R.grid.pred`,
  passed by `warm` and `evalAt`), on the relaxation profile; then `enthalpy()` on its rows is the march's tProfile and the THT at q (cache by
  q). Counted ¼ E each (`R.counts.pred`, present only in this mode). `R.heat` adds `thtRelax, dT, eta, beta, budget, passCheck` (THT
  re-run on the reported traverse pressures: 0.005 °F oil, 0.11 °F gas), `intervals`, `layers`, `Amin`, `Amax`; traverse rows `tRelax`.
  Gas lift and a failed balance fall back to the relaxation (`ENTH_FALLBACK`), no geotherm to linear (`R.heat.enthFallback`). Flag
  `PROVISIONAL_TEMP` names the enthalpy balance.
- **`WTS_wp_match.thtFit`:** in the enthalpy mode each test with a THP is marched down (400 ft, no refine) and U fitted with that source
  (`row.model`). `compare` / QC_THT keep the A2 paths (the enthalpy mode is marched like the linear mode with each test's THT).
- **Model:** `wp_heat` enum adds `'enthalpy'`; `geo.layers [[topMd, botMd, U, ke|null]]` in `wts_wellperf_model` (validated, ≤ 20 rows,
  present only when given) → `M.well.heat.layers`. DEFAULTS unchanged (linear; no layers key).
- **Page:** temperature option "Enthalpy balance (J-T, gravity, kinetic; U by depth)" (relaxation inputs serve it too); step ③ box
  "Enthalpy balance at the operating point" (THT, against the relaxation, J-T coefficient at the perforations / wellhead in °F/psi or °C/bar,
  U layers with the A range, pass check) and an energy-budget waterfall (reservoir → heat to the earth → J-T → gravity → kinetic → THT,
  HTML bars with CSS transitions, reduced-motion off); heat-layer table (MD with computed TVD columns; re-rendered on a geo write from
  elsewhere); traverse: "Temperature (enthalpy balance)" with the dashed relaxation curve, U / TIME rails re-solve live; schematic: layer
  sleeves labelled with U (component, click / Enter edits the row) and "J-T + gravity ΔT" colouring; KPI THT chip "enthalpy · J-T etc. ±x";
  checks, case summary, studies and Notes in `#wp_res`. Help: one sentence in the wellperf "Flowing temperature" part; reviewedSrc updated.
- **Validation:** BENCH `temp enthalpy` pending (Q9: no verifiable published traverse), gate 5b (label, never the default); X40 (march with a
  step source and two U layers vs RK4 on the deviated FIX.gasWell path 9.9e-4 °F; adiabatic gravity lapse), X41 (liquid identity J-T +
  gravity = −βT_R sinθ/(J c_p) exact; η_gas vs real-gas μ_JT; budget closure), X42 (pass check < 0.5 °F); `--time` rows "system solve,
  enthalpy temperature": oil 27.8 E (27 predictors, budget 34), gas 20.3 E (budget 30), ≈ +15–20 % ms over the relaxation. (Numbered X40+
  to avoid the X22–X25 of WP20 / WP21.) Tests `wellperf-temp3` (10: TH1–TH10).
- **Gaps:** J-T across the drawdown at the sandface not included (inlet = reservoir temperature); gas lift uses the relaxation; liquid β
  constants assumed; the predictor pressure (IPR pwf, coarse path) is one pass (pass check reported); QC_THT band and `compare` stay on
  the relaxation / linear paths; no new help screenshot (cap full); layer boundaries are edited in the table (no drag handle).
#### 18.3.4 WP24 record (2026-11-12, branch wp/b-wp24)

Owner default: every open question at its proposed default; Q9 (no textbooks) → every model below ships `verified:false` with the D17
label, is never a default, and has a `pending` BENCH row in `wellperf-validate.js`.

- **Inflow models (49-calc-wp-ipr.js, additive; `WTS_wp_ipr.B_KEYS`)**: `wcComposite` (water-cut-weighted composite after Brown 1984: PI
  above pb, f_w·water PI + f_o·oil Vogel below — the oil branch is `WTS_oilipr_model` composite — and past q_o,max the straight line with
  the exact limit slope −(f_w + 9 f_o)/J; f_w = `params.fw` or the fluid WC); `joshi` (Joshi 1988, anisotropy term in the form of
  Economides et al., r_eh = `re`); `babuOdeh` (Babu & Odeh 1989 box, ln C_H, partial-penetration s_R cases 1 / 2 with F(x) on both
  branches; outside both cases → case 1 with a warning); `furui` (Furui, Zhu & Hill 2003); `frac` / `fracGas` (Prats r_w′ = x_f/2 and the
  closed-form fit of the Cinco-Ley & Samaniego F_cD curve, 0.1–1,000; s_f joins S in darcyOil / darcyGas exactly); `transient` (line-source
  log approximation at a flowing time; t_D < 100 and past-t_pss warnings; J(t) exposed); `multilayer` (commingled layers from
  `res.layers`, each at its own TVD from the well path, wellbore gradient from the fluid; crossflow on the layer PI / reversed LIT; p_ws by
  bisection; layer rates and the shut-in crossflow); `injector` (water II·(pwf − p̄r) or Darcy II with Bw / μw; gas reversed m(p) LIT;
  `pfrac`). The horizontal lateral L defaults to the perforated MD interval (deviation first class). `fromBuildup(state, {midPerfTvd})` —
  the Build-up Surveillance hand-off: the latest interpreted test → k, h (or kh/k), S, rw / re, p̄r = p_ext moved from the Build-up datum by
  its static gradient (p* flagged); `fracSkin`, `babuOdehX`, `transientJ` exported.
- **Injection wells (new 49-calc-wp-inj.js, `WTS_wp_inj.solve`)**: `WTS_wp_system.solve` delegates waterinj / gasinj to it. VLP = the ONE
  marcher with the flow down the deviated path (`WTS_wp_vlp.traverse` option `inject`: segment rise −dz, forward from the THP / reverse
  from the bottom); one stable root by scan + Brent; fracture limit p_frac (input, else the DFIT closure gradient × mid-perf TVD, provisional);
  q_frac, the highest THP without fracturing, the THP to start injecting, verdicts ok / warn (5 %) / fail; breakdown sums to THP − p̄r.
- **Contract changes (all additive; absent → A2 bit for bit)**: `WTS_wp_ipr.curve(spec, F, o)` reads `spec.layers`, `spec.perf` and
  `o.tvdAt` / `o.refMd`; I gains `kind` 'inj' | 'any'-resolved, `horizontal`, `frac`, `transient`, `layers`, `layerRates(pwf)`, `crossflow`,
  `prInput`, `inj`, `pFrac`, `qLimit`, `II`, `injector`; registry entries gain `horizontal`. `WTS_wp_model`: table key `layers` (≤ 10 rows,
  `{name, topMd, botMd, tvdTop, tvdBot, pr, J, pb, k, h, S, a, b, use}`) → `M.res.layers`; `M.res.perf {topMd, botMd, midMd}`. The solver
  builds W before I and passes the well path to the inflow; R gains `layers {rates, crossflow, pws, grad, thief}` (producers) and, for
  injectors, `injector: true`, `inj {…}`, `rates.injection`; flags `CROSSFLOW`, `INJ_FRAC`, `INJ_FRAC_NEAR`, `INJ_FRAC_DFIT`, `INJ_NO_FRAC`,
  `PROVISIONAL_INJ`; check items `INJ_MODEL`, `INJ_THP`, `INJ_CHOKE`, `INJ_MODEL_PROD`, a validity line for a B model in use.
  `WTS_wp_vlp.traverse` option `inject`. `WTS_wp_view.schematic` options `layers`, `inject`, `frac`, `lateral`. Fluid types gasinj /
  waterinj enabled on the page (the gas-injector "later release" note removed).
- **Page**: new IP fields (L, kv/kh, box a / b, x0 (`xPos`), z0 (`zPos`), y_mid, y_b, x_f, F_cD, φ, ct, t, II, p_frac), a Layers table card
  (MD, TVD from the survey, live rate at the operating point, red on crossflow), the **Inflow study** plot with a live drag handle per model
  (J vs flowing time, J vs lateral length with the vertical-well line, J vs x_f with infinite conductivity, the WC rail on the composite
  split, layer rates on TVD with the shut-in crossflow, injection rate vs THP with the fracture limit), the IPR plot with per-layer curves /
  p_ws / p_frac / q_frac, injector KPI strip (rate, BHP, THP, fracture margin, max rate, injectivity, temperature, erosion), one extra KPI for
  the producer B models (Crossflow / Lateral / Fracture / Flowing time), injector operating-point card, verdicts, system plot (fracture
  line, THP handle), schematic beds with inflow / crossflow arrows, injection arrows, fracture wings, lateral label; **Import from Build-up
  Surveillance** (async through `WTS_buildup.store`, provenance chips); report capture through `#wp_studies` "Inflow: …" rows; examples
  **Horizontal**, **Layers**, **Injector**. Help: the wellperf guide step text (examples, B models, Build-up import) within the existing cap
  (production 47,653 of 47,670 bytes), reviewedSrc d3fa5380; no screenshot added or re-taken.
- **Tests / gates**: `wellperf-ipr2` IP2-1 … IP2-15 (14 unit + 1 integration); wellperf-ipr IP9 limited to the A1 keys. wellperf-validate:
  9 BENCH rows (pending), gate 8 (each B model provisional in the check validity; the injector flag), X28–X35 (30 / 30 pass), `--time` rows
  injector solve 15 E of 20 and two-layer solve 23 E of 24. Accept-test `--html --integration` 2137 / 2137 (183 files, file by file);
  smoke 347 / 347; help-shots / build-user-guide / publish-site `--check` ok.
- **Known gaps**: no verified published example for any B model (Q9); horizontal and transient models are oil only (gas horizontal via
  fracGas / darcyGas only); Babu-Odeh kx = ky; the injector temperature is the linear profile (no inject-direction relaxation), no injector
  design / sensitivity / match (`_ctx` refuses them), the injection-rate-vs-THP study shifts the outflow by ΔTHP (exact for water, approximate
  for gas); the transient model is not wired to PRiSM C3 directly (Import from PRiSM fills k, h, φ, ct, rw, S); multilayer layers use one
  wellbore gradient (static, at the mean layer pressure) and no per-layer PVT; Build-up import reads the localStorage summary (the per-test
  arrays of an overflowed state are not needed); help text for the B models is one line (the cap is full; no new screenshots).
#### 18.3.5 WP20 record (2026-11-12, branch wp/b-wp20)

Owner default: Q4 at its proposed default (the lift-curve table text format, producer / injector, + CSV); Q9 not provided — a table export
is a format, not a method, so it adds no D17 gate entry of its own; it carries the provisional label of every unverified method it uses.

- **Engine (new `49-calc-wp-export.js`, `WTS_wp_export`).** Axes: rate `OIL` | `LIQ` | `GAS` | `WAT`, THP (psia), water fraction `WCT` |
  `WOR` | `WGR`, gas fraction `GOR` | `GLR` | `OGR`, lift quantity none | `GRAT` (the `ALQ` registry is open: WP26 adds the pump frequency
  with an `apply()`); value = BHP at the datum. Each point is the solver's own top-down evaluation at that THP (`WTS_wp_system.evalAt`,
  outflow only): the model's correlation, multipliers, temperature model, restrictions, deviated path and, on a lift-gas axis, the A2
  injection point solved inside the point; choke / flowline / separator are not in a table. One solver context per (WFR, GFR, ALQ)
  combination, one frozen step layout per THP row recorded at its middle rate (BHP smooth along each row; X43 ≤ 0.1 psi against a
  fresh evaluation, the middle rate exact). Datum = an MD (default the mid-perforations; deeper is clamped), read on the traverse; the
  record carries its TVD. Injector tables (`waterinj` / `gasinj`): the one marcher `WTS_flowline_march` down the reversed path with the
  rise negated (hydrostatic gained, friction lost), the well's linear temperature (INJ_TEMP note). Lost points (a march over pMax, a
  lift point whose gas cannot enter) are filled along the rate axis (interpolated; above the last valid rate a straight line never
  falling — never rising for an injector, ≥ 1 atm; below the first valid rate held; a whole lost row from the next THP row + ΔTHP), listed in
  the notes, the text header and the CSV flags. **Monotonicity (deviation from §9 as written):** BHP rising with THP is checked on every
  column; along the rate axis a row is checked for a SINGLE MINIMUM (falling branch, then rising) — BHP is not monotone in rate left of
  the tubing-curve minimum, which is physical; a second minimum (a correlation's flow-pattern switch, e.g. Beggs & Brill on the wet-gas
  fixture at 1,400 psia) is flagged, never smoothed. `liftJob` (PRiSM_autoInterp.drive; a step evaluates points for up to 20 ms, at
  least one — `sliceMs: 0` = one point per step), `liftTable`, `fill`, `monotone`, `text` / `parseText` (round trip), `csv`, `slice`,
  `interp`, `suggest` (10 × 5 × 4 × 4 × 1–4 around the operating point), `normalize` (≤ 12,000 points). PVT (B9): `pvtTable` (the rows
  of `WTS_wp_fluid.table` at the reservoir T, the bubble point always a row), `pvtCsv` (field, or metric through WTS_units), `pvtText` /
  `parsePvtText` (black-oil PVT table text format: live oil with the undersaturated branch under the bubble-point Rs, dry gas, water with
  cw and viscosibility by central differences; a wet gas exports the gas table only, D14).
- **Contract changes (additive).** `WTS_wp_system.evalAt(M, q, o)`: `o.outflowOnly` (no inflow built or needed, pIn NaN, pMax default
  30,000 psia), `o.pMax`, `o.ctx` (from the new `WTS_wp_system.context(M, o)` → `{ok, C}`; one fluid build / property table reused) and
  `o.thp_psig` (with ctx: the fixed THP of this evaluation). Defaults unchanged (`solve` identical). Page: `#wp_ltsum` inside `#wp_res`;
  step ⑦ mounts `WTS_wp_tables.html()` and calls `bind()` after `_bindRoot()`.
- **Page (new `49-calc-wp-tables.js`, `WTS_wp_tables`).** Step ⑦ "Lift-curve tables" card: axis types (only the applicable ones
  enabled) and values in the table's field units, table number, datum MD with its TVD on the surveyed path, Fill from the model (axes
  follow the model until edited), point count and time estimate, Run (Job with progress and Cancel), downloads (text, CSV). Results: KPI
  chips (points, filled, BHP vs THP, single-minimum rows, datum MD · TVD, run time), sliders for the WFR / GFR / ALQ slice, an
  interactive chart (BHP vs rate, a curve per THP, filled points hollow, the model's inflow with the operating point at each THP when the
  slice is the model's fluid, a draggable rate line reading every THP's BHP; no legend box on phones — the readout row carries the
  colours), the slice table with each row's minimum. "PVT table export" card with preview pills and two downloads. Controls `wplt_*`
  autosave but never solve. The summary `#wp_ltsum` (table, axes, datum MD · TVD, ranges, correlation, ✓ / ⚠ verdicts, provisional
  labels; "(previous inputs)" after a model change) is in the page report and the Quick Report.
- **Tests.** `wellperf-export` WX1–WX10 (axes, solver identity, Job / cancel, text round trip and record layout, fill and monotonicity,
  CSV, lift-gas axis identity, PVT tables, injector hydrostatic, page). Validate: gate 9 (export labels, defaults), X43–X46, timing rows
  (800 points 800 E ≈ 12.7 s; 3,200 projected ≈ 51 s of 60 s; lift-gas table reported only, ≈ 1.7 E per lifted point).
- **Help.** Text only, within the caps: the wellperf guide's notDocumented pattern takes `^wplt` (the production file is 47,666 of 47,670
  bytes); reviewedSrc re-hashed. No screenshot. **Gap:** the guide does not describe the lift-curve / PVT table export (no room under
  the cap).
- **Known gaps.** The 3,200-point budget is met with little margin on a loaded container (≈ 51–56 s); lift-gas tables cost ≈ 4× per
  point; injector tables use the linear temperature profile (WP22 / WP24 should supply the injection temperature and injector VLP —
  then `_injPoint` should call that); ESP frequency axis waits for WP26; no datum mark on the well schematic.
#### 18.3.6 WP27 record (2026-11-12, branch wp/b-wp27)

Owner default: every open question at its proposed default; Q9 (textbooks) not provided, so the forecast tank models and the lift
screening ranges ship provisional through the D17 gate (`wellperf-validate.js` BENCH `forecast gasTank`, `forecast oilTank`,
`screen lift` pending); none is a default (the forecast's default mode is the p̄r steps, which run the solver alone).

- **Cases (US18, A3)** — new 49-calc-wp-cases.js `WTS_wp_cases`: `make` (name, kind base | matched | proposed | other, the page's scalar
  contract `WTS_wp_model.SCALARS` + `wp_ip_*` only, the tables survey / strings / restrictions / geo / flowline / rating / beans / lab /
  pump — never the tests), `add` (replace by name keeps the id; ≤ 20), `rename`, `remove`, `diff`, `model(c)` (the frozen M through
  `WTS_wp_model.read` on an in-memory record, so a case solves exactly like the page — WCA2), `compare` (a Job: one cold solve per case,
  the first is the reference, Δ %, the inputs that differ, IPR / outflow per case), `csv`, `summary(R)`. Stored in
  `wts_wellperf_model.cases` (per well, project files; written only by the page through `WTS_wp_model.write`).
- **Depletion forecast (§8)** — `WTS_wp_forecast` (same file): `job(M, spec)` — `steps` (default): future p̄r with optional WC / GOR per
  step, the first step a cold solve (= the single solve when p̄r is the model's), the rest tracking solves; `tank`: explicit (forward
  Euler) time steps on a gas p/Z tank (well-stream Z with impurities, wet-gas vapour equivalent from `WTS_wp_fluid.recombine`) or an oil
  Havlena-Odeh tank (N, m, S_wi, c_w, c_f; PVT from the model's fluid; the producing GOR of each step from Corey curves on the
  material-balance saturations once S_g > S_gc (n_o 3, n_g 2, S_gc 5 %; `gas:'retained'` = no free gas produced) fed into the outflow);
  events: liquid-loading onset with the limiting MD · TVD, the step where lift is needed (no stable root), abandonment p̄r / rate; the
  decline / EUR cross-check reads `PRiSM_declineResults()` when PRiSM has a decline fit. `tank(M, spec)` exposes the pure balance
  (`pAt`, `pAtGp`, `step`, `at`, `gorAt`). Measured: 24 gas steps 114 E, first-order convergence (12 / 24 / 48 steps: ratio 0.51, 24
  steps within 1.9 % of 48 — X51); a first finding during development: "produce the liberated gas at once" is not a valid closure below
  p_b (the voidage needs free gas), hence the Corey GOR.
- **Operating envelope** — new 49-calc-wp-envelope.js `WTS_wp_envelope.job(M, o)`: the wellhead deliverability THP_av(q) is the solver's
  wellhead-node inflow (`WTS_wp_system.evalAt` on one frozen layout, ≈ 1 E per rate, 14 rates + the maximum-rate crossing + one exact
  march at each limit), the flowline back pressure from `WTS_wp_system.boundary`; limits: static stability at a fixed THP (right of the
  THP_av maximum), liquid loading (q = q_c of that traverse), the wellhead rating, the maximum rate, the tubing erosional ratio,
  drawdown, a minimum pwf, p_b at the mid-perforations, a facility rate; the window, its binding limits and the operating point
  checked; `at(res, q)` interpolates for the drag handle. Node independence X47 (0.11 %), maximum rate = `maxRate` X48 (0.32 %); at the
  loading limit a fixed-THP solve has margin ≈ 7e-6 (WEN2).
- **Lift screening (§7.4)** — `WTS_wp_screen` (same file): `matrix(M, {R, W})` (natural flow, continuous gas lift, ESP, rod pump, PCP,
  jet pump, plunger; depth TVD / MD, liquid rate, maximum inclination and dogleg of the survey, BHT, API, GLR, H₂S / CO₂, lift gas; pump
  setting windows on MD · TVD by dogleg / inclination limits) and `job(M, o)` (natural = the solve, gas lift = the quick-look optimum on
  a short list with a stated screening casing pressure when step ④ has none, ESP only when the solver answers `R.lift.type 'esp'` —
  WP26 — never the natural-flow number, and the pump potential = the IPR at a minimum pwf).
- **Tornado and 3 / 4 variables (§6.2)** — 49-calc-wp-sens.js: `tornado(M, o)` (Job; base = the single solve, each low / high a tracking
  solve from the base; default ranges `TORNADO`; `tornadoCsv`); `job` with three or four variables now runs `jobN` (breadth-first from the
  start cell, each cell warm-started from the neighbour it was reached from; result `nd:true`, `keys`, `axes`, `strides`, flat `q` /
  `stable`, `cases[{values, R, idx}]`); `table` / `csv` carry every variable.
- **Contract changes (additive unless stated).** New namespaces `WTS_wp_cases`, `WTS_wp_forecast`, `WTS_wp_envelope`, `WTS_wp_screen`.
  **Changed:** `WTS_wp_sens.job` with 3–4 variables returns the matrix instead of `{ok:false, code:'B_ONLY'}` (tests WSE / WSN2 updated);
  new `WTS_wp_sens.tornado`, `tornadoCsv`, `TORNADO_ORDER`. `WTS_wp_view.chart` series kind `'poly'` (closed filled polygon, `alpha`);
  `WTS_wp_view.schematic` marks kinds `'window'` {md, md2} (bracket beside the hole) and `'tick'`. Page (49-calc-wellperf.js): a generic
  extension registry `window.WTS_wellperf_ext[name] = {resHtml, stepHtml(n), render(live), act, change, input, studies, marks, sysPlot,
  csv, notes, reset, resize}` called at fixed points (name order, errors logged, never thrown), and `WTS_wellperf_page.ui()` (the page
  helpers: display units, cards, `drive`, the input path); no change when no extension is registered. The WP27 page part is the
  extension 49-calc-wp-studies.js (`WTS_wellperf_ext.studies`).
- **Page.** #wp_res "Studies" card (tabs Operating envelope · Depletion forecast · Tornado · Matrix (3–4 variables) · Cases; one shared
  canvas, so the active tab's plot, KPI chips and table reach the report and the Quick Report; controls `.rp-skip`): envelope with the
  window band between the curves, constraint lines, the draggable point along the curve (live read-out THP / choke Δp / pwf / drawdown /
  erosion / loading and ✓ / ✕ per limit; release → Bean for this rate (the design Job) → Use this bean); forecast with rate / p̄r /
  cumulative / material-balance views, a time line and a slider that move the IPR and the operating point of that time on the system
  plot, the loading-onset tick on the schematic; HTML tornado bars (select → Use low / high); the matrix heat map with column / row
  selectors and sliders for the other variables, rate lines, Use these values; case cards (Compare / Load / Delete), overlay, Δ % and the
  inputs that differ. Step ④ "Lift screening" card (the matrix follows every solve; the rate bars on a button; the ESP setting window
  bracket on the schematic after a run). `#wp_studies` rows for every study; CSV sections; Notes for the provisional methods.
- **Tests** (19): `wellperf-cases` (WCA1–2, WFC1–4), `wellperf-envelope` (WEN1–3, WSC1–2), `wellperf-tornado` (WTN1–3), `wellperf-studies`
  (WST1–5, page incl. report capture and the 60 kB snapshot). Validate: gate rows above, X47–X52, `--time` rows envelope (oil 50.5 / gas
  45 E of 60), forecast 24 steps (114 / 48 E of 160), tornado 7 variables (85 E of 136), matrix 3⁴ (432 E of 500), screening (100.5 E
  of 120). Smoke: the namespace check lists the new namespaces (count 347 unchanged).
- **Help.** The production help file was 1 byte under its 47.67 kB cap: the `wpv_*` controls are one notDocumented pattern (`^wpv_`)
  and the guide's top-block line names the studies; no study part, no screenshot (help shot `sys` unchanged). Gap: the studies have no
  guide text until the owner decides a cap (Q21 open).
- **Known gaps.** Forward-Euler time steps (≈ 2 % on the cumulative at 24 steps; no predictor-corrector); the oil tank has no aquifer,
  the Corey exponents and S_gc are defaults, the gas tank is volumetric; screening ranges are indicative and rod / PCP / jet / plunger
  have no rate model (C); the ESP rate needs WP26; the envelope's erosion limit is the tubing only (the flowline is in the system
  solve's erosion KPI); the operating-envelope point starts on the operating point (the marker and the handle overlap until dragged).
#### 18.3.7 WP28 record (2026-11-12, branch wp/b-wp28)

- **`WTS_wp_batch`** (new, `49-calc-wp-batch.js`, engine, no page): `sources(o?)` (the `WTS_wells` list; the open well reads the live
  storage, a parked well its blob through `WTS_wells.captureWell` — a copy, nothing written; a project without `wts_wells` is one well;
  `o.wells` injects wells for tests), `readWell(src, {scalars})` (`WTS_wp_model.read` with a getter-only storage whose setItem throws;
  `NO_INPUTS` when neither `wts_page_wellperf` nor `wts_wellperf_model` exists), `summarise(M, R, W, L?)` (one row: rates, p_wf, THP, THT,
  bean, stability, q / q_s, loading margin (WTS_wp_loading when the solve has none), correlation + provisional, warning flags, verdict
  ok / warn / fail / none, decimated IPR / outflow curves, and the deviation of the well: mid-perf MD · TVD, TD, max inclination,
  departure, horizontal length at ≥ 80°, a ≤ 60-point trajectory), `job(o?)` (one well per step for `PRiSM_autoInterp.drive`; progress,
  label "name (i of n)", cancel within one well keeps the finished rows, `ids` subset, `liveScalars` for the open well) → `{ok, v, rows,
  totals (stable wells only), counts, evals, ms, cancelled?, errors, warnings, ts}`, `table` (20 columns, field units), `csv`, `key(M)`
  (8-hex model hash) and `storedFrom(M)` (a model as a well stores it — the inverse of `read`, exact on FIX.oilWell / gasWell). Read only:
  no storage write, no event, no switch, no page calc (WW2).
- **Page** (additive; the UI in `49-calc-wp-wells.js`, `WTS_wp_wellsUi`, so the page file only gets hooks): `#wp_wells` inside `#wp_res`
  (empty until a run; with several wells and no run an `.rp-skip` call to action "Run all wells"), step ⑦ card "All wells in the project"
  (`data-act="wellsrun"`). After a run the card carries KPI chips (wells solved n / n with inputs, oil, water, gas of the stable wells,
  unstable, loading risk), an interactive map `#wp_cv_wells` (WTS_wp_view.chart: crosshair 'near' read-out, zoom / pan, legend) with three
  views — **Normalised** (q / AOF against p_wf / p̄r, every well's inflow and outflow, oil and gas together), **Rate – BHP** (liquid or gas
  wells, a switch when both), **Well paths** (vertical section against TVD, each well's mid-perforation, MD · TVD on hover) — click a point
  or a table row (Enter / arrows on the rows) to pick a well, **Open this well** (`WTS_wells.switchTo`, the only write, a user action), a
  stale chip when the open well's inputs or the well list change, **Run again** / **Export CSV**; the page CSV bundle appends the table.
  Views are the device pref `wtspref_wp_plots.wellsView` / `wellsKind`. The result lives in memory (survives a well switch, not a reload).
- **Contract changes (additive)**: `WTS_state.wellperf.wells` = `{ts, counts, totals, cancelled, rows:[{id, name, status, verdict, gas,
  q, qo, qw, qg, pwf, thp, tht, stable, midMd, midTvd, incMax}]}` or null; `WTS_wellperf_page.ui` (page helpers: u, dv, lab, fmt, esc,
  vHtml, drive, liveScalars, reduced, phone) and `.publishWells()`; `resetJobs()` also clears the wells result; data-act `wells*`.
  `WTS_wp_view` 1.1.0: `schematic(S, o)` takes `o.layers [{topMd, botMd, label, color}]`, `o.sections [{fromMd, toMd, key, label, color,
  provisional}]` (rail beside the flow path + legend; `o.prop 'correlation'` paints the path by section, provisional dashed), marks kinds
  `'esp' {md, label}` (pump / seal / motor along the hole) and `'mandrel' {md, state 'operating'|'open'|'closed'|'orifice'|'dummy', label}`,
  `o.deviation` (default on when the maximum inclination ≥ 5°: KOP at 3°, each stretch ≥ 80° and ≥ 2 % of MD bracketed with its length);
  returns `dev {kopMd, kopTvd, incMax, incMaxMd, hz[]}` and `sections`; `devInfo(traj, o?)` exported. A vertical well draws as before.
  The page feeds the schematic from what the B engines supply — **for WP21 / WP24 / WP25 / WP26**: `R.lift.marks` (any mark kind) or else
  `R.lift.valves [{md, state | operating, label}]` (mandrels) and `R.lift.pumpMd` / `M.lift.esp.pumpMd` (ESP); `M.res.layers [{topMd,
  botMd | topTvd, botTvd, label | name}]`; `R.corr.sections` / `M.system.corr.sections [{fromMd, toMd, key}]` (without them the
  "Correlation" colouring shows the well correlation from the wellhead to the mid-perforation). Colour by gains "Correlation"; the hover
  read-out adds the section correlation and the layer; the caption adds the maximum inclination (MD · TVD), the KOP and the horizontal
  length; ESP / mandrel marks open step ④.
- **Tests / gates**: `wellperf-wells` (10: WW1–WW10 — sources, read only, row = single solve for the open and a parked well, no-input /
  no-solution rows and totals, Job progress / cancel / subset, deviation per well incl. a horizontal well, table / CSV, page card with
  report capture, views, selection, Open this well and the stale chip, schematic view additions, page schematic caption / colouring /
  lift-marks contract). `wellperf-validate`: X53a (each stored well = its single solve, identical), X53b (KOP 1,100 ft MD and the 500 ft
  hold on FIX.devSurvey), `--time` row "all wells, 2 wells" (37 E against 2 × 24). No gate row: the batch adds no method (D17 unchanged).
- **Help**: the `wellperf` guide re-hashed (reviewedSrc), text unchanged — the production help file is at its byte cap (47.67 kB), so
  "Run all wells" and the schematic marks are not described (gap, Q21). No new screenshot. Browser shots at 1280 × 800 and 390 px in the
  session scratchpad (`shots-b-WP28`), no horizontal overflow.
- **Known gaps**: the batch result is not persisted (a reload clears it); parked wells are solved from their saved inputs only (no PRiSM
  or DFIT import at run time); the well-path map is not equal-scale; the horizontal length counts trajectory points at ≥ 80° (within one
  point spacing); layers / sections / ESP / mandrels appear only once WP24 / WP21 / WP26 / WP25 supply the fields above.

#### 18.3.8 B integration record (2026-11-12, branch wp/b)

Merged with --no-ff in the order WP23, WP21, WP22, WP24, WP20, WP27, WP28 onto master 8ce1989. Generated files (combined-round9.js,
well-testing-app.html, ios-app/www, help/user-guide.html) were never merged by hand: Round 9 rebuilt, LF, synced and the guide regenerated
after every merge; the wellperf and flowline guides re-hashed (reviewed v4.5). Resolutions that change a WP record:

- **Cross-check ids** (each WP numbered from X22): WP23 X22–X24, WP21 X25–X27, WP24 X28–X35, WP22 X40–X42, WP20 X43–X46, WP27 X47–X52,
  WP28 X53a / X53b; gate sections 7 (PVT, WP23), 8 (B inflow, WP24), 9 (exports, WP20), 10 (forecast / screening, WP27). The records
  above carry the new ids.
- **Page table names**: WP22's heat-transfer layer table is `hlayers` (`#wp_tbl_hlayers`, still stored in `geo.layers`); `layers` is WP24's
  reservoir layer table (model key `layers`). The WP22 sleeve CSS is scoped to `.wp-comp.wp-layer`.
- **Schematic layers**: one drawing — the WP24 beds at TVD with inflow / crossflow arrows (labelled by their arrows); the WP28 band
  drawing along MD is dropped (WP28's `_schLayers` still feeds `o.layers` when the model is not multilayer; the multilayer inflow overrides it).
- **Correlation sections on the schematic**: the WP21 band beside the path by default; with Colour by → Correlation the WP28 rail is
  drawn from the WP21 traverse runs (`mdTop`, `mdBot`, `corr`) and the band is left out.
- **`WTS_wellperf_page.ui`**: a function returning the WP27 helper set, with the WP28 subset attached as properties (`ui.u`, `ui.drive`, …).
- **`WTS_wp_system` _ctx**: the well path is built before the inflow (WP24) and `o.outflowOnly` skips the inflow (WP20); evalAt with a
  reused context also resets the predictor count (WP22).
- **Gates at the integration HEAD**: node --check ok; smoke 347/347; accept-test --html --integration file by file 192 files, 2208/2208
  (2122 + 86 new; per-file sums with substring matching — see §18.3.12 for the unique counts); wellperf-validate --html --gate --check --time: gate PASS, 51/51 cross-checks, every E budget ok (one wall-clock row,
  the gas enthalpy solve, ran over its ms cap on the loaded container: 1.46 s against 1.36 s); help-shots / build-user-guide /
  publish-site --check ok; help production file under its cap (no screenshot added).

#### 18.3.9 WP25 record (2026-11-12, branch wp/b-wp25)

Owner default: every open question at its proposed default; Q9 (textbooks) not provided, so Thornhill-Craver and the Asheim numbers ship
provisional through the D17 gate (`wellperf-validate.js` BENCH `lift thornhillCraver`, `lift asheim` pending; `lift glDesign` pinned — the
existing API RP 11V6 engine, calc-gaslift against an independent RK4 gas column). Q11 (valve library) stays at its default: no library.

- **`WTS_gaslift_compute` additive inputs (§2.3)** — absent → today bit for bit (calc-gaslift 4, wellperf-identity FI3 unchanged):
  `ipr` (a `WTS_wp_ipr` curve: `pr` psia, `pwfAt(q)` psia) replaces the straight-line PI; `segments` (the flow path from the mid-perforations
  up, `WTS_wp_well.segmentsFor` shape) replaces `[{len: L, dz: L}]` — every depth is then an MD, the injection-gas column, the kill-fluid
  gradient and the design tubing line work on the TVD of that MD, spacing (minsp) is along the hole, dperf = the path MD (≤ 40,000 ft);
  `tAt(md)` replaces the linear THT → BHT profile (marches, gas column, valve temperatures); `corr` (a `WTS_flowline_corr` key) and `pvt`
  (fluid.pvt without `table` / `injGas`) reach the marches. With them the result adds `valves[].md / tvd`, `curves[*][].tvd`, `deviated`,
  `poiTvd`, `poiValveTvd`, `dperfTvd`, `pr`, `ipr {key, label, pr_psia}`. X55: a one-segment vertical path + a straight-line ipr = the
  vertical design (6e-8).
- **`WTS_wp_gl` (new file `49-calc-wp-gldesign.js`, same namespace as 49-calc-wp-lift.js)**: `TC` {cd 0.865, k 1.27, A_bellows 0.77 in²,
  ports 8–32/64, verified:false}; `tc({port64 | d_in, cd, p1, p2 psia, T °F, sg, k})` Thornhill-Craver with the critical-ratio cap
  (q, qCrit, r, rc, critical, dqdp2); `portR`; `context(M)` (fluid, inflow, path as the solver builds them); `inputFor(M, R)` (the design
  input on the shared model: rate and THP of the operating solve, injection pressure and rate of step ④, kickoff = injection + 100 psi,
  deepest mandrel = packer − 30 ft, the model's inflow, path, correlation and the flowing temperature of the operating solve at every valve
  — linear, relaxation or enthalpy profile); `design(M, R)` → a Job (2 steps; result `{ok, gl, valves:[{n, md, tvd, role, port, R, t, pso,
  pvo, pt, pd, pd60, ptro, pvcs, spacing, tc, need, ok}], operating, qinj, qL, port, portRec, capOk, inputs, warnings}` — portRec = the
  smallest port passing 110 % of the injection rate at the operating valve); `setValve(D, i, md)` (a dragged design valve re-set on the same
  casing and design-tubing lines); `valvesFromDesign`; `diagnose(M, R, valves, test)` (casing at each valve from the test CHP, tubing from
  the THP marched down with the metered lift gas to the operating valve and with the formation gas below it; IPO open at p_vo, held open
  down to p_vc = p_d; status, operating valve, multi-pointing, lifting above the bottom valve, throughput against the metered gas, supply-
  limited, sub-critical, under / over injection (80 % / 120 %) against the performance-curve economic point or optimum, else the design
  rate; orifice and dummy kinds); `parseSurvey(text, {axis, unit})` (header units m / bar / kPa / °C converted; psig / psia; MD or TVD);
  `matchSurvey(M, R, rows, {valves})` (residuals against the solved traverse, RMS / bias / worst, temperature RMS, the gradient break by
  two least-squares lines in p vs TVD → injection MD · TVD, nearest valve); `asheim(M, R, {port64})` → `{F1, F2, stable1, stable2,
  verdict, parts, verified:false, provisional}`: F1 = (dp_in/dq)/(dp_out/dq) at the operating point (∞ on a rising tubing curve; > 1 ⇔
  the solver's dΔ/dq > 0, X57), F2 = |∂p_ti/∂q_gi|·|∂q_v/∂p_ti| (no-slip column above the point × the Thornhill-Craver slope; 0 with a
  critical port; < 1 stable) — written for this module from Asheim's lumped description; the paper's own coefficients were not checked.
- **Model (`WTS_wp_model`, additive)**: table key `glValves` [{md, port /64, ptro psig, R, kind 'ipo'|'orifice'|'dummy'}] ≤ 20, sorted →
  `M.lift.gl.valves`; `M.lift.gl.design {pko_psig, gs, ftub, minsp, dpdrop, port64, R, qL, dmaxMd}` (null = engine default); scalars
  `wp_gld_pko / gs / ftub / dpdrop / minsp / port / R / qL / dmax`. The test rows already carried `chp_psig` and `qinj_Mscfd`; the page's
  test table now shows them (CHP, Lift gas).
- **Page** (extension `window.WTS_wellperf_ext.gldesign`, new file `49-calc-wp-glui.js`; page edits: the `handle` / `trPlot` / `comp`
  extension hooks, the wp_gld_* unit tags, the two test columns, three text lines): `#wp_res` card "Gas-lift valves — design, throughput
  and diagnosis" (with gas lift): KPI chips (valves, operating valve MD · TVD, port throughput vs need, Asheim F1 / F2, diagnosis, survey
  RMS), the valve chart `#wp_cv_glv` (pressure vs TVD or MD; Design view: kickoff / injection casing lines, design tubing line, unloading
  kill-fluid legs, tubing with and without lift gas, point of injection; Diagnosis view: casing from the CHP, tubing from the THP, p_vo per
  valve; survey stops and break; packer) with a drag knob per valve (live re-set of a design valve, or a moved installed valve written on
  release; keyboard [ ] arrows Enter), the valve table (MD, TVD, T, port, p_tro, p_vo / p_c, p_t, capacity / gas, role / status) and the
  ✓ / ⚠ / ✗ verdicts. Step ④: "Gas-lift design — unloading valves" (settings, Design the valves (a Job), Use this design → glValves, Use the
  recommended port, the installed-valve editor with TVD) and "Gas-lift diagnosis and gradient survey" (test select — device pref
  `wtspref_wp_plots.glTest`, survey text `wpv_gls_text`, Match the survey). Schematic: a mandrel per valve coloured by state (operating /
  open / closed / orifice / dummy) — click opens its editor row, drag along the hole moves it (live), arrow keys on a focused mandrel move it
  50 ft (Shift 10 ft). Traverse: a line per valve (the operating one labelled) and the survey stops. CSV blocks (valves, diagnosis, survey),
  a Notes line. Device prefs `glvView`, `glvDepth`, `glvHidden`. Shots at 1280 × 800 and 390 px (scratchpad `shots-b-WP25`), no
  horizontal overflow, no console errors.
- **Tests / gates**: `wellperf-gl2` (8: WG21–WG28); `wellperf-validate`: gate section 11 (Thornhill-Craver and Asheim carry the provisional
  label; the design carries TC_PROVISIONAL), X54 (Thornhill-Craver = the isentropic nozzle at z = 1, 0.32 % worst), X55, X56 (diagnosis at the
  design operating surface pressure = the design operating valve, alone), X57, X58 (the solve's own traverse as a survey: RMS 0, break
  71 ft from the injection point); `--time` rows "gas-lift valve design" (26 marches against 120 E) and "gas-lift diagnosis" (1 against 3).
  Full suite: 193 files, 2,216 / 2,216; smoke 347; wellperf-validate --html: gate PASS, 56 / 56, every E budget ok.
- **Help**: no new text or screenshot (the production help file is at its cap, Q21) — `^wp_gld_` added to the wellperf notDocumented
  pattern; the wellperf and gaslift guides re-hashed (reviewedSrc). The guide does not describe the design card, the diagnosis or the
  survey (gap).
- **Known gaps**: Thornhill-Craver (Cd 0.865) and the Asheim numbers are provisional (Q9) — the F1 / F2 forms are this module's reading of
  the lumped model and need the owner's check against the paper; the design marches are the RP 11V6 engine's (the model's correlation and
  PVT pass through, the lift gas is mixed into the gravity and the total GLR, not the solver's free-gas-only option), so the design tubing
  curve and the solve's traverse differ slightly; with gas lift the solver uses the relaxation profile (WP22 ENTH_FALLBACK), so the valve
  temperatures are relaxation / linear on a lifted well; the system solve still injects at its single point of balance with the step ④
  casing pressure — it does not yet inject at the installed valves (the design's operating valve sits at the operating surface pressure
  p_so − (n − 1)·Δp_drop); the RP 11V6 engine's operating-pressure iteration can stop on an alternate valve count (psoOp of the last pass),
  so the page reports the operating valve's own surface pressure; the diagnosis is steady state (IPO valves only, held open above their
  closing pressure, formation gas = metered gas − lift gas, no hole-in-tubing model); the survey is in field units unless its header says
  otherwise and is not used for tuning (step ⑥ tunes on gauges); no valve / mandrel library (Q11); valve labels can overlap on the chart
  when two valves are close; GLPC points carry no Asheim numbers.

#### 18.3.10 WP26 record (2026-11-12, branch wp/b-wp26)

Owner default: every open question at its proposed default; Q9 (textbooks) not provided, so the viscosity correction, the natural
separation, the gas criterion and the motor / cable basics ship `verified:false` with the D17 label (BENCH kind `esp` pending) and are
never a default (the default lift type stays natural flow); the affinity laws are exact similarity relations (`pinned`, X60). Q11 at its
default (a device-wide pump library) — as a device preference `wtspref_wp_pumplib` rather than a project library key (the library-key rule
of 29-project-save is PRiSM-only and would need a Round-6 edit). Q21 open.

- **Engine (new `49-calc-wp-esp.js`, `WTS_wp_esp`)** as §7.3: `normPump` (user table rate / head per stage / efficiency % / BHP per stage at
  f0, monotone cubic with linear continuation, efficiency ↔ BHP fill, BEP = the efficiency maximum, recommended range from the table else
  70–130 % of the BEP rate, stated), `curve` (affinity q ∝ f, H ∝ f², P ∝ f³; viscosity by the Turzo, Takacs & Zsuga (2000) fit, normalised
  to its water value so a catalogue water curve is unchanged, factors in [0.1, 1], held beyond Q* = 40 and flagged), `fan`, `natSep`
  (Harmathy v∞, E = v∞/(v∞ + v_SL) after Alhanati; a rotary separator in series), `turpin`, `prepare` (setting MD with TVD, inclination and
  dogleg; defaults: end of tubing, 60 Hz, natural separation and viscosity OFF (opt-in since the review fix, §18.3.12), OD 4 in, #2 cable to MD + 100 ft), `pump` (stage by stage in
  ≤ 20 groups, midpoint rule, gas dissolving as the pressure rises, hydraulic and shaft power), `motor` (V/Hz constant, load, linear current
  estimate, copper cable at the mean cable temperature, surface voltage, kVA, motor cooling velocity), `flags` (range down- / upthrust, gas
  interference φ > 1, GVF > 10 %, viscosity, overload / high / light load, cable drop > 5 %, cooling < 1 ft/s, below the perforations,
  dogleg > 3 (fail > 6)°/100 ft), `sizeStages` (≤ 3 evaluations at the target rate), `sweep` (rate against frequency, a Job),
  `example` (a generic synthetic pump, not a catalogue pump).
- **Solver (49-calc-wp-system.js, additive; no ESP → unchanged):** `M.lift.type 'esp'` makes the pump a node: the intake segment is marched
  bottom-up from the inflow's pwf(q) (so the intake state is exact at a root), the pump runs stage by stage, the discharge segment carries
  the stream less the vented gas (the separated gas rejoins at the wellhead: the choke and flowline carry the full stream); bottom node
  p_out = pwf + (p_dis,needed − p_dis,pump), wellhead node marches up; `outflowOnly` (lift tables) marches top-down and solves the intake
  pressure by a secant (lost 'pump-off' when the pump would draw it below atmospheric). Each segment has its own frozen layout (`R.grid.esp`,
  carried by warm starts). One evaluation = one traverse of the path (counted 1 E). `R.lift` as in the file header (state, motor, flags,
  methods, the system head curve from the scan, `marks`), breakdown key `pump` (negative = a gain; gravity residual corrected), flags
  `ESP_POINT`, the warn / fail ESP flags and `PROVISIONAL_ESP` per provisional method used; `designFor({freq: q})` (30–90 Hz);
  `WTS_wp_check`: ESP_NOT_APPLICABLE (gas wells), NEEDS_PUMP / BAD_PUMP, NEEDS_STAGES, ESP_FREQ, ESP_BELOW_PERFS and provisional validity rows
  `esp_turzo` / `esp_alhanati` / `esp_turpin`. Enthalpy temperature mode falls back to the relaxation with a pump (ENTH_FALLBACK).
- **Contract changes (additive).** Model: scalars `wp_esp_md, _freq, _stages, _sep (%), _nat, _visc, _od, _hp, _volt, _amp, _awg, _clen` →
  `M.lift.esp.{pumpMd, freq, stages, sepEff, natSep, visc, od_in, motor{hp, volt, amp}, cable{awg, len_ft}}`; table key `pump` =
  `{v, name, f0, rows[[q, h, eff %, bhp]], qMin, qMax, od_in, example}` (cleaned, ≤ 40 rows) → `M.lift.esp.pump`; DEFAULTS unchanged
  (`esp: null`). Export: ALQ type `FREQ` (Hz, oil / water, the model's pump), `suggest` offers it for an ESP model, a table without a lift
  axis keeps the model's pump (`ALQ_MODEL_ESP`). Page: `WTS_wellperf_page.ui().solveLive()` (an extension's live drag), breakdown label
  `pump`, KPI `esp` (replaces the loading margin of a pumped oil well), schematic ESP label with stages · Hz · MD · TVD, example **ESP**
  (an example without a lift type clears an ESP selection), the ESP option enabled. Screening (WP27): the ESP rate is now the pumped solve
  when the model has a pump (`NEEDS_PUMP` otherwise; test WSC2 updated).
- **Page (new `49-calc-wp-espui.js`, extension `WTS_wellperf_ext.esp`).** Step ④: "ESP — setting, pump and motor" (MD with TVD /
  inclination / dogleg pills, frequency, stages, gas, motor and cable; Size the stages → Use N stages; Frequency for this rate (Job) → Use;
  Rate against frequency (Job)), "Pump curve" (display-unit table editor, meta row, Add row / Example / Paste CSV / Clear, device library
  Save / Load / Remove, BEP / range pills), "Rate against frequency" (rate per frequency coloured by the range verdict, in-range band, a
  draggable frequency line). `#wp_res` "ESP — pump and system head" (visible only with the ESP): eight KPI chips with ✓ / ! / ✕, the pump plot
  (total head against the rate through the pump: recommended range band across 30–90 Hz, BEP locus, frequency fan, the pump at f and N, the
  head the well needs from the scan, the pump on this fluid when gas / viscosity matter, the operating point; FREQ and STAGES rails re-solve
  live and commit on release), a stage strip intake → discharge, the summary rbox, the checks. Studies row, CSV sections, Notes. Phone: a taller
  plot and a shorter legend. Help: the notDocumented pattern takes `^wpe_` and `(gl|esp)_` (production help file 47,619 of 47,670 bytes); no
  guide text, no screenshot (cap full, Q21).
- **Tests / gates.** `wellperf-esp` ES1–ES13 (13: record, affinity, Turzo, separation / Turpin, stage by stage, system identities, top-down
  and the FREQ axis, monotone and tracking, sizing / frequency design, sweep Job, motor / cable and flags incl. a dogleg on a deviated path,
  model and checks, the page). wellperf-validate: BENCH `esp` (5 rows), gate 11, X60–X63 (numbered from X60 to stay clear of WP25), `--time`
  rows ESP solve (≤ solve budget), stage sizing (3 E), sweep 7 frequencies (budget 70 E), frequency design, a FREQ lift table (reported).
  Screenshots at 1280 × 800 and 390 px in the session scratchpad (`shots-b-WP26`).
- **Known gaps.** No verified published example (Q9): Turzo coefficients as published in the fit, to verify; natural separation is the
  simplified Alhanati form; no head degradation by gas beyond the homogeneous density (Turpin only flags); no temperature rise through the pump
  and no motor heat in the temperature profile (enthalpy mode falls back); current is a linear estimate of load; the cable drop is resistive
  copper only (the host electrical engines are not exported); no thrust-bearing load number (range flags only); the separated gas has no
  casing-pressure model; gas wells (dewatering ESP) not modelled; no ESP in the sensitivity variables, the forecast or the batch over wells
  beyond what the solve gives; the pump library is per device; help text for the ESP not added (cap, Q21).

#### 18.3.11 WPI3 record — B release (2026-11-12, branch wp/b)

- **Help guide** (11e2a5c): the wellperf guide lists the ESP example, step ④ natural flow / gas lift / ESP, step ⑦ lift-curve tables, PVT
  table export and Run all wells, PVT lab match, and three new parts (Studies, Gas-lift design, ESP) within the Q21 caps (production
  47,635 / 47,670 bytes; all help 367,950 / 369,000 raw, 127,774 / 128,000 gzip). Gaps (did not fit, Q21): the names of the five B lift
  correlations, Rv / emulsion options, the enthalpy U layers, the B inflow models, how to use the batch, how the ESP motor / cable / gas checks
  work, the gas-lift design inputs and the limits of diagnosis / survey matching, any screenshot of the B cards.
- **Release**: RELEASE_NOTES v4.5 (both platforms, six items, provisional methods marked), App Store 4.5, the release-notes help shots
  re-taken (image total 7,983,698 bytes).
- **Fixes** (GUI sweep + Playwright pass): Metric FVF unit on the separator-test Bob and condensate B_c inputs; `_loadExample` puts the
  controls that another example sets back to their page defaults (`defaultValue` / `defaultSelected`; `wp_lift` keeps its own rule) and
  clears the forecast steps and matrix values so they are suggested for the example; 49-calc-wp-tables `_sync` decides "still auto-filled"
  before the axis selects fall back to an applicable type; 49-calc-wp-view schematic fits a wide well in 88 % of the section width and sets a
  side label that would run past the section against its edge.
- **Gates**: smoke 347/347, accept-test 2398/2398 (194 files; per-file sums — 2,229 unique by --list, §18.3.12), wts3d 147/149 (CRLF checks), wellperf-validate gate PASS + 60/60 + budgets,
  help / guide / publish checks, GUI sweep full and --mobile 0 findings.

#### 18.3.12 Review-fix record (2026-11-12, branch wp/b)

Twenty-seven review findings verified and fixed (regression tests in wellperf-mech VM4 / VM2 / VM11, wellperf-gl2 WG29, wellperf-esp ES12,
wellperf-pvtmatch PM13 and the new wellperf-bfix RB1–RB3; checks X5b / X5c in wellperf-validate):
- **Lift correlations.** Ansari annular: the film equation is scanned upward from the thin end and the first sign change is bisected (the
  thin film, as Ansari and Alves take it); a film that has only the thick root or a total holdup above 0.12 is bridged to slug (Barnea, as
  used by Ansari et al.; the same rule in `ansariPattern`, so the map and the gradient agree). FIX.gasWell at 2,600 psia now flows with
  Ansari (≈ 3,710 Mscf/d; was UNSTABLE_ONLY) and its largest outflow step on a rate grid fell from 27 % to ≈ 15 %. Mukherjee-Brill: uphill
  bubble when N_Lv > N_LvBS(N_gv), level / downhill bubble below N_gvBS(N_Lv) and stratified when N_Lv ≤ N_LvST (the review's reading of
  §4.3.3; Q9). Orkiszewski: the slug density is no longer held at the no-slip density (published method; hand point ρ_s ≈ 20.6 lbm/ft³).
  Orkiszewski / Hasan-Kabir keep their published pattern steps: X5c reports them (known limitation), the traverse warns `PATTERN_STEP`.
- **D17.** BENCH `lift glDesign` → pending (no published worked example checked; the design carries `GLD_PROVISIONAL`, `WTS_wp_gl.DESIGN`
  verified:false, the card / verdicts / Notes / release note say provisional). The Asheim numbers are renamed "static stability and
  injection loop gain (screening, after Asheim 1988)"; casing heading from the annulus volume is not assessed. ESP natural separation and
  the viscosity correction are opt-in (`=== true`; checkboxes unchecked; the ESP example leaves them off) — the WP26 record line "natural
  separation and viscosity on" is superseded.
- **PVT / flowline.** The lab-match Rs shift is applied as b·min(1, p / pb_lab) (`match.rsPb`; the fit regresses b on that taper and skips
  the lab-pb point itself): Rs at stock-tank and separator pressures stays the correlation's. A plain `fluid.pvt.mult.rs` no longer maps the
  GOR back for the bubble point (only a lab match does: `pvt.matchRs` or a shift) — the A2 bubble point bit for bit (PM13).
- **Forecast header.** The oil tank's producing GOR is the Corey solution-gas-drive R (S_gc 5 %, n_o 3, n_g 2, S_wi 0.2 assumed), 'retained'
  holds R_s; the 49-calc-wp-cases header said R_p was held.
- **Reports from any step.** The ESP frequency sweep (plot, table, best-in-range chip), the inflow-study plot, the condensate plots, the
  lift-screening ranking and a compact table of every study that has results (envelope, forecast, tornado, matrix, cases — the active tab
  shows its own) are inside #wp_res; the 'Lift screening' report row is built from the current model's matrix in the table's words.
- **Page.** Gas lift example (deviated, p_inj / q_inj / packer; designs its valves on load); example chips wrap as one group; validity box
  labels a provisional entry once (ℹ); Notes / Case summary name the per-section correlations; inclination text clamped to 0–90°;
  injection-point KPI and schematic marker say "point of balance — not yet at the installed valves" (warn below the deepest valve); valve
  drag clamped between the neighbours ± the minimum spacing with a spacing verdict / KPI; ArrowDown = deeper on a depth-down chart; one TVD
  source and knob labels from the valve MD; one port notation; schematic side labels placed without overlaps and off the path, perforation
  ticks and the correlation rail clipped to the frame, the horizontal label off its bracket; hline labels and the envelope point label
  avoid the other labels; Metric: matrix variable lists, J, the ESP engine lines and doglegs (°/30 m) in display units; the breakdown
  footer wraps; the forecast chip's short sub-line; labelled matrix best case; per-study plot names.
- **Records.** The earlier counts were per-file sums with substring matching (`--file wellperf-sens` also runs wellperf-sens2 …): unique by
  `--list` 1,964 at 8ce1989 (A2, not 2,122) and 2,229 at the WPI3 release (not 2,398). Smoke namespaces now include every B engine.
- **Gates (Linux, LF, built HTML).** node --check ok; smoke 347/347; accept-test --html --integration 2235/2235 unique (195 files, each run
  with its full name); wts3d-test 147/149 (the two CRLF checks); wellperf-validate --html --gate --check --time: gate PASS, 62/62
  cross-checks (X5b ≤ 0.2, X5c recorded), every E budget ok; help-shots --check (release-notes desktop shot re-taken, image total 7,980,332),
  build-user-guide --check, publish-site --check ok; wellperf and flowline guides re-reviewed (reviewedSrc).

#### 18.3.13 Q21 help completion (2026-11-13, branch help-q21)

Owner question Q21 approved on 2026-11-13 ("do Q21 now"): the second help-cap raise, with the help growth needed to document the B features
fully, B card screenshots included. (The task named this record §18.3.12; that number was already the review-fix record, so it is §18.3.13.)
- **New text** (48-calc-help-production.js, wellperf guide; every provisional method called provisional, D17): parts *PVT lab match* (inputs,
  pb one-point factor, Rs / Bo / μo as a·y + b, ranking, the b·min(1, p / pb) taper, differential → flash), *Condensate and emulsion* (wet gas
  vs the Rv table, dew point; mixture default, Woelflin / Brinkman / table), *Correlations and flow regimes* (Orkiszewski, Aziz-Govier-
  Fogarasi, Mukherjee-Brill, Ansari, Hasan-Kabir by name; pattern steps; per-section rows by MD or inclination, first row wins, the two
  fill buttons), *Flowing temperature* (enthalpy balance terms, U layers, fallback with gas lift / ESP), *More inflow models* (water-cut
  composite, Joshi / Babu-Odeh / Furui, fractured oil and gas, transient, multilayer, injector, the Build-up Surveillance hand-off and its
  p* caution), *Studies* (five steps: envelope, forecast + time slider and the tank mode, tornado, matrix, cases), *Tables* (lift-curve
  axes, datum, Fill from the model, Run lift table, text / CSV; PVT table export), *Gas-lift design* (inputs kickoff pressure, kill-fluid
  gradient, pressure drop per valve, port, R; Design / recommended port / Use this design; diagnosis; survey match; F1 / F2 screening after
  Asheim; limits: the solve injects at its point of balance, mixed lift-gas gravity), *ESP* (pump curve and library, affinity, rails, Size
  the stages / Frequency for this rate, Rate against frequency, range / gas / motor / cable / velocity checks, opt-in natural separation
  and viscosity; not modelled: heating, thrust, casing gas, gas wells). Main steps: the Gas lift example, step ⑦ split with Run all wells
  (read-only batch). Refs + Asheim (1988), Turpin, Lea and Bearden (1986); related + buildup. 48-calc-help-start.js: task *Design gas-lift
  valves or size an ESP* (14 → 15, the format's maximum).
- **Shots** (help/img/wellperf, desktop crops; ESP also phone): wells-d 11,996 B, ltab-d 17,222 B, env-d 20,040 B, gld-d 29,702 B, esp-d
  25,716 B, esp-p 25,916 B (130,592 B). Jobs run through the new named action `wpJob` (help-shots.js: click, then wait for a done selector;
  browser-only shots, checked by recipe hash); the sticky step bar is masked. help/view re-fingerprinted (pixels unchanged).
- **Caps (old → new; measured)**: production 47.67 → 57.6 kB (57,009 B); start 19.8 → 20.55 kB (20,333 B); SUM_CAP 369 → 381 kB
  (378,001 B); GZIP_CAP 128 → 133 kB (131,598 B); wellperf guide serialised 14 → 21.75 kB (new GUIDE_CAP_KB, 21,920 B); images 8 → 8.15 MB
  (8,110,924 B, 224 files); manifest module (help-shots moduleBytes) 8.8 → 9 kB (8,914 B). Other per-file caps unchanged.

### 18.4 Increment C

Equation of state; rod pump, PCP, jet pump, piston pump, multiphase booster, plunger / intermittent lift; coning; relative
permeability water-cut forecast; material-balance coupling beyond the tank; live virtual metering through the historian / Modbus tags;
multilateral branches; annulus + tubing simultaneous flow; multi-well gas-lift allocation.

---

## 19. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Correlation chart fits differ between sources | traverse differences of a few percent | pin one documented fit per chart; tests at chart readings; ±3 % against book traverses |
| A correlation cannot be verified against a published example (Q9 late or a book lacks one) | a wrong holdup fit ships checked only for self-consistency | D17 gate: `verified:false`, "provisional" label, not a default; benchmarks merged with the engine WP; Q9 blocking with a date |
| Extending the shared marcher breaks flowline / flare / gas-lift pages | regressions on shipped pages | one owner (WP0b), additive options only, full-output identity tests merged first |
| DFIT and this module both defining `WTS_wellbore._ramey` | last loader wins; DFIT test fails | `_ramey` left to DFIT; production uses `flowingTemp`; DFIT-PLAN cross-reference; Q16 |
| Multiple roots / no root / a choke regime jump confuse users | wrong operating point reported | all roots listed, stability from q_s, discontinuity detection, continuous choke bound, plain-text explanation |
| Performance on phones | slow UI | evaluation budgets (§16), coarse-curve scan, PVT table, Jobs on buttons only, Solve-button fallback |
| Users trust a vertical correlation in a horizontal section | wrong BHP | range checks and the per-section warning |
| Engineering liability: outputs are used for equipment rating and choke selection | an unsafe rating decision | REPORT_DISCLAIMER and the validity-range verdicts mandatory on the report and the Quick Report snapshot (tested); SITHP shown with its worst-case basis; provisional labels; known limitations in the report Notes |
| Help byte caps nearly used up | the guide cannot ship as planned; build fails | compact A1 guide; draft sized first; Q15 to the owner; course in A2 |
| Help screenshots can be made only in the Linux container | WP10 blocked elsewhere | WP10 scheduled in the container; `--check` runs anywhere |
| Round-3 rebuild for 16-pvt edits (A2) touches PRiSM | PRiSM / DFIT / Build-up regressions | moved out of A1; P-ID on all 20 keys; downstream suites named in §2.3 |
| Karakas-Tariq table still unverified | perforation skin missing | user-entered S_perf, clearly labelled |
| localStorage size with long surveys / many tests; Quick Report snapshot size | quota errors, evicted snapshots | decimation, 256 kB cap, `WTS_lsSet`; compact block, `.rp-skip`, 60 kB snapshot test |
| A commercial name slips into code, help or tests | breach of the owner's naming rule | §2.11 rule, `wellperf-names` grep test |
| Scope creep into A2 / B inside A1 | late release | the A1 list in §1.4 / §18.1 is fixed; anything else waits |

---

## 20. Open questions for the owner

| # | Question | Proposed default |
|---|---|---|
| Q1 | Hub "Well Performance" with oilipr / gasdeliv / gaslift as members (frees two rows) — or a plain 8th row? | hub (key `perf`) |
| Q2 | Release numbering: A1 as v4.3, A2 as v4.4, B as v4.5? | yes |
| Q3 | Default correlations: Hagedorn & Brown (oil), Gray (gas / condensate), Beggs & Brill (lines)? | yes |
| Q4 | Which simulator input formats must the lift-table export support? | the lift-curve table text format (producer / injector) + CSV |
| Q5 | Keep perforation skin user-entered until the Karakas-Tariq coefficient table is verified from the paper? | yes |
| Q6 | Metric display on this page (the engines stay imperial)? | yes |
| Q7 | Is the gas-lift quick look in A2 enough, or is valve design on deviated wells needed earlier? | quick look in A2, design in B |
| Q8 | Economics (workover payback) wanted at all? | no |
| Q9 | **Blocking:** can the owner provide copies / page references of the textbooks in §15.1 by 2026-11-24 (before WP3 merges)? | needed; without them the affected correlations ship provisional |
| Q10 | Default tubing roughness: 0.0006 in (new) or 0.0018 in (used, today's flowline default)? | 0.0006 in for wells, 0.0018 in for lines |
| Q11 | Should pump curves / valve catalogues be a device-wide library in B? | yes, library key |
| Q12 | API RP 14E C default 100 or 125? | 100 (as the flowline page) |
| Q13 | Should the operating point offer a "send to simulator" write of THP / THT / rates (simulator workstream change)? | no — copy rows only |
| Q14 | Producing-time default for the temperature model (30 days)? | 30 d |
| Q15 | Help allocation: raise SUM_CAP / GZIP_CAP and make `wellperf` a PART route (sized from the WP10 draft), so the guide can carry more and the A2 course fits? | `wellperf` PART route; SUM_CAP +12 kB, GZIP_CAP +4 kB (final numbers from the draft) |
| Q16 | Flowing temperature contract: production uses a new `WTS_wellbore.flowingTemp(column, opts)` with `direction:'produce'\|'inject'`, and `_ramey` stays DFIT 3.4b's. Should DFIT 3.4b's `_ramey` call `flowingTemp` with `direction:'inject'` (one shared formulation, owned by WP14 with a DFIT test pinned)? | yes, agreed with the DFIT owner before WP14 |
| Q17 | Should a shared per-well geometry record (survey, strings, datum) later serve DFIT, well kill and well performance, instead of each keeping its own copy? | yes, later (separate plan); A1 imports from DFIT read-only |
| Q18 | Release notes: the well performance items on both platforms (web and iOS)? | yes, both |
| Q19 | Do the oilipr / gasdeliv / gaslift guides and dashboard tiles change wording once they are hub members? | one hub note per guide, tiles unchanged |
| Q20 | Default equipment ratings for the shut-in / THT verdicts (wellhead pressure class, maximum THT)? | no default — the user enters the rating; verdict hidden until entered |
| Q21 | Second help-cap raise for A2 (the course and the A2 guide parts): SUM_CAP 357 → 369 kB, GZIP_CAP 124 → 128 kB, per-file caps production 45.41 → 47.67, 49-calc-help 47.6 → 48.52, print 15.33 → 15.68, start 19.74 → 19.8 kB, wpcourse 9.83 kB (new)? Q15's default was one raise (+12 / +4 kB), used by A1; raising a cap is an owner decision (§14) | **approved by the owner on 2026-11-13** ("do Q21 now"), with the help growth needed to document B fully, screenshots of the B cards included; caps set from the measured draft (§18.3.13) |

---

## 21. Known limitations (printed in the help and the report Notes)

- Black-oil fluid model only in A1 / A2 / B; gas-condensate is a wet gas with constant condensate volume (no retrograde dropout, no
  compositional flash); Rv is B.
- Empirical correlations outside their data range are extrapolations; the page warns but still computes. Correlations without a
  verified published example are labelled provisional.
- A1 temperature is the linear profile with a user THT; the J-T correction applies only to the hydrate check. The A2 relaxation model is
  decoupled from pressure and assumes a constant producing time and a single U.
- One correlation for the whole well (per-section choice in B).
- A1 chokes: critical correlations with a continuous conservative bound in sub-critical flow (Sachdeva in A2).
- Restrictions use a homogeneous loss coefficient.
- Skin parts are summed with the h / h_p scaling; the non-additive overlap of damage, crushed zone and perforations ending inside the
  damaged zone is not modelled. Perforation skin is user-entered while the Karakas-Tariq table is unverified.
- Steady state only: the stability verdict is a static criterion (q_s); it does not predict heading or slugging dynamics.
- Single well; no network, no multi-well gas allocation. Gas lift (A2): single injection point, no valve mechanics.

---

## Appendix A. Correlation validity ranges (checked by `WTS_wp_check`; values from the original papers, to verify in WP1 / WP3 / WP13)

| Correlation | Range recorded in code |
|---|---|
| Standing Pb / Rs / Bo | API 16.5–63.8, T 100–258 °F, Rs 20–1,425 scf/STB, γg 0.59–0.95 (not used for the wet-gas condensate) |
| Vasquez-Beggs (A2) | API 15.3–59.5, Rs 0–2,199, T 75–294 °F, p 15–6,055 psia |
| Glasø (A2) | API 22.3–48.1, T 80–280 °F, Rs 90–2,637 |
| Petrosky-Farshad (A2) | API 16.3–45, T 114–288 °F, Rs 217–1,406 |
| Beggs-Robinson | API 16–58, T 70–295 °F, Rs 20–2,070 |
| Hagedorn & Brown | vertical; tubing 1–2-1/2 in nominal in the original data (warn above 4.5 in); oil-water-gas |
| Duns & Ros (A2) | vertical; wide GLR range; mist region extrapolated for high liquid |
| Gray | vertical gas wells; v_m < 50 ft/s, d < 3.5 in, condensate ≤ 50 bbl/MMscf, water ≤ 5 bbl/MMscf |
| Beggs & Brill | any inclination; 1–1.5 in test pipe data (warn: commonly used beyond) |
| Turner | droplet model; data mostly at wellhead pressures above about 1,000 psia |
| Coleman | data from wells with flowing wellhead pressures below about 500 psia |
| Sachdeva choke (A2) | bean 8–40/64 in data range |

## Appendix B. Defaults (all editable)

Step length 100 ft (wells), 50 ft (lines), scan at double step; refine on (frozen grid per solve); scan 12 coarse points; Brent
tolerance 0.1 psi; U_to 2 Btu/hr·ft²·°F; producing time 30 d; k_e 1.4 Btu/hr·ft·°F; α 0.04 ft²/hr; erosional C 100; holdup
multiplier bounds 0.8–1.25, friction 0.7–1.5, flag outside 0.9–1.1; loading method suggested by WHP (Turner default); condensate
B_c 1.0; choke Cd 0.75 (Sachdeva, A2), gas nozzle Cd as `WTS_chokeperf_gasRate`; separator 100 psig; heading flag 10 % above q_s;
bean list 16, 20, 24, 32, 40, 48 /64; sensitivity ≤ 10 values per variable; Quick Report snapshot cap 60 kB.

## Review fixes of increment A1 (2026-11-12)

Verified findings of the A1 review and what changed (tests: `prism-build/tests/wellperf-review.test.js`, WRV1–WRV24):

- Liquid-only choke (GLR < 10 scf/STB): q (bbl/d) = **1022.7**·Cd·d²·√(Δp/SG) (d in, Δp psi; = 29.84 gal/min × 34.29 = 8074/√62.4). The
  A1 build used 673.2 (Torricelli's constant for head in feet), so the choke Δp was 2.31× too high.
- Design (`designFor`): a no-flow trial past the stability cliff is a one-sided bound (bisection), never a secant value; a repeated
  setting is not "converged" unless |q − target| ≤ tol; an unreachable target says why (stability gap, or the sub-critical bound of the
  critical choke correlation with the no-choke maximum rate next to it). Up to 16 solves.
- Erosion (§4.12) covers the flowline march as well as the tubing; `R.velocities` = the higher of the two with `where`.
- Liquid loading: the decision recorded in §4.11 (tubing verdict, rathole apart, `loadingRathole` option).
- Hydrate: ⚠ within 10 °F downstream of the choke as well as at the wellhead; the KPI shows the smaller margin and where; the hydrate
  check and the choke isenthalp use the well-stream gravity for gas and condensate wells (`R.surface.sgHyd`).
- The flowline of a choked gas well is marched at the choke-downstream (isenthalpic) temperature (`R.surface.tLine`).
- `darcyGas` p² form stores the p² coefficients it uses (a·μ̄z̄, b·μ̄z̄; m(p) ones as `aMp` / `bMp`, units in `form.units`).
- The dry-gas method `gasTZ` is refused for oil and water wells (solver `CORR_NOT_APPLICABLE`, ✗ in `WTS_wp_check`, disabled option).
- Page: schematic hover marker passes clicks through; test gauges drawn on the schematic; MD and TVD on every depth readout (tables,
  perforations, BHP KPI, component labels, depth-plot crosshairs); a case summary inside `#wp_res` (the report of any step carries the
  inputs); sensitivity values fitted to the variable and engine refusals shown; touch-action none on the plot with handles; wheel zoom
  only with Ctrl / Cmd or a focused plot; survey form switch converts the stations with Undo (no browser confirm); stale study results
  marked; staggered vertical-line labels and an auto-placed legend; decimal-comma aware paste with a cell-count warning; one solve per
  well switch / project open (the host re-render solves) and per example; layout at 1280 px; step status text for screen readers.
- Not changed: the schematic is exported in the app's dark rendering (the app has no light theme and the host report bakes the on-screen
  styles of every page's diagrams the same way); a light export needs a host report hook.
