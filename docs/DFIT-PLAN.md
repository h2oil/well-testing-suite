# DFIT module in PRiSM (v3.4) — implementation plan

> **Status: shipped in v3.4 (3.4a); 3.4b open** (2026-11-07). 3.4a (WPH, WP0–WP7) is integrated, reviewed and released as v3.4;
> Appendix D records the integration amendments. In 3.4a every closure / ISIP / p_i label, the grade and the leak-off type are shown as
> "provisional — not yet calibrated" (WP7: the benchmark does not yet support more; the leak-off type in particular often differs from the
> true mechanism); 3.4b (v3.4.1: WP8 calibration, WP9 live listeners, WP10 field tests, WP11 model extras, WP12 lenses, WP13) is open.
> Earlier status (WP0, 2026-11-07, on top of v3.3.3): WP0 (contracts and skeleton, §9) is in: the frozen
> fixtures `prism-build/tests/_dfit-shapes.js` (all §3.13 names, the §3.2 range table, `FIX.ds` / `.state` / `.run` / `.aca`,
> `sharedApp`, `resetDfit`; resolutions at the end of §3.13), `tests/dfit-shapes.test.js` (SH1, SH2), the stub skeletons of
> 56–59 and of the five Round-9 helpers, and 56–59 in the Round-8 FILES list. The engine and UI work packages (WPH, WP1–WP6,
> WPT) start from here; test counts in this plan are relative to the v3.3.3 gates (smoke 330, acceptance 1,369).
> Plan history: reviewed 2026-10-31. This revision resolves the theory, novelty and architecture review (every blocker, major and minor); Appendix C
> ("Review notes") lists the points that were resolved differently from the reviewer's proposal and why. The module is our own
> design. No other software product, vendor, company or website is named in it, cited by it or compared with it by name; the
> state of the art is described generically ("commercial DFIT packages commonly …"). Literature is cited by author, year, title
> and SPE number only. An SPE number marked "no. to verify" never goes into the app.

| | |
|---|---|
| Release | **v3.4**, after v3.3 (Build-up Surveillance). Built in two gated increments: **3.4a = app version 3.4** ("DFIT analysis") and **3.4b = app version 3.4.1** ("DFIT in the field") |
| Where | Inside PRiSM, as a fourth **workspace mode** `PRiSM.mode = 'dfit'` (next to transient / decline / combined), registered through a new generic mode-extension registry `window.PRiSM_modeExt`. Header test-type select option "DFIT (fracture injection)". The well's PTA test type stays `falloff` underneath. Several DFITs of one well (stacked zones) live side by side in one state object; the 3.4a UI shows one at a time |
| Namespaces | `window.PRiSM_dfit_*` (pure engines and UI entry points, Round 8). `window.WTS_wellbore` (shared surface ↔ bottomhole, step-test and ramp engine, Round-9 helper). `window.PRiSM_dfit_triage` / `_blunders` / `_repump` (triage gate, Round-9 helper). `window.WTS_dfitInfo` (method notes dialog, Round-9 helper). `window.PRiSM_dfit_synth` (synthetic DFIT generator and scorer, Round-9 helper). `window.PRiSM_dfit_cal` (generated calibration table, Round-9 data module) |
| New files (3.4a) | Round 8: `56-prism-dfit-core.js`, `57-prism-dfit-aca.js`, `58-prism-dfit-leakoff.js`, `59-prism-dfit-ui.js`. Round-9 helpers (no page): `48-calc-wellbore.js`, `49-calc-dfit-triage.js`, `49-calc-dfit-info.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (generated). Tool: `prism-build/dfit-validate.js`. Tests: 17 `tests/dfit-*.test.js` files (≈ 210 tests, **≤ 60 s in total**) plus one helper `tests/_dfit-shapes.js` |
| New files (3.4b) | Round 8 (explicit FILES names, added by the lead): `57-prism-dfit-acamodel.js`, `59-prism-dfit-dragfit.js`, `59-prism-dfit-fieldtools.js`, `59-prism-dfit-lenses.js` (stretch), `59-prism-dfit-live.js`. Round 9: `48-calc-wellbore-field.js`. Tests: 4 files (+ 1 stretch), ≈ 30 tests, ≤ 15 s |
| Edited files (generic hooks only, no DFIT logic) | `01-foundation.js`, `02-plots.js`, `04-ui-wiring.js`, `05-regression.js` (one export), `07-data-enhancements.js`, `11-polish.js`, `29-project-save.js`, `30-quick-report.js`, `33-pta-core.js`, `35-rta-dca.js`, `36-report.js`, `37-prism-workflow.js` (WPH); `29-multiwell.js`, `smoke-test.js`, `gui-sweep.js`, `ux-layout-check.js`, `ios-webkit-check.js`, `ios-styles.css` (WP6); `concat-round8.js` (lead); host `well-testing-app.html` (two job-report lines, release notes); iOS version stamps; README, CLAUDE.md, PROJECT-NOTES |
| File numbers | Round 8 **56–59 only** (the review allows 55–59; 53–55 are used by the Build-up Surveillance plan: `53-prism-autointerp.js`, `54-prism-skin.js`, `55-prism-autointerp-cal.js`); 6N is live data. Anything that does not need the PRiSM shell goes into Round-9 helper modules (the pattern of `40-calc-tubulars.js`, `49-calc-cheminj-info.js` and the build-up helpers) |
| Inputs to this plan | The DFIT requirements brief and seven research notes in the session scratchpad folder `shutin/dfit/` (`preclosure.md`, `afterclosure.md`, `leakoff.md`, `related.md`, `landscape.md`, `prism.md`, `ideas-judged.md`) with their verification scripts, the review of this plan and its check scripts (`_theory/`), the revision checks (`_rev3/`), CLAUDE.md, and the Build-up Surveillance plan as a model of format. This plan copies everything a builder needs; the notes hold the derivations |

**Conventions.**
- Field units throughout. Engine time is in **hours**; DFIT displays show minutes for the pre-closure period and hours or days after
  closure (display only, never stored). Pressure psia (psi for differences), rate bbl/min in every DFIT-specific object (the PRiSM
  dataset keeps bbl/d), volume bbl, length ft, permeability md, viscosity cp, compressibility 1/psi, E′ in psi (UI in 1e6 psi),
  CL in ft/√min, spurt in gal/100 ft², toughness in psi·√in, temperature °F, gradients psi/ft, density ppg. §3.0 fixes the unit of
  every public field.
- ΔtD = Δt/tp. "G" is the Nolte G-function. "F0…F4" are closure-method **families** (§4.7; always written "family F2" where a test
  id could be meant). "ACA" = after-closure analysis. **T** = the active test, `st.dfit.tests[i]` with `id === st.dfit.active` (§3.3).
- `V_i*` = injected volume net of fill and of the wellbore compression up to closure (§4.3); `C_sys` = system compliance
  A_f·c_f + V_w·c_w (§4.6); `τ` = the closure tolerance scale (§4.8); `s_D` = the local log-log slope of the p_i-free derivative D
  after closure (§4.12).
- Confidence tags on methods: **[H]** verified by closed form or by our own prototype, **[M]** plausible with stated open items,
  **[L]** indicative only.
- "Desktop" timings come from the research prototypes on the audit server (single thread). "Phone" means × 3. Acceptance tests never
  assert wall-clock times tighter than 5 × the target (§8.6).
- Evidence ids look like `C2` (closure item 2) or `A4` (after-closure item 4); §6.10 fixes the groups. Test ids carry a file
  prefix where they could clash (`LF1` leak-fit, `I3` integration, …).

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where DFIT lives | PRiSM workspace mode `dfit` through a generic `PRiSM_modeExt` registry (§2.1, option B). Not a new test type, not a separate page | A DFIT *is* an injection falloff for every PTA purpose (sign, tp, superposition); a `'dfit'` test type would touch 35 `'falloff'` checks in 14 files. A mode reuses the header, steps, rail, Tools, undo, report tab, plot picker and PDF gallery once the shell honours the ext hooks of §2.3 |
| D2 | Files | Round 8: 56 core (pre-closure), 57 after-closure + results layer + the pure pipeline, 58 leak-off mini-model + designer, 59 UI. Round-9 helpers: `48-calc-wellbore.js` (`WTS_wellbore`), `49-calc-dfit-triage.js`, `49-calc-dfit-info.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` | 53–55 are taken by the build-up plan; the wellbore path and triage are engines other pages and the live tool can reuse; triage is its own work package so the pre-closure core stays on schedule |
| D3 | Prerequisite | O(n) sliding-window Bourdet derivative in `PRiSM_compute_bourdet` (02) and in `_bourdetOnLn` (33), identical output, including NaN, duplicate-t and t ≤ 0 inputs. 04:433, 11:1570 and 36:310 call `PRiSM_compute_bourdet` first and inherit it (their fallback loops stay). The separate O(n²) loops in `13-auto-match.js:125` and `34-semilog-skin.js:124` are a follow-up (§9, out-of-module). Plus an O(n) log-from-shut-in resampler in 56 | The current walk-outwards loop is O(n²): C2 takes 849 ms at 2,000 and 3,288 ms at 4,000 evenly sampled falloff points; a two-pointer window computes the same derivative in 0.15 ms (max relative difference 0 on 3,938 points) |
| D4 | Data | The DFIT dataset is the PRiSM dataset (`t` h, `p` psia at the primary gauge, `q` bbl/d) plus optional parallel channels (`pSurf`, `pBh`, `qFb`, `T`, `pAnn`) mapped by new column roles in 07 so they survive a reload. **07 stays the single psig conversion point** (fixed 14.696, recorded in `ds.meta.psigConverted`); a test's own `atmPsia`, channel flags, unit and blunder fixes, mask and clock offset live in `T.inputs.channels` and are applied non-destructively by `PRiSM_dfit_prepare`. Each test is bound to a dataset hash. High-rate windows go to `PRiSM_storage` (IndexedDB) keyed by that hash | Extra arrays are lost on reload today (07 knows only t/p/q roles); rewriting `PRiSM_dataset` would break reloads, undo and project files |
| D5 | C2 use | DFIT writes `testType:'falloff'` and an idealised two-step schedule into `PRiSM.multiRate` (q_eq = (V_i − V_fill − V_fb)/tp_veq, §4.3; undoable). It builds its own ISIP-referenced and p_i-referenced arrays; C2 is used only for the standard log-log and the PTA hand-off. **Only 59 writes `multiRate` and C1** | Auto-detect reads a positive-rate DFIT as a build-up; pump noise with > 20 steps flips C2 to variable-rate; the wellbore-compression volume enters the formation after shut-in and belongs to the impulse |
| D6 | G-function | Closed forms for α = ½ and α = 1, general α by 64-point Gauss–Legendre, and a data-driven G from the real rate history (or from the mini-model's area history, g = B_w/(A_L,s·√tp)). The G type is printed on every plot. The same α is used for G and for η; the α pair is shown whenever it changes η by more than 0.01 | Real DFITs have ramps, breakdown surges and two cycles; Gc/(Gc+2) on an α = 1 G is a common pairing error (up to 0.025 in η) |
| D7 | One derivative engine | `PRiSM_compute_bourdet` (after D3) for G·dP/dG (= dP/d ln G), √t·dP/d√t (= 2·dP/d ln Δt), the pre-closure log-log derivative (always on Δt) and D after closure; the primary pressure derivative dp/dΔt is D/Δt | One noise model, one smoothing parameter L, testable identities |
| D8 | ISIP | Four estimates in three families (water-hammer midline fitted with the friction bleed-off term, early-G extrapolation, step-down intercept / last pump minus friction and minus the in-fracture viscous redistribution), inverse-variance consensus with spread and label; extrapolate on G, never on √t at early time. A wave estimate whose bleed-off has not died out is an "upper estimate" | √t extrapolation over the first minutes reads 22–28 psi high in the reference case; a linear midline over a decaying friction transient reads tens to hundreds of psi high |
| D9 | Closure | Every recognised method runs. Methods are grouped into dependence-aware families (F0 fissure closure, F1 first stiffening, F2 end of stiffening, F3 model-based cross-checks, **F4 reopening** from re-pressurisation ramps). Each voting family has one independent member; log-log departure counts as the compliance member, not a second vote. Family bands come from the stability grid and the bootstrap. One tolerance scale τ (§4.8) sets single vs range and the label. Two-tier frictional-limit check (veto below the μ = 1.0 bound, warning above it). Overrides are logged with a reason. Never a silent single value | The closure dispute (100 to 1,000+ psi between methods) is the main pain point; a √t pick repeats the tangent pick, and a log-log departure repeats the compliance test |
| D10 | Downstream consistency | Each closure candidate carries its own consistent chain (Gc, η, C_sys, A_f·c_f, pn, χ, CL, geometry, leak-off rate) in a what-if table; every downstream number states which candidate it uses. In range mode every closure-dependent output is reported per family, never as a pooled median | Swapping only the closure pick into a chain built for another pick is the error the literature warns about; a pooled median of a bimodal mixture corresponds to no interpretation |
| D11 | Leak-off type | Rule-based classifier on numeric features (intercept ratio ι, dP/dG trend κ against the *expected* curvature κ_exp from a reservoir-controlled mini-model run and the wellbore's pressure-dependent compressibility, hump H, D/D_ref, the storage-consistent closure visibility R_vis, measured vs theoretical V_w·c_w, friction bleed-off check) with evidence sentences; dual readings when two classes score within 0.15 (always for height recession vs asperity contact) | No tool classifies with reasons; reservoir-controlled leak-off is routinely mislabelled as PDL or tip extension |
| D12 | After-closure | p_i-free derivative diagnosis (D = t·\|dp/dt\|) as the primary view, with every regime threshold tabulated **for s_D**, the statistic actually tested; centroid time origin t − t_c/3 by default; three p_i brackets intersected (the derivative bracket holds through the linear-to-radial hump); bounds [k_lo, k_hi] with the binding constraint named when radial flow is not reached; impulse → constant-rate transform so any PRiSM model can be matched. No empirical closure-time permeability correlation is shipped | Total time and time-since-closure origins misdiagnose regimes; false radial reads k 100× or more high |
| D13 | Gas | Adjusted pressure (anchored at p_i, so intercepts read in psia) and pseudo-time through `PRiSM_mpTable` and `PRiSM_gasPseudoTime`, p_i iterated (≤ 3 passes); forced when (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia | Pseudo-time stretches the early after-closure clock about 1.5× even at 5,000 psi |
| D14 | Leak-off mini-model | Lumped PKN/KGD/radial fracture, exact Abel bookkeeping of a piecewise-linear area history, two-part leak-off (wall C_w + reservoir-controlled Duhamel parameterised by **log k**), default reservoir-controlled for water-based fluids, semi-implicit step (one bracketed monotone root per step, relative tolerances), aperture laws that never give a negative width. Apparent toughness labelled "not a rock property" | Reproduces Nolte to 1e-14 (α = 1); one engine from injection through closure into after-closure flow |
| D15 | History match | `PRiSM_lm` with presets, priors and multi-start; the identifiable group **Γ = r_p·CL·A_f/C_sys = 2·m_G/(π·√tp)** is primary (PKN form Γ_PKN = r_p·CL·E′/h_f = (π/2)·Γ/R_vis); intervals inflated by n_eff and by the spread across closure laws. The fit never goes through `PRiSM_setLastFit` (C4) | A falloff fixes only Γ (E′, hf, CL and toughness correlate at \|r\| ≥ 0.997); perfect-model intervals are 4–14× too narrow |
| D16 | Uncertainty | Seeded Latin hypercube (default n = 1,000, cap 2,000) through the closed-form chain. In range mode the closure is resampled **per family** and every closure-dependent output is reported as conditional P10/P50/P90 per family plus an envelope; the family weight is an explicit, logged "interpretive weight" (default 50/50); first-order variance shares by quantile binning; tornado; seed stored | No tool propagates picks and inputs to every output |
| D17 | Labels | Rule-based on one tolerance scale τ = max(15 psi, 0.3 % σ_c, 3 % pn) in 3.4a and marked "uncalibrated". 3.4b calibrates them per mode (single / range) on a 900-case synthetic benchmark (Wilson intervals, out-of-fold; ranges scored with an interval score) into the generated `49-calc-dfit-cal.js` | Thresholds relative to pn alone degenerate for small pn; pooled hit rates let wide ranges buy accuracy |
| D18 | Live | Replay engine in 3.4a (on recorded data; a "first available" table in the Replay tool). Replay timeline UI, live listeners and the live tile in 3.4b: `wts:modbus-samples` / `wts:historian-updated` on `document`, engines resolved at call time, psig → psia, each block processed by one drive job (no other timer), released on `h2oil:pagechange`, `wts:project-new`, `wts:project-loaded`, mode leave and tool close. The live closure CUSUM runs on decimated or prewhitened **pressure** residuals. Never polling | Smoke test fails on pending timers; Round-9/10 engines load after Round 8; serially correlated derivative residuals make a nominal CUSUM fire early |
| D19 | Hand-off | One button per target. PTA: `PRiSM_setWell` (falloff, tShut, tp, pwf0 = ISIP, pi) with source `'dfit'`, the schedule into `multiRate`, model `infiniteFrac`/`finiteFrac`/`homogeneous` seeded with xf and k, `setMode('transient')`, `PRiSM_gotoStep(3)`. RTA: k constraint through a 3-line fallback in 35. Frac design: a ranged sheet (CSV + report section) with both family columns in range mode and geomechanics rows | Landscape gap: DFIT, PTA and frac design live in separate tools today |
| D20 | Persistence | `st.dfit = {v, active, tests[], plan, live}` (decisions, picks, inputs, small summaries per test) in `STATE_FIELDS` → `wts_prism_state`, and `'dfit'` in the project writer's `PRISM_KEYS`; undoable through a generic `PRiSM_undoExtras` hook that snapshots **decisions only** (≤ 10 kB); the runtime result lives on `st._dfitRun` (never saved); derived arrays recomputed; high-rate windows in `PRiSM_storage`. DFIT-only inputs (E′, ν, heights, depths, strings, perforations) live in `T.inputs`, because `PRiSM_setWell` silently drops keys that are not PVT store fields | `16-pvt.js:794` skips unknown keys; the project writer copies `PRISM_KEYS`, not `STATE_FIELDS`, and drops `extra` above 200,000 characters |
| D21 | Contracts and events | New C1 provenance value `'dfit'` (documented and tested; `setWell` already accepts free text). New events `prism:dfit-updated` and `prism:dfit-model-updated`; generic `prism:plot-hover` | Keeps C4 and the PTA listeners untouched |
| D22 | Report | One report section per DFIT group (headline, board, what-if, ACA, type, triage, step tests, model, uncertainty, hand-off, log), each with `fn.modes = ['dfit']` and the new generic `blocks` list (kv, table, verdict, notes, plot); mode-aware header and key line; an "Ev." column and an evidence appendix; the quoted-value check runs as a self-check that prints only on failure; append-only pick log; data + picks ASCII export with a column template; an A–D test-quality grade; frac-design sheet | Reports and the header Quick Report capture DFIT with no host logic beyond two generic lines and one 30-quick-report line |
| D23 | Units | Field units only; PRiSM keeps `#prism_units_note` in Metric mode; DFIT controls are not tagged with `WTS_units.tagInput`; one display ↔ engine conversion table (`PRiSM_dfit_units`); numeric inputs parsed with `WTS_parseNumber` and clamped to the §3.2 range table | PRiSM is field-unit only |
| D24 | Standalone leak-off tool | The "what leak-off rate do I get?" sandbox runs inside PRiSM with **no data loaded**. Its Tools-drawer entry is registered for **every** PRiSM mode and switches to DFIT mode at step ④ → Leak-off model on open. No new sidebar row in v3.4 (Q4) | Production & Reservoir reaches 7 of 8 rows with Build-up Surveillance; the owner's mini-model must be one click from any PRiSM view |
| D25 | What we never do | No black-box machine-learning closure predictor; no claim of a single "true" closure; lenses and method notes labelled by method, never by person or school | Cannot be validated offline; the dispute is open |
| D26 | Budgets | ▶ Analyse ≤ 1.5 s desktop for a 2,000-point falloff (stability grid over the closed-form methods ≤ 600 ms, chunked); redraw ≤ 30 ms; mini-model ≤ 50 ms at N ≈ 1,840; history match ≤ 1 s; 1,000-draw uncertainty ≤ 60 ms; designer (500 coarse runs) ≤ 1 s chunked. These targets are checked by `dfit-validate.js --perf`; acceptance tests assert evaluation counts and scaling ratios with ceilings ≥ 5 × the target. **All 3.4a acceptance additions run in ≤ 60 s** | Measured on the prototypes; phones × 3; the harness clock is virtual and CI machines are slower |
| D27 | Version | 3.4a ships as **v3.4**, 3.4b as **v3.4.1** (`RELEASE_NOTES[0].ver`, MARKETING_VERSION ×2, VERSION_BASE ×2) | Same pattern as 3.2a / 3.2b |
| D28 | Runtime result and pipeline | One runtime type `DfitRun` (§3.3a) and one pure, synchronous `PRiSM_dfit_pipeline(ds, inputs, well, picks, opts) → DfitRun` with a `Job` twin and `PRiSM_dfit_summarise(run)` (57). ▶ Analyse, undo/drag previews (`opts.fast`), replay, live, the benchmark and `dfit-validate.js` all call it; no other code re-implements the stage order | Untyped "state" parameters and a pipeline that existed only inside the UI would be re-implemented four times |
| D29 | Several DFITs per well | `st.dfit.tests[]` (≤ 12) from WP0, each bound to its dataset; a "Tests in this well" table, a closure / ISIP / p_i gradient-vs-TVD plot and an overlay of normalised G·dP/dG in 3.4a; no pooling or depletion logic until R2 | Stacked DFITs give the stress profile and the stress contrast for height containment; changing the frozen state later would break every fixture |

---

## 1. Scope, users and user stories

### 1.1 What the module does

A diagnostic fracture injection test (DFIT, mini-frac, fracture calibration test) pumps a small volume (typically 10–50 bbl)
at a constant rate for a few minutes, breaks the formation down, creates a small fracture and then shuts in for hours to weeks.
The module turns the recorded injection and falloff into:

- **before closure**: ISIP, closure pressure (σ_hmin) as a value or a range with a confidence label, net pressure, fluid
  efficiency, leak-off type, leak-off coefficient (with the group the test actually determines), fracture geometry (PKN, KGD,
  radial) with E′, leak-off rate and cumulative loss, and the before-closure permeability estimates (k from CL and the h-function,
  each with its known bias);
- **after closure**: flow regime, reservoir pressure with a bracket, transmissibility kh/μ and permeability, or bounds on k when
  radial flow never appears; gas wells in adjusted variables;
- **related tests**: step-down (perforation versus near-wellbore friction, open perforations), step-rate (fracture extension
  pressure with a band; superposition parting detection and the Hall plot in 3.4b), re-pressurisation ramps (reopening pressure as
  an independent closure family; the leak-off point of a drilling leak-off or formation-integrity test), pump-in / flowback (3.4b),
  water hammer (period, reflector, connection);
- **several DFITs in one well**: a test table, closure / ISIP / p_i gradients against depth, an overlay of the normalised
  derivatives and a stress-log calibration offset per closure reading;
- **before the job**: a designer that says how long to shut in, what volume to pump, which gauge to run and what the test can and
  cannot tell;
- **during the job** (3.4b): a live co-pilot on the app's own Modbus / historian stack, with a closure forecast and a
  stop/continue verdict, usable offline on a phone at the wellsite;
- **a leak-off mini-model** that answers "what leak-off rate do I get?" with no data, and history-matches a recorded DFIT;
- **hand-offs** to PRiSM PTA (after-closure into a fractured-well model), RTA (k constraint) and a frac-design input sheet with
  ranges; and a report in which every number carries evidence.

### 1.2 Users

Completion / stimulation engineers (closure, net pressure, efficiency, CL for frac design), reservoir engineers (p_i, k, kh/μ
for PTA, RTA and field development), well-test and DFIT field supervisors (planning, live decisions, data health), geomechanics
specialists (stress gradient, stress-log calibration, stress contrast between stacked tests), drilling engineers (leak-off point
from a leak-off or formation-integrity test ramp), injection-well engineers (fracture extension pressure, step-rate tests),
reviewers and regulators (data + picks, evidence trail).

### 1.3 User stories (each is an acceptance item for the named test file)

| # | As a … | I want to … | So that … | Test |
|---|---|---|---|---|
| US1 | stimulation engineer | import a surface-gauge DFIT with rate in bbl/min and get a bottomhole pressure with an uncertainty band and flags for vacuum and column warm-back | I do not analyse a wrong conversion | dfit-wellbore, dfit-integration |
| US2 | any user | see within seconds whether the test is interpretable, which windows are usable, what went wrong and an A–D quality grade | I do not waste a day on a misrun | dfit-triage |
| US3 | stimulation engineer | get ISIP from several independent methods with a spread | net pressure and geometry carry an honest ISIP | dfit-preclosure |
| US4 | stimulation engineer | see every closure method on one strip, a single closure or a range, and why | I can defend the pick | dfit-closure |
| US5 | stimulation engineer | drag a what-if closure along the strip and see η, pn, CL and xf change consistently | I see the consequence of the interpretation choice | dfit-closure, dfit-uncertainty |
| US6 | reservoir engineer | get p_i with a bracket and k (or k bounds) without guessing p_i | I do not report a false radial k | dfit-aca |
| US7 | reservoir engineer | match after-closure data with PRiSM's fractured-well and composite models and hand p_i, k and xf to PTA in one click | DFIT and PTA agree (radial kh/μ within 2 %) | dfit-aca, dfit-integration |
| US8 | planner | enter ranges before the job and get the shut-in length, volume, gauge spec and expected outcome | the crew knows how long to stay and what they will learn | dfit-designer |
| US9 | anyone, from any PRiSM view | ask "what leak-off rate do I get?" for a planned job with no data | I can size the job and explain leak-off | dfit-leakoff, dfit-ui |
| US10 | analyst | history-match the recorded DFIT and be told which parameters it determines | I do not report E′ or CL as if measured | dfit-leakfit |
| US11 | stimulation engineer | split near-wellbore friction into perforation and tortuosity parts with an open-perforation range | I can plan the main treatment | dfit-wellbore |
| US12 | field supervisor (3.4b) | watch the falloff live on a phone with a closure forecast and a stop/continue verdict | I can release the gauge at the right time | dfit-livelisten |
| US13 | team lead | replay a recorded test and see when each conclusion first became available (table in 3.4a, timeline on the history plot in 3.4b) | we can set a shut-in policy from our own history | dfit-live |
| US14 | reviewer / regulator | export data + picks in a stated column layout and see every pick, override and reason | the interpretation is reproducible | dfit-report |
| US15 | gas reservoir engineer | analyse after-closure data in adjusted pressure and pseudo-time with p_i iteration | gas k and p_i are not biased | dfit-aca |
| US16 | frac designer | receive closure, ISIP, pn, η, Γ, CL and geometry as P10/P50/P90, with one column per closure family when the board shows a range | design inputs carry their uncertainty and no number belongs to no interpretation | dfit-uncertainty, dfit-report |
| US17 | injection engineer | get the fracture extension pressure of a step-rate test with a band and a per-step stabilisation check (3.4a); superposition parting detection, k, s and the Hall plot (3.4b) | the operating limit is objective | dfit-wellbore, dfit-fieldtests |
| US18 | geomechanics specialist | compare stacked DFITs of one well against depth and get a stress-log calibration offset for each closure reading | the stress profile and the stress contrast are calibrated | dfit-ui, dfit-integration |
| US19 | stimulation or drilling engineer | read the reopening pressure of a second cycle (or the leak-off point of a leak-off test) from the pressure–volume ramp | the closure dispute gets injection-side evidence | dfit-wellbore, dfit-closure |

### 1.4 Parity: what established tools commonly do, and where we cover it

Commercial DFIT capability lives in three generic tool families: fracture-design suites with a minifrac module,
pressure-transient suites with a DFIT analysis type, and newer DFIT-only applications. The rows below are what a user
expects from any of them (landscape matrix "Most"/"Some"). Every row is in 3.4a unless marked.

| Area | What established tools commonly offer | PRiSM DFIT |
|---|---|---|
| Data | Import time / pressure / rate / temperature; manual picks of pump start, breakdown, shut-in; resampling | Same, plus automatic events with refinement, pressure-increment + log-from-shut-in resampler, clock alignment (§4.1, §4.3) |
| Conversion | Surface → bottomhole by a constant gradient; friction table during injection | ρ(p,T) column with temperature models, Newtonian / friction-reduced / power-law friction, perforation and near-wellbore loss, uncertainty band (§4.2) |
| ISIP | Last-point, linear or √t back-extrapolation | Four estimates reconciled; G extrapolation; water-hammer midline with the bleed-off term (§4.4) |
| Pre-closure plots | G-function (p, dP/dG, G·dP/dG) with α = ½ and α = 1; √t with derivatives; log-log Δp and Bourdet derivative; primary pressure derivative (PTA-style tools); compliance-versus-pressure plot (newer tools); h-function plot (newer tools); pressure vs dP/dt for rapid closure (rare) | All of them (`dfitG`, `dfitSqrt`, `dfitLogLog` with a PPD toggle, `dfitCompliance`, `dfitH`, `dfitPdpdt`), plus general-α and data-driven G and the exact Nolte reference curve on the log-log plot (§4.5–4.6) |
| Closure | Tangent line, √t inflection, log-log departure; compliance method in newer tools; several picks listed side by side | All of them, plus variable-compliance fit, model closure and the reopening ramp, grouped in dependence-aware families with a consensus (§4.7, §4.15b, §6.2) |
| Outputs | Net pressure, ISIP and closure gradients, η ≈ Gc/(2 + Gc), CL, PKN/KGD/radial geometry with E′, spurt (frac suites) | Same, with matched-α η, a storage-consistent closure balance (C_sys from the data, A_f·c_f = C_sys − V_w·c_w), the Γ group, automatic geometry selection, spurt only with independent geometry (§4.9–4.10) |
| Before-closure permeability | G-function (k from CL) and h-function estimates with bias notes (newer tools) | Both, non-voting, beside the after-closure k, with the bias factor and its direction printed (§4.10) |
| Leak-off type | Visual overlays: normal, pressure-dependent / fissure opening, tip extension, height recession / transverse storage | Same signatures, classified automatically with evidence (§4.11) |
| After closure | Linear / radial identification on log-log; Nolte F_L / F_R; impulse lines; p_i from p vs t^−½ or t^−1; k from linear (with geometry) and kh/μ from radial; gas pseudo-pressure; far-field fracture extension pressure from early regimes (rare) | All, plus p_i-free diagnosis, bracket, centroid origin, bounds, model-library match (§4.12–4.13); the far-field extension pressure is an informational, non-voting reading |
| Step tests | Step-down: perforation (∝ q²) vs tortuosity (∝ q^½); step-rate: two-line break | Step-down with identifiability checks and open-perforation range; step-rate continuous hinge with a bootstrap band and a per-step stabilisation check (3.4a); superposition-corrected parting, Hall plot and injector limit (3.4b) (§4.14–4.15) |
| Several tests | Overlay of several DFITs (some) | Tests table, gradient vs TVD, normalised-derivative overlay (§6.12) |
| Modelling | Net-pressure history match with a pseudo-3D / planar simulator (frac suites); analytical falloff model across closure (PTA suites) | Lumped leak-off mini-model from injection through closure and after-closure, standalone and history match (§5). No pseudo-3D growth (out of scope) |
| Report | Plots, tables, picks, PDF; regulatory-style export (some); quality grading of the G-plot (newer tools) | Same plus an evidence column and appendix, pick log, data + picks export with a column template, an A–D test grade, frac-design sheet (§6.10) |

### 1.5 New features (selected from 44 candidate ideas; scored on value, novelty, soundness, feasibility, testability)

These are the headline capabilities that no surveyed tool documentation describes, or only as written guidance. Scores are out
of 25. Effort is on top of the baseline engines (S ≤ 400 lines, M 400–1,200, L more).

1. **Leak-off sandbox — the requested mini-model** (22, M, 3.4a; §5, §6.1). One engine runs a schedule through propagation,
   shut-in, closure and after-closure flow, and returns the leak-off rate split into wall, reservoir and spurt parts, cumulative
   loss, efficiency, closure time, geometry, the falloff and its own G-plot. It works with no data ("what leak-off rate do I get?",
   "what CL gives my observed closure time?") and as the history-match engine for a recorded test. A stacked bar shows where the
   pumped volume is (fracture / formation / wellbore) over time, and the card always shows the one group a falloff determines. It
   opens from the Tools drawer in every PRiSM mode.
   *Rationale:* a quick, transparent forward model exists today only inside full fracture-design suites; the owner asked for it;
   and the same engine feeds the designer, the identifiability card, the live forecast and our synthetic test data.
2. **Closure consensus board** (23, M–L, 3.4a; §6.2). Every closure method on one pressure strip, grouped in dependence-aware
   families with P10–P90 bars from the stability grid and the bootstrap, giving one closure or a closure range, a confidence label
   on one tolerance scale with the rules that fired, "why this pick?" (the plot window it used and a neutral method note), a
   two-tier frictional-limit check, the setting that would move the pick (read from the stability samples), and a logged override.
   *Rationale:* methods differ by 100–1,000+ psi and tools list picks without reconciling them; a range with reasons is more honest
   and more useful than a single number.
3. **Reopening family from re-pressurisation ramps** (new in this revision; S–M, 3.4a; §4.15b). A hinge fit of pressure against
   pumped volume on any re-pressurisation (second cycle, pump-in before flowback, a planned post-closure ramp) gives the reopening
   pressure with a bootstrap band. It enters the consensus as family F4, an injection-side, upper-side reading with a near-wellbore
   caveat — the only evidence on the board not read from the same falloff derivative. The same engine gives the triage ramp
   stiffness, the step-rate break and the leak-off point of a drilling leak-off or formation-integrity test. *Rationale:* every other
   closure family reads the same derivative, so "families agree" is weak evidence; the plan's own "measurement that would settle it"
   (a second-cycle reopening) becomes an analysed input.
4. **Triage and data-health gate** (23, M, 3.4a; §6.3). A traffic-light card and an A–D grade within seconds of import (or 30–60
   min into a live falloff): air or gas in the well (two independent detectors: the ramp stiffness and the water-hammer period),
   vacuum, thermal transients, leaks, gauge resolution against the derivative signal, volume reconciliation, fluid gradient, clock
   alignment, and the pressure-gradient plot that guidance calls "often missing". It tests common unit and depth blunders, gives an
   early "re-pump?" verdict with bands derived from the well's own inputs and a salvage plan. *Rationale:* misruns, wrong units and
   surface-gauge problems are the commonest reasons DFITs fail, and "uninterpretable, but these windows are usable" is a valid
   result no tool returns.
5. **Leak budget and leak plot** (24 — top score, S, 3.4a; §6.4). A leak tolerance for the plan, q_k,max = ε·V/(Θ·t_end), with
   Θ = 2 in linear flow (where it does not depend on k, h or xf) and the uniform-flux radial factor once radial flow develops; the
   temperature stability a sealed-wellbore hold would need; and a p_i-free plot with a gauge-drift term that measures a leak during
   the falloff and gives a leak-corrected p_i with its detection floor, or says "leak or drift (not separable)". *Rationale:* "small
   leaks ruin tests" is the most repeated field warning; this turns it into numbers.
6. **Pre-job designer** (22, M, 3.4a; §6.5). Ranges in; out come an expected-outcome label ("closure only" / "linear: p_i ±W" /
   "radial: kh/μ ±x %"), closure time and recommended shut-in at P10/P50/P90 (regime times on the statistic the module detects),
   minimum volume, gauge and sample-rate spec, a vacuum check, an optional post-closure re-pressurisation step, an execution
   checklist and a P10–P90 pressure corridor. *Rationale:* "how long do we shut in and what will we learn?" is asked before every
   job and today is answered by rule of thumb or a full fracture simulator.
7. **Uncertainty budget and what-if propagator** (22, M, 3.4a; §6.6). P10/P50/P90 on every DFIT number — per closure family when
   the board shows a range, never a pooled median — the share of each spread by input, a tornado, and a what-if marker on the
   closure strip that recomputes everything downstream. *Rationale:* no tool propagates picks and inputs; the dispute is argued
   with differences the size of the interpretation uncertainty.
8. **"What this test can tell you" card** (21, S–M, 3.4a; §6.7). Plain sentences per parameter ("determined ±x", "only as a
   group", "not determined"), a ranking of the next best information, and an extend-the-shut-in table (keep or pull the gauge).
   *Rationale:* stops E′, height and CL being shown as if measured, and answers the daily "keep the gauge?" question with numbers.
9. **Live DFIT co-pilot with replay** (20, M–L; replay engine and "first available" table 3.4a, timeline UI and live listeners
   3.4b; §6.9). Live falloff drawn inside the designer corridor, closure provisional → confirmed (naming the family), a forecast
   band, the p_i bracket and a verdict tile; replay shows when each conclusion first became available on any recorded test.
   *Rationale:* on-the-fly closure detection and a stop criterion are absent from every tool; the app already has a Modbus
   station, a historian and an offline phone build.
10. **Evidence trail in the report** (23 for the full idea; S; 3.4a; §6.10). An "Ev." column and an evidence appendix (chips are
   buttons in the app that open the plot window behind a number), an undoable append-only pick and override log, a data + picks
   export with a column template, and an A–D grade. The quoted-value check is a self-check that prints only when a number fails
   to recompute. *Rationale:* reproducibility is a recurring complaint and regulators ask for data plus picks.
11. **Several DFITs per well and calibration outputs** (new in this revision; S–M, 3.4a; §6.12). Stacked tests side by side,
   gradient against depth and the normalised-derivative overlay (parity), plus a stress-log calibration offset and a pad fraction
   per closure reading (new: the closure dispute's downstream effect on geomechanics and design made explicit).
12. *Stretch (3.4b, first to cut):* **interpretation lenses** (21, S–M; §6.11) — internally consistent calculation chains
   (contact, tangent, global model) side by side with an exact difference breakdown.

**Parity-plus, not headline novelty:** the after-closure match with the PRiSM model library and the one-click hand-off (§6.8) is
parity with pressure-transient suites; it is new only against DFIT-only tools. Its new parts are the p_i-free constant-rate
transform and the bracket-bounded variable projection of p_i. PRiSM's model library (46 models after v3.3) and the hand-off still
close a manual, error-prone step.

**Method upgrades built into the baseline** (not separate features, but each is new against common practice): exact Nolte
reference curve instead of slope guides (the true slope is 0.785 / 0.617 / 0.539 at ΔtD = 1 / 10 / 100); general-α and data-driven
G; matched-α efficiency; the storage-consistent closure balance and the closure-visibility index R_vis computed from it; friction
bleed-off forecast that sets G_min, screens false PDL humps and corrects the water-hammer ISIP; expected-curvature test in the
classifier (reservoir-controlled leak-off plus pressure-dependent wellbore compressibility); PDL quantification (C_d, p_fo,
multiplier); height from the recession ratio; closure-time forecast; variable-compliance fit with a CI on σ_c; the p_i bracket
[p − 2D, p − D] valid through the linear-to-radial hump; regime thresholds tabulated for the statistic actually tested; centroid
time origin; bound-based ACA; Carter-exact F_R option; identifiability-aware step-down with an open-perforation P10/P50/P90; the
model-derived G that removes the α artefact (a false 15 % early steepening); a drift-aware leak plot.

**3.4a must ship** (the line below which nothing is cut): every parity row of §1.4 (including the basic step-rate test), the
consensus board without the counterfactual sentence, rule-based triage with the grade, the reopening family, the leak-off sandbox
and history match, ACA with the p_i bracket and the hand-off, the uncertainty propagator with per-family columns, the designer.

**Pre-agreed moves to 3.4b if the WP2 or WP6 midpoint slips** (in this order): the counterfactual sentence (keep the label and the
why-popover) → Bayes-factor blunder scoring (keep the rule-based blunder flags) → the `finiteFrac` / `radialComposite` match
candidates (keep `infiniteFrac` and `homogeneous`) → the displaced temperature model (keep static) → the next-best-information
ranking (keep the identifiability sentences) → the h-function estimate (if gate G6 is not met) → the geomechanics rows. Already in
3.4b: replay timeline UI, live listeners, drag-to-fit, lenses, tidal c_t cross-check.

### 1.6 Out of scope for v3.4 (with the reason)

| Item | Why not now | Where it goes |
|---|---|---|
| Doctrine arbitration across closure physics (evidence, model averaging) | Prototype weights collapse to 0/1 on synthetic data; needs tempered likelihoods and the full mechanism set | R2 (after 3.4b) |
| Analysis-by-synthesis leak-off classifier | Needs tip extension and height recession in the fit | R2 |
| Event detective (automatic segmentation, rate recovery from wellbore compressibility) | 3.4a covers clock alignment and basic picks | R2, first in line |
| DFIT gym (teaching mode, quizzes) | Generator ships in 3.4a; the teaching UI is extra (the method notes of §6.13 are in 3.4a) | R2 |
| Particle-filter forecast bands, exit alarms, cost-aware stop rule | Builds on the 3.4b live pipeline | R2 |
| Up-down hold-test analyser, blind peer review and sign-off pack | Adoption questions; sign-off shares the build-up helpers later | R2 |
| Compliance sounding with planned micro-pulses (design side) | Needs a field procedure change; 3.4b analyses pulses that exist | R2, experimental |
| Multi-DFIT stress column with pooling, depletion and field memory | Needs n ≥ 4 tests and cross-well plumbing; 3.4a stores several tests per well, plots them against depth and publishes per-well comparison rows | R2 |
| Tidal phase-lag kh/μ | Attenuated tidal responses give only a qualitative statement; the tidal c_t cross-check is 3.4b [M] | Parked |
| Frac-design consequences board, stress tensor, fault-slip envelope, stage-ISIP harvest, joint DFIT+PTA+RTA inversion, XLOT/LOT forecast, closure-stress spectrum, method-skill audit, offset-operations guard | Research-grade or depend on R2 items | R3 / exploratory |
| In-test poro-thermo-elastic correction; capillary-offset leak-off | Unsettled physics | Parked (sensitivity notes only) |
| Pseudo-3D height growth; proppant; power-law fluid in the mini-model propagation law | Beyond a lumped model | Mini-model phase 3 |
| A standalone Round-9 leak-off or step-rate page | Sidebar budget | Q4, Q5 |

---

## 2. Architecture

### 2.1 Where DFIT lives (decision)

The PRiSM audit (`prism.md`, file:line at HEAD `29c2970`) compared four options.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| A. New test type `'dfit'` | One control | The test type does not drive the shell (steps, sub-tabs and plot filters key on **mode**). 35 `'falloff'` checks in 14 files plus two whitelists (01:696, 16:745) would have to learn it; high regression risk in C2, C3, auto-match, semilog, report, deconvolution | Rejected. DFIT keeps `testType:'falloff'` underneath |
| **B. Workspace mode `PRiSM.mode = 'dfit'`** | Native: same header, step bar, rail slot, Tools, Export, undo/redo, report tab; the plot picker (04:1211) and PDF gallery (11:2983) already filter by `entry.mode`; `setMode` re-renders the shell so `when()` panels re-mount; mode already persists (33:1418); PTA hand-off is `setMode('transient')`; the same hook later serves other special tests (slug/DST, closed chamber) | Generic edits in 01, 02, 04, 11, 29-project-save, 30, 33, 36, 37: a step view for any step (today only step ②), a panel filter, the rail / Analyse / undo dispatch inside 37, a draw-any-canvas export, a gallery and undo that know the ext; transient / decline / combined must stay byte-identical (existing tests cover them) | **Chosen**, implemented as a generic `PRiSM_modeExt` registry so no host file contains DFIT logic |
| C. Tools-drawer workbench | Zero edits | Modal drawer too narrow for linked plots; no step guidance; PTA rail; picks not undoable; poor on phones | Stop-gap only: if WPH slips, 56–58 ship behind a Tools entry and a Tab-2 panel, and move into the mode when the hooks land (engines unchanged) |
| D. Separate Round-9 page | No PRiSM edits | Not "in PRiSM"; duplicates data, plots and regression or reaches across; no shared dataset or well | Only for a later standalone leak-off or step-rate page (Q4, Q5) that calls the Round-8 engines |

### 2.2 Files, rounds and owners

| File | Round | Owner (3.4a) | Contents |
|---|---|---|---|
| `prism-build/56-prism-dfit-core.js` (new) | 8 | WP2 | Pure pre-closure engine: units, dataset hash, preparation (non-destructive channel fixes), O(n) resampler, events, G family and the h-function, derivatives and the Nolte reference curve, ISIP reconciliation, closure methods (incl. merging the F4 reopening picks from `WTS_wellbore.ramp`), variable-compliance fit, consensus and stability (with the counterfactual sentence read from the stability samples), bounds check, what-if, efficiency, storage-consistent closure balance, net pressure, CL, geometry, spurt, PDL, leak-off rate from data, before-closure k estimates, far-field extension pressure, closure forecast, leak-off-type classifier |
| `prism-build/57-prism-dfit-aca.js` (new) | 8 | WP3 | Pure after-closure and results layer: **`PRiSM_dfit_pipeline` / `…Job` and `PRiSM_dfit_summarise`** (§3.3a), time functions and centroid, p_i-free diagnosis, brackets, Nolte and impulse lines, bounds, p_i consensus, gas adjustment, impulse → constant-rate transform and model-library match, leak plot with drift, uncertainty propagator, live incremental engine and replay, evidence index, report model, quoted-value check, data + picks export, frac-design sheet, hand-off packets, quality grade |
| `prism-build/58-prism-dfit-leakoff.js` (new) | 8 | WP4 | Leak-off mini-model (forward, verification modes, quick answers, goal-seek), history match, Fisher / identifiability / value of information, designer ensemble, corridor and checklist, leak budget |
| `prism-build/59-prism-dfit-ui.js` (new) | 8 | WP6 | DOM only: `PRiSM_modeExt.dfit`, step views ② and ④, C7 panels, test selector and tests table, plot registry entries and plot functions, post-draw hook `dfit-picks`, line tools (merge into `PRiSM_analysisKeys`, `store:false`), rail, ▶ Analyse orchestration (pipeline Job, one undo batch, cancel), Tools entries, override dialog, report sections, exports, hand-off buttons, the only writer of `multiRate`, C1 and storage, `WTS_state.dfit`; read-only hook points for the 3.4b files (live verdict, field tools) |
| `prism-build/48-calc-wellbore.js` (new) | 9, helper | WP1 | `WTS_wellbore`: survey, column ρ(p,T), system compressibility, temperature profiles, pipe friction (Newtonian, friction-reduced, power law), perforation and near-wellbore loss, friction bleed-off, surface ↔ bottomhole conversion with an uncertainty band, vacuum predictor, step-down fit / design check / open perforations, **step-rate hinge with per-step stabilisation check**, **pump-in ramp analyser**, water-hammer quick analysis, clock alignment |
| `prism-build/49-calc-dfit-triage.js` (new) | 9, helper | WPT | `PRiSM_dfit_triage`, `PRiSM_dfit_blunders`, `PRiSM_dfit_repump`, `PRiSM_dfit_grade`: pure triage checks, blunder library, re-pump verdict, A–D grade (resolved at call time like `WTS_wellbore`) |
| `prism-build/49-calc-dfit-info.js` (new) | 9, helper | WP6 | `WTS_dfitInfo`: neutral method notes (assumptions, failure modes, citations) and their modal dialog, the pattern of `49-calc-cheminj-info.js` |
| `prism-build/49-calc-dfit-synth.js` (new) | 9, helper | WP5 | `PRiSM_dfit_synth`: seeded case generator (mini-model, G-domain and analytical sources, artefact injectors), demo datasets, case lists and scorer |
| `prism-build/49-calc-dfit-cal.js` (new, **generated**) | 9, data | WP5 writes the placeholder; WP8 (3.4b) regenerates | `PRiSM_dfit_cal`: per-mode label hit rates with Wilson intervals, range interval scores, CUSUM thresholds, generator version |
| `prism-build/dfit-validate.js` (new) | tool | WP5 (tool), WP8 (runs) | Offline benchmark, `--quick` (12-case subset, 20-seed replay, structural spread, multi-start), `--perf` (wall-clock budgets), calibration and `--write` for the cal file |
| `prism-build/tests/_dfit-shapes.js` (new) | test helper | WP0 (frozen afterwards) | `checkShape(name, obj)` for every §3 shape, fixture objects, the shared-app helper |
| 3.4b: `48-calc-wellbore-field.js` (9), `57-prism-dfit-acamodel.js`, `59-prism-dfit-dragfit.js`, `59-prism-dfit-fieldtools.js`, `59-prism-dfit-lenses.js`, `59-prism-dfit-live.js` (8) | | WP10, WP11, WP12, WP9 | §9, 3.4b work packages; each merges into the 3.4a registries and namespaces, never wraps a function |

Every Round-9 helper starts with the header line "helper module: does not add a page to window.WTS_calcRegistry", is a single
IIFE, merges into its namespace (`G.WTS_wellbore = G.WTS_wellbore || {}`), and ends with one `// === SELF-TEST ===` block.

### 2.3 Generic edits to existing files (exact; no DFIT logic in any of them)

Line numbers are from the audit at `29c2970`; WPH rebases them on v3.3, which edits 05 and 33 elsewhere (`PRiSM_fitPhysical`,
`PRiSM_physicalModel`). Every ext code path runs only when `PRiSM_modeExt[PRiSM.mode]` exists.

| File (rebuild round) | Edit | Test that proves it |
|---|---|---|
| `02-plots.js` (phase 1+2) | (a) **O(n) Bourdet**: in `PRiSM_compute_bourdet` (02:1603) precompute `lnx` once and move two monotone pointers (left edge, right edge) instead of walking outwards with `Math.log` at every step; when `lnx` is not monotone keep the old loop; non-finite y, duplicate x and x ≤ 0 behave exactly as in the old loop. (b) Window aliases for `PRiSM_plot_finish`, `PRiSM_plot_straightLine`, `PRiSM_plot_keyPoint`, `PRiSM_plot_clip`, `PRiSM_THEME` in the api object (02:2690). (c) `opts.hoverEvent` → dispatch `prism:plot-hover {plotKey, x, y, index}` from the canvas on pointermove (no timer, no throttle object). (d) Pointer-owner hook at the start of the `down` handler (02:1308): `if (canvas._prismPointerOwner && canvas._prismPointerOwner(ev) === true) return;`. (e) `PRiSM_plot_overlay(canvas, drawFn)`: draws on the cached overlay frame (02:1139) without a full redraw (linked cursor) | `dfit-hooks` H1 (identical output, max relative difference ≤ 1e-12 on log-spaced, uniform and superposition-time sets, plus sets with NaN, duplicate t and t ≤ 0; operation count linear: 4,000 points take < 2.5 × the work of 2,000), H2, H3, H12; all `wp6-plots` tests unchanged |
| `01-foundation.js` (phase 1+2) | Modes resolved **at call time**: `_modes()` = built-ins + keys of `PRiSM_modeExt` (replaces the load-time `MODES`, 01:695; `state()` 01:735 accepts them). `state()` keeps `P.step` for any n that has `ext.stepView[n]` (today it resets every step but ② to `STEP_FOR_TAB[P.tab]`, 01:741). Markup adds a generic step-view host `#prism_stepview` next to `#prism_step2` (01:907); `showStep` (01:1269) renders `ext.stepView[n](host)` there for any n and hides the PTA sub-tab strip `#prism_tabs` in ext modes (01:1279). Header select options append `ext.label` (01:871). `onTestType` (01:1375): an ext key → `setMode(key)`. `setMode` (01:1365): calls `prev.onLeave(next)` and `ext.onEnter(prev)` around the re-render. Step labels from `ext.steps` (`markup` 01:859, `compactLabel` 01:1131). `tabForStep` / `gotoStep` (01:725, 1335) honour `ext.tabs` and `ext.stepView`. `PRiSM_mountTabPanels` (01:537) mounts a panel only when `spec.when()` passes **and**, in an ext mode, `ext.showsPanel(n, spec)` is true (default: `spec.modes` includes the mode, or the spec id is in `ext.panelAllow`, DFIT: crop, gauges, linetools); in built-in modes panels with `spec.modes` that exclude the mode are skipped. `refreshRail` (01:1233) and `analyse` (01:1391) stay thin wrappers over 37; `stepStatus` (01:1078) → `ext.status(snap)` | H5 (a dummy `PRiSM_modeExt.test` registered after 01 loads: gotoStep(4) survives `PRiSM_refreshShell()` and a reload, `#prism_tabs` hidden, exact panel list per mode); `wp13-workflow` unchanged |
| `04-ui-wiring.js` (3+4) | Export **`PRiSM_drawPlot(canvas, plotKey, extraOpts)`**: builds `{data, opts}` from the registry entry, calls `entry.fn`, sets `_prismAxes` with that `plotKey` and runs the post-draw hooks for it (the body of `_runPostDrawHooks`, 04:1201); `PRiSM_drawActivePlot` (04:1403) becomes a call to it with `#prism_plot_canvas` and `st.activePlot`. `_modeAllows` (04:1211): in an ext mode use `ext.showsPlot(entry, key)`, and never show `mode:<ext>` entries in any other mode, combined included. `_normaliseActivePlot` (04:1216) → `ext.defaultPlot`. `_modeShows` (04:1483) → `ext.showsModel`. `modeNote` (04:1962) → `ext.note`. Tab-2 controls: hide the period picker, time-function select and overlay checkbox when `ext.plotsTab.hide` lists them | H5, H13 (`PRiSM_drawPlot` on a second canvas runs the post-draw hooks once with its own plotKey); `wp13-workflow` unchanged |
| `05-regression.js` (3+4) | One export: `G.PRiSM_rng = function (seed) { return _makeRng(seed == null ? 1 : seed); };` (the seeded generator at 05:796, which returns `Math.random` for a null seed; the wrapper never does) | H8 (`PRiSM_rng(1)` reproduces the 05 bootstrap sequence; `PRiSM_rng(undefined)` is deterministic) |
| `07-data-enhancements.js` (3+4) | Column roles `pressure_surf`, `pressure_ann`, `temp`, `rate_fb` (→ `ds.pSurf`, `ds.pAnn`, `ds.T`, `ds.qFb`) in `ROLES` (07:75) and the header sniffing (role headers such as `pressure_surf_psia` are recognised on re-parse, so CSV written by DFIT round-trips); liquid-rate units `bbl/min` (factor 1440) and `bbl/h` (24) in 07:108; hints `bpm`, `bbl/min`, `bbl/h`. When 07 converts a psig column (07:101, fixed +14.696) it records `ds.meta.psigConverted[channel] = 14.696` | H9 (a CSV with surface pressure in psig, bbl/min rate and temperature survives a reload with all channels and the psig record) |
| `11-polish.js` (round 2) | `_defaultKinds` (11:2349) first reads `PRiSM_PLOT_REGISTRY[plotKey].axes = {x:'lin'\|'log', y:'lin'\|'log'}`. `_galleryHTML` (11:2989): in an ext mode list `ext.reportPlots` only; in every other mode, combined included, skip `mode:<ext>` entries. Analysis keys flagged `store:false` (11:2409–2410) skip `st.analysisKeyResults` and the `linetools-picks` hook | H4, H7 (gallery lists only `ext.reportPlots` in DFIT mode and no DFIT plot in combined mode) |
| `29-project-save.js` (round 6) | `'dfit'` added to `PRISM_KEYS` (29:283), as for 51 and 52, so `st.dfit` never rides in `extra` (dropped above 200,000 characters, 29:291). `st._*` runtime caches stay skipped. Integration review: `_readPRiSM` saves `step`; `_applyPRiSM` accepts a registered extension mode (`PRiSM_modeExtFor`) and enters it through `PRiSM.setMode` (its `onEnter` runs), leaving an extension mode calls its `onLeave` first (also in `_resetPRiSM`: New, well switch), restores `step` 1–5, and drops an extension's `stateKey` (`'dfit'`) when the opened project has none | I6 (project save/open restores `st.dfit` of two tests); `dfit-review` RV15 (DFIT mode and step after open and well switch; no stale DFIT state) |
| `30-quick-report.js` (round 6) | `_prismResults` (30:173): when `PRiSM_modeExt[PRiSM.mode]` exists and `PRiSM_reportKeyLine` returns text, use it instead of the PTA fit line | I8 |
| `33-pta-core.js` (round 8) | Same O(n) window in `_bourdetOnLn` (33:131). `'dfit'` in `STATE_FIELDS` (33:1404) and one restore line (33:1453); `P.step` saved and restored with mode and tab. Add `prism:dfit-updated`, `prism:dfit-model-updated` and `prism:mode-changed` to the debounced one-shot save list (33:1473–1488) | H1; H6 (reload restores `st.dfit` and step ④) |
| `35-rta-dca.js` (round 8) | After the last-fit lookup (35:1566): `if (!k && typeof G.PRiSM_dfit_kConstraint === 'function') { var dk = G.PRiSM_dfit_kConstraint(); if (dk && _pos(+dk.k)) { k = +dk.k; kSrc = 'DFIT after-closure'; } }` | H10 |
| `36-report.js` (round 8) | Section contract gains **`blocks:[{kind:'kv'\|'table'\|'verdict'\|'notes'\|'plot', …}]`** rendered in order in both the Tab-7 and the PDF paths (the existing kv / table / notes fields still work); `plot` blocks are drawn with `PRiSM_renderPlotToCanvas(key)` to PNG. Optional `fn.modes = [...]` filter; an ext mode with `reportLegacySections:false` skips sections without `modes`. Header and key results come from `ext.reportHeader(model) → {title, keyRows:[[label, text]], keyLine}`; `_plotSpecs(c)` returns `ext.reportPlots` in an ext mode. New exports `G.PRiSM_reportKeyLine()` and `G.PRiSM_reportReady()` (mode-aware) | H7 (a section with `modes` and three tables, a verdict and two plots renders in both paths only in its mode) |
| `37-prism-workflow.js` (round 8) | **The ext dispatch lives here**: `PRiSM_renderRail` calls `ext.rail(el)` first and `PRiSM_analyse` calls `ext.analyse(opts)` first, so `renderRailIfMounted` (37:1224) after an undo (37:2451) and at the end of Analyse (37:1769), the rail buttons and the direct call at 37:1159 all honour the ext. `restoreSnapshot` (37:2405) ends with `PRiSM_refreshShell()` so step views re-render. `snapObject` / `restoreSnapshot` (37:2362 / 2405) loop over `window.PRiSM_undoExtras` (`{get(), set(v), events?}`); `restoreSnapshot` skips keys a snapshot does not have (the baseline `_cur`, 37:2559, predates DFIT). An extra's `events` list is added to the record triggers (37:2481), ignoring events whose `detail.source` is `undo` or `restore`. New export `PRiSM_undoBatch('begin'\|'end')` with a nesting counter (one snapshot per outermost batch; the caller ends it on finish, cancel and reject). `listTools()` (37:2191) filters C7 panels by `when()` and `modes`, marks every `PRiSM_toolCatalogueExtra` fn as seen **before** the mode filter (so DFIT tool functions never appear under "More" through the discovery regex, 37:2203), and shows entries with `modes:'*'` in every mode | H5, H6 (first undo after load keeps `st.dfit`; pick → undo → redo; one Analyse = one undo step; after an undo the rail is the ext rail), H11, H14 (exact Tools list per mode) |
| `29-multiwell.js` (round 6; WP6) | `_extract`: when `st.dfit` has results, add `dfit:{tests:[{zone, datumTvd, closureGrad, closureLabel, pi, k, kRange}]}`; `ROWS` += 4 rows with `src:'PRiSM DFIT'` (active test; "n tests" note) | `dfit-integration` I7 |
| `concat-round8.js` (lead) | `FILES` += `56-prism-dfit-core.js`, `57-prism-dfit-aca.js`, `58-prism-dfit-leakoff.js`, `59-prism-dfit-ui.js` after `55-prism-autointerp-cal.js`; banner text. 3.4b adds the 3.4b Round-8 files by name | concat runs; harness sees the files |
| `smoke-test.js` (WP6) | DFIT list (§9, WP6) | itself |
| `gui-sweep.js` (WP6) | DFIT views with a set-up (load the reference demo, `PRiSM.setMode('dfit')`, await ▶ Analyse, go to the step): steps ①–⑤, step-④ sub-views, every DFIT Tools entry; DFIT variants of the Metric and decimal-comma passes (gui-sweep.js:1197); a DFIT pass in `--mobile` | sweep runs |
| `ux-layout-check.js`, `ios-webkit-check.js` (WP6) | A DFIT-mode pass (demo loaded, steps ①–⑤, step-④ sub-views) at 390 px and 1280 px; one DFIT view in the WebKit check | tools run (reports, not gates) |
| `well-testing-app.html` (host, outside sentinels) | `_rtPrismReady()` (≈ l.3444): `if (typeof window.PRiSM_reportReady === 'function') return window.PRiSM_reportReady();` first. `_rtPrism()` (≈ l.3448): `const _kl = (typeof window.PRiSM_reportKeyLine === 'function') ? window.PRiSM_reportKeyLine() : ''; if (_kl) return { html, key: _kl };` before the PTA key line. `RELEASE_NOTES` (WP7) | `platform-reports` unchanged in transient; I8 in DFIT mode |
| `ios-app/ios-additions/ios-styles.css` (WP6) | `html.ios-app #prism_dfit_override, html.ios-app #wts_dfit_info { padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); }`; the dialog boxes `.prism-dfit-dlg` / `.wdi-box` capped at `calc(100dvh - max(10px, env(safe-area-inset-top)) - max(10px, env(safe-area-inset-bottom)))` (a 100vh fallback first); 44 px for `.wdi-x`, the override `.btn` and `.prism-dfit-tile button`. Changed at the integration review: the first rule put `max-height: calc(100dvh - 20px)` on the `inset:0` overlay, which shortened the backdrop and left the inner box (its web cap 100dvh − 32 px) taller than the padded area, so a tall dialog's title and buttons sat under the Dynamic Island and the home indicator; the cheminj / buildup rules cap the inner box instead | `dfit-ui` U12 checks the CSS string |

### 2.4 Load order and feasibility

- **Round 8** runs 33–37, 39, 51, 52, then the build-up files 53–55, then 56 → 57 → 58 → 59 (3.4b: the extra 57/59 files by
  name after their base file). 33 restores `wts_prism_state` at load (33:1490), so `st.dfit` exists before 59 reads it. 59 runs
  after 37 and 11, so it can merge into `PRiSM_analysisKeys`, `PRiSM_PLOT_REGISTRY`, `PRiSM_reportSections`, the C7 panel registry,
  `PRiSM_modeExt`, `PRiSM_undoExtras` and `PRiSM_toolCatalogueExtra` at load. Because 01 resolves modes and step views at call time
  and 37 re-baselines lazily, registering the ext after 01/37 have loaded is safe (H5, H6).
- **Cross-file calls are resolved at call time** (`G.PRiSM_dfit_isip(...)`), never captured at load, inside the Round-8 files as
  well as across rounds.
- **Round 9 after Round 8.** `WTS_wellbore`, `PRiSM_dfit_triage`, `WTS_dfitInfo`, `WTS_tubulars`, `WTS_gradient_compute`,
  `WTS_flowline_friction`, `WTS_gaspvt_*`, `WTS_historian`, `WTS_buildup` (v3.3), `PRiSM_dfit_synth` and `PRiSM_dfit_cal` do not
  exist when Round 8 loads. Every use is behind a `typeof` guard with a stated fallback (constant-gradient hydrostatic, Newtonian
  smooth-pipe friction, "triage unavailable", "uncalibrated" labels). `48-calc-wellbore.js` sorts before `48-calc-wellkill.js` and
  `49-calc-flowline.js` and therefore also resolves `WTS_flowline_friction` at call time.
- **Round 6** (29-project-save, 29-multiwell, 30-quick-report) is concatenated before Round 8 but only reads DFIT names at call time.
- **Round 10** (`WTS_modbus`) loads last; the live listeners (3.4b) resolve it per event.
- **Smoke stub.** Every DFIT file loads without `document`, `WTS_units`, `drawLineChart`, the 02 lexical helpers, IndexedDB or the
  Round-9/10 engines. No file starts a timer at load. 59 guards DOM work on `document.getElementById('prism_shell')`.
- **Self-tests.** Each file ends with exactly one `// === SELF-TEST ===` IIFE covering only its own pure functions (stripped by
  concat).

### 2.5 Data flow

```
 CSV / paste / gauge manager (19) / large records via WTS_buildup.data.parseJob / live-data page window / demo (synth) / live (3.4b)
        │  07 roles: time, pressure, pressure_surf, rate (bbl/min→bbl/d), rate_fb, temp, pressure_ann; psig → psia (+14.696, recorded)
        ▼  demo and gauge sets go through PRiSM_commitDataset (source 'dfit-demo' / 'gauge') with their CSV written to the Data-tab text
 PRiSM_dataset {t h, p psia, q bbl/d, pSurf?, qFb?, T?, meta.psigConverted}    T.dsRef.hash binds the active test to it
        │
        ▼  PRiSM_dfit_pipeline(ds, T.inputs, PRiSM_getWell(), T.picks, opts)         (57; pure, synchronous; Job twin for the UI)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ prepare (56; channel fixes, atmPsia difference, mask, clock offset; WTS_wellbore.convert when the primary is surface)  │
 │ → events (56) → triage (49-calc-dfit-triage, call time) → ISIP (56; WTS_wellbore.hammerQuick, .stepDown)               │
 │ → derivs (56; G family, h-function, PRiSM_compute_bourdet) → closure picks (56; + WTS_wellbore.ramp → family F4)        │
 │ → consensus + stability (56; skipped when opts.fast) → classify (56) → frac / what-if (56)                             │
 │ → ACA (57) → leak plot (57) → uncertainty (57; skipped when opts.fast) → evidence + report model + grade (57)          │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▼
 DfitRun (§3.3a) ──► st._dfitRun (runtime cache, never saved) ──► PRiSM_dfit_summarise(run) ──► T.summary (stored, small)
        ▼
 59 only: rail, step views, panels, plots (PRiSM_drawPlot), report sections; writes PRiSM.multiRate (idealised schedule) and
          PRiSM_setWell({testType:'falloff', tShut, tp}, {source:'dfit'}) after a run; HF windows to PRiSM_storage

 Leak-off model (58): PRiSM_dfit_lkSimulate / lkFit / lkFisher  ◄── initial guesses from run.consensus, run.frac, run.aca
 Designer (58): PRiSM_dfit_design(DesignRanges) ──► Design {outcome, shut-in, Vmin, gauge, checklist, corridor}
 Replay / live (57): PRiSM_dfit_replay(ds, ctx) and PRiSM_dfit_live.create(ctx) call the same pipeline stages incrementally
 Benchmark / validate (49-calc-dfit-synth, dfit-validate.js): PRiSM_dfit_pipeline per case ──► PRiSM_dfit_synth.score(run, truth)
```

### 2.6 How the five-step shell adapts

| Shell item | Transient mode (unchanged) | DFIT mode |
|---|---|---|
| Header select `#prism_testtype` | auto / drawdown / buildup / injection / falloff / rate / combined | + "DFIT (fracture injection)" → `setMode('dfit')` |
| Step labels | ① Data ② Flow periods ③ Diagnose ④ Model & fit ⑤ Report | ① Data & events ② ISIP & friction ③ Pre-closure ④ After-closure & model ⑤ Report |
| Step hosts | tabs 1, step view 2, tab 2, tabs 3–6, tab 7 | ① tab 1 (Data) + DFIT panels; ② step view `PRiSM_dfit_renderStep2` in `#prism_stepview`; ③ tab 2 (plots) with DFIT plots + panels; ④ step view `PRiSM_dfit_renderStep4` in `#prism_stepview` with its own segmented control (After-closure · Leak-off model · Uncertainty · What this test can tell); ⑤ tab 7. `#prism_tabs` hidden; `P.step` persists |
| Step ticks (`ext.status`) | data / period / adata.ok / fit converged | ① prepared and triage not red; ② ISIP picked; ③ consensus mode ≠ none (or a user pick); ④ ACA run or "closure only" acknowledged; ⑤ always |
| ▶ Analyse (`ext.analyse`, dispatched by 37) | data → semilog → race → refine → interp | `PRiSM_dfit_pipelineJob` (stages of §4.20) inside one `PRiSM_undoBatch`; yields between work units; Cancel (§4.20) |
| Rail (`ext.rail`, dispatched by 37) | model, k, S, C, R², pins | test selector; ISIP ±; closure value or range + label (family medians in range mode); closure gradient; pn; η (α); Γ and CL; xf/R; p_i + bracket label; kh/μ or [k_lo, k_hi]; triage light and grade; live verdict (3.4b, read through a hook). `prism-rail--sheet` below 1,024 px as today |
| Panels | all whose `when()` passes | only panels with `modes:['dfit']` plus the allow-list (crop, gauges, linetools) |
| Tools drawer | catalogue + discovery | + DFIT designer (pre-job), Leak-off sandbox (**every mode**), Replay a recorded DFIT, Water hammer (detail), Method notes; 3.4b: Live DFIT co-pilot, Step-rate superposition & Hall, Flowback & pulses |
| Undo / redo | well, model, params, fit, period, multiRate | + `PRiSM_undoExtras.dfit` (decisions only: active test id, event overrides, tp/α choices, picks, inputs; ≤ 10 kB) recorded on `prism:dfit-updated`; restoring re-runs the fast pipeline (no stability grid, no uncertainty, ≈ 50 ms) and re-renders the step view |
| Export menu | report, PDF, CSV, plot PNG, XML | + "DFIT data + picks (ASCII)" and "Frac-design sheet (CSV)" through the same menu (`ext.exportItems`) |
| Units note | `#prism_units_note` in Metric mode | same note; DFIT is field-unit only |

Entering DFIT mode (`ext.onEnter`): open an undo batch; `PRiSM_setWell({testType:'falloff'}, {source:'dfit'})` if it is not already
`falloff`; create `st.dfit` with one test when it is missing; when a dataset exists, bind or check `T.dsRef.hash`, run the fast
pipeline and write the idealised schedule to `PRiSM.multiRate` (`[{t: ts − tp_veq, q: q_eq}, {t: ts, q: 0}]` in bbl/d,
q_eq = (V_i − V_fill − V_fb)/tp_veq; C2 negates all-positive steps for injection-like tests, 33:603); close the batch; go to step ①.
Leaving (`ext.onLeave`): nothing is undone (a falloff set-up is right for PTA too); live listeners are released.

### 2.7 Plots and line tools

- **Registry entries** (merged into `PRiSM_PLOT_REGISTRY`): `{fn, label, mode:'dfit', kind:'dfit', axes:{x, y}, build(ctx)}`.
  Each entry carries a **real `fn`** (exports at 11:2923 ignore `fnOverride`) and the kind `'dfit'`, never `'loglog'` or
  `'history'`, so foreign post-draw hooks keyed on PTA kinds (51's saved-fit overlay, 51:487–490) skip them. The plot list is in §7.9.
- **Drawing.** Every DFIT canvas (main plot, `dfitConv` in a tab-1 panel, `dfitIsip` / `dfitHammer` / `dfitStepDown` /
  `dfitStepRate` / `dfitCycles` in step ②, `dfitStrip` in a panel, every step-④ plot, the tests overlay) is drawn with
  `PRiSM_drawPlot(canvas, key, extraOpts)` (§2.3, 04), which sets `_prismAxes` and runs the post-draw hooks with that key. 59
  redraws visible DFIT canvases on `prism:dfit-updated`.
- **Plot functions** live at host-IIFE scope in 59 (Round 8 is concatenated inside the host IIFE), built from the lexical 02 helpers
  with `typeof` guards: `PRiSM_plot_dfitDual(canvas, data, opts)` (left pressure axis, right derivative axis, x linear or log,
  overlay lines, bands, markers, shaded windows), `PRiSM_plot_dfitStrip(canvas, data, opts)` (closure strip), and
  `PRiSM_plot_dfitStack(canvas, data, opts)` (stacked volume partition). Log-log plots reuse the `bourdet` drawing style.
  `PRiSM_plot_finish` gives zoom, pan, pinch, persisted user view and `_prismAxes` for free.
- **Derivative axis.** On `dfitG`, `dfitSqrt` and `dfitH` the dP/dG (dP/d√t) and G·dP/dG y-range defaults to the data after G_min
  (robust 2–98 percentile, 10 % headroom), so the early drop does not flatten the contact deflection; a "lock axis" toggle
  (`#prism_dfit_axislock`) is persisted in `T.inputs.options.axisLock`.
- **PPD toggle** (`#prism_dfit_ppd`) on `dfitLogLog` and `dfitAcaLogLog`: adds the primary pressure derivative dp/dΔt = D/Δt (no new
  engine).
- **Picks** are drawn by one post-draw hook `_prismId: 'dfit-picks'`, filtered by `plotKey`, so PDF and PNG exports show them.
- **Linked cursor**: DFIT plots set `opts.hoverEvent`; 59 listens to `prism:plot-hover` and draws the same Δt on the other visible
  DFIT canvases with `PRiSM_plot_overlay` (02's cached overlay frame, no full redraw), and on the fracture schematic of the sandbox.
- **Line tools** (merged into `PRiSM_analysisKeys`, group "DFIT", every key `store:false`, so 11 neither stores them in
  `st.analysisKeyResults` nor draws them with `linetools-picks`): `dfitIsipLine` (2 clicks on `dfitG`: early straight line →
  ISIP_G), `dfitTangent` (1 click on `dfitG`: tangent through the origin touching G·dP/dG near the click), `dfitCompliance` (2
  clicks: early line on G·dP/dG, then the departure), `dfitClosure` (1 click on any pre-closure plot: user closure), `dfitSqrtInfl`
  (1 click on `dfitSqrt`), `dfitAcaLinear` / `dfitAcaRadial` (2 clicks on `dfitFL`/`dfitImpLin` or `dfitFR`/`dfitImpRad`: window),
  `dfitPiLevel` (1 click on `dfitPiTraj`), `dfitRampKnee` (1 click on `dfitCycles`: user reopening). Every action calls the DFIT
  engine, stores the result in `T.picks.user[key]` with `source:'user'`, appends to the pick log and fires
  `prism:dfit-updated {what:'pick'}`; only `dfit-picks` draws them.
- **Draggable handles** (pointer-owner hook): the closure marker on `dfitG`, `dfitSqrt` and `dfitLogLog`, the what-if marker on the
  strip, and the ACA window edges. A drag previews with the fast pipeline; release commits one pick-log entry.

### 2.8 Panels (C7; every spec carries `modes:['dfit']` and `when: () => window.PRiSM && PRiSM.mode === 'dfit'`)

| Tab | Panel id | Title | Order |
|---|---|---|---|
| 1 | `dfit-tests` | Tests in this well | 5 |
| 1 | `dfit-well` | DFIT well, wellbore and fluid | 10 |
| 1 | `dfit-channels` | Channels and bottomhole conversion | 20 |
| 1 | `dfit-triage` | Test triage | 30 |
| 2 | `dfit-board` | Closure consensus | 10 |
| 2 | `dfit-classify` | Leak-off type | 20 |
| 2 | `dfit-frac` | Efficiency, net pressure, CL and geometry | 30 |
| 2 | `dfit-whatif` | What-if closure table | 40 |
| 7 | `dfit-report-opts` | DFIT report options (sections, family columns, pick log, export template) | 10 |

In DFIT mode `ext.showsPanel` admits these plus the allow-list `ext.panelAllow = ['crop', 'gauges', 'linetools']` (12 crop, 19
gauges, 11 line tools); 16 Well & Test, 18 tide, 39's ct builder / gauge register / events log, 34 semilog, 15 regime markers, 17
deconvolution and 21 plot tools do not mount. The `linetools` panel shows the DFIT tool group automatically (it filters by the
active plot). Step views ② and ④ render their own cards (they are not tabs).

### 2.9 Persistence, project files, multi-well

- `st.dfit` (§3.3) travels in `wts_prism_state` (`'dfit'` in `STATE_FIELDS`), in the project `prism` module (`'dfit'` in
  `PRISM_KEYS`) and in parked multi-well blobs. Only decisions, inputs and small summaries are stored (≤ 100 kB for up to 12
  tests); arrays are recomputed on restore (the fast pipeline, ≈ 50 ms) and the bands on the next ▶ Analyse. The runtime result
  sits on `st._dfitRun` and the what-if marker on `st._dfitWhatIf`; neither is ever written (the project reader skips `_` keys).
- **Binding.** Each test stores `dsRef = {kind, id, name, hash, n}`. On restore, `prism:dataset-loaded`, `wts:project-loaded` and
  `wts:project-new`, 59 compares `PRiSM_dfit_dsHash(PRiSM_dataset)` with `T.dsRef.hash`; on a mismatch the test is marked
  "for another dataset" (summary stale, picks shown but not applied) until the matching dataset is loaded or the user re-binds
  (logged). Demo and gauge-manager sets are committed through `PRiSM_commitDataset` and their CSV, with role headers, is written to
  the Data-tab text, so a plain reload re-creates the same dataset (I6 reloads a demo dataset).
- **High-rate windows** (§3.11) are records in 19's `PRiSM_storage` (IndexedDB backend, carried by project files) keyed by the
  dataset hash; `T.hf` holds only the index. Without IndexedDB, only the shut-in window (≤ 150 kB) is kept in `wts_prism_dfit_hf`.
- No new project module. Raw multi-day 1 s records stay in the gauge manager (19); the analysis dataset is the resampled set.
- `WTS_state.dfit` (published by 59 after each Analyse): `{ok, ts, isip, closure:{mode, value, lo, hi, label, families}, closureGrad,
  pn, eta, CL, Gamma, xf, pi, piLabel, khmu, k, kLo, kHi, triage, grade, tests:[{id, zone, datumTvd, closureGrad}], appVersion}`;
  multi-well comparison rows read it (§2.3).

### 2.10 Report and Quick Report

- One report section per DFIT group, registered in `PRiSM_reportSections` with `fn.modes = ['dfit']` and the generic `blocks` list:
  headline (order 10: kv + table with P10/P50/P90 and the Ev. column, grade), closure board (11), what-if (12), ACA (13: brackets,
  p_i, kh/μ or bounds, leak check), leak-off type (14), triage (15), step tests (16: step-down, step-rate, reopening), leak-off model
  (17: Γ, fit, identifiability), uncertainty (18: per-family columns in range mode), hand-off and geomechanics rows (19), pick and
  override log plus the evidence appendix (20). The report-options panel switches groups on and off. Each section's content comes
  from `run.report` (`ReportModel`, §3.6).
- `PRiSM_modeExt.dfit.reportLegacySections = false`, so PTA-only sections (semilog, workspace, gas deliverability) do not print in
  DFIT mode; `ext.reportHeader` gives the DFIT title and key rows; `ext.reportPlots` = `dfitHistory`, `dfitG`, `dfitSqrt`,
  `dfitLogLog`, `dfitStrip`, `dfitAcaLogLog`, `dfitPiTraj` (+ `dfitLkP` when a model fit exists, `dfitStress` when the well has two
  or more tests).
- The header Quick Report picks the PRiSM section up through the two host lines of §2.3, and 30-quick-report's PRiSM result line
  reads `PRiSM_reportKeyLine()` in DFIT mode. Key line examples: `DFIT · closure 7,000 psia (single, high) · p_i 4,500 ±6 psia`;
  `DFIT · closure range 6,495–7,004 psia (medians 6,507 / 6,998; medium) · p_i 4,500 ±6 psia`.
- Report capture classes: inputs as `.card` / `.fg-item`, results as `.rbox` / `.rrow .rl/.rv`, tables as `table.dtable`, charts as
  `canvas` inside `.chart-wrap`, verdicts as ✓ / ⚠ / ✗ plain text under 300 characters, and a `<div><b>Notes</b> …</div>` box.

### 2.11 Hand-offs to PTA, RTA and other pages

| Target | What moves | How |
|---|---|---|
| PRiSM PTA (transient) | testType falloff, tShut = ts, tp = tp_veq, pwf0 = ISIP, p_i (when its label ≥ medium), idealised schedule with q_eq = (V_i − V_fill − V_fb)/tp_veq (the wellbore-compression volume is part of the impulse); model `infiniteFrac` (ACA linear seen), `finiteFrac` (bilinear seen) or `homogeneous` (radial only); seeds `st.phys.xf` (geometry P50 or ACA L) and k (ACA kh/μ·μ/h) | `PRiSM_dfit_applyHandoff('pta')` after a confirm listing every change: `PRiSM_undoBatch('begin')` → `PRiSM_setWell(patch, {source:'dfit'})` → `PRiSM.multiRate` → `PRiSM_setModel` → seeds → `setMode('transient')` → `PRiSM_gotoStep(3)` → `PRiSM_undoBatch('end')`. The DFIT result never goes through `PRiSM_setLastFit`; C3 then floats xf, k, S (optional floatPi). In range mode the user chooses the family whose chain is handed over (logged) |
| PRiSM RTA (decline mode) | k (P50) and its range | `PRiSM_dfit_kConstraint()` read by the 35 fallback (§2.3); the RTA panel shows "k from DFIT after-closure" |
| Frac design | Closure (value, or both family columns in range mode, gradient), ISIP, pn, η (upper bound when spurt is unknown), pad fraction range, Γ and conditional CL, PDL multiplier, E′ source, geometry, height estimates, lens used; all with P10/P50/P90 | `PRiSM_dfit_fracSheet(run)` → CSV download and report section |
| Geomechanics | Per closure family: closure gradient, stress-log calibration offset Δσ_tect at datum, ISIP gradient; per test: depth, zone (§6.12) | rail rows, frac sheet rows, `WTS_state.dfit.tests` |
| Well Kill & Bullhead page (fracture gradient) | Closure gradient and ISIP gradient (psi/ft and ppg equivalent) | Published in `WTS_state.dfit`; 3.4 shows a copy-to-clipboard line in the DFIT rail. Reading it from the Well Kill page is an out-of-module follow-up (§9, out-of-module follow-ups) |
| Build-up Surveillance (v3.3) | p_i and k for the same well (injectors: closure as the parting limit) | Published in `WTS_state.dfit`; using it as a reference value on that page is an out-of-module follow-up |
| Multi-well comparison | closure gradient, label, p_i, k (active test; "n tests" note) | `29-multiwell.js` rows (§2.3) |

### 2.12 Rules for parallel worktrees

1. Each WP works in its own worktree and branch off Dev **after v3.3 is merged and WP0 has landed**.
2. Commit sources only. Never commit a rebuilt `well-testing-app.html`, `ios-app/www/index.html` or any `combined-*.js` from a WP
   branch; tests run with `--sources`. The exceptions are WPH and WP7, which commit hand edits to the host outside the
   injection sentinels on top of Dev's copy.
3. A file belongs to exactly one WP per increment (§2.2, §2.3). A change in another WP's file goes through its owner; the lead
   arbitrates. 3.4b work packages that would share a file get their own file instead (§9).
4. Code against §3 and the fixtures in `tests/_dfit-shapes.js`, never against another branch. Cross-WP tests live only in
   `dfit-integration.test.js` (WP6), which lands last; this includes the three end-to-end benchmark cases and every test that runs
   the mini-model through the pre-closure chain. WP6 tests its UI against fake engines loaded with
   `loadApp({ sourceOverrides: { '56-prism-dfit-core.js': fake56, '57-prism-dfit-aca.js': fake57 } })` that return `FIX.run`.
5. The integrator merges in the order of §9.0, then rebuilds every round whose files changed and nothing else: 01 / 02 → phase 1+2;
   04 / 05 / 07 → phase 3+4; 11 → round 2; 29-project-save / 29-multiwell / 30 → round 6; 33–37 and 56–59 → round 8; 48 / 49 →
   round 9 — in the order of CLAUDE.md's full rebuild sequence — then `sync-from-main`, the smoke test and the touched acceptance
   files, and commits the rebuilt artefacts on Dev. This checkout is LF: skip CLAUDE.md's CRLF step.
6. No DFIT WP edits `docs/BUILDUP-SURVEILLANCE-PLAN.md` or a build-up file.

---

## 3. Interfaces (exact)

### 3.0 Rules common to every interface

- **Units of public fields** (engine-internal units may differ; each file converts at its boundary through `PRiSM_dfit_units`):

  | Quantity | Unit | Field names (examples) |
  |---|---|---|
  | time on the record clock | h since the first sample | `t`, `tStart`, `tb`, `ts`, `tc`, `tEnd` |
  | shut-in time | h | `dt` (= t − ts) |
  | time since the start of the analysed injection cycle | h | `tInj`, `tcInj` (= tc − tStart) |
  | pressure | psia (psi for differences) | `p`, `pw`, `isip`, `sigmaC`, `pi`, `pn` |
  | rate (DFIT objects) | **bbl/min** | `q`, `qMax`, `qLast`, `qEq`, `qL` (leak-off rate), `qStar` |
  | rate (PRiSM dataset and `multiRate` only) | bbl/d | `ds.q`, `ds.qFb`, `multiRate[i].q` |
  | leak rate (leak plot, budget) | bbl/d | `qk`, `qkMax` |
  | volume | bbl | `V`, `Vi`, `ViStar`, `ViFrac`, `Vf`, `VL`, `Vfill`, `Vfb` |
  | storage / system compliance | bbl/psi | `VwCw`, `Csys`, `AfCf` |
  | compressibility | 1/psi | `cSys`, `cFluid` |
  | width compliance | ft/psi | `cf` |
  | leak-off coefficient | ft/√min | `CL`, `Cw`, `CLeq` |
  | spurt | gal/100 ft² | `Sp` |
  | E′ | psi (UI 1e6 psi) | `Ep` |
  | toughness | psi·√in | `KIc` |
  | viscosity | cp | `mu`, `muRes` |
  | permeability | md; transmissibility kh/μ md·ft/cp | `k`, `khmu` |
  | lengths, depths | ft (TVD unless the name ends in `Md`) | `xf`, `R`, `hf`, `hp`, `datumTvd`, `gaugeMd` |
  | pipe / perforation diameters | in | `id`, `od`, `dIn` |
  | density / gradient | ppg / psi/ft | `rhoPpg`, `gradIsip` |
  | temperature | °F | `T`, `tInjF` |

- **Numbers.** Every output number is finite or `null`; engines convert NaN and Infinity to `null` and add a warning. **Inside
  engines, masked samples are removed (arrays compacted, with an index map back to the dataset rows) or set to `NaN` before any
  derivative, regression or Theil–Sen call; `null` never reaches a numeric routine** (`isFinite(null)` is true, so a masked `null`
  would read as Δp = 0 and spike G·dP/dG and D). Display series in a `DfitRun` may carry `null` for gaps. Arrays crossing a WP
  boundary or going to storage are plain arrays; work arrays may be `Float64Array`.
- **Failure.** `{ok:false, code:'<UPPER_SNAKE>', errors:[string], bad:[fieldName]}`. Public functions never throw (they catch and
  convert). Partial success: `ok:true` with `warnings`.
- **Warnings and verdicts.** `{code, level:'info'|'warn'|'bad', text, ev:[evidenceId]}`; `text` is plain, under 300 characters (≤ 299) and
  never contains the words "null", "undefined", "NaN" or "Infinity" (GUI-sweep text scan).
- **Purity.** 56, 57, 58, `WTS_wellbore`, `PRiSM_dfit_triage` and `PRiSM_dfit_synth` touch no DOM, no storage and no timers, and fire
  no events. **Only 59 (and in 3.4b the 59-* files) touches the DOM, writes `PRiSM.multiRate`, writes C1 (`PRiSM_setWell`), writes
  storage and fires events.** Long work is exposed as a **`Job<T>`** (`{step() → {done, progress, label}, result(), cancel()}`, the
  shape used by the build-up plan) next to a synchronous function with the identical result; 59 runs jobs through
  `PRiSM_autoInterp.drive(job, {shouldCancel, onProgress})` (v3.3, the one timer user in Round 8), resolved at call time. Without
  it, 59 runs the job synchronously.
- **Determinism.** No `Math.random` in any DFIT file (a test greps the sources). Randomness comes only from `PRiSM_rng(seed)`; every
  stochastic result carries its seed. Work slicing is by count, never by elapsed time. Every loop has an iteration cap as its main
  runaway guard; wall-clock budgets (`budgetMs`) are a secondary guard and never fire in the harness (virtual clock).
- **Hashes.** `inputHash` / `resultHash` / `dsHash` use `PRiSM_autoInterp.canon` + `hash16` (v3.3, frozen) when present, else a
  local 32-bit FNV-1a in 56 (flagged `weakHash:true`).
- **Evidence ids** (§6.10): every result object that produces a reportable number carries `ev:[id]`.
- **Inputs** are read through the §3.2 range table (`PRiSM_dfit_inputRanges`): out-of-range or unparsable values are clamped or
  replaced by the default with a warning, never passed on.

### 3.1 Dataset format (injection + falloff)

DFIT uses the normal PRiSM dataset; nothing outside these fields is required.

```js
PRiSM_dataset = {
  t: [h],                    // monotonic after cleaning; hours since the first sample
  p: [psia],                 // primary pressure channel AS RECORDED at its gauge (bottomhole gauge if present, else surface); psig already +14.696 by 07
  q: [bbl/d] | null,         // injection rate, POSITIVE while pumping (bbl/min × 1440); null = rate unknown (events from pressure)
  pSurf: [psia] | undefined, // surface (wellhead) pressure when the primary is a bottomhole gauge
  pBh:   [psia] | undefined, // second bottomhole gauge (rare; dual-gauge QA)
  qFb:   [bbl/d] | undefined,// metered flowback rate, POSITIVE out of the well (3.4b analysis; kept from 3.4a)
  T:     [°F]   | undefined, // temperature of the primary gauge
  pAnn:  [psia] | undefined, // annulus pressure (leak / communication check)
  name, source, timeUnit:'h', timeUnitOriginal, rateUnit:'bbl/d', ratePhase:'water',
  meta: { psigConverted: { p?:14.696, pSurf?:14.696, pAnn?:14.696 } }      // written by 07 when it converted a psig column
}
```

- 07 maps the new roles (`pressure_surf`, `pressure_ann`, `temp`, `rate_fb`) and the units `bbl/min`, `bbl/h`, so a reload
  re-creates every channel from the persisted Data-tab text.
- **psig.** 07 is the single conversion point (+14.696, recorded in `meta.psigConverted`). A test whose `channels.atmPsia` differs
  (12.2 psia at 5,000 ft elevation is offered as a hint from the well elevation) gets the difference `atmPsia − 14.696` applied by
  `PRiSM_dfit_prepare` to the channels 07 converted; a channel marked psig in `channels.psig` that 07 did not convert (live-data
  "Send to PRiSM" with `meta.unit:'psig'`) gets the full `atmPsia`. The dataset is never rewritten.
- **Non-destructive fixes.** Unit and depth blunder fixes, masks and the clock offset are stored in `T.inputs.channels` and applied
  by `PRiSM_dfit_prepare` (logged, undoable, persisted).
- **Demo and gauge sets** are committed through `PRiSM_commitDataset` (sources `'dfit-demo'`, `'gauge'`) and their CSV, with role
  headers, is written to the Data-tab text, so a reload re-creates them and `T.dsRef.hash` still matches.
- **High-rate windows** (≥ 2 Hz around shut-in, step changes, flowback start, ramps) do not go into the dataset. On import, when the
  source sampling is ≥ 2 Hz, 56 cuts up to three windows (shut-in −10 s … +120 s; the last step-down step; the flowback start or a
  re-pressurisation ramp) and 59 stores them (§3.11).
- **Large records** (> 200,000 rows) are imported with the v3.3 chunked parser `WTS_buildup.data.parseJob` (psig and patm aware) or
  read from the historian with `WTS_buildup.data.fromHistorian`, both resolved at call time; "Use for DFIT" in step ① builds the
  analysis set with `PRiSM_dfit_resample` (pumping period ≤ 2,000 points, falloff log-spaced from shut-in) and commits it. Without
  v3.3, the gauge manager (19) path is used.
- The rate stays positive in the dataset; the falloff sign and the injection-like history come from `testType:'falloff'` and the
  idealised `PRiSM.multiRate` schedule (§2.6).

### 3.2 DFIT inputs (`T.inputs`, edited in step ①; units per §3.0)

```js
DfitInputs = {
  datumTvd: null,            // REQUIRED for gradients: mid-perforation TVD (ft); null → gradients and conversion disabled with a warning
  datumMd: null,             // null = vertical (MD = TVD)
  survey: null,              // [[md, tvd], …] ascending; linear interpolation
  gauge: { bhTvd: null, bhMd: null },          // primary bottomhole gauge depth (null = gauge at datum)
  strings: [],               // flow path top → perforations: [{tubKey|null, id, od, wall, topMd, botMd}] (WTS_tubulars keys)
  fluid: { kind:'water', rhoPpg:8.43, salinityWt:null, muCp:1.0, fr:0, nPrime:null, kPrime:null, tInjF:70 },
                             // kind 'water'|'slickwater'|'gel'|'oil'; fr = friction reduction 0–0.85 (Virk cap)
  temp: { model:'static', surfF:70, gradFper100:1.5, tauLoH:0.5, tauHiH:5 },   // 'static'|'displaced' (3.4b: 'ramey')
  perfs: { n:null, dIn:0.40, cd:0.62 },      // n = shot holes (null = no open-perforation estimate)
  rock: { Ep:null, EpSource:'unknown', nu:0.25, hf:null, hp:null, barrierSpacing:null,
          sigmaVGrad:1.0, sigmaVGradLo:0.9, muFricWarn:0.6, muFricVeto:1.0, biot:1.0 },
                             // EpSource 'static'|'dynamic-corrected'|'dynamic'|'unknown'; heights ft
  priors: { sigmaGrad:null, sigmaGradSd:0.02, piGrad:null },           // psi/ft; used by forecast, designer, blunder scoring, triage bands
  channels: { primary:'bh', psig:{ p:false, pSurf:false, pAnn:false }, atmPsia:14.696, clockOffsetH:0,
              unitFix:{ p:null, pSurf:null, q:null, t:null },          // {kind, factor, offset} from an applied blunder fix
              depthFix:null, mask:[] },                                // mask: [[t0, t1, why]]
  events: { tStart:null, tb:null, ts:null, flowback:null },            // user overrides only (detected events live in the run)
  options: {
    alpha:'auto',            // 'auto'|0.5|1|'general'|'data' ('auto' = data-driven when rate history exists, else 0.5)
    alphaGeneral:0.75,       // the α used when alpha = 'general' (PRiSM_dfit_g accepts (0.5, 1]; stored 0.51–1)
    tp:'pump',               // 'pump'|'breakdown'|'veq' (pump start / breakdown / Vi ÷ q_last, or ÷ the main-stage rate after a step-down)
    L:0.1,                   // Bourdet window, ln units (0.05–0.4)
    gMin:'auto',             // 'auto' | number (G units)
    eps:{ compliance:0.02, tangent:0.02, loglog:0.05 },
    tau:{ abs:15, fSigma:0.003, fN:0.03 },   // closure tolerance scale τ (§4.8)
    familyWeightF1:0.5,      // range mode: interpretive weight of family F1 (F2 gets 1 − w); logged when changed
    axisLock:false, ppd:false,
    aca:{ origin:'centroid', LB:0.25, carterExactFR:false, tideRemove:'auto' },
    unc:{ n:1000, seed:1 },
    triage:{}                // threshold overrides (§6.3), keyed by check id
  }
}
```

Reservoir and fluid properties (`pi`, `phi`, `ct`, `mu`, `h`, `T_F`, `fluid`, `SG_g`) are **not** copied here: engines receive
`well = PRiSM_getWell()` (C1) and the DFIT cards edit them through `PRiSM_setWell(patch, {source:'user'})`. DFIT writes
C1 only with `{source:'dfit'}` for `testType`, `tShut`, `tp`, `pwf0` and (on hand-off) `pi`. `muRes` is always the reservoir-fluid
viscosity from C1; the injectate viscosity is `fluid.muCp`.

**Range table** (`PRiSM_dfit_inputRanges`, frozen in WP0; engines clamp with it, U13 enters blank / 0 / −1 / 1e12 into every
field). Every two-value quantity is two fields (no "lo, hi" text box, so 50-a11y's decimal-comma rewrite of "1,5" cannot corrupt
it); text inputs are parsed with `WTS_parseNumber`.

| Field (element id `prism_dfit_…`) | min | max | default | unit |
|---|---|---|---|---|
| `datumTvd`, `datumMd`, `gauge.bhTvd`, `gauge.bhMd` (`datum_tvd`, …) | 100 / 0 | 40,000 | null | ft |
| survey rows / string rows / tests per well | 0 | 2,000 / 10 / 12 | — | rows |
| `fluid.rhoPpg` | 6 | 20 | 8.43 | ppg |
| `fluid.salinityWt` | 0 | 30 | null | wt % |
| `fluid.muCp` | 0.1 | 5,000 | 1.0 | cp |
| `fluid.fr` | 0 | 0.85 | 0 | – |
| `fluid.nPrime` / `fluid.kPrime` | 0.1 / 1e-6 | 1 / 1 | null | – / lbf·sⁿ/ft² |
| `fluid.tInjF`, `temp.surfF` | 32 / −20 | 300 / 150 | 70 | °F |
| `temp.gradFper100` | 0.5 | 4 | 1.5 | °F/100 ft |
| `temp.tauLoH` / `temp.tauHiH` | 0.05 / 0.1 | 24 / 72 | 0.5 / 5 | h |
| `perfs.n` (integer) / `perfs.dIn` / `perfs.cd` | 1 / 0.1 / 0.4 | 2,000 / 1.5 / 1.0 | null / 0.40 / 0.62 | – / in / – |
| `rock.Ep` | 0.1 | 20 | null | 1e6 psi |
| `rock.nu` | 0.05 | 0.45 | 0.25 | – |
| `rock.hf`, `rock.hp`, `rock.barrierSpacing` | 1 | 5,000 | null | ft |
| `rock.sigmaVGrad` / `rock.sigmaVGradLo` | 0.7 | 1.3 | 1.0 / 0.9 | psi/ft |
| `rock.muFricWarn` / `rock.muFricVeto` | 0.3 | 1.2 | 0.6 / 1.0 | – |
| `rock.biot` | 0 | 1 | 1.0 | – |
| `priors.sigmaGrad` / `priors.sigmaGradSd` / `priors.piGrad` | 0.4 / 0.005 / 0.2 | 1.3 / 0.2 / 1.0 | null / 0.02 / null | psi/ft |
| `channels.atmPsia` | 10 | 15.2 | 14.696 | psia |
| `channels.clockOffsetH` | −24 | 24 | 0 | h |
| `options.alphaGeneral` (α for `alpha:'general'`, open at ½) | 0.51 | 1 | 0.75 | – |
| `options.L` | 0.05 | 0.4 | 0.1 | ln units |
| `options.gMin` | 0 | 50 | auto | G |
| `options.eps.*` | 0.005 | 0.3 | 0.02 / 0.02 / 0.05 | – |
| `options.tau.abs` / `fSigma` / `fN` | 1 / 0 / 0 | 200 / 0.02 / 0.2 | 15 / 0.003 / 0.03 | psi / – / – |
| `options.familyWeightF1` | 0 | 1 | 0.5 | – |
| `options.aca.LB` | 0.1 | 0.5 | 0.25 | ln units |
| `options.unc.n` (integer, **hard cap**) | 100 | 2,000 | 1,000 | draws |
| `options.unc.seed`, designer seed, synth seeds (integer) | 1 | 2³¹ − 1 | 1 | – |
| designer `n` (integer, hard cap) | 50 | 2,000 | 500 | draws |
| sandbox `V` / `q` / `tEnd` | 0.1 / 0.05 / 0.01 | 2,000 / 100 / 10,000 | 25 / 5 / 300 | bbl / bbl/min / h |

### 3.3 State (`st.dfit` in `wts_prism_state`)

```js
st.dfit = {
  v: 2,
  active: 't1',                                  // id of the test shown; the 3.4a UI shows one test at a time
  tests: [ DfitTest ],                           // ≥ 1 once DFIT mode was opened; ≤ 12 per well (stacked zones)
  plan: { ranges:DesignRanges, summary, corridor:{t:[], p10:[], p50:[], p90:[]}, ticks:{} } | null,  // designer (≤ 60 points)
  live: { tags:{p, pSurf, q, T}, enabled:false, verdictLog:[{t, state, family, text}] } | null       // 3.4b; no buffers stored
}

DfitTest = {
  id: 't1', zone: '',                            // zone label shown in the tests table (depth from inputs.datumTvd)
  dsRef: { kind:'data-tab'|'gauge'|'demo', id:null|string, name, hash, n } | null,   // dataset these decisions belong to
  inputs: DfitInputs,                            // §3.2 (includes channels and event overrides)
  picks: {
    isip:    { value, method, source:'auto'|'user', reason, at } | null,
    closure: { mode:'consensus'|'family'|'user', family, method, p, dt, source, reason, at } | null,  // 'family' = range end chosen (Q6)
    user:    { [toolKey]: { G, dt, p, value, at } },          // line-tool results (store:false keys; drawn only by dfit-picks)
    aca:     { origin, linWin:[t0,t1]|null, radWin:[t0,t1]|null, piLevel:null }
  },
  summary: {                                     // PRiSM_dfit_summarise(run): rail, report key line, Quick Report, tests table
    at, dsHash, inputHash, resultHash, stale:false, forOtherDataset:false,
    isip:{value, spread, label}, closure:{mode, value, lo, hi, label, families:{F1:{p50}, F2:{p50}, F4:{p50}}},
    pn, eta, CL, Gamma, xf, R, model, pi:{value, lo, hi, label}, khmu, k, kLo, kHi,
    triage:'green'|'amber'|'red', grade:'A'|'B'|'C'|'D', unc:{seed, n},
    gdpdgN:{ x:[], y:[] }                        // ≤ 60 points of G·dP/dG normalised (x = G/G_c, y ÷ (m_G·G)) for the overlay
  } | null,
  lk:   { cfg, preset, fit:{params, ci95, ci95Inflated, groups, chi2, at} | null, gridN } | null,   // leak-off model
  hf:   { key, kinds:['shutin'|'step'|'flowback'|'ramp'], bytes, store:'idb'|'ls' } | null,       // high-rate window index
  log:  [ { seq, at, who, item, old, new, reason } ]                                              // append-only, cap 300
}
```

- Derived arrays (prepared series, derivatives, picks with bands, ACA arrays, samples) are **never** stored; they live in the
  runtime `DfitRun` on `st._dfitRun` and are rebuilt from the dataset and `T` on restore. The what-if marker lives on
  `st._dfitWhatIf` (runtime only).
- **Undo extra** `PRiSM_undoExtras.dfit.get()` returns decisions only — `{active, test:{id, inputs, picks}}` of the active test
  (≤ 10 kB; no log, summary, lk.fit, plan or hf) — and `set(v)` writes them back, marks the summary stale and re-runs the fast
  pipeline. `events:['prism:dfit-updated']`.
- `who` is the free-text analyst name from the report options (default empty). Size caps: `st.dfit` ≤ 100 kB (log condensed beyond
  300 entries per test; corridor ≤ 60 points; `gdpdgN` ≤ 60 points).

### 3.3a Runtime result `DfitRun` and the pure pipeline (57)

```js
DfitRun = { v:1, ok, fast:bool, dsHash, inputsHash, picksHash, seed,
            prep:Prepared, events:Events, triage:Triage|null, isip:IsipResult, derivs:Derivs,
            picks:[ClosurePick], consensus:Consensus|null, consensusLite:ConsensusLite,
            classification:Classification, frac:{ chosen:FracOutputs|null, byFamily:{F0?, F1?, F2?, F3?, F4?} },
            whatIf:[FracOutputs], aca:AcaResult|null, leak:LeakPlot|null, unc:Uncertainty|null,
            evidence:EvidenceIndex|null, report:ReportModel|null, grade:{letter, why}|null,
            summary, warnings:[Warning], counts:{evals, refits, draws} }   // counts: what acceptance tests assert instead of times

ConsensusLite = { mode:'single'|'range'|'none', value, range:{lo, hi}|null,
                  families:{F1:{p50}|null, F2:{p50}|null, F4:{p50}|null}, confidence:'stale' }   // fast pipeline (no grid)
```

- `PRiSM_dfit_pipeline(ds, inputs, well, picks, opts) → DfitRun` — pure, synchronous; `opts {fast:false, seed, uncN, stages:'all'
  | [stage id…] (list form: prepare, events, isip, derivs, consensus, frac, aca, uncertainty, report), whatIf:null|{p},
  strapVolume, tCloseS, tide}` (the last three also from `ds.meta`; Appendix D). `fast:true` skips the stability grid, the bootstrap and the uncertainty (undo, drag preview, live, replay).
  Stage order is §4.20 and exists only here.
- `PRiSM_dfit_pipelineJob(...)` → `Job<DfitRun>` with the identical result (U8 and C8 check sync = job).
- `PRiSM_dfit_summarise(run) → DfitTest.summary`.
- Callers: 59's ▶ Analyse (Job), undo restore and drag preview (`fast`), `PRiSM_dfit_replay` and `PRiSM_dfit_live` (stage subsets),
  `PRiSM_dfit_synth.score`'s callers (`dfit-validate.js`, `dfit-integration` I11–I13). No caller re-implements the stage order.

### 3.4 `WTS_wellbore` (48-calc-wellbore.js, WP1; 3.4b items in `48-calc-wellbore-field.js`)

| Function | Input | Output |
|---|---|---|
| `column(spec)` | `{survey, strings, fluid, temp, datumTvd, datumMd}` | `Column {ok, tvdAt(md), mdAt(tvd), capacityAt(md) bbl/ft, segments:[{topMd, botMd, id, od, wall, area}], Vw bbl, warnings}` |
| `csys(column, fluid, T)` | | `{ok, cSys, cFluid, cPipe (1/psi), VwCw (bbl/psi), waveSpeed (ft/s), rhoSlug (slug/ft³)}` — the **one** system compressibility c_sys = c_fluid + ψ·D/(E_s·e) used for storage, the ramp and the hammer (§4.3, §4.17) |
| `tempProfile(column, opts)` | `{model:'static'\|'displaced'\|'ramey'*, t, Vinj, q, tauLoH, tauHiH}` | `{ok, T(tvd) → °F, model}` (* 3.4b) |
| `hydrostatic(pKnown, tvdKnown, tvdTarget, column, T)` | | `{ok, p, rhoBar (ppg), dp, rangeNote}` (ρ(p,T) RK2 at 10 ft; ρ_sc(S)/B_w via `PRiSM_pvt_correlations.Bw_meehan`; gas sections through `WTS_gradient_compute`) |
| `pipeFriction(q, seg, fluid, T)` | q bbl/min | `{ok, dpdl psi/ft, v ft/s, re, regime:'laminar'\|'turbulent', f (Fanning), model:'newtonian'\|'fr'\|'powerlaw'}` |
| `perfFriction(q, perfs, rhoPpg)` | | psi: 0.2369·q²·ρ/(n²·d⁴·Cd²) |
| `nwbLoss(q, {b, beta, qt})` | | psi: two-branch law (§4.2) |
| `bleedOff({b, beta, qt, VwCw, d0})` | | `{t1psi h, t10psi h, curve(dt) → psi}` |
| `convert(ds, prepCtx, opts)` | `opts {band:true}` | `{ok, pw:[], parts:{hyd:[], pipe:[], perf:[], nwb:[]}, band:{p10:[], p90:[]}\|null, terms:[{name, dpAtShutIn}], flags:[Warning], vacuumAt:h\|null}` |
| `vacuum(piPsia, column, T, atm)` | | `{risk:'none'\|'surface-zero', pSurfAtPi, text}` |
| `stepDown(steps, opts)` | `steps [{q, p, n, t}]`, `opts {beta:0.5\|'free', drift:true, pipe:fn\|null, perfs, rhoPpg}` | `StepDown {ok, pFrac, se:{pFrac, a, b}, a, b, beta, drift, nOpen, nOpenBand:{p10,p50,p90, driver}, at:{dpPerf, dpNwb, dpPipe}, label, refused:null\|string, resid, corr}` |
| `stepDownDesignCheck(steps)` | | `{ok, se:{pFrac, a, b}, why}` (refuses a split when the rate range < 30 % or < 3 steps) |
| `stepRate(steps, opts)` **(3.4a basic)** | `steps [{q, t0, t1}]` from `Events.steps` plus the (t, p) arrays, `opts {stabFrac:0.3, dpdtMax, nBoot:500, seed}` | `StepRate {ok, qStar (bbl/min), fep, band:{p10,p50,p90}, b1, b2 (psi per bbl/min), fTest:{F, p}, breakFound, steps:[{q, pEnd, dpdt, stabilised}], why}` |
| `ramp(t, p, q, win, opts)` **(3.4a)** | a re-pressurisation window, `opts {VwCw, nBoot:500, seed, kind}` | `Ramp {ok, kind:'pre-breakdown'\|'reopening'\|'lot'\|'pump-in', VwCwRamp, knee:{p, V, t}\|null, band:{p10,p50,p90}\|null, slopes:{s1, s2} (psi/bbl), stiffRatio, nwbCorr (psi)\|null, label, why}` |
| `hammerQuick(tHz, p, ts, ctx)` | high-rate window, `ctx {column, fluid, qShut, tClose, reflectorMd\|null}` | `Hammer {ok, why, c, cSource:'korteweg'\|'calibrated', T, tau, delta, A, phi, isip, regime:'ringing'\|'staircase'\|'single'\|'none', Lquarter, Lhalf, reflectorMatch:'perfs'\|'shallower'\|'deeper'\|'unknown', gammaDecay, joukowsky:{expected, measured, ratio}, VwCwHammer\|null, tEnd h, sampling:{hz, per2Lc, ok}}` |
| `align(tp, p, tq, q, opts)` | two clocks | `{offsetS, driftSPerDay, score, events:[], hourShift:bool, method:'xcorr'\|'event'}` |
| 3.4b (`48-calc-wellbore-field.js`): `calibrateTwoGauge`, `stepRateSP` (superposition-corrected parting), `hall`, `flowback`, `pulses`, `mocSim`, `hammerFit`, `injector`, `stepDownHysteresis`; `tempProfile` 'ramey' | | `{FR, rhoEff, tauH, kPrime\|null, resid}`, `StepRateSP`, `Hall`, `Flowback`, `[Pulse]`, MOC traces and fit, `{regime, evidence, hall, masip(q)}` (§4.15–4.17) |

### 3.5 `56-prism-dfit-core.js` (WP2)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_units` | — | `{toEngine(obj), toDisplay(obj), table}` (bbl/min ↔ ft³/h 336.875, ft/√min ↔ ft/√h 7.74597, gal/100 ft² ↔ ft 1/748.05, psi·√in ↔ psi·√ft 0.288675, cp ↔ psi·h 4.02883e-11, md ↔ ft² 1.062315e-14, bbl/psi ↔ ft³/psi 5.614583) |
| `PRiSM_dfit_inputRanges` | — | the §3.2 range table `{[path]: {min, max, def, unit, integer}}` and `clamp(inputs) → {inputs, warnings}` |
| `PRiSM_dfit_dsHash(ds)` | | 16-hex string (hash16 of the canonical t/p/q, or FNV-1a) |
| `PRiSM_dfit_prepare(ds, inputs, well)` | | `Prepared {ok, t:[], pw:[], band:{p10:[],p90:[]}\|null, pSurf:[]\|null, q:[] (bbl/min), T:[]\|null, idx:[] (dataset rows), src:'bh'\|'surface-converted', sigma, quantum, applied:{atmDelta, unitFix, clockOffsetH, masked}, flags:[], hf:{windows}\|null}` (masked samples removed, §3.0) |
| `PRiSM_dfit_resample(t, p, ts, opts)` | `opts {perDecade:40, dpMin, keepPump:2000}` | `{idx:[], t:[], p:[]}` — O(n), log-spaced from shut-in plus a pressure-increment rule |
| `PRiSM_dfit_events(prep, overrides, opts)` | `overrides` = `inputs.events`, `opts {qStartFrac:0.02, qStopFrac:0.05}` | `Events` (below) |
| `PRiSM_dfit_g(dtD, alpha)`, `PRiSM_dfit_gPrime(dtD, alpha)`, `PRiSM_dfit_G(dtD, alpha \| gSpec)`, `PRiSM_dfit_Ginv(G, alpha \| gSpec)` | `alpha` 0.5, 1 or any value in (0.5, 1]; `gSpec` from `gFromHistory` | numbers (closed forms, 64-point Gauss–Legendre, data-driven) |
| `PRiSM_dfit_gFromHistory(schedule, ts, tp, opts)` | `opts {alpha, area:'volume'\|'model', modelHist:{t:[], AL:[], Bw:[]}}` | `gSpec {kind:'data'\|'model', g0, G(dt), Gp(dt), GD(dtD), GpD(dtD), gD(dtD), tauNodes}` — `G` / `Gp` take Δt in **hours** (§3.0), `Gp` = dG/dΔt_D; the engine works on Δt_D through `GD` / `GpD` / `gD` (Appendix D) |
| `PRiSM_dfit_hFn(dtD, spec)` | (gate G6, §4.6) | h(ΔtD) and dh/dΔtD, or `null` until the definition is verified |
| `PRiSM_dfit_derivs(prep, events, opts)` | `opts {alpha, tp, L, gMin, isip}` | `Derivs` (below) |
| `PRiSM_dfit_isip(prep, events, derivs, ctx)` | `ctx {hammer, stepDown, bleed, lumped:{lambda, pVisc}\|null}` | `IsipResult` |
| `PRiSM_dfit_closurePicks(derivs, ctx)` | `ctx {ramps:[Ramp], lkFit:LkFit\|null, user}` | `[ClosurePick]` |
| `PRiSM_dfit_varComplianceFit(derivs, ctx, opts)` | | `{ok, sigmaC, ci95, sc, fres, K, isip, corrSigmaSc, resid, rmse, profile:null}` (profile on demand) |
| `PRiSM_dfit_vcModel(G, params, ctx)` | `params {isip, K, sigmaC, sc, fres, sr, law:'exp'\|'hyp', Cd, pfo, pr, VwCw, cwOfP:null\|'gas', tipA, hrStep}` | `p[]` on the G grid — the G-domain forward model of the fit, also used by tests to build normal, matrix, PDL, contact, height-recession, tip-extension and storage signatures (constant or pressure-dependent wellbore compressibility) |
| `PRiSM_dfit_consensus(picks, derivs, ctx)` / `PRiSM_dfit_consensusJob(...)` | | `Consensus` / `Job<Consensus>` (stability grid over the closed-form methods) |
| `PRiSM_dfit_consensusLite(picks, derivs, ctx)` | | `ConsensusLite` (§3.3a; no grid) |
| `PRiSM_dfit_bounds(candidate, ctx)` | | `{admissible:bool, vetoes:[{rule, text, value, limit}], warnings:[{rule, text, value, limit}], frictional:{veto, warn}}` |
| `PRiSM_dfit_classify(derivs, ctx)` | `ctx {frac, curvExpRun:LkResult\|null, VwCwTheory, VwCwMeasured}` | `Classification` |
| `PRiSM_dfit_frac(pClosure, derivs, ctx)` | `ctx {events, isip, inputs, family}` | `FracOutputs` |
| `PRiSM_dfit_whatIf(candidates, derivs, ctx)` | `candidates [{label, family, p, method}]` | `[FracOutputs + {label}]` |
| `PRiSM_dfit_leakoffRate(derivs, frac)` | | `{dt:[], qL:[], VL:[], Vf:[]}` (from the data, §4.10) |
| `PRiSM_dfit_kBeforeClosure(frac, derivs, ctx)` | | `{kCL:{k, dpCL, factor:2, kCorr}, kH:{k, factor:1.5, kCorr}\|null, note}` (non-voting, §4.10) |
| `PRiSM_dfit_farField(derivs, events, ctx)` | | `{p, regime, window, note}\|null` (informational, non-voting) |
| `PRiSM_dfit_forecastClosure(derivs, ctx, sigmas)` | | `[{sigma, Gc, dtc}]` |

```js
Events = { ok, tStart, tb, pb, ts, tsRefined:true|false, tEnd, qMax, qLast, Vi, ViFrac, ViStar, Vfill, Vfb, qEq,
           VwCwMeasured, tp:{pump, breakdown, veq}, rampDownFrac,
           steps:[{t0, t1, q, pSettled, n, dir:'down'|'up'}],      // step-down / step-rate steps (bbl/min, psia)
           flowback:{t0, t1, q, V}|null,
           cycles:[{tStart, ts, Vi, closedBefore:bool, rampWin:[t0, t1]|null}],   // ramp window = re-pressurisation for WTS_wellbore.ramp
           schedule:[{t, q}],                          // idealised (bbl/min); 59 writes it to PRiSM.multiRate as bbl/d
           source:{tStart:'auto'|'user', tb:…, ts:…}, warnings:[], ev:['E1'] }

Derivs = { ok, alpha, gType:'a05'|'a1'|'general'|'data'|'model', tp, tpChoice, dt:[], dtD:[], G:[], p:[], dpIsip:[],
           GdPdG:[], dPdG:[], sqrtDt:[], sdPds:[], dPds:[], D:[], Dref:[], ppd:[], mG, earlyWin:[G0, G1],
           h:{ h:[], dPdh:[], hdPdh:[] }|null, axis:{ GdPdG:[lo, hi], dPdG:[lo, hi] },   // derivative y-range after G_min
           L, gMin, gMinWhy:'hammer'|'bleed-off'|'thermal'|'1%'|'user', usable:[0|1], sigmaY, ev:['G1'] }

IsipResult = { ok, value, spread, confidence:'high'|'medium'|'low', why:[string],
               candidates:[{method:'wh'|'g'|'sd'|'lp', family:'wave'|'falloff'|'friction', value, se, ok, upper:bool,
                            bleedAtEnd:null|psi, viscCorr:null|psi, why, ev}],
               loglogCheck:{isipBest, ok}, ev:['I1'] }

ClosurePick = { method:'tangent'|'sqrt'|'maxdpdg'|'compliance'|'crel'|'loglog'|'varcomp'|'model'|'fissure'|'reopening'|'user',
                family:'F0'|'F1'|'F2'|'F3'|'F4', vote:bool, ok, dt, G, p, band:{p10, p50, p90}|null, se, window:[G0, G1],
                admissible:true, vetoes:[], warnings:[], sameEvidenceAs:null|method, upperSide:bool, evidence:[{text, ev}], ev }

Consensus = { ok, mode:'single'|'range'|'none',
              value, range:{lo, hi, medians:{low, high}, lowFamily, highFamily}|null,   // lo = P10 of the lower family, hi = P90 of the upper
              families:{F0:{p10,p50,p90,sigma,n}|null, F1:{…}|null, F2:{…}|null, F3:{…}|null, F4:{…}|null},
              tau, metrics:{w, s, g},                    // half-width, family separation, grid spread (psi)
              bimodal:bool, preferred:'F1'|'F2'|null, preferredWhy, confidence:'high'|'medium'|'low'|'not-estimable',
              calibrated:false, hitRate:{p, lo, hi, n, mode}|null, rules:[{id, fired, value, threshold, text}],
              stability:{L:[0.05,0.1,0.2], tp:['pump','breakdown','veq'], grid:{F1:[[p]], F2:[[p]]}, unstable:bool},
              samples:{F1:[p], F2:[p], F4:[p]},  // kept in memory (DfitRun) for the uncertainty propagator, never stored
              counterfactual:{knob, setting, text}|null,   // read from the stability samples (§6.2)
              frictional:{veto, warn}, forecast:[{sigma, Gc, dtc}]|null, ev:['C1','K1'] }

Classification = { ok, type:'normal'|'matrix'|'pdl'|'tip'|'hr-contact'|'storage'|'undetermined',
                   scores:{normal, matrix, pdl, tip, hrContact, storage}, alt:[type],
                   features:{iota, curv, curvExp, curvWb, H, DoverDref, Rvis, VwCwRatio, unitSlopeSink:bool,
                             bleedOffExplained:bool},
                   pdl:{pfo, Cd, multAtIsip, sigmaHminusH}|null, hr:{Rs, hf0FromPKN, hf0FromKGD}|null,
                   evidence:[string], ev:['M1'] }

FracOutputs = { pClosure, family, method, Gc, dtc, dtDc, ViStar,
                eta:{a05, a1, matched, alphaUsed, etaF},              // etaF = fracture efficiency at shut-in (§4.9)
                Csys, VwCw, AfCf, Rvis, pn, chi, gradIsip, gradClosure, Gamma, GammaPKN, mG,
                geometry:{model:'PKN'|'KGD'|'radial', auto:true, consistent:bool, msgs:[],
                          byModel:{PKN:{cf, xf, Af, rp, CL, wAvg, wMax, Vf, VLpump}, KGD:{…}, radial:{cf, R, Af, rp, CL, …}}},
                spurt:{value|null, note}, kBefore:{kCL, kH}, pdlMult|null, farField|null,
                padFraction:{lo, hi}, stressCal:{dSigmaTect, sigmaModel, biot}|null, ev:['F1'] }
```

### 3.5a `49-calc-dfit-triage.js` (WPT; Round-9 helper, resolved at call time)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_triage(prep, events, ctx)` | `ctx {isip, derivs, hammer, ramps, stepDown, inputs, well, plan}` | `Triage` |
| `PRiSM_dfit_blunders(prep, events, ctx)` | | `[{id, hypothesis, score, bf\|null, fix:{field, from, to}, text}]` (rule flags in 3.4a; Bayes factors when the scoring is in, §1.5 slip list) |
| `PRiSM_dfit_repump(triage, ctx)` | | `{verdict:'continue'\|'caution'\|'repump', rules:[{id, level, text}], ack:false}` |
| `PRiSM_dfit_grade(triage, consensus, aca)` | | `{letter:'A'\|'B'\|'C'\|'D', why:[string]}` (§6.3) |

```js
Triage = { ok, light:'green'|'amber'|'red', verdict:'interpretable'|'partly'|'uninterpretable',
           checks:[{id, title, level:'pass'|'warn'|'fail'|'na', value, threshold, text, ev}],
           windows:{usable:[[t0, t1]], excluded:[{t0, t1, why}]},
           blunders:[…], repump:{verdict, rules, ack:false}, grade:{letter, why}, salvage:[string], ev:['Q1'] }
```

### 3.6 `57-prism-dfit-aca.js` (WP3)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_pipeline(ds, inputs, well, picks, opts)` / `…Job` / `PRiSM_dfit_summarise(run)` | §3.3a | `DfitRun` / `Job<DfitRun>` / summary |
| `PRiSM_dfit_timeFns(tInj, tcInj, opts)` | `opts {carterExact:false, ta:[]\|null}` | `{FL:[], FR:[], FRc:[]}` |
| `PRiSM_dfit_centroid(src)` | `{tcInj}` or `{tau:[], qL:[]}` | h (t_c/3 for Carter) |
| `PRiSM_dfit_acaDiag(t, p, opts)` | `opts {t0, LB, sigma}` | `{x:[], D:[], sD:[], n:[], piLo:[], piHi:[], piPoint:[] (null where s_D is not locally constant), noiseD:[], regimes:[{kind, t0, t1, slope}], sequenceOk:bool}` |
| `PRiSM_dfit_nolte(ctx)` | `{tInj, p, tcInj, V, linWin, radWin, CL, mu, phi, ct, h}` | `{lin:{pr, mL, k, win}\|null, rad:{pr, mR, khmu, k, win}\|null}` |
| `PRiSM_dfit_impulseLines(ctx)` | `{t, p, t0, V, win, regime, A, h, mu, phi, ct}` | `{pi, m, group:'Ask'\|'khmu'\|'ks'\|'kfw', value}` |
| `PRiSM_dfit_acaBounds(ctx)` | `{diag, Lmax, Amax, CL, CLlo, pMidHi, piLo, tEnd, t0, ranges}` | `{kLo, kHi, binding:[{edge, rule, value}], direction:'normal'\|'reversed'}` |
| `PRiSM_dfit_piConsensus(ctx)` | candidates + brackets | `{value, lo, hi, label:'high'\|'medium'\|'low', reasons:[], edges:{lo, hi}}` |
| `PRiSM_dfit_gasAdjust(t, p, ctx)` | `{pi, T_F, SG_g, ct}` | `{ok, pa:[], ta:[], iterations, converged}` via `PRiSM_mpTable` / `PRiSM_gasPseudoTime` |
| `PRiSM_dfit_crTransform(t, p, ctx)` | `{t0, V, pi\|null}` | `{t:[], y:[] (psi per STB/d), yPiFree:[]}` |
| `PRiSM_dfit_acaMatch(ctx, opts)` / `…Job` | `opts {models:['infiniteFrac','finiteFrac','homogeneous','radialComposite'], piBracket}` | `{ok, best:{model, k, L, pi, ci95, bic, params}, candidates:[…]}` |
| `PRiSM_dfit_aca(run, opts)` | a `DfitRun` with prep, events, frac | `AcaResult` (below) |
| `PRiSM_dfit_leakPlot(aca, ctx)` | `ctx {V, form, driftSpec (psi/d), tEnd, theta}` | `LeakPlot` (below) |
| `PRiSM_dfit_uncertainty(run, opts)` / `…Job` | `opts {n, seed, correlations, familyWeightF1}` | `Uncertainty` (below) |
| `PRiSM_dfit_live.create(ctx)` | `ctx {test:DfitTest, plan\|null, dpMin, cusum:{k:0.5, h:5}}` | `LiveSession {push(samples[{t, p, q?, T?}]) → {changed}, run(), verdict() → LiveVerdict, timeline(), close()}` |
| `PRiSM_dfit_replay(ds, ctx)` / `…Job` | | `{timeline:[LiveVerdict], firsts:{closureProvisional, closureConfirmed, piW25, piW10, radialSeen}, tEnd}` |
| `PRiSM_dfit_evidence(run)` | | `EvidenceIndex` |
| `PRiSM_dfit_reportModel(run, opts)` | `opts {groups, familyColumns, log, appendix}` | `ReportModel` |
| `PRiSM_dfit_checkQuoted(model, run)` | | `{ok, nChecked, nFailed, failures:[{ref, quoted, recomputed}]}` (a self-check; the report prints a line only on failure) |
| `PRiSM_dfit_exportText(run, template)` | `template {columns:[…], header:[…], sep, decimals}` or `'default'` | `{text, filename:'dfit-<name>-<hash8>.txt'}` (§6.10) |
| `PRiSM_dfit_fracSheet(run)` | | `{rows:[[name, family, p10, value, p90, unit, lens, ev, p50]], csv, head}` — `value` is the point estimate and p10 / p50 / p90 the uncertainty ensemble (p50 appended; changed at integration review: the point estimate used to sit in a column headed p50, so P10 > P50 was printed for p_i) |
| `PRiSM_dfit_handoff(run, target, opts)` | `'pta'\|'rta'\|'frac'`, `opts {family}` | `HandoffPacket` |
| `PRiSM_dfit_kConstraint()` | — | `{k, kLo, kHi, source:'aca-radial'\|'aca-match'\|'bounds'}` or `null` (reads `T.summary`) |

```js
AcaResult = { ok, regimeSummary:'none'|'linear'|'linear-radial'|'radial'|'spherical'|'storage',
              origin, t0, tcInj, V, diag, nolte, impulse:{lin, rad, sph},
              brackets:{cart:[lo,hi]|null, imp:[lo,hi]|null, deriv:[lo,hi]|null, combined:[lo,hi]|null, edges:{lo, hi}},
              pi:{value, lo, hi, label, reasons}, kh:{khmu, k, biasDirection:'upper'|'none'}|null,
              bounds:{kLo, kHi, binding, direction}|null, match:{…}|null, gas:{iterations, converged}|null,
              tidalCt:{ct, ok, note}|null,                 // 3.4b [M]
              eps:{atClosure, now}, ratios:{AacaOverAcarter, lambda}|null, warnings:[], ev:['A1'] }

LeakPlot = { ok, form:'linear'|'radial', A, B, d, dPrior, corrBd, separable:bool, qk, qkCI:[lo,hi], floor,
             piCorr, piUncorr, windowBiasNote, qkMax, theta, verdict:'none'|'leak'|'leak-or-drift'|'below-floor' }

Uncertainty = { ok, n, seed, mode:'single'|'range', familyWeight:{F1, F2}, inputs:[{name, dist, params, provenance}],
                outputs:{ [name]: { p10, p50, p90, unit, shares:[{input, s}], closureShare, bimodal:bool,
                                    byFamily:{F1:{p10,p50,p90}, F2:{p10,p50,p90}}|null, envelope:[lo, hi]|null } },
                tornado:[{output, input, lo, hi}], ev:['U1'] }
                // bimodal:true ⇒ p10/p50/p90 are null for that output; byFamily and envelope carry the answer (§6.6)

LiveVerdict = { t, state:'none'|'continue'|'provisional'|'confirmed'|'enough-pi'|'radial-unreachable'|'outside-corridor',
                family:'F1'|'F2'|null, p, forecast:{lo, hi}|null, text, ev }

EvidenceIndex = { items:{ [id]: {id, group, title, values:[{label, value, unit, dp}], path, text} }, order:[id] }

ReportModel = { title, keyRows:[[label, text]], keyLine, grade:{letter, why},
                sections:[{ id, title, order, blocks:[Block] }], appendix:EvidenceIndex, quoted:{ok, nFailed} }
Block = {kind:'kv', rows:[[label, value, ev]]} | {kind:'table', head:[], rows:[[]], ev:true|false}
      | {kind:'verdict', level:'ok'|'warn'|'bad', text} | {kind:'notes', text} | {kind:'plot', key, title}
      | {kind:'kpi', items:[{label, value, ev}]}

HandoffPacket = { target, family, setWell:{…}, multiRate:[{t, q (bbl/d)}], qEq, model, seeds:{xf, k, pi}, notes:[], blockers:[] }
```

### 3.7 `58-prism-dfit-leakoff.js` (WP4)

| Function | Input | Output |
|---|---|---|
| `PRiSM_dfit_lkDefaults()` | — | `LkConfig` in display units (the §5.4 base case; V_w·c_w from the wellbore card when set) |
| `PRiSM_dfit_lkToEngine(cfg)` | `LkConfig` | engine config (consistent units h, ft, psi, ft³, psi·h; derived κ, rp(L), C_c from k) |
| `PRiSM_dfit_lkSimulate(cfg, opts)` | `opts {grid:'fit'\|'display'\|'coarse'\|{dt0, r, nShut}, budgetMs:2000, maxSteps}` | `LkResult` (below) |
| `PRiSM_dfit_lkSample(res, t)` | | p_w at data times (linear in t) |
| `PRiSM_dfit_lkQuick(cfg)` | | `{rows:[{label, dtMin, qL}], VL, eta, tc, xf, wAvg, partition:{frac, form, wb}, CLeq}` |
| `PRiSM_dfit_lkSolveCL(cfg, dtcObserved)` | h | `{ok, CL, k\|null, runs}` (bisection on log CL or log k, ≈ 25 runs) |
| `PRiSM_dfit_lkGoalSeek(cfg, goal)` / `…Job` | `{kind:'visibleClosureBy', tH}` | `{ok, V, q, table:[…]}` (V × q grid scan, coarse grid) |
| `PRiSM_dfit_lkProfile(fit, key, opts)` / `…Job` | `key` 'sigmaC' \| 'pr', `opts {n:10}` | profile likelihood of one free parameter, one refit per step (Appendix D) |
| `PRiSM_dfit_lkFit(data, cfg, preset, opts)` / `…Job` | `data {t, p, w?}`, preset `'falloff'\|'full'\|'geometry'\|'pdl'\|'spurt'` | `LkFit` (below) |
| `PRiSM_dfit_lkFisher(cfg, design)` | `{tEnd, sigma, nPts, free}` | `{ci, corr, eig, sloppy:[{vec, text}]}` |
| `PRiSM_dfit_lkGroups(cfg)` | | `{Gamma, GammaPKN, mG, text}` |
| `PRiSM_dfit_identify(fit, ctx)` | | `Identify {rows:[{param, status:'determined'\|'group'\|'not', pm, text}], sloppyText, voi:[{source, reduction, text}], extend:[{tEndD, tEndH, sdPi (1 sd), pFixed, kRange, kBasis, pRadial}]}` (Appendix D) |
| `PRiSM_dfit_lkVerify()` | — | V1–V14 numbers (tests and a hidden self-check button) |
| `PRiSM_dfit_design(ranges, opts)` / `…Job` | `DesignRanges`, `opts {n:500, seed, grid:'coarse'}` | `Design` (below) |
| `PRiSM_dfit_leakBudget(V, tEnd, ctx)` | `ctx {tDLDraws\|null, tDL\|null, kDraws\|null, phi, muRes, ct, L, sigmaP, VwCw, dpdT, tempF, driftSpec}` (t_DL = P90 of `tDLDraws`, else `tDL`, else from `kDraws` with φ, μ, c_t, L — Appendix D) | `{qkMax, theta, regime, holdMin, dTneeded, holdRealistic:bool, text, warnings:[]}` (§6.4) |

```js
LkConfig = { mode:'propagate'|'prescribed'|'constP', geometry:'PKN'|'KGD'|'radial',
             schedule:[{t, q}],                       // bbl/min steps (from Events or typed)
             Ep, nu, hf, hp, muCp, KIc:14000, viscCal:1,
             Cw:0, k:null, Sp:0,                      // wall coefficient (ft/√min) and reservoir permeability (md): the fit parameters
             pdl:{Cd:0, pfo:null, fmax:50}, sigmaC, pr, VwCw, nwb:{a, b, beta:0.5}|null, pBd:null, L0:1,
             aperture:{law:'none'|'exp'|'hyp', sh:60, sc:100, fres:0.1, sr:null}, tip:{tauX:null}, farField:false,
             tEnd, phi, ct, muRes,
             CL:null, wc:null }   // optional display inputs: CL and w_c are converted to {Cw, k} at Δp_CL (§5.2) and never fitted

LkResult = { ok, why, t:[], pw:[], pf:[], L:[], A:[], AL:[], W:[], Vf:[], Vi:[], VL:[], VLw:[], VLc:[], VS:[], qL:[], eta:[],
             Bw:[], Ggen:[], events:{tb, pb, ts, isip, tcMech, tcHyd, Gc:{a05, a1, gen}}, xf:{ts, tc},
             CLeq, dpCL, wcEq, tDxfMax, balanceErr, regime:{tipShare}, validity:[Warning], warnings:[] }

LkFit = { ok, preset, params, ci95, ci95Inflated, corr, nEff, rho1, structural:{sigmaC:[lo,hi], pr:[lo,hi], k:[lo,hi], CLeq:[lo,hi]},
          groups:{Gamma, GammaPKN, text}, sloppy:[{vec, text}], starts:{n, converged}, runs, chi2, rmse, stopReason, warnings }

DesignRanges = { k:{p10, p90}, phi:{p10, p90}, ct:{p10, p90}, muRes:{p10, p90}, h:{p10, p90}, hf:{p10, p90}, hp,
                 Ep:{p50, sdLn}, nu, sigmaGrad:{p50, sd}, piGrad:{p50, sd}, datumTvd, strings, fluid,
                 gauge:{kind:'surface'|'bh', sigma, resolution, hz, driftPsiPerDay}, V:null|bbl, q:null|bbl/min, suggest:true,
                 allowedShutInD, targetW, repressurise:false, epsMax:0.05, leakEps:0.05 }

Design = { ok, n, seed, outcome:{label:'closure-only'|'linear'|'radial', text},
           tc:{p10,p50,p90}, shutIn:{p10,p50,p90, binding:'radial'|'3tc'|'afterflow'|'precision'},
           tRadial:{p10,p50,p90}, signalPsi:{p10,p50,p90}, Vmin, Rvis:{p50}, vacuum:{risk, text},
           gauge:{bhRequired, why:[], hz, resolutionPsi, driftPsiPerDay}, leak:{qkMax, theta, holdMin, dTneeded},
           stepDown:{rates:[]}, repressurise:{q, V, kneeP:{p10,p50,p90}}|null, precision:[{tEndD, sdPi}],
           checklist:[{id, text}], corridor:{t:[], p10:[], p50:[], p90:[]}, warnings }
```

### 3.8 `59-prism-dfit-ui.js` (WP6)

| Export | Purpose |
|---|---|
| `PRiSM_modeExt.dfit` | `{label, testType:'falloff', steps, tabs:{1:1, 3:2, 5:7}, stepView:{2: PRiSM_dfit_renderStep2, 4: PRiSM_dfit_renderStep4}, defaultPlot:'dfitG', showsPlot, showsModel:() => false, showsPanel, panelAllow:['crop','gauges','linetools'], plotsTab:{hide:['period','timeFn','overlay']}, note, rail, status, analyse, onEnter, onLeave, reportHeader, reportPlots, reportLegacySections:false, exportItems}` |
| `PRiSM_dfit_analyse(opts)` | ▶ Analyse in DFIT mode → `Promise` (runs `PRiSM_dfit_pipelineJob` inside `PRiSM_undoBatch`; writes `st._dfitRun`, `T.summary`, `multiRate`, C1) |
| `PRiSM_dfit_renderStep2(host)`, `PRiSM_dfit_renderStep4(host)` | step views (rendered into `#prism_stepview`) |
| `PRiSM_renderDfitDesignerTool(host)`, `PRiSM_renderDfitSandboxTool(host)` (`modes:'*'`), `PRiSM_renderDfitReplayTool(host)`, `PRiSM_renderDfitHammerTool(host)`, `PRiSM_renderDfitNotesTool(host)` | Tools drawer entries (registered in `PRiSM_toolCatalogueExtra`); 3.4b tools are registered by their own files |
| `PRiSM_dfit_state()` / `PRiSM_dfit_test()` / `PRiSM_dfit_selectTest(id)` / `PRiSM_dfit_addTest(opts)` | returns `st.dfit` (creates the default object) / the active test / switches the active test (loads its dataset through its `dsRef`, undoable) / adds a test |
| `PRiSM_dfit_setPick(item, value, {source, reason})` | the only writer of picks: appends to the log, fires `prism:dfit-updated {what:'pick', item}` (37 records the undo snapshot on that event), recomputes the fast pipeline |
| `PRiSM_dfit_applyHandoff(target, {family})` | confirm dialog → apply `PRiSM_dfit_handoff` inside one undo batch |
| `PRiSM_dfit_results()` | `T.summary` for the rail, report key line, `WTS_state.dfit` |
| `PRiSM_dfit_hooks` | read-only hook points for 3.4b files: `{liveVerdict:null, railRows:[], step2Cards:[]}` (merged, never replaced) |
| `PRiSM_plot_dfitDual`, `PRiSM_plot_dfitStrip`, `PRiSM_plot_dfitStack` | plot functions (host-IIFE scope, bridged to window) |

### 3.9 `PRiSM_dfit_synth`, `PRiSM_dfit_cal` and `WTS_dfitInfo` (Round-9 helpers)

```js
PRiSM_dfit_synth = {                                             // WP5
  version: 'g1',
  make(caseSpec, seed) → { ds, truth, artefacts, caseSpec },     // ds in §3.1 format
  demo(name) → ds,                                               // 'reference' | 'tight-linear' | 'conventional-radial' | 'contact' | 'pdl' | 'surface-gauge' | 'two-cycle'
  cases(kind) → [CaseSpec],                                      // 'integration' (3) | 'quick' (12) | 'benchmark' (900) | 'artefact' (60)
  score(run, truth) → { closure:{mode, right, err, inBand, intervalScore}, classify:{right, partial}, pi:{right, err}, k:{right}, labels }
}
CaseSpec = { id, source:'lk'|'aca-exact'|'gdomain', mechanism, lk:LkConfig|null, aca:{k, L, h, phi, ct, mu, V, tcInj, pi}|null,
             wellbore:{VwCw, cwOfP:null|'gas'|'air'}, noise:{sigma, rho1, quantum}, sampling:{dtS}, tEndFactor,
             artefacts:[{kind, …}], tags:[] }
truth = { sigmaC, sigmaCHyd, sigmaCF2, isip, pi, k, khmu, L, mechanism, regimeAtEnd, tcInj, eta, CL, Gamma, AfCf, Rvis, xf }

PRiSM_dfit_cal = { calibrated:false, version:null, generator:null, n:0,                       // placeholder (3.4a); WP8 writes it
                   hitRate:{ single:{high:null, medium:null, low:null}, range:{medium:null, low:null} },
                   intervalScore:{ range:null }, cusum:{ k:0.5, h:5, decimate:'2L' }, thresholds:{} }

WTS_dfitInfo = { notes:{ [methodOrFamily]: {title, assumptions, failureModes, cites:[string]} },    // WP6
                 open(key, opener) }                             // modal <dialog id="wts_dfit_info" class="rp-skip" data-rp-nosnap>
```

### 3.10 Events

| Event (window CustomEvent unless noted) | Fired by | Detail |
|---|---|---|
| `prism:dfit-updated` | 59 after each stored result or pick | `{what:'events'\|'isip'\|'closure'\|'classify'\|'frac'\|'aca'\|'unc'\|'triage'\|'pick'\|'test'\|'all', source:'auto'\|'user'\|'undo'\|'restore'}`; 37 records an undo snapshot on it unless `source` is `undo` or `restore` |
| `prism:dfit-model-updated` | 59 after a leak-off simulate or fit | `{kind:'simulate'\|'fit', ok}` |
| `prism:plot-hover` (generic, 02) | canvas with `opts.hoverEvent` | `{plotKey, x, y, index}` (bubbles) |
| `prism:well-changed` (existing) | DFIT writes with `source:'dfit'` | — |
| listened: `prism:dataset-loaded` | 59 | checks `T.dsRef.hash`, marks the summary stale, re-runs the fast pipeline if in DFIT mode |
| listened: `wts:project-loaded`, `wts:project-new` (document) | 59 | re-binds or resets `st.dfit`, drops `st._dfitRun`, releases live listeners and the session (Project New resets `PRiSM.mode` without `setMode`, so `ext.onLeave` would not run) |
| listened: `h2oil:pagechange` (document) | 59 | if the PRiSM root is no longer connected (`root.isConnected`, as 63-wellos.js:632–646 does): cancels a running Analyse job and releases live listeners |
| listened (3.4b): `wts:modbus-samples`, `wts:historian-updated` (document) | 59-prism-dfit-live while the live tool is open | samples → `LiveSession.push`; released on tool close, mode leave, `h2oil:pagechange`, `wts:project-new`, `wts:project-loaded` |

DFIT never fires `prism:fit-updated` and never calls `PRiSM_setLastFit`.

### 3.11 Storage keys and project files

| Key / store | Contents | Cap | Travels in |
|---|---|---|---|
| `wts_prism_state` (existing) | adds `dfit` (§3.3) | `st.dfit` ≤ 100 kB | project `prism` module (`PRISM_KEYS`), `storage`; multi-well blobs |
| `PRiSM_storage` analysis record `dfit-hf:<dsHash>` (IndexedDB, 19) | `{v:1, windows:[{kind:'shutin'\|'step'\|'flowback'\|'ramp', t0 (h), dtS, n, p:Int32Array-delta, pSurf\|null, q\|null, scale, offset}]}` | ≤ 4 windows × 12,000 samples | project files (19's store is already carried); keyed by dataset, so shared by wells using the same data |
| `wts_prism_dfit_hf` (fallback without IndexedDB) | the shut-in window only, same encoding | ≤ 150 kB | `storage` (well-scoped) |
| `wts_prism` (existing Data-tab text) | DFIT channels through the new 07 roles; demo and gauge sets as role-header CSV | existing | existing |

No new project module. 3.4b adds nothing persistent beyond `st.dfit.live.tags`.

### 3.12 Generic hook contracts (WPH)

```js
window.PRiSM_modeExt = window.PRiSM_modeExt || {};            // merge, never replace; read at call time
// ext keys read by the shell (all optional except label):
//   label, testType, steps{1..5}, tabs{n:tab}, stepView{n:fn(host)} (any n; rendered into #prism_stepview), defaultPlot,
//   showsPlot(entry,key), showsModel(entry), showsPanel(n, spec), panelAllow[], plotsTab{hide:[]}, note, rail(el),
//   status(snap) → {1..5:bool}, analyse(opts) → Promise, onEnter(prev), onLeave(next),
//   reportHeader(model) → {title, keyRows, keyLine}, reportPlots[{key,title}], reportLegacySections, exportItems[{id,label,fn}]
window.PRiSM_undoExtras = window.PRiSM_undoExtras || {};      // {key: {get() → JSON-safe (small), set(v), events?:[name]}}
window.PRiSM_undoBatch('begin' | 'end');                      // 37: nesting counter; one snapshot per outermost batch
window.PRiSM_toolCatalogueExtra = window.PRiSM_toolCatalogueExtra || [];   // [{id, fn, group, title, sub, modes:[]|'*'}]
window.PRiSM_drawPlot(canvas, plotKey, extraOpts);            // 04: registry build + entry.fn + _prismAxes + post-draw hooks
window.PRiSM_plot_overlay(canvas, drawFn);                    // 02: draw on the cached overlay frame (no full redraw)
// C7 panel spec may carry modes:[…]; PRiSM_mountTabPanels honours ext.showsPanel in ext modes
// 36: section fn may carry fn.modes = ['dfit'] and return {…, blocks:[{kind:'kv'|'table'|'verdict'|'notes'|'plot', …}]}
// 02: canvas._prismPointerOwner = fn(ev) → true to take the gesture; opts.hoverEvent → 'prism:plot-hover'
// 02/11: PRiSM_PLOT_REGISTRY[key].axes = {x:'lin'|'log', y:'lin'|'log'}; 11 gallery honours ext.reportPlots and entry.mode
// 11: PRiSM_analysisKeys[key].store === false → not stored in st.analysisKeyResults, not drawn by linetools-picks
// 05: window.PRiSM_rng(seed) → () → [0,1)   (seed null/undefined → 1; never Math.random)
// 36: window.PRiSM_reportKeyLine() → string, window.PRiSM_reportReady() → bool  (also read by 30-quick-report in ext modes)
```

### 3.13 Contract fixtures (`tests/_dfit-shapes.js`, WP0, frozen)

Exports `checkShape(name, obj) → {ok, errors:[path]}` for `DfitDataset`, `DfitInputs`, `DfitState`, `DfitTest`, `DfitRun`,
`Prepared`, `Events`, `Derivs`, `IsipResult`, `StepDown`, `StepRate`, `Ramp`, `Hammer`, `ClosurePick`, `Consensus`, `ConsensusLite`,
`Classification`, `FracOutputs`, `Triage`, `AcaResult`, `LeakPlot`, `Uncertainty`, `LkConfig`, `LkResult`, `LkFit`, `Identify`,
`DesignRanges`, `Design`, `LiveVerdict`, `EvidenceIndex`, `ReportModel`, `HandoffPacket`, `CaseSpec`; the range table; fixtures
`FIX.ds` (the reference DFIT of §4.21, 600 points, generated once from the research prototype and committed as data), `FIX.state`
(a complete `st.dfit` with two tests, one with a closure range), `FIX.run` (a complete `DfitRun` on `FIX.ds`) and `FIX.aca`
(example B); and `sharedApp(ctx)`: pure-engine test files declare `opts:false` and get one app per file, created lazily through
`ctx.loadApp()` and held in a module-level variable, with `resetDfit(app)` clearing `st.dfit`, `st._dfitRun` and the DFIT storage
keys between tests. Every WP asserts `checkShape` on its outputs; WP6 builds against the fixtures (and fake engines returning
`FIX.run`) until the engines land. The helper changes only through the lead, together with this section.

**WP0 resolutions** (frozen with the helper; the file header repeats them):
- Derivative arrays in `Derivs` (`GdPdG`, `dPdG`, `sdPds`, `dPds`, `D`, `Dref`, `ppd`) are magnitudes (≥ 0 for a falling
  pressure); `dpIsip = ISIP − p`. `AcaResult.t0`, `tcInj` and `diag.x` are on the injection clock (`x = t_inj − t0`).
  `Hammer.T` and `Hammer.tau` are seconds (wave quantities). Areas ft², widths in.
- The range table stores `rock.Ep` in psi (`display:{unit:'1e6 psi', scale:1e6}`); `datumTvd` / `datumMd` have min 100 ft and the
  gauge depths min 0. Row caps (survey 2,000, strings 10, tests 12) are table entries with `rows:true`; designer, synth and sandbox
  fields carry their own `scope`. Clamp rule: blank → default (no warning when the default is null or `'auto'`), unparsable →
  default with `INPUT_DEFAULT`, outside → nearest bound with `INPUT_CLAMPED`, integers rounded (`INPUT_ROUNDED`); invalid enums →
  default. `PRiSM_dfit_inputRanges` in 56 carries the same table, `enums`, `defaults()`, `clamp()` and `clampValue()` (SH2
  compares them).
- Hashes: `dsHash(ds) = hash16(canon({t, p, q}, 'inputs'))`; `inputHash` / `picksHash` = `hash16(canon(x, 'inputs'))`;
  `resultHash` = `hash16(canon(summary result fields, 'display'))` (53's frozen canon + hash16).
- The failure form passes every engine-output shape; `{}` and `null` never pass. Stored `DfitInputs` must lie inside the table.
- `FIX.run` follows §4.21's convention that the 25 bbl is V_i\* (an engine run on `FIX.ds` gives V_i\* 23.02 bbl): it is a shape
  and consistency fixture, not regression truth. The ISIP candidates are the §4.4 P3a given numbers.
- **WP0 fix round** (review of WP0):
  - **Votes.** Voting members are F1 `compliance`, F1 `loglog` when it is independent (|ι| ≥ 0.05, `sameEvidenceAs:null`),
    F2 `tangent`, F4 `reopening` and a `user` pick in F1 / F2 / F4. `crel`, `sqrt` and `maxdpdg` never vote — `sqrt` not even
    when ΔtD,c ≤ 5 and it carries no `sameEvidenceAs` (a √t pick never confirms a tangent pick); F0 and F3 never vote; a member
    with `sameEvidenceAs` set never votes.
  - **Clamp.** `clamp` / `clampInputs` always return inputs that pass `DfitInputs`: a non-object group → its defaults
    (`INPUT_DEFAULT`); survey rows `[md, tvd]` finite with MD strictly ascending and string rows with id, od, wall > 0, id < od,
    finite topMd < botMd (an invalid `tubKey` → null), others dropped (`ROWS_DROPPED`), then the row caps; flags (`psig.*`,
    `axisLock`, `ppd`, `aca.carterExactFR`) keep true / false, coerce 'true' / 1 and 'false' / 0, else the default; each
    `unitFix.*` is null or `{kind, factor, offset}`; `depthFix` null or an object; `mask` rows `[t0, t1, why]` with finite
    t0 < t1 (why '' when not a string); `events.tStart / tb / ts` finite or null; `events.flowback` null or finite t0 ≤ t1.
  - **Numeric strings.** A string with a comma is read with `WTS_parseNumber` (resolved at call time) when that parser follows the
    decimal-comma option; otherwise '1,5' → 1.5, '1,500' (1–3 digits, comma, exactly three digits) is ambiguous → default with
    `INPUT_DEFAULT` (never 1.5, never 1,500), '1,500,000' / '1,500.5' → thousands groups. Strings without a comma must match a
    strict decimal pattern.
  - **Modes.** Consensus: `single` ⇒ value, range null, confidence not `'not-estimable'`; `range` ⇒ value null, a range, not
    `'high'`; `none` ⇒ value and range null, `'not-estimable'`. ConsensusLite: the same value / range rules. Summary.closure:
    `single` ⇒ value, label not `'not-estimable'`; `range` ⇒ lo < hi and value null; `none` ⇒ value, lo and hi null.
  - `HandoffPacket.model` adds `'radialComposite'` (an `acaMatch` candidate, §3.6 / §6.8). `options.alphaGeneral` (0.51–1,
    default 0.75) holds the general α.
  - Enumerations frozen without an earlier §3 source: `AcaDiag.regimes[].kind` `'linear'|'bilinear'|'radial'|'spherical'|
    'storage'|'transition'|'artefact'`; `Uncertainty.inputs[].dist` `'normal'|'lognormal'|'uniform'|'triangular'|'fixed'|
    'empirical'`; `Consensus.counterfactual.knob` `'L'|'tp'|'ts'|'eps'`; `DfitDataset.rateUnit` `'bbl/d'|'STB/d'`;
    `channels.primary` `'bh'|'surface'`; `options.aca.origin` (and `AcaResult.origin`, `picks.aca.origin`) `'centroid'|'total'|
    'midInjection'|'sinceClosure'`; `options.aca.tideRemove` `'auto'|'on'|'off'`. Text fields are < 300 characters (§3.0).
  - `resetDfit` also runs the pending debounced C8 save (manual timers, `flush(400)`) and removes the `dfit` field of the
    persisted `wts_prism_state`. Because the failure form passes every engine-output shape, **WP tests assert `result.ok === true`
    next to `checkShape`**.
  - `FIX.ds` / `FIX.run.aca`: the after-closure line has m_L = σ_c − p_r = 2,500 psi for continuity, not from CL, so its F_L-line k
    (3.46e-3 md) differs from the CL k of `FIX.run.frac` (2.75e-3 md) by ≈ 26 %; it is not a physical consistency check.
- The 59 skeleton registers no `PRiSM_modeExt.dfit`, panels, plots, tools or undo extras (a stub mode would appear in the header
  select as soon as WPH lands); WP6 registers them. It also does not export the five `PRiSM_renderDfit…Tool` functions: 37's
  `listTools` discovers every `window.PRiSM_render*Tool` by name and would list them under "More" until WPH marks catalogue
  functions as seen. `PRiSM_dfit_kConstraint` returns `null` until WP3.

---

## 4. Algorithms

Every formula below was re-derived and checked numerically in the research scripts; the values quoted are the acceptance vectors
of Appendix A (the review's corrections are listed in Appendix B, items 9–16). Symbols follow §3.0. Engine internals use consistent
units (h, ft, psi, ft³, psi·h) and convert once at the
boundary.

### 4.1 Import, units, clock alignment, noise and resampling (56, `WTS_wellbore.align`) [H]

- **Units.** 07 maps time (s, min, h, d, dates), pressure (psia, psig, bar, kPa, MPa) and liquid rate (bbl/d, **bbl/min ×1440**,
  **bbl/h ×24**, m³/d, L/min). psig channels get `atmPsia`. The triage blunder library (§6.3) re-tests the unit choices.
- **Clock alignment** (rate logger vs gauge). Default: cross-correlation of first differences, maximise Σ Δp_i·Δq_i(t + lag) over
  ±30 min, rate interpolated onto the pressure clock at 0.1 s steps, parabolic refinement; fallback: event method (rate shut-in vs the
  largest negative pressure difference). Offsets > 2 s are shown and applied only after confirmation; a whole number of hours is
  labelled "time zone / daylight saving". Demo: a 37.4 s offset is recovered exactly. Cross-check: the pre-breakdown ramp must start
  when the rate starts.
- **Noise.** σ = 1.4826·MAD of first differences / √2; the quantum = the most common non-zero |Δp|; Hampel spikes (window 7,
  4 MAD) are flagged, never deleted.
- **Resampler** `PRiSM_dfit_resample` (O(n), one pass): keep every pumping sample up to 2,000 (above that, keep the minimum and the maximum
  sample of each bin — two extremes per bin);
  after shut-in keep a sample when Δln(Δt) ≥ ln(10)/40 (40 per decade) **or** |p − p_kept| ≥ dpMin = max(0.05 psi, 3σ, 10 quanta);
  bin value = median of the samples in the bin. Replaces `PRiSM_decimateLog` (O(target × n), record-time spacing) for DFIT.
- Failure modes: a single-step rate (no texture for cross-correlation → event method, then manual); quantised surface transducers
  (the window L is widened until ≥ 10 quanta change across it); duplicate or reversed times (triage fail).

### 4.2 Surface → bottomhole conversion (`WTS_wellbore`) [H for the physics, M for the inputs]

```
p_w = p_s + p_hyd(ρ(p,T), TVD) − Δp_pipe(q)        injection (q > 0); all friction signs flip for flowback
p_f = p_w − Δp_perf(q) − Δp_nwb(q)                  fracture entrance; after shut-in, friction = 0 once static
```

- **Hydrostatics** use TVD, friction and wave travel use MD (survey interpolation). dp/dz = 0.052·ρ(p,T), RK2 at 10 ft steps;
  ρ(p,T) = ρ_sc(S)/B_w(p,T), ρ_sc [lb/ft³] = 62.368 + 0.438603·S + 1.60074e-3·S² (S wt %), `B_w` from
  `PRiSM_pvt_correlations.Bw_meehan` (fitted to p ≤ 5,000 psia, T ≤ 260 °F: beyond that a "correlation range exceeded" note).
  8.43 ppg at standard conditions ⇔ S = 1.571 wt %. Gas or mixed sections through `WTS_gradient_compute` section by section
  (it works in psig: convert at the call).
- **Temperature models.** (a) static geotherm T = T_s + g_T·z; (b) displaced (DFIT): the top D = V_inj / capacity ft hold fluid at
  T_inj, the displaced column is g_T·D cooler than the geotherm, relaxing with e^(−t/τ_T), τ_T a band 0.5–5 h or fitted from a
  BH temperature trace; (c) Ramey (3.4b, long injections): T = g_T·z + T_s − g_T·A + (T_inj − T_s + g_T·A)·e^(−z/A),
  A = w·c_p·f(t)/(2πk_e), f(t) = −ln(r_o/(2√(α_e t))) − 0.290.
  Cross-reference (Well Performance, docs/WELL-PERFORMANCE-PLAN.md §4.6, D7, Q16): `WTS_wellbore._ramey` stays reserved for this
  DFIT 3.4b model; the production flowing-temperature path is the separate public `WTS_wellbore.flowingTemp(column, opts)` (A2, WP14),
  which offers `direction: 'inject'` for DFIT to call if it chooses.
- **Pipe friction.** v = 17.157·q/d² (ft/s; q bbl/min, d in); Re = 928·ρ·v·d/μ; laminar f = 16/Re; turbulent Colebrook (Fanning)
  through `WTS_flowline_friction.colebrook` (it returns Darcy; ÷ 4); dp/dL = f·ρ·v²/(25.8·d). Friction-reduced water:
  Δp = (1 − FR)·Δp_water, FR capped by Virk's asymptote (85 % at Re 549,856). Power law: Re_MR = 89,100·ρ·v^(2−n)/K·(0.0416·d/(3 + 1/n))^n,
  Re_crit ≈ 3,470 − 1,370·n, laminar dp/dL = K·v^n·((3 + 1/n)/0.0416)^n/(144,000·d^(1+n)), turbulent Dodge–Metzner. μ at the column
  temperature (`mu_w_meehan`).
- **Perforations:** Δp_perf = 0.2369·q²·ρ/(n²·d⁴·C_d²) (C_d 0.56–0.66 new; 37.6 psi for 12 × 0.40 in at 5 bbl/min, 8.43 ppg).
- **Near-wellbore (tortuosity), two-branch law:** Δp_nwb = b·q^β for q ≥ q_t, = b·q_t^β·(q/q_t) below (q_t default 0.1 bbl/min).
- **Friction bleed-off after shut-in:** V_w·c_w·dΔ/dt = −q(Δ). Pure q^½: 1/Δ = 1/Δ₀ + t/(b²·V_w·c_w) (reference, V_w·c_w 4.44e-3
  ft³/psi: 1 psi after 15.4 min; the tortuosity loss falls from 315 psi to ≈ 105 psi at 6 s and ≈ 29 psi at 30 s); two-branch:
  exponential below q_t with τ = V_w·c_w·b/√q_t (1 psi after 1.6 min). The bracket [1.6, 15.4] min is ΔtD 0.33–3.1 for tp = 5 min —
  the whole early G window — so G_min is moved past the time when the predicted Δ < max(1 psi, 3σ), the classifier tests this
  explanation before calling a PDL hump (§4.11), and the water-hammer ISIP fit carries the same term (§4.4). V_w·c_w is always the
  one system value of `WTS_wellbore.csys` or the ramp (§4.3).
- **Band** (first order, deterministic): each uncertain term is moved to its ±1σ value or band end one at a time — ρ_sc ±0.05 ppg,
  static vs displaced temperature model, τ_T band ends, friction ±10 % (water) / ±25 % (FR) / ±30 % (gel), C_d 0.62 ± 0.04, d ±8 %, b
  ± se from the step-down — (≈ 10 conversions, each column integrated at 5 surface-pressure nodes × 8 log-spaced times and
  interpolated per sample, ≈ 30 ms for 2,000 samples), and the deviations are combined in quadrature into P10/P90 (± 1.2816σ). The
  term list with its psi at shut-in is returned so the triage card can name the dominant term. The same terms enter the uncertainty
  propagator (§6.6) through the ISIP and closure spread.
- **Vacuum:** the surface stays liquid-supported only while p_w > p_hyd,column. p_s < 15 psig warns, < 0 psig fails; converted
  data after that time are masked ("ACA needs a bottomhole gauge"). Reference column (geotherm): p_w 4,500 → p_s 195 psia;
  4,300 → −3 psia.
- **Gauge to datum:** p_datum = p_gauge + 0.052·ρ̄_between·(TVD_datum − TVD_gauge) (+21.9 psi for 50 ft at 0.438 psi/ft).
- Failure modes: static p_w − p_s off the model by > 2 % (gas, wrong ρ, gauge offset); drift during the falloff (warm-back, gas
  migration); a negative step-down perforation coefficient (pipe friction overestimated); a hump right after shut-in (bleed-off or
  gauge thermal transient |dT/dt| > 1 °F/min). The reference well's column models give p_s 3,220 / 3,173 / 3,260 psia for BHP
  7,600 (constant 0.438 psi/ft / 60 °F isothermal / geotherm): the usual constant gradient is ≈ 40 psi off; DFIT warm-back drifts
  +18 / +34 / +57 psi for 25 / 50 / 100 bbl.

### 4.3 Events, volumes and the pumping time (56) [H]

- **Pump start** t_start: first rate above 2 % of q_max (pressure ramp onset when q is missing). **Breakdown** t_b: pressure
  maximum followed by a drop while pumping. **Steps**: rate plateaus (within 1 %) of ≥ 5 s before shut-in (down) or in a rising
  sequence (up, step-rate). **Shut-in** t_s: rate below 5 % of the last stable rate, refined to sub-sample resolution between the
  last pumping and the first falloff sample (the largest negative pressure difference, refined by the hammer onset when a high-rate
  window exists). **Flowback**: q_fb > 0. **Cycles**: separate injection periods; a cycle is "closed before" when the pressure fell
  below the previous cycle's closure. Every later cycle's re-pressurisation window is handed to `WTS_wellbore.ramp` (§4.15b) and
  gives a family-F4 reopening pick.
- **System compressibility** (one value for storage, the ramp and the hammer; `WTS_wellbore.csys`): c_sys = c_fluid + ψ·D/(E_s·e)
  (c_fluid = 1/K from `cw_dodson`, ψ ≈ 1 for thin-walled anchored casing, D/e from the string, E_s 30e6 psi). Reference 5½-in 20 lb/ft
  casing with water: c_fluid 3.13e-6 + pipe 0.44e-6 = **c_sys 3.57e-6 1/psi** = 1/(ρc²) at the 4,539 ft/s wave speed of §4.17.
- **Wellbore stiffness** from the pre-breakdown ramp (`WTS_wellbore.ramp`, kind `pre-breakdown`): V_w·c_w = q/(dp/dt); expected
  V_w·c_sys = 1,245.1 ft³ × 3.57e-6 = **4.44e-3 ft³/psi** (7.91e-4 bbl/psi) and dp/dt = **6,323 psi/min** for 5 bbl/min into
  10,000 ft of 5½-in 20 lb/ft casing. Compared in triage with the theory value and, when a known reflector exists, with
  L·A/(ρc²) from the measured hammer period — two independent detectors of air or gas in the well (§6.3).
- **Volumes:** V_i = ∫q dt; V_fill from the delay between the rate start and the pressure rise; V_fb = ∫q_fb dt.
  - V_i,frac = V_i − V_w·c_w·(p_shut-in − p_start) − V_fill (volume in the fracture and formation at shut-in);
  - **V_i\* = V_i − V_w·c_w·(σ_c − p_start) − V_fill** (volume that has left the wellbore by closure; it depends on the closure
    candidate and is recomputed per candidate). It is the volume in the closure balance η_G·V_i\* = C_sys·p_n (§4.6).
- **tp definitions** (all stored, default `pump`, sensitivity shown): pump = t_s − t_start; breakdown = t_s − t_b;
  volume-equivalent = V_i / q_last — or V_i / q_main when the injection ends below the main stage (a step-down, or a last rate under
  90 % of q_max), q_main = Σq²Δt / ΣqΔt of the cycle (amended at the integration review: after the reference step-down V_i/q_last was
  21.5 min against a 5.6 min pump time, and it fed a third of the stability grid, the uncertainty tp draws, the C2 schedule and the
  PTA hand-off). CL and xf hardly move with tp; Gc and η do (tp 5.0 / 3.5 / 6.0 min → Gc 18.00 / 21.87 / 16.28).
- **Ramp-down** > 10 % of tp makes the instantaneous shut-in undefined: the data-driven G (§4.5) becomes the default.
- **Idealised schedule** for C2 and the PTA hand-off: one step at **q_eq = (V_i − V_fill − V_fb)/tp_veq** from t_s − tp_veq to t_s,
  then 0 (59 writes it to `PRiSM.multiRate` in bbl/d). The wellbore-compression volume V_w·c_w·(p_shut-in − p_start) enters the
  formation after shut-in and is part of the impulse, as §4.12's V = injected − flowback; dropping it would understate V by ≈ 11 %
  in the breakdown example (V_f/V_i = 0.814 against V_f/V_i,frac = 0.916) and bias the transient kh/μ and the xf seeds by the same
  factor (I-test I15).

### 4.4 ISIP (56 + `WTS_wellbore`) [H]

At shut-in the BHP drops by Δp_perf + Δp_nwb (+ Δp_pipe at surface); then water hammer, friction bleed-off and pressure
redistribution follow. ISIP is the friction-free fracture pressure at t_s with the hammer removed. Four estimates:

1. **Water-hammer midline** (`hammerQuick`, needs ≥ 10 samples per 2L/c): fit
   p = p_f(G) + Δ_bleed(t; b, β, q_t, V_w·c_w) + A·e^(−t/τ)·cos(2πt/T + φ) over the first periods with `PRiSM_lm`, where p_f is
   linear in G (p_f = ISIP_wh − m·G) and Δ_bleed is the §4.2 friction bleed-off (seeded from the step-down b, β; V_w·c_w from the
   ramp), T started from the autocorrelation peak. A linear-in-time midline would return p_f + Δ(t) — in the reference the
   tortuosity loss falls from 315 psi to ≈ 105 psi at 6 s and ≈ 29 psi at 30 s — so it is biased high by tens to hundreds of psi on
   tortuosity-dominated wells. **Acceptance rule:** ISIP_wh is accepted as a family member only when the bleed-off term is fitted, or
   when the predicted Δ at the end of the fit window is below max(2 psi, 3σ); otherwise it is shown as an **"upper estimate"**
   (`upper:true`) and does not enter the reconciliation. Quick fallback (no high-rate window): none (a mean of the first peak and
   trough is not offered, because it carries the same bias). Family **wave**.
2. **Early-G extrapolation**: p = ISIP − m_G·G over [G_min, G_lin]; the window grows while residuals stay unstructured (runs test;
   line R² vs quadratic). **On G, never on √Δt** (for ΔtD ≪ 1, G ≈ (4/π)·g′(0)·ΔtD is linear in Δt): the reference data give
   7,600.0 on G and 7,622–7,628 on √Δt. PDL or tip-extension curvature: fit after the hump or label "extrapolated through a
   non-linear segment". Family **falloff**.
3. **Step-down intercept** p_frac (§4.14). Family **friction**.
4. **Last pump pressure minus friction**: ISIP_lp = p_inj,end − a·q² − b·q^β (− Δp_pipe) − (Λ − 1)·p̄_visc. The last term is the
   in-fracture viscous redistribution that disappears at shut-in (≈ 35 psi in the PKN reference at 1 cp, above the high-agreement
   band), taken from the lumped propagation law (§5.2) or the leak-off fit when available; without it the family is labelled
   "fracture-entrance pressure, upper estimate" and carries the term in its error budget. Same family as 3 (shared coefficients).

**Reconciliation:** inverse-variance mean over **families** (within a family the better-determined member; upper estimates excluded),
spread = max − min of the accepted family values. Label **high** when all accepted families agree within max(10 psi, 2 % of pn),
**medium** within **max(25 psi, 5 % of pn)**, low otherwise (outlier and likely reason listed). The spread feeds pn, xf and CL in the
uncertainty propagator but not Gc or η. **Log-log check:** the ISIP for which early Δp and D keep the Nolte-curve ratio (§4.6); a
wrong ISIP bends Δp while D is unchanged.

**Reference vectors.** Arithmetic check (P3a): the four numbers wh 7,605, G 7,600.0, sd 7,595.5, lp 7,599.4 reconcile to
**7,600 ± 5 psia** (0.760 psi/ft at 10,000 ft), label high — these are *given numbers* for the arithmetic only (the 7,605 was an
assumed fit value in the research note). Physics check (W16b, P3b): one lumped bleed-off simulation of the reference (step-down b,
β, V_w·c_w 4.44e-3 ft³/psi, a 50 Hz shut-in window with ringing, viscous redistribution from the mini-model at 1 cp) is generated in
the test; each accepted family recovers the simulation's ISIP within 5 psi, a linear midline over the same window reads ≥ 20 psi
high, and the wave estimate is flagged "upper" when the bleed term is switched off. The source of every vector is stated in the test.

### 4.5 G-function family (56) [H]

Carter leak-off (u = CL/√(t − τ) per face), area A_f = A_p·(t/tp)^α while pumping and constant after shut-in, linear compliance,
uniform net pressure:

```
V_L(t ≥ tp) = 2·r_p·A_p·[ CL·√tp·g(ΔtD) + S_p ]
g(ΔtD, α) = 2 ∫₀¹ √(1 + ΔtD − a^(1/α)) da
α = 1   : g = (4/3)·[(1 + ΔtD)^(3/2) − ΔtD^(3/2)],              g0 = 4/3
α = 1/2 : g = (1 + ΔtD)·asin((1 + ΔtD)^(−1/2)) + ΔtD^(1/2),    g0 = π/2
G(ΔtD) = (4/π)·[g(ΔtD) − g0]
dg/dΔtD: α = ½ → asin((1+ΔtD)^−½);  α = 1 → 2·[√(1+ΔtD) − √ΔtD];  general → ∫₀¹ da/√(1 + ΔtD − a^(1/α))
```

- α = ½ is the low-efficiency (leak-off dominated) bound; α = 1 the high-efficiency bound; the no-leak-off geometry values are
  PKN 4/5, KGD 2/3, radial 8/9 (g0 = 1.41495, 1.47835, 1.37689).
- **General α:** substitute a = 1 − (1 − u)² (removes the endpoint square root) and use 64-point Gauss–Legendre on u; agreement
  with the closed forms better than 1e-5 at ΔtD ∈ {0, 0.1, 1, 10, 61.7}.
- **Data-driven G** (`gFromHistory`): g(Δt) = 2∫₀¹ √((t_s + Δt − τ(a))/tp) da with τ(a) the opening time of area fraction a. First
  pass: a = (V(τ)/V_total)^α with V the cumulative injected volume (reduces to (t/tp)^α at constant rate); "model" option: τ(a) from
  the mini-model's own area history (`LkResult.AL`), which is exactly the self-consistent G that removes the α artefact (§5.5).
  Two cycles: when the fracture closed in between, the last cycle is analysed alone (re-opening); otherwise the generalised form
  handles the superposition.
- **Inverse** G⁻¹: bisection on log ΔtD, 60 iterations (G = 18, α = ½ → ΔtD = 61.019).
- **Asymptotes:** ΔtD ≪ 1: G ≈ 2·ΔtD (α = ½), (8/π)·ΔtD (α = 1); ΔtD ≫ 1: G ≈ (8/π)·√ΔtD − (4/π)·g0, which is why √t works for
  short injections. The α bounds differ in G by 5 % at ΔtD = 5 and < 2 % beyond 50,
  but η depends on α through 4·g0/π (2 vs 1.698) at any ΔtD (Δη = 0.015 at G_c 18, ≈ 0.03 at G_c ≈ 5): the α pair is shown whenever
  |η(½) − η(1)| > 0.01, and always in the what-if table.
- Check values: G(1, ½) = 4/π = 1.27324; G(1, 1) = 1.40638; G(10, ½) = 6.3159; G(100, ½) = 23.5495; G(100, 1) = 23.8307.
- Every plot and the report state "G type: ideal α = ½ / ideal α = 1 / general α / data-driven".

### 4.6 Derivatives, the closure balance and the diagnostic plots (56) [H]

- **Pressure-decline equation with storage:** C_sys·dp = −dV_L, C_sys = A_f·c_f + V_w·c_w. With constant-area Carter leak-off
  dV_L/dG = X = (π/2)·r_p·A_f·CL·√tp, so dp/dG = −X/C_sys ≡ −m_G. Without storage the slope is m_G0 = π·r_p·CL·√tp/(2c_f)
  (Nolte's form).
- **Closure balance with storage** (shut-in to closure, no spurt): X·G_c = C_sys·p_n and V_L(t_c) = V_i\* (§4.3), hence
  **η_G·V_i\* = C_sys·p_n** with η_G = G_c/(G_c + 4·g0/π). The data therefore give
  - **C_sys = η_G·V_i\*/p_n** (system compliance, ft³/psi) and **X = C_sys·m_G = η_G·V_i\*/G_c** (leak-off per unit G);
  - **A_f·c_f = C_sys − V_w·c_w** (V_w·c_w from the ramp, else from `WTS_wellbore.csys`) and R_vis = A_f·c_f/C_sys (§4.10);
  - p_n = m_G·G_c for normal leak-off (any spurt).
  The no-storage shortcuts "dV_L/dG = V_f/G_c", "C_sys = (V_f/G_c)/|dP/dG|", "V_f = η·V_i = A_f·c_f·p_n" are **not used**: with a
  wellbore they fix the system excess volume, not the fracture volume, and combined with a storage-corrected CL they double-count —
  xf, R and w̄ come out 1/R_vis too large (× 1.85 for a gas-filled wellbore) and R_vis itself is biased high (0.69 instead of 0.54).
  Test P18 (G-domain, `vcModel`) and integration I14 (mini-model with V_w·c_w = 0.178 ft³/psi) check that the chain recovers A_f·c_f,
  xf and R_vis.
- **Pressure-dependent wellbore compressibility.** With gas or air in the well c_w(p) ≈ c_liquid + φ_g/p, so
  C_sys(p) = A_f·c_f + V_w·c_w(p) grows as p falls and |dP/dG| falls (curvature κ_wb < 0), which mimics matrix PDL or tip extension.
  56 computes the expected κ_wb from C_sys(p) over [G_min, G_c] and adds it to κ_exp (§4.11).
- **One engine:** `PRiSM_compute_bourdet(x, y, L)` returns dy/d ln x. G·dP/dG = call with (G, ISIP − p); dP/dG = that ÷ G;
  √t·dP/d√t = 2 × call with (Δt, ISIP − p); dP/d√t = that ÷ √Δt; log-log D = call with (Δt, ISIP − p); primary pressure derivative
  dp/dΔt = D/Δt. The derivative does not depend on the ISIP value. L default 0.1 (0.05–0.2 for G·dP/dG in the stability grid;
  0.2–0.4 after closure). Derivatives only where a full window exists; masked samples are compacted out first (§3.0).
- **Time variable.** The pre-closure log-log (Δp, D and D_ref) is **always on Δt**: G already is the fracture superposition function
  and the exact reference D_ref = m_G·ΔtD·G′ is defined on Δt, so switching D to injection superposition time would make D/D_ref,
  the log-log pick and the classifier feature inconsistent. Superposition or impulse time is used only after closure (§4.12).
- **G_min** = the latest of: hammer end (3τ), predicted bleed-off end (§4.2), gauge thermal transient end, 1 % of the falloff;
  user-settable. ln G diverges as G → 0 and the earliest points carry friction dissipation.
- **G plot** (`dfitG`): p, dP/dG and G·dP/dG vs G, with the fitted early line and intercept, the tangent through the origin, the
  compliance early line, PDL-hump shading, pick markers per family and the consensus band. The derivative y-range is set from the
  data after G_min (§2.7), so the contact deflection is never flattened by the early drop.
- **√t plot** (`dfitSqrt`): p, dP/d√t and √t·dP/d√t vs √Δt (min^½ on display). Its inflection equals max |dP/dG| when ΔtD ≫ 1, so
  it is **not** independent of the tangent pick (§4.7).
- **Log-log** (`dfitLogLog`): ISIP − p and D vs Δt, with the **exact Nolte reference** instead of slope guides:
  Δp_ref = m_G·G(ΔtD), D_ref = m_G·ΔtD·G′(ΔtD) with m_G from the early window. The local slope d ln G/d ln ΔtD is 0.978 / 0.927 /
  0.785 / 0.617 / 0.539 at ΔtD = 0.01 / 0.1 / 1 / 10 / 100 (α = ½) — still ≈ 0.55 at a typical closure. D above the reference and
  rising = stiffening (contact, height recession); below early = PDL or tip extension; turning over = after closure. **A unit slope
  persisting past ΔtD ≈ 1 is not a storage signature**: with dp/dG = −X/C_sys and constant C_sys, storage rescales m_G but cannot
  change the shape (the slope is 0.785 at ΔtD = 1 for any V_w·c_w). It is evidence of a near-constant-rate sink (a leaking valve,
  casing or packer, flow into another zone) and raises "constant-rate sink (leak?)", cross-linked to the leak plot (§6.4) and the
  annulus check. PPD toggle: dp/dΔt.
- **Compliance-versus-pressure** (`dfitCompliance`): C_sys(p) = X/|dP/dG(p)| with X = η_G·V_i\*/G_c of the chosen candidate (F1 in
  range mode, labelled), and C_rel(p) = |dP/dG|_open/|dP/dG(p)|, against pressure, x decreasing. Closure is a compliance drop at a
  pressure; the onset is contact, the floor is residual aperture plus storage. Stiffness ratio (dP/dG)_closed/(dP/dG)_open; residual
  compliance A_f·c_f,res = X/|dP/dG|_closed − V_w·c_w.
- **h-function plot** (`dfitH`, [M], gate G6): pressure and its h-derivative against the h-function of the cited before-closure
  method (a time function for leak-off that departs from constant-pressure Carter behaviour). Implemented against `PRiSM_dfit_hFn`,
  whose definition and check values are taken from the cited source at gate G6 (§9, WP2); until then the plot is hidden.
- **Pressure vs dP/dt** (`dfitPdpdt`): p against |dp/dt| for rapid closures (open-hole and wireline micro-frac cycles, falloffs to
  closure shorter than ≈ 10 min); closure reads at the slope break. A non-voting reading shown in the F0 row of the strip.

### 4.7 Closure methods (56) [H for the algorithms; the physics is disputed and shown as such]

All methods run on the same resampled data and derivatives; each returns a `ClosurePick`.

| Method (`method`) | Family | Algorithm | Main failure modes |
|---|---|---|---|
| Tangent (`tangent`) | F2 (votes) | The line y = s·G through the origin touches G·dP/dG where y/G is largest ⇔ **s\* = max dP/dG** (robust: smoothed, or the 95th percentile in a sliding window), over [G_start, G_peak], excluding G < G_min and the PDL hump. Pick = the touch point (the vertex of dP/dG, d(dP/dG)/dG = 0); a flat top longer than 0.5 ln units keeps the last G with y ≥ (1 − ε)·s\*·G before y falls permanently below; ε = max(0.02, 3σ_y/(s\*·G)) (amended at the integration review, Appendix D) | tangent drawn to a PDL hump (too early, too high); concave-up data (late, low if the compliance reading is right); wrong tp or t_s; low closure visibility (no clear departure) |
| √t inflection (`sqrt`) | F2 (`sameEvidenceAs:'tangent'` when ΔtD,c > 5) | max \|dP/d√t\| (or departure of √t·dP/d√t from a line through the origin) | multiple inflections (PDL, hammer, thermal); second-derivative noise; diverges from the tangent only when ΔtD,c is small |
| Max dP/dG (`maxdpdg`) | F2 (same evidence) | the G of the dP/dG maximum | as tangent |
| Compliance (`compliance`) | F1 (votes) | Fit y = a + b·G (through the origin when \|ι\| < 0.05) over the longest early window with unstructured residuals after G_min and after any hump; pick = first G after which y − (a + bG) > ε·(a + bG), ε = max(0.02, 3σ), held ≥ N points or ≥ 0.05 in log G. If the first departure is downward, the compliance and tangent picks coincide (families agree) | any other rising-dP/dG cause (height recession, gas break-out, gauge thermal drift); early line biased by PDL or tip extension; ε and noise sensitivity |
| Compliance drop (`crel`) | F1 (`sameEvidenceAs:'compliance'`) | first p where C_rel < 1 − ε for ≥ N points | as compliance |
| Log-log departure (`loglog`) | F1 (**`sameEvidenceAs:'compliance'` whenever \|ι\| < 0.05**) | first upward departure D/D_ref > 1 + ε_ll (0.05) held ≥ 0.1 log cycle, always on Δt. With D_ref = m_G·ΔtD·G′, D/D_ref = \|dP/dG\|/m_G: the same quantity as the compliance criterion y > (1 + ε)·b·G with b = m_G, so it is the compliance test with another ε and smoothing variable. It votes only when \|ι\| ≥ 0.05 (the early line does not pass through the origin, so the two tests differ). Also reported (not used): the end of the reference-curve region and max D (after closure) | L smoothing shifts it by ≈ L/2 in ln Δt; wrong tp shifts the reference |
| Variable-compliance fit (`varcomp`) | F3 (**cross-check, no vote**) | Fit dp/dG = −K·f_L(p)/C_sys(p), C_sys(p) = A_f·c_f(p) + V_w·c_w(p), aperture law above σ_c: w = w_σ + c_f0·(p − σ_c) (w_σ = the width at σ_c); below (x = σ_c − p) the `hyp` law w = c_f0·s_h²/(s_h + x) (default, always positive) or the decaying-residual exponential law c/c_f0 = f_res·e^(−x/s_r) + (1 − f_res)·e^(−x/s_c), s_r ≫ s_c (§5.2; w → 0⁺, never negative); after closure the Carter rate is damped by (p − p_r)/(σ_c − p_r). RK4 in G on the data grid; `PRiSM_lm` over ISIP, K, σ_c, s_c (or s_h), f_res (optional C_d, p_fo); V_w·c_w and p_r fixed; data to 1.5 × G of the F2 pick. Its band is its own LM CI (profile on demand), not the stability grid | model dependence (aperture-law form); non-uniqueness with PDL; σ_c–s_c correlation when data stop soon after closure (reported) |
| Model closure (`model`) | F3 (cross-check, no vote) | σ_c from the leak-off mini-model fit (§5.7) when one exists (mechanical closure, contact onset) | embeds the contact law |
| Fissure closure (`fissure`) | F0 (no vote) | end of the PDL hump (G·dP/dG returns within ε of the line through the origin) = p_fo; the p vs dP/dt break (§4.6) is shown in the same row | not main closure |
| Reopening (`reopening`) | F4 (votes, upper-side) | knee of a re-pressurisation ramp (`WTS_wellbore.ramp`, §4.15b) on a later cycle, pump-in before flowback or a planned post-closure ramp; corrected for near-wellbore loss at the ramp rate (Δp_nwb(q_ramp) from the step-down) when available | near-wellbore stress concentration and tortuosity read high; a ramp that starts above closure has no knee |
| User (`user`) | its own | a click, a drag or a typed value | logged with reason |

**Families and dependence.** F1 "first stiffening" marks the onset of compliance loss (contact or the start of height recession);
F2 "end of stiffening" marks the end of the concave-up section; they are two readings of the same physics, and the module shows both
with all downstream numbers. **Each voting family has one independent member** (F1 compliance, F2 tangent, F4 reopening); `crel`,
`loglog` (when |ι| < 0.05), `sqrt` and `maxdpdg` are dependent members drawn hollow and never counted; F3 (`varcomp`, `model`) and
F0 are cross-checks that never enter the inverse-variance mean or the mode decision. A √t pick never confirms a tangent pick and a
log-log departure never confirms a compliance pick ("3 methods agree" is the commonest false confidence). **Family bands therefore
come from the stability grid and the bootstrap (§4.8), never from member counts.** F4 is the only family read from injection-side
evidence: in single mode it enters the mean only after its near-wellbore correction; uncorrected, it is an upper-side bound that
can veto a single closure above it and is shown with a caveat. Test C11: on contact data the `loglog` and `compliance` picks
coincide within one Bourdet window L.

**Failure-mode matrix** (what each method does when the cause is present):

| Cause | Tangent | √t | Log-log | Compliance | Var. compliance | Reopening |
|---|---|---|---|---|---|---|
| PDL hump | early/high unless excluded | extra inflection | below the reference early | early line biased | needs the PDL term | unaffected |
| Height recession | late/low by design | late | rises | early/high by design | ambiguous | unaffected |
| Low closure visibility (large V_w·c_w) | weak departure | weak | weak | weak | needs V_w·c_w | knee faint (low stiffness ratio) |
| Wrong tp / t_s | bends small G | minor | reference off | early line biased | ISIP/K biased | unaffected |
| Gauge thermal drift | spurious | spurious | spurious | spurious trigger | misfit | minor |
| Surface gauge on vacuum | invalid | invalid | invalid | invalid | invalid | ramp starts below the column head: invalid |
| Closure not reached | none | none | none | none | σ_c unbounded below | none (no later cycle) |
| Tortuosity | – | – | – | – | – | reads high (corrected when a step-down exists) |

**Toy contact illustration** (model-dependent): contact onset built into the data at 7,000 psi (`hyp`-equivalent contact, s_c
100 psi). Compliance pick 6,998 psi, tangent pick 6,507 psi, √t 6,506 psi; pn 602 vs 1,093 psi; PKN xf ≈ 131 vs 72 ft with the
storage-consistent chain (134 vs 75 ft with the earlier no-storage chain); χ = 1.00 vs 1.44 (the χ ratio flags the tangent pick as
lying after the stiffening began).

### 4.8 Consensus, stability and the label (56; full detail in §6.2) [H for the arithmetic, M for the thresholds]

- **Stability grid** for the closed-form pick methods only (tangent, sqrt, maxdpdg, compliance, crel, loglog, fissure; reopening on
  its own bootstrap): L ∈ {0.05, 0.1, 0.2} × tp ∈ {pump, breakdown, veq} × t_s ± one sample × ε ∈ {2 %, 5 %} = 54 settings, plus 50
  block-bootstrap resamples of the de-trended residuals (block length max(5, round(2/(1 − ρ1))) ≤ 50, seeded) → P10/P50/P90 per
  method and per family (family = the samples of its one voting member). **`varcomp` and `model` are excluded** (their band is their
  own LM CI, with the profile on demand), so the grid budget covers closed-form picks only (C9 counts evaluations with `varcomp`
  present).
- **Tolerance scale** (one scale everywhere): **τ = max(τ_abs, f_σ·σ_c, f_n·p_n)**, defaults τ_abs 15 psi, f_σ 0.3 %, f_n 3 %
  (reference: max(15, 21, 18) = 21 psi). Metrics: w = the largest voting-family half-width (P90 − P10)/2; s = |P50(F1) − P50(F2)|
  (and the F4 median against both when present); g = the stability-grid spread of the family P50s (half of max − min).
  σ_f = max((P90 − P10)/2.563, 1 psi, 2σ_gauge) — never 0.
- **Mode.** **Single** when s ≤ 2.5τ and the family P10–P90 bands overlap, and no uncorrected F4 bound lies below the candidate:
  value = inverse-variance mean of the voting-family P50s. **Range** otherwise: reported as **[P10 of the lower family, P90 of the
  upper family]** with both medians marked (e.g. 6,495–7,004 psia, medians 6,507 and 6,998), the classifier's preferred reading and
  the consequences of each end (what-if table). **None** when dP/dG never departs: the board shows the closure-time forecast
  instead.
- **Label** (rule ids are evidence `K1…`): **high** needs single mode, s ≤ τ, w ≤ τ, g ≤ τ, R_vis > 0.7 (storage-consistent,
  §4.10), ≥ 0.3 G-decade of data past the pick, σ_y/(s\*·G) < 2 % at the pick and χ within 0.9–1.1. **Low** if any of w > 2.5τ,
  g > 2.5τ, R_vis < 0.3, the F1 departure within 3σ, or a vacuum or thermal flag overlapping the pick window. **Medium** otherwise. In
  range mode the label rates the families' own bands (w, g); "high" is not available. Not estimable when mode = none. 3.4a labels
  say "uncalibrated"; 3.4b shows the calibrated per-mode hit rate next to the label.
- **Bounds check** (`PRiSM_dfit_bounds`): p_i < σ_c < ISIP; η ∈ (0, 1); pn plausibility (warn > 0.5·(ISIP − p_i)); **frictional
  limit, two tiers** (σ_c ≥ p_p + (S_v − p_p)/[√(μ² + 1) + μ]², valid in normal and strike-slip regimes where S_hmin = S3):
  - **veto** below the conservative bound: μ = `rock.muFricVeto` (1.0, factor 5.83), p_p at the lower bracket edge (hydrostatic when
    unknown), S_v from `rock.sigmaVGradLo` (0.9 psi/ft unless logged) × TVD — the least restrictive plausible bound;
  - **warning** between that bound and the nominal one: μ = `rock.muFricWarn` (0.6, factor 3.119), p_p from C1, S_v from
    `rock.sigmaVGrad` (1.0 psi/ft).
  Both lines are drawn on the strip and μ is editable. A vetoed pick is shown struck through and excluded from the consensus unless
  the user overrides it with a reason; a warned pick stays in with the warning listed.

### 4.9 Efficiency, net pressure and the consistency ratio (56) [H]

```
η_G = (g_c − g0)/g_c = G_c / (G_c + 4·g0/π)       the G-function efficiency (relative to V_i*)
α = ½ : η_G = G_c/(G_c + 2);   α = 1 : η_G = G_c/(G_c + 16/(3π)) = G_c/(G_c + 1.698);   general: 4g0/π = 1.7531 (8/9), 1.8016 (4/5), 1.8823 (2/3)
with spurt: η_G = (g_c − g0)/(g_c + S_p/(CL·√tp))  → the no-spurt value is an UPPER bound
η_f = V_f/(V_f + V_L(t_s)) = A_f·c_f·p_n / (A_f·c_f·p_n + (1 − η_G)·V_i*)        fracture efficiency at shut-in (wellbore excluded)
p_n = ISIP − σ_c        χ = p_n/(m_G·G_c)        gradients ISIP/TVD, σ_c/TVD (psi/ft), p_n/σ_c
```

- The **same α** for G and η (reported pair); closure at 305.1 min, tp 5 min → G_c 18.00, η_G 0.900 (α = ½) or G_c 18.276, η_G 0.915
  (α = 1); η_f 0.898 (reference, V_w·c_w 4.44e-3 ft³/psi). With a mini-model fit, the model's own α gives the "model-consistent η"
  (G_c/(G_c+2) underestimates η by up to 0.025 at intermediate efficiency). "η" without a subscript in the UI and the uncertainty
  table means η_G; η_f is shown beside it whenever R_vis < 0.95.
- η_G depends on G_c, tp and t_s only, **not on ISIP**; η_f depends on p_n through A_f·c_f·p_n.
- χ > 1.1: compliance changed before the pick (typical of an F2 pick on concave-up data); χ < 0.9: early slope steepened (PDL,
  tip extension) or ISIP too low. χ goes into the evidence list, never alone into a label.

### 4.10 Compliance, CL, geometry, spurt, PDL, leak-off rate, forecast (56) [H; M for geometry inputs]

Geometry is sized from **A_f·c_f = C_sys − V_w·c_w** (§4.6), never from C_sys or η·V_i:

| Geometry | A_f (one face) | c_f | w_max/w̄ | Size from A_f·c_f |
|---|---|---|---|---|
| PKN | 2·xf·h_f | π·h_f/(2E′) | 4/π | xf = A_f·c_f·E′/(π·h_f²) |
| KGD | 2·xf·h_f | π·xf/E′ | 4/π | xf = √(A_f·c_f·E′/(2π·h_f)) |
| Radial | π·R² | 16·R/(3π·E′) | 3/2 | R = (3·E′·A_f·c_f/16)^(1/3) |

Then V_f = A_f·c_f·p_n, w̄ = V_f/A_f, η_f per §4.9.

- **CL** (one form, no separate storage correction): CL = 2·m_G·C_sys/(π·r_p·A_f·√tp) = 2·X/(π·r_p·A_f·√tp) (→ 2·c_f·m_G0/(π·r_p·√tp)
  without storage; tp in min gives ft/√min). r_p = min(1, h_p/h_f) for PKN/KGD; radial with h_p < 2R: r_p = (2/π)·[u√(1 − u²) +
  asin u], u = h_p/(2R).
- **Γ** (`lkGroups.Gamma`, one definition) = **r_p·CL·A_f/C_sys = 2·m_G/(π·√tp)** — the group the falloff determines (9.49 psi/√min
  in the reference; it reduces to r_p·CL/c_f without storage). Its PKN product is named separately: **Γ_PKN = r_p·CL·E′/h_f =
  (π/2)·Γ/R_vis** (`GammaPKN`; 14.9 without storage, 15.2 in the reference with R_vis 0.979). CL is printed "conditional on E′ = …
  and h_f = …".
- **Automatic geometry selection** (override allowed): radial if 2R ≤ barrier spacing; else PKN with h_f = barrier spacing if
  xf ≥ 1.5·h_f; else KGD (or PKN and KGD as bounds). Messages such as "radial 2R = 116 ft exceeds the 50 ft barrier spacing".
- **Spurt:** not determinable from the falloff alone. With independent geometry (A_f and c_f known): C_sys = A_f·c_f + V_w·c_w,
  CL from m_G, S_p = [V_i\* − C_sys·p_n − 2·r_p·A_f·g0·CL·√tp]/(2·r_p·A_f) (× 748.05 → gal/100 ft²); negative → "geometry inconsistent"
  (never clipped). Default 0 with the η upper-bound note.
- **PDL:** matrix power law CL(p) = CL_s·[(p − p_r)/(ISIP − p_r)]^n (n = 1 compressibility, ½ filtrate); fissure law
  CL = CL0·e^(C_d·(p − p_fo)) above p_fo, C_d by regressing ln[(dP/dG)/(dP/dG)_base] on (p − p_fo) over the hump (synthetic C_d 0.004
  recovered as 0.00404); multiplier at ISIP e^(C_d·(ISIP − p_fo)) (4.06 in the example) for frac design; σ_H − σ_h =
  (1 − 2ν)·(p_fo − σ_h) (low confidence, caveats printed). The expected curvature used by the classifier is §4.11's κ_exp.
- **CL ↔ k convention** (one convention for §4.10, §4.12 k_lo, §5.2 and §5.5): **Δp_CL = p_mid − p_r, p_mid = ½·(ISIP + σ_c)**
  (σ_c → p_end when closure is not reached); k [md] = 1000·(CL/(0.0374·Δp_CL))²·μ/(φ·c_t). Reference: Δp_CL 2,800 psi, PKN CL
  1.903e-4 → **2.75e-3 md**.
- **Before-closure permeability estimates** (`PRiSM_dfit_kBeforeClosure`, non-voting, shown beside the after-closure k): "k from CL"
  (the G-function method above) and the **h-function estimate** (gate G6, §4.6). Both are physics-based reservoir-controlled
  leak-off relations — **not** the empirical closure-time correlation, which is not shipped. The practice the landscape cites divides
  the G-function estimate by 2 and the h-function estimate by 1.5 (both read high against after-closure k); the card shows the raw
  value, the corrected value and the factor with its direction ("÷ 2, reads high"). Agreement with the after-closure k within × 3
  supports the geometry; a large mismatch points at r_p, h_f, E′ or fissure leak-off.
- **Leak-off rate from the data:** q_L(Δt) = C_sys·m_G·dG/dt = X·(4/(π·tp))·dg/dΔtD; V_L − V_L(t_s) = X·G; V_f(Δt) = A_f·c_f·(p − σ_c)
  = V_f·(1 − G/G_c); with PDL q_L = C_sys·|dP/dG|·dG/dt. Reference: 0.500 → 0.0405 bbl/min from shut-in to closure; **22.5 bbl
  leaked after shut-in** (25 bbl in total).
- **Closure-time forecast:** G_c,f = (ISIP − σ_prior)/m_G, Δt_c = tp·G⁻¹(G_c,f); ±0.02 psi/ft (±200 psi) brackets closure between
  2.46 and 8.63 h in the reference.
- **Height estimates** shown side by side: user / stress profile; radial-consistency; recession ratio h_f,0/h_f,end = √R_s (PKN-like)
  or R_s (KGD-like), R_s = (dP/dG)_late/(dP/dG)_early over the concave-up section; injection net-pressure slope (Nolte–Smith,
  indicative: ¼–⅕ contained PKN, negative KGD/radial or height growth, ≈ 0 barrier or fissures, unit restriction).
- **Far-field extension pressure** (`PRiSM_dfit_farField`, [L], informational, non-voting): the pressure at the end of the early
  near-wellbore segment of the injection-falloff log-log derivative, as the pressure-transient school reads it; shown in the F0 row
  of the strip with its window; its definition is checked against the cited practice notes at gate G6 and it is dropped if that check
  fails.
- **Thermal sensitivity:** dp/dT ≈ V_w·β(T)/C_sys, with β(T) = ∂ln B_w/∂T from `Bw_meehan` at the column mean temperature and
  pressure and the same c_sys as for storage: ≈ 1.4 psi/°F before closure in the reference; after closure (C_sys → V_w·c_sys)
  ≈ β/c_sys ≈ **65 psi/°F at a 100 °F column mean and 80–105 psi/°F at 150–250 °F**. The value is printed on the triage card and
  used by the leak budget (§6.4).
- **Closure visibility** R_vis = A_f·c_f/C_sys with A_f·c_f = C_sys − V_w·c_w from the data: **0.979** in the water-filled
  reference, **0.54** with a gas-filled wellbore (C_sys 0.388 ft³/psi for the same A_f·c_f 0.2105); < 0.3 low, 0.3–0.7 medium. When
  no ramp gives V_w·c_w, the theory value is used and the label says so.
- Failure modes: h_f unknown (PKN xf ∝ 1/h_f²: 20 % in h_f is 44 % in xf); dynamic E′ without correction; r_p = 1 in thin pay;
  spurt ignored (xf overestimated); V_w·c_w wrong (A_f·c_f absorbs the error; triage compares ramp, theory and hammer); complex
  fractures (transverse-storage flag).

### 4.11 Leak-off-type classification (56) [M]

Features over W = [G_min, G_c,tangent]:

| Feature | Definition | Normal | Matrix | PDL | Tip ext. | HR / contact | Storage |
|---|---|---|---|---|---|---|---|
| ι | a/(b·G_c) of G·dP/dG = a + bG over the lower 60 % of W | \|ι\| < 0.05 | ≈ 0 | > 0 early | > 0.1 | < 0 | ≈ 0 |
| κ | robust relative change of dP/dG from G_min to G_c | ≈ 0 | ≈ κ_exp (± 0.05) | < 0 then 0 | < −0.1 below κ_exp throughout | > +0.1 | ≈ κ_wb |
| H | max of (G·dP/dG − s·G)/(s·G) before the return, s from after the hump | < 0.05 | < 0.05 | > 0.05, spans ≥ 0.3 G and returns | no return | – | – |
| D/D_ref | log-log ratio to the Nolte reference | ≈ 1 | slightly < 1 | < 1 early | < 1 | > 1 rising | ≈ 1 (shape unchanged) |
| R_vis | §4.10 (storage-consistent) | – | – | – | – | – | < 0.3 (or < 0.5 with the V_w·c_w ratio > 2) |
| V_w·c_w ratio | measured (ramp, hammer) / theory (`csys`) | – | – | – | – | – | > 2 supports |

- **κ_exp** is computed, not assumed: one coarse w_c = 1 mini-model run (≈ 1 ms; `lkSimulate` with `grid:'coarse'`) on the case's
  ISIP, σ_c candidate, p_r and tp, read over the same [G_min, G_c] window on the same G (data-driven or model-derived) as the data.
  This keeps the Duhamel memory of reservoir-controlled leak-off that the quasi-static [(σ_c − p_r)/(ISIP − p_r)]^n − 1 ignores
  (the w_c = 1 run falls 28 % between G 1 and 15, the quasi-static estimate 19 %). The wellbore term κ_wb (pressure-dependent
  compressibility, §4.6) is added; with a water-filled well it is ≈ 0. Without 58 the quasi-static form is used and flagged.
- **Storage class and rule R5** are driven by the storage-consistent R_vis and by the measured-vs-theory V_w·c_w ratio, never by the
  log-log shape. A persistent unit slope past ΔtD ≈ 1 sets `unitSlopeSink` and the "constant-rate sink (leak?)" warning (§4.6), not
  a class.
- **Order of tests:** (1) the friction bleed-off and hammer explanations of an early hump (§4.2) and a gauge thermal transient;
  (2) storage (R_vis, V_w·c_w ratio); (3) the other classes.
- **Score** per class = mean over its conditions of a logistic margin σ((value − threshold)/(0.2·|threshold| + δ)); top class
  reported; any class within 0.15 is reported too (for height recession vs asperity contact this is the rule: one class
  `hr-contact` with both readings). Below 0.5 for every class → `undetermined`.
- **Evidence sentences** filled only with computed numbers, e.g. "dP/dG falls 27 % to closure; 28 % is expected from
  reservoir-controlled leak-off at p_r = 4,500 psia; no hump; classified normal (matrix-controlled)."
- Alternative causes listed for tip extension (wrong t_s or tp, matrix PDL with large pn/(ISIP − p_r), slow valve, thermal, gas in
  the wellbore).

### 4.12 After-closure analysis (57) [H]

**Impulse kernels** (V bbl, t h, field units; a whole family Δp = 5.6146·V/(φc_t)·G_d(t)):

| Regime | Impulse Δp | Group | Specialised plot |
|---|---|---|---|
| Bilinear | 264.8·V·μ/[h·√(k_f w)·(φμc_t k)^¼]·t^−¾ | √(k_f w)·(φμc_t k)^¼ | p vs t^−¾ |
| Linear | 97.54·(V/A)·√(μ/(kφc_t))·t^−½ | A√k | p vs t^−½ |
| Radial | 1,694.5·V·μ/(kh)·t^−1 | kh/μ | p vs t^−1 |
| Spherical | 29,437·V·μ^1.5·√(φc_t)/(k_s t)^1.5 | k_s = (k_h² k_v)^(1/3) | p vs t^−³⁄₂ |

Every intercept is p_i. η_d = 0.0002637·k/(φμc_t) ft²/h. μ and c_t are **reservoir-fluid** values; V = injected minus flowback.

- **Time origin.** Carter leak-off is spread over 0 < τ < t_c with mean release time τ̄ = t_c/3. The exact Carter linear function
  F_L and the Carter-exact radial function F_Rc both expand to ∝ (t − t_c/3)^−½ and 1/(t − t_c/3); the log-form F_R does not
  (¼·ln(1 + χ·t_c/(t − t_c)) ≈ (χ/4)·t_c/(t − 0.19·t_c), an effective origin of 0.235·t_c at 5·t_c). Default t0 = τ̄ (t_c/3 or the
  mini-model centroid), shown in the axis label and paired with F_Rc; F_R is kept only for continuity with common practice and
  labelled as such. Options total time, mid-injection t_e/2 (no-fracture injections), time since closure. On a time-since-closure
  axis pure radial reads −0.52 at 1.5 t_c and −0.65 at 2 t_c (looks linear); the centroid origin is within 3 % from 3 t_c.
- **Nolte / Talley functions** (t and t_c from the start of injection): F_L = (2/π)·asin√(t_c/t) (exact Carter convolution;
  F_L(2t_c) = 0.5), F_R = ¼·ln(1 + χ·t_c/(t − t_c)), χ = 16/π²; Carter-exact radial F_Rc = (χ/4)·u·artanh u, u = √(t_c/t)
  (F_R/F_Rc = 0.9538 at 2 t_c). Cartesian lines p = p_r + m_L·F_L and p = p_r + m_R·F_R; **kh/μ = 4,181·V/(m_R·t_c[h])**
  (250,856·V/(m_R·t_c[min])); linear: m_L = 845.5·CL_p·√(μ/(kφc_t)) (CL_p ft/√min on the permeable area) ⇒
  k = μ/(φc_t)·(CL_p/(1.1827e-3·m_L))².
- **Properties used:** late radial kh/μ does not depend on the closure pick; linear-flow k scales with CL²·t_c and does (k is re-run
  over the closure band, per family in range mode); V = 8·CL_p·h_p·L·√t_c links Nolte-linear and impulse-linear (ratio
  A_ACA/A_Carter is a QC number); λ = m_L/(p̄_frac − p_r) ≈ 1 means reservoir-controlled leak-off.
- **p_i-free diagnosis:** D(t) = |dp/d ln(t − t0)| (L_B 0.2–0.4; noise σ_D ≈ σ/(√2·L_B); an accepted regime needs D ≥ 10σ_D, i.e.
  Δp ≳ 35–50 σ_gauge; tides removed first through `PRiSM_tideAnalysis` / `PRiSM_applyTideCorrection`). Local slope
  s_D = d ln D/d ln(t − t0); flow-dimension trajectory n(t) = −2·s_D. **Every threshold below is for s_D**, the statistic tested
  (the Δp slope behaves differently; the earlier −0.90 at t_DL 0.76 and −0.95 at 1.6 were Δp slopes).

  | Uniform-flux fracture (full height), t_DL = η_d·t/L² | s_D | (p − p_i)/D (truth) | point p − (2/n)·D lies below p_i by | Δp slope (for reference) |
  |---|---|---|---|---|
  | ≤ 0.03 (linear) | −0.50 | 2.00 | 0 | −0.50 |
  | 0.051 (leaves the linear band ±0.07) | −0.43 | 1.97 | — | −0.51 |
  | **0.058–0.183 (transition hump, s_D > −0.40; max −0.30 at 0.10)** | −0.39 → −0.30 → −0.41 | 1.93 → 1.44 | up to +1.6·D (wrong) | −0.52 → −0.69 |
  | 0.20 | −0.43 | 1.42 | +0.92·D (wrong) | −0.70 |
  | 0.31 | −0.57 | 1.28 | +0.51·D | −0.78 |
  | 0.77 | −0.80 | 1.11 | +0.14·D | −0.90 |
  | **1.6 (radial recognisable, s_D ≤ −0.90)** | −0.90 | 1.05 | +0.06·D | −0.95 |
  | **2.32 (enters the radial band ±0.07)** | −0.93 | 1.04 | — | −0.96 |
  | 3.27 | −0.95 | 1.03 | — | −0.97 |
  | 8.3 | −0.98 | 1.01 | — | −0.99 |

  Penny-shaped fracture in a thick zone (τ = η_d·t/R²): s_D has its own hump (−0.19 at τ ≈ 0.1), passes −0.90 at τ 0.32, −1.0 at
  0.39, −1.1 at 0.49 and −1.4 at 2.1 on its way to −3/2 (the Δp slope passes −1 already at 0.20: **false radial**). Bands: linear
  −0.5 ± 0.07, bilinear −0.75 ± 0.07, radial −1.0 ± 0.07, spherical −1.5 ± 0.1, artefact/boundary < −1.6. These s_D trajectories are
  acceptance vectors (A3b) generated from the same kernels.
- **Storage after closure** is called only when s_D > −0.40 occurs **before** any −0.5 segment, or persists for more than one log
  cycle; the linear-to-radial hump (s_D > −0.40 for t_DL ≈ 0.06–0.18, at most ≈ 0.5 cycle) is **not** storage and lines are not
  withheld because of it.
- **Bracket at every time:** p − 2D ≤ p_i ≤ p − D, valid while the s_D sequence lies **between linear and radial**, including the
  transition hump (the truth (p − p_i)/D stays in [1.0, 2.0] throughout: 2.00 → 1.42 at t_DL 0.2 → 1.05 at 1.6). The gate is "the
  sequence so far is linear → (hump) → radial-ward, with no s_D below −1.1 and no storage call", not s_D ∈ [−1, −0.5]. Failure cases:
  penny/spherical (true p_i above p − D: s_D still steepening past −1.1), after-closure storage (below p − 2D), boundaries (D
  collapses).
- **Point estimate** p_i = p − (2/n)·D only where s_D is locally constant: |Δs_D| < 0.1 over 0.5 log cycle (as for the sliding
  fits), i.e. in pure linear flow (t_DL ≲ 0.01) or from t_DL ≈ 1.1 on; elsewhere (`piPoint` null) only the bracket is reported (at
  t_DL 0.2 the point formula would give p − 2.34·D against the true p − 1.42·D, outside the bracket).
- **Three brackets intersected:** Cartesian (F_L line ≤ p_i ≤ F_Rc line on the latest data), impulse lines (1/√t ≤ p_i ≤ 1/t),
  derivative; report the intersection and which method set each edge.
- **Sliding power-law fits** p = p_i + c·(t − t0)^(−n/2) are accepted only if s_D changes by < 0.1 across the window and the window
  starts after 3 t_c; otherwise only the bracket is reported (example B, 50–300 h gives n = 0.68, p_i = 4,321 vs 4,500).
- **p_i consensus:** candidates Nolte line (regime-appropriate), impulse line, derivative trajectory (flat over ≥ 0.3 log cycle),
  model match; weighted median inside the intersected bracket. High: width ≤ max(10 psi, 0.5 % p_i), regime stable ≥ 0.5 log cycle,
  ε < 0.05, match CI inside; medium: width ≤ 50 psi, or linear-only with F_L and impulse agreeing within 10 psi; low otherwise with
  the reason ("after-closure storage", "penny/spherical suspected", "surface gauge: column temperature not modelled"). p_i reported
  at the gauge and at the datum (reservoir-fluid gradient).
- **Transmissibility:** kh/μ primary (independent of φ and c_t); k = (kh/μ)·μ/h with h = net height by default (fracture height
  offered). A radial line (Δp-based) starting at t_DL 1.6 overestimates kh/μ by ≈ 5 %, from 5 by ≈ 2 % — never underestimates; the
  p_i-free D-based kh/μ = 1,694.5·V/(D·(t − t0)) over-reads by ≈ |1 + s_D| (10 % at t_DL 1.6, 5 % at 3.2, 2 % at 8.2).
- **Bounds when radial is not reached** (k ∈ [k_lo, k_hi], binding constraint named, evaluated at the conservative ends of the input
  ranges):
  - k_hi (trend): kh/μ ≤ 1,694.5·V/(Δp_end·(t_end − t0)) (needs p_i) and ≤ 1,694.5·V/(D_end·(t_end − t0)) (p_i-free); direction
    reverses for a spherical-type trend (n > 2).
  - k_hi (radial not reached, s_D > −0.90 at t_end ⇒ t_DL < 1.6): **k < 1.6·φμc_t·L_max²/(0.0002637·(t_end − t0))**.
  - k_lo (linear with the largest plausible area): k = (97.54·V/(A_max·m_L′))²·μ/(φc_t).
  - k_lo (leak-off cannot exceed its reservoir-controlled limit): k ≥ μ/(φc_t)·(CL_p,lo/(1.1827e-3·Δp_hi))² with
    **Δp_hi = p_mid,hi − p_i,lo** (the largest plausible driving pressure in the §4.10 convention, p_mid,hi = ½·(ISIP_P90 + σ_c,hi);
    see Appendix B, correction 2).
  - Example B: [0.0039, 0.0131] md contains the true 0.0100 md (binding: A ≤ A_max at 80 ft; trend at 300 h); WP3 re-runs it with
    the 1.6 constant (the radial-not-reached bound only widens).
- **Before-closure k** (when the falloff ends before closure or as a cross-check): §4.10's estimates (labelled with λ and their
  bias factors) and the mini-model fit with k as a parameter (§5.7). **No empirical closure-time correlation is shipped.**
- **Model-library match** (§6.8): impulse → constant-rate transform t·Δp_imp = 24·V·Δp′_u (t h, V bbl, unit rate 1 STB/d;
  radial gives 24 × 70.6 = 1,694 V·μ/(kh)).
- **Afterflow fraction** ε(t) = C_ac·(p − p_i)/V (C_ac = C_wb + C_res); straight lines valid for ε ≤ 0.05 (radial: ε = 1/(2τ), the
  slug-test criterion). ε is shown with C_wb only (lower limit) and with C_res from the 3.4b storage model.
- **Tidal c_t cross-check** (3.4b, [M]; in 3.4a only if cheap): when the tidal fit of `18-tide-analysis.js` is significant (amplitude
  > 5σ, phase stable over the window), its Bredehoeft c_t is shown against the c_t input and offered as an alternative c_t
  distribution in the uncertainty inputs; an attenuated response gives only "consistent with kh/μ below X". Tidal phase-lag kh/μ is
  not planned.
- **3.4b** (`57-prism-dfit-acamodel.js`): variable-storage convolution model (q_inj − q_L = C(p_w)·dp_w/dt; p_face = p_i +
  Σ(q_j − q_j−1)·g(t − t_j−1); C(p) = C_wb + C_res + (C_f − C_res)·S((p − p_c)/w); Newton per step, O(N²), N ≤ 1,500) fitting p_i,
  k, L, C_res, p_c; generalised F_n from the actual leak-off history.

### 4.13 Gas (57) [H]

- Adjusted variables p_a = p_i + (μz/p)_i·∫_{p_i}^{p} p′/(μz) dp′ (anchored so that p_a(p_i) = p_i and intercepts read in psia)
  and t_a = (μc_t)_i·∫ dt′/(μc_t)(p(t′)), c_t(p) = S_g·c_g + S_w·c_w + c_f;
  every liquid formula then applies with μ_i and c_ti at p_i; V stays the injected water volume. F_L and F_R are evaluated in t_a with
  t_c,a = t_a(t_c).
- Reuse `PRiSM_mpTable` and `PRiSM_gasPseudoTime` (normalised at p_i); `WTS_gaspvt_z` when impurities matter.
- Forced when (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia. Iterate: liquid p_i⁰ → p_a, t_a → re-analyse → p_i; stop at |Δp_i| < 0.1 psi
  (2–3 passes); the iteration count is shown. **k_lo uses the lower bracket edge of p_i**: k ∝ μ/(φ·c_t) in linear flow and ∝ μ in
  radial flow, and for gas μ rises and c_g ≈ 1/p falls with p, so a higher p_i gives a larger k (the same direction as Appendix B,
  correction 2).
- Magnitudes: at p_i 5,000 psia pseudo-pressure changes Δp by < 3 % but pseudo-time stretches the early clock ≈ 1.5×; at 2,000 psia
  both are large (+34 % in Δp). Labels: "effective gas permeability; water invasion and imbibition not modelled".

### 4.14 Step-down (`WTS_wellbore.stepDown`) [H]

- Model p_i = p_frac + a·q_i² + b·q_i^β + d·(t_i − t_last) (β = 0.5 fixed; β free only when its CI is narrower than ±0.15; drift
  optional); linear least squares with β fixed, `PRiSM_lm` otherwise; step pressure = median over the settled window
  (≥ 3 τ_hammer after the rate change), weight = n/σ²_window.
- Identifiability (σ = 2 psi): 4 steps 5 → 1.25 bbl/min: se(p_frac) 10.6 psi, se(a) 0.41 (27 %), se(b) 8.8 (6 %); 5 steps 5 → 1:
  7.9 / 0.34 / 6.8 (recommended minimum); a 25 % rate range is useless (se(p_frac) 219 psi) → **refused**. β-free with 5 steps:
  P10/P50/P90 0.20/0.51/0.95.
- **Surface gauge:** q^1.8 (pipe) and q² (perforation) correlate at r = 0.99939 over 1–5 bbl/min, so the pipe term must come from
  §4.2; n_p is labelled "not determinable" when the pipe term at the top rate exceeds 3 × Δp_perf (tubing slickwater: ±10 % friction
  error → 8.5 to 58 open perforations). p_frac and b stay robust.
- **Open perforations:** n_p = √(0.2369·ρ/(a·d⁴·C_d²)); Monte Carlo (C_d ~ N(0.62, 0.04) clipped 0.5–0.95; d ~ N(d, 8 %); a ~ N(a,
  se)) → P10/P50/P90 (reference 8.9 / 11.7 / 16.0; deterministic 11.9 of 12) and the dominant driver (d⁴ unless the entrance-hole
  size is known).
- **Labels** (configurable defaults, shown as such): Δp_perf + Δp_nwb < 100 psi "good connection"; Δp_nwb > 200 psi and
  > 2·Δp_perf "tortuosity dominated"; Δp_perf > 2·Δp_nwb and n_p,P90 < 50 % of shot holes "perforation limited"; both > 200
  "mixed"; a or b < 0 or residual > 3σ "fit invalid".
- Reference fit: p_frac 7,595.5, a 1.528, b 140.9, 11.9 open; at 5 bbl/min perforation 38 psi + tortuosity 315 psi →
  tortuosity dominated. The drift term should match the early falloff slope (a mismatch flags rate lag).
- **As an ISIP family member** (§4.4) p_frac is the fracture-entrance pressure: the in-fracture viscous redistribution
  (Λ − 1)·p̄_visc that disappears at shut-in (≈ 35 psi in the PKN reference at 1 cp) is subtracted from the lumped law or the leak-off
  fit when available; otherwise the family is labelled "fracture-entrance pressure, upper estimate" and the term enters its error
  budget. The q^¼ viscous term also aliases into b·q^½ in the fit (stated next to b).
- 3.4b (`48-calc-wellbore-field.js`): step-up/step-down hysteresis (b_up vs b_down) and a mini-hammer fit at every step (≥ 10 Hz).

### 4.15 Step-rate test (`WTS_wellbore.stepRate` 3.4a; `stepRateSP`, `hall`, `injector` 3.4b) [H]

- **3.4a — continuous hinge** on end-of-step pressures: p = α + b₁·min(q, q\*) + b₂·max(0, q − q\*); q\* scanned continuously between
  the 2nd and the 2nd-to-last rate, linear LSQ at each q\*, minimum SSE; constraints b₂ < b₁, ≥ 2 points per side, F-test vs a single
  line (p < 0.05) else "no break". FEP = α + b₁·q\*; band from a 500-resample residual bootstrap (seeded). Example: q\* 1,805 bbl/d
  (1.2535 bbl/min), FEP 6,199.3 psia (P10–P90 6,186–6,217; true 6,204), b₁ 1.249, b₂ 0.037 psi/(bbl/d).
- **3.4a — per-step stabilisation check:** the end-of-step pressure is the median of the last 30 % of the step; the step is
  "stabilised" when |dp/dt| over that part, projected over one more step duration, is below max(5 psi, 10 % of the pressure rise
  into the step) (both editable); otherwise the step is flagged "step not stabilised", drawn hollow, and the FEP band is recomputed
  without it (both answers shown). Step ② shows a step-rate card whenever `Events.steps` rise (§7.3).
- **3.4b — superposition-corrected** (every sample; `48-calc-wellbore-field.js`): X = Σ_j (q_j − q_j−1)/q_n·log10(t − t_j−1),
  Y = (p_w − p_i)/q_n; matrix samples fall on Y = m·X + m·C₀ (m = 162.6·Bμ/(kh)); fit on the first steps (excluding 5 min after each
  change), then parting = first time the residual r = (Y − Ŷ)·q_n < −4σ_p for 3 consecutive samples. Example: k 9.95 md (true 10),
  departure 3.000 h (true 2.967 h). p_i from C1 or fitted (flagged). b₁ is never reported as an injectivity (matrix injectivity falls
  12 % over nine steps with no fracture).
- **3.4b — Hall plot** H(W) = ∫(p_w − p_e)dt with derivative D_H = W·dH/dW (D_H < H: fracturing; > H: plugging); slope
  141.2·Bμ(ln(r_e/r_w) + s)/(kh) (1.683 → 0.634 psi·d/bbl with a 100 ft fracture); injector regime and MASIP.
- Failure modes: b₂ > b₁ (matrix convexity, plugging, rising surface friction → "no break"); parted from the first step; two breaks;
  unequal steps (handled by the superposition form, 3.4b); unstabilised steps (flagged, 3.4a); thermal drift in tests > 12 h.

### 4.15b Pump-in ramp analyser and the reopening family F4 (`WTS_wellbore.ramp`, 3.4a) [H for the fit, M for the interpretation]

- **What it reads.** Any re-pressurisation of a shut-in well: the pre-breakdown ramp (kind `pre-breakdown`), a later injection cycle
  after closure (`reopening`), a pump-in before a flowback (`pump-in`), a planned post-closure ramp from the designer, and the ramp of
  a drilling leak-off or formation-integrity test (`lot`). Windows come from `Events.cycles[].rampWin` or a user selection.
- **Model.** p against pumped volume V = ∫q dt from the window start (bottomhole, or converted surface pressure): a continuous hinge
  p = p₀ + s₁·min(V, V\*) + s₂·max(0, V − V\*), solved with the step-rate hinge routine (shared code), F-test against one line
  (p < 0.05) else "no knee". Below the knee s₁ = 1/(V_w·c_w) (wellbore compression, plus leak-off on permeable sections); above it
  s₂ ≈ 1/(V_w·c_w + A_f·c_f) once the fracture takes fluid. Knee pressure p_k = p₀ + s₁·V\*, band from a 500-resample residual
  bootstrap; the first 3σ departure from the s₁ line is reported as the onset (the conventional leak-off point for kind `lot`).
- **Outputs.** V_w·c_w from s₁ (the triage stiffness check and its comparison with `csys` and the hammer period, §6.3); the
  stiffness ratio s₁/s₂ ≈ 1/(1 − R_vis) (a faint knee below 1.2 is labelled "low visibility"); the knee as the **reopening
  pressure**, corrected for near-wellbore loss at the ramp rate, p_k − Δp_perf(q) − Δp_nwb(q), when a step-down exists; the onset
  as the **leak-off point** for `lot`.
- **Use in the consensus.** A `reopening` pick is family **F4**: injection-side evidence, physically independent of the falloff
  derivative, and an **upper-side** reading of σ_c (the near-wellbore stress concentration and tortuosity must be overcome). With the
  near-wellbore correction it votes in the mean and the mode decision; without it, it is an upper bound (a single closure above it
  becomes a range) and carries the caveat "reopening reads high by the near-wellbore loss". The board's "measurement that would
  settle it" (§6.2) points here, and the designer offers the ramp as an optional step (§6.5).
- **Cycle overlay** (`dfitCycles`): every cycle's p vs V on one plot with the wellbore line, the knee and its band, and the falloff
  closure families marked on the pressure axis.
- **Acceptance vectors** (generated in the test from the hinge model, not from a prototype): V_w·c_w 7.908e-4 bbl/psi, knee 7,050
  psia, A_f·c_f 0.0367 bbl/psi above the knee, σ 0.5 psi, q 0.5 bbl/min → knee within 10 psi with the truth inside the P10–P90 band,
  s₁ within 1 %; a one-slope ramp → "no knee"; a `lot` case → onset within 3σ of the true departure; a step-down b = 140.9 shifts the
  corrected knee by Δp_nwb(0.5) = 99.6 psi.

### 4.16 Pump-in / flowback and micro-pulses (`WTS_wellbore.flowback`, `.pulses`, 3.4b in `48-calc-wellbore-field.js`) [H]

- The pump-in before a flowback is a re-pressurisation ramp: in 3.4a `WTS_wellbore.ramp` already reads its knee as a family-F4
  reopening pick and its slope as V_w·c_w (§4.15b); 3.4b adds the flowback analysis below.
- Storage balance C(p)·dp/dt = −(q_fb + q_L(p)), C = V_w·c_w + C_f (open) or + C_res (closed); at the flowback start
  C(p\*) = q_fb/(|dp/dt|_fb − |dp/dt|_fo), q_L(p\*) = C(p\*)·|dp/dt|_fo (reference 0.2140 ft³/psi, 0.080 bbl/min; slopes −2.10 →
  −28.3 → −405 psi/min, 14× steeper at closure), V_f ≈ C_f·p_n → η = 0.893 with no G-function.
- **Closure corrected for near-wellbore loss:** σ_c = p_w,knee + Δp_perf(q_fb) + Δp_nwb(q_fb) (+ pipe); the flowback-start pressure
  step measures the correction directly (141.5 psi at 1 bbl/min in the reference). Rebound peak ≤ σ_c ≤ corrected knee.
- Rate selection: q_fb ≥ 5 q_L, time to closure 5–30 min, correction ≤ 25 % of (p\* − σ_prior); ≈ ⅙–¼ of the injection rate.
- Micro-pulses (10–30 s bleeds): response 4.4 psi while open vs 62.5 psi after closure (0.5 bbl/min, 20 s); removed volume put
  back by superposition through C2 rate periods so the G-function and ACA still work.

### 4.17 Water hammer (`WTS_wellbore.hammerQuick` 3.4a; MOC 3.4b) [H]

- Wave speed c = c₀/√(1 + ψ·K·D/(E_s·e)), c₀ = √(K/ρ) (K in lb/ft² = psi × 144, ρ in slug/ft³ = ppg × 7.48052/32.174 — 1.960
  slug/ft³ for 8.43 ppg; K = 1/c_fluid from `cw_dodson`): 4,539 ft/s in 5½-in 20 lb/ft casing. Equivalently c = 1/√(ρ·c_sys) with the
  **same system compressibility c_sys = c_fluid + ψ·D/(E_s·e) used for storage and the ramp** (3.57e-6 1/psi here, §4.3); with a known
  reflector the measured period gives V_w·c_w = L·A/(ρc²), the second, independent air-or-gas detector of triage (§6.3).
  Gas (Wood): 1 % free gas at 3,000 psia cuts c to 3,289 ft/s, 3 % to 2,376 ft/s — the main reflector uncertainty.
  A known reflector (packer, tubing tail, liner top) calibrates c.
- Period: quarter-wave 4L/c (open end: connected fracture), half-wave 2L/c (closed end); 8.81 / 4.41 s at 10,000 ft. Reflector
  depth L = c·T/4 or c·T/2 compared with the perforation MD.
- Transmission line Z_c = ρc/A (496.2 psi per ft³/s = 46.4 psi per bbl/min in 5½-in casing); termination Z_t = R + 1/(iωC_f);
  Γ = (Z_t − Z_c)/(Z_t + Z_c). **Γ < 0**: ringing at 4L/c, amplitude × |Γ| per round trip (Γ² per period). **Γ > 0**: no ringing but
  a staircase toward p_f with a step every 2L/c, step ratio Γ (the friction bleed-off at wave resolution). Wall friction dominates the
  decay of a clean well, so peak ratios overstate R; 3.4a labels Γ from the decay "indicative (includes wall friction)".
- Joukowsky: Δp_J = ρ·c·v (232 psi at 5 bbl/min in casing), scaled by min(1, (2L/c)/t_close) for the measured shut-in duration;
  a large mismatch flags the rate record or the valve.
- Sampling: ≥ 10 samples per 2L/c (≥ 2.3 Hz at 10,000 ft); 25–100 Hz for damping and close reflectors; otherwise "water hammer not
  resolvable" and nothing is fitted. Pump harmonics are notched before shut-in.
- 3.4b: MOC simulator (50–200 reaches, Courant 1, explicit Swamee–Jain friction per reach, nonlinear termination
  p_f + a·q|q| + b·sign(q)|q|^½ + C_f with leak-off; 20–40 ms per evaluation) fitted with `PRiSM_lm` over c, a, b, C_f and the
  shut-in offset (1–2 s); BH/surface first-swing Γ = ratio − 1; the period-switch diagnostic (2L/c → 4L/c perforation-limited,
  4L/c → 2L/c tortuosity-limited); C_f from the period shift tan(ωL/c) = −ωC_fZ_c when c is calibrated.

### 4.18 Triage checks (`49-calc-dfit-triage.js`, WPT; the feature is §6.3)

Implemented as `PRiSM_dfit_triage` (with `PRiSM_dfit_blunders`, `PRiSM_dfit_repump` and `PRiSM_dfit_grade`) in its own Round-9
helper, resolved at call time by the pipeline like `WTS_wellbore`; every threshold is a user-editable default stored in
`T.inputs.options.triage`. Without the helper the pipeline returns `triage:null` and the card says "triage unavailable".

### 4.19 Global failure modes and automatic responses

| # | Symptom | Likely cause | Automatic check | Response / label |
|---|---|---|---|---|
| 1 | After-closure slope ≈ −½ just after closure, turning to −1 | time-since-closure origin on radial data, closure proximity | slopes over the four origins | centroid origin; linear withheld |
| 2 | Slope −1 briefly, then steeper | penny / spherical | s_D still falling past −1.1 | penny kernel; k_s; no radial kh |
| 3 | Slope shallower than −0.4 after "closure" | closure picked too early; progressive closure; storage — or the normal linear-to-radial hump | s_D > −0.4 **before any −0.5 segment or for > 1 log cycle** (the hump at t_DL 0.06–0.18 lasts ≤ 0.5 cycle and is not storage); ε > 0.05 | re-check consensus; lines withheld only for storage |
| 4 | Late flattening, p_i too high | thermal afterflow, drift, column warm-back, wrong c_t | BH T trend; ∫q_th/V > 2 %; surface-gauge column model; tidal c_t cross-check (3.4b) | low confidence; thermal note; c_t note |
| 5 | Radial k from the last points in shale | radial not reached | t_DL(t_end); trend direction | bounds only; T_app "upper bound" |
| 6 | Linear k far from radial k | wrong A, CL, r_p; height change; several fractures | A_ACA/A_Carter/A_geom | ratios shown; radial preferred |
| 7 | Early hump | bleed-off, hammer, gauge thermal, PDL | §4.2 prediction; dT/dt; hump span | G_min moved, or PDL with evidence |
| 8 | Pre-closure derivative dives at early time | wrong t_s or tp | ι > 0 with κ < 0 and no hump | "check shut-in time" warning |
| 9 | Surface pressure 0 / vacuum | p_w below the column head | p_s < 15 psig | data masked; BH gauge required |
| 10 | Falloff flat or linear bleed right after shut-in | gauge isolated by the shut-in valve | closed-line signature | fail: "gauge on the pump side of the valve?" |
| 11 | Late decline linear in time, below p_i | leak, or gauge drift | s_D ≈ 0; leak plot with the drift term | leak rate + corrected p_i, or "leak or drift (not separable)" |
| 12 | Gas: F functions inconsistent | real time with large μc_t change | (μc_t)_i/(μc_t)(p_c) > 1.1 | adjusted variables |
| 13 | Nolte and impulse disagree near closure | t < 3 t_c, F_R vs F_Rc | window start / t_c | move the window; F_Rc |
| 14 | μ, c_t of the injected fluid used | input error | fluid type vs reservoir | reservoir values forced (C1) |
| 15 | Steeper than −1.6 late | boundary, wrong origin, cooling | plateau test with a bracket p_i | label only, no line |
| 16 | Supercharge from earlier operations | initial static ≠ C1 p_i | triage | note |
| 17 | Unit log-log slope past ΔtD ≈ 1 before closure | a near-constant-rate sink (leak); not storage, which cannot change the shape | `unitSlopeSink` (§4.6) | "constant-rate sink (leak?)"; leak plot and annulus check linked |
| 18 | Wave-ISIP well above the falloff ISIP | friction bleed-off not removed from the hammer midline | bleed term fitted? predicted Δ at the window end | "upper estimate"; excluded from the reconciliation |

### 4.20 ▶ Analyse pipeline, slicing, cancel and budgets (`PRiSM_dfit_pipeline` in 57; 59 drives the Job)

| Stage | Engine | Desktop target (2,000-point falloff) | Unit size |
|---|---|---|---|
| prepare (+ conversion band when surface) | `PRiSM_dfit_prepare`, `WTS_wellbore.convert` | ≤ 60 ms (+ ≤ 40 ms band) | 1 unit |
| events, ramps, triage | `_events`, `WTS_wellbore.ramp`, `PRiSM_dfit_triage` | ≤ 40 ms | 1 |
| ISIP (incl. hammer fit with the bleed term when a window exists, step-down, step-rate) | `_isip`, `WTS_wellbore.*` | ≤ 90 ms | 1 |
| derivatives, picks | `_derivs`, `_closurePicks` (+ var-compliance fit) | ≤ 60 ms | 1 |
| stability grid (closed-form methods only) | `_consensusJob` | ≤ 600 ms | 8 settings per unit |
| classify (incl. the κ_exp coarse run), frac outputs, what-if | `_classify`, `_frac`, `_whatIf` | ≤ 25 ms | 1 |
| ACA (+ gas iteration, + library match when requested) | `_aca`, `_acaMatchJob` | ≤ 150 ms (+ ≤ 800 ms match) | 1 model per unit |
| uncertainty | `_uncertaintyJob` | ≤ 60 ms | 250 draws per unit |
| evidence, report model, grade, summary | 57, `PRiSM_dfit_grade` | ≤ 20 ms | 1 |

`PRiSM_dfit_pipelineJob` exposes these stages as work units; `opts.fast` skips the grid, the bootstrap and the uncertainty
(≈ 50 ms). 59 runs the Job through `PRiSM_autoInterp.drive(job, {shouldCancel, onProgress})` inside `PRiSM_undoBatch('begin')` …
`('end')` (ended on finish, on cancel and on rejection, so one Analyse is exactly one undo step); `shouldCancel = () => cancelled ||
!(shell = document.getElementById('prism_shell')) || !shell.isConnected || PRiSM.mode !== 'dfit' || token !== currentToken`.
Cancel keeps the previous results and shows "Cancelled — previous results kept". After a run 59 stores `st._dfitRun`, writes
`T.summary`, the idealised schedule and the C1 fields, and fires `prism:dfit-updated {what:'all'}`. The leak-off history match, the
designer and the uncertainty in "model-consistent" mode run from their own buttons, never inside ▶ Analyse. After the last stage,
zero timers are pending (smoke and `dfit-ui` U9). The targets above are measured by `dfit-validate.js --perf`; acceptance tests
assert `run.counts` and scaling ratios (§8.6).

### 4.21 Reference worked example (the synthetic vertical well used by every note)

Datum 10,000 ft TVD; slickwater 8.43 ppg (0.438 psi/ft; ρ 1.960 slug/ft³); 5½-in 20 lb/ft casing (ID 4.778 in, V_w 1,245.1 ft³);
12 perforations 0.40 in, C_d 0.6; 25 bbl at 5.0 bbl/min (tp 5.0 min); E′ 5.0e6 psi, h_f 50 ft, h_p 40 ft, p_r 4,500 psia, φ 0.06,
c_t 1e-5 1/psi, μ 0.5 cp. The 25 bbl is taken as **V_i\*** (no fill; the wellbore compression up to closure already excluded), so
the closure balance reads directly. Values revised for the storage-consistent balance and the single system compressibility.

| Output | Value |
|---|---|
| c_sys, V_w·c_w | 3.57e-6 1/psi; 4.44e-3 ft³/psi (7.91e-4 bbl/psi); ramp 6,323 psi/min |
| Water hammer | c 4,539 ft/s; T 8.81 s quarter-wave → reflector 10,000 ft; Joukowsky 232 psi; L·A/(ρc²) = 4.44e-3 ft³/psi (agrees with the ramp) |
| Step-down | p_frac 7,595.5; 38 psi perforation + 315 psi tortuosity at 5 bbl/min; 11.9 of 12 open (P10/P50/P90 8.9/11.7/16.0) |
| Friction bleed-off | 1 psi after 15.4 min (pure q^½) or 1.6 min (two-branch) |
| ISIP | 7,600 ± 5 psia (0.760 psi/ft); surface equivalent 3,216 psia (constant gradient) |
| Falloff | p = 7,600 − 33.33·G (α = ½) to closure |
| Closure | 7,000 psia (0.700 psi/ft), Δt_c 305.1 min, ΔtD,c 61.02, G_c 18.00 |
| Efficiency | η_G 0.900 (α = ½), 0.915 (α = 1); η_f 0.898; pn 600 psi; χ 1.00 |
| Closure balance | C_sys = η_G·V_i\*/p_n = 0.2105 ft³/psi; A_f·c_f = 0.2061 ft³/psi; R_vis 0.979; V_f 123.7 ft³ (22.0 bbl) |
| Geometry | PKN consistent: xf 131.2 ft, A_f 13,121 ft², w̄ 0.113 in, CL 1.903e-4 ft/√min; KGD 57.3 ft / 4.361e-4; radial 57.8 ft / 4.409e-4 (r_p 0.432; 2R 115.6 ft > 50 ft barriers) |
| Groups | Γ = 9.49 psi/√min; Γ_PKN 15.2 (14.9 without storage) |
| Leak-off | 0.500 → 0.0405 bbl/min shut-in → closure; 22.5 bbl leaked after shut-in (25 bbl in total); V_L during pumping 14.04 ft³ (all geometries) |
| k from CL | 2.75e-3 md (PKN, Δp_CL 2,800 psi) |
| Thermal | ≈ 1.4 psi/°F before closure; ≈ 65 psi/°F after (100 °F column) |
| Forecast | σ 7,200 → 2.46 h; 6,800 → 8.63 h |
| Tolerance τ | max(15, 21, 18) = 21 psi |

### 4.22 Defaults (all user-editable; "cal" = replaced by the 3.4b calibration table)

| Name | Default | Where |
|---|---|---|
| Rate thresholds pump start / shut-in | 2 % of q_max / 5 % of q_last | events |
| Resampling | 40 per decade; dpMin = max(0.05 psi, 3σ, 10 quanta) | prepare |
| Bourdet L (pre / after closure) | 0.1 / 0.25 ln units | derivs, ACA |
| Compliance and tangent ε | max(0.02, 3σ) | picks |
| Log-log departure ε_ll | 0.05 held ≥ 0.1 log cycle (votes only when \|ι\| ≥ 0.05) | picks |
| Tolerance scale τ | max(15 psi, 0.3 % σ_c, 3 % pn) (cal) | consensus, label |
| Single-closure test | s ≤ 2.5τ and overlapping family bands | consensus |
| Label thresholds | high: s, w, g ≤ τ; low: w or g > 2.5τ; R_vis 0.7 / 0.3; 0.3 G-decade; noise 2 %; χ 0.9–1.1 (cal) | consensus |
| σ_f floor | max(1 psi, 2σ_gauge) | consensus |
| Frictional check | veto: μ 1.0, S_v 0.9 psi/ft, p_p at the lower bracket edge; warning: μ 0.6, S_v 1.0 psi/ft | bounds |
| ISIP agreement | high ≤ max(10 psi, 2 % pn); medium ≤ max(25 psi, 5 % pn) | ISIP |
| Wave-ISIP acceptance | bleed term fitted, or predicted Δ at the window end < max(2 psi, 3σ) | ISIP |
| Classifier tie margin | 0.15 | classify |
| ACA regime bands (on s_D) | ±0.07 (±0.1 spherical); storage only if s_D > −0.40 before any −0.5 segment or for > 1 log cycle; artefact < −1.6 | ACA |
| Point p_i | only where \|Δs_D\| < 0.1 over 0.5 log cycle | ACA |
| ε afterflow limit | 0.05 | ACA, designer |
| Δp_CL (CL ↔ k) | ½·(ISIP + σ_c) − p_r | frac, ACA, mini-model |
| Gas forcing | (p_c − p_i)/p_i > 0.1 or p_i < 3,000 psia; stop at \|Δp_i\| < 0.1 psi | gas |
| Atmospheric pressure | 14.696 psia (07's fixed value; a different test value is applied as a difference) | prepare |
| Uncertainty draws / seed | 1,000 (cap 2,000) / 1 | uncertainty |
| Range-mode family weight | F1 0.5 / F2 0.5 ("interpretive weight, not a probability") | uncertainty |
| Designer draws / grid | 500 (cap 2,000) / coarse (≈ 232 steps) | designer |
| Leak tolerance ε | 0.05 | leak budget |
| Step stabilisation | projected drift over one step < max(5 psi, 10 % of the step's rise) | step-rate |
| CUSUM k, h; decimation (live) | 0.5, 5 on pressure residuals decimated to one per 2L in ln G (cal) | live |

---

## 5. The leak-off rate mini-model (58, WP4)

Prototyped in pure `Math.*` (≈ 330 lines, `shutin/dfit/_leakoff/lk.js`) with twelve verification cases; every number below came
from a run of that prototype, except V13–V14 and the log-k parameterisation (review additions, closed-form checks). The prototype is a
planning check: WP4 ports it to the file conventions and the §3.7 API.

### 5.1 What it answers

- Standalone, no data: "what leak-off rate do I get?" for a planned schedule, geometry, E′, fluid, CL and spurt — leak-off rate
  against time (wall, reservoir and spurt parts), cumulative loss, the volume partition (fracture / formation / wellbore),
  efficiency, closure time (mechanical and hydraulic), half-length or radius, widths, the pressure falloff and its own G-plot.
- Inverse quick answers: "what CL gives my observed closure time?" (≈ 25 runs, ≈ 0.1 s) and "what volume and rate give a visible
  closure within X h?" (coarse-grid scan).
- History match of a recorded DFIT: reservoir permeability k and/or the wall coefficient C_w (reported as the CL equivalent, w_c and
  Γ), closure stress, pore pressure, contact scale, optionally E′ or height, toughness, PDL, spurt, with an identifiability report.

### 5.2 Equations

**Volume balance, every step** (exact):

```
V_w·c_w·(p_w,n+1 − p_w,n) + [V_f,n+1 − V_f,n] + ΔV_L,n+1 = Q_in = q̄·Δt
V_f = A(L)·W(p̄; L)                 W from the aperture law (W = c_f·p̄ for hard closure)
ΔV_L = f_PDL(p_m)·[H_open·2·C_w·ΔB_w + 2·κ_k·ΔB_c] + 2·S_p·(A_L,n+1 − A_L,n)        (κ_k = √(kφc_t/(πμ_r)), below)
p_w = p_f + (Λ − 1)·p̄_visc(L, q)·[pumping] + Δp_nwb(q),   Δp_nwb = a·q² + b·q^β (from the step-down)
```

Summed: V_i = V_f + V_L + V_w·c_w·(p_w − p_w,0) (closed to 1.05e-8 ft³ of 140.36 ft³).

**Geometry and compliance** (uniform net pressure after shut-in; Sneddon): PKN A = 2·xf·h_f, A_L = A·min(1, h_p/h_f),
c_f = π·h_f/(2E′); KGD c_f = π·xf/E′; radial A = πR², A_L = 2R²·[u√(1 − u²) + asin u] with u = min(1, h_p/(2R)) (so r_p changes as R
grows), c_f = 16R/(3πE′). The leak-off integrand is A_L(t) itself.

**Lumped propagation** (pumping): p̄_prop(L, q) = p_tip(L) + p̄_visc(L, q).

| | p_tip (K_Ic psi·√in, lengths ft) | p̄_visc, field form (μ cp, q bbl/min, E′ psi, ft) | Λ |
|---|---|---|---|
| PKN | 0.28868·K_Ic/√(π·h_f/2) (a floor, constant in L) | 0.015426·(μ·q·E′³·xf/(2·h_f⁴))^¼ | 5/4 |
| KGD | 0.28868·K_Ic/√(π·xf) | 0.007880·(μ·q·E′³/(2·h_f·xf²))^¼ | 1 |
| Radial | 0.28868·K_Ic·√π/(2√R) | 0.008527·(μ·q·E′³/R³)^¼ | 1 |

The toughness vertex is exact; PKN's viscous constant comes from the constant-flux elliptic channel (no-leak-off law
xf = 0.5236·(E′·q₁³·t⁴/(μ·h_f⁴))^⅕); the KGD and radial prefactors are calibrated so the lumped no-leak-off laws reproduce published
zero-toughness similarity constants (KGD 0.6152, radial 0.6955, under the conventions μ′ = 12μ, Q₀ = the total injection rate — per
unit height for KGD — and K′ = 4·√(2/π)·K_Ic, with which V3's 317.98 / 165.02 ft reproduce and the toughness vertex gives exactly
0.9324 / 0.8546; using μ where μ′ is meant would change L by 12^(1/6) = 1.51 or 12^(1/9) = 1.32) **that were quoted from memory and
must be verified before the tests are frozen**
(gate G4 in WP4; a corrected value only changes κ; until verified the UI labels KGD/radial pumping pressures
"viscous term uncalibrated"). `viscCal` multiplies κ. The additive transition over-predicts p̄ by up to ≈ 20 % between vertices;
the fit absorbs it through the **apparent toughness** (default K_Ic,app = 14,000 psi·√in reaches field-like net pressures:
456 psi tip + 140 psi viscous at xf = 134 ft). The UI and report say: "apparent toughness stands in for tip and scale effects; it
is not a rock property."

**Two-part leak-off**: a wall (filter-cake / filtrate) part with coefficient C_w and a reservoir-controlled part with permeability k.
The fit parameters are **C_w and log k**, never CL and w_c:

```
Abel form (exact for a piecewise-linear history):   V_Lw(t) = 2·C_w·∫₀ᵗ A_L(s)/√(t − s) ds ≡ 2·C_w·B_w(t)
reservoir-controlled (1-D Duhamel, actual pressure): V_Lc(t) = 2·κ_k·∫₀ᵗ A_L(s)·(p_f(s) − p_r − δ(s))/√(t − s) ds ≡ 2·κ_k·B_c(t)
κ_k = √(kφc_t/(πμ_r))     k enters directly, so κ_k stays fixed while σ_c and p_r move in the fit
reported at the §4.10 convention Δp_CL = ½·(ISIP + σ_c) − p_r of the run (a reporting convention only; it replaces the earlier Δp_ref):
   C_c,eq = κ_k·Δp_CL,  CL_eq = C_w + C_c,eq,  w_c,eq = C_c,eq/CL_eq   ⇔   k [md] = 1000·(C_c,eq[ft/√min]/(0.0374·Δp_CL))²·μ_r/(φc_t)
segment integral (no cancellation): ∫_a^b y/√(T − s) ds = d1·[2·y_a + (2/3)·(y_b − y_a)·(1 + s_a/(s_a + s_b))],
                                    s_a = √(T − a), s_b = √(T − b), d1 = (b − a)/(s_a + s_b);  newest segment (T = b): √Δt·[(2/3)y_a + (4/3)y_b]
```

- C_w (filter cake / filtrate) is classical Carter, pressure-independent, active only while open: H_open = the step-averaged open
  fraction (1, 0, p̄_n/(p̄_n − p̄_n+1) when closing) for the hard law `none`, and **H_open = c(p̄_m)/c_f0** for the contact laws `exp`
  and `hyp` (wall leak-off fades with the aperture instead of stopping abruptly at contact onset while the fracture is still open,
  which would create an artificial stiffening at σ_c in wall-only runs and teach it to the classifier and the benchmark truth). It
  does not feed the reservoir pressure: with no reservoir part (k = 0, wall-only) the model is the classical
  G-function world and the pressure stays near σ_c after closure (banner "after-closure not modelled: wall-controlled leak-off").
- The reservoir part carries leak-off through closure into after-closure linear flow with no switch: p − p_r → Ṽ/(π·κ_k·√t) for
  t ≫ t_c (Ṽ = V_Lc/(2A_L)), the impulse linear-flow law. **Default reservoir-controlled (k free, C_w = 0) for water-based DFITs**;
  wall-only (C_w free, k = 0) for verification and wall-building fluids.
- **PDL:** f_PDL = min(f_max, e^(C_d·(p − p_fo))) above p_fo and 1 below (default p_fo = σ_c, f_max 50). **p_fo is constrained to
  ≥ σ_c**, so f_PDL = 1 after closure, where backflow increments ΔB_c < 0 can occur and would otherwise break the monotonicity of the
  step equation (§5.3); applied at the mid-step pressure to both parts; optional Castillo power law for n ≠ 1.
- **Spurt:** 2·S_p per unit of new permeable area.
- **2-D far-field** (optional; pseudo-radial transition): δ(t) = Σ_j q_c,j·[D(t − t_j−1) − D(t − t_j)], D = P_2D − P_1D,
  P_2D = μ_r/(2πk·h_p)·p_D,uf(t_D), p_D,uf = √(πt_D)·erf(1/(2√t_D)) + ½·E1(1/(4t_D)), P_1D = μ_r/(2πk·h_p)·√(πt_D), t_D = ηt/xe²,
  xe = xf (PKN/KGD) or A_L/(2h_p) (radial); D tabulated on 600 log lags; history in 60 log bins (O(N·60)). Reference implementation
  for the test: `PRiSM_model_infiniteFrac(tD, {uniformFlux:true})`.

**Aperture laws** (closure signature; c/c_f0 = relative compliance):

| Law | p̄ ≥ 0 | p̄ < 0 (x = σ_c − p) | c/c_f0 |
|---|---|---|---|
| `none` (hard, Nolte) | c_f0·p̄ | 0 | 1 / 0 |
| `exp` (decaying residual; as the variable-compliance fit) | w_σ + c_f0·p̄, w_σ = c_f0·[f_res·s_r + (1 − f_res)·s_c] (w_σ = width at σ_c) | c_f0·[f_res·s_r·e^(−x/s_r) + (1 − f_res)·s_c·e^(−x/s_c)] (> 0 for every x) | f_res·e^(−x/s_r) + (1 − f_res)·e^(−x/s_c), s_r ≫ s_c (default 20·s_c) |
| `hyp` (hyperbolic, the default when contact is on; always positive) | c_f0·(s_h + p̄) | c_f0·s_h²/(s_h + x) | 1/(1 + x/s_h)² |

Two closure times: **mechanical** (p_f = σ_c, the contact onset) and **hydraulic** (c/c_f0 = ½: x = s_h(√2 − 1) for `hyp`; for `exp`
solved by bisection, ≈ s_c·ln((1 − f_res)/(½ − f_res)) when s_r ≫ s_c — 0.811·s_c at f_res 0.1, 0.801·s_c with s_r = 20·s_c — and on
the residual branch when f_res ≥ ½). The earlier exponential form w = w_σ − c_f0·[f_res·x + (1 − f_res)·s_c·(1 − e^(−x/s_c))] reached
zero 220 psi below σ_c (f_res 0.1, s_c 100) and went negative, while DFIT falloffs go more than 2,000 psi below σ_c, and its
non-decaying floor f_res·c_f0·A_f (≈ 4 × V_w·c_w) dominated after-closure storage; it is not used. Widths are additionally clamped at
w ≥ 0 with zero compliance at w = 0 as a guard.

**Tip extension** (3.4b, phenomenological): L relaxes toward the equilibrium length at constant volume with e^(−Δt/τ_x); new area
is fresh (high early Carter rate, takes spurt). **Breakdown** (`p_bd`): the wellbore compresses until p_w ≥ p_bd, then a flaw
(L0 = 1 ft) opens and the first propagating step dumps the wellbore over-pressure (scan upward for the first sign change = the
stable branch). **Special modes:** `prescribed` (A = A_p(t/tp)^α, constant c_f: Nolte's assumptions), `constP` (constant width:
Carter's), `propagate` (full). Multi-cycle schedules need no extra code (re-opening at ≈ σ_c + p_tip; old area keeps its opening
times; 3.4b).

### 5.3 Numerics

- **Grid** fixed by the schedule and t_end, never by the parameters (smooth fit objective): geometric steps after every rate change
  from Δt0 (0.25–0.5 s) with ratio 1.05–1.1 capped at segment/40–60; after shut-in log-spaced to t_end. N ≈ 600 for fitting, 1,500–
  2,000 for display, ≈ 232 "coarse" for ensembles (max |Δp| 0.44 psi, t_c −6.2 of 286 min against fine). Dense output by linear
  interpolation in t.
- **History sums** once per step, one loop with two accumulators (h_A for A_L, h_Y for A_L·(p_f − p_r − δ)) sharing the kernel weights.
- **Per-step solve: one bracketed monotone scalar root** (Illinois). Fixed area: F_p(p) = V_w·c_w·(p + exc + Δp_nwb − p_w,n) +
  A·W(p − σ_c) − V_f,n + ΔV_L(p) − Q_in is non-decreasing in p (given p_fo ≥ σ_c, §5.2), so bracketing always
  succeeds; the bracket-expansion guard stays. Propagating (pumping and
  p\* − σ_c > p̄_prop): F_L(L) on [L\*, 1.5^k·L\*], first sign change = stable branch. Tolerances are relative,
  |Δx| ≤ tol·(1 + |x|) with tol 1e-13 (p) and 1e-10 (L) (an absolute 1e-13 psi is below the double-precision spacing at 7,000 psi,
  ≈ 9e-13, and would never converge); 10–25 evaluations per step, each O(1); an iteration cap (60) backs the tolerance.
- **Closing step:** step-averaged open fraction (continuous in p_n+1; a mid-step evaluation made a 0.2 ft³ balance error in an early
  prototype). Reported t_c by event location (bisection of the crossing step to |p_f − σ_c| < 0.01 psi); tests extrapolate the last
  two open samples linearly in G (exact for Nolte: G_c 18.00394 on every grid from 117 to 3,301 steps).
- **Stability:** the history is explicit but exact and only the newest segment is implicit, so there is no step limit (an explicit
  newest segment would go unstable after closure once Δt ≳ (C_sys/(2κ_k·A_L))², 0.16 h in the reference).
- **Guards:** V_w·c_w ≥ 1e-6 ft³/psi; L ≤ 5,000 ft; ≤ 200 bracket expansions ("geometry runaway"); NaN guard on every committed
  state → `{ok:false, why, step}` with the partial result kept for plotting; a step cap and a run budget (`budgetMs`, `Date.now()`
  checks, secondary; never a timer); a volume-balance audit with a warning above 1e-6·V_i; validity diagnostics (t_Dxf at t_end, L/h_f
  for PKN ≥ 1.5 and KGD
  ≤ 1, 2R vs barrier spacing, p_tip/p̄_prop regime indicator, component shares).
- **Special functions:** erfcx by series (x < 3) and continued fraction (the naive product overflows near x = 27); E1 by series ≤ 1
  and continued fraction above; Nolte g from 56.
- **Cost** (desktop, prototype): 2.8 ms (N ≈ 470), 11 ms (≈ 890), 45–50 ms (≈ 1,840); far-field with log-binned history adds
  O(N·60). Phone ≈ × 3. Optional sum-of-exponentials kernel (≈ 40 terms, 1e-7 relative over 8 decades, O(N·40), 1–2 ms at
  N = 2,000) is phase 3 and keeps the direct sum as the test reference.

### 5.4 Verification (acceptance vectors; common inputs E′ 5.0e6 psi, h_f 50 ft, h_p 40 ft, σ_c 7,000, p_r 4,500 psia, 5 bbl/min, 25 bbl, μ 1 cp; V_w·c_w 4.98e-3 ft³/psi where storage is on — the prototype's input, passed explicitly; the reference well of §4.21 uses the hammer-consistent 4.44e-3)

| # | Case | Expected | Tolerance |
|---|---|---|---|
| V1a | Nolte falloff, α = 1, `prescribed` (A_p 13,404 ft², c_f 1.571e-5, CL 1.863e-4, no storage) | V_L = 2r_p·A_p·CL·√tp·g(ΔtD, 1) to 7.9e-15 rel; p = ISIP − m_G0·G to 4e-9 psi; ISIP 7,610.003; η 0.91513; G_c 18.306 | 1e-10 rel / 1e-6 psi |
| V1b | same, α = ½ | V_L rel err 2.4e-5; \|p − (ISIP − m_G0·G)\| ≤ 1.5e-3 psi; ISIP 7,599.93; η 0.90002; G_c 18.0039 (Δt_c 305.2 min); m_G0 33.322 | 1e-4 / 0.01 psi |
| V1c | grid independence (117 … 3,301 steps) | G_c = 18.00394 | 1e-5 |
| V1d | storage in the G slope (m_G0 = the no-storage slope of V1b) | ISIP 7,586.07; G_c = pn·(1 + V_w·c_w/(A_f·c_f))/m_G0 = 18.0040 (model 18.0039) | 1e-4 |
| V2 | Carter area, `constP` p̄ 600 psi, r_p 1, 30 min | A(t) = (q·w_e/(4πC²))·[erfcx(x) + 2x/√π − 1], x = 2C√(πt)/w_e, w_e = w + 2S_p; A(30 min) = 68,890.1 / 47,998.1 / 33,134.4 / 22,044.7 / 8,992.5 ft² for (CL, S_p) = (1.863e-4, 0) / (1.863e-4, 2) / (1e-3, 0) / (1e-3, 5) / (5e-3, 0) | 1e-4 rel |
| V3 | no-leak-off growth laws (conventions of gate G4: μ′ = 12μ, Q₀ the total injection rate, per unit height for KGD, K′ = 4·√(2/π)·K_Ic) | exponents 0.8000 / 0.6667 / 0.4444 (viscous PKN / KGD / radial), 0.6667 / 0.4000 (toughness KGD / radial); L(5 min) 468.29 / 317.98 / 165.02 / 573.01 / 192.54 ft; toughness prefactors 0.9324 / 0.8546; η = 1.00000 | 1e-4 |
| V4 | efficiency limits (PKN, K_Ic 0, CL 1e-6 … 3e-2) | α_A → 0.800 and → 0.502; η_s → 0.998 and → 0.0049; η from G_c with the model's α within 5e-4 of η_s | 1e-3 |
| V5 | storage ramp (`p_bd` 9,500, p0 4,500) | dp/dt = q/(V_w·c_w) = 5,637.1 psi/min at the 4.98e-3 input (6,323 psi/min at the reference 4.44e-3) | 1e-6 |
| V6 | after-closure linear asymptote (reservoir-controlled, k equivalent of CL 1.863e-4 at Δp_CL, 1-D) | ratio 1.0165 (20 h), 1.0059 (100 h), 1.0039 (200 h); slope −0.506 / −0.501 / −0.501 | slope −0.5 ± 0.01 at t ≥ 50 t_c |
| V7 | volume balance (full options, breakdown) | \|V_i − V_f − V_L − V_w·c_w·Δp_w\| ≤ 1.05e-8 ft³ | 1e-6·V_i |
| V8 | cross-check with the pre-closure example (PKN, K_Ic,app 14,000, wall-only leak-off, storage) | xf 133.8 ft, pn 596.3 psi, η 0.892, Δt_c 307.1 min vs the §4.21 values 131.2 / 600 / 0.900 / 305.1 | 3 % |
| V9 | 2-D far-field (k 0.1 md, xe 170.7 ft) | slope −0.653 (t_D 0.15), −0.845 (0.61), −0.911 (1.51), −0.928 (3.03), −0.940 (6.03); Δp/radial impulse 0.955 (1.5), 0.977 (3.0) | slope < −0.9 for t_D > 1.5 |
| V10 | self-consistent G (wall-only leak-off) with g = B_w/(A_L,s·√tp) | dP/dG_gen = −32.487 constant to 1e-3 psi from 1 to 240 min, while dP/dG(α = ½) drifts −37.3 → −32.6 | 1e-3 psi |
| V11 | fit recovery (run A) | k (or C_w), σ_c, p_r inside the 95 % CI from a start ×1.5, +150 psi, −200 psi in ≤ 40 runs | inside CI |
| V12 | identifiable group (runs B, G, I) | Γ_PKN = r_p·CL·E′/h_f = 14.904 in all three (= (π/2)·Γ/R_vis of the run) | 1e-3 |
| V13 | model-derived G against closed forms | prescribed area histories with α = ½ and α = 1 give g = B_w/(A_L,s·√tp) equal to the closed-form g(ΔtD, α); a constant area from t = 0 gives Nolte's limit g = 2√(1 + ΔtD) | 1e-6 rel |
| V14 | aperture laws stay positive | `exp` (decaying residual, f_res 0.1, s_c 100, s_r 2,000 psi) and `hyp` (s_h 60) give w > 0 and c ≥ 0 down to x = 3,000 psi below σ_c; hydraulic closure 0.801·s_c (`exp`; 0.811·s_c in the s_r → ∞ limit) and s_h·(√2 − 1) (`hyp`) | 1e-3 rel |

### 5.5 Outputs

`LkResult` (§3.7): p_w and p_f; optional surface pressure p_s = p_w − hydrostatic + Δp_pipe(q) via `WTS_wellbore`; L(t), A, A_L,
mean and maximum width (4/π·w̄ PKN/KGD, 1.5·w̄ radial); q_L = ΔV_L/Δt (bbl/min; bbl/d after closure on display) and its wall /
reservoir / spurt parts; cumulative V_L with the same parts, V_f(t), V_i(t); the wellbore volume V_w·c_w·(p_w − p_w,0) — the
**volume-partition** series; η of the pumped volume and η(t) = V_f/V_i,frac (they differ by the wellbore compression:
V_f/V_i = 0.814 and V_f/V_i,frac = 0.916 in the breakdown example); events (breakdown, ISIP, last pump pressure, the ISIP drop split
into near-wellbore and viscous
redistribution, t_c mechanical and hydraulic, G_c for α = ½, α = 1 and the model's own G); xf at shut-in and closure; k and the CL
equivalent
at Δp_CL (with w_c,eq); t_Dxf range; balance error; warnings.

**Model-derived G:** g(t) = B_w(t)/(A_L,s·√tp), G_gen = (4/π)·(g(t) − g(t_s)), with B_w = ∫A_L(s)/√(t − s) ds computed from the area
history whatever C_w is (so it exists at the default C_w = 0) — exactly the data-driven G of §4.5 with τ(a) from the model, passed to
`PRiSM_dfit_gFromHistory` as a `gSpec`. Check: since V_Lw = 2·C_w·B_w and Nolte's V_L = 2·A_L,s·CL·√tp·g, a constant area from t = 0
gives g = 2√(1 + ΔtD) (V13; a factor ½ in g would halve G_gen and double dP/dG_gen). With it the reference falloff has a constant dP/dG
(−32.487) where the
α = ½ axis shows a false 15 % early steepening (V10) that would be read as PDL or tip extension.

**Leak-off types simulated on the base case** (signature library for the classifier tests; §8):

| Case | xf (ft) | ISIP | η | Δt_c (min) | q_L bbl/min at 1 s / 5 / 25 / 100 min | dP/dG at G = 1, 5, 10, 15 | p at 24 h / 300 h |
|---|---|---|---|---|---|---|---|
| Carter (w_c 0) | 133.8 | 7,596.3 | 0.892 | 307.1 | 0.586 / 0.262 / 0.135 / 0.070 | −34.6, −32.9, −32.7, −32.6 | 6,999 / 6,999 |
| Reservoir-controlled (w_c 1) | 131.2 | 7,595.6 | 0.873 | 288.1 | 0.713 / 0.306 / 0.149 / 0.069 | −41.4, −36.2, −32.6, −29.6 | 5,342 / 4,732 |
| Fissure PDL C_d 0.004, p_fo = σ_c | 75.8 | 7,577.7 | 0.489 | 57.9 | 3.05 / 0.54 / 0.12 / closed | −141, −42.7, closed | 7,000 / 7,000 |
| Asperity contact (hyp, s_h 60) | 123.2 | 7,593.5 | 0.900 | 305.5 | 0.541 / 0.241 / 0.124 / 0.064 | −34.5, −32.8, −32.6, −32.6, then stiffening | 6,547 / 5,938 |
| Tip extension (τ_x 10 min, K_Ic 7,000; 3.4b) | 199.8 → 250.8 | 7,382.7 | 0.855 | 86.6 | 0.875 / 0.555 / 0.259 / closed | −75.3, −33.8, closed | 6,999 / 6,999 |
| Spurt 2 gal/100 ft² | 95.9 | 7,585.4 | 0.628 | 301.6 | 0.424 / 0.188 / 0.097 / 0.050 | −34.3, −32.6, −32.4, −32.3 | 6,999 / 6,999 |

Spurt changes xf and η strongly but the falloff by < 1 %: the falloff alone cannot determine spurt.

### 5.6 Standalone UI ("what leak-off rate do I get?")

Step ④ → "Leak-off model" sub-view (and the Tools-drawer entry `PRiSM_renderDfitSandboxTool`, registered for every PRiSM mode),
available with no dataset:

- **Inputs card** `#prism_dfit_lk_inputs` (`.card` / `.fg-item`): schedule (volume `#prism_dfit_lk_v` bbl, rate `#prism_dfit_lk_q`
  bbl/min, or "use the loaded test's schedule" `#prism_dfit_lk_usesched`), geometry select `#prism_dfit_lk_geom` (PKN / KGD / radial /
  auto), E′ `#prism_dfit_lk_ep` (1e6 psi), ν, h_f, h_p, injectate μ (cp), leak-off as CL (ft/√min) with "reservoir fraction w_c"
  `#prism_dfit_lk_wc` (converted to C_w and k at Δp_CL) or directly as C_w and k, spurt, PDL (C_d, p_fo), aperture law and scale, σ_c,
  p_r, V_w·c_w (from the wellbore card), t_end, mode
  (propagate / prescribed / constP), apparent toughness with its label. "Run" `#prism_dfit_lk_run` (≈ 10–50 ms; also on change,
  debounced through the save debounce, only while the card is visible).
- **Quick table** (`table.dtable`): q_L at shut-in, 5, 25, 100 min and at closure; cumulative leak-off; η; t_c (mechanical,
  hydraulic); xf/R; w̄; V_L at closure and t_end; k and the CL equivalent.
- **Volume-partition bar** (`dfitLkQ` stacked: fracture / formation / wellbore against time) synced with a fracture schematic that
  deflates under the time cursor (`prism:plot-hover`).
- **Plots:** `dfitLkP` (p_w, p_f and data when loaded), `dfitLkQ` (q_L by part, cumulative), `dfitLkG` (the model's falloff on the
  α = ½, α = 1 and model-derived G axes, with dP/dG and G·dP/dG), `dfitLkGeom` (L and w̄).
- **Goal-seek** `#prism_dfit_lk_goal`: "CL for an observed closure time" (`lkSolveCL`) and "volume and rate for a visible closure
  within X h" (`lkGoalSeek`, coarse grid: closure "visible" when R_vis ≥ 0.7 and Δt_c ≤ X).
- **Always shown:** "This falloff fixes Γ = r_p·CL·A_f/C_sys = 2·m_G/(π·√tp) = … psi/√min (PKN form Γ_PKN = r_p·CL·E′/h_f = …); CL is
  conditional on E′ = … and h_f = …" and the validity diagnostics as ⚠ lines.

### 5.7 History-match mode

- **Parameters** (transform, default bounds, prior source): **k** (log, 1e-7–100 md; started from the pre-closure CL at Δp_CL) for the
  reservoir part and **C_w** (log, 1e-7–1e-1 ft/√min; fixed 0 for water-based fluids by default) for the wall part — parameterised so
  that √(kφc_t/(πμ_r)) stays fixed while σ_c and p_r move (with CL and w_c as parameters, k ∝ (w_c·CL/(σ_c − p_r))² moved whenever σ_c
  or p_r did and coupled the Jacobian columns); S_p (log, 1e-3–20, fixed 0 by default); σ_c (linear, [p_ACA,end, ISIP] when closure is
  observed and [max(p_r,lo, frictional veto bound), ISIP] when it is not — p_ACA,end would exclude the truth when the falloff ends
  before closure; consensus); p_r (linear [0, σ_c], ACA); E′ (log
  0.3–10 × 1e6, logs ± 30 %); h_f (log, h_p–10 h_p, stress profile ± 20 %); K_Ic,app (log 500–50,000, from ISIP − σ_c − p̄_visc);
  s_h (log 1–2,000 psi) or s_c / f_res; C_d, p_fo; τ_x (3.4b); V_w·c_w (log ± 50 % around the ramp value).
- **Presets** (instead of a dozen check-boxes): "Falloff, closure" {k (or C_w), σ_c, s_h} with data to ≈ 2 t_c; **"Full test"
  (recommended)** {k, K_Ic,app, σ_c, s_h, p_r, C_w}; "Geometry group" (Full test + E′ free, h_f fixed; the report states Γ, not
  E′); "PDL" (+ C_d, p_fo); "Spurt" (+ S_p, only with K_Ic,app and E′ fixed). Never more than one of {E′, h_f} free; K_Ic,app free
  only with E′ fixed; never C_w, C_d and τ_x free together.
- **Objective:** pressure residuals (psi) on 200–400 log-spaced falloff times; injection weight 0 by default; optional derivative
  residuals on log(G·dP/dG) (weight 0.2), with the same Bourdet engine and L on data and model; optional MAP priors
  (ln θ − ln θ_prior)/σ_ln θ for E′, h_f, K_Ic,app; σ_p from the late-falloff first differences.
- **Initial guesses:** σ_c = consensus; k from the pre-closure CL of the chosen geometry at Δp_CL (C_w = 0); K_Ic,app inverted from
  ISIP − σ_c at the
  pre-closure xf; p_r = ACA intercept or σ_c − 0.5·(ISIP − σ_c); s_h = 0.3·(ISIP − σ_c); V_w·c_w = ramp value. Multi-start (in the UI
  and in `dfit-validate.js --quick`): 4 deterministic perturbations (k ×/÷ 4, σ_c ± one consensus band, s_h ×/÷ 3); report how many
  starts reached the best χ².
- **Algorithm:** `PRiSM_lm(modelFn, data, params0, bounds, freeze, {logKeys, maxIter})`, modelFn = simulate on the fixed grid and
  sample at the data times; finite-difference Jacobian (n_p + 1 runs per iteration); run budget 400 runs and 5 s wall-clock (reported
  as such); exposed as a `Job` (one LM iteration per unit) so 59 runs it with progress and Cancel. Measured: 3 free 0.27–0.42 s,
  4 free 0.18–0.42 s, 5 free 0.6–0.9 s at N ≈ 600.
- **Uncertainty that is honest about model error:** (1) LM covariance s²·(JᵀJ)⁻¹ (tiny on perfect-model data: σ_c ± 0.1 psi);
  (2) inflate by √(n/n_eff), n_eff = n·(1 − ρ1)/(1 + ρ1) from the lag-1 autocorrelation of the residuals (4–14× on field data);
  (3) **structural spread**: refit with each aperture law (none / exp / hyp) and PDL on/off; the spread of σ_c, p_r and k (and the CL
  equivalent) across
  structures with χ² within 1.5× the best is the reported closure-stress uncertainty; (4) profile likelihood on demand for σ_c and p_r
  (15 values, 3–6 s, as a Job); (5) Monte Carlo refits are phase 3 (needs the fast kernel).
- **Identifiability rules** applied and explained (synthetic history matches, σ_p 0.5 psi, 250 points to 100 h): the falloff fixes
  Γ (|corr| ≥ 0.997 among CL, E′, h_f, K_Ic,app; condition number 1e6–3e6); a wrong fixed height with E′ fixed fits badly (rmse
  19.6 vs 0.5 psi) and biases σ_c by 78 psi, while with E′ free it fits (0.82 psi) with σ_c fine but CL and E′ badly biased — "free
  one member of the group, read σ_c from that fit, report Γ"; spurt only through the propagation model; p_r needs after-closure data
  (± 9 psi with data to 1.5 t_c vs ± 0.24 psi to 21 t_c; corr(CL, p_r) 0.993 in the old CL/w_c parameterisation, part of which may be
  that parameterisation — re-measured with log k in WP4, LF8); σ_c trades off with the contact scale (corr 0.58);
  the wall / reservoir split identifiable with after-closure data (w_c ± 0.004; corr with CL −0.84,
  old parameterisation).
- **Plain-English sloppy-direction warning** when the smallest scaled Fisher eigenvalue is below 1e-4 of the largest, naming its
  two or three largest components: "E′ and fracture height cannot be separated by this test: only Γ = 9.49 psi/√min (r_p·CL·E′/h_f =
  14.9) is
  determined (±1 %). CL = 1.86e-4 ft/√min assumes E′ = 5.0e6 psi and h_f = 50 ft."
- The fit is stored in `T.lk.fit` and fires `prism:dfit-model-updated`; its σ_c becomes the F3 `model` pick; its area history
  can rebuild the model-derived G for the pre-closure plots ("use model G" toggle `#prism_dfit_usemodelg`).

### 5.8 Performance

| Operation | Desktop | Phone (× 3) | Where it runs |
|---|---|---|---|
| Simulate, display grid (N ≈ 1,840) | 45–50 ms | ≈ 150 ms | Run button, change |
| Simulate, fit grid (N ≈ 600) | ≈ 5 ms | ≈ 15 ms | inside LM |
| Simulate, coarse grid (N ≈ 232) | 1.2 ms | ≈ 4 ms | designer, goal-seek, live forecast |
| History match, 5 free parameters | 0.6–0.9 s | ≈ 2.5 s | Job with progress |
| Structural spread (3 laws × PDL on/off) | ≈ 3–5 s | ≈ 12 s | Job, on demand |
| Designer, 500 coarse runs | ≈ 0.6 s | ≈ 2 s | Job |

### 5.9 Limitations (printed in the help and the report)

Lumped geometry (uniform net pressure after shut-in, fixed height or unconfined radial, no pseudo-3D growth); calibrated propagation
constants and an additive transition (KGD/radial constants pending verification at gate G4 under μ′ = 12μ, Q₀ total rate,
K′ = 4·√(2/π)·K_Ic); apparent toughness is not a rock property;
wall-controlled leak-off does not feed the reservoir pressure; reservoir-controlled leak-off is single-phase, slightly compressible,
isothermal, per-element 1-D plus an approximate 2-D correction, liquid-equivalent for gas reservoirs; not modelled: thermal effects,
poroelastic back-stress, near-wellbore changes during the test, natural-fracture networks (except through f_PDL), transverse storage
(except through height recession, phase 3); tip extension phenomenological (3.4b); breakdown represented, not predicted.

---

## 6. New features in detail

Each item lists the algorithm (where not already in §4–5), the UI and the tests. Test ids refer to §9's test files.

### 6.1 Leak-off sandbox (beyond §5.6)

- **Volume partition and schematic.** From `LkResult`: fracture V_f, formation V_L (wall + reservoir + spurt) and wellbore
  V_w·c_w·(p_w − p_w,0), stacked against time (`dfitLkQ`), normalised to V_i. The schematic is an inline SVG (PKN ellipse section /
  KGD rectangle / radial disc) scaled by L(t) and w̄(t) at the hovered time; it carries `role="img"` and an `aria-label` with the
  numbers, and is captured by the report as an SVG.
- **Goal-seek** (§5.6) runs as a Job (≤ 25 runs; coarse grid for the V × q scan, 6 × 6 grid, then a refinement around the best cell).
- **Drag-to-fit (3.4b, `59-prism-dfit-dragfit.js`).** With a recorded test loaded, the user grabs the model curve on `dfitLkP`. While
  dragging, 3 LM iterations on
  the coarse grid over {k, σ_c, p_r} with a pseudo-observation (t\*, p\*) of weight 10/σ² keep it responsive; on release a full fit
  runs (fit grid) and the pseudo-observation is dropped. Uses the 02 pointer-owner hook. The residual plot and the identifiability
  warnings stay visible during the drag.
- **Tests** (`dfit-leakoff`, `opts:false` shared app, ≤ 3 s): L1–L14 = V1–V14; L15 quick table on the base case (q_L 0.586 / 0.262 /
  0.135 / 0.070 bbl/min, η 0.892, Δt_c 307.1 min, ±2 %); L16 `lkSolveCL` returns 1.863e-4 ± 2 % for Δt_c 307.1 min (wall-only) and the
  matching k for the reservoir-controlled case; L17 partition sums to V_i within 1e-6; L18 simulate and fit leave `localStorage`,
  `PRiSM_state` and the event log unchanged (pure).

### 6.2 Closure consensus board

**Algorithm** (on ▶ Analyse, not on redraw; inside `PRiSM_dfit_pipeline`):

1. Picks of §4.7 for every method, with `vote` and `sameEvidenceAs` marking the one voting member per family (F1 compliance, F2
   tangent, F4 reopening) and the dependent members; F3 (`varcomp`, `model`) and F0 are cross-checks.
2. Stability grid over the closed-form methods (§4.8: 54 settings + 50 seeded block bootstraps); F4 uses its own ramp bootstrap;
   `varcomp` and `model` show their own LM CI. A small heat map of the family P50 against (L, tp) flags an unstable pick
   (g > 2.5τ).
3. Bounds check (§4.8) per pick and per family band: veto below the μ = 1.0 frictional bound, warning between the μ = 1.0 and μ = 0.6
   bounds.
4. Mode single / range / none and the value or range on the τ scale (§4.8). Preferred reading from the classifier: normal or matrix
   → "families agree"; `hr-contact` → "ambiguous: the F1 end is the contact (compliance) reading, the F2 end the end of stiffening
   (tangent) reading"; PDL → "after the hump"; storage → "low visibility". When F4 exists it is shown as the injection-side check
   ("reopening 7,0xx psia, near-wellbore corrected, supports the F1 end").
5. Label with every rule listed (fired or not) and its number (evidence `K1…K10`): R_vis, w, s, g against τ and 2.5τ, data past the
   pick, noise at the pick, χ, mode, vacuum / thermal overlap, frictional veto or warning. 3.4a: "uncalibrated rule label"; 3.4b:
   per-mode hit rate from `PRiSM_dfit_cal`.
6. **Counterfactual sentence** (no separate engine): read from the stability samples already computed — the knob (L, tp, t_s ± one
   sample, ε) with the largest effect on the family P50, and the grid setting, if any, at which one family's P50 enters the other's
   band. Filled only with computed numbers, e.g. "Within the tested settings the compliance pick moves at most 14 psi (largest
   effect: L); no tested setting brings it into the tangent band, so the difference is interpretive." Plus the one measurement that
   would settle it (a second-cycle reopening ramp, a flowback knee, a longer shut-in), chosen by rule from the classification. First
   item on the slip list (§1.5).
7. **Override.** "Use another value" opens `#prism_dfit_override` (dialog): value, method or family, reason (required, ≤ 300
   characters), analyst name (from report options). Stored in `T.picks.closure` with `source:'user'`, logged, undoable; the board
   then shows "user override" in amber with the consensus beside it. In range mode "Use the F1 / F2 end for hand-offs" stores
   `mode:'family'` (Q6).

**UI** (Tab-2 panel `dfit-board`, step ③):

- The **closure strip** `dfitStrip` (canvas, full width, 120 px tall; 160 px on phones): pressure axis with ISIP and p_i markers; one
  P10–P90 bar per family (F1 blue, F2 orange, F4 green, F3 grey, F0 dashed); a dot per method (dependent members hollow, cross-checks
  as rings); the consensus value or the shaded range [P10 lower family, P90 upper family] with both medians ticked; the two
  frictional-limit lines (veto solid, warning dashed); the **what-if marker** (draggable) that sets `st._dfitWhatIf` and recomputes
  every downstream number with the fast pipeline (§6.6).
- Under the strip: `.rbox` "Closure" with `.rrow` value/range (with medians), gradient (psi/ft), label and its rules (`<details>`
  list), "Why this pick?" buttons per method (`#prism_dfit_why_<method>`) that switch the main plot to the method's plot, highlight
  its window and offer its method note (§6.13); the counterfactual sentence; the stability heat map (a 3 × 3 `table.dtable` coloured
  by deviation); "Use another value" `#prism_dfit_override_btn`.
- Verdict line, e.g. "⚠ Closure range 6,495–7,004 psia (medians 6,507 and 6,998; medium, uncalibrated): the contact and
  end-of-stiffening readings differ by 491 psi; the classifier cannot separate height recession from asperity contact."

**Tests** (`dfit-closure`, `opts:false` shared app, ≤ 4 s): C1 toy contact (f_res 0.10, s_c 100): F1 6,998 ± 5, F2 6,507 ± 10, √t
marked same-evidence, mode range reported as [P10(F2), P90(F1)] with both medians, χ(F2) ≈ 1.44; C2 pure Carter normal: s ≤ τ →
single, label high; C3 PDL hump: tangent excludes the hump (pick after G_fo), F0 = p_fo within 15 psi; C4 low visibility (gas-filled
wellbore, storage-consistent R_vis 0.54): label medium or low with the R_vis rule fired; C5 closure not reached → mode none, forecast
shown; C6 frictional check: a pick below the μ = 1.0 bound (p_p at the lower bracket edge, S_v 0.9 psi/ft) is vetoed and excluded, a
pick between the μ = 1.0 and μ = 0.6 bounds is kept with a warning; C7 the counterfactual sentence names the largest-effect knob on
the toy case from the stability samples (no extra refits: `run.counts.refits` unchanged); C8 determinism: the same seed gives
identical bands, sync = job; C9 the stability grid makes exactly 54 × (closed-form methods) + 50-bootstrap evaluations with `varcomp`
present (no `varcomp` refit inside the grid); C10 a user closure passed in `picks` replaces the consensus in `frac` and the what-if
table and is marked `source:'user'` (the UI round trip with log, undo and reload is `dfit-ui` U6 and `dfit-integration` I6); C11 on
contact data the `loglog` pick is `sameEvidenceAs:'compliance'` and coincides with the compliance pick within one window L; C12 label
arithmetic: at pn 100 psi and σ_c 7,000 psi, τ = 21 psi (not 3 psi), and an ISIP spread of 8 / 12 / 30 psi is high / medium / low
(the medium threshold max(25 psi, 5 % pn) never falls below the high one); a family band with P90 = P10 gets
σ_f = max(1 psi, 2σ_gauge); C13 a near-wellbore-corrected F4 pick within τ of F1 keeps the mode single; an uncorrected F4 bound below
the single value turns it into a range. Test signals are built with `PRiSM_dfit_vcModel` and
the hinge model (§4.15b), so WP2 needs neither the mini-model nor the generator.

### 6.3 Triage and data-health gate (`49-calc-dfit-triage.js`, WPT)

**Checks** (`PRiSM_dfit_triage`; pass / warn / fail; thresholds editable in `T.inputs.options.triage`; each with an evidence id
`Q1…`):

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Units and time base | mapped, monotonic | gaps > 1 % of the record | reversals, unknown units |
| Clock alignment | \|offset\| ≤ 1 s or corrected | corrected by > 2 s | events contradict |
| Wellbore stiffness (ramp V_w·c_w vs `WTS_wellbore.csys`) | ratio 0.5–2 | 2–4 | > 4 (air or gas, leak, open fracture) |
| Air / gas cross-check (ramp V_w·c_w vs L·A/(ρc²) from the hammer period with a known reflector) | both within 25 % of theory | one detector > 1.5 × theory | both > 2 × theory (air or gas confirmed by two independent detectors) |
| Surface liquid-supported | p_s > 15 psig throughout | 0–15 psig | < 0 psig in the analysed window |
| Static hydrostatic check (p_w − p_s vs model before pumping) | within 2 % | 2–5 % | > 5 % |
| Gauge isolation | falloff shows hammer or a falloff shape | – | flat or linear bleed (closed-line signature) |
| Sampling vs hammer | ≥ 10 per 2L/c | 3–10 per 2L/c | < 3 per 2L/c (hammer not analysed) |
| Shut-in duration | < 2L/c | 2L/c–4L/c | > 4L/c (Joukowsky QC off) |
| Step-down quality | ≥ 4 steps over ≥ 60 % of the rate range | 3 steps | < 3 or < 30 % range |
| Step-rate stabilisation | every step stabilised (§4.15) | one step not stabilised | two or more not stabilised |
| Surface-gauge friction share | Δp_pipe < Δp_perf at the top rate | 1–3 × | > 3 × (n_p not determinable) |
| Bleed-off window | G_min past the predicted Δ < 1 psi | within 2 × | picks inside the bleed-off |
| Volume reconciliation (∫q dt vs straps / strokes, fill excluded) | ≤ 5 % | 5–10 % | > 10 % |
| Temperature channel | BH T present | surface only | none, with a surface-gauge ACA |
| Gauge thermal transient | \|dT/dt\| < 1 °F/min after G_min | – | above, inside the pick window |
| Derivative noise | σ_D < 5 % of D at the pick | 5–15 % | > 15 % |
| Thermal (corr(detrended p, wellhead T) when T exists; dp/dT of §4.10 printed) | < 0.3 | 0.3–0.6 | > 0.6 inside a pick window |
| Constant-rate sink (unit slope past ΔtD ≈ 1 before closure; s_D ≈ 0 after) | none | present over 0.3 cycle (leak plot, §6.4) | – |
| Tides / barometric (ACA) | removed or < 10 % of Δp | 10–30 % | > 30 % |
| Annulus communication | none | – | p_ann correlated with pumping |

- **Pressure-gradient plot** `dfitGradient`: BHP/TVD (psi/ft) against time with the p_i gradient (`priors.piGrad`, else the fluid's
  hydrostatic), the stress-gradient prior band, the overburden gradient (`rock.sigmaVGrad`) and the ISIP/closure gradients; BHP
  above the overburden line flags a possible horizontal-plane fracture, at or below hydrostatic flags vacuum.
- **Blunder library** (`PRiSM_dfit_blunders`). Hypotheses, each an exact transform of the data or inputs: psig read as psia (+ atm;
  evidence: the source unit flag, or a reading within ±2 psi of zero while the well is open to atmosphere before pressure-up); kPa /
  bar / MPa read as psi (× 0.145 / 14.5 / 145); MD used as TVD (survey); gauge depth used as datum (ρ·ΔTVD); time unit s ↔ min ↔ h
  (pump time outside 1–60 min); bbl/d ↔ bbl/min (× 1440, volume vs straps); ± 1 h clock. 3.4a scores each hypothesis with rules on
  the well's own bands (ISIP gradient inside [p_i gradient, S_v gradient + 0.05 psi/ft]; hydrostatic within 2 %; pump time; volume);
  the Bayes-factor scoring with a lognormal ISIP-gradient prior centred on `priors.sigmaGrad` (generic 0.8 psi/ft only when nothing
  is known, labelled) is on the slip list (§1.5). A flagged blunder shows its fix; "Apply fix" writes `T.inputs.channels` (applied
  non-destructively, logged, undoable); "it is real" dismisses and logs.
- **Early "re-pump?" verdict** (`PRiSM_dfit_repump`; first hour, advisory, needs an "Acknowledge"), bands from the inputs:
  - R1 no breakdown and ISIP gradient ≥ the S_v gradient: note "possible horizontal fracture or no fracture" (warn);
  - R2 ISIP gradient below the p_i gradient (or hydrostatic when unknown) or above the S_v gradient + 0.05 psi/ft: fail (unit or depth
    blunder, or not a fracture) — **downgraded to warn when only generic priors are in use**;
  - R3 ΔISIP_nwb (= last pump − ISIP − pipe friction) > 30 % of (ISIP − σ_prior): tortuosity dominated, re-pump at higher rate or with
    a viscous pill (warn);
  - R4 measured V_w·c_w > 2 × theory (air or gas: circulate and re-pump) — fail when the hammer cross-check agrees, warn otherwise;
  - R5 storage-consistent R_vis < 0.3, or R_vis < 0.5 with the V_w·c_w ratio > 2: closure may be invisible (warn);
  - R6 Joukowsky mismatch > 50 % (rate record or valve) (warn);
  - R7 V_i,frac < the designer's V_min (fail).
  Verdict "repump" on any fail among R2/R4/R7 or two warnings, "caution" on one warning, else "continue".
- **Salvage plan:** the usable windows and what each still supports, e.g. "Use 0.2–31 h for closure; surface data after 31 h are on
  vacuum; p_i not observable from this gauge."
- **Grade** (`PRiSM_dfit_grade`, printed in the report and the rail): **A** — triage green, closure single with label high or
  medium, p_i label ≥ medium (or a designer outcome "closure only" met); **B** — no failed check inside an analysed window, closure a
  range or label medium, p_i any label; **C** — a failed check outside the analysed windows, a low closure label, or "partly
  interpretable"; **D** — uninterpretable or a "repump" verdict. Each grade lists its reasons.
- **UI:** Tab-1 panel `dfit-triage` with a traffic-light tile `#prism_dfit_triage_light` and the grade, the check table
  (`table.dtable`), blunder cards with "Apply fix" `#prism_dfit_blunder_apply_<id>` / "It is real" `#prism_dfit_blunder_dismiss_<id>`,
  the re-pump verdict with `#prism_dfit_repump_ack`, the salvage list; usable windows shaded on `dfitHistory`.
- **Tests** (`dfit-triage`, WPT, `opts:false` shared app, ≤ 3 s; artefacts built inline in the test, no dependency on the generator):
  T1 each check fires on its artefact (14 artefacts, one case each); T2 psig blunder found and the fix restores the true ISIP gradient
  through `channels` (dataset unchanged); T3 bbl/d vs bbl/min; T4 MD-as-TVD with a deviated survey; T5 vacuum masks the converted data
  after p_s < 0; T6 clock offset 37.4 s recovered within 0.2 s; T7 re-pump verdict on an air-in-well case (R4 with both detectors) and
  on a clean case (continue), and an overpressured case (ISIP 1.05 psi/ft, p_i 0.75 psi/ft, S_v 1.15 psi/ft) that is **not** a
  repump; T8 thresholds passed in `inputs.options.triage` change the levels; T9 grade mapping A–D on four fixture combinations;
  T10 the air cross-check fires only when both detectors exceed 2 × theory.

### 6.4 Leak budget and leak plot

- **Leak budget** (`PRiSM_dfit_leakBudget`, designer and step ①). A leak q_k biases the after-closure signal relative to the impulse
  by (q_k·t/V)·Θ, with **Θ = p_D/p_D′ of the expected regime at t_end** (p_D′ = t_D·dp_D/dt_D):
  - linear flow: Θ = 2, and k, h and xf cancel (constant-rate linear Δp = m·q·√t against the impulse V·m/(2√t)) — the only regime
    where the tolerance does not depend on permeability;
  - radial flow from a uniform-flux fracture: Θ(t_DL) from the §5.2 p_D,uf: 2.0 (t_DL ≤ 0.1), 2.4 (0.3), 3.1 (1), 3.5 (1.6), 4.0 (3),
    4.5 (5), 5.8 (20), tending to ln t_DL + 2.81 — so the linear rule is non-conservative by 1.6–3 × exactly when the test reaches the
    radial flow the designer recommends.
  The tolerance for a shut-in of t_end is **q_k,max = ε·V/(Θ·t_end)** (ε = 0.05), with t_DL(t_end) from the designer's draws and
  **Θ taken at the P90 of the draws** (the binding, smallest q_k,max); the regime used is named. Reference (25 bbl, 300 h): 0.050
  bbl/d in linear flow, 0.022 bbl/d if radial flow is reached at t_DL 5. Prototype check (linear): biases 0.018 / 0.063 / 0.181 for
  0.02 / 0.07 / 0.2 bbl/d against the rule's 0.020 / 0.070 / 0.200 — about 10 % conservative.
- **Pressure-test hold** to prove a leak below q_k,max: t_hold = 5σ_p·V_w·c_w/q_k,max (σ 0.05 psi, V_w·c_w 7.91e-4 bbl/psi, 0.050
  bbl/d → 5.7 min). It is valid only while thermal drift during the hold stays below 5σ_p, and a sealed liquid column moves
  ≈ 65 psi/°F (100 °F column) to ≈ 105 psi/°F (250 °F) (§4.10): the card prints the **temperature stability the hold needs**
  (here 0.25 psi ÷ 65 psi/°F ≈ 0.004 °F over the hold). When that is unrealistic (default: below 0.05 °F), it says so and recommends
  proving the leak after the fact with the leak plot below (or the 3.4b up-down hold test) instead of quoting minutes.
- **Leak plot** (after closure, t′ = t − t0 ≥ 2 t_c, inside the regime band): a leak adds −m·q_k·√t′ to the linear impulse and a gauge
  drift d (psi/h) adds +d·t′, so
  - linear form y_lin = −2·t′^1.5·dp/dt′ = A + B·t′ − 2d·t′^1.5, q_k = (B/A)·V/2 (bbl/h, × 24 for bbl/d);
  - radial form y_rad = −t′²·dp/dt′ = A + B·t′ − d·t′², q_k = (B/A)·V (bbl/h).
  Robust (Huber) regression with d constrained by a Gaussian prior N(0, s_d²) from the gauge drift spec (designer
  `gauge.driftPsiPerDay`, default 0.02 psi/d, entered as a pseudo-observation); CI by block bootstrap. When corr(B, d) > 0.95 the
  verdict is **"leak or drift (not separable)"** and no corrected p_i is offered. **Detection floor** = the q_k at which B differs from
  0 at 2σ with the drift term in the model (stated next to the result; the prototype read 0.021 bbl/d with no leak and no drift
  term). **Leak-corrected p_i** = median over the window of p − A/√t′ + B·√t′ − d·t′ (linear form), shown beside the uncorrected value
  with the note that a window bias remains (+7.5 psi in the reference case even with no leak). Prototype: 0.018 / 0.068 / 0.199 bbl/d
  recovered (after the baseline) for 0.02 / 0.07 / 0.2; corrected p_i 4,507–4,508 against 4,461 uncorrected at 0.2 bbl/d (truth
  4,500).
- **Cross-links.** A pre-closure "constant-rate sink" warning (§4.6) and the triage sink check open this plot; a temperature channel,
  when present, is cross-checked (a leak-like trend that follows T is labelled "thermal?").
- **UI:** step ④ ACA sub-view card "Leak check" with `dfitLeakPlot`, the q_k ± CI against q_k,max (✓ / ⚠) with Θ and the regime
  named, the drift estimate and its prior, the corrected p_i and the floor.
- **Tests** (`dfit-aca`): A13 linear rule vs simulation within 15 %; A13b radial case: Θ(t_DL 5) = 4.509 ± 1 % and the simulated bias
  of a 0.02 bbl/d leak in radial flow equals Θ·q_k·t/V within 15 %; A14 leak plot recovers 0.07 bbl/d within ± 0.02 after the
  baseline and reports the floor; A14b drift only (d at the spec, no leak): the verdict is "none" or "leak or drift", never "leak";
  A15 corrected p_i within 10 psi of truth at 0.2 bbl/d.

### 6.5 Pre-job designer

- **Inputs** (`DesignRanges`, §3.7; Tools drawer `PRiSM_renderDfitDesignerTool`, also usable from step ① with no data): k (P10/P90,
  lognormal), φ, c_t, μ_res, h, h_f (barrier spacing), h_p, E′, ν, closure-gradient prior (P50 ± sd), p_i gradient prior, wellbore
  (strings via `WTS_tubulars`, datum TVD, fluid), gauge (surface / BH, σ, resolution, sample rate, drift), planned V and q (or
  "suggest"), allowed shut-in (days), target p_i precision W, optional post-closure re-pressurisation.
- **Ensemble:** 500 seeded Latin-hypercube draws (cap 2,000); each runs the mini-model on the coarse grid (≈ 1.2 ms) → t_c, L at
  closure, η, V_f, the pressure curve (sampled at 60 log times for the corridor). Then the after-closure timing (hours), on the
  statistic the module detects (s_D, §4.12):
  - radial recognisable (s_D ≤ −0.90, t_DL 1.6; a radial line there over-reads kh/μ by ≤ 5 %): **t ≈ 6,068·φμc_t·L²/k**;
  - radial band reached (s_D ≤ −0.93, t_DL 2.32): t ≈ 8,800·φμc_t·L²/k;
  - **confirmed over ½ cycle inside the band (kh/μ ± 2 %): t_shut ≈ 27,800·φμc_t·L²/k** (t_DL 7.34);
  - impulse validity t ≥ 3 t_c; afterflow t ≥ 33,890·C_ac·μ/(kh); signal at radial recognition
    Δp = 0.4468·V/(t_DL·φc_t·h·L²) with t_DL = 1.6 ≥ 35–50 σ_gauge (independent of k);
  - p_i bracket width W: linear t_W = (m_L′/(2W))² with m_L′ = 97.54·(V/A)·√(μ/(kφc_t)), radial t_W = 1,694.5·Vμ/(khW).
  **Recommended shut-in = max(t_shut, 3 t_c, t_ε, t_W)** as P10/P50/P90 with the binding criterion named.
- **Outputs:** outcome label "closure only" / "linear: p_i ± W" / "radial: kh/μ ± x %" (the class reached by ≥ 50 % of draws within
  the allowed shut-in) with a sentence saying the width comes from the k range; t_c P10/P50/P90; V_min ≈ C_ac·(p_c − p_i)/ε_max
  (7.5e-4 × 2,500/0.05 = 37.5 bbl; 19 bbl at ε_max 0.10); predicted R_vis (storage-consistent); vacuum risk ("surface gauge
  sufficient for closure; BH gauge required for ACA"); water-hammer sample rate (≥ 10 per 2L/c); gauge resolution and drift for the
  ACA goal; the leak budget with Θ and the hold time with its temperature-stability requirement (§6.4); a 5-step step-down plan
  (from the treating rate to ≈ 20 %, 10–30 s each); an optional **post-closure re-pressurisation** (0.25–0.5 bbl/min for 1–2 bbl
  after the closure P90, predicted knee ≈ σ_prior + Δp_nwb(q) in 3.4a, from the multi-cycle mini-model in 3.4b) that gives the F4
  reading (§4.15b); pre-job precision from `lkFisher` on the planned schedule (σ(p_i) ± 7.9 / 2.8 / 1.5 / 0.9 / 0.56 / 0.39 psi at
  1.5 / 2 / 3 / 5 / 10 / 20 t_c in the reference, × the n_eff factor); an execution checklist (pressure test, air removal,
  anti-freeze in gauge dead spaces, one clock plus a marker blip, ≥ 60 min concurrent recording with the pump unit, shut-in valve
  on the pump side of the gauge, no step-down when closure, p_i and k are the objectives unless a friction split is needed); the
  **P10–P90 pressure corridor** saved to `st.dfit.plan.corridor` for the live view.
- **Planning reference cases** (afterclosure scripts, recomputed from the s_D thresholds: × 2.10 on the earlier "recognisable"
  times and × 2.45 on the "confirmed" times): conventional oil (k 5 md, L 40 ft, V 10 bbl) radial recognisable 3.6 h, confirmed
  16 h; tight gas (k 0.01 md) 20 d / 90 d with ≈ 0.5 psi signal; shale gas (k 1e-4 md) 7.1 yr / 33 yr → "plan for p_i and bounds on
  k".
- **UI:** a printable `.card` set ("Design basis", "Expected outcome", "Shut-in", "Gauge and sampling", "Checklist") with
  `#prism_dfit_des_*` inputs, `dfitPlan` (corridor and timeline with the regime onset bands), and "Save plan" (to `st.dfit.plan`) /
  "Print checklist" (report capture). Phone layout: one column; the checklist as check-boxes (autosaved as ticks in `st.dfit.plan`).
- **Tests** (`dfit-designer`, `opts:false` shared app, ≤ 3 s): D1 deterministic with seed; D2 conventional / tight / shale reference
  outcomes and times within 5 % of the revised values; D3 V_min formula; D4 vacuum predictor on the reference column (p_s 195 / 96 /
  −3 psia for p_w 4,500 / 4,400 / 4,300); D5 500 draws as a Job stepped synchronously make exactly 500 coarse runs
  (`counts.evals`), sync = job; D6 the leak budget switches from Θ = 2 to the radial Θ when the P90 t_DL(t_end) ≥ 1, and the hold
  card flags the temperature requirement as unrealistic at 100 °F.

### 6.6 Uncertainty budget and what-if propagator

- **Inputs** (each with a distribution and provenance shown next to the results): E′ lognormal (σ_ln 0.15 default), ν uniform
  ± 0.05, h_f triangular (h_p, input, barrier spacing or 1.5 × input), h_p ± 10 %, μ_res / c_t / φ lognormal (0.1 / 0.3 / 0.1)
  (or the tidal c_t distribution when offered, 3.4b), V_w·c_w normal around the ramp value (± 10 %, ± 50 % when only theory),
  tp choice discrete (pump / breakdown / veq, equal weights), ISIP ~ N(consensus, spread/2), p_i from the ACA consensus (normal
  truncated to the bracket). **Closure:** single mode — resampled from the voting families' stability samples; range mode —
  resampled **per family** (F1 and F2 separately, F4 joining the family it agrees with). Rank correlations (Iman–Conover): E′–ν 0,
  φ–c_t −0.3 (editable).
- **Chain per draw** (microseconds, closed form, storage-consistent): G_c(σ_c) by monotone interpolation of p(G); η_G with matched α;
  p_n = ISIP − σ_c; V_i\*(σ_c); C_sys = η_G·V_i\*/p_n; A_f·c_f = C_sys − V_w·c_w; R_vis; c_f by geometry; xf or R; V_f; η_f; widths;
  CL and Γ; k from CL (Δp_CL); after-closure k (linear needs CL; radial from kh/μ); p_i.
- **Range mode (`bimodal:true`)** — no pooled median of a bimodal mixture is ever reported for a closure-dependent output (it can fall
  in the gap between modes and then corresponds to no interpretation):
  - each such output gets **per-family conditional P10/P50/P90** (two columns, F1 | F2) plus the **envelope** [P10 of the low family,
    P90 of the high family]; its pooled p10/p50/p90 fields are `null`;
  - the family weight (`T.inputs.options.familyWeightF1`, default 0.5) is an explicit, logged user input labelled **"interpretive
    weight, not a probability"**; it affects only the envelope shading and the share split, never the per-family columns;
  - the **interpretation share** (closure family) is reported apart from the parametric shares;
  - outputs that do not depend on the closure (late radial kh/μ, p_i) keep a single P10/P50/P90.
- **Shares:** first-order variance index S_i = Var(E[Y|X_i])/Var(Y) estimated by binning X_i into 20 quantile bins (no extra runs),
  computed within each family in range mode; the closure (interpretation) share is shown apart from the parametric shares. Tornado:
  one-at-a-time P10/P90 of each input (per family in range mode).
- **What-if marker:** dragging it on the strip recomputes the fast pipeline for that closure (`opts.whatIf`), updates the
  frac-outputs card, the rail (labelled "what-if") and the frac-design sheet preview, and releases back to the chosen closure on
  Escape or "Reset". It lives on `st._dfitWhatIf` only.
- **UI:** step ④ "Uncertainty" sub-view: an outputs `table.dtable` (P10 / P50 / P90 / unit / largest driver / Ev.; in range mode
  F1 P10–P50–P90 | F2 P10–P50–P90 | envelope), per-output share bars (inline in the table for report capture), the tornado
  (`table.dtable` with inline bars), the seed, n and the family weight (`#prism_dfit_unc_n`, `#prism_dfit_unc_seed`,
  `#prism_dfit_unc_wf1`), "Re-run" `#prism_dfit_unc_run`.
- **Tests** (`dfit-uncertainty`, `opts:false` shared app, ≤ 2 s): U1 determinism (seed); U2 with all inputs fixed and a single
  closure, P10 = P50 = P90 equals the deterministic chain (including C_sys, A_f·c_f and R_vis); U3 the range case gives
  `bimodal:true`, **no pooled P50** for closure, xf, η, pn or CL (fields `null`), per-family columns that contain each family's
  deterministic chain, and an interpretation share > 60 %; U4 shares sum within [0.8, 1.2] on an additive test function; U5 1,000
  draws make exactly 1,000 chain evaluations (`counts.draws`) and scale linearly (2,000 draws < 2.5 × the work); U6 changing the
  family weight changes neither per-family column and logs one entry.

### 6.7 "What this test can tell you" card

- **Per parameter** (from the history-match Fisher matrix with priors, inflated by √(n/n_eff) and widened by the structural spread):
  "determined ± x" when the inflated relative CI < 25 % (log parameters) or < max(25 psi, 1 % of value) (pressures); "determined only
  as a group" when the parameter loads > 0.3 on a sloppy eigenvector (λ_min/λ_max < 1e-4); otherwise "not determined by this test".
  Wording is constructive ("…; a log-derived height would determine it").
- **Next best information:** F_k = F + ΔF_k for: height from logs ± 10 %, E′ from core ± 15 %, offset p_i ± 50 psi, a gauge with half
  the noise, a longer shut-in (Jacobian on a time grid extended with the model forecast). Ranked by the reduction of gᵀF_k⁻¹g for the
  outputs that matter (σ_c, p_i, k, CL). A 1-D profile on σ_c (≈ 10 refits, Job, on demand) checks the linearised interval.
- **Extend-the-shut-in table** for 0.5, 1, 2, 3, 5, 7, 14 days: σ(p_i) (Fisher, inflated), the k range from the §4.12 bounds with the
  forecast D, and P(radial) = share of designer/uncertainty draws with t_DL(t_end) ≥ 1.6; a "keep or pull the gauge" sentence.
- Works before the job on the planned schedule (noise-free synthetic data from the designer base case).
- **UI:** step ④ "What this test can tell" sub-view; plain sentences (`.rbox` rows), the ranking (`table.dtable`), the extension
  table.
- **Tests** (`dfit-leakfit`): LF4 the group sentence appears for run B (E′ and h_f free) with Γ_PKN = 14.904 ± 1e-3 and Γ quoted in
  psi/√min; LF5 the extension table reproduces the §6.5 σ(p_i) sequence within 10 %; LF6 the ranking puts "longer shut-in" first for
  run F (data to 1.5 t_c).

### 6.8 After-closure match with the PRiSM model library, and the hand-off packet

- **Transform:** for t′ ≥ 3 t_c from the centroid origin, the constant-rate-equivalent derivative is y(t′) = t′·(p − p_i)/(24·V)
  (psi per STB/d); the p_i-free form is t′²·|dp/dt′|/V·(1/24) = Δp′_u·(1 − d ln Δp′_u/d ln t). y is flat for radial, +½ for linear,
  +¼ for bilinear, so any PRiSM model's pd′ applies.
- **Match:** p_model(t′) = p_i + 24·V·Δp′_u(t′)/t′ with Δp′_u = (141.2·μ/(kh))·pd′(t_D), t_D = 0.0002637·k·t′/(φμc_t·L²), pd′ from
  `PRiSM_MODELS[key].pdPrime` (Stehfest weights reused); p_i solved linearly for each (k, L, shape) by variable projection and
  bounded by the bracket; k and L (and shape parameters such as FcD) by `PRiSM_lm` (log keys) on ≤ 120 log-spaced points;
  candidates `infiniteFrac` (uniform flux), `finiteFrac`, `homogeneous`, `radialComposite`; BIC selection; CIs from the Jacobian plus a
  profile on L when only linear flow is present. Gas: in adjusted variables.
- **Hand-off packet** (`PRiSM_dfit_handoff(run, target, {family})`): PTA `setWell {testType:'falloff', tShut: ts, tp: tp_veq, pwf0:
  ISIP, pi}` (pi only when its label is ≥ medium; otherwise listed as a blocker the user can override), `multiRate` idealised schedule
  at q_eq = (V_i − V_fill − V_fb)/tp_veq (the wellbore-compression volume is part of the impulse, §4.3), model by regime, seeds
  `{xf: geometry P50 or match L, k: match k or kh/μ·μ/h}`; RTA `{k, kLo, kHi, source}`; frac sheet rows. Confirm dialog lists every
  change and blocker; the transient-mode C3 then floats xf, k, S.
- **UI:** step ④ ACA sub-view "Model match" card: model check-boxes, "Match" `#prism_dfit_aca_match`, the `dfitCrDeriv` plot (y and
  the model on log-log), a results `.rbox`; hand-off buttons `#prism_dfit_to_pta`, `#prism_dfit_to_rta`, `#prism_dfit_frac_csv`.
- **Tests** (`dfit-aca`): A10 the transform reproduces 1,694.5 on example A late data (± 0.5 %); A11 `infiniteFrac` match recovers k
  0.0100 ± 5 % and L 50 ± 10 ft on example B and keeps p_i inside the bracket; A12 BIC picks `homogeneous` on example A late data;
  `dfit-integration` I3 the PTA hand-off sets falloff, tShut, tp, pwf0, multiRate (with q_eq), model and seeds, and transient C2 sees
  Δp > 0 for ≥ 95 % of the falloff points; I15 after the hand-off the transient radial kh/μ equals the ACA kh/μ within 2 %. This item is
  parity-plus (§1.5): new are the p_i-free transform and the bracket-bounded variable projection.

### 6.9 Live co-pilot and replay

- **Engine** (`PRiSM_dfit_live`, 57, pure; uses the pipeline's stage functions incrementally): an O(1) pressure-increment
  resampler (keep a sample when |p − p_last| ≥ dpMin or Δln Δt ≥ 0.01), closed-form G per sample, a two-pointer Bourdet window; ISIP
  from the first minutes (G extrapolation; hammer with the bleed term when ≥ 2 Hz); a forecast before closure
  G_c = (ISIP − σ_prior)/m_G, Δt_c = tp·G⁻¹(G_c) with σ_prior ± 0.02 psi/ft (or the designer's prior); after closure the p_i bracket
  and t_W; optionally a warm-started 3-iteration mini-model re-fit (k, σ_c, p_r; ≈ 50 ms) per block for the radial-onset forecast.
- **Closure detection** after the dP/dG minimum, on **pressure residuals** r_k = p_k − (ISIP − m_G·G_k) from the fitted early G line
  (not on G·dP/dG, whose Bourdet residuals share ≈ 10 points per window at the live resampling and are strongly serially
  correlated). The residuals are made close to independent by one of two means, chosen by the data:
  - **decimation** to one point per 2L in ln G (L the Bourdet window), the default;
  - **prewhitening** with the estimated lag-1 coefficient ρ̂1 of the pre-departure residuals:
    z_k = (r_k − ρ̂1·r_{k−1})/(σ·√(1 − ρ̂1²)), used when the decimated series is too short (< 30 points before the departure).
  σ includes the early-line parameter variance at G_k (σ² = σ_r² + Var(ISIP) + G_k²·Var(m_G) + 2G_k·Cov), so the line's own
  uncertainty does not read as a departure. One-sided CUSUM S_k = max(0, S_{k−1} + z_k − k), k = 0.5, "provisional" at S_k > h = 5;
  "confirmed" when the departure is held ≥ 0.05 log G with ≥ 0.3 G-decade of data after it. The tile names the family: "contact
  reading (family F1) provisional / confirmed"; the end-of-stiffening reading (F2) is confirmed separately when dP/dG falls back
  below the tangent line; when the board would show a range, the tile shows both. (k, h) and the decimation rule are calibrated in
  3.4b so that false early calls are ≤ 5 % on the benchmark replays.
- **Verdict tile** (states, `LiveVerdict`): "continue: closure expected in 2.5–8.6 h" / "contact reading (F1) provisional at 7,010
  psia" / "contact reading (F1) confirmed: 7,000 psia (medium)" / "enough for p_i ± 25 psi" / "radial flow not reachable in the
  allowed time: plan for bounds on k" / "outside the designer corridor: check the gauge" (data outside P10–P90 for > 10 % of the last
  log cycle).
- **Replay** (engine 3.4a; timeline UI 3.4b): feeds a recorded dataset to the same engine in time order (synchronously in tests, as
  a Job in the UI) and records each verdict transition. 3.4a shows a "first available" table in the Replay tool ("contact reading
  confirmed at 7.2 h; p_i ± 25 psi at 3.1 d; the test ran 9 d"); 3.4b draws it as a conclusion timeline under `dfitHistory`.
- **Live listeners (3.4b, `59-prism-dfit-live.js`):** the Live tool lists `WTS_modbus.getTags()` and historian tags (resolved per
  call) for pressure (BH or surface), rate and temperature (`st.dfit.live.tags`); on `wts:modbus-samples` / `wts:historian-updated`
  (document), matching samples (psig → psia) are appended to the session and, if no job is running, one drive job processes the
  pending block (no other timer). Back-fill of the minutes before the tool opened uses `WTS_buildup.data.fromHistorian` (v3.3,
  resolved at call time), then `PRiSM_dfit_resample`. The listeners and the session are released on tool close, mode leave,
  `h2oil:pagechange` (PRiSM root disconnected), `wts:project-new` and `wts:project-loaded` (§3.10). Surface data go through
  `WTS_wellbore.convert` with the last known column. Tap-to-log buttons (pump on/off, leak, rig-out, note) write `PRiSM_addEvent`
  entries (`note` / `open` / `close` types) on the data clock. 390 px layout: the verdict tile on top (≥ 44 px targets), the live
  plot inside the corridor, a loupe for picks. The rail reads the live verdict through `PRiSM_dfit_hooks.liveVerdict`.
- **Tests** (`dfit-live`, WP3, `opts:false` shared app, ≤ 3 s; data built inline from `PRiSM_dfit_vcModel` plus `PRiSM_rng` noise,
  so WP3 does not wait for WP5): V1 replay of a noisy reference-like falloff: provisional within 2 % of t_c after closure, confirmed
  before 1.5 t_c; V2 the forecast band brackets the true t_c; V3 the session handles out-of-order and duplicate samples; V4 psig
  samples are converted; V7 on AR(1) noise with ρ1 0.9 the decimated statistic has lag-1 autocorrelation < 0.3 and the prewhitened
  one < 0.1, and 5 seeds give no provisional call before t_c (the 20-seed false-call replay runs in `dfit-validate.js --quick`).
  3.4b (`dfit-livelisten`, WP9): V5 listeners are released on route leave, project New and project Open, and zero timers remain
  (`pendingTimers() === 0` after `flush(5000)`); V6 a synthetic `wts:modbus-samples` stream drives the tile through its states.

### 6.10 Evidence column, pick log, quoted-value self-check, data + picks export, grade

- **Evidence groups** (our own scheme, letters chosen so they do not clash in meaning with the build-up report): Q quality/triage,
  X conversion, E events, I ISIP, H water hammer, S step tests and ramps, G pre-closure derivatives, C closure (per family/method), K
  confidence rules, M mechanism (leak-off type), F fracture outputs, A after-closure, L leak-off model, U uncertainty, P plan, O
  overrides. Ids are `<group><n>` assigned in a fixed order by `PRiSM_dfit_evidence`; each item holds the values it quotes with their
  display precision and a path into the run.
- **In the app**, evidence ids are small buttons after a value ("chips") that open the plot and window behind the number. **In the
  report** they appear only as an "Ev." column in tables and an **evidence appendix** (one row per id: group, title, values, the plot
  or rule it came from); no inline `[C1·C2·K1]` text in `.rv` values, PDFs or Quick Report snapshots.
- **Quoted-value self-check:** `PRiSM_dfit_checkQuoted` recomputes each quoted number from the run and fails when |quoted −
  recomputed| > half a unit in the last displayed digit. Because the report is generated from the same run, it is a test and a
  self-check, not a user-facing feature: the report prints nothing when it passes and a ⚠ line listing the failures when it does
  not (R2 checks both).
- **Pick log:** append-only `{seq, at, who, item, old, new, reason}` for every user pick, override, blunder fix, channel fix, tp/α
  choice, family-weight change, test switch and hand-off; undo restores decisions but appends an "undo" entry rather than deleting
  history; capped at 300 per test (older entries condensed into one summary entry).
- **Data + picks export** (`PRiSM_dfit_exportText(run, template)`): a plain ASCII file with a header block (well, test, zone, datum,
  gauge, fluid, inputs and their provenance, app version, input/result hash16 when available), the events, every pick with method
  and band, the closure decision and log, the results with P10/P50/P90 (per family in range mode), the grade, then the resampled data.
  The column layout comes from a template `{columns, header, sep, decimals}`: the default (t h, p psia, q bbl/min, before/after-closure
  flag) or a user template saved in the report options (for a regulator's or a client's submission layout). Filename
  `dfit-<name>-<hash8>.txt`.
- **Grade:** the A–D grade of §6.3 is printed in the report header and the key rows with its reasons.
- **Tests** (`dfit-report`, `opts:false` shared app, ≤ 2 s): R1 every headline number has ≥ 1 evidence id and the appendix lists
  every id used; R2 the quoted check passes on the reference (the report contains no check line) and fails on a tampered model (one ⚠
  line naming the value); R3 the report model lists the pick-log entries of `FIX.state` in order with their reasons; R4 the export
  contains the events, picks and the resampled data and parses back to the same t/p arrays (± display precision); R5 frac sheet rows
  and CSV columns, with both family columns for the range test of `FIX.state`; R6 hand-off packet with a low-confidence p_i lists it
  as a blocker and its `qEq` equals (V_i − V_fill − V_fb)/tp_veq; R7 a custom export template reorders and renames the columns;
  R8 no `.rv` text in the report model contains an inline evidence bracket.

### 6.11 Interpretation lenses (3.4b stretch, `59-prism-dfit-lenses.js`; first to cut)

- Two or three read-only, cited lenses, each a complete calculation chain with its own closure family and efficiency/geometry
  conventions: **contact chain** (F1 closure; matched-α η; CL and geometry from it), **tangent chain** (F2 closure; G_c/(G_c + 2)
  η; its conventional CL and geometry), **global-model chain** (the mini-model fit's σ_c and its own outputs). Lenses are labelled by
  method, never by person or school; their help text cites McClure et al. 2016 (SPE 179725), Barree, Barree & Craig 2009
  (SPE 107877), Nolte 1979 (SPE 8341) and Liu & Ehlig-Economides 2015 (SPE 174906).
- Compare view: outputs side by side and an exact Shapley breakdown of each difference over ≤ 4 elements (closure, efficiency
  formula, geometry convention, ISIP). The pure chain-compare part (`PRiSM_dfit_lenses`) touches no DOM; the card is in the same file.
- Tests (`dfit-lenses`, stretch): the Shapley parts sum exactly to the difference; switching lens never changes stored picks.

### 6.12 Several DFITs per well and calibration outputs (3.4a; 59 + 56)

- **Tests in this well** (`dfit-tests` panel, tab 1): one row per `st.dfit.tests[i]` — zone, datum TVD, dataset name and hash
  status, ISIP and closure gradients (both family medians in range mode), p_i gradient, grade; "Add test" (new test bound to a new
  dataset or a gauge-manager record), "Open" (makes it active; loads its dataset through `dsRef`; undoable and logged), "Delete"
  (confirm). The 3.4a UI analyses one active test at a time; inactive tests keep their summaries.
- **Gradient vs depth** (`dfitStress`): closure (both families as a bar when a test shows a range), ISIP and p_i (or their
  gradients) against TVD for every test, with the hydrostatic, the prior stress-gradient band and the overburden lines; stress
  contrast between adjacent zones printed when two tests bracket a barrier ("Δσ = 640 ± 90 psi between zones B and C"). No pooling,
  depletion logic or gradient fit until R2.
- **Overlay** (`dfitOverlay`): the stored `summary.gdpdgN` curves (G·dP/dG normalised by m_G·G against G/G_c) of two or more tests
  on one plot, so contact and recession signatures can be compared without recomputing inactive tests.
- **Stress-log calibration offset** (per closure family, at the datum; rail rows and frac sheet): Δσ_tect = σ_c − [ν/(1 − ν)·(S_v −
  α·p_p) + α·p_p], with α the Biot coefficient (`rock.biot`, default 1, editable), S_v from `rock.sigmaVGrad`, p_p = p_i (ACA) or the
  prior; both family columns in range mode. It is the number a geomechanics model needs to calibrate its stress log, and it makes the
  closure dispute's downstream effect explicit.
- **Pad fraction** from η (per family): f_pad = (1 − η)/(1 + η) and the (1 − η)² variant shown as a range ("Nolte's rule", Nolte
  1986, cited by author, year and title until the SPE number is verified); reference η 0.900 → 0.053–0.010. Labelled indicative.
- **Tests:** `dfit-ui` U15 (tests table, add/open/delete with undo; the overlay draws two stored curves), `dfit-integration` I16
  (two stacked tests on two demo datasets: switching keeps each test's picks, the gradient plot shows both, reload restores both);
  `dfit-preclosure` P19 (stress-log offset and pad fraction on the reference: Δσ_tect for ν 0.25, α 1, S_v 1.0 psi/ft, p_p 4,500 is
  7,000 − [(1/3)·5,500 + 4,500] = 667 psi).

### 6.13 DFIT method notes (help; `49-calc-dfit-info.js`, WP6)

- `WTS_dfitInfo`, modelled on `WTS_cheminjInfo`: a modal `<dialog id="wts_dfit_info" class="rp-skip" data-rp-nosnap>` (never captured
  by reports or autosave), opened from "Why this pick?" (§6.2), the strip legend, the classifier card and the Tools entry "Method
  notes".
- One neutral note per method and family (tangent, √t, max dP/dG, compliance, compliance drop, log-log departure, variable
  compliance, model closure, fissure closure, reopening; families F0–F4; the leak-off types; the after-closure regimes): assumptions,
  the failure modes of §4.7's matrix, what would distinguish it from the competing reading, citations by author / year / title / SPE
  number (no "no. to verify" numbers). Notes are labelled by method, never by person or school, and present the dispute as open.
- WP7's neutral-wording review covers every note. Test: `dfit-ui` U16 (every pick method has a note; the dialog carries `rp-skip`
  and `data-rp-nosnap`; no note contains a product, vendor or company name from the review list).

---

## 7. User interface (59, WP6)

All DFIT element ids start with `prism_dfit_`. Numeric inputs are parsed with `WTS_parseNumber` and clamped to the §3.2 range table
on read (blank, 0, −1 and 1e12 never hang or produce NaN text; counts are integers with hard caps). Two-value quantities are two
inputs. All labels state field units. Controls are plain `input` / `select` (no `WTS_units.tagInput`). A button that needs data
it does not have stays enabled and shows a ⚠ reason when pressed ("Load a DFIT first", "No high-rate window"), so the GUI sweep sees
an effect.

### 7.1 Entering DFIT mode

- Header `#prism_testtype` gains "DFIT (fracture injection)". Selecting it calls `setMode('dfit')`; `ext.onEnter` sets the test type,
  creates or binds the active test, writes the schedule (when a dataset exists) and opens step ①. The crumb reads "PRiSM · DFIT"
  (with the zone when the well has several tests).
- With no dataset, step ① shows "Load a DFIT", "Build from gauge records" (v3.3 chunked parser, or 19), "Load demo DFIT"
  `#prism_dfit_demo` (select: reference / tight linear / conventional radial / contact / PDL / surface gauge / two-cycle) and "Plan a
  DFIT" (opens the designer) and "Leak-off sandbox" (opens step ④ → Leak-off model). The sandbox and designer work without data.
- The Tools-drawer entry "Leak-off sandbox" is registered with `modes:'*'`: from transient, decline or combined mode it switches to
  DFIT mode (one undo step) and opens step ④ → Leak-off model, so the requested mini-model is one click from any PRiSM view.
- `#prism_units_note` shows in Metric mode exactly as in transient mode.

### 7.2 Step ① Data & events

Tab 1 (the existing Data tab: loader, column mapper with the new roles, crop) plus four panels:

- **`dfit-tests` "Tests in this well"** (§6.12): the tests table, add / open / delete, the `dfitStress` and `dfitOverlay` plots when
  the well has two or more tests.
- **`dfit-well` "DFIT well, wellbore and fluid"** (`.card` / `.fg-item`): datum TVD `#prism_dfit_datum_tvd` (required), datum MD,
  survey (paste box `#prism_dfit_survey`, "vertical" check-box), BH gauge TVD/MD, strings table (rows: tubular select from
  `WTS_tubulars` `#prism_dfit_str_<i>_key`, ID, top/bottom MD; + / − buttons), fluid select `#prism_dfit_fluid` (water / slickwater /
  gel / oil) with ρ (ppg), salinity, μ (cp), FR %, n′/K′ (gel), injection T; temperature model `#prism_dfit_tmodel` (static /
  displaced), surface T, gradient (°F/100 ft), τ_T low and high (two inputs); perforations (shot holes, d, C_d); rock E′ (1e6 psi)
  with source select (static / dynamic-corrected / dynamic / unknown), ν, h_f, h_p, barrier spacing, overburden gradient and its low
  value, friction coefficients (warning, veto), Biot coefficient; system compressibility and V_w·c_w (theory, ramp, hammer side by
  side); reservoir block (p_i, φ, c_t, μ_res, h, T, fluid; read from and written to C1 with provenance badges "default / user /
  dfit / sample"). Missing required inputs show ⚠ lines, never NaN.
- **`dfit-channels` "Channels and bottomhole conversion"**: primary channel select `#prism_dfit_primary` (BH / surface), psig
  check-boxes per channel (showing which channels 07 already converted), atmospheric pressure (applied as a difference to 07's
  14.696), clock offset (auto / manual, "Apply" after confirmation), masks, applied blunder fixes with "undo fix", conversion summary
  (`.rrow`: hydrostatic, friction at q_last, band width at shut-in), `dfitConv` plot (surface, converted BHP with band, BH when
  present), vacuum ⚠. Every change writes `T.inputs.channels`, never the dataset.
- **`dfit-triage` "Test triage"** (§6.3) with the grade and the `dfitGradient` plot.
- **Events** are shown on `dfitHistory` (p, p_surf, q, T; event markers). Detected events can be dragged (pointer-owner) or typed in an
  events table (`#prism_dfit_ev_tstart`, `_tb`, `_ts`, flowback); overrides go to `T.inputs.events`; tp choice `#prism_dfit_tp` (pump
  / breakdown / volume-equivalent) with the G_c / η sensitivity line; α select `#prism_dfit_alpha` (auto / ½ / 1 / general /
  data-driven).

### 7.3 Step ② ISIP & friction (step view)

- **ISIP card**: the four candidates (`table.dtable`: method, family, value, se, status — accepted / upper estimate / failed — and the
  bleed-off at the end of the fit window), the consensus with spread and label, a verdict line, and "Use another ISIP" (override with
  reason). `dfitIsip` plot: early falloff on G with the extrapolation line, the hammer midline with its bleed-off term and the
  step-down intercept marked.
- **Water-hammer card** (only when a high-rate window exists; otherwise "Water hammer not resolvable at 1 Hz: record ≥ 2.3 Hz at the
  wellhead"): `dfitHammer` (window with the fitted damped sinusoid plus bleed-off), period, regime, reflector depth vs perforation
  MD, Joukowsky check, V_w·c_w from the period when a reflector is known, hammer end time (sets G_min).
- **Step-down card** (when steps fall): `dfitStepDown` (p vs q with the fitted curve and the perforation / tortuosity split), the
  results table (p_frac, a, b, β, se), open perforations P10/P50/P90 with driver, label, refusal reasons, and the predicted friction
  bleed-off curve drawn on the early falloff.
- **Step-rate card** (3.4a, when steps rise): `dfitStepRate` (end-of-step p vs q with the hinge, FEP and its band; unstabilised steps
  hollow), the stabilisation table (step, q, p_end, projected drift, status), the F-test result and "no break" when it fails. The
  3.4b Tools entry adds the superposition parting and the Hall plot.
- **Cycles / reopening card** (when a later cycle, a pump-in or a LOT ramp exists): `dfitCycles` (p vs pumped volume per cycle with
  the wellbore line, the knee and its band, the falloff families on the pressure axis), the reopening pick (family F4, corrected or
  "upper-side"), the LOT leak-off point for kind `lot`, and the ramp V_w·c_w used by triage.
- **Injection net pressure** (BH gauge only): `dfitInjNet` (log-log net pressure vs time since breakdown with slope guides ¼, 0, −¼,
  1), labelled "indicative".

### 7.4 Step ③ Pre-closure (tab 2)

- The plot picker (mode-filtered) shows `dfitG` (default), `dfitSqrt`, `dfitLogLog` (PPD toggle), `dfitCompliance`, `dfitH` (after
  gate G6), `dfitPdpdt`, `dfitHistory`, `dfitGradient`, `dfitStrip`. The smoothing-L input stays (it sets `T.inputs.options.L`);
  period picker, time-function select and overlay are hidden (`ext.plotsTab.hide`); "lock axis" `#prism_dfit_axislock` and PPD
  `#prism_dfit_ppd` toggles. "Reset view" and zoom work as today.
- Panels: `dfit-board` (closure strip, label, why + method notes, counterfactual sentence, stability, override), `dfit-classify`
  (type, scores, alternatives, evidence sentences, κ against κ_exp, PDL and height-recession numbers, the constant-rate-sink warning
  when it fires), `dfit-frac` (η_G with the α pair whenever it changes η by > 0.01, η_f, pn, χ, gradients, C_sys, A_f·c_f, R_vis, Γ
  with the conditional CL and Γ_PKN, geometry with the automatic choice and messages, spurt note, before-closure k estimates with
  their bias factors, far-field extension pressure (informational), leak-off-rate table and `dfitQL`, closure forecast when not
  reached, thermal sensitivity, pad fraction and stress-log offset), `dfit-whatif` (one row per candidate: family, method, σ_c, G_c,
  Δt_c, η (½, 1), pn, χ, R_vis, CL, xf/R, w̄, q_L at closure; the α pair always shown here).
- The existing `linetools` panel shows the DFIT tool group for the active plot.

### 7.5 Step ④ After-closure & model (step view with a segmented control `#prism_dfit_s4_tabs`)

- **After-closure**: origin select `#prism_dfit_aca_origin` (centroid / total / mid-injection / since closure), L_B, F_R form
  (`#prism_dfit_aca_frc` Carter-exact, default with the centroid origin), tide removal (auto / on / off), gas (auto; iteration count
  shown); plots `dfitAcaLogLog` (Δp and D vs t − t0, PPD toggle, regime bands on s_D, noise band, bracket shading), `dfitFlowDim`,
  `dfitFL` / `dfitFR` (Cartesian with lines and brackets), `dfitImpLin` / `dfitImpRad`, `dfitPiTraj`; tables: brackets (method /
  lower / upper / edge), p_i consensus with label, kh/μ and k with the bias direction, bounds (method / value / direction ≤ ≥ ≈ /
  binding / Ev.), A_ACA/A_Carter and λ, ε; cards "Model match" (§6.8) and "Leak check" (§6.4); hand-off buttons (family choice in
  range mode).
- **Leak-off model**: §5.6 (sandbox) and §5.7 (history match: preset select `#prism_dfit_lk_preset`, "Fit" `#prism_dfit_lk_fit`,
  progress and Cancel, results with CI and inflated CI, structural spread button, Γ sentence, residual plot `dfitLkRes`).
- **Uncertainty**: §6.6 (per-family columns in range mode).
- **What this test can tell**: §6.7.

### 7.6 Step ⑤ Report (tab 7)

The PRiSM report view in DFIT mode: header from `ext.reportHeader` (title "DFIT interpretation — <well> · <zone>", key rows: ISIP,
closure (value, or range with medians, + label), closure gradient, pn, η, Γ/CL, xf, p_i, kh/μ or k range, grade), the DFIT sections
(§2.10), the report-options panel `dfit-report-opts` (groups on/off, per-family columns, include pick log, include data + picks
appendix, export template, analyst name), and the export buttons (PDF, CSV, data + picks ASCII, frac-design CSV).

### 7.7 Tools drawer (registered through `PRiSM_toolCatalogueExtra`, group "DFIT")

| Tool | Function | Modes | Increment |
|---|---|---|---|
| Leak-off sandbox | `PRiSM_renderDfitSandboxTool` (switches to DFIT mode, step ④ → Leak-off model) | `'*'` (every mode) | 3.4a |
| DFIT designer (pre-job) | `PRiSM_renderDfitDesignerTool` | dfit | 3.4a |
| Replay a recorded DFIT | `PRiSM_renderDfitReplayTool` ("first available" table; timeline on `dfitHistory` in 3.4b) | dfit | 3.4a |
| Water hammer (detail) | `PRiSM_renderDfitHammerTool` | dfit | 3.4a (MOC fit 3.4b) |
| Method notes | `PRiSM_renderDfitNotesTool` (opens `WTS_dfitInfo`) | dfit | 3.4a |
| Live DFIT co-pilot | `PRiSM_renderDfitLiveTool` (`59-prism-dfit-live.js`) | dfit | 3.4b |
| Step-rate superposition & Hall | `PRiSM_renderDfitStepRateTool` (`59-prism-dfit-fieldtools.js`) | dfit | 3.4b |
| Flowback & pulses | `PRiSM_renderDfitFlowbackTool` (`59-prism-dfit-fieldtools.js`) | dfit | 3.4b |

37's `listTools` marks every one of these functions as seen before the mode filter, so none appears again under "More".

### 7.8 Rail in DFIT mode

Rows (each with its evidence chip and label colour): test selector (zone) when the well has several tests; ISIP ± spread; closure
value or range + label, with both family medians in range mode (+ "user override" / "what-if" badges); closure gradient (psi/ft and
ppg equivalent, with a copy button); pn; η (α); Γ and CL (conditional); xf or R (model); p_i + bracket + label; kh/μ or
[k_lo, k_hi]; triage light and grade; stress-log offset (per family); live verdict (3.4b, through `PRiSM_dfit_hooks`); "results
stale — ▶ Analyse" when `summary.stale`, "decisions belong to another dataset" when `summary.forOtherDataset`. Below 1,024 px the
rail is the existing bottom sheet.

### 7.9 Plots (registry key → content; all `mode:'dfit'`, `kind:'dfit'`, real `fn`, drawn with `PRiSM_drawPlot`, picks via `dfit-picks`)

| Key | x | y (left / right) | Overlays | Step |
|---|---|---|---|---|
| `dfitHistory` | t (h) lin | p, p_surf (psia) / q (bbl/min), T | events, usable windows, replay timeline (3.4b), live corridor (3.4b) | ① |
| `dfitConv` | t lin | p_s, converted p_w with P10–P90 band, BH | vacuum time | ① |
| `dfitGradient` | t lin | p_w/TVD (psi/ft) | p_i gradient, prior band, overburden, ISIP and closure gradients | ① |
| `dfitStress` | gradient or pressure | TVD (ft, down) | every test's closure (family bar), ISIP, p_i; hydrostatic, prior band, overburden | ① |
| `dfitOverlay` | G/G_c lin | G·dP/dG ÷ (m_G·G) | one curve per test | ① |
| `dfitIsip` | G lin | p | extrapolation line, hammer midline with bleed-off, step-down intercept | ② |
| `dfitHammer` | t (s) lin | p (psia) | fitted damped sinusoid plus bleed-off, period marks | ② |
| `dfitStepDown` | q (bbl/min) lin | p_settled | fit curve, perforation / tortuosity split | ② |
| `dfitStepRate` | q (bbl/min) lin | end-of-step p | hinge, FEP band, unstabilised steps hollow | ② |
| `dfitCycles` | pumped volume (bbl) lin | p | wellbore line, knee and band per cycle, closure families on the p axis | ② |
| `dfitInjNet` | t − t_b log | p_n,inj log | slope guides | ② |
| `dfitG` | G lin | p / dP/dG, G·dP/dG | early line, tangent, compliance line, hump shading, picks, consensus band; derivative range after G_min | ③ |
| `dfitSqrt` | √Δt (min^½) lin | p / dP/d√t, √t·dP/d√t | picks | ③ |
| `dfitLogLog` | Δt (min) log | ISIP − p, D (PPD optional) log | Nolte reference Δp_ref and D_ref, picks | ③ |
| `dfitCompliance` | p (psia) lin, decreasing | C_rel (and C_sys) | onset and floor | ③ |
| `dfitH` | h lin | p / dP/dh, h·dP/dh | picks (after gate G6) | ③ |
| `dfitPdpdt` | \|dp/dt\| lin | p | slope break (F0 row reading) | ③ |
| `dfitStrip` | p (psia) lin | families (rows F0–F4) | bars, dots, range with medians, two frictional lines, what-if marker | ③ |
| `dfitQL` | Δt (min) log | q_L (bbl/min) / V_L (bbl) | closure | ③ |
| `dfitAcaLogLog` | t − t0 (h) log | Δp, D (PPD optional) log | regime bands on s_D, noise band, slope guides −½, −¾, −1, −³⁄₂ | ④ |
| `dfitFlowDim` | t − t0 log | n(t) | bands 1, 1.5, 2, 3 | ④ |
| `dfitFL`, `dfitFR` | F_L, F_Rc (F_R optional) lin | p | lines, intercepts, bracket | ④ |
| `dfitImpLin`, `dfitImpRad` | (t − t0)^−½, (t − t0)^−1 | p | lines | ④ |
| `dfitPiTraj` | t − t0 log | p_i bracket band and trajectory | consensus | ④ |
| `dfitCrDeriv` | t − t0 log | t·(p − p_i)/(24V) log | model curve | ④ |
| `dfitLeakPlot` | t′ lin | y_lin or y_rad | regression line with the drift term | ④ |
| `dfitLkP`, `dfitLkQ`, `dfitLkG`, `dfitLkGeom`, `dfitLkRes` | t, t, G, t, t | model vs data; partition stack; G family; L, w̄; residuals | — | ④ |
| `dfitPlan` | t (h, d) log | corridor P10/P50/P90 | regime onset bands, shut-in recommendation | tools |
| `dfitHall`, `dfitFlowback`, `dfitStepRateSP` | — | — | — | 3.4b tools |

### 7.10 Picks and interactions

- Click tools (§2.7) and drag handles commit through `PRiSM_dfit_setPick`, which appends to the log, fires `prism:dfit-updated`
  (37 records the undo snapshot on it) and runs the fast pipeline (≈ 50 ms) so all plots, the rail and the what-if table update at
  once; bands refresh on the next ▶ Analyse (the rail shows "bands stale").
- Escape cancels an armed tool or a drag. Ctrl/Cmd-Z and Ctrl-Y undo picks (via `PRiSM_undoExtras.dfit`); after an undo the step
  view re-renders (37 calls `PRiSM_refreshShell()`).
- The override dialog `#prism_dfit_override` (modal `<dialog>`, `.rp-skip data-rp-nosnap` so it is neither captured nor autosaved)
  asks for the value, method or family and a reason (required).
- Linked cursor across the visible DFIT canvases through `prism:plot-hover` and `PRiSM_plot_overlay`.

### 7.11 Verdict lines (plain text, each under 300 characters; numbers filled from results)

| Code | Level | Text |
|---|---|---|
| TRIAGE_OK | ✓ | Test interpretable (grade A): all data-health checks pass. |
| TRIAGE_VACUUM | ✗ | Surface pressure reaches 0 psig at 31.2 h: converted data after that time are not used. Closure is unaffected; p_i needs a bottomhole gauge. |
| TRIAGE_AIR | ⚠ | The pre-breakdown ramp and the water-hammer period both show a wellbore 3.1× softer than the model: air or gas in the well. Closure visibility may be low. |
| BLUNDER_PSIG | ⚠ | The surface channel reads 0.2 psi before pressure-up with the well open to atmosphere, so it is probably psig: add 14.7 psi or confirm the data are absolute. |
| ISIP_LOW | ⚠ | ISIP methods disagree by 46 psi (low): the step-down intercept is the outlier; the steps may be unsettled. |
| ISIP_UPPER | ⚠ | The water-hammer ISIP 7,640 psia is an upper estimate: the friction bleed-off had not died out at the end of the fit window (38 psi predicted). |
| CLOSURE_SINGLE | ✓ | Closure 7,000 psia (0.700 psi/ft), high confidence (uncalibrated rule label): both method families agree within 12 psi (tolerance 21 psi). |
| CLOSURE_RANGE | ⚠ | Closure range 6,495–7,004 psia (medians 6,507 and 6,998; medium): the contact and end-of-stiffening readings differ by 491 psi; every downstream number is shown for both. |
| CLOSURE_NONE | ⚠ | No closure yet: dP/dG has not departed. Forecast with a 0.70 ± 0.02 psi/ft prior: 2.5–8.6 h after shut-in. |
| CLOSURE_VETO | ✗ | The tangent pick 5,050 psia is below the frictional limit 5,131 psia (μ 1.0, overburden 0.9 psi/ft, hydrostatic pore pressure) and is excluded unless overridden. |
| CLOSURE_FRICTION_WARN | ⚠ | The tangent pick 6,200 psia is below the μ 0.6 frictional limit 6,263 psia (overburden 1.0 psi/ft, p_p 4,500 psia) but above the μ 1.0 limit 5,131 psia: kept, with strong faults required to explain it. |
| CLOSURE_REOPEN | ✓ | The second-cycle reopening at 7,031 psia (near-wellbore corrected) supports the contact reading within 31 psi. |
| CLASS_DUAL | ⚠ | Concave-up G·dP/dG: height recession and asperity contact fit equally well (scores 0.71 and 0.68); the closure range reflects this. |
| CLASS_MATRIX | ✓ | dP/dG falls 27 % to closure; 28 % is expected from reservoir-controlled leak-off at p_r 4,500 psia; classified normal (matrix-controlled). |
| SINK_UNIT_SLOPE | ⚠ | The log-log derivative keeps a unit slope past ΔtD 1: a near-constant leak (valve, casing, packer or another zone) is likely. Check the leak plot and the annulus. |
| ACA_FALSE_RADIAL | ⚠ | Slope reached −1 and kept steepening (−1.32): penny-shaped fracture suspected; no radial kh/μ is reported. |
| ACA_BOUNDS | ⚠ | Radial flow not reached: k between 0.0039 and 0.0131 md (limited by the largest plausible area and by the trend at 300 h). |
| ACA_PI | ✓ | p_i 4,500 psia, bracket 4,494–4,506 psia (high): three methods agree. |
| LEAK | ✗ | Leak of 0.20 ± 0.03 bbl/d detected (tolerance 0.05 bbl/d for this shut-in, linear flow): leak-corrected p_i 4,508 psia vs 4,461 psia uncorrected. |
| LEAK_DRIFT | ⚠ | The late trend fits a leak of 0.03 bbl/d or a gauge drift of 0.02 psi/d equally well: leak or drift, not separable from these data. |
| LK_GROUP | ⚠ | E′ and fracture height cannot be separated by this test: only Γ = 9.49 psi/√min (r_p·CL·E′/h_f = 14.9) is determined (±1 %). CL assumes E′ 5.0e6 psi and h_f 50 ft. |
| LK_TOUGH | ⚠ | Apparent toughness 14,000 psi·√in stands in for tip and scale effects; it is not a rock property. |
| DESIGN_SHALE | ⚠ | Radial flow is not reachable within 30 days for these ranges: plan this DFIT for closure, p_i and bounds on k. |
| DESIGN_VACUUM | ⚠ | At p_i the surface pressure would be below 0 psig: a surface gauge is enough for closure, but after-closure analysis needs a bottomhole gauge. |
| DESIGN_HOLD | ⚠ | A 6-minute hold would need the column temperature stable to 0.004 °F: prove the leak rate after the test with the leak plot instead. |
| HANDOFF_BLOCK | ⚠ | p_i is low confidence and is not handed to PTA unless you include it explicitly. |
| HAMMER_NA | ⚠ | Water hammer not resolvable at 1 Hz: record ≥ 2.3 Hz at the wellhead through shut-in to use it. |

### 7.12 Report capture

Every card follows the capture classes (§2.10). Tables carry an "Ev." column and the report ends with the evidence appendix; no
inline evidence brackets in values; verdict divs use ✓ / ⚠ / ✗ plain text; canvases sit in `.chart-wrap`; the schematic is an SVG
with `role="img"`; the override and method-note dialogs and the tool drawers are `.rp-skip`. The PRiSM job-report snapshot (Quick
Report) captures the DFIT sections through the two host lines and 30-quick-report's key line. PNG export of any DFIT plot includes
the picks (post-draw hook runs with `exporting:true`).

### 7.13 Phones (390 px) and iOS

- One column; plots at 0.75 × width (existing rule); the strip at 160 px; tables scroll horizontally inside `.dtable-wrap`; the rail is
  the bottom sheet; the step-④ segmented control wraps to two rows.
- Drag handles rely on 02's `touch-action: none` on zoomable canvases, the pointer-owner hook and a 24 px hit radius.
- Live tool (3.4b): verdict tile first, buttons ≥ 44 px, tap-to-log row, loupe.
- iOS (`html.ios-app` only, in `ios-styles.css`): form controls ≥ 16 px (existing rule), the override and method-note dialogs'
  safe-area padding (§2.3), 44 px tile buttons. No change to the web layout for iOS.
- Layout is measured outside the acceptance harness (which has no layout engine): `ux-layout-check.js` and `gui-sweep --mobile` get a
  DFIT-mode pass (demo loaded, steps ①–⑤, step-④ sub-views) and `ios-webkit-check.js` one DFIT view (WP6). In acceptance, U11 checks
  structure only (§9, WP6).

### 7.14 Accessibility and GUI sweep

- Canvases get `role="img"` and an `aria-label` summary from `PRiSM_plot_finish`; the strip's aria-label reads the families and the
  consensus; drag handles have keyboard equivalents (focusable marker buttons; arrow keys move by one resampled point, Shift × 10).
- The GUI sweep visits DFIT mode with a set-up per view (load the reference demo, `PRiSM.setMode('dfit')`, await ▶ Analyse, then go to
  the step or sub-view), so result controls exist: steps ①–⑤, the four step-④ sub-views and every DFIT tool; it enters blank / 0 /
  −1 / 1e12 into every numeric input, tries every select option and scans for NaN / undefined / Infinity / null / [object Object];
  DFIT must produce none. DFIT variants of the Metric and decimal-comma passes run with the same set-up. Buttons that need missing data
  show their ⚠ reason, so they are not reported as no-effect clicks.

### 7.15 Metric mode

PRiSM is field-unit only. In Metric mode the shell shows `#prism_units_note`; DFIT shows field units unchanged (psia, psi/ft, ft, bbl,
bbl/min, cp, md, 1/psi, 1e6 psi, ft/√min, gal/100 ft²). `WTS_state.dfit` carries field-unit values. No DFIT number goes through
`_uFmt`.

---

## 8. Synthetic test data and validation

### 8.1 Generator (`49-calc-dfit-synth.js`, WP5)

`PRiSM_dfit_synth.make(caseSpec, seed)` returns a dataset in the §3.1 format plus the truth. Sources:

| Source | What it produces | Used for |
|---|---|---|
| `lk` — the leak-off mini-model (58, called at call time) | whole tests: breakdown, propagation, optional step-down, shut-in, closure, after-closure (w_c > 0); mechanisms Carter normal, reservoir-controlled, fissure PDL, asperity contact (hyp / exp with several scales), spurt, storage-dominated (large V_w·c_w with a pressure-dependent gas or air compressibility c_w(p), so the storage class and rule R5 can fire), tip extension and multi-cycle (3.4b engine) | closure picks, classifier, ISIP, frac outputs, history-match recovery |
| `gdomain` — closed-form G-domain decline (the variable-compliance model of §4.7 integrated in G, plus a decaying extra-area term for tip extension and a compliance step for height recession) | pre-closure signatures not yet in the 3.4a mini-model (tip extension, height recession) | classifier coverage in 3.4a |
| `aca-exact` — exact convolution of a Carter source with the full-height uniform-flux, penny or box kernel (§4.12) | after-closure data with known p_i, k, L (examples A and B and variants), radial, linear, penny/spherical | ACA, brackets, bounds, library match |

**Artefact injectors** (each a pure transform with its own seed stream): white noise (σ 0.01–1 psi) and AR(1) noise (ρ1 0–0.99);
quantisation (0.01–1 psi); sampling (1 s, 0.1 s); earth tides (M2 + K1, 0.05–0.5 psi); barometric (psig channels); surface conversion
with displacement warm-back (τ_T 0.5–5 h); vacuum truncation of the surface channel; leak (0.02–0.2 bbl/d); rate-clock offset (s to
1 h); psig written as psia; gauge depth used as datum; bbl/d written as bbl/min; water hammer (Γ, T, damping) in a high-rate window;
friction bleed-off (b, V_w·c_w); gauge thermal transient; early stop (0.5–3 t_c); shut-in valve on the gauge side (closed-line
signature); air in the well (V_w·c_w × 3).

**Truth** recorded per case: σ_c (mechanical, contact onset), σ_c,hyd (hydraulic), the model's F2-equivalent point σ_c,F2 (end of
stiffening, from the model's own compliance curve), ISIP, p_i, k, kh/μ, L, mechanism, regime at t_end (from t_DL and the s_D
thresholds of §4.12), t_c, η, CL, Γ, A_f·c_f, R_vis, xf, artefact list.

**Demo datasets** (`demo(name)`, deterministic seeds): `reference` (the §4.21 well, BH gauge, 1 s, with a step-down and a 50 Hz
shut-in window), `tight-linear` (example B), `conventional-radial` (example A), `contact` (hyp s_h 60), `pdl` (C_d 0.004),
`surface-gauge` (the reference with surface data, warm-back and a vacuum after 31 h), `two-cycle` (a second injection cycle after
closure with a reopening ramp, for family F4). "Load demo DFIT" commits them through `PRiSM_commitDataset` with role-header CSV in the
Data-tab text; tests use them.

### 8.2 Benchmark design (`dfit-validate.js`; WP5 builds, WP8 runs in 3.4b)

| Set | Strata | Cases |
|---|---|---|
| Pre-closure | 8 mechanisms (normal, matrix, PDL, contact-hyp, contact-exp, storage, tip extension, height recession) × 3 storage levels (R_vis ≈ 0.95, 0.6, 0.3; the 0.3 level with a pressure-dependent gas/air wellbore compressibility) × 3 noise levels (σ 0.05, 0.3, 1 psi with ρ1 0.9) × 2 shut-in lengths (1.5 t_c, 5 t_c) × 5 seeds | 720 |
| After-closure | k (1e-4 … 10 md, 6 levels) × geometry (full height, penny in a thick zone, box) × shut-in (linear only, transition, radial) × gas/liquid, 1 seed each with two noise levels | 120 (± a few cells pruned as physically empty) |
| Artefacts | 15 artefact kinds × 4 severities | 60 |
| **Total** | | **≈ 900** |

Run cost: one full pipeline run per case ≈ 1–1.5 s desktop → ≈ 20 minutes for the whole set (tool only, never in acceptance).

**Quick set** (`cases('quick')`, 12 cases, `dfit-validate.js --quick`, ≈ 20 s; a tool, not acceptance): reference, contact, PDL,
storage (gas wellbore), matrix, tip (gdomain), height recession (gdomain), example A, example B, penny, gas linear, surface gauge with
vacuum; plus the 20-seed live false-call replay, the structural spread of the contact case and the multi-start fit of run A.

**Integration set** (`cases('integration')`, 3 cases, in `dfit-integration` I11–I13, ≤ 6 s): reference, contact, example B.

### 8.3 What "right" means

| Output | Right when | Partial |
|---|---|---|
| Closure, single mode | \|consensus − σ_c\| ≤ max(25 psi, 0.5 % σ_c) | ≤ max(75 psi, 1.5 %) |
| Closure, range mode | the range [P10 of the lower family, P90 of the upper family] contains σ_c **and** the truth mechanism is concave-up (contact or height recession); the interval score is recorded for every range | contains σ_c only |
| Closure, none | the truth closure is after the last data point, or within 0.3 G-decade of it | — |
| ISIP | within max(10 psi, 2 % pn) of the truth | within max(25 psi, 5 % pn) |
| Mechanism | top class = truth (with `hr-contact` counting for either) | truth in `alt` |
| p_i | truth inside the reported bracket and the point within the label's width | truth inside the bracket |
| k | truth inside [k_lo, k_hi] (bounds) or inside the 95 % CI (radial / match) | within × 2 |
| Regime label | equals the truth at t_end (s_D thresholds of §4.12) | adjacent regime |
| A_f·c_f, R_vis, xf (pre-closure chain) | within 3 % of the truth (storage-consistent balance) | within 10 % |

Single-mode and range-mode results are **never pooled**: hit rates are reported per mode, and ranges are additionally scored with the
interval (width-penalised) score IS = (u − l) + (2/a)·(l − y)·[y < l] + (2/a)·(y − u)·[y > u] with a = 0.2 for a P10–P90 range
(Gneiting and Raftery 2007), so a wide range cannot buy hit rate.

**Caveat printed with every label statistic:** the truth closure is the mini-model's contact onset, which embeds the contact
physics, so the calibration favours F1 by construction. F2's agreement with its own model-equivalent point (end of stiffening,
`truth.sigmaCF2`) is reported separately so the board's two families are both checked against their own definitions.

### 8.4 Label calibration (3.4b, WP8)

- Out-of-fold by seed (5 folds). For each mode and label (single: high / medium / low; range: medium / low) the hit rate = P(right |
  mode, label) with a Wilson 95 % interval, and for ranges the mean interval score.
- Targets: single high ≥ 0.90, single medium ≥ 0.70 (lower bounds of the intervals ≥ 0.85 / 0.60); range medium ≥ 0.70 with a mean
  interval score no worse than the single-mode P10–P90 width of the same strata. If a target is missed, WP8 tightens the rule
  thresholds marked "cal" in §4.22 (τ constants, R_vis, noise) by a grid search on the training folds and re-checks out of fold.
- Live CUSUM (k, h, decimation) tuned on replays of the benchmark so that false early "provisional" calls (before t_c) are ≤ 5 % and
  the median confirmation delay is ≤ 0.3 G-decade.
- `dfit-validate.js --write` writes `49-calc-dfit-cal.js` (generated header "GENERATED — never edit by hand"), with `calibrated:true`,
  `version`, `generator:'g1'`, `n`, `hitRate:{single:{high:{p, lo, hi, n}, …}, range:{…}}`, `intervalScore`, `cusum`, `thresholds`, the
  date and the app version. The board then shows e.g. "medium (range) — 78 % right on 312 synthetic range cases (73–83 %)".

### 8.5 `prism-build/dfit-validate.js`

`dfit-validate.js [--set pre|aca|art|all] [--quick] [--perf] [--seed n] [--folds 5] [--write] [--out <dir>] [--cases id,…]` builds
the app from sources (harness `loadApp({fromSources:true})`), runs each case through `PRiSM_dfit_pipeline` (the same synchronous
engine as ▶ Analyse), scores it with `PRiSM_dfit_synth.score(run, truth)`, prints a confusion matrix per output and per mode and
label, writes `dfit-validate.json` and `.md` to `--out` (scratch; never committed) and, with `--write`, the cal file. `--quick` runs
the 12-case set and the replay / spread / multi-start checks (§8.2); `--perf` measures the wall-clock targets of D26, §4.20 and §5.8
on real timers (the acceptance harness clock is virtual). It exits 0 unless a target is missed with `--strict`.

### 8.6 What runs where

| Check | Where | Time |
|---|---|---|
| Verification vectors (G table, constants, V1–V14, s_D trajectories, examples A/B, related-test vectors) | acceptance (14 engine files incl. `dfit-shapes`, `opts:false`, one shared app per file) | ≤ 37.5 s together (≤ 4 s per file; budgets in §9) |
| Hooks, UI and integration (incl. the 3-case benchmark) | acceptance (`dfit-hooks`, `dfit-ui`, `dfit-integration`) | ≤ 4 + 8 + 8 s |
| **All 3.4a acceptance additions** | | **≤ 60 s** (17 files; ≈ 210 tests; loadApp ≈ 0.11–0.16 s per fresh app after the first build, so only the ≈ 46 UI/hook/integration tests that need a fresh app pay it) |
| 12-case quick set, 20-seed replay false-call check, structural spread (3–5 s), multi-start fit | `dfit-validate.js --quick` (tool) | ≈ 30 s |
| Wall-clock budgets (Analyse, grid, simulate, fit, designer, uncertainty, redraw) | `dfit-validate.js --perf` (tool) | ≈ 20 s |
| 900-case benchmark + calibration | `dfit-validate.js` (WP8, 3.4b) | ≈ 20 min |
| GUI sweep of DFIT mode (with set-up, Metric, decimal comma, mobile) | `gui-sweep.js --route prism` (report, not a gate) | part of the sweep |
| Layout at 390 / 1280 px in DFIT mode | `ux-layout-check.js`, `ios-webkit-check.js` (reports) | part of the tools |

Acceptance tests never assert wall-clock times tighter than 5 × a target; they assert evaluation counts (`run.counts`), iteration caps
and scaling ratios (e.g. 4,000 points < 2.5 × the work of 2,000).

---

## 9. Work packages

### 9.0 Dependencies, schedule, merge order

```
v3.3 merged ──► WP0 contracts (1.5 d) ──► WPH generic hooks + O(n) Bourdet (7 d) ─────────────────────────┐
                                    ├──► WP1 wellbore, step-rate, ramp engine (48) (9 d) ─────────────────┤
                                    ├──► WP2 pre-closure core (56) (18 d) ────────────────────────────────┤
                                    ├──► WPT triage helper (49-calc-dfit-triage) (5 d) ───────────────────┼──► WP6 UI + integration (23 d) ──► WP7 reviews + release v3.4 (3 d)
                                    ├──► WP3 after-closure, pipeline, results layer (57) (11 d) ──────────┤      (builds on fixtures and fake engines from day 1)
                                    ├──► WP4 leak-off model + designer (58) (12 d) ───────────────────────┤
                                    └──► WP5 synth generator + validate tool (49 helpers) (5 d) ──────────┘
3.4b (after v3.4 ships; all parallel, no shared file): WP8 calibration · WP9 live listeners · WP10 field tests · WP11 model extras
                                                       · WP12 lenses (stretch) · WP13 release v3.4.1
```

| WP | Owns (files) | Depends on | Days |
|---|---|---|---|
| WP0 | `concat-round8.js` (FILES), `tests/_dfit-shapes.js`, `tests/dfit-shapes.test.js`, skeletons of 56–59 and of the five Round-9 helpers | v3.3 merged | 1.5 |
| WPH | `01`, `02`, `04`, `05`, `07`, `11`, `29-project-save`, `30-quick-report`, `33`, `35`, `36`, `37`, host job-report lines, `tests/dfit-hooks.test.js` | WP0 | 7 |
| WP1 | `48-calc-wellbore.js`, `tests/dfit-wellbore.test.js` | WP0 | 9 |
| WP2 | `56-prism-dfit-core.js`, `tests/dfit-gfunction.test.js`, `tests/dfit-preclosure.test.js`, `tests/dfit-closure.test.js` | WP0 (WP1 and WPH resolved at call time, stubbed until merged) | 18 |
| WPT | `49-calc-dfit-triage.js`, `tests/dfit-triage.test.js` | WP0 (inputs from fixtures) | 5 |
| WP3 | `57-prism-dfit-aca.js`, `tests/dfit-aca.test.js`, `tests/dfit-uncertainty.test.js`, `tests/dfit-live.test.js`, `tests/dfit-report.test.js` | WP0 (56/58/WPT outputs from fixtures and `FIX.run`) | 11 |
| WP4 | `58-prism-dfit-leakoff.js`, `tests/dfit-leakoff.test.js`, `tests/dfit-leakfit.test.js`, `tests/dfit-designer.test.js` | WP0 (56's G functions stubbed through `sourceOverrides` until WP2 merges) | 12 |
| WP5 | `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (placeholder), `prism-build/dfit-validate.js`, `tests/dfit-synth.test.js` | WP0 (58 through fixtures until WP4 merges) | 5 |
| WP6 | `59-prism-dfit-ui.js`, `49-calc-dfit-info.js`, `29-multiwell.js`, `smoke-test.js`, `gui-sweep.js`, `ux-layout-check.js`, `ios-webkit-check.js`, `ios-styles.css` (DFIT block), `tests/dfit-ui.test.js`, `tests/dfit-integration.test.js` | WP0 from day 1 (fakes); WPH for real UI tests; every engine WP for integration | 23 |
| WP7 | release items (§10), neutral-wording review | all | 3 |

- WP1–WP6 and WPT run **in parallel** after WP0 (WPH as early as possible: WP6 needs its hooks for real UI tests; engine WPs do not).
- **Merge order (3.4a):** WPH → WP1 → WP2 → WPT → WP4 → WP3 → WP5 → WP6 (rebased on everything; adds `dfit-integration.test.js`) →
  WP7.
- **Estimates (engineer-days):** WP0 1.5, WPH 7, WP1 9, WP2 18, WPT 5, WP3 11, WP4 12, WP5 5, WP6 23, WP7 3 → **3.4a ≈ 95**
  (re-estimated from 69: WP2 holds the whole pre-closure engine with nine closure methods and the variable-compliance fit; WP6 holds
  ≈ 30 plot keys with picks, two step views with sub-views, nine panels, five tools, the rail, eleven report sections, exports,
  hand-off dialogs, keyboard equivalents, the linked cursor, the tests table and the 390 px layout). 3.4b: WP8 3, WP9 5, WP10 7, WP11
  7, WP12 3 (stretch), WP13 2 → **3.4b ≈ 27**.
- **Critical path:** WP0 → WP2 → WP6 (final integration, ≈ 6 days after WP2/WP3 land) → WP7 ≈ 28.5 working days, with WP6 building
  against `tests/_dfit-shapes.js` fixtures and fake engines from day 1.
- **Midpoint checks:** WP2 at day 9 and WP6 at day 12. If either is behind, the lead applies the pre-agreed 3.4b moves of §1.5 in
  order until the forecast fits; the "must ship" line of §1.5 is never cut.
- **Acceptance additions (3.4a):** 17 files, ≈ 210 tests, **≤ 60 s in total** (budgets per file below; engine files declare
  `opts:false` and share one app per file through `sharedApp(ctx)`). The count goes from the v3.3 figure (≈ 1,037) to ≈ 1,247; the
  exact number is fixed at integration. 3.4b adds 4 files (+ 1 stretch), ≈ 30 tests, ≤ 15 s. Smoke: + 9 checks (3.4a), + 2 (3.4b).

| File | WP | Tests | Budget |
|---|---|---|---|
| `dfit-shapes` | WP0 | 2 | ≤ 0.5 s |
| `dfit-hooks` | WPH | 14 | ≤ 4 s |
| `dfit-wellbore` | WP1 | 25 | ≤ 2 s |
| `dfit-gfunction` | WP2 | 8 | ≤ 1 s |
| `dfit-preclosure` | WP2 | 23 | ≤ 4 s |
| `dfit-closure` | WP2 | 13 | ≤ 4 s |
| `dfit-triage` | WPT | 10 | ≤ 3 s |
| `dfit-aca` | WP3 | 25 | ≤ 4 s |
| `dfit-uncertainty` | WP3 | 6 | ≤ 2 s |
| `dfit-live` | WP3 | 5 | ≤ 3 s |
| `dfit-report` | WP3 | 8 | ≤ 2 s |
| `dfit-leakoff` | WP4 | 18 | ≤ 3 s |
| `dfit-leakfit` | WP4 | 8 | ≤ 4 s |
| `dfit-designer` | WP4 | 6 | ≤ 3 s |
| `dfit-synth` | WP5 | 6 | ≤ 2 s |
| `dfit-ui` | WP6 | 16 | ≤ 8 s |
| `dfit-integration` | WP6 | 16 | ≤ 8 s |
| **Total** | | **≈ 209** | **≤ 57.5 s** |

### WP0 — Contracts and skeleton (lead; serial; before everything)

- **Files:** `concat-round8.js` (FILES += 56–59, banner), `tests/_dfit-shapes.js`, `tests/dfit-shapes.test.js`, empty skeletons of
  56–59, `48-calc-wellbore.js`, `49-calc-dfit-triage.js`, `49-calc-dfit-info.js`, `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js`
  (placeholder `PRiSM_dfit_cal` of §3.9), this plan's status line.
- **Deliverables:** `checkShape` for every §3.13 name; the §3.2 range table; `FIX.ds`, `FIX.state` (two tests), `FIX.run`, `FIX.aca`;
  `sharedApp(ctx)` and `resetDfit(app)`; skeleton files that load in the smoke stub and export the §3 names as stubs returning
  `{ok:false, code:'NOT_IMPLEMENTED'}`.
- **Tests:** `dfit-shapes.test.js` (2 tests, ≤ 0.5 s): SH1 fixtures pass and a broken copy fails with a path; SH2 the range table
  clamps blank / 0 / −1 / 1e12 for every field and keeps integers integral.
- **Done when:** Dev builds; smoke unchanged + skeleton loads; existing Round-8 acceptance files pass; tag `v3.4-wp0`.

### WPH — Generic PRiSM hooks and the O(n) derivative

- **Files owned:** `01-foundation.js`, `02-plots.js`, `04-ui-wiring.js`, `05-regression.js` (one export), `07-data-enhancements.js`,
  `11-polish.js`, `29-project-save.js`, `30-quick-report.js`, `33-pta-core.js`, `35-rta-dca.js`, `36-report.js`,
  `37-prism-workflow.js`, host job-report lines, `tests/dfit-hooks.test.js`.
- **May assume:** §3.12 only. No DFIT code.
- **Deliverables:** every row of §2.3 except 29-multiwell, smoke, gui-sweep, ux-layout-check, ios-webkit-check and the iOS CSS (WP6).
- **Tests** (`dfit-hooks.test.js`, 14 tests, ≤ 4 s; fresh apps where reloads are needed): H1 O(n) Bourdet identical to the old loop
  (max relative difference ≤ 1e-12) on log-spaced, uniform and superposition-time sets and on sets with NaN, duplicate t and t ≤ 0,
  and linear operation count (4,000 points < 2.5 × the work of 2,000); H2 window aliases exist; H3 `prism:plot-hover` fires with
  `opts.hoverEvent` and the pointer owner suppresses the box gesture; H4 `_defaultKinds` honours `entry.axes`, and post-draw hooks
  keyed on PTA kinds (51 saved-fit compare, 21 overlays) do not draw on a `kind:'dfit'` entry; H5 a dummy `PRiSM_modeExt.test`
  registered after 01/37 load appears in the select, relabels the steps, renders step views for steps 2 and 4 in `#prism_stepview`,
  `gotoStep(4)` survives `PRiSM_refreshShell()` and a reload, `#prism_tabs` is hidden, its rail and status are used, the mounted
  panel list per mode is exact, and transient / decline / combined are unchanged (labels, plot lists, step hosts, panels); H6
  `PRiSM_undoExtras` round-trip: the first undo after load keeps the extra's state, pick → undo → redo, a `PRiSM_undoBatch` around
  several changes is one undo step (also when the batch ends by rejection), after an undo the rail is the ext rail and the step view
  re-renders, `'dfit'` in `STATE_FIELDS` and `P.step` survive a reload; H7 a section with `modes`, three tables, a verdict and two
  plot blocks renders in the Tab-7 and PDF paths only in its mode, `PRiSM_reportKeyLine` / `PRiSM_reportReady` follow the ext, and the
  gallery lists only `ext.reportPlots` in the ext mode and no `mode:'test'` entry in combined mode; H8 `PRiSM_rng(1)` reproduces the
  05 bootstrap sequence and `PRiSM_rng(undefined)` is deterministic; H9 a CSV with surface pressure in psig, bbl/min rate and
  temperature reloads with all channels and `meta.psigConverted`; H10 RTA linear flow takes k from `PRiSM_dfit_kConstraint` when no
  input or fit exists; H11 `PRiSM_toolCatalogueExtra` entries appear only in their modes (`'*'` in all), de-duplicated, and never
  under "More"; H12 `PRiSM_plot_overlay` draws on the cached frame without calling the plot function; H13 `PRiSM_drawPlot` on a second
  canvas runs each post-draw hook once with its own plotKey and `PRiSM_drawActivePlot` output is unchanged; H14 `'dfit'` in
  `PRISM_KEYS` (project round trip of a dummy `st.dfit`), 30-quick-report uses `PRiSM_reportKeyLine` in an ext mode, and analysis keys
  with `store:false` are neither stored nor drawn by `linetools-picks`.
- **Done when:** H1–H14 pass; `wp6-plots`, `wp13-workflow`, `wp10-tools`, `platform-reports` and every Round-8 acceptance file are
  unchanged; C2 on 4,000 uniform falloff points no longer scales quadratically (`--perf`: < 60 ms).

### WP1 — Wellbore, step-rate and ramp engine (`48-calc-wellbore.js`)

- **Files owned:** `48-calc-wellbore.js`, `tests/dfit-wellbore.test.js`.
- **May assume:** `PRiSM_pvt_correlations` (Round 3), `WTS_tubulars` (40), `WTS_flowline_friction` and `WTS_gradient_compute`
  (resolved at call time), `PRiSM_lm`, `PRiSM_rng`.
- **Deliverables (3.4a):** `column`, `csys`, `tempProfile` (static, displaced), `hydrostatic`, `pipeFriction` (Newtonian, FR, power
  law), `perfFriction`, `nwbLoss`, `bleedOff`, `convert` (with band), `vacuum`, `stepDown`, `stepDownDesignCheck`, **`stepRate`
  (hinge, bootstrap, stabilisation)**, **`ramp`**, `hammerQuick` (bleed-aware midline, V_w·c_w from the period), `align`.
- **Tests** (`dfit-wellbore.test.js`, 25 tests, `opts:false`, ≤ 2 s): W1 v = 17.157 ft/s for 1 bbl/min in 1 in; W2 perforation
  constant 0.2376 (first principles) and 37.6 psi; W3 water in 5½-in casing at 5 bbl/min: Re 140,456, 40 psi smooth / 46 psi rough;
  W4 2⅞-in tubing 1,020 / 1,355 psi; W5 power law 66 psi (laminar, casing) and 1,134 psi (turbulent, tubing); W6 n = 1 limits 926.6
  and 1/(1,497.6 d²); W7 Virk f 0.00049 at Re 549,856; W8 8.43 ppg ⇔ 1.571 wt %; W9 p_s for BHP 7,600: 3,220.0 / 3,173.0 / 3,181.3 /
  3,260.1 psia; W10 warm-back +18.3 / +33.8 / +57.4 psi; W11 bleed-off 1 psi at 15.45 / 1.63 min (V_w·c_w 4.44e-3 ft³/psi; 17.33 /
  1.83 min at the old 4.98e-3); W12 step-down reference fit (p_frac 7,595.5, a 1.528, b 140.9, n 11.9); W13 se table (10.6, 0.414,
  8.8) and refusal of the 25 % range; W14 n_p P10/P50/P90 8.9 / 11.7 / 16.0 (± 0.3, seeded); W15 surface tubing case → n_p "not
  determinable"; W16 hammer: c 4,539 ft/s, T 8.81 / 4.41 s, Joukowsky 232.1 psi, and a synthetic 50 Hz window gives ISIP_wh within
  1 psi and the quarter-wave reflector within 3 %; W16b a bleed-off-plus-ringing window built inline (b 140.9, β ½, V_w·c_w 4.44e-3):
  the bleed-aware midline recovers ISIP within 5 psi, a linear midline reads ≥ 20 psi high, and switching the bleed term off flags
  "upper"; W17 vacuum 195.2 / 95.9 / −3.3 psia; W18 clock offset 37.4 s within 0.2 s; W19 `csys`: c_sys 3.57e-6 1/psi, V_w·c_w
  4.44e-3 ft³/psi, ramp 6,323 psi/min, and L·A/(ρc²) from the 8.81 s period equals the ramp value within 1 %; W20 step-rate vector
  (q\* 1,805 bbl/d, FEP 6,199.3, P10–P90 6,186–6,217, b₁ 1.249, b₂ 0.037); W21 an unstabilised step is flagged and the band is
  recomputed without it; W22 ramp knee (§4.15b vector) within 10 psi and s₁ within 1 %; W23 one-slope ramp → "no knee", and the LOT
  onset within 3σ; W24 the near-wellbore-corrected knee shifts by 99.6 psi (+ 0.4 psi perforation) at 0.5 bbl/min.
- **Done when:** W1–W24 pass; self-test present; loads in the smoke stub; no timers.

### WP2 — Pre-closure core (`56-prism-dfit-core.js`)

- **Files owned:** `56-prism-dfit-core.js`, `tests/dfit-gfunction.test.js`, `tests/dfit-preclosure.test.js`,
  `tests/dfit-closure.test.js`.
- **May assume:** §3.4 (WP1 functions resolved at call time, stubbed in tests until WP1 merges), `PRiSM_compute_bourdet` (WPH;
  until it merges the old loop gives the same numbers, slower), `PRiSM_lm`, `PRiSM_rng`, `PRiSM_autoInterp.canon/hash16` (optional),
  `PRiSM_dfit_lkSimulate` at call time for κ_exp (quasi-static fallback when absent).
- **Gate G6 (by the WP2 midpoint):** take the h-function definition, its permeability relation and check values, and the far-field
  extension-pressure reading, from the cited sources (§13; author, year, title until the SPE number is verified); freeze P20 from
  them. If not verifiable, `dfitH`, the h-function estimate and the far-field reading move to 3.4b (slip list) and the plot stays
  hidden.
- **Deliverables:** every §3.5 function; §4.1, 4.3–4.11, 4.15b merging (F4 picks from `Ramp`), §6.12's calculations; the consensus
  Job; the counterfactual sentence from the stability samples.
- **Tests:** `dfit-gfunction` (8 tests, ≤ 1 s): G1 g0 = π/2, 4/3; G2 the G table (G(1, ½) 1.27324, G(1, 1) 1.40638, G(10, ½) 6.3159,
  G(100, ½) 23.5495, G(100, 1) 23.8307); G3 quadrature vs closed forms < 1e-5 at ΔtD 0, 0.1, 1, 10, 61.7; G4 g0(8/9, 4/5, 2/3) =
  1.37689 / 1.41495 / 1.47835; G5 G⁻¹(18, ½) = 61.019; G6 η(18, ½) 0.9000 and η(18.276, 1) 0.9150, and the α pair is shown when
  |Δη| > 0.01 (G_c 5) but not at G_c 61 unless in the what-if table; G7 slopes 0.785 / 0.617 / 0.539; G8 the data-driven G equals the
  closed form for a constant-rate schedule within 1e-4 and stays monotone on a ramped two-cycle schedule. `dfit-preclosure` (23
  tests, ≤ 4 s): P1 events on `FIX.ds` (t_s within 1 s; tp choices; V_i\*, q_eq); P2 resampler: 10⁶ samples in one pass (operation
  count linear), 40 per decade; P3a reconciliation arithmetic (7,605 / 7,600.0 / 7,595.5 / 7,599.4 → 7,600 ± 5, high); P3b the
  inline bleed-off simulation of §4.4 (each accepted family within 5 psi; the viscous term subtracted from ISIP_lp); P4 the √t
  extrapolation reads 22–28 psi high on the same data (proves G is used); P5 Bourdet G·dP/dG equals the analytic m_G·G on Nolte data
  within 0.5 %; P6 D_ref on Δt (no superposition switch); P7 geometry table with storage (xf 131.2 / 57.3 / 57.8 ft; CL 1.903e-4 /
  4.361e-4 / 4.409e-4; r_p 0.4315; C_sys 0.2105, A_f·c_f 0.2061); P8 V_L during pumping 14.04 ft³; P9 q_L 0.500 / 0.0405 bbl/min and
  22.5 bbl after shut-in; P10 k from CL 2.75e-3 md at Δp_CL 2,800; P11 forecast 2.46 / 8.63 h; P12 C_d 0.0040 ± 0.0002; P13 κ_exp from
  a stubbed w_c = 1 run and the matrix classification; P14 R_vis 0.979 (water) / 0.54 (gas-filled, C_sys 0.388); P15–P17 classifier on
  `PRiSM_dfit_vcModel` signatures (normal, matrix, PDL, contact / height recession, tip extension, storage with a pressure-dependent
  wellbore; top class or alt correct; a constant-C_sys storage case is **not** classified storage when R_vis > 0.7, and a constant sink
  raises `unitSlopeSink`); P18 storage chain: `vcModel` with V_w·c_w 0.178 ft³/psi and A_f·c_f 0.2105 → R_vis 0.542 ± 0.01 and A_f·c_f
  within 1 %; P19 stress-log offset 667 psi and pad fraction 0.053–0.010 on the reference; P20 h-function check values (after gate
  G6); P21 masked samples (vacuum mask) never reach a derivative as `null` (no spike at the mask edge); P22 the frictional check uses
  p_p at the lower bracket edge and S_v 0.9 psi/ft for the veto. `dfit-closure` (13 tests, ≤ 4 s): C1–C13 of §6.2.
- **Done when:** all pass; the stability grid evaluation count matches C9; no `Math.random`; every output passes `checkShape`.

### WPT — Triage helper (`49-calc-dfit-triage.js`)

- **Files owned:** `49-calc-dfit-triage.js`, `tests/dfit-triage.test.js`.
- **May assume:** §3.4 and §3.5 shapes (fixtures until WP1/WP2 merge).
- **Deliverables:** §6.3 (checks, blunder rules, re-pump verdict with input-derived bands, grade, salvage); Bayes-factor scoring only
  if time allows (slip list).
- **Tests:** `dfit-triage` (10 tests, `opts:false`, ≤ 3 s): T1–T10 of §6.3.
- **Done when:** all pass; loads in the smoke stub; resolved at call time by the pipeline.

### WP3 — After-closure, pipeline and results layer (`57-prism-dfit-aca.js`)

- **Files owned:** `57-prism-dfit-aca.js`, `tests/dfit-aca.test.js`, `tests/dfit-uncertainty.test.js`, `tests/dfit-live.test.js`,
  `tests/dfit-report.test.js`.
- **May assume:** §3.5 outputs (fixtures and `FIX.run` until WP2 merges); examples A and B are built inline in the test file from the
  closed-form Carter-source convolution (WP5 re-implements it independently and S5 checks the two agree); `PRiSM_mpTable`,
  `PRiSM_gasPseudoTime`, `PRiSM_tideAnalysis`, `PRiSM_applyTideCorrection`, `PRiSM_MODELS[key].pdPrime`, `PRiSM_lm`, `PRiSM_rng`.
- **Deliverables:** `PRiSM_dfit_pipeline` / `…Job` / `PRiSM_dfit_summarise` (§3.3a); every §3.6 function in 3.4a scope; §4.12–4.13;
  §6.4 (leak plot), §6.6, §6.8, §6.9 engine + replay, §6.10 engine.
- **Tests:** `dfit-aca` (25 tests, `opts:false`, ≤ 4 s): A1 constants (250,856 ± 0.1 %, 4,181, 1,694.5, 97.54, 29,437, 845.50 /
  109.15, 1.1827e-3, 2.63679e-4); A2 Nolte vs impulse radial within 0.1 % late, and V = 8·CL_p·h·L·√t_c; A3 uniform-flux Δp slope
  −0.950 at t_DL 1.60, −0.980 at 4.10 (± 0.002), penny Δp slope −1.00 at ηt/R² 0.199; A3b s_D trajectories of §4.12 (uniform flux:
  −0.50 to 0.03, max −0.30 at 0.10, −0.90 at 1.6, −0.93 at 2.32; penny −1.0 at 0.39, −1.1 at 0.49; ± 0.01); A4 F_R/F_Rc 0.9538 at
  2 t_c, F_L(2t_c) = 0.5; A5 example A (F_R 100–300 h: p_r 4,500.02 ± 0.05, kh/μ 50.5 ± 0.3; 20–300 h 51.97, bias upper; bracket
  contains 4,500 for t ≥ 1.2 t_c); A6 example B (F_L 5–30 h: p_r 4,500.00 ± 0.05, k 0.0100 ± 1 %; centroid impulse 10–55 h k within
  2 %; F_R line > 4,500 on 3–10 h; F_L line < 4,500 on 20–300 h); A7 trend bounds 0.653 / 0.854 md·ft/cp and the interval containing
  0.01 md with the 1.6 constant; A8 origin table ± 0.005; A9 gas: p_i converges in ≤ 3 passes and late radial kh/μ_i changes < 2 % at
  5,000 psi; A10–A12 (§6.8); A13, A13b, A14, A14b, A15 (§6.4); A16 p_i labels high on example A and medium on example B at 300 h;
  A17 gas details: p_a(p_i) = p_i (intercepts in psia) and k_lo evaluated at the lower bracket edge is ≤ the value at the upper edge;
  A18 the uniform-flux hump (t_DL 0.06–0.18) is not called storage, the bracket contains p_i through it, and `piPoint` is null there;
  A19 a storage case (s_D > −0.4 before any −0.5 segment) is called storage and lines are withheld; A20 `PRiSM_dfit_pipeline` sync =
  job on `FIX.ds` and `opts.fast` skips grid and uncertainty (`counts`); A21 `PRiSM_dfit_summarise(FIX.run)` passes `checkShape`; A22
  the Δp_CL convention is identical in `frac.kBefore`, `acaBounds` and the leak-off model report. `dfit-uncertainty` (6 tests, ≤ 2 s):
  U1–U6 of §6.6. `dfit-live` (5 tests, ≤ 3 s): V1–V4 and V7 of §6.9. `dfit-report` (8 tests, ≤ 2 s): R1–R8 of §6.10.
- **Done when:** all pass; `PRiSM_dfit_aca` and the library match stay within their `--perf` targets.

### WP4 — Leak-off mini-model and designer (`58-prism-dfit-leakoff.js`)

- **Files owned:** `58-prism-dfit-leakoff.js`, `tests/dfit-leakoff.test.js`, `tests/dfit-leakfit.test.js`,
  `tests/dfit-designer.test.js`.
- **May assume:** `PRiSM_dfit_g/G/gFromHistory` (56, resolved at call time; a 30-line closed-form stub through `sourceOverrides`
  until WP2 merges), `PRiSM_lm`, `PRiSM_jacobianForward`, `PRiSM_invertMatrix`, `PRiSM_rng`, `WTS_wellbore` (call time).
- **Gate G4 (before the tests are frozen):** verify the KGD (0.6152) and radial (0.6955) zero-toughness similarity coefficients against
  the original papers (Spence & Sharp 1985 / Adachi & Detournay 2002; Savitski & Detournay 2002) **under the stated conventions**:
  μ′ = 12μ, Q₀ the total injection rate (per unit height for KGD), K′ = 4·√(2/π)·K_Ic. Under them V3's 317.98 / 165.02 ft reproduce
  and the toughness vertex gives exactly 0.9324 / 0.8546; using μ where μ′ is meant changes L by 12^(1/6) = 1.51 (KGD) or
  12^(1/9) = 1.32 (radial). If not verifiable within WP4, ship the lumped laws with κ as derived from the coefficients in hand, label
  KGD/radial pumping pressures "viscous term uncalibrated" and keep V3 testing the model's own laws (it does by construction).
- **Deliverables:** §3.7 in 3.4a scope (no tip extension, no multi-cycle, no drag); §5 (log-k parameterisation, positive aperture
  laws, relative tolerances, p_fo ≥ σ_c); §6.1 (minus drag); §6.5; §6.7 engine; leak budget with Θ.
- **Tests:** `dfit-leakoff` (18 tests, `opts:false`, ≤ 3 s): L1–L18 (§6.1). `dfit-leakfit` (8 tests, ≤ 4 s): LF1 run A recovery
  inside the 95 % CI in ≤ 40 runs from one start; LF2 Γ_PKN conserved to 1e-3 (14.904); LF3 run J (h_f wrong, E′ fixed) reports rmse
  ≈ 19.6 psi, σ_c bias ≈ −78 psi and fires the geometry warning; LF4–LF6 (§6.7); LF7 n_eff inflation ≈ × 4.4 for AR(1) residuals with
  ρ1 0.9; LF8 with log k as the parameter, moving σ_c or p_r by ± 200 psi leaves the k column of the Jacobian unchanged to 1e-6 and
  the reported CL equivalent follows Δp_CL; the structural spread (3–5 s) and the multi-start check run in `dfit-validate.js --quick`.
  `dfit-designer` (6 tests, ≤ 3 s): D1–D6 (§6.5).
- **Done when:** all pass; simulate, fit and designer stay within their `--perf` targets; Job = sync results.

### WP5 — Synthetic generator, demos and validation tool

- **Files owned:** `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` (placeholder), `prism-build/dfit-validate.js`,
  `tests/dfit-synth.test.js`.
- **May assume:** §3.7 `lkSimulate` (fixtures until WP4 merges) and the §4.12 kernels (own implementation for the `aca-exact` source,
  independent of 57, so the ACA tests check 57 against a separate calculation).
- **Deliverables:** §8.1–8.2, §8.5 (`--quick`, `--perf`); the seven demo datasets (with role-header CSV for the Data-tab text); the
  quick (12) and integration (3) case lists.
- **Tests:** `dfit-synth` (6 tests, `opts:false`, ≤ 2 s): S1 determinism by seed; S2 demos pass `checkShape('DfitDataset')` and their
  CSV re-parses through 07 to the same arrays; S3 each artefact injector changes only its target channel; S4 truth fields complete
  (incl. A_f·c_f, R_vis, xf, σ_c,F2); S5 `aca-exact` reproduces the example A/B tables (Δp and D) within 0.1 %; S6 no `Math.random` in
  any DFIT source file (grep). The end-to-end benchmark cases run in `dfit-integration` I11–I13 (they need 56–58).
- **Done when:** all pass; `dfit-validate.js --quick` runs end to end and writes its report to a scratch folder.

### WP6 — UI and integration (`59-prism-dfit-ui.js`)

- **Files owned:** `59-prism-dfit-ui.js`, `49-calc-dfit-info.js`, `29-multiwell.js` (DFIT rows), `smoke-test.js` (DFIT list),
  `gui-sweep.js` (DFIT views with set-up, Metric and decimal-comma variants, mobile pass), `ux-layout-check.js` and
  `ios-webkit-check.js` (DFIT passes), `ios-app/ios-additions/ios-styles.css` (DFIT block), `tests/dfit-ui.test.js`,
  `tests/dfit-integration.test.js`.
- **May assume:** every §3 interface and the fixtures; WPH hooks. Until the engines land, UI tests load fake engines with
  `loadApp({ sourceOverrides: { '56-prism-dfit-core.js': fake56, '57-prism-dfit-aca.js': fake57, '58-prism-dfit-leakoff.js': fake58 } })`
  that return `FIX.run` and fixture objects.
- **Deliverables:** §2.6–2.11, §6.12 UI, §6.13, §7, `WTS_state.dfit`, the Analyse orchestration (§4.20), the replay tool ("first
  available" table), the report sections.
- **Tests:** `dfit-ui` (16 tests, ≤ 8 s): U1 the select option and `setMode('dfit')` relabel the steps; U2 transient / decline
  unchanged; U3 `onEnter` writes falloff + `multiRate` with q_eq as one undo step; U4 each DFIT plot draws through `PRiSM_drawPlot` on
  the reference demo with `_prismAxes`, no foreign hook draws on DFIT canvases while saved-fit compare, overlays and field-tool
  events are active, and on the `contact` demo the contact deflection of G·dP/dG lies inside the plotted y-range of `dfitG` (axis
  rule of §2.7; with "lock axis" on, the range is kept); U5 `dfit-picks` hook registered once; U6 `dfitTangent` click stores a pick
  (not in `st.analysisKeyResults`),
  logs it and undo restores it; U7 a drag through the pointer owner commits one log entry; U8 ▶ Analyse runs every stage through the
  pipeline Job with progress, Cancel keeps the previous results, and the run is one undo step; U9 zero pending timers after Analyse and
  `flush(5000)`; U10 the exact mounted panel list in DFIT mode (DFIT panels + crop, gauges, linetools) and none of them in transient
  mode; U11 390 px **structure**: `.dtable-wrap` around every DFIT table and `prism-rail--sheet` on the rail after `app.resize(390)`
  (layout overflow is measured by `ux-layout-check.js`); U12 the iOS CSS block exists; U13 every DFIT numeric input clamps blank / 0 /
  −1 / 1e12 to the range table without NaN text, counts are capped (n ≤ 2,000) and integral, and "1,5" in a decimal-comma locale
  becomes 1.5 in a single-value field; U14 the exact Tools list per mode (sandbox in every mode, the others only in DFIT mode, none
  under "More"); U15 tests table add / open / delete with undo, overlay of two stored curves; U16 method notes (§6.13).
  `dfit-integration` (16 tests, ≤ 8 s): I1 reference demo end to end (ISIP 7,600 ± 5, closure 7,000 ± 25, η_G 0.900 ± 0.005, xf 131 ±
  3 ft, R_vis 0.979 ± 0.01); I2 surface-gauge demo (band, vacuum masking after 31 h, closure within 30 psi of the BH result); I3 PTA
  hand-off (§6.8; multiRate carries q_eq; transient C2 sees Δp > 0 for ≥ 95 % of the falloff points); I4 RTA k fallback; I5 the
  Tab-7 report and the PDF HTML contain the DFIT sections, plots, grade and key line; I6 reload and project save/open restore `st.dfit`
  (two tests) and the HF index, and a demo dataset reloads from the Data-tab text with the same hash (the test is not marked "for
  another dataset"); I7 two wells keep separate DFIT states and the comparison rows show both; I8 header Quick Report and
  30-quick-report key line in DFIT mode; I9 no pending timers 5 s after opening DFIT mode; I10 DFIT → transient → DFIT keeps the
  picks; I11–I13 the integration cases (reference, contact, example B) through `PRiSM_dfit_pipeline` and `PRiSM_dfit_synth.score`:
  closure right or partial, mechanism right or partial, p_i inside the bracket; I14 a mini-model run with V_w·c_w 0.178 ft³/psi
  (gas-filled wellbore) analysed by the pre-closure chain recovers the model's A_f·c_f, xf and R_vis within 3 %, and κ_exp comes from
  the coarse run; I15 after the PTA hand-off on the conventional-radial demo, the transient radial kh/μ equals the ACA kh/μ within 2 %;
  I16 two stacked tests on two demo datasets (§6.12).
- **Smoke additions (9):** the DFIT API list (all §3.3a, §3.5–3.8 names) is present; `PRiSM_modeExt.dfit` has `label`, `steps`,
  `analyse`, `rail`, `showsPanel`; plot keys `dfitG`, `dfitSqrt`, `dfitLogLog`, `dfitStrip`, `dfitAcaLogLog` registered with
  `mode:'dfit'`, `kind:'dfit'` and a function `fn`; `dfit-picks` post-draw hook exactly once; every DFIT report section carries
  `modes:['dfit']`; G spot check (1.27324, 1.40638); `WTS_wellbore` and `PRiSM_dfit_triage` shapes; the range table loads; no pending
  timers with DFIT mode open.
- **Done when:** all pass; the GUI sweep of DFIT mode (with set-up, Metric, decimal comma, mobile) reports no NaN / undefined /
  Infinity / null / [object Object] and no error-level findings; `ux-layout-check` unchanged for the sidebar and clean for the DFIT
  pass.

### WP7 — Reviews and release v3.4

- Neutral-wording review of every DFIT string, method note, help text, test name and comment (no product, vendor, company or website
  names; no doctrine attributed to a person; SPE numbers marked "no. to verify" absent from the app); engineering review of the
  verdict strings and labels; release items of §10; perf baseline re-record in its own commit; merge Dev → master after the batch is
  verified.

### 3.4b work packages (v3.4.1; each WP owns its files, so they run in parallel; the lead adds the new Round-8 names to FILES)

- **WP8 — Calibration** (3 d; files `49-calc-dfit-cal.js` (generated), `tests/dfit-cal.test.js`): run `dfit-validate.js --set all
  --write`; meet the §8.4 per-mode targets or tighten the "cal" thresholds; 59 (3.4a) already shows hit rates when
  `calibrated:true`. Test: the cal file shape, `calibrated:true`, per-mode rates, and the label text with the rate.
- **WP9 — Live listeners** (5 d; new `59-prism-dfit-live.js`, `tests/dfit-livelisten.test.js`): §6.9 listeners, tag picker, back-fill,
  tap-to-log, corridor display, replay timeline on `dfitHistory`, 390 px live layout; V5–V6.
- **WP10 — Field tests** (7 d; new `48-calc-wellbore-field.js` (merges into `WTS_wellbore`) and `59-prism-dfit-fieldtools.js`,
  `tests/dfit-fieldtests.test.js`): `stepRateSP` (superposition, vectors of §4.15), `hall`, `injector` and MASIP (2,162 / 2,265 psia),
  `flowback` / `pulses` (§4.16 vectors), `mocSim` / `hammerFit` (regime rows, first-swing ratios 0.040 … 1.905, critical amplitudes,
  capacitive periods 8.738 / 8.517 / 8.140 s), `calibrateTwoGauge`, Ramey profile (5,000 bbl/d, 30 d → 94.4 °F), step-down hysteresis
  and per-step hammer.
- **WP11 — Model extras** (7 d; new `57-prism-dfit-acamodel.js` and `59-prism-dfit-dragfit.js`, plus `58-prism-dfit-leakoff.js`,
  whose only 3.4b owner it is; `tests/dfit-extras.test.js`): variable-storage ACA model (reproduces example B within 0.5 psi with
  C_res = 0 and a Carter source), generalised F_n, tip extension and multi-cycle in the mini-model, drag-to-fit, tidal c_t cross-check
  (if not shipped in 3.4a).
- **WP12 — Interpretation lenses** (3 d, stretch; new `59-prism-dfit-lenses.js`, `tests/dfit-lenses.test.js`): §6.11.
- **WP13 — Release v3.4.1** (2 d).

### Out-of-module follow-ups (other workstreams; not in v3.4)

- The live-data page's "Send to PRiSM" (route `wellos`, `63-wellos.js:570`) sends psig without conversion for PTA too: convert to
  psia at the PRiSM boundary for every mode (DFIT applies `channels.psig` itself).
- O(n) derivative in the separate loops of `13-auto-match.js:125` (PTA model race) and `34-semilog-skin.js:124` (semilog panel), which
  stay O(n²) on long falloffs (rebuild rounds 2 and 8).
- Well Kill & Bullhead page: offer the DFIT closure gradient as the fracture-gradient input (`WTS_state.dfit`).
- Build-up Surveillance: offer the DFIT p_i and k of the same well as reference values.
- PRiSM model gaps found by the injector notes: changing-storage PTA model, three-zone radial composite, fracture inside an elliptical
  flood front.
- The dead `renderDCA` / `renderPTA` host bodies (CLAUDE.md) remain a separate clean-up.

---

## 10. Release items

- **`RELEASE_NOTES[0]` (WP7, v3.4):**

```js
{ ver:'v3.4', date:'<release date>', title:'DFIT analysis in PRiSM',
  note:'PRiSM gains a DFIT workspace: diagnostic fracture injection tests from data health to closure, after-closure analysis, a leak-off model and hand-off to PTA.',
  items:[
   ['prism','DFIT workspace','Choose “DFIT (fracture injection)” in PRiSM: data and events, ISIP and friction, pre-closure, after-closure and model, report — with G-function, √t, log-log and compliance plots and every closure method.'],
   ['new','Closure consensus','All closure methods on one strip, grouped into independent families (including the reopening pressure from a second cycle), giving one closure or a closure range with a confidence label, the reasons, a frictional-limit check and a logged override.'],
   ['new','Test triage','Data-health checks and an A–D grade within seconds of import: vacuum, air in the well, thermal effects, gauge resolution, clock alignment, unit and depth blunders, and an early re-pump verdict.'],
   ['new','Step tests','Step-down friction split with open perforations, and the step-rate fracture extension pressure with a band and a per-step stabilisation check.'],
   ['new','After-closure analysis','Reservoir pressure with a bracket that needs no guess, transmissibility or bounds on permeability when radial flow is not reached, gas in adjusted variables, a leak check that separates leaks from gauge drift, and matching with the PRiSM model library.'],
   ['new','Leak-off model','“What leak-off rate do I get?” with no data, from any PRiSM view, and history matching of a recorded DFIT that states which parameters the test actually determines.'],
   ['new','DFIT designer','Ranges in; shut-in length, volume, gauge and sampling, leak tolerance, vacuum check, checklist and the expected outcome out.'],
   ['new','Uncertainty','P10/P50/P90 on every DFIT number, per closure reading when the closure is a range, with the largest driver in the report and a what-if closure marker.'],
   ['new','Several DFITs per well','Stacked tests side by side, closure and pressure gradients against depth, and a stress-log calibration offset for each closure reading.'],
   ['report','DFIT report','Evidence column and appendix, a pick and override log, data + picks export with your own column layout and a frac-design sheet; PTA and RTA hand-off in one click.'],
   ['ux','Faster derivatives','The plot and analysis-data pressure derivative is now computed in linear time (4,000 falloff points in tens of milliseconds); the auto-match and semilog loops follow later.'] ] }
```

  3.4b (`v3.4.1`): live DFIT co-pilot on the Modbus station and historian with a replay timeline; superposition step-rate and Hall
  plot; flowback and pulse analysis; water-hammer model fit; calibrated confidence labels; storage-model after-closure fit;
  tip extension and multi-cycle in the leak-off model. Engineering changes only; `&amp;` in the HTML; no research, competitor or
  paywall wording.
- **Version** 3.4 (then 3.4.1): `MARKETING_VERSION` at both places in `project.pbxproj`; `VERSION_BASE` in both copies of
  `ci_post_clone.sh` (identical); `tests/ios-native.test.js` and `app-version.test.js` follow `RELEASE_NOTES[0].ver`.
- **README:** a DFIT paragraph (generic wording); counts (models unchanged at 46, smoke, acceptance).
- **CLAUDE.md:** file-map lines for 56–59, `48-calc-wellbore.js`, `49-calc-dfit-triage.js`, `49-calc-dfit-info.js`,
  `49-calc-dfit-synth.js`, `49-calc-dfit-cal.js` ("GENERATED — never edit by hand") and `dfit-validate.js` (`--quick`, `--perf`); the
  Round-8 build note (FILES now include 53–59); the rebuild rounds for the edited files (01/02 phase 1+2; 04/05/07 phase 3+4; 11 round
  2; 29-project-save, 29-multiwell, 30 round 6); the generic hooks (`PRiSM_modeExt` incl. `showsPanel` and any-step step views,
  `PRiSM_undoExtras` with `events`, `PRiSM_undoBatch`, `PRiSM_toolCatalogueExtra` with `modes:'*'`, `PRiSM_drawPlot`,
  `PRiSM_plot_overlay`, report `blocks`/`modes`, analysis keys `store:false`, `prism:plot-hover`, pointer owner, `PRiSM_rng`,
  `PRiSM_reportKeyLine`/`Ready`); C1 provenance `dfit`; C7 events `prism:dfit-updated`, `prism:dfit-model-updated`; C8 `dfit` in
  `STATE_FIELDS` and `PRISM_KEYS`; shared engines list + `WTS_wellbore` (incl. `csys`, `stepRate`, `ramp`) and `PRiSM_dfit_pipeline`;
  the O(n) derivative note; stats; "Latest release: v3.4".
- **PROJECT-NOTES:** v3.4 entry (scope, benchmarks, known limitations).
- **perf-baseline.json:** DFIT adds ≈ 9–12k source lines (≈ 0.5–0.65 MB); re-recorded in a separate commit.

---

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Users read the consensus as "the truth" in an open dispute | Misplaced confidence | Range shown by default when families disagree; both readings with all downstream numbers and per-family uncertainty columns; labels say "uncalibrated" until 3.4b and state the truth-model bias after; neutral method notes |
| Storage handled inconsistently in the closure balance | xf, R, w̄ and R_vis biased exactly in low-visibility tests | One storage-consistent chain (§4.6, §4.10) used by frac outputs, uncertainty, designer and classifier; P18 and I14 recover the model's A_f·c_f and R_vis with a gas-filled wellbore |
| Regime thresholds on the wrong statistic | False "storage", wrong p_i point, k_hi excluding the truth | Thresholds tabulated for s_D (§4.12); A3b / A18 / A19 vectors |
| Priors drive the forward tools (designer, corridor, forecast, uncertainty, triage bands) | Confident-looking nonsense | Priors and their provenance printed next to every band; "generic priors in use" banner and downgraded triage rules; modest defaults |
| Lumped mini-model over-trusted | Wrong CL / E′ / geometry | Γ shown as primary; inflated and structural intervals; validity diagnostics; "apparent toughness is not a rock property" |
| Unverified constants (KGD/radial similarity, h-function, far-field reading) and SPE numbers | Wrong pumping-pressure level; wrong citations | Gates G4 and G6 with the conventions written down; "uncalibrated" label; slip to 3.4b if not verified; "no. to verify" numbers never in the app |
| Hooks regress transient / decline / combined mode | PTA breakage | WPH tests H5–H14 + all existing acceptance; ext code paths only when `PRiSM_modeExt[mode]` exists; panel filter defaults keep built-in modes unchanged |
| Undo snapshots grow or miss DFIT changes | Lost picks or memory pressure | Decisions-only extra (≤ 10 kB), recording on `prism:dfit-updated`, `PRiSM_undoBatch`, H6 |
| O(n) Bourdet differs subtly | Changed PTA derivatives | H1 identity test on five data shapes incl. NaN / duplicates; fallback to the old loop when `lnx` is not monotone |
| v3.3 slips or `PRiSM_autoInterp.drive` / `canon` / `WTS_buildup.data` change | No async driver, hashes or chunked parser | v3.4 is sequenced after v3.3; fallbacks: synchronous jobs with a progress message, FNV hashes, gauge-manager import |
| Phone performance (stability grid, fits, designer) | Sluggish UI | Jobs with progress and Cancel; coarse grids; 1,000-draw default and 2,000 cap; `--perf` on phone-class settings |
| 1 s data over days (10⁵–10⁶ rows) and high-rate windows | Slow import, storage quota | Chunked parser; O(n) resampler; HF windows in IndexedDB keyed by dataset (150 kB localStorage fallback) |
| Surface-gauge DFITs | Biased BHP, vacuum | Conversion band, warm-back model, vacuum masking, triage fails stated |
| Live false early closure calls (3.4b) | Gauge pulled too early | Provisional → confirmed; CUSUM on decimated / prewhitened pressure residuals, calibrated on replays; verdict advisory |
| Acceptance runtime | Slower CI for everyone | ≤ 60 s budget with shared apps; heavy checks in `dfit-validate.js --quick/--perf` |
| Schedule (3.4a ≈ 95 engineer-days) | Late release | Midpoint checks and the pre-agreed slip list (§1.5, §9.0); must-ship line |
| Bundle growth | perf-budget flag | Re-record the baseline; no new libraries |
| Confidentiality of wording | Names in strings or docs | WP7 neutral-wording review; generic descriptions only |

---

## 12. Open questions (each with the default we use; we do not stop to ask)

| # | Question | Default |
|---|---|---|
| Q1 | Name of the mode in the header select | "DFIT (fracture injection)"; crumb "PRiSM · DFIT" |
| Q2 | 3.4a / 3.4b split | As §1.5 and §9: analysis (incl. basic step-rate and the reopening ramp), model, designer, replay engine, several tests per well in 3.4a; replay timeline, live listeners, superposition step-rate, flowback, calibration, extras in 3.4b |
| Q3 | Default α | `auto`: data-driven G when a rate history exists, else α = ½; the α pair is shown whenever it changes η by more than 0.01, and always in the what-if table |
| Q4 | Standalone Round-9 leak-off page | Not in v3.4 (the sandbox runs in PRiSM with no data and its Tools entry is in every PRiSM mode; Production & Reservoir is at 7 of 8 rows). Revisit with a "Fracture tests" hub |
| Q5 | Standalone step-rate page for injector engineers | Not in v3.4; the basic step-rate card is in step ② (3.4a), the superposition tool in DFIT mode (3.4b) |
| Q6 | Which closure feeds hand-offs when the board shows a range | None automatically: the PTA hand-off asks the user to choose a family (logged as `mode:'family'`); the frac sheet and the uncertainty table carry both family columns |
| Q7 | Default ISIP when families disagree (low label) | The falloff-family (G extrapolation) value when its residual test passes, else the inverse-variance consensus of the accepted families; flagged |
| Q8 | Default tp | Pump start; the sensitivity of G_c and η to the other two is always shown |
| Q9 | Default leak-off split in the mini-model | Reservoir-controlled (k free, C_w = 0) for water / slickwater; wall-controlled (C_w free, no k) for gel and other wall-building fluids |
| Q10 | E′ missing | Geometry outputs hidden; Γ, η, pn, closure and ACA still reported; "enter E′ for geometry" ⚠ |
| Q11 | Frictional limit defaults | Two tiers: veto below μ 1.0 with S_v 0.9 psi/ft and p_p at the lower bracket edge (hydrostatic if unknown); warning below μ 0.6 with S_v 1.0 psi/ft; all editable; the veto can be overridden with a reason |
| Q12 | Empirical closure-time permeability correlation | Not shipped (the physics-based k-from-CL and h-function estimates are, with bias factors) |
| Q13 | SPE numbers marked "no. to verify" | Never shown in the app; author, year and title only until verified |
| Q14 | Does DFIT write p_i into C1 automatically? | No; only through the PTA hand-off, after confirmation, and only with a label ≥ medium unless the user includes it |
| Q15 | Does DFIT add a `PRiSM_MODELS` entry? | No; model count stays 46 |
| Q16 | Tide removal | Automatic when the after-closure window spans ≥ 24 h and the tidal amplitude exceeds 10 % of Δp |
| Q17 | PTA report sections in DFIT mode | Hidden (`reportLegacySections:false`) |
| Q18 | Analyst name in the pick log | Free text from the report options, empty by default; the log is an integrity aid, not a signature |
| Q19 | High-rate windows | Up to 4 windows × 12,000 samples in `PRiSM_storage` (IndexedDB) keyed by dataset hash; without IndexedDB the shut-in window only (≤ 150 kB) in `wts_prism_dfit_hf` |
| Q20 | Live pressure units (3.4b) | Station canonical psig → psia with the test's `atmPsia` |
| Q21 | Re-pump verdict wording | Advisory; needs "Acknowledge"; never blocks analysis |
| Q22 | Uncertainty sample size | 1,000 (2,000 selectable, hard cap) |
| Q23 | Leak tolerance ε | 0.05, with Θ from the expected regime at the P90 of the designer draws |
| Q24 | Import above 200,000 rows | Through the v3.3 chunked parser (or the gauge manager), then "Use for DFIT" |
| Q25 | Without v3.3's driver | Jobs run synchronously with a progress message; no timers |
| Q26 | What "leak-off rate analysis" in the owner's request means | Fracture-fluid leak-off: the mini-model sandbox and history match (§5). A wellbore loss rate is the leak plot (§6.4); the leak-off point of a drilling leak-off or formation-integrity test comes from the ramp analyser (§4.15b) |
| Q27 | Range-mode family weight | 50/50, labelled "interpretive weight, not a probability", editable and logged; never changes the per-family columns |
| Q28 | CL ↔ k pressure convention | Δp_CL = ½·(ISIP + σ_c) − p_r, used by §4.10, §4.12 k_lo, §5.2 and §5.5 |
| Q29 | Closure tolerance constants | τ = max(15 psi, 0.3 % σ_c, 3 % pn); single when s ≤ 2.5τ; high when s, w, g ≤ τ; low when w or g > 2.5τ (all "cal" in 3.4b) |
| Q30 | Reference-well wellbore compressibility | One system compressibility c_sys = c_fluid + ψ·D/(E_s·e) = 3.57e-6 1/psi → V_w·c_w 4.44e-3 ft³/psi (consistent with the 4,539 ft/s hammer speed); the mini-model vectors keep their stated 4.98e-3 input |
| Q31 | h-function and far-field readings if gate G6 fails | Move to 3.4b; the plot stays hidden and the card shows only k from CL |
| Q32 | How F4 (reopening) votes | With a near-wellbore correction (step-down available): a full voting family; without it: an upper-side bound (a single closure above it becomes a range) |
| Q33 | Several DFITs per well in 3.4a | One active test analysed at a time; the others keep summaries for the table, the gradient plot and the overlay; ≤ 12 per well |
| Q34 | Pad fraction rule | Shown as the range of (1 − η)/(1 + η) and (1 − η)², labelled indicative |

---

## 13. References (author, year, title, SPE number; "no. to verify" numbers are never shown in the app)

**Pre-closure, ISIP, closure, leak-off types**
- Barree, R.D. 1998. Applications of pre-frac injection/falloff tests in fissured reservoirs — field examples. SPE 39932.
- Barree, R.D., Barree, V.L. and Craig, D.P. 2009. Holistic fracture diagnostics: consistent interpretation of prefrac injection tests
  using multiple analysis methods. SPE 107877.
- Barree, R.D., Miskimins, J.L. and Gilbert, J.V. 2015. Diagnostic fracture injection tests: common mistakes, misfires, and
  misdiagnoses. SPE 169539.
- Barree, R.D. and Mukherjee, H. 1996. Determination of pressure dependent leakoff and its effect on fracture geometry. SPE 36424.
- Bachman, Walters and Hawkes 2012. Reappraisal of the G time concept in mini-frac analysis. SPE 160169.
- Carter, R.D. 1957. Derivation of the general equation for estimating the extent of the fractured area (appendix to Howard and Fast,
  Optimum fluid characteristics for fracture extension).
- Castillo, J.L. 1987. Modified fracture pressure decline analysis including pressure-dependent leakoff. SPE 16417.
- Craig, D.P., Barree, R.D., Warpinski, N.R. and Blasingame, T.A. 2017. Fracture closure stress: reexamining field and laboratory
  experiments of fracture closure using modern interpretation methodologies. SPE 187038.
- Craig, D.P. and Blasingame, T.A. 2006. Application of a new fracture-injection/falloff model accounting for propagating, dilated, and
  closing hydraulic fractures. SPE 100578.
- Liu and Ehlig-Economides 2015. Comprehensive global model for before-closure analysis of an injection falloff fracture
  calibration test. SPE 174906.
- McClure, M.W., Jung, H., Cramer, D.D. and Sharma, M.M. 2016. The fracture-compliance method for picking closure pressure from
  diagnostic fracture-injection tests. SPE 179725.
- McClure, M.W. 2017. The spurious deflection on log-log superposition-time derivative plots of diagnostic fracture-injection tests.
  SPE 186098.
- McClure, Fowler and Picone 2022. Best practices in DFIT interpretation: comparative analysis of 62 DFITs from nine
  different shale plays. SPE 205297.
- McClure, M.W. et al. 2019. A collaborative study on DFIT interpretation: integrating modeling, field data, and analytical methods
  (conference paper 2019-123; title to verify).
- Mayerhofer, M.J. et al. 1995. Pressure-transient analysis of fracture-calibration tests. SPE 26527 (author list to verify).
- Nolte, K.G. 1979. Determination of fracture parameters from fracturing pressure decline. SPE 8341.
- Nolte, K.G. 1986. A general analysis of fracturing pressure decline with application to three models. SPE 12941.
- Nolte, K.G. 1986. Determination of proppant and fluid schedules from fracturing-pressure decline. SPE 13278 (no. to verify;
  pad-fraction rule).
- Nolte, K.G. and Smith, M.B. 1981. Interpretation of fracturing pressures. SPE 8297.
- Wang, H. and Sharma, M.M. 2017. New variable compliance method for estimating closure stress and fracture compliance from DFIT data.
  SPE 187348 (title and number to verify).
- Zanganeh, B., Clarkson, C.R. and Hawkes, R.V. 2017. Reinterpretation of fracture closure dynamics during diagnostic fracture
  injection tests. SPE 185649.
- Hubbert, M.K. and Willis, D.G. 1957. Mechanics of hydraulic fracturing. SPE 686-G.
- Haimson, B. and Fairhurst, C. 1967. Initiation and extension of hydraulic fractures in rocks. SPE 1710.
- Sneddon, I.N. 1946. The distribution of stress in the neighbourhood of a crack in an elastic solid.

**After-closure and gas**
- Nolte, K.G., Maniere, J.L. and Owens, K.A. 1997. After-closure analysis of fracture calibration tests. SPE 38676.
- Nolte, K.G. 1997. Background for after-closure analysis of fracture calibration tests. SPE 39407.
- Talley, G.R., Swindell, T.M., Waters, G.A. and Nolte, K.G. 1999. Field application of after-closure analysis of fracture calibration
  tests. SPE 52220.
- Soliman, M.Y. 1986. Analysis of buildup tests with short producing time. SPE 11083.
- Soliman, M.Y., Craig, D., Bartko, K., Rahim, Z. and Adams, D. 2005. After-closure analysis to determine formation permeability,
  reservoir pressure, and residual fracture properties. SPE 93419.
- Gu, H., Elbel, J.L., Nolte, K.G., Cheng, A.H.-D. and Abousleiman, Y. 1993. Formation permeability determination using impulse-fracture
  injection. SPE 25425.
- Craig, D.P. 2014. New type curve analysis removes limitations of conventional after-closure analysis of DFIT data (no. to verify).
- Benelkadi, S. and Tiab, D. 2004. Reservoir permeability determination using after-closure period analysis of calibration tests (no.
  to verify).
- Mohamed, I.M. et al. 2011. Evaluation of after-closure analysis techniques for tight and shale gas formations. SPE 140136.
- Marongiu-Porcu, M., Ehlig-Economides, C.A. and Economides, M.J. 2011. Global model for fracture falloff analysis. SPE 144028.
- Cinco-Ley, H. and Samaniego-V., F. 1981. Transient pressure analysis for fractured wells. SPE 7490.
- Gringarten, A.C., Ramey, H.J. Jr. and Raghavan, R. 1974. Unsteady-state pressure distributions created by a well with a single
  infinite-conductivity vertical fracture. SPE 4051.
- Bourdet, D., Ayoub, J.A. and Pirard, Y.M. 1989. Use of pressure derivative in well-test interpretation. SPE 12777.
- Al-Hussainy, R., Ramey, H.J. Jr. and Crawford, P.B. 1966. The flow of real gases through porous media. SPE 1243.
- Agarwal, R.G. 1979. "Real gas pseudo-time" — a new function for pressure buildup analysis of MHF gas wells. SPE 8279.
- Lee, W.J. and Holditch, S.A. 1982. Application of pseudotime to buildup test analysis of low-permeability gas wells with long-duration
  wellbore storage distortion. SPE 9888.
- Barker, J.A. 1988. A generalized radial flow model for hydraulic tests in fractured rock.
- Cramer, D.D. and Nguyen, D.H. 2013. Diagnostic fracture injection testing tactics in unconventional reservoirs. SPE 163863.
- Nicholson, A.K., Hawkes, R.V. and Bachman, R.C. 2019 (pressure-transient DFIT practice, including the far-field fracture extension
  pressure; title and SPE number to verify at gate G6).
- Bredehoeft, J.D. 1967. Response of well-aquifer systems to earth tides.

**Leak-off model and fracture mechanics**
- Howard, G.C. and Fast, C.R. 1957. Optimum fluid characteristics for fracture extension.
- Perkins, T.K. and Kern, L.R. 1961. Widths of hydraulic fractures. SPE 89.
- Geertsma, J. and de Klerk, F. 1969. A rapid method of predicting width and extent of hydraulically induced fractures. SPE 2458.
- Nordgren, R.P. 1972. Propagation of a vertical hydraulic fracture. SPE 3009.
- Settari, A. 1985. A new general model of fluid loss in hydraulic fracturing (no. to verify).
- Spence, D.A. and Sharp, P. 1985. Self-similar solutions for elastohydrodynamic cavity flow.
- Adachi, J.I. and Detournay, E. 2002. Self-similar solution of a plane-strain fracture driven by a power-law fluid.
- Savitski, A.A. and Detournay, E. 2002. Propagation of a penny-shaped fluid-driven fracture in an impermeable rock: asymptotic
  solutions.
- Bandis, S.C., Lumsden, A.C. and Barton, N.R. 1983. Fundamentals of rock joint deformation.
- Valkó, P. and Economides, M.J. 1999. Fluid-leakoff delineation in high-permeability fracturing. SPE 56135.

**Related tests, wellbore and water hammer**
- Carey, M.A., Mondal, S. and Sharma, M.M. 2015. Analysis of water hammer signatures for fracture diagnostics. SPE 174866.
- Holzhausen, G.R. and Gooch, R.P. 1985. Impedance of hydraulic fractures: its measurement and use for estimating fracture closure
  pressure and dimensions. SPE 13892.
- Iriarte, J., Merritt, J. and Kreyche, B. 2017. Using water hammer characteristics as a fracture treatment diagnostic. SPE 185087.
- Crump, J.B. and Conway, M.W. 1988. Effects of perforation-entry friction on bottomhole treating analysis. SPE 15474.
- Romero, J., Mack, M.G. and Elbel, J.L. 1995. Theoretical model and numerical investigation of near-wellbore effects in hydraulic
  fracturing. SPE 30506.
- Cleary, M.P. et al. 1993. Field implementation of proppant slugs to avoid premature screen-out of hydraulic fractures with adequate
  proppant concentration. SPE 25892.
- Singh, P.K., Agarwal, R.G. and Krase, L.D. 1987. Systematic design and analysis of step-rate tests to determine formation parting
  pressure. SPE 16798.
- Singh, P.K. and Agarwal, R.G. 1990. Two-step rate test: new procedure for determining formation parting pressure. SPE 18141.
- Odeh, A.S. and Jones, L.G. 1965. Pressure drawdown analysis, variable-rate case. SPE 1084.
- Plahn, S.V., Nolte, K.G., Thompson, L.G. and Miska, S. 1997. A quantitative investigation of the fracture pump-in/flowback test.
  SPE 30504.
- Shlyapobersky, J., Walhaug, W.W., Sheffield, R.E. and Huckabee, P.T. 1988. Field determination of fracturing parameters for
  overpressure calibrated design of hydraulic fracturing. SPE 18195.
- Ramey, H.J. Jr. 1962. Wellbore heat transmission. SPE 96.
- Hasan, A.R. and Kabir, C.S. 1991. Heat transfer during two-phase flow in wellbores: part I — formation temperature. SPE 22866.
- McCain, W.D. Jr. 1991. Reservoir-fluid property correlations — state of the art. SPE 18571.
- Izgec, B. and Kabir, C.S. 2009. Real-time performance analysis of water-injection wells. SPE 109876.
- Silin, D.B., Holtzman, R., Patzek, T.W. and Brink, J.L. 2005. Monitoring waterflood operations: Hall's method revisited. SPE 93879.
- Koning, E.J.L. and Niko, H. 1985. Fractured water-injection wells: a pressure falloff test for determining fracturing dimensions.
  SPE 14458.
- van den Hoek, P.J. 2002. Pressure transient analysis in fractured produced water injection wells. SPE 77946.
- van den Hoek, P.J. 2016. A simple unified pressure transient analysis method for fractured waterflood injectors and minifracs in
  hydraulic fracture stimulation. SPE 181593.
- Perkins, T.K. and Gonzalez, J.A. 1985. The effect of thermoelastic stresses on injection well fracturing. SPE 11332.
- Dodge, D.W. and Metzner, A.B. 1959. Turbulent flow of non-Newtonian systems.
- Metzner, A.B. and Reed, J.C. 1955. Flow of non-Newtonian fluids — correlation of the laminar, transition, and turbulent-flow regions.
- Virk, P.S. 1975. Drag reduction fundamentals.
- Wood, A.B. 1930. A textbook of sound.
- Wylie, E.B. and Streeter, V.L. 1993. Fluid transients in systems.
- Hall, H.N. 1963. How to analyze waterflood injection well performance.
- Nicholson and Hawkes 2020 (revised 2023). Diagnostic fracture injection test (DFIT) recommendations (regulatory guidance
  document; execution and data-submission practice).
- Hawkes, Bachman, Nicholson, Cramer and Chipperfield 2018. Good tests cost money, bad tests cost more — a
  critical review of DFIT and analysis gone wrong (no. to verify; cited by the practice notes as the source of the h-function, gate
  G6).

**Statistics used by the module**
- Gneiting, T. and Raftery, A.E. 2007. Strictly proper scoring rules, prediction, and estimation (interval score).
- Iman, R.L. and Conover, W.J. 1982. A distribution-free approach to inducing rank correlation among input variables.
- Page, E.S. 1954. Continuous inspection schemes (CUSUM).
- Wilson, E.B. 1927. Probable inference, the law of succession, and statistical inference.

---

## Appendix A. Where the acceptance vectors live

| Topic | Section | Test file |
|---|---|---|
| G table, quadrature, inverse, η, α-pair rule, slopes | §4.5, §4.9 | `dfit-gfunction` |
| Reference well: ISIP, closure, storage-consistent balance, geometry, CL, leak-off rate, k, forecast, R_vis, stress-log offset | §4.21, §6.12 | `dfit-preclosure`, `dfit-integration` |
| Toy contact, consensus, τ label arithmetic, two-tier veto, counterfactual, log-log = compliance, F4 | §4.7, §4.8, §6.2 | `dfit-closure` |
| Conversion, c_sys, friction, perforations, bleed-off, step-down, step-rate, ramp, hammer (incl. the bleed-aware midline), vacuum, alignment | §4.2–4.4, §4.14–4.15b, §4.17 | `dfit-wellbore` |
| Triage checks, blunders, re-pump bands, grade | §6.3 | `dfit-triage` |
| After-closure constants, s_D trajectories, examples A and B, bounds, origin table, gas, transform, leak with drift, pipeline | §4.12–4.13, §6.4, §6.8, §3.3a | `dfit-aca` |
| Mini-model V1–V14, quick table, goal-seek | §5.4, §6.1 | `dfit-leakoff` |
| History match, groups, log-k Jacobian, Fisher, extension table | §5.7, §6.7 | `dfit-leakfit` |
| Designer reference cases (s_D times), V_min, vacuum, leak budget with Θ | §6.5, §6.4 | `dfit-designer` |
| Uncertainty, per-family columns, family weight | §6.6 | `dfit-uncertainty` |
| Replay, decimated / prewhitened CUSUM | §6.9 | `dfit-live` |
| Evidence, quoted self-check, export template, frac sheet, hand-off packet | §6.10, §6.8 | `dfit-report` |
| End-to-end cases, mini-model storage recovery, hand-off kh/μ, stacked tests | §8.2, §4.6, §6.8, §6.12 | `dfit-integration` |
| 12-case quick set, 20-seed replay, structural spread, multi-start; wall-clock budgets | §8.2, §8.5 | `dfit-validate.js --quick` / `--perf` (tool) |
| Superposition step-rate, Hall, flowback, MOC hammer, two-gauge, Ramey, MASIP (3.4b) | §4.15–4.17 | `dfit-fieldtests` |

## Appendix B. Corrections and open checks carried over from the research notes and the review

1. **Water-hammer table, Γ > 0 rows.** For a closed-end (half-wave, staircase) termination the decay per 2L/c period is Γ, not Γ²: 0.60
   (R = 2,000) and 0.91 (R = 10,000) instead of 0.36 and 0.82. The Γ < 0 rows (Γ² per 4L/c period) were right. §4.17 uses the corrected
   rule (verified by the method-of-characteristics simulation).
2. **Reservoir-controlled leak-off lower bound on k.** The bound k ≥ μ/(φc_t)·(CL_p/(1.1827e-3·Δp))² decreases with Δp, so a bound that
   is safe for the true Δp must use the **largest** plausible Δp (p_mid high, p_i at the **lower** bracket edge) and the lowest CL_p;
   the after-closure note's "use the p_i upper bracket" gives a larger, non-conservative k_lo. §4.12 uses the corrected form, in the
   Δp_CL convention of §4.10.
3. **Leak-corrected p_i window bias.** The prototype's corrected p_i reads ≈ 7.5 psi high even with no leak (transitional data in the
   window); the UI states the bias next to the corrected value.
4. **G(1, α = 1)** = 1.40638 (re-computed; one note rounded it to 1.40640).
5. **KGD and radial zero-toughness similarity coefficients** (0.6152, 0.6955): unverified, gate G4 (§9, WP4), now with the conventions
   μ′ = 12μ, Q₀ total rate, K′ = 4·√(2/π)·K_Ic written into the gate and V3.
6. **SPE numbers to verify** before any help text: Craig 2014; Benelkadi & Tiab 2004; Settari 1985; Wang & Sharma 2017 (the notes give
   two different titles); Mayerhofer et al. 1995 (the notes give two different author lists); Hawkes et al. 2018; Nolte 1986 (pad
   fraction); Nicholson et al. 2019. A water-hammer paper quoted in the landscape note with an approximate number is not used.
7. **Leak-plot detection floor** (0.021 bbl/d with no leak in the prototype) is data-dependent: the floor is computed from the
   regression's own noise (now with the drift term), not hard-coded.
8. **Psig detection** cannot rely on the gradient priors alone (14.7 psi moves a 10,000 ft ISIP gradient by 0.0015 psi/ft); the blunder
   test uses the source unit flag and a channel reading within ±2 psi of zero while the well is open to atmosphere.
9. **Storage in the closure balance** (review). With a wellbore, the G-function balance fixes the system excess volume:
   η_G·V_i\* = (A_f·c_f + V_w·c_w)·p_n. The earlier identities (dV_L/dG = V_f/G_c, C_sys = (V_f/G_c)/|dP/dG|, V_f = η·V_i = A_f·c_f·p_n)
   were no-storage results; combined with the storage-corrected CL they double-counted and inflated xf by 1/R_vis (134.0 → 131.2 ft
   in the reference at V_w·c_w 4.44e-3; × 1.85 with a gas-filled wellbore) and biased R_vis high (0.69 instead of 0.54). The CL value
   (1.90e-4) survives because two errors cancelled to first order. §4.6, §4.9, §4.10, §4.21 and §6.6 use the corrected chain.
10. **Regime thresholds were Δp slopes** (review). −0.90 at t_DL 0.76 and −0.95 at 1.6 are slopes of Δp; on the tested statistic s_D the
   uniform-flux impulse reaches −0.90 only at t_DL 1.6 and shows a transition hump above −0.40 for t_DL 0.06–0.18. k_hi now uses 1.6,
   the point p_i is used only where s_D is locally constant, the bracket gate allows the hump, and the designer constants are
   recomputed (2,894 → 6,068; 18,962 → 27,800 for "confirmed").
11. **Model-derived G factor** (review): g = B_w/(A_L,s·√tp), not B_w/(2·A_L,s·√tp); a constant area from t = 0 must give
   g = 2√(1 + ΔtD). The prototype was right; the plan's formula is corrected and V13 checks it.
12. **Exponential aperture law** (review): w = w_σ − c_f0·[f_res·x + (1 − f_res)·s_c·(1 − e^(−x/s_c))] reached zero 220 psi below σ_c
   (f_res 0.1, s_c 100) and went negative; replaced by a decaying residual that keeps w > 0; the hydraulic closure is
   s_c·ln((1 − f_res)/(½ − f_res)) in the s_r → ∞ limit, not s_c·ln 2.
13. **Gas k_lo direction and adjusted pressure anchor** (review): a higher p_i gives a larger k for gas (μ rises, c_g falls), so k_lo uses
   the lower bracket edge (the same mistake as correction 2); p_a = p_i + (μz/p)_i·∫ p′/(μz) dp′ so intercepts read in psia.
14. **One wellbore compressibility** (review): V_w·c_w 4.98e-3 used c_w = 4e-6 while the 4,539 ft/s wave speed implies c_sys 3.57e-6
   (V_w·c_w 4.44e-3; ramp 6,323 instead of 5,637 psi/min). The reference well now uses c_sys for storage, ramp and hammer; the
   mini-model verification vectors keep 4.98e-3 as an explicit input.
15. **Thermal sensitivity** (review): β at DFIT column temperatures is 2.3–3.7e-4 1/°F (`Bw_meehan`), giving ≈ 65–105 psi/°F after
   closure instead of ≈ 42 psi/°F.
16. **Expected PDL curvature** (review): the quasi-static κ_exp ignores the Duhamel memory of reservoir-controlled leak-off (−19 % vs the
   model's −28 % between G 1 and 15); κ_exp now comes from a coarse w_c = 1 run on the case's own window.

## Appendix C. Review notes (points resolved differently from the reviewer's proposal, with the reason)

1. **h-function check values.** The review asked for acceptance vectors "from the research notes"; the notes hold the bias factors
   (h ÷ 1.5, G ÷ 2) but no h-function definition or check values. Rather than invent numbers, the plan adds gate G6 (§9, WP2): the
   definition and vectors are taken from the cited source before P20 is frozen, and the h-function estimate and plot slip to 3.4b if
   that fails. The far-field extension-pressure reading is put behind the same gate for the same reason.
2. **Leak-bias factor in radial flow.** The two reviews give ln t_Dxf + 2.81 and (ln t_D + 0.81); they are the same physics with
   different reference lengths (fracture half-length vs an effective wellbore radius). The plan uses the exact uniform-flux
   Θ(t_DL) = p_D/p_D′ (2.0 early, 3.5 at t_DL 1.6, 4.5 at 5, → ln t_DL + 2.81), which is 2 in linear flow and matches both asymptotes.
3. **ISIP thresholds.** The review fixed the medium threshold at max(25 psi, 5 % pn); the high threshold stays max(10 psi, 2 % pn)
   (monotone with the new medium) rather than τ, because ISIP agreement is about gauge-level precision, not closure precision.
4. **Reference worked example.** The reviewer's 130.9 ft used V_w·c_w 4.98e-3; with the hammer-consistent 4.44e-3 (correction 14)
   the corrected xf is 131.2 ft. The 25 bbl of the reference is declared to be V_i\* so the balance stays directly comparable with
   the research notes; a real test computes V_i\* per closure candidate.
5. **Mini-model verification vectors at V_w·c_w 4.98e-3.** They are model identities with a stated input; rerunning the prototype
   was not needed to fix the inconsistency. WP4 may rerun V1d / V5 / V7 / V8 at 4.44e-3 before freezing; V8 now compares magnitudes
   within 3 %.
6. **Report sections.** The review offered per-group sections or a `blocks` contract; the plan does both — one section per group
   (so groups can be switched off) and the generic `blocks` list (so a group can hold several tables, verdicts and plots).
7. **F4 voting.** The review proposed that F4 votes as an upper-side estimate. Because an uncorrected reopening reads high by the
   near-wellbore loss, it votes in the mean only after that correction; without a step-down it is an upper bound (it can turn a single
   closure above it into a range) — still physically independent evidence, never a confirmation of F1 by itself.
8. **Paying for step-rate and the ramp analyser in 3.4a.** Done by moving the replay timeline UI to 3.4b (the engine and a "first
   available" table stay) and by replacing the counterfactual bisection engine with a sentence read from the stability samples
   (novelty review item on gimmick risk); the counterfactual sentence is also first on the slip list.
9. **O(n) loops in 13 and 34.** Listed as an out-of-module follow-up (§9) rather than added to WPH, to keep the hook package small; DFIT
   does not call either loop.
10. **Test-id clash.** Families are F0–F4, so the leak-fit tests are renamed LF1–LF8 and the reopening family keeps the name F4 the review
   proposed; evidence ids keep their groups (F = fracture outputs) and are always shown in brackets or the Ev. column.
11. **`datumTvd` at test level.** The proposed multi-test shape had `datumTvd` beside `inputs`; it stays only in `inputs.datumTvd` (the
   tests table reads it) to avoid two copies.
12. **Hold-time recommendation.** The review asked for a printed temperature requirement; the plan also sets a default "unrealistic"
   threshold (0.05 °F) at which the designer recommends proving the leak after the test with the leak plot.
13. **Benchmark in acceptance.** The architecture review asked to move B1–B3 to integration or the validate tool and the runtime review to
   cut the benchmark to three cases: the three cases (reference, contact, example B) run in `dfit-integration` I11–I13 and the 12-case
   set in `dfit-validate.js --quick`; `dfit-benchmark.test.js` is dropped.
14. **Pad fraction.** Two forms are in common use; the plan shows both as a range and labels it indicative rather than choosing one.

## Appendix D. Integration amendments (3.4a, lead)

Recorded by the integrator after the work packages were merged in the §9.0 order (WPH → WP1 → WP2 → WPT → WP4 → WP3 → WP5 → WP6).
Each item says what changed against the text above and why. Items marked **reviewed** are work-package deviations the lead checked
for soundness before recording them; none was reverted.

**Interfaces**

- **§3.5 `gSpec`.** `G(dt)` / `Gp(dt)` take the shut-in time in hours like every public time field (§3.0); `Gp` is dG/dΔt_D; the
  engine-side forms `GD` / `GpD` / `gD` take Δt_D. Reason: one public time unit. No file outside 56 calls `gSpec.G` / `Gp` (57 reads
  only `g0`; 58 uses `PRiSM_dfit_G(Δt_D, gSpec)`), so no consumer needed a change.
- **§3.7 `leakBudget`.** `ctx` gains `tDLDraws` (the P90 is used), `phi`, `muRes`, `ct`, `L` (with `kDraws`) and `tempF`; the result
  gains `warnings[]` (e.g. `LEAK_KDRAWS_UNUSED`). 57's leak plot now passes t_DL draws built from the after-closure k (bounds and
  estimate), φ, μ, c_t and the fracture length, so the budget uses this test's leak-off regime (Θ) instead of the linear default.
- **§3.7 names.** `PRiSM_dfit_lkGoalSeekJob`, `PRiSM_dfit_lkProfile` and `PRiSM_dfit_lkProfileJob` (profile likelihood of σ_c or p_r,
  one refit per step) are part of the 3.4a surface.
- **§6.5 / §6.7 `Identify.extend[]`.** Rows are `{tEndD, tEndH, sdPi, pFixed, kRange, kBasis, pRadial}`. `sdPi` is **one standard
  deviation**; the ± figures quoted in §6.5 (7.9 / 2.8 / 1.5 / 0.9 / 0.56 / 0.39 psi) are 95 % half-widths (1.96·sd), which is how
  `dfit-leakfit` checks them. `pFixed:true` marks a wall-only model that cannot estimate p_r (sd 0, no keep-or-pull comparison);
  `kBasis 'fisher'` names the source of the k range.
- **§3.3a `opts.stages`.** `'all'` or a list of stage ids (prepare, events, isip, derivs, consensus, frac, aca, uncertainty, report).
- **§3.4 `StepRate`.** `band` is the fracture-extension-pressure band (psia) and `qStarBand` the q\* band (bbl/min), both from the
  bootstrap (FIX: 7,470 / 7,480 / 7,492 psia and 2.9 / 3.2 / 3.5 bbl/min). `Hammer.delta` = T/τ, the logarithmic decrement per fitted
  period (the FIX value is computed from T and τ instead of a free 0.11).
- **§4.3 / §4.17 fluid compressibility.** c_fluid = 1/K with the handbook water bulk modulus K = 3.2e5 psi by default (3.125e-6 1/psi);
  `fluid.cFluid` (given) or `fluid.cFluidModel 'dodson'` (`cw_dodson` at the mid-column p, T) are optional; oil defaults to 1e-5 1/psi.
  Reason: the default must not depend on a PVT module being loaded; the 3.57e-6 1/psi reference of §4.3 is unchanged to rounding.
- **§4.22 L_max.** The default L_max of the k_hi bound (§4.12) is 2·xf of the chosen geometry when no input (`options.aca.Lmax`,
  `rock.Lmax`) is given.

**Algorithms**

- **§4.7 / §4.8 closure picks under noise (WP2, reviewed).** (1) The early p–G window grows while its curvature is statistically
  absent (σ_eff and ρ1 from the lag-1 / lag-2 difference variances), capped one Bourdet window before the provisional departure — a
  standard nested-model test, sound. (2) The departure threshold is max(ε, 3σ_y/ŷ): **ε is a floor**, the local noise sets the
  scale, with persistence (joint z ≥ 4, still beyond 0.3 ln units later). **Corrected at the integration review:** the claim that
  this "can only delay a pick under noise" was false — a sharp (compliance-drop) closure reverts by crossing the line (G·dP/dG jumps
  above it at G_c and falls below it as the decline slows), so the reversion test moved a noise-free closure 140–190 psi late
  (Example A 4,963.6 against 5,105.5; penny 4,976 against 5,164). A departure that crosses to the other side within 0.3 ln units, or
  is far beyond the noise (Σ(r/σ_r)/√n_eff ≥ 8), is now kept and read at its start (abrupt-break rule), also when it is shorter than
  n_hold; the crossing needs the same joint z ≥ 8, so correlated noise (C14, σ 1, ρ1 0.9) still cannot cross its way in. (3) The compliance onset is refined by a hinge fit p = A + B·u + C·u₊² + D·u₊³ with an SSR-profile standard error, and an
  abrupt break is read at the start of its interval — a change-point refinement of a pick the §4.7 rule has already made; sound.
  (4) The tangent after an upward departure is the vertex of dP/dG: the line through the origin touches y = G·dP/dG where
  y′ = y/G, i.e. d(dP/dG)/dG = 0, so the vertex is exactly the **touch point**. **Corrected at the integration review:** it is not the
  §4.7 reading, which is the plateau end (the last G with y ≥ (1 − ε)·s*·G, after the touch point); F2 is now read at the touch point
  (earlier and higher than §4.7 as first written; §4.7 is amended accordingly), which makes 'tangent' the same reading as the
  dependent 'maxdpdg' member. A flat top longer than 0.5 ln units keeps the plateau-end rule. The quick-set median F2 error of 436 psi
  came from the truth, not the engine: `sigmaCF2From`'s quasi-static f_L = (p − p_r)/(σ_c − p_r) misses the Duhamel memory (§4.11);
  lk cases now take truth.sigmaCF2 from the mini-model's own dP/dG maximum below σ_c on its display grid (q-contact F2 error 46 psi). (5) The family band adds the voting pick's own se in quadrature — conservative
  (never narrower).
- **§4.7 abrupt break (integration fix).** The break is located in the **first** of the steep intervals (walking back from the
  steepest while the interval before still falls ≥ 3 × the early slope) and read at the centre of that interval on the pre-closure
  line, se = half-width/√3. Reason: on an exact Carter after-closure line the slope keeps growing for a few samples after closure, so
  the steepest interval lies one sample past it, and its start pressure is already after-closure (reference demo: 6,936.8 psia →
  7,002.6, truth 7,000).
- **§4.7 reservoir-controlled decline (integration fix; was open).** A downward first departure followed by a stiffening of dP/dG
  by ≥ 30 % is reservoir-controlled (matrix) leak-off, not closure: dP/dG falls with p − p_r (the 28–40 % of §4.11). The compliance
  departure is then searched upward from the declining trend (the G·dP/dG line over the last 0.7 ln units before the dP/dG minimum,
  starting one Bourdet window before it), and the hinge carries a u² base term (`closedForm.matrixDecline`). `dfit-integration`
  I11 (matrix): 6,998.3 psia, single (was 7,569); I12 (contact): F1 7,002.2 / F2 6,736, range (truth 7,000 / 6,301; was 7,582).
- **§4.3 events (integration fix).** The pump start is read from the first sample above the pre-pump level (a sample still at that
  level puts the onset at the end of the rate bracket). The last pumping sample is taken from the pressure when the largest drop
  within the next three samples follows a sample that has not fallen (a forward-held rate column writes q = 0 at the shut-in sample);
  the volume carries the last rate to it. Reference demo tp 5.63 min against the true 5.65 (was 5.83); I14 V_i 25.00 bbl (was 24.32).
  I14 then recovers A_f·c_f, xf and R_vis 2.8 % low (limit 3 %): the remainder is the ramp V_w·c_w, 1 % high because the model's
  initial 1 ft fracture takes fluid during the ramp, amplified by R_vis 0.26 in A_f·c_f = C_sys − V_w·c_w.
- **§4.11 κ_exp.** The coarse run is 58's `'prescribed'` mode with the frac candidate's geometry `{Ap = A_f, c_f, α, r_p, tp}` and a
  fully reservoir-controlled leak-off (CL with w_c = 1); without a geometry or p_r the quasi-static form is used, and without 58 too.
  The model is read up to its own closure when it closes before the data's G_c, on the last model interval ending there (an interval
  straddling the closure read the after-closure slope: +345 % instead of −31 %). W ends at the tangent G when that lies after the
  closure candidate (§4.11 as written), so a closure range's stiffening is part of κ. p_r (57): C1 p_i, else the p_i-gradient prior,
  else the injected fluid's hydrostatic at the datum (assumed, said in the evidence); after the ACA the classifier runs once more with
  the after-closure p_i when that is labelled high or medium (`classification.prSource` 'well' | 'prior' | 'hydrostatic' |
  'aca-pi').
- **§4.4 ISIP acceptance.** 56 accepts the wave ISIP on `hammerQuick`'s own §4.4 verdict (`bleed.fitted`, `upper:false`, `bleed.dEnd`).
  57 runs the step tests first and passes the column, q_shut, V_w·c_w, tp, the valve closing time (`ds.meta.tCloseS`) and the
  step-down `{b, β, q_t}` — or `fitBleed:true` without a step-down — to `hammerQuick`, and builds the `bleedOff` law used by the ISIP
  and by the triage bleed-off window (Q13).
- **§4.1 depth fix.** `PRiSM_dfit_prepare` applies `channels.depthFix.dpPsi` (an applied gauge-to-datum blunder fix) to the bottomhole
  channel, records `applied.depthFixPsi` and a `DEPTH_FIX` flag, and then skips the constant-gradient gauge-to-datum shift. A surface
  primary channel is converted with `WTS_wellbore.convert`'s own contract (column, fluid, temperature, atmPsia, channel 'p'), which
  gives the P10–P90 band and the vacuum time.
- **§4.12 p_i bracket allowance.** Each bracket edge (Cartesian, impulse, derivative) is widened outward by 2 % of its distance from
  the last pressure (`BR_TOL`). Reason: the edges are exact for a Carter source; a reservoir-controlled history moves the late
  intercepts by about 1 % of the remaining Δp (I11: the F_L line fits 27–81 h with σ 0.2 psi and extrapolates to 4,505.6 psia against
  the model's 4,500, p_end 4,989). On a radial record (small Δp) the change is a fraction of a psi.
- **§6.6 rank correlation.** A Gaussian copula replaces Iman–Conover for the φ–c_t pair: with ρ_N = 2·sin(π·r_s/6) in normal space the
  Spearman coefficient of the drawn pair is exactly r_s (−0.3 by default) for any monotone marginals, which is the property
  Iman–Conover was chosen for. (The WP3 code used r_s directly as ρ_N, giving −0.287; corrected at integration.)
- **§6.3 triage (WPT deviations, recorded).** Evidence ids Q1–Q21 follow the CHECKS order, Q0 is the triage summary. A failed check
  inside an analysed window grades C like one outside; a surface vacuum on a surface-converted analysis is masked and recorded
  `inWindow:false`; a gauge thermal transient above the limit outside the pick window is a warning. Context sources (57): `ds`,
  `stepRate`, `bleed`; `strapVolume` and `tCloseS` from `opts` or `ds.meta` (no input field in 3.4a); `tide` from `opts` or from the
  ACA tide fit (largest constituent amplitude against the after-closure change), with the triage re-run once after the ACA stage.
- **§6.3 blunder cards.** "Apply fix" writes `fix.field` and every `fix.also[]` entry (MD-as-TVD moves `datumTvd` and `datumMd`
  together) in one undo batch and logs each field; "It is real" dismisses and logs (`dfit-integration` I17).
- **§6.9 live events.** The session uses 56's events when present, but takes the shut-in only once a zero-rate sample follows it
  (while pumping, 56 puts t_s at the end of the record, which moved t_s and rebuilt the state every block); without a usable ramp
  56's pump start keeps the bracket and the nuisance tp search (`dfit-live` V1b, V8).

**Demos and budgets**

- **Surface-gauge demo and §4.2.** The demo's surface channel is the fixed-point inverse of `WTS_wellbore.convert` for the
  reference column (ρ(p,T), the displaced temperature model with τ_T 2 h, pipe friction while pumping), so a converted analysis
  recovers the bottomhole record to the gauge noise (closure 6,999.9 against 7,002.6 bottomhole); the constant-gradient column plus
  warm-back stays as the fallback without the wellbore engine. Its inputs carry the displaced model with a 1–4 h τ band, and its
  p_r is re-solved for that column (3,235.0 psia: vacuum 31 h after shut-in; 3,323.9 with the fallback column). Reason: the constant
  0.438 psi/ft column is ≈ 40 psi off the ρ(p,T) column (§4.2) and drifts with the warm-back, which moved the converted closure by
  196 psi.
- **34 semilog recompute in DFIT mode.** The semilog listener defers its recompute while `PRiSM.mode === 'dfit'` and runs it on the
  next change to another mode (the IARF search on every DFIT dataset commit and C1 write took ≈ 0.3 s and is neither shown nor
  reported in DFIT mode).
- **Appendix A / §4.21 reference demo.** The demo's tp is 5.65 min (main stage plus the step-down), not the 5.0 min of the §4.21
  table; Δt_c, CL, Γ, k_CL and G of the demo use this tp (stated in `ds.meta.note`). The §4.21 numbers stay the FIX.ds numbers.
- **Budgets measured at integration** (Linux container, one file at a time, wall clock incl. the app load): `dfit-closure` 4.4 s for
  16 tests (≤ 4 s planned), `dfit-integration` 12.2 s for 17 tests at the first integration and ≈ 10.2 s after the engine cuts of the
  second round (≤ 8 s planned: the leak-plot bootstrap's IRLS without the finiteness filter and with selection medians, the
  per-draw finiteness check of the uncertainty propagator done once per context, the deferred semilog recompute; what remains is
  eight demo analyses on cold app contexts — ≈ 0.35–0.55 s each, the stability grid ≈ 0.15 s of it — the Tab-7 render and the reload
  and project tests), `dfit-ui` 7.4 s, `dfit-hooks` 4.3 s for 14,
  `dfit-synth` 3.9 s for 7, `dfit-leakfit` 3.9 s for 8; the 17 DFIT files total ≈ 55 s for 225 tests run file by file and 46 s in one `--html --integration --file dfit-` run (≤ 60 s planned). Accepted as
  exceptions for 3.4a.
- **Demo binding (59).** `loadDemo` decides the dataset binding before the commit (the dataset-loaded listener binds an unbound test
  itself, which skipped the demo set-up); the surface-gauge demo now gets its datum and strings.

**Integration review fixes (3.4a, after the three reviews of fc4ac5c; `tests/dfit-review.test.js` RV1–RV19)**

- **Live co-pilot (57, §6.9).** Only the closure sign raises a call: p below the early line (dP/dG rising). A first departure above it
  is a reservoir-controlled decline; the reference then follows the declining trend (the line over the last 0.7 ln units before the
  candidate, less 2L) and the CUSUM restarts. Reason: on the mini-model reference every replay seed called closure 5 h early at
  7,462 psia. Now 0 of 20 early (quick replay), the reference call 7,001 psia.
- **High-rate windows (56 prepare).** Each `prep.hf.windows[i]` carries `t` (h) and `p` (psia, converted like the main bottomhole
  channel) from the main record when it is ≥ 2 Hz, else from `ds.meta.hfWindows`; 57 passes them to `hammerQuick`, 59 stores them.
  The reference demo's wave ISIP is 7,599.0 against the falloff 7,599.1 psia.
- **ISIP_lp.** The friction is a·q_last² + b·q_last^β from the step-down coefficients (not `sd.at`, which is at the top step rate).
- **Re-pump after closure (§4.5).** 57 re-runs the events with σ_prior = the last cycle's F4 reopening knee (else σ_grad·TVD), so
  `closedBefore` is decided from the data; the last cycle is then analysed alone and p_i is labelled low (earlier cycles not
  superposed). The two-cycle demo truth is now the realised cycle-2 falloff (the ramp does not reach the nominal propagation pressure
  in V/q: realised ISIP 7,163 psia, pn 163, m_G 20.4, A_f·c_f 0.0433 bbl/psi, xf 155 ft); the engine reads 164 / 0.0431 / 154.
- **k lower bound (§4.12).** The leak-off-limit bound divides CL_lo by KMEM = 1.3 (Duhamel memory, §4.11); it is not used under PDL or
  tip extension, and the linear-A_max bound not under PDL (the fissure area is not bounded by the main fracture).
- **Departure persistence (56).** See WP2 change (2) above: a reversion that crosses the line (with joint z ≥ 8) is a sharp closure.
- **Vetoed-only consensus.** K1 says "all closure candidates vetoed (…) by the … limit", K10 is read at the vetoed picks,
  `consensus.vetoed[]` lists them. Example A and the penny case state an 8,000 ft datum (`aca.datumTvd`): σ_c ≈ 5,100 psia with
  p_i 4,500 psia is below the conservative frictional limit deeper than ≈ 8,900 ft.
- **PDL (56).** A post-hump window sets m_G and the picks' early window when a later straight (or ≤ 15 % flat) window with a
  ≥ 10 % lower dP/dG is reached by a dP/dG that only falls; the ISIP stays on the earliest line when the hump carries ≥ 15 % of the
  drop (a gas wellbore's bleed-off lifts the first samples by a few psi only, I14). Classified PDL, the fracture chain uses
  C_sys = V*/(p_n + (4g0/π)·m_G·m), m = the PDL multiplier at the ISIP. The G-domain generator's PDL pumping leak-off now runs at the
  same multiplier (V* = X·(G_c + 4g0/π·m)); before, the PDL demo's truth assumed constant-CL pumping leak-off.
- **tp_veq** (§4.3 amended above), **closure draws** (N(0, s_j) with s_j² = σ_family² − var(pool), own seeded stream; `_shares` 0
  for a constant output), **family σ floor** max(1 psi, 2σ_gauge, 0.25 % p_n, 0.05 % σ_c), **stability grid g** on the
  pre-refinement detection points (an abrupt break keeps its exact reading).
- **Classifier.** With consensus mode none and no R_vis the type is never 'normal' (storage when R_vis,max ≤ 0.3 from the early
  slope bound, else undetermined).
- **Benchmark truths (49-calc-dfit-synth).** Gas aca-exact: ISIP and σ_c mapped through m(p) like the record, k = k_liq·μ_g,i/μ_liq.
  lk cases: σ_c,F2 from the model's dP/dG maximum. `dfit-validate --quick`: spread on a σ 0.05 contact case, truth ∈ structural
  range ∪ CI95 ± 0.05 psi; 58's structural rule is Δχ²/s² ≤ 4 + 2·|Δn_p|.
- **Triage.** Q2 looks for the shut-in drop within t[kd] ± max(60 s, 5 × the pre-shut-in sample interval) of the rate stop, reads a
  sampled rate step against its interval, back-extrapolates the pressure rise on the ramp slope and, on a vacuum start, checks the
  clocks at the stop. Q20 gets an amplitude only from a significant (SNR ≥ 3) or applied tide fit.
- **UI (59, 01, 04, 11, 37).** Undo / redo reinstates a cached full run for the same inputs and picks (else marks the summary
  stale); the designer has id'd range inputs (field units, as all DFIT inputs) and shows the shut-in in days with the binding words;
  `ext.toolAllow` (37) and the PTA CSV / XML left out of Export in an extension mode (01); no C1 defaults banner or chip in an
  extension mode (04, 11); `ext.panelsFirst` mounts the Tests / demo card above the data cards; the export header gets the test,
  inputs, well and `WTS_appVersion()`; `setPick` refuses a primitive; a failed Analyse says why. Frac-design sheet columns:
  name, family, p10, value, p90, unit, lens, ev, p50 (§3.13 amended).
- **iOS (ios-styles.css §10).** The overlay keeps its full-screen backdrop; the dialog boxes are capped to the padded area; 44 pt
  close / override buttons (§2.3 amended).
- **Help.** The PRiSM guide's `reviewedSrc` is bumped to the new page-source hash for the generic shell edits only (the transient,
  decline and combined text is unchanged and was re-checked); the DFIT guide section stays WP7 (below).

**Help content needed for the v3.4 release (WP7; not written in the integration round)** — in `48-calc-help-production.js` (the
PRiSM guide parts) plus shots recipes, within the `help-content.test.js` byte caps:

1. A "DFIT mode" section of the PRiSM guide: entering the mode (test-type select), the five steps in DFIT terms, the tests table
   (several tests per well, zones), the rail rows and the grade.
2. Step ① data: channel roles (bottomhole / surface / annulus / temperature / flowback), psig and the test atmospheric pressure,
   the wellbore set-up (survey, strings, fluid, temperature, datum, gauge depth), demos, high-rate windows.
3. Triage and data health: the 21 checks with their pass / warn / fail meaning, blunder cards ("Apply fix", "It is real", the
   undo), the re-pump verdict and its acknowledgement, the salvage list.
4. Step ② events and ISIP: pump start / breakdown / shut-in, tp choices, the ISIP families (wave, falloff, friction) and when the
   wave ISIP is an upper estimate; step-down, step-rate and the pump-in ramp (F4).
5. Step ③ closure: the method families F0–F4, the consensus (single vs range, τ), confidence labels marked uncalibrated in 3.4a,
   the frictional-limit check, overrides with a reason, "Why …?" and the method notes dialog.
6. Fracture outputs: efficiency, net pressure, storage-consistent R_vis, geometry (PKN / KGD / radial), CL, leak-off rate, the
   what-if closure, the stress-log calibration.
7. Step ④ after-closure: origin choice, regimes, p_i consensus and bracket, kh/μ and k bounds, the leak plot and leak budget,
   tides, gas.
8. Uncertainty, the leak-off mini-model sandbox and the pre-job designer (goal-seek, extension table, keep or pull the gauge).
9. Live / replay: provisional and confirmed calls, the forecast band.
10. Step ⑤ report and hand-offs: Tab-7 sections, PDF / CSV / text export, frac sheet, PTA / RTA hand-offs, Quick Report key line,
    `WTS_state.dfit` values used by other pages.
11. Glossary entries (ISIP, G-function, closure, net pressure, efficiency, PDL, tip extension, height recession, R_vis, F-families,
    after-closure, impulse), two "How do I…" tasks (analyse a DFIT; check whether a test is interpretable) and FAQ items on the
    labels being uncalibrated and on closure ranges.
12. Screenshots: step ① with triage, step ③ closure board on the reference demo, step ④ after-closure, the designer; then
    `help-shots.js --route prism` and `build-user-guide.js`.
