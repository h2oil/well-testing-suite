# Build-up Surveillance (v3.3) — implementation plan

> **Status: plan, reviewed (2026-10-31).** No code has been written yet. This revision resolves the engineering and architecture
> review; Appendix B lists the review notes. Literature is cited by author, year, title and SPE number; numbers marked
> "no. to verify" never go into the app.

| | |
|---|---|
| Release | v3.3, built as work packages WP0–WP9 (§9) |
| Page | Title **Build-up Surveillance**, route key `buildup`, element ids `bu_*`, sidebar group Production & Reservoir (row 7, after Gas Lift) |
| Namespaces | `window.PRiSM_autoInterp`: the pure automatic build-up interpretation engine, Round 8, shared with PRiSM; it also holds the shared canonical JSON and 64-bit hash helpers (`canon`, `hash16`). `window.PRiSM_skinCheck`: skin maths plus the PRiSM Skin-check card, Round 8. `window.PRiSM_autoInterpCal`: the generated calibration table, Round 8. `window.WTS_buildup`: sub-objects `data`, `run`, `trend`, `synth`, `review`, `store`, `plot`, `page`, Round 9. `window.WTS_buildup_compute`: the registry contract |
| New files | Round 8: `53-prism-autointerp.js`, `54-prism-skin.js`, `55-prism-autointerp-cal.js` (generated). Round 9: `49-calc-buildup-data.js`, `-run.js`, `-trend.js`, `-synth.js`, `-review.js`, `-store.js`, `-plot.js` and the page `49-calc-buildup.js`. Tool: `prism-build/buildup-validate.js`. Tests: 14 new `tests/*.test.js` files (about 140 tests, about 75 s in total) and two helpers, `tests/_buildup-shapes.js` and `tests/_buildup-idb-fake.js` |
| Edited files | `05-regression.js`, `04-ui-wiring.js` and `33-pta-core.js` (additive options, one model name, one new public function); `11-polish.js`, `13-auto-match.js` and `51-prism-workspace.js` (closed-circle schematic, name and plain text); `concat-round8.js` (FILES, lead only); host `well-testing-app.html` (nav order, final Quick Report template, app-version getter, snapshot hook, release notes); `29-multiwell.js` (comparison rows); `ios-styles.css`; `smoke-test.js`; `tests/wp7-ui.test.js`; the iOS version stamps; README, CLAUDE.md, PROJECT-NOTES, `docs/ROADMAP.md` |
| Background | Every formula, table, threshold and field list a builder needs is in this document (§3–§5 and Appendix A). The planning session's working notes are not part of the repository and are not needed to build |

**Conventions.**
- Field units throughout: psia, hours, STB/d (oil), bbl/d (water injection), Mscf/d (gas), md, ft, cp, 1/psi, bbl/psi, psi²/cp,
  °F as input and °R inside.
- Log cycles are base-10 unless marked "ln". PRiSM functions take the Bourdet distance L in **ln units**: 0.1 log cycle = 0.2303 ln.
- "Desktop" timings come from the planning measurements on a 4-core 2.8 GHz server running the build runtime. "Phone" means ×3.
- Object ids: `B3` build-up 3, `E5` event 5, `O2` override 2, `F4` review finding 4.
- Evidence references are written `B3·I1` (§8.1).
- Confidence rule ids: `KL1`–`KL9` (low), `KK1`–`KK4` (low, k-held results), `KC1`–`KC6` (medium caps), `KH1`–`KH6` (high) (§5.1).
- Algorithm labels: `M§A1`–`M§A28` and `M§A-CAL` name the algorithms of §4 and §5 (for example M§A2 = shut-in detection). They are
  labels only; nothing outside this document is needed.
- Extension items are `X1`–`X16` (§1.4). Test ids carry a file prefix: `SH` shapes, `EN` engine, `CC` closed circle, `DA` data, `RU`
  run, `TR` trend, `GE` generator, `BM` benchmark, `RV` review, `PG` page, `ST` store, `IN` integration, `SK` Skin check.

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Page | One Round-9 plug-in page `buildup`, "Build-up Surveillance", group Production & Reservoir (6 → 7 rows, one row left). Registry only: no host route or sidebar edit, apart from an `__NAV_ORDER` entry after `gaslift` | The registry mounts pages; the group has room |
| D2 | Where the PTA intelligence lives | In **PRiSM**: `53-prism-autointerp.js`, a pure engine on `window.PRiSM_autoInterp`. It covers the IARF window, line, match, triggers + BIC, C-held refits, S_err, sensitivity, confidence, r_inv, p*/p_ext and the IARF reach. The page and the PRiSM Skin-check card both call it. The same file holds `canon`/`hash16`, used by every WP | One implementation of every check. The user asked to develop PRiSM's PTA and skin checks |
| D3 | How PRiSM code is reused | `PRiSM_fitPhysical` and `PRiSM_physicalModel` with a hand-built `adata` and `well` (`defaulted:[]`, `complete:true`). Additive options only: `opts.entry`, `opts.isolated`, `opts.evalBudget`, `opts.lmState`, `opts.slice` (§3.2). The engine never calls `PRiSM_getAnalysisData`, `PRiSM_getWell`, `PRiSM_rateHistory`, `PRiSM_autoMatch`, `setLastFit`, `setWell` or `commitDataset` during a scan | `physicalModel` reads `PRiSM_state.params` for categorical keys (33:1036); `fitPhysical` flags S "not identifiable" when `defaulted` is not empty (05:1820) |
| D4 | Model set | Homogeneous + WBS + skin always. Sealing fault (`linearBoundary`), two-zone radial composite (engine kernel, F frozen at 1) and **closed circle (new `PRiSM_MODELS.closedCircle`, `kind:'pressure'`, 46 models)** are fitted only when a trigger fires. `closedRectangle` is never in the automatic race. The registry `radialComposite` is never run inside a work unit | The rectangle took 89 s and converged to a wrong minimum; one registry-composite LM iteration costs 222–267 ms desktop |
| D5 | Speed | Rate-history compaction (last 10·Δt_end exact plus one volume block), superposition through one pd grid per parameter set, 12 fit bins per cycle, a single start seeded from the line, rivals only on triggers, fast kernels, and LM slicing by **evaluation count** with λ and the stagnation count carried between slices | A 365-step fit takes 12–39 s today |
| D6 | Derivative | Bourdet on X = ln Δt_e (superposition equivalent time), L = 0.1 log10 cycle (0.2303 ln), drawn only where the full window exists, 20 bins per cycle: used by the IARF detector, triggers and display. The fit's derivative block uses `PRiSM_compute_bourdet` on the 12-per-cycle fit bins for data and model alike. The plateau is 70.6·qBμ/(kh), asserted in a test | Requirement §4; one operator for data and model in the fit |
| D7 | IARF window | The **earliest** plateau run after the storage hump; inside it, the longest window that passes. This deviates from the requirement's "longest window" (a later plateau is often a boundary or a second zone); the deviation is stated in the I1 text and the limitations, and the longest qualifying window is always reported. Tolerances widen with noise up to caps (band 0.20, slope 0.06), with the slope standard error from the noise model. Reported grades use the requirement's fixed ±10 % / ±0.03: a widened window is "fair (noise-widened)" and fails KH1 | Window stability across tests; honest grades under noise |
| D8 | Model choice | BIC on the **log-Δp block** (the Δp part of what the fit minimises), on a common log-spaced point set (12 per cycle), with n_eff from lag-1 autocorrelation and a relative variance floor. A rival must beat homogeneous by τ (default 10, calibrated so the false-rival rate is ≤ 5 %) | One residual definition for fit, BIC and standard errors; scale-free across tests |
| D9 | Line vs match | One rule, defined once in `PRiSM_autoInterp.DEFAULTS.agree`: k ±5 % and S ±0.5, or "bias explained" within 3 % and 0.3. Both the page and the PRiSM Skin check use it. 34's line-vs-derivative-plateau check (5 %, 0.3) stays as a separate sanity check, labelled as such | One threshold set |
| D10 | S_err | Line-based tests: `max(floor 0.2, se_S·√(n/n_eff), \|S_line − S_match\|, S_win, S_tc, S_pwf)`. k-held tests: `max(floor, se_S·√(n/n_eff), S_tc, S_pwf, S_k)`, where S_k includes the k spread and the test's own rate error. The C-held half-range is reported separately (S_err,ext) and feeds the label. The floor is calibrated by coverage | Requirement §4 plus the window, closing-time, flowing-pressure and held-k terms |
| D11 | Alerts | Delta: `S − S_err − S_base > 2` (requirement form, default). Option `bu_t_basevar` uses `√(S_err² + σ_base²)`. WP8 picks the shipped default from the sequence benchmark's false-alarm rate. Absolute: `S − S_err > 5`, on **mechanical skin** when completion data exist, else on total skin labelled "may include geometric pseudo-skin". Status `none` / `possible` / `provisional` / `confirmed`; `possible` when only tests excluded as low exceed the threshold | Requirement §5; the label gate must not hide a rise |
| D12 | Rates and zones | Each day's volume is spread over the detected flowing hours. The gauge zone and the production-day zone are **resolved to IANA names** at the first analysis (`device` → `Intl.DateTimeFormat().resolvedOptions().timeZone`), stored and hashed, and every conversion uses `Intl` with that name. Day lengths come from the actual boundaries (23/25 h). Closing-day volumes from less than 6 flowing hours are not used for Δq. An offset scan warns on a better-fitting offset. Partial cuts are classified, never interpreted | Requirement §3 and §9 (reproducible on any device) |
| D13 | History before the data | Inputs: production start date or cumulative. If unknown, prepend `max(30 d, 10 × longest Δt_end)` at the first allocated rate, flag it, and run a doubling check (more than 2 % change in the IARF derivative caps the label at medium). With an estimated history p* is reported as a range (prepend ×0.5, ×2, ×10) and no rule uses p* or its trend (depletion, background slope, R4, V2, T13); the drift input is used instead | p* is wrong by about −m·log10(tp_true/tp_assumed) while S cancels |
| D14 | Short tests | A "k-held" pass: k fixed at the baseline median, S and C fitted, for tests with no or only a short IARF. Its own rule set (KK1–KK4, §5.1), label at most medium, S_k from two extra refits at k_base·(1 ± δ). Tests excluded as low are counted and shown in S5 | A k-held S is about 10× more sensitive to k and rate errors than a free fit |
| D15 | Wells covered | Oil producers, gas producers (normalised pseudo-pressure, optional pseudo-time) and **water injectors** (fall-off: sign −1, water μ/B, the first plateau, injectivity wording). A **time-stamped rate table** mode covers test (DST-style) data: rate status `n/a` (measured), trend and alerts off by default | Injectors and test data |
| D16 | Review | Offline and deterministic: an **automated rule-based review** whose evidence check re-reads and recomputes every quoted number, plus re-derivation rules written separately from the engine (no engine calls); a Q&A engine that answers from the analysis with evidence ids; and an optional **"Copy for your AI assistant"** export (clipboard or download, no network from the app; free text excluded by default) | Requirement §10–11; app constraints |
| D17 | Traceability | Evidence ids (Q/D/R/W/I/L/M/A/C/U/K/T/V/O groups). Every report statement cites at least one. Numbers in the report model are structured `{v, cat, dp, ref}`. DRAFT until sign-off. `hash16` (53) over canonical JSON for inputs, results and decisions; a built-in synchronous SHA-256 (WP5) for the signature. "Changed after sign-off" is decided on the three hashes only | Requirement §9, §12 |
| D18 | Storage | `wts_buildup_state` ≤ 300 kB (typical 10 tests ≤ 150 kB): settings, events, rates (steps stored once), trend, review and per-test results without recomputable arrays. Per-test bins and results overflow into IndexedDB (`wts_buildup` / `tests`), carried by project module `buildup_analysis`. Raw gauge data in IndexedDB (`raw`), carried by `buildup_raw` (≤ 16 MB) and used only when its hash matches. Writes go through `WTS_lsSet` | Well switching parks a 2× copy; a 1.5 MB key can block it app-wide |
| D19 | Responsiveness | One generic driver, `PRiSM_autoInterp.drive(job)`: a terminating chain of one-shot `setTimeout(0)` yields between work units, sliced by **work count**, never by elapsed time. The page captures `{wellId, runToken}` at Analyse; the run is cancelled on detach, well change, project Open or New, and a result for another well or token is discarded. Zero pending timers when idle | Smoke test; virtual clock in the harness |
| D20 | Charts | `drawLineChart` for the time-axis charts (x = days since the first test). A page-local log-log renderer for the per-test diagnostic and the rate-normalised overlay. Canvas size from the `#bu_root` width (720×300; 600×400 below 600 px), `touch-action: pan-y` inside `#bu_root`, series converted to display units | `drawLineChart` is linear only and does not scale with DPR |
| D21 | Quick Report | Final template only: a `pages` section "Build-up surveillance" (`detail:'results'`) straight after the PRiSM section. The daily template is unchanged | A multi-month surveillance section does not belong in a rig daily report |
| D22 | Calibration | 640 single build-ups plus 120 multi-test wells (about 1,000 more build-ups), from an independent seeded generator, run end to end (raw samples plus daily allocation). Folds grouped by well, a staged threshold grid that includes the LOW thresholds, Wilson intervals for single cases and cluster-bootstrap intervals for the pooled table, two tables (k/S label and headline label), frozen in `55-prism-autointerp-cal.js`. 10 cases run in the acceptance tests and 24 in the in-app check | Requirement §13 |
| D23 | Skin decomposition | New `PRiSM_skinCheck.mechanicalSkin` returns S_mech on the **pressure-drop basis** (S_t − S_geo − D·q; what alerts and production loss use) and the **local damage skin** S_d = S_mech·h_w/h (used for treatment design). 34's `PRiSM_skinDecomposition` is unchanged, because its tests pin the additive form | Decomposition scaling |
| D24 | Version | v3.3 everywhere: `RELEASE_NOTES[0]`, `MARKETING_VERSION` ×2, `VERSION_BASE` ×2 | CLAUDE.md |
| D25 | Coordination with the DFIT workstream | Round-8 numbers 53–55 belong to this feature; DFIT files take 56 upwards. The lead is the only editor of `concat-round8.js` FILES for both. The DFIT page goes to Well Test & Flowlines (6 → 7 rows), so Production & Reservoir keeps one free row | Both drafts claimed 55; both wanted the same sidebar group |
| D26 | Label pipeline | One staged pipeline owned by `run` (§4.6 item 18): pass-1 labels → baseline from pass-1 tests ≥ medium → pass 2 (k-held, background, partial-cut suspicion, window-level check) → final k/S labels and the frozen used set → trend → trend model caps applied once, with no feedback into the used set | Removes the circular dependency between labels and trend |
| D27 | Decisions near thresholds | Every threshold test compares inputs rounded to display precision (ΔBIC 0.1, span 0.01 cycle, slope 0.001, ratios 0.001). Canonical inputs are rounded to 6 significant figures | Last-bit differences between JS engines must not flip a model, label or hash |

---

## 1. Scope and user stories

### 1.1 What the page does

The page turns every routine shut-in of a producing (or injection) well into an interpreted pressure build-up (or fall-off). It tracks
k, S, p* and PI over time and raises a skin alert. It then gives the engineer a traceable report with an automated rule-based review
and a sign-off step. PRiSM gains the same checks for any single analysis: automatic IARF window, line-vs-match agreement, skin
uncertainty, a calibrated confidence label, sensitivity and mechanical skin.

### 1.2 Users

- Production or reservoir engineer: weekly surveillance of PDHG wells.
- Well-test engineer: post-test analysis of test data in rate-table mode.
- Reviewer or supervisor: reviews and signs off.

### 1.3 User stories (each is an acceptance item for WP6 or the integration tests)

| # | As … I want … | So that … | Accepted when |
|---|---|---|---|
| US1 | to load a PDHG CSV (or paste, a historian tag, the PRiSM dataset or the demo) and a daily allocation CSV | I can start in one minute | A 500k-row CSV loads with a progress line and no UI block over 150 ms (phone target, §4.8) |
| US2 | every shut-in found, with partial cuts and short shut-ins listed separately | I know what was and was not analysed | The demo shows 9 analysable build-ups, 1 short shut-in "too short" and 1 partial cut "not interpreted" |
| US3 | rates spread over the actual flowing hours, with allocation checks | k and S are not biased by shut-in hours | A day with a 15:00 shut-in reads 24·V/15, and the V/24 alternative is shown as 37.5 % low |
| US4 | each build-up interpreted automatically (IARF window, line, match, rivals only when called for) | I get k, S, C and a model with the reasons | The reference 72 h case gives "fair", agreement and homogeneous |
| US5 | a confidence label per test with the failed rules listed | I know which numbers to trust | The label text lists rule ids and evidence ids, and the calibration tables are visible |
| US6 | skin trend, baseline, delta and absolute alerts, the onset date, the recent rate of rise and a forecast | I can decide on intervention | The demo raises a delta alert confirmed at B7, with the onset within one test interval |
| US7 | Δp across the skin, PI ratio, production at stake and an optional value | I can justify a stimulation review | Numbers match the trend tests (§9 WP3) |
| US8 | uncertainty: S_err composition, the C-held range and input sensitivity | I know whether a rise is real | ±20 % inputs leave the delta alert unchanged (stated, with numbers) |
| US9 | to exclude a test, edit an IARF window, force a model or add a missed shut-in, always with a reason | my judgement is recorded | Each override appears in the audit trail with who, when, why and the app version, and the affected test re-runs |
| US10 | a review whose quoted numbers are checked | the report is not self-contradictory | The evidence check fails, as a V14 critical finding that cannot be accepted, when a number is tampered with |
| US11 | to ask questions ("why this model?", "what if h is 20 % higher?") | I understand the analysis | Answers cite evidence ids, and the what-if numbers equal the analytic sensitivity |
| US12 | to sign off; the report is DRAFT until then and goes back to DRAFT if anything changes | the record is honest | The signature hash is shown; a change of inputs, results or decisions gives a "changed after sign-off" banner; re-running with the same inputs or flipping units and back does not |
| US13 | to open any build-up in PRiSM with its rate history | I can do detailed work | PRiSM shows the build-up period with the multi-rate table after a reload too |
| US14 | a Skin-check card in PRiSM for my current fit | a one-off analysis gets the same checks | The card shows the window, agreement, S_err, label, sensitivity and mechanical skin, and writes no state |

### 1.4 What we add beyond the minimum (chosen and scoped)

| # | Addition | In v3.3 | Not in v3.3 |
|---|---|---|---|
| X1 | Gas wells | Normalised pseudo-pressure (impurity-aware z when `WTS_gaspvt_z` exists), optional pseudo-time for the build-up period, S′, Δp_skin converted back to psi, guarded D separation (M§A19), wet-gas equivalent rate for gas producers with liquids | Condensate-bank quantification (flag only) |
| X2 | Skin decomposition | Partial penetration (Brons–Marting and Papatzacos), deviation (Cinco-Ley et al., validity limits enforced), perforation (Karakas–Tariq, **only if WP7 verifies the coefficients against the paper**), mechanical-skin trend, alerts on mechanical skin | Two-phase near-well skin (review flag only) |
| X3 | Review rules | Bubble point (sandface, with a gradient range), non-Darcy, rate basis, allocation, k stability, PI cross-check, background trend, history estimate, partial-cut suspicion, calibration envelope, five re-derivation rules | — |
| X4 | Observed vs predicted PI | Daily J_obs against the skin-predicted J (M§A21), as a chart and a rule | — |
| X5 | Forecast and value | Crossing date for the absolute threshold, with a Sen-slope range and a horizon cap; rate and cumulative production at stake (constant drawdown and constant rate); optional value per unit volume (no currency symbol) | Economic decline modelling |
| X6 | Robust trend and onset | Theil–Sen and Mann–Kendall, hinge regression with CUSUM confirmation, an "indicative" label when n < 5 | — |
| X7 | Model-free skin change | Rate-normalised Δp at a common IARF time (M§A28), as a cross-check on the fitted ΔS | — |
| X8 | Open in PRiSM, PRiSM Skin check | One public PRiSM function (`PRiSM_openExternalBuildup`) that handles the reload trap; a Tab-6 card, a Tools-drawer entry and a PRiSM report section | — |
| X9 | Overrides, audit, signature, validation card | All of them, plus the in-app 24-case check | — |
| X10 | "Copy for your AI assistant" | A de-identified structured summary plus a built-in review prompt; clipboard or download; free text only on opt-in | Any network call |
| X11 | Multi-well and historian | Per-well state; on-demand scan of a historian tag; a "new data" badge on `wts:historian-updated` (no automatic re-run) | Automatic live rescans |
| X12 | Recommended shut-in length | Numeric IARF reach from the fitted model: the hours needed for a "fair" (0.5 cycle) and a "good" (1 cycle) IARF, allowing for the derivative window | — |
| X13 | Tide index and removal | Q6 index; M2 removal from 24 h and M2 + K1 from 48 h, before the derivative, when r_tide > 0.10 | Full constituent analysis (PRiSM tide module) |
| X14 | Injector fall-offs | Fall detection, sign −1, water bank as the first plateau, half-slope fracture flag, injectivity wording | Thermal-front models |
| X15 | Rate-table (DST-style) mode | Time-stamped rates; periods from the table; the rise detector only refines closing times; spans, slopes and reach in log10 Δt_e | — |
| X16 | Workover and stimulation dates | A new baseline segment and a new partial-cut reference after each entered date; suspected interventions flagged with a prompt to enter one | — |

### 1.5 Deliberately out of scope (deferred, with the reason; each goes to `docs/ROADMAP.md` in WP9)

- **Multi-build-up deconvolution on the page.** `PRiSM_deconvolve` blocks the UI for 1.6–1.8 s, synchronously. The user can reach it through "Open in PRiSM", which passes the full history.
- **A phase-redistribution model term (Fair).** v3.3 flags the anomaly and starts the fit after it (M§A15).
- **Interpretation of partial rate cuts.** Classified, put into the rate history and listed (Q11).
- **Interference modelling of offset wells.** Flagged through the negative late derivative and the background check.
- **Two-phase near-well skin quantification.** Review flag only.
- **A PDF watermark.** None exists in the app; DRAFT is a verdict line plus subtitle text.
- **Worker threads.** The harness has none. The sliced driver is the only path.

---

## 2. Architecture

### 2.1 Files, rounds and owners

| File | Round | Owner | Contents |
|---|---|---|---|
| `prism-build/53-prism-autointerp.js` (new) | 8 | WP0 skeleton (`version`, `canon`, `hash16`), then WP1 | `PRiSM_autoInterp`: canonical JSON and hash16 (frozen after WP0), binning, masked derivative, storage, IARF, line, triggers and flags, grid entry, sliced fits, closed-circle and two-zone kernels, BIC, fully seen, agreement, C-held, S_err, sensitivity, numeric reach, confidence, history and background checks, k-held, gas table, `interpret`, `interpretJob`, `drive`, `stats`. Registers `PRiSM_MODELS.closedCircle` |
| `prism-build/54-prism-skin.js` (new) | 8 | WP7 | `PRiSM_skinCheck`: perforation skin, mechanical skin (both bases), guarded rate-dependent skin, PI and skin products; the Skin-check panel (Tab 6), `PRiSM_renderSkinCheckPanel`, the `PRiSM_reportSections` entry |
| `prism-build/55-prism-autointerp-cal.js` (new, **generated**) | 8 | WP4 writes the generator and a placeholder; WP8 regenerates it | `PRiSM_autoInterpCal`: thresholds, reliability tables, envelope, in-app case list with margins |
| `prism-build/49-calc-buildup-data.js` (new) | 9 | WP2 | `WTS_buildup.data`: chunked parser, sniffing, historian and PRiSM import, QC, detection, closing refinement, partial cuts, interventions, missed events, zones, allocation, rate spreading, consistency, rate table, history steps |
| `prism-build/49-calc-buildup-run.js` (new) | 9 | WP2 | `WTS_buildup.run`: the staged pipeline (pass 1, baseline, pass 2, final labels, trend, trend caps), overrides, cache, hashes; `window.WTS_buildup_compute` |
| `prism-build/49-calc-buildup-trend.js` (new) | 9 | WP3 | `WTS_buildup.trend`: baseline, alerts, onset, recent trend, forecast, Δp skin, PI ratio, production at stake, k stability, pressure trend, model-free ΔS, bubble point, PI cross-check, mechanical and rate skin series, interpretation table, recommendations, limitations |
| `prism-build/49-calc-buildup-synth.js` (new) | 9 | WP4 | `WTS_buildup.synth`: seeded PRNG, independent forward model (own Bessel functions and Stehfest N = 16), real-time record and allocation generator, strata sampler, demos (oil, gas), in-app case list, scorer |
| `prism-build/49-calc-buildup-review.js` (new) | 9 | WP5 | `WTS_buildup.review`: evidence index, rules V1–V27, evidence check with its own formula registry, Q&A, report model, SHA-256, signature, sign-off logic, AI export |
| `prism-build/49-calc-buildup-store.js` (new) | 9 | WP6 | `WTS_buildup.store`: IndexedDB stores with memory fallback, raw encoding, project modules `buildup_raw` and `buildup_analysis`, `wts_buildup_state` / `wts_buildup_audit` access with the size guard |
| `prism-build/49-calc-buildup-plot.js` (new) | 9 | WP6 | `WTS_buildup.plot`: log-log renderer, overlay, trend charts (through `drawLineChart`) |
| `prism-build/49-calc-buildup.js` (new) | 9 | WP6 | Page: registry entry, render, `window.calcBuildup`, UI, dialog, report rendering, Open in PRiSM (through the PRiSM function), `WTS_state.buildup`, unit categories (registered at module load) |
| `prism-build/buildup-validate.js` (new) | tool | WP4 (tool), WP8 (runs) | Offline benchmark, calibration and the `--write` generator for file 55 |
| `prism-build/tests/_buildup-shapes.js` (new) | test helper | WP0 (frozen afterwards) | Executable contract: `checkShape(name, obj)`, the fixtures `FIX.analysis` and `FIX.result`, and a test-only formula table `FORMULAS` |
| `prism-build/tests/_buildup-idb-fake.js` (new) | test helper | WP6 | A small IndexedDB fake (open/put/get/delete, `onupgradeneeded`, a failure path) |

Every Round-9 file is a single IIFE that merges into `G.WTS_buildup = G.WTS_buildup || {}` and owns exactly one sub-object. Only the
page registers in `WTS_calcRegistry`. The helper files carry the header line "helper module: does not add a page to
window.WTS_calcRegistry", so `concat-round9.js` builds them without a warning.

### 2.2 Load order and feasibility (verified on this checkout)

- **Round 8.** `concat-round8.js` has a hand-kept `FILES` list (l.18–27: 33–37, 39, 51, 52). WP0 (the lead) appends
  `'53-prism-autointerp.js'`, `'54-prism-skin.js'` and `'55-prism-autointerp-cal.js'`. Missing files are skipped with a warning, so the
  list can be updated before the files exist. The harness builds Round 8 from FILES only (`_harness.js:97-101`), so the FILES edit
  **must** land (WP0) before WP1/WP7 can test their files in the app harness. Numbers 53–55 are free (50 = Round 6, 51–52 = Round 8,
  6N = Round 10); DFIT takes 56 upwards (D25).
- **Round 9.** `concat-round9.js` sorts by number, then by a **plain string comparison** (l.30–33). `'-'` (0x2D) sorts before `'.'` (0x2E),
  so every `49-calc-buildup-*.js` loads before `49-calc-buildup.js`, and all of them load before `49-calc-cheminj-info.js`. The
  order does not matter for correctness anyway: **every cross-file call looks the function up at call time**
  (`G.PRiSM_autoInterp.interpret(...)`) and never captures it at load.
- **Round 8 before Round 9.** Round 9 anchors after the Round-8 END, so the page can call PRiSM at render time. Round-8 code may call
  Round-9 functions (`WTS_gaspvt_z`) only at call time and behind a `typeof` guard.
- **Smoke stub.** Module load must not throw without `document`, `WTS_units`, `drawLineChart`, IndexedDB or PRiSM. Engines start no
  timers at load. Module-load listeners are attached only when `typeof document !== 'undefined' && typeof document.addEventListener
  === 'function'`. `getElementById` returns a stub in the smoke test, so `render` guards on `body.id === 'pgBody'` (cheminj pattern).
- **Self-test.** Each file ends with exactly one `// === SELF-TEST ===` IIFE. It covers only the file's own pure functions and is
  stripped by concat.

### 2.3 Data flow

```
 CSV / paste / historian tag / PRiSM dataset / demo        daily allocation CSV  |  time-stamped rate table
            │                                                      │
            ▼                                                      ▼
 WTS_buildup.data.parseJob ──► GaugeRecord ──► data.qc ──► QC      data.parseAllocation ──► AllocRows
            │                                   │
            ▼                                   ▼
 data.detect (M§A2) ─► data.refineClosing (M§A3) ─► data.classify (M§A4, allocation, interventions) ─► Events + Missed (M§A5)
            │
            ▼
 data.rates (M§A6/A7, resolved zones, offset scan, history start) ──► RateHistory (days, steps)
            │
            ▼  per analysable event: run.specFor ──► BuildupSpec (bins via PRiSM_autoInterp.bin, rateQC, σ_LF, pwf0 se)
            ▼
 stage 1  PRiSM_autoInterp.interpretJob(spec)  ──► BuildupResult per test, pass-1 labels
            │      (prep → storage → IARF → line → homogeneous fit → reach → BIC → agreement → C-held → triggers → rivals →
            │       fully seen → final → p* range → S_err → sensitivity → confidence)
            ▼
 stage 2  trend.baseline over pass-1 tests ≥ medium ──► k_base, CV_k, kh_base
 stage 3  pass 2: k-held fits, backgroundCheck, partial-cut suspicion, window-level check ──► final k/S labels, frozen used set
 stage 4  WTS_buildup.trend.compute(tests, ctx) ──► Trend (uses PRiSM_skinCheck.mechanicalSkin / rateSkin)
 stage 5  trend model caps (closed circle without depletion) applied once ──► final model labels
            ▼
 Analysis ──► review.evidence → review.run → review.report ──► page renders the ReportModel (+ charts) into #bu_res
            │                                                    │
            ▼                                                    ▼
 store.saveState (wts_buildup_state, overflow to IndexedDB)  audit trail / sign-off (wts_buildup_audit)
```

PRiSM side: the Skin-check card builds `adata` with PRiSM's own C2 (`PRiSM_getAnalysisData`, the user's own settings are right
there). It then calls the same `PRiSM_autoInterp` pieces on `PRiSM_getLastFit()` and `PRiSM_skinCheck.*`.

### 2.4 Reuse of PRiSM code

| Function (file:line) | Used for | How |
|---|---|---|
| `PRiSM_fitPhysical` (05:1608) | All fits | Called with `{entry, isolated:true, dataset: spec-ds, singleStart:true, evalBudget, lmState, slice, start, freeze, params0, window}`; `well.defaulted = []`, `well.complete = true`. Never with `timeBudgetMs` or `race` (wall clock) |
| `PRiSM_physicalModel` (33:914) | Forward Δp for BIC, the bias line, model pi, p_ext, history and background checks | `{entry, isolated:true}` |
| `PRiSM_evalWbsSkin` (03:363) | Closed-circle and two-zone kernels | Kernel `lapRes(s, dScale)` folded with WBS and skin |
| `PRiSM_lm` (05:376) | Only through `fitPhysical` | — |
| `PRiSM_compute_bourdet` (02:1603) | The fit's derivative block (data and model, on the 12-per-cycle fit bins). Not used by the IARF detector, which has its own full-window Bourdet | `L = 0.2303·(Lcyc/0.1)` |
| `PRiSM_timeFunction` (33:511) | Superposition x for the hand-built adata | `{kind:'superposition', terms}` |
| `PRiSM_semilogAnalysis(adata, well, opts)` (34:1550) | Line through an explicit window, with the W term (superposition skin) | Never with `opts.store` during a scan |
| `PRiSM_semilog.linfit`, `localLogSlope` (34) | Helpers | — |
| `PRiSM_skinSummary` (34:576) | ΔpS, FE, DR, J | Explicit inputs |
| `PRiSM_pseudoSkin.bronsMarting`, `.cincoLey` (03:437/453) | Partial penetration, deviation | From 54 |
| `PRiSM_mpTable` (16:844), `PRiSM_pvt_correlations` | Gas m(p) fallback, μg | When `WTS_gaspvt_z` is missing |
| `PRiSM_gasPseudoTime` (52:154) | Pseudo-time for the build-up period | Explicit p0, T, SG |
| `PRiSM_convert` (33:865) | Constants | — |
| `PRiSM_openExternalBuildup` (33, new, WP1) | **Only** for "Open in PRiSM" (§6.10), after a user confirm | It owns every PRiSM store write |
| `drawLineChart` (host 2000) | Time-axis charts | `typeof` guard |
| `WTS_units.tagInput`, `runCanonical`, `format`, `convertCategory`; host `_uFmt` | Units | — |
| `WTS_historian.query`, `.listTags` | Historian source | Promise; no polling |
| `WTS_project.registerModule` (29-project-save:243) | `buildup_raw`, `buildup_analysis` | Synchronous `read()` from the memory mirror |
| `WTS_wells.active()` | Store keys, run token | — |
| `WTS_lsSet` (host 948), `WTS_pageAutosave.flush` (host 1350) | Quota-safe writes; refresh of the comparison cache | — |

**Never called during a scan:** `PRiSM_getAnalysisData`, `PRiSM_getWell`, `PRiSM_rateHistory`, `PRiSM_autoMatch(Sync)`,
`PRiSM_applyAutoMatchRow`, `PRiSM_setLastFit`, `PRiSM_setWell`, `PRiSM_commitDataset`, `PRiSM_skinVsRate`,
`PRiSM_semilogAnalysis()` without data or with `store`, `PRiSM_refreshInterpretation`, `PRiSM_classifyRegimes` (it misreads the
WBS–skin hump as linear flow), and `PRiSM_deconvolve` (synchronous, 1.7 s). A WP1 test checks that a full `interpret` leaves
`localStorage`, `PRiSM_state` and the event log unchanged.

### 2.5 Additive edits to existing files (exact)

| File | Round | Owner | Edit | Test that proves it |
|---|---|---|---|---|
| `05-regression.js` `PRiSM_fitPhysical`, `_getPM`, `_localPhysicalModel`, `PRiSM_lm` | Phase 3+4 | WP1 | (1) `var entry = (opts.entry && typeof opts.entry.pd === 'function') ? opts.entry : _registry()[modelKey];`. (2) At l.1636 pass the options through: `_getPM(modelKey, well, adata, { floatPi: floatPi, mode: opts.mode, params0: opts.params0, entry: opts.entry, isolated: opts.isolated })`, and `_localPhysicalModel` uses `opts.entry` when given. (3) `opts.evalBudget` (a count-only `lmOpts.shouldStop = () => nEval >= evalBudget`, no `deadline`), `opts.lmState {lambda, ssr, stagnant}` (resume λ, skip the initial evaluation, keep the plateau counter) and `opts.slice:true` (skip `modelDpAll`, `derived()` and the final Jacobian/CI; the last slice runs without it). The result gains `lmState` and `nEval`. (4) `PRiSM_lm`: `O.ssr0`, `O.stagnant0` (`O.lambda0` already exists); its result gains `lambda`, `nEval`, `stagnantSteps` | EN8, EN8b, EN20. Existing wp2 tests unchanged |
| `04-ui-wiring.js` `MODEL_NAMES` (l.1443) | Phase 3+4 | WP1 | `closedCircle: 'Closed circle'` | wp7-ui |
| `33-pta-core.js` `PRiSM_physicalModel` | Round 8 | WP1 | Same `entry` line. In `toModelParams`, `var stP = opts.isolated ? {} : (...)`. New public `PRiSM_openExternalBuildup(o)` (§6.10). No other change | EN8: with `PRiSM_state.model = 'linearBoundary'` and `params.BC = 'constP'`, an isolated fit still uses `'noflow'`; EN21 |
| `51-prism-workspace.js` `PLAIN_RAW` | Round 8 | WP1 | `closedCircle: ['Closed circular reservoir (well at the centre).', 'Flat, then the derivative bends up to a unit slope (pseudo-steady state).', 'closed circle circular bounded drainage radius depletion']`. Do not use the word "compartment" (the 'closed compartment' search must still rank `closedRectangle` first) | wp15 "plain info for every model" |
| `13-auto-match.js` model-name map | Round 2 | WP1 | `closedCircle: 'Closed circle'` (name only; **no change to the regime library or candidate lists**) | wp3 tests unchanged |
| `11-polish.js` schematic switch | Round 2 | WP1 | `case 'closedCircle': return _schematic_closedCircle();` (a circle boundary with a centred well) | wp7 thumbnail count 46 |
| `tests/wp7-ui.test.js` | — | WP1 | 45 → 46 models (l.212), 41 → 42 transient (l.213, l.244, l.253), 45 → 46 thumbnails (l.225), "of 41" → "of 42" (l.246) | itself |
| `concat-round8.js` | — | WP0 (lead only, D25) | FILES += 53, 54, 55; banner text | concat runs |
| `29-multiwell.js` | Round 6 | WP6 | `_extract`: `if (st.buildup) r.buildup = _ok(st.buildup) ? {S, dS, alertCode, k} : null`. `ROWS` += 4 rows (latest skin, skin change vs baseline, skin alert, k median); the alert row maps the status code through a label map, not `_uv`; `src: 'Build-up Surveillance'` | IN4; `platform-multiwell` (row count updated by WP6) |
| `well-testing-app.html` (host, outside injection sentinels) | hand edit | WP6 | `'buildup'` after `'gaslift'` in `__NAV_ORDER`. `RT_BUILTIN` final: insert the section after the `prism` section (daily unchanged). Next to l.11284: `window.WTS_appVersion = function () { return (RELEASE_NOTES[0] && RELEASE_NOTES[0].ver) \|\| ''; };`. Next to `_snapshotPage` (l.3226): `window.WTS_snapshotNow = function () { clearTimeout(_snapTimer); _snapshotPage(); };` | PG9, PG16 |
| `well-testing-app.html` `RELEASE_NOTES` | hand edit | WP9 | v3.3 entry (§10) | `app-version` |
| `ios-app/ios-additions/ios-styles.css` | — | WP6 | New section copying the cheminj two-part pattern (l.168–185): the overlay `html.ios-app #bu_root .bu-dlg` gets the safe-area padding and `box-sizing:border-box`; the inner `.bu-dlg-box` gets `max-height: calc(100vh - <insets>)` then `max-height: calc(100dvh - <insets>)`; controls and the close × at least 44 px | PG15 (CSS string) and `ios-webkit-check.js` in WP9 |
| `smoke-test.js` | — | WP6 | §9 WP6 list (9 checks) | itself |

`tests/platform-reports.test.js` is **not** edited (D21: the daily template keeps 8 sections; the final-template check is a subset in order).

### 2.6 Rules for parallel worktrees

1. Each WP works in its own worktree and branch off Dev **after WP0 has merged**.
2. **Commit sources only.** Never commit `well-testing-app.html` rebuilt by an inject script, `ios-app/www/index.html` or any
   `combined-*.js` from a WP branch. Tests run with `--sources` (the default), which builds in memory. The exceptions are WP6
   and WP9: they commit host **hand edits** to `well-testing-app.html`, outside the injection sentinels, on top of Dev's copy, with no
   inject run included.
3. **Smoke on a WP branch.** `smoke-test.js` reads `.tmp/wts-main.js` extracted from the built HTML (l.83). To run it on a branch:
   rebuild locally (the rounds the branch touches, §2.5), run smoke, then `git checkout -- well-testing-app.html ios-app/www/index.html
   prism-build/combined-*.js` before committing.
4. A file belongs to exactly one WP (§2.1, §2.5). If a WP needs a change in another WP's file, it asks that owner. The lead arbitrates.
5. Code against §3 and the fixtures in `tests/_buildup-shapes.js`, not against another branch. Cross-WP tests live only in
   `buildup-integration.test.js` (WP6), which lands last.
6. **Integrator (lead)** merges in the order of §9.0 and rebuilds the rounds the merged files belong to:
   - after WP7-M1 and the WP7 card: Round 8;
   - after WP3, WP5 and WP2: Round 9;
   - after WP1: Phase 3+4 (05, 04), Round 2 (11, 13) and Round 8 (33, 51, 53);
   - after WP4: Round 8 (55 placeholder) and Round 9;
   - after WP6: Round 6 (29-multiwell) and Round 9, on top of the host hand edits;
   - after WP8: Round 8.

   Then `sync-from-main`, `node --check`, smoke and the targeted acceptance files, and commit the rebuilt artefacts on Dev.
   **CRLF:** run CLAUDE.md's re-normalisation step only when the working copy is CRLF, checked with node (`html.includes('\r\n')`);
   on an LF checkout skip it (git stores LF).
7. No WP edits `docs/DFIT-PLAN.md` or anything belonging to the DFIT workstream. Round-8 numbers 53–55 are this feature's; DFIT files
   take 56 upwards; only the lead edits `concat-round8.js` FILES (for both workstreams); the DFIT page goes to Well Test & Flowlines
   (D25). WP9 records both rules in CLAUDE.md.

---

## 3. Interfaces (exact)

### 3.0 Rules common to every interface

- **Units.** Engine input and output are field units (see Conventions). Record- and allocation-level times are **epoch ms UTC**.
  Engine-level times are **hours on the history clock**: hours since `origin_ms`, the first gauge sample. Rate steps before the record
  have negative hours. Production days are labelled `'YYYY-MM-DD'`.
- **Numbers.** Every output number is finite or `null`. Engines never emit NaN or Infinity; they convert them to `null` and add a
  warning. Masked array entries are `null`. Arrays crossing a WP boundary or going to storage are plain arrays (JSON-safe). Internal
  work may use `Float64Array`.
- **Failure.** `{ok:false, code:'<UPPER_SNAKE>', errors:[string], bad:[fieldName]}`. Partial success: `ok:true` with `warnings`.
  `WTS_buildup_compute({})` returns `{ok:false, code:'NO_DATA', ...}` and never throws.
- **Warnings and verdicts.** `{code, level:'info'|'warn'|'bad', text, ev:[evidenceId]}`. `text` is plain, under 299 characters, and
  never contains the words "null" or "undefined" (GUI-sweep text scan).
- **Purity.** Engines touch no DOM, no storage and no timers, and fire no events. The exceptions are `PRiSM_autoInterp.drive`
  (setTimeout(0) chain), `WTS_buildup.store` (IndexedDB and localStorage), `WTS_buildup.plot` (canvas) and the page.
- **Determinism.** No `Math.random` in any engine file (a test greps the sources). The only PRNG is `WTS_buildup.synth.rng(seed)`.
  Work slicing is by count. Threshold tests compare values rounded per `DEFAULTS.round` (D27).
- **Listeners at module load** are attached only behind `typeof document !== 'undefined' && typeof document.addEventListener ===
  'function'`, and every handler checks `#bu_root` (or the PRiSM mount) before doing anything.
- **Evidence ids.** `<group><n>` for well-level items (`Q1`, `T4`, `V7`) and `B<k>·<group><n>` for test-level items (`B3·I1`).
  Groups and numbers are fixed in §8.1. Every result object that produces an item carries `ev:[ids]` (ids relative to the test, such as
  `'I1'`). The review layer prefixes the test id.
- **Hashes.** Every `hex16` value is `PRiSM_autoInterp.hash16(PRiSM_autoInterp.canon(obj, mode))` (§3.1). Only the signature uses
  SHA-256 (§3.10).

### 3.1 `window.PRiSM_autoInterp` (53, WP0 skeleton, then WP1)

| Function | Signature | Returns |
|---|---|---|
| `version` | string | `'1.0'` |
| `canon(obj, mode)` | `mode` `'inputs'` (numbers to 6 significant figures) or `'display'` (the §8.4 per-key display precision); keys sorted; NaN/±Infinity → `null`; `undefined` dropped | canonical JSON string. **Frozen after WP0** |
| `hash16(str)` | UTF-16 code units of the string | 16 hex characters: two 32-bit FNV-1a passes with different offset bases (0x811c9dc5 and 0x050c5d1f), computed with `Math.imul` only and concatenated. Bit-identical on every engine. **Frozen after WP0** |
| `DEFAULTS` | frozen object | §4.10, keys below |
| `bin(dt, p, opts)` | `dt` h (> 0, ascending), `p` psia; `opts {perCycle=20, dtMin=null, counts=null}` | `{dt:[], p:[], n:[]}`: medians per log bin; single-sample bins keep the raw value |
| `derivative(x, dp, Lcyc, opts)` | `x` = ln Δt_e (ascending), `dp` psi, `Lcyc` log10 cycles | `{deriv:[number\|null], full:[bool], neg:[index], L_ln}` |
| `prepare(spec)` | `BuildupSpec` | `Prep` or failure (`NO_DATA`, `BAD_HISTORY`, `TOO_FEW_POINTS`, `BAD_WELL`) |
| `storage(prep)` | | `Storage` |
| `iarf(prep, opts)` | `opts` overrides `DEFAULTS.iarf`; `opts.window {dt0_h, dt1_h}` forces a window | `Iarf` |
| `line(prep, iarf, opts)` | | `Line` (with the shifted lines for S_win) or `null` (no window) |
| `gridEntry(key, prep, opts)` | `key` ∈ `homogeneous`, `linearBoundary`, `composite2`, `closedCircle`; `opts {perDecade=10}` | registry-like entry `{pd, pdPrime, paramSpec, defaults, refLength:'rw', kind:'pressure', timeInput:'td', category, description, reference, evalCostMs, base}` |
| `fitJob(key, prep, opts)` | `opts {start, freeze, params0, maxIterTotal=40, objective='dp+deriv'}` | `Job<ModelFit>` |
| `fit(key, prep, opts)` | | `ModelFit` (synchronous loop over `fitJob`) |
| `reach(prep, homFit)` | | `Reach` (numeric, §4.6 item 5b) |
| `predictors(k, h, mu, C, S)` | | `{tUs_h, tHump_h}` from the correlation (Appendix A.1); used **only** to seed C when the unit slope is missing |
| `triggers(prep, iarf, reach)` | | `{triggers: Triggers, flags: [Flag]}` |
| `bic(prep, fits, opts)` | | `BicTable` |
| `fullySeen(key, prep, iarf, fit)` | | `FullySeen` |
| `agreement(line, fit, prep)` | | `Agreement` (with the bias of every shifted line) |
| `cHeldJob(prep, fit, opts)` | `opts {mode:'auto'\|'off'\|'extended'}` | `Job<CHeld>` |
| `pStarRange(prep, line, spec)` | | `{lo, hi, byFactor:{0.5, 1, 2, 10}}` when `history.estimated`, else `null` |
| `pExt(prep, fit, family)` | `family` `'infinite'\|'closed'`; `fit` the test's chosen fit (closed family: r_e from the analysis) | psia at the gauge: p* (infinite) or p̄ (closed) |
| `kHeldJob(prep, opts)` | `opts {k, delta}` | `Job<KHeld>`: the k-held fit plus two refits at k·(1 ± δ) |
| `sErr(parts)` | `{mode:'line'\|'kHeld'\|'model', seS, nOverNeff, sLine, sMatch, sWin, sTc, sPwf, sK, sC, sSens, floor}` | `SErr` |
| `sensitivity(final, well, ranges)` | `ranges {req, typ}`, each `{h, phi, ct, rw, B, mu, q}` fractions (§4.6 item 16) | `Sensitivity` |
| `confidence(ev, cal)` | `ev` = `EvidenceVector` (below); `cal` = `PRiSM_autoInterpCal` or null | `Confidence` |
| `rinv(k, dt_h, well)` | | ft: `0.0325·√(k·Δt/(φμct))` |
| `compactHistory(steps, tc_h, dtEnd_h, opts)` | `opts {keepFactor=10}` | `{steps:[{t, q}], nKept, nLumped, lumped:{t0, t1, q, V}\|null}` |
| `gasTable(gas)` | `{sg, T_F, co2, h2s, n2, pmax}` (mol %) | `{ok, p:[], m:[], z:[], mu:[], cg:[], mOf(p), pOf(m), pn(p), pOfPn(pn), ref:{p, mu, z, ct, Bg}, impurityAware:bool}` |
| `backgroundCheck(result, spec, dpdt_psi_h)` | | `{applied, slopeSource:'pstar'\|'drift', triggersBefore:[], triggersAfter:[], boundaryDepends:bool, ev:['M7']}` |
| `interpretJob(spec, opts)` | `opts {cal, rivals, cheld}` | `Job<BuildupResult>` (stage 1: pass-1 result and labels) |
| `interpret(spec, opts)` | | `BuildupResult` (synchronous; identical to the job's result) |
| `drive(job, opts)` | `opts {shouldCancel():bool, onProgress(frac, label)}` | `Promise<result>`. Rejects with `{code:'CANCELLED'}` on cancel. **The only timer user in Round 8** |
| `stats()` / `resetStats()` | | `{evals, gridBuilds, fits, lmIters, slices, lines}` (counters for tests) |
| `kernels` | | `{closedCircleLap(s, reD), composite2Lap(s, M, F, R)}` (exposed for tests) |

**`Job<T>`:** `{step(): {done:bool, progress:number 0..1, label:string}, result(): T|null, cancel(): void}`. Each `step()` does one
work unit of at most `DEFAULTS.budget.unitMs` estimated desktop cost (§4.8). `interpret` = `while (!job.step().done); return job.result();`.

**`BuildupSpec`** (built by `WTS_buildup.run.specFor` or by the PRiSM Skin check; in-memory form):

```js
{
  id: 'B3',                                  // string, unique in the analysis
  testType: 'buildup' | 'falloff',           // falloff → sign −1 (injector)
  tc_h: 1234.567,                            // refined closing time, history clock (h)
  dtc_h: 0.0021,                             // closing-time uncertainty (h), ≥ 0
  pwf0: 2481.3,                              // psia at the gauge, flowing trend at tc
  pwf0SE: 0.11,                              // psi, standard error of pwf0 (trend residuals, σ_flow), §4.3
  dpdt_flow: -0.42,                          // psi/h, flowing-trend slope at tc (for S_tc)
  dt: [0.0028, ...],                         // Δt (h) > 0, ascending: raw samples OR bins
  p:  [2493.1, ...],                         // psia at the gauge, same length
  n:  [1, ...] | null,                       // sample counts when pre-binned (null = raw)
  steps: [{t: -720, q: 812}, ..., {t: 1234.567, q: 0}],  // full history, history clock, ends with q = 0 at tc
  qUnit: 'STB/d' | 'Mscf/d' | 'bbl/d',       // bbl/d for water injection
  Dq: 805.2,                                 // rate before closing (positive; injection rate for falloff), ×fRate already applied
  fRate: 1,                                  // f̂ applied when 0.9 ≤ f̂ < 0.95 (label cap KC6), else 1
  rateQC: { source: 'allocation'|'table'|'measured', r3: number|null, r3Status: 'pass'|'fail'|'unavailable'|'n/a',
            r4: number|null, r4Status: 'pass'|'fail'|'unavailable'|'n/a', dqKnown: bool,
            dqSource: 'closingDay'|'previousDay'|'qref'|'table', equalRateAssumed: bool, ignoresShutin: bool, allocAccPct: 5 },
  well: { fluid:'oil'|'gas'|'water_inj', h, phi, mu, B, ct, rw, T_R: null|number, re_ft: null|number,
          defaulted: ['h', ...] },           // mu/B are water values for injectors; defaulted is for V13 and labels only
  gas: null | { sg, T_F, co2, h2s, n2, pseudoTime: bool, pdew: null|number },
  sigma_psi: 0.012,                          // robust gauge noise from QC (Q1)
  sigmaFlow_psi: 0.08,                       // flowing-period noise (slugging) from QC
  sigmaLF_psi: 0.02 | null,                  // low-frequency noise at the derivative scale, computed by specFor (§4.2)
  dtSample_h: 0.0167,                        // median sampling interval
  driftPsiPerDay: 0.01,                      // assumed gauge drift (input)
  history: { estimated: bool, tPrepend_h: number, source: 'data'|'date'|'cum'|'default' },
  overrides: { window: null | {dt0_h, dt1_h}, model: null | key, excludeRivals: [key] },
  opts: { Lcyc: 0.1, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: 'auto'|'none'|'all',
          cheld: 'auto'|'off'|'extended', tide: 'auto'|'off' }
}
```

**Stored form.** `TestEntry.spec` replaces `steps` with `stepRef: {from, to}` (indices into `analysis.rates.steps`, whose step `to` is the
q = 0 step at t_c) and keeps `dt`, `p`, `n` at 6 significant figures. `run` rehydrates `steps` before calling the engine.

**`Prep`** (internal, but exposed for tests and the Skin check): `{ok, id, sign, bins:{dt, dte, X, dp, n, sigma_b}, deriv:{deriv, full,
neg, L_ln}, fitSet:{idx}, adata, well, gasTable|null, histFull:{steps}, histFit:{steps (compacted)}, snrD, rDrift, rTide,
tideRemoved:bool, warnings}`, where:

- `adata` (C2-shaped; every field PRiSM reads): `ok:true`; `t` (Δt h on the 12-per-cycle fit bins); `p` (psia); `dp` (sign-aware);
  `x` and `lnx` (superposition time function and its log); `deriv` (`PRiSM_compute_bourdet(x, dp, L)` on the same fit bins, D6); `L`
  (ln units); `timeFn:'superposition'`; `timeFnSpec {kind:'superposition', tp, terms:[{w, off}]}` from the compacted history; `sign`
  (+1 build-up, −1 fall-off); `pRef` = `pRefPressure` = pwf0; `pRefSource:'pwf0'`; `dRef:'start'`; `testType`; `tStart` = `tShut` =
  t_c (h); `tp`; `qRef` = `qFlow` = Δq; `rateHistory [{t, q}]` (compacted, ending with q = 0 at t_c); `stepIndex`; `periods:[]` (34 then
  builds its steps from `rateHistory`); `fluid`; `pseudo` and `mpSpec` (gas); `dpUnit`; `warnings:[]`.
- `well` (C1-shaped, as passed to PRiSM): `{fluid, q: Δq, B, mu, ct, h, phi, rw, T_R (gas), pi:null, complete:true, missing:[],
  defaulted:[]}`. Defaulted inputs never reach `fitPhysical` (which would flag S "not identifiable" with a PRiSM-only message);
  they are handled by V13 and the label.

**`BuildupResult`** (per test; the stored copy drops `curves`, `bins.X` and `bins.dte`, which are recomputable, and is under 6 kB JSON):

```js
{
  ok: true, id: 'B3', version: '1.0', inputHash: 'hex16', testType: 'buildup',
  reason: null | 'NO_IARF_TOO_SHORT' | 'NO_IARF_NO_MODEL' | ...,      // when ok:false or no IARF
  bins:   { dt:[h], dte:[h], dp:[psi], n:[int], deriv:[psi|null], full:[bool], X:[ln] },
  quality:{ sigma_psi, sigmaFlow_psi, sigmaD_psi, snrD, rDrift, rTide|null, tideRemoved, tideFit: 'none'|'M2'|'M2K1',
            ev:['I5','Q5','Q6'] },
  storage:{ unitSlope: bool, C_us: number|null, tHump_h: number|null, humpRatio: number|null,
            seed: { tUs_h, tHump_h } | null, humpConsistent: bool|null, ev:['W1','W2','W3'] },
  reach:  { t10_h, t5_h, fair_h, good_h, fairShut_h: number|null, goodShut_h: number|null, reachable: bool, ev:['W4'] },
  iarf:   { found: bool, grade: 'good'|'fair'|'none', noiseWidened: bool, status: 'ok'|'tooShort'|'expectedNotFound',
            dt0_h, dt1_h, X0, X1, cycles, level_psi, slope, slopeSE, slopeLast, slopeLastSE, band, slopeTol, noiseLimited: bool,
            pointSkin: { spread, min, max }, longest: null | { dt0_h, dt1_h, cycles },
            secondLevel: null | { dt0_h, dt1_h, level_psi, ratio }, laterPlateaus: [{dt0_h, dt1_h, level_psi}],
            forced: bool, reason: string, ev:['I1','I2','I3','I4','I6'] },
  line:   null | { method:'superposition'|'horner', k, kh, S, m, pStar, pStarRange: null|{lo, hi}, p1hr, r2, dt0_h, dt1_h, n,
                   shifts: [ { dX, dt0_h, dt1_h, S, bS: number|null } ],      // S_win lines (0, 1 or 2)
                   plateauCheck: { khDiffPct, dS, pass }, ev:['L1','L2','L3'] },
  triggers:{ up: bool, down: bool, level: bool, none: bool, noneSkipped: bool, fired: ['T-up', ...], ev:['M2'] },
  flags:  [ { code:'valley'|'halfLate'|'earlyQuarter'|'earlyHalf'|'humpDp'|'steepStorage'|'negLate'|'fracHalf',
              dt0_h, dt1_h, text } ],            // M7
  models: [ ModelFit, ... ],                        // homogeneous first, then rivals in fit order
  bic:    { n, nEff, rho1, tau, basis: 'logDp', floorUsed: bool,
            rows: [ { key, bic, dBicHom, p, eligible, why:[string] } ], chosen: key, margin: number|null, ev:['M4'] },
  chosen: { key, label: 'Homogeneous'|'Sealing fault'|'Radial composite'|'Closed circle', fullySeen: FullySeen,
            reason: string, ev:['M6','M5'] },
  agreement:{ agree: bool, mode: 'raw'|'bias'|'none', dkPct, dS, biasKPct: number|null, biasDS: number|null, ev:['A1'] },
  final:  { k, kh, S, C, source: 'match'|'line'|'model'|'kHeld', m, mPrime, pStar: number|null,
            pStarRange: null | {lo, hi}, pExt: number|null, pExtKind: 'pStar'|'pbar', piModel: number|null,
            rinv_ft, rinvE_ft, dpSkin_psi, distances: { dF_ft?, R_ft?, re_ft? },
            minFaultDist_ft: number|null, gas: null | { Sprime, dmSkin, dpSkin_psi }, ev:['A2'] },
  cheld:  { triggered: bool, mode: 'pair'|'extended', refits: [ { f, k, S, C, dBic, rejected } ],
            range: { C:[lo,hi], k:[lo,hi], S:[lo,hi] }, S_C: number, meaningful: bool, ev:['C1'] },
  sErr:   { value, mode: 'line'|'kHeld'|'model', floor, seS, dLineMatch, sWin, sTc, sPwf, sK,
            driver: 'floor'|'se'|'lineMatch'|'window'|'tc'|'pwf'|'kHeld', ext: { value, S_C }, sSens, sAbs, ev:['U1'] },
  sensitivity: { req: [ { input, f, k, S, dkPct, dS } ], typ: [ ... ],
                 dominantK: { req, typ }, dominantS: { req, typ }, sSens, muNoEffectOnS: true, ev:['U2','U3'] },
  history:{ estimated: bool, dDerivPct: number|null, sensitive: bool, ev:['R5'] },
  background: null | { applied, slopeSource, boundaryDepends, ev:['M7'] },     // filled in pass 2
  kHeld:  null | KHeld,                                                       // filled in pass 2
  confidence: { ks: 'high'|'medium'|'low', model: 'high'|'medium'|'low', headline: 'high'|'medium'|'low',
                stage: 'pass1'|'final',
                reasons: [ { rule:'KL3'|'KH2'|'KC1'|'KK2'|..., kind:'low'|'cap'|'unmet', text, ev:['R3'] } ],
                rates: null | { ks: {rate, lo, hi}, headline: {rate, lo, hi} },
                outsideCalibration: bool, calVersion: string|null, calibrated: bool, ev:['K1','K2'] },
  curves: { dt:[h], hom: { dp:[], deriv:[] }, chosen: { dp:[], deriv:[] } | null },   // display grid, 40 points; memory only
  fitC4:  object,                                   // PRiSM C4-shaped fit of the chosen model, for "Open in PRiSM"
  warnings: [Warning]
}
```

**`Reach`:** `t10_h` and `t5_h` are the last equivalent times at which the fitted homogeneous derivative is outside ±10 % and ±5 % of
its plateau (one pd′ evaluation on the grid at the fitted C_D·e^{2S}). `fair_h = 10^(0.5 + Lcyc)·t5_h` (3.98·t_5 % at L = 0.1) and
`good_h = 10^(1 + Lcyc)·t5_h` (12.6·t_5 %), in Δt_e. `fairShut_h`/`goodShut_h` convert to a shut-in length with the test's effective
producing time (Δt = Δt_e·tp/(tp − Δt_e)); `null` and `reachable:false` when Δt_e ≥ tp.

**`ModelFit`:**
`{key, base: registryKey, ok, converged, stopReason, iterations, slices, nEval, phys:{k, S, C, M?, F?, R_ft?, dF_ft?, re_ft?},
params:{dimensionless}, se:{k, S, C, ...}, ci95:{...}, corr:{CS, kS}, ssrLog, nDp, rmseDp (psi), bic, p,
eligible:bool, why:[string], fullySeen: FullySeen}`.

**`KHeld`:** `{k, delta, fit: ModelFit, refits:[{f, S, C}], S_k, S_kAnalytic, corrCS, rmsRatio, converged, ev:['M8']}`.

**`FullySeen`:** `{status:'full'|'partial'|'not'|'n/a', value:number|null, bound:'upper'|'lower'|null, text}`.

**`EvidenceVector`** (input to `confidence`; also stored in the result for calibration): `{grade, noiseWidened, span,
pointSkinSpread, agree, agreeMode, dkPct, dS, sErr, sErrMode, unitSlope, cheldRejectedBoth, rateSource, r3, r3Status, r4, r4Status,
dqKnown, fRate, equalRateAssumed, snrD, rDrift, rTide, tideRemoved, flags:[codes], distractorAtOrBeforeIarf, humpAfterIarf,
dtEnd_h, dteEnd_h, t10_h, t5_h, historySensitive, outsideEnvelope, kHeld, kHeldConverged, kHeldCorrCS, kHeldRmsRatio,
partialSuspect, windowLevelInconsistent, chosenKey, chosenFullySeen, triggers:[...], dBicChosen, dBicNext, boundaryDepends}`.
`run` fills the rate fields from `spec.rateQC` and the pass-2 fields (`kHeld*`, `partialSuspect`, `windowLevelInconsistent`,
`boundaryDepends`) before the final `confidence` call (§4.6 item 18).

**`DEFAULTS`** (frozen): `{Lcyc:0.1, binsPerCycle:20, fitBinsPerCycle:12,
iarf:{band:0.10, slope:0.03, bandCap:0.20, slopeCap:0.06, minCycles:0.5, goodCycles:1.0, goodSlope:0.01, goodSE:0.01,
valleyDepth:0.15, mergeLevel:0.05, mergeGap:0.2}, reach:{fairCycles:0.5, goodCycles:1.0},
trig:{late:0.15, lateCycles:0.2, level:[0.8,1.25]}, bic:{tau:10, perCycle:12, logFloor:0.005},
agree:{kPct:5, dS:0.5, biasKPct:3, biasDS:0.3}, cheld:{f:[0.8,1.25], ext:[0.64,0.5,1.56,2.0], reject:10},
sErr:{floor:0.2, winShift:0.25, winShiftFrac:0.2}, kHeld:{spanMax:0.6, corrMax:0.95, rmsK:3, sErrMax:1.0},
pwf:{trendMin_min:30, trendSamplesMin:10, trendDtFactor:10},
seen:{fault:1.8, faultCycles:0.15, compCycles:0.3, closed:0.5, closedSlope:-0.5, faultDepart:0.15},
history:{maxDerivPct:2, pStarFactors:[0.5,2,10]}, tide:{m2Min_h:24, k1Min_h:48, index:0.10},
budget:{unitMs:50, perDecade:10, maxIterTotal:40, evalsMax:24,
costMs:{homogeneous:{pos:4, neg:8}, closedCircle:{pos:1.5, neg:3}, composite2:{pos:3, neg:6}, linearBoundary:{pos:9, neg:18}}},
rivals:{composite:{freezeF:true, M:[0.05,20]}, closedStarts:[0.7,1.0,1.4]},
round:{dBic:0.1, span:0.01, slope:0.001, ratio:0.001}}`.
`costMs` is the measured desktop cost of one 60-point pd + pd′, keyed by the sign of S (`neg` for S < 0; WP1 measures and freezes the
values). Values marked "cal" in §4.10 are overridden by `PRiSM_autoInterpCal.thresholds` when that table is present and `calibrated:true`.

### 3.2 Changes to `PRiSM_fitPhysical` / `PRiSM_physicalModel` / `PRiSM_lm` (05, 33; WP1)

- `opts.entry`: a registry-like object `{pd(td, params), pdPrime(td, params), paramSpec, defaults, refLength, kind, evalCostMs}`
  used **instead of** `PRiSM_MODELS[modelKey]`, in `fitPhysical` and in the `_getPM` → `PRiSM_physicalModel` / `_localPhysicalModel`
  path (the `_getPM` call at 05:1636 builds a new options object today, so the two keys are added to it explicitly). `modelKey` is still
  used for labels and the returned `modelKey`.
- `opts.isolated: true`: never read `PRiSM_state` (`params` for categorical keys).
- `opts.evalBudget: n`: stop the LM after n residual evaluations (Jacobian columns and trial steps included) through a count-only
  `shouldStop`. No `deadline`, no `Date.now()`.
- `opts.lmState: {lambda, ssr, stagnant}`: resume a sliced fit. λ starts at `lambda`, the initial evaluation is skipped (`O.ssr0`) and
  the plateau counter continues (`O.stagnant0`), so the "plateau" stop (5 stagnant steps) can fire across slices.
- `opts.slice: true`: an intermediate slice. Skip `modelDpAll`, `derived()` and the final Jacobian and CIs; return
  `{ok, phys, lmState, nEval, converged, stopReason}`. The engine's last slice omits `slice`, so statistics are computed once.
- Results gain `lmState` and `nEval`; `PRiSM_lm` results gain `lambda`, `nEval` and `stagnantSteps`.
- All options are ignored when absent, so behaviour is otherwise unchanged.
- Already supported and relied on: `opts.dataset` (hash source), `singleStart`, `maxIter`, `start {phys}`, `freeze`, `params0`,
  `window`, `objective`. Never used by the engine: `timeBudgetMs`, `race`, `deadline` (wall clock).

### 3.3 `PRiSM_MODELS.closedCircle` (53, WP1)

```js
{ name: 'Closed circle', pd, pdPrime, kind: 'pressure', timeInput: 'td', category: 'boundary', refLength: 'rw',
  defaultFrozen: [], evalCostMs: 1.5,
  defaults: { Cd: 100, S: 0, reD: 5000 },
  paramSpec: [ { key:'Cd', label:'Wellbore storage Cd', unit:'-', min:0, max:1e10, default:100, scale:'log' },
               { key:'S', label:'Skin S', unit:'-', min:-7, max:50, default:0 },
               { key:'reD', label:'r_e / r_w', unit:'-', min:50, max:1e7, default:5000, scale:'log' } ],
  description: 'Well at the centre of a closed circular reservoir; pseudo-steady state at late time.',
  reference: 'van Everdingen & Hurst 1949, The application of the Laplace transformation to flow problems in reservoirs' }
```

`kind:'pressure'` is required by the smoke test's C3 metadata check (`registryMeta`, smoke-test.js l.395–399), and `name` is what
36-report's `_modelLabel` reads. `gridEntry` results use `kind:'pressure'` too. The engine converts `reD` to ft as `re_ft = reD·rw`.
`DISTANCE_KEYS` in 33 is not changed: the engine converts it itself, as it does for the composite's R.

### 3.4 `window.PRiSM_skinCheck` (54, WP7)

| Function | Input | Output |
|---|---|---|
| `perforationSkin(i)` | `{rw_ft, lp_in, rp_in, spf, phase_deg ∈ {0,45,60,90,120,180}, kvkh}` | `{ok, S_H, S_V, S_wb, S_perf, verified:bool, warnings}`. Returns `ok:false, code:'UNVERIFIED'` when the coefficient table is not marked verified (§11 Q7) |
| `mechanicalSkin(i)` | `{S_total, Serr, h, rw, completion:{hp_ft, htop_ft, theta_deg, kvkh:[lo,hi], perf\|null}, D\|null, q\|null}` | `{available, S_geo, S_geo_lo, S_geo_hi, parts:{pp, ppMethod, theta, perf\|null}, S_mech (pressure-drop basis), S_mech_err, S_d_local (= S_mech·hp/h), validity:[{code, text}], warnings}` |
| `rateSkin(rows, opts)` | `rows [{id, t_days, q, S, Serr}]`, `opts {qRatioMin:1.5, maxDays:60, joint:true, expected:{k, h, hp, rw, sg, mu_g}}` | `{resolved, S, D, seD, n, qRatio, joint:null\|{S0, r_per30d, D, seD}, expectedD, consistent:bool\|null, reason, ev:['T15']}` |
| `products(i)` | `{S, k, h, B, mu, q, Dq, rw, re_ft, reSource:'input'\|'rinv', pbar\|null, pwf}` | `{dpSkin_psi, m, X, reAssumed:bool, piRatio, piRatioLowerBound:bool, rateAtStakeUpperBound:bool, FE\|null, DR\|null, guard:bool}`, where `m = 162.6·Dq·B·μ/(k·h)` and guard means X + S < 1 |
| `run(opts)` | `{adata?, fit?, well?, completion?}`, defaults from PRiSM C1/C2/C4 (Skin check only) | `SkinCheck` (card model, §6.11) |
| `renderPanel(el)` | DOM element | — (`window.PRiSM_renderSkinCheckPanel = renderPanel` for the Tools drawer) |
| `reportSection(model)` | PRiSM report model | `{id:'skincheck', title:'Skin check', order:45, kv, table, notes}`, pushed onto `PRiSM_reportSections` |

### 3.5 `window.PRiSM_autoInterpCal` (55, generated)

```js
{ version: 'cal-1', calibrated: bool, generated: 'YYYY-MM-DD', app: 'v3.3', engine: '1.0',
  seeds: { single: [100000, 100639], sequences: [200000, 200119], master: 3300 }, nCases: 640, nBuildups: 1600,
  thresholds: { snrHigh, sErrHigh, fairSpanHigh, pointSkinSpread, tauBic, rateTolPct, sErrFloor, deltaForm: 'plain'|'basevar',
                sErrLow, snrLow, disagreeDS, disagreeKPct, reachFactor, distractorRule: bool, kHeldRmsK },
  ksTable:   [ { label:'high'|'medium'|'low', n, right, lo, hi, loCluster, hiCluster, medAbsDS, cover2 } ],   // K1 vs kRight ∧ sRight ∧ status
  table:     [ { label, n, fullyRight, lo, hi, loCluster, hiCluster, kRight, sRight, modelRight, medAbsDS, cover2 } ], // headline min(K1,K2)
  strict:    [ same shape as table, k ±5 % / S ±0.3 ],
  kHeldTable: [ same shape as ksTable ], gasTable: [ same shape as table ],
  brier, bss, reliability, resolution, uncertainty, falseRival, abstain: { n, rate, rateHom },
  distractorCaught: { n, rate }, rateAccuracy: { medAbsPct, p90AbsPct },
  envelope: { CD:[lo,hi], S:[lo,hi], tDCDend:[lo,hi], snrD:[lo,hi], k:[lo,hi], dtEnd_h:[lo,hi] },
  sequences: { falseAlarmDelta, falseAlarmAbs, delayMedian, delayMedianShort, onsetWithin1, senCover },
  inApp: [ { seed, stratum, expect: { status, ks, headline, fullyRight }, margin } ]   // 24 cases, margin ≥ 0.1 (§5.6)
}
```

`lo`/`hi` are Wilson 95 % bounds on single cases; `loCluster`/`hiCluster` are cluster-bootstrap bounds over wells for the pooled
table (§5.4). The placeholder written by WP4 has `calibrated:false` and the pre-calibration thresholds. The page then shows "labels not
yet calibrated" (KC2 caps every label at medium) and WP9's release checklist fails until WP8 regenerates the file.

### 3.6 `WTS_buildup.data` (49-calc-buildup-data.js, WP2)

| Function | Input | Output |
|---|---|---|
| `DEFAULTS` | | §4.10 detection, rate and zone keys |
| `resolveZone(z)` | `{mode:'device'\|'utc'\|'fixed'\|'iana', offset_h, tz}` | `{mode:'iana', tz:'Europe/London'}` (device → `Intl.DateTimeFormat().resolvedOptions().timeZone`), `{mode:'utc'}` or `{mode:'fixed', offset_h}`. Stored with the analysis; never `device` after the first analysis |
| `sniff(text)` | first 64 kB of the text | `{sep, headers:[], sample:[[string]] (≤ 20 rows), cols:{t, p, T, q} (indices or -1), timeFormat:'iso'\|'dmy'\|'mdy'\|'elapsed_h'\|'elapsed_min'\|'elapsed_s'\|'serial', pUnitGuess:'psia'\|'psig'\|'kPa'\|'bar'\|'MPa'\|null, hasRate:bool}` |
| `parseJob(text, opts)` | `opts {cols, timeFormat, t0_ms (elapsed only), zone (resolved), pUnit, patm=14.696, chunkLines=10000}` | `Job<{record: GaugeRecord, rateTable: [{t_ms, q}]\|null}>` |
| `parse(text, opts)` | same | the same result, synchronously (tests and tools) |
| `fromHistorian(o)` | `{tag, from_ms, to_ms, patm}` | `Promise<GaugeRecord>`; maps the historian unit text (psig/psia/kPa/bar) and flags `rollup` when 60 s means were returned |
| `fromPRiSM(o)` | `{t0_ms}` | `{record, rateTable\|null}` from `window.PRiSM_dataset` (read only) |
| `qc(record, opts)` | | `QC` |
| `detect(record, qc, opts)` | | `{events:[Event], missed: Missed}` (M§A2, M§A5) |
| `refineClosing(record, ev, qc)` | | the `Event` with `tc_ms`, `dtc_s`, `pwf0`, `pwf0SE`, `trend`, `ramp` filled in (M§A3) |
| `classify(events, record, days, opts)` | | events with `kind`, `status`, `fhat`, `fhatMethod`, `alloc` (M§A4, interventions) |
| `parseAllocation(text, opts)` | `opts {cols:{date, oil, gas, water, hours}, gUnit:'Mscf'\|'MMscf'\|'Sm3', dayFirst:bool}` | `{ok, rows:[AllocRow], errors:[{line, text}], gUnit, resolution:{oil, gas, water}}` (volume resolution: the rounding unit detected in each column) |
| `dayBounds(date, day)` | `day {zone (resolved), startHour}` | `{t0_ms, t1_ms, hours}` (23 or 25 on daylight-saving days of an IANA zone), offsets from `Intl` with `timeZone` |
| `rates(record, events, rows, opts)` | `opts {fluid, day, history:{mode, date, cum}, rsScfStb, wcLimit:0.05, gorFactor:1.2, closeDayMin_h:6}` | `RateHistory` (daily mode) |
| `rateTable(rows, opts)` | `[{t_ms, q}]` | `RateHistory` (table mode) |
| `historySteps(rh, origin_ms, upTo_ms)` | | `[{t (h, history clock), q}]`, ending with the q = 0 step at `upTo_ms` |
| `depthShift(depth)` | `{gaugeTVD, datumTVD, grad}` | psi added to gauge pressure to reach the datum |

**`GaugeRecord`:** `{ok:true, origin_ms, t:[ms], p:[psia at gauge], T:[°F]|null, n, source:'csv'|'paste'|'historian'|'prism'|'demo',
name, zone (resolved), pUnitIn, patm, elapsed:bool, rollup:bool, hash:'hex16', warnings}`. The arrays are `Float64Array` in memory.
They are never put in localStorage.

**`QC`:**

```js
{ ok, n, dtMed_s, dtP05_s, dtP95_s,
  sigma_psi, sigmaFlow_psi, sigmaShut_psi,
  segments: [ {t0_ms, t1_ms, kind:'flow'|'shut', sigma} ],
  resolution_psi: number|null, resolutionLimited: bool, rho1: number, noiseCorrelated: bool,
  gaps: [ {t0_ms, t1_ms, dur_h} ], gapCount, gapTotal_h, longestGap_h,
  spikes: { count, mode: 'off'|'flag'|'filter', idx: [int] /* ≤ 200 */ },
  depth: { applied: bool, shift_psi },
  temperature: { present: bool, fastChanges: [ {t_ms, dT_F} ] },
  plausibility: [Warning], ev: ['Q1','Q2','Q3','Q4','Q5','Q7','Q8'] }
```

σ_LF is per test and lives in `BuildupSpec.sigmaLF_psi` (computed by `run.specFor`, §4.2).

**`Event`:**

```js
{ id: 'E3', kind: 'shutin'|'falloff'|'partial'|'substep',
  status: 'analysable'|'too_short'|'gap_at_closing'|'partial'|'excluded'|'not_confirmed'|'intervention',
  tc_ms, dtc_s, j0, j1,                      // refined closing time, its uncertainty, last flowing / first shut-in sample
  pwf0, pwf0SE, trend: { a, b, ref_ms, n, sigmaRes },   // flowing trend p = a + b·(t − ref) in psia and psi/h
  rise_psi, riseScale_min, Ts_psi, tEnd_ms, dtEnd_h, endReason: 'reopen'|'gap'|'data_end',
  ramp: { present: bool, dur_s }, fhat: number|null, fhatMethod: 'derivRatio'|'dpDiff'|'allocation'|'proxy'|null,
  qBefore: number|null, qAfter: number|null,
  alloc: { date, ratio: number|null, pass: bool|null, ignoresShutin: bool, confirm: 'confirmed'|'not_confirmed'|'no_alloc'|'n/a' },
  manual: bool,                              // added by an engineer override
  ev: ['D1','D2','D3','D4','D5','D6'], warnings: [] }
```

**`Missed` (M§A5):** `{subThreshold:[{t_ms, dp_psi, dur_h}], allocOnly:[{date, ratio}], gaps:[{t0_ms, t1_ms}],
detectability:{ok:bool, pStarMinusPwf_psi:number|null, Ts_psi}, tooShort:[eventId], interventions:[eventId], ev:['D1']}`.

**`AllocRow`:** `{date:'YYYY-MM-DD', oil:STB|null, gas:Mscf|null, water:STB|null, hours:number|null}`. For water injectors,
`water` holds the injected volume.

**`RateHistory`:**

```js
{ mode: 'daily'|'table', unit: 'STB/d'|'Mscf/d'|'bbl/d', phase: 'oil'|'gas'|'gasEq'|'total_rb'|'water_inj',
  days: [ { date, t0_ms, t1_ms, hours, hOn, V, q, cls: 'clean'|'event'|'gap'|'flush'|'shut', events: [id],
            pwfMean_psia: number|null, pwfMeanDatum_psia: number|null,      // mean flowing pressure over the day's flowing hours
            R3: { ratio, tol, pass, status: 'pass'|'fail'|'unavailable'|'n/a' } | null,
            R4: { ratio, pass, status: 'pass'|'fail'|'unavailable'|'n/a' } | null, R6: { reported, detected, flag } | null,
            ignoresShutin: bool, equalRateAssumed: bool, shortDay: bool } ],
  steps: [ { t_ms, q } ],                    // full, uncompacted, from the start of history (prepend included) to the data end;
                                             // every detected q = 0 period stays in, whatever its event status
  start: { source: 'data'|'date'|'cum'|'default', prepend_h, q, flag: bool },
  offsetScan: { current_h, best_h, better: bool, improvement: number },
  phaseBasis: { used: 'oil'|'total'|'gas'|'gasEq', wcMax: number|null, gorRatioMax: number|null, twoPhaseCt: bool },
  ev: ['R1','R2','R3','R4','R5','R6','R7'], warnings: [] }
```

### 3.7 `WTS_buildup.run` (49-calc-buildup-run.js, WP2)

| Function | Input | Output |
|---|---|---|
| `analyse(input, opts)` | `AnalysisInput`; `opts {cache: Analysis\|null}` | `Analysis` (synchronous; used by tests and the validation tool) |
| `job(input, opts)` | same | `Job<Analysis>` |
| `analyseAsync(input, opts)` | `opts {cache, shouldCancel, onProgress}` | `Promise<Analysis>` via `PRiSM_autoInterp.drive` |
| `specFor(event, record, rh, input)` | | `BuildupSpec` (bins built with `PRiSM_autoInterp.bin`; `rateQC`, `sigmaLF_psi`, `pwf0SE` filled) |
| `inputHash(input)` | | hex16 over `canon(…, 'inputs')` of everything that changes numbers (§4.9), including the resolved zones |
| `window.WTS_buildup_compute(input)` | | `= analyse(input)` (registry contract, smoke check); `{ok:false, code:'NO_DATA'}` for `{}` |

**`AnalysisInput`:**

```js
{ record: GaugeRecord|null,          // null = reproduce from stored.tests[].spec (no detection re-run)
  stored: null | { events: [Event], rates: RateHistory, qc: QC, tests: [ {id, eventId, spec: BuildupSpec (stored form)} ] },
  allocation: null | { rows: [AllocRow], gUnit, resolution },
  rateTable: null | [ {t_ms, q} ],
  well: WellInput, completion: Completion|null, depth: Depth|null,
  history: { mode: 'unknown'|'date'|'cum', date: 'YYYY-MM-DD'|null, cum: number|null },
  zones: { gauge: Zone, day: { zone: Zone, startHour } },   // Zone resolved by data.resolveZone at the first analysis
  settings: Settings, overrides: [Override], workovers: ['YYYY-MM-DD'],
  meta: { wellName: string, engineer: string, appVersion: string } }

WellInput = { fluid: 'oil'|'gas'|'water_inj', h, phi, mu, B, ct, rw, re_ft: number|null, Pb: number|null, Rs: number|null,
              gas: null | { sg, T_F, co2, h2s, n2, pseudoTime: bool, pdew: number|null, apiCond: number|null, Mo: number|null },
              Bw, muw, allocAccPct: 5, driftPsiPerDay: 0.01, defaulted: [string],
              sens: { h:0.2, phi:0.1, ct:0.3, rw:0.05, B:0.05, mu:0.2, q:0.1 } }
Completion = { hp_ft, htop_ft, theta_deg, kvkh: [lo, hi], perf: null | { spf, lp_in, rp_in, phase_deg } }
Depth      = { gaugeTVD, datumTVD, grad, gradFlow: number|null }
Settings   = { detect: {winMin, riseMin, riseSig, persistMin, minDur_h, gapN, spike, partial},
               interp: {Lcyc, band, slope, minCycles, rivals, cheld, kHeld, tide},
               trend:  {baseN, delta, abs, basevar, confirm, price: number|null, enabled: 'auto'|'on'|'off'},
               report: {detail: 'selected'|'all'} }
Override   = { id: 'O7', kind: 'exclude'|'include'|'window'|'model'|'event_add'|'event_drop'|'tc',
               target: 'B3'|'E5', value: any, reason: string /* ≥ 5 chars */, who, at: ISO, appVersion }
```

Edited inputs are not dialog overrides: at the next Analyse after a sign-off (or any earlier run), `run` writes one audit entry
`kind:'input'` with the field diff against the previous run's inputs and an optional reason (§6.4).

**`Analysis`:**

```js
{ ok, version: '1.0', appVersion, runAt: ISO, inputHash, resultHash,
  meta, well, completion, depth, settings, zones,
  record: { name, source, n, origin_ms, end_ms, hash, reduced: false, rawStored: 'idb'|'memory'|'none' },
  qc: QC, events: [Event], missed: Missed, rates: RateHistory,
  baseline: { k, cvK, kh, tests: [id] } | null,              // stage 2
  tests: [ TestEntry ], trend: Trend, overrides: [Override],
  stats: { evals, fits, slices, ms: number|null }, warnings: [] }

TestEntry = { id: 'B1', eventId: 'E2', date: 'YYYY-MM-DD', tc_ms, dtEnd_h, Dq, qUnit,
              pwf0, pwf0Datum, pStarDatum: number|null, pExtDatum: number|null,
              status: 'interpreted'|'excluded'|'not_analysable'|'failed', statusReason: string|null,
              spec: BuildupSpec (stored form), result: BuildupResult|null,
              used: { baseline: bool, trend: bool, alert: bool },      // copied from trend.series[].used (owner: trend)
              partialSuspect: bool, overrides: ['O3'] }
```

When more than 60 tests are detected, the analysis keeps 60 by selection, not by age: the longest analysable shut-in per day, then per
week, newest weeks first, while always keeping the baseline tests of each segment; the others get `status:'excluded'`, `statusReason:
'test cap'`. Pipeline order, overrides and caching are in §4.6 item 18 and §4.8. An override re-runs only the tests whose `inputHash`
changed, then stages 2–5.

### 3.8 `WTS_buildup.trend` (49-calc-buildup-trend.js, WP3)

`compute(tests, ctx) → Trend`, where `tests = [TrendTest]` (built by run from `TestEntry`, so trend never reads raw data) and
`ctx = {well, completion, depth, settings, days: RateHistory.days, workovers, fluid, firstTest_ms, mode: RateHistory.mode,
phaseBasis: RateHistory.phaseBasis, start: RateHistory.start, historyEstimated: bool, baseline: Analysis.baseline}`.
Helpers are exposed for tests: `theilSen(t, y)`, `mannKendall(y)`, `hinge(t, y, w)`, `cusum(z, k, h)`, `baseline(series, n)`.
`baseline` is the single baseline implementation; `run` calls it in stage 2 and `compute` reuses its result.

```js
TrendTest = { id, t_ms, tDays, date, S, Serr, SerrExt, SerrMode, k, kh, C, m, mPrime,
              pStarDatum: number|null, pStarRangeDatum: null|{lo, hi}, pExtDatum: number|null, pExtKind, piModelDatum: number|null,
              pwf0Datum, Dq, qUnit, rinv_ft, dpSkin_psi, conf: {ks, model, headline}, chosen, fullySeen, kHeld: bool,
              excluded: bool, excludedReason: string|null, gasSprime: number|null, partialSuspect: bool,
              iarfDt0_h: number|null, dtEnd_h, dteEnd_h, reachFair_h, reachGood_h, reachFairShut_h, reachGoodShut_h,
              bins: { dte: [h], dp: [psi] } }        // display-grid bins, for the model-free ΔS (T11)

Trend = {
  ok, n, nUsed, enabled: bool, disabledReason: string|null,
  baseline: { S, sigma, tests: [id], unstable: bool, provisional: bool, segments: [ {from: date, S, tests:[id]} ], ev:['T1'] },
  series: [ { id, tDays, S, Serr, k, pExt, pwf0Datum, Smech, SmechErr, Sd, conf, used: {baseline, trend, alert} } ],
  excludedLow: { n, ids: [id], S: [lo, hi] | null, ev:['T16'] },
  alerts: {
    delta:    { threshold, form: 'plain'|'basevar', raisedAt: id|null, confirmedAt: id|null,
                status: 'none'|'possible'|'provisional'|'confirmed', kHeldOnly: bool, inputRobust: true, ev:['T2'] },
    absolute: { threshold, basis: 'mechanical'|'total', raisedAt, confirmedAt, status, kHeldOnly: bool,
                robustness: { lo: id|null, hi: id|null, unchanged: bool }, ev:['T3'] } },
  onset:    { tauDays: number|null, interval: [lo, hi]|null, date: string|null, model: 'hinge'|'constant'|'line',
              cusum: { alarmAt: id|null, onsetAt: id|null }, indicative: bool, ev:['T4'] },
  recent:   { slopePer30d, ci: [lo, hi], mkZ, mkP, n, indicative: bool, wlsSlopePer30d, disagree: bool, ev:['T5'] },
  forecast: { show: bool, date: string|null, earliest: string|null, latest: string|null, reason: string, ev:['T6'] },
  skinDp:   [ { id, dpSkin_psi } ],                                                   // T7
  pi:       { X, re_ft, reSource: 'input'|'rinv', ratioNow, ratioBase, ratioLowerBound: bool, rateAtStake, rateUnit,
              extraDrawdown_psi, cumAtStake, cumUnit, atStakeUpperBound: bool, value: number|null, guard: bool, ev:['T8'] },
  kStability: { cv, stable: bool, allocAccPct, reading: 'nearWell'|'mobility'|'none'|'allocation', ev:['T9'] },
  pTrend:   { quantity: 'pStar'|'pbar', assessable: bool, reason: string|null, slopePer30d, scatter, depletion: bool|null,
              label: string, ev:['T10'] },
  modelFree:[ { id, refId, dS, fittedDS, agrees: bool } ],                           // T11
  bubble:   { rows: [ { id, pwfSand_lo, pwfSand_hi, margin, level: 'ok'|'minor'|'major'|'critical' } ],
              spearman: number|null, ev:['T12'] },
  piCheck:  { available: bool, reason: string|null, rows: [ { from, to, RJ } ], consistent: bool|null, rho: number|null, ev:['T13'] },
  mech:     { available: bool, Sgeo, SgeoRange: [lo, hi], basis: 'pressureDrop', ev:['T14'] },
  rateSkin: { resolved: bool, S, D, seD, reason, dqEffect: number|null, ev:['T15'] },
  crossTest:{ windowLevelInconsistent: [id] /* from stage 3, reported */, closedWithoutDepletion: [id] },
  recommendations: [ { code, text, ev: [id] } ],
  limitations: [ { code, text } ] }
```

`trend.compute` owns `series[].used`; `run` copies it to `TestEntry.used`. `crossTest.closedWithoutDepletion` is a trend output
(stage 5 caps the model label from it); there is no such field on `TrendTest`.

### 3.9 `WTS_buildup.synth` (49-calc-buildup-synth.js, WP4)

| Function | Input | Output |
|---|---|---|
| `rng(seed)` | 32-bit integer | `{next() ∈ [0,1), normal(), int(a, b), pick(arr)}`. Integer state with `Math.imul` only, so the uniform stream is bit-identical on every engine |
| `pwd(model, params, tD[])` | the generator's **own** Laplace kernels, own scaled Bessel functions, own Stehfest N = 16, a 40-per-decade evaluation grid | pD array |
| `caseFromSeed(seed)` | | `CaseSpec` (seed → stratum and design row through the fixed table of §5.2) |
| `generate(caseSpec)` | | `SynthCase` |
| `generateJob(caseSpec)` | | `Job<SynthCase>` (for the in-app demo and validation card) |
| `demo(kind)` | `'oil'\|'gas'` | `{name, record, allocation, well, completion, settings, truth:{tests:[{tc_ms, k, S, dtEnd_h}]}}`; deterministic seeds 3301 / 3302 |
| `IN_APP` | | 24 `{seed, stratum}` |
| `score(test, truth, opts)` | `TestEntry`, case truth | `Score`. Reads only the engine's k̂, Ŝ, model, flags, status and label, **never its Δq** |

```js
CaseSpec = { seed, stratum: 'hom'|'fault'|'comp'|'closed'|'dualpor'|'channel'|'wbschange'|'partpen'|'frac'|'constp'|'interf'
                            |'baddata'|'gas'|'inj'|'partial', row,
  truth:   { model, k, S, C, h, phi, mu, B, ct, rw, q, D: number|null,
             extra: { dF_ft?, M?, F?, R_ft?, re_ft?, omega?, lambda?, width_ft?, hump_psi?, xf_ft?, b?, dpdt? } },
  given:   { h, phi, ct, rw, B, mu },          // the inputs the engine receives (primes, §5.3)
  history: { days, variationPct, earlierShutins, truncate: bool, intraDayChange: bool, flushPct, flushDecay_h },
  test:    { closeHour, dtEnd_h, dtSample_s, sigma, sigmaFlowFactor, ar1Rho: number|null, quant, spikes, drift_psi_d,
             tide: {M2, K1}, ramp_s, partialBefore: number|null },
  alloc:   { errPct, bias, ignoresShutin: bool, hoursConflict_h, resolution } }
SynthCase = { spec, record: GaugeRecord, allocation: { rows }, rateTable: null|[...], well: WellInput,
              truth: { tc_ms, k, S, model, f, qCorrect, kStar, SStar, plateaus: [ {dt0_h, dt1_h, kStar, SStar} ],
                       visible: { fault, comp, closed, distractor }, notAnalysable: bool, partial: bool } }
Score = { matched: bool, status, abstained: bool, fullyRight: bool, ksRight: bool, kRight, sRight, modelRight, strict: bool,
          falseSeen: bool, distractorCaught: bool|null, dkPct, dS, rateErrPct: number|null,
          label: { ks, model, headline } | null }
```

`rateErrPct` compares the engine's Δq with the generator's `qCorrect`; it feeds only the separate rate-accuracy table (§5.3).

### 3.10 `WTS_buildup.review` (49-calc-buildup-review.js, WP5)

| Function | Input | Output |
|---|---|---|
| `evidence(analysis)` | | `EvidenceIndex` |
| `run(analysis, idx)` | | `Review` |
| `check(obj, analysis, idx)` | a `Review`, `Answer` or `ReportModel` | `{ok, nChecked, nFailed, failures:[{ref, quoted, recomputed, tol}]}`; works on the canonical `{v, ref}` values, never on text |
| `ask(text, analysis, idx, fmt)` | question (plain text, ≤ 300 chars); `fmt(v, cat, dp)` formatter | `Answer` |
| `report(analysis, review, audit, signoff, fmt)` | `fmt(v, cat, dp)`: the page passes `_uFmt`; tests pass an imperial formatter | `ReportModel` |
| `sha256(str)` | UTF-8 string | 64-hex digest (built-in synchronous implementation; test vectors `''` and `'abc'`) |
| `signature(analysis, review, form)` | | `{hash, inputsHash, resultsHash, decisionsHash, appVersion, runAt}` |
| `status(analysis, review, signoff)` | | `'DRAFT'\|'SIGNED'\|'CHANGED'`: CHANGED when any of the three hashes differs from the signed ones |
| `canSign(review)` | | `{ok, open:[findingId]}`: every critical and major finding needs a decision, a rejection needs a note, and no V14 finding may exist |
| `signoff(form, analysis, review)` | `{name, role, statement:true}` | `Signoff` or failure (`OPEN_FINDINGS`, `EVIDENCE_CHECK_FAILED`, `NO_NAME`, `NO_STATEMENT`) |
| `aiExport(analysis, review, opts)` | `{deidentify:true, includeDates:false, includeFreeText:false}` | `{text, filename:'buildup-review-<hash8>.txt'}` |
| `RULES`, `INTENTS`, `FORMULAS` | | rule table (§7.2), intent table (§7.4) and the review's own formula registry (§7.3) |

`canon` and `hash16` come from `PRiSM_autoInterp` (§3.1); the review only adds SHA-256.

```js
Value = { v: number|string|null, cat: unitCategory|null, dp: number, ref: 'B3·I1:cycles' }   // structured numeric cell
EvidenceItem = { id: 'B3·I1', group: 'I', test: 'B3'|null, title: 'IARF window',
                 values: { cycles: { v: 0.58, cat: null, dp: 2, path: 'tests[2].result.iarf.cycles' }, ... },
                 template: 'Fair IARF window {dt0}–{dt1} ({cycles} cycle).' }
EvidenceIndex = { items: { [id]: EvidenceItem }, order: [id] }
Finding = { id: 'F1', rule: 'V7', severity: 'critical'|'major'|'minor'|'suggestion', acceptable: bool, where: 'S5',
            template: 'B5 is used for the delta alert but its allocation check failed (r = {r} on {date}).',
            values: { r: Value, date: Value }, ev: ['T2','B5·R3'],
            check: { ok: bool, failures: [] }, decision: null | { d: 'accept'|'reject'|'note', note, who, at } }
Review = { version: 'r1', at: ISO, findings: [Finding], counts: { critical, major, minor, suggestion },
           evidenceCheck: { ok, nChecked, nFailed }, inputHash, resultHash }
Answer = { q, intent, template, values: { [name]: Value }, ev: [id], grounded: 'full'|'partial'|'none',
           check: { ok, failures: [] }, followUps: [string] }
ReportModel = { title, subtitle, status: 'DRAFT'|'SIGNED'|'CHANGED', sections: [ Section ], signature, reproducibility: Block }
Section = { id: 'S1'..'S12', title, blocks: [
            { kind: 'verdict', level: 'ok'|'warn'|'bad', template, values, ev: [] },              // rendered text < 300 chars
            { kind: 'kv', rows: [ { label, value: Value | { template, values }, ev: [] } ] },
            { kind: 'kpi', items: [ { label, value: Value, ev } ] },
            { kind: 'table', id, head: [ { text, cat: unitCategory|null } ], rows: [ [ Value | string ] ], ev: [] },
            { kind: 'notes', head: 'Notes'|'Recommendations'|'Assessment'|'Conclusions'|'Interpretation', template, values,
              ev: [] },                                                                            // rendered ≤ 600 chars
            { kind: 'chart', id: 'bu_ch_skin', series: [ { name, cat, x: [days], y: [number] } ] } ] }
Signoff = { name, role, statement: true, at: ISO, hash, inputsHash, resultsHash, decisionsHash, appVersion, runAt, decisions: n, open: 0 }
```

Templates are fixed strings with `{name}` placeholders. Numbers are bound only through `values` and formatted by `fmt` at render time
(`fmt(v, cat, dp)` converts with the units layer, so Metric mode shows converted values and units). Table head cells with a category get
their unit label from the same formatter. Free text (file and tag names, reasons, names, questions) is escaped and never contains
numbers that are checked.

### 3.11 `WTS_buildup.store` and `WTS_buildup.plot` (WP6)

- `store.init() → Promise<{engine:'idb'|'memory'}>`.
- `store.putRaw(wellId, record) → Promise`, `store.getRaw(wellId) → Promise<GaugeRecord|null>`. A raw record is used only when its
  `hash` equals `analysis.record.hash`; otherwise it is treated as absent and the page shows the "not embedded" note.
- `store.putTests(wellId, {[testId]: {spec, result}})`, `store.getTests(wellId) → Promise<object|null>` (overflow store, D18).
- `store.encode(record) → {origin_ms, tScale_ms, pScale, n, tB64, pB64, TB64|null}` (delta-encoded int32), run in 50k-sample units
  through `drive` (`store.encodeJob(record)`); `store.decode(obj) → GaugeRecord`.
- `store.loadState() → object|null`; `store.saveState(state) → {ok, bytes, overflow:bool}`: writes `wts_buildup_state` through
  `WTS_lsSet`, at most 300 kB. Over that, per-test `spec.dt/p/n` and `result` move to the IndexedDB `tests` store and the state keeps
  per-test summaries (final values, S_err, labels, evidence vector); recomputable arrays (`curves`, `bins.X`, `bins.dte`) are never
  stored.
- `store.audit.list() → [AuditEntry]`, `store.audit.append(entry)`. Raw and test keys use `WTS_wells.active() || 'default'`, or the
  well id captured at Analyse (§6.5).

`plot.loglog(canvas, {series:[{dt, y, kind:'dp'|'deriv'|'model', color, dash, mask}], band:{dt0, dt1}|null, markersNeg:[{dt, y}], xLabel,
yLabel})`, `plot.overlay(canvas, tests)` (Δp/q and Δp′/q for every test), and `plot.trend(canvas, spec)` (through `drawLineChart`, with x
in days and threshold lines as 2-point datasets). Series arrive already converted to display units (the page uses
`WTS_units.convertCategory`). Canvas size is chosen by the page from the `#bu_root` width (720×300; 600×400 below 600 px). The
renderers honour the host chart colours and set `role="img"` and an `aria-label` summary.

### 3.12 Page entry, published state, events, storage keys, project modules (WP6)

```js
G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.buildup = {
  key: 'buildup', title: 'Build-up Surveillance',
  sub: 'Automatic interpretation of every shut-in, skin trend and alerts, with review and sign-off',
  group: 'Production & Reservoir', icon: '&#128200;',
  desc: 'Find every shut-in in gauge data, interpret each build-up, track skin over time and get a reviewed, signed report.',
  hooks: { silent: true, after: function (body) { _syncUi(body); window.calcBuildup(); } },
  render: renderBuildup };                     // window.renderBuildup also exported
```

- `window.calcBuildup()` is cheap. It re-renders results from the stored analysis, applies display-only settings, publishes
  `WTS_state.buildup` and marks the results stale when analysis inputs differ from the stored `inputHash`. It **never** runs the
  analysis. The analysis runs only from `#bu_run` (or the demo / validation buttons). Counter: `WTS_buildup.page.calcs()`.
- `WTS_state.buildup = {ok, ts, wellId, nTests, latest:{id, date, S, Serr, k, conf}, baseline:{S}, dS, delta:{status, at},
  absolute:{status, at, basis}, alertCode: 'none'|'possible'|'provisional'|'confirmed', onsetDate, recentPer30d, signed:bool, hash8}`.
  It is published in `calcBuildup` and after every run, override, sign-off and withdrawal, followed by `WTS_pageAutosave.flush()` (which
  fires `wts:autosaved`, so the comparison cache in 29-multiwell refreshes).
- Event fired: `document` `wts:buildup-updated` `{detail:{wellId, ok, nTests, delta, absolute, signed}}` after an analysis or a sign-off.
- Events listened to (attached once at module load, guarded, each checking `#bu_root` first):
  - `wts:unit-system-changed`: re-render (no stale marking, §6.5);
  - `wts:well-changed`, `wts:project-loaded`, `wts:project-new`: cancel a running analysis, reload state and raw;
  - `wts:historian-updated`: "new data" badge only, no re-run.
- Storage keys (all well-scoped automatically, and carried in project files by the `storage` module):

  | Key | Contents | Cap |
  |---|---|---|
  | `wts_page_buildup` | host autosave of id'd controls | host |
  | `wts_buildup_state` | `{v:1, appVersion, savedAt, input (no record), analysis (Analysis without raw; rates.steps once; specs by stepRef; no recomputable arrays), review, qa:[last 20 Answers], uiSel, signoff}` | 300 kB (typical 10 tests ≤ 150 kB); overflow to IndexedDB `tests` |
  | `wts_buildup_audit` | `{v:1, entries:[AuditEntry], summary: null \| {from, to, n, counts, chainHash}}` | 200 kB, 500 entries |

  `AuditEntry = {seq, at, who, kind:'run'|'override'|'override_removed'|'input'|'decision'|'signoff'|'unsign'|'import'|
  'changed_after_signoff', target, value, reason, appVersion, inputsHash, resultsHash, prevHash, hash}`. Entries are never edited. Each
  carries `hash = hash16(prevHash + canon(entry))`. Beyond 500 entries the oldest are folded into one `summary` record that keeps the
  chain hash of the folded entries, so the chain still verifies.
- IndexedDB: database `wts_buildup`, stores `raw` (key well id, value `store.encode(record)`) and `tests` (key `wellId`, value
  `{[testId]: {spec, result}}`).
- Project modules (`WTS_project.registerModule`), not in `WELL_MODULES` (records are keyed by well id):
  - `buildup_raw`: `read()` returns `{wells:{[id]: encoded}, omitted:[id]}` from the memory mirror (encoded strings are kept in the
    mirror, so `read()` does no encoding), up to 16 MB in total; when the mirror is cold for a well that has an analysis, that well is
    listed in `omitted` and S10 says "not embedded". `write(state)` fills the memory mirror **synchronously** first, then writes
    IndexedDB. `write(null)` (New) clears.
  - `buildup_analysis`: the same pattern for the overflow `tests` store.
  - On `wts:project-loaded`, mirror and IndexedDB entries whose well ids are not in the payload are dropped (29-project-save applies
    only the modules present in a file, l.778, so an old project without the module must not inherit the previous project's data).

### 3.13 Contract fixtures (`tests/_buildup-shapes.js`, WP0, frozen)

It exports:
- `checkShape(name, obj) → {ok, errors:[path]}`, with names `BuildupSpec`, `BuildupResult`, `ModelFit`, `KHeld`, `Reach`, `GaugeRecord`,
  `QC`, `Event`, `RateHistory`, `AnalysisInput`, `Analysis`, `TestEntry`, `TrendTest`, `Trend`, `Review`, `Finding`, `Answer`,
  `ReportModel`, `CaseSpec`, `SynthCase`, `Score` and `Cal`;
- fixture objects **generated from closed-form values** (homogeneous IARF formulas, Appendix A): `FIX.analysis` (a 6-test oil analysis
  with a confirmed delta alert, one excluded test and one k-held test) and `FIX.result`, a reference-case `BuildupResult`;
- `FORMULAS`, a test-only table of the derived quantities (Δp_skin, m, PI ratio, rate at stake, dkPct, r_inv), used by the fixture
  self-consistency test (SH2). WP5 writes its own runtime registry; RV12 asserts that both agree on `FIX.analysis`.

Every WP's tests assert `checkShape` on their outputs. WP5 and WP6 build against `FIX.analysis` until the real engines land. After WP2 and
WP3 merge, the lead refreshes `FIX` from real engine output (same shapes) and re-runs SH2. The helper changes only through the lead,
together with an update of this section.

---

## 4. Algorithms

This section fixes what is built. Formulas and reference tables that several sections use are collected in Appendix A.

### 4.1 Import and parsing (WP2)

- **Chunked parser** (`parseJob`): `chunkLines` lines per `step()` (default 10,000), numeric parse in place into growing `Float64Array`s.
  WP2 measures the cost per row on the reference machine and freezes `chunkLines` as a constant so that one chunk costs ≤ 50 ms desktop
  (never measured at run time).
  - Separators: comma, semicolon, tab, space.
  - Decimal comma accepted when the separator is not a comma.
  - Times: ISO / `YYYY-MM-DD hh:mm[:ss]`, D/M/Y or M/D/Y (`dayFirst` from sniffing, user-settable), elapsed h/min/s with `t0_ms`
    (default `2026-01-01T00:00Z` in UTC mode, editable), spreadsheet serial days.
  - Naive times are read in the **resolved gauge zone** (§4.4). We never rely on another module's parser default (one existing module
    reads naive time as local, another as UTC).
- **Measured basis.** The existing one-shot parsers take 285 / 1,129 / 3,445 ms for 50k / 200k / 500k rows (about 6.9 µs per row). The
  target is ≤ 3 µs per row (≤ 1.5 s for 500k rows) and ≤ 50 ms per chunk on desktop (≤ 150 ms on a phone).
- Pressure units psia / psig (+ `patm`) / kPa / bar / MPa, with an optional temperature column. Rows that are not monotonic are sorted
  once; duplicate timestamps keep the median.
- Spreadsheets: through the lazily loaded spreadsheet library only when online; the status line says "CSV works offline".
- **The GUI-sweep sample** (`time_hr, pressure_psi, rate_stbd`) is recognised as elapsed hours plus a rate column. When no allocation
  is loaded, the page proposes rate-table mode.

### 4.2 Data quality (WP2) — M§A1

- **σ (M§A1).** σ2 = 1.4826·MAD(second differences)/√6 on quiet segments: late build-up (Δt ≥ max(2 h, Δt_end/4)) and flowing segments
  more than 1 h after any event, excluding ±3 samples around events. σ = the median of the segment values. σ_flow (flowing segments,
  which carry slugging and are often much larger) and σ_shut are reported separately and used separately: σ_shut for the build-up
  derivative, σ_flow for the flowing trend and the first-shut-in-sample rule (§4.3).
  - Quantisation: if more than 50 % of the first differences are zero, σ = max(σ2, Δ_q/√12) and the record is flagged
    "resolution-limited".
  - Lag-1 autocorrelation of the first differences: above −0.2 means "noise correlated; σ is a lower bound".
  - **σ_LF**, the low-frequency noise at the derivative scale, per test, computed by `run.specFor`: the robust scatter
    (1.4826·MAD) of the late-build-up bin medians about a local quadratic in ln Δt.
- **Sampling and gaps.** Report Δt_med and its 5 % and 95 % quantiles. A gap is longer than max(N·Δt_med, Δt_med + 60 s), with N = 5.
- **Spikes.** Hampel filter: k = 5, 6 robust σ, runs ≤ 2, never within ±3 samples of an event. Off by default; options flag / filter.
- **Drift index (Q5).** r_drift = (d/24)·Δt_end/m′, with d the drift input in psi/day (default 0.01), Δt_end in hours and m′ in psi;
  flag above 0.05. The reference case gives 0.001 at 72 h.
- **Tide index (Q6).** Least-squares fit on the late-build-up residual: M2 (12.4206 h) alone when 24 h ≤ Δt_end < 48 h, M2 + K1
  (23.9345 h) when Δt_end ≥ 48 h (K1 needs two periods; over one period it aliases with boundary curvature). r_tide = ΣA·ω·Δt_end/m′.
  Above 0.10, the fitted harmonics are removed before the derivative (`tideRemoved:true`, `tideFit:'M2'|'M2K1'`).
- **Depth (Q8).** p_datum = p_gauge + G·(D_datum − D_gauge). It applies to pwf0, p*, p_ext and pi for the datum values only, because
  Δp, k, S and C are unchanged by a constant shift (this is stated in the report).
- **Temperature (Q7).** More than 1 °F change in the first hour of a build-up → "start the fit after the temperature settles"
  (fit window starts at the settle time).

### 4.3 Detection, closing time, partial cuts, interventions, missed events (WP2) — M§A2–M§A5

- **M§A2 shut-ins.**
  - Window medians M_k over w = max(5 min, 3·Δt_med).
  - **Multi-scale rise.** A candidate starts at window k when M_{k+j} − M_k > T_s = max(5 psi, 10σ) for some j = 1…J, with
    J = ceil(30 min / w); the smallest such j is kept (`riseScale_min`). A slow early rise therefore triggers: at qB/(24C) psi/h,
    q = 100 STB/d and C = 0.2 bbl/psi give 2.1 psi per 5 min, which passes at j = 3.
  - Persistence: M_{k+j+i} − M_k > T_s for every window up to +30 min after k + j (and for at least 2 windows).
  - The flowing trend is a Theil–Sen line (≤ 200 samples) on a window of max(30 min, 10·Δt_med, at least 10 samples) ending at the
    first candidate window, never crossing the previous event. pwf0SE = σ_res·√(1/n + (t_c − t̄)²/Σ(t_i − t̄)²), with
    σ_res = max(σ_flow, 1.4826·MAD of the trend residuals). With fewer than 10 samples available the trend uses what exists and D3 is
    flagged.
  - The first shut-in sample is the first residual above max(4·σ_flow, 0.5 psi) that stays above for 3 samples.
  - Gap at closing: t_j1 − t_j0 > max(5·Δt_med, 10 min) → `gap_at_closing`, not analysed.
  - **End of the build-up.** A reopen needs a persistent fall: M_{m+i} − M_m < −T_s for every window up to +30 min, **and** a level
    below the one the build-up had reached 30 min before m. When the allocation shows the well shut for the whole day, a fall must also
    persist for 2 h. A phase-redistribution hump or a burst of noise therefore does not end the test. Otherwise the build-up ends at a
    gap or at the data end.
  - Analysable when Δt_end ≥ 2 h and there is no gap at the closing.
- **Injectors (D15).** For fluid `water_inj` the detector looks for **falls**: the same rules on −p, `kind:'falloff'`, sign −1.
  The event type comes from the fluid and the rate sign, never from the pressure sign alone.
- **M§A3 closing time.** For t_c on a 50-point grid in [t_j0, t_j1), regress ln r_j on ln(t_j − t_c) over the first K = 3–5 shut-in
  samples. Choose the SSR minimum subject to 0.5 ≤ n ≤ 1.05.
  - δt_c is the half-width where SSR ≤ SSR_min·(1 + 1/K); when t_c is clamped, δt_c = (t_j1 − t_j0)/√12.
  - **pwf0 = trend(t_c)**, never a sample; pwf0SE as above.
  - n > 1.05 over more than 2·Δt_med → "closing ramp": t_c is placed at the ramp midpoint and the ramp is modelled as two half-rate steps.
- **M§A4 partial cut vs shut-in (classification gate).** The rate fraction removed, f̂, must not follow skin. It is computed by the
  first method that applies:
  1. `dpDiff`: f̂ = [Δp_ev(t2) − Δp_ev(t1)] / [Δp_ref(t2) − Δp_ref(t1)] · (q_ref/q_before), with t2 = min(Δt_end,ev, Δt_end,ref)/1.26
     and t1 = t2/3.16, valid when t1 ≥ 3× the later of the two derivative-maximum times. In that range both tests are past storage, so
     skin cancels in the differences. The reference is the nearest full build-up **in the same workover segment** (the reference resets
     after an entered workover date).
  2. `allocation`: the day's volume agrees with full-shut-in hours (R3 pass with the detected hours treated as fully shut).
  3. `proxy` (no reference yet): f̂ ≈ (Δp(4 h) − Δp(1 h))/(m′_flow·ln 4), with m′_flow from the previous flowing decline when it exists;
     used only as a flag.

  Decision:
  - When the allocation confirms full-shut-in hours (method 2 passes), the event is a shut-in; f̂ from method 1 is only a flag (a value
    below 0.9 raises warning D6 "allocation says shut-in, pressure says partial").
  - Otherwise f̂ ≥ 0.95 → shut-in; 0.9 ≤ f̂ < 0.95 → shut-in interpreted with Δq·f̂ (`spec.fRate`, label cap KC6); 0.1 ≤ f̂ < 0.9 →
    `partial` with q_after = (1 − f̂)·q_before and the day split preserving volume (q1 = 24·V/(h1 + (1 − f̂)·h2)). Partial cuts enter
    the rate history and are **never interpreted** in v3.3.
  - Neither method available, or the allocation contradicts → `not_confirmed` (listed; the engineer can include it with an `include`
    override and a reason).
  - Sub-threshold steps T_p = max(2 psi, 6σ) ≤ Δ < T_s sustained for ≥ 2 h → `substep` ("possible partial cut / choke change").
- **Interventions.** An event is flagged `status:'intervention'` and not interpreted when the pressure exceeds the previous p_ext (or the
  previous build-up's last pressure) by more than 2·T_s, or when it rises and then falls by more than T_s inside the event while the
  allocation shows no reopening (bullheading, a squeeze or a kill). The page suggests entering a workover date.
- **Pass-2 partial-cut suspicion** (run, stage 3). For an interpreted test, m′_obs/m′_expected, with m′_expected from the baseline kh at
  the test's Δq. A ratio below 0.7 while k elsewhere is stable → `partialSuspect` (KL8, review V17).
- **M§A5 missed.** Sub-threshold steps; allocation days with V < 0.85·V_ref and no pressure event; gaps over 2 h; detectability
  (p* − pwf < 2·T_s → "full shut-ins may be missed"); shut-ins shorter than 2 h; suspected interventions. An engineer can promote any of
  these to an event (override `event_add`, with a reason).

### 4.4 Time zones and production days (WP2)

- All stored times are epoch ms UTC. Two settings, each stored with the analysis:
  - the **gauge zone** (how naive gauge timestamps are read);
  - the **production-day definition**: start hour 0–23, default 0, and its zone.
- Each zone is `device`, `utc` or a fixed offset in the settings. At the first analysis, `device` is **resolved** to the IANA name of
  the device (`Intl.DateTimeFormat().resolvedOptions().timeZone`, built into the JS engines on web and iOS; offline). The name is
  shown next to the select (`bu_g_tzname`, `bu_pd_tzname`), stored with the analysis, included in `inputHash`, and used on every later
  analysis and on every other device until the engineer presses "Use this device's zone" (`bu_tz_reset`). A project opened in another
  time zone therefore gives the same days, rates, k, S and hashes.
- Offsets come from `Intl.DateTimeFormat(…, {timeZone, …}).formatToParts`, so daylight-saving days last 23 or 25 h. A day lasts from its
  start boundary to the next one.
- Tests and synthetic cases always use explicit zones (`'UTC'`, `'Europe/London'`, fixed offsets) and never depend on the process
  time zone.
- **Offset scan.** For offsets −12…+12 h in 1-hour steps, recompute R3 on the closing and reopening days. Warn (R3, review V16) when
  the best offset reduces the summed |r − 1| by more than 50 % and passes on at least 2 more days than the current one.
  The engine never changes the offset on its own.

### 4.5 Rates (WP2) — M§A6, M§A7

- **M§A6 spreading.** h_on,d = day hours − Σ|shut-in ∩ day| (with partial cuts split per M§A4); q_d = 24·V_d/h_on,d when h_on ≥ 0.5 h.
  - V > 0 with h_on < 0.5 h → R2 flag "volume on a shut-in day", and q = 0 for the shut-in.
  - Reported hours that differ from the detected hours by more than 1 h → R6 flag; the detected hours are used.
  - **Short closing day.** When the closing day has h_on < 6 h (`closeDayMin_h`, settable), Δq is taken from the previous full day,
    else from q_ref, with an R1 flag (`dqSource:'previousDay'|'qref'`). A closing at 00:30 therefore does not base Δq on 0.5 h of
    allocated volume. The same rule applies to the reopening day's step rate (q_ref, flagged; the volume difference is reported in R2).
- **M§A7 consistency.**
  - A **clean day** has no event, no gap, h_on ≥ day hours − 0.5 (so a 23-h daylight-saving day can be clean), and no reopening within
    the previous 12 h (flush-production exclusion).
  - q_ref,d = the median of the 3 nearest clean days on each side within ±10 days; at least 2 clean days within ±10 days are needed.
  - r_d = V_d/(q_ref·h_on/24); pass if |r − 1| ≤ 0.15 + ΔV_res/V_exp, where V_exp = q_ref·h_on/24 and ΔV_res is the volume resolution
    of the allocation column (detected by `parseAllocation`; default 1 STB or 1 Mscf).
  - **Fewer than 2 clean days within ±10 days, or h_on < 6 h on the day → `R3.status:'unavailable'`**, which is not a pass (KH5 fails,
    and KC4 caps the label at medium).
  - **Measured or tabled rates** (rate-table mode, D15) → `R3.status:'n/a'`: treated as a pass by KH5 and never capped by KC4. The rate
    source is part of the evidence vector and calibrated as its own sub-stratum.
  - "Allocation ignores the shut-in": |V/(q_ref·day hours/24) − 1| ≤ 0.15 with h_on ≤ day hours − 3 → q_ref is used for Δq, and the flag
    is raised.
  - **R4 constant-PI check** (evaluated by `run` in stage 3, because it needs p_ext from pass 1): q_pred = q_ref·(p_ref − pwf_d)/(p_ref −
    pwf_ref), with pwf_d = `days[].pwfMean_psia` and p_ref interpolated between the tests' p_ext; flag if |q_spread/q_pred − 1| > 0.15.
    `unavailable` when the history is estimated (D13) or fewer than 2 p_ext values exist; `n/a` for tabled rates.
  - Two or more events in one day → `equalRateAssumed:true`, flagged per test.
- **Δq (R1).** The rate of the flowing sub-interval just before t_c, after any partial cut (or the short-closing-day substitute above);
  flagged if it differs from q_ref by more than 15 %.
- **Phase basis (R7), chosen once per analysis.** From the maximum water cut and GOR over the whole analysis: oil basis when
  wc_max ≤ 5 % and GOR_max ≤ 1.2·R_s; otherwise the total reservoir rate q_t = q_o·B_o + q_w·B_w + (q_g − q_o·R_s)·B_g (RB/d) for
  **every** test, with B = 1 and μ → the total-mobility basis. A per-test switch would put steps of about −0.1 to −0.3 into the S series.
  When free gas is likely (pwf < Pb or GOR > 1.2·R_s), `twoPhaseCt:true`: ct is flagged as two-phase in the limitations and in V4.
- **Gas producers with liquids.** When the condensate gas equivalent exceeds 5 % of q_g, the wet-gas equivalent rate is used
  (phase `gasEq`): q_eq = q_g + 133.3·γ_o·q_o/M_o (+ about 7.4 Mscf per STB of condensed water, when the engineer marks the water
  column as condensed), in Mscf/d with q_o and q_w in STB/d; M_o from the input, else 6,084/(API − 5.9).
- **History start (D13).**
  - `date` known → prepend a constant first-allocated rate from that date.
  - `cum` known → prepend t_eq = Np/q_first.
  - Unknown → prepend max(30 d, 10 × the longest Δt_end), with `start.flag:true`.
- **Zero-rate periods.** Every detected q = 0 period stays in `RateHistory.steps`, whatever the event's status: `too_short`,
  `gap_at_closing`, `not_confirmed`, `excluded`, `intervention`, and the split of a partial cut. Leaving one out would make the late
  derivative fall and look like T-down or a closed boundary.
- **Rate-table mode (D15).** Steps come straight from the time-stamped table. Shut-ins are the q = 0 periods. The rise detector only
  refines t_c within ±max(10 min, 5·Δt_med) of each tabled closing. No daily spreading or allocation rules apply (`R3`/`R4` `n/a`), and
  the history is "complete" (p* meaningful). With short producing times Δt_e compresses, so spans, slopes and reach are always measured
  in X = log10 Δt_e (§4.6). The trend and alerts are off by default (`settings.trend.enabled:'auto'`) in table mode or when the median
  spacing of the tests is under 1 day; the engineer can switch them on.

### 4.6 Per build-up interpretation (WP1) — M§A8–M§A17

Spans, slopes, cycles and windows are measured in X = log10 Δt_e throughout. Work units in this order; each bullet is at most one
`step()`:

1. **Prep.**
   - Bins: 20 per cycle with medians, σ_b = 1.2533·σ_shut/√n.
   - Time functions: ln Δt_e from the **full** history (an exact Σ over all steps: cheap), and the compacted history for the model.
   - Bourdet derivative dΔp/d ln Δt_e with L = 0.2303·(Lcyc/0.1) ln.
   - **Full-window mask** (both neighbours at ≥ L). Negative values are kept as `neg` markers and never logged.
   - σ_d,i ≈ √(σ_b,i² + σ_LF²)/(√2·L) per bin, SNR_d = m′/median σ_d over the window, plus the drift and tide indices and tide removal.
   - Fit set: 12 bins per cycle; `adata.deriv` = `PRiSM_compute_bourdet` on those bins (the operator `fitPhysical` uses for the model
     derivative in its `consistent` mode). `fitPhysical` drops non-positive data derivatives, so the derivative block uses the positive
     points only; the set is identical for every candidate and refit of the test.
   - Gas: normalised pseudo-pressure via `gasTable`; with `pseudoTime`, Δt → t_a for the build-up period only.
   - Fall-off: sign −1 throughout (`adata.sign = -1`, `testType:'falloff'`).
2. **Storage (W1–W3).**
   - Unit slope sampled: at least 3 bins before the hump with slope in [0.85, 1.10] and Δp′/Δp ≥ 0.85.
   - C_us = q·B·Δt/(24·Δp) (median).
   - t_hump = the masked derivative maximum, with the hump present when max/m′ ≥ 1.2.
   - Seed only: when the unit slope is missing, C is seeded by inverting the hump correlation of Appendix A.1 (valid for 0 ≤ S ≤ 8 and
     220 ≤ C_D ≤ 22,060). The IARF reach (W4) is **not** taken from the correlation; it is computed numerically in item 5b.
   - Hump consistency: observed vs the hump time of the fitted model within ×1.5 (after item 5).
3. **IARF (M§A8, D7).**
   - Gate a0: after the derivative maximum, or after the local slope falls below 0.25 when there is no hump.
   - Candidates: every pair [a, b] of full-window bins with span ≥ 0.5 cycle.
   - Band: max|Δp′/ℓ − 1| ≤ min(0.20, max(0.10, 3·σ_d/ℓ)).
   - Slope: OLS |s| ≤ min(0.06, max(0.03, 2·se_s)), where se_s comes from the **noise model**, not the residuals:
     se_s = √(aᵀ Σ a)/ℓ with the OLS weights a and Σ_ij = σ_d,i·σ_d,j·max(0, 1 − |X_i − X_j|/(2·Lcyc)) (overlapping Bourdet windows are
     correlated). Computed in O(1) per pair with prefix sums and sparse min/max.
   - **Plateau runs.** Group the qualifying windows into runs of overlapping windows. Runs whose levels agree within 5 % and that are
     less than 0.2 cycle apart are merged. **Take the earliest run**, then the longest window inside it (ties go to the lower RMS). The
     longest qualifying window of all runs is reported as `iarf.longest` (evidence I1). This deliberately deviates from the requirement's
     "longest window" (a later run is often a boundary, a second zone or a hump tail); the I1 text and the limitations say so.
   - **Valley guard.** Reject a window whose centre bin is a local minimum that is at least 15 % below the derivative on both sides
     within 0.5 cycle.
   - **Grade** (always against the requirement's fixed tolerances): "good" = the window passes ±10 % / ±0.03, span ≥ 1 cycle, last 0.5
     cycle |s_last| ≤ 0.01 **and** se_last ≤ 0.01; "fair" = passes ±10 % / ±0.03 with span ≥ 0.5; "fair (noise-widened)"
     (`noiseWidened:true`) = passes only with the widened tolerances (fails KH1). If noise was the only reason for missing "good",
     `noiseLimited:true`. A window that would need tolerances beyond the caps does not qualify: grade "none", reason "noise".
   - **No window.** `status:'tooShort'` when Δt_e,end < reach.fair (item 5b), else `status:'expectedNotFound'`.
   - Point skin S_i = 0.5·[Δp_i/m′ − ln(k·Δt_e,i/(φμct·rw²)) + 7.4316] across the window; its spread is I4.
   - Second level (I6): a disjoint window ≥ 0.3 cycle (±10 %, |s| ≤ 0.05) with ℓ2/ℓ outside [0.8, 1.25]. Later plateaus are listed.
   - An engineer override `window` forces [dt0, dt1] (`forced:true`).
4. **Line (L1–L3).**
   - `PRiSM_semilogAnalysis(adata, well, {method: single-rate ? 'horner' : 'superposition', window:{t0, t1}})`, which includes the W
     term, so S is right for short tp.
   - S is also evaluated at the window midpoint's Δt_e for the point-skin cross-check.
   - **Shifted lines for S_win.** Shift δ = min(0.25, 0.2·span) cycle, keeping the span, earlier and later, each clipped to [a0, the last
     bin whose full window exists]. A shift that does not fit is skipped. The lines are stored in `line.shifts`; S_win is finished in
     item 15.
   - L3, the plateau cross-check, is kept and labelled "line vs derivative plateau".
5. **Homogeneous fit (M1).**
   - `fitJob('homogeneous')` through `gridEntry` (10 points per decade over [tD_min/2, 2·tD(t_c − τ_0 + Δt_end)]; cubic Hermite in ln tD
     using the exact pd′).
   - Compacted history: the last 10·Δt_end exact plus one volume-mean block (≤ 0.1 psi and ≤ 0.13 % derivative error, measured over a
     365-day history; Appendix A.4).
   - 12 fit bins per cycle; objective log Δp + log Δp′ (the PRiSM default).
   - Seeds: k and S from the line, or from the level and the point skin when there is no line; C from C_us, or from the hump correlation
     inverted when the unit slope is missing.
   - A single start; a second start (S ± 2) only if not converged.
   - **Evaluation slicing (D5, §4.8):** each `step()` runs `fitPhysical` with `evalBudget = evalsPerSlice`, `lmState` from the previous
     slice and `slice:true`, until convergence (`stopReason` tolerance/gtol/plateau), a stall, or 40 iterations in total; the last call
     runs without `slice` and returns the statistics.
   - **5b. Reach (W4).** One pd′ evaluation of the fitted homogeneous model on the grid gives t_10 % and t_5 % (the last Δt_e outside
     ±10 % / ±5 % of the plateau). reach.fair = 10^(0.5 + Lcyc)·t_5 % (3.98·t_5 %) and reach.good = 10^(1 + Lcyc)·t_5 % (12.6·t_5 %),
     because the masked derivative ends one window (Lcyc) before Δt_e,end. They are compared with Δt_e,end and converted to shut-in
     hours with the test's effective tp. Reference case (k 45 md, S 5, C 0.02 bbl/psi, h 50 ft, μ 1 cp): t_5 % = 15.5 h, reach.fair =
     62 h, reach.good = 196 h.
6. **BIC (M§A10, D8).**
   - On the common point set (the 12-per-cycle fit bins, identical for every candidate and refit of the test), on the **log-Δp block**:
     SSR_m = Σ(ln Δp_i − ln Δp_model,i)², floored at Σ((σ_b,i/Δp_i)² + 0.005²).
   - ρ1 = lag-1 autocorrelation of the best model's log residuals (clipped to [0, 0.9]); n_eff = n·(1 − ρ1)/(1 + ρ1).
   - BIC = n_eff·ln(SSR/n) + p·ln n_eff. ΔBIC values are rounded to 0.1 before any comparison with τ (D27).
   - se of every parameter from the log-Δp block of the fit's final Jacobian, inflated by √(n/n_eff).
7. **Agreement (M§A12, D9).** agree = |k_line/k_match − 1| ≤ 0.05 and |S_line − S_match| ≤ 0.5. Otherwise the same line is fitted to the
   matched model's own synthetic Δp on the same window, giving the predicted bias b_k, b_S. If the observed differences equal the
   predicted ones within 3 % and 0.3 → "agree (bias explained)". The bias b_S is also computed for each shifted window of item 4
   (`line.shifts[].bS`).
8. **C-held (M§A13).** Triggered when the unit slope was not sampled, or Δt_1 > t_us/2.
   - Pair: refits with C frozen at f·C, f ∈ {0.8, 1.25}, and k and S free. A refit is rejected when ΔBIC > 10.
   - Mode `auto` (default): the extended refits (f ∈ {0.64, 0.5} on the low side, {1.56, 2.0} on the high side) run only on a side
     whose pair refit was **not** rejected, and stop at the first rejection. Mode `extended` runs them on both sides; `off` runs none.
     Worst case 6 refits; typical with a missed unit slope: 2.
   - The range of C, k and S over the accepted refits; S_C = half the S range.
   - Changing-storage flags → `meaningful:false`.
9. **Triggers and rivals (M§A9).** Triggers on the masked derivative relative to ℓ (or, with no IARF, to the minimum after the hump):
   - T-up: the last ≥ 0.2 cycle above 1.15·ℓ and rising → sealing fault, and composite with **M > 1** (less mobile outside; the outer
     level is 0.5·M in dimensionless derivative units);
   - T-down: below 0.85·ℓ and falling → closed circle, and composite with **M < 1** (more mobile outside);
   - T-level: I6 found → composite (seed M = ℓ2/ℓ);
   - T-none: no IARF **and** Δt_e,end ≥ reach.fair (IARF was expected but is absent) → all three. When Δt_e,end < reach.fair the status is
     "no IARF: test too short" (`noneSkipped:true`), no rival is fitted, and the test goes to the k-held pass.

   Seeds:
   - fault: L from the image-well inversion g = Δp′/ℓ − 1 ∈ [0.1, 0.9], L_i = √(0.0002637·k·Δt_i·ln(1/g_i)/(φμct)), median;
   - composite: R = r_inv(t_dev), M = ℓ2/ℓ (or the end ratio), bounds [0.05, 20], **F frozen at 1**;
   - closed circle: r_e = 0.9·r_inv(t_dev), starts ×{0.7, 1.0, 1.4}.

   Overrides: `model` forces one key (it is still fitted and reported); `excludeRivals` skips keys. If WP1's two-zone kernel misses its
   speed target (§4.6 kernels), composite leaves the automatic race: T-up and T-level then add the flag "possible radial composite —
   open in PRiSM" and the model label is at most medium.
10. **Anomaly flags (M7).** Valley, late half slope, early quarter/half slope, Δp hump (phase redistribution), steep storage, negative
    late derivative; for fall-offs, an early half slope (`fracHalf`, "injection-induced fracture"). A hump or steep-storage flag moves
    the fit start to 3·t_end,anomaly. A distractor flag (valley, half or quarter slope, `fracHalf`) that overlaps or precedes the IARF
    window sets `distractorAtOrBeforeIarf` (KL9).
11. **Eligibility and choice.**
    - A rival is eligible when its trigger fired, it converged, no parameter is within 1 % (log) of a bound, |corr| < 0.98, its distances
      lie within [0.05, 1.5]·r_inv(Δt_e,end), and 0.05 ≤ M ≤ 20.
    - It replaces homogeneous only if BIC_hom − BIC_r > τ.
    - The best eligible model wins; the table reports ΔBIC against homogeneous and the margin to the next model.
12. **Fully seen (M§A11).**
    - Fault: the last ≥ 0.15 cycle at ≥ 1.8·ℓ.
    - Composite: the second level flat for ≥ 0.3 cycle.
    - Closed: Δp′ ≤ 0.5·ℓ with local slope ≤ −0.5 over ≥ 0.2 cycle.
    - Otherwise "seen, not fully" (the distance is an estimate with one bound only).
    - Flat to the end → "no sealing boundary within L_min = X ft" (`minFaultDist_ft`), with
      L_min = √(0.0002637·k·Δt_e,last·ln(1/g)/(φμct)), Δt_e,last the last full-window bin, and g = max(0.15, 3σ_d/ℓ) (the departure that
      T-up or the noise would have revealed).
    - The closed-circle wording always lists the alternatives "constant-pressure boundary, interference or depletion"; stage 5 caps the
      model label if the pressure trend shows no depletion (only when depletion can be assessed).
13. **Final values (M§A12).** From the match when the line and match agree (raw or bias-explained), else the line (k, S) with C from
    the match or W2.
    - With no IARF and a fully-seen rival (T-none fired), the best model is used, label at most medium (at most low if the winner is not
      fully seen).
    - p* = the line value at H = 0.
    - **13b. p* range.** When `history.estimated`, the line is re-evaluated with the prepended period ×0.5, ×2 and ×10 (time function
      only, no refit): `pStarRange = {lo, hi}`. S cancels to first order; p* moves by about −m·log10(tp_true/tp_assumed).
    - **p_ext** = the chosen pressure-trend quantity at Δt → ∞: p* for the infinite-acting family, p̄ for the closed family. Pass 1 stores
      p* as p_ext; stage 4 picks one family for the whole analysis (§4.7) and recomputes p_ext with it for every test.
    - **model pi** = pwf0 + sign·(141.2Bμ/kh)·Σ Δq_i·pD(tD(t_c − τ_i)), from the chosen model through the grid entry. Reported, never
      used for a trend (for a closed circle it is the initial pressure, constant by construction).
    - r_inv = 0.0325·√(k·Δt/(φμct)), at Δt_end and at Δt_e,end.
    - Δp_skin = 0.8686·m·S with m = 162.6·Δq·B·μ/(k·h) from the final k and S; distances are converted to ft (R·rw, dF·rw, reD·rw).
    - Gas: S′, Δm_S = 0.8686·m·S′, converted to psi through the table.
14. **History sensitivity (D13).** When `history.estimated`, evaluate the homogeneous model derivative (forward only, no refit) with the
    prepended period doubled. If the masked derivative inside the IARF window changes by more than 2 % → `history.sensitive:true`
    (KC1 cap; review V15).
15. **S_err (M§A14, D10).**
    - Line-based tests: value = max(floor, se_S·√(n/n_eff), |S_line − S_match|, S_win, S_tc, S_pwf).
    - S_win: with two shifted lines, |S₊ − S₋|/2; with one, |S_shift − S_0| (a one-sided value, not doubled); with none, 0 (noted). When
      the agreement mode is "bias explained", each line's S is first corrected by its own b_S (S − b_S), so S_win measures the window
      sensitivity, not the known unsettled-window bias that |S_line − S_match| already carries. Target: the reference 72 h case gives
      S_win ≤ 0.15.
    - S_tc = 1.1513·|dpdt_flow|·dtc_h/m, analytic (the effect of δt_c on Δt is negligible inside the IARF window).
    - S_pwf = 1.1513·pwf0SE/m. A pwf0 error moves the line skin and the match skin identically, so the line-vs-match test cannot see it.
      Example: kh = 100,000 md·ft and m = 1.56 psi/cycle with pwf0SE = 0.5 psi gives 0.37.
    - k-held tests: value = max(floor, se_S·√(n/n_eff), S_tc, S_pwf, S_k) (item 18). Model-only tests (T-none winner): max(floor,
      se_S·√(n/n_eff), S_tc, S_pwf).
    - `driver` names the largest term; `mode` says which formula applied.
    - ext = max(value, S_C); sSens = RSS over inputs of the larger ±ΔS (typical ranges); sAbs = √(value² + sSens²).
    - The floor and τ come from the calibration table when it is present.
16. **Sensitivity (M§A16).** Analytic and exact for homogeneous (Appendix A.2):
    - k ∝ q·B·μ/h;
    - ΔS = +1.1513·log10 f for h, φ, ct; +2.3026·log10 f for rw; −1.1513·log10 f for B and q; 0 for μ.

    Two tables:
    - `req`: the requirement's ±20 % (h, φ, ct, rw, B, μ) and ±10 % (q), always shown;
    - `typ`: the per-input typical ranges from `WellInput.sens`, which drive S_sens.

    Both dominant inputs are stated, each labelled: under the requirement's ranges h dominates k (asymmetric: +25 % at −20 %) and rw
    dominates S (+0.18 / −0.22 against ≤ 0.11 for h, φ, ct); under the typical ranges h still dominates k, and S is dominated by the
    input with the largest typical ΔS (with the defaults, ct). The engine states "μ has no effect on S".
17. **Confidence, pass 1 (M§A17)**: §5.1, with the evidence available in stage 1.
18. **Stages (D26), owned by `run`.**
    1. **Stage 1.** `interpretJob` per test → pass-1 results and labels (the pass-2 evidence fields are `null` and their rules do not
       fire yet).
    2. **Stage 2.** `trend.baseline` over the pass-1 tests whose k/S label is ≥ medium (first up to 3 per segment) → `Analysis.baseline =
       {k (median), cvK, kh, tests}`.
    3. **Stage 3, pass 2** (with the stage-2 baseline):
       - `kHeld`: tests with grade "none" and `noneSkipped`, or "fair" with span < 0.6 cycle and Δt_e,end < reach.fair. Fit homogeneous with
         k frozen at k_base, S and C free; then two refits at k_base·(1 ± δ) with δ = √(CV_k² + (allocAccPct/100)² + se(median k)²), where
         se(median k) = 1.2533·1.4826·MAD(k)/(√n·median k). S_k = half the S range of the two refits. This covers both the k spread and
         the test's own rate error, which a k-held fit cannot absorb into kh: the model derivative level is wrong by the k error and S
         absorbs it at the matched Δp, ΔS ≈ δ·(p_D − 0.5) with p_D = Δp_end/(2·m′_held), typically 10–13. The analytic value is reported
         as `S_kAnalytic` (cross-check). Reference case: a 5 % k offset gives |ΔS| ≈ 0.5–0.6.
       - `backgroundCheck`: subtract Δt·(dp/dt)_bg from Δp, where (dp/dt)_bg is the Theil–Sen slope of the tests' p_ext, or the drift
         input when there are fewer than 3 tests **or the history is estimated** (D13). Recompute the derivative and triggers (no refit). If
         a chosen rival's trigger disappears → `boundaryDepends:true`, model label low, review V19.
       - Partial-cut suspicion (§4.3) and R4 (§4.5).
       - Window-level check: a test whose IARF level implies k outside median ± 2·CV·median → `windowLevelInconsistent` (KC5, review V20).
         The window is not changed automatically.
       - `confidence` is called again for every test with the full evidence vector → **final k/S labels**. The used set (k/S label ≥
         medium, k-held included when medium) is frozen here.
    4. **Stage 4.** `trend.compute` over the frozen used set; it writes `series[].used`, which `run` copies to `TestEntry.used`.
    5. **Stage 5.** Trend model caps (closed circle without depletion → model label ≤ medium) are applied once to K2 and the headline
       label. They never change the k/S label or the used set, so there is no feedback.

**Kernels (WP1).** Both are folded with `PRiSM_evalWbsSkin`, use scaled Bessel functions local to 53 (I0e, I1e, K0e, K1e) and
cylindrical-source reservoir solutions. dScale is applied to all distances as `PRiSM_evalWbsSkin` passes it.
- Closed circle: p̄ = [K0(√s) + I0(√s)·ρ] / (s·√s·[K1(√s) − I1(√s)·ρ]), where ρ = K1(reD√s)/I1(reD√s), computed in scaled form
  (it underflows safely to 0).
  - **Grid form.** In pseudo-steady state pD grows linearly (≈ 2tD/reD²) to values of several hundred after months of history, and the
    build-up Δp is a difference of many large superposed terms, so interpolating pD itself would cost 1–10 psi. The grid therefore holds
    the bounded function pD − 2tD/reD² (and pd′ − 2tD/reD²); the linear term is added analytically, and its superposition sum has the
    closed form (2/reD²)·Σ Δq_i·tD(t − τ_i).
- Two-zone composite (inner zone r ∈ [1, R], outer r > R; M = λ1/λ2, F = (φct)1/(φct)2; outer argument r·√(s·M/F)):
  p̄1 = A·I0(r√s) + B·K0(r√s), p̄2 = Cc·K0(r√(sM/F)).
  - Well: √s·(B·K1(√s) − A·I1(√s)) = 1/s.
  - Interface: p̄1 = p̄2, and dp̄1/dr = (1/M)·dp̄2/dr.
  - A 3×3 solve per s. With M = λ1/λ2 the outer derivative level is 0.5·M: M > 1 rises, M < 1 falls.

  It is validated against `PRiSM_MODELS.radialComposite` to 0.5 % (pd and pd′, tD 1e2–1e8, six parameter sets, three with M > 1 and three
  with M < 1).

Targets: closed circle ≤ 1.5 ms and two-zone ≤ 3 ms per 60-point pd + pd′ on desktop (the registry composite takes 41 ms). If the two-zone
kernel misses 6 ms, composite leaves the automatic race (item 9); the registry composite is never run inside a work unit.

### 4.7 Trend (WP3) — M§A22–M§A28

Only tests in the frozen used set (stage 3: k/S label ≥ medium; k-held tests count when labelled medium and are flagged) enter the
baseline, trend and alerts. Low tests are shown and excluded, with the reason.

- **Excluded low tests (T16).** S5 reports "N low tests excluded" with their S range. When an excluded test meets an alert condition
  with its own S and S_err and no used test confirms it, the alert status is `possible` (shown, never confirmed by excluded tests).
- **Trend enabled.** `settings.trend.enabled`: `auto` (default) turns the trend and alerts off in table mode or when the median test
  spacing is under 1 day (`disabledReason`); `on` / `off` override.
- **Baseline (M§A22).** S_base = median of the first (up to) 3 used tests in each segment. Workover dates start new segments.
  - σ_base = max(median S_err, 1.4826·MAD/√n).
  - "Unstable" when the range > 2·max S_err.
  - Fewer than 3 tests or any k-held test → `provisional`.
- **Alerts (M§A23, D11).**
  - Delta: S_j − E_j − S_base > Δ (default 2), where E_j = S_err,j (plain form, the default) or √(S_err,j² + σ_base²) (`basevar` form).
  - Absolute: S_j − S_err,j > S_alert (default 5), on S_mech when completion data exist (`basis:'mechanical'`).
  - Raised at the first used test that meets the condition.
  - Confirmed at the next used test that also meets it, or immediately when the raising test is labelled high and exceeds the
    threshold by ≥ 1. Otherwise provisional. Detection delay (benchmark, §5.2) is counted to the **confirmed** alert.
  - k-held tests raise and confirm alerts with their own S_err (which includes S_k); `kHeldOnly:true` when every contributing test is
    k-held, and the alert text says so (Q21).
  - Robustness: repeat the absolute test with S ± S_sens → "first confirmed test unchanged" or "moves to Bn".
  - Delta is input-robust (a uniform input error shifts every S equally, exactly so for homogeneous).
  - Gas: the alert text states the D·q change between the tests (expected D × Δq).
- **Onset (M§A24).** Hinge regression with weights 1/S_err² over τ on test dates and midpoints (needs ≥ 2 tests after τ).
  - The profile interval is ΔWSSR ≤ 1.
  - Hinge vs constant vs line by BIC, with "indicative" when n < 6.
  - CUSUM confirmation (κ = 0.5, h = 4).
- **Recent trend (M§A25).** Theil–Sen ×30 (skin per 30 days) with the Sen CI and Mann–Kendall over the tests after τ̂ (n ≥ 3; n ≤ 4
  "indicative"). Also the WLS slope; `disagree` when the two differ by more than 50 %.
- **Forecast (M§A26).** Shown only when the Sen lower bound > 0 (or Mann–Kendall p < 0.10 with n ≥ 5).
  t_cross = t_last + (S_alert + S_err,typ − S_fit(t_last))/b, with a range from the slope bounds, and nothing beyond 2× the
  post-τ̂ span.
- **Skin products (T7, T8, M§A27).**
  - Δp_skin = 0.8686·m·S with m = 162.6·Δq·B·μ/(k·h) from each test's final k and S.
  - X = ln(r_e/rw) − 0.75, with **r_e from `well.re_ft` when given; else max r_inv** (`reSource:'rinv'`).
  - Guard: X + S ≥ 1, else "not computable (strongly negative skin)".
  - PI ratio X/(X + S).
  - Constant-drawdown rate at stake: q_now·[(X + S_now)/(X + S_base) − 1].
  - Constant-rate extra drawdown: 141.2·qBμ·ΔS/kh.
  - Cumulative since τ̂: Σ_days q_d·[(X + S(t_d))/(X + S_base) − 1].
  - Optional value = cumulative × value per unit volume.
  - Gas: S → S + D·q in the X + S terms.
  - All of these are labelled "pseudo-steady-state estimate". When `reSource:'rinv'`, the PI ratio is labelled "lower bound" and the rate
    and cumulative at stake "upper bound (r_e assumed from r_inv)".
- **k stability (T9).** CV_k = 1.4826·MAD/median; stable if ≤ max(5 %, allocation accuracy). The interpretation table is Appendix A.3.
  The cross-test window check (KC5) is computed in stage 3 and reported here.
- **Pressure trend (T10).** One quantity per analysis: the family is `closed` when the closed circle is the chosen model on at least half
  of the used tests (p_ext = p̄ for every test, with r_e = the median of the closed fits or `well.re_ft`), else `infinite` (p_ext = p*).
  Theil–Sen on the datum p_ext, psi per 30 days. Depletion if |slope|·span > 2·scatter and Mann–Kendall p < 0.10. Labelled "depletion or
  gauge drift" whenever the drift input could explain it. **Not assessable** (`assessable:false`, `depletion:null`) when the history is
  estimated (the assumption alone creates a trend of about +10 psi per 30 days on a 5-year-old well) or with fewer than 3 tests; the
  report then says "depletion cannot be assessed" and quotes the p* range. Closed-circle tests without depletion → `closedWithoutDepletion`
  (model cap medium, V18) only when the trend is assessable.
- **Model-free ΔS (T11, M§A28).** At a common Δt_ref (the largest `iarfDt0_h` that is ≤ the smallest `dtEnd_h`), from `TrendTest.bins`:
  ΔS = 1.1513·[(Δp_j/q_j − Δp_b/q_b)/(m/q)_b − log10(Δt_e,j/Δt_e,b)]. It agrees within max(0.3, S_err).
- **Bubble point (T12, M§A20).** The sandface pwf range = pwf0_datum ± ΔG·Δz, with the flowing gradient input ±20 %.
  - ok ≥ Pb + 100; minor within 100 psi; major below Pb; critical when p_ext < Pb (only when the pressure trend is assessable; with an
    estimated history the upper end of the p* range is compared and the level is at most major).
  - Spearman ρ(S, max(0, Pb − pwf)) ≥ 0.7 over ≥ 4 tests is a rule (V12).
  - Off for gas and injectors.
- **PI cross-check (T13, M§A21).** J_obs,d = q_d/(p_ref,d − pwf_d) on flowing days, with pwf_d = `days[].pwfMean_psia` and p_ref
  interpolated between the tests' p_ext. J_pred uses the PSS form with S(t) interpolated. The median R_J per interval should lie in
  [0.8, 1.25]. Off for injectors and when the history is estimated (`available:false`).
- **Mechanical skin (T14, D23).** `PRiSM_skinCheck.mechanicalSkin` per test; ΔS_mech = ΔS_total − D·Δq.
- **Rate skin (T15, M§A19).** `PRiSM_skinCheck.rateSkin` over the baseline segment (or tests ≤ 60 days apart with no significant trend),
  with q_max/q_min ≥ **1.5** and D/se ≥ 2. A joint fit with a time term needs ≥ 4 tests and |corr(q, t)| < 0.8. Otherwise "S′
  (apparent skin including D·q)" with the expected-D range.
- **Recommendations** (advisory, each with evidence):
  - stimulation-candidate review (confirmed delta alert with stable k);
  - verify h/μ/B (any defaulted input);
  - bubble-point check;
  - water-cut/GOR trend (R7);
  - non-Darcy multi-rate test (gas, unresolved D);
  - longer shut-ins (reach.fair > Δt_e,end on most tests: "this well needs a shut-in of at least X h", X = the median `reachFairShut_h`);
  - enter production start (history estimated);
  - enter a workover date (suspected intervention).
- **Limitations** (fixed list plus case items): models not interpreted (dual porosity, fractures, channels, multilayer); single-phase
  fluid assumptions (two-phase ct when flagged); inputs not checked; allocation accuracy; total skin vs mechanical; PSS PI assumptions;
  partial cuts not interpreted; changing storage not modelled; gradient changes in the wellbore during build-up; the IARF window is the
  earliest plateau, not the longest (the longest is reported); p* with an estimated history.

### 4.8 Performance budget and responsiveness

Measured desktop figures come from the planning measurements (Appendix A.4). The targets are WP1/WP2 done criteria, checked in
`buildup-validate.js --perf` (wall clock, desktop). The acceptance tests check the **counters** (`stats()`), because the harness clock is
virtual.

| Item | Today (measured) | Target, desktop | Phone (×3) | Lever |
|---|---|---|---|---|
| Parse 500k rows | 3,445 ms in one block | ≤ 1.5 s total, ≤ 50 ms per chunk | ≤ 4.5 s, ≤ 150 ms per chunk | chunked parser, measured µs per row |
| QC + detection, 500k samples | — | ≤ 400 ms in ≤ 50 ms units | ≤ 1.2 s | O(n) passes, chunked |
| Raw encode for the store, 500k samples | — | ≤ 150 ms in ≤ 50 ms units | ≤ 450 ms | `store.encodeJob` through `drive` |
| Per-test prep (bins, derivative, IARF, up to 3 lines) | lines 5–13 ms each | ≤ 40 ms | ≤ 120 ms | one unit |
| Homogeneous fit, 365 daily steps | 12 s (1 start) | ≤ 60 ms | ≤ 180 ms, sliced | compaction + grid + 12 bins per cycle + seeded start |
| C-held refits (pair; extended only when not rejected) | 147 ms each, single rate | ≤ 30 ms each | ≤ 90 ms | warm start |
| k-held fit + 2 refits (pass 2) | — | ≤ 80 ms | ≤ 240 ms, sliced | k frozen, warm start |
| Fault fit | 0.54 s | ≤ 100 ms | sliced | grid, departure seed |
| Composite fit, F frozen | 24 s (F free) | ≤ 300 ms total | sliced | two-zone kernel |
| Closed circle, 3 starts | 89 s (rectangle) | ≤ 150 ms | sliced | new kernel, bounded grid |
| Typical test (no trigger, C-held pair) | — | ≤ 200 ms | ≤ 0.6 s | — |
| 8 tests, 2 triggered | — | ≤ 1.7 s | **≤ 5 s**, with progress and cancel | — |
| Re-analysis after one new test (cache) | — | ≤ 0.4 s | ≤ 1.2 s | per-test `inputHash` |
| Trend + review + report model | — | ≤ 50 ms | ≤ 150 ms | synchronous |
| Render results (12 sections, up to 9 charts) | — | ≤ 50 ms per unit; charts drawn one per yielded unit | ≤ 150 ms per unit | — |
| Largest single blocking unit | 3.4 s (parse) | **≤ 50 ms** | ≤ 150 ms | unit budget |

If the phone check in WP9 misses 5 s for 8 tests, the measured value and the reason are recorded in §11 and PROJECT-NOTES; the unit budget
(≤ 150 ms on a phone) is not relaxed.

**Slicing rule (deterministic).** Costs come from a **static** table, never from a clock. `DEFAULTS.budget.costMs[key][sign of S]` is the
measured desktop cost of one 60-point pd + pd′. One evaluation of a fit costs `evalCost = costMs × gridPoints/60` (the grid entry evaluates
pd and pd′ once per parameter set; interpolation over the steps is cheap). A slice gets `evalsPerSlice = clamp(floor(unitMs / evalCost),
nFree + 1, 24)` residual evaluations with `unitMs = 50`, so at least one full LM iteration (nFree Jacobian columns plus one trial) always
fits. `PRiSM_lm` allows up to 40 trials per iteration; with `evalBudget` a slice simply stops after its budget and the next slice resumes
with the carried λ and plateau counter, without a fresh initial evaluation and without the final statistics (`slice:true`). Examples:
homogeneous, S ≥ 0, 65 grid points, 3 free parameters → evalCost 4.33 ms, 11 evaluations per slice (about 2.75 iterations when no trial
is rejected); the same with S < 0 → 8.67 ms, 5 evaluations; a fault fit (9 ms, 4 free) → 9.75 ms, 5 evaluations. Parse units are
`chunkLines` lines, detection and encode units 50,000 samples. The same work splits identically on every device.

**Driver (`PRiSM_autoInterp.drive`).**
- `step()`, then `await new Promise(r => setTimeout(r, 0))`, then check `shouldCancel()`, report progress, and repeat until done. The page
  passes `() => cancelled || !root.isConnected || token !== currentToken || WTS_wells.active() !== wellId` (§6.5).
- On cancel it resolves its pending yield and rejects with `CANCELLED`, so no timer remains.
- It never re-arms while idle.
- The test pattern: run, `await app.flushAsync()`, `app.flush(5000)`, expect `pendingTimers() === 0`.

**Caching.** A per-test `inputHash` covers the spec, settings and overrides. `analyseAsync({cache})` reuses unchanged pass-1 results, so an
override or one new test re-runs one test plus stages 2–5. Opening the page renders stored results and **never** starts an analysis (a11y
and v3-ux tests open every route).

### 4.9 Reproducibility

- **"Same project file + same app version ⇒ same displayed numbers."** Engines are deterministic: no `Math.random`, count-based slicing,
  and yields outside the numeric path. The sync and async runs must give identical `resultHash` (WP2 test).
- **Zones.** The resolved IANA zone names are stored and hashed (§4.4), so a project gives the same days and rates on every device.
- **Across JS engines**, last-bit differences in `Math.exp`/`log`/`pow` may change hidden digits. Two guards:
  - every threshold decision compares inputs rounded to display precision (ΔBIC 0.1, span 0.01 cycle, slope 0.001, ratios 0.001;
    `DEFAULTS.round`), so a model, label or alert cannot flip on a last-bit difference;
  - hashes use `canon` (inputs to 6 significant figures, results to display precision, §8.4).
- **Reproduction without the raw record.** `AnalysisInput.stored` re-runs interpretation, trend and review from the stored events,
  rates and per-test bins (from `wts_buildup_state`, or the overflow `tests` store / `buildup_analysis` module). Detection is re-run only
  when a raw record with the matching hash is present (IndexedDB or the project's `buildup_raw`).

### 4.10 Defaults (all settable; "cal" = replaced by the calibration table)

| Item | Default |
|---|---|
| Detection window, rise | max(5 min, 3·Δt_med); T_s = max(5 psi, 10σ) over j = 1…30 min of windows, persistent ≥ 30 min and ≥ 2 windows |
| End of build-up | fall < −T_s persisting 30 min and below the level 30 min earlier; 2 h when the allocation says shut all day |
| Flowing trend for pwf0 | max(30 min, 10·Δt_med, ≥ 10 samples), not crossing the previous event; first shut-in sample > max(4σ_flow, 0.5 psi) |
| Partial step / gate | max(2 psi, 6σ), ≥ 2 h; shut-in when the allocation confirms full-shut-in hours or f̂ ≥ 0.95; 0.9 ≤ f̂ < 0.95 interpreted with Δq·f̂ (cap medium) |
| Minimum duration; gap | 2 h; gap > max(5·Δt_med, Δt_med + 60 s); gap at closing > max(5·Δt_med, 10 min) |
| Spike filter | off (k 5, 6 robust σ, runs ≤ 2) |
| Bins | 20 per cycle (derivative), 12 per cycle (fit and BIC) |
| L | 0.1 cycle (0.2303 ln), range 0.05–0.3 |
| IARF | grades at ±10 % / ±0.03; widening max(10 %, 3σ_d/ℓ) ≤ 20 % and max(0.03, 2·se_s) ≤ 0.06 ("fair (noise-widened)"); ≥ 0.5 cycle after the hump; good ≥ 1 cycle with the last 0.5 cycle at \|s\| ≤ 0.01 and se ≤ 0.01; valley 15 % |
| IARF reach | fair 10^(0.5 + L)·t_5 % = 3.98·t_5 %; good 10^(1 + L)·t_5 % = 12.6·t_5 %; t_5 %, t_10 % numeric from the fitted model |
| Point-skin spread (high) | 0.3 (cal) |
| SNR_d | high ≥ 20 (cal); low < 5 (cal) |
| Triggers | late ±15 % for ≥ 0.2 cycle; second level outside [0.8, 1.25]; T-none only when Δt_e,end ≥ reach.fair |
| BIC | log-Δp block, n_eff (AR(1)), floor (σ_b/Δp)² + 0.005²; τ = 10 (cal) |
| Fully seen | fault ≥ 1.8× over 0.15 cycle; composite 0.3 cycle; closed ≤ 0.5× and slope ≤ −0.5 |
| Agreement | k 5 %, S 0.5; bias-explained 3 %, 0.3 |
| C-held | ×0.8 / ×1.25; extended ×0.64, ×0.5, ×1.56, ×2 only on a side not rejected; reject ΔBIC > 10 |
| S_err | floor 0.2 (cal by coverage); window shift min(0.25, 0.2·span) cycle |
| k-held | eligible: no IARF (too short) or fair with span < 0.6 and Δt_e,end < reach.fair; δ = √(CV_k² + acc² + se²); KK: \|corr(C, S)\| < 0.95, RMS ≤ 3σ_eff (cal), S_err ≤ 1.0 |
| History | prepend max(30 d, 10·Δt_end,max); doubling check 2 %; p* range ×0.5 / ×2 / ×10 |
| Allocation | ±15 % + volume resolution; clean day h_on ≥ day hours − 0.5 with no reopening in the previous 12 h; at least 2 clean days within ±10 days; closing day < 6 h → previous day's rate |
| Production day; zones | start 00:00; gauge and day zones `device`, resolved to the IANA name at the first analysis and stored |
| Drift / tide | 0.01 psi/day assumed; indices 0.05 / 0.10; M2 from 24 h, M2 + K1 from 48 h |
| Baseline; alerts | first 3 used tests; delta 2 (plain form; cal chooses the form); absolute 5; confirmation by the next test |
| Trend | on, except in table mode or with tests less than 1 day apart (auto) |
| Trend significance | n ≥ 5; n 3–4 indicative |
| Bubble point | 100 psi margin, flowing gradient ±20 % |
| k stable | CV ≤ max(5 %, allocation accuracy) |
| PI check | 0.8 ≤ R_J ≤ 1.25 |
| Non-Darcy | q ratio ≥ 1.5, ≤ 60 days apart, D/se ≥ 2 |
| Sensitivity, typical | h 20 %, φ 10 %, ct 30 %, rw 5 %, B 5 %, μ 20 %, q 10 % |
| Maximum tests | 60 per analysis, kept by selection (longest per day, then per week, baseline tests always kept) |

---

## 5. Confidence labels and the synthetic benchmark

### 5.1 Label rules (M§A17; thresholds marked * are calibrated, §5.4)

Three labels per test: the **k/S label** (K1), the **model label** (K2, never above K1) and the **headline label** = min(K1, K2). Rules are
evaluated in stage 1 with the evidence available then, and again in stage 3 with the full evidence (§4.6 item 18). Rules marked "free"
apply to free-k results (line-based or model-only); k-held results use KK1–KK4 instead.

**k/S label (K1).**

| Kind | Id | Rule | Applies to | Evidence |
|---|---|---|---|---|
| LOW if any | KL1 | IARF "none" and no fully-seen rival | free | I1, M5 |
| | KL2 | S_err > 1.0* | free | U1 |
| | KL3 | R3 or R4 failed by more than 25 %, or Δq unknown | all | R1, R3, R4 |
| | KL4 | Hump or steep-storage flag inside or after the IARF start (k-held: anywhere after the fit start) | all | M7 |
| | KL5 | SNR_d < 5* in the IARF window | free | I5 |
| | KL6 | Line and match disagree, not explained: \|ΔS\| > 1.0* or \|Δk\| > 15 %* | free | A1 |
| | KL7 | Δt_e,end < 3.98*·t_10 % (numeric t_10 %; the window cannot be IARF) | free | W4, I1 |
| | KL8 | Partial-cut suspicion (m′/m′_base < 0.7, k stable elsewhere; stage 3) | free | R1, I3, T9 |
| | KL9* | A distractor flag (valley, half or quarter slope, `fracHalf`) that overlaps or precedes the IARF window (k-held: any distractor flag) | all | M7, I1 |
| LOW if any (k-held) | KK1 | k-held fit not converged | k-held | M8 |
| | KK2 | \|corr(C, S)\| ≥ 0.95 in the k-held fit | k-held | M8 |
| | KK3 | Δp residual RMS > 3*·σ_eff, σ_eff = √(σ_b² + σ_LF²) | k-held | M8, I5 |
| | KK4 | S_err (k-held, with S_k) > 1.0 | k-held | U1 |
| MEDIUM cap if any | KC1 | History estimated and sensitive (more than 2 %) | all | R5 |
| | KC2 | Outside the calibration envelope, or table not calibrated | all | K1 |
| | KC3 | k-held result | k-held | M8 |
| | KC4 | R3 `unavailable` (fewer than 2 clean days, or a short day) or equal-rate assumption. Not applied when R3 is `n/a` (measured or tabled rates) | all | R2, R3 |
| | KC5 | IARF level inconsistent with the baseline kh (stage 3) | free | T9 |
| | KC6 | Rate step interpreted with Δq·f̂ (0.9 ≤ f̂ < 0.95) | all | R1, D6 |
| HIGH if all | KH1 | IARF "good", or "fair" (not noise-widened) with span ≥ 0.7* cycle and point-skin spread ≤ 0.3* | free | I1, I4 |
| | KH2 | Line and match agree (raw or bias-explained) | free | A1 |
| | KH3 | S_err ≤ 0.5* | free | U1 |
| | KH4 | Unit slope sampled, or both ×0.8 / ×1.25 C-held refits rejected | free | W1, C1 |
| | KH5 | R3 passes within its tolerance* (or is `n/a`), and R4 within 15 % when available | free | R3, R4 |
| | KH6 | SNR_d ≥ 20*, r_drift ≤ 0.05, r_tide ≤ 0.10 (or removed), no M7 flag | free | I5, Q5, Q6, M7 |
| otherwise | | MEDIUM (k-held: MEDIUM, from KC3) | | |

**Model label (K2).**
- HIGH: homogeneous chosen with no trigger and IARF "good"; or a rival chosen with ΔBIC > τ* against homogeneous **and** against the next
  rival, **and** fully seen.
- MEDIUM: a rival chosen but not fully seen; homogeneous with a trigger and no rival better by τ; a test with no IARF because it was too
  short (no rival fitted); or composite triggered while composite is out of the race (§4.6 item 9).
- LOW: no IARF while expected (T-none fired) and the winner not fully seen; any distractor flag (valley, late half slope, early quarter or
  half slope, `fracHalf`); or `boundaryDepends`.
- Caps: K2 ≤ K1 (requirement); closed circle without depletion ≤ medium (stage 5, only when the pressure trend is assessable).

**Text.** The verdict line is short: "Confidence: medium (k/S) · medium (test)". The reasons are a table (rule, kind, text, evidence),
for example "KH1 unmet: fair window 0.58 cycle [B3·I1]" and "KC1: history start estimated, derivative changes 2.6 % [B3·R5]". Every
fired KL/KK or KC rule and every unmet KH rule is listed with its evidence ids. The label shows the calibrated rate of that label with
its interval: the k/S label quotes `ksTable` ("k and S right"), the headline label quotes `table` ("fully right").

### 5.2 Benchmark design (WP4 builds, WP8 runs)

**Single build-ups: 640 cases, one integer seed each (100000–100639).** Seed → (stratum, row) through a fixed table: the strata take
consecutive seed ranges in the order and sizes listed below (`hom` 100000–100231, `fault` 100232–100291, …); `row` is the rank inside the
stratum. Each stratum has a Latin-hypercube design over its continuous parameters, built once from the master seed 3300 plus the stratum
index (one permutation per dimension from `rng`); row r takes the r-th stratified quantile of each dimension. `caseFromSeed(seed)` is
therefore a pure function of the seed.

| Stratum | n | Notes | Engine models it? |
|---|---|---|---|
| `hom` homogeneous + WBS + skin | 232 | 20 % short (2–8 h), the rest log-uniform 8–200 h | yes |
| `fault` sealing fault | 60 | L chosen so t_dev/Δt_end ∈ {0.1, 0.5, 2} | yes |
| `comp` radial composite | 60 | M 0.3–3, R = r_inv(Δt_end) × 0.2–1.5; F = 1 in two thirds, F 0.5–2 in one third | yes (F frozen at 1) |
| `closed` closed circle | 36 | t_DA at the end 0.05–1 | yes |
| `gas` gas producers | 80 | m(p); pseudo-time in 50 %; D·q 0–2; CO2/H2S/N2 0–10 mol % | yes |
| `inj` water-injector fall-offs | 24 | Water bank (composite M 0.2–1) in 50 %; 4 cases with an injection-induced fracture (half slope) | partly |
| `dualpor` | 36 | ω 0.05–0.3, λ 1e-8–1e-5 (valley inside or outside the test) | **no (distractor)** |
| `channel` | 24 | Width chosen so the half slope starts inside the test | **no** |
| `wbschange` | 18 | Changing storage, phase redistribution, gradient change (hump 1–20 psi) | **no** |
| `partpen` | 12 | Partial penetration (spherical flow) | **no** |
| `frac` | 12 | Finite-conductivity fracture | **no** |
| `constp` | 12 | Constant-pressure boundary (falling derivative, a decoy for "closed") | **no** |
| `interf` | 12 | Offset-well interference or depletion trend during the test | **no** |
| `partial` | 10 | A partial rate cut that looks like a shut-in | correct answer: "partial, not interpreted" |
| `baddata` | 12 | Gap at the closing, closing inside a gap | correct answer: "not analysable" |

**Parameter ranges (all strata):** k log-uniform 1–2,000 md; h 15–300 ft; S uniform −2…15; C log-uniform 0.002–0.2 bbl/psi; φ 0.08–0.30;
μ 0.2–10 cp; ct 3e-6–3e-5 1/psi; rw 0.25–0.40 ft; q 100–8,000 STB/d (gas 500–30,000 Mscf/d); B 1.05–1.8. Draws are rejected when
Δp(Δt_end) < 5 psi or pwf < 50 psia.

**Factors, crossed across all strata:**
- sampling {1 s for the first 2 h then 60 s, 10 s, 60 s, 300 s, 600 s} inside each build-up and the day before it; 300 s elsewhere;
- σ {0.005, 0.02, 0.1, 0.5} psi (white), plus **coloured noise** in 30 % of cases: AR(1) with ρ 0.5–0.95 or a random-walk component at
  the derivative scale;
- **slugging in flowing periods** (30 %): σ_flow = 2–20 × σ_shut;
- quantisation 0.01 psi (50 %);
- spikes (30 %);
- drift 0–0.05 psi/day (30 %);
- tides 0.05–0.5 psi (15 %);
- closing ramp 0–5 min (30 %);
- daily allocation over 30–180 days with ±5–25 % day variation and 0–3 earlier shut-ins;
- **flush after reopening** (+10–40 % decaying over 2–12 h) and **rate changes within a day** (10 %), so constant-rate spreading is not
  exact by construction;
- closing at a random hour; a closing within 1 h after the production-day start in 5 %;
- allocation error lognormal 3 % (all) and 10 % (25 %); volume rounding to 1 or 10 units;
- "allocation ignores the shut-in" (10 %);
- hours-on conflicting by 2–4 h (10 %);
- partial cut before the shut-in (10 %);
- **truncated history** (15 %: true production 1–5 years, start unknown to the engine);
- **high-kh noisy gauge** (10 %: kh 20,000–100,000 md·ft with σ 0.02–0.1 psi and slugging);
- **gauge-zone and production-day mismatch** of 6 h (10 %);
- **input errors** (all single cases): the engine receives h, φ, ct, rw, B, μ each perturbed by a lognormal 0–10 % (the truth used for
  scoring follows the inputs given, §5.3).

About a fifth of the cases (126 of 640) are distractor strata, and with the crossed factors **at least 40 % of cases contain at least one effect the
engine does not model** (the generator reports the exact share).

Generated records are capped at 500k samples (the requirement's envelope). The forward model evaluates pD once per case on a 40-per-decade
log grid in tD and interpolates for every sample and step.

**Sequences: 120 wells (seeds 200000–200119), 6–12 build-ups each over 90–365 days.**
- Skin paths: constant (40 %), step +3…+8 (20 %), linear 0.5–3 per 30 days (20 %), a rise then a stimulation drop (10 %; the workover
  date is entered in half of them), gas with rate changes at constant S (10 %).
- Shut-in lengths: 24–48 h in half of the wells, 48–120 h in the others.
- A per-well uniform input error of ±20 % on h, φ, ct, rw and B (input robustness), scored against the input-consistent truth of §5.3.
- Targets:
  - delta false-alarm rate on constant wells ≤ 5 % per well;
  - median delay of the **confirmed** delta alert ≤ 1 test after the true S − S_base exceeds 2.5 (the minimum possible is 1, because
    confirmation needs the next test unless the raising test is high and exceeds the threshold by ≥ 1); ≤ 2 tests on wells with 24–48 h
    shut-ins;
  - onset within one test interval in ≥ 80 %;
  - Sen CI covering the true slope in ≥ 85 %;
  - no delta alert on constant-S gas wells when D is resolved;
  - the stimulation drop without an entered workover date is classified as a shut-in, not a partial cut, in ≥ 95 %.
- The sequence build-ups (about 1,000) are pooled with the 640 single cases for the label tables, so at least 1,600 labelled build-ups
  are available.

**Independent generator (no inverse crime).**
- Own kernels for the four fitted models, with own scaled Bessel functions.
- Own Stehfest with **N = 16**, against N = 12 in the app. Its weights are computed by the generator itself.
- A 40-per-decade evaluation grid with cubic interpolation (the engine uses 10).
- The full, uncompacted daily history; real-time sampling; noise, drift and tides added in real time.
- Raw records and daily allocations are given to the **whole pipeline** (detection, refinement, rates), never cut-out build-ups.
- The generator keeps its own day, zone and allocation code. It must not call `WTS_buildup.data` or the PRiSM kernels of the fitted models
  (`homogeneous`, `linearBoundary`, `radialComposite`, `closedCircle`, `PRiSM_evalWbsSkin`); a source-grep test (GE7) enforces this.

Distractor physics may use PRiSM registry kernels (dual porosity, partial penetration, fracture, channel), because the engine never
fits those models.

### 5.3 What "fully right" means

- **Input-consistent truth, computed in the generator only.** The scorer never reads the engine's Δq or rates.
  - f = q_correct/q_true, where q_correct is what a correct reading of the given data yields: the closing day's given volume spread over the
    **true** flowing hours (q_correct = 24·V_given/h_true,on). On "ignores the shut-in" days, q_correct is the neighbouring-day reference
    rate the generator built from the given volumes. With a partial cut before the closing, the post-cut rate.
  - With primes for the inputs the engine received (`CaseSpec.given`):
    k* = f·k·(B′/B)·(μ′/μ)·(h/h′),
    S* = S + 1.1513·log10((h′/h)·(φ′/φ)·(ct′/ct)) + 2.3026·log10(rw′/rw) − 1.1513·log10((B′/B)·f).
  - Gas: S* = S′ = S + D·q at the test rate, with the same input terms.
  - Every rate-spreading error the engine makes (wrong flowing hours, zone offset, missed partial cut, mishandled "ignores the shut-in")
    therefore shows up as a k or S error and counts against the label. A uniform allocation bias cannot be seen in pressure data and is
    scored separately as "absolute accuracy".
  - **Rate accuracy** (the engine's Δq against q_correct) is reported as its own table (`rateAccuracy` in file 55).
- **First-plateau truth for distractors.** The generator computes, for each plateau of the noise-free truth, k* and
  S* = pD − 0.5·(ln tD + 0.80907) at the plateau's middle (with the input and rate terms above). The reference plateau is the first one
  with ≥ 0.5 cycle. For example, on the fissure plateau of a dual-porosity well S* = S + 0.5·ln(1/ω); on the late plateau of a partially
  penetrating well S* includes the pseudo-skin.
- **k/S right** = |k̂/k* − 1| ≤ 0.10 **and** |Ŝ − S*| ≤ 0.5 **and** the status is right (analysable / not analysable / partial).
- **Fully right** = k/S right **and** model right **and** no false "fully seen" flag.
- **Model right:**
  - homogeneous truth → homogeneous;
  - a rival whose feature is visible (≥ 10 % derivative departure at Δt_end on the noise-free truth) → that rival;
  - a rival that is not visible → homogeneous, or that rival;
  - a distractor whose feature is visible (the same ≥ 10 % noise-free departure test, inside the analysed window) → an anomaly flag, with
    k and S judged against the first-plateau k*, S*;
  - a distractor whose feature is not visible → homogeneous with k*, S* is right and needs no flag;
  - `constp` → never "closed, fully seen";
  - `baddata` → "not analysable";
  - `partial` → classified partial.
  - "Distractor caught" (a visible distractor flagged) is reported separately, never as part of "model right".
- **Abstention** (no k or S on analysable truth) counts as label **low** with y = 0 in both tables, so abstaining cannot raise the high or
  medium rates. The abstention rate is a calibration constraint (≤ 10 % on `hom` cases).
- Also reported:
  - strict (k ±5 %, S ±0.3);
  - C within ±25 % when the unit slope was sampled;
  - S_err coverage P(|Ŝ − S*| ≤ 2·S_err);
  - the k-held sub-table;
  - the gas sub-table;
  - the rate-source sub-strata (allocation, table).

### 5.4 Calibration (M§A-CAL, WP8)

1. Run every case and store the evidence vector and both outcomes: y_ks (k/S right) and y (fully right).
2. 5-fold cross-validation with **folds grouped by well** (each sequence well, and each single case as its own group), stratified by
   stratum and duration class. No well is split across folds.
3. On 4 folds, a **staged grid search** (each stage exhaustive over its own grid, the others held; stage 1 is repeated once after
   stage 2):
   - Stage 1, LOW thresholds: KL2 S_err low {0.8, 1.0, 1.2}; KL5 SNR_d low {3, 5, 8}; KL6 {0.7, 1.0} × {10 %, 15 %}; the KL7 factor
     {3.16, 3.98, 5.0}; KL9 {on, off}; KK3 {2, 3, 4}.
   - Stage 2, HIGH thresholds and τ: SNR_d high {10, 15, 20, 30}; S_err high {0.3, 0.4, 0.5, 0.6}; fair span high {0.6, 0.7, 0.8, 1.0};
     point-skin spread {0.2, 0.3, 0.4}; τ_BIC {6, 10, 20, 40}; rate tolerance {10, 15, 20 %}; S_err floor {0.2, 0.25, 0.3, 0.4};
     delta-alert form {plain, basevar}.
   - Objective: maximise the share labelled high (headline).
   - Subject to, for **both** the k/S table (y_ks) and the headline table (y): rate(high) ≥ 0.95 with lower bound ≥ 0.90;
     rate(medium) ≥ 0.80 with lower bound ≥ 0.70; rate(low) ≤ rate(medium) − 0.20; plus false-rival rate on homogeneous truth ≤ 0.05;
     S_err coverage ≥ 0.90 for high and medium; abstention ≤ 10 % on `hom`; sequence delta false-alarm rate ≤ 5 %.
   - Lower bounds: Wilson on the single-case table; a cluster bootstrap over wells (2,000 resamples, fixed seed) on the pooled table.
4. Label the held-out fold; rotate; pool the out-of-fold labels into the reliability tables, which are entirely out of sample.
5. Freeze one threshold set fitted on all folds and write file 55 with both tables, the Brier score, BSS, the Murphy decomposition and the
   envelope (5–95 % ranges of C_D, S, t_D/C_D at the end, SNR_d, k and Δt_end).

If the constraints cannot be met, thresholds get stricter (a smaller share labelled high). **The targets are never relaxed.** The
outcome is recorded in PROJECT-NOTES.

### 5.5 `prism-build/buildup-validate.js` (WP4 writes it, WP8 runs it)

```
node prism-build/buildup-validate.js [--quick] [--strata hom,fault] [--seeds 100000-100639] [--sequences]
     [--workers 4] [--out <dir>] [--write] [--placeholder] [--perf] [--strict] [--json]
```

- Loads the app through `tests/_harness.js` `loadApp({fromSources:true, timers:'real', console:'errors'})` once per worker
  (`child_process.fork`). Worker i takes the seeds ≡ i (mod workers).
- Per case: `synth.generate(synth.caseFromSeed(seed))` → `run.analyse(input)` → `synth.score(test, truth)`. One JSON line per case
  (seed, stratum, truth, outcome, evidence vector, labels) goes to `<out>/cases.jsonl`.
- `--write`: calibration (§5.4). Writes `prism-build/55-prism-autointerp-cal.js` with the header "GENERATED by buildup-validate.js — do
  not edit by hand" (version, date, seeds), and `<out>/calibration.md` (reliability tables, per-stratum breakdown, rate accuracy, sequence
  metrics, the 24 in-app cases with their expected outcomes and margins).
- `--placeholder`: writes file 55 with `calibrated:false` and the pre-calibration thresholds, without running anything.
- `--quick`: 60 cases plus the 20-seed false-rival check on homogeneous truth (moved here from the acceptance tests).
- `--perf`: runs the §4.8 timing targets on the demo and the reference case and prints a table. With `--strict` it exits 1 when a
  target is missed.
- Exit codes: 0 ok; 1 targets missed (with `--strict`); 2 crash. The default `--out` is `$TMPDIR/wts-buildup-validate`. Only file 55 is
  ever committed.
- Runtime: WP4 measures generation and analysis per case on the capped records and updates this line; the planning estimate is
  0.5–1.5 s per build-up end to end (generation included), i.e. 15–40 min on 1 worker and 4–10 min on 4. `--quick` stays under 2 min.

### 5.6 What runs where

- **Acceptance** (`buildup-benchmark.test.js`, WP8): 10 fixed seeds end to end (hom short, hom long, fault seen, comp, closed, gas, inj,
  dualpor, partial, baddata), generated with 60 s sampling and histories of at most 30 days. It asserts the snapshot outcomes (status, k/S
  and headline labels, fully right) recorded by WP8 and that no "high" case is wrong. Seeds are chosen with a margin (below) so the
  snapshot cannot flip on a last-bit difference. Budget ≤ 9 s.
- **In-app validation card**: the 24 `IN_APP` cases, user-triggered and asynchronous (planning estimate 10 s desktop, 30 s phone, with
  progress and cancel; WP4 measures and updates). Each case is chosen with margin ≥ 0.1: the smallest distance of its evidence to any
  label threshold, normalised by the threshold, stored in file 55. Outcomes are compared with `PRiSM_autoInterpCal.inApp[].expect`: "24 of
  24 as expected", or the differences, where a difference whose recomputed evidence lies within the stored margin of a threshold is shown
  as "near threshold" and not as a failure. The card also shows both reliability tables (label, n, rate, interval).
- **Full benchmark**: only in `buildup-validate.js`, never in accept-test.

---

## 6. Page UI (WP6)

### 6.1 Layout (one scrolling page, no tabs: reports capture visible blocks only)

```
#pgTitle  Build-up Surveillance
#pgSub    Automatic interpretation of every shut-in, skin trend and alerts, with review and sign-off  [· DRAFT | · Signed off <date>]
<div id="bu_root">
 <nav class="bu-jump rp-skip"> Data · Well · Depth & completion · Settings · Tests · Trend · Review · Report </nav>
 ┌ Card "Data sources" ──────────────────────┐ ┌ Card "Well and fluid" ─────────────────────────┐
 │ engineer; gauge source ▾; file / paste /  │ │ well type ▾; h φ μ B ct rw re; Pb Rs (oil)      │
 │ historian / PRiSM / demo; time format,    │ │ gas: SG T CO2 H2S N2, pseudo-time, dew point,   │
 │ zones (resolved name shown), pressure     │ │ condensate API / M_o                            │
 │ unit; column mapping                      │ │ injector: Bw μw; allocation accuracy; drift     │
 │ rate source ▾ daily | table; allocation   │ │ [Copy from PRiSM]  "inputs left at default: …"  │
 │ file/paste, mapping, production day;      │ └─────────────────────────────────────────────────┘
 │ history before the data ▾                 │ ┌ Card "Gauge depth & completion (optional)" ─────┐
 └───────────────────────────────────────────┘ │ depths, gradients; open interval, top, angle,   │
 ┌ Card "Settings" [Advanced ▸] ─────────────┐ │ kv/kh range; perforations; workover dates       │
 │ detection · interpretation · trend ·      │ └─────────────────────────────────────────────────┘
 │ report detail                             │
 └───────────────────────────────────────────┘
 [ Analyse ] [ Cancel (only while running) ]  <progress line role=status>   ⚠ stale banner (when inputs changed)
 <div id="bu_res" data-done="1">          ← ReportModel sections S1–S12 rendered as .rbox blocks (§8.2)
 three static <div><b>Notes</b> …</div> boxes (method, units, limitations), present at first paint
 <dialog id="bu_dlg" class="bu-dlg rp-skip" data-rp-nosnap data-no-persist><div class="bu-dlg-box"> action / override / decision form </div></dialog>
</div>
```

### 6.2 Controls (every id)

Physical inputs (h, φ, μ, B, ct, rw, re, Pb, Rs, Bw, μw, depths, gradients, completion lengths) are **validated, not clamped**: a value
outside its range blocks Analyse with a ✗ verdict that lists the fields, and those inputs get the `input-err` class (the cheminj
pattern). Detection, interpretation and trend settings and counts are clamped on read, and the values used are echoed in S2
"Settings used". A value of 1e12 or −1 therefore never hangs the page and never silently changes k or S.

| Id | Label | Type / unit category | Default | Range / notes |
|---|---|---|---|---|
| `bu_eng` | Engineer | text, `data-no-decimal-comma` | — | Used as "who" for overrides and decisions |
| `bu_src` | Gauge data source | select file / paste / historian / prism / demo | file | |
| `bu_g_file` | Gauge file | file (.csv, .txt, .xlsx) | — | Not persisted (host rule) |
| `bu_g_paste` | Paste gauge data | textarea, `data-no-persist` | — | |
| `bu_g_load` | Load gauge data | button | | Immediate status text |
| `bu_g_tfmt` | Time format | select auto / iso / dmy / mdy / elapsed_h / elapsed_min / elapsed_s / serial (spreadsheet days) | auto | |
| `bu_g_t0` | Start of elapsed time | datetime-local | 2026-01-01T00:00 | |
| `bu_g_tz` / `bu_g_tzoff` / `bu_g_tzname` | Gauge time zone / fixed offset (h) / resolved zone | select device / utc / fixed; number; read-only text (persisted) | device / 0 / filled at the first analysis | −12…14 (clamped) |
| `bu_tz_reset` | Use this device's zone | button | | Re-resolves both zone names; marks the results stale |
| `bu_g_punit` / `bu_patm` | Pressure unit in file / atmospheric pressure | select psia / psig / kPa / kPa(g) / bar / bar(g) / MPa; `pressureBase` | psia / 14.696 | 10–16 psia (validated) |
| `bu_g_ct`, `bu_g_cp`, `bu_g_cT`, `bu_g_cq` | Time, pressure, temperature, rate columns | selects inside `#bu_g_map[data-no-persist]` | sniffed | Values are kept in the state record |
| `bu_h_tag`, `bu_h_from`, `bu_h_to`, `bu_h_load` | Historian tag, from, to, load | select (`data-no-persist`), datetime-local ×2, button | last 30 days | Tag list from `listTags()` |
| `bu_p_load` | Use the current PRiSM dataset | button | | |
| `bu_demo_kind`, `bu_demo_load` | Demo, load demo | select oil / gas; button | oil | |
| `bu_g_status` | — | div role=status | | |
| `bu_rate_mode` | Rate source | select daily allocation / time-stamped rate table | daily | |
| `bu_a_file`, `bu_a_paste`, `bu_a_load` | Allocation file, paste, load | file; textarea (`data-no-persist`); button | | |
| `bu_a_cd`, `bu_a_co`, `bu_a_cg`, `bu_a_cw`, `bu_a_ch` | Date, oil, gas, water, hours columns | selects in `#bu_a_map[data-no-persist]` | sniffed | |
| `bu_a_gunit`, `bu_a_dayfirst`, `bu_a_wcond` | Gas volume unit; dates are day-first; water column is condensed water | select Mscf / MMscf / Sm³; checkbox; checkbox | Mscf; off; off | `bu_a_wcond` shown for gas |
| `bu_pd_start`, `bu_pd_tz`, `bu_pd_tzoff`, `bu_pd_tzname` | Production day starts at (h); zone; fixed offset; resolved zone | number; select; number; read-only text (persisted) | 0; device; 0; filled at the first analysis | 0–23; −12…14 (clamped) |
| `bu_hist_mode`, `bu_hist_date`, `bu_hist_cumo`, `bu_hist_cumg` | History before the data; production start; cumulative oil; cumulative gas | select unknown / date / cum; date; `volume`; `gasVolume` | unknown | Cumulative field shown per fluid |
| `bu_fluid` | Well type | select oil producer / gas producer / water injector | oil | |
| `bu_h`, `bu_rw`, `bu_re` | Net pay h; wellbore radius; drainage radius (blank = lower bound from r_inv) | `length` | 50; 0.3; blank | 1–2,000; 0.1–2; blank or ≥ 10·rw (validated) |
| `bu_phi`, `bu_mu`, `bu_B`, `bu_ct` | Porosity (fraction); viscosity; Formation volume factor (res/std); total compressibility | —; `viscosity`; —; `compressibility` | 0.15; 1.0; 1.2; 1.2e-5 | 0.01–0.5; 0.01–1,000; 0.5–5; 1e-7–1e-3 (validated) |
| `bu_pb`, `bu_rs` | Bubble point; solution GOR | `pressure`; `gor` | blank | validated when given |
| `bu_sg`, `bu_tres`, `bu_co2`, `bu_h2s`, `bu_n2`, `bu_ptime`, `bu_pdew`, `bu_api`, `bu_mo` | Gas SG; reservoir T; CO2, H2S, N2 (mol %); pseudo-time; dew point; condensate API; condensate molecular weight | —; `temperature`; `percent` ×3; checkbox; `pressure`; —; — | 0.65; 200 °F; 0; off; blank; blank; blank | Shown for gas |
| `bu_bw`, `bu_muw` | Water formation volume factor (res/std); water viscosity | —; `viscosity` | 1.02; 0.5 | Shown for injectors |
| `bu_alloc_acc`, `bu_drift` | Allocation accuracy (%); gauge drift | `percent`; `pressurePerDay` (new) | 5; 0.01 | 0.5–50; 0–10 |
| `bu_sr_h`, `bu_sr_phi`, `bu_sr_ct`, `bu_sr_rw`, `bu_sr_B`, `bu_sr_mu`, `bu_sr_q` | Typical uncertainty (%) | `percent` | 20, 10, 30, 5, 5, 20, 10 | 0–100; Advanced |
| `bu_well_prism` | Copy from PRiSM well inputs | button | | Reads `PRiSM_getWell()` (allowed here: user action, read only) |
| `bu_dep_on`, `bu_dep_g`, `bu_dep_d`, `bu_dep_grad`, `bu_dep_gradf` | Depth correction; gauge TVD; datum TVD; static gradient; flowing gradient | checkbox; `length` ×2; `pressureGradient` ×2 | off | Gradient 0.01–0.6 (validated) |
| `bu_cmp_on`, `bu_cmp_hp`, `bu_cmp_htop`, `bu_cmp_theta`, `bu_cmp_kvlo`, `bu_cmp_kvhi` | Completion data; open interval; top of reservoir to top of interval; deviation (°); kv/kh low, high | checkbox; `length` ×2; —; — ×2 | off; h; 0; 0; 0.1; 1 | θ 0–75 (validity) |
| `bu_cmp_perf`, `bu_cmp_spf`, `bu_cmp_lp`, `bu_cmp_rp`, `bu_cmp_phase` | Perforation data; shots per foot; length; radius; phasing | checkbox; —; `lengthSmall` ×2; select 0/180/120/90/60/45 | off; 4; 12 in; 0.2 in; 90 | Hidden when the coefficients are unverified (§11 Q7) |
| `bu_wo` | Workover / stimulation dates | text, `data-no-decimal-comma` | — | "YYYY-MM-DD, …" |
| `bu_adv` | Show advanced settings | checkbox | off | Hidden values are echoed in S2 "Settings used" |
| `bu_d_win`, `bu_d_rise`, `bu_d_sig`, `bu_d_persist`, `bu_d_mindur`, `bu_d_gapn`, `bu_d_spike`, `bu_d_partial` | Detection window (min); minimum rise; rise in σ; persistence (min); minimum duration (h); gap (samples); spikes; classify partial cuts | numbers (`pressure` for the rise); select off / flag / filter; checkbox | 5; 5; 10; 30; 2; 5; off; on | 1–60; 0.5–500; 2–50; 5–240; 0.5–48; 2–50 (clamped). Partial cuts off: steps that would be partial cuts are listed as substeps only and the rate history keeps the allocated rate |
| `bu_i_L`, `bu_i_band`, `bu_i_slope`, `bu_i_mincyc`, `bu_i_rivals`, `bu_i_cheld`, `bu_i_kheld`, `bu_i_tide` | Bourdet L (cycle); IARF band (%); slope; minimum cycles; rival models; C-held refits; k-held fits; tide removal | numbers; selects auto / none / all, auto / off / extended, auto / off, auto / off | 0.1; 10; 0.03; 0.5; auto; auto; auto; auto | 0.05–0.3; 5–25; 0.01–0.1; 0.3–1 (clamped) |
| `bu_t_base`, `bu_t_delta`, `bu_t_abs`, `bu_t_basevar`, `bu_t_confirm`, `bu_t_enabled`, `bu_t_price` | Baseline tests; delta alert; absolute alert; include baseline uncertainty; confirmation; trend and alerts; value per unit volume (optional, any currency) | numbers; checkbox; select next test / immediate; select auto / on / off; `pricePerVolume` (new) | 3; 2; 5; per file 55; next; auto; blank | 1–5; 0.5–10; 0–50; ≥ 0 |
| `bu_rep_detail` | Test detail in the report | select selected test / all tests (up to 12) | selected | |
| `bu_run`, `bu_cancel`, `bu_progress`, `bu_stale` | Analyse; Cancel; progress; stale banner | buttons; div role=status aria-live=polite; verdict div | | Cancel is disabled unless an analysis is running |
| `bu_test_sel` | Test shown in detail | select (options rendered from the stored analysis before the host restore) | latest | Display only (no stale marking) |
| `bu_qa_q`, `bu_qa_go`, `bu_qa_out` | Ask about the analysis; Ask; answers | text (`data-no-persist`, `data-no-decimal-comma`, ≤ 300 chars); button; div | | |
| `bu_so_name`, `bu_so_role`, `bu_so_ok`, `bu_so_sign`, `bu_so_unsign` | Signed by; role; statement; Sign off; Withdraw sign-off | text ×2 (`data-no-decimal-comma`); checkbox (`data-no-persist`); buttons | | Withdraw is disabled unless signed |
| `bu_val_run`, `bu_val_out` | Re-run 24-case check; result | button; div | | Asynchronous |
| `bu_ai_deid`, `bu_ai_free`, `bu_ai_copy`, `bu_ai_dl` | De-identify; include free text (notes, reasons, file and tag names); Copy for your AI assistant; Download | checkbox (on); checkbox (off); buttons | | No network; buttons disabled until an analysis exists |
| `bu_open_prism` | Open this build-up in PRiSM | button | | Disabled until an analysis exists; confirm first (§6.10) |
| Dialog: `bu_dlg_title`, `bu_dlg_body`, `bu_dlg_act`, `bu_dlg_t0`, `bu_dlg_t1`, `bu_dlg_model`, `bu_dlg_reason`, `bu_dlg_ok`, `bu_dlg_cancel` | Action / override / decision form | Inside `<dialog data-no-persist data-rp-nosnap>` | | A reason of at least 5 characters is required for overrides and rejections |

Each S4 row and each S9 rule group has **one** `rp-skip` button "Actions…" (`data-act="menu"`, `data-test` / `data-f`, no id). It opens the
dialog with `bu_dlg_act` offering the choices for that row (Exclude / Include / Edit IARF window / Force model, or Accept / Reject / Note).
The results live in the audit store, not in id'd controls.

### 6.3 Results blocks and charts

The page renders `review.report(..., _uFmt)` into `#bu_res`: one `.rbox` with an `.rbox-title` per Section, `.rrow` `.rl`/`.rv` for `kv`,
`.kpi` for `kpi`, `table.dtable` for `table`, verdict divs with inline `style="color:var(--green|yellow|red)"`, and
`<div><b>{head}</b> …</div>` for `notes`. Charts are placed at their `chart` blocks and drawn one per yielded unit after the text:

| Canvas | Section | Content | Renderer |
|---|---|---|---|
| `bu_ch_rate` | S3 | Pressure (left) and allocated rate (right, scaled) against days; events marked | `drawLineChart` |
| `bu_ch_ll` (`bu_ch_ll_B3` … in "all tests" mode, up to 12) | S4 detail | Log-log Δp and Δp′ bins (masked), the IARF band shaded, homogeneous and chosen model curves, negative-derivative markers | `plot.loglog` |
| `bu_ch_sl` (`bu_ch_sl_B3` …) | S4 detail | Δp against the superposition function H with the line and its window | `drawLineChart` |
| `bu_ch_ov` | S5 | Rate-normalised overlay Δp/q and Δp′/q of all used tests (the same plateau means the same k) | `plot.overlay` |
| `bu_ch_skin` | S5 | S ± S_err against days; baseline; baseline + Δ; absolute threshold; hinge fit; Theil–Sen line; dashed forecast; excluded low tests as hollow markers | `plot.trend` |
| `bu_ch_k` | S5 | k against days with the median ± allocation-accuracy band | `plot.trend` |
| `bu_ch_pi` | S5 | Datum p_ext against days with the Theil–Sen line (p* range bars when the history is estimated) | `plot.trend` |
| `bu_ch_J` | S5 | Daily J_obs and J_pred | `plot.trend` |
| `bu_ch_pwf` | S5 | Sandface pwf at closing (range) against Pb (oil producers only) | `plot.trend` |

Canvas size comes from the `#bu_root` width: 720×300, or 600×400 below 600 px, so chart text stays legible on phones.

### 6.4 Overrides and the dialog

- **Kinds:**
  - `exclude` / `include` (a test);
  - `window` (dt0, dt1 on the log axis, pre-filled with the automatic window);
  - `model` (one of the four keys);
  - `event_add` (from the M§A5 list or a typed time);
  - `event_drop`;
  - `tc` (a typed closing time).
- Each override needs `bu_eng` (or prompts for a name) and a reason of at least 5 characters. It is appended to `wts_buildup_audit`,
  sets the results stale, and is applied at the next Analyse, which re-runs only the affected tests and stages 2–5.
- **Edited inputs** are recorded once, at the next Analyse: one audit entry `kind:'input'` with the field diff against the previous run's
  inputs and an optional reason (the Analyse button prompts for one after a sign-off). No entry is written per keystroke.
- Removing an override is itself an audit entry. Overrides show in the S4 table's "Override" column and in S10.
- Closing the dialog (OK, Cancel or Esc) returns focus to the "Actions…" button that opened it.

### 6.5 Behaviour

- **Module load.** A guarded IIFE registers the unit categories with the merge-if-absent pattern when `WTS_units` exists (the cheminj
  `_cats` pattern), so a Metric first paint already has them:
  - `pressureGradient` psi/ft → kPa/m (22.6206, the constant 49-calc-gaslift.js uses; only if absent);
  - `wbStorage` bbl/psi → m³/kPa (0.0230592);
  - `pseudoPressure` psi²/cp → kPa²/(mPa·s) (47.5377);
  - `pressurePerDay` psi/d → kPa/d (6.894757);
  - `pricePerVolume` per bbl → per m³ (6.28981);
  - `gasPI` Mscf/d/psi → Sm³/d/kPa (4.10697).
- **render(body).**
  1. Paint `#bu_root` with the static Notes boxes.
  2. Tag inputs.
  3. Attach listeners to `#bu_root` only.
  4. Load `wts_buildup_state` and render the stored results synchronously, with `bu_test_sel` options, so the host restore finds them.
  5. If not restored by the host: call `window.calcBuildup()`.
- **No analysis at open.** Opening is cheap (no parse, no fit), so the a11y `flush(400)` and v3-ux `flush(50)` route sweeps are safe.
- **Analyse** (`bu_run`).
  1. Validate the physical inputs (§6.2); on failure show the ✗ verdict and stop.
  2. Gather everything inside `WTS_units.runCanonical` into a plain `AnalysisInput`; resolve the zones if not yet resolved.
  3. Capture `wellId = WTS_wells.active() || 'default'` and a new `runToken`.
  4. Write "Analysing… 0 %" into `bu_progress` **immediately** (GUI-sweep `settleMs` = 300 ms) and enable Cancel.
  5. Store a changed raw record under the captured `wellId` (`store.putRaw`, then `store.encodeJob` through `drive`).
  6. `run.analyseAsync(input, {cache, shouldCancel, onProgress})`.
  7. On completion, **discard** the result if `WTS_wells.active() !== wellId` or the token changed.
  8. Otherwise: review, report model, render (charts in yielded units), `data-done="1"`, save state, the audit entries ("run", and "input"
     when inputs changed), `WTS_state.buildup`, `WTS_pageAutosave.flush()`, `wts:buildup-updated`, `window.WTS_snapshotNow()` (falls back to
     dispatching a bubbling `change` from `#bu_res` when the hook is missing), then move focus to the S1 title and announce "Analysis
     complete" in `bu_progress`.
- **Errors** become a ✗ verdict with plain text. Partial results (some tests failed) still render, with those tests marked "failed".
- **Stale marking.** Any input or change inside `#bu_root`, outside the dialog and the display-only controls (`bu_test_sel`,
  `bu_rep_detail`, `bu_qa_*`, `bu_ai_*`), compares `run.inputHash` (canonical imperial values to 6 significant figures, so a Metric/Imperial
  round trip changes nothing) with the stored one. On a difference it shows `bu_stale` ("⚠ Inputs changed since the last analysis — press
  Analyse"), adds `.bu-stale` (dimmed) to `#bu_res`, sets `#pgSub` to "· DRAFT (stale)", and calls `WTS_snapshotNow()`. The stale banner is
  captured in reports on purpose (registry pages get no host stale marking).
- **Cancel** sets a flag. The driver rejects at the next yield and the page shows "Cancelled — previous results kept". No timer remains.
- **Navigation away** detaches `#bu_root` (`isConnected` false), so the driver stops. `wts:well-changed`, `wts:project-loaded` and
  `wts:project-new` also cancel a running analysis.
- After an override is applied, a sign-off or a withdrawal, the page re-renders, publishes `WTS_state.buildup`, flushes the autosave and
  calls `WTS_snapshotNow()` again.

### 6.6 Report capture and Quick Report

- PDF and PNG: `collectPageReport` walks `#bu_res` (sections S1–S12 in order), the cards (inputs) and the canvases.
  - Notes ≤ 600 characters each; verdicts < 300 characters; tables ≤ 30 rows. S3's day table shows ±2 days around each event only. S4
    shows the latest 30 tests plus one "n older tests" row. S9 groups findings by rule (one row per rule, with the tests it concerns). The
    confidence reasons are a table, and the verdict line stays short.
  - Everything in `innerHTML` is either computed numbers and fixed strings, or **escaped** text: file names, tag names, reasons,
    names, questions.
- **Quick Report** snapshots are text only (`charts:false`), so every chart has a text equivalent in the same section (a table or rows).
  The host takes its snapshot 900 ms after a click in `#pgBody`, which is during the analysis; the page therefore calls
  `window.WTS_snapshotNow()` (host hook, §2.5) after every render that changes results (analysis, override applied, sign-off,
  withdrawal, stale toggle).
- **Template** (host `RT_BUILTIN`, WP6): final only, `{ type:'pages', heading:'Build-up surveillance', pages:['buildup'],
  detail:'results' }` inserted right after the `prism` section. The daily template is unchanged (D21).

### 6.7 Units and Metric mode

- **Inputs** are tagged (§6.2 categories) and read as imperial inside `window.calcBuildup` / `runCanonical`.
- **Results.** Every number in the report model is a structured `Value {v, cat, dp, ref}` (§3.10), formatted at render time with
  `_uFmt` (metric value first in Metric mode). That covers k (`permeability`), kh (`permThickness`), C (`wbStorage`), pressures and Δp
  (`pressure`), p* and p_ext (`pressure`), r_inv and distances (`length`), J (`productivityIndex` for oil and water, `gasPI` for gas),
  rates (`liquidRate` for STB/d and bbl/d / `gasRateSmall`), cumulative (`volume` / `gasVolume`), pressure trend (`pressurePerDay` ×30,
  labelled "per 30 d"), value (`pricePerVolume`) and m(p) (`pseudoPressure`). Skin, ΔBIC, cycles and labels stay untagged. Findings, Q&A
  answers and the AI export use the same formatter, so they convert too.
- **Charts.** Series values are converted with `WTS_units.convertCategory` before drawing, and axis labels come from `WTS_units.format`.
- **Labels.** No unit text in labels that the GUI-sweep Metric regex flags (for example "Formation volume factor (res/std)", "Value per
  unit volume"); the injector rate unit is bbl/d.
- The GUI-sweep Metric pass checks that no psi, ft, md, bbl or STB labels remain in labels, titles, `.rrow`, table cells or canvas text.
- The PRiSM field-units note does **not** apply to this page.

### 6.8 Autosave, project file, multi-well

- **Autosave.** Every id'd control saves to `wts_page_buildup`, except `data-no-persist` areas (pastes, column maps, the dialog, the
  Q&A box, the statement checkbox).
- **State.** Analysis state, the audit trail and the sign-off live in `wts_buildup_state` (≤ 300 kB) and `wts_buildup_audit` (≤ 200 kB)
  (§3.12), written through `WTS_lsSet`. They are well-scoped automatically and carried in project files by the `storage` module. The
  overflow `tests` store travels in the `buildup_analysis` module. Budgeting matters because a well switch parks the active well as a blob
  while its keys still exist (a 2× footprint) and refuses on quota.
- **Raw data.** In IndexedDB, keyed by well, plus the project module `buildup_raw` (≤ 16 MB), used only when its hash matches
  `analysis.record.hash`. The page says "raw gauge data not embedded for wells A, B — re-import to re-run detection; interpretation and
  trend reproduce from the stored build-ups".
- **Well switch.** On `wts:well-changed`, cancel any running analysis, re-render from the new well's keys and load its raw record and
  overflow tests from IndexedDB.
- **Comparison page.** It gets four rows through `29-multiwell.js` (§2.5). `WTS_state.buildup` is published on open and after every run,
  and `WTS_pageAutosave.flush()` fires `wts:autosaved`, which refreshes `wts_mw_results`.

### 6.9 Phones, iOS, accessibility, GUI sweep

- **Phones (390 px).** Cards stack. The wide S4 and S9 tables carry `data-no-stack` and scroll inside their `.rbox`; the other tables are
  stacked by calling `window.WTS_stackTables(#bu_res)` after each asynchronous render. Each table row has one "Actions…" button. Canvases
  use the 600×400 size and are 100 % wide. The jump nav wraps and the dialog is full-width. On completion focus moves to S1, so the
  results are not far below the Analyse button.
- **Touch.** `#bu_root canvas { touch-action: pan-y; }` in the page CSS, on every platform: these charts have no pointer interaction,
  and this undoes the app-wide `touch-action:none` so the page scrolls.
- **iOS.** 16 px controls come from the global rule (no inline `!important` font sizes). The dialog copies the cheminj two-part
  safe-area pattern (§2.5), with `box-sizing:border-box`, a `100vh` fallback before `100dvh`, and 44 px controls including the close ×.
- **Accessibility.**
  - Every control has a `<label>` (`.fg-item`) or an `aria-label`. Canvases have `role="img"` and an `aria-label` summary.
  - `bu_progress` is `aria-live=polite`.
  - The dialog has `aria-labelledby`, Esc closes it, and focus returns to the invoking button.
- **GUI sweep.**
  - Settings are clamped, physical inputs validated, select options are all valid, and no UI text contains "null" or "undefined".
  - Analyse changes the DOM at once. Controls that only act on a running analysis or an existing result are disabled when idle, so the
    sweep does not report "no visible effect".
  - The file inputs accept the sweep's elapsed-hours CSV: it is parsed, and rate-table mode is proposed because the file has a rate column.

### 6.10 Open in PRiSM (`bu_open_prism`, user action only)

1. `confirm('This replaces the PRiSM dataset and well inputs with build-up B3 and its rate history. Continue?')`. Stop if declined.
2. Build a decimated CSV `t_hr, p_psia` (≤ 3,000 rows):
   - the flowing record at one point per 15 min over the last 10·Δt_end;
   - the build-up bins at 20 per cycle;
   - time zero = the first kept sample.
3. Call `PRiSM_openExternalBuildup({ds, pasteText, multiRate: compacted steps on the dataset clock (negative t allowed), well:{q, B, mu,
   ct, h, phi, rw, fluid, testType}, tShut, pwf0, modelKey, fitC4})`. The function (33, WP1) owns every PRiSM write:
   - a read-modify-write of `localStorage.wts_prism` with `.prism_data_paste` set to `pasteText` (the reload trap: PRiSM re-reads the
     paste box after a reload);
   - the multi-rate table persisted (`wts_prism_mrate`, `PRiSM.multiRate`);
   - `PRiSM_setWell(…, {source:'user'})` with C1 values: `water_inj` becomes `fluid:'water'` with `testType:'falloff'` and the injection
     rate sign C1 uses for fall-offs;
   - `PRiSM_commitDataset(ds, {source:'buildup'})`;
   - `st.activePeriod` = the `PRiSM_rateHistory(ds)` period that contains `tShut`;
   - model adoption before the fit (C4): `st.model`, `st.params`, `st.phys` from `fitC4`, mapping `composite2` → `radialComposite`
     (M, F = 1, R in r_w) and keeping `closedCircle` (registered); then `PRiSM_setLastFit(fitC4)`;
   - `PRiSM_saveState()`; returns `{ok, period}`.
4. `WTS_nav('prism')`, then `PRiSM_gotoStep(3)`.

WP1's EN21 reloads the app and checks that PRiSM still shows the build-up period, the multi-rate table and the adopted model. WP6's PG12
only checks that the button calls the function with the right arguments.

### 6.11 PRiSM Skin-check card (WP7)

- **Placement.** Tab-6 panel `{id:'prism_skincheck', title:'Skin check: IARF window, line vs match, uncertainty, confidence', order:8,
  when: a fit or a semilog result exists and mode ≠ decline, render}`. Tools drawer: `window.PRiSM_renderSkinCheckPanel`
  (auto-discovered under "More"; no `TOOL_CATALOGUE` edit). Report: a `PRiSM_reportSections` entry (order 45).
- **Inputs.** `PRiSM_getAnalysisData()` (PRiSM's own settings belong here), `PRiSM_getLastFit()` and `PRiSM_getWell()`. The rate is the
  user's entered or tabled rate, so `rateQC.r3Status = 'n/a'` and KC4 does not apply.
  Completion inputs sit in the card and are saved in `wts_prism_skincheck` (small, well-scoped; PRiSM is skipped by page autosave).
- **Shown.**
  - the automatic IARF window at L = 0.1 cycle (grade, cycles, level, and the longest qualifying window);
  - the line through that window;
  - the line vs **match** (`DEFAULTS.agree`) and the line vs derivative plateau (34, labelled separately);
  - S_err with its composition (including S_pwf when PRiSM's pwf0 is a trend value); the analytic sensitivity table;
  - the confidence labels, with the note "calibrated on build-ups; indicative for drawdowns";
  - Δp_skin, FE, PI ratio;
  - mechanical skin (both bases) with the kv/kh range;
  - expected IARF reach (numeric, from the fitted model).
- **Buttons.** "Run C-held refits" (asynchronous via `drive`, progress, cancel) and "Use this window in the straight-line panel"
  (calls `PRiSM_semilogAnalysis(null, null, {window, store:true})`; a user action, so the C7 write and event are allowed).
- **No writes on render.** Listens to `prism:fit-updated`, `prism:period-changed`, `prism:well-changed` and `prism:dataset-loaded` only
  while mounted, and re-renders only the cheap parts.

---

## 7. Automated rule-based review, Q&A and AI export (WP5)

### 7.1 Decision (recorded)

The review required by requirement §10 is **offline and deterministic** and is labelled in the UI "Automated rule-based review". It has
three layers:
- an **evidence check** that re-reads every quoted number from the analysis and recomputes derived quantities with the review's own
  formula registry (it catches transcription and rounding errors, not engine logic errors);
- **re-derivation rules** (V23–V27) written in the review file with no calls into the engine files (53, 54, run, trend): they recompute
  key results from more primitive stored data and raise a major finding when they disagree;
- the plausibility rules V1–V22.

The report states this scope plainly: the review is independent of the report text and partly of the engine, not of the physics model.
A Q&A engine answers only from the analysis and cites evidence ids. The app makes **no network calls and holds no API keys**. For
engineers who want a second opinion from an AI assistant, **"Copy for your AI assistant"** puts a de-identified, structured summary and a
built-in review prompt on the clipboard (or downloads it as a .txt). The engineer decides where to paste it, outside the app. Reasons:
the app is offline and runs on iOS; reproducibility; no data leaves the device without an explicit user action.

### 7.2 Review rules (`review.RULES`)

| Id | Rule | Severity | Where | Evidence |
|---|---|---|---|---|
| V1 | Sandface pwf at closing below Pb on an interpreted test | major | S5 | T12 |
| V2 | p_ext below Pb (only when the pressure trend is assessable; with an estimated history an info line quotes the p* range against Pb instead) | critical | S5 | T12, Bn·L1 |
| V3 | Gas: expected D·q at the test rates > 0.5 and D not resolved | major | S5 | T15 |
| V4 | Water cut > 5 % or GOR > 1.2·Rs with an oil-only rate basis, or two-phase ct flagged | major | S3 | R7 |
| V5 | Confirmed delta alert with stable k → stimulation-candidate review | suggestion | S7 | T2, T9 |
| V6 | CV_k > max(5 %, allocation accuracy) | major | S5 | T9 |
| V7 | Allocation inconsistent, or the check `unavailable`, on a test used for an alert (`n/a` does not fire) | critical | S3 | Bn·R3, Bn·R4, T2 |
| V8 | Baseline unstable or provisional | major | S5 | T1 |
| V9 | Expected IARF reach > Δt_e,end on most tests → recommend a shut-in of at least X h (numeric reach) | suggestion | S7 | Bn·W4 |
| V10 | r_tide > 0.10 (not removed) or r_drift > 0.05 | minor | S2 | Q5, Q6 |
| V11 | R_J outside 0.8–1.25 in any interval | major | S5 | T13 |
| V12 | Skin rise correlates with rate (gas) or with Pb − pwf (oil), ρ ≥ 0.7 | major | S5 | T12, T15 |
| V13 | Any of h, μ, B, φ, ct, rw defaulted | minor | S6 | U2 |
| V14 | A quoted number differs from the analysis (evidence check). **Cannot be accepted**: a re-run is required | critical | any | — |
| V15 | History estimated and sensitive on a used test | major | S4 | Bn·R5 |
| V16 | Offset scan prefers another gauge/production-day offset | major | S3 | R3 |
| V17 | Partial-cut suspicion on an interpreted test | major | S4 | Bn·R1, Bn·I3 |
| V18 | Closed-circle model without depletion in the pressure trend (only when depletion can be assessed) | minor | S4 | Bn·M6, T10 |
| V19 | Boundary call depends on the background trend | major | S4 | Bn·M7 |
| V20 | IARF level inconsistent with the baseline kh (the window may sit on a later plateau) | major | S4 | Bn·I3, T9 |
| V21 | Test outside the calibration envelope, or labels not calibrated | minor | S12 | Bn·K1 |
| V22 | An override changed a test used for an alert | minor | S10 | On, T2 |
| V23 | Re-derived k = 70.6·Δq·B·μ/(m′·h) from the stored IARF level differs from the final k by more than 5 % plus the explained bias | major | S4 | Bn·I3, Bn·A2 |
| V24 | Re-derived S = the mean point skin over the stored window differs from the final S by more than max(0.5, S_err) | major | S4 | Bn·I4, Bn·A2 |
| V25 | Re-derived Δq from the allocation rows and the detected hours differs from the Δq used by more than 15 % plus the volume resolution (allocation mode only) | major | S3 | Bn·R1, Bn·R2 |
| V26 | The model choice re-evaluated from the stored BIC table with τ (rounded per D27) differs from the chosen model | major | S4 | Bn·M4, Bn·M6 |
| V27 | The alert status recomputed from the stored series and thresholds differs from the reported status | major | S5 | T2, T3 |

Each finding is a fixed template filled only from evidence values, for example
"B5 is used for the delta alert but its allocation check failed (r = {r} on {date}) [B5·R3, T2]."

### 7.3 Evidence check

- Every quoted value is a `Value` with its `ref` (an evidence id plus a value name).
- `check()` re-reads the value from the analysis path and, for derived quantities, recomputes it with the review's own formula registry
  (`review.FORMULAS`) from the **full-precision stored values**: Δp_skin = 0.8686·m·S with m = 162.6·Δq·B·μ/(k·h); PI ratio = X/(X + S);
  dkPct from k ranges; rate at stake; r_inv.
- It compares at display precision: |round(quoted) − round(recomputed)| ≤ half a unit in the last displayed digit, so rounding of displayed
  inputs cannot raise a false failure.
- It runs on the Review and on the ReportModel. Any failure adds a V14 critical finding (not acceptable) and blocks sign-off until a
  re-run clears it.
- It also runs on every Answer, but a failing answer is marked on the answer itself ("this answer failed its evidence check; the numbers
  are withheld") and never adds a finding to the review, so a Q&A template bug cannot block sign-off.

### 7.4 Q&A intents (`review.INTENTS`; deterministic keyword and entity matching)

- Text is normalised to lower case with punctuation stripped.
- Synonym map: thickness → h, permeability → k, porosity → phi, and so on.
- Entities (all with the `g` flag, read with `matchAll`):
  - tests `/\b(?:b|test|build-?up)\s*#?(\d+)\b/g` (so "compare B2 and B5" finds both);
  - percentages `/([+-]?\d+(?:\.\d+)?)\s*%/g`;
  - directions higher / lower / increase / decrease;
  - dates; thresholds.
- Highest score wins; ties go to table order.

| Intent | Example | Answer built from |
|---|---|---|
| why_model | "why this model?", "why not a fault for B4?" | Bn·M2, M4, M5, M6 (triggers, ΔBIC table, fully-seen status) |
| why_conf | "why is confidence medium?" | Bn·K1 reasons with their evidence |
| whatif_input | "what if h is 20 % higher?" | Analytic sensitivity for every used test plus a trend re-run with the shifted S (synchronous, cheap); states the alert impact |
| onset | "when did skin start rising?" | T4 (hinge, interval, CUSUM) |
| alert | "is there an alert?" | T2, T3, T16 (status, raised/confirmed tests, robustness, excluded tests) |
| value | "what is k for B3?" | Bn·A2 (final k, S, C, p*, p_ext with S_err) |
| compare | "compare B2 and B5" | Bn final values, T11 model-free ΔS |
| excluded | "why was B4 excluded?" | status reason, overrides On |
| shutin_length | "how long should the shut-in be?" | Bn·W4 reach (fair, good, in shut-in hours) |
| stake | "how much production is at stake?" | T8 (both cases, assumptions, bound labels) |
| kstable | "is k stable?" | T9 and its interpretation |
| serr | "why is the skin uncertainty large?" | Bn·U1 driver and terms |
| line_vs_match | "why do line and match disagree for B6?" | Bn·A1 and the bias explanation |
| bubble | "is pwf below the bubble point?" | T12 |
| forecast | "when will skin cross 5?" | T6 with its range, or the reason it is not shown |
| mech | "what is the mechanical skin?" | T14 and the parts |
| depletion | "is the reservoir depleting?" | T10 (with the drift caveat, or "cannot be assessed") |
| missed | "could we have missed shut-ins?" | D1 / missed list |
| help | anything else | The list of supported questions with examples; quotes no numbers |

Every answer passes the evidence check. `grounded:'none'` is used only by `help`.

### 7.5 AI export (`review.aiExport`)

- **Content.**
  - A header with the app version and the signature status.
  - A de-identified summary: well name → "Well A"; no engineer or client names; dates → day numbers unless `includeDates`.
  - The inputs table, the per-test table (k, S ± S_err, C, model, ΔBIC, labels and reason rule ids), the trend and alerts, the findings with
    their decisions (decision codes only), the evidence ids, and the built-in prompt.
  - **Free text is dropped by default**: decision notes, override reasons, gauge file and tag names, and question text can carry names
    and dates. The `bu_ai_free` checkbox (off) includes them.
  - The prompt asks the assistant to check consistency and physical plausibility, to cite evidence ids for each point, and to say what
    extra data would change the conclusions.
- **Delivery.** `navigator.clipboard.writeText` with a download fallback. The text contains no URL. A WP5 test asserts that no well name,
  engineer name, file name, reason text or date string appears when `deidentify` is on and `includeFreeText` is off.

---

## 8. Traceable report

### 8.1 Evidence reference scheme

| Group | Items (B-prefixed when per test) |
|---|---|
| Q data quality | Q1 σ (σ_shut, σ_flow), Q2 sampling, Q3 gaps, Q4 spikes, Q5 drift index, Q6 tide index, Q7 temperature, Q8 depth correction |
| D detection | D1 rise / missed list, D2 t_c and δt_c, D3 pwf0 and its standard error, D4 gap at closing, D5 duration, D6 allocation confirmation and f̂ |
| R rates | R1 Δq (source, partial-cut suspicion), R2 flowing hours, R3 allocation consistency (and offset scan), R4 pressure-based rate check, R5 rate history (and history start and sensitivity), R6 hours-on agreement, R7 phase basis |
| W storage | W1 unit slope, W2 C, W3 hump time, W4 expected IARF reach |
| I IARF | I1 window and grade (and the longest qualifying window), I2 end slope, I3 level m′, I4 point-skin spread, I5 derivative SNR, I6 second level |
| L line | L1 k, S, p* (and the p* range), L2 window, L3 line vs derivative plateau |
| M model | M1 homogeneous fit, M2 triggers, M3 rival fits, M4 BIC table, M5 fully-seen flags, M6 chosen model, M7 anomaly flags and background check, M8 k-held fit |
| A agreement | A1 line vs match, A2 final values and their source |
| C C-held | C1 refits and allowed range |
| U uncertainty | U1 S_err composition, U2 sensitivity, U3 dominant inputs |
| K confidence | K1 k/S label and reasons, K2 model and headline labels |
| T trend | T1 baseline, T2 delta alert, T3 absolute alert, T4 onset, T5 recent trend, T6 crossing date, T7 Δp across the skin, T8 PI ratio and production at stake, T9 k stability, T10 pressure trend, T11 model-free skin change, T12 bubble point, T13 PI cross-check, T14 mechanical skin, T15 rate-dependent skin, T16 tests excluded as low |
| V review | V1–V27 (§7.2) |
| O overrides | O1… (audit entries) |

A statement cites as "S = 7.9 ± 0.4 (high) [B6·A2, B6·U1, B6·K1]". The renderer appends the refs to `.rv` text and to an "Ev." column in
tables.

### 8.2 Sections (ReportModel → `#bu_res`)

| Id | Title | Blocks |
|---|---|---|
| S1 | Summary | kpi (latest S ± S_err, baseline, ΔS, k median, labels, onset, forecast); verdicts (delta alert, absolute alert, **DRAFT / signed**); notes "Assessment" |
| S2 | Data and quality | kv Q1–Q8, resolved zones and "Settings used" (echo of the advanced and clamped values); verdicts |
| S3 | Events and rates | table of events (id, time, kind, status, duration, Δq and its source, pwf0, allocation check, note); table of days around events; chart `bu_ch_rate`; notes "Notes" (what could have been missed) |
| S4 | Build-up tests | table of the latest 30 tests plus an "n older tests" row (id, date, Δt_end, Δq, IARF grade and cycles, k, S ± S_err, C, model and ΔBIC, agree, labels, used, override, Actions…); per selected test (or up to 12 tests): kv (window, longest window, line, final, p* and range, p_ext, r_inv, fully seen, reach), table of models / BIC, table of confidence reasons, charts `bu_ch_ll` and `bu_ch_sl`, notes "Interpretation" |
| S5 | Trend and alerts | charts `bu_ch_skin`, `bu_ch_k`, `bu_ch_pi`, `bu_ch_J`, `bu_ch_pwf`, `bu_ch_ov`; kv T1–T16 ("N low tests excluded, S a–b"); verdicts; table of alert robustness |
| S6 | Uncertainty | table of S_err composition per test (mode, floor, se, line–match, window, t_c, pwf0, k-held S_k, C-held range, S_sens); kv dominant inputs (requirement ranges and typical ranges, each labelled); notes "Assessment" ("a uniform input error shifts every skin equally …"; "total skin = mechanical + pseudo-skins …") |
| S7 | Recommendations | up to 6 notes "Recommendations" (≤ 600 characters each) with evidence |
| S8 | Limitations | notes "Notes" (fixed list plus case items) |
| S9 | Automated rule-based review | table of findings grouped by rule (rule, severity, where, finding, tests, evidence, check, decision, Actions…); verdict counts; evidence-check verdict; a note on the review's scope (§7.1) |
| S10 | Audit trail and reproducibility | table of the audit entries (latest 30); kv app version, run date, resolved zones, inputs, results and decisions hashes, chain hash; notes "Notes" (reproducibility statement) |
| S11 | Sign-off | verdict "⚠ DRAFT — not signed off (2 major findings open)" or "✓ Signed off by … (role) on … · hash 1a2b…"; kv; info line "signed with vX; re-run to verify" when the app version differs |
| S12 | Confidence calibration | both tables from file 55 (label, n, rate, interval); in-app check result; notes "Notes" |

### 8.3 DRAFT and sign-off

- `status` is DRAFT until `review.signoff` succeeds. Sign-off needs `bu_so_name`, the `bu_so_ok` statement ("I have reviewed the
  analysis and the findings"), and `canSign` (no open critical or major finding, a note on every rejection, and no V14 finding).
- On success: an audit entry `signoff` with the hashes, `#pgSub` "· Signed off <date>", and an S11 ✓ verdict.
- **Changed after sign-off** is decided on `inputsHash`, `resultsHash` and `decisionsHash` only. When any of them differs from the signed
  values, the status becomes `CHANGED` (shown as DRAFT, with the banner "changed after sign-off on <date>") and one audit entry
  `changed_after_signoff` is added per transition (not per edit). Pressing Analyse again with identical inputs, updating the app, or a
  Metric/Imperial round trip leaves the status SIGNED. `runAt` and `appVersion` are shown with the signature; a different app version adds
  the info line "signed with vX; re-run to verify".
- Withdrawing (`bu_so_unsign`) requires a reason.
- The hash checks integrity; it does not authenticate the signer. The report says so.

### 8.4 Hashes and signature

- `canon` (53) sorts keys and rounds numbers. Mode `inputs`: 6 significant figures. Mode `display`: k 3 significant figures; S and
  S_err 2 dp; C 3 significant figures; pressures 1 dp; distances 0 dp; times 3 dp (h) or whole seconds (epoch); rates 1 dp;
  percentages 1 dp; ΔBIC 1 dp.
- **inputsHash** = `hash16(canon(…, 'inputs'))` over well, completion, depth, settings, the resolved zones, history, allocation rows, the
  record hash, the events (t_c rounded to 1 s) and the overrides.
- **resultsHash** = `hash16(canon(…, 'display'))` over each test's final values, S_err and labels, plus the trend alerts, onset and recent
  slope.
- **decisionsHash** = `hash16(canon(…, 'display'))` over the review decisions.
- The signature is `sha256(canon({inputsHash, resultsHash, decisionsHash, name, role, at}, 'display'))`; `runAt` and `appVersion` are
  recorded next to it but are not hashed. The report shows the first 16 hex characters and the full value.

### 8.5 Overrides audit trail

Append-only `wts_buildup_audit` entries (§3.12): who, when (ISO), kind, target, value, reason, app version, hashes and a chain hash.
Entries are never edited. Removing an override adds an entry. Beyond 500 entries, the oldest are folded into one separate summary record
that keeps their chain hash, so the chain still verifies and the folded entries are counted. S10 lists the latest entries, and the review
rule V22 highlights overrides on alert tests.

### 8.6 Reproducibility statement (S10 notes)

"Reproducible: opening this project in Well Testing Suite {RELEASE_NOTES[0].ver} and pressing Analyse gives the same displayed numbers
(inputs {hash8}, results {hash8}). Times are read in {gauge zone} and production days in {day zone}. Numbers are rounded to display
precision before hashing, and threshold decisions use rounded inputs; hidden last digits can differ between devices. Raw gauge data
{embedded | not embedded — interpretation and trend reproduce from the stored build-ups}. Run on {date}." The version comes from
`WTS_appVersion()` (host getter, §2.5), falling back to `#appVersionLabel`.

---

## 9. Work packages

### 9.0 Dependencies, schedule, merge order

```
WP0 (lead, serial: FILES, shapes + fixtures, 53 skeleton with canon/hash16)
 ├──► WP7-M1 PRiSM skin maths (day 2) ──► WP3 trend and alerts
 ├──► WP5 review / Q&A / report / sign-off (against FIX)
 ├──► WP2 data / detection / rates / run (stubbed interpretJob)
 ├──► WP1 PRiSM engine ──► WP7 Skin-check card
 ├──► WP4 synth + demos + validation tool (the tool run needs WP1 and WP2 merged)
 └──► WP6 page + integration (FIX first; lands after all engines)
                            WP1 + WP2 + WP4 ──► WP8 calibration ──► WP9 reviews + release
```

- WP1–WP7 run **in parallel** after WP0.
- **Merge order:** WP7-M1 → WP3 → WP5 → WP2 → WP1 → WP7 card → WP4 → WP6 (rebased on everything; adds `buildup-integration.test.js`) →
  WP8 → WP9. Every WP that hashes uses `PRiSM_autoInterp.canon`/`hash16` from the WP0 skeleton, so no branch waits for WP1 or WP5. After
  WP2 and WP3 merge, the lead refreshes `FIX` from real output (§3.13).
- Estimates (engineer-days): WP0 2, WP1 10, WP2 9, WP3 5, WP4 8, WP5 7, WP6 11, WP7 5, WP8 4, WP9 3.
- Critical path: WP0 → WP1 → WP8 → WP9 ≈ 19 days, with WP6 alongside.
- **Acceptance additions:** 14 files, about 140 tests, about 75 s in total. Per-file budgets (seconds): shapes 1, engine-a 6, engine-b 6,
  closed circle 3, data 6, run 5, trend 3, synth 4, benchmark 9, review 4, page 9, store 4, integration 9, skin check 4. The acceptance
  count goes from 941 to about 1,080; the exact number is fixed at integration. Every WP records the measured per-file time in its merge
  note.
- **Keeping the budgets.** `accept-test.js` gives each test a fresh app (no shared app, l.130). Therefore:
  - page tests seed `wts_buildup_state` from one demo analysis computed once per file (a file-level lazy cache: the first test that needs
    it runs the demo and serialises the state; later tests write that JSON into storage before opening the page). Only PG2, PG3, PG6 and
    PG17 run the engine themselves;
  - the engine tests are split into two files;
  - the 20-seed false-rival check runs in `buildup-validate.js --quick`; acceptance keeps 6 seeds (EN9);
  - benchmark seeds in acceptance use 60 s sampling and histories of at most 30 days.

### WP0 — Skeleton and contracts (lead; serial; before everything)

- **Files:** `prism-build/concat-round8.js`, `prism-build/53-prism-autointerp.js` (skeleton: `version`, `canon`, `hash16`, self-test),
  `prism-build/tests/_buildup-shapes.js`, `prism-build/tests/buildup-shapes.test.js`, and this plan's status line.
- **Deliverables:**
  - FILES += 53, 54, 55 (and the banner);
  - `canon` and `hash16` (frozen from here on; WP1 owns the rest of 53);
  - `checkShape` for every §3.13 name;
  - `FIX.analysis` and `FIX.result`, generated from closed-form values; the test-only `FORMULAS`.
- **Tests:** `buildup-shapes.test.js` (3 tests, ≤ 1 s):
  - SH1: the fixtures pass their own shape checks, and a broken copy fails with a path;
  - SH2: fixture self-consistency: every derived number in `FIX` equals `FORMULAS` applied to its stored inputs at display precision;
  - SH3: `canon`/`hash16` vectors: fixed inputs give fixed hex; key order does not matter; a 1e-15 perturbation does not change a
    `display`-mode hash; `inputs` mode rounds to 6 significant figures.
- **Done when:** Dev builds; smoke 317/317; the existing acceptance files touched by Round 8 pass; tag `v3.3-wp0`.

### WP1 — PRiSM automatic interpretation engine

- **Files owned:** `53-prism-autointerp.js` (all but `canon`/`hash16`), `05-regression.js`, `04-ui-wiring.js`, `33-pta-core.js`,
  `51-prism-workspace.js`, `13-auto-match.js`, `11-polish.js`, `tests/wp7-ui.test.js`, `tests/buildup-engine-a.test.js`,
  `tests/buildup-engine-b.test.js`, `tests/prism-closedcircle.test.js`.
- **May assume:** §3.1–§3.3 and `FIX.result`; nothing from other WPs.
- **Deliverables:**
  - the whole of §3.1;
  - the additive options (§3.2), including the exact `_getPM` edit;
  - `closedCircle` with its registry metadata, bounded grid form, schematic, names and plain text;
  - the two-zone kernel;
  - `PRiSM_openExternalBuildup` (§6.10);
  - placeholder calibration lookup: read `PRiSM_autoInterpCal` at call time, else `DEFAULTS`.
- **Tests:** `buildup-engine-a.test.js` (EN1–EN11, ≤ 6 s) and `buildup-engine-b.test.js` (EN12–EN22, ≤ 6 s), one app per test as the
  harness gives:

  | # | Asserts |
  |---|---|
  | EN1 | `derivative`: the plateau of a synthetic IARF Δp equals 70.6·qBμ/kh within 0.2 %; the mask is false within L of both ends; negative values sit in `neg` and are never logged |
  | EN2 | `bin`: 20 per cycle, medians, counts; single-sample bins raw |
  | EN3 | IARF, reference case (k 45, S 5, C 0.02, h 50, μ 1, 72 h): fair, start within ±0.1 cycle of 15.5 h, span 0.5–0.65, `iarf.longest` reported; 400 h → good; 600 ft fault → window ends before 24 h and T-up fires |
  | EN4 | Composite direction and earliest plateau: M 0.5 over 400 h → window on the inner level, second level reported, T-down fires, composite seeded with M < 1; M 2 → T-up, composite seeded with M > 1 and fitted M within 10 %; a dual-porosity valley is never chosen |
  | EN5 | Noise: σ 0.5 psi at kh 40,000 → tolerances widened within the caps, grade "fair (noise-widened)", `noiseLimited`, KH1 fails; noise beyond the caps → grade "none", reason "noise"; se_s does not grow with a hump-tail curvature |
  | EN6 | Line: reference 72 h → k −2.6 % ± 0.5, S −0.33 ± 0.1; tp = 1 h single rate → S within 0.05 of the truth (W term) |
  | EN7 | 365 daily steps: compaction ≤ 0.1 psi; homogeneous fit k ±0.5 %, S ±0.05, C ±1 %; `stats().gridBuilds` ≤ 40 and slices ≥ 1 |
  | EN8 | `opts.entry` grid wrapper vs the registry ≤ 0.02 psi; `opts.isolated` ignores `PRiSM_state.params` (BC constP set; fit uses noflow) |
  | EN8b | `fitPhysical('composite2', …, {entry})` succeeds while `PRiSM_MODELS` has no `composite2` key (the options reach `_getPM` and `_localPhysicalModel`) |
  | EN9 | BIC on the log-Δp block: homogeneous truth, 6 noisy seeds → no rival chosen; fault seen → fault chosen; ΔBIC finite, under 1,000 |
  | EN10 | Agreement: reference 72 h → agree; bias explained within 0.1 % and 0.01 |
  | EN11 | C-held: first sample at 0.3 h → triggered, range reported; unit slope sampled → not triggered; changing storage → `meaningful:false`; mode `auto` runs extended refits only on a side whose pair refit was not rejected (counter) |
  | EN12 | S_err: noise-free → 0.2 with driver `floor`; reference 72 h → S_win ≤ 0.15 (bias-corrected lines); a case where only the early shift fits uses the one-sided value; pwf0SE 0.5 psi at m 1.56 psi/cycle → S_pwf 0.37 and driver `pwf` |
  | EN13 | Sensitivity: the Appendix A.2 values to 1e-3; μ ΔS = 0; dominant inputs: requirement ranges k → h, S → rw; typical ranges k → h, S → ct |
  | EN14 | `confidence`: each KL, KK, KC and KH rule fires on a crafted evidence vector, with ids; `r3Status:'n/a'` passes KH5 and does not fire KC4; k-held vectors skip KL1, KL2, KL5–KL8 |
  | EN15 | Fall-off: synthetic injector → sign −1, k and S recovered within 2 % and 0.1 |
  | EN16 | Gas: pseudo-pressure build-up → k within 2 %, S′ within 0.1; `impurityAware` true when `WTS_gaspvt_z` exists |
  | EN17 | Determinism: `interpret` vs `drive` give identical JSON; zero pending timers after `drive`; no `Math.random` in 53 (source grep); `localStorage`, `PRiSM_state` and the events are untouched; a decision input 1e-12 from a threshold gives the same model on both sides of the rounding |
  | EN18 | k-held: S recovered with k fixed at the truth; a 5 % k offset on the reference case gives \|ΔS\| 0.5–0.6 and S_err ≥ \|ΔS\|; S_k from the refits within 20 % of `S_kAnalytic`; KK1–KK4 fire on crafted cases; label ≤ medium |
  | EN19 | Two-zone kernel vs `radialComposite` ≤ 0.5 % (six sets: three with M > 1, three with M < 1) |
  | EN20 | Slicing: `evalBudget` is count-only (the same fit under a frozen and an advancing clock gives identical results); a sliced fit equals the unsliced fit within 1e-9 relative; the plateau stop fires across slices; the evaluations per slice follow the §4.8 rule (11 for a homogeneous fit with 65 grid points and S ≥ 0) |
  | EN21 | `PRiSM_openExternalBuildup`: dataset, paste text and multi-rate written; `water_inj` → `water` / `falloff`; `activePeriod` contains tShut; the model is adopted before `setLastFit` (a `prism:fit-updated` listener sees a consistent `st`); `composite2` → `radialComposite`; after `reload()` PRiSM still shows the period |
  | EN22 | Reach and p*: numeric t_5 % on the reference case 15.5 h ± 5 %, reach.fair 62 h, reach.good 196 h; a 24 h test without IARF fits no rival and reports "too short"; with an estimated history (true production 5 years, default prepend) `pStarRange` brackets the true p* |

  `prism-closedcircle.test.js` (≤ 3 s):
  - CC1: late pD′ = 2tD/reD² within 0.5 %;
  - CC2: IARF 0.5 before the boundary; equal to homogeneous before the boundary within 0.1 %;
  - CC3: a seeded fit recovers re within 5 %;
  - CC4: the bounded grid form against direct Stehfest superposition with 365 daily steps and re = 0.9·r_inv: ≤ 0.05 psi;
  - CC5: registry metadata: the smoke C3 assertion (`kind` pressure|rate) passes for `closedCircle`, with `timeInput:'td'`,
    `defaultFrozen:[]`, `name` and a `default` on every `paramSpec` item.
- **Done when:** all `wp*-*.test.js` pass with the updated counts; the §4.8 desktop targets for prep and fits are met in a scratch timing
  run (numbers in the merge note); the CLAUDE.md naming rules hold (code review item in WP9).

### WP2 — Data, detection, rates and pipeline

- **Files owned:** `49-calc-buildup-data.js`, `49-calc-buildup-run.js`, `tests/buildup-data.test.js`, `tests/buildup-run.test.js`.
- **May assume:** §3.1 (`interpretJob`, `kHeldJob`, `bin`, `canon`, `hash16`; the run tests install an explicit stub that returns
  `FIX.result`), §3.6–§3.8 shapes, `trend.baseline` (stubbed until WP3 merges).
- **Deliverables:** §3.6, §3.7 and §4.1–§4.5; the staged pipeline (§4.6 item 18); the cache; the test cap; `WTS_buildup_compute`.
- **Tests:** `buildup-data.test.js`, ≤ 6 s. Synthetic records come from a small analytic generator inside the test file (not WP4's).

  | # | Asserts |
  |---|---|
  | DA1 | σ: 10 s sampling, σ 0.05 psi, a 1 psi/h trend and spikes → within ±10 %; quantised → resolution-limited 0.0029 psi; flowing slugging at 10× → σ_flow ≈ 10·σ_shut, σ_shut unaffected |
  | DA2 | Detection on 30 days, 6 shut-ins, 1 short, 1 partial (40 %) at 1 s / 1 min / 10 min → all found, the short one `too_short`, the partial classified; no event in 1,000 h of noise plus drift |
  | DA3 | Slow rise: q = 100 STB/d, C = 0.2 bbl/psi at 1 min sampling → detected through the multi-scale rule |
  | DA4 | End persistence: a 20 psi hump at 0.3 h does not end the build-up; a real reopen does, within one window |
  | DA5 | Closing time: error ≤ 0.2·Δt_med when ≥ 2 samples fall in storage; pwf0 within max(2σ, 0.05 psi); a ramp is detected; pwf0SE grows with slugging and with only 3 samples at 600 s |
  | DA6 | Partial: a 40 % cut gives f̂ 0.32–0.48 (dpDiff) with the volume preserved; a 90 % cut gives f̂ in [0.9, 0.95) → interpreted with `fRate` ≈ 0.9 and KC6 |
  | DA7 | Stimulation without an entered workover date (S 8 → 0 between the reference and the event) → f̂ ≥ 0.95 → shut-in |
  | DA8 | Spreading: a day with a 15:00 shut-in reads 24·V/15, the V/24 alternative 37.5 % low; a shut-in day with volume → R2; a closing at 00:30 → Δq from the previous day (`dqSource:'previousDay'`), R1 flag |
  | DA9 | Allocation: ignores-shutin, pass and fail days; fewer than 2 clean days within ±10 days → `unavailable`; a reopening flush day is not clean; a 23-h daylight-saving day can be clean; 10-unit volume rounding widens the R3 tolerance |
  | DA10 | Zones: `Europe/London` daylight-saving days of 23/25 h with an explicit zone, whatever the process time zone; `device` resolves to the IANA name and is stored; the offset scan finds a 6 h shift |
  | DA11 | Parser: the chunked result equals the one-shot result; elapsed-hours CSV with a rate column → `rateTable`; psig → psia; 500k synthetic rows take ≥ 50 steps |
  | DA12 | History: unknown → default prepend plus flag; date and cum modes; table mode builds steps from the table; every q = 0 period (`too_short`, `gap_at_closing`, `not_confirmed`, `intervention`, the split of a partial cut) stays in `steps` |
  | DA13 | Injector: falls detected as `falloff`; rate unit bbl/d |
  | DA14 | Two events in one day → `equalRateAssumed` |
  | DA15 | Intervention: a pressure above the previous p* by more than 2·T_s → `status:'intervention'`, not interpreted, listed in `missed.interventions` |
  | DA16 | Phase basis once per analysis: a water cut crossing 5 % mid-analysis → every test on the total basis; gas with condensate → the q_eq formula |

  `buildup-run.test.js`, ≤ 5 s:
  - RU1: the Analysis passes `checkShape`;
  - RU2: `analyse` and `analyseAsync` give the same `resultHash`, and no timers remain;
  - RU3: a cancel rejects `CANCELLED` and leaves no timers;
  - RU4: an override re-runs exactly one test (stub call counter) plus stages 2–5;
  - RU5: the cache reuses unchanged tests;
  - RU6: `stored` (no record) reproduces the same result hash;
  - RU7: stage order: pass-1 labels → baseline from pass-1 tests ≥ medium → pass 2 → final labels → trend → trend caps; a
    closed-without-depletion cap changes K2 and the headline label only, never the used set;
  - RU8: `spec.rateQC` is filled (`n/a` in table mode, `dqSource`, `fRate`); R4 is filled in stage 3 and is `unavailable` with an
    estimated history;
  - RU9: 80 detected tests → 60 kept by selection (longest per day, then per week; baseline tests kept), the others `test cap`;
  - RU10: `WTS_buildup_compute({})` returns `{ok:false, code:'NO_DATA'}` without throwing; `inputHash` changes with the resolved zone name and
    not with a unit-system flip.
- **Done when:** the targets above pass; parse and detection meet the §4.8 desktop targets in a scratch run, with the measured µs per row
  and the frozen `chunkLines` in the merge note.

### WP3 — Trend and alerts

- **Files owned:** `49-calc-buildup-trend.js`, `tests/buildup-trend.test.js`.
- **May assume:** `TrendTest[]` and `ctx` (§3.8) and the `PRiSM_skinCheck.mechanicalSkin` / `rateSkin` / `products` signatures (§3.4);
  WP7-M1 merges first, so the real functions are used.
- **Deliverables:** §3.8, §4.7.
- **Tests:** `buildup-trend.test.js`, ≤ 3 s:

  | # | Asserts |
  |---|---|
  | TR1 | Baseline: median, unstable and provisional rules; a workover date starts a segment |
  | TR2 | Delta and absolute alerts: raised, confirmed, provisional, possible (an excluded low test above the threshold); immediate confirmation when high + 1; plain vs basevar form; `kHeldOnly` |
  | TR3 | Absolute robustness with ±S_sens; basis switches to mechanical when completion is given |
  | TR4 | Hinge onset on a synthetic step within one interval; CUSUM alarm and onset |
  | TR5 | Theil–Sen slope and Sen CI against hand values; Mann–Kendall z; n ≤ 4 indicative |
  | TR6 | Forecast hidden when the lower bound ≤ 0; horizon cap |
  | TR7 | Products: S 1.2 → 7.4 with X 7.68 gives PI ratio 0.865 / 0.509, rate factor 1.698, extra drawdown 374 psi (141.2·qBμ/kh = 60.3 psi per unit skin); guard for X + S < 1; m = 162.6·Δq·B·μ/(k·h); `reSource:'rinv'` → "lower bound" and "upper bound" labels |
  | TR8 | k stability, the Appendix A.3 interpretation table, the stage-3 window inconsistency reported |
  | TR9 | Pressure trend: depletion vs none; drift wording; an estimated history → not assessable, `depletion:null`, no `closedWithoutDepletion`; the closed family (p̄) when the closed circle wins on ≥ half of the tests |
  | TR10 | Model-free ΔS agreement from `TrendTest.bins` |
  | TR11 | Bubble-point levels from the gradient range; Spearman rule; off for gas and injectors; critical only when the pressure trend is assessable |
  | TR12 | Gas rate skin: collinear q and t → unresolved; a 2.0× spread with 3 + 3 constant-skin tests → D within 10 % and D/se ≥ 2 |
  | TR13 | Recommendations and limitations carry evidence ids; texts are under 600 characters; "needs a shut-in of at least X h" uses `reachFairShut_h` |
  | TR14 | Trend `auto` is off in table mode and with tests less than 1 day apart; `on` overrides |
  | TR15 | `excludedLow` count and S range (T16) |
  | TR16 | PI cross-check uses `days[].pwfMean_psia`; unavailable with an estimated history |
- **Done when:** the tests pass with the real `PRiSM_skinCheck` (WP7-M1 merged).

### WP4 — Synthetic generator, demos, validation tool

- **Files owned:** `49-calc-buildup-synth.js`, `prism-build/buildup-validate.js`, `55-prism-autointerp-cal.js` (placeholder),
  `tests/buildup-synth.test.js`.
- **May assume:** §3.6, §3.7 (to call the pipeline in the tool), §3.9.
- **Deliverables:**
  - §3.9 and §5.2–§5.5, including the seed table, the input-consistent truth and the realism factors;
  - the demos:
    - **oil:** 135 days; 9 analysable build-ups, 1 short shut-in (1.5 h), 1 partial cut (40 %); k 45 md, h 50 ft, μ 1 cp, C 0.01 bbl/psi;
      S path 1.2, 1.3, 1.1, 1.8, 2.9, 4.2, 5.9, 6.8, 7.4; durations 72, 48, 36, 30, 48, 42, 48, 60, 72 h (each ≥ 1.2·reach.fair at its S,
      from the generator's own numeric reach; about 21 h at S 1.2 and 38 h at S 7.4); one closing at 15:00 on a production day starting at
      00:00 (the US3 example); daily allocation with 3 % noise; 1 min sampling within build-ups and the day before, 5 min elsewhere. Expected:
      delta alert raised at B6 (its excess stays below 1, so no immediate confirmation) and confirmed at B7; absolute alert raised at B7 and
      confirmed at B8;
    - **gas:** 8 build-ups; the first 6 at constant mechanical S on two rate levels 2.0× apart (high, low, high, low, high, low), D·q = 2.0
      at the high rate (1.0 at the low rate); then 2 at the high rate with mechanical S rising by +3 and +5. With S_err at the 0.2 floor the
      rate-skin step between the levels is ΔS′ = 1.0 and se(ΔS′) = 0.2·√(1/3 + 1/3) = 0.163, so D/se ≈ 6.1. Expected: D resolved; no delta
      alert on the 6 constant-skin tests (their S′ differ by D·Δq = 1.0 < 2); delta raised at test 7 and confirmed at test 8;
  - `IN_APP` (24 seeds, chosen with margin ≥ 0.1); the placeholder file 55 (`--placeholder`).
- **Tests:** `buildup-synth.test.js`, ≤ 4 s:
  - GE1: the same seed gives an identical record hash;
  - GE2: the homogeneous generator vs the IARF asymptote 0.5(ln tD + 0.80907) + S, within 0.1 % at late time;
  - GE3: own Stehfest N = 16 vs the Ei line source (C_D 0, S 0) within 1e-4;
  - GE4: the oil demo has 9 analysable plus 1 short plus 1 partial truth events, k 45, C 0.01, the S path and durations as listed, each
    duration ≥ 1.2·reach.fair, and the 15:00 closing; the expected grade of each test (fair or good) is recorded and asserted;
  - GE5: the gas demo has a rate ratio of 2.0, D·q = 2.0 at the high rate and 3 + 3 constant-skin tests, and the D/se arithmetic above gives
    ≥ 6 with S_err = 0.2;
  - GE6: `caseFromSeed` follows the fixed seed table, covers every stratum, and the parameters lie within the §5.2 ranges;
  - GE7: source grep: the generator never references `WTS_buildup.data`, `PRiSM_MODELS.homogeneous`, `linearBoundary`, `radialComposite`,
    `closedCircle`, `PRiSM_evalWbsSkin` or `Math.random`;
  - GE8: truth: f, k* and S* follow the given inputs and the true flowing hours; `score` never reads the engine's Δq (a stub engine with a
    wrong Δq scores "not right"); records stay ≤ 500k samples.
- **Done when:** `buildup-validate.js --quick` runs end to end once WP1 and WP2 are merged (lead check), with the measured time per case in
  the merge note and §5.5/§5.6 updated; the placeholder file 55 passes `checkShape('Cal')`.

### WP5 — Review, Q&A, report model, sign-off, AI export

- **Files owned:** `49-calc-buildup-review.js`, `tests/buildup-review.test.js`.
- **May assume:** `Analysis` (§3.7) via `FIX.analysis`; §3.10; `canon`/`hash16` from the WP0 skeleton.
- **Deliverables:** §3.10, §7 and §8 (model side).
- **Tests:** `buildup-review.test.js`, ≤ 4 s:

  | # | Asserts |
  |---|---|
  | RV1 | The evidence index has every id used by the report; every report statement has at least one id |
  | RV2 | Each rule V1–V27 fires on a crafted variant of `FIX.analysis` with the right severity and where; the V23–V27 functions reference none of `PRiSM_autoInterp`, `WTS_buildup.run` or `WTS_buildup.trend` (source grep) |
  | RV3 | Tampering with a quoted number → V14 critical with `acceptable:false`; `canSign` fails even with a decision recorded |
  | RV4 | Q&A: the 19 sample questions plus 3 paraphrases per intent → expected intent, ev ids and numbers equal to the analysis; "what if h is 20 % higher" → k −16.7 %, S +0.091; "compare B2 and B5" finds both tests; an out-of-scope question → help, quoting no numbers |
  | RV5 | A failing answer is marked on the answer and adds no review finding |
  | RV6 | SHA-256 vectors for '' and 'abc'; the hashes use `canon`/`hash16` from 53 |
  | RV7 | Sign-off blocked with open major findings; DRAFT → SIGNED → CHANGED after a result edit; a re-run with the same inputs stays SIGNED; a different app version stays SIGNED with the info line |
  | RV8 | AI export: no well, engineer or file name, no reason text, no dates, no URL; with `includeFreeText` the reasons appear |
  | RV9 | Report blocks on `FIX`: notes ≤ 600 characters, verdicts < 300 characters, table rows ≤ 30 (40 tests → 30 rows plus "10 older tests"), S9 grouped by rule, no "null" or "undefined" text |
  | RV10 | Every ReportModel number is a `Value` with a `ref`; `check()` uses `v`, not text: an imperial and a metric formatter give the same check result |
  | RV11 | With a metric formatter, report, finding and answer text contains no psi, ft or STB |
  | RV12 | `review.FORMULAS` agrees with the shapes `FORMULAS` on `FIX.analysis` |
  | RV13 | The audit chain verifies; folding beyond 500 entries keeps the chain |
  | RV14 | The evidence check uses full-precision stored values: inputs whose displayed values round differently do not raise V14 |
- **Done when:** the tests pass; the shapes match.

### WP6 — Page and integration

- **Files owned:** `49-calc-buildup.js`, `49-calc-buildup-plot.js`, `49-calc-buildup-store.js`, `ios-app/ios-additions/ios-styles.css`
  (the `bu` section), `29-multiwell.js`, host `well-testing-app.html` (`__NAV_ORDER`, `RT_BUILTIN` final, `WTS_appVersion`,
  `WTS_snapshotNow` only), `smoke-test.js`, `tests/_buildup-idb-fake.js`, `tests/buildup-page.test.js`, `tests/buildup-store.test.js`,
  `tests/buildup-integration.test.js`, plus `tests/platform-multiwell.test.js` if it pins the comparison row count.
- **May assume:** all of §3; `FIX.analysis` until the engines merge.
- **Deliverables:** §6, §3.11–§3.12, §2.5 rows owned by WP6.
- **Smoke checks** (9, so 317 → 326):
  1. registry `buildup` (group, `hooks.silent`, render);
  2. `WTS_buildup_compute` is a function and `WTS_buildup_compute({}).ok === false`;
  3. `PRiSM_autoInterp.interpret` is a function;
  4. `PRiSM_MODELS.closedCircle.pd(1e4, …)` is finite and its `kind` is `'pressure'`;
  5. `PRiSM_skinCheck.mechanicalSkin` is a function;
  6. `PRiSM_autoInterpCal.table` is an array;
  7. `WTS_buildup.review.sha256('abc')` gives the known digest;
  8. `PRiSM_autoInterp.hash16('abc')` gives its fixed vector;
  9. 0 pending timers 5 s after opening `buildup`.
- **Tests:** `buildup-page.test.js`, ≤ 9 s (seeded state, §9.0):

  | # | Asserts |
  |---|---|
  | PG1 | Open: Notes box at first paint, no analysis started, 0 timers after `flush(400)`; every control labelled; idle-only controls disabled |
  | PG2 | Demo + Analyse: progress text at once; results after `flushAsync`; `data-done`; focus on S1; 0 timers after `flush(5000)` |
  | PG3 | Cancel keeps the previous results and leaves no timers |
  | PG4 | Metric at first paint and after a flip: no psi/ft/md/bbl/STB in labels, `.rrow`, table cells or `app.canvasTexts()`; one converted value checked; `bu_drift` label and value converted at first paint |
  | PG5 | Autosave + reload: one `calcBuildup` (counter); results restored from state with no re-run |
  | PG6 | Override via the dialog: a reason is required; audit entry; stale banner; one test re-run; focus returns to the "Actions…" button |
  | PG7 | Sign-off: DRAFT → signed (S11 ✓, `#pgSub`) → input change and Analyse → CHANGED banner, one `changed_after_signoff` entry and one `input` entry; a re-run with the same inputs stays SIGNED; a unit flip and back is not stale and stays SIGNED |
  | PG8 | `collectPageReport`: sections S1–S12 present; verdicts < 300 characters; notes ≤ 600 |
  | PG9 | Quick Report: run the demo, `flushAsync`, navigate away, export final → "Build-up surveillance" with the latest S and DRAFT status (snapshot hook); the daily template is unchanged |
  | PG10 | Project save/open round trip (`wts_buildup_state`, `wts_buildup_audit`, `buildup_raw`, `buildup_analysis`) |
  | PG11 | Well switch reloads the other well's state |
  | PG12 | Open in PRiSM: confirm, then `PRiSM_openExternalBuildup` is called with ds, paste text, multi-rate, tShut and fitC4 (spy) |
  | PG13 | GUI-sweep edge values (blank / 0 / −1 / 1e12) on every numeric input: physical inputs → ✗ verdict, `input-err`, no analysis; settings clamped and echoed in S2; no NaN, Infinity, "null" or "undefined" text, no hang |
  | PG14 | The sweep's elapsed-hours CSV → parsed; rate-table mode proposed |
  | PG15 | The ios-styles CSS contains the `#bu_root .bu-dlg` overlay rule and the `.bu-dlg-box` `100vh` and `100dvh` rules |
  | PG16 | `WTS_appVersion()` returns `RELEASE_NOTES[0].ver`; if `RELEASE_NOTES[0]` says "calibrated confidence", `PRiSM_autoInterpCal.calibrated` is true |
  | PG17 | Well switch during a running analysis: start the demo, switch well, `flushAsync` → neither well's state is written by the discarded run, no audit "run" entry, 0 timers |
  | PG18 | 375 px layout (`loadApp({viewport:{width:375, height:812}})`): `#bu_root` scrollWidth ≤ the viewport after results render |
  | PG19 | S5 shows "N low tests excluded" and a `possible` alert from a seeded state |
  | PG20 | The comparison page (29-multiwell) shows the new S after an async run and after a reload |

  `buildup-store.test.js`, ≤ 4 s (with `_buildup-idb-fake.js`):
  - ST1: `putRaw`/`getRaw` and `putTests`/`getTests` round trips; the failure path falls back to memory;
  - ST2: a raw-hash mismatch after project Open → raw treated as absent, note shown;
  - ST3: opening an old project without `buildup_raw`/`buildup_analysis` drops the previous project's entries;
  - ST4: saving a project before the page was opened (cold mirror) → `read()` lists `omitted`; `write()` fills the mirror synchronously;
  - ST5: a 60-test analysis × 3 wells → `saveState` ok (≤ 300 kB per well, overflow used) and `WTS_wells.switchTo` ok;
  - ST6: `encodeJob` runs in 50k-sample units through `drive` and leaves no timers.

  `buildup-integration.test.js`, ≤ 9 s (real engines):
  - IN1: oil demo → 9 interpreted, 1 too short, 1 partial; k within 10 % of 45; the S path within ±0.6; each test's expected grade (GE4);
    delta alert raised at B6 and confirmed at B7; absolute raised at B7; k/S labels ≥ medium on at least 8 of 9 tests;
  - IN2: gas demo → D resolved (D/se ≥ 2); no delta alert on the 6 constant-skin tests; delta raised at test 7 and confirmed at test 8;
  - IN3: the evidence check passes on the real analysis (0 V14), and V23–V27 do not fire on either demo;
  - IN4: the comparison page shows the latest skin row;
  - IN5: report limits (600 / 300 / 30, no "null" or "undefined") on the real oil and gas demo analyses;
  - IN6: a sliced end-to-end oil-demo run leaves zero pending timers and the stats counters match the §4.8 slicing rule.
- **Done when:** the tests pass; smoke 326/326; v3-ux, a11y, sidebar-nav, calc-registry, platform-reports, platform-multiwell and
  app-version pass.

### WP7 — PRiSM skin maths and the Skin-check card

- **Files owned:** `54-prism-skin.js`, `tests/prism-skincheck.test.js`.
- **May assume:** §3.1 (`iarf`, `line`, `agreement`, `sErr`, `sensitivity`, `confidence`, `reach`, `cHeldJob`, `drive`) and §3.4.
- **Milestone M1 (day 2, merged first):** `perforationSkin`, `mechanicalSkin`, `rateSkin`, `products`.
- **Deliverables:** §3.4, §6.11. Verification of the Karakas–Tariq coefficient table against SPE 18247 (Q7). `verified:true` only after
  that check, recorded in the file header with the table's source page.
- **Tests:** `prism-skincheck.test.js`, ≤ 4 s:
  - SK1: perforation vectors (180°, 2 spf → 2.19; 0° / 90° / 60° → 3.09 / 2.03 / 2.29) when verified; otherwise `UNVERIFIED`;
  - SK2: S_total 5.5 → 12 with S_pp 4 → S_mech 1.5 → 8, and S_d scaled by h_w/h;
  - SK3: deviation above 75° → validity warning, not split;
  - SK4: `rateSkin` guards (q ratio < 1.5 → unresolved; collinear → joint fit refused);
  - SK5: the panel renders on Tab 6 after a fit, with no localStorage change and no events on render;
  - SK6: the PRiSM report contains the "Skin check" section;
  - SK7: "Use this window" stores the semilog window (user action);
  - SK8: the C-held button runs through `drive` and leaves no timers;
  - SK9: the card's rate status is `n/a` (no KC4 cap) and the reach shown is the numeric one; `products` labels the bounds when
    `reSource:'rinv'`.
- **Done when:** the tests pass; the existing wp5 / wp3 skin tests are unchanged.

### WP8 — Calibration run (after WP1, WP2 and WP4 are merged)

- **Files owned:** `55-prism-autointerp-cal.js` (regenerated), `tests/buildup-benchmark.test.js`.
- **Work:**
  - run `buildup-validate.js --sequences --workers 4 --write` and inspect `calibration.md`;
  - if targets fail, change engine thresholds only through the calibration grid. Engine logic bugs go back to the owning WP as fixes.
- **Deliverables:**
  - the calibrated file 55 (`calibrated:true`) with both tables, the in-app cases and their margins;
  - the benchmark acceptance test (§5.6) with snapshot outcomes (BM1: the 10 seeds; BM2: no "high" case wrong);
  - a one-page summary for PROJECT-NOTES (both reliability tables, Brier/BSS, coverage, false-rival rate, abstention, rate accuracy,
    sequence metrics, the shipped delta-alert form).
- **Done when:**
  - for both tables: high ≥ 95 % (lower bound ≥ 90 %), medium ≥ 80 % (lower bound ≥ 70 %), low ≤ medium − 20 points;
  - false-rival rate ≤ 5 %; delta false-alarm rate ≤ 5 %; abstention ≤ 10 % on `hom`;
  - the benchmark test passes.

### WP9 — Reviews and release

- **Files owned:** host `RELEASE_NOTES` (`well-testing-app.html`, after WP6 has merged, so the work is serial),
  `ios-app/ios/App/App.xcodeproj/project.pbxproj`, both `ci_post_clone.sh`, `tests/ios-native.test.js` / `tests/app-version.test.js`
  (only if they pin 3.2), README, CLAUDE.md, PROJECT-NOTES, `docs/ROADMAP.md`, `perf-baseline.json` (re-recorded in its own commit, as for
  v3.2).
- **Work:**
  - an independent code review of every new file (correctness, the purity rules, escaping, the CLAUDE.md naming rules);
  - an engineering review of the calibration;
  - a GUI sweep: `node prism-build/gui-sweep.js --route buildup,prism` and `--mobile`, with fixes back to the owners;
  - `node prism-build/ux-layout-check.js` (the sidebar still fits 1280×800 with 7 rows in Production & Reservoir) and
    `node prism-build/ios-webkit-check.js` when Playwright is available (the dialog safe-area rule);
  - one real-phone timing check of the oil demo (§4.8 phone target; a miss is recorded in §11 and PROJECT-NOTES);
  - the full rebuild with CLAUDE.md's incantation: Phase 1+2, Phase 3+4, Rounds 2, 3, 6, 8, 9 and 10 (Rounds 4/5 are unchanged; Round 7
    belongs to the separate simulator workstream and is never run from this work); the CRLF step only when the working copy is CRLF;
  - `sync-from-main`; `node --check`; smoke 326/326; full acceptance; `wts3d-test.js`;
  - `docs/ROADMAP.md` entries for every deferred item of §1.5;
  - merge Dev → master.
- **Done when:** every gate is green and the §10 items are done.

---

## 10. Release items (WP9)

- **`RELEASE_NOTES[0]`** (keep the format comment above `RELEASE_NOTES` unchanged and use only `RN_CATS` keys):

```js
{ ver:'v3.3', date:'<release date>', title:'Build-up Surveillance &amp; PRiSM skin checks',
  items:[
   ['new','Build-up Surveillance','Finds every shut-in in permanent-gauge data, interprets each build-up automatically and tracks skin, k, p* and PI over time with delta and absolute skin alerts, onset date and forecast.'],
   ['new','Rates over flowing hours','Daily allocated volumes are spread over the actual flowing hours, with allocation consistency checks, production-day and time-zone settings and partial-cut detection.'],
   ['new','Review &amp; sign-off','Automated rule-based review whose evidence check verifies every quoted number, questions answered from the analysis, DRAFT until sign-off, signature hash and audit trail.'],
   ['new','Gas wells &amp; injectors','Normalised pseudo-pressure, rate-dependent skin separation with guards, and water-injector fall-offs.'],
   ['prism','Skin check','New Skin-check card: automatic IARF window, line-vs-match agreement, skin uncertainty, <CAL_TEXT>, sensitivity and mechanical skin.'],
   ['prism','Closed circle model','New closed circular reservoir model (46 models).'],
   ['report','Quick Report','Build-up surveillance section in the final report template; every statement carries an evidence reference.'],
   ['ux','Responsive analysis','Long imports and analyses run in short slices with progress and cancel, also on phones.'] ] }
```

  `<CAL_TEXT>` is "calibrated confidence label" when file 55 has `calibrated:true`, else "confidence label (calibration in progress)"
  (PG16 checks the pairing). Engineering changes only (the CLAUDE.md release-notes rule); `&amp;` in the HTML.
- **Version 3.3:** `MARKETING_VERSION = 3.3;` at `project.pbxproj:319` and `:342`; `VERSION_BASE="3.3"` in
  `ios-app/ci_scripts/ci_post_clone.sh:86` and `ios-app/ios/App/ci_scripts/ci_post_clone.sh` (keep both identical);
  `tests/ios-native.test.js` and `app-version.test.js` follow `RELEASE_NOTES[0].ver`.
- **README:** a feature paragraph; counts (the PRiSM_MODELS total 46 in the feature list and the version table, smoke, acceptance).
- **CLAUDE.md:**
  - file-map lines for 53 / 54 / 55, `49-calc-buildup-*.js` and `buildup-validate.js` (with "file 55 is GENERATED; never edit by hand");
  - the build note that Round 8 now has 53–55, and the numbering rule (DFIT from 56; only the lead edits `concat-round8.js` FILES);
  - the sidebar note: Production & Reservoir has 7 of 8 rows; the DFIT page goes to Well Test & Flowlines;
  - stats: 46 models (42 transient + 4 decline), SVG schematics 46 → 47, 21 plug-in pages, smoke 326, acceptance 941 + new;
  - the shared-engine list: `PRiSM_autoInterp` (with `canon`/`hash16`), `PRiSM_skinCheck`, `WTS_buildup`;
  - known limitations: partial cuts not interpreted; deconvolution not on the page; two-phase skin not quantified; perforation skin only
    if verified; the IARF window is the earliest plateau; p* with an estimated history is a range;
  - correct the Stehfest line (a table keyed by N, not on window);
  - "Latest release: v3.3".
- **PROJECT-NOTES:** the v3.3 entry with the calibration summary.
- **docs/ROADMAP.md:** the deferred items of §1.5.
- **perf-baseline.json:** re-recorded in a separate commit. The new code adds about 0.6–0.8 MB; the baseline was already exceeded before
  v3.3.

---

## 11. Open questions (each with the default we use; we do not stop to ask)

| # | Question | Default |
|---|---|---|
| Q1 | Page name and route | "Build-up Surveillance", `buildup` (as given) |
| Q2 | Register the closed circle in PRiSM's library (46 models, test counts change)? | Yes, with `kind:'pressure'`: PRiSM gains a model, and "Open in PRiSM" can show every engine winner (composite2 maps to `radialComposite`) |
| Q3 | Add `opts.entry` / `isolated` / `evalBudget` / `lmState` / `slice` to 05 and 33? | Yes, additive. Without them the engine would duplicate the C3 mapping and could not slice deterministically |
| Q4 | Delta alert form | Requirement form (plain); WP8 switches to `basevar` only if the plain form misses the 5 % false-alarm target |
| Q5 | S_err floor | 0.2 unless the benchmark coverage is below 90 %; then the calibrated value |
| Q6 | History default when the start is unknown | max(30 d, 10 × the longest Δt_end), flagged, with the doubling check; p* reported as a range and not used for any trend |
| Q7 | Karakas–Tariq coefficients are unverified (recalled from memory) | Perforation skin ships **only** if WP7 verifies the table against SPE 18247. Otherwise the perforation inputs are hidden and the decomposition says "perforation skin not split" |
| Q8 | SPE numbers marked "no. to verify" | Never shown in the app; cite author, year and title only until verified |
| Q9 | Raw data in project files | Embed up to 16 MB encoded (active well plus wells opened this session), used only when the hash matches; otherwise omitted with a visible note |
| Q10 | Daily Quick Report section | **No**: final template only; the daily template and its tests are unchanged |
| Q11 | Interpret partial cuts? | No in v3.3: classified, put into the rate history, listed. Steps with 0.9 ≤ f̂ < 0.95 are interpreted with Δq·f̂ and capped at medium |
| Q12 | Default zones | Gauge and production day both `device`, **resolved to the IANA name at the first analysis and stored**; start hour 0; the offset scan warns |
| Q13 | Maximum tests per analysis | 60, kept by selection (longest shut-in per day, then per week; baseline tests always kept), not by dropping the oldest |
| Q14 | Deconvolution on the page | Deferred; reachable through Open in PRiSM |
| Q15 | Currency for the value at stake | "Value per unit volume", no currency symbol, unit category `pricePerVolume` |
| Q16 | Signer identity | Free-text name and role; the hash checks integrity, not authentication (stated) |
| Q17 | Gas condensate | Flag only: "two-phase; S′ includes the condensate bank" when the dew point is given and pwf < pdew; rates on the wet-gas equivalent basis when the condensate equivalent exceeds 5 % |
| Q18 | AI export default | De-identified, no dates, no free text |
| Q19 | Size budget | Accept about 0.7 MB; re-record the baseline in its own commit |
| Q20 | Benchmark size | 640 single cases plus 120 sequences (≥ 1,600 labelled build-ups) |
| Q21 | Do k-held tests confirm alerts? | Re-decided with the corrected S_err (S_k of 0.3–1.2 for 3–10 % k or rate errors): yes when labelled medium, using their own S_err (which includes S_k), so a k-held test confirms only a rise that exceeds that larger uncertainty; flagged `kHeldOnly` in the alert text when no free-fit test contributes; KK4 makes a k-held test low when S_err > 1.0 |
| Q22 | Closed circle without depletion support | Model label capped at medium (V18), only when depletion can be assessed |
| Q23 | Tide removal | Automatic when r_tide > 0.10: M2 alone from 24 h, M2 + K1 from 48 h |
| Q24 | Sidebar position | Row 7 of Production & Reservoir, after Gas Lift (`__NAV_ORDER`) |
| Q25 | Spreadsheet import offline | CSV first; the spreadsheet path only online, with a status note |
| Q26 | File numbers and sidebar group shared with DFIT | 53–55 for this feature, DFIT from 56; the lead edits `concat-round8.js` FILES for both; DFIT page in Well Test & Flowlines |
| Q27 | Composite if the two-zone kernel misses its speed target | Composite leaves the automatic race (flag "possible radial composite — open in PRiSM", model label ≤ medium); the registry composite is never run inside a work unit on any device |
| Q28 | Work-unit budget | 50 ms desktop (150 ms phone), below the requirement's ~200 ms |
| Q29 | Phone target for 8 tests | ≤ 5 s; a miss in the WP9 phone check is recorded here and in PROJECT-NOTES with the measured value |
| Q30 | Trend and alerts for test (table) data or tests less than 1 day apart | Off by default (`auto`); the engineer can switch them on |

---

## 12. Pre-review resolutions

The first four pre-review entries were process notes written before this plan existed (plan missing, scope questioned, integration and
method notes missing); this document closes them. The 27 engineering issues are resolved as follows (the later engineering and
architecture review is in Appendix B).

| # | Issue (severity) | Decision | Where |
|---|---|---|---|
| 1 | Rate history truncated before the first allocated day (blocker) | Inputs for production start or cumulative. The default prepend is max(30 d, 10·Δt_end,max), flagged. A doubling check: more than 2 % derivative change → medium cap (KC1), V15. p* becomes a range and no rule uses p* or its trend. 15 % of benchmark cases have truncated history | D13, §4.5, §4.6 items 13b and 14, §5.2 |
| 2 | Phone performance of superposition (blocker) | Compaction + pd grid + 12 fit bins per cycle + seeded single start + rivals on triggers only + fast closed-circle and two-zone kernels + no `closedRectangle` + LM slicing by evaluation count with yields. Budget table with measured baselines and targets; counters asserted in tests, wall clock in `--perf`, one phone check in WP9 | D5, §4.6, §4.8 |
| 3 | No closed-circle model (major) | New `PRiSM_MODELS.closedCircle` (`kind:'pressure'`) on `PRiSM_evalWbsSkin` (46 models), with a bounded grid form. "Closed, fully seen" needs a falling derivative with slope ≤ −0.5; the wording always lists constant-pressure boundary, interference and depletion; without depletion in the pressure trend the label is ≤ medium (V18) when depletion can be assessed. `constp` and `interf` decoys in the benchmark | D4, §3.3, §4.6 items 9–12, §5.2 |
| 4 | Partial cuts pass the shut-in tests (major) | A classification gate on a skin-free f̂ (late Δp differences against a same-segment reference) or the allocation: shut-in at f̂ ≥ 0.95 or allocation-confirmed hours; 0.9–0.95 interpreted with Δq·f̂ (KC6). Partial cuts go into the rate history and are never interpreted. Pass-2 m′-ratio suspicion (KL8, V17). Benchmark stratum `partial` plus a 10 % factor | D12, §4.3 |
| 5 | IARF window selection unstable across tests (major) | The earliest plateau run after the hump, then the longest window in it (deviation disclosed; the longest window reported); the valley guard; later plateaus as evidence; cross-test kh consistency (KC5, V20); no automatic window change | D7, §4.6 item 3, §4.6 item 18 |
| 6 | IARF thresholds vs gauge noise (major) | Widening max(10 %, 3σ_d/ℓ) ≤ 20 % and max(0.03, 2·se_s) ≤ 0.06 with se_s from the noise model; grades at the fixed tolerances, "fair (noise-widened)" fails KH1; SNR_d in the labels; high-kh noisy cases in the benchmark | D7, §4.6 item 3, §5.2 |
| 7 | BIC sample size and autocorrelation (major) | Log-Δp-block BIC on a fixed 12-per-cycle point set shared by all candidates and refits; n_eff from AR(1); a variance floor; τ calibrated (false-rival ≤ 5 %); C-held profile ×0.5–×2 with the allowed range where ΔBIC ≤ 10 | D8, §4.6 items 6 and 8, §5.4 |
| 8 | Benchmark "fully right" undefined (major) | Input-consistent truth computed in the generator; k ±10 %, S ±0.5, model right, no false fully-seen; abstentions count as low; folds grouped by well; an independent generator (own kernels, N = 16, 40 per decade, full history, end-to-end raw data, coloured noise, slugging, flush); at least 40 % unmodelled effects; ≥ 1,600 labelled build-ups; Wilson and cluster intervals in the app; envelope → "outside calibration" | D22, §5.2–§5.4 |
| 9 | Gas D·q confounded with time (major) | D only from tests in a stable-skin segment with q_max/q_min ≥ 1.5 and D/se ≥ 2; a joint fit with a time term only with ≥ 4 tests and \|corr(q, t)\| < 0.8; otherwise S′ labelled "apparent", with the expected-D range; gas alert text states the rate-change effect | §3.4 `rateSkin`, §4.7 |
| 10 | Absolute alert on total skin; decomposition scaling (major) | The absolute alert on S_mech (pressure-drop basis) when completion data exist, else labelled total; the local damage skin S_d = S_mech·h_w/h reported for treatment design; deviation validity θ ≤ 75°; 34 unchanged (its tests pin the additive form, which is the pressure-drop basis); the delta alert stays primary | D11, D23, §3.4, §4.7 |
| 11 | Production day and time zone (major) | UTC storage; gauge-zone and production-day settings resolved to IANA names and stored; true day lengths; the offset scan with a warning (V16); a 10 % offset-mismatch factor in the benchmark | D12, §4.4 |
| 12 | Short tests miss the rising skin (major) | The k-held pass (k fixed at the baseline median, S_k from two refits, own rules KK1–KK4, label ≤ medium, its own sub-table in calibration); excluded low tests counted with a `possible` alert status; numeric reach and the recommended shut-in length (V9) | D14, §4.6 item 18, §4.7, §5.3 |
| 13 | Gauge drift, interference, depletion (major) | Drift input and index (Q5); pass-2 background check with the p_ext slope (drift input with an estimated history) → `boundaryDepends` (model low, V19); pressure trend labelled "depletion or gauge drift"; drift and interference in the benchmark | §4.2, §4.6 item 18, §4.7 |
| 14 | Injection wells (major) | Event type from fluid and rate sign; falls detected; sign −1; water μ and B; first plateau; half-slope fracture flag; injectivity wording; bbl/d; Pb, PI and allocation-flush rules off; `inj` stratum | D15, §4.3, §4.6 |
| 15 | DST-style data (major) | Rate-table mode: periods from the table, the rise detector only refines t_c, full superposition W term, r_inv from equivalent time, p* "history complete", rate status `n/a`, spans in log10 Δt_e, trend off by default | D15, §4.5 |
| 16 | Semilog skin superposition form (minor) | Reuse `PRiSM_semilogAnalysis` (W term) with an explicit window; pwf0 from the flowing trend at t_c with its standard error; test EN6 with tp = 1 h | §4.6 item 4, WP1 EN6 |
| 17 | Sensitivity can be analytic (minor) | Closed form, no refits; the requirement ±20 % / ±10 % table plus a typical-range table that drives S_sens; both dominant inputs stated; "μ has no effect on S"; the larger uncertainties (window, total vs mechanical) shown first in S6 | §4.6 item 16, §8.2 S6 |
| 18 | S_err misses window and t_c terms; baseline uncertainty (minor) | S_err adds S_win (shift min(0.25, 0.2·span), bias-corrected), S_tc and S_pwf (analytic), and S_k for k-held tests; LM se inflated by √(n/n_eff); `basevar` alert option; baseline from fewer than 3 or k-held tests is provisional | D10, D11, §4.6 item 15, §4.7 |
| 19 | Noise estimate and detection windows (minor) | σ from second differences on quiet segments, σ_flow and σ_shut separately, plus σ_LF at the derivative scale; quantisation and correlation flags; window max(5 min, 3·Δt_med) with multi-scale rises up to 30 min and persistence ≥ 30 min | §4.2, §4.3 |
| 20 | PI ratio with an r_e lower bound (minor) | `bu_re` input (well spacing) with r_inv as the shown lower bound; guard X + S ≥ 1; r_inv = 0.0325·√(kΔt/(φμct)) at Δt and Δt_e; "pseudo-steady-state estimate" label, lower and upper bounds labelled | §4.6 item 13, §4.7 |
| 21 | Bubble point vs gauge depth (minor) | Sandface pwf with a flowing-gradient range against Pb; a constant depth shift leaves k and S unchanged (stated); in-wellbore gradient changes listed under limitations and in the `wbschange` stratum | §4.2, §4.7, §5.2 |
| 22 | Derivative variable (minor) | ln Δt_e, L in ln units 0.2303, plateau 70.6qBμ/kh asserted (EN1); negative derivatives are markers and "falling" evidence, never logged | D6, §4.6 item 1 |
| 23 | Gas variable storage (minor) | Normalised pseudo-pressure, optional pseudo-time for the build-up period; μ·ct at the build-up average pressure (stated); condensate flag | §4.6 item 1, Q17 |
| 24 | Reproducibility across JS engines (minor) | Display-precision canonical hashing, rounded decision inputs, resolved zones; seeded PRNG only (no `Math.random`, source grep); count-based slicing; yields outside the numeric path; sync = async test | §4.9, §8.4 |
| 25 | Line-vs-match threshold vs 34 (minor) | One rule in `PRiSM_autoInterp.DEFAULTS.agree` (k 5 %, S 0.5) for both the page and the Skin check; 34's check compares against the derivative plateau, a different quantity, and is kept and labelled separately | D9 |
| 26 | In-app benchmark cost (minor) | The precomputed tables per version (file 55); an in-app 24-case check on demand; the full benchmark offline only; 10 cases in acceptance | §5.5, §5.6 |
| 27 | Several shut-ins per day; no clean days (minor) | Fewer than 2 clean days within ±10 days → "unavailable" (not a pass, label ≤ medium); equal-rate assumption flagged per test; flush hours excluded from clean days; trend off by default for tests less than a day apart | §4.5, §5.1 |

---

## 13. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The two-zone kernel misses its speed target | Composite fits block the UI too long | Composite leaves the automatic race (Q27); the registry composite is never run in a work unit |
| Sliced LM fits converge more slowly than unsliced ones | More slices per test | λ and the plateau counter carried between slices (`lmState`), no per-slice initial evaluation or statistics (`slice:true`); EN20 asserts sliced = unsliced; WP1 measures |
| Calibration cannot reach the targets for both tables | Few "high" labels | Stricter thresholds (never relaxed targets), LOW thresholds in the grid for the medium target; record in PROJECT-NOTES; the labels stay honest |
| Karakas–Tariq table not verifiable in time | No perforation split | Q7 default: perforation skin hidden |
| Quota pressure from `wts_buildup_state` | Failed saves or a blocked well switch | 300 kB budget, steps stored once, recomputable arrays dropped, overflow to IndexedDB, writes through `WTS_lsSet`; ST5 tests 60 tests × 3 wells with a well switch |
| Historian retention (30 days default) | A year of data unavailable | The page explains how to raise retention; CSV path |
| Time-zone settings misunderstood | Wrong rates | Zones resolved and shown by name; offset scan and V16 warning; settings echoed in S2 |
| Generated benchmark runtime larger than planned | Slow calibration iterations | Records capped at 500k samples, log-grid forward model; WP4 measures and updates §5.5 |
| Phone target missed | "A few seconds" not met for 8 tests | 50 ms units keep the UI responsive; cache re-runs only new tests; a miss is recorded (Q29) |
| HTML size grows by about 0.7 MB | Slower start | All code inert until the page opens (no work at load); measured in WP9 |
| Parallel WPs drift from the contracts | Integration failures | `_buildup-shapes.js` frozen; shape checks in every WP; `FIX` refreshed from real output after WP2/WP3; integration test last |
| The DFIT workstream edits the same Round-8 list or sidebar group | Merge conflicts, a full sidebar group | D25: numbers 53–55 vs 56+, the lead as the only FILES editor, DFIT in Well Test & Flowlines |

---

## 14. References (author, year, title, SPE number; "no. to verify" numbers are never shown in the app)

- Agarwal 1980, "A new method to account for producing time effects when drawdown type curves are used to analyze pressure buildup and other test data", SPE 9289.
- Agarwal 1979, "Real gas pseudo-time — a new function for pressure buildup analysis of MHF gas wells", SPE 8279.
- Agarwal, Al-Hussainy & Ramey 1970, "An investigation of wellbore storage and skin effect in unsteady liquid flow: I. Analytical treatment", SPE 2466.
- Al-Hussainy, Ramey & Crawford 1966, "The flow of real gases through porous media", SPE 1243-A.
- Athichanagorn, Horne & Kikani 2002, "Processing and interpretation of long-term data acquired from permanent pressure gauges", SPE 80287.
- Bourdet, Ayoub & Pirard 1989, "Use of pressure derivative in well-test interpretation", SPE 12777.
- Brons & Marting 1961, "The effect of restricted fluid entry on well productivity", SPE 1322-G.
- Cinco-Ley, Ramey & Miller 1975, "Pseudo-skin factors for partially-penetrating directionally-drilled wells" (no. to verify).
- Cragoe 1929, "Thermodynamic properties of petroleum products" (monograph; condensate molecular weight from API gravity).
- Earlougher 1977, "Advances in well test analysis" (monograph).
- Fair 1981, "Pressure buildup analysis with wellbore phase redistribution", SPE 8206.
- Gringarten 2008, "From straight lines to deconvolution: the evolution of the state of the art in well test analysis", SPE 102079.
- Gringarten, Bourdet, Landel & Kniazeff 1979, "A comparison between different skin and wellbore storage type-curves for early-time transient analysis", SPE 8205.
- Hegeman, Hallford & Joseph 1993, "Well-test analysis with changing wellbore storage", SPE 21829.
- Hemala & Balnaves 1986, "Tidal effect in petroleum well testing", SPE 14607.
- Horne 1995, "Modern well test analysis: a computer-aided approach" (book).
- Karakas & Tariq 1991, "Semianalytical productivity models for perforated completions", SPE 18247.
- Lee & Holditch 1982, "Application of pseudotime to buildup test analysis of low-permeability gas wells with long-duration wellbore storage distortion", SPE 9888.
- Meunier, Kabir & Wittmann 1987, "Gas well test analysis: use of normalized pseudovariables", SPE 13082.
- Papatzacos 1987, "Approximate partial-penetration pseudoskin for infinite-conductivity wells", SPE 13956.
- Ramey 1970, "Short-time well test data interpretation in the presence of skin effect and wellbore storage", SPE 2336.
- Satman, Eggenschwiler & Ramey 1980, "Interpretation of injection well pressure transient data in thermal oil recovery" (no. to verify).
- Swift & Kiel 1962, "The prediction of gas-well performance including the effect of non-Darcy flow", SPE 143.
- van Everdingen & Hurst 1949, "The application of the Laplace transformation to flow problems in reservoirs" (no. to verify).
- Watson, Gatens & Lane 1988, "Model selection for well test and production data analysis", SPE 15926.
- Statistics: Wilson 1927, "Probable inference, the law of succession, and statistical inference"; Mann 1945, "Nonparametric tests
  against trend"; Theil 1950, "A rank-invariant method of linear and polynomial regression analysis"; Brier 1950, "Verification of
  forecasts expressed in terms of probability"; Page 1954, "Continuous inspection schemes"; Sen 1968, "Estimates of the regression
  coefficient based on Kendall's tau"; Murphy 1973, "A new vector partition of the probability score"; Hampel 1974, "The influence curve
  and its role in robust estimation"; Schwarz 1978, "Estimating the dimension of a model"; Rousseeuw & Croux 1993, "Alternatives to the
  median absolute deviation"; Kass & Raftery 1995, "Bayes factors".

---

## Appendix A. Reference tables

### A.1 Storage correlation (seeding only)

From Stehfest type curves of the homogeneous model with WBS and skin (infinite-acting, 0 ≤ S ≤ 8, 220 ≤ C_D ≤ 22,060;
t_D/C_D = 0.0002951·k·h·t/(μ·C), i.e. t = 3,389·(t_D/C_D)·C·μ/(k·h)). Reference case: k 45 md, S 5, C 0.02 bbl/psi, h 50 ft, μ 1 cp.

| Event | t_D/C_D | Field units, hours | Reference case |
|---|---|---|---|
| Δp slope leaves unit slope (< 0.9) | 0.86 + 0.22·S | (2,900 + 750·S)·Cμ/(kh) | 0.06 h |
| derivative maximum (hump) | 6.3 + 1.0·S | (21,400 + 3,390·S)·Cμ/(kh) | 0.34 h |
| derivative stays within ±10 % of m′ | 143 + 27·S | (485,000 + 91,500·S)·Cμ/(kh) | 8.4 h |
| derivative stays within ±5 % of m′ | 286 + 46·S | (969,000 + 156,000·S)·Cμ/(kh) | 15.5 h |
| classic "start of semilog line" | 60 + 3.5·S | (200,000 + 12,000·S)·Cμ/(kh) | 2.3 h |

Use in the engine: only the first two rows, to seed C when the unit slope is missing. The ±10 % and ±5 % rows are **not** used for the
reach, KL7, T-none, k-held eligibility or V9: they go negative for S below about −5.3 and −6.2 and are untested outside the fitted range;
the engine computes t_10 % and t_5 % numerically from the fitted model (§4.6 item 5b). The classic rule is 2.4–4.1× optimistic for the
±10 % band and 4.8–7.5× for ±5 %.

### A.2 Input sensitivity (homogeneous line and match; exact)

| Input × f | k | ΔS | f = 1.2 | f = 0.8 |
|---|---|---|---|---|
| h | k/f | +1.1513·log10 f | k −16.7 %, S +0.091 | k +25.0 %, S −0.112 |
| φ, ct | — | +1.1513·log10 f | S +0.091 | S −0.112 |
| rw | — | +2.3026·log10 f | S +0.182 | S −0.223 |
| B | k·f | −1.1513·log10 f | k +20 %, S −0.091 | k −20 %, S +0.112 |
| μ | k·f | 0 | k +20 % | k −20 % |
| q (±10 %) | k·f | −1.1513·log10 f | k +10 %, S −0.048 | k −10 %, S +0.053 |

C ∝ q·B; distances scale as √(k/(φμct)). A uniform input error shifts every test's S by the same ΔS, so S − baseline is unchanged
(exact for homogeneous); the absolute alert moves by at most ±0.22 for ±20 % inputs. Gas with normalised pseudo-pressure: the same table
with B → B_gi and μ → μ_i. With the typical ranges of `WellInput.sens` (h 20 %, φ 10 %, ct 30 %, rw 5 %, B 5 %, μ 20 %, q 10 %) the largest
|ΔS| comes from ct (+0.131 / −0.178).

### A.3 k-stability interpretation (T9)

| k | S | Reading |
|---|---|---|
| stable | rising | change near the well (damage or a pseudo-skin change), not the formation |
| falling | rising | mobility change (water cut, gas), model switch, or a rate basis problem; check R7 and K2 |
| stable | stable | no change |
| drifting with the rate allocation | ≈ stable | allocation drift (k ∝ q, S changes only by −1.15·log10 f) |

One gauge cannot separate gauge drift from depletion in the pressure trend; interference from offset wells also moves p*.

### A.4 Measured basis for the budgets (desktop, planning measurements on this checkout)

| Item | Measured |
|---|---|
| One 60-point pd + pd′ (tD 1e-1…1e7) | homogeneous 3.9 ms (7.2 ms with S = −3); radialComposite 41 ms; linearBoundary 9.0 ms; closedRectangle 189 ms; closed-circle prototype 1.2 ms |
| `PRiSM_fitPhysical('homogeneous')`, 120 points, log objective | single rate: 223 ms with 3 starts, 65 ms with one; 30 daily steps 1.0 s (one start); 120 steps 4.4 s; 365 steps 12.0 s |
| Rival fits on single-rate synthetic data (one start) | linearBoundary 0.54 s; radialComposite 24.3 s with F free (not converged at 60 iterations); closedRectangle 88.6 s, converged to a wrong minimum |
| `PRiSM_semilogAnalysis` | 5–13 ms |
| `PRiSM_deconvolve` | 1.6–1.8 s, synchronous |
| Compaction (365 days, ±15 % daily variation, 72 h build-up) | Horner single rate: 0.76 psi, 1.0 %; keep 10·Δt_end + one volume-mean block (32 steps): 0.07 psi, 0.10 % (0.10 psi, 0.13 % at ±35 %) |
| pd grid with Hermite interpolation (8–12 points per decade) | homogeneous 365 steps 591 → 7.5 ms; radialComposite 4,176 → 46 ms; linearBoundary 1,653 → 15 ms; max error 0.010–0.017 psi (closed circle: bounded form only, CC4) |
| C-held refits, σ 0.05 psi, single rate | 147 ms each; ΔBIC of the log objective without n_eff or floor in the hundreds, which is why D8 adds both |
| One-shot CSV parse | 50k / 200k / 500k rows: 285 / 1,129 / 3,445 ms |

---

## Appendix B. Review notes

The engineering and architecture review of this plan raised 81 items: 5 blockers (2 engineering, 3 architecture), 39 majors and 37 minors. All blockers and majors are
fixed in the sections named in the review. Minors are fixed as proposed, except the following, which were resolved differently:

- **Work-unit size.** One review item asked for `unitMs` 50 and another for 60. The plan uses **50 ms** (150 ms on a phone): it meets both
  and leaves margin below the requirement's ~200 ms (§4.8, Q28).
- **Registry-composite fallback.** The proposal was to exclude it on phones or to split its Jacobian by column across steps. A
  device-dependent model set would break reproducibility across devices, and a column-split Jacobian needs a resumable LM inside
  `PRiSM_lm`. The plan instead removes composite from the automatic race when the two-zone kernel misses its target (Q27), with a flag
  and a model-label cap.
- **BIC definition.** Of the two options offered, the plan computes BIC on the log-Δp block (no extra evaluations, scale-free, the
  residuals the fit minimises) rather than polishing with a psi objective (§4.6 item 6, D8).
- **S_k.** Of the two options offered, the plan uses the two extra k-held refits as the value and reports the analytic first-order value
  as a cross-check (EN18 requires them to agree within 20 %).
- **Full rebuild.** "Rounds 1-2 through 10" is followed except Round 7, which CLAUDE.md reserves for the simulator workstream; Rounds 4/5
  are unchanged and not rebuilt (§9 WP9).
- **Phone target.** The plan targets ≤ 5 s for 8 tests and records a miss in §11 rather than relaxing the 150 ms unit budget (Q29).
- **Daily Quick Report.** Final template only (Q10 → No), so no daily-template test edits are needed.
- **`f̂` derivative-ratio method.** The plan uses late Δp differences between two times (`dpDiff`), which needs no fitted reach at
  classification time; the derivative ratio at a common IARF time is equivalent where both tests have IARF, and the pass-2 m′-ratio check
  keeps it for interpreted tests (§4.3).
- **Signature content.** `runAt` and `appVersion` are removed from the hashed content (not only from the CHANGED decision), so the stored
  signature stays valid after a re-run or an app update (§8.4).

---
